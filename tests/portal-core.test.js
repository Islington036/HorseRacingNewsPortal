"use strict";

const assert = require("node:assert/strict");
const {
  dedupeByUrl,
  finalizeStructuredSourceItems,
  mapWithConcurrency,
  parseJapaneseDate
} = require("../shared/portal-core.js");

async function run() {
  testStructuredSourceMerge();
  testStructuredEmptyResult();
  testJapaneseDateParsing();
  await testConcurrencyLimit();
  console.log("portal-core: 4 tests passed");
}

// APIと完全RSSで同じ記事を返しても、最新日時を残して新着順・上限件数へ揃うことを確認する。
function testStructuredSourceMerge() {
  const apiItems = [
    item("https://example.com/article/1?from=api", "2026-07-15T01:00:00Z"),
    item("https://example.com/article/2", "2026-07-15T02:00:00Z")
  ];
  const rssItems = [
    item("https://example.com/article/1#rss", "2026-07-15T03:00:00Z"),
    item("https://example.com/article/3", "2026-07-15T00:00:00Z")
  ];

  const result = finalizeStructuredSourceItems([...apiItems, ...rssItems], null, 2);
  assert.equal(result.hasResult, true);
  assert.deepEqual(result.items.map((entry) => entry.url), [
    "https://example.com/article/1#rss",
    "https://example.com/article/2"
  ]);
  assert.equal(dedupeByUrl([...apiItems, ...rssItems]).length, 3);
}

// 正常な0件応答と、すべての取得経路が失敗した状態を混同しないことを確認する。
function testStructuredEmptyResult() {
  assert.deepEqual(finalizeStructuredSourceItems([], [], 18), { hasResult: true, items: [] });
  assert.deepEqual(finalizeStructuredSourceItems([], null, 18), { hasResult: false, items: [] });
}

// タイムゾーンなし日時をJSTとして読み、年なし12月表記を年跨ぎで前年へ補正する。
function testJapaneseDateParsing() {
  assert.equal(parseJapaneseDate("2026/07/15 12:00").toISOString(), "2026-07-15T03:00:00.000Z");
  assert.equal(parseJapaneseDate("2026-07-15T12:00:00+09:00").toISOString(), "2026-07-15T03:00:00.000Z");
  assert.equal(parseJapaneseDate("2026-07-15 12:00:00Z").toISOString(), "2026-07-15T12:00:00.000Z");
  assert.equal(parseJapaneseDate("2026-07-15 12:00:00+0000").toISOString(), "2026-07-15T12:00:00.000Z");

  const newYear = new Date("2026-12-31T15:30:00.000Z"); // 2027-01-01 00:30 JST
  assert.equal(parseJapaneseDate("12月31日 23:00", newYear).toISOString(), "2026-12-31T14:00:00.000Z");
}

// サイト取得ワーカーが設定した同時実行数を超えないことを確認する。
async function testConcurrencyLimit() {
  let active = 0;
  let maximum = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.equal(maximum, 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
}

function item(url, publishedAt) {
  return { url, publishedAt: new Date(publishedAt) };
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
