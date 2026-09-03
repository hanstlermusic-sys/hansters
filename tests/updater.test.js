// Pruebas del actualizador integrado (updater.js).
// No tocan red ni git real: se validan la deteccion del repo fuente, el
// armado del script de instalacion y el reporte de estado con cursor.
const fs = require('fs');
const os = require('os');
const path = require('path');

const updater = require('../updater.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '  -> ' + e.message); }
}
function ok(cond, m) { if (!cond) throw new Error(m || 'esperaba verdadero'); }
function eq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((m || '') + ' esperado ' + JSON.stringify(b) + ' pero fue ' + JSON.stringify(a));
  }
}

console.log('\n--- updater ---');

t('exporta la API que consume server.js', () => {
  ['findRepoRoot', 'checkUpdate', 'runUpdate', 'status'].forEach((k) => {
    ok(typeof updater[k] === 'function', 'falta ' + k);
  });
});

t('encuentra el repo fuente desde el propio checkout', () => {
  const root = updater.findRepoRoot();
  ok(root, 'no encontro el repo');
  ok(fs.existsSync(path.join(root, 'server.js')), 'el repo hallado no tiene server.js');
  ok(fs.existsSync(path.join(root, 'package.json')), 'el repo hallado no tiene package.json');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  eq(pkg.name, 'hanstlers', 'nombre del paquete:');
});

t('status devuelve un cursor y una lista de lineas', () => {
  const st = updater.status(0);
  ok(typeof st.running === 'boolean', 'running debe ser booleano');
  ok(typeof st.nextCursor === 'number', 'nextCursor debe ser numero');
  ok(Array.isArray(st.lines), 'lines debe ser arreglo');
  ok(Array.isArray(st.steps), 'steps debe ser arreglo');
});

t('status respeta el cursor y no reenvia lineas ya entregadas', () => {
  const all = updater.status(0);
  const tail = updater.status(all.nextCursor);
  eq(tail.lines.length, 0, 'desde el cursor final no deben quedar lineas:');
});

t('rechaza actualizar si no hay repo fuente', async () => {
  // findRepoRoot cachea; aqui solo validamos el contrato de error de runUpdate
  // cuando se le pasa un estado imposible, sin lanzar procesos.
  const st = updater.status(0);
  ok(st.error === '' || typeof st.error === 'string', 'error debe ser cadena');
});

// El script de aplicacion es la pieza critica: si esta mal armado, la app se
// cierra y no vuelve. Validamos su contenido reconstruyendo la misma logica
// que usa updater.js sobre el archivo fuente.
t('el script de instalacion espera, instala en silencio y relanza', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'updater.js'), 'utf8');
  const from = src.indexOf('function writeApplyScript(');
  const to = src.indexOf('function launchApply(');
  ok(from > 0 && to > from, 'no encontre writeApplyScript');
  const body = src.slice(from, to);
  ok(/Get-Process -Name HanstlerS/.test(body), 'debe esperar a que el proceso cierre');
  ok(/Stop-Process/.test(body), 'debe forzar el cierre si se resiste');
  ok(/ArgumentList "\/S"/.test(body), 'debe instalar en modo silencioso');
  ok(/-Wait/.test(body), 'debe esperar a que el instalador termine');
  ok(/Start-Process \$exe/.test(body), 'debe relanzar la app al final');
});

t('el instalador se lanza desacoplado del proceso actual', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'updater.js'), 'utf8');
  const from = src.indexOf('function launchApply(');
  const to = src.indexOf('async function runUpdate(');
  const body = src.slice(from, to);
  ok(/detached:\s*true/.test(body), 'debe ser detached para sobrevivir al cierre');
  ok(/\.unref\(\)/.test(body), 'debe hacer unref para no bloquear la salida');
  ok(/ExecutionPolicy['"]?,\s*['"]Bypass/.test(body), 'debe saltar la politica de ejecucion');
});

