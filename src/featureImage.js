import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Feature image in the SYU blog style: a campus photo (or a drawn study desk) behind,
// a stack of course books and a laptop on the desk, the college/exam logo in a white circle,
// the title on a navy brush stroke, the topic + year on a yellow one, and the SYU brand top right.
// Only the text, logo, photo and book labels change per article.
const asset = (f) => fileURLToPath(new URL(`../assets/${f}`, import.meta.url));
const FONTS = [asset('Poppins-ExtraBold.ttf'), asset('Poppins-Bold.ttf')];
const SYU_ICON = `data:image/png;base64,${readFileSync(asset('syu-icon.png')).toString('base64')}`;
const W = 1200, H = 675;
const NAVY = '#16206b', YELLOW = '#ffd21f', RED = '#e3262f', PINK = '#e8336e';
const BOOKS = ['#1d3f8f', '#c4302b', '#1f7a4d', '#0f7c8c', '#6a3fa0', '#e07b1a'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Poppins ExtraBold averages ~0.62em per character.
const textW = (t, size) => t.length * size * 0.62;
const fit = (text, maxW, maxSize) => Math.min(maxSize, Math.floor(maxW / (Math.max(text.length, 1) * 0.62)));

/** Split a title into at most two balanced lines. */
function wrap(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const words = text.split(' ');
  let best = [text], bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const diff = Math.abs(a.length - b.length);
    if (diff < bestDiff) { best = [a, b]; bestDiff = diff; }
  }
  return best;
}

/** A painted brush stroke: ragged ends, slightly wavy edges. */
function brush(cx, cy, w, h, fill, seed) {
  let s = seed;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  const pts = [];
  for (let x = x0; x < x1; x += 60) pts.push([x, y0 + (rnd() - 0.5) * 8]);
  for (let i = 0; i <= 8; i++) pts.push([x1 + rnd() * 26 - 6, y0 + (h * i) / 8]);
  for (let x = x1; x > x0; x -= 60) pts.push([x, y1 + (rnd() - 0.5) * 8]);
  for (let i = 8; i >= 0; i--) pts.push([x0 - rnd() * 26 + 6, y0 + (h * i) / 8]);
  const streaks = [0.18, 0.5, 0.82].map((f) => `<rect x="${x1 + 8 + rnd() * 20}" y="${y0 + h * f - 2}" width="${20 + rnd() * 30}" height="4" rx="2" fill="${fill}" opacity="0.8"/>
    <rect x="${x0 - 28 - rnd() * 20}" y="${y0 + h * (1 - f) - 2}" width="${20 + rnd() * 30}" height="4" rx="2" fill="${fill}" opacity="0.8"/>`).join('');
  return `<path d="M${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L')} Z" fill="${fill}"/>${streaks}`;
}

/** Drawn background when there is no campus photo: soft classroom wall with window light. */
function drawnBackground() {
  const bokeh = [[180, 140, 90], [420, 90, 60], [820, 120, 80], [1050, 220, 110], [640, 300, 70]]
    .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff" opacity="0.35"/>`).join('');
  return `<defs><linearGradient id="wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#dcebfb"/><stop offset="1" stop-color="#fbf3e4"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#wall)"/>
  <rect x="60" y="40" width="300" height="360" rx="18" fill="#ffffff" opacity="0.45"/>
  <rect x="840" y="40" width="300" height="360" rx="18" fill="#ffffff" opacity="0.45"/>
  ${bokeh}`;
}

/** Wooden desk along the bottom. */
const desk = `<defs><linearGradient id="wood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c99560"/><stop offset="1" stop-color="#9c6a3a"/></linearGradient></defs>
  <rect x="0" y="575" width="${W}" height="${H - 575}" fill="url(#wood)"/>
  <rect x="0" y="575" width="${W}" height="6" fill="#ddb07c"/>`;

