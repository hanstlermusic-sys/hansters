// Pruebas del saneado de modelos Vertex y de los mensajes de error.
// Extrae las funciones REALES de server.js en un sandbox, para que no puedan
// quedar desincronizadas. No usa red.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SERVER = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');

function extraer(desde, hasta, nombre) {
  const a = src.indexOf(desde);
  const b = src.indexOf(hasta);
  if (a < 0 || b < 0 || b <= a) {
    console.error('No se pudo extraer ' + nombre + ' de server.js');
    process.exit(1);
  }
  return src.slice(a, b);
}

const bloqueModelos = extraer(
  '// Modelos por defecto.',
  'function loadVertex() {',
  'normalizeVertexModel');

const bloqueError = extraer(
  'function summarizeVertexError(',
  'const GEMINI_NO_CONTENT_RETRY_REASONS',
  'summarizeVertexError');

// summarizeVertexError consulta loadVertex() para saber el modo de auth;
// lo sustituimos por un doble controlable.
let modoAuth = 'api-key';
const sandbox = {
  __out: null,
  String, Number, Set, JSON,
  loadVertex: () => ({ authMode: modoAuth })
};
vm.runInNewContext(
  bloqueModelos + '\n' + bloqueError +
  '\n__out = { normalizeVertexModel, summarizeVertexError, VERTEX_DEFAULT_PRO, VERTEX_DEFAULT_FLASH, GEMINI_RETIRADOS };',
  sandbox);
const { normalizeVertexModel, summarizeVertexError, VERTEX_DEFAULT_PRO, VERTEX_DEFAULT_FLASH } = sandbox.__out;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '  -> ' + e.message); }
}
function eq(a, b, m) {
  if (a !== b) throw new Error((m || '') + ' esperado ' + JSON.stringify(b) + ' pero fue ' + JSON.stringify(a));
}
function inc(txt, frag, m) {
  if (String(txt).toLowerCase().indexOf(String(frag).toLowerCase()) < 0) {
    throw new Error((m || '') + ' esperaba que contuviera "' + frag + '" pero fue: ' + txt);
  }
}
function noInc(txt, frag, m) {
  if (String(txt).toLowerCase().indexOf(String(frag).toLowerCase()) >= 0) {
    throw new Error((m || '') + ' NO debia contener "' + frag + '" pero fue: ' + txt);
  }
}

console.log('\n--- normalizeVertexModel ---');

t('el modelo pro por defecto es el rapido verificado', () => {
  eq(VERTEX_DEFAULT_PRO, 'gemini-3.8-flash', 'default pro:');
  eq(normalizeVertexModel('pro', ''), 'gemini-3.8-flash');
});

t('sin valor devuelve el default de cada tipo', () => {
  eq(normalizeVertexModel('flash', ''), VERTEX_DEFAULT_FLASH);
  eq(normalizeVertexModel('opus', ''), 'claude-opus-5');
});

t('reemplaza modelos retirados que aun aparecen listados', () => {
  // Google deja los 2.5 en /v1beta/models pero responden 404.
  eq(normalizeVertexModel('pro', 'gemini-2.5-pro'), VERTEX_DEFAULT_PRO);
  eq(normalizeVertexModel('flash', 'gemini-2.5-flash'), VERTEX_DEFAULT_FLASH);
  eq(normalizeVertexModel('pro', 'gemini-1.5-pro'), VERTEX_DEFAULT_PRO);
  eq(normalizeVertexModel('flash', 'gemini-2.0-flash'), VERTEX_DEFAULT_FLASH);
});

t('no distingue mayusculas al detectar retirados', () => {
  eq(normalizeVertexModel('pro', 'Gemini-2.5-Pro'), VERTEX_DEFAULT_PRO);
});

