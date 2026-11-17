#!/usr/bin/env node
/*
 * Builds the animated README banner: an ASCII angel, plus trails of "lens"
 * windows that re-render the same figure as solid / x-ray / wireframe.
 *
 * Output is plain SVG (CSS keyframes + SMIL, no scripts) so it animates when
 * embedded in a GitHub README through <img>.
 *
 *   node scripts/build-banner.js                 -> assets/banner.svg (cycles themes)
 *                                                   assets/themes/<name>.svg (one each)
 *   node scripts/build-banner.js --title=myname  -> change the name in the menu bar
 *
 * Needs Playwright (Chromium) once, to rasterise the figure for the ASCII frames.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

// ───────────────────────────── configuration ─────────────────────────────
const TITLE = arg('title', 'seraph');
const OUT = path.resolve(__dirname, '..', 'assets');

const W = 1280;
const H = 640;
const BAR = 26; // menu bar height

// Each theme: page background, primary accent, secondary accent.
const THEMES = [
  { name: 'abyss', bg: '#04061a', a: '#4a7dff', b: '#9fd2ff' },
  { name: 'nebula', bg: '#0b0519', a: '#a06bff', b: '#ff8fe0' },
  { name: 'ember', bg: '#140704', a: '#ff7a3d', b: '#ffd27a' },
  { name: 'phosphor', bg: '#03110b', a: '#2ee6a0', b: '#d2ff7a' },
  { name: 'bloodmoon', bg: '#150509', a: '#ff4d73', b: '#ffb8a6' },
  { name: 'frost', bg: '#080a0f', a: '#b9c8de', b: '#ffffff' },
];
const THEME_HOLD = 7; // seconds per theme (incl. cross-fade)
const THEME_FADE = 0.3; // share of each slot spent cross-fading

const INK = '#05060c'; // near-black used for outlines / window bodies

// ASCII grid
const CW = 7.2; // cell width  (0.6em at 12px)
const CH = 12; // cell height
const COLS = Math.floor(W / CW);
const ROWS = Math.floor((H - BAR - 4) / CH);
const GX = (W - COLS * CW) / 2;
const GY = BAR + 2;
const RAMP = " .'`^\",:;Il!i~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW8%B@$";

// Figure animation
const FLAP = 4; // seconds per wing beat
const FPS = 8; // ASCII frame rate
const FRAMES = FLAP * FPS;
const ORIGIN = [640, 296]; // where the figure's chest sits on the canvas

const TAU = Math.PI * 2;
const ph = (t) => (TAU * t) / FLAP;
const POSE = {
  wing: (t) => -1 - 7 * Math.sin(ph(t)), // deg, about the shoulder
  tip: (t) => -1 - 9 * Math.sin(ph(t) - 1.0), // deg, about the wrist (lags)
  bob: (t) => 5 * Math.sin(ph(t) - 0.5), // px
  sway: (t) => 3.5 * Math.sin(ph(t) - 1.9), // deg, ribbons + hem
  hair: (t) => 4 * Math.sin(ph(t) - 2.4),
};

// Window trails
const WIN = { w: 196, h: 144, bar: 20 };
const TRAIL_LEN = 9;
const TRAIL_LAG = 0.13; // seconds between successive windows
const TRAILS = [
  { kind: 'real', label: `${TITLE}.real`, id0: 7001, dur: 18, pauses: 2, k: 0.82, phase: 0.05,
    at: (u) => [640 + 310 * Math.sin(TAU * u), 350 + 140 * Math.sin(2 * TAU * u)] },
  { kind: 'xray', label: 'xray.exe', id0: 7130, dur: 23, pauses: 3, k: 0.8, phase: 0.4,
    at: (u) => [640 + 450 * Math.cos(TAU * u + 2.2), 318 + 196 * Math.sin(TAU * u + 2.2)] },
  { kind: 'wire', label: 'mesh.obj', id0: 7230, dur: 29, pauses: 3, k: 0.8, phase: 0.72,
    at: (u) => [640 - 400 * Math.sin(TAU * u + 1.1), 262 + 150 * Math.sin(3 * TAU * u + 0.4)] },
];

// ─────────────────────────────── helpers ───────────────────────────────
const r1 = (n) => String(Math.round(n * 10) / 10);
const lerp = (a, b, t) => a + (b - a) * t;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pw = (pts, s) => {
  // point on a polyline, s in [0, pts.length-1]
  const i = Math.min(pts.length - 2, Math.floor(s));
  const f = s - i;
  return [lerp(pts[i][0], pts[i + 1][0], f), lerp(pts[i][1], pts[i + 1][1], f)];
};
const pl = (stops, s) => {
  // piecewise-linear lookup: stops = [[s, value], ...]
  for (let i = 0; i < stops.length - 1; i++) {
    const [s0, v0] = stops[i];
    const [s1, v1] = stops[i + 1];
    if (s <= s1) return lerp(v0, v1, Math.max(0, (s - s0) / (s1 - s0)));
  }
  return stops[stops.length - 1][1];
};

/** Feather / leaf shape: from (bx,by), pointing at `deg`, `len` long. */
function leaf(bx, by, deg, len, wid, blunt = 0.85) {
  const a = (deg * Math.PI) / 180;
  const dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
  const p = (f, s) => `${r1(bx + dx * len * f + nx * wid * s)},${r1(by + dy * len * f + ny * wid * s)}`;
  return `M${p(0, 0)}C${p(0.22, 1)} ${p(0.9, blunt)} ${p(1, 0)}C${p(0.9, -blunt)} ${p(0.22, -1)} ${p(0, 0)}Z`;
}
const shape = (d, tone = 1, cls = '') =>
  `<path${cls ? ` class="${cls}"` : ''} d="${d}"${tone < 1 ? ` fill-opacity="${r1(tone)}"` : ''}/>`;

