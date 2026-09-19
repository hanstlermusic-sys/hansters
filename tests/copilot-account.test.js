const fs = require('fs');
const path = require('path');
const assert = require('assert');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

assert.ok(
  /ghBin,\s*\['auth',\s*'token',\s*'--hostname',\s*'github\.com'\]/.test(server),
  'el servidor debe obtener el token de la cuenta activa de GitHub CLI'
);
assert.ok(
  /COPILOT_GITHUB_TOKEN:\s*token/.test(server),
  'el token seleccionado debe enviarse a Copilot CLI'
);
assert.ok(
  /\['login',\s*'--with-token'\]/.test(server),
  'el servidor debe reautenticar Copilot con la cuenta elegida (el env var solo no basta)'
);
assert.ok(
  /Signed in successfully as/.test(server),
  'debe confirmarse la cuenta real con la que quedo Copilot'
);
assert.ok(
  /copilotLoginAs\(r\.user/.test(server),
  'cambiar de cuenta debe disparar el login de Copilot'
);
assert.ok(
  /renderRepoAuthCard\(box,\s*true\)/.test(app),
  'Conversaciones debe mostrar el selector de suscripción'
);
assert.ok(
  /copilotUser/.test(app),
  'la tarjeta debe mostrar la cuenta que factura Copilot'
);
assert.ok(
  /c\.session\s*=\s*null/.test(app),
  'cambiar de cuenta debe descartar la sesión de Copilot anterior'
);

// `gh auth switch` es estado global de la maquina: un push o un script de
// fuera lo mueve. Si la lista marcara la cuenta activa por `gh`, la eleccion
// de suscripcion del usuario pareceria deshacerse sola.
assert.ok(
  /billByCopilot\s*=\s*forConversations\s*&&\s*!!copilotUser/.test(app),
  'en Conversaciones la cuenta marcada debe ser la que factura Copilot'
);
assert.ok(
  /const isAct\s*=\s*billByCopilot\s*\?\s*\(login2 === copilotUser\)\s*:\s*!!a\.active/.test(app),
  'la marca de activa no puede depender solo de la cuenta activa de gh'
);
assert.ok(
  /ghDiffers/.test(app) && /repo-auth-warn/.test(app),
  'si git y Copilot apuntan a cuentas distintas, hay que avisarlo'
);

console.log('  PASS  selector de cuenta de Copilot conectado al chat');
