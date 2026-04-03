/**
 * Figma Style Learner — Proxy Server
 * Uses Google Gemini for vision analysis (cheap/free tier)
 * Uses Anthropic Claude for synthesis (optional, falls back to Gemini)
 *
 * Required env vars:
 *   GEMINI_API_KEY   — aistudio.google.com (free)
 *   FIGMA_TOKEN      — figma.com settings
 *   SUPABASE_URL     — your supabase project url
 *   SUPABASE_KEY     — supabase service role key
 *
 * Optional:
 *   ANTHROPIC_API_KEY — for synthesis pass (falls back to Gemini if not set)
 *   PORT              — defaults to 3579
 */

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3579;

const GEMINI_KEY    = process.env.GEMINI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const FIGMA_TOKEN   = process.env.FIGMA_TOKEN || '';
const SUPABASE_URL  = process.env.SUPABASE_URL || '';
const SUPABASE_KEY  = process.env.SUPABASE_KEY || '';
const CACHE_FILE    = path.join(__dirname, '.frame-cache.json');

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

let frameCache = {};

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf-8');
    const loaded = JSON.parse(raw);
    // Filter out any cached error responses from old model names
    let cleaned = 0;
    for (const [id, entry] of Object.entries(loaded)) {
      const isError = entry.analysis?.raw && entry.analysis.raw.includes('is not found for API version');
      if (!isError) frameCache[id] = entry;
      else cleaned++;
    }
    console.log(`[cache] Loaded ${Object.keys(frameCache).length} cached frames (removed ${cleaned} stale errors)`);
  } catch { frameCache = {}; }
}

async function saveCache() {
  try { await fs.writeFile(CACHE_FILE, JSON.stringify(frameCache, null, 2)); }
  catch(e) { console.warn('[cache] Could not save:', e.message); }
}

function frameHash(frame) {
  return crypto.createHash('md5')
    .update(`${frame.id}:${frame.lastModified || frame.name}:${frame.width}:${frame.height}`)
    .digest('hex');
}

class RateLimiter {
  constructor(reqPerSec = 2) {
    this.interval = 1000 / reqPerSec;
    this.lastCall = 0;
  }
  async wait() {
    const now = Date.now();
    const wait = Math.max(0, this.interval - (now - this.lastCall));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastCall = Date.now();
  }
}

const geminiLimiter = new RateLimiter(2);

async function analyzeWithGemini(imageB64, textPrompt, apiKey) {
  await geminiLimiter.wait();
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'image/png', data: imageB64 } },
      { text: textPrompt }
    ]}],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1200 }
  };
  const r = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Gemini error ${r.status}`);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
}

async function synthesizeWithGemini(prompt, apiKey) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192 }
  };
  const r = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Gemini error ${r.status}`);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasGeminiKey: !!GEMINI_KEY,
    hasAnthropicKey: !!ANTHROPIC_KEY,
    hasFigmaToken: !!FIGMA_TOKEN,
    hasSupabase: !!(SUPABASE_URL && SUPABASE_KEY),
    cachedFrames: Object.keys(frameCache).length,
    visionProvider: GEMINI_KEY ? 'gemini' : 'none',
    synthesisProvider: ANTHROPIC_KEY ? 'anthropic' : GEMINI_KEY ? 'gemini' : 'none'
  });
});