/** Stack of books with course labels on the spines (bottom left). */
function books(tags) {
  const labels = (tags.length ? tags : ['', '', '']).slice(0, 4);
  return labels.map((label, i) => {
    const y = 585 - (i + 1) * 46, w = 236 - (i % 2) * 14, x = 20 + (i % 3) * 6, c = BOOKS[i % BOOKS.length];
    return `<rect x="${x}" y="${y}" width="${w}" height="44" rx="6" fill="${c}"/>
    <rect x="${x + w - 26}" y="${y + 4}" width="20" height="36" rx="3" fill="#f4ecd8"/>
    <rect x="${x + 14}" y="${y + 6}" width="${w - 56}" height="2" fill="#ffffff" opacity="0.35"/>
    <circle cx="${x + 34}" cy="${y + 22}" r="11" fill="#ffffff" opacity="0.9"/>
    ${label ? `<text x="${x + 54}" y="${y + 30}" font-family="Poppins" font-weight="700" font-size="${fit(label, w - 90, 22)}" fill="#ffffff">${esc(label)}</text>` : ''}`;
  }).join('');
}

/** Laptop with a result-style screen (bottom right). */
function laptop(screen) {
  const x = 880, y = 395, w = 290, h = 180;
  return `<rect x="${x - 8}" y="${y - 8}" width="${w + 16}" height="${h + 16}" rx="14" fill="#2b2f3a"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#f3f6fb"/>
  <path d="M${x + w / 2} ${y + 22} l26 10 -26 10 -26 -10 z" fill="${NAVY}"/><rect x="${x + w / 2 - 14}" y="${y + 34}" width="28" height="10" rx="3" fill="${NAVY}"/>
  <text x="${x + w / 2}" y="${y + 78}" text-anchor="middle" font-family="Poppins" font-weight="800" font-size="${fit(screen, w - 40, 30)}" fill="${NAVY}">${esc(screen)}</text>
  <rect x="${x + 30}" y="${y + 94}" width="${w - 60}" height="30" rx="6" fill="#ffffff" stroke="#c9d3e6" stroke-width="2"/>
  <text x="${x + 42}" y="${y + 114}" font-family="Poppins" font-weight="700" font-size="14" fill="#98a2b3">Registration Number</text>
  <rect x="${x + 70}" y="${y + 134}" width="${w - 140}" height="30" rx="6" fill="${NAVY}"/>
  <text x="${x + w / 2}" y="${y + 155}" text-anchor="middle" font-family="Poppins" font-weight="700" font-size="15" fill="#ffffff">Check Now</text>
  <path d="M${x - 40} ${y + h + 10} H${x + w + 40} L${x + w + 10} ${y + h + 28} H${x - 10} Z" fill="#c4c9d4"/>`;
}

/** Notebook and pen in the middle of the desk. */
const notebook = `<g transform="rotate(-4 600 630)"><rect x="470" y="596" width="260" height="110" rx="6" fill="#ffffff" stroke="#d6dbe5" stroke-width="2"/>
  ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<circle cx="${492 + i * 31}" cy="604" r="4" fill="#9aa4b6"/>`).join('')}
  ${[0, 1, 2].map((i) => `<rect x="490" y="${626 + i * 18}" width="220" height="2" fill="#c9d3e6"/>`).join('')}</g>
  <g transform="rotate(-24 690 640)"><rect x="600" y="634" width="150" height="12" rx="6" fill="#1b2a4a"/>
  <rect x="712" y="630" width="30" height="4" rx="2" fill="#d4a017"/><path d="M600 634 L578 640 L600 646 Z" fill="#c9a26b"/><path d="M584 638 L578 640 L584 642 Z" fill="#1b2a4a"/></g>`;

/** Fetch an image as a data URI; ImageKit URLs are converted to PNG/JPG at a useful width. */
export async function imageDataUri(url, { format = 'png', width = 300, trim = false } = {}) {
  if (!url) return null;
  try {
    // trim: ImageKit cuts the empty border around a logo (t-true), so the logo fills its circle.
    const kit = (t) => `${url.split('?')[0]}?tr=f-${format},w-${width}${t ? ',t-true' : ''}`;
    let r = await fetch(/ik\.imagekit\.io/.test(url) ? kit(trim) : url);
    if (!r.ok && trim && /ik\.imagekit\.io/.test(url)) r = await fetch(kit(false));
    if (!r.ok) return null;
    const type = r.headers.get('content-type') || '';
    if (!/png|jpe?g/.test(type)) return null;
    return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
  } catch { return null; }
}

/** Split words into `n` rows of balanced length (in order). */
function rowsOf(words, n) {
  if (words.length <= n) return words.map((w) => [w]);
  let best = null, bestScore = Infinity;
  const go = (from, left, acc) => {
    if (left === 1) {
      const all = [...acc, words.slice(from)];
      const lens = all.map((r) => r.join(' ').length);
      const score = Math.max(...lens) - Math.min(...lens);
      if (score < bestScore) { bestScore = score; best = all; }
      return;
    }
    for (let i = from + 1; i <= words.length - left + 1; i++) go(i, left - 1, [...acc, words.slice(from, i)]);
  };
  go(0, n, []);
  return best;
}

/** Sun rays (short yellow strokes) fanning out from a point, pointing left (dir -1) or right (dir 1). */
function rays(x, y, dir) {
  return [-34, -12, 12, 34].map((deg, i) => {
    const a = (deg * Math.PI) / 180, len = i === 1 || i === 2 ? 46 : 34;
    const x1 = x + dir * 14 * Math.cos(a), y1 = y + 14 * Math.sin(a);
    const x2 = x + dir * (14 + len) * Math.cos(a), y2 = y + (14 + len) * Math.sin(a);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${YELLOW}" stroke-width="9" stroke-linecap="round"/>`;
  }).join('');
}

