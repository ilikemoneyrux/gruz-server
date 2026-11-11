// Monety Gruz, sklep rotacyjny i Gruz+ (od serwera 1.11.0).
//
// Monety: tylko za granie – zadania dzienne, nagroda dnia, czas w grze (liczy serwer) i nowe poziomy.
// Nie da się ich kupić za pieniądze.
//
// Sklep rotacyjny: co tydzień (poniedziałek, strefa serwera) kilka kosmetyków do kupienia za monety.
// Wybór jest losowy, ale stały w danym tygodniu. Domyślnie bez skrzydeł, rzeczy sezonowych i darmowych.
// Ustawienia bez panelu: db.promo.coins = { off, count, pool: ['cape:nebula', …], prices: { cape: 900, 'cape:flow': 1500 } }.
//
// Gruz+: kod "plus:30" / "plus:90" / "plus:365" (dni; kolejne kody się sumują). W czasie Gruz+ gracz:
// nosi wszystko z bieżącej rotacji, ma Gruz Pass Premium, odznakę Gruz+ i 50% więcej monet.
const crypto = require('crypto');

const DEFAULT_PRICES = { name: 300, trail: 400, head: 500, back: 600, pet: 700, cape: 900 };
const ANIMATED_CAPES = ['cape:flow', 'cape:crystals', 'cape:galaxy', 'cape:aurora', 'cape:ember'];
const DAILY_COINS = [10, 10, 15, 15, 20, 20, 50]; // nagroda dnia: dzień 1–7
const PLAY_EVERY = 10, PLAY_COINS = 2, PLAY_CAP = 60; // co 10 minut gry 2 monety, najwyżej 60 dziennie
const LEVEL_COINS = 25;
const PLUS_DAYS = [30, 90, 365];
const PLUS_BONUS = 1.5;

