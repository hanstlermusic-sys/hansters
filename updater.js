'use strict';
// Actualizador integrado de HanstlerS.
//
// Ejecuta, desde el propio botón de la app, el ciclo completo que antes era
// manual: git pull -> npm install -> npm test -> npm run dist -> instalar el
// build nuevo -> relanzar. El ultimo tramo lo hace un script externo lanzado
// en modo detached, porque la app no puede cerrarse a si misma y a la vez
// seguir instalando.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const HOME = os.homedir();

// ===== Localizar el repo fuente =====
// La app empaquetada corre dentro de app.asar, que no es un repo git. El
// codigo fuente vive aparte; hay que encontrarlo para poder actualizar.
function looksLikeRepo(dir) {
  try {
    if (!dir || !fs.existsSync(path.join(dir, '.git'))) return false;
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));
    return pkg && pkg.name === 'hanstlers';
  } catch (e) { return false; }
}

let cachedRepoRoot;
function findRepoRoot() {
  if (cachedRepoRoot !== undefined) return cachedRepoRoot;
  const candidates = [
    process.env.HANSTLERS_REPO,
    __dirname,
    path.join(__dirname, '..'),
    path.join(HOME, 'Documents', 'HanstlerS'),
    path.join(HOME, 'Documents', 'HansterS'),
    path.join(HOME, 'HanstlerS'),
    path.join(HOME, 'source', 'repos', 'HanstlerS'),
    path.join(HOME, 'Documents', 'GitHub', 'HanstlerS')
  ].filter(Boolean);
  for (const c of candidates) {
    let dir;
    try { dir = path.resolve(c); } catch (e) { continue; }
    if (looksLikeRepo(dir)) { cachedRepoRoot = dir; return dir; }
  }
  cachedRepoRoot = null;
  return null;
}

// ===== Ejecucion de comandos con log en vivo =====
function resolveCommand(cmd, args) {
  // En Windows npm/ask-cli son .cmd y necesitan pasar por cmd.exe.
  if (IS_WIN && /^(npm|npx|yarn|pnpm)$/i.test(cmd)) {
    const line = [cmd].concat(args).map((a) => (/[\s"&|<>^]/.test(a) ? '"' + a + '"' : a)).join(' ');
    return { file: process.env.ComSpec || 'cmd.exe', argv: ['/d', '/s', '/c', line] };
  }
  return { file: cmd, argv: args };
}

function runCmd(cmd, args, cwd, onLine, opts) {
  const options = opts || {};
  return new Promise((resolve) => {
    const { file, argv } = resolveCommand(cmd, args);
    let child;
    try {
      child = spawn(file, argv, {
        cwd,
        windowsHide: true,
        env: Object.assign({}, process.env, options.env || {})
      });
    } catch (e) {
      onLine('ERROR al lanzar ' + cmd + ': ' + e.message);
      return resolve({ code: -1, out: '' });
    }
    let out = '';
    let buf = '';
    const pump = (chunk) => {
      const text = chunk.toString();
      out += text;
      buf += text;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.forEach((l) => { if (l.trim()) onLine(l.replace(/\s+$/, '')); });
    };
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('error', (e) => { onLine('ERROR: ' + e.message); resolve({ code: -1, out }); });
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf.trim());
      resolve({ code, out });
    });
  });
}

function gitOut(repo, args) {
  return runCmd('git', args, repo, () => {}).then((r) => ({ code: r.code, text: r.out.trim() }));
}

// ===== Estado del trabajo en curso =====
const job = {
  running: false,
  done: false,
  ok: false,
  step: '',
  steps: [],
  log: [],
  error: '',
  restarting: false,
  startedAt: 0,
  finishedAt: 0
};

function pushLog(line) {
  job.log.push(line);
  // Cota superior: no dejamos crecer el log sin limite.
  if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
}

function setStep(name) {
  job.step = name;
  job.steps.push({ name, at: Date.now() });
  pushLog('### ' + name);
}

function readVersion(repo) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    return pkg.version || '';
  } catch (e) { return ''; }
}

