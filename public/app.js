'use strict';
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const composer = document.getElementById('composer');
const sendBtn = document.getElementById('send');
const cwdEl = document.getElementById('cwd');

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// Modal de texto (Electron NO soporta window.prompt). Devuelve el texto o null.
function askText(message, def){
  return new Promise((resolve)=>{
    const ov=document.createElement('div');
    ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:200;display:flex;align-items:center;justify-content:center;';
    ov.innerHTML='<div style="background:#141422;border:1px solid var(--neon,#b026ff);border-radius:12px;padding:18px;width:min(90%,420px);box-shadow:0 8px 30px rgba(0,0,0,.6);">'
      +'<div style="color:#e8e8f0;font-size:14px;margin-bottom:10px;">'+esc(message)+'</div>'
      +'<input type="text" class="ask-in" style="width:100%;box-sizing:border-box;background:#0e0e18;border:1px solid #33335a;color:#e8e8f0;border-radius:8px;padding:8px 10px;font-size:14px;outline:none;">'
      +'<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">'
      +'<button class="ask-no" style="background:#26263a;color:#e8e8f0;border:none;border-radius:8px;padding:7px 14px;cursor:pointer;">Cancelar</button>'
      +'<button class="ask-ok" style="background:linear-gradient(135deg,#26e0ff,#b026ff);color:#fff;border:none;border-radius:8px;padding:7px 14px;cursor:pointer;font-weight:600;">Aceptar</button>'
      +'</div></div>';
    document.body.appendChild(ov);
    const inp=ov.querySelector('.ask-in'); inp.value=def||''; inp.focus(); inp.select();
    let done=false;
    const close=(val)=>{ if(done) return; done=true; ov.remove(); resolve(val); };
    ov.querySelector('.ask-ok').onclick=()=>close(inp.value);
    ov.querySelector('.ask-no').onclick=()=>close(null);
    ov.onclick=(e)=>{ if(e.target===ov) close(null); };
    inp.onkeydown=(e)=>{ if(e.key==='Enter'){e.preventDefault();close(inp.value);} else if(e.key==='Escape'){e.preventDefault();close(null);} };
  });
}

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
  if(!convData[id]) convData[id] = { title:'Nueva conversación', messages:[], session:null, model:null, queue:[], busy:false, aborts:new Set(), live:null };
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
    const q = (document.getElementById('conv-search')?.value||'').trim().toLowerCase();
    (j.items||[]).filter(it=> !q || (it.title||'').toLowerCase().includes(q)).forEach(it=>{
      const busy = convData[it.id] && convData[it.id].busy;
      const el = document.createElement('div');
      el.className = 'conv-item' + (it.id===activeId?' active':'');
      el.innerHTML = `<span class="t" title="${esc(it.title)}">${busy?'<span class="spin">●</span> ':''}${esc(it.title)}</span><span class="ren" title="Renombrar"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></span><span class="del" title="Borrar"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></span>`;
      el.querySelector('.t').onclick = ()=> openConv(it.id);
      el.querySelector('.ren').onclick = (e)=>{ e.stopPropagation();
        // Edición EN LÍNEA (Electron no soporta prompt()).
        const span = el.querySelector('.t');
        const inp = document.createElement('input');
        inp.type='text'; inp.value = it.title; inp.className='ren-input';
        inp.style.cssText='flex:1;min-width:0;background:#0e0e18;border:1px solid var(--neon);color:var(--text);border-radius:6px;padding:3px 6px;font-size:13px;outline:none;';
        span.replaceWith(inp);
        inp.focus(); inp.select();
        let doneRen=false;
        const commit = async (save)=>{
          if(doneRen) return; doneRen=true;
          const nn=(inp.value||'').trim();
          if(save && nn && nn!==it.title){
            try{ await fetch('/api/conv/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:it.id,title:nn})}); }catch(_){}
            if(convData[it.id]) convData[it.id].title=nn;
          }
          loadConvList();
        };
        inp.onkeydown=(ev)=>{ if(ev.key==='Enter'){ ev.preventDefault(); commit(true); } else if(ev.key==='Escape'){ ev.preventDefault(); commit(false); } };
        inp.onblur=()=> commit(true);
        inp.onclick=(ev)=> ev.stopPropagation();
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
  modelSel.addEventListener('change', async ()=>{
    let id = modelSel.value;
    if(id==='__custom__'){
      const typed = (await askText('Escribe el ID del modelo (ej: claude-sonnet-5):','claude-sonnet-5')||'').trim();
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

function enqueue(msg, images, files){
  const id = activeId;               // capturamos la conversación destino
  const c = getConv(id);
  const imgHtml = (images&&images.length) ? images.map(im=>`<img src="${im}" style="max-width:160px;max-height:120px;border-radius:8px;margin:4px 4px 0 0;border:1px solid #33335a;">`).join('') : '';
  const fileHtml = (files&&files.length) ? '<div style="margin-top:4px;">'+files.map(f=>`<span style="display:inline-block;background:#1a2438;border:1px solid #33335a;border-radius:8px;padding:3px 8px;margin:2px 4px 0 0;font-size:12px;">📄 ${f.name}</span>`).join('')+'</div>' : '';
  const userHtml = renderMd(msg) + (imgHtml?('<div>'+imgHtml+'</div>'):'') + fileHtml;
  c.messages.push({role:'user', html:userHtml, text:msg});
  if(id===activeId) addMsg('user', userHtml, c.messages.length-1);
  persistConv(id);
  maybeSuggestAzure(c, msg);
  c.queue.push({msg, images: images||[], files: files||[]});
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
    await runOne(id, item.msg, item.images, item.files);
  }
  c.busy = false; loadConvList(); refreshStopMode();
}

async function runOne(id, msg, images, files){
  const c = getConv(id);
  // Crear el mensaje de respuesta en el modelo de datos y (si visible) en el DOM.
  const botIdx = c.messages.length;
  c.messages.push({role:'bot', html:'<span class="working"><span class="wheel"></span> Trabajando…</span>'});
  if(id===activeId) addMsg('bot', c.messages[botIdx].html, botIdx);
  showWorking(true);
  let acc='';
  c.live = { step:0, max:0, status:'', done:0, startedAt:Date.now(), task:(msg||'').slice(0,120) };
  const abort = new AbortController();
  c.aborts.add(abort);
  refreshStopMode();
  const setHtml = (html)=>{ c.messages[botIdx].html = html; updateBubble(id, botIdx, html); };
  let statusLine = '';
  const renderWithStatus = ()=>{
    const base = acc.trim() ? renderMd(acc) : '';
    const st = statusLine ? `<div class="agent-status"><span class="wheel"></span> ${esc(statusLine)}</div>` : (acc.trim()?'':'<span class="working"><span class="wheel"></span> Trabajando…</span>');
    setHtml(base + st);
  };
  // Historial de respaldo para los motores sin sesion en el servidor. Se manda para
  // TODOS los modelos: antes solo se llenaba para los de Azure, asi que cualquier otro
  // motor (Vertex/Gemini) recibia history:[] y arrancaba cada turno sin memoria alguna.
  // Ademas usamos el texto CRUDO del mensaje: rearmarlo desde el HTML de la burbuja
  // perdia el contenido de las herramientas y dejaba al modelo a ciegas.
  const history = [];
  {
    const prev = c.messages.slice(Math.max(0, botIdx-24), botIdx);
    for(const m of prev){
      const raw = (typeof m.text==='string' && m.text.trim()) ? m.text : m.html.replace(/<[^>]+>/g,'').trim();
      if(raw) history.push({ role: m.role==='user'?'user':'assistant', content: raw });
    }
  }
  try{
    const resp = await fetch('/api/chat', {
      method:'POST', headers:{'Content-Type':'application/json'},
      signal: abort.signal,
      body: JSON.stringify({ message: msg, images: images||[], files: files||[], sessionId: c.session || '', convId: id, model: c.model || '', history: history })
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
        if(type==='chunk'){ acc += data; statusLine=''; renderWithStatus(); if(c.live && / ✓/.test(data)) c.live.done++; }
        else if(type==='status'){
          statusLine = (typeof data==='string'?data:''); renderWithStatus();
          if(c.live && statusLine){ const mm=/paso\s+(\d+)\s*\/\s*(\d+)/i.exec(statusLine); if(mm){ c.live.step=+mm[1]; c.live.max=+mm[2]; } c.live.status=statusLine; }
        }
        else if(type==='session'){ if(data && data.id){ c.session = data.id; } }
        else if(type==='memory'){ if(data && data.text) showMemoryChip(data.text); }
        else if(type==='usage'){ if(data) updateUsage(data); }
        else if(type==='confirm'){ if(data && data.id) showDangerConfirm(data); }
        else if(type==='canContinue'){ pendingContinue = id; showContinueButton(id); }
        else if(type==='error'){ acc += '\n⚠️ '+data; statusLine=''; renderWithStatus(); }
      }
    }
    c.messages[botIdx].text = acc;
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
    c.live = null;
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

// ¿El usuario pregunta cómo va la tarea en curso? (no debe cancelar)
function isProgressQuery(t){ return /\b(c[oó]mo\s+(vas|va|va\s+eso|va\s+todo)|qu[eé]\s+(vas\s+haciendo|est[aá]s\s+haciendo|llevas|haces)|cu[aá]nto\s+(falta|te\s+falta|queda)|vas\s+(bien|terminando)|sigues?\s+(ah[ií]|trabajando)|estado|progreso|avance|ya\s+(casi|terminaste|acabaste)|how('?s|\s+is)?\s+it\s+going|status|progress)\b/i.test(t||'');
}
// Muestra un resumen del progreso actual SIN cancelar la tarea; el agente sigue.
function showProgressReply(id, question){
  const c = convData[id]; if(!c) return;
  addMsg('user', renderMd(question), -1);
  const L = c.live;
  let txt;
  if(!L){
    txt = 'Estoy terminando… en un momento te muestro el resultado.';
  }else{
    const secs = Math.round((Date.now()-L.startedAt)/1000);
    const tiempo = secs<60 ? (secs+'s') : (Math.floor(secs/60)+'m '+(secs%60)+'s');
    const pasoTxt = (L.step&&L.max) ? `Paso ${L.step} de ${L.max}` : 'En marcha';
    const faltan = (L.step&&L.max) ? Math.max(0, L.max-L.step) : null;
    const pct = (L.step&&L.max) ? Math.min(99, Math.round(L.step/L.max*100)) : null;
    txt = `⏳ **Sigo trabajando, tranquilo — no cancelo nada.**\n\n`
        + `- ${pasoTxt}${pct!=null?` (~${pct}%)`:''}\n`
        + `- Acciones completadas: **${L.done}**\n`
        + (L.status?`- Ahora mismo: ${L.status.replace(/\(paso.*?\)/,'').trim()||'procesando'}\n`:'')
        + `- Tiempo: ${tiempo}\n`
        + (faltan!=null?`- Faltan como máximo **${faltan}** pasos\n`:'')
        + `\nContinúo y te aviso al terminar.`;
  }
  c.messages.push({role:'bot', html:renderMd(txt)});
  if(id===activeId) addMsg('bot', renderMd(txt), c.messages.length-1);
  persistConv(id);
}

// ===== Confirmación de acciones peligrosas =====
function showDangerConfirm(data){
  const bar = document.createElement('div');
  bar.className = 'danger-confirm';
  bar.innerHTML = `<div class="dc-txt">⚠️ <b>Acción peligrosa</b><br>${esc(data.reason||'')}</div>`
    + `<div class="dc-btns"><button class="dc-yes">Permitir</button><button class="dc-no">Rechazar</button></div>`;
  document.body.appendChild(bar);
  const decide = (approved)=>{
    fetch('/api/agent/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:data.id,approved})}).catch(()=>{});
    bar.remove();
  };
  bar.querySelector('.dc-yes').onclick=()=>decide(true);
  bar.querySelector('.dc-no').onclick=()=>decide(false);
}

// ===== Botón "Continuar" cuando el agente llega al límite de pasos =====
let pendingContinue = null;
function showContinueButton(id){
  const c = convData[id]; if(!c) return;
  const html = '<div class="continue-box">El agente alcanzó el límite de pasos. '
    + '<button onclick="continueAgent(\''+id+'\')">▶️ Continuar</button></div>';
  c.messages.push({role:'bot', html});
  if(id===activeId) addMsg('bot', html, c.messages.length-1);
  persistConv(id);
}
function continueAgent(id){
  const prev = activeId;
  activeId = id;
  enqueue('Continúa exactamente donde te quedaste hasta completar la tarea pendiente.', [], []);
  activeId = prev;
}
window.continueAgent = continueAgent;

composer.addEventListener('submit', (e)=>{
  e.preventDefault();
  const c = convData[activeId];
  const busy = !!(c && c.aborts && c.aborts.size>0);
  const typed = input.value.trim();
  if(busy){
    // Con texto escrito: NO cancelar. Si pregunta por el progreso, responder en vivo y seguir.
    if(typed){
      if(isProgressQuery(typed)){
        input.value=''; autoGrow();
        showProgressReply(activeId, typed);
      }else{
        // Otro texto mientras trabaja: encolar como siguiente tarea (no interrumpe la actual).
        input.value=''; autoGrow();
        enqueue(typed, [], []);
        setStatusMic('📌 Lo haré cuando termine lo actual.');
      }
      return;
    }
    // Sin texto = botón ⏹ Detener.
    c.aborts.forEach(a=>{ try{a.abort();}catch(_){}});
    return;
  }
  const msg = typed;
  const imgs = pendingImages.slice();
  const files = pendingFiles.slice();
  if(!msg && !imgs.length && !files.length) return;
  input.value=''; autoGrow();
  clearPreview();
  enqueue(msg || (files.length?'Analiza los documentos adjuntos.':'¿Qué ves en esta imagen?'), imgs, files);
  input.focus();
});

/* ===== Adjuntar imágenes: pegar (Ctrl+V) y arrastrar ===== */
let pendingFiles=[]; // documentos de texto adjuntos {name, text}
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|ts|jsx|tsx|py|java|c|cpp|h|cs|go|rs|rb|php|sh|ps1|bat|yml|yaml|ini|cfg|conf|log|sql|env|gitignore|toml)$/i;
async function addTextFile(file){
  try{
    const text = await file.text();
    pendingFiles.push({ name: file.name, text: text.slice(0, 60000) });
    renderPreview();
  }catch(e){}
}
function addImage(dataUrl){
  pendingImages.push(dataUrl);
  renderPreview();
}
function clearPreview(){ pendingImages=[]; pendingFiles=[]; renderPreview(); }
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
  pendingFiles.forEach((f,idx)=>{
    const w=document.createElement('div');
    w.style.cssText='position:relative;background:#1a2438;border:1px solid #33335a;border-radius:8px;padding:6px 10px;font-size:12px;display:flex;align-items:center;gap:6px;';
    w.innerHTML=`📄 ${f.name}<span style="background:#ff2668;color:#fff;border-radius:50%;width:16px;height:16px;display:grid;place-items:center;font-size:11px;cursor:pointer;">×</span>`;
    w.querySelector('span').onclick=()=>{ pendingFiles.splice(idx,1); renderPreview(); };
    bar.appendChild(w);
  });
  bar.style.display = (pendingImages.length||pendingFiles.length) ? 'flex' : 'none';
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
  for(const f of files){
    if(f.type.startsWith('image/')) addImage(await fileToDataUrl(f));
    else if(TEXT_EXT.test(f.name) || (f.type||'').startsWith('text/')) addTextFile(f);
  }
});

/* Botón adjuntar documento (clip) */
const attachBtn = document.getElementById('btn-attach');
if(attachBtn){
  const fi = document.createElement('input');
  fi.type='file'; fi.multiple=true; fi.style.display='none';
  fi.accept='.txt,.md,.csv,.json,.xml,.html,.css,.js,.ts,.py,.java,.c,.cpp,.cs,.go,.rs,.rb,.php,.sh,.ps1,.yml,.yaml,.ini,.log,.sql,image/*';
  document.body.appendChild(fi);
  attachBtn.onclick=()=>fi.click();
  fi.onchange=async()=>{
    for(const f of fi.files){
      if(f.type.startsWith('image/')) addImage(await fileToDataUrl(f));
      else addTextFile(f);
    }
    fi.value='';
  };
}

input.focus();

/* ============ VOZ: dictado (Azure Speech o navegador) y lectura (TTS) ============ */
const micBtn = document.getElementById('btn-mic');
const speakBtn = document.getElementById('btn-speak');

let speechAvailable = false;
let speechEngine = 'browser';   // 'local' | 'azure' | 'browser'
let localModelReady = false;
fetch('/api/speech/available').then(r=>r.json()).then(d=>{
  speechAvailable = !!d.available;
  localModelReady = !!d.localModelReady;
  speechEngine = d.local ? 'local' : (d.azure ? 'azure' : 'browser');
  if(micBtn) micBtn.title = speechEngine==='local' ? 'Hablar (Whisper local, offline)' : (speechEngine==='azure' ? 'Hablar (Azure Speech)' : 'Hablar (dictado del navegador)');
}).catch(()=>{});

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
  // Whisper local: si el modelo aún no está, avisar que se descarga la 1ª vez.
  if(speechEngine==='local' && !localModelReady){
    setStatusMic('⬇️ Descargando modelo de voz (solo la 1ª vez, ~140MB)…');
  }
  try{
    const r = await fetch('/api/transcribe', { method:'POST', headers:{'Content-Type':'audio/wav','x-engine':speechEngine}, body: wav });
    const j = await r.json();
    if(j.text){ input.value = (input.value ? input.value+' ' : '') + j.text; autoGrow(); setStatusMic('✔ '+j.text); localModelReady = true; }
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

let ttsAudio = null;
function speak(text){
  if (!speakOn) return;
  const clean = text.replace(/```[\s\S]*?```/g, ' bloque de código. ').replace(/`([^`]+)`/g, '$1').replace(/[#*_>]/g,'').trim();
  if (!clean) return;
  // Preferir Azure TTS (voz natural). Fallback: voz del navegador.
  if (speechAvailable) {
    fetch('/api/tts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: clean }) })
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(blob => {
        if (ttsAudio) { try{ ttsAudio.pause(); }catch(_){} }
        ttsAudio = new Audio(URL.createObjectURL(blob));
        ttsAudio.play().catch(()=>{});
      })
      .catch(()=> browserSpeak(clean));
    return;
  }
  browserSpeak(clean);
}
function browserSpeak(clean){
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'es-ES'; u.rate = 1.05;
  const v = window.speechSynthesis.getVoices().find(x => x.lang && x.lang.startsWith('es'));
  if (v) u.voice = v;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

/* ============ MEJORAS: buscar, exportar, temas, atajos ============ */
// Buscar en conversaciones
(function(){
  const s = document.getElementById('conv-search');
  if(s) s.addEventListener('input', ()=> loadConvList());
})();

// Exportar la conversación activa a un archivo de texto
document.getElementById('btn-export')?.addEventListener('click', ()=>{
  const c = convData[activeId]; if(!c || !c.messages.length){ return; }
  let out = 'HanstlerS - ' + (c.title||'Conversación') + '\n' + '='.repeat(40) + '\n\n';
  c.messages.forEach(m=>{
    const who = m.role==='user' ? 'Tú' : 'HanstlerS';
    const text = m.html.replace(/<pre><code>/g,'\n').replace(/<\/code><\/pre>/g,'\n').replace(/<[^>]+>/g,'').trim();
    out += who + ':\n' + text + '\n\n';
  });
  const blob = new Blob([out], {type:'text/plain;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (c.title||'conversacion').replace(/[^a-z0-9_-]/gi,'_').slice(0,40) + '.txt';
  a.click();
});

// Temas de color (oscuro neón / oscuro azul / claro)
const THEMES = ['neon','ocean','light'];
function applyTheme(t){
  document.body.setAttribute('data-theme', t);
  try{ localStorage.setItem('hs-theme', t); }catch(_){}
}
document.getElementById('btn-theme')?.addEventListener('click', ()=>{
  const cur = document.body.getAttribute('data-theme') || 'neon';
  const next = THEMES[(THEMES.indexOf(cur)+1) % THEMES.length];
  applyTheme(next);
});
(function(){ try{ applyTheme(localStorage.getItem('hs-theme')||'neon'); }catch(_){ applyTheme('neon'); } })();

// Auto-arranque con Windows
(function(){
  const btn = document.getElementById('btn-autostart');
  if(!btn) return;
  let on = false, supported = false;
  const paint = ()=>{ btn.classList.toggle('on', !!on); btn.title = supported ? (on?'Se inicia con Windows (clic para desactivar)':'Iniciar con Windows (clic para activar)') : 'Disponible solo en la app instalada'; };
  fetch('/api/autostart').then(r=>r.json()).then(d=>{ on=!!d.enabled; supported=!!d.supported; paint(); }).catch(()=>{});
  btn.addEventListener('click', ()=>{
    if(!supported){ return; }
    fetch('/api/autostart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!on})})
      .then(r=>r.json()).then(d=>{ if(d.ok){ on=!!d.enabled; paint(); } }).catch(()=>{});
  });
})();

// Autodiagnóstico: prueba cada eslabón y muestra qué falla
(function(){
  const btn = document.getElementById('btn-diagnose');
  if(!btn) return;
  btn.addEventListener('click', async ()=>{
    if(btn.disabled) return; btn.disabled=true; btn.style.opacity='0.5';
    let html = '<b>Diagnóstico de HanstlerS</b>\n\n';
    try{
      const r = await fetch('/api/diagnose'); const d = await r.json();
      d.checks.forEach(c=>{ html += (c.ok?'✅':'❌')+' **'+c.name+'** — '+c.detail+'\n'; });
      html += '\n'+(d.ok ? '**Todo funciona.** Los modelos de Copilot deberían responder.' : '⚠️ **Hay un problema** (ver ❌ arriba). Sigue la indicación de la línea roja.');
    }catch(e){ html += '❌ No se pudo ejecutar el diagnóstico: '+e.message; }
    btn.disabled=false; btn.style.opacity='';
    const id = activeId; const c = getConv(id);
    c.messages.push({role:'bot', html:renderMd(html)});
    if(id===activeId) addMsg('bot', renderMd(html), c.messages.length-1);
    persistConv(id);
  });
})();
document.addEventListener('keydown', (e)=>{
  const ctrl = e.ctrlKey || e.metaKey;
  if(ctrl && e.key.toLowerCase()==='n'){ e.preventDefault(); newConv(); }        // nueva conversación
  else if(ctrl && e.key.toLowerCase()==='k'){ e.preventDefault(); document.getElementById('conv-search')?.focus(); } // buscar
  else if(ctrl && e.key.toLowerCase()==='t'){ e.preventDefault(); document.getElementById('btn-theme')?.click(); }   // tema
  else if(ctrl && e.key.toLowerCase()==='e'){ e.preventDefault(); document.getElementById('btn-export')?.click(); }  // exportar
  else if(ctrl && e.key.toLowerCase()==='b'){ e.preventDefault(); document.getElementById('sidebar')?.classList.toggle('hidden'); } // ocultar panel
});
