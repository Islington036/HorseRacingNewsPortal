const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_ITEMS = 8;
const { mapWithConcurrency } = window.HorseRacingPortalCore;

// 本体と同じ公開プロキシ候補を使うが、テストでは選択された1媒体にしかアクセスしない。
const PROXY_BUILDERS = [
  (url) => "https://corsproxy.io/?" + encodeURIComponent(url),
  (url) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
  (url) => "https://api.codetabs.com/v1/proxy/?quest=" + encodeURIComponent(url)
];
const TEXT_PROXY = (url) => "https://r.jina.ai/" + url;

// 指定された媒体1件を取得し、記事データと画像の実読込結果をまとめて返す。
export async function runSourceTest(source) {
  if (!source || !source.id || !source.url || typeof source.parse !== "function") {
    throw new Error("テスト媒体の設定が不完全です");
  }

  const response = await fetchAndParseSource(source);
  const decoratedItems = source.readerDecorationUrls
    ? await decorateItemsFromReader(response.parsedItems, source)
    : response.parsedItems;
  const parsedItems = source.hydrateFromReader
    ? await hydrateItemsFromReader(decoratedItems, source)
    : decoratedItems;
  const items = parsedItems
    .map((item) => normalizeItem(item, source))
    .filter(Boolean)
    .slice(0, source.maxItems || DEFAULT_MAX_ITEMS);

  // URL文字列の存在だけでは、403やホットリンク制限を検出できないため、実際にimgとして読み込む。
  const checkedItems = await Promise.all(items.map(async (item) => ({
    ...item,
    imageLoaded: await canLoadImage(item.thumbnail, source.imageTimeoutMs)
  })));

  const validTitleLinks = checkedItems.filter((item) => item.title && isHttpUrl(item.url)).length;
  const datedItems = checkedItems.filter((item) => item.publishedAt && !Number.isNaN(item.publishedAt.getTime())).length;
  const itemCount = checkedItems.length;
  const thumbnailItems = checkedItems.filter((item) => isHttpUrl(item.thumbnail)).length;
  const missingThumbnails = itemCount - thumbnailItems;
  const loadedImages = checkedItems.filter((item) => item.imageLoaded).length;
  // 共有RSSの特定カテゴリは更新がないと0件になるため、明示された0を既定値1で上書きしない。
  const minimumItems = source.minimumItems ?? 1;
  const minimumImageCoverage = source.minimumImageCoverage ?? 0.75;
  const imageCoverage = itemCount ? loadedImages / itemCount : 0;
  const routeMatched = !source.requiredRoute || response.route === source.requiredRoute;
  const forbiddenUrlMatches = checkedItems.filter((item) => matchesForbiddenUrl(item.url, source.forbiddenUrlPatterns)).length;
  // 同一公開時刻の記事は許容し、後続記事が前の記事より新しくなる逆転だけを不正とする。
  const chronologicalOrderValid = checkedItems.every((item, index) =>
    index === 0 || !item.publishedAt || !checkedItems[index - 1].publishedAt ||
      item.publishedAt.getTime() <= checkedItems[index - 1].publishedAt.getTime()
  );

  return {
    sourceId: source.id,
    sourceName: source.name,
    route: response.route,
    itemCount,
    validTitleLinks,
    datedItems,
    thumbnailItems,
    missingThumbnails,
    loadedImages,
    imageCoverage,
    forbiddenUrlMatches,
    chronologicalOrderValid,
    passed:
      itemCount >= minimumItems &&
      validTitleLinks === itemCount &&
      (!source.requireDate || datedItems === itemCount) &&
      routeMatched &&
      forbiddenUrlMatches === 0 &&
      (!source.requireDescendingDates || chronologicalOrderValid) &&
      imageCoverage >= minimumImageCoverage &&
      // URLが配信された画像は全件読めることを要求し、画像URL自体がない記事とは別に判定する。
      loadedImages === thumbnailItems,
    items: checkedItems
  };
}

// 媒体設定で禁止した固定ページ・案内ページのURLが取得結果へ混ざっていないか確認する。
function matchesForbiddenUrl(url, patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((pattern) => {
    if (!(pattern instanceof RegExp)) return String(url || "").includes(String(pattern));
    pattern.lastIndex = 0;
    return pattern.test(String(url || ""));
  });
}

