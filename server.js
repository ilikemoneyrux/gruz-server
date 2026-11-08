// Serwer Gruz Client: znajomi, wiadomości, party, profile, synchronizacja kosmetyków i emotek.
// Logowanie bez haseł: gracz potwierdza konto Minecraft tym samym mechanizmem co przy wejściu na serwer
// (sessionserver.mojang.com join -> hasJoined), więc nikt nie podszyje się pod cudzy nick.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const DATA = process.env.GRUZ_DATA || path.join(__dirname, 'data');
const MOJANG = process.env.GRUZ_SESSION_URL || 'https://sessionserver.mojang.com/session/minecraft/hasJoined';
const VERSION = '1.10.0';
const PUBLIC_URL = (process.env.GRUZ_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://gruz-server.onrender.com').replace(/\/$/, '');
const TZ = process.env.GRUZ_TZ || 'Europe/Warsaw';
const ADMIN_PASSWORD = process.env.GRUZ_ADMIN_PASSWORD || '';
const storage = require('./storage');

// ---------------- magazyn danych (pliki JSON, zapis z opóźnieniem) ----------------
// dane trzymamy w pamięci, a zapisujemy z opóźnieniem (pliki albo PostgreSQL – patrz storage.js)
const db = {
  users: {},   // uuid -> { uuid, name, friends[], incoming[], outgoing[], cosmetics, stats, firstSeen, lastSeen }
  dms: {},     // "uuidA|uuidB" (posortowane) -> [{ from, text|voice|sticker, at }]
  codes: {},   // KOD -> { cosmetic, maxUses, used: [uuid], created, note }
  news: [],    // [{ id, date, tag, title, body }] – publikowane w /news.json
  servers: {}, // "hypixel.net" -> { ms, players: [uuid], sessions, last } – topka serwerów
  discord: {}, // ustawienia bota Discord (język, kanały, tickety, giveawaye)
  crashes: [], // raporty crashy wysłane z launchera (najnowsze na początku)
  promo: { partners: [], ads: [], creatorReward: 'cape:nebula' }, // serwery partnerskie, reklamy, nagrody za kody i zaproszenia
  creators: {}, // KOD -> { code, name, discordId, cosmetic, uses: [uuid], created } – kody twórców
  meta: {},     // { week, lastWeekly } – tygodniowy ranking
  metrics: { days: {}, today: null }, // aktywni gracze dziennie, szczyt online, wersje launchera (wykresy w panelu)
  capes: {},    // id -> { id, pl, en, unlock, level, ver, created } – własne peleryny z panelu (obrazki osobno, capes.js)
  shop: { token: '', items: {} }, // sklep Tebex: publiczny token i pakiet -> kosmetyka (shop.js)
  purchases: [], // zakupy z webhooków Tebexa (najnowsze na początku)
  shots: [],     // screeny z gry: [{ id, uuid, at, w, h, server, size }] – obrazki osobno (shots.js)
};
const FILES = [['users.json', 'users'], ['dms.json', 'dms'], ['codes.json', 'codes'], ['news.json', 'news'],
  ['servers.json', 'servers'], ['discord.json', 'discord'], ['crashes.json', 'crashes'], ['promo.json', 'promo'], ['creators.json', 'creators'],
  ['meta.json', 'meta'], ['metrics.json', 'metrics'], ['capes.json', 'capes'], ['shop.json', 'shop'], ['purchases.json', 'purchases'], ['shots.json', 'shots']];
let saveTimer = null, saving = false, again = false;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 2000);
}
async function flush() {
  if (saving) { again = true; return; }
  saving = true;
  try {
    for (const [name, key] of FILES) await storage.save(name, db[key]);
  } catch (e) {
    console.error('[zapis]', e.message);
  } finally {
    saving = false;
    if (again) { again = false; save(); }
  }
}

const dashed = (u) => String(u).replace(/-/g, '').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5').toLowerCase();
const now = () => Date.now();

// ---------------- daty (strefa serwera Gruz, domyślnie Polska) ----------------
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
/** "2026-10-31" w strefie TZ */
const dayKey = (ms = now()) => dayFmt.format(new Date(ms));
const dayBefore = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10); };
/** Tydzień ISO, np. "2026-W44" (od poniedziałku) */
function weekKey(ms = now()) {
  const [y, m, d] = dayKey(ms).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 3 - ((dt.getUTCDay() + 6) % 7));
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() + 3 - ((firstThu.getUTCDay() + 6) % 7));
  return `${dt.getUTCFullYear()}-W${String(1 + Math.round((dt - firstThu) / 6048e5)).padStart(2, '0')}`;
}

function user(uuid) { return db.users[uuid]; }
function ensureUser(uuid, name) {
  if (!db.users[uuid]) {
    db.users[uuid] = { uuid, name, friends: [], incoming: [], outgoing: [], cosmetics: '', stats: {}, firstSeen: now(), lastSeen: now(),
      joinIndex: Object.keys(db.users).length + 1, unlocked: [], badges: [], partiesLed: 0, partiesJoined: 0, dmsSent: 0,
      wk: { week: weekKey(), xp0: 0 } };
  }
  const u = db.users[uuid];
  for (const [k, v] of [['unlocked', []], ['badges', []], ['partiesLed', 0], ['partiesJoined', 0], ['dmsSent', 0]]) if (u[k] === undefined) u[k] = v;
  if (!u.wk) u.wk = { week: weekKey(), xp0: xpOf(u) }; // starsi gracze: ranking tygodnia liczy się od teraz
  u.name = name;
  u.lastSeen = now();
  save();
  return u;
}
function byName(name) {
  const n = String(name || '').toLowerCase();
  return Object.values(db.users).find((u) => u.name.toLowerCase() === n);
}

// ---------------- poziomy i odznaki ----------------
const hoursOf = (u) => (u.stats?.totalMs || 0) / 36e5;
function xpOf(u) {
  return Math.round(hoursOf(u) * 60 + (u.stats?.kills || 0) * 4 + u.friends.length * 25
    + (u.partiesLed || 0) * 15 + (u.partiesJoined || 0) * 10 + Math.min(500, (u.dmsSent || 0) * 0.5) + (u.bonusXp || 0));
}
/** XP zdobyte w tym tygodniu (ranking tygodniowy) */
const weeklyXp = (u) => (u.wk && u.wk.week === weekKey() ? Math.max(0, xpOf(u) - (u.wk.xp0 || 0)) : 0);
/** Poziom: każdy kolejny wymaga 15% więcej XP (100, 115, 132…) */
function levelOf(u) {
  let level = 1, need = 100, rest = xpOf(u);
  while (rest >= need && level < 200) { rest -= need; level++; need = Math.round(need * 1.15); }
  return { level, xp: rest, next: need, total: xpOf(u) };
}
const BADGES = [
  { id: 'pioneer', pl: 'Pionier', en: 'Pioneer', test: (u) => (u.joinIndex || 9999) <= 100 },
  { id: 'hours10', pl: '10 godzin w grze', en: '10 hours played', test: (u) => hoursOf(u) >= 10 },
  { id: 'hours100', pl: '100 godzin w grze', en: '100 hours played', test: (u) => hoursOf(u) >= 100 },
  { id: 'social', pl: 'Towarzyski (5 znajomych)', en: 'Social (5 friends)', test: (u) => u.friends.length >= 5 },
  { id: 'leader', pl: 'Lider party', en: 'Party leader', test: (u) => (u.partiesLed || 0) >= 1 },
  { id: 'slayer', pl: 'Zabójca (100 killi)', en: 'Slayer (100 kills)', test: (u) => (u.stats?.kills || 0) >= 100 },
  { id: 'collector', pl: 'Kolekcjoner', en: 'Collector', test: (u) => (u.unlocked || []).length >= 1 },
  { id: 'level10', pl: 'Poziom 10', en: 'Level 10', test: (u) => levelOf(u).level >= 10 },
  { id: 'staff', pl: 'Ekipa Gruz', en: 'Gruz staff', test: (u) => !!u.staff },
];
/** Liczy odznaki i powiadamia o nowych */
function updateBadges(uuid) {
  const u = user(uuid);
  if (!u) return;
  checkLevel(u);
  const have = BADGES.filter((b) => b.test(u)).map((b) => b.id);
  const fresh = have.filter((id) => !u.badges.includes(id));
  u.badges = have;
  const passNew = progress.passCheck(u);
  if (fresh.length) {
    progress.rewardXp(u, fresh);
    save();
    for (const id of fresh) {
      const b = BADGES.find((x) => x.id === id);
      sendTo(uuid, { t: 'notify', kind: 'badge', id, names: { pl: b.pl, en: b.en }, xp: progress.xpFor(id) });
    }
    checkLevel(u);
  }
  if (fresh.length || passNew.length) pushMe(uuid);
}
/** Zmiana poziomu: powiadomienie gracza i role za poziom na Discordzie */
const levelListeners = [];
function checkLevel(u) {
  const lv = levelOf(u).level;
  if (u.lvl === lv) return;
  const before = u.lvl;
  u.lvl = lv;
  save();
  if (before && lv > before) sendTo(u.uuid, { t: 'notify', kind: 'levelUp', level: lv });
  for (const f of levelListeners) { try { f(u, lv, before || 0); } catch (e) { console.error('[level]', e.message); } }
}
function meView(u) {
  return { level: levelOf(u), badges: u.badges || [], unlocked: u.unlocked || [], season: catalog.activeSeason(),
    discord: u.discord ? { tag: u.discord.tag } : null, referredBy: referrerName(u), invite: inviteView(u),
    weekly: { xp: weeklyXp(u), rank: weeklyRank(u.uuid), week: weekKey() },
    achievements: progress.achievementsView(u, BADGES), pass: progress.passView(u), wishlist: u.wishlist || [], daily: progress.dailyView(u) };
}
function pushMe(uuid) { const u = user(uuid); if (u) sendTo(uuid, { t: 'me', ...meView(u) }); }

