// Obrazki bota w stylu Gruz Client: kod do weryfikacji (captcha) i karta ze skinem i peleryną.
const path = require('path');
const crypto = require('crypto');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const A = (f) => path.join(__dirname, '..', 'assets', f);
GlobalFonts.registerFromPath(A('fonts/poppins-bold.ttf'), 'PoppinsBold');
GlobalFonts.registerFromPath(A('fonts/poppins-semibold.ttf'), 'PoppinsSemi');

const ACCENT = '#b45cff';
let logoP = null;
const logo = () => (logoP ||= loadImage(A('logo.png')).catch(() => null));
const capeCache = new Map();
const HD_CAPES = ['gruz', 'nebula', 'sakura', 'inferno', 'ocean', 'pumpkin', 'winter'];
const ANIM_CAPES = { flow: ['#4ad6ff', '#b45cff'], crystals: ['#b45cff', '#5cf0ff'], galaxy: ['#1a0b3d', '#8a5cff'], aurora: ['#3dffb4', '#5c7cff'], ember: ['#ff7a2e', '#5c1a00'] };

const rnd = (a, b) => a + (b - a) * (crypto.randomInt(1_000_000) / 1_000_000);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Tło w stylu launchera: ciemny fiolet, poświata akcentu, delikatna siatka */
function background(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#0c0913');
  g.addColorStop(1, '#190f2b');
  ctx.fillStyle = g;
  roundRect(ctx, 0, 0, w, h, 26);
  ctx.fill();
  ctx.save();
  ctx.clip();
  for (const [x, y, r, a] of [[w * 0.15, h * 0.1, h * 0.9, 0.35], [w * 0.95, h * 1.0, h * 1.1, 0.28]]) {
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(180,92,255,${a})`);
    rg.addColorStop(1, 'rgba(180,92,255,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 28) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke(); }
  for (let y = 0; y < h; y += 28) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke(); }
  ctx.restore();
  ctx.strokeStyle = 'rgba(180,92,255,0.45)';
  ctx.lineWidth = 2;
  roundRect(ctx, 1, 1, w - 2, h - 2, 25);
  ctx.stroke();
}

async function header(ctx, x, y, label) {
  const l = await logo();
  if (l) ctx.drawImage(l, x, y, 34, 34);
  ctx.font = '15px PoppinsBold';
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText('GRUZ CLIENT', x + 44, y + 17);
  const tw = ctx.measureText('GRUZ CLIENT').width;
  ctx.font = '13px PoppinsSemi';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText('·  ' + label, x + 52 + tw, y + 17);
}

// ---------------- captcha ----------------
const CODE_ABC = 'ABCDEFGHJKMNPRSTUVWXYZ23456789';
function newCode(n = 6) { let s = ''; for (let i = 0; i < n; i++) s += CODE_ABC[crypto.randomInt(CODE_ABC.length)]; return s; }

async function captcha(code) {
  const W = 640, H = 240;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext('2d');
  background(ctx, W, H);
  await header(ctx, 26, 20, 'VERIFICATION');

  // pole z kodem
  const bx = 40, by = 74, bw = W - 80, bh = 130;
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  roundRect(ctx, bx, by, bw, bh, 18);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.save();
  roundRect(ctx, bx, by, bw, bh, 18);
  ctx.clip();
  // fałszywe, blade znaki w tle
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 14; i++) {
    ctx.font = `${Math.round(rnd(22, 40))}px PoppinsBold`;
    ctx.fillStyle = `rgba(180,92,255,${rnd(0.07, 0.16)})`;
    ctx.save();
    ctx.translate(rnd(bx, bx + bw), rnd(by, by + bh));
    ctx.rotate(rnd(-0.8, 0.8));
    ctx.fillText(CODE_ABC[crypto.randomInt(CODE_ABC.length)], 0, 0);
    ctx.restore();
  }
  // właściwy kod
  const step = (bw - 70) / code.length;
  for (let i = 0; i < code.length; i++) {
    const x = bx + 35 + step * (i + 0.5) + rnd(-7, 7);
    const y = by + bh / 2 + rnd(-14, 14);
    const size = Math.round(rnd(62, 78));
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rnd(-0.38, 0.38));
    ctx.transform(1, 0, rnd(-0.25, 0.25), 1, 0, 0);
    ctx.font = `${size}px PoppinsBold`;
    const g = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
    g.addColorStop(0, '#f2e4ff');
    g.addColorStop(1, ACCENT);
    ctx.shadowColor = 'rgba(180,92,255,0.75)';
    ctx.shadowBlur = 18;
    ctx.fillStyle = g;
    ctx.fillText(code[i], 0, 0);
    ctx.restore();
  }
  // linie zakłócające przez kod
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(bx - 10, rnd(by, by + bh));
    ctx.bezierCurveTo(rnd(bx, bx + bw / 2), rnd(by - 30, by + bh + 30), rnd(bx + bw / 2, bx + bw), rnd(by - 30, by + bh + 30), bx + bw + 10, rnd(by, by + bh));
    ctx.strokeStyle = i % 2 ? `rgba(255,255,255,${rnd(0.25, 0.45)})` : `rgba(180,92,255,${rnd(0.45, 0.7)})`;
    ctx.lineWidth = rnd(2, 3.5);
    ctx.stroke();
  }
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(255,255,255,${rnd(0.05, 0.35)})`;
    ctx.fillRect(rnd(bx, bx + bw), rnd(by, by + bh), rnd(1, 2.6), rnd(1, 2.6));
  }
  ctx.restore();

  ctx.font = '13px PoppinsSemi';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.textAlign = 'center';
  ctx.fillText('Type the 6 characters you see · Wpisz 6 znaków z obrazka', W / 2, H - 18);
  return cv.toBuffer('image/png');
}

