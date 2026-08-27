import chalk from "chalk";
import {
  ParsedWeatherExplanation,
  ForecastTimeSeries,
  ForecastMetricValue,
  ForecastMetricArea,
  WeatherExplanationObservation,
  WeatherExplanationTidal,
  WeatherExplanationTidalEntry,
  StationObservation,
} from "../types";
import * as theme from "./theme";
import {
  FrameLevel,
  getFrameWidth,
  getDisplayMode,
  SEVERITY_LABELS,
  frameColor,
  frameTopColored,
  frameLineColored,
  frameDividerColored,
  frameBottomColored,
  createRenderBuffer,
  flushWithRecap,
  pushWrappedFrameLine,
  wrapFrameLinesColored,
  renderFooter,
  type RenderBuffer,
} from "./formatter";
import { getDisplaySeverityText } from "./weather-warning-level-theme";
import { pushFrameTable } from "./frame-table-builder";
import { weatherExplanationFrameLevel } from "../engine/presentation/level-helpers";

// 平常 = 白単色、取消 = release 単色 (確定配色言語)。気象解説は一律 normal (Phase D レビュー決定 3)
const WHITE_BORDER = chalk.rgb(232, 232, 232);

/** controlTitle が空のときの汎用フォールバック名 (VPCJ51/VPZJ51 共通) */
const DEFAULT_CONTROL_TITLE = "気象解説情報";

function pushWrappedTitle(
  buf: ReturnType<typeof createRenderBuffer>,
  level: Parameters<typeof pushWrappedFrameLine>[1],
  width: number,
  content: Parameters<typeof pushWrappedFrameLine>[3],
  borderColor?: (s: string) => string,
): void {
  const titleBuf = createRenderBuffer();
  pushWrappedFrameLine(
    titleBuf,
    level,
    { width, purpose: "title", ...(borderColor == null ? {} : { borderColor }) },
    content,
  );
  const [first, ...rest] = titleBuf.getLines();
  if (first == null) return;
  buf.pushTitle(first);
  for (const line of rest) buf.pushTitle(line);
}

/**
 * ForecastMetricArea の全 locals → phases → values をフラット化して返す。
 * cluster/count 算出・unit 探索など「全値を集める」目的に限る。
 * 描画では Local / Phase / modifier の区別が必要なため使わないこと。
 */
function flattenMetricValues(area: ForecastMetricArea): ForecastMetricValue[] {
  const out: ForecastMetricValue[] = [];
  for (const loc of area.locals) {
    for (const phase of loc.phases) {
      out.push(...phase.values);
    }
  }
  return out;
}

/** セクション type 別の見出しラベル装飾 */
function sectionLabel(sectionType: string): string {
  // sectionType (MeteorologicalInfos.@_type) は「概況」「防災事項」「付加情報」など
  return sectionType || "本文";
}

/** 情報タグの代表ラベル (compact / バナー表示用)。複数タグは「・」で結合。 */
function summarizeTags(info: ParsedWeatherExplanation): string {
  if (info.informationTags.length === 0) return "";
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const tag of info.informationTags) {
    for (const kw of tag.keywords) {
      if (seen.has(kw)) continue;
      seen.add(kw);
      labels.push(kw);
    }
  }
  return labels.join("・");
}

/**
 * 1 値の表示文字列を組み立てる (cell 内 / phase 内の各値共通)。
 * - condition === "値なし" → 欠測 "−"
 * - value != null → "subType短縮+value(+condition併記)"。0 は欠測扱いしない。
 * - value == null → description / raw / condition の順でフォールバック
 *   (WindDirection は value=null だが raw="北東" 等で復元できる)
 * unit は列ヘッダ末尾に 1 回付けるため、セルには含めない。
 */
function formatMetricValue(v: ForecastMetricValue): string {
  if (v.condition === "値なし") return "−";
  if (v.value != null) {
    const cond =
      v.condition != null && v.condition !== "値なし" ? ` ${v.condition}` : "";
    const sub = v.subType.replace(/^最大/, "");
    return `${sub}${v.value}${cond}`;
  }
  // value == null: WindDirection の raw / description を優先
  return v.description || v.raw || v.condition || "−";
}