/** A group whose transform is either frozen at time t, or animated with SMIL. */
function moving(type, fn, pivot, inner, t) {
  const fmt = (v) => (type === 'rotate' ? `${r1(v)} ${pivot[0]} ${pivot[1]}` : `0 ${r1(v)}`);
  if (t !== null) return `<g transform="${type}(${fmt(fn(t))})">${inner}</g>`;
  const n = 24;
  const vals = Array.from({ length: n + 1 }, (_, i) => fmt(fn((i / n) * FLAP))).join(';');
  return `<g><animateTransform attributeName="transform" type="${type}" dur="${FLAP}s" repeatCount="indefinite" values="${vals}"/>${inner}</g>`;
}

// ──────────────────────────────── the figure ────────────────────────────────
function wing(t) {
  const arm = [[22, -36], [100, -112], [186, -146], [236, -140]]; // shoulder, elbow, wrist, hand
  const ang = (s) => pl([[0, 104], [1, 92], [2, 66], [3, -16]], s);
  const len = (s) => pl([[0, 92], [1, 142], [2, 178], [2.55, 196], [3, 158]], s);
  const flight = (from, to, n, wid) => {
    let out = '';
    for (let i = 0; i < n; i++) {
      const s = lerp(to, from, i / (n - 1)); // outermost first
      const [x, y] = pw(arm, s);
      out += shape(leaf(x, y, ang(s), len(s), wid), i % 2 ? 0.8 : 0.94);
    }
    return out;
  };
  const coverts = (from, to, n, l, wid, tone) => {
    let out = '';
    for (let i = 0; i < n; i++) {
      const s = lerp(to, from, i / (n - 1));
      const [x, y] = pw(arm, s);
      out += shape(leaf(x, y, ang(s) + 4, l * (0.75 + 0.25 * Math.min(1, s)), wid), tone);
    }
    return out;
  };
  const bone = (i, wid) => {
    const [a, b] = [arm[i], arm[i + 1]];
    const deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    return shape(leaf(a[0] - 4, a[1], deg, Math.hypot(b[0] - a[0], b[1] - a[1]) + 10, wid, 1));
  };
  const outer =
    flight(2.08, 3, 10, 13) + coverts(2.05, 3, 8, 70, 10, 0.95) + coverts(2.05, 2.95, 7, 36, 8, 1) + bone(2, 8);
  const inner =
    flight(1.06, 1.98, 8, 14) + flight(0.12, 0.96, 7, 14) +
    coverts(0.15, 2, 15, 74, 11, 0.95) + coverts(0.1, 2, 13, 40, 9, 1) +
    moving('rotate', POSE.tip, arm[2], outer, t) + bone(0, 10) + bone(1, 9);
  return moving('rotate', POSE.wing, arm[0], inner, t);
}