// ---------------- zaproszenia znajomych ----------------
// Każdy gracz ma swój kod (domyślnie nick). Nowy gracz wpisuje go przy pierwszym uruchomieniu,
// a zapraszający dostaje nagrody za progi ustawione komendą /gruzadmin invites albo w panelu.
const DEFAULT_TIERS = [{ count: 3, cosmetic: 'cape:sakura' }, { count: 10, cosmetic: 'wings:crystal' }];
const tiers = () => (Array.isArray(db.promo?.inviteTiers) ? db.promo.inviteTiers : DEFAULT_TIERS).slice().sort((a, b) => a.count - b.count);
function inviteCodeOf(u) {
  if (u.inviteCode) return u.inviteCode;
  const base = String(u.name || 'GRUZ').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 16) || 'GRUZ';
  let code = base;
  const taken = (c) => db.creators?.[c] || db.codes?.[c] || Object.values(db.users).some((x) => x !== u && x.inviteCode === c);
  while (taken(code)) code = base.slice(0, 13) + crypto.randomInt(100, 999);
  u.inviteCode = code;
  save();
  return code;
}
const byInvite = (code) => Object.values(db.users).find((x) => x.inviteCode === code) || null;
function referrerName(u) {
  if (!u.referredBy) return null;
  if (u.referredBy.startsWith('P:')) return user(u.referredBy.slice(2))?.name || null;
  return db.creators[u.referredBy]?.name || u.referredBy;
}
function inviteView(u) {
  const count = (u.invited || []).length;
  const list = tiers();
  return { code: inviteCodeOf(u), count, tiers: list, next: list.find((x) => x.count > count) || null, welcome: db.promo?.inviteWelcome || null };
}
/** Daje zapraszającemu nagrody za osiągnięte progi (też po zmianie progów przez admina) */
function grantInviteRewards(u) {
  const count = (u.invited || []).length;
  let got = null;
  for (const tr of tiers()) {
    if (count >= tr.count && catalog.exists(tr.cosmetic) && !u.unlocked.includes(tr.cosmetic)) { u.unlocked.push(tr.cosmetic); got = tr.cosmetic; }
  }
  if (got) { save(); sendTo(u.uuid, { t: 'notify', kind: 'inviteReward', cosmetic: got, count }); }
  return got;
}

// ---------------- kody twórców ----------------
// Gracz może raz (do 14 dni od pierwszego logowania) podać kod twórcy – dostaje kosmetykę, a twórca +1 do licznika.
const CREATOR_WINDOW = 14 * 864e5;
const inviteListeners = [];
const creatorKey = (s) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
function useCreator(uuid, raw) {
  const u = user(uuid);
  const code = creatorKey(raw);
  const cr = db.creators[code];
  if (!u) return { error: 'CREATOR_INVALID' };
  if (!cr) {
    // kod znajomego
    const inv = byInvite(code);
    if (!inv) return { error: 'CREATOR_INVALID' };
    if (u.referredBy) return { error: 'CREATOR_USED' };
    if (inv.uuid === uuid) return { error: 'CREATOR_SELF' };
    if (now() - (u.firstSeen || 0) > CREATOR_WINDOW) return { error: 'CREATOR_LATE' };
    u.referredBy = 'P:' + inv.uuid;
    inv.invited ||= [];
    if (!inv.invited.includes(uuid)) inv.invited.push(uuid);
    const welcome = db.promo?.inviteWelcome || null;
    if (welcome && catalog.exists(welcome) && !u.unlocked.includes(welcome)) u.unlocked.push(welcome);
    save();
    sendTo(inv.uuid, { t: 'notify', kind: 'invited', name: u.name, count: inv.invited.length });
    grantInviteRewards(inv);
    pushMe(inv.uuid);
    updateBadges(uuid);
    pushMe(uuid);
    for (const f of inviteListeners) { try { f({ inviter: inv, invitee: u }); } catch { /* ignore */ } }
    return { ok: true, name: inv.name, cosmetic: welcome, kind: 'friend' };
  }
  if (u.referredBy) return { error: 'CREATOR_USED' };
  if (now() - (u.firstSeen || 0) > CREATOR_WINDOW) return { error: 'CREATOR_LATE' };
  if (cr.discordId && u.discord?.id === cr.discordId) return { error: 'CREATOR_SELF' };
  u.referredBy = code;
  cr.uses ||= [];
  cr.uses.push(uuid);
  const cosmetic = cr.cosmetic || db.promo?.creatorReward || 'cape:nebula';
  if (catalog.exists(cosmetic) && !u.unlocked.includes(cosmetic)) u.unlocked.push(cosmetic);
  save();
  updateBadges(uuid);
  pushMe(uuid);
  return { ok: true, name: cr.name, cosmetic };
}

// ---------------- kosmetyki na kody ----------------
const catalog = require('./catalog');
/** Do panelu admina: wszystko, na co można zrobić kod ("all" = cały katalog) */
const LOCKED = [...catalog.ALL.filter((k) => !catalog.FREE.includes(k)), 'all'];
/** Kody mogą też dawać Gruz Pass Premium (nie jest kosmetyką, więc nie ma go w LOCKED) */
/** Płatne emotki we dwoje (od 1.8.0): emote:<id> w u.unlocked, mod gra je razem z drugim graczem */
const DUO_EMOTES = ['highfive', 'hug', 'duodance'];
const isCodeKey = (k) => LOCKED.includes(k) || k === 'pass:premium' || DUO_EMOTES.some((id) => k === 'emote:' + id);

// ---------------- osiągnięcia i Gruz Pass (progress.js) ----------------
const progress = require('./progress').setup({ db, save, xpOf, levelOf, hoursOf, dayKey, dayBefore, catalog, sendTo });
BADGES.push(...progress.asBadges);
/** Zostawia tylko to, co gracz ma odblokowane. Kolor motywu przechodzi bez zmian. */
function cleanCosmetics(u, set) {
  return String(set || '').slice(0, 300).split(';').map((part) => {
    const [slot, value] = part.split('=');
    if (!slot) return null;
    if (slot === 'color') return /^[0-9a-f]{6}$/i.test(value || '') ? `color=${value}` : null;
    if (!catalog.CATALOG[slot]) return null;
    const v = value || 'none';
    return `${slot}=${catalog.allowed(`${slot}:${v}`, u.unlocked || []) ? v : 'none'}`;
  }).filter(Boolean).join(';');
}

// ---------------- naklejki i wiadomości głosowe ----------------
const STICKERS = ['gg', 'ez', 'gruz', 'love', 'lol', 'rip', 'wp', 'clutch', 'onev1', 'sleep', 'fire', 'cry'];
const MAX_VOICE_B64 = 420 * 1024; // ~20 s opus

// ---------------- połączenia ----------------
/** uuid -> Set<Client> (launcher i gra mogą być połączone równocześnie) */
const online = new Map();
const parties = new Map(); // id -> { id, leader, members:Set<uuid>, invited:Set<uuid> }
const partyOf = new Map(); // uuid -> partyId

function clientsOf(uuid) { return online.get(uuid) || new Set(); }
function sendTo(uuid, msg) { for (const c of clientsOf(uuid)) c.send(msg); }
/** Do wszystkich połączonych (launchery i gry) */
function sendAll(msg) { for (const set of online.values()) for (const c of set) c.send(msg); }