/**
 * 定量メトリックの 1 セル (同 timeRef にぶら下がる subType 群) を組み立てる。
 * - condition === "値なし" → 欠測 "−"
 * - value == null (かつ condition あり) → condition 語のみ
 * - value != null → "subType短縮+value(+condition併記)"。0 は欠測扱いしない。
 * unit は列ヘッダ末尾に 1 回付けるため、セルには含めない。
 */
function metricCell(values: ForecastMetricValue[]): string {
  if (values.length === 0) return "−";
  const parts = values.map(formatMetricValue);
  // 全セルが欠測なら 1 つの "−" に畳む
  if (parts.every((p) => p === "−")) return "−";
  return parts.join(" ");
}

/**
 * テーブル cell 1 つを (area, timeRef) ペアで構築する。
 * locals/phases 階層を畳み込み、Local AreaName を `[…]` プレフィックス、
 * Becoming modifier を語頭 ("のち" 等) として連結する。
 *
 * VPZJ51 fixture (Local 無し + Becoming 無し) では metricCell(flattenMetricValues(...))
 * と同一出力になる (areaName=null → prefix なし、kind=base → modifier なし)。
 *
 * VPFJ51 では:
 *   Base 北東 + Becoming "のち" 東 + Becoming "のち" 南 + Local "海上" Becoming "ときどき" 南東
 *   → "北東 のち 東 のち 南 / [海上] ときどき 南東"
 */
function buildCellValueString(
  area: ForecastMetricArea,
  timeRef: string,
): string {
  const localParts: string[] = [];
  for (const loc of area.locals) {
    const localPrefix = loc.areaName ? `[${loc.areaName}] ` : "";
    const phaseParts: string[] = [];
    for (const phase of loc.phases) {
      const phaseValues = phase.values.filter((v) => v.timeRef === timeRef);
      if (phaseValues.length === 0) continue;
      const formatted = phaseValues.map(formatMetricValue);
      // 全欠測なら "−" に畳む
      const valueStr = formatted.every((p) => p === "−")
        ? "−"
        : formatted.join(" ");
      const phasePrefix =
        phase.kind === "becoming" && phase.modifier ? `${phase.modifier} ` : "";
      phaseParts.push(`${phasePrefix}${valueStr}`);
    }
    if (phaseParts.length === 0) continue;
    localParts.push(`${localPrefix}${phaseParts.join(" ")}`);
  }
  if (localParts.length === 0) return "−";
  return localParts.join(" / ");
}

/** 系列の代表 unit (最初の非空 unit)。列ヘッダに付与する。 */
function seriesUnit(series: ForecastTimeSeries): string {
  for (const area of series.metrics) {
    for (const v of flattenMetricValues(area)) {
      if (v.unit) return v.unit;
    }
  }
  return "";
}

/** events 系列を `[地域, 期間]` テーブルで描画する。 */
function renderEventsTable(
  buf: RenderBuffer,
  level: FrameLevel,
  width: number,
  series: ForecastTimeSeries,
  borderColor: (s: string) => string,
): void {
  const rows = series.events.map((e) => {
    const area = e.regionLabel ? `(${e.regionLabel})${e.areaName}` : e.areaName;
    const period = e.sentence || e.timeName || "";
    return [area, period];
  });
  // indent=6: 本文 (4 桁) よりさらに 1 段下げ、テーブルであることを視覚的に分離する
  pushFrameTable(
    buf,
    level,
    width,
    [{ header: "地域" }, { header: "期間" }],
    rows,
    borderColor,
    6,
  );
}

