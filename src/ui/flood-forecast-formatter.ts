import chalk from "chalk";
import type {
  ParsedFloodForecastInfo,
  FloodStation,
  FloodSeriesWindow,
  FloodCriteria,
  FloodLevel,
  InundationArea,
} from "../types";
import * as theme from "./theme";
import {
  type FrameLevel,
  type RenderBuffer,
  SEVERITY_LABELS,
  getFrameWidth,
  getTruncation,
  createRenderBuffer,
  flushWithRecap,
  frameTopColored,
  frameBottomColored,
  frameLineColored,
  frameDividerColored,
  frameDividerLabeledColored,
  renderFooter,
  wrapFrameLinesColored,
  visualWidth,
  stripAnsi,
} from "./formatter";
import { getDisplaySeverityText } from "./weather-warning-level-theme";
import {
  aggregateByRiver,
  type RiverSection,
} from "../engine/presentation/flood-forecast-aggregate";
import { resolveFloodForecastLevels } from "../engine/presentation/level-helpers";

/**
 * 指定河川洪水予報 (VXKO50-89) / 水位周知河川に関する情報 (VXSU50-59) の
 * 表示 formatter。
 *
 * spec §7 layout、`aggregateByRiver` は formatter 内呼出が正
 * (engine→ui 境界遵守、plan v2 冒頭の重要注記)。
 *
 * ブロック関数の signature 2 種類許容:
 * - `function buildXxxBlock(info)` (rivers 不要 block)
 * - `function buildRiverStationGroupBlock(info, rivers)` (rivers が要る block)
 *
 * 配色言語:
 * - 取消 = release (cancel) — `weatherBannerOfficialL1` 系の release 色
 * - VXSU/VXKO とも frame level は `resolveFloodForecastLevels` に従う
 *   (parser が解決した maxLevel から決定)
 */

const WHITE_BORDER = chalk.rgb(232, 232, 232);

/** title を 1 行 or 2 行 で push する (overflow 対策、レビュー指摘 (2026-06-18) で導入)。
 *  - titleHead (kind + type + severity 等の固定 head 部) は常に 1 行目に pushTitle。
 *  - headTitle が inner に収まれば末尾 concat、超過時は 2 行目 (indent 2、wrap 可) に分離。
 *  display 種類別 (`displayVxkoNormal` / `displayCancelPath` / `displayVxsuMinimal`) で
 *  同一ロジック重複を解消。`frameLineColored` は wrap せず pad のみのため content が
 *  inner を超えると右枠線がハミ出るので、その判定をここで集約する。
 *  残課題: headTitle 自体が更に狭い幅で超過するケースは `wrapFrameLinesColored` の
 *  hard-wrap で ANSI が抜ける (Findings 3-2 #3 と同根)。 */
function pushTitleWithOverflow(
  buf: RenderBuffer,
  level: FrameLevel,
  color: (s: string) => string,
  width: number,
  titleHead: string,
  headTitle: string | null,
): void {
  const headTitlePart =
    headTitle != null && headTitle !== "" ? chalk.white(`  ${headTitle}`) : "";
  const titleFull = titleHead + headTitlePart;
  if (visualWidth(titleFull) <= width - 4) {
    buf.pushTitle(frameLineColored(level, color, titleFull, width));
    return;
  }
  buf.pushTitle(frameLineColored(level, color, titleHead, width));
  if (headTitle != null && headTitle !== "") {
    for (const wrapped of wrapFrameLinesColored(
      level,
      color,
      `  ${chalk.white(headTitle)}`,
      width,
    )) {
      buf.push(wrapped);
    }
  }
}

/** 取消パス用の最小 layout. */
function displayCancelPath(info: ParsedFloodForecastInfo): void {
  const width = getFrameWidth();
  const level: FrameLevel = "cancel";
  const color = getDisplaySeverityText("release");
  const buf = createRenderBuffer();

  buf.pushEmpty();
  buf.push(frameTopColored(level, color, width));
  if (info.isTest) {
    buf.push(
      frameLineColored(
        level,
        color,
        theme.getRoleChalk("testBadge")(" テスト電文 "),
        width,
      ),
    );
  }
  // 訂正電文バッジは取消パスでは到達しない (displayFloodForecastInfo の dispatch で
  // infoType="取消" 専用ルートに分岐されるため)。displayVxkoNormal / displayVxsuMinimal
  // 側にのみ配置 (Codex review 2026-06-19 で dead code 指摘)。
  const titleHead =
    chalk.bold(info.infoKind || "洪水予報") +
    chalk.gray(`  ${info.infoType}`) +
    chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  pushTitleWithOverflow(buf, level, color, width, titleHead, info.headTitle);

  buf.push(frameDividerColored(level, color, width));
  buf.push(
    frameLineColored(
      level,
      color,
      chalk.gray("この洪水予報は取り消されました"),
      width,
    ),
  );

  renderFooter(
    level,
    info.typeCode,
    info.reportDateTime,
    info.publishingOffice,
    width,
    buf,
    color,
  );
  buf.push(frameBottomColored(level, color, width));
  buf.pushEmpty();
  flushWithRecap(buf, level, width, color);
}

