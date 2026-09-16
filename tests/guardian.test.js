// Pruebas del vigilante de codigo (guardian.js).
//
// Lo que se vigila aqui es el equilibrio del detector: tiene que encontrar los
// secretos de verdad y NO gritar con los de mentira. Un falso positivo en cada
// guardado convierte el aviso en ruido y se acaba ignorando, y entonces el
// aviso de verdad tambien pasa de largo.
//
// No usa red ni IA. Crea archivos en carpetas temporales y las borra al final.
const fs = require('fs');
const os = require('os');
const path = require('path');

const guardian = require('../guardian');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '  -> ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'falso'); }

// Secretos con formato valido pero inventados: no abren nada. Se arman por
// partes para que ningun escaner los lea como credenciales de verdad.
const GH = 'ghp' + '_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const OPENAI = 'sk' + '-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
const GOOGLE = 'AIza' + 'Sy' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q';
const AWS = 'AKIA' + 'IOSFODNN7EXAMPL1';
const JWT = 'eyJhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dBjftJeZ4CVPmB92K27uhbUJU1p1rXwW1gFWFOEjXk';

function detecta(texto) { return guardian.scanText(texto, 'x.js'); }
function reglas(texto) { return detecta(texto).map((h) => h.regla); }

console.log('\n--- deteccion de secretos ---');

t('encuentra los formatos de cada proveedor', () => {
  assert(reglas('const t = "' + GH + '";').includes('github-token'), 'token de GitHub');
  assert(reglas('key = "' + OPENAI + '"').includes('openai-key'), 'llave de OpenAI');
  assert(reglas('KEY=' + GOOGLE).includes('google-key'), 'llave de Google');
  assert(reglas('aws: ' + AWS).includes('aws-key'), 'llave de AWS');
  assert(reglas('auth = "' + JWT + '"').includes('jwt'), 'JWT');
  assert(reglas('-----BEGIN RSA PRIVATE KEY-----').includes('private-key'), 'llave privada');
  assert(reglas('DefaultEndpointsProtocol=https;AccountKey=' + 'a'.repeat(60) + ';').includes('azure-conn'), 'Azure');
  assert(reglas('DB=postgres://admin:s3cretPass99@db.host/app').includes('conn-string'), 'cadena de conexion');
});

t('reporta el numero de linea correcto', () => {
  const hs = guardian.scanText('linea uno\nlinea dos\nvar k = "' + GH + '";\n', 'a.js');
  assert(hs.length === 1, 'un hallazgo, hubo ' + hs.length);
  assert(hs[0].linea === 3, 'linea 3, dio ' + hs[0].linea);
});

t('el aviso no expone el secreto entero', () => {
  const d = detecta('t = "' + GH + '"')[0].detalle;
  assert(!d.includes(GH), 'el detalle traia el secreto completo');
  assert(d.includes('***'), 'deberia venir enmascarado');
});

console.log('\n--- nada de falsos positivos ---');

t('placeholders y ejemplos no disparan', () => {
  assert(detecta('token = "ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"').length === 0, 'XXXX');
  assert(detecta('key = "sk-your_key_here_aaaaaaaaaaaaaaaaaaaa"').length === 0, 'your_');
  assert(detecta('token = "${GITHUB_TOKEN}"').length === 0, 'variable de shell');
  assert(detecta('token = "%GITHUB_TOKEN%"').length === 0, 'variable de Windows');
  assert(detecta('token = "<tu-token-aqui>"').length === 0, 'marcador');
});

t('codigo normal no dispara', () => {
  const normal = [
    'const path = require("path");',
    'function scanText(text) { return text.split("\\n"); }',
    'const url = "https://github.com/hanstlermusic-sys/hansters";',
    'res.end(JSON.stringify({ ok: true }));'
  ].join('\n');
  const hs = guardian.scanText(normal, 'ok.js');
  assert(hs.length === 0, 'grito con codigo normal: ' + JSON.stringify(hs));
});

t('leer un token desde la configuracion no es exponerlo', () => {
  const src = 'const cfg = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));\nconst token = cfg.githubToken;';
  assert(guardian.scanText(src, 'cfg.js').length === 0, 'falso positivo al leer config');
});

t('el propio guardian.js no se delata a si mismo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'guardian.js'), 'utf8');
  const hs = guardian.scanText(src, 'guardian.js');
  assert(hs.length === 0, 'se detecto a si mismo: ' + JSON.stringify(hs));
});

