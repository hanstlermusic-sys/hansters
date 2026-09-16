// Pruebas de lectura por trozos (read_file) y parcheo seguro (apply_patch).
//
// Por que importa: antes read_file recortaba a 20000 caracteres EN SILENCIO y
// apply_patch reemplazaba la PRIMERA aparicion aunque hubiera decenas iguales.
// En server.js el 8.3% de las lineas estan repetidas (una sola linea aparece
// 51 veces), asi que el agente podia editar la funcion equivocada y reportar
// exito. Estas pruebas fijan las dos cosas: que el recorte se avise y que un
// "find" ambiguo NO toque el archivo.
//
// Se extrae el codigo REAL de server.js y se corre en un sandbox, igual que
// las demas pruebas del repo. No usa red ni disco.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SERVER = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');

const INI = '// ===== Lectura por trozos y parcheo seguro =====';
const FIN = '// ===== fin lectura/parcheo =====';
const start = src.indexOf(INI);
const end = src.indexOf(FIN);
if (start < 0 || end < 0 || end <= start) {
  console.error('No se pudo extraer el bloque de lectura/parcheo de server.js');
  process.exit(1);
}

const sandbox = {};
vm.runInNewContext(
  src.slice(start, end) +
  '\n__api = { leerTrozo, aplicarParche, ubicarOcurrencias, READ_MAX_CHARS };',
  sandbox
);
const { leerTrozo, aplicarParche, ubicarOcurrencias, READ_MAX_CHARS } = sandbox.__api;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '  -> ' + e.message); }
}
function ok(c, m) { if (!c) throw new Error(m || 'condicion falsa'); }

// Archivo de juguete: 5000 lineas, muy por encima del tope.
const grande = Array.from({ length: 5000 }, (_, i) => 'linea ' + (i + 1) + ' de relleno para ocupar sitio').join('\n');
const chico = 'uno\ndos\ntres\ncuatro\ncinco';

console.log('\n--- read_file: compatibilidad hacia atras ---');

t('un archivo chico se devuelve entero y sin ruido', () => {
  const r = leerTrozo(chico, {});
  ok(r.texto === chico, 'cambio el contenido de un archivo que si cabia');
  ok(r.resumen === '5 lineas', 'resumen raro: ' + r.resumen);
});

t('sin offset/limit se comporta como antes (mismo recorte)', () => {
  const r = leerTrozo(grande, {});
  ok(r.texto.startsWith(grande.slice(0, READ_MAX_CHARS)), 'el trozo inicial ya no coincide con el de antes');
});

console.log('\n--- read_file: el recorte ahora se avisa ---');

t('avisa cuando recorta, con cuanto vio y cuanto falta', () => {
  const r = leerTrozo(grande, {});
  ok(/RECORTADO/.test(r.texto), 'no avisa del recorte en el cuerpo');
  ok(/de 5000 lineas/.test(r.texto), 'no dice el total real de lineas');
  ok(/RECORTADO/.test(r.resumen), 'el resumen no delata el recorte: ' + r.resumen);
});

t('dice exactamente por donde seguir leyendo', () => {
  const r = leerTrozo(grande, {});
  const m = r.texto.match(/offset=(\d+)/);
  ok(m, 'no sugiere un offset para continuar');
  const vistas = grande.slice(0, READ_MAX_CHARS).split('\n').length;
  ok(Number(m[1]) === vistas + 1, 'el offset sugerido se salta o repite lineas');
});

console.log('\n--- read_file: lectura por trozos ---');

t('offset y limit devuelven justo ese rango', () => {
  const r = leerTrozo(grande, { offset: 100, limit: 3 });
  ok(r.texto.includes('linea 100 '), 'no empieza donde se pidio');
  ok(r.texto.includes('linea 102 '), 'no llega al final del rango');
  ok(!r.texto.includes('linea 103 '), 'devuelve mas lineas de las pedidas');
  ok(r.resumen === 'lineas 100-102/5000', 'resumen raro: ' + r.resumen);
});

