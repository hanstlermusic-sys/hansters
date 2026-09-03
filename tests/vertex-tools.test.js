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
    asisFirmado([{ id: 'a1', name: 'run_command', args: '{"command":"ls"}' }]),
    { role: 'tool', tool_call_id: 'a1', content: 'ok' }
  ]);
  eq(r.contents[1].parts[0].functionCall, { name: 'run_command', args: { command: 'ls' } });
  ok(r.contents[1].parts[0].thoughtSignature === 'FIRMA_a1', 'se perdio la firma');
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

// Tal y como Vertex guarda un turno con herramientas: parts crudas CON firma.
// Sin firma, Gemini devuelve 400 en cuanto el historial termina en la respuesta
// de la herramienta, asi que ese caso se degrada a texto (ver mas abajo).
function asisFirmado(llamadas) {
  return {
    role: 'assistant', content: null,
    tool_calls: llamadas.map((l) => ({ id: l.id, _geminiId: l.gid || null, type: 'function', function: { name: l.name, arguments: l.args || '{}' } })),
    _geminiParts: llamadas.map((l) => ({ functionCall: Object.assign({ name: l.name, args: JSON.parse(l.args || '{}') }, l.gid ? { id: l.gid } : {}), thoughtSignature: 'FIRMA_' + l.id }))
  };
}

t('el resultado de la herramienta vuelve como functionResponse con su nombre', () => {
  const r = toGeminiAgentContents([
    { role: 'user', content: 'x' },
    asisFirmado([{ id: 'a1', name: 'read_file' }]),
    { role: 'tool', tool_call_id: 'a1', content: 'contenido' }
  ]);
  eq(r.contents[2], { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'contenido' } } }] });
});

t('devuelve el id que asigno el modelo cuando existe', () => {
  const r = toGeminiAgentContents([
    { role: 'user', content: 'x' },
    asisFirmado([{ id: 'call_9', gid: 'call_9', name: 'read_file' }]),
    { role: 'tool', tool_call_id: 'call_9', content: 'ok' }
  ]);
  eq(r.contents[2].parts[0].functionResponse.id, 'call_9');
});

// Gemini exige que el numero de functionResponse case con el de functionCall del
// turno anterior: si no se agrupan, las llamadas en paralelo dan 400.
t('agrupa los resultados en paralelo en UN solo turno', () => {
  const r = toGeminiAgentContents([
    { role: 'user', content: 'x' },
    asisFirmado([{ id: 'a1', name: 'read_file' }, { id: 'a2', name: 'list_dir' }]),
    { role: 'tool', tool_call_id: 'a1', content: 'uno' },
    { role: 'tool', tool_call_id: 'a2', content: 'dos' }
  ]);
  eq(r.contents.length, 3, 'deberian ser user, model y un unico user de resultados:');
  eq(r.contents[1].parts.length, 2, 'functionCall:');
  eq(r.contents[2].parts.length, 2, 'functionResponse:');
});

// Verificado contra la API real: Gemini ACEPTA (200) un historial que empieza
// por 'model'. Descartar ese turno tiraba contexto util -en un historial ya
// recortado, justo lo que el agente acababa de leer- sin ganar nada.
t('un turno de model al principio se conserva: la API lo acepta', () => {
  const r = toGeminiAgentContents([
    { role: 'assistant', content: 'te ayudo' },
    { role: 'user', content: 'hola' }
  ]);
  eq(r.contents, [
    { role: 'model', parts: [{ text: 'te ayudo' }] },
    { role: 'user', parts: [{ text: 'hola' }] }
  ]);
});

t('lo que si se descarta es un functionResponse al principio', () => {
  const r = toGeminiAgentContents([
    { role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'x', content: 'algo' },
    { role: 'user', content: 'sigue' }
  ]);
  ok(!r.contents.length || !r.contents[0].parts.some((p) => p.functionResponse),
    'empieza por functionResponse: HTTP 400');
});

