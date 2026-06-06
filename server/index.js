import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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
function loadDB() {
  if (!existsSync(DATA_FILE)) return { profiles: {}, picks: [] };
  try { return JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch { return { profiles: {}, picks: [] }; }
}
function saveDB(db) {
  writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
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

// ── Polygon: snapshot (price + change) ───────────────────────────────────────
async function getPolygonSnapshot(ticker) {
  if (!POLYGON_KEY) return null;
  try {
    const r = await fetch(
      `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${POLYGON_KEY}`,
      { timeout: 5000 }
    );
    const d = await r.json();
    const t = d.ticker;
    if (!t) return null;
    return {
      price:      t.day?.c || t.prevDay?.c,
      change_pct: t.todaysChangePerc,
      volume:     t.day?.v,
      open:       t.day?.o,
      high:       t.day?.h,
      low:        t.day?.l,
    };
  } catch { return null; }
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
  saveDB(db);
  res.json({ ok: true });
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
  saveDB(db);
  res.json({ ok: true });
});

// Get all picks (leaderboard)
app.get('/api/picks', (req, res) => {
  const db = loadDB();
  res.json(db.picks.reverse());
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Intellivest running → http://localhost:${PORT}`));