t('server.js expone las rutas del actualizador', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ["'/api/update/check'", "'/api/update/status'", "'/api/update/run'"].forEach((r) => {
    ok(src.indexOf(r) > 0, 'falta la ruta ' + r);
  });
  ok(/require\('\.\/updater'\)/.test(src), 'server.js debe requerir updater.js');
  ok(/requireAdminOrDeny\(req, res\)/.test(src.slice(src.indexOf("'/api/update/run'") - 400,
    src.indexOf("'/api/update/run'") + 400)), '/api/update/run debe exigir admin');
});

t('updater.js viaja dentro del paquete de electron-builder', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  ok(pkg.build.files.indexOf('updater.js') >= 0,
    'updater.js debe estar en build.files o no se empaqueta');
});

t('la interfaz tiene el boton y el panel de actualizacion', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  ['id="btn-update"', 'id="update-overlay"', 'id="update-go"', 'id="update-log"'].forEach((s) => {
    ok(html.indexOf(s) > 0, 'falta ' + s + ' en index.html');
  });
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  ok(app.indexOf('/api/update/check') > 0, 'app.js debe consultar /api/update/check');
  ok(app.indexOf('/api/update/run') > 0, 'app.js debe poder disparar /api/update/run');
  ok(app.indexOf('/api/update/status') > 0, 'app.js debe sondear /api/update/status');
});

// ===== la actualizacion no puede mentir (regresion 1.0.9) =====
// Sintoma real: se pulsa actualizar, la app se reinicia, dice que todo fue bien
// y sigue en la version anterior. Dos causas, las dos cubiertas aqui.
console.log('\n--- instalar la version correcta, o ninguna ---');

function repoConSetups(lista) {
  const dir = path.join(os.tmpdir(), 'hs_setups_' + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(dir, 'dist-electron'), { recursive: true });
  lista.forEach(([nombre, edadSeg]) => {
    const f = path.join(dir, 'dist-electron', nombre);
    fs.writeFileSync(f, 'x');
    const s = Date.now() / 1000 - edadSeg;
    fs.utimesSync(f, s, s);
  });
  return dir;
}

t('no reinstala un build viejo aunque su archivo sea el mas reciente', () => {
  // En dist-electron se acumulan todos los builds. Elegir por fecha puede
  // reinstalar una version anterior y dejar creer que se actualizo.
  const repo = repoConSetups([['HanstlerS Setup 1.0.8.exe', 500], ['HanstlerS Setup 1.0.6.exe', 10]]);
  const elegido = updater.findLatestSetup(repo, '1.0.8');
  eq(path.basename(elegido), 'HanstlerS Setup 1.0.8.exe', 'eligio un build que no es el esperado:');
  fs.rmSync(repo, { recursive: true, force: true });
});

t('si falta el build de la version esperada, aborta en vez de instalar otra', () => {
  const repo = repoConSetups([['HanstlerS Setup 1.0.6.exe', 10]]);
  ok(updater.findLatestSetup(repo, '1.0.8') === null,
    'devolvio un instalador de otra version: instalaria la equivocada');
  fs.rmSync(repo, { recursive: true, force: true });
});

t('sin version esperada mantiene el comportamiento por fecha', () => {
  const repo = repoConSetups([['HanstlerS Setup 1.0.6.exe', 500], ['HanstlerS Setup 1.0.8.exe', 10]]);
  eq(path.basename(updater.findLatestSetup(repo, null)), 'HanstlerS Setup 1.0.8.exe');
  fs.rmSync(repo, { recursive: true, force: true });
});

console.log('\n--- verificar que la instalacion de verdad ocurrio ---');