t('tolera argumentos JSON corruptos sin reventar', () => {
  const r = toGeminiAgentContents([
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, _geminiParts: [{ functionCall: { name: 'f', args: {} }, thoughtSignature: 'F' }], tool_calls: [{ id: 'a1', type: 'function', function: { name: 'f', arguments: '{no es json' } }] },
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

t('el historial nunca empieza por un functionResponse huerfano', () => {
  const out = toGeminiAgentContents(historialRecortado());
  if (!out.contents.length) return;
  ok(!out.contents[0].parts.some((p) => p.functionResponse),
    'empieza por una respuesta de herramienta sin su llamada: HTTP 400');
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
// ===== historial sin thoughtSignature (regresion 1.0.9) =====
// Medido contra la API real: si un functionCall no lleva su thoughtSignature y
// el historial TERMINA en la respuesta de la herramienta -que es justo como
// queda el bucle del agente tras ejecutar algo- Gemini devuelve 400
// ("Function call is missing a thought_signature") y la conversacion queda
// muerta. Pasa con conversaciones que venian de Copilot/Azure. Se degradan a
// texto plano: se pierde la estructura, se conserva el contenido.
const sinFirma = [
  { role: 'user', content: 'lee el archivo' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'a1', type: 'function', function: { name: 'read_file', arguments: '{"path":"s.txt"}' } }] },
  { role: 'tool', tool_call_id: 'a1', content: 'la clave es ZORRO7' }
];

t('sin thoughtSignature no se emite ningun functionCall', () => {
  const c = toGeminiAgentContents(sinFirma).contents;
  const crudo = JSON.stringify(c);
  ok(crudo.indexOf('functionCall') === -1, 'se emitio un functionCall sin firma: HTTP 400');
  ok(crudo.indexOf('functionResponse') === -1, 'quedo un functionResponse suelto');
});

t('al degradar NO se pierde lo que devolvio la herramienta', () => {
  const crudo = JSON.stringify(toGeminiAgentContents(sinFirma).contents);
  ok(crudo.indexOf('ZORRO7') !== -1, 'se perdio el resultado de la herramienta');
  ok(crudo.indexOf('read_file') !== -1, 'se perdio el nombre de la herramienta');
});

t('con thoughtSignature SI se conserva la estructura de la llamada', () => {
  const c = toGeminiAgentContents([
    { role: 'user', content: 'lee' },
    asisFirmado([{ id: 'a1', name: 'read_file' }]),
    { role: 'tool', tool_call_id: 'a1', content: 'ok' }
  ]).contents;
  ok(c.some((x) => x.parts.some((q) => q.functionCall)), 'se degrado un historial que SI tenia firma');
  ok(JSON.stringify(c).indexOf('FIRMA_a1') !== -1, 'se perdio la firma');
});

t('un historial mixto degrada solo el tramo sin firma', () => {
  const c = toGeminiAgentContents([
    { role: 'user', content: 'uno' },
    asisFirmado([{ id: 'f1', name: 'read_file' }]),
    { role: 'tool', tool_call_id: 'f1', content: 'CON_FIRMA' },
    { role: 'user', content: 'dos' },
    { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 's1', content: 'SIN_FIRMA' }
  ]).contents;
  const crudo = JSON.stringify(c);
  ok(crudo.indexOf('FIRMA_f1') !== -1, 'se degrado el tramo que si tenia firma');
  ok(crudo.indexOf('CON_FIRMA') !== -1 && crudo.indexOf('SIN_FIRMA') !== -1, 'se perdio contenido');
  const calls = c.filter((x) => x.parts.some((q) => q.functionCall));
  eq(calls.length, 1, 'solo debe quedar la llamada firmada:');
});

// Red de seguridad en runtime: los 400 que NO se arreglan reintentando igual.
const detectar = (function () {
  const i = srvSrc.indexOf('function geminiErrorDeHistorial(');
  const j = srvSrc.indexOf('\n}', i);
  const sandbox = { JSON: JSON, String: String };
  require('vm').createContext(sandbox);
  require('vm').runInContext(srvSrc.slice(i, j + 2) + '\nthis.f = geminiErrorDeHistorial;', sandbox);
  return sandbox.f;
})();

t('detecta los 400 de estructura que dejan la conversacion muerta', () => {
  const casos = [
    'Function call is missing a thought_signature in functionCall parts.',
    "Please ensure that function response turn comes immediately after a function call turn. Got function response with name 'read_file'.",
    'Please ensure that function call turn comes immediately after a user turn or after a function response turn.'
  ];
  casos.forEach((m) => {
    ok(detectar(JSON.stringify({ error: { message: m } })), 'no detectado: ' + m.slice(0, 45));
  });
});

t('no confunde un 400 normal con uno de estructura', () => {
  ok(!detectar(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } })), 'falso positivo con la api key');
  ok(!detectar(JSON.stringify({ error: { message: 'Quota exceeded for model' } })), 'falso positivo con la cuota');
  ok(!detectar('respuesta que no es json'), 'falso positivo con basura');
});

t('el reintento degradado esta cableado en la llamada a Gemini', () => {
  ok(srvSrc.indexOf('intentoSinHerramientas') !== -1, 'no existe la bandera del reintento');
  ok(srvSrc.indexOf('payloadDegradado()') !== -1, 'el reintento no usa el payload degradado');
  ok(/geminiErrorDeHistorial\(raw\)/.test(srvSrc), 'el 400 de estructura no dispara el reintento');
});

console.log('\n--- regresion 1.0.13: el historial degradado no se puede imitar ---');

// Medido contra la API real: cuando el tramo degradado se redactaba en primera
// persona ("Llamé a la herramienta X con {...}"), el modelo acababa imitando el
// patron y ESCRIBIA la llamada como texto en vez de emitirla, con lo que el
// agente se detenia a mitad de tarea. 4 de 34 muestras narraron con el formato
// viejo; 0 de 34 con el nuevo, conservando igual el contenido.
t('el tramo degradado no se redacta en primera persona', () => {
  const sinFirma = [
    { role: 'user', content: 'revisa el archivo' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'a1', function: { name: 'run_command', arguments: '{"command":"type x.html"}' } } ] },
    { role: 'tool', tool_call_id: 'a1', content: '125: <div class=fillLight>' }
  ];
  const r = toGeminiAgentContents(sinFirma);
  const todo = JSON.stringify(r.contents);
  ok(!/Llam[\u00e9e] a la herramienta/.test(todo),
    'sigue en primera persona: el modelo imitara el patron y narrara la llamada');
  ok(!/"Resultado de run_command/.test(todo),
    'el resultado sigue redactado como si lo dijera el asistente');
  ok(/registro de la sesion/.test(todo), 'no se marca como acta de la sesion');
});

