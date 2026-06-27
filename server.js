const express = require('express');
const http = require('http');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { nanoid } = require('nanoid');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DB_FILE = path.join(__dirname, 'data', 'db.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const baseDb = { users: [], heroes: [], items: [], inventory: [], messages: [], combats: [], cooldowns: {} };
let db = loadDb();
seedItems();

const sessions = new Map(); // userId -> socket ids
const pvpQueue = [];
const activeCombats = new Map(); // combatId -> combat state

const LOCATIONS = {
  town: { name: 'Поселение', desc: 'Место отдыха, торговли и разговоров.' },
  forest: { name: 'Тёмный лес', desc: 'Слабые звери и бандиты.' },
  mine: { name: 'Старые шахты', desc: 'Крепкие твари, выше награды.' },
  arena: { name: 'Арена', desc: 'Очередь дуэлей с другими игроками.' }
};

const MOBS = {
  forest: [
    { name: 'Дикий волк', level: 1, stats: { str: 3, agi: 3, con: 3 }, gold: [5, 12], exp: 8 },
    { name: 'Лесной разбойник', level: 2, stats: { str: 5, agi: 4, con: 4 }, gold: [8, 18], exp: 14 }
  ],
  mine: [
    { name: 'Пещерный тролль', level: 4, stats: { str: 8, agi: 2, con: 8 }, gold: [18, 35], exp: 28 },
    { name: 'Железный скорпион', level: 5, stats: { str: 7, agi: 7, con: 6 }, gold: [24, 45], exp: 38 }
  ]
};

function loadDb() {
  try { return { ...baseDb, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; }
  catch { fs.mkdirSync(path.dirname(DB_FILE), { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(baseDb, null, 2)); return structuredClone(baseDb); }
}
function saveDb() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function publicHero(hero) { const { passwordHash, ...h } = hero; return h; }
function now() { return Date.now(); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function seedItems() {
  if (db.items.length) return;
  db.items = [
    { id: 'rusty_axe', name: 'Ржавый топор', slot: 'weapon', price: 35, stats: { str: 2 }, desc: '+2 сила' },
    { id: 'bone_club', name: 'Костяная дубина', slot: 'weapon', price: 95, stats: { str: 4, con: 1 }, desc: '+4 сила, +1 выносливость' },
    { id: 'leather_vest', name: 'Кожаный жилет', slot: 'armor', price: 50, stats: { con: 3 }, desc: '+3 выносливость' },
    { id: 'iron_plate', name: 'Железная пластина', slot: 'armor', price: 140, stats: { con: 6, agi: -1 }, desc: '+6 выносливость, -1 ловкость' },
    { id: 'hunter_boots', name: 'Сапоги охотника', slot: 'boots', price: 65, stats: { agi: 3 }, desc: '+3 ловкость' },
    { id: 'war_ring', name: 'Кольцо ярости', slot: 'ring', price: 180, stats: { str: 3, agi: 2 }, desc: '+3 сила, +2 ловкость' }
  ];
  saveDb();
}

function getUserByName(username) { return db.users.find(u => u.username.toLowerCase() === String(username).toLowerCase()); }
function getHero(userId) { return db.heroes.find(h => h.userId === userId); }
function getHeroById(id) { return db.heroes.find(h => h.id === id); }
function heroInv(heroId) { return db.inventory.filter(x => x.heroId === heroId); }
function item(id) { return db.items.find(i => i.id === id); }
function equipped(hero) { return Object.values(hero.equipment || {}).filter(Boolean).map(item).filter(Boolean); }
function totalStats(hero) {
  const s = { ...hero.stats };
  for (const it of equipped(hero)) for (const [k, v] of Object.entries(it.stats || {})) s[k] = (s[k] || 0) + v;
  s.str = Math.max(1, s.str); s.agi = Math.max(1, s.agi); s.con = Math.max(1, s.con);
  return s;
}
function maxHp(hero) { const s = totalStats(hero); return 60 + hero.level * 8 + s.con * 12; }
function maxEnergy(hero) { const s = totalStats(hero); return 30 + s.agi * 4 + hero.level * 2; }
function power(hero) { const s = totalStats(hero); return 4 + s.str * 2 + Math.floor(hero.level * 1.5); }
function defense(hero) { const s = totalStats(hero); return Math.floor(s.con * 0.8 + hero.level); }
function dodge(hero) { const s = totalStats(hero); return clamp(4 + s.agi * 1.4, 4, 35); }
function crit(hero) { const s = totalStats(hero); return clamp(5 + s.agi * 0.9, 5, 30); }
function normalizeHero(hero) {
  if (!hero.hp || hero.hp < 1) hero.hp = maxHp(hero);
  if (!hero.energy && hero.energy !== 0) hero.energy = maxEnergy(hero);
  hero.hp = clamp(hero.hp, 0, maxHp(hero));
  hero.energy = clamp(hero.energy, 0, maxEnergy(hero));
}
function levelUp(hero) {
  let changed = false;
  while (hero.exp >= hero.level * 50) {
    hero.exp -= hero.level * 50; hero.level += 1; hero.statPoints += 3; hero.hp = maxHp(hero); hero.energy = maxEnergy(hero); changed = true;
  }
  return changed;
}
function fullState(hero) {
  normalizeHero(hero);
  return { hero: publicHero(hero), derived: { totalStats: totalStats(hero), maxHp: maxHp(hero), maxEnergy: maxEnergy(hero), power: power(hero), defense: defense(hero), dodge: dodge(hero), crit: crit(hero) }, inventory: heroInv(hero.id).map(x => ({ ...x, item: item(x.itemId) })), shop: db.items, locations: LOCATIONS, leaderboard: db.heroes.slice().sort((a,b)=> b.level-a.level || b.exp-a.exp || b.kills-a.kills).slice(0,20).map(h=>({name:h.name, level:h.level, exp:h.exp, kills:h.kills, gold:h.gold})) };
}
function auth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  try { req.user = jwt.verify(token, JWT_SECRET); req.hero = getHero(req.user.id); if (!req.hero) throw new Error('no hero'); next(); }
  catch { res.status(401).json({ error: 'Требуется вход' }); }
}
function emitState(hero) { io.to(`hero:${hero.id}`).emit('state', fullState(hero)); }

app.post('/api/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const heroName = String(req.body.heroName || username).trim();
  if (!/^[a-zA-Zа-яА-Я0-9_ -]{3,20}$/.test(username) || password.length < 5) return res.status(400).json({ error: 'Логин 3-20 символов, пароль минимум 5.' });
  if (!/^[a-zA-Zа-яА-Я0-9_ -]{3,20}$/.test(heroName)) return res.status(400).json({ error: 'Имя героя 3-20 символов.' });
  if (getUserByName(username)) return res.status(409).json({ error: 'Логин занят.' });
  if (db.heroes.some(h => h.name.toLowerCase() === heroName.toLowerCase())) return res.status(409).json({ error: 'Имя героя занято.' });
  const user = { id: nanoid(), username, passwordHash: await bcrypt.hash(password, 10), createdAt: now() };
  const hero = { id: nanoid(), userId: user.id, name: heroName, level: 1, exp: 0, gold: 60, location: 'town', stats: { str: 5, agi: 5, con: 5 }, statPoints: 0, hp: 120, energy: 50, equipment: { weapon: null, armor: null, boots: null, ring: null }, kills: 0, deaths: 0, createdAt: now() };
  db.users.push(user); db.heroes.push(hero); saveDb();
  const token = jwt.sign({ id: user.id, username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, state: fullState(hero) });
});

app.post('/api/login', async (req, res) => {
  const user = getUserByName(req.body.username || '');
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.passwordHash))) return res.status(401).json({ error: 'Неверный логин или пароль.' });
  const hero = getHero(user.id); normalizeHero(hero); saveDb();
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, state: fullState(hero) });
});