// CORS対応媒体は直接取得を先に試し、通信またはパース失敗時だけ本体と同じ公開プロキシへ進む。
async function fetchAndParseSource(source) {
  const candidates = [];
  if (source.tryDirect) {
    candidates.push({ url: source.url, route: "direct" });
  }
  if (source.allowTextProxy && source.preferTextProxy) {
    candidates.push({ url: buildTextProxyUrl(source.url, source), route: "text-proxy" });
  }
  PROXY_BUILDERS.forEach((buildUrl, index) => {
    candidates.push({ url: buildUrl(source.url), route: `proxy-${index + 1}` });
  });
  if (source.allowTextProxy && !source.preferTextProxy) {
    // Sitemapの生XMLを公開CORSプロキシで取得できない場合だけ、ReaderからURL候補を得る。
    // ReaderではXMLのタイトル・日時・画像が失われるため、後段のhydrateItemsFromReaderで記事詳細を補う。
    candidates.push({ url: buildTextProxyUrl(source.url, source), route: "text-proxy" });
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const text = await fetchText(candidate.url, {
        timeoutMs: source.timeoutMs,
        headers: candidate.route === "direct" ? source.headers : undefined
      });
      // HTTP 200でもWAFやプロキシのHTML説明ページが返ることがある。
      // 取得とパースを同じtry内に置き、JSON/XMLとして読めない場合は次の候補へフォールバックする。
      const parsedItems = await source.parse(text, source);
      return { parsedItems, route: candidate.route };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("取得経路がすべて失敗しました");
}

// 外部取得が止まったままにならないよう、媒体ごとのタイムアウトをAbortControllerで保証する。
async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    options.timeoutMs || DEFAULT_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      headers: options.headers || {}
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("取得がタイムアウトしました");
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

// 海外版本体と同じ優先順でRSS項目を読み、カード用データへ変換する。
export function parseFeed(text, source) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("RSSをXMLとして解析できませんでした");

  return [...doc.querySelectorAll("item, entry")].map((entry) => {
    const linkElement = entry.querySelector("link");
    const description = firstValue(
      textOf(entry, "content\\:encoded"),
      textOf(entry, "description"),
      textOf(entry, "summary")
    );
    const thumbnail = firstValue(
      textOf(entry, "image"),
      attrOf(entry, "media\\:content", "url"),
      attrOf(entry, "media\\:thumbnail", "url"),
      attrOf(entry, "enclosure", "url"),
      imageFromHtml(description)
    );

    const categories = [...entry.querySelectorAll("category")].map((element) => cleanText(element.textContent));
    if (source.rssCategory && !categories.includes(source.rssCategory)) return null;

    return {
      title: textOf(entry, "title"),
      url: normalizeProtocol(firstValue(
        linkElement && linkElement.getAttribute("href"),
        linkElement && linkElement.textContent
      ), source),
      publishedAt: firstValue(
        textOf(entry, "pubDate"),
        textOf(entry, "published"),
        textOf(entry, "updated"),
        textOf(entry, "dc\\:date")
      ),
      thumbnail
    };
  }).filter(Boolean);
}

// HTTPS対応済み媒体が古いRSS内だけhttpリンクを返す場合、同一記事の重複と混在コンテンツを防ぐ。
function normalizeProtocol(value, source) {
  return source.forceHttps ? String(value || "").replace(/^http:\/\//i, "https://") : value;
}

// rss2jsonのCORS対応JSONから、共有RSSの指定カテゴリだけを共通記事形式へ変換する。
// 無料APIはRSS先頭の一部だけを返すため、カテゴリ判定はURL推測ではなく公式RSSのcategories完全一致で行う。
export function parseRss2Json(text, source) {
  const data = JSON.parse(String(text || ""));
  if (!data || data.status !== "ok" || !Array.isArray(data.items)) {
    throw new Error("RSS JSONを解析できませんでした");
  }

  return data.items
    .filter((item) => {
      const categories = Array.isArray(item && item.categories) ? item.categories.map(cleanText) : [];
      return !source.rssCategory || categories.includes(source.rssCategory);
    })
    .map((item) => ({
      title: item && item.title,
      // 公式RSSは一部リンクをhttpで返すため、閲覧時のリダイレクトを避けてhttpsへ正規化する。
      url: String(item && item.link || "").replace(/^http:\/\/(www\.)?thoroughbredracing\.com/i, "https://www.thoroughbredracing.com"),
      // rss2jsonのpubDateはタイムゾーンなしUTC表記なので、末尾Zを補ってローカル時刻と誤解釈させない。
      publishedAt: normalizeRss2JsonDate(item && item.pubDate),
      thumbnail: firstValue(item && item.thumbnail, item && item.enclosure && item.enclosure.link)
    }));
}

// `YYYY-MM-DD HH:mm:ss`をUTCのISO互換文字列へ直し、すでにタイムゾーン付きなら元値を維持する。
function normalizeRss2JsonDate(value) {
  const raw = cleanText(value);
  const utc = raw.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/);
  return utc ? `${utc[1]}T${utc[2]}Z` : raw;
}

