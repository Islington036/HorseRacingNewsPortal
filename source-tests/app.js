import { runSourceTest } from "./core.js";
import { SOURCES } from "./sources.js";

const elements = {
  sourceSelect: document.querySelector("#sourceSelect"),
  runButton: document.querySelector("#runButton"),
  status: document.querySelector("#status"),
  metrics: document.querySelector("#metrics"),
  results: document.querySelector("#results")
};

initialize();

// 登録済み媒体を選択肢へ反映し、?source=ID&autorun=1なら指定媒体だけを自動実行する。
function initialize() {
  renderSourceOptions();
  elements.runButton.addEventListener("click", runSelectedSource);

  const params = new URLSearchParams(window.location.search);
  const requestedSource = params.get("source");
  if (requestedSource && SOURCES.some((source) => source.id === requestedSource)) {
    elements.sourceSelect.value = requestedSource;
  }
  if (params.get("autorun") === "1" && elements.sourceSelect.value) {
    runSelectedSource();
  }
}

function renderSourceOptions() {
  elements.sourceSelect.replaceChildren();
  SOURCES.forEach((source) => {
    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = source.name;
    elements.sourceSelect.append(option);
  });

  const hasSources = SOURCES.length > 0;
  elements.sourceSelect.disabled = !hasSources;
  elements.runButton.disabled = !hasSources;
  if (!hasSources) {
    setStatus("idle", "未登録", "featureブランチでテスト対象を追加してください。");
  }
}

// 選択された1媒体だけを取得し、合否・件数・取得カードを画面へ出す。
async function runSelectedSource() {
  const source = SOURCES.find((entry) => entry.id === elements.sourceSelect.value);
  if (!source) return;

  elements.runButton.disabled = true;
  elements.metrics.hidden = true;
  elements.results.replaceChildren();
  setStatus("running", "取得中", `${source.name}だけを取得しています。`);

  try {
    const result = await runSourceTest(source);
    renderMetrics(result);
    renderItems(result.items);
    setStatus(
      result.passed ? "passed" : "failed",
      result.passed ? "合格" : "要確認",
      `${result.sourceName}: ${result.itemCount}件、画像読込 ${result.loadedImages}件、配信元画像なし ${result.missingThumbnails}件、経路 ${result.route}`
    );
  } catch (error) {
    setStatus("failed", "取得失敗", error && error.message ? error.message : String(error));
  } finally {
    elements.runButton.disabled = false;
  }
}

function renderMetrics(result) {
  const metrics = [
    ["記事", result.itemCount],
    ["見出し・リンク", result.validTitleLinks],
    ["日時", result.datedItems],
    ["画像URLあり", result.thumbnailItems],
    ["画像読込", result.loadedImages],
    ["配信元画像なし", result.missingThumbnails],
    ["固定ページ混入", result.forbiddenUrlMatches],
    ["新着順", result.chronologicalOrderValid ? "OK" : "NG"]
  ];

  elements.metrics.replaceChildren(...metrics.map(([label, value]) => {
    const container = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = String(value);
    container.append(term, description);
    return container;
  }));
  elements.metrics.hidden = false;
}

function renderItems(items) {
  elements.results.replaceChildren(...items.map((item) => {
    const card = document.createElement("article");
    card.className = "result-card";

    // APIに画像URLがない記事は壊れたimgを作らず、本体でダミー表示になることを明示する。
    const thumbnail = item.thumbnail
      ? document.createElement("img")
      : document.createElement("div");
    if (item.thumbnail) {
      thumbnail.src = item.thumbnail;
      thumbnail.alt = "";
      thumbnail.referrerPolicy = "no-referrer";
    } else {
      thumbnail.className = "result-placeholder";
      thumbnail.textContent = "配信元画像なし";
    }

    const body = document.createElement("div");
    body.className = "result-body";
    const link = document.createElement("a");
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.title;
    const detail = document.createElement("p");
    detail.textContent = `${formatDate(item.publishedAt)} / ${item.thumbnail ? `画像 ${item.imageLoaded ? "OK" : "NG"}` : "本体ではダミー画像"}`;
    body.append(link, detail);
    card.append(thumbnail, body);
    return card;
  }));
}

function setStatus(status, title, message) {
  elements.status.dataset.status = status;
  elements.status.replaceChildren();
  const strong = document.createElement("strong");
  const span = document.createElement("span");
  strong.textContent = title;
  span.textContent = message;
  elements.status.append(strong, span);
}

function formatDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(value)
    : "日時なし";
}