// ---------------- tryb zgodny z serwerami MC (1.9.0) ----------------
// Panel admina: adres serwera -> moduły Gruz, które mod wyłącza na tym serwerze (np. hypixel.net -> freelook).
// Mod pamięta listę w configu i dopasowuje sam (subdomeny też: mc.hypixel.net pasuje do hypixel.net).
const MODULE_IDS = ['armor', 'autogg', 'betterchat', 'blockoverlay', 'clip', 'clock', 'combo', 'coords', 'cosmetics', 'cps', 'crosshair', 'fight', 'fps', 'freecam', 'freelook', 'fullbright', 'hitboxes', 'hudtweaks', 'hitcolor', 'hitsound', 'items', 'itemphysics', 'keystrokes', 'lowfire', 'lowhp', 'menu', 'minimap', 'motionblur', 'nametags', 'oldanim', 'ping', 'potions', 'reach', 'recording', 'scoreboard', 'speed', 'tab', 'targethud', 'togglesprint', 'world', 'zoom'];
function normHost(s) {
  let h = String(s || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  if ((h.match(/:/g) || []).length === 1) h = h.replace(/:.*$/, '');
  return h.replace(/\.+$/, '').replace(/[^a-z0-9.-]/g, '').slice(0, 80);
}
/** Reguły do wysłania do gry (bez wyłączonych i pustych) */
function serverRules() {
  const list = Array.isArray(db.promo?.serverRules) ? db.promo.serverRules : [];
  return list.filter((r) => !r.off && r.match && r.block?.length).map((r) => ({ match: r.match, block: r.block }));
}
/** Do jednej gry (po zalogowaniu) albo do wszystkich połączonych gier (po zmianie w panelu) */
function pushServerRules(c) {
  const msg = { t: 'serverRules', rules: serverRules() };
  if (c) return c.send(msg);
  for (const set of online.values()) for (const x of set) if (x.kind === 'game') x.send(msg);
}
/** Własne peleryny z panelu admina (capes.js) – ustawiane przy starcie */
let capesApi = null;
/** Sklep Tebex (shop.js) – ustawiany przy starcie */
let shopApi = null;
/** Publiczne API strony: profile i ranking (public.js) */
let publicApi = null;
/** Screeny z gry: gruzclient.com/s/<id> (shots.js) */
let shotsApi = null;
/** Publiczny adres tego serwera (Render podaje go sam w RENDER_EXTERNAL_URL) */
const publicUrl = (p) => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://gruz-server.onrender.com').replace(/\/+$/, '') + p;
function isOnline(uuid) { return clientsOf(uuid).size > 0; }

/** Status gracza (z gry ma pierwszeństwo nad launcherem) */
function presenceOf(uuid) {
  let best = null;
  for (const c of clientsOf(uuid)) {
    if (!best || (c.kind === 'game' && best.kind !== 'game')) best = c;
  }
  if (!best) return { online: false };
  return { online: true, state: best.presence.state || 'launcher', server: best.presence.server || null, since: best.presence.since };
}

function friendView(uuid) {
  const u = user(uuid);
  return {
    uuid, name: u?.name || '?', cosmetics: u?.cosmetics || '', ...presenceOf(uuid),
    level: u ? levelOf(u).level : 1, badges: u?.badges || [],
    wishlist: (u?.wishlist || []).filter((k) => !(u.unlocked || []).includes(k)),
    stats: { totalMs: u?.stats?.totalMs || 0, kills: u?.stats?.kills || 0 },
  };
}

function pushFriends(uuid) {
  const u = user(uuid);
  if (!u) return;
  sendTo(uuid, {
    t: 'friends',
    friends: u.friends.map(friendView),
    incoming: u.incoming.map((x) => ({ uuid: x, name: user(x)?.name || '?' })),
    outgoing: u.outgoing.map((x) => ({ uuid: x, name: user(x)?.name || '?' })),
  });
}

/** Powiadamia znajomych o zmianie statusu */
function announce(uuid) {
  const u = user(uuid);
  if (!u) return;
  for (const f of u.friends) if (isOnline(f)) sendTo(f, { t: 'friend.status', friend: friendView(uuid) });
}

// ---------------- promocje z listy życzeń (1.10.0) ----------------
// Co 15 minut i po zalogowaniu: kosmetyka z listy życzeń ma promocję w Tebexie (min. 5%) -> powiadomienie
// w launcherze i w grze. Każdą promocję zgłaszamy raz (u.wishSale: kosmetyka -> % zniżki); gdy promocja
// się skończy, wpis znika i następna promocja znów da powiadomienie. Offline = powiadomienie po zalogowaniu.
async function wishSaleCheck(only) {
  if (!shopApi) return;
  let list = [];
  try { list = await shopApi.publicList(); } catch { return; }
  const sale = {};
  for (const p of list) {
    const base = Number(p.price) + Number(p.discount || 0);
    const off = base > 0 && p.discount > 0 ? Math.round((p.discount / base) * 100) : 0;
    if (off >= 5) sale[p.cosmetic] = { off, packageId: p.packageId, price: p.price, currency: p.currency,
      names: p.label || { en: p.name, pl: p.name } };
  }
  let changed = false;
  for (const u of only || Object.values(db.users)) {
    if (!u || !(u.wishlist || []).length && !u.wishSale) continue;
    const seen = u.wishSale || {};
    for (const k of Object.keys(seen)) if (!sale[k]) { delete seen[k]; changed = true; }
    if (!isOnline(u.uuid)) { if (!Object.keys(seen).length) delete u.wishSale; continue; }
    for (const k of u.wishlist || []) {
      const s = sale[k];
      if (!s || seen[k] === s.off || (u.unlocked || []).includes(k) || (u.unlocked || []).includes('all')) continue;
      seen[k] = s.off;
      changed = true;
      sendTo(u.uuid, { t: 'notify', kind: 'wishSale', cosmetic: k, name: s.names.en, names: s.names, off: s.off,
        packageId: s.packageId, price: s.price, currency: s.currency });
    }
    if (Object.keys(seen).length) u.wishSale = seen; else delete u.wishSale;
  }
  if (changed) save();
}

// ---------------- pokoje (gracze Gruz na tym samym serwerze MC) ----------------
const roomKey = (c) => (c.kind === 'game' && c.presence.state === 'multiplayer' && c.presence.server ? 'srv:' + c.presence.server.toLowerCase() : null);
function roomMembers(key) {
  const out = [];
  for (const set of online.values()) for (const c of set) if (roomKey(c) === key) out.push(c);
  return out;
}
/** Nowy gracz w pokoju dostaje kosmetyki pozostałych, a pozostali – jego */
function syncRoom(client) {
  const key = roomKey(client);
  if (!key) return;
  const others = roomMembers(key).filter((c) => c !== client);
  const map = {};
  for (const c of others) map[c.uuid] = user(c.uuid)?.cosmetics || '';
  client.send({ t: 'cosmetics', map });
  for (const c of others) c.send({ t: 'cosmetics', map: { [client.uuid]: user(client.uuid)?.cosmetics || '' } });
}

// ---------------- party ----------------
function partyView(p) {
  return { id: p.id, leader: p.leader, members: [...p.members].map(friendView), invited: [...p.invited].map((x) => ({ uuid: x, name: user(x)?.name })) };
}
function pushParty(p) {
  for (const m of p.members) sendTo(m, { t: 'party', party: partyView(p) });
}
function leaveParty(uuid) {
  const id = partyOf.get(uuid);
  if (!id) return;
  const p = parties.get(id);
  partyOf.delete(uuid);
  sendTo(uuid, { t: 'party', party: null });
  if (!p) return;
  p.members.delete(uuid);
  if (!p.members.size) { parties.delete(id); return; }
  if (p.leader === uuid) p.leader = [...p.members][0];
  pushParty(p);
}

// ---------------- kody do party (link z /gruz invite i z launchera) ----------------
// Lider dostaje link https://…/party?c=KOD, który otwiera launcher (gruzclient://party/KOD).
// Kto ma link, może dołączyć bez bycia znajomym. Kod działa 30 minut i maksymalnie 7 razy.
const partyCodes = new Map(); // KOD -> { leader, exp, uses }
const duoInvites = new Map(); // "do|od" -> { emote, exp } – emotki we dwoje
setInterval(() => { const t = now(); for (const [k, v] of duoInvites) if (v.exp < t) duoInvites.delete(k); }, 60_000);
function partyLink(uuid) {
  for (const [k, v] of partyCodes) if (v.exp < now()) partyCodes.delete(k);
  let code = [...partyCodes].find(([, v]) => v.leader === uuid && v.uses < 7)?.[0];
  if (!code) {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do { code = ''; for (let i = 0; i < 6; i++) code += abc[crypto.randomInt(abc.length)]; } while (partyCodes.has(code));
    partyCodes.set(code, { leader: uuid, exp: now() + 30 * 60_000, uses: 0 });
  }
  const v = partyCodes.get(code);
  return { code, url: `${PUBLIC_URL}/party?c=${code}`, expires: v.exp, leaderName: user(uuid)?.name || '?' };
}
/** Tworzy party dla gracza, jeśli jeszcze go nie ma */
function ensureParty(uuid) {
  let p = parties.get(partyOf.get(uuid));
  if (p) return p;
  p = { id: crypto.randomUUID(), leader: uuid, members: new Set([uuid]), invited: new Set() };
  parties.set(p.id, p);
  partyOf.set(uuid, p.id);
  const u = user(uuid);
  u.partiesLed = (u.partiesLed || 0) + 1;
  save();
  updateBadges(uuid);
  return p;
}
/** Ktoś dołączył do party: zadanie dzienne dla wszystkich obecnych */
function partyQuest(p) {
  if (p.members.size < 2) return;
  for (const id of p.members) {
    const u = user(id);
    if (!u) continue;
    const d = dailyOf(u);
    if (!d.prog.partyIds.includes(p.id)) { d.prog.partyIds.push(p.id); d.prog.parties++; questsChanged(u); }
  }
}

// ---------------- codzienne zadania ----------------
// Co dzień (północ w strefie TZ) gracz dostaje 3 zadania. Za każde jest XP, a za serię dni ze wszystkimi
// zadaniami – kosmetyki (progi ustawia admin w panelu, domyślnie niżej).
const QUESTS = [
  { id: 'play30', stat: 'play', goal: 30, xp: 40, pl: 'Zagraj 30 minut', en: 'Play for 30 minutes' },
  { id: 'play60', stat: 'play', goal: 60, xp: 70, pl: 'Zagraj godzinę', en: 'Play for an hour' },
  { id: 'server20', stat: 'mp', goal: 20, xp: 50, pl: 'Graj 20 minut na serwerze', en: 'Play 20 minutes on a server' },
  { id: 'servers2', stat: 'servers', goal: 2, xp: 40, pl: 'Wejdź na 2 różne serwery', en: 'Join 2 different servers' },
  { id: 'kills10', stat: 'kills', goal: 10, xp: 50, pl: 'Pokonaj 10 graczy', en: 'Defeat 10 players' },
  { id: 'kills25', stat: 'kills', goal: 25, xp: 90, pl: 'Pokonaj 25 graczy', en: 'Defeat 25 players' },
  { id: 'dm5', stat: 'dms', goal: 5, xp: 25, pl: 'Wyślij 5 wiadomości znajomym', en: 'Send 5 messages to friends' },
  { id: 'party', stat: 'parties', goal: 1, xp: 35, pl: 'Zagraj w party ze znajomym', en: 'Play in a party with a friend' },
];
const DEFAULT_STREAK = [{ days: 3, cosmetic: 'trail:sparks' }, { days: 7, cosmetic: 'cape:aurora' }, { days: 30, cosmetic: 'wings:angel' }];
const streakTiers = () => (Array.isArray(db.promo?.questStreak) ? db.promo.questStreak : DEFAULT_STREAK).slice().sort((a, b) => a.days - b.days);
const questXp = (q) => Number(db.promo?.questXp?.[q.id]) || q.xp;

/** Zadania na dziś: losowe, ale stałe dla gracza i dnia; co najwyżej jedno z każdej grupy */
function pickQuests(uuid, day) {
  const h = (s) => crypto.createHash('sha1').update(s).digest().readUInt32BE(0);
  const order = QUESTS.slice().sort((a, b) => h(uuid + day + a.id) - h(uuid + day + b.id));
  const out = [];
  for (const q of order) if (out.length < 3 && !out.some((x) => x.stat === q.stat)) out.push(q.id);
  return out;
}
function dailyOf(u) {
  const day = dayKey();
  if (!u.daily || u.daily.day !== day) {
    u.daily = { day, ids: pickQuests(u.uuid, day), claimed: [], notified: [],
      prog: { playMs: 0, mpMs: 0, dms: 0, parties: 0, partyIds: [], servers: [], kills0: u.stats?.kills || 0, total0: u.stats?.totalMs || 0,
        // launcher jeszcze nie przysłał statystyk – punktem startu będą pierwsze, które przyjdą (żeby stare godziny nie zaliczały zadań)
        needBase: u.stats?.totalMs === undefined } };
    save();
  }
  return u.daily;
}
function questProgress(u, q) {
  const p = dailyOf(u).prog;
  switch (q.stat) {
    // czas liczy serwer (gra z modem Gruz) albo launcher po sesji – bierzemy większy
    case 'play': return Math.floor(Math.max(p.playMs, (u.stats?.totalMs || 0) - p.total0) / 60_000);
    case 'mp': return Math.floor(p.mpMs / 60_000);
    case 'servers': return p.servers.length;
    case 'kills': return Math.max(0, (u.stats?.kills || 0) - p.kills0);
    case 'dms': return p.dms;
    case 'parties': return p.parties;
    default: return 0;
  }
}
function streakOf(u) {
  const s = u.streak || { n: 0, last: '' };
  const today = dayKey();
  // seria przepada, jeśli wczoraj nie było kompletu (dzisiejszy jeszcze może być)
  const alive = s.last === today || s.last === dayBefore(today);
  return { n: alive ? s.n : 0, today: s.last === today, best: u.streakBest || 0 };
}
function questsView(u) {
  const d = dailyOf(u);
  const st = streakOf(u);
  return {
    day: d.day, resetsAt: nextMidnight(),
    quests: d.ids.map((id) => QUESTS.find((q) => q.id === id)).filter(Boolean).map((q) => {
      const progress = Math.min(q.goal, questProgress(u, q));
      return { id: q.id, names: { pl: q.pl, en: q.en }, goal: q.goal, progress, xp: questXp(q), done: progress >= q.goal, claimed: d.claimed.includes(q.id) };
    }),
    streak: st.n, streakToday: st.today, best: st.best,
    rewards: streakTiers().map((x) => ({ ...x, got: (u.unlocked || []).includes(x.cosmetic) })),
  };
}
function nextMidnight() {
  // pierwsza minuta następnego dnia w strefie TZ (działa też przy zmianie czasu)
  const today = dayKey();
  let t = Math.ceil(now() / 60_000) * 60_000;
  while (dayKey(t) === today) t += 15 * 60_000;
  while (dayKey(t - 60_000) !== today) t -= 60_000;
  return t;
}
const questDirty = new Set();
/** Po zmianie postępu: powiadomienie o wykonanym zadaniu i odświeżenie listy (z opóźnieniem, hurtem) */
function questsChanged(u) {
  const d = dailyOf(u);
  for (const id of d.ids) {
    const q = QUESTS.find((x) => x.id === id);
    if (q && !d.notified.includes(id) && questProgress(u, q) >= q.goal) {
      d.notified.push(id);
      sendTo(u.uuid, { t: 'notify', kind: 'quest', id, names: { pl: q.pl, en: q.en }, xp: questXp(q) });
    }
  }
  save();
  questDirty.add(u.uuid);
}
setInterval(() => {
  for (const id of questDirty) { const u = user(id); if (u && isOnline(id)) sendTo(id, { t: 'quests', ...questsView(u) }); }
  questDirty.clear();
}, 3000);
function claimQuest(u, id) {
  const d = dailyOf(u);
  const q = QUESTS.find((x) => x.id === id);
  if (!q || !d.ids.includes(id)) return { error: 'QUEST_UNKNOWN' };
  if (d.claimed.includes(id)) return { error: 'QUEST_CLAIMED' };
  if (questProgress(u, q) < q.goal) return { error: 'QUEST_NOT_DONE' };
  d.claimed.push(id);
  u.questsDone = (u.questsDone || 0) + 1;
  u.bonusXp = (u.bonusXp || 0) + questXp(q);
  let cosmetic = null;
  if (d.ids.every((x) => d.claimed.includes(x))) {
    // komplet na dziś: seria +1 i nagrody za progi serii
    const today = dayKey();
    const s = u.streak || { n: 0, last: '' };
    if (s.last !== today) {
      u.streak = { n: s.last === dayBefore(today) ? s.n + 1 : 1, last: today };
      u.streakBest = Math.max(u.streakBest || 0, u.streak.n);
      for (const tr of streakTiers()) {
        if (u.streak.n >= tr.days && catalog.exists(tr.cosmetic) && !u.unlocked.includes(tr.cosmetic)) { u.unlocked.push(tr.cosmetic); cosmetic = tr.cosmetic; }
      }
    }
  }
  save();
  updateBadges(u.uuid);
  pushMe(u.uuid);
  if (cosmetic) sendTo(u.uuid, { t: 'unlocked', cosmetic, unlocked: u.unlocked, streak: u.streak.n });
  return { ok: true, xp: questXp(q), cosmetic, streak: u.streak?.n || 0 };
}
// co minutę dopisujemy czas gry (gra z modem Gruz zgłasza menu / świat / serwer)
setInterval(() => {
  for (const [uuid, set] of online) {
    const states = [...set].filter((c) => c.kind === 'game').map((c) => c.presence.state);
    if (!states.some((s) => s === 'singleplayer' || s === 'multiplayer')) continue;
    const u = user(uuid);
    if (!u) continue;
    const p = dailyOf(u).prog;
    p.playMs += 60_000;
    if (states.includes('multiplayer')) p.mpMs += 60_000;
    questsChanged(u);
  }
}, 60_000);

// ---------------- ranking tygodniowy ----------------
const weeklyListeners = [];
function weeklyTop(n = 10) {
  return Object.values(db.users).filter((u) => !u.banned).map((u) => ({ uuid: u.uuid, name: u.name, xp: weeklyXp(u), level: levelOf(u).level }))
    .filter((x) => x.xp > 0).sort((a, b) => b.xp - a.xp).slice(0, n);
}
function weeklyRank(uuid) {
  const u = user(uuid);
  if (!u || !weeklyXp(u)) return null;
  const mine = weeklyXp(u);
  return 1 + Object.values(db.users).filter((x) => !x.banned && weeklyXp(x) > mine).length;
}
/** Nowy tydzień: zapisujemy wyniki poprzedniego, dajemy nagrody i zerujemy licznik */
function weeklyTick() {
  const wk = weekKey();
  if (!db.meta.week) { db.meta.week = wk; save(); return; }
  if (db.meta.week === wk) return;
  const prev = db.meta.week;
  const rows = Object.values(db.users).filter((u) => !u.banned && u.wk?.week === prev)
    .map((u) => ({ uuid: u.uuid, name: u.name, xp: Math.max(0, xpOf(u) - (u.wk.xp0 || 0)) }))
    .filter((x) => x.xp > 0).sort((a, b) => b.xp - a.xp).slice(0, 10);
  const reward = db.promo?.weeklyReward || {};
  const places = Math.max(0, Math.min(10, Number(reward.places) || 0));
  const rewarded = [];
  if (reward.cosmetic && catalog.exists(reward.cosmetic)) {
    for (const r of rows.slice(0, places)) {
      const u = user(r.uuid);
      if (!u.unlocked.includes(reward.cosmetic)) { u.unlocked.push(reward.cosmetic); rewarded.push(r.uuid); sendTo(u.uuid, { t: 'unlocked', cosmetic: reward.cosmetic, unlocked: u.unlocked, weekly: true }); }
    }
  }
  rows.forEach((r, i) => { const u = user(r.uuid); if (u) u.bestWeekly = Math.min(u.bestWeekly || 99, i + 1); });
  db.meta.lastWeekly = { week: prev, top: rows, cosmetic: reward.cosmetic || null, rewarded, at: now() };
  db.meta.history = [db.meta.lastWeekly, ...(db.meta.history || [])].slice(0, 12);
  for (const u of Object.values(db.users)) u.wk = { week: wk, xp0: xpOf(u) };
  db.meta.week = wk;
  save();
  for (const f of weeklyListeners) { try { f(db.meta.lastWeekly); } catch (e) { console.error('[weekly]', e.message); } }
  for (const r of rows.slice(0, 3)) updateBadges(r.uuid);
  for (const uuid of online.keys()) pushMe(uuid);
}
setInterval(weeklyTick, 5 * 60_000);

// ---------------- metryki do wykresów w panelu ----------------
function markActive(uuid, launcherVersion) {
  const m = db.metrics;
  const day = dayKey();
  if (!m.today || m.today.day !== day) m.today = { day, seen: [] };
  const d = (m.days[day] ||= { active: 0, peak: 0, sessions: 0, versions: {} });
  d.sessions++;
  if (!m.today.seen.includes(uuid)) {
    m.today.seen.push(uuid);
    d.active = m.today.seen.length;
    if (launcherVersion) d.versions[launcherVersion] = (d.versions[launcherVersion] || 0) + 1;
  }
  d.peak = Math.max(d.peak, online.size);
  // trzymamy pół roku
  const keys = Object.keys(m.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 190))) delete m.days[k];
  save();
}

