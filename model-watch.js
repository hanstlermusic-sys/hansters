'use strict';
// Vigia de modelos de Gemini.
//
// Por que no basta con leer /v1beta/models: Google DEJA los modelos retirados
// visibles en esa lista aunque ya respondan 404 (gemini-2.5-pro es el caso
// que nos rompio la app). Asi que aqui nada se da por bueno hasta que se
// PRUEBA de verdad: texto, function calling con llamadas paralelas y el
// round-trip de thoughtSignature, que es justo lo que usa el bucle de agente.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const STATE_FILE = path.join(os.homedir(), '.hanstlers', 'model-watch.json');
const VERTEX_FILE = path.join(os.homedir(), '.hanstlers', 'vertex.json');

// Solo nos interesan los modelos de texto/razonamiento: los de imagen, voz y
// transcripcion no pueden sustituir al modelo del agente.
const EXCLUIR = /(image|tts|transcribe|live|embedding|aqa|learnlm|veo|imagen)/i;

function leerJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; }
}
function escribirJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Sin BOM: un BOM invisible ya nos tumbo JSON.parse una vez.
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), { encoding: 'utf8' });
    return true;
  } catch (e) { return false; }
}

// Un valor ausente usa el default; uno presente se recorta al rango valido.
// Ojo con `Number(x) || 24`: convertiria un 0 explicito en 24 y se saltaria
// el minimo.
function horasValidas(v, porDefecto) {
  const n = Number(v);
  if (v == null || v === '' || !isFinite(n)) return porDefecto;
  return Math.max(1, Math.min(168, n));
}

function loadState() {
  const s = leerJson(STATE_FILE) || {};
  return {
    enabled: s.enabled !== false,
    intervalHours: horasValidas(s.intervalHours, 24),
    autoApply: s.autoApply === true,
    conocidos: Array.isArray(s.conocidos) ? s.conocidos : [],
    lastCheck: s.lastCheck || 0,
    lastResult: s.lastResult || null,
    pendiente: s.pendiente || null,
    descartados: Array.isArray(s.descartados) ? s.descartados : []
  };
}
function saveState(s) { escribirJson(STATE_FILE, s); return s; }

function apiKey() {
  const env = String(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '').trim();
  if (env) return env;
  const c = leerJson(VERTEX_FILE);
  return c && c.apiKey ? String(c.apiKey).trim() : '';
}

function httpJson(opts, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign({}, opts.headers || {});
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({
      host: 'generativelanguage.googleapis.com',
      path: opts.path,
      method: opts.method || 'GET',
      timeout: opts.timeout || 45000,
      headers
    }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; if (out.length > 4e6) out = out.slice(-4e6); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch (e) {}
        resolve({ status: res.statusCode, json, raw: out });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ status: 0, json: null, raw: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, json: null, raw: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

// Familia y version, para comparar "peras con peras": un 3.8-flash sustituye
// a un 3.7-flash, pero un flash-lite no sustituye a un pro.
function parseModelo(id) {
  const m = /^gemini-(\d+(?:\.\d+)?)-(.+)$/.exec(id);
  if (!m) return null;
  const version = parseFloat(m[1]);
  let variante = m[2];
  const preview = /-preview/.test(variante);
  variante = variante.replace(/-preview.*$/, '').replace(/-\d{2,}$/, '');
  return { id, version, variante, preview };
}

async function listarModelos() {
  const key = apiKey();
  if (!key) return { ok: false, error: 'No hay API key de Google configurada.' };
  const r = await httpJson({ path: '/v1beta/models?pageSize=200', headers: { 'x-goog-api-key': key } });
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.models)) {
    return { ok: false, error: 'No pude listar modelos (HTTP ' + r.status + ').' };
  }
  const ids = r.json.models
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter((id) => /^gemini-/.test(id) && !EXCLUIR.test(id));
  return { ok: true, ids };
}

const TOOLS = [{
  functionDeclarations: [
    { name: 'leer_archivo', description: 'Lee un archivo del disco.',
      parameters: { type: 'object', properties: { ruta: { type: 'string' } }, required: ['ruta'] } },
    { name: 'clima', description: 'Da el clima actual de una ciudad.',
      parameters: { type: 'object', properties: { ciudad: { type: 'string' } }, required: ['ciudad'] } }
  ]
}];

