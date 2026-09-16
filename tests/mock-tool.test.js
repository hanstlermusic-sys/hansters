// Pruebas de la herramienta mock_api del agente.
//
// Lo importante aqui es que el agente pueda montar la API falsa cuando el
// usuario la pide en lenguaje natural ("dame un mock de pagos"), sin que nadie
// tenga que acordarse de puertos ni de curl. Si el esquema de la herramienta
// se rompe, el modelo deja de llamarla y la funcion queda muerta en silencio.
//
// Se extrae el catalogo REAL de server.js y se ejecuta en un sandbox, igual
// que las demas pruebas. No usa red.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SERVER = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');

const start = src.indexOf('const AGENT_TOOLS = [');
const end = src.indexOf('function resolveInCwd(p) {');
if (start < 0 || end < 0 || end <= start) {
  console.error('No se pudo extraer AGENT_TOOLS de server.js');
  process.exit(1);
}

const sandbox = { __out: null };
vm.runInNewContext(src.slice(start, end) + '\n__out = AGENT_TOOLS;', sandbox);
const TOOLS = sandbox.__out;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '  -> ' + e.message); }
}
function ok(c, m) { if (!c) throw new Error(m || 'condicion falsa'); }

const mock = TOOLS.map((x) => x.function).find((f) => f && f.name === 'mock_api');

console.log('\n--- la herramienta existe y esta bien formada ---');

t('mock_api esta en el catalogo del agente', () => {
  ok(mock, 'no aparece mock_api en AGENT_TOOLS');
});

t('tiene el envoltorio que esperan los modelos', () => {
  const envuelto = TOOLS.find((x) => x.function && x.function.name === 'mock_api');
  ok(envuelto.type === 'function', 'falta type: function');
  ok(envuelto.function.parameters.type === 'object', 'los parametros deben ser un objeto');
});

t('action es obligatoria: sin ella el modelo no sabria que hacer', () => {
  ok(mock.parameters.required.includes('action'), 'action deberia ser obligatoria');
});

t('cubre encender, apagar, fijar respuesta, consultar y limpiar', () => {
  const vals = mock.parameters.properties.action.enum;
  ['start', 'stop', 'status', 'seed', 'clear'].forEach((a) => {
    ok(vals.includes(a), 'falta la accion ' + a);
  });
});

t('seed puede recibir ruta y JSON exacto', () => {
  const p = mock.parameters.properties;
  ok(p.path && p.path.type === 'string', 'falta path');
  ok(p.data && p.data.type === 'string', 'falta data');
});

t('se pueden forzar escenario y codigo HTTP', () => {
  const p = mock.parameters.properties;
  ok(p.scenario && p.scenario.type === 'string', 'falta scenario');
  ok(p.status && p.status.type === 'number', 'status deberia ser numero');
});

console.log('\n--- la descripcion ensena al modelo cuando usarla ---');

t('menciona las frases con las que el usuario la pide', () => {
  const d = mock.description.toLowerCase();
  ok(d.includes('dame un mock'), 'deberia reconocer "dame un mock"');
  ok(d.includes('api falsa'), 'deberia hablar de API falsa');
});

t('deja claro que sirve para no depender de APIs reales', () => {
  const d = mock.description.toLowerCase();
  ok(d.includes('sin depender') || d.includes('sin apis'), 'no explica el para que');
  ok(d.includes('paypal'), 'conviene nombrar un caso real del usuario');
});

console.log('\n--- no rompe el resto del catalogo ---');

t('las herramientas de siempre siguen ahi', () => {
  const nombres = TOOLS.map((x) => x.function.name);
  ['read_file', 'write_file', 'run_command', 'open_repo', 'notify'].forEach((n) => {
    ok(nombres.includes(n), 'desaparecio la herramienta ' + n);
  });
});

t('ninguna herramienta esta repetida', () => {
  const nombres = TOOLS.map((x) => x.function.name);
  ok(new Set(nombres).size === nombres.length, 'hay herramientas duplicadas: ' + nombres.join(', '));
});

t('server.js engancha la herramienta al ejecutor', () => {
  ok(src.includes("if (name === 'mock_api')"), 'el ejecutor no atiende mock_api');
  ok(src.includes('function runMockTool('), 'falta la implementacion runMockTool');
});

console.log('\n' + pass + ' pruebas OK, ' + fail + ' fallidas');
process.exit(fail ? 1 : 0);
