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
  if(!convData[id]) convData[id] = { title:'Nueva conversación', messages:[], session:null, queue:[], busy:false, aborts:new Set() };
  return convData[id];
}

function persistConv(id){
  const c = convData[id]; if(!c || !c.messages.length) return;
  if(c.title==='Nueva conversación'){
    const fu = c.messages.find(m=>m.role==='user');
    if(fu){ const t=fu.html.replace(/<[^>]+>/g,'').trim(); c.title = t.slice(0,40) || 'Conversación'; }
  }
  fetch('/api/conv/save', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ id, title:c.title, messages:c.messages, session:c.session })})
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
      convData[id] = { title:c.title||'Conversación', messages:c.messages||[], session:c.session||null, queue:[], busy:false, aborts:new Set() };
    }
    activeId = id;
    renderActive();
    refreshStopMode();
    loadConvList();
  }catch(e){}
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
    let found=false;
    d.models.forEach(m=>{
      const o=document.createElement('option');
      o.value=m.id; o.textContent=m.name;
      if(m.id===d.current){ o.selected=true; found=true; }
      modelSel.appendChild(o);
    });
    // Si el modelo actual es uno personalizado no listado, añadirlo
    if(!found && d.current){
      const o=document.createElement('option');
      o.value=d.current; o.textContent=d.current+' (personalizado)';
      o.selected=true;
      modelSel.insertBefore(o, modelSel.lastChild);
    }
  }).catch(()=>{});

  let lastModel = null;
  modelSel.addEventListener('focus', ()=>{ lastModel = modelSel.value; });
  modelSel.addEventListener('change', ()=>{
    let id = modelSel.value;
    if(id==='__custom__'){
      const typed = (prompt('Escribe el ID del modelo (ej: claude-opus-4.8):','claude-opus-4.8')||'').trim();
      if(!typed){ if(lastModel) modelSel.value=lastModel; return; }
      // Añadir/seleccionar la opción personalizada
      let opt=[...modelSel.options].find(o=>o.value===typed);
      if(!opt){ opt=document.createElement('option'); opt.value=typed; opt.textContent=typed+' (personalizado)'; modelSel.insertBefore(opt, modelSel.lastChild); }
      opt.selected=true; id=typed;
    }
    fetch('/api/model', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({model: id})})
      .then(()=>{ const h='Modelo cambiado a <code>'+esc(modelSel.options[modelSel.selectedIndex].text)+'</code>.'; const c=getConv(activeId); c.messages.push({role:'bot',html:h}); renderActive(); persistConv(activeId); });
  });
}

function autoGrow(){ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,180)+'px'; }
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
  c.queue.push({msg, images: images||[]});
  if(!c.busy) drainConv(id);
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
  c.messages.push({role:'bot', html:'<span class="typing"><span></span><span></span><span></span></span>'});
  if(id===activeId) addMsg('bot', c.messages[botIdx].html, botIdx);
  let acc='';
  const abort = new AbortController();
  c.aborts.add(abort);
  refreshStopMode();
  const setHtml = (html)=>{ c.messages[botIdx].html = html; updateBubble(id, botIdx, html); };
  try{
    const resp = await fetch('/api/chat', {
      method:'POST', headers:{'Content-Type':'application/json'},
      signal: abort.signal,
      body: JSON.stringify({ message: msg, images: images||[], sessionId: c.session || '', convId: id })
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
  }
}

// El botón de enviar se vuelve "detener" si la conversación ACTIVA está trabajando.
function refreshStopMode(){
  const c = convData[activeId];
  const on = !!(c && c.aborts && c.aborts.size>0);
  sendBtn.textContent = on ? '⏹' : '➤';
  sendBtn.title = on ? 'Detener' : 'Enviar';
  sendBtn.classList.toggle('stopping', on);
}

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

/* ============ VOZ: dictado (STT) y lectura (TTS) ============ */
const micBtn = document.getElementById('btn-mic');
const speakBtn = document.getElementById('btn-speak');

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, listening = false;

if (SR) {
  recog = new SR();
  recog.lang = 'es-ES';
  recog.interimResults = true;
  recog.continuous = false;
  let baseText = '';

  recog.onstart = () => { listening = true; micBtn.classList.add('listening'); setStatusMic('Escuchando… habla ahora'); };
  recog.onerror = (e) => {
    const m = {
      'not-allowed': 'Permiso de micrófono denegado. Haz clic en el candado 🔒 de la barra y permite el micrófono.',
      'service-not-allowed': 'El reconocimiento de voz está bloqueado. Permite el micrófono para este sitio.',
      'no-speech': 'No te escuché. Intenta de nuevo.',
      'audio-capture': 'No se detectó micrófono. Conecta uno y reintenta.',
      'network': 'El dictado necesita conexión a internet.'
    };
    setStatusMic('🎤 ' + (m[e.error] || ('Error de voz: ' + e.error)));
    stopListen();
  };
  recog.onend = () => stopListen();
  recog.onresult = (e) => {
    let txt = '';
    for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
    input.value = (baseText + ' ' + txt).trim();
    autoGrow();
  };

  micBtn.addEventListener('click', async () => {
    if (listening) { recog.stop(); return; }
    // Pedir permiso de micrófono explícitamente (mejora el prompt en modo app).
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
      }
    } catch (err) {
      setStatusMic('🎤 Permiso de micrófono denegado. Actívalo en el candado 🔒 de la barra.');
      return;
    }
    baseText = input.value.trim();
    try { recog.start(); } catch (_) {}
  });
} else {
  micBtn.disabled = true;
  micBtn.title = 'Tu navegador no soporta dictado por voz';
  micBtn.style.opacity = .4;
}

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
