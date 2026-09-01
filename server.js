'use strict';
// HanstlerS - servidor local que envuelve el GitHub Copilot CLI en una app de chat.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

// AHORRO DE TOKENS: salidas de herramientas grandes van a archivo (el modelo ve
// solo una vista previa), reduciendo el contexto por turno. Ajustable por env.
if (!process.env.COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES) {
  process.env.COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES = '4096';
}

const PORT = process.env.HANSTLERS_PORT ? Number(process.env.HANSTLERS_PORT) : 8717;
const COPILOT_CMD = process.env.HANSTLERS_CMD || 'copilot';
const PUBLIC = path.join(__dirname, 'public');
const https = require('https');

// Config de Azure OpenAI (BYOK). Si existe, aparece como modelo en el selector.
const AZURE_FILE = path.join(os.homedir(), '.hanstlers', 'azure.json');
function loadAzure() {
  try { const c = JSON.parse(fs.readFileSync(AZURE_FILE, 'utf8')); if (c && c.endpoint && c.key && c.deployment) return c; } catch (e) {}
  return null;
}

// Config de Azure Speech (para dictado por voz).
const SPEECH_FILE = path.join(os.homedir(), '.hanstlers', 'speech.json');
function loadSpeech() {
  try { const c = JSON.parse(fs.readFileSync(SPEECH_FILE, 'utf8')); if (c && c.key && c.region) return c; } catch (e) {}
  return null;
}

// ===== WHISPER LOCAL (offline, sin nube): whisper.cpp =====
// Binario empaquetado junto a la app; modelo en ~/.hanstlers/whisper (se descarga la 1ª vez).
const WHISPER_DIR = path.join(os.homedir(), '.hanstlers', 'whisper');
const WHISPER_MODEL_NAME = 'ggml-base.bin';
const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
function whisperCliPath() {
  // Buscar whisper-cli.exe empaquetado en varias ubicaciones posibles.
  const cands = [
    process.env.HANSTLERS_WHISPER_CLI,
    path.join(__dirname, 'whisper', 'whisper-cli.exe'),
    path.join(__dirname, 'vendor', 'whisper', 'dist', 'whisper-cli.exe'),
    path.join(process.resourcesPath || '', 'whisper', 'whisper-cli.exe')
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}
function whisperModelPath() {
  const cands = [
    path.join(WHISPER_DIR, WHISPER_MODEL_NAME),
    path.join(__dirname, 'whisper', 'models', WHISPER_MODEL_NAME),
    path.join(__dirname, 'vendor', 'whisper', 'models', WHISPER_MODEL_NAME)
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}
function whisperAvailable() { return !!whisperCliPath(); }

// Limpia el texto de whisper: quita tokens de ruido y alucinaciones típicas en silencio.
function cleanTranscript(t) {
  if (!t) return '';
  let s = String(t).replace(/\r/g, '').split('\n').map(x => x.trim()).filter(Boolean).join(' ').trim();
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\*[^*]*\*/g, ' ');
  s = s.replace(/\((?:m[uú]sica|risas|aplausos|silencio|ruido|sonido[^)]*)\)/gi, ' ');
  const junk = [
    /subt[ií]tulos?[^.]*amara\.org/gi,
    /subt[ií]tulos?\s+realizados?\s+por[^.]*/gi,
    /gracias por ver[^.]*/gi,
    /www\.[^\s]+/gi
  ];
  for (const j of junk) s = s.replace(j, ' ');
  return s.replace(/\s{2,}/g, ' ').trim();
}

let whisperDownloading = false;
function ensureWhisperModel(cb) {
  const existing = whisperModelPath();
  if (existing) return cb(null, existing);
  if (whisperDownloading) return cb(new Error('El modelo de voz se está descargando, intenta en unos segundos.'));
  whisperDownloading = true;
  try { fs.mkdirSync(WHISPER_DIR, { recursive: true }); } catch (e) {}
  const dest = path.join(WHISPER_DIR, WHISPER_MODEL_NAME);
  const tmp = dest + '.part';
  const file = fs.createWriteStream(tmp);
  const get = (url) => {
    https.get(url, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) { resp.resume(); return get(resp.headers.location); }
      if (resp.statusCode !== 200) { whisperDownloading = false; file.close(); try { fs.unlinkSync(tmp); } catch (e) {} return cb(new Error('Descarga del modelo falló: ' + resp.statusCode)); }
      resp.pipe(file);
      file.on('finish', () => { file.close(() => { try { fs.renameSync(tmp, dest); } catch (e) {} whisperDownloading = false; cb(null, dest); }); });
    }).on('error', (e) => { whisperDownloading = false; try { fs.unlinkSync(tmp); } catch (_) {} cb(e); });
  };
  get(WHISPER_MODEL_URL);
}

// Transcribe un WAV (16kHz mono PCM) con whisper.cpp local y devuelve el texto.
function transcribeLocal(wavBuffer, cb) {
  const cli = whisperCliPath();
  if (!cli) return cb(new Error('Whisper local no disponible'));
  ensureWhisperModel((err, model) => {
    if (err) return cb(err);
    let tmp;
    try {
      tmp = path.join(os.tmpdir(), 'hs_whisper_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.wav');
      fs.writeFileSync(tmp, wavBuffer);
    } catch (e) { return cb(e); }
    const args = ['-m', model, '-f', tmp, '-l', 'es', '-nt', '-np', '-t', String(Math.max(2, Math.min(8, (os.cpus() || []).length || 4)))];
    const child = spawn(cli, args, { cwd: path.dirname(cli) });
    let out = '', errOut = '';
    let finished = false;
    const done = (e, txt) => { if (finished) return; finished = true; try { clearTimeout(timer); } catch (_) {} try { fs.unlinkSync(tmp); } catch (_) {} cb(e, txt); };
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} done(new Error('Transcripción local excedió el tiempo')); }, 120000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (errOut += d));
    child.on('close', () => {
      const text = cleanTranscript(out);
      if (!text && errOut && !out.trim()) return done(new Error('Whisper: ' + errOut.slice(-150)));
      done(null, text);
    });
    child.on('error', (e) => done(e));
  });
}


function transcribeSpeech(audioBuffer, contentType, cb) {
  const cfg = loadSpeech();
  if (!cfg) return cb(new Error('Azure Speech no configurado'));
  const host = cfg.region + '.stt.speech.microsoft.com';
  const pathUrl = '/speech/recognition/conversation/cognitiveservices/v1?language=es-ES';
  const req = https.request({
    hostname: host, path: pathUrl, method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': cfg.key,
      'Content-Type': contentType || 'audio/wav; codecs=audio/pcm; samplerate=16000',
      'Accept': 'application/json'
    }
  }, (resp) => {
    let body = '';
    resp.on('data', (d) => (body += d));
    resp.on('end', () => {
      try {
        const j = JSON.parse(body);
        cb(null, (j.DisplayText || j.NBest && j.NBest[0] && j.NBest[0].Display || '').trim());
      } catch (e) { cb(new Error('Respuesta inválida: ' + body.slice(0, 150))); }
    });
  });
  req.on('error', (e) => cb(e));
  req.write(audioBuffer);
  req.end();
}

