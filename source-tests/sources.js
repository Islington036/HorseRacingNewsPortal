import { parseAtom, parseFeed, parseNewsSitemap, parseWordPressPosts } from "./core.js";

// 各featureブランチで、実装対象の媒体だけをここへ追加する。
// テストランナーは選択された1設定だけをrunSourceTestへ渡すため、全媒体の一括更新は発生しない。
export const SOURCES = [
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