/**
 * Feature image on an AI photo scene, laid out like the SYU sample: the person on the left, one big navy
 * brush shape in the centre with the title in large UPPERCASE — white rows, the middle row yellow on a red
 * band — yellow rays on both sides, and the SYU brand top right. All text is drawn here, never by the image AI.
 * text: { line1: "Madras University", line2: "Result", year: "2026" }; images: { scene (required) } as data URIs.
 * ("Madras University Result 2026" → MADRAS / UNIVERSITY / RESULT 2026.)
 */
export function renderSceneImage({ line1, line2 = '', year = '' }, { scene, personLeft = false }) {
  const cx = personLeft ? 690 : 600, maxW = personLeft ? 640 : 820;
  // Words of the title once each ("FMGE Exam" + "Exam Day Guidelines" → FMGE EXAM DAY GUIDELINES), then the year.
  const words = [];
  for (const w of `${line1} ${line2}`.toUpperCase().split(/\s+/).filter(Boolean)) if (!words.includes(w)) words.push(w);
  if (year && !words.includes(year)) words.push(year);
  const n = words.length >= 3 ? 3 : words.length;
  const rows = rowsOf(words, n).map((r) => r.join(' '));
  const mid = rows.length === 3 ? 1 : rows.length - 1; // the highlighted row
  const sizes = rows.map((t, i) => fit(t, maxW - 70, i === mid ? 96 : 112));
  const gap = 6;
  const heights = sizes.map((z) => z * 1.12);
  const total = heights.reduce((a, b) => a + b, 0) + gap * (rows.length - 1);
  const top = 350 - total / 2;
  const blobW = Math.min(maxW + 60, Math.max(...rows.map((t, i) => textW(t, sizes[i]))) + 120);
  let y = top;
  const text = rows.map((t, i) => {
    const cy = y + heights[i] / 2;
    y += heights[i] + gap;
    const tw = textW(t, sizes[i]);
    const band = i === mid ? `<g filter="url(#shadow)">${brush(cx, cy, tw + 60, heights[i] * 1.02, RED, 13)}</g>` : '';
    const color = i === mid ? YELLOW : '#ffffff';
    return `${band}<text x="${cx}" y="${cy + sizes[i] * 0.36}" text-anchor="middle" font-family="Poppins" font-weight="800" font-size="${sizes[i]}"
      fill="${color}" stroke="${NAVY}" stroke-width="${Math.round(sizes[i] / 14)}" paint-order="stroke" letter-spacing="1">${esc(t)}</text>`;
  }).join('');
  const midY = top + heights.slice(0, mid).reduce((a, b) => a + b + gap, 0) + heights[mid] / 2;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000000" flood-opacity="0.3"/></filter>
  </defs>
  <image href="${scene}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>
  <g filter="url(#shadow)">
    <rect x="890" y="24" width="286" height="84" rx="16" fill="#ffffff"/>
    <image href="${SYU_ICON}" x="904" y="34" width="64" height="64"/>
    <text x="978" y="72" font-family="Poppins" font-weight="800" font-size="38" fill="${NAVY}">SELECT</text>
    <text x="980" y="96" font-family="Poppins" font-weight="700" font-size="16" fill="${PINK}">YOUR UNIVERSITY</text>
  </g>
  <g transform="rotate(-2 ${cx} 350)">
    <g filter="url(#shadow)">${brush(cx, 350, blobW, total + 70, NAVY, 5)}</g>
    ${rays(cx - blobW / 2 - 18, midY, -1)}${rays(cx + blobW / 2 + 18, midY, 1)}
    ${text}
  </g>
</svg>`;
  return new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Poppins' }, fitTo: { mode: 'width', value: W } }).render().asPng();
}

/**
 * text: { line1: "Bharathidasan University", line2: "Results", year: "2026", tags: ["BA","BSc"], screen: "Results" }
 * images: { logo, photo } as data URIs (optional). Returns a PNG Buffer (1200×675).
 */
export function renderFeatureImage({ line1, line2 = '', year = '', tags = [], screen = 'Results' }, { logo = null, photo = null } = {}) {
  const top = logo ? 225 : 170;
  // Title on navy brush (1–2 lines).
  const lines = wrap(line1, 20);
  const size1 = Math.min(...lines.map((l) => fit(l, 860, 84)));
  const lh = size1 * 1.12;
  const w1 = Math.max(...lines.map((l) => textW(l, size1))) + 90;
  const h1 = lines.length * lh + 34;
  const cy1 = top + h1 / 2;
  const title = lines.map((l, i) => `<text x="${W / 2}" y="${top + 17 + lh * (i + 0.8)}" text-anchor="middle" font-family="Poppins" font-weight="800" font-size="${size1}" fill="#ffffff">${esc(l)}</text>`).join('');
  // Topic + year on yellow brush.
  const sub = `${line2}${line2 && year ? ' ' : ''}${year}`;
  const size2 = fit(sub || ' ', 760, 66);
  const cy2 = top + h1 + 22 + size2 * 0.75;
  const w2 = textW(sub, size2) + 90;
  const subText = sub ? `<text x="${W / 2}" y="${cy2 + size2 * 0.36}" text-anchor="middle" font-family="Poppins" font-weight="800" font-size="${size2}" fill="${NAVY}">${esc(line2)}${line2 && year ? ' ' : ''}<tspan fill="${RED}">${esc(year)}</tspan></text>` : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <clipPath id="logoClip"><circle cx="${W / 2}" cy="112" r="78"/></clipPath>
    <radialGradient id="glow" cx="0.5" cy="0.45" r="0.6"><stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000000" flood-opacity="0.25"/></filter>
  </defs>
  ${photo ? `<image href="${photo}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/><rect width="${W}" height="${H}" fill="url(#glow)"/>` : drawnBackground()}
  ${desk}
  ${notebook}
  ${laptop(screen)}
  <g filter="url(#shadow)">
    <rect x="890" y="24" width="286" height="84" rx="16" fill="#ffffff"/>
    <image href="${SYU_ICON}" x="904" y="34" width="64" height="64"/>
    <text x="978" y="72" font-family="Poppins" font-weight="800" font-size="38" fill="${NAVY}">SELECT</text>
    <text x="980" y="96" font-family="Poppins" font-weight="700" font-size="16" fill="${PINK}">YOUR UNIVERSITY</text>
  </g>
  ${logo ? `<g filter="url(#shadow)"><circle cx="${W / 2}" cy="112" r="88" fill="#ffffff"/></g>
  <image href="${logo}" x="${W / 2 - 70}" y="42" width="140" height="140" preserveAspectRatio="xMidYMid meet" clip-path="url(#logoClip)"/>` : ''}
  <g filter="url(#shadow)" transform="rotate(-1.5 ${W / 2} ${cy1})">${brush(W / 2, cy1, w1, h1, NAVY, 7)}</g>
  <g transform="rotate(-1.5 ${W / 2} ${cy1})">${title}</g>
  ${sub ? `<g filter="url(#shadow)" transform="rotate(-1.5 ${W / 2} ${cy2})">${brush(W / 2, cy2, w2, size2 * 1.45, YELLOW, 11)}</g>
  <g transform="rotate(-1.5 ${W / 2} ${cy2})">${subText}</g>` : ''}
  <g filter="url(#shadow)">${books(tags)}</g>
</svg>`;
  return new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Poppins' }, fitTo: { mode: 'width', value: W } }).render().asPng();
}
