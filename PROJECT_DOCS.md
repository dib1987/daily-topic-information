# PHASE 3 — Daily AI Research Automation
### Project Documentation

---

## What Is This Project? (The Simple Version)

Every morning, this system wakes up on its own, reads the latest AI news and stock market updates from the internet, asks Claude AI to summarize what matters, and writes a clean report into a Google Sheet — all without you doing anything.

Think of it like hiring a research assistant who:
- Wakes up at 12:30 PM IST every day
- Reads dozens of news articles
- Picks out what's important
- Writes a summary in your notebook
- Goes back to sleep

You just open the Google Sheet and the work is already done.

---

## The Problem We Were Solving

Reading AI news and tracking AI stocks every day takes time. You have to:
- Visit multiple websites
- Figure out what's relevant
- Remember to do it every day

This project automates all of that completely. Zero manual work after setup.

---

## How It Works — Step by Step

```
Every day at 07:00 UTC (12:30 PM IST)
        │
        ▼
┌─────────────────────────────┐
│  STEP 1 — Fetch the news    │
│  Read 5 RSS feeds:          │
│  • TechCrunch AI            │
│  • The Decoder              │
│  • AI News                  │
│  • Yahoo Finance            │
│  • Wall Street Journal      │
└─────────────┬───────────────┘
              │ If any feed fails, skip it.
              │ If ALL fail, mark step as failed.
              ▼
┌─────────────────────────────┐
│  STEP 2 — Ask Claude AI     │
│  Send all the news to       │
│  Claude and ask for:        │
│  • Top 5 AI news stories    │
│  • Top 5 stock opportunities│
└─────────────┬───────────────┘
              │ If Claude fails, mark step as failed.
              ▼
┌─────────────────────────────┐
│  STEP 3 — Write to Sheet    │
│  Append one row:            │
│  Date | News | Stocks |     │
│  Sources | Status           │
└─────────────────────────────┘
              │
              ▼
        Done. Every day.
```

**Important design decision:** If Step 1 fails, Step 2 is skipped. But Step 3 always runs — even if everything failed, it writes a row saying "failed" so you have a record. The task never crashes.

---

## Google Sheet Output

| Column | What's in it |
|--------|-------------|
| A — Date | 2026-05-27 |
| B — AI News Summary | 5 bullet points: today's biggest AI stories |
| C — Stock Opportunities | 5 stocks: what to watch, why, and the risk |
| D — Sources | URLs of the articles used |
| E — Status | `complete` / `partial` / `failed` |

---

## Technology Stack

### 1. Trigger.dev (v4)
**What it is:** The scheduler and runner. It's the thing that wakes up at 12:30 PM and runs your code.

**Why we used it:**
- No server to manage. No always-on computer needed.
- Built-in logs — you can see exactly what happened in each run
- Built-in retries — if something fails, it tries again
- Dev mode — test locally before going live
- One line to schedule: `cron: "0 7 * * *"`

**Why not something else:**
- GitHub Actions would also work, but logs are harder to read and it needs a GitHub repo
- AWS Lambda would work but requires complex setup (IAM roles, EventBridge, etc.)
- Trigger.dev is the simplest option for a TypeScript developer

---

### 2. Claude API (Anthropic)
**What it is:** The AI brain. It reads the raw RSS content and writes the summaries.

**Model used:** `claude-sonnet-4-6` — fast, capable, cost-efficient for daily use

**Why we used it:**
- RSS feeds give raw, messy, repetitive content. Claude turns it into clean, structured bullet points.
- It understands context — it can identify which news is actually important vs. noise
- It follows instructions well — "give me exactly 5 bullets" actually produces 5 bullets

**What it replaces:** Manually reading 30+ articles and writing your own summary

---

### 3. RSS Feeds (Native Fetch)
**What it is:** Free public news feeds from news websites. Every major site publishes one.

**Why we used it (and not Firecrawl):**
- We originally tried Firecrawl (a web scraping API) but the free plan doesn't support search or scraping
- RSS feeds are completely free, no API key needed, no rate limits
- They update automatically as new articles are published
- We parse the XML ourselves with a small custom function — no external library needed

**Feeds used:**
- `techcrunch.com/category/artificial-intelligence/feed/` — AI product news
- `the-decoder.com/feed/` — AI research and industry
- `artificialintelligence-news.com/feed/` — AI industry news
- `feeds.finance.yahoo.com` — AI stock headlines (NVDA, MSFT, GOOGL, META, AMZN)
- `feeds.a.dj.com/rss/RSSMarketsMain.xml` — Wall Street Journal markets

