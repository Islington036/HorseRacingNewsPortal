(function () {
  const definition = window.InternationalHorseRacingPortalDefinition;
  const { CONFIG, I18N, REGION_OPTIONS, SITE_ALL } = definition;
  const {
    dedupeByUrl,
    finalizeStructuredSourceItems,
    mapWithConcurrency
  } = window.HorseRacingPortalCore;

    const state = {
      allItems: [],
      errors: [],
      siteLatest: {},
      lastUpdatedAt: null,
      isLoading: false,
      activeRegion: "all",
      activeSite: "all",
      activeDaysBack: CONFIG.DAYS_BACK,
      darkMode: false,
      language: "ja",
      refreshRunId: 0,
      animatedItemIds: new Set(),
      animationClearTimer: null
    };

    const elements = {
      pageTitle: document.querySelector("#pageTitle"),
      subtitle: document.querySelector("#subtitle"),
      refreshButton: document.querySelector("#refreshButton"),
      searchLabel: document.querySelector("#searchLabel"),
      searchInput: document.querySelector("#searchInput"),
      settingsDetails: document.querySelector("#settingsDetails"),
      settingsSummaryLabel: document.querySelector("#settingsSummaryLabel"),
      currentSettingsLabel: document.querySelector("#currentSettingsLabel"),
      darkModeLabel: document.querySelector("#darkModeLabel"),
      darkModeToggle: document.querySelector("#darkModeToggle"),
      languageSettingLabel: document.querySelector("#languageSettingLabel"),
      languageSelect: document.querySelector("#languageSelect"),
      daysSettingLabel: document.querySelector("#daysSettingLabel"),
      daysOptions: document.querySelector("#daysOptions"),
      filterSummaryLabel: document.querySelector("#filterSummaryLabel"),
      currentFilterLabel: document.querySelector("#currentFilterLabel"),
      regionFilterLabel: document.querySelector("#regionFilterLabel"),
      regionTabs: document.querySelector("#regionTabs"),
      siteFilterLabel: document.querySelector("#siteFilterLabel"),
      siteTabs: document.querySelector("#siteTabs"),
      statusLine: document.querySelector("#statusLine"),
      errorList: document.querySelector("#errorList"),
      siteSummary: document.querySelector("#siteSummary"),
      newsList: document.querySelector("#newsList"),
      emptyState: document.querySelector("#emptyState")
    };

    elements.refreshButton.addEventListener("click", refreshAll);
    elements.searchInput.addEventListener("input", render);
    elements.darkModeToggle.addEventListener("change", () => {
      // チェックボックスは見た目だけでなく状態の正本として使い、変更直後にlocalStorageへ保存する。
      state.darkMode = elements.darkModeToggle.checked;
      saveSettings();
      applyTheme();
      renderSettings();
    });
    elements.languageSelect.addEventListener("change", () => {
      // 言語はニュースデータではなく表示設定として扱い、保存後すぐに画面全体の文言を再描画する。
      state.language = normalizeLanguage(elements.languageSelect.value);
      saveSettings();
      render();
    });
    elements.daysOptions.addEventListener("click", (event) => {
      const button = event.target.closest("[data-days]");
      if (!button) return;

      // data-daysはHTML属性なので文字列で来る。範囲外値が混ざっても1〜3日に丸めて扱う。
      state.activeDaysBack = clampDaysBack(button.dataset.days);
      saveSettings();
      render();
      setStatus(t("settingsChangedStatus"), t("settingsChangedMessage", { days: state.activeDaysBack }));
    });
    elements.regionTabs.addEventListener("click", (event) => {
      const button = event.target.closest("[data-region]");
      if (!button) return;
      state.activeRegion = button.dataset.region;
      syncActiveSiteWithRegion();
      saveSettings();
      render();
    });
    elements.siteTabs.addEventListener("click", (event) => {
      const button = event.target.closest("[data-site]");
      if (!button) return;
      state.activeSite = button.dataset.site;
      saveSettings();
      render();
    });
    window.addEventListener("DOMContentLoaded", boot);

    window.InternationalHorseRacingNewsPortal = {
      refresh: refreshAll,
      getSnapshot() {
        return {
          itemCount: state.allItems.length,
          errorCount: state.errors.length,
          lastUpdatedAt: state.lastUpdatedAt && state.lastUpdatedAt.toISOString(),
          activeRegion: state.activeRegion,
          activeSite: state.activeSite,
          activeDaysBack: state.activeDaysBack,
          darkMode: state.darkMode,
          language: state.language
        };
      }
    };

    // 初期表示時にキャッシュを復元し、現在の条件で画面を描画する。
    function boot() {
      loadSettings();
      applyTheme();
      loadCache();
      render();
    }

    // 全サイトの取得を並列実行し、終わった媒体から順に画面へ反映する。
    async function refreshAll() {
      if (state.isLoading) return;

      // 外部からrefresh()を連打された場合でも、古い取得処理が後から画面を書き換えないよう実行IDを進める。
      const runId = state.refreshRunId + 1;
      state.refreshRunId = runId;
      state.isLoading = true;
      state.errors = [];
      state.siteLatest = {};
      state.animatedItemIds.clear();
      setStatus(t("loadingStatus"), t("loadingMessage", { total: CONFIG.SITES.length, days: state.activeDaysBack }));
      elements.refreshButton.disabled = true;
      elements.refreshButton.textContent = t("refreshing");
      renderErrors();

      const previousItems = state.allItems;
      const previousItemIds = new Set(previousItems.map((item) => item.id));
      const completedSiteIds = new Set();
      const fetchedItemsBySite = new Map();
      const failedSiteIds = new Set();
      let completedCount = 0;

      // 取得対象は一括でキューへ入れ、同時接続数だけを制限して公開プロキシの429と連鎖タイムアウトを抑える。
      // 全件完了を待ってから描画するのではなく、各媒体の完了時点で従来どおり途中結果を反映する。
      await mapWithConcurrency(CONFIG.SITES, CONFIG.SITE_FETCH_CONCURRENCY, async (site) => {
        try {
          const items = await fetchSite(site);
          if (runId !== state.refreshRunId) return;

          completedCount += 1;
          completedSiteIds.add(site.id);
          fetchedItemsBySite.set(site.id, items);
          markItemsForAnimation(items, previousItemIds);
          updateSiteLatest(site, items);
          renderIncrementalRefreshProgress(previousItems, completedSiteIds, fetchedItemsBySite, failedSiteIds);
          setStatus(t("loadingStatus"), t("loadingProgress", {
            done: completedCount,
            total: CONFIG.SITES.length,
            site: site.name,
            count: items.length
          }));
        } catch (error) {
          if (runId !== state.refreshRunId) return;

          completedCount += 1;
          completedSiteIds.add(site.id);
          // 一時的な429や抽出失敗の媒体は、途中表示と最終表示で前回分を残すため記録する。
          failedSiteIds.add(site.id);
          state.errors.push({
            site: site.name,
            message: error && error.message ? error.message : String(error)
          });
          renderIncrementalRefreshProgress(previousItems, completedSiteIds, fetchedItemsBySite, failedSiteIds);
          setStatus(t("partialFailedStatus"), t("loadingProgressError", {
            done: completedCount,
            total: CONFIG.SITES.length,
            site: site.name
          }));
        }
      });
      if (runId !== state.refreshRunId) return;

      const fetchedItems = collectFetchedItems(fetchedItemsBySite);
      const preservedFailedItems = getPreservedItemsForFailedSites(previousItems, failedSiteIds);
      const merged = buildMergedItems([...fetchedItems, ...preservedFailedItems]);

      if (fetchedItems.length > 0 && merged.length > 0) {
        // 1件でも新規取得できた場合だけキャッシュを更新する。
        // 失敗媒体の前回分も混ぜて保存し、次回表示で部分失敗だけを理由に記事が消えないようにする。
        state.allItems = merged;
        state.lastUpdatedAt = new Date();
        saveCache();
      } else {
        // 全サイト失敗、または取得結果がすべて表示対象外だった場合は、途中表示で消した可能性のある前回キャッシュを戻す。
        state.allItems = previousItems;
      }

      state.isLoading = false;
      elements.refreshButton.disabled = false;
      elements.refreshButton.textContent = t("refresh");
      render();

      const visibleCount = getDateScopedItems().length;
      if (visibleCount > 0) {
        setStatus(
          state.errors.length > 0 ? t("partialFailedStatus") : t("completedStatus"),
          t("completedMessage", { days: state.activeDaysBack, count: visibleCount })
        );
      } else if (merged.length > 0) {
        setStatus(t("noWindowStatus"), t("noWindowAfterFetch", { days: state.activeDaysBack }));
      } else if (state.allItems.length > 0) {
        setStatus(t("failedStatus"), t("failedUsingCache"));
      } else {
        setStatus(t("failedStatus"), t("failedNoItems"));
      }
    }

    // 取得済みサイトの新データと、未完了または失敗サイトの旧キャッシュを合わせて途中経過を描画する。
    function renderIncrementalRefreshProgress(previousItems, completedSiteIds, fetchedItemsBySite, failedSiteIds) {
      const fetchedItems = collectFetchedItems(fetchedItemsBySite);
      const pendingPreviousItems = previousItems.filter((item) => !completedSiteIds.has(item.sourceId) || failedSiteIds.has(item.sourceId));
      const partialItems = buildMergedItems([...fetchedItems, ...pendingPreviousItems]);

      if (partialItems.length > 0) {
        state.allItems = partialItems;
      }

      render();
    }

    // Map<siteId, items[]> から全記事を平坦化する。Array#flatに頼らず、古めのブラウザでも動く形にする。
    function collectFetchedItems(fetchedItemsBySite) {
      return [...fetchedItemsBySite.values()].reduce((items, siteItems) => items.concat(siteItems), []);
    }

    // 取得失敗した媒体だけ前回分を引き継ぐ。成功媒体は最新データに置き換えるため、古い重複を混ぜない。
    function getPreservedItemsForFailedSites(previousItems, failedSiteIds) {
      if (!failedSiteIds.size) return [];

      // ニュースサイトや公開プロキシは短時間の連続更新で429/タイムアウトになることがある。
      // その場合も「失敗した媒体の記事が消えた」と誤解されないよう、媒体単位で前回表示を保持する。
      return previousItems.filter((item) => failedSiteIds.has(item.sourceId));
    }

    // キャッシュ・途中表示・最終表示で共通する「3日以内保持」「URL重複排除」「新着順」を一箇所にまとめる。
    function buildMergedItems(items) {
      return dedupeByUrl(items)
        .filter(isWithinMaxWindow)
        .sort((a, b) => b.publishedAt - a.publishedAt);
    }

    // 今回の更新で初めて見つかった記事だけ、次回描画時に下から流れ込むアニメーションを付ける。
    function markItemsForAnimation(items, previousItemIds) {
      items.forEach((item) => {
        if (item && item.id && !previousItemIds.has(item.id)) {
          state.animatedItemIds.add(item.id);
        }
      });
    }

    // 「取得成功だが期間内記事なし」を説明する注記用に、媒体ごとの最新検出日時を保存する。
    function updateSiteLatest(site, items) {
      if (!items.length) return;

      const latestItem = items.reduce((latest, item) => !latest || item.publishedAt > latest.publishedAt ? item : latest, null);
      if (latestItem && latestItem.publishedAt) {
        state.siteLatest[site.id] = latestItem.publishedAt.toISOString();
      }
    }

    // 1サイト分のAPI/RSS/HTML候補を順番に試し、最初に抽出できた記事一覧を返す。
    async function fetchSite(site) {
      // sitemapUrl/apiUrl/feedUrl/urlの順で試す。構造化経路があるサイトはHTMLより安定しやすいため優先する。
      // Setで包んでいるのは、設定ミスで同じURLが複数入った場合に無駄な外部アクセスを避けるため。
      // structuredSourcesOnlyの媒体は、API/RSS障害時に一覧HTMLへ落とさない。
      // 一覧HTMLの広告日付やイベント日付を記事日時と誤認して「期間内記事なし」にするより、
      // 取得失敗として前回キャッシュを維持する方が、ユーザーへ正しい状態を伝えられるためである。
      const sourceUrls = [...new Set([
        site.sitemapUrl,
        site.apiUrl,
        site.feedUrl,
        site.structuredSourcesOnly ? null : site.url
      ].filter(Boolean))];
      let lastError = null;
      // API側のページ上限で指定カテゴリが0件でも、後続の完全RSSには記事がある場合がある。
      // 正常な空配列を保持したまま予備経路を試し、予備経路まで失敗した場合だけ0件成功へ戻す。
      let validEmptyStructuredResult = null;
      // 部分件数APIと完全RSSを併用する媒体では、先に成功した結果を捨てずURL重複排除して結合する。
      const mergedStructuredItems = [];

      for (const sourceUrl of sourceUrls) {
        // preferTextProxyは「公式ページHTMLをJina ReaderでMarkdown化したい」サイト向けの指定。
        // API/RSSまでMarkdown化するとJSON/XMLとして扱えなくなるため、site.urlのときだけ元設定を使う。
        const requestSite = {
          ...site,
          // Sitemap/RSS/APIをJina Readerへ渡すとXML/JSON構造がMarkdown化され、空リンク見出しなどのノイズが混ざる。
          // Jinaは公式ページHTMLを読む最後の手段としてだけ使う。
          allowTextProxy:
            sourceUrl === site.url ||
            (sourceUrl === site.sitemapUrl && site.allowSitemapTextProxy) ||
            (sourceUrl === site.apiUrl && site.allowApiTextProxy),
          preferTextProxy:
            sourceUrl === site.url
              ? site.preferTextProxy
              : sourceUrl === site.sitemapUrl
                ? site.preferSitemapTextProxy
                : sourceUrl === site.apiUrl
                  ? site.preferApiTextProxy
                  : false,
          // HTTP 200のエラーページをJSON/RSSとして誤って成功扱いしないよう、候補URLごとの形式を記録する。
          expectedResponseType:
            sourceUrl === site.apiUrl
              ? site.allowApiTextProxy
                ? "json-or-reader"
                : "json"
              : sourceUrl === site.feedUrl || sourceUrl === site.sitemapUrl
                ? sourceUrl === site.sitemapUrl && site.allowSitemapTextProxy
                  ? "xml-or-reader"
                  : "xml"
                : "html",
          // Sitemapを正本にする媒体だけ、一覧Readerからの画像装飾を有効にする。
          // HTMLフォールバック時まで同じ一覧を再取得しないよう、取得元URLごとに設定を絞る。
          readerDecorationUrls: sourceUrl === site.sitemapUrl ? site.readerDecorationUrls || [] : []
        };

        for (const proxyUrl of buildProxyUrls(sourceUrl, requestSite)) {
          try {
            // directFetch用のURLだけはサイト設定の追加ヘッダーを付ける。公開プロキシには余計なヘッダーを渡さない。
            // 現在はRacing.comの公開APIヘッダーが対象で、今後ほかの媒体が追加されても同じ境界を維持する。
            const requestHeaders = proxyUrl === sourceUrl ? site.requestHeaders || {} : {};
            const html = await fetchProxyText(proxyUrl, requestHeaders, requestSite.requestTimeoutMs);
            const items = site.id === "paulickreport" && sourceUrl === site.url
              // Paulick Reportの一覧ページには日付が出ないため、記事詳細ページのメタ情報で公開日時を補完する。
              ? await parsePaulickReportResponse(html, site)
              : await parseSiteResponse(html, requestSite);

            if (items.length > 0) {
              if (site.mergeStructuredSources && sourceUrl !== site.url) {
                // rss2jsonは無料経路で先頭の一部だけを返すため、API成功後も完全RSSまで一度だけ進む。
                // 同じURLを別プロキシで再取得せず、次のsourceUrlへ移るため内側ループを終了する。
                mergedStructuredItems.push(...items);
                break;
              }
              // 1つの取得経路で記事が取れたら、そのサイトは成功扱いにする。
              // 後続プロキシまで回すと同じ記事の再取得が増え、公開プロキシの制限にも引っかかりやすい。
              return items;
            }

            if (site.allowEmptyStructured && sourceUrl !== site.url) {
              // 有効なAPI/RSS応答が0件なら同じURLを別プロキシで取り直さず、次の構造化URLへ進む。
              // APIが先頭10件だけを返しても、次の完全RSSで指定カテゴリを回収できる余地を残す。
              validEmptyStructuredResult = items;
              break;
            }

            // HTTPとしては成功しても抽出0件なら、ユーザーには「取得はしたが読めなかった」と分かるエラーにする。
            lastError = new Error("ヘッドラインを抽出できませんでした");
          } catch (error) {
            // プロキシの403/522、タイムアウト、JSONとして読めない等を最後の失敗理由として保持する。
            // 次の候補URLや次のプロキシが成功すれば、このエラーは表には出さない。
            lastError = error;
          }
        }
      }

      const structuredResult = finalizeStructuredSourceItems(
        mergedStructuredItems,
        validEmptyStructuredResult,
        site.maxItems || CONFIG.MAX_ITEMS_PER_SITE
      );
      if (structuredResult.hasResult) return structuredResult.items;
      throw lastError || new Error(t("noExtract"));
    }

    // Paulick Reportの一覧レスポンスから候補を拾い、個別記事ページのPublished Timeで日時を補完する。
    async function parsePaulickReportResponse(rawText, site) {
      const candidates = extractPaulickReportCandidates(rawText, site)
        // 一覧の先頭に近いほど新しい記事なので、詳細取得数は設定上限までに絞る。
        // すべての記事詳細を読むと公開プロキシに負荷が寄り、更新全体も遅くなる。
        .slice(0, site.detailHydrationLimit || site.maxItems || CONFIG.MAX_ITEMS_PER_SITE);

      if (!candidates.length) return [];

      const hydratedItems = await mapWithConcurrency(
        candidates,
        site.detailHydrationConcurrency || 3,
        (candidate) => hydratePaulickReportCandidate(candidate, site)
      );

      return dedupeByUrl(
        hydratedItems
          .filter(Boolean)
          .map((item, index) => normalizeItem(item, site, index))
          .filter(Boolean)
          .filter((item) => item.title && item.url && item.publishedAt instanceof Date && !Number.isNaN(item.publishedAt.getTime()))
      ).slice(0, site.maxItems || CONFIG.MAX_ITEMS_PER_SITE);
    }

    // Paulick Reportの一覧HTMLまたはJina Markdownから、記事URL・見出し・一覧画像だけを候補として抽出する。
    function extractPaulickReportCandidates(rawText, site) {
      const candidates = [];
      const text = String(rawText || "");

      // Jina Readerでは「View post」リンクの直後に一覧用画像が続く形で出るため、ここから画像付き候補を作る。
      const viewPostPattern = /\[View post:\s*([^\]]+)\]\((https?:\/\/paulickreport\.com\/news\/[^)]+)\)(?:!\[[^\]]*\]\((https?:\/\/[^)]+)\))?/gi;
      for (const match of text.matchAll(viewPostPattern)) {
        const title = cleanTitle(match[1]);
        const url = match[2];
        if (!isLikelyHeadline(title) || !isPaulickReportArticleUrl(url, site)) continue;
        candidates.push({
          title,
          url,
          thumbnail: pickUsableImage(match[3]),
          source: site.name
        });
      }

      // 通常HTML経由で取れた場合の保険。DOMでは日付がないため、ここでも候補だけ作って詳細補完へ回す。
      const doc = new DOMParser().parseFromString(text, "text/html");
      doc.querySelectorAll("a[href*='/news/']").forEach((anchor) => {
        const url = absoluteUrl(anchor.getAttribute("href"), site.baseUrl);
        const title = cleanTitle(anchor.textContent || anchor.getAttribute("aria-label") || anchor.getAttribute("title"));
        if (!isLikelyHeadline(title) || !isPaulickReportArticleUrl(url, site)) return;

        candidates.push({
          title: title.replace(/^View post:\s*/i, ""),
          url,
          thumbnail: pickUsableImage(findImageNear(anchor, site)),
          source: site.name
        });
      });

      return dedupeRawItems(candidates);
    }

    // Paulick Reportのカテゴリ・View All・固定ページを除き、/news/配下の個別記事だけを許可する。
    function isPaulickReportArticleUrl(value, site) {
      const url = absoluteUrl(value, site.baseUrl);
      if (!url || !isCandidateArticleUrl(url, site)) return false;

      try {
        const pathParts = new URL(url).pathname.split("/").filter(Boolean);
        // /news/<category>/<slug> 以上の深さだけを記事扱いする。/news/the-biz のようなカテゴリ導線を落とす。
        return pathParts[0] === "news" && pathParts.length >= 3;
      } catch (_error) {
        return false;
      }
    }

    // Paulick Reportの候補1件について、Jina Readerの個別記事出力から公開日時と実画像を補完する。
    async function hydratePaulickReportCandidate(candidate, site) {
      try {
        const detailText = await fetchText(candidate.url, {
          ...site,
          allowTextProxy: true,
          preferTextProxy: true,
          textProxyOnly: true,
          requestTimeoutMs: site.detailRequestTimeoutMs || site.requestTimeoutMs || CONFIG.REQUEST_TIMEOUT_MS
        });
        const detail = extractPaulickReportDetail(detailText, candidate, site);
        const publishedAt = detail.publishedAt || candidate.publishedAt;

        if (!publishedAt) return null;

        return {
          title: detail.title || candidate.title,
          url: candidate.url,
          publishedAt,
          thumbnail: pickUsableImage(candidate.thumbnail, detail.thumbnail),
          source: site.name
        };
      } catch (_error) {
        // 1記事だけ詳細補完に失敗しても、媒体全体を失敗扱いにしない。
        // 取得できた他の記事でPaulick Report欄を更新できるよう、失敗候補はnullで落とす。
        return null;
      }
    }

    // Jina Readerの個別記事Markdownから、Published Time・本文見出し・代表画像を抜き出す。
    function extractPaulickReportDetail(text, candidate, site) {
      const raw = String(text || "");
      const publishedAt =
        parseDateFromText((raw.match(/^Published Time:\s*(.+)$/im) || [])[1]) ||
        parseDateFromText((raw.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+20\d{2}\s+\d{1,2}:\d{2}\s+(?:AM|PM)\s+EDT\b/i) || [])[0]);
      const title =
        cleanTitle((raw.match(/^Title:\s*(.+)$/im) || [])[1]) ||
        cleanTitle((raw.match(/^#\s+(.+?)(?:\s+-\s+Paulick Report)?$/m) || [])[1]) ||
        candidate.title;

      return {
        title,
        publishedAt,
        thumbnail: pickUsableImage(...extractPaulickReportDetailImages(raw, candidate, site))
      };
    }

    // 個別記事Markdown内の画像から、候補タイトルに近い画像や本文代表画像を優先して返す。
    function extractPaulickReportDetailImages(text, candidate, site) {
      const images = [];
      const imagePattern = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;

      for (const match of text.matchAll(imagePattern)) {
        const alt = cleanWhitespace(match[1]);
        const url = match[2];
        if (!isUsableImageValue(url)) continue;

        // 見出しaltが候補タイトルに近い一覧画像、またはprofile=w2560等の本文代表画像を優先する。
        if (alt && cleanTitle(alt).toLowerCase() === cleanTitle(candidate.title).toLowerCase()) {
          images.unshift(url);
        } else if (/profile=w(?:1536|2560)|ar=4-3|share16-9/i.test(url)) {
          images.push(url);
        }
      }

      // 一覧側で取れた画像を最後の保険として加える。詳細側が広告画像だけだった場合もダミー化を避けやすい。
      images.push(candidate.thumbnail);
      return images.map((image) => absoluteUrl(image, site.baseUrl));
    }

    // 取得したレスポンスをJSON/XML/HTMLとして解釈し、サイト設定に応じた抽出結果へ正規化する。
    async function parseSiteResponse(html, site) {
      // BOMを除去して先頭判定を安定させる。公開プロキシがXML宣言の前へBOMを付けてもRSSとして扱える。
      const responseText = String(html || "").replace(/^\uFEFF/, "");
      // WordPress RESTやRacing TV APIなど、レスポンス全体がJSONの場合はここでオブジェクト化する。
      // JSONでない場合はnullのままにして、HTML/XMLとしてDOMParserへ渡す。
      const json = safeJsonParse(responseText) ||
        (site.expectedResponseType === "json-or-reader" ? parseReaderWrappedJson(responseText) : null);
      if (site.expectedResponseType === "json" && !json) {
        // API URLがWAFやプロキシのHTMLエラーページを200で返した場合、汎用HTML抽出へ流さず次の経路へ進む。
        throw new Error("APIレスポンスをJSONとして解析できませんでした");
      }
      if (site.expectedResponseType === "json-or-reader" && !json) {
        throw new Error("APIレスポンスからJSON本文を解析できませんでした");
      }
      // RSS/AtomはHTMLパーサーで読むとitem/pubDate等の扱いが崩れるため、XMLとして読む。
      const isXml = !json && /^\s*(<\?xml|<rss|<feed)/i.test(responseText);
      if (site.expectedResponseType === "xml" && !isXml) {
        // RSS URLからHTMLや空本文が返った場合も、記事候補の誤抽出を避けて別プロキシへフォールバックする。
        throw new Error("RSSレスポンスをXMLとして解析できませんでした");
      }
      // JSONサイトでも後段の関数シグネチャを揃えるため、空のHTML Documentを作って渡す。
      // これにより「docを使う抽出」と「dataを使う抽出」を同じparser配列で扱える。
      const doc = json
        ? new DOMParser().parseFromString("<!doctype html><html><body></body></html>", "text/html")
        : new DOMParser().parseFromString(responseText, isXml ? "application/xml" : "text/html");
      if (isXml && doc.querySelector("parsererror")) {
        // 先頭がXMLでも本文が壊れているケースを明示的に失敗させ、空配列による原因不明表示を防ぐ。
        throw new Error("RSSレスポンスをXMLとして解析できませんでした");
      }
      const parser = PARSERS[site.parser] || PARSERS.generic;
      let rawItems = parser(doc, site, responseText, json);
      if (site.readerDecorationUrls && site.readerDecorationUrls.length > 0) {
        // Sitemapのタイトル・日時・URLは維持し、一覧カードと完全URL一致した画像だけを補う。
        // タイトル一致は同名記事や省略見出しの誤結合を起こすため使用しない。
        rawItems = await decorateRawItemsFromReader(rawItems, site);
      }
      if (site.readerDetailHydration) {
        rawItems = await hydrateReaderDetailItems(rawItems, site);
      }
      return dedupeByUrl(
        rawItems
          // 各抽出器が返すバラバラの形式を、sourceId/region/thumbnail付きの共通形式へ変換する。
          .map((item, index) => normalizeItem(item, site, index))
          // 日付がDateとして確定しない記事は、3日以内判定ができないためここで落とす。
          .filter(Boolean)
          .filter((item) => item.title && item.url && item.publishedAt instanceof Date && !Number.isNaN(item.publishedAt.getTime()))
      ).slice(0, site.maxItems || CONFIG.MAX_ITEMS_PER_SITE);
    }

    // 構造化経路の記事へ、一覧Readerに存在する同一URLカードの不足項目を装飾する。
    // 一覧の片方が失敗しても取得済みページで継続し、画像欠損は既存ダミー表示へ委ねる。
    async function decorateRawItemsFromReader(items, site) {
      const decorationByUrl = new Map();

      for (const listingUrl of site.readerDecorationUrls) {
        try {
          const text = await fetchText(listingUrl, {
            ...site,
            allowTextProxy: true,
            preferTextProxy: true,
            textProxyOnly: true,
            requestTimeoutMs: site.detailRequestTimeoutMs || CONFIG.REQUEST_TIMEOUT_MS
          });
          extractReaderDecorationItems(text, site).forEach((item) => {
            const key = canonicalArticleUrl(item.url, site);
            if (!key || decorationByUrl.has(key)) return;
            decorationByUrl.set(key, item);
          });
        } catch (_error) {
          // 装飾は補助経路。Sitemap本体が取得できていれば、写真なし記事として安全に表示を続ける。
        }
      }

      return items.map((item) => {
        const decoration = decorationByUrl.get(canonicalArticleUrl(item.url, site)) || {};
        return {
          ...item,
          title: item.title || decoration.title || "",
          publishedAt: item.publishedAt || decoration.publishedAt || null,
          thumbnail: item.thumbnail || decoration.thumbnail || ""
        };
      });
    }

    // 一覧Readerから記事URLに直接結び付いた画像を抽出する。
    // Irish Racingのように専用パーサーが既にある媒体は、その結果を同じURL結合形式へ再利用する。
    function extractReaderDecorationItems(text, site) {
      if (site.readerDecorationParser === "irishracing") {
        return extractIrishRacingMarkdownItems(text, site).filter((item) => isAllowedDecorationImage(item.thumbnail, site));
      }
      if (site.readerDecorationParser === "drf") {
        return extractDrfReaderDecorationItems(text, site);
      }

      const items = [];
      for (const match of String(text || "").matchAll(/\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\]\((https?:\/\/[^)]+)\)/g)) {
        const thumbnail = unwrapImageProxyUrl(match[1]);
        const url = match[2];
        if (!isCandidateArticleUrl(url, site) || !isAllowedDecorationImage(thumbnail, site)) continue;
        items.push({ url, thumbnail });
      }
      return items;
    }

    // DRFのReader一覧は写真と見出しが別行なので、直前のStoryblok写真を次の記事URLへ結び付ける。
    // 記事詳細のOG画像は共通ロゴになる場合があるため、一覧で確認できた写真以外は補完しない。
    function extractDrfReaderDecorationItems(text, site) {
      const lines = String(text || "").split(/\r?\n/).map((line) => line.trim());
      const items = [];
      let pendingImage = "";

      lines.forEach((line) => {
        const image = line.match(/^!\[[^\]]*\]\((https?:\/\/a-us\.storyblok\.com\/.+)\)$/i);
        if (image) {
          pendingImage = image[1];
          return;
        }

        const heading = line.match(/^#{2,6}\s+\[([^\]]+)\]\((https?:\/\/www\.drf\.com\/news\/(?!all-news(?:[?#/]|$))[^)]+)\)$/i);
        if (!heading) return;
        if (pendingImage && isAllowedDecorationImage(pendingImage, site)) {
          items.push({ title: heading[1], url: heading[2], thumbnail: pendingImage });
        }
        pendingImage = "";
      });

      return items;
    }

    // 媒体設定で画像originやパスを限定できるようにし、ロゴ・広告・別記事画像の混入を防ぐ。
    function isAllowedDecorationImage(value, site) {
      const image = absoluteUrl(unwrapImageProxyUrl(value), site.baseUrl);
      if (!isUsableImageUrl(image)) return false;
      if (site.readerDecorationImagePattern && !site.readerDecorationImagePattern.test(image)) return false;

      const allowedOrigins = site.readerDecorationImageOrigins || [];
      if (allowedOrigins.length > 0) {
        try {
          return allowedOrigins.includes(new URL(image).origin);
        } catch (_error) {
          return false;
        }
      }
      return true;
    }

    // 解析クエリ・hash・末尾スラッシュを除いたorigin+pathnameを、一覧との安全な結合キーにする。
    function canonicalArticleUrl(value, site = {}) {
      try {
        const parsed = new URL(value);
        const pathname = parsed.pathname.replace(/\/+$/, "");
        if (site.matchByTrailingNumericId) {
          const id = pathname.match(/\/(\d+)$/);
          if (id) return `${parsed.origin}/article-id/${id[1]}`;
        }
        return `${parsed.origin}${site.caseInsensitivePath ? pathname.toLowerCase() : pathname}`;
      } catch (_error) {
        return "";
      }
    }

    // Jina ReaderがAPI JSONの前へ説明ヘッダーを付けた場合に、最外のJSON本文だけを復元する。
    // HTMLや任意テキストをJSONとして誤認しないよう、最初の{から最後の}までをJSON.parseできた場合だけ採用する。
    function parseReaderWrappedJson(value) {
      const raw = String(value || "");
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      return safeJsonParse(raw.slice(start, end + 1));
    }

    // 任意URLを設定済みプロキシ経由で取得し、テキスト本文だけを返す補助関数。
    async function fetchText(url, site = {}) {
      let lastError = null;

      for (const proxyUrl of buildProxyUrls(url, site)) {
        try {
          return await fetchProxyText(proxyUrl, {}, site.requestTimeoutMs);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error(t("fetchFailed"));
    }

    // CORS制限を避けるために試行するプロキシURLの優先順を組み立てる。
    function buildProxyUrls(url, site = {}) {
      // Racing TVのように公式APIを直に試すサイトだけ、最初に元URLを入れる。
      // 通常サイトはブラウザCORSで止まるため、公開プロキシ/Jina Readerを先に使う。
      const directUrls = site.tryDirect ? [url] : [];

      // HTML向けプロキシは元HTML・RSS・JSONをなるべくそのまま返す経路。
      // corsproxy.ioが無料制限で落ちる場合もあるので、AllOriginsとCodeTabsを後続に置く。
      const htmlProxyUrls = [
        CONFIG.CORS_PROXY(url),
        ...CONFIG.CORS_PROXY_FALLBACKS.map((buildUrl) => buildUrl(url))
      ];

      // Jina ReaderはHTMLをMarkdown化する経路。動的サイトや403サイトの代替として有効。
      // RSS/APIではタイトルや日時の構造が壊れることがあるため、allowTextProxy=falseなら完全に候補から外す。
      const textProxyUrls = site.allowTextProxy === false ? [] : [CONFIG.TEXT_PROXY(url)];
      if (site.textProxyOnly) {
        // Racing TVのように公開CORSプロキシが長時間失敗しやすいサイトは、Jinaだけを短く試す。
        // HTML/APIプロキシへ落とすと更新全体がタイムアウト待ちに引っ張られるため、設定で明示的に絞る。
        return textProxyUrls;
      }

      // preferTextProxyがtrueのサイトは、HTMLよりJina Markdownの方が抽出しやすい。
      // falseのサイトは、RSS/API/構造化HTMLを優先してからMarkdownに落とす。
      return site.preferTextProxy
        ? [...directUrls, ...textProxyUrls, ...htmlProxyUrls]
        : [...directUrls, ...htmlProxyUrls, ...textProxyUrls];
    }

    // 1つのプロキシURLから本文を取得し、HTTPエラーやタイムアウトを例外化する。
    async function fetchProxyText(proxyUrl, requestHeaders = {}, timeoutMs = CONFIG.REQUEST_TIMEOUT_MS) {
      const controller = new AbortController();
      // サイト別に待機時間を上書きできるようにする。通常は全体設定を使い、
      // Racing TVのようにReader経由の初回応答が遅いサイトだけ個別に延長する。
      const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

      try {
        // サイト側APIに追加ヘッダーが必要な場合は、既定Acceptよりサイト設定を優先する。
        const headers = {
          Accept: "application/json,text/html,application/xhtml+xml,text/markdown,text/plain,application/xml;q=0.9,*/*;q=0.8",
          ...requestHeaders
        };

        const response = await fetch(proxyUrl, {
          credentials: "omit",
          signal: controller.signal,
          headers
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        return await response.text();
      } catch (error) {
        if (error.name === "AbortError") {
          throw new Error(t("timeout"));
        }
        throw error;
      } finally {
        window.clearTimeout(timeoutId);
      }
    }

    const PARSERS = {
      generic(doc, site, rawText, data) {
        return dedupeRawItems([
          ...extractSiteSpecificItems(doc, site, rawText, data),
          // カテゴリ分離を担う専用API抽出器がある媒体は、同じJSONを汎用走査へ二重投入しない。
          // rss2json全体を再走査すると、共有RSSの別カテゴリ記事まで当該サイトへ混入するためである。
          ...extractStructuredJsonItems(site.exclusiveStructuredJson ? null : data, site),
          ...extractNewsSitemapItems(doc, site, rawText),
          ...extractFeedItems(doc, site),
          ...extractMarkdownItems(rawText, site),
          ...extractJsonLdItems(doc, site),
          ...extractStructuredScriptItems(doc, site),
          ...extractAnchorsWithTimeElements(doc, site),
          ...extractArticleCards(doc, site)
        ]);
      }
    };

    // Google News Sitemapを共通形式へ変換する。
    // 接頭辞（news/image）は配信側の都合で変わり得るため、名前空間に依存しないlocalName検索を使う。
    // URLのカテゴリ判定はnormalizeItem内のisCandidateArticleUrlでも再確認し、共有Sitemapの他競技を除外する。
    function extractNewsSitemapItems(doc, site, rawText) {
      const xmlItems = [...doc.getElementsByTagNameNS("*", "url")].map((entry) => {
        const url = textByLocalName(entry, "loc");
        const newsNode = entry.getElementsByTagNameNS("*", "news")[0];
        if (!url || !newsNode || !isCandidateArticleUrl(url, site)) return null;

        const imageNode = entry.getElementsByTagNameNS("*", "image")[0];
        return {
          title: textByLocalName(newsNode, "title"),
          url,
          publishedAt: parseDate(textByLocalName(newsNode, "publication_date")),
          thumbnail: imageNode ? textByLocalName(imageNode, "loc") : "",
          source: site.name
        };
      }).filter(Boolean);

      if (xmlItems.length || !site.allowSitemapTextProxy) return xmlItems;

      // ReaderはSitemapのタイトル・日時・画像を落とすため、ここではURL候補だけを作る。
      // 欠損項目はhydrateReaderDetailItemsが記事ページの公式メタデータから補完する。
      return [...String(rawText || "").matchAll(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)]
        .map((match) => match[1])
        .filter((url, index, urls) => urls.indexOf(url) === index && isCandidateArticleUrl(url, site))
        .map((url) => ({ title: "", url, publishedAt: null, thumbnail: "", source: site.name }));
    }

    // XML名前空間の接頭辞に左右されず、指定localNameの先頭要素から文字列を取り出す。
    function textByLocalName(root, localName) {
      const element = root && root.getElementsByTagNameNS("*", localName)[0];
      return element ? cleanWhitespace(element.textContent) : "";
    }

    // Reader経由のSitemapでURLしか残らなかった候補を、記事ページのメタデータで上限付き補完する。
    async function hydrateReaderDetailItems(items, site) {
      const limit = site.detailHydrationLimit || site.maxItems || CONFIG.MAX_ITEMS_PER_SITE;
      const candidates = items.slice(0, limit);

      const hydrated = await mapWithConcurrency(
        candidates,
        site.detailHydrationConcurrency || 2,
        async (item) => {
          if (item.title && item.publishedAt && item.thumbnail) return item;

          try {
            const detailText = await fetchText(item.url, {
              ...site,
              allowTextProxy: true,
              preferTextProxy: true,
              textProxyOnly: true,
              requestTimeoutMs: site.detailRequestTimeoutMs || CONFIG.REQUEST_TIMEOUT_MS
            });
            const detail = extractReaderArticleMetadata(detailText);
            return {
              ...item,
              // SitemapやRSSの値を正本とし、Reader詳細は欠損項目だけに使う。
              title: item.title || detail.title,
              publishedAt: item.publishedAt || detail.publishedAt,
              thumbnail: item.thumbnail || detail.thumbnail
            };
          } catch (_error) {
            return null;
          }
        }
      );

      return hydrated.filter(Boolean);
    }

    // Jina Readerの記事出力からTitle、Published Time、最初の実写真を取り出す。
    function extractReaderArticleMetadata(text) {
      const raw = String(text || "");
      const images = [...raw.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)]
        .map((match) => unwrapImageProxyUrl(match[1]))
        .filter(isUsableImageValue);

      return {
        title: cleanTitle((raw.match(/^Title:\s*(.+)$/im) || [])[1]),
        publishedAt: parseDate((raw.match(/^Published Time:\s*(.+)$/im) || [])[1]),
        thumbnail: images[0] || ""
      };
    }

    // Next.jsの画像変換URLに元画像URLが埋め込まれている場合は、配信元画像へ戻す。
    function unwrapImageProxyUrl(value) {
      try {
        const parsed = new URL(value);
        const nested = parsed.searchParams.get("url");
        return nested ? decodeURIComponent(nested) : parsed.href;
      } catch (_error) {
        return value || "";
      }
    }

    // 汎用抽出だけでは拾いにくいサイトを、サイトIDごとの専用ロジックへ振り分ける。
    function extractSiteSpecificItems(doc, site, rawText, data) {
      // Racing PostはNext.jsの初期JSONに記事カードが入り、画像はURLではなくimage_idで持つ。
      // 汎用Markdown抽出だけだとロゴや鍵アイコンを拾うことがあるため、専用抽出を先に走らせる。
      if (site.id === "racingpost_news" || site.id === "racingpost_bloodstock") return extractRacingPostNextDataItems(doc, site);
      // Racing TV公式APIは公式Origin以外のブラウザfetchで読めないため、静的HTMLではJina Readerを予備経路にする。
      // 将来APIリレーを用意した場合に備え、API用抽出関数も残して同じURL重複排除へ流す。
      if (site.id === "racingtv") return [...extractRacingTvApiItems(data, site), ...extractRacingTvMarkdownItems(rawText, site)];
      // At The RacesはJina Reader経由だと記事リンクが落ちるため、見出しと日付から公式URL形式を復元する。
      if (site.id === "attheraces") return extractAtTheRacesMarkdownItems(rawText, site);
      // 以下はHTML構造やAPIレスポンスが一般的なarticle抽出とずれるサイトだけ、専用関数で先に拾う。
      // 専用抽出で漏れた記事はPARSERS.generic側のJSON-LD/Feed/Markdown/カード抽出が引き続き拾う。
      if (site.id === "irishracing") return [...extractIrishRacingItems(doc, site), ...extractIrishRacingMarkdownItems(rawText, site)];
      if (site.id === "sportinglife_features") return extractSportingLifeItems(doc, site, data);
      if (site.id === "irishfield_bloodstock") return [...extractIrishFieldApiItems(data, site), ...extractIrishFieldItems(doc, site)];
      // Thoroughbred Racingの3画面は同じ公式RSSを共有するため、JSON変換APIでもRSSでもcategory完全一致で分離する。
      // APIに当該カテゴリが0件なら空配列を正常結果として返し、別カテゴリの記事を混ぜない。
      if (["trc_racing", "trc_breeding_sales", "trc_sales_previews"].includes(site.id)) {
        return extractThoroughbredRacingRssJsonItems(data, site);
      }
      // 本体がDataDomeで自動取得を拒否するPaulick Reportは、Bing News RSSの索引から元記事URLを復元する。
      if (site.id === "paulickreport") return extractPaulickReportBingItems(data, site);
      if (site.id === "ttrausnz") return [...extractTtrAusNzItems(doc, site, data), ...extractTtrAusNzMarkdownItems(rawText, site)];
      // TDN、ANZ Bloodstock、The Straightは同じWordPress REST形式なので、共通抽出器へまとめる。
      // TDNはRSSを予備経路として残しており、RSSレスポンス時はdataがnullになるため空配列を返す。
      // その場合もPARSERS.generic側のextractFeedItemsが続けてRSSを抽出する。
      if (["tdn_europe", "tdn_america", "anzbloodstock", "thestraight"].includes(site.id)) {
        return extractWordPressApiItems(data, site);
      }
      if (site.id === "bloodhorse") return [...extractBloodHorseItems(doc, site), ...extractBloodHorseReaderItems(rawText, site)];
      if (site.id === "racing_com") return [...extractRacingComGraphqlItems(data, site), ...extractRacingComMarkdownItems(rawText, site)];
      if (site.id === "racenet") return extractRacenetMarkdownItems(rawText, site);
      return [];
    }

    // rss2jsonのCORS対応レスポンスから、指定された公式RSSカテゴリの記事だけを抽出する。
    // pubDateはタイムゾーンなしUTC文字列なので末尾Zを補い、閲覧端末のローカル時刻として誤解釈させない。
    function extractThoroughbredRacingRssJsonItems(data, site) {
      if (!data) return [];
      if (data.status !== "ok" || !Array.isArray(data.items)) {
        // JSONとしては読めてもAPI側エラーの場合、0件成功にはせず公式RSSの予備経路へ進める。
        throw new Error("Thoroughbred Racing RSS APIの応答を解析できませんでした");
      }

      return data.items
        .filter((item) => {
          const categories = Array.isArray(item && item.categories)
            ? item.categories.map(cleanWhitespace)
            : [];
          return !site.rssCategory || categories.includes(site.rssCategory);
        })
        .map((item) => {
          return {
            title: item && item.title,
            url: String(item && item.link || "").replace(/^http:\/\/(www\.)?thoroughbredracing\.com/i, "https://www.thoroughbredracing.com"),
            publishedAt: parseRss2JsonUtcDate(item && item.pubDate),
            thumbnail: pickFirst(item && item.thumbnail, item && item.enclosure && item.enclosure.link),
            source: site.name
          };
        })
        .filter((item) => item.title && item.url && item.publishedAt && isCandidateArticleUrl(item.url, site));
    }

    // Bing Newsのサイト限定RSS JSONから、Paulick Reportの元記事だけを取り出す。
    // BingクリックURLは表示リンクに使わず、urlクエリに格納された公式URLへ戻してから厳格に検証する。
    function extractPaulickReportBingItems(data, site) {
      if (!data) return [];
      if (data.status !== "ok" || !Array.isArray(data.items)) {
        throw new Error("Paulick Report RSS索引の応答を解析できませんでした");
      }

      return data.items
        .map((item) => {
          const url = unwrapBingNewsArticleUrl(item && item.link);
          return {
            title: item && item.title,
            url,
            publishedAt: parseRss2JsonUtcDate(item && item.pubDate),
            // rss2jsonがNews:Imageを保持しない記事は、既存のダミー画像表示へ安全に委ねる。
            thumbnail: pickFirst(item && item.thumbnail, item && item.enclosure && item.enclosure.link),
            source: site.name
          };
        })
        .filter((item) => item.title && item.publishedAt && isPaulickReportArticleUrl(item.url, site))
        .sort((left, right) => right.publishedAt - left.publishedAt);
    }

    // Bing Newsのapiclick URLに埋め込まれた配信元URLをデコードする。
    function unwrapBingNewsArticleUrl(value) {
      try {
        const url = new URL(String(value || ""));
        if (!/(^|\.)bing\.com$/i.test(url.hostname)) return "";
        return url.searchParams.get("url") || "";
      } catch (_error) {
        return "";
      }
    }

    // rss2jsonのタイムゾーンなし日時はUTCとして扱う。媒体ごとの重複実装を避ける共通変換器。
    function parseRss2JsonUtcDate(value) {
      const raw = cleanWhitespace(value);
      const utcDate = raw.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/);
      return parseDate(utcDate ? `${utcDate[1]}T${utcDate[2]}Z` : raw);
    }

    // Racing PostのNext.js初期データから、記事カードと実写真URLを復元する。
    function extractRacingPostNextDataItems(doc, site) {
      const script = doc.querySelector("#__NEXT_DATA__");
      const data = script ? safeJsonParse(script.textContent) : null;
      if (!data) return [];

      return flattenJsonObjects(data, 18000)
        .map((node) => {
          const title = pickFirst(node.headline, node.title, node.shortHeadline, node.seoTitle);
          const url = pickFirst(node.path, node.url, node.canonicalUrl, node.href);
          const publishedAt = parseRacingPostTimestamp(
            pickFirst(
              node.publishedAtTimestamp,
              node.displayPublishedAtTimestamp,
              node.published_at_timestamp,
              node.publishedAt,
              node.datePublished,
              node.updatedAt
            )
          );

          if (!title || !url || !publishedAt || !isCandidateArticleUrl(url, site)) return null;

          return buildRawNewsItem(site, {
            title,
            url,
            publishedAt,
            thumbnail: buildRacingPostImageUrl(node)
          });
        })
        .filter(Boolean);
    }

    // Racing Postの数値タイムスタンプ文字列をDateへ変換する。
    function parseRacingPostTimestamp(value) {
      if (value === undefined || value === null || value === "") return null;
      if (typeof value === "number") return parseDate(value);
      if (/^\d{10,13}$/.test(String(value).trim())) return parseDate(Number(value));
      return parseDate(value);
    }

    // Racing PostのpromoDetails.image_idから、一覧用のS3画像URLを組み立てる。
    function buildRacingPostImageUrl(node) {
      const promo = node && node.promoDetails ? node.promoDetails : {};
      const direct = pickUsableImage(
        promo.image,
        promo.imageUrl,
        promo.thumbnail,
        promo.thumbnailUrl,
        node.image,
        node.images,
        node.thumbnail,
        node.thumbnailUrl
      );
      if (direct) return direct;

      const imageId = pickFirst(promo.image_id, promo.imageId, node.image_id, node.imageId);
      if (!imageId) return "";
      if (/^https?:\/\//i.test(String(imageId))) return pickUsableImage(imageId);

      return `https://s3-eu-west-1.amazonaws.com/prod-media-racingpost/prod/images/169_408/${encodeURIComponent(String(imageId).trim())}.jpg`;
    }

    // Racing TV公式APIのJSONから、見出し・URL・日時・画像を抽出する。
    function extractRacingTvApiItems(data, site) {
      const articles = data && Array.isArray(data.articles) ? data.articles : [];

      return articles.map((article) => {
        const slug = String(article.slug || article.url || "").replace(/^\/+/, "");
        const path = slug.startsWith("news/") ? `/${slug}` : `/news/${slug}`;
        const hero = article.hero || {};

        return buildRawNewsItem(site, {
          title: article.headline || article.title,
          url: article.url || path,
          publishedAt: parseDate(
            pickFirst(
              article.published && article.published.datetime,
              article.published_at,
              article.publishedAt,
              article.date
            )
          ),
          thumbnail: pickUsableImage(hero.placeholder_image_url, hero.image_url, hero.url, hero.src)
        });
      }).filter(Boolean);
    }

    // The Irish FieldのLoad More APIから、血統ニュース記事を構造化して取り出す。
    function extractIrishFieldApiItems(data, site) {
      const articles =
        data && data.fjapp && Array.isArray(data.fjapp.api)
          ? data.fjapp.api
          : data && Array.isArray(data.api)
            ? data.api
            : [];

      return articles.map((article) => buildRawNewsItem(site, {
        title: article.ctitle || article.title || article.name,
        url: article.hspermlink || article.permalink || article.url,
        publishedAt: parseDate(pickFirst(article.releasedate, article.modified, article.publishedAt, article.date)),
        thumbnail: buildIrishFieldImageUrl(article)
      })).filter(Boolean);
    }

    // The Irish Field APIの画像パスとファイル名をS3の実画像URLへ変換する。
    function buildIrishFieldImageUrl(article) {
      const direct = pickUsableImage(article.image, article.thumbnail, article.thumbnailUrl, article.mainImage);
      if (direct) return direct;

      const imagePath = pickFirst(article.imagePath, article.imagepath, article.TLImagePath, article.path);
      const fileName = pickFirst(article.TLThumb, article.tlthumb, article.thumb, article.fileName, article.filename);
      if (imagePath && fileName) {
        return `https://s3-eu-west-1.amazonaws.com/theirishfield/WEBFILES/${String(imagePath).replace(/^\/+/, "")}${fileName}`;
      }

      return "";
    }

    // WordPress REST APIから、埋め込みメディア付きの記事情報を媒体共通形式へ変換する。
    function extractWordPressApiItems(data, site) {
      const posts = Array.isArray(data) ? data : [];

      return posts.map((post) => {
        const media = post && post._embedded && post._embedded["wp:featuredmedia"] && post._embedded["wp:featuredmedia"][0];
        const sizes = media && media.media_details && media.media_details.sizes ? media.media_details.sizes : {};

        // 一覧カードに合う中サイズを優先し、無ければWordPressの標準画像へ順に落とす。
        const image = pickFirst(
          sizes["indiegraf-post-grid-medium"] && sizes["indiegraf-post-grid-medium"].source_url,
          sizes["post-thumbnail"] && sizes["post-thumbnail"].source_url,
          sizes.medium_large && sizes.medium_large.source_url,
          sizes.medium && sizes.medium.source_url,
          media && media.source_url
        );

        return buildRawNewsItem(site, {
          title: decodeHtmlEntities(post && post.title && post.title.rendered),
          url: post && post.link,
          publishedAt: parseDate(post && post.date_gmt ? `${post.date_gmt}Z` : post && post.date),
          thumbnail: pickUsableImage(image)
        });
      }).filter(Boolean);
    }

    // BloodHorseの一覧HTMLから、content属性の公開日時を優先して記事を抽出する。
    function extractBloodHorseItems(doc, site) {
      const items = [];

      doc.querySelectorAll("article.content-article.summary, article").forEach((card) => {
        const anchor = card.querySelector("h4 a[href*='/horse-racing/articles/'], a[href*='/horse-racing/articles/']");
        if (!anchor) return;

        const dateElement = card.querySelector("[itemprop='datePublished'], [content][itemprop='datePublished']");
        const rawDate = dateElement && (dateElement.getAttribute("content") || dateElement.textContent);
        const image = attrOf(card, "img", "src");
        const title = cleanTitle(anchor.textContent || anchor.getAttribute("title"));

        // BloodHorseはToday/Yesterday表示もあるが、content属性のISO日時が最も安定する。
        items.push({
          title,
          url: anchor.getAttribute("href"),
          publishedAt: parseDate(rawDate),
          thumbnail: image,
          source: site.name
        });
      });

      return items.filter((item) => item.title && item.url && item.publishedAt);
    }

    // BloodHorseは公式HTMLがWAFで遮断されることがあるため、一覧Readerのカードを安定取得経路として読む。
    // 写真リンクと見出しリンクのURL一致を要求し、相対時刻は配信元のAmerica/New_Yorkとして絶対時刻へ直す。
    function extractBloodHorseReaderItems(rawText, site) {
      const lines = String(rawText || "").split(/\r?\n/).map((line) => line.trim());
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
        const thumbnail = pendingImage && canonicalArticleUrl(pendingImage.url) === canonicalArticleUrl(heading[2])
          ? pendingImage.thumbnail
          : "";
        pendingImage = null;

        if (!publishedAt) return;
        items.push({
          title: cleanTitle(heading[1]),
          url: heading[2],
          publishedAt,
          thumbnail: pickUsableImage(thumbnail),
          source: site.name
        });
      });

      return items;
    }

    // Today/Yesterday表記を配信元タイムゾーンの壁時計として解釈し、ブラウザ共通のDateへ変換する。
    function parseRelativeDateInTimeZone(value, timeZone) {
      const match = String(value || "").match(/^(Today|Yesterday),\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!match) return null;

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
      }, timeZone);
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
      return Object.fromEntries(
        formatter.formatToParts(date)
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, Number(part.value)])
      );
    }

    // 地域時刻を一度UTCと仮定し、その瞬間のタイムゾーン差を差し引いて絶対時刻へ変換する。
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

    // Irish Racingの一覧HTMLから日付見出しと時刻を組み合わせて記事を抽出する。
    function extractIrishRacingItems(doc, site) {
      const items = [];

      doc.querySelectorAll("#news-panel .main-news-item, #news-panel .news-item, .main-news-item, .news-item").forEach((card) => {
        // Irish RacingのHTMLはカード全体がリンクに包まれる形と、カード内にリンクがある形が混在する。
        // /news/ を含むURLを優先して、ヘッダーや広告リンクを記事として拾わないようにする。
        const anchor =
          card.closest("a[href*='/news/']") ||
          card.querySelector("a[href*='/news/']") ||
          card.closest("a[href]") ||
          card.querySelector("a[href]");
        const title = cleanTitle(textOf(card, "h2, h3, h4"));
        const dateHeader = findIrishRacingDateHeader(card);
        const timeText = normalizeClockText(textOf(card, ".news-stamp"));
        const image = attrOf(card, "img.news-photo, img", "src");

        if (!anchor || !title || !dateHeader || !timeText) return;

        items.push({
          title,
          url: anchor.getAttribute("href"),
          publishedAt: parseIrishRacingDateTime(dateHeader, timeText),
          thumbnail: image,
          source: site.name
        });
      });

      return items;
    }

    // Irish RacingのJina Reader Markdownから、日付見出し・記事見出し・時刻を組み合わせて抽出する。
    function extractIrishRacingMarkdownItems(text, site) {
      if (!text) return [];

      const lines = String(text).split(/\r?\n/).map((line) => line.trim());
      const items = [];
      let currentDateHeader = "";
      let lastImage = "";

      lines.forEach((line, index) => {
        // Jinaでは「Sat 16th May 2026」のような日付行が先に出て、その下に同日記事が並ぶ。
        if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+20\d{2}$/i.test(line)) {
          currentDateHeader = line;
          lastImage = "";
          return;
        }

        // 画像リンクは見出し行より前に出ることがあるため、直近画像として一時保存する。
        const imageMatch = line.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/);
        if (imageMatch) lastImage = imageMatch[1];

        // 多くの記事は「[画像](記事URL)#### [タイトル](記事URL)」が1行に連結される。
        // 通常のMarkdown見出しではないため、画像・URL・タイトルをこの専用正規表現でまとめて取り出す。
        const inlineHeading = line.match(/^\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\]\((https?:\/\/www\.irishracing\.com\/news\/[^)]+)\)#{2,6}\s+\[([^\]]+)\]\((https?:\/\/www\.irishracing\.com\/news\/[^)]+)\)/i);

        // 最初のメイン記事だけは「[画像 ## タイトル 本文 時刻](記事URL)」という圧縮形になる。
        // 本文まで同じ角括弧に入ってタイトル境界が曖昧なので、URLスラッグから見出しを復元する。
        const compactHero = line.match(/^\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\s*#{2,6}\s*.+?\s+(\d{1,2}\.\d{2}\s*(?:AM|PM))\]\((https?:\/\/www\.irishracing\.com\/news\/[^)]+)\)/i);

        const heading = line.match(/^#{2,6}\s+\[([^\]]+)\]\((https?:\/\/www\.irishracing\.com\/news\/[^)]+)\)/i);
        if (!currentDateHeader) return;

        let title = "";
        let url = "";
        let thumbnail = lastImage;
        let timeText = "";

        if (inlineHeading) {
          thumbnail = inlineHeading[1];
          title = inlineHeading[3];
          url = inlineHeading[4] || inlineHeading[2];
          timeText = findIrishRacingMarkdownTime(lines, index);
        } else if (compactHero) {
          thumbnail = compactHero[1];
          url = compactHero[3];
          title = titleFromIrishRacingUrl(url) || compactHero[3];
          timeText = normalizeClockText(compactHero[2]);
        } else if (heading) {
          title = heading[1];
          url = heading[2];
          timeText = findIrishRacingMarkdownTime(lines, index);
        } else {
          return;
        }

        // 時刻は見出しの直後に出る場合と、短い本文を挟んで出る場合があるため、近傍だけを限定探索する。
        const publishedAt = parseIrishRacingDateTime(currentDateHeader, timeText);
        if (!publishedAt) return;

        items.push({
          title: cleanTitle(title),
          url,
          publishedAt,
          thumbnail,
          source: site.name
        });
      });

      return items;
    }

    // Irish Racing Markdown内で、記事見出しに紐づく時刻表記を近傍から探す。
    function findIrishRacingMarkdownTime(lines, index) {
      for (let offset = 0; offset <= 6; offset += 1) {
        const line = lines[index + offset] || "";
        const match = line.match(/\b\d{1,2}\.\d{2}\s*(?:AM|PM)\b/i);
        if (match) return normalizeClockText(match[0]);
      }
      return "";
    }

    // Irish Racingの記事URLは /news/slug/id 形式なので、通常の「末尾slug」抽出ではIDだけになる。
    function titleFromIrishRacingUrl(url) {
      try {
        const parts = new URL(url).pathname.split("/").filter(Boolean);
        const slug = parts.length >= 3 ? parts[parts.length - 2] : "";
        return cleanTitle(
          decodeURIComponent(slug)
            .replace(/[-_]+/g, " ")
            .replace(/\b([a-z])/g, (match) => match.toUpperCase())
        );
      } catch (_error) {
        return "";
      }
    }

    // Irish Racingで記事カードの直前にある日付見出しをさかのぼって探す。
    function findIrishRacingDateHeader(element) {
      let row = element.closest(".row") || element;

      while (row) {
        const dateElement = row.matches(".newsitemdate") ? row : row.querySelector(".newsitemdate");
        if (dateElement) return cleanWhitespace(dateElement.textContent);
        row = row.previousElementSibling;
      }

      return "";
    }

    // Irish Racing専用の日付見出しと時刻を結合し、Dateへ変換する。
    function parseIrishRacingDateTime(dateHeader, timeText) {
      if (!dateHeader || !timeText) return null;
      // dateHeaderは「Sat 16th May 2026」、timeTextは「6:08 PM」へ正規化済みの想定。
      // parseDate側で曜日と序数サフィックスを処理できるため、ここでは結合だけに留める。
      return parseDate(`${dateHeader} ${normalizeClockText(timeText)}`);
    }

    // 12.30 PMのような時刻表記を、Date解析しやすい形式へ整える。
    function normalizeClockText(value) {
      return cleanWhitespace(value)
        .replace(/(\d{1,2})\.(\d{2})\s*(AM|PM)/ig, "$1:$2 $3")
        .replace(/(\d{1,2})\.(\d{2})(?!\d)/g, "$1:$2");
    }

    // Sporting Life公式API、または旧Next.js初期JSONから競馬記事だけを抽出する。
    // APIレスポンスは記事配列そのもの、HTML経路は#__NEXT_DATA__配下なので、ここで入力形式を吸収する。
    function extractSportingLifeItems(doc, site, apiData) {
      const script = doc.querySelector("#__NEXT_DATA__");
      const data = Array.isArray(apiData)
        ? apiData
        : script
          ? safeJsonParse(script.textContent)
          : null;
      if (!data) return [];

      // 配列APIでもNext.jsの深いJSONでも同じ条件で記事オブジェクトを取り出す。
      // API配列の要素もflattenJsonObjectsへ渡すことで、抽出後の正規化処理を一系統に保つ。
      return flattenJsonObjects(data, 12000)
        .filter((node) => node && node.article_id && node.title && node.published_date)
        .filter((node) => !node.category || node.category === "HORSE_RACING")
        .map((node) => buildRawNewsItem(site, {
          title: node.title,
          url: buildSportingLifeArticleUrl(node, site),
          publishedAt: parseDate(node.published_date),
          thumbnail: pickSportingLifeImage(node)
        }))
        .filter(Boolean)
        // APIの配列順は公開時刻順とは限らないため、単体抽出の段階でも新着順へ揃える。
        .sort((left, right) => right.publishedAt - left.publishedAt);
    }

    // Sporting Lifeの記事IDとSEOタイトルから、元記事URLを組み立てる。
    function buildSportingLifeArticleUrl(node, site) {
      const slug = slugifyPathSegment(node.seo_title || node.title);
      if (!slug || !node.article_id) return "";
      return absoluteUrl(`/racing/news/${slug}/${node.article_id}`, site.baseUrl);
    }

    // Sporting Life記事ウィジェット内から利用可能なサムネイルURLを選ぶ。
    function pickSportingLifeImage(node) {
      const widgets = Array.isArray(node.widgets) ? node.widgets : [];

      for (const widget of widgets) {
        const keys = Array.isArray(widget.keys) ? widget.keys : [];
        const image = pickUsableImage(...keys.filter((entry) => entry && ["uri", "thumbnail"].includes(entry.key)).map((entry) => entry.value));
        if (image) return image;
      }

      return "";
    }

    // 英文タイトルをURLパスに使える小文字スラッグへ変換する。
    function slugifyPathSegment(value) {
      return String(value || "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }

    // URL末尾のスラッグを、最低限読める英文タイトルへ変換する。
    function titleFromUrlSlug(url, stripPattern) {
      let pathname = "";
      try {
        pathname = new URL(url).pathname;
      } catch (_error) {
        return "";
      }

      const slug = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "")
        .replace(stripPattern || /$/, "")
        .replace(/[-_]+/g, " ")
        .replace(/\b([a-z])/g, (match) => match.toUpperCase());

      return cleanTitle(slug);
    }

    // The Irish Fieldの通常HTMLから、APIが使えない場合の予備抽出を行う。
    function extractIrishFieldItems(doc, site) {
      const items = [];
      const scope = doc.querySelector(".channel-latest-articles-desktop") || doc;

      scope.querySelectorAll("a[href*='/bloodstock/'], a[href*='/racing/']").forEach((anchor) => {
        const row = anchor.closest(".col-sm-12.right-padding-col, .col-sm-12.top-border, .main-news") || anchor.parentElement;
        const title =
          textOf(row, ".title, .title-smallerline, .title-desktop-most-read") ||
          cleanTitle(anchor.textContent);
        const dateText = textOf(row, ".bottom-information .grey, .bottom-information-load-more .grey, .grey");
        const image =
          attrOf(row, "img.small-image, img", "src") ||
          extractCssBackgroundUrl(attrOf(row, ".article-image-container", "style"));

        if (!title || !dateText) return;

        items.push({
          title,
          url: anchor.getAttribute("href"),
          publishedAt: parseDate(dateText),
          thumbnail: image,
          source: site.name
        });
      });

      return items;
    }

    // TTR AusNZのNext.js初期JSONから、エディション内の記事一覧を抽出する。
    // 将来JSON APIへ切り替えた場合も再利用できるよう、第三引数の構造化データを最優先する。
    function extractTtrAusNzItems(doc, site, structuredData) {
      const script = doc.querySelector("#__NEXT_DATA__");
      const data = structuredData || (script ? safeJsonParse(script.textContent) : null);
      if (!data) return [];

      const skipTypes = new Set(["interstitial", "sponsored", "social", "results", "winners", "top20"]);
      const editionNodes = flattenJsonObjects(data, 20000)
        .filter((node) => node && Array.isArray(node.pages) && (node.date || node.slug || node.publishedAt));
      const items = [];

      editionNodes.forEach((edition) => {
        const editionSlug = edition.slug || edition.date || "";
        const editionDate =
          parseDate(edition.publishedAt) ||
          parseDate(edition.date) ||
          parseDateFromUrl(`/edition/${editionSlug}/`);

        edition.pages.forEach((page) => {
          if (!page || !page.headline || !page.slug || skipTypes.has(page.articleType)) return;
          if (isTtrAusNzFixedPage(page.slug)) return;
          const pageEditionSlug = page.editionSlug || editionSlug;
          if (!pageEditionSlug) return;

          items.push({
            title: page.headline,
            url: `/edition/${pageEditionSlug}/${page.slug}`,
            publishedAt: parseDate(page.publishedAt) || editionDate,
            thumbnail: page.coverImage || edition.coverImage,
            source: site.name
          });
        });
      });

      // JSON深度走査の順序はNext.js内部構造で変わるため、返却前に公開時刻の降順を明示する。
      return items.sort((left, right) => right.publishedAt - left.publishedAt);
    }

    // TTR AusNZのReader Markdownから、日付付きエディション記事を抽出する。
    // Readerは複数の#####見出しを改行なしで連結することがあるため、行単位ではなく全文をglobal検索する。
    function extractTtrAusNzMarkdownItems(text, site) {
      if (!text) return [];

      const items = [];
      const articlePattern = /#{4,5}\s+\[([^\]]+)\]\((https?:\/\/(?:www\.)?ttrausnz\.com\.au\/edition\/(\d{4}-\d{2}-\d{2})\/([^/?#)]+)[^)]*)\)/gi;

      for (const match of String(text).matchAll(articlePattern)) {
        const url = match[2];
        const slug = match[4];
        if (isTtrAusNzFixedPage(slug)) continue;

        // 見出しラベルには「タイトル＋要約＋日付」が連結されている。
        // URL slugと一致する先頭部分を探し、要約や日付がヘッドラインへ混ざらないようにする。
        const title = extractTitleMatchingSlug(match[1], slug) || titleFromUrlSlug(url);
        if (!isLikelyHeadline(title)) continue;

        items.push({
          title,
          url,
          publishedAt: parseDateFromUrl(url) || parseDate(match[3]),
          // 現在のReader一覧には記事写真が含まれないため、空値は本体のダミー画像へ委ねる。
          thumbnail: "",
          source: site.name
        });
      }

      return items.sort((left, right) => right.publishedAt - left.publishedAt);
    }

    // 「タイトル＋要約」からURL slugと完全一致するタイトル部分だけを復元する。
    function extractTitleMatchingSlug(label, slug) {
      const words = cleanWhitespace(label).split(" ").filter(Boolean);

      for (let index = 1; index <= words.length; index += 1) {
        const candidate = words.slice(0, index).join(" ");
        if (slugifyPathSegment(candidate) === slugifyPathSegment(slug)) return candidate;
      }

      return "";
    }

    // エディション内へ毎日挿入される案内・索引ページを、記事種別に依存せずslugで除外する。
    // normal型には実ニュースも存在し得るため、normal全体を落とさず既知の固定ページだけを限定除外する。
    function isTtrAusNzFixedPage(slug) {
      const value = String(slug || "");
      return /^(?:job-board|wednesday-trivia|20\d{2}-stallion-parades|daily-news-wrap|debutants|first-season-sire-runners-and-results|thanks-for-reading)$/i.test(value) ||
        /^looking-ahead(?:-|$)/i.test(value);
    }

    // RacenetをJina Readerで読んだMarkdownから、画像付きカードを記事化する。
    function extractRacenetMarkdownItems(text, site) {
      if (!text) return [];

      const items = [];
      const cardPattern = /\[!\[[^\]]*?(?::\s*([^\]]+))?\]\((https?:\/\/[^)]+)\)\s*([^\[\]]{20,900}?)\]\((https?:\/\/www\.racenet\.com\.au\/news\/[^)]+)\)/g;

      for (const match of String(text).matchAll(cardPattern)) {
        const url = match[4];
        const body = cleanWhitespace(match[3]);
        const publishedAt = parseDateFromText(body) || parseDateFromUrl(url);
        const title = pickRacenetTitle(body, url);
        if (!title || !publishedAt || !isCandidateArticleUrl(url, site)) continue;

        items.push({
          title,
          url,
          publishedAt,
          thumbnail: match[2],
          source: site.name
        });
      }

      return items;
    }

    // Racing TVのJina Reader一覧Markdownから、APIが使えない場合の予備記事候補を作る。
    function extractRacingTvMarkdownItems(text, site) {
      if (!text) return [];

      const items = [];
      const cardPattern = /\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\s*([^\[\]]{8,500}?)\]\((https?:\/\/www\.racingtv\.com\/news\/[^)]+)\)/g;
      let undatedCount = 0;

      for (const match of String(text).matchAll(cardPattern)) {
        const image = match[1];
        const body = cleanWhitespace(match[2]);
        const url = match[3];
        let publishedAt = parseDateFromText(body) || parseDateFromUrl(url);
        let dateEstimated = false;

        if (!publishedAt && CONFIG.ALLOW_UNDATED_LATEST_ITEMS && undatedCount < CONFIG.UNDATED_ITEMS_PER_SITE) {
          // Racing TVのJina出力は先頭カード以外の相対時刻を省略することがある。
          // 最新一覧の上位カードだけ現在時刻から少しずつずらして仮配置し、0件扱いになるのを避ける。
          publishedAt = estimateDateForUndatedItem(undatedCount);
          dateEstimated = true;
          undatedCount += 1;
        }

        if (!publishedAt || !isCandidateArticleUrl(url, site)) continue;

        items.push({
          title: cleanTitle(body.replace(/\b\d+\s+(?:minutes?|mins?|hours?|days?)\s+ago\b.*$/i, "")),
          url,
          publishedAt,
          dateEstimated,
          thumbnail: image,
          source: site.name
        });
      }

      return items;
    }

    // At The RacesのJina Reader一覧は「見出し -> Sunday 24 May -> 要約」の順で、記事URLだけが欠ける。
    // 公式記事URLは /news/YYYY/Month/DD/title-slug 形式なので、日付行と見出しから復元する。
    function extractAtTheRacesMarkdownItems(text, site) {
      if (!text || !/At The Races News/i.test(text)) return [];

      const lines = String(text).split(/\r?\n/).map((line) => cleanWhitespace(line)).filter(Boolean);
      const startIndex = lines.findIndex((line) => /^At The Races News$/i.test(line));
      const scanLines = startIndex >= 0 ? lines.slice(startIndex + 1) : lines;
      const items = [];

      for (let index = 0; index < scanLines.length - 1; index += 1) {
        const parsedLine = parseAtTheRacesTitleLine(scanLines[index]);
        const title = cleanTitle(parsedLine.title);
        const dateText = scanLines[index + 1];

        // 記事カードの日付行だけを採用する。Cookie文言やナビゲーション中の短いテキストはここで落とす。
        if (/^send message$/i.test(title) || !isLikelyHeadline(title) || !isAtTheRacesDateLine(dateText)) continue;

        const publishedAt = parseDate(dateText);
        const url = parsedLine.url || buildAtTheRacesArticleUrl(title, publishedAt, site);
        if (!publishedAt || !url) continue;

        items.push({
          title,
          url,
          publishedAt,
          thumbnail: "",
          source: site.name
        });
      }

      return items;
    }

    // Jinaの状態によって、At The Racesの見出しはプレーンテキストまたは「## [見出し](URL)」になる。
    function parseAtTheRacesTitleLine(line) {
      const normalized = cleanWhitespace(String(line || "").replace(/^#{1,6}\s*/, ""));
      const linked = normalized.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
      if (linked) return { title: linked[1], url: linked[2] };
      return { title: normalized, url: "" };
    }

    // At The Races一覧の日付は曜日付きの「Sunday 24 May」形式で出る。
    function isAtTheRacesDateLine(value) {
      return /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*$/i.test(value || "");
    }

    // At The Racesの公式記事URLを、Jina一覧に残る見出しと日付から復元する。
    function buildAtTheRacesArticleUrl(title, publishedAt, site) {
      if (!title || !(publishedAt instanceof Date) || Number.isNaN(publishedAt.getTime())) return "";

      const year = publishedAt.getFullYear();
      const month = monthPathName(publishedAt.getMonth() + 1);
      const day = String(publishedAt.getDate()).padStart(2, "0");
      const slug = slugifyAtTheRacesTitle(title);
      if (!slug) return "";

      return absoluteUrl(`/news/${year}/${month}/${day}/${slug}`, site.baseUrl);
    }

    // At The Racesは「1,000」のカンマをURLに残すため、汎用slugifyとは別に媒体専用で変換する。
    function slugifyAtTheRacesTitle(value) {
      return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9,\s-]+/g, "")
        .replace(/[\s-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }

    // Racenetカード本文とURLスラッグを照合し、長い説明文を見出しに混ぜないようにする。
    function pickRacenetTitle(body, url) {
      const fromSlug = titleFromUrlSlug(url, /-\d{8}$/);
      if (!fromSlug) return cleanTitle(body);
      const bodyPrefix = cleanWhitespace(body).slice(0, 180).toLowerCase();
      const slugWords = fromSlug.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
      const matchedWords = slugWords.filter((word) => bodyPrefix.includes(word)).length;
      return matchedWords >= Math.min(4, slugWords.length) ? fromSlug : cleanTitle(body);
    }

    // Racing.com公式GraphQLのJSONから、見出し・日時・実写真URLを安定して取り出す。
    function extractRacingComGraphqlItems(data, site) {
      const articles = data && data.data && Array.isArray(data.data.getNewsList)
        ? data.data.getNewsList
        : [];

      return articles.map((article) => {
        // 公式APIでは一般的なcamelCaseではなく、short_title/page_url/article_date/image_urlを使う。
        // 汎用JSON抽出へ任せるとURLや日時を落としやすいので、このサイトだけ明示的に対応する。
        const url = absoluteUrl(pickFirst(article.page_url, article.url, article.path), site.baseUrl);
        if (!url || !isCandidateArticleUrl(url, site)) return null;

        return buildRawNewsItem(site, {
          title: pickFirst(article.short_title, article.name, article.title, article.description),
          url,
          publishedAt: parseDate(pickFirst(article.article_date, article.published, article.modified)),
          thumbnail: pickUsableImage(
            article.image_url,
            article.thumbnail,
            article.image_object && pickFirst(article.image_object.src, article.image_object.thumbnail_src),
            article.thumbnail_object && pickFirst(article.thumbnail_object.src, article.thumbnail_object.thumbnail_src)
          )
        });
      }).filter(Boolean);
    }

    // Racing.comのJina Reader出力から、実写真・見出し・相対時刻・記事URLを1カードとして抽出する。
    function extractRacingComMarkdownItems(text, site) {
      if (!text) return [];

      const lines = String(text).split(/\r?\n/).map((line) => line.trim());
      const items = [];

      lines.forEach((line, index) => {
        const heading = line.match(/^#{3,5}\s+(.+)$/);
        if (!heading) return;

        // Racing.comのカードは「画像」「ブランドアイコン」「見出し」「カテゴリ」「時刻」「空リンク」の順で並ぶ。
        // 汎用Markdown抽出だとブランドアイコンをサムネイル扱いしやすいため、ここで実写真だけを先に結び付ける。
        const title = cleanTitle(heading[1]);
        const url = findRacingComArticleLinkAfter(lines, index, site);
        const publishedAt = findRacingComDateAfter(lines, index, url);
        const thumbnail = findRacingComImageBefore(lines, index);

        if (!isLikelyHeadline(title) || !url || !publishedAt || !isCandidateArticleUrl(url, site)) return;

        items.push({
          title,
          url,
          publishedAt,
          thumbnail,
          source: site.name
        });
      });

      return items;
    }

    // Racing.comの見出し直後に出る空リンク形式の記事URLを探す。
    function findRacingComArticleLinkAfter(lines, index, site) {
      for (let offset = 1; offset <= 10; offset += 1) {
        const line = lines[index + offset] || "";
        const links = [...line.matchAll(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)].map((match) => match[1]);
        const candidate = links.find((link) => isCandidateArticleUrl(link, site));
        if (candidate) return candidate;
      }
      return "";
    }

    // Racing.comの「JUST NOW」「21 MINS AGO」など、見出し近傍の相対時刻をDateへ変換する。
    function findRacingComDateAfter(lines, index, url) {
      for (let offset = 1; offset <= 8; offset += 1) {
        const line = lines[index + offset] || "";
        if (/^just now$/i.test(line)) return new Date();
        const parsed = parseDateFromText(line);
        if (parsed) return parsed;
      }
      return parseDateFromUrl(url);
    }

    // Racing.comの見出し直前にある実写真を探し、赤いブランドアイコンやナビロゴは除外する。
    function findRacingComImageBefore(lines, index) {
      for (let offset = -1; offset >= -8; offset -= 1) {
        const line = lines[index + offset] || "";
        if (/^#{3,5}\s+/.test(line)) break;

        const images = [...line.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)].map((match) => match[1]);
        const candidate = images.find((image) => isUsableImageValue(image));
        if (candidate) return candidate;
      }
      return "";
    }

    // RSS/Atomフィードから記事タイトル、URL、公開日時、メディア画像を抽出する。
    function extractFeedItems(doc, site) {
      const items = [];

      doc.querySelectorAll("item, entry").forEach((entry) => {
        const title = textOf(entry, "title");
        const linkElement = entry.querySelector("link");
        const rawLink = linkElement && (linkElement.getAttribute("href") || linkElement.textContent);
        // 古いRSSだけhttpを返す媒体は、API結果とのURL重複排除と安全な遷移のためhttpsへ統一する。
        const link = site.forceHttps ? String(rawLink || "").replace(/^http:\/\//i, "https://") : rawLink;
        const encoded = textOf(entry, "content\\:encoded") || textOf(entry, "description") || textOf(entry, "summary");
        const image =
          textOf(entry, "image") ||
          attrOf(entry, "media\\:content", "url") ||
          attrOf(entry, "media\\:thumbnail", "url") ||
          attrOf(entry, "enclosure", "url") ||
          extractImageFromHtml(encoded);

        const categories = [...entry.querySelectorAll("category")].map((element) => cleanWhitespace(element.textContent));
        // 同じRSSを複数ビューで共有する媒体は、category完全一致で混入を防ぐ。
        if (site.rssCategory && !categories.includes(site.rssCategory)) return;
        if (!title || !link || !isCandidateArticleUrl(link, site)) return;

        items.push({
          title,
          url: link,
          publishedAt: parseDate(textOf(entry, "pubDate") || textOf(entry, "published") || textOf(entry, "updated") || textOf(entry, "dc\\:date")),
          thumbnail: image,
          source: site.name
        });
      });

      return items;
    }

    // 指定セレクタのテキストを安全に取り出し、空白を整える。
    function textOf(root, selector) {
      const element = root.querySelector(selector);
      return element ? cleanWhitespace(element.textContent) : "";
    }

    // 指定セレクタの属性値を安全に取り出す。
    function attrOf(root, selector, attr) {
      const element = root.querySelector(selector);
      return element ? element.getAttribute(attr) || "" : "";
    }

    // HTML断片に含まれる最初のimg srcをサムネイル候補として取り出す。
    function extractImageFromHtml(value) {
      if (!value) return "";
      const match = String(value).match(/<img[^>]+src=["']([^"']+)["']/i);
      return match ? decodeHtmlEntities(match[1]) : "";
    }

    // Jina ReaderなどのMarkdown本文から、見出しリンクと近傍の日付・画像を抽出する。
    function extractMarkdownItems(text, site) {
      if (!text || !/(Markdown Content:|^#{1,4}\s|\]\(https?:\/\/)/m.test(text)) return [];

      const lines = String(text).split(/\r?\n/).map((line) => line.trim());
      const items = extractMarkdownInlineCards(text, site);

      lines.forEach((line, index) => {
        let title = "";
        let url = "";
        let thumbnail = "";

        const viewPost = line.match(/\[View post:\s*([^\]]+)\]\((https?:\/\/[^)]+)\)(?:!\[[^\]]*\]\((https?:\/\/[^)]+)\))?/i);
        const linkedHeading = line.match(/^#{1,4}\s+\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
        const plainHeading = line.match(/^#{2,5}\s+(.+)$/);
        const plainArticleLink = line.match(/^\[([^\]]{8,500})\]\((https?:\/\/[^)]+)\)$/);

        if (viewPost) {
          title = viewPost[1];
          url = viewPost[2];
          thumbnail = viewPost[3] || "";
        } else if (linkedHeading) {
          title = linkedHeading[1];
          url = linkedHeading[2];
        } else if (plainArticleLink) {
          // Racing PostのJina出力では、画像カードの次行が見出し記号なしの単独リンクになることがある。
          // カテゴリリンクも同じ形で混ざるため、後段のisLikelyHeadlineと日付近傍チェックで記事だけに絞る。
          title = plainArticleLink[1];
          url = plainArticleLink[2];
        } else if (plainHeading) {
          title = plainHeading[1];
          // Daily MailのRSSをJinaがMarkdown化すると「### [](URL)」のような空リンク見出しになることがある。
          // これは記事タイトルではなく変換ノイズなので、URLが近傍にあってもカード化しない。
          if (/^\[\]\(https?:\/\/[^)]+\)$/i.test(title)) return;
          const titleLink = parseStandaloneMarkdownLink(title);
          if (titleLink) {
            // Racing Postの一部カードは「##### [見出し](記事URL)」のような深い見出しで出る。
            // 近傍の別記事リンクを拾うと見出しと遷移先がずれるため、Markdown内のURLを最優先にする。
            title = titleLink.title;
            url = titleLink.url;
          } else {
            url = findMarkdownArticleLinkNear(lines, index, site);
          }
        }

        title = cleanTitle(title);
        if (!title || !url || !isLikelyHeadline(title) || !isCandidateArticleUrl(url, site)) return;

        const publishedAt = findMarkdownDateNear(lines, index, url);
        if (!publishedAt) return;
        const markdownThumbnail = thumbnail || findMarkdownImageNear(lines, index, url);
        if (site.requireMarkdownImage && !markdownThumbnail) {
          // Paulick ReportのRelated Articlesは記事リンクと日時だけがあり、一覧上の画像が存在しない。
          // 画像付きカードだけを採用し、ダミー画像だらけになるのを避ける。
          return;
        }

        items.push({
          title,
          url,
          publishedAt,
          thumbnail: markdownThumbnail,
          source: site.name
        });
      });

      return items;
    }

    // 画像とリンクが1行にまとまったMarkdownカードを抽出する。
    function extractMarkdownInlineCards(text, site) {
      const items = [];

      const imageHeadingPattern = /\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\s*#{2,6}\s*([^\]]+?)\s+(\d{1,2}\s+[A-Za-z]+,?\s+\d{4})\]\((https?:\/\/[^)]+)\)/g;
      for (const match of text.matchAll(imageHeadingPattern)) {
        const title = cleanTitle(match[2]);
        const url = match[4];
        if (!isLikelyHeadline(title) || !isCandidateArticleUrl(url, site)) continue;
        items.push({
          title,
          url,
          publishedAt: parseDate(match[3]) || parseDateFromUrl(url),
          thumbnail: match[1],
          source: site.name
        });
      }

      const imageAndBoldLinkPattern = /\[!\[[^\]]*?(?::\s*([^\]]+))?\]\((https?:\/\/[^)]+)\)\]\((https?:\/\/[^)]+)\)\s*\[\*\*([^*]+)\*\*\]\((https?:\/\/[^)]+)\)/g;
      for (const match of text.matchAll(imageAndBoldLinkPattern)) {
        const title = cleanTitle(match[4] || match[1]);
        const url = match[5] || match[3];
        if (!isLikelyHeadline(title) || !isCandidateArticleUrl(url, site)) continue;
        items.push({
          title,
          url,
          publishedAt: parseDateFromUrl(url),
          thumbnail: match[2],
          source: site.name
        });
      }

      return items.filter((item) => item.publishedAt);
    }

    // Markdown見出しの近くにある記事URLを、下方向へ最大10行探す。
    function findMarkdownArticleLinkNear(lines, index, site) {
      for (let offset = 1; offset <= 10; offset += 1) {
        const line = lines[index + offset] || "";
        const links = [...line.matchAll(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)].map((match) => match[1]);
        const candidate = links.find((link) => isCandidateArticleUrl(link, site));
        if (candidate) return candidate;
      }
      return "";
    }

    // Markdown見出しの前後にある画像URLをサムネイル候補として探す。
    function findMarkdownImageNear(lines, index, articleUrl) {
      const offsets = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5];

      // まず「画像付きリンクの遷移先が同じ記事URL」の候補を優先する。
      // Racing PostのJina出力のように、カード直前に鍵・矢印・ロゴSVGが混ざる場合の誤採用を避ける。
      for (const offset of offsets) {
        const line = lines[index + offset] || "";
        const linkedImages = line.matchAll(/\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)[^\]]{0,500}\]\((https?:\/\/[^)]+)\)/g);
        for (const match of linkedImages) {
          if (isSameUrlIgnoringQuery(match[2], articleUrl) && isUsableImageValue(match[1])) return match[1];
        }
      }

      for (const offset of offsets) {
        const line = lines[index + offset] || "";
        const match = line.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/);
        if (match && isUsableImageValue(match[1])) return match[1];
      }
      return "";
    }

    // クエリやハッシュだけが違う同一記事URLかどうかを判定する。
    function isSameUrlIgnoringQuery(left, right) {
      try {
        const leftUrl = new URL(left);
        const rightUrl = new URL(right);
        return leftUrl.origin === rightUrl.origin && leftUrl.pathname.replace(/\/+$/, "") === rightUrl.pathname.replace(/\/+$/, "");
      } catch (_error) {
        return false;
      }
    }

    // Markdown見出しの近傍テキストやURLから公開日時を推定する。
    function findMarkdownDateNear(lines, index, url) {
      const fromUrl = parseDateFromUrl(url);
      // Jina ReaderのMarkdownでは、見出しの直前に画像URLや画像altが並ぶことがある。
      // Daily Racing Formのように画像ファイル名へ「05-30-26」形式の日付が入るサイトでは、
      // 直前行を先に読むと記事公開日ではなく画像ファイル名の日付を拾ってしまう。
      // そのため、見出し行と直後の著者・公開日メタ情報を先に確認し、最後に直前行へ戻る。
      const offsets = [0, 1, 2, 3, 4, 5, 6, 7, 8, -1, -2];
      for (const offset of offsets) {
        const parsed = parseDateFromText(lines[index + offset]);
        if (parsed) return parsed;
      }
      return fromUrl;
    }

    // JSON-LDのNewsArticle/Articleノードから記事情報を抽出する。
    function extractJsonLdItems(doc, site) {
      const items = [];

      doc.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
        const data = safeJsonParse(script.textContent);
        flattenJsonLd(data).forEach((node) => {
          if (!isArticleJsonNode(node, site)) return;
          items.push(buildRawNewsItem(site, {
            title: node.headline || node.name || node.title,
            url: pickUrlFromObject(node),
            publishedAt: parseDate(node.datePublished || node.dateCreated || node.dateModified || node.uploadDate),
            thumbnail: pickImageFromJsonValue(node.image || node.thumbnailUrl || node.thumbnail)
          }));
        });
      });

      return items.filter(Boolean);
    }

    // scriptタグ内の埋め込みJSONから記事らしいオブジェクトを抽出する。
    function extractStructuredScriptItems(doc, site) {
      const items = [];

      doc.querySelectorAll("script:not([src])").forEach((script) => {
        const type = (script.getAttribute("type") || "").toLowerCase();
        const text = (script.textContent || "").trim();
        if (!text || text.length > 2400000) return;
        if (!type.includes("json") && !/^[{\[]/.test(text)) return;

        const data = safeJsonParse(text);
        if (!data) return;

        flattenJsonObjects(data, 4500).forEach((node) => {
          const title = pickFirst(node.headline, node.title, node.name, node.displayName);
          const url = pickUrlFromObject(node);
          if (!title || !url || !isCandidateArticleUrl(url, site)) return;

          items.push(buildRawNewsItem(site, {
            title,
            url,
            publishedAt: parseDate(pickFirst(node.datePublished, node.publishedAt, node.publishDate, node.createdAt, node.updatedAt, node.date, node.pubDate)),
            thumbnail: pickImageFromJsonValue(pickFirst(node.image, node.images, node.thumbnail, node.thumbnailUrl, node.imageUrl, node.mainImage))
          }));
        });
      });

      return items.filter(Boolean);
    }

    // APIレスポンスJSON全体を走査し、URL付きの記事オブジェクトを汎用抽出する。
    function extractStructuredJsonItems(data, site) {
      if (!data) return [];
      const items = [];

      flattenJsonObjects(data, 6000).forEach((node) => {
        const title = pickFirst(node.headline, node.title, node.name, node.displayName);
        const url = pickUrlFromObject(node);
        if (!title || !url || !isCandidateArticleUrl(url, site)) return;

        items.push(buildRawNewsItem(site, {
          title,
          url,
          publishedAt: parseDate(pickFirst(node.datePublished, node.publishedAt, node.publishDate, node.createdAt, node.updatedAt, node.date, node.pubDate)),
          thumbnail: pickImageFromJsonValue(pickFirst(node.image, node.images, node.thumbnail, node.thumbnailUrl, node.imageUrl, node.mainImage))
        }));
      });

      return items.filter(Boolean);
    }

    // time要素を起点に、同じカード内の記事リンクと画像を抽出する。
    function extractAnchorsWithTimeElements(doc, site) {
      const items = [];

      doc.querySelectorAll("time").forEach((timeElement) => {
        const card = closestUsefulContainer(timeElement);
        const anchor = pickBestAnchorInContainer(card, site);
        if (!anchor) return;

        const title = pickTitleForAnchor(anchor, card);
        const url = absoluteUrl(anchor.getAttribute("href"), site.baseUrl);
        if (!isLikelyHeadline(title) || !isCandidateArticleUrl(url, site)) return;

        items.push({
          title,
          url,
          publishedAt: parseDate(timeElement.getAttribute("datetime") || timeElement.textContent),
          thumbnail: findImageNear(anchor, site),
          source: site.name
        });
      });

      return items;
    }

    // 汎用HTMLカードから記事リンク、見出し、日時、画像を抽出する最後の受け皿。
    function extractArticleCards(doc, site) {
      const items = [];
      let undatedCount = 0;

      doc.querySelectorAll("a[href]").forEach((anchor) => {
        const url = absoluteUrl(anchor.getAttribute("href"), site.baseUrl);
        if (!isCandidateArticleUrl(url, site)) return;

        const card = closestUsefulContainer(anchor);
        const title = pickTitleForAnchor(anchor, card);
        if (!isLikelyHeadline(title)) return;

        let publishedAt = findDateNear(card, anchor, url);
        let dateEstimated = false;

        if (!publishedAt && CONFIG.ALLOW_UNDATED_LATEST_ITEMS && undatedCount < CONFIG.UNDATED_ITEMS_PER_SITE) {
          publishedAt = estimateDateForUndatedItem(undatedCount);
          dateEstimated = true;
          undatedCount += 1;
        }

        if (!publishedAt) return;

        items.push({
          title,
          url,
          publishedAt,
          dateEstimated,
          thumbnail: findImageNear(anchor, site),
          source: site.name
        });
      });

      return items;
    }

    // JSON-LDノードが記事として扱える型・URL・見出しを持つか判定する。
    function isArticleJsonNode(node, site) {
      if (!node || typeof node !== "object") return false;
      const type = Array.isArray(node["@type"]) ? node["@type"].join(" ") : node["@type"];
      const title = node.headline || node.name || node.title;
      const url = pickUrlFromObject(node);
      if (!title || !url) return false;
      if (/NewsArticle|Article|BlogPosting|ReportageNewsArticle|AnalysisNewsArticle|LiveBlogPosting/i.test(type || "")) return true;
      return isCandidateArticleUrl(url, site) && isLikelyHeadline(title);
    }

    // JSON-LDの@graphやitemListElementを平坦化して記事候補を走査しやすくする。
    function flattenJsonLd(input) {
      if (!input) return [];
      const queue = Array.isArray(input) ? [...input] : [input];
      const nodes = [];

      while (queue.length > 0 && nodes.length < 2000) {
        const node = queue.shift();
        if (!node || typeof node !== "object") continue;
        nodes.push(node);
        if (Array.isArray(node["@graph"])) queue.push(...node["@graph"]);
        if (Array.isArray(node.itemListElement)) {
          node.itemListElement.forEach((entry) => {
            if (entry && typeof entry === "object") queue.push(entry.item || entry);
          });
        }
      }

      return nodes;
    }

    // 任意のJSONを幅優先でたどり、オブジェクトだけを上限付きで平坦化する。
    function flattenJsonObjects(input, limit) {
      const queue = [input];
      const nodes = [];
      const seen = new WeakSet();

      while (queue.length > 0 && nodes.length < limit) {
        const node = queue.shift();
        if (!node || typeof node !== "object") continue;
        if (seen.has(node)) continue;
        seen.add(node);
        if (!Array.isArray(node)) nodes.push(node);
        Object.keys(node).forEach((key) => {
          const value = node[key];
          if (value && typeof value === "object") queue.push(value);
        });
      }

      return nodes;
    }

    // 抽出器が返す生記事オブジェクトを共通形にそろえ、必須項目が欠けた候補はここで捨てる。
    function buildRawNewsItem(site, fields) {
      if (!fields || !fields.title || !fields.url || !fields.publishedAt) return null;

      return {
        title: fields.title,
        url: fields.url,
        publishedAt: fields.publishedAt,
        dateEstimated: Boolean(fields.dateEstimated),
        thumbnail: fields.thumbnail || "",
        source: fields.source || site.name
      };
    }

    // 抽出元ごとのばらつきを、画面表示用の共通ニュース形式へ変換する。
    function normalizeItem(raw, site, index) {
      // Jina ReaderやMarkdown系抽出では、見出しそのものが `[title](url)` の形で残ることがある。
      // その場合は表示用タイトルだけでなくURLもMarkdown内のリンク先を優先し、見出しと遷移先の食い違いを防ぐ。
      const titleLink = parseStandaloneMarkdownLink(raw.title);
      const sourceUrl = titleLink && isCandidateArticleUrl(titleLink.url, site) ? titleLink.url : raw.url;
      const url = absoluteUrl(sourceUrl, site.baseUrl);
      const title = cleanTitle(titleLink ? titleLink.title : raw.title);
      const publishedAt = raw.publishedAt instanceof Date ? raw.publishedAt : parseDate(raw.publishedAt);

      // JSON-LDや一覧ページの<title>から、媒体説明文やカテゴリ名が記事見出しとして紛れ込むことがある。
      // ここを最後の共通ゲートにして、抽出経路ごとの漏れを画面表示前に止める。
      if (!url || !title || !publishedAt || !isLikelyHeadline(title)) return null;

      return {
        id: `${site.id}:${url}`,
        sourceId: site.id,
        source: raw.source || site.name,
        region: site.region,
        regionName: getRegionLabel(site.region),
        title,
        url,
        publishedAt,
        dateEstimated: Boolean(raw.dateEstimated),
        thumbnail: resolveThumbnail(raw.thumbnail, site, url),
        sortIndex: index
      };
    }

    // リンクや時刻要素の周囲から、記事カードらしい親コンテナを探す。
    function closestUsefulContainer(element) {
      if (!element) return null;
      return element.closest(
        "article, li, dl, [class*='article'], [class*='Article'], [class*='news'], [class*='News'], [class*='story'], [class*='Story'], [class*='card'], [class*='Card'], [class*='post'], [class*='Post'], [class*='tile'], section, div"
      ) || element.parentElement;
    }

    // コンテナ内で、対象サイトの記事URLかつ見出しらしいリンクを選ぶ。
    function pickBestAnchorInContainer(container, site) {
      if (!container) return null;
      const anchors = [...container.querySelectorAll("a[href]")];
      return anchors.find((anchor) => {
        const url = absoluteUrl(anchor.getAttribute("href"), site.baseUrl);
        const title = pickTitleForAnchor(anchor, container);
        return isCandidateArticleUrl(url, site) && isLikelyHeadline(title);
      }) || null;
    }

    // リンク本文、aria-label、画像alt、近傍見出しから最適なタイトルを選ぶ。
    function pickTitleForAnchor(anchor, container) {
      const image = anchor.querySelector("img[alt]");
      const heading = container && container.querySelector("h1, h2, h3, h4, [class*='headline'], [class*='Headline'], [class*='title'], [class*='Title']");
      return cleanTitle(
        anchor.textContent ||
        anchor.getAttribute("aria-label") ||
        anchor.getAttribute("title") ||
        (image && image.getAttribute("alt")) ||
        (heading && heading.textContent)
      );
    }

    // 記事カード内のdatetime属性や近傍テキスト、URLから公開日時を探す。
    function findDateNear(container, anchor, url) {
      const candidates = [];
      if (container) {
        container.querySelectorAll("time, [datetime], [content], [data-date], [data-time], [data-published], [data-published-at]").forEach((element) => {
          candidates.push(
            element.getAttribute("datetime"),
            element.getAttribute("content"),
            element.getAttribute("data-date"),
            element.getAttribute("data-time"),
            element.getAttribute("data-published"),
            element.getAttribute("data-published-at"),
            element.getAttribute("title"),
            element.getAttribute("aria-label"),
            element.textContent
          );
        });
      }

      if (anchor) {
        candidates.push(anchor.getAttribute("title"), anchor.getAttribute("aria-label"));
      }

      const text = container && cleanWhitespace(container.textContent).slice(0, 1000);
      candidates.push(text, parseDateFromUrl(url));

      for (const candidate of candidates) {
        const parsed = candidate instanceof Date ? candidate : parseDateFromText(candidate);
        if (parsed) return parsed;
      }

      return null;
    }

    // 記事リンクの周辺コンテナを広げながら、利用可能なサムネイル画像を探す。
    function findImageNear(anchor, site) {
      const containers = collectImageSearchContainers(anchor);
      for (const container of containers) {
        const candidates = collectImageCandidates(container);
        for (const candidate of candidates) {
          const resolved = resolveThumbnail(candidate, site, anchor.getAttribute("href"));
          if (resolved !== CONFIG.FALLBACK_THUMBNAIL) return resolved;
        }
      }
      return CONFIG.FALLBACK_THUMBNAIL;
    }

    // 画像探索の対象にするリンク自身と親コンテナ群を近い順に集める。
    function collectImageSearchContainers(anchor) {
      const containers = [anchor];
      let current = anchor.parentElement;
      let depth = 0;
      while (current && depth < 6) {
        containers.push(current);
        if (current.matches("article, li, dl, [class*='item'], [class*='Item'], [class*='card'], [class*='Card'], [class*='story'], [class*='Story'], [class*='post'], [class*='Post']")) {
          break;
        }
        current = current.parentElement;
        depth += 1;
      }

      return [...new Set(containers)].filter(Boolean);
    }

    // img/source/background/data属性からサムネイル候補URLを収集する。
    function collectImageCandidates(container) {
      const candidates = [];

      container.querySelectorAll("source, img, [style*='background']").forEach((element) => {
        candidates.push(
          element.getAttribute("data-srcset"),
          element.getAttribute("data-lazy-srcset"),
          element.getAttribute("srcset"),
          element.getAttribute("data-src"),
          element.getAttribute("data-original"),
          element.getAttribute("data-lazy-src"),
          element.getAttribute("data-original-src"),
          element.getAttribute("data-image"),
          element.getAttribute("data-img"),
          element.getAttribute("data-bg"),
          element.getAttribute("content"),
          extractCssBackgroundUrl(element.getAttribute("style")),
          element.getAttribute("src")
        );
      });

      candidates.push(extractCssBackgroundUrl(container.getAttribute("style")));
      return candidates.map(firstSrcFromSet).filter(isUsableImageValue);
    }

    // srcsetなど複数候補を含む値から、先頭の画像URLだけを取り出す。
    function firstSrcFromSet(value) {
      if (!value) return "";
      if (String(value).trim().startsWith("data:")) return String(value).trim();
      return decodeHtmlEntities(String(value).split(",")[0].trim().split(/\s+/)[0]);
    }

    // inline styleのbackground-imageからURL部分だけを取り出す。
    function extractCssBackgroundUrl(style) {
      if (!style) return "";
      const match = String(style).match(/background(?:-image)?\s*:\s*url\((['"]?)(.*?)\1\)/i);
      return match ? match[2] : "";
    }

    // サムネイル候補を絶対URL化し、使えない場合はダミー画像へ置き換える。
    function resolveThumbnail(value, site, articleUrl) {
      // srcsetの場合は先頭候補だけを抜き出す。相対パスの場合はサイトのbaseUrlから絶対URLに直す。
      const direct = absoluteUrl(firstSrcFromSet(value), site.baseUrl);
      // ロゴ・透明GIF・placeholder等はニュース写真として見せると紛らわしいため採用しない。
      if (isUsableImageUrl(direct)) return direct;
      // 画像が無い記事は、壊れたimgではなく必ずHTML内蔵のSVGダミーへ寄せる。
      // ここでdata URIを返しておくことで、renderThumbnail側がダミー要素へ確実に分岐できる。
      return CONFIG.FALLBACK_THUMBNAIL;
    }

    // 相対URLやsrcset値も含めて、画像候補として使えるか判定する。
    function isUsableImageValue(value) {
      return isUsableImageUrl(absoluteUrl(firstSrcFromSet(value), "https://example.com"));
    }

    // ロゴ・透明画像・トラッキング画像などをサムネイル候補から除外する。
    function isUsableImageUrl(url) {
      if (!url) return false;
      if (url === CONFIG.FALLBACK_THUMBNAIL) return true;
      let decodedUrl = String(url);
      try {
        decodedUrl = decodeURIComponent(decodedUrl);
      } catch (_error) {
        // URLエンコードが壊れていても、元文字列だけで判定を続ける。
      }

      // JinaやNext.jsの変換URLでは、実画像URLがクエリ内にエンコードされることがある。
      // 元文字列とデコード後の両方を調べ、サイト装飾SVG・ロゴ・アイコンをニュース写真として使わない。
      const target = `${url} ${decodedUrl}`;
      return !/blank\.gif|spacer\.gif|transparent|no[-_]?image|dummy|placeholder|default[-_]?image|avatar|author|\/icons?\/|\/svgs?\/|\.svg(?:[?#&\s]|$)|brand[-_]?icon|racing-brand-icon|logo|favicon|sprite|pixel|tracking|padlock|lock_|chevron|time_solid|search[-_]?icon|menu[-_]?icon|profile[-_]?icon|star[-_]?icon|open_in_new_window|bookmakers?|\/janus\/|trustarc|consent\.|powered-by|advert|sponsor|initials?|monogram|letter[-_]?avatar|data:image\/gif/i.test(target);
    }

    // URLが対象サイトの記事ページらしいか、ホスト・パス・除外語で判定する。
    function isCandidateArticleUrl(value, site) {
      const url = absoluteUrl(value, site.baseUrl);
      if (!url || url.startsWith("data:")) return false;

      let parsed;
      let siteUrl;
      try {
        parsed = new URL(url);
        siteUrl = new URL(site.baseUrl);
      } catch (_error) {
        return false;
      }

      const host = stripWww(parsed.hostname);
      const siteHost = stripWww(siteUrl.hostname);
      const allowedHosts = (site.allowedHosts || []).map(stripWww);
      if (host !== siteHost && !host.endsWith(`.${siteHost}`) && !allowedHosts.includes(host)) return false;

      const path = parsed.pathname.replace(/\/+$/, "") || "/";
      const lowerPath = path.toLowerCase();
      const lowerHref = parsed.href.toLowerCase();
      const sourcePath = new URL(site.url).pathname.replace(/\/+$/, "") || "/";
      if (path === "/" || lowerPath === sourcePath.toLowerCase()) return false;
      if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|mp4|mov|avi|zip)$/i.test(lowerPath)) return false;
      if (/\/(tag|tags|category|categories|author|authors|search|subscribe|subscription|login|signin|sign-in|register|about|contact|privacy|terms|advertise|video|videos|podcast|racecards?|results?|tips?|free-bets?)($|\/)/i.test(lowerPath)) return false;
      if (/\/(newsletter|issues?|editions?|today|rankings?|live|premierleague|football|soccer|uk-news|world-news|royal|tv-guide|null)($|\/)/i.test(lowerPath)) return false;
      if (/\/(the-biz|sales-reports|expert-opinion|breeding-and-bloodstock|bloodstock-sales|sales-calendar|sales-results|stallions?|sires?|features?|columnists?)$/i.test(lowerPath)) return false;
      if (/\/news\/(latest-news|racing|tipping|jockeys|interstate|international|industry|tv-shows|spring-racing|blackbook|null)$/i.test(lowerPath)) return false;
      if ((site.id === "racingpost_news" || site.id === "racingpost_bloodstock") && !/-a[a-z0-9]+\/?$/i.test(lowerPath)) {
        // Racing Postのカテゴリ導線も/news/配下に大量にあるため、記事ID付きURLだけを記事として扱う。
        return false;
      }

      const prefixes = site.pathPrefixes || [];
      if (prefixes.length > 0 && !prefixes.some((prefix) => lowerPath.startsWith(String(prefix).toLowerCase()))) return false;
      const excludedHints = site.excludePathHints || [];
      if (excludedHints.some((hint) => lowerPath.includes(String(hint).toLowerCase()))) return false;

      const hints = site.pathHints || [];
      if (hints.length > 0 && hints.some((hint) => lowerHref.includes(String(hint).toLowerCase()) || lowerPath.includes(String(hint).toLowerCase()))) return true;
      if (hints.length > 0 && !site.includeAnySameHost) return false;
      if (site.includeAnySameHost) return true;
      return /\/(news|racing|bloodstock|articles?|features|sport|horse-racing|breeding|sales|story)\//i.test(lowerPath) || /article-\d+|news-story/i.test(lowerPath);
    }

    // ホスト名比較のために先頭のwwwだけを取り除く。
    function stripWww(hostname) {
      return String(hostname || "").replace(/^www\./i, "");
    }

    // 長いテキストから日付らしい部分だけを抜き出してDateへ変換する。
    function parseDateFromText(value) {
      if (!value) return null;
      if (value instanceof Date) return value;
      const raw = cleanWhitespace(value);
      if (!raw) return null;

      const patterns = [
        /\b\d{4}-\d{1,2}-\d{1,2}T\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/i,
        /\b\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2}(?:\s*(?:am|pm))?)?\b/i,
        /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*,?\s+\d{4}(?:\s+\d{1,2}:\d{2}(?:\s*(?:am|pm))?)?\b/i,
        /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}(?:\s+\d{1,2}:\d{2}(?:\s*(?:am|pm))?)?\b/i,
        /\b\d{1,2}[/-]\d{1,2}[/-]\d{4}(?:\s+\d{1,2}:\d{2}(?:\s*(?:am|pm))?)?\b/i,
        /\b(?:today|yesterday),?\s+\d{1,2}:\d{2}(?:\s*(?:am|pm))?\b/i,
        /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b/i,
        /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b/i,
        /\b\d+\s*(?:minute|minutes|min|mins|hour|hours|hr|hrs|day|days)\s*(?:ago)?\b/i
      ];

      for (const pattern of patterns) {
        const match = raw.match(pattern);
        if (!match) continue;
        const parsed = parseDate(match[0]);
        if (parsed) return parsed;
      }

      // 長い記事カード本文を丸ごとDateへ渡すと、本文中の数字列から12/31などの誤日付を作ることがある。
      // 明示的な日付断片を拾えなかった場合だけ、最後のフォールバックとしてブラウザ標準の解釈を使う。
      const direct = parseDate(raw);
      if (direct) return direct;

      return null;
    }

    // 多様な英語圏ニュースの日付表記をDateへ変換する中心処理。
    function parseDate(value) {
      if (!value) return null;
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
      if (typeof value === "number") {
        const timestamp = value > 10000000000 ? value : value * 1000;
        const date = new Date(timestamp);
        return Number.isNaN(date.getTime()) ? null : date;
      }
      const raw = cleanWhitespace(value)
        .replace(/\b(Published|Updated|Last updated|Posted|By)\b:?\s*/ig, "")
        .replace(/\b(GMT|BST|IST|EDT|EST|CDT|CST|PDT|PST|AEST|AEDT|NZST|NZDT|HKT)\b/g, "")
        .replace(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+/i, "")
        .trim();
      if (!raw) return null;

      let match = raw.match(/^(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days)\s*(?:ago)?$/i);
      if (match) {
        const amount = Number(match[1]);
        const unit = match[2].toLowerCase();
        const minutes = /day/.test(unit) ? amount * 24 * 60 : /hour|hr/.test(unit) ? amount * 60 : amount;
        return new Date(Date.now() - minutes * 60 * 1000);
      }

      match = raw.match(/yesterday,?\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i);
      if (match) {
        const date = new Date();
        date.setDate(date.getDate() - 1);
        setDateTimeParts(date, match[1], match[2], match[3]);
        return date;
      }

      match = raw.match(/today,?\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i);
      if (match) {
        const date = new Date();
        setDateTimeParts(date, match[1], match[2], match[3]);
        return date;
      }

      if (!/\b(?:19|20)\d{2}\b/.test(raw)) {
        // 年なし表記だけをここで補完する。年あり表記まで通すと「May 2026」を月日として誤解するため必ず年の有無を先に見る。
        match = raw.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)(?:\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?)?$/i);
        if (match) {
          // At The Racesの「Saturday 16 May」は、曜日除去後に「16 May」だけが残る。
          // ここで先に現在年を補完しないと、ブラウザ標準Dateが2001年など古い年として解釈することがある。
          const currentYear = new Date().getFullYear();
          return makeLocalDate(currentYear, monthNumber(match[2]), match[1], match[3] || 0, match[4] || 0, match[5]);
        }

        match = raw.match(/([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?)?$/i);
        if (match) {
          // BloodHorseや英語圏サイトでは「May 16」のように月名が先に来る年なし表記もある。
          // 上と同じくブラウザ標準Dateより前に処理し、今年の記事として3日以内判定に渡す。
          const currentYear = new Date().getFullYear();
          return makeLocalDate(currentYear, monthNumber(match[1]), match[2], match[3] || 0, match[4] || 0, match[5]);
        }
      }

      const native = new Date(raw.replace(/(\d+)(st|nd|rd|th)/gi, "$1"));
      if (!Number.isNaN(native.getTime())) return native;

      match = raw.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?)?/i);
      if (match) return makeLocalDate(match[1], match[2], match[3], match[4] || 0, match[5] || 0, match[6]);

      match = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?)?/i);
      if (match) {
        const first = Number(match[1]);
        const second = Number(match[2]);
        const day = first > 12 ? first : second > 12 ? second : first;
        const month = first > 12 ? second : second > 12 ? first : second;
        return makeLocalDate(match[3], month, day, match[4] || 0, match[5] || 0, match[6]);
      }

      match = raw.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?)?/i);
      if (match) return makeLocalDate(match[3], monthNumber(match[2]), match[1], match[4] || 0, match[5] || 0, match[6]);

      match = raw.match(/([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?)?/i);
      if (match) return makeLocalDate(match[3], monthNumber(match[1]), match[2], match[4] || 0, match[5] || 0, match[6]);

      return null;
    }

    // URLに含まれるYYYY-MM-DDやYYYYMMDDから公開日を補完する。
    function parseDateFromUrl(url) {
      if (!url) return null;
      const raw = String(url);
      let match = raw.match(/\/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})(?:\/|$)/);
      if (match) return makeLocalDate(match[1], match[2], match[3], 0, 0);
      match = raw.match(/(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(?:[^\d]|$)/);
      if (match) return makeLocalDate(match[1], match[2], match[3], 0, 0);
      match = raw.match(/\/(20\d{2})\/([A-Za-z]+)\/(\d{1,2})(?:\/|$)/);
      if (match) return makeLocalDate(match[1], monthNumber(match[2]), match[3], 0, 0);
      return null;
    }

    // 年月日と時刻部品からローカルタイムのDateを作る。
    function makeLocalDate(year, month, day, hour, minute, meridiem) {
      const date = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
      setDateTimeParts(date, hour, minute, meridiem);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    // AM/PM表記も考慮してDateに時分を設定する。
    function setDateTimeParts(date, hour, minute, meridiem) {
      let normalizedHour = Number(hour || 0);
      if (/pm/i.test(meridiem || "") && normalizedHour < 12) normalizedHour += 12;
      if (/am/i.test(meridiem || "") && normalizedHour === 12) normalizedHour = 0;
      date.setHours(normalizedHour, Number(minute || 0), 0, 0);
    }

    // 英語の月名省略表記を1から12の数値へ変換する。
    function monthNumber(value) {
      const key = String(value || "").slice(0, 3).toLowerCase();
      return {
        jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
        jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
      }[key] || 1;
    }

    // URLパスに使う英語の月名を、Date#getMonth()+1から復元する。
    function monthPathName(month) {
      return [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
      ][Number(month) - 1] || "January";
    }

    // 日時が取れない最新一覧の記事を、取得順に少しずつずらして仮配置する。
    function estimateDateForUndatedItem(index) {
      return new Date(Date.now() - index * 20 * 60 * 1000);
    }

    // 現在の表示設定で指定された日数内の記事だけを残す。
    function isWithinWindow(item) {
      return isWithinDays(item, state.activeDaysBack);
    }

    // キャッシュ保持用として、設定メニューで選べる最大日数内の記事だけを残す。
    function isWithinMaxWindow(item) {
      return isWithinDays(item, CONFIG.MAX_DAYS_BACK);
    }

    // 指定した日数内の記事かどうかを共通判定する。
    function isWithinDays(item, daysBack) {
      const now = new Date();
      const cutoff = now.getTime() - daysBack * 24 * 60 * 60 * 1000;
      // 少し未来の時刻は、海外サイトのタイムゾーン差やJST変換の揺れを吸収するため12時間まで許容する。
      return item.publishedAt.getTime() >= cutoff && item.publishedAt.getTime() <= now.getTime() + 12 * 60 * 60 * 1000;
    }

    // 抽出直後の記事候補をURL優先で重複排除する。
    function dedupeRawItems(items) {
      const byKey = new Map();
      items.forEach((item) => {
        const key = (item.url || item.title || "").replace(/[?#].*$/, "").toLowerCase();
        if (!key) return;
        const existing = byKey.get(key);
        if (existing && hasArticleThumbnail(existing)) return;
        if (existing && !hasArticleThumbnail(item)) return;
        byKey.set(key, item);
      });
      return [...byKey.values()];
    }

    // 同じURLの記事候補が複数ある場合、実写真を持つ候補を優先するための判定。
    function hasArticleThumbnail(item) {
      return Boolean(item && item.thumbnail && item.thumbnail !== CONFIG.FALLBACK_THUMBNAIL && isUsableImageValue(item.thumbnail));
    }

    // タイトル全体がMarkdownリンクの場合、表示文字列とリンク先URLを分離する。
    function parseStandaloneMarkdownLink(value) {
      const match = cleanWhitespace(value).match(/^\[([^\]]{1,500})\]\((https?:\/\/[^)]+)\)$/i);
      if (!match) return null;
      return {
        title: match[1],
        url: match[2]
      };
    }

    // 見出し末尾の媒体名や不要な導入語を除去する。
    function cleanTitle(value) {
      return cleanWhitespace(value)
        // Markdownの空リンクだけが見出しとして残った場合は、タイトル扱いせず空文字へ落とす。
        .replace(/^\[\]\(https?:\/\/[^)]+\)$/i, "")
        // Markdownリンク全体がタイトル欄に入った場合は、表示用の文字列だけを残す。
        .replace(/^\[([^\]]+)\]\(https?:\/\/[^)]+\)$/i, "$1")
        .replace(/\s*\|\s*(Racing Post|BloodHorse|Daily Mail Online|Daily Mail|Mirror|SCMP|Racing\.com)\s*$/i, "")
        .replace(/\s*-\s*(Horse Racing News|Racing News)\s*$/i, "")
        .replace(/^(Read more|Premium|Exclusive)\s*:?\s*/i, "")
        .replace(/\s*(Read more|View article|Full story)\s*$/i, "")
        .trim();
    }

    // 改行や連続空白を1つの半角スペースに整える。
    function cleanWhitespace(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    // ナビゲーション文言や短すぎる文字列を除き、見出しらしさを判定する。
    function isLikelyHeadline(title) {
      const clean = cleanTitle(title);
      if (!clean || clean.length < 6 || clean.length > 240) return false;
      if (/^\[\]\(https?:\/\/[^)]+\)$/i.test(clean)) return false;
      if (/^(news|latest news|bloodstock|racing|features|sport|subscribe|sign in|login|register|menu|search|home|more|read more|view all|next|previous|advertisement|privacy policy|terms and conditions|cookie policy)$/i.test(clean)) return false;
      if (/^(raceday live|today's edition|previous editions|global rankings|newsletter sign-up|newsletter|premier league|uk news|view all campaigns|job board)$/i.test(clean)) return false;
      if (/^headlines and features from the thoroughbred industry$/i.test(clean)) return false;
      if (/^(the biz|sales reports|expert opinion|breeding and bloodstock|bloodstock sales|sales calendar|sales results|stallions?|sires?|columnists?)$/i.test(clean)) return false;
      if (/^(facebook|twitter|x|instagram|youtube|tiktok|whatsapp|email|print)$/i.test(clean)) return false;
      if (/^[\d\s:./-]+$/.test(clean)) return false;
      const wordCount = clean.split(/\s+/).filter(Boolean).length;
      return wordCount >= 2 || clean.length >= 16;
    }

    // 相対URLをサイトのbaseUrl基準で絶対URLへ変換する。
    function absoluteUrl(value, baseUrl) {
      if (!value) return "";
      const cleaned = decodeHtmlEntities(String(value).trim());
      if (!cleaned || cleaned.startsWith("data:")) return cleaned;
      try {
        return new URL(cleaned, baseUrl).href;
      } catch (_error) {
        return "";
      }
    }

    // JSONオブジェクト内のURL候補キーから最初に使えるURLを選ぶ。
    function pickUrlFromObject(node) {
      if (!node || typeof node !== "object") return "";
      const direct = pickFirst(node.url, node.href, node.link, node.canonicalUrl, node.webUrl, node.permalink, node.path);
      if (direct) return typeof direct === "string" ? direct : pickUrlFromJsonValue(direct);
      return pickUrlFromJsonValue(node.mainEntityOfPage);
    }

    // 文字列・配列・オブジェクトのいずれかからURL文字列を取り出す。
    function pickUrlFromJsonValue(value) {
      if (!value) return "";
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.map(pickUrlFromJsonValue).find(Boolean) || "";
      if (typeof value === "object") return value.url || value.href || value["@id"] || value.id || "";
      return "";
    }

    // 複数の画像候補から、ニュース写真として使える最初のURLだけを返す。
    function pickUsableImage(...values) {
      const candidates = [];
      values.forEach((value) => collectImageValues(value, candidates));
      return candidates.map(firstSrcFromSet).find(isUsableImageValue) || "";
    }

    // 文字列・配列・代表的な画像オブジェクトを、URL候補の配列へ平坦化する。
    function collectImageValues(value, candidates) {
      if (!value) return;
      if (typeof value === "string") {
        candidates.push(value);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry) => collectImageValues(entry, candidates));
        return;
      }
      if (typeof value !== "object") return;

      [
        value.url,
        value.contentUrl,
        value.src,
        value.href,
        value.thumbnailUrl,
        value.imageUrl,
        value.source_url,
        value.guid
      ].forEach((entry) => collectImageValues(entry, candidates));

      // WordPress REST APIなどは media_details.sizes の中に実画像URLを持つ。
      if (value.media_details && value.media_details.sizes) {
        Object.values(value.media_details.sizes).forEach((size) => collectImageValues(size && size.source_url, candidates));
      }
    }

    // JSON内の画像候補から、利用可能な画像URLを優先して取り出す。
    function pickImageFromJsonValue(value) {
      return pickUsableImage(value);
    }

    // undefined/null/空文字を除き、最初に存在する値を返す。
    function pickFirst(...values) {
      return values.find((value) => value !== undefined && value !== null && value !== "");
    }

    // JSON.parse失敗時に例外を外へ出さずnullを返す。
    function safeJsonParse(value) {
      try {
        return JSON.parse(value);
      } catch (_error) {
        return null;
      }
    }

    // HTMLエンティティをURLや見出しで使いやすい文字へ戻す。
    function decodeHtmlEntities(value) {
      // WordPressは右引用符などを&#8217;のような数値参照で返すため、固定置換ではなくブラウザ標準のHTMLデコードを使う。
      // textarea.valueとして読むだけでDOMへ表示はしないので、見出しにHTMLタグが含まれても実行されない。
      const textarea = document.createElement("textarea");
      textarea.innerHTML = String(value || "");
      return textarea.value;
    }

    // 現在の検索・地域・サイト条件に合わせて、タブ、件数、一覧、状態表示を再描画する。
    function render() {
      const filtered = getFilteredItems();

      // 言語切替でHTML直書き部分も更新されるよう、一覧描画の前に静的文言を同期する。
      renderStaticText();

      // 設定メニューは取得結果とは独立しているため、表示再描画のたびに現在状態をボタンへ反映する。
      renderSettings();

      // 絞り込みの要約はプルダウンを閉じた状態でも見えるため、一覧より先に更新する。
      renderCurrentFilterLabel(filtered);

      // 地域・サイトのボタン群はdetails内に隠れているが、開いた瞬間に最新件数が見えるよう毎回再描画する。
      renderRegionTabs();
      renderSiteTabs();
      renderSummary(filtered);
      renderErrors();

      // カードHTMLをまとめて差し替えた後、imgのerrorハンドラを張り直す。
      elements.newsList.innerHTML = filtered.map((item, index) => renderCard(item, index)).join("");
      attachThumbnailFallbacks();
      scheduleAnimationCleanup();
      elements.emptyState.classList.toggle("is-visible", filtered.length === 0);

      if (!state.isLoading) {
        const query = elements.searchInput.value.trim();
        const regionText = state.activeRegion === "all" ? t("allRegions") : getRegionLabel(state.activeRegion);
        const siteText = state.activeSite === "all" ? t("allSites") : getSiteLabel(state.activeSite);
        const filterText = `${regionText} / ${siteText}`;
        const lastUpdated = t("lastUpdated", { date: state.lastUpdatedAt ? formatDateTime(state.lastUpdatedAt) : "" });
        const dateScopedCount = getDateScopedItems().length;
        const suffix = query
          ? t("searchSuffix", { filter: filterText, count: filtered.length, days: state.activeDaysBack, total: dateScopedCount })
          : t("resultSuffix", { filter: filterText, count: filtered.length });
        if (state.errors.length > 0 && state.allItems.length === 0) {
          setStatus(t("failedStatus"), t("failedNoItems"));
        } else if (state.errors.length > 0) {
          setStatus(t("partialFailedStatus"), joinStatusParts(suffix, lastUpdated));
        } else if (dateScopedCount === 0 && state.allItems.length > 0) {
          setStatus(t("noWindowStatus"), t("noWindowMessage", { days: state.activeDaysBack }));
        } else {
          setStatus(state.allItems.length ? t("showingStatus") : t("standbyStatus"), joinStatusParts(suffix, lastUpdated));
        }
      }
    }

    // 言語設定に応じて、HTML直書きのラベルやplaceholderをまとめて更新する。
    function renderStaticText() {
      document.documentElement.lang = t("htmlLang");
      document.title = t("appTitle");
      elements.pageTitle.textContent = t("appTitle");
      elements.searchLabel.textContent = t("searchLabel");
      elements.searchInput.placeholder = t("searchPlaceholder");
      elements.settingsSummaryLabel.textContent = t("settings");
      elements.darkModeLabel.textContent = t("darkMode");
      elements.darkModeToggle.setAttribute("aria-label", t("darkMode"));
      elements.languageSettingLabel.textContent = t("language");
      elements.languageSelect.setAttribute("aria-label", t("language"));
      elements.daysSettingLabel.textContent = t("daysSetting");
      elements.daysOptions.setAttribute("aria-label", t("daysSetting"));
      elements.filterSummaryLabel.textContent = t("filter");
      elements.regionFilterLabel.textContent = t("region");
      elements.regionTabs.setAttribute("aria-label", t("region"));
      elements.siteFilterLabel.textContent = t("site");
      elements.siteTabs.setAttribute("aria-label", t("site"));
      elements.emptyState.textContent = t("emptyState");
      if (!state.isLoading) elements.refreshButton.textContent = t("refresh");
    }

    // 設定メニュー内の日数ボタン、ダークモード表示、サブタイトルを現在状態に合わせる。
    function renderSettings() {
      elements.darkModeToggle.checked = state.darkMode;
      elements.languageSelect.value = state.language;
      elements.currentSettingsLabel.textContent = t("currentSettings", {
        days: state.activeDaysBack,
        theme: state.darkMode ? t("dark") : t("light")
      });
      elements.subtitle.textContent = t("subtitle", { days: state.activeDaysBack });

      // ボタンを毎回作り直すことで、CONFIG.MIN_DAYS_BACK/MAX_DAYS_BACKを変えた場合もUIが自動追従する。
      const options = [];
      for (let day = CONFIG.MIN_DAYS_BACK; day <= CONFIG.MAX_DAYS_BACK; day += 1) {
        const active = day === state.activeDaysBack ? " is-active" : "";
        const pressed = day === state.activeDaysBack ? "true" : "false";
        options.push(`<button class="day-option${active}" type="button" data-days="${day}" aria-pressed="${pressed}">${escapeHtml(t("dayOption", { day }))}</button>`);
      }
      elements.daysOptions.innerHTML = options.join("");
    }

    // 閉じたプルダウン上に、現在選択中の地域・サイト・表示件数を短く表示する。
    function renderCurrentFilterLabel(items) {
      const regionText = state.activeRegion === "all" ? t("allRegions") : getRegionLabel(state.activeRegion);
      const siteText = state.activeSite === "all" ? t("allSites") : getSiteLabel(state.activeSite);

      // 検索語がある場合は、プルダウンを開かなくても絞り込み中だと分かる文言にする。
      const query = elements.searchInput.value.trim();
      elements.currentFilterLabel.textContent = t("currentFilter", { region: regionText, site: siteText, search: query, count: items.length });
    }

    // 地域、サイト、検索語をすべて反映した表示対象ニュースを返す。
    function getFilteredItems() {
      const query = elements.searchInput.value.trim().toLowerCase();
      return getRegionScopedItems()
        // 地域で候補を絞った後、サイトが選ばれていればsourceIdでさらに絞る。
        .filter((item) => state.activeSite === "all" || item.sourceId === state.activeSite)
        .filter((item) => {
          // 検索対象は見出し、媒体名、地域名、URL。入力なしの場合はincludes("")で全件通る。
          const haystack = `${item.title} ${item.source} ${getRegionLabel(item.region)} ${item.url}`.toLowerCase();
          return haystack.includes(query);
        });
    }

    // 最大3日分キャッシュから、現在の取得対象日数に入る記事だけを取り出す。
    function getDateScopedItems() {
      return state.allItems.filter(isWithinWindow);
    }

    // サイトフィルタの前段階として、選択中地域に属するニュースだけを返す。
    function getRegionScopedItems() {
      return getDateScopedItems().filter((item) => state.activeRegion === "all" || item.region === state.activeRegion);
    }

    // 地域変更時に、その地域に存在しないサイト選択を全サイトへ戻す。
    function syncActiveSiteWithRegion() {
      if (state.activeSite === "all" || state.activeRegion === "all") return;
      const site = CONFIG.SITES.find((entry) => entry.id === state.activeSite);
      if (!site || site.region !== state.activeRegion) {
        state.activeSite = "all";
      }
    }

    // 地域別の件数付きタブを描画する。
    function renderRegionTabs() {
      const counts = new Map(REGION_OPTIONS.map((region) => [region.id, 0]));
      const dateScopedItems = getDateScopedItems();
      counts.set("all", dateScopedItems.length);
      dateScopedItems.forEach((item) => {
        // キャッシュ表示時も現在の総件数から地域別件数を再計算する。
        counts.set(item.region, (counts.get(item.region) || 0) + 1);
      });

      elements.regionTabs.innerHTML = REGION_OPTIONS.map((region) => {
        // data-regionにIDを置き、クリックイベント側で状態だけを更新する。
        const active = region.id === state.activeRegion ? " is-active" : "";
        const label = region.id === "all" ? t("allRegions") : getRegionLabel(region.id);
        return `<button class="region-tab${active}" type="button" data-region="${escapeHtml(region.id)}">${escapeHtml(label)} ${counts.get(region.id) || 0}</button>`;
      }).join("");
    }

    // 選択中地域に応じたサイト別の件数付きタブを描画する。
    function renderSiteTabs() {
      const regionScopedItems = getRegionScopedItems();
      const visibleSites = CONFIG.SITES.filter((site) => state.activeRegion === "all" || site.region === state.activeRegion);
      const counts = new Map(visibleSites.map((site) => [site.id, 0]));
      regionScopedItems.forEach((item) => {
        // サイトタブの件数は、選択中地域の中だけで集計する。
        counts.set(item.sourceId, (counts.get(item.sourceId) || 0) + 1);
      });

      const siteOptions = [SITE_ALL, ...visibleSites];
      elements.siteTabs.innerHTML = siteOptions.map((site) => {
        // 全サイトだけは地域内総数、それ以外は媒体別件数を表示する。
        const active = site.id === state.activeSite ? " is-active" : "";
        const count = site.id === "all" ? regionScopedItems.length : counts.get(site.id) || 0;
        const label = site.id === "all" ? t("allSites") : site.name;
        return `<button class="site-tab${active}" type="button" data-site="${escapeHtml(site.id)}">${escapeHtml(label)} ${count}</button>`;
      }).join("");
    }

    // 1件分のニュースカードHTMLを組み立てる。
    function renderCard(item, index = 0) {
      const dateText = item.dateEstimated ? t("dateUnknown") : formatDateTime(item.publishedAt);
      const dateTitle = item.dateEstimated ? t("dateEstimatedTitle", { date: formatDateTime(item.publishedAt) }) : formatDateTime(item.publishedAt);
      const isNew = state.animatedItemIds.has(item.id);
      const className = isNew ? "news-card is-new" : "news-card";
      const animationStyle = isNew ? ` style="--appear-delay: ${Math.min(index, 10) * 28}ms"` : "";
      return `
        <a class="${className}"${animationStyle} href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">
          ${renderThumbnail(item)}
          <div class="news-body">
            <h2 class="headline">${escapeHtml(item.title)}</h2>
            <div class="meta">
              <span class="source-badge">${escapeHtml(item.source)}</span>
              <span class="region-badge">${escapeHtml(getRegionLabel(item.region))}</span>
              <time datetime="${item.publishedAt.toISOString()}" title="${escapeHtml(dateTitle)}">${escapeHtml(dateText)}</time>
            </div>
          </div>
        </a>
      `;
    }

    // 実画像またはダミー画像のどちらを表示するか決める。
    function renderThumbnail(item) {
      if (item.thumbnail === CONFIG.FALLBACK_THUMBNAIL) {
        // ダミー画像は<img>にdata URIを入れるのではなく、divで描画する。
        // 画像読み込みイベントに依存しないため、ダミー画像そのものの読み込み失敗を防げる。
        return renderFallbackThumbnail();
      }

      // 実画像は遅延読み込みにして一覧を軽くする。読み込み失敗時はattachThumbnailFallbacksでdivへ差し替える。
      return `<img class="thumb" src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    }

    // 画像がない記事向けのダミーサムネイル要素を返す。
    function renderFallbackThumbnail() {
      return `<div class="thumb thumb-fallback" aria-hidden="true">${escapeHtml(t("noImage"))}</div>`;
    }

    // 再描画直後にアニメーション用クラスを消すと、速い取得では動きが見えない。
    // CSSアニメーションが終わる少し後に状態とDOMクラスを片付け、次回更新で誤って再アニメーションしないようにする。
    function scheduleAnimationCleanup() {
      if (state.animationClearTimer) {
        window.clearTimeout(state.animationClearTimer);
        state.animationClearTimer = null;
      }

      if (state.animatedItemIds.size === 0) return;

      state.animationClearTimer = window.setTimeout(() => {
        state.animatedItemIds.clear();
        state.animationClearTimer = null;
        elements.newsList.querySelectorAll(".news-card.is-new").forEach((card) => {
          card.classList.remove("is-new");
          card.style.removeProperty("--appear-delay");
        });
      }, 900);
    }

    // 画像読み込み失敗時に、壊れたimgをダミーサムネイルへ差し替える。
    function attachThumbnailFallbacks() {
      elements.newsList.querySelectorAll("img.thumb").forEach((image) => {
        const applyFallback = () => {
          // errorイベントが複数回発火してもreplaceWithを二重実行しないよう、datasetで処理済み印を付ける。
          if (image.dataset.fallbackApplied === "true") return;
          image.dataset.fallbackApplied = "true";
          // 文字列HTMLをtemplateに入れると、余計な親要素を作らず最初の要素だけ安全に取り出せる。
          const wrapper = document.createElement("template");
          wrapper.innerHTML = renderFallbackThumbnail();
          image.replaceWith(wrapper.content.firstElementChild);
        };

        // ネットワークエラー、403画像、Hotlink拒否などはerrorイベントで検知してダミーへ差し替える。
        image.addEventListener("error", applyFallback, { once: true });

        if (!isUsableImageUrl(image.getAttribute("src"))) {
          // 抽出後に不適切なURLが紛れ込んだ場合も、読み込みを待たずに即ダミー化する。
          applyFallback();
        } else if (image.complete && image.naturalWidth === 0) {
          // キャッシュ済みの壊れ画像はerrorイベントより先にcompleteになることがあるため、描画直後にも確認する。
          applyFallback();
        }
      });
    }

    // 現在表示中の記事をサイト別に集計してチップ表示する。
    function renderSummary(items) {
      const counts = new Map(CONFIG.SITES.map((site) => [site.id, { name: site.name, count: 0 }]));
      items.forEach((item) => {
        const entry = counts.get(item.sourceId);
        if (entry) entry.count += 1;
      });

      elements.siteSummary.innerHTML = [...counts.values()]
        .filter((entry) => entry.count > 0)
        .map((entry) => `<span class="chip">${escapeHtml(entry.name)} <span>${entry.count}</span></span>`)
        .join("") || `<span class="chip">${escapeHtml(t("summaryEmpty"))} <span>0</span></span>`;
    }

    // 取得失敗サイト、期間内記事なし、画像なし件数などをステータス領域に表示する。
    function renderErrors() {
      const messages = [
        ...state.errors.map((error) => ({ type: "error", site: error.site, message: error.message })),
        ...buildWindowNotes(),
        ...buildImageNotes()
      ];

      if (messages.length === 0) {
        elements.errorList.classList.remove("is-visible");
        elements.errorList.innerHTML = "";
        return;
      }

      elements.errorList.classList.add("is-visible");
      elements.errorList.innerHTML = messages
        .map((entry) => {
          // エラーと注記を同じ場所に出し、0件・画像なし・プロキシ失敗の理由を見失わないようにする。
          const prefix = entry.type === "error" ? t("errorPrefix") : t("notePrefix");
          return `<div>${escapeHtml(prefix)} ${escapeHtml(entry.site)}: ${escapeHtml(entry.message)}</div>`;
        })
        .join("");
    }

    // 取得はできたが現在の表示日数内に記事が無い媒体を、媒体ごとの最新検出日から説明する。
    function buildWindowNotes() {
      const visibleBySite = new Set(getDateScopedItems().map((item) => item.sourceId));

      return CONFIG.SITES.map((site) => {
        if (visibleBySite.has(site.id)) return null;
        const latestIso = state.siteLatest[site.id];
        if (!latestIso) return null;

        const latestDate = new Date(latestIso);
        if (Number.isNaN(latestDate.getTime())) return null;

        return {
          type: "note",
          site: site.name,
          message: t("latestDetected", { days: state.activeDaysBack, date: formatDateTime(latestDate) })
        };
      }).filter(Boolean);
    }

    // 画像が取得できずダミー表示になっている件数を、必要な場合だけ注記として表示する。
    function buildImageNotes() {
      const dateScopedItems = getDateScopedItems();
      const fallbackCount = dateScopedItems.filter((item) => item.thumbnail === CONFIG.FALLBACK_THUMBNAIL).length;
      if (fallbackCount === 0) return [];

      return [{
        type: "note",
        site: t("thumbnailSite"),
        message: t("thumbnailNote", { count: fallbackCount })
      }];
    }

    // 取得中・表示中・失敗などの現在状態を画面上部に表示する。
    function setStatus(label, message) {
      elements.statusLine.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(message)}</span>`;
    }

    // 現在の言語で、短い状態文を自然につなげる。
    function joinStatusParts(first, second) {
      return state.language === "ja" ? `${first}。${second}` : `${first}. ${second}`;
    }

    // 翻訳キーから表示文言を取得する。関数型の文言には変数を渡して埋め込む。
    function t(key, vars = {}) {
      const dictionary = I18N[state.language] || I18N.ja;
      const value = key.split(".").reduce((current, part) => current && current[part], dictionary);
      if (typeof value === "function") return value(vars);
      if (value !== undefined && value !== null) return value;
      const fallback = key.split(".").reduce((current, part) => current && current[part], I18N.ja);
      return typeof fallback === "function" ? fallback(vars) : fallback || key;
    }

    // 未知の言語コードが保存されていても、対応済み言語へ安全に丸める。
    function normalizeLanguage(value) {
      return Object.prototype.hasOwnProperty.call(I18N, value) ? value : "ja";
    }

    // DateをJSTの月日・時刻表示へ整形する。
    function formatDateTime(date) {
      return new Intl.DateTimeFormat(t("locale"), {
        timeZone: "Asia/Tokyo",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      }).format(date);
    }

    // 地域IDから画面表示用の地域名を返す。
    function getRegionLabel(regionId) {
      return t(`regions.${regionId}`) || (CONFIG.REGIONS.find((entry) => entry.id === regionId) || {}).name || regionId;
    }

    // サイトIDから画面表示用のサイト名を返す。
    function getSiteLabel(siteId) {
      const site = CONFIG.SITES.find((entry) => entry.id === siteId);
      return site ? site.name : siteId;
    }

    // 保存済みフィルタが古い設定を指していても、安全な選択肢へ戻す。
    function normalizeRegionId(regionId) {
      if (regionId === "all") return "all";
      return CONFIG.REGIONS.some((entry) => entry.id === regionId) ? regionId : "all";
    }

    // 保存済みサイトIDが削除済み媒体なら全サイトへ戻す。
    function normalizeSiteId(siteId) {
      if (siteId === "all") return "all";
      return CONFIG.SITES.some((entry) => entry.id === siteId) ? siteId : "all";
    }

    // 日数設定を1〜3日の許容範囲へ丸める。
    function clampDaysBack(value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return CONFIG.DAYS_BACK;
      return Math.min(CONFIG.MAX_DAYS_BACK, Math.max(CONFIG.MIN_DAYS_BACK, Math.round(parsed)));
    }

    // 保存済みの表示設定を復元する。
    function loadSettings() {
      try {
        const cached = JSON.parse(localStorage.getItem(CONFIG.SETTINGS_KEY) || "null");
        if (!cached) return;

        // 日数は将来CONFIG範囲を変えた場合にも壊れないよう、読み込み時に必ず丸める。
        state.activeDaysBack = clampDaysBack(cached.activeDaysBack);
        state.darkMode = Boolean(cached.darkMode);
        state.language = normalizeLanguage(cached.language || state.language);
        state.activeRegion = normalizeRegionId(cached.activeRegion || state.activeRegion);
        state.activeSite = normalizeSiteId(cached.activeSite || state.activeSite);
        syncActiveSiteWithRegion();
      } catch (_error) {
        // 設定JSONが壊れていてもニュース表示は止めない。初期値へ戻してそのまま描画する。
        state.activeDaysBack = CONFIG.DAYS_BACK;
        state.darkMode = false;
        state.language = "ja";
        state.activeRegion = "all";
        state.activeSite = "all";
      }
    }

    // 表示設定をlocalStorageへ保存する。
    function saveSettings() {
      try {
        localStorage.setItem(
          CONFIG.SETTINGS_KEY,
          JSON.stringify({
            activeDaysBack: state.activeDaysBack,
            darkMode: state.darkMode,
            language: state.language,
            activeRegion: state.activeRegion,
            activeSite: state.activeSite
          })
        );
      } catch (_error) {
        state.errors.push({ site: "localStorage", message: t("storageError") });
      }
    }

    // ダークモード設定をbodyクラスへ反映する。
    function applyTheme() {
      // 背景色はCSS変数で管理し、body.is-darkのときだけ完全な黒へ切り替える。
      document.body.classList.toggle("is-dark", state.darkMode);
    }

    // 最後に取得できたニュース一覧をlocalStorageへ保存する。
    function saveCache() {
      try {
        localStorage.setItem(
          CONFIG.CACHE_KEY,
          JSON.stringify({
            lastUpdatedAt: state.lastUpdatedAt && state.lastUpdatedAt.toISOString(),
            siteLatest: state.siteLatest,
            allItems: state.allItems.map((item) => ({
              ...item,
              publishedAt: item.publishedAt.toISOString()
            }))
          })
        );
      } catch (_error) {
        state.errors.push({ site: "localStorage", message: t("cacheError") });
      }
    }

    // localStorageに残っている前回取得結果を復元する。
    function loadCache() {
      try {
        const cached = JSON.parse(localStorage.getItem(CONFIG.CACHE_KEY) || "null");
        if (!cached || !Array.isArray(cached.allItems)) return;

        state.allItems = cached.allItems
          .map((item) => {
            const site = CONFIG.SITES.find((entry) => entry.id === item.sourceId);
            // 取得対象から削除した媒体（例: news.com.au）は、古いキャッシュに残っていても表示へ戻さない。
            if (!site) return null;
            return {
              ...item,
              region: item.region || site.region,
              regionName: item.regionName || getRegionLabel(item.region || site.region),
              publishedAt: new Date(item.publishedAt),
              thumbnail: resolveThumbnail(item.thumbnail, site, item.url)
            };
          })
          .filter(Boolean)
          .filter((item) => !Number.isNaN(item.publishedAt.getTime()))
          .filter(isWithinMaxWindow)
          .sort((a, b) => b.publishedAt - a.publishedAt);
        state.siteLatest = cached.siteLatest && typeof cached.siteLatest === "object" ? cached.siteLatest : {};
        state.lastUpdatedAt = cached.lastUpdatedAt ? new Date(cached.lastUpdatedAt) : null;
      } catch (_error) {
        state.allItems = [];
        state.siteLatest = {};
        state.lastUpdatedAt = null;
      }
    }

    // 画面へ埋め込む文字列をHTMLエスケープしてXSSを避ける。
    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

})();
