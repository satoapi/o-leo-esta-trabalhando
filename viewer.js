import {
  getClientId,
  getRoomForViewer,
  normalizePin,
  peerOptions,
  timeAgo,
  toast,
} from './shared.js?v=20261126g';

const AUTH_TIMEOUT_MS = 9000;
const HEARTBEAT_MS = 8000;
const WATCHDOG_MS = 24000;
const LIVE_WINDOW_MS = 6500;
const AUTO_PIN_KEY = 'leo-viewer-auto-pin';
const AUTO_FLAG_KEY = 'leo-viewer-auto';

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
  room: null,
  pin: '',
  clientId: getClientId(),
  device: null,
  peer: null,
  peerReady: false,
  peerTimer: null,
  conn: null,
  connPending: false,
  authenticated: false,
  hostOnline: false,
  connecting: false,
  authRejected: false,
  manualClose: false,
  attempts: 0,
  reconnectTimer: null,
  authTimer: null,
  heartbeatTimer: null,
  watchdogTimer: null,
  streamTimer: null,
  resyncs: 0,
  lastInbound: 0,
  presence: { state: 'indefinido', note: '', updatedAt: 0 },
  viewers: 0,
  sources: { cam: false, screen: false },
  streams: { cam: null, screen: null },
  calls: { cam: null, screen: null },
  hasFrame: { cam: false, screen: false },
  lastFrame: { cam: 0, screen: 0 },
  frameCallbacks: { cam: null, screen: null },
  frameTimers: { cam: null, screen: null },
  immersive: null,
};

state.device = describeDevice();
refineDeviceInfo();

const panels = {};

for (const source of ['cam', 'screen']) {
  const card = document.querySelector(`[data-panel="${source}"]`);
  const video = document.getElementById(`${source}-video`);
  const viewport = document.getElementById(`${source}-viewport`);
  const badge = card.querySelector('[data-badge]');
  const placeholder = card.querySelector('[data-placeholder]');
  const placeholderText = card.querySelector('[data-placeholder-text]');
  const stale = card.querySelector('[data-stale]');
  const staleText = card.querySelector('[data-stale-text]');
  const dot = card.querySelector('[data-dot]');
  const footText = card.querySelector('[data-foot-text]');
  const resolution = card.querySelector('[data-resolution]');

  video.muted = true;
  video.addEventListener('loadeddata', () => {
    if (state.streams[source]) markFrame(source, true);
  });
  video.addEventListener('playing', () => {
    if (state.streams[source]) markFrame(source, true);
  });
  video.addEventListener('resize', () => {
    if (state.streams[source]) updateResolution(source);
  });
  video.addEventListener('emptied', () => {
    if (!video.srcObject) clearPanel(source);
  });
  video.addEventListener('click', () => {
    video.play().catch(() => {});
  });

  panels[source] = {
    card,
    video,
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
  gate: document.getElementById('auth-gate'),
  app: document.getElementById('app'),
  form: document.getElementById('auth-form'),
  pinInput: document.getElementById('pin'),
  autoLogin: document.getElementById('auto-login'),
  gateError: document.querySelector('[data-auth-error]'),
  gateButton: document.querySelector('#auth-form button[type="submit"]'),
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

bindPageUi();
setInterval(() => {
  render();
  updatePresenceAge();
}, 1000);

const room = getRoomForViewer();
if (!room) {
  ui.gate.hidden = false;
  ui.app.hidden = true;
  setGateMessage('O link está incompleto. Peça ao Leo o link completo do painel.');
  ui.gateButton.disabled = true;
} else {
  state.room = room;
  ui.gate.hidden = false;
  ui.app.hidden = true;

  const auto = readAutoLogin();
  let savedPin = '';
  try {
    savedPin = sessionStorage.getItem('leo-viewer-pin') || '';
  } catch {
    /* modo privado */
  }

  if (ui.autoLogin) ui.autoLogin.checked = auto.enabled;
  const initialPin = auto.enabled && auto.pin ? auto.pin : savedPin;

  if (initialPin) {
    ui.pinInput.value = initialPin;
    setTimeout(() => attempt(initialPin, { auto: true }), 120);
  } else {
    setTimeout(() => ui.pinInput.focus(), 120);
  }

  ui.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const pin = normalizePin(ui.pinInput.value);
    if (!pin) {
      setGateMessage('Digite o PIN para continuar.');
      ui.pinInput.focus();
      return;
    }
    attempt(pin);
  });
}