/** metrics 系列を `[地域, <timeName...>]` テーブルで描画する。 */
function renderMetricsTable(
  buf: RenderBuffer,
  level: FrameLevel,
  width: number,
  series: ForecastTimeSeries,
  borderColor: (s: string) => string,
): void {
  // 時間帯 (timeRef) の順序を timeDefines から決定 (フォールバックで値から収集)
  const timeOrder: { ref: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const td of series.timeDefines) {
    if (seen.has(td.timeId)) continue;
    seen.add(td.timeId);
    timeOrder.push({ ref: td.timeId, name: td.name });
  }
  for (const area of series.metrics) {
    for (const v of flattenMetricValues(area)) {
      if (seen.has(v.timeRef)) continue;
      seen.add(v.timeRef);
      timeOrder.push({ ref: v.timeRef, name: v.timeName ?? v.timeRef });
    }
  }

  const unit = seriesUnit(series);
  const columns = [
    { header: "地域" },
    ...timeOrder.map((t) => ({
      header: unit ? `${t.name}(${unit})` : t.name,
    })),
  ];

  const rows = series.metrics.map((area) => {
    const cells: string[] = [area.areaName];
    for (const t of timeOrder) {
      // buildCellValueString は locals/phases 階層 (Local AreaName 接頭辞 + Becoming modifier)
      // を畳み込んで 1 セル文字列にする。VPZJ51 (Local 無し + Becoming 無し) では
      // metricCell(flattenMetricValues(...)) と同等の出力。
      cells.push(buildCellValueString(area, t.ref));
    }
    return cells;
  });

  // indent=6: 本文 (4 桁) よりさらに 1 段下げ、テーブルであることを視覚的に分離する
  pushFrameTable(buf, level, width, columns, rows, borderColor, 6);
}

/** 系列見出し + intro 散文を描画する。 */
function renderSeriesHeader(
  buf: RenderBuffer,
  level: FrameLevel,
  width: number,
  series: ForecastTimeSeries,
  borderColor: (s: string) => string,
): void {
  const heading = series.element ? `▸ 予想: ${series.element}` : "▸ 予想";
  pushWrappedFrameLine(
    buf,
    level,
    { width, purpose: "prose", borderColor },
    `  ${chalk.bold.cyan(heading)}`,
  );
  for (const line of series.intro) {
    const trimmed = line.replace(/　/g, " ");
    for (const wrapped of wrapFrameLinesColored(
      level,
      borderColor,
      `    ${chalk.white(trimmed)}`,
      width,
    )) {
      buf.push(wrapped);
    }
  }
}

/**
 * Station 1 行を描画。WindPart は WindDirection + WindSpeed を併記。
 *
 * remark 抑制条件の判定対象は「実際に描画される文字列」(rendered) にする
 * (sentence に既に remark を含む場合の二重表記を防ぐ)。
 */
function formatStationRow(st: StationObservation): string {
  const parts: string[] = [st.stationName];
  for (const m of st.measurements) {
    const valueStr = m.values
      .map((v) => {
        if (v.value != null) return `${v.value}${v.unit}`;
        return v.description || v.raw || "";
      })
      .filter((x) => x.length > 0)
      .join(" ");
    const rendered = valueStr || m.sentence;
    parts.push(rendered);
    if (m.remark != null && !rendered.includes(m.remark)) {
      parts.push(`※${m.remark}`);
    }
    if (m.time != null) {
      const hhmm = m.time.match(/T(\d{2}:\d{2})/)?.[1];
      if (hhmm) parts.push(`(${hhmm})`);
    }
  }
  return parts.join("  ");
}

/**
 * 観測実況セクション全体を描画する (VPFJ51 のみ)。
 * fallback に応じて詳細度を切り替える。
 */