function figure(t) {
  const wings = `<g transform="scale(-.92 .92)">${wing(t)}</g><g transform="scale(.92)">${wing(t)}</g>`;

  const hair =
    shape('M-24,-84C-26,-112 24,-114 25,-84C27,-66 30,-54 26,-40C16,-48 12,-58 12,-70L-12,-70C-12,-58 -18,-46 -30,-36C-32,-52 -24,-66 -24,-84Z', 0.7) +
    moving('rotate', POSE.hair, [-18, -70],
      shape(leaf(-18, -74, 152, 74, 11), 0.6) + shape(leaf(-16, -62, 138, 58, 9), 0.7), t);

  const ribbons = moving('rotate', POSE.sway, [-30, 44],
    shape('M-30,38C-72,46 -92,88 -132,94C-162,98 -178,128 -210,124L-202,138C-172,146 -156,116 -128,110C-92,104 -72,64 -30,52Z', 0.85) +
    shape('M-30,44C-58,62 -64,104 -96,126C-112,138 -116,164 -140,176L-128,184C-102,172 -100,146 -84,134C-54,112 -50,70 -26,54Z', 0.7), t);
  const ribbonR = moving('rotate', (x) => -POSE.sway(x) * 0.7, [30, 44],
    shape('M30,40C60,52 70,92 104,104C126,112 136,138 160,140L154,152C128,152 118,126 98,118C66,106 54,68 28,54Z', 0.7), t);

  const gown = moving('rotate', (x) => POSE.sway(x) * 0.35, [0, 40],
    shape('M-30,-46C-40,-44 -46,-30 -44,-10C-42,30 -52,80 -66,140C-76,185 -98,222 -124,248C-90,246 -66,236 -48,250C-36,262 -26,244 -12,262C-4,272 6,250 16,262C30,274 40,246 58,238C64,200 54,150 48,110C44,70 42,30 44,-10C46,-30 40,-44 30,-46Z', 0.8) +
    shape(leaf(-22, 62, 104, 176, 5), 1, 'd') + shape(leaf(20, 66, 82, 168, 4.5), 1, 'd') +
    shape(leaf(-42, 112, 112, 124, 4), 1, 'd') + shape(leaf(36, 120, 80, 104, 3.5), 1, 'd'), t);

  const torso =
    shape('M-30,-46C-10,-40 10,-40 30,-46C36,-20 36,10 40,36L-40,36C-36,10 -36,-20 -30,-46Z', 0.8) +
    shape('M-42,32L42,32L45,48L-45,48Z', 0.95) +
    shape(leaf(0, -44, 90, 30, 9), 1, 'd');

  const sleeves = ['', ' transform="scale(-1 1)"']
    .map((m) => `<g${m}>${shape('M-28,-48C-54,-42 -62,-8 -46,16C-36,30 -14,28 -2,20L-4,2C-14,6 -24,2 -27,-10C-29,-24 -22,-38 -14,-46Z', 0.9)}</g>`)
    .join('');

  const head =
    shape('M-7,-58L7,-58L8,-42L-8,-42Z', 0.85) +
    '<ellipse cx="0" cy="-78" rx="17" ry="21"/>' +
    shape('M-19,-84C-18,-104 18,-104 19,-84C10,-92 -2,-94 -19,-84Z', 0.55, 'd');

  const halo = moving('translate', (x) => 2.5 * Math.sin(ph(x) + 1), null,
    '<path fill-rule="evenodd" d="M-31,-124a31,8 0 1,0 62,0a31,8 0 1,0 -62,0ZM-25,-124a25,4.6 0 1,0 50,0a25,4.6 0 1,0 -50,0Z"/>', t);

  const sword =
    shape('M-15,24L15,24L13,256L0,298L-13,256Z', 1, 'd') + // dark margin keeps the blade readable
    shape('M-6,24L6,24L5,258L0,285L-5,258Z') +
    shape(leaf(0, 34, 90, 214, 1.3), 1, 'd') +
    shape('M-38,12C-20,20 20,20 38,12L40,23C20,31 -20,31 -40,23Z') +
    shape('M-4,-16L4,-16L4.5,16L-4.5,16Z', 0.9) +
    '<ellipse cx="0" cy="-21" rx="6.5" ry="6.5"/>' +
    '<ellipse cx="-3" cy="1" rx="9" ry="6.5"/><ellipse cx="3" cy="9" rx="9" ry="6.5"/>';

  return moving('translate', POSE.bob, null,
    `${wings}<g transform="scale(1.12)">${hair + ribbons + ribbonR + gown + torso + sleeves + head + halo + sword}</g>`, t);
}

