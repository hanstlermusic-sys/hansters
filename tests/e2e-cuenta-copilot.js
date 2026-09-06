// Prueba REAL de extremo a extremo: levanta el servidor de HanstlerS, cambia de
// cuenta por el mismo endpoint que usa la tarjeta del panel y comprueba que el
// CLI de Copilot queda autenticado con esa cuenta (no solo `gh`).
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 8919;
const OBJETIVO = process.argv[2] || 'cezumbad_microsoft';
const OTRA = process.argv[3] || 'hanstlermusic-sys';

function pedir(metodo, ruta, cuerpo) {
  return new Promise((resolve, reject) => {
    const datos = cuerpo ? JSON.stringify(cuerpo) : null;
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: ruta, method: metodo,
      headers: datos ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(datos) } : {}
    }, (res) => {
      let out = '';
      res.on('data', (d) => (out += d));
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('respuesta no JSON: ' + out.slice(0, 200))); } });
    });
    req.on('error', reject);
    if (datos) req.write(datos);
    req.end();
  });
}

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function arriba() {
  for (let i = 0; i < 40; i++) {
    try { await pedir('GET', '/api/gh/auth/copilot'); return true; } catch (e) { await esperar(500); }
  }
  return false;
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { HANSTLERS_PORT: String(PORT), HANSTLERS_HOST: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  let codigo = 0;
  try {
    if (!(await arriba())) throw new Error('el servidor no respondio');

    // 1) Cambiar a la otra cuenta y luego a la del usuario: probamos el cambio real.
    const r1 = await pedir('POST', '/api/gh/auth/switch', { user: OTRA });
    if (!r1.ok) throw new Error('no cambio a ' + OTRA + ': ' + r1.error);
    if (r1.copilotUser !== OTRA) throw new Error('Copilot quedo en ' + r1.copilotUser + ' y no en ' + OTRA);

    const r2 = await pedir('POST', '/api/gh/auth/switch', { user: OBJETIVO });
    if (!r2.ok) throw new Error('no cambio a ' + OBJETIVO + ': ' + r2.error);
    if (r2.copilotUser !== OBJETIVO) throw new Error('Copilot quedo en ' + r2.copilotUser + ' y no en ' + OBJETIVO);

    // 2) La tarjeta debe poder leer la cuenta que factura.
    const estado = await pedir('GET', '/api/gh/auth/copilot');
    if (estado.user !== OBJETIVO) throw new Error('la tarjeta mostraria ' + estado.user);

    // 3) `gh` tambien debe haber quedado en esa cuenta.
    const ghUser = String(execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' })).trim();
    if (ghUser !== OBJETIVO) throw new Error('gh quedo en ' + ghUser);

    console.log('  PASS  cambio de cuenta real: gh y Copilot quedaron en ' + OBJETIVO);
  } catch (e) {
    codigo = 1;
    console.log('  FAIL  ' + e.message);
  } finally {
    try { process.kill(server.pid); } catch (e) {}
    process.exit(codigo);
  }
})();