function displayObservation(
  observation: WeatherExplanationObservation,
  buf: RenderBuffer,
  level: FrameLevel,
  width: number,
  borderColor: (s: string) => string,
): void {
  buf.push(frameDividerColored(level, borderColor, width));
  pushWrappedFrameLine(
    buf,
    level,
    { width, purpose: "type", borderColor },
    chalk.bold.cyan("  ▸ 観測実況"),
  );

  // インデント階層: 見出し「▸ 観測実況」(2) < 副見出し「雨の実況 (…)」(4) < 配下行 (6)。
  // 副見出し・観測点行も wrap 経由にし、狭い幅でのはみ出しを防ぐ
  // (先頭スペースが hanging indent として継続行に引き継がれる)
  if (observation.fallback === "raw") {
    const totalStations = observation.series.reduce(
      (a, s) => a + s.stations.length,
      0,
    );
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "diagnostic", borderColor },
      chalk.gray(`    詳細省略 (${totalStations} 地点)`),
    );
    return;
  }

  for (const s of observation.series) {
    const elementLabel = s.element ? ` (${s.element})` : "";
    if (observation.fallback === "compactOnly") {
      for (const wrapped of wrapFrameLinesColored(
        level,
        borderColor,
        `    ${s.propertyType}${elementLabel} (${s.stations.length} 地点)`,
        width,
      )) {
        buf.push(wrapped);
      }
      continue;
    }
    // fallback === "none": フル描画
    for (const wrapped of wrapFrameLinesColored(
      level,
      borderColor,
      `    ${chalk.bold(s.propertyType)}${elementLabel}`,
      width,
    )) {
      buf.push(wrapped);
    }
    for (const t of s.intro) {
      const trimmed = t.replace(/　/g, " ");
      for (const wrapped of wrapFrameLinesColored(
        level,
        borderColor,
        `      ${chalk.white(trimmed)}`,
        width,
      )) {
        buf.push(wrapped);
      }
    }
    for (const st of s.stations) {
      for (const wrapped of wrapFrameLinesColored(
        level,
        borderColor,
        `      ${formatStationRow(st)}`,
        width,
      )) {
        buf.push(wrapped);
      }
    }
    for (const t of s.supplement) {
      const trimmed = t.replace(/　/g, " ");
      for (const wrapped of wrapFrameLinesColored(
        level,
        borderColor,
        `      ${chalk.gray(trimmed)}`,
        width,
      )) {
        buf.push(wrapped);
      }
    }
  }
}

/**
 * 補助表示する TidalLevel @type。満潮潮位/干潮潮位 に限定する:
 * - 89_02 型 (千葉・大潮) の Sentence は「０１時０１分　５０センチ」形式で
 *   満潮か干潮かが @type にしか無いため「満潮 」/「干潮 」を補う
 * - 「副振動の山から谷の高さ」のような長い type は行を支配して読みにくく、
 *   ヘッドライン・概況本文に説明が出るため補助しない
 */
const TIDAL_TYPE_LABEL_TARGETS = ["満潮潮位", "干潮潮位"];

/**
 * levelType の補助ラベル ("満潮 "/"干潮 ")。Sentence に既に語が含まれる
 * 89_01 型 (「満潮時刻　…」) では二重表記になるため空を返す。
 */
function tidalTypeLabel(entry: WeatherExplanationTidalEntry): string {
  if (entry.levelType == null) return "";
  if (!TIDAL_TYPE_LABEL_TARGETS.includes(entry.levelType)) return "";
  const short = entry.levelType.replace("潮位", ""); // 満潮潮位 → 満潮
  if (entry.sentence.includes(short)) return "";
  return `${short} `;
}

/**
 * 潮位エントリ 1 行 (Station 名 + [timeName] + (levelType 補助) + Sentence) を push する。
 * standalone「▸ 潮位実況/予想」と対応セクションへの統合表示 (指摘 #3) で同形式を共有する。
 */
function pushTidalEntryLine(
  entry: WeatherExplanationTidalEntry,
  buf: RenderBuffer,
  level: FrameLevel,
  width: number,
  borderColor: (s: string) => string,
): void {
  const station = entry.stationName ? `${entry.stationName}  ` : "";
  const timePrefix = entry.timeName ? `[${entry.timeName}] ` : "";
  const typeLabel = tidalTypeLabel(entry);
  const line = `    ${chalk.bold.white(station)}${chalk.gray(timePrefix)}${chalk.white(typeLabel)}${chalk.white(entry.sentence)}`;
  for (const wrapped of wrapFrameLinesColored(level, borderColor, line, width)) {
    buf.push(wrapped);
  }
}

