import {
  bindLogout,
  copyText,
  initAuthGate,
  registerServiceWorker,
  timeAgo,
  toast,
} from './shared.js';

const QUALITY = {
  leve: { maxW: 640, maxH: 360, fps: 8, quality: 0.55 },
  padrao: { maxW: 1280, maxH: 720, fps: 15, quality: 0.68 },
  nitido: { maxW: 1920, maxH: 1080, fps: 24, quality: 0.76 },
  maxima: { maxW: 1920, maxH: 1080, fps: 30, quality: 0.85 },
};

const HOST_ID = (() => {
  try {
    const key = 'leo-host-id';
    let value = sessionStorage.getItem(key);
    if (!value) {
      value = crypto.randomUUID ? crypto.randomUUID() : `h-${Date.now()}-${Math.random()}`;
      sessionStorage.setItem(key, value);
    }
    return value;
  } catch {
    return `h-${Date.now()}-${Math.random()}`;
  }
})();

const PRESENCE_LABEL = {
  trabalhando: 'Trabalhando',
  pausa: 'Em pausa',
  almocando: 'Almoçando',
  banheiro: 'No banheiro',
  ausente: 'Ausente',
  indefinido: 'Sem status',
};

const sessions = { cam: null, screen: null };
const state = {
  quality: QUALITY[localStorage.getItem('leo-quality')] ? localStorage.getItem('leo-quality') : 'nitido',
  presence: { state: 'indefinido', note: '', updatedAt: 0 },
  viewers: 0,
  sent: 0,
  fails: 0,
  connected: false,
  starting: { cam: false, screen: false },
  errors: { cam: '', screen: '' },
  savingPresence: false,
  redirecting: false,
  started: false,
  wakeLock: null,
};

const el = {};
for (const id of [
  'quality',
  'stat-viewers',
  'stat-fps',
  'stat-sent',
  'stat-fails',
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
  'host-conn-hint',
  'host-mode-pill',
  'host-mode-text',
  'secure-warning',
  'browser-warning',
  'background-notice',
]) {
  el[id] = document.getElementById(id);
}

const presenceButtons = [...document.querySelectorAll('[data-presence]')];
const screenHintDefault = el['screen-hint']?.innerHTML || '';
let lastPresenceRender = '';
let fpsSample = { at: performance.now(), sent: 0 };

bindLogout();
registerServiceWorker();

initAuthGate(start);

function start() {
  if (state.started) return;
  state.started = true;

  window.leoHostDebug = { state, sessions, QUALITY };

  el.quality.value = state.quality;
  el['share-link'].value = `${location.origin}/`;
  el['presence-note'].value = state.presence.note || '';

  if (!window.isSecureContext) {
    el['secure-warning'].hidden = false;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    el['browser-warning'].hidden = false;
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    el['screen-start'].disabled = true;
    el['screen-hint'].textContent =
      'Este navegador não permite compartilhar tela. Use Chrome ou Edge no computador para mostrar o AnyDesk.';
  }

  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    const localHint = document.createElement('p');
    localHint.className = 'hint warn';
    localHint.textContent =
      'Este convite aponta para localhost. Para abrir no celular, use o endereço público do app (deploy ou túnel HTTPS).';
    el['share-link'].closest('.host-side')?.appendChild(localHint);
  }

  bindUi();
  fetchInitialStatus();
  pingHost();
  setInterval(pingHost, 4500);
  setInterval(updateStats, 1000);
  setInterval(renderPresenceAge, 30_000);

  document.addEventListener('visibilitychange', () => {
    updateBackgroundNotice();
    if (document.visibilityState === 'visible' && anyActive()) requestWakeLock();
  });

  window.addEventListener('beforeunload', (event) => {
    if (anyActive()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  window.addEventListener('pagehide', () => stopAll({ redirect: false }));
  updateSourceUi('cam');
  updateSourceUi('screen');
  updateModePill();
}

function bindUi() {
  el['cam-toggle'].addEventListener('change', () => {
    if (el['cam-toggle'].checked) startCam();
    else stopSession('cam');
  });
  el['screen-start'].addEventListener('click', () => startScreen());
  el['screen-stop'].addEventListener('click', () => stopSession('screen'));

  el.quality.addEventListener('change', () => {
    const value = el.quality.value;
    if (!QUALITY[value]) return;
    state.quality = value;
    localStorage.setItem('leo-quality', value);
    for (const kind of ['cam', 'screen']) {
      const session = sessions[kind];
      if (!session?.active) continue;
      if (session.mode === 'worker' && session.worker) {
        session.worker.postMessage({ type: 'config', id: kind, config: workerConfig(kind) });
      } else {
        startLoop(session);
      }
    }
    toast('Qualidade atualizada.');
  });

  el.popout?.addEventListener('click', () => {
    const win = window.open(
      '/host?janela=1',
      'leo-transmissao',
      'popup=yes,width=780,height=960',
    );
    if (!win) toast('O navegador bloqueou a janela. Libere pop-ups para este site.');
  });

  el['cam-device'].addEventListener('change', async () => {
    const deviceId = el['cam-device'].value;
    if (!deviceId) return;
    stopSession('cam', { silent: true });
    await startCam(deviceId);
  });

  for (const button of presenceButtons) {
    button.addEventListener('click', () => savePresence(button.dataset.presence));
  }

  el['presence-save'].addEventListener('click', () => {
    const current = state.presence.state === 'indefinido' ? 'trabalhando' : state.presence.state;
    savePresence(current);
  });

  el['presence-note'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const current = state.presence.state === 'indefinido' ? 'trabalhando' : state.presence.state;
      savePresence(current);
    }
  });

  el['share-copy'].addEventListener('click', () => {
    copyText(el['share-link'].value, 'Link copiado! Envie também o PIN por um canal privado.');
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (sessions.cam?.active) refreshDevices();
    });
  }
}

