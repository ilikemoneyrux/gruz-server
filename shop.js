// Sklep z kosmetykami przez Tebex (Tebex jest sprzedawcą: rozlicza VAT, zwroty i chargebacki).
// Przepływ: launcher -> serwer Gruz tworzy koszyk w Tebex Headless API (nick gracza + jego uuid w "custom")
// -> gracz płaci na stronie Tebexa -> Tebex wysyła webhook payment.completed -> serwer odblokowuje kosmetykę.
// Zwrot / chargeback / przegrany spór -> kosmetyka jest zabierana (jeśli gracz dostał ją z tego zakupu).
//
// Ustawienia: publiczny token sklepu w panelu (zakładka Sklep) albo TEBEX_PUBLIC_TOKEN,
// sekret webhooka TYLKO w zmiennej środowiskowej TEBEX_WEBHOOK_SECRET (Render → Environment).
// Strona gruzclient.com/shop: gracz wpisuje nick (musi choć raz zagrać przez launcher), serwer tworzy koszyk tak samo jak dla launchera.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API = process.env.TEBEX_API || 'https://headless.tebex.io/api/accounts'; // TEBEX_API tylko do testów
const TEBEX_IPS = ['18.209.80.3', '54.87.231.232'];
const PAYMENT = { COMPLETE: 1, REFUND: 2, CHARGEBACK: 3 };
// strona sklepu (powrót z Tebexa) i adresy, z których strona może wołać API sklepu
const SITE_SHOP = (process.env.SHOP_SITE_URL || 'https://gruzclient.com/shop').replace(/\/+$/, '');
const SITE_ORIGINS = ['https://gruzclient.com', 'https://www.gruzclient.com', ...String(process.env.SHOP_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)];
const allowedOrigin = (o) => !!o && (SITE_ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+\.gruz-website\.pages\.dev$/.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));
const NICK_RE = /^[A-Za-z0-9_]{2,16}$/;

