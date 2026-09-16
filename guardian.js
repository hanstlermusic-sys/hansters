// Vigilante de código en segundo plano.
//
// Mira la carpeta de trabajo y, cada vez que se guarda un archivo, lo revisa
// SIN llamar a ninguna IA: busca secretos expuestos (tokens, llaves) y errores
// de sintaxis. Si encuentra algo, avisa con una notificación de Windows.
//
// Todo el análisis es local: no gasta cuota, no manda código a ningún lado y
// responde al instante. Revisar con IA en cada guardado quedó fuera a
// propósito: cuesta cuota en cada Ctrl+S y tarda lo que tarde la red, que es
// justo lo contrario de lo que sirve mientras se escribe código.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Carpetas que nunca se revisan: son ajenas, generadas o enormes.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', 'build', 'out', '.next',
  '__pycache__', 'venv', '.venv', 'vendor', '.cache', 'coverage', '.pytest_cache'
]);

// Solo se revisan archivos de código y configuración de texto.
const SCAN_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.psm1',
  '.json', '.yml', '.yaml', '.env', '.sh', '.bat', '.cmd', '.html', '.css', '.md'
]);

const MAX_FILE_BYTES = 512 * 1024;

// Reglas de alta confianza: formatos propios de un proveedor, no palabras
// sueltas. Nada de heurísticas vagas tipo "la línea dice password": un aviso
// falso en cada guardado enseña a ignorar los avisos, y entonces el de verdad
// también pasa de largo.
const SECRET_RULES = [
  { regla: 'github-token', desc: 'Token de GitHub', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/ },
  { regla: 'github-pat', desc: 'Token fino de GitHub', re: /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/ },
  { regla: 'openai-key', desc: 'Llave de OpenAI', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { regla: 'anthropic-key', desc: 'Llave de Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { regla: 'google-key', desc: 'Llave de Google/Gemini', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { regla: 'aws-key', desc: 'Llave de AWS', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { regla: 'slack-token', desc: 'Token de Slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { regla: 'stripe-key', desc: 'Llave de Stripe', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { regla: 'private-key', desc: 'Llave privada', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
  { regla: 'azure-conn', desc: 'Cadena de conexión de Azure', re: /AccountKey=[A-Za-z0-9+/=]{40,}/ },
  { regla: 'conn-string', desc: 'Contraseña en cadena de conexión', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{6,}@[^\s/]+/i },
  { regla: 'jwt', desc: 'Token JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ }
];

// Marcas de que el "secreto" es de mentira: ejemplo, plantilla o variable.
const PLACEHOLDER = /(xxxx|placeholder|ejemplo|example|your[_-]?|tu[_-]?token|dummy|fake|sample|<[^>]+>|\{\{|\$\{|%[A-Z_]+%|\.\.\.)/i;

function esFalsoPositivo(linea, hallado) {
  if (PLACEHOLDER.test(hallado)) return true;
  const ctx = String(linea).slice(0, 400);
  if (/(placeholder|ejemplo|example|no real|ficticio)/i.test(ctx) && PLACEHOLDER.test(ctx)) return true;
  return false;
}

function recortar(s) {
  const t = String(s).trim();
  return t.length > 120 ? t.slice(0, 117) + '...' : t;
}

// Oculta el secreto: deja ver lo justo para reconocerlo sin copiarlo entero.
// El aviso viaja a la barra de notificaciones y queda en el historial, así que
// no tiene por qué llevar la credencial completa.
function enmascarar(s) {
  const t = String(s);
  if (t.length <= 12) return t.slice(0, 3) + '***';
  return t.slice(0, 6) + '***' + t.slice(-3);
}

// Revisa un texto y devuelve los secretos encontrados, con número de línea.
function scanText(text, archivo) {
  const hallazgos = [];
  if (typeof text !== 'string' || !text) return hallazgos;
  const lineas = text.split(/\r?\n/);
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    if (linea.length > 4000) continue; // línea minificada: ruido garantizado
    for (const r of SECRET_RULES) {
      const m = linea.match(r.re);
      if (!m) continue;
      if (esFalsoPositivo(linea, m[0])) continue;
      hallazgos.push({
        tipo: 'secreto',
        regla: r.regla,
        archivo: archivo || '',
        linea: i + 1,
        detalle: r.desc + ': ' + enmascarar(m[0]),
        severidad: 'alta'
      });
      break; // una regla por línea basta para avisar
    }
  }
  return hallazgos;
}

function esRutaIgnorada(rel) {
  const partes = String(rel).split(/[\\/]/);
  return partes.some((p) => SKIP_DIRS.has(p));
}

function esRevisable(archivo) {
  const base = path.basename(archivo);
  if (base.startsWith('~$')) return false;
  if (/\.(min|bundle)\.(js|css)$/i.test(base)) return false;
  if (/^\.env($|\.)/i.test(base)) return true;
  return SCAN_EXTS.has(path.extname(base).toLowerCase());
}

// Comprueba la sintaxis con el propio Node (`--check`). Solo JavaScript:
// es lo único que Node sabe validar sin instalar nada.
function checkSyntax(archivo, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  opts = opts || {};
  const ext = path.extname(archivo).toLowerCase();
  if (!['.js', '.cjs', '.mjs'].includes(ext)) return cb(null);
  const bin = opts.nodeBin || process.execPath;
  const env = opts.env || process.env;
  let child;
  try {
    child = spawn(bin, ['--check', archivo], { env, windowsHide: true });
  } catch (e) { return cb(null); }
  let err = '';
  let listo = false;
  const fin = (res) => { if (listo) return; listo = true; cb(res); };
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', () => {});
  child.on('error', () => fin(null));
  child.on('close', (code) => {
    if (code === 0 || !err.trim()) return fin(null);
    const m = err.match(/^(?:.*?):(\d+)\s*$/m);
    const msg = (err.split(/\r?\n/).find((l) => /SyntaxError|Error:/.test(l)) || 'Error de sintaxis').trim();
    fin({
      tipo: 'sintaxis',
      regla: 'node-check',
      archivo,
      linea: m ? Number(m[1]) : 0,
      detalle: recortar(msg),
      severidad: 'alta'
    });
  });
  setTimeout(() => { try { child.kill(); } catch (_) {} fin(null); }, 10000);
}

// Notificación de Windows (globo del área de notificación). Misma técnica que
// la herramienta `notify` del agente, para que se vea igual.
function notificarWindows(titulo, mensaje) {
  if (process.platform !== 'win32') return;
  const t = String(titulo || 'HanstlerS').replace(/'/g, '').slice(0, 60);
  const m = String(mensaje || '').replace(/'/g, '').slice(0, 200);
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Warning; $n.Visible = $true; $n.ShowBalloonTip(6000, '${t}', '${m}', [System.Windows.Forms.ToolTipIcon]::Warning); Start-Sleep 6; $n.Visible = $false`;
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    child.on('error', () => {});
  } catch (e) {}
}

function textoAviso(h) {
  const base = path.basename(h.archivo || '');
  const donde = base + (h.linea ? ':' + h.linea : '');
  return donde + ' - ' + h.detalle;
}

// Revisa un archivo entero (secretos + sintaxis) y llama cb(hallazgos).
function scanFile(archivo, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  opts = opts || {};
  let texto = '';
  try {
    const st = fs.statSync(archivo);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return cb([]);
    texto = fs.readFileSync(archivo, 'utf8');
  } catch (e) { return cb([]); }
  const hallazgos = scanText(texto, archivo);
  checkSyntax(archivo, opts, (sint) => {
    if (sint) hallazgos.push(sint);
    cb(hallazgos);
  });
}

// ---- Vigilancia en vivo ----

const estado = {
  activo: false,
  cwd: null,
  watcher: null,
  hallazgos: [],       // últimos hallazgos, el más reciente primero
  avisados: new Set(), // firma de lo ya notificado, para no repetir el globo
  pendientes: new Map(),
  revisados: 0
};

function firma(h) {
  return [h.archivo, h.regla, h.linea, h.detalle].join('|');
}

// Guarda los hallazgos nuevos y avisa una sola vez por cada uno: al guardar
// diez veces el mismo archivo no salen diez globos del mismo problema.
function registrar(hallazgos, notificar) {
  const nuevos = hallazgos.filter((h) => !estado.avisados.has(firma(h)));
  if (!nuevos.length) return [];
  nuevos.forEach((h) => {
    estado.avisados.add(firma(h));
    estado.hallazgos.unshift(Object.assign({ at: Date.now() }, h));
  });
  if (estado.hallazgos.length > 100) estado.hallazgos.length = 100;
  if (estado.avisados.size > 500) estado.avisados.clear();
  if (notificar) {
    const secretos = nuevos.filter((h) => h.tipo === 'secreto');
    const h = secretos[0] || nuevos[0];
    const titulo = secretos.length ? 'HanstlerS: posible secreto expuesto' : 'HanstlerS: error de sintaxis';
    const extra = nuevos.length > 1 ? ' (+' + (nuevos.length - 1) + ' mas)' : '';
    notificar(titulo, textoAviso(h) + extra);
  }
  return nuevos;
}

function start(opts) {
  opts = opts || {};
  const cwd = opts.cwd;
  stop();
  if (!cwd) return estado;
  try { if (!fs.statSync(cwd).isDirectory()) return estado; } catch (e) { return estado; }
  const notificar = opts.notify === null ? null : (opts.notify || notificarWindows);
  // Un guardado dispara varios eventos del sistema de archivos; la espera los
  // junta en una sola revisión.
  const espera = Number(opts.debounceMs) || 700;
  const scanOpts = { nodeBin: opts.nodeBin, env: opts.env };

  let watcher;
  try {
    watcher = fs.watch(cwd, { recursive: true, persistent: false }, (evt, rel) => {
      if (!rel) return;
      if (esRutaIgnorada(rel)) return;
      const full = path.join(cwd, rel);
      if (!esRevisable(full)) return;
      const prev = estado.pendientes.get(full);
      if (prev) clearTimeout(prev);
      estado.pendientes.set(full, setTimeout(() => {
        estado.pendientes.delete(full);
        scanFile(full, scanOpts, (hs) => {
          estado.revisados++;
          if (hs.length) registrar(hs, notificar);
          if (typeof opts.onScan === 'function') opts.onScan(full, hs);
        });
      }, espera));
    });
  } catch (e) { return estado; }

  watcher.on('error', () => { try { watcher.close(); } catch (_) {} });
  estado.watcher = watcher;
  estado.activo = true;
  estado.cwd = cwd;
  return estado;
}

function stop() {
  estado.pendientes.forEach((t) => clearTimeout(t));
  estado.pendientes.clear();
  if (estado.watcher) { try { estado.watcher.close(); } catch (e) {} }
  estado.watcher = null;
  estado.activo = false;
  estado.cwd = null;
  return estado;
}

function status() {
  return {
    activo: estado.activo,
    cwd: estado.cwd,
    revisados: estado.revisados,
    hallazgos: estado.hallazgos.slice(0, 20)
  };
}

function clear() {
  estado.hallazgos = [];
  estado.avisados.clear();
  return status();
}

// Barrido completo de la carpeta, bajo demanda. El vigilante no lo hace solo al
// arrancar: revisar miles de archivos de golpe sería lento y llenaría de avisos
// cosas que ya estaban ahí desde antes.
function scanTree(cwd, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  opts = opts || {};
  const limite = Number(opts.maxFiles) || 600;
  const lista = [];
  const walk = (dir, prof) => {
    if (lista.length >= limite || prof > 6) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const it of items) {
      if (lista.length >= limite) return;
      if (SKIP_DIRS.has(it.name)) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) walk(full, prof + 1);
      else if (esRevisable(full)) lista.push(full);
    }
  };
  try { walk(cwd, 0); } catch (e) {}
  const hallazgos = [];
  let i = 0;
  const siguiente = () => {
    if (i >= lista.length) return cb(hallazgos, lista.length);
    const f = lista[i++];
    scanFile(f, { nodeBin: opts.nodeBin, env: opts.env }, (hs) => {
      hs.forEach((h) => hallazgos.push(h));
      siguiente();
    });
  };
  siguiente();
}

module.exports = {
  SECRET_RULES,
  scanText,
  scanFile,
  scanTree,
  checkSyntax,
  esRevisable,
  esRutaIgnorada,
  enmascarar,
  notificarWindows,
  start,
  stop,
  status,
  clear
};
