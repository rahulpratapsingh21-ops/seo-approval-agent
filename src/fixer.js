import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as cheerio from 'cheerio';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getEntityImages, searchBlogs, searchEntityPages, tabHtml, newSiloUrl } from './cms.js';
import { runChecks, ctaOffTopic, ctaTarget, todayIST, isBareCta } from './checks.js';
import { renderFeatureImage, imageDataUri } from './featureImage.js';

const CTA_URL = 'https://lp.selectyouruniversity.com/syu-leads-form/';
const COMPETITORS = /shiksha\.com|collegedunia\.com|careers360\.com|collegedekho\.com|getmyuni\.com|jagranjosh\.com|leverageedu\.com/i;
export const FIX_DIR = fileURLToPath(new URL('../data/fixes', import.meta.url));

// Created on first use so the dashboard still starts when no API key is set yet.
let client;

const FixPlan = z.object({
  h1: z.string().describe('Page H1 (the title shown on the page), from the current content: starts with the primary keyword, uses the year the content is about, natural, max 70 characters.'),
  metaTitle: z.string().describe('50–60 characters, contains the primary keyword near the start.'),
  metaDescription: z.string().describe('130–155 characters, contains the primary keyword, ends with a reason to click.'),
  slug: z.string().describe('lowercase-hyphenated URL slug with the main keyword, max 60 chars, no dates unless essential.'),
  ctaText: z.string().describe('Short CTA line about this article\'s topic, 35–55 characters, e.g. "Get FREE Expert Guidance for PTU Results 2026". No emoji.'),
  internalLinks: z.array(z.object({
    anchorText: z.string().describe('Keyword phrase copied word-for-word from the article text (1–6 words) that names the target page\'s topic, e.g. "GSEB HSC exam" or "IKGPTU".'),
    url: z.string().describe('One of the candidate URLs, unchanged.'),
  })).describe('2–4 links, one per URL, only candidate URLs. For each related candidate, find the phrase in the article that names its topic (e.g. "GSEB HSC exam" for a GSEB HSC result page). Leave out candidates with no such phrase.'),
  imageAlts: z.array(z.object({ index: z.number(), alt: z.string() })).describe('Alt text for each listed in-body image missing alt, 8–15 words, descriptive, includes the keyword where natural.'),
  featureImage: z.object({
    line1: z.string().describe('Main title, max 26 chars, e.g. "Bharathidasan University" or "CAT Question Paper".'),
    line2: z.string().describe('What it is about, max 20 chars, e.g. "Results", "PDF With Solutions", "Admit Card".'),
    year: z.string().describe('The year the article is about, e.g. "2026"; empty if none.'),
    tags: z.array(z.string()).describe('2–5 short labels from the article for the book spines, max 8 chars each: courses (e.g. "BA", "B.Tech", "MBA"), classes ("SSC", "HSC") or sections ("VARC", "QA").'),
    screen: z.string().describe('1–2 words for the laptop screen, e.g. "Results", "Admit Card", "Answer Key".'),
  }).describe('Text for the feature image, taken from the article.'),
});

const SYSTEM = `You are the SEO editor for SelectYourUniversity (SYU), an Indian education portal for exams, colleges and courses.
You prepare the SEO fields for drafts in SEO review. You only write the H1, meta title, meta description, URL slug, CTA text,
image alt text and feature image text, based on the current content — the article body text is never rewritten. Keep facts exactly as in the article — never invent dates, numbers or claims.
Write for Indian students and parents in clear, simple English. Follow every field description exactly.`;

const plainText = ($) => $.root().text().replace(/\s+/g, ' ').trim();

// Same markup as the CTA boxes in published articles: full-width grey box, border, centred heading.
function ctaBlock(text) {
  return `<table><colgroup><col style="width: 1188px;"></colgroup><tbody><tr><th style="width: 75px; background-color: rgb(242, 243, 245); border: 1px solid black; vertical-align: top; text-align: start;"><h2 class="editor-heading-h2" dir="ltr" style="text-align: center;"><a href="${CTA_URL}" rel="noreferrer" class="editor-link"><span style="white-space: pre-wrap;">☎️ ${text} ☎️</span></a></h2></th></tr></tbody></table>`;
}

/**
 * Short linkable phrases from a page's keywords/title/slug: "GSEB HSC Result 2026 Announced: Check …"
 * → "GSEB HSC Result 2026"; "gujcet-result-2026" → "gujcet result 2026". Only phrases of 2+ words.
 */
