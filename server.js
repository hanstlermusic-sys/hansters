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
  started: false
};

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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const baseArgs = ['-p', message, '--allow-all-tools'];

  function launch(useContinue) {
    const a = useContinue ? baseArgs.concat('--continue') : baseArgs.slice();
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
  child.stdout.on('data', (d) => { gotOutput = true; send('chunk', stripAnsi(d.toString())); });
  child.stderr.on('data', (d) => { send('chunk', stripAnsi(d.toString())); });
  child.on('error', (e) => { send('error', 'Error al ejecutar copilot: ' + e.message); res.end(); });
  child.on('close', (code) => {
    if (code !== 0 && state.started && !gotOutput) {
      state.started = false;
      const retry = launch(false);
      retry.stdout.on('data', (d) => send('chunk', stripAnsi(d.toString())));
      retry.stderr.on('data', (d) => send('chunk', stripAnsi(d.toString())));
      retry.on('close', () => { state.started = true; send('done', { code: 0 }); res.end(); });
      return;
    }
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
    return res.end(JSON.stringify({ cwd: state.cwd }));
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