window.addEventListener('pagehide', () => {
  state.manualClose = true;
  shutdown();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.authenticated) {
    send({ type: 'ping' });
  }
});

window.leoViewerDebug = { state, panels };

function readAutoLogin() {
  try {
    const enabled = localStorage.getItem(AUTO_FLAG_KEY) !== '0';
    const pin = localStorage.getItem(AUTO_PIN_KEY) || '';
    return { enabled, pin };
  } catch {
    return { enabled: false, pin: '' };
  }
}

function saveAutoLogin(pin, enabled) {
  try {
    if (enabled) {
      localStorage.setItem(AUTO_FLAG_KEY, '1');
      localStorage.setItem(AUTO_PIN_KEY, pin);
    } else {
      localStorage.setItem(AUTO_FLAG_KEY, '0');
      localStorage.removeItem(AUTO_PIN_KEY);
    }
  } catch {
    /* modo privado */
  }
}

function clearAutoLogin() {
  try {
    localStorage.removeItem(AUTO_PIN_KEY);
    localStorage.setItem(AUTO_FLAG_KEY, '0');
  } catch {
    /* modo privado */
  }
}

function bindPageUi() {
  for (const button of document.querySelectorAll('[data-fullscreen]')) {
    button.addEventListener('click', () => enterFullscreen(button.dataset.fullscreen));
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

  document.querySelector('[data-logout]')?.addEventListener('click', () => {
    try {
      sessionStorage.removeItem('leo-viewer-pin');
    } catch {
      /* ignora */
    }
    clearAutoLogin();
    state.manualClose = true;
    shutdown();
    location.reload();
  });
}

function attempt(pin, { auto = false } = {}) {
  if (!state.room) return;

  state.pin = pin;
  state.authRejected = false;
  state.manualClose = false;
  state.attempts = 0;
  state.resyncs = 0;

  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;

  if (state.conn) {
    try {
      state.conn.close();
    } catch {
      /* ignora */
    }
    state.conn = null;
    state.connPending = false;
  }

  setGateError(auto ? 'Conectando ao PC do Leo…' : '');
  setGateBusy(true, 'Conectando…');
  connectNow();
}

function connectNow() {
  if (!state.room || !state.pin || state.authRejected || state.manualClose) return;
  if (state.authenticated) return;
  if (state.connPending) return;

  state.connecting = true;
  ensurePeer();
}

function ensurePeer() {
  if (state.peer && !state.peer.destroyed && state.peer.open) {
    openConnection();
    return;
  }

  if (state.peer && !state.peer.destroyed) {
    // O Peer já existe, mas ainda está abrindo ou se reconectando.
    clearTimeout(state.peerTimer);
    state.peerTimer = setTimeout(() => {
      if (state.peer && state.peer.open) {
        openConnection();
      } else {
        state.connecting = false;
        scheduleReconnect(4000);
      }
    }, 9000);
    return;
  }

  if (typeof window.Peer !== 'function') {
    setGateError('Não foi possível carregar o componente de conexão. Recarregue a página.');
    setGateBusy(false);
    return;
  }

  let peer;
  try {
    peer = new window.Peer(peerOptions());
  } catch {
    scheduleReconnect(5000);
    return;
  }

  state.peer = peer;
  state.peerReady = false;

  peer.on('open', () => {
    state.peerReady = true;
    state.connecting = false;
    clearTimeout(state.peerTimer);
    openConnection();
  });

  peer.on('call', handleCall);

  peer.on('disconnected', () => {
    state.peerReady = false;
    if (!state.manualClose) {
      try {
        peer.reconnect();
      } catch {
        scheduleReconnect(3000);
      }
    }
  });

  peer.on('close', () => {
    state.peerReady = false;
  });

  peer.on('error', handlePeerError);
}

function openConnection() {
  if (!state.peer?.open || state.connPending || state.authenticated) return;

  let conn;
  try {
    conn = state.peer.connect(state.room, {
      reliable: true,
      metadata: { v: 1 },
    });
  } catch {
    scheduleReconnect(3000);
    return;
  }

  state.conn = conn;
  state.connPending = true;
  state.lastInbound = Date.now();

  conn.on('open', () => {
    state.connPending = false;
    state.connecting = false;
    conn.send({
      type: 'hello',
      pin: state.pin,
      clientId: state.clientId,
      device: state.device,
      v: 1,
    });
    clearTimeout(state.authTimer);
    state.authTimer = setTimeout(() => {
      if (state.authenticated) return;
      closeConnection();
      if (!state.authRejected) {
        setGateError('O PC do Leo não respondeu. Vou tentar de novo sozinho…');
        setGateBusy(false);
        scheduleReconnect();
      }
    }, AUTH_TIMEOUT_MS);
    startTimers();
  });

  conn.on('data', handleData);

  conn.on('close', () => {
    state.connPending = false;
    if (state.conn === conn) state.conn = null;
    clearTimeout(state.authTimer);
    if (state.authenticated) {
      state.authenticated = false;
      setHostOffline();
      scheduleReconnect();
    } else if (!state.authRejected) {
      setGateError('Conexão encerrada. Tentando de novo…');
      setGateBusy(false);
      scheduleReconnect();
    }
  });

  conn.on('error', () => {
    state.connPending = false;
    if (state.conn === conn) state.conn = null;
    clearTimeout(state.authTimer);
    if (state.authenticated) {
      state.authenticated = false;
      setHostOffline();
    }
    if (!state.authRejected) scheduleReconnect();
  });
}

function handleData(raw) {
  let message;
  try {
    message = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return;
  }
  if (!message || typeof message.type !== 'string') return;

  state.lastInbound = Date.now();

  if (message.type === 'identify') {
    sendDevice();
    return;
  }

  if (message.type === 'auth-ok') {
    clearTimeout(state.authTimer);
    state.authenticated = true;
    state.hostOnline = true;
    state.authRejected = false;
    state.attempts = 0;
    state.resyncs = 0;
    state.connecting = false;

    state.presence = normalizePresence(message.presence);
    state.viewers = Number(message.viewers) || 0;
    state.sources.cam = Boolean(message.sources?.cam);
    state.sources.screen = Boolean(message.sources?.screen);

    try {
      sessionStorage.setItem('leo-viewer-pin', state.pin);
    } catch {
      /* modo privado */
    }
    saveAutoLogin(state.pin, Boolean(ui.autoLogin?.checked));

    ui.gate.hidden = true;
    ui.app.hidden = false;
    setGateBusy(false, 'Entrar no painel');
    updateHostUi();
    updatePresenceUi();
    updateViewerCount();
    render();
    ensureStreams();

    for (const source of ['cam', 'screen']) {
      if (state.sources[source] && panels[source].video.srcObject) {
        panels[source].video.play().catch(() => {});
      }
    }
    return;
  }

  if (message.type === 'auth-error') {
    state.authRejected = true;
    state.authenticated = false;
    state.connecting = false;
    clearTimeout(state.authTimer);
    try {
      sessionStorage.removeItem('leo-viewer-pin');
    } catch {
      /* ignora */
    }
    clearAutoLogin();
    if (ui.autoLogin) ui.autoLogin.checked = false;
    closeConnection();
    ui.gate.hidden = false;
    ui.app.hidden = true;
    setGateBusy(false, 'Entrar no painel');
    setGateMessage('PIN incorreto. Confira com o Leo e tente novamente.');
    ui.pinInput.select();
    return;
  }

  if (message.type === 'presence') {
    state.presence = normalizePresence(message.presence);
    updatePresenceUi();
    return;
  }

  if (message.type === 'viewers') {
    state.viewers = Number(message.count) || 0;
    updateViewerCount();
    return;
  }

  if (message.type === 'source') {
    if (message.kind === 'cam' || message.kind === 'screen') {
      applySourceState(message.kind, Boolean(message.active));
    }
    return;
  }

  if (message.type === 'auth-ok-details') {
    /* reservado para versões futuras */
  }
}

function handlePeerError(error) {
  const type = error?.type || '';

  if (type === 'peer-unavailable') {
    state.connecting = false;
    state.connPending = false;
    clearTimeout(state.authTimer);
    if (state.authenticated) {
      state.authenticated = false;
      setHostOffline();
    } else {
      setGateError('O PC do Leo não está transmitindo agora. Vou tentar de novo sozinho…');
      setGateBusy(false);
    }
    scheduleReconnect();
    return;
  }

  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'ssl-unavailable') {
    state.peerReady = false;
    state.connecting = false;
    if (!state.authenticated) {
      setGateError('Sem conexão com o serviço de conexão. Tentando de novo…');
      setGateBusy(false);
    } else {
      setHostOffline();
    }
    destroyPeer();
    scheduleReconnect(4000);
    return;
  }

  if (type === 'unavailable-id') {
    destroyPeer();
    scheduleReconnect(2500);
    return;
  }

  if (type === 'browser-incompatible') {
    setGateError('Este navegador não consegue fazer a conexão direta. Use Chrome, Edge ou Safari atualizado.');
    setGateBusy(false);
    state.manualClose = true;
  }
}