const FIGURE_CSS =
  '.fig path,.fig ellipse{fill:var(--f,#fff);stroke:var(--s,none);stroke-width:var(--sw,1);stroke-linejoin:round}' +
  '.fig .d{fill:var(--d,#000)}';

// ─────────────────────────── ASCII rasterisation ───────────────────────────
async function asciiFrames() {
  const svgs = [];
  for (let k = 0; k < FRAMES; k++) {
    const t = (k + 0.5) / FPS;
    svgs.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
        `<style>${FIGURE_CSS}.fig{--f:url(#g);--s:#000;--sw:1.6}</style>` +
        '<defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="0" cy="20" r="440">' +
        '<stop offset="0" stop-color="#fff"/><stop offset=".42" stop-color="#e6e6e6"/><stop offset=".78" stop-color="#8e8e8e"/><stop offset="1" stop-color="#4a4a4a"/>' +
        '</radialGradient></defs>' +
        `<rect width="${W}" height="${H}" fill="#000"/>` +
        `<g class="fig" transform="translate(${ORIGIN})">${figure(t)}</g></svg>`
    );
  }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const grids = await page.evaluate(
    async ({ svgs, W, H, CW, CH, COLS, ROWS, GX, GY }) => {
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      const out = [];
      for (const svg of svgs) {
        const img = new Image();
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        await img.decode();
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, W, H).data;
        const grid = [];
        for (let r = 0; r < ROWS; r++) {
          const row = [];
          for (let c = 0; c < COLS; c++) {
            const x0 = Math.round(GX + c * CW), x1 = Math.round(GX + (c + 1) * CW);
            const y0 = Math.round(GY + r * CH), y1 = Math.round(GY + (r + 1) * CH);
            let sum = 0, n = 0;
            for (let y = y0; y < y1; y++)
              for (let x = x0; x < x1; x++) {
                const i = (y * W + x) * 4;
                sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
                n++;
              }
            row.push(sum / n / 255);
          }
          grid.push(row);
        }
        out.push(grid);
      }
      return out;
    },
    { svgs, W, H, CW, CH, COLS, ROWS, GX, GY }
  );
  await browser.close();

  return grids.map((grid) =>
    grid.map((row) =>
      row
        .map((v) => {
          if (v < 0.045) return ' ';
          const i = 1 + Math.floor(Math.pow(v, 0.85) * (RAMP.length - 1.001));
          return RAMP[Math.min(RAMP.length - 1, i)];
        })
        .join('')
    )
  );
}

function asciiMarkup(frames) {
  const dt = FLAP / FRAMES;
  return frames
    .map((rows, k) => {
      let out = `<g class="fr" style="animation-delay:${r1(k * dt * 1000)}ms">`;
      rows.forEach((row, r) => {
        const body = row.replace(/\s+$/, '');
        const lead = body.length - body.trimStart().length;
        const txt = body.slice(lead);
        if (!txt) return;
        out += `<text x="${r1(GX + lead * CW)}" y="${r1(GY + r * CH + CH * 0.82)}" textLength="${r1(txt.length * CW)}">${esc(txt)}</text>`;
      });
      return out + '</g>';
    })
    .join('\n');
}