---

### 4. Google Sheets API (googleapis)
**What it is:** The notebook. Every day's research gets stored as one new row.

**Why we used it:**
- You already use Google Sheets — no new tool to learn
- Easy to filter, sort, and review past days
- Free with a Google account
- Accessible from phone, tablet, any browser

**How authentication works:**
- A Service Account (a bot Google user) is created in Google Cloud
- The sheet is shared with that bot's email address
- The credentials are stored as a JSON string in the environment variables
- No manual login ever needed

---

### 5. TypeScript + Node.js
**What it is:** The programming language the task is written in.

**Why:** Trigger.dev is TypeScript-native. Strong typing catches bugs before they reach production. The entire codebase is already TypeScript.

---

## What We Learned Building This

### 1. Free tiers have hidden limits
Firecrawl looked perfect on paper — but the free plan silently returns `success=false` instead of an error when you hit the limit. Always test the actual API call, not just the docs.

**Lesson:** Verify free tier limits by actually calling the API, not by reading the pricing page.

### 2. AI output format is unpredictable
We told Claude to format output as `**SECTION 1**` but it sometimes returned `## SECTION 1` or `SECTION 1` (no markers). The first version of the parser broke silently — it put the entire output in Column B and left Column C empty.

**Lesson:** When parsing AI output, write flexible regex that handles multiple formats, not just the one you expect. Better yet, tell the AI explicitly: "Use EXACTLY these headers with no extra symbols."

### 3. "Completed" in Trigger.dev ≠ task worked correctly
A Trigger.dev run shows "Completed" if the function returned a value — even if that value is `{ status: "failed" }`. You must check your actual output (the Google Sheet) to verify the task did useful work.

**Lesson:** Always check the end result (the sheet), not just the runner status.

### 4. RSS is underrated
RSS feeds are free, fast, reliable, and require zero authentication. For news aggregation, they beat scraping every time. Most major tech and finance sites still publish them.

**Lesson:** Before reaching for a paid scraping API, check if the site publishes an RSS feed.

### 5. Individual error handling per step beats one big try/catch
Wrapping every step in its own try/catch means a Claude API timeout won't prevent the sheet from getting a row. Partial data is more useful than silence.

**Lesson:** Design tasks to always produce output, even when they partially fail. A row that says "failed" is more useful than no row.

---

## Project File Structure

```
PHASE3-AUTOMATION/
├── src/
│   └── trigger/
│       └── daily-research.ts    ← The entire task lives here
├── trigger.config.ts             ← Trigger.dev project config
├── .env                          ← API keys (never commit this)
├── package.json
└── PROJECT_DOCS.md               ← This file
```

---

## Environment Variables Required

| Variable | What it is | Where to get it |
|----------|-----------|-----------------|
| `TRIGGER_SECRET_KEY` | Trigger.dev auth | trigger.dev dashboard |
| `ANTHROPIC_API_KEY` | Claude API key | console.anthropic.com |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google bot credentials | Google Cloud Console |
| `GOOGLE_SHEET_ID` | ID from the sheet URL | Copy from Google Sheets URL |

---

## Pending Steps Before Going Fully Live

1. **Add env vars to Trigger.dev Cloud** (dashboard → Environment Variables)
   - `ANTHROPIC_API_KEY`
   - `GOOGLE_SERVICE_ACCOUNT_JSON`
   - `GOOGLE_SHEET_ID`

2. **Deploy:** run `npm run deploy:trigger`
   - After this, the task runs on Trigger.dev's servers every day at 07:00 UTC
   - Your computer can be off

3. **Optional:** Set up email alert in Trigger.dev dashboard → Alerts → on run failure

---

## How to Run Locally (For Testing)

```powershell
# Start the dev server
npm run dev:trigger

# Then go to trigger.dev → Test → Run test
# Check Google Sheet for the new row
```

---

## Quick Reference: What To Do If Something Breaks

| Symptom | Where to look | Likely fix |
|---------|--------------|------------|
| Row says "failed" | Trigger.dev → Runs → click run ID → read step1 logs | RSS feed URL changed, replace it |
| Row says "partial" | Same logs, check step2 | Claude API key expired or quota hit |
| No row at all | Check step3 logs | Google Sheet ID wrong or service account lost editor access |
| Task not running | Trigger.dev → Schedules | Re-deploy: `npm run deploy:trigger` |

---

*Built in May 2026 as part of the Agentic Workflow Phase 3 Automation project.*