/* ---------------- Câmera ---------------- */

async function startCam(deviceId) {
  if (state.starting.cam) return;
  if (!navigator.mediaDevices?.getUserMedia) {
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

  const constraints = {
    audio: false,
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 24, max: 30 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.contentHint = 'motion';
      track.addEventListener('ended', () => {
        stopSession('cam');
        toast('A câmera foi desligada.');
      });
    }
    attachSession('cam', stream);
    el['cam-hint'].textContent = 'Webcam no ar. A imagem está sendo enviada ao painel.';
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
      sessions.cam?.stream?.getVideoTracks()[0]?.getSettings()?.deviceId || el['cam-device'].value;

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

    el['cam-device-row'].hidden = !sessions.cam?.active;
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

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'window',
        frameRate: { ideal: 20, max: 30 },
        width: { max: 1920 },
        height: { max: 1080 },
      },
      audio: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'exclude',
    });

    const track = stream.getVideoTracks()[0];
    if (track) {
      track.contentHint = 'text';
      track.addEventListener('ended', () => {
        stopSession('screen');
        toast('Compartilhamento da tela encerrado.');
      });
    }

    attachSession('screen', stream);

    const settings = track?.getSettings?.() || {};
    const surface = settings.displaySurface || '';
    const label = track?.label ? String(track.label).slice(0, 80) : '';

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

/* ---------------- Sessões, preview e envio ---------------- */

function attachSession(kind, stream) {
  stopSession(kind, { silent: true });

  const video = kind === 'cam' ? el['cam-video'] : el['screen-video'];
  const viewport = kind === 'cam' ? el['cam-viewport'] : el['screen-viewport'];

  const session = {
    kind,
    stream,
    video,
    viewport,
    active: true,
    busy: false,
    token: 0,
    timer: null,
    worker: null,
    mode: 'timer',
    sent: 0,
    fails: 0,
    lastOk: 0,
  };

  sessions[kind] = session;
  video.srcObject = stream;
  video.play().catch(() => {});
  viewport.classList.add('is-active');
  updateSourceUi(kind);
  reportSource(kind, true);

  if (!startWorkerCapture(kind, session, stream)) startLoop(session);
  document.body.dataset[kind === 'cam' ? 'captureCam' : 'captureScreen'] = session.mode;
}

/* ---------------- Captura no Web Worker ---------------- */

function workerConfig(kind) {
  const preset = QUALITY[state.quality] || QUALITY.padrao;
  return {
    fps: preset.fps,
    maxW: preset.maxW,
    maxH: preset.maxH,
    quality: preset.quality,
    source: kind,
    host: HOST_ID,
  };
}

function startWorkerCapture(kind, session, stream) {
  if (typeof Worker === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') {
    return false;
  }

  const track = stream.getVideoTracks()[0];
  if (!track) return false;

  let processor;
  let worker;
  let readable;
  try {
    processor = new MediaStreamTrackProcessor({ track });
    readable = processor.readable;
    worker = new Worker('/capture-worker.js');
  } catch {
    try {
      readable?.cancel();
    } catch {
      /* ignora */
    }
    return false;
  }

  session.mode = 'worker';
  session.worker = worker;
  session.processor = processor;

  worker.addEventListener('message', (event) => {
    handleWorkerMessage(kind, session, event.data);
  });

  worker.addEventListener('error', () => {
    if (sessions[kind] !== session) return;
    toast('A captura no worker falhou. Reinicie a transmissão.');
  });

  try {
    worker.postMessage(
      {
        type: 'start',
        id: kind,
        source: kind,
        readable,
        config: workerConfig(kind),
      },
      [readable],
    );
  } catch {
    worker.terminate();
    session.worker = null;
    session.processor = null;
    session.mode = 'timer';
    return false;
  }

  return true;
}