function keyPhrases(keywords) {
  const out = new Set();
  for (const raw of keywords) {
    const k = String(raw).replace(/-/g, /\s/.test(raw) ? '-' : ' ');
    const head = k.split(/\s[:–|@(]|:\s|\s-\s/)[0].trim();
    for (const p of [head, head.replace(/\s+\b(out|declared|released|announced|today|soon|expected|live|updates?|check|now)\b.*$/i, '')]) {
      const s = p.replace(/[,.;]+$/, '').trim();
      if (s.split(/\s+/).length >= 2 && s.length >= 8) out.add(s);
    }
  }
  return [...out];
}

const CTA_MAX = 60;
// Internal links: keyword links are added up to LINK_TARGET; if that still leaves fewer than
// LINK_MIN, "Also Read" lines make up the difference.
const LINK_TARGET = 4;
const LINK_MIN = 3;
const ctaPlain = ($, a) => $(a).text().replace(/[☎️\s]+/gu, ' ').trim();

/**
 * Set a CTA link's text with exactly one phone icon on each side: older CTA boxes already have
 * ☎️ outside the link, so icons go inside the link only when the box has none.
 */
function setCtaText($, a, text) {
  $(a).html(`<span style="white-space: pre-wrap;">${text}</span>`);
  const box = $(a).closest('h1, h2, h3, h4, p, th, td').get(0) || a;
  if (!/☎/.test($(box).text())) $(a).html(`<span style="white-space: pre-wrap;">☎️ ${text} ☎️</span>`);
}

/**
 * Existing CTAs: off-topic or too long → new text; doubled phone icons → one each side; good ones stay.
 * Returns true when something changed.
 */
function tidyCtas($, ctaText, primary, title, changes) {
  let changed = false;
  // Narrow CTA boxes (a bare table without the editor's column width) → the full-width box, same text.
  $('table').filter((_, t) => $(t).find('a[href*="syu-leads-form"]').length > 0 && !$(t).find('colgroup').length).each((_, t) => {
    const text = ctaPlain($, $(t).find('a[href*="syu-leads-form"]').get(0));
    $(t).replaceWith(ctaBlock(text));
    changes.push(`CTA "${text}": full-width box`);
    changed = true;
  });
  $('a[href*="syu-leads-form"]').each((_, a) => {
    const old = ctaPlain($, a);
    const box = $(a).closest('h1, h2, h3, h4, p, th, td').get(0) || a;
    if (ctaOffTopic(old, primary, title) || old.length > CTA_MAX) {
      setCtaText($, a, ctaText);
      changes.push(`Changed CTA "${old}" → "${ctaText}"`);
      changed = true;
    } else if (($(box).text().match(/☎/g) || []).length > 2) {
      setCtaText($, a, old);
      changes.push(`CTA "${old}": one phone icon each side`);
      changed = true;
    }
  });
  return changed;
}

const isCtaBox = ($, el) => $(el).find('a[href*="syu-leads-form"]').length > 0 || /syu-leads-form/.test($(el).attr('href') || '');
// Previous / next element, skipping the empty lines kept around CTA boxes.
const prevContent = ($, el) => { let p = $(el).prev(); while (p.length && isGap($, p.get(0))) p = p.prev(); return p.get(0) || null; };

/** CTA lines written without the lead-form link become proper CTA boxes (own text kept when short and on topic). */
function linkBareCtas($, ctaText, primary, title, changes) {
  $.root().children().each((_, el) => {
    if (!isBareCta($, el)) return;
    const raw = $(el).text().replace(/\s+/g, ' ').trim();
    const old = raw.replace(/[☎️📞🎓👉]/gu, '').replace(/\s+/g, ' ').trim();
    const text = ctaOffTopic(old, primary, title) || old.length > CTA_MAX ? ctaText : old;
    $(el).replaceWith(ctaBlock(text));
    changes.push(`Added the form link to CTA "${old}"`);
  });
}

/**
 * The heading the "after the intro" CTA goes before: the first H2 with at least INTRO_WORDS of article
 * text above it. Some articles open with a short "Latest Updates" H2 before the intro, so the very
 * first H2 can sit above all the text. null when the article has no such H2.
 */
// A line that is only a link ("👉 Click here to check CSJMU Result Direct Link"), even when styled as a
// heading: it belongs to the text above it, so it is never a section boundary and CTAs go after it.
function isLinkLine($, el) {
  if (!/^(p|h2|h3|h4)$/.test(el.tagName) || isCtaBox($, el)) return false;
  const a = $(el).find('a');
  if (a.length !== 1) return false;
  const t = $(el).text().replace(/[👉\s]+/gu, ' ').trim();
  return !!t && t === a.text().replace(/\s+/g, ' ').trim();
}
const isSection = ($, el) => el.tagName === 'h2' && !isCtaBox($, el) && !isLinkLine($, el);

// CTAs need at least this much article text between them.
const CTA_GAP_WORDS = 150;
const wordsOf = ($, el) => (isCtaBox($, el) ? 0 : $(el).text().split(/\s+/).filter(Boolean).length);
function wordsBetween($, a, b) {
  const top = $.root().children().toArray();
  const [i, j] = [top.indexOf(a), top.indexOf(b)].sort((x, y) => x - y);
  return top.slice(i + 1, j).reduce((n, el) => n + wordsOf($, el), 0);
}

const INTRO_WORDS = 60;
// True when at least INTRO_WORDS of article text come before this element.
const hasTextBefore = ($, el) => $(el).prevAll().toArray().filter((x) => !isCtaBox($, x))
  .reduce((n, x) => n + $(x).text().split(/\s+/).filter(Boolean).length, 0) >= INTRO_WORDS;
function introBoundary($) {
  let words = 0;
  for (const el of $.root().children().toArray()) {
    if (isSection($, el) && words >= INTRO_WORDS) return el;
    words += wordsOf($, el);
  }
  return null;
}

const isImageOnly = ($, el) => /^(p|figure|div)$/.test(el.tagName) && !$(el).text().trim() && $(el).find('img').length > 0;

/**
 * Exact spot for the intro CTA: right after the last line of intro text (e.g. a "👉 … Direct Link" line),
 * ahead of any images or empty lines before the next heading. Returns the element to insert before.
 */
function introSpot($) {
  const heading = introBoundary($);
  if (!heading) return null;
  let el = $(heading).prev().get(0);
  while (el && (isGap($, el) || isImageOnly($, el) || isCtaBox($, el))) el = $(el).prev().get(0);
  return el ? $(el).next().get(0) : heading;
}

/**
 * Misplaced CTAs move to the right spot:
 * - right before a link line ("👉 Click here … Direct Link") → after it;
 * - above the intro (before any real text) → after the intro;
 * - right under a heading (before its text) → just before that heading;
 * - inside the FAQs → before the FAQs.
 * Then CTAs with less than CTA_GAP_WORDS of text between them are thinned out (the first one stays).
 */
function moveMisplacedCtas($, changes) {
  const top = () => $.root().children().toArray();
  const faq = top().find((el) => isSection($, el) && /faq|frequently asked/i.test($(el).text()));
  // Its own empty lines go with it; ctaGaps() adds fresh ones in the new place.
  const lift = (box) => {
    [$(box).prev().get(0), $(box).next().get(0)].filter((g) => isGap($, g)).forEach((g) => $(g).remove());
    const html = $.html(box);
    $(box).remove();
    return html;
  };
  for (const box of top().filter((el) => isCtaBox($, el))) {
    // Link lines right after the CTA: the CTA goes below the last of them.
    let next = $(box).next().get(0), lastLink = null;
    while (next && (isGap($, next) || isLinkLine($, next))) { if (isLinkLine($, next)) lastLink = next; next = $(next).next().get(0); }
    if (lastLink) {
      const html = lift(box);
      $(lastLink).after(html);
      changes.push(`Moved CTA after the link "${$(lastLink).text().replace(/\s+/g, ' ').trim().slice(0, 50)}"`);
      continue;
    }
    const intro = introBoundary($);
    if (intro && top().indexOf(box) < top().indexOf(intro) && !hasTextBefore($, box)) {
      const html = lift(box); // out first: it may sit where the intro spot is measured
      $(introSpot($) || intro).before(html);
      changes.push('Moved CTA from above the intro to after it');
      continue;
    }
    const prev = prevContent($, box);
    let target = null, why = '';
    if (prev && /^h[2-4]$/.test(prev.tagName) && !isCtaBox($, prev) && !isLinkLine($, prev)) { target = prev; why = `from under the heading "${$(prev).text().trim().slice(0, 50)}"`; }
    else if (faq && top().indexOf(box) > top().indexOf(faq)) { target = faq; why = 'out of the FAQs'; }
    if (!target) continue;
    const html = lift(box);
    $(target).before(html);
    changes.push(`Moved CTA ${why}`);
  }
  // Too close to the previous CTA (side by side, or only a short paragraph between): remove it.
  let kept = null;
  for (const box of top().filter((el) => isCtaBox($, el))) {
    if (kept && wordsBetween($, kept, box) < CTA_GAP_WORDS) {
      [$(box).next().get(0)].filter((g) => isGap($, g)).forEach((g) => $(g).remove());
      $(box).remove();
      changes.push(`Removed a CTA too close to the one before (under ${CTA_GAP_WORDS} words apart)`);
    } else kept = box;
  }
}

/**
 * Where CTAs belong in a blog, in order: after the intro (before the first H2), before a middle
 * section, before the FAQs. free = no CTA box there yet. Articles without H2s fall back to
 * evenly spaced blocks.
 */
function ctaSlots($) {
  const top = $.root().children().toArray();
  const h2s = top.filter((el) => isSection($, el));
  // A spot is free when no CTA is closer than CTA_GAP_WORDS of text to it.
  const ctas = top.filter((el) => isCtaBox($, el));
  const near = (el) => ctas.some((c) => wordsBetween($, c, el) + (top.indexOf(c) > top.indexOf(el) ? wordsOf($, el) : 0) < CTA_GAP_WORDS);
  if (!h2s.length) {
    return [0.2, 0.55, 0.85].map((f) => top[Math.max(1, Math.floor(top.length * f))]).filter(Boolean)
      .map((el, i) => ({ name: ['after the intro', 'mid-article', 'near the end'][i], before: el, free: !near(el) }));
  }
  const faq = h2s.find((h) => /faq|frequently asked/i.test($(h).text()));
  // After the intro = before the first H2 with real text above it (not an opening "Latest Updates" H2).
  const intro = introBoundary($) || h2s.find((h) => h !== faq) || h2s[0];
  const middle = h2s.filter((h) => h !== intro && h !== faq && top.indexOf(h) > top.indexOf(intro))
    .sort((a, b) => Math.abs(top.indexOf(a) - top.length / 2) - Math.abs(top.indexOf(b) - top.length / 2))[0];
  const introHasCta = top.slice(0, top.indexOf(intro)).some((el) => isCtaBox($, el) && hasTextBefore($, el));
  const spot = introSpot($) || intro;
  return [
    { name: 'after the intro', before: spot, free: !introHasCta && !near(spot) },
    middle && { name: 'mid-article', before: middle, free: !near(middle) },
    { name: faq ? 'before the FAQs' : 'before the last section', before: faq || h2s[h2s.length - 1], free: !near(faq || h2s[h2s.length - 1]) },
  ].filter((s, i, all) => s && all.findIndex((x) => x && x.before === s.before) === i);
}

/**
 * All CTA work on a blog's HTML ($ loaded as a fragment):
 * - CTA lines without the form link become CTA boxes; off-topic/long CTA text is rewritten;
 * - CTAs right under a heading or inside the FAQs move to the section boundary;
 * - count: a live blog with a CTA keeps its count, otherwise 2 (3 for long articles); max 3;
 *   every blog gets the CTA right after the intro;
 * - new CTAs go in order: after the intro, before a middle section, before the FAQs;
 * - an empty line above and below every CTA box.
 */
export function arrangeBlogCtas($, ctaText, { primary, title, isUpdate }, changes) {
  linkBareCtas($, ctaText, primary, title, changes);
  tidyCtas($, ctaText, primary, title, changes);
  const countCtas = () => $.root().children().filter((_, el) => isCtaBox($, el)).length;
  // The count is decided before moving/thinning, so a CTA removed for being too close is re-added in a better spot.
  const original = Math.min(countCtas(), 3);
  moveMisplacedCtas($, changes);
  $.root().children().filter((_, el) => isCtaBox($, el)).toArray().slice(3)
    .forEach((c) => { $(c).remove(); changes.push('Removed extra CTA (max 3)'); });
  const words = $.root().text().replace(/\s+/g, ' ').trim().split(' ').length;
  let target = isUpdate ? (original >= 1 ? original : 2) : Math.max(original, words > 1500 ? 3 : 2);
  const first = ctaSlots($);
  if (first[0]?.free && target === countCtas() && target < 3) target++;
  // One at a time, so each new CTA keeps its distance from the ones already placed.
  while (countCtas() < Math.min(target, 3)) {
    const slot = ctaSlots($).find((s) => s.free);
    if (!slot) break;
    $(slot.before).before(ctaBlock(ctaText));
    changes.push(`Added CTA ${slot.name}: "☎️ ${ctaText} ☎️"`);
  }
  const gaps = ctaGaps($);
  if (gaps) changes.push(`Added ${gaps} empty line(s) above/below CTAs`);
}

// Published articles have one empty line above and below each CTA box.
const GAP = '<p class="editor-paragraph"><br></p>';
const isGap = ($, el) => !!el && el.tagName === 'p' && !$(el).text().trim() && !$(el).find('img').length;

/** Add the empty line above/below every CTA box that lacks one. Returns how many lines were added. */
function ctaGaps($) {
  let added = 0;
  $('table').filter((_, t) => $(t).find('a[href*="syu-leads-form"]').length > 0).each((_, t) => {
    if (!isGap($, $(t).prev().get(0))) { $(t).before(GAP); added++; }
    if (!isGap($, $(t).next().get(0))) { $(t).after(GAP); added++; }
  });
  return added;
}

/**
 * A paragraph or heading that is only a link ("Check the SSC June 2026 Exam Results here") gets 👉 in front.
 * Links inside sentences, tables and CTAs are left as they are. Returns how many were marked.
 */
function pointLinks($) {
  let marked = 0;
  $('p, h2, h3, h4').each((_, p) => {
    const a = $(p).find('a');
    if (a.length !== 1 || /syu-leads-form/.test(a.attr('href') || '') || $(p).closest('table').length) return;
    const pText = $(p).text().replace(/\s+/g, ' ').trim();
    if (!pText || pText !== a.text().replace(/\s+/g, ' ').trim() || pText.includes('👉')) return;
    a.before('<span style="white-space: pre-wrap;">👉 </span>');
    marked++;
  });
  return marked;
}

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Link the first whole-word occurrence of `anchor` in a paragraph or list item (outside links, headings and CTA boxes).
 * The editor splits text over bold/span pieces, so a phrase may cross several text nodes: each piece of it is
 * wrapped in a link to the same URL, which reads as one link. Returns the linked text, or null.
 */
function addLink($, anchor, url) {
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${anchor.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')})(?=$|[^\\p{L}\\p{N}])`, 'iu');
  for (const el of $('p, li').toArray()) {
    if ($(el).closest('a, h1, h2, h3, h4').length || $(el).closest('table').find('a[href*="syu-leads-form"]').length) continue;
    // Text nodes in reading order; an existing link breaks the run so a match can't span it.
    const texts = [];
    const collect = (n) => {
      for (const c of n.children || []) {
        if (c.type === 'text') texts.push(c);
        else if (c.type === 'tag') { if (/^(a|h[1-4])$/.test(c.name)) texts.push(null); else collect(c); }
      }
    };
    collect(el);
    const m = texts.map((t) => (t ? t.data : '\u0000')).join('').match(re);
    if (!m) continue;
    const start = m.index + m[1].length, end = start + m[2].length;
    let pos = 0;
    for (const t of texts) {
      const from = pos;
      pos += t ? t.data.length : 1;
      const s = Math.max(start, from), e = Math.min(end, pos);
      if (!t || s >= e) continue;
      const d = t.data;
      $(t).replaceWith(`${escHtml(d.slice(0, s - from))}<a class="editor-link" href="${url}">${escHtml(d.slice(s - from, e - from))}</a>${escHtml(d.slice(e - from))}`);
    }
    return m[2];
  }
  return null;
}

/**
 * Prepares a blog draft for Submit. The article body text is never changed.
 * Always: H1, meta title + description from the current content, a new feature image, internal links on exact keywords.
 * Update task (URL live): URL kept; CTAs added only when there are none.
 * New page: URL from the content; CTAs topped up to 2 (3 for long articles).
 * Returns { changes[], fields: { metaTitle, metaDescription, pageUrl, date, authorName, html }, imageFile, before, after }
 */
export async function fixBlog(st, draft, before, { isUpdate = false, liveUrl = null, writer = null, rules = {} } = {}) {
  const $ = cheerio.load(draft.html || '', null, false);
  const changes = [];
  const primary = (Array.isArray(draft.primaryKeywords) ? draft.primaryKeywords[0] : draft.primaryKeywords) || st.title;

  // 1. Competitor links: keep the words, drop the link; remove link-only blocks.
  //    Only paragraphs emptied here are removed; the writer's blank lines stay.
  $('a').filter((_, a) => COMPETITORS.test($(a).attr('href') || '')).each((_, a) => {
    const text = $(a).text().trim();
    const p = $(a).closest('p');
    if (!text || COMPETITORS.test(text) || /^https?:/i.test(text)) $(a).remove(); else $(a).replaceWith(text);
    if (p.length && !p.text().trim() && !p.find('img').length) p.remove();
    changes.push(`Removed competitor link: ${$(a).attr('href')}`);
  });

  // 2. Ask Claude for the SEO fields.
  const imgs = $('img').toArray();
  const needAlt = imgs.map((img, index) => ({ index, src: $(img).attr('src'), near: $(img).closest('p, figure, div').prev().text().slice(0, 150) }))
    .filter(({ index }) => !($(imgs[index]).attr('alt') || '').trim());
  const term = primary.split(/\s+/).find((w) => w.length > 2 && /[A-Z]{2,}/.test(w)) || primary.split(/\s+/).slice(0, 2).join(' ');
  // Internal link targets: published blogs on the topic (main term, primary and secondary keywords),
  // plus the college/exam pages it names.
  const secondary = (Array.isArray(draft.secondaryKeywords) ? draft.secondaryKeywords : []).filter((k) => typeof k === 'string').slice(0, 2);
  // Topic without the board/college name ("CGBSE Time Table 2027" → "Time Table 2027") finds sibling articles
  // (other boards' time tables) for "Also Read" when the subject itself has few published pages.
  const topic = primary.split(/\s+/).slice(1).join(' ');
  const found = [];
  for (const t of new Set([term, primary, ...secondary])) found.push(...await searchBlogs(t, 20).catch(() => []));
  if (topic.split(' ').length >= 2) found.push(...await searchBlogs(topic, 10).catch(() => []));
  found.push(...await searchEntityPages(term).catch(() => []));
  const candidates = found.filter((c, i) => !c.url.endsWith(`/${draft.pageUrl}`) && found.findIndex((x) => x.url === c.url) === i);

  client ??= new Anthropic();
  const response = await client.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: 'medium', format: zodOutputFormat(FixPlan) },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Fix this blog draft.
${isUpdate ? `This is an UPDATE of a live page${liveUrl ? ` (${liveUrl})` : ''}: the URL stays as it is, return the current slug unchanged.` : 'This is a NEW page.'}

Primary keyword: ${primary}
Current H1: ${draft.title}
Current meta title (${(draft.metaTitle || '').length} chars): ${draft.metaTitle}
Current meta description (${(draft.metaDescription || '').length} chars): ${draft.metaDescription}
Current slug: ${draft.pageUrl}

Failed / weak checks:
${before.checks.filter((c) => c.level !== 'pass').map((c) => `- ${c.label}: ${c.detail}`).join('\n') || '(none)'}

Internal link candidates (use only these URLs; never this article's own primary keyword as anchor):
${candidates.map((c) => `- ${c.title} → ${c.url}`).join('\n') || '(none — return an empty list)'}

In-body images missing alt text:
${needAlt.map((i) => `- index ${i.index}: ${i.src} (text before it: "${i.near}")`).join('\n') || '(none — return an empty list)'}

Article text:
${plainText($)}`,
    }],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) throw new Error(`Claude could not produce a fix (${response.stop_reason})`);
  const plan = response.parsed_output;

  // 3. Internal links, only when the article has fewer than LINK_TARGET: first where another published
  //    blog's keyword appears word-for-word, then Claude's anchors (one per page, never on this
  //    article's own primary keyword).
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const linked = new Set($('a').map((_, a) => $(a).attr('href')).get());
  const existing = $('a').filter((_, a) => /^\/(?!\/)|selectyouruniversity\.com/i.test($(a).attr('href') || '') && !isCtaBox($, a)).length;
  const room = Math.max(0, LINK_TARGET - existing);
  const pairs = candidates.flatMap((c) => keyPhrases(c.keywords).map((k) => ({ k, url: c.url })))
    .filter(({ k }) => !norm(primary).includes(norm(k)) && !norm(k).includes(norm(primary)))
    .sort((a, b) => b.k.length - a.k.length);
  // Then Claude's keyword anchors — only kept when the phrase is really in the article text.
  // Website addresses ("cgbse.nic.in") are never anchors for our own pages.
  const suggested = plan.internalLinks.filter((l) => candidates.some((c) => c.url === l.url) && norm(l.anchorText) !== norm(primary)
    && !/^https?:|\b[\w-]+\.(com|in|org|net|gov|nic|edu|ac)\b/i.test(l.anchorText))
    .map((l) => ({ k: l.anchorText, url: l.url }));
  let added = 0;
  for (const { k, url } of [...pairs, ...suggested]) {
    if (added >= room || linked.has(url)) continue;
    const text = addLink($, k, url);
    if (text) { linked.add(url); added++; changes.push(`Added internal link "${text}" → ${url}`); }
  }
  //    Still under LINK_MIN: "👉 Also Read: <related title>" lines before later sections (article text untouched).
  const extra = candidates.filter((c) => !linked.has(c.url) && c.title).slice(0, Math.max(0, LINK_MIN - existing - added));
  if (extra.length) {
    const sections = $.root().children('h2').toArray().filter((h) => !isCtaBox($, h) && !/faq|frequently asked/i.test($(h).text())).slice(1);
    extra.forEach((c, i) => {
      const at = sections[Math.floor(((i + 1) * sections.length) / (extra.length + 1))];
      const line = `<p class="editor-paragraph" dir="ltr"><span style="white-space: pre-wrap;">👉 Also Read: </span><a href="${c.url}" class="editor-link"><span style="white-space: pre-wrap;">${escHtml(c.title)}</span></a></p>`;
      if (at) $(at).before(line); else $.root().append(line);
      linked.add(c.url);
      changes.push(`Added "Also Read" link → ${c.url}`);
    });
  }

  // 4. Alt text on in-body images.
  for (const { index, alt } of plan.imageAlts) {
    if (imgs[index] && !($(imgs[index]).attr('alt') || '').trim()) { $(imgs[index]).attr('alt', alt); changes.push(`Added alt text to image ${index + 1}: "${alt}"`); }
  }

  // 5. CTAs (see arrangeBlogCtas) and 👉 before link lines.
  arrangeBlogCtas($, plan.ctaText, { primary, title: plan.h1 || draft.title, isUpdate }, changes);
  const pointed = pointLinks($);
  if (pointed) changes.push(`Added 👉 before ${pointed} standalone link line(s)`);

  // 6. SEO fields. URL only for new pages; date is always today; writer only when missing.
  // Every change so far (links, alt text, CTAs) was to the article HTML.
  const fields = changes.length ? { html: $.html() } : {};
  const setField = (key, label, value) => { if (value && value !== draft[key]) { fields[key] = value; changes.push(`${label}: "${draft[key] || ''}" → "${value}"`); } };
  setField('title', 'H1', plan.h1);
  setField('metaTitle', 'Meta title', plan.metaTitle);
  setField('metaDescription', 'Meta description', plan.metaDescription);
  if (!isUpdate) setField('pageUrl', 'URL', plan.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''));
  const h1 = fields.title || draft.title;
  if (before.checks.some((c) => c.id === 'date' && c.level !== 'pass')) {
    fields.date = new Date(`${todayIST()}T00:00:00+05:30`).toISOString();
    changes.push(`Date: ${draft.date ? draft.date.slice(0, 10) : '(none)'} → ${todayIST()}`);
  }
  if (!(draft.authorName || '').trim() && writer) setField('authorName', 'Writer', writer);

  // 7. New feature image (uploaded and set as hero image on Submit).
  //    Logo and campus photo come from the college/exam the article is about.
  const pics = await getEntityImages(draft, `${primary} ${draft.title}`).catch(() => ({}));
  const images = {
    logo: await imageDataUri(pics.logo, { format: 'png', width: 300 }),
    photo: await imageDataUri(pics.cover, { format: 'jpg', width: 1200 }),
  };
  mkdirSync(FIX_DIR, { recursive: true });
  const imageFile = `${st.subTaskId}-feature.png`;
  writeFileSync(`${FIX_DIR}/${imageFile}`, renderFeatureImage(plan.featureImage, images));
  changes.push(`Created new feature image (alt: "${h1}")`);

  const after = runChecks({ ...draft, ...fields, html: fields.html ?? draft.html, primaryKeywords: draft.primaryKeywords, heroImage: imageFile, isUpdate, liveUrl }, rules);
  // Nothing is written here; Submit on the dashboard saves these fields and approves.
  return { changes, fields, imageFile, imageAlt: h1, isUpdate, before, after, at: new Date().toISOString() };
}

const SiloPlan = FixPlan.pick({ h1: true, metaTitle: true, metaDescription: true, ctaText: true });
const isVideo = ($, el) => $(el).is('iframe, video, embed, object') || $(el).find('iframe, video, embed, object').length > 0;

/**
 * Fixes a college/exam/course silo: H1 (page display title), meta title and description from the current content,
 * CTAs by content length, and a URL only when the silo is new. Text and videos are never changed;
 * only sections that get a CTA are re-saved.
 * Returns { changes[], fields: { pageDisplayTitle, metaTitle, metaDescription, pageUrl, <tab> }, before, after }
 */
export async function fixSilo(st, draft, before, { isUpdate = false, liveUrl = null, rules = {} } = {}) {
  const changes = [];
  const tabKey = String(draft.page || st.page).split(':').pop();
  const tab = structuredClone(draft[tabKey] || {});
  const primary = (Array.isArray(draft.primaryKeywords) ? draft.primaryKeywords[0] : draft.primaryKeywords) || draft.entity || st.title;
  const title = draft.pageDisplayTitle || draft.entity || st.title;
  const text = cheerio.load(tabHtml(draft, st.page)).root().text().replace(/\s+/g, ' ').trim();

  client ??= new Anthropic();
  const response = await client.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 4000,
    output_config: { effort: 'medium', format: zodOutputFormat(SiloPlan) },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Write the H1, meta title, meta description and CTA line for this ${st.contentCategory.replace(/s$/, '')} page ("${tabKey}" section of ${draft.entity}).
Base them on the content below; use years and facts exactly as the content has them.

Primary keyword: ${primary}
Current H1: ${title}
Current meta title (${(draft.metaTitle || '').length} chars): ${draft.metaTitle}
Current meta description (${(draft.metaDescription || '').length} chars): ${draft.metaDescription}

Failed / weak checks:
${before.checks.filter((c) => c.level !== 'pass').map((c) => `- ${c.label}: ${c.detail}`).join('\n')}

Page content:
${text.slice(0, 40000)}`,
    }],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) throw new Error(`Claude could not produce a fix (${response.stop_reason})`);
  const plan = response.parsed_output;

  // Visible sections of this silo, in page order (same walk as tabHtml).
  const sections = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.showOnWebsite === false) return;
    if (node.sectionDisplayTitle && node.content?.html?.trim()) sections.push(node);
    for (const [k, v] of Object.entries(node)) if (k !== 'content') walk(v);
  };
  walk(tab);

  // More than 3 CTA boxes: keep the first 3 in page order.
  let kept = 0;
  for (const s of sections) {
    const $ = cheerio.load(s.content.html, null, false);
    const boxes = new Set();
    $('a[href*="syu-leads-form"]').each((_, a) => boxes.add($(a).closest('table').get(0) || $(a).closest('h1,h2,h3,h4,p,li,div').get(0) || a));
    const extra = [...boxes].filter(() => ++kept > 3);
    if (!extra.length) continue;
    extra.forEach((b) => $(b).remove());
    s.content.html = $.html();
    changes.push(`Removed ${extra.length} extra CTA(s) in "${s.sectionDisplayTitle}" (max 3)`);
  }

  // CTAs that don't match the page (or are too long) get the new text; matching ones stay.
  for (const s of sections) {
    const $ = cheerio.load(s.content.html, null, false);
    const changesBefore = changes.length;
    linkBareCtas($, plan.ctaText, primary, plan.h1 || title, changes);
    tidyCtas($, plan.ctaText, primary, plan.h1 || title, changes);
    if (changes.length > changesBefore) s.content.html = $.html();
  }

  // Missing CTAs: spread over the longest sections without one (several per section if needed),
  // at even points between paragraphs — never inside a video.
  const missing = Math.max(0, ctaTarget(before.words) - Math.min(before.ctaCount, 3));
  const free = sections.filter((s) => !/syu-leads-form/.test(s.content.html));
  const pool = (free.length ? free : sections).sort((a, b) => b.content.html.length - a.content.html.length);
  const perSection = new Map();
  for (let i = 0; i < missing && pool.length; i++) perSection.set(pool[i % pool.length], (perSection.get(pool[i % pool.length]) || 0) + 1);
  for (const [s, k] of perSection) {
    const $ = cheerio.load(s.content.html, null, false);
    const blocks = $.root().children().toArray().filter((el) => !isVideo($, el));
    for (let j = k; j >= 1; j--) {
      const at = blocks[Math.floor((blocks.length * j) / (k + 1))];
      if (at) $(at).after(ctaBlock(plan.ctaText)); else $.root().append(ctaBlock(plan.ctaText));
    }
    s.content.html = $.html();
    changes.push(`Added ${k} CTA(s) in "${s.sectionDisplayTitle}": "☎️ ${plan.ctaText} ☎️"`);
  }

  // Empty line above and below every CTA box; 👉 before standalone link lines.
  for (const s of sections) {
    const $ = cheerio.load(s.content.html, null, false);
    const gaps = ctaGaps($), pointed = pointLinks($);
    if (!gaps && !pointed) continue;
    s.content.html = $.html();
    if (gaps) changes.push(`Added ${gaps} empty line(s) around CTAs in "${s.sectionDisplayTitle}"`);
    if (pointed) changes.push(`Added 👉 before ${pointed} link line(s) in "${s.sectionDisplayTitle}"`);
  }

  const fields = changes.length ? { [tabKey]: tab } : {};
  const setField = (key, label, value) => { if (value && value !== draft[key]) { fields[key] = value; changes.push(`${label}: "${draft[key] || ''}" → "${value}"`); } };
  setField('pageDisplayTitle', 'H1', plan.h1);
  setField('metaTitle', 'Meta title', plan.metaTitle);
  setField('metaDescription', 'Meta description', plan.metaDescription);
  if (!isUpdate) setField('pageUrl', 'URL', await newSiloUrl(st.contentCategory, draft));

  const merged = { ...draft, ...fields };
  const after = runChecks({ title: merged.pageDisplayTitle || title, metaTitle: merged.metaTitle, metaDescription: merged.metaDescription, primaryKeywords: draft.primaryKeywords,
    pageUrl: merged.pageUrl, html: tabHtml(merged, st.page), isUpdate, liveUrl }, rules);
  return { changes, fields, isUpdate, before, after, at: new Date().toISOString() };
}
