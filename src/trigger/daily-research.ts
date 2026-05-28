import { schedules, logger } from "@trigger.dev/sdk";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import nodemailer from "nodemailer";

// ─── RSS feed sources ─────────────────────────────────────────────────────────
const NEWS_FEEDS = [
  "https://techcrunch.com/category/artificial-intelligence/feed/",
  "https://the-decoder.com/feed/",
  "https://www.artificialintelligence-news.com/feed/",
];

const STOCK_FEEDS = [
  "https://feeds.finance.yahoo.com/rss/2.0/headline?s=NVDA,MSFT,GOOGL,META,AMZN&region=US&lang=en-US",
  "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
];

// ─── Parse RSS XML into readable text ────────────────────────────────────────
function parseRss(xml: string, maxItems = 8): { text: string; links: string[] } {
  const links: string[] = [];
  const blocks: string[] = [];

  const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  for (const match of itemMatches.slice(0, maxItems)) {
    const item = match[1];

    const title =
      item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s)?.[1] ??
      item.match(/<title>(.*?)<\/title>/s)?.[1] ??
      "";

    const desc =
      item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ??
      item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ??
      "";

    const link =
      item.match(/<link>(.*?)<\/link>/s)?.[1] ??
      item.match(/<guid[^>]*>(.*?)<\/guid>/s)?.[1] ??
      "";

    const cleanDesc = desc.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 400);

    if (title.trim()) {
      blocks.push(`**${title.trim()}**\n${cleanDesc}\n${link.trim()}`);
      if (link.trim()) links.push(link.trim());
    }
  }

  return { text: blocks.join("\n\n"), links };
}