function scheduleReconnect(explicitDelay) {
  if (state.manualClose || state.authRejected || !state.pin) return;
  if (state.reconnectTimer) return;

  state.attempts += 1;
  const backoff = Math.min(15000, Math.round(2800 * 1.55 ** Math.min(state.attempts, 5)));
  const delay = explicitDelay || backoff;

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.manualClose || state.authRejected || !state.pin) return;
    connectNow();
  }, delay);
}

function startTimers() {
  clearInterval(state.heartbeatTimer);
  clearInterval(state.watchdogTimer);

  state.heartbeatTimer = setInterval(() => {
    if (state.conn?.open) send({ type: 'ping' });
  }, HEARTBEAT_MS);

  state.watchdogTimer = setInterval(() => {
    if (state.manualClose) return;
    if (state.authenticated && Date.now() - state.lastInbound > WATCHDOG_MS) {
      closeConnection();
      state.authenticated = false;
      setHostOffline();
      scheduleReconnect(1200);
    }
  }, 5000);
}

function send(payload) {
  try {
    if (state.conn?.open) state.conn.send(payload);
  } catch {
    /* a reconexão cuida */
  }
}

function closeConnection() {
  clearTimeout(state.authTimer);
  state.connPending = false;
  const conn = state.conn;
  state.conn = null;
  if (!conn) return;
  try {
    conn.close();
  } catch {
    /* ignora */
  }
}

