import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env') });
const DATA_FILE = join(ROOT, 'data', 'db.json');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(ROOT, 'public')));

// ── JSON "database" ──────────────────────────────────────────────────────────
let memoryDB = null;

function loadDB() {
  if (memoryDB) return memoryDB;
  if (!existsSync(DATA_FILE)) memoryDB = { profiles: {}, picks: [] };
  else {
    try { memoryDB = JSON.parse(readFileSync(DATA_FILE, 'utf8')); }
    catch { memoryDB = { profiles: {}, picks: [] }; }
  }
  return memoryDB;
}
function saveDB(db) {
  memoryDB = db;
  if (process.env.VERCEL) return false;
  try {
    writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
    return true;
  } catch {
    return false;
  }
}

// ── ENV / API keys ────────────────────────────────────────────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY  || '';
const POLYGON_KEY    = process.env.POLYGON_API_KEY     || '';
const FINNHUB_KEY    = process.env.FINNHUB_API_KEY     || '';
const NEWSAPI_KEY    = process.env.NEWSAPI_KEY         || '';
const CLAUDE_MODEL   = process.env.CLAUDE_MODEL        || 'claude-sonnet-4-6';
const CHAT_MODEL     = process.env.CHAT_MODEL          || 'claude-haiku-4-5';
const ANALYSIS_TIMEOUT_MS = 180_000;
const CHAT_TIMEOUT_MS     = 45_000;
const ANTHROPIC_RETRIES   = 2;

function isRetryableError(err) {
  if (err?.name === 'AbortError') return false;
  const msg = (err?.message || '').toLowerCase();
  if (msg.includes('timed out') || msg.includes('timeout')) return false;
  return msg.includes('hang up') || msg.includes('econnreset') || msg.includes('etimedout')
    || msg.includes('socket') || msg.includes('network') || msg.includes('econnrefused');
}

async function callAnthropic(payload, { timeoutMs = ANALYSIS_TIMEOUT_MS, retries = ANTHROPIC_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await r.json();
      if (!r.ok || data.type === 'error') {
        const msg = data.error?.message || data.message || `Anthropic API error (${r.status})`;
        throw new Error(msg);
      }
      return data;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err.name === 'AbortError'
        ? new Error('Request timed out — try again or ask a shorter question')
        : err;
      if (attempt < retries && isRetryableError(lastErr)) {
        await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

// ── Polygon: real-time quote ──────────────────────────────────────────────────
async function getPolygonQuote(ticker) {
  if (!POLYGON_KEY) return null;
  try {
    const r = await fetch(
      `https://api.polygon.io/v2/last/trade/${ticker}?apiKey=${POLYGON_KEY}`,
      { timeout: 5000 }
    );
    const d = await r.json();
    return d.results ? { price: d.results.p, size: d.results.s } : null;
  } catch { return null; }
}

// Free-tier fallback: previous daily bar close
async function getPolygonPrevClose(ticker) {
  if (!POLYGON_KEY) return null;
  try {
    const r = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${POLYGON_KEY}`,
      { timeout: 5000 }
    );
    const d = await r.json();
    const bar = d.results?.[0];
    if (!bar?.c) return null;
    return {
      price:      bar.c,
      change_pct: bar.o ? +(((bar.c - bar.o) / bar.o) * 100).toFixed(2) : null,
      volume:     bar.v,
      open:       bar.o,
      high:       bar.h,
      low:        bar.l,
      source:     'prev_close',
    };
  } catch { return null; }
}

// ── Polygon: snapshot (price + change), with prev-close fallback ──────────────
async function getPolygonSnapshot(ticker) {
  if (!POLYGON_KEY) return null;
  try {
    const r = await fetch(
      `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${POLYGON_KEY}`,
      { timeout: 5000 }
    );
    const d = await r.json();
    const t = d.ticker;
    if (t) {
      return {
        price:      t.day?.c || t.prevDay?.c,
        change_pct: t.todaysChangePerc,
        volume:     t.day?.v,
        open:       t.day?.o,
        high:       t.day?.h,
        low:        t.day?.l,
        source:     'snapshot',
      };
    }
  } catch { /* fall through */ }
  return getPolygonPrevClose(ticker);
}

// ── Finnhub: company info + earnings ─────────────────────────────────────────
async function getFinnhubData(ticker) {
  if (!FINNHUB_KEY) return null;
  try {
    const [profileRes, earningsRes, sentRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${FINNHUB_KEY}`),
      fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${ticker}&limit=4&token=${FINNHUB_KEY}`),
      fetch(`https://finnhub.io/api/v1/news-sentiment?symbol=${ticker}&token=${FINNHUB_KEY}`),
    ]);
    const [profile, earnings, sent] = await Promise.all([profileRes.json(), earningsRes.json(), sentRes.json()]);
    return { profile, earnings, sentiment: sent };
  } catch { return null; }
}

// ── NewsAPI: latest news for ticker ──────────────────────────────────────────
async function getNews(company) {
  if (!NEWSAPI_KEY) return [];
  try {
    const q = encodeURIComponent(company);
    const r = await fetch(
      `https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=5&apiKey=${NEWSAPI_KEY}`,
      { timeout: 6000 }
    );
    const d = await r.json();
    return (d.articles || []).slice(0, 5).map(a => ({
      headline: a.title,
      source:   a.source?.name || 'News',
      url:      a.url,
      publishedAt: a.publishedAt,
    }));
  } catch { return []; }
}

