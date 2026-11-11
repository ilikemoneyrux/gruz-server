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
  const own = require('../catalog').custom[style]; // własna peleryna z panelu admina (obrazek w bazie)
  if (own) {
    const key = `${style}@${own.ver}`;
    if (!capeCache.has(key)) capeCache.set(key, require('../storage').getBlob('capes', style).then((b) => (b ? loadImage(b) : null)).catch(() => null));
    return capeCache.get(key);
  }
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
    const k = img.width / 64; // 64x32 albo większa w tej samej proporcji (HD 1024x512 -> k = 16)
    ctx.drawImage(img, k, k, 10 * k, 16 * k, x, y, w, h);
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


// ---------------- banery dla partnerów / twórców ----------------
const DL = 'github.com/ilikemoneyrux/gruz-client';

function glow(ctx, x, y, r, a = 0.4, color = '180,92,255') {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${color},${a})`);
  g.addColorStop(1, `rgba(${color},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/** Pełne tło banera (bez zaokrągleń): gradient, poświaty, siatka, kilka "odłamków" */
function bannerBg(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#07050c');
  g.addColorStop(0.55, '#120a1f');
  g.addColorStop(1, '#1d0f33');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  glow(ctx, w * 0.82, h * 0.35, Math.max(w, h) * 0.55, 0.32);
  glow(ctx, w * 0.05, h * 1.05, Math.max(w, h) * 0.45, 0.22, '92,140,255');
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  const step = Math.round(Math.max(w, h) / 40);
  for (let x = 0; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke(); }
  for (let y = 0; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke(); }
  // odłamki (romby) jak w launcherze
  const shards = [[0.62, 0.12, 0.018], [0.93, 0.78, 0.026], [0.48, 0.88, 0.012], [0.08, 0.2, 0.014], [0.74, 0.62, 0.01]];
  for (const [fx, fy, fs] of shards) {
    const x = fx * w, y = fy * h, r = fs * Math.max(w, h);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(0.6);
    ctx.fillStyle = 'rgba(180,92,255,0.18)';
    ctx.strokeStyle = 'rgba(220,170,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.fillRect(-r / 2, -r / 2, r, r);
    ctx.strokeRect(-r / 2, -r / 2, r, r);
    ctx.restore();
  }
}

function fitFont(ctx, text, maxW, size, family) {
  let s = size;
  do { ctx.font = `${s}px ${family}`; s -= 2; } while (ctx.measureText(text).width > maxW && s > 10);
  return s + 2;
}

/** Napis z gradientem akcentu i poświatą */
function neonText(ctx, text, x, y, size, align = 'left') {
  ctx.save();
  ctx.font = `${size}px PoppinsBold`;
  ctx.textAlign = align;
  const w = ctx.measureText(text).width;
  const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const g = ctx.createLinearGradient(x0, y - size, x0 + w, y);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#dcaaff');
  ctx.shadowColor = 'rgba(180,92,255,0.8)';
  ctx.shadowBlur = size * 0.45;
  ctx.fillStyle = g;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** Ramka z kodem twórcy */
function codeBox(ctx, x, y, w, h, code, sub) {
  ctx.save();
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, 'rgba(180,92,255,0.28)');
  g.addColorStop(1, 'rgba(92,60,255,0.12)');
  ctx.fillStyle = g;
  roundRect(ctx, x, y, w, h, h * 0.22);
  ctx.fill();
  ctx.setLineDash([h * 0.12, h * 0.08]);
  ctx.strokeStyle = 'rgba(220,170,255,0.75)';
  ctx.lineWidth = Math.max(2, h * 0.025);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const pad = h * 0.28;
  ctx.font = `${Math.round(h * 0.17)}px PoppinsSemi`;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText('USE CODE', x + pad, y + h * 0.3);
  const size = fitFont(ctx, code, w - pad * 2, Math.round(h * 0.42), 'PoppinsBold');
  neonText(ctx, code, x + pad, y + h * 0.68, size);
  if (sub) {
    ctx.textAlign = 'right';
    ctx.font = `${Math.round(h * 0.15)}px PoppinsSemi`;
    ctx.fillStyle = '#dcaaff';
    ctx.fillText(sub, x + w - pad, y + h * 0.3);
  }
  ctx.restore();
}

/** Postać od tyłu z peleryną Gruz (albo sama peleryna, gdy nie znamy skina) */
async function heroFigure(ctx, skin, slim, cx, top, s, cape = 'gruz') {
  ctx.save();
  ctx.translate(cx + 0, top + 32 * s);
  ctx.scale(1, 0.2);
  const fl = ctx.createRadialGradient(0, 0, 0, 0, 0, 16 * s);
  fl.addColorStop(0, 'rgba(180,92,255,0.55)');
  fl.addColorStop(1, 'rgba(180,92,255,0)');
  ctx.fillStyle = fl;
  ctx.fillRect(-16 * s, -16 * s, 32 * s, 32 * s);
  ctx.restore();
  ctx.imageSmoothingEnabled = false;
  const x = cx - 8 * s;
  if (skin) drawBody(ctx, skin, x, top, s, true, slim);
  drawCape(ctx, await capeImage(cape), cape, x, top, s);
  ctx.imageSmoothingEnabled = true;
}

async function logoAt(ctx, x, y, size) {
  const l = await logo();
  if (!l) return;
  ctx.save();
  ctx.shadowColor = 'rgba(180,92,255,0.7)';
  ctx.shadowBlur = size * 0.35;
  ctx.drawImage(l, x, y, size, size);
  ctx.restore();
}

function chips(ctx, items, x, y, h, gap = 12) {
  ctx.save();
  ctx.font = `${Math.round(h * 0.42)}px PoppinsSemi`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const it of items) {
    const w = ctx.measureText(it).width + h * 0.9;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180,92,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#efe6ff';
    ctx.fillText(it, x + h * 0.45, y + h / 2 + 1);
    x += w + gap;
  }
  ctx.restore();
}

