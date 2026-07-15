(function () {
    // Racing.comはNext.js画面の静的HTMLに記事一覧を含めず、公式フロントエンドがGraphQLから取得している。
    // 公式JSに含まれている公開フロントエンド用キーと同じ経路を使い、GitHub Pages上のブラウザから直接読む。
    const RACING_COM_PUBLIC_API_KEY = "da2-r5s52y73i5c7vi6vxflvfdufsa";
    const RACING_COM_NEWS_QUERY = [
      "query GetNewsList {",
      "  getNewsList(sites: [\"RDC\"], limit: 20) {",
      "    id",
      "    name",
      "    short_title",
      "    description",
      "    article_type",
      "    image_url",
      "    thumbnail",
      "    published",
      "    modified",
      "    article_date",
      "    page_url",
      "    site",
      "    category { label url }",
      "    image_object { width height alt src thumbnail_src }",
      "    thumbnail_object { width height alt src thumbnail_src }",
      "  }",
      "}"
    ].join("\n");
    // Thoroughbred Racingの公式RSSはCORSを許可しないため、CORS対応JSON変換APIをブラウザ直取得の第一経路にする。
    // 元RSS URLも予備経路として残し、カテゴリはRSS由来の名称を完全一致で分離する。
    const THOROUGHBRED_RACING_RSS = "https://www.thoroughbredracing.com/rss.xml";
    const THOROUGHBRED_RACING_RSS_API =
      "https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(THOROUGHBRED_RACING_RSS);
    // Paulick Report本体はDataDomeでブラウザ自動取得を拒否するため、Bing Newsのサイト限定RSSを索引として使う。
    // rss2jsonはCORS許可済みで、抽出時にはBingの転送URLからPaulick Reportの元記事URLへ必ず戻す。
    const PAULICK_REPORT_BING_RSS =
      "https://www.bing.com/news/search?q=site%3Apaulickreport.com&format=rss";
    const PAULICK_REPORT_BING_RSS_API =
      "https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(PAULICK_REPORT_BING_RSS);

    // ===== カスタマイズ用設定 =====
    const CONFIG = {
      DAYS_BACK: 3,
      MIN_DAYS_BACK: 1,
      MAX_DAYS_BACK: 3,
      REQUEST_TIMEOUT_MS: 12000,
      // 全媒体を同時に接続せず、完了順描画を維持したまま公開プロキシへの負荷を抑える。
      SITE_FETCH_CONCURRENCY: 6,
      MAX_ITEMS_PER_SITE: 18,
      ALLOW_UNDATED_LATEST_ITEMS: false,
      UNDATED_ITEMS_PER_SITE: 0,
      // v3ではTDN/ANZを公式RESTへ切り替えたため、旧HTML解析由来の誤った日時キャッシュを引き継がない。
      CACHE_KEY: "international-horse-racing-news-portal-cache-v3",
      SETTINGS_KEY: "international-horse-racing-news-portal-settings-v1",
      FALLBACK_THUMBNAIL:
        "data:image/svg+xml;charset=UTF-8," +
        encodeURIComponent(
          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 180'><rect width='320' height='180' fill='#dfe9e0'/><path d='M48 128c30-48 71-65 125-50 28 8 47 6 82-9-12 33-45 57-91 58-42 1-79 12-116 39z' fill='#0e6f4f'/><circle cx='130' cy='70' r='13' fill='#6a5130'/><text x='160' y='154' text-anchor='middle' font-family='sans-serif' font-size='20' font-weight='700' fill='#244235'>Racing News</text></svg>"
        ).replace(/'/g, "%27"),
      CORS_PROXY(url) {
        return "https://corsproxy.io/?" + encodeURIComponent(url);
      },
      CORS_PROXY_FALLBACKS: [
        (url) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
        (url) => "https://api.codetabs.com/v1/proxy/?quest=" + encodeURIComponent(url)
      ],
      TEXT_PROXY(url) {
        return "https://r.jina.ai/" + url;
      },
      REGIONS: [
        { id: "europe", name: "ヨーロッパ" },
        { id: "america", name: "アメリカ" },
        { id: "australia", name: "オーストラリア" },
        { id: "new-zealand", name: "ニュージーランド" },
        { id: "hong-kong", name: "香港" }
      ],
      // SiteConfigの主な取得制御:
      // tryDirectは公式URLの直接取得、structuredSourcesOnlyは一覧HTMLへの後退禁止、
      // allowEmptyStructuredは正常な0件応答、mergeStructuredSourcesはAPI/RSS併合を表す。
      // allow*/prefer*TextProxyはXML/JSONではなくReaderで読む例外媒体だけに指定する。
      SITES: [
        { id: "racingpost_news", name: "Racing Post News", region: "europe", url: "https://www.racingpost.com/news/", sitemapUrl: "https://www.racingpost.com/sitemaps/news-sitemap.xml", baseUrl: "https://www.racingpost.com", parser: "generic", pathPrefixes: ["/news/"], excludePathHints: ["/news/betting-offers/"], preferTextProxy: true, allowSitemapTextProxy: true, preferSitemapTextProxy: true, readerDetailHydration: true, detailHydrationLimit: 8, detailHydrationConcurrency: 2, detailRequestTimeoutMs: 20000 },
        { id: "racingpost_bloodstock", name: "Racing Post Bloodstock", region: "europe", url: "https://www.racingpost.com/bloodstock/", sitemapUrl: "https://www.racingpost.com/sitemaps/news-sitemap.xml", baseUrl: "https://www.racingpost.com", parser: "generic", pathPrefixes: ["/bloodstock/"], preferTextProxy: true, allowSitemapTextProxy: true, preferSitemapTextProxy: true, readerDetailHydration: true, detailHydrationLimit: 8, detailHydrationConcurrency: 2, detailRequestTimeoutMs: 20000 },
        { id: "attheraces", name: "At The Races", region: "europe", url: "https://www.attheraces.com/news", sitemapUrl: "https://www.attheraces.com/news-sitemap.xml", readerDecorationUrls: ["https://www.attheraces.com/news"], baseUrl: "https://www.attheraces.com", parser: "generic", pathPrefixes: ["/news/"], pathHints: ["/news"], preferTextProxy: true, tryDirect: true },
        { id: "racingtv", name: "Racing TV", region: "europe", url: "https://www.racingtv.com/news/latest", baseUrl: "https://www.racingtv.com", parser: "generic", pathHints: ["/news"], preferTextProxy: true, textProxyOnly: true, maxItems: 8, requestTimeoutMs: 30000 },
        { id: "irishracing", name: "Irish Racing", region: "europe", url: "https://www.irishracing.com/news", sitemapUrl: "https://www.irishracing.com/newssitemap.xml", readerDecorationUrls: ["https://www.irishracing.com/news"], readerDecorationParser: "irishracing", readerDecorationImagePattern: /\/photo_jpeg\//i, readerDecorationImageOrigins: ["https://www.irishracing.com"], baseUrl: "https://www.irishracing.com", parser: "generic", pathPrefixes: ["/news/"], pathHints: ["/news"], caseInsensitivePath: true, matchByTrailingNumericId: true, preferTextProxy: true },
        { id: "dailymail_racing", name: "Daily Mail Racing", region: "europe", url: "https://www.dailymail.com/sport/racing/index.html", feedUrl: "https://www.dailymail.com/sport/racing/index.rss", baseUrl: "https://www.dailymail.com", parser: "generic", pathHints: ["/sport/racing/article-"], allowedHosts: ["dailymail.co.uk"], preferTextProxy: true, tryDirect: true },
        { id: "mirror_racing", name: "Mirror Horse Racing", region: "europe", url: "https://www.mirror.co.uk/sport/horse-racing/", feedUrl: "https://www.mirror.co.uk/sport/horse-racing/?service=rss", baseUrl: "https://www.mirror.co.uk", parser: "generic", pathHints: ["/sport/horse-racing/"], preferTextProxy: true },
        // Sporting Life自身のWeb画面が利用する公開JSON APIを直接読む。
        // CORS許可済みの構造化データなので、Cookie同意画面や公開プロキシの遅延を避けられる。
        { id: "sportinglife_features", name: "Sporting Life Racing", region: "europe", url: "https://www.sportinglife.com/racing/features", apiUrl: "https://www.sportinglife.com/api/content/articles/summary?limit=13&offset=0&basketPath=sl%2Fracing", baseUrl: "https://www.sportinglife.com", parser: "generic", pathHints: ["/racing/news/", "/racing/features/"], tryDirect: true, structuredSourcesOnly: true, exclusiveStructuredJson: true },
        { id: "irishfield_bloodstock", name: "The Irish Field Bloodstock", region: "europe", url: "https://www.theirishfield.ie/ireland/bloodstock/82", apiUrl: "https://api2.theirishfield.ie/v1/channel/topic.php?id=82&level=1&limit=18&offset=0", baseUrl: "https://www.theirishfield.ie", parser: "generic", pathHints: ["/bloodstock/", "/racing/"], includeAnySameHost: true, preferTextProxy: false, allowApiTextProxy: true, preferApiTextProxy: true },
        { id: "tdn_europe", name: "TDN Europe", region: "europe", url: "https://www.thoroughbreddailynews.com/category/news-europe/", apiUrl: "https://www.thoroughbreddailynews.com/wp-json/wp/v2/posts?categories=7479&per_page=20&_embed=1", feedUrl: "https://www.thoroughbreddailynews.com/category/news-europe/feed/", baseUrl: "https://www.thoroughbreddailynews.com", parser: "generic", pathHints: ["/category/news-europe/"], includeAnySameHost: true, tryDirect: true, structuredSourcesOnly: true },
        { id: "trc_racing", name: "Thoroughbred Racing", region: "europe", url: "https://www.thoroughbredracing.com/racing/", apiUrl: THOROUGHBRED_RACING_RSS_API, feedUrl: THOROUGHBRED_RACING_RSS, rssCategory: "Racing", forceHttps: true, baseUrl: "https://www.thoroughbredracing.com", parser: "generic", pathHints: ["/racing/"], includeAnySameHost: true, tryDirect: true, structuredSourcesOnly: true, allowEmptyStructured: true, exclusiveStructuredJson: true, mergeStructuredSources: true },
        { id: "trc_breeding_sales", name: "Thoroughbred Racing Breeding", region: "europe", url: "https://www.thoroughbredracing.com/breeding-and-sales/", apiUrl: THOROUGHBRED_RACING_RSS_API, feedUrl: THOROUGHBRED_RACING_RSS, rssCategory: "Breeding", forceHttps: true, baseUrl: "https://www.thoroughbredracing.com", parser: "generic", pathHints: ["/breeding-and-sales/"], includeAnySameHost: true, tryDirect: true, structuredSourcesOnly: true, allowEmptyStructured: true, exclusiveStructuredJson: true, mergeStructuredSources: true },
        { id: "trc_sales_previews", name: "Thoroughbred Racing Sales", region: "europe", url: "https://www.thoroughbredracing.com/sales-previews/", apiUrl: THOROUGHBRED_RACING_RSS_API, feedUrl: THOROUGHBRED_RACING_RSS, rssCategory: "Sales Previews", forceHttps: true, baseUrl: "https://www.thoroughbredracing.com", parser: "generic", pathHints: ["/sales-previews/"], includeAnySameHost: true, tryDirect: true, structuredSourcesOnly: true, allowEmptyStructured: true, exclusiveStructuredJson: true, mergeStructuredSources: true },
        { id: "bloodhorse", name: "BloodHorse", region: "america", url: "https://www.bloodhorse.com/horse-racing/articles/index", baseUrl: "https://www.bloodhorse.com", parser: "generic", pathHints: ["/horse-racing/articles/"], preferTextProxy: true, textProxyOnly: true },
        { id: "tdn_america", name: "TDN America", region: "america", url: "https://www.thoroughbreddailynews.com/category/news/", apiUrl: "https://www.thoroughbreddailynews.com/wp-json/wp/v2/posts?categories=1&per_page=20&_embed=1", feedUrl: "https://www.thoroughbreddailynews.com/category/news/feed/", baseUrl: "https://www.thoroughbreddailynews.com", parser: "generic", pathHints: ["/category/news/"], includeAnySameHost: true, tryDirect: true, structuredSourcesOnly: true },
        { id: "drf", name: "Daily Racing Form", region: "america", url: "https://www.drf.com/news/all-news", sitemapUrl: "https://www.drf.com/sitemap-news.xml", readerDecorationUrls: ["https://www.drf.com/news/all-news", "https://www.drf.com/news/all-news?page=2"], readerDecorationParser: "drf", readerDecorationImagePattern: /a-us\.storyblok\.com/i, readerDecorationImageOrigins: ["https://a-us.storyblok.com"], baseUrl: "https://www.drf.com", parser: "generic", pathPrefixes: ["/news/"], pathHints: ["/news/"], preferTextProxy: true, tryDirect: true },
        { id: "paulickreport", name: "Paulick Report", region: "america", url: "https://paulickreport.com/news", apiUrl: PAULICK_REPORT_BING_RSS_API, baseUrl: "https://paulickreport.com", parser: "generic", pathHints: ["/news/"], tryDirect: true, structuredSourcesOnly: true, exclusiveStructuredJson: true },
        { id: "racing_com", name: "Racing.com", region: "australia", url: "https://www.racing.com/news/latest-news", apiUrl: "https://graphql.api.racing.com?query=" + encodeURIComponent(RACING_COM_NEWS_QUERY), baseUrl: "https://www.racing.com", parser: "generic", pathHints: ["/news/"], preferTextProxy: false, tryDirect: true, requestHeaders: { "x-api-key": RACING_COM_PUBLIC_API_KEY, "content-type": "application/json;charset=UTF-8" } },
        { id: "racenet", name: "Racenet", region: "australia", url: "https://www.racenet.com.au/news", baseUrl: "https://www.racenet.com.au", parser: "generic", pathHints: ["/news/"], preferTextProxy: true },
        { id: "anzbloodstock", name: "ANZ Bloodstock News", region: "australia", url: "https://www.anzbloodstocknews.com/category/latest-news/", apiUrl: "https://www.anzbloodstocknews.com/wp-json/wp/v2/posts?categories=67&per_page=20&_embed=1", feedUrl: "https://www.anzbloodstocknews.com/category/latest-news/feed/", baseUrl: "https://www.anzbloodstocknews.com", parser: "generic", pathHints: ["/category/latest-news/"], includeAnySameHost: true, preferTextProxy: false, allowTextProxy: false, tryDirect: true, structuredSourcesOnly: true },
        // 元HTMLはブラウザCORSを許可せず公開CORSプロキシも不安定なため、ReaderのMarkdownだけを短く試す。
        // 専用抽出器が/edition/YYYY-MM-DD/配下の個別記事へ限定し、固定ページの混入を防ぐ。
        { id: "ttrausnz", name: "TTR AusNZ", region: "australia", url: "https://www.ttrausnz.com.au/", baseUrl: "https://www.ttrausnz.com.au", parser: "generic", pathHints: ["/edition/", "/news/", "/articles/"], includeAnySameHost: true, preferTextProxy: true, allowTextProxy: true, textProxyOnly: true, requestTimeoutMs: 20000 },
        { id: "theage_racing", name: "The Age Racing", region: "australia", url: "https://www.theage.com.au/sport/racing", baseUrl: "https://www.theage.com.au", parser: "generic", pathHints: ["/sport/racing/"] },
        { id: "thestraight", name: "The Straight", region: "australia", url: "https://thestraight.com.au/", apiUrl: "https://thestraight.com.au/wp-json/wp/v2/posts?per_page=20&_embed=1", feedUrl: "https://thestraight.com.au/feed/", baseUrl: "https://thestraight.com.au", parser: "generic", pathHints: ["/news/", "/racing/", "/bloodstock/"], includeAnySameHost: true, tryDirect: true },
        { id: "loveracing_nz", name: "LOVERACING.NZ", region: "new-zealand", url: "https://loveracing.nz/news/articles/racing", baseUrl: "https://loveracing.nz", parser: "generic", pathHints: ["/news/"], preferTextProxy: true },
        { id: "scmp_racing", name: "SCMP Racing", region: "hong-kong", url: "https://www.scmp.com/sport/racing/news", feedUrl: "https://www.scmp.com/rss/39/feed/", baseUrl: "https://www.scmp.com", parser: "generic", pathHints: ["/sport/racing/"], preferTextProxy: true }
      ]
    };

    const I18N = {
      ja: {
        locale: "ja-JP",
        htmlLang: "ja",
        appTitle: "海外競馬ニュース早見ポータル",
        subtitle: ({ days }) => `欧州・米国・豪州・ニュージーランド・香港の競馬ニュースを${days}日分だけ確認`,
        searchLabel: "ヘッドライン検索",
        searchPlaceholder: "見出し・媒体名・地域・サイトで検索",
        refresh: "更新",
        refreshing: "更新中",
        settings: "設定",
        darkMode: "ダークモード",
        language: "表示言語",
        daysSetting: "取得対象の日数",
        dayOption: ({ day }) => `${day}日以内`,
        currentSettings: ({ days, theme }) => `${days}日以内 / ${theme}`,
        light: "ライト",
        dark: "ダーク",
        filter: "絞り込み",
        region: "地域",
        site: "サイト",
        allRegions: "全地域",
        allSites: "全サイト",
        currentFilter: ({ region, site, search, count }) => `${region} / ${site}${search ? ` / 検索: ${search}` : ""} / ${count}件`,
        loadingStatus: "取得中",
        loadingMessage: ({ total, days }) => `${total}サイトからヘッドラインを取得しています。表示対象は${days}日以内です。`,
        loadingProgress: ({ done, total, site, count }) => `${done}/${total}サイト処理済み: ${site} ${count}件を反映しました。`,
        loadingProgressError: ({ done, total, site }) => `${done}/${total}サイト処理済み: ${site} は取得に失敗しました。`,
        completedStatus: "更新完了",
        completedMessage: ({ days, count }) => `${days}日以内の${count}件を表示しています。`,
        noWindowStatus: "期間内記事なし",
        noWindowAfterFetch: ({ days }) => `取得は完了しましたが、${days}日以内に表示できる記事はありません。`,
        noWindowMessage: ({ days }) => `${days}日以内の記事はありません。日数を広げるか更新してください。`,
        failedStatus: "取得失敗",
        failedNoItems: "表示できるヘッドラインを取得できませんでした。",
        failedUsingCache: "新しい取得結果がないため、前回キャッシュを表示しています。",
        partialFailedStatus: "一部取得失敗",
        showingStatus: "表示中",
        standbyStatus: "待機中",
        standbyMessage: "更新ボタンで最新ヘッドラインを取得します。",
        lastUpdated: ({ date }) => date ? `最終更新: ${date}` : "未更新",
        resultSuffix: ({ filter, count }) => `${filter} 表示 ${count}件`,
        searchSuffix: ({ filter, count, days, total }) => `${filter}の検索結果 ${count}件 / ${days}日以内の全${total}件`,
        settingsChangedStatus: "設定変更",
        settingsChangedMessage: ({ days }) => `${days}日以内の記事だけを表示しています。必要なら更新で再取得できます。`,
        noExtract: "ヘッドラインを抽出できませんでした",
        fetchFailed: "取得に失敗しました",
        timeout: "タイムアウトしました",
        errorPrefix: "エラー",
        notePrefix: "注記",
        latestDetected: ({ days, date }) => `${days}日以内の記事がありません（最新検出: ${date}）`,
        thumbnailSite: "サムネイル",
        thumbnailNote: ({ count }) => `${count}件は画像が見つからないためダミー画像で表示しています`,
        noImage: "No Image",
        dateUnknown: "日時未検出",
        dateEstimatedTitle: ({ date }) => `取得順から仮配置: ${date}`,
        emptyState: "表示できるニュースがありません。検索条件を変えるか、更新を試してください。",
        summaryEmpty: "該当サイト",
        storageError: "設定保存に失敗しました",
        cacheError: "キャッシュ保存に失敗しました",
        regions: {
          europe: "ヨーロッパ",
          america: "アメリカ",
          australia: "オーストラリア",
          "new-zealand": "ニュージーランド",
          "hong-kong": "香港"
        }
      },
      en: {
        locale: "en-US",
        htmlLang: "en",
        appTitle: "International Horse Racing News Portal",
        subtitle: ({ days }) => `Follow horse racing news from Europe, North America, Australia, New Zealand, and Hong Kong from the past ${days} day${days === 1 ? "" : "s"}`,
        searchLabel: "Search headlines",
        searchPlaceholder: "Search headlines, sources, regions, or URLs",
        refresh: "Refresh",
        refreshing: "Refreshing",
        settings: "Settings",
        darkMode: "Dark mode",
        language: "Display language",
        daysSetting: "Time range",
        dayOption: ({ day }) => `Past ${day} day${day === 1 ? "" : "s"}`,
        currentSettings: ({ days, theme }) => `Past ${days} day${days === 1 ? "" : "s"} / ${theme} mode`,
        light: "light",
        dark: "dark",
        filter: "Filters",
        region: "Region",
        site: "Source",
        allRegions: "All regions",
        allSites: "All sources",
        currentFilter: ({ region, site, search, count }) => `${region} / ${site}${search ? ` / Search: "${search}"` : ""} / ${count} result${count === 1 ? "" : "s"}`,
        loadingStatus: "Loading",
        loadingMessage: ({ total, days }) => `Fetching headlines from ${total} sources for the past ${days} day${days === 1 ? "" : "s"}.`,
        loadingProgress: ({ done, total, site, count }) => `${done}/${total} sources processed: added ${count} from ${site}.`,
        loadingProgressError: ({ done, total, site }) => `${done}/${total} sources processed: ${site} failed.`,
        completedStatus: "Updated",
        completedMessage: ({ days, count }) => `Showing ${count} article${count === 1 ? "" : "s"} from the past ${days} day${days === 1 ? "" : "s"}.`,
        noWindowStatus: "No recent articles",
        noWindowAfterFetch: ({ days }) => `Refresh complete, but no articles were found from the past ${days} day${days === 1 ? "" : "s"}.`,
        noWindowMessage: ({ days }) => `No articles from the past ${days} day${days === 1 ? "" : "s"}. Try a wider range or refresh.`,
        failedStatus: "Update failed",
        failedNoItems: "Couldn't fetch any headlines to show.",
        failedUsingCache: "Couldn't fetch new results, so cached headlines are shown.",
        partialFailedStatus: "Some sources failed",
        showingStatus: "Showing",
        standbyStatus: "Ready",
        standbyMessage: "Select Refresh to fetch the latest headlines.",
        lastUpdated: ({ date }) => date ? `Last updated: ${date}` : "Never updated",
        resultSuffix: ({ filter, count }) => `${filter}: ${count} article${count === 1 ? "" : "s"}`,
        searchSuffix: ({ filter, count, days, total }) => `${filter}: ${count} search result${count === 1 ? "" : "s"} out of ${total} article${total === 1 ? "" : "s"} from the past ${days} day${days === 1 ? "" : "s"}`,
        settingsChangedStatus: "Settings updated",
        settingsChangedMessage: ({ days }) => `Showing articles from the past ${days} day${days === 1 ? "" : "s"}. Refresh to fetch the latest results.`,
        noExtract: "No headlines found",
        fetchFailed: "Couldn't fetch this source",
        timeout: "The request timed out",
        errorPrefix: "Error",
        notePrefix: "Note",
        latestDetected: ({ days, date }) => `No articles from the past ${days} day${days === 1 ? "" : "s"} (latest found: ${date})`,
        thumbnailSite: "Images",
        thumbnailNote: ({ count }) => `No thumbnail was found for ${count} article${count === 1 ? "" : "s"}, so fallback images are shown.`,
        noImage: "No image",
        dateUnknown: "Date unknown",
        dateEstimatedTitle: ({ date }) => `Date estimated from the source listing: ${date}`,
        emptyState: "No news to display. Try changing the search or filters, or refresh.",
        summaryEmpty: "Matching sources",
        storageError: "Couldn't save settings",
        cacheError: "Couldn't save cached headlines",
        regions: {
          europe: "Europe",
          america: "North America",
          australia: "Australia",
          "new-zealand": "New Zealand",
          "hong-kong": "Hong Kong"
        }
      }
    };

    const REGION_ALL = { id: "all", name: "すべて" };
    const REGION_OPTIONS = [REGION_ALL, ...CONFIG.REGIONS];
    const SITE_ALL = { id: "all", name: "全サイト" };

  window.InternationalHorseRacingPortalDefinition = {
    CONFIG,
    I18N,
    REGION_ALL,
    REGION_OPTIONS,
    SITE_ALL
  };
})();
