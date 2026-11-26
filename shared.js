/* Utilidades compartilhadas da versão estática (GitHub Pages + WebRTC). */

export const DEFAULT_PIN = '12345678';
export const ROOM_KEY = 'leo-host-room';
export const VIEWER_ROOM_KEY = 'leo-viewer-room';
export const HOST_PIN_KEY = 'leo-host-pin';
export const CLIENT_ID_KEY = 'leo-client-id';
export const PRESENCE_KEY = 'leo-presence';
export const QUALITY_KEY = 'leo-quality';

const ROOM_RE = /^[a-z0-9][a-z0-9-]{3,63}$/i;

export function isValidRoom(value) {
  return typeof value === 'string' && ROOM_RE.test(value.trim());
}

export function randomToken(length = 12) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let output = '';
  for (const byte of bytes) output += alphabet[byte % alphabet.length];
  return output;
}

export function randomRoom() {
  return `leo-${randomToken(12)}`;
}

export function getOrCreateHostRoom() {
  let fromUrl = null;
  try {
    const params = new URLSearchParams(location.search);
    fromUrl = params.get('sala') || params.get('room');
  } catch {
    /* URL inválida: segue com o armazenamento local */
  }

  if (isValidRoom(fromUrl)) {
    const room = fromUrl.trim();
    try {
      localStorage.setItem(ROOM_KEY, room);
    } catch {
      /* modo privado sem armazenamento */
    }
    return room;
  }

  try {
    const saved = localStorage.getItem(ROOM_KEY);
    if (isValidRoom(saved)) return saved.trim();
  } catch {
    /* modo privado sem armazenamento */
  }

  const room = randomRoom();
  try {
    localStorage.setItem(ROOM_KEY, room);
  } catch {
    /* modo privado sem armazenamento */
  }
  return room;
}

export function getRoomForViewer() {
  let fromUrl = null;
  try {
    const params = new URLSearchParams(location.search);
    fromUrl = params.get('sala') || params.get('room');
    if (!fromUrl && location.hash.startsWith('#sala=')) {
      fromUrl = decodeURIComponent(location.hash.slice(6));
    }
  } catch {
    /* ignora */
  }

  if (isValidRoom(fromUrl)) {
    const room = fromUrl.trim();
    try {
      localStorage.setItem(VIEWER_ROOM_KEY, room);
    } catch {
      /* ignora */
    }
    return room;
  }

  try {
    const saved = localStorage.getItem(VIEWER_ROOM_KEY);
    if (isValidRoom(saved)) return saved.trim();
  } catch {
    /* ignora */
  }

  return null;
}

export function viewerLink(room) {
  const url = new URL('./', location.href);
  if (room) url.searchParams.set('sala', room);
  return url.toString();
}

export function getHostPin() {
  try {
    const saved = localStorage.getItem(HOST_PIN_KEY);
    if (saved && saved.trim()) return saved.trim();
  } catch {
    /* ignora */
  }
  return DEFAULT_PIN;
}

export function setHostPin(pin) {
  const value = normalizePin(pin);
  if (!value) return false;
  try {
    localStorage.setItem(HOST_PIN_KEY, value);
  } catch {
    /* ignora */
  }
  return true;
}

export function normalizePin(value) {
  return String(value ?? '').trim().slice(0, 32);
}

export function getClientId() {
  try {
    const saved = localStorage.getItem(CLIENT_ID_KEY);
    if (saved && /^[a-z0-9-]{8,64}$/i.test(saved)) return saved;
  } catch {
    /* ignora */
  }

  const id = globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${randomToken(10)}`;

  try {
    localStorage.setItem(CLIENT_ID_KEY, id);
  } catch {
    /* ignora */
  }
  return id;
}

export function peerOptions() {
  const params = new URLSearchParams(location.search);
  const debug = params.get('debug') === '1' ? 2 : 0;

  return {
    debug,
    config: {
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        { urls: 'stun:stun.cloudflare.com:3478' },
        {
          urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp',
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
      ],
    },
  };
}

export function timeAgo(timestamp, now = Date.now()) {
  if (!timestamp) return null;
  const seconds = Math.max(0, Math.round((now - Number(timestamp)) / 1000));
  if (seconds < 2) return 'agora';
  if (seconds < 60) return `há ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  return `há ${days}d`;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1).replace('.', ',')} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2).replace('.', ',')} GB`;
}

let toastTimer = null;

export function toast(message) {
  let element = document.getElementById('toast');
  if (!element) {
    element = document.createElement('div');
    element.id = 'toast';
    element.className = 'toast';
    element.setAttribute('role', 'status');
    document.body.appendChild(element);
  }
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 3600);
}

export async function copyText(text, successMessage = 'Copiado!') {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    toast(successMessage);
    return true;
  } catch {
    toast('Não foi possível copiar. Selecione o texto manualmente.');
    return false;
  }
}

export function loadPresence() {
  try {
    const raw = localStorage.getItem(PRESENCE_KEY);
    if (!raw) return { state: 'indefinido', note: '', updatedAt: 0 };
    const parsed = JSON.parse(raw);
    const valid = ['trabalhando', 'pausa', 'almocando', 'banheiro', 'ausente', 'indefinido'];
    return {
      state: valid.includes(parsed?.state) ? parsed.state : 'indefinido',
      note: String(parsed?.note ?? '').slice(0, 140),
      updatedAt: Number(parsed?.updatedAt) || 0,
    };
  } catch {
    return { state: 'indefinido', note: '', updatedAt: 0 };
  }
}

export function savePresence(presence) {
  try {
    localStorage.setItem(PRESENCE_KEY, JSON.stringify(presence));
  } catch {
    /* ignora */
  }
}
