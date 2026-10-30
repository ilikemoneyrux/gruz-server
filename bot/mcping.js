// Server List Ping (to samo, co lista serwerów w Minecrafcie): gracze, wersja, MOTD, ikona i ping.
const net = require('net');
const dns = require('dns').promises;

function varint(n) {
  const out = [];
  n >>>= 0;
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}
function packet(id, ...parts) {
  const body = Buffer.concat([varint(id), ...parts]);
  return Buffer.concat([varint(body.length), body]);
}
function str(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([varint(b.length), b]); }
function readVarint(buf, off) {
  let n = 0, shift = 0, b;
  do {
    if (off >= buf.length) return null;
    b = buf[off++];
    n |= (b & 0x7f) << shift;
    shift += 7;
    if (shift > 35) throw new Error('bad varint');
  } while (b & 0x80);
  return [n, off];
}

/** "host", "host:port" -> { host, port, display } z rekordem SRV */
async function resolve(address) {
  let a = String(address || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  let host = a, port = 25565, explicit = false;
  const m = a.match(/^\[?([^\]]+?)\]?:(\d{1,5})$/);
  if (m) { host = m[1]; port = Number(m[2]); explicit = true; }
  if (!/^[a-z0-9.-]+$/.test(host) || host.length > 253) throw new Error('bad address');
  if (!explicit && !net.isIP(host)) {
    try {
      const srv = await dns.resolveSrv(`_minecraft._tcp.${host}`);
      if (srv[0]) return { host: srv[0].name, port: srv[0].port, display: a };
    } catch { /* brak SRV */ }
  }
  return { host, port, display: a };
}

function ping(address, timeout = 6000) {
  return new Promise(async (resolveP, reject) => {
    let target;
    try { target = await resolve(address); } catch (e) { return reject(e); }
    const sock = net.createConnection({ host: target.host, port: target.port });
    let buf = Buffer.alloc(0), status = null, sentAt = 0, done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolveP(val);
    };
    const timer = setTimeout(() => finish(new Error('timeout')), timeout);
    sock.on('error', (e) => finish(e));
    sock.on('connect', () => {
      const port = Buffer.alloc(2); port.writeUInt16BE(target.port);
      sock.write(packet(0x00, varint(767), str(target.host), port, varint(1)));
      sock.write(packet(0x00));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 2 * 1024 * 1024) return finish(new Error('too big'));
      try {
        for (;;) {
          const l = readVarint(buf, 0);
          if (!l) return;
          const [len, off] = l;
          if (buf.length < off + len) return;
          const body = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          const [id, o2] = readVarint(body, 0);
          if (id === 0x00 && !status) {
            const [slen, o3] = readVarint(body, o2);
            status = JSON.parse(body.subarray(o3, o3 + slen).toString('utf8'));
            const t = Buffer.alloc(8); t.writeBigInt64BE(BigInt(Date.now()));
            sentAt = Date.now();
            sock.write(packet(0x01, t));
          } else if (id === 0x01) {
            return finish(null, { ...parse(status), latency: Date.now() - sentAt, display: target.display });
          }
        }
      } catch (e) { finish(e); }
    });
    // część serwerów nie odpowiada na ping – wtedy zwracamy sam status
    sock.on('close', () => { if (status) finish(null, { ...parse(status), latency: null, display: target.display }); else finish(new Error('closed')); });
  });
}

function plain(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(plain).join('');
  return (c.text || '') + (c.translate || '') + (c.extra ? c.extra.map(plain).join('') : '');
}

function parse(s) {
  const motd = plain(s.description).replace(/§[0-9a-fk-or]/gi, '').split('\n').map((l) => l.trim()).join('\n').trim();
  return {
    online: s.players?.online ?? 0,
    max: s.players?.max ?? 0,
    sample: (s.players?.sample || []).map((p) => String(p.name || '').replace(/§[0-9a-fk-or]/gi, '')).filter((n) => /^[\w ]{1,32}$/.test(n)).slice(0, 12),
    version: String(s.version?.name || '?').replace(/§[0-9a-fk-or]/gi, ''),
    motd,
    favicon: typeof s.favicon === 'string' && s.favicon.startsWith('data:image/png;base64,') ? Buffer.from(s.favicon.slice(22), 'base64') : null,
  };
}

module.exports = { ping, resolve };
