import 'dotenv/config';

// Payload CMS client. Blog workflow: subTasks (status) → latest _blogContent_versions (draft article).
const BASE = process.env.CMS_URL;
export const STATUS = {
  pickUp: (process.env.PICKUP_STATUSES || 'readyForSEOReview').split(',').map((s) => s.trim()),
  approve: process.env.APPROVE_STATUS || 'approved',
  reject: process.env.REJECT_STATUS || '', // empty = keep current status, only save the fix list
};

let token = null;
let tokenAt = 0;
export let me = null; // logged-in CMS user (used as SEO manager on new tasks)

async function login() {
  const r = await fetch(`${BASE}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.CMS_EMAIL, password: process.env.CMS_PASSWORD }),
  });
  const j = await r.json();
  if (!j.token) throw new Error('CMS login failed: ' + (j.errors?.[0]?.message || r.status));
  token = j.token;
  tokenAt = Date.now();
  me = j.user;
}

async function api(path, opts = {}) {
  if (!token || Date.now() - tokenAt > 60 * 60 * 1000) await login();
  const r = await fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', Authorization: `JWT ${token}`, ...opts.headers },
  });
  if (r.status === 401) { token = null; return api(path, opts); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) {
    // Validation errors list each bad field — show them all so missing mandatory fields are obvious.
    const fields = (j.errors || []).flatMap((e) => (e.data || []).map((d) => `${d.field}: ${d.message}`));
    throw new Error(`CMS ${opts.method || 'GET'} ${path.split('?')[0]}: ${fields.length ? fields.join('; ') : j.errors?.[0]?.message || r.status}`);
  }
  return j;
}

/** Generic CMS calls for other modules (task creator). */
export const cmsGet = (path) => api(path);
export const cmsCreate = (collection, body) => api(`/${collection}`, { method: 'POST', body: JSON.stringify(body) }).then((j) => j.doc);
export async function getMe() { if (!me) await login(); return me; }

export const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// Where each content type keeps its drafts, and which SEO rules apply to it.
export const TYPES = {
  blogs: { versions: '_blogContent_versions', rules: { images: true } },
  colleges: { versions: '_collegePages_versions', rules: { images: false } },
  exams: { versions: '_examPages_versions', rules: { images: false } },
  courses: { versions: '_coursePages_versions', rules: { images: false } },
};

/** Subtasks waiting for SEO review (blogs, colleges, exams, courses). */
export async function listSubTasks(statuses = STATUS.pickUp) {
  const j = await api(`/subTasks?${qs({
    'where[status][in]': statuses.join(','),
    'where[contentCategory][in]': Object.keys(TYPES).join(','),
    limit: 200, depth: 0, sort: '-updatedAt',
  })}`);
  return j.docs;
}

/** Latest saved draft for a subtask. */
export async function getDraft(subTask) {
  const type = TYPES[subTask.contentCategory];
  if (!type) return null;
  const j = await api(`/${type.versions}?${qs({ 'where[version.subTaskRef][equals]': subTask.id, sort: '-updatedAt', limit: 1, depth: 0 })}`);
  const d = j.docs[0];
  return d ? { ...d.version, _parent: d.parent, _versionId: d.id, _savedAt: d.updatedAt } : null;
}

/** Logo URL of the exam/college/course a blog is about (blogFor relation). */
export async function getEntityLogo(draft, term) {
  const url = (e) => (e?.logo && typeof e.logo === 'object' ? e.logo.assetsUrl || e.logo.url : null) || null;
  const rel = draft.blogFor?.[0] || draft.dataRef;
  if (rel?.relationTo && rel?.value && rel.relationTo !== 'blogs') {
    try { const logo = url(await api(`/${rel.relationTo}/${rel.value}?depth=1`)); if (logo) return logo; } catch { /* fall through */ }
  }
  // Blog not linked to an entity: look the main term up by name (e.g. "NMAT").
  if (!term) return null;
  for (const c of ['exams', 'colleges']) {
    try {
      const j = await api(`/${c}?${qs({ 'where[or][0][name][like]': term, 'where[or][1][alsoKnownAs][like]': term, limit: 1, depth: 1, sort: '-popularityScore' })}`);
      const logo = url(j.docs[0]);
      if (logo) return logo;
    } catch { /* try next */ }
  }
  return null;
}

/** Published blogs matching a term — candidates for internal links. */
export async function searchBlogs(term, limit = 15) {
  const j = await api(`/blogPages?${qs({ 'where[title][like]': term, 'where[status][equals]': 'published', limit, depth: 0, sort: '-updatedAt' })}`);
  return j.docs.map((d) => ({ title: d.title, url: `https://www.selectyouruniversity.com/blog/${d.pageUrl}` }));
}

/** Try to save a fixed blog draft. Returns false when this login may not edit content. */
export async function saveBlogDraft(parentId, fields) {
  try { await api(`/blogPages/${parentId}?draft=true`, { method: 'PATCH', body: JSON.stringify(fields) }); return true; }
  catch (e) { if (/403|forbidden|not allowed/i.test(e.message)) return false; throw e; }
}

/** Latest published drafts for a type/tab — used to learn what "normal" looks like. */
export async function listPublished(type, tab, limit = 20) {
  const where = { 'where[version.status][equals]': 'published', 'where[latest][equals]': 'true' };
  // Per-course tabs are saved as "<course name>:courseDetails", so match on the suffix.
  if (type !== 'blogs') where[/^(courseDetails|courseSpecialisation|specialisation)$/.test(tab) ? 'where[version.page][like]' : 'where[version.page][equals]'] = tab;
  const j = await api(`/${TYPES[type].versions}?${qs({ ...where, sort: '-updatedAt', limit, depth: 0 })}`);
  return j.docs.map((d) => d.version);
}

/**
 * College/exam/course drafts store content per tab, e.g. draft.coursesAndFees.summary.content.html.
 * subTask.page names the tab ("overview", or "MBBS:courseDetails"). Join that tab's visible
 * sections into one HTML string, with each section title as an H2.
 */
export function tabHtml(draft, page) {
  const tab = draft[String(page || '').split(':').pop()];
  const parts = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.showOnWebsite === false) return;
    const html = node.content?.html;
    if (html && html.trim()) parts.push((node.sectionDisplayTitle ? `<h2>${node.sectionDisplayTitle}</h2>` : '') + html);
    for (const [k, v] of Object.entries(node)) if (k !== 'content') walk(v);
  };
  walk(tab);
  return parts.join('\n');
}

