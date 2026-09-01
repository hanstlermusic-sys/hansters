// Pruebas del parseo de repos para el clonado automatico (open_repo).
// Se extrae la funcion REAL de server.js y se ejecuta en un sandbox, igual que
// las demas pruebas, para que no pueda quedar desincronizada. No usa red.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SERVER = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');

const start = src.indexOf('function parseRepoSpec(spec) {');
const end = src.indexOf('// Candidatos donde ya podria existir una copia local');
if (start < 0 || end < 0 || end <= start) {
  console.error('No se pudo extraer parseRepoSpec de server.js');
  process.exit(1);
}

const sandbox = { __out: null, String: String };
vm.runInNewContext(src.slice(start, end) + '\n__out = { parseRepoSpec };', sandbox);
const { parseRepoSpec } = sandbox.__out;

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

console.log('\n--- parseRepoSpec ---');

t('acepta owner/repo', () => {
  eq(parseRepoSpec('hanstlermusic-sys/hansters'), { owner: 'hanstlermusic-sys', repo: 'hansters' });
});

t('acepta la URL https de GitHub, con o sin .git', () => {
  eq(parseRepoSpec('https://github.com/hanstlermusic-sys/hansters'), { owner: 'hanstlermusic-sys', repo: 'hansters' });
  eq(parseRepoSpec('https://github.com/hanstlermusic-sys/hansters.git'), { owner: 'hanstlermusic-sys', repo: 'hansters' });
});

t('ignora la cola de la URL (rama, issues, query)', () => {
  eq(parseRepoSpec('https://github.com/owner/repo/tree/main'), { owner: 'owner', repo: 'repo' });
  eq(parseRepoSpec('github.com/owner/repo?tab=readme'), { owner: 'owner', repo: 'repo' });
});

t('acepta la URL ssh', () => {
  eq(parseRepoSpec('git@github.com:owner/repo.git'), { owner: 'owner', repo: 'repo' });
});

t('acepta solo el nombre y deja el owner vacio para resolverlo despues', () => {
  eq(parseRepoSpec('hansters'), { owner: '', repo: 'hansters' });
});

t('limpia comillas y puntuacion suelta del lenguaje natural', () => {
  eq(parseRepoSpec('"owner/repo"'), { owner: 'owner', repo: 'repo' });
  eq(parseRepoSpec('<https://github.com/owner/repo>'), { owner: 'owner', repo: 'repo' });
  eq(parseRepoSpec('owner/repo,'), { owner: 'owner', repo: 'repo' });
});

t('rechaza entradas vacias o sin forma de repo', () => {
  eq(parseRepoSpec(''), null);
  eq(parseRepoSpec(null), null);
  eq(parseRepoSpec('a/b/c/d e f'), null);
});

console.log('\n=== ' + pass + ' pasaron, ' + fail + ' fallaron ===');
process.exit(fail ? 1 : 0);
