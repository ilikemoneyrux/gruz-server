// Publiczne API dla strony gruzclient.com: profile graczy (/u/<nick>), ranking (/top) i skiny z Mojanga.
// Pokazujemy tylko to, co i tak widać w grze i na Discordzie: nick, poziom, godziny, odznaki, założone kosmetyki,
// czy gracz jest online (bez adresu serwera). Gracz z u.privateProfile = true nie ma publicznego profilu ani miejsca w rankingu.
const SKIN_TTL = 60 * 60_000;

function setup(ctx) {
  const { db, user, byName, levelOf, hoursOf, presenceOf, weeklyTop, weeklyRank, weeklyXp, BADGES, catalog, publicUrl, streakTiers, tiers, progress, coins } = ctx;
  const visible = (u) => u && !u.banned && !u.privateProfile;

  // ---------------- limit zapytań z jednego IP ----------------
  const hits = new Map();
  function tooMany(ip, max = 90, perMs = 60_000) {
    const t0 = Date.now();
    const list = (hits.get(ip) || []).filter((t) => t0 - t < perMs);
    list.push(t0);
    hits.set(ip, list);
    if (hits.size > 5000) for (const [k, l] of hits) if (!l.length || t0 - l[l.length - 1] > perMs) hits.delete(k);
    return list.length > max;
  }
  const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  function send(res, code, body, maxAge = 30) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': code === 200 ? `public, max-age=${maxAge}` : 'no-store' });
    res.end(JSON.stringify(body));
  }

  // ---------------- skiny z Mojanga (pamięć 1 h) ----------------
  const skins = new Map(); // uuid -> { at, png: Buffer|null, slim }
  async function skinOf(uuid) {
    const hit = skins.get(uuid);
    if (hit && Date.now() - hit.at < SKIN_TTL) return hit;
    let out = { at: Date.now(), png: null, slim: false };
    try {
      const r = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, '')}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const p = await r.json();
        const tex = JSON.parse(Buffer.from(p.properties?.find((x) => x.name === 'textures')?.value || '', 'base64').toString('utf8') || '{}');
        const s = tex.textures?.SKIN;
        if (s?.url && /^https?:\/\/textures\.minecraft\.net\//.test(s.url)) {
          const img = await fetch(s.url.replace(/^http:/, 'https:'), { signal: AbortSignal.timeout(8000) });
          if (img.ok) out = { at: Date.now(), png: Buffer.from(await img.arrayBuffer()), slim: s.metadata?.model === 'slim' };
        }
      }
    } catch { /* Mojang nie odpowiada – strona pokaże domyślny skin */ }
    if (!out.png && hit?.png) out = { ...hit, at: Date.now() - SKIN_TTL + 5 * 60_000 }; // stary skin jeszcze 5 min
    skins.set(uuid, out);
    if (skins.size > 800) skins.delete(skins.keys().next().value);
    return out;
  }

  // ---------------- kosmetyki ----------------
  const BUILTIN_HD = new Set(['gruz', 'nebula', 'sakura', 'inferno', 'ocean', 'pumpkin', 'winter']);
  function cosmeticsOf(u) {
    const out = {};
    for (const part of String(u.cosmetics || '').split(';')) {
      const [slot, v] = part.split('=');
      if (!slot || !v || v === 'none') continue;
      const key = `${slot}:${v}`;
      if (!catalog.exists(key) || !catalog.allowed(key, coins ? coins.effective(u) : u.unlocked || [])) continue; // tylko to, co gracz może nosić
      out[slot] = { id: v, name: catalog.customName(key, 'en') ? { en: catalog.customName(key, 'en'), pl: catalog.customName(key, 'pl') } : null };
    }
    const cape = out.cape?.id;
    const capeUrl = !cape ? null : catalog.custom[cape] ? publicUrl(`/capes/${cape}.png?v=${catalog.custom[cape].ver || 1}`) : BUILTIN_HD.has(cape) ? publicUrl(`/shop/cape/${cape}.png`) : null;
    return { worn: out, capeUrl };
  }

  async function profile(u) {
    const lv = levelOf(u);
    const s = await skinOf(u.uuid);
    const badges = (u.badges || []).map((id) => BADGES.find((b) => b.id === id)).filter(Boolean).map((b) => ({ id: b.id, pl: b.pl, en: b.en }));
    return {
      name: u.name, uuid: u.uuid,
      level: { level: lv.level, xp: lv.xp, next: lv.next, total: lv.total },
      hours: Math.round(hoursOf(u) * 10) / 10,
      firstSeen: u.firstSeen || null, online: !!presenceOf(u.uuid).online,
      friends: (u.friends || []).length, badges,
      weekly: { xp: weeklyXp(u), rank: weeklyXp(u) > 0 ? 1 + Object.values(db.users).filter((x) => visible(x) && weeklyXp(x) > weeklyXp(u)).length : null }, // jak w /api/top (bez ukrytych)
      cosmetics: cosmeticsOf(u),
      wishlist: (u.wishlist || []).filter((k) => !(u.unlocked || []).includes(k)),
      achievements: { done: (u.badges || []).filter((id) => id !== 'plus').length, total: BADGES.filter((b) => b.id !== 'staff' && b.id !== 'plus').length },
      plus: !!coins?.plusActive(u),
      pass: progress ? { tier: progress.passTier(u), tiers: 30, premium: progress.premium(u) } : null,
      skin: { url: s.png ? publicUrl(`/api/skin/${u.uuid}.png`) : null, slim: s.slim },
    };
  }

  function top(period, n) {
    if (period === 'week') return weeklyTop(500).filter((x) => visible(user(x.uuid))).slice(0, n).map((x, i) => ({ rank: i + 1, name: x.name, uuid: x.uuid, level: x.level, value: x.xp }));
    return Object.values(db.users).filter(visible).map((u) => ({ name: u.name, uuid: u.uuid, level: levelOf(u).level, value: Math.round(hoursOf(u) * 10) / 10 }))
      .filter((x) => x.value > 0).sort((a, b) => b.value - a.value).slice(0, n).map((x, i) => ({ rank: i + 1, ...x }));
  }

  // ---------------- obrazki do podglądu linków (Discord, X…): 1200x630, pamięć 10 minut ----------------
  const cards = new Map(); // "profile:nick" -> { at, png }
  async function cardImage(kind, id) {
    const key = kind + ':' + id.toLowerCase();
    const hit = cards.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.png;
    let o = null;
    if (kind === 'profile') {
      const u = byName(id);
      if (!visible(u)) return null;
      const s = await skinOf(u.uuid);
      const cape = /(?:^|;)cape=([a-z0-9_]+)/.exec(u.cosmetics || '')?.[1];
      o = { title: u.name, kicker: coins?.plusActive(u) ? 'GRUZ+ PLAYER' : 'GRUZ CLIENT PLAYER', skin: s.png, slim: s.slim,
        cape: cape && cape !== 'none' && catalog.allowed('cape:' + cape, coins ? coins.effective(u) : u.unlocked || []) ? cape : null,
        chips: [`Level ${levelOf(u).level}`, `${Math.round(hoursOf(u))} h played`, `${(u.badges || []).length} badges`], foot: `gruzclient.com/u/${u.name}` };
    } else {
      const code = ctx.creatorKey(id);
      const cr = db.creators?.[code];
      const inv = !cr ? ctx.byInvite(code) : null;
      if (!cr && !visible(inv)) return null;
      const s = inv ? await skinOf(inv.uuid) : { png: null, slim: false };
      const reward = cr ? cr.cosmetic || db.promo?.creatorReward || 'cape:nebula' : db.promo?.inviteWelcome || null;
      o = { title: cr ? cr.name : inv.name, kicker: 'PLAY GRUZ CLIENT WITH', skin: s.png, slim: s.slim,
        cape: reward && reward.startsWith('cape:') ? reward.slice(5) : 'gruz', codeBox: code,
        chips: reward ? ['Free cosmetic with this code'] : ['Free Minecraft launcher & client'], foot: `gruzclient.com/c/${code}` };
    }
    let png = null;
    try { png = await require('./bot/images').shareCard(o); } catch (e) { console.error('[card]', e.message); }
    cards.set(key, { at: Date.now(), png });
    if (cards.size > 300) cards.delete(cards.keys().next().value);
    return png;
  }

  async function http(req, res, url) {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'access-control-max-age': '600' }); res.end(); return true; }
    if (req.method !== 'GET') return false;
    if (tooMany(ipOf(req))) { send(res, 429, { error: 'SLOW' }); return true; }
    if (url.pathname === '/api/profile') {
      const nick = String(url.searchParams.get('name') || '').trim();
      if (!/^[A-Za-z0-9_]{2,16}$/.test(nick)) { send(res, 400, { error: 'NICK' }); return true; }
      const u = byName(nick);
      if (!visible(u)) { send(res, 404, { error: 'NO_PLAYER' }); return true; }
      send(res, 200, await profile(u), 60);
      return true;
    }
    if (url.pathname === '/api/top') {
      const period = url.searchParams.get('period') === 'all' ? 'all' : 'week';
      const n = Math.min(100, Math.max(1, Number(url.searchParams.get('n')) || 50));
      send(res, 200, { period, unit: period === 'week' ? 'xp' : 'hours', reward: db.promo?.weeklyReward || null, rows: top(period, n), players: Object.values(db.users).filter(visible).length }, 120);
      return true;
    }
    if (url.pathname === '/api/cosmetics') {
      // galeria kosmetyków na stronie: katalog i to, jak można dostać każdą rzecz za darmo
      const how = {};
      const add = (key, what) => { if (key) (how[key] ||= []).push(what); };
      for (const k of catalog.FREE) add(k, { type: 'free' });
      for (const [id, s] of Object.entries(catalog.SEASONS)) for (const k of s.items) add(k, { type: 'event', event: id, from: s.from, to: s.to });
      for (const t of streakTiers()) add(t.cosmetic, { type: 'streak', days: t.days });
      for (const t of tiers()) add(t.cosmetic, { type: 'invite', count: t.count });
      if (db.promo?.weeklyReward?.cosmetic) add(db.promo.weeklyReward.cosmetic, { type: 'weekly', places: Number(db.promo.weeklyReward.places) || 0 });
      if (db.promo?.creatorReward) add(db.promo.creatorReward, { type: 'creator' });
      if (progress) {
        for (const r of progress.rewardList()) { add(r.free, { type: 'pass', tier: r.tier, premium: false }); add(r.premium, { type: 'pass', tier: r.tier, premium: true }); }
      }
      for (const c of Object.values(catalog.custom)) if (c.unlock === 'level') add(`cape:${c.id}`, { type: 'level', level: c.level });
      const custom = Object.values(catalog.custom).map((c) => ({ id: c.id, name: { pl: c.pl, en: c.en || c.pl }, url: publicUrl(`/capes/${c.id}.png?v=${c.ver || 1}`) }));
      send(res, 200, { catalog: catalog.CATALOG, how, custom, season: catalog.activeSeason(), duoEmotes: ['highfive', 'hug', 'duodance'] }, 300);
      return true;
    }
    if (url.pathname === '/api/creator') {
      // strona gruzclient.com/c/<KOD>: kod twórcy (panel → Twórcy) albo kod zaproszenia gracza
      const code = ctx.creatorKey(url.searchParams.get('code'));
      const cr = code && db.creators?.[code];
      const inv = !cr && code ? ctx.byInvite(code) : null;
      if (!cr && !visible(inv)) { send(res, 404, { error: 'NO_CODE' }); return true; }
      const reward = cr ? cr.cosmetic || db.promo?.creatorReward || 'cape:nebula' : db.promo?.inviteWelcome || null;
      const key = reward && catalog.exists(reward) ? reward : null;
      send(res, 200, {
        code, kind: cr ? 'creator' : 'friend', name: cr ? cr.name : inv.name, uuid: cr ? null : inv.uuid,
        uses: cr ? (cr.uses || []).length : (inv.invited || []).length,
        reward: key, rewardName: key && catalog.customName(key, 'en') ? { en: catalog.customName(key, 'en'), pl: catalog.customName(key, 'pl') } : null,
        card: publicUrl(`/api/card/creator/${code}.png`),
      }, 120);
      return true;
    }
    const card = /^\/api\/card\/(profile|creator)\/([A-Za-z0-9_-]{2,24})\.png$/.exec(url.pathname);
    if (card) {
      const png = await cardImage(card[1], card[2]);
      if (!png) { res.writeHead(404, { 'access-control-allow-origin': '*' }); res.end(); return true; }
      res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=600' });
      res.end(png);
      return true;
    }
    const m = /^\/api\/skin\/([0-9a-f-]{32,36})\.png$/.exec(url.pathname);
    if (m) {
      const u = user(m[1]);
      if (!visible(u)) { res.writeHead(404); res.end(); return true; }
      const s = await skinOf(u.uuid);
      if (!s.png) { res.writeHead(404, { 'access-control-allow-origin': '*' }); res.end(); return true; }
      res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' });
      res.end(s.png);
      return true;
    }
    return false;
  }

  return { http, profile, top };
}

module.exports = { setup };
