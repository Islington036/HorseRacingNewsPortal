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
  await testReaderUpstreamDiagnostics();
  await testTtrTitleSymbolMatching();
  await testDirectRequestCachePolicy(harness);
  await testWordPressMetadataAuthority();
  await testRacingTvDetailDates(harness);
  testFinalArticleUrlGate(harness);
  await testSourceMetadataCacheMigration(harness);
  await testDailyMailMotorSportExclusion(harness);

  console.log("international-app: 10 tests passed");
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

// Readerの200/元509を本体と専用テスターが同じ原因で失敗させ、APIと本文中のWarningは変えない。
async function testReaderUpstreamDiagnostics() {
  const { api, context } = loadAppHarness();
  const site = context.window.InternationalHorseRacingPortalDefinition.CONFIG.SITES.find((entry) => entry.id === "ttrausnz");
  const readerUrl = `https://r.jina.ai/${site.url}`;
  const quotaBody = [
    "Title: Quota Exceeded",
    "",
    `URL Source: ${site.url}`,
    "",
    "Warning: Target URL returned error 509: Bandwidth Limit Exceeded",
    "",
    "Markdown Content:",
    "## Bandwidth Quota Exceeded"
  ].join("\n");
  context.fetch = async () => createTextResponse(quotaBody);
  await assert.rejects(api.fetchSite(site), /元サイトの帯域制限.*HTTP 509/);
  assert.equal(await api.fetchProxyText("https://api.example.test/news", {}, 100), quotaBody);

  // 同じテスターコードを既存VMへ読み込み、媒体パーサーへ渡す前に上流失敗を捕捉する。
  context.window.JapaneseHorseRacingSourceParsers = {};
  vm.runInContext(fs.readFileSync(require.resolve("../source-tests/core.js"), "utf8").replace(/^export /gm, ""), context);
  await assert.rejects(context.runSourceTest({
    ...site,
    id: "ttrausnz_reader",
    parse: context.parseTtrAusNzReader,
    allowTextProxy: true,
    timeoutMs: 100
  }), /元サイトの帯域制限.*HTTP 509/);

  const normalBody = quotaBody.replace("\nWarning: Target URL returned error 509: Bandwidth Limit Exceeded\n", "\n") +
    "\nWarning: Target URL returned error 509: Bandwidth Limit Exceeded";
  context.fetch = async () => createTextResponse(normalBody);
  assert.equal(await api.fetchProxyText(readerUrl, {}, 100), normalBody);
}

// TTR実見出しの通貨・百分率・小数を比較時だけ正規化し、要約混入と汎用slug変更を防ぐ。
async function testTtrTitleSymbolMatching() {
  const { api, context } = loadAppHarness();
  const site = context.window.InternationalHorseRacingPortalDefinition.CONFIG.SITES.find((entry) => entry.id === "ttrausnz");
  const title = "Inglis Digital: Ninja valued at $5.5 million after 1% share sells";
  const slug = "inglis-digital-ninja-valued-at-dollar55-million-after-1percent-share-sells";
  const articleUrl = `${site.baseUrl}/edition/2026-10-09/${slug}`;
  const listing = [
    `##### [${title} The share sale attracted bidders October 9, 2026](${articleUrl})`,
    `##### [Friday racing preview A useful summary October 9, 2026](${site.baseUrl}/edition/2026-10-09/friday-racing-preview)`,
    `##### [Job board Latest roles October 9, 2026](${site.baseUrl}/edition/2026-10-09/job-board)`
  ].join("");
  context.fetch = async () => createTextResponse(listing);
  const items = await api.fetchSite(site);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, title);
  assert.equal(items[0].url, articleUrl);
  assert.equal(items[0].publishedAt.getTime(), new Date(2026, 9, 9).getTime());
  assert.equal(items[1].title, "Friday racing preview");

  const extractTitle = sourceParsers.extractTtrTitleMatchingSlug;
  assert.equal(extractTitle(`${title} A longer summary follows`, slug), title);
  assert.equal(extractTitle("Trainer’s wins & sales Summary follows", "trainers-wins-and-sales"), "Trainer’s wins & sales");
  assert.equal(extractTitle("A different headline with Ninja in its summary", slug), "");
  assert.equal(extractTitle(`Breaking news ${title}`, slug), "");

  context.window.JapaneseHorseRacingSourceParsers = {};
  vm.runInContext(fs.readFileSync(require.resolve("../source-tests/core.js"), "utf8").replace(/^export /gm, ""), context);
  const testItems = context.parseTtrAusNzReader(listing);
  assert.equal(testItems.length, 2);
  assert.equal(testItems[0].title, title);
  assert.equal(testItems[0].url, articleUrl);
  assert.equal(testItems[0].publishedAt, "2026-10-09T00:00:00");
  assert.equal(testItems[0].thumbnail, "");
  const mismatch = `##### [Breaking news ${title}](${articleUrl})`;
  assert.equal(api.extractTtrAusNzMarkdownItems(mismatch, site).length, 0);
  assert.throws(() => context.parseTtrAusNzReader(mismatch), /見出しをURLと照合できませんでした/);

  const sportingLifeItems = context.parseSportingLifeApi(JSON.stringify([{
    article_id: 123,
    title,
    published_date: "2026-10-09T00:00:00Z"
  }]));
  assert.equal(sportingLifeItems[0].url, "/racing/news/inglis-digital-ninja-valued-at-5-5-million-after-1-share-sells/123");
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

