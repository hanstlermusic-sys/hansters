'use strict';
// HanstlerS - servidor local que envuelve el GitHub Copilot CLI en una app de chat.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const PORT = process.env.HANSTLERS_PORT ? Number(process.env.HANSTLERS_PORT) : 8717;
const COPILOT_CMD = process.env.HANSTLERS_CMD || 'copilot';
const PUBLIC = path.join(__dirname, 'public');

// Resuelve el script real de Copilot (npm-loader.js) para poder ejecutarlo con
// node directamente y preservar saltos de línea (cmd.exe los rompe).
let LOADER = undefined; // undefined = sin resolver; null = no encontrado
function resolveLoader() {
  if (LOADER !== undefined) return LOADER;
  if (process.env.HANSTLERS_LOADER) { LOADER = process.env.HANSTLERS_LOADER; return LOADER; }
  if (process.env.HANSTLERS_CMD) { LOADER = null; return LOADER; } // modo test: usar wrapper
  const candidates = [];
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@github', 'copilot', 'npm-loader.js'));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules', '@github', 'copilot', 'npm-loader.js'));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@github', 'copilot', 'index.js'));
  for (const c of candidates) { try { if (fs.existsSync(c)) { LOADER = c; return LOADER; } } catch (e) {} }
  LOADER = null;
  return LOADER;
}

let state = {
  cwd: process.env.HANSTLERS_CWD || process.env.USERPROFILE || os.homedir(),
  started: false,
  model: process.env.HANSTLERS_MODEL || 'auto'
};

// Detecta qué flags soporta la version instalada del CLI (una sola vez).
let SUPPORTED = null;
function detectFlags(cb) {
  if (SUPPORTED) return cb(SUPPORTED);
  const runner = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', COPILOT_CMD, '--help'], { env: process.env })
    : spawn(COPILOT_CMD, ['--help'], { env: process.env });
  let out = '';
  const done = () => {
    const has = (f) => out.includes(f);
    SUPPORTED = {
      silent: has('--silent') || /\s-s[,\s]/.test(out),
      noBanner: has('--no-banner'),
      noAutoUpdate: has('--no-auto-update'),
      noRemote: has('--no-remote'),
      disableBuiltinMcps: has('--disable-builtin-mcps'),
      model: has('--model'),
      noAskUser: has('--no-ask-user')
    };
    cb(SUPPORTED);
  };
  let finished = false;
  const finish = () => { if (!finished) { finished = true; done(); } };
  runner.stdout.on('data', (d) => (out += d.toString()));
  runner.stderr.on('data', (d) => (out += d.toString()));
  runner.on('close', finish);
  runner.on('error', finish);
  setTimeout(finish, 8000);
}

// Construye los argumentos con las optimizaciones de velocidad soportadas.
function buildArgs(message, sessionId, withModel) {
  const a = ['-p', message, '--allow-all-tools'];
  const s = SUPPORTED || {};
  if (withModel && s.model && state.model && state.model !== 'auto') { a.push('--model', state.model); }
  if (s.silent) a.push('--silent');
  if (s.noBanner) a.push('--no-banner');
  if (s.noAutoUpdate) a.push('--no-auto-update');
  if (s.noRemote) a.push('--no-remote');
  if (s.disableBuiltinMcps) a.push('--disable-builtin-mcps');
  if (s.noAskUser) a.push('--no-ask-user');
  // Continuar la conversación real del CLI si tenemos su session id.
  if (sessionId) a.push('--resume=' + sessionId);
  return a;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// Líneas de "ruido" que el CLI imprime y que el usuario no necesita ver.
const NOISE = [
  /^\s*Changes\s+[+\-]?\d+/i,
  /^\s*AI Credits\b/i,
  /^\s*Tokens\b/i,
  /^\s*Resume\b/i,
  /copilot --resume=/i,
  /^\s*\d+(\.\d+)?k?\s+(cached|written)/i,
  /^\s*↑|^\s*↓/,
  /reasoning\)\s*$/i,
  /Total duration/i,
  /Total usage est/i
];
function isNoise(line) {
  return NOISE.some((re) => re.test(line));
}
// Crea un filtro con buffer por líneas: recibe texto crudo, devuelve texto limpio.
function makeLineFilter(onClean) {
  let buf = '';
  return {
    push(text) {
      buf += text;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!isNoise(line)) onClean(line + '\n');
      }
    },
    flush() {
      if (buf.length) { if (!isNoise(buf)) onClean(buf); buf = ''; }
    }
  };
}

