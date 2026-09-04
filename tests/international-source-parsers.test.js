"use strict";

const assert = require("node:assert/strict");
const {
  extractRacenetReaderCards,
  extractRacingTvReaderCards,
  extractTheAgeReaderItems,
  hasExplicitTimezone,
  isCandidateArticleUrl,
  isRacenetArticleUrl,
  isTtrAusNzFixedPage,
  parseInternationalDate,
  parseExplicitTimezoneDate,
  pickRacenetReaderTitle
} = require("../international/source-parsers.js");

function run() {
  testRacenetReaderCards();
  testRacenetLongTitleFallback();
  testRacenetFixedPages();
  testExplicitTimezoneDates();
  testSharedArticleUrlGate();
  testRacingTvReaderCards();
  testTheAgeReaderItems();
  console.log("international-source-parsers: 7 tests passed");
}

// 通常カードとpremium鍵付きカードの両方で、最初の実写真と個別記事URLを維持する。
function testRacenetReaderCards() {
  const normalCards = Array.from({ length: 7 }, (_, index) =>
    card(
      `https://images.puntcdn.com/news-${index + 1}.jpg`,
      `Horse Racing Headline Number ${index + 1} was published 9 hours ago with a useful summary.`,
      `horse-racing-headline-number-${index + 1}-20260723`
    )
  );
  const premiumCards = Array.from({ length: 3 }, (_, index) =>
    card(
      `https://images.puntcdn.com/premium-${index + 1}.jpg`,
      `Premium Racing Headline Number ${index + 1} was published 11 hours ago with a useful summary.`,
      `premium-racing-headline-number-${index + 1}-20260723`,
      " ![Image: premium lock](https://www.racenet.com.au/assets/lock-gold-alt.svg)"
    )
  );

  const cards = extractRacenetReaderCards([...normalCards, ...premiumCards].join("\n"));
  assert.equal(cards.length, 10);
  assert.equal(new Set(cards.map((entry) => entry.url)).size, 10);
  assert.ok(cards.every((entry) => entry.thumbnail.startsWith("https://images.puntcdn.com/")));
  assert.ok(cards.every((entry) => !entry.thumbnail.includes("lock-gold-alt.svg")));
}

// 見出しと要約が240文字を超えて連結された場合も、記事を落とさずURLスラッグ由来の題へ戻す。
function testRacenetLongTitleFallback() {
  const url = "https://www.racenet.com.au/news/emerging-stayer-brillantezza-eyes-hattrick-despite-caulfield-challenge-20260723";
  const body = `Yendall backs filly for hat-trick bid at Caulfield ${"long summary ".repeat(24)}`;
  const title = pickRacenetReaderTitle(body, url);

  assert.equal(title, "Emerging Stayer Brillantezza Eyes Hattrick Despite Caulfield Challenge");
  assert.ok(title.length <= 240);
}

// 記者・カテゴリなどの固定導線は、カードに似たMarkdownでも個別記事として扱わない。
function testRacenetFixedPages() {
  assert.equal(isRacenetArticleUrl("https://www.racenet.com.au/news/journalist/aaron-mills"), false);
  assert.equal(isRacenetArticleUrl("https://www.racenet.com.au/news/category/horse-racing"), false);
  assert.equal(
    extractRacenetReaderCards(
      card(
        "https://images.puntcdn.com/profile.jpg",
        "This is a long journalist profile card that resembles an article card.",
        "journalist/aaron-mills"
      )
    ).length,
    0
  );
}

// RSSのGMTと地域別の夏時間を明示どおり解釈し、曖昧な略称は推測しない。
function testExplicitTimezoneDates() {
  assert.equal(
    parseExplicitTimezoneDate("Tue, 01 Sep 2026 19:11:46 GMT").toISOString(),
    "2026-09-01T19:11:46.000Z"
  );
  assert.equal(
    parseExplicitTimezoneDate("1st September 2026 19:11 BST").toISOString(),
    "2026-09-01T18:11:00.000Z"
  );
  assert.equal(
    parseExplicitTimezoneDate("September 1, 2026 19:11 HKT").toISOString(),
    "2026-09-01T11:11:00.000Z"
  );
  assert.equal(parseExplicitTimezoneDate("September 1, 2026 19:11 IST"), null);
  assert.equal(parseExplicitTimezoneDate("September 1, 2026 19:11 CST"), null);
  assert.equal(hasExplicitTimezone("September 1, 2026 19:11"), false);
  assert.equal(hasExplicitTimezone("September 1, 2026 19:11 AEDT"), true);
  assert.equal(
    parseInternationalDate("5 hours ago", Date.UTC(2026, 8, 5, 12)).toISOString(),
    "2026-09-05T07:00:00.000Z"
  );
  assert.equal(parseInternationalDate("September 4, 2026") instanceof Date, true);
  assert.equal(parseInternationalDate("May 16"), null);
}

