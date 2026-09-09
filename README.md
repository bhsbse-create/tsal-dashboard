# TSAL 연구현황 대시보드

노션 "연구리스트" DB를 읽어서 만드는 정적 대시보드. 클로드 계정 없이도 이 폴더만 있으면 계속 쓸 수 있음.

## 파일 구성

- `index.html` — 대시보드 본체. 순수 HTML/CSS/JS 한 파일, 서버 필요 없음. 그냥 브라우저로 열어도 되고, 아무 정적 호스팅에 올려도 됨.
- `sync.js` — 노션 API로 최신 데이터를 가져와서 `index.html` 안의 데이터 두 줄(`var DATA`, `var UPDATED_AT`)만 바꿔치기하는 Node.js 스크립트. 그 외 내용(비밀번호, 디자인, 로직)은 안 건드림.
- `.env` — 노션 API 키 (`NOTION_API_KEY`). **깃에 올리면 안 됨** — `.gitignore`에 이미 등록되어 있음.
- `.env.example` — `.env` 만들 때 참고용 템플릿.
- `.github/workflows/sync.yml` — GitHub Actions로 6시간마다 자동 동기화하는 설정 (GitHub에 올렸을 때만 동작).

현재 지금 클로드 계정으로는 `index.html`이 Claude Artifact로 호스팅되고 있고, 클로드 스케줄 작업(routine, 6시간마다)이 `sync.js`와 같은 로직으로 자동 갱신 중임. 이 폴더는 그것과 **완전히 별개로, 클로드 없이도** 돌아가게 만든 이식용 사본임.

## 로컬에서 수동으로 동기화하기

```
cd tsal-notion
node sync.js
```

`.env`에 `NOTION_API_KEY`만 있으면 됨 (Node.js 18+ 필요, 별도 패키지 설치 불필요).

## 다른 곳에 호스팅하기 (클로드 없이 계속 쓰고 싶을 때)

1. 이 폴더를 GitHub 저장소로 만들기 (private 추천 — 비밀번호가 코드에 그대로 박혀있음).
2. 저장소 Settings → Pages에서 GitHub Pages 켜기 (브랜치: main, 루트).
3. 저장소 Settings → Secrets and variables → Actions에서 `NOTION_API_KEY`를 시크릿으로 등록.
4. 그러면 `.github/workflows/sync.yml`이 6시간마다 알아서 `sync.js`를 돌리고, 데이터가 바뀌면 자동으로 커밋 + 푸시 → GitHub Pages가 자동으로 최신 버전을 서빙함.
5. Actions 탭에서 "Run workflow" 누르면 즉시 한 번 수동 실행도 가능.

GitHub Pages 대신 Netlify, Vercel 등 다른 정적 호스팅을 써도 동일한 방식(스케줄러 + `sync.js` + 커밋)으로 대체 가능.

## 알아둘 것

- 비밀번호 게이트는 `index.html` 안에 평문으로 박혀있는 클라이언트 사이드 체크임 (지금 `tsal308*`). 진짜 보안이 아니라 가벼운 접근 차단용 — 코드를 볼 수 있는 사람이면 누구나 우회 가능.
- 노션 "연구리스트" DB의 select 옵션 중 일부가 실제로 인코딩이 깨진 채로 저장되어 있음 (원인 불명). `sync.js`의 `FIX_MAP`에서 알려진 3건을 자동 교정함. 새로운 깨진 값이 생기면 콘솔에 경고가 뜨니, 그때 `FIX_MAP`에 항목을 추가하거나 노션에서 해당 옵션을 직접 재입력해서 정리하면 됨.
- 노션 DB 스키마가 바뀌면(속성 이름 변경 등) `sync.js`의 `transform()` 함수 안 속성 이름 매핑도 같이 고쳐야 함.
