"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const core = require("../shared/portal-core.js");
const sourceParsers = require("../japanese/source-parsers.js");

const APP_SOURCE = fs.readFileSync(require.resolve("../japanese/app.js"), "utf8");
const CONFIG_SOURCE = fs.readFileSync(require.resolve("../japanese/config.js"), "utf8");

function createElement() {
  return {
    checked: false,
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    disabled: false,
    innerHTML: "",
    textContent: "",
    value: "",
    addEventListener() {},
    querySelectorAll() { return []; },
    setAttribute() {}
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createResponse(items) {
  return {
    headers: { get() { return null; } },
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ status: "ok", items });
    }
  };
}

function createHarness(cachedValue, options = {}) {
  const elements = new Map();
  const storage = new Map();
  const requests = new Map();
  let boot = null;

  if (cachedValue) storage.set("keiba-news-portal-cache-v2", JSON.stringify(cachedValue));

  const window = {
    matchMedia() { return { matches: Boolean(options.mobile) }; },
    addEventListener(type, listener) {
      if (type === "DOMContentLoaded") boot = listener;
    },
    clearTimeout() {},
    setTimeout() { return 1; }
  };
  const document = {
    body: createElement(),
    documentElement: {},
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, createElement());
      return elements.get(selector);
    },
    title: ""
  };
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, value); }
  };
  const context = vm.createContext({
    AbortController,
    Date,
    Intl,
    URL,
    console,
    document,
    fetch(url) {
      if (options.fetch) return options.fetch(url);
      const request = requests.get(url);
      if (!request) return Promise.reject(new Error(`unexpected request: ${url}`));
      return request.promise;
    },
    localStorage,
    DOMParser: options.DOMParser,
    window
  });

  vm.runInContext(CONFIG_SOURCE, context, { filename: "japanese/config.js" });
  const definition = window.JapaneseHorseRacingPortalDefinition;
  definition.CONFIG.SITES = options.sites || [{
    id: "alpha",
    name: "Alpha",
    apiUrl: "https://api.example/alpha",
    baseUrl: "https://alpha.example",
    parser: "rss2json"
  }, {
    id: "beta",
    name: "Beta",
    apiUrl: "https://api.example/beta",
    baseUrl: "https://beta.example",
    parser: "rss2json"
  }];
  if (options.configure) options.configure(definition.CONFIG);
  window.HorseRacingPortalCore = core;
  window.JapaneseHorseRacingSourceParsers = sourceParsers;
  vm.runInContext(APP_SOURCE, context, { filename: "japanese/app.js" });
  boot();

  return {
    elements,
    portal: window.JapaneseHorseRacingNewsPortal,
    requests,
    storage
  };
}

function cachedItem(sourceId, title, hoursAgo = 1) {
  const url = `https://${sourceId}.example/${title.toLowerCase().replace(/\s+/g, "-")}`;
  return {
    id: `${sourceId}:${url}`,
    sourceId,
    source: sourceId === "alpha" ? "Alpha" : "Beta",
    title,
    url,
    publishedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
    thumbnail: ""
  };
}

async function settleMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("expected state was not reached");
}