function setup(ctx) {
  const { db, save, catalog, dayKey, weekKey } = ctx;
  const cfg = () => (db.promo?.coins && typeof db.promo.coins === 'object' ? db.promo.coins : {});

  // ---------------- Gruz+ ----------------
  const plusActive = (u) => !!u && (u.plus?.until || 0) > Date.now();
  const plusView = (u) => (plusActive(u) ? { active: true, until: u.plus.until } : { active: false, until: u.plus?.until || null });
  const isPlusCode = (key) => PLUS_DAYS.some((d) => key === 'plus:' + d);
  /** Kod Gruz+: dopisuje dni do końca obecnego okresu (albo od teraz) */
  function redeemPlus(u, key) {
    const days = Number(String(key).split(':')[1]);
    if (!PLUS_DAYS.includes(days)) return { error: 'CODE_INVALID' };
    u.plus = { until: Math.max(Date.now(), u.plus?.until || 0) + days * 864e5, since: plusActive(u) ? u.plus.since || Date.now() : Date.now() };
    save();
    return { ok: true, days, plus: plusView(u) };
  }

  // ---------------- monety ----------------
  /** Dopisuje monety (z premią Gruz+). Zwraca, ile gracz dostał. */
  function earn(u, amount) {
    let n = Math.max(0, Math.round(Number(amount) || 0));
    if (!n || cfg().off) return 0;
    if (plusActive(u)) n = Math.round(n * PLUS_BONUS);
    u.coins = (u.coins || 0) + n;
    u.coinsTotal = (u.coinsTotal || 0) + n;
    save();
    return n;
  }
  const forQuest = (xp) => Math.max(5, Math.round((Number(xp) || 0) / 2));
  const forDaily = (day) => DAILY_COINS[(day - 1) % 7] || 10;
  /** Wołane co minutę gry z modem Gruz: co 10 minut 2 monety, z dziennym limitem. Zwraca przyznane monety. */
  function playMinute(u) {
    const day = dayKey();
    if (!u.coinDay || u.coinDay.day !== day) u.coinDay = { day, min: 0, got: 0 };
    const d = u.coinDay;
    d.min++;
    if (d.min % PLAY_EVERY || d.got >= PLAY_CAP) return 0;
    d.got += PLAY_COINS;
    return earn(u, PLAY_COINS);
  }

  // ---------------- sklep rotacyjny ----------------
  function pool() {
    if (Array.isArray(cfg().pool) && cfg().pool.length) return cfg().pool.filter((k) => catalog.exists(k) && !catalog.FREE.includes(k));
    const seasonal = new Set(Object.values(catalog.SEASONS).flatMap((s) => s.items));
    return catalog.ALL.filter((k) => {
      const [slot, v] = k.split(':');
      if (catalog.FREE.includes(k) || seasonal.has(k) || slot === 'wings') return false;
      const own = slot === 'cape' && catalog.custom[v];
      return !own || own.unlock === 'locked'; // własne peleryny „od poziomu” zostają nagrodą za poziom
    });
  }
  function price(key) {
    const p = cfg().prices || {};
    const slot = key.split(':')[0];
    return Math.max(1, Math.round(Number(p[key]) || Number(p[slot]) || (ANIMATED_CAPES.includes(key) ? 1300 : DEFAULT_PRICES[slot] || 900)));
  }
  let cache = null;
  /** Kosmetyki z tego tygodnia: losowe, ale stałe; najwyżej 2 z jednej kategorii */
  function rotation() {
    const week = weekKey();
    const list = pool();
    const sig = week + '|' + list.length + '|' + (cfg().count || 4);
    if (cache && cache.sig === sig) return cache.items;
    const h = (s) => crypto.createHash('sha1').update(s).digest().readUInt32BE(0);
    const order = list.slice().sort((a, b) => h(week + a) - h(week + b) || a.localeCompare(b));
    const count = Math.max(1, Math.min(8, Number(cfg().count) || 4));
    const items = [];
    for (const k of order) {
      if (items.length >= count) break;
      if (items.filter((x) => x.split(':')[0] === k.split(':')[0]).length < 2) items.push(k);
    }
    cache = { sig, items };
    return items;
  }
  /** Początek następnego tygodnia w strefie serwera (wtedy zmienia się rotacja) */
  function nextWeekAt() {
    const wk = weekKey();
    let t = Math.ceil(Date.now() / 3600_000) * 3600_000;
    while (weekKey(t) === wk) t += 3600_000;
    while (weekKey(t - 60_000) !== wk) t -= 60_000;
    return t;
  }
  function shopView(u) {
    const own = u.unlocked || [];
    const all = own.includes('all');
    return {
      enabled: !cfg().off, week: weekKey(), resetsAt: nextWeekAt(), coins: u.coins || 0,
      items: cfg().off ? [] : rotation().map((k) => ({ cosmetic: k, price: price(k), owned: all || own.includes(k) })),
    };
  }
  /** Kupno za monety: tylko rzecz z bieżącej rotacji, której gracz jeszcze nie ma */
  function buy(u, key) {
    if (cfg().off) return { error: 'COINS_OFF' };
    if (!rotation().includes(key)) return { error: 'COINS_NOT_IN_SHOP' };
    u.unlocked ||= [];
    if (u.unlocked.includes(key) || u.unlocked.includes('all')) return { error: 'COINS_OWNED' };
    const cost = price(key);
    if ((u.coins || 0) < cost) return { error: 'COINS_NOT_ENOUGH', price: cost, coins: u.coins || 0 };
    u.coins -= cost;
    u.unlocked.push(key);
    save();
    return { ok: true, cosmetic: key, price: cost, coins: u.coins };
  }

  /** To, co gracz może założyć: swoje + (w czasie Gruz+) wszystko z bieżącej rotacji */
  function effective(u) {
    const own = u.unlocked || [];
    if (!plusActive(u) || cfg().off) return own;
    return [...own, ...rotation().filter((k) => !own.includes(k))];
  }

  return { plusActive, plusView, isPlusCode, redeemPlus, earn, forQuest, forDaily, playMinute, rotation, price, shopView, buy, effective };
}

module.exports = { setup, PLUS_DAYS, DAILY_COINS, LEVEL_COINS };
