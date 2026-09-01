// Pruebas del cerebro Gemini (function calling) de la ruta Vertex.
// Mismo enfoque que context.test.js: se extraen las funciones REALES de
// server.js y se ejecutan en un sandbox, para que la prueba no pueda quedarse
// desincronizada de la implementacion. No requieren red ni credenciales.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SERVER = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');

const start = src.indexOf('// ===== Cerebro Gemini: function calling para el bucle de agente =====');
const end = src.indexOf('// Confirmaciones pendientes de comandos peligrosos:');
if (start < 0 || end < 0 || end <= start) {
  console.error('No se pudo extraer el bloque del cerebro Gemini de server.js');
  process.exit(1);
}

const sandbox = { __out: null, console: console, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number, Date: Date, Math: Math };
vm.runInNewContext(
  src.slice(start, end) +
  '\n__out = { geminiFunctionDeclarations, geminiPartsFromContent, toGeminiAgentContents, sinCamposInternos };',
  sandbox
);
const { geminiFunctionDeclarations, geminiPartsFromContent, toGeminiAgentContents, sinCamposInternos } = sandbox.__out;

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

console.log('\n--- geminiFunctionDeclarations ---');

t('quita el envoltorio {type,function} de las herramientas OpenAI', () => {
  const decls = geminiFunctionDeclarations([
    { type: 'function', function: { name: 'read_file', description: 'lee', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }
  ]);
  eq(decls, [{ name: 'read_file', description: 'lee', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]);
});

t('omite parameters cuando no hay propiedades (Gemini lo rechaza)', () => {
  const decls = geminiFunctionDeclarations([
    { type: 'function', function: { name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } } }
  ]);
  eq(decls, [{ name: 'ping', description: 'p' }]);
});

t('tolera lista vacia o entradas invalidas', () => {
  eq(geminiFunctionDeclarations([]), []);
  eq(geminiFunctionDeclarations(null), []);
  eq(geminiFunctionDeclarations([null, {}, { function: {} }]), []);
});

console.log('\n--- geminiPartsFromContent ---');

t('texto suelto', () => {
  eq(geminiPartsFromContent('hola'), [{ text: 'hola' }]);
  eq(geminiPartsFromContent(''), []);
  eq(geminiPartsFromContent(null), []);
});

t('convierte imagenes data-url a inline_data', () => {
  const parts = geminiPartsFromContent([
    { type: 'text', text: 'mira' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }
  ]);
  eq(parts, [{ text: 'mira' }, { inline_data: { mime_type: 'image/png', data: 'QUJD' } }]);
});

t('ignora urls de imagen que no sean data-url', () => {
  eq(geminiPartsFromContent([{ type: 'image_url', image_url: { url: 'https://x/y.png' } }]), []);
});

console.log('\n--- toGeminiAgentContents ---');

t('los system van a systemInstruction, no a contents', () => {
  const r = toGeminiAgentContents([
    { role: 'system', content: 'A' },
    { role: 'system', content: 'B' },
    { role: 'user', content: 'hola' }
  ]);
  eq(r.systemInstruction, { parts: [{ text: 'A\n\nB' }] });
  eq(r.contents, [{ role: 'user', parts: [{ text: 'hola' }] }]);
});

t('assistant con tool_calls -> turno model con functionCall', () => {
  const r = toGeminiAgentContents([
    { role: 'user', content: 'suma' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a1', type: 'function', function: { name: 'run_command', arguments: '{"command":"ls"}' } }] }
  ]);
  eq(r.contents[1], { role: 'model', parts: [{ functionCall: { name: 'run_command', args: { command: 'ls' } } }] });
});

// Esta es la regresion que costo un HTTP 400: Gemini 3.x firma cada part con un
// thoughtSignature opaco y EXIGE que se le devuelva tal cual.
t('reenvia las parts crudas del modelo, conservando thoughtSignature', () => {
  const crudas = [{ functionCall: { name: 'run_command', args: { command: 'ls' }, id: 'call_1' }, thoughtSignature: 'FIRMA' }];
  const r = toGeminiAgentContents([
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, _geminiParts: crudas, tool_calls: [{ id: 'call_1', _geminiId: 'call_1', type: 'function', function: { name: 'run_command', arguments: '{}' } }] }
  ]);
  eq(r.contents[1], { role: 'model', parts: crudas });
  ok(JSON.stringify(r.contents).indexOf('FIRMA') !== -1, 'se perdio el thoughtSignature');
});

t('el resultado de la herramienta vuelve como functionResponse con su nombre', () => {
  const r = toGeminiAgentContents([
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a1', content: 'contenido' }
  ]);
  eq(r.contents[2], { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'contenido' } } }] });
});