async function testIncrementalRenderingAndSuccessfulReplacement() {
  const lastUpdatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const harness = createHarness({
    lastUpdatedAt,
    siteLatest: {},
    allItems: [cachedItem("alpha", "Old Alpha"), cachedItem("beta", "Old Beta")]
  });
  const alphaRequest = createDeferred();
  const betaRequest = createDeferred();
  harness.requests.set("https://api.example/alpha", alphaRequest);
  harness.requests.set("https://api.example/beta", betaRequest);

  const refreshPromise = harness.portal.refresh();
  await settleMicrotasks();
  alphaRequest.resolve(createResponse([{
    title: "Fresh Alpha headline",
    link: "https://alpha.example/fresh",
    pubDate: new Date().toISOString(),
    thumbnail: "https://alpha.example/fresh.jpg"
  }]));
  await waitFor(() => harness.elements.get("#newsList").innerHTML.includes("Fresh Alpha headline"));

  const partialHtml = harness.elements.get("#newsList").innerHTML;
  assert.match(partialHtml, /Fresh Alpha headline/, "完了媒体は他媒体の待機中にも描画される");
  assert.match(partialHtml, /class="news-card is-new"[^>]*href="https:\/\/alpha\.example\/fresh"/, "逐次追加した新着には海外版と同じ上向きアニメーションを適用する");
  assert.match(partialHtml, /Old Beta/, "未完了媒体の前回キャッシュは途中表示で維持される");

  betaRequest.resolve(createResponse([{
    title: "Old Beta response",
    link: "https://beta.example/old-response",
    pubDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    thumbnail: ""
  }]));
  await refreshPromise;

  const finalHtml = harness.elements.get("#newsList").innerHTML;
  assert.match(finalHtml, /Fresh Alpha headline/);
  assert.doesNotMatch(finalHtml, /Old Beta/, "成功媒体の表示対象0件では旧記事を残さない");
  assert.notEqual(harness.portal.getSnapshot().lastUpdatedAt, lastUpdatedAt);
}

async function testAllFailuresPreserveCacheTimestamp() {
  const lastUpdatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const harness = createHarness({
    lastUpdatedAt,
    siteLatest: {},
    allItems: [cachedItem("alpha", "Old Alpha"), cachedItem("beta", "Old Beta")]
  });
  const alphaRequest = createDeferred();
  const betaRequest = createDeferred();
  harness.requests.set("https://api.example/alpha", alphaRequest);
  harness.requests.set("https://api.example/beta", betaRequest);

  const refreshPromise = harness.portal.refresh();
  await settleMicrotasks();
  alphaRequest.reject(new Error("alpha unavailable"));
  betaRequest.reject(new Error("beta unavailable"));
  await refreshPromise;

  assert.equal(harness.portal.getSnapshot().itemCount, 2);
  assert.equal(harness.portal.getSnapshot().lastUpdatedAt, lastUpdatedAt);
  assert.equal(harness.portal.getSnapshot().errorCount, 2);
}

function testInvalidCachedTimestampIsIgnored() {
  const harness = createHarness({
    lastUpdatedAt: "broken",
    siteLatest: {},
    allItems: [cachedItem("alpha", "Old Alpha")]
  });
  assert.equal(harness.portal.getSnapshot().lastUpdatedAt, null);
}

// 詳細を閉じても失敗を隠さず、0件・停止中の媒体は開いた詳細から確認できる。
async function testSourceDetailsKeepFailuresVisible() {
  const harness = createHarness({
    lastUpdatedAt: new Date().toISOString(),
    siteLatest: {},
    allItems: [cachedItem("alpha", "Old Alpha")]
  }, {
    mobile: true,
    fetch() { return Promise.reject(new Error("source unavailable")); }
  });
  const details = harness.elements.get("#sourceDetails");
  assert.equal(details.open, false);
  assert.match(harness.elements.get("#siteSummary").innerHTML, /Beta <span>0<\/span>/);
  assert.match(harness.elements.get("#pausedSources").innerHTML, /スポーツ報知/);
  assert.equal(harness.elements.get("#errorSummary").hidden, true);

  await harness.portal.refresh();
  assert.equal(details.open, false);
  assert.equal(harness.elements.get("#errorSummary").hidden, false);
  assert.match(harness.elements.get("#errorSummary").textContent, /取得失敗 2媒体/);
  // 利用者が開いた状態は、その後の再描画で初期値へ戻さない。
  details.open = true;
  await harness.portal.refresh();
  assert.equal(details.open, true);
}

