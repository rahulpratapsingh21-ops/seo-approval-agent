// Photo backgrounds for feature images, made by an image AI. The scene never contains text:
// the agent adds the title, year, logos and brand itself (image AIs misspell words).
// IMAGE_PROVIDER (set from the dashboard) picks one at a time: "gemini", "openai" (ChatGPT) or "off".

export const PROVIDERS = { gemini: { name: 'Gemini', key: 'GEMINI_API_KEY' }, openai: { name: 'ChatGPT (OpenAI)', key: 'OPENAI_API_KEY' } };
const provider = () => process.env.IMAGE_PROVIDER || 'gemini';
/** True when the chosen image AI has its key. */
export const imageAiReady = () => !!PROVIDERS[provider()] && !!process.env[PROVIDERS[provider()].key];
export const imageAiName = () => PROVIDERS[provider()]?.name || 'off';

function prompt(scene) {
  return `Photorealistic 16:9 editorial photo for an Indian education news article. Scene: ${scene}.
Bright natural daylight, sharp focus, warm and positive mood, clean modern look, high detail.
Composition (important): any person sits in the LEFT third of the frame, never in the middle; the centre and the right
two thirds of the upper half are open and calm (plain wall, window light or sky, softly out of focus) because a large
headline goes in the centre-right and a round logo on the far right. Desk objects may sit along the bottom edge.
Absolutely no text, letters, numbers, signs, logos, labels or watermarks anywhere in the image.`;
}

async function gemini(scene) {
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt(scene) }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gemini image: ${j.error?.message || r.status}`);
  const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new Error('Gemini image: no image returned');
  return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
}

async function openai(scene) {
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2', prompt: prompt(scene), size: '1536x1024', quality: 'medium', n: 1 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI image: ${j.error?.message || r.status}`);
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI image: no image returned');
  return `data:image/png;base64,${b64}`;
}

/** A photo scene as a data URI from the chosen image AI. Throws when it fails. */
export async function generateScene(scene) {
  return provider() === 'openai' ? openai(scene) : gemini(scene);
}
