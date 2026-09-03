'use strict';
// HanstlerS - servidor local que envuelve el GitHub Copilot CLI en una app de chat.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const updater = require('./updater');
const modelWatch = require('./model-watch');

// Version instalada, para comparar contra la del repo en el actualizador.
const APP_VERSION = (function () {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8').replace(/^\uFEFF/, '')).version || '';
  } catch (e) { return ''; }
})();

// Se registra el hallazgo del vigia de modelos; la interfaz lo consulta y lo
// muestra. No se aplica solo salvo que el usuario active autoApply.
function onModelFinding(r) {
  try {
    const rec = r && r.recomendacion;
    if (!rec) return;
    console.log('[model-watch] hay un modelo mejor: ' + rec.de + ' -> ' + rec.a +
      ' (' + rec.msAntes + 'ms -> ' + rec.msDespues + 'ms)');
  } catch (e) {}
}

// Cierra HanstlerS cuando el actualizador ya dejo el instalador corriendo.// El script externo espera a que el proceso muera, instala y vuelve a abrir.
function quitForUpdate(j) {
  if (!j || !j.restarting) return;
  setTimeout(() => {
    try {
      if (process.env.HANSTLERS_ELECTRON) {
        const { app } = require('electron');
        app.quit();
        setTimeout(() => { try { process.exit(0); } catch (e) {} }, 4000);
        return;
      }
    } catch (e) {}
    try { process.exit(0); } catch (e) {}
  }, 1500);
}

// AHORRO DE TOKENS: salidas de herramientas grandes van a archivo (el modelo ve
// solo una vista previa), reduciendo el contexto por turno. Ajustable por env.
if (!process.env.COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES) {
  process.env.COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES = '4096';
}

