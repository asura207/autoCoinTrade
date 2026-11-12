import https from "node:https";
import http from "node:http";

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        timeout: 8000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchUrl(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

function parseXmlItems(xmlText) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xmlText)) !== null) {
    const block = match[1];

    const titleMatch = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i.exec(block);
    const linkMatch = /<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/i.exec(block);
    const pubDateMatch = /<pubDate>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/pubDate>/i.exec(block);
    const descMatch = /<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/i.exec(block);

    if (titleMatch && titleMatch[1]) {
      items.push({
        rawTitle: titleMatch[1].trim(),
        link: linkMatch && linkMatch[1] ? linkMatch[1].trim() : "",
        pubDate: pubDateMatch && pubDateMatch[1] ? pubDateMatch[1].trim() : "",
        rawDesc: descMatch && descMatch[1] ? descMatch[1].trim() : "",
      });
    }
  }

  return items;
}

function cleanHtmlText(str) {
  if (!str) return "";
  return str
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePublishedDate(pubDateStr) {
  try {
    const d = new Date(pubDateStr);
    if (!isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
  } catch {}

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const BULLISH_WORDS = [
  "상승", "급등", "돌파", "사상최고", "신고가", "랠리", "승인", "매수", "호재", "반등",
  "유입", "지지", "낙관", "성장", "흑자", "회복", "폭등", "surged", "rally", "bullish",
  "breakout", "ath", "high", "gain", "profit", "inflow", "approval", "rebound"
];

const BEARISH_WORDS = [
  "하락", "급락", "폭락", "붕괴", "해킹", "유출", "규제", "제재", "기소", "사기", "악재",
  "파산", "손실", "이탈", "비관", "폭락장", "압류", "조사", "수사", "crash", "plunge",
  "fall", "drop", "bearish", "hack", "fraud", "ban", "dump", "loss", "lawsuit", "collapse"
];

function analyzeSentiment(title, desc = "") {
  const text = `${title} ${desc}`.toLowerCase();
  let bullScore = 0;
  let bearScore = 0;

  for (const w of BULLISH_WORDS) {
    if (text.includes(w)) bullScore++;
  }
  for (const w of BEARISH_WORDS) {
    if (text.includes(w)) bearScore++;
  }

  if (bullScore > bearScore) return "BULLISH";
  if (bearScore > bullScore) return "BEARISH";
  return "NEUTRAL";
}

function extractKeywords(title, desc = "") {
  const text = `${title} ${desc}`.toLowerCase();
  const tags = [];

  const candidates = [
    { tag: "비트코인", terms: ["비트코인", "bitcoin", "btc"] },
    { tag: "이더리움", terms: ["이더리움", "ethereum", "eth"] },
    { tag: "업비트", terms: ["업비트", "upbit"] },
    { tag: "바이낸스", terms: ["바이낸스", "binance"] },
    { tag: "리플", terms: ["리플", "xrp", "ripple"] },
    { tag: "솔라나", terms: ["솔라나", "solana", "sol"] },
    { tag: "ETF", terms: ["etf", "상장지수펀드"] },
    { tag: "규제/정책", terms: ["규제", "sec", "법원", "기소", "제재", "regulation", "fed", "금리"] },
    { tag: "해킹/보안", terms: ["해킹", "탈취", "사기", "hack", "scam"] },
    { tag: "시황/전망", terms: ["전망", "시황", "분석", "예측", "target"] },
  ];

  for (const c of candidates) {
    if (c.terms.some((t) => text.includes(t))) {
      tags.push(`#${c.tag}`);
    }
  }

  return tags.length > 0 ? tags.join(" ") : "#암호화폐";
}

export async function fetchAllCryptoNews() {
  const feeds = [
    {
      name: "Google News (KR)",
      url: "https://news.google.com/rss/search?q=%EB%B9%84%ED%8A%B8%EC%BD%94%EC%9D%B8+OR+%EC%95%94%ED%98%B8%ED%99%94%ED%8F%90+OR+%EC%97%85%EB%B9%84%ED%8A%B8+OR+%EA%B0%80%EC%83%81%EC%9E%90%EC%82%B0&hl=ko&gl=KR&ceid=KR:ko",
    },
    {
      name: "Google News (Global)",
      url: "https://news.google.com/rss/search?q=crypto+OR+bitcoin+OR+upbit+OR+ethereum&hl=en-US&gl=US&ceid=US:en",
    },
    {
      name: "TokenPost (KR)",
      url: "https://www.tokenpost.kr/rss",
    },
  ];

  const articles = [];
  const seenLinks = new Set();

  for (const feed of feeds) {
    try {
      const xml = await fetchUrl(feed.url);
      const parsed = parseXmlItems(xml);

      for (const item of parsed) {
        let cleanTitle = cleanHtmlText(item.rawTitle);
        let link = item.link;
        if (!cleanTitle || !link || seenLinks.has(link)) continue;
        seenLinks.add(link);

        // 출처 분리: "기사 제목 - 언론사명" 형태 파싱
        let source = feed.name;
        const lastDash = cleanTitle.lastIndexOf(" - ");
        if (lastDash !== -1 && lastDash > cleanTitle.length - 30) {
          source = cleanTitle.slice(lastDash + 3).trim() || source;
          cleanTitle = cleanTitle.slice(0, lastDash).trim();
        }

        const publishedAt = parsePublishedDate(item.pubDate);
        const cleanDesc = cleanHtmlText(item.rawDesc);
        const sentiment = analyzeSentiment(cleanTitle, cleanDesc);
        const keywords = extractKeywords(cleanTitle, cleanDesc);

        articles.push({
          title: cleanTitle,
          link,
          source,
          published_at: publishedAt,
          summary: cleanDesc.slice(0, 300),
          sentiment,
          keywords,
        });
      }
    } catch (err) {
      console.warn(`[NewsService] Failed to fetch feed ${feed.name}: ${err.message}`);
    }
  }

  return articles;
}

export async function syncNewsToDatabase(db) {
  const articles = await fetchAllCryptoNews();
  if (!articles || articles.length === 0) return 0;

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  let insertedCount = 0;
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO crypto_news (
      title, link, source, published_at, summary, sentiment, keywords, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const a of articles) {
    try {
      const res = await insertStmt.run(
        a.title,
        a.link,
        a.source,
        a.published_at,
        a.summary || "",
        a.sentiment || "NEUTRAL",
        a.keywords || "",
        nowStr
      );
      if (res && res.changes > 0) {
        insertedCount++;
      }
    } catch {}
  }

  console.log(`[NewsService] Fetched ${articles.length} news, newly inserted ${insertedCount} articles.`);
  return insertedCount;
}

export async function queryNewsList(db, { page = 1, limit = 50, keyword = "", startDate = "", endDate = "" }) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 50));
  const offset = (p - 1) * l;

  const whereClauses = [];
  const params = [];

  if (keyword && keyword.trim()) {
    const kw = `%${keyword.trim()}%`;
    whereClauses.push("(title ILIKE ? OR summary ILIKE ? OR source ILIKE ? OR keywords ILIKE ?)");
    params.push(kw, kw, kw, kw);
  }

  if (startDate && startDate.trim()) {
    whereClauses.push("published_at >= ?");
    params.push(`${startDate.trim()} 00:00:00`);
  }

  if (endDate && endDate.trim()) {
    whereClauses.push("published_at <= ?");
    params.push(`${endDate.trim()} 23:59:59`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  // 1. 전체 개수 조회
  const countRow = await db.prepare(`SELECT COUNT(*) AS total FROM crypto_news ${whereSql}`).get(...params);
  const total = countRow ? Number(countRow.total || 0) : 0;
  const totalPages = Math.ceil(total / l) || 1;

  // 2. 현재 페이지 50건 목록 조회
  const items = await db
    .prepare(`SELECT * FROM crypto_news ${whereSql} ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, l, offset);

  return {
    items,
    total,
    page: p,
    limit: l,
    total_pages: totalPages,
  };
}

