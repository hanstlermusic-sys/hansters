// Pruebas de la revision automatica al escribir (guardian dentro del bucle).
//
// El agente escribia un archivo y seguia sin mirarlo: una clave pegada o un
// parentesis sin cerrar solo se descubrian mucho despues. Ahora, tras un
// write_file/apply_patch correcto, se revisa ese archivo y el hallazgo vuelve
// DENTRO del resultado de la herramienta, que es lo unico que el modelo relee.
//
// Lo que se fija aqui:
//   - si no hay nada que decir, no se anade NI UN TOKEN al resultado;
//   - si lo hay, el aviso es accionable (archivo, linea, que hacer);
//   - la revision jamas tumba una accion que ya salio bien.
//
// Se extrae el codigo REAL de server.js y se corre en un sandbox, igual que
// las demas pruebas del repo. No usa red.
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const SERVER = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');
const guardian = require('../guardian');

const INI = '// ===== Revision al escribir (guardian en el bucle del agente) =====';
const FIN = '// ===== fin revision al escribir =====';
const start = src.indexOf(INI);
const end = src.indexOf(FIN);
if (start < 0 || end < 0 || end <= start) {
  console.error('No se pudo extraer el bloque de revision al escribir de server.js');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-'));
const features = { codeGuardian: true };
const sandbox = {
  path, guardian, setTimeout, console,
  currentFeatures: () => features,
  nodeEnv: () => process.env,
  resolveInCwd: (p) => path.resolve(tmp, String(p || '.')),
  __api: null
};
vm.runInNewContext(
  src.slice(start, end) +
  '\n__api = { formatearAvisoGuardian, etiquetaAvisoGuardian, revisarTrasEscritura };',
  sandbox
);
const { formatearAvisoGuardian, etiquetaAvisoGuardian, revisarTrasEscritura } = sandbox.__api;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '  -> ' + e.message); }
}
function ok(c, m) { if (!c) throw new Error(m || 'condicion falsa'); }

// Version con promesa para no anidar callbacks en las pruebas asincronas.
function revisar(tool, args) {
  return new Promise((res) => revisarTrasEscritura(tool, args, (aviso, etiqueta) => res({ aviso, etiqueta })));
}

// Secreto de juguete armado por trozos: asi ningun escaner lo lee como real.
const TOKEN = 'ghp' + '_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

console.log('\n--- el formato del aviso ---');

t('sin hallazgos no se anade nada al resultado', () => {
  ok(formatearAvisoGuardian([]) === null, 'devolvio texto con la lista vacia');
  ok(formatearAvisoGuardian(null) === null, 'no tolera null');
  ok(etiquetaAvisoGuardian([]) === '', 'etiqueta no vacia sin hallazgos');
});

t('un secreto se reporta con archivo, linea y que hacer', () => {
  const txt = formatearAvisoGuardian([{ tipo: 'secreto', archivo: 'C:\\x\\app.js', linea: 7, detalle: 'Token de GitHub: ghp_A1***7r8' }]);
  ok(/app\.js:7/.test(txt), 'no dice archivo y linea: ' + txt);
  ok(/variable de entorno/.test(txt), 'no dice como arreglarlo');
  ok(!/ghp_A1b2C3/.test(txt), 'filtro el secreto completo en el aviso');
});

t('un error de sintaxis manda corregir ya', () => {
  const txt = formatearAvisoGuardian([{ tipo: 'sintaxis', archivo: 'a.js', linea: 3, detalle: 'SyntaxError: x' }]);
  ok(/AHORA/.test(txt), 'no urge la correccion: ' + txt);
  ok(/1 error de sintaxis/.test(txt), 'no resume el tipo de problema');
});

t('resume bien cuando hay de los dos tipos', () => {
  const txt = formatearAvisoGuardian([
    { tipo: 'sintaxis', archivo: 'a.js', linea: 1, detalle: 'x' },
    { tipo: 'secreto', archivo: 'a.js', linea: 2, detalle: 'y' }
  ]);
  ok(/1 error de sintaxis y 1 posible secreto/.test(txt), 'resumen mal: ' + txt);
});

