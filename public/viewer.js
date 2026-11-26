import {
  bindLogout,
  initAuthGate,
  registerServiceWorker,
  timeAgo,
  toast,
} from './shared.js';

const LIVE_WINDOW_MS = 4500;

const PRESENCE = {
  trabalhando: {
    label: 'Trabalhando',
    title: 'Sim, o Leo está trabalhando.',
    defaultNote: 'Webcam e tela do AnyDesk ao vivo.',
    orb: 'trabalhando',
  },
  pausa: {
    label: 'Em pausa',
    title: 'O Leo está em pausa.',
    defaultNote: 'Uma pausa rápida.',
    orb: 'pausa',
  },
  almocando: {
    label: 'Almoçando',
    title: 'O Leo está almoçando.',
    defaultNote: 'Almoço agora — volto em breve.',
    orb: 'almocando',
  },
  banheiro: {
    label: 'No banheiro',
    title: 'O Leo foi ao banheiro.',
    defaultNote: 'Volto em instantes.',
    orb: 'banheiro',
  },
  ausente: {
    label: 'Ausente',
    title: 'O Leo está ausente.',
    defaultNote: 'Fora do computador agora.',
    orb: 'ausente',
  },
  indefinido: {
    label: 'Sem status',
    title: 'Status ainda não informado.',
    defaultNote: 'O Leo ainda não definiu o status do painel.',
    orb: 'indefinido',
  },
  offline: {
    label: 'Sem transmissão',
    title: 'Sem transmissão no momento.',
    defaultNote: 'O PC do Leo está desconectado. O painel reconecta sozinho.',
    orb: 'offline',
  },
};

const state = {
  hostOnline: false,
  presence: { state: 'indefinido', note: '', updatedAt: 0 },
  viewers: 0,
  connected: false,
  sources: { cam: false, screen: false },
  lastFrame: { cam: 0, screen: 0 },
  hasFrame: { cam: false, screen: false },
  mjpeg: {
    cam: { attached: false, retry: null },
    screen: { attached: false, retry: null },
  },
  errors: 0,
  immersive: null,
  started: false,
};
state.checkedAuth = false;

const panels = {};

for (const source of ['cam', 'screen']) {
  const card = document.querySelector(`[data-panel="${source}"]`);
  const image = document.getElementById(`${source}-img`);
  const viewport = document.getElementById(`${source}-viewport`);
  const badge = card.querySelector('[data-badge]');
  const placeholder = card.querySelector('[data-placeholder]');
  const placeholderText = card.querySelector('[data-placeholder-text]');
  const stale = card.querySelector('[data-stale]');
  const staleText = card.querySelector('[data-stale-text]');
  const dot = card.querySelector('[data-dot]');
  const footText = card.querySelector('[data-foot-text]');
  const resolution = card.querySelector('[data-resolution]');

  image.addEventListener('load', () => {
    if (!state.mjpeg[source].attached) return;
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (width && height) {
      const label = `${width} × ${height}`;
      if (resolution.textContent !== label) resolution.textContent = label;
    }

    // Em MJPEG o navegador dispara load a cada quadro (e pelo menos no
    // primeiro), então serve como sinal de vida mesmo sem metadados do SSE.
    state.hasFrame[source] = true;
    state.lastFrame[source] = Date.now();
    if (!state.sources[source]) state.sources[source] = true;
    viewport.classList.remove('is-stale');
    stale.hidden = true;
    if (placeholder.hidden !== true) {
      placeholder.hidden = true;
      viewport.classList.add('has-frame');
      setPlaceholderTexts();
    }
  });

  image.addEventListener('error', () => {
    const slot = state.mjpeg[source];
    slot.attached = false;
    if (state.sources[source] && state.connected) scheduleMjpegRetry(source);
  });

  panels[source] = {
    card,
    image,
    viewport,
    badge,
    placeholder,
    placeholderText,
    stale,
    staleText,
    dot,
    footText,
    resolution,
  };
}

const ui = {
  hostPill: document.getElementById('host-pill'),
  hostLabel: document.getElementById('host-label'),
  statusOrb: document.getElementById('status-orb'),
  statusTitle: document.getElementById('status-title'),
  statusNote: document.getElementById('status-note'),
  statusUpdated: document.getElementById('status-updated'),
  viewerCount: document.getElementById('viewer-count'),
  serverDot: document.getElementById('server-dot'),
  serverStatus: document.getElementById('server-status'),
  connStatus: document.getElementById('conn-status'),
};

