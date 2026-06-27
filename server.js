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

const baseDb = { users: [], heroes: [], items: [], inventory: [], messages: [], cooldowns: {} };
let db = loadDb();

const pvpQueue = [];
const activeCombats = new Map();

const LOCATIONS = {
  town: { name: 'Поселение', icon: '🏘️', desc: 'Отдых, торговля, разговоры и подготовка к походам.', gather: null },
  forest: { name: 'Тёмный лес', icon: '🌲', desc: 'Слабые звери, травы и разбойники.', gather: { itemId: 'wild_herb', name: 'собрать травы' } },
  mine: { name: 'Старые шахты', icon: '⛏️', desc: 'Крепкие твари, руда и повышенные награды.', gather: { itemId: 'iron_ore', name: 'добыть руду' } },
  arena: { name: 'Арена', icon: '⚔️', desc: 'Очередь дуэлей с другими игроками.', gather: null }
};

const MOBS = {
  forest: [
    { name: 'Дикий волк', level: 1, stats: { str: 3, agi: 3, con: 3 }, gold: [5, 12], exp: 8 },
    { name: 'Лесной разбойник', level: 2, stats: { str: 5, agi: 4, con: 4 }, gold: [8, 18], exp: 14 },
    { name: 'Матёрый кабан', level: 3, stats: { str: 6, agi: 2, con: 6 }, gold: [12, 22], exp: 18 }
  ],
  mine: [
    { name: 'Пещерный тролль', level: 4, stats: { str: 8, agi: 2, con: 8 }, gold: [18, 35], exp: 28 },
    { name: 'Железный скорпион', level: 5, stats: { str: 7, agi: 7, con: 6 }, gold: [24, 45], exp: 38 },
    { name: 'Слепой рудокоп', level: 6, stats: { str: 9, agi: 4, con: 9 }, gold: [32, 55], exp: 48 }
  ]
};

const QUESTS = [
  { id: 'first_blood', title: 'Первая кровь', desc: 'Победите 3 монстров.', type: 'pveKills', need: 3, reward: { gold: 40, exp: 35, itemId: 'small_potion', reputation: 1 } },
  { id: 'forest_order', title: 'Лесной дозор', desc: 'Победите 5 врагов в Тёмном лесу.', type: 'locationKills', location: 'forest', need: 5, reward: { gold: 90, exp: 70, itemId: 'energy_brew', reputation: 2 } },
  { id: 'miner_contract', title: 'Шахтёрский подряд', desc: 'Добудьте 4 куска железной руды.', type: 'gather', itemId: 'iron_ore', need: 4, reward: { gold: 120, exp: 80, reputation: 2 } },
  { id: 'arena_trial', title: 'Испытание арены', desc: 'Победите 1 игрока на арене.', type: 'pvpWins', need: 1, reward: { gold: 160, exp: 120, itemId: 'war_ring', reputation: 4 } }
];

seedItems();
migrateHeroes();
saveDb();

