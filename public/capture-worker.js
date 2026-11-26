/* Captura e envio de quadros fora da thread principal.
 *
 * Roda em um Web Worker e é alimentado pelo pipeline de mídia do navegador
 * (MediaStreamTrackProcessor). Assim a transmissão continua em taxa alta
 * mesmo quando a aba do host está em segundo plano — o que não acontece com
 * timers normais, que o navegador reduz para 1x por segundo.
 */

const sessions = new Map();

self.addEventListener('message', (event) => {
  const message = event.data || {};

  if (message.type === 'start') {
    startSession(message).catch((error) => {
      report('error', message.id, error);
    });
  } else if (message.type === 'stop') {
    stopSession(message.id);
  } else if (message.type === 'config') {
    const session = sessions.get(message.id);
    if (session && message.config) {
      session.config = { ...session.config, ...message.config };
    }
  }
});

function report(type, id, error) {
  self.postMessage({ type, id, message: error ? String(error.message || error) : '' });
}

function stopSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  session.stopped = true;
  sessions.delete(id);
  try {
    session.reader?.cancel();
  } catch {
    /* ignora */
  }
}

async function startSession({ id, readable, source, config }) {
  stopSession(id);

  if (!readable) {
    report('unsupported', id);
    return;
  }

  const session = {
    id,
    source,
    config: { ...config },
    stopped: false,
    reader: null,
    canvas: null,
    context: null,
    lastSent: 0,
  };
  sessions.set(id, session);

  const reader = readable.getReader();
  session.reader = reader;
  self.postMessage({ type: 'started', id });

  try {
    for (;;) {
      const { done, value: frame } = await reader.read();
      if (done) break;
      if (!frame) continue;

      if (session.stopped) {
        closeFrame(frame);
        break;
      }

      const interval = 1000 / Math.max(1, session.config.fps || 20);
      const now = performance.now();
      if (now - session.lastSent < interval) {
        closeFrame(frame);
        continue;
      }
      session.lastSent = now;

      try {
        await encodeAndSend(session, frame);
      } catch {
        report('fails', id);
      } finally {
        closeFrame(frame);
      }

      if (session.stopped) break;
    }
  } catch (error) {
    if (!session.stopped) report('error', id, error);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignora */
    }
    if (sessions.get(id) === session) sessions.delete(id);
  }
}

async function encodeAndSend(session, frame) {
  const width = frame.displayWidth || frame.codedWidth;
  const height = frame.displayHeight || frame.codedHeight;
  if (!width || !height) return;

  const { maxW, maxH, quality } = session.config;
  const scale = Math.min(maxW / width, maxH / height, 1);
  const targetW = Math.max(2, Math.round(width * scale));
  const targetH = Math.max(2, Math.round(height * scale));

  if (!session.canvas) {
    session.canvas = new OffscreenCanvas(targetW, targetH);
    session.context = session.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!session.context) throw new Error('Canvas indisponível');
  } else if (session.canvas.width !== targetW || session.canvas.height !== targetH) {
    session.canvas.width = targetW;
    session.canvas.height = targetH;
  }

  session.context.drawImage(frame, 0, 0, targetW, targetH);

  const startedAt = performance.now();
  const blob = await session.canvas.convertToBlob({
    type: 'image/jpeg',
    quality: Math.min(0.95, Math.max(0.3, Number(quality) || 0.72)),
  });
  if (session.stopped || !blob) return;

  let response;
  try {
    response = await fetch(
      `/api/frame?source=${encodeURIComponent(session.source)}&host=${encodeURIComponent(session.config.host || '')}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
        signal: fetchTimeout(8000),
      },
    );
  } catch {
    if (!session.stopped) report('fails', session.id);
    return;
  }

  if (response.status === 401) {
    report('auth', session.id);
    stopSession(session.id);
    return;
  }
  if (!response.ok) {
    report('fails', session.id);
    return;
  }

  self.postMessage({
    type: 'sent',
    id: session.id,
    width: targetW,
    height: targetH,
    bytes: blob.size,
    elapsedMs: Math.round(performance.now() - startedAt),
  });
}

function closeFrame(frame) {
  try {
    frame.close();
  } catch {
    /* ignora */
  }
}

// AbortSignal.timeout usa o relógio interno do navegador, que não é
// reduzido como os timers da página quando a aba fica em segundo plano.
function fetchTimeout(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}
