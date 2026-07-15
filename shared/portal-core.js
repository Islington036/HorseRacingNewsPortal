(function (root, factory) {
  "use strict";

  const api = factory();

  // GitHub Pagesではグローバルとして、Node.jsの決定的テストではCommonJSとして同じ実装を公開する。
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HorseRacingPortalCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 外部サイトへの処理を指定数のワーカーで実行し、入力と同じ順序で結果を返す。
  async function mapWithConcurrency(items, concurrency, iteratee) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, items.length));

    async function runWorker() {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, runWorker));
    return results;
  }

  // query/hashだけが異なる同一記事をまとめ、公開日時が新しい候補を残す。
  function dedupeByUrl(items) {
    const byUrl = new Map();

    items.forEach((item) => {
      const key = String(item && item.url || "").replace(/[?#].*$/, "");
      if (!key) return;

      const existing = byUrl.get(key);
      if (!existing || timestampOf(item) > timestampOf(existing)) {
        byUrl.set(key, item);
      }
    });

    return [...byUrl.values()];
  }

  // APIと完全RSSなど複数の構造化経路を、重複なし・新着順・媒体上限へ確定する。
  // validEmptyResultがnull以外なら「取得成功だが0件」を表し、通信失敗とは区別する。
  function finalizeStructuredSourceItems(mergedItems, validEmptyResult, maxItems) {
    if (mergedItems.length > 0) {
      const parsedLimit = Number(maxItems);
      const itemLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : mergedItems.length;
      return {
        hasResult: true,
        items: dedupeByUrl(mergedItems)
          .sort((left, right) => timestampOf(right) - timestampOf(left))
          .slice(0, itemLimit)
      };
    }

    if (validEmptyResult !== null) {
      return { hasResult: true, items: validEmptyResult };
    }

    return { hasResult: false, items: [] };
  }

  // 国内媒体のタイムゾーンなし日時を、閲覧者の地域に依存させずJSTとして解釈する。
  // ISO 8601などタイムゾーンを含む形式だけ、最後にブラウザ標準パーサーへ委ねる。
  function parseJapaneseDate(value, now = new Date()) {
    if (!value) return null;
    const raw = String(value).trim();

    // 末尾にZ/UTC/GMT/数値オフセットがある日時は、JST固定形式へ部分一致させず明示された地域を尊重する。
    if (/(?:Z|(?:UTC|GMT)(?:[+-]\d{1,2}(?::?\d{2})?)?|[+-]\d{2}:?\d{2})\s*$/i.test(raw)) {
      const zonedDate = new Date(raw);
      return Number.isNaN(zonedDate.getTime()) ? null : zonedDate;
    }

    let match = raw.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
    if (match) return makeJstDate(match[1], match[2], match[3], match[4], match[5]);

    match = raw.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s*(\d{1,2}):(\d{2})/);
    if (match) return makeJstDate(match[1], match[2], match[3], match[4], match[5]);

    match = raw.match(/(\d{1,2})月\s*(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
    if (match) {
      const currentJstYear = getYearInTimeZone(now, "Asia/Tokyo");
      let candidate = makeJstDate(currentJstYear, match[1], match[2], match[3], match[4]);

      // 1月初旬に前年12月の記事を読む場合、現在年を補うと約1年先になるため前年へ戻す。
      if (candidate.getTime() > now.getTime() + 60 * 60 * 1000) {
        candidate = makeJstDate(currentJstYear - 1, match[1], match[2], match[3], match[4]);
      }
      return candidate;
    }

    const native = new Date(raw);
    return Number.isNaN(native.getTime()) ? null : native;
  }

  // 日本標準時の年月日時分をUTCのDateへ変換する。
  function makeJstDate(year, month, day, hour, minute) {
    const utcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 9, Number(minute));
    return new Date(utcMs);
  }

  // 実行環境のローカルタイムゾーンを使わず、指定地域の西暦年だけを取得する。
  function getYearInTimeZone(date, timeZone) {
    const yearPart = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric"
    }).formatToParts(date).find((part) => part.type === "year");
    return Number(yearPart && yearPart.value);
  }

  // DateとISO文字列のどちらでも、安全に比較用ミリ秒へ変換する。
  function timestampOf(item) {
    const value = item && item.publishedAt;
    const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  return Object.freeze({
    dedupeByUrl,
    finalizeStructuredSourceItems,
    mapWithConcurrency,
    parseJapaneseDate
  });
});
