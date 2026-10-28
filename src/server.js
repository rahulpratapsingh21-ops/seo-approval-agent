import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { runAgent, checkSubTask, fixSubTask, submitSubTask, decide, aiStatus } from './agent.js';
import { FIX_DIR } from './fixer.js';
import { getSubTask, countSubTasks, countApprovedSince, findSubTasksByNumber, STATUS, TYPES } from './cms.js';
import { todayIST } from './checks.js';
import { keyStatus, saveKey, testKey } from './keys.js';

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const DRY_RUN = process.env.DRY_RUN === 'true';

// Dashboard settings (pause, interval) survive restarts.
const DATA_DIR = fileURLToPath(new URL('../data', import.meta.url));
const SETTINGS_FILE = `${DATA_DIR}/settings.json`;
// autoApprove: an update that passes every check is approved during the run, without Submit.
const settings = { everyMinutes: Number(process.env.RUN_EVERY_MINUTES || 15), paused: false, autoApprove: true };
try { Object.assign(settings, JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))); } catch { /* first start */ }
const saveSettings = () => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); };

// Every approval made with Submit, for the "Via Submit" count (kept across restarts, last 2,000).
const SUBMITS_FILE = `${DATA_DIR}/submits.json`;
let submits = [];
try { submits = JSON.parse(readFileSync(SUBMITS_FILE, 'utf8')); } catch { /* none yet */ }
// One record per approval; page = one course/specialisation page (not a silo), silo = college/exam/course silo.
const submitEntry = (subTaskId, type, page, auto = false) => {
  const perItem = String(page || '').includes(':');
  return { at: new Date().toISOString(), subTaskId, type, ...(perItem ? { page } : type !== 'blogs' && page && { silo: page }), ...(auto && { auto }) };
};
const recordSubmit = (entry) => {
  submits = [entry, ...submits].slice(0, 2000);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SUBMITS_FILE, JSON.stringify(submits));
};
// Per type (silos only), per silo, and per-course/specialisation pages — same split as the CMS counts.
const countBy = (list, key) => list.reduce((m, s) => ({ ...m, [key(s)]: (m[key(s)] || 0) + 1 }), {});
function submittedIn({ since, until }) {
  const list = submits.filter((s) => s.at >= since && s.at < until);
  return {
    types: countBy(list.filter((s) => !s.page), (s) => s.type),
    pages: list.filter((s) => s.page).reduce((m, s) => {
      const kind = s.page.split(':').pop();
      return { ...m, [s.type]: { ...m[s.type], [kind]: (m[s.type]?.[kind] || 0) + 1 } };
    }, {}),
    silos: list.filter((s) => s.silo).reduce((m, s) => ({ ...m, [s.type]: { ...m[s.type], [s.silo]: (m[s.type]?.[s.silo] || 0) + 1 } }), {}),
  };
}

/** Today and the 2 days before, as India-time day ranges: [{ date: "2026-10-26", since, until }]. */
function lastDays(n = 3) {
  const DAY = 24 * 60 * 60 * 1000;
  const start = Date.parse(`${todayIST()}T00:00:00+05:30`);
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(start - i * DAY + 12 * 60 * 60 * 1000).toISOString().slice(0, 10),
    since: new Date(start - i * DAY).toISOString(),
    until: new Date(start - (i - 1) * DAY).toISOString(),
  }));
}

// Dashboard login (browser pop-up). Cron services can call /api/run?key=RUN_KEY instead.
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (req.path === '/api/run' && process.env.RUN_KEY && req.query.key === process.env.RUN_KEY) return next();
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass) return next();
  const [, b64] = (req.headers.authorization || '').split(' ');
  const [, pw] = Buffer.from(b64 || '', 'base64').toString().split(':');
  if (pw === pass) return next();
  res.set('WWW-Authenticate', 'Basic realm="SEO Agent"').status(401).send('Login required');
});

