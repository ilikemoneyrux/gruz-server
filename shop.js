// Sklep z kosmetykami przez Tebex (Tebex jest sprzedawcą: rozlicza VAT, zwroty i chargebacki).
// Przepływ: launcher -> serwer Gruz tworzy koszyk w Tebex Headless API (nick gracza + jego uuid w "custom")
// -> gracz płaci na stronie Tebexa -> Tebex wysyła webhook payment.completed -> serwer odblokowuje kosmetykę.
// Zwrot / chargeback / przegrany spór -> kosmetyka jest zabierana (jeśli gracz dostał ją z tego zakupu).
//
// Ustawienia: publiczny token sklepu w panelu (zakładka Sklep) albo TEBEX_PUBLIC_TOKEN,
// sekret webhooka TYLKO w zmiennej środowiskowej TEBEX_WEBHOOK_SECRET (Render → Environment).
const crypto = require('crypto');

const API = process.env.TEBEX_API || 'https://headless.tebex.io/api/accounts'; // TEBEX_API tylko do testów
const TEBEX_IPS = ['18.209.80.3', '54.87.231.232'];
const PAYMENT = { COMPLETE: 1, REFUND: 2, CHARGEBACK: 3 };

function setup(ctx) {
  const { db, save, user, sendTo, pushMe, catalog, publicUrl } = ctx;
  db.shop ||= { token: '', items: {} };       // items: packageId -> "cape:c_smok"
  db.purchases ||= [];                         // najnowsze na początku
  const secret = () => process.env.TEBEX_WEBHOOK_SECRET || '';
  const token = () => (process.env.TEBEX_PUBLIC_TOKEN || db.shop.token || '').trim();

  // ---------------- pakiety z Tebexa (pamięć 5 min) ----------------
  let cache = { at: 0, token: '', list: [] };
  async function packages(force = false) {
    const t = token();
    if (!t) return [];
    if (!force && cache.token === t && Date.now() - cache.at < 5 * 60_000) return cache.list;
    const r = await fetch(`${API}/${encodeURIComponent(t)}/packages`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Tebex: ${r.status} (sprawdź publiczny token sklepu)`);
    const j = await r.json();
    const list = (j.data || []).map((p) => ({
      id: String(p.id), name: p.name, price: p.total_price ?? p.base_price, currency: p.currency, image: p.image || null,
      discount: p.discount || 0, category: p.category?.name || '',
    }));
    cache = { at: Date.now(), token: t, list };
    return list;
  }

  /** Lista dla launchera: tylko pakiety przypisane do istniejącej kosmetyki */
  async function publicList() {
    let list = [];
    try { list = await packages(); } catch { list = cache.list; }
    return list.filter((p) => db.shop.items[p.id] && catalog.exists(db.shop.items[p.id]))
      .map((p) => ({ packageId: p.id, cosmetic: db.shop.items[p.id], name: p.name, price: p.price, currency: p.currency, image: p.image }));
  }

  // ---------------- zakup (wiadomość z launchera) ----------------
  async function buy(c, packageId) {
    const t = token();
    if (!t) throw new Error('SHOP_OFF');
    const u = user(c.uuid);
    const cosmetic = db.shop.items[String(packageId)];
    if (!u || !cosmetic || !catalog.exists(cosmetic)) throw new Error('SHOP_UNKNOWN');
    if ((u.unlocked || []).includes(cosmetic) || (u.unlocked || []).includes('all')) throw new Error('SHOP_OWNED');
    const done = publicUrl('/shop/done');
    const basketRes = await fetch(`${API}/${encodeURIComponent(t)}/baskets`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ username: u.name, ip_address: c.ip || undefined, complete_url: done, cancel_url: done + '?cancel=1', complete_auto_redirect: true, custom: { uuid: u.uuid } }),
    });
    const basket = await basketRes.json().catch(() => ({}));
    if (!basketRes.ok || !basket.data?.ident) throw new Error('SHOP_TEBEX:' + (basket.detail || basket.message || basketRes.status));
    const ident = basket.data.ident;
    const addRes = await fetch(`${API}/${encodeURIComponent(t)}/baskets/${encodeURIComponent(ident)}/packages`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ package_id: String(packageId), quantity: 1, custom: { uuid: u.uuid, cosmetic } }),
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
    const uuid = product.custom?.uuid;
    if (uuid && user(uuid)) return user(uuid);
    const name = String(product.username?.username || subject.customer?.username?.username || '').toLowerCase();
    return name ? Object.values(db.users).find((x) => x.name.toLowerCase() === name) : null;
  }

  function grant(subject) {
    for (const p of subject.products || []) {
      const cosmetic = (p.custom?.cosmetic && catalog.exists(p.custom.cosmetic) && p.custom.cosmetic) || db.shop.items[String(p.id)];
      const u = findUser(p, subject);
      const rec = { tx: subject.transaction_id, at: Date.now(), packageId: String(p.id), name: p.name, cosmetic: cosmetic || null,
        uuid: u?.uuid || null, player: u?.name || p.username?.username || '', amount: p.paid_price?.amount ?? subject.price_paid?.amount,
        currency: p.paid_price?.currency || subject.price_paid?.currency, status: 'paid', granted: false };
      if (db.purchases.some((x) => x.tx === rec.tx && x.packageId === rec.packageId)) continue; // Tebex może wysłać ponownie
      if (u && cosmetic) {
        u.unlocked ||= [];
        if (!u.unlocked.includes(cosmetic)) { u.unlocked.push(cosmetic); rec.granted = true; }
        sendTo(u.uuid, { t: 'unlocked', cosmetic, unlocked: u.unlocked, purchase: true });
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

  async function http(req, res, url) {
    if (url.pathname === '/tebex/webhook' && req.method === 'POST') { await webhook(req, res); return true; }
    if (url.pathname === '/shop/done') { donePage(res, url); return true; }
    if (url.pathname === '/shop.json') {
      const items = await publicList();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'max-age=60' });
      res.end(JSON.stringify({ enabled: !!token() && items.length > 0, items }));
      return true;
    }
    return false;
  }

  // ---------------- panel admina ----------------
  async function adminGet() {
    let list = [], error = null;
    try { list = await packages(true); } catch (e) { error = e.message; }
    const paid = db.purchases.filter((p) => p.status === 'paid');
    const revenue = {};
    for (const p of paid) if (p.amount) revenue[p.currency || '?'] = Math.round(((revenue[p.currency || '?'] || 0) + Number(p.amount)) * 100) / 100;
    return {
      token: db.shop.token || '', tokenFromEnv: !!process.env.TEBEX_PUBLIC_TOKEN, secretSet: !!secret(),
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

  return { http, buy, publicList, adminGet, adminSave, adminAssign, verify, grant, revoke, packages };
}

module.exports = { setup };
