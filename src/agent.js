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
const FIX_VERSION = 15;
const fixPath = (id) => `${FIX_DIR}/${id}.json`;
export function getFix(subTaskId) {
  try { return JSON.parse(readFileSync(fixPath(subTaskId), 'utf8')); } catch { return null; }
}

/**
 * Anthropic API problems the user must act on (credit, key) or wait out (rate limit, busy).
 * Shown as a banner on the dashboard; while credit is out or the key is bad, AI fixes pause for 30 minutes.
 */
export const aiStatus = { problem: null, kind: null, at: null, pausedUntil: 0 };
function aiProblem(e) {
  const text = `${e?.status || ''} ${e?.message || ''}`;
  if (process.env.TEXT_PROVIDER === 'openai') {
    if (/insufficient_quota|billing|exceeded your current quota/i.test(text))
      return { kind: 'credit', pause: true, problem: 'OpenAI (ChatGPT) credit has run out. AI fixes are paused — add credit at platform.openai.com → Settings → Billing, or switch Text AI to Claude, then click "Fix again".' };
    if (e?.status === 401 || /invalid_api_key|incorrect api key/i.test(text))
      return { kind: 'key', pause: true, problem: 'OpenAI API key is not valid. Update OPENAI_API_KEY in the API keys panel, then click "Fix again".' };
    if (e?.status === 429) return { kind: 'rate', pause: false, problem: 'OpenAI rate limit reached — fixes will continue on the next check.' };
    if (e?.status >= 500) return { kind: 'busy', pause: false, problem: 'OpenAI is busy right now — fixes will continue on the next check.' };
    return null;
  }
  if (/credit balance is too low|billing|insufficient.*credit/i.test(text))
    return { kind: 'credit', pause: true, problem: 'Anthropic credit has run out. AI fixes are paused — add credit at console.anthropic.com → Settings → Billing, then click "Fix again".' };
  if (e?.status === 401 || /authentication_error|invalid x-api-key/i.test(text))
    return { kind: 'key', pause: true, problem: 'Anthropic API key is not valid. Update ANTHROPIC_API_KEY in .env (and on Render), then restart the agent.' };
  if (e?.status === 429 || /rate_limit/i.test(text))
    return { kind: 'rate', pause: false, problem: 'Anthropic rate limit reached — fixes will continue on the next check.' };
  if (e?.status === 529 || /overloaded/i.test(text))
    return { kind: 'busy', pause: false, problem: 'Anthropic is busy right now — fixes will continue on the next check.' };
  return null;
}

export async function fixSubTask(st, { force = false } = {}) {
  // The text AI chosen on the dashboard needs its key.
  const keyName = process.env.TEXT_PROVIDER === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!process.env[keyName]) return { error: `Add ${keyName} in the API keys panel to enable auto-fix` };
  const draft = await getDraft(st);
  if (!draft) return null;
  const old = getFix(st.subTaskId);
  if (!force && old?.draftSavedAt === draft._savedAt && old.version === FIX_VERSION && !old.error) return old;
  // Credit out / bad key: don't call Claude for every task; "Fix again" (force) still tries.
  if (!force && Date.now() < aiStatus.pausedUntil) return { error: aiStatus.problem, draftSavedAt: draft._savedAt };
  let fix;
  try {
    const item = await checkSubTask(st);
    const opts = { isUpdate: item.isUpdate, liveUrl: item.liveUrl, rules: item.rules };
    const made = st.contentCategory === 'blogs'
      ? await fixBlog(st, draft, item.result, { ...opts, writer: draft.authorName ? null : await getUserName(st.contentWriter) })
      : await fixSilo(st, draft, item.result, opts);
    fix = { ...made, draftSavedAt: draft._savedAt, version: FIX_VERSION };
    Object.assign(aiStatus, { problem: null, kind: null, at: null, pausedUntil: 0 }); // Claude answered: all clear
  } catch (e) {
    const p = aiProblem(e);
    if (p) Object.assign(aiStatus, { problem: p.problem, kind: p.kind, at: new Date().toISOString(), pausedUntil: p.pause ? Date.now() + 30 * 60 * 1000 : 0 });
    fix = { error: p?.problem || e.message, draftSavedAt: draft._savedAt, at: new Date().toISOString() };
  }
  mkdirSync(FIX_DIR, { recursive: true });
  writeFileSync(fixPath(st.subTaskId), JSON.stringify(fix, null, 2));
  return fix;
}

/**
 * Every task gets its SEO update prepared (meta, image, links, CTAs — see fixer.js) from the current content.
 * With auto-approve on, an update that passes every check is saved in the CMS and approved 5 seconds later;
 * otherwise (or when it still fails a check) it waits for Submit on the dashboard.
 */
const AUTO_APPROVE_WAIT_MS = 5000; // pause between "fix ready" and the automatic approval
export async function decide(st, { dryRun = false, autoApprove = false } = {}) {
  const item = await checkSubTask(st);
  const fix = await fixSubTask(st);
  const ready = fix?.after?.status === 'pass';
  if (ready && autoApprove && !dryRun && !fix.submittedAt) {
    await new Promise((r) => setTimeout(r, AUTO_APPROVE_WAIT_MS));
    try {
      await submitSubTask(st);
      return { ...item, fix: getFix(st.subTaskId), action: 'fixed & approved', auto: true };
    } catch (e) {
      return { ...item, fix, action: 'ready to submit', autoError: `Auto-approve failed: ${e.message}` };
    }
  }
  return { ...item, fix, action: ready ? 'ready to submit' : 'needs fix', dryRun };
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
export async function runAgent({ dryRun = false, autoApprove = false } = {}) {
  const subs = await listSubTasks();
  const results = [];
  for (const st of subs) {
    try { results.push(await decide(st, { dryRun, autoApprove })); }
    catch (e) { results.push({ id: st.id, subTaskId: st.subTaskId, title: st.title, action: 'error', error: e.message }); }
  }
  return results;
}
