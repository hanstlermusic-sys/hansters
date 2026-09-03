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
    { role: 'assistant', content: null, tool_calls: [{ id: 'a1', type: 'function', function: { name: 'run_command', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 'a1', content: 'ok' }
  ]);
  eq(r.contents[1], { role: 'model', parts: [{ functionCall: { name: 'run_command', args: { command: 'ls' } } }] });
});

// Esta es la regresion que costo un HTTP 400: Gemini 3.x firma cada part con un
// thoughtSignature opaco y EXIGE que se le devuelva tal cual.
t('reenvia las parts crudas del modelo, conservando thoughtSignature', () => {
  const crudas = [{ functionCall: { name: 'run_command', args: { command: 'ls' }, id: 'call_1' }, thoughtSignature: 'FIRMA' }];
  const r = toGeminiAgentContents([
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, _geminiParts: crudas, tool_calls: [{ id: 'call_1', _geminiId: 'call_1', type: 'function', function: { name: 'run_command', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' }
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
    { role: 'assistant', content: null, tool_calls: [{ id: 'a1', type: 'function', function: { name: 'f', arguments: '{no es json' } }] },
    { role: 'tool', tool_call_id: 'a1', content: 'ok' }
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

console.log('\n--- historial recortado (regresion 1.0.7) ---');

// Bug real visto en produccion: tras un job largo, trimAgentMessages recorta el
// transcript y puede dejarlo empezando por el assistant que pidio la
// herramienta. Al quitar ese turno 'model' para que el historial empiece por
// 'user', quedaba expuesto su functionResponse y Gemini respondia:
// "Please ensure that function response turn comes immediately after a
//  function call turn. Got function response with name 'read_file'."
// Envenenaba la conversacion: todos los turnos siguientes fallaban igual.
function historialRecortado() {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
      _geminiParts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } }, thoughtSignature: 'FIRMA' }]
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'contenido' },
    { role: 'assistant', content: 'Listo.' },
    { role: 'user', content: 'y ahora?' }
  ];
}

function primerasPartes(out) {
  return (out.contents[0] || { parts: [] }).parts;
}

t('un historial recortado no empieza por functionResponse', () => {
  const out = toGeminiAgentContents(historialRecortado());
  const huerfana = primerasPartes(out).find((p) => p && p.functionResponse);
  ok(!huerfana, 'el historial empieza con functionResponse(' +
    (huerfana && huerfana.functionResponse.name) + '), Gemini lo rechaza');
});

t('todo functionResponse va precedido de su functionCall', () => {
  const casos = [
    historialRecortado(),
    // Respuesta de herramienta sin ningun assistant previo.
    [{ role: 'tool', tool_call_id: 'x', content: 'huerfano' }, { role: 'user', content: 'hola' }],
    // El assistant previo no pidio herramientas.
    [{ role: 'assistant', content: 'texto' }, { role: 'tool', tool_call_id: 'y', content: 'r' }, { role: 'user', content: 'hola' }]
  ];
  casos.forEach((caso, n) => {
    const c = toGeminiAgentContents(caso).contents;
    for (let i = 0; i < c.length; i++) {
      const tieneResp = c[i].parts.some((p) => p && p.functionResponse);
      if (!tieneResp) continue;
      const prev = c[i - 1];
      ok(prev && prev.role === 'model' && prev.parts.some((p) => p && p.functionCall),
        'caso ' + n + ': el turno ' + i + ' responde a una llamada inexistente');
    }
  });
});

t('el historial siempre empieza por un turno user', () => {
  const out = toGeminiAgentContents(historialRecortado());
  if (out.contents.length) eq(out.contents[0].role, 'user', 'primer turno');
});

t('un historial que ya es valido no se toca', () => {
  const bueno = [
    { role: 'user', content: 'lee a.txt' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
      _geminiParts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } }, thoughtSignature: 'S' }]
    },
    { role: 'tool', tool_call_id: 'c1', content: 'hola' },
    { role: 'assistant', content: 'dice hola' }
  ];
  const c = toGeminiAgentContents(bueno).contents;
  eq(c.length, 4, 'no debe descartar turnos validos');
  ok(c[1].parts.some((p) => p.functionCall), 'se pierde el functionCall');
  ok(c[2].parts.some((p) => p.functionResponse), 'se pierde el functionResponse');
  // thoughtSignature debe viajar intacta o Gemini 3.x devuelve 400.
  ok(c[1].parts[0].thoughtSignature === 'S', 'se perdio la thoughtSignature');
});

