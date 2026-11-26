import {
  copyText,
  formatBytes,
  getHostPin,
  getOrCreateHostRoom,
  loadPresence,
  normalizePin,
  peerOptions,
  savePresence as persistPresence,
  setHostPin,
  timeAgo,
  toast,
  viewerLink,
} from './shared.js?v=20261126g';

const QUALITY = {
  leve: {
    cam: { maxW: 640, maxH: 360, fps: 15, maxBitrate: 300_000 },
    screen: { maxW: 1280, maxH: 720, fps: 10, maxBitrate: 650_000 },
  },
  padrao: {
    cam: { maxW: 960, maxH: 540, fps: 24, maxBitrate: 700_000 },
    screen: { maxW: 1280, maxH: 720, fps: 15, maxBitrate: 1_400_000 },
  },
  nitido: {
    cam: { maxW: 1280, maxH: 720, fps: 24, maxBitrate: 1_200_000 },
    screen: { maxW: 1280, maxH: 720, fps: 18, maxBitrate: 2_000_000 },
  },
  maxima: {
    cam: { maxW: 1920, maxH: 1080, fps: 30, maxBitrate: 2_200_000 },
    screen: { maxW: 1920, maxH: 1080, fps: 24, maxBitrate: 3_400_000 },
  },
};

function qualityFor(kind) {
  const preset = QUALITY[state.quality] || QUALITY.nitido;
  return preset[kind] || preset.cam;
}

function viewerShareFactor() {
  const viewers = Math.max(1, Number(state.viewersCount) || 1);
  if (viewers <= 1) return 1;
  return Math.max(0.65, 1 / Math.sqrt(viewers));
}

const senderTuning = new WeakMap();

function tuningFor(call, kind) {
  let tuning = senderTuning.get(call);
  if (!tuning || tuning.kind !== kind) {
    tuning = { kind, factor: 1, fpsFactor: 1, bad: 0, cpu: 0, good: 0, applying: false };
    senderTuning.set(call, tuning);
  }
  return tuning;
}

const PRESENCE_LABEL = {
  trabalhando: 'Trabalhando',
  pausa: 'Em pausa',
  almocando: 'Almoçando',
  banheiro: 'No banheiro',
  ausente: 'Ausente',
  indefinido: 'Sem status',
};

const state = {
  room: getOrCreateHostRoom(),
  pin: getHostPin(),
  quality: QUALITY[localStorage.getItem('leo-quality')] ? localStorage.getItem('leo-quality') : 'nitido',
  presence: loadPresence(),
  peer: null,
  peerReady: false,
  peerError: '',
  viewers: new Map(),
  streams: { cam: null, screen: null },
  sourceActive: { cam: false, screen: false },
  calls: { cam: new Map(), screen: new Map() },
  starting: { cam: false, screen: false },
  errors: { cam: '', screen: '' },
  viewersCount: 0,
  sentBytes: 0,
  sentFrames: 0,
  fps: 0,
  fails: 0,
  statsBusy: false,
  statsPrev: { at: performance.now(), frames: 0 },
  wakeLock: null,
  shuttingDown: false,
  started: false,
};

const el = {};
for (const id of [
  'quality',
  'stat-viewers',
  'stat-fps',
  'stat-sent',
  'stat-fails',
  'viewers-card',
  'viewers-card-count',
  'viewers-list',
  'popout',
  'presence-badge',
  'presence-note',
  'presence-save',
  'cam-badge',
  'cam-viewport',
  'cam-video',
  'cam-toggle',
  'cam-toggle-label',
  'cam-device-row',
  'cam-device',
  'cam-hint',
  'screen-badge',
  'screen-viewport',
  'screen-video',
  'screen-start',
  'screen-stop',
  'screen-hint',
  'share-link',
  'share-copy',
  'share-invite',
  'viewer-open',
  'access-pin',
  'pin-save',
  'room-new',
  'host-conn-hint',
  'host-mode-pill',
  'host-mode-text',
  'secure-warning',
  'browser-warning',
  'background-notice',
  'host-error',
  'host-error-text',
  'boss-warning',
  'boss-warning-count',
  'boss-warning-device',
  'boss-popup',
  'boss-popup-text',
  'boss-popup-close',
  'boss-popup-sound',
]) {
  el[id] = document.getElementById(id);
}

let bossPopupShown = false;
let bossPopupTimer = null;
let bossAudioPrimed = false;
let peerIdRetries = 0;
const bossAlertAudio = new Audio('./boss-alert.mp3');
bossAlertAudio.preload = 'auto';

const presenceButtons = [...document.querySelectorAll('[data-presence]')];
const screenHintDefault = el['screen-hint']?.innerHTML || '';
const fakeCam = new URLSearchParams(location.search).get('fakecam') === '1';

start();