function loadDb() {
  try { return { ...baseDb, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; }
  catch {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(baseDb, null, 2));
    return structuredClone(baseDb);
  }
}
function saveDb() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(`${DB_FILE}.tmp`, JSON.stringify(db, null, 2));
  fs.renameSync(`${DB_FILE}.tmp`, DB_FILE);
}
function now() { return Date.now(); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function chance(p) { return Math.random() < p; }
function dayKey() { return new Date().toISOString().slice(0, 10); }
function escapeId(id) { return String(id || '').replace(/[^a-zA-Z0-9_-]/g, ''); }

function seedItems() {
  const items = [
    { id: 'rusty_axe', name: 'Ржавый топор', type: 'equipment', slot: 'weapon', rarity: 'common', price: 35, stats: { str: 2 }, desc: '+2 сила' },
    { id: 'bone_club', name: 'Костяная дубина', type: 'equipment', slot: 'weapon', rarity: 'uncommon', price: 95, stats: { str: 4, con: 1 }, desc: '+4 сила, +1 выносливость' },
    { id: 'raider_sabre', name: 'Сабля налётчика', type: 'equipment', slot: 'weapon', rarity: 'rare', price: 230, stats: { str: 5, agi: 4 }, desc: '+5 сила, +4 ловкость' },
    { id: 'leather_vest', name: 'Кожаный жилет', type: 'equipment', slot: 'armor', rarity: 'common', price: 50, stats: { con: 3 }, desc: '+3 выносливость' },
    { id: 'iron_plate', name: 'Железная пластина', type: 'equipment', slot: 'armor', rarity: 'uncommon', price: 140, stats: { con: 6, agi: -1 }, desc: '+6 выносливость, -1 ловкость' },
    { id: 'hunter_boots', name: 'Сапоги охотника', type: 'equipment', slot: 'boots', rarity: 'common', price: 65, stats: { agi: 3 }, desc: '+3 ловкость' },
    { id: 'shadow_boots', name: 'Теневые сапоги', type: 'equipment', slot: 'boots', rarity: 'rare', price: 210, stats: { agi: 6, str: 1 }, desc: '+6 ловкость, +1 сила' },
    { id: 'war_ring', name: 'Кольцо ярости', type: 'equipment', slot: 'ring', rarity: 'rare', price: 180, stats: { str: 3, agi: 2 }, desc: '+3 сила, +2 ловкость' },
    { id: 'small_potion', name: 'Малое зелье жизни', type: 'consumable', rarity: 'common', price: 28, effect: { hp: 65 }, desc: 'Восстанавливает 65 HP' },
    { id: 'energy_brew', name: 'Брага бодрости', type: 'consumable', rarity: 'common', price: 32, effect: { energy: 35 }, desc: 'Восстанавливает 35 энергии' },
    { id: 'wild_herb', name: 'Дикая трава', type: 'material', rarity: 'common', price: 8, desc: 'Материал. Можно продать в лавке.' },
    { id: 'iron_ore', name: 'Железная руда', type: 'material', rarity: 'common', price: 14, desc: 'Материал. Нужна для заданий и продажи.' }
  ];
  for (const next of items) {
    const old = db.items.find(i => i.id === next.id);
    if (old) Object.assign(old, next); else db.items.push(next);
  }
}
function migrateHeroes() { for (const h of db.heroes) normalizeHero(h, true); }

function getUserByName(username) { return db.users.find(u => u.username.toLowerCase() === String(username).toLowerCase()); }
function getHero(userId) { return db.heroes.find(h => h.userId === userId); }
function getHeroById(id) { return db.heroes.find(h => h.id === id); }
function heroInv(heroId) { return db.inventory.filter(x => x.heroId === heroId); }
function item(id) { return db.items.find(i => i.id === id); }
function invItem(id, heroId) { return db.inventory.find(x => x.id === id && x.heroId === heroId); }
function publicHero(hero) { return { ...hero }; }
function addInventory(hero, itemId, qty = 1) {
  for (let i = 0; i < qty; i++) db.inventory.push({ id: nanoid(), heroId: hero.id, itemId, createdAt: now() });
}
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
function normalizeHero(hero, migrate = false) {
  hero.stats ||= { str: 5, agi: 5, con: 5 };
  hero.equipment ||= { weapon: null, armor: null, boots: null, ring: null };
  hero.kills ||= 0; hero.deaths ||= 0; hero.statPoints ||= 0; hero.exp ||= 0; hero.gold ||= 0; hero.level ||= 1; hero.location ||= 'town';
  hero.reputation ||= 0;
  hero.questProgress ||= { pveKills: 0, pvpWins: 0, locationKills: {}, gather: {}, claimed: [] };
  hero.questProgress.locationKills ||= {}; hero.questProgress.gather ||= {}; hero.questProgress.claimed ||= [];
  hero.daily ||= { date: dayKey(), pveKills: 0, gathers: 0, claimed: false };
  if (hero.daily.date !== dayKey()) hero.daily = { date: dayKey(), pveKills: 0, gathers: 0, claimed: false };
  hero.cooldowns ||= {};
  if (!hero.hp || hero.hp < 1) hero.hp = maxHp(hero);
  if (!hero.energy && hero.energy !== 0) hero.energy = maxEnergy(hero);
  hero.hp = clamp(hero.hp, 0, maxHp(hero));
  hero.energy = clamp(hero.energy, 0, maxEnergy(hero));
  if (migrate && hero.hp > maxHp(hero)) hero.hp = maxHp(hero);
}
function levelUp(hero) {
  let changed = false;
  while (hero.exp >= hero.level * 50) {
    hero.exp -= hero.level * 50; hero.level += 1; hero.statPoints += 3; hero.hp = maxHp(hero); hero.energy = maxEnergy(hero); changed = true;
  }
  return changed;
}
function questValue(hero, q) {
  const p = hero.questProgress;
  if (q.type === 'pveKills') return p.pveKills || 0;
  if (q.type === 'pvpWins') return p.pvpWins || 0;
  if (q.type === 'locationKills') return p.locationKills?.[q.location] || 0;
  if (q.type === 'gather') return p.gather?.[q.itemId] || 0;
  return 0;
}
function questState(hero) {
  const regular = QUESTS.map(q => ({ ...q, progress: clamp(questValue(hero, q), 0, q.need), done: questValue(hero, q) >= q.need, claimed: hero.questProgress.claimed.includes(q.id) }));
  const dailyNeed = 3;
  const dailyProgress = Math.min(dailyNeed, (hero.daily.pveKills || 0) + (hero.daily.gathers || 0));
  const daily = { id: 'daily_hunt', title: 'Ежедневная вылазка', desc: 'Сделайте 3 полезных действия: победы PvE или сбор ресурсов.', need: dailyNeed, progress: dailyProgress, done: dailyProgress >= dailyNeed, claimed: hero.daily.claimed, reward: { gold: 75, exp: 45, itemId: 'small_potion' } };
  return { regular, daily };
}
function fullState(hero) {
  normalizeHero(hero);
  return {
    hero: publicHero(hero),
    derived: { totalStats: totalStats(hero), maxHp: maxHp(hero), maxEnergy: maxEnergy(hero), power: power(hero), defense: defense(hero), dodge: dodge(hero), crit: crit(hero) },
    inventory: heroInv(hero.id).map(x => ({ ...x, item: item(x.itemId) })).filter(x => x.item),
    shop: db.items.filter(i => i.type !== 'material'),
    locations: LOCATIONS,
    quests: questState(hero),
    queue: { arena: pvpQueue.length },
    cooldowns: hero.cooldowns || {},
    leaderboard: db.heroes.slice().sort((a,b)=> b.level-a.level || b.exp-a.exp || b.kills-a.kills).slice(0,20).map(h=>({name:h.name, level:h.level, exp:h.exp, kills:h.kills, deaths:h.deaths || 0, gold:h.gold, reputation:h.reputation || 0}))
  };
}
function auth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  try { req.user = jwt.verify(token, JWT_SECRET); req.hero = getHero(req.user.id); if (!req.hero) throw new Error('no hero'); normalizeHero(req.hero); next(); }
  catch { res.status(401).json({ error: 'Требуется вход' }); }
}
function emitState(hero) { io.to(`hero:${hero.id}`).emit('state', fullState(hero)); }
function addQuestProgress(hero, type, data = {}) {
  normalizeHero(hero);
  if (type === 'pveKill') {
    hero.questProgress.pveKills = (hero.questProgress.pveKills || 0) + 1;
    hero.questProgress.locationKills[data.location] = (hero.questProgress.locationKills[data.location] || 0) + 1;
    hero.daily.pveKills = (hero.daily.pveKills || 0) + 1;
  }
  if (type === 'pvpWin') hero.questProgress.pvpWins = (hero.questProgress.pvpWins || 0) + 1;
  if (type === 'gather') {
    hero.questProgress.gather[data.itemId] = (hero.questProgress.gather[data.itemId] || 0) + 1;
    hero.daily.gathers = (hero.daily.gathers || 0) + 1;
  }
}
function grantReward(hero, reward, log = []) {
  if (reward.gold) { hero.gold += reward.gold; log.push(`+${reward.gold} золота`); }
  if (reward.exp) { hero.exp += reward.exp; log.push(`+${reward.exp} опыта`); }
  if (reward.reputation) { hero.reputation = (hero.reputation || 0) + reward.reputation; log.push(`+${reward.reputation} репутации`); }
  if (reward.itemId) { addInventory(hero, reward.itemId); log.push(`предмет: ${item(reward.itemId)?.name || reward.itemId}`); }
  if (levelUp(hero)) log.push('новый уровень');
  normalizeHero(hero);
}

