(() => {
  const $ = (id) => document.getElementById(id);
  const DRIFT_TOLERANCE = 1.5; // segundos de diferença tolerados antes de reajustar
  const HEARTBEAT_MS = 4000;

  const socket = io({ autoConnect: false });
  const video = $('video-el');

  let me = { name: '', isHost: false, code: '' };
  let heartbeat = null;
  let player = null;
  let currentUrl = '';
  let expected = { playing: false, time: 0, at: Date.now() };

  // ---------- Fundo com corações ----------
  (function spawnPetals() {
    const layer = document.querySelector('.petals');
    const symbols = ['♥', '❤', '♡', '❥'];
    for (let i = 0; i < 18; i++) {
      const s = document.createElement('span');
      s.textContent = symbols[i % symbols.length];
      s.style.left = Math.random() * 100 + 'vw';
      s.style.fontSize = 10 + Math.random() * 22 + 'px';
      s.style.animationDuration = 14 + Math.random() * 18 + 's';
      s.style.animationDelay = -Math.random() * 30 + 's';
      layer.appendChild(s);
    }
  })();

  // ---------- Utilidades ----------
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function expectedTime() {
    return expected.playing ? expected.time + (Date.now() - expected.at) / 1000 : expected.time;
  }

  // Lembra o nome e, para quem criou, o token que devolve o controle ao recarregar a página.
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  // ---------- Entrada ----------
  const params = new URLSearchParams(location.search);
  $('name').value = store.get('cine-name') || '';
  $('code').value = (params.get('sala') || '').toUpperCase();

  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('name').value.trim();
    const code = $('code').value.trim().toUpperCase();
    const videoUrl = $('video').value.trim();
    $('join-error').textContent = '';
    const btn = e.submitter || document.querySelector('#join-form button');
    btn.disabled = true;

    if (!socket.connected) socket.connect();
    socket.emit('join', { name, code, videoUrl, hostToken: store.get('cine-host-' + code) }, (res) => {
      btn.disabled = false;
      if (!res || res.error) {
        $('join-error').textContent = (res && res.error) || 'Algo deu errado. Tente de novo.';
        if (res && res.needsVideo) $('video').focus();
        return;
      }
      store.set('cine-name', name);
      if (res.hostToken) store.set('cine-host-' + res.room.code, res.hostToken);
      enterRoom(name, res);
    });
  });

  function enterRoom(name, res) {
    me = { name, isHost: res.isHost, code: res.room.code };
    history.replaceState(null, '', '?sala=' + encodeURIComponent(me.code));
    $('join-screen').classList.add('hidden');
    $('room-screen').classList.remove('hidden');
    $('room-code').textContent = me.code;
    applyRole();

    renderMembers(res.room.members);
    addSystem(me.isHost ? 'Sala criada! Mande o código para o seu amor 💌' : `Você entrou na sala ${me.code} 💞`);
    loadVideo(res.room.videoUrl, res.room.state);
  }

  function applyRole() {
    $('role-badge').textContent = me.isHost ? '🎬 Você controla o filme' : '🍿 Assistindo junto';
    $('host-tools').classList.toggle('hidden', !me.isHost);
    $('guest-controls').classList.toggle('hidden', me.isHost);
    if (me.isHost) $('waiting').classList.add('hidden');
    // O player do YouTube precisa ser recriado para ligar/desligar os controles.
    if (player && !player.setControls(me.isHost)) loadVideo(currentUrl, { playing: expected.playing, time: expectedTime() });
    updateGuestUi();
  }

  function loadVideo(url, state) {
    $('video-error').classList.add('hidden');
    expected = { playing: !!(state && state.playing), time: (state && state.time) || 0, at: Date.now() };
    if (player) player.destroy();
    currentUrl = url;
    player = CinePlayers.create(url, {
      video,
      ytBox: $('yt-box'),
      hostMode: me.isHost,
      events: {
        ready: onPlayerReady,
        play: onPlayerPlay,
        pause: onPlayerPause,
        seek: () => { if (me.isHost) sendControl('seek'); },
        error: showVideoError,
      },
    });
    player.setControls(me.isHost);
    updateGuestUi();
  }

  function onPlayerReady() {
    if (Math.abs(player.time() - expectedTime()) > 1) player.seek(expectedTime());
    if (!me.isHost) applyExpected();
  }

  const ERRORS = {
    file: {
      3: ['💔 O link funciona, mas o navegador não sabe tocar esse arquivo.',
        'O vídeo ou o áudio usa um formato não suportado (ex.: .mov do iPhone em HEVC, áudio AC3/DTS). Jeito mais prático: suba o vídeo no YouTube como "Não listado" e cole o link aqui — o YouTube aceita qualquer formato.'],
      4: ['💔 Esse arquivo não pode ser tocado no navegador.',
        'Pode ser que o link não seja público ou que o formato não seja suportado (ex.: .mkv, .avi, .mov em HEVC). Jeito mais prático: suba o vídeo no YouTube como "Não listado" e cole o link aqui.'],
      default: ['💔 Não consegui carregar esse vídeo.',
        'Confira se o link está público. Vídeos muito grandes do Google Drive às vezes são bloqueados — o Dropbox ou o YouTube costumam funcionar melhor.'],
    },
    youtube: {
      2: ['💔 Esse link do YouTube não parece válido.', 'Copie o link de novo pelo botão Compartilhar do YouTube.'],
      100: ['💔 O YouTube não encontrou esse vídeo.', 'Ele pode ter sido apagado ou estar como "Privado". Deixe o vídeo como "Não listado" para funcionar aqui.'],
      101: ['💔 O YouTube não deixa esse vídeo tocar fora do site dele.', 'Isso acontece com vídeos com direitos autorais ou com a opção "Permitir incorporação" desligada. Vídeos que você mesmo subiu funcionam.'],
      150: ['💔 O YouTube não deixa esse vídeo tocar fora do site dele.', 'Isso acontece com vídeos com direitos autorais ou com a opção "Permitir incorporação" desligada. Vídeos que você mesmo subiu funcionam.'],
      api: ['💔 Não consegui abrir o player do YouTube.', 'Confira sua internet e recarregue a página.'],
      default: ['💔 O YouTube não conseguiu tocar esse vídeo.', 'Tente recarregar a página. Se o vídeo acabou de ser enviado, espere o YouTube terminar de processar.'],
    },
  };

  function showVideoError(info) {
    const table = ERRORS[info.source];
    const [title, detail] = table[info.code] || table.default;
    $('video-error-title').textContent = title;
    $('video-error-detail').textContent = detail;
    $('video-error-link').href = info.link;
    $('video-error-code').textContent = 'Código do erro: ' + (info.code || '?') + (info.message ? ' — ' + info.message : '');
    $('waiting').classList.add('hidden');
    $('video-error').classList.remove('hidden');
  }

  // ---------- Quem criou a sala (host) ----------
  function sendControl(action) {
    if (!me.isHost || !player) return;
    socket.emit('control', { action, time: player.time() });
  }

  function onPlayerPlay() {
    if (me.isHost) {
      sendControl('play');
      clearInterval(heartbeat);
      heartbeat = setInterval(() => sendControl('tick'), HEARTBEAT_MS);
    }
    updateGuestUi();
  }

  function onPlayerPause(ended) {
    if (me.isHost) {
      clearInterval(heartbeat);
      // Também acontece no fim do vídeo; tudo bem, mantém todos no mesmo ponto.
      sendControl('pause');
    } else if (expected.playing && !ended) {
      // Convidado não controla: se o vídeo parar sozinho, volta ao estado da sala.
      setTimeout(() => applyExpected(), 300);
    }
    updateGuestUi();
  }

  $('change-video-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('new-video').value.trim();
    if (!url) return;
    socket.emit('change-video', url, (res) => {
      if (res && res.error) return toast(res.error);
      $('new-video').value = '';
      toast('Vídeo trocado 🎞️');
    });
  });

  // ---------- Quem assiste (convidado) ----------
  socket.on('sync', (msg) => {
    expected = { playing: msg.playing, time: msg.time, at: Date.now() };
    // O host só recebe isso se o servidor pausar a sala; ele continua no controle.
    if (me.isHost) return;
    applyExpected(msg.action !== 'tick');
  });

  async function applyExpected(forceSeek, muteFallback) {
    if (me.isHost || !player || !player.ready()) return updateGuestUi();
    const target = expectedTime();
    if (forceSeek || Math.abs(player.time() - target) > DRIFT_TOLERANCE) player.seek(target);
    if (expected.playing && player.paused()) {
      try {
        await player.play();
        $('unlock').classList.add('hidden');
      } catch (err) {
        if (!err || err.name !== 'NotAllowedError') return;
        if (!muteFallback) return $('unlock').classList.remove('hidden');
        // Alguns celulares só deixam começar sem som; o som volta pelo botão 🔇.
        setMuted(true);
        $('unlock').classList.add('hidden');
        toast('Toque em 🔇 para ligar o som');
        player.play().catch(() => {});
      }
    } else if (!expected.playing && !player.paused()) {
      player.pause();
    }
    updateGuestUi();
  }

  $('unlock-btn').addEventListener('click', () => {
    $('unlock').classList.add('hidden');
    applyExpected(true, true);
  });

  setInterval(() => {
    if (!me.isHost && player && player.ready()) {
      $('guest-time').textContent = `${fmt(player.time())} / ${fmt(player.duration())}`;
    }
  }, 500);

  function updateGuestUi() {
    if (me.isHost) return;
    $('guest-status').textContent = expected.playing ? '▶ Tocando' : '⏸ Pausado';
    const errored = !$('video-error').classList.contains('hidden');
    $('waiting').classList.toggle('hidden', errored || expected.playing || expectedTime() > 0.5);
  }

  let muted = false;
  function setMuted(m) {
    muted = m;
    if (player) player.setMuted(m);
    $('mute-btn').textContent = m ? '🔇' : '🔊';
  }
  $('mute-btn').addEventListener('click', () => setMuted(!muted));
  $('volume').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (player) player.setVolume(v);
    setMuted(v === 0);
  });
  $('fs-btn').addEventListener('click', () => {
    const wrap = $('player-wrap');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (wrap.requestFullscreen) wrap.requestFullscreen();
    else if (video.webkitEnterFullscreen && !video.classList.contains('hidden')) video.webkitEnterFullscreen();
  });

  // ---------- Troca de vídeo, membros, conexão ----------
  socket.on('video', (url) => {
    loadVideo(url, { playing: false, time: 0 });
    if (!me.isHost) toast('Um novo vídeo foi escolhido 🎞️');
  });

  socket.on('members', renderMembers);

  function renderMembers(list) {
    const ul = $('member-list');
    ul.innerHTML = '';
    let hostName = null;
    for (const m of list) {
      const li = document.createElement('li');
      li.textContent = (m.isHost ? '🎬 ' : '💗 ') + m.name;
      ul.appendChild(li);
      if (m.isHost) hostName = m.name;
    }
    $('host-name').textContent = hostName || 'quem criou a sala';
  }

  socket.on('disconnect', () => {
    if (me.code) toast('Conexão perdida... tentando voltar 💫');
  });
  socket.io.on('reconnect', () => {
    if (!me.code) return;
    socket.emit('join', { name: me.name, code: me.code, hostToken: store.get('cine-host-' + me.code) }, (res) => {
      if (!res || res.error) return toast((res && res.error) || 'Não foi possível voltar à sala.');
      me.isHost = res.isHost;
      applyRole();
      renderMembers(res.room.members);
      expected = { playing: res.room.state.playing, time: res.room.state.time, at: Date.now() };
      if (me.isHost) sendControl(player && !player.paused() ? 'play' : 'pause');
      else applyExpected(true);
      toast('De volta à sala ♥');
    });
  });

  $('copy-code').addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}?sala=${encodeURIComponent(me.code)}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Link da sala copiado! Mande para o seu amor 💌');
    } catch {
      toast('Código da sala: ' + me.code);
    }
  });

  // ---------- Chat e corações ----------
  function addMessage(msg) {
    const li = document.createElement('li');
    li.className = msg.name === me.name ? 'mine' : 'theirs';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = msg.name;
    li.append(who, document.createTextNode(msg.text));
    appendLi(li);
  }

  function addSystem(text) {
    const li = document.createElement('li');
    li.className = 'system';
    li.textContent = text;
    appendLi(li);
  }

  function appendLi(li) {
    const list = $('messages');
    list.appendChild(li);
    list.scrollTop = list.scrollHeight;
  }

  socket.on('chat', addMessage);
  socket.on('system', addSystem);

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat', text);
    input.value = '';
  });

  $('heart-btn').addEventListener('click', () => socket.emit('heart'));

  socket.on('heart', ({ name }) => {
    const layer = $('hearts-layer');
    const h = document.createElement('div');
    h.className = 'float-heart';
    h.textContent = ['❤️', '💖', '💗', '💕', '💘'][Math.floor(Math.random() * 5)];
    const label = document.createElement('small');
    label.textContent = name;
    h.appendChild(label);
    h.style.left = 10 + Math.random() * 80 + '%';
    h.style.setProperty('--drift', (Math.random() * 80 - 40) + 'px');
    layer.appendChild(h);
    setTimeout(() => h.remove(), 3100);
  });
})();