export const dailyResearch = schedules.task({
  id: "daily-research",
  cron: "0 7 * * *", // 07:00 UTC = ~12:30 PM IST

  run: async (payload) => {
    const runDate = payload.timestamp.toISOString().split("T")[0];
    logger.info("daily-research started", { date: runDate });

    let step1Status: "success" | "failed" = "failed";
    let step2Status: "success" | "failed" = "failed";
    let step3Status: "success" | "failed" = "failed";
    let step4Status: "success" | "failed" = "failed";

    let newsContent = "";
    let stockContent = "";
    let allSourceUrls: string[] = [];
    let newsSummary = "";
    let stockSummary = "";

    // ── STEP 1: Fetch RSS feeds ───────────────────────────────────────────────
    try {
      logger.info("step1: fetching RSS feeds", {
        newsFeeds: NEWS_FEEDS.length,
        stockFeeds: STOCK_FEEDS.length,
      });

      const fetchFeed = async (url: string) => {
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; DailyResearchBot/1.0)" },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      };

      const newsResults = await Promise.allSettled(NEWS_FEEDS.map(fetchFeed));
      const stockResults = await Promise.allSettled(STOCK_FEEDS.map(fetchFeed));

      for (let i = 0; i < newsResults.length; i++) {
        const r = newsResults[i];
        if (r.status === "fulfilled") {
          const { text, links } = parseRss(r.value);
          newsContent += "\n\n" + text;
          allSourceUrls.push(...links);
          logger.info(`step1: news feed ${i + 1} ok`, { url: NEWS_FEEDS[i], items: links.length });
        } else {
          logger.warn(`step1: news feed ${i + 1} failed`, { url: NEWS_FEEDS[i], reason: String(r.reason) });
        }
      }

      for (let i = 0; i < stockResults.length; i++) {
        const r = stockResults[i];
        if (r.status === "fulfilled") {
          const { text, links } = parseRss(r.value);
          stockContent += "\n\n" + text;
          allSourceUrls.push(...links);
          logger.info(`step1: stock feed ${i + 1} ok`, { url: STOCK_FEEDS[i], items: links.length });
        } else {
          logger.warn(`step1: stock feed ${i + 1} failed`, { url: STOCK_FEEDS[i], reason: String(r.reason) });
        }
      }

      if (!newsContent.trim() && !stockContent.trim()) {
        throw new Error("All RSS feeds failed — no content retrieved");
      }

      step1Status = "success";
      logger.info("step1: RSS fetch complete", {
        newsChars: newsContent.length,
        stockChars: stockContent.length,
        totalLinks: allSourceUrls.length,
      });
    } catch (err) {
      step1Status = "failed";
      logger.error("step1: RSS fetch failed", { error: String(err) });
    }

    // ── STEP 2: Claude Synthesis ──────────────────────────────────────────────
    try {
      if (!newsContent.trim() && !stockContent.trim()) {
        throw new Error("No content from step 1 — skipping synthesis");
      }

      logger.info("step2: claude synthesis starting", {
        newsChars: newsContent.length,
        stockChars: stockContent.length,
      });

      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

      const prompt = `You are a financial and technology research assistant. Today is ${runDate}.

Based on the RSS feed content below, produce TWO clearly labeled sections. Use EXACTLY these headers with no extra symbols:

SECTION 1 — AI NEWS TODAY
Summarize the 3-5 most important AI news stories. For each: one sentence headline + one sentence explanation. Focus on breakthroughs, product launches, partnerships, and regulation.

SECTION 2 — AI STOCK OPPORTUNITIES
Identify 3-5 AI-related stocks or sectors showing investment opportunity right now. For each: company/ticker, why it's an opportunity (catalyst, trend, valuation), and one risk to watch. Be specific and cite figures where available.

---
AI NEWS FEED:
${newsContent.slice(0, 20000)}

---
MARKET/STOCK FEED:
${stockContent.slice(0, 20000)}`;

      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      });

      const block = message.content[0];
      if (block.type !== "text") throw new Error("Unexpected Claude response type: " + block.type);

      const fullOutput = block.text;

      // Split on SECTION 2 regardless of heading style (**, ##, plain)
      const splitMatch = fullOutput.split(/(?:[*#]{1,3}\s*)SECTION 2[^\n]*/i);
      const sec1Raw = splitMatch[0].replace(/(?:[*#]{1,3}\s*)SECTION 1[^\n]*/i, "").trim();
      const sec2Raw = splitMatch[1] ? splitMatch[1].trim() : "";

      const stripMarkdown = (s: string) =>
        s.replace(/\*\*(.*?)\*\*/g, "$1").replace(/^#{1,3}\s*/gm, "").replace(/^\s*[-–]+\s*$/gm, "").trim();

      newsSummary = stripMarkdown(sec1Raw) || fullOutput;
      stockSummary = stripMarkdown(sec2Raw) || "(see news summary)";

      step2Status = "success";
      logger.info("step2: claude synthesis complete", {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        newsSummaryLength: newsSummary.length,
        stockSummaryLength: stockSummary.length,
      });
    } catch (err) {
      step2Status = "failed";
      logger.error("step2: claude synthesis failed", { error: String(err) });
    }

    // ── Overall status ────────────────────────────────────────────────────────
    const overallStatus: "complete" | "partial" | "failed" =
      step1Status === "success" && step2Status === "success"
        ? "complete"
        : step1Status === "failed" && step2Status === "failed"
        ? "failed"
        : "partial";

    logger.info("overall status determined", { step1Status, step2Status, overallStatus });

    // ── STEP 3: Google Sheets Write ───────────────────────────────────────────
    try {
      logger.info("step3: google sheets write starting", {
        sheetId: process.env.GOOGLE_SHEET_ID,
        overallStatus,
      });

      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

      const sheets = google.sheets({ version: "v4", auth });
      const rowValues = [
        runDate,
        newsSummary || "(news synthesis failed)",
        stockSummary || "(stock synthesis failed)",
        allSourceUrls.slice(0, 10).join("\n") || "(no sources)",
        overallStatus,
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID!,
        range: "Sheet1!A:E",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rowValues] },
      });

      step3Status = "success";
      logger.info("step3: google sheets write complete", { date: runDate, status: overallStatus });
    } catch (err) {
      step3Status = "failed";
      logger.error("step3: google sheets write failed", { error: String(err) });
    }

    // ── STEP 4: Send Email Report ─────────────────────────────────────────────
    try {
      logger.info("step4: email send starting", { to: process.env.NOTIFY_EMAIL, overallStatus });

      const statusLabel =
        overallStatus === "complete" ? "Complete" :
        overallStatus === "partial" ? "Partial" : "Failed";

      const statusColor =
        overallStatus === "complete" ? "#16a34a" :
        overallStatus === "partial" ? "#d97706" : "#dc2626";

      const formatSection = (text: string, fallback: string): string => {
        if (!text.trim()) return `<p style="color:#6b7280;font-style:italic;">${fallback}</p>`;
        return text.split("\n").filter((l) => l.trim())
          .map((l) => `<p style="margin:0 0 8px 0;line-height:1.6;">${l.trim()}</p>`).join("");
      };

      const sourceLinks = allSourceUrls.length > 0
        ? allSourceUrls.slice(0, 10).map((url) =>
            `<li style="margin-bottom:4px;"><a href="${url}" style="color:#2563eb;text-decoration:none;font-size:13px;">${url.length > 70 ? url.slice(0, 70) + "…" : url}</a></li>`
          ).join("")
        : `<li style="color:#6b7280;font-style:italic;font-size:13px;">No sources captured</li>`;

      const htmlBody = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr><td style="background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);padding:28px 32px;">
          <p style="margin:0 0 4px 0;color:#94a3b8;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">Daily Research Report</p>
          <h1 style="margin:0 0 12px 0;color:#f8fafc;font-size:22px;font-weight:700;">${runDate}</h1>
          <span style="display:inline-block;background-color:${statusColor};color:#ffffff;font-size:12px;font-weight:600;padding:3px 10px;border-radius:20px;">${statusLabel}</span>
        </td></tr>
        <tr><td style="padding:28px 32px 0 32px;">
          <h2 style="margin:0 0 16px 0;color:#0f172a;font-size:16px;font-weight:700;border-bottom:2px solid #e2e8f0;padding-bottom:8px;">AI News Today</h2>
          <div style="color:#334155;font-size:14px;">${formatSection(newsSummary, "News synthesis did not complete for this run.")}</div>
        </td></tr>
        <tr><td style="padding:24px 32px 0 32px;">
          <h2 style="margin:0 0 16px 0;color:#0f172a;font-size:16px;font-weight:700;border-bottom:2px solid #e2e8f0;padding-bottom:8px;">AI Stock Opportunities</h2>
          <div style="color:#334155;font-size:14px;">${formatSection(stockSummary, "Stock synthesis did not complete for this run.")}</div>
        </td></tr>
        <tr><td style="padding:24px 32px 0 32px;">
          <h2 style="margin:0 0 12px 0;color:#0f172a;font-size:16px;font-weight:700;border-bottom:2px solid #e2e8f0;padding-bottom:8px;">Sources</h2>
          <ul style="margin:0;padding-left:16px;color:#334155;">${sourceLinks}</ul>
        </td></tr>
        <tr><td style="padding:24px 32px 28px 32px;">
          <table width="100%" cellpadding="8" cellspacing="0" style="background:#f8fafc;border-radius:8px;">
            <tr><td style="font-size:12px;color:#64748b;">
              <strong style="color:#475569;">Pipeline:</strong>&nbsp;
              RSS <span style="color:${step1Status === "success" ? "#16a34a" : "#dc2626"};font-weight:600;">${step1Status === "success" ? "✓" : "✗"}</span>&nbsp;&nbsp;
              Claude <span style="color:${step2Status === "success" ? "#16a34a" : "#dc2626"};font-weight:600;">${step2Status === "success" ? "✓" : "✗"}</span>&nbsp;&nbsp;
              Sheets <span style="color:${step3Status === "success" ? "#16a34a" : "#dc2626"};font-weight:600;">${step3Status === "success" ? "✓" : "✗"}</span>
              &nbsp;&nbsp;|&nbsp;&nbsp;${allSourceUrls.length} sources
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="background:#f1f5f9;padding:14px 32px;border-top:1px solid #e2e8f0;">
          <p style="margin:0;color:#94a3b8;font-size:11px;text-align:center;">Phase 3 Automation · Scheduled daily at 07:00 UTC · Trigger.dev</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.GMAIL_USER!,
          pass: process.env.GMAIL_APP_PASSWORD!,
        },
      });

      await transporter.sendMail({
        from: `"Daily Research Bot" <${process.env.GMAIL_USER}>`,
        to: process.env.NOTIFY_EMAIL!,
        subject: `[${statusLabel}] AI Research Report — ${runDate}`,
        html: htmlBody,
      });

      step4Status = "success";
      logger.info("step4: email sent", { to: process.env.NOTIFY_EMAIL });
    } catch (err) {
      step4Status = "failed";
      logger.error("step4: email send failed", { error: String(err) });
    }

    // ── Final result ──────────────────────────────────────────────────────────
    const result = {
      date: runDate,
      step1Status,
      step2Status,
      step3Status,
      step4Status,
      overallStatus,
      sourcesFound: allSourceUrls.length,
      newsSummaryLength: newsSummary.length,
      stockSummaryLength: stockSummary.length,
    };

    logger.info("daily-research finished", result);
    return result;
  },
});
