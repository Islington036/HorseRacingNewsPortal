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

  // Dateを指定タイムゾーンの壁時計へ分解し、端末のローカルタイムゾーンに依存しない部品を返す。
  function readZonedParts(date, timeZone) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime()) || !timeZone) return null;

    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      });
      return Object.fromEntries(
        formatter.formatToParts(date)
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, Number(part.value)])
      );
    } catch (_error) {
      return null;
    }
  }

  // 地域時刻を一度UTCと仮定し、その瞬間の地域差を差し引いて絶対時刻へ変換する。
  // 変換後の壁時計が入力と一致しない夏時間の欠落時刻は、推測せずnullを返す。
  function zonedDateToUtc(parts, timeZone) {
    if (!isValidCalendarParts(parts)) return null;

    const wallClockUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    let timestamp = wallClockUtc;

    // 夏時間境界の前後で最初の推定に別のオフセットが適用されても収束できるよう、差分を再計算する。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const represented = readZonedParts(new Date(timestamp), timeZone);
      if (!represented) return null;
      const representedAsUtc = Date.UTC(
        represented.year,
        represented.month - 1,
        represented.day,
        represented.hour,
        represented.minute
      );
      const nextTimestamp = timestamp - (representedAsUtc - wallClockUtc);
      if (nextTimestamp === timestamp) break;
      timestamp = nextTimestamp;
    }

    const result = new Date(timestamp);
    const verified = readZonedParts(result, timeZone);
    if (!verified || !sameCalendarParts(verified, parts)) return null;
    return result;
  }

  // Irish Racingの日付見出しと一覧上の時刻をEurope/Dublinの壁時計として解釈する。
  function parseIrishRacingDateTime(dateHeader, timeText) {
    const dateMatch = cleanWhitespace(dateHeader).match(
      /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+((?:19|20)\d{2})$/i
    );
    const timeMatch = cleanWhitespace(timeText).match(/^(\d{1,2})[.:](\d{2})\s*(AM|PM)$/i);
    if (!dateMatch || !timeMatch) return null;

    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
      .indexOf(dateMatch[2].slice(0, 3).toLowerCase()) + 1;
    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    if (!month || hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    if (/pm/i.test(timeMatch[3]) && hour < 12) hour += 12;
    if (/am/i.test(timeMatch[3]) && hour === 12) hour = 0;

    return zonedDateToUtc({
      year: Number(dateMatch[3]),
      month,
      day: Number(dateMatch[1]),
      hour,
      minute
    }, "Europe/Dublin");
  }

  // Irish RacingのReader一覧から、日付見出し・記事見出し・時刻・写真を同じ記事へ結び付ける。
  function extractIrishRacingReaderItems(text) {
    if (!text) return [];

    const lines = String(text).split(/\r?\n/).map((line) => line.trim());
    const items = [];
    let currentDateHeader = "";
    let lastImage = "";

    lines.forEach((line, index) => {
      // 日付見出しは後続カードに引き継ぎ、別日へ移った時点で直近画像を破棄する。
      if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+20\d{2}$/i.test(line)) {
        currentDateHeader = line;
        lastImage = "";
        return;
      }

      const imageMatch = line.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/);
      if (imageMatch) lastImage = imageMatch[1];

      // Readerには通常カードと、画像・本文・時刻が一つのリンクへ圧縮された先頭カードが混在する。
      const inlineHeading = line.match(/^\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\]\((https?:\/\/(?:www\.)?irishracing\.com\/news\/[^)]+)\)#{2,6}\s+\[([^\]]+)\]\((https?:\/\/(?:www\.)?irishracing\.com\/news\/[^)]+)\)/i);
      const compactHero = line.match(/^\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\s*#{2,6}\s*.+?\s+(\d{1,2}\.\d{2}\s*(?:AM|PM))\]\((https?:\/\/(?:www\.)?irishracing\.com\/news\/[^)]+)\)/i);
      const heading = line.match(/^#{2,6}\s+\[([^\]]+)\]\((https?:\/\/(?:www\.)?irishracing\.com\/news\/[^)]+)\)/i);
      if (!currentDateHeader) return;

      let title = "";
      let url = "";
      let thumbnail = lastImage;
      let timeText = "";

      if (inlineHeading) {
        thumbnail = inlineHeading[1];
        title = inlineHeading[3];
        url = inlineHeading[4] || inlineHeading[2];
        timeText = findIrishRacingReaderTime(lines, index);
      } else if (compactHero) {
        thumbnail = compactHero[1];
        url = compactHero[3];
        title = titleFromIrishRacingUrl(url) || url;
        timeText = compactHero[2];
      } else if (heading) {
        title = heading[1];
        url = heading[2];
        timeText = findIrishRacingReaderTime(lines, index);
      } else {
        return;
      }

      // 一度カードへ割り当てた画像は、日時欠落で記事化できない場合も次のカードへ持ち越さない。
      lastImage = "";
      const publishedAt = parseIrishRacingDateTime(currentDateHeader, timeText);
      if (!publishedAt) return;
      items.push({ title: cleanWhitespace(title), url, publishedAt, thumbnail });
    });

    // 元一覧は同日内でも公開時刻が前後するため、本体・テスターへ渡す前に新着順へ揃える。
    return items.sort((a, b) => b.publishedAt - a.publishedAt);
  }

  // 見出しの直後に本文が挟まる場合も、次のカードへ届かない近傍だけから時刻を探す。
  function findIrishRacingReaderTime(lines, index) {
    for (let offset = 0; offset <= 6; offset += 1) {
      const line = lines[index + offset] || "";
      if (offset > 0 && (
        /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+\d{1,2}/i.test(line) ||
        /irishracing\.com\/news\//i.test(line)
      )) return "";
      const match = line.match(/\b\d{1,2}[.:]\d{2}\s*(?:AM|PM)\b/i);
      if (match) return match[0];
    }
    return "";
  }

  // Irish RacingのURLは末尾が数値IDのため、一つ前のslugを先頭カードの見出しへ戻す。
  function titleFromIrishRacingUrl(value) {
    try {
      const parts = new URL(value).pathname.split("/").filter(Boolean);
      const slug = parts.length >= 3 ? parts[parts.length - 2] : "";
      return cleanWhitespace(
        decodeURIComponent(slug)
          .replace(/[-_]+/g, " ")
          .replace(/\b([a-z])/g, (match) => match.toUpperCase())
      );
    } catch (_error) {
      return "";
    }
  }

  // 除外カテゴリが設定されたWordPress媒体では、カテゴリ不明と除外対象投稿を安全側で落とす。
  // 除外設定のない既存媒体にはカテゴリ配列を要求せず、従来の抽出挙動を維持する。
  function isAllowedWordPressPost(post, site) {
    const excludedIds = Array.isArray(site && site.excludedCategoryIds)
      ? site.excludedCategoryIds.map(Number).filter(Number.isInteger)
      : [];
    if (excludedIds.length === 0) return true;

    const categoryIds = Array.isArray(post && post.categories)
      ? post.categories.map(Number).filter(Number.isInteger)
      : [];
    if (categoryIds.length === 0) return false;
    return !categoryIds.some((categoryId) => excludedIds.includes(categoryId));
  }

  // 数値の範囲と実在する暦日を確認し、Dateの自動繰り上げによる誤日時を防ぐ。
  function isValidCalendarParts(parts) {
    if (!parts || ![parts.year, parts.month, parts.day, parts.hour, parts.minute].every(Number.isInteger)) return false;
    if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.hour < 0 || parts.hour > 23 || parts.minute < 0 || parts.minute > 59) return false;
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
    return date.getUTCFullYear() === parts.year &&
      date.getUTCMonth() + 1 === parts.month &&
      date.getUTCDate() === parts.day;
  }

  // 地域変換後の壁時計が入力と同一かを照合し、夏時間の欠落時刻を検出する。
  function sameCalendarParts(actual, expected) {
    return actual.year === expected.year &&
      actual.month === expected.month &&
      actual.day === expected.day &&
      actual.hour === expected.hour &&
      actual.minute === expected.minute;
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
    extractIrishRacingReaderItems,
    extractRacenetReaderCards,
    extractRacingTvReaderCards,
    extractTheAgeReaderItems,
    hasExplicitTimezone,
    isCandidateArticleUrl,
    isAllowedWordPressPost,
    isRacenetArticleUrl,
    isTtrAusNzFixedPage,
    parseIrishRacingDateTime,
    parseInternationalDate,
    parseExplicitTimezoneDate,
    pickRacenetReaderTitle,
    readZonedParts,
    zonedDateToUtc
  });
});