t('lineas minificadas gigantes se ignoran', () => {
  assert(detecta('var a="' + 'x'.repeat(5000) + '";' + GH).length === 0, 'reviso una linea minificada');
});

console.log('\n--- que archivos se revisan ---');

t('solo codigo y configuracion de texto', () => {
  assert(guardian.esRevisable('a.js'), '.js');
  assert(guardian.esRevisable('a.py'), '.py');
  assert(guardian.esRevisable('.env'), '.env');
  assert(guardian.esRevisable('a.json'), '.json');
  assert(!guardian.esRevisable('a.png'), '.png');
  assert(!guardian.esRevisable('a.exe'), '.exe');
  assert(!guardian.esRevisable('script.min.js'), 'minificado');
});

t('carpetas ajenas o generadas quedan fuera', () => {
  assert(guardian.esRutaIgnorada('node_modules\\x\\a.js'), 'node_modules');
  assert(guardian.esRutaIgnorada('dist-electron/a.js'), 'dist-electron');
  assert(guardian.esRutaIgnorada('.git/config'), '.git');
  assert(!guardian.esRutaIgnorada('tools/a.js'), 'tools deberia revisarse');
});

console.log('\n--- sintaxis y barrido ---');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-guardian-'));
function esc(nombre, txt) {
  const p = path.join(tmp, nombre);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, txt);
  return p;
}

let pendientes = 3;
function acabar() {
  if (--pendientes) return;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + pass + ' pruebas OK, ' + fail + ' fallidas');
  process.exit(fail ? 1 : 0);
}

const roto = esc('roto.js', 'function a( {\n');
guardian.checkSyntax(roto, {}, (h) => {
  t('node --check detecta el archivo roto', () => {
    assert(h, 'no detecto el error de sintaxis');
    assert(h.tipo === 'sintaxis', 'tipo ' + (h && h.tipo));
  });
  const bueno = esc('bueno.js', 'function a() { return 1; }\n');
  guardian.checkSyntax(bueno, {}, (h2) => {
    t('un archivo sano no genera aviso', () => assert(!h2, 'aviso sobre codigo valido'));
    acabar();
  });
});

esc('src/config.js', 'module.exports = { token: "' + GH + '" };\n');
esc('src/limpio.js', 'module.exports = { ok: true };\n');
esc('node_modules/mal/index.js', 'var t = "' + GH + '";\n');
esc('logo.png', GH);
guardian.scanTree(tmp, {}, (hs) => {
  t('el barrido encuentra el secreto y respeta las exclusiones', () => {
    const archivos = hs.map((h) => path.basename(h.archivo));
    assert(archivos.includes('config.js'), 'no encontro config.js');
    assert(!archivos.includes('index.js'), 'reviso node_modules');
    assert(!archivos.includes('logo.png'), 'reviso una imagen');
    assert(!archivos.includes('limpio.js'), 'aviso de un archivo limpio');
  });
  acabar();
});

// Vigilancia en vivo: guardar un archivo tiene que disparar el aviso, y el
// aviso no puede llevar el secreto completo.
const vivo = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-guardian-vivo-'));
const avisos = [];
guardian.start({ cwd: vivo, debounceMs: 150, notify: (tit, msg) => avisos.push(tit + ' | ' + msg) });
setTimeout(() => fs.writeFileSync(path.join(vivo, 'limpio.js'), 'module.exports = 1;\n'), 100);
setTimeout(() => fs.writeFileSync(path.join(vivo, 'fuga.js'), 'const token = "' + GH + '";\n'), 700);
setTimeout(() => {
  const st = guardian.status();
  guardian.stop();
  try { fs.rmSync(vivo, { recursive: true, force: true }); } catch (e) {}
  t('al guardar un archivo con secreto avisa al momento', () => {
    assert(st.hallazgos.some((h) => h.tipo === 'secreto'), 'no detecto el secreto al guardar');
    assert(avisos.length === 1, 'esperaba 1 aviso, hubo ' + avisos.length + ': ' + JSON.stringify(avisos));
    assert(!avisos.join(' ').includes(GH), 'el aviso llevaba el secreto completo');
    assert(!st.hallazgos.some((h) => path.basename(h.archivo) === 'limpio.js'), 'aviso de un archivo limpio');
  });
  t('stop() deja el vigilante inactivo', () => {
    assert(guardian.status().activo === false, 'sigue activo despues de stop()');
  });
  acabar();
}, 2200);