const PORT = Number(process.env.HANSTLERS_PORT || process.env.PORT || 8717);
const HOST = (process.env.HANSTLERS_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1')).trim() || '127.0.0.1';
const COPILOT_CMD = process.env.HANSTLERS_CMD || 'copilot';
const PUBLIC = path.join(__dirname, 'public');
const https = require('https');
const GITHUB_QUOTA_DEFAULT_URL = 'https://github.com/settings/billing/ai_usage?period=3&group=7&customer=112329552&chart_selection=2&view=models';
const GITHUB_QUOTA_SYNC_FILE = path.join(os.homedir(), '.hanstlers', 'github-quota-sync.json');
const FEATURES_FILE = path.join(os.homedir(), '.hanstlers', 'features.json');
const GITHUB_CLIENT_ID = (process.env.GITHUB_CLIENT_ID || '').trim();
const GITHUB_CLIENT_SECRET = (process.env.GITHUB_CLIENT_SECRET || '').trim();
const SESSION_SECRET = (process.env.SESSION_SECRET || '').trim();
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const GITHUB_ALLOWED_ORG = (process.env.GITHUB_ALLOWED_ORG || '').trim().toLowerCase();
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const ADMIN_USERS = (process.env.ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// Config de Azure OpenAI (BYOK). Si existe, aparece como modelo en el selector.
const AZURE_FILE = path.join(os.homedir(), '.hanstlers', 'azure.json');
function loadAzure() {
  try { const c = JSON.parse(fs.readFileSync(AZURE_FILE, 'utf8')); if (c && c.endpoint && c.key && c.deployment) return c; } catch (e) {}
  return null;
}
const VERTEX_FILE = path.join(os.homedir(), '.hanstlers', 'vertex.json');

// Modelos por defecto. Google deja modelos RETIRADOS visibles en /v1beta/models
// aunque ya devuelvan 404, asi que la lista de la API no sirve para validar:
// hay que mantener a mano los que sabemos muertos.
const VERTEX_DEFAULT_PRO = 'gemini-3.8-flash';
const VERTEX_DEFAULT_FLASH = 'gemini-3.5-flash';
const VERTEX_DEFAULT_OPUS = 'claude-opus-5';
const GEMINI_RETIRADOS = new Set([
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
  'gemini-2.0-pro', 'gemini-2.0-flash',
  'gemini-1.5-pro', 'gemini-1.5-flash',
  'gemini-pro', 'gemini-flash'
]);
function normalizeVertexModel(kind, value) {
  const v = String(value || '').trim();
  const low = v.toLowerCase();
  if (!v) {
    if (kind === 'pro') return VERTEX_DEFAULT_PRO;
    if (kind === 'flash') return VERTEX_DEFAULT_FLASH;
    return VERTEX_DEFAULT_OPUS;
  }
  // Evita modelos legacy que hoy devuelven 404 aunque sigan listados.
  if (GEMINI_RETIRADOS.has(low)) {
    if (kind === 'flash') return VERTEX_DEFAULT_FLASH;
    if (kind === 'pro') return VERTEX_DEFAULT_PRO;
  }
  if (kind === 'opus' && low === 'claude-opus-4') return VERTEX_DEFAULT_OPUS;
  return v;
}
function loadVertex() {
  let fileCfg = {};
  try {
    let crudo = fs.readFileSync(VERTEX_FILE, 'utf8');
    // Un BOM invisible tumbaba JSON.parse y dejaba Vertex "sin configurar" en
    // silencio: el usuario elegia Gemini y le respondia otro modelo.
    if (crudo.charCodeAt(0) === 0xFEFF) crudo = crudo.slice(1);
    fileCfg = JSON.parse(crudo) || {};
  } catch (e) {}
  const projectId = String(process.env.GCP_PROJECT_ID || fileCfg.projectId || '').trim();
  const region = String(process.env.GCP_REGION || process.env.ANTHROPIC_VERTEX_REGION || fileCfg.region || 'us-central1').trim();
  let apiKey = String(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || fileCfg.apiKey || '').trim();
  if (/^pega_aqui_/i.test(apiKey) || /tu_google_api_key/i.test(apiKey)) apiKey = '';
  const hasProjectCfg = !!(projectId && region);
  const hasApiKey = !!apiKey;
  if (!hasProjectCfg && !hasApiKey) return null;
  const allowModelEnv = /^(1|true|yes|on)$/i.test(String(process.env.HANSTLERS_ALLOW_VERTEX_MODEL_ENV || '').trim());
  const modelProEnv = String(process.env.VERTEX_MODEL_PRO || '').trim();
  const modelFlashEnv = String(process.env.VERTEX_MODEL_FLASH || '').trim();
  const modelOpusEnv = String(process.env.VERTEX_MODEL_OPUS || '').trim();
  return {
    projectId,
    region,
    apiKey,
    models: {
      pro: normalizeVertexModel('pro', (allowModelEnv ? modelProEnv : '') || fileCfg.modelPro || VERTEX_DEFAULT_PRO),
      flash: normalizeVertexModel('flash', (allowModelEnv ? modelFlashEnv : '') || fileCfg.modelFlash || VERTEX_DEFAULT_FLASH),
      opus: normalizeVertexModel('opus', (allowModelEnv ? modelOpusEnv : '') || fileCfg.modelOpus || VERTEX_DEFAULT_OPUS)
    },
    authMode: hasProjectCfg ? 'adc' : 'api-key'
  };
}

// Config de Azure Speech (para dictado por voz).
const SPEECH_FILE = path.join(os.homedir(), '.hanstlers', 'speech.json');
function loadSpeech() {
  try { const c = JSON.parse(fs.readFileSync(SPEECH_FILE, 'utf8')); if (c && c.key && c.region) return c; } catch (e) {}
  return null;
}

// Config de X-Core local (Ollama runtime expuesto por local_ai/app.py).
const XCORE_FILE = path.join(os.homedir(), '.hanstlers', 'xcore.json');
function loadXCore() {
  try {
    const c = JSON.parse(fs.readFileSync(XCORE_FILE, 'utf8'));
    if (c && c.endpoint) {
      return {
        endpoint: String(c.endpoint).replace(/\/$/, ''),
        model: c.model || 'x-core:latest'
      };
    }
  } catch (e) {}
  return { endpoint: 'http://127.0.0.1:8009', model: 'x-core:latest' };
}


const XCORE_DEFAULT = { endpoint: 'http://127.0.0.1:8009', model: 'x-core:latest' };
let xcoreCfgCache = null;
let xcoreCfgMtimeMs = 0;
let xcoreLastReloadAt = 0;
let xcoreLastReloadError = '';
let xcoreDrain = false;
let xcoreInFlight = 0;

function reloadXCore(force) {
  try {
    let mtime = 0;
    try { mtime = fs.statSync(XCORE_FILE).mtimeMs || 0; } catch (e) { mtime = 0; }
    if (!force && xcoreCfgCache && mtime === xcoreCfgMtimeMs) return xcoreCfgCache;
    const cfg = loadXCore();
    xcoreCfgCache = cfg || XCORE_DEFAULT;
    xcoreCfgMtimeMs = mtime;
    xcoreLastReloadAt = Date.now();
    xcoreLastReloadError = '';
    return xcoreCfgCache;
  } catch (e) {
    xcoreLastReloadError = e.message || String(e);
    if (!xcoreCfgCache) xcoreCfgCache = XCORE_DEFAULT;
    return xcoreCfgCache;
  }
}
function currentXCore() { return reloadXCore(false); }
function withXCoreRequest(done) {
  xcoreInFlight += 1;
  let finished = false;
  return (code) => {
    if (finished) return;
    finished = true;
    xcoreInFlight = Math.max(0, xcoreInFlight - 1);
    done(code);
  };
}
reloadXCore(true);

const XCORE_AUDIO_EXT_RE = /\.(wav|mp3|flac|m4a|ogg|aac|webm|aif|aiff)$/i;
function xcoreMimeFor(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const map = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.aac': 'audio/aac',
    '.webm': 'audio/webm',
    '.aif': 'audio/aiff',
    '.aiff': 'audio/aiff'
  };
  return map[ext] || 'application/octet-stream';
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
    const child = spawn(cli, args, { cwd: path.dirname(cli), windowsHide: true });
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

function runAzure(message, history, historySummary, send, onDone, onAbort, images) {
  const cfg = loadAzure();
  if (!cfg) { send('error', 'Azure no está configurado.'); return onDone(1); }
  const ep = cfg.endpoint.replace(/\/$/, '');
  const url = new URL(ep + '/openai/deployments/' + cfg.deployment + '/chat/completions?api-version=' + (cfg.apiVersion || '2024-10-21'));
  const messages = [];
  messages.push({ role: 'system', content: 'Eres HanstlerS, asistente personal de Cesar. Responde en español, conciso y directo.' });
  if (historySummary) {
    messages.push({ role: 'system', content: 'Resumen acumulado de la conversación previa:\n' + historySummary });
  }
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

function resolveGcloudInvocation() {
  const baseArgs = ['auth', 'application-default', 'print-access-token'];
  const override = (process.env.GCLOUD_BIN || '').trim();
  const cands = [];
  if (override) cands.push(override);
  if (process.platform === 'win32') {
    cands.push(path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'));
    cands.push(path.join(process.env['ProgramFiles'] || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'));
    cands.push(path.join(process.env.LOCALAPPDATA || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'));
    cands.push(path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.exe'));
    cands.push(path.join(process.env['ProgramFiles'] || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.exe'));
    cands.push(path.join(process.env.LOCALAPPDATA || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.exe'));
    cands.push(path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.ps1'));
    cands.push(path.join(process.env['ProgramFiles'] || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.ps1'));
    cands.push(path.join(process.env.LOCALAPPDATA || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.ps1'));
  }
  for (const cand of cands) {
    if (!cand) continue;
    try {
      if (!fs.existsSync(cand)) continue;
      if (/\.cmd$/i.test(cand)) {
        const psPath = cand.replace(/'/g, "''");
        return {
          bin: 'powershell.exe',
          args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "& '" + psPath + "' " + baseArgs.join(' ')]
        };
      }
      if (/\.ps1$/i.test(cand)) {
        return {
          bin: 'powershell.exe',
          args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cand].concat(baseArgs)
        };
      }
      return { bin: cand, args: baseArgs };
    } catch (e) {}
  }
  if (process.platform === 'win32') {
    return { bin: 'cmd.exe', args: ['/d', '/s', '/c', 'gcloud auth application-default print-access-token'] };
  }
  return { bin: 'gcloud', args: baseArgs };
}

function pickTokenFromOutput(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^[A-Za-z0-9._-]{20,}$/.test(line)) return line;
  }
  return '';
}

function getGcpAccessToken(cb) {
  const inv = resolveGcloudInvocation();
  let child;
  try {
    child = spawn(inv.bin, inv.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return cb(e);
  }
  let out = '';
  let err = '';
  let done = false;
  const finish = (e, token) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(e, token);
  };
  const timer = setTimeout(() => {
    try { child.kill(); } catch (e) {}
    finish(new Error('gcloud timeout'));
  }, 15000);
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  child.on('error', (e) => finish(e));
  child.on('close', (code) => {
    if (code !== 0) return finish(new Error(('gcloud auth failed: ' + (err || ('exit ' + code))).trim()));
    const token = pickTokenFromOutput(out);
    if (!token) return finish(new Error('gcloud returned empty token'));
    finish(null, token);
  });
}

function summarizeVertexError(statusCode, raw, model) {
  const code = Number(statusCode) || 0;
  let msg = '';
  try {
    const j = JSON.parse(String(raw || '{}'));
    msg = String((j && j.error && j.error.message) || '').trim();
  } catch (e) {}
  const low = (msg || String(raw || '')).toLowerCase();
  // El modo de autenticacion cambia por completo la solucion: mandar a "gcloud
  // auth" a quien usa API key lo hace perder el tiempo en algo que no usa.
  let modo = '';
  try { const c = loadVertex(); modo = c ? c.authMode : ''; } catch (e) {}
  const nombreModelo = String(model || '').trim();
  if (code === 400 && msg) return 'Vertex rechazó la solicitud: ' + msg.slice(0, 280);
  if ((code === 429) || /quota exceeded|resource_exhausted|rate limit|too many requests/.test(low)) return 'Vertex no disponible: cuota/rate-limit agotado. Sube cuota de Vertex o espera el reset.';
  if (code === 403 && /billing/.test(low)) return 'Vertex no disponible: habilita billing en el proyecto GCP.';
  if (code === 403 && /permission denied|permission_denied|denied/.test(low)) return 'Vertex no disponible: faltan permisos IAM para ese proyecto/modelo.';
  if (code === 404 || /not found|is not found|no está disponible/.test(low)) {
    return 'Vertex no disponible: el modelo' + (nombreModelo ? ' "' + nombreModelo + '"' : '') +
      ' ya no existe o fue retirado por Google (sigue apareciendo listado, pero responde 404). ' +
      'Cambia modelPro/modelFlash en ~/.hanstlers/vertex.json; hoy funcionan ' +
      VERTEX_DEFAULT_PRO + ' y ' + VERTEX_DEFAULT_FLASH + '.';
  }
  if (code === 401 || /unauthenticated|invalid_grant|login required|invalid authentication credentials|api key not valid/.test(low)) {
    if (modo === 'api-key') {
      return 'Vertex no disponible: la API key es inválida, expiró o fue revocada. ' +
        'Genera otra en Google AI Studio y guárdala en ~/.hanstlers/vertex.json (UTF-8 sin BOM).';
    }
    return 'Vertex no disponible: autentica ADC con gcloud (gcloud auth application-default login).';
  }
  if (code) return 'Vertex no disponible (HTTP ' + code + ').';
  return 'Vertex no disponible temporalmente.';
}

const GEMINI_NO_CONTENT_RETRY_REASONS = new Set([
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'OTHER',
  'FINISH_REASON_UNSPECIFIED'
]);

function normalizeGeminiFinishReason(reason) {
  return String(reason || '').trim().toUpperCase();
}

function summarizeGeminiNoContent(reason) {
  const r = normalizeGeminiFinishReason(reason);
  if (!r) return 'Gemini no devolvio contenido.';
  if (r === 'MALFORMED_FUNCTION_CALL') return 'Gemini devolvio una llamada de funcion malformada. Se reintentara automaticamente.';
  if (r === 'UNEXPECTED_TOOL_CALL') return 'Gemini intento usar una herramienta no esperada. Se reintentara automaticamente.';
  if (r === 'SAFETY') return 'Gemini bloqueo la respuesta por politicas de seguridad. Reformula la peticion con mas contexto tecnico.';
  if (r === 'RECITATION') return 'Gemini bloqueo la salida por recitacion de contenido protegido. Pide un resumen o transformacion.';
  if (r === 'MAX_TOKENS') return 'Gemini llego al limite de tokens sin producir salida util. Reduce el alcance del pedido.';
  return 'Gemini no devolvio contenido (' + r + ').';
}

function isVertexOnlyMode(selectedModel) {
  const forced = String(process.env.HANSTLERS_VERTEX_ONLY || '').trim().toLowerCase();
  if (forced === '1' || forced === 'true' || forced === 'yes' || forced === 'on') return true;
  return String(selectedModel || '').trim().toLowerCase() === 'vertex-claude-opus-5';
}
function allowVertexCopilotFallback() {
  const v = String(process.env.HANSTLERS_VERTEX_ALLOW_COPILOT_FALLBACK || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function toGeminiContents(history, message, images) {
  const raw = [];
  (Array.isArray(history) ? history : []).forEach((m) => {
    const role = String(m && m.role || '').toLowerCase() === 'user' ? 'user' : 'model';
    const txt = String(m && (m.content || m.html) || '').trim();
    if (!txt) return;
    raw.push({ role, text: txt.slice(0, 2000) });
  });
  while (raw.length && raw[0].role !== 'user') raw.shift();
  const out = [];
  raw.forEach((m) => {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.parts.push({ text: m.text });
    } else {
      out.push({ role: m.role, parts: [{ text: m.text }] });
    }
  });
  const userParts = [{ text: String(message || '').trim() }];
  (Array.isArray(images) ? images : []).slice(0, 4).forEach((im) => {
    const mm = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(im || ''));
    if (!mm) return;
    userParts.push({ inlineData: { mimeType: mm[1], data: mm[2] } });
  });
  if (out.length && out[out.length - 1].role === 'user') out[out.length - 1].parts = out[out.length - 1].parts.concat(userParts);
  else out.push({ role: 'user', parts: userParts });
  return out;
}

function toAnthropicMessages(history, message) {
  const raw = [];
  (Array.isArray(history) ? history : []).forEach((m) => {
    const role = String(m && m.role || '').toLowerCase() === 'user' ? 'user' : 'assistant';
    const txt = String(m && (m.content || m.html) || '').trim();
    if (!txt) return;
    raw.push({ role, text: txt.slice(0, 2000) });
  });
  while (raw.length && raw[0].role !== 'user') raw.shift();
  const out = [];
  raw.forEach((m) => {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content.push({ type: 'text', text: m.text });
    } else {
      out.push({ role: m.role, content: [{ type: 'text', text: m.text }] });
    }
  });
  if (out.length && out[out.length - 1].role === 'user') out[out.length - 1].content.push({ type: 'text', text: String(message || '') });
  else out.push({ role: 'user', content: [{ type: 'text', text: String(message || '') }] });
  return out;
}

function runVertex(message, history, historySummary, selectedVertexModel, send, onDone, onAbort, images) {
  const cfg = loadVertex();
  if (!cfg) return onDone(1, 'Vertex no configurado (GCP_PROJECT_ID/GCP_REGION o GOOGLE_API_KEY).');
  const pick = pickVertexTarget(selectedVertexModel, message, !!(images && images.length));
  if (!pick.model) return onDone(1, 'No se pudo resolver modelo Vertex.');
  if (pick.publisher === 'anthropic' && cfg.authMode !== 'adc') {
    return onDone(1, 'Claude Opus en Vertex requiere GCP_PROJECT_ID/GCP_REGION y auth de gcloud (ADC).');
  }
  const finalMsg = historySummary ? (`Resumen acumulado:\n${historySummary}\n\nMensaje actual:\n${message}`) : message;
  const payload = pick.publisher === 'anthropic'
    ? JSON.stringify({
      anthropic_version: 'vertex-2023-10-16',
      messages: toAnthropicMessages(history, finalMsg),
      temperature: 0.2,
      max_tokens: 2048
    })
    : JSON.stringify({
      contents: toGeminiContents(history, finalMsg, images),
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
    });
  const buildGoogleEndpoint = (modelName) => {
    if (cfg.authMode === 'api-key') {
      return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
    }
    return `https://${cfg.region}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/locations/${encodeURIComponent(cfg.region)}/publishers/google/models/${encodeURIComponent(modelName)}:generateContent`;
  };
  let noContentRetry = false;
  let malformedRecovered = false;
  const parseAndEmit = (publisher, raw, modelUsed, routeReason) => {
    let j = null;
    try { j = JSON.parse(raw || '{}'); } catch (e) { return { ok: false, err: 'Vertex devolvió una respuesta inválida.' }; }
    let txt = '';
    let promptTok = 0;
    let outTok = 0;
    let finishReason = '';
    if (publisher === 'anthropic') {
      txt = Array.isArray(j.content)
        ? j.content.map((p) => String(p && p.text || '')).join('').trim()
        : String(j.output_text || '').trim();
      const usage = j.usage || {};
      promptTok = Number(usage.input_tokens);
      outTok = Number(usage.output_tokens);
    } else {
      const cand = (((j || {}).candidates || [])[0] || {});
      const parts = cand.content || {};
      finishReason = normalizeGeminiFinishReason(cand.finishReason || '');
      txt = Array.isArray(parts.parts) ? parts.parts.map((p) => String(p && p.text || '')).join('').trim() : '';
      const usage = j.usageMetadata || {};
      promptTok = Number(usage.promptTokenCount);
      outTok = Number(usage.candidatesTokenCount);
    }
    if (!txt) {
      const userMessage = summarizeGeminiNoContent(finishReason);
      if (finishReason) return { ok: false, err: 'Vertex devolvió respuesta vacía (' + finishReason + ').', finishReason: finishReason, userMessage: userMessage };
      return { ok: false, err: 'Vertex devolvió respuesta vacía.', finishReason: '', userMessage: userMessage };
    }
    send('route', { model: 'vertex:' + (publisher === 'anthropic' ? ('anthropic/' + modelUsed) : modelUsed), reason: routeReason || pick.reason });
    send('chunk', txt);
    if ((Number.isFinite(promptTok) && promptTok > 0) || (Number.isFinite(outTok) && outTok > 0)) {
      addGoogleTokens(modelUsed, promptTok, outTok);
      send('usage', { quota: quotaInfo(), google: googleQuotaInfo() });
    }
    return { ok: true };
  };
  const sendVertexRequest = (authHeader, endpoint, modelUsed, routeReason) => {
    const u = new URL(endpoint);
    let reqAborted = false;
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      timeout: 45000,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }, authHeader || {})
    }, (resp) => {
      let raw = '';
      resp.on('data', (d) => { raw += d.toString(); if (raw.length > 2 * 1024 * 1024) raw = raw.slice(-2 * 1024 * 1024); });
      resp.on('end', () => {
        if (reqAborted) return;
        if (resp.statusCode >= 400) return onDone(1, summarizeVertexError(resp.statusCode, raw, modelUsed || pick.model));
        const currentModel = modelUsed || pick.model;
        const parsed = parseAndEmit(pick.publisher || 'google', raw, currentModel, routeReason || pick.reason);
        if (!parsed.ok && (pick.publisher || 'google') === 'google') {
          if (!noContentRetry && GEMINI_NO_CONTENT_RETRY_REASONS.has(parsed.finishReason)) {
            noContentRetry = true;
            return sendVertexRequest(authHeader, endpoint, currentModel, (routeReason || pick.reason) + '-retry-empty');
          }
          if (!malformedRecovered && parsed.finishReason === 'MALFORMED_FUNCTION_CALL') {
            malformedRecovered = true;
            const fallbackModel = cfg.models.flash || currentModel;
            if (fallbackModel && fallbackModel !== currentModel) {
              return sendVertexRequest(authHeader, buildGoogleEndpoint(fallbackModel), fallbackModel, (routeReason || pick.reason) + '-fallback-malformed');
            }
          }
        }
        if (!parsed.ok) return onDone(1, parsed.userMessage || parsed.err);
        return onDone(0);
      });
    });
    req.on('error', (e) => { if (!reqAborted) onDone(1, 'Vertex error: ' + e.message); });
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (e) {} });
    if (onAbort) onAbort(() => { reqAborted = true; try { req.destroy(); } catch (e) {} });
    req.write(payload);
    req.end();
  };
  if (cfg.authMode === 'api-key') {
    return sendVertexRequest({}, buildGoogleEndpoint(pick.model), pick.model, pick.reason);
  }

  try {
    getGcpAccessToken((tokErr, token) => {
      if (tokErr) return onDone(1, 'Vertex auth: ' + tokErr.message);
      const publisher = pick.publisher || 'google';
      const method = publisher === 'anthropic' ? 'rawPredict' : 'generateContent';
      const endpoint = `https://${cfg.region}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/locations/${encodeURIComponent(cfg.region)}/publishers/${encodeURIComponent(publisher)}/models/${encodeURIComponent(pick.model)}:${method}`;
      return sendVertexRequest({ 'Authorization': 'Bearer ' + token }, endpoint, pick.model, pick.reason);
    });
  } catch (e) {
    onDone(1, 'Vertex auth: ' + e.message);
  }
}

function runXCore(message, history, send, onDone, onAbort) {
  if (xcoreDrain) {
    send('error', 'X-Core esta en mantenimiento temporal. Espera unos segundos y vuelve a intentar.');
    return onDone(1);
  }
  onDone = withXCoreRequest(onDone);
  const cfg = currentXCore();
  const url = new URL(cfg.endpoint + '/v1/knowledge/ask');
  let query = String(message || '').slice(0, 1800);
  const isAudioAnalysis = /(?:^|\s)(analiza|analizar|revisa|review).*(track|cancion|canci[oó]n|tema)|\.(wav|mp3|flac|aiff|m4a)\b/i.test(query);
  const wantsReferenceAnalysis = /\b(analiza|analizar|revisa)\b[\s\S]{0,40}\b(referencia|reference)\b/i.test(query) || /\b(bpm|tempo|genero|género)\b[\s\S]{0,30}\b(referencia)\b/i.test(query);
  const wantsStyleProfile = /\b(crea|crear|arma|build)\b[\s\S]{0,40}\b(perfil|style)\b/i.test(query) && /\.(wav|mp3|flac|aiff|m4a)\b/i.test(query);
  const wantsLoraJob = /\b(lora|fine[- ]?tune|entrena modelo|entrenar modelo)\b/i.test(query);
  const hasProjectContinuation = /\b(v\d+|version\s*\d+|versi[oó]n\s*\d+|haz\s*v\d+)\b/i.test(query);
  const needsAudioBrief = Array.isArray(history)
    ? history.slice(-4).some((m) => ['bot','assistant'].includes(String(m && m.role || '').toLowerCase()) && /brief de producci(o|ó)n/i.test(String(m && (m.content || m.html) || '')))
    : false;
  const typoAudioGeneration = /\b(has|as)\s+una?\s+(cancion|canci[oó]n|track|beat|instrumental|melodia|melod[ií]a|sonido|sound|fx|efecto)\b/i.test(query);
  const shortAudioRequest = /^\s*(una?|un)\s+(cancion|canci[oó]n|track|beat|instrumental|melodia|melod[ií]a|sonido|sound|fx|efecto)\b/i.test(query);
  const wantsAudioGeneration = /\b(haz|hacer|crea|crear|genera|generar|produce|producir|make|generate)\b[\s\S]{0,60}\b(cancion|canci[oó]n|track|beat|instrumental|melodia|melod[ií]a|sonido|sound|fx|efecto)\b/i.test(query) || typoAudioGeneration || shortAudioRequest || needsAudioBrief || hasProjectContinuation;
  if (wantsStyleProfile) {
    const nameMatch = /(?:perfil|style)\s*[:=]\s*([a-zA-Z0-9_-]{3,})/i.exec(query);
    const profileName = nameMatch && nameMatch[1] ? nameMatch[1] : 'mi-estilo';
    const re = /@([a-zA-Z]:\\[^\n\r\t"'`]+?\.(wav|mp3|flac|aiff|m4a))/gi;
    const paths = [];
    let mm = null;
    while ((mm = re.exec(query)) !== null) { if (mm[1]) paths.push(mm[1]); }
    if (!paths.length) {
      send('chunk', 'Para crear perfil de estilo, adjunta al menos un audio con @ruta.wav.');
      return onDone(0);
    }
    const pUrl = new URL(cfg.endpoint + '/v1/audio/style-profile');
    const payload = JSON.stringify({ name: profileName, audio_paths: paths });
    const pReq = http.request({
      hostname: pUrl.hostname,
      port: Number(pUrl.port || 80),
      path: pUrl.pathname + pUrl.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (resp) => {
      let raw = '';
      resp.on('data', (d) => (raw += d.toString()));
      resp.on('end', () => {
        if (resp.statusCode >= 400) { send('error', 'X-Core ' + resp.statusCode + ': ' + raw.slice(0, 220)); return onDone(1); }
        try {
          const j = JSON.parse(raw || '{}');
          if (!j.ok) { send('chunk', `No pude crear perfil: ${j.error || 'error desconocido'}`); return onDone(0); }
          send('chunk', `Perfil de estilo creado: ${j.name}\nReferencias: ${j.references}\nBPM: ${j.bpm || 'n/d'}\nGenero: ${j.genre_guess || 'n/d'}\nArchivo perfil: ${j.profile_path}`);
          return onDone(0);
        } catch (e) { send('error', 'X-Core respuesta invalida'); return onDone(1); }
      });
    });
    pReq.on('error', (e) => { send('error', 'X-Core error: ' + e.message); onDone(1); });
    if (onAbort) onAbort(() => { try { pReq.destroy(); } catch (e) {} });
    pReq.write(payload);
    pReq.end();
    return;
  }
  if (wantsLoraJob) {
    const nameMatch = /(?:perfil|style)\s*[:=]\s*([a-zA-Z0-9_-]{3,})/i.exec(query);
    const profileName = nameMatch && nameMatch[1] ? nameMatch[1] : 'mi-estilo';
    const runNow = /\b(ahora|inicia|run now|start now)\b/i.test(query);
    const re = /@([a-zA-Z]:\\[^\n\r\t"'`]+?\.(wav|mp3|flac|aiff|m4a))/gi;
    const paths = [];
    let mm = null;
    while ((mm = re.exec(query)) !== null) { if (mm[1]) paths.push(mm[1]); }
    const fUrl = new URL(cfg.endpoint + '/v1/audio/fine-tune-lora');
    const payload = JSON.stringify({ profile_name: profileName, audio_paths: paths, run_now: runNow });
    const fReq = http.request({
      hostname: fUrl.hostname,
      port: Number(fUrl.port || 80),
      path: fUrl.pathname + fUrl.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (resp) => {
      let raw = '';
      resp.on('data', (d) => (raw += d.toString()));
      resp.on('end', () => {
        if (resp.statusCode >= 400) { send('error', 'X-Core ' + resp.statusCode + ': ' + raw.slice(0, 220)); return onDone(1); }
        try {
          const j = JSON.parse(raw || '{}');
          if (!j.ok) { send('chunk', `No pude preparar LoRA: ${j.message || j.error || 'error desconocido'}`); return onDone(0); }
          send('chunk', `Pipeline LoRA listo para ${j.profile_name}.\nDataset: ${j.dataset_dir}\nJob: ${j.job_dir}\nComando: ${j.command}\nEstado: ${j.started ? 'iniciado' : 'preparado'}`);
          return onDone(0);
        } catch (e) { send('error', 'X-Core respuesta invalida'); return onDone(1); }
      });
    });
    fReq.on('error', (e) => { send('error', 'X-Core error: ' + e.message); onDone(1); });
    if (onAbort) onAbort(() => { try { fReq.destroy(); } catch (e) {} });
    fReq.write(payload);
    fReq.end();
    return;
  }
  if (wantsReferenceAnalysis) {
    const m = /@([a-zA-Z]:\\[^\n\r\t"'`]+?\.(wav|mp3|flac|aiff|m4a))/i.exec(query);
    if (!m || !m[1]) {
      send('chunk', 'Para analizar referencia, envia la ruta del audio con @ (ejemplo: @C:\\Users\\czumb\\Downloads\\track.wav).');
      return onDone(0);
    }
    const refUrl = new URL(cfg.endpoint + '/v1/audio/analyze-reference');
    const refPayload = JSON.stringify({ audio_path: m[1] });
    const refReq = http.request({
      hostname: refUrl.hostname,
      port: Number(refUrl.port || 80),
      path: refUrl.pathname + refUrl.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(refPayload) }
    }, (resp) => {
      let raw = '';
      resp.on('data', (d) => (raw += d.toString()));
      resp.on('end', () => {
        if (resp.statusCode >= 400) {
          send('error', 'X-Core ' + resp.statusCode + ': ' + raw.slice(0, 220));
          return onDone(1);
        }
        try {
          const j = JSON.parse(raw || '{}');
          if (!j.ok) {
            send('chunk', `No pude analizar referencia: ${j.error || 'error desconocido'}`);
            return onDone(0);
          }
          const dur = j.duration_sec ? `${Math.round(j.duration_sec)}s` : 'n/d';
          const bpm = j.bpm ? `${j.bpm} BPM` : 'BPM n/d';
          const genre = j.genre_guess || 'género n/d';
          const key = j.key_guess || 'clave n/d';
          const rms = (j.energy_rms_db !== null && j.energy_rms_db !== undefined) ? `${j.energy_rms_db} dB RMS` : 'RMS n/d';
          const sec = j.section_count || 0;
          send('chunk', `Referencia analizada:\nArchivo: ${j.path}\nDuracion: ${dur}\nTempo: ${bpm}\nGenero estimado: ${genre}\nClave estimada: ${key}\nEnergia: ${rms}\nSecciones detectadas: ${sec}\nLoudness: ${j.loudness_lufs !== null && j.loudness_lufs !== undefined ? `${j.loudness_lufs} LUFS` : `LUFS n/d`} | True peak: ${j.true_peak_db !== null && j.true_peak_db !== undefined ? `${j.true_peak_db} dB` : `n/d`}\nCanales: ${j.channels || 'n/d'} | Sample rate: ${j.sample_rate || 'n/d'} Hz`);
          return onDone(0);
        } catch (e) {
          send('error', 'X-Core respuesta invalida');
          return onDone(1);
        }
      });
    });
    refReq.on('error', (e) => { send('error', 'X-Core error: ' + e.message); onDone(1); });
    if (onAbort) onAbort(() => { try { refReq.destroy(); } catch (e) {} });
    refReq.write(refPayload);
    refReq.end();
    return;
  }
  if (wantsAudioGeneration) {
    const genUrl = new URL(cfg.endpoint + '/v1/audio/generate');
    const briefUserContext = Array.isArray(history)
      ? history
          .filter((m) => String(m && m.role || '').toLowerCase() === 'user')
          .slice(-4)
          .map((m) => String(m.content || '').slice(0, 280))
          .join('\n')
      : '';
    const generationPrompt = (needsAudioBrief || hasProjectContinuation) && briefUserContext ? `${briefUserContext}\n${query}` : query;
    const qualityMode = /\b(pro|alta calidad|high quality|suno)\b/i.test(generationPrompt) ? 'pro' : 'auto';
    const prevProject = Array.isArray(history)
      ? (() => {
          const joined = history.map((m) => String(m && (m.content || m.html) || '')).join('\n');
          const mm = /Proyecto:\s*([a-z0-9-]{3,})/i.exec(joined);
          return mm ? mm[1] : '';
        })()
      : '';
    const genPayload = JSON.stringify({ prompt: generationPrompt, stems: true, project_name: prevProject || undefined, quality_mode: qualityMode });
    const genReq = http.request({
      hostname: genUrl.hostname,
      port: Number(genUrl.port || 80),
      path: genUrl.pathname + genUrl.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(genPayload) }
    }, (resp) => {
      let raw = '';
      resp.on('data', (d) => (raw += d.toString()));
      resp.on('end', () => {
        if (resp.statusCode >= 400) {
          send('error', 'X-Core ' + resp.statusCode + ': ' + raw.slice(0, 220));
          return onDone(1);
        }
        try {
          const j = JSON.parse(raw || '{}');
          if (j.needs_input) {
            const qs = Array.isArray(j.questions) ? j.questions : [];
            const list = qs.map((q, i) => `${i + 1}. ${q}`).join('\n');
            const intro = String(j.details || '').trim();
            const header = intro ? (`Brief de produccion:\n${intro}\n\n`) : 'Brief de produccion (necesario):\n';
            send('chunk', `${header}${list || '1. Define genero, BPM, caracter y duracion.'}`);
            return onDone(0);
          }
          const mode = j.mode === 'sfx' ? 'sonido' : 'cancion/base';
          const bpm = j.bpm ? ` | BPM: ${j.bpm}` : '';
          const out = String(j.output_path || '').trim();
          const proj = j.project ? `\nProyecto: ${j.project}` : '';
          const ver = j.version ? `\nVersion: ${j.version}` : '';
          const stems = (j.stems && typeof j.stems === 'object') ? Object.keys(j.stems) : [];
          const stemsTxt = stems.length ? `\nStems: ${stems.join(', ')}` : '';
          if (out && fs.existsSync(out) && XCORE_AUDIO_EXT_RE.test(out)) {
            send('xcoreTrack', { path: out, name: path.basename(out) });
          }
          send('chunk', `Listo. Genere ${mode}${bpm}.${proj}${ver}\nArchivo: ${out}${stemsTxt}\n${j.details || ''}`);
          return onDone(0);
        } catch (e) {
          send('error', 'X-Core respuesta invalida');
          return onDone(1);
        }
      });
    });
    genReq.on('error', (e) => { send('error', 'X-Core error: ' + e.message); onDone(1); });
    if (onAbort) onAbort(() => { try { genReq.destroy(); } catch (e) {} });
    genReq.write(genPayload);
    genReq.end();
    return;
  }
  const recent = Array.isArray(history)
    ? history.filter((m) => String(m && m.role || '').toLowerCase() === 'user').slice(-2)
    : [];
  if (recent.length && !isAudioAnalysis) {
    const mini = recent
      .map((m) => `${m.role || 'user'}: ${String(m.content || '').slice(0, 280)}`)
      .join('\n');
    query = `Contexto reciente:\n${mini}\n\nPregunta actual:\n${query}`;
  }
  const payload = JSON.stringify({
    query: query,
    model: cfg.model || 'x-core:latest',
    top_k: 6,
    temperature: 0.15,
    max_tokens: 260
  });
  const req = http.request({
    hostname: url.hostname,
    port: Number(url.port || 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  }, (resp) => {
    let raw = '';
    resp.on('data', (d) => (raw += d.toString()));
    resp.on('end', () => {
      if (resp.statusCode >= 400) {
        send('error', 'X-Core ' + resp.statusCode + ': ' + raw.slice(0, 220));
        return onDone(1);
      }
      try {
        const j = JSON.parse(raw || '{}');
        const content = String(j.answer || '').trim();
        if (content) send('chunk', content);
        return onDone(0);
      } catch (e) {
        send('error', 'X-Core respuesta invalida');
        return onDone(1);
      }
    });
  });
  req.on('error', (e) => { send('error', 'X-Core error: ' + e.message); onDone(1); });
  if (onAbort) onAbort(() => { try { req.destroy(); } catch (e) {} });
  req.write(payload);
  req.end();
}

// ===== MODO AGENTE sobre Azure: el modelo usa herramientas (archivos/comandos) =====
// Modo confianza total: sin confirmaciones para acciones del agente.
let trustMode = true;

const AGENT_TOOLS = [
  { type: 'function', function: { name: 'list_dir', description: 'Lista archivos y carpetas de un directorio', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta (por defecto la carpeta de trabajo)' } } } } },
  { type: 'function', function: { name: 'read_file', description: 'Lee el contenido de un archivo de texto', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Crea o sobrescribe un archivo con contenido', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'apply_patch', description: 'Edita un trozo de un archivo existente: reemplaza la primera aparición de un texto por otro (más rápido y barato que reescribir todo). Usa esto para cambios pequeños.', parameters: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string', description: 'Texto exacto a buscar (incluye contexto suficiente para que sea único)' }, replace: { type: 'string', description: 'Texto nuevo que lo reemplaza' } }, required: ['path', 'find', 'replace'] } } },
  { type: 'function', function: { name: 'search_in_files', description: 'Busca un texto o patrón en todos los archivos del proyecto y devuelve las coincidencias con archivo y número de línea', parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string', description: 'Carpeta donde buscar (por defecto la de trabajo)' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'delete_file', description: 'Borra un archivo o carpeta', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'move_file', description: 'Mueve o renombra un archivo o carpeta', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Ejecuta un comando de PowerShell en la carpeta de trabajo y devuelve la salida', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'open_browser', description: 'Abre una URL en el navegador predeterminado del sistema', parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL a abrir (debe empezar con http:// o https://)' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'git_commit', description: 'Hace git add -A y git commit con el mensaje dado en la carpeta de trabajo', parameters: { type: 'object', properties: { message: { type: 'string', description: 'Mensaje del commit' } }, required: ['message'] } } },
  { type: 'function', function: { name: 'npm_run', description: 'Ejecuta un script de npm (package.json) en la carpeta de trabajo. Útil para build, test, lint, start, etc.', parameters: { type: 'object', properties: { script: { type: 'string', description: 'Nombre del script (ej: build, test, lint)' }, args: { type: 'string', description: 'Argumentos opcionales adicionales' } }, required: ['script'] } } },
  { type: 'function', function: { name: 'notify', description: 'Muestra una notificación toast en Windows con un título y mensaje', parameters: { type: 'object', properties: { title: { type: 'string' }, message: { type: 'string' } }, required: ['title', 'message'] } } },
  { type: 'function', function: { name: 'open_repo', description: 'Abre un repositorio de GitHub para trabajar en él: lo clona automáticamente si no está en disco (o hace git pull si ya estaba) y cambia la carpeta de trabajo a ese repo. Úsala SIEMPRE que el usuario diga "abre el repo X", "trabaja en X", "clona X" o mencione un repositorio de GitHub que aún no es la carpeta actual.', parameters: { type: 'object', properties: { repo: { type: 'string', description: 'owner/repo, URL de GitHub, o solo el nombre del repo si es de la cuenta del usuario' } }, required: ['repo'] } } }
];

function resolveInCwd(p) {
  if (!p) return state.cwd;
  return path.isAbsolute(p) ? p : path.join(state.cwd, p);
}

// ===== Abrir repos de GitHub con clonado automatico =====
// El panel de repos solo ponia una etiqueta "GitHub · owner/repo": no habia copia
// local, asi que el agente no podia leer ni editar nada. Aqui se clona (o actualiza)
// el repo en disco y se mueve la carpeta de trabajo hacia el.
const REPOS_BASE = path.join(os.homedir(), 'Documents', 'HanstlerS');

function parseRepoSpec(spec) {
  const s = String(spec || '').trim().replace(/^[<"']+|[>"'.,;]+$/g, '');
  if (!s) return null;
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[\/?#].*)?$/i.exec(s);
  if (m) return { owner: m[1], repo: m[2] };
  m = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(s);
  if (m) return { owner: m[1], repo: m[2] };
  m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(s);
  if (m) return { owner: m[1], repo: m[2] };
  m = /^([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(s);
  if (m) return { owner: '', repo: m[1] };
  return null;
}

// Candidatos donde ya podria existir una copia local, para no reclonar de mas.
function existingRepoDirs(repoName) {
  const home = os.homedir();
  return [
    path.join(REPOS_BASE, repoName),
    path.join(home, 'Documents', repoName),
    path.join(home, repoName)
  ];
}

function isGitRepoDir(dir) {
  try { return fs.statSync(path.join(dir, '.git')).isDirectory() || fs.statSync(path.join(dir, '.git')).isFile(); }
  catch (e) { return false; }
}

function runQuiet(bin, args, cwd, cb) {
  // Sin prompts interactivos: un git clone que pide credenciales colgaria el
  // agente con un dialogo invisible (windowsHide) hasta el timeout.
  const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
  execFile(bin, args, { cwd: cwd || undefined, env: env, windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => cb(err || null, String(stdout || '') + String(stderr || '')));
}

// Resuelve owner/repo cuando el usuario solo dijo el nombre ("abre hansters").
function resolveRepoOwner(name, cb) {
  ghJson(['repo', 'view', name, '--json', 'nameWithOwner'], (err, obj) => {
    if (!err && obj && obj.nameWithOwner) {
      const p = parseRepoSpec(obj.nameWithOwner);
      if (p && p.owner) return cb(null, p);
    }
    ghJson(['repo', 'list', '@me', '--limit', '100', '--json', 'nameWithOwner'], (err2, items) => {
      if (err2 || !Array.isArray(items)) return cb(new Error('No pude resolver el dueño del repo "' + name + '". Usa owner/repo.'));
      const hit = items.find((r) => {
        const p = parseRepoSpec(String(r && r.nameWithOwner || ''));
        return p && p.repo.toLowerCase() === String(name).toLowerCase();
      });
      const p = hit ? parseRepoSpec(String(hit.nameWithOwner)) : null;
      if (!p || !p.owner) return cb(new Error('No encontré el repo "' + name + '" en tu cuenta de GitHub. Usa owner/repo.'));
      cb(null, p);
    });
  });
}

// Clona si falta, actualiza si ya existe, y deja el repo como carpeta de trabajo.
function openRepoWorkspace(spec, cb) {
  const parsed = parseRepoSpec(spec);
  if (!parsed || !parsed.repo) return cb(new Error('Repo inválido: "' + spec + '". Usa owner/repo o la URL de GitHub.'));

  const proceed = (info) => {
    const ref = (info.owner ? info.owner + '/' : '') + info.repo;
    const existing = existingRepoDirs(info.repo).find((d) => isGitRepoDir(d));
    if (existing) {
      return runQuiet('git', ['-C', existing, 'pull', '--ff-only'], null, (_e, out) => {
        finish(existing, ref, 'actualizado', out);
      });
    }
    if (!info.owner) return cb(new Error('Falta el dueño del repo "' + info.repo + '". Usa owner/repo.'));
    const target = path.join(REPOS_BASE, info.repo);
    try { fs.mkdirSync(REPOS_BASE, { recursive: true }); } catch (e) {}
    const url = 'https://github.com/' + ref + '.git';
    runQuiet('git', ['clone', url, target], null, (err, out) => {
      if (!err) return finish(target, ref, 'clonado', out);
      // Repo privado o sin credenciales en git: reintento con la GitHub CLI.
      runQuiet(resolveGhBinary(), ['repo', 'clone', ref, target], null, (err2, out2) => {
        if (err2) return cb(new Error('No pude clonar ' + ref + ': ' + String(out || out2 || err2.message).trim().slice(0, 400)));
        finish(target, ref, 'clonado', out2);
      });
    });
  };

  const finish = (dir, ref, action, out) => {
    if (!isGitRepoDir(dir)) return cb(new Error('El clonado de ' + ref + ' no dejó un repo válido en ' + dir));
    state.cwd = dir;
    state.started = false;
    state.projectCtx = null;
    cb(null, { path: dir, repoRef: ref, action: action, output: String(out || '').slice(0, 2000) });
  };

  if (parsed.owner) return proceed(parsed);
  // Sin owner: si ya hay copia local, se usa sin tocar la red.
  const local = existingRepoDirs(parsed.repo).find((d) => isGitRepoDir(d));
  if (local) {
    return runQuiet('git', ['-C', local, 'remote', 'get-url', 'origin'], null, (_e, out) => {
      const p = parseRepoSpec(String(out || '').trim().split(/\r?\n/)[0] || '');
      proceed(p && p.owner ? p : { owner: '', repo: parsed.repo, _localOnly: true });
    });
  }
  resolveRepoOwner(parsed.repo, (err, p) => {
    if (err) return cb(err);
    proceed(p);
  });
}
function isMutatingTool(name) {
  return name === 'write_file' || name === 'apply_patch' || name === 'delete_file' || name === 'move_file';
}
function isProtectedMainPath(p) {
  const b = path.basename(String(p || '')).toLowerCase();
  return /^main([._-]|$)/.test(b);
}
function isExplicitMainEditRequest(text) {
  return /\b(main(?:[_-]qt)?\.(py|js|ts|tsx|jsx)|archivo\s+main|editar\s+main|modificar\s+main)\b/i.test(String(text || ''));
}
function operatorTargetLabel(name, args) {
  if (name === 'move_file') return String(args.from || '') + ' → ' + String(args.to || '');
  if (name === 'run_command') return String(args.command || '').slice(0, 120);
  if (name === 'open_repo') return String(args.repo || '').slice(0, 120);
  return String(args.path || args.url || '').slice(0, 120);
}
function buildOperatorSuggestion(name, args) {
  const tgt = operatorTargetLabel(name, args);
  if (name === 'open_browser') return 'Sugerencia: abriré la página y continuaré el flujo automáticamente.';
  if (name === 'run_command') return 'Sugerencia: ejecutaré el comando en modo no interactivo y validaré el resultado.';
  if (isMutatingTool(name)) return 'Sugerencia: aplicaré el cambio con rollback automático y post-check.';
  return 'Sugerencia: validaré el resultado al terminar.';
}
function snapshotPathForRollback(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { path: filePath, exists: false };
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { path: filePath, exists: true, kind: 'non-file' };
    return { path: filePath, exists: true, kind: 'file', content: fs.readFileSync(filePath, 'utf8') };
  } catch (e) {
    return { path: filePath, exists: false, error: e.message };
  }
}
function rollbackSnapshot(snap, cb) {
  try {
    if (!snap || !snap.path) return cb(null);
    if (!snap.exists) {
      if (fs.existsSync(snap.path)) fs.rmSync(snap.path, { force: true, recursive: false });
      return cb(null);
    }
    if (snap.kind === 'file') {
      fs.mkdirSync(path.dirname(snap.path), { recursive: true });
      fs.writeFileSync(snap.path, snap.content || '');
    }
    cb(null);
  } catch (e) { cb(e); }
}
function verifyPostCheck(tool, args, result, summary) {
  try {
    if (tool === 'write_file') {
      const f = resolveInCwd(args.path);
      if (!fs.existsSync(f)) return { ok: false, detail: 'post-check: archivo no existe' };
      const now = fs.readFileSync(f, 'utf8');
      if (sha256Hex(now) !== sha256Hex(String(args.content || ''))) return { ok: false, detail: 'post-check: contenido no coincide' };
      return { ok: true, detail: 'post-check ok' };
    }
    if (tool === 'apply_patch') {
      const f = resolveInCwd(args.path);
      if (!fs.existsSync(f)) return { ok: false, detail: 'post-check: archivo no existe' };
      const now = fs.readFileSync(f, 'utf8');
      const repl = String(args.replace || '');
      if (repl && now.indexOf(repl) === -1) return { ok: false, detail: 'post-check: reemplazo no encontrado' };
      return { ok: true, detail: 'post-check ok' };
    }
    if (tool === 'delete_file') {
      const f = resolveInCwd(args.path);
      if (fs.existsSync(f)) return { ok: false, detail: 'post-check: ruta sigue existiendo' };
      return { ok: true, detail: 'post-check ok' };
    }
    if (tool === 'move_file') {
      const from = resolveInCwd(args.from);
      const to = resolveInCwd(args.to);
      if (!fs.existsSync(to)) return { ok: false, detail: 'post-check: destino no existe' };
      if (fs.existsSync(from)) return { ok: false, detail: 'post-check: origen sigue existiendo' };
      return { ok: true, detail: 'post-check ok' };
    }
    if (tool === 'open_browser') {
      return /^https?:\/\//i.test(String(args.url || ''))
        ? { ok: true, detail: 'post-check ok' }
        : { ok: false, detail: 'post-check: url inválida' };
    }
    if (tool === 'run_command' || tool === 'npm_run' || tool === 'git_commit') {
      const s = String(summary || '');
      if (/\bexit\s+0\b/i.test(s)) return { ok: true, detail: 'post-check ok' };
      return { ok: false, detail: 'post-check: comando sin exit 0' };
    }
    if (tool === 'list_dir') {
      return result ? { ok: true, detail: 'post-check ok' } : { ok: false, detail: 'post-check: sin salida' };
    }
    if (tool === 'read_file') {
      return (result !== undefined && result !== null) ? { ok: true, detail: 'post-check ok' } : { ok: false, detail: 'post-check: lectura vacía' };
    }
    if (tool === 'search_in_files' || tool === 'notify') {
      return { ok: true, detail: 'post-check ok' };
    }
  } catch (e) {
    return { ok: false, detail: 'post-check error: ' + e.message };
  }
  return { ok: true, detail: '' };
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
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { cwd: state.cwd, windowsHide: true });
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
    if (name === 'open_browser') {
      const url = String(args.url || '');
      if (!/^https?:\/\//i.test(url)) return cb('Error: URL inválida (debe empezar con http:// o https://)', 'error');
      // Usar el shell de Windows para abrir el navegador predeterminado.
      const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', url], { windowsHide: true });
      // Un spawn fallido emite 'error' Y DESPUES 'close': sin esta guardia cb() se
      // llamaria dos veces y el bucle del agente perderia el resultado de otra
      // herramienta de la misma tanda (ver comentario en loop()).
      let finished = false;
      const done = (txt, s) => { if (finished) return; finished = true; cb(txt, s); };
      child.on('close', () => done('Abierto en el navegador: ' + url, 'abierto'));
      child.on('error', e => done('Error: ' + e.message, 'error'));
      return;
    }
    if (name === 'git_commit') {
      const msg = String(args.message || 'chore: update').replace(/"/g, "'");
      const child = spawn('cmd.exe', ['/d', '/s', '/c', 'git add -A && git commit -m "' + msg + '"'], { cwd: state.cwd, windowsHide: true });
      let out = ''; let finished = false;
      const done = (txt, s) => { if (finished) return; finished = true; try { clearTimeout(timer); } catch (e) {} cb(txt, s); };
      const timer = setTimeout(() => { try { child.kill(); } catch (_) {} done('(timeout)', 'timeout'); }, 30000);
      child.stdout.on('data', d => (out += d)); child.stderr.on('data', d => (out += d));
      child.on('close', code => done('(exit ' + code + ')\n' + out.slice(0, 4000), 'exit ' + code));
      child.on('error', e => done('Error: ' + e.message, 'error'));
      return;
    }
    if (name === 'npm_run') {
      const script = String(args.script || '').replace(/[^a-zA-Z0-9:_-]/g, '');
      const extra = args.args ? ' ' + String(args.args).slice(0, 200) : '';
      const child = spawn('cmd.exe', ['/d', '/s', '/c', 'npm run ' + script + extra], { cwd: state.cwd, windowsHide: true });
      let out = ''; let finished = false;
      const done = (txt, s) => { if (finished) return; finished = true; try { clearTimeout(timer); } catch (e) {} cb(txt, s); };
      const timer = setTimeout(() => { try { child.kill(); } catch (_) {} done('(cancelado >120s)\n' + out.slice(0, 8000), 'timeout'); }, 120000);
      child.stdout.on('data', d => (out += d)); child.stderr.on('data', d => (out += d));
      child.on('close', code => done('(exit ' + code + ')\n' + out.slice(0, 8000), 'exit ' + code));
      child.on('error', e => done('Error: ' + e.message, 'error'));
      return;
    }
    if (name === 'notify') {
      const title = String(args.title || 'HanstlerS').replace(/'/g, '').slice(0, 60);
      const msg = String(args.message || '').replace(/'/g, '').slice(0, 200);
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(4000, '${title}', '${msg}', [System.Windows.Forms.ToolTipIcon]::None); Start-Sleep 5; $n.Visible = $false`;
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
      let finished = false;
      const done = (txt, s) => { if (finished) return; finished = true; cb(txt, s); };
      child.on('close', () => done('Notificación enviada: ' + title, 'notificado'));
      child.on('error', e => done('Error: ' + e.message, 'error'));
      return;
    }
    if (name === 'open_repo') {
      return openRepoWorkspace(args.repo, (err, info) => {
        if (err) return cb('Error: ' + err.message, 'error');
        cb('Repo ' + info.action + ': ' + info.repoRef + '\nCarpeta de trabajo ahora: ' + info.path +
          '\nYa puedes leer/editar sus archivos con rutas relativas.', info.action + ' ' + info.repoRef);
      });
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

// Versión streaming de azureChat: llama onChunk(delta) por cada token y onDone(err) al final.
// Usar cuando NO se necesita leer tool_calls (solo texto libre).
function azureChatStream(cfg, messages, onChunk, onDone) {
  const ep = cfg.endpoint.replace(/\/$/, '');
  const u = new URL(ep + '/openai/deployments/' + cfg.deployment + '/chat/completions?api-version=' + (cfg.apiVersion || '2024-10-21'));
  const body = { messages, stream: true };
  const payload = JSON.stringify(body);
  const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': cfg.key, 'Content-Length': Buffer.byteLength(payload) } },
    (resp) => {
      if (resp.statusCode >= 400) {
        let e = ''; resp.on('data', d => (e += d));
        resp.on('end', () => onDone(new Error('Azure ' + resp.statusCode + ': ' + e.slice(0, 200))));
        return;
      }
      let buf = '';
      resp.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') continue;
          try { const j = JSON.parse(data); const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content; if (delta) onChunk(delta); } catch (e) {}
        }
      });
      resp.on('end', () => onDone(null));
    });
  req.on('error', e => onDone(e));
  req.write(payload); req.end();
}

// Versión streaming con herramientas: streamea texto EN VIVO y acumula tool_calls.
// cb(err, message) al terminar — message tiene la misma forma que choices[0].message.
function azureChatStreamTools(cfg, messages, tools, onChunk, cb) {
  const ep = cfg.endpoint.replace(/\/$/, '');
  const u = new URL(ep + '/openai/deployments/' + cfg.deployment + '/chat/completions?api-version=' + (cfg.apiVersion || '2024-10-21'));
  const body = { messages, stream: true }; if (tools) body.tools = tools;
  const payload = JSON.stringify(body);
  // Acumuladores de delta
  let textContent = '';
  const toolCallMap = {}; // index -> {id, type, function:{name, arguments}}
  const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': cfg.key, 'Content-Length': Buffer.byteLength(payload) } },
    (resp) => {
      if (resp.statusCode >= 400) {
        let e = ''; resp.on('data', d => (e += d));
        resp.on('end', () => cb(new Error('Azure ' + resp.statusCode + ': ' + e.slice(0, 200))));
        return;
      }
      let buf = '';
      resp.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices && j.choices[0] && j.choices[0].delta;
            if (!delta) continue;
            // Texto: streamear en vivo
            if (delta.content) { textContent += delta.content; onChunk(delta.content); }
            // Tool calls: acumular deltas
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCallMap[tc.index]) toolCallMap[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                const entry = toolCallMap[tc.index];
                if (tc.id) entry.id += tc.id;
                if (tc.function && tc.function.name) entry.function.name += tc.function.name;
                if (tc.function && tc.function.arguments) entry.function.arguments += tc.function.arguments;
              }
            }
          } catch (e) {}
        }
      });
      resp.on('end', () => {
        const tool_calls = Object.keys(toolCallMap).sort((a, b) => a - b).map(k => toolCallMap[k]);
        const msg = { role: 'assistant', content: textContent || null };
        if (tool_calls.length) msg.tool_calls = tool_calls;
        cb(null, msg);
      });
    });
  req.on('error', e => cb(e));
  req.write(payload); req.end();
}

// ===== Cerebro Gemini: function calling para el bucle de agente =====
// Convierte AGENT_TOOLS (formato OpenAI) a functionDeclarations de Gemini. Solo
// cambia el envoltorio: el JSON Schema de `parameters` es compatible tal cual.
function geminiFunctionDeclarations(tools) {
  return (tools || [])
    .map((t) => (t && t.function) ? t.function : t)
    .filter((f) => f && f.name)
    .map((f) => {
      const decl = { name: f.name, description: f.description || '' };
      const p = f.parameters;
      // Gemini rechaza un objeto de parametros sin propiedades: se omite.
      if (p && p.properties && Object.keys(p.properties).length) decl.parameters = p;
      return decl;
    });
}

// Contenido OpenAI (texto suelto, o array con texto e imagenes) -> parts de Gemini.
function geminiPartsFromContent(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  const parts = [];
  (Array.isArray(content) ? content : []).forEach((c) => {
    if (!c) return;
    if (c.type === 'text' && c.text) parts.push({ text: String(c.text) });
    if (c.type === 'image_url' && c.image_url && c.image_url.url) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(String(c.image_url.url));
      if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
    }
  });
  return parts;
}

// Historial estilo OpenAI -> contents + systemInstruction de Gemini.
// Los turnos del mismo rol se fusionan porque Gemini exige alternancia y porque
// el numero de functionResponse debe casar con el de functionCall del turno
// anterior del modelo (varias herramientas en paralelo = un solo turno).
function toGeminiAgentContents(messages) {
  const sys = [];
  const turns = [];
  const nombrePorId = {};
  const pushTurn = (role, parts, meta) => {
    if (!parts || !parts.length) return;
    turns.push({
      role: role,
      parts: parts,
      fromTool: !!(meta && meta.fromTool),
      hasFnCall: !!(meta && meta.hasFnCall)
    });
  };
  const pushUserText = (parts) => {
    if (!parts || !parts.length) return;
    const ultimo = turns[turns.length - 1];
    if (ultimo && ultimo.role === 'user' && !ultimo.fromTool) { ultimo.parts = ultimo.parts.concat(parts); return; }
    pushTurn('user', parts, { fromTool: false, hasFnCall: false });
  };
  const pushModel = (parts, hasFnCall) => {
    if (!parts || !parts.length) return;
    const ultimo = turns[turns.length - 1];
    if (ultimo && ultimo.role === 'model' && !ultimo.hasFnCall && !hasFnCall) {
      ultimo.parts = ultimo.parts.concat(parts);
      return;
    }
    pushTurn('model', parts, { fromTool: false, hasFnCall: !!hasFnCall });
  };
  const pushToolResponse = (part) => {
    if (!part) return;
    const ultimo = turns[turns.length - 1];
    if (ultimo && ultimo.role === 'user' && ultimo.fromTool) { ultimo.parts.push(part); return; }
    pushTurn('user', [part], { fromTool: true, hasFnCall: false });
  };
  (messages || []).forEach((m) => {
    if (!m) return;
    if (m.role === 'system') { if (m.content) sys.push(String(m.content)); return; }
    if (m.role === 'user') { pushUserText(geminiPartsFromContent(m.content)); return; }
    if (m.role === 'assistant') {
      (m.tool_calls || []).forEach((tc) => {
        nombrePorId[tc.id] = {
          name: (tc.function && tc.function.name) || 'tool',
          gid: tc._geminiId || null
        };
      });
      // Gemini 3.x firma cada part con un `thoughtSignature` opaco y EXIGE que se
      // le devuelva tal cual; reconstruir la part desde {name,args} da un 400.
      // Por eso se reenvian las parts crudas del modelo cuando las tenemos.
      if (m._geminiParts && m._geminiParts.length) {
        const hasFn = m._geminiParts.some((p) => !!(p && p.functionCall));
        pushModel(m._geminiParts, hasFn);
        return;
      }
      const parts = [];
      let hasFnCall = false;
      if (m.content) parts.push({ text: String(m.content) });
      (m.tool_calls || []).forEach((tc) => {
        let args = {};
        try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) { args = {}; }
        parts.push({ functionCall: { name: (tc.function && tc.function.name) || 'tool', args: args } });
        hasFnCall = true;
      });
      pushModel(parts, hasFnCall);
      return;
    }
    if (m.role === 'tool') {
      const info = nombrePorId[m.tool_call_id] || {};
      const salida = String(m.content == null ? '' : m.content);
      const fr = { name: info.name || 'tool', response: { output: salida } };
      if (info.gid) fr.id = info.gid;
      pushToolResponse({ functionResponse: fr });
    }
  });
  const filtered = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t && t.fromTool) {
      const prev = filtered[filtered.length - 1];
      if (!(prev && prev.role === 'model' && prev.hasFnCall)) continue;
    }
    filtered.push(t);
  }
  // Medido contra la API real (gemini-3.8-flash), no supuesto: de 10 formas de
  // historial descuadrado solo devuelve 400 en dos.
  //   - que el historial empiece por un functionResponse: no tiene delante su
  //     functionCall. Se descarta solo eso; Gemini SI acepta empezar por 'model',
  //     y recortar tambien los 'model' iniciales tiraba, en un historial ya
  //     recortado, justo el tramo con lo que el agente acababa de leer.
  //   - que TERMINE en un functionCall sin responder -> 400 pidiendo thought_signature.
  // Los descuadres intermedios (mas o menos respuestas que llamadas) los tolera,
  // asi que no se tocan: recortarlos seria tirar contexto util.
  while (filtered.length && filtered[0].fromTool) filtered.shift();
  while (filtered.length) {
    const ultimo = filtered[filtered.length - 1];
    if (ultimo.role === 'model' && ultimo.hasFnCall) { filtered.pop(); continue; }
    break;
  }
  // Quitar el ultimo turno puede dejar expuesto un functionResponse al principio.
  while (filtered.length && filtered[0].fromTool) filtered.shift();
  // Gemini 3.x exige la thoughtSignature de cada functionCall. Cuando NO la
  // tenemos (conversacion que venia de Copilot/Azure, o transcript guardado por
  // una version anterior) reconstruir la part desde {name,args} da un 400 en
  // cuanto el historial termina en la respuesta de la herramienta, que es
  // justo como queda el bucle del agente tras ejecutar algo. Verificado contra
  // la API real: con firma 200, sin firma 400.
  // En vez de tirar ese tramo del historial, se degrada a texto plano: el
  // modelo pierde la estructura de la llamada pero conserva lo que se ejecuto y
  // lo que devolvio, que es lo que de verdad importa para seguir la tarea.
  // El texto de la degradacion va en tercera persona y marcado como acta de la
  // sesion, NO en primera persona ("Llamé a la herramienta X..."). Medido
  // contra la API real: con la redaccion en primera persona el modelo acaba
  // imitando el patron y ESCRIBE la llamada como texto en vez de emitirla, con
  // lo que el agente se detiene a mitad de tarea. Empeora cuanto mas larga es
  // la conversacion (0/12 con 3 rondas, 1/12 con 8). Con esta redaccion:
  // 0 de 34 muestras narraron, y el contenido se conserva igual de bien.
  for (let i = 0; i < filtered.length; i++) {
    const t = filtered[i];
    if (!t.hasFnCall) continue;
    if (t.parts.some((p) => p.functionCall && p.thoughtSignature)) continue;
    const descripcion = t.parts.map((p) => {
      if (p.text) return String(p.text);
      if (!p.functionCall) return '';
      let args = '';
      try { args = JSON.stringify(p.functionCall.args || {}); } catch (e) { args = '{}'; }
      return '[registro de la sesion] Se ejecuto la herramienta ' + p.functionCall.name +
        ' con los argumentos ' + args.slice(0, 2000);
    }).filter(Boolean).join('\n');
    t.parts = [{ text: descripcion || '[registro de la sesion] Se ejecuto una herramienta.' }];
    t.hasFnCall = false;
    const sig = filtered[i + 1];
    if (!sig || !sig.fromTool) continue;
    const resultados = sig.parts.map((p) => {
      if (p.text) return String(p.text);
      if (!p.functionResponse) return '';
      const r = p.functionResponse.response || {};
      return '[registro de la sesion] Salida de ' + p.functionResponse.name + ':\n' +
        String(r.output == null ? '' : r.output);
    }).filter(Boolean).join('\n\n');
    sig.parts = [{ text: resultados || '[registro de la sesion] (sin resultado)' }];
    sig.fromTool = false;
  }
  // Al degradar pueden quedar dos turnos seguidos del mismo rol; Gemini lo
  // acepta, pero fusionarlos deja un historial mas limpio y barato.
  for (let i = filtered.length - 1; i > 0; i--) {
    const a = filtered[i - 1];
    const b = filtered[i];
    if (a.role !== b.role || a.hasFnCall || b.hasFnCall || b.fromTool || a.fromTool) continue;
    if (!a.parts.every((p) => p.text) || !b.parts.every((p) => p.text)) continue;
    a.parts = [{ text: a.parts.map((p) => p.text).join('\n') + '\n' + b.parts.map((p) => p.text).join('\n') }];
    filtered.splice(i, 1);
  }
  const contents = filtered.map((t) => ({ role: t.role, parts: t.parts }));
  return {
    contents: contents,
    systemInstruction: sys.length ? { parts: [{ text: sys.join('\n\n') }] } : null
  };
}

// Los flash se saturan a ratos: 503/429 son transitorios y merecen reintento.
const GEMINI_REINTENTABLES = [429, 500, 502, 503];
const GEMINI_MAX_REINTENTOS = 3;

// Espera antes de reintentar. Antes era lineal (1.5s, 3s, 4.5s) y suele ser
// poco para un 429: Google dice EXACTAMENTE cuanto esperar en la cabecera
// Retry-After (o en RetryInfo del cuerpo) y hay que hacerle caso. Sin eso, los
// tres reintentos se gastan demasiado pronto y el turno muere igual.
// El jitter evita que varias peticiones en curso reintenten todas a la vez.
function geminiEsperaReintento(intento, headers, raw) {
  const h = headers || {};
  let segundos = 0;
  // Bandera aparte: un Retry-After de 0 es una pista valida ("reintenta ya"),
  // y comprobar solo `if (!segundos)` lo confundiria con no tener pista.
  let hayPista = false;

  const ra = h['retry-after'];
  if (ra != null) {
    const n = Number(String(ra).trim());
    if (Number.isFinite(n) && n >= 0) { segundos = n; hayPista = true; }
    else {
      const fecha = Date.parse(String(ra));
      if (Number.isFinite(fecha)) { segundos = Math.max(0, (fecha - Date.now()) / 1000); hayPista = true; }
    }
  }

  if (!hayPista) {
    // google.rpc.RetryInfo llega dentro de error.details como "12s".
    try {
      const j = JSON.parse(String(raw || '{}'));
      const det = (j && j.error && j.error.details) || [];
      for (const d of det) {
        const delay = d && (d.retryDelay || (d.retryInfo && d.retryInfo.retryDelay));
        if (delay) {
          const n = parseFloat(String(delay));
          if (Number.isFinite(n) && n >= 0) { segundos = n; hayPista = true; break; }
        }
      }
    } catch (e) {}
  }

  // Sin pista del servidor: retroceso exponencial 2s, 4s, 8s.
  let ms = hayPista ? segundos * 1000 : Math.pow(2, intento) * 1000;
  ms = Math.min(ms, 60000);
  return Math.round(ms + Math.random() * 500);
}

// Misma firma que azureChatStreamTools, para que el bucle de agente no note la
// diferencia: (messages, tools, onChunk, cb) -> cb(err, {role, content, tool_calls}).
// Mensajes con los que Gemini rechaza la ESTRUCTURA del historial de
// herramientas. Verificados uno a uno contra la API real: son los unicos 400
// que no se arreglan reintentando, porque el historial vuelve a ir igual.
function geminiErrorDeHistorial(raw) {
  let msg = '';
  try { msg = JSON.parse(raw || '{}').error.message || ''; } catch (e) { msg = String(raw || ''); }
  return /thought_signature|function response turn|function call turn/i.test(msg);
}

// El historial que no tiene thoughtSignature se degrada a texto con un formato
// interno ("[registro de la sesion] ..."). Ese texto es andamiaje NUESTRO, no
// una respuesta: si el modelo acaba copiandolo -y con conversaciones largas
// ocurre- aparece en pantalla como si HanstlerS estuviera narrando lo que hace
// en vez de hacerlo. Aqui se recorta pase lo que pase, para que ese ruido no
// llegue nunca al usuario.
const REGISTRO_INTERNO_RE =
  /^\s*(?:\[registro de la sesion\][^\n]*|Llam[\u00e9e] a la herramienta [^\n]*|Resultado de [A-Za-z0-9_]+:[^\n]*)$/;

function limpiarRegistroInterno(texto) {
  if (!texto || texto.indexOf('registro de la sesion') === -1 &&
      texto.indexOf('Llamé a la herramienta') === -1 &&
      texto.indexOf('Llame a la herramienta') === -1) return texto;
  const lineas = String(texto).split('\n');
  const limpias = [];
  let dentro = false;
  lineas.forEach((l) => {
    if (REGISTRO_INTERNO_RE.test(l)) { dentro = true; return; }
    // La salida de una herramienta ocupa varias lineas; se descarta el bloque
    // entero hasta la siguiente linea en blanco.
    if (dentro) { if (!l.trim()) dentro = false; return; }
    limpias.push(l);
  });
  return limpias.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function geminiChatWithTools(cfg, model, messages, tools, onChunk, cb) {
  const conv = toGeminiAgentContents(messages);
  const body = {
    contents: conv.contents,
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
  };
  if (conv.systemInstruction) body.systemInstruction = conv.systemInstruction;
  const decls = geminiFunctionDeclarations(tools);
  if (decls.length) body.tools = [{ functionDeclarations: decls }];
  const payloadTools = JSON.stringify(body);
  const bodyPlain = {
    contents: conv.contents,
    generationConfig: { temperature: 0.15, maxOutputTokens: 8192 }
  };
  if (conv.systemInstruction) bodyPlain.systemInstruction = conv.systemInstruction;
  const payloadPlain = JSON.stringify(bodyPlain);
  const bodyRepair = {
    contents: conv.contents.concat([{ role: 'user', parts: [{ text: 'Responde SOLO en texto plano en espanol. No llames herramientas ni funciones en esta respuesta.' }] }]),
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
  };
  if (conv.systemInstruction) bodyRepair.systemInstruction = conv.systemInstruction;
  const payloadRepair = JSON.stringify(bodyRepair);
  let liquidado = false;
  const terminar = (err, msg) => { if (liquidado) return; liquidado = true; cb(err, msg); };
  let intento = 0;
  let intentoPlano = false;
  let intentoFlash = false;
  let intentoReparacion = false;
  let intentoSinHerramientas = false;
  // Convierte todo el historial a texto plano, sin functionCall ni
  // functionResponse: es la forma que Gemini siempre acepta.
  const payloadDegradado = () => {
    const planos = conv.contents.map((t) => {
      const parts = t.parts.map((p) => {
        if (p.text) return { text: String(p.text) };
        if (p.functionCall) {
          let args = '';
          try { args = JSON.stringify(p.functionCall.args || {}); } catch (e) { args = '{}'; }
          // Misma redaccion en tercera persona que en toGeminiAgentContents: en
          // primera persona el modelo imita el patron y narra la llamada.
          return { text: '[registro de la sesion] Se ejecuto la herramienta ' + p.functionCall.name +
            ' con los argumentos ' + args.slice(0, 2000) };
        }
        if (p.functionResponse) {
          const r = p.functionResponse.response || {};
          return { text: '[registro de la sesion] Salida de ' + p.functionResponse.name + ':\n' +
            String(r.output == null ? '' : r.output) };
        }
        return p;
      });
      return { role: t.role, parts: parts.length ? parts : [{ text: '(sin contenido)' }] };
    });
    const b = { contents: planos, generationConfig: { temperature: 0.2, maxOutputTokens: 8192 } };
    if (conv.systemInstruction) b.systemInstruction = conv.systemInstruction;
    if (decls.length) b.tools = [{ functionDeclarations: decls }];
    return JSON.stringify(b);
  };
  const swapEndpointModel = (endpoint, nextModel) => String(endpoint || '').replace(
    /\/models\/[^:]+:generateContent/i,
    '/models/' + encodeURIComponent(String(nextModel || '').trim()) + ':generateContent'
  );

  const lanzar = (endpoint, authHeader, sinTools, modelActivo, payloadOverride) => {
    const modelUsed = String(modelActivo || model || '').trim();
    const payload = payloadOverride || (sinTools ? payloadPlain : payloadTools);
    const u = new URL(endpoint);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      timeout: 180000,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }, authHeader || {})
    }, (resp) => {
      let raw = '';
      resp.on('data', (d) => {
        raw += d.toString();
        if (raw.length > 4 * 1024 * 1024) raw = raw.slice(-4 * 1024 * 1024);
      });
      resp.on('end', () => {
        if (liquidado) return;
        if (resp.statusCode >= 400) {
          if (GEMINI_REINTENTABLES.indexOf(resp.statusCode) !== -1 && intento < GEMINI_MAX_REINTENTOS) {
            intento++;
            const espera = geminiEsperaReintento(intento, resp.headers, raw);
            return setTimeout(() => lanzar(endpoint, authHeader, sinTools, modelUsed, payloadOverride), espera);
          }
          // Red de seguridad: un 400 por la estructura de las herramientas deja
          // la conversacion MUERTA para siempre, porque cada turno reenvia el
          // historial entero y vuelve a fallar igual. Antes que eso, se reenvia
          // el historial degradado a texto plano: se pierde la estructura de las
          // llamadas pero se conserva que se ejecuto y que devolvio, y el usuario
          // puede seguir trabajando.
          if (resp.statusCode === 400 && !intentoSinHerramientas && geminiErrorDeHistorial(raw)) {
            intentoSinHerramientas = true;
            return lanzar(endpoint, authHeader, sinTools, modelUsed, payloadDegradado());
          }
          return terminar(new Error(summarizeVertexError(resp.statusCode, raw, modelUsed)));
        }
        let j = null;
        try { j = JSON.parse(raw || '{}'); } catch (e) { return terminar(new Error('Gemini devolvio una respuesta invalida.')); }
        const cand = ((j.candidates || [])[0]) || {};
        const parts = (cand.content && cand.content.parts) || [];
        let texto = '';
        const tool_calls = [];
        parts.forEach((p, i) => {
          if (!p) return;
          if (typeof p.text === 'string') texto += p.text;
          if (p.functionCall) {
            tool_calls.push({
              id: p.functionCall.id || ('gc_' + Date.now().toString(36) + '_' + i + '_' + Math.random().toString(36).slice(2, 6)),
              _geminiId: p.functionCall.id || null,
              type: 'function',
              function: {
                name: p.functionCall.name,
                arguments: JSON.stringify(p.functionCall.args || {})
              }
            });
          }
        });
        const usage = j.usageMetadata || {};
        const pt = Number(usage.promptTokenCount);
        const ot = Number(usage.candidatesTokenCount);
        if ((Number.isFinite(pt) && pt > 0) || (Number.isFinite(ot) && ot > 0)) {
          try { addGoogleTokens(modelUsed, pt, ot); } catch (e) {}
        }
        if (!texto && !tool_calls.length) {
          const fin = normalizeGeminiFinishReason(cand.finishReason || '');
          if (!sinTools && GEMINI_NO_CONTENT_RETRY_REASONS.has(fin)) {
            const flashModel = String(cfg && cfg.models && cfg.models.flash || '').trim();
            if (!intentoFlash && flashModel && flashModel !== modelUsed) {
              intentoFlash = true;
              return lanzar(swapEndpointModel(endpoint, flashModel), authHeader, false, flashModel);
            }
          }
          if (!sinTools && !intentoPlano && GEMINI_NO_CONTENT_RETRY_REASONS.has(fin)) {
            intentoPlano = true;
            return lanzar(endpoint, authHeader, true, modelUsed);
          }
          if (sinTools && !intentoReparacion && GEMINI_NO_CONTENT_RETRY_REASONS.has(fin)) {
            intentoReparacion = true;
            return lanzar(endpoint, authHeader, true, modelUsed, payloadRepair);
          }
          return terminar(new Error(summarizeGeminiNoContent(fin)));
        }
        texto = limpiarRegistroInterno(texto);
        if (texto && onChunk) onChunk(texto);
        const msg = { role: 'assistant', content: texto || null };
        if (tool_calls.length) msg.tool_calls = tool_calls;
        // Se conservan para poder reenviarlas intactas en el siguiente turno.
        if (parts.length) msg._geminiParts = parts;
        return terminar(null, msg);
      });
    });
    req.on('error', (e) => {
      if (liquidado) return;
      if (intento < GEMINI_MAX_REINTENTOS) {
        intento++;
        // Hay que reenviar el MISMO payload: omitir payloadOverride hacia que
        // el reintento mandara una conversacion distinta a la que fallo.
        const espera = geminiEsperaReintento(intento, null, null);
        return setTimeout(() => lanzar(endpoint, authHeader, sinTools, modelUsed, payloadOverride), espera);
      }
      return terminar(e);
    });
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (e) {} });
    req.write(payload);
    req.end();
  };

  if (cfg.authMode === 'api-key') {
    return lanzar('https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(cfg.apiKey), {}, false, model);
  }
  try {
    getGcpAccessToken((tokErr, token) => {
      if (tokErr) return terminar(new Error('Vertex auth: ' + tokErr.message));
      return lanzar('https://' + cfg.region + '-aiplatform.googleapis.com/v1/projects/' +
        encodeURIComponent(cfg.projectId) + '/locations/' + encodeURIComponent(cfg.region) +
        '/publishers/google/models/' + encodeURIComponent(model) + ':generateContent',
        { 'Authorization': 'Bearer ' + token }, false, model);
    });
  } catch (e) {
    terminar(new Error('Vertex auth: ' + e.message));
  }
}

// Cerebros intercambiables para el bucle de agente.
// Quita los campos internos (_geminiParts, _geminiId) antes de hablar con Azure,
// por si una conversacion empezada en Vertex sigue con otro proveedor.
function sinCamposInternos(messages) {
  return (messages || []).map((m) => {
    if (!m || (!m._geminiParts && !(m.tool_calls || []).some((t) => t && t._geminiId !== undefined))) return m;
    const copia = Object.assign({}, m);
    delete copia._geminiParts;
    if (copia.tool_calls) {
      copia.tool_calls = copia.tool_calls.map((t) => {
        const tc = Object.assign({}, t);
        delete tc._geminiId;
        return tc;
      });
    }
    return copia;
  });
}
function azureBrain(cfg) {
  return {
    label: 'Azure',
    chatTools: (messages, tools, onChunk, cb) => azureChatStreamTools(cfg, sinCamposInternos(messages), tools, onChunk, cb),
    chatPlain: (messages, onChunk, cb) => azureChatStream(cfg, sinCamposInternos(messages), onChunk, cb)
  };
}
function vertexBrain(cfg, model) {
  return {
    label: 'Vertex (' + model + ')',
    chatTools: (messages, tools, onChunk, cb) => geminiChatWithTools(cfg, model, messages, tools, onChunk, cb),
    // Cierre sin herramientas: se pide texto puro y se avisa al terminar.
    chatPlain: (messages, onChunk, cb) => geminiChatWithTools(cfg, model, messages, null, onChunk, (err) => cb(err))
  };
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
// El transcript COMPLETO (incluidos los mensajes role:'tool' con el contenido real
// de lo que el agente leyo o ejecuto) vive AQUI, en el servidor, indexado por
// conversacion, y ademas en disco para sobrevivir al reinicio de la app.
// Antes el contexto se rearmaba en cada turno desde lo que mandaba el cliente, que
// solo tiene el texto de las burbujas: eso descartaba toda llamada a herramienta y
// su resultado, asi que el modelo sabia QUE habia leido un archivo pero no QUE
// decia, y volvia a leerlo una y otra vez.
// Se guarda solo el CUERPO de la conversacion; el preambulo de mensajes 'system'
// se vuelve a construir en cada turno porque depende de state.cwd y del proyecto.
const AGENT_CTX_MAX_CHARS = 200000;
const AGENT_DIR = path.join(os.homedir(), '.hanstlers', 'agent');

function msgSize(m) { try { return JSON.stringify(m).length; } catch (e) { return 0; } }

function sanitizeAgentBody(body) {
  if (!Array.isArray(body) || !body.length) return [];
  const out = [];
  let i = 0;
  while (i < body.length) {
    const m = body[i] || null;
    const role = String(m && m.role || '');
    if (role === 'tool') {
      // Conserva tools sueltos del transcript: toGeminiAgentContents ya descarta
      // cualquier tool huérfano al serializar para la API.
      out.push(m);
      i++;
      continue;
    }
    if (role !== 'assistant') {
      out.push(m);
      i++;
      continue;
    }

    const rawCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (!rawCalls.length) {
      out.push(m);
      i++;
      continue;
    }

    const ids = rawCalls
      .map((tc) => String(tc && tc.id || '').trim())
      .filter(Boolean);
    if (ids.length !== rawCalls.length) {
      const plain = Object.assign({}, m);
      delete plain.tool_calls;
      delete plain._geminiParts;
      if (plain.content) out.push(plain);
      i++;
      continue;
    }

    const byId = {};
    let j = i + 1;
    while (j < body.length) {
      const tm = body[j] || null;
      if (String(tm && tm.role || '') !== 'tool') break;
      const tid = String(tm && tm.tool_call_id || '').trim();
      if (tid && byId[tid] === undefined) byId[tid] = tm;
      j++;
    }

    const complete = ids.every((id) => !!byId[id]);
    if (complete) {
      out.push(m);
      ids.forEach((id) => out.push(byId[id]));
    } else if (m.content) {
      const plain = Object.assign({}, m);
      delete plain.tool_calls;
      delete plain._geminiParts;
      out.push(plain);
    }
    i = j;
  }
  return out;
}

// Recorta por el principio. Nunca deja un mensaje role:'tool' huerfano al frente:
// la API devuelve 400 si un 'tool' no va precedido del 'assistant' que lo pidio.
function trimAgentMessages(body, maxChars) {
  if (!Array.isArray(body) || !body.length) return [];
  const limit = maxChars || AGENT_CTX_MAX_CHARS;
  let total = 0;
  for (let i = 0; i < body.length; i++) total += msgSize(body[i]);
  let cut = 0;
  while (cut < body.length && total > limit) { total -= msgSize(body[cut]); cut++; }
  while (cut < body.length && body[cut] && body[cut].role === 'tool') cut++;
  const sliced = cut === 0 ? body : body.slice(cut);
  return sanitizeAgentBody(sliced);
}

function agentFile(id) { return path.join(AGENT_DIR, String(id).replace(/[^a-z0-9_-]/gi, '') + '.json'); }
function saveAgentTranscript(convId, body) {
  if (!convId) return;
  try {
    fs.mkdirSync(AGENT_DIR, { recursive: true });
    fs.writeFileSync(agentFile(convId), JSON.stringify(body));
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

// preamble = mensajes 'system' recien construidos. Se antepone al cuerpo guardado.
function buildAgentMessages(convId, history, preamble) {
  state.convAgentMessages = state.convAgentMessages || {};
  let prior = convId ? state.convAgentMessages[convId] : null;
  if (!(Array.isArray(prior) && prior.length)) prior = loadAgentTranscript(convId);
  const bodyRaw = (Array.isArray(prior) && prior.length) ? prior : (history || []);
  const body = sanitizeAgentBody(bodyRaw);
  const rawSig = (() => { try { return JSON.stringify(bodyRaw); } catch (e) { return ''; } })();
  const cleanSig = (() => { try { return JSON.stringify(body); } catch (e) { return ''; } })();
  if (convId && Array.isArray(bodyRaw) && bodyRaw.length && rawSig !== cleanSig) {
    state.convAgentMessages[convId] = body;
    saveAgentTranscript(convId, body);
  }
  return (preamble || []).concat(body);
}

// El modelo suele ANUNCIAR lo que hara y devolver el turno sin llamar a ninguna
// herramienta ("Voy a revisar los archivos..."). El bucle lo tomaba por respuesta
// final y cerraba el trabajo ahi: de ahi los "jobs muy cortos que no ejecutan nada".
//
// El texto se compara SIN acentos. La lista se escribio sin ellos pero el modelo
// responde con ellos, asi que "procedere" no casaba con "procedere" acentuado y
// 12 de cada 15 anuncios reales se colaban: el trabajo se cerraba a medias y
// habia que escribir "sigue" a mano en cada paso.
function sinAcentos(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
const ANNOUNCE_RE = /(voy a |vamos a |ire a |paso a |procedo a |procedere|ahora (voy|vamos|procedo|revis|le|cre|edit|modific|ejecut|busc|analiz|verific|corri|actualiz)|dejame |permiteme |empezare|empiezo por|comenzare|comienzo por|primero (voy|vamos|le|revis|analiz|verific)|a continuacion|acto seguido|enseguida (lo|le|revis|voy)|revisare|leere|creare|escribire|ejecutare|buscare|analizare|verificare|corregire|editare|modificare|actualizare|aplicare|comprobare|abrire|generare|anadire|instalare|probare|mirare|manos a la obra|un momento|dame un segundo|I'll |let me |I will |I'm going to |I am going to |next,? I|first,? I|now I('ll| will))/i;

// Un anuncio solo cuenta si el turno NO trae ya trabajo hecho: si el modelo
// escribio un bloque de codigo o un resumen largo, es una respuesta de verdad.
function soloAnuncia(texto) {
  const t = String(texto || '').trim();
  if (!t) return true;
  if (t.indexOf('\u0060\u0060\u0060') !== -1) return false;
  return ANNOUNCE_RE.test(sinAcentos(t));
}

function runAzureAgent(message, history, historySummary, send, onDone, onAbort, images, convId, brain) {
  // `brain` = cerebro del modelo (Azure o Vertex). Si no se pasa, se usa Azure:
  // la ruta historica queda intacta.
  if (!brain) {
    const cfg = loadAzure();
    if (!cfg) { send('error', 'Azure no configurado'); return onDone(1); }
    brain = azureBrain(cfg);
  }
  let aborted = false;
  if (onAbort) onAbort(() => { aborted = true; });
  const preamble = [
    { role: 'system', content: 'Eres HanstlerS, asistente de Cesar en modo AGENTE. Estás en Windows (PowerShell), carpeta de trabajo: ' + state.cwd + '.' + (state.projectCtx && state.projectCtx.cwd === state.cwd && state.projectCtx.text ? '\n\nCONTEXTO DEL PROYECTO:\n' + state.projectCtx.text : '') + '\n\nUsa las herramientas para leer/crear archivos y ejecutar comandos y COMPLETAR la tarea tú mismo (no solo expliques). SÉ DECIDIDO Y AUTÓNOMO: si la intención está clara, ACTÚA de inmediato sin pedir permiso ni confirmación. NO preguntes "¿quieres que...?", "¿procedo?", "¿te gustaría?": simplemente hazlo y muestra el resultado. Toma decisiones razonables por tu cuenta (nombres de archivo, estructura, enfoque) en lugar de consultar. Solo detente a preguntar si de verdad falta un dato imprescindible que no puedes deducir del contexto ni de los archivos (por ejemplo una credencial secreta), o si la acción es claramente destructiva e irreversible (borrar muchos archivos, formatear). En cualquier otro caso, procede hasta terminar. EFICIENCIA: cuando necesites leer o crear varios archivos, pide TODAS las herramientas a la vez en el mismo turno (varias tool_calls en paralelo) en lugar de una por una. No releas un archivo que ya leíste. Prioriza hacer los cambios (write_file) cuanto antes. Al usar run_command, NUNCA uses comandos interactivos ni que dejen una ventana/consola abierta (nada de -NoExit, Read-Host, pause, o abrir la app en primer plano); usa siempre modo no interactivo con parámetros. Responde en español, conciso. Cuando termines, resume lo que hiciste.' },
    { role: 'system', content: 'Si el usuario pide ir a una web (por ejemplo Cloudflare, Azure o GitHub), abre la página tú con la herramienta de navegador y ejecuta el flujo tú mismo. No le pidas al usuario que navegue manualmente.' },
    { role: 'system', content: 'REPOS: si el usuario menciona un repositorio de GitHub (por nombre, owner/repo o URL) y no es ya la carpeta de trabajo, llama PRIMERO a open_repo. Esa herramienta clona el repo automáticamente si no está en disco, hace git pull si ya estaba, y deja la carpeta de trabajo dentro del repo; después trabaja con rutas relativas. Nunca le pidas al usuario que clone a mano ni que te dé la ruta local: dedúcela con open_repo. Interpreta la intención en lenguaje natural ("abre X", "trabaja en X", "revisa X", "arregla Y en X") y ejecuta la tarea completa sobre ese repo.' }
  ];
  if (historySummary) preamble.push({ role: 'system', content: 'Resumen acumulado de la conversación previa:\n' + historySummary });
  const preambleLen = preamble.length;
  const messages = buildAgentMessages(convId, history, preamble);
  if (images && images.length) {
    const content = [{ type: 'text', text: message }];
    images.forEach((im) => content.push({ type: 'image_url', image_url: { url: im } }));
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: message });
  }

  let steps = 0;
  let nudges = 0;
  const MAX_STEPS = 40;
  const MAX_NUDGES = 6;
  const saveTranscript = () => {
    if (!convId) return;
    state.convAgentMessages = state.convAgentMessages || {};
    const body = trimAgentMessages(messages.slice(preambleLen), AGENT_CTX_MAX_CHARS);
    state.convAgentMessages[convId] = body;
    saveAgentTranscript(convId, body);
  };
  const OP_DELAY_MS = 4000;
  const iconOf = (n) => ({ list_dir: '📂', read_file: '📄', write_file: '✍️', apply_patch: '🩹', search_in_files: '🔎', delete_file: '🗑️', move_file: '📦', run_command: '⚙️', open_repo: '📥' }[n] || '🔧');
  // Ejecuta una herramienta, pidiendo confirmación si es peligrosa.
  function runToolGated(tc, args, whenDone) {
    const toolName = tc.function.name;
    const opMode = !!currentFeatures().operatorMode;
    const mainTouchedPath = toolName === 'move_file' ? (args.to || args.from || '') : (args.path || '');
    if (isMutatingTool(toolName) && isProtectedMainPath(mainTouchedPath) && !isExplicitMainEditRequest(message)) {
      return whenDone('Bloqueado: no edito archivos main* sin orden explícita del usuario.', 'bloqueado-main');
    }
    const execute = () => {
      const mut = isMutatingTool(toolName);
      const snaps = mut ? {
        main: snapshotPathForRollback(resolveInCwd(args.path)),
        from: toolName === 'move_file' ? snapshotPathForRollback(resolveInCwd(args.from)) : null,
        to: toolName === 'move_file' ? snapshotPathForRollback(resolveInCwd(args.to)) : null
      } : null;
      execAgentTool(toolName, args, (result, summary) => {
        // El agente puede mover la carpeta de trabajo (open_repo): avisar a la UI.
        if (toolName === 'open_repo' && !/^Error:/.test(String(result || ''))) send('cwd', { cwd: state.cwd });
        const chk = verifyPostCheck(toolName, args, result, summary);
        if (!mut) {
          if (chk.ok) return whenDone(result, ((summary || '') + ' · post-check ok').trim());
          return whenDone((String(result || '') + '\n⚠️ ' + chk.detail).trim(), ((summary || '') + ' · post-check falló').trim());
        }
        if (chk.ok) return whenDone(result, ((summary || '') + ' · post-check ok').trim());
        if (toolName === 'move_file') {
          try {
            const from = resolveInCwd(args.from);
            const to = resolveInCwd(args.to);
            if (fs.existsSync(to)) {
              fs.mkdirSync(path.dirname(from), { recursive: true });
              fs.renameSync(to, from);
            }
          } catch (e) {}
          if (snaps && snaps.to) rollbackSnapshot(snaps.to, () => {});
          return whenDone((String(result || '') + '\n⚠️ ' + chk.detail + '. Se aplicó rollback automático.').trim(), 'rollback automático');
        }
        rollbackSnapshot(snaps && snaps.main, (rbErr) => {
          if (rbErr) return whenDone((String(result || '') + '\n⚠️ ' + chk.detail + '. Falló rollback: ' + rbErr.message).trim(), 'post-check falló');
          return whenDone((String(result || '') + '\n⚠️ ' + chk.detail + '. Se aplicó rollback automático.').trim(), 'rollback automático');
        });
      });
    };
    if (opMode) {
      const suggestion = buildOperatorSuggestion(toolName, args);
      send('status', 'Operador: preparando acción…');
      send('chunk', '\n💡 ' + suggestion);
      send('chunk', '\n⏳ Ejecutaré en ' + Math.round(OP_DELAY_MS / 1000) + 's (pulsa Detener para cancelar).');
    }
    const startExecution = () => {
      if (aborted) return whenDone('Cancelado por el usuario antes de ejecutar la acción.', 'cancelado');
      // En modo confianza total, ejecutar todo sin pedir confirmación.
      if (trustMode) return execute();
      const reason = dangerReason(toolName, args);
      if (!reason) return execute();
      // Pedir confirmación al usuario y esperar su decisión.
      const cid = 'cf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      send('status', 'Esperando tu confirmación…');
      send('confirm', { id: cid, reason: reason, tool: toolName });
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; delete pendingConfirms[cid]; whenDone('Acción cancelada: el usuario no confirmó a tiempo.', 'sin confirmar'); } }, 120000);
      pendingConfirms[cid] = (approved) => {
        if (settled) return; settled = true; clearTimeout(timer); delete pendingConfirms[cid];
        if (approved) {
          send('chunk', ' ▶️ aprobado');
          execute();
        } else {
          send('chunk', ' ✋ rechazado por el usuario');
          whenDone('El usuario RECHAZÓ esta acción. No la ejecutes; busca otra forma o continúa con el resto de la tarea.', 'rechazado');
        }
      };
    };
    if (opMode) return setTimeout(startExecution, OP_DELAY_MS);
    return startExecution();
  }
  function loop() {
    if (aborted) { saveTranscript(); return onDone(1); }
    if (steps++ > MAX_STEPS) {
      send('status', 'Cerrando y resumiendo…');
      messages.push({ role: 'user', content: 'Has alcanzado el límite de pasos. Detente ahora: NO uses más herramientas. Resume en español lo que lograste, lo que quedó pendiente y cómo continuar.' });
      send('chunk', '\n\n⏸️ ');
      return brain.chatPlain(messages,
        (delta) => send('chunk', delta),
        (err) => {
          send('status', '');
          if (err) send('chunk', '(límite de pasos alcanzado)');
          send('canContinue', { reason: 'limite' });
          saveTranscript();
          onDone(0);
        }
      );
    }
    // Indicador vivo mientras Azure "piensa" (evita sensación de colgado).
    send('status', 'Pensando… (paso ' + steps + '/' + MAX_STEPS + ')');
    brain.chatTools(messages, AGENT_TOOLS, (delta) => send('chunk', delta), (err, msg) => {
      if (aborted) { send('status', ''); saveTranscript(); return onDone(1); }
      if (err) { send('status', ''); send('error', brain.label + ': ' + err.message); return onDone(1); }
      if (!msg) { send('status', ''); send('error', 'Respuesta vacía de ' + brain.label); return onDone(1); }
      messages.push(msg);
      if (msg.tool_calls && msg.tool_calls.length) {
        let pending = msg.tool_calls.length;
        send('status', 'Ejecutando ' + pending + (pending === 1 ? ' acción…' : ' acciones…'));
        const orderedToolResults = new Array(msg.tool_calls.length);
        const yaRespondio = new Array(msg.tool_calls.length).fill(false);
        msg.tool_calls.forEach((tc, idx) => {
          let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
          const label = (args.path || args.command || '').toString();
          const shortLabel = label.length > 60 ? '…' + label.slice(-58) : label;
          send('chunk', '\n' + iconOf(tc.function.name) + ' ' + tc.function.name + '(' + shortLabel + ') …');
          runToolGated(tc, args, (result, summary) => {
            // Si una herramienta contesta dos veces (p.ej. un spawn que emite
            // 'error' y luego 'close'), "pending" bajaria de mas y la tanda se
            // cerraria dejando huecos: Gemini recibiria menos functionResponse
            // que functionCall y responderia 400, envenenando la conversacion.
            if (yaRespondio[idx]) return;
            yaRespondio[idx] = true;
            send('chunk', ' ✓' + (summary ? ' ' + summary : ''));
            orderedToolResults[idx] = { role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 12000) };
            if (--pending === 0) {
              for (let i = 0; i < orderedToolResults.length; i++) {
                // Toda llamada necesita SU respuesta, aunque la herramienta no
                // haya devuelto nada: el numero de ambas debe cuadrar siempre.
                messages.push(orderedToolResults[i] || {
                  role: 'tool', tool_call_id: msg.tool_calls[i].id,
                  content: 'Error: la herramienta no devolvió ningún resultado.'
                });
              }
              send('chunk', '\n');
              loop();
            }
          });
        });
      } else {
        // Respuesta final de texto: ya se streameo token a token via onChunk arriba.
        const text = (msg.content || '').trim();
        // Si solo ANUNCIO una accion (o devolvio un turno vacio) sin ejecutar nada,
        // el trabajo NO ha terminado: empujalo a actuar en vez de cerrar el job.
        if (nudges < MAX_NUDGES && soloAnuncia(text)) {
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

// Bucle de agente (con herramientas) usando Gemini como cerebro. Reutiliza
// runAzureAgent entero, asi que hereda gating, post-check, rollback y transcript.
function runVertexAgent(message, history, historySummary, pick, send, onDone, onAbort, images, convId) {
  const cfg = loadVertex();
  if (!cfg) { send('error', 'Vertex no configurado'); return onDone(1); }
  send('route', { model: 'vertex:' + pick.model, reason: pick.reason + '+tools' });
  return runAzureAgent(message, history, historySummary, send, onDone, onAbort, images, convId,
    vertexBrain(cfg, pick.model));
}

// ===== Auto-arranque con Windows (registry Run key) =====
const AUTOSTART_NAME = 'HanstlerS';
function autostartExe() {
  // En Electron empaquetado, HANSTLERS_EXE = ruta de HanstlerS.exe.
  return process.env.HANSTLERS_EXE || process.execPath;
}
function getAutostart(cb) {
  if (process.platform !== 'win32') return cb(false, false);
  const child = spawn('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', AUTOSTART_NAME], { windowsHide: true });
  let out = '';
  child.stdout.on('data', d => (out += d));
  child.on('close', () => cb(out.indexOf(AUTOSTART_NAME) !== -1, true));
  child.on('error', () => cb(false, true));
}
function setAutostart(enabled, cb) {
  if (process.platform !== 'win32') return cb(false, false);
  let child;
  if (enabled) {
    child = spawn('reg.exe', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', AUTOSTART_NAME, '/t', 'REG_SZ', '/d', '"' + autostartExe() + '"', '/f'], { windowsHide: true });
  } else {
    child = spawn('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', AUTOSTART_NAME, '/f'], { windowsHide: true });
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
  model: process.env.HANSTLERS_MODEL || 'auto',
  projectCtx: null  // { cwd, text } — caché del contexto del proyecto
};

function defaultFeatures() {
  return {
    smartRouter: true,
    proResponseMode: false,
    agentBridgeMode: true,
    routeExecutionToAzureAgent: true,
    // Gemini ejecuta herramientas por si mismo: las tareas de ejecucion en modo
    // vertex ya no se desvian al agente de Azure.
    vertexAgentTools: true,
    preferClaudeForStrategy: true,
    preferXCoreForAudio: true,
    autoRouteForLocalAgent: true,
    operatorMode: false
  };
}
function loadFeatures() {
  const d = defaultFeatures();
  try {
    const raw = JSON.parse(fs.readFileSync(FEATURES_FILE, 'utf8'));
    if (raw && typeof raw === 'object') return Object.assign(d, raw);
  } catch (e) {}
  return d;
}
function saveFeatures(cfg) {
  try {
    fs.mkdirSync(path.dirname(FEATURES_FILE), { recursive: true });
    fs.writeFileSync(FEATURES_FILE, JSON.stringify(cfg));
  } catch (e) {}
}
let FEATURES = loadFeatures();
function currentFeatures() { return FEATURES || loadFeatures(); }
function reloadFeatures() { FEATURES = loadFeatures(); return FEATURES; }
function authEnabled() { return !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET && SESSION_SECRET && BASE_URL); }
const authSessions = new Map(); // sid -> { login, name, avatarUrl, isAdmin, at, githubToken }
const oauthStates = new Map();  // state -> createdAt
function sha256Hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function signSid(sid) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(sid)).digest('hex');
}
function parseCookies(req) {
  const raw = (req.headers.cookie || '').split(';');
  const out = {};
  raw.forEach((p) => {
    const i = p.indexOf('=');
    if (i <= 0) return;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}
function issueSessionCookie(res, sid) {
  const sig = signSid(sid);
  const secure = BASE_URL.toLowerCase().startsWith('https://');
  const cookie = [
    'hs_session=' + encodeURIComponent(sid + '.' + sig),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    'Max-Age=2592000'
  ].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', cookie);
}
function clearSessionCookie(res) {
  const secure = BASE_URL.toLowerCase().startsWith('https://');
  const cookie = [
    'hs_session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    'Max-Age=0'
  ].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', cookie);
}
function readAuthUser(req) {
  if (!authEnabled()) return { ok: true, user: null };
  const c = parseCookies(req);
  const tok = c.hs_session || '';
  const p = tok.split('.');
  if (p.length !== 2) return { ok: false, reason: 'no-session' };
  const sid = p[0], sig = p[1];
  const exp = signSid(sid);
  if (sig !== exp) return { ok: false, reason: 'bad-signature' };
  const u = authSessions.get(sid);
  if (!u) return { ok: false, reason: 'session-expired' };
  return { ok: true, user: u };
}
function githubRequest(pathName, token, cb) {
  const req = https.request({
    hostname: 'api.github.com',
    path: pathName,
    method: 'GET',
    timeout: 20000,
    headers: {
      'User-Agent': 'HanstlerS/1.0',
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token
    }
  }, (res) => {
    let body = '';
    res.on('data', (c) => body += c.toString());
    res.on('end', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return cb(new Error('github api ' + res.statusCode));
      try { cb(null, JSON.parse(body || '{}')); } catch (e) { cb(e); }
    });
  });
  req.on('error', cb);
  req.on('timeout', () => req.destroy(new Error('github api timeout')));
  req.end();
}
function buildRepoApiPath(repoRef, tail) {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(String(repoRef || '').trim());
  if (!m) return '';
  const owner = encodeURIComponent(m[1]);
  const repo = encodeURIComponent(m[2]);
  const suffix = tail ? ('/' + String(tail).replace(/^\/+/, '')) : '';
  return '/repos/' + owner + '/' + repo + suffix;
}
function decodeBase64Utf8(s) {
  try { return Buffer.from(String(s || '').replace(/\s+/g, ''), 'base64').toString('utf8'); } catch (e) {}
  return '';
}
let GH_BIN_CACHE = '';
function resolveGhBinary() {
  if (GH_BIN_CACHE) return GH_BIN_CACHE;
  const cands = [
    process.env.HANSTLERS_GH_BIN,
    'gh',
    path.join(process.env['ProgramFiles'] || '', 'GitHub CLI', 'gh.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'GitHub CLI', 'gh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe')
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (c === 'gh') { GH_BIN_CACHE = c; return GH_BIN_CACHE; }
      if (fs.existsSync(c)) { GH_BIN_CACHE = c; return GH_BIN_CACHE; }
    } catch (e) {}
  }
  GH_BIN_CACHE = 'gh';
  return GH_BIN_CACHE;
}
function ghJson(args, cb) {
  const ghBin = resolveGhBinary();
  execFile(ghBin, args, { windowsHide: true, timeout: 25000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return cb(new Error((stderr || err.message || 'gh failed (' + ghBin + ')').toString().trim()));
    let obj = null;
    try { obj = JSON.parse(String(stdout || '[]')); } catch (e) { return cb(new Error('gh json inválido')); }
    cb(null, obj);
  });
}
function ghAuthStatus(cb) {
  const ghBin = resolveGhBinary();
  execFile(ghBin, ['auth', 'status', '--hostname', 'github.com'], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    const out = String((stdout || '') + '\n' + (stderr || ''));
    const loggedIn = /Logged in to github\.com account /i.test(out);
    const m = /Logged in to github\.com account\s+([^\s(]+)/i.exec(out);
    const user = m ? m[1] : '';
    if (err && !loggedIn) return cb(null, { ok: false, loggedIn: false, user: '', error: out.trim() || err.message || 'not logged in' });
    return cb(null, { ok: true, loggedIn: !!loggedIn, user });
  });
}
function ghListAccounts(cb) {
  const ghBin = resolveGhBinary();
  execFile(ghBin, ['auth', 'status', '--hostname', 'github.com'], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (_err, stdout, stderr) => {
    const out = String((stdout || '') + '\n' + (stderr || ''));
    const accounts = [];
    const blocks = out.split(/Logged in to github\.com account\s+/i).slice(1);
    for (const b of blocks) {
      const login = (/^([^\s(]+)/.exec(b) || [])[1] || '';
      if (!login) continue;
      const active = /Active account:\s*true/i.test(b);
      accounts.push({ login, active });
    }
    cb(null, accounts);
  });
}
function ghSwitchAccount(login, cb) {
  const user = String(login || '').trim();
  if (!user) return cb(new Error('cuenta requerida'));
  const ghBin = resolveGhBinary();
  execFile(ghBin, ['auth', 'switch', '--hostname', 'github.com', '--user', user], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    const out = String((stdout || '') + '\n' + (stderr || '')).trim();
    if (err && !/Switched active account/i.test(out)) return cb(new Error(out || err.message || 'no se pudo cambiar de cuenta'));
    cb(null, { user, output: out });
  });
}
function startGhAuth(cb) {
  const ghBin = resolveGhBinary();
  try {
    // Abre flujo web de login en una consola separada para no bloquear el servidor.
    const cmd = '"' + ghBin.replace(/"/g, '""') + '" auth login --hostname github.com --web --git-protocol https';
    const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', cmd], { windowsHide: true });
    child.on('error', (e) => cb(e));
    child.on('close', () => cb(null));
  } catch (e) { cb(e); }
}
function fetchUserReposViaGh(cb) {
  const mapOut = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 10).map((r) => {
    const full = String((r && (r.full_name || r.nameWithOwner)) || '');
    return {
      id: 'gh-' + full.toLowerCase().replace(/[^a-z0-9/_-]/g, '').replace('/', '-'),
      name: full || String(r && r.name || ''),
      repoRef: full,
      subtitle: String(r && r.description || ''),
      defaultBranch: String((r && (r.default_branch || (r.defaultBranchRef && r.defaultBranchRef.name))) || ''),
      private: !!(r && (r.private || r.isPrivate))
    };
  }).filter((x) => x.repoRef);
  ghJson(['repo', 'list', '@me', '--limit', '10', '--json', 'nameWithOwner,description,isPrivate,defaultBranchRef'], (err, items) => {
    if (!err) return cb(null, mapOut(items));
    ghJson(['api', 'user/repos?sort=updated&direction=desc&per_page=10'], (err2, items2) => {
      if (err2) return cb(new Error((err.message || 'repo list failed') + ' | ' + (err2.message || 'api list failed')));
      return cb(null, mapOut(items2));
    });
  });
}
const repoCtxCache = new Map(); // key -> { text, at }
function fetchGithubRepoContext(user, repoRef, cb) {
  const token = user && user.githubToken ? String(user.githubToken) : '';
  const ref = String(repoRef || '').trim();
  if (!ref) return cb(null, '');
  const key = (String((user && user.login) || '@me').toLowerCase() + '|' + ref.toLowerCase());
  const prev = repoCtxCache.get(key);
  if (prev && prev.text && (Date.now() - Number(prev.at || 0) < 5 * 60 * 1000)) return cb(null, prev.text);
  const buildText = (repo, tree, readme) => {
    const branch = String(repo.default_branch || 'main');
    let treeTxt = '';
    if (Array.isArray(tree)) {
      const rows = tree.slice(0, 40).map((it) => ((it && it.type === 'dir') ? '📁 ' : '📄 ') + String((it && it.name) || ''));
      if (rows.length) treeTxt = '### Estructura raíz\n' + rows.join('\n');
    }
    let readmeTxt = '';
    if (readme && typeof readme.content === 'string') {
      const raw = decodeBase64Utf8(readme.content).trim();
      if (raw) readmeTxt = '### README.md\n' + raw.slice(0, 1200);
    }
    const header = [
      '### Repositorio GitHub',
      'Nombre: ' + String(repo.full_name || ref),
      'Branch: ' + branch,
      'Visibilidad: ' + (repo.private ? 'private' : 'public'),
      'Descripción: ' + String(repo.description || '').trim()
    ].join('\n');
    return [header, treeTxt, readmeTxt].filter(Boolean).join('\n\n');
  };
  const useGhFallback = () => {
    const escRef = ref.replace(/[^A-Za-z0-9_.\\/-]/g, '');
    ghJson(['api', 'repos/' + escRef], (eRepo, repo) => {
      if (eRepo || !repo || !repo.full_name) return cb(eRepo || new Error('repo no disponible'));
      const branch = String(repo.default_branch || 'main');
      const treeApi = 'repos/' + escRef + '/contents?ref=' + encodeURIComponent(branch);
      ghJson(['api', treeApi], (_eTree, tree) => {
        ghJson(['api', 'repos/' + escRef + '/readme'], (_eReadme, readme) => {
          const text = buildText(repo, tree, readme);
          repoCtxCache.set(key, { text, at: Date.now() });
          cb(null, text);
        });
      });
    });
  };
  if (!token) return useGhFallback();
  const repoPath = buildRepoApiPath(ref, '');
  if (!repoPath) return useGhFallback();
  githubRequest(repoPath, token, (eRepo, repo) => {
    if (eRepo || !repo || !repo.full_name) return useGhFallback();
    const branch = String(repo.default_branch || 'main');
    const treePath = buildRepoApiPath(ref, 'contents') + '?ref=' + encodeURIComponent(branch);
    const readmePath = buildRepoApiPath(ref, 'readme');
    githubRequest(treePath, token, (_eTree, tree) => {
      githubRequest(readmePath, token, (_eReadme, readme) => {
        const text = buildText(repo, tree, readme);
        repoCtxCache.set(key, { text, at: Date.now() });
        cb(null, text);
      });
    });
  });
}
function fetchUserReposForPanel(user, cb) {
  const token = user && user.githubToken ? String(user.githubToken) : '';
  if (!token) return fetchUserReposViaGh(cb);
  const p = '/user/repos?sort=updated&direction=desc&per_page=10&affiliation=owner,collaborator,organization_member';
  githubRequest(p, token, (err, items) => {
    if (err) return fetchUserReposViaGh(cb);
    const arr = Array.isArray(items) ? items : [];
    const out = arr.slice(0, 10).map((r) => ({
      id: 'gh-' + String(r && r.full_name || '').toLowerCase().replace(/[^a-z0-9/_-]/g, '').replace('/', '-'),
      name: String(r && (r.full_name || r.name) || ''),
      repoRef: String(r && r.full_name || ''),
      subtitle: String(r && r.description || ''),
      defaultBranch: String(r && r.default_branch || ''),
      private: !!(r && r.private)
    })).filter((x) => x.repoRef);
    cb(null, out);
  });
}
function exchangeGithubCode(code, cb) {
  const data = JSON.stringify({
    client_id: GITHUB_CLIENT_ID,
    client_secret: GITHUB_CLIENT_SECRET,
    code: code,
    redirect_uri: BASE_URL + '/auth/callback'
  });
  const req = https.request({
    hostname: 'github.com',
    path: '/login/oauth/access_token',
    method: 'POST',
    timeout: 20000,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'HanstlerS/1.0',
      'Content-Length': Buffer.byteLength(data)
    }
  }, (res) => {
    let body = '';
    res.on('data', (c) => body += c.toString());
    res.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        if (!j.access_token) return cb(new Error(j.error_description || j.error || 'oauth token failed'));
        cb(null, j.access_token);
      } catch (e) { cb(e); }
    });
  });
  req.on('error', cb);
  req.on('timeout', () => req.destroy(new Error('oauth timeout')));
  req.write(data);
  req.end();
}
function isAllowedUser(login) {
  const l = String(login || '').toLowerCase();
  if (!l) return false;
  if (ALLOWED_USERS.length === 0) return true;
  return ALLOWED_USERS.includes(l);
}
function isAdminUser(login) {
  const l = String(login || '').toLowerCase();
  if (!l) return false;
  return ADMIN_USERS.includes(l);
}
function checkOrgMembership(token, cb) {
  if (!GITHUB_ALLOWED_ORG) return cb(null, true);
  githubRequest('/user/memberships/orgs/' + encodeURIComponent(GITHUB_ALLOWED_ORG), token, (err, m) => {
    if (err) return cb(null, false);
    const stateOk = m && m.state === 'active';
    cb(null, !!stateOk);
  });
}

function looksLikeExecutionTask(text) {
  return /\b(abr\w*|open\w*|lanz\w*|inici\w*|arranc\w*|cre\w*|edit\w*|modific\w*|arregl\w*|corrig\w*|ejecut\w*|corr\w*|instal\w*|despleg\w*|refactor\w*|agreg\w*|a[ñn]ad\w*|archivo\w*|carpeta\w*|comando\w*|script\w*|c[oó]digo\w*|bug\w*|error\w*|compil\w*|build\w*|test\w*|prueb\w*|git\w*|deploy\w*|terminal\w*)\b/i.test(text || '')
    || /@[\w./\\-]+/.test(text || '');
}
function isXtudioMentioned(text) {
  return /\b(xtudio(?:-?1)?|xstudio(?:-?1)?|dj[-\s]?set[-\s]?studio|main_qt\.py)\b/i.test(String(text || ''));
}
function isXtudioLaunchIntent(message, history, historySummary) {
  const msg = String(message || '').trim();
  if (!msg) return false;
  const launchVerb = /\b(abr\w*|lanz\w*|inici\w*|arranc\w*|ejecut\w*)\b/i;
  return launchVerb.test(msg) && isXtudioMentioned(msg);
}
function launchXtudio1(cb) {
  const py = 'C:\\Users\\czumb\\AppData\\Local\\Programs\\Python\\Python311\\python.exe';
  const main = 'C:\\Users\\czumb\\Documents\\HanstlerS\\dj-set-studio\\main_qt.py';
  const wd = 'C:\\Users\\czumb\\Documents\\HanstlerS\\dj-set-studio';
  try {
    const child = spawn(py, [main], { cwd: wd, windowsHide: true, detached: true, stdio: 'ignore' });
    try { child.unref(); } catch (_) {}
    return cb(null, child && child.pid ? child.pid : 0);
  } catch (e) {
    return cb(e);
  }
}
function looksLikeStrategyTask(text) {
  return /\b(estrategia|roadmap|assessment|analiza|compar[aá]|trade[- ]?off|arquitectura|plan|prioriza|benchmark|decisi[oó]n|enfoque)\b/i.test(text || '');
}
function looksLikeAudioTask(text) {
  return /\b(x-core|xcore|audio|m[uú]sica|beat|track|voz|sonido|mezcla|master|sample)\b/i.test(text || '');
}
function looksLikeWebPortalTask(text) {
  return /\b(cloudflare|github|azure|portal|dashboard|dns|dominio|domain|ssl|cname|nameserver|hosting|vercel|netlify|render|railway|login|inicia sesi[oó]n|settings)\b/i.test(text || '');
}
function isVertexModel(model) {
  const m = String(model || '').trim().toLowerCase();
  return m === 'vertex-auto' || m === 'vertex-gemini-pro' || m === 'vertex-gemini-flash' || m === 'vertex-claude-opus-5';
}
function isModelIdentityQuestion(text) {
  const t = String(text || '').toLowerCase();
  return /\b(que|qué|cual|cuál)\s+modelo\b/.test(t)
    || /\bde\s+donde\s+viene\s+ese\s+modelo\b/.test(t)
    || /\bwhat\s+model\b/.test(t)
    || /\bwhich\s+model\b/.test(t);
}
function describeEffectiveModel(reqModel, routeReason) {
  const m = String(reqModel || '').trim();
  if (!m || m === 'auto') return 'Modelo activo: auto (router inteligente).';
  if (m === 'azure-agent') return 'Modelo activo: Azure Agent (herramientas en servidor local).';
  if (m === 'azure' || m === 'azure-gpt-5-mini') return 'Modelo activo: Azure OpenAI (' + m + ').';
  if (isVertexModel(m)) {
    const pick = pickVertexTarget(m, '', false);
    const real = pick && pick.model ? pick.model : m;
    const pub = pick && pick.publisher === 'anthropic' ? 'Anthropic en Vertex' : 'Google Gemini en Vertex';
    return 'Modelo activo: ' + m + ' → ' + real + ' (' + pub + ').';
  }
  return 'Modelo activo: ' + m + (routeReason ? (' (' + routeReason + ').') : '.');
}
function pickVertexTarget(model, message, hasAttachments) {
  const cfg = loadVertex();
  const m = String(model || '').trim().toLowerCase();
  if (!cfg) return { model: '', reason: 'vertex-not-configured' };
  if (m === 'vertex-claude-opus-5') return { model: cfg.models.opus, publisher: 'anthropic', reason: 'vertex-manual-opus' };
  if (m === 'vertex-gemini-pro') return { model: cfg.models.pro, publisher: 'google', reason: 'vertex-manual-pro' };
  if (m === 'vertex-gemini-flash') return { model: cfg.models.flash, publisher: 'google', reason: 'vertex-manual-flash' };
  if (looksLikeStrategyTask(message)) return { model: cfg.models.pro, publisher: 'google', reason: 'vertex-auto-strategy' };
  if (looksLikeExecutionTask(message) || looksLikeWebPortalTask(message) || hasAttachments) return { model: cfg.models.flash, publisher: 'google', reason: 'vertex-auto-execution-or-vision' };
  return { model: cfg.models.flash, publisher: 'google', reason: 'vertex-auto-default' };
}
function chooseModelForRequest(requestedModel, message, hasAttachments, fromLocalAgent) {
  const feats = currentFeatures();
  const base = (requestedModel || state.model || 'auto').trim();
  if (!feats.smartRouter) return { model: base || 'auto', reason: 'smart-router-disabled' };
  if (base !== 'auto') {
    const explicit = base.toLowerCase();
    const wantsExecution = looksLikeExecutionTask(message) || looksLikeWebPortalTask(message) || hasAttachments;
    const explicitVertex = explicit === 'vertex-auto' || explicit === 'vertex-gemini-pro' || explicit === 'vertex-gemini-flash' || explicit === 'vertex-claude-opus-5';
    if (explicitVertex && wantsExecution) {
      return { model: base, reason: 'explicit-vertex-locked' };
    }
    return { model: base || 'auto', reason: 'explicit-model' };
  }
  if (fromLocalAgent && feats.agentBridgeMode && feats.autoRouteForLocalAgent) {
    if (feats.routeExecutionToAzureAgent && loadAzure() && (looksLikeExecutionTask(message) || looksLikeWebPortalTask(message) || hasAttachments)) return { model: 'azure-agent', reason: 'local-agent-execution-or-web' };
    return { model: 'claude-sonnet-5', reason: 'local-agent-default' };
  }
  if (feats.preferXCoreForAudio && looksLikeAudioTask(message)) return { model: 'x-core', reason: 'audio-task' };
  if (feats.routeExecutionToAzureAgent && loadAzure() && (looksLikeExecutionTask(message) || looksLikeWebPortalTask(message) || hasAttachments)) return { model: 'azure-agent', reason: 'execution-or-web-task' };
  if (feats.preferClaudeForStrategy && looksLikeStrategyTask(message)) return { model: 'claude-sonnet-5', reason: 'strategy-task' };
  return { model: 'auto', reason: 'auto-default' };
}
function wrapProResponsePrompt(message) {
  const guard = '[Instrucción interna: respuesta profesional, clara, accionable, sin relleno, con recomendación principal cuando aplique y máxima exactitud técnica.]';
  return guard + '\n\n' + message;
}

// Construye un bloque de contexto del proyecto: árbol, git status, README y package.json.
// Llama cb(text) al terminar; usa caché si el cwd no cambió.
function buildProjectContext(cwd, cb) {
  if (state.projectCtx && state.projectCtx.cwd === cwd) {
    return cb(state.projectCtx.text);
  }
  const parts = [];
  let pending = 4;
  function tryDone() {
    if (--pending !== 0) return;
    const text = parts.filter(Boolean).join('\n\n');
    state.projectCtx = { cwd, text };
    cb(text);
  }

  // 1. Árbol de archivos (2 niveles, sin carpetas pesadas)
  try {
    const entries = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'build', '.next', '__pycache__', 'venv', '.venv', 'vendor', '.cache', 'coverage']);
    const walk = (dir, depth) => {
      let items; try { items = fs.readdirSync(dir); } catch (e) { return; }
      for (const item of items.slice(0, 50)) {
        if (skip.has(item)) continue;
        const full = path.join(dir, item);
        let stat; try { stat = fs.statSync(full); } catch (e) { continue; }
        entries.push((stat.isDirectory() ? '📁 ' : '📄 ') + path.relative(cwd, full).replace(/\\/g, '/') + (stat.isDirectory() ? '/' : ''));
        if (stat.isDirectory() && depth < 2) walk(full, depth + 1);
      }
    };
    walk(cwd, 1);
    if (entries.length) parts.push('### Estructura del proyecto (' + path.basename(cwd) + ')\n' + entries.join('\n'));
  } catch (e) {}
  tryDone(); // 1

  // 2. Git status (si hay repo)
  let gitDone = false;
  try {
    if (fs.existsSync(path.join(cwd, '.git'))) {
      const child = spawn('git', ['status', '--short', '--branch'], { cwd, windowsHide: true });
      let out = '';
      child.stdout.on('data', d => (out += d));
      child.stderr.on('data', () => {});
      const finish = () => { if (gitDone) return; gitDone = true; if (out.trim()) parts.push('### Git status\n' + out.trim().slice(0, 800)); tryDone(); };
      child.on('close', finish);
      child.on('error', finish);
      setTimeout(() => { try { child.kill(); } catch (_) {} finish(); }, 5000);
    } else { tryDone(); } // 2 sin git
  } catch (e) { if (!gitDone) { gitDone = true; tryDone(); } } // 2 error

  // 3. README.md (primeros 600 chars)
  try {
    const rp = ['README.md', 'readme.md', 'Readme.md'].map(n => path.join(cwd, n)).find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
    if (rp) parts.push('### README.md\n' + fs.readFileSync(rp, 'utf8').trim().slice(0, 600));
  } catch (e) {}
  tryDone(); // 3

  // 4. package.json (resumen)
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const s = {};
      if (pkg.name) s.name = pkg.name;
      if (pkg.version) s.version = pkg.version;
      if (pkg.description) s.description = pkg.description;
      if (pkg.scripts) s.scripts = pkg.scripts;
      if (pkg.main) s.main = pkg.main;
      parts.push('### package.json\n' + JSON.stringify(s, null, 2));
    }
  } catch (e) {}
  tryDone(); // 4
}

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
  /^\s*Modo Respuesta Pro\b/i,
  /^\s*-\s*Responde de forma clara, precisa y accionable\./i,
  /^\s*-\s*Si hay varias opciones, da recomendación principal con justificación breve\./i,
  /^\s*-\s*Si hay pasos, ordénalos y evita relleno\./i,
  /^\s*-\s*Mantén exactitud técnica; no inventes datos\./i,
  /^\s*Mensaje del usuario:\s*$/i,
  /^\s*\[Instrucción interna:\s*respuesta profesional/i,
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
  if (u.month !== monthKey()) { u = { month: monthKey(), spent: 0, plan: u.plan || (process.env.HANSTLERS_PLAN || 'max') }; saveUsage(u); }
  if (typeof u.spent !== 'number' || !Number.isFinite(u.spent) || u.spent < 0) u.spent = 0;
  if (!u.plan) u.plan = process.env.HANSTLERS_PLAN || 'max';
  // Migración: el default histórico era 'pro'; ahora la cuenta es Pro+ (7000).
  // Solo actualiza si el usuario no fijó un plan distinto manualmente.
  if ((u.plan === 'pro' || u.plan === 'pro+') && !u.planLocked) { u.plan = 'max'; saveUsage(u); }
  const plan = (u.plan || 'max').toLowerCase();
  const base = PLAN_CREDITS[plan] !== undefined ? PLAN_CREDITS[plan] : 20000;
  const extra = typeof u.extraCredits === 'number' ? u.extraCredits : 0;
  const hardCap = Math.max(50000, (base + extra) * 5);
  if (u.spent > hardCap) {
    u.lastBadSpent = u.spent;
    u.spent = 0;
    u.lastCliCreditsSeen = null;
    u.repairedAt = Date.now();
    saveUsage(u);
  }
  return u;
}
function saveUsage(u) {
  try { fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true }); fs.writeFileSync(USAGE_FILE, JSON.stringify(u)); } catch (e) {}
}
function addSpent(credits) {
  if (!Number.isFinite(credits) || !(credits > 0)) return loadUsage();
  // Evita saltos absurdos por parseos rotos del CLI (ej. 20000 por turno).
  if (credits > 500) return loadUsage();
  const u = loadUsage();
  u.spent = Math.round((u.spent + credits) * 100) / 100;
  saveUsage(u);
  return u;
}
function parseNumLoose(s) {
  if (!s) return NaN;
  const t = String(s).trim();
  const hasDot = t.indexOf('.') >= 0;
  const hasComma = t.indexOf(',') >= 0;
  // Si tiene ambos separadores, tomamos el último como decimal y el otro como miles.
  if (hasDot && hasComma) {
    const lastDot = t.lastIndexOf('.');
    const lastComma = t.lastIndexOf(',');
    const decSep = lastDot > lastComma ? '.' : ',';
    const thouSep = decSep === '.' ? ',' : '.';
    const compact = t.split(thouSep).join('').replace(decSep, '.').replace(/[^\d.]/g, '');
    return parseFloat(compact);
  }
  // Un solo separador: si parece miles (grupos de 3), lo quitamos.
  const sep = hasComma ? ',' : (hasDot ? '.' : '');
  if (sep) {
    const parts = t.split(sep);
    const maybeThousands = parts.length > 1 && parts.slice(1).every((p) => /^\d{3}$/.test(p));
    if (maybeThousands) return parseFloat(parts.join(''));
    return parseFloat(t.replace(',', '.').replace(/[^\d.]/g, ''));
  }
  return parseFloat(t.replace(/[^\d.]/g, ''));
}
function syncCliQuota(raw) {
  if (!raw) return;
  const m = /AI Credits[^\d]{0,40}([\d.,]+)\s*\/\s*([\d.,]+)/i.exec(raw);
  if (!m) return;
  const used = parseNumLoose(m[1]);
  const total = parseNumLoose(m[2]);
  if (!Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total <= 0) return;
  const u = loadUsage();
  const roundedUsed = Math.round(used * 100) / 100;
  const currentPlan = (u.plan || 'max').toLowerCase();
  const currentBase = PLAN_CREDITS[currentPlan] !== undefined ? PLAN_CREDITS[currentPlan] : 20000;
  const currentExtra = typeof u.extraCredits === 'number' ? u.extraCredits : 0;
  const currentTotal = currentBase + currentExtra;
  // Si ya tenemos una cuota mayor (ej. Max 20000), ignorar lecturas menores del CLI.
  if (total < currentTotal) return;
  u.spent = roundedUsed;
  if (total === 20000) u.plan = 'max';
  else if (total === 7000) u.plan = 'pro+';
  else if (total === 1500) u.plan = 'pro';
  else if (total > 0) {
    const base = PLAN_CREDITS[(u.plan || 'max').toLowerCase()] || 20000;
    u.extraCredits = Math.max(0, Math.round((total - base) * 100) / 100);
  }
  u.lastCliCreditsSeen = roundedUsed;
  u.lastCliCreditsTotal = Math.round(total * 100) / 100;
  u.syncedAt = Date.now();
  saveUsage(u);
}
function syncQuotaManual(payload) {
  const b = payload || {};
  const used = parseNumLoose(b.used);
  const total = parseNumLoose(b.total);
  const planRaw = String(b.plan || '').toLowerCase().trim();
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(total) || total <= 0) return null;
  const u = loadUsage();
  const roundedUsed = Math.round(used * 100) / 100;
  const roundedTotal = Math.round(total * 100) / 100;
  u.spent = roundedUsed;
  if (planRaw === 'max' || roundedTotal === 20000) u.plan = 'max';
  else if (planRaw === 'pro+' || planRaw === 'proplus' || roundedTotal === 7000) u.plan = 'pro+';
  else if (planRaw === 'pro' || roundedTotal === 1500) u.plan = 'pro';
  else if (planRaw === 'free' || roundedTotal === 0) u.plan = 'free';
  const base = PLAN_CREDITS[(u.plan || 'max').toLowerCase()] !== undefined ? PLAN_CREDITS[(u.plan || 'max').toLowerCase()] : 20000;
  u.extraCredits = Math.max(0, Math.round((roundedTotal - base) * 100) / 100);
  u.planLocked = true;
  u.lastCliCreditsSeen = roundedUsed;
  u.lastCliCreditsTotal = roundedTotal;
  u.syncedAt = Date.now();
  u.syncedFrom = 'manual';
  saveUsage(u);
  return quotaInfo();
}
function quotaInfo() {
  const u = loadUsage();
  const plan = (u.plan || 'max').toLowerCase();
  const base = PLAN_CREDITS[plan] !== undefined ? PLAN_CREDITS[plan] : 20000;
  const extra = typeof u.extraCredits === 'number' ? u.extraCredits : 0;
  const total = base + extra;
  const remaining = Math.max(0, Math.round((total - u.spent) * 100) / 100);
  return { plan, base, extra, total, spent: u.spent, remaining, month: u.month };
}

// ===== Contador independiente de consumo Google/Vertex (no comparte cuota con Copilot) =====
const GOOGLE_USAGE_FILE = path.join(os.homedir(), '.hanstlers', 'google-usage.json');
// Precios oficiales Vertex AI / Gemini API (USD por 1M tokens, tier estandar).
const GOOGLE_PRICING = [
  { match: /gemini-2\.5-flash/i, in: 0.30, out: 2.50 },
  { match: /gemini-2\.5-pro/i, in: 1.25, out: 10.00 },
  { match: /gemini-1\.5-flash/i, in: 0.075, out: 0.30 },
  { match: /gemini-1\.5-pro/i, in: 1.25, out: 5.00 },
  { match: /gemini.*flash/i, in: 0.75, out: 3.75 },   // fallback futuras versiones flash
  { match: /gemini.*pro/i, in: 2.00, out: 8.00 }       // fallback futuras versiones pro
];
function priceForModel(model) {
  const m = String(model || '');
  const hit = GOOGLE_PRICING.find((p) => p.match.test(m));
  return hit || { in: 0.75, out: 3.75 };
}
function loadGoogleUsage() {
  let g = {};
  try { g = JSON.parse(fs.readFileSync(GOOGLE_USAGE_FILE, 'utf8')); } catch (e) {}
  if (g.month !== monthKey()) g = { month: monthKey(), promptTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
  if (!Number.isFinite(g.promptTokens)) g.promptTokens = 0;
  if (!Number.isFinite(g.outputTokens)) g.outputTokens = 0;
  if (!Number.isFinite(g.costUsd)) g.costUsd = 0;
  if (!Number.isFinite(g.calls)) g.calls = 0;
  return g;
}
function saveGoogleUsage(g) {
  try { fs.mkdirSync(path.dirname(GOOGLE_USAGE_FILE), { recursive: true }); fs.writeFileSync(GOOGLE_USAGE_FILE, JSON.stringify(g)); } catch (e) {}
}
function addGoogleTokens(model, promptTokens, outputTokens) {
  const g = loadGoogleUsage();
  const price = priceForModel(model);
  const inTok = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0;
  const outTok = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  g.promptTokens += inTok;
  g.outputTokens += outTok;
  g.costUsd = Math.round((g.costUsd + (inTok / 1e6) * price.in + (outTok / 1e6) * price.out) * 1e6) / 1e6;
  g.calls += 1;
  saveGoogleUsage(g);
  return g;
}
function googleQuotaInfo() {
  const g = loadGoogleUsage();
  const totalTokens = g.promptTokens + g.outputTokens;
  return { promptTokens: g.promptTokens, outputTokens: g.outputTokens, totalTokens, costUsd: g.costUsd, calls: g.calls, month: g.month };
}

// ===== Auto-sync silencioso desde GitHub Billing (headless) =====
const githubQuotaSyncState = {
  running: false,
  lastRunAt: 0,
  lastOkAt: 0,
  lastError: '',
  lastSource: '',
  lastUsed: null,
  lastTotal: null
};
function loadGithubQuotaSyncCfg() {
  const base = {
    enabled: true,
    intervalMin: 30,
    url: GITHUB_QUOTA_DEFAULT_URL,
    useGhCli: true,
    cookie: process.env.HANSTLERS_GITHUB_COOKIE || '',
    chromePath: process.env.HANSTLERS_CHROME_PATH || '',
    profileDir: process.env.HANSTLERS_CHROME_PROFILE_DIR || ''
  };
  try {
    const raw = JSON.parse(fs.readFileSync(GITHUB_QUOTA_SYNC_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      if (typeof raw.enabled === 'boolean') base.enabled = raw.enabled;
      if (Number.isFinite(Number(raw.intervalMin))) base.intervalMin = Math.max(5, Math.min(240, Number(raw.intervalMin)));
      if (raw.url) base.url = String(raw.url);
      if (typeof raw.useGhCli === 'boolean') base.useGhCli = raw.useGhCli;
      if (raw.cookie) base.cookie = String(raw.cookie);
      if (raw.chromePath) base.chromePath = String(raw.chromePath);
      if (raw.profileDir) base.profileDir = String(raw.profileDir);
    }
  } catch (e) {}
  return base;
}
function saveGithubQuotaSyncCfg(cfg) {
  try {
    fs.mkdirSync(path.dirname(GITHUB_QUOTA_SYNC_FILE), { recursive: true });
    fs.writeFileSync(GITHUB_QUOTA_SYNC_FILE, JSON.stringify(cfg));
  } catch (e) {}
}
function findChromePath(preferred) {
  const cands = [];
  if (preferred) cands.push(preferred);
  cands.push(path.join(process.env['ProgramFiles'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'));
  cands.push(path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'));
  cands.push(path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'));
  cands.push(path.join(process.env['ProgramFiles'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  cands.push(path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  cands.push(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (const p of cands) {
    if (!p) continue;
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return '';
}
function extractQuotaFromHtml(html) {
  if (!html) return null;
  const clean = String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const m = /Included credits[\s\S]{0,800}?([0-9][0-9.,]*)\s*\/\s*([0-9][0-9.,]*)\s*AI credits/i.exec(clean);
  if (!m) return null;
  const used = parseNumLoose(m[1]);
  const total = parseNumLoose(m[2]);
  if (!Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total <= 0) return null;
  return { used, total };
}
function fetchGithubQuotaViaCookie(cfg, cb) {
  if (!cfg.cookie) return cb(new Error('cookie missing'));
  let u;
  try { u = new URL(cfg.url || GITHUB_QUOTA_DEFAULT_URL); } catch (e) { return cb(e); }
  const req = https.request({
    hostname: u.hostname,
    path: (u.pathname || '/') + (u.search || ''),
    method: 'GET',
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 HanstlerS/1.0',
      'Cookie': cfg.cookie
    }
  }, (res) => {
    let body = '';
    res.on('data', (c) => {
      body += c.toString();
      if (body.length > 3 * 1024 * 1024) body = body.slice(-3 * 1024 * 1024);
    });
    res.on('end', () => {
      if (res.statusCode !== 200) return cb(new Error('http ' + res.statusCode));
      const q = extractQuotaFromHtml(body);
      if (!q) return cb(new Error('quota not found in html'));
      cb(null, q, 'cookie');
    });
  });
  req.on('error', (e) => cb(e));
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.end();
}
function fetchGithubQuotaViaHeadless(cfg, cb) {
  const browser = findChromePath(cfg.chromePath);
  if (!browser) return cb(new Error('chrome not found'));
  const targetUrl = cfg.url || GITHUB_QUOTA_DEFAULT_URL;
  const args = ['--headless=new', '--disable-gpu', '--disable-extensions', '--dump-dom', targetUrl];
  const profileRoot = cfg.profileDir || path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  if (profileRoot) {
    args.push('--user-data-dir=' + profileRoot);
    args.push('--profile-directory=Default');
  }
  const child = spawn(browser, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  let done = false;
  const finish = (e, q) => {
    if (done) return;
    done = true;
    clearTimeout(t);
    cb(e, q, 'headless');
  };
  const t = setTimeout(() => { try { child.kill(); } catch (e) {} finish(new Error('headless timeout')); }, 35000);
  child.stdout.on('data', (d) => {
    out += d.toString();
    if (out.length > 3 * 1024 * 1024) out = out.slice(-3 * 1024 * 1024);
  });
  child.stderr.on('data', (d) => {
    err += d.toString();
    if (err.length > 2000) err = err.slice(-2000);
  });
  child.on('error', (e) => finish(e));
  child.on('close', () => {
    const q = extractQuotaFromHtml(out);
    if (!q) return finish(new Error('headless parse failed' + (err ? ': ' + err : '')));
    finish(null, q);
  });
}
function fetchGithubQuotaViaGhCli(cb) {
  const args = ['api', '/copilot_internal/user'];
  let out = '';
  let err = '';
  const child = spawn('gh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let done = false;
  const finish = (e, q) => {
    if (done) return;
    done = true;
    clearTimeout(t);
    cb(e, q, 'gh-cli');
  };
  const t = setTimeout(() => { try { child.kill(); } catch (e) {} finish(new Error('gh api timeout')); }, 30000);
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 2000) err = err.slice(-2000); });
  child.on('error', (e) => finish(e));
  child.on('close', (code) => {
    if (code !== 0) return finish(new Error(('gh api failed: ' + (err || ('exit ' + code))).trim()));
    let obj = null;
    try { obj = JSON.parse(out || '{}'); } catch (e) { return finish(new Error('gh api json parse failed')); }
    const snap = obj && obj.quota_snapshots && obj.quota_snapshots.premium_interactions;
    if (!snap) return finish(new Error('gh api missing premium_interactions'));
    const used = Number(snap.credits_used);
    const total = Number(snap.entitlement);
    if (!Number.isFinite(used) || used < 0 || !Number.isFinite(total) || total <= 0) {
      return finish(new Error('gh api invalid quota values'));
    }
    finish(null, { used, total });
  });
}
function autoSyncGithubQuota(reason, done) {
  if (githubQuotaSyncState.running) return done && done(null, { skipped: true, reason: 'already-running' });
  const cfg = loadGithubQuotaSyncCfg();
  if (!cfg.enabled) return done && done(null, { skipped: true, reason: 'disabled' });
  githubQuotaSyncState.running = true;
  githubQuotaSyncState.lastRunAt = Date.now();
  const finish = (err, result) => {
    githubQuotaSyncState.running = false;
    if (err) {
      githubQuotaSyncState.lastError = err.message || String(err);
      return done && done(err);
    }
    githubQuotaSyncState.lastError = '';
    githubQuotaSyncState.lastOkAt = Date.now();
    githubQuotaSyncState.lastSource = result.source || '';
    githubQuotaSyncState.lastUsed = result.used;
    githubQuotaSyncState.lastTotal = result.total;
    done && done(null, result);
  };
  const applyQuota = (q, src) => {
    const synced = syncQuotaManual({ used: q.used, total: q.total, plan: q.total >= 20000 ? 'max' : '' });
    if (!synced) return finish(new Error('sync invalid values'));
    finish(null, { source: src, used: synced.spent, total: synced.total, quota: synced, reason: reason || 'auto' });
  };
  const tryHeadless = () => {
    fetchGithubQuotaViaHeadless(cfg, (e2, q2, src2) => {
      if (e2 || !q2) return finish(e2 || new Error('sync failed'));
      applyQuota(q2, src2);
    });
  };
  const tryCookie = () => {
    fetchGithubQuotaViaCookie(cfg, (e1, q1, src1) => {
      if (!e1 && q1) return applyQuota(q1, src1);
      tryHeadless();
    });
  };
  if (cfg.useGhCli !== false) {
    fetchGithubQuotaViaGhCli((e0, q0, src0) => {
      if (!e0 && q0) return applyQuota(q0, src0);
      tryCookie();
    });
    return;
  }
  tryCookie();
}
let githubQuotaSyncTimer = null;
function scheduleGithubQuotaSync() {
  if (githubQuotaSyncTimer) clearInterval(githubQuotaSyncTimer);
  const cfg = loadGithubQuotaSyncCfg();
  const everyMs = Math.max(5, Math.min(240, Number(cfg.intervalMin) || 30)) * 60 * 1000;
  if (!cfg.enabled) return;
  setTimeout(() => { autoSyncGithubQuota('startup', () => {}); }, 15000);
  githubQuotaSyncTimer = setInterval(() => { autoSyncGithubQuota('interval', () => {}); }, everyMs);
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

const HISTORY_MAX_ITEMS = Math.max(2, Math.min(12, Number(process.env.HANSTLERS_HISTORY_MAX_ITEMS || 6)));
const HISTORY_MAX_CHARS = Math.max(800, Math.min(12000, Number(process.env.HANSTLERS_HISTORY_MAX_CHARS || 3200)));
const HISTORY_SUMMARY_MAX_CHARS = Math.max(200, Math.min(8000, Number(process.env.HANSTLERS_HISTORY_SUMMARY_MAX_CHARS || 2200)));
function trimText(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? (t.slice(0, Math.max(0, max - 1)) + '…') : t;
}
function normalizeHistoryItem(m) {
  if (!m || typeof m !== 'object') return null;
  const role = String(m.role || '').toLowerCase() === 'user' ? 'user' : 'assistant';
  const content = trimText(m.content || m.html || '', 600);
  if (!content) return null;
  return { role, content };
}
function compactHistoryInput(rawHistory, rawSummary) {
  const norm = (Array.isArray(rawHistory) ? rawHistory : []).map(normalizeHistoryItem).filter(Boolean);
  const lastItems = norm.slice(Math.max(0, norm.length - HISTORY_MAX_ITEMS));
  const out = [];
  let chars = 0;
  for (let i = lastItems.length - 1; i >= 0; i--) {
    const item = lastItems[i];
    const size = item.content.length;
    if (out.length > 0 && (chars + size > HISTORY_MAX_CHARS)) break;
    out.unshift(item);
    chars += size;
  }
  const summary = trimText(rawSummary || '', HISTORY_SUMMARY_MAX_CHARS);
  return { history: out, summary };
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

  const compactCtxForIntent = compactHistoryInput(body.history, body.historySummary);
  if (isXtudioLaunchIntent(body.message || message, compactCtxForIntent.history, compactCtxForIntent.summary)) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {} };
    send('route', { model: 'local-launcher', reason: 'xtudio-direct-launch' });
    return launchXtudio1((err, pid) => {
      if (err) send('error', 'No se pudo lanzar Xtudio-1: ' + err.message);
      else send('chunk', 'Xtudio-1 lanzado correctamente' + (pid ? (' (PID ' + pid + ')') : '') + '.');
      send('done', { code: err ? 1 : 0 });
      try { res.end(); } catch (_) {}
    });
  }

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
  const statelessMode = !!body.stateless;
  const repoPath = String(body.repoPath || '').trim();
  const repoRef = String(body.repoRef || '').trim();
  let reqCwd = state.cwd;
  if (repoPath) {
    try {
      const p = path.resolve(repoPath);
      const st = fs.statSync(p);
      if (st && st.isDirectory()) reqCwd = p;
    } catch (e) {}
  }
  const fromLocalAgent = !!req.headers['x-hanstlers-local-agent'];
  const requestedModel = model || state.model;
  const routePick = chooseModelForRequest(requestedModel, body.message || message, (images.length > 0 || files.length > 0), fromLocalAgent);
  const reqModel = routePick.model || model || state.model;
  if (isModelIdentityQuestion(body.message || message)) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    const sendQuick = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {} };
    sendQuick('route', { model: reqModel || 'auto', reason: routePick.reason || '' });
    sendQuick('chunk', describeEffectiveModel(reqModel, routePick.reason || ''));
    sendQuick('done', { code: 0 });
    try { res.end(); } catch (_) {}
    return;
  }
  const isXCoreReq = (reqModel === 'x-core' || reqModel === 'x-core:latest');

  // AHORRO DE TOKENS: inyectar la memoria SOLO cuando aporta valor:
  //  - primer mensaje de la conversación (aún no hay sesión que la contenga), o
  //  - el usuario pregunta/alude a la memoria ("recuerdas", "acuerdas", "sabes que"...).
  const asksMemory = /\b(recuerdas?|te acuerdas|acuerdas|sab[eí]as?|dijimos|hab[ií]amos|mencion[eé]|coment[eé])\b/i.test(body.message || '');
  const firstTurn = statelessMode ? true : !sessionId;
  // En Vertex evita inyectar memoria automática en primer turno para no arrastrar contexto viejo.
  const autoMemoryOnFirstTurn = !isVertexModel(reqModel);
  const mem = (isXCoreReq ? '' : (((firstTurn && autoMemoryOnFirstTurn) || asksMemory) ? memoryContextBlock() : ''));

  // Imágenes para visión (Azure): pasamos las data URLs válidas tal cual.
  const visionImages = images.filter((im) => /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(im || '')).slice(0, 6);

  const compactCtx = compactCtxForIntent;
  const convHistoryArr = compactCtx.history;
  const convHistorySummary = compactCtx.summary;
  const launch = (projCtx) => {
    let finalMessage = message;
    const blocks = [];
    if (projCtx && !isXCoreReq) blocks.push('--- CONTEXTO DEL PROYECTO ---\n' + projCtx + '\n--- FIN CONTEXTO ---');
    if (mem) blocks.push(mem.trimEnd());
    if (blocks.length) finalMessage = blocks.join('\n\n') + '\n\nMensaje del usuario:\n' + message;
    const feats = currentFeatures();
    const isAzureFamily = reqModel === 'azure' || reqModel === 'azure-gpt-5-mini' || reqModel === 'azure-agent';
    if (feats.proResponseMode && !isXCoreReq && !isAzureFamily && !looksLikeExecutionTask(message)) {
      finalMessage = wrapProResponsePrompt(finalMessage);
    }
    detectFlags(() => handleChatInner(req, res, finalMessage, sessionId, convId, reqModel, memNote, convHistoryArr, convHistorySummary, visionImages, routePick, reqCwd, statelessMode));
  };
  // Inyectar contexto del proyecto solo en el primer turno de cada conversación.
  if (firstTurn && !isXCoreReq) {
    if (repoRef) {
      fetchGithubRepoContext(req.authUser, repoRef, (_err, projCtx) => launch(projCtx || ''));
    } else {
      buildProjectContext(reqCwd, (projCtx) => launch(projCtx));
    }
  } else {
    launch('');
  }
}

function handleChatInner(req, res, message, sessionId, convId, model, memNote, convHistory, convHistorySummary, visionImages, routePick, runCwd, statelessMode) {
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
  if (routePick && routePick.reason && routePick.model) send('route', routePick);

  const effModel = model || state.model;
  const useCwd = (runCwd && String(runCwd).trim()) ? String(runCwd).trim() : state.cwd;
  state.convSessions = state.convSessions || {};
  let effSession = statelessMode ? '' : (sessionId || (convId ? state.convSessions[convId] : '') || '');

  // RUTA X-CORE LOCAL.
  if (effModel === 'x-core' || effModel === 'x-core:latest') {
    let aborted = false;
    runXCore(
      message,
      Array.isArray(convHistory) ? convHistory : [],
      send,
      (code) => { if (!aborted) send('done', { code }); res.end(); },
      (killer) => { req.on('close', () => { aborted = true; killer(); }); }
    );
    return;
  }

  // RUTA VERTEX (Google): auto + selección manual de modelo.
  if (isVertexModel(effModel)) {
    let aborted = false;
    // Vertex se comporta IGUAL que el agente de Azure: siempre con herramientas.
    // Antes un heuristico de texto decidia si usar el bucle de agente, asi que
    // pedidos como "abre el repo X" caian en chat plano y solo describian el plan.
    const vxCfg = loadVertex();
    const vxPick = vxCfg ? pickVertexTarget(effModel, message, !!(visionImages && visionImages.length)) : null;
    const vxUsaAgente = !!(vxCfg && vxPick && vxPick.model && vxPick.publisher !== 'anthropic' &&
      currentFeatures().vertexAgentTools);
    if (vxUsaAgente) {
      let vxDone = false;
      runVertexAgent(
        message,
        Array.isArray(convHistory) ? convHistory : [],
        convHistorySummary || '',
        vxPick,
        send,
        (code) => {
          if (vxDone || aborted) return; vxDone = true;
          send('done', { code });
          try { res.end(); } catch (e) {}
        },
        (killer) => { req.on('close', () => { aborted = true; killer(); }); },
        visionImages || [],
        statelessMode ? '' : convId
      );
      return;
    }
    runVertex(
      message,
      Array.isArray(convHistory) ? convHistory : [],
      convHistorySummary || '',
      effModel,
      send,
      (code, reason) => {
        if (aborted) return;
        if (code === 0) {
          send('done', { code: 0 });
          try { res.end(); } catch (e) {}
          return;
        }
        if (isVertexOnlyMode(effModel) || !allowVertexCopilotFallback()) {
          send('error', reason || 'Vertex falló y la política anti-fallback a Copilot está activa.');
          send('done', { code: 1 });
          try { res.end(); } catch (e) {}
          return;
        }
        send('status', (reason ? (reason + ' ') : '') + 'Usando respaldo…');
        // Que se vea POR QUE cambio el modelo, en vez de solo mutar la insignia.
        send('chunk', '\n⚠️ Vertex no pudo responder' + (reason ? (': ' + reason) : '') +
          '\nRespondo con claude-sonnet-5 como respaldo.\n\n');
        send('route', { model: 'claude-sonnet-5', reason: 'vertex-fallback' });
        return attempt(!state.autoOnly, { sessionId: effSession, model: 'claude-sonnet-5' }, false);
      },
      (killer) => { req.on('close', () => { aborted = true; killer(); }); },
      visionImages || []
    );
    return;
  }

  // RUTA AZURE (BYOK): si el modelo elegido es Azure, llamar directo a tu recurso.
  if (effModel === 'azure' || effModel === 'azure-gpt-5-mini') {
    let aborted = false;
    let azureTokens = 0;
    const sendAzure = (event, data) => {
      if (event === 'chunk' && typeof data === 'string') azureTokens += Math.ceil(data.length / 4);
      send(event, data);
    };
    runAzure(
      message,
      Array.isArray(convHistory) ? convHistory : [],
      convHistorySummary || '',
      sendAzure,
      (code) => {
        if (!aborted) {
          if (azureTokens > 0) { const est = Math.round(azureTokens / 100) / 10; addSpent(est); send('usage', { quota: quotaInfo() }); }
          send('done', { code });
        }
        res.end();
      },
      (killer) => { req.on('close', () => { aborted = true; killer(); }); },
      visionImages || []
    );
    return;
  }

  // RUTA AZURE AGENTE: modelo con herramientas (lee/escribe archivos, ejecuta comandos).
  if (effModel === 'azure-agent') {
    let agentDone = false;
    let azureAgentTokens = 0;
    const sendAgent = (event, data) => {
      if (event === 'chunk' && typeof data === 'string') azureAgentTokens += Math.ceil(data.length / 4);
      send(event, data);
    };
    runAzureAgent(
      message,
      Array.isArray(convHistory) ? convHistory : [],
      convHistorySummary || '',
      sendAgent,
      (code) => {
        if (agentDone) return; agentDone = true;
        if (azureAgentTokens > 0) { const est = Math.round(azureAgentTokens / 100) / 10; addSpent(est); send('usage', { quota: quotaInfo() }); }
        send('done', { code }); try { res.end(); } catch (e) {}
      },
      (killer) => { req.on('close', () => killer()); },
      visionImages || [],
        statelessMode ? '' : convId
    );
    return;
  }

  function launchRaw(withModel, opts) {
    const a = buildArgs(message, opts, withModel);
    // PREFERIDO: ejecutar el binario nativo copilot.exe DIRECTO y OCULTO (sin ventana negra).
    const bin = resolveCopilotBinary();
    if (bin) {
      return spawn(bin, a, { cwd: useCwd, env: process.env, windowsHide: true });
    }
    const loader = resolveLoader();
    if (loader) {
      // Respaldo: Electron ejecuta el loader como Node (ELECTRON_RUN_AS_NODE) — oculto.
      return spawn(process.execPath, [loader].concat(a), { cwd: useCwd, env: nodeEnv(), windowsHide: true });
    }
    if (process.platform === 'win32') {
      return spawn('cmd.exe', ['/d', '/s', '/c', COPILOT_CMD].concat(a), { cwd: useCwd, env: process.env, windowsHide: true });
    }
    return spawn(COPILOT_CMD, a, { cwd: useCwd, env: process.env, windowsHide: true });
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
      if (statelessMode) return;
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
      syncCliQuota(raw);
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
  const byId = new Map();
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8'));
      if (!c || !c.id) continue;
      const item = { id: c.id, title: c.title || 'Conversación', updatedAt: c.updatedAt || 0 };
      const prev = byId.get(c.id);
      if (!prev || Number(item.updatedAt || 0) > Number(prev.updatedAt || 0)) byId.set(c.id, item);
    } catch (e) {}
  }
  const items = Array.from(byId.values());
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
  try { return JSON.parse(fs.readFileSync(convFile(id), 'utf8')); } catch (e) {}
  // Fallback: localizar por id aunque el archivo tenga sufijos (ej. .backup o _chat).
  try {
    const files = fs.readdirSync(CONV_DIR).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8'));
        if (c && c.id === id) return c;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
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
  execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true }, (err, stdout) => {
    const p = (stdout || '').trim();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (p) { state.cwd = p; state.started = false; state.projectCtx = null; }
    res.end(JSON.stringify({ path: p || null, cwd: state.cwd }));
  });
}

function listQuickFolders() {
  const home = os.homedir();
  const candidates = [
    { id: 'xtudio-1-main', name: 'Xtudio-1 (principal)', path: path.join(home, 'xtudio-1') },
    { id: 'xtudio-1-docs', name: 'Xtudio-1 (Documentos)', path: path.join(home, 'OneDrive', 'Favoritos', 'Documentos', 'Xtudio-1') },
    { id: 'xtudio-site', name: 'Xtudio sitio web', path: path.join(home, 'Documents', 'HanstlerS', 'xtudio-site') },
    { id: 'xtudio-website', name: 'Xtudio website', path: path.join(home, 'xtudio-website') },
    { id: 'xtudio-backend', name: 'Xtudio backend', path: path.join(home, 'Documents', 'HanstlerS', 'xtudio-backend') },
    { id: 'xtudio-marketing', name: 'Xtudio marketing', path: path.join(home, 'Documents', 'HanstlerS', 'xtudio-marketing') },
    { id: 'hanstlers-core', name: 'HanstlerS core', path: path.join(home, 'Documents', 'HanstlerS', 'HanstlerS') },
    { id: 'dj-set-studio', name: 'DJ Set Studio', path: path.join(home, 'Documents', 'HanstlerS', 'dj-set-studio') }
  ];
  const out = [];
  const seen = {};
  candidates.forEach((c) => {
    try {
      const p = path.resolve(String(c.path || ''));
      if (!p || seen[p.toLowerCase()]) return;
      const st = fs.statSync(p);
      if (!st || !st.isDirectory()) return;
      seen[p.toLowerCase()] = true;
      out.push({ id: c.id, name: c.name, path: p });
    } catch (e) {}
  });
  return out;
}
function samePathKey(p) {
  return String(p || '').replace(/[\\/]+$/, '').toLowerCase();
}
function pushRepoCandidate(list, seen, id, name, p) {
  try {
    const rp = path.resolve(String(p || ''));
    if (!rp) return;
    const key = samePathKey(rp);
    if (!key || seen[key]) return;
    const st = fs.statSync(rp);
    if (!st || !st.isDirectory()) return;
    seen[key] = true;
    list.push({ id, name, path: rp });
  } catch (e) {}
}
function listReposForPanel() {
  const out = [];
  const seen = {};
  const cwd = path.resolve(String(state.cwd || os.homedir()));
  pushRepoCandidate(out, seen, 'repo-cwd', 'Actual · ' + path.basename(cwd), cwd);
  listQuickFolders().forEach((it) => pushRepoCandidate(out, seen, it.id, it.name, it.path));
  const hsRoot = path.join(os.homedir(), 'Documents', 'HanstlerS');
  let roots = [];
  try { roots = fs.readdirSync(hsRoot); } catch (e) { roots = []; }
  roots.slice(0, 80).forEach((name) => {
    const full = path.join(hsRoot, name);
    let include = false;
    try {
      const st = fs.statSync(full);
      if (!st || !st.isDirectory()) return;
      include = fs.existsSync(path.join(full, '.git')) || fs.existsSync(path.join(full, 'package.json')) || /xtudio|hanstler|xone|studio|web|site|backend|api|dj/i.test(name);
    } catch (e) { include = false; }
    if (!include) return;
    pushRepoCandidate(out, seen, 'repo-hs-' + name.toLowerCase().replace(/[^a-z0-9_-]/g, ''), name, full);
  });
  out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity: 'base' }));
  return out;
}

function isPublicAuthPath(urlPath) {
  return urlPath === '/auth/login' || urlPath.startsWith('/auth/callback') || urlPath === '/auth/logout' || urlPath === '/healthz';
}
function wantsHtml(req) {
  const a = String(req.headers.accept || '');
  return a.includes('text/html') || a.includes('*/*');
}
function requireAuthOrDeny(req, res) {
  if (!authEnabled()) return { ok: true, user: null };
  const r = readAuthUser(req);
  if (r.ok && r.user) return { ok: true, user: r.user };
  if (isPublicAuthPath((req.url || '').split('?')[0])) return { ok: true, user: null };
  if (wantsHtml(req)) {
    res.writeHead(302, { Location: '/auth/login' });
    res.end();
    return { ok: false };
  }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
  return { ok: false };
}
function requireAdminOrDeny(req, res) {
  if (!authEnabled()) return true;
  if (req.authUser && req.authUser.isAdmin) return true;
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
  return false;
}

const server = http.createServer(async (req, res) => {
 try {
  const reqPath = (req.url || '').split('?')[0];
  if (req.method === 'GET' && reqPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === 'GET' && reqPath === '/auth/login') {
    if (!authEnabled()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'oauth not configured' }));
    }
    const st = crypto.randomBytes(16).toString('hex');
    oauthStates.set(st, Date.now());
    const redirectUri = BASE_URL + '/auth/callback';
    const gh = 'https://github.com/login/oauth/authorize?client_id=' + encodeURIComponent(GITHUB_CLIENT_ID)
      + '&redirect_uri=' + encodeURIComponent(redirectUri)
      + '&scope=' + encodeURIComponent('read:user read:org repo')
      + '&state=' + encodeURIComponent(st);
    res.writeHead(302, { Location: gh });
    return res.end();
  }
  if (req.method === 'GET' && reqPath === '/auth/callback') {
    if (!authEnabled()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'oauth not configured' }));
    }
    const u = new URL(req.url, BASE_URL || 'http://localhost');
    const code = (u.searchParams.get('code') || '').trim();
    const st = (u.searchParams.get('state') || '').trim();
    const ts = oauthStates.get(st) || 0;
    oauthStates.delete(st);
    if (!code || !st || !ts || (Date.now() - ts > 15 * 60 * 1000)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'invalid oauth state' }));
    }
    return exchangeGithubCode(code, (err, token) => {
      if (err) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'oauth exchange failed: ' + err.message }));
      }
      githubRequest('/user', token, (uErr, ghUser) => {
        if (uErr || !ghUser || !ghUser.login) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'github user fetch failed' }));
        }
        checkOrgMembership(token, (_mErr, inOrg) => {
          const login = String(ghUser.login || '').toLowerCase();
          if (!isAllowedUser(login) || !inOrg) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'user not allowed' }));
          }
          const sid = crypto.randomBytes(24).toString('hex');
          authSessions.set(sid, {
            login: login,
            name: ghUser.name || ghUser.login,
            avatarUrl: ghUser.avatar_url || '',
            isAdmin: isAdminUser(login),
            at: Date.now(),
            githubToken: token
          });
          issueSessionCookie(res, sid);
          res.writeHead(302, { Location: '/' });
          return res.end();
        });
      });
    });
  }
  if (req.method === 'POST' && reqPath === '/auth/logout') {
    const c = parseCookies(req);
    const tok = String(c.hs_session || '');
    const sid = tok.split('.')[0] || '';
    if (sid) authSessions.delete(sid);
    clearSessionCookie(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === 'GET' && reqPath === '/auth/me') {
    const r = readAuthUser(req);
    if (!authEnabled()) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, enabled: false, user: null }));
    }
    if (!r.ok || !r.user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, enabled: true, user: null }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, enabled: true, user: r.user }));
  }
  if (req.method === 'GET' && reqPath === '/api/gh/auth/status') {
    return ghAuthStatus((_err, st) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(st || { ok: false, loggedIn: false, user: '' }));
    });
  }
  if (req.method === 'GET' && reqPath === '/api/gh/auth/accounts') {
    return ghListAccounts((_err, accounts) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, accounts: accounts || [] }));
    });
  }
  if (req.method === 'POST' && reqPath === '/api/gh/auth/switch') {
    const body = await readBody(req);
    return ghSwitchAccount(body && body.user, (err, r) => {
      res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(err ? { ok: false, error: err.message } : { ok: true, user: r.user }));
    });
  }
  if (req.method === 'POST' && reqPath === '/api/gh/auth/start') {
    return startGhAuth((err) => {
      res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(err ? { ok: false, error: err.message } : { ok: true }));
    });
  }
  const gate = requireAuthOrDeny(req, res);
  if (!gate.ok) return;
  req.authUser = gate.user || null;
  if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res, await readBody(req));
  if (req.method === 'POST' && req.url === '/api/agent/confirm') {
    const b = await readBody(req);
    const fn = b && b.id && pendingConfirms[b.id];
    if (fn) { fn(!!b.approved); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
    res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'confirmación no encontrada o expirada' }));
  }
  if (req.method === 'GET' && req.url === '/api/pickfolder') return pickFolder(res);
  if (req.method === 'GET' && req.url === '/api/folders/quick') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ items: listQuickFolders(), cwd: state.cwd }));
  }
  if (req.method === 'GET' && req.url === '/api/repos/list') {
    return fetchUserReposForPanel(req.authUser, (err, items) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ items: [], cwd: state.cwd, source: 'github', error: 'No se pudieron cargar repos de GitHub ahora.', detail: String(err.message || '') }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ items: items || [], cwd: state.cwd, source: 'github' }));
    });
  }
  if (req.method === 'POST' && req.url === '/api/repos/open') {
    const b = await readBody(req);
    const spec = String((b && (b.repo || b.repoRef)) || '').trim();
    if (!spec) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'falta el repo' }));
    }
    return openRepoWorkspace(spec, (err, info) => {
      res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
      if (err) return res.end(JSON.stringify({ ok: false, error: err.message, cwd: state.cwd }));
      return res.end(JSON.stringify({ ok: true, cwd: info.path, repoRef: info.repoRef, action: info.action }));
    });
  }
  if (req.method === 'POST' && req.url === '/api/cwd') {
    const b = await readBody(req);
    const p = path.resolve(String((b && b.path) || ''));
    let ok = false;
    try {
      const st = fs.statSync(p);
      ok = !!(st && st.isDirectory());
    } catch (e) { ok = false; }
    if (!ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'invalid path', cwd: state.cwd }));
    }
    state.cwd = p;
    state.started = false;
    state.projectCtx = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, cwd: state.cwd }));
  }
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
  if (req.method === 'GET' && req.url.startsWith('/api/xcore/stream')) {
    const u = new URL(req.url, 'http://localhost');
    const audioPath = decodeURIComponent((u.searchParams.get('path') || '').trim());
    if (!audioPath || !path.isAbsolute(audioPath) || !XCORE_AUDIO_EXT_RE.test(audioPath)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'ruta de audio invalida' }));
    }
    fs.stat(audioPath, (err, st) => {
      if (err || !st || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'audio no encontrado' }));
      }
      const mime = xcoreMimeFor(audioPath);
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(String(range));
        const start = m && m[1] ? Number(m[1]) : 0;
        const end = m && m[2] ? Number(m[2]) : (st.size - 1);
        const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0;
        const safeEnd = Number.isFinite(end) ? Math.min(st.size - 1, end) : (st.size - 1);
        if (safeStart > safeEnd || safeStart >= st.size) {
          res.writeHead(416);
          return res.end();
        }
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Length': (safeEnd - safeStart + 1),
          'Accept-Ranges': 'bytes',
          'Content-Range': 'bytes ' + safeStart + '-' + safeEnd + '/' + st.size
        });
        return fs.createReadStream(audioPath, { start: safeStart, end: safeEnd }).pipe(res);
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': st.size,
        'Accept-Ranges': 'bytes'
      });
      fs.createReadStream(audioPath).pipe(res);
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/xcore/status') {
    const cfg = currentXCore();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      config: cfg,
      draining: xcoreDrain,
      inFlight: xcoreInFlight,
      file: XCORE_FILE,
      lastReloadAt: xcoreLastReloadAt,
      lastReloadError: xcoreLastReloadError
    }));
  }
  if (req.method === 'POST' && req.url === '/api/xcore/reload') {
    const cfg = reloadXCore(true);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, config: cfg, lastReloadAt: xcoreLastReloadAt, lastReloadError: xcoreLastReloadError }));
  }
  if (req.method === 'POST' && req.url === '/api/xcore/drain') {
    const b = await readBody(req);
    const enabled = !!(b && (b.enabled === true || b.enabled === 'true' || b.enabled === 1 || b.enabled === '1'));
    const waitMsRaw = Number((b && b.waitMs) || 0);
    const waitMs = Number.isFinite(waitMsRaw) ? Math.max(0, Math.min(120000, waitMsRaw)) : 0;
    xcoreDrain = enabled;
    if (enabled && waitMs > 0) {
      const start = Date.now();
      while (xcoreInFlight > 0 && (Date.now() - start) < waitMs) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      draining: xcoreDrain,
      inFlight: xcoreInFlight,
      drained: xcoreInFlight === 0,
      waitedMs: enabled ? waitMs : 0
    }));
  }
  if (req.method === 'GET' && req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ cwd: state.cwd, model: state.model, quota: quotaInfo(), features: currentFeatures() }));
  }
  if (req.method === 'GET' && req.url === '/api/features') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(currentFeatures()));
  }
  if (req.method === 'POST' && req.url === '/api/features') {
    if (!requireAdminOrDeny(req, res)) return;
    const b = await readBody(req);
    const f = Object.assign({}, currentFeatures());
    const keys = Object.keys(defaultFeatures());
    keys.forEach((k) => {
      if (typeof b[k] === 'boolean') f[k] = b[k];
    });
    saveFeatures(f);
    reloadFeatures();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, features: currentFeatures() }));
  }
  if (req.method === 'GET' && req.url === '/api/quota') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(quotaInfo()));
  }
  if (req.method === 'GET' && req.url === '/api/quota/google') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(googleQuotaInfo()));
  }
  if (req.method === 'GET' && req.url === '/api/quota/sync/status') {
    const cfg = loadGithubQuotaSyncCfg();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      config: { enabled: !!cfg.enabled, intervalMin: cfg.intervalMin, useGhCli: cfg.useGhCli !== false, url: cfg.url, hasCookie: !!cfg.cookie, hasChromePath: !!findChromePath(cfg.chromePath) },
      state: githubQuotaSyncState,
      quota: quotaInfo()
    }));
  }
  if (req.method === 'POST' && req.url === '/api/quota/sync/run') {
    if (!requireAdminOrDeny(req, res)) return;
    return autoSyncGithubQuota('manual-run', (err, result) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: err.message, state: githubQuotaSyncState }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, result, state: githubQuotaSyncState, quota: quotaInfo() }));
    });
  }
  if (req.method === 'POST' && req.url === '/api/quota/sync/config') {
    if (!requireAdminOrDeny(req, res)) return;
    const b = await readBody(req);
    const cfg = loadGithubQuotaSyncCfg();
    if (typeof b.enabled === 'boolean') cfg.enabled = b.enabled;
    if (Number.isFinite(Number(b.intervalMin))) cfg.intervalMin = Math.max(5, Math.min(240, Number(b.intervalMin)));
    if (typeof b.useGhCli === 'boolean') cfg.useGhCli = b.useGhCli;
    if (typeof b.url === 'string' && b.url.trim()) cfg.url = b.url.trim();
    if (typeof b.cookie === 'string') cfg.cookie = b.cookie.trim();
    if (typeof b.chromePath === 'string') cfg.chromePath = b.chromePath.trim();
    if (typeof b.profileDir === 'string') cfg.profileDir = b.profileDir.trim();
    saveGithubQuotaSyncCfg(cfg);
    scheduleGithubQuotaSync();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, config: { enabled: !!cfg.enabled, intervalMin: cfg.intervalMin, useGhCli: cfg.useGhCli !== false, url: cfg.url, hasCookie: !!cfg.cookie } }));
  }
  if (req.method === 'POST' && req.url === '/api/quota/sync') {
    if (!requireAdminOrDeny(req, res)) return;
    const b = await readBody(req);
    const q = syncQuotaManual(b);
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'invalid used/total' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(q));
  }
  if (req.method === 'POST' && req.url === '/api/saldo') {
    const b = await readBody(req);
    const add = parseFloat(b && b.add);
    if (add > 0) {
      const u = loadUsage();
      u.extraCredits = Math.round(((u.extraCredits || 0) + add) * 100) / 100;
      saveUsage(u);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(quotaInfo()));
  }
  if (req.method === 'POST' && req.url === '/api/plan') {
    const b = await readBody(req);
    if (b && b.plan) { const u = loadUsage(); u.plan = String(b.plan).toLowerCase(); u.planLocked = true; saveUsage(u); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(quotaInfo()));
  }
  if (req.method === 'GET' && req.url === '/api/vertex/status') {
    const v = loadVertex();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      configured: !!v,
      authMode: v ? v.authMode : '',
      region: v ? v.region : '',
      projectId: v ? v.projectId : '',
      models: v ? v.models : null
    }));
  }
  if (req.method === 'POST' && req.url === '/api/vertex/config') {
    const b = await readBody(req) || {};
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(VERTEX_FILE, 'utf8')) || {}; } catch (e) {}
    const apiKey = String(b.apiKey || '').trim();
    const projectId = String(b.projectId || '').trim();
    const region = String(b.region || cur.region || 'us-central1').trim();
    if (!apiKey && !projectId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Da una API key de Google AI Studio o un projectId de GCP.' }));
    }
    const next = Object.assign({}, cur, {
      region,
      modelPro: normalizeVertexModel('pro', cur.modelPro || VERTEX_DEFAULT_PRO),
      modelFlash: normalizeVertexModel('flash', cur.modelFlash || VERTEX_DEFAULT_FLASH),
      modelOpus: normalizeVertexModel('opus', cur.modelOpus || VERTEX_DEFAULT_OPUS)
    });
    if (apiKey) next.apiKey = apiKey; else delete next.apiKey;
    if (projectId) next.projectId = projectId;
    const finish = (verify) => {
      try {
        fs.mkdirSync(path.dirname(VERTEX_FILE), { recursive: true });
        fs.writeFileSync(VERTEX_FILE, JSON.stringify(next, null, 2), 'utf8');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'No se pudo guardar vertex.json: ' + e.message }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, configured: !!loadVertex(), verify: verify || null }));
    };
    if (!apiKey) return finish(null);
    // Verifica la API key contra la API pública de Gemini antes de darla por buena.
    const r2 = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models?key=' + encodeURIComponent(apiKey),
      method: 'GET',
      timeout: 15000
    }, (rs) => {
      let buf = '';
      rs.on('data', (d) => { buf += d; });
      rs.on('end', () => {
        const okKey = rs.statusCode >= 200 && rs.statusCode < 300;
        if (!okKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: summarizeVertexError(rs.statusCode, buf) || ('API key rechazada (HTTP ' + rs.statusCode + ')') }));
        }
        return finish({ ok: true });
      });
    });
    r2.on('timeout', () => r2.destroy(new Error('timeout')));
    r2.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'No se pudo validar la API key: ' + e.message }));
    });
    return r2.end();
  }
  if (req.method === 'GET' && req.url === '/api/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const vtx = loadVertex();
    const vPro = vtx && vtx.models && vtx.models.pro ? String(vtx.models.pro) : '';
    const vFlash = vtx && vtx.models && vtx.models.flash ? String(vtx.models.flash) : '';
    const vOpus = vtx && vtx.models && vtx.models.opus ? String(vtx.models.opus) : '';
    const models = [
      { id: 'auto', name: 'Automatico (recomendado)' },
      { id: 'x-core', name: 'X-Core local (HanstlerS)' },
      { id: 'vertex-auto', name: 'Vertex Auto (Google: ' + (vFlash || 'sin modelo') + ')' + (vtx ? '' : ' [configurar GCP/API key]') },
      { id: 'vertex-gemini-pro', name: 'Vertex Gemini Pro (' + (vPro || 'sin modelo') + ')' + (vtx ? '' : ' [configurar GCP/API key]') },
      { id: 'vertex-gemini-flash', name: 'Vertex Gemini Flash (' + (vFlash || 'sin modelo') + ')' + (vtx ? '' : ' [configurar GCP/API key]') },
      { id: 'vertex-claude-opus-5', name: 'Vertex Claude Opus 5 (Anthropic: ' + (vOpus || 'sin modelo') + ')' + (vtx ? '' : ' [configurar GCP/API key]') }
    ];
    if (loadAzure()) models.push({ id: 'azure', name: 'Azure gpt-5-mini (tu cuota, barato)' });
    if (loadAzure()) models.push({ id: 'azure-agent', name: 'Azure Agente (ejecuta archivos/comandos)' });
    models.push(
      { id: 'claude-opus-5', name: 'Claude Opus 5 (maximo)' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (potente)' },
      { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
      { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5 (rapido)' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex (codigo)' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini (rapido)' },
      { id: 'gpt-5-mini', name: 'GPT-5 mini (rapido)' },
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash (rapido)' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
      { id: 'mai-code-1-flash', name: 'MAI-Code-1-Flash (rapido)' },
      { id: '__custom__', name: 'Otro... (escribir ID)' }
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
  if (req.method === 'GET' && req.url === '/api/trust') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ trust: trustMode }));
  }
  if (req.method === 'POST' && req.url === '/api/trust') {
    const b = await readBody(req);
    trustMode = !!(b && b.trust);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ trust: trustMode }));
  }
  // ===== Actualizacion desde la propia app =====
  if (req.method === 'GET' && req.url === '/api/update/check') {
    const info = await updater.checkUpdate();
    // Si el ultimo intento dijo "listo" pero en disco quedo otra version, hay
    // que decirlo: si no, la app arranca vieja y el usuario cree que actualizo.
    const aplicado = updater.lastApplyResult();
    const extra = { installedVersion: APP_VERSION };
    if (aplicado && aplicado.ok === false) {
      extra.lastApplyFailed = true;
      extra.lastApplyDetail = 'La ultima actualizacion no se aplico: esperaba ' +
        (aplicado.expected || '?') + ' y quedo ' + (aplicado.installed || 'nada') +
        ' (instalador: codigo ' + aplicado.exitCode + '). Cierra HanstlerS del todo y vuelve a pulsar actualizar.';
    } else if (aplicado && aplicado.ok && aplicado.expected && aplicado.expected !== APP_VERSION) {
      // Se instalo la version esperada pero corre otra: hay una copia vieja abierta.
      extra.lastApplyFailed = true;
      extra.lastApplyDetail = 'Se instalo la ' + aplicado.expected + ' pero estas ejecutando la ' +
        APP_VERSION + '. Cierra todas las ventanas de HanstlerS y vuelve a abrirla.';
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(Object.assign(extra, info)));
  }
  if (req.method === 'GET' && req.url.startsWith('/api/update/status')) {
    const since = Number(new URL(req.url, 'http://x').searchParams.get('since') || 0);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(updater.status(since)));
  }
  if (req.method === 'POST' && req.url === '/api/update/run') {
    if (!requireAdminOrDeny(req, res)) return;
    const b = (await readBody(req)) || {};
    const r = await updater.runUpdate(
      { force: !!b.force, skipTests: !!b.skipTests, skipBuild: !!b.skipBuild },
      quitForUpdate
    );
    res.writeHead(r.ok ? 200 : 409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // ===== Vigia de modelos de Gemini =====
  if (req.method === 'GET' && req.url === '/api/vertex/models/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(modelWatch.status()));
  }
  if (req.method === 'POST' && req.url === '/api/vertex/models/check') {
    const b = (await readBody(req)) || {};
    const r = await modelWatch.checkModels({ deep: b.deep !== false });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  if (req.method === 'POST' && req.url === '/api/vertex/models/apply') {
    if (!requireAdminOrDeny(req, res)) return;
    const b = (await readBody(req)) || {};
    const r = modelWatch.applyModel(b.model);
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  if (req.method === 'POST' && req.url === '/api/vertex/models/dismiss') {
    const b = (await readBody(req)) || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(modelWatch.dismiss(b.model)));
  }
  if (req.method === 'POST' && req.url === '/api/vertex/models/config') {
    if (!requireAdminOrDeny(req, res)) return;
    const b = (await readBody(req)) || {};
    const st = modelWatch.setConfig(b);
    modelWatch.schedule(onModelFinding);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, enabled: st.enabled, autoApply: st.autoApply, intervalHours: st.intervalHours }));
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
  server.listen(PORT, HOST, () => {
    console.log(`HanstlerS escuchando en http://${HOST}:${PORT}`);
    // Pre-calentar la detección de flags en segundo plano para que el
    // PRIMER mensaje del usuario no pague el costo de `copilot --help`.
    setTimeout(() => { try { detectFlags(() => {}); } catch (e) {} }, 50);
    // Sincronización silenciosa de cuota GitHub (si está habilitada).
    scheduleGithubQuotaSync();
    // Vigilancia de modelos nuevos de Gemini (si está habilitada).
    try { modelWatch.schedule(onModelFinding); } catch (e) {}
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