// 本番の媒体設定を使い、公開ニュースの一覧Readerだけで表示まで完了することを確認する。
async function testSanspoUsesPublicNewsReaderListing() {
  const articleUrl = "https://www.sanspo.com/race/article/general/20261023-NEWS/";
  const requestedUrls = [];
  const readerUrl = "https://reader.example/sanspo-listing";
  const configuredWindow = {};
  vm.runInNewContext(CONFIG_SOURCE, { window: configuredWindow });
  const site = configuredWindow.JapaneseHorseRacingPortalDefinition.CONFIG.SITES.find((item) => item.id === "sanspo");
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString()
    .slice(0, 16).replace(/-/g, "/").replace("T", " ");
  const harness = createHarness(null, {
    sites: [site],
    configure(config) {
      config.TEXT_PROXY = () => readerUrl;
    },
    fetch(url) {
      requestedUrls.push(url);
      return Promise.resolve(createResponseText([
        "Published Time: Mon, 18 Aug 2025 05:27:27 GMT",
        "## 中央競馬ニュース",
        `### [サンスポ最新公開記事](${articleUrl})`,
        date,
        "## 特集",
        "### [固定ガイド](https://www.sanspo.com/race/article/general/20260424-GUIDE/)",
        date
      ].join("\n")));
    }
  });

  await harness.portal.refresh();

  assert.deepEqual(requestedUrls, [readerUrl]);
  assert.equal(harness.portal.getSnapshot().itemCount, 1);
  assert.equal(harness.portal.getSnapshot().errorCount, 0);
  const saved = JSON.parse(harness.storage.get("keiba-news-portal-cache-v2"));
  assert.equal(saved.allItems[0].url, articleUrl);
  assert.equal(saved.allItems[0].publishedAt, new Date(`${date.replace(/\//g, "-").replace(" ", "T")}:00+09:00`).toISOString());
  assert.match(harness.elements.get("#newsList").innerHTML, /サンスポ最新公開記事/);
  assert.match(harness.elements.get("#newsList").innerHTML, /thumb-fallback/);
  assert.doesNotMatch(harness.elements.get("#newsList").innerHTML, /固定ガイド/);
}

// Reader取得失敗とHTTP 200の抽出0件は区別して失敗扱いにし、どちらも前回記事・更新時刻を保つ。
async function testSanspoReaderFailureOrEmptyKeepsCache() {
  const articleUrl = "https://www.sanspo.com/race/article/general/20261002-AAAAAAAAAAAAAAAAAAAAAAAAAA/";
  const site = {
    id: "sanspo", name: "サンスポ", baseUrl: "https://www.sanspo.com",
    url: "https://www.sanspo.com/race/keiba/",
    parser: "sanspo", readerListing: true
  };
  const readerUrl = "https://reader.example/sanspo-listing";

  for (const emptyResponse of [false, true]) {
    const requestedUrls = [];
    const lastUpdatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const oldItem = { ...cachedItem("sanspo", "前回サンスポ記事"), url: articleUrl, source: "サンスポ" };
    const harness = createHarness({ lastUpdatedAt, siteLatest: {}, allItems: [oldItem] }, {
      sites: [site],
      configure(config) {
        config.TEXT_PROXY = () => readerUrl;
      },
      fetch(url) {
        requestedUrls.push(url);
        if (emptyResponse) return Promise.resolve(createResponseText("## 中央競馬ニュース\n## レース情報"));
        return Promise.reject(new Error("source unavailable"));
      }
    });
    await harness.portal.refresh();
    assert.deepEqual(requestedUrls, [readerUrl]);
    assert.equal(harness.portal.getSnapshot().itemCount, 1);
    assert.equal(harness.portal.getSnapshot().errorCount, 1);
    assert.match(harness.elements.get("#newsList").innerHTML, /前回サンスポ記事/);
    assert.equal(harness.portal.getSnapshot().lastUpdatedAt, lastUpdatedAt);
    assert.match(harness.elements.get("#errorList").innerHTML,
      emptyResponse ? /ヘッドラインを抽出できませんでした/ : /source unavailable/);
  }
}

