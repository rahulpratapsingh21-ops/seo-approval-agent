import { spawn } from 'node:child_process';

// Windows toast notification (bottom-right corner), shown through PowerShell so no extra app is needed.
// Clicking it opens the dashboard.
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const xmlEsc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function notify(title, body, url) {
  if (process.platform !== 'win32') return;
  const xml = `<toast activationType="protocol" launch="${xmlEsc(url)}"><visual><binding template="ToastGeneric">`
    + `<text>${xmlEsc(title)}</text><text>${xmlEsc(String(body).slice(0, 300))}</text></binding></visual>`
    + `<actions><action content="Open dashboard" activationType="protocol" arguments="${xmlEsc(url)}"/></actions></toast>`;
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
