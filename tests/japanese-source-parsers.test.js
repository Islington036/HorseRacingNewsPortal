"use strict";

const assert = require("node:assert/strict");
const {
  extractSponichiReaderItems,
  extractTospoReaderCards,
  extractTospoSitemapTextItems
} = require("../japanese/source-parsers.js");

function run() {
  const text = [
    "*   ![Image 2](https://www.sponichi.co.jp/gamble/news/sample.webp) **[【新潟記念】追い切り速報...](https://keiba.sponichi.co.jp/news/20260827s00004000055000c)**2026年8月27日 05:28",
    "*   ![Image 3](https://keiba.sponichi.co.jp/front/images/dummy/news/4.jpg) **[【門別競馬】重賞結果](https://keiba.sponichi.co.jp/news/20260827s00004049351000c)**2026年8月27日 05:27",
    "*   [ニュース](https://keiba.sponichi.co.jp/news)",
    "*   ![広告](https://example.com/ad.jpg) **[競馬以外](https://example.com/news/1)**2026年8月27日 05:27"
  ].join("\n");

  assert.deepEqual(extractSponichiReaderItems(text), [{
    title: "【新潟記念】追い切り速報...",
    url: "https://keiba.sponichi.co.jp/news/20260827s00004000055000c",
    publishedAt: "2026-08-27T05:28:00+09:00",
    thumbnail: "https://www.sponichi.co.jp/gamble/news/sample.webp"
  }, {
    title: "【門別競馬】重賞結果",
    url: "https://keiba.sponichi.co.jp/news/20260827s00004049351000c",
    publishedAt: "2026-08-27T05:27:00+09:00",
    thumbnail: ""
  }]);

  const tospoReader = [
    "[![Image](https://tospo-keiba.jp/images/article/thumbnail/20260917/170048/sample.jpg)](https://tospo-keiba.jp/breaking_news/75702) [完全見出し](https://tospo-keiba.jp/breaking_news/75702)",
    "ニュース",
    "2026/09/17",
    "(木)",
    "17:00"
  ].join("\n");
  assert.deepEqual(extractTospoReaderCards(tospoReader), [{
    title: "完全見出し",
    url: "https://tospo-keiba.jp/breaking_news/75702",
    publishedAt: "2026-09-17T17:00:00+09:00",
    thumbnail: "https://tospo-keiba.jp/images/article/thumbnail/20260917/170048/sample.jpg"
  }]);

  const flattenedSitemap = [
    "https://tospo-keiba.jp/breaking\\_news/75702 東スポ競馬 ja 2026-09-17T17:00:49+09:00 最新ニュース見出し",
    "https://tospo-keiba.jp/forecast/75613 東スポ競馬 ja 2026-09-17T18:00:00+09:00 予想記事は対象外",
    "https://tospo-keiba.jp/breaking\\_news/75612 東スポ競馬 ja 2026-09-17T09:22:20+09:00 次のニュース見出し"
  ].join(" ");
  assert.deepEqual(extractTospoSitemapTextItems(flattenedSitemap), [{
    title: "最新ニュース見出し",
    url: "https://tospo-keiba.jp/breaking_news/75702",
    publishedAt: "2026-09-17T17:00:49+09:00",
    thumbnail: ""
  }, {
    title: "次のニュース見出し",
    url: "https://tospo-keiba.jp/breaking_news/75612",
    publishedAt: "2026-09-17T09:22:20+09:00",
    thumbnail: ""
  }]);
  console.log("japanese-source-parsers: 4 tests passed");
}

run();