function start() {
  if (state.started) return;
  state.started = true;

  window.leoHostDebug = { state, QUALITY, updateStats };

  el.quality.value = state.quality;
  el['share-link'].value = viewerLink(state.room);
  if (el['viewer-open']) el['viewer-open'].href = viewerLink(state.room);
  el['access-pin'].value = state.pin;
  el['presence-note'].value = state.presence.note || '';

  if (!window.isSecureContext) el['secure-warning'].hidden = false;
  if (!navigator.mediaDevices?.getUserMedia) el['browser-warning'].hidden = false;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    el['screen-start'].disabled = true;
    el['screen-hint'].textContent =
      'Este navegador não permite compartilhar tela. Use Chrome ou Edge no computador para mostrar o AnyDesk.';
  }

  bindUi();
  updatePeerUi();
  updateSourceUi('cam');
  updateSourceUi('screen');
  renderPresence();
  updateStats();

  initPeer();
  setInterval(sampleStats, 1000);
  setInterval(adaptStreamQuality, 5000);
  setInterval(checkViewerHeartbeats, 10_000);
  setInterval(() => {
    renderPresenceAge();
    renderViewers();
  }, 30_000);

  document.addEventListener('visibilitychange', () => {
    updateBackgroundNotice();
    if (document.visibilityState === 'visible' && anyActive()) requestWakeLock();
  });

  window.addEventListener('beforeunload', (event) => {
    if (!anyActive()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  window.addEventListener('pagehide', () => {
    state.shuttingDown = true;
    shutdown();
  });

  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    const hint = document.createElement('p');
    hint.className = 'hint warn';
    hint.textContent =
      'Este link é local. Para abrir no celular ou no PC do seu chefe, use o endereço do GitHub Pages.';
    el['share-link'].closest('.host-side')?.appendChild(hint);
  }
}

function bindUi() {
  el['boss-popup-close']?.addEventListener('click', hideBossPopup);
  el['boss-popup-sound']?.addEventListener('click', () => {
    primeBossAudio();
    playBossAlert();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && el['boss-popup'] && !el['boss-popup'].hidden) hideBossPopup();
  });
  document.addEventListener('pointerdown', primeBossAudio, { once: true, capture: true });

  el['cam-toggle'].addEventListener('change', () => {
    if (el['cam-toggle'].checked) startCam();
    else stopSource('cam');
  });

  el['screen-start'].addEventListener('click', startScreen);
  el['screen-stop'].addEventListener('click', () => stopSource('screen'));

  el.quality.addEventListener('change', () => {
    const value = el.quality.value;
    if (!QUALITY[value]) return;
    state.quality = value;
    localStorage.setItem('leo-quality', value);
    applyQuality();
    toast('Qualidade atualizada.');
  });

  el.popout?.addEventListener('click', () => {
    const win = window.open(
      'host.html?janela=1',
      'leo-transmissao',
      'popup=yes,width=780,height=980',
    );
    if (!win) toast('O navegador bloqueou a janela. Libere pop-ups para este site.');
  });

  el['cam-device'].addEventListener('change', async () => {
    const deviceId = el['cam-device'].value;
    if (!deviceId) return;
    stopSource('cam', { silent: true });
    await startCam(deviceId);
  });

  for (const button of presenceButtons) {
    button.addEventListener('click', () => savePresenceState(button.dataset.presence));
  }

  el['presence-save'].addEventListener('click', () => {
    const current = state.presence.state === 'indefinido' ? 'trabalhando' : state.presence.state;
    savePresenceState(current);
  });

  el['presence-note'].addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const current = state.presence.state === 'indefinido' ? 'trabalhando' : state.presence.state;
    savePresenceState(current);
  });

  el['share-copy'].addEventListener('click', () => {
    copyLink();
  });

  el['share-invite'].addEventListener('click', () => {
    copyInvite();
  });

  el['pin-save'].addEventListener('click', () => {
    const pin = normalizePin(el['access-pin'].value);
    if (pin.length < 4) {
      toast('Use um PIN com pelo menos 4 caracteres.');
      el['access-pin'].focus();
      return;
    }
    state.pin = pin;
    setHostPin(pin);
    el['access-pin'].value = pin;
    toast('PIN salvo. Quem já está assistindo continua conectado.');
  });

  el['access-pin'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      el['pin-save'].click();
    }
  });

  el['room-new']?.addEventListener('click', () => {
    toast('O link é fixo para manter o atalho compartilhado funcionando.');
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (state.sourceActive.cam) refreshDevices();
    });
  }
}

/* ---------------- Peer / sinalização ---------------- */

function initPeer() {
  if (state.shuttingDown) return;

  state.peerError = '';
  state.peerReady = false;
  updatePeerUi();

  if (typeof window.Peer !== 'function') {
    state.peerError = 'O componente de conexão não carregou. Recarregue a página.';
    showHostError(state.peerError);
    updatePeerUi();
    return;
  }

  let peer;
  try {
    peer = new window.Peer(state.room, peerOptions());
  } catch {
    state.peerError = 'Não foi possível iniciar a sinalização. Tentando de novo…';
    updatePeerUi();
    setTimeout(initPeer, 5000);
    return;
  }

  state.peer = peer;
  let retryTimer = null;

  peer.on('open', () => {
    if (state.peer !== peer) return;
    peerIdRetries = 0;
    state.peerReady = true;
    state.peerError = '';
    showHostError('');
    updatePeerUi();
    updateModePill();
  });

  peer.on('connection', (conn) => {
    if (state.peer !== peer) return;
    handleIncoming(conn);
  });

  peer.on('call', (call) => {
    // O host só faz chamadas; se alguém tentar chamar o host, recusa.
    try {
      call.close();
    } catch {
      /* ignora */
    }
  });

  peer.on('error', (error) => {
    if (state.peer !== peer) return;
    handlePeerError(error);
  });

  peer.on('disconnected', () => {
    if (state.peer !== peer || state.shuttingDown) return;
    state.peerReady = false;
    updatePeerUi();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (state.peer !== peer || state.shuttingDown) return;
      try {
        peer.reconnect();
      } catch {
        destroyPeer();
        initPeer();
      }
    }, 1800);
  });

  peer.on('close', () => {
    if (state.peer !== peer) return;
    state.peerReady = false;
    updatePeerUi();
  });
}

