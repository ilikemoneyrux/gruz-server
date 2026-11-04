// Katalog kosmetyków Gruz – ten sam w modzie (CosmeticSet.java) i launcherze (cosmetics.js).
// Za darmo jest tylko peleryna "gruz". Resztę odblokowuje kod z panelu admina,
// a kosmetyki sezonowe można odebrać za darmo w czasie wydarzenia.

const CATALOG = {
  cape: ['gruz', 'nebula', 'sakura', 'inferno', 'ocean', 'flow', 'crystals', 'galaxy', 'aurora', 'ember', 'pumpkin', 'winter'],
  head: ['halo', 'crown', 'tophat', 'witch', 'santa'],
  wings: ['angel', 'demon', 'crystal', 'bat'],
  back: ['backpack', 'jetpack'],
  trail: ['shards', 'sparks', 'stars', 'witch', 'souls', 'snow'],
  pet: ['crystal', 'pumpkin'],
  name: ['rainbow', 'neon', 'gold', 'fire', 'frost'],
};
const FREE = ['cape:gruz'];

/** Wydarzenia: od–do (miesiąc-dzień, włącznie) i kosmetyki do odebrania w tym czasie */
const SEASONS = {
  halloween: { from: [10, 15], to: [11, 10], items: ['cape:pumpkin', 'head:witch', 'wings:bat', 'trail:souls', 'pet:pumpkin'] },
  christmas: { from: [12, 1], to: [1, 6], items: ['cape:winter', 'head:santa', 'trail:snow'] },
};

const ALL = Object.entries(CATALOG).flatMap(([slot, list]) => list.map((v) => `${slot}:${v}`));

function exists(key) { const [slot, v] = key.split(':'); return !!CATALOG[slot]?.includes(v); }

/** Czy gracz może założyć daną rzecz */
function allowed(key, unlocked = []) {
  if (key.endsWith(':none')) return true;
  if (!exists(key)) return false;
  return FREE.includes(key) || unlocked.includes(key) || unlocked.includes('all');
}

/** Aktywne wydarzenie w podanym dniu: { id, endsAt, items } albo null */
function activeSeason(now = new Date()) {
  const md = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  for (const [id, s] of Object.entries(SEASONS)) {
    const from = s.from[0] * 100 + s.from[1], to = s.to[0] * 100 + s.to[1];
    const inside = from <= to ? md >= from && md <= to : md >= from || md <= to;
    if (!inside) continue;
    // koniec: północ (UTC) po ostatnim dniu
    let year = now.getUTCFullYear();
    if (from > to && md >= from) year += 1;
    const endsAt = Date.UTC(year, s.to[0] - 1, s.to[1] + 1);
    return { id, endsAt, items: s.items };
  }
  return null;
}

// ---------------- własne peleryny z panelu admina (capes.js) ----------------
// Dopisujemy je do tych samych tablic (bez podmiany), bo inne moduły trzymają do nich referencje.
const BASE_CAPES = [...CATALOG.cape];
const BASE_FREE = [...FREE];
/** id -> { id, pl, en, unlock: 'free' | 'locked' | 'level', level, ver } */
const custom = {};
function setCustom(list) {
  for (const k of Object.keys(custom)) delete custom[k];
  for (const c of list) custom[c.id] = c;
  CATALOG.cape.length = 0;
  CATALOG.cape.push(...BASE_CAPES, ...list.map((c) => c.id));
  FREE.length = 0;
  FREE.push(...BASE_FREE, ...list.filter((c) => c.unlock === 'free').map((c) => `cape:${c.id}`));
  ALL.length = 0;
  ALL.push(...Object.entries(CATALOG).flatMap(([slot, l]) => l.map((v) => `${slot}:${v}`)));
}
/** Nazwa własnej peleryny w danym języku albo null (dla wbudowanych) */
function customName(key, lang = 'en') {
  const [slot, v] = String(key).split(':');
  const c = slot === 'cape' && custom[v];
  return c ? (lang === 'pl' ? c.pl : c.en || c.pl) : null;
}

module.exports = { CATALOG, FREE, SEASONS, ALL, exists, allowed, activeSeason, BASE_CAPES, custom, setCustom, customName };
