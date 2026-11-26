/* Utilidades compartilhadas: autenticação, tempo, avisos e cópia. */

export async function getSession() {
  try {
    const response = await fetch('/api/me', { cache: 'no-store' });
    if (!response.ok) return { authenticated: false };
    return await response.json();
  } catch {
    return { authenticated: false };
  }
}

export async function initAuthGate(onReady) {
  const gate = document.getElementById('auth-gate');
  const app = document.getElementById('app');
  const form = document.getElementById('auth-form');

  if (!gate || !app || !form) {
    onReady();
    return;
  }

  const session = await getSession();
  if (session.authenticated) {
    gate.hidden = true;
    app.hidden = false;
    onReady();
    return;
  }

  gate.hidden = false;
  app.hidden = true;

  const input = form.querySelector('input[name="pin"]');
  const error = form.querySelector('[data-auth-error]');
  const button = form.querySelector('button[type="submit"]');
  const params = new URLSearchParams(location.search);
  if (params.get('expirado') === '1') {
    error.textContent = 'Sua sessão expirou. Entre novamente.';
  }

  setTimeout(() => input?.focus(), 80);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const pin = input.value.trim();
    error.textContent = '';

    if (!pin) {
      error.textContent = 'Digite o PIN para continuar.';
      input.focus();
      return;
    }

    button.disabled = true;
    const previous = button.textContent;
    button.textContent = 'Entrando…';

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });

      if (response.ok) {
        gate.hidden = true;
        app.hidden = false;
        input.value = '';
        onReady();
        return;
      }

      if (response.status === 429) {
        const retry = response.headers.get('Retry-After');
        error.textContent = retry
          ? `Muitas tentativas. Tente de novo em ${Math.ceil(Number(retry) / 60)} min.`
          : 'Muitas tentativas. Aguarde alguns minutos.';
      } else {
        error.textContent = 'PIN incorreto. Confira e tente novamente.';
      }
      input.select();
    } catch {
      error.textContent = 'Não foi possível conectar ao servidor. Verifique a internet.';
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  });
}

export async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {
    /* mesmo sem rede, volta para a tela inicial */
  }
  location.href = '/';
}

export function bindLogout(selector = '[data-logout]') {
  for (const button of document.querySelectorAll(selector)) {
    button.addEventListener('click', logout);
  }
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

export function clockTime(timestamp) {
  if (!timestamp) return '--:--:--';
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleTimeString('pt-BR');
  }
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
  }, 3200);
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

export function setButtonBusy(button, busy, busyLabel = 'Aguarde…') {
  if (!button) return;
  if (busy) {
    button.dataset.idleLabel = button.textContent;
    button.textContent = busyLabel;
    button.disabled = true;
  } else {
    if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
    button.disabled = false;
  }
}

export function registerServiceWorker() {
  const secure = location.protocol === 'https:' || location.hostname === 'localhost';
  if (!secure || !('serviceWorker' in navigator)) return;

  // Em localhost o service worker só atrapalha: pode servir JS antigo do cache
  // durante o desenvolvimento. Remove registros antigos e não registra de novo.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => {
        for (const registration of registrations) registration.unregister();
      })
      .catch(() => {
        /* opcional */
      });
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* PWA é opcional */
    });
  });
}