// La prueba de fuego: el modelo tiene que pedir herramientas y luego aceptar
// de vuelta sus propias partes crudas (con thoughtSignature). Si falla el
// segundo turno, es exactamente el HTTP 400 que rompia el agente.
async function probarModelo(id) {
  const key = apiKey();
  const res = { id, usable: false, tools: false, ms: 0, error: '' };
  if (!key) { res.error = 'sin API key'; return res; }
  const p = '/v1beta/models/' + id + ':generateContent';
  const h = { 'x-goog-api-key': key };

  const t0 = Date.now();
  const r1 = await httpJson({ path: p, method: 'POST', headers: h, timeout: 40000 }, {
    contents: [{ role: 'user', parts: [{ text: 'Responde solo: OK' }] }]
  });
  if (r1.status !== 200) {
    res.error = 'HTTP ' + r1.status + (r1.json && r1.json.error ? ' ' + String(r1.json.error.message).slice(0, 120) : '');
    res.ms = Date.now() - t0;
    return res;
  }
  res.usable = true;

  const t1 = Date.now();
  const r2 = await httpJson({ path: p, method: 'POST', headers: h, timeout: 40000 }, {
    contents: [{ role: 'user', parts: [{ text: 'Dime el clima de Bogota y de Lima, y lee C:/temp/n.txt. Usa las herramientas.' }] }],
    tools: TOOLS
  });
  if (r2.status !== 200 || !r2.json.candidates) {
    res.error = 'sin function calling (HTTP ' + r2.status + ')';
    res.ms = Date.now() - t1;
    return res;
  }
  const partes = (r2.json.candidates[0].content && r2.json.candidates[0].content.parts) || [];
  const llamadas = partes.filter((x) => x.functionCall);
  if (!llamadas.length) { res.error = 'no usa herramientas'; res.ms = Date.now() - t1; return res; }

  // Devolvemos las partes TAL CUAL: reconstruirlas pierde thoughtSignature.
  const r3 = await httpJson({ path: p, method: 'POST', headers: h, timeout: 40000 }, {
    contents: [
      { role: 'user', parts: [{ text: 'Dime el clima de Bogota y de Lima, y lee C:/temp/n.txt. Usa las herramientas.' }] },
      { role: 'model', parts: partes },
      { role: 'user', parts: llamadas.map((x) => ({
        functionResponse: { name: x.functionCall.name, response: { resultado: 'simulado' } } })) }
    ],
    tools: TOOLS
  });
  res.ms = Date.now() - t1;
  if (r3.status !== 200) {
    res.error = 'falla el round-trip de thoughtSignature (HTTP ' + r3.status + ')';
    return res;
  }
  res.tools = true;
  res.llamadas = llamadas.length;
  return res;
}

// Promedio de dos rondas: una sola medicion de latencia es ruidosa.
async function medir(id) {
  const a = await probarModelo(id);
  if (!a.tools) return a;
  const b = await probarModelo(id);
  if (!b.tools) return b;
  return Object.assign({}, a, { ms: Math.round((a.ms + b.ms) / 2) });
}

function modeloActual() {
  const c = leerJson(VERTEX_FILE) || {};
  return { pro: String(c.modelPro || '').trim(), flash: String(c.modelFlash || '').trim() };
}

