import * as cheerio from 'cheerio';
import { TYPES, tabHtml, listPublished } from './cms.js';

// Rules learnt from published content of the same type + tab, so short tabs
// (Exam Dates) and long ones (Overview) each get a fair word-count bar.
const CTA_FORM = /lp\.selectyouruniversity\.com\/syu-leads-form/i;
const cache = new Map();
const TTL = 6 * 60 * 60 * 1000;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

function measure(html) {
  const $ = cheerio.load(html || '');
  const words = $.root().text().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
  const boxes = new Set();
  $('a').filter((_, a) => CTA_FORM.test($(a).attr('href') || '')).each((_, a) => {
    boxes.add($(a).closest('table').get(0) || $(a).closest('h1,h2,h3,h4,p,li,div').get(0));
  });
  return { words, cta: boxes.size };
}

/** Returns { minWords, requireCta, sample, medianWords, medianCta } for a type/tab. */
export async function rulesFor(type, page) {
  const tab = type === 'blogs' ? 'blogContent' : String(page || '').split(':').pop();
  const key = `${type}:${tab}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.rules;

  const drafts = await listPublished(type, tab, 10).catch(() => []);
  const stats = drafts
    .map((d) => measure(type === 'blogs' ? d.html : tabHtml(d, tab)))
    .filter((s) => s.words > 30);

  const fallback = type === 'blogs' ? 600 : 250;
  const medianWords = median(stats.map((s) => s.words));
  const medianCta = median(stats.map((s) => s.cta));
  const rules = {
    ...TYPES[type].rules,
    sample: stats.length,
    medianWords,
    medianCta,
    // Below half the usual length for this tab → warn; below a quarter → fail.
    minWords: stats.length >= 5 ? Math.max(100, Math.round(medianWords * 0.5)) : fallback,
    // Require 2–3 CTAs only where published pages of this kind actually use them.
    requireCta: type === 'blogs' || (stats.length >= 5 && medianCta >= 1),
  };
  cache.set(key, { at: Date.now(), rules });
  return rules;
}