// Google News Sitemapから見出し・記事URL・公開日時・画像を抽出する。
// XML名前空間の接頭辞は配信元によって変わり得るため、querySelectorの文字列ではなくlocalNameで読む。
// 同じサイトマップに複数カテゴリが混在する場合は、媒体設定のpathHintsで記事URLを絞り込む。
export function parseNewsSitemap(text, source) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) {
    if (!source.allowTextProxy) {
      throw new Error("ニュースサイトマップをXMLとして解析できませんでした");
    }

    // Jina ReaderがSitemapをMarkdown化した場合は記事URLだけが残る。
    // URL以外は推測せず空欄にし、記事詳細Readerで公式メタデータを補完する。
    return [...String(text || "").matchAll(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)]
      .map((match) => match[1])
      .filter((url, index, urls) => urls.indexOf(url) === index && matchesSourcePath(url, source))
      .map((url) => ({ title: "", url, publishedAt: "", thumbnail: "" }));
  }

  return [...doc.getElementsByTagNameNS("*", "url")]
    .map((entry) => {
      const url = textByLocalName(entry, "loc");
      if (!matchesSourcePath(url, source)) return null;

      const newsNode = entry.getElementsByTagNameNS("*", "news")[0];
      const imageNode = entry.getElementsByTagNameNS("*", "image")[0];

      return {
        title: newsNode ? textByLocalName(newsNode, "title") : "",
        url,
        publishedAt: newsNode ? textByLocalName(newsNode, "publication_date") : "",
        thumbnail: imageNode ? textByLocalName(imageNode, "loc") : ""
      };
    })
    .filter(Boolean);
}

// SitemapのReader予備経路でURLしか得られなかった記事を、記事ページのReaderメタデータで補完する。
// すでにXMLから4項目が揃っている記事には追加アクセスせず、欠損候補だけを上限付きで処理する。
async function hydrateItemsFromReader(items, source) {
  const limit = Math.max(1, Number(source.hydrationLimit) || DEFAULT_MAX_ITEMS);
  const candidates = items.slice(0, limit);

  return mapWithConcurrency(candidates, source.hydrationConcurrency || 2, async (item) => {
    if (item.title && item.publishedAt && item.thumbnail) return item;

    try {
      const text = await fetchText(buildTextProxyUrl(item.url, source), { timeoutMs: source.hydrationTimeoutMs });
      const detail = parseReaderArticle(text, item.url);
      return {
        ...item,
        title: item.title || detail.title,
        publishedAt: item.publishedAt || detail.publishedAt,
        thumbnail: item.thumbnail || (source.disableReaderImageFallback ? "" : detail.thumbnail)
      };
    } catch (_error) {
      return null;
    }
  }).then((results) => results.filter(Boolean));
}

// 一覧Readerを媒体ごとに最大数ページだけ取得し、同じ記事URLへ結び付いたカード画像を候補へ装飾する。
// タイトル一致では同名記事や短縮見出しを誤結合するため、URLのorigin+pathname完全一致だけを使う。
async function decorateItemsFromReader(items, source) {
  const decorationByUrl = new Map();

  for (const listingUrl of source.readerDecorationUrls) {
    try {
      const text = await fetchText(buildTextProxyUrl(listingUrl, source), { timeoutMs: source.hydrationTimeoutMs });
      if (typeof source.parseReaderDecoration === "function") {
        source.parseReaderDecoration(text).forEach((item) => {
          if (!isAllowedDecorationImage(item.thumbnail, source)) return;
          const key = canonicalArticleUrl(item.url, source);
          if (key && !decorationByUrl.has(key)) decorationByUrl.set(key, item);
        });
        continue;
      }

      for (const match of String(text || "").matchAll(/\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\]\((https?:\/\/[^)]+)\)/g)) {
        const image = unwrapImageProxyUrl(match[1]);
        const key = canonicalArticleUrl(match[2], source);
        if (!key || !isAllowedDecorationImage(image, source)) continue;
        if (!decorationByUrl.has(key)) decorationByUrl.set(key, { thumbnail: image });
      }
    } catch (_error) {
      // 片方の一覧ページだけ失敗しても、取得できたページの画像で継続する。
      // 必須画像が不足すれば最終の画像カバレッジ判定でテスト不合格になる。
    }
  }

  return items.map((item) => {
    const decoration = decorationByUrl.get(canonicalArticleUrl(item.url, source)) || {};
    return {
      ...item,
      title: item.title || decoration.title || "",
      publishedAt: item.publishedAt || decoration.publishedAt || "",
      thumbnail: item.thumbnail || decoration.thumbnail || ""
    };
  });
}