// ===== Comprobar si hay actualizacion =====
async function checkUpdate() {
  const repo = findRepoRoot();
  if (!repo) {
    return {
      ok: false,
      error: 'No encontre el repositorio fuente de HanstlerS. Clonalo en Documents\\HanstlerS o define la variable HANSTLERS_REPO.'
    };
  }
  const branchRes = await gitOut(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRes.text || 'main';
  const fetched = await gitOut(repo, ['fetch', 'origin', branch, '--quiet']);
  const localRes = await gitOut(repo, ['rev-parse', 'HEAD']);
  const remoteRes = await gitOut(repo, ['rev-parse', 'origin/' + branch]);
  const dirtyRes = await gitOut(repo, ['status', '--porcelain']);
  const dirty = dirtyRes.text.split('\n').map((s) => s.trim()).filter(Boolean);

  let behind = 0;
  let ahead = 0;
  const counts = await gitOut(repo, ['rev-list', '--left-right', '--count', 'HEAD...origin/' + branch]);
  if (counts.code === 0 && counts.text) {
    const parts = counts.text.split(/\s+/);
    ahead = Number(parts[0] || 0);
    behind = Number(parts[1] || 0);
  }

  let commits = [];
  if (behind > 0) {
    const logRes = await gitOut(repo, ['log', '--oneline', '--no-decorate', '-12', 'HEAD..origin/' + branch]);
    commits = logRes.text.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  return {
    ok: true,
    repoRoot: repo,
    branch,
    version: readVersion(repo),
    localCommit: localRes.text.slice(0, 7),
    remoteCommit: remoteRes.text.slice(0, 7),
    behind,
    ahead,
    dirty,
    updateAvailable: behind > 0,
    offline: fetched.code !== 0,
    commits
  };
}

// ===== Workaround de electron-builder en Windows =====
// La cache de winCodeSign se extrae con symlinks y falla sin permisos de
// administrador. Si ya existe una copia extraida, la reutilizamos con el
// nombre que electron-builder espera para que no vuelva a descomprimir.
function primeWinCodeSignCache(onLine) {
  if (!IS_WIN) return;
  try {
    const cache = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'),
      'electron-builder', 'Cache', 'winCodeSign');
    if (!fs.existsSync(cache)) return;
    const target = path.join(cache, 'winCodeSign-2.6.0');
    if (fs.existsSync(path.join(target, 'windows-10', 'x64', 'signtool.exe'))) return;
    const donor = fs.readdirSync(cache)
      .filter((n) => /^\d+$/.test(n))
      .map((n) => path.join(cache, n))
      .find((d) => fs.existsSync(path.join(d, 'windows-10', 'x64', 'signtool.exe')));
    if (!donor) return;
    fs.cpSync(donor, target, { recursive: true, force: true, dereference: true });
    onLine('Cache de firma preparada (evita el fallo de symlinks de electron-builder).');
  } catch (e) {
    onLine('Aviso: no pude preparar la cache de firma: ' + e.message);
  }
}

// Elegir el instalador POR VERSION, no por fecha: en dist-electron se acumulan
// los builds viejos, y quedarse con el mtime mas reciente puede reinstalar una
// version anterior (o dejar creer que se actualizo cuando no). Si el build de la
// version esperada no esta, es un fallo: mejor abortar que instalar otra cosa.
function findLatestSetup(repo, expectedVersion) {
  const dir = path.join(repo, 'dist-electron');
  if (!fs.existsSync(dir)) return null;
  const found = fs.readdirSync(dir)
    .filter((n) => /^HanstlerS Setup .*\.exe$/i.test(n))
    .map((n) => {
      const full = path.join(dir, n);
      const m = n.match(/^HanstlerS Setup (.+)\.exe$/i);
      return { full, version: m ? m[1] : '', mtime: fs.statSync(full).mtimeMs };
    });
  if (!found.length) return null;
  if (expectedVersion) {
    const exacto = found.filter((f) => f.version === expectedVersion);
    if (!exacto.length) return null;
    return exacto.sort((a, b) => b.mtime - a.mtime)[0].full;
  }
  return found.sort((a, b) => b.mtime - a.mtime)[0].full;
}

function readRepoVersion(repo) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    return (pkg && pkg.version) || '';
  } catch (e) { return ''; }
}

const RESULT_FILE = path.join(HOME, '.hanstlers', 'update-result.json');