// Genera audio (TTS) con Azure Speech y devuelve el buffer MP3.
function synthSpeech(text, cb) {
  const cfg = loadSpeech();
  if (!cfg) return cb(new Error('Azure Speech no configurado'));
  const host = cfg.region + '.tts.speech.microsoft.com';
  const voice = cfg.voice || 'es-ES-ElviraNeural';
  const safe = String(text).slice(0, 3000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ssml = `<speak version='1.0' xml:lang='es-ES'><voice xml:lang='es-ES' name='${voice}'>${safe}</voice></speak>`;
  const req = https.request({
    hostname: host, path: '/cognitiveservices/v1', method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': cfg.key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'HanstlerS'
    }
  }, (resp) => {
    if (resp.statusCode >= 400) { let e = ''; resp.on('data', d => e += d); resp.on('end', () => cb(new Error('TTS ' + resp.statusCode))); return; }
    const chunks = [];
    resp.on('data', (d) => chunks.push(d));
    resp.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  req.on('error', (e) => cb(e));
  req.write(ssml);
  req.end();
}

function runAzure(message, history, send, onDone, onAbort, images) {
  const cfg = loadAzure();
  if (!cfg) { send('error', 'Azure no está configurado.'); return onDone(1); }
  const ep = cfg.endpoint.replace(/\/$/, '');
  const url = new URL(ep + '/openai/deployments/' + cfg.deployment + '/chat/completions?api-version=' + (cfg.apiVersion || '2024-10-21'));
  const messages = [];
  messages.push({ role: 'system', content: 'Eres HanstlerS, asistente personal de Cesar. Responde en español, conciso y directo.' });
  (history || []).forEach((m) => messages.push(m));
  // Si hay imágenes, el mensaje del usuario va como contenido multimodal (texto + imágenes).
  if (images && images.length) {
    const content = [{ type: 'text', text: message || '¿Qué ves en esta imagen?' }];
    images.forEach((im) => content.push({ type: 'image_url', image_url: { url: im } }));
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: message });
  }
  const payload = JSON.stringify({ messages, stream: true });
  const req = https.request({
    hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': cfg.key, 'Content-Length': Buffer.byteLength(payload) }
  }, (resp) => {
    if (resp.statusCode >= 400) {
      let err = '';
      resp.on('data', (d) => (err += d));
      resp.on('end', () => { send('error', 'Azure ' + resp.statusCode + ': ' + err.slice(0, 200)); onDone(1); });
      return;
    }
    let buf = '';
    resp.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        try { const j = JSON.parse(data); const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content; if (delta) send('chunk', delta); } catch (e) {}
      }
    });
    resp.on('end', () => onDone(0));
  });
  req.on('error', (e) => { send('error', 'Azure error: ' + e.message); onDone(1); });
  if (onAbort) onAbort(() => { try { req.destroy(); } catch (e) {} });
  req.write(payload);
  req.end();
}

// ===== MODO AGENTE sobre Azure: el modelo usa herramientas (archivos/comandos) =====
const AGENT_TOOLS = [
  { type: 'function', function: { name: 'list_dir', description: 'Lista archivos y carpetas de un directorio', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta (por defecto la carpeta de trabajo)' } } } } },
  { type: 'function', function: { name: 'read_file', description: 'Lee el contenido de un archivo de texto', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Crea o sobrescribe un archivo con contenido', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'apply_patch', description: 'Edita un trozo de un archivo existente: reemplaza la primera aparición de un texto por otro (más rápido y barato que reescribir todo). Usa esto para cambios pequeños.', parameters: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string', description: 'Texto exacto a buscar (incluye contexto suficiente para que sea único)' }, replace: { type: 'string', description: 'Texto nuevo que lo reemplaza' } }, required: ['path', 'find', 'replace'] } } },
  { type: 'function', function: { name: 'search_in_files', description: 'Busca un texto o patrón en todos los archivos del proyecto y devuelve las coincidencias con archivo y número de línea', parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string', description: 'Carpeta donde buscar (por defecto la de trabajo)' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'delete_file', description: 'Borra un archivo o carpeta (acción destructiva; se pedirá confirmación al usuario)', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'move_file', description: 'Mueve o renombra un archivo o carpeta', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Ejecuta un comando de PowerShell en la carpeta de trabajo y devuelve la salida', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }
];

function resolveInCwd(p) {
  if (!p) return state.cwd;
  return path.isAbsolute(p) ? p : path.join(state.cwd, p);
}

function execAgentTool(name, args, cb) {
  try {
    if (name === 'list_dir') {
      const dir = resolveInCwd(args.path);
      const items = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200).map(e => (e.isDirectory() ? '[dir] ' : '') + e.name);
      return cb(items.join('\n') || '(vacío)', items.length + ' elementos');
    }
    if (name === 'read_file') {
      const f = resolveInCwd(args.path);
      const data = fs.readFileSync(f, 'utf8');
      return cb(data.slice(0, 20000), data.split('\n').length + ' líneas');
    }
    if (name === 'write_file') {
      const f = resolveInCwd(args.path);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, args.content || '');
      return cb('Archivo escrito: ' + f, Math.max(1, Math.round(Buffer.byteLength(args.content || '') / 1024)) + ' KB');
    }
    if (name === 'apply_patch') {
      const f = resolveInCwd(args.path);
      if (!fs.existsSync(f)) return cb('Error: el archivo no existe: ' + f, 'no existe');
      const orig = fs.readFileSync(f, 'utf8');
      const find = String(args.find || '');
      if (!find) return cb('Error: "find" vacío', 'error');
      const idx = orig.indexOf(find);
      if (idx === -1) return cb('Error: no se encontró el texto a reemplazar. Lee el archivo de nuevo y copia el fragmento exacto.', 'no encontrado');
      const updated = orig.slice(0, idx) + String(args.replace || '') + orig.slice(idx + find.length);
      fs.writeFileSync(f, updated);
      const before = orig.slice(0, idx).split('\n').length;
      return cb('Parche aplicado en ' + f + ' (línea ~' + before + ')', 'editado línea ~' + before);
    }
    if (name === 'search_in_files') {
      const root = resolveInCwd(args.path);
      const q = String(args.query || '');
      if (!q) return cb('Error: consulta vacía', 'error');
      const skip = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', 'vendor']);
      const results = [];
      const ql = q.toLowerCase();
      const walk = (dir, depth) => {
        if (depth > 6 || results.length >= 100) return;
        let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
          if (results.length >= 100) break;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { if (!skip.has(e.name)) walk(full, depth + 1); continue; }
          if (e.size > 2 * 1024 * 1024) continue;
          let content; try { content = fs.readFileSync(full, 'utf8'); } catch (e2) { continue; }
          if (content.indexOf('\u0000') !== -1) continue; // binario
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().indexOf(ql) !== -1) {
              results.push(path.relative(state.cwd, full) + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 160));
              if (results.length >= 100) break;
            }
          }
        }
      };
      walk(root, 0);
      return cb(results.length ? results.join('\n') : '(sin coincidencias)', results.length + ' coincidencias');
    }
    if (name === 'delete_file') {
      const f = resolveInCwd(args.path);
      if (!fs.existsSync(f)) return cb('Error: no existe: ' + f, 'no existe');
      fs.rmSync(f, { recursive: true, force: true });
      return cb('Borrado: ' + f, 'borrado');
    }
    if (name === 'move_file') {
      const from = resolveInCwd(args.from);
      const to = resolveInCwd(args.to);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return cb('Movido: ' + from + ' → ' + to, 'movido');
    }
    if (name === 'run_command') {
      // Neutralizar patrones que cuelgan la consola en modo automático (no interactivo).
      let cmd = String(args.command || '');
      cmd = cmd.replace(/(^|\s)-NoExit\b/gi, ' ').replace(/(^|\s)\/k\b/gi, ' ');
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { cwd: state.cwd });
      let out = '';
      let finished = false;
      const done = (txt, summary) => { if (finished) return; finished = true; try { clearTimeout(timer); } catch (e) {} cb(txt, summary); };
      const timer = setTimeout(() => { try { child.kill(); } catch (e) {} done('(cancelado: el comando superó 60s. Evita comandos interactivos o que abran ventanas persistentes.)\n' + out.slice(0, 8000), 'cancelado (>60s)'); }, 60000);
      try { child.stdin.end(); } catch (e) {}
      child.stdout.on('data', d => (out += d));
      child.stderr.on('data', d => (out += d));
      child.on('close', (code) => done('(exit ' + code + ')\n' + out.slice(0, 8000), 'exit ' + code));
      child.on('error', e => done('Error: ' + e.message, 'error'));
      return;
    }
    cb('Herramienta desconocida: ' + name);
  } catch (e) { cb('Error: ' + e.message); }
}