t('devuelve el id que asigno el modelo cuando existe', () => {
  const r = toGeminiAgentContents([
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', _geminiId: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_9', content: 'ok' }
  ]);
  eq(r.contents[2].parts[0].functionResponse.id, 'call_9');
});

// Gemini exige que el numero de functionResponse case con el de functionCall del
// turno anterior: si no se agrupan, las llamadas en paralelo dan 400.
t('agrupa los resultados en paralelo en UN solo turno', () => {
  const r = toGeminiAgentContents([
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'a1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      { id: 'a2', type: 'function', function: { name: 'list_dir', arguments: '{}' } }
    ] },
    { role: 'tool', tool_call_id: 'a1', content: 'uno' },
    { role: 'tool', tool_call_id: 'a2', content: 'dos' }
  ]);
  eq(r.contents.length, 3, 'deberian ser user, model y un unico user de resultados:');
  eq(r.contents[1].parts.length, 2, 'functionCall:');
  eq(r.contents[2].parts.length, 2, 'functionResponse:');
});

t('el historial nunca empieza por un turno de model', () => {
  const r = toGeminiAgentContents([
    { role: 'assistant', content: 'te ayudo' },
    { role: 'user', content: 'hola' }
  ]);
  eq(r.contents, [{ role: 'user', parts: [{ text: 'hola' }] }]);
});

t('tolera argumentos JSON corruptos sin reventar', () => {
  const r = toGeminiAgentContents([
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a1', type: 'function', function: { name: 'f', arguments: '{no es json' } }] }
  ]);
  eq(r.contents[1].parts[0].functionCall.args, {});
});

t('sin mensajes de system no se manda systemInstruction', () => {
  eq(toGeminiAgentContents([{ role: 'user', content: 'x' }]).systemInstruction, null);
});

console.log('\n--- sinCamposInternos (aislamiento entre proveedores) ---');

t('quita _geminiParts y _geminiId antes de hablar con Azure', () => {
  const limpio = sinCamposInternos([
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, _geminiParts: [{ functionCall: {} }], tool_calls: [{ id: 'a1', _geminiId: 'a1', type: 'function', function: { name: 'f', arguments: '{}' } }] }
  ]);
  ok(limpio[1]._geminiParts === undefined, 'quedo _geminiParts');
  ok(limpio[1].tool_calls[0]._geminiId === undefined, 'quedo _geminiId');
  eq(limpio[1].tool_calls[0].function, { name: 'f', arguments: '{}' });
});

t('NO muta los mensajes originales', () => {
  const original = { role: 'assistant', content: null, _geminiParts: [{ a: 1 }], tool_calls: [{ id: 'a1', _geminiId: 'a1' }] };
  sinCamposInternos([original]);
  ok(original._geminiParts !== undefined, 'se muto el original');
  ok(original.tool_calls[0]._geminiId === 'a1', 'se muto el tool_call original');
});

t('deja intactos los mensajes que no vienen de Gemini', () => {
  const msgs = [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }];
  ok(sinCamposInternos(msgs)[0] === msgs[0], 'copio de mas');
});

console.log('\n=== ' + pass + ' pasaron, ' + fail + ' fallaron ===\n');
process.exit(fail ? 1 : 0);