t('respeta un modelo valido elegido a mano', () => {
  eq(normalizeVertexModel('pro', 'gemini-3.7-flash'), 'gemini-3.7-flash');
  eq(normalizeVertexModel('flash', 'gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite');
});

t('actualiza claude-opus-4 a la version vigente', () => {
  eq(normalizeVertexModel('opus', 'claude-opus-4'), 'claude-opus-5');
});

console.log('\n--- summarizeVertexError ---');

t('con API key, un 401 NO manda a configurar gcloud', () => {
  modoAuth = 'api-key';
  const m = summarizeVertexError(401, JSON.stringify({
    error: { message: 'Request had invalid authentication credentials. Expected OAuth 2 access token.' }
  }));
  inc(m, 'api key', 'debe hablar de la API key:');
  noInc(m, 'gcloud', 'no debe mandar a gcloud a quien usa API key:');
});

t('con ADC, un 401 SI manda a autenticar con gcloud', () => {
  modoAuth = 'adc';
  const m = summarizeVertexError(401, JSON.stringify({ error: { message: 'login required' } }));
  inc(m, 'gcloud', 'en modo ADC la solucion es gcloud:');
});

t('un 404 explica que el modelo fue retirado y cual usar', () => {
  modoAuth = 'api-key';
  const m = summarizeVertexError(404, JSON.stringify({
    error: { message: 'models/gemini-2.5-pro is not found for API version v1beta' }
  }), 'gemini-2.5-pro');
  inc(m, 'gemini-2.5-pro', 'debe nombrar el modelo que fallo:');
  inc(m, 'retirado', 'debe explicar que fue retirado:');
  inc(m, VERTEX_DEFAULT_PRO, 'debe sugerir un modelo que si funciona:');
});

t('un 429 se reporta como cuota agotada', () => {
  const m = summarizeVertexError(429, JSON.stringify({ error: { message: 'Quota exceeded' } }));
  inc(m, 'cuota', 'debe hablar de cuota:');
});

t('un 400 muestra el motivo real de la API', () => {
  const m = summarizeVertexError(400, JSON.stringify({
    error: { message: 'Unable to submit request because it has a functionResponse part but no functionCall.' }
  }));
  inc(m, 'functionresponse', 'debe incluir el detalle del rechazo:');
});

t('un 403 de billing y uno de permisos se distinguen', () => {
  const a = summarizeVertexError(403, JSON.stringify({ error: { message: 'billing is not enabled' } }));
  const b = summarizeVertexError(403, JSON.stringify({ error: { message: 'permission denied on resource' } }));
  inc(a, 'billing', 'caso billing:');
  inc(b, 'iam', 'caso permisos:');
});

t('sin cuerpo util sigue devolviendo algo accionable', () => {
  const m = summarizeVertexError(500, 'boom');
  inc(m, '500', 'debe incluir el codigo:');
});

console.log('\n--- coherencia con el resto del codigo ---');

t('ya no quedan modelos por defecto hardcodeados en la config de Vertex', () => {
  // Solo las zonas que fijan defaults: loadVertex y la ruta /api/vertex/config.
  // La lista del selector de /api/models sí nombra modelos a proposito.
  const zonas = [
    src.slice(src.indexOf('function loadVertex() {'), src.indexOf('function summarizeVertexError(')),
    (function () {
      const a = src.indexOf("req.url === '/api/vertex/config'");
      return a > 0 ? src.slice(a, a + 2000) : '';
    })()
  ];
  zonas.forEach((z, i) => {
    const sueltos = z.match(/'gemini-[\d.]+[\w.-]*'/g) || [];
    if (sueltos.length) {
      throw new Error('zona ' + i + ' aun fija modelos a mano: ' + sueltos.join(', ') +
        ' (deben salir de VERTEX_DEFAULT_*)');
    }
  });
});

t('el modelo pro configurado en disco es usable', () => {
  const home = require('os').homedir();
  const f = path.join(home, '.hanstlers', 'vertex.json');
  if (!fs.existsSync(f)) { console.log('        (sin vertex.json local, se omite)'); return; }
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  const pro = String(cfg.modelPro || '').toLowerCase();
  if (pro && sandbox.__out.GEMINI_RETIRADOS.has(pro)) {
    throw new Error('vertex.json apunta a un modelo retirado: ' + pro);
  }
});

console.log('\n=== ' + pass + ' pasaron, ' + fail + ' fallaron ===\n');
process.exit(fail ? 1 : 0);
