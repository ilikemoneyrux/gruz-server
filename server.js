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
const VERSION = '1.1.0';
const ADMIN_PASSWORD = process.env.GRUZ_ADMIN_PASSWORD || '';
const storage = require('./storage');

// ---------------- magazyn danych (pliki JSON, zapis z opóźnieniem) ----------------
// dane trzymamy w pamięci, a zapisujemy z opóźnieniem (pliki albo PostgreSQL – patrz storage.js)
const db = {
  users: {},   // uuid -> { uuid, name, friends[], incoming[], outgoing[], cosmetics, stats, firstSeen, lastSeen }
  dms: {},     // "uuidA|uuidB" (posortowane) -> [{ from, text|voice|sticker, at }]
  codes: {},   // KOD -> { cosmetic, maxUses, used: [uuid], created, note }
  news: [],    // [{ id, date, tag, title, body }] – publikowane w /news.json
};
const FILES = [['users.json', 'users'], ['dms.json', 'dms'], ['codes.json', 'codes'], ['news.json', 'news']];
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

function user(uuid) { return db.users[uuid]; }
function ensureUser(uuid, name) {
  if (!db.users[uuid]) {
    db.users[uuid] = { uuid, name, friends: [], incoming: [], outgoing: [], cosmetics: '', stats: {}, firstSeen: now(), lastSeen: now(),
      joinIndex: Object.keys(db.users).length + 1, unlocked: [], badges: [], partiesLed: 0, partiesJoined: 0, dmsSent: 0 };
  }
  const u = db.users[uuid];
  for (const [k, v] of [['unlocked', []], ['badges', []], ['partiesLed', 0], ['partiesJoined', 0], ['dmsSent', 0]]) if (u[k] === undefined) u[k] = v;
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
    + (u.partiesLed || 0) * 15 + (u.partiesJoined || 0) * 10 + Math.min(500, (u.dmsSent || 0) * 0.5));
}
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
  const have = BADGES.filter((b) => b.test(u)).map((b) => b.id);
  const fresh = have.filter((id) => !u.badges.includes(id));
  u.badges = have;
  if (fresh.length) {
    save();
    for (const id of fresh) {
      const b = BADGES.find((x) => x.id === id);
      sendTo(uuid, { t: 'notify', kind: 'badge', id, names: { pl: b.pl, en: b.en } });
    }
    pushMe(uuid);
  }
}
function meView(u) {
  return { level: levelOf(u), badges: u.badges || [], unlocked: u.unlocked || [] };
}
function pushMe(uuid) { const u = user(uuid); if (u) sendTo(uuid, { t: 'me', ...meView(u) }); }

// ---------------- kosmetyki na kody ----------------
/** Te kosmetyki trzeba odblokować kodem. Bez kodu serwer nie pokaże ich innym graczom. */
const LOCKED = ['cape:aurora', 'cape:ember'];
function cleanCosmetics(u, set) {
  return String(set || '').slice(0, 200).split(';').map((part) => {
    const [slot, value] = part.split('=');
    if (!slot) return null;
    const key = `${slot}:${value}`;
    if (LOCKED.includes(key) && !(u.unlocked || []).includes(key)) return `${slot}=none`;
    return `${slot}=${value || 'none'}`;
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

// ---------------- obsługa wiadomości ----------------
const handlers = {
  presence(c, m) {
    const state = String(m.state || 'launcher').slice(0, 20);
    const server = m.server ? String(m.server).slice(0, 80) : null;
    const changed = state !== c.presence.state || server !== c.presence.server;
    c.presence = { state, server, since: changed ? now() : c.presence.since };
    announce(c.uuid);
    syncRoom(c);
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

  emote(c, m) {
    const id = String(m.id || '').slice(0, 20);
    const key = roomKey(c);
    if (key) for (const o of roomMembers(key)) if (o !== c) o.send({ t: 'emote', uuid: c.uuid, id });
  },

  stats(c, m) {
    const u = user(c.uuid);
    const num = (v) => Math.max(0, Math.min(1e13, Number(v) || 0));
    u.stats = { totalMs: num(m.totalMs), sessions: num(m.sessions), longestMs: num(m.longestMs), kills: num(m.kills) };
    save();
    updateBadges(c.uuid);
  },

  /** Kod na ekskluzywną kosmetykę */
  'code.redeem'(c, m) {
    const code = String(m.code || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32);
    const entry = db.codes[code];
    const u = user(c.uuid);
    if (!entry) return c.send({ t: 'error', code: 'CODE_INVALID' });
    if (entry.used.includes(c.uuid) || u.unlocked.includes(entry.cosmetic)) return c.send({ t: 'error', code: 'CODE_USED' });
    if (entry.maxUses && entry.used.length >= entry.maxUses) return c.send({ t: 'error', code: 'CODE_EXHAUSTED' });
    entry.used.push(c.uuid);
    u.unlocked.push(entry.cosmetic);
    save();
    c.send({ t: 'unlocked', cosmetic: entry.cosmetic, unlocked: u.unlocked });
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
    let p = parties.get(partyOf.get(c.uuid));
    if (!p) {
      p = { id: crypto.randomUUID(), leader: c.uuid, members: new Set([c.uuid]), invited: new Set() };
      parties.set(p.id, p);
      partyOf.set(c.uuid, p.id);
      user(c.uuid).partiesLed = (user(c.uuid).partiesLed || 0) + 1;
      save();
      updateBadges(c.uuid);
    }
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
        friends: u.friends.length, level: levelOf(u), badges: u.badges || [], ...presenceOf(u.uuid) },
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
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return admin.route(req, res, url, adminCtx);
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Gruz Client server ' + VERSION);
});

/** To, czego potrzebuje panel admina */
const adminCtx = {
  password: ADMIN_PASSWORD, db, save, online, parties, levelOf, hoursOf, presenceOf, LOCKED, VERSION,
  kick(uuid) { for (const c of clientsOf(uuid)) { c.send({ t: 'error', code: 'BANNED' }); c.ws.close(4003, 'banned'); } },
  updateBadges,
};

const wss = new WebSocketServer({ server, maxPayload: 600 * 1024 }); // wiadomości głosowe do ~20 s

wss.on('connection', (ws, req) => {
  const c = {
    ws, uuid: null, name: null, kind: 'launcher', presence: { state: 'launcher', since: now() },
    serverId: crypto.randomBytes(16).toString('hex'), alive: true, rate: { n: 0, at: now() },
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
        updateBadges(who.uuid);
        if (!online.has(c.uuid)) online.set(c.uuid, new Set());
        online.get(c.uuid).add(c);
        c.send({ t: 'welcome', uuid: c.uuid, name: c.name, party: partyOf.has(c.uuid) ? partyView(parties.get(partyOf.get(c.uuid))) : null,
          me: meView(user(c.uuid)) });
        pushFriends(c.uuid);
        announce(c.uuid);
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
  server.listen(PORT, () => console.log(`Gruz server ${VERSION} na porcie ${PORT}, dane: ${where}, graczy: ${Object.keys(db.users).length}`));
})().catch((e) => { console.error('Nie udało się uruchomić serwera:', e); process.exit(1); });

// przy zamykaniu (np. restart na hostingu) zapisujemy od razu
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { clearTimeout(saveTimer); await flush(); process.exit(0); });

module.exports = { server, db, handlers, levelOf, cleanCosmetics };