bindLogout();
registerServiceWorker();

for (const button of document.querySelectorAll('[data-fullscreen]')) {
  button.addEventListener('click', () => {
    enterFullscreen(button.dataset.fullscreen);
  });
}

for (const button of document.querySelectorAll('[data-exit-fullscreen]')) {
  button.addEventListener('click', exitFullscreen);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.immersive) exitFullscreen();
});

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.immersive) exitFullscreen();
});

initAuthGate(() => {
  if (state.started) return;
  state.started = true;
  connect();
  setInterval(render, 1000);
  setInterval(updatePresenceAge, 1000);
  setInterval(watchdogMjpeg, 4000);
});

window.addEventListener('pagehide', () => {
  for (const source of ['cam', 'screen']) {
    detachMjpeg(source);
  }
});

function connect() {
  const source = new EventSource('/api/stream');
  state.stream = source;

  source.addEventListener('open', () => {
    state.connected = true;
    state.errors = 0;
    updateConnectionUi();
    syncStreams();
  });

  source.addEventListener('error', () => {
    state.connected = false;
    state.errors += 1;
    updateConnectionUi();

    if (!state.checkedAuth && state.errors >= 3) {
      state.checkedAuth = true;
      fetch('/api/me', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : { authenticated: false }))
        .then((data) => {
          if (!data.authenticated) location.reload();
          else state.checkedAuth = false;
        })
        .catch(() => {
          state.checkedAuth = false;
        });
    }
  });

  source.addEventListener('status', (event) => {
    try {
      const data = JSON.parse(event.data);
      state.hostOnline = Boolean(data.hostOnline);
      state.viewers = Number(data.viewers) || 0;
      if (data.presence) state.presence = data.presence;
      if (data.sources && typeof data.sources === 'object') {
        state.sources.cam = Boolean(data.sources.cam);
        state.sources.screen = Boolean(data.sources.screen);
      }
      updateHostUi();
      updatePresenceUi();
      updateViewerCount();
      syncStreams();
      render();
    } catch {
      /* ignora payload inválido */
    }
  });

  source.addEventListener('presence', (event) => {
    try {
      state.presence = JSON.parse(event.data);
      updatePresenceUi();
    } catch {
      /* ignora payload inválido */
    }
  });

  source.addEventListener('source', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.source === 'cam' || data.source === 'screen') {
        applySourceState(data.source, Boolean(data.active));
      }
    } catch {
      /* ignora payload inválido */
    }
  });

  source.addEventListener('frame', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.source === 'cam' || data.source === 'screen') {
        noteFrame(data.source, Number(data.ts) || Date.now());
      }
    } catch {
      /* ignora payload inválido */
    }
  });
}

function syncStreams() {
  for (const source of ['cam', 'screen']) {
    if (state.connected && state.sources[source] && state.hostOnline) attachMjpeg(source);
    else detachMjpeg(source);
  }
}

function attachMjpeg(source) {
  const slot = state.mjpeg[source];
  if (slot.attached) return;
  if (!state.connected) return;

  clearTimeout(slot.retry);
  slot.retry = null;
  slot.attached = true;
  slot.attachedAt = Date.now();
  panels[source].image.src = `/api/mjpeg?source=${source}&v=${Date.now()}`;
}

function detachMjpeg(source) {
  const slot = state.mjpeg[source];
  if (slot.retry) {
    clearTimeout(slot.retry);
    slot.retry = null;
  }
  slot.attached = false;
  slot.attachedAt = 0;
  panels[source].image.removeAttribute('src');
}

// Se o stream MJPEG ficar preso sem entregar o primeiro quadro (por exemplo,
// quando muitas abas disputam conexões), força uma nova conexão.
function watchdogMjpeg() {
  if (!state.connected || !state.hostOnline) return;
  for (const source of ['cam', 'screen']) {
    if (!state.sources[source]) continue;
    const slot = state.mjpeg[source];
    if (!slot.attached) continue;
    if (panels[source].image.naturalWidth > 0) continue;
    if (Date.now() - (slot.attachedAt || 0) < 5000) continue;
    slot.attached = false;
    panels[source].image.removeAttribute('src');
    attachMjpeg(source);
  }
}