t('pero el contenido del tramo degradado se conserva', () => {
  const sinFirma = [
    { role: 'user', content: 'busca el token' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'a1', function: { name: 'run_command', arguments: '{"command":"type secreto.txt"}' } } ] },
    { role: 'tool', tool_call_id: 'a1', content: 'el token es HANSTLER42' }
  ];
  const todo = JSON.stringify(toGeminiAgentContents(sinFirma).contents);
  ok(/run_command/.test(todo), 'se pierde el nombre de la herramienta');
  ok(/secreto\.txt/.test(todo), 'se pierden los argumentos');
  ok(/HANSTLER42/.test(todo), 'se pierde la salida: la degradacion no sirve de nada');
});

t('la red de seguridad usa la misma redaccion', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf('const payloadDegradado');
  ok(i !== -1, 'no encuentro payloadDegradado');
  const bloque = src.slice(i, i + 1400);
  ok(!/Llam[\u00e9e] a la herramienta/.test(bloque),
    'el reintento degradado sigue en primera persona');
  ok(/registro de la sesion/.test(bloque), 'el reintento no marca el texto como registro');
});

console.log('\n--- el ruido interno nunca llega a la pantalla ---');

// El historial sin thoughtSignature se degrada a un texto con formato interno
// ("[registro de la sesion] ..."). Con conversaciones largas el modelo acaba
// copiando ese formato y lo escribe como respuesta: en pantalla parecia que
// HanstlerS narraba lo que iba a hacer en vez de hacerlo. Cambiar la redaccion
// reduce la imitacion pero no la garantiza, asi que ademas se recorta siempre.
(function () {
  const vm2 = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf('const REGISTRO_INTERNO_RE');
  const f = src.indexOf('function geminiChatWithTools(');
  if (i === -1 || f === -1) throw new Error('no encuentro limpiarRegistroInterno en server.js');
  const ctx = { module: {}, String: String, console: console, RegExp: RegExp };
  vm2.runInNewContext(src.slice(i, f) + '\nmodule.exports = limpiarRegistroInterno;', ctx);
  const limpiar = ctx.module.exports;

  t('se recorta el registro que el modelo copio (formato actual)', () => {
    const capturado = '[registro de la sesion] Se ejecuto la herramienta run_command con los argumentos {"command":"dir"}';
    eq(limpiar(capturado), '', 'ese texto acabaria en pantalla');
  });

  t('y tambien el formato viejo, por si viene de un transcript antiguo', () => {
    eq(limpiar('Llamé a la herramienta run_command con {"command":"dir"}.'), '');
  });

  t('de una respuesta mixta solo se quita el registro', () => {
    const r = limpiar('Ya revise el archivo.\n\n' +
      '[registro de la sesion] Se ejecuto la herramienta run_command con los argumentos {"command":"dir"}\n' +
      '[registro de la sesion] Salida de run_command:\nlinea uno\nlinea dos\n\n' +
      'Subo fillLight a 0.8.');
    ok(r.indexOf('registro de la sesion') === -1, 'queda ruido interno');
    ok(r.indexOf('linea uno') === -1, 'queda la salida cruda de la herramienta');
    ok(r.indexOf('Ya revise el archivo.') !== -1, 'se perdio texto real del asistente');
    ok(r.indexOf('Subo fillLight a 0.8.') !== -1, 'se perdio la conclusion');
  });

  t('una respuesta normal no se toca', () => {
    const normal = 'Listo. Corregi la iluminacion: subi fillLight a 0.8 y ajuste la camara.';
    eq(limpiar(normal), normal);
    const conCodigo = 'Te explico:\n\n\u0060\u0060\u0060js\nconst x = 1;\n\u0060\u0060\u0060\n\nEso es todo.';
    eq(limpiar(conCodigo), conCodigo, 'un bloque de codigo no debe mutilarse');
  });

  t('mencionar una herramienta en una frase no cuenta como registro', () => {
    const frase = 'No te preocupes, el resultado de run_command fue correcto.';
    eq(limpiar(frase), frase, 'se recorta texto legitimo del asistente');
  });

  t('el filtro se aplica antes de enviar el texto a la interfaz', () => {
    const src2 = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const i2 = src2.indexOf('if (texto && onChunk) onChunk(texto);');
    ok(i2 !== -1, 'no encuentro el envio del texto a la UI');
    ok(src2.slice(i2 - 200, i2).indexOf('limpiarRegistroInterno') !== -1,
      'el texto se manda a la pantalla sin limpiar');
  });
})();

console.log('\n=== ' + pass + ' pasaron, ' + fail + ' fallaron ===\n');
process.exit(fail ? 1 : 0);
