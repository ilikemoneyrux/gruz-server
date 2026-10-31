// Panel admina serwera Gruz: /admin (hasło z GRUZ_ADMIN_PASSWORD).
// Statystyki, wyszukiwanie graczy, bany, kody na kosmetyki i newsy publikowane w /news.json.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sessions = new Map(); // token -> wygasa
const attempts = new Map(); // ip -> { n, at }
const PAGE = path.join(__dirname, 'admin.html');

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function authed(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

const randomCode = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'GRUZ-';
  for (let i = 0; i < 8; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
};

async function route(req, res, url, ctx) {
  const p = url.pathname;
  if (p === '/admin' || p === '/admin/') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' https://mc-heads.net data:",
      'x-frame-options': 'DENY',
    });
    return res.end(fs.readFileSync(PAGE, 'utf8').replace('__ENABLED__', ctx.password ? 'true' : 'false'));
  }
  if (!ctx.password) return json(res, 403, { error: 'Panel wyłączony. Ustaw zmienną GRUZ_ADMIN_PASSWORD.' });

  try {
    if (p === '/admin/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || '?';
      const a = attempts.get(ip) || { n: 0, at: Date.now() };
      if (Date.now() - a.at > 10 * 60_000) { a.n = 0; a.at = Date.now(); }
      if (a.n >= 8) return json(res, 429, { error: 'Za dużo prób. Spróbuj za 10 minut.' });
      const body = await readBody(req);
      if (!safeEqual(body.password || '', ctx.password)) {
        a.n++;
        attempts.set(ip, a);
        return json(res, 401, { error: 'Złe hasło.' });
      }
      attempts.delete(ip);
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, Date.now() + 12 * 3600_000);
      return json(res, 200, { token });
    }
    if (!authed(req)) return json(res, 401, { error: 'Zaloguj się ponownie.' });

    const { db } = ctx;
    const users = Object.values(db.users);

    if (p === '/admin/api/stats') {
      const day = Date.now() - 864e5;
      const totalMs = users.reduce((a, u) => a + (u.stats?.totalMs || 0), 0);
      return json(res, 200, {
        version: ctx.VERSION,
        users: users.length,
        online: ctx.online.size,
        active24h: users.filter((u) => u.lastSeen > day).length,
        new24h: users.filter((u) => u.firstSeen > day).length,
        parties: ctx.parties.size,
        conversations: Object.keys(db.dms).length,
        messages: Object.values(db.dms).reduce((a, l) => a + l.length, 0),
        hours: Math.round(totalMs / 36e5),
        banned: users.filter((u) => u.banned).length,
        codes: Object.keys(db.codes).length,
        top: users.slice().sort((a, b) => (b.stats?.totalMs || 0) - (a.stats?.totalMs || 0)).slice(0, 10)
          .map((u) => ({ name: u.name, uuid: u.uuid, hours: Math.round(ctx.hoursOf(u) * 10) / 10, level: ctx.levelOf(u).level })),
      });
    }

    if (p === '/admin/api/users') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const list = users.filter((u) => !q || u.name.toLowerCase().includes(q) || u.uuid.includes(q))
        .sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 60)
        .map((u) => ({
          uuid: u.uuid, name: u.name, level: ctx.levelOf(u).level, hours: Math.round(ctx.hoursOf(u) * 10) / 10,
          kills: u.stats?.kills || 0, friends: u.friends.length, badges: u.badges || [], unlocked: u.unlocked || [],
          banned: !!u.banned, staff: !!u.staff, firstSeen: u.firstSeen, lastSeen: u.lastSeen, online: ctx.presenceOf(u.uuid).online,
        }));
      return json(res, 200, list);
    }

    if (p === '/admin/api/user' && req.method === 'POST') {
      const body = await readBody(req);
      const u = db.users[body.uuid];
      if (!u) return json(res, 404, { error: 'Nie ma takiego gracza.' });
      if ('banned' in body) { u.banned = !!body.banned; if (u.banned) ctx.kick(u.uuid); }
      if ('staff' in body) u.staff = !!body.staff;
      if (typeof body.unlock === 'string' && ctx.LOCKED.includes(body.unlock) && !u.unlocked.includes(body.unlock)) u.unlocked.push(body.unlock);
      if (typeof body.lock === 'string') u.unlocked = u.unlocked.filter((x) => x !== body.lock);
      ctx.save();
      ctx.updateBadges(u.uuid);
      if (ctx.pushMe) ctx.pushMe(u.uuid);
      return json(res, 200, { ok: true });
    }

    if (p === '/admin/api/codes' && req.method === 'GET') {
      return json(res, 200, {
        locked: ctx.LOCKED,
        codes: Object.entries(db.codes).map(([code, c]) => ({ code, ...c, used: c.used.length })).sort((a, b) => b.created - a.created),
      });
    }
    if (p === '/admin/api/codes' && req.method === 'POST') {
      const body = await readBody(req);
      if (!ctx.LOCKED.includes(body.cosmetic)) return json(res, 400, { error: 'Nieznana kosmetyka.' });
      const count = Math.max(1, Math.min(100, Number(body.count) || 1));
      const made = [];
      for (let i = 0; i < count; i++) {
        let code = count === 1 && body.code ? String(body.code).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32) : randomCode();
        if (!code || db.codes[code]) code = randomCode();
        db.codes[code] = { cosmetic: body.cosmetic, maxUses: Math.max(0, Number(body.maxUses) || 1), used: [], created: Date.now(), note: String(body.note || '').slice(0, 80) };
        made.push(code);
      }
      ctx.save();
      return json(res, 200, { made });
    }
    if (p.startsWith('/admin/api/codes/') && req.method === 'DELETE') {
      delete db.codes[decodeURIComponent(p.slice('/admin/api/codes/'.length))];
      ctx.save();
      return json(res, 200, { ok: true });
    }

    if (p === '/admin/api/crashes') {
      return json(res, 200, (db.crashes || []).slice(0, 100).map(({ log, ...r }) => ({ ...r, logSize: (log || '').length })));
    }
    if (p.startsWith('/admin/api/crashes/')) {
      const r = (db.crashes || []).find((x) => x.id === decodeURIComponent(p.slice('/admin/api/crashes/'.length)));
      if (!r) return json(res, 404, { error: 'Nie ma takiego raportu.' });
      return json(res, 200, r);
    }
    if (p === '/admin/api/news' && req.method === 'GET') return json(res, 200, db.news);
    if (p === '/admin/api/news' && req.method === 'POST') {
      const b = await readBody(req);
      const str = (v, n) => String(v || '').trim().slice(0, n);
      const item = {
        id: 'n' + Date.now().toString(36),
        date: new Date().toISOString().slice(0, 10),
        tag: { pl: str(b.tagPl, 30) || 'News', en: str(b.tagEn, 30) || str(b.tagPl, 30) || 'News' },
        title: { pl: str(b.titlePl, 120), en: str(b.titleEn, 120) || str(b.titlePl, 120) },
        body: { pl: str(b.bodyPl, 2000), en: str(b.bodyEn, 2000) || str(b.bodyPl, 2000) },
      };
      if (!item.title.pl || !item.body.pl) return json(res, 400, { error: 'Tytuł i treść są wymagane.' });
      db.news.unshift(item);
      db.news = db.news.slice(0, 50);
      ctx.save();
      return json(res, 200, item);
    }
    if (p.startsWith('/admin/api/news/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/admin/api/news/'.length));
      db.news = db.news.filter((n) => n.id !== id);
      ctx.db.news = db.news;
      ctx.save();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Nie znaleziono.' });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}

module.exports = { route };