// El resultado que dejo el script externo la ultima vez. Sin esto, si el
// instalador falla la app se relanza en la version vieja y el usuario cree que
// ya actualizo: exactamente el caso de quedarse en 1.0.6 sin enterarse.
function lastApplyResult() {
  try {
    const r = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return r && typeof r === 'object' ? r : null;
  } catch (e) { return null; }
}

// ===== Script que cierra, instala y relanza =====
// Se lanza detached: sobrevive al cierre de HanstlerS y lo vuelve a abrir.
function writeApplyScript(repo, setupExe, expectedVersion) {
  const dir = path.join(HOME, '.hanstlers');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const logFile = path.join(dir, 'update-apply.log');
  const scriptPath = path.join(dir, 'apply-update.ps1');
  // Se borra el resultado anterior para no confundir un update viejo con este.
  try { fs.unlinkSync(RESULT_FILE); } catch (e) {}
  const ps = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$log = ' + JSON.stringify(logFile),
    '$esperada = ' + JSON.stringify(expectedVersion || ''),
    'function W($m){ "$(Get-Date -Format o)  $m" | Out-File -FilePath $log -Append -Encoding utf8 }',
    'W "Esperando a que HanstlerS cierre..."',
    'for ($i = 0; $i -lt 60; $i++) {',
    '  if (-not (Get-Process -Name HanstlerS -ErrorAction SilentlyContinue)) { break }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    'Get-Process -Name HanstlerS -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }',
    'Start-Sleep -Seconds 2',
    'W "Instalando ' + setupExe.replace(/"/g, '') + '"',
    '$p = Start-Process -FilePath ' + JSON.stringify(setupExe) + ' -ArgumentList "/S" -Wait -PassThru',
    '$code = $p.ExitCode',
    'W "Instalador termino con codigo $code"',
    'Start-Sleep -Seconds 2',
    '$exe = Join-Path $env:LOCALAPPDATA "Programs\\HanstlerS\\HanstlerS.exe"',
    // Verificar de verdad que en disco quedo la version esperada. El instalador
    // puede devolver 0 y no haber sustituido nada (app abierta, permisos, etc.).
    '$instalada = ""',
    'if (Test-Path $exe) { $instalada = (Get-Item $exe).VersionInfo.ProductVersion }',
    'if ($instalada) { $instalada = ($instalada -split "\\+")[0].Trim() }',
    '$corta = $instalada',
    'if ($corta -match "^(\\d+\\.\\d+\\.\\d+)") { $corta = $Matches[1] }',
    '$ok = ($code -eq 0) -and ($esperada -eq "" -or $corta -eq $esperada)',
    'W "Version en disco: $instalada (esperaba $esperada) -> ok=$ok"',
    '$res = [ordered]@{ ok = $ok; expected = $esperada; installed = $corta; exitCode = $code; at = (Get-Date).ToString("o") }',
    '$json = $res | ConvertTo-Json -Compress',
    '[System.IO.File]::WriteAllText(' + JSON.stringify(RESULT_FILE) + ', $json, (New-Object System.Text.UTF8Encoding($false)))',
    'if (-not $ok) { W "AVISO: la actualizacion NO se aplico. La app seguira en la version anterior." }',
    'if (Test-Path $exe) { W "Relanzando"; Start-Process $exe } else { W "No encontre HanstlerS.exe" }'
  ].join('\r\n');
  fs.writeFileSync(scriptPath, ps, 'utf8');
  return { scriptPath, logFile };
}

