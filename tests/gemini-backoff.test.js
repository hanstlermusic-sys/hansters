// Prueba la espera entre reintentos de Gemini. Extrae la funcion REAL de
// server.js en un sandbox para que no pueda quedar desincronizada. No usa red.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SERVER = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');

const desde = 'function geminiEsperaReintento(';
const a = src.indexOf(desde);
if (a < 0) {
  console.error('No encuentro geminiEsperaReintento en server.js');
  process.exit(1);
}
const fin = src.slice(a).search(/\r?\n\}\r?\n/);
if (fin < 0) {
  console.error('No encuentro el final de geminiEsperaReintento');
  process.exit(1);
}
const codigo = src.slice(a, a + fin) + '\n}\n';

const sandbox = { Number, Date, Math, JSON, String, parseFloat, module: {}, exports: {} };
vm.createContext(sandbox);
vm.runInContext(codigo + '\nthis.fn = geminiEsperaReintento;', sandbox);
const esperar = sandbox.fn;

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

// El jitter es aleatorio (0-500ms); las aserciones usan rangos.
const JITTER = 500;

console.log('gemini backoff');

test('sin pistas del servidor retrocede exponencialmente', () => {
  const uno = esperar(1, null, null);
  const dos = esperar(2, null, null);
  const tres = esperar(3, null, null);
  assert.ok(uno >= 2000 && uno <= 2000 + JITTER, `intento 1 = ${uno}, esperaba ~2000`);
  assert.ok(dos >= 4000 && dos <= 4000 + JITTER, `intento 2 = ${dos}, esperaba ~4000`);
  assert.ok(tres >= 8000 && tres <= 8000 + JITTER, `intento 3 = ${tres}, esperaba ~8000`);
});

test('el backoff crece de verdad entre intentos', () => {
  // Con el bug anterior (1500 * intento) la progresion era demasiado plana.
  const uno = esperar(1, null, null);
  const tres = esperar(3, null, null);
  assert.ok(tres > uno * 2, `el intento 3 (${tres}) deberia superar con creces al 1 (${uno})`);
});

test('respeta Retry-After en segundos', () => {
  const ms = esperar(1, { 'retry-after': '30' }, null);
  assert.ok(ms >= 30000 && ms <= 30000 + JITTER, `dio ${ms}, esperaba ~30000`);
});

test('Retry-After manda sobre el exponencial', () => {
  // Un 429 con Retry-After alto: reintentar antes solo gasta un intento.
  const conCabecera = esperar(1, { 'retry-after': '45' }, null);
  const sinCabecera = esperar(1, null, null);
  assert.ok(conCabecera > sinCabecera, 'deberia esperar mas de lo que dice el exponencial');
});

test('acepta Retry-After como fecha HTTP', () => {
  const futuro = new Date(Date.now() + 20000).toUTCString();
  const ms = esperar(1, { 'retry-after': futuro }, null);
  assert.ok(ms >= 18000 && ms <= 21000 + JITTER, `dio ${ms}, esperaba ~20000`);
});

test('una fecha pasada no produce esperas negativas', () => {
  const pasado = new Date(Date.now() - 60000).toUTCString();
  const ms = esperar(1, { 'retry-after': pasado }, null);
  assert.ok(ms >= 0, `espera negativa: ${ms}`);
});

test('lee retryDelay de RetryInfo en el cuerpo', () => {
  const raw = JSON.stringify({
    error: { code: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }] }
  });
  const ms = esperar(1, {}, raw);
  assert.ok(ms >= 12000 && ms <= 12000 + JITTER, `dio ${ms}, esperaba ~12000`);
});

test('la cabecera tiene prioridad sobre el cuerpo', () => {
  const raw = JSON.stringify({ error: { details: [{ retryDelay: '5s' }] } });
  const ms = esperar(1, { 'retry-after': '25' }, raw);
  assert.ok(ms >= 25000 && ms <= 25000 + JITTER, `dio ${ms}, esperaba ~25000`);
});

test('un cuerpo corrupto no revienta', () => {
  const ms = esperar(1, {}, '<html>502 Bad Gateway</html>');
  assert.ok(ms >= 2000 && ms <= 2000 + JITTER, `dio ${ms}, esperaba el exponencial`);
});

test('tolera headers y cuerpo ausentes', () => {
  assert.ok(esperar(1, undefined, undefined) > 0);
  assert.ok(esperar(1, {}, '') > 0);
});

test('un Retry-After absurdo se recorta a 60s', () => {
  // Sin tope, un "3600" dejaria la app colgada una hora.
  const ms = esperar(1, { 'retry-after': '3600' }, null);
  assert.ok(ms <= 60000 + JITTER, `dio ${ms}, deberia recortarse a 60000`);
});

test('un Retry-After no numerico cae al exponencial', () => {
  const ms = esperar(2, { 'retry-after': 'pronto' }, null);
  assert.ok(ms >= 4000 && ms <= 4000 + JITTER, `dio ${ms}, esperaba el exponencial`);
});

test('el jitter separa reintentos simultaneos', () => {
  const muestras = new Set();
  for (let i = 0; i < 40; i++) muestras.add(esperar(1, null, null));
  assert.ok(muestras.size > 1, 'sin jitter, varias peticiones reintentarian a la vez');
});

test('el reintento por socket reenvia el mismo payload', () => {
  // Bug real: el reintento del handler de error omitia payloadOverride, asi que
  // reenviaba una conversacion distinta a la que habia fallado.
  const i = src.indexOf('function geminiChatWithTools');
  const err = src.indexOf("req.on('error'", i);
  const rel = src.slice(err).search(/\r?\n\}\r?\n/);
  const cuerpo = src.slice(i, err + (rel < 0 ? 2000 : rel));
  const llamadas = cuerpo.match(/lanzar\(endpoint, authHeader, sinTools, modelUsed[^)]*\)/g) || [];
  assert.ok(llamadas.length > 0, 'no encuentro las llamadas de reintento');
  for (const c of llamadas) {
    // El reintento degradado manda OTRO payload a proposito: es el que convierte
    // el historial a texto plano cuando Gemini rechaza la estructura de las
    // herramientas. Los demas reintentos si deben reenviar el mismo.
    if (c.includes('payloadDegradado()')) continue;
    assert.ok(c.includes('payloadOverride'), 'un reintento pierde el payload: ' + c);
  }
  assert.ok(llamadas.some((c) => c.includes('payloadDegradado()')),
    'falta el reintento que degrada el historial cuando Gemini rechaza la estructura');
});

// Un Retry-After de 0 es una pista valida ("reintenta ya"), no ausencia de
// pista. Comprobarlo con `if (!segundos)` lo mandaba al exponencial y hacia
// esperar 8s cuando el servidor decia que se podia reintentar de inmediato.
test('un Retry-After de 0 no se confunde con "sin pista"', () => {
  const ms = esperar(3, { 'retry-after': '0' }, null);
  assert.ok(ms <= JITTER, `un 0 explicito debe reintentar ya; espero ${ms}ms`);
});

test('un retryDelay de 0s en el cuerpo tampoco cae al exponencial', () => {
  const raw = JSON.stringify({ error: { details: [{ retryDelay: '0s' }] } });
  const ms = esperar(3, {}, raw);
  assert.ok(ms <= JITTER, `espero ${ms}ms, deberia reintentar ya`);
});
console.log(`\nbackoff: ${pasan} ok, ${fallan} fallan`);
if (fallan > 0) process.exit(1);