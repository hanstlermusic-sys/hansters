// Mock API local: inventa respuestas JSON para desarrollar frontend/backend
// sin depender de APIs externas (PayPal, R2, licencias...).
//
// Vive en su PROPIO servidor y puerto: si algo falla aqui, el chat de
// HanstlerS no se entera. server.js solo lo arranca y lo para.
//
// Uso tipico:
//   GET  http://127.0.0.1:8718/api/paypal/order       -> JSON inventado y cacheado
//   GET  http://127.0.0.1:8718/api/paypal/order?__scenario=rechazado
//   GET  http://127.0.0.1:8718/api/license?__status=500
//   POST http://127.0.0.1:8718/__mock/seed            -> fija una respuesta a mano
//   POST http://127.0.0.1:8718/__mock/clear           -> borra la cache
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MOCK_DIR = path.join(os.homedir(), '.hanstlers', 'mocks');
const DEFAULT_PORT = Number(process.env.HANSTLERS_MOCK_PORT || 8718);
const MAX_BODY = 256 * 1024;

// --- Utilidades puras (las pruebas las usan directamente) ---

// Una peticion se identifica por metodo + ruta + escenario. La query normal
// NO entra en la clave: /productos?page=1 y ?page=2 deben dar la misma forma.
function mockCacheKey(method, pathname, scenario) {
  const base = String(method || 'GET').toUpperCase() + ' ' + String(pathname || '/') +
    (scenario ? ' #' + scenario : '');
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 16);
}

// Separa la ruta real de los parametros de control (__scenario, __status).
function parseMockRequest(method, url) {
  const u = new URL(String(url || '/'), 'http://127.0.0.1');
  const scenario = String(u.searchParams.get('__scenario') || '').trim().slice(0, 60);
  const rawStatus = Number(u.searchParams.get('__status'));
  const status = Number.isFinite(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : 200;
  const query = {};
  u.searchParams.forEach((v, k) => { if (!k.startsWith('__')) query[k] = v; });
  return {
    method: String(method || 'GET').toUpperCase(),
    pathname: u.pathname,
    scenario,
    status,
    query,
    key: mockCacheKey(method, u.pathname, scenario)
  };
}

// El modelo suele envolver el JSON en ```json ... ``` o anadir explicacion.
// Rescatamos el primer objeto/array bien formado que aparezca.
function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : raw;
  try { return JSON.parse(body); } catch (e) {}
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

// Respuesta sin IA: sirve para trabajar sin Vertex configurado y sin red.
// Deduce la forma por el nombre del recurso, que es lo que importa al
// programar el frontend (una lista vs un objeto vs un ok).
function fallbackMock(info) {
  const parts = String(info.pathname || '/').split('/').filter(Boolean);
  const last = (parts[parts.length - 1] || 'recurso').toLowerCase();
  const scenario = String(info.scenario || '').toLowerCase();
  if (info.status >= 400 || /error|fallo|rechaz|denied|fail|invalid/.test(scenario)) {
    return {
      ok: false,
      error: scenario || 'mock_error',
      message: 'Respuesta de error simulada por HanstlerS Mock API',
      path: info.pathname
    };
  }
  // Caso frecuente en HanstlerS: simular una orden de PayPal para pruebas
  // del checkout sin pegarle a la API real.
  if (String(info.pathname || '').toLowerCase() === '/api/paypal/order') {
    return {
      id: '5O190127TN364715T',
      status: 'CREATED',
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: 'default',
          amount: { currency_code: 'USD', value: '49.99' },
          description: 'HanstlerS Pro'
        }
      ],
      payer: {
        name: { given_name: 'Cesar', surname: 'Zumbado' },
        email_address: 'comprador@ejemplo.com'
      },
      links: [
        {
          href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T',
          rel: 'self',
          method: 'GET'
        },
        {
          href: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
          rel: 'approve',
          method: 'GET'
        },
        {
          href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T/capture',
          rel: 'capture',
          method: 'POST'
        }
      ]
    };
  }
  const plural = /s$|list|items|productos|licenses|orders/.test(last);
  const item = (i) => ({
    id: 'mock-' + last + '-' + (i + 1),
    nombre: last + ' ' + (i + 1),
    estado: 'activo',
    creado: '2026-01-0' + (i + 1) + 'T00:00:00.000Z'
  });
  if (plural) return { ok: true, total: 2, items: [item(0), item(1)] };
  return Object.assign({ ok: true }, item(0));
}

function promptFor(info, body) {
  const lines = [
    'Genera SOLO un JSON de ejemplo (sin explicacion, sin markdown) que podria devolver esta API REST.',
    'Metodo: ' + info.method,
    'Ruta: ' + info.pathname
  ];
  if (Object.keys(info.query).length) lines.push('Query: ' + JSON.stringify(info.query));
  if (body) lines.push('Cuerpo recibido: ' + String(body).slice(0, 1000));
  if (info.scenario) lines.push('Escenario a simular: ' + info.scenario);
  if (info.status >= 400) lines.push('Debe representar un error HTTP ' + info.status + '.');
  lines.push('Usa datos realistas en espanol. Responde unicamente el JSON.');
  return lines.join('\n');
}

// --- Cache en disco ---

function cachePath(key) { return path.join(MOCK_DIR, key + '.json'); }

function readCache(key) {
  try { return JSON.parse(fs.readFileSync(cachePath(key), 'utf8')); } catch (e) { return null; }
}

function writeCache(key, info, data) {
  try {
    fs.mkdirSync(MOCK_DIR, { recursive: true });
    fs.writeFileSync(cachePath(key), JSON.stringify({
      key,
      method: info.method,
      pathname: info.pathname,
      scenario: info.scenario || '',
      status: info.status,
      data,
      creado: new Date().toISOString()
    }, null, 2), 'utf8');
  } catch (e) {}
}