// Readerのキャッシュ遅延が確認された媒体だけ、取得元URLへ時刻クエリを付けて最新レスポンスを要求する。
// Reader自体のURLへクエリを付けるのではなく、Readerが読む元URLへ付けることが重要。
function buildTextProxyUrl(url, source) {
  if (!source.readerCacheBust) return TEXT_PROXY(url);

  try {
    const parsed = new URL(url);
    parsed.searchParams.set("portal_refresh", String(Date.now()));
    return TEXT_PROXY(parsed.href);
  } catch (_error) {
    return TEXT_PROXY(url);
  }
}

// 媒体専用パーサーが返した画像にも、共通のパス・origin制約を必ず適用する。
function isAllowedDecorationImage(value, source) {
  const image = unwrapImageProxyUrl(value);
  if (!isUsableArticleImage(image)) return false;
  if (source.decorationImagePattern && !source.decorationImagePattern.test(image)) return false;

  if (Array.isArray(source.decorationImageOrigins) && source.decorationImageOrigins.length > 0) {
    try {
      return source.decorationImageOrigins.includes(new URL(image).origin);
    } catch (_error) {
      return false;
    }
  }

  return true;
}

// 東スポ競馬のReader一覧カードから、同じ行の画像・記事URL・完全見出しと直後の日付時刻を読む。
// カードごとの「ニュース / YYYY/MM/DD / 曜日 / HH:mm」という並びだけを対象にし、ランキング欄を除外する。
export function parseTospoReaderCards(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim());
  const items = [];

  lines.forEach((line, index) => {
    const card = line.match(/\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\]\((https?:\/\/tospo-keiba\.jp\/breaking_news\/\d+)\)(?:!\[[^\]]*\]\([^)]+\))?\s*\[([^\]]+)\]\((https?:\/\/tospo-keiba\.jp\/breaking_news\/\d+)\)/i);
    if (!card || !sameArticleUrl(card[2], card[4])) return;

    // Readerでは日時がカード行の後ろへ出力される。次のカードへ到達する前の範囲だけを探索し、
    // 直前カードの日時を一つ後の記事へ誤って割り当てないようにする。
    const nextCardOffset = lines
      .slice(index + 1)
      .findIndex((value) => /tospo-keiba\.jp\/breaking_news\/\d+/i.test(value));
    const endIndex = nextCardOffset === -1 ? index + 8 : index + 1 + nextCardOffset;
    const nearby = lines.slice(index + 1, Math.min(endIndex, index + 8));
    const date = nearby.find((value) => /^20\d{2}\/\d{1,2}\/\d{1,2}$/.test(value));
    const time = nearby.find((value) => /^\d{1,2}:\d{2}$/.test(value));
    if (!date || !time) return;

    items.push({
      title: card[3],
      url: card[4],
      publishedAt: `${date} ${time}`,
      thumbnail: card[1]
    });
  });

  return items;
}

