// Paste this into the Google Sheet: Extensions → Apps Script → replace everything → Save.
// Then Deploy → New deployment → type "Web app" → Execute as: Me → Who has access: Anyone → Deploy.
// Copy the Web app URL into the agent's SHEET_WEBAPP_URL setting.
// Set the same secret here and in SHEET_WEBAPP_SECRET so only the agent can write.

const SECRET = 'change-me';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return reply({ ok: false, error: 'Wrong secret' });

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(body.tab);
    if (!sheet) return reply({ ok: false, error: 'Tab not found: ' + body.tab });

    const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const col = header.findIndex(function (h) { return /^task\s*id$/i.test(String(h).trim()); }) + 1;
    if (!col) return reply({ ok: false, error: 'No "Task ID" column in ' + body.tab });

    const cell = sheet.getRange(Number(body.row), col);
    if (String(cell.getValue()).trim()) return reply({ ok: false, error: 'Task ID cell already filled: ' + cell.getValue() });
    cell.setValue(body.taskId);
    return reply({ ok: true, cell: cell.getA1Notation() });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
