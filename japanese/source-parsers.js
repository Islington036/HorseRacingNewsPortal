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

  // サンスポの中央競馬ニュース欄だけを読み、予想・動画・固定ページなど別セクションを除外する。
  function extractSanspoReaderItems(text) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trim());
    const startIndex = lines.findIndex((line) => line === "## 中央競馬ニュース");
    if (startIndex === -1) return [];
    const nextSection = lines.findIndex((line, index) => index > startIndex && /^#{1,2}(?:\s|$)/.test(line));
    const section = lines.slice(startIndex + 1, nextSection === -1 ? undefined : nextSection).join("\n");
    const headings = [...section.matchAll(/^###\s+(.+)$/gm)];
    const items = [];

    headings.forEach((heading, index) => {
      const card = heading[1].match(/^\[([^\]]+)\]\((https:\/\/www\.sanspo\.com\/race\/article\/general\/20\d{6}-[A-Z0-9]+\/?)\)$/i);
      if (!card) return;
      // 次の見出しを必ず境界にし、画像や日時のない記事へ隣のカードの値を流用しない。
      const endIndex = index + 1 < headings.length ? headings[index + 1].index : section.length;
      const body = section.slice(heading.index + heading[0].length, endIndex);
      const date = body.match(/^(20\d{2}\/\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2})(?:\s+JST)?\s*$/m);
      if (!date) return;
      const image = body.match(/!\[[^\]]*\]\((https:\/\/www\.sanspo\.com\/resizer\/v2\/[^)\s]+)\)/i);
      const thumbnail = image ? image[1] : "";

      items.push({
        title: cleanWhitespace(card[1]),
        url: card[2],
        // ReaderヘッダーのPublished Timeは一覧ページ自体の日時なので、各カードの日本時間を使う。
        publishedAt: toSlashDateJstIso(date[1], date[2]),
        thumbnail: /thumb_keiba_og\.jpg/i.test(thumbnail) ? "" : thumbnail
      });
    });

    return items;
  }

  // 東スポ競馬のReader一覧カードから、同じ記事に属する画像・見出し・公開日時を抽出する。
  // 記事URLを二重に持つ正式カードだけを認め、ランキングや広告、隣のカードの日時を除外する。
  function extractTospoReaderCards(text) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trim());
    const items = [];

    lines.forEach((line, index) => {
      const card = line.match(/\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\]\((https?:\/\/tospo-keiba\.jp\/breaking_news\/\d+)\)(?:!\[[^\]]*\]\([^)]+\))?\s*\[([^\]]+)\]\((https?:\/\/tospo-keiba\.jp\/breaking_news\/\d+)\)/i);
      if (!card || canonicalArticleUrl(card[2]) !== canonicalArticleUrl(card[4])) return;
      if (!/\/images\/article\/thumbnail\//i.test(card[1])) return;

      const nextCardOffset = lines
        .slice(index + 1)
        .findIndex((value) => /tospo-keiba\.jp\/breaking_news\/\d+/i.test(value));
      const endIndex = nextCardOffset === -1 ? index + 8 : index + 1 + nextCardOffset;
      const nearby = lines.slice(index + 1, Math.min(endIndex, index + 8));
      const date = nearby.find((value) => /^20\d{2}\/\d{1,2}\/\d{1,2}$/.test(value));
      const time = nearby.find((value) => /^\d{1,2}:\d{2}$/.test(value));
      if (!date || !time) return;

      items.push({
        title: cleanWhitespace(card[3]),
        url: card[4],
        publishedAt: toSlashDateJstIso(date, time),
        thumbnail: card[1]
      });
    });

    return items;
  }

  // URL-to-MarkdownがGoogle News Sitemapを一行へ平文化した場合も、公式URL・日時・見出しを復元する。
  // 別カテゴリの記事も区切りとして認識し、見出しを連結せずbreaking_newsだけをニュース一覧へ返す。
  function extractTospoSitemapTextItems(text) {
    const normalized = String(text || "").replace(/\\_/g, "_");
    const headerPattern = /https:\/\/tospo-keiba\.jp\/([A-Za-z][A-Za-z0-9_-]*)\/(\d+)\s+東スポ競馬\s+ja\s+(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+/g;
    const headers = [...normalized.matchAll(headerPattern)];

    return headers.flatMap((header, index) => {
      if (header[1] !== "breaking_news") return [];
      const titleStart = header.index + header[0].length;
      const titleEnd = index + 1 < headers.length ? headers[index + 1].index : normalized.length;
      const title = cleanWhitespace(normalized.slice(titleStart, titleEnd));
      if (!title) return [];

      return [{
        title,
        url: `https://tospo-keiba.jp/breaking_news/${header[2]}`,
        publishedAt: header[3],
        thumbnail: ""
      }];
    });
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

  // スラッシュ区切りの日付と時刻を、日本時間のISO表記へ統一する。
  function toSlashDateJstIso(date, time) {
    const match = `${date} ${time}`.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (!match) return "";
    const pad = (part) => String(part).padStart(2, "0");
    return `${match[1]}-${pad(match[2])}-${pad(match[3])}T${pad(match[4])}:${match[5]}:00+09:00`;
  }

  function canonicalArticleUrl(value) {
    try {
      const parsed = new URL(value);
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
    } catch (_error) {
      return "";
    }
  }

  return Object.freeze({
    extractSanspoReaderItems,
    extractSponichiReaderItems,
    extractTospoReaderCards,
    extractTospoSitemapTextItems
  });
});
