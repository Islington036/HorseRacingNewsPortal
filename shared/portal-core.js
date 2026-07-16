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

  // HTTP要求の開始時刻を直列予約し、429応答時はRetry-Afterに従って後続要求も待機させる。
  // 通信完了までは直列化しないため、開始間隔を守りつつ遅い応答が全媒体を不必要に塞がない。
  function createRequestRateLimiter(options = {}) {
    const minStartIntervalMs = normalizeNonNegativeNumber(options.minStartIntervalMs, 0);
    const defaultRetryAfterMs = normalizeNonNegativeNumber(options.defaultRetryAfterMs, 60000);
    const retryLimit = Math.max(0, Math.floor(normalizeNonNegativeNumber(options.retryLimit, 0)));
    const now = typeof options.now === "function" ? options.now : Date.now;
    const wait = typeof options.wait === "function" ? options.wait : waitForMilliseconds;
    let reservationQueue = Promise.resolve();
    let nextStartAt = 0;
    let blockedUntil = 0;

    // 1要求分の開始枠を予約する。待機中に別要求が429を受ける可能性があるため、
    // 一度sleepした後も共有ブロック時刻を読み直し、実際に開始可能になるまで繰り返す。
    function reserve(signal) {
      const reservation = reservationQueue
        .catch(() => {})
        .then(async () => {
          while (true) {
            throwIfAborted(signal);
            const currentTime = now();
            const waitUntil = Math.max(nextStartAt, blockedUntil);
            if (waitUntil <= currentTime) break;
            await waitWithSignal(waitUntil - currentTime, signal, wait);
          }
          nextStartAt = now() + minStartIntervalMs;
        });

      // 1件の中止・失敗で後続予約まで永久停止しないよう、共有チェーン側だけ例外を吸収する。
      reservationQueue = reservation.catch(() => {});
      return reservation;
    }

    // 指定ミリ秒だけ全要求の開始を停止する。複数の429が重なった場合は最も遅い解除時刻を残す。
    function block(delayMs) {
      const normalizedDelay = normalizeNonNegativeNumber(delayMs, defaultRetryAfterMs);
      blockedUntil = Math.max(blockedUntil, now() + normalizedDelay);
    }

    // Retry-Afterは秒数とHTTP-dateの両形式を受け付ける。ブラウザからヘッダーを読めない場合や
    // 不正値の場合は、設定済みの保守的な既定時間へ戻す。
    function parseRetryAfterMs(value) {
      const raw = String(value || "").trim();
      // HTTP仕様のdelay-secondsは数字だけを許可する。負数をDate.parseへ渡すと、
      // 一部ブラウザが過去日付として解釈して1秒再試行になるため、曖昧値は既定待機へ戻す。
      if (/^\d+$/.test(raw)) {
        const seconds = Number(raw);
        return Math.max(1000, seconds * 1000);
      }

      // HTTP-dateには英語の曜日または月名が入るため、単なる数値・記号列を日付として誤認しない。
      if (/[A-Za-z]{3}/.test(raw)) {
        const retryAt = Date.parse(raw);
        if (!Number.isNaN(retryAt)) return Math.max(1000, retryAt - now());
      }
      return defaultRetryAfterMs;
    }

    // Response互換値を返すHTTP処理を実行する。429なら後続を止め、設定回数だけ同じ処理を再試行する。
    // 最後の試行も429だった場合はそのResponseを呼び出し元へ返し、媒体側で通常のHTTPエラー表示にする。
    async function run(request, runOptions = {}) {
      if (typeof request !== "function") throw new TypeError("request must be a function");

      let response = null;
      for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
        await reserve(runOptions.signal);
        response = await request(attempt);
        if (!response || Number(response.status) !== 429) return response;

        const retryAfter = response.headers && typeof response.headers.get === "function"
          ? response.headers.get("Retry-After")
          : null;
        // 再試行回数を使い切った場合も、後続要求が直後に同じ429を受けないようブロックは更新する。
        block(parseRetryAfterMs(retryAfter));
        if (attempt >= retryLimit) return response;
      }
      return response;
    }

    return Object.freeze({
      block,
      parseRetryAfterMs,
      reserve,
      run
    });
  }

  // URLが指定ホストを正確に指すか確認する。文字列の部分一致を使わず、偽装ホストを除外する。
  function isUrlHostname(value, hostname) {
    try {
      return new URL(String(value || "")).hostname.toLowerCase() === String(hostname || "").toLowerCase();
    } catch (_error) {
      return false;
    }
  }

  // 取得元URLの既存query/hashを保ったまま、Readerキャッシュ更新用などの指定パラメータを設定する。
  // 不正URLは呼び出し元で通常の通信エラーとして扱えるよう、加工せず元の文字列を返す。
  function setUrlQueryParameter(value, name, parameterValue) {
    try {
      const url = new URL(String(value || ""));
      url.searchParams.set(String(name || ""), String(parameterValue));
      return url.href;
    } catch (_error) {
      return String(value || "");
    }
  }

  // Jina ReaderのTitle行とMarkdown本文の全H1を返し、媒体側でより完全な見出しを比較できるようにする。
  // Reader本文は記事H1より前にサイトロゴの空MarkdownリンクをH1として置く場合があるため、先頭だけに限定しない。
  function extractReaderTitleCandidates(value) {
    const text = String(value || "");
    const candidates = [];
    // 改行まで含む\sを使うと空Title行の次のURL Sourceを誤取得するため、行内空白だけを許す。
    const titleMatch = text.match(/^Title:[ \t]*(.+)$/im);
    const headingMatches = [...text.matchAll(/^#[ \t]+(.+)$/gm)]
      .map((match) => match[1])
      .filter((heading) => !/^\[\s*\]\([^)]+\)$/.test(String(heading || "").trim()));

    [titleMatch && titleMatch[1], ...headingMatches].forEach((candidate) => {
      const normalized = String(candidate || "").replace(/\s+/g, " ").trim();
      if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
    });
    return candidates;
  }

  // 記事ページtitleに付く媒体名だけを区切り記号ごと除去し、見出し本文中の同名語は維持する。
  function stripTrailingSourceName(value, sourceNames) {
    const text = String(value || "").trim();
    const escapedNames = (Array.isArray(sourceNames) ? sourceNames : [])
      .map((name) => String(name || "").trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp);
    if (escapedNames.length === 0) return text;

    const suffixPattern = new RegExp(`\\s*[-|｜‐‑‒–—―]\\s*(?:${escapedNames.join("|")})\\s*$`, "i");
    return text.replace(suffixPattern, "").trim();
  }

  // 媒体名に含まれるピリオドなどを正規表現の文字ではなく、文字列そのものとして比較できるようにする。
  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  function normalizeNonNegativeNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function waitForMilliseconds(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
  }

  // 予約待機中に媒体全体の期限へ達した場合、実HTTPを開始せず直ちに待機列から離脱する。
  function waitWithSignal(delayMs, signal, wait) {
    throwIfAborted(signal);
    if (!signal) return Promise.resolve(wait(delayMs));

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", handleAbort);
        callback(value);
      };
      const handleAbort = () => finish(reject, createAbortError());

      signal.addEventListener("abort", handleAbort, { once: true });
      Promise.resolve(wait(delayMs)).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
    });
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw createAbortError();
  }

  function createAbortError() {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
  }

  return Object.freeze({
    createRequestRateLimiter,
    dedupeByUrl,
    extractReaderTitleCandidates,
    finalizeStructuredSourceItems,
    isUrlHostname,
    mapWithConcurrency,
    parseJapaneseDate,
    setUrlQueryParameter,
    stripTrailingSourceName
  });
});
