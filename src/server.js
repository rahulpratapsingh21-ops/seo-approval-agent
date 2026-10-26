import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { runAgent, checkSubTask, fixSubTask, submitSubTask } from './agent.js';
import { FIX_DIR } from './fixer.js';
import { getSubTask, countSubTasks, countApprovedSince, STATUS } from './cms.js';
import { todayIST } from './checks.js';

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const DRY_RUN = process.env.DRY_RUN === 'true';

// Dashboard settings (pause, interval) survive restarts.
const DATA_DIR = fileURLToPath(new URL('../data', import.meta.url));
const SETTINGS_FILE = `${DATA_DIR}/settings.json`;
const settings = { everyMinutes: Number(process.env.RUN_EVERY_MINUTES || 15), paused: false };
try { Object.assign(settings, JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))); } catch { /* first start */ }
const saveSettings = () => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); };

// Every approval made with Submit, for the "Via Submit" count (kept across restarts, last 2,000).
const SUBMITS_FILE = `${DATA_DIR}/submits.json`;
let submits = [];
try { submits = JSON.parse(readFileSync(SUBMITS_FILE, 'utf8')); } catch { /* none yet */ }
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
    pages: countBy(list.filter((s) => s.page), (s) => s.type),
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
    const results = await runAgent({ dryRun: DRY_RUN });
    state.lastResults = results;
    for (const r of results) {
      // Log each task once per new outcome, not on every scheduled run.
      if (state.log.find((l) => l.subTaskId === r.subTaskId)?.action !== r.action) state.log.unshift({ at: started, trigger, subTaskId: r.subTaskId, title: r.title, action: r.action, score: r.result?.score, error: r.error });
    }
    state.log = state.log.slice(0, 300);
    state.lastRun = { at: started, trigger, count: results.length, readyToSubmit: results.filter((r) => r.action === 'ready to submit').length };
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
app.get('/api/state', (_, res) => res.json({ ...state, config: { ...settings, dryRun: DRY_RUN, pickUp: STATUS.pickUp, approve: STATUS.approve, reject: STATUS.reject || '(keep status)' } }));
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
app.post('/api/submit/:id', async (req, res) => {
  if (DRY_RUN) return res.status(400).json({ error: 'Test mode (DRY_RUN=true) — set DRY_RUN=false in .env to submit to the CMS' });
  try {
    const st = await getSubTask(req.params.id);
    const out = await submitSubTask(st);
    const perItem = String(st.page || '').includes(':'); // one course/specialisation page, not a silo
    recordSubmit({ at: new Date().toISOString(), subTaskId: out.subTaskId, type: st.contentCategory,
      ...(perItem ? { page: st.page } : st.contentCategory !== 'blogs' && { silo: st.page }) });
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
