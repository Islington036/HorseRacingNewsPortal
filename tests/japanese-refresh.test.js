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

async function testSanspoFiltersMemberPagesBeforeHydrationLimit() {
  const basicUrls = [
    "https://www.sanspo.com/race/article/basic/20260905-AAAAAAAAAAAAAAAAAAAAAAAAAA/",
    "https://www.sanspo.com/race/article/basic/20260905-BBBBBBBBBBBBBBBBBBBBBBBBBB/"
  ];
  const generalUrls = [
    "https://www.sanspo.com/race/article/general/20260905-CCCCCCCCCCCCCCCCCCCCCCCCCC/",
    "https://www.sanspo.com/race/article/general/20260905-DDDDDDDDDDDDDDDDDDDDDDDDDD/"
  ];
  const requestedUrls = [];

  class SitemapDomParser {
    parseFromString() {
      const urls = [...basicUrls, ...generalUrls];
      return {
        querySelector() { return null; },
        getElementsByTagNameNS(_namespace, localName) {
          if (localName !== "url") return [];
          return urls.map((url) => ({
            getElementsByTagNameNS(_childNamespace, childLocalName) {
              return childLocalName === "loc" ? [{ textContent: url }] : [];
            }
          }));
        }
      };
    }
  }

  const site = {
    id: "sanspo",
    name: "サンスポ",
    url: "https://www.sanspo.com/race/keiba/",
    sitemapUrl: "https://www.sanspo.com/feeds/sitemap-race-keiba/?outputType=xml&from=0",
    baseUrl: "https://www.sanspo.com",
    articlePathPattern: /^\/race\/article\/general\/20\d{6}-[A-Z0-9]+\/?$/i,
    detailHydrationLimit: 2,
    detailHydrationConcurrency: 2
  };
  const harness = createHarness(null, {
    DOMParser: SitemapDomParser,
    sites: [site],
    configure(config) {
      config.CORS_PROXY = () => "https://proxy.example/sanspo-sitemap";
      config.CORS_PROXY_FALLBACKS = [];
      config.TEXT_PROXY = (url) => `https://reader.example/${encodeURIComponent(url)}`;
    },
    fetch(url) {
      requestedUrls.push(url);
      if (url === "https://proxy.example/sanspo-sitemap") {
        return Promise.resolve(createResponseText("sitemap"));
      }

      const articleUrl = decodeURIComponent(url.replace("https://reader.example/", ""));
      const articleId = articleUrl.includes("CCCC") ? "C" : "D";
      return Promise.resolve(createResponseText([
        `Title: サンスポ公開記事${articleId}`,
        "",
        `URL Source: ${articleUrl}`,
        "",
        `Published Time: ${new Date().toISOString()}`
      ].join("\n")));
    }
  });

  await harness.portal.refresh();

  assert.equal(harness.portal.getSnapshot().itemCount, 2);
  assert.ok(generalUrls.every((url) => requestedUrls.some((requested) => requested.includes(encodeURIComponent(url)))));
  assert.ok(basicUrls.every((url) => requestedUrls.every((requested) => !requested.includes(encodeURIComponent(url)))));
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
  await testSanspoFiltersMemberPagesBeforeHydrationLimit();
  await testSourceDetailsKeepFailuresVisible();
  console.log("japanese-refresh: 5 tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
