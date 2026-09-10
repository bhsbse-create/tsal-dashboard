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
const TARGET_FILE = path.join(__dirname, "index.html");

if (!NOTION_API_KEY) {
  console.error("NOTION_API_KEY가 없습니다 (.env 파일 또는 환경변수로 설정하세요).");
  process.exit(1);
}

// 알려진 손상 문자(U+FFFD) 교정. Notion DB 자체에 인코딩이 깨진 채로 저장된
// 값이 있어서(원인 미상) 정규화(NFC)만으로는 못 고치는 것들.
// 새로운 깨진 값을 만나면 여기 추가하면 된다.
const FIX_MAP = {
  "통��행태 수요모형": "통행행태 수요모형",
  "대한��통학회": "대한교통학회",
  "2024 서울시 버��파업이 기존 수단에 미치는 영향": "2024 서울시 버스파업이 기존 수단에 미치는 영향",
};

function nfc(s) {
  return (s || "").normalize("NFC");
}
function fix(s) {
  return FIX_MAP[s] || s;
}
function clean(s) {
  return fix(nfc(s)).trim();
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

function transform(pages) {
  return pages.map((p) => {
    const props = p.properties;
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
  });
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

  const stillBroken = data.filter((d) => JSON.stringify(d).includes("�"));
  if (stillBroken.length > 0) {
    console.warn(
      `경고: FIX_MAP에 없는 손상된(U+FFFD) 값이 ${stillBroken.length}건 남아있습니다. Notion에서 직접 확인하거나 sync.js의 FIX_MAP에 추가하세요.`
    );
  }

  let html = fs.readFileSync(TARGET_FILE, "utf8");

  const dataLineRe = /^  var DATA = \[.*\];$/m;
  const updatedLineRe = /^  var UPDATED_AT = "[^"]*";$/m;

  if (!dataLineRe.test(html) || !updatedLineRe.test(html)) {
    throw new Error("index.html 안에서 var DATA / var UPDATED_AT 줄을 찾지 못했습니다.");
  }

  html = html.replace(dataLineRe, "  var DATA = " + JSON.stringify(data) + ";");
  html = html.replace(updatedLineRe, '  var UPDATED_AT = "' + nowInSeoul() + '";');

  fs.writeFileSync(TARGET_FILE, html);

  console.log(`동기화 완료: ${data.length}건, 갱신시각 ${nowInSeoul()}`);
}

main().catch((e) => {
  console.error("동기화 실패:", e.message);
  process.exit(1);
});