// ---------------- topka serwerów ----------------
// Liczymy, na jakich serwerach grają gracze Gruz (unikalni gracze i łączny czas).
const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'com.pl', 'net.pl', 'org.pl', 'com.br', 'com.au', 'co.nz', 'com.tr', 'com.ua', 'co.za', 'com.mx']);
function serverKey(address) {
  let h = String(address || '').trim().toLowerCase().replace(/\.$/, '').replace(/:25565$/, '');
  const port = /:(\d+)$/.exec(h);
  if (port) h = h.slice(0, port.index);
  if (/^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.')) return port ? `${h}:${port[1]}` : h;
  const parts = h.split('.');
  const n = SECOND_LEVEL.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-n).join('.') + (port ? ':' + port[1] : '');
}
const serverSessions = new Map(); // uuid -> { key, since }
function bankServer(s, ms) { s.ms = (s.ms || 0) + ms; s.last = now(); }
function trackServer(uuid) {
  const p = presenceOf(uuid);
  const key = p.online && p.state === 'multiplayer' && p.server ? serverKey(p.server) : null;
  const cur = serverSessions.get(uuid);
  if (cur && cur.key === key) return;
  if (cur) {
    bankServer(db.servers[cur.key] ||= { ms: 0, players: [], sessions: 0 }, now() - cur.since);
    serverSessions.delete(uuid);
  }
  if (key) {
    const s = (db.servers[key] ||= { ms: 0, players: [], sessions: 0 });
    if (!s.players.includes(uuid)) s.players.push(uuid);
    const u = user(uuid);
    if (u) { const d = dailyOf(u); if (!d.prog.servers.includes(key)) { d.prog.servers.push(key); questsChanged(u); } }
    s.sessions = (s.sessions || 0) + 1;
    s.last = now();
    serverSessions.set(uuid, { key, since: now() });
  }
  save();
}
// co 5 minut dopisujemy czas trwających sesji (żeby restart serwera go nie zgubił)
setInterval(() => {
  for (const v of serverSessions.values()) {
    const s = db.servers[v.key];
    if (s) bankServer(s, now() - v.since);
    v.since = now();
  }
  if (serverSessions.size) save();
}, 5 * 60_000);