// Irish Racing一覧の通常カードと、画像・本文・時刻が一つのリンクへ圧縮された先頭カードを共通形式へ変換する。
// Sitemap側が見出しと日時を持つため、ここでは記事URLと公式写真だけを厳密に取り出す。
export function parseIrishRacingReaderCards(text) {
  const items = [];
  const raw = String(text || "");

  const standardPattern = /\[!\[[^\]]*\]\((https?:\/\/www\.irishracing\.com\/photo_jpeg\/[^)]+)\)\]\((https?:\/\/www\.irishracing\.com\/news\/[^)]+)\)#{2,6}\s+\[[^\]]+\]\((https?:\/\/www\.irishracing\.com\/news\/[^)]+)\)/gi;
  for (const match of raw.matchAll(standardPattern)) {
    if (canonicalArticleUrl(match[2], { caseInsensitivePath: true }) !== canonicalArticleUrl(match[3], { caseInsensitivePath: true })) continue;
    items.push({ url: match[3], thumbnail: match[1] });
  }

  const compactPattern = /\[!\[[^\]]*\]\((https?:\/\/www\.irishracing\.com\/photo_jpeg\/[^)]+)\)\s*#{2,6}\s*[^\]]+\]\((https?:\/\/www\.irishracing\.com\/news\/[^)]+)\)/gi;
  for (const match of raw.matchAll(compactPattern)) {
    items.push({ url: match[2], thumbnail: match[1] });
  }

  const seen = new Set();
  return items.filter((item) => {
    const key = canonicalArticleUrl(item.url, { caseInsensitivePath: true });
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// DRF一覧では画像と見出しリンクが別行に並ぶため、直前のStoryblok写真を次の記事見出しへ結び付ける。
// 広告画像は記事見出しへ到達する前にリセットされ、/news/記事URL以外には採用しない。
export function parseDrfReaderCards(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim());
  const items = [];
  let pendingImage = "";

  lines.forEach((line) => {
    // Storyblok変換URLには filters:format(webp) の括弧が入るため、行末の閉じ括弧までを貪欲に読む。
    const image = line.match(/^!\[[^\]]*\]\((https?:\/\/a-us\.storyblok\.com\/.+)\)$/i);
    if (image) {
      pendingImage = image[1];
      return;
    }

    const heading = line.match(/^#{2,6}\s+\[([^\]]+)\]\((https?:\/\/www\.drf\.com\/news\/(?!all-news(?:[?#/]|$))[^)]+)\)$/i);
    if (!heading) return;
    if (pendingImage) items.push({ title: heading[1], url: heading[2], thumbnail: pendingImage });
    pendingImage = "";
  });

  return items;
}

// BloodHorse一覧Readerの各カードから、同一URLの写真・完全見出し・米東部の相対公開時刻を抽出する。
// 画像リンクと見出しリンクのURL一致を必須にし、著者リンクや前後カードの写真を誤結合しない。
export function parseBloodHorseReaderCards(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim());
  const items = [];
  let pendingImage = null;

  lines.forEach((line, index) => {
    const imageLink = line.match(/^\*?\s*\[!\[[^\]]*\]\((https?:\/\/cdn-images\.bloodhorse\.com\/[^)]+)\)\]\((https?:\/\/(?:www\.)?bloodhorse\.com\/horse-racing\/articles\/\d+\/[^\s)\"]+)/i);
    if (imageLink) {
      pendingImage = { thumbnail: imageLink[1], url: imageLink[2] };
      return;
    }

    const heading = line.match(/^#{2,6}\s+\[([^\]]+)\]\((https?:\/\/(?:www\.)?bloodhorse\.com\/horse-racing\/articles\/\d+\/[^)]+)\)$/i);
    if (!heading) return;

    const nearbyDate = lines
      .slice(index + 1, index + 9)
      .map((value) => value.replace(/^\*?\s*/, ""))
      .find((value) => /^(Today|Yesterday),\s*\d{1,2}:\d{2}\s*(?:AM|PM)$/i.test(value));
    const publishedAt = parseRelativeDateInTimeZone(nearbyDate, "America/New_York");
    const thumbnail = pendingImage && sameArticleUrl(pendingImage.url, heading[2])
      ? pendingImage.thumbnail
      : "";
    pendingImage = null;

    if (!publishedAt) return;
    items.push({ title: heading[1], url: heading[2], publishedAt, thumbnail });
  });

  return items;
}

// `Today, 7:58 PM`等を指定地域の暦日・時刻として解釈し、絶対時刻のISO文字列へ変換する。
// UTCとの差は対象日のIntl出力から求めるため、米東部の夏時間・標準時間の切替にも追従する。
function parseRelativeDateInTimeZone(value, timeZone) {
  const match = String(value || "").match(/^(Today|Yesterday),\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return "";

  const nowParts = timeZoneParts(new Date(), timeZone);
  const calendarDate = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day));
  if (/^yesterday$/i.test(match[1])) calendarDate.setUTCDate(calendarDate.getUTCDate() - 1);

  let hour = Number(match[2]);
  if (/pm/i.test(match[4]) && hour < 12) hour += 12;
  if (/am/i.test(match[4]) && hour === 12) hour = 0;

  return zonedDateToUtc({
    year: calendarDate.getUTCFullYear(),
    month: calendarDate.getUTCMonth() + 1,
    day: calendarDate.getUTCDate(),
    hour,
    minute: Number(match[3])
  }, timeZone).toISOString();
}

// Dateを指定タイムゾーンの年月日時分へ分解する。
function timeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  return parts;
}

// 指定タイムゾーンの壁時計をUTCへ変換する。初回推定時刻の地域差を差し引いて実時刻を得る。
function zonedDateToUtc(parts, timeZone) {
  const utcGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  const represented = timeZoneParts(utcGuess, timeZone);
  const representedAsUtc = Date.UTC(
    represented.year,
    represented.month - 1,
    represented.day,
    represented.hour,
    represented.minute
  );
  return new Date(utcGuess.getTime() - (representedAsUtc - utcGuess.getTime()));
}

