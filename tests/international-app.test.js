"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const portalCore = require("../shared/portal-core.js");
const sourceParsers = require("../international/source-parsers.js");

const CONFIG_SOURCE = fs.readFileSync(require.resolve("../international/config.js"), "utf8");

async function run() {
  const harness = loadAppHarness();

  await testResponseBodyTimeout(harness);
  await testRateLimiterResponseCompatibility(harness);
  await testDirectRequestCachePolicy(harness);
  testFinalArticleUrlGate(harness);

  console.log("international-app: 4 tests passed");
}

// fetchのヘッダー受信後に本文が停止しても、同じAbortタイマーで打ち切れることを確認する。
async function testResponseBodyTimeout({ context, api }) {
  context.fetch = async (_url, options) => ({
    ok: true,
    status: 200,
    headers: createHeaders(),
    text() {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
  });

  let guardTimer;
  try {
    await assert.rejects(
      Promise.race([
        api.fetchProxyText("https://example.test/feed", {}, 15),
        new Promise((_resolve, reject) => {
          guardTimer = setTimeout(() => reject(new Error("本文停止時のAbortが作動しませんでした")), 200);
        })
      ]),
      /タイムアウト|timeout/i
    );
  } finally {
    clearTimeout(guardTimer);
  }
}

// Readerの429応答は本文を読まずResponse互換値としてrate limiterへ渡し、再試行後の本文だけを返す。
async function testRateLimiterResponseCompatibility({ context, api, limiterState }) {
  let requestCount = 0;
  let errorBodyRead = false;
  context.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return {
        ok: false,
        status: 429,
        headers: createHeaders({ "Retry-After": "1" }),
        async text() {
          errorBodyRead = true;
          return "rate limited";
        }
      };
    }
    return {
      ok: true,
      status: 200,
      headers: createHeaders(),
      async text() {
        return "reader body";
      }
    };
  };

  const body = await api.fetchProxyText("https://r.jina.ai/https://example.test/news", {}, 100);
  assert.equal(body, "reader body");
  assert.equal(requestCount, 2);
  assert.equal(errorBodyRead, false);
  assert.equal(limiterState.firstResponse.status, 429);
  assert.equal(limiterState.firstResponse.headers.get("Retry-After"), "1");
}

