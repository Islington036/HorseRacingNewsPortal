(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.InternationalHorseRacingSourceParsers = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // RacenetのReaderカードから、実写真・本文・個別記事URLだけを抜き出す。
  // premium記事では実写真の直後に鍵アイコンが入るため、追加画像を読み飛ばして最初の写真を維持する。
  function extractRacenetReaderCards(text) {
    if (!text) return [];

    const cards = [];
    const cardPattern = /\[!\[[^\]]*?(?::\s*([^\]]+))?\]\((https?:\/\/[^)]+)\)(?:\s*!\[[^\]]*\]\(https?:\/\/[^)]+\))*\s*([^\[\]]{20,900}?)\]\((https?:\/\/www\.racenet\.com\.au\/news\/[^)]+)\)/g;

    for (const match of String(text).matchAll(cardPattern)) {
      const url = match[4];
      // /news/配下のカテゴリや記者ページではなく、日付付きの個別記事だけを返す。
      if (!isRacenetArticleUrl(url)) continue;
      cards.push({
        thumbnail: match[2],
        body: cleanWhitespace(match[3]),
        url
      });
    }

    return cards;
  }

  // Racenetの一覧本文とURLスラッグを照合し、説明文を見出しへ混ぜない。
  function pickRacenetReaderTitle(body, url, maxLength = 240) {
    const fallbackTitle = cleanWhitespace(body);
    const fromSlug = titleFromRacenetUrlSlug(url);
    if (!fromSlug) return fallbackTitle;

    const bodyPrefix = fallbackTitle.slice(0, 180).toLowerCase();
    const slugWords = fromSlug.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
    const matchedWords = slugWords.filter((word) => bodyPrefix.includes(word)).length;

    if (matchedWords >= Math.min(4, slugWords.length)) return fromSlug;
    // Readerが見出しと長い要約を連結した場合は、240文字超で記事ごと落とさずURL由来の題へ戻す。
    return fallbackTitle.length <= maxLength ? fallbackTitle : fromSlug;
  }

  function isRacenetArticleUrl(value) {
    try {
      const url = new URL(value);
      return /^(?:www\.)?racenet\.com\.au$/i.test(url.hostname) &&
        /^\/news\/[^/]+-20\d{6}\/?$/i.test(url.pathname);
    } catch (_error) {
      return false;
    }
  }

  function titleFromRacenetUrlSlug(value) {
    try {
      const url = new URL(value);
      const encodedSlug = url.pathname.split("/").filter(Boolean).pop() || "";
      return cleanWhitespace(
        decodeURIComponent(encodedSlug)
          .replace(/-\d{8}$/i, "")
          .replace(/[-_]+/g, " ")
          .replace(/\b([a-z])/g, (match) => match.toUpperCase())
      );
    } catch (_error) {
      return "";
    }
  }

  function cleanWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  return Object.freeze({
    extractRacenetReaderCards,
    isRacenetArticleUrl,
    pickRacenetReaderTitle
  });
});
