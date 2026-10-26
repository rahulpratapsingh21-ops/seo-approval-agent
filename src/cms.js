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
  const form = opts.body instanceof FormData; // fetch sets the multipart content-type itself
  const r = await fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { ...(!form && { 'content-type': 'application/json' }), Authorization: `JWT ${token}`, ...opts.headers },
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
  blogs: { pages: 'blogPages', versions: '_blogContent_versions', rules: { images: true } },
  colleges: { pages: 'collegePages', versions: '_collegePages_versions', rules: { images: false } },
  exams: { pages: 'examPages', versions: '_examPages_versions', rules: { images: false } },
  courses: { pages: 'coursePages', versions: '_coursePages_versions', rules: { images: false } },
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

/** File URL behind a mediaRef (id or object): mediaRef → media.assetsUrl. */
export async function mediaUrl(ref) {
  try {
    if (!ref) return null;
    const r = typeof ref === 'object' ? ref : await api(`/mediaRef/${ref}?depth=0`);
    if (r.assetsUrl) return r.assetsUrl;
    const id = typeof r.mediaId === 'object' ? r.mediaId?.id : r.mediaId;
    return id ? (await api(`/media/${id}?depth=0`)).assetsUrl || null : null;
  } catch { return null; }
}

const tokens = (s) => String(s || '').toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 2);

/**
 * Logo and campus photo of the exam/college a blog is about: its blogFor/dataRef entity, else the
 * exam/college whose name or short name shares a word with the blog's title/keyword (e.g. "PTU" → [IKG-PTU]).
 * Returns { name, logo, cover } as image URLs (null when missing).
 */
export async function getEntityImages(draft, text) {
  const pick = async (e) => ({ name: e.name, logo: await mediaUrl(e.logo), cover: await mediaUrl([].concat(e.coverImages || [])[0]) });
  const rel = draft.blogFor?.[0] || draft.dataRef;
  if (rel?.relationTo && rel?.value && rel.relationTo !== 'blogs') {
    const e = await api(`/${rel.relationTo}/${typeof rel.value === 'object' ? rel.value.id : rel.value}?depth=0`).catch(() => null);
    if (e) return pick(e);
  }
  const want = new Set(tokens(text).filter((w) => !/^\d+$/.test(w) && !['EXAM', 'EXAMS', 'RESULT', 'RESULTS', 'CHECK', 'COURSE', 'COURSES', 'ADMISSION', 'BOARD', 'PDF', 'WITH', 'AND', 'THE', 'FOR'].includes(w)));
  const term = [...want].find((w) => w.length >= 3 && /[A-Z]{3,}/.test(w)) || [...want][0];
  if (!term) return { name: null, logo: null, cover: null };
  let best = null, bestScore = 0;
  for (const c of ['exams', 'colleges']) {
    const j = await api(`/${c}?${qs({ 'where[or][0][name][like]': term, 'where[or][1][alsoKnownAs][like]': term, limit: 5, depth: 0, sort: '-popularityScore' })}`)
      .catch(() => ({ docs: [] }));
    for (const e of j.docs) {
      const score = new Set(tokens(`${e.name} ${[].concat(e.alsoKnownAs || []).join(' ')}`).filter((w) => want.has(w))).size;
      if (score > bestScore) { best = e; bestScore = score; }
    }
  }
  return best ? pick(best) : { name: null, logo: null, cover: null };
}

/** Published blogs matching a term — candidates for internal links, with their keywords. */
export async function searchBlogs(term, limit = 15) {
  const j = await api(`/blogPages?${qs({ 'where[title][like]': term, 'where[status][equals]': 'published', limit, depth: 0, sort: '-updatedAt' })}`);
  return j.docs.map((d) => ({
    title: d.title,
    url: `https://www.selectyouruniversity.com/blog/${d.pageUrl}`,
    keywords: [d.title, d.pageUrl, ...(d.primaryKeywords || []), ...(d.secondaryKeywords || [])].filter((k) => typeof k === 'string'),
  }));
}

/** Published college/exam overview pages matching a term — internal link targets keyed on the entity's names. */
export async function searchEntityPages(term, limit = 5) {
  const out = [];
  for (const type of ['exams', 'colleges']) {
    const j = await api(`/${type}?${qs({ 'where[or][0][name][like]': term, 'where[or][1][alsoKnownAs][like]': term, limit, depth: 0, sort: '-popularityScore' })}`)
      .catch(() => ({ docs: [] }));
    for (const e of j.docs) {
      const p = await api(`/${TYPES[type].pages}?${qs({ 'where[dataRef.value][equals]': e.id, 'where[page][equals]': 'overview', 'where[status][equals]': 'published', limit: 1, depth: 0 })}`)
        .catch(() => ({ docs: [] }));
      if (!p.docs[0]?.pageUrl) continue;
      const aka = [].concat(e.alsoKnownAs || []).flatMap((x) => (typeof x === 'string' ? x.split(',') : x?.name || x?.value || []));
      out.push({ title: e.name, url: `${SITE}/${SECTION[type]}/${p.docs[0].pageUrl}`, keywords: [e.name, ...aka].map((k) => String(k).trim()).filter(Boolean) });
    }
  }
  return out;
}

/**
 * Upload an image the way the CMS screen does: file → media, then a mediaRef (alt text, tags)
 * for the collection. Returns the mediaRef id, which is what heroImage points to.
 */