// ---------------- raporty crashy i łączenie Discorda ----------------
const crashListeners = [];
let crashHelp = null; // bot Discord: (raport) => Promise<{ url }>
async function askForHelp(c, u, report) {
  if (now() - (u.lastHelpAt || 0) < 5 * 60_000) return c.send({ t: 'crash.result', ok: true, id: report.id, helpError: 'HELP_SLOW' });
  if (!crashHelp) return c.send({ t: 'crash.result', ok: true, id: report.id, helpError: 'HELP_NO_BOT' });
  if (!u.discord?.id) return c.send({ t: 'crash.result', ok: true, id: report.id, helpError: 'HELP_NEED_LINK' });
  try {
    const r = await crashHelp(report, u);
    u.lastHelpAt = now();
    report.ticket = r.url;
    save();
    c.send({ t: 'crash.result', ok: true, id: report.id, ticket: r.url });
  } catch (e) {
    console.error('[crash help]', e.message);
    c.send({ t: 'crash.result', ok: true, id: report.id, helpError: /^HELP_/.test(e.message) ? e.message : 'HELP_FAILED' });
  }
}
const linkCodes = new Map(); // KOD -> { uuid, exp }
/** Zużywa kod z launchera; zwraca uuid gracza albo null */
function consumeLinkCode(code) {
  const k = String(code || '').trim().toUpperCase();
  const v = linkCodes.get(k);
  linkCodes.delete(k);
  return v && v.exp > now() ? v.uuid : null;
}

