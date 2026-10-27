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
export async function imageDataUri(url, { format = 'png', width = 300 } = {}) {
  if (!url) return null;
  try {
    const u = /ik\.imagekit\.io/.test(url) ? `${url.split('?')[0]}?tr=f-${format},w-${width}` : url;
    const r = await fetch(u);
    if (!r.ok) return null;
    const type = r.headers.get('content-type') || '';
    if (!/png|jpe?g/.test(type)) return null;
    return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
  } catch { return null; }
}

/**
 * Feature image on an AI photo scene, laid out like the SYU sample: big stacked title — line1 on a
 * navy brush stroke, line2 on yellow, the year on pink — the board/college logo in a white circle on
 * the right and the SYU brand top right. All text is drawn here, never by the image AI.
 * text: { line1: "CGBSE", line2: "Time Table", year: "2027" }; images: { scene (required), logo } as data URIs.
 */
export function renderSceneImage({ line1, line2 = '', year = '' }, { scene, logo = null }) {
  const cx = logo ? 520 : 600;
  const maxW = logo ? 640 : 900;
  // Rows: title (1–2 lines) on navy, line2 on yellow, year on pink.
  const rows = [
    ...wrap(line1, logo ? 14 : 20).map((t) => ({ t, fill: NAVY, color: '#ffffff', max: 108 })),
    ...(line2 ? [{ t: line2, fill: YELLOW, color: NAVY, max: 92 }] : []),
    ...(year ? [{ t: year, fill: PINK, color: '#ffffff', max: 104 }] : []),
  ].map((r) => ({ ...r, size: fit(r.t, maxW - 90, r.max) }));
  const gap = 14;
  const heights = rows.map((r) => r.size * 1.32);
  let y = 330 - (heights.reduce((a, b) => a + b, 0) + gap * (rows.length - 1)) / 2;
  const strokes = rows.map((r, i) => {
    const cy = y + heights[i] / 2;
    y += heights[i] + gap;
    return `<g filter="url(#shadow)">${brush(cx, cy, textW(r.t, r.size) + 90, heights[i], r.fill, 7 + i * 4)}</g>
    <text x="${cx}" y="${cy + r.size * 0.36}" text-anchor="middle" font-family="Poppins" font-weight="800" font-size="${r.size}" fill="${r.color}">${esc(r.t)}</text>`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <clipPath id="logoClip"><circle cx="1040" cy="300" r="100"/></clipPath>
    <radialGradient id="glow" cx="${cx / W}" cy="0.48" r="0.42"><stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000000" flood-opacity="0.28"/></filter>
  </defs>
  <image href="${scene}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <g filter="url(#shadow)">
    <rect x="890" y="24" width="286" height="84" rx="16" fill="#ffffff"/>
    <image href="${SYU_ICON}" x="904" y="34" width="64" height="64"/>
    <text x="978" y="72" font-family="Poppins" font-weight="800" font-size="38" fill="${NAVY}">SELECT</text>
    <text x="980" y="96" font-family="Poppins" font-weight="700" font-size="16" fill="${PINK}">YOUR UNIVERSITY</text>
  </g>
  ${logo ? `<g filter="url(#shadow)"><circle cx="1040" cy="300" r="118" fill="#ffffff"/></g>
  <image href="${logo}" x="940" y="200" width="200" height="200" preserveAspectRatio="xMidYMid meet" clip-path="url(#logoClip)"/>` : ''}
  <g transform="rotate(-3 ${cx} 330)">${strokes}</g>
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