function azureChat(cfg, messages, tools, cb) {
  const ep = cfg.endpoint.replace(/\/$/, '');
  const u = new URL(ep + '/openai/deployments/' + cfg.deployment + '/chat/completions?api-version=' + (cfg.apiVersion || '2024-10-21'));
  const body = { messages }; if (tools) body.tools = tools;
  const payload = JSON.stringify(body);
  const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': cfg.key, 'Content-Length': Buffer.byteLength(payload) } },
    (resp) => { let d = ''; resp.on('data', c => (d += c)); resp.on('end', () => {
      let j; try { j = JSON.parse(d); } catch (e) { return cb(new Error('Azure ' + resp.statusCode + ': ' + d.slice(0, 200))); }
      if (j && j.error) return cb(new Error(j.error.message || JSON.stringify(j.error).slice(0, 200)));
      cb(null, j);
    }); });
  req.on('error', e => cb(e));
  req.write(payload); req.end();
}

// Confirmaciones pendientes de comandos peligrosos: id -> resolve(boolean)
const pendingConfirms = {};
// Detecta si una acción es destructiva y merece confirmación del usuario.
function dangerReason(name, args) {
  if (name === 'delete_file') return 'Borrar ' + (args.path || '');
  if (name === 'run_command') {
    const c = String(args.command || '');
    if (/\bremove-item\b[\s\S]*(-recurse|-force)|\brm\b\s+-[rf]|\brmdir\b|\bdel\b\s|\bformat\b|\bformat-volume\b|\bclear-disk\b/i.test(c)) return 'Comando destructivo: ' + c.slice(0, 120);
    if (/\bgit\b\s+reset\s+--hard|\bgit\b\s+clean\s+-[a-z]*f|\bgit\b\s+push\s+.*--force/i.test(c)) return 'Git destructivo: ' + c.slice(0, 120);
    if (/\bshutdown\b|\brestart-computer\b|\bstop-computer\b/i.test(c)) return 'Apagar/reiniciar el equipo';
  }
  return null;
}

// ===== Contexto persistente del agente =====
// El transcript COMPLETO (incluidos los mensajes role:'tool' con el contenido real de
// lo que el agente leyo o ejecuto) vive AQUI, en el servidor, indexado por conversacion.
// Antes el contexto se rearmaba en el cliente raspando el HTML de las burbujas, lo que
// descartaba toda llamada a herramienta y su resultado: en el turno siguiente el modelo
// sabia QUE habia leido un archivo pero no QUE decia, y volvia a leerlo una y otra vez.
const AGENT_CTX_MAX_CHARS = 200000;

// El transcript tambien va a DISCO. Sin esto vivia solo en memoria y bastaba con
// cerrar la app para que el agente olvidara por completo el hilo de trabajo.
// Carpeta aparte de 'conversations' a proposito: listConversations() lee todo *.json
// de ahi y tomaria estos archivos por conversaciones.
const AGENT_DIR = path.join(os.homedir(), '.hanstlers', 'agent');
function agentFile(id) { return path.join(AGENT_DIR, String(id).replace(/[^a-z0-9_-]/gi, '') + '.json'); }
function saveAgentTranscript(convId, msgs) {
  if (!convId) return;
  try {
    fs.mkdirSync(AGENT_DIR, { recursive: true });
    fs.writeFileSync(agentFile(convId), JSON.stringify(msgs));
  } catch (e) {}
}
function loadAgentTranscript(convId) {
  if (!convId) return null;
  try {
    const m = JSON.parse(fs.readFileSync(agentFile(convId), 'utf8'));
    return (Array.isArray(m) && m.length) ? m : null;
  } catch (e) { return null; }
}
function deleteAgentTranscript(convId) { try { fs.unlinkSync(agentFile(convId)); } catch (e) {} }

function msgSize(m) { try { return JSON.stringify(m).length; } catch (e) { return 0; } }

// Recorta el transcript por el principio conservando siempre el system prompt.
// Nunca deja un mensaje role:'tool' huerfano al frente: la API devuelve 400 si un
// mensaje 'tool' no va precedido del 'assistant' que lo solicito.
function trimAgentMessages(msgs, maxChars) {
  if (!Array.isArray(msgs) || msgs.length < 2) return Array.isArray(msgs) ? msgs : [];
  const limit = maxChars || AGENT_CTX_MAX_CHARS;
  const sys = msgs[0];
  const rest = msgs.slice(1);
  let total = msgSize(sys);
  for (let i = 0; i < rest.length; i++) total += msgSize(rest[i]);
  let cut = 0;
  while (cut < rest.length && total > limit) { total -= msgSize(rest[cut]); cut++; }
  while (cut < rest.length && rest[cut] && rest[cut].role === 'tool') cut++;
  if (cut === 0) return msgs;
  return [sys].concat(rest.slice(cut));
}

