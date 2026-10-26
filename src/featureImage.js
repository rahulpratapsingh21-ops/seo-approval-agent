import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Feature image in the SYU blog style: brand mark top-left, topic logo in a white
// circle, title on a navy pill, sub-title on a yellow pill, year on a red pill.
const asset = (f) => fileURLToPath(new URL(`../assets/${f}`, import.meta.url));
const FONTS = [asset('Poppins-ExtraBold.ttf'), asset('Poppins-Bold.ttf')];
const SYU_ICON = `data:image/png;base64,${readFileSync(asset('syu-icon.png')).toString('base64')}`;
const W = 1200, H = 675;
const NAVY = '#16206b', YELLOW = '#ffd21f', RED = '#e3262f', PINK = '#e8336e';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Poppins ExtraBold is ~0.64em per character on average; size text to fit the pill.
const fit = (text, maxW, maxSize) => Math.min(maxSize, Math.floor(maxW / (Math.max(text.length, 1) * 0.64)));

function pill(text, cy, { fill, color, maxSize, maxW = 1000 }) {
  const size = fit(text, maxW - 80, maxSize);
  const w = Math.min(maxW, text.length * size * 0.64 + 80);
  const h = size * 1.45;
  return `<rect x="${(W - w) / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${h / 2.6}" fill="${fill}" stroke="#ffffff" stroke-width="6"/>
  <text x="${W / 2}" y="${cy + size * 0.36}" text-anchor="middle" font-family="Poppins" font-weight="800" font-size="${size}" fill="${color}">${esc(text)}</text>`;
}

/** Fetch a logo as a PNG data URI (ImageKit URLs are converted with tr=f-png). */
export async function logoDataUri(url) {
  if (!url) return null;
  try {
    const u = /ik\.imagekit\.io/.test(url) ? `${url.split('?')[0]}?tr=f-png,w-300` : url;
    const r = await fetch(u);
    if (!r.ok) return null;
    const type = r.headers.get('content-type') || '';
    if (!/png|jpe?g/.test(type)) return null;
    return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
  } catch { return null; }
}

/**
 * lines: { line1: "CBSE Class 10", line2: "Question Paper", year: "2024" }
 * Returns a PNG Buffer (1200×675).
 */
export function renderFeatureImage({ line1, line2, year }, logo) {
  const titleY = logo ? 395 : 300;
  const dots = Array.from({ length: 20 }, (_, i) => `<circle cx="${1010 + (i % 5) * 26}" cy="${70 + Math.floor(i / 5) * 26}" r="5" fill="#ffffff" opacity="0.9"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eef4fb"/><stop offset="1" stop-color="#dbe8f6"/></linearGradient>
    <linearGradient id="blue" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3fa9f5"/><stop offset="1" stop-color="#1d6fe0"/></linearGradient>
    <clipPath id="circle"><circle cx="${W / 2}" cy="165" r="105"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <path d="M0 0 H520 C430 40 330 90 230 170 C150 230 70 250 0 250 Z" fill="${YELLOW}" opacity="0.95"/>
  <path d="M${W} 0 V430 C1080 380 980 300 930 170 C900 90 880 30 860 0 Z" fill="url(#blue)"/>
  ${dots}
  <path d="M0 ${H} V560 C120 600 260 640 420 ${H} Z" fill="${NAVY}" opacity="0.08"/>
  <path d="M${W} ${H} V580 C1080 610 950 650 860 ${H} Z" fill="${PINK}" opacity="0.12"/>
  <image href="${SYU_ICON}" x="34" y="30" width="72" height="72"/>
  <text x="114" y="74" font-family="Poppins" font-weight="800" font-size="42" fill="${NAVY}">SELECT</text>
  <text x="116" y="100" font-family="Poppins" font-weight="700" font-size="17" fill="${PINK}">YOUR UNIVERSITY</text>
  ${logo ? `<circle cx="${W / 2}" cy="165" r="115" fill="#ffffff" stroke="${NAVY}" stroke-opacity="0.12" stroke-width="4"/>
  <image href="${logo}" x="${W / 2 - 90}" y="75" width="180" height="180" preserveAspectRatio="xMidYMid meet" clip-path="url(#circle)"/>` : ''}
  ${pill(line1, titleY, { fill: NAVY, color: '#ffffff', maxSize: 86 })}
  ${line2 ? pill(line2, titleY + 118, { fill: YELLOW, color: NAVY, maxSize: 78 }) : ''}
  ${year ? pill(year, titleY + (line2 ? 225 : 118), { fill: RED, color: '#ffffff', maxSize: 66, maxW: 360 }) : ''}
</svg>`;
  return new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Poppins' }, fitTo: { mode: 'width', value: W } }).render().asPng();
}
