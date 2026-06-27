let token = localStorage.getItem('token');
let state = null;
let socket = null;
let mode = 'login';

const $ = id => document.getElementById(id);
$('tabLogin').onclick = () => setMode('login');
$('tabReg').onclick = () => setMode('register');
$('authForm').onsubmit = async e => { e.preventDefault(); await doAuth(); };
$('chatForm').onsubmit = e => { e.preventDefault(); const v=$('chatInput').value.trim(); if(v&&socket){socket.emit('chat',v); $('chatInput').value='';} };

function setMode(m){ mode=m; $('tabLogin').classList.toggle('active',m==='login'); $('tabReg').classList.toggle('active',m==='register'); $('heroName').classList.toggle('hidden',m==='login'); $('authBtn').textContent=m==='login'?'Войти':'Создать героя'; }
async function doAuth(){ const body={username:$('username').value,password:$('password').value,heroName:$('heroName').value}; const res=await fetch('/api/'+(mode==='login'?'login':'register'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const data=await res.json(); if(!res.ok){$('authError').textContent=data.error||'Ошибка';return;} token=data.token; localStorage.setItem('token',token); state=data.state; enterGame(); }
async function api(url, opts={}){ opts.headers={...(opts.headers||{}),Authorization:'Bearer '+token,'Content-Type':'application/json'}; if(opts.body&&typeof opts.body!=='string') opts.body=JSON.stringify(opts.body); const r=await fetch(url,opts); const d=await r.json().catch(()=>({})); if(!r.ok){toast(d.error||'Ошибка'); if(r.status===401) logout(); return null;} state=d; render(); return d; }
function logout(){ localStorage.removeItem('token'); location.reload(); }
async function boot(){ if(!token) return; const r=await fetch('/api/state',{headers:{Authorization:'Bearer '+token}}); if(r.ok){ state=await r.json(); enterGame(); } else localStorage.removeItem('token'); }
function enterGame(){ $('auth').classList.add('hidden'); $('game').classList.remove('hidden'); connect(); render(); loadMessages(); }
function connect(){ if(socket) socket.disconnect(); socket=io({auth:{token}}); socket.on('state',s=>{state=s;render();}); socket.on('combat',renderCombat); socket.on('chat',m=>addMessage(m)); socket.on('toast',toast); socket.on('connect_error',()=>toast('Ошибка подключения сокета')); }
async function loadMessages(){ const r=await fetch('/api/messages',{headers:{Authorization:'Bearer '+token}}); if(r.ok){ $('chat').innerHTML=''; (await r.json()).forEach(addMessage); } }
function pct(a,b){return Math.max(0,Math.min(100,Math.round(a/b*100)));}
function render(){ if(!state) return; const h=state.hero,d=state.derived; $('heroLine').textContent=`${h.name}, уровень ${h.level}, ${h.gold} золота`; $('heroStats').innerHTML=`<div class="bar"><span style="width:${pct(h.hp,d.maxHp)}%"></span></div><b>HP:</b> ${h.hp}/${d.maxHp}<div class="bar energy"><span style="width:${pct(h.energy,d.maxEnergy)}%"></span></div><b>Энергия:</b> ${h.energy}/${d.maxEnergy}<div class="bar exp"><span style="width:${pct(h.exp,h.level*50)}%"></span></div><b>Опыт:</b> ${h.exp}/${h.level*50}<p><span class="pill">Сила ${d.totalStats.str}</span><span class="pill">Ловкость ${d.totalStats.agi}</span><span class="pill">Вынос ${d.totalStats.con}</span></p><p class="small">Урон ${d.power}, защита ${d.defense}, уклон ${Math.round(d.dodge)}%, крит ${Math.round(d.crit)}%</p><p>Свободно очков: <b>${h.statPoints}</b></p>`; $('equip').innerHTML=Object.entries(h.equipment).map(([slot,id])=>`<div class="item"><b>${slotName(slot)}</b>: ${id?state.shop.find(i=>i.id===id)?.name:'пусто'} ${id?`<button onclick="unequip('${slot}')">снять</button>`:''}</div>`).join(''); $('locations').innerHTML=Object.entries(state.locations).map(([id,l])=>`<div class="loc ${h.location===id?'active':''}" onclick="setLocation('${id}')"><b>${l.name}</b><br><span class="small">${l.desc}</span></div>`).join(''); $('inventory').innerHTML=state.inventory.length?state.inventory.map(x=>`<div class="item"><b>${x.item.name}</b><br><span class="small">${x.item.slot}: ${x.item.desc}</span><button onclick="equip('${x.id}')">надеть</button></div>`).join(''):'<p class="muted">Пусто.</p>'; $('shop').innerHTML=state.shop.map(i=>`<div class="item"><b>${i.name}</b> — ${i.price} зол.<br><span class="small">${i.slot}: ${i.desc}</span><button onclick="buy('${i.id}')">купить</button></div>`).join(''); $('leaderboard').innerHTML=state.leaderboard.map((r,i)=>`<div class="rank">${i+1}. <b>${r.name}</b> ур.${r.level} убийств:${r.kills}</div>`).join(''); }
function slotName(s){return {weapon:'Оружие',armor:'Броня',boots:'Сапоги',ring:'Кольцо'}[s]||s}
function setLocation(location){api('/api/location',{method:'POST',body:{location}})}
function addStat(stat){api('/api/stat',{method:'POST',body:{stat}})}
function buy(itemId){api('/api/buy',{method:'POST',body:{itemId}})}
function equip(inventoryId){api('/api/equip',{method:'POST',body:{inventoryId}})}
function unequip(slot){api('/api/unequip',{method:'POST',body:{slot}})}
function startPve(){socket.emit('pve:start')}
function joinPvp(){socket.emit('pvp:join')}
function leavePvp(){socket.emit('pvp:leave')}
function action(a){socket.emit('combat:action',a)}
function renderCombat(c){ const me=state?.hero?.id; const turn=c.fighters[c.turn]; $('combat').classList.remove('muted'); $('combat').innerHTML=`<h3>${c.status==='active'?'Раунд '+c.round:'Бой завершён'}</h3><div class="fighters">${c.fighters.map(f=>`<div class="fighter ${turn===f&&c.status==='active'?'turn':''}"><b>${f.name}</b> ур.${f.level}<div class="bar"><span style="width:${pct(f.hp,f.maxHp)}%"></span></div>${f.hp}/${f.maxHp} HP<div class="bar energy"><span style="width:${pct(f.energy,f.maxEnergy)}%"></span></div>${f.energy}/${f.maxEnergy} энергии${f.guard?'<p class="pill">защита</p>':''}</div>`).join('')}</div>${c.status==='active'&&turn.heroId===me?`<div class="combatBtns"><button onclick="action('attack')">Удар</button><button onclick="action('power')">Мощный (-14)</button><button onclick="action('precise')">Точный (-8)</button><button onclick="action('guard')">Защита (+энергия)</button></div>`:''}<div class="combatLog">${c.log.slice(-12).reverse().map(x=>`<div>${x}</div>`).join('')}</div>`; if(c.status==='finished') setTimeout(()=>$('combat').innerHTML='Нет активного боя.',5000); }
function addMessage(m){ const el=document.createElement('div'); el.className='msg'; el.innerHTML=`<b>${escapeHtml(m.hero)}</b>: ${escapeHtml(m.text)}`; $('chat').appendChild(el); $('chat').scrollTop=$('chat').scrollHeight; }
function toast(t){ const el=document.createElement('div'); el.className='toast'; el.textContent=t; $('toast').appendChild(el); setTimeout(()=>el.remove(),3500); }
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));}
boot();