// 本体とテスターが同じホスト・パス・プロトコル条件で記事URLを判定する。
function testSharedArticleUrlGate() {
  const site = {
    id: "theage_racing",
    url: "https://www.theage.com.au/sport/racing",
    baseUrl: "https://www.theage.com.au",
    pathHints: ["/sport/racing/"]
  };
  assert.equal(
    isCandidateArticleUrl("https://www.theage.com.au/sport/racing/proper-story-20260904-p60abc.html", site),
    true
  );
  assert.equal(isCandidateArticleUrl("https://outside.example/sport/racing/story.html", site), false);
  assert.equal(isCandidateArticleUrl("ftp://www.theage.com.au/sport/racing/story.html", site), false);
  assert.equal(isCandidateArticleUrl("https://www.theage.com.au/sport/racing", site), false);
  assert.equal(isTtrAusNzFixedPage("job-board"), true);
  assert.equal(isTtrAusNzFixedPage("looking-ahead-next-week"), true);
  assert.equal(isTtrAusNzFixedPage("saturday-preview"), false);
}

// Racing TV一覧は各画像と同じ記事URLを結び、公開相対時刻があるカードだけ日時を返す。
function testRacingTvReaderCards() {
  const text = [
    "[![Image](https://images.example/first.webp) Five horses to follow on Saturday 5 hours ago Summary follows. Read More](https://www.racingtv.com/news/five-horses-to-follow)",
    "[![Image](https://images.example/second.webp) Another proper racing headline](https://www.racingtv.com/news/another-proper-racing-headline)"
  ].join("\n");
  const items = extractRacingTvReaderCards(text);
  const nowMs = Date.UTC(2026, 8, 5, 12);

  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Five horses to follow on Saturday");
  assert.equal(items[0].publishedAt, "5 hours ago");
  assert.equal(items[1].publishedAt, "");
  // 同じ一覧取得時刻を渡せば、同じ相対表記は処理順にかかわらず完全に同じDateになる。
  assert.equal(
    parseInternationalDate(items[0].publishedAt, nowMs).getTime(),
    parseInternationalDate("5 hours ago", nowMs).getTime()
  );
}

// The Age一覧では画像カード、見出し、日付が同じ記事URLに属する場合だけ記事化する。
function testTheAgeReaderItems() {
  const text = [
    "[![Image 1: First story](https://images.example/first.jpg)](https://www.theage.com.au/sport/racing/first-story-20260904-p60abc.html)",
    "##### [Horse racing](https://www.theage.com.au/topic/horse-racing-1n6g)",
    "### [First story headline](https://www.theage.com.au/sport/racing/first-story-20260904-p60abc.html)",
    "Summary.",
    "*   September 4, 2026",
    "*   by Reporter",
    "[![Image 2: Second story](https://images.example/second.jpg)](https://www.theage.com.au/sport/racing/second-story-20260903-p60def.html)",
    "### [Second story headline](https://www.theage.com.au/sport/racing/second-story-20260903-p60def.html)",
    "*   September 3, 2026"
  ].join("\n");
  const items = extractTheAgeReaderItems(text);

  assert.equal(items.length, 2);
  assert.equal(items[0].title, "First story headline");
  assert.equal(items[0].publishedAt, "September 4, 2026");
  assert.equal(items[1].thumbnail, "https://images.example/second.jpg");
}

function card(image, body, slug, decoration = "") {
  return `[![Image](${image})${decoration} ${body}](https://www.racenet.com.au/news/${slug})`;
}

run();