app.get('/api/state', auth, (req, res) => res.json(fullState(req.hero)));
app.post('/api/location', auth, (req, res) => { const loc = req.body.location; if (!LOCATIONS[loc]) return res.status(400).json({error:'Нет такой локации'}); req.hero.location = loc; saveDb(); res.json(fullState(req.hero)); });
app.post('/api/stat', auth, (req, res) => { const stat = req.body.stat; if (!['str','agi','con'].includes(stat)) return res.status(400).json({error:'Неизвестная характеристика'}); if (req.hero.statPoints < 1) return res.status(400).json({error:'Нет свободных очков'}); req.hero.stats[stat]++; req.hero.statPoints--; normalizeHero(req.hero); saveDb(); res.json(fullState(req.hero)); });
app.post('/api/buy', auth, (req, res) => { const it = item(req.body.itemId); if (!it) return res.status(404).json({error:'Предмет не найден'}); if (req.hero.gold < it.price) return res.status(400).json({error:'Недостаточно золота'}); req.hero.gold -= it.price; db.inventory.push({ id:nanoid(), heroId:req.hero.id, itemId:it.id, createdAt:now() }); saveDb(); res.json(fullState(req.hero)); });
app.post('/api/equip', auth, (req, res) => { const inv = db.inventory.find(x => x.id === req.body.inventoryId && x.heroId === req.hero.id); if (!inv) return res.status(404).json({error:'Нет предмета'}); const it = item(inv.itemId); req.hero.equipment[it.slot] = it.id; normalizeHero(req.hero); saveDb(); res.json(fullState(req.hero)); });
app.post('/api/unequip', auth, (req, res) => { const slot = req.body.slot; if (!['weapon','armor','boots','ring'].includes(slot)) return res.status(400).json({error:'Слот неизвестен'}); req.hero.equipment[slot] = null; normalizeHero(req.hero); saveDb(); res.json(fullState(req.hero)); });
app.post('/api/rest', auth, (req, res) => { req.hero.hp = maxHp(req.hero); req.hero.energy = maxEnergy(req.hero); saveDb(); res.json(fullState(req.hero)); });
app.get('/api/messages', auth, (req,res)=> res.json(db.messages.slice(-60)));