// Reanuda el transcript guardado de esta conversacion; si no hay, arranca uno nuevo
// con el historial que mando el cliente.
function buildAgentMessages(convId, history, systemMsg) {
  state.convAgentMessages = state.convAgentMessages || {};
  let prior = convId ? state.convAgentMessages[convId] : null;
  // Respaldo en disco: cubre el caso de haber reiniciado la app a mitad de un trabajo.
  if (!(Array.isArray(prior) && prior.length)) prior = loadAgentTranscript(convId);
  if (Array.isArray(prior) && prior.length) {
    const m = prior.slice();
    m[0] = systemMsg; // refrescar el system prompt: la carpeta de trabajo pudo cambiar
    return m;
  }
  const m = [systemMsg];
  (history || []).forEach((h) => m.push(h));
  return m;
}

// El modelo suele ANUNCIAR lo que hara y devolver el turno sin llamar a ninguna
// herramienta ("Voy a revisar los archivos..."). El bucle lo tomaba por respuesta final
// y cerraba el trabajo ahi: de ahi los "jobs muy cortos que nunca ejecutan nada".
const ANNOUNCE_RE = /(voy a |vamos a |procedo a |procedere|ahora (voy|procedo|revis|le|cre|ejecut|busc)|dejame |permiteme |empezare|empiezo por|comenzare|primero (voy|le|revis)|a continuacion (voy|le)|revisare|leere|creare|escribire|ejecutare|buscare|manos a la obra|I'll |let me |I will |I'm going to |next,? I)/i;

function runAzureAgent(message, history, send, onDone, onAbort, images, convId) {
  const cfg = loadAzure();
  if (!cfg) { send('error', 'Azure no configurado'); return onDone(1); }
  let aborted = false;
  if (onAbort) onAbort(() => { aborted = true; });
  const systemMsg =
    { role: 'system', content: 'Eres HanstlerS, asistente de Cesar en modo AGENTE. Estás en Windows (PowerShell), carpeta de trabajo: ' + state.cwd + '. Usa las herramientas para leer/crear archivos y ejecutar comandos y COMPLETAR la tarea tú mismo (no solo expliques). SÉ DECIDIDO Y AUTÓNOMO: si la intención está clara, ACTÚA de inmediato sin pedir permiso ni confirmación. NO preguntes "¿quieres que...?", "¿procedo?", "¿te gustaría?": simplemente hazlo y muestra el resultado. Toma decisiones razonables por tu cuenta (nombres de archivo, estructura, enfoque) en lugar de consultar. Solo detente a preguntar si de verdad falta un dato imprescindible que no puedes deducir del contexto ni de los archivos (por ejemplo una credencial secreta), o si la acción es claramente destructiva e irreversible (borrar muchos archivos, formatear). En cualquier otro caso, procede hasta terminar. EFICIENCIA: cuando necesites leer o crear varios archivos, pide TODAS las herramientas a la vez en el mismo turno (varias tool_calls en paralelo) en lugar de una por una. No releas un archivo que ya leíste. Prioriza hacer los cambios (write_file) cuanto antes. Al usar run_command, NUNCA uses comandos interactivos ni que dejen una ventana/consola abierta (nada de -NoExit, Read-Host, pause, o abrir la app en primer plano); usa siempre modo no interactivo con parámetros. Responde en español, conciso. Cuando termines, resume lo que hiciste.' }
  ;
  const messages = buildAgentMessages(convId, history, systemMsg);
  if (images && images.length) {
    const content = [{ type: 'text', text: message }];
    images.forEach((im) => content.push({ type: 'image_url', image_url: { url: im } }));
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: message });
  }

  let steps = 0;
  let nudges = 0;
  let toolsUsed = 0;
  const MAX_STEPS = 40;
  const MAX_NUDGES = 2;
  const saveTranscript = () => {
    if (!convId) return;
    state.convAgentMessages = state.convAgentMessages || {};
    const trimmed = trimAgentMessages(messages, AGENT_CTX_MAX_CHARS);
    state.convAgentMessages[convId] = trimmed;
    saveAgentTranscript(convId, trimmed);
  };
  const iconOf = (n) => ({ list_dir: '📂', read_file: '📄', write_file: '✍️', apply_patch: '🩹', search_in_files: '🔎', delete_file: '🗑️', move_file: '📦', run_command: '⚙️' }[n] || '🔧');
  // Ejecuta una herramienta, pidiendo confirmación si es peligrosa.
  function runToolGated(tc, args, whenDone) {
    const reason = dangerReason(tc.function.name, args);
    if (!reason) {
      return execAgentTool(tc.function.name, args, (result, summary) => whenDone(result, summary));
    }
    // Pedir confirmación al usuario y esperar su decisión.
    const cid = 'cf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    send('status', 'Esperando tu confirmación…');
    send('confirm', { id: cid, reason: reason, tool: tc.function.name });
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; delete pendingConfirms[cid]; whenDone('Acción cancelada: el usuario no confirmó a tiempo.', 'sin confirmar'); } }, 120000);
    pendingConfirms[cid] = (approved) => {
      if (settled) return; settled = true; clearTimeout(timer); delete pendingConfirms[cid];
      if (approved) {
        send('chunk', ' ▶️ aprobado');
        execAgentTool(tc.function.name, args, (result, summary) => whenDone(result, summary));
      } else {
        send('chunk', ' ✋ rechazado por el usuario');
        whenDone('El usuario RECHAZÓ esta acción. No la ejecutes; busca otra forma o continúa con el resto de la tarea.', 'rechazado');
      }
    };
  }
  function loop() {
    if (aborted) { saveTranscript(); return onDone(1); }
    if (steps++ > MAX_STEPS) {
      send('status', 'Cerrando y resumiendo…');
      messages.push({ role: 'user', content: 'Has alcanzado el límite de pasos. Detente ahora: NO uses más herramientas. Resume en español lo que lograste, lo que quedó pendiente y cómo continuar.' });
      return azureChat(cfg, messages, null, (err, resp) => {
        send('status', '');
        if (!err) { const m = resp.choices && resp.choices[0] && resp.choices[0].message; if (m && m.content) send('chunk', '\n\n⏸️ ' + m.content); }
        else send('chunk', '\n\n(límite de pasos alcanzado)');
        send('canContinue', { reason: 'limite' });
        saveTranscript();
        onDone(0);
      });
    }
    // Indicador vivo mientras Azure "piensa" (evita sensación de colgado).
    send('status', 'Pensando… (paso ' + steps + '/' + MAX_STEPS + ')');
    azureChat(cfg, messages, AGENT_TOOLS, (err, resp) => {
      if (aborted) { send('status', ''); saveTranscript(); return onDone(1); }
      if (err) { send('status', ''); send('error', 'Azure: ' + err.message); return onDone(1); }
      const msg = resp.choices && resp.choices[0] && resp.choices[0].message;
      if (!msg) { send('status', ''); send('error', 'Respuesta vacía de Azure'); return onDone(1); }
      messages.push(msg);
      // Mostrar el PLAN/razonamiento del modelo si lo escribió antes de actuar.
      if (msg.content && msg.content.trim()) send('chunk', msg.content.trim() + '\n');
      if (msg.tool_calls && msg.tool_calls.length) {
        let pending = msg.tool_calls.length;
        send('status', 'Ejecutando ' + pending + (pending === 1 ? ' acción…' : ' acciones…'));
        msg.tool_calls.forEach((tc) => {
          let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
          const label = (args.path || args.command || '').toString();
          const shortLabel = label.length > 60 ? '…' + label.slice(-58) : label;
          send('chunk', '\n' + iconOf(tc.function.name) + ' ' + tc.function.name + '(' + shortLabel + ') …');
          runToolGated(tc, args, (result, summary) => {
            send('chunk', ' ✓' + (summary ? ' ' + summary : ''));
            toolsUsed++;
            messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 12000) });
            if (--pending === 0) { send('chunk', '\n'); loop(); }
          });
        });
      } else {
        const text = (msg.content || '').trim();
        // Si solo ANUNCIO una accion (o devolvio un turno vacio) sin ejecutar nada, el
        // trabajo NO ha terminado: empujalo a actuar en lugar de cerrar el job aqui.
        if (nudges < MAX_NUDGES && (!text || ANNOUNCE_RE.test(text))) {
          nudges++;
          messages.push({ role: 'user', content: 'No ejecutaste ninguna herramienta en este turno: solo anunciaste lo que ibas a hacer. Si la tarea NO esta terminada, HAZLA AHORA llamando a las herramientas en este mismo turno (no vuelvas a anunciarla). Si ya esta completamente terminada, responde solo con el resumen final, sin anunciar acciones futuras.' });
          send('status', 'Continuando...');
          return loop();
        }
        send('status', '');
        saveTranscript();
        onDone(0);
      }
    });
  }
  loop();
}