/** VXSU 専用最小 layout (Headline + 警報名のみ、観測所/inundation/雨量/氾濫水予報なし). */
function displayVxsuMinimal(info: ParsedFloodForecastInfo): void {
  const width = getFrameWidth();
  const levels = resolveFloodForecastLevels(info);
  const level: FrameLevel = levels.frameLevel;
  const color = level === "cancel" ? getDisplaySeverityText("release") : WHITE_BORDER;
  const buf = createRenderBuffer();

  buf.pushEmpty();
  buf.push(frameTopColored(level, color, width));
  if (info.isTest) {
    buf.push(
      frameLineColored(
        level,
        color,
        theme.getRoleChalk("testBadge")(" テスト電文 "),
        width,
      ),
    );
  }
  if (info.infoType === "訂正") {
    buf.push(
      frameLineColored(
        level,
        color,
        theme.getRoleChalk("correctionBadge")(" 訂正電文 "),
        width,
      ),
    );
  }
  const titleHead =
    chalk.bold(info.infoKind || "水位周知河川に関する情報") +
    chalk.gray(`  ${info.infoType}`) +
    chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  pushTitleWithOverflow(buf, level, color, width, titleHead, info.headTitle);
  buf.push(frameDividerColored(level, color, width));

  // Headline ブロック (1 行 wrap 許容)
  if (info.headlines.length > 0) {
    const h = info.headlines[0];
    if (h.headlineText) {
      for (const wrapped of wrapFrameLinesColored(
        level,
        color,
        `  ${chalk.white(h.headlineText)}`,
        width,
      )) {
        buf.push(wrapped);
      }
    }
    if (h.kindName) {
      buf.push(
        frameLineColored(
          level,
          color,
          `  ${chalk.bold.cyan(h.kindName)}`,
          width,
        ),
      );
    }
  }
  if (info.notice) {
    buf.push(
      frameLineColored(level, color, `  ${chalk.gray(info.notice)}`, width),
    );
  }

  renderFooter(
    level,
    info.typeCode,
    info.reportDateTime,
    info.publishingOffice,
    width,
    buf,
    color,
  );
  buf.push(frameBottomColored(level, color, width));
  buf.pushEmpty();
  flushWithRecap(buf, level, width, color);
}

/**
 * 主文ブロック (Task 19a).
 *
 * Warning.Item.Property.Text の代表として、scope=河川 の Headline.Text を 1-3 行で表示する。
 * 河川名 (areas) を先頭に小見出しとして付与し、本文を wrap で折り返す。
 *
 * 注: parser の現実装では 3 つの scope (予報区域/河川/府県予報区等) の headlineText は同一の
 * ことが多いが、areas が河川単位かどうかで使い分ける。`scope=河川` がなければ
 * `scope=予報区域` / `headlines[0]` で fallback する。
 */
function buildMainTextBlock(
  info: ParsedFloodForecastInfo,
  width: number,
  level: FrameLevel,
  color: (s: string) => string,
): string[] {
  const lines: string[] = [];
  const riverHeadline =
    info.headlines.find((h) => h.scope === "河川") ??
    info.headlines.find((h) => h.scope === "予報区域") ??
    info.headlines[0];
  if (riverHeadline == null) return lines;

  // 河川名小見出し (areas[].name を ' / ' で連結)
  const riverLabel = riverHeadline.areas
    .map((a) => a.name)
    .filter((n) => n !== "")
    .join(" / ");
  if (riverLabel !== "") {
    lines.push(
      frameLineColored(
        level,
        color,
        `  ${chalk.bold.cyan("▸ " + riverLabel)}`,
        width,
      ),
    );
  }

  // 本文 (主文)
  const text = riverHeadline.headlineText.trim();
  if (text !== "") {
    for (const wrapped of wrapFrameLinesColored(
      level,
      color,
      `    ${chalk.white(text)}`,
      width,
    )) {
      lines.push(wrapped);
    }
  }
  return lines;
}

