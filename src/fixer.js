import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as cheerio from 'cheerio';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getEntityImages, searchBlogs, searchEntityPages, tabHtml, newSiloUrl } from './cms.js';
import { runChecks, ctaOffTopic, ctaTarget, todayIST } from './checks.js';
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
  ctaText: z.string().describe('CTA line about this article\'s title topic, e.g. "Start Your MBA Journey – Get FREE Expert Guidance for CAT 2026". No emoji.'),
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

function ctaBlock(text) {
  return `<table class="editor-table"><tbody><tr><th class="editor-table-cell-header"><h2 class="editor-heading-h2" dir="ltr"><a class="editor-link" rel="noreferrer" href="${CTA_URL}"><span style="white-space: pre-wrap;">☎️ ${text} ☎️</span></a></h2></th></tr></tbody></table>`;
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
  $('a').filter((_, a) => COMPETITORS.test($(a).attr('href') || '')).each((_, a) => {
    const text = $(a).text().trim();
    if (!text || COMPETITORS.test(text) || /^https?:/i.test(text)) $(a).remove(); else $(a).replaceWith(text);
    changes.push(`Removed competitor link: ${$(a).attr('href')}`);
  });
  $('p').filter((_, p) => !$(p).text().trim() && !$(p).find('img').length).remove();

  // 2. Ask Claude for the SEO fields.
  const imgs = $('img').toArray();
  const needAlt = imgs.map((img, index) => ({ index, src: $(img).attr('src'), near: $(img).closest('p, figure, div').prev().text().slice(0, 150) }))
    .filter(({ index }) => !($(imgs[index]).attr('alt') || '').trim());
  const term = primary.split(/\s+/).find((w) => w.length > 2 && /[A-Z]{2,}/.test(w)) || primary.split(/\s+/).slice(0, 2).join(' ');
  // Internal link targets: published blogs on the topic, plus the college/exam pages it names.
  const found = [];
  for (const t of new Set([term, primary])) found.push(...await searchBlogs(t, 20).catch(() => []));
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

  // 3. Internal links on exact keywords: where another published blog's keyword appears word-for-word
  //    in this article, link it (max 4, one per page, never on this article's own primary keyword).
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const linked = new Set($('a').map((_, a) => $(a).attr('href')).get());
  const pairs = candidates.flatMap((c) => keyPhrases(c.keywords).map((k) => ({ k, url: c.url })))
    .filter(({ k }) => !norm(primary).includes(norm(k)) && !norm(k).includes(norm(primary)))
    .sort((a, b) => b.k.length - a.k.length);
  // Then Claude's keyword anchors — only kept when the phrase is really in the article text.
  const suggested = plan.internalLinks.filter((l) => candidates.some((c) => c.url === l.url) && norm(l.anchorText) !== norm(primary))
    .map((l) => ({ k: l.anchorText, url: l.url }));  let added = 0;
  for (const { k, url } of [...pairs, ...suggested]) {
    if (added >= 4 || linked.has(url)) continue;
    const text = addLink($, k, url);
    if (text) { linked.add(url); added++; changes.push(`Added internal link "${text}" → ${url}`); }
  }

  // 4. Alt text on in-body images.
  for (const { index, alt } of plan.imageAlts) {
    if (imgs[index] && !($(imgs[index]).attr('alt') || '').trim()) { $(imgs[index]).attr('alt', alt); changes.push(`Added alt text to image ${index + 1}: "${alt}"`); }
  }

  // 5. CTAs: CTAs that match the title stay as they are; off-topic ones get the new text.
  //    Update task: add only when there is none. New page: top up to 2 (3 for long articles).
  //    New CTAs go after the intro, mid-article and before the last section.
  $('a[href*="syu-leads-form"]').each((_, a) => {
    const old = $(a).text().replace(/[☎️\s]+/gu, ' ').trim();
    if (!ctaOffTopic(old, primary, draft.title)) return;
    $(a).html(`<span style="white-space: pre-wrap;">☎️ ${plan.ctaText} ☎️</span>`);
    changes.push(`Changed off-topic CTA "${old}" → "${plan.ctaText}"`);
  });
  const isCta = (_, el) => $(el).find(`a[href*="syu-leads-form"]`).length > 0;
  const ctas = $.root().children().filter(isCta).toArray();
  const words = plainText($).split(' ').length;
  ctas.slice(3).forEach((c) => { $(c).remove(); changes.push('Removed extra CTA (max 3)'); });
  const blocks = $.root().children().toArray();
  const have = Math.min(ctas.length, 3);
  const target = have >= (isUpdate ? 1 : 2) ? have : words > 1500 ? 3 : 2;
  const spots = [0.2, 0.55, 0.85].map((f) => blocks[Math.max(1, Math.floor(blocks.length * f))]).filter(Boolean);
  for (const spot of spots.slice(0, Math.max(0, target - have))) {
    $(spot).after(ctaBlock(plan.ctaText));
    changes.push(`Added CTA: "☎️ ${plan.ctaText} ☎️"`);
  }

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

  // CTAs that don't match the page get the new text; matching ones stay.
  for (const s of sections) {
    const $ = cheerio.load(s.content.html, null, false);
    let changed = false;
    $('a[href*="syu-leads-form"]').each((_, a) => {
      const old = $(a).text().replace(/[☎️\s]+/gu, ' ').trim();
      if (!ctaOffTopic(old, primary, title)) return;
      $(a).html(`<span style="white-space: pre-wrap;">☎️ ${plan.ctaText} ☎️</span>`);
      changes.push(`Changed off-topic CTA "${old}" → "${plan.ctaText}"`);
      changed = true;
    });
    if (changed) s.content.html = $.html();
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