/** Parent task of a subtask; updateData: true marks an update of an existing page. */
export async function getTask(id) {
  return id ? api(`/tasks/${id}?depth=0`).catch(() => null) : null;
}

/** CMS user's display name (the subtask's content writer). */
export async function getUserName(id) {
  if (!id) return null;
  const u = await api(`/users/${id}?depth=0`).catch(() => null);
  return u ? (u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || null) : null;
}

// The website answers 200 for every path; missing pages show "Page Not Found".
const SITE = 'https://www.selectyouruniversity.com';
const liveCache = new Map();
/** Live URL of a slug on the website (blog, college, exam or course), or null if it is a new page. */
export async function findLivePage(pageUrl) {
  const slug = String(pageUrl || '').split('/').filter(Boolean).pop();
  if (!slug) return null;
  const hit = liveCache.get(slug);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.url;
  let url = null;
  for (const section of ['blog', 'college', 'exam', 'course']) {
    try {
      const r = await fetch(`${SITE}/${section}/${slug}`);
      if (r.ok && !/Page Not Found/i.test(await r.text())) { url = `${SITE}/${section}/${slug}`; break; }
    } catch { /* site unreachable: try next */ }
  }
  liveCache.set(slug, { at: Date.now(), url });
  return url;
}

export async function getSubTask(id) {
  return api(`/subTasks/${id}?depth=0`);
}

export async function setSubTaskStatus(id, status, reviewMessage) {
  return api(`/subTasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status, reviewMessage }) });
}
