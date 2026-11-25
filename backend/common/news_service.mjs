/**
 * [Antigravity-Doc]
 * 파일 역할: 암호화폐 RSS 뉴스 수집, 규칙 기반 감성/키워드 태깅, DB 동기화 및 검색/통계 조회 서비스 모듈
 * 아키텍처:
 * - Google News (KR/Global) 및 TokenPost RSS 피드를 `node:https`/`node:http`로 직접 수집(8초 타임아웃, 3xx 리다이렉트 추적)합니다.
 * - 외부 XML 파서 없이 정규식 기반으로 `<item>` 블록을 추출하고 HTML 태그·엔티티를 정제한 뒤, 사전 기반 키워드 매칭으로 감성(`BULLISH`/`BEARISH`/`NEUTRAL`)과 해시태그(`#비트코인` 등)를 부여합니다.
 * - `crypto_news` 테이블에 `INSERT OR IGNORE`로 중복 링크를 배제하며 적재하고, 대시보드 페이징 검색 및 AI 브리핑용 최신 뉴스/통계 조회 API를 제공합니다.
 * 주요 의존성: `node:https`, `node:http` (외부 DB 어댑터는 호출부에서 `db` 인자로 주입)
 * 수정 시 주의사항:
 * - `queryNewsList`는 `ILIKE`를 사용하므로 SQLite 환경에서는 `sqlite_db.mjs`의 `translateSqlite`를 경유하는 DB 래퍼를 전달해야 정상 동작합니다.
 * - RSS 피드 URL 변경 시 Google News의 `"제목 - 언론사"` 분리 로직(`lastIndexOf(" - ")`) 영향 여부를 확인하세요.
 */
import https from "node:https";
import http from "node:http";