// WordPressの専用結果を汎用JSONで置換せず、実際のTDN投稿形状で題名・GMT・代表写真とRSS予備経路を保つ。
async function testWordPressMetadataAuthority() {
  const { api, context } = loadAppHarness();
  const config = context.window.InternationalHorseRacingPortalDefinition.CONFIG;
  const expectedTitle = "Grade I Winner Dotsy’s Trainer John Grabowski Joins TDN Writers’ Room";
  const post = {
    id: 538845,
    title: { rendered: "Grade I Winner Dotsy&#8217;s Trainer John Grabowski Joins TDN Writers&#8217; Room" },
    link: "https://www.thoroughbreddailynews.com/grade-i-winner-dotsys-trainer-john-grabowski-joins-tdn-writers-room/",
    date: "2026-10-07T13:16:28",
    date_gmt: "2026-10-07T17:16:28",
    image: "https://www.thoroughbreddailynews.com/wp-content/uploads/2026/10/tdn-writers-room.jpg",
    _embedded: { "wp:featuredmedia": [{}] },
    related: { title: "Embedded unrelated article", link: "https://www.thoroughbreddailynews.com/embedded-unrelated-article/", date: "2026-10-07T13:16:28", image: "https://www.thoroughbreddailynews.com/related.jpg" }
  };
  let body;
  context.fetch = async () => createTextResponse(body);
  for (const id of ["tdn_america", "tdn_europe", "anzbloodstock"]) {
    const site = config.SITES.find((entry) => entry.id === id);
    const sitePost = {
      ...post,
      link: post.link.replace("https://www.thoroughbreddailynews.com", site.baseUrl),
      related: { ...post.related, link: post.related.link.replace("https://www.thoroughbreddailynews.com", site.baseUrl) }
    };
    body = JSON.stringify([sitePost]);
    const items = await api.fetchSite(site);
    assert.equal(items[0].title, expectedTitle);
    assert.equal(items.length, 1);
    assert.equal(items[0].publishedAt.toISOString(), "2026-10-07T17:16:28.000Z");
    assert.equal(items[0].thumbnail, post.image);
    assert.equal(site.exclusiveStructuredJson, true);
    assert.equal(site.cacheVersion, 1);
  }

  context.window.JapaneseHorseRacingSourceParsers = {};
  vm.runInContext(fs.readFileSync(require.resolve("../source-tests/core.js"), "utf8").replace(/^export /gm, ""), context);
  const site = config.SITES.find((entry) => entry.id === "tdn_america");
  const testItems = context.parseWordPressPosts(JSON.stringify([post]), site);
  assert.equal(testItems[0].title, expectedTitle);
  assert.equal(testItems[0].publishedAt, "2026-10-07T17:16:28Z");
  assert.equal(testItems[0].thumbnail, post.image);

  // JSON専用設定は正常APIだけに適用し、API失敗時の既存RSS抽出は残す。
  context.DOMParser = class extends FakeDOMParser {
    parseFromString(text, type) {
      const doc = super.parseFromString(text, type);
      if (type === "application/xml") {
        doc.querySelectorAll = (selector) => selector === "item, entry" ? [{
          querySelector(name) {
            const value = { title: expectedTitle, link: post.link, pubDate: "Wed, 07 Oct 2026 17:16:28 GMT" }[name];
            return value ? { textContent: value, getAttribute() { return ""; } } : null;
          },
          querySelectorAll() { return []; }
        }] : [];
      }
      return doc;
    }
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(url);
    if (url.includes("wp-json")) throw new Error("API unavailable");
    return createTextResponse("<rss><channel><item>fixture</item></channel></rss>");
  };
  const rssItems = await api.fetchSite(site);
  assert.ok(fetched.includes(site.feedUrl));
  assert.equal(rssItems.length, 1);
  assert.equal(rssItems[0].title, expectedTitle);
  assert.equal(rssItems[0].publishedAt.toISOString(), "2026-10-07T17:16:28.000Z");
}