/**
 * 潮位実況・予想 (VMCJ53-55 の TidalLevelPart) を standalone 見出しで描画する。
 * 対応セクション (「▸ 観測実況」/「▸ 予想: …」) へ統合済みのエントリは呼び出し側で
 * 除外されるため、ここには対応先の無いエントリだけが渡る (フォールバック)。
 */
function renderTidal(
  tidal: WeatherExplanationTidal,
  buf: RenderBuffer,
  level: FrameLevel,
  width: number,
  borderColor: (s: string) => string,
): void {
  const groups: { label: string; entries: WeatherExplanationTidalEntry[] }[] = [
    { label: "潮位実況", entries: tidal.observations },
    { label: "潮位予想", entries: tidal.forecasts },
  ];
  for (const g of groups) {
    if (g.entries.length === 0) continue;
    buf.push(frameDividerColored(level, borderColor, width));
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "type", borderColor },
      `  ${chalk.bold.cyan(`▸ ${g.label}`)}`,
    );
    for (const entry of g.entries) {
      pushTidalEntryLine(entry, buf, level, width, borderColor);
    }
  }
}

/**
 * 予想 (TimeSeriesInfo) 全体を volume guard 付きで描画する。
 * inlineTidal: sourceIndex → 潮位予想エントリ。メトリクスも events も無い series
 * (VMCJ55 の TidalLevelPart 系列は ForecastMetricArea として認識されず空 series になる) の
 * 見出し + intro 直下に統合表示する (指摘 #3「以下のとおりです」の直下に値を出す)。
 */
function renderForecast(
  buf: RenderBuffer,
  level: FrameLevel,
  width: number,
  forecast: ParsedWeatherExplanation["forecast"],
  borderColor: (s: string) => string,
  inlineTidal: Map<number, WeatherExplanationTidalEntry[]>,
): void {
  if (forecast == null || forecast.series.length === 0) return;

  buf.push(frameDividerColored(level, borderColor, width));

  if (forecast.fallback === "raw") {
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "diagnostic", borderColor },
      chalk.gray("予想は大規模のため省略"),
    );
    return;
  }

  for (const series of forecast.series) {
    renderSeriesHeader(buf, level, width, series, borderColor);

    // 空 series (metrics 無し && events 無し) に紐付いた潮位予想を見出し直下に統合。
    // inlineTidal は空 series の sourceIndex に限って構築されるため、潮位電文以外の
    // 空 series (header + intro のみ) の従来挙動は変わらない
    const inlineEntries = inlineTidal.get(series.sourceIndex);
    if (inlineEntries != null) {
      for (const entry of inlineEntries) {
        pushTidalEntryLine(entry, buf, level, width, borderColor);
      }
    }

    if (forecast.fallback === "compactOnly") {
      // 件数サマリのみ (詳細テーブルは出さない)
      const label = series.element ?? "予想";
      if (series.events.length > 0) {
        pushWrappedFrameLine(
          buf,
          level,
          { width, purpose: "prose", borderColor },
          `    ${series.events.length} 地域`,
        );
      } else if (series.metrics.length > 0) {
        const cols = Math.max(
          series.timeDefines.length,
          new Set(series.metrics.flatMap((m) => flattenMetricValues(m).map((v) => v.timeRef))).size,
          1,
        );
        pushWrappedFrameLine(
          buf,
          level,
          { width, purpose: "prose", borderColor },
          `    ${label}: ${series.metrics.length} 地域 × ${cols} 時間帯`,
        );
      }
      continue;
    }

    // none: フル描画
    if (series.events.length > 0) {
      renderEventsTable(buf, level, width, series, borderColor);
    }
    if (series.metrics.length > 0) {
      renderMetricsTable(buf, level, width, series, borderColor);
    }
  }
}

/** compact モード */
function displayCompact(
  info: ParsedWeatherExplanation,
  level: FrameLevel,
): void {
  const parts: string[] = [];
  parts.push(SEVERITY_LABELS[level]);
  parts.push(info.controlTitle || DEFAULT_CONTROL_TITLE);

  if (info.infoType === "取消") {
    parts.push("取消");
  } else {
    if (info.targetAreas.length > 0) {
      parts.push(info.targetAreas[0].name);
    }
    const tagSummary = summarizeTags(info);
    if (tagSummary) {
      parts.push(tagSummary);
    }
  }

  const color = frameColor(level);
  console.log(color(parts.join("  ")));
}