// ─────────────────────────────── window trails ───────────────────────────────
function trailCss(tr, i) {
  const n = 48;
  let fwd = '', inv = '';
  for (let j = 0; j <= n; j++) {
    const t = j / n;
    const u = t + (tr.k * Math.sin(TAU * tr.pauses * t)) / (TAU * tr.pauses) + tr.phase;
    const [cx, cy] = tr.at(u);
    const x = cx - WIN.w / 2, y = cy - WIN.h / 2;
    const p = r1((j / n) * 100);
    fwd += `${p}%{transform:translate(${r1(x)}px,${r1(y)}px)}`;
    inv += `${p}%{transform:translate(${r1(-x)}px,${r1(-y)}px)}`;
  }
  return (
    `@keyframes t${i}{${fwd}}@keyframes u${i}{${inv}}` +
    `.t${i}{animation:t${i} ${tr.dur}s linear infinite}.u${i}{animation:u${i} ${tr.dur}s linear infinite}`
  );
}

function trailMarkup(tr, i, rand) {
  const { w, h, bar } = WIN;
  const fig = `<use href="#fig" class="m-${tr.kind}" transform="translate(${ORIGIN})"/>`;
  let out = '';
  for (let j = 0; j < TRAIL_LEN; j++) {
    // j = 0 is the tail (drawn first), the last one leads the trail.
    const lag = (TRAIL_LEN - 1 - j) * TRAIL_LAG;
    const delay = `animation-delay:${r1((lag - tr.dur) * 1000)}ms`;
    const coords = `x${100 + Math.floor(rand() * 900)} y${100 + Math.floor(rand() * 500)} · ${tr.kind === 'wire' ? 'MESH' : tr.kind.toUpperCase()}`;
    out +=
      `<g class="w w-${tr.kind} t${i}" style="${delay}">` +
      `<rect class="sh" x="5" y="6" width="${w}" height="${h}"/>` +
      `<rect class="bd" width="${w}" height="${h}"/>` +
      (tr.kind === 'xray' ? `<rect y="${bar}" width="${w}" height="${h - bar}" fill="url(#grid)"/>` : '') +
      (tr.kind === 'real' ? `<rect y="${bar}" width="${w}" height="${h - bar}" fill="url(#wash)"/>` : '') +
      (tr.kind === 'wire' ? `<rect y="${bar}" width="${w}" height="${h - bar}" fill="url(#plot)"/>` : '') +
      `<g clip-path="url(#lens)"><g class="u${i}" style="${delay}">${fig}</g></g>` +
      `<path class="cr" d="M7,${bar + 15}v-8h8M${w - 15},${bar + 7}h8v8M7,${h - 15}v8h8M${w - 15},${h - 7}h8v-8"/>` +
      `<text class="co" x="20" y="${h - 9}">${coords}</text>` +
      `<rect class="tb" width="${w}" height="${bar}"/>` +
      `<circle class="d1" cx="12" cy="${bar / 2}" r="3"/><circle class="d2" cx="23" cy="${bar / 2}" r="3"/><circle class="d2" cx="34" cy="${bar / 2}" r="3"/>` +
      `<text class="tt" x="50" y="${bar / 2 + 4}">${esc(tr.label)} — #${tr.id0 + j}</text>` +
      `<rect class="ol" x=".5" y=".5" width="${w - 1}" height="${h - 1}"/>` +
      '</g>';
  }
  return out;
}

