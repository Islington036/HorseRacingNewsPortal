import { parseAtom, parseBloodHorseReaderCards, parseDrfReaderCards, parseFeed, parseIrishFieldTopic, parseIrishRacingReaderCards, parseNewsSitemap, parseRacingComGraphql, parseRss2Json, parseSportingLifeApi, parseTospoReaderCards, parseTtrAusNzNextData, parseWordPressPosts } from "./core.js";

// Racing.comの公開フロントエンド設定をテスト側へ複製せず、本体と同じURL・公開ヘッダーを参照する。
const internationalConfig = window.InternationalHorseRacingPortalDefinition &&
  window.InternationalHorseRacingPortalDefinition.CONFIG;
const racingComSite = internationalConfig && internationalConfig.SITES.find((site) => site.id === "racing_com");
const thoroughbredRacingRss = "https://www.thoroughbredracing.com/rss.xml";
const thoroughbredRacingRssApi = "https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(thoroughbredRacingRss);

// 各featureブランチで、実装対象の媒体だけをここへ追加する。
// テストランナーは選択された1設定だけをrunSourceTestへ渡すため、全媒体の一括更新は発生しない。
export const SOURCES = [
  {
    id: "sportinglife_official_api",
    name: "Sporting Life Official Racing API",
    url: "https://www.sportinglife.com/api/content/articles/summary?limit=13&offset=0&basketPath=sl%2Fracing",
    baseUrl: "https://www.sportinglife.com",
    parse: parseSportingLifeApi,
    tryDirect: true,
    requiredRoute: "direct",
    pathPrefixes: ["/racing/news/"],
    requireDescendingDates: true,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 1
  },
  {
    id: "trc_sales_previews_full_rss",
    name: "Thoroughbred Racing / Sales Previews Full RSS",
    url: thoroughbredRacingRss,
    baseUrl: "https://www.thoroughbredracing.com",
    parse: parseFeed,
    rssCategory: "Sales Previews",
    forceHttps: true,
    tryDirect: true,
    requireDate: true,
    minimumItems: 1,
    // 公式RSSには写真がないため、本体のダミー画像へ渡せることを正常条件にする。
    minimumImageCoverage: 0
  },
  {
    id: "ttrausnz_next_data",
    name: "TTR AusNZ Next.js Data",
    url: "https://www.ttrausnz.com.au/",
    baseUrl: "https://www.ttrausnz.com.au",
    parse: parseTtrAusNzNextData,
    // 公式ページはCORSを許可しないため、HTML構造を維持する公開プロキシ経路を検証する。
    allowTextProxy: false,
    forbiddenUrlPatterns: [
      /\/(?:job-board|wednesday-trivia|20\d{2}-stallion-parades|daily-news-wrap|debutants|first-season-sire-runners-and-results|thanks-for-reading)\/?$/i,
      /\/looking-ahead(?:-|\/|$)/i
    ],
    requireDescendingDates: true,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 1
  },
  {
    id: "sanspo_keiba_sitemap_reader",
    name: "サンスポ競馬 Sitemap + Reader",
    url: "https://www.sanspo.com/feeds/sitemap-race-keiba/?outputType=xml&from=0",
    baseUrl: "https://www.sanspo.com",
    allowedOrigins: ["https://www.sanspo.com"],
    pathPrefixes: ["/race/article/"],
    articlePathPattern: /^\/race\/article\/(?:general|basic)\/20\d{6}-[A-Z0-9]+\/?$/i,
    parse: parseNewsSitemap,
    tryDirect: true,
    allowTextProxy: true,
    hydrateFromReader: true,
    hydrationLimit: 8,
    hydrationConcurrency: 2,
    hydrationTimeoutMs: 20000,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 1
  },
  {
    id: "bloodhorse_reader",
    name: "BloodHorse Reader Listing",
    url: "https://www.bloodhorse.com/horse-racing/articles/index",
    baseUrl: "https://www.bloodhorse.com",
    parse: parseBloodHorseReaderCards,
    allowTextProxy: true,
    preferTextProxy: true,
    requiredRoute: "text-proxy",
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 1
  },
  {
    id: "trc_racing_rss_api",
    name: "Thoroughbred Racing / Racing RSS API",
    url: thoroughbredRacingRssApi,
    baseUrl: "https://www.thoroughbredracing.com",
    parse: parseRss2Json,
    rssCategory: "Racing",
    tryDirect: true,
    requiredRoute: "direct",
    requireDate: true,
    minimumItems: 1,
    // 公式RSSが写真を配信しないため、画像なしを正常データとして本体のダミー画像へ渡す。
    minimumImageCoverage: 0
  },
  {
    id: "trc_breeding_rss_api",
    name: "Thoroughbred Racing / Breeding RSS API",
    url: thoroughbredRacingRssApi,
    baseUrl: "https://www.thoroughbredracing.com",
    parse: parseRss2Json,
    rssCategory: "Breeding",
    tryDirect: true,
    requiredRoute: "direct",
    requireDate: true,
    // RSS先頭10件に当該カテゴリの更新がない場合も、APIレスポンス自体を正常として検証する。
    minimumItems: 0,
    minimumImageCoverage: 0
  },
  {
    id: "trc_sales_previews_rss_api",
    name: "Thoroughbred Racing / Sales Previews RSS API",
    url: thoroughbredRacingRssApi,
    baseUrl: "https://www.thoroughbredracing.com",
    parse: parseRss2Json,
    rssCategory: "Sales Previews",
    tryDirect: true,
    requiredRoute: "direct",
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 0
  },
  {
    id: "drf_news_sitemap",
    name: "Daily Racing Form News Sitemap",
    url: "https://www.drf.com/sitemap-news.xml",
    baseUrl: "https://www.drf.com",
    allowedOrigins: ["https://www.drf.com"],
    pathPrefixes: ["/news/"],
    parse: parseNewsSitemap,
    tryDirect: true,
    requiredRoute: "direct",
    readerDecorationUrls: [
      "https://www.drf.com/news/all-news",
      "https://www.drf.com/news/all-news?page=2"
    ],
    parseReaderDecoration: parseDrfReaderCards,
    decorationImagePattern: /a-us\.storyblok\.com/i,
    decorationImageOrigins: ["https://a-us.storyblok.com"],
    hydrationTimeoutMs: 20000,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 0.25
  },
  {
    id: "irishracing_news_sitemap",
    name: "Irish Racing News Sitemap",
    url: "https://www.irishracing.com/newssitemap.xml",
    baseUrl: "https://www.irishracing.com",
    allowedOrigins: ["https://www.irishracing.com"],
    caseInsensitivePath: true,
    matchByTrailingNumericId: true,
    pathPrefixes: ["/news/"],
    parse: parseNewsSitemap,
    readerDecorationUrls: ["https://www.irishracing.com/news"],
    parseReaderDecoration: parseIrishRacingReaderCards,
    decorationImagePattern: /\/photo_jpeg\//i,
    decorationImageOrigins: ["https://www.irishracing.com"],
    hydrationTimeoutMs: 20000,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 1
  },
  {
    id: "attheraces_news_sitemap",
    name: "At The Races News Sitemap",
    url: "https://www.attheraces.com/news-sitemap.xml",
    baseUrl: "https://www.attheraces.com",
    allowedOrigins: ["https://www.attheraces.com"],
    pathPrefixes: ["/news/"],
    parse: parseNewsSitemap,
    tryDirect: true,
    requiredRoute: "direct",
    readerDecorationUrls: ["https://www.attheraces.com/news"],
    hydrationTimeoutMs: 20000,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 1
  },
  {
    id: "tospo_news_sitemap",
    name: "東スポ競馬 News Sitemap",
    url: "https://tospo-keiba.jp/sitemap_news_1.xml",
    baseUrl: "https://tospo-keiba.jp",
    allowedOrigins: ["https://tospo-keiba.jp"],
    pathPrefixes: ["/breaking_news/"],
    parse: parseNewsSitemap,
    allowTextProxy: true,
    preferTextProxy: true,
    readerDecorationUrls: [
      "https://tospo-keiba.jp/news",
      "https://tospo-keiba.jp/news?page=2"
    ],
    parseReaderDecoration: parseTospoReaderCards,
    decorationImagePattern: /\/images\/article\/thumbnail\//i,
    decorationImageOrigins: ["https://tospo-keiba.jp"],
    readerCacheBust: true,
    hydrateFromReader: true,
    disableReaderImageFallback: true,
    // 東スポのサイトマップは通常20件弱なので、既定8件で打ち切らず2ページ目の記事まで結合を検証する。
    maxItems: 20,
    hydrationLimit: 20,
    hydrationConcurrency: 2,
    hydrationTimeoutMs: 20000,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 1
  },
  ...(racingComSite ? [{
    id: "racing_com_graphql",
    name: "Racing.com GraphQL",
    url: racingComSite.apiUrl,
    baseUrl: racingComSite.baseUrl,
    headers: racingComSite.requestHeaders,
    parse: parseRacingComGraphql,
    tryDirect: true,
    requiredRoute: "direct",
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 1
  }] : []),
  {
    id: "irishfield_topic_api",
    name: "The Irish Field Topic API",
    url: "https://api2.theirishfield.ie/v1/channel/topic.php?id=82&level=1&limit=18&offset=0",
    baseUrl: "https://www.theirishfield.ie",
    parse: parseIrishFieldTopic,
    allowTextProxy: true,
    preferTextProxy: true,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 1
  },
  {
    id: "racingpost_news_sitemap",
    name: "Racing Post News Sitemap",
    url: "https://www.racingpost.com/sitemaps/news-sitemap.xml",
    baseUrl: "https://www.racingpost.com",
    pathPrefixes: ["/news/"],
    excludePathHints: ["/news/betting-offers/"],
    parse: parseNewsSitemap,
    allowTextProxy: true,
    preferTextProxy: true,
    hydrateFromReader: true,
    hydrationLimit: 8,
    hydrationConcurrency: 2,
    hydrationTimeoutMs: 20000,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 0.75
  },
  {
    id: "racingpost_bloodstock_sitemap",
    name: "Racing Post Bloodstock Sitemap",
    url: "https://www.racingpost.com/sitemaps/news-sitemap.xml",
    baseUrl: "https://www.racingpost.com",
    pathPrefixes: ["/bloodstock/"],
    parse: parseNewsSitemap,
    allowTextProxy: true,
    preferTextProxy: true,
    hydrateFromReader: true,
    hydrationLimit: 8,
    hydrationConcurrency: 2,
    hydrationTimeoutMs: 20000,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 0.75
  },
  {
    id: "nikkan_atom",
    name: "日刊スポーツ Atom",
    url: "https://www.nikkansports.com/keiba/atom.xml",
    baseUrl: "https://www.nikkansports.com",
    parse: parseAtom,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 0.75
  },
  {
    id: "dailymail_rss",
    name: "Daily Mail Racing RSS",
    url: "https://www.dailymail.com/sport/racing/index.rss",
    baseUrl: "https://www.dailymail.com",
    parse: parseFeed,
    tryDirect: true,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 0.75
  },
  {
    id: "tdn_europe_wordpress",
    name: "TDN Europe WordPress REST",
    url: "https://www.thoroughbreddailynews.com/wp-json/wp/v2/posts?categories=7479&per_page=20&_embed=1",
    baseUrl: "https://www.thoroughbreddailynews.com",
    parse: parseWordPressPosts,
    // TDNのREST APIはCORSを許可しているため、公開プロキシより先にブラウザから直接取得する。
    tryDirect: true,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 0.75
  },
  {
    id: "tdn_america_wordpress",
    name: "TDN America WordPress REST",
    url: "https://www.thoroughbreddailynews.com/wp-json/wp/v2/posts?categories=1&per_page=20&_embed=1",
    baseUrl: "https://www.thoroughbreddailynews.com",
    parse: parseWordPressPosts,
    // Europe版と同じく、ローカルHTMLのOriginを返す公式CORS経路を第一候補にする。
    tryDirect: true,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 0.75
  },
  {
    id: "tdn_europe_rss_fallback",
    name: "TDN Europe RSS（予備経路）",
    url: "https://www.thoroughbreddailynews.com/category/news-europe/feed/",
    baseUrl: "https://www.thoroughbreddailynews.com",
    parse: parseFeed,
    // 本体と同じく直接取得を先に試し、RSSがCORSを許可しない場合は公開プロキシへ進む。
    tryDirect: true,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 0.75
  },
  {
    id: "tdn_america_rss_fallback",
    name: "TDN America RSS（予備経路）",
    url: "https://www.thoroughbreddailynews.com/category/news/feed/",
    baseUrl: "https://www.thoroughbreddailynews.com",
    parse: parseFeed,
    // Europe版と同じ条件でRSSの見出し・リンク・日時・画像が保たれているかを確認する。
    tryDirect: true,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 0.75
  },
  {
    id: "anzbloodstock_wordpress",
    name: "ANZ Bloodstock WordPress REST",
    url: "https://www.anzbloodstocknews.com/wp-json/wp/v2/posts?categories=67&per_page=20&_embed=1",
    baseUrl: "https://www.anzbloodstocknews.com",
    parse: parseWordPressPosts,
    // ANZのREST APIもOrigin反射型CORSに対応しており、直接取得ならプロキシ混雑の影響を受けない。
    tryDirect: true,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 0.75
  },
  {
    id: "anzbloodstock_rss_fallback",
    name: "ANZ Bloodstock RSS（予備経路）",
    url: "https://www.anzbloodstocknews.com/category/latest-news/feed/",
    baseUrl: "https://www.anzbloodstocknews.com",
    parse: parseFeed,
    // RESTが直接取得・公開プロキシとも失敗した場合に備え、構造化されたRSSだけを予備経路にする。
    tryDirect: true,
    requireDate: true,
    minimumItems: 1,
    // ANZのRSSは記事画像を配信しないため、画像URLがない全件を本体のダミー表示へ回せれば合格とする。
    minimumImageCoverage: 0
  },
  {
    id: "the_straight_wordpress",
    name: "The Straight WordPress REST",
    url: "https://thestraight.com.au/wp-json/wp/v2/posts?per_page=20&_embed=1",
    baseUrl: "https://thestraight.com.au",
    parse: parseWordPressPosts,
    tryDirect: true,
    requireDate: true,
    minimumItems: 1,
    // 現在の先頭記事にはfeatured_media未設定が含まれるため、存在する画像が全て読める50%を基準にする。
    minimumImageCoverage: 0.5
  },
  {
    id: "scmp_racing_rss",
    name: "SCMP Racing RSS",
    url: "https://www.scmp.com/rss/39/feed/",
    baseUrl: "https://www.scmp.com",
    parse: parseFeed,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 0.75
  }
];
