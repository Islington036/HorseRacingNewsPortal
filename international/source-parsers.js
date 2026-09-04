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

  // RSSや一覧に付く明示的なタイムゾーンを、実行端末のローカル時刻へ変えずDateへ変換する。
  // IST/CSTは地域によって意味が変わるため推測せず、呼び出し元で日時不明として扱わせる。
  function parseExplicitTimezoneDate(value) {
    const raw = cleanWhitespace(value);
    const timezoneMatch = raw.match(/\b(GMT|UTC|BST|IST|EDT|EST|CDT|CST|PDT|PST|AEST|AEDT|NZST|NZDT|HKT)\b/i);
    if (!timezoneMatch) return null;

    const timezone = timezoneMatch[1].toUpperCase();
    if (timezone === "IST" || timezone === "CST") return null;

    const offsets = {
      GMT: "+0000",
      UTC: "+0000",
      BST: "+0100",
      EDT: "-0400",
      EST: "-0500",
      CDT: "-0500",
      PDT: "-0700",
      PST: "-0800",
      AEST: "+1000",
      AEDT: "+1100",
      NZST: "+1200",
      NZDT: "+1300",
      HKT: "+0800"
    };
    const normalized = raw
      .replace(/(\d+)(st|nd|rd|th)/gi, "$1")
      .replace(timezoneMatch[0], offsets[timezone]);
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // タイムゾーン略称が明示されているかを判定し、未解釈の値をローカル時刻として誤読するのを防ぐ。
  function hasExplicitTimezone(value) {
    return /\b(GMT|UTC|BST|IST|EDT|EST|CDT|CST|PDT|PST|AEST|AEDT|NZST|NZDT|HKT)\b/i.test(String(value || ""));
  }

  // 本体と媒体別テスターが同じ日時を別のタイムゾーンとして解釈しないよう、
  // 年を含む絶対日時と相対時刻だけを共有処理でDateへ変換する。
  function parseInternationalDate(value, nowMs = Date.now()) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "number") {
      const timestamp = value > 10000000000 ? value : value * 1000;
      const date = new Date(timestamp);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    const raw = cleanWhitespace(value)
      .replace(/\b(Published|Updated|Last updated|Posted|By)\b:?\s*/ig, "")
      .trim();
    if (!raw) return null;
    if (hasExplicitTimezone(raw)) return parseExplicitTimezoneDate(raw);

    const relative = raw.match(/^(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days)\s*(?:ago)?$/i);
    if (relative) {
      const amount = Number(relative[1]);
      const unit = relative[2].toLowerCase();
      const minutes = /day/.test(unit) ? amount * 24 * 60 : /hour|hr/.test(unit) ? amount * 60 : amount;
      return new Date(nowMs - minutes * 60 * 1000);
    }

    // 年なし表記はサイトごとの暦日補完が必要なため、ここでブラウザ標準へ渡して推測しない。
    if (!/\b(?:19|20)\d{2}\b/.test(raw)) return null;
    const normalized = raw
      .replace(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+/i, "")
      .replace(/(\d+)(st|nd|rd|th)/gi, "$1");
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // 設定された媒体の記事URLかを、プロトコル・ホスト・記事パス・固定ページ除外まで一度に判定する。
  // 本体とテスターの最終ゲートで同じ関数を使い、抽出経路ごとの判定差を防ぐ。
  function isCandidateArticleUrl(value, site) {
    if (!site || !site.baseUrl) return false;

    let parsed;
    let siteUrl;
    try {
      parsed = new URL(value, site.baseUrl);
      siteUrl = new URL(site.baseUrl);
    } catch (_error) {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

    const configuredOrigins = Array.isArray(site.allowedOrigins) ? site.allowedOrigins : [];
    if (configuredOrigins.length > 0 && !configuredOrigins.includes(parsed.origin)) return false;

    const host = stripWww(parsed.hostname);
    const siteHost = stripWww(siteUrl.hostname);
    const allowedHosts = (site.allowedHosts || []).map(stripWww);
    if (host !== siteHost && !host.endsWith(`.${siteHost}`) && !allowedHosts.includes(host)) return false;

    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const lowerPath = path.toLowerCase();
    const lowerHref = parsed.href.toLowerCase();
    const sourcePath = new URL(site.url || site.baseUrl, site.baseUrl).pathname.replace(/\/+$/, "") || "/";
    if (path === "/" || lowerPath === sourcePath.toLowerCase()) return false;
    if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|mp4|mov|avi|zip)$/i.test(lowerPath)) return false;
    if (/\/(tag|tags|category|categories|author|authors|search|subscribe|subscription|login|signin|sign-in|register|about|contact|privacy|terms|advertise|video|videos|podcast|racecards?|results?|tips?|free-bets?)($|\/)/i.test(lowerPath)) return false;
    if (/\/(newsletter|issues?|today|rankings?|live|premierleague|football|soccer|uk-news|world-news|royal|tv-guide|null)($|\/)/i.test(lowerPath)) return false;
    if (site.id !== "ttrausnz" && /\/editions?($|\/)/i.test(lowerPath)) return false;
    if (/\/(the-biz|sales-reports|expert-opinion|breeding-and-bloodstock|bloodstock-sales|sales-calendar|sales-results|stallions?|sires?|features?|columnists?)$/i.test(lowerPath)) return false;
    if (/\/news\/(latest-news|racing|tipping|jockeys|interstate|international|industry|tv-shows|spring-racing|blackbook|null)$/i.test(lowerPath)) return false;

    if ((site.id === "racingpost_news" || site.id === "racingpost_bloodstock") && !/-a[a-z0-9]+\/?$/i.test(lowerPath)) return false;
    if (site.id === "ttrausnz" && (
      !/^\/edition\/20\d{2}-\d{2}-\d{2}\/[^/]+$/i.test(lowerPath) ||
      isTtrAusNzFixedPage(lowerPath.split("/").pop())
    )) return false;
    if (site.id === "loveracing_nz" && !/^\/news\/\d+\/[^/]+\.aspx$/i.test(lowerPath)) return false;

    const prefixes = site.pathPrefixes || [];
    if (prefixes.length > 0 && !prefixes.some((prefix) => lowerPath.startsWith(String(prefix).toLowerCase()))) return false;
    const excludedHints = site.excludePathHints || [];
    if (excludedHints.some((hint) => lowerPath.includes(String(hint).toLowerCase()))) return false;
    if (site.articlePathPattern instanceof RegExp) {
      site.articlePathPattern.lastIndex = 0;
      if (!site.articlePathPattern.test(parsed.pathname)) return false;
    }

    const hints = site.pathHints || [];
    if (hints.length > 0 && hints.some((hint) => lowerHref.includes(String(hint).toLowerCase()) || lowerPath.includes(String(hint).toLowerCase()))) return true;
    if (hints.length > 0 && !site.includeAnySameHost) return false;
    if (site.includeAnySameHost) return true;
    return /\/(news|racing|bloodstock|articles?|features|sport|horse-racing|breeding|sales|story)\//i.test(lowerPath) || /article-\d+|news-story/i.test(lowerPath);
  }

  // Racing TVのReader一覧で、画像・記事URL・見出し本文を同じカードから抽出する。
  // 日時のないカードは構造情報として残し、本体とテスターの日時ポリシーで共通に判定する。
  function extractRacingTvReaderCards(text) {
    const cards = [];
    const pattern = /\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\s*([^\[\]]{8,500}?)\]\((https?:\/\/(?:www\.)?racingtv\.com\/news\/[^)]+)\)/gi;

    for (const match of String(text || "").matchAll(pattern)) {
      const body = cleanWhitespace(match[2]);
      const publishedAt = (body.match(/\b\d+\s+(?:minutes?|mins?|hours?|hrs?|days?)\s+ago\b/i) || [])[0] || "";
      cards.push({
        title: cleanWhitespace(body.replace(/\b\d+\s+(?:minutes?|mins?|hours?|hrs?|days?)\s+ago\b.*$/i, "")),
        url: match[3],
        publishedAt,
        thumbnail: match[1]
      });
    }

    return cards;
  }

  // The AgeのReader一覧で、同一記事URLに結び付く画像・見出し・公開日を一つの項目へまとめる。
  // トピック導線や著者リンクは、画像カードと記事見出しのURL一致を満たさないため混入しない。
  function extractTheAgeReaderItems(text) {
    const raw = String(text || "");
    const cardPattern = /\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\]\((https?:\/\/(?:www\.)?theage\.com\.au\/sport\/racing\/[^)]+)\)([\s\S]*?)(?=\n\[!\[[^\]]*\]\(https?:\/\/|$)/gi;
    const items = [];

    for (const match of raw.matchAll(cardPattern)) {
      const block = match[3];
      const heading = block.match(/#{2,4}\s+\[([^\]]+)\]\((https?:\/\/(?:www\.)?theage\.com\.au\/sport\/racing\/[^)]+)\)/i);
      const publishedAt = (block.match(/^\*\s+([A-Za-z]+\s+\d{1,2},\s+20\d{2})\s*$/m) || [])[1] || "";
      if (!heading || !publishedAt || canonicalUrl(heading[2]) !== canonicalUrl(match[2])) continue;
      items.push({
        title: cleanWhitespace(heading[1]),
        url: heading[2],
        publishedAt,
        thumbnail: match[1]
      });
    }

    return items;
  }

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

  function canonicalUrl(value) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch (_error) {
      return "";
    }
  }

  function stripWww(hostname) {
    return String(hostname || "").replace(/^www\./i, "");
  }

  function isTtrAusNzFixedPage(slug) {
    const value = String(slug || "");
    return /^(?:job-board|wednesday-trivia|20\d{2}-stallion-parades|daily-news-wrap|debutants|first-season-sire-runners-and-results|thanks-for-reading)$/i.test(value) ||
      /^looking-ahead(?:-|$)/i.test(value);
  }

  return Object.freeze({
    extractRacenetReaderCards,
    extractRacingTvReaderCards,
    extractTheAgeReaderItems,
    hasExplicitTimezone,
    isCandidateArticleUrl,
    isRacenetArticleUrl,
    isTtrAusNzFixedPage,
    parseInternationalDate,
    parseExplicitTimezoneDate,
    pickRacenetReaderTitle
  });
});
