// Pruebas del vigia de modelos de Gemini.
// No usan red: se valida el parseo de versiones, la seleccion de candidatos,
// la escritura segura de vertex.json y el cableado con server.js e interfaz.
const fs = require('fs');
const os = require('os');
const path = require('path');

const mw = require('../model-watch.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '  -> ' + e.message); }
}
function ok(c, m) { if (!c) throw new Error(m || 'esperaba verdadero'); }
function eq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((m || '') + ' esperado ' + JSON.stringify(b) + ' pero fue ' + JSON.stringify(a));
  }
}

console.log('\n--- parseModelo ---');

t('extrae version, variante y si es preview', () => {
  eq(mw.parseModelo('gemini-3.8-flash'), { id: 'gemini-3.8-flash', version: 3.8, variante: 'flash', preview: false });
  eq(mw.parseModelo('gemini-3.5-flash-lite'), { id: 'gemini-3.5-flash-lite', version: 3.5, variante: 'flash-lite', preview: false });
});

t('marca los preview para no ascender a ellos', () => {
  const m = mw.parseModelo('gemini-3.1-pro-preview');
  eq(m.preview, true, 'debe detectar preview:');
  eq(m.variante, 'pro', 'la variante no debe incluir el sufijo preview:');
});

t('ordena versiones correctamente (3.10 > 3.9 no aplica, pero 3.8 > 3.7)', () => {
  ok(mw.parseModelo('gemini-3.8-flash').version > mw.parseModelo('gemini-3.7-flash').version);
  ok(mw.parseModelo('gemini-3.7-flash').version > mw.parseModelo('gemini-2.5-flash').version);
});

t('devuelve null si no tiene forma de modelo gemini versionado', () => {
  eq(mw.parseModelo('claude-opus-5'), null);
  eq(mw.parseModelo(''), null);
});

console.log('\n--- estado y configuracion ---');

t('status expone lo que la interfaz necesita', () => {
  const s = mw.status();
  ['ok', 'enabled', 'autoApply', 'intervalHours', 'lastCheck', 'pendiente', 'actual'].forEach((k) => {
    ok(k in s, 'falta ' + k + ' en status()');
  });
});

t('el intervalo se mantiene en un rango sensato', () => {
  const previo = mw.loadState().intervalHours;
  eq(mw.setConfig({ intervalHours: 0 }).intervalHours, 1, 'minimo 1 hora:');
  eq(mw.setConfig({ intervalHours: 9999 }).intervalHours, 168, 'maximo una semana:');
  eq(mw.setConfig({ intervalHours: 24 }).intervalHours, 24, 'valor normal:');
  mw.setConfig({ intervalHours: previo });
});

t('autoApply viene desactivado salvo que se pida', () => {
  const previo = mw.loadState().autoApply;
  mw.setConfig({ autoApply: false });
  eq(mw.loadState().autoApply, false, 'por defecto no cambia solo:');
  mw.setConfig({ autoApply: previo });
});

console.log('\n--- applyModel ---');

t('applyModel preserva el resto de vertex.json y no mete BOM', () => {
  const f = path.join(os.homedir(), '.hanstlers', 'vertex.json');
  if (!fs.existsSync(f)) { console.log('        (sin vertex.json local, se omite)'); return; }
  const antes = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  const original = antes.modelPro;

  const r = mw.applyModel('gemini-3.7-flash');
  eq(r.ok, true, 'debe aplicar:');

  const crudo = fs.readFileSync(f, 'utf8');
  ok(crudo.charCodeAt(0) !== 0xFEFF, 'no debe escribir BOM (rompe JSON.parse)');
  const despues = JSON.parse(crudo);
  eq(despues.modelPro, 'gemini-3.7-flash', 'modelo aplicado:');
  eq(despues.apiKey, antes.apiKey, 'la API key debe sobrevivir:');
  eq(despues.modelFlash, antes.modelFlash, 'el modelo flash no se toca:');
  eq(despues.region, antes.region, 'la region no se toca:');

  mw.applyModel(original); // restaurar
  eq(JSON.parse(fs.readFileSync(f, 'utf8')).modelPro, original, 'restaurado:');
});

t('applyModel rechaza un modelo vacio', () => {
  eq(mw.applyModel('').ok, false, 'sin modelo debe fallar:');
});

t('dismiss recuerda el descarte para no reofrecerlo', () => {
  const antes = mw.loadState().descartados.slice();
  mw.dismiss('gemini-9.9-inventado');
  ok(mw.loadState().descartados.indexOf('gemini-9.9-inventado') >= 0, 'debe recordar el descarte');
  eq(mw.loadState().pendiente, null, 'descartar limpia el pendiente:');
  const st = mw.loadState(); st.descartados = antes;
  fs.writeFileSync(path.join(os.homedir(), '.hanstlers', 'model-watch.json'), JSON.stringify(st, null, 2), 'utf8');
});

console.log('\n--- cableado ---');

t('el vigia solo mira modelos de texto', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'model-watch.js'), 'utf8');
  const m = /const EXCLUIR = ([^;]+);/.exec(src);
  ok(m, 'debe existir el filtro EXCLUIR');
  const re = eval(m[1]);
  ['gemini-3-pro-image', 'gemini-3.5-transcribe', 'gemini-3.1-flash-tts-preview'].forEach((id) => {
    ok(re.test(id), id + ' deberia excluirse (no puede sustituir al modelo del agente)');
  });
  ['gemini-3.8-flash', 'gemini-3.1-pro-preview'].forEach((id) => {
    ok(!re.test(id), id + ' NO deberia excluirse');
  });
});

t('un candidato se valida con function calling, no solo listando', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'model-watch.js'), 'utf8');
  const from = src.indexOf('async function probarModelo(');
  const to = src.indexOf('async function medir(');
  const body = src.slice(from, to);
  ok(/functionResponse/.test(body), 'debe cerrar el ciclo con functionResponse');
  ok(/role: 'model', parts: partes/.test(body),
    'debe devolver las partes CRUDAS: reconstruirlas pierde thoughtSignature y da 400');
  ok(/tools: TOOLS/.test(body), 'debe declarar herramientas');
});

t('server.js expone las rutas del vigia', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ["'/api/vertex/models/status'", "'/api/vertex/models/check'",
   "'/api/vertex/models/apply'", "'/api/vertex/models/dismiss'",
   "'/api/vertex/models/config'"].forEach((r) => {
    ok(src.indexOf(r) > 0, 'falta la ruta ' + r);
  });
  ok(/require\('\.\/model-watch'\)/.test(src), 'server.js debe requerir model-watch.js');
  ok(/modelWatch\.schedule\(/.test(src), 'debe agendarse al arrancar');
});

t('cambiar el modelo exige admin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("'/api/vertex/models/apply'");
  ok(/requireAdminOrDeny/.test(src.slice(i, i + 300)), 'apply debe exigir admin');
});

t('model-watch.js viaja dentro del paquete', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  ok(pkg.build.files.indexOf('model-watch.js') >= 0,
    'model-watch.js debe estar en build.files o no se empaqueta');
});

t('la interfaz muestra y aplica el hallazgo', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  ok(html.indexOf('id="model-watch"') > 0, 'falta el panel del vigia en index.html');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  ['/api/vertex/models/status', '/api/vertex/models/apply', '/api/vertex/models/check'].forEach((r) => {
    ok(app.indexOf(r) > 0, 'app.js debe usar ' + r);
  });
});

console.log('\n=== ' + pass + ' pasaron, ' + fail + ' fallaron ===\n');
process.exit(fail ? 1 : 0);