app.get('/api/figma/*', async (req, res) => {
  const token = req.headers['x-figma-token'] || FIGMA_TOKEN;
  const figmaPath = '/' + req.params[0];
  const query = new URLSearchParams(req.query).toString();
  const url = `https://api.figma.com/v1${figmaPath}${query ? '?' + query : ''}`;
  try {
    const r = await fetch(url, { headers: { 'X-Figma-Token': token } });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/analyze-frame', async (req, res) => {
  const { frame, prompt, forceRefresh } = req.body;
  const geminiKey = req.headers['x-gemini-key'] || GEMINI_KEY;
  if (!geminiKey) return res.status(400).json({ error: 'No Gemini API key. Add GEMINI_API_KEY to Railway variables.' });
  if (!frame.imageB64) return res.status(400).json({ error: 'No image data' });

  const hash = frameHash(frame);
  if (!forceRefresh && frameCache[frame.id] && frameCache[frame.id].hash === hash) {
    console.log(`[cache] HIT: ${frame.name}`);
    return res.json({ analysis: frameCache[frame.id].analysis, cached: true });
  }

  const textPrompt = `Frame: "${frame.name}" | File: ${frame.fileLabel} | Page: ${frame.page} | Size: ${frame.width}x${frame.height}px\n\n${prompt}`;

  try {
    const rawText = await analyzeWithGemini(frame.imageB64, textPrompt, geminiKey);
    let analysis;
    try { analysis = JSON.parse(rawText.replace(/```json|```/g, '').trim()); }
    catch { analysis = { raw: rawText }; }
    frameCache[frame.id] = { hash, analysis, analyzedAt: new Date().toISOString() };
    await saveCache();
    console.log(`[gemini] OK: ${frame.name}`);
    res.json({ analysis, cached: false });
  } catch(e) {
    console.error(`[gemini] ERR: ${frame.name}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/synthesize', async (req, res) => {
  const { clusters, totalFrames } = req.body;
  const anthropicKey = req.headers['x-anthropic-key'] || ANTHROPIC_KEY;
  const geminiKey = req.headers['x-gemini-key'] || GEMINI_KEY;
  if (!anthropicKey && !geminiKey) return res.status(400).json({ error: 'No API key for synthesis' });

  const clusterSummaries = clusters.map(cl => {
    const samples = cl.frames.slice(0, 15).map(f => `  - ${f.frameName}: ${JSON.stringify(f.analysis)}`).join('\n');
    return `## Cluster: ${cl.label} (${cl.frames.length} frames)\n${samples}`;
  }).join('\n\n');

  const prompt = `You are a senior design systems architect. You have analyzed ${totalFrames} design frames from a company's Figma files grouped into clusters.\n\n${clusterSummaries}\n\nSynthesize a comprehensive Visual Language Guide:\n\n# 1. Core Color System\nExact hex values for primary, secondary, accent, neutral, semantic colors.\n\n# 2. Typography System\nFont families, heading scale, body text rules, caption styles.\n\n# 3. Spacing & Layout\nGrid system, spacing scale, common padding, max-width, breakpoints.\n\n# 4. Component Language\nButtons, cards, inputs, navigation, badges, modals — be specific.\n\n# 5. Visual Personality\n3-5 adjectives. What it feels like. What it never does.\n\n# 6. Cluster-Specific Rules\nSpecific rules per cluster type.\n\n# 7. The 10 Design Rules\nOpinionated, specific rules consistently followed across frames.\n\n# 8. New Component Checklist\nVerify these before shipping anything new.\n\nWrite in clear specific markdown. This is injected into an AI design tool as ground truth.`;

  try {
    let styleGuide = '';
    if (anthropicKey) {
      console.log('[synthesis] Using Anthropic');
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 6000, messages: [{ role: 'user', content: prompt }] })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message);
      styleGuide = data.content?.[0]?.text || '';
    } else {
      console.log('[synthesis] Using Gemini fallback');
      styleGuide = await synthesizeWithGemini(prompt, geminiKey);
    }
    res.json({ styleGuide, provider: anthropicKey ? 'anthropic' : 'gemini' });
  } catch(e) {
    console.error('[synthesis] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/push-supabase', async (req, res) => {
  const { analyses, styleGuide } = req.body;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(400).json({ error: 'Supabase not configured' });
  let pushed = 0, errors = 0;
  for (const a of analyses) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/design_analyses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ frame_id: a.frameId, frame_name: a.frameName, file_label: a.fileLabel, page_name: a.page, cluster: a.cluster, analysis: a.analysis, analyzed_at: new Date().toISOString() })
      });
      if (r.ok) pushed++; else errors++;
    } catch { errors++; }
  }
  if (styleGuide) {
    await fetch(`${SUPABASE_URL}/rest/v1/style_guides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ content: styleGuide, generated_at: new Date().toISOString() })
    });
  }
  res.json({ pushed, errors });
});

app.get('/api/cache-stats', (req, res) => {
  res.json({ total: Object.keys(frameCache).length, entries: Object.entries(frameCache).map(([id, v]) => ({ id, analyzedAt: v.analyzedAt })) });
});

app.delete('/api/cache', async (req, res) => {
  frameCache = {};
  await saveCache();
  res.json({ ok: true });
});

await loadCache();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n Figma Style Learner Proxy running on port ${PORT}`);
  console.log(` Vision:    ${GEMINI_KEY    ? 'Gemini OK'        : 'GEMINI_API_KEY missing'}`);
  console.log(` Synthesis: ${ANTHROPIC_KEY ? 'Anthropic OK'     : 'Gemini fallback'}`);
  console.log(` Figma:     ${FIGMA_TOKEN   ? 'Token configured' : 'set via UI'}`);
  console.log(` Supabase:  ${(SUPABASE_URL && SUPABASE_KEY) ? 'configured' : 'not configured'}\n`);
});
