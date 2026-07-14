import { parseFeed } from "./core.js";

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
  }
];
