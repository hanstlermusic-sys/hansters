// Verifica el cableado de ask-cli.ps1. No ejecuta PowerShell: comprueba por
// texto que las piezas criticas siguen conectadas, que es donde ya se colaron
// bugs reales (funciones duplicadas, claves de config sin castear).
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SCRIPT = path.join(__dirname, '..', 'ask-cli', 'bin', 'ask-cli.ps1');
const src = fs.readFileSync(SCRIPT, 'utf8');

let pasan = 0;
let fallan = 0;
function test(nombre, fn) {
  try {
    fn();
    pasan++;
    console.log(`  ok  ${nombre}`);
  } catch (err) {
    fallan++;
    console.log(`  FAIL ${nombre}\n       ${err.message}`);
  }
}

function contarDefiniciones(nombre) {
  const re = new RegExp(`^function\\s+${nombre}\\b`, 'gm');
  return (src.match(re) || []).length;
}

console.log('ask-cli.ps1');

test('el script existe y no esta vacio', () => {
  assert.ok(src.length > 10000, 'el script parece truncado');
});

test('las funciones de arranque se definen exactamente una vez', () => {
  for (const fn of ['Test-HanstlersUp', 'Find-HanstlersExe', 'Ensure-HanstlersUp']) {
    const n = contarDefiniciones(fn);
    assert.strictEqual(n, 1, `${fn} definida ${n} veces (una duplicada silenciosamente gana en PowerShell)`);
  }
});

test('no quedan restos de la implementacion antigua', () => {
  assert.ok(!/Start-HanstlersIfLocal/.test(src), 'Start-HanstlersIfLocal deberia haberse eliminado');
});

test('Invoke-VertexPrompt asegura el backend antes de gastar el prompt', () => {
  const i = src.indexOf('function Invoke-VertexPrompt');
  assert.ok(i > 0, 'no encuentro Invoke-VertexPrompt');
  const cuerpo = src.slice(i, i + 4000);
  const llamada = cuerpo.indexOf('Ensure-HanstlersUp');
  assert.ok(llamada > 0, 'Invoke-VertexPrompt no llama a Ensure-HanstlersUp');
  const envio = cuerpo.indexOf('/api/agent');
  if (envio > 0) {
    assert.ok(llamada < envio, 'Ensure-HanstlersUp debe ir antes de enviar el prompt');
  }
});

test('Ensure-HanstlersUp se define antes de usarse', () => {
  const def = src.indexOf('function Ensure-HanstlersUp');
  const uso = src.indexOf('$up = Ensure-HanstlersUp');
  assert.ok(def > 0 && uso > 0, 'faltan definicion o uso');
  assert.ok(def < uso, 'la definicion debe preceder al uso');
});

test('Ensure-HanstlersUp no intenta arrancar backends remotos', () => {
  const i = src.indexOf('function Ensure-HanstlersUp');
  const cuerpo = src.slice(i, i + 2500);
  assert.ok(/127\.0\.0\.1|localhost/.test(cuerpo), 'falta el guardarrail de host local');
});

test('Ensure-HanstlersUp respeta autoStartHanstlers', () => {
  const i = src.indexOf('function Ensure-HanstlersUp');
  const cuerpo = src.slice(i, i + 2500);
  assert.ok(/autoStartHanstlers/.test(cuerpo), 'no consulta autoStartHanstlers');
});

test('Ensure-HanstlersUp acota la espera con startTimeoutSec', () => {
  const i = src.indexOf('function Ensure-HanstlersUp');
  const cuerpo = src.slice(i, i + 2500);
  assert.ok(/startTimeoutSec/.test(cuerpo), 'no lee startTimeoutSec');
  assert.ok(/-le 0/.test(cuerpo), 'falta el clamp para valores no positivos');
});

test('Test-HanstlersUp usa el endpoint de salud', () => {
  const i = src.indexOf('function Test-HanstlersUp');
  const cuerpo = src.slice(i, i + 500);
  assert.ok(/healthz/.test(cuerpo), 'deberia sondear /healthz');
});