// ---------------- obsługa wiadomości ----------------
const handlers = {
  // sklep: koszyk w Tebexie, launcher otwiera link do płatności w przeglądarce
  async 'shop.buy'(c, m) {
    if (c.kind !== 'launcher') return;
    try { c.send({ t: 'shop.checkout', ...(await shopApi.buy(c, m.packageId)) }); }
    catch (e) { console.warn('[shop]', e.message); c.send({ t: 'shop.error', code: String(e.message).startsWith('SHOP_') ? String(e.message).split(':')[0] : 'SHOP_TEBEX' }); }
  },
  // prezent dla znajomego: koszyk na uuid znajomego, płaci ten, kto daje (od launchera 0.6.3)
  async 'shop.gift'(c, m) {
    if (c.kind !== 'launcher') return;
    const me = user(c.uuid);
    const to = dashed(String(m.to || ''));
    if (!me || !user(to) || !me.friends.includes(to)) return c.send({ t: 'shop.error', code: 'SHOP_NOT_FRIEND' });
    try { c.send({ t: 'shop.checkout', gift: user(to).name, ...(await shopApi.buy({ uuid: to, ip: c.ip }, m.packageId, undefined, me)) }); }
    catch (e) { console.warn('[shop] prezent:', e.message); c.send({ t: 'shop.error', code: String(e.message).startsWith('SHOP_') ? String(e.message).split(':')[0] : 'SHOP_TEBEX' }); }
  },
  /** Screen z gry (mod 0.5.5+): JPEG w base64 -> link gruzclient.com/s/<id> */
  'shot.upload'(c, m) {
    if (!shotsApi) return c.send({ t: 'shot.error', code: 'SHOT_SAVE' });
    shotsApi.upload(c, m).catch((e) => { console.error('[shots]', e.message); c.send({ t: 'shot.error', code: 'SHOT_SAVE' }); });
  },

  presence(c, m) {
    const state = String(m.state || 'launcher').slice(0, 20);
    const server = m.server ? String(m.server).slice(0, 80) : null;
    const changed = state !== c.presence.state || server !== c.presence.server;
    c.presence = { state, server, since: changed ? now() : c.presence.since };
    announce(c.uuid);
    syncRoom(c);
    trackServer(c.uuid);
  },

  cosmetics(c, m) {
    const u = user(c.uuid);
    u.cosmetics = cleanCosmetics(u, m.set);
    save();
    const key = roomKey(c);
    if (key) for (const o of roomMembers(key)) if (o !== c) o.send({ t: 'cosmetics', map: { [c.uuid]: u.cosmetics } });
    announce(c.uuid);
  },

  /** Gra pyta o kosmetyki graczy, których widzi (np. na serwerze bez wspólnego pokoju) */
  lookup(c, m) {
    const map = {};
    for (const raw of (m.uuids || []).slice(0, 100)) {
      const id = dashed(raw);
      if (isOnline(id)) map[id] = user(id)?.cosmetics || '';
    }
    c.send({ t: 'cosmetics', map });
  },

  /** Emotka we dwoje: zaproszenie dla gracza obok (ten sam serwer Minecraft). Emotkę musi mieć ten, kto zaprasza. */
  'duo.invite'(c, m) {
    const id = String(m.emote || '');
    const u = user(c.uuid);
    if (!DUO_EMOTES.includes(id)) return;
    if (!(u.unlocked.includes('emote:' + id) || u.unlocked.includes('all'))) return c.send({ t: 'error', code: 'DUO_LOCKED' });
    const to = dashed(String(m.to || ''));
    const key = roomKey(c);
    const there = key && roomMembers(key).filter((o) => o.uuid === to);
    if (!there || !there.length) return c.send({ t: 'error', code: 'DUO_FAR' });
    duoInvites.set(`${to}|${c.uuid}`, { emote: id, exp: now() + 20_000 });
    for (const o of there) o.send({ t: 'duo.invite', from: c.uuid, name: u.name, emote: id });
    c.send({ t: 'duo.sent', to, emote: id });
  },
  /** Przyjęcie zaproszenia: start u obu i u wszystkich graczy Gruz na tym serwerze */
  'duo.accept'(c, m) {
    const from = dashed(String(m.from || ''));
    const k = `${c.uuid}|${from}`;
    const inv = duoInvites.get(k);
    duoInvites.delete(k);
    if (!inv || inv.exp < now()) return c.send({ t: 'error', code: 'DUO_EXPIRED' });
    const key = roomKey(c);
    if (!key || !roomMembers(key).some((o) => o.uuid === from)) return c.send({ t: 'error', code: 'DUO_FAR' });
    const msg = { t: 'duo.start', a: from, b: c.uuid, emote: inv.emote };
    for (const o of roomMembers(key)) o.send(msg);
  },

  emote(c, m) {
    const id = String(m.id || '').slice(0, 20);
    const key = roomKey(c);
    if (key) for (const o of roomMembers(key)) if (o !== c) o.send({ t: 'emote', uuid: c.uuid, id });
  },

  stats(c, m) {
    const u = user(c.uuid);
    const num = (v) => Math.max(0, Math.min(1e13, Number(v) || 0));
    u.stats = { totalMs: num(m.totalMs), sessions: num(m.sessions), longestMs: num(m.longestMs), kills: num(m.kills) };
    const d = dailyOf(u);
    if (d.prog.needBase) { d.prog.needBase = false; d.prog.total0 = u.stats.totalMs; d.prog.kills0 = u.stats.kills; }
    progress.passRebase(u);
    save();
    updateBadges(c.uuid);
    questsChanged(u);
  },

  /** Kod na ekskluzywną kosmetykę */
  'code.redeem'(c, m) {
    const code = String(m.code || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32);
    const entry = db.codes[code];
    const u = user(c.uuid);
    if (!entry && db.creators[creatorKey(code)]) {
      const r = useCreator(c.uuid, code);
      return c.send(r.ok ? { t: 'creator.result', ...r } : { t: 'error', code: r.error });
    }
    if (!entry) return c.send({ t: 'error', code: 'CODE_INVALID' });
    if (entry.cosmetic === progress.PASS_CODE) {
      // Gruz Pass Premium na bieżący miesiąc
      if (entry.maxUses && entry.used.length >= entry.maxUses) return c.send({ t: 'error', code: 'CODE_EXHAUSTED' });
      const r = progress.activatePremium(u);
      if (r.error) return c.send({ t: 'error', code: r.error });
      entry.used.push(c.uuid);
      save();
      c.send({ t: 'pass.premium', pass: progress.passView(u) });
      updateBadges(c.uuid);
      return pushMe(c.uuid);
    }
    if (entry.used.includes(c.uuid) || u.unlocked.includes(entry.cosmetic)) return c.send({ t: 'error', code: 'CODE_USED' });
    if (entry.maxUses && entry.used.length >= entry.maxUses) return c.send({ t: 'error', code: 'CODE_EXHAUSTED' });
    entry.used.push(c.uuid);
    u.unlocked.push(entry.cosmetic);
    save();
    c.send({ t: 'unlocked', cosmetic: entry.cosmetic, unlocked: u.unlocked });
    updateBadges(c.uuid);
    pushMe(c.uuid);
  },

  /** Kod twórcy podany przy pierwszym uruchomieniu launchera */
  'creator.use'(c, m) {
    const r = useCreator(c.uuid, m.code);
    c.send(r.ok ? { t: 'creator.result', ...r } : { t: 'creator.result', ok: false, code: r.error });
  },

  /** Kosmetyka sezonowa: za darmo, ale tylko w czasie wydarzenia */
  /** Raport crasha z launchera (gracz kliknął "Wyślij raport") */
  'crash.report'(c, m) {
    const u = user(c.uuid);
    if (!u) return;
    if (now() - (u.lastCrashAt || 0) < 60_000) return c.send({ t: 'crash.result', ok: false, code: 'SLOW' });
    u.lastCrashAt = now();
    const str = (v, n) => String(v ?? '').slice(0, n);
    const report = {
      id: crypto.randomBytes(5).toString('hex'), uuid: u.uuid, name: u.name, at: now(),
      launcher: str(m.launcher, 20), mc: str(m.mc, 20), loader: str(m.loader, 20), mod: str(m.mod, 20),
      kind: str(m.kind, 30), title: str(m.title, 150), text: str(m.text, 600), note: str(m.note, 500),
      mods: Array.isArray(m.mods) ? m.mods.slice(0, 10).map((x) => str(x, 80)) : [],
      excerpt: str(m.excerpt, 4000), log: str(m.log, 60_000),
    };
    db.crashes.unshift(report);
    db.crashes = db.crashes.slice(0, 300);
    save();
    for (const f of crashListeners) { try { f(report); } catch (e) { console.error('[crash]', e.message); } }
    if (m.help) return askForHelp(c, u, report);
    c.send({ t: 'crash.result', ok: true, id: report.id });
  },

  /** "Poproś o pomoc" po wysłaniu raportu: ticket na Discordzie z logiem */
  'crash.help'(c, m) {
    const u = user(c.uuid);
    const report = (db.crashes || []).find((r) => r.id === String(m.id || '') && r.uuid === c.uuid);
    if (!report) return c.send({ t: 'crash.result', ok: false, code: 'NOT_FOUND' });
    askForHelp(c, u, report);
  },

  /** Kod do połączenia konta z Discordem (/gruz link KOD) – ważny 10 minut */
  'link.code'(c) {
    for (const [k, v] of linkCodes) if (v.uuid === c.uuid || v.exp < now()) linkCodes.delete(k);
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = ''; for (let i = 0; i < 6; i++) code += abc[crypto.randomInt(abc.length)]; } while (linkCodes.has(code));
    linkCodes.set(code, { uuid: c.uuid, exp: now() + 10 * 60_000 });
    c.send({ t: 'link.code', code, expires: now() + 10 * 60_000 });
  },

  'season.claim'(c, m) {
    const key = String(m.key || '');
    const season = catalog.activeSeason();
    const u = user(c.uuid);
    if (!season || !season.items.includes(key)) return c.send({ t: 'error', code: 'SEASON_OVER' });
    if (!u.unlocked.includes(key)) u.unlocked.push(key);
    save();
    c.send({ t: 'unlocked', cosmetic: key, unlocked: u.unlocked, season: true });
    updateBadges(c.uuid);
    pushMe(c.uuid);
  },

  'voice.get'(c, m) {
    const id = String(m.id || '').replace(/[^a-f0-9]/g, '').slice(0, 32);
    // odsłuchać może tylko nadawca albo odbiorca
    const allowed = Object.entries(db.dms).some(([key, list]) => key.includes(c.uuid) && list.some((x) => x.voice === id));
    if (!allowed) return c.send({ t: 'error', code: 'VOICE_NOT_FOUND' });
    try {
      storage.getVoice(id).then((data) => c.send(data ? { t: 'voice', id, data } : { t: 'error', code: 'VOICE_NOT_FOUND' }));
    } catch { c.send({ t: 'error', code: 'VOICE_NOT_FOUND' }); }
  },

  'friend.add'(c, m) {
    const target = byName(m.name);
    if (!target) return c.send({ t: 'error', code: 'USER_NOT_FOUND', name: m.name });
    if (target.uuid === c.uuid) return c.send({ t: 'error', code: 'SELF' });
    const me = user(c.uuid);
    if (me.friends.includes(target.uuid)) return c.send({ t: 'error', code: 'ALREADY_FRIENDS' });
    // jeśli tamten już nas zaprosił – od razu przyjaźń
    if (me.incoming.includes(target.uuid)) return handlers['friend.accept'](c, { uuid: target.uuid });
    if (!me.outgoing.includes(target.uuid)) me.outgoing.push(target.uuid);
    if (!target.incoming.includes(c.uuid)) target.incoming.push(c.uuid);
    save();
    pushFriends(c.uuid);
    pushFriends(target.uuid);
    sendTo(target.uuid, { t: 'notify', kind: 'friendRequest', name: me.name });
  },

  'friend.accept'(c, m) {
    const me = user(c.uuid), other = user(dashed(m.uuid));
    if (!other || !me.incoming.includes(other.uuid)) return;
    me.incoming = me.incoming.filter((x) => x !== other.uuid);
    other.outgoing = other.outgoing.filter((x) => x !== c.uuid);
    if (!me.friends.includes(other.uuid)) me.friends.push(other.uuid);
    if (!other.friends.includes(c.uuid)) other.friends.push(c.uuid);
    save();
    pushFriends(c.uuid);
    pushFriends(other.uuid);
    updateBadges(c.uuid);
    updateBadges(other.uuid);
    sendTo(other.uuid, { t: 'notify', kind: 'friendAccepted', name: me.name });
  },

  'friend.decline'(c, m) {
    const me = user(c.uuid), id = dashed(m.uuid), other = user(id);
    me.incoming = me.incoming.filter((x) => x !== id);
    me.outgoing = me.outgoing.filter((x) => x !== id);
    if (other) { other.outgoing = other.outgoing.filter((x) => x !== c.uuid); other.incoming = other.incoming.filter((x) => x !== c.uuid); }
    save();
    pushFriends(c.uuid);
    if (other) pushFriends(other.uuid);
  },

  'friend.remove'(c, m) {
    const me = user(c.uuid), id = dashed(m.uuid), other = user(id);
    me.friends = me.friends.filter((x) => x !== id);
    if (other) other.friends = other.friends.filter((x) => x !== c.uuid);
    save();
    pushFriends(c.uuid);
    if (other) pushFriends(other.uuid);
  },

  dm(c, m) {
    const to = dashed(m.to);
    const text = String(m.text || '').trim().slice(0, 500);
    const sticker = STICKERS.includes(m.sticker) ? m.sticker : null;
    const voiceData = typeof m.voice === 'string' && m.voice.length <= MAX_VOICE_B64 ? m.voice : null;
    if (!text && !sticker && !voiceData) return;
    if (!user(c.uuid).friends.includes(to)) return c.send({ t: 'error', code: 'NOT_FRIENDS' });
    const key = [c.uuid, to].sort().join('|');
    const msg = { from: c.uuid, to, at: now() };
    if (voiceData) {
      const id = crypto.randomBytes(12).toString('hex');
      storage.putVoice(id, voiceData).catch((e) => console.error('[voice]', e.message));
      msg.voice = id;
      msg.dur = Math.max(0, Math.min(20, Number(m.dur) || 0));
    } else if (sticker) msg.sticker = sticker;
    else msg.text = text;
    user(c.uuid).dmsSent = (user(c.uuid).dmsSent || 0) + 1;
    dailyOf(user(c.uuid)).prog.dms++;
    questsChanged(user(c.uuid));
    (db.dms[key] ||= []).push(msg);
    if (db.dms[key].length > 200) {
      // stare wiadomości głosowe kasujemy razem z historią
      for (const old of db.dms[key].slice(0, -200)) if (old.voice) storage.delVoice(old.voice).catch(() => {});
      db.dms[key] = db.dms[key].slice(-200);
    }
    save();
    const out = { t: 'dm', ...msg, fromName: user(c.uuid).name, toName: user(to)?.name };
    sendTo(c.uuid, out);
    sendTo(to, out);
  },

  'dm.history'(c, m) {
    const other = dashed(m.with);
    const key = [c.uuid, other].sort().join('|');
    c.send({ t: 'dm.history', with: other, messages: (db.dms[key] || []).slice(-100) });
  },

  'party.invite'(c, m) {
    const target = dashed(m.uuid);
    if (!user(c.uuid).friends.includes(target)) return c.send({ t: 'error', code: 'NOT_FRIENDS' });
    const p = ensureParty(c.uuid);
    if (p.members.size >= 8) return c.send({ t: 'error', code: 'PARTY_FULL' });
    p.invited.add(target);
    pushParty(p);
    sendTo(target, { t: 'party.invite', id: p.id, from: user(c.uuid).name, fromUuid: c.uuid });
  },

  'party.accept'(c, m) {
    const p = parties.get(m.id);
    if (!p || !p.invited.has(c.uuid)) return c.send({ t: 'error', code: 'INVITE_EXPIRED' });
    leaveParty(c.uuid);
    p.invited.delete(c.uuid);
    p.members.add(c.uuid);
    partyOf.set(c.uuid, p.id);
    user(c.uuid).partiesJoined = (user(c.uuid).partiesJoined || 0) + 1;
    save();
    pushParty(p);
    partyQuest(p);
  },

  /** Link do party (dla znajomych spoza listy znajomych, np. na Discordzie) */
  'party.link'(c) {
    c.send({ t: 'party.link', ...partyLink(c.uuid) });
  },

  /** Wejście do party z linku gruzclient://party/KOD */
  'party.join'(c, m) {
    const code = String(m.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const entry = partyCodes.get(code);
    if (!entry || entry.exp < now() || entry.uses >= 7) return c.send({ t: 'error', code: 'PARTY_LINK_EXPIRED' });
    if (entry.leader === c.uuid) return c.send({ t: 'error', code: 'PARTY_LINK_SELF' });
    if (!isOnline(entry.leader)) return c.send({ t: 'error', code: 'PARTY_LEADER_OFFLINE', name: user(entry.leader)?.name });
    const p = ensureParty(entry.leader);
    if (p.members.has(c.uuid)) return pushParty(p);
    if (p.members.size >= 8) return c.send({ t: 'error', code: 'PARTY_FULL' });
    entry.uses++;
    leaveParty(c.uuid);
    p.invited.delete(c.uuid);
    p.members.add(c.uuid);
    partyOf.set(c.uuid, p.id);
    user(c.uuid).partiesJoined = (user(c.uuid).partiesJoined || 0) + 1;
    save();
    pushParty(p);
    partyQuest(p);
    for (const id of p.members) if (id !== c.uuid) sendTo(id, { t: 'notify', kind: 'partyJoined', name: user(c.uuid).name });
  },

  /** Lista życzeń: kosmetyki, które gracz chciałby dostać (widać na profilu i u znajomych) */
  'wish.toggle'(c, m) {
    const u = user(c.uuid);
    const key = String(m.cosmetic || '');
    if (!catalog.exists(key) || catalog.FREE.includes(key)) return;
    const list = u.wishlist || [];
    if (list.includes(key)) u.wishlist = list.filter((k) => k !== key);
    else if (!u.unlocked.includes(key)) u.wishlist = [...list, key].slice(-20);
    save();
    pushMe(c.uuid);
    for (const f of u.friends) pushFriends(f);
  },

  /** Codzienna nagroda za logowanie (przycisk na stronie Graj w launcherze) */
  'daily.claim'(c) {
    const u = user(c.uuid);
    const r = progress.dailyClaim(u);
    c.send({ t: 'daily.claimed', ...r });
    if (r.ok) { updateBadges(c.uuid); pushMe(c.uuid); }
  },

  'quests.get'(c) { c.send({ t: 'quests', ...questsView(user(c.uuid)) }); },
  'quests.claim'(c, m) {
    const u = user(c.uuid);
    const r = claimQuest(u, String(m.id || ''));
    c.send({ t: 'quests.claimed', ...r, id: m.id });
    c.send({ t: 'quests', ...questsView(u) });
  },

  'party.leave'(c) { leaveParty(c.uuid); },

  'party.kick'(c, m) {
    const p = parties.get(partyOf.get(c.uuid));
    if (!p || p.leader !== c.uuid) return;
    leaveParty(dashed(m.uuid));
  },

  /** Lider wysyła całe party na swój serwer */
  'party.warp'(c, m) {
    const p = parties.get(partyOf.get(c.uuid));
    if (!p || p.leader !== c.uuid) return c.send({ t: 'error', code: 'NOT_LEADER' });
    const address = String(m.address || presenceOf(c.uuid).server || '').slice(0, 80);
    if (!address) return c.send({ t: 'error', code: 'NO_SERVER' });
    for (const id of p.members) if (id !== c.uuid) sendTo(id, { t: 'party.warp', address, from: user(c.uuid).name });
  },

  'profile.get'(c, m) {
    const u = m.uuid ? user(dashed(m.uuid)) : byName(m.name);
    if (!u) return c.send({ t: 'error', code: 'USER_NOT_FOUND', name: m.name });
    c.send({
      t: 'profile',
      profile: { uuid: u.uuid, name: u.name, cosmetics: u.cosmetics, stats: u.stats, firstSeen: u.firstSeen, lastSeen: u.lastSeen,
        friends: u.friends.length, level: levelOf(u), badges: u.badges || [], wishlist: (u.wishlist || []).filter((k) => !u.unlocked.includes(k)), ...presenceOf(u.uuid) },
    });
  },
};