// ===== Auto-arranque con Windows (registry Run key) =====
const AUTOSTART_NAME = 'HanstlerS';
function autostartExe() {
  // En Electron empaquetado, HANSTLERS_EXE = ruta de HanstlerS.exe.
  return process.env.HANSTLERS_EXE || process.execPath;
}
function getAutostart(cb) {
  if (process.platform !== 'win32') return cb(false, false);
  const child = spawn('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', AUTOSTART_NAME]);
  let out = '';
  child.stdout.on('data', d => (out += d));
  child.on('close', () => cb(out.indexOf(AUTOSTART_NAME) !== -1, true));
  child.on('error', () => cb(false, true));
}
function setAutostart(enabled, cb) {
  if (process.platform !== 'win32') return cb(false, false);
  let child;
  if (enabled) {
    child = spawn('reg.exe', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', AUTOSTART_NAME, '/t', 'REG_SZ', '/d', '"' + autostartExe() + '"', '/f']);
  } else {
    child = spawn('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', AUTOSTART_NAME, '/f']);
  }
  child.on('close', (code) => cb(code === 0, enabled));
  child.on('error', () => cb(false, enabled));
}


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

// Localiza el binario nativo copilot.exe (para ejecutarlo DIRECTO, sin ventana negra).
let COPILOT_BIN = undefined;
function resolveCopilotBinary() {
  if (COPILOT_BIN !== undefined) return COPILOT_BIN;
  if (process.env.HANSTLERS_CMD) { COPILOT_BIN = null; return COPILOT_BIN; } // modo test
  const exe = process.platform === 'win32' ? 'copilot.exe' : 'copilot';
  const pkg = '@github/copilot-' + process.platform + '-' + process.arch;
  const roots = [];
  const loader = resolveLoader();
  if (loader) roots.push(path.dirname(loader));
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@github', 'copilot'));
  for (const r of roots) {
    const cand = path.join(r, 'node_modules', pkg, exe);
    try { if (fs.existsSync(cand)) { COPILOT_BIN = cand; return COPILOT_BIN; } } catch (e) {}
  }
  COPILOT_BIN = null;
  return COPILOT_BIN;
}

let state = {
  cwd: process.env.HANSTLERS_CWD || process.env.USERPROFILE || os.homedir(),
  started: false,
  model: process.env.HANSTLERS_MODEL || 'auto'
};

// Entorno para ejecutar node dentro de Electron: process.execPath es HanstlerS.exe,
// y ELECTRON_RUN_AS_NODE=1 lo obliga a comportarse como Node puro.
function nodeEnv() {
  return Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
}

// Detecta qué flags soporta la version instalada del CLI (una sola vez).
let SUPPORTED = null;
let detectPending = null;
function detectFlags(cb) {
  if (SUPPORTED) return cb(SUPPORTED);
  // Si ya hay una detección en curso (p.ej. el pre-calentamiento), engancharse a ella.
  if (detectPending) { detectPending.push(cb); return; }
  detectPending = [cb];
  const loader = resolveLoader();
  const bin = resolveCopilotBinary();
  // Preferir binario nativo directo (oculto). Respaldo: node+loader; luego cmd.
  const runner = bin
    ? spawn(bin, ['--help'], { env: process.env, windowsHide: true })
    : (loader
        ? spawn(process.execPath, [loader, '--help'], { env: nodeEnv(), windowsHide: true })
        : (process.platform === 'win32'
            ? spawn('cmd.exe', ['/d', '/s', '/c', COPILOT_CMD, '--help'], { env: process.env, windowsHide: true })
            : spawn(COPILOT_CMD, ['--help'], { env: process.env, windowsHide: true })));
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
      noAskUser: has('--no-ask-user'),
      effort: has('--effort') || has('--reasoning-effort'),
      maxAiCredits: has('--max-ai-credits')
    };
    const cbs = detectPending || []; detectPending = null;
    cbs.forEach((f) => { try { f(SUPPORTED); } catch (e) {} });
  };
  let finished = false;
  const finish = () => { if (!finished) { finished = true; done(); } };
  runner.stdout.on('data', (d) => (out += d.toString()));
  runner.stderr.on('data', (d) => (out += d.toString()));
  runner.on('close', finish);
  runner.on('error', finish);
  setTimeout(finish, 8000);
}

// Respaldo: obtener el id de la sesión más reciente del CLI desde disco.
function newestSessionId() {
  const bases = [
    path.join(os.homedir(), '.copilot', 'history'),
    path.join(os.homedir(), '.copilot', 'session-state'),
    path.join(os.homedir(), '.copilot', 'sessions')
  ];
  let best = null, bestMs = 0;
  for (const base of bases) {
    let entries = [];
    try { entries = fs.readdirSync(base); } catch (e) { continue; }
    for (const name of entries) {
      const id = name.replace(/\.(json|db|sqlite|log)$/i, '');
      if (!/^[a-f0-9-]{8,}$/i.test(id)) continue;
      try {
        const st = fs.statSync(path.join(base, name));
        if (st.mtimeMs > bestMs) { bestMs = st.mtimeMs; best = id; }
      } catch (e) {}
    }
  }
  return best;
}

