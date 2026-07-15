(function () {
    // ===== カスタマイズ用設定 =====
    const CONFIG = {
      DAYS_BACK: 3,
      MIN_DAYS_BACK: 1,
      MAX_DAYS_BACK: 3,
      REQUEST_TIMEOUT_MS: 9000,
      TITLE_HYDRATION_TIMEOUT_MS: 20000,
      CACHE_KEY: "keiba-news-portal-cache-v2",
      SETTINGS_KEY: "keiba-news-portal-settings-v1",
      FALLBACK_THUMBNAIL:
        "data:image/svg+xml;charset=UTF-8," +
        encodeURIComponent(
          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 180'><rect width='320' height='180' fill='#dfe9e0'/><path d='M55 122c35-57 85-72 150-44 22 10 40 13 60 6-18 33-55 51-100 48-45-4-82 5-110 25z' fill='#0e6f4f'/><circle cx='122' cy='63' r='14' fill='#6a5130'/><text x='160' y='156' text-anchor='middle' font-family='sans-serif' font-size='21' fill='#244235'>Keiba News</text></svg>"
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
      SITES: [
        {
          id: "hochi",
          name: "スポーツ報知",
          url: "https://hochi.news/tag/%E7%AB%B6%E9%A6%AC",
          baseUrl: "https://hochi.news",
          parser: "hochi",
          hydrateTruncatedTitles: true,
          titleHydrationLimit: 6
        },
        {
          id: "nikkan",
          name: "日刊スポーツ",
          url: "https://www.nikkansports.com/keiba/atom.xml",
          baseUrl: "https://www.nikkansports.com",
          parser: "atom",
          documentType: "application/xml",
          accept: "application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8"
        },
        {
          id: "tospo",
          name: "東スポ競馬",
          url: "https://tospo-keiba.jp/news",
          sitemapUrl: "https://tospo-keiba.jp/sitemap_news_1.xml",
          readerListingUrls: [
            "https://tospo-keiba.jp/news",
            "https://tospo-keiba.jp/news?page=2"
          ],
          baseUrl: "https://tospo-keiba.jp",
          parser: "tospo",
          readerCacheBust: true
        },
        {
          id: "sanspo",
          name: "サンスポ",
          url: "https://www.sanspo.com/race/keiba/",
          sitemapUrl: "https://www.sanspo.com/feeds/sitemap-race-keiba/?outputType=xml&from=0",
          baseUrl: "https://www.sanspo.com",
          parser: "generic",
          detailHydrationLimit: 8,
          detailHydrationConcurrency: 2
        },
        {
          id: "sponichi",
          name: "スポニチ競馬Web",
          url: "https://keiba.sponichi.co.jp/news",
          baseUrl: "https://keiba.sponichi.co.jp",
          parser: "sponichi",
          hydrateTruncatedTitles: true,
          // 一覧は多くの記事を「...」で省略するため、表示上限相当まで詳細タイトルを補完する。
          // 同時接続は4件に抑え、記事ページと公開プロキシへ過剰な負荷を掛けない。
          titleHydrationLimit: 18,
          titleHydrationConcurrency: 4
        }
      ]
    };

    const I18N = {
      ja: {
        locale: "ja-JP",
        htmlLang: "ja",
        appTitle: "競馬ニュース早見ポータル",
        subtitle: ({ days }) => `主要紙のヘッドラインを${days}日分だけ拾って時系列で確認`,
        searchLabel: "ヘッドライン検索",
        searchPlaceholder: "見出し・媒体名・サイトで検索",
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
        site: "サイト",
        allSites: "全サイト",
        currentFilter: ({ site, search, count }) => `${site}${search ? ` / 検索: ${search}` : ""} / ${count}件`,
        loadingStatus: "取得中",
        loadingMessage: ({ total, days }) => `${total}サイトからヘッドラインを取得しています。表示対象は${days}日以内です。`,
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
        resultSuffix: ({ site, count }) => `${site} 表示 ${count}件`,
        searchSuffix: ({ site, count, days, total }) => `${site}の検索結果 ${count}件 / ${days}日以内の全${total}件`,
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
        emptyState: "表示できるニュースがありません。検索条件を変えるか、更新を試してください。",
        summaryEmpty: "該当サイト",
        storageError: "設定保存に失敗しました",
        cacheError: "キャッシュ保存に失敗しました",
        titleHydrated: "記事ページから見出しを補完しました"
      },
      en: {
        locale: "en-US",
        htmlLang: "en",
        appTitle: "Japanese Horse Racing News Portal",
        subtitle: ({ days }) => `Review Japanese racing headlines from major media for the last ${days} day${days === 1 ? "" : "s"}`,
        searchLabel: "Headline search",
        searchPlaceholder: "Search headline, source, or site",
        refresh: "Refresh",
        refreshing: "Refreshing",
        settings: "Settings",
        darkMode: "Dark mode",
        language: "Display language",
        daysSetting: "Article age",
        dayOption: ({ day }) => `Within ${day} day${day === 1 ? "" : "s"}`,
        currentSettings: ({ days, theme }) => `${days} day${days === 1 ? "" : "s"} / ${theme}`,
        light: "Light",
        dark: "Dark",
        filter: "Filters",
        site: "Site",
        allSites: "All sites",
        currentFilter: ({ site, search, count }) => `${site}${search ? ` / Search: ${search}` : ""} / ${count}`,
        loadingStatus: "Loading",
        loadingMessage: ({ total, days }) => `Fetching headlines from ${total} sites. Showing articles within ${days} day${days === 1 ? "" : "s"}.`,
        completedStatus: "Updated",
        completedMessage: ({ days, count }) => `Showing ${count} article${count === 1 ? "" : "s"} within ${days} day${days === 1 ? "" : "s"}.`,
        noWindowStatus: "No Articles In Range",
        noWindowAfterFetch: ({ days }) => `Fetch completed, but no articles are available within ${days} day${days === 1 ? "" : "s"}.`,
        noWindowMessage: ({ days }) => `No articles within ${days} day${days === 1 ? "" : "s"}. Expand the range or refresh.`,
        failedStatus: "Fetch Failed",
        failedNoItems: "No displayable headlines could be fetched.",
        failedUsingCache: "No new results were fetched, so the previous cache is still shown.",
        partialFailedStatus: "Partial Failure",
        showingStatus: "Showing",
        standbyStatus: "Ready",
        standbyMessage: "Press refresh to fetch the latest headlines.",
        lastUpdated: ({ date }) => date ? `Last updated: ${date}` : "Not updated",
        resultSuffix: ({ site, count }) => `${site} showing ${count}`,
        searchSuffix: ({ site, count, days, total }) => `${site} search results ${count} / ${total} within ${days} day${days === 1 ? "" : "s"}`,
        settingsChangedStatus: "Settings Updated",
        settingsChangedMessage: ({ days }) => `Showing only articles within ${days} day${days === 1 ? "" : "s"}. Refresh if needed.`,
        noExtract: "Could not extract headlines",
        fetchFailed: "Fetch failed",
        timeout: "Request timed out",
        errorPrefix: "Error",
        notePrefix: "Note",
        latestDetected: ({ days, date }) => `No articles within ${days} day${days === 1 ? "" : "s"} (latest detected: ${date})`,
        thumbnailSite: "Thumbnail",
        thumbnailNote: ({ count }) => `${count} article${count === 1 ? "" : "s"} use the fallback image because no thumbnail was found`,
        noImage: "No Image",
        emptyState: "No news to display. Change the search or filters, or refresh.",
        summaryEmpty: "Matching sites",
        storageError: "Failed to save settings",
        cacheError: "Failed to save cache",
        titleHydrated: "Headlines were completed from article pages"
      }
    };

    const SITE_ALL = { id: "all", name: "全サイト" };

  window.JapaneseHorseRacingPortalDefinition = {
    CONFIG,
    I18N,
    SITE_ALL
  };
})();