// Jina Readerの記事出力から、ページタイトル・公開日時・最初の実写真を抽出する。
function parseReaderArticle(text, articleUrl) {
  const raw = String(text || "");
  const linkedImage = [...raw.matchAll(/\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\]\((https?:\/\/[^)]+)\)/g)]
    .find((match) => sameArticleUrl(match[2], articleUrl));
  const images = [linkedImage && linkedImage[1], ...[...raw.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)].map((match) => match[1])]
    .filter(Boolean)
    .map(unwrapImageProxyUrl)
    .filter(isUsableArticleImage);

  return {
    title: cleanText((raw.match(/^Title:\s*(.+)$/im) || [])[1]),
    publishedAt: cleanText((raw.match(/^Published Time:\s*(.+)$/im) || [])[1]),
    thumbnail: images[0] || ""
  };
}

// クエリ・hash・末尾スラッシュを除いた記事URLが一致するかを確認する。
function sameArticleUrl(left, right) {
  return canonicalArticleUrl(left) === canonicalArticleUrl(right) && Boolean(canonicalArticleUrl(left));
}

// origin+pathnameだけを結合キーにし、解析パラメータや末尾スラッシュの差を無視する。
function canonicalArticleUrl(value, source = {}) {
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (source.matchByTrailingNumericId) {
      const id = pathname.match(/\/(\d+)$/);
      if (id) return `${parsed.origin}/article-id/${id[1]}`;
    }
    return `${parsed.origin}${source.caseInsensitivePath ? pathname.toLowerCase() : pathname}`;
  } catch (_error) {
    return "";
  }
}

// Next.js画像変換URLのurlクエリに実画像がある場合は、元画像へ戻してホットリンク判定を安定させる。
function unwrapImageProxyUrl(value) {
  try {
    const parsed = new URL(value);
    const nested = parsed.searchParams.get("url");
    return nested ? decodeURIComponent(nested) : parsed.href;
  } catch (_error) {
    return value || "";
  }
}

