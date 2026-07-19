'use strict';
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const composer = document.getElementById('composer');
const sendBtn = document.getElementById('send');
const cwdEl = document.getElementById('cwd');

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// Render de markdown (bloques de código, inline, negritas, listas, títulos, enlaces)
function renderMd(text){
  // Extraer bloques de código primero (para no tocar su contenido)
  const blocks = [];
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (m,lang,code)=>{
    blocks.push('<pre><code>'+esc(code.replace(/\n$/,''))+'</code></pre>');
    return '\u0000B'+(blocks.length-1)+'\u0000';
  });
  html = esc(html);
  // inline code
  const inline = [];
  html = html.replace(/`([^`\n]+)`/g, (m,c)=>{ inline.push('<code>'+c+'</code>'); return '\u0000I'+(inline.length-1)+'\u0000'; });
  // enlaces [texto](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  // negritas y cursivas
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // títulos
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h3>$1</h3>');
  // listas
  html = html.replace(/^(\s*)[-*] (.+)$/gm, '$1<li>$2</li>');
  html = html.replace(/^(\s*)\d+\. (.+)$/gm, '$1<li>$2</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
  // restaurar código
  html = html.replace(/\u0000I(\d+)\u0000/g, (m,i)=>inline[+i]);
  html = html.replace(/\u0000B(\d+)\u0000/g, (m,i)=>blocks[+i]);
  return html;
}

function addMsg(role, html, idx){
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  if(idx!==undefined) wrap.dataset.idx = idx;
  wrap.innerHTML = `<div class="avatar">${role==='bot'?'H':'Tú'}</div><div class="bubble">${html}</div>`;
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return wrap.querySelector('.bubble');
}

const WELCOME = '¡Hola! Soy <strong>HanstlerS</strong>. Elige tu carpeta de proyecto arriba y dime en qué trabajamos. Puedo leer y editar archivos, ejecutar comandos y usar tu agente <code>hanstler-dev</code>.';

// ===== Estado por conversación (independiente / paralelo) =====
const convData = {}; // id -> {title, messages:[], session, queue:[], busy, aborts:Set}
let activeId = 'c' + Date.now();

function getConv(id){
  if(!convData[id]) convData[id] = { title:'Nueva conversación', messages:[], session:null, model:null, queue:[], busy:false, aborts:new Set() };
  return convData[id];
}

function persistConv(id){
  const c = convData[id]; if(!c || !c.messages.length) return;
  if(c.title==='Nueva conversación'){
    const fu = c.messages.find(m=>m.role==='user');
    if(fu){ const t=fu.html.replace(/<[^>]+>/g,'').trim(); c.title = t.slice(0,40) || 'Conversación'; }
  }
  fetch('/api/conv/save', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ id, title:c.title, messages:c.messages, session:c.session, model:c.model })})
    .then(()=>loadConvList()).catch(()=>{});
}

// Actualiza el DOM de un mensaje concreto solo si su conversación está activa.
function updateBubble(id, idx, html){
  if(id!==activeId) return;
  const el = chat.querySelector('.msg[data-idx="'+idx+'"] .bubble');
  if(el){ el.innerHTML = html; chat.scrollTop = chat.scrollHeight; }
}

function renderActive(){
  chat.innerHTML='';
  const c = getConv(activeId);
  if(!c.messages.length){ addMsg('bot', WELCOME); return; }
  c.messages.forEach((m,i)=> addMsg(m.role, m.html, i));
}

async function loadConvList(){
  try{
    const r = await fetch('/api/conv/list'); const j = await r.json();
    const box = document.getElementById('conv-list'); box.innerHTML='';
    (j.items||[]).forEach(it=>{
      const busy = convData[it.id] && convData[it.id].busy;
      const el = document.createElement('div');
      el.className = 'conv-item' + (it.id===activeId?' active':'');
      el.innerHTML = `<span class="t" title="${esc(it.title)}">${busy?'<span class="spin">●</span> ':''}${esc(it.title)}</span><span class="ren" title="Renombrar">✏️</span><span class="del" title="Borrar">🗑</span>`;
      el.querySelector('.t').onclick = ()=> openConv(it.id);
      el.querySelector('.ren').onclick = async (e)=>{ e.stopPropagation();
        const nn = (prompt('Nuevo nombre de la conversación:', it.title)||'').trim();
        if(!nn) return;
        await fetch('/api/conv/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:it.id,title:nn})});
        if(convData[it.id]) convData[it.id].title=nn;
        loadConvList();
      };
      el.querySelector('.del').onclick = async (e)=>{ e.stopPropagation();
        await fetch('/api/conv/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:it.id})});
        delete convData[it.id];
        if(it.id===activeId) newConv(); else loadConvList();
      };
      box.appendChild(el);
    });
  }catch(e){}
}

async function openConv(id){
  try{
    // Si ya la tenemos en memoria (posiblemente trabajando), úsala; si no, cárgala.
    if(!convData[id]){
      const r = await fetch('/api/conv/get?id='+encodeURIComponent(id)); const c = await r.json();
      if(!c || c.error) return;
      convData[id] = { title:c.title||'Conversación', messages:c.messages||[], session:c.session||null, model:c.model||null, queue:[], busy:false, aborts:new Set() };
    }
    activeId = id;
    renderActive();
    reflectModel();
    refreshStopMode();
    loadConvList();
  }catch(e){}
}

// Refleja en el selector el modelo guardado de la conversación activa.
function reflectModel(){
  const sel = document.getElementById('model-sel');
  if(!sel || !sel.options.length) return;
  const c = convData[activeId];
  const m = (c && c.model) ? c.model : 'auto';
  let opt = [...sel.options].find(o=>o.value===m);
  if(!opt){ opt=document.createElement('option'); opt.value=m; opt.textContent=m+' (personalizado)'; sel.insertBefore(opt, sel.lastChild); }
  sel.value = m;
}

function newConv(){
  activeId = 'c'+Date.now();
  getConv(activeId);
  renderActive();
  refreshStopMode();
  loadConvList();
}

document.getElementById('btn-newconv').addEventListener('click', newConv);
document.getElementById('btn-toggle').addEventListener('click', ()=>{
  document.getElementById('sidebar').classList.toggle('hidden');
});
renderActive();
loadConvList();

function setCwd(p){ if(p){ cwdEl.textContent = p; cwdEl.title = p; } }

fetch('/api/state').then(r=>r.json()).then(s=>setCwd(s.cwd)).catch(()=>{});

document.getElementById('btn-folder').addEventListener('click', async ()=>{
  cwdEl.textContent = 'Abriendo selector…';
  try{
    const r = await fetch('/api/pickfolder');
    const j = await r.json();
    setCwd(j.cwd);
    if(j.path){ const h='Carpeta cambiada a <code>'+esc(j.path)+'</code>.'; const c=getConv(activeId); c.messages.push({role:'bot',html:h}); renderActive(); persistConv(activeId); }
  }catch(e){ setCwd('~'); }
});

// Selector de modelo
const modelSel = document.getElementById('model-sel');
if (modelSel) {
  fetch('/api/models').then(r=>r.json()).then(d=>{
    modelSel.innerHTML='';
    d.models.forEach(m=>{
      const o=document.createElement('option');
      o.value=m.id; o.textContent=m.name;
      modelSel.appendChild(o);
      if(m.id==='azure') hasAzure = true;
    });
    reflectModel(); // mostrar el modelo de la conversación activa
  }).catch(()=>{});

  let lastModel = null;
  modelSel.addEventListener('focus', ()=>{ lastModel = modelSel.value; });
  modelSel.addEventListener('change', ()=>{
    let id = modelSel.value;
    if(id==='__custom__'){
      const typed = (prompt('Escribe el ID del modelo (ej: claude-sonnet-5):','claude-sonnet-5')||'').trim();
      if(!typed){ if(lastModel) modelSel.value=lastModel; return; }
      let opt=[...modelSel.options].find(o=>o.value===typed);
      if(!opt){ opt=document.createElement('option'); opt.value=typed; opt.textContent=typed+' (personalizado)'; modelSel.insertBefore(opt, modelSel.lastChild); }
      opt.selected=true; id=typed;
    }
    // Guardar el modelo EN LA CONVERSACIÓN activa (no global).
    const c = getConv(activeId);
    c.model = id;
    const h='Modelo de esta conversación: <code>'+esc(modelSel.options[modelSel.selectedIndex].text)+'</code>.';
    c.messages.push({role:'bot',html:h}); renderActive(); persistConv(activeId);
  });
}

function autoGrow(){ input.style.height='auto'; input.style.height=Math.min(Math.max(input.scrollHeight,88),280)+'px'; }
input.addEventListener('input', autoGrow);
input.addEventListener('keydown', (e)=>{
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); composer.requestSubmit(); }
});

let pendingImages=[]; // imágenes adjuntas al mensaje que se está redactando

function enqueue(msg, images){
  const id = activeId;               // capturamos la conversación destino
  const c = getConv(id);
  const imgHtml = (images&&images.length) ? images.map(im=>`<img src="${im}" style="max-width:160px;max-height:120px;border-radius:8px;margin:4px 4px 0 0;border:1px solid #33335a;">`).join('') : '';
  const userHtml = renderMd(msg) + (imgHtml?('<div>'+imgHtml+'</div>'):'');
  c.messages.push({role:'user', html:userHtml});
  if(id===activeId) addMsg('user', userHtml, c.messages.length-1);
  persistConv(id);
  maybeSuggestAzure(c, msg);
  c.queue.push({msg, images: images||[]});
  if(!c.busy) drainConv(id);
}

// ===== Sugerencia inteligente: usar Azure cuando solo se chatea =====
let hasAzure = false;
let azureSuggestDismissed = false;
function looksLikeExecution(msg){
  return /\b(crea|cre[aá]|edita|modifica|arregla|corrige|ejecuta|corre|instala|despliega|refactor|agrega|a[ñn]ade|borra|elimina|archivo|carpeta|comando|script|c[oó]digo|bug|error|compila|build|test|prueba|git|deploy)\b/i.test(msg||'')
    || /@[\w./\\-]+/.test(msg||'');
}
function maybeSuggestAzure(c, msg){
  if(azureSuggestDismissed || !hasAzure) return;
  const model = c.model || 'auto';
  if(model === 'azure' || model === 'azure-gpt-5-mini') return;
  const userMsgs = c.messages.filter(m=>m.role==='user');
  if(userMsgs.length < 2) return;
  const recent = userMsgs.slice(-3).map(m=>m.html.replace(/<[^>]+>/g,''));
  if(recent.some(looksLikeExecution) || looksLikeExecution(msg)) return;
  showAzureSuggestion();
}
function showAzureSuggestion(){
  if(document.getElementById('azure-suggest')) return;
  const bar = document.createElement('div');
  bar.id = 'azure-suggest';
  bar.style.cssText='position:fixed;top:58px;left:50%;transform:translateX(-50%);background:#0e1a2a;border:1px solid #26e0ff;color:#e8e8f0;padding:10px 14px;border-radius:12px;font-size:12.5px;z-index:60;box-shadow:0 4px 20px rgba(38,224,255,.35);max-width:80%;display:flex;gap:10px;align-items:center;';
  bar.innerHTML='💡 Parece que solo chateas. <b style="color:#26e0ff">Azure gpt-5-mini</b> es casi gratis para esto. <button id="az-switch" style="background:linear-gradient(135deg,#26e0ff,#b026ff);border:none;color:#fff;border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12px;">Cambiar</button> <span id="az-dismiss" style="cursor:pointer;color:#8a8aa0;">✕</span>';
  document.body.appendChild(bar);
  document.getElementById('az-switch').onclick=()=>{
    const sel=document.getElementById('model-sel');
    if(sel){ sel.value='azure'; sel.dispatchEvent(new Event('change')); }
    bar.remove();
  };
  document.getElementById('az-dismiss').onclick=()=>{ azureSuggestDismissed=true; bar.remove(); };
  setTimeout(()=>{ if(bar.parentNode) bar.remove(); }, 12000);
}

async function drainConv(id){
  const c = getConv(id);
  c.busy = true; loadConvList(); refreshStopMode();
  while(c.queue.length){
    const item = c.queue.shift();
    await runOne(id, item.msg, item.images);
  }
  c.busy = false; loadConvList(); refreshStopMode();
}

async function runOne(id, msg, images){
  const c = getConv(id);
  // Crear el mensaje de respuesta en el modelo de datos y (si visible) en el DOM.
  const botIdx = c.messages.length;
  c.messages.push({role:'bot', html:'<span class="working"><span class="wheel"></span> Trabajando…</span>'});
  if(id===activeId) addMsg('bot', c.messages[botIdx].html, botIdx);
  showWorking(true);
  let acc='';
  const abort = new AbortController();
  c.aborts.add(abort);
  refreshStopMode();
  const setHtml = (html)=>{ c.messages[botIdx].html = html; updateBubble(id, botIdx, html); };
  // Para Azure (sin sesión server-side), enviamos historial reciente como contexto.
  const history = [];
  if(c.model==='azure' || c.model==='azure-gpt-5-mini'){
    const prev = c.messages.slice(Math.max(0, botIdx-12), botIdx);
    for(const m of prev){
      const text = m.html.replace(/<[^>]+>/g,'').trim();
      if(text && text!=='') history.push({ role: m.role==='user'?'user':'assistant', content: text });
    }
  }
  try{
    const resp = await fetch('/api/chat', {
      method:'POST', headers:{'Content-Type':'application/json'},
      signal: abort.signal,
      body: JSON.stringify({ message: msg, images: images||[], sessionId: c.session || '', convId: id, model: c.model || '', history: history })
    });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf='';
    while(true){
      const {value, done} = await reader.read();
      if(done) break;
      buf += dec.decode(value, {stream:true});
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for(const p of parts){
        const ev = /event: (\w+)/.exec(p);
        const dm = /data: ([\s\S]*)/.exec(p);
        if(!ev || !dm) continue;
        const type = ev[1];
        let data; try{ data = JSON.parse(dm[1]); }catch(_){ data = dm[1]; }
        if(type==='chunk'){ acc += data; setHtml(renderMd(acc)); }
        else if(type==='session'){ if(data && data.id){ c.session = data.id; } }
        else if(type==='memory'){ if(data && data.text) showMemoryChip(data.text); }
        else if(type==='usage'){ if(data) updateUsage(data); }
        else if(type==='error'){ acc += '\n⚠️ '+data; setHtml(renderMd(acc)); }
      }
    }
    if(!acc.trim()) setHtml('<em style="color:#8a8aa0">(sin respuesta)</em>');
    else { setHtml(renderMd(acc)); if(id===activeId) speak(acc); }
    persistConv(id);
  }catch(err){
    if(err.name==='AbortError'){
      setHtml(renderMd(acc) + '<div style="color:#8a8aa0;font-size:12px;margin-top:6px;">⏹ Detenido</div>');
    } else {
      setHtml('⚠️ Error de conexión: '+esc(err.message));
    }
    persistConv(id);
  }finally{
    c.aborts.delete(abort);
    refreshStopMode();
    // Ocultar la rueda global si ninguna conversación sigue trabajando.
    const anyBusy = Object.keys(convData).some(k=>convData[k].aborts && convData[k].aborts.size>0);
    if(!anyBusy) showWorking(false);
  }
}

// Rueda de carga global (barra superior) mientras HanstlerS trabaja.
function showWorking(on){
  let bar = document.getElementById('working-bar');
  if(on){
    if(!bar){
      bar = document.createElement('div');
      bar.id = 'working-bar';
      bar.innerHTML = '<span class="wheel"></span> HanstlerS está trabajando…';
      document.body.appendChild(bar);
    }
    bar.style.display = 'flex';
  } else if(bar){ bar.style.display = 'none'; }
}

// El botón de enviar se vuelve "detener" si la conversación ACTIVA está trabajando.
function refreshStopMode(){
  const c = convData[activeId];
  const on = !!(c && c.aborts && c.aborts.size>0);
  sendBtn.textContent = on ? '⏹' : '➤';
  sendBtn.title = on ? 'Detener' : 'Enviar';
  sendBtn.classList.toggle('stopping', on);
}

// Aviso discreto de "memoria guardada" (se auto-oculta).
function showMemoryChip(text){
  let chip = document.getElementById('mem-chip');
  if(!chip){
    chip = document.createElement('div');
    chip.id = 'mem-chip';
    chip.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#1a1030;border:1px solid #b026ff;color:#e8e8f0;padding:8px 14px;border-radius:20px;font-size:12.5px;z-index:60;box-shadow:0 4px 20px rgba(176,38,255,.4);max-width:70%;';
    document.body.appendChild(chip);
  }
  chip.textContent = '🧠 Recordaré: ' + text;
  chip.style.display = 'block';
  clearTimeout(chip._t);
  chip._t = setTimeout(()=>{ chip.style.display='none'; }, 4000);
}

// Medidor de consumo: muestra créditos restantes del plan (cuota − gastado).
function renderQuota(q){
  const el = document.getElementById('usage-meter');
  if(!el || !q) return;
  const planName = q.plan==='pro+'||q.plan==='proplus' ? 'Pro+' : (q.plan.charAt(0).toUpperCase()+q.plan.slice(1));
  el.textContent = '◈ ' + q.remaining + ' / ' + q.total + ' · ' + planName;
  el.title = 'Créditos restantes este mes: ' + q.remaining + ' de ' + q.total + ' (' + planName + '). Gastado: ' + q.spent + '. Reinicia el 1º de cada mes.';
}
function updateUsage(u){
  if(u.quota) renderQuota(u.quota);
  else if(typeof u.credits === 'number'){ fetch('/api/quota').then(r=>r.json()).then(renderQuota).catch(()=>{}); }
}
// Cargar la cuota al iniciar.
fetch('/api/quota').then(r=>r.json()).then(renderQuota).catch(()=>{});

composer.addEventListener('submit', (e)=>{
  e.preventDefault();
  // Si la conversación activa tiene una respuesta en curso, detenerla.
  const c = convData[activeId];
  if(c && c.aborts && c.aborts.size>0){ c.aborts.forEach(a=>{ try{a.abort();}catch(_){}}); return; }
  const msg = input.value.trim();
  const imgs = pendingImages.slice();
  if(!msg && !imgs.length) return;
  input.value=''; autoGrow();
  clearPreview();
  enqueue(msg || '¿Qué ves en esta imagen?', imgs);
  input.focus();
});

/* ===== Adjuntar imágenes: pegar (Ctrl+V) y arrastrar ===== */
function addImage(dataUrl){
  pendingImages.push(dataUrl);
  renderPreview();
}
function clearPreview(){ pendingImages=[]; renderPreview(); }
function renderPreview(){
  let bar=document.getElementById('img-preview');
  if(!bar){
    bar=document.createElement('div');
    bar.id='img-preview';
    bar.style.cssText='display:flex;gap:8px;flex-wrap:wrap;padding:0 18px;max-width:936px;margin:0 auto;width:100%;';
    composer.parentNode.insertBefore(bar, composer);
  }
  bar.innerHTML='';
  pendingImages.forEach((im,idx)=>{
    const w=document.createElement('div');
    w.style.cssText='position:relative;';
    w.innerHTML=`<img src="${im}" style="height:56px;border-radius:8px;border:1px solid #33335a;"><span style="position:absolute;top:-6px;right:-6px;background:#ff2668;color:#fff;border-radius:50%;width:18px;height:18px;display:grid;place-items:center;font-size:12px;cursor:pointer;">×</span>`;
    w.querySelector('span').onclick=()=>{ pendingImages.splice(idx,1); renderPreview(); };
    bar.appendChild(w);
  });
  bar.style.display = pendingImages.length ? 'flex' : 'none';
}
function fileToDataUrl(file){
  return new Promise((resolve)=>{ const r=new FileReader(); r.onload=()=>resolve(r.result); r.readAsDataURL(file); });
}

document.addEventListener('paste', async (e)=>{
  const items = (e.clipboardData||{}).items || [];
  for(const it of items){
    if(it.type && it.type.startsWith('image/')){
      const f=it.getAsFile();
      if(f){ addImage(await fileToDataUrl(f)); e.preventDefault(); }
    }
  }
});
['dragover','drop'].forEach(ev=>document.addEventListener(ev,(e)=>{ e.preventDefault(); }));
document.addEventListener('drop', async (e)=>{
  const files = (e.dataTransfer||{}).files || [];
  for(const f of files){ if(f.type.startsWith('image/')) addImage(await fileToDataUrl(f)); }
});

input.focus();

/* ============ VOZ: dictado (Azure Speech o navegador) y lectura (TTS) ============ */
const micBtn = document.getElementById('btn-mic');
const speakBtn = document.getElementById('btn-speak');

let speechAvailable = false;
fetch('/api/speech/available').then(r=>r.json()).then(d=>{ speechAvailable = !!d.available; }).catch(()=>{});

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, listening = false;
let mediaRec = null, audioCtx = null, recStream = null, recProcessor = null, recData = [], recSampleRate = 16000;

// --- Dictado con Azure Speech (graba PCM 16kHz y transcribe en el servidor) ---
async function startAzureDictation(){
  try{
    recStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount:1, sampleRate:16000 } });
  }catch(err){
    setStatusMic('🎤 Permiso de micrófono denegado. Actívalo en el candado 🔒 de la barra.');
    return;
  }
  audioCtx = new (window.AudioContext||window.webkitAudioContext)({ sampleRate: 16000 });
  recSampleRate = audioCtx.sampleRate;
  const source = audioCtx.createMediaStreamSource(recStream);
  recProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
  recData = [];
  recProcessor.onaudioprocess = (e)=>{
    const ch = e.inputBuffer.getChannelData(0);
    recData.push(new Float32Array(ch));
  };
  source.connect(recProcessor);
  recProcessor.connect(audioCtx.destination);
  listening = true; micBtn.classList.add('listening'); setStatusMic('🎙️ Escuchando… pulsa de nuevo para terminar');
}

async function stopAzureDictation(){
  micBtn.classList.remove('listening'); listening = false;
  try{ if(recProcessor) recProcessor.disconnect(); }catch(_){}
  try{ if(recStream) recStream.getTracks().forEach(t=>t.stop()); }catch(_){}
  try{ if(audioCtx) await audioCtx.close(); }catch(_){}
  if(!recData.length){ setStatusMic('No se grabó audio.'); return; }
  setStatusMic('Transcribiendo…');
  const wav = encodeWav(recData, recSampleRate);
  recData = [];
  try{
    const r = await fetch('/api/transcribe', { method:'POST', headers:{'Content-Type':'audio/wav'}, body: wav });
    const j = await r.json();
    if(j.text){ input.value = (input.value ? input.value+' ' : '') + j.text; autoGrow(); setStatusMic('✔ '+j.text); }
    else setStatusMic('No te entendí: ' + (j.error||'intenta de nuevo'));
  }catch(err){ setStatusMic('Error al transcribir: '+err.message); }
}

// Codifica Float32 mono a WAV PCM16 (con remuestreo a 16kHz si hace falta).
function encodeWav(chunks, sampleRate){
  let len = 0; chunks.forEach(c=>len+=c.length);
  let data = new Float32Array(len); let off=0;
  chunks.forEach(c=>{ data.set(c, off); off+=c.length; });
  // Remuestrear a 16000 si el contexto usó otra tasa
  const target = 16000;
  if(sampleRate !== target){
    const ratio = sampleRate/target;
    const newLen = Math.round(data.length/ratio);
    const res = new Float32Array(newLen);
    for(let i=0;i<newLen;i++){ res[i] = data[Math.floor(i*ratio)]; }
    data = res;
  }
  const buffer = new ArrayBuffer(44 + data.length*2);
  const view = new DataView(buffer);
  const ws=(o,s)=>{ for(let i=0;i<s.length;i++) view.setUint8(o+i, s.charCodeAt(i)); };
  ws(0,'RIFF'); view.setUint32(4, 36+data.length*2, true); ws(8,'WAVE'); ws(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,target,true); view.setUint32(28,target*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
  ws(36,'data'); view.setUint32(40, data.length*2, true);
  let o=44;
  for(let i=0;i<data.length;i++){ let s=Math.max(-1,Math.min(1,data[i])); view.setInt16(o, s<0?s*0x8000:s*0x7FFF, true); o+=2; }
  return buffer;
}

// --- Fallback: reconocimiento del navegador ---
function setupBrowserRecog(){
  recog = new SR();
  recog.lang = 'es-ES';
  recog.interimResults = true;
  recog.continuous = false;
  let baseText = '';
  recog.onstart = () => { listening = true; micBtn.classList.add('listening'); setStatusMic('Escuchando… habla ahora'); };
  recog.onerror = (e) => {
    const m = { 'not-allowed':'Permiso de micrófono denegado.', 'no-speech':'No te escuché.', 'audio-capture':'No se detectó micrófono.', 'network':'El dictado del navegador necesita internet.' };
    setStatusMic('🎤 ' + (m[e.error] || ('Error de voz: ' + e.error)));
    stopListen();
  };
  recog.onend = () => stopListen();
  recog.onresult = (e) => {
    let txt=''; for(let i=e.resultIndex;i<e.results.length;i++) txt+=e.results[i][0].transcript;
    input.value=(baseText+' '+txt).trim(); autoGrow();
  };
  micBtn._base = () => baseText = input.value.trim();
}

micBtn.addEventListener('click', async () => {
  // Preferir Azure Speech (funciona en la app nativa). Fallback: navegador.
  if (speechAvailable) {
    if (listening) { await stopAzureDictation(); } else { await startAzureDictation(); }
    return;
  }
  if (!SR) { setStatusMic('El dictado no está disponible.'); return; }
  if (!recog) setupBrowserRecog();
  if (listening) { recog.stop(); return; }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t=>t.stop());
  } catch (err) { setStatusMic('🎤 Permiso de micrófono denegado.'); return; }
  micBtn._base && micBtn._base();
  try { recog.start(); } catch (_) {}
});

function stopListen(){ listening = false; micBtn.classList.remove('listening'); }

function setStatusMic(text){
  let bar = document.getElementById('mic-status');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'mic-status';
    bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:82px;background:#1a1a2a;border:1px solid #33335a;color:#e8e8f0;padding:8px 14px;border-radius:10px;font-size:13px;z-index:50;max-width:80%;box-shadow:0 4px 20px rgba(0,0,0,.5);';
    document.body.appendChild(bar);
  }
  bar.textContent = text;
  bar.style.display = 'block';
  clearTimeout(bar._t);
  bar._t = setTimeout(() => { bar.style.display = 'none'; }, 6000);
}

let speakOn = false;
speakBtn.addEventListener('click', () => {
  speakOn = !speakOn;
  speakBtn.classList.toggle('on', speakOn);
  speakBtn.textContent = speakOn ? '🔊' : '🔈';
  if (!speakOn && window.speechSynthesis) window.speechSynthesis.cancel();
});

function speak(text){
  if (!speakOn || !window.speechSynthesis) return;
  const clean = text.replace(/```[\s\S]*?```/g, ' bloque de código. ').replace(/`([^`]+)`/g, '$1').trim();
  if (!clean) return;
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'es-ES'; u.rate = 1.05;
  const v = window.speechSynthesis.getVoices().find(x => x.lang && x.lang.startsWith('es'));
  if (v) u.voice = v;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}
