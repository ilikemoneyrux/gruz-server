// Screeny z gry (od 1.10.0): gracz klika „Udostępnij” po zrzucie ekranu (F2) albo wpisuje .share,
// mod wysyła JPEG przez WebSocket (shot.upload), a serwer oddaje link https://gruzclient.com/s/<id>.
// Obrazki leżą w bazie jako blob „shot” (storage.putBlob), lista w db.shots (shots.json).
// Limity: 15 screenów dziennie na gracza, 30 dni przechowywania, maks. 400 sztuk i 120 MB na serwerze (najstarsze znikają).
const crypto = require('crypto');

const MAX_B64 = 940 * 1024;     // ~700 KB JPEG (WebSocket przyjmuje do 1 MB)
const PER_DAY = 15;
const KEEP_MS = 30 * 24 * 3600_000;
const MAX_TOTAL = 400;
const MAX_BYTES = 120 * 1024 * 1024; // darmowa baza Neon ma 0,5 GB na wszystko (base64 zajmuje 4/3 tego)
const SITE = 'https://gruzclient.com';

function setup(ctx) {
  const { db, save, user, storage, publicUrl } = ctx;
  if (!Array.isArray(db.shots)) db.shots = [];
  const byId = (id) => db.shots.find((s) => s.id === id);

  /** Usuwa przeterminowane i nadmiarowe screeny (lista i obrazki) */
  function cleanup() {
    const t0 = Date.now();
    const keep = [], drop = [];
    for (const s of db.shots) (t0 - s.at > KEEP_MS ? drop : keep).push(s);
    keep.sort((a, b) => b.at - a.at);
    drop.push(...keep.splice(MAX_TOTAL));
    let bytes = keep.reduce((n, s) => n + (s.size || 0), 0);
    while (bytes > MAX_BYTES && keep.length > 1) { const s = keep.pop(); bytes -= s.size || 0; drop.push(s); }
    if (!drop.length) return;
    db.shots = keep;
    for (const s of drop) storage.delBlob('shot', s.id).catch(() => {});
    save();
  }
  setInterval(cleanup, 6 * 3600_000).unref?.();

  function newId() {
    const abc = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id;
    do { id = ''; for (let i = 0; i < 8; i++) id += abc[crypto.randomInt(abc.length)]; } while (byId(id));
    return id;
  }

  /** Wiadomość z gry: { t: 'shot.upload', data: base64 JPEG, w, h, server } */
  async function upload(c, m) {
    if (c.kind !== 'game') return;
    const u = user(c.uuid);
    if (!u || u.banned) return;
    const data = typeof m.data === 'string' ? m.data : '';
    if (!data || data.length > MAX_B64) return c.send({ t: 'shot.error', code: 'SHOT_TOO_BIG' });
    const buf = Buffer.from(data, 'base64');
    if (buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8) return c.send({ t: 'shot.error', code: 'SHOT_BAD' }); // tylko JPEG
    const day = Date.now() - 24 * 3600_000;
    if (db.shots.filter((s) => s.uuid === c.uuid && s.at > day).length >= PER_DAY) return c.send({ t: 'shot.error', code: 'SHOT_LIMIT' });
    const id = newId();
    const shot = {
      id, uuid: c.uuid, at: Date.now(),
      w: Math.max(0, Math.min(8192, Number(m.w) || 0)), h: Math.max(0, Math.min(8192, Number(m.h) || 0)),
      server: m.server ? String(m.server).toLowerCase().replace(/[^a-z0-9.:-]/g, '').slice(0, 80) : null,
      size: buf.length,
    };
    // wpis przed zapisem obrazka: kilka wysyłek naraz nie ominie limitu dziennego
    db.shots.unshift(shot);
    try { await storage.putBlob('shot', id, buf); }
    catch (e) {
      db.shots = db.shots.filter((x) => x !== shot);
      console.error('[shots]', e.message);
      return c.send({ t: 'shot.error', code: 'SHOT_SAVE' });
    }
    save();
    cleanup();
    c.send({ t: 'shot.done', id, url: `${SITE}/s/${id}` });
  }

  /** Publiczne dane screena. Adresu serwera MC nie podajemy (zostaje tylko w panelu) – link może trafić do każdego. */
  function view(s) {
    const u = user(s.uuid);
    const shown = u && !u.privateProfile;
    return {
      id: s.id, at: s.at, w: s.w, h: s.h,
      name: shown ? u.name : null, uuid: shown ? u.uuid : null,
      img: publicUrl(`/api/shot/${s.id}.jpg`),
    };
  }

  /** GET /api/shot/<id> (dane) i /api/shot/<id>.jpg (obrazek) */
  async function http(req, res, url) {
    const m = /^\/api\/shot\/([A-Za-z0-9]{6,12})(\.jpg)?$/.exec(url.pathname);
    if (!m || req.method !== 'GET') return false;
    const s = byId(m[1]);
    const u = s && user(s.uuid);
    if (!s || !u || u.banned) {
      res.writeHead(404, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'NO_SHOT' }));
      return true;
    }
    if (!m[2]) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' });
      res.end(JSON.stringify(view(s)));
      return true;
    }
    const buf = await storage.getBlob('shot', s.id);
    if (!buf) { res.writeHead(404, { 'access-control-allow-origin': '*' }); res.end(); return true; }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=86400' });
    res.end(buf);
    return true;
  }

  // ---------- panel admina ----------
  function list(n = 120) {
    return db.shots.slice(0, n).map((s) => ({ ...view(s), server: s.server, name: user(s.uuid)?.name || '?', uuid: s.uuid, size: s.size }));
  }
  async function remove(id) {
    const s = byId(id);
    if (!s) return false;
    db.shots = db.shots.filter((x) => x.id !== id);
    await storage.delBlob('shot', id).catch(() => {});
    save();
    return true;
  }

  cleanup();
  return { upload, http, list, remove };
}

module.exports = { setup, MAX_B64 };
