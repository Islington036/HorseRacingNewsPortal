const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_ITEMS = 8;

// 本体と同じ公開プロキシ候補を使うが、テストでは選択された1媒体にしかアクセスしない。
const PROXY_BUILDERS = [
  (url) => "https://corsproxy.io/?" + encodeURIComponent(url),
  (url) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
  (url) => "https://api.codetabs.com/v1/proxy/?quest=" + encodeURIComponent(url)
];

// 指定された媒体1件を取得し、記事データと画像の実読込結果をまとめて返す。
export async function runSourceTest(source) {
  if (!source || !source.id || !source.url || typeof source.parse !== "function") {
    throw new Error("テスト媒体の設定が不完全です");
  }

  const response = await fetchAndParseSource(source);
  const parsedItems = response.parsedItems;
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
  const minimumItems = source.minimumItems || 1;
  const minimumImageCoverage = source.minimumImageCoverage ?? 0.75;
  const imageCoverage = itemCount ? loadedImages / itemCount : 0;

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
    passed:
      itemCount >= minimumItems &&
      validTitleLinks === itemCount &&
      (!source.requireDate || datedItems === itemCount) &&
      imageCoverage >= minimumImageCoverage &&
      // URLが配信された画像は全件読めることを要求し、画像URL自体がない記事とは別に判定する。
      loadedImages === thumbnailItems,
    items: checkedItems
  };
}

// CORS対応媒体は直接取得を先に試し、通信またはパース失敗時だけ本体と同じ公開プロキシへ進む。
async function fetchAndParseSource(source) {
  const candidates = [];
  if (source.tryDirect) {
    candidates.push({ url: source.url, route: "direct" });
  }
  PROXY_BUILDERS.forEach((buildUrl, index) => {
    candidates.push({ url: buildUrl(source.url), route: `proxy-${index + 1}` });
  });

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

    return {
      title: textOf(entry, "title"),
      url: firstValue(
        linkElement && linkElement.getAttribute("href"),
        linkElement && linkElement.textContent
      ),
      publishedAt: firstValue(
        textOf(entry, "pubDate"),
        textOf(entry, "published"),
        textOf(entry, "updated"),
        textOf(entry, "dc\\:date")
      ),
      thumbnail
    };
  });
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

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim()) || "";
}