const state = { running: false, lastRun: null, nextRun: null, lastResults: [], log: [] };

async function run(trigger) {
  if (state.running) return { busy: true };
  state.running = true;
  const started = new Date();
  try {
    const results = await runAgent({ dryRun: DRY_RUN, autoApprove: settings.autoApprove });
    state.lastResults = results;
    for (const r of results) {
      if (r.auto) recordSubmit(submitEntry(r.subTaskId, r.type, r.tab, true));
      // Log each task once per new outcome, not on every scheduled run.
      if (state.log.find((l) => l.subTaskId === r.subTaskId)?.action !== r.action) state.log.unshift({ at: started, trigger, subTaskId: r.subTaskId, title: r.title, action: r.action,
        score: r.fix?.after && r.action !== 'needs fix' ? `${r.result?.score} → ${r.fix.after.score}` : r.result?.score, error: r.error });
    }
    state.log = state.log.slice(0, 300);
    state.lastRun = { at: started, trigger, count: results.length, readyToSubmit: results.filter((r) => r.action === 'ready to submit').length, autoApproved: results.filter((r) => r.auto).length };
    return state.lastRun;
  } catch (e) {
    state.lastRun = { at: started, trigger, error: e.message };
    return state.lastRun;
  } finally {
    state.running = false;
  }
}

// Scheduled runs; paused = no automatic checks (Run now still works).
let timer = null;
function schedule() {
  clearInterval(timer);
  state.nextRun = settings.paused ? null : new Date(Date.now() + settings.everyMinutes * 60000);
  if (settings.paused) return;
  timer = setInterval(() => {
    state.nextRun = new Date(Date.now() + settings.everyMinutes * 60000);
    run('schedule');
  }, settings.everyMinutes * 60000);
}

