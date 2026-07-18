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

function addMsg(role, html){
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  wrap.innerHTML = `<div class="avatar">${role==='bot'?'H':'Tú'}</div><div class="bubble">${html}</div>`;
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return wrap.querySelector('.bubble');
}

// ===== Historial de conversaciones =====
let convId = 'c' + Date.now();
let convTitle = 'Nueva conversación';
let convMsgs = []; // {role, html}
let convSession = null; // session id real del CLI para esta conversación
const WELCOME = '¡Hola! Soy <strong>HanstlerS</strong>. Elige tu carpeta de proyecto arriba y dime en qué trabajamos. Puedo leer y editar archivos, ejecutar comandos y usar tu agente <code>hanstler-dev</code>.';

function recordMsg(role, html){ convMsgs.push({role, html}); persistConv(); }
function persistConv(){
  if(!convMsgs.length) return;
  if(convTitle==='Nueva conversación'){
    const firstUser = convMsgs.find(m=>m.role==='user');
    if(firstUser){ const t=firstUser.html.replace(/<[^>]+>/g,'').trim(); convTitle = t.slice(0,40) || 'Conversación'; }
  }
  fetch('/api/conv/save', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ id: convId, title: convTitle, messages: convMsgs, session: convSession })})
    .then(()=>loadConvList()).catch(()=>{});
}

async function loadConvList(){
  try{
    const r = await fetch('/api/conv/list'); const j = await r.json();
    const box = document.getElementById('conv-list'); box.innerHTML='';
    (j.items||[]).forEach(it=>{
      const el = document.createElement('div');
      el.className = 'conv-item' + (it.id===convId?' active':'');
      el.innerHTML = `<span class="t" title="${esc(it.title)}">${esc(it.title)}</span><span class="ren" title="Renombrar">✏️</span><span class="del" title="Borrar">🗑</span>`;
      el.querySelector('.t').onclick = ()=> openConv(it.id);
      el.querySelector('.ren').onclick = async (e)=>{ e.stopPropagation();
        const nn = (prompt('Nuevo nombre de la conversación:', it.title)||'').trim();
        if(!nn) return;
        await fetch('/api/conv/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:it.id,title:nn})});
        if(it.id===convId) convTitle=nn;
        loadConvList();
      };
      el.querySelector('.del').onclick = async (e)=>{ e.stopPropagation();
        await fetch('/api/conv/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:it.id})});
        if(it.id===convId) newConv(); else loadConvList();
      };
      box.appendChild(el);
    });
  }catch(e){}
}

async function openConv(id){
  try{
    const r = await fetch('/api/conv/get?id='+encodeURIComponent(id)); const c = await r.json();
    if(!c || c.error) return;
    convId=c.id; convTitle=c.title||'Conversación'; convMsgs=c.messages||[]; convSession=c.session||null;
    chat.innerHTML='';
    convMsgs.forEach(m=> addMsg(m.role, m.html));
    loadConvList();
  }catch(e){}
}

function newConv(){
  convId='c'+Date.now(); convTitle='Nueva conversación'; convMsgs=[]; convSession=null;
  chat.innerHTML=''; addMsg('bot', WELCOME);
  loadConvList();
}

document.getElementById('btn-newconv').addEventListener('click', newConv);
document.getElementById('btn-toggle').addEventListener('click', ()=>{
  document.getElementById('sidebar').classList.toggle('hidden');
});
loadConvList();

function setCwd(p){ if(p){ cwdEl.textContent = p; cwdEl.title = p; } }

fetch('/api/state').then(r=>r.json()).then(s=>setCwd(s.cwd)).catch(()=>{});

document.getElementById('btn-folder').addEventListener('click', async ()=>{
  cwdEl.textContent = 'Abriendo selector…';
  try{
    const r = await fetch('/api/pickfolder');
    const j = await r.json();
    setCwd(j.cwd);
    if(j.path){ const h='Carpeta cambiada a <code>'+esc(j.path)+'</code>.'; addMsg('bot', h); recordMsg('bot', h); }
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
      .then(()=> addMsg('bot', 'Modelo cambiado a <code>'+esc(modelSel.options[modelSel.selectedIndex].text)+'</code>.'));
  });
}

function autoGrow(){ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,180)+'px'; }
input.addEventListener('input', autoGrow);
input.addEventListener('keydown', (e)=>{
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); composer.requestSubmit(); }
});

