(function () {
  const definition = window.JapaneseHorseRacingPortalDefinition;
  const { CONFIG, I18N, SITE_ALL } = definition;

const state = {
      allItems: [],
      errors: [],
      siteLatest: {},
      lastUpdatedAt: null,
      isLoading: false,
      activeSite: "all",
      activeDaysBack: CONFIG.DAYS_BACK,
      darkMode: false,
      language: "ja",
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
      // チェック状態を表示設定の正本として扱い、切替直後に保存とbodyクラス反映を行う。
      state.darkMode = elements.darkModeToggle.checked;
      saveSettings();
      applyTheme();
      renderSettings();
    });
    elements.languageSelect.addEventListener("change", () => {
      // 表示言語はニュースデータとは独立しているため、保存後に画面文言だけ再描画する。
      state.language = normalizeLanguage(elements.languageSelect.value);
      saveSettings();
      render();
    });
    elements.daysOptions.addEventListener("click", (event) => {
      const button = event.target.closest("[data-days]");
      if (!button) return;

      // data属性は文字列なので、範囲外値や壊れた値が来ても1〜3日に丸める。
      state.activeDaysBack = clampDaysBack(button.dataset.days);
      saveSettings();
      render();
      setStatus(t("settingsChangedStatus"), t("settingsChangedMessage", { days: state.activeDaysBack }));
    });
    elements.siteTabs.addEventListener("click", (event) => {
      const button = event.target.closest("[data-site]");
      if (!button) return;
      state.activeSite = button.dataset.site;
      saveSettings();
      render();
    });
    window.addEventListener("DOMContentLoaded", boot);

    window.JapaneseHorseRacingNewsPortal = {
      refresh: refreshAll,
      getSnapshot() {
        return {
          itemCount: state.allItems.length,
          errorCount: state.errors.length,
          lastUpdatedAt: state.lastUpdatedAt && state.lastUpdatedAt.toISOString(),
          activeSite: state.activeSite,
          activeDaysBack: state.activeDaysBack,
          darkMode: state.darkMode,
          language: state.language
        };
      }
    };

    function boot() {
      loadSettings();
      applyTheme();
      loadCache();
      render();
    }

    async function refreshAll() {
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
      const failedSiteIds = new Set();

      // 各媒体は独立しているため、1サイトの失敗で全体表示を止めないようallSettledで並列取得する。
      const results = await Promise.allSettled(CONFIG.SITES.map(fetchSite));
      const fetchedItems = [];

      results.forEach((result, index) => {
        const site = CONFIG.SITES[index];
        if (result.status === "fulfilled") {
          fetchedItems.push(...result.value);
          if (result.value.length > 0) {
            // 期間内記事がない媒体でも「取得はできたが最新が古い」と説明するため、媒体ごとの最新日時を保存する。
            const latestItem = result.value.reduce((latest, item) => !latest || item.publishedAt > latest.publishedAt ? item : latest, null);
            if (latestItem && latestItem.publishedAt) {
              state.siteLatest[site.id] = latestItem.publishedAt.toISOString();
            }
          }
        } else {
          // タイムアウトや一時的なプロキシ制限で失敗した媒体は、あとで前回キャッシュを残すためIDを控える。
          failedSiteIds.add(site.id);
          state.errors.push({
            site: site.name,
            message: result.reason && result.reason.message ? result.reason.message : String(result.reason)
          });
        }
      });

      const preservedFailedItems = getPreservedItemsForFailedSites(previousItems, failedSiteIds);
      const merged = dedupeByUrl([...fetchedItems, ...preservedFailedItems])
        .filter(isWithinMaxWindow)
        .sort((a, b) => b.publishedAt - a.publishedAt);

      if (fetchedItems.length > 0 && merged.length > 0) {
        state.allItems = merged;
        markItemsForAnimation(merged, previousItemIds);
        state.lastUpdatedAt = new Date();
        saveCache();
      } else if (merged.length > 0) {
        // 全サイト失敗時は「更新できた」と誤表示しないよう、時刻とキャッシュ保存は触らず前回表示だけ維持する。
        state.allItems = merged;
      }

      state.isLoading = false;
      elements.refreshButton.disabled = false;
      elements.refreshButton.textContent = t("refresh");

      const visibleCount = getDateScopedItems().length;
      if (visibleCount > 0) {
        setStatus(t("completedStatus"), t("completedMessage", { days: state.activeDaysBack, count: visibleCount }));
      } else if (merged.length > 0) {
        setStatus(t("noWindowStatus"), t("noWindowAfterFetch", { days: state.activeDaysBack }));
      } else if (state.allItems.length > 0) {
        setStatus(t("failedStatus"), t("failedUsingCache"));
      } else {
        setStatus(t("failedStatus"), t("failedNoItems"));
      }

      render();
    }

    function getPreservedItemsForFailedSites(previousItems, failedSiteIds) {
      if (!failedSiteIds.size) return [];

      // 部分失敗時に失敗媒体の記事だけ消えると、ユーザーには「記事がなくなった」ように見える。
      // そのため、成功媒体は新データへ差し替えつつ、失敗媒体だけ前回取得分を混ぜて一覧の連続性を保つ。
      return previousItems.filter((item) => failedSiteIds.has(item.sourceId));
    }

    function markItemsForAnimation(items, previousItemIds) {
      items.forEach((item) => {
        if (item && item.id && !previousItemIds.has(item.id)) {
          state.animatedItemIds.add(item.id);
        }
      });
    }

    async function fetchSite(site) {
      // 東スポ競馬は通常一覧のHTML取得が公開CORSプロキシで不安定なため、専用の安定経路を使う。
      // ニュースサイトマップを記事の正本とし、Reader一覧は見出し・日時・画像の補完に限定する。
      if (site.id === "tospo" && site.sitemapUrl) {
        return fetchTospoStructuredItems(site);
      }

      const html = await fetchText(site.url, site.accept);
      // RSS/AtomはHTMLとして解釈するとlink要素の属性やXML名前空間を失うため、媒体設定の文書型で解析する。
      const doc = new DOMParser().parseFromString(html, site.documentType || "text/html");
      if (site.documentType && doc.querySelector("parsererror")) {
        throw new Error("フィードをXMLとして解析できませんでした");
      }
      const parser = PARSERS[site.parser] || PARSERS.generic;
      const items = parser(doc, site)
        .map((item) => normalizeItem(item, site))
        .filter(Boolean)
        .filter((item) => item.title && item.url && item.publishedAt instanceof Date && !Number.isNaN(item.publishedAt.getTime()));

      if (items.length === 0) {
        throw new Error(t("noExtract"));
      }

      // 一覧側で「...」「…」付きの短い見出ししか出ない媒体は、記事ページのog:title/h1を少数だけ確認する。
      // 追加アクセスを増やしすぎるとプロキシ制限を受けやすいため、媒体ごとにtitleHydrationLimitで上限を置く。
      return hydrateTruncatedTitles(dedupeByUrl(items), site);
    }

    // 東スポ競馬のサイトマップと一覧カードを統合し、記事だけを返す。
    // サイトマップに存在しない固定ページやランキングリンクは、一覧に出ていても採用しない。
    async function fetchTospoStructuredItems(site) {
      const sitemapText = await fetchReaderText(site.sitemapUrl);
      const sitemapItems = extractTospoSitemapItems(sitemapText, site);
      if (sitemapItems.length === 0) {
        throw new Error(t("noExtract"));
      }

      // 一覧の片方が一時的に失敗しても、取得できたページのカードだけで更新を継続する。
      // ただし両方とも失敗した場合は、日時を持たないReaderサイトマップだけでは表示できないため失敗扱いにする。
      const listingResults = await Promise.allSettled(
        site.readerListingUrls.map(async (url) => extractTospoReaderCards(await fetchReaderText(url), site))
      );
      const listingItems = listingResults.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      if (listingItems.length === 0) {
        throw new Error(t("noExtract"));
      }

      const listingByUrl = new Map();
      listingItems.forEach((item) => {
        const key = canonicalArticleUrl(item.url);
        if (key && !listingByUrl.has(key)) listingByUrl.set(key, item);
      });

      const mergedItems = sitemapItems.map((sitemapItem) => {
        const listingItem = listingByUrl.get(canonicalArticleUrl(sitemapItem.url)) || {};
        return {
          title: sitemapItem.title || listingItem.title,
          url: sitemapItem.url,
          publishedAt: sitemapItem.publishedAt || listingItem.publishedAt,
          thumbnail: listingItem.thumbnail || sitemapItem.thumbnail,
          source: site.name
        };
      });

      const normalizedItems = mergedItems
        .map((item) => normalizeItem(item, site))
        .filter(Boolean)
        .filter((item) => /\/breaking_news\/\d+\/?$/i.test(new URL(item.url).pathname));

      if (normalizedItems.length === 0) {
        throw new Error(t("noExtract"));
      }

      return dedupeByUrl(normalizedItems);
    }

    // Jina Readerを直接呼び出す。公開CORSプロキシを二重に通さないため、Reader URLへ通常のfetchを行う。
    async function fetchReaderText(url) {
      return fetchProxyText(CONFIG.TEXT_PROXY(url), CONFIG.TITLE_HYDRATION_TIMEOUT_MS);
    }

    // Google News Sitemapの生XMLと、ReaderがMarkdown化したURL一覧の両方へ対応する。
    // Reader経路では見出し・日時が失われるため空欄のまま返し、一覧カードとの完全URL一致で補完する。
    function extractTospoSitemapItems(text, site) {
      const doc = new DOMParser().parseFromString(text, "application/xml");
      if (!doc.querySelector("parsererror")) {
        return [...doc.getElementsByTagNameNS("*", "url")].map((entry) => ({
          title: textByLocalName(entry, "title"),
          url: textByLocalName(entry, "loc"),
          publishedAt: parseDate(textByLocalName(entry, "publication_date")),
          thumbnail: "",
          source: site.name
        })).filter((item) => isTospoBreakingNewsUrl(item.url));
      }

      const urls = [...String(text || "").matchAll(/\[[^\]]*\]\((https?:\/\/tospo-keiba\.jp\/breaking_news\/\d+)[^)]*\)/gi)]
        .map((match) => match[1]);
      return [...new Set(urls)].map((url) => ({
        title: "",
        url,
        publishedAt: null,
        thumbnail: "",
        source: site.name
      }));
    }

    // Reader一覧のカード行から、完全見出し・記事URL・記事画像と、そのカード直後にある日時を抽出する。
    // origin+pathnameが同じ二つの記事リンクを持つ行だけをカードと認め、広告やランキング画像を除外する。
    function extractTospoReaderCards(text, site) {
      const lines = String(text || "").split(/\r?\n/).map((line) => line.trim());
      const items = [];

      lines.forEach((line, index) => {
        const card = line.match(/\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\]\((https?:\/\/tospo-keiba\.jp\/breaking_news\/\d+)\)(?:!\[[^\]]*\]\([^)]+\))?\s*\[([^\]]+)\]\((https?:\/\/tospo-keiba\.jp\/breaking_news\/\d+)\)/i);
        if (!card || canonicalArticleUrl(card[2]) !== canonicalArticleUrl(card[4])) return;
        if (!/\/images\/article\/thumbnail\//i.test(card[1])) return;

        // Readerでは日時がカード行の後ろへ並ぶ。次の記事カードより前、かつ最大7行だけを探索することで、
        // 隣の記事の日時を誤って流用することを防ぐ。
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
          publishedAt: parseDate(`${date} ${time}`),
          thumbnail: absoluteUrl(card[1], site.baseUrl),
          source: site.name
        });
      });

      return items;
    }

    function isTospoBreakingNewsUrl(value) {
      try {
        const parsed = new URL(value);
        return parsed.origin === "https://tospo-keiba.jp" && /^\/breaking_news\/\d+\/?$/i.test(parsed.pathname);
      } catch (_error) {
        return false;
      }
    }

    // 記事照合では解析クエリ・hash・末尾スラッシュを除き、origin+pathnameだけを正本にする。
    function canonicalArticleUrl(value) {
      try {
        const parsed = new URL(value);
        return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
      } catch (_error) {
        return "";
      }
    }

    async function fetchText(url, accept) {
      const proxyUrls = [
        CONFIG.CORS_PROXY(url),
        ...CONFIG.CORS_PROXY_FALLBACKS.map((buildUrl) => buildUrl(url))
      ];
      let lastError = null;

      for (const proxyUrl of proxyUrls) {
        try {
          return await fetchProxyText(proxyUrl, CONFIG.REQUEST_TIMEOUT_MS, accept);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error(t("fetchFailed"));
    }

    async function fetchProxyText(proxyUrl, timeoutMs = CONFIG.REQUEST_TIMEOUT_MS, accept) {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(proxyUrl, {
          signal: controller.signal,
          headers: { Accept: accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
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
      hochi(doc, site) {
        return [
          ...extractHochiItems(doc, site),
          ...extractJsonLdItems(doc, site),
          ...extractAnchorsWithDates(doc, site, {
            linkSelector: "a[href*='/articles/']",
            datePattern: /(\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2})/
          })
        ];
      },

      nikkan(doc, site) {
        return [
          ...extractJsonLdItems(doc, site),
          ...extractAnchorsWithDates(doc, site, {
            linkSelector: "a[href*='/keiba/news/'], a[href*='/keiba/column/']",
            datePattern: /\[?(\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2})\]?/
          })
        ];
      },

      atom(doc, site) {
        return extractAtomItems(doc, site);
      },

      sponichi(doc, site) {
        return [
          ...extractJsonLdItems(doc, site),
          ...extractAnchorsWithDates(doc, site, {
            linkSelector: "a[href*='/news/']",
            datePattern: /(\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2})/
          })
        ];
      },

      tospo(doc, site) {
        return [
          ...extractTospoArticleList(doc, site),
          ...extractJsonLdItems(doc, site),
          ...extractAnchorsWithTimeElements(doc, site)
        ];
      },

      generic(doc, site) {
        return [
          ...extractJsonLdItems(doc, site),
          ...extractAnchorsWithTimeElements(doc, site),
          ...extractAnchorsWithDates(doc, site, {
            linkSelector: "a[href]",
            datePattern: /(\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}|\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2})/
          })
        ];
      }
    };

    // Atom entryから完全な見出し、記事URL、公開日時、enclosure画像だけを抽出する。
    // 本文やsummaryはポータルに不要なため読み取らず、媒体の配信内容を必要最小限に留める。
    function extractAtomItems(doc, site) {
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
          publishedAt: parseDate(
            textByLocalName(entry, "published") || textByLocalName(entry, "updated")
          ),
          thumbnail: imageLink && imageLink.getAttribute("href"),
          source: site.name
        };
      });
    }

    // XMLのデフォルト名前空間に左右されず、指定localNameの最初の要素から文字列を取り出す。
    function textByLocalName(root, localName) {
      const element = root.getElementsByTagNameNS("*", localName)[0];
      return element ? String(element.textContent || "").replace(/\s+/g, " ").trim() : "";
    }

    function extractHochiItems(doc, site) {
      const items = [];

      doc.querySelectorAll(".article-list__unit, article, li").forEach((container) => {
        // 報知の一覧はリンク全体に配信時刻も含まれるため、リンクtextContentではなくタイトル専用要素を優先する。
        const anchor = container.matches("a[href*='/articles/']")
          ? container
          : container.querySelector("a[href*='/articles/']");
        if (!anchor) return;

        const title = textOf(container, ".article-list__title, h1, h2, h3, h4") || pickTitleForAnchor(anchor, container);
        const timeElement = container.querySelector("time, .article-list__date, [class*='date'], [class*='Date']");
        const dateText = timeElement && (timeElement.getAttribute("datetime") || timeElement.textContent);
        if (!title || !dateText) return;

        items.push({
          title,
          url: anchor.getAttribute("href"),
          publishedAt: parseDate(dateText),
          thumbnail: findImageNear(anchor, site),
          source: site.name
        });
      });

      return items;
    }

    function extractTospoArticleList(doc, site) {
      const component = doc.querySelector("article-list-slug-main");
      const mainData = component && safeJsonParse(component.getAttribute(":main"));
      const articleList = mainData && Array.isArray(mainData.articleList) ? mainData.articleList : [];

      return articleList.map((article) => ({
        title: article.title || article.imgAlt,
        url: article.linkUrl,
        publishedAt: article.date && article.date.date && article.date.time
          ? parseDate(`${article.date.date} ${article.date.time}`)
          : null,
        thumbnail: article.imgUrl,
        source: site.name
      }));
    }

    function extractJsonLdItems(doc, site) {
      const items = [];

      doc.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
        const data = safeJsonParse(script.textContent);
        flattenJsonLd(data).forEach((node) => {
          const type = Array.isArray(node["@type"]) ? node["@type"].join(" ") : node["@type"];
          if (!type || !/NewsArticle|Article|BlogPosting/i.test(type)) return;

          items.push({
            title: node.headline || node.name,
            url: node.url || node.mainEntityOfPage && (node.mainEntityOfPage["@id"] || node.mainEntityOfPage.url),
            publishedAt: parseDate(node.datePublished || node.dateCreated || node.dateModified),
            thumbnail: pickImageFromJsonLd(node.image),
            source: site.name
          });
        });
      });

      return items;
    }

    function flattenJsonLd(input) {
      if (!input) return [];
      const queue = Array.isArray(input) ? [...input] : [input];
      const nodes = [];

      while (queue.length > 0) {
        const node = queue.shift();
        if (!node || typeof node !== "object") continue;
        nodes.push(node);
        if (Array.isArray(node["@graph"])) queue.push(...node["@graph"]);
        if (Array.isArray(node.itemListElement)) {
          node.itemListElement.forEach((entry) => {
            if (entry && typeof entry === "object") {
              queue.push(entry.item || entry);
            }
          });
        }
      }

      return nodes;
    }

    function extractAnchorsWithTimeElements(doc, site) {
      const items = [];

      doc.querySelectorAll("time").forEach((timeElement) => {
        const card = closestUsefulContainer(timeElement);
        const anchor = card && card.querySelector("a[href]");
        if (!anchor) return;

        items.push({
          title: pickTitleForAnchor(anchor, card),
          url: anchor.getAttribute("href"),
          publishedAt: parseDate(timeElement.getAttribute("datetime") || timeElement.textContent),
          thumbnail: findImageNear(anchor, site),
          source: site.name
        });
      });

      return items;
    }

    function extractAnchorsWithDates(doc, site, options) {
      const items = [];
      const seen = new Set();

      doc.querySelectorAll(options.linkSelector).forEach((anchor) => {
        const container = closestUsefulContainer(anchor);
        const title = pickTitleForAnchor(anchor, container);
        if (!isLikelyHeadline(title)) return;

        const text = [anchor.textContent, container && container.textContent, anchor.getAttribute("aria-label"), anchor.getAttribute("title")]
          .filter(Boolean)
          .join(" ");
        const match = text.match(options.datePattern);
        if (!match) return;

        const url = absoluteUrl(anchor.getAttribute("href"), site.baseUrl);
        if (!url || seen.has(url)) return;
        seen.add(url);

        items.push({
          title,
          url,
          publishedAt: parseDate(match[1]),
          thumbnail: findImageNear(anchor, site),
          source: site.name
        });
      });

      return items;
    }

    function normalizeItem(raw, site) {
      const url = absoluteUrl(raw.url, site.baseUrl);
      const title = cleanTitle(raw.title);
      const publishedAt = raw.publishedAt instanceof Date ? raw.publishedAt : parseDate(raw.publishedAt);

      if (!url || !isCandidateArticleUrl(url, site) || !title || !publishedAt) return null;

      return {
        id: `${site.id}:${url}`,
        sourceId: site.id,
        source: raw.source || site.name,
        title,
        url,
        publishedAt,
        thumbnail: resolveThumbnail(raw.thumbnail, site, url)
      };
    }

    function closestUsefulContainer(element) {
      return element.closest(
        "article, li, dl, [class*='article'], [class*='news'], [class*='story'], [class*='card'], section, div"
      ) || element.parentElement;
    }

    function textOf(root, selector) {
      const node = root && root.querySelector(selector);
      return node ? cleanTitle(node.textContent) : "";
    }

    function attrOf(root, selector, attr) {
      const node = root && root.querySelector(selector);
      return node ? node.getAttribute(attr) || "" : "";
    }

    function pickTitleForAnchor(anchor, container) {
      // 多くのニュース一覧ではリンク要素の中に「見出し」「日時」「カテゴリ」が同居する。
      // そのままanchor.textContentを読むと報知の配信時刻などが混ざるため、見出しらしい子要素を先に見る。
      const titleNode = container && container.querySelector(
        "h1, h2, h3, h4, [class*='headline'], [class*='Headline'], [class*='title'], [class*='Title']"
      );
      const candidates = [
        titleNode && titleNode.textContent,
        anchor.getAttribute("aria-label"),
        anchor.getAttribute("title"),
        attrOf(anchor, "img[alt]", "alt"),
        anchor.textContent
      ];

      // 候補は上から信頼度順。短すぎるものやUI文言を避け、最初に見出しとして使える文字列を採用する。
      for (const candidate of candidates) {
        const title = cleanTitle(candidate);
        if (isLikelyHeadline(title)) return title;
      }

      return cleanTitle(anchor.textContent);
    }

    async function hydrateTruncatedTitles(items, site) {
      if (!site.hydrateTruncatedTitles) return items;

      const limit = site.titleHydrationLimit || 6;
      const targets = items
        // 省略記号のない見出しは一覧側のタイトルをそのまま信頼する。
        // 省略見出しだけに絞ることで、記事ページへの追加アクセスを必要最小限にする。
        .filter((item) => isTruncatedTitle(item.title))
        // 日刊スポーツのように同じ一覧内に重複セクションやランキング枠が混ざる媒体では、
        // DOMに出てきた順番とポータル上の表示順が一致しない。画面に出やすい新しい記事から補完する。
        .sort((a, b) => b.publishedAt - a.publishedAt)
        .slice(0, limit);

      if (targets.length === 0) return items;

      const hydratedPairs = await Promise.all(targets.map(async (item) => {
        try {
          // 記事ページ補完は補助処理なので、通常取得より短い上限時間で切り上げる。
          // 1サイト内では並列に走らせ、見出し補完待ちで更新全体が長く止まらないようにする。
          const articleHtml = await fetchTitleHydrationTextWithDeadline(item.url, CONFIG.TITLE_HYDRATION_TIMEOUT_MS);
          const fullTitle = extractFullTitleFromArticle(articleHtml, item.title);
          return [item.url, preferFullTitle(item.title, fullTitle)];
        } catch (_error) {
          // 記事ページ側の取得に失敗しても、一覧の省略見出しで表示継続する。
          // ここをエラー扱いにすると、ヘッドライン自体が取れているサイトまで失敗表示になってしまう。
          return [item.url, item.title];
        }
      }));

      const hydratedTitleByUrl = new Map(hydratedPairs);
      return items.map((item) => {
        const title = hydratedTitleByUrl.get(item.url);
        return title ? { ...item, title } : item;
      });
    }

    async function fetchTitleHydrationTextWithDeadline(url, timeoutMs) {
      const request = fetchTitleHydrationText(url);
      request.catch(() => {
        // Promise.raceでタイムアウトした後に記事ページ補完側が失敗しても、未処理例外にしないための吸収。
      });

      return Promise.race([
        request,
        new Promise((_, reject) => {
          window.setTimeout(() => reject(new Error(t("timeout"))), timeoutMs);
        })
      ]);
    }

    async function fetchTitleHydrationText(url) {
      // 見出し補完は記事ページを読む補助処理。日刊スポーツの記事ページはAllOriginsが遅く失敗し、
      // CodeTabsが成功しやすいため、通常取得とは別にCodeTabsを先に試して省略見出しを補完しやすくする。
      const proxyUrls = [
        CONFIG.TEXT_PROXY(url),
        CONFIG.CORS_PROXY(url),
        CONFIG.CORS_PROXY_FALLBACKS[1](url),
        CONFIG.CORS_PROXY_FALLBACKS[0](url)
      ];
      let lastError = null;

      for (const proxyUrl of proxyUrls) {
        try {
          return await fetchProxyText(proxyUrl, CONFIG.TITLE_HYDRATION_TIMEOUT_MS);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error(t("fetchFailed"));
    }

    function extractFullTitleFromArticle(html, fallbackTitle) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const candidates = [
        extractReaderTitleCandidate(html),
        doc.querySelector("meta[property='og:title']") && doc.querySelector("meta[property='og:title']").getAttribute("content"),
        doc.querySelector("meta[name='twitter:title']") && doc.querySelector("meta[name='twitter:title']").getAttribute("content"),
        doc.querySelector("h1") && doc.querySelector("h1").textContent,
        doc.title
      ];

      // JSON-LDはmetaやh1より整っている場合があるため、記事構造があれば候補へ追加する。
      doc.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
        const data = safeJsonParse(script.textContent);
        flattenJsonLd(data).forEach((node) => {
          if (node && (node.headline || node.name)) {
            candidates.push(node.headline || node.name);
          }
        });
      });

      return candidates
        .map((candidate) => cleanArticleTitle(candidate))
        .find((candidate) => preferFullTitle(fallbackTitle, candidate) === candidate) || "";
    }

    function extractReaderTitleCandidate(value) {
      // Jina ReaderはHTMLではなくMarkdown風テキストを返すため、DOMParserだけでは見出し候補を拾えない。
      // 先頭のTitle行を最優先し、無い場合は本文冒頭のMarkdown見出しを補完候補にする。
      const text = String(value || "");
      const titleMatch = text.match(/^Title:\s*(.+)$/im);
      if (titleMatch) return titleMatch[1];

      const headingMatch = text.match(/^#\s+(.+)$/m);
      return headingMatch ? headingMatch[1] : "";
    }

    function cleanArticleTitle(value) {
      return cleanTitle(value)
        // 日刊スポーツの記事ページtitleは「- 共通 | 競馬 : 日刊スポーツ」のようにカテゴリ名が入る場合がある。
        // カテゴリ名は媒体側のページタイトル用メタ情報なので、ポータルの見出しからは除去する。
        .replace(/\s*-\s*(?:[^|]{1,16}\s*\|\s*)?競馬\s*:\s*日刊スポーツ\s*$/i, "")
        .replace(/\s*[|-]\s*(スポーツ報知|日刊スポーツ|東スポ競馬|サンスポ|SANSPO\.COM|スポニチ競馬Web|スポニチ)\s*$/i, "")
        .trim();
    }

    function isTruncatedTitle(title) {
      // 日刊スポーツは「馬名…／レース名」のように、末尾以外にも一覧専用の省略記号を入れる。
      // 正式見出しにも三点リーダーが残る場合はpreferFullTitle側で採用しないため、候補抽出は広めに行う。
      return /(…|\.{3}|‥)/.test(cleanArticleTitle(title));
    }

    function preferFullTitle(currentTitle, candidateTitle) {
      const current = cleanTitle(currentTitle);
      const candidate = cleanArticleTitle(candidateTitle);
      if (!candidate || !isLikelyHeadline(candidate)) return current;

      // 省略記号が残る候補でも、記事ページ側の正式見出しに会話文として「…」が入る場合がある。
      // 一覧より明らかに長い場合は記事ページ候補を採用し、同程度なら一覧の省略見出しとみなして戻す。
      if (isTruncatedTitle(candidate)) {
        const currentWithoutMarks = current.replace(/…|\.{3}|‥/g, "");
        const candidateWithoutMarks = candidate.replace(/…|\.{3}|‥/g, "");
        if (
          isTruncatedTitle(current) &&
          candidate.length >= current.length + 4 &&
          candidateWithoutMarks.length > currentWithoutMarks.length
        ) {
          return candidate;
        }
        return current;
      }

      // 現在タイトルが省略されていて、候補の方が十分長ければ記事ページ側を優先する。
      if (isTruncatedTitle(current) && candidate.length >= current.replace(/…|\.{3}|‥/g, "").length) {
        return candidate;
      }

      return current;
    }

    function findImageNear(anchor, site) {
      const containers = collectImageSearchContainers(anchor);
      for (const container of containers) {
        const candidates = collectImageCandidates(container);
        for (const candidate of candidates) {
          const resolved = resolveThumbnail(candidate, site, anchor.getAttribute("href"));
          if (resolved !== CONFIG.FALLBACK_THUMBNAIL) return resolved;
        }
      }
      return resolveThumbnail("", site, anchor.getAttribute("href"));
    }

    function collectImageSearchContainers(anchor) {
      const containers = [anchor];
      let current = anchor.parentElement;
      let depth = 0;
      while (current && depth < 5) {
        containers.push(current);
        if (current.matches("article, li, dl, [class*='item'], [class*='card'], [class*='story']")) {
          break;
        }
        current = current.parentElement;
        depth += 1;
      }

      return [...new Set(containers)].filter(Boolean);
    }

    function collectImageCandidates(container) {
      const candidates = [];

      container.querySelectorAll("source, img").forEach((element) => {
        candidates.push(
          element.getAttribute("data-srcset"),
          element.getAttribute("data-lazy-srcset"),
          element.getAttribute("srcset"),
          element.getAttribute("data-src"),
          element.getAttribute("data-original"),
          element.getAttribute("data-lazy-src"),
          element.getAttribute("data-original-src"),
          element.getAttribute("data-image"),
          extractCssBackgroundUrl(element.getAttribute("style")),
          element.getAttribute("src")
        );
      });

      candidates.push(extractCssBackgroundUrl(container.getAttribute("style")));
      return candidates.map(firstSrcFromSet).filter(isUsableImageValue);
    }

    function firstSrcFromSet(value) {
      if (!value) return "";
      if (String(value).trim().startsWith("data:")) return String(value).trim();
      return String(value).split(",")[0].trim().split(/\s+/)[0];
    }

    function extractCssBackgroundUrl(style) {
      if (!style) return "";
      const match = String(style).match(/background(?:-image)?\s*:\s*url\((['"]?)(.*?)\1\)/i);
      return match ? match[2] : "";
    }

    function resolveThumbnail(value, site, articleUrl) {
      const direct = absoluteUrl(firstSrcFromSet(value), site.baseUrl);
      if (isUsableImageUrl(direct)) return direct;

      const inferred = inferThumbnailFromArticleUrl(articleUrl, site);
      if (isUsableImageUrl(inferred)) return inferred;

      return CONFIG.FALLBACK_THUMBNAIL;
    }

    function inferThumbnailFromArticleUrl(articleUrl, site) {
      const url = absoluteUrl(articleUrl, site.baseUrl);
      if (!url || site.id !== "nikkan") return "";

      try {
        const parsed = new URL(url);
        parsed.pathname = parsed.pathname.replace(/\/([^/]+)\.html$/, "/img/$1-w200_0.jpg");
        return parsed.href;
      } catch (_error) {
        return "";
      }
    }

    function isUsableImageValue(value) {
      return isUsableImageUrl(absoluteUrl(firstSrcFromSet(value), "https://example.com"));
    }

    function isUsableImageUrl(url) {
      if (!url) return false;
      if (url === CONFIG.FALLBACK_THUMBNAIL) return true;
      return !/blank\.gif|spacer\.gif|transparent|noimage|dummy|ogp_default|thumb_[^/]*_og|\/icons?\/|logo|favicon|data:image\/gif/i.test(url);
    }

    function parseDate(value) {
      if (!value) return null;
      const raw = String(value).trim();

      const native = new Date(raw);
      if (!Number.isNaN(native.getTime())) return native;

      let match = raw.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
      if (match) return makeJstDate(match[1], match[2], match[3], match[4], match[5]);

      match = raw.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s*(\d{1,2}):(\d{2})/);
      if (match) return makeJstDate(match[1], match[2], match[3], match[4], match[5]);

      match = raw.match(/(\d{1,2})月\s*(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
      if (match) {
        const nowJst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
        return makeJstDate(nowJst.getFullYear(), match[1], match[2], match[3], match[4]);
      }

      return null;
    }

    function makeJstDate(year, month, day, hour, minute) {
      const utcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 9, Number(minute));
      return new Date(utcMs);
    }

    function isWithinWindow(item) {
      return isWithinDays(item, state.activeDaysBack);
    }

    function isWithinMaxWindow(item) {
      return isWithinDays(item, CONFIG.MAX_DAYS_BACK);
    }

    function isWithinDays(item, daysBack) {
      const now = new Date();
      const cutoff = now.getTime() - daysBack * 24 * 60 * 60 * 1000;
      return item.publishedAt.getTime() >= cutoff && item.publishedAt.getTime() <= now.getTime() + 60 * 60 * 1000;
    }

    function dedupeByUrl(items) {
      const byUrl = new Map();
      items.forEach((item) => {
        const key = item.url.replace(/[?#].*$/, "");
        const existing = byUrl.get(key);
        if (!existing || item.publishedAt > existing.publishedAt) {
          byUrl.set(key, item);
        }
      });
      return [...byUrl.values()];
    }

    function cleanTitle(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .replace(/^競馬\s*/, "")
        .replace(/\s*\[?記事へ\]?\s*$/g, "")
        // 報知などでリンク内に混ざる配信時刻を最後尾から落とす。タイトル中の数字やレース名は消さない。
        .replace(/\s*(?:\d{4}年\s*\d{1,2}月\s*\d{1,2}日|\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}月\s*\d{1,2}日)\s+\d{1,2}:\d{2}\s*$/g, "")
        .replace(/\s*\[?\d{1,2}月\s*\d{1,2}日\s+\d{1,2}:\d{2}\]?\s*$/g, "")
        .trim();
    }

    function isLikelyHeadline(title) {
      if (!title || title.length < 8) return false;
      if (/^(TOP|ログイン|ニュース|検索|Page TOP|メニュー|初めての方はこちら)$/i.test(title)) return false;
      return true;
    }

    function isCandidateArticleUrl(value, site) {
      const url = absoluteUrl(value, site.baseUrl);
      if (!url) return false;

      try {
        const parsed = new URL(url);
        const base = new URL(site.baseUrl);
        const protocolAllowed = parsed.protocol === "https:" || parsed.protocol === "http:";
        return protocolAllowed && stripWww(parsed.hostname) === stripWww(base.hostname);
      } catch (_error) {
        return false;
      }
    }

    function stripWww(hostname) {
      return String(hostname || "").replace(/^www\./i, "");
    }

    function absoluteUrl(value, baseUrl) {
      if (!value) return "";
      const cleaned = String(value).trim();
      if (!cleaned || cleaned.startsWith("data:")) return cleaned;
      try {
        return new URL(cleaned, baseUrl).href;
      } catch (_error) {
        return "";
      }
    }

    function pickImageFromJsonLd(image) {
      if (!image) return "";
      if (typeof image === "string") return image;
      if (Array.isArray(image)) {
        return image.map(pickImageFromJsonLd).find(isUsableImageValue) || pickImageFromJsonLd(image[0]);
      }
      return image.url || image.contentUrl || "";
    }

    function safeJsonParse(value) {
      try {
        return JSON.parse(value);
      } catch (_error) {
        return null;
      }
    }

    function render() {
      const filtered = getFilteredItems();

      renderStaticText();
      renderSettings();
      renderCurrentFilterLabel(filtered);
      renderSiteTabs();
      renderSummary(filtered);
      renderErrors();
      elements.newsList.innerHTML = filtered.map((item, index) => renderCard(item, index)).join("");
      attachThumbnailFallbacks();
      scheduleAnimationCleanup();
      elements.emptyState.classList.toggle("is-visible", filtered.length === 0);

      if (!state.isLoading) {
        const query = elements.searchInput.value.trim();
        const siteText = state.activeSite === "all" ? t("allSites") : getSiteLabel(state.activeSite);
        const lastUpdated = t("lastUpdated", { date: state.lastUpdatedAt ? formatDateTime(state.lastUpdatedAt) : "" });
        const dateScopedCount = getDateScopedItems().length;
        const suffix = query
          ? t("searchSuffix", { site: siteText, count: filtered.length, days: state.activeDaysBack, total: dateScopedCount })
          : t("resultSuffix", { site: siteText, count: filtered.length });
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

    function renderStaticText() {
      document.documentElement.lang = t("htmlLang");
      document.title = t("appTitle");
      elements.pageTitle.textContent = t("appTitle");
      elements.subtitle.textContent = t("subtitle", { days: state.activeDaysBack });
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
      elements.siteFilterLabel.textContent = t("site");
      elements.siteTabs.setAttribute("aria-label", t("site"));
      elements.emptyState.textContent = t("emptyState");
      if (!state.isLoading) elements.refreshButton.textContent = t("refresh");
    }

    function renderSettings() {
      elements.darkModeToggle.checked = state.darkMode;
      elements.languageSelect.value = state.language;
      elements.currentSettingsLabel.textContent = t("currentSettings", {
        days: state.activeDaysBack,
        theme: state.darkMode ? t("dark") : t("light")
      });

      // CONFIG.MIN_DAYS_BACK/MAX_DAYS_BACKを変えるだけで、設定ボタンも自動で増減するよう毎回生成する。
      const options = [];
      for (let day = CONFIG.MIN_DAYS_BACK; day <= CONFIG.MAX_DAYS_BACK; day += 1) {
        const active = day === state.activeDaysBack ? " is-active" : "";
        const pressed = day === state.activeDaysBack ? "true" : "false";
        options.push(`<button class="day-option${active}" type="button" data-days="${day}" aria-pressed="${pressed}">${escapeHtml(t("dayOption", { day }))}</button>`);
      }
      elements.daysOptions.innerHTML = options.join("");
    }

    function renderCurrentFilterLabel(items) {
      const siteText = state.activeSite === "all" ? t("allSites") : getSiteLabel(state.activeSite);
      const query = elements.searchInput.value.trim();
      elements.currentFilterLabel.textContent = t("currentFilter", { site: siteText, search: query, count: items.length });
    }

    function getFilteredItems() {
      const query = elements.searchInput.value.trim().toLowerCase();
      return getDateScopedItems()
        .filter((item) => state.activeSite === "all" || item.sourceId === state.activeSite)
        .filter((item) => {
          // 検索対象は見出し、媒体名、URL。URLも含めると同名記事や媒体名が曖昧な場合に絞りやすい。
          const haystack = `${item.title} ${item.source} ${item.url}`.toLowerCase();
          return haystack.includes(query);
        });
    }

    function getDateScopedItems() {
      return state.allItems.filter(isWithinWindow);
    }

    function renderSiteTabs() {
      const dateScopedItems = getDateScopedItems();
      const counts = new Map(CONFIG.SITES.map((site) => [site.id, 0]));
      dateScopedItems.forEach((item) => {
        counts.set(item.sourceId, (counts.get(item.sourceId) || 0) + 1);
      });

      const siteOptions = [SITE_ALL, ...CONFIG.SITES];
      elements.siteTabs.innerHTML = siteOptions.map((site) => {
        const active = site.id === state.activeSite ? " is-active" : "";
        const count = site.id === "all" ? dateScopedItems.length : counts.get(site.id) || 0;
        const label = site.id === "all" ? t("allSites") : site.name;
        return `<button class="site-tab${active}" type="button" data-site="${escapeHtml(site.id)}">${escapeHtml(label)} ${count}</button>`;
      }).join("");
    }

    function renderCard(item, index = 0) {
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
              <time datetime="${item.publishedAt.toISOString()}">${formatDateTime(item.publishedAt)}</time>
            </div>
          </div>
        </a>
      `;
    }

    function renderThumbnail(item) {
      if (item.thumbnail === CONFIG.FALLBACK_THUMBNAIL) {
        return renderFallbackThumbnail();
      }

      return `<img class="thumb" src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    }

    function renderFallbackThumbnail() {
      return `<div class="thumb thumb-fallback" aria-hidden="true">${escapeHtml(t("noImage"))}</div>`;
    }

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

    function attachThumbnailFallbacks() {
      elements.newsList.querySelectorAll("img.thumb").forEach((image) => {
        const applyFallback = () => {
          if (image.dataset.fallbackApplied === "true") return;
          image.dataset.fallbackApplied = "true";
          const wrapper = document.createElement("template");
          wrapper.innerHTML = renderFallbackThumbnail();
          image.replaceWith(wrapper.content.firstElementChild);
        };

        image.addEventListener("error", applyFallback, { once: true });

        if (!isUsableImageUrl(image.getAttribute("src"))) {
          applyFallback();
        } else if (image.complete && image.naturalWidth === 0) {
          applyFallback();
        }
      });
    }

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
          const prefix = entry.type === "error" ? t("errorPrefix") : t("notePrefix");
          return `<div>${escapeHtml(prefix)} ${escapeHtml(entry.site)}: ${escapeHtml(entry.message)}</div>`;
        })
        .join("");
    }

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

    function buildImageNotes() {
      const fallbackCount = getDateScopedItems().filter((item) => item.thumbnail === CONFIG.FALLBACK_THUMBNAIL).length;
      if (fallbackCount === 0) return [];

      return [{
        type: "note",
        site: t("thumbnailSite"),
        message: t("thumbnailNote", { count: fallbackCount })
      }];
    }

    function setStatus(label, message) {
      elements.statusLine.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(message)}</span>`;
    }

    function joinStatusParts(first, second) {
      return state.language === "ja" ? `${first}。${second}` : `${first}. ${second}`;
    }

    function t(key, vars = {}) {
      const dictionary = I18N[state.language] || I18N.ja;
      const value = key.split(".").reduce((current, part) => current && current[part], dictionary);
      if (typeof value === "function") return value(vars);
      if (value !== undefined && value !== null) return value;
      const fallback = key.split(".").reduce((current, part) => current && current[part], I18N.ja);
      return typeof fallback === "function" ? fallback(vars) : fallback || key;
    }

    function normalizeLanguage(value) {
      return Object.prototype.hasOwnProperty.call(I18N, value) ? value : "ja";
    }

    function formatDateTime(date) {
      return new Intl.DateTimeFormat(t("locale"), {
        timeZone: "Asia/Tokyo",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      }).format(date);
    }

    function getSiteLabel(siteId) {
      const site = CONFIG.SITES.find((entry) => entry.id === siteId);
      return site ? site.name : siteId;
    }

    function normalizeSiteId(siteId) {
      if (siteId === "all") return "all";
      return CONFIG.SITES.some((entry) => entry.id === siteId) ? siteId : "all";
    }

    function clampDaysBack(value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return CONFIG.DAYS_BACK;
      return Math.min(CONFIG.MAX_DAYS_BACK, Math.max(CONFIG.MIN_DAYS_BACK, Math.round(parsed)));
    }

    function loadSettings() {
      try {
        const cached = JSON.parse(localStorage.getItem(CONFIG.SETTINGS_KEY) || "null");
        if (!cached) return;

        state.activeDaysBack = clampDaysBack(cached.activeDaysBack);
        state.darkMode = Boolean(cached.darkMode);
        state.language = normalizeLanguage(cached.language || state.language);
        state.activeSite = normalizeSiteId(cached.activeSite || state.activeSite);
      } catch (_error) {
        // 設定JSONが壊れていても、ニュース閲覧は初期設定で続けられるよう握りつぶす。
        state.activeDaysBack = CONFIG.DAYS_BACK;
        state.darkMode = false;
        state.language = "ja";
        state.activeSite = "all";
      }
    }

    function saveSettings() {
      try {
        localStorage.setItem(
          CONFIG.SETTINGS_KEY,
          JSON.stringify({
            activeDaysBack: state.activeDaysBack,
            darkMode: state.darkMode,
            language: state.language,
            activeSite: state.activeSite
          })
        );
      } catch (_error) {
        state.errors.push({ site: "localStorage", message: t("storageError") });
      }
    }

    function applyTheme() {
      // bodyクラスだけを切り替え、実際の色はCSS変数へ任せる。ダーク時の背景は有機EL向けに完全な黒。
      document.body.classList.toggle("is-dark", state.darkMode);
    }

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

    function loadCache() {
      try {
        const cached = JSON.parse(localStorage.getItem(CONFIG.CACHE_KEY) || "null");
        if (!cached || !Array.isArray(cached.allItems)) return;

        state.allItems = cached.allItems
          .map((item) => {
            const site = CONFIG.SITES.find((entry) => entry.id === item.sourceId);
            if (!site) return null;
            return {
              ...item,
              publishedAt: new Date(item.publishedAt),
              thumbnail: resolveThumbnail(item.thumbnail, site, item.url)
            };
          })
          .filter(Boolean)
          .filter((item) => !Number.isNaN(item.publishedAt.getTime()))
          .filter(isWithinMaxWindow)
          .sort((a, b) => b.publishedAt - a.publishedAt);
        state.siteLatest = cached.siteLatest || {};
        state.lastUpdatedAt = cached.lastUpdatedAt ? new Date(cached.lastUpdatedAt) : null;
      } catch (_error) {
        state.allItems = [];
        state.siteLatest = {};
        state.lastUpdatedAt = null;
      }
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

})();
