// Pruebas del contexto del agente.
// No requieren dependencias ni credenciales: extraen las funciones reales de
// server.js y las ejecutan en un sandbox, para que la prueba no pueda quedarse
// desincronizada de la implementacion.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const SERVER = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');

const start = src.indexOf('// ===== Contexto persistente del agente =====');
const end = src.indexOf('function runAzureAgent(');
if (start < 0 || end < 0 || end <= start) {
  console.error('No se pudo extraer el bloque de contexto de server.js');
  process.exit(1);
}

const sandbox = {
  state: {}, __out: null, console: console,
  JSON: JSON, Array: Array, String: String,
  fs: fs, path: path, os: os
};
vm.runInNewContext(
  src.slice(start, end) +
  '\n__out = { trimAgentMessages, buildAgentMessages, ANNOUNCE_RE, AGENT_CTX_MAX_CHARS,' +
  ' saveAgentTranscript, loadAgentTranscript, deleteAgentTranscript, AGENT_DIR };',
  sandbox
);
const {
  trimAgentMessages, buildAgentMessages, ANNOUNCE_RE,
  saveAgentTranscript, loadAgentTranscript, deleteAgentTranscript, AGENT_DIR
} = sandbox.__out;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '  -> ' + e.message); }
}
function eq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((m || '') + ' esperado ' + JSON.stringify(b) + ' pero fue ' + JSON.stringify(a));
  }
}
function ok(c, m) { if (!c) throw new Error(m || 'condicion falsa'); }

const sys = { role: 'system', content: 'SYS' };
// El preambulo de 'system' se reconstruye en cada turno (depende de state.cwd),
// asi que NO forma parte del cuerpo que se recorta ni del que se guarda en disco.
const PRE = [sys];
const big = (n) => 'x'.repeat(n);

console.log('\n--- trimAgentMessages ---');

t('devuelve igual si cabe en el limite', () => {
  const m = [{ role: 'user', content: 'hola' }];
  eq(trimAgentMessages(m, 100000), m);
});

t('tolera arrays vacios o de un solo elemento', () => {
  eq(trimAgentMessages([], 100), []);
  eq(trimAgentMessages(null, 100), []);
  const uno = [{ role: 'user', content: big(9999) }];
  eq(trimAgentMessages(uno, 10), [], 'si ni uno solo cabe, devuelve vacio en vez de romperse');
});

t('recorta cuando se pasa del limite', () => {
  const m = [];
  for (let i = 0; i < 20; i++) m.push({ role: 'user', content: big(500) });
  const r = trimAgentMessages(m, 2000);
  ok(r.length < m.length, 'deberia haber recortado');
  ok(JSON.stringify(r).length <= JSON.stringify(m).length, 'no deberia crecer');
});

t('NUNCA deja un mensaje role:tool huerfano al frente (evita el 400 de la API)', () => {
  const m = [];
  for (let i = 0; i < 12; i++) {
    m.push({ role: 'assistant', content: big(400), tool_calls: [{ id: 'c' + i }] });
    m.push({ role: 'tool', tool_call_id: 'c' + i, content: big(400) });
  }
  for (const limit of [500, 1500, 3000, 5000, 9000]) {
    const r = trimAgentMessages(m, limit);
    ok(!r.length || r[0].role !== 'tool', 'limite ' + limit + ': quedo un tool huerfano al frente');
  }
});

t('recorta por el principio y conserva lo mas reciente', () => {
  const m = [{ role: 'user', content: big(3000) }, { role: 'user', content: 'MAS_RECIENTE' }];
  const r = trimAgentMessages(m, 400);
  ok(JSON.stringify(r).indexOf('MAS_RECIENTE') !== -1, 'se perdio el mensaje reciente');
});

console.log('\n--- buildAgentMessages ---');

t('conversacion nueva: preambulo + historial del cliente', () => {
  sandbox.state = {};
  const r = buildAgentMessages('c1', [{ role: 'user', content: 'hola' }], PRE);
  eq(r, [sys, { role: 'user', content: 'hola' }]);
});