t('encadenando offsets se puede leer el archivo entero', () => {
  let visto = 0, off = 1, vueltas = 0;
  while (off <= 5000 && vueltas < 100) {
    const r = leerTrozo(grande, { offset: off, limit: 400 });
    const m = r.resumen.match(/lineas (\d+)-(\d+)\//);
    ok(m, 'resumen no parseable: ' + r.resumen);
    visto += Number(m[2]) - Number(m[1]) + 1;
    off = Number(m[2]) + 1;
    vueltas++;
  }
  ok(visto === 5000, 'leyendo por trozos se perdieron lineas: ' + visto);
});

t('al llegar al final lo dice, no deja al modelo pidiendo mas', () => {
  const r = leerTrozo(chico, { offset: 4, limit: 50 });
  ok(/fin del archivo/.test(r.texto), 'no marca el fin del archivo');
});

t('un offset imposible da error claro y no texto vacio', () => {
  const r = leerTrozo(chico, { offset: 999 });
  ok(/^Error:/.test(r.texto), 'no devuelve error: ' + r.texto);
  ok(/5/.test(r.texto), 'no dice cuantas lineas hay en realidad');
});

t('offset y limit basura no revientan', () => {
  const r = leerTrozo(chico, { offset: 'abc', limit: -7 });
  ok(typeof r.texto === 'string' && r.texto.length > 0, 'se cayo con argumentos invalidos');
});

console.log('\n--- apply_patch: lo que ya funcionaba sigue funcionando ---');

t('un find unico se reemplaza igual que antes', () => {
  const r = aplicarParche(chico, { find: 'tres', replace: 'TRES' });
  ok(r.ok, 'rechazo un reemplazo que si era unico: ' + r.texto);
  ok(r.contenido === 'uno\ndos\nTRES\ncuatro\ncinco', 'contenido mal: ' + r.contenido);
  ok(/linea ~3/.test(r.resumen), 'no reporta la linea: ' + r.resumen);
});

t('si no encuentra el texto avisa y no inventa', () => {
  const r = aplicarParche(chico, { find: 'no existe', replace: 'x' });
  ok(!r.ok, 'dijo que aplico un parche imposible');
  ok(r.resumen === 'no encontrado', 'resumen raro: ' + r.resumen);
});

t('un find vacio se rechaza', () => {
  const r = aplicarParche(chico, { find: '', replace: 'x' });
  ok(!r.ok, 'acepto un find vacio');
});

t('replace vacio sirve para borrar', () => {
  const r = aplicarParche('aaa\nBORRAME\nbbb', { find: 'BORRAME\n', replace: '' });
  ok(r.ok && r.contenido === 'aaa\nbbb', 'no borro limpio: ' + JSON.stringify(r.contenido));
});

console.log('\n--- apply_patch: el bug de corrupcion silenciosa ---');

const repetido = 'function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}\n';

t('un find ambiguo NO se aplica', () => {
  const r = aplicarParche(repetido, { find: '  return 1;', replace: '  return 2;' });
  ok(!r.ok, 'volvio a editar a ciegas la primera aparicion');
  ok(r.contenido === undefined, 'devolvio contenido modificado pese a ser ambiguo');
});

t('al rechazar, dice cuantas hay y en que lineas', () => {
  const r = aplicarParche(repetido, { find: '  return 1;', replace: '  return 2;' });
  ok(/aparece 2 veces/.test(r.texto), 'no dice cuantas coincidencias hay');
  ok(/linea 2/.test(r.texto) && /linea 5/.test(r.texto), 'no lista las lineas: ' + r.texto);
  ok(/ambiguo/.test(r.resumen), 'el resumen no delata la ambiguedad: ' + r.resumen);
});

t('el mensaje le explica al modelo como salir del paso', () => {
  const r = aplicarParche(repetido, { find: '  return 1;', replace: '  return 2;' });
  ok(/ocurrencia=N/.test(r.texto), 'no menciona ocurrencia=N');
  ok(/todas=true/.test(r.texto), 'no menciona todas=true');
  ok(/unico/.test(r.texto), 'no sugiere ampliar el contexto');
});

t('ampliar el contexto vuelve a hacerlo unico', () => {
  const r = aplicarParche(repetido, { find: 'function b() {\n  return 1;', replace: 'function b() {\n  return 2;' });
  ok(r.ok, 'sigue quejandose con un find ya unico: ' + r.texto);
  ok(r.contenido.includes('function a() {\n  return 1;'), 'toco la funcion equivocada');
  ok(r.contenido.includes('function b() {\n  return 2;'), 'no aplico el cambio pedido');
});

console.log('\n--- apply_patch: escoger explicitamente ---');

t('ocurrencia=2 edita la segunda, no la primera', () => {
  const r = aplicarParche(repetido, { find: '  return 1;', replace: '  return 2;', ocurrencia: 2 });
  ok(r.ok, 'rechazo una eleccion explicita: ' + r.texto);
  ok(r.contenido === 'function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n', 'edito la equivocada: ' + JSON.stringify(r.contenido));
});

t('ocurrencia=1 edita la primera (comportamiento viejo, ya explicito)', () => {
  const r = aplicarParche(repetido, { find: '  return 1;', replace: '  return 2;', ocurrencia: 1 });
  ok(r.ok && r.contenido.startsWith('function a() {\n  return 2;'), 'no edito la primera');
});

t('una ocurrencia que no existe se rechaza', () => {
  const r = aplicarParche(repetido, { find: '  return 1;', replace: 'x', ocurrencia: 9 });
  ok(!r.ok, 'acepto una ocurrencia inexistente');
  ok(/solo hay 2/.test(r.texto), 'no dice cuantas hay: ' + r.texto);
});

t('todas=true reemplaza todas y dice cuantas', () => {
  const r = aplicarParche(repetido, { find: '  return 1;', replace: '  return 2;', todas: true });
  ok(r.ok, 'no aplico el reemplazo masivo');
  ok(!r.contenido.includes('return 1;'), 'quedaron apariciones sin cambiar');
  ok(r.resumen === '2 reemplazos', 'no reporta el numero: ' + r.resumen);
});

t('todas=true no se come el texto de alrededor', () => {
  const r = aplicarParche('x-A-y-A-z', { find: 'A', replace: 'B', todas: true });
  ok(r.contenido === 'x-B-y-B-z', 'destrozo el contenido: ' + r.contenido);
});

console.log('\n--- contra el archivo real ---');

t('ubicarOcurrencias ve la ambiguedad real de server.js', () => {
  const linea = "res.writeHead(200, { 'Content-Type': 'application/json' });";
  const pos = ubicarOcurrencias(src, linea);
  ok(pos.length > 10, 'se esperaban muchas coincidencias, hubo ' + pos.length);
});

t('apply_patch se niega a editar server.js con un find repetido', () => {
  const linea = "res.writeHead(200, { 'Content-Type': 'application/json' });";
  const r = aplicarParche(src, { find: linea, replace: 'ROTO' });
  ok(!r.ok, 'habria corrompido server.js en silencio');
});

console.log('\n' + pass + ' pruebas OK, ' + fail + ' fallidas');
process.exit(fail ? 1 : 0);
