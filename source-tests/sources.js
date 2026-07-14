import { parseFeed, parseWordPressPosts } from "./core.js";

// 各featureブランチで、実装対象の媒体だけをここへ追加する。
// テストランナーは選択された1設定だけをrunSourceTestへ渡すため、全媒体の一括更新は発生しない。
export const SOURCES = [
  {
    id: "nikkan_atom",
    name: "日刊スポーツ Atom",
    url: "https://www.nikkansports.com/keiba/atom.xml",
    baseUrl: "https://www.nikkansports.com",
    parse: parseFeed,
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
    id: "tdn_europe_rss",
    name: "TDN Europe RSS",
    url: "https://www.thoroughbreddailynews.com/category/news-europe/feed/",
    baseUrl: "https://www.thoroughbreddailynews.com",
    parse: parseFeed,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 0.75
  },
  {
    id: "tdn_america_rss",
    name: "TDN America RSS",
    url: "https://www.thoroughbreddailynews.com/category/news/feed/",
    baseUrl: "https://www.thoroughbreddailynews.com",
    parse: parseFeed,
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
    tryDirect: true,
    requireDate: true,
    minimumItems: 1,
    minimumImageCoverage: 0.75
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
  }
];