function setup(ctx) {
  const { db, save, user, sendTo, pushMe, catalog, publicUrl, byName } = ctx;
  db.shop ||= { token: '', items: {} };       // items: packageId -> "cape:c_smok"
  db.purchases ||= [];                         // najnowsze na początku
  const secret = () => process.env.TEBEX_WEBHOOK_SECRET || '';
  const token = () => (process.env.TEBEX_PUBLIC_TOKEN || db.shop.token || '').trim();

  // ---------------- dane sklepu (typ, czy włączony) – pamięć 10 min ----------------
  // Sklep "Universal (No Auth)" odrzuca nick w koszyku ("You can't set the username for this game type"),
  // dlatego nick wysyłamy tylko, gdy sklep obsługuje nicki. Gracza i tak rozpoznajemy po uuid w "custom".
  let store = { at: 0, token: '', info: null };
  async function storeInfo() {
    const t = token();
    if (!t) return null;
    if (store.token === t && store.info && Date.now() - store.at < 10 * 60_000) return store.info;
    const r = await fetch(`${API}/${encodeURIComponent(t)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const d = (await r.json().catch(() => ({}))).data;
    if (!r.ok || !d) return store.info;
    store = { at: Date.now(), token: t, info: { name: d.name, type: d.platform_type, disabled: !!d.disabled, usernames: !!d.supports_usernames, currency: d.currency } };
    return store.info;
  }

  // ---------------- prosty limit zapytań z jednego IP ----------------
  const hits = new Map(); // "ip|rodzaj" -> [czasy]
  function tooMany(ip, kind, max, perMs) {
    const k = ip + '|' + kind, t0 = Date.now();
    const list = (hits.get(k) || []).filter((t) => t0 - t < perMs);
    list.push(t0);
    hits.set(k, list);
    if (hits.size > 5000) for (const [key, l] of hits) if (!l.length || t0 - l[l.length - 1] > 3600_000) hits.delete(key);
    return list.length > max;
  }

  // ---------------- pakiety z Tebexa (pamięć 5 min) ----------------
  let cache = { at: 0, token: '', list: [] };
  async function packages(force = false) {
    const t = token();
    if (!t) return [];
    if (!force && cache.token === t && Date.now() - cache.at < 5 * 60_000) return cache.list;
    const r = await fetch(`${API}/${encodeURIComponent(t)}/packages`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Tebex zwraca opis błędu (RFC 9457: title / detail) – pokazujemy go w panelu
      const why = [j.title, j.detail, j.message, j.error].filter((x) => typeof x === 'string' && x).join(' – ');
      throw new Error(`Tebex ${r.status}: ${why || 'bez opisu'}`);
    }
    const list = (j.data || []).map((p) => ({
      id: String(p.id), name: p.name, price: p.total_price ?? p.base_price, currency: p.currency, image: p.image || null,
      discount: p.discount || 0, category: p.category?.name || '',
    }));
    cache = { at: Date.now(), token: t, list };
    return list;
  }

  /** Podgląd kosmetyki: tekstura peleryny (własna z panelu albo wbudowana z assets/capes) albo null */
  const BUILTIN_CAPES = new Set(fs.existsSync(path.join(__dirname, 'assets/capes'))
    ? fs.readdirSync(path.join(__dirname, 'assets/capes')).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)) : []);
  function preview(cosmetic) {
    const [slot, v] = cosmetic.split(':');
    if (slot !== 'cape') return null;
    if (catalog.custom[v]) return publicUrl(`/capes/${v}.png?v=${catalog.custom[v].ver || 1}`);
    return BUILTIN_CAPES.has(v) ? publicUrl(`/shop/cape/${v}.png`) : null;
  }

  /** Lista dla launchera i strony: tylko pakiety przypisane do istniejącej kosmetyki */
  async function publicList() {
    let list = [];
    try { list = await packages(); } catch { list = cache.list; }
    return list.filter((p) => db.shop.items[p.id] && catalog.exists(db.shop.items[p.id]))
      .map((p) => {
        const cosmetic = db.shop.items[p.id];
        const label = catalog.customName(cosmetic, 'en') ? { en: catalog.customName(cosmetic, 'en'), pl: catalog.customName(cosmetic, 'pl') } : null;
        return { packageId: p.id, cosmetic, slot: cosmetic.split(':')[0], name: p.name, label, price: p.price, currency: p.currency, image: p.image, preview: preview(cosmetic), discount: p.discount || 0 };
      });
  }

  // ---------------- zakup (z launchera albo ze strony) ----------------
  // c: { uuid, ip }; returnUrl: dokąd Tebex wraca po płatności (launcher: /shop/done na serwerze, strona: gruzclient.com/shop)
  // from: gracz, który kupuje w prezencie (null = dla siebie) – odbiorca dostaje powiadomienie "X podarował Ci…"
  async function buy(c, packageId, returnUrl, from = null) {
    const t = token();
    if (!t) throw new Error('SHOP_OFF');
    const u = user(c.uuid);
    const cosmetic = db.shop.items[String(packageId)];
    if (!u || !cosmetic || !catalog.exists(cosmetic)) throw new Error('SHOP_UNKNOWN');
    if ((u.unlocked || []).includes(cosmetic) || (u.unlocked || []).includes('all')) throw new Error('SHOP_OWNED');
    const info = await storeInfo().catch(() => null);
    if (info?.disabled) console.warn('[shop] sklep Tebex jest wyłączony (disabled) – płatność może nie przejść');
    const done = returnUrl || publicUrl('/shop/done');
    const back = (q) => done + (done.includes('?') ? '&' : '?') + q;
    const basketRes = await fetch(`${API}/${encodeURIComponent(t)}/baskets`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ ...(info?.usernames ? { username: u.name } : {}), ip_address: c.ip || undefined, complete_url: back('done=1'), cancel_url: back('cancel=1'),
        complete_auto_redirect: true, custom: { uuid: u.uuid, cosmetic, ...(from ? { from: from.uuid, fromName: from.name } : {}) } }),
    });
    const basket = await basketRes.json().catch(() => ({}));
    if (!basketRes.ok || !basket.data?.ident) throw new Error('SHOP_TEBEX:' + (basket.detail || basket.message || basketRes.status));
    const ident = basket.data.ident;
    // dodawanie do koszyka: /api/baskets/<ident>/packages (bez /accounts/<token> – tamten adres daje 404)
    const addRes = await fetch(`https://headless.tebex.io/api/baskets/${encodeURIComponent(ident)}/packages`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ package_id: String(packageId), quantity: 1, custom: { uuid: u.uuid, cosmetic, ...(from ? { from: from.uuid, fromName: from.name } : {}) } }),
    });
    const added = await addRes.json().catch(() => ({}));
    if (!addRes.ok) throw new Error('SHOP_TEBEX:' + (added.detail || added.message || addRes.status));
    let url = added.data?.links?.checkout || basket.data?.links?.checkout;
    // niektóre sklepy wymagają zalogowania w koszyku przed płatnością – wtedy najpierw link logowania
    if (!url) {
      const auth = await fetch(`${API}/${encodeURIComponent(t)}/baskets/${encodeURIComponent(ident)}/auth?returnUrl=${encodeURIComponent(done)}`, { signal: AbortSignal.timeout(15000) })
        .then((r) => r.json()).catch(() => null);
      url = Array.isArray(auth) ? auth[0]?.url : auth?.data?.[0]?.url;
    }
    if (!url || !/^https:\/\//.test(url)) throw new Error('SHOP_TEBEX:no checkout link');
    return { url, basket: ident };
  }

  // ---------------- webhook z Tebexa ----------------
  function verify(raw, sig) {
    const s = secret();
    if (!s || !sig) return false;
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const want = crypto.createHmac('sha256', s).update(hash).digest('hex');
    const a = Buffer.from(want), b = Buffer.from(String(sig));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function findUser(product, subject) {
    const uuid = product.custom?.uuid || subject.custom?.uuid; // pakiet albo cały koszyk
    if (uuid && user(uuid)) return user(uuid);
    const name = String(product.username?.username || subject.customer?.username?.username || '').toLowerCase();
    return name ? Object.values(db.users).find((x) => x.name.toLowerCase() === name) : null;
  }

  function grant(subject) {
    for (const p of subject.products || []) {
      const cosmetic = (p.custom?.cosmetic && catalog.exists(p.custom.cosmetic) && p.custom.cosmetic) || db.shop.items[String(p.id)];
      const u = findUser(p, subject);
      const rec = { tx: subject.transaction_id, at: Date.now(), packageId: String(p.id), name: p.name, cosmetic: cosmetic || null,
        uuid: u?.uuid || null, player: u?.name || p.username?.username || '', gift: p.custom?.fromName || subject.custom?.fromName || null, amount: p.paid_price?.amount ?? subject.price_paid?.amount,
        currency: p.paid_price?.currency || subject.price_paid?.currency, status: 'paid', granted: false };
      if (db.purchases.some((x) => x.tx === rec.tx && x.packageId === rec.packageId)) continue; // Tebex może wysłać ponownie
      if (u && cosmetic) {
        u.unlocked ||= [];
        if (!u.unlocked.includes(cosmetic)) { u.unlocked.push(cosmetic); rec.granted = true; }
        sendTo(u.uuid, { t: 'unlocked', cosmetic, unlocked: u.unlocked, purchase: true, ...(rec.gift ? { gift: rec.gift } : {}) });
        pushMe(u.uuid);
      } else rec.status = u ? 'no-cosmetic' : 'no-player';
      db.purchases.unshift(rec);
    }
    db.purchases = db.purchases.slice(0, 2000);
    save();
  }

  function revoke(subject, why) {
    for (const rec of db.purchases.filter((x) => x.tx === subject.transaction_id)) {
      if (rec.status === why) continue;
      rec.status = why;
      const u = rec.uuid && user(rec.uuid);
      if (u && rec.granted && rec.cosmetic) {
        u.unlocked = (u.unlocked || []).filter((k) => k !== rec.cosmetic);
        const [slot, v] = rec.cosmetic.split(':');
        if (new RegExp(`(^|;)${slot}=${v}(;|$)`).test(u.cosmetics || '')) u.cosmetics = u.cosmetics.replace(new RegExp(`(^|;)${slot}=${v}(?=;|$)`), `$1${slot}=none`);
        rec.granted = false;
        pushMe(u.uuid);
      }
    }
    save();
  }

  async function webhook(req, res) {
    const chunks = [];
    let size = 0;
    for await (const ch of req) { size += ch.length; if (size > 512 * 1024) { res.writeHead(413); return res.end(); } chunks.push(ch); }
    const raw = Buffer.concat(chunks);
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, '');
    if (!verify(raw, req.headers['x-signature'])) {
      console.warn('[tebex] zły podpis webhooka z', ip);
      res.writeHead(401); return res.end();
    }
    if (process.env.TEBEX_CHECK_IP !== '0' && !TEBEX_IPS.includes(ip)) console.warn('[tebex] webhook z nieznanego IP', ip, '(podpis OK)');
    let m;
    try { m = JSON.parse(raw.toString('utf8')); } catch { res.writeHead(400); return res.end(); }
    if (m.type === 'validation.webhook') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: m.id }));
    }
    const s = m.subject || {};
    const st = s.status?.id;
    if (m.type === 'payment.completed' && (st === undefined || st === PAYMENT.COMPLETE)) grant(s);
    else if (m.type === 'payment.refunded' || st === PAYMENT.REFUND) revoke(s, 'refund');
    else if (m.type === 'payment.dispute.lost' || st === PAYMENT.CHARGEBACK) revoke(s, 'chargeback');
    console.log('[tebex]', m.type, s.transaction_id || '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }

  /** Strona po płatności (Tebex wraca tutaj) */
  function donePage(res, url) {
    const cancel = url.searchParams.has('cancel');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gruz Client</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07050c;color:#f1ecf8;font:16px/1.6 system-ui,sans-serif;text-align:center}
.c{max-width:440px;padding:32px;border:1px solid #2b2139;background:#0c0912}h1{color:#dcaaff;margin:0 0 8px}p{color:#9a8fae;margin:6px 0}</style></head>
<body><div class="c">${cancel
  ? '<h1>Payment cancelled</h1><p>Nothing was charged. You can close this tab.</p><p>Płatność anulowana – nic nie zostało pobrane.</p>'
  : '<h1>Thank you! 💜</h1><p>Your item will appear in the launcher within a minute – go back to Gruz Client.</p><p>Dziękujemy! Kosmetyka pojawi się w launcherze w ciągu minuty – wróć do Gruz Client.</p>'}</div></body></html>`);
  }

  // ---------------- API dla strony gruzclient.com/shop ----------------
  const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, '');
  function cors(req) {
    const o = req.headers.origin;
    return allowedOrigin(o) ? { 'access-control-allow-origin': o, vary: 'Origin', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' } : { vary: 'Origin' };
  }
  function send(req, res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors(req) });
    res.end(JSON.stringify(body));
  }
  async function readJson(req) {
    let raw = '';
    for await (const ch of req) { raw += ch; if (raw.length > 4096) throw new Error('TOO_BIG'); }
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  /** Gracz po nicku: nick, uuid i które kosmetyki ze sklepu już ma */
  function playerView(u) {
    const unlocked = u.unlocked || [];
    const all = unlocked.includes('all');
    const owned = Object.values(db.shop.items).filter((k) => all || unlocked.includes(k) || catalog.FREE.includes(k));
    return { name: u.name, uuid: u.uuid, owned: [...new Set(owned)] };
  }

  async function siteApi(req, res, url) {
    const ip = ipOf(req);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors(req)); res.end(); return; }
    if (url.pathname === '/shop/player' && req.method === 'GET') {
      if (tooMany(ip, 'player', 30, 60_000)) return send(req, res, 429, { error: 'SHOP_SLOW' });
      const nick = String(url.searchParams.get('name') || '').trim();
      if (!NICK_RE.test(nick)) return send(req, res, 400, { error: 'SHOP_NICK' });
      const u = byName(nick);
      if (!u) return send(req, res, 404, { error: 'SHOP_NO_PLAYER' });
      return send(req, res, 200, playerView(u));
    }
    if (url.pathname === '/shop/checkout' && req.method === 'POST') {
      if (!allowedOrigin(req.headers.origin)) return send(req, res, 403, { error: 'SHOP_ORIGIN' });
      if (tooMany(ip, 'checkout', 8, 10 * 60_000)) return send(req, res, 429, { error: 'SHOP_SLOW' });
      let b;
      try { b = await readJson(req); } catch { return send(req, res, 413, { error: 'SHOP_UNKNOWN' }); }
      const nick = String(b.name || '').trim();
      if (!NICK_RE.test(nick)) return send(req, res, 400, { error: 'SHOP_NICK' });
      const u = byName(nick);
      if (!u) return send(req, res, 404, { error: 'SHOP_NO_PLAYER' });
      try {
        const r = await buy({ uuid: u.uuid, ip }, String(b.packageId || ''), SITE_SHOP);
        console.log('[shop] koszyk ze strony dla', u.name, 'pakiet', b.packageId);
        return send(req, res, 200, { url: r.url });
      } catch (e) {
        console.warn('[shop] strona:', e.message);
        const code = String(e.message).startsWith('SHOP_') ? String(e.message).split(':')[0] : 'SHOP_TEBEX';
        return send(req, res, code === 'SHOP_OWNED' ? 409 : code === 'SHOP_UNKNOWN' ? 404 : code === 'SHOP_OFF' ? 503 : 502, { error: code });
      }
    }
    return send(req, res, 404, { error: 'NOT_FOUND' });
  }

  /** Wbudowane tekstury peleryn do podglądu na stronie */
  function capeTexture(res, v) {
    if (!BUILTIN_CAPES.has(v)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=86400' });
    fs.createReadStream(path.join(__dirname, 'assets/capes', v + '.png')).pipe(res);
  }

  async function http(req, res, url) {
    if (url.pathname === '/tebex/webhook' && req.method === 'POST') { await webhook(req, res); return true; }
    if (url.pathname === '/shop/done') { donePage(res, url); return true; }
    if (url.pathname === '/shop.json') {
      const items = await publicList();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'max-age=60' });
      res.end(JSON.stringify({ enabled: !!token() && items.length > 0, items }));
      return true;
    }
    if (url.pathname === '/shop/player' || url.pathname === '/shop/checkout') { await siteApi(req, res, url); return true; }
    const cape = /^\/shop\/cape\/([a-z0-9_]{1,40})\.png$/.exec(url.pathname);
    if (cape) { capeTexture(res, cape[1]); return true; }
    return false;
  }

  // ---------------- panel admina ----------------
  async function adminGet() {
    let list = [], error = null;
    try { list = await packages(true); } catch (e) { error = e.message; }
    store.at = 0;
    const info = await storeInfo().catch(() => null);
    const paid = db.purchases.filter((p) => p.status === 'paid');
    const revenue = {};
    for (const p of paid) if (p.amount) revenue[p.currency || '?'] = Math.round(((revenue[p.currency || '?'] || 0) + Number(p.amount)) * 100) / 100;
    return {
      token: db.shop.token || '', tokenFromEnv: !!process.env.TEBEX_PUBLIC_TOKEN, secretSet: !!secret(), store: info, siteUrl: SITE_SHOP,
      webhookUrl: publicUrl('/tebex/webhook'), packages: list.map((p) => ({ ...p, cosmetic: db.shop.items[p.id] || '' })), error,
      cosmetics: ctx.LOCKED.filter((k) => k !== 'all'), purchases: db.purchases.slice(0, 100), count: paid.length, revenue,
    };
  }
  function adminSave(b) {
    if (typeof b.token === 'string') { db.shop.token = b.token.trim().slice(0, 80); cache.at = 0; }
    if (b.items && typeof b.items === 'object') {
      const items = {};
      for (const [id, cos] of Object.entries(b.items)) if (/^\d{1,12}$/.test(id) && cos && catalog.exists(String(cos))) items[id] = String(cos);
      db.shop.items = items;
    }
    save();
    return { ok: true };
  }
  /** Ręczne nadanie zakupu (np. gdy gracz podał zły nick) */
  function adminAssign(tx, nick) {
    const u = Object.values(db.users).find((x) => x.name.toLowerCase() === String(nick || '').trim().toLowerCase());
    if (!u) throw new Error('Nie ma takiego gracza.');
    const recs = db.purchases.filter((x) => x.tx === tx && x.cosmetic);
    if (!recs.length) throw new Error('Nie ma takiego zakupu.');
    for (const rec of recs) {
      if (!u.unlocked.includes(rec.cosmetic)) { u.unlocked.push(rec.cosmetic); rec.granted = true; }
      rec.uuid = u.uuid; rec.player = u.name; rec.status = 'paid';
      sendTo(u.uuid, { t: 'unlocked', cosmetic: rec.cosmetic, unlocked: u.unlocked, purchase: true });
    }
    pushMe(u.uuid);
    save();
    return { ok: true };
  }

  return { http, buy, publicList, storeInfo, adminGet, adminSave, adminAssign, verify, grant, revoke, packages };
}

module.exports = { setup };
