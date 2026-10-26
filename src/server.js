import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { runAgent, checkSubTask, fixSubTask } from './agent.js';
import { FIX_DIR } from './fixer.js';
import { getSubTask, STATUS } from './cms.js';

const app = express();
const PORT = process.env.PORT || 3000;
const EVERY_MIN = Number(process.env.RUN_EVERY_MINUTES || 15);
const DRY_RUN = process.env.DRY_RUN === 'true';

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
      if (r.action !== 'unchanged') state.log.unshift({ at: started, trigger, subTaskId: r.subTaskId, title: r.title, action: r.action, score: r.result?.score, error: r.error });
    }
    state.log = state.log.slice(0, 300);
    state.lastRun = { at: started, trigger, count: results.length, approved: results.filter((r) => r.action === 'approved').length };
    return state.lastRun;
  } catch (e) {
    state.lastRun = { at: started, trigger, error: e.message };
    return state.lastRun;
  } finally {
    state.running = false;
    state.nextRun = new Date(Date.now() + EVERY_MIN * 60000);
  }
}

app.get('/health', (_, res) => res.send('ok'));
app.get('/api/state', (_, res) => res.json({ ...state, config: { everyMinutes: EVERY_MIN, dryRun: DRY_RUN, pickUp: STATUS.pickUp, approve: STATUS.approve, reject: STATUS.reject || '(keep status)' } }));
app.all('/api/run', async (req, res) => res.json(await run(req.query.key ? 'cron' : 'manual')));
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
app.use('/fixes', express.static(FIX_DIR));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

app.listen(PORT, () => {
  console.log(`SEO agent dashboard on http://localhost:${PORT} (runs every ${EVERY_MIN} min${DRY_RUN ? ', DRY RUN' : ''})`);
  run('startup');
  setInterval(() => run('schedule'), EVERY_MIN * 60000);
});
