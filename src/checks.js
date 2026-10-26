import * as cheerio from 'cheerio';

// The lead form every CTA box links to. CTA text changes per article, the link does not.
const CTA_FORM = /lp\.selectyouruniversity\.com\/syu-leads-form/i;
// Links to these sites usually mean content was copied and must not go live.
const COMPETITORS = new RegExp((process.env.COMPETITOR_DOMAINS || 'shiksha.com,collegedunia.com,careers360.com,collegedekho.com,getmyuni.com,jagranjosh.com,leverageedu.com')
  .split(',').map((d) => d.trim().replace(/\./g, '\\.')).join('|'), 'i');
const SITE_HOST =/(^\/(?!\/)|selectyouruniversity\.com)/i;
const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'to', 'in', 'on', 'with', 'is', 'how', 'what', 'your', 'best', 'top', 'get', 'free']);

const toList = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap((x) => toList(typeof x === 'object' ? (x.keyword ?? x.value ?? x.name) : x));
  return String(v).split(/[,\n|]/).map((s) => s.trim()).filter(Boolean);
};
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const has = (text, kw) => !!kw && norm(text).includes(norm(kw));

/** CTA text that names none of the article's topic words (CBSE article → CBSE CTA, CAT article → CAT CTA). */
export function ctaOffTopic(ctaText, primary, title) {
  const topicWords = norm(`${primary || ''} ${title || ''}`).split(' ').filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  return !topicWords.some((w) => norm(ctaText).split(' ').includes(w));
}

/** CTAs a college/exam/course silo needs for its length. */
export const ctaTarget = (words) => (words < 600 ? 1 : words < 1500 ? 2 : 3);

/** Today's date in India (YYYY-MM-DD); the CMS stores dates as IST midnight. */
export const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const dayIST = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * Runs the SEO checklist on one blog page.
 * page: { title, metaTitle, metaDescription, primaryKeywords, secondaryKeywords, pageUrl, html, heroImage }
 * Returns { status: 'pass' | 'fail', score, checks: [{ id, label, level: 'pass'|'warn'|'fail', detail }] }
 */
