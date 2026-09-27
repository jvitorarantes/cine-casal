const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 30 * 60 * 1000; // sala vazia expira em 30 minutos

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/**
 * rooms: Map<code, {
 *   code, videoUrl, hostToken, hostSocketId,
 *   state: { playing, time, updatedAt },
 *   members: Map<socketId, { name, isHost }>,
 *   emptySince
 * }>
 */
const rooms = new Map();

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 30);
}

// Aceita youtube.com/watch?v=, youtu.be/, /shorts/, /embed/ e /live/.
function youtubeVideoId(url, host) {
  let id = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
    id = url.searchParams.get('v') || (url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/) || [])[1];
  }
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}

// Converte links de compartilhamento do Google Drive e Dropbox em links diretos de vídeo
// e links do YouTube em um formato único que o navegador reconhece.
function toDirectVideoUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;

  const host = url.hostname.toLowerCase();

  const youtubeId = youtubeVideoId(url, host);
  if (youtubeId) return `https://www.youtube.com/watch?v=${youtubeId}`;

  if (host.endsWith('drive.google.com') || host.endsWith('docs.google.com')) {
    const match = url.pathname.match(/\/file\/d\/([^/]+)/);
    const id = match ? match[1] : url.searchParams.get('id');
    if (id) return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
  }

  if (host === 'dropbox.com' || host === 'www.dropbox.com') {
    // dl.dropboxusercontent.com entrega o arquivo direto, sem redirecionamento, e aceita avançar/voltar.
    // Mantém rlkey/st (necessários nos links novos) e remove só o dl=0.
    const direct = new URL(url.pathname + url.search, 'https://dl.dropboxusercontent.com');
    direct.searchParams.delete('dl');
    return direct.toString();
  }

  return url.toString();
}

// Tempo atual estimado do vídeo, considerando o tempo decorrido desde a última atualização.
function currentTime(state) {
  if (!state.playing) return state.time;
  return state.time + (Date.now() - state.updatedAt) / 1000;
}

function snapshot(room) {
  return {
    code: room.code,
    videoUrl: room.videoUrl,
    state: { playing: room.state.playing, time: currentTime(room.state) },
    members: [...room.members.values()],
  };
}

function broadcastMembers(room) {
  io.to(room.code).emit('members', [...room.members.values()]);
}

io.on('connection', (socket) => {
  let joined = null; // código da sala atual

  socket.on('join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const code = normalizeCode(payload && payload.code);
    const name = cleanName(payload && payload.name);
    if (!code) return reply({ error: 'Digite um código de sala.' });
    if (!name) return reply({ error: 'Digite seu nome.' });
    if (joined) return reply({ error: 'Você já está em uma sala.' });

    let room = rooms.get(code);
    let isHost = false;
    let hostToken;

    if (!room) {
      const videoUrl = toDirectVideoUrl(payload && payload.videoUrl);
      if (!videoUrl) {
        return reply({ error: 'Essa sala ainda não existe. Cole o link do vídeo para criá-la.', needsVideo: true });
      }
      hostToken = crypto.randomBytes(16).toString('hex');
      room = {
        code,
        videoUrl,
        hostToken,
        hostSocketId: null,
        state: { playing: false, time: 0, updatedAt: Date.now() },
        members: new Map(),
        emptySince: null,
      };
      rooms.set(code, room);
      isHost = true;
    } else if (payload && payload.hostToken && payload.hostToken === room.hostToken) {
      // O criador voltou para a sala (recarregou a página ou a conexão caiu no celular).
      // A conexão antiga pode ainda não ter sido detectada como morta, então ela é substituída.
      isHost = true;
      hostToken = room.hostToken;
      const old = room.hostSocketId && room.hostSocketId !== socket.id && io.sockets.sockets.get(room.hostSocketId);
      if (room.hostSocketId) room.members.delete(room.hostSocketId);
      room.hostSocketId = null;
      if (old) old.disconnect(true);
    }

    if (isHost) room.hostSocketId = socket.id;
    room.members.set(socket.id, { name, isHost });
    room.emptySince = null;
    joined = code;
    socket.join(code);

    reply({ ok: true, isHost, hostToken, room: snapshot(room) });
    socket.to(code).emit('system', `${name} entrou na sala 💞`);
    broadcastMembers(room);
  });

  function hostRoom() {
    const room = joined && rooms.get(joined);
    if (!room || room.hostSocketId !== socket.id) return null;
    return room;
  }

  socket.on('control', (msg) => {
    const room = hostRoom();
    if (!room || !msg) return;
    const time = Number(msg.time);
    if (!Number.isFinite(time) || time < 0) return;
    const playing = msg.action === 'play' ? true : msg.action === 'pause' ? false : room.state.playing;
    room.state = { playing, time, updatedAt: Date.now() };
    socket.to(room.code).emit('sync', { action: msg.action, playing, time });
  });

  socket.on('change-video', (rawUrl, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = hostRoom();
    if (!room) return reply({ error: 'Só quem criou a sala pode trocar o vídeo.' });
    const videoUrl = toDirectVideoUrl(rawUrl);
    if (!videoUrl) return reply({ error: 'Link inválido.' });
    room.videoUrl = videoUrl;
    room.state = { playing: false, time: 0, updatedAt: Date.now() };
    io.to(room.code).emit('video', videoUrl);
    reply({ ok: true });
  });

  socket.on('chat', (text) => {
    const room = joined && rooms.get(joined);
    const member = room && room.members.get(socket.id);
    const body = String(text || '').trim().slice(0, 500);
    if (!member || !body) return;
    io.to(room.code).emit('chat', { name: member.name, text: body, at: Date.now() });
  });

  socket.on('heart', () => {
    const room = joined && rooms.get(joined);
    const member = room && room.members.get(socket.id);
    if (!member) return;
    io.to(room.code).emit('heart', { name: member.name });
  });

  socket.on('disconnect', () => {
    const room = joined && rooms.get(joined);
    if (!room) return;
    const member = room.members.get(socket.id);
    room.members.delete(socket.id);
    if (room.hostSocketId === socket.id) {
      room.hostSocketId = null;
      // Pausa quando o criador sai, para ninguém perder nada.
      room.state = { playing: false, time: currentTime(room.state), updatedAt: Date.now() };
      io.to(room.code).emit('sync', { action: 'pause', playing: false, time: room.state.time });
    }
    if (member) io.to(room.code).emit('system', `${member.name} saiu da sala`);
    broadcastMembers(room);
    if (room.members.size === 0) room.emptySince = Date.now();
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > ROOM_TTL_MS) rooms.delete(code);
  }
}, 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Cine Casal rodando em http://localhost:${PORT}`));
}

module.exports = { server, toDirectVideoUrl };
