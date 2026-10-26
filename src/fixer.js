import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as cheerio from 'cheerio';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getEntityLogo, searchBlogs, saveBlogDraft } from './cms.js';
import { runChecks, ctaOffTopic, todayIST } from './checks.js';
import { renderFeatureImage, logoDataUri } from './featureImage.js';

const CTA_URL = 'https://lp.selectyouruniversity.com/syu-leads-form/';
const COMPETITORS = /shiksha\.com|collegedunia\.com|careers360\.com|collegedekho\.com|getmyuni\.com|jagranjosh\.com|leverageedu\.com/i;
export const FIX_DIR = fileURLToPath(new URL('../data/fixes', import.meta.url));

// Created on first use so the dashboard still starts when no API key is set yet.
let client;

const FixPlan = z.object({
  metaTitle: z.string().describe('50–60 characters, contains the primary keyword near the start.'),
  metaDescription: z.string().describe('130–155 characters, contains the primary keyword, ends with a reason to click.'),
  slug: z.string().describe('lowercase-hyphenated URL slug with the main keyword, max 60 chars, no dates unless essential.'),
  ctaText: z.string().describe('CTA line about this article\'s title topic, e.g. "Start Your MBA Journey – Get FREE Expert Guidance for CAT 2026". No emoji.'),
  internalLinks: z.array(z.object({
    anchorText: z.string().describe('Exact phrase copied from the article text, 2–6 words.'),
    url: z.string().describe('One of the candidate URLs, unchanged.'),
  })).describe('2–4 links. Only use candidate URLs. Anchor must appear verbatim in the article.'),
  imageAlts: z.array(z.object({ index: z.number(), alt: z.string() })).describe('Alt text for each listed in-body image missing alt, 8–15 words, descriptive, includes the keyword where natural.'),
  featureImage: z.object({
    line1: z.string().describe('Main subject, max 16 chars, e.g. "CBSE Class 10" or "NMAT 2026".'),
    line2: z.string().describe('What it is about, max 18 chars, e.g. "Question Paper", "Admit Card Out".'),
    year: z.string().describe('Year or short tag, max 14 chars, e.g. "2026" or "Download Now".'),
  }),
});

const SYSTEM = `You are the SEO editor for SelectYourUniversity (SYU), an Indian education portal for exams, colleges and courses.
You fix blog drafts that failed SEO review. You only write meta title, meta description, URL slug, CTA text, internal links,
image alt text and feature image text — the article itself is never rewritten. Keep facts exactly as in the article — never invent dates, numbers or claims.
Write for Indian students and parents in clear, simple English. Follow every field description exactly.`;

const plainText = ($) => $.root().text().replace(/\s+/g, ' ').trim();

function ctaBlock(text) {
  return `<table class="editor-table"><tbody><tr><th class="editor-table-cell-header"><h2 class="editor-heading-h2" dir="ltr"><a class="editor-link" rel="noreferrer" href="${CTA_URL}"><span style="white-space: pre-wrap;">☎️ ${text} ☎️</span></a></h2></th></tr></tbody></table>`;
}

/** Wrap the first plain-text occurrence of `anchor` (outside existing links/headings) in a link. */
function addLink($, anchor, url) {
  let done = false;
  $('p, li').each((_, el) => {
    if (done) return;
    $(el).find('*').addBack().contents().each((_, node) => {
      if (done || node.type !== 'text' || $(node).closest('a, h1, h2, h3, h4').length) return;
      const i = node.data.toLowerCase().indexOf(anchor.toLowerCase());
      if (i < 0) return;
      const t = node.data;
      $(node).replaceWith(`${t.slice(0, i)}<a class="editor-link" href="${url}">${t.slice(i, i + anchor.length)}</a>${t.slice(i + anchor.length)}`);
      done = true;
    });
  });
  return done;
}

/**
 * Builds a fixed version of a failed blog draft. The article text and H1 are never changed;
 * an update task (page already live) also keeps its URL.
 * Returns { changes[], fields: { metaTitle, metaDescription, pageUrl, date, authorName, html }, imageFile, before, after, saved }
 */
