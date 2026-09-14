// TSAL 연구현황 대시보드 <- Notion 동기화 스크립트
//
// 무엇을 하는가: Notion의 "연구리스트" DB를 조회해서 index.html 안의
// var DATA / var UPDATED_AT 두 줄만 새 값으로 바꿔치기한다. 그 외에는 파일을
// 건드리지 않는다.
//
// 실행: NOTION_API_KEY 환경변수(또는 같은 폴더의 .env)를 설정하고
//   node sync.js
//
// 대시보드를 GitHub Pages 등으로 옮긴 뒤에는 이 스크립트를 GitHub Actions
// 같은 무료 스케줄러에 얹고, 실행 후 index.html이 바뀌었으면 git commit +
// push 하도록 만들면 지금과 동일한 자동 동기화를 계속 쓸 수 있다.
// (예시: .github/workflows/sync.yml 참고)

const fs = require("fs");
const path = require("path");
const https = require("https");

// .env 파일이 있으면 읽어서 process.env 에 채워넣는다 (dotenv 패키지 없이 최소 구현)
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DB_ID = process.env.NOTION_DB_ID || "1b217295-e616-802a-aa46-fa4266d789c3";
const SEMANTIC_SCHOLAR_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY;
const TARGET_FILE = path.join(__dirname, "index.html");
const RELATED_CACHE_FILE = path.join(__dirname, "related_cache.json");
const RELATED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7일 지나면 재검색

if (!NOTION_API_KEY) {
  console.error("NOTION_API_KEY가 없습니다 (.env 파일 또는 환경변수로 설정하세요).");
  process.exit(1);
}

function nfc(s) {
  return (s || "").normalize("NFC");
}
function clean(s) {
  return nfc(s).trim();
}
function plainText(richTextArr) {
  return clean((richTextArr || []).map((t) => t.plain_text).join(""));
}

