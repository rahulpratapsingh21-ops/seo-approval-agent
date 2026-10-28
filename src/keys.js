// API keys editable from the dashboard. Saved to .env (so they survive restarts) and to process.env
// (so they work at once). The full key is never sent back to the browser — only whether it is set
// and its last 4 characters.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

export const KEYS = [
  {
    name: 'ANTHROPIC_API_KEY',
    label: 'Anthropic (Claude) API key',
    usedFor: 'SEO Approval Agent — writes the H1, meta title & description, URL slug, CTA text, internal-link anchors, image alt text and feature-image text. Paid; needed for fixes.',
    help: 'console.anthropic.com → Settings → API keys',
  },
  {
    name: 'GEMINI_API_KEY',
    label: 'Google Gemini API key',
    usedFor: 'SEO Approval Agent — AI photo backgrounds for feature images, when "Gemini" is chosen as the image AI. Needs billing on in Google AI Studio.',
    help: 'aistudio.google.com/apikey',
  },
  {
    name: 'OPENAI_API_KEY',
    label: 'OpenAI (ChatGPT) API key',
    usedFor: 'SEO Approval Agent — AI photo backgrounds for feature images, when "ChatGPT" is chosen as the image AI. Needs credit on platform.openai.com.',
    help: 'platform.openai.com/api-keys',
  },
];

const status = (k) => {
  const v = process.env[k.name] || '';
  return { ...k, set: !!v, last4: v ? v.slice(-4) : '' };
};
export const keyStatus = () => KEYS.map(status);

/** Save one key (empty value removes it). Returns its new status. */
export function saveKey(name, value) {
  const k = KEYS.find((x) => x.name === name);
  if (!k) throw new Error('Unknown key');
  const v = String(value || '').trim();
  if (/[\s"'`]/.test(v)) throw new Error('The key must not contain spaces or quotes');
  let text = '';
  try { text = readFileSync(ENV_FILE, 'utf8'); } catch { /* no .env yet */ }
  const line = `${name}=${v}`;
  const re = new RegExp(`^${name}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
  writeFileSync(ENV_FILE, text);
  if (v) process.env[name] = v; else delete process.env[name];
  return status(k);
}

/** Check a key with the provider (free calls: list models). */
export async function testKey(name) {
  const v = process.env[name];
  if (!v) return { ok: false, message: 'Not set' };
  try {
    if (name === 'ANTHROPIC_API_KEY') {
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': v, 'anthropic-version': '2023-06-01' } });
      const j = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, message: 'Key works (credit balance is not shown by this check)' } : { ok: false, message: j.error?.message || `HTTP ${r.status}` };
    }
    if (name === 'GEMINI_API_KEY') {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': v } });
      const j = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, message: 'Key works (image billing must be on in Google AI Studio)' } : { ok: false, message: j.error?.message || `HTTP ${r.status}` };
    }
    if (name === 'OPENAI_API_KEY') {
      const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${v}` } });
      const j = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, message: 'Key works (credit balance is not shown by this check)' } : { ok: false, message: j.error?.message || `HTTP ${r.status}` };
    }
    return { ok: false, message: 'Unknown key' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