// キャッシュされた一覧の相対日時を信じず、先頭を含め記事詳細の正式な公開時刻だけを使う。
async function testRacingTvDetailDates({ context, api }) {
  const site = context.window.InternationalHorseRacingPortalDefinition.CONFIG.SITES
    .find((entry) => entry.id === "racingtv");
  assert.equal(site.readerDetailHydration, true);
  assert.equal(site.detailHydrationLimit, site.maxItems);

  const listing = [
    "[![Image](https://images.example/first.webp) First proper racing headline 1 hour ago Read More](https://www.racingtv.com/news/first-proper-racing-headline)",
    "[![Image](https://images.example/second.webp) Second proper racing headline](https://www.racingtv.com/news/second-proper-racing-headline)",
    "[![Image](https://images.example/third.webp) Third proper racing headline](https://www.racingtv.com/news/third-proper-racing-headline)",
    "## [Alternate proper racing headline](https://www.racingtv.com/news/alternate-proper-racing-headline)",
    "September 24, 2026",
    "![Image](https://images.example/alternate.webp)"
  ].join("\n");
  const firstDetailDate = "2026-09-24T17:10:00+01:00";
  const secondDetailDate = "2026-09-24T16:33:55+01:00";
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(url);
    if (url.endsWith("/news/latest")) return createTextResponse(listing);
    if (url.endsWith("/news/first-proper-racing-headline")) {
      return createTextResponse(`Title: First proper racing headline\nPublished Time: ${firstDetailDate}\n`);
    }
    if (url.endsWith("/news/second-proper-racing-headline")) {
      return createTextResponse(`Title: Second proper racing headline\nPublished Time: ${secondDetailDate}\n`);
    }
    if (url.endsWith("/news/third-proper-racing-headline")) {
      return createTextResponse("Title: Third proper racing headline\n");
    }
    if (url.endsWith("/news/alternate-proper-racing-headline")) {
      // 汎用Markdownが日付を拾っても、詳細に正式日時がなければ掲載しない。
      return createTextResponse("Title: Alternate proper racing headline\n");
    }
    throw new Error(`予期しないReader要求: ${url}`);
  };

  const items = await api.fetchSite(site);
  assert.equal(items.length, 2);
  const first = items.find((item) => item.url.endsWith("/news/first-proper-racing-headline"));
  const second = items.find((item) => item.url.endsWith("/news/second-proper-racing-headline"));
  assert.equal(first.publishedAt.toISOString(), "2026-09-24T16:10:00.000Z");
  assert.equal(second.publishedAt.toISOString(), "2026-09-24T15:33:55.000Z");
  assert.equal(first.thumbnail, "https://images.example/first.webp");
  assert.equal(second.thumbnail, "https://images.example/second.webp");
  assert.equal(first.dateEstimated, false);
  assert.equal(second.dateEstimated, false);
  assert.equal(fetched.length, 5, "相対日時付き先頭と汎用Markdown候補も記事詳細を取得する");
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