async function testTospoUsesOfficialSitemapTextFallbackWithoutReaderCards(readerText = "Title: エラー\nただいまアクセスが集中しています", headline = "フォールバックで取得した公式見出し", cachedValue = null) {
  class ErrorDomParser {
    parseFromString() {
      return {
        querySelector(selector) { return selector === "parsererror" ? {} : null; }
      };
    }
  }

  const site = {
    id: "tospo",
    name: "東スポ競馬",
    url: "https://tospo-keiba.jp/news",
    sitemapUrl: "https://tospo-keiba.jp/sitemap_news_1.xml",
    sitemapTextFallbackUrl: "https://fallback.example/tospo-sitemap",
    readerListingUrls: [],
    baseUrl: "https://tospo-keiba.jp",
    readerCacheBust: true
  };
  const harness = createHarness(cachedValue, {
    DOMParser: ErrorDomParser,
    sites: [site],
    configure(config) {
      config.TEXT_PROXY_MIN_INTERVAL_MS = 0;
      config.TEXT_PROXY_RETRY_LIMIT = 0;
      config.TEXT_PROXY = (url) => `https://reader.example/${encodeURIComponent(url)}`;
    },
    fetch(url) {
      if (url.startsWith("https://reader.example/")) {
        return Promise.resolve(createResponseText(readerText));
      }
      if (url === site.sitemapTextFallbackUrl) {
        return Promise.resolve(createResponseText(
          "https://tospo-keiba.jp/breaking\\_news/75702 東スポ競馬 ja " +
          `${new Date().toISOString()} ${headline}`
        ));
      }
      return Promise.reject(new Error(`unexpected request: ${url}`));
    }
  });

  await harness.portal.refresh();

  assert.equal(harness.portal.getSnapshot().itemCount, 1);
  assert.equal(harness.portal.getSnapshot().errorCount, 0);
  assert.ok(harness.elements.get("#newsList").innerHTML.includes(headline));
  assert.match(harness.elements.get("#newsList").innerHTML, /class="thumb thumb-fallback"/, "一覧Readerが失敗した記事は共通ダミー画像を表示する");
  return harness;
}

// 実見出しの先頭「競馬」をカテゴリ扱いで消さず、同URLの欠けた保存済み見出しも次回成功時に置き換える。
async function testTospoHeadlinePreservesKeibaPrefix() {
  const headline = "競馬の神様がくれた地道な積み重ねへの「ご褒美」 福永調教師1日3場メイン制覇の偉業達成";
  const articleUrl = "https://tospo-keiba.jp/breaking_news/75702";
  const cachedTitle = headline.slice(2);
  const harness = await testTospoUsesOfficialSitemapTextFallbackWithoutReaderCards(undefined, headline, {
    siteLatest: {},
    allItems: [{
      ...cachedItem("tospo", "旧見出し"),
      id: `tospo:${articleUrl}`,
      url: articleUrl,
      title: cachedTitle
    }]
  });
  const saved = JSON.parse(harness.storage.get("keiba-news-portal-cache-v2"));
  assert.equal(saved.allItems.length, 1);
  assert.equal(saved.allItems[0].title, headline);
}

function createResponseText(text) {
  return {
    headers: { get() { return null; } },
    ok: true,
    status: 200,
    async text() { return text; }
  };
}

async function run() {
  await testIncrementalRenderingAndSuccessfulReplacement();
  await testAllFailuresPreserveCacheTimestamp();
  testInvalidCachedTimestampIsIgnored();
  await testSanspoUsesPublicNewsReaderListing();
  await testSanspoReaderFailureOrEmptyKeepsCache();
  await testTospoUsesOfficialSitemapTextFallbackWithoutReaderCards();
  await testTospoUsesOfficialSitemapTextFallbackWithoutReaderCards("[article](https://tospo-keiba.jp/breaking_news/75702)");
  await testTospoHeadlinePreservesKeibaPrefix();
  await testSourceDetailsKeepFailuresVisible();
  console.log("japanese-refresh: 9 tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
