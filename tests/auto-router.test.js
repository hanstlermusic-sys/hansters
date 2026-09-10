// Pruebas del router automatico de modelos.
// Extrae funciones reales de server.js para evitar desalineaciones.
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

const bloque = extraer(
  'function looksLikeExecutionTask(text) {',
  'function wrapProResponsePrompt(message) {',
  'router automatico');

let hasAzure = true;
const sandbox = {
  __out: null,
  String, Number, RegExp, JSON, Math,
  loadAzure: () => (hasAzure ? { endpoint: 'ok', key: 'ok', deployment: 'ok' } : null),
  currentFeatures: () => ({
    smartRouter: true,
    proResponseMode: false,
    agentBridgeMode: true,
    routeExecutionToAzureAgent: true,
    vertexAgentTools: true,
    preferClaudeForStrategy: true,
    preferXCoreForAudio: true,
    autoRouteForLocalAgent: true,
    operatorMode: false
  }),
  state: { model: 'auto' }
};
vm.runInNewContext(
  bloque + '\n__out = { chooseModelForRequest, chooseAutoModelRoute, looksLikeCodeDevelopmentTask, looksLikeUnresolvedTask, looksLikeNewDevelopmentTask };',
  sandbox);

const { chooseModelForRequest, looksLikeCodeDevelopmentTask, looksLikeUnresolvedTask, looksLikeNewDevelopmentTask } = sandbox.__out;

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
function ok(cond, m) { if (!cond) throw new Error(m || 'condicion falsa'); }

console.log('\n--- router automatico ---');

t('respeta un modelo explicito', () => {
  eq(chooseModelForRequest('gpt-5.4', 'hola', false, false), { model: 'gpt-5.4', reason: 'explicit-model' });
});

t('preguntas generales usan gemini-3.5-flash con fallback a gpt-5.4-mini', () => {
  eq(
    chooseModelForRequest('auto', '¿qué es IaC y cuándo conviene usarlo?', false, false),
    { model: 'gemini-3.5-flash', reason: 'auto-general-primary', fallbackModel: 'gpt-5.4-mini' }
  );
});

t('desarrollo de codigo usa gpt-5.3-codex', () => {
  eq(
    chooseModelForRequest('auto', 'corrige este bug y refactoriza el archivo app.js', false, false),
    { model: 'gpt-5.3-codex', reason: 'auto-code-primary', fallbackModel: 'claude-opus-5' }
  );
});

t('una tarea bloqueada escala a claude-opus-5', () => {
  eq(
    chooseModelForRequest('auto', 'no se pudo resolver, sigo atascado con este problema', false, false),
    { model: 'claude-opus-5', reason: 'auto-unresolved-opus' }
  );
});

t('nuevo desarrollo desde cero escala a claude-opus-5', () => {
  eq(
    chooseModelForRequest('auto', 'arranquemos una nueva app desde cero con arquitectura completa', false, false),
    { model: 'claude-opus-5', reason: 'auto-new-development-opus' }
  );
});

t('si no hay Azure configurado, tarea operativa cae en ruta general', () => {
  hasAzure = false;
  eq(
    chooseModelForRequest('auto', 'abre el portal de azure y revisa dns', false, false),
    { model: 'gemini-3.5-flash', reason: 'auto-general-primary', fallbackModel: 'gpt-5.4-mini' }
  );
  hasAzure = true;
});

t('si hay Azure configurado, tarea de portal/ejecucion usa azure-agent', () => {
  eq(
    chooseModelForRequest('auto', 'abre el portal de azure y revisa dns', false, false),
    { model: 'azure-agent', reason: 'execution-or-web-task' }
  );
});

t('codigo tiene prioridad sobre ruta operativa', () => {
  const r = chooseModelForRequest('auto', 'crea y corrige código en server.js para este bug', false, false);
  eq(r, { model: 'gpt-5.3-codex', reason: 'auto-code-primary', fallbackModel: 'claude-opus-5' });
});

t('las detecciones auxiliares cubren frases clave', () => {
  ok(looksLikeCodeDevelopmentTask('edita este módulo y agrega tests'));
  ok(looksLikeUnresolvedTask('no se pudo y sigo bloqueado'));
  ok(looksLikeNewDevelopmentTask('new app from scratch'));
});

console.log('\n=== ' + pass + ' pasaron, ' + fail + ' fallaron ===\n');
process.exit(fail ? 1 : 0);