t('el recorte no deja el historial vacio si hay turnos utiles', () => {
  const out = toGeminiAgentContents(historialRecortado());
  ok(out.contents.length > 0, 'se descarto todo el historial');
});
// ===== lo que Gemini rechaza de verdad (regresion 1.0.8) =====
// Verificado contra la API real (gemini-3.8-flash), no supuesto: de 10 formas de
// historial descuadrado, Gemini solo devuelve 400 en dos. Las demas las ACEPTA,
// asi que recortarlas seria tirar contexto util del agente.
const CALL_N = (n) => ({
  role: 'assistant', content: '',
  tool_calls: Array.from({ length: n }, (_, i) => ({ id: 'c' + i, function: { name: 'read_file', arguments: '{}' } })),
  _geminiParts: Array.from({ length: n }, (_, i) => ({ functionCall: { name: 'read_file', args: {} }, thoughtSignature: 'S' + i }))
});
const RESP_N = (i) => ({ role: 'tool', tool_call_id: 'c' + i, content: 'ok' });
const hayCall = (t) => t.parts.some((p) => p.functionCall);
const hayResp = (t) => t.parts.some((p) => p.functionResponse);

t('RECHAZADO por la API: el historial no puede terminar en functionCall sin responder', () => {
  const c = toGeminiAgentContents([{ role: 'user', content: 'haz algo' }, CALL_N(1)]).contents;
  ok(!c.length || !hayCall(c[c.length - 1]), 'quedo un functionCall colgando al final: HTTP 400');
});

t('RECHAZADO por la API: el historial no puede empezar por functionResponse', () => {
  const c = toGeminiAgentContents([CALL_N(1), RESP_N(0), { role: 'user', content: 'sigue' }]).contents;
  ok(!c.length || !hayResp(c[0]), 'empieza por functionResponse: HTTP 400');
});

t('ACEPTADO por la API: faltan respuestas, pero el contexto NO se tira', () => {
  const c = toGeminiAgentContents([
    { role: 'user', content: 'x' }, CALL_N(3), RESP_N(0), { role: 'user', content: 'y?' }
  ]).contents;
  ok(c.some(hayCall), 'se perdieron las llamadas: Gemini acepta este historial');
  ok(c.some(hayResp), 'se perdieron las respuestas ya obtenidas');
});

t('ACEPTADO por la API: sobran respuestas, pero el contexto NO se tira', () => {
  const c = toGeminiAgentContents([
    { role: 'user', content: 'x' }, CALL_N(1), RESP_N(0), RESP_N(1), { role: 'user', content: 'y?' }
  ]).contents;
  ok(c.some(hayCall) && c.some(hayResp), 'se tiro contexto que la API acepta');
});

t('un descuadre no se lleva por delante el resto del historial', () => {
  const c = toGeminiAgentContents([
    { role: 'user', content: 'primero' }, CALL_N(2), RESP_N(0), RESP_N(1),
    { role: 'assistant', content: 'listo' },
    { role: 'user', content: 'segundo' }, CALL_N(3), RESP_N(0),
    { role: 'user', content: 'tercero' }
  ]).contents;
  ok(c.length && c[0].role === 'user', 'el historial ya no empieza por user');
  ok(c.filter(hayResp).length >= 2, 'se perdieron tandas validas');
});

// El origen real del descuadre: herramientas cuyo callback se dispara dos veces.
// Un spawn fallido emite 'error' Y DESPUES 'close'; sin guardia, el bucle del
// agente baja "pending" de mas y cierra la tanda perdiendo resultados de otras
// herramientas que aun no habian terminado.
const srvSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');

t('toda herramienta con spawn protege su callback contra la doble llamada', () => {
  const inicio = srvSrc.indexOf('function execAgentTool(');
  const cuerpo = srvSrc.slice(inicio, srvSrc.indexOf('\nfunction ', inicio + 10));
  const sinGuardia = [];
  const re = /if \(name === '([a-z_]+)'\) \{([\s\S]*?)\n    \}/g;
  let m;
  while ((m = re.exec(cuerpo))) {
    if (m[2].indexOf('spawn(') === -1) continue;
    if (m[2].indexOf("child.on('error'") === -1) continue;
    if (m[2].indexOf('finished') === -1) sinGuardia.push(m[1]);
  }
  ok(!sinGuardia.length, 'sin guardia contra doble callback: ' + sinGuardia.join(', '));
});

t('el bucle del agente ignora la segunda respuesta y rellena los huecos', () => {
  const i = srvSrc.indexOf('const orderedToolResults = new Array(');
  const bloque = srvSrc.slice(i, i + 2000);
  ok(bloque.indexOf('yaRespondio') !== -1, 'no hay guardia de doble respuesta por herramienta');
  ok(bloque.indexOf('if (orderedToolResults[i]) messages.push') === -1,
    'sigue saltandose los huecos en vez de rellenarlos');
});
console.log('\n=== ' + pass + ' pasaron, ' + fail + ' fallaron ===\n');
process.exit(fail ? 1 : 0);