function handleWorkerMessage(kind, session, message) {
  if (!message || sessions[kind] !== session) return;

  if (message.type === 'sent') {
    session.sent += 1;
    session.lastOk = Date.now();
    session.lastFrameMs = Number(message.elapsedMs) || 0;
    session.lastBytes = Number(message.bytes) || 0;
    state.sent += 1;
  } else if (message.type === 'fails') {
    session.fails += 1;
    state.fails += 1;
  } else if (message.type === 'auth') {
    redirectExpired();
  } else if (message.type === 'unsupported') {
    // Navegador sem MediaStreamTrackProcessor: volta para o modo antigo.
    if (session.mode !== 'worker') return;
    session.mode = 'timer';
    session.worker?.terminate();
    session.worker = null;
    startLoop(session);
  } else if (message.type === 'error') {
    state.errors[kind] = 'A captura falhou.';
    toast('A captura falhou. Tente iniciar novamente.');
    stopSession(kind);
  }
}

function stopSession(kind, { silent = false } = {}) {
  const session = sessions[kind];
  if (!session) return;

  session.active = false;
  session.token += 1;
  session.busy = false;
  clearInterval(session.timer);
  session.timer = null;

  if (session.worker) {
    const worker = session.worker;
    session.worker = null;
    try {
      worker.postMessage({ type: 'stop', id: kind });
    } catch {
      /* ignora */
    }
    setTimeout(() => {
      try {
        worker.terminate();
      } catch {
        /* ignora */
      }
    }, 250);
  }
  session.processor = null;

  for (const track of session.stream.getTracks()) {
    track.onended = null;
    track.stop();
  }

  session.video.pause();
  session.video.srcObject = null;
  session.viewport.classList.remove('is-active');
  sessions[kind] = null;

  if (kind === 'screen') {
    el['screen-hint'].innerHTML = screenHintDefault;
    el['screen-hint'].classList.remove('warn');
  }
  if (kind === 'cam') {
    el['cam-hint'].textContent = 'A transmissão é só de vídeo — o microfone não é enviado.';
    state.errors.cam = '';
  }
  if (kind === 'screen') state.errors.screen = '';

  updateSourceUi(kind);
  updateModePill();
  updateBackgroundNotice();
  reportSource(kind, false);

  if (!anyActive()) releaseWakeLock();
  if (!silent && kind === 'screen') toast('Compartilhamento encerrado.');
}

function reportSource(kind, active) {
  try {
    fetch('/api/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: kind, active, host: HOST_ID }),
      keepalive: true,
    }).catch(() => {
      /* o ping do host cobre a reconexão */
    });
  } catch {
    /* sem rede agora */
  }
}

function startLoop(session) {
  stopLoop(session);
  const token = ++session.token;
  const interval = Math.max(30, Math.round(1000 / (QUALITY[state.quality]?.fps || 15)));

  const tick = () => {
    if (!session.active || session.token !== token) return;
    captureFrame(session, token);
  };

  session.timer = setInterval(tick, interval);
  tick();
}

function stopLoop(session) {
  if (session.timer) {
    clearInterval(session.timer);
    session.timer = null;
  }
}

function captureFrame(session, token) {
  if (session.busy) return;
  const video = session.video;
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

  const preset = QUALITY[state.quality] || QUALITY.padrao;
  const dims = fitDimensions(video.videoWidth, video.videoHeight, preset);

  const canvas = session.canvas || document.createElement('canvas');
  const context = session.context || canvas.getContext('2d', { alpha: false });
  if (!context) return;

  session.canvas = canvas;
  session.context = context;

  if (canvas.width !== dims.width) canvas.width = dims.width;
  if (canvas.height !== dims.height) canvas.height = dims.height;

  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch {
    return;
  }

  session.busy = true;
  canvas.toBlob(
    async (blob) => {
      try {
        if (!blob || !session.active || session.token !== token) return;
        await uploadFrame(session, blob, token);
      } finally {
        session.busy = false;
      }
    },
    'image/jpeg',
    preset.quality,
  );
}