// Construye los argumentos con las optimizaciones de velocidad soportadas.
function buildArgs(message, opts, withModel) {
  opts = opts || {};
  const a = ['-p', message, '--allow-all-tools'];
  const s = SUPPORTED || {};
  // El modelo puede venir por conversación (opts.model); si no, usa el global.
  const model = opts.model || state.model;
  if (withModel && s.model && model && model !== 'auto') { a.push('--model', model); }
  // Modo MÍNIMO: sin flags de optimización (para reintentar si algo los rechaza).
  // El modelo ya se añadió arriba; aquí solo se conserva la sesión.
  if (opts.minimal) {
    if (opts.sessionId) a.push('--resume=' + opts.sessionId);
    return a;
  }
  // Solo flags COSMÉTICOS/seguros que no afectan la salida del modelo.
  // (NO usar --silent ni --effort: pueden suprimir o vaciar la respuesta en algunos planes.)
  if (s.noBanner) a.push('--no-banner');
  if (s.noAutoUpdate) a.push('--no-auto-update');
  if (s.noAskUser) a.push('--no-ask-user');
  // Tope de créditos por respuesta (solo si el usuario lo pide explícitamente).
  if (s.maxAiCredits && process.env.HANSTLERS_MAX_CREDITS) a.push('--max-ai-credits=' + process.env.HANSTLERS_MAX_CREDITS);
  // Ahorro de razonamiento SOLO si se activa explícitamente por variable de entorno.
  if (s.effort && process.env.HANSTLERS_EFFORT) a.push('--effort=' + process.env.HANSTLERS_EFFORT);
  // Mantener el hilo: reanudar por id exacto de sesión de esta conversación.
  if (opts.sessionId) a.push('--resume=' + opts.sessionId);
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

// ===== Memoria global (persiste entre TODAS las conversaciones) =====
const MEM_FILE = path.join(os.homedir(), '.hanstlers', 'memory.json');
function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEM_FILE, 'utf8')); } catch (e) { return []; }
}
function saveMemory(list) {
  try { fs.mkdirSync(path.dirname(MEM_FILE), { recursive: true }); fs.writeFileSync(MEM_FILE, JSON.stringify(list)); } catch (e) {}
}
function addMemory(text) {
  text = (text || '').trim();
  if (!text) return null;
  const list = loadMemory();
  const item = { id: 'm' + Date.now() + Math.floor(Math.random() * 1000), text, at: Date.now() };
  list.push(item);
  saveMemory(list);
  return item;
}
// Detecta datos a recordar, de forma automática:
//  - órdenes explícitas: "recuerda que ...", "anota que ..."
//  - hechos declarativos duraderos sobre el usuario/proyectos
function detectMemory(message) {
  const notes = [];
  const explicit = /(?:^|\b)(?:recuerda|recu[eé]rdame|acu[eé]rdate|acu[eé]rdame|anota|guarda|ten en cuenta)(?:\s+que)?\s*[:,]?\s+([\s\S]{3,})/i.exec(message);
  if (explicit) notes.push(explicit[1].trim().replace(/^["“]|["”]$/g, ''));
  // Hechos declarativos (frases cortas), solo si el usuario no está preguntando.
  if (!/[?¿]/.test(message) && message.length < 200) {
    const decl = /(?:^|\b)((?:mi|mis|me llamo|soy|trabajo en|uso|prefiero|mi nombre es)\b[\s\S]{3,120})/i.exec(message);
    if (decl && !explicit) notes.push(decl[1].trim());
  }
  return notes;
}
function memoryContextBlock() {
  const list = loadMemory();
  if (!list.length) return '';
  const facts = list.map((x) => '- ' + x.text).join('\n');
  return 'Datos que debes recordar sobre el usuario y sus proyectos (memoria persistente):\n' + facts + '\n\n';
}

// ===== Cuota mensual (créditos del plan − gastado) =====
const USAGE_FILE = path.join(os.homedir(), '.hanstlers', 'usage.json');
const PLAN_CREDITS = { free: 0, pro: 1500, 'pro+': 7000, proplus: 7000, max: 20000 };
function monthKey() { const d = new Date(); return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1); }
function loadUsage() {
  let u = {};
  try { u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch (e) {}
  // Reinicio automático el día 1 de cada mes (UTC).
  if (u.month !== monthKey()) { u = { month: monthKey(), spent: 0, plan: u.plan || (process.env.HANSTLERS_PLAN || 'pro+') }; saveUsage(u); }
  if (typeof u.spent !== 'number') u.spent = 0;
  if (!u.plan) u.plan = process.env.HANSTLERS_PLAN || 'pro+';
  // Migración: el default histórico era 'pro'; ahora la cuenta es Pro+ (7000).
  // Solo actualiza si el usuario no fijó un plan distinto manualmente.
  if (u.plan === 'pro' && !u.planLocked) { u.plan = 'pro+'; saveUsage(u); }
  return u;
}
function saveUsage(u) {
  try { fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true }); fs.writeFileSync(USAGE_FILE, JSON.stringify(u)); } catch (e) {}
}
function addSpent(credits) {
  if (!(credits > 0)) return loadUsage();
  const u = loadUsage();
  u.spent = Math.round((u.spent + credits) * 100) / 100;
  saveUsage(u);
  return u;
}
function quotaInfo() {
  const u = loadUsage();
  const plan = (u.plan || 'pro+').toLowerCase();
  const total = PLAN_CREDITS[plan] !== undefined ? PLAN_CREDITS[plan] : 7000;
  const remaining = Math.max(0, Math.round((total - u.spent) * 100) / 100);
  return { plan, total, spent: u.spent, remaining, month: u.month };
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
  // Documentos de texto adjuntos: {name, text}. Se inyectan como contexto.
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length) {
    let block = '\n\n--- DOCUMENTOS ADJUNTOS ---\n';
    files.forEach((f) => {
      if (!f || !f.name) return;
      const txt = String(f.text || '').slice(0, 40000);
      block += '\n[Archivo: ' + f.name + ']\n' + txt + '\n';
    });
    message = (message || 'Analiza los documentos adjuntos.') + block;
  }
  if (!message) { res.writeHead(400); return res.end('empty'); }

  // Auto-capturar memoria: órdenes explícitas + hechos declarativos.
  let memNote = '';
  const facts = detectMemory((body.message || '').trim());
  if (facts.length) {
    const existing = loadMemory().map((x) => x.text.toLowerCase());
    for (const f of facts) {
      if (!existing.includes(f.toLowerCase())) { addMemory(f); memNote = f; }
    }
  }

  const sessionId = (body.sessionId || '').trim();
  const convId = (body.convId || '').trim();
  const model = (body.model || '').trim();

  // AHORRO DE TOKENS: inyectar la memoria SOLO cuando aporta valor:
  //  - primer mensaje de la conversación (aún no hay sesión que la contenga), o
  //  - el usuario pregunta/alude a la memoria ("recuerdas", "acuerdas", "sabes que"...).
  const asksMemory = /\b(recuerdas?|te acuerdas|acuerdas|sab[eí]as?|dijimos|hab[ií]amos|mencion[eé]|coment[eé])\b/i.test(body.message || '');
  const firstTurn = !sessionId;
  const mem = (firstTurn || asksMemory) ? memoryContextBlock() : '';
  const finalMessage = mem ? (mem + 'Mensaje del usuario:\n' + message) : message;

  // Imágenes para visión (Azure): pasamos las data URLs válidas tal cual.
  const visionImages = images.filter((im) => /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(im || '')).slice(0, 6);

  detectFlags(() => handleChatInner(req, res, finalMessage, sessionId, convId, model, memNote, Array.isArray(body.history) ? body.history : [], visionImages));
}