// no-storeは媒体設定を持つ公式URLの直接取得だけへ渡し、公開プロキシには伝播させない。
async function testDirectRequestCachePolicy({ context, api }) {
  const baseSite = context.window.InternationalHorseRacingPortalDefinition.CONFIG.SITES
    .find((site) => site.id === "tdn_america");
  assert.equal(baseSite.requestCache, "no-store");
  const body = JSON.stringify([{
    title: { rendered: "Current Thoroughbred Racing Headline" },
    link: "https://www.thoroughbreddailynews.com/current-thoroughbred-racing-headline/",
    date_gmt: new Date(Date.now() - 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "")
  }]);

  const directCalls = [];
  context.fetch = async (url, options) => {
    directCalls.push({ url, options });
    return createTextResponse(body);
  };
  const directItems = await api.fetchSite({ ...baseSite, tryDirect: true });
  assert.equal(directItems.length, 1);
  assert.equal(directCalls.length, 1);
  assert.equal(directCalls[0].url, baseSite.apiUrl);
  assert.equal(directCalls[0].options.cache, "no-store");

  const proxyCalls = [];
  context.fetch = async (url, options) => {
    proxyCalls.push({ url, options });
    return createTextResponse(body);
  };
  const proxyItems = await api.fetchSite({ ...baseSite, tryDirect: false });
  assert.equal(proxyItems.length, 1);
  assert.equal(proxyCalls.length, 1);
  assert.match(proxyCalls[0].url, /^https:\/\/proxy\.test\//);
  assert.equal(Object.prototype.hasOwnProperty.call(proxyCalls[0].options, "cache"), false);
}

// 抽出器が候補を返しても、外部ホスト・固定ページ・HTTP(S)以外は最終正規化で除外する。
function testFinalArticleUrlGate({ api, context }) {
  const site = {
    id: "example_news",
    name: "Example News",
    region: "europe",
    url: "https://news.example.test/news/",
    baseUrl: "https://news.example.test",
    pathHints: ["/news/"],
    includeAnySameHost: true
  };
  const raw = {
    title: "A Proper Horse Racing Headline",
    publishedAt: new Date()
  };

  assert.ok(api.normalizeItem({ ...raw, url: "https://news.example.test/news/proper-story" }, site, 0));
  assert.equal(api.normalizeItem({ ...raw, url: "https://outside.example/news/proper-story" }, site, 0), null);
  assert.equal(api.normalizeItem({ ...raw, url: "ftp://news.example.test/news/proper-story" }, site, 0), null);
  assert.equal(api.normalizeItem({ ...raw, url: "javascript://news.example.test/news/proper-story" }, site, 0), null);
  assert.equal(api.normalizeItem({ ...raw, url: "https://news.example.test/privacy/terms" }, site, 0), null);
  // TTRのedition配下は日別の記事であり、他媒体のエディション索引と混同しない。
  const ttrSite = context.window.InternationalHorseRacingPortalDefinition.CONFIG.SITES.find((entry) => entry.id === "ttrausnz");
  assert.ok(api.normalizeItem({ ...raw, url: "https://www.ttrausnz.com.au/edition/2026-09-05/saturday-preview" }, ttrSite, 0));
  assert.equal(api.normalizeItem({ ...raw, url: "https://www.ttrausnz.com.au/edition/2026-09-05/job-board" }, ttrSite, 0), null);
  assert.equal(api.normalizeItem({ ...raw, url: "https://www.ttrausnz.com.au/edition/2026-09-05" }, ttrSite, 0), null);
}

// 本体IIFEへテスト時だけ関数参照を差し込み、製品コードへtest-only公開APIを追加せず検証する。
function loadAppHarness() {
  const source = fs.readFileSync(require.resolve("../international/app.js"), "utf8");
  const iifeEnd = source.lastIndexOf("})();");
  assert.notEqual(iifeEnd, -1, "international/app.jsのIIFE終端を検出できません");

  const instrumentedSource = `${source.slice(0, iifeEnd)}
    window.__InternationalAppTestApi = {
      fetchProxyText,
      fetchSite,
      isCandidateArticleUrl,
      normalizeItem
    };
  ${source.slice(iifeEnd)}`;
  const limiterState = { firstResponse: null };
  const context = createContext(limiterState);
  vm.runInContext(instrumentedSource, context, { filename: "international/app.js" });

  return {
    api: context.window.__InternationalAppTestApi,
    context,
    limiterState
  };
}

function createContext(limiterState) {
  const dummyElement = createElementStub();
  const coreForHarness = {
    ...portalCore,
    createRequestRateLimiter() {
      return {
        async run(request) {
          const firstResponse = await request(0);
          limiterState.firstResponse = firstResponse;
          return firstResponse && firstResponse.status === 429 ? request(1) : firstResponse;
        }
      };
    }
  };
  const window = {
    addEventListener() {},
    clearTimeout,
    setTimeout
  };
  const document = {
    body: { classList: { toggle() {} } },
    createElement(tagName) {
      if (tagName === "template") return createTemplateStub();
      if (tagName === "textarea") return createTextDecoderStub();
      return createElementStub();
    },
    querySelector() {
      return dummyElement;
    }
  };

  const context = vm.createContext({
    AbortController,
    Date,
    DOMParser: FakeDOMParser,
    Intl,
    URL,
    clearTimeout,
    console,
    document,
    encodeURIComponent,
    fetch: async () => { throw new Error("fetch stub is not configured"); },
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout,
    window
  });
  vm.runInContext(CONFIG_SOURCE, context, { filename: "international/config.js" });
  const config = window.InternationalHorseRacingPortalDefinition.CONFIG;
  config.REQUEST_TIMEOUT_MS = 100;
  config.TEXT_PROXY_MIN_INTERVAL_MS = 0;
  config.TEXT_PROXY_DEFAULT_RETRY_AFTER_MS = 1;
  config.CORS_PROXY = (url) => `https://proxy.test/?url=${encodeURIComponent(url)}`;
  config.CORS_PROXY_FALLBACKS = [];
  config.TEXT_PROXY = (url) => `https://r.jina.ai/${url}`;
  window.HorseRacingPortalCore = coreForHarness;
  window.InternationalHorseRacingSourceParsers = sourceParsers;
  return context;
}

function createElementStub() {
  return {
    addEventListener() {},
    appendChild() {},
    classList: { add() {}, contains() { return false; }, remove() {}, toggle() {} },
    dataset: {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    replaceChildren() {},
    setAttribute() {},
    style: {},
    checked: false,
    disabled: false,
    hidden: false,
    innerHTML: "",
    textContent: "",
    value: ""
  };
}

function createTemplateStub() {
  let html = "";
  return {
    set innerHTML(value) {
      html = String(value || "");
    },
    content: {
      querySelectorAll() {
        return [];
      },
      get textContent() {
        return html.replace(/<[^>]*>/g, "");
      }
    }
  };
}

function createTextDecoderStub() {
  return {
    value: "",
    set innerHTML(value) {
      this.value = String(value || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#(?:39|x27);/gi, "'");
    }
  };
}

class FakeDOMParser {
  parseFromString() {
    return {
      getElementsByTagNameNS() { return []; },
      querySelector() { return null; },
      querySelectorAll() { return []; }
    };
  }
}

function createHeaders(values = {}) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    get(name) {
      return normalized[String(name || "").toLowerCase()] || null;
    }
  };
}

function createTextResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: createHeaders(),
    async text() {
      return body;
    }
  };
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