function destroyPeer() {
  const peer = state.peer;
  state.peer = null;
  state.peerReady = false;
  clearTimeout(state.peerTimer);
  if (!peer) return;
  try {
    peer.destroy();
  } catch {
    /* ignora */
  }
}

function shutdown() {
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.authTimer);
  clearTimeout(state.streamTimer);
  clearInterval(state.heartbeatTimer);
  clearInterval(state.watchdogTimer);
  state.reconnectTimer = null;
  closeConnection();
  destroyPeer();
  for (const source of ['cam', 'screen']) detachStream(source);
}

function handleCall(call) {
  const kind = call?.metadata?.kind;
  if (kind !== 'cam' && kind !== 'screen') {
    try {
      call.close();
    } catch {
      /* ignora */
    }
    return;
  }

  const previous = state.calls[kind];
  if (previous && previous !== call) {
    try {
      previous.close();
    } catch {
      /* ignora */
    }
  }

  state.calls[kind] = call;
  state.resyncs = 0;

  try {
    call.answer();
  } catch {
    /* a chamada pode ter sido encerrada */
  }

  call.on('stream', (stream) => {
    if (state.calls[kind] !== call) return;
    attachStream(kind, stream);
  });

  call.on('close', () => {
    if (state.calls[kind] !== call) return;
    state.calls[kind] = null;
    detachStream(kind);
    if (state.authenticated && state.sources[kind]) ensureStreams(4000);
  });

  call.on('error', () => {
    if (state.calls[kind] !== call) return;
    state.calls[kind] = null;
    detachStream(kind);
    if (state.authenticated && state.sources[kind]) ensureStreams(5000);
  });
}

