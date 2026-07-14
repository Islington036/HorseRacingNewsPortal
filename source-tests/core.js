const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_ITEMS = 8;

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
  const parsedItems = source.hydrateFromReader
    ? await hydrateItemsFromReader(response.parsedItems, source)
    : response.parsedItems;
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
  const routeMatched = !source.requiredRoute || response.route === source.requiredRoute;

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
      routeMatched &&
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
  if (source.allowTextProxy && source.preferTextProxy) {
    candidates.push({ url: TEXT_PROXY(source.url), route: "text-proxy" });
  }
  PROXY_BUILDERS.forEach((buildUrl, index) => {
    candidates.push({ url: buildUrl(source.url), route: `proxy-${index + 1}` });
  });
  if (source.allowTextProxy && !source.preferTextProxy) {
    // Sitemapの生XMLを公開CORSプロキシで取得できない場合だけ、ReaderからURL候補を得る。
    // ReaderではXMLのタイトル・日時・画像が失われるため、後段のhydrateItemsFromReaderで記事詳細を補う。
    candidates.push({ url: TEXT_PROXY(source.url), route: "text-proxy" });
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
      const text = await fetchText(TEXT_PROXY(item.url), { timeoutMs: source.hydrationTimeoutMs });
      const detail = parseReaderArticle(text);
      return {
        ...item,
        title: detail.title || item.title,
        publishedAt: detail.publishedAt || item.publishedAt,
        thumbnail: detail.thumbnail || item.thumbnail
      };
    } catch (_error) {
      return null;
    }
  }).then((results) => results.filter(Boolean));
}

// Jina Readerの記事出力から、ページタイトル・公開日時・最初の実写真を抽出する。
function parseReaderArticle(text) {
  const raw = String(text || "");
  const images = [...raw.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)]
    .map((match) => unwrapImageProxyUrl(match[1]))
    .filter(isUsableArticleImage);

  return {
    title: cleanText((raw.match(/^Title:\s*(.+)$/im) || [])[1]),
    publishedAt: cleanText((raw.match(/^Published Time:\s*(.+)$/im) || [])[1]),
    thumbnail: images[0] || ""
  };
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

// 外部記事の詳細取得を少数並列に抑え、1媒体のテストが配信元へ一斉接続しないようにする。
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
  const prefixes = Array.isArray(source.pathPrefixes) ? source.pathPrefixes : [];
  const includes = Array.isArray(source.pathHints) ? source.pathHints : [];
  const excludes = Array.isArray(source.excludePathHints) ? source.excludePathHints : [];

  if (prefixes.length && !prefixes.some((prefix) => path.startsWith(String(prefix).toLowerCase()))) {
    return false;
  }

  if (includes.length && !includes.some((hint) => path.includes(String(hint).toLowerCase()))) {
    return false;
  }

  return !excludes.some((hint) => path.includes(String(hint).toLowerCase()));
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim()) || "";
}
