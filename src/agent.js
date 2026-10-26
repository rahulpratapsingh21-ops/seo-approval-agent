import { listSubTasks, getDraft, tabHtml, getTask, findLivePage, findLiveSilo, getUserName, approveContent, uploadImage } from './cms.js';
import { runChecks } from './checks.js';
import { rulesFor } from './benchmarks.js';
import { fixBlog, fixSilo, FIX_DIR } from './fixer.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

/** Check one subtask's draft. Falls back to SEO fields on the subtask if the draft lacks them. */
export async function checkSubTask(st) {
  const type = st.contentCategory;
  const base = { id: st.id, subTaskId: st.subTaskId, type, tab: type === 'blogs' ? '' : st.page, status: st.status, updatedAt: st.updatedAt };
  const draft = await getDraft(st);
  if (!draft) {
    return { ...base, title: st.title, result: { status: 'fail', score: 0, checks: [{ id: 'draft', label: 'Draft', level: 'fail', detail: 'No saved draft found for this subtask' }] } };
  }
  const isBlog = type === 'blogs';
  const page = {
    title: isBlog ? draft.title || st.title : draft.pageDisplayTitle || `${draft.entity || ''} ${st.title}`.trim(),
    metaTitle: draft.metaTitle ?? st.metaTitle,
    metaDescription: draft.metaDescription ?? st.metaDescription,
    primaryKeywords: draft.primaryKeywords?.length ? draft.primaryKeywords : st.primaryKeywords,
    pageUrl: draft.pageUrl || st.pageUrl,
    html: isBlog ? draft.html : tabHtml(draft, st.page),
  };
  if (isBlog) Object.assign(page, { heroImage: draft.heroImage, date: draft.date, authorName: draft.authorName });
  if (isBlog) {
    // Blog update = the parent task says so, or the URL is already live on the website.
    const [task, liveUrl] = await Promise.all([getTask(st.parentTaskId), findLivePage(page.pageUrl)]);
    Object.assign(page, { liveUrl, isUpdate: !!(liveUrl || task?.updateData) });
  } else {
    // College/exam/course silo update = this silo is already published / live for the entity.
    const silo = await findLiveSilo(type, draft);
    Object.assign(page, { liveUrl: silo.url, isUpdate: silo.exists });
  }
  // A live blog with a CTA already has enough; new blogs need 2–3.
  const rules = { ...(await rulesFor(type, st.page)), ...(isBlog && page.isUpdate && { minCta: 1 }) };
  return { ...base, title: page.title, pageUrl: page.pageUrl, isUpdate: page.isUpdate, liveUrl: page.liveUrl, rules, result: runChecks(page, rules) };
}

export async function checkAll() {
  const subs = await listSubTasks();
  const out = [];
  for (const st of subs) out.push(await checkSubTask(st));
  return out;
}

// One fix per saved draft version, so a draft is only sent to Claude again after the writer changes it.
// FIX_VERSION goes up when the fix rules change, so older saved fixes are made again.
const FIX_VERSION = 4;
const fixPath = (id) => `${FIX_DIR}/${id}.json`;
export function getFix(subTaskId) {
  try { return JSON.parse(readFileSync(fixPath(subTaskId), 'utf8')); } catch { return null; }
}

export async function fixSubTask(st, { force = false } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return { error: 'Add ANTHROPIC_API_KEY to .env to enable auto-fix' };
  const draft = await getDraft(st);
  if (!draft) return null;
  const old = getFix(st.subTaskId);
  if (!force && old?.draftSavedAt === draft._savedAt && old.version === FIX_VERSION && !old.error) return old;
  let fix;
  try {
    const item = await checkSubTask(st);
    const opts = { isUpdate: item.isUpdate, liveUrl: item.liveUrl, rules: item.rules };
    const made = st.contentCategory === 'blogs'
      ? await fixBlog(st, draft, item.result, { ...opts, writer: draft.authorName ? null : await getUserName(st.contentWriter) })
      : await fixSilo(st, draft, item.result, opts);
    fix = { ...made, draftSavedAt: draft._savedAt, version: FIX_VERSION };
  } catch (e) {
    fix = { error: e.message, draftSavedAt: draft._savedAt, at: new Date().toISOString() };
  }
  mkdirSync(FIX_DIR, { recursive: true });
  writeFileSync(fixPath(st.subTaskId), JSON.stringify(fix, null, 2));
  return fix;
}

/**
 * Every task gets its SEO update prepared (meta, image, links, CTAs — see fixer.js) from the current content.
 * It then waits for Submit on the dashboard, which saves it in the CMS and approves.
 */
export async function decide(st, { dryRun = false } = {}) {
  const item = await checkSubTask(st);
  const fix = await fixSubTask(st);
  const action = fix?.after?.status === 'pass' ? 'ready to submit' : 'needs fix';
  return { ...item, fix, action, dryRun };
}

/** Submit: upload the new feature image, save the prepared fields into the CMS draft and approve. */
export async function submitSubTask(st) {
  const draft = await getDraft(st);
  const fix = getFix(st.subTaskId);
  if (!fix || fix.error) throw new Error('Click Fix first');
  if (fix.submittedAt) throw new Error('Already submitted');
  if (fix.draftSavedAt !== draft?._savedAt) throw new Error('The writer changed the draft after this fix — click Fix again');
  if (fix.after.status !== 'pass') throw new Error('The fix still fails some checks — fix those in the CMS first');
  const fields = { ...fix.fields };
  if (fix.imageFile) {
    // Remembered, so a retry after a failed approval doesn't upload the image twice.
    const alt = fix.imageAlt || fields.title || draft.title;
    fix.heroImage ??= await uploadImage(readFileSync(`${FIX_DIR}/${fix.imageFile}`), { caption: alt, altText: alt });
    writeFileSync(fixPath(st.subTaskId), JSON.stringify(fix, null, 2));
    fields.heroImage = fix.heroImage;
  }
  const after = await approveContent(st, fields);
  fix.submittedAt = new Date().toISOString();
  writeFileSync(fixPath(st.subTaskId), JSON.stringify(fix, null, 2));
  return { subTaskId: st.subTaskId, status: after.status, imageFile: fix.imageFile };
}

/** One agent run: check every subtask waiting for SEO review and act on it. */
export async function runAgent({ dryRun = false } = {}) {
  const subs = await listSubTasks();
  const results = [];
  for (const st of subs) {
    try { results.push(await decide(st, { dryRun })); }
    catch (e) { results.push({ id: st.id, subTaskId: st.subTaskId, title: st.title, action: 'error', error: e.message }); }
  }
  return results;
}