/**
 * Zestaw gotowych reklam dla twórcy.
 * @param o { nick, code, reward (np. "free Nebula cape"), skin(Buffer|null), slim }
 * @returns [{ name, title, buffer }]
 */
async function partnerBanners(o) {
  const skin = o.skin ? await loadImage(o.skin).catch(() => null) : null;
  const code = String(o.code || o.nick).toUpperCase();
  const reward = o.reward || 'free cape';
  const out = [];

  // 1) Nakładka na stream (przezroczyste tło)
  {
    const W = 1000, H = 190;
    const cv = createCanvas(W, H);
    const ctx = cv.getContext('2d');
    ctx.save();
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(12,9,19,0.92)');
    g.addColorStop(1, 'rgba(32,16,56,0.92)');
    ctx.fillStyle = g;
    roundRect(ctx, 6, 6, W - 12, H - 12, 34);
    ctx.fill();
    ctx.clip();
    glow(ctx, W - 120, H / 2, 260, 0.35);
    ctx.restore();
    ctx.strokeStyle = 'rgba(180,92,255,0.8)';
    ctx.lineWidth = 3;
    roundRect(ctx, 6, 6, W - 12, H - 12, 34);
    ctx.stroke();
    await logoAt(ctx, 34, 37, 116);
    ctx.textBaseline = 'alphabetic';
    ctx.font = '22px PoppinsSemi';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('NOW PLAYING ON', 176, 72);
    neonText(ctx, 'GRUZ CLIENT', 174, 128, 54);
    ctx.font = '22px PoppinsSemi';
    ctx.fillStyle = '#dcaaff';
    ctx.fillText(`code ${code} = ${reward}`, 176, 162);
    ctx.save();
    ctx.globalAlpha = 0.95;
    await heroFigure(ctx, skin, o.slim, W - 110, 22, 4.6);
    ctx.restore();
    out.push({ name: 'gruz-stream-overlay.png', title: 'Stream overlay (transparent)', buffer: cv.toBuffer('image/png') });
  }

  // 2) Post kwadratowy (Instagram / TikTok / Discord)
  {
    const W = 1080, H = 1080;
    const cv = createCanvas(W, H);
    const ctx = cv.getContext('2d');
    bannerBg(ctx, W, H);
    await logoAt(ctx, 80, 80, 92);
    ctx.font = '30px PoppinsBold';
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText('GRUZ CLIENT', 190, 126);
    ctx.textBaseline = 'alphabetic';
    neonText(ctx, 'Your Minecraft.', 80, 330, 92);
    neonText(ctx, 'Upgraded.', 80, 430, 92);
    ctx.font = '30px PoppinsSemi';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('FPS boost · cosmetics · friends & party', 80, 500);
    chips(ctx, ['Free', '1.20 – 26.x', 'Fabric mods', 'Discord'], 80, 540, 52);
    await heroFigure(ctx, skin, o.slim, 890, 296, 13);
    codeBox(ctx, 80, 760, 920, 170, code, reward.toUpperCase());
    ctx.font = '24px PoppinsSemi';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(`Download: ${DL}`, 80, 1000);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#dcaaff';
    ctx.fillText(`with ${o.nick}`, 1000, 1000);
    out.push({ name: 'gruz-post-square.png', title: 'Square post (1080×1080)', buffer: cv.toBuffer('image/png') });
  }

  // 3) Szeroki baner (Twitter/X, YouTube community, opis kanału)
  {
    const W = 1500, H = 500;
    const cv = createCanvas(W, H);
    const ctx = cv.getContext('2d');
    bannerBg(ctx, W, H);
    await logoAt(ctx, 70, 64, 70);
    ctx.font = '26px PoppinsBold';
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText('GRUZ CLIENT', 156, 99);
    ctx.textBaseline = 'alphabetic';
    neonText(ctx, `${o.nick} plays on Gruz`, 70, 250, fitFont(ctx, `${o.nick} plays on Gruz`, 820, 76, 'PoppinsBold'));
    ctx.font = '26px PoppinsSemi';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('The free Minecraft client with FPS boost and cosmetics.', 70, 300);
    codeBox(ctx, 70, 336, 600, 120, code, reward.toUpperCase());
    ctx.font = '22px PoppinsSemi';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(`Download: ${DL}`, 700, 420);
    await heroFigure(ctx, skin, o.slim, 1240, 70, 11);
    out.push({ name: 'gruz-banner-wide.png', title: 'Wide banner (1500×500)', buffer: cv.toBuffer('image/png') });
  }

  // 4) Ekran 16:9 (start streama / przerwa / koniec filmu)
  {
    const W = 1920, H = 1080;
    const cv = createCanvas(W, H);
    const ctx = cv.getContext('2d');
    bannerBg(ctx, W, H);
    await logoAt(ctx, 120, 110, 120);
    ctx.font = '40px PoppinsBold';
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText('GRUZ CLIENT', 264, 170);
    ctx.textBaseline = 'alphabetic';
    ctx.font = '40px PoppinsSemi';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(`${o.nick} is playing on`, 120, 450);
    neonText(ctx, 'GRUZ CLIENT', 112, 590, 150);
    ctx.font = '38px PoppinsSemi';
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillText('Free · FPS boost · cosmetics · friends & party', 120, 670);
    codeBox(ctx, 120, 740, 900, 190, code, reward.toUpperCase());
    ctx.font = '30px PoppinsSemi';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(`Download: ${DL}`, 120, 1000);
    await heroFigure(ctx, skin, o.slim, 1500, 170, 24);
    out.push({ name: 'gruz-screen-16x9.png', title: 'Stream screen / video end card (1920×1080)', buffer: cv.toBuffer('image/png') });
  }
  return out;
}