function makeFighterFromHero(hero) { return { kind:'hero', heroId:hero.id, name:hero.name, level:hero.level, hp:maxHp(hero), maxHp:maxHp(hero), energy:maxEnergy(hero), maxEnergy:maxEnergy(hero), stats:totalStats(hero), power:power(hero), defense:defense(hero), dodge:dodge(hero), crit:crit(hero), guard:false }; }
function makeFighterFromMob(tpl, scale=1) {
  const level = tpl.level + Math.max(0, scale-1); const con = tpl.stats.con + scale;
  return { kind:'mob', name:tpl.name, level, hp:60+level*8+con*12, maxHp:60+level*8+con*12, energy:30, maxEnergy:30, stats:{str:tpl.stats.str+scale, agi:tpl.stats.agi+Math.floor(scale/2), con}, power:4+(tpl.stats.str+scale)*2+Math.floor(level*1.5), defense:Math.floor(con*.8+level), dodge:clamp(4+(tpl.stats.agi+scale)*1.1,4,28), crit:clamp(5+(tpl.stats.agi+scale)*.7,5,24), guard:false, reward:tpl };
}
function createCombat(type, a, b) {
  const c = { id:nanoid(), type, fighters:[a,b], turn:0, round:1, log:[`Бой начался: ${a.name} против ${b.name}`], status:'active', createdAt:now() };
  activeCombats.set(c.id,c); return c;
}
function combatForHero(heroId) { return [...activeCombats.values()].find(c => c.status==='active' && c.fighters.some(f=>f.heroId===heroId)); }
function emitCombat(c) { for (const f of c.fighters) if (f.heroId) io.to(`hero:${f.heroId}`).emit('combat', c); }
function performAction(c, actorIndex, action) {
  if (c.status !== 'active') return;
  if (actorIndex !== c.turn) return;
  const actor = c.fighters[actorIndex], target = c.fighters[1-actorIndex];
  actor.guard = false;
  let text = '';
  if (action === 'guard') { actor.guard = true; actor.energy = clamp(actor.energy + 10, 0, actor.maxEnergy); text = `${actor.name} встаёт в защиту и восстанавливает энергию.`; }
  else {
    let cost = action === 'power' ? 14 : action === 'precise' ? 8 : 0;
    if (actor.energy < cost) { cost = 0; action = 'attack'; }
    actor.energy -= cost;
    const miss = Math.random()*100 < target.dodge - (action==='precise' ? 10 : 0);
    if (miss) text = `${actor.name} промахивается по ${target.name}.`;
    else {
      let dmg = actor.power + rand(0, 6) - target.defense;
      if (action === 'power') dmg = Math.floor(dmg * 1.7) + 4;
      if (action === 'precise') dmg = Math.floor(dmg * .9) + 2;
      let isCrit = Math.random()*100 < actor.crit + (action==='precise' ? 8 : 0);
      if (isCrit) dmg = Math.floor(dmg * 1.6);
      if (target.guard) dmg = Math.floor(dmg * .55);
      dmg = Math.max(1, dmg);
      target.hp = clamp(target.hp - dmg, 0, target.maxHp);
      text = `${actor.name} наносит ${dmg} урона ${target.name}${isCrit ? ' (критический удар)' : ''}.`;
    }
  }
  c.log.push(text);
  if (target.hp <= 0) finishCombat(c, actor, target);
  else { c.turn = 1 - c.turn; if (c.turn === 0) c.round++; actor.energy = clamp(actor.energy + 4, 0, actor.maxEnergy); }
}
function finishCombat(c, winner, loser) {
  c.status = 'finished'; c.winner = winner.name; c.log.push(`${winner.name} побеждает!`);
  for (const f of c.fighters) if (f.heroId) { const h = getHeroById(f.heroId); if (h) { h.hp = Math.max(1, Math.floor(f.hp)); h.energy = f.energy; } }
  if (winner.heroId) {
    const h = getHeroById(winner.heroId);
    h.kills++;
    if (c.type === 'pve') { const r = loser.reward; const g = rand(r.gold[0], r.gold[1]); h.gold += g; h.exp += r.exp; c.log.push(`Награда: ${g} золота и ${r.exp} опыта.`); if (levelUp(h)) c.log.push(`${h.name} получает новый уровень!`); }
    else { h.gold += 15; h.exp += 20; c.log.push(`Награда за дуэль: 15 золота и 20 опыта.`); levelUp(h); }
  }
  if (loser.heroId) { const h = getHeroById(loser.heroId); h.deaths++; h.hp = Math.max(1, Math.floor(maxHp(h)*0.35)); }
  saveDb(); setTimeout(()=>activeCombats.delete(c.id), 1000*60*10);
}
function mobAutoMove(c) { if (c.status==='active') { const ai = c.fighters[c.turn]; if (ai.kind === 'mob') { const action = ai.energy >= 14 && Math.random() < .35 ? 'power' : Math.random() < .15 ? 'guard' : 'attack'; performAction(c, c.turn, action); emitCombat(c); } } }

