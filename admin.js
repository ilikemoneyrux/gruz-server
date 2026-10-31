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
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' https: data:",
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

    // ---------- serwery partnerskie i reklamy ----------
    const str = (v, n) => String(v ?? '').trim().slice(0, n);
    const httpUrl = (v) => { const s = str(v, 400); return /^https:\/\//i.test(s) ? s : ''; };
    db.promo ||= { partners: [], ads: [], creatorReward: 'cape:nebula' };
    if (p === '/admin/api/promo' && req.method === 'GET') {
      return json(res, 200, { ...db.promo, cosmetics: ctx.LOCKED.filter((k) => k !== 'all') });
    }
    if (p === '/admin/api/promo/partner' && req.method === 'POST') {
      const b = await readBody(req);
      const item = {
        id: str(b.id, 20) || 'p' + Date.now().toString(36), name: str(b.name, 40), ip: str(b.ip, 80).toLowerCase(),
        desc: str(b.desc, 140), tag: str(b.tag, 20), color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '',
        url: httpUrl(b.url), hidden: !!b.hidden,
      };
      if (!item.name || !/^[a-z0-9.-]+(:\d{1,5})?$/.test(item.ip)) return json(res, 400, { error: 'Podaj nazwę i poprawne IP.' });
      const i = db.promo.partners.findIndex((x) => x.id === item.id);
      if (i >= 0) db.promo.partners[i] = item; else db.promo.partners.push(item);
      ctx.save();
      return json(res, 200, item);
    }
    if (p === '/admin/api/promo/ad' && req.method === 'POST') {
      const b = await readBody(req);
      const days = Number(b.days) || 0;
      const item = {
        id: str(b.id, 20) || 'a' + Date.now().toString(36), title: str(b.title, 60), text: str(b.text, 160),
        image: httpUrl(b.image), url: httpUrl(b.url), cta: str(b.cta, 24),
        until: days > 0 ? Date.now() + days * 864e5 : (Number(b.until) || 0), hidden: !!b.hidden,
      };
      if (!item.title) return json(res, 400, { error: 'Reklama musi mieć tytuł.' });
      const i = db.promo.ads.findIndex((x) => x.id === item.id);
      if (i >= 0) db.promo.ads[i] = item; else db.promo.ads.push(item);
      ctx.save();
      return json(res, 200, item);
    }
    if (p === '/admin/api/promo/reward' && req.method === 'POST') {
      const b = await readBody(req);
      if (!ctx.catalog.exists(b.cosmetic || '')) return json(res, 400, { error: 'Nieznana kosmetyka.' });
      db.promo.creatorReward = b.cosmetic;
      ctx.save();
      return json(res, 200, { ok: true });
    }
    if (p === '/admin/api/promo/move' && req.method === 'POST') {
      const b = await readBody(req);
      const list = b.kind === 'ad' ? db.promo.ads : db.promo.partners;
      const i = list.findIndex((x) => x.id === b.id), j = i + (b.dir < 0 ? -1 : 1);
      if (i >= 0 && j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; ctx.save(); }
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/admin/api/promo/') && req.method === 'DELETE') {
      const [kind, id] = p.slice('/admin/api/promo/'.length).split('/').map(decodeURIComponent);
      if (kind === 'partner') db.promo.partners = db.promo.partners.filter((x) => x.id !== id);
      if (kind === 'ad') db.promo.ads = db.promo.ads.filter((x) => x.id !== id);
      ctx.save();
      return json(res, 200, { ok: true });
    }

    // ---------- zaproszenia znajomych ----------
    if (p === '/admin/api/invites' && req.method === 'GET') {
      const top = users.filter((u) => (u.invited || []).length).sort((a, b) => b.invited.length - a.invited.length).slice(0, 15)
        .map((u) => ({ name: u.name, uuid: u.uuid, count: u.invited.length, code: u.inviteCode }));
      return json(res, 200, { tiers: ctx.tiers(), welcome: db.promo.inviteWelcome || '', cosmetics: ctx.LOCKED.filter((k) => k !== 'all'), top,
        total: users.filter((u) => u.referredBy?.startsWith('P:')).length });
    }
    if (p === '/admin/api/invites' && req.method === 'POST') {
      const b = await readBody(req);
      const list = (Array.isArray(b.tiers) ? b.tiers : []).map((x) => ({ count: Math.max(1, Math.min(1000, Math.round(Number(x.count) || 0))), cosmetic: String(x.cosmetic || '') }))
        .filter((x) => x.count && ctx.catalog.exists(x.cosmetic)).slice(0, 12);
      db.promo.inviteTiers = list.sort((a, c) => a.count - c.count);
      if ('welcome' in b) db.promo.inviteWelcome = ctx.catalog.exists(b.welcome || '') ? b.welcome : '';
      ctx.save();
      for (const u of users) if ((u.invited || []).length) { ctx.grantInviteRewards(u); ctx.pushMe(u.uuid); }
      return json(res, 200, { ok: true, tiers: db.promo.inviteTiers });
    }

    // ---------- bot Discord ----------
    if (p.startsWith('/admin/api/bot')) {
      const bot = ctx.bot;
      if (!bot) return json(res, 200, { online: false, reason: 'Bot nie działa (brak DISCORD_TOKEN w zmiennych na Renderze).' });
      if (p === '/admin/api/bot' && req.method === 'GET') return json(res, 200, await bot.info());
      const b = req.method === 'POST' ? await readBody(req) : {};
      if (p === '/admin/api/bot/config' && req.method === 'POST') return json(res, 200, await bot.setConfig(b));
      if (p === '/admin/api/bot/release' && req.method === 'POST') return json(res, 200, await bot.releaseNow());
      if (p === '/admin/api/bot/event' && req.method === 'POST') return json(res, 200, await bot.createEvent(b));
      if (p.startsWith('/admin/api/bot/event/') && req.method === 'DELETE') return json(res, 200, await bot.cancelEvent(decodeURIComponent(p.slice('/admin/api/bot/event/'.length))));
      if (p === '/admin/api/bot/announce' && req.method === 'POST') return json(res, 200, await bot.announce(b));
      if (p === '/admin/api/bot/panel' && req.method === 'POST') return json(res, 200, await bot.postPanel(b));
      if (p === '/admin/api/bot/giveaway' && req.method === 'POST') return json(res, 200, await bot.giveaway(b));
      if (p === '/admin/api/bot/ticket-category' && req.method === 'POST') return json(res, 200, await bot.ticketCategory(b));
      if (p === '/admin/api/bot/levels-sync' && req.method === 'POST') return json(res, 200, await bot.syncLevels());
      if (p === '/admin/api/bot/ranking' && req.method === 'POST') return json(res, 200, await bot.postRanking());
      return json(res, 404, { error: 'Nie znaleziono.' });
    }

    // ---------- kody twórców ----------
    db.creators ||= {};
    if (p === '/admin/api/creators' && req.method === 'GET') {
      return json(res, 200, Object.values(db.creators).map((c) => ({ ...c, uses: (c.uses || []).length }))
        .sort((a, b) => b.uses - a.uses));
    }
    if (p === '/admin/api/creators' && req.method === 'POST') {
      const b = await readBody(req);
      const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
      if (code.length < 3) return json(res, 400, { error: 'Kod musi mieć min. 3 znaki (litery, cyfry, - i _).' });
      if (db.codes[code]) return json(res, 400, { error: 'Taki kod na kosmetykę już istnieje.' });
      const cosmetic = b.cosmetic && ctx.catalog.exists(b.cosmetic) ? b.cosmetic : null;
      const old = db.creators[code];
      db.creators[code] = { code, name: str(b.name, 40) || code, discordId: old?.discordId || null, cosmetic, uses: old?.uses || [], created: old?.created || Date.now() };
      ctx.save();
      return json(res, 200, db.creators[code]);
    }
    if (p.startsWith('/admin/api/creators/') && req.method === 'DELETE') {
      delete db.creators[decodeURIComponent(p.slice('/admin/api/creators/'.length))];
      ctx.save();
      return json(res, 200, { ok: true });
    }

    // ---------- wykresy: nowi gracze, skąd przyszli, aktywni ----------
    if (p === '/admin/api/growth') {
      const days = Math.max(7, Math.min(180, Number(url.searchParams.get('days')) || 30));
      const keys = [];
      for (let k = days - 1; k >= 0; k--) keys.push(ctx.dayKey(Date.now() - k * 864e5));
      const uniq = [...new Set(keys)];
      const rows = Object.fromEntries(uniq.map((k) => [k, { day: k, organic: 0, creator: 0, friend: 0, active: 0, peak: 0, sessions: 0 }]));
      const from = uniq[0];
      const creators = {}, inviters = {};
      let organic = 0, creator = 0, friend = 0;
      for (const u of users) {
        const k = ctx.dayKey(u.firstSeen || 0);
        if (k < from) continue;
        const src = !u.referredBy ? 'organic' : u.referredBy.startsWith('P:') ? 'friend' : 'creator';
        if (rows[k]) rows[k][src]++;
        if (src === 'organic') organic++;
        if (src === 'creator') { creator++; creators[u.referredBy] = (creators[u.referredBy] || 0) + 1; }
        if (src === 'friend') {
          friend++;
          const inv = db.users[u.referredBy.slice(2)];
          if (inv) inviters[inv.name] = (inviters[inv.name] || 0) + 1;
        }
      }
      const m = db.metrics?.days || {};
      const versions = {};
      for (const k of uniq) {
        if (m[k]) { rows[k].active = m[k].active || 0; rows[k].peak = m[k].peak || 0; rows[k].sessions = m[k].sessions || 0; }
      }
      // wersje launchera u graczy aktywnych w tym okresie
      const since = Date.now() - days * 864e5;
      for (const u of users) if (u.lastSeen > since && u.launcher) versions[u.launcher] = (versions[u.launcher] || 0) + 1;
      const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => ({ name, n }));
      return json(res, 200, {
        days: uniq.map((k) => rows[k]), totals: { organic, creator, friend, all: organic + creator + friend },
        creators: top(creators).map((x) => ({ ...x, name: (db.creators[x.name]?.name || x.name) + ' (' + x.name + ')' })),
        inviters: top(inviters), versions: top(versions),
        trackedSince: Object.keys(m).sort()[0] || null,
        retention: (() => {
          // ilu z nowych graczy wróciło po co najmniej 1 dniu
          const fresh = users.filter((u) => u.firstSeen > since && Date.now() - u.firstSeen > 864e5);
          const back = fresh.filter((u) => (u.lastSeen || 0) - (u.firstSeen || 0) > 864e5).length;
          return { fresh: fresh.length, back };
        })(),
      });
    }

    // ---------- codzienne zadania i ranking tygodniowy ----------
    if (p === '/admin/api/quests' && req.method === 'GET') {
      const today = ctx.dayKey();
      const daily = users.map((u) => u.daily).filter((d) => d && d.day === today);
      const claimed = {};
      for (const d of daily) for (const id of d.claimed || []) claimed[id] = (claimed[id] || 0) + 1;
      return json(res, 200, {
        quests: ctx.QUESTS.map((q) => ({ id: q.id, pl: q.pl, en: q.en, goal: q.goal, defaultXp: q.xp, xp: Number(db.promo.questXp?.[q.id]) || q.xp, claimedToday: claimed[q.id] || 0 })),
        streak: ctx.streakTiers(), weeklyReward: db.promo.weeklyReward || { places: 0, cosmetic: '' },
        cosmetics: ctx.LOCKED.filter((k) => k !== 'all'),
        today: { players: daily.length, complete: daily.filter((d) => d.ids.every((x) => (d.claimed || []).includes(x))).length },
        week: ctx.weekKey(), weekly: ctx.weeklyTop(15), lastWeekly: db.meta?.lastWeekly || null,
        streaks: users.filter((u) => u.streak?.n).sort((a, b) => b.streak.n - a.streak.n).slice(0, 10).map((u) => ({ name: u.name, n: u.streak.n, last: u.streak.last, best: u.streakBest || 0 })),
      });
    }
    if (p === '/admin/api/quests' && req.method === 'POST') {
      const b = await readBody(req);
      if (Array.isArray(b.streak)) {
        db.promo.questStreak = b.streak.map((x) => ({ days: Math.max(1, Math.min(365, Math.round(Number(x.days) || 0))), cosmetic: String(x.cosmetic || '') }))
          .filter((x) => x.days && ctx.catalog.exists(x.cosmetic)).sort((a, c) => a.days - c.days).slice(0, 12);
      }
      if (b.xp && typeof b.xp === 'object') {
        db.promo.questXp = {};
        for (const q of ctx.QUESTS) { const v = Math.round(Number(b.xp[q.id]) || 0); if (v > 0 && v <= 1000 && v !== q.xp) db.promo.questXp[q.id] = v; }
      }
      if (b.weeklyReward) {
        const c = String(b.weeklyReward.cosmetic || '');
        db.promo.weeklyReward = { places: Math.max(0, Math.min(10, Math.round(Number(b.weeklyReward.places) || 0))), cosmetic: ctx.catalog.exists(c) ? c : '' };
      }
      ctx.save();
      return json(res, 200, { ok: true });
    }

    if (p === '/admin/api/crashes') {
      return json(res, 200, (db.crashes || []).slice(0, 100).map(({ log, ...r }) => ({ ...r, logSize: (log || '').length, ticket: r.ticket || null })));
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
