const $ = s => document.querySelector(s);
const stateKey = localStorage.getItem('msyayin_session') || '';
let key = stateKey;
let state = null;
let socket = null;

async function ensureSession(){
  if(key){
    const r = await fetch('/api/session/'+key);
    if(r.ok){ state = await r.json(); return; }
  }
  const r = await fetch('/api/session/new');
  const j = await r.json();
  key = j.key; localStorage.setItem('msyayin_session', key);
  const rs = await fetch('/api/session/'+key); state = await rs.json();
}

function toast(t){const e=$('#toast');e.textContent=t;e.style.display='block';clearTimeout(window.__tt);window.__tt=setTimeout(()=>e.style.display='none',3200)}
function esc(t){return String(t??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function initials(n){return esc(String(n||'K').slice(0,2).toUpperCase())}
function row(name, val){return `<div class="row"><div class="user"><div class="avatar">${initials(name)}</div><span>${esc(name)}</span></div><div class="pill">${esc(val)}</div></div>`}

function render(){
  if(!state)return;
  $('#statusText').textContent=state.status||'Hazır';
  $('#statusDot').className='dot '+(state.connected?'on':/hata/i.test(state.status||'')?'err':'');
  $('#connectionHint').textContent=state.connected?`@${state.tiktokUsername} izleniyor`:state.status;
  $('#username').value=state.tiktokUsername||$('#username').value;
  $('#scoreSeconds').value=state.score.seconds;
  const votes=state.score.votes||[]; 
  const avg=votes.length?votes.reduce((a,x)=>a+Number(x.value||0),0)/votes.length:0;
  $('#average').textContent=avg.toFixed(1);
  $('#countVotes').textContent=votes.length;
  $('#countdown').textContent=state.score.active&&state.score.endsAt?Math.max(0,Math.ceil((state.score.endsAt-Date.now())/1000))+' sn':state.score.active?'aktif':'—';
  $('#voteList').innerHTML=votes.map(v=>row(v.username,v.value+' puan')).join('')||'<div class="muted">Henüz oy yok.</div>';
  $('#raconList').innerHTML=(state.raconGifts||[]).map(v=>row(v.username,v.gift+(v.quantity>1?' ×'+v.quantity:''))).join('')||'<div class="muted">Seçili hediye bekleniyor.</div>';
  $('#mekanList').innerHTML=(state.mekanGifts||[]).map(v=>row(v.username,v.gift+(v.quantity>1?' ×'+v.quantity:''))).join('')||'<div class="muted">Seçili hediye bekleniyor.</div>';
  const likes=Object.entries(state.likes||{}).sort((a,b)=>b[1]-a[1]);
  $('#top3').innerHTML=likes.slice(0,3).map((x,i)=>`<div class="rankbox"><b>#${i+1}</b><span>${esc(x[0])}</span><span>${x[1].toLocaleString('tr-TR')} beğeni</span></div>`).join('')||'<div class="muted">Beğeni bekleniyor.</div>'.repeat(3);
  $('#likeList').innerHTML=likes.map(x=>row(x[0],x[1].toLocaleString('tr-TR')+' ❤️')).join('')||'<div class="muted">Henüz beğeni yok.</div>';
  $('#wins').textContent=state.wins||0;
  $('#targetWins').value=state.targetWins||20;
  const giftNames=[...new Set([...(state.recentEvents||[]).filter(x=>x.type==='gift').map(x=>x.gift).filter(Boolean)])];
  for(const sel of ['#raconGift','#mekanGift']){
    const cur=$(sel).value;
    $(sel).innerHTML='<option value="">Gelen hediyelerden seç</option>'+giftNames.map(g=>`<option value="${esc(g)}">${esc(g)}</option>`).join('');
    $(sel).value=cur;
  }
  $('#scoreOverlay').href='/overlay/puanlama?room='+state.key;
  $('#raconOverlay').href='/overlay/racon?room='+state.key;
  $('#mekanOverlay').href='/overlay/mekan?room='+state.key;
  $('#likeOverlay').href='/overlay/begeni?room='+state.key;
  $('#winOverlay').href='/overlay/win?room='+state.key;
}

async function post(url, body){
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,...body})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||'İşlem başarısız');
  return j;
}

async function init(){
  try{await ensureSession(); render();
    socket=io(); socket.on('connect',()=>socket.emit('join',key));
    socket.on('state:update',x=>{state=x;render()});
    socket.on('event:new',x=>{ if(state){state.recentEvents.unshift(x);state.recentEvents=state.recentEvents.slice(0,40);render();} });
  }catch(e){toast(e.message)}
}

$('#connectBtn').onclick=async()=>{try{await post('/api/connect',{username:$('#username').value});toast('Bağlantı başlatıldı. TikTok LIVE sayfası açılıyor…')}catch(e){toast(e.message)}};
$('#disconnectBtn').onclick=async()=>{try{await post('/api/disconnect',{});toast('Bağlantı kesildi.')}catch(e){toast(e.message)}};
$('#scoreSeconds').onchange=async()=>{try{await post('/api/settings/score',{seconds:$('#scoreSeconds').value})}catch(e){toast(e.message)}};
$('#scoreStart').onclick=async()=>{try{await post('/api/score/start',{});toast('Puanlama başladı.')}catch(e){toast(e.message)}};
$('#raconGift').onchange=async e=>{try{await post('/api/gift/select',{kind:'racon',gift:e.target.value})}catch(x){toast(x.message)}};
$('#mekanGift').onchange=async e=>{try{await post('/api/gift/select',{kind:'mekan',gift:e.target.value})}catch(x){toast(x.message)}};
$('#winPlus').onclick=async()=>{try{await post('/api/win',{delta:1,target:$('#targetWins').value})}catch(e){toast(e.message)}};
$('#winMinus').onclick=async()=>{try{await post('/api/win',{delta:-1,target:$('#targetWins').value})}catch(e){toast(e.message)}};
$('#targetWins').onchange=async()=>{try{await post('/api/win',{delta:0,target:$('#targetWins').value})}catch(e){toast(e.message)}};

document.querySelectorAll('[data-test]').forEach(btn=>btn.onclick=async()=>{
  const kind=btn.dataset.test;
  try{
    if(kind==='vote') await post('/api/test',{type:'vote',username:'TestPuan',value:10});
    if(kind==='vote9') await post('/api/test',{type:'vote',username:'TestPuan2',value:9});
    if(kind==='gift') await post('/api/test',{type:'gift',username:'RaconTest',gift:'Gül'});
    if(kind==='like') await post('/api/test',{type:'like',username:'LikeTest',count:50});
    if(kind==='win') await post('/api/test',{type:'win',username:'WinTest',delta:1});
  }catch(e){toast(e.message)}
});
$('#clearData').onclick=async()=>{location.reload()};
setInterval(()=>render(),500);
init();