function attachStream(kind, stream) {
  const panel = panels[kind];
  const video = panel.video;
  const previous = state.streams[kind];

  state.streams[kind] = stream;

  if (previous && previous !== stream) {
    for (const track of previous.getTracks()) {
      try {
        track.stop();
      } catch {
        /* ignora */
      }
    }
  }

  state.hasFrame[kind] = false;
  state.lastFrame[kind] = 0;
  state.resyncs = 0;

  panel.viewport.classList.remove('has-frame', 'is-stale');
  panel.placeholder.hidden = false;
  panel.stale.hidden = true;
  panel.resolution.textContent = '';
  setPlaceholderTexts();

  video.srcObject = stream;
  video.muted = true;
  video.play().catch(() => {
    // Alguns navegadores só liberam o play depois de um toque.
    panel.placeholderText.textContent = 'Toque na imagem para iniciar o vídeo.';
  });

  startFrameWatch(kind, video, stream);
  renderPanel(kind);
}

function detachStream(kind) {
  stopFrameWatch(kind);
  const panel = panels[kind];
  const stream = state.streams[kind];
  state.streams[kind] = null;
  state.hasFrame[kind] = false;
  state.lastFrame[kind] = 0;

  if (stream) {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* ignora */
      }
    }
  }

  try {
    panel.video.pause();
  } catch {
    /* ignora */
  }
  panel.video.srcObject = null;
  clearPanel(kind);
}

function clearPanel(kind) {
  const panel = panels[kind];
  state.hasFrame[kind] = false;
  state.lastFrame[kind] = 0;
  panel.viewport.classList.remove('has-frame', 'is-stale');
  panel.placeholder.hidden = false;
  panel.stale.hidden = true;
  panel.resolution.textContent = '';
  renderPanel(kind);
}

function startFrameWatch(kind, video, stream) {
  stopFrameWatch(kind);

  if (typeof video.requestVideoFrameCallback === 'function') {
    const tick = () => {
      if (state.streams[kind] !== stream) return;
      markFrame(kind, false);
      state.frameCallbacks[kind] = video.requestVideoFrameCallback(tick);
    };
    state.frameCallbacks[kind] = video.requestVideoFrameCallback(tick);
    return;
  }

  state.frameTimers[kind] = setInterval(() => {
    if (state.streams[kind] !== stream) return;
    if (video.readyState >= 2 && video.videoWidth > 0) markFrame(kind, false);
  }, 1000);
}

function stopFrameWatch(kind) {
  const video = panels[kind].video;
  const callback = state.frameCallbacks[kind];
  if (callback != null && typeof video.cancelVideoFrameCallback === 'function') {
    try {
      video.cancelVideoFrameCallback(callback);
    } catch {
      /* ignora */
    }
  }
  state.frameCallbacks[kind] = null;
  clearInterval(state.frameTimers[kind]);
  state.frameTimers[kind] = null;
}

function markFrame(kind, firstOnly) {
  const panel = panels[kind];
  const hadFrame = state.hasFrame[kind];
  state.hasFrame[kind] = true;
  state.lastFrame[kind] = Date.now();

  if (!hadFrame) {
    panel.viewport.classList.add('has-frame');
    panel.viewport.classList.remove('is-stale');
    panel.placeholder.hidden = true;
    panel.stale.hidden = true;
    updateResolution(kind);
    renderPanel(kind);
  }
}