// ロゴ・SVG・追跡画像を除き、記事カードに使えるHTTP画像だけを残す。
function isUsableArticleImage(value) {
  return isHttpUrl(value) && !/\.svg(?:[?#]|$)|logo|icon|avatar|author|google|facebook|twitter|placeholder|no[-_]?image|transparent|pixel|bookmakers?|\/janus\/|trustarc|consent\.|powered-by|advert|sponsor/i.test(value);
}

// 日本版本体と同じlocalName基準でAtom entryを読み、alternateリンクと画像enclosureを分離する。
export function parseAtom(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("AtomをXMLとして解析できませんでした");

  return [...doc.getElementsByTagNameNS("*", "entry")].map((entry) => {
    const links = [...entry.getElementsByTagNameNS("*", "link")];
    const articleLink =
      links.find((link) => (link.getAttribute("rel") || "alternate") === "alternate") ||
      links.find((link) => link.getAttribute("href"));
    const imageLink = links.find((link) => {
      const rel = link.getAttribute("rel");
      const type = link.getAttribute("type") || "";
      return rel === "enclosure" && type.startsWith("image/");
    });

    return {
      title: textByLocalName(entry, "title"),
      url: articleLink && (articleLink.getAttribute("href") || articleLink.textContent),
      publishedAt: firstValue(textByLocalName(entry, "published"), textByLocalName(entry, "updated")),
      thumbnail: imageLink && imageLink.getAttribute("href")
    };
  });
}

// WordPress RESTの埋込featured mediaから、一覧カードに適した画像サイズを優先して選ぶ。
export function parseWordPressPosts(text) {
  const posts = JSON.parse(text);
  if (!Array.isArray(posts)) throw new Error("WordPress RESTの投稿配列を取得できませんでした");

  return posts.map((post) => {
    const media = post && post._embedded && post._embedded["wp:featuredmedia"]
      ? post._embedded["wp:featuredmedia"][0]
      : null;
    const sizes = media && media.media_details && media.media_details.sizes
      ? media.media_details.sizes
      : {};

    return {
      title: decodeHtml(post && post.title && post.title.rendered),
      url: post && post.link,
      publishedAt: post && post.date_gmt ? `${post.date_gmt}Z` : post && post.date,
      thumbnail: firstValue(
        sizes["indiegraf-post-grid-medium"] && sizes["indiegraf-post-grid-medium"].source_url,
        sizes["post-thumbnail"] && sizes["post-thumbnail"].source_url,
        sizes.medium_large && sizes.medium_large.source_url,
        sizes.medium && sizes.medium.source_url,
        media && media.source_url
      )
    };
  });
}

// The Irish Fieldの第一者JSON APIから、見出し・記事URL・公開日時・S3画像URLを復元する。
// 公開プロキシ不調時にJina ReaderがJSONを説明文付きで返すため、JSON本体だけを安全に切り出す。
export function parseIrishFieldTopic(text) {
  const data = parseJsonPayload(text);
  const articles = data && data.fjapp && Array.isArray(data.fjapp.api)
    ? data.fjapp.api
    : data && Array.isArray(data.api)
      ? data.api
      : [];

  return articles.map((article) => ({
    title: firstValue(article.ctitle, article.title, article.name),
    url: firstValue(article.hspermlink, article.permalink, article.url),
    publishedAt: firstValue(article.releasedate, article.modified, article.date),
    thumbnail: buildIrishFieldImageUrl(article)
  }));
}

// Racing.com公式フロントエンドが利用するGraphQL応答を、カード用の共通形式へ変換する。
export function parseRacingComGraphql(text) {
  const data = parseJsonPayload(text);
  const articles = data && data.data && Array.isArray(data.data.getNewsList)
    ? data.data.getNewsList
    : data && Array.isArray(data.getNewsList)
      ? data.getNewsList
      : [];

  return articles.map((article) => ({
    title: firstValue(article.short_title, article.name, article.title),
    url: firstValue(article.page_url, article.url),
    publishedAt: firstValue(article.article_date, article.published, article.modified),
    thumbnail: firstValue(
      article.image_url,
      article.thumbnail,
      article.image_object && firstValue(article.image_object.src, article.image_object.thumbnail_src),
      article.thumbnail_object && firstValue(article.thumbnail_object.src, article.thumbnail_object.thumbnail_src)
    )
  }));
}

// TTR AusNZのNext.js初期データから、エディション内の実ニュースだけを抽出する。
// 広告型に加えてnormal型の固定ページslugも除外し、記事写真は各pageのcoverImageを優先する。
export function parseTtrAusNzNextData(text) {
  const doc = new DOMParser().parseFromString(String(text || ""), "text/html");
  const script = doc.querySelector("#__NEXT_DATA__");
  const data = script ? JSON.parse(script.textContent) : null;
  if (!data) throw new Error("TTR AusNZのNext.jsデータを解析できませんでした");

  const skipTypes = new Set(["interstitial", "sponsored", "social", "results", "winners", "top20"]);
  const editionNodes = flattenObjectsForSourceTest(data, 20000)
    .filter((node) => node && Array.isArray(node.pages) && (node.date || node.slug || node.publishedAt));
  const items = [];

  editionNodes.forEach((edition) => {
    const editionSlug = edition.slug || edition.date || "";
    // 日付だけのedition.dateよりepochのpublishedAtを優先し、同日版の実公開時刻を保持する。
    const editionDate = firstValue(edition.publishedAt, edition.date);

    edition.pages.forEach((page) => {
      if (!page || !page.headline || !page.slug || skipTypes.has(page.articleType)) return;
      if (isTtrAusNzFixedPage(page.slug)) return;
      const pageEditionSlug = page.editionSlug || editionSlug;
      if (!pageEditionSlug) return;

      items.push({
        title: page.headline,
        url: `/edition/${pageEditionSlug}/${page.slug}`,
        publishedAt: firstValue(page.publishedAt, editionDate),
        thumbnail: firstValue(page.coverImage, edition.coverImage)
      });
    });
  });

  return items.sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt));
}

// TTRのニュース一覧に常設される案内・索引ページをslugで除外する。
function isTtrAusNzFixedPage(slug) {
  return /^(?:job-board|wednesday-trivia|20\d{2}-stallion-parades|daily-news-wrap|debutants|first-season-sire-runners-and-results|thanks-for-reading)$/i.test(String(slug || "")) ||
    /^looking-ahead(?:-|$)/i.test(String(slug || ""));
}

// Next.js JSONを循環なしで深さ優先走査し、記事配列を持つエディション候補を探す。
function flattenObjectsForSourceTest(value, limit) {
  const result = [];
  const stack = [value];

  while (stack.length > 0 && result.length < limit) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    result.push(current);
    Object.values(current).forEach((child) => {
      if (child && typeof child === "object") stack.push(child);
    });
  }

  return result;
}