// ---------------- skin + peleryna ----------------
async function fetchBuf(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'GruzClientBot' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

/** nick -> { uuid, name, skinUrl, slim } albo null */
async function mojangProfile(nick) {
  const r = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(nick)}`);
  if (r.status === 204 || r.status === 404) return null;
  if (!r.ok) throw new Error('mojang ' + r.status);
  const { id, name } = await r.json();
  const p = await (await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`)).json();
  const tex = JSON.parse(Buffer.from(p.properties.find((x) => x.name === 'textures').value, 'base64').toString('utf8'));
  const skin = tex.textures?.SKIN;
  const uuid = id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  return { uuid, name, skinUrl: skin?.url || null, slim: skin?.metadata?.model === 'slim' };
}

async function capeImage(style) {
  if (!HD_CAPES.includes(style)) return null;
  if (!capeCache.has(style)) capeCache.set(style, loadImage(A(`capes/${style}.png`)).catch(() => null));
  return capeCache.get(style);
}

/**
 * Rysuje płaską postać (przód albo tył) w skali s px na piksel skina.
 * Współrzędne regionów jak w pliku skina 64x64 (stary format 64x32: lewe kończyny = odbite prawe).
 */
function drawBody(ctx, skin, ox, oy, s, back, slim) {
  const legacy = skin.height === 32;
  const aw = slim ? 3 : 4;
  const part = (sx, sy, sw, sh, dx, dy, mirror = false) => {
    ctx.save();
    if (mirror) { ctx.translate(ox + (dx + sw) * s, oy + dy * s); ctx.scale(-1, 1); ctx.drawImage(skin, sx, sy, sw, sh, 0, 0, sw * s, sh * s); }
    else ctx.drawImage(skin, sx, sy, sw, sh, ox + dx * s, oy + dy * s, sw * s, sh * s);
    ctx.restore();
  };
  // [region przód, region tył] dla warstwy podstawowej i zewnętrznej
  const R = {
    head: { b: [[8, 8], [24, 8]], o: [[40, 8], [56, 8]], w: 8, h: 8 },
    body: { b: [[20, 20], [32, 20]], o: [[20, 36], [32, 36]], w: 8, h: 12 },
    rArm: { b: [[44, 20], [48 + aw, 20]], o: [[44, 36], [48 + aw, 36]], w: aw, h: 12 },
    lArm: { b: [[36, 52], [40 + aw, 52]], o: [[52, 52], [56 + aw, 52]], w: aw, h: 12 },
    rLeg: { b: [[4, 20], [12, 20]], o: [[4, 36], [12, 36]], w: 4, h: 12 },
    lLeg: { b: [[20, 52], [28, 52]], o: [[4, 52], [12, 52]], w: 4, h: 12 },
  };
  // pozycja na rysunku (x w pikselach skina, szerokość postaci 16)
  const X = back
    ? { head: 4, body: 4, lArm: 4 - aw, rArm: 12, lLeg: 4, rLeg: 8 }
    : { head: 4, body: 4, rArm: 4 - aw, lArm: 12, rLeg: 4, lLeg: 8 };
  const Y = { head: 0, body: 8, rArm: 8, lArm: 8, rLeg: 20, lLeg: 20 };
  const i = back ? 1 : 0;
  for (const layer of ['b', 'o']) {
    if (legacy && layer === 'o') { // stary skin ma tylko nakładkę na głowę
      part(...R.head.o[i], 8, 8, X.head, Y.head);
      continue;
    }
    for (const k of ['rLeg', 'lLeg', 'body', 'rArm', 'lArm', 'head']) {
      const r = R[k];
      if (legacy && (k === 'lArm' || k === 'lLeg')) {
        const src = R[k === 'lArm' ? 'rArm' : 'rLeg'].b[i];
        part(src[0], src[1], r.w, r.h, X[k], Y[k], true);
      } else part(...r[layer][i], r.w, r.h, X[k], Y[k]);
    }
  }
}

