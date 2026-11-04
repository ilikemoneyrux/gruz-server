// Własne peleryny dodawane w panelu admina – bez nowej wersji launchera i moda.
// Obrazek PNG (64x32 albo większy w tej samej proporcji, np. 1024x512) trzymamy w bazie,
// launcher i mod pobierają listę z /capes.json, a obrazki z /capes/<id>.png.
// Sposób odblokowania: "free" (każdy), "locked" (kod, giveaway, nagroda za zaproszenia/serię/ranking) albo "level" (od poziomu N).
const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const catalog = require('./catalog');

const MAX_BYTES = 2 * 1024 * 1024;
const ID_RE = /^c_[a-z0-9_]{1,32}$/;
const images = new Map(); // id -> Buffer (pamięć podręczna)

/** Szerokość i wysokość z nagłówka PNG albo null */
function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** "Smocza peleryna!" -> "c_smocza_peleryna" */
function slug(name) {
  const base = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  return 'c_' + (base || Date.now().toString(36));
}

function setup(ctx) {
  const { db, save, levelOf, LOCKED, pushMe, sendAll } = ctx;
  db.capes ||= {};

  const list = () => Object.values(db.capes).sort((a, b) => (a.order ?? a.created) - (b.order ?? b.created));

  /** Przelicza katalog i listę rzeczy na kody po każdej zmianie */
  function apply() {
    catalog.setCustom(list());
    LOCKED.length = 0;
    LOCKED.push(...catalog.ALL.filter((k) => !catalog.FREE.includes(k)), 'all');
  }

  /** Peleryny "od poziomu N" trafiają do odblokowanych, gdy gracz ma ten poziom */
  function grantLevel(u, lv = levelOf(u).level) {
    let got = null;
    for (const c of list()) {
      const key = `cape:${c.id}`;
      if (c.unlock === 'level' && lv >= (c.level || 1) && !u.unlocked.includes(key)) { u.unlocked.push(key); got = key; }
    }
    if (got) { save(); ctx.sendTo(u.uuid, { t: 'unlocked', cosmetic: got, unlocked: u.unlocked, level: true }); }
    return got;
  }

  const publicView = (c) => ({ id: c.id, name: { pl: c.pl, en: c.en || c.pl }, url: `/capes/${c.id}.png?v=${c.ver}`, ver: c.ver, unlock: c.unlock, level: c.level || 0 });

  /** Zmiana listy: przeliczenie katalogu i powiadomienie launcherów i gier, żeby pobrały nową listę */
  function changed() {
    apply();
    save();
    sendAll({ t: 'capes', capes: list().map(publicView) });
  }

  // ---------------- HTTP (publiczne) ----------------
  async function http(req, res, url) {
    if (url.pathname === '/capes.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'max-age=60' });
      res.end(JSON.stringify(list().map(publicView)));
      return true;
    }
    const m = /^\/capes\/([a-z0-9_]{1,40})\.png$/.exec(url.pathname);
    if (!m) return false;
    const id = m[1];
    let buf = null;
    if (db.capes[id]) {
      buf = images.get(id) || await storage.getBlob('capes', id);
      if (buf) images.set(id, buf);
    } else if (catalog.BASE_CAPES.includes(id)) {
      // wbudowane peleryny HD (te same pliki co w launcherze i modzie)
      try { buf = fs.readFileSync(path.join(__dirname, 'assets', 'capes', id + '.png')); } catch { buf = null; }
    }
    if (!buf) { res.writeHead(404, { 'access-control-allow-origin': '*' }); res.end(); return true; }
    res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=31536000, immutable' });
    res.end(buf);
    return true;
  }

  // ---------------- panel admina ----------------
  async function adminList() {
    const owners = {};
    for (const u of Object.values(db.users)) for (const k of u.unlocked || []) owners[k] = (owners[k] || 0) + 1;
    const wearing = {};
    for (const u of Object.values(db.users)) {
      const cape = /(?:^|;)cape=([a-z0-9_]+)/.exec(u.cosmetics || '')?.[1];
      if (cape) wearing[cape] = (wearing[cape] || 0) + 1;
    }
    return list().map((c) => ({ ...publicView(c), pl: c.pl, en: c.en, created: c.created, owners: owners[`cape:${c.id}`] || 0, wearing: wearing[c.id] || 0 }));
  }

  /** Nowa albo zmieniona peleryna. body: { id?, pl, en, unlock, level, image? (data:image/png;base64,…) } */
  async function adminSave(body) {
    const str = (v, n) => String(v ?? '').trim().slice(0, n);
    const pl = str(body.pl, 40), en = str(body.en, 40) || pl;
    if (!pl) throw new Error('Podaj nazwę peleryny.');
    const unlock = ['free', 'locked', 'level'].includes(body.unlock) ? body.unlock : 'locked';
    const level = unlock === 'level' ? Math.max(2, Math.min(200, Number(body.level) || 5)) : 0;
    const editing = body.id && db.capes[body.id];
    let buf = null;
    if (body.image) {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image));
      if (!m) throw new Error('Obrazek musi być plikiem PNG.');
      buf = Buffer.from(m[1], 'base64');
      if (buf.length > MAX_BYTES) throw new Error('Obrazek jest za duży (max 2 MB).');
      const size = pngSize(buf);
      if (!size) throw new Error('To nie jest poprawny plik PNG.');
      if (size.w !== size.h * 2 || size.w < 64 || size.w > 2048 || (size.w & (size.w - 1)) !== 0) {
        throw new Error(`Zły rozmiar: ${size.w}x${size.h}. Peleryna musi mieć proporcje 2:1, np. 64x32, 512x256 albo 1024x512.`);
      }
    } else if (!editing) throw new Error('Dodaj obrazek peleryny (PNG).');

    let id = editing ? body.id : slug(en || pl);
    if (!editing) {
      while (db.capes[id] || catalog.BASE_CAPES.includes(id)) id = slug(en || pl).slice(0, 30) + '_' + Math.floor(Math.random() * 90 + 10);
    }
    if (!ID_RE.test(id)) throw new Error('Zły identyfikator.');
    const prev = db.capes[id] || {};
    const c = { ...prev, id, pl, en, unlock, level, created: prev.created || Date.now(), ver: prev.ver || 1 };
    if (buf) {
      await storage.putBlob('capes', id, buf);
      images.set(id, buf);
      if (editing) c.ver = (prev.ver || 1) + 1; // nowy adres obrazka – launchery i gry pobiorą go od nowa
    }
    db.capes[id] = c;
    changed();
    if (unlock === 'level') for (const u of Object.values(db.users)) if (grantLevel(u)) pushMe(u.uuid);
    return publicView(c);
  }

  async function adminDelete(id) {
    if (!db.capes[id]) throw new Error('Nie ma takiej peleryny.');
    delete db.capes[id];
    images.delete(id);
    await storage.delBlob('capes', id);
    // nikt jej już nie założy (gracze, którzy ją mieli, dostają z powrotem zwykłą)
    for (const u of Object.values(db.users)) {
      u.unlocked = (u.unlocked || []).filter((k) => k !== `cape:${id}`);
      if (new RegExp(`(^|;)cape=${id}(;|$)`).test(u.cosmetics || '')) u.cosmetics = u.cosmetics.replace(new RegExp(`(^|;)cape=${id}(?=;|$)`), '$1cape=gruz');
    }
    for (const k of Object.keys(db.codes || {})) if (db.codes[k].cosmetic === `cape:${id}`) delete db.codes[k];
    changed();
    return { ok: true };
  }

  async function adminMove(id, dir) {
    const l = list();
    const i = l.findIndex((c) => c.id === id), j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= l.length) return { ok: true };
    [l[i], l[j]] = [l[j], l[i]];
    l.forEach((c, n) => { c.order = n; });
    changed();
    return { ok: true };
  }

  apply();
  return { http, apply, grantLevel, list, publicView, adminList, adminSave, adminDelete, adminMove, pngSize, slug };
}

module.exports = { setup, pngSize, slug };