function scheduleMjpegRetry(source, delay = 1500) {
  const slot = state.mjpeg[source];
  if (slot.retry || !state.connected || !state.sources[source]) return;

  slot.retry = setTimeout(() => {
    slot.retry = null;
    if (!state.connected || !state.sources[source]) return;
    attachMjpeg(source);
  }, delay);
}

function applySourceState(source, active) {
  state.sources[source] = active;

  if (!active) {
    const panel = panels[source];
    state.hasFrame[source] = false;
    state.lastFrame[source] = 0;
    detachMjpeg(source);
    panel.viewport.classList.remove('has-frame', 'is-stale');
    panel.placeholder.hidden = false;
    panel.stale.hidden = true;
    panel.resolution.textContent = '';
    panel.dot.classList.remove('live');
    panel.badge.classList.remove('is-live', 'is-stale', 'is-error');
    panel.badge.textContent = 'Desligada';
    panel.footText.textContent = 'Desligada';
  } else {
    attachMjpeg(source);
  }

  setPlaceholderTexts();
  renderPanel(source);
}

function noteFrame(source, ts) {
  const panel = panels[source];
  const hadFrame = state.hasFrame[source];

  state.sources[source] = true;
  state.lastFrame[source] = ts;
  state.hasFrame[source] = true;
  panel.viewport.classList.add('has-frame');
  panel.viewport.classList.remove('is-stale');
  panel.stale.hidden = true;

  if (!hadFrame) {
    panel.placeholder.hidden = true;
    setPlaceholderTexts();
  }

  if (!hadFrame || panel.badge.textContent !== 'Ao vivo') renderPanel(source);
}

function render() {
  renderPanel('cam');
  renderPanel('screen');
}

function renderPanel(source) {
  const panel = panels[source];
  const hasFrame = state.hasFrame[source];
  const age = Date.now() - state.lastFrame[source];
  // A tela do AnyDesk pode ficar parada sem novos quadros; enquanto a fonte
  // estiver ativa, a última imagem continua válida.
  const still = source === 'screen' && state.connected && state.hostOnline && state.sources[source];
  const live = hasFrame && (age < LIVE_WINDOW_MS || still);
  const stale = hasFrame && !live;
  const sourceOff = state.connected && state.hostOnline && !state.sources[source];

  panel.viewport.classList.toggle('has-frame', hasFrame && !sourceOff);
  panel.viewport.classList.toggle('is-stale', stale && !sourceOff);
  panel.stale.hidden = !stale || sourceOff;

  panel.badge.classList.remove('is-live', 'is-stale', 'is-error');
  panel.dot.classList.remove('live');

  if (sourceOff) {
    panel.badge.textContent = 'Desligada';
    panel.footText.textContent = source === 'cam' ? 'Webcam desligada' : 'AnyDesk desligado';
  } else if (live) {
    panel.badge.classList.add('is-live');
    panel.badge.textContent = 'Ao vivo';
    panel.dot.classList.add('live');
    panel.footText.textContent = age < 1500 ? 'Atualizado agora' : `Atualizado ${timeAgo(state.lastFrame[source])}`;
  } else if (stale) {
    panel.badge.classList.add('is-stale');
    panel.badge.textContent = state.hostOnline ? 'Sem sinal' : 'Transmissão encerrada';
    panel.footText.textContent = `Última imagem ${timeAgo(state.lastFrame[source])}`;
    panel.staleText.textContent = state.hostOnline
      ? `A imagem parou de chegar ${timeAgo(state.lastFrame[source])}. Tentando novamente…`
      : `O PC do Leo parou de transmitir ${timeAgo(state.lastFrame[source])}.`;
  } else {
    panel.badge.textContent = state.hostOnline ? 'Aguardando' : 'Sem sinal';
    panel.footText.textContent = state.hostOnline
      ? source === 'cam'
        ? 'Aguardando a webcam'
        : 'Aguardando o AnyDesk'
      : 'Sem transmissão';
  }
}

