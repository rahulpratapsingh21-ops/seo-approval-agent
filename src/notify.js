import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

// Windows toast notification (bottom-right corner), shown through PowerShell so no extra app is needed.
// Clicking it opens the task in the CMS.
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const xmlEsc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// Clicks open in Chrome, not the default browser: links get a "syu-chrome:" prefix, a link type registered
// for this Windows user (no admin) that a small script hands to Chrome. Without Chrome the plain link is used.
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`].find((p) => existsSync(p));
let chromeReady = false;
function inChrome(url) {
  if (!CHROME || !/^https?:/.test(url || '')) return url;
  if (!chromeReady) {
    try {
      const dir = `${process.env.LOCALAPPDATA}\\SYU`, vbs = `${dir}\\open-in-chrome.vbs`, key = 'HKCU\\Software\\Classes\\syu-chrome';
      mkdirSync(dir, { recursive: true });
      writeFileSync(vbs, `u = Mid(WScript.Arguments(0), 12)\r\nCreateObject("WScript.Shell").Run """${CHROME}"" """ & u & """", 1, False\r\n`);
      const reg = (...a) => execFileSync('reg', ['add', ...a, '/f'], { windowsHide: true, stdio: 'ignore' });
      reg(key, '/ve', '/d', 'URL:SYU open in Chrome');
      reg(key, '/v', 'URL Protocol', '/d', '');
      reg(`${key}\\shell\\open\\command`, '/ve', '/d', `"${process.env.SystemRoot}\\System32\\wscript.exe" "${vbs}" "%1"`);
      chromeReady = true;
    } catch (e) { console.log('notification: Chrome link not set up —', e.message); return url; }
  }
  return `syu-chrome:${url}`;
}

// WhatsApp message (phone + laptop) through CallMeBot, free for personal alerts.
// WHATSAPP_RECIPIENTS = "919876543210:123456" (country code + number : CallMeBot apikey), comma-separated for more people.
// Sent one after another, a few seconds apart, as CallMeBot asks.
let waQueue = Promise.resolve();
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
export function sendWhatsApp(text) {
  const recipients = (process.env.WHATSAPP_RECIPIENTS || '').split(',').map((s) => s.trim().split(':')).filter(([p, k]) => p && k);
  const run = waQueue.then(async () => {
    const errors = [];
    for (const [phone, apikey] of recipients) {
      try {
        const q = new URLSearchParams({ phone: `+${phone.replace(/\D/g, '')}`, text: String(text).slice(0, 1000), apikey });
        const r = await fetch(`https://api.callmebot.com/whatsapp.php?${q}`);
        const reply = plain(await r.text());
        if (!r.ok || /error|invalid|wrong|blocked/i.test(reply)) throw new Error(`WhatsApp to ${phone}: ${reply.slice(0, 150) || `HTTP ${r.status}`}`);
      } catch (e) { errors.push(e.message); console.log('notification:', e.message); }
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    return { sent: recipients.length - errors.length, errors };
  });
  waQueue = run.catch(() => {});
  return run;
}

// Pop-up on this PC + WhatsApp. `link` is what the WhatsApp message opens (localhost is no use on a phone).
export function notify(title, body, url, link = url) {
  if (process.env.WHATSAPP_RECIPIENTS) sendWhatsApp(`*${title}*\n${body}${link ? `\n${link}` : ''}`);
  showToast(title, body, url);
}

export function showToast(title, body, url) {
  if (process.platform !== 'win32') return;
  url = inChrome(url);
  const xml = `<toast activationType="protocol" launch="${xmlEsc(url)}"><visual><binding template="ToastGeneric">`
    + `<text>${xmlEsc(title)}</text><text>${xmlEsc(String(body).slice(0, 300))}</text></binding></visual>`
    + `<actions><action content="Open in CMS" activationType="protocol" arguments="${xmlEsc(url)}"/></actions></toast>`;
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(xml).toString('base64')}')))
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show((New-Object Windows.UI.Notifications.ToastNotification $x))`;
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: 'ignore' });
  p.on('error', (e) => console.log('notification:', e.message));
}