function launchApply(scriptPath) {
  const child = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
    { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

// ===== El ciclo completo =====
async function runUpdate(options, onFinish) {
  const opts = options || {};
  if (job.running) return { ok: false, error: 'Ya hay una actualizacion en curso.' };

  const repo = findRepoRoot();
  if (!repo) return { ok: false, error: 'No encontre el repositorio fuente de HanstlerS.' };

  job.running = true;
  job.done = false;
  job.ok = false;
  job.error = '';
  job.restarting = false;
  job.step = '';
  job.steps = [];
  job.log = [];
  job.startedAt = Date.now();
  job.finishedAt = 0;

  const log = (l) => pushLog(l);

  (async () => {
    try {
      const branchRes = await gitOut(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = branchRes.text || 'main';

      // 1. Traer cambios
      setStep('Descargando cambios');
      const dirtyRes = await gitOut(repo, ['status', '--porcelain']);
      const dirty = dirtyRes.text.split('\n').map((s) => s.trim()).filter(Boolean);
      if (dirty.length && !opts.force) {
        throw new Error('Hay cambios locales sin guardar en el repo (' + dirty.length +
          ' archivo(s)). Haz commit o descartalos antes de actualizar.');
      }
      const lockBefore = safeRead(path.join(repo, 'package-lock.json'));
      const pull = await runCmd('git', ['pull', '--ff-only', 'origin', branch], repo, log);
      if (pull.code !== 0) throw new Error('git pull fallo. Revisa el log.');

      // 2. Dependencias, solo si cambiaron
      const lockAfter = safeRead(path.join(repo, 'package-lock.json'));
      if (lockBefore !== lockAfter || !fs.existsSync(path.join(repo, 'node_modules'))) {
        setStep('Instalando dependencias');
        const inst = await runCmd('npm', ['install', '--no-audit', '--no-fund'], repo, log);
        if (inst.code !== 0) throw new Error('npm install fallo.');
      } else {
        pushLog('Dependencias sin cambios, me salto npm install.');
      }

      // 3. Pruebas: no publicamos un build roto
      if (!opts.skipTests) {
        setStep('Ejecutando pruebas');
        const test = await runCmd('npm', ['test'], repo, log);
        if (test.code !== 0) throw new Error('Las pruebas fallaron. No instalo un build roto.');
      }

      // 4. Sincronizar ask-cli
      const askInstall = path.join(repo, 'ask-cli', 'install.ps1');
      if (fs.existsSync(askInstall)) {
        setStep('Sincronizando ask-cli');
        await runCmd('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', askInstall], repo, log);
      }

      // 5. Compilar el instalador
      if (opts.skipBuild) {
        setStep('Listo (sin recompilar)');
        job.ok = true;
        return;
      }
      setStep('Compilando la aplicacion');
      primeWinCodeSignCache(log);
      const dist = await runCmd('npm', ['run', 'dist'], repo, log,
        { env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
      if (dist.code !== 0) throw new Error('La compilacion fallo. Revisa el log.');

      // La version que acabamos de traer con el pull: es la que DEBE quedar
      // instalada. Buscar por nombre evita reinstalar un build viejo que siga
      // en dist-electron.
      const expectedVersion = readRepoVersion(repo);
      const setupExe = findLatestSetup(repo, expectedVersion);
      if (!setupExe) {
        throw new Error(expectedVersion
          ? 'La compilacion no genero el instalador de la version ' + expectedVersion + '. No instalo una version distinta.'
          : 'La compilacion no genero instalador en dist-electron.');
      }

      // 6. Instalar y relanzar desde fuera del proceso
      setStep('Instalando y reiniciando');
      const { scriptPath } = writeApplyScript(repo, setupExe, expectedVersion);
      launchApply(scriptPath);
      job.restarting = true;
      job.ok = true;
      job.expectedVersion = expectedVersion;
      pushLog('Instalador lanzado: ' + path.basename(setupExe));
      pushLog('Al reabrirse, HanstlerS comprobara que quedo en la version ' + (expectedVersion || 'nueva') + '.');
      pushLog('HanstlerS se cerrara y volvera a abrir solo en unos segundos.');
    } catch (e) {
      job.ok = false;
      job.error = e && e.message ? e.message : String(e);
      pushLog('ERROR: ' + job.error);
    } finally {
      job.running = false;
      job.done = true;
      job.finishedAt = Date.now();
      if (typeof onFinish === 'function') {
        try { onFinish(job); } catch (e) {}
      }
    }
  })();

  return { ok: true, started: true };
}

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

function status(since) {
  const from = Number(since || 0);
  return {
    running: job.running,
    done: job.done,
    ok: job.ok,
    step: job.step,
    steps: job.steps,
    error: job.error,
    restarting: job.restarting,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    nextCursor: job.log.length,
    lines: job.log.slice(from),
    lastApply: lastApplyResult()
  };
}

module.exports = { findRepoRoot, checkUpdate, runUpdate, status, findLatestSetup, lastApplyResult, RESULT_FILE };