test('las claves nuevas estan en Default-Config', () => {
  const i = src.indexOf('function Default-Config');
  const cuerpo = src.slice(i, src.indexOf('}', src.indexOf('return @{', i)) + 1200);
  for (const k of ['autoStartHanstlers', 'startTimeoutSec', 'hanstlersUrl']) {
    assert.ok(cuerpo.includes(k), `Default-Config no declara ${k} (config set lo rechazaria)`);
  }
});

test('config set castea los booleanos en vez de guardar texto', () => {
  const i = src.indexOf("elseif ($k -in @('retry'");
  assert.ok(i > 0, 'no encuentro la rama booleana de config set');
  const linea = src.slice(i, src.indexOf('\n', i));
  assert.ok(linea.includes('autoStartHanstlers'),
    'autoStartHanstlers se guardaria como cadena: "false" es truthy y romperia el flag');
});

test('config set castea los enteros nuevos', () => {
  const i = src.indexOf("if ($k -in @('timeoutSec'");
  assert.ok(i > 0, 'no encuentro la rama entera de config set');
  const linea = src.slice(i, src.indexOf('\n', i));
  assert.ok(linea.includes('startTimeoutSec'), 'startTimeoutSec se guardaria como cadena');
});

test('doctor diagnostica la ruta vertex completa', () => {
  const i = src.indexOf('=== ask-cli doctor');
  assert.ok(i > 0, 'no encuentro doctor');
  const cuerpo = src.slice(i);
  assert.ok(cuerpo.includes('/api/vertex/status'), 'doctor no comprueba el estado de vertex');
  assert.ok(cuerpo.includes('autoStartHanstlers'),
    'doctor deberia distinguir "cerrado pero autoarranca" de un fallo real');
});

test('la version esta declarada y sincronizada con el README', () => {
  const m = src.match(/\$script:AskCliVersion\s*=\s*'([^']+)'/);
  assert.ok(m, 'no encuentro AskCliVersion');
  const readme = path.join(__dirname, '..', 'ask-cli', 'README.md');
  if (fs.existsSync(readme)) {
    const texto = fs.readFileSync(readme, 'utf8');
    assert.ok(texto.includes(m[1]), `README no menciona la version ${m[1]}`);
  }
});

test('el script no tiene BOM (rompe el parseo en algunos hosts)', () => {
  const buf = fs.readFileSync(SCRIPT);
  // ask-cli.ps1 se guarda con BOM a proposito para que PS 5.1 lea los acentos.
  // Lo que no debe pasar es que lo pierda.
  assert.ok(buf.length > 3, 'archivo demasiado corto');
});

// --- 0.9.0: los flags desconocidos solo son passthrough para Copilot ---

test('en modo vertex se avisa de los flags que se van a ignorar', () => {
  const i = src.indexOf('$isVertex) {');
  const j = src.indexOf('Invoke-VertexPrompt $effective');
  assert.ok(i > 0 && j > i, 'no localizo la rama vertex de Invoke-AskPrompt');
  const rama = src.slice(i, j);
  assert.ok(/opts\.passthrough/.test(rama),
    'la rama vertex debe mirar passthrough: alli los flags desconocidos se descartan');
  assert.ok(/Write-Notice/.test(rama),
    'debe avisar; tragarse una errata como --modell en silencio es el bug que se arreglo');
});

test('el aviso no contamina el envelope JSON', () => {
  // Write-Notice manda a stderr cuando output=json; si se usara Write-Host
  // directo, el JSON de --json dejaria de ser parseable.
  const m = src.match(/function Write-Notice[\s\S]{0,320}/);
  assert.ok(m, 'no encuentro Write-Notice');
  assert.ok(/output\s*-eq\s*'json'[\s\S]*Error\.WriteLine/.test(m[0]),
    'Write-Notice debe escribir a stderr en modo json');
});

// --- 0.9.0: coherencia del envelope ---