export async function fixBlog(st, draft, before, { isUpdate = false, liveUrl = null, writer = null } = {}) {
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
  const candidates = (await searchBlogs(term).catch(() => [])).filter((c) => !c.url.endsWith(`/${draft.pageUrl}`));

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
H1 (fixed, do not change): ${draft.title}
Current meta title (${(draft.metaTitle || '').length} chars): ${draft.metaTitle}
Current meta description (${(draft.metaDescription || '').length} chars): ${draft.metaDescription}
Current slug: ${draft.pageUrl}

Failed / weak checks:
${before.checks.filter((c) => c.level !== 'pass').map((c) => `- ${c.label}: ${c.detail}`).join('\n')}

Internal link candidates (use only these URLs):
${candidates.map((c) => `- ${c.title} → ${c.url}`).join('\n') || '(none — return an empty list)'}

In-body images missing alt text:
${needAlt.map((i) => `- index ${i.index}: ${i.src} (text before it: "${i.near}")`).join('\n') || '(none — return an empty list)'}

Article text:
${plainText($)}`,
    }],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) throw new Error(`Claude could not produce a fix (${response.stop_reason})`);
  const plan = response.parsed_output;

  // 3. Internal links.
  for (const l of plan.internalLinks) {
    if (candidates.some((c) => c.url === l.url) && addLink($, l.anchorText, l.url)) changes.push(`Added internal link "${l.anchorText}" → ${l.url}`);
  }

  // 4. Alt text on in-body images.
  for (const { index, alt } of plan.imageAlts) {
    if (imgs[index] && !($(imgs[index]).attr('alt') || '').trim()) { $(imgs[index]).attr('alt', alt); changes.push(`Added alt text to image ${index + 1}: "${alt}"`); }
  }

  // 5. CTAs: CTAs that match the title stay as they are; off-topic ones get the new text.
  //    With fewer than 2, add up to 2 (3 for long articles) after the intro, mid-article and before the last section.
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
  const target = have >= 2 ? have : words > 1500 ? 3 : 2;
  const spots = [0.2, 0.55, 0.85].map((f) => blocks[Math.max(1, Math.floor(blocks.length * f))]).filter(Boolean);
  for (const spot of spots.slice(0, Math.max(0, target - have))) {
    $(spot).after(ctaBlock(plan.ctaText));
    changes.push(`Added CTA: "☎️ ${plan.ctaText} ☎️"`);
  }

  // 6. SEO fields. URL only for new pages; date is always today; writer only when missing.
  // Every change so far (links, alt text, CTAs) was to the article HTML.
  const fields = changes.length ? { html: $.html() } : {};
  const setField = (key, label, value) => { if (value && value !== draft[key]) { fields[key] = value; changes.push(`${label}: "${draft[key] || ''}" → "${value}"`); } };
  setField('metaTitle', 'Meta title', plan.metaTitle);
  setField('metaDescription', 'Meta description', plan.metaDescription);
  if (!isUpdate) setField('pageUrl', 'URL', plan.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''));
  if (before.checks.some((c) => c.id === 'date' && c.level !== 'pass')) {
    fields.date = new Date(`${todayIST()}T00:00:00+05:30`).toISOString();
    changes.push(`Date: ${draft.date ? draft.date.slice(0, 10) : '(none)'} → ${todayIST()}`);
  }
  if (!(draft.authorName || '').trim() && writer) setField('authorName', 'Writer', writer);

  // 7. Feature image.
  let imageFile = null;
  if (!draft.heroImage || before.checks.some((c) => c.id === 'hero' && c.level !== 'pass')) {
    const logo = await logoDataUri(await getEntityLogo(draft, term));
    mkdirSync(FIX_DIR, { recursive: true });
    imageFile = `${st.subTaskId}-feature.png`;
    writeFileSync(`${FIX_DIR}/${imageFile}`, renderFeatureImage(plan.featureImage, logo));
    changes.push(`Created feature image (alt: "${draft.title}")`);
  }

  const after = runChecks({ ...draft, ...fields, html: fields.html ?? draft.html, primaryKeywords: draft.primaryKeywords, heroImage: draft.heroImage || imageFile, isUpdate, liveUrl }, { images: true });
  // Only write to the CMS when explicitly enabled; otherwise the fix is shown on the dashboard to copy.
  const saved = process.env.SAVE_FIXES === 'true' && process.env.DRY_RUN !== 'true' && draft._parent
    ? await saveBlogDraft(draft._parent, fields) : false;
  return { changes, fields, imageFile, imageAlt: draft.title, isUpdate, before, after, saved, at: new Date().toISOString() };
}