/** 地方気象解説情報を表示 */
export function displayWeatherExplanation(
  info: ParsedWeatherExplanation,
): void {
  const level = weatherExplanationFrameLevel(info);
  const width = getFrameWidth();

  if (getDisplayMode() === "compact") {
    displayCompact(info, level);
    return;
  }

  const borderColor = info.infoType === "取消"
    ? getDisplaySeverityText("release")
    : WHITE_BORDER;

  const buf = createRenderBuffer();
  buf.pushEmpty();
  buf.push(frameTopColored(level, borderColor, width));

  // テスト電文バッジ
  if (info.isTest) {
    if (chalk.level === 0) {
      buf.push(frameLineColored(level, borderColor, " テスト電文 ", width));
    } else {
      pushWrappedFrameLine(
        buf,
        level,
        { width, purpose: "type", borderColor },
        theme.getRoleChalk("testBadge")(" テスト電文 "),
      );
    }
  }

  // タイトル行
  const controlTitle = info.controlTitle || DEFAULT_CONTROL_TITLE;
  pushWrappedTitle(buf, level, width, [
    { text: chalk.bold(controlTitle), priority: 0, omission: "never" },
    { text: chalk.gray(info.infoType), priority: 1, omission: "never" },
    { text: chalk.gray(SEVERITY_LABELS[level]), priority: 2, omission: "drop" },
  ], borderColor);

  if (info.title && info.title !== info.controlTitle) {
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "title", borderColor },
      chalk.white(info.title),
    );
  }

  // 取消は短く
  if (info.infoType === "取消") {
    buf.push(frameDividerColored(level, borderColor, width));
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "diagnostic", borderColor },
      chalk.gray(`${controlTitle}は取り消されました`),
    );
    renderFooter(
      level,
      info.type,
      info.reportDateTime,
      info.publishingOffice,
      width,
      buf,
      borderColor,
    );
    buf.push(frameBottomColored(level, borderColor, width));
    buf.pushEmpty();
    flushWithRecap(buf, level, width, borderColor);
    return;
  }

  // 情報タグバナー
  const tagSummary = summarizeTags(info);
  if (tagSummary) {
    buf.push(frameDividerColored(level, borderColor, width));
    const banner = chalk.bold.yellow(` ${tagSummary} `);
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "type", borderColor },
      banner,
    );
  }

  // 対象地域
  if (info.targetAreas.length > 0) {
    buf.push(frameDividerColored(level, borderColor, width));
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "type", borderColor },
      chalk.gray("[対象地域]"),
    );
    const areaNames = info.targetAreas.map((a) => a.name).join(", ");
    for (const wrapped of wrapFrameLinesColored(level, borderColor, `  ${chalk.white(areaNames)}`, width)) {
      buf.push(wrapped);
    }
  }

  // Headline
  if (info.headline) {
    buf.push(frameDividerColored(level, borderColor, width));
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "type", borderColor },
      chalk.gray("[ヘッドライン]"),
    );
    for (const rawLine of info.headline.split("\n")) {
      const trimmed = rawLine.replace(/　/g, " ");
      for (const wrapped of wrapFrameLinesColored(
        level,
        borderColor,
        `  ${chalk.white(trimmed)}`,
        width,
      )) {
        buf.push(wrapped);
      }
    }
  }

  // ── 潮位エントリの対応セクションへの統合 (指摘 #3) ──
  // 「以下のとおりです」と言うセクションの直下に値を寄せる:
  //   - observations: sections に「観測実況」があれば、その最後の section 直下へ
  //   - forecasts: seriesIndex が一致する空 series (metrics/events 無し) の見出し直下へ
  // 対応先の無いエントリは従来どおり standalone「▸ 潮位実況」「▸ 潮位予想」で出す
  let lastObsSectionIdx = -1;
  info.sections.forEach((s, i) => {
    if (s.sectionType === "観測実況") lastObsSectionIdx = i;
  });
  const inlineObservations =
    info.tidal != null && lastObsSectionIdx >= 0 ? info.tidal.observations : [];
  const inlineForecastsBySeries = new Map<number, WeatherExplanationTidalEntry[]>();
  const standaloneForecasts: WeatherExplanationTidalEntry[] = [];
  if (info.tidal != null) {
    // 紐付け対象は「メトリクスも events も無い空 series」のみ (raw fallback 時は見出し自体が
    // 出ないため統合不能 → standalone へ)
    const emptySeriesIndices = new Set<number>();
    if (info.forecast != null && info.forecast.fallback !== "raw") {
      for (const s of info.forecast.series) {
        if (s.metrics.length === 0 && s.events.length === 0) {
          emptySeriesIndices.add(s.sourceIndex);
        }
      }
    }
    for (const entry of info.tidal.forecasts) {
      if (entry.seriesIndex != null && emptySeriesIndices.has(entry.seriesIndex)) {
        const list = inlineForecastsBySeries.get(entry.seriesIndex) ?? [];
        list.push(entry);
        inlineForecastsBySeries.set(entry.seriesIndex, list);
      } else {
        standaloneForecasts.push(entry);
      }
    }
  }

  // セクション (概況 / 観測実況 / 防災事項 / 付加情報)
  // 連続する同一 sectionType は 1 グループとして扱い、divider + 「▸ 見出し」は
  // グループ先頭で 1 回だけ出す (VMCJ55 89_01: 1 つの Property に Text 解説 +
  // Text 気象要素の 2 本があり、section は 2 つでも見出しは「観測実況」1 回)。
  // 非連続の同一 sectionType (間に別 type が挟まる) は文書順を尊重して見出しを再表示する
  if (info.sections.length > 0) {
    for (let i = 0; i < info.sections.length; i++) {
      const section = info.sections[i];
      const isGroupHead =
        i === 0 || section.sectionType !== info.sections[i - 1].sectionType;
      if (isGroupHead) {
        buf.push(frameDividerColored(level, borderColor, width));
        const label = sectionLabel(section.sectionType);
        pushWrappedFrameLine(
          buf,
          level,
          { width, purpose: "prose", borderColor },
          `  ${chalk.bold.cyan(`▸ ${label}`)}`,
        );
      }
      for (const rawLine of section.text.split("\n")) {
        const trimmed = rawLine.replace(/　/g, " ");
        for (const wrapped of wrapFrameLinesColored(
          level,
          borderColor,
          `    ${chalk.white(trimmed)}`,
          width,
        )) {
          buf.push(wrapped);
        }
      }
      // 最後の「観測実況」section 直下に潮位実況値を統合 (VMCJ55 89_01)
      if (i === lastObsSectionIdx) {
        for (const entry of inlineObservations) {
          pushTidalEntryLine(entry, buf, level, width, borderColor);
        }
      }
    }
  }

  // 潮位実況・予想 (VMCJ53-55 の TidalLevelPart) — 対応セクションへ統合できなかった分のみ
  if (info.tidal != null) {
    renderTidal(
      {
        observations: lastObsSectionIdx >= 0 ? [] : info.tidal.observations,
        forecasts: standaloneForecasts,
      },
      buf,
      level,
      width,
      borderColor,
    );
  }

  // 観測実況 (VPFJ51 のみ)
  if (info.observation != null) {
    displayObservation(info.observation, buf, level, width, borderColor);
  }

  // 予想 (VPZJ51/VPFJ51 の TimeSeriesInfo)。潮位予想は紐付く空 series の見出し直下に統合
  if (info.forecast != null) {
    renderForecast(buf, level, width, info.forecast, borderColor, inlineForecastsBySeries);
  }

  // フッター
  renderFooter(
    level,
    info.type,
    info.reportDateTime,
    info.publishingOffice,
    width,
    buf,
    borderColor,
  );

  buf.push(frameBottomColored(level, borderColor, width));
  buf.pushEmpty();

  flushWithRecap(buf, level, width, borderColor);
}