// 記事分類・日時を修正した媒体だけ旧キャッシュを除き、他媒体と新形式キャッシュを保持する。
async function testSourceMetadataCacheMigration({ api, context }) {
  const config = context.window.InternationalHorseRacingPortalDefinition.CONFIG;
  const straight = config.SITES.find((site) => site.id === "thestraight");
  const irish = config.SITES.find((site) => site.id === "irishracing");
  assert.equal(new URL(straight.apiUrl).searchParams.get("categories_exclude"), "127");
  assert.equal(straight.feedUrl, undefined);
  assert.equal(straight.structuredSourcesOnly, true);
  assert.equal(straight.exclusiveStructuredJson, true);
  assert.equal(irish.sitemapUrl, undefined);
  assert.equal(irish.textProxyOnly, true);

  const now = new Date().toISOString();
  let stored = JSON.stringify({
    lastUpdatedAt: now,
    siteLatest: { irishracing: now, thestraight: now, tdn_america: now, tdn_europe: now, anzbloodstock: now, bloodhorse: now },
    allItems: [
      { sourceId: "irishracing", url: "https://www.irishracing.com/news/example/267200" },
      { sourceId: "thestraight", url: "https://thestraight.com.au/scenic-lodge-thoroughbred-stud/" },
      { sourceId: "tdn_america", url: "https://www.thoroughbreddailynews.com/current-racing-news/" },
      { sourceId: "tdn_europe", url: "https://www.thoroughbreddailynews.com/current-european-racing-news/" },
      { sourceId: "anzbloodstock", url: "https://www.anzbloodstocknews.com/current-bloodstock-news/" },
      { sourceId: "bloodhorse", url: "https://www.bloodhorse.com/horse-racing/articles/123456/current-racing-news" }
    ].map((item) => ({ ...item, title: "A current headline", publishedAt: now }))
  });
  context.localStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  api.loadCache();
  assert.deepEqual(Array.from(api.state.allItems, (item) => item.sourceId), ["bloodhorse"]);
  assert.deepEqual(Object.keys(api.state.siteLatest), ["bloodhorse"]);

  // フィルターを無視したAPI応答でも専用判定が除外し、汎用JSON走査から復活しない。
  context.fetch = async () => createTextResponse(JSON.stringify([
    { title: { rendered: "Scenic Lodge Thoroughbred Stud" }, link: "https://thestraight.com.au/scenic-lodge-thoroughbred-stud/", date_gmt: now.replace(/\.\d{3}Z$/, ""), categories: [127], content: { rendered: "[![Photo](https://thestraight.com.au/photo.jpg) ## Scenic Lodge Thoroughbred Stud 10 September 2026](https://thestraight.com.au/scenic-lodge-thoroughbred-stud/)" } },
    { title: { rendered: "Current racing news" }, link: "https://thestraight.com.au/current-racing-news/", date_gmt: now.replace(/\.\d{3}Z$/, ""), categories: [83] }
  ]));
  const items = await api.fetchSite(straight);
  assert.equal(items.length, 1);
  assert.match(items[0].url, /current-racing-news/);
  api.state.allItems.push(...items);
  api.saveCache();
  assert.equal(JSON.parse(stored).sourceVersions.thestraight, straight.cacheVersion);
  for (const id of ["tdn_america", "tdn_europe", "anzbloodstock"]) {
    assert.equal(JSON.parse(stored).sourceVersions[id], 1);
  }
  api.loadCache();
  assert.deepEqual(Array.from(api.state.allItems, (item) => item.sourceId).sort(), ["bloodhorse", "thestraight"]);
}