// ──────────────────────────────── colour themes ────────────────────────────────
function themeCss(themes) {
  if (themes.length === 1) {
    const t = themes[0];
    return `.c1{color:${t.a}}.c2{color:${t.b}}.c0{color:${t.bg}}`;
  }
  const n = themes.length;
  const total = n * THEME_HOLD;
  const frames = (key) => {
    let s = '';
    themes.forEach((t, i) => {
      s += `${r1((i / n) * 100)}%,${r1(((i + 1 - THEME_FADE) / n) * 100)}%{color:${t[key]}}`;
    });
    return s + `100%{color:${themes[0][key]}}`;
  };
  const slot = 100 / n;
  return (
    `@keyframes c1{${frames('a')}}@keyframes c2{${frames('b')}}@keyframes c0{${frames('bg')}}` +
    `.c1{color:${themes[0].a};animation:c1 ${total}s ease-in-out infinite}` +
    `.c2{color:${themes[0].b};animation:c2 ${total}s ease-in-out infinite}` +
    `.c0{color:${themes[0].bg};animation:c0 ${total}s ease-in-out infinite}` +
    `@keyframes tn{0%{opacity:0}${r1(slot * 0.1)}%{opacity:1}${r1(slot * (1 - THEME_FADE))}%{opacity:1}${r1(slot * 0.96)}%{opacity:0}100%{opacity:0}}` +
    `.tn{opacity:0;animation:tn ${total}s linear infinite}`
  );
}