function handleChatInner(req, res, message, sessionId, convId, model, memNote, convHistory, visionImages) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  let ended = false;
  const send = (event, data) => { if (ended) return; try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} };
  res.on('close', () => { ended = true; });

  // Avisar al cliente que se guardó un dato en memoria (para mostrar chip discreto).
  if (memNote) send('memory', { text: memNote });

  const effModel = model || state.model;

  // RUTA AZURE (BYOK): si el modelo elegido es Azure, llamar directo a tu recurso.
  if (effModel === 'azure' || effModel === 'azure-gpt-5-mini') {
    let aborted = false;
    runAzure(
      message,
      Array.isArray(convHistory) ? convHistory : [],
      send,
      (code) => { if (!aborted) { send('done', { code }); } res.end(); },
      (killer) => { req.on('close', () => { aborted = true; killer(); }); },
      visionImages || []
    );
    return;
  }

  // RUTA AZURE AGENTE: modelo con herramientas (lee/escribe archivos, ejecuta comandos).
  if (effModel === 'azure-agent') {
    let agentDone = false;
    runAzureAgent(
      message,
      Array.isArray(convHistory) ? convHistory : [],
      send,
      (code) => { if (agentDone) return; agentDone = true; send('done', { code }); try { res.end(); } catch (e) {} },
      (killer) => { req.on('close', () => killer()); },
      visionImages || [],
      convId
    );
    return;
  }


  state.convSessions = state.convSessions || {};
  let effSession = sessionId || (convId ? state.convSessions[convId] : '') || '';

  function launchRaw(withModel, opts) {
    const a = buildArgs(message, opts, withModel);
    // PREFERIDO: ejecutar el binario nativo copilot.exe DIRECTO y OCULTO (sin ventana negra).
    const bin = resolveCopilotBinary();
    if (bin) {
      return spawn(bin, a, { cwd: state.cwd, env: process.env, windowsHide: true });
    }
    const loader = resolveLoader();
    if (loader) {
      // Respaldo: Electron ejecuta el loader como Node (ELECTRON_RUN_AS_NODE) — oculto.
      return spawn(process.execPath, [loader].concat(a), { cwd: state.cwd, env: nodeEnv(), windowsHide: true });
    }
    if (process.platform === 'win32') {
      return spawn('cmd.exe', ['/d', '/s', '/c', COPILOT_CMD].concat(a), { cwd: state.cwd, env: process.env, windowsHide: true });
    }
    return spawn(COPILOT_CMD, a, { cwd: state.cwd, env: process.env, windowsHide: true });
  }

  function attempt(withModel, opts, isRetry) {
    let child;
    try {
      child = launchRaw(withModel, opts);
    } catch (e) {
      send('error', 'No se pudo iniciar copilot: ' + e.message);
      return res.end();
    }

    let raw = '';
    let gotOutput = false;
    let sessionEmitted = false;
    const rememberSession = (id) => {
      if (id && convId) { state.convSessions = state.convSessions || {}; state.convSessions[convId] = id; }
    };
    const emitSession = (text) => {
      if (sessionEmitted) return;
      const m = /--resume=([a-f0-9-]{8,})/i.exec(text) || /session[ _-]?id["':\s]+([a-f0-9-]{8,})/i.exec(text);
      if (m) { sessionEmitted = true; rememberSession(m[1]); send('session', { id: m[1] }); }
    };
    const filter = makeLineFilter((clean) => { gotOutput = true; send('chunk', clean); });

    child.stdout.on('data', (d) => { const t = stripAnsi(d.toString()); raw += t; emitSession(raw); filter.push(t); });
    child.stderr.on('data', (d) => { const t = stripAnsi(d.toString()); raw += t; emitSession(raw); filter.push(t); });
    child.on('error', (e) => { send('error', 'Error al ejecutar copilot: ' + e.message); res.end(); });
    child.on('close', (code) => {
      const modelUnavailable = withModel && /model .*(is )?not available|not available.*--model|--model flag is not available/i.test(raw);
      if (modelUnavailable && !isRetry) {
        state.autoOnly = true;
        return attempt(false, opts, true);
      }
      // Si --resume falló (sesión inexistente), reintenta sin reanudar (conservando el modelo).
      if (code !== 0 && opts.sessionId && !gotOutput && !isRetry) {
        return attempt(withModel, { model: opts.model }, true);
      }
      filter.flush();
      emitSession(raw);
      // Respaldo: si no se detectó en la salida, buscar la sesión más reciente en disco.
      if (!sessionEmitted) {
        const id = newestSessionId();
        if (id) { rememberSession(id); send('session', { id }); }
      }
      // Si SIGUE sin haber salida, mostrar la salida cruda o un mensaje claro con el error.
      if (!gotOutput) {
        const rawClean = (raw || '').trim();
        if (rawClean) send('chunk', rawClean);
        else send('chunk', '⚠️ No hubo respuesta del modelo. Verifica que tu sesión de Copilot esté activa (abre "Iniciar sesión en Copilot") y que tu plan permita este modelo. Si acabas de comprar créditos, cierra y vuelve a abrir HanstlerS.');
      }
      // Medidor: extraer créditos AI de la salida del CLI y calcular lo que resta.
      const usage = {};
      const cr = /AI Credits\s+([\d.]+)/i.exec(raw);
      if (cr) usage.credits = parseFloat(cr[1]);
      const tk = /Tokens[\s\S]{0,40}?([\d.]+k?)\b/i.exec(raw);
      if (tk) usage.tokens = tk[1];
      if (usage.credits > 0) addSpent(usage.credits);
      usage.quota = quotaInfo();
      send('usage', usage);
      send('done', { code });
      res.end();
    });

    // Permitir detener la respuesta desde el cliente (cerrar el stream mata el proceso).
    req.on('close', () => { try { child.kill(); } catch (e) {} });
  }

  attempt(!state.autoOnly, { sessionId: effSession, model: effModel }, false);
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
  deleteAgentTranscript(id);
  try { delete (state.convAgentMessages || {})[id]; } catch (e) {}
  try { fs.unlinkSync(convFile(id)); return true; } catch (e) { return false; }
}