// Comprueba si hay un modelo mejor que el que usamos hoy.
// deep=false: solo detecta nombres nuevos (barato, sin gastar tokens).
// deep=true: ademas prueba a fondo los candidatos y compara latencia.
async function checkModels(opts) {
  const o = opts || {};
  const st = loadState();
  const lista = await listarModelos();
  if (!lista.ok) {
    st.lastCheck = Date.now();
    st.lastResult = { ok: false, error: lista.error, at: Date.now() };
    saveState(st);
    return st.lastResult;
  }

  const actual = modeloActual();
  const nuevos = lista.ids.filter((id) => st.conocidos.indexOf(id) < 0);
  const primeraVez = st.conocidos.length === 0;

  // Candidatos: misma variante que el modelo pro actual, version mas alta,
  // y nada en preview (no queremos sorpresas en produccion).
  const refPro = parseModelo(actual.pro) || { version: 0, variante: 'flash' };
  const candidatos = lista.ids
    .map(parseModelo)
    .filter(Boolean)
    .filter((m) => !m.preview)
    .filter((m) => m.variante === refPro.variante)
    .filter((m) => m.version > refPro.version)
    .filter((m) => st.descartados.indexOf(m.id) < 0)
    .sort((a, b) => b.version - a.version);

  const resultado = {
    ok: true,
    at: Date.now(),
    actual,
    totalModelos: lista.ids.length,
    nuevos: primeraVez ? [] : nuevos,
    candidatos: candidatos.map((c) => c.id),
    probados: [],
    mejor: null,
    recomendacion: null
  };

  if (o.deep && candidatos.length) {
    const base = await medir(actual.pro);
    resultado.baseline = { id: actual.pro, ms: base.ms, tools: base.tools, error: base.error };

    for (const c of candidatos.slice(0, 3)) {
      const r = await medir(c.id);
      resultado.probados.push(r);
      if (!r.tools) {
        // Un candidato que no aguanta el round-trip no se vuelve a probar:
        // asi no gastamos tokens en el mismo fallo cada dia.
        if (st.descartados.indexOf(c.id) < 0) st.descartados.push(c.id);
        continue;
      }
      if (!resultado.mejor || r.ms < resultado.mejor.ms) resultado.mejor = r;
    }

    if (resultado.mejor && base.tools) {
      const mejora = Math.round(((base.ms - resultado.mejor.ms) / base.ms) * 100);
      resultado.recomendacion = {
        de: actual.pro,
        a: resultado.mejor.id,
        mejoraPct: mejora,
        msAntes: base.ms,
        msDespues: resultado.mejor.ms,
        // Solo vale la pena si no es mas lento. Un empate ya justifica el
        // salto: el modelo mas nuevo vivira mas tiempo antes de retirarse.
        vale: resultado.mejor.ms <= base.ms * 1.05
      };
    } else if (resultado.mejor && !base.tools) {
      // El modelo actual esta roto: cualquier candidato sano es mejor.
      resultado.recomendacion = {
        de: actual.pro, a: resultado.mejor.id, mejoraPct: 100,
        msAntes: 0, msDespues: resultado.mejor.ms, vale: true,
        motivo: 'el modelo actual ya no funciona'
      };
    }
  }

  st.conocidos = lista.ids;
  st.lastCheck = Date.now();
  st.lastResult = resultado;
  st.pendiente = (resultado.recomendacion && resultado.recomendacion.vale)
    ? resultado.recomendacion : null;
  saveState(st);

  if (st.autoApply && st.pendiente) {
    const ap = applyModel(st.pendiente.a);
    resultado.aplicado = ap;
  }
  return resultado;
}

// Cambia el modelo pro en vertex.json, preservando el resto de la config.
function applyModel(id) {
  const modelo = String(id || '').trim();
  if (!modelo) return { ok: false, error: 'falta el modelo' };
  const cfg = leerJson(VERTEX_FILE);
  if (!cfg) return { ok: false, error: 'no pude leer vertex.json' };
  const anterior = cfg.modelPro;
  cfg.modelPro = modelo;
  if (!escribirJson(VERTEX_FILE, cfg)) return { ok: false, error: 'no pude escribir vertex.json' };
  const st = loadState();
  st.pendiente = null;
  saveState(st);
  return { ok: true, de: anterior, a: modelo };
}

function dismiss(id) {
  const st = loadState();
  if (id && st.descartados.indexOf(id) < 0) st.descartados.push(id);
  st.pendiente = null;
  saveState(st);
  return { ok: true };
}

function setConfig(patch) {
  const st = loadState();
  if (typeof patch.enabled === 'boolean') st.enabled = patch.enabled;
  if (typeof patch.autoApply === 'boolean') st.autoApply = patch.autoApply;
  if (patch.intervalHours != null) {
    st.intervalHours = horasValidas(patch.intervalHours, st.intervalHours);
  }
  saveState(st);
  return st;
}

function status() {
  const st = loadState();
  return {
    ok: true,
    enabled: st.enabled,
    autoApply: st.autoApply,
    intervalHours: st.intervalHours,
    lastCheck: st.lastCheck,
    pendiente: st.pendiente,
    actual: modeloActual(),
    lastResult: st.lastResult
  };
}

// ===== Agenda =====
let timer = null;
function schedule(onFinding) {
  if (timer) clearInterval(timer);
  const st = loadState();
  if (!st.enabled) return;
  const cada = st.intervalHours * 60 * 60 * 1000;

  const correr = (motivo) => {
    // Chequeo barato de rutina; a fondo solo si aparecio algo nuevo o si
    // toca la revision periodica completa.
    checkModels({ deep: false })
      .then((r) => {
        if (!r.ok) return null;
        const hayNovedad = (r.candidatos && r.candidatos.length) || (r.nuevos && r.nuevos.length);
        if (!hayNovedad) return null;
        return checkModels({ deep: true });
      })
      .then((r) => {
        if (r && r.recomendacion && r.recomendacion.vale && typeof onFinding === 'function') {
          onFinding(r);
        }
      })
      .catch(() => {});
  };

  // Al arrancar, con margen para no competir con el arranque de la app.
  setTimeout(() => correr('startup'), 45000);
  timer = setInterval(() => correr('interval'), cada);
}

module.exports = {
  checkModels, applyModel, dismiss, setConfig, status, schedule,
  probarModelo, listarModelos, parseModelo, loadState
};