app.get('/health', (_, res) => res.send('ok'));
app.get('/api/state', (_, res) => res.json({ ...state, ai: aiStatus, config: { ...settings, dryRun: DRY_RUN, pickUp: STATUS.pickUp, approve: STATUS.approve, reject: STATUS.reject || '(keep status)' } }));
// SEO queue sizes and today's approvals for the dashboard side panel (cached a minute; the page polls every 15 s).
let counts = { at: 0, data: null };
app.get('/api/counts', async (_, res) => {
  try {
    if (Date.now() - counts.at > 60000) {
      const days = lastDays();
      const [queue, ...approved] = await Promise.all([countSubTasks(), ...days.map((d) => countApprovedSince(d.since, d.until))]);
      counts = { at: Date.now(), data: { ...queue, days: days.map((d, i) => ({ ...d, approved: approved[i] })) } };
    }
    // Submits are local, so always fresh (not cached).
    const days = counts.data.days.map((d) => ({ ...d, submitted: submittedIn(d) }));
    res.json({ ...counts.data, days, at: new Date(counts.at), cmsUrl: process.env.CMS_URL });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.all('/api/run', async (req, res) => res.json(await run(req.query.key ? 'cron' : 'manual')));
app.post('/api/settings', (req, res) => {
  const { paused, everyMinutes } = req.body || {};
  if (typeof paused === 'boolean') settings.paused = paused;
  if (typeof req.body?.autoApprove === 'boolean') settings.autoApprove = req.body.autoApprove;
  if (everyMinutes !== undefined) {
    const m = Math.round(Number(everyMinutes));
    if (!(m >= 1 && m <= 1440)) return res.status(400).json({ error: 'Minutes must be between 1 and 1440' });
    settings.everyMinutes = m;
  }
  saveSettings();
  schedule();
  res.json(settings);
});
app.post('/api/clear', (_, res) => {
  state.lastResults = [];
  state.log = [];
  state.lastRun = null;
  rmSync(FIX_DIR, { recursive: true, force: true });
  res.json({ cleared: true });
});
app.get('/api/check/:id', async (req, res) => {
  try { res.json(await checkSubTask(await getSubTask(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/fix/:id', async (req, res) => {
  try {
    const fix = await fixSubTask(await getSubTask(req.params.id), { force: true });
    const r = state.lastResults.find((x) => x.id === req.params.id);
    if (r) r.fix = fix;
    res.json(fix);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// API keys panel: status only (set + last 4 characters), save, and a free test call.
app.get('/api/keys', (_, res) => res.json(keyStatus()));
app.post('/api/keys', (req, res) => {
  try {
    const k = saveKey(req.body?.name, req.body?.value);
    // A new Anthropic key ends a pause caused by the old key's credit/validity.
    if (k.name === 'ANTHROPIC_API_KEY') Object.assign(aiStatus, { problem: null, kind: null, at: null, pausedUntil: 0 });
    res.json(k);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/keys/test', async (req, res) => res.json(await testKey(req.body?.name)));

// One task on demand (typed on the dashboard): check, fix, and approve (auto-approve on) or wait for Submit.
// Works for Ready for SEO review and In SEO review — the CMS lets the SEO manager approve only those.
const REVIEWABLE = ['readyForSEOReview', 'inSEOReview'];
app.post('/api/task/:num', async (req, res) => {
  try {
    const subs = (await findSubTasksByNumber(req.params.num)).filter((s) => TYPES[s.contentCategory]);
    if (!subs.length) return res.status(404).json({ error: `No blog, college, exam or course task found for #${req.params.num}` });
    const results = [];
    for (const st of subs) {
      if (!REVIEWABLE.includes(st.status)) {
        results.push({ id: st.id, subTaskId: st.subTaskId, title: st.title, type: st.contentCategory, action: 'skipped',
          error: `Status is "${st.status}" — only tasks in Ready for SEO review or In SEO review can be fixed and approved.` });
        continue;
      }
      const r = await decide(st, { dryRun: DRY_RUN, autoApprove: settings.autoApprove });
      if (r.auto) recordSubmit(submitEntry(r.subTaskId, r.type, r.tab, true));
      results.push(r);
    }
    // Show them at the top of the dashboard list and in the activity log.
    for (const r of results.slice().reverse()) {
      state.lastResults = [r, ...state.lastResults.filter((x) => x.subTaskId !== r.subTaskId)];
      state.log.unshift({ at: new Date(), trigger: 'by ID', subTaskId: r.subTaskId, title: r.title, action: r.action,
        score: r.fix?.after && r.action !== 'needs fix' ? `${r.result?.score} → ${r.fix.after.score}` : r.result?.score, error: r.error });
    }
    res.json({ results: results.map((r) => ({ subTaskId: r.subTaskId, title: r.title, action: r.action, error: r.error || r.autoError })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/submit/:id', async (req, res) => {
  if (DRY_RUN) return res.status(400).json({ error: 'Test mode (DRY_RUN=true) — set DRY_RUN=false in .env to submit to the CMS' });
  try {
    const st = await getSubTask(req.params.id);
    const out = await submitSubTask(st);
    recordSubmit(submitEntry(out.subTaskId, st.contentCategory, st.page));
    const r = state.lastResults.find((x) => x.id === req.params.id);
    if (r) r.action = 'fixed & approved';
    state.log.unshift({ at: new Date(), trigger: 'manual', subTaskId: out.subTaskId, title: r?.title, action: 'fixed & approved' });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/fixes', express.static(FIX_DIR));
app.get('/logo.png', (_, res) => res.sendFile(fileURLToPath(new URL('../assets/syu-icon.png', import.meta.url))));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

app.listen(PORT, () => {
  console.log(`SEO agent dashboard on http://localhost:${PORT} (${settings.paused ? 'PAUSED' : `runs every ${settings.everyMinutes} min`}${DRY_RUN ? ', DRY RUN' : ''})`);
  if (!settings.paused) run('startup');
  schedule();
});
