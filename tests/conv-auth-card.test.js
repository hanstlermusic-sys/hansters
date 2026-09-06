// Verifica que la tarjeta de cuenta de GitHub se renderiza en el panel de
// Conversaciones con los mismos datos que en Repos (y el aviso de suscripcion).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const start = src.indexOf('function renderRepoAuthCard(');
const end = src.indexOf('async function selectRepoItem(');
assert.ok(start > 0 && end > start, 'no se pudo extraer renderRepoAuthCard de app.js');

const sandbox = {
  repoAuth: {
    enabled: false,
    ok: true,
    user: null,
    ghLogged: true,
    ghUser: 'cezumbad_microsoft',
    copilotUser: 'cezumbad_microsoft',
    ghAccounts: [
      { login: 'cezumbad_microsoft', active: true },
      { login: 'hanstlermusic-sys', active: false }
    ]
  },
  esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  document: { createElement: () => ({ className: '', innerHTML: '' }) },
  Array: Array,
  String: String,
  __out: null
};
vm.runInNewContext(src.slice(start, end) + '\n__out = renderRepoAuthCard;', sandbox);

function render(forConversations) {
  const cards = [];
  return sandbox.__out({ appendChild: (c) => cards.push(c) }, forConversations) || cards[0];
}

const conv = render(true);
const repo = render(false);

assert.ok(/repo-auth-title">GitHub</.test(conv.innerHTML), 'falta el titulo GitHub en Conversaciones');
assert.ok(/Conectado: <b>cezumbad_microsoft<\/b>/.test(conv.innerHTML), 'falta la cuenta conectada');
assert.ok(/Cambiar de cuenta/.test(conv.innerHTML), 'falta el bloque para cambiar de cuenta');
assert.ok(/data-gh-switch="hanstlermusic-sys"/.test(conv.innerHTML), 'falta el boton de la otra cuenta');
assert.ok(/Copilot factura a <b>cezumbad_microsoft<\/b>/.test(conv.innerHTML), 'falta el aviso de suscripcion');
assert.ok(/data-repo-refresh/.test(conv.innerHTML), 'falta el boton Actualizar');
assert.ok(!/Copilot factura a/.test(repo.innerHTML), 'el aviso de suscripcion no va en Repos');
assert.ok(/data-gh-switch="hanstlermusic-sys"/.test(repo.innerHTML), 'Repos perdio el cambio de cuenta');

console.log('  PASS  tarjeta de cuenta visible en Conversaciones y en Repos');