/** condition → 矢印化 (spec §7.4)。値ありの cell の trend 表示用。
 *  値が null のときは {@link conditionLabelForMissing} で日本語ラベルを使う方針 (2026-06-18 方針)。 */
function conditionArrow(cond: FloodSeriesWindow["condition"]): string {
  switch (cond) {
    case "上昇": return "↗";
    case "下降": return "↘";
    case "正常": return "→";
    case "一定": return "=";
    case "欠測": return "?";
    case "無効": return "-";
    case "未計算": return "…";
    case "unknown":
    default:
      return "?";
  }
}

/** value=null cell の condition を日本語ラベルに置換 (`?…` `??` `?-` 等の暗号表記を解消)。
 *  trend 系 (上昇/下降/正常/一定) は null fallback として "?" を返す (本来 value あり想定)。
 *  caller が `chalk.gray()` 等で muted 着色して使う。 */
function conditionLabelForMissing(cond: FloodSeriesWindow["condition"]): string {
  switch (cond) {
    case "欠測": return "欠測";
    case "未計算": return "未計算";
    case "無効": return "無効";
    case "unknown": return "不明";
    // value=null + trend 条件は本来矛盾、fallback の "?"
    default: return "?";
  }
}

/** series cell の level (0-5/null) に応じた inline 色 (文字色のみ、bg は使わない)。
 *  null は素のまま (color なし)。FLOOD_LEVEL_COLOR の共有 palette を引く (levelChip と整合)。 */
function levelToInlineColor(level: FloodSeriesWindow["level"]): (s: string) => string {
  if (level == null) return (s) => s;
  if (level === 0 || level === 1) return FLOOD_LEVEL_COLOR.L1;
  if (level === 2) return FLOOD_LEVEL_COLOR.L2;
  if (level === 3) return FLOOD_LEVEL_COLOR.L3;
  if (level === 4) return FLOOD_LEVEL_COLOR.L4;
  if (level === 5) return FLOOD_LEVEL_COLOR.L5;
  return (s) => s;
}

/** Flood level の共有 palette。L1〜L5 は warning palette と整合させつつ、
 *  inline text として黒背景で視認性が要るため L4 は ライト寄り、L5 はピンク寄り
 *  brighter purple に override する (選定 (2026-06-18))。 */
const FLOOD_LEVEL_COLOR: Record<FloodLevel, (s: string) => string> = {
  L5: chalk.rgb(220, 100, 220),
  L4: chalk.rgb(255, 90, 90),
  L3: getDisplaySeverityText("officialL3"),
  L2: getDisplaySeverityText("officialL2"),
  L1: getDisplaySeverityText("officialL1"),
  release: chalk.green,
  unknown: chalk.gray,
};

/** 文字列配列を innerWidth に収まるように greedy pack で行分けする。
 *  各行は sep で連結、超過しそうなら新しい行に折り返す。空配列は空 array を返す。
 *  ANSI を含む文字列を渡しても visualWidth が stripAnsi 込みで計算するため正しく動く。
 *  series / Criteria / inundation items の 3 箇所で重複していたパターンを統合
 *  (Findings 3-2 #1 レビュー決定 (2026-06-18))。
 *  単体 part が innerWidth を超える場合は文字単位で hard wrap (ANSI strip)
 *  — 浸水想定地区の長い city + sub-areas で frame overflow を防ぐため
 *  (Codex review 2026-06-19 で snapshot 内 62 幅 case 確認)。 */