function notionQuery(cursor) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(
      cursor ? { page_size: 100, start_cursor: cursor } : { page_size: 100 }
    );
    const req = https.request(
      {
        hostname: "api.notion.com",
        path: `/v1/databases/${DB_ID}/query`,
        method: "POST",
        headers: {
          Authorization: "Bearer " + NOTION_API_KEY,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function fetchAllPages() {
  let all = [];
  let cursor;
  do {
    const d = await notionQuery(cursor);
    if (d.object === "error") throw new Error("Notion API error: " + JSON.stringify(d));
    all = all.concat(d.results);
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return all;
}

function propsToFields(props) {
  return {
    title: plainText(props["주저자"] && props["주저자"].title),
    engAuthors: ((props["주저자 영문"] && props["주저자 영문"].multi_select) || []).map((o) =>
      clean(o.name)
    ),
    field: props["분야"] && props["분야"].select ? clean(props["분야"].select.name) : "",
    status:
      props["진행상황"] && props["진행상황"].select ? clean(props["진행상황"].select.name) : "",
    topic: plainText(props["연구 주제"] && props["연구 주제"].rich_text),
    presented: !!(props["학회발표여부"] && props["학회발표여부"].checkbox),
    awarded: !!(props["수상여부"] && props["수상여부"].checkbox),
    journals: ((props["주요학술지"] && props["주요학술지"].multi_select) || []).map((o) =>
      clean(o.name)
    ),
  };
}

function transform(pages) {
  return pages.map((p) => Object.assign({ id: p.id }, propsToFields(p.properties)));
}

// 대량조회(/databases/{id}/query)가 간헐적으로 select/텍스트 값을 빈 값이나
// 손상된(U+FFFD) 문자로 반환하는 현상이 확인됨 (2026-09-10, 편집 직후뿐
// 아니라 시점과 무관하게 발생). 같은 페이지를 /pages/{id}로 단건 재조회하면
// 정상 값이 나온다.
function notionGetPage(id) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.notion.com",
        path: `/v1/pages/${id}`,
        method: "GET",
        headers: {
          Authorization: "Bearer " + NOTION_API_KEY,
          "Notion-Version": "2022-06-28",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 분야/진행상황/연구주제(제목) 중 하나라도 비어있거나 손상 문자(U+FFFD)가
// 섞여있으면 의심 대상으로 보고 단건 API로 재확인한다. 대량조회가 계속
// 불안정한 값을 주면 최대 3번까지 재시도한다.
function looksBad(fields) {
  return !fields.field || !fields.status || !fields.topic || JSON.stringify(fields).includes("�");
}

async function reverifySuspects(data) {
  const suspects = data.filter((d) => looksBad(d));
  if (suspects.length === 0) return;
  console.log(`값이 의심스러운 ${suspects.length}건을 단건 API로 재확인합니다...`);
  for (const d of suspects) {
    let fresh = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = await notionGetPage(d.id);
      if (!page.properties) continue;
      fresh = propsToFields(page.properties);
      if (!looksBad(fresh)) break;
      await sleep(1500);
    }
    if (!fresh) continue;
    if (fresh.field !== d.field || fresh.status !== d.status || fresh.topic !== d.topic) {
      console.warn(
        `재확인으로 값 복구: ${d.title} (분야 "${d.field}"→"${fresh.field}", 진행상황 "${d.status}"→"${fresh.status}", 주제 "${d.topic}"→"${fresh.topic}")`
      );
    }
    d.field = fresh.field;
    d.status = fresh.status;
    d.topic = fresh.topic;
  }
}

// ---------- 관련 논문(Semantic Scholar) ----------
// 우리 논문 자체가 아니라 "연구 주제" 텍스트에서 뽑은 키워드로 최근 발표된
// 관련 논문을 검색한다 (2026-09-14 조사: 국내 학회 논문/미출판 논문은 우리
// 논문 자체로 매칭이 거의 안 되지만, 주제 키워드 검색은 언어/출판여부와
// 무관하게 잘 작동함이 확인됨). LLM 토큰은 전혀 쓰지 않는다 — 불용어 제거
// 규칙만으로 키워드를 뽑고, 결과는 페이지별로 캐시해서 주제가 안 바뀌었으면
// 7일간 재검색하지 않는다 (Semantic Scholar 요청 수를 아끼기 위함).
const FIELD_EN = {
  기타: "transportation research",
  "인프라 및 정책평가": "transportation infrastructure policy evaluation",
  "통행행태 수요모형": "travel behavior demand model",
  신교통서비스: "emerging mobility service",
  대중교통운영: "public transit operations",
  마이크로모빌리티: "micromobility",
};

const STOPWORDS = new Set(
  "how to the of a an is are and for with from on by this that its it as in using based which who what does do did evaluating comparing case study application applicationof between has evolved tracing trajectory through role affect factors differently valued analysis".split(
    " "
  )
);

function hasKorean(s) {
  return /[가-힣]/.test(s || "");
}

function extractKeywords(text, max) {
  return text
    .replace(/[?:,.;()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, max || 6)
    .join(" ");
}

// 검색 쿼리 결정: 영문 주제는 키워드만 추출, 국영문 혼합이면 한글만 지워서
// 남는 영문이 충분하면 그걸 쓰고, 그마저 없으면(순수 한글) 분야를 영문
// 키워드로 대체해서 쓴다.
function queryForRecord(d) {
  const topic = (d.topic || "").trim();
  if (topic && !hasKorean(topic)) return extractKeywords(topic);
  if (topic) {
    const stripped = topic.replace(/[가-힣]/g, " ").replace(/\s+/g, " ").trim();
    if (stripped.length > 8) return extractKeywords(stripped);
  }
  return FIELD_EN[d.field] || null;
}

function loadRelatedCache() {
  try {
    return JSON.parse(fs.readFileSync(RELATED_CACHE_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}
function saveRelatedCache(cache) {
  fs.writeFileSync(RELATED_CACHE_FILE, JSON.stringify(cache, null, 2));
}

// Semantic Scholar 비인증/저활성 키 상태에서는 429가 잦아서 재시도가 필수임이
// 실측으로 확인됨 (2026-09-14). 최대 6번, 1.5초 간격 재시도.
async function s2search(query) {
  const thisYear = new Date().getFullYear();
  const url =
    "https://api.semanticscholar.org/graph/v1/paper/search?query=" +
    encodeURIComponent(query) +
    "&fields=title,year,venue,externalIds&year=" +
    (thisYear - 2) +
    "-&sort=publicationDate:desc&limit=5";
  for (let attempt = 0; attempt <= 6; attempt++) {
    const res = await fetch(url, { headers: { "x-api-key": SEMANTIC_SCHOLAR_API_KEY || "" } });
    if (res.status !== 429) {
      if (!res.ok) return [];
      const json = await res.json();
      return (json.data || []).map((p) => ({
        title: p.title,
        year: p.year,
        venue: p.venue || "",
        url: "https://www.semanticscholar.org/paper/" + p.paperId,
      }));
    }
    await sleep(1500);
  }
  return null; // 재시도 끝까지 429 — 이번 실행에서는 포기
}

async function attachRelatedPapers(data) {
  const cache = loadRelatedCache();
  if (!SEMANTIC_SCHOLAR_API_KEY) {
    console.warn("SEMANTIC_SCHOLAR_API_KEY가 없어 관련 논문은 캐시된 값만 사용합니다.");
    data.forEach((d) => { d.related = (cache[d.id] || {}).results || []; });
    return;
  }
  const now = Date.now();
  let refreshed = 0;
  for (const d of data) {
    const query = queryForRecord(d);
    const cached = cache[d.id];
    const fresh = cached && cached.query === query && now - new Date(cached.computedAt).getTime() < RELATED_MAX_AGE_MS;
    if (fresh) { d.related = cached.results; continue; }
    if (!query) { d.related = []; continue; }
    const results = await s2search(query);
    if (results === null) {
      d.related = cached ? cached.results : [];
      continue;
    }
    d.related = results;
    cache[d.id] = { query, computedAt: new Date().toISOString(), results };
    refreshed++;
    await sleep(600);
  }
  saveRelatedCache(cache);
  console.log(`관련 논문 갱신: ${refreshed}건 새로 검색, ${data.length - refreshed}건 캐시 사용`);
}

function nowInSeoul() {
  // 실행 서버의 타임존과 무관하게 항상 한국 시각을 얻는다 (YYYY-MM-DD-HH:mm)
  return new Date()
    .toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false })
    .slice(0, 16)
    .replace(" ", "-");
}

async function main() {
  const pages = await fetchAllPages();
  const data = transform(pages);

  if (data.length === 0) {
    console.error("Notion에서 0건이 조회됐습니다 — 오류로 판단해 배포를 중단합니다.");
    process.exit(1);
  }

  await reverifySuspects(data);

  const stillBroken = data.filter((d) => JSON.stringify(d).includes("�"));
  if (stillBroken.length > 0) {
    console.error(`재확인 후에도 손상된(�) 값이 ${stillBroken.length}건 남아있어 배포를 중단합니다:`);
    stillBroken.forEach((d) => console.error(` - ${d.title}: ${d.topic}`));
    process.exit(1);
  }

  await attachRelatedPapers(data);

  let html = fs.readFileSync(TARGET_FILE, "utf8");

  const dataLineRe = /^  var DATA = \[.*\];$/m;
  const updatedLineRe = /^  var UPDATED_AT = "[^"]*";$/m;

  if (!dataLineRe.test(html) || !updatedLineRe.test(html)) {
    throw new Error("index.html 안에서 var DATA / var UPDATED_AT 줄을 찾지 못했습니다.");
  }

  const outData = data.map(({ id, ...rest }) => rest);
  html = html.replace(dataLineRe, "  var DATA = " + JSON.stringify(outData) + ";");
  html = html.replace(updatedLineRe, '  var UPDATED_AT = "' + nowInSeoul() + '";');

  fs.writeFileSync(TARGET_FILE, html);

  console.log(`동기화 완료: ${data.length}건, 갱신시각 ${nowInSeoul()}`);
}

main().catch((e) => {
  console.error("동기화 실패:", e.message);
  process.exit(1);
});
