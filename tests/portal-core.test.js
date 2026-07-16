"use strict";

const assert = require("node:assert/strict");
const {
  createRequestRateLimiter,
  dedupeByUrl,
  extractReaderTitleCandidates,
  finalizeStructuredSourceItems,
  isUrlHostname,
  mapWithConcurrency,
  parseJapaneseDate,
  setUrlQueryParameter,
  stripTrailingSourceName
} = require("../shared/portal-core.js");

async function run() {
  testStructuredSourceMerge();
  testStructuredEmptyResult();
  testJapaneseDateParsing();
  testUrlUtilities();
  testReaderTitleCandidates();
  testTrailingSourceNameRemoval();
  await testConcurrencyLimit();
  await testConcurrentRateLimitedRuns();
  await testRequestRateLimiter();
  await testRateLimitExtensionDuringWait();
  await testRateLimitAbort();
  console.log("portal-core: 11 tests passed");
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

// Reader判定ではホスト名を厳密比較し、キャッシュ更新パラメータは既存query/hashを壊さない。
function testUrlUtilities() {
  assert.equal(isUrlHostname("https://r.jina.ai/https://example.com", "r.jina.ai"), true);
  assert.equal(isUrlHostname("https://r.jina.ai.example.com/", "r.jina.ai"), false);
  assert.equal(isUrlHostname("not a url", "r.jina.ai"), false);

  const updated = new URL(setUrlQueryParameter("https://example.com/news?page=2#latest", "portal_refresh", 123));
  assert.equal(updated.searchParams.get("page"), "2");
  assert.equal(updated.searchParams.get("portal_refresh"), "123");
  assert.equal(updated.hash, "#latest");
  assert.equal(setUrlQueryParameter("not a url", "portal_refresh", 123), "not a url");
}

// Reader本文ではTitle行とMarkdownのH1を候補に含め、同一見出しは一度だけ扱う。
function testReaderTitleCandidates() {
  const raw = [
    "Title: 桜花賞の追い切り速報 - スポニチ競馬Web",
    "",
    "# [](http://keiba.sponichi.co.jp/)",
    "",
    "# 桜花賞の枠順が決定",
    "",
    "# 桜花賞の追い切り速報 - スポニチ競馬Web"
  ].join("\n");

  assert.deepEqual(extractReaderTitleCandidates(raw), [
    "桜花賞の追い切り速報 - スポニチ競馬Web",
    "桜花賞の枠順が決定"
  ]);
  assert.deepEqual(extractReaderTitleCandidates("Title: 同じ見出し\n# 同じ見出し"), ["同じ見出し"]);
  assert.deepEqual(
    extractReaderTitleCandidates("Title:\nURL Source: https://example.com/news\n# 完全な記事見出し"),
    ["完全な記事見出し"]
  );
}

// 既知媒体名だけを末尾区切りごと除去し、別媒体や本文中の同名文字列は維持する。
function testTrailingSourceNameRemoval() {
  const sourceNames = ["スポニチ競馬Web", "Sponichi Annex"];
  ["-", "|", "｜", "―", "—"].forEach((separator) => {
    assert.equal(
      stripTrailingSourceName(`桜花賞の追い切り速報 ${separator} スポニチ競馬Web`, sourceNames),
      "桜花賞の追い切り速報"
    );
  });

  assert.equal(
    stripTrailingSourceName("桜花賞の追い切り速報 - 別媒体", sourceNames),
    "桜花賞の追い切り速報 - 別媒体"
  );
  assert.equal(
    stripTrailingSourceName("スポニチ競馬Webが伝えた桜花賞の追い切り速報", sourceNames),
    "スポニチ競馬Webが伝えた桜花賞の追い切り速報"
  );
  assert.equal(
    stripTrailingSourceName("桜花賞の追い切り速報 - SANSPO.COM", ["SANSPO.COM"]),
    "桜花賞の追い切り速報"
  );
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

// 同時投入したrunも予約順に開始枠を取り、開始時刻が設定間隔より狭くならないことを確認する。
async function testConcurrentRateLimitedRuns() {
  let currentTime = 0;
  const starts = [];
  const limiter = createRequestRateLimiter({
    minStartIntervalMs: 10,
    now: () => currentTime,
    wait: async (delayMs) => {
      currentTime += delayMs;
    }
  });

  await Promise.all([0, 1, 2].map(() => limiter.run(async () => {
    starts.push(currentTime);
    return responseLike(200, null);
  })));
  assert.deepEqual(starts, [0, 10, 20]);
}

// 429を受けた要求はRetry-Afterだけ待って1回再試行し、通信開始時刻を決定的に検証する。
async function testRequestRateLimiter() {
  let currentTime = 100000;
  const waits = [];
  const starts = [];
  const limiter = createRequestRateLimiter({
    minStartIntervalMs: 10,
    retryLimit: 1,
    defaultRetryAfterMs: 30000,
    now: () => currentTime,
    wait: async (delayMs) => {
      waits.push(delayMs);
      currentTime += delayMs;
    }
  });

  const response = await limiter.run(async (attempt) => {
    starts.push(currentTime);
    return responseLike(attempt === 0 ? 429 : 200, attempt === 0 ? "2" : null);
  });

  assert.equal(response.status, 200);
  assert.deepEqual(starts, [100000, 102000]);
  assert.deepEqual(waits, [2000]);
  assert.equal(limiter.parseRetryAfterMs("invalid"), 30000);
  assert.equal(limiter.parseRetryAfterMs("-1"), 30000);
  assert.equal(limiter.parseRetryAfterMs(new Date(currentTime + 5000).toUTCString()), 5000);
}

// 待機中に別要求がブロック時刻を延長しても、古い開始時刻のまま通信しないことを確認する。
async function testRateLimitExtensionDuringWait() {
  let currentTime = 0;
  let waitCount = 0;
  const waits = [];
  let limiter;

  limiter = createRequestRateLimiter({
    minStartIntervalMs: 10,
    defaultRetryAfterMs: 30,
    now: () => currentTime,
    wait: async (delayMs) => {
      waits.push(delayMs);
      waitCount += 1;
      if (waitCount === 1) limiter.block(30);
      currentTime += delayMs;
    }
  });

  await limiter.reserve();
  await limiter.reserve();
  assert.equal(currentTime, 30);
  assert.deepEqual(waits, [10, 20]);
}

// 見出し補完全体の期限に達した待機要求は通信を開始せず、後続予約は通常どおり継続できる。
async function testRateLimitAbort() {
  let currentTime = 0;
  let pendingWait = null;
  const limiter = createRequestRateLimiter({
    minStartIntervalMs: 10,
    now: () => currentTime,
    wait: (delayMs) => new Promise((resolve) => {
      pendingWait = () => {
        currentTime += delayMs;
        resolve();
      };
    })
  });

  await limiter.reserve();
  const controller = new AbortController();
  const abortedReservation = limiter.reserve(controller.signal);
  // 予約処理が実際の待機へ入ってから中止し、開始前Abortだけでなく待機途中の経路も通す。
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(typeof pendingWait, "function");
  controller.abort();
  await assert.rejects(abortedReservation, (error) => error && error.name === "AbortError");

  currentTime = 10;
  await limiter.reserve();
  assert.equal(currentTime, 10);
}

function responseLike(status, retryAfter) {
  return {
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "retry-after" ? retryAfter : null;
      }
    }
  };
}

function item(url, publishedAt) {
  return { url, publishedAt: new Date(publishedAt) };
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
