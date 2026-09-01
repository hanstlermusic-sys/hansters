// Prueba end-to-end del contexto del agente contra el servidor real.
// Requiere ~/.hanstlers/azure.json; si no existe, se omite (no falla).
// No entra en CI porque consume cuota. Ejecutar a mano: npm run test:e2e
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

if (!fs.existsSync(path.join(os.homedir(), '.hanstlers', 'azure.json'))) {
  console.log('OMITIDA: no hay ~/.hanstlers/azure.json');
  process.exit(0);
}

const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 8803;
// Valor deliberadamente anodino: con nombres tipo "secreto.txt" o "TOKEN-..."
// el modelo se niega a repetir el contenido y la prueba falla por el motivo
// equivocado.
const VALOR = 'manzanas verdes 42 cajas';
const CONV = 'e2e-' + process.pid + '-' + Date.now();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-'));
fs.writeFileSync(path.join(dir, 'inventario.txt'), VALOR + '\notra linea\n');

function start() {
  const s = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, { HANSTLERS_PORT: String(PORT), HANSTLERS_CWD: dir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  s.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
  return s;
}

function chat(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      message, convId: CONV, model: 'azure-agent', history: [], images: [], files: []
    });
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let buf = '', out = '';
      res.on('data', (d) => {
        buf += d.toString();
        const parts = buf.split('\n\n'); buf = parts.pop();
        for (const p of parts) {
          const ev = /event: (\w+)/.exec(p); const dm = /data: ([\s\S]*)/.exec(p);
          if (!ev || !dm) continue;
          let data; try { data = JSON.parse(dm[1]); } catch (e) { data = dm[1]; }
          if (ev[1] === 'chunk') out += data;
          if (ev[1] === 'error') out += '\n[ERROR] ' + data;
        }
      });
      res.on('end', () => resolve(out));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const toolsIn = (s) => (s.match(/(read_file|list_dir|search_in_files|run_command|write_file)\(/g) || []);

(async () => {
  let fail = 0;
  let srv = start();
  try {
    await wait(2500);
    console.log('\n=== TURNO 1 ===');
    const t1 = await chat('Lee inventario.txt y responde solo con el numero de lineas. No escribas su contenido.');
    console.log(t1.trim().slice(0, 300));
    if (!/read_file/.test(t1)) { console.log('  FALLO: no ejecuto ninguna herramienta'); fail++; }

    console.log('\n=== REINICIANDO EL SERVIDOR (simula cerrar la app) ===');
    srv.kill(); await wait(1500);
    srv = start(); await wait(2500);

    console.log('\n=== TURNO 2 (proceso nuevo, history:[]) ===');
    const t2 = await chat('Cual es el texto EXACTO de la primera linea de inventario.txt que leiste antes? Responde solo con ese texto. NO uses herramientas.');
    console.log(t2.trim().slice(0, 300));

    const tools = toolsIn(t2);
    // Lo decisivo no es acertar el valor, sino saberlo SIN volver a leer nada.
    if (t2.indexOf(VALOR) === -1) { console.log('  FALLO: no recordo el contenido'); fail++; }
    if (tools.length) { console.log('  FALLO: releyo (' + tools.join(', ') + ') => contexto perdido'); fail++; }

    console.log('\n=== ' + (fail ? 'FALLARON ' + fail : 'TODO OK') + ' ===');
  } catch (e) {
    console.log('ERROR: ' + e.message); fail++;
  } finally {
    try { srv.kill(); } catch (e) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    try { fs.unlinkSync(path.join(os.homedir(), '.hanstlers', 'agent', CONV + '.json')); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
