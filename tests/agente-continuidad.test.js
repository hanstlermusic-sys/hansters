// El agente se paraba a media tarea y habia que escribirle "sigue" en cada paso.
// La causa no estaba en el modelo ni en el CLI: el detector de anuncios de
// HanstlerS (el que empuja al agente a actuar cuando solo dice lo que hara)
// estaba escrito SIN acentos, y el modelo responde CON ellos.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(nombre, fn) {
  try { fn(); pass++; console.log('  ok   ' + nombre); }
  catch (e) { fail++; console.log('  FAIL ' + nombre + '\n       ' + e.message); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'esperaba true'); }

function cargarSoloAnuncia() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf('function sinAcentos(');
  const f = src.indexOf('function runAzureAgent(');
  if (i === -1 || f === -1) throw new Error('no encuentro soloAnuncia en server.js');
  const ctx = { module: {}, String: String, console: console, RegExp: RegExp };
  vm.runInNewContext(src.slice(i, f) + '\nmodule.exports = soloAnuncia;', ctx);
  return ctx.module.exports;
}
const soloAnuncia = cargarSoloAnuncia();

console.log('\n--- el agente no se para a media tarea ---');

// Estas son las frases que el modelo escribe de verdad, con sus acentos. Antes
// se colaban 12 de 15: el bucle las tomaba por respuesta final, cerraba el
// trabajo y el usuario tenia que teclear "sigue" para cada paso.
const ANUNCIOS_ACENTUADOS = [
  'Ahora procederé a corregir la iluminación.',
  'Revisaré el archivo HTML para ver el problema.',
  'Leeré el contenido de la función animate.',
  'Crearé el archivo de configuración.',
  'Escribiré los cambios en el archivo.',
  'Ejecutaré el comando para verificarlo.',
  'Buscaré la definición de esa función.',
  'Empezaré por revisar la estructura.',
  'Comenzaré con el análisis del código.',
  'Déjame revisar eso.',
  'Permíteme verificar el estado.',
  'Analizaré el problema antes de tocar nada.',
  'Verificaré que funcione.',
  'Corregiré el error.'
];

ANUNCIOS_ACENTUADOS.forEach((frase) => {
  t('detecta el anuncio acentuado: "' + frase.slice(0, 40) + '"', () => {
    ok(soloAnuncia(frase), 'se cuela -> el trabajo se cerraria aqui y habria que decirle "sigue"');
  });
});

t('la misma frase sin acentos tambien se detecta', () => {
  ok(soloAnuncia('Ahora procedere a corregir la iluminacion.'));
  ok(soloAnuncia('Revisare el archivo HTML.'));
});

t('un turno vacio cuenta como que no hizo nada', () => {
  ok(soloAnuncia(''));
  ok(soloAnuncia('   '));
  ok(soloAnuncia(null));
});

t('los anuncios en ingles siguen detectandose', () => {
  ok(soloAnuncia("Let me check the file."));
  ok(soloAnuncia("I'll review the configuration."));
  ok(soloAnuncia("Now I'll apply the change."));
});

console.log('\n--- pero una respuesta terminada no se empuja ---');

const RESPUESTAS_FINALES = [
  'Listo. Corregí la iluminación: subí fillLight a 0.8 y ajusté la cámara.',
  'Ya está todo funcionando correctamente.',
  'El problema era que la variable no estaba definida. Lo arreglé.',
  'Encontré 3 archivos con ese patrón: a.js, b.js y c.js.',
  'Terminé. La aplicación ya compila sin errores.',
  'No pude completar la tarea porque falta el token de acceso.',
  'La versión instalada es la 1.0.16 y responde correctamente.'
];

RESPUESTAS_FINALES.forEach((frase) => {
  t('no empuja una respuesta ya terminada: "' + frase.slice(0, 40) + '"', () => {
    ok(!soloAnuncia(frase), 'falso positivo -> el agente daria vueltas de mas');
  });
});

t('un turno que ya trae codigo es trabajo hecho, no un anuncio', () => {
  const conCodigo = 'Voy a dejarte la funcion corregida:\n\n```js\nconst x = 1;\n```';
  ok(!soloAnuncia(conCodigo), 'el turno trae el trabajo hecho aunque empiece con "voy a"');
});

console.log('\n--- margen suficiente para tareas largas ---');

t('el bucle admite varios empujones, no solo dos', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = src.match(/const MAX_NUDGES = (\d+);/);
  ok(m, 'no encuentro MAX_NUDGES');
  ok(Number(m[1]) >= 5, 'con solo ' + m[1] + ' empujones una tarea larga se queda a medias');
});

t('el bucle usa soloAnuncia, no el regex a pelo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(src.indexOf('nudges < MAX_NUDGES && soloAnuncia(text)') !== -1,
    'el bucle no pasa por la comparacion sin acentos');
});

console.log('\n=== ' + pass + ' pasaron, ' + fail + ' fallaron ===\n');
process.exit(fail ? 1 : 0);