function drawCape(ctx, img, style, ox, oy, s) {
  // peleryna 10x16 px od ramion w dół, lekko szersza niż tułów
  const x = ox + 3 * s, y = oy + 8 * s, w = 10 * s, h = 16 * s;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  if (img) {
    ctx.drawImage(img, 16, 16, 160, 256, x, y, w, h);
  } else {
    const [a, b] = ANIM_CAPES[style] || ['#b45cff', '#3a1a66'];
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
  // cień przy ramionach
  const sh = ctx.createLinearGradient(0, y, 0, y + s * 2);
  sh.addColorStop(0, 'rgba(0,0,0,0.35)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh;
  ctx.fillRect(x, y, w, s * 2);
}

/**
 * Karta gracza: przód i tył (z peleryną), nick i statystyki.
 * @param o { name, skin(Buffer|null), slim, cape, capeLabel, line1, line2 }
 */
async function skinCard(o) {
  const W = 900, H = 560;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext('2d');
  background(ctx, W, H);
  await header(ctx, 30, 24, 'PLAYER PREVIEW');
  ctx.imageSmoothingEnabled = false;

  const skin = o.skin ? await loadImage(o.skin) : null;
  const s = 12; // 16x32 px skina -> 192x384
  const pos = [[W / 2 - 230, 120], [W / 2 + 38, 120]];
  for (const [k, [x, y]] of pos.entries()) {
    // podłoga / cień
    ctx.save();
    ctx.translate(x + 8 * s, y + 32 * s);
    ctx.scale(1, 0.22);
    const fl = ctx.createRadialGradient(0, 0, 0, 0, 0, 160);
    fl.addColorStop(0, 'rgba(180,92,255,0.45)');
    fl.addColorStop(1, 'rgba(180,92,255,0)');
    ctx.fillStyle = fl;
    ctx.fillRect(-160, -160, 320, 320);
    ctx.restore();
    if (skin) drawBody(ctx, skin, x, y, s, k === 1, o.slim);
    if (k === 1 && o.cape) drawCape(ctx, await capeImage(o.cape), o.cape, x, y, s);
  }
  ctx.imageSmoothingEnabled = true;

  // podpisy
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '13px PoppinsSemi';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText('FRONT', pos[0][0] + 8 * s, H - 26);
  ctx.fillText('BACK', pos[1][0] + 8 * s, H - 26);

  ctx.textAlign = 'right';
  ctx.font = '30px PoppinsBold';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(o.name, W - 34, 52);
  ctx.font = '14px PoppinsSemi';
  ctx.fillStyle = ACCENT;
  if (o.line1) ctx.fillText(o.line1, W - 34, 76);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  if (o.capeLabel) ctx.fillText(o.capeLabel, W - 34, 98);
  return cv.toBuffer('image/png');
}

module.exports = { captcha, newCode, skinCard, mojangProfile, fetchBuf, HD_CAPES };