// ── Finnhub: insider transactions ────────────────────────────────────────────
async function getInsiderData(ticker) {
  if (!FINNHUB_KEY) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${ticker}&token=${FINNHUB_KEY}`);
    const d = await r.json();
    const txns = (d.data || []).slice(0, 10);
    const buys  = txns.filter(t => t.change > 0).reduce((s, t) => s + t.change, 0);
    const sells = txns.filter(t => t.change < 0).reduce((s, t) => s + Math.abs(t.change), 0);
    return { buys, sells, ratio: sells > 0 ? (buys / (buys + sells) * 100).toFixed(0) : 100 };
  } catch { return null; }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Save / load investor profile
app.post('/api/profile', (req, res) => {
  const { sessionId, profile } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const db = loadDB();
  db.profiles[sessionId] = { ...profile, updatedAt: new Date().toISOString() };
  const persisted = saveDB(db);
  res.json({ ok: true, persisted });
});

app.get('/api/profile/:sessionId', (req, res) => {
  const db = loadDB();
  const p = db.profiles[req.params.sessionId];
  res.json(p || null);
});

// Save a pick to the Conviction Leaderboard
app.post('/api/picks', (req, res) => {
  const { sessionId, pick } = req.body;
  const db = loadDB();
  db.picks.push({
    id:        Date.now().toString(),
    sessionId,
    ticker:    pick.ticker,
    company:   pick.company,
    entryPrice: pick.price,
    conviction: pick.conviction_score,
    thesis:    pick.thesis,
    instrument: pick.instrument || 'stock',
    pickedAt:  new Date().toISOString(),
    currentPrice: pick.price,
    returnPct: 0,
  });
  const persisted = saveDB(db);
  res.json({ ok: true, persisted });
});

// Get all picks (leaderboard)
app.get('/api/picks', (req, res) => {
  const db = loadDB();
  res.json(db.picks.reverse());
});

// Refresh currentPrice + returnPct from Polygon (all picks, or one by id)
app.post('/api/picks/refresh', async (req, res) => {
  if (!POLYGON_KEY) {
    return res.status(503).json({ error: 'POLYGON_API_KEY not set — cannot refresh prices' });
  }
  const db = loadDB();
  const idFilter = req.body?.id;
  const targets = idFilter
    ? db.picks.filter(p => p.id === idFilter)
    : db.picks;

  if (!targets.length) {
    return res.json({ ok: true, updated: 0, failed: [], picks: db.picks.reverse() });
  }

  // One Polygon call per unique ticker
  const tickers = [...new Set(targets.map(p => p.ticker).filter(Boolean))];
  const priceMap = {};
  const failed = [];
  await Promise.all(tickers.map(async (ticker) => {
    const snap = await getPolygonSnapshot(ticker);
    if (snap?.price != null && Number.isFinite(+snap.price)) {
      priceMap[ticker] = +snap.price;
    } else {
      failed.push(ticker);
    }
  }));

  let updated = 0;
  for (const pick of targets) {
    const price = priceMap[pick.ticker];
    if (price == null) continue;
    const entry = +pick.entryPrice;
    pick.currentPrice = price;
    pick.returnPct = entry > 0 ? +(((price - entry) / entry) * 100).toFixed(2) : 0;
    pick.priceUpdatedAt = new Date().toISOString();
    updated++;
  }
  const persisted = saveDB(db);
  res.json({
    ok: true,
    persisted,
    updated,
    failed,
    picks: db.picks.slice().reverse(),
  });
});

// Enrich a ticker with live data
app.get('/api/enrich/:ticker', async (req, res) => {
  const { ticker } = req.params;
  const [snapshot, finnhub, insider] = await Promise.all([
    getPolygonSnapshot(ticker),
    getFinnhubData(ticker),
    getInsiderData(ticker),
  ]);
  res.json({ snapshot, finnhub, insider });
});

// Fetch live news for a company
app.get('/api/news/:company', async (req, res) => {
  const articles = await getNews(req.params.company);
  res.json(articles);
});

// Proxy Anthropic (keeps key server-side)
app.post('/api/analyze', async (req, res) => {
  const { messages, system } = req.body;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server' });
  }
  const isChat = req.body.mode === 'chat';
  const model = req.body.model || (isChat ? CHAT_MODEL : CLAUDE_MODEL);
  const timeoutMs = req.body.timeout_ms || (isChat ? CHAT_TIMEOUT_MS : ANALYSIS_TIMEOUT_MS);
  const retries = isChat ? 1 : ANTHROPIC_RETRIES;
  try {
    const data = await callAnthropic({
      model,
      max_tokens: req.body.max_tokens || (isChat ? 800 : 2000),
      system,
      messages,
    }, { timeoutMs, retries });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Analysis request failed' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    keys: {
      anthropic: !!ANTHROPIC_KEY,
      polygon:   !!POLYGON_KEY,
      finnhub:   !!FINNHUB_KEY,
      newsapi:   !!NEWSAPI_KEY,
    },
  });
});

export default app;

// Start a long-running server only for local development. Vercel imports the
// Express app from api/[...path].js and manages the HTTP server itself.
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const PORT = process.env.PORT || 3002;
  app.listen(PORT, () => console.log(`Intellivest running → http://localhost:${PORT}`));
}