io.use((socket,next)=>{ try { const token = socket.handshake.auth.token; const data = jwt.verify(token, JWT_SECRET); const hero = getHero(data.id); if (!hero) throw new Error('no hero'); socket.user = data; socket.hero = hero; next(); } catch(e){ next(new Error('auth')); } });
io.on('connection', socket => {
  const hero = socket.hero; socket.join(`hero:${hero.id}`); socket.emit('state', fullState(hero));
  const old = combatForHero(hero.id); if (old) socket.emit('combat', old);

  socket.on('chat', msg => { const text = String(msg || '').trim().slice(0, 240); if (!text) return; const m = { id:nanoid(), hero:hero.name, text, at:now() }; db.messages.push(m); db.messages = db.messages.slice(-200); saveDb(); io.emit('chat', m); });
  socket.on('pve:start', () => {
    if (combatForHero(hero.id)) return socket.emit('toast','Вы уже в бою.');
    if (!MOBS[hero.location]) return socket.emit('toast','В этой локации не на кого охотиться.');
    normalizeHero(hero); if (hero.hp < 2) return socket.emit('toast','Сначала отдохните.');
    const list = MOBS[hero.location]; const tpl = list[rand(0, list.length-1)]; const c = createCombat('pve', makeFighterFromHero(hero), makeFighterFromMob(tpl, Math.max(1, hero.level - tpl.level + 1))); emitCombat(c);
  });
  socket.on('pvp:join', () => {
    if (combatForHero(hero.id)) return socket.emit('toast','Вы уже в бою.');
    if (pvpQueue.includes(hero.id)) return socket.emit('toast','Вы уже в очереди.');
    const opponentId = pvpQueue.find(id => id !== hero.id);
    if (!opponentId) { pvpQueue.push(hero.id); return socket.emit('toast','Вы в очереди арены.'); }
    pvpQueue.splice(pvpQueue.indexOf(opponentId),1);
    const a = getHeroById(opponentId), b = hero; normalizeHero(a); normalizeHero(b);
    const c = createCombat('pvp', makeFighterFromHero(a), makeFighterFromHero(b)); emitCombat(c);
  });
  socket.on('pvp:leave',()=>{ const i=pvpQueue.indexOf(hero.id); if(i>=0){pvpQueue.splice(i,1); socket.emit('toast','Вы вышли из очереди.');} });
  socket.on('combat:action', action => {
    const c = combatForHero(hero.id); if (!c) return;
    const idx = c.fighters.findIndex(f=>f.heroId===hero.id); if (idx !== c.turn) return socket.emit('toast','Сейчас ход противника.');
    if (!['attack','power','precise','guard'].includes(action)) return;
    performAction(c, idx, action); emitCombat(c); setTimeout(()=>mobAutoMove(c), 550);
    for (const f of c.fighters) if (f.heroId) { const h = getHeroById(f.heroId); if (h) emitState(h); }
  });
});

server.listen(PORT, () => console.log(`RPG server: http://localhost:${PORT}`));
