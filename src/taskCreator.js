import * as cheerio from 'cheerio';
import { cmsGet, cmsCreate, getMe, qs } from './cms.js';
import { readRows, writeTaskId } from './sheets.js';

const SITE = 'https://www.selectyouruniversity.com';

// Silos (subtask pages) per content type, with the URL segment each one lives under.
export const SILOS = {
  colleges: [['overview', 'Overview', ''], ['coursesAndFees', 'Courses & Fees', 'courses-and-fees'], ['admissions', 'Admissions', 'admissions'],
    ['reviews', 'Reviews', 'reviews'], ['placements', 'Placements', 'placements'], ['infrastructure', 'Infrastructure', 'infrastructure'],
    ['faculty', 'Faculty', 'faculty'], ['scholarship', 'Scholarship', 'scholarship'], ['gallery', 'Gallery', 'gallery'], ['newsAndArticles', 'News & Articles', 'news-and-articles']],
  exams: [['overview', 'Overview', ''], ['applicationProcess', 'Application Process', 'application-process'], ['eligibilityAndPreparation', 'Eligibility & Preparation', 'eligibility-and-preparation'],
    ['examDetails', 'Exam Details', 'exam-details'], ['results', 'Results', 'results'], ['acceptingColleges', 'Accepting Colleges', 'accepting-colleges'],
    ['examDates', 'Exam Dates', 'exam-dates'], ['syllabus', 'Syllabus', 'syllabus'], ['pastQuestionPapers', 'Past Question Papers', 'past-question-papers']],
  courses: [['overview', 'Overview', ''], ['eligibility', 'Eligibility', 'eligibility'], ['exams', 'Exams', 'exams'], ['syllabus', 'Syllabus', 'syllabus'], ['jobsAndCareers', 'Jobs & Careers', 'jobs-and-careers']],
};
const URL_TYPE = { blog: 'blogs', college: 'colleges', exam: 'exams', course: 'courses' };
const NUM = { colleges: /-cid-(\d+)$/, exams: /-eid-(\d+)$/, courses: /-mci-(\d+)$/ };

const slugify = (s) => String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const decode = (s) => cheerio.load(`<p>${s || ''}</p>`)('p').text().trim();

/** Today's date at midnight India time, the way the CMS stores due dates. */
function todayIST() {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return new Date(`${d}T00:00:00+05:30`).toISOString();
}

async function pageMeta(url) {
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const $ = cheerio.load(await r.text());
    return { title: decode($('title').first().text()), description: decode($('meta[name="description"]').attr('content')), h1: decode($('h1').first().text()), $ };
  } catch (e) { return { error: e.message }; }
}

// ---- users -------------------------------------------------------------------------------
let usersCache = null;
async function users() {
  usersCache ??= (await cmsGet('/users?limit=500&depth=1')).docs.map((u) => ({ id: u.id, email: u.email, role: u.role?.name || '' }));
  return usersCache;
}
export async function userOptions() {
  const all = await users();
  return { writers: all.filter((u) => /writer/i.test(u.role)), editors: all.filter((u) => /editor/i.test(u.role)) };
}
/** Sheet name ("Shreyosee", "Sushil") → CMS user of that role; blank → the role's default account. */
async function matchUser(name, roleRe, fallbackEmail) {
  const all = (await users()).filter((u) => roleRe.test(u.role));
  const n = String(name || '').toLowerCase().split(/[\s.]+/)[0];
  const hit = n && (all.find((u) => u.email.split('@')[0].toLowerCase() === n) || all.find((u) => u.email.toLowerCase().startsWith(n)));
  return hit || all.find((u) => u.email === fallbackEmail) || null;
}

// ---- entities ----------------------------------------------------------------------------
export async function searchEntities(category, term) {
  if (!term || category === 'blogs') return [];
  const j = await cmsGet(`/${category}?${qs({ 'where[or][0][name][like]': term, 'where[or][1][alsoKnownAs][like]': term, limit: 8, depth: 0, sort: '-popularityScore' })}`);
  return j.docs.map((d) => ({ id: d.id, name: d.name, number: d.number, relationTo: category, slug: d.pageUrl || `${slugify(d.name)}-${{ colleges: 'cid', exams: 'eid', courses: 'mci' }[category]}-${d.number}` }));
}

let pageCatCache = null;
export async function pageCategories() {
  pageCatCache ??= (await cmsGet('/pageCategories?limit=200&depth=0')).docs.map((d) => ({ id: d.id, name: d.name }));
  return pageCatCache;
}
async function defaultBlogFields() {
  const last = (await cmsGet(`/tasks?${qs({ 'where[contentCategory][equals]': 'blogs', 'where[updateData][equals]': 'false', limit: 1, depth: 0, sort: '-createdAt' })}`)).docs[0];
  return { blogType: last?.blogType || 'general', category: last?.category?.length ? last.category : ['latestNews'], pageCategory: last?.pageCategory || '' };
}