// ---------------- weryfikacja konta (Mojang hasJoined) ----------------
async function verify(name, serverId) {
  const url = `${MOJANG}?username=${encodeURIComponent(name)}&serverId=${encodeURIComponent(serverId)}`;
  const res = await fetch(url);
  if (res.status !== 200) return null;
  const p = await res.json();
  return { uuid: dashed(p.id), name: p.name };
}

// ---------------- serwer HTTP + WebSocket ----------------
const admin = require('./admin');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, version: VERSION, online: online.size, users: Object.keys(db.users).length }));
  }
  if (url.pathname === '/news.json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'max-age=60' });
    return res.end(JSON.stringify(db.news.slice(0, 20)));
  }
  if (url.pathname === '/promo.json') {
    const p = db.promo || {};
    const t0 = now();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'max-age=120' });
    return res.end(JSON.stringify({
      partners: (p.partners || []).filter((x) => !x.hidden),
      ads: (p.ads || []).filter((a) => !a.hidden && (!a.until || a.until > t0)),
      creatorReward: p.creatorReward || 'cape:nebula',
    }));
  }
  if (url.pathname === '/capes.json' || url.pathname.startsWith('/capes/')) {
    if (!capesApi) { res.writeHead(503); return res.end(); }
    capesApi.http(req, res, url).then((ok) => { if (!ok) { res.writeHead(404); res.end(); } })
      .catch((e) => { console.error('[capes]', e.message); if (!res.headersSent) res.writeHead(500); res.end(); });
    return;
  }
  if (url.pathname === '/shop.json' || url.pathname.startsWith('/shop/') || url.pathname === '/tebex/webhook') {
    if (!shopApi) { res.writeHead(503); return res.end(); }
    shopApi.http(req, res, url).then((ok) => { if (!ok) { res.writeHead(404); res.end(); } })
      .catch((e) => { console.error('[shop]', e.message); if (!res.headersSent) res.writeHead(500); res.end(); });
    return;
  }
  if (url.pathname.startsWith('/api/shot/')) {
    if (!shotsApi) { res.writeHead(503); return res.end(); }
    shotsApi.http(req, res, url).then((ok) => { if (!ok) { res.writeHead(404); res.end(); } })
      .catch((e) => { console.error('[shots]', e.message); if (!res.headersSent) res.writeHead(500); res.end(); });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (!publicApi) { res.writeHead(503); return res.end(); }
    publicApi.http(req, res, url).then((ok) => { if (!ok) { res.writeHead(404); res.end(); } })
      .catch((e) => { console.error('[public]', e.message); if (!res.headersSent) res.writeHead(500); res.end(); });
    return;
  }
  if (url.pathname === '/join') return joinPage(res, url);
  if (url.pathname === '/party') return partyPage(res, url);
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return admin.route(req, res, url, adminCtx);
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Gruz Client server ' + VERSION);
});