function updateResolution(kind) {
  const video = panels[kind].video;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return;
  const label = `${width} × ${height}`;
  if (panels[kind].resolution.textContent !== label) {
    panels[kind].resolution.textContent = label;
  }
}

function applySourceState(kind, active) {
  state.sources[kind] = active;

  if (!active) {
    const call = state.calls[kind];
    state.calls[kind] = null;
    if (call) {
      try {
        call.close();
      } catch {
        /* ignora */
      }
    }
    detachStream(kind);
  } else {
    setPlaceholderTexts();
    renderPanel(kind);
    ensureStreams(5000);
  }

  setPlaceholderTexts();
  renderPanel(kind);
}

function ensureStreams(delay = 5000) {
  clearTimeout(state.streamTimer);
  state.streamTimer = setTimeout(() => {
    if (!state.authenticated) return;
    let missing = false;
    for (const source of ['cam', 'screen']) {
      if (state.sources[source] && !state.streams[source]) missing = true;
    }
    if (!missing) return;
    if (state.resyncs >= 3) return;
    state.resyncs += 1;
    send({ type: 'resync' });
    ensureStreams(7000);
  }, delay);
}

function setHostOffline() {
  state.hostOnline = false;
  state.sources.cam = false;
  state.sources.screen = false;
  state.viewers = 0;
  for (const source of ['cam', 'screen']) {
    const call = state.calls[source];
    state.calls[source] = null;
    if (call) {
      try {
        call.close();
      } catch {
        /* ignora */
      }
    }
    detachStream(source);
  }
  updateHostUi();
  updatePresenceUi();
  updateViewerCount();
  setPlaceholderTexts();
  render();
}

function render() {
  renderPanel('cam');
  renderPanel('screen');
}

function renderPanel(kind) {
  const panel = panels[kind];
  const sourceOn = state.hostOnline && state.sources[kind];
  const hasFrame = Boolean(state.hasFrame[kind] && state.streams[kind]);
  const age = Date.now() - state.lastFrame[kind];
  const live = sourceOn && hasFrame && (kind === 'screen' || age < LIVE_WINDOW_MS);
  const stale = sourceOn && hasFrame && !live;

  panel.viewport.classList.toggle('has-frame', hasFrame && !stale);
  panel.viewport.classList.toggle('is-stale', stale);
  panel.stale.hidden = !stale;

  panel.badge.classList.remove('is-live', 'is-stale', 'is-error');
  panel.dot.classList.remove('live');

  if (!state.hostOnline) {
    panel.badge.textContent = 'Sem sinal';
    panel.footText.textContent = 'Sem transmissão';
  } else if (!state.sources[kind]) {
    panel.badge.textContent = 'Desligada';
    panel.footText.textContent = kind === 'cam' ? 'Webcam desligada' : 'AnyDesk desligado';
  } else if (live) {
    panel.badge.classList.add('is-live');
    panel.badge.textContent = 'Ao vivo';
    panel.dot.classList.add('live');
    panel.footText.textContent = age < 1500 ? 'Atualizado agora' : `Atualizado ${timeAgo(state.lastFrame[kind])}`;
  } else if (stale) {
    panel.badge.classList.add('is-stale');
    panel.badge.textContent = 'Sem sinal';
    panel.footText.textContent = `Última imagem ${timeAgo(state.lastFrame[kind])}`;
    panel.staleText.textContent = `A imagem parou de chegar ${timeAgo(state.lastFrame[kind])}. Tentando novamente…`;
  } else {
    panel.badge.textContent = 'Aguardando';
    panel.footText.textContent = kind === 'cam' ? 'Aguardando a webcam' : 'Aguardando o AnyDesk';
  }
}