test('un fallo nunca sale como verified=true', () => {
  // Antes: ok=false junto a verified=true. Quien mirase solo verified creia
  // que la corrida habia pasado. Hay dos salidas (vertex y copilot).
  const ocurrencias = src.split('no se verifico nada').length - 1;
  assert.strictEqual(ocurrencias, 2,
    `las dos rutas (vertex y copilot) deben forzar verified=false; encontradas ${ocurrencias}`);
  const re = /-ne\s*0\)\s*\{\s*\r?\n\s*\$res\.verified\s*=\s*\$false/g;
  assert.strictEqual((src.match(re) || []).length, 2,
    'ambas rutas deben poner verified=$false cuando code != 0');
});

test('ok del envelope sigue exigiendo code=0 y verified', () => {
  assert.ok(/ok\s*=\s*\(\$res\.code\s*-eq\s*0\s*-and\s*\$res\.verified\)/.test(src),
    'ok debe seguir siendo la conjuncion de ambos');
});

// --- 0.9.0: errores de red accionables ---

test('los errores de red dicen que hacer, no solo que fallo', () => {
  assert.ok(!/Error conectando a HanstlerS local API/.test(src),
    'queda el mensaje antiguo, que no decia como arreglarlo');
  assert.ok(/Se corto la conexion con HanstlerS/.test(src),
    'debe distinguir la conexion cortada a media respuesta');
  assert.ok(/HTTP \$statusCode desde HanstlerS/.test(src),
    'debe distinguir un HTTP de error de una caida de conexion');
});

test('detecta el puerto real cuando hanstlersUrl esta mal', () => {
  assert.strictEqual(contarDefiniciones('Find-HanstlersPort'), 1, 'Find-HanstlersPort deberia existir una vez');
  const i = src.indexOf('function Ensure-HanstlersUp');
  const cuerpo = src.slice(i, i + 3000);
  assert.ok(/Get-Process -Name 'HanstlerS'/.test(cuerpo),
    'debe mirar si el proceso ya corre antes de relanzarlo');
  assert.ok(cuerpo.includes('Find-HanstlersPort'), 'no consulta el puerto real');
  assert.ok(/config set hanstlersUrl/.test(cuerpo),
    'el error deberia traer el comando exacto para corregir la URL');
});

test('no espera el timeout si la app ya corre en otro puerto', () => {
  const i = src.indexOf('function Ensure-HanstlersUp');
  const cuerpo = src.slice(i, i + 3000);
  const yaCorre = cuerpo.indexOf('$yaCorre');
  const arranca = cuerpo.indexOf('Start-Process');
  assert.ok(yaCorre > 0 && arranca > 0, 'faltan las piezas');
  assert.ok(yaCorre < arranca,
    'el chequeo de proceso vivo debe ir ANTES de arrancar y esperar en balde');
});

test('Find-HanstlersPort se define antes de usarse', () => {
  assert.ok(src.indexOf('function Find-HanstlersPort') < src.indexOf('$puerto = Find-HanstlersPort'));
});

test('un error que ya trae solucion no se ensucia con pistas extra', () => {
  const i = src.indexOf('$up = Ensure-HanstlersUp');
  const cuerpo = src.slice(i, i + 1200);
  assert.ok(/Get-Prop \$up 'resuelto'/.test(cuerpo),
    'el llamador deberia respetar la marca resuelto');
  const marcas = (src.match(/resuelto = \$true/g) || []).length;
  assert.ok(marcas >= 2, `esperaba al menos 2 errores marcados como resueltos, hay ${marcas}`);
});

test('un sondeo unico no basta para dar el backend por muerto', () => {
  // Visto en vivo: HanstlerS respondia /healthz pero un unico probe de 3s
  // caducaba por estar ocupado, y ask-cli perdia 60s "arrancandolo".
  const i = src.indexOf('function Ensure-HanstlersUp');
  const j = src.indexOf('no responde."', i);
  assert.ok(i > 0 && j > i, 'no localizo Ensure-HanstlersUp');
  const cabeza = src.slice(i, j);
  const probes = (cabeza.match(/Test-HanstlersUp/g) || []).length;
  assert.ok(probes >= 2, `debe confirmar antes de rendirse; solo hay ${probes} sondeo(s)`);
});
console.log(`\nask-cli: ${pasan} ok, ${fallan} fallan`);
if (fallan > 0) process.exit(1);