function clearCache() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(MOCK_DIR)) {
      if (!f.endsWith('.json')) continue;
      try { fs.unlinkSync(path.join(MOCK_DIR, f)); n++; } catch (e) {}
    }
  } catch (e) {}
  return n;
}

function listCache() {
  const out = [];
  try {
    for (const f of fs.readdirSync(MOCK_DIR)) {
      if (!f.endsWith('.json')) continue;
      const c = readCache(f.replace(/\.json$/, ''));
      if (c) out.push({ key: c.key, method: c.method, pathname: c.pathname, scenario: c.scenario, creado: c.creado });
    }
  } catch (e) {}
  return out;
}

// --- Servidor ---

let server = null;
let activePort = 0;
let generator = null; // (prompt, cb(err, texto)) inyectado desde server.js

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'X-Hanstlers-Mock': '1'
  });
  res.end(payload);
}

function readBody(req, cb) {
  let raw = '';
  let done = false;
  const finish = (v) => { if (!done) { done = true; cb(v); } };
  req.on('data', (d) => {
    raw += d.toString();
    if (raw.length > MAX_BODY) { raw = raw.slice(0, MAX_BODY); try { req.destroy(); } catch (e) {} finish(raw); }
  });
  req.on('end', () => finish(raw));
  req.on('error', () => finish(raw));
}

function handle(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }

  const info = parseMockRequest(req.method, req.url);

  // Rutas de control del propio mock.
  if (info.pathname === '/__mock/health') {
    return sendJson(res, 200, { ok: true, puerto: activePort, ia: !!generator, cacheados: listCache().length });
  }
  if (info.pathname === '/__mock/list') {
    return sendJson(res, 200, { ok: true, items: listCache() });
  }
  if (info.pathname === '/__mock/clear') {
    return sendJson(res, 200, { ok: true, borrados: clearCache() });
  }
  if (info.pathname === '/__mock/seed') {
    return readBody(req, (raw) => {
      let b = null;
      try { b = JSON.parse(raw || '{}'); } catch (e) {}
      if (!b || !b.path || typeof b.data === 'undefined') {
        return sendJson(res, 400, { ok: false, error: 'Se espera { path, data, method?, scenario?, status? }' });
      }
      const seed = parseMockRequest(b.method || 'GET', String(b.path) +
        (b.scenario ? (String(b.path).includes('?') ? '&' : '?') + '__scenario=' + encodeURIComponent(b.scenario) : ''));
      if (Number.isFinite(Number(b.status))) seed.status = Number(b.status);
      writeCache(seed.key, seed, b.data);
      return sendJson(res, 200, { ok: true, key: seed.key, path: seed.pathname });
    });
  }

  const cached = readCache(info.key);
  if (cached) return sendJson(res, cached.status || info.status, cached.data);

  readBody(req, (raw) => {
    // El respaldo NO se cachea si hay IA disponible: una caida puntual de
    // Vertex dejaria congelado un JSON pobre para siempre. Asi, la siguiente
    // llamada vuelve a intentar con la IA.
    const finish = (data, esRespaldo) => {
      if (!(esRespaldo && generator)) writeCache(info.key, info, data);
      sendJson(res, info.status, data);
    };
    if (!generator) return finish(fallbackMock(info), false);
    let settled = false;
    const once = (data, esRespaldo) => { if (!settled) { settled = true; finish(data, esRespaldo); } };
    const timer = setTimeout(() => once(fallbackMock(info), true), 30000);
    try {
      generator(promptFor(info, raw), (err, texto) => {
        clearTimeout(timer);
        const j = err ? null : extractJson(texto);
        if (j === null) return once(fallbackMock(info), true);
        return once(j, false);
      });
    } catch (e) {
      clearTimeout(timer);
      once(fallbackMock(info), true);
    }
  });
}

function isRunning() { return !!server; }
function port() { return activePort; }
function setGenerator(fn) { generator = typeof fn === 'function' ? fn : null; }

function start(opts, cb) {
  const o = opts || {};
  const done = typeof cb === 'function' ? cb : () => {};
  if (o.generate) setGenerator(o.generate);
  if (server) return done(null, { puerto: activePort, yaActivo: true });
  const wanted = Number(o.port || DEFAULT_PORT);
  const s = http.createServer((req, res) => {
    try { handle(req, res); }
    catch (e) {
      try { sendJson(res, 500, { ok: false, error: 'mock: ' + (e && e.message) }); } catch (_) {}
    }
  });
  s.on('error', (err) => {
    if (server === s) { server = null; activePort = 0; }
    done(err);
  });
  s.listen(wanted, '127.0.0.1', () => {
    server = s;
    activePort = s.address().port;
    done(null, { puerto: activePort, yaActivo: false });
  });
}

function stop(cb) {
  const done = typeof cb === 'function' ? cb : () => {};
  if (!server) return done(null);
  const s = server;
  server = null;
  activePort = 0;
  try { s.close(() => done(null)); } catch (e) { done(null); }
}

function status() {
  return {
    activo: isRunning(),
    puerto: activePort || DEFAULT_PORT,
    url: 'http://127.0.0.1:' + (activePort || DEFAULT_PORT),
    ia: !!generator,
    cacheados: listCache().length,
    carpeta: MOCK_DIR
  };
}

module.exports = {
  start,
  stop,
  status,
  isRunning,
  port,
  setGenerator,
  clearCache,
  listCache,
  // expuestas para las pruebas
  mockCacheKey,
  parseMockRequest,
  extractJson,
  fallbackMock,
  promptFor,
  MOCK_DIR,
  DEFAULT_PORT
};
