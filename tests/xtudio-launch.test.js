// Pruebas del atajo que lanza Xtudio-1 sin pasar por el modelo.
// El bug: un prompt largo que solo mencionaba Xtudio se contestaba con
// "Xtudio-1 lanzado correctamente" en vez de responder lo que se pedia.
// Se extrae la funcion REAL de server.js y se corre en un sandbox, igual que
// las demas pruebas, para que no pueda quedar desincronizada. No usa red.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SERVER = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');

const start = src.indexOf('function isXtudioMentioned(text) {');
const end = src.indexOf('// Las rutas dependen de la maquina');
if (start < 0 || end < 0 || end <= start) {
  console.error('No se pudo extraer isXtudioLaunchIntent de server.js');
  process.exit(1);
}

const sandbox = { __out: null, String: String };
vm.runInNewContext(src.slice(start, end) + '\n__out = { isXtudioLaunchIntent, isXtudioMentioned };', sandbox);
const { isXtudioLaunchIntent, isXtudioMentioned } = sandbox.__out;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '  -> ' + e.message); }
}
function lanza(msg) {
  if (isXtudioLaunchIntent(msg, [], '')) return;
  throw new Error('deberia lanzar: ' + JSON.stringify(msg));
}
function noLanza(msg) {
  if (!isXtudioLaunchIntent(msg, [], '')) return;
  throw new Error('NO deberia lanzar: ' + JSON.stringify(msg));
}

console.log('\n--- isXtudioLaunchIntent ---');

t('ordenes cortas y directas si lanzan', () => {
  lanza('abre Xtudio-1');
  lanza('lanza xtudio');
  lanza('lanzala xtudio');
  lanza('inicia Xtudio-1');
  lanza('ejecuta xtudio-1');
  lanza('arranca DJ Set Studio');
  lanza('open xtudio');
  lanza('por favor abre Xtudio-1');
});

t('un prompt largo que solo menciona Xtudio no secuestra la respuesta', () => {
  noLanza('Cuando este desplegado xtudio avisadnos y quitamos el banner de mantenimiento de la pagina');
  noLanza('Necesito que revises el flujo de conexion de xtudio y me expliques por que inicia sesion dos veces');
  noLanza('En xtudio-1 el modulo de anuncios ejecuta la campana antes de validar la cuenta, hay que corregirlo');
});

t('preguntas sobre Xtudio no lanzan la app', () => {
  noLanza('¿como lanzo xtudio?');
  noLanza('que version de xtudio tengo instalada?');
});

t('otras tareas sobre Xtudio no lanzan la app', () => {
  noLanza('haz commit de xtudio');
  noLanza('compila xtudio-1');
  noLanza('arregla el error de xtudio');
  noLanza('actualiza el mirror de xtudio-1');
  noLanza('abre xtudio y despues revisa el registro de errores');
  noLanza('no abras xtudio');
});

t('mensajes con adjuntos o varias lineas no lanzan la app', () => {
  noLanza('abre xtudio @C:\\tmp\\captura.png');
  noLanza('abre xtudio\ny luego revisa el log');
});

t('sin mencionar Xtudio nunca lanza', () => {
  noLanza('abre el proyecto');
  noLanza('lanzala');
  noLanza('');
});

t('isXtudioMentioned reconoce los alias', () => {
  ['xtudio', 'Xtudio-1', 'xstudio', 'DJ Set Studio', 'main_qt.py'].forEach((s) => {
    if (!isXtudioMentioned(s)) throw new Error('no reconocio ' + s);
  });
  if (isXtudioMentioned('estudio de grabacion')) throw new Error('falso positivo con "estudio"');
});

console.log('\n' + pass + ' pruebas OK, ' + fail + ' fallidas');
process.exit(fail ? 1 : 0);