export async function uploadImage(png, { caption, altText, collection = 'blogPages' }) {
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), `${slugify(caption) || 'feature-image'}.png`);
  form.append('_payload', JSON.stringify({ caption }));
  const media = await api('/media?depth=0', { method: 'POST', body: form });
  const ref = await api('/mediaRef?depth=0', {
    method: 'POST',
    body: JSON.stringify({ caption, altText, tags: [caption], mediaId: media.doc.id, collectionName: collection, fileType: 'image' }),
  });
  return ref.doc.id;
}

/**
 * Run a workflow action the way the CMS screen does: PATCH the content page with the
 * latest draft (plus any changed fields) and an X-User-Action header. The CMS hooks then
 * move the subtask/task status. An SEO manager may only do this while the subtask is in SEO review.
 */
async function contentAction(st, action, fields = {}) {
  const draft = await getDraft(st);
  if (!draft) throw new Error('No saved draft found for this subtask');
  const { _parent, _versionId, _savedAt, ...version } = draft;
  // Sent as a form with a _payload field, like the CMS screen: long articles are over the CMS's JSON size limit.
  const body = new FormData();
  body.append('_payload', JSON.stringify({ ...version, ...fields, id: _parent }));
  return api(`/${TYPES[st.contentCategory].pages}/${_parent}?depth=0`, { method: 'PATCH', headers: { 'X-User-Action': action }, body });
}

/** "Start Review" as an SEO manager: the subtask moves to In SEO Review, which unlocks saving and approving its content. */
async function startSeoReview(st) {
  const body = new FormData();
  body.append('_payload', JSON.stringify({ ...st, status: 'inSEOReview' }));
  await api(`/subTasks/${st.id}?depth=0`, { method: 'PATCH', body });
}

/** SEO approval: start review (if not started), save the fixed fields (if any), approve. Returns the subtask after. */
export async function approveContent(st, fields = null) {
  if (st.status === 'readyForSEOReview') await startSeoReview(st);
  if (fields && Object.keys(fields).length) await contentAction(st, 'saveContent', fields);
  await contentAction(st, 'approveContentBySEO');
  const after = await getSubTask(st.id);
  if (['readyForSEOReview', 'inSEOReview'].includes(after.status)) throw new Error(`CMS did not approve (subtask still "${after.status}")`);
  return after;
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
async function isLive(url) {
  const hit = liveCache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.live;
  let live = false;
  try { const r = await fetch(url); live = r.ok && !/Page Not Found/i.test(await r.text()); } catch { /* site unreachable */ }
  liveCache.set(url, { at: Date.now(), live });
  return live;
}

/** Live URL of a blog slug on the website (blog, college, exam or course), or null if it is a new page. */
export async function findLivePage(pageUrl) {
  const slug = String(pageUrl || '').split('/').filter(Boolean).pop();
  if (!slug) return null;
  for (const section of ['blog', 'college', 'exam', 'course']) {
    if (await isLive(`${SITE}/${section}/${slug}`)) return `${SITE}/${section}/${slug}`;
  }
  return null;
}

// College/exam/course pages: one page per silo, e.g. /exam/<overview url>/results.
const SECTION = { colleges: 'college', exams: 'exam', courses: 'course' };
const URL_CODE = { colleges: 'cid', exams: 'eid', courses: 'mci' };
const slugify = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Does this silo already exist? Yes when the college/exam/course has a published page for it
 * (or its URL is live on the website). Returns { exists, url } — url is the live website URL.
 */
export async function findLiveSilo(type, draft) {
  const j = await api(`/${TYPES[type].pages}?${qs({ 'where[dataRef.value][equals]': draft.dataRef?.value, 'where[status][equals]': 'published', limit: 100, depth: 0 })}`)
    .catch(() => ({ docs: [] }));
  const overview = j.docs.find((p) => p.page === 'overview');
  const silo = j.docs.find((p) => p.page === draft.page);
  if (!overview?.pageUrl) return { exists: !!silo, url: null };
  const base = `${SITE}/${SECTION[type]}/${overview.pageUrl}`;
  const url = draft.page === 'overview' ? base : `${base}/${silo?.pageUrl || draft.pageUrl}`;
  const live = await isLive(url);
  return { exists: !!silo || live, url: live ? url : null };
}

/** URL for a new silo, built like published ones: overview = <name>-<cid|eid|mci>-<number>, other silos = the URL other entities use for that silo. */
export async function newSiloUrl(type, draft) {
  const tab = String(draft.page || '');
  if (tab === 'overview') {
    const e = await api(`/${draft.dataRef.relationTo}/${draft.dataRef.value}?depth=0`).catch(() => null);
    return e?.number ? `${slugify(e.name || draft.entity)}-${URL_CODE[type]}-${e.number}` : null;
  }
  if (tab.includes(':')) return null; // per-course pages keep the writer's URL
  const urls = (await listPublished(type, tab, 20).catch(() => [])).map((v) => v.pageUrl).filter(Boolean);
  const count = urls.reduce((m, u) => m.set(u, (m.get(u) || 0) + 1), new Map());
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || slugify(tab.replace(/([A-Z])/g, '-$1'));
}

export async function getSubTask(id) {
  return api(`/subTasks/${id}?depth=0`);
}