function serveStatic(req, res) {
  let file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const full = path.join(PUBLIC, path.normalize(file).replace(/^([.][.][\/\\])+/, ''));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function handleChat(req, res, body) {
  let message = (body.message || '').trim();
  const images = Array.isArray(body.images) ? body.images : [];
  // Guardar imágenes pegadas/arrastradas y referenciarlas con @ruta para el CLI.
  const savedPaths = [];
  try {
    const dir = path.join(os.tmpdir(), 'hanstlers-img');
    fs.mkdirSync(dir, { recursive: true });
    images.forEach((img, i) => {
      const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/i.exec(img || '');
      if (!m) return;
      const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
      const file = path.join(dir, `img_${Date.now()}_${i}.${ext}`);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      savedPaths.push(file);
    });
  } catch (e) {}
  if (savedPaths.length) {
    const refs = savedPaths.map((p) => '@' + p).join(' ');
    message = message ? (message + '\n\n' + refs) : ('Describe estas imágenes: ' + refs);
  }
  if (!message) { res.writeHead(400); return res.end('empty'); }
  const sessionId = (body.sessionId || '').trim();
  detectFlags(() => handleChatInner(req, res, message, sessionId));
}

function handleChatInner(req, res, message, sessionId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  function launchRaw(withModel, sid) {
    const a = buildArgs(message, sid, withModel);
    const loader = resolveLoader();
    if (loader) {
      return spawn(process.execPath, [loader].concat(a), { cwd: state.cwd, env: process.env });
    }
    if (process.platform === 'win32') {
      return spawn('cmd.exe', ['/d', '/s', '/c', COPILOT_CMD].concat(a), { cwd: state.cwd, env: process.env });
    }
    return spawn(COPILOT_CMD, a, { cwd: state.cwd, env: process.env });
  }

  function attempt(withModel, sid, isRetry) {
    let child;
    try {
      child = launchRaw(withModel, sid);
    } catch (e) {
      send('error', 'No se pudo iniciar copilot: ' + e.message);
      return res.end();
    }

    let raw = '';
    let gotOutput = false;
    const filter = makeLineFilter((clean) => { gotOutput = true; send('chunk', clean); });

    child.stdout.on('data', (d) => { const t = stripAnsi(d.toString()); raw += t; filter.push(t); });
    child.stderr.on('data', (d) => { const t = stripAnsi(d.toString()); raw += t; filter.push(t); });
    child.on('error', (e) => { send('error', 'Error al ejecutar copilot: ' + e.message); res.end(); });
    child.on('close', (code) => {
      const modelUnavailable = withModel && /model .*(is )?not available|not available.*--model|--model flag is not available/i.test(raw);
      if (modelUnavailable && !isRetry) {
        state.autoOnly = true;
        return attempt(false, sid, true);
      }
      // Si --resume falló (sesión inexistente), reintenta sin sesión.
      if (code !== 0 && sid && !gotOutput && !isRetry) {
        return attempt(withModel, '', true);
      }
      filter.flush();
      // Capturar el session id del CLI para continuar esta conversación luego.
      const m = /--resume=([a-f0-9-]{8,})/i.exec(raw);
      if (m) send('session', { id: m[1] });
      send('done', { code });
      res.end();
    });

    // Permitir detener la respuesta desde el cliente (cerrar el stream mata el proceso).
    req.on('close', () => { try { child.kill(); } catch (e) {} });
  }

  attempt(!state.autoOnly, sessionId, false);
}

// ===== Historial de conversaciones (persistente en disco) =====
const CONV_DIR = path.join(os.homedir(), '.hanstlers', 'conversations');
function ensureConvDir() { try { fs.mkdirSync(CONV_DIR, { recursive: true }); } catch (e) {} }
function convFile(id) { return path.join(CONV_DIR, id.replace(/[^a-z0-9_-]/gi, '') + '.json'); }
function listConversations() {
  ensureConvDir();
  let files = [];
  try { files = fs.readdirSync(CONV_DIR).filter((f) => f.endsWith('.json')); } catch (e) {}
  const items = [];
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8'));
      items.push({ id: c.id, title: c.title || 'Conversación', updatedAt: c.updatedAt || 0 });
    } catch (e) {}
  }
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return items;
}
function saveConversation(conv) {
  ensureConvDir();
  if (!conv || !conv.id) return;
  conv.updatedAt = Date.now();
  try { fs.writeFileSync(convFile(conv.id), JSON.stringify(conv)); } catch (e) {}
}
function getConversation(id) {
  try { return JSON.parse(fs.readFileSync(convFile(id), 'utf8')); } catch (e) { return null; }
}
function deleteConversation(id) {
  try { fs.unlinkSync(convFile(id)); return true; } catch (e) { return false; }
}

