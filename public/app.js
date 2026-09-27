(() => {
  const $ = (id) => document.getElementById(id);
  const DRIFT_TOLERANCE = 1.5; // segundos de diferença tolerados antes de reajustar
  const HEARTBEAT_MS = 4000;

  const socket = io({ autoConnect: false });
  const video = $('video-el');

  let me = { name: '', isHost: false, code: '' };
  let heartbeat = null;
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
    video.controls = me.isHost;
    if (me.isHost) $('waiting').classList.add('hidden');
    updateGuestUi();
  }

  function loadVideo(url, state) {
    $('video-error').classList.add('hidden');
    expected = { playing: !!(state && state.playing), time: (state && state.time) || 0, at: Date.now() };
    video.src = url;
    video.load();
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = expectedTime();
      if (!me.isHost) applyExpected();
    }, { once: true });
    updateGuestUi();
  }

  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    const code = video.error && video.error.code;
    const messages = {
      3: ['💔 O link funciona, mas o navegador não sabe tocar esse arquivo.',
        'O vídeo ou o áudio usa um formato não suportado (ex.: HEVC/H.265 10-bit, áudio AC3/DTS). Converta para .mp4 com vídeo H.264 e áudio AAC (o HandBrake faz isso de graça) e tente de novo.'],
      4: ['💔 Esse arquivo não pode ser tocado no navegador.',
        'Pode ser que o link não seja público ou que o formato não seja suportado (ex.: .mkv, .avi ou vídeo em HEVC/H.265). Converta para .mp4 (H.264) e tente de novo.'],
    };
    const [title, detail] = messages[code] || ['💔 Não consegui carregar esse vídeo.',
      'Confira se o link está público. Vídeos muito grandes do Google Drive às vezes são bloqueados — o Dropbox costuma funcionar melhor.'];
    $('video-error-title').textContent = title;
    $('video-error-detail').textContent = detail;
    $('video-error-link').href = video.currentSrc || video.getAttribute('src');
    $('video-error-code').textContent = 'Código do erro: ' + (code || '?') + (video.error && video.error.message ? ' — ' + video.error.message : '');
    $('waiting').classList.add('hidden');
    $('video-error').classList.remove('hidden');
  });

  // ---------- Quem criou a sala (host) ----------
  function sendControl(action) {
    if (!me.isHost) return;
    socket.emit('control', { action, time: video.currentTime });
  }

  video.addEventListener('play', () => {
    if (!me.isHost) return;
    sendControl('play');
    clearInterval(heartbeat);
    heartbeat = setInterval(() => sendControl('tick'), HEARTBEAT_MS);
  });
  video.addEventListener('pause', () => {
    if (!me.isHost) return;
    clearInterval(heartbeat);
    // O navegador também dispara "pause" no fim do vídeo; tudo bem, mantém todos no mesmo ponto.
    sendControl('pause');
  });
  video.addEventListener('seeked', () => {
    if (me.isHost) sendControl('seek');
  });

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
    if (me.isHost) {
      // Só acontece se o servidor pausar a sala; o host continua mandando.
      return;
    }
    applyExpected(msg.action !== 'tick');
  });

  async function applyExpected(forceSeek) {
    if (me.isHost || video.readyState < 1) return updateGuestUi();
    const target = expectedTime();
    if (forceSeek || Math.abs(video.currentTime - target) > DRIFT_TOLERANCE) {
      video.currentTime = target;
    }
    if (expected.playing && video.paused) {
      try {
        await video.play();
        $('unlock').classList.add('hidden');
      } catch (err) {
        if (err && err.name === 'NotAllowedError') $('unlock').classList.remove('hidden');
      }
    } else if (!expected.playing && !video.paused) {
      video.pause();
    }
    updateGuestUi();
  }

  $('unlock-btn').addEventListener('click', () => {
    $('unlock').classList.add('hidden');
    applyExpected(true);
  });

  // Convidado não controla: se o vídeo pausar/tocar sozinho (ex.: teclado, fim de buffer), volta ao estado da sala.
  video.addEventListener('pause', () => {
    if (!me.isHost && expected.playing && !video.ended) setTimeout(() => applyExpected(), 300);
    updateGuestUi();
  });
  video.addEventListener('play', updateGuestUi);
  video.addEventListener('timeupdate', () => {
    if (!me.isHost) $('guest-time').textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  });

  function updateGuestUi() {
    if (me.isHost) return;
    $('guest-status').textContent = expected.playing ? '▶ Tocando' : '⏸ Pausado';
    const errored = !$('video-error').classList.contains('hidden');
    $('waiting').classList.toggle('hidden', errored || expected.playing || expectedTime() > 0.5);
  }

  $('mute-btn').addEventListener('click', () => {
    video.muted = !video.muted;
    $('mute-btn').textContent = video.muted ? '🔇' : '🔊';
  });
  $('volume').addEventListener('input', (e) => {
    video.volume = Number(e.target.value);
    video.muted = video.volume === 0;
    $('mute-btn').textContent = video.muted ? '🔇' : '🔊';
  });
  $('fs-btn').addEventListener('click', () => {
    const wrap = $('player-wrap');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (wrap.requestFullscreen) wrap.requestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
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
      if (me.isHost) sendControl(video.paused ? 'pause' : 'play');
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