t('con muchos hallazgos recorta y dice cuantos faltan', () => {
  const muchos = Array.from({ length: 9 }, (_, i) => ({ tipo: 'secreto', archivo: 'a.js', linea: i + 1, detalle: 'd' + i }));
  const txt = formatearAvisoGuardian(muchos);
  ok(/y 4 mas/.test(txt), 'no indica los omitidos: ' + txt);
  ok(txt.split('\n').length < 12, 'el aviso se desborda y come contexto');
});

t('la etiqueta prioriza la sintaxis sobre el secreto', () => {
  const both = [{ tipo: 'secreto', detalle: 'a' }, { tipo: 'sintaxis', detalle: 'b' }];
  ok(/sintaxis/.test(etiquetaAvisoGuardian(both)), 'no prioriza el fallo que rompe el archivo');
  ok(/secreto/.test(etiquetaAvisoGuardian([{ tipo: 'secreto', detalle: 'a' }])), 'etiqueta de secreto mal');
});

console.log('\n--- revision sobre archivos de verdad ---');

async function main() {
  const casos = [];

  // Herramientas que NO escriben: ni se mira el archivo.
  fs.writeFileSync(path.join(tmp, 'fuga.js'), 'const t = "' + TOKEN + '";\n');
  for (const tool of ['read_file', 'list_dir', 'run_command', 'delete_file']) {
    const r = await revisar(tool, { path: 'fuga.js' });
    casos.push(['no revisa ' + tool + ' (no escribe)', r.aviso === null]);
  }

  // write_file con un secreto: debe avisar.
  const r1 = await revisar('write_file', { path: 'fuga.js' });
  casos.push(['write_file con secreto avisa', !!r1.aviso && /fuga\.js/.test(r1.aviso)]);
  casos.push(['el aviso enmascara el secreto', !!r1.aviso && !r1.aviso.includes(TOKEN)]);
  casos.push(['la etiqueta lo delata en el resumen', /secreto/.test(r1.etiqueta)]);

  // apply_patch tambien.
  const r2 = await revisar('apply_patch', { path: 'fuga.js' });
  casos.push(['apply_patch con secreto avisa', !!r2.aviso]);

  // Archivo limpio: cero ruido, cero tokens.
  fs.writeFileSync(path.join(tmp, 'limpio.js'), 'module.exports = function () { return 1; };\n');
  const r3 = await revisar('write_file', { path: 'limpio.js' });
  casos.push(['un archivo limpio no anade nada', r3.aviso === null && r3.etiqueta === '']);

  // Sintaxis rota.
  fs.writeFileSync(path.join(tmp, 'roto.js'), 'function a( {\n');
  const r4 = await revisar('write_file', { path: 'roto.js' });
  casos.push(['detecta sintaxis rota al escribir', !!r4.aviso && /sintaxis/.test(r4.aviso)]);
  casos.push(['y lo marca en la etiqueta', /sintaxis/.test(r4.etiqueta)]);

  // Placeholders: no debe gritar por un ejemplo.
  fs.writeFileSync(path.join(tmp, 'ejemplo.js'), 'const t = process.env.GITHUB_TOKEN || "${GITHUB_TOKEN}";\n');
  const r5 = await revisar('write_file', { path: 'ejemplo.js' });
  casos.push(['no grita por un placeholder', r5.aviso === null]);

  // Tipos que no se revisan.
  fs.writeFileSync(path.join(tmp, 'notas.bin'), 'const t = "' + TOKEN + '";');
  const r6 = await revisar('write_file', { path: 'notas.bin' });
  casos.push(['ignora extensiones no revisables', r6.aviso === null]);

  // Robustez: nada de esto puede tumbar una accion ya correcta.
  const r7 = await revisar('write_file', { path: 'no-existe-jamas.js' });
  casos.push(['un archivo inexistente no revienta', r7.aviso === null]);
  const r8 = await revisar('write_file', {});
  casos.push(['args sin path no revienta', r8.aviso === null]);

  // La bandera manda.
  features.codeGuardian = false;
  const r9 = await revisar('write_file', { path: 'fuga.js' });
  casos.push(['con la bandera apagada no revisa', r9.aviso === null]);
  features.codeGuardian = true;
  const r10 = await revisar('write_file', { path: 'fuga.js' });
  casos.push(['al reactivarla vuelve a revisar', !!r10.aviso]);

  for (const [nombre, cond] of casos) t(nombre, () => ok(cond));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + pass + ' pruebas OK, ' + fail + ' fallidas');
  process.exit(fail ? 1 : 0);
}

main();
