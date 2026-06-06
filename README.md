# IntelInvest — AI Stock Intelligence Platform

A full-stack AI-powered stock analyzer with live market data, insider flow,
real-time news, and the proprietary **Priced-In Engine™**.

---

## Architecture

```
IntelInvest/
├── server/
│   └── index.js        ← Express server: API proxy, data enrichment, persistence
├── public/
│   └── index.html      ← Full frontend (React-less, zero build step)
├── data/
│   └── db.json         ← JSON database: investor profiles + pick history
├── .env.example        ← Copy to .env and fill in keys
└── package.json
```

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure API keys

```bash
cp .env.example .env
```

Edit `.env` with your keys:

| Key | Where to get it | Cost |
|-----|----------------|------|
| `ANTHROPIC_API_KEY` | console.anthropic.com | Pay-per-use |
| `POLYGON_API_KEY` | polygon.io | Free tier available |
| `FINNHUB_API_KEY` | finnhub.io | Free tier available |
| `NEWSAPI_KEY` | newsapi.org | Free tier available |

Only `ANTHROPIC_API_KEY` is required. The others unlock live data.

### 3. Run the server

```bash
# Load .env and start
node -e "
  const fs = require('fs');
  if (fs.existsSync('.env')) {
    fs.readFileSync('.env','utf8').split('\n').forEach(line => {
      const [k,...v] = line.split('=');
      if (k && !k.startsWith('#')) process.env[k.trim()] = v.join('=').trim();
    });
  }
" && node server/index.js
```

Or with dotenv installed:
```bash
npm install dotenv
node --require dotenv/config server/index.js
```

### 4. Open the app

```
http://localhost:3000
```

---

## Features

### AI Advisor (Chat)
- 7-question **Investor DNA** onboarding
- Personalized stock recommendations via Claude
- Free-form chat for follow-up analysis

### Live Data Pipeline
- **Polygon.io** — Real-time prices, % change, volume via snapshot API
- **Finnhub** — Company profile, earnings history, insider buy/sell transactions
- **NewsAPI** — Latest news articles for each recommended company

### Priced-In Engine™
Every news headline and catalyst is scored 0–100% for how much information
is already reflected in the stock price. Low scores = potential information edge.

### Sentiment Convergence Score™
Five independent signals aggregated into one score:
1. Analyst ratings (upgrades/downgrades)
2. Insider activity (Finnhub transaction ratio)
3. Options flow (unusual volume / skew)
4. Social momentum (Reddit/Twitter signal)
5. Search trend momentum

### Bull / Bear / Must-Be-True Framework
Every recommendation includes:
- 3 bull case arguments
- 3 bear case risks
- 3 conditions that must hold for the thesis to work

### Catalyst Calendar
Upcoming binary events (earnings, FDA, Fed meetings) with:
- Priced-in percentage bar
- Plain-English explanation of the information gap

### Conviction Leaderboard
All picks saved to `data/db.json` with full transparency:
- Entry price, date, conviction score, instrument
- Return tracked over time (update `currentPrice` via cron job)

### Watchlist
- Add any ticker
- Live price refresh via Polygon
- Sidebar quick-view

---

## Adding a Return-Update Cron Job

To keep leaderboard returns current, add a cron job that calls:

```bash
# Example: update prices every hour
curl http://localhost:3000/api/picks   # get all picks
# For each pick, fetch current price and PATCH /api/picks/:id
```

Or use a service like GitHub Actions on a schedule.

---

## Scaling to Production

1. **Replace `data/db.json`** with PostgreSQL or SQLite via `better-sqlite3`
2. **Add auth** — a simple JWT or session cookie
3. **Cache Polygon/Finnhub** responses (5-min TTL) to stay in free tier
4. **Deploy** on Railway, Render, or Fly.io — they support Node.js natively
5. **Add WebSockets** for real-time price streaming via Polygon's WS API

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/analyze` | Proxy to Anthropic (keeps key server-side) |
| GET | `/api/enrich/:ticker` | Live price (Polygon) + insider data (Finnhub) |
| GET | `/api/news/:company` | NewsAPI articles for company |
| POST | `/api/profile` | Save investor DNA profile |
| GET | `/api/profile/:sessionId` | Load saved profile |
| POST | `/api/picks` | Save a pick to leaderboard |
| GET | `/api/picks` | Get all picks (leaderboard) |
| GET | `/api/health` | Server + API key status |
