let token = localStorage.getItem('token');
let state = null;
let socket = null;
let mode = 'login';
let activeCombat = null;

const $ = id => document.getElementById(id);
$('tabLogin').onclick = () => setMode('login');
$('tabReg').onclick = () => setMode('register');
$('authForm').onsubmit = async e => { e.preventDefault(); await doAuth(); };
$('chatForm').onsubmit = e => { e.preventDefault(); const v=$('chatInput').value.trim(); if(v&&socket){socket.emit('chat',v); $('chatInput').value='';} };

function setMode(m){ mode=m; $('tabLogin').classList.toggle('active',m==='login'); $('tabReg').classList.toggle('active',m==='register'); $('heroLabel').classList.toggle('hidden',m==='login'); $('authBtn').textContent=m==='login'?'Войти':'Создать героя'; $('authError').textContent=''; }
async function doAuth(){ const body={username:$('username').value,password:$('password').value,heroName:$('heroName').value}; const res=await fetch('/api/'+(mode==='login'?'login':'register'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const data=await res.json(); if(!res.ok){$('authError').textContent=data.error||'Ошибка';return;} token=data.token; localStorage.setItem('token',token); state=data.state; enterGame(); }
async function api(url, opts={}){ opts.headers={...(opts.headers||{}),Authorization:'Bearer '+token,'Content-Type':'application/json'}; if(opts.body&&typeof opts.body!=='string') opts.body=JSON.stringify(opts.body); const r=await fetch(url,opts); const d=await r.json().catch(()=>({})); if(!r.ok){toast(d.error||'Ошибка'); if(r.status===401) logout(); return null;} state=d; render(); if(d.notice) toast(d.notice); return d; }
function logout(){ localStorage.removeItem('token'); location.reload(); }
async function boot(){ if(!token) return; const r=await fetch('/api/state',{headers:{Authorization:'Bearer '+token}}); if(r.ok){ state=await r.json(); enterGame(); } else localStorage.removeItem('token'); }
function enterGame(){ $('auth').classList.add('hidden'); $('game').classList.remove('hidden'); connect(); render(); loadMessages(); }
function connect(){ if(socket) socket.disconnect(); socket=io({auth:{token}}); socket.on('state',s=>{state=s;render();}); socket.on('combat',c=>{activeCombat=c; renderCombat(c);}); socket.on('chat',m=>addMessage(m)); socket.on('toast',toast); socket.on('connect_error',()=>toast('Ошибка подключения сокета')); }
async function loadMessages(){ const r=await fetch('/api/messages',{headers:{Authorization:'Bearer '+token}}); if(r.ok){ $('chat').innerHTML=''; (await r.json()).forEach(addMessage); } }
function pct(a,b){return Math.max(0,Math.min(100,Math.round((a||0)/(b||1)*100)));}
function gold(n){return `<span class="gold">${n} зол.</span>`}
function render(){ if(!state) return; const h=state.hero,d=state.derived; $('heroLine').innerHTML=`<b>${escapeHtml(h.name)}</b> · ур. ${h.level} · ${h.gold} зол. · репутация ${h.reputation||0}`; $('queueInfo').textContent=`Арена: ${state.queue?.arena||0}`; $('bagCount').textContent=`${state.inventory.length} предметов`;
  $('heroStats').innerHTML=`${bar('HP',h.hp,d.maxHp,'hp')}${bar('Энергия',h.energy,d.maxEnergy,'energy')}${bar('Опыт',h.exp,h.level*50,'exp')}<div class="statGrid"><div><b>${d.totalStats.str}</b><span>Сила</span></div><div><b>${d.totalStats.agi}</b><span>Ловкость</span></div><div><b>${d.totalStats.con}</b><span>Вынос</span></div></div><p class="small">Урон ${d.power}, защита ${d.defense}, уклон ${Math.round(d.dodge)}%, крит ${Math.round(d.crit)}%</p><p>Свободно очков: <b>${h.statPoints}</b></p>`;
  $('equip').innerHTML=Object.entries(h.equipment).map(([slot,id])=>`<div class="item compactItem"><span><b>${slotName(slot)}</b><br><em>${id?itemName(id):'пусто'}</em></span>${id?`<button onclick="unequip('${slot}')">снять</button>`:''}</div>`).join('');
  $('locations').innerHTML=Object.entries(state.locations).map(([id,l])=>`<div class="loc ${h.location===id?'active':''}" onclick="setLocation('${id}')"><div class="locIcon">${l.icon||'•'}</div><b>${l.name}</b><br><span class="small">${l.desc}</span></div>`).join('');
  renderInventory(); renderShop(); renderQuests(); renderLeaderboard(); if(activeCombat) renderCombat(activeCombat);
}
function bar(label,val,max,cls){return `<div class="barLabel"><span>${label}</span><b>${Math.round(val)}/${max}</b></div><div class="bar ${cls}"><span style="width:${pct(val,max)}%"></span></div>`}
function itemName(id){return state.shop.find(i=>i.id===id)?.name || state.inventory.find(x=>x.itemId===id)?.item?.name || id}
function renderInventory(){ const groups={equipment:[],consumable:[],material:[]}; for(const x of state.inventory){groups[x.item.type||'material'].push(x)}; const block=(title,arr)=>`<h3>${title}</h3>`+(arr.length?arr.map(invCard).join(''):'<p class="muted">Пусто.</p>'); $('inventory').innerHTML=block('Экипировка',groups.equipment)+block('Расходники',groups.consumable)+block('Материалы',groups.material); }
function invCard(x){ const it=x.item; const equipped=Object.values(state.hero.equipment||{}).includes(it.id); return `<div class="item rarity-${it.rarity||'common'}"><div><b>${it.name}</b> ${equipped?'<span class="pill ok">надето</span>':''}<br><span class="small">${typeName(it)} · ${it.desc}</span></div><div class="itemActions">${it.type==='equipment'?`<button onclick="equip('${x.id}')">надеть</button>`:''}${it.type==='consumable'?`<button onclick="useItem('${x.id}')">использ.</button>`:''}<button class="ghost" onclick="sell('${x.id}')">продать</button></div></div>`; }
function renderShop(){ $('shop').innerHTML=state.shop.map(i=>`<div class="item rarity-${i.rarity||'common'}"><div><b>${i.name}</b> — ${gold(i.price)}<br><span class="small">${typeName(i)} · ${i.desc}</span></div><button onclick="buy('${i.id}')">купить</button></div>`).join(''); }
function renderQuests(){ const q=[...(state.quests?.regular||[]), state.quests?.daily].filter(Boolean); $('quests').innerHTML=q.map(x=>`<div class="quest ${x.done&&!x.claimed?'ready':''}"><div><b>${x.title}</b>${x.id==='daily_hunt'?'<span class="pill">daily</span>':''}<br><span class="small">${x.desc}</span>${bar('',x.progress,x.need,'mini')}<span class="small">Награда: ${x.reward.gold||0} зол., ${x.reward.exp||0} опыта${x.reward.itemId?', '+itemName(x.reward.itemId):''}</span></div><button ${(!x.done||x.claimed)?'disabled':''} onclick="claimQuest('${x.id}')">${x.claimed?'получено':'забрать'}</button></div>`).join(''); }
function renderLeaderboard(){ $('leaderboard').innerHTML=state.leaderboard.map((r,i)=>`<div class="rank"><span class="place">${i+1}</span><div><b>${escapeHtml(r.name)}</b><br><span class="small">ур.${r.level}, побед ${r.kills}, смертей ${r.deaths}, реп. ${r.reputation||0}</span></div></div>`).join(''); }
function typeName(i){return {equipment:slotName(i.slot),consumable:'расходник',material:'материал'}[i.type]||i.type}
function slotName(s){return {weapon:'Оружие',armor:'Броня',boots:'Сапоги',ring:'Кольцо'}[s]||s}
function setLocation(location){api('/api/location',{method:'POST',body:{location}})}
function addStat(stat){api('/api/stat',{method:'POST',body:{stat}})}
function buy(itemId){api('/api/buy',{method:'POST',body:{itemId}})}
function sell(inventoryId){api('/api/sell',{method:'POST',body:{inventoryId}})}
function equip(inventoryId){api('/api/equip',{method:'POST',body:{inventoryId}})}
function unequip(slot){api('/api/unequip',{method:'POST',body:{slot}})}
function useItem(inventoryId){api('/api/use',{method:'POST',body:{inventoryId}})}
function gather(){api('/api/gather',{method:'POST'})}
function claimQuest(id){api('/api/quest/claim',{method:'POST',body:{id}})}
function startPve(){socket.emit('pve:start')}
function joinPvp(){socket.emit('pvp:join')}
function leavePvp(){socket.emit('pvp:leave')}
function action(a){socket.emit('combat:action',a)}
function renderCombat(c){ const me=state?.hero?.id; const turn=c.fighters[c.turn]; $('combat').classList.remove('muted'); $('combat').innerHTML=`<div class="sectionHead"><h3>${c.status==='active'?'Раунд '+c.round:'Бой завершён'}</h3><span class="pill">${c.type.toUpperCase()}</span></div><div class="fighters">${c.fighters.map(f=>`<div class="fighter ${turn===f&&c.status==='active'?'turn':''}"><div class="fighterName"><b>${escapeHtml(f.name)}</b><span>ур.${f.level}</span></div>${bar('HP',f.hp,f.maxHp,'hp')}${bar('Энергия',f.energy,f.maxEnergy,'energy')}<span class="pill">ярость ${f.fury||0}/3</span>${f.guard?'<span class="pill ok">защита</span>':''}</div>`).join('')}</div>${c.status==='active'&&turn.heroId===me?`<div class="combatBtns"><button onclick="action('attack')">Удар</button><button onclick="action('power')">Мощный -14</button><button onclick="action('precise')">Точный -8</button><button onclick="action('rage')">Ярость -22</button><button onclick="action('guard')">Защита</button></div>`:c.status==='active'?'<p class="muted">Ход противника...</p>':''}<div class="combatLog">${c.log.slice(-14).reverse().map(x=>`<div>${escapeHtml(x)}</div>`).join('')}</div>`; if(c.status==='finished') setTimeout(()=>{activeCombat=null;$('combat').classList.add('muted');$('combat').innerHTML='Нет активного боя.';},6000); }
function addMessage(m){ const el=document.createElement('div'); el.className='msg'; const time=new Date(m.at||Date.now()).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); el.innerHTML=`<span class="small">${time}</span> <b>${escapeHtml(m.hero)}</b>: ${escapeHtml(m.text)}`; $('chat').appendChild(el); $('chat').scrollTop=$('chat').scrollHeight; }
function toast(t){ const el=document.createElement('div'); el.className='toast'; el.textContent=t; $('toast').appendChild(el); setTimeout(()=>el.remove(),4200); }
function scrollToPanel(id){$(id).scrollIntoView({behavior:'smooth',block:'start'});}
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));}
boot();