async function uploadFrame(session, blob, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`/api/frame?source=${session.kind}&host=${encodeURIComponent(HOST_ID)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
      signal: controller.signal,
    });

    if (response.status === 401) {
      redirectExpired();
      return;
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!session.active || session.token !== token) return;

    session.sent += 1;
    session.lastOk = Date.now();
    state.sent += 1;
  } catch {
    if (session.active && session.token === token) {
      session.fails += 1;
      state.fails += 1;
    }
  } finally {
    clearTimeout(timeout);
  }
}

function fitDimensions(width, height, preset) {
  const scale = Math.min(preset.maxW / width, preset.maxH / height, 1);
  return {
    width: Math.max(2, Math.round(width * scale)),
    height: Math.max(2, Math.round(height * scale)),
  };
}

function stopAll() {
  stopSession('cam', { silent: true });
  stopSession('screen', { silent: true });
  releaseWakeLock();
}

function anyActive() {
  return Boolean(sessions.cam?.active || sessions.screen?.active);
}

/* ---------------- Interface ---------------- */

function updateSourceUi(kind) {
  const active = Boolean(sessions[kind]?.active);
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

function updateModePill() {
  const active = anyActive();
  el['host-mode-pill'].classList.toggle('online', active && state.connected);
  el['host-mode-pill'].classList.toggle('offline', active && !state.connected);

  if (!active) {
    el['host-mode-text'].textContent = 'Modo host';
  } else if (state.connected) {
    el['host-mode-text'].textContent = 'No ar';
  } else {
    el['host-mode-text'].textContent = 'Prévia local';
  }
}

function updateStats() {
  el['stat-viewers'].textContent = String(state.viewers);
  el['stat-sent'].textContent = new Intl.NumberFormat('pt-BR').format(state.sent);
  el['stat-fails'].textContent = new Intl.NumberFormat('pt-BR').format(state.fails);

  const now = performance.now();
  const elapsed = now - fpsSample.at;
  if (elapsed >= 900) {
    const fps = ((state.sent - fpsSample.sent) * 1000) / elapsed;
    fpsSample = { at: now, sent: state.sent };
    if (el['stat-fps']) {
      el['stat-fps'].textContent = anyActive() ? fps.toFixed(1).replace('.', ',') : '0';
    }
  }
}

function updateBackgroundNotice() {
  const workerRunning = ['cam', 'screen'].some(
    (kind) => sessions[kind]?.active && sessions[kind].mode === 'worker',
  );
  el['background-notice'].hidden = !(document.hidden && anyActive() && !workerRunning);
}

function redirectExpired() {
  if (state.redirecting) return;
  state.redirecting = true;
  stopAll();
  location.href = '/host?expirado=1';
}

/* ---------------- Presença ---------------- */

async function fetchInitialStatus() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (response.status === 401) {
      redirectExpired();
      return;
    }
    if (!response.ok) return;
    const data = await response.json();
    if (data.presence) state.presence = data.presence;
    state.viewers = Number(data.viewers) || 0;
    renderPresence();
    updateStats();
  } catch {
    /* o ping tenta de novo */
  }
}

async function savePresence(nextState) {
  if (state.savingPresence) return;
  if (!PRESENCE_LABEL[nextState]) nextState = 'trabalhando';

  state.savingPresence = true;
  const note = el['presence-note'].value.trim();

  try {
    const response = await fetch('/api/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: nextState, note }),
    });

    if (response.status === 401) {
      redirectExpired();
      return;
    }
    if (!response.ok) throw new Error('presence');

    const data = await response.json();
    state.presence = data.presence || { state: nextState, note, updatedAt: Date.now() };
    renderPresence();
  } catch {
    toast('Não foi possível salvar o status agora.');
  } finally {
    state.savingPresence = false;
  }
}

function ensurePresenceDefault(fallback) {
  if (state.presence.state !== 'indefinido') return;
  savePresence(fallback);
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
  if (!state.presence.updatedAt) return;
  el['presence-badge'].title = `Atualizado ${timeAgo(state.presence.updatedAt)}`;
}

/* ---------------- Servidor ---------------- */

async function pingHost() {
  try {
    const response = await fetch('/api/host/ping', { method: 'POST' });
    if (response.status === 401) {
      redirectExpired();
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.connected = true;
    state.viewers = Number(data.viewers) || 0;
    el['host-conn-hint'].textContent = `Servidor conectado · ${state.viewers} assistindo agora.`;
  } catch {
    state.connected = false;
    el['host-conn-hint'].textContent = 'Sem conexão com o servidor. Tentando reconectar…';
  } finally {
    updateModePill();
    updateStats();
  }
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