function handlePeerError(error) {
  const type = error?.type || '';
  state.peerReady = false;

  if (type === 'unavailable-id') {
    if (peerIdRetries >= 5) {
      state.peerError =
        'Já existe outra transmissão aberta com este link. Feche a outra aba e recarregue esta página.';
      showHostError(state.peerError);
      updatePeerUi();
      return;
    }
    peerIdRetries += 1;
    state.peerError = 'Reconectando a transmissão…';
    showHostError('');
    updatePeerUi();
    destroyPeer();
    setTimeout(() => {
      if (!state.shuttingDown) initPeer();
    }, 1500 + peerIdRetries * 1200);
    return;
  }

  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'ssl-unavailable') {
    state.peerError = 'Sem conexão com o serviço de conexão. Tentando de novo…';
    showHostError(state.peerError);
    updatePeerUi();
    destroyPeer();
    setTimeout(initPeer, 5000);
    return;
  }

  if (type === 'browser-incompatible') {
    state.peerError = 'Este navegador não consegue fazer a conexão direta. Use Chrome ou Edge atualizado.';
    showHostError(state.peerError);
    updatePeerUi();
  }
}

function handleIncoming(conn) {
  const viewer = {
    conn,
    clientId: '',
    device: null,
    authenticated: false,
    joinedAt: Date.now(),
    lastSeen: Date.now(),
    authFails: 0,
    authTimer: null,
  };

  viewer.authTimer = setTimeout(() => {
    if (!viewer.authenticated) dropViewer(viewer);
  }, 15_000);

  conn.on('data', (data) => handleViewerData(viewer, data));
  conn.on('close', () => dropViewer(viewer));
  conn.on('error', () => dropViewer(viewer));
}

function handleViewerData(viewer, raw) {
  let message;
  try {
    message = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return;
  }
  if (!message || typeof message.type !== 'string') return;

  viewer.lastSeen = Date.now();

  if (!viewer.authenticated) {
    if (message.type !== 'hello') return;

    if (normalizePin(message.pin) !== state.pin) {
      viewer.authFails += 1;
      setTimeout(() => {
        sendTo(viewer, { type: 'auth-error', reason: 'pin' });
        if (viewer.authFails >= 5) dropViewer(viewer);
      }, 650);
      return;
    }

    viewer.authenticated = true;
    viewer.clientId = sanitizeClientId(message.clientId) || viewer.conn.peer;
    viewer.device = sanitizeDevice(message.device);
    clearTimeout(viewer.authTimer);
    state.viewers.set(viewer.conn.peer, viewer);

    sendTo(viewer, {
      type: 'auth-ok',
      presence: state.presence,
      sources: state.sourceActive,
      viewers: countViewers(),
      quality: state.quality,
    });
    // Pede a identificação também a versões antigas do painel.
    sendTo(viewer, { type: 'identify' });

    updateViewers();
    setTimeout(() => sendStreamsTo(viewer), 120);
    return;
  }

  if (message.type === 'device') {
    const device = sanitizeDevice(message.device);
    if (device) {
      viewer.device = device;
      renderViewers();
      updateStats();
    }
    return;
  }

  if (message.type === 'ping') {
    sendTo(viewer, { type: 'pong', at: Date.now() });
    return;
  }

  if (message.type === 'resync') {
    sendStreamsTo(viewer, { force: true });
    return;
  }

  if (message.type === 'bye') {
    dropViewer(viewer);
  }
}

function dropViewer(viewer) {
  clearTimeout(viewer.authTimer);
  if (state.viewers.get(viewer.conn.peer) === viewer) {
    state.viewers.delete(viewer.conn.peer);
  }
  for (const kind of ['cam', 'screen']) {
    const call = state.calls[kind].get(viewer.conn.peer);
    state.calls[kind].delete(viewer.conn.peer);
    if (call) {
      try {
        call.close();
      } catch {
        /* ignora */
      }
    }
  }
  try {
    viewer.conn.close();
  } catch {
    /* ignora */
  }
  updateViewers();
}

function disconnectAllViewers() {
  for (const viewer of [...state.viewers.values()]) {
    try {
      viewer.conn.close();
    } catch {
      /* ignora */
    }
  }
  state.viewers.clear();
  for (const kind of ['cam', 'screen']) {
    for (const call of state.calls[kind].values()) {
      try {
        call.close();
      } catch {
        /* ignora */
      }
    }
    state.calls[kind].clear();
  }
  updateViewers();
}

function countViewers() {
  const unique = new Set();
  for (const viewer of state.viewers.values()) {
    unique.add(viewer.clientId || viewer.conn.peer);
  }
  return unique.size;
}

function updateViewers() {
  const previous = state.viewersCount;
  state.viewersCount = countViewers();
  if (state.viewersCount !== previous) applyAllSenderParams();
  updateStats();
  updatePeerUi();
  renderViewers();
  broadcast({ type: 'viewers', count: state.viewersCount });
}