function updateHostUi() {
  if (!state.connected) {
    ui.hostLabel.textContent = 'Reconectando…';
    ui.hostPill.classList.remove('online', 'offline');
    ui.serverStatus.textContent = 'Reconectando…';
    ui.serverDot.classList.remove('live');
    ui.connStatus.classList.remove('is-connected');
    return;
  }

  ui.hostPill.classList.toggle('online', state.hostOnline);
  ui.hostPill.classList.toggle('offline', !state.hostOnline);
  ui.hostLabel.textContent = state.hostOnline ? 'PC conectado' : 'PC desconectado';

  const connectionText = ui.connStatus.querySelector('span:last-child');
  if (connectionText) connectionText.textContent = 'Servidor conectado';
  ui.connStatus.classList.add('is-connected');
  ui.serverDot.classList.add('live');
  ui.serverStatus.textContent = 'Servidor conectado';

  setPlaceholderTexts();
}

function updateConnectionUi() {
  if (state.connected) {
    updateHostUi();
    ui.serverStatus.textContent = 'Servidor conectado';
  } else {
    ui.hostLabel.textContent = 'Reconectando…';
    ui.hostPill.classList.remove('online', 'offline');
    ui.serverStatus.textContent = 'Reconectando…';
    ui.serverDot.classList.remove('live');
    ui.connStatus.classList.remove('is-connected');
    const connectionText = ui.connStatus.querySelector('span:last-child');
    if (connectionText) connectionText.textContent = 'Reconectando ao servidor…';
    setPlaceholderTexts();
  }
}

function updatePresenceUi() {
  const hostOnline = state.connected && state.hostOnline;
  const meta = hostOnline ? PRESENCE[state.presence.state] || PRESENCE.indefinido : PRESENCE.offline;

  ui.statusOrb.dataset.state = meta.orb;
  ui.statusTitle.textContent = meta.title;
  ui.statusNote.textContent =
    (state.presence.note && state.presence.note.trim()) ||
    (hostOnline ? meta.defaultNote : PRESENCE.offline.defaultNote);

  if (hostOnline) {
    document.title = `${meta.label} · O Leo está trabalhando?`;
  } else {
    document.title = 'O Leo está trabalhando?';
  }

  updatePresenceAge();
  setPlaceholderTexts();
}

function updatePresenceAge() {
  if (!state.presence.updatedAt) {
    ui.statusUpdated.textContent = '';
    return;
  }
  const prefix = state.hostOnline ? 'Status atualizado' : 'Último status';
  ui.statusUpdated.textContent = `${prefix} ${timeAgo(state.presence.updatedAt)}`;
}

function updateViewerCount() {
  if (!ui.viewerCount) return;
  if (!state.connected || !state.hostOnline) {
    ui.viewerCount.textContent = '';
    return;
  }
  const n = state.viewers;
  ui.viewerCount.textContent = n === 1 ? '1 pessoa assistindo' : `${n} pessoas assistindo`;
}

function setPlaceholderTexts() {
  for (const source of ['cam', 'screen']) {
    if (!state.connected) {
      panels[source].placeholderText.textContent = 'Reconectando ao servidor…';
    } else if (!state.hostOnline) {
      panels[source].placeholderText.textContent =
        'O PC do Leo está desconectado. O painel reconecta sozinho.';
    } else if (!state.sources[source]) {
      panels[source].placeholderText.textContent =
        source === 'cam'
          ? 'A webcam está desligada.'
          : 'A janela do AnyDesk não está sendo compartilhada.';
    } else {
      panels[source].placeholderText.textContent =
        source === 'cam' ? 'Conectando à webcam…' : 'Conectando à janela do AnyDesk…';
    }
  }
}

async function enterFullscreen(viewportId) {
  const viewport = document.getElementById(viewportId);
  if (!viewport) return;

  const card = viewport.closest('.card');

  try {
    if (viewport.requestFullscreen) {
      await viewport.requestFullscreen();
      return;
    }
  } catch {
    /* cai para o modo imersivo abaixo */
  }

  if (card) {
    state.immersive = card;
    card.classList.add('is-immersive');
    document.body.classList.add('has-immersive');
  } else {
    toast('Este navegador não permite tela cheia.');
  }
}

async function exitFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
  } catch {
    /* continua para o modo imersivo */
  }

  if (state.immersive) {
    state.immersive.classList.remove('is-immersive');
    document.body.classList.remove('has-immersive');
    state.immersive = null;
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', () => {});
}
