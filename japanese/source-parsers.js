(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.JapaneseHorseRacingSourceParsers = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // スポニチ競馬WebのReader一覧から、1カードに属する画像・見出し・記事URL・公開日時を抽出する。
  // 個別記事URLの形式を限定し、ナビゲーションやランキングなど記事ではないリンクの混入を防ぐ。
  function extractSponichiReaderItems(text) {
    const items = [];
    const cardPattern = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)\s+\*\*\[([^\]]+)\]\((https?:\/\/keiba\.sponichi\.co\.jp\/news\/[A-Za-z0-9]+)\)\*\*\s*(20\d{2}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2})/g;

    for (const match of String(text || "").matchAll(cardPattern)) {
      items.push({
        title: cleanWhitespace(match[2]),
        url: match[3],
        publishedAt: toJstIso(match[4]),
        // 配信元のdummy画像は実写真として数えず、本体の共通ダミー画像表示へ明示的に渡す。
        thumbnail: /\/front\/images\/dummy\//i.test(match[1]) ? "" : match[1]
      });
    }

    return items;
  }

  function cleanWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  // Reader一覧の日本語日時をタイムゾーン付きISOへ直し、テスターでも閲覧端末の地域に依存させない。
  function toJstIso(value) {
    const match = String(value || "").match(/^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})$/);
    if (!match) return "";
    const pad = (part) => String(part).padStart(2, "0");
    return `${match[1]}-${pad(match[2])}-${pad(match[3])}T${pad(match[4])}:${match[5]}:00+09:00`;
  }

  return Object.freeze({
    extractSponichiReaderItems
  });
});
