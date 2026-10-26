import { listSubTasks, getDraft, getSubTask, setSubTaskStatus, tabHtml, STATUS, TYPES } from './cms.js';
import { runChecks, reviewMessage } from './checks.js';
import { rulesFor } from './benchmarks.js';
import { fixBlog, FIX_DIR } from './fixer.js';
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
  if (isBlog) page.heroImage = draft.heroImage;
  const rules = await rulesFor(type, st.page);
  return { ...base, title: page.title, pageUrl: page.pageUrl, rules, result: runChecks(page, rules) };
}

export async function checkAll() {
  const subs = await listSubTasks();
  const out = [];
  for (const st of subs) out.push(await checkSubTask(st));
  return out;
}

// One fix per saved draft version, so a draft is only sent to Claude again after the writer changes it.
const fixPath = (id) => `${FIX_DIR}/${id}.json`;
export function getFix(subTaskId) {
  try { return JSON.parse(readFileSync(fixPath(subTaskId), 'utf8')); } catch { return null; }
}

export async function fixSubTask(st, { force = false } = {}) {
  if (st.contentCategory !== 'blogs') return null;
  if (!process.env.ANTHROPIC_API_KEY) return { error: 'Add ANTHROPIC_API_KEY to .env to enable auto-fix' };
  const draft = await getDraft(st);
  if (!draft) return null;
  const old = getFix(st.subTaskId);
  if (!force && old?.draftSavedAt === draft._savedAt && !old.error) return old;
  let fix;
  try {
    const before = (await checkSubTask(st)).result;
    fix = { ...(await fixBlog(st, draft, before)), draftSavedAt: draft._savedAt };
  } catch (e) {
    fix = { error: e.message, draftSavedAt: draft._savedAt, at: new Date().toISOString() };
  }
  mkdirSync(FIX_DIR, { recursive: true });
  writeFileSync(fixPath(st.subTaskId), JSON.stringify(fix, null, 2));
  return fix;
}

/**
 * Pass → status Approved + review note.
 * Fail → fix list saved in reviewMessage, status left as is (set REJECT_STATUS to also move it).
 */
export async function decide(st, { dryRun = false } = {}) {
  const item = await checkSubTask(st);
  const pass = item.result.status === 'pass';
  const msg = reviewMessage(item.result);
  const next = pass ? STATUS.approve : STATUS.reject || st.status;
  const changed = next !== st.status || msg !== st.reviewMessage;
  if (!dryRun && changed) await setSubTaskStatus(st.id, next, msg);
  const action = pass ? 'approved' : changed ? 'notes saved' : 'unchanged';
  const fix = pass ? null : await fixSubTask(st);
  return { ...item, fix, action: dryRun && action !== 'unchanged' ? `test: would be ${action}` : action, newStatus: next, dryRun };
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