// ---- preview -----------------------------------------------------------------------------
/** Live URL → { category, entity, silos[] } with each silo's current meta title/description. */
async function inspectLiveUrl(liveUrl) {
  const u = new URL(liveUrl.startsWith('http') ? liveUrl : `${SITE}${liveUrl}`);
  const parts = u.pathname.split('/').filter(Boolean);
  const category = URL_TYPE[parts[0]];
  if (!category) throw new Error(`Not a blog/college/exam/course URL: ${u.pathname}`);
  const baseSlug = parts[1];
  const basePath = `/${parts[0]}/${baseSlug}`;
  const meta = await pageMeta(`${SITE}${u.pathname}`);
  if (meta.error) throw new Error(`Could not open the live URL (${meta.error})`);

  if (category === 'blogs') {
    const bp = (await cmsGet(`/blogPages?${qs({ 'where[pageUrl][equals]': baseSlug, limit: 1, depth: 0 })}`)).docs[0];
    if (!bp?.dataRef?.value) throw new Error(`No blog in the CMS with URL "${baseSlug}"`);
    return {
      category, entity: { id: bp.dataRef.value, name: bp.title, relationTo: 'blogs' },
      silos: [{ page: 'blogContent', label: 'Blog Content', pageUrl: baseSlug, liveUrl: u.href, metaTitle: meta.title, metaDescription: meta.description, selected: true }],
    };
  }

  const num = baseSlug.match(NUM[category])?.[1];
  if (!num) throw new Error(`Could not read the ${category.slice(0, -1)} number from the URL "${baseSlug}"`);
  const ent = (await cmsGet(`/${category}?${qs({ 'where[number][equals]': num, limit: 1, depth: 0 })}`)).docs[0];
  if (!ent) throw new Error(`No ${category.slice(0, -1)} with number ${num} in the CMS`);

  // Silos that exist on the live page = Overview + tab links under the base path.
  const $ = (await pageMeta(`${SITE}${basePath}`)).$ || meta.$;
  const links = new Set($ ? $('a[href]').map((_, a) => $(a).attr('href').split('?')[0]).get().filter((h) => h.startsWith(`${basePath}/`)) : []);
  const silos = [];
  for (const [page, label, seg] of SILOS[category]) {
    const path = seg ? `${basePath}/${seg}` : basePath;
    if (seg && !links.has(path) && u.pathname !== path) continue;
    silos.push({ page, label, pageUrl: seg || baseSlug, liveUrl: `${SITE}${path}`, selected: u.pathname === path });
  }
  // Per-course pages of a college (/courses/<slug>-cci-N) and specialisations of a course (/<slug>-msi-N).
  for (const path of links) {
    const last = path.split('/').pop();
    const cci = category === 'colleges' && path.includes('/courses/') && last.match(/-cci-(\d+)$/)?.[1];
    const msi = category === 'courses' && last.match(/-msi-(\d+)$/)?.[1];
    if (!cci && !msi) continue;
    const coll = cci ? 'collegeCourses' : 'specialisations';
    const sub = (await cmsGet(`/${coll}?${qs({ 'where[number][equals]': cci || msi, limit: 1, depth: 0 })}`)).docs[0];
    if (!sub) continue;
    const kind = cci ? 'courseDetails' : 'specialisation';
    silos.push({ page: `${sub.name}:${kind}`, label: `${sub.name} (${cci ? 'course details' : 'specialisation'})`, pageUrl: last, liveUrl: `${SITE}${path}`,
      pageId: sub.id, pageHierarchy: { currentId: sub.id, parentId: ent.id }, selected: u.pathname === path });
  }
  if (!silos.some((s) => s.selected)) silos[0].selected = true;
  await Promise.all(silos.map(async (s) => {
    const m = s.liveUrl === `${SITE}${u.pathname}` ? meta : await pageMeta(s.liveUrl);
    Object.assign(s, { metaTitle: m.title || '', metaDescription: m.description || '' });
  }));
  return { category, entity: { id: ent.id, name: ent.name, relationTo: category, slug: baseSlug }, silos };
}

