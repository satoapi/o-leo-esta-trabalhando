import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const BIND = process.env.HOST || '0.0.0.0';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FRAME_BYTES = 6 * 1024 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 6;
const HOST_ONLINE_MS = 15_000;
const STREAM_BACKLOG_LIMIT = 8_000_000;
const MJPEG_BACKLOG_LIMIT = 8_000_000;

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/host', ['host.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/shared.js', ['shared.js', 'text/javascript; charset=utf-8']],
  ['/viewer.js', ['viewer.js', 'text/javascript; charset=utf-8']],
  ['/host.js', ['host.js', 'text/javascript; charset=utf-8']],
  ['/capture-worker.js', ['capture-worker.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
  ['/apple-touch-icon.png', ['apple-touch-icon.png', 'image/png']],
]);

await mkdir(DATA_DIR, { recursive: true });

let saved = {};
try {
  saved = JSON.parse(await readFile(STATE_FILE, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.warn('[aviso] Não foi possível ler data/state.json; um novo será criado.');
  }
}

const pin = String(process.env.ACCESS_PIN || saved.pin || randomInt(10_000_000, 100_000_000)).trim();
const sessionSecret = String(
  process.env.AUTH_SECRET || saved.secret || randomBytes(32).toString('hex'),
);

if (saved.pin !== pin || saved.secret !== sessionSecret) {
  try {
    await writeFile(
      STATE_FILE,
      JSON.stringify({ pin, secret: sessionSecret }, null, 2),
      { mode: 0o600 },
    );
  } catch (error) {
    console.warn('[aviso] Não foi possível salvar data/state.json:', error.message);
  }
}

if (pin.length < 6) {
  console.warn('[aviso] O PIN configurado é curto. Use pelo menos 6 caracteres.');
}
if (!process.env.ACCESS_PIN) {
  console.log('[info] Nenhum ACCESS_PIN definido; o PIN foi gerado/salvo em data/state.json.');
}

/* ------------------------------------------------------------------ */
/* Sessão                                                              */
/* ------------------------------------------------------------------ */

const COOKIE_NAME = 'leo_session';

function makeSessionToken() {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + SESSION_TTL_MS }),
  ).toString('base64url');
  const signature = createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function validSessionToken(token) {
  if (typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  const givenBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    givenBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(givenBuffer, expectedBuffer)
  ) {
    return false;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(data.exp) && data.exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return validSessionToken(cookies[COOKIE_NAME]);
}

function isHttps(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return Boolean(req.socket.encrypted) || forwarded === 'https';
}

function sessionCookie(req, value, maxAgeSeconds) {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

/* ------------------------------------------------------------------ */
/* Rate limit do login                                                 */
/* ------------------------------------------------------------------ */

const loginAttempts = new Map();

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || req.socket.remoteAddress || 'desconhecido';
}

function loginRateStatus(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now >= record.resetAt) return { blocked: false, retryAfter: 0 };
  if (record.fails < LOGIN_MAX_FAILS) return { blocked: false, retryAfter: 0 };
  return {
    blocked: true,
    retryAfter: Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
  };
}

