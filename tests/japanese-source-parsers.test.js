"use strict";

const assert = require("node:assert/strict");
const { extractSponichiReaderItems } = require("../japanese/source-parsers.js");

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
  console.log("japanese-source-parsers: 2 tests passed");
}

run();