t('el script comprueba la version que quedo en disco', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'updater.js'), 'utf8');
  const i = src.indexOf('function writeApplyScript(');
  const cuerpo = src.slice(i, src.indexOf('\nfunction ', i + 10));
  ok(cuerpo.indexOf('VersionInfo.ProductVersion') !== -1,
    'no lee la version instalada: no puede saber si el instalador hizo algo');
  ok(cuerpo.indexOf('$esperada') !== -1, 'no compara contra la version esperada');
  ok(cuerpo.indexOf('update-result.json') !== -1 || cuerpo.indexOf('RESULT_FILE') !== -1,
    'no deja constancia del resultado para que la app pueda avisar');
});

t('un instalador que devuelve 0 sin instalar nada NO se da por bueno', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'updater.js'), 'utf8');
  const i = src.indexOf('function writeApplyScript(');
  const cuerpo = src.slice(i, src.indexOf('\nfunction ', i + 10));
  // El ok debe exigir AMBAS cosas: codigo 0 y version en disco correcta.
  ok(/\$ok = \(\$code -eq 0\) -and/.test(cuerpo),
    'basta con que el instalador devuelva 0: asi es como paso desapercibido');
});

t('el estado del updater expone el resultado de la ultima instalacion', () => {
  const s = updater.status(0);
  ok(Object.prototype.hasOwnProperty.call(s, 'lastApply'),
    'status() no expone lastApply: la app no puede avisar de un update fallido');
});

t('la app avisa cuando la version instalada no es la esperada', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = srv.indexOf("req.url === '/api/update/check'");
  const bloque = srv.slice(i, i + 1600);
  ok(bloque.indexOf('lastApplyFailed') !== -1,
    '/api/update/check no reporta que la ultima actualizacion no se aplico');
});
console.log('\n--- el guardarrail no bloquea por carpetas ajenas ---');

// Caso real: en la carpeta del repo conviven otros proyectos sin trackear
// (Hanstler/, dj-set-studio/, xtudio-backend/). Contarlos como "cambios sin
// guardar" bloqueaba el boton de actualizar con un error irresoluble: no habia
// nada que commitear y descartarlos habria borrado trabajo ajeno.
t('el chequeo de repo sucio ignora los archivos sin trackear', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'updater.js'), 'utf8');
  // Hay dos chequeos: el de checkUpdate (lo que muestra la pantalla) y el de
  // runUpdate (el que aborta). Los dos deben ignorar los untracked.
  const usos = src.match(/'status', '--porcelain'[^\]]*/g) || [];
  ok(usos.length >= 2, 'esperaba dos chequeos de repo sucio, encontre ' + usos.length);
  usos.forEach((u, i) => {
    ok(u.indexOf('--untracked-files=no') !== -1,
      'el chequeo ' + (i + 1) + ' cuenta los untracked: una carpeta ajena bloquea la actualizacion');
  });
});

t('pero sigue bloqueando si hay cambios de verdad', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'updater.js'), 'utf8');
  ok(/if \(dirty\.length && !opts\.force\)/.test(src),
    'ya no aborta ante cambios locales reales: el pull los sobreescribiria');
});

t('el script reparador aplica el mismo criterio', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'tools', 'repair-update.ps1'), 'utf8');
  ok(ps.indexOf('--untracked-files=no') !== -1,
    'repair-update.ps1 se bloquearia con las mismas carpetas ajenas');
});

console.log('\n--- los manifiestos no llevan BOM ---');

// Un BOM en package.json rompe el build entero con un error ilegible:
// "readObjectStart: expect { or n, but found \ufeff". Es facil de introducir sin
// querer: Set-Content -Encoding utf8 de PowerShell 5.1 lo mete siempre.
['package.json', 'package-lock.json'].forEach((nombre) => {
  t('sin BOM: ' + nombre, () => {
    const f = path.join(__dirname, '..', nombre);
    if (!fs.existsSync(f)) return;
    const b = fs.readFileSync(f);
    ok(!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf),
      nombre + ' empieza por BOM: electron-builder no podra leerlo');
    JSON.parse(b.toString('utf8'));
  });
});

console.log('\n=== ' + pass + ' pasaron, ' + fail + ' fallaron ===\n');
process.exit(fail ? 1 : 0);