/**
 * Obrazek do podglądu linku (Discord, X): profil gracza albo strona twórcy. 1200x630.
 * @param o { title, kicker, chips: [..], foot, skin(Buffer|null), slim, cape, codeBox }
 */
async function shareCard(o) {
  const W = 1200, H = 630;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext('2d');
  bannerBg(ctx, W, H);
  await logoAt(ctx, 70, 62, 64);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = '26px PoppinsBold';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('GRUZ CLIENT', 150, 104);
  ctx.font = '24px PoppinsSemi';
  ctx.fillStyle = '#dcaaff';
  ctx.fillText(String(o.kicker || '').toUpperCase(), 72, 238);
  const size = fitFont(ctx, o.title, 640, 108, 'PoppinsBold');
  neonText(ctx, o.title, 70, 238 + size * 0.95, size);
  let y = 238 + size * 0.95 + 44;
  if (o.codeBox) {
    ctx.font = '22px PoppinsSemi';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('CODE', 72, y + 10);
    ctx.font = '44px PoppinsBold';
    const cw = ctx.measureText(o.codeBox).width + 56;
    ctx.fillStyle = 'rgba(180,92,255,0.16)';
    roundRect(ctx, 150, y - 34, cw, 66, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(220,170,255,0.7)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(o.codeBox, 178, y + 16);
    y += 84;
  }
  chips(ctx, o.chips || [], 70, y, 52, 14);
  ctx.font = '24px PoppinsSemi';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText(o.foot || 'gruzclient.com', 72, H - 58);
  // postać po prawej: tył z peleryną, gdy jest peleryna; inaczej przód
  const skin = o.skin ? await loadImage(o.skin).catch(() => null) : null;
  const s = 13;
  if (o.cape) await heroFigure(ctx, skin, o.slim, 940, 120, s, o.cape);
  else if (skin) { ctx.imageSmoothingEnabled = false; drawBody(ctx, skin, 940 - 8 * s, 120, s, false, o.slim); ctx.imageSmoothingEnabled = true; }
  return cv.toBuffer('image/png');
}

module.exports = { captcha, newCode, skinCard, shareCard, mojangProfile, fetchBuf, HD_CAPES, partnerBanners };
