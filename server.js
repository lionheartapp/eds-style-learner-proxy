/**
 * Figma Style Learner — Proxy Server
 * Fixes CORS for Anthropic API calls, handles rate limiting,
 * frame hash caching, and Supabase indexing.
 *
 * Usage:
 *   npm install
 *   ANTHROPIC_API_KEY=sk-ant-xxx FIGMA_TOKEN=figd_xxx node server.js
 *
 * Optional (for Supabase auto-indexing):
 *   SUPABASE_URL=https://xxx.supabase.co
 *   SUPABASE_KEY=your-service-role-key
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
const PORT = 3579;

// ── Config ───────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const FIGMA_TOKEN   = process.env.FIGMA_TOKEN || '';
const SUPABASE_URL  = process.env.SUPABASE_URL || '';
const SUPABASE_KEY  = process.env.SUPABASE_KEY || '';
const CACHE_FILE    = path.join(__dirname, '.frame-cache.json');

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ── Frame hash cache (for delta detection) ───────────────
let frameCache = {};

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf-8');
    frameCache = JSON.parse(raw);
    console.log(`[cache] Loaded ${Object.keys(frameCache).length} cached frames`);
  } catch {
    frameCache = {};
  }
}

async function saveCache() {
  await fs.writeFile(CACHE_FILE, JSON.stringify(frameCache, null, 2));
}

function frameHash(frame) {
  return crypto
    .createHash('md5')
    .update(`${frame.id}:${frame.lastModified || frame.name}:${frame.width}:${frame.height}`)
    .digest('hex');
}

// ── Rate limiter ──────────────────────────────────────────
class RateLimiter {
  constructor(reqPerSec = 2.5) {
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

const anthropicLimiter = new RateLimiter(2.5);

// ── Routes ────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasAnthropicKey: !!ANTHROPIC_KEY,
    hasFigmaToken: !!FIGMA_TOKEN,
    hasSupabase: !!(SUPABASE_URL && SUPABASE_KEY),
    cachedFrames: Object.keys(frameCache).length
  });
});

// Figma proxy
app.get('/api/figma/*', async (req, res) => {
  const token = req.headers['x-figma-token'] || FIGMA_TOKEN;
  const figmaPath = '/' + req.params[0];
  const query = new URLSearchParams(req.query).toString();
  const url = `https://api.figma.com/v1${figmaPath}${query ? '?' + query : ''}`;

  try {
    const r = await fetch(url, { headers: { 'X-Figma-Token': token } });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Claude Vision proxy — single frame
app.post('/api/analyze-frame', async (req, res) => {
  const { frame, prompt, forceRefresh } = req.body;
  const key = process.env.ANTHROPIC_API_KEY || req.headers['x-anthropic-key'] || ANTHROPIC_KEY;

  if (!key) return res.status(400).json({ error: 'No Anthropic API key configured' });

  // Check cache
  const hash = frameHash(frame);
  if (!forceRefresh && frameCache[frame.id] && frameCache[frame.id].hash === hash) {
    console.log(`[cache] HIT: ${frame.name}`);
    return res.json({ analysis: frameCache[frame.id].analysis, cached: true });
  }

  await anthropicLimiter.wait();

  try {
    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: frame.imageB64 }
          },
          {
            type: 'text',
            text: `Frame: "${frame.name}" | File: ${frame.fileLabel} | Page: ${frame.page} | Size: ${frame.width}×${frame.height}px\n\n${prompt}`
          }
        ]
      }]
    };

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'API error' });

    const text = data.content?.[0]?.text || '{}';
    let analysis;
    try { analysis = JSON.parse(text.replace(/```json|```/g, '').trim()); }
    catch { analysis = { raw: text }; }

    // Cache it
    frameCache[frame.id] = { hash, analysis, analyzedAt: new Date().toISOString() };
    await saveCache();

    res.json({
      analysis,
      cached: false,
      usage: data.usage
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Claude synthesis proxy — full style guide
app.post('/api/synthesize', async (req, res) => {
  const { clusters, totalFrames } = req.body;
  const key = process.env.ANTHROPIC_API_KEY || req.headers['x-anthropic-key'] || ANTHROPIC_KEY;

  if (!key) return res.status(400).json({ error: 'No Anthropic API key' });

  // Build cluster summaries
  const clusterSummaries = clusters.map(cluster => {
    const sampleAnalyses = cluster.frames.slice(0, 15).map(f =>
      `  - ${f.frameName}: ${JSON.stringify(f.analysis)}`
    ).join('\n');
    return `## Cluster: ${cluster.label} (${cluster.frames.length} frames)\n${sampleAnalyses}`;
  }).join('\n\n');

  const prompt = `You are a senior design systems architect. You've analyzed ${totalFrames} design frames from a company's Figma files, grouped into clusters by frame type.

${clusterSummaries}

Synthesize a comprehensive Visual Language Guide with these sections:

# 1. Core Color System
Exact hex values for primary, secondary, accent, neutral, and semantic colors. Note any dark/light mode patterns.

# 2. Typography System
Font families, heading scale (h1–h6 sizes/weights), body text rules, caption styles. Note any font pairing logic.

# 3. Spacing & Layout
Grid system, spacing scale (4px? 8px base?), common padding values, max-width patterns, responsive breakpoints if evident.

# 4. Component Language
How the team styles: buttons (sizes, variants, border-radius), cards (shadow, border, padding), inputs, navigation, badges/chips, modals. Be specific.

# 5. Visual Personality
3–5 adjectives that describe the brand. What it feels like. What it definitely does NOT do.

# 6. Cluster-Specific Rules
For each cluster type (ads, layouts, components, mobile), what are the specific design rules?

# 7. The 10 Design Rules
Numbered list of implicit rules consistently followed across all frames. These should be opinionated and specific — not generic best practices.

# 8. New Component Checklist
When building anything new, a designer should verify these things to ensure it feels native.

Write in clear, specific markdown. Avoid vague language. This document will be injected into an AI design tool as ground truth.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 6000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message });

    res.json({ styleGuide: data.content?.[0]?.text || '', usage: data.usage });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Supabase push
app.post('/api/push-supabase', async (req, res) => {
  const { analyses, styleGuide } = req.body;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(400).json({ error: 'Supabase not configured' });
  }

  let pushed = 0, errors = 0;

  for (const a of analyses) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/design_analyses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          frame_id: a.frameId,
          frame_name: a.frameName,
          file_label: a.fileLabel,
          page_name: a.page,
          cluster: a.cluster,
          analysis: a.analysis,
          analyzed_at: new Date().toISOString()
        })
      });
      if (r.ok) pushed++; else errors++;
    } catch { errors++; }
  }

  // Push style guide
  if (styleGuide) {
    await fetch(`${SUPABASE_URL}/rest/v1/style_guides`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ content: styleGuide, generated_at: new Date().toISOString() })
    });
  }

  res.json({ pushed, errors });
});

// Cache stats
app.get('/api/cache-stats', (req, res) => {
  res.json({
    total: Object.keys(frameCache).length,
    entries: Object.entries(frameCache).map(([id, v]) => ({
      id, analyzedAt: v.analyzedAt
    }))
  });
});

app.delete('/api/cache', async (req, res) => {
  frameCache = {};
  await saveCache();
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────
await loadCache();
app.listen(PORT, () => {
  console.log(`\n┌─────────────────────────────────────────┐`);
  console.log(`│  Figma Style Learner — Proxy Server      │`);
  console.log(`│  http://localhost:${PORT}                  │`);
  console.log(`│                                          │`);
  console.log(`│  Anthropic Key: ${ANTHROPIC_KEY ? '✓ configured' : '✗ missing (set ANTHROPIC_API_KEY)'}   │`);
  console.log(`│  Figma Token:   ${FIGMA_TOKEN ? '✓ configured' : '○ optional (can use UI)'}   │`);
  console.log(`│  Supabase:      ${(SUPABASE_URL && SUPABASE_KEY) ? '✓ configured' : '○ optional'}              │`);
  console.log(`└─────────────────────────────────────────┘\n`);
});
