// Magazyn danych serwera Gruz: pliki JSON w folderze data/ albo baza PostgreSQL (zmienna DATABASE_URL).
// Na darmowych hostingach (np. Render) dysk znika przy restarcie, więc tam używamy bazy (np. darmowy Neon).
const fs = require('fs');
const path = require('path');

const DATA = process.env.GRUZ_DATA || path.join(__dirname, 'data');
const PG_URL = process.env.DATABASE_URL || '';
let pool = null;

async function init() {
  if (PG_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: PG_URL, ssl: /localhost|127\.0\.0\.1/.test(PG_URL) ? false : { rejectUnauthorized: false }, max: 3 });
    await pool.query('CREATE TABLE IF NOT EXISTS gruz_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT now())');
    return 'PostgreSQL';
  }
  fs.mkdirSync(path.join(DATA, 'voice'), { recursive: true });
  return `pliki w ${DATA}`;
}

async function load(name, fallback) {
  try {
    if (pool) {
      const r = await pool.query('SELECT v FROM gruz_kv WHERE k = $1', [name]);
      return r.rows.length ? JSON.parse(r.rows[0].v) : fallback;
    }
    return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
  } catch {
    return fallback;
  }
}

async function put(key, text) {
  if (pool) {
    await pool.query('INSERT INTO gruz_kv (k, v, updated) VALUES ($1, $2, now()) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated = now()', [key, text]);
    return;
  }
  const file = path.join(DATA, key.replace(/^voice:/, 'voice/'));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// zapis leci po każdej zmianie dla wszystkich plików naraz – nie ruszamy bazy, gdy treść się nie zmieniła
const lastSaved = new Map();
async function save(name, value) {
  const text = JSON.stringify(value);
  if (lastSaved.get(name) === text) return;
  await put(name, text);
  lastSaved.set(name, text);
}

// ---------------- wiadomości głosowe ----------------
async function putVoice(id, base64) {
  if (pool) return put('voice:' + id, base64);
  fs.writeFileSync(path.join(DATA, 'voice', id + '.webm'), Buffer.from(base64, 'base64'));
}
async function getVoice(id) {
  if (pool) {
    const r = await pool.query('SELECT v FROM gruz_kv WHERE k = $1', ['voice:' + id]);
    return r.rows.length ? r.rows[0].v : null;
  }
  try { return fs.readFileSync(path.join(DATA, 'voice', id + '.webm')).toString('base64'); } catch { return null; }
}
async function delVoice(id) {
  if (pool) { await pool.query('DELETE FROM gruz_kv WHERE k = $1', ['voice:' + id]); return; }
  fs.rmSync(path.join(DATA, 'voice', id + '.webm'), { force: true });
}

// ---------------- obrazki (np. własne peleryny): baza jako base64 albo plik data/<rodzaj>/<id>.png ----------------
const blobFile = (kind, id) => path.join(DATA, kind, path.basename(id) + '.png');
async function putBlob(kind, id, buf) {
  if (pool) return put(`${kind}:${id}`, buf.toString('base64'));
  fs.mkdirSync(path.join(DATA, kind), { recursive: true });
  fs.writeFileSync(blobFile(kind, id), buf);
}
async function getBlob(kind, id) {
  if (pool) {
    const r = await pool.query('SELECT v FROM gruz_kv WHERE k = $1', [`${kind}:${id}`]);
    return r.rows.length ? Buffer.from(r.rows[0].v, 'base64') : null;
  }
  try { return fs.readFileSync(blobFile(kind, id)); } catch { return null; }
}
async function delBlob(kind, id) {
  if (pool) { await pool.query('DELETE FROM gruz_kv WHERE k = $1', [`${kind}:${id}`]); return; }
  fs.rmSync(blobFile(kind, id), { force: true });
}

module.exports = { init, load, save, putVoice, getVoice, delVoice, putBlob, getBlob, delBlob, DATA };