function renderViewers() {
  const card = el['viewers-card'];
  const list = el['viewers-list'];
  if (!card || !list) return;

  const unique = new Map();
  for (const viewer of state.viewers.values()) {
    const key = viewer.clientId || viewer.conn.peer;
    const previous = unique.get(key);
    if (!previous || viewer.joinedAt >= previous.joinedAt) unique.set(key, viewer);
  }

  const viewers = [...unique.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  card.hidden = viewers.length === 0;
  if (el['viewers-card-count']) el['viewers-card-count'].textContent = String(viewers.length);

  list.replaceChildren(
    ...viewers.map((viewer) => {
      const item = document.createElement('li');
      const icon = document.createElement('span');
      icon.className = 'viewer-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = viewer.device?.icon || '💻';

      const body = document.createElement('div');
      body.className = 'viewer-body';

      const name = document.createElement('strong');
      name.textContent = viewer.device?.label || 'Identificando dispositivo…';

      const meta = document.createElement('span');
      meta.className = 'viewer-meta';
      const details = [];
      if (viewer.device?.screen) details.push(viewer.device.screen);
      details.push(`entrou ${timeAgo(viewer.joinedAt) || 'agora'}`);
      meta.textContent = details.join(' · ');

      body.append(name, meta);
      item.append(icon, body);
      return item;
    }),
  );
}

function sendTo(viewer, payload) {
  if (!viewer?.conn?.open) return;
  try {
    viewer.conn.send(payload);
  } catch {
    /* a conexão será limpa pelo close */
  }
}

function broadcast(payload) {
  for (const viewer of state.viewers.values()) sendTo(viewer, payload);
}

function sendStreamsTo(viewer, { force = false, kinds = ['cam', 'screen'] } = {}) {
  if (!state.peerReady || !state.peer || viewer?.conn?.open !== true) return;

  for (const kind of kinds) {
    if (!state.sourceActive[kind] || !state.streams[kind]) continue;

    const existing = state.calls[kind].get(viewer.conn.peer);
    if (existing && !force) continue;
    if (existing) {
      state.calls[kind].delete(viewer.conn.peer);
      try {
        existing.close();
      } catch {
        /* ignora */
      }
    }

    sendTo(viewer, { type: 'source', kind, active: true });

    let call;
    try {
      call = state.peer.call(viewer.conn.peer, state.streams[kind], {
        metadata: { kind },
      });
    } catch {
      continue;
    }

    state.calls[kind].set(viewer.conn.peer, call);

    call.on('open', () => {
      applySenderParams(call, kind);
    });

    call.on('close', () => {
      if (state.calls[kind].get(viewer.conn.peer) === call) {
        state.calls[kind].delete(viewer.conn.peer);
      }
    });

    call.on('error', () => {
      state.fails += 1;
      if (state.calls[kind].get(viewer.conn.peer) === call) {
        state.calls[kind].delete(viewer.conn.peer);
      }
      updateStats();
    });
  }
}

function checkViewerHeartbeats() {
  const now = Date.now();
  for (const viewer of [...state.viewers.values()]) {
    if (now - viewer.lastSeen > 32_000) dropViewer(viewer);
  }
}

function sanitizeClientId(value) {
  const text = String(value ?? '').trim();
  return /^[a-z0-9-]{8,64}$/i.test(text) ? text : '';
}

function sanitizeDevice(value) {
  if (!value || typeof value !== 'object') return null;
  const text = (input, max = 60) =>
    String(input ?? '')
      .replace(/[\u0000-\u001f<>]/g, '')
      .trim()
      .slice(0, max);

  const label = text(value.label, 70);
  if (!label) return null;

  return {
    label,
    kind: text(value.kind, 20),
    os: text(value.os, 40),
    browser: text(value.browser, 40),
    screen: text(value.screen, 20),
    icon: ['💻', '📱', '🖥️', '📟'].includes(value.icon) ? value.icon : '💻',
  };
}

function latestViewer() {
  let latest = null;
  for (const viewer of state.viewers.values()) {
    if (!latest || viewer.joinedAt > latest.joinedAt) latest = viewer;
  }
  return latest;
}

function latestDeviceLabel() {
  return sanitizeDevice(latestViewer()?.device)?.label || '';
}

/* ---------------- Câmera ---------------- */

async function startCam(deviceId) {
  if (state.starting.cam) return;

  if (!navigator.mediaDevices?.getUserMedia && !fakeCam) {
    state.errors.cam = 'Este navegador não oferece acesso à câmera. Use Chrome ou Edge.';
    el['browser-warning'].hidden = false;
    el['cam-hint'].textContent = state.errors.cam;
    el['cam-toggle'].checked = false;
    updateSourceUi('cam');
    return;
  }

  state.starting.cam = true;
  state.errors.cam = '';
  el['cam-hint'].textContent = 'Aguardando a permissão da câmera…';
  updateSourceUi('cam');

  const preset = qualityFor('cam');
  const constraints = {
    audio: false,
    video: {
      width: { ideal: preset.maxW },
      height: { ideal: preset.maxH },
      frameRate: { ideal: preset.fps, max: preset.fps },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  };

  try {
    const stream = fakeCam
      ? createFakeCamStream()
      : await navigator.mediaDevices.getUserMedia(constraints);
    attachSource('cam', stream);
    el['cam-hint'].textContent = 'Webcam no ar. A imagem está sendo enviada direto para quem assiste.';
    await refreshDevices();
    ensurePresenceDefault('trabalhando');
    requestWakeLock();
  } catch (error) {
    state.errors.cam = cameraErrorMessage(error);
    el['cam-hint'].textContent = state.errors.cam;
    toast(state.errors.cam);
  } finally {
    state.starting.cam = false;
    updateSourceUi('cam');
  }
}

function cameraErrorMessage(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Permissão da câmera negada. Libere a câmera no ícone ao lado do endereço e tente de novo.';
    case 'NotFoundError':
      return 'Nenhuma câmera foi encontrada neste PC.';
    case 'NotReadableError':
      return 'A câmera está em uso por outro programa. Feche-o e tente novamente.';
    case 'OverconstrainedError':
      return 'A câmera escolhida não está disponível. Tente outra.';
    default:
      return 'Não foi possível abrir a câmera. Tente novamente.';
  }
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === 'videoinput');
    if (!cameras.length) return;

    const currentId =
      state.streams.cam?.getVideoTracks()[0]?.getSettings()?.deviceId || el['cam-device'].value;

    el['cam-device'].replaceChildren(
      ...cameras.map((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Câmera ${index + 1}`;
        return option;
      }),
    );

    if (cameras.some((device) => device.deviceId === currentId)) {
      el['cam-device'].value = currentId;
    }

    el['cam-device-row'].hidden = !state.sourceActive.cam;
  } catch {
    /* lista de dispositivos é um extra */
  }
}

/* ---------------- Compartilhamento da tela ---------------- */

async function startScreen() {
  if (state.starting.screen) return;

  if (!navigator.mediaDevices?.getDisplayMedia) {
    el['screen-hint'].textContent =
      'Este navegador não permite compartilhar tela. Use Chrome ou Edge no computador.';
    toast('Compartilhar tela exige Chrome ou Edge no computador.');
    return;
  }

  state.starting.screen = true;
  state.errors.screen = '';
  updateSourceUi('screen');

  const preset = qualityFor('screen');

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'window',
        frameRate: { ideal: preset.fps, max: preset.fps },
        width: { max: preset.maxW },
        height: { max: preset.maxH },
      },
      audio: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'exclude',
    });

    attachSource('screen', stream);

    const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
    const surface = settings.displaySurface || '';
    const label = stream.getVideoTracks()[0]?.label
      ? String(stream.getVideoTracks()[0].label).slice(0, 80)
      : '';

    if (surface === 'monitor') {
      el['screen-hint'].classList.add('warn');
      el['screen-hint'].textContent =
        'Você compartilhou a tela inteira. Tudo o que aparecer nela será visto. Para mostrar só o AnyDesk, pare e escolha a janela dele.';
      toast('Dica: compartilhe só a janela do AnyDesk.');
    } else {
      el['screen-hint'].classList.remove('warn');
      el['screen-hint'].textContent = label
        ? `Compartilhando: ${label}. Deixe a janela aberta e sem minimizar.`
        : 'Tela compartilhada. Deixe a janela do AnyDesk aberta e sem minimizar.';
    }

    ensurePresenceDefault('trabalhando');
    requestWakeLock();
  } catch (error) {
    const message =
      error?.name === 'NotAllowedError'
        ? 'Compartilhamento cancelado.'
        : 'Não foi possível compartilhar a tela. Tente novamente.';
    state.errors.screen = message;
    toast(message);
  } finally {
    state.starting.screen = false;
    updateSourceUi('screen');
  }
}

/* ---------------- Fontes ---------------- */

function attachSource(kind, stream) {
  const previousStream = state.streams[kind];
  if (previousStream) {
    closeCallsFor(kind);
    for (const track of previousStream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* ignora */
      }
    }
  }

  state.streams[kind] = stream;
  state.sourceActive[kind] = true;

  const video = kind === 'cam' ? el['cam-video'] : el['screen-video'];
  const viewport = kind === 'cam' ? el['cam-viewport'] : el['screen-viewport'];

  video.srcObject = stream;
  video.play().catch(() => {});
  viewport.classList.add('is-active');

  const track = stream.getVideoTracks()[0];
  if (track) {
    const preset = qualityFor(kind);
    // "detail" mantém o texto legível; "motion" prioriza fluidez na webcam.
    track.contentHint = kind === 'screen' ? 'detail' : 'motion';
    track
      .applyConstraints({ frameRate: { ideal: preset.fps, max: preset.fps } })
      .catch(() => {});
    track.addEventListener('ended', () => stopSource(kind));
  }

  updateSourceUi(kind);
  updateModePill();
  broadcast({ type: 'source', kind, active: true });
  for (const viewer of state.viewers.values()) {
    sendStreamsTo(viewer, { kinds: [kind] });
  }
  updateStats();
}

function stopSource(kind, { silent = false } = {}) {
  const stream = state.streams[kind];

  closeCallsFor(kind);
  state.streams[kind] = null;
  state.sourceActive[kind] = false;

  if (stream) {
    if (stream._fakeTimer) clearInterval(stream._fakeTimer);
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* ignora */
      }
    }
  }

  const video = kind === 'cam' ? el['cam-video'] : el['screen-video'];
  const viewport = kind === 'cam' ? el['cam-viewport'] : el['screen-viewport'];
  try {
    video.pause();
  } catch {
    /* ignora */
  }
  video.srcObject = null;
  viewport.classList.remove('is-active');

  if (kind === 'screen') {
    el['screen-hint'].innerHTML = screenHintDefault;
    el['screen-hint'].classList.remove('warn');
    state.errors.screen = '';
  } else {
    el['cam-hint'].textContent = 'A transmissão é só de vídeo — o microfone não é enviado.';
    state.errors.cam = '';
  }

  updateSourceUi(kind);
  updateModePill();
  updateBackgroundNotice();
  broadcast({ type: 'source', kind, active: false });
  if (!anyActive()) releaseWakeLock();
  if (!silent && kind === 'screen') toast('Compartilhamento encerrado.');
  updateStats();
}

function closeCallsFor(kind, viewerId = null) {
  for (const [peerId, call] of [...state.calls[kind].entries()]) {
    if (viewerId && peerId !== viewerId) continue;
    state.calls[kind].delete(peerId);
    try {
      call.close();
    } catch {
      /* ignora */
    }
  }
}

async function applyQuality() {
  for (const kind of ['cam', 'screen']) {
    const track = state.streams[kind]?.getVideoTracks()[0];
    if (!track) continue;
    const preset = qualityFor(kind);
    try {
      await track.applyConstraints({
        width: { ideal: preset.maxW },
        height: { ideal: preset.maxH },
        frameRate: { ideal: preset.fps, max: preset.fps },
      });
    } catch {
      /* alguns navegadores não permitem reduzir a tela */
    }
  }

  for (const kind of ['cam', 'screen']) {
    for (const call of state.calls[kind].values()) {
      const tuning = tuningFor(call, kind);
      tuning.factor = 1;
      tuning.fpsFactor = 1;
      tuning.bad = 0;
      tuning.cpu = 0;
      tuning.good = 0;
    }
  }
  applyAllSenderParams();
}

function applyAllSenderParams() {
  for (const kind of ['cam', 'screen']) {
    for (const call of state.calls[kind].values()) applySenderParams(call, kind);
  }
}

async function applySenderParams(call, kind) {
  const pc = call?.peerConnection;
  if (!pc) return;

  const tuning = tuningFor(call, kind);
  if (tuning.applying) return;

  const preset = qualityFor(kind);
  const target = Math.max(
    120_000,
    Math.round(preset.maxBitrate * viewerShareFactor() * tuning.factor),
  );
  const fpsTarget = Math.max(12, Math.round(preset.fps * tuning.fpsFactor));

  tuning.applying = true;
  try {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      if ('degradationPreference' in params) {
        params.degradationPreference =
          kind === 'screen' ? 'balanced' : 'maintain-framerate';
      }
      for (const encoding of params.encodings) {
        encoding.maxBitrate = target;
        encoding.maxFramerate = fpsTarget;
        if ('priority' in encoding) encoding.priority = kind === 'screen' ? 'high' : 'medium';
        if ('networkPriority' in encoding) {
          encoding.networkPriority = kind === 'screen' ? 'high' : 'low';
        }
      }
      try {
        await sender.setParameters(params);
      } catch {
        // Navegadores mais antigos recusam prioridades; aplica só o essencial.
        const fallback = sender.getParameters();
        if (!fallback.encodings?.length) fallback.encodings = [{}];
        for (const encoding of fallback.encodings) {
          encoding.maxBitrate = target;
          encoding.maxFramerate = fpsTarget;
        }
        await sender.setParameters(fallback).catch(() => {});
      }
    }
  } finally {
    tuning.applying = false;
  }
}

async function adaptStreamQuality() {
  if (!state.viewersCount) return;

  const entries = [];
  for (const kind of ['cam', 'screen']) {
    for (const call of state.calls[kind].values()) entries.push([kind, call]);
  }

  await Promise.all(
    entries.map(async ([kind, call]) => {
      const pc = call?.peerConnection;
      if (!pc) return;

      let reason = '';
      try {
        const report = await pc.getStats();
        report.forEach((entry) => {
          if (entry.type === 'outbound-rtp' && entry.kind === 'video') {
            reason = entry.qualityLimitationReason || '';
          }
        });
      } catch {
        return;
      }

      const tuning = tuningFor(call, kind);
      if (reason === 'bandwidth') {
        tuning.bad += 1;
        tuning.cpu = 0;
        tuning.good = 0;
      } else if (reason === 'cpu') {
        tuning.cpu += 1;
        tuning.bad = 0;
        tuning.good = 0;
      } else {
        tuning.good += 1;
        tuning.bad = 0;
        tuning.cpu = 0;
      }

      if (tuning.bad >= 2 && tuning.factor > 0.55) {
        tuning.factor = Math.max(0.55, tuning.factor - 0.15);
        tuning.bad = 0;
        tuning.good = 0;
        applySenderParams(call, kind);
      } else if (tuning.cpu >= 2 && tuning.fpsFactor > 0.5) {
        tuning.fpsFactor = Math.max(0.5, tuning.fpsFactor - 0.2);
        tuning.cpu = 0;
        tuning.good = 0;
        applySenderParams(call, kind);
      } else if (tuning.good >= 6 && (tuning.factor < 1 || tuning.fpsFactor < 1)) {
        tuning.factor = Math.min(1, tuning.factor + 0.08);
        tuning.fpsFactor = Math.min(1, tuning.fpsFactor + 0.1);
        tuning.good = 0;
        applySenderParams(call, kind);
      }
    }),
  );
}

function anyActive() {
  return Boolean(state.sourceActive.cam || state.sourceActive.screen);
}

/* ---------------- Estatísticas ---------------- */

async function sampleStats() {
  if (state.statsBusy) return;
  state.statsBusy = true;

  let bytes = 0;
  let frames = 0;
  let reportedFps = 0;
  let callCount = 0;

  const calls = [...state.calls.cam.values(), ...state.calls.screen.values()];
  await Promise.all(
    calls.map(async (call) => {
      if (!call?.peerConnection) return;
      callCount += 1;
      try {
        const report = await call.peerConnection.getStats();
        report.forEach((entry) => {
          if (entry.type !== 'outbound-rtp' || entry.kind !== 'video') return;
          bytes += Number(entry.bytesSent) || 0;
          frames += Number(entry.framesEncoded) || 0;
          if (entry.framesPerSecond) reportedFps = Math.max(reportedFps, entry.framesPerSecond);
        });
      } catch {
        /* a chamada pode ter encerrado */
      }
    }),
  );

  const now = performance.now();
  const elapsed = Math.max(0.2, (now - state.statsPrev.at) / 1000);
  const delta = Math.max(0, frames - state.statsPrev.frames);
  const computedFps = callCount > 0 ? delta / elapsed / callCount : 0;

  state.sentBytes = bytes;
  state.sentFrames = frames;
  state.fps = reportedFps || computedFps;
  state.statsPrev = { at: now, frames };

  state.statsBusy = false;
  updateStats();
}

function bossViewerText(count, deviceLabel = '') {
  const total = Math.max(1, Number(count) || 1);
  const label = String(deviceLabel || '').trim();
  if (total === 1) {
    return label
      ? `${label} começou a assistir à sua transmissão agora.`
      : '1 pessoa começou a assistir à sua transmissão agora.';
  }
  const base = `${new Intl.NumberFormat('pt-BR').format(total)} pessoas estão assistindo à sua transmissão agora.`;
  return label ? `${base} Dispositivo mais recente: ${label}.` : base;
}

function updateBossDevice() {
  const element = el['boss-warning-device'];
  if (!element) return;

  const label = latestDeviceLabel();
  if (!label) {
    element.textContent = '';
    element.hidden = true;
    return;
  }

  const extra =
    state.viewersCount > 1
      ? ` +${new Intl.NumberFormat('pt-BR').format(state.viewersCount - 1)}`
      : '';
  element.textContent = `${label}${extra}`;
  element.hidden = false;
}

function primeBossAudio() {
  if (bossAudioPrimed) return;
  bossAudioPrimed = true;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.00001;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.03);
      setTimeout(() => {
        try {
          ctx.close();
        } catch {
          /* ignora */
        }
      }, 200);
    }
  } catch {
    /* áudio indisponível */
  }
  try {
    bossAlertAudio.load();
  } catch {
    /* ignora */
  }
}

function speakBossAlert() {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance('Atenção, novo espectador');
    utter.lang = 'pt-BR';
    utter.rate = 1;
    utter.pitch = 1;
    utter.volume = 1;
    speechSynthesis.speak(utter);
  } catch {
    /* ignora */
  }
}

function playBossAlert() {
  try {
    bossAlertAudio.currentTime = 0;
    const played = bossAlertAudio.play();
    if (played && typeof played.catch === 'function') {
      played.catch(() => speakBossAlert());
    }
  } catch {
    speakBossAlert();
  }
}

function showBossPopup(count) {
  if (!el['boss-popup']) return;
  el['boss-popup-text'].textContent = bossViewerText(count, latestDeviceLabel());
  el['boss-popup'].hidden = false;
  document.body.classList.add('boss-popup-open');
  el['boss-popup-close']?.focus({ preventScroll: true });
  primeBossAudio();
  playBossAlert();
  clearTimeout(bossPopupTimer);
  bossPopupTimer = setTimeout(hideBossPopup, 12000);
}

function hideBossPopup() {
  clearTimeout(bossPopupTimer);
  bossPopupTimer = null;
  if (!el['boss-popup']) return;
  el['boss-popup'].hidden = true;
  document.body.classList.remove('boss-popup-open');
  try {
    bossAlertAudio.pause();
    bossAlertAudio.currentTime = 0;
  } catch {
    /* ignora */
  }
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignora */
  }
}

function updateStats() {
  el['stat-viewers'].textContent = String(state.viewersCount);
  el['stat-fps'].textContent = anyActive() && state.viewersCount ? state.fps.toFixed(1).replace('.', ',') : '0';
  el['stat-sent'].textContent = anyActive() && state.viewersCount ? formatBytes(state.sentBytes) : '0 B';
  el['stat-fails'].textContent = new Intl.NumberFormat('pt-BR').format(state.fails);

  const watching = state.viewersCount > 0;
  el['boss-warning'].hidden = !watching;
  updateBossDevice();
  if (watching) {
    el['boss-warning-count'].textContent =
      state.viewersCount === 1
        ? '1 pessoa assistindo agora'
        : `${new Intl.NumberFormat('pt-BR').format(state.viewersCount)} pessoas assistindo agora`;
    if (!bossPopupShown) {
      bossPopupShown = true;
      showBossPopup(state.viewersCount);
    } else if (el['boss-popup'] && !el['boss-popup'].hidden) {
      el['boss-popup-text'].textContent = bossViewerText(state.viewersCount, latestDeviceLabel());
    }
  } else if (bossPopupShown) {
    bossPopupShown = false;
    hideBossPopup();
  }

  updatePeerUi();
}

/* ---------------- Interface ---------------- */

function updatePeerUi() {
  if (state.peerReady) {
    el['host-conn-hint'].textContent = `Conexão pronta · ${state.viewersCount} assistindo agora.`;
  } else if (state.peerError) {
    el['host-conn-hint'].textContent = state.peerError;
  } else {
    el['host-conn-hint'].textContent = 'Conectando ao serviço de conexão…';
  }

  updateModePill();
}

function updateModePill() {
  const active = anyActive();
  el['host-mode-pill'].classList.toggle('online', active && state.peerReady);
  el['host-mode-pill'].classList.toggle('offline', active && !state.peerReady);

  if (!state.peerReady) {
    el['host-mode-text'].textContent = 'Reconectando';
  } else if (active) {
    el['host-mode-text'].textContent = 'No ar';
  } else {
    el['host-mode-text'].textContent = 'Pronto';
  }
}

function updateSourceUi(kind) {
  const active = Boolean(state.sourceActive[kind]);
  const starting = state.starting[kind];
  const error = state.errors[kind];
  const badge = kind === 'cam' ? el['cam-badge'] : el['screen-badge'];

  badge.classList.remove('is-live', 'is-stale', 'is-error');
  if (active) {
    badge.textContent = 'Ao vivo';
    badge.classList.add('is-live');
  } else if (starting) {
    badge.textContent = 'Conectando';
    badge.classList.add('is-stale');
  } else if (error) {
    badge.textContent = 'Erro';
    badge.classList.add('is-error');
  } else {
    badge.textContent = 'Desligada';
  }

  if (kind === 'cam') {
    el['cam-toggle'].checked = active;
    el['cam-toggle'].disabled = starting;
    el['cam-toggle-label'].textContent = active
      ? 'Webcam ligada'
      : starting
        ? 'Autorizando câmera…'
        : error
          ? 'Erro na câmera'
          : 'Webcam desligada';
    el['cam-device-row'].hidden = !active;
  } else {
    el['screen-start'].hidden = active;
    el['screen-start'].disabled = starting;
    el['screen-stop'].hidden = !active;
  }

  updateModePill();
  updateBackgroundNotice();
}

function updateBackgroundNotice() {
  el['background-notice'].hidden = !(document.hidden && anyActive());
}

function showHostError(message) {
  el['host-error-text'].textContent = message || '';
  el['host-error'].hidden = !message;
}

/* ---------------- Presença ---------------- */

function savePresenceState(nextState) {
  if (!PRESENCE_LABEL[nextState]) nextState = 'trabalhando';
  const note = el['presence-note'].value.trim().slice(0, 140);

  state.presence = { state: nextState, note, updatedAt: Date.now() };
  persistPresence(state.presence);
  renderPresence();
  broadcast({ type: 'presence', presence: state.presence });
  updateStats();
}

function ensurePresenceDefault(fallback) {
  if (state.presence.state !== 'indefinido') return;
  savePresenceState(fallback);
}

function renderPresence() {
  const current = PRESENCE_LABEL[state.presence.state] ? state.presence.state : 'indefinido';
  const badge = el['presence-badge'];

  badge.textContent = PRESENCE_LABEL[current];
  badge.classList.remove('is-live', 'is-stale', 'is-error');
  if (current === 'trabalhando') badge.classList.add('is-live');
  else if (current === 'pausa' || current === 'almocando' || current === 'banheiro') {
    badge.classList.add('is-stale');
  } else if (current === 'ausente') badge.classList.add('is-error');

  for (const button of presenceButtons) {
    button.classList.toggle('is-active', button.dataset.presence === current);
  }

  if (document.activeElement !== el['presence-note']) {
    el['presence-note'].value = state.presence.note || '';
  }

  renderPresenceAge();
}

function renderPresenceAge() {
  if (!state.presence.updatedAt) {
    el['presence-badge'].title = '';
    return;
  }
  el['presence-badge'].title = `Atualizado ${timeAgo(state.presence.updatedAt)}`;
}

/* ---------------- Convite ---------------- */

function copyLink() {
  copyText(el['share-link'].value, 'Link copiado! Envie também o PIN por um canal privado.');
}

function copyInvite() {
  const link = el['share-link'].value;
  const text = `Painel: ${link}\nPIN: ${state.pin}`;
  copyText(text, 'Link e PIN copiados!');
}

/* ---------------- Tela acordada ---------------- */

async function requestWakeLock() {
  if (!navigator.wakeLock || document.visibilityState !== 'visible' || !anyActive()) return;
  if (state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => {
      state.wakeLock = null;
    });
  } catch {
    state.wakeLock = null;
  }
}

function releaseWakeLock() {
  if (!state.wakeLock) return;
  state.wakeLock.release().catch(() => {});
  state.wakeLock = null;
}

/* ---------------- Desligamento ---------------- */

function destroyPeer() {
  const peer = state.peer;
  state.peer = null;
  state.peerReady = false;
  if (!peer) return;
  try {
    peer.destroy();
  } catch {
    /* ignora */
  }
}

function shutdown() {
  for (const kind of ['cam', 'screen']) {
    const stream = state.streams[kind];
    if (stream?._fakeTimer) clearInterval(stream._fakeTimer);
    for (const track of stream?.getTracks?.() || []) {
      try {
        track.stop();
      } catch {
        /* ignora */
      }
    }
  }
  disconnectAllViewers();
  destroyPeer();
  releaseWakeLock();
}

/* ---------------- Câmera de teste (apenas ?fakecam=1) ---------------- */

function createFakeCamStream() {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext('2d');
  let frame = 0;

  const draw = () => {
    const hue = (frame * 2) % 360;
    context.fillStyle = `hsl(${hue} 55% 18%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.fillStyle = 'rgba(255,255,255,0.08)';
    for (let x = 0; x < canvas.width; x += 80) {
      context.fillRect(x + ((frame * 4) % 80), 0, 2, canvas.height);
    }

    context.fillStyle = '#a3e635';
    context.beginPath();
    context.arc(180 + Math.sin(frame / 20) * 90, 300, 70, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = '#ffffff';
    context.font = 'bold 54px system-ui, sans-serif';
    context.fillText('WEBCAM DE TESTE', 320, 260);
    context.font = '34px system-ui, sans-serif';
    context.fillText(new Date().toLocaleTimeString('pt-BR'), 320, 330);
    context.fillText(`quadro ${frame}`, 320, 385);
    frame += 1;
  };

  draw();
  const stream = canvas.captureStream(24);
  stream._fakeTimer = setInterval(draw, 1000 / 24);
  return stream;
}

/* Mantém referências úteis para depuração no console. */
window.leoHostDebug = { state, QUALITY, updateStats };
