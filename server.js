/**
 * Figma Style Learner — Full Server-Side Pipeline
 * Runs entirely on Railway — no browser needed after triggering
 *
 * Env vars:
 *   GEMINI_API_KEY, FIGMA_TOKEN, SUPABASE_URL, SUPABASE_KEY
 *   ANTHROPIC_API_KEY (optional, better synthesis)
 *   MAX_FRAMES_PER_FILE (default 30)
 *   MIN_FRAME_WIDTH (default 160)
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
const MAX_FRAMES    = parseInt(process.env.MAX_FRAMES_PER_FILE) || 30;
const MIN_WIDTH     = parseInt(process.env.MIN_FRAME_WIDTH) || 160;
const FILE_FILTER   = process.env.FILE_FILTER || '\\[[A-Z]+-\\d+\\]';
const GEMINI_MODEL  = 'gemini-2.0-flash';
const GEMINI_URL    = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const EDMUNDS_TEAMS = [
  { id: '1038197350560087985', label: 'Design System' },
  { id: '1037441437571487478', label: 'Core Pages' },
  { id: '1043678046766663830', label: 'Appraisal' },
  { id: '1035273870646275860', label: 'Appraisal Widget' },
  { id: '1043677877898352778', label: 'Article Pages' },
  { id: '1043678230508743840', label: 'Home Landing Pages' },
  { id: '1479241863559912953', label: 'Search' },
  { id: '1043678153826386076', label: 'Emails' },
  { id: '1043677710304980101', label: 'Ads' },
  { id: '1035273527546695407', label: 'CarCode' },
  { id: '1482534511005199527', label: 'Design Stage AI' }
];

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// Job state
let job = {
  running: false, status: 'idle', startedAt: null, phase: null,
  progress: { files: 0, pages: 0, frames: 0, analyzed: 0, errors: 0, cached: 0 },
  log: [], result: null
};

function jobLog(msg, type = 'info') {
  const entry = { time: new Date().toISOString(), msg, type };
  job.log.push(entry);
  if (job.log.length > 500) job.log = job.log.slice(-500);
  console.log(`[${type}] ${msg}`);
}

// Cache
let frameCache = {};

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf-8');
    const loaded = JSON.parse(raw);
    let cleaned = 0;
    for (const [id, entry] of Object.entries(loaded)) {
      const isError = entry.analysis?.raw && entry.analysis.raw.includes('is not found for API version');
      if (!isError) frameCache[id] = entry;
      else cleaned++;
    }
    console.log(`[cache] Loaded ${Object.keys(frameCache).length} frames (removed ${cleaned} stale errors)`);
  } catch { frameCache = {}; }
}

async function saveCache() {
  try { await fs.writeFile(CACHE_FILE, JSON.stringify(frameCache, null, 2)); }
  catch(e) { console.warn('[cache] Save failed:', e.message); }
}

function frameHash(frame) {
  return crypto.createHash('md5')
    .update(`${frame.id}:${frame.name}:${frame.width}:${frame.height}`)
    .digest('hex');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class RateLimiter {
  constructor(rps = 2) { this.interval = 1000/rps; this.last = 0; }
  async wait() {
    const wait = Math.max(0, this.interval - (Date.now() - this.last));
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
  }
}

const geminiLimiter = new RateLimiter(2);
const figmaLimiter  = new RateLimiter(1.5);

async function figmaGet(p) {
  await figmaLimiter.wait();
  const r = await fetch(`https://api.figma.com/v1${p}`, { headers: { 'X-Figma-Token': FIGMA_TOKEN } });
  const data = await r.json();
  if (!r.ok) throw new Error(data.err || `Figma ${r.status}`);
  return data;
}

function classifyFrame(frame) {
  const name = (frame.name || '').toLowerCase();
  const w = frame.width, h = frame.height;
  const adSizes = [[300,250],[728,90],[320,50],[160,600],[300,600],[970,250],[320,480],[375,667]];
  if (adSizes.some(([aw,ah]) => Math.abs(w-aw)<15 && Math.abs(h-ah)<15)) return 'Ad Units';
  if (w <= 430) return 'Mobile';
  if (name.match(/button|btn|card|modal|dialog|dropdown|input|form|chip|badge|tag|avatar|icon|nav|header|footer|sidebar|component/)) return 'Components';
  if (name.match(/page|screen|layout|home|dashboard|landing|detail|search|list|feed|grid|srp|vdp/)) return 'Layouts';
  return 'Other';
}

const ANALYSIS_PROMPT = `Analyze this UI design frame. Return ONLY valid JSON, no markdown:
{"colors":{"dominant":["#hex"],"accents":["#hex"],"background":"#hex","text":"#hex"},"typography":{"fonts":["name"],"headingWeight":"string","scale":"string","style":"string"},"layout":{"type":"string","columns":0,"spacing":"string","density":"string"},"components":[{"type":"string","style":"string"}],"brand":{"tone":"string","keywords":["string"]},"designNotes":"1-2 sentences on standout design choices"}`;

async function analyzeFrame(imageB64) {
  await geminiLimiter.wait();
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'image/png', data: imageB64 } },
      { text: ANALYSIS_PROMPT }
    ]}],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1200 }
  };
  const r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Gemini ${r.status}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch { return { raw: text }; }
}

async function synthesize(analyses, tokens = null) {
  const clusters = {};
  analyses.forEach(a => { if (!clusters[a.cluster]) clusters[a.cluster] = []; clusters[a.cluster].push(a); });
  const clusterSummaries = Object.entries(clusters).map(([label, frames]) => {
    const samples = frames.slice(0,12).map(f => `  - ${f.frameName}: ${JSON.stringify(f.analysis)}`).join('\n');
    return `## ${label} (${frames.length} frames)\n${samples}`;
  }).join('\n\n');

  // Build token context if available
  let tokenContext = '';
  if (tokens && (tokens.variables?.length || tokens.colorStyles?.length)) {
    const colorVars = tokens.variables.filter(v => v.type === 'COLOR').slice(0, 60);
    const floatVars = tokens.variables.filter(v => v.type === 'FLOAT').slice(0, 40);
    const colorStyles = tokens.colorStyles.slice(0, 40);
    const textStyles  = tokens.textStyles.slice(0, 30);

    tokenContext = `
## ACTUAL DESIGN TOKENS (source of truth — use these exact values)

### Color Variables (${colorVars.length} found)
${colorVars.map(v => `- ${v.name}: ${JSON.stringify(v.values)}`).join('\n')}

### Spacing/Size Variables (${floatVars.length} found)
${floatVars.map(v => `- ${v.name}: ${JSON.stringify(v.values)}`).join('\n')}

### Published Color Styles (${colorStyles.length} found)
${colorStyles.map(s => `- ${s.name}${s.description ? ': ' + s.description : ''}`).join('\n')}

### Published Text Styles (${textStyles.length} found)
${textStyles.map(s => `- ${s.name}${s.description ? ': ' + s.description : ''}`).join('\n')}
`;
  }

  const prompt = `You are a senior design systems architect at Edmunds (automotive marketplace).
You analyzed ${analyses.length} frames from Edmunds Figma files.
${tokenContext}
## VISUAL ANALYSIS (from frame screenshots)
${clusterSummaries}

${tokenContext ? 'IMPORTANT: Where design tokens are provided above, use those EXACT values in the style guide. They are the source of truth.' : ''}

Write a Visual Language Guide with these exact sections:

# 1. Core Color System
${tokenContext ? 'Use the exact token values provided. Name each color by its token name.' : 'Exact hex values. Note: Edmunds primary is navy blue and orange accent.'}

# 2. Typography System
${tokenContext ? 'Use the exact text style names and values from tokens.' : 'Note: Edmunds primary font is Helvetica Neue. Document the full type scale.'}

# 3. Spacing & Layout
${tokenContext ? 'Use the exact spacing token values.' : 'Grid, spacing scale, padding values, max-width, breakpoints.'}

# 4. Component Language
Buttons, cards, inputs, navigation — specific to Edmunds style.

# 5. Visual Personality
3-5 adjectives. What Edmunds feels like. What it never does.

# 6. Cluster-Specific Rules
Rules per cluster type.

# 7. The 10 Design Rules
Opinionated specific rules from the analyzed frames.

# 8. New Component Checklist
Verify before shipping anything new.

Write clear specific markdown. This is injected into AI tools as ground truth for Edmunds design.`;

  if (ANTHROPIC_KEY) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 6000, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message);
    return data.content?.[0]?.text || '';
  } else {
    const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 8192 } };
    const r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message);
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
}

async function pushToSupabase(analyses, styleGuide) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { pushed: 0, errors: 0 };
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
    await sleep(50);
  }
  if (styleGuide) {
    await fetch(`${SUPABASE_URL}/rest/v1/style_guides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ content: styleGuide, generated_at: new Date().toISOString() })
    });
  }
  return { pushed, errors };
}

async function runPipeline(options = {}) {
  if (job.running) return;
  job.running = true; job.status = 'running'; job.startedAt = new Date().toISOString();
  job.phase = 'discover'; job.progress = { files: 0, pages: 0, frames: 0, analyzed: 0, errors: 0, cached: 0 };
  job.log = []; job.result = null;

  const maxF = options.maxFrames || MAX_FRAMES;
  const minW  = options.minWidth  || MIN_WIDTH;
  const teams = options.teams || EDMUNDS_TEAMS;
  const filterRx = new RegExp(FILE_FILTER, 'i');

  try {
    // Phase 1: Discover
    jobLog(`Pipeline start — ${teams.length} teams, ${maxF} frames/file`);
    const allFiles = [];
    for (const team of teams) {
      if (!job.running) break;
      jobLog(`Scanning: ${team.label}`);
      // Design System team — crawl ALL files, no Jira filter
      const useFilter = team.id !== '1038197350560087985';
      try {
        const pd = await figmaGet(`/teams/${team.id}/projects`);
        for (const proj of (pd.projects || [])) {
          const fd = await figmaGet(`/projects/${proj.id}/files`);
          for (const f of (fd.files || [])) {
            if (!useFilter || filterRx.test(f.name)) {
              allFiles.push({ key: f.key, name: f.name, teamLabel: team.label });
            }
          }
          await sleep(200);
        }
      } catch(e) { jobLog(`Scan failed ${team.label}: ${e.message}`, 'warn'); }
    }
    jobLog(`Discovered ${allFiles.length} files`);

    // Phase 1b: Extract tokens & styles from Design System files
    job.phase = 'tokens';
    jobLog('Extracting design tokens and styles from Design System files...');
    const allTokens = { collections: [], variables: [], colorStyles: [], textStyles: [], effectStyles: [] };
    const dsFiles = allFiles.filter(f => f.teamLabel === 'Design System');

    for (const file of dsFiles) {
      if (!job.running) break;

      // Fetch variables (design tokens)
      try {
        const varsData = await figmaGet(`/files/${file.key}/variables/local`);
        const collections = Object.values(varsData.meta?.variableCollections || {});
        const variables   = Object.values(varsData.meta?.variables || {});

        collections.forEach(c => allTokens.collections.push({
          id: c.id, name: c.name, file: file.name,
          modes: c.modes?.map(m => ({ id: m.modeId, name: m.name })) || []
        }));

        variables.forEach(v => allTokens.variables.push({
          id: v.id, name: v.name, type: v.resolvedType,
          collection: v.variableCollectionId,
          values: v.valuesByMode, file: file.name
        }));

        jobLog(`  Tokens: ${variables.length} variables from ${file.name}`);
      } catch(e) {
        jobLog(`  Variables not available for ${file.name}: ${e.message}`, 'warn');
      }

      // Fetch published styles
      try {
        const stylesData = await figmaGet(`/files/${file.key}/styles`);
        const styles = stylesData.meta?.styles || [];

        styles.forEach(s => {
          const entry = { id: s.node_id, name: s.name, description: s.description || '', file: file.name };
          if (s.style_type === 'FILL')   allTokens.colorStyles.push(entry);
          if (s.style_type === 'TEXT')   allTokens.textStyles.push(entry);
          if (s.style_type === 'EFFECT') allTokens.effectStyles.push(entry);
        });

        jobLog(`  Styles: ${styles.length} styles from ${file.name} (${allTokens.colorStyles.length} colors, ${allTokens.textStyles.length} text)`);
      } catch(e) {
        jobLog(`  Styles not available for ${file.name}: ${e.message}`, 'warn');
      }

      await sleep(400);
    }

    // Push tokens to Supabase
    if (allTokens.variables.length > 0 || allTokens.colorStyles.length > 0) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/design_tokens`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify({ id: 'latest', tokens: allTokens, extracted_at: new Date().toISOString() })
        });
        jobLog(`Tokens saved to Supabase: ${allTokens.variables.length} variables, ${allTokens.colorStyles.length} color styles, ${allTokens.textStyles.length} text styles`);
      } catch(e) {
        jobLog(`Token Supabase push failed: ${e.message}`, 'warn');
      }
    }

    // Store token summary for synthesis
    job.tokenSummary = allTokens;
    job.phase = 'crawl';
    const frames = [];
    for (const file of allFiles) {
      if (!job.running) break;
      let fd;
      try { fd = await figmaGet(`/files/${file.key}?depth=2`); }
      catch(e) {
        if (e.message.includes('429')) { jobLog('Rate limited, waiting 15s', 'warn'); await sleep(15000); try { fd = await figmaGet(`/files/${file.key}?depth=2`); } catch(e2) { jobLog(`Skip ${file.name}: ${e2.message}`, 'error'); continue; } }
        else { jobLog(`Skip ${file.name}: ${e.message}`, 'error'); continue; }
      }
      job.progress.files++;
      let fileFrames = 0;
      for (const page of (fd.document?.children || [])) {
        job.progress.pages++;
        for (const node of (page.children || [])) {
          if (fileFrames >= maxF) break;
          if (!['FRAME','COMPONENT','COMPONENT_SET'].includes(node.type)) continue;
          const w = node.absoluteBoundingBox?.width || 0;
          if (w < minW) continue;
          const h = node.absoluteBoundingBox?.height || 0;
          frames.push({ id: node.id, name: node.name, fileKey: file.key, fileLabel: `${file.teamLabel} / ${file.name}`, page: page.name, width: w, height: h, type: node.type, cluster: classifyFrame({ name: node.name, width: w, height: h }) });
          fileFrames++; job.progress.frames++;
        }
      }
      jobLog(`Crawled ${file.name}: ${fileFrames} frames`);
      await sleep(500);
    }
    jobLog(`Crawl done: ${frames.length} frames`);

    // Phase 3: Screenshots
    job.phase = 'screenshots';
    const byFile = {};
    frames.forEach(f => { (byFile[f.fileKey] = byFile[f.fileKey] || []).push(f); });
    for (const [fk, ff] of Object.entries(byFile)) {
      for (let i = 0; i < ff.length; i += 10) {
        if (!job.running) break;
        const batch = ff.slice(i, i+10);
        const ids = batch.map(f => f.id).join(',');
        try {
          const img = await figmaGet(`/images/${fk}?ids=${encodeURIComponent(ids)}&scale=0.5&format=png`);
          batch.forEach(f => { if (img.images?.[f.id]) f.imageUrl = img.images[f.id]; });
        } catch(e) { jobLog(`Screenshot batch failed: ${e.message}`, 'warn'); }
        await sleep(500);
      }
    }

    jobLog('Downloading image bytes...');
    let dl = 0;
    for (const frame of frames) {
      if (!frame.imageUrl) continue;
      try {
        const r = await fetch(frame.imageUrl);
        const buf = await r.buffer();
        frame.imageB64 = buf.toString('base64'); dl++;
        if (dl % 25 === 0) jobLog(`Downloaded ${dl} images`);
      } catch {}
      await sleep(30);
    }
    jobLog(`${dl} images ready`);

    // Phase 4: Analyze
    job.phase = 'analyze';
    const analyses = [];
    const withImg = frames.filter(f => f.imageB64);
    jobLog(`Analyzing ${withImg.length} frames with Gemini...`);
    for (const frame of withImg) {
      if (!job.running) break;
      const hash = frameHash(frame);
      if (frameCache[frame.id] && frameCache[frame.id].hash === hash) {
        analyses.push({ frameId: frame.id, frameName: frame.name, fileLabel: frame.fileLabel, page: frame.page, cluster: frame.cluster, width: frame.width, height: frame.height, analysis: frameCache[frame.id].analysis });
        job.progress.cached++; job.progress.analyzed++; continue;
      }
      try {
        const analysis = await analyzeFrame(frame.imageB64);
        analyses.push({ frameId: frame.id, frameName: frame.name, fileLabel: frame.fileLabel, page: frame.page, cluster: frame.cluster, width: frame.width, height: frame.height, analysis });
        frameCache[frame.id] = { hash, analysis, analyzedAt: new Date().toISOString() };
        job.progress.analyzed++;
        if (job.progress.analyzed % 10 === 0) { await saveCache(); jobLog(`Analyzed ${job.progress.analyzed}/${withImg.length}`); }
      } catch(e) { job.progress.errors++; jobLog(`Error ${frame.name}: ${e.message}`, 'error'); }
    }
    await saveCache();
    jobLog(`Analysis done: ${analyses.length} frames`);

    // Phase 5: Synthesize
    job.phase = 'synthesize';
    jobLog('Synthesizing style guide...');
    const styleGuide = await synthesize(analyses, job.tokenSummary);
    jobLog(`Style guide: ${styleGuide.length.toLocaleString()} chars`);

    // Phase 6: Push
    job.phase = 'push';
    const { pushed, errors } = await pushToSupabase(analyses, styleGuide);
    jobLog(`Pushed ${pushed} to Supabase (${errors} errors)`);

    job.status = 'complete'; job.phase = 'done';
    job.result = { framesAnalyzed: analyses.length, pushed, styleGuideLength: styleGuide.length, completedAt: new Date().toISOString() };
    jobLog('Pipeline complete!');

  } catch(e) {
    job.status = 'error'; job.phase = 'error';
    jobLog(`Pipeline failed: ${e.message}`, 'error');
  } finally {
    job.running = false;
  }
}

// Routes
app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasGeminiKey: !!GEMINI_KEY, hasAnthropicKey: !!ANTHROPIC_KEY, hasFigmaToken: !!FIGMA_TOKEN, hasSupabase: !!(SUPABASE_URL && SUPABASE_KEY), cachedFrames: Object.keys(frameCache).length, job: { status: job.status, phase: job.phase, running: job.running } });
});

app.post('/api/trigger-run', (req, res) => {
  if (job.running) return res.status(409).json({ error: 'Already running', job });
  const options = { maxFrames: req.body?.maxFrames || MAX_FRAMES, minWidth: req.body?.minWidth || MIN_WIDTH, teams: req.body?.teams || EDMUNDS_TEAMS };
  runPipeline(options);
  res.json({ ok: true, message: 'Pipeline started', options });
});

app.get('/api/job-status', (req, res) => {
  res.json({ status: job.status, phase: job.phase, running: job.running, startedAt: job.startedAt, progress: job.progress, recentLog: job.log.slice(-50), result: job.result });
});

app.post('/api/stop-run', (req, res) => {
  if (!job.running) return res.json({ ok: false, message: 'No job running' });
  job.running = false; job.status = 'stopped';
  res.json({ ok: true, message: 'Stop requested' });
});

app.get('/api/figma/*', async (req, res) => {
  const p = '/' + req.params[0];
  const q = new URLSearchParams(req.query).toString();
  const url = `https://api.figma.com/v1${p}${q ? '?'+q : ''}`;
  try {
    const r = await fetch(url, { headers: { 'X-Figma-Token': FIGMA_TOKEN } });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/analyze-frame', async (req, res) => {
  const { frame, forceRefresh } = req.body;
  if (!GEMINI_KEY) return res.status(400).json({ error: 'No Gemini key' });
  if (!frame?.imageB64) return res.status(400).json({ error: 'No image' });
  const hash = frameHash(frame);
  if (!forceRefresh && frameCache[frame.id]?.hash === hash) return res.json({ analysis: frameCache[frame.id].analysis, cached: true });
  try {
    const analysis = await analyzeFrame(frame.imageB64);
    frameCache[frame.id] = { hash, analysis, analyzedAt: new Date().toISOString() };
    await saveCache();
    res.json({ analysis, cached: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/synthesize', async (req, res) => {
  const { clusters } = req.body;
  const analyses = (clusters || []).flatMap(c => c.frames || []);
  try { res.json({ styleGuide: await synthesize(analyses), provider: ANTHROPIC_KEY ? 'anthropic' : 'gemini' }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/push-supabase', async (req, res) => {
  const result = await pushToSupabase(req.body?.analyses || [], req.body?.styleGuide);
  res.json(result);
});

app.get('/api/supabase-data', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(400).json({ error: 'Supabase not configured' });
  try {
    const [aRes, sgRes, tkRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/design_analyses?select=*&order=analyzed_at.desc&limit=500`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/style_guides?select=*&order=generated_at.desc&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/design_tokens?select=*&order=extracted_at.desc&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      })
    ]);
    const analyses = await aRes.json();
    const guides   = await sgRes.json();
    const tokens   = await tkRes.json();
    res.json({
      analyses:   Array.isArray(analyses) ? analyses : [],
      styleGuide: guides[0]?.content || '',
      tokens:     tokens[0]?.tokens || null
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cache-stats', (req, res) => res.json({ total: Object.keys(frameCache).length }));
app.delete('/api/cache', async (req, res) => { frameCache = {}; await saveCache(); res.json({ ok: true }); });

await loadCache();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n EDS Style Learner running on port ${PORT}`);
  console.log(` Gemini: ${GEMINI_KEY ? 'OK' : 'MISSING'} | Figma: ${FIGMA_TOKEN ? 'OK' : 'MISSING'} | Supabase: ${(SUPABASE_URL&&SUPABASE_KEY)?'OK':'MISSING'}`);
  console.log(` Max frames/file: ${MAX_FRAMES} | Min width: ${MIN_WIDTH}px\n`);
});
