"use strict";

const assert = require("node:assert/strict");
const {
  extractRacenetReaderCards,
  isRacenetArticleUrl,
  pickRacenetReaderTitle
} = require("../international/source-parsers.js");

function run() {
  testRacenetReaderCards();
  testRacenetLongTitleFallback();
  testRacenetFixedPages();
  console.log("international-source-parsers: 3 tests passed");
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

function card(image, body, slug, decoration = "") {
  return `[![Image](${image})${decoration} ${body}](https://www.racenet.com.au/news/${slug})`;
}

run();