function registerLoginFailure(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now >= record.resetAt) {
    loginAttempts.set(ip, { fails: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  record.fails += 1;
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    if (now >= record.resetAt) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* Helpers HTTP                                                        */
/* ------------------------------------------------------------------ */

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), display-capture=(self), microphone=(), geolocation=()',
  );
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "style-src 'self'",
      "script-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  );
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let done = false;
    let size = 0;
    const chunks = [];

    const fail = (error) => {
      if (done) return;
      done = true;
      reject(error);
      req.resume();
    };

    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error('Corpo da requisição muito grande'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

function safePinEqual(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  const length = Math.max(a.length, b.length, 1);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  a.copy(paddedA);
  b.copy(paddedB);
  return timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Estado das transmissões                                             */
/* ------------------------------------------------------------------ */

/** @type {Set<{res: http.ServerResponse}>} */
const viewers = new Set();
/** @type {{cam: Set<{res: http.ServerResponse}>, screen: Set<{res: http.ServerResponse}>}} */
const mjpegClients = { cam: new Set(), screen: new Set() };
const lastFrames = { cam: null, screen: null };
const lastFrameMeta = { cam: 0, screen: 0 };
const frameCounts = { cam: 0, screen: 0 };
let frameSequence = 0;
let hostLastSeen = 0;
let hostOnline = false;

const PRESENCE_STATES = new Set([
  'trabalhando',
  'pausa',
  'almocando',
  'banheiro',
  'ausente',
]);
let presence = { state: 'indefinido', note: '', updatedAt: 0 };
const sourceActive = { cam: false, screen: false };
const sourceOwner = { cam: null, screen: null };

function currentStatus() {
  return {
    hostOnline,
    viewers: uniqueViewerCount(),
    presence,
    sources: { ...sourceActive },
    last: {
      cam: lastFrames.cam?.ts || 0,
      screen: lastFrames.screen?.ts || 0,
    },
    frames: { cam: frameCounts.cam, screen: frameCounts.screen },
    serverTime: Date.now(),
  };
}

function uniqueViewerCount() {
  const tokens = new Set();
  for (const viewer of viewers) tokens.add(viewer.token);
  return tokens.size;
}

function setSourceActive(source, active, { clearFrame = false } = {}) {
  if (clearFrame) lastFrames[source] = null;
  if (!active) closeMjpegClients(source);
  if (sourceActive[source] === active) return;
  sourceActive[source] = active;
  broadcastEvent('source', { source, active });
  broadcastStatus();
}

function touchHost() {
  hostLastSeen = Date.now();
  if (!hostOnline) {
    hostOnline = true;
    broadcastStatus();
  }
}

function writeToViewer(viewer, payload) {
  if (viewer.res.writableEnded || viewer.res.destroyed) {
    viewers.delete(viewer);
    return false;
  }
  if (viewer.res.writableLength > STREAM_BACKLOG_LIMIT) {
    // O cliente está lento: descarta este quadro em vez de acumular memória.
    return false;
  }
  try {
    viewer.res.write(payload);
    return true;
  } catch {
    viewers.delete(viewer);
    try {
      viewer.res.end();
    } catch {
      /* ignore */
    }
    return false;
  }
}

function broadcastEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const viewer of viewers) writeToViewer(viewer, payload);
}

function broadcastStatus() {
  broadcastEvent('status', currentStatus());
}

function closeMjpegClients(source) {
  for (const client of mjpegClients[source]) {
    try {
      client.res.end();
    } catch {
      /* ignore */
    }
  }
  mjpegClients[source].clear();
}

function writeMjpegFrame(source, client, frame) {
  const res = client.res;
  if (res.writableEnded || res.destroyed) {
    mjpegClients[source].delete(client);
    return false;
  }
  if (res.writableLength > MJPEG_BACKLOG_LIMIT) {
    // Cliente lento: descarta o quadro inteiro, sem quebrar o multipart.
    // Se continuar travado por muito tempo, encerra a conexão para liberar
    // o navegador (a página reconecta sozinha).
    if (!client.slowSince) client.slowSince = Date.now();
    if (Date.now() - client.slowSince > 10_000) {
      mjpegClients[source].delete(client);
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    }
    return false;
  }
  client.slowSince = 0;

  try {
    res.write(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.buffer.length}\r\n\r\n`,
    );
    res.write(frame.buffer);
    res.write('\r\n');
    return true;
  } catch {
    mjpegClients[source].delete(client);
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return false;
  }
}

function broadcastFrame(source, frame) {
  for (const client of mjpegClients[source]) {
    writeMjpegFrame(source, client, frame);
  }
  // Metadados leves para o painel saber quando o vídeo está vivo. Limitados a
  // ~4 por segundo por fonte para não pesar em celulares.
  if (frame.ts - lastFrameMeta[source] >= 250) {
    lastFrameMeta[source] = frame.ts;
    broadcastEvent('frame', { source, ts: frame.ts, seq: frame.seq });
  }
}

setInterval(() => {
  const online = Date.now() - hostLastSeen < HOST_ONLINE_MS;
  if (online !== hostOnline) {
    hostOnline = online;
    broadcastStatus();
  }
}, 3000).unref();

setInterval(() => {
  for (const viewer of viewers) {
    try {
      viewer.res.write(': ping\n\n');
    } catch {
      viewers.delete(viewer);
    }
  }
}, 15000).unref();

/* ------------------------------------------------------------------ */
/* Rotas                                                               */
/* ------------------------------------------------------------------ */

async function handleRequest(req, res) {
  applySecurityHeaders(res);

  const method = req.method || 'GET';
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/healthz' && (method === 'GET' || method === 'HEAD')) {
    return sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
  }

  if (pathname === '/api/me' && method === 'GET') {
    return sendJson(res, 200, { authenticated: isAuthenticated(req) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    const rate = loginRateStatus(ip);
    if (rate.blocked) {
      return sendJson(
        res,
        429,
        { error: 'Muitas tentativas. Tente novamente mais tarde.' },
        { 'Retry-After': String(rate.retryAfter) },
      );
    }

    let body;
    try {
      const raw = await readBody(req, 10 * 1024);
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch (error) {
      return sendJson(res, error.status || 400, { error: 'Requisição inválida.' });
    }

    const candidate = String(body.pin || '').trim();
    if (!safePinEqual(candidate, pin)) {
      registerLoginFailure(ip);
      await sleep(350);
      return sendJson(res, 401, { error: 'PIN incorreto.' });
    }

    clearLoginFailures(ip);
    return sendJson(
      res,
      200,
      { ok: true },
      { 'Set-Cookie': sessionCookie(req, makeSessionToken(), SESSION_TTL_MS / 1000) },
    );
  }

  if (pathname === '/api/logout' && method === 'POST') {
    return sendJson(
      res,
      200,
      { ok: true },
      { 'Set-Cookie': sessionCookie(req, '', 0) },
    );
  }

  if (pathname === '/api/status' && method === 'GET') {
    if (!isAuthenticated(req)) return sendJson(res, 401, { error: 'Não autenticado.' });
    return sendJson(res, 200, currentStatus());
  }

  if (pathname === '/api/presence' && method === 'POST') {
    if (!isAuthenticated(req)) return sendJson(res, 401, { error: 'Não autenticado.' });

    let body;
    try {
      const raw = await readBody(req, 4096);
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return sendJson(res, 400, { error: 'Requisição inválida.' });
    }

    const state = String(body.state || '');
    if (!PRESENCE_STATES.has(state)) {
      return sendJson(res, 400, { error: 'Status inválido.' });
    }
    const note = String(body.note || '').trim().slice(0, 140);

    presence = { state, note, updatedAt: Date.now() };
    broadcastEvent('presence', presence);
    return sendJson(res, 200, { ok: true, presence });
  }

  if (pathname === '/api/source' && method === 'POST') {
    if (!isAuthenticated(req)) return sendJson(res, 401, { error: 'Não autenticado.' });

    let body;
    try {
      const raw = await readBody(req, 4096);
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return sendJson(res, 400, { error: 'Requisição inválida.' });
    }

    const source = String(body.source || '');
    if (source !== 'cam' && source !== 'screen') {
      return sendJson(res, 400, { error: 'Fonte inválida.' });
    }

    const hostId = String(body.host || '').slice(0, 80);
    const active = Boolean(body.active);

    if (!active && hostId && sourceOwner[source] && sourceOwner[source] !== hostId) {
      return sendJson(res, 200, { ok: true, ignored: true, sources: { ...sourceActive } });
    }

    touchHost();

    if (active) {
      const changed = sourceOwner[source] !== (hostId || null);
      sourceOwner[source] = hostId || null;
      setSourceActive(source, true, { clearFrame: changed });
    } else {
      sourceOwner[source] = null;
      setSourceActive(source, false, { clearFrame: true });
    }

    return sendJson(res, 200, { ok: true, sources: { ...sourceActive } });
  }

  if (pathname === '/api/host/ping' && method === 'POST') {
    if (!isAuthenticated(req)) return sendJson(res, 401, { error: 'Não autenticado.' });
    touchHost();
    return sendJson(res, 200, { ok: true, viewers: uniqueViewerCount() });
  }

  if (pathname === '/api/frame' && method === 'POST') {
    if (!isAuthenticated(req)) return sendJson(res, 401, { error: 'Não autenticado.' });

    const source = url.searchParams.get('source');
    if (source !== 'cam' && source !== 'screen') {
      return sendJson(res, 400, { error: 'Fonte inválida.' });
    }

    let buffer;
    try {
      buffer = await readBody(req, MAX_FRAME_BYTES);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: 'Quadro inválido.' });
    }

    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      return sendJson(res, 415, { error: 'Envie uma imagem JPEG.' });
    }

    const hostId = url.searchParams.get('host') || '';
    if (sourceOwner[source] && sourceOwner[source] !== hostId) {
      // Outra aba antiga ainda está enviando: não deixa misturar com a atual.
      return sendJson(res, 200, { ok: true, ignored: true });
    }
    if (!sourceOwner[source] && hostId) sourceOwner[source] = hostId;

    touchHost();
    if (!sourceActive[source]) setSourceActive(source, true);
    const ts = Date.now();
    frameSequence += 1;
    frameCounts[source] += 1;
    const frame = { ts, seq: frameSequence, buffer };
    lastFrames[source] = frame;
    broadcastFrame(source, frame);
    return sendJson(res, 200, { ok: true, seq: frame.seq });
  }

  if (pathname === '/api/mjpeg' && method === 'GET') {
    if (!isAuthenticated(req)) return sendJson(res, 401, { error: 'Não autenticado.' });

    const source = url.searchParams.get('source');
    if (source !== 'cam' && source !== 'screen') {
      return sendJson(res, 400, { error: 'Fonte inválida.' });
    }

    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const client = { res };
    mjpegClients[source].add(client);
    if (lastFrames[source]) writeMjpegFrame(source, client, lastFrames[source]);

    const cleanup = () => mjpegClients[source].delete(client);
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    return;
  }

  if (pathname === '/api/stream' && method === 'GET') {
    if (!isAuthenticated(req)) {
      return sendJson(res, 401, { error: 'Não autenticado.' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const viewer = { res, token: parseCookies(req.headers.cookie || '')[COOKIE_NAME] || '' };
    viewers.add(viewer);

    res.write(`event: status\ndata: ${JSON.stringify(currentStatus())}\n\n`);
    res.write(`event: presence\ndata: ${JSON.stringify(presence)}\n\n`);

    const cleanup = () => {
      viewers.delete(viewer);
      broadcastStatus();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    broadcastStatus();
    return;
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'Rota não encontrada.' });
  }

  if (method === 'GET' || method === 'HEAD') {
    const asset = STATIC_FILES.get(pathname);
    if (asset) {
      try {
        const [file, contentType] = asset;
        const data = await readFile(path.join(PUBLIC_DIR, file));
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': data.length,
          'Cache-Control': 'no-cache',
        });
        return res.end(method === 'HEAD' ? undefined : data);
      } catch {
        return sendText(res, 404, 'Arquivo não encontrado.');
      }
    }
  }

  return sendText(res, 404, 'Página não encontrada.');
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    if (error?.status) {
      sendJson(res, error.status, { error: error.message || 'Requisição inválida.' });
      return;
    }
    console.error('[erro]', error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Erro interno do servidor.' });
    } else if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n[erro] A porta ${PORT} já está em uso. Feche o outro processo ou defina PORT.\n`);
  } else {
    console.error('[erro]', error);
  }
  process.exitCode = 1;
});

server.listen(PORT, BIND, () => {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);

  const lanUrls = addresses.map((address) => `http://${address}:${PORT}`);

  console.log('');
  console.log('  ===============================================');
  console.log('   O LEO ESTÁ TRABALHANDO?');
  console.log('  ===============================================');
  console.log(`   Painel (celular/PC):  http://localhost:${PORT}`);
  for (const url of lanUrls) {
    console.log(`   Na mesma rede:        ${url}`);
  }
  console.log(`   Host (neste PC):      http://localhost:${PORT}/host`);
  console.log('');
  console.log(`   PIN de acesso:        ${pin}`);
  console.log('');
  console.log('   Dica: no PC, abra a página /host e autorize a câmera.');
  console.log('   Mantenha esta janela e a aba do host abertas.');
  console.log('');
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nEncerrando...');
  for (const viewer of viewers) {
    try {
      viewer.res.end();
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