function updateHostUi() {
  const online = state.authenticated && state.hostOnline;
  const connected = state.authenticated && state.hostOnline;

  ui.hostPill.classList.toggle('online', online);
  ui.hostPill.classList.toggle('offline', !online);
  ui.hostLabel.textContent = online ? 'PC conectado' : state.authenticated ? 'Reconectando…' : 'PC desconectado';

  const connectionText = ui.connStatus.querySelector('span:last-child');
  if (connected) {
    ui.serverStatus.textContent = 'Conexão direta';
    ui.serverDot.classList.add('live');
    ui.connStatus.classList.add('is-connected');
    if (connectionText) connectionText.textContent = 'P2P conectado';
  } else {
    ui.serverStatus.textContent = state.authenticated ? 'Reconectando…' : 'Conectando…';
    ui.serverDot.classList.remove('live');
    ui.connStatus.classList.remove('is-connected');
    if (connectionText) connectionText.textContent = 'Conectando ao PC do Leo…';
  }

  setPlaceholderTexts();
}

function updatePresenceUi() {
  const hostOnline = state.authenticated && state.hostOnline;
  const meta = hostOnline ? PRESENCE[state.presence.state] || PRESENCE.indefinido : PRESENCE.offline;

  ui.statusOrb.dataset.state = meta.orb;
  ui.statusTitle.textContent = meta.title;
  ui.statusNote.textContent =
    (state.presence.note && state.presence.note.trim()) ||
    (hostOnline ? meta.defaultNote : PRESENCE.offline.defaultNote);

  document.title = hostOnline ? `${meta.label} · O Leo está trabalhando?` : 'O Leo está trabalhando?';
  updatePresenceAge();
  setPlaceholderTexts();
}

function updatePresenceAge() {
  if (!state.presence.updatedAt) {
    ui.statusUpdated.textContent = '';
    return;
  }
  const prefix = state.authenticated && state.hostOnline ? 'Status atualizado' : 'Último status';
  ui.statusUpdated.textContent = `${prefix} ${timeAgo(state.presence.updatedAt)}`;
}

function updateViewerCount() {
  if (!state.authenticated || !state.hostOnline) {
    ui.viewerCount.textContent = '';
    return;
  }
  const count = state.viewers;
  if (count <= 0) {
    ui.viewerCount.textContent = 'Ninguém assistindo ainda';
  } else if (count === 1) {
    ui.viewerCount.textContent = '1 pessoa assistindo';
  } else {
    ui.viewerCount.textContent = `${count} pessoas assistindo`;
  }
}

function setPlaceholderTexts() {
  for (const source of ['cam', 'screen']) {
    if (!state.authenticated) {
      panels[source].placeholderText.textContent = 'Conectando ao PC do Leo…';
    } else if (!state.hostOnline) {
      panels[source].placeholderText.textContent = 'O PC do Leo está desconectado. O painel reconecta sozinho.';
    } else if (!state.sources[source]) {
      panels[source].placeholderText.textContent =
        source === 'cam'
          ? 'A webcam está desligada.'
          : 'A janela do AnyDesk não está sendo compartilhada.';
    } else if (!state.streams[source]) {
      panels[source].placeholderText.textContent =
        source === 'cam' ? 'Conectando à webcam…' : 'Conectando à janela do AnyDesk…';
    } else if (!state.hasFrame[source]) {
      panels[source].placeholderText.textContent =
        source === 'cam' ? 'Recebendo o primeiro quadro da webcam…' : 'Recebendo a janela do AnyDesk…';
    } else {
      panels[source].placeholderText.textContent = '';
    }
  }
}

function normalizePresence(value) {
  const valid = ['trabalhando', 'pausa', 'almocando', 'banheiro', 'ausente', 'indefinido'];
  return {
    state: valid.includes(value?.state) ? value.state : 'indefinido',
    note: String(value?.note ?? '').slice(0, 140),
    updatedAt: Number(value?.updatedAt) || 0,
  };
}

function setGateMessage(message) {
  if (ui.gateError) ui.gateError.textContent = message || '';
}