t('reanuda el transcript guardado CON los mensajes de herramienta', () => {
  const prior = [
    { role: 'user', content: 'lee config.json' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a1' }] },
    { role: 'tool', tool_call_id: 'a1', content: 'CONTENIDO_REAL_DEL_ARCHIVO' }
  ];
  sandbox.state = { convAgentMessages: { c9: prior } };
  const r = buildAgentMessages('c9', [], PRE);
  ok(JSON.stringify(r).indexOf('CONTENIDO_REAL_DEL_ARCHIVO') !== -1,
     'el resultado de la herramienta debe sobrevivir al turno siguiente');
  eq(r[0], sys, 'el system prompt debe refrescarse (la carpeta pudo cambiar)');
  eq(r.length, 4, 'preambulo + los 3 mensajes guardados');
});

t('el transcript guardado GANA al historial del cliente', () => {
  // El cliente solo manda el texto de las burbujas; el servidor tiene la verdad.
  sandbox.state = { convAgentMessages: { c7: [{ role: 'user', content: 'DEL_SERVIDOR' }] } };
  const r = buildAgentMessages('c7', [{ role: 'user', content: 'DEL_CLIENTE' }], PRE);
  ok(JSON.stringify(r).indexOf('DEL_SERVIDOR') !== -1, 'deberia usar el del servidor');
  ok(JSON.stringify(r).indexOf('DEL_CLIENTE') === -1, 'no deberia duplicar con el del cliente');
});

t('sin convId no revienta y cae al historial del cliente', () => {
  sandbox.state = {};
  const r = buildAgentMessages('', [{ role: 'user', content: 'x' }], PRE);
  eq(r.length, 2);
});

console.log('\n--- ANNOUNCE_RE (anuncio sin accion) ---');

const anuncios = [
  'Voy a revisar los archivos del proyecto para entender la estructura.',
  'Perfecto. Ahora procedo a crear el archivo de configuracion.',
  'Dejame leer el server.js primero.',
  'Primero voy a listar el directorio.',
  'Revisare las dependencias y te digo.',
  'Let me check the project structure first.',
  "I'll start by reading the config file."
];
const finales = [
  'Listo. Cree calc.py con las funciones suma y resta, y test_calc.py con 4 pruebas; las ejecute y las 4 pasan.',
  'Hecho: corregi el bug de la linea 42 y verifique que compila.',
  'No encontre ningun archivo con ese nombre en la carpeta actual.',
  'El proyecto usa Express 4 y no tiene tests configurados.'
];

t('detecta anuncios de accion futura', () => {
  for (const a of anuncios) ok(ANNOUNCE_RE.test(a), 'no detecto: ' + a);
});

t('NO confunde un resumen final con un anuncio', () => {
  for (const f of finales) ok(!ANNOUNCE_RE.test(f), 'falso positivo en: ' + f);
});

console.log('\n--- persistencia en disco ---');

const TESTID = 'zz-test-' + process.pid + '-' + Date.now();

t('ida y vuelta a disco conservando los mensajes de herramienta', () => {
  const msgs = [{ role: 'tool', tool_call_id: 'x', content: 'DATO_EN_DISCO' }];
  saveAgentTranscript(TESTID, msgs);
  eq(loadAgentTranscript(TESTID), msgs, 'el transcript no sobrevivio al disco.');
});

t('buildAgentMessages recupera de disco si la memoria esta vacia (app reiniciada)', () => {
  sandbox.state = {}; // simula un proceso recien arrancado
  const r = buildAgentMessages(TESTID, [], PRE);
  ok(JSON.stringify(r).indexOf('DATO_EN_DISCO') !== -1, 'no recupero el transcript del disco');
});

t('devuelve null para una conversacion inexistente', () => {
  eq(loadAgentTranscript('no-existe-' + Date.now()), null);
  eq(loadAgentTranscript(''), null);
});

t('el transcript NO se guarda entre las conversaciones', () => {
  ok(AGENT_DIR.indexOf('conversations') === -1,
     'AGENT_DIR esta dentro de conversations: listConversations() lo leeria como conversacion');
});

t('borrar deja el disco limpio', () => {
  deleteAgentTranscript(TESTID);
  eq(loadAgentTranscript(TESTID), null, 'quedo basura huerfana en disco');
});

console.log('\n=== ' + pass + ' pasaron, ' + fail + ' fallaron ===');
process.exit(fail ? 1 : 0);