export function runChecks(page, rules = {}) {
  const r = { minCta: 2, maxCta: 3, minWords: 600, metaTitleMax: 60, metaDescMin: 120, metaDescMax: 160, images: true, ...rules };
  const $ = cheerio.load(page.html || '');
  const checks = [];
  const add = (id, label, level, detail) => checks.push({ id, label, level, detail });

  const primary = toList(page.primaryKeywords)[0] || '';
  const bodyText = $.root().text().replace(/\s+/g, ' ').trim();
  const words = bodyText ? bodyText.split(' ').length : 0;
  if (r.ctaByLength) r.minCta = ctaTarget(words);

  // 1. CTA boxes: one box = the table (or heading/paragraph) holding links to the lead form.
  const boxes = new Set();
  $('a').filter((_, a) => CTA_FORM.test($(a).attr('href') || '')).each((_, a) => {
    const box = $(a).closest('table').get(0) || $(a).closest('h1,h2,h3,h4,p,li,div').get(0);
    if (box) boxes.add(box);
  });
  const ctaTexts = [...boxes].map((b) => $(b).text().replace(/[☎️\s]+/gu, ' ').trim());
  const ctaCount = boxes.size;
  if (r.requireCta !== false) add('cta-count', `CTA form ${r.minCta}–${r.maxCta} times`,
    ctaCount >= r.minCta && ctaCount <= r.maxCta ? 'pass' : 'fail',
    `Found ${ctaCount} CTA box(es) linking to the lead form` + (ctaTexts[0] ? `: "${ctaTexts[0]}"` : ''));

  // 2. CTA text should be about this article's topic (CBSE article → CBSE CTA, CAT article → CAT CTA).
  if (ctaCount && r.requireCta !== false) {
    const off = ctaTexts.filter((t) => ctaOffTopic(t, primary, page.title));
    add('cta-topic', 'CTA text matches article topic', off.length ? 'warn' : 'pass',
      off.length ? `CTA may be copied from another article: "${off[0]}"` : 'CTA text mentions the article topic');
    // Short CTA, one phone icon each side, an empty line above and below.
    const long = ctaTexts.find((t) => t.length > 60);
    const icons = [...boxes].find((b) => ($(b).text().match(/☎/g) || []).length > 2);
    const blank = (el) => !!el && el.tagName === 'p' && !$(el).text().trim() && !$(el).find('img').length;
    const tight = [...boxes].filter((b) => b.tagName === 'table' && !(blank($(b).prev().get(0)) && blank($(b).next().get(0)))).length;
    const narrow = [...boxes].filter((b) => b.tagName === 'table' && !$(b).find('colgroup').length).length;
    add('cta-style', 'CTA full width, short, one ☎️ each side, space around', long || icons || tight || narrow ? 'warn' : 'pass',
      narrow ? `${narrow} CTA box(es) not full width` : long ? `CTA is ${long.length} characters (max 60): "${long}"`
        : icons ? 'CTA has more than one phone icon on a side' : tight ? `${tight} CTA box(es) without an empty line above and below` : 'OK');
  }

  // 3. Meta title
  const mt = (page.metaTitle || '').trim();
  if (!mt) add('meta-title', 'Meta title', 'fail', 'Meta title is empty');
  else add('meta-title', 'Meta title', mt.length > r.metaTitleMax ? 'warn' : 'pass',
    `${mt.length} characters (max ${r.metaTitleMax})`);
  if (mt && primary) add('meta-title-kw', 'Primary keyword in meta title', has(mt, primary) ? 'pass' : 'warn',
    has(mt, primary) ? `Contains "${primary}"` : `"${primary}" not found in meta title`);

  // 4. Meta description
  const md = (page.metaDescription || '').trim();
  if (!md) add('meta-desc', 'Meta description', 'fail', 'Meta description is empty');
  else add('meta-desc', 'Meta description', md.length < r.metaDescMin || md.length > r.metaDescMax ? 'warn' : 'pass',
    `${md.length} characters (target ${r.metaDescMin}–${r.metaDescMax})`);

  // 5. Primary keyword
  if (!primary) add('primary-kw', 'Primary keyword set', 'fail', 'No primary keyword on this page');
  else {
    const first100 = bodyText.split(' ').slice(0, 100).join(' ');
    add('kw-intro', 'Primary keyword in first 100 words', has(first100, primary) ? 'pass' : 'warn',
      has(first100, primary) ? `"${primary}" found in intro` : `"${primary}" missing from intro`);
    const hits = norm(bodyText).split(norm(primary)).length - 1;
    const density = words ? (hits * norm(primary).split(' ').length * 100) / words : 0;
    add('kw-density', 'Keyword density', density < 0.3 || density > 3 ? 'warn' : 'pass',
      `"${primary}" used ${hits} time(s), ${density.toFixed(2)}% (target 0.3–3%)`);
  }

  // 6. Headings
  const h2 = $('h2').filter((_, h) => !$(h).find('a').filter((_, a) => CTA_FORM.test($(a).attr('href') || '')).length).length;
  add('h2', 'H2 subheadings', h2 >= 2 ? 'pass' : 'fail', `${h2} H2 heading(s) (excluding CTAs)`);
  const h1 = $('h1').length;
  if (h1) add('h1', 'No extra H1 in body', 'warn', `${h1} H1 in body — page title is already the H1`);
  // The agent never edits the H1, so a stale year there is for the writer to fix.
  const staleYear = (String(page.title || '').match(/\b20\d\d\b/g) || []).find((y) => !bodyText.includes(y));
  if (staleYear) add('h1-year', 'H1 year matches content', 'warn', `H1 says ${staleYear} but the article never mentions it — writer to update the H1`);

  // 7. Length
  add('words', 'Word count', words >= r.minWords ? 'pass' : words >= r.minWords / 2 ? 'warn' : 'fail',
    `${words} words (min ${r.minWords}` + (r.sample ? `, published pages like this average ${r.medianWords})` : ')'));

  // 8. Images — blogs only; college/exam/course pages carry no images.
  if (r.images) {
    const imgs = $('img');
    const noAlt = imgs.filter((_, i) => !($(i).attr('alt') || '').trim()).length;
    add('img-alt', 'Image alt text', noAlt ? 'fail' : 'pass',
      imgs.length ? `${imgs.length - noAlt}/${imgs.length} images have alt text` : 'No images in body');
  }

  // 9. Links
  const links = $('a').map((_, a) => $(a).attr('href') || '').get();
  const internal = links.filter((h) => SITE_HOST.test(h) && !CTA_FORM.test(h)).length;
  add('internal-links', 'Internal links', internal >= 2 ? 'pass' : 'warn', `${internal} internal link(s) (min 2)`);
  const rivals = links.filter((h) => COMPETITORS.test(h));
  if (rivals.length) add('competitor-links', 'No competitor links', 'fail',
    `${rivals.length} link(s) to competitor sites: ${[...new Set(rivals.map((h) => h.match(COMPETITORS)[0]))].join(', ')}`);
  // A line that is only a link ("Check the SSC Result here") starts with 👉.
  const bare = $('p, h2, h3, h4').filter((_, p) => {
    const a = $(p).find('a');
    if (a.length !== 1 || CTA_FORM.test(a.attr('href') || '') || $(p).closest('table').length) return false;
    const t = $(p).text().replace(/\s+/g, ' ').trim();
    return !!t && t === a.text().replace(/\s+/g, ' ').trim() && !t.includes('👉');
  }).length;
  if (bare) add('link-pointer', '👉 before link lines', 'warn', `${bare} line(s) that are only a link without 👉`);
  const broken = links.filter((h) => !h.trim() || h.trim() === '#' || /^javascript:/i.test(h)).length;
  if (broken) add('empty-links', 'Empty links', 'fail', `${broken} link(s) with empty or "#" href`);

  // 10. URL slug — an update task's page is already live, so its URL is never changed.
  const slug = (page.pageUrl || '').split('/').filter(Boolean).pop() || '';
  if (page.isUpdate) add('slug', 'URL slug', 'pass', `Update task — URL kept as is${page.liveUrl ? ` (live: ${page.liveUrl})` : ''}`);
  else if (!slug) add('slug', 'URL slug', 'fail', 'Page URL is empty');
  else add('slug', 'URL slug', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 75 ? 'pass' : 'warn',
    `/${slug}` + (/[A-Z_ ]/.test(slug) ? ' — use lowercase and hyphens only' : ''));

  // 11. Hero image
  if (r.images && 'heroImage' in page) add('hero', 'Hero image', page.heroImage ? 'pass' : 'warn', page.heroImage ? 'Set' : 'No hero image');

  // 12. Date must be today; writer name must be set (blogs).
  if ('date' in page) add('date', 'Date is today', page.date && dayIST(page.date) === todayIST() ? 'pass' : 'fail',
    page.date ? `Date ${dayIST(page.date)} (today ${todayIST()})` : 'No date set');
  if ('authorName' in page) add('writer', 'Writer name', (page.authorName || '').trim() ? 'pass' : 'fail',
    (page.authorName || '').trim() || 'No writer name');

  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  // A pass scores 100; warnings are notes only and never block or change a passing article.
  const score = fails ? Math.max(0, Math.round(100 - fails * 15 - warns * 5)) : 100;
  return { status: fails ? 'fail' : 'pass', score, ctaCount, words, checks };
}

/** Short text written back to the CMS reviewMessage field. */
export function reviewMessage(result) {
  const issues = result.checks.filter((c) => c.level !== 'pass');
  if (!issues.length) return `SEO Agent: approved (score ${result.score}/100).`;
  return [`SEO Agent: ${result.status === 'pass' ? 'approved with notes' : 'needs changes'} (score ${result.score}/100)`,
    ...issues.map((c) => `${c.level === 'fail' ? '❌' : '⚠️'} ${c.label}: ${c.detail}`)].join('\n');
}
