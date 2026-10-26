import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { runAgent, checkSubTask, fixSubTask, submitSubTask } from './agent.js';
import { FIX_DIR } from './fixer.js';
import { getSubTask, STATUS } from './cms.js';

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
    const out = await submitSubTask(await getSubTask(req.params.id));
    const r = state.lastResults.find((x) => x.id === req.params.id);
    if (r) r.action = 'fixed & approved';
    state.log.unshift({ at: new Date(), trigger: 'manual', subTaskId: out.subTaskId, title: r?.title, action: 'fixed & approved' });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/fixes', express.static(FIX_DIR));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

app.listen(PORT, () => {
  console.log(`SEO agent dashboard on http://localhost:${PORT} (${settings.paused ? 'PAUSED' : `runs every ${settings.everyMinutes} min`}${DRY_RUN ? ', DRY RUN' : ''})`);
  if (!settings.paused) run('startup');
  schedule();
});