// 観測したNASCARドライバー記事だけを本体・テスター・保存済み記事から除き、競馬と正常0件を保つ。
async function testDailyMailMotorSportExclusion({ api, context }) {
  const config = context.window.InternationalHorseRacingPortalDefinition.CONFIG;
  const site = config.SITES.find((entry) => entry.id === "dailymail_racing");
  const now = new Date().toISOString();
  const motorArticle = {
    title: "Female Nascar driver pays $850k for 'affair' with woman's husband",
    url: "https://www.dailymail.com/sport/racing/article-16172365/Nascar-driver-sued-affair-jennifer-cobb-clayton-hughes.html?ns_mchannel=rss&ns_campaign=1490&ito=1490",
    publishedAt: now
  };
  const horseArticle = {
    title: "Pierre Royal produces huge shock to win bet365 Cambridgeshire Handicap as late decision by trainer pays off",
    url: "https://www.dailymail.com/sport/racing/article-16162963/Pierre-Royal-produces-huge-shock-win-bet365-Cambridgeshire-Handicap-late-decision-trainer-pays-off.html",
    publishedAt: now
  };
  const ukHorseArticle = { ...horseArticle, url: horseArticle.url.replace("dailymail.com", "dailymail.co.uk") };
  assert.equal(api.normalizeItem(motorArticle, site, 0), null);
  assert.ok(api.normalizeItem(horseArticle, site, 0));
  assert.ok(api.normalizeItem(ukHorseArticle, site, 0));
  // 競走馬名の一部、単なる競技名・比喩、他媒体にはNASCARドライバー除外を広げない。
  assert.ok(api.normalizeItem({ ...horseArticle, url: horseArticle.url.replace("Pierre-Royal", "Nascarlet") }, site, 0));
  assert.ok(api.normalizeItem({ ...horseArticle, url: horseArticle.url.replace("Pierre-Royal", "Nascar-inspired-horse") }, site, 0));
  assert.ok(api.normalizeItem({ ...motorArticle, url: motorArticle.url.replace("www.dailymail.com/sport/racing", "news.example.test/news") }, {
    id: "example_news", name: "Example News", region: "europe", baseUrl: "https://news.example.test", pathHints: ["/news/"]
  }, 0));

  let stored = JSON.stringify({
    sourceVersions: { dailymail_racing: site.cacheVersion, tdn_america: 1 },
    siteLatest: { dailymail_racing: now, tdn_america: now },
    allItems: [
      { ...motorArticle, sourceId: site.id },
      { ...horseArticle, sourceId: site.id },
      { ...horseArticle, sourceId: "tdn_america", url: "https://www.thoroughbreddailynews.com/current-racing-news/" }
    ]
  });
  context.localStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  api.loadCache();
  assert.equal(api.state.allItems.length, 2);
  assert.ok(api.state.allItems.every((item) => !item.url.includes("Nascar-driver")));
  // 旧版だけは媒体ごと更新し、誤記事由来の最新日時も残さず、他媒体のキャッシュは保持する。
  const oldCache = JSON.parse(stored);
  oldCache.sourceVersions.dailymail_racing = 0;
  stored = JSON.stringify(oldCache);
  api.loadCache();
  assert.deepEqual(Array.from(api.state.allItems, (item) => item.sourceId), ["tdn_america"]);
  assert.deepEqual(Object.keys(api.state.siteLatest), ["tdn_america"]);

  const rssBody = "<rss><channel><item>fixture</item></channel></rss>";
  let feedItems = [motorArticle, horseArticle, ukHorseArticle];
  context.DOMParser = class extends FakeDOMParser {
    parseFromString(text, type) {
      if (type !== "application/xml") return super.parseFromString(text, type);
      return {
        documentElement: { localName: (text.match(/^\s*(?:<\?xml[^>]*>\s*)?<([\w:-]+)/) || [])[1] || "" },
        getElementsByTagNameNS() { return []; },
        querySelector(selector) { return selector === "parsererror" && text === "<rss><channel></rss>" ? {} : null; },
        querySelectorAll(selector) {
          if (selector !== "item, entry") return [];
          return feedItems.map((item) => ({
            querySelector(name) {
              const value = { title: item.title, link: item.url, pubDate: item.publishedAt }[name];
              return value ? { textContent: value, getAttribute() { return ""; } } : null;
            },
            querySelectorAll() { return []; }
          }));
        }
      };
    }
  };
  context.fetch = async () => createTextResponse(rssBody);
  const mainItems = await api.fetchSite(site);
  assert.equal(mainItems.length, 2);
  assert.equal(mainItems[0].url, horseArticle.url);
  assert.equal(mainItems[1].url, ukHorseArticle.url);

  // テスターの実コードと本体設定を同じVMへ読み込み、別の除外条件を作らず検証する。
  vm.runInContext(fs.readFileSync(require.resolve("../japanese/config.js"), "utf8"), context);
  context.window.JapaneseHorseRacingSourceParsers = {};
  vm.runInContext(fs.readFileSync(require.resolve("../source-tests/core.js"), "utf8").replace(/^export /gm, ""), context);
  vm.runInContext(fs.readFileSync(require.resolve("../source-tests/sources.js"), "utf8")
    .replace(/^import .*\n/, "").replace(/^export /gm, "") +
    '\nwindow.__DailyMailTestSource = SOURCES.find((entry) => entry.id === "dailymail_rss");\nwindow.__RunSourceTest = runSourceTest;', context);
  const testSource = context.window.__DailyMailTestSource;
  assert.deepEqual(Array.from(testSource.excludePathHints), Array.from(site.excludePathHints));
  const mixedReport = await context.window.__RunSourceTest(testSource);
  assert.equal(mixedReport.passed, true);
  assert.equal(mixedReport.itemCount, 2);
  assert.equal(mixedReport.items[0].url, horseArticle.url);
  assert.equal(mixedReport.items[1].url, ukHorseArticle.url);

  feedItems = [motorArticle];
  assert.equal((await api.fetchSite(site)).length, 0);
  const emptyReport = await context.window.__RunSourceTest(testSource);
  assert.equal(emptyReport.passed, true);
  assert.equal(emptyReport.itemCount, 0);
  for (const invalidBody of ["<html><body>Service unavailable</body></html>", "<rss><channel></rss>", '<?xml version="1.0"?><error>unavailable</error>']) {
    context.fetch = async () => createTextResponse(invalidBody);
    await assert.rejects(api.fetchSite(site));
    await assert.rejects(context.window.__RunSourceTest(testSource));
  }
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
      extractTtrAusNzMarkdownItems,
      isCandidateArticleUrl,
      normalizeItem,
      loadCache,
      saveCache,
      state
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
        return html.replace(/<[^>]*>/g, "").replace(/&#8217;/g, "’");
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
        .replace(/&#8217;/g, "’")
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
