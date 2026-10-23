"use strict";

const assert = require("node:assert/strict");
const {
  extractSanspoReaderItems,
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

  // generalパスの会員予想も別欄には存在するため、URL形式だけでなくニュース欄の境界を確認する。
  const memberCards = Array.from({ length: 8 }, (_, index) => [
    `### [会員予想${index}](https://www.sanspo.com/race/article/general/20261023-MEMBER${index}/)`,
    "2026/10/23 16:30",
    "![Image](https://www.sanspo.com/resizer/v2/member.jpg)"
  ].join("\n")).join("\n");
  const sanspoReader = [
    "Title: 中央競馬 - サンスポZBAT!",
    "Published Time: Mon, 18 Aug 2025 05:27:27 GMT",
    "Markdown Content:",
    "## 予想",
    memberCards,
    "## 中央競馬ニュース",
    "### [日時なし](https://www.sanspo.com/race/article/general/20261023-NODATE/)",
    "### [公開ニュースの完全見出し](https://www.sanspo.com/race/article/general/20261023-NEWS1/)",
    "2026/10/23 15:09",
    "[その他](https://www.sanspo.com/race/keiba/contents/)",
    "![Image 3](https://www.sanspo.com/resizer/v2/news.jpg?width=856&height=570)",
    "### [写真のないゲート試験記事](https://www.sanspo.com/race/article/general/20261023-NEWS2/)",
    "2026/10/23 14:38",
    "![Image 6](https://www.sanspo.com/resizer/v2/https%3A%2F%2Fwww.sanspo.com%2Fcommon%2Fimages%2Fbasic%2Fthumb_keiba_og.jpg?width=150)",
    "### [画像を配信しない記事](https://www.sanspo.com/race/article/general/20261023-NEWS3/)",
    "2026/10/23 14:30 JST",
    "### [会員ページ](https://www.sanspo.com/race/article/basic/20261023-MEMBER/)",
    "2026/10/23 14:20",
    "![Image](https://www.sanspo.com/resizer/v2/next-card.jpg)",
    "## レース情報",
    "![Image](https://www.sanspo.com/resizer/v2/next-section.jpg)",
    "### [馬柱ガイド](https://www.sanspo.com/race/article/general/20260424-GUIDE/)",
    "2026/10/23 14:00",
    "## 動画ピックアップ",
    "### [省略された動画…](https://www.sanspo.com/race/article/general/20261022-VIDEO/)",
    "2026/10/22 19:04",
    "## 予想",
    memberCards
  ].join("\n");
  assert.deepEqual(extractSanspoReaderItems(sanspoReader), [{
    title: "公開ニュースの完全見出し",
    url: "https://www.sanspo.com/race/article/general/20261023-NEWS1/",
    publishedAt: "2026-10-23T15:09:00+09:00",
    thumbnail: "https://www.sanspo.com/resizer/v2/news.jpg?width=856&height=570"
  }, {
    title: "写真のないゲート試験記事",
    url: "https://www.sanspo.com/race/article/general/20261023-NEWS2/",
    publishedAt: "2026-10-23T14:38:00+09:00",
    thumbnail: ""
  }, {
    title: "画像を配信しない記事",
    url: "https://www.sanspo.com/race/article/general/20261023-NEWS3/",
    publishedAt: "2026-10-23T14:30:00+09:00",
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
    "https://tospo-keiba.jp/sakagamiblood/76816 東スポ競馬 ja 2026-09-17T19:15:00+09:00 血統査定の記事は対象外",
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
  console.log("japanese-source-parsers: 5 tests passed");
}

run();
