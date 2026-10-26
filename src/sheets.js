// Google Sheet access. Reading uses the public CSV export (sheet is shared "anyone with the link").
// Writing goes through a small Apps Script web app the owner deploys (see apps-script/WriteTaskId.gs).
export const SHEET_ID = process.env.SHEET_ID || '1bsGKL667kifcVDHeWK35Edb0juxoRvNUDsFWiQVE2zc';

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** Tabs of the sheet: [{ gid, name }] */
export async function listTabs() {
  const html = await (await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/htmlview`)).text();
  return [...html.matchAll(/\{name: "([^"]+)", pageUrl: "[^"]*gid=(\d+)/g)].map((m) => ({ name: m[1], gid: m[2] }));
}

// Column headers differ per tab, so find columns by name.
const COLS = {
  topic: /^(topic|news title|title|college|exam|course)$/i,
  taskId: /^task\s*id$/i,
  writer: /^writer$/i,
  editor: /^editor$/i,
  liveUrl: /^(live\s*url|url)$/i,
};

/** Rows of a tab by sheet row number (1 = header). Returns [{ row, topic, taskId, writer, editor, liveUrl }] */
export async function readRows(gid, rowNumbers) {
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`);
  if (!r.ok) throw new Error(`Could not read the sheet (HTTP ${r.status}). Is it shared as "Anyone with the link"?`);
  const rows = parseCsv(await r.text());
  const header = rows[0].map((h) => h.trim());
  const col = Object.fromEntries(Object.entries(COLS).map(([k, re]) => [k, header.findIndex((h) => re.test(h))]));
  if (col.topic < 0) throw new Error(`No topic column found in this tab. Headers: ${header.filter(Boolean).join(', ')}`);
  const cell = (r, k) => (col[k] >= 0 ? (r[col[k]] || '').trim() : '');
  return {
    taskIdColumn: col.taskId >= 0 ? header[col.taskId] : null,
    rows: rowNumbers.map((n) => {
      const r = rows[n - 1] || [];
      return { row: n, topic: cell(r, 'topic'), taskId: cell(r, 'taskId'), writer: cell(r, 'writer'), editor: cell(r, 'editor'), liveUrl: cell(r, 'liveUrl') };
    }),
  };
}

/** "185", "185-190", "185, 190, 200-202" → [185, 186, …] */
export function parseRowList(text) {
  const out = new Set();
  for (const part of String(text).split(',').map((s) => s.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map((x) => parseInt(x, 10));
    if (!a || a < 2) throw new Error(`Invalid row "${part}" (row 1 is the header)`);
    for (let i = a; i <= (b || a); i++) out.add(i);
    if (out.size > 50) throw new Error('Max 50 rows at a time');
  }
  return [...out].sort((x, y) => x - y);
}

/** Write the Task ID into the sheet's "Task ID" column via the Apps Script web app. */
export async function writeTaskId(tabName, row, taskId) {
  const url = process.env.SHEET_WEBAPP_URL;
  if (!url) return { ok: false, error: 'SHEET_WEBAPP_URL not set — copy the Task ID into the sheet manually' };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ secret: process.env.SHEET_WEBAPP_SECRET || '', tab: tabName, row, taskId }),
    redirect: 'follow',
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: `Sheet script replied: ${text.slice(0, 120)}` }; }
}