function setGateError(message) {
  setGateMessage(message);
}

function setGateBusy(busy, label = 'Conectando…') {
  if (!ui.gateButton) return;
  ui.gateButton.disabled = busy;
  ui.gateButton.textContent = busy ? label : 'Entrar no painel';
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
    /* cai para o modo imersivo */
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

/* ---------------- Identificação do aparelho de quem assiste ---------------- */

function describeDevice() {
  const ua = navigator.userAgent || '';
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const touchMac = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  const iPad = /iPad/i.test(ua) || touchMac;
  const iPhone = /iPhone|iPod/i.test(ua);
  const android = /Android/i.test(ua);
  const tablet = iPad || (android && !/Mobile/i.test(ua));
  const mobile = !tablet && (iPhone || android || /Mobile|Windows Phone/i.test(ua));

  const browser = detectBrowser(ua);
  const os = detectOs(ua, platform, { iPad, iPhone, android });
  const model = detectModel(ua, platform, { iPad, iPhone, android });
  const kind = tablet ? 'tablet' : mobile ? 'celular' : 'computador';

  return {
    label: composeDeviceLabel(model, browser),
    kind,
    os,
    browser,
    screen: `${window.screen?.width || 0}×${window.screen?.height || 0}`,
    icon: mobile || tablet ? '📱' : '💻',
  };
}

function detectBrowser(ua) {
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\//i.test(ua)) return 'Opera';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/CriOS/i.test(ua)) return 'Chrome';
  if (/FxiOS/i.test(ua)) return 'Firefox';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Chrome\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua)) return 'Safari';
  return 'Navegador';
}

function detectOs(ua, platform, flags) {
  if (/Windows/i.test(platform) || /Windows NT/i.test(ua)) return 'Windows';
  if (/Android/i.test(ua)) {
    const match = ua.match(/Android\s+([\d.]+)/i);
    return match ? `Android ${match[1]}` : 'Android';
  }
  if (flags.iPad || flags.iPhone) return 'iOS';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return 'macOS';
  if (/Linux/i.test(platform) || /Linux/i.test(ua)) return 'Linux';
  return 'Sistema desconhecido';
}

function detectModel(ua, platform, flags) {
  if (flags.iPad) return 'iPad';
  if (flags.iPhone) return 'iPhone';
  if (flags.android) {
    const match = ua.match(/Android [^;)]*;\s*([^;)]+?)(?:\s+Build[/;]|\s*\)|;)/i);
    const model = match?.[1]?.replace(/\s+wv$/i, '').trim();
    if (model && !/^(K|wv|Mobile)$/i.test(model)) return model;
    return /Mobile/i.test(ua) ? 'Celular Android' : 'Tablet Android';
  }
  if (/Windows/i.test(platform) || /Windows NT/i.test(ua)) return 'PC Windows';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return 'Mac';
  if (/Linux/i.test(platform) || /Linux/i.test(ua)) return 'PC Linux';
  return 'Computador';
}

function composeDeviceLabel(model, browser) {
  const parts = [];
  if (model) parts.push(model);
  if (browser && browser !== model) parts.push(browser);
  return parts.join(' · ') || 'Dispositivo';
}

async function refineDeviceInfo() {
  const data = navigator.userAgentData;
  if (!data || typeof data.getHighEntropyValues !== 'function') return;

  try {
    const values = await data.getHighEntropyValues(['model', 'platform']);
    const model = String(values?.model || '').trim();
    if (!model) return;

    const current = state.device || describeDevice();
    const next = {
      ...current,
      label: composeDeviceLabel(model, current.browser),
      os: String(values?.platform || '').trim() || current.os,
    };
    if (next.label === current.label && next.os === current.os) return;
    state.device = next;
    sendDevice();
  } catch {
    /* mantém a identificação básica */
  }
}

function sendDevice() {
  if (!state.authenticated || state.conn?.open !== true) return;
  send({ type: 'device', device: state.device });
}