/**
 * [Antigravity-Doc]
 * 역할: 지정된 HTTP/HTTPS URL에서 텍스트 본문을 비동기로 내려받습니다.
 * 매개변수:
 * - url {string}: 요청할 RSS 피드 URL
 * 반환값: {Promise<string>} UTF-8로 디코딩된 응답 본문 문자열
 * 부수효과/예외 처리: 8초 타임아웃 적용, 3xx 리다이렉트 자동 재귀 추적, HTTP 200 외 상태 코드나 네트워크/타임아웃 오류 시 reject합니다.
 */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    // [Antigravity-Doc] URL 스킴에 따라 https 또는 http 클라이언트 선택 및 브라우저 호환 User-Agent 헤더 설정
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
        // [Antigravity-Doc] 3xx 리다이렉트 응답 시 Location 헤더 대상으로 재요청
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchUrl(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        // [Antigravity-Doc] 응답 스트림 청크를 UTF-8 문자열로 누적해 완료 시 반환
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    // [Antigravity-Doc] 타임아웃 발생 시 소켓을 즉시 파기해 리소스 누수 방지
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

/**
 * [Antigravity-Doc]
 * 역할: RSS XML 원문에서 `<item>` 요소들을 추출해 제목·링크·발행일·요약 원문을 파싱합니다.
 * 매개변수:
 * - xmlText {string}: RSS XML 전체 문자열
 * 반환값: {Array<{rawTitle: string, link: string, pubDate: string, rawDesc: string}>} 추출된 기사 원시 객체 배열
 * 부수효과/예외 처리: CDATA 래퍼(`<![CDATA[...]]>`)를 선택적으로 벗겨내며, 제목이 없는 항목은 무시합니다.
 */
function parseXmlItems(xmlText) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  // [Antigravity-Doc] XML 내 모든 <item>...</item> 블록을 순회하며 주요 필드 정규식 추출
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

/**
 * [Antigravity-Doc]
 * 역할: RSS 제목/본문 문자열에서 HTML 태그를 제거하고 주요 HTML 엔티티를 일반 문자로 복원합니다.
 * 매개변수:
 * - str {string}: 정제 전 원시 HTML/텍스트 문자열
 * 반환값: {string} 연속 공백이 단일 공백으로 압축된 순수 텍스트
 */
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

/**
 * [Antigravity-Doc]
 * 역할: RSS `<pubDate>` 문자열을 로컬 시스템 시간 기준 `YYYY-MM-DD HH:mm:ss` 포맷으로 변환합니다.
 * 매개변수:
 * - pubDateStr {string}: RFC 2822 등 날짜 문자열
 * 반환값: {string} 정규화된 타임스탬프 문자열 (파싱 실패 시 현재 시각으로 폴백)
 */
function parsePublishedDate(pubDateStr) {
  try {
    const d = new Date(pubDateStr);
    if (!isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
  } catch {}

  // [Antigravity-Doc] 날짜 파싱 실패 시 현재 시각으로 안전 폴백
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// [Antigravity-Doc] 호재(BULLISH) 감성 점수 산정에 사용되는 한/영 키워드 사전
const BULLISH_WORDS = [
  "상승", "급등", "돌파", "사상최고", "신고가", "랠리", "승인", "매수", "호재", "반등",
  "유입", "지지", "낙관", "성장", "흑자", "회복", "폭등", "surged", "rally", "bullish",
  "breakout", "ath", "high", "gain", "profit", "inflow", "approval", "rebound"
];

// [Antigravity-Doc] 악재(BEARISH) 감성 점수 산정에 사용되는 한/영 키워드 사전
const BEARISH_WORDS = [
  "하락", "급락", "폭락", "붕괴", "해킹", "유출", "규제", "제재", "기소", "사기", "악재",
  "파산", "손실", "이탈", "비관", "폭락장", "압류", "조사", "수사", "crash", "plunge",
  "fall", "drop", "bearish", "hack", "fraud", "ban", "dump", "loss", "lawsuit", "collapse"
];

/**
 * [Antigravity-Doc]
 * 역할: 기사 제목과 요약 본문에서 호재/악재 키워드 출현 빈도를 비교해 감성 레이블을 분류합니다.
 * 매개변수:
 * - title {string}: 정제된 기사 제목
 * - desc {string} [""]: 정제된 기사 요약
 * 반환값: {"BULLISH"|"BEARISH"|"NEUTRAL"} 판정된 감성 문자열
 */
function analyzeSentiment(title, desc = "") {
  const text = `${title} ${desc}`.toLowerCase();
  let bullScore = 0;
  let bearScore = 0;

  // [Antigravity-Doc] 사전별 포함 키워드 개수를 카운트하여 우세한 쪽으로 감성 결정
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

/**
 * [Antigravity-Doc]
 * 역할: 기사 제목과 본문에서 주요 코인·거래소·테마 키워드를 감지해 공백 구분 해시태그 문자열을 생성합니다.
 * 매개변수:
 * - title {string}: 기사 제목
 * - desc {string} [""]: 기사 요약
 * 반환값: {string} 예: `"#비트코인 #ETF"` (일치 항목 없을 시 기본값 `"#암호화폐"`)
 */
function extractKeywords(title, desc = "") {
  const text = `${title} ${desc}`.toLowerCase();
  const tags = [];

  // [Antigravity-Doc] 카테고리별 대표 태그와 매칭 동의어(한/영) 매핑 테이블
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

/**
 * [Antigravity-Doc]
 * 역할: 등록된 모든 암호화폐 RSS 피드에서 기사를 수집·중복 제거·정제·감성 분석하여 표준 기사 객체 배열로 반환합니다.
 * 매개변수: 없음
 * 반환값: {Promise<Array<object>>} `{ title, link, source, published_at, summary, sentiment, keywords }` 배열
 * 부수효과/예외 처리: 개별 피드 요청/파싱 실패 시 경고 로그만 남기고 나머지 피드 수집을 계속 진행합니다.
 */
export async function fetchAllCryptoNews() {
  // [Antigravity-Doc] 수집 대상 RSS 피드 목록 (구글 뉴스 국내/글로벌 + 토큰포스트)
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
  // [Antigravity-Doc] 동일 수집 사이클 내 링크 중복 제거용 Set
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

        // [Antigravity-Doc] Google News 특유의 "제목 - 언론사" 접미사를 감지해 실제 언론사명을 source로 분리
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

        // [Antigravity-Doc] 요약문은 최대 300자로 절단해 DB 저장 용량 및 UI 렌더링 길이 제한
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

/**
 * [Antigravity-Doc]
 * 역할: RSS에서 최신 암호화폐 뉴스를 수집한 뒤 `crypto_news` 테이블에 신규 기사만 중복 없이 삽입합니다.
 * 매개변수:
 * - db {object}: `prepare(sql).run(...)` 인터페이스를 지원하는 DB 래퍼 (`pgDb` 또는 `sqliteDb`)
 * 반환값: {Promise<number>} 실제 DB에 새로 저장된 기사 건수
 * 부수효과/예외 처리: 개별 행 삽입 오류(제약 위반 등)는 삼키고 나머지 기사를 계속 적재하며, 완료 요약을 콘솔에 로깅합니다.
 */
export async function syncNewsToDatabase(db) {
  const articles = await fetchAllCryptoNews();
  if (!articles || articles.length === 0) return 0;

  // [Antigravity-Doc] 수집 시점 기록용 created_at 타임스탬프 생성
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  let insertedCount = 0;
  // [Antigravity-Doc] link UNIQUE 제약을 활용한 INSERT OR IGNORE로 중복 기사 자동 스킵
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

/**
 * [Antigravity-Doc]
 * 역할: 키워드 및 발행일 범위 필터를 적용해 `crypto_news` 테이블에서 페이지네이션된 뉴스 목록을 조회합니다.
 * 매개변수:
 * - db {object}: DB 래퍼 인스턴스
 * - query {object}: `{ page = 1, limit = 50, keyword = "", startDate = "", endDate = "" }`
 * 반환값: {Promise<{items: object[], total: number, page: number, limit: number, total_pages: number}>}
 * 부수효과/예외 처리: `limit`은 1~100 범위로, `page`는 1 이상으로 안전하게 클램핑합니다.
 */
export async function queryNewsList(db, { page = 1, limit = 50, keyword = "", startDate = "", endDate = "" }) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 50));
  const offset = (p - 1) * l;

  // [Antigravity-Doc] 동적 WHERE 조건 및 바인딩 파라미터 조립 (SQL 인젝션 방지를 위해 모든 사용자 입력은 파라미터 바인딩)
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

  // [Antigravity-Doc] 전체 매칭 건수 집계 후 총 페이지 수 산출
  // 1. 전체 개수 조회
  const countRow = await db.prepare(`SELECT COUNT(*) AS total FROM crypto_news ${whereSql}`).get(...params);
  const total = countRow ? Number(countRow.total || 0) : 0;
  const totalPages = Math.ceil(total / l) || 1;

  // [Antigravity-Doc] 최신 발행일/ID 내림차순으로 현재 페이지 분량 조회
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

/**
 * [Antigravity-Doc]
 * 역할: Gemini AI 시황/뉴스 브리핑 생성에 투입할 최신 뉴스 요약 목록을 조회합니다.
 * 매개변수:
 * - db {object}: DB 래퍼 인스턴스
 * - limit {number} [12]: 조회할 최대 기사 수 (1~50 범위로 제한)
 * 반환값: {Promise<object[]>} 최신 기사 메타/요약 배열 (조회 실패 시 빈 배열)
 */
/**
 * AI 분석용 최신 암호화폐 뉴스 목록을 조회합니다.
 */
export async function getRecentNewsForAiAnalysis(db, limit = 12) {
  const safeLimit = Math.min(50, Math.max(1, Math.floor(Number(limit) || 12)));
  try {
    return await db
      .prepare(
        "SELECT title, source, published_at, sentiment, keywords, summary FROM crypto_news ORDER BY published_at DESC, id DESC LIMIT ?"
      )
      .all(safeLimit);
  } catch {
    return [];
  }
}

/**
 * [Antigravity-Doc]
 * 역할: `crypto_news` 테이블 전체의 누적 기사 수와 호재/악재/중립 감성별 건수를 집계합니다.
 * 매개변수:
 * - db {object}: DB 래퍼 인스턴스
 * 반환값: {Promise<{totalNews: number, bullCount: number, bearCount: number, neutCount: number}>} 감성 통계 객체 (실패 시 모두 0)
 */
/**
 * 수집된 암호화폐 뉴스의 전체 건수 및 호재/악재/중립 감성 통계를 반환합니다.
 */
export async function getNewsSentimentStats(db) {
  try {
    const countRow = await db
      .prepare(
        `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN sentiment = 'BULLISH' THEN 1 ELSE 0 END) AS bull,
          SUM(CASE WHEN sentiment = 'BEARISH' THEN 1 ELSE 0 END) AS bear,
          SUM(CASE WHEN sentiment = 'NEUTRAL' THEN 1 ELSE 0 END) AS neut
        FROM crypto_news
        `
      )
      .get();
    return {
      totalNews: Number(countRow?.total || 0),
      bullCount: Number(countRow?.bull || 0),
      bearCount: Number(countRow?.bear || 0),
      neutCount: Number(countRow?.neut || 0),
    };
  } catch {
    return {
      totalNews: 0,
      bullCount: 0,
      bearCount: 0,
      neutCount: 0,
    };
  }
}