// ===== AUTODIAGNÓSTICO: prueba cada eslabón en la PC del usuario =====
function runDiagnostics(cb) {
  const result = { checks: [], ok: false };
  const add = (name, ok, detail) => result.checks.push({ name, ok, detail: (detail || '').toString().slice(0, 300) });

  // 1) Runtime (¿estamos en Electron?)
  const inElectron = !!process.versions.electron;
  add('Entorno', true, inElectron ? ('Electron ' + process.versions.electron) : ('Node ' + process.version));

  // 2) CLI de Copilot (binario directo o loader)
  const bin = resolveCopilotBinary();
  const loader = resolveLoader();
  add('CLI de Copilot instalado', !!(bin || loader), bin || loader || 'No se encontró Copilot. Instala con: npm install -g @github/copilot');
  if (!bin && !loader) { return cb(result); }

  // 3) Ejecutar el CLI (oculto) y probar respuesta real
  const dArgs = ['-p', 'responde solo con la palabra OK', '--allow-all-tools'];
  const child = bin
    ? spawn(bin, dArgs, { cwd: state.cwd, env: process.env, windowsHide: true })
    : spawn(process.execPath, [loader].concat(dArgs), { cwd: state.cwd, env: nodeEnv(), windowsHide: true });
  let out = '', err = '';
  let finished = false;
  const finish = () => {
    if (finished) return; finished = true; try { clearTimeout(t); } catch (e) {}
    const raw = (out + '\n' + err);
    const authFail = /No authentication information found|run the '\/login'|gh auth login/i.test(raw);
    const policyBlock = /Access denied by policy|disabled by your organization/i.test(raw);
    const gotText = /\bOK\b/i.test(out) || (out.trim().length > 0 && !authFail && !policyBlock);
    add('Ejecuta como Node', true, 'El binario ejecutó el CLI correctamente');
    if (policyBlock) add('Política de organización', false, 'BLOQUEADO por política. Revisa Settings de Copilot / organización.');
    else add('Política de organización', true, 'Sin bloqueo de política');
    if (authFail) add('Sesión de Copilot', false, 'NO hay sesión. Abre PowerShell, ejecuta: copilot  y luego /login');
    else add('Sesión de Copilot', true, 'Sesión activa');
    add('Respuesta del modelo', gotText, gotText ? ('Respondió: ' + out.trim().slice(0, 80)) : ('Vacío. ' + (raw.trim().slice(0, 200) || 'sin salida')));
    result.ok = !!loader && !policyBlock && !authFail && gotText;
    cb(result);
  };
  const t = setTimeout(() => { try { child.kill(); } catch (e) {} add('Tiempo', false, 'El CLI tardó demasiado (timeout 45s)'); finish(); }, 45000);
  child.stdout.on('data', d => (out += stripAnsi(d.toString())));
  child.stderr.on('data', d => (err += stripAnsi(d.toString())));
  child.on('close', finish);
  child.on('error', (e) => { add('Ejecuta como Node', false, 'No se pudo lanzar: ' + e.message); finish(); });
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
 try {
  if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res, await readBody(req));
  if (req.method === 'POST' && req.url === '/api/agent/confirm') {
    const b = await readBody(req);
    const fn = b && b.id && pendingConfirms[b.id];
    if (fn) { fn(!!b.approved); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
    res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'confirmación no encontrada o expirada' }));
  }
  if (req.method === 'GET' && req.url === '/api/pickfolder') return pickFolder(res);
  if (req.method === 'GET' && req.url === '/api/diagnose') {
    return runDiagnostics((result) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); });
  }
  if (req.method === 'GET' && req.url === '/api/speech/available') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ available: !!loadSpeech() || whisperAvailable(), azure: !!loadSpeech(), local: whisperAvailable(), localModelReady: !!whisperModelPath() }));
  }
  if (req.method === 'POST' && req.url === '/api/tts') {
    const b = await readBody(req);
    synthSpeech((b && b.text) || '', (err, audio) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: err.message })); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length });
      res.end(audio);
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/transcribe') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const audio = Buffer.concat(chunks);
      const ct = req.headers['content-type'] || 'audio/wav';
      // Motor: cabecera x-engine ('local'|'azure') o auto (local si está, si no Azure).
      const engine = (req.headers['x-engine'] || '').toString().toLowerCase();
      const useLocal = engine === 'local' || (engine !== 'azure' && whisperAvailable());
      const reply = (err, text) => {
        res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(err ? { error: err.message } : { text: text }));
      };
      if (useLocal && whisperAvailable()) {
        return transcribeLocal(audio, (err, text) => {
          if (err && loadSpeech()) return transcribeSpeech(audio, ct, reply); // fallback a Azure
          reply(err, text);
        });
      }
      transcribeSpeech(audio, ct, reply);
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/speech/download-model') {
    ensureWhisperModel((err, p) => {
      res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(err ? { error: err.message } : { ok: true, path: p }));
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ cwd: state.cwd, model: state.model, quota: quotaInfo() }));
  }
  if (req.method === 'GET' && req.url === '/api/quota') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(quotaInfo()));
  }
  if (req.method === 'POST' && req.url === '/api/plan') {
    const b = await readBody(req);
    if (b && b.plan) { const u = loadUsage(); u.plan = String(b.plan).toLowerCase(); u.planLocked = true; saveUsage(u); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(quotaInfo()));
  }
  if (req.method === 'GET' && req.url === '/api/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const models = [
      { id: 'auto', name: 'Automático (recomendado)' }
    ];
    if (loadAzure()) models.push({ id: 'azure', name: '⚡ Azure gpt-5-mini (tu cuota, barato)' });
    if (loadAzure()) models.push({ id: 'azure-agent', name: '🤖 Azure Agente (ejecuta archivos/comandos)' });
    models.push(
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
    );
    return res.end(JSON.stringify({ current: state.model, models }));
  }
  if (req.method === 'POST' && req.url === '/api/model') {
    const b = await readBody(req);
    if (b && b.model) { state.model = b.model; state.started = false; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, model: state.model }));
  }
  if (req.method === 'GET' && req.url === '/api/autostart') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return getAutostart((enabled, supported) => res.end(JSON.stringify({ enabled, supported })));
  }
  if (req.method === 'POST' && req.url === '/api/autostart') {
    const b = await readBody(req);
    return setAutostart(!!(b && b.enabled), (ok, enabled) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, enabled }));
    });
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
  if (req.method === 'POST' && req.url === '/api/conv/rename') {
    const b = await readBody(req);
    const c = getConversation((b && b.id) || '');
    if (c && b.title) { c.title = String(b.title).slice(0, 80); c.renamed = true; saveConversation(c); }
    res.writeHead(c ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: !!c }));
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
    // En modo Electron no matamos el proceso (Electron gestiona el ciclo de vida).
    if (!process.env.HANSTLERS_ELECTRON) setTimeout(() => process.exit(0), 200);
    return;
  }
  serveStatic(req, res);
 } catch (e) {
   try { console.error('Handler error:', e && e.message); } catch (_) {}
   try { if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Error interno: ' + (e && e.message) })); } else { res.end(); } } catch (_) {}
 }
});

let bindTries = 0;

// BLINDAJE: nunca dejar que un error no capturado tumbe la app.
process.on('uncaughtException', (err) => {
  try { console.error('uncaughtException:', err && err.stack || err); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try { console.error('unhandledRejection:', reason && reason.stack || reason); } catch (_) {}
});
function startListen() {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`HanstlerS escuchando en http://127.0.0.1:${PORT}`);
    // Pre-calentar la detección de flags en segundo plano para que el
    // PRIMER mensaje del usuario no pague el costo de `copilot --help`.
    setTimeout(() => { try { detectFlags(() => {}); } catch (e) {} }, 50);
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
