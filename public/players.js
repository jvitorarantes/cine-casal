// Players de vídeo com a mesma interface: arquivo direto (<video>) e YouTube.
// Cada player avisa o app pelos callbacks: ready, play, pause(ended), seek, error(info).
window.CinePlayers = (() => {
  const YT_RE = /^https:\/\/www\.youtube\.com\/watch\?v=([\w-]{6,})/;

  function youtubeId(url) {
    const m = String(url || '').match(YT_RE);
    return m ? m[1] : null;
  }

  function create(url, opts) {
    const id = youtubeId(url);
    return id ? youtube(opts.ytBox, id, opts.hostMode, opts.events) : file(opts.video, url, opts.events);
  }

  // ---------- Arquivo direto (Dropbox, Google Drive, .mp4) ----------
  function file(video, url, ev) {
    const offs = [];
    const on = (type, fn) => {
      video.addEventListener(type, fn);
      offs.push(() => video.removeEventListener(type, fn));
    };
    on('loadedmetadata', ev.ready);
    on('play', ev.play);
    on('pause', () => ev.pause(video.ended));
    on('seeked', ev.seek);
    on('error', () => {
      const err = video.error;
      ev.error({ source: 'file', code: err && err.code, message: err && err.message, link: video.currentSrc || url });
    });

    video.classList.remove('hidden');
    video.src = url;
    video.load();

    return {
      kind: 'file',
      url,
      ready: () => video.readyState >= 1,
      play: () => video.play(),
      pause: () => video.pause(),
      seek: (t) => { video.currentTime = t; },
      time: () => video.currentTime,
      duration: () => video.duration,
      paused: () => video.paused,
      setControls: (on) => { video.controls = on; return true; },
      setVolume: (v) => { video.volume = v; },
      setMuted: (m) => { video.muted = m; },
      destroy() {
        offs.forEach((off) => off());
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.classList.add('hidden');
      },
    };
  }

  // ---------- YouTube ----------
  let apiPromise = null;
  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (!apiPromise) {
      apiPromise = new Promise((resolve, reject) => {
        const previous = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
          if (previous) previous();
          resolve();
        };
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.onerror = () => {
          apiPromise = null;
          reject(new Error('YouTube indisponível'));
        };
        document.head.appendChild(script);
      });
    }
    return apiPromise;
  }

  const S = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

  function youtube(box, videoId, hostMode, ev) {
    let yt = null;
    let isReady = false;
    let destroyed = false;
    let poll = null;
    let last = null;
    // O YouTube começa a tocar sozinho ao avançar um vídeo que ainda não começou;
    // holdPause segura o vídeo pausado nesse caso.
    let holdPause = false;

    box.innerHTML = '<div></div>';
    box.classList.remove('hidden');
    box.classList.toggle('shielded', !hostMode);

    const state = () => (yt && isReady ? yt.getPlayerState() : S.UNSTARTED);
    const isPlaying = () => state() === S.PLAYING || state() === S.BUFFERING;

    loadYouTubeApi().then(() => {
      if (destroyed) return;
      yt = new window.YT.Player(box.firstChild, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          controls: hostMode ? 1 : 0,
          disablekb: hostMode ? 0 : 1,
          fs: hostMode ? 1 : 0,
          playsinline: 1,
          rel: 0,
          iv_load_policy: 3,
        },
        events: {
          onReady: () => {
            isReady = true;
            ev.ready();
          },
          onStateChange: (e) => {
            if (holdPause) {
              if (e.data === S.PLAYING) {
                holdPause = false;
                yt.pauseVideo();
              }
              if (e.data === S.PLAYING || e.data === S.BUFFERING) return;
            }
            if (e.data === S.PLAYING) ev.play();
            else if (e.data === S.PAUSED) ev.pause(false);
            else if (e.data === S.ENDED) ev.pause(true);
          },
          onError: (e) => ev.error({ source: 'youtube', code: e.data, link: `https://youtu.be/${videoId}` }),
        },
      });

      // O YouTube não avisa quando alguém avança/volta o vídeo, então detectamos pulos no tempo.
      poll = setInterval(() => {
        if (!isReady) return;
        const now = performance.now();
        const t = yt.getCurrentTime();
        if (last) {
          const rate = state() === S.PLAYING ? yt.getPlaybackRate() || 1 : 0;
          const predicted = last.t + ((now - last.at) / 1000) * rate;
          if (Math.abs(t - predicted) > 1.5) ev.seek();
        }
        last = { t, at: now };
      }, 500);
    }).catch(() => ev.error({ source: 'youtube', code: 'api', link: `https://youtu.be/${videoId}` }));

    return {
      kind: 'youtube',
      hostMode,
      ready: () => isReady,
      play() {
        if (!isReady) return Promise.resolve();
        holdPause = false;
        yt.playVideo();
        // playVideo não diz se o navegador bloqueou o som automático; confere logo depois.
        return new Promise((resolve, reject) => setTimeout(() => {
          if (isPlaying()) resolve();
          else reject(Object.assign(new Error('Reprodução bloqueada'), { name: 'NotAllowedError' }));
        }, 1500));
      },
      pause() {
        if (isReady) yt.pauseVideo();
      },
      seek(t) {
        if (!isReady) return;
        if (!isPlaying() && state() !== S.PAUSED) holdPause = true;
        yt.seekTo(t, true);
        last = null;
      },
      time: () => (isReady ? yt.getCurrentTime() : 0),
      duration: () => (isReady ? yt.getDuration() : 0),
      paused: () => !isPlaying(),
      // Os controles do YouTube só podem ser escolhidos ao criar o player.
      setControls: (on) => on === hostMode,
      setVolume: (v) => { if (isReady) yt.setVolume(Math.round(v * 100)); },
      setMuted: (m) => { if (isReady) (m ? yt.mute() : yt.unMute()); },
      destroy() {
        destroyed = true;
        clearInterval(poll);
        try { if (yt) yt.destroy(); } catch {}
        box.innerHTML = '';
        box.classList.add('hidden');
      },
    };
  }

  return { create, youtubeId };
})();