let processing=false;
const queue=[];
let pendingImages=[]; // imágenes adjuntas al mensaje que se está redactando

function enqueue(msg, images){
  const imgHtml = (images&&images.length) ? images.map(im=>`<img src="${im}" style="max-width:160px;max-height:120px;border-radius:8px;margin:4px 4px 0 0;border:1px solid #33335a;">`).join('') : '';
  const userHtml = renderMd(msg) + (imgHtml?('<div>'+imgHtml+'</div>'):'');
  addMsg('user', userHtml);
  recordMsg('user', userHtml);
  queue.push({msg, images: images||[]});
  updatePending();
  if(!processing) drainQueue();
}

function updatePending(){
  let tag=document.getElementById('pending');
  const n=queue.length;
  if(n>0){
    if(!tag){
      tag=document.createElement('div');
      tag.id='pending';
      tag.style.cssText='position:fixed;right:16px;bottom:82px;background:#1a1a2a;border:1px solid #33335a;color:#8a8aa0;padding:5px 10px;border-radius:8px;font-size:12px;z-index:40;';
      document.body.appendChild(tag);
    }
    tag.textContent='🕓 '+n+' en cola';
    tag.style.display='block';
  } else if(tag){ tag.style.display='none'; }
}

async function drainQueue(){
  processing=true;
  while(queue.length){
    const item=queue.shift();
    updatePending();
    await runOne(item.msg, item.images);
  }
  processing=false;
}

let currentAbort = null;

async function runOne(msg, images){
  const bubble = addMsg('bot', '<span class="typing"><span></span><span></span><span></span></span>');
  let acc='';
  currentAbort = new AbortController();
  setStopMode(true);
  try{
    const resp = await fetch('/api/chat', {
      method:'POST', headers:{'Content-Type':'application/json'},
      signal: currentAbort.signal,
      body: JSON.stringify({ message: msg, images: images||[], sessionId: convSession || '', convId: convId })
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
        if(type==='chunk'){ acc += data; bubble.innerHTML = renderMd(acc); chat.scrollTop=chat.scrollHeight; }
        else if(type==='session'){ if(data && data.id){ convSession = data.id; } }
        else if(type==='error'){ acc += '\n⚠️ '+data; bubble.innerHTML = renderMd(acc); }
      }
    }
    if(!acc.trim()){ bubble.innerHTML = '<em style="color:#8a8aa0">(sin respuesta)</em>'; recordMsg('bot', bubble.innerHTML); }
    else { recordMsg('bot', bubble.innerHTML); speak(acc); }
  }catch(err){
    if(err.name==='AbortError'){
      bubble.innerHTML = renderMd(acc) + '<div style="color:#8a8aa0;font-size:12px;margin-top:6px;">⏹ Detenido</div>';
      if(acc.trim()) recordMsg('bot', bubble.innerHTML);
    } else {
      bubble.innerHTML = '⚠️ Error de conexión: '+esc(err.message);
      recordMsg('bot', bubble.innerHTML);
    }
  }finally{
    currentAbort = null;
    setStopMode(false);
  }
}

function setStopMode(on){
  sendBtn.textContent = on ? '⏹' : '➤';
  sendBtn.title = on ? 'Detener' : 'Enviar';
  sendBtn.classList.toggle('stopping', on);
}

composer.addEventListener('submit', (e)=>{
  e.preventDefault();
  // Si hay una respuesta en curso, el botón funciona como "detener".
  if(currentAbort){ try{ currentAbort.abort(); }catch(_){}; return; }
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