function packGreedyByWidth(
  parts: string[],
  sep: string,
  innerWidth: number,
): string[] {
  const lines: string[] = [];
  let current = "";
  for (const part of parts) {
    // 単体 part が innerWidth を超える: 文字単位で hard wrap。ANSI は剥がれる前提。
    if (visualWidth(part) > innerWidth) {
      if (current !== "") {
        lines.push(current);
        current = "";
      }
      for (const chunk of hardWrapPlain(part, innerWidth)) {
        lines.push(chunk);
      }
      continue;
    }
    const candidate = current === "" ? part : current + sep + part;
    if (visualWidth(candidate) > innerWidth && current !== "") {
      lines.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** 文字列を visualWidth ベースで innerWidth に収まるよう char 単位で分割。ANSI は strip。
 *  `packGreedyByWidth` の単体 overflow フォールバック専用。 */
function hardWrapPlain(part: string, innerWidth: number): string[] {
  const plain = stripAnsi(part);
  const chunks: string[] = [];
  let acc = "";
  let used = 0;
  for (const ch of plain) {
    const w = visualWidth(ch);
    if (used + w > innerWidth) {
      if (acc !== "") chunks.push(acc);
      acc = ch;
      used = w;
    } else {
      acc += ch;
      used += w;
    }
  }
  if (acc !== "") chunks.push(acc);
  return chunks;
}

/** FloodLevel の表示テキスト (色付き)。
 *  全 level を text 色のみで統一 (旧 L3-L5 の bg-chip 形式は廃止し、
 *  inline 値の色感と整合させる。NO_COLOR snapshot 上は " L5 " → "L5" で 2 char 縮む)。 */
function levelChip(level: FloodLevel): string {
  if (level === "release") return FLOOD_LEVEL_COLOR.release("解除");
  if (level === "unknown") return FLOOD_LEVEL_COLOR.unknown("―");
  return FLOOD_LEVEL_COLOR[level](level);
}

/** Criteria を fields に分解する (greedy pack 用)。
 *  L4 と単位 [m] は分割不能ペアとしてグルーピングし、折り返し時に "[m]" だけが
 *  単独行に取り残されるのを防ぐ。null 値は `--`。 */
function formatCriteriaParts(c: FloodCriteria): string[] {
  const fmt = (label: string, v: number | null): string =>
    v == null ? `${label}=--` : `${label}=${v}`;
  const l4 = fmt("L4", c.L4);
  const l4WithUnit = c.rawUnit !== "" ? `${l4} [${c.rawUnit}]` : l4;
  return [
    "基準水位",
    fmt("L1", c.L1),
    fmt("L2", c.L2),
    fmt("L3", c.L3),
    l4WithUnit,
  ];
}

/** series 7 個 (現況〜6H 後) を width に応じた greedy packing で N 行に分けて表示。
 *  h4 indent (6) + 枠 padding (4) を差し引いた `width - 10` を 1 行の cell 詰込み枠とする。 */
function buildSeriesLines(s: FloodStation, width: number): string[] {
  if (s.series.length === 0) return [chalk.gray("(時系列なし)")];
  // 全 condition が "欠測" かつ全 value=null かどうかで早期 return
  const allMissing = s.series.every((w) => w.condition === "欠測" && w.value == null);
  if (allMissing) return [chalk.gray("全時刻欠測")];

  // ラベル割当: index 0 = 現況、index k (k>=1) = `${k}H`。
  // 値あり: 値を level 色で着色 + arrow は素のまま。
  // 値なし: condition の日本語ラベル (`欠測`/`未計算`/`無効`/`不明`) を gray で表示
  //         (`?…` 等の暗号表記を解消、レビュー指摘 (2026-06-18))。
  const cells = s.series.map((w, i) => {
    const label = i === 0 ? "現況" : `${i}H`;
    if (w.value == null) {
      return `${label} ${chalk.gray(conditionLabelForMissing(w.condition))}`;
    }
    const v = levelToInlineColor(w.level)(String(w.value));
    const arrow = conditionArrow(w.condition);
    return `${label} ${v}${arrow}`;
  });

  // greedy packing: 共有 helper `packGreedyByWidth` で行分け
  return packGreedyByWidth(cells, " │ ", Math.max(8, width - 10));
}

/** station 1 件分の lines を構築. wrap せず、呼び出し側で frameLineColored 化する */
function buildStationLines(s: FloodStation, width: number): string[] {
  const lines: string[] = [];

  // ヘッダ: 観測所名 (河川名・measurement) ─ city ─ level
  const measurementLabel = s.measurement === "discharge" ? "流量" : "水位";
  let header = chalk.bold.white(s.stationName);
  // 河川名: 複数のとき (+N) で省略
  if (s.riverNames.length > 0) {
    const firstRiver = s.riverNames[0];
    const restCount = s.riverNames.length - 1;
    const riverPart =
      restCount > 0 ? `${firstRiver} (+${restCount})` : firstRiver;
    header += chalk.gray(` (${riverPart}・${measurementLabel})`);
  } else {
    header += chalk.gray(` (${measurementLabel})`);
  }
  if (s.cityName != null && s.cityName !== "") {
    header += chalk.gray(` ─ ${s.cityName}`);
  }
  header += "  " + levelChip(s.stationObservedLevel);
  // s.series[0] の trend indicator を観測所名行末にも。
  // 値あり: arrow (`↗` `↘` `→` `=`)、値なし: 日本語ラベル (gray)。
  if (s.series.length > 0) {
    const w = s.series[0];
    header += " " + (
      w.value == null
        ? chalk.gray(conditionLabelForMissing(w.condition))
        : conditionArrow(w.condition)
    );
  }
  // h3 (station): 4 indent + ○ marker。h2 (river) の ◇ と区別するため形を変え、
  // インデントを +2 して階層を視覚化する (見出し原則: river > station > series)。
  lines.push("    " + chalk.bold.cyan("○") + " " + header);

  // 時系列 (h4): h3 の content col に合わせて 6 indent (h3 marker +2)
  const seriesLines = buildSeriesLines(s, width);
  for (const sl of seriesLines) {
    lines.push("      " + sl);
  }

  // criteria (h4): 共有 helper `packGreedyByWidth` で行分け。chalk.gray は各行に独立適用
  // (折り返し時の ANSI 剥離を回避、狭幅で gray 色が抜けるバグ対策)。
  const criteriaLines = packGreedyByWidth(
    formatCriteriaParts(s.criteria),
    "  ",
    Math.max(8, width - 10),
  );
  for (const cl of criteriaLines) {
    lines.push("      " + chalk.gray(cl));
  }
  return lines;
}

/**
 * 観測所ブロック (Task 19b).
 *
 * 河川 divider + 観測所 item (header + 時系列 2 行 + Criteria 1 行) を順次積む.
 * VPTA50 の item pack pattern を参考にしたが、洪水 station は 1 件あたり 4 行と
 * 大きいので、wrap pack は使わず行単位で出力 (80 桁制約は visualWidth で個別 cap).
 */
function buildRiverStationGroupBlock(
  info: ParsedFloodForecastInfo,
  rivers: RiverSection[],
  width: number,
  level: FrameLevel,
  color: (s: string) => string,
): string[] {
  void info;
  const lines: string[] = [];
  if (rivers.length === 0) return lines;

  lines.push(
    frameDividerLabeledColored(
      level,
      color,
      chalk.bold.cyan(" ▸ 観測所 "),
      width,
    ),
  );

  for (const river of rivers) {
    if (river.stations.length === 0) continue;
    // 河川名 divider (空文字なら fallback)
    const riverLabel =
      river.riverName !== "" ? river.riverName : river.riverKey;
    lines.push(
      frameLineColored(
        level,
        color,
        `  ${chalk.bold.cyan("◇ " + riverLabel)}  ${levelChip(river.highestObservedLevel)}`,
        width,
      ),
    );

    for (const s of river.stations) {
      const stationLines = buildStationLines(s, width);
      for (const raw of stationLines) {
        // 80 桁制約: stationName 長すぎは '…' 省略 — visualWidth が枠内余白を超えそうな
        // 場合に切り詰める. 余白 = width - 4 (フレーム左右 + space).
        let line = raw;
        const inner = width - 4;
        if (visualWidth(stripAnsi(line)) > inner) {
          // ANSI 保持で削るのは難しいので、stripAnsi 結果を 1 文字ずつ切り詰める
          // (まれな超過のフォールバック; 通常は inner に収まる).
          const plain = stripAnsi(line);
          let acc = "";
          let used = 0;
          for (const ch of plain) {
            const w = visualWidth(ch);
            if (used + w + 1 > inner) {
              acc += "…";
              break;
            }
            acc += ch;
            used += w;
          }
          line = acc;
        }
        lines.push(frameLineColored(level, color, line, width));
      }
    }
  }
  return lines;
}

/**
 * 浸水想定地区ブロック (Task 20a + 2026-06-18 redesign).
 *
 * - `info.inundationAreas` を variant → prefName でグループ化 (2 層、出現順保持)
 * - h2 variant (◇)、h3 prefName (○)、items は ", " 区切り greedy pack で折り返し
 * - station axis + subCity あり時は item を `観測所名 [sub・cities (+N)]` 形式に
 * - 旧 truncation (先頭 N 件 cap + 注釈) は廃止: 県別グループ化 + comma 折り返しで
 *   行数が大幅圧縮されるため (レビュー決定 (2026-06-18))。`info.inundationAreas` 全件出力
 * - `info.inundationAreas` 自体は **変異させない** (spec §7.5 契約)
 */
function buildInundationBlock(
  info: ParsedFloodForecastInfo,
  width: number,
  level: FrameLevel,
  color: (s: string) => string,
): string[] {
  const lines: string[] = [];
  if (info.inundationAreas.length === 0) return lines;
  // 旧仕様の先頭 N 件 cap + 省略注釈は、prefName グループ化 + comma 折り返しで
  // 行数が大幅に削れるため廃止 (2026-06-18)。`info.inundationAreas` 全件をそのまま grouping へ。

  lines.push(
    frameDividerLabeledColored(
      level,
      color,
      chalk.bold.cyan(" ▸ 浸水想定地区 "),
      width,
    ),
  );

  // variant → prefName でグループ化 (2 層、出現順保持)。
  // axis (市町村/観測所/区分不明) は item 形式 (station axis なら `[sub・cities]`) で
  // 暗黙に表現するため、グループキーから除外 (提案 (2026-06-18))。
  type PrefBucket = Map<string /* prefName */, InundationArea[]>;
  const variants = new Map<string /* variant */, PrefBucket>();
  const variantOrder: string[] = [];
  for (const a of info.inundationAreas) {
    let prefBucket = variants.get(a.variant);
    if (prefBucket == null) {
      prefBucket = new Map();
      variants.set(a.variant, prefBucket);
      variantOrder.push(a.variant);
    }
    const prefKey = a.prefName !== "" ? a.prefName : "県不明";
    const arr = prefBucket.get(prefKey);
    if (arr == null) {
      prefBucket.set(prefKey, [a]);
    } else {
      arr.push(a);
    }
  }

  // greedy pack で items を行分け (h4 indent 6 + 枠 padding 4 = width - 10 が枠)
  const itemInner = Math.max(8, width - 10);
  const itemSep = ", ";

  for (const variant of variantOrder) {
    const prefBucket = variants.get(variant)!;
    // h2 (variant): ◇ marker (cyan bold)
    lines.push(
      frameLineColored(
        level,
        color,
        `  ${chalk.bold.cyan("◇")} ${chalk.white(variant)}`,
        width,
      ),
    );

    for (const [prefName, areas] of prefBucket) {
      // h3 (prefecture): ○ marker (cyan bold、station h3 と同じ)
      lines.push(
        frameLineColored(
          level,
          color,
          `    ${chalk.bold.cyan("○")} ${chalk.white(prefName)}`,
          width,
        ),
      );

      // items text: axis に応じて整形
      //   station axis + subCity あり → "市町村名 [sub-areas (+N)]"
      //     ※ areaName (station 名) は内部情報。住民にとって意味あるのは cityName。
      //        cityName が無ければ areaName fallback (レビュー指摘 (2026-06-18) — 大石田が
      //        2 件並んでいたのは 1 station × 2 city の構造、city を出せば自然に区別される)
      //   それ以外 → cityName ?? areaName のみ
      // 県名 prefix は h3 で既に表示済みなので、表示直前に prefName を剥がす
      // (例: "茨城県古河市" → "古河市"、レビュー指摘 (2026-06-18))。
      const stripPref = (name: string): string =>
        prefName !== "県不明" && name.startsWith(prefName) ? name.slice(prefName.length) : name;
      const cityOrArea = (a: InundationArea): string =>
        a.cityName != null && a.cityName !== "" ? stripPref(a.cityName) : stripPref(a.areaName);
      const itemTexts = areas.map((a) => {
        const head = cityOrArea(a);
        if (a.axis === "station" && a.subCityList.length > 0) {
          const subStripped = a.subCityList.map(stripPref);
          const sub = subStripped.slice(0, 3).join("・");
          const more =
            a.subCityList.length > 3 ? ` (+${a.subCityList.length - 3})` : "";
          return `${head} [${sub}${more}]`;
        }
        return head;
      });

      // 共有 helper `packGreedyByWidth` で行分け。gray は各行に独立適用 (wrap 時色抜け回避)
      const packed = packGreedyByWidth(itemTexts, itemSep, itemInner);
      for (const p of packed) {
        lines.push(frameLineColored(level, color, `      ${chalk.gray(p)}`, width));
      }
    }
  }

  return lines;
}

/** windowMinutes から累積ラベルを動的化。null/< 60 は防御 fallback (spec §5.1)
 *  @internal 直接テスト用 export. production の呼び出しは buildRainfallBlock 経由. */
export function formatWindowLabel(windowMinutes: number | null): string {
  if (windowMinutes == null) return "(?時間)累積";
  if (windowMinutes < 60) return "(?時間)累積";
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}時間累積`;
  const h = Math.floor(windowMinutes / 60);
  const m = windowMinutes % 60;
  return `${h}時間${m}分累積`;
}

/**
 * windowMinutes から予測ラベルを動的化。cumulative と対称に null/< 60 を防御 fallback
 * (Codex review W4 反映 — parser 側で 180 default invent を廃止したため、formatter 側で
 *  対称な防御 fallback を持つ。Duration PT0H30M = 30 のような < 60 経路も含む)
 * @internal 直接テスト用 export. production の呼び出しは buildRainfallBlock 経由.
 */
export function formatForecastLabel(windowMinutes: number | null): string {
  if (windowMinutes == null) return "(?時間)予測";
  if (windowMinutes < 60) return "(?時間)予測";
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}時間予測`;
  const h = Math.floor(windowMinutes / 60);
  const m = windowMinutes % 60;
  return `${h}時間${m}分予測`;
}

/**
 * 雨量ブロックを組み立てる。
 * - VXKO: basinName + cumulativeActual (任意長窓) / forecastShort (PT3H 等)
 * - VXSU: trend + currentBasinIndex (VXSU は displayVxsuMinimal 経路なのでここに来ない)
 */
function buildRainfallBlock(
  info: ParsedFloodForecastInfo,
  width: number,
  level: FrameLevel,
  color: (s: string) => string,
): string[] {
  const lines: string[] = [];
  if (info.rainfallSummaries.length === 0) return lines;

  lines.push(
    frameDividerLabeledColored(
      level,
      color,
      chalk.bold.cyan(" ▸ 雨量 "),
      width,
    ),
  );

  for (const r of info.rainfallSummaries) {
    const heading = r.basinName != null && r.basinName !== "" ? r.basinName : "(流域不明)";
    lines.push(
      frameLineColored(
        level,
        color,
        `  ${chalk.bold.cyan("◇")} ${chalk.white(heading)}`,
        width,
      ),
    );

    // VXKO: 累積実況 (任意長) / 短時間予測 (PT3H 等)
    const parts: string[] = [];
    if (r.cumulativeActual != null) {
      const v = r.cumulativeActual.value == null ? "--" : String(r.cumulativeActual.value);
      parts.push(`${formatWindowLabel(r.cumulativeActual.windowMinutes)} ${v} ${r.cumulativeActual.unit}`);
    }
    if (r.forecastShort != null) {
      const v = r.forecastShort.value == null ? "--" : String(r.forecastShort.value);
      parts.push(`${formatForecastLabel(r.forecastShort.windowMinutes)} ${v} ${r.forecastShort.unit}`);
    }
    // VXSU 由来 (currentBasinIndex / trend) - normally not reached for VXKO
    if (r.currentBasinIndex != null) {
      parts.push(`流域雨量指数 ${r.currentBasinIndex}`);
    }
    if (r.trend != null) {
      parts.push(`傾向 ${r.trend}`);
    }
    if (parts.length > 0) {
      for (const wrapped of wrapFrameLinesColored(
        level,
        color,
        `     ${chalk.white(parts.join("  /  "))}`,
        width,
      )) {
        lines.push(wrapped);
      }
    }
  }
  return lines;
}

/** ISO 8601 を MM/DD HH:mm に整形. parsing 失敗時は元文字列を返す. */
function isoToShort(iso: string | null): string {
  if (iso == null || iso === "") return "";
  const m = iso.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (m == null) return iso;
  return `${m[1]}/${m[2]} ${m[3]}:${m[4]}`;
}

/**
 * 氾濫水予報ブロック (Task 20c).
 *
 * 主条件は `info.floodAssumptions.length > 0` (Code 値非依存、spec §7.4).
 * 主文の直後・観測所ブロック群の前に配置 (spec §7.1 layout).
 */
function buildFloodAssumptionBlock(
  info: ParsedFloodForecastInfo,
  width: number,
  level: FrameLevel,
  color: (s: string) => string,
): string[] {
  const lines: string[] = [];
  if (info.floodAssumptions.length === 0) return lines;

  const limit = getTruncation().floodAssumptionLines;
  const visible = info.floodAssumptions.slice(0, limit);
  const truncated = info.floodAssumptions.length > limit;

  lines.push(
    frameDividerLabeledColored(
      level,
      color,
      chalk.bold.cyan(" ▸ 氾濫水の予報 "),
      width,
    ),
  );

  for (const a of visible) {
    // 1 行目: 河川名 + assumptionAreaName (どちらか欠落あり)
    const riverPart = a.riverName != null && a.riverName !== "" ? a.riverName : "";
    const areaPart =
      a.assumptionAreaName != null && a.assumptionAreaName !== ""
        ? a.assumptionAreaName
        : "(地区不明)";
    const heading =
      riverPart !== ""
        ? `${chalk.bold.cyan(riverPart)}  ${chalk.white(areaPart)}`
        : chalk.white(areaPart);
    lines.push(frameLineColored(level, color, `  ${chalk.bold.cyan("◇")} ${heading}`, width));

    // 2 行目: 到達時刻 + 浸水深
    const parts: string[] = [];
    if (a.attainmentTime != null) {
      const dub = a.attainmentDubious ?? "";
      const desc = a.attainmentDescription != null ? a.attainmentDescription : isoToShort(a.attainmentTime);
      parts.push(`到達 ${desc}${dub}`);
    }
    if (a.depthMaxM != null || a.depthMinM != null) {
      const lo = a.depthMinM == null ? "?" : String(a.depthMinM);
      const hi = a.depthMaxM == null ? "?" : String(a.depthMaxM);
      parts.push(`浸水深 ${lo}〜${hi}m`);
    }
    if (a.attainmentDeepestTime != null) {
      parts.push(`最深 ${isoToShort(a.attainmentDeepestTime)}`);
    }
    if (parts.length > 0) {
      for (const wrapped of wrapFrameLinesColored(
        level,
        color,
        `     ${chalk.gray(parts.join("  /  "))}`,
        width,
      )) {
        lines.push(wrapped);
      }
    }
  }

  if (truncated) {
    const note = `   ${chalk.gray(`(計 ${info.floodAssumptions.length} 件、先頭 ${limit} 件)`)}`;
    for (const wrapped of wrapFrameLinesColored(level, color, note, width)) {
      lines.push(wrapped);
    }
  }
  return lines;
}

/** VXKO normal layout. ブロックを順次積み、`flushWithRecap` で出力. */
function displayVxkoNormal(
  info: ParsedFloodForecastInfo,
  rivers: RiverSection[],
): void {
  const width = getFrameWidth();
  const levels = resolveFloodForecastLevels(info);
  const level: FrameLevel = levels.frameLevel;
  const color = level === "cancel" ? getDisplaySeverityText("release") : WHITE_BORDER;
  const buf = createRenderBuffer();

  buf.pushEmpty();
  buf.push(frameTopColored(level, color, width));
  if (info.isTest) {
    buf.push(
      frameLineColored(
        level,
        color,
        theme.getRoleChalk("testBadge")(" テスト電文 "),
        width,
      ),
    );
  }
  if (info.infoType === "訂正") {
    buf.push(
      frameLineColored(
        level,
        color,
        theme.getRoleChalk("correctionBadge")(" 訂正電文 "),
        width,
      ),
    );
  }
  const titleHead =
    chalk.bold(info.infoKind || "指定河川洪水予報") +
    chalk.gray(`  ${info.infoType}`) +
    chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  pushTitleWithOverflow(buf, level, color, width, titleHead, info.headTitle);

  // 主文ブロック (Task 19a)
  const mainTextLines = buildMainTextBlock(info, width, level, color);
  if (mainTextLines.length > 0) {
    buf.push(frameDividerColored(level, color, width));
    for (const l of mainTextLines) buf.push(l);
  }

  // 氾濫水予報ブロック (Task 20c) — 主文の直後・観測所ブロックの前 (spec §7.1)
  const floodAssumptionLines = buildFloodAssumptionBlock(
    info,
    width,
    level,
    color,
  );
  for (const l of floodAssumptionLines) buf.push(l);

  // 観測所ブロック (Task 19b)
  const stationLines = buildRiverStationGroupBlock(
    info,
    rivers,
    width,
    level,
    color,
  );
  for (const l of stationLines) buf.push(l);

  // 浸水想定地区ブロック (Task 20a)
  const inundationLines = buildInundationBlock(info, width, level, color);
  for (const l of inundationLines) buf.push(l);

  // 雨量予測ブロック (Task 20b)
  const rainfallLines = buildRainfallBlock(info, width, level, color);
  for (const l of rainfallLines) buf.push(l);

  renderFooter(
    level,
    info.typeCode,
    info.reportDateTime,
    info.publishingOffice,
    width,
    buf,
    color,
  );
  buf.push(frameBottomColored(level, color, width));
  buf.pushEmpty();
  flushWithRecap(buf, level, width, color);
}

/**
 * 指定河川洪水予報 / 水位周知河川に関する情報 の表示エントリポイント。
 *
 * 1. 取消 (info.infoType === "取消") → `displayCancelPath` 早期 return
 * 2. VXSU schema → `displayVxsuMinimal`
 * 3. それ以外 (VXKO) → `displayVxkoNormal` (内部で `rivers = aggregateByRiver(...)`)
 */
export function displayFloodForecastInfo(info: ParsedFloodForecastInfo): void {
  if (info.infoType === "取消") {
    displayCancelPath(info);
    return;
  }
  if (info.schema === "vxsu50") {
    displayVxsuMinimal(info);
    return;
  }
  displayVxkoNormal(info, aggregateByRiver(info.rawStations));
}