function pickFolder(res) {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog;',
    '$f.Description = "Elige la carpeta de tu proyecto";',
    'if ($f.ShowDialog() -eq "OK") { Write-Output $f.SelectedPath }'
  ].join(' ');
  execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], (err, stdout) => {
    const p = (stdout || '').trim();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (p) { state.cwd = p; state.started = false; }
    res.end(JSON.stringify({ path: p || null, cwd: state.cwd }));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res, await readBody(req));
  if (req.method === 'GET' && req.url === '/api/pickfolder') return pickFolder(res);
  if (req.method === 'GET' && req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ cwd: state.cwd, model: state.model }));
  }
  if (req.method === 'GET' && req.url === '/api/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      current: state.model,
      models: [
        { id: 'auto', name: 'Automático (recomendado)' },
        { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (potente)' },
        { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
        { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
        { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5 (rápido)' },
        { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
        { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
        { id: 'gpt-5.4', name: 'GPT-5.4' },
        { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex (código)' },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini (rápido)' },
        { id: 'gpt-5-mini', name: 'GPT-5 mini (rápido)' },
        { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
        { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash (rápido)' },
        { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
        { id: 'mai-code-1-flash', name: 'MAI-Code-1-Flash (rápido)' },
        { id: '__custom__', name: 'Otro… (escribir ID)' }
      ]
    }));
  }
  if (req.method === 'POST' && req.url === '/api/model') {
    const b = await readBody(req);
    if (b && b.model) { state.model = b.model; state.started = false; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, model: state.model }));
  }
  if (req.method === 'GET' && req.url === '/api/conv/list') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ items: listConversations() }));
  }
  if (req.method === 'GET' && req.url.startsWith('/api/conv/get')) {
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    const c = getConversation(id);
    res.writeHead(c ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(c || { error: 'not found' }));
  }
  if (req.method === 'POST' && req.url === '/api/conv/save') {
    const b = await readBody(req);
    saveConversation(b);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === 'POST' && req.url === '/api/conv/delete') {
    const b = await readBody(req);
    const ok = deleteConversation((b && b.id) || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok }));
  }
  if (req.method === 'POST' && req.url === '/api/newsession') {
    state.started = false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === 'GET' && req.url === '/api/shutdown') {
    res.writeHead(200); res.end('bye');
    setTimeout(() => process.exit(0), 200);
    return;
  }
  serveStatic(req, res);
});

let bindTries = 0;
function startListen() {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`HanstlerS escuchando en http://127.0.0.1:${PORT}`);
  });
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && bindTries < 5) {
    bindTries++;
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/shutdown', timeout: 1500 }, () => {});
    req.on('error', () => {});
    setTimeout(() => {
      try { server.close(); } catch (e) {}
      startListen();
    }, 900);
  } else if (err && err.code !== 'EADDRINUSE') {
    console.error('Error del servidor:', err && err.message);
  }
});

startListen();