// ──────────────────────────────── assemble ────────────────────────────────
function build(frames, themes) {
  const rand = rng(7);
  const { w, h, bar } = WIN;

  // background dust: sparse punctuation, three twinkle groups
  const dust = [0, 1, 2]
    .map((g) => {
      let rows = '';
      for (let r = 0; r < 9; r++) {
        const y = BAR + 14 + rand() * (H - BAR - 24);
        const xs = [], cs = [];
        for (let c = 0; c < 7; c++) {
          xs.push(r1(10 + rand() * (W - 20)));
          cs.push(";:',.`:;"[Math.floor(rand() * 8)]);
        }
        rows += `<text y="${r1(y)}" x="${xs.sort((a, b) => a - b).join(' ')}">${cs.join('')}</text>`;
      }
      return `<g class="du" style="animation-delay:${-g * 2.3}s">${rows}</g>`;
    })
    .join('');

  const menu =
    `<rect width="${W}" height="${BAR}" fill="#fff" fill-opacity=".05"/>` +
    `<rect y="${BAR - 0.5}" width="${W}" height="1" fill="currentColor" fill-opacity=".45"/>` +
    `<g class="mn"><text x="16" y="17">◆</text><text class="hi" x="40" y="17">${esc(TITLE)}.exe</text>` +
    ['File', 'View', 'Filter', 'Window']
      .map((m, i) => `<text x="${150 + TITLE.length * 7.3 + i * 70}" y="17">${m}</text>`)
      .join('') +
    themes
      .map((t, i) =>
        themes.length === 1
          ? `<text class="hi" x="${W - 16}" y="17" text-anchor="end">● ${t.name}</text>`
          : `<text class="hi tn" x="${W - 16}" y="17" text-anchor="end" style="animation-delay:${i * THEME_HOLD}s">● ${t.name}</text>`
      )
      .join('') +
    '</g>';

  const css = [
    'text{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono","DejaVu Sans Mono",monospace;white-space:pre}',
    themeCss(themes),
    FIGURE_CSS,
    // ASCII layer: one frame visible at a time
    `.as text{font-size:${CH}px;font-weight:700;fill:url(#ink)}`,
    `@keyframes fr{0%{visibility:visible}${r1(100 / FRAMES)}%,100%{visibility:hidden}}`,
    `.fr{visibility:hidden;animation:fr ${FLAP}s steps(1,end) infinite}`,
    // dust + menu
    '.du text{font-size:11px;fill:currentColor}@keyframes du{0%,100%{opacity:.2}50%{opacity:.6}}.du{animation:du 7s ease-in-out infinite}',
    '.mn text{font-size:12px;font-weight:700;fill:currentColor;fill-opacity:.7}.mn .hi{fill-opacity:1}',
    // lens styles for the figure
    `.m-real{--f:url(#shine);--s:${INK};--sw:1.1;--d:${INK}}`,
    '.m-xray{--f:rgba(255,255,255,.13);--s:currentColor;--sw:.9;--d:none}',
    `.m-wire{--f:rgba(255,255,255,.42);--s:${INK};--sw:1;--d:none}`,
    // window chrome
    `.sh{fill:#000;fill-opacity:.28}.bd{fill:${INK}}.w-wire .bd{fill:currentColor}`,
    `.tb{fill:#0d101b}.w-wire .tb{fill:#eef1f8}`,
    '.ol{fill:none;stroke:currentColor;stroke-opacity:.75}',
    `.tt{font-size:10.5px;font-weight:700;fill:currentColor}.w-wire .tt{fill:${INK}}`,
    `.co{font-size:8.5px;fill:currentColor;fill-opacity:.85}.w-wire .co{fill:${INK}}`,
    `.cr{fill:none;stroke:currentColor;stroke-width:1.2}.w-wire .cr{stroke:${INK}}`,
    `.d1{fill:currentColor}.d2{fill:currentColor;fill-opacity:.3}.w-wire .d1,.w-wire .d2{fill:${INK}}`,
    ...TRAILS.map(trailCss),
  ].join('\n');

  const [ox, oy] = ORIGIN;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Animated ASCII angel with floating render windows">
<title>${esc(TITLE)}</title>
<style>
${css}
</style>
<defs>
<clipPath id="frame"><rect width="${W}" height="${H}" rx="14"/></clipPath>
<clipPath id="lens"><rect y="${bar}" width="${w}" height="${h - bar}"/></clipPath>
<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="${ox}" cy="${oy + 30}" r="560"><stop class="c1" offset="0" stop-color="currentColor" stop-opacity=".3"/><stop class="c1" offset=".55" stop-color="currentColor" stop-opacity=".08"/><stop class="c1" offset="1" stop-color="currentColor" stop-opacity="0"/></radialGradient>
<radialGradient id="ink" gradientUnits="userSpaceOnUse" cx="${ox}" cy="${oy + 20}" r="440"><stop offset="0" stop-color="#fff"/><stop class="c2" offset=".4" stop-color="currentColor"/><stop class="c1" offset="1" stop-color="currentColor"/></radialGradient>
<radialGradient id="shine" gradientUnits="userSpaceOnUse" cx="0" cy="20" r="420"><stop offset="0" stop-color="#fff"/><stop offset=".35" stop-color="#fff"/><stop class="c2" offset="1" stop-color="currentColor"/></radialGradient>
<linearGradient id="wash" x1="0" y1="0" x2="1" y2="1"><stop class="c1" offset="0" stop-color="currentColor" stop-opacity=".5"/><stop class="c1" offset="1" stop-color="currentColor" stop-opacity=".16"/></linearGradient>
<pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse"><path class="c2" d="M16,0H0V16" fill="none" stroke="currentColor" stroke-opacity=".2"/></pattern>
<pattern id="plot" width="16" height="16" patternUnits="userSpaceOnUse"><path d="M16,0H0V16" fill="none" stroke="${INK}" stroke-opacity=".16"/></pattern>
<g id="fig" class="fig">${figure(null)}</g>
</defs>
<g clip-path="url(#frame)">
<rect class="c0" width="${W}" height="${H}" fill="currentColor"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
<g class="c1">
${dust}
<g class="as">
${asciiMarkup(frames)}
</g>
${TRAILS.map((tr, i) => (tr.kind === 'xray' ? `<g class="c2">${trailMarkup(tr, i, rand)}</g>` : trailMarkup(tr, i, rand))).join('\n')}
${menu}
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="13.5" fill="none" stroke="currentColor" stroke-opacity=".35"/>
</g>
</g>
</svg>
`;
}

(async () => {
  const frames = await asciiFrames();
  fs.mkdirSync(path.join(OUT, 'themes'), { recursive: true });
  const write = (file, svg) => {
    fs.writeFileSync(file, svg);
    console.log(`${path.relative(process.cwd(), file)}  ${(svg.length / 1024).toFixed(0)} KB`);
  };
  write(path.join(OUT, 'banner.svg'), build(frames, THEMES));
  for (const t of THEMES) write(path.join(OUT, 'themes', `${t.name}.svg`), build(frames, [t]));
})();