app.post('/api/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const heroName = String(req.body.heroName || username).trim();
  if (!/^[a-zA-Zа-яА-Я0-9_ -]{3,20}$/.test(username) || password.length < 5) return res.status(400).json({ error: 'Логин 3-20 символов, пароль минимум 5.' });
  if (!/^[a-zA-Zа-яА-Я0-9_ -]{3,20}$/.test(heroName)) return res.status(400).json({ error: 'Имя героя 3-20 символов.' });
  if (getUserByName(username)) return res.status(409).json({ error: 'Логин занят.' });
  if (db.heroes.some(h => h.name.toLowerCase() === heroName.toLowerCase())) return res.status(409).json({ error: 'Имя героя занято.' });
  const user = { id: nanoid(), username, passwordHash: await bcrypt.hash(password, 10), createdAt: now() };
  const hero = { id: nanoid(), userId: user.id, name: heroName, level: 1, exp: 0, gold: 80, location: 'town', stats: { str: 5, agi: 5, con: 5 }, statPoints: 0, hp: 128, energy: 52, equipment: { weapon: null, armor: null, boots: null, ring: null }, kills: 0, deaths: 0, reputation: 0, createdAt: now() };
  normalizeHero(hero); addInventory(hero, 'small_potion');
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
app.post('/api/location', auth, (req, res) => { const loc = escapeId(req.body.location); if (!LOCATIONS[loc]) return res.status(400).json({error:'Нет такой локации'}); if (combatForHero(req.hero.id)) return res.status(400).json({error:'Нельзя сменить локацию в бою'}); req.hero.location = loc; saveDb(); res.json(fullState(req.hero)); });
app.post('/api/stat', auth, (req, res) => { const stat = req.body.stat; if (!['str','agi','con'].includes(stat)) return res.status(400).json({error:'Неизвестная характеристика'}); if (req.hero.statPoints < 1) return res.status(400).json({error:'Нет свободных очков'}); req.hero.stats[stat]++; req.hero.statPoints--; normalizeHero(req.hero); saveDb(); res.json(fullState(req.hero)); });
app.post('/api/buy', auth, (req, res) => { const it = item(req.body.itemId); if (!it || it.type === 'material') return res.status(404).json({error:'Предмет не найден'}); if (req.hero.gold < it.price) return res.status(400).json({error:'Недостаточно золота'}); req.hero.gold -= it.price; addInventory(req.hero, it.id); saveDb(); res.json(fullState(req.hero)); });
app.post('/api/sell', auth, (req, res) => { const inv = invItem(req.body.inventoryId, req.hero.id); if (!inv) return res.status(404).json({error:'Нет предмета'}); const it = item(inv.itemId); if (Object.values(req.hero.equipment || {}).includes(it.id)) return res.status(400).json({error:'Сначала снимите предмет этого типа'}); const price = Math.max(1, Math.floor((it.price || 1) * 0.5)); req.hero.gold += price; db.inventory = db.inventory.filter(x => x.id !== inv.id); saveDb(); res.json(fullState(req.hero)); });
app.post('/api/equip', auth, (req, res) => { const inv = invItem(req.body.inventoryId, req.hero.id); if (!inv) return res.status(404).json({error:'Нет предмета'}); const it = item(inv.itemId); if (!it || it.type !== 'equipment') return res.status(400).json({error:'Этот предмет нельзя надеть'}); req.hero.equipment[it.slot] = it.id; normalizeHero(req.hero); saveDb(); res.json(fullState(req.hero)); });
app.post('/api/unequip', auth, (req, res) => { const slot = req.body.slot; if (!['weapon','armor','boots','ring'].includes(slot)) return res.status(400).json({error:'Слот неизвестен'}); req.hero.equipment[slot] = null; normalizeHero(req.hero); saveDb(); res.json(fullState(req.hero)); });
app.post('/api/use', auth, (req, res) => { const inv = invItem(req.body.inventoryId, req.hero.id); if (!inv) return res.status(404).json({error:'Нет предмета'}); const it = item(inv.itemId); if (!it || it.type !== 'consumable') return res.status(400).json({error:'Этот предмет нельзя использовать'}); if (it.effect?.hp) req.hero.hp = clamp(req.hero.hp + it.effect.hp, 0, maxHp(req.hero)); if (it.effect?.energy) req.hero.energy = clamp(req.hero.energy + it.effect.energy, 0, maxEnergy(req.hero)); db.inventory = db.inventory.filter(x => x.id !== inv.id); saveDb(); res.json(fullState(req.hero)); });
app.post('/api/rest', auth, (req, res) => { if (req.hero.location !== 'town') return res.status(400).json({error:'Отдых доступен только в поселении'}); req.hero.hp = maxHp(req.hero); req.hero.energy = maxEnergy(req.hero); saveDb(); res.json(fullState(req.hero)); });
app.post('/api/gather', auth, (req, res) => {
  if (combatForHero(req.hero.id)) return res.status(400).json({error:'Нельзя собирать ресурсы в бою'});
  const loc = LOCATIONS[req.hero.location]; if (!loc?.gather) return res.status(400).json({error:'В этой локации нечего собирать'});
  const cdKey = `gather:${req.hero.location}`; const left = (req.hero.cooldowns[cdKey] || 0) - now(); if (left > 0) return res.status(400).json({error:`Можно снова через ${Math.ceil(left/1000)} сек.`});
  if (req.hero.energy < 10) return res.status(400).json({error:'Недостаточно энергии'});
  req.hero.energy -= 10; req.hero.cooldowns[cdKey] = now() + 20_000;
  addInventory(req.hero, loc.gather.itemId); addQuestProgress(req.hero, 'gather', { itemId: loc.gather.itemId });
  const exp = req.hero.location === 'mine' ? 8 : 5; const gold = req.hero.location === 'mine' ? rand(3, 8) : rand(1, 5);
  req.hero.exp += exp; req.hero.gold += gold; const logs = [`Вы добыли: ${item(loc.gather.itemId).name}`, `+${gold} золота`, `+${exp} опыта`]; if (levelUp(req.hero)) logs.push('новый уровень');
  saveDb(); res.json({ ...fullState(req.hero), notice: logs.join(', ') });
});
app.post('/api/quest/claim', auth, (req, res) => {
  const id = escapeId(req.body.id); const log = [];
  if (id === 'daily_hunt') {
    const daily = questState(req.hero).daily;
    if (!daily.done) return res.status(400).json({error:'Ежедневное задание ещё не выполнено'});
    if (req.hero.daily.claimed) return res.status(400).json({error:'Награда уже получена'});
    req.hero.daily.claimed = true; grantReward(req.hero, daily.reward, log); saveDb(); return res.json({ ...fullState(req.hero), notice: `Награда: ${log.join(', ')}` });
  }
  const q = QUESTS.find(x => x.id === id); if (!q) return res.status(404).json({error:'Задание не найдено'});
  if (req.hero.questProgress.claimed.includes(q.id)) return res.status(400).json({error:'Награда уже получена'});
  if (questValue(req.hero, q) < q.need) return res.status(400).json({error:'Задание ещё не выполнено'});
  req.hero.questProgress.claimed.push(q.id); grantReward(req.hero, q.reward, log); saveDb(); res.json({ ...fullState(req.hero), notice: `Награда: ${log.join(', ')}` });
});
app.get('/api/messages', auth, (req,res)=> res.json(db.messages.slice(-80)));

function makeFighterFromHero(hero) { return { kind:'hero', heroId:hero.id, name:hero.name, level:hero.level, hp:hero.hp, maxHp:maxHp(hero), energy:hero.energy, maxEnergy:maxEnergy(hero), stats:totalStats(hero), power:power(hero), defense:defense(hero), dodge:dodge(hero), crit:crit(hero), guard:false, fury:0 }; }
function makeFighterFromMob(tpl, scale=1, location='forest') {
  const level = tpl.level + Math.max(0, scale-1); const con = tpl.stats.con + scale;
  return { kind:'mob', name:tpl.name, level, hp:60+level*8+con*12, maxHp:60+level*8+con*12, energy:30, maxEnergy:30, stats:{str:tpl.stats.str+scale, agi:tpl.stats.agi+Math.floor(scale/2), con}, power:4+(tpl.stats.str+scale)*2+Math.floor(level*1.5), defense:Math.floor(con*.8+level), dodge:clamp(4+(tpl.stats.agi+scale)*1.1,4,28), crit:clamp(5+(tpl.stats.agi+scale)*.7,5,24), guard:false, fury:0, reward:{...tpl, location} };
}
function createCombat(type, a, b) { const c = { id:nanoid(), type, fighters:[a,b], turn:0, round:1, log:[`Бой начался: ${a.name} против ${b.name}`], status:'active', createdAt:now() }; activeCombats.set(c.id,c); return c; }
function combatForHero(heroId) { return [...activeCombats.values()].find(c => c.status==='active' && c.fighters.some(f=>f.heroId===heroId)); }
function emitCombat(c) { for (const f of c.fighters) if (f.heroId) io.to(`hero:${f.heroId}`).emit('combat', c); }
function performAction(c, actorIndex, action) {
  if (c.status !== 'active' || actorIndex !== c.turn) return;
  const actor = c.fighters[actorIndex], target = c.fighters[1-actorIndex];
  actor.guard = false;
  let text = '';
  if (action === 'guard') { actor.guard = true; actor.energy = clamp(actor.energy + 12, 0, actor.maxEnergy); actor.fury = clamp((actor.fury || 0) + 1, 0, 3); text = `${actor.name} встаёт в защиту, копит ярость и восстанавливает энергию.`; }
  else {
    let cost = action === 'power' ? 14 : action === 'precise' ? 8 : action === 'rage' ? 22 : 0;
    if (actor.energy < cost) { cost = 0; action = 'attack'; }
    actor.energy -= cost;
    const miss = Math.random()*100 < target.dodge - (action==='precise' ? 10 : 0);
    if (miss) text = `${actor.name} промахивается по ${target.name}.`;
    else {
      let dmg = actor.power + rand(0, 6) - target.defense;
      if (action === 'power') dmg = Math.floor(dmg * 1.7) + 4;
      if (action === 'precise') dmg = Math.floor(dmg * .9) + 2;
      if (action === 'rage') { dmg = Math.floor(dmg * 2.05) + 7 + (actor.fury || 0) * 3; actor.fury = 0; }
      let isCrit = Math.random()*100 < actor.crit + (action==='precise' ? 8 : 0);
      if (isCrit) dmg = Math.floor(dmg * 1.6);
      if (target.guard) dmg = Math.floor(dmg * .55);
      dmg = Math.max(1, dmg);
      target.hp = clamp(target.hp - dmg, 0, target.maxHp);
      actor.fury = clamp((actor.fury || 0) + 1, 0, 3);
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
    const h = getHeroById(winner.heroId); h.kills++;
    if (c.type === 'pve') {
      const r = loser.reward; const g = rand(r.gold[0], r.gold[1]); h.gold += g; h.exp += r.exp; addQuestProgress(h, 'pveKill', { location: r.location }); c.log.push(`Награда: ${g} золота и ${r.exp} опыта.`);
      if (chance(0.28)) { const drop = chance(0.72) ? 'small_potion' : (r.location === 'mine' ? 'iron_ore' : 'wild_herb'); addInventory(h, drop); c.log.push(`Добыча: ${item(drop).name}.`); }
      if (chance(0.08)) { const drop = r.location === 'mine' ? 'shadow_boots' : 'hunter_boots'; addInventory(h, drop); c.log.push(`Редкая добыча: ${item(drop).name}!`); }
      if (levelUp(h)) c.log.push(`${h.name} получает новый уровень!`);
    } else { h.gold += 18; h.exp += 24; addQuestProgress(h, 'pvpWin'); c.log.push(`Награда за дуэль: 18 золота и 24 опыта.`); levelUp(h); }
  }
  if (loser.heroId) { const h = getHeroById(loser.heroId); h.deaths++; h.hp = Math.max(1, Math.floor(maxHp(h)*0.35)); }
  saveDb(); setTimeout(()=>activeCombats.delete(c.id), 1000*60*10);
}
function mobAutoMove(c) { if (c.status==='active') { const ai = c.fighters[c.turn]; if (ai.kind === 'mob') { const action = ai.energy >= 22 && Math.random() < .18 ? 'rage' : ai.energy >= 14 && Math.random() < .32 ? 'power' : Math.random() < .14 ? 'guard' : 'attack'; performAction(c, c.turn, action); emitCombat(c); } } }

io.use((socket,next)=>{ try { const token = socket.handshake.auth.token; const data = jwt.verify(token, JWT_SECRET); const hero = getHero(data.id); if (!hero) throw new Error('no hero'); normalizeHero(hero); socket.user = data; socket.hero = hero; next(); } catch(e){ next(new Error('auth')); } });
io.on('connection', socket => {
  const hero = socket.hero; socket.join(`hero:${hero.id}`); socket.emit('state', fullState(hero));
  const old = combatForHero(hero.id); if (old) socket.emit('combat', old);
  socket.on('chat', msg => { const text = String(msg || '').trim().slice(0, 240); if (!text) return; const m = { id:nanoid(), hero:hero.name, text, at:now() }; db.messages.push(m); db.messages = db.messages.slice(-250); saveDb(); io.emit('chat', m); });
  socket.on('pve:start', () => {
    if (combatForHero(hero.id)) return socket.emit('toast','Вы уже в бою.');
    if (!MOBS[hero.location]) return socket.emit('toast','В этой локации не на кого охотиться.');
    normalizeHero(hero); if (hero.hp < 2) return socket.emit('toast','Сначала отдохните.');
    const list = MOBS[hero.location]; const tpl = list[rand(0, list.length-1)]; const c = createCombat('pve', makeFighterFromHero(hero), makeFighterFromMob(tpl, Math.max(1, hero.level - tpl.level + 1), hero.location)); emitCombat(c);
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
    if (!['attack','power','precise','guard','rage'].includes(action)) return;
    performAction(c, idx, action); emitCombat(c); setTimeout(()=>mobAutoMove(c), 550);
    for (const f of c.fighters) if (f.heroId) { const h = getHeroById(f.heroId); if (h) emitState(h); }
  });
});

server.listen(PORT, () => console.log(`RPG server: http://localhost:${PORT}`));
