'use strict';
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const composer = document.getElementById('composer');
const sendBtn = document.getElementById('send');
const cwdEl = document.getElementById('cwd');

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// Render minimalista de markdown (bloques de código, `code`, saltos)
function renderMd(text){
  let html = esc(text);
  html = html.replace(/```([\s\S]*?)```/g, (m,c)=>`<pre><code>${c.replace(/^\n/,'')}</code></pre>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
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

function setCwd(p){ if(p){ cwdEl.textContent = p; cwdEl.title = p; } }

fetch('/api/state').then(r=>r.json()).then(s=>setCwd(s.cwd)).catch(()=>{});

document.getElementById('btn-folder').addEventListener('click', async ()=>{
  cwdEl.textContent = 'Abriendo selector…';
  try{
    const r = await fetch('/api/pickfolder');
    const j = await r.json();
    setCwd(j.cwd);
    if(j.path) addMsg('bot', 'Carpeta cambiada a <code>'+esc(j.path)+'</code>. Nueva conversación iniciada.');
  }catch(e){ setCwd('~'); }
});

document.getElementById('btn-new').addEventListener('click', async ()=>{
  await fetch('/api/newsession', {method:'POST'});
  chat.innerHTML='';
  addMsg('bot', 'Nueva conversación. ¿En qué trabajamos?');
});

function autoGrow(){ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,180)+'px'; }
input.addEventListener('input', autoGrow);
input.addEventListener('keydown', (e)=>{
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); composer.requestSubmit(); }
});

let busy=false;
composer.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const msg = input.value.trim();
  if(!msg || busy) return;
  busy=true; sendBtn.disabled=true;
  addMsg('user', renderMd(msg));
  input.value=''; autoGrow();

  const bubble = addMsg('bot', '<span class="typing"><span></span><span></span><span></span></span>');
  let acc='';

  try{
    const resp = await fetch('/api/chat', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ message: msg })
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
        else if(type==='error'){ acc += '\n⚠️ '+data; bubble.innerHTML = renderMd(acc); }
      }
    }
    if(!acc.trim()) bubble.innerHTML = '<em style="color:#8a8aa0">(sin respuesta)</em>';
    else speak(acc);
  }catch(err){
    bubble.innerHTML = '⚠️ Error de conexión: '+esc(err.message);
  }finally{
    busy=false; sendBtn.disabled=false; input.focus();
  }
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

  recog.onstart = () => { listening = true; micBtn.classList.add('listening'); };
  recog.onerror = () => stopListen();
  recog.onend = () => stopListen();
  recog.onresult = (e) => {
    let txt = '';
    for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
    input.value = (baseText + ' ' + txt).trim();
    autoGrow();
  };

  micBtn.addEventListener('click', () => {
    if (listening) { recog.stop(); return; }
    baseText = input.value.trim();
    try { recog.start(); } catch (_) {}
  });
} else {
  micBtn.disabled = true;
  micBtn.title = 'Tu navegador no soporta dictado por voz';
  micBtn.style.opacity = .4;
}

function stopListen(){ listening = false; micBtn.classList.remove('listening'); }

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
