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

let state = {
  cwd: process.env.HANSTLERS_CWD || process.env.USERPROFILE || os.homedir(),
  started: false,
  model: process.env.HANSTLERS_MODEL || 'claude-haiku-4.5'
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
function buildArgs(message, useContinue) {
  const a = ['-p', message, '--allow-all-tools'];
  const s = SUPPORTED || {};
  if (s.model && state.model && state.model !== 'auto') { a.push('--model', state.model); }
  if (s.silent) a.push('--silent');
  if (s.noBanner) a.push('--no-banner');
  if (s.noAutoUpdate) a.push('--no-auto-update');
  if (s.noRemote) a.push('--no-remote');
  if (s.disableBuiltinMcps) a.push('--disable-builtin-mcps');
  if (s.noAskUser) a.push('--no-ask-user');
  if (useContinue) a.push('--continue');
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
  const message = (body.message || '').trim();
  if (!message) { res.writeHead(400); return res.end('empty'); }
  detectFlags(() => handleChatInner(req, res, message));
}

function handleChatInner(req, res, message) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  function launch(useContinue) {
    const a = buildArgs(message, useContinue);
    // En Windows: invocar via cmd.exe con shell:false para que Node entrecomille
    // correctamente cada argumento (evita "Invalid command format" con espacios).
    if (process.platform === 'win32') {
      return spawn('cmd.exe', ['/d', '/s', '/c', COPILOT_CMD].concat(a), { cwd: state.cwd, env: process.env });
    }
    return spawn(COPILOT_CMD, a, { cwd: state.cwd, env: process.env });
  }

  let child;
  try {
    child = launch(state.started);
  } catch (e) {
    send('error', 'No se pudo iniciar copilot: ' + e.message);
    return res.end();
  }

  let gotOutput = false;
  const filter = makeLineFilter((clean) => { gotOutput = true; send('chunk', clean); });

  child.stdout.on('data', (d) => { filter.push(stripAnsi(d.toString())); });
  child.stderr.on('data', (d) => { filter.push(stripAnsi(d.toString())); });
  child.on('error', (e) => { send('error', 'Error al ejecutar copilot: ' + e.message); res.end(); });
  child.on('close', (code) => {
    if (code !== 0 && state.started && !gotOutput) {
      state.started = false;
      const retry = launch(false);
      const rf = makeLineFilter((clean) => send('chunk', clean));
      retry.stdout.on('data', (d) => rf.push(stripAnsi(d.toString())));
      retry.stderr.on('data', (d) => rf.push(stripAnsi(d.toString())));
      retry.on('close', () => { rf.flush(); state.started = true; send('done', { code: 0 }); res.end(); });
      return;
    }
    filter.flush();
    state.started = true;
    send('done', { code });
    res.end();
  });

  req.on('close', () => { try { child.kill(); } catch (e) {} });
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
        { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5 (más rápido)' },
        { id: 'gpt-5-mini', name: 'GPT-5 mini (rápido)' },
        { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash (rápido)' },
        { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5 (equilibrado)' },
        { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (equilibrado)' },
        { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex (código)' },
        { id: 'gpt-5.4', name: 'GPT-5.4 (potente)' },
        { id: 'gpt-5.5', name: 'GPT-5.5 (potente)' },
        { id: 'gemini-3-pro', name: 'Gemini 3 Pro (potente)' },
        { id: 'claude-opus-4.5', name: 'Claude Opus 4.5 (máxima calidad)' },
        { id: 'claude-opus-4.8', name: 'Claude Opus 4.8 (máxima calidad)' },
        { id: 'auto', name: 'Automático' },
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