/** Everything the dashboard needs to show for the chosen rows, before anything is created. */
export async function previewRows(tab, rowNumbers) {
  const { rows, taskIdColumn } = await readRows(tab.gid, rowNumbers);
  const blogDefaults = await defaultBlogFields();
  const out = [];
  for (const r of rows) {
    const item = { ...r, tab: tab.name, warnings: [], errors: [] };
    if (!taskIdColumn) item.warnings.push('This tab has no "Task ID" column — the ID cannot be written back');
    if (!r.topic) item.errors.push('Topic is empty');
    if (r.taskId) item.errors.push(`Already has Task ID ${r.taskId} — skipped`);
    const [writer, editor] = await Promise.all([matchUser(r.writer, /writer/i, 'contentwriter@syu.com'), matchUser(r.editor, /editor/i, 'contenteditor@syu.com')]);
    item.writerId = writer?.id || ''; item.editorId = editor?.id || '';
    if (r.writer && writer?.email?.startsWith('contentwriter')) item.warnings.push(`Writer "${r.writer}" not found in CMS — using ${writer.email}`);
    if (r.editor && editor?.email?.startsWith('contenteditor')) item.warnings.push(`Editor "${r.editor}" not found in CMS — using ${editor.email}`);

    if (r.liveUrl && /selectyouruniversity\.com|^\//.test(r.liveUrl)) {
      item.mode = 'update';
      try { Object.assign(item, await inspectLiveUrl(r.liveUrl)); } catch (e) { item.errors.push(e.message); }
    } else {
      item.mode = 'new';
      if (r.liveUrl) item.warnings.push(`"${r.liveUrl}" is not an SYU URL — treated as a new task`);
      item.category = 'blogs';
      item.blog = { ...blogDefaults };
      item.silos = newSilos('blogs', r.topic, null);
    }
    out.push(item);
  }
  return out;
}

/** Silos for a NEW task: blog = one subtask; college/exam/course = all silos, user ticks which. */
export function newSilos(category, topic, entity) {
  if (category === 'blogs') return [{ page: 'blogContent', label: 'Blog Content', pageUrl: slugify(topic), metaTitle: topic, metaDescription: topic, selected: true }];
  return SILOS[category].map(([page, label, seg]) => ({
    page, label, pageUrl: seg || entity?.slug || '', selected: page === 'overview',
    metaTitle: page === 'overview' ? topic : `${topic} ${label}`, metaDescription: page === 'overview' ? topic : `${topic} ${label}`,
  }));
}

// ---- create ------------------------------------------------------------------------------
/** Create the task + chosen subtasks for one previewed (and user-edited) row, then write the Task ID to the sheet. */
export async function createFromItem(item) {
  const missing = [];
  if (!item.topic) missing.push('topic');
  if (!item.editorId) missing.push('content editor');
  if (item.category !== 'blogs' || item.mode === 'update') { if (!item.entity?.id) missing.push(`which ${item.category?.slice(0, -1)} (entity)`); }
  const silos = (item.silos || []).filter((s) => s.selected);
  if (!silos.length) missing.push('at least one silo');
  for (const s of silos) {
    if (!s.metaTitle?.trim()) missing.push(`meta title for ${s.label}`);
    if (!s.metaDescription?.trim()) missing.push(`meta description for ${s.label}`);
    if (!s.pageUrl?.trim()) missing.push(`page URL for ${s.label}`);
  }
  if (item.mode === 'new' && item.category === 'blogs' && !item.blog?.pageCategory) missing.push('page category');
  if (missing.length) throw new Error(`Missing mandatory: ${missing.join(', ')}`);

  const meId = (await getMe()).id;
  const due = todayIST();
  const people = { seoManager: meId, contentEditor: item.editorId, ...(item.writerId ? { contentWriter: item.writerId } : {}) };
  const isBlogNew = item.category === 'blogs' && item.mode === 'new';

  const task = await cmsCreate('tasks', {
    title: item.topic,
    description: `${item.mode === 'update' ? 'Update' : 'New'} ${item.category.slice(0, -1)} (sheet: ${item.tab}, row ${item.row})`,
    taskType: 'contentWriting',
    contentCategory: item.category,
    updateData: item.mode === 'update',
    ...(isBlogNew ? { blogType: item.blog.blogType, category: item.blog.category, pageCategory: item.blog.pageCategory, blogFor: [], tags: [item.topic] }
      : { entity: { relationTo: item.entity.relationTo, value: item.entity.id } }),
    dueDate: due,
    status: 'open',
    dataManager: meId,
    ...people,
  });

  const created = [];
  for (const s of silos) {
    const title = item.category === 'blogs' || s.page === 'overview' ? item.topic : `${item.topic} ${s.label}`;
    try {
      const st = await cmsCreate('subTasks', {
        title, description: item.topic, parentTaskId: task.id, contentCategory: item.category,
        page: s.page, ...(s.pageId ? { pageId: s.pageId, pageHierarchy: s.pageHierarchy } : {}),
        mandatory: 'yes', primaryKeywords: [title], secondaryKeywords: [title], pageUrl: s.pageUrl,
        status: 'open', metaTitle: s.metaTitle.trim(), metaDescription: s.metaDescription.trim(), dueDate: due, ...people,
      });
      created.push({ silo: s.label, subTaskId: st.subTaskId });
    } catch (e) { created.push({ silo: s.label, error: e.message }); }
  }
  const sheet = await writeTaskId(item.tab, item.row, task.taskId).catch((e) => ({ ok: false, error: e.message }));
  return { row: item.row, topic: item.topic, mode: item.mode, category: item.category, taskId: task.taskId, subtasks: created, sheet };
}