// Readerのヘッダーより後ろにあるJSONオブジェクトを取り出し、通常JSONと同じパーサーへ渡す。
function parseJsonPayload(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch (_error) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("JSON本文を取得できませんでした");
    return JSON.parse(raw.slice(start, end + 1));
  }
}

// APIが分割保持する画像ディレクトリとファイル名を、配信用S3 URLへ結合する。
function buildIrishFieldImageUrl(article) {
  const direct = firstValue(article.image, article.thumbnail, article.thumbnailUrl, article.mainImage);
  if (direct) return direct;

  const imagePath = firstValue(article.imagePath, article.imagepath, article.TLImagePath, article.path);
  const fileName = firstValue(article.TLThumb, article.tlthumb, article.thumb, article.fileName, article.filename);
  return imagePath && fileName
    ? `https://s3-eu-west-1.amazonaws.com/theirishfield/WEBFILES/${String(imagePath).replace(/^\/+/, "")}${fileName}`
    : "";
}

// 媒体別パーサーの出力を、テストUIが扱う共通形式へ正規化する。
function normalizeItem(item, source) {
  if (!item || typeof item !== "object") return null;
  const title = cleanText(item.title);
  const url = absoluteUrl(item.url, source.baseUrl || source.url);
  const thumbnail = absoluteUrl(item.thumbnail, source.baseUrl || source.url);
  const publishedAt = item.publishedAt ? new Date(item.publishedAt) : null;

  return { title, url, thumbnail, publishedAt };
}

// ブラウザが実際に表示できる画像かを確認し、遅い画像はテスト全体を止めず失敗扱いにする。
function canLoadImage(url, timeoutMs = 8000) {
  if (!isHttpUrl(url)) return Promise.resolve(false);

  return new Promise((resolve) => {
    const image = new Image();
    const timeoutId = window.setTimeout(() => finish(false), timeoutMs);
    let finished = false;

    function finish(result) {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeoutId);
      image.onload = null;
      image.onerror = null;
      resolve(result);
    }

    image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0);
    image.onerror = () => finish(false);
    // 本体カードと同じ条件で検証し、参照元ヘッダーの有無によるテスト差を作らない。
    image.referrerPolicy = "no-referrer";
    image.src = url;
  });
}

function textOf(root, selector) {
  const element = root.querySelector(selector);
  return element ? cleanText(element.textContent) : "";
}

function textByLocalName(root, localName) {
  const element = root.getElementsByTagNameNS("*", localName)[0];
  return element ? cleanText(element.textContent) : "";
}

function attrOf(root, selector, attribute) {
  const element = root.querySelector(selector);
  return element ? element.getAttribute(attribute) || "" : "";
}

function imageFromHtml(value) {
  const match = String(value || "").match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? decodeHtml(match[1]) : "";
}

function cleanText(value) {
  return decodeHtml(value).replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = String(value || "");
  return textarea.value;
}

function absoluteUrl(value, baseUrl) {
  if (!value) return "";
  try {
    return new URL(String(value).trim(), baseUrl).href;
  } catch (_error) {
    return "";
  }
}

// サイトマップ共有時に、設定されたURL断片へ一致する記事だけをテスト対象にする。
function matchesSourcePath(value, source) {
  if (!value) return false;

  let parsed;
  try {
    parsed = new URL(value, source.baseUrl || source.url);
  } catch (_error) {
    return false;
  }

  const path = parsed.pathname.toLowerCase();
  const allowedOrigins = Array.isArray(source.allowedOrigins) ? source.allowedOrigins : [];
  const prefixes = Array.isArray(source.pathPrefixes) ? source.pathPrefixes : [];
  const includes = Array.isArray(source.pathHints) ? source.pathHints : [];
  const excludes = Array.isArray(source.excludePathHints) ? source.excludePathHints : [];

  if (allowedOrigins.length && !allowedOrigins.includes(parsed.origin)) {
    return false;
  }

  if (prefixes.length && !prefixes.some((prefix) => path.startsWith(String(prefix).toLowerCase()))) {
    return false;
  }

  if (includes.length && !includes.some((hint) => path.includes(String(hint).toLowerCase()))) {
    return false;
  }

  // Sitemapが複数種別の記事を含む媒体では、許可する記事パス全体を正規表現で限定する。
  // RegExpにglobal指定があっても前回testのlastIndexを持ち越さないよう、判定前に必ず0へ戻す。
  if (source.articlePathPattern instanceof RegExp) {
    source.articlePathPattern.lastIndex = 0;
    if (!source.articlePathPattern.test(parsed.pathname)) return false;
  }

  return !excludes.some((hint) => path.includes(String(hint).toLowerCase()));
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim()) || "";
}