/** Strona z przycisku "Join" na Discordzie: otwiera launcher (gruzclient://join/<ip>) */
function joinPage(res, url) {
  const ip = String(url.searchParams.get('ip') || '').trim().slice(0, 80);
  const ok = /^[a-z0-9.-]+(:\d{1,5})?$/i.test(ip);
  const e = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const deep = ok ? `gruzclient://join/${ip}` : '';
  res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join ${e(ip)} · Gruz Client</title>${ok ? `<meta http-equiv="refresh" content="0;url=${e(deep)}">` : ''}
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07050c;color:#f1ecf8;font:16px/1.5 'Segoe UI',system-ui,sans-serif}
.c{max-width:420px;padding:32px;border:1px solid #2b2139;background:#0c0912;text-align:center}h1{margin:0 0 6px;font-size:22px;color:#dcaaff}
code{color:#dcaaff;font-size:18px}a{display:inline-block;margin:14px 6px 0;padding:10px 18px;background:#b45cff;color:#12051f;font-weight:700;text-decoration:none}
a.g{background:transparent;color:#f1ecf8;border:1px solid #2b2139}p{color:#9488a8}</style></head><body><div class="c">
${ok ? `<h1>Opening Gruz Client…</h1><p>Joining</p><code>${e(ip)}</code><br><a href="${e(deep)}">Open launcher</a>
<a class="g" href="https://github.com/ilikemoneyrux/gruz-client/releases/latest">Download Gruz Client</a>
<p>Nothing happened? Install Gruz Client, then click "Open launcher" again.</p>` : '<h1>Bad server address</h1>'}
</div></body></html>`);
}

/** Strona z linku do party: otwiera launcher (gruzclient://party/<kod>) */
function partyPage(res, url) {
  const code = String(url.searchParams.get('c') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const entry = partyCodes.get(code);
  const ok = !!entry && entry.exp > now() && entry.uses < 7;
  const leader = ok ? user(entry.leader)?.name || '?' : '';
  const e = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const deep = `gruzclient://party/${code}`;
  res.writeHead(ok ? 200 : 410, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? `Join ${e(leader)}'s party` : 'Party link expired'} · Gruz Client</title>${ok ? `<meta http-equiv="refresh" content="0;url=${e(deep)}">` : ''}
<meta property="og:title" content="${ok ? `${e(leader)} invites you to a party` : 'Party link expired'}"><meta property="og:description" content="Gruz Client – play Minecraft together">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07050c;color:#f1ecf8;font:16px/1.5 'Segoe UI',system-ui,sans-serif}
.c{max-width:420px;padding:32px;border:1px solid #2b2139;background:#0c0912;text-align:center}h1{margin:0 0 6px;font-size:22px;color:#dcaaff}
a{display:inline-block;margin:14px 6px 0;padding:10px 18px;background:#b45cff;color:#12051f;font-weight:700;text-decoration:none}
a.g{background:transparent;color:#f1ecf8;border:1px solid #2b2139}p{color:#9488a8}img{image-rendering:pixelated}</style></head><body><div class="c">
${ok ? `<img src="https://mc-heads.net/avatar/${e(entry.leader)}/72" width="72" height="72" alt=""><h1>${e(leader)}'s party</h1><p>Opening Gruz Client…</p>
<a href="${e(deep)}">Join party</a><a class="g" href="https://github.com/ilikemoneyrux/gruz-client/releases/latest">Download Gruz Client</a>
<p>Nothing happened? Install Gruz Client, log in, then click "Join party" again.<br><small>Link works for 30 minutes.</small></p>`
    : '<h1>This party link has expired</h1><p>Ask your friend for a new one (<b>/gruz invite</b> on Discord or <b>Copy party link</b> in the launcher).</p>'}
</div></body></html>`);
}

/** To, czego potrzebuje panel admina */
const adminCtx = {
  password: ADMIN_PASSWORD, db, save, online, parties, levelOf, hoursOf, presenceOf, LOCKED, isCodeKey, VERSION,
  kick(uuid) { for (const c of clientsOf(uuid)) { c.send({ t: 'error', code: 'BANNED' }); c.ws.close(4003, 'banned'); } },
  MODULE_IDS, normHost, pushServerRules,
  updateBadges, pushMe, catalog, tiers, grantInviteRewards, dayKey, weekKey, weeklyXp, weeklyTop, QUESTS, streakTiers, DEFAULT_STREAK,
  bot: null, // uzupełnia bot Discord (panel "Bot")
};


const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 }); // wiadomości głosowe do ~20 s i screeny (~700 KB)

wss.on('connection', (ws, req) => {
  const c = {
    ws, uuid: null, name: null, kind: 'launcher', presence: { state: 'launcher', since: now() },
    serverId: crypto.randomBytes(16).toString('hex'), alive: true, rate: { n: 0, at: now() },
    ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, ''), // do koszyka Tebex
    send(msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); },
  };
  ws.on('pong', () => { c.alive = true; });

  ws.on('message', async (raw) => {
    // prosty limit: 40 wiadomości na 5 sekund; duże (głosowe) liczą się jak 10
    if (now() - c.rate.at > 5000) c.rate = { n: 0, at: now() };
    c.rate.n += raw.length > 32 * 1024 ? 10 : 1;
    if (c.rate.n > 40) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (!c.uuid) {
      if (m.t === 'hello') {
        c.kind = m.client === 'game' ? 'game' : 'launcher';
        c.version = String(m.version || '').replace(/[^\w.+-]/g, '').slice(0, 16);
        return c.send({ t: 'challenge', serverId: c.serverId, version: VERSION });
      }
      if (m.t === 'auth') {
        let who = null;
        try { who = await verify(String(m.name || ''), c.serverId); } catch { /* sieć */ }
        if (!who) { c.send({ t: 'error', code: 'AUTH_FAILED' }); return ws.close(4001, 'auth'); }
        if (user(who.uuid)?.banned) { c.send({ t: 'error', code: 'BANNED' }); return ws.close(4003, 'banned'); }
        c.uuid = who.uuid;
        c.name = who.name;
        ensureUser(who.uuid, who.name);
        if (c.kind === 'launcher' && c.version) user(who.uuid).launcher = c.version;
        markActive(who.uuid, c.kind === 'launcher' ? c.version : '');
        updateBadges(who.uuid);
        grantInviteRewards(user(who.uuid));
        capesApi?.grantLevel(user(who.uuid));
        if (!online.has(c.uuid)) online.set(c.uuid, new Set());
        online.get(c.uuid).add(c);
        const today = db.metrics.days[dayKey()];
        if (today) today.peak = Math.max(today.peak || 0, online.size);
        c.send({ t: 'welcome', uuid: c.uuid, name: c.name, party: partyOf.has(c.uuid) ? partyView(parties.get(partyOf.get(c.uuid))) : null,
          me: meView(user(c.uuid)), quests: questsView(user(c.uuid)) });
        if (c.kind === 'game') pushServerRules(c);
        pushFriends(c.uuid);
        announce(c.uuid);
        setTimeout(() => wishSaleCheck([user(c.uuid)]), 4000); // promocje z listy życzeń (gdy był offline)
        return;
      }
      return;
    }
    const h = handlers[m.t];
    if (h) {
      try { h(c, m); } catch (e) { console.error('[handler]', m.t, e); }
    }
  });

  ws.on('close', () => {
    if (!c.uuid) return;
    const set = online.get(c.uuid);
    if (set) { set.delete(c); if (!set.size) online.delete(c.uuid); }
    const u = user(c.uuid);
    if (u) { u.lastSeen = now(); save(); }
    if (!isOnline(c.uuid)) leaveParty(c.uuid);
    announce(c.uuid);
    trackServer(c.uuid);
  });
});

// rozłączanie martwych połączeń
setInterval(() => {
  for (const set of online.values()) for (const c of set) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

// start: najpierw wczytujemy dane, potem przyjmujemy graczy
(async () => {
  const where = await storage.init();
  for (const [name, key] of FILES) db[key] = await storage.load(name, db[key]);
  db.meta ||= {};
  db.metrics ||= { days: {}, today: null };
  db.metrics.days ||= {};
  db.capes ||= {};
  capesApi = require('./capes').setup({ db, save, levelOf, LOCKED, pushMe, sendTo, sendAll });
  adminCtx.capes = capesApi;
  db.shop ||= { token: '', items: {} };
  db.purchases ||= [];
  shopApi = require('./shop').setup({ db, save, user, byName, sendTo, pushMe, catalog, publicUrl, LOCKED });
  publicApi = require('./public').setup({ db, user, byName, levelOf, hoursOf, presenceOf, weeklyTop, weeklyRank, weeklyXp, BADGES, catalog, publicUrl,
    streakTiers, tiers, progress });
  adminCtx.shop = shopApi;
  shotsApi = require('./shots').setup({ db, save, user, storage, publicUrl });
  adminCtx.shots = shotsApi;
  setInterval(() => wishSaleCheck(), 15 * 60_000);
  levelListeners.push((u, lv) => { if (capesApi.grantLevel(u, lv)) pushMe(u.uuid); });
  weeklyTick();
  server.listen(PORT, () => console.log(`Gruz server ${VERSION} na porcie ${PORT}, dane: ${where}, graczy: ${Object.keys(db.users).length}`));
  // bot Discord (gdy ustawiono DISCORD_TOKEN)
  require('./discord')({
    db, save, online, presenceOf, levelOf, LOCKED, isCodeKey, serverKey, serverSessions, pushMe, consumeLinkCode, creatorKey, catalog,
    updateBadges, codePackages: require('./codepkgs'),
    tiers, grantInviteRewards, inviteCodeOf, onInvite: (f) => inviteListeners.push(f), registerAdmin: (api) => { adminCtx.bot = api; },
    onCrash: (f) => crashListeners.push(f),
    onCrashHelp: (f) => { crashHelp = f; },
    onLevel: (f) => levelListeners.push(f), onWeekly: (f) => weeklyListeners.push(f),
    partyLink, weeklyTop, weeklyXp, weeklyRank, weekKey, questsView,
    badgeName: (id) => { const b = BADGES.find((x) => x.id === id); return b && (db.discord?.lang === 'pl' ? b.pl : b.en || b.pl); },
  });
})().catch((e) => { console.error('Nie udało się uruchomić serwera:', e); process.exit(1); });

// przy zamykaniu (np. restart na hostingu) zapisujemy od razu
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { clearTimeout(saveTimer); await flush(); process.exit(0); });

module.exports = { server, db, handlers, levelOf, cleanCosmetics, serverKey };
