import chalk from "chalk";
import {
  ParsedClimateInfo,
  ClimateStationValue,
  ClimateBodyText,
} from "../types";
import * as theme from "./theme";
import {
  FrameLevel,
  getFrameWidth,
  SEVERITY_LABELS,
  frameTop,
  frameLine,
  frameDivider,
  frameBottom,
  createRenderBuffer,
  flushWithRecap,
  wrapFrameLines,
  renderFooter,
  visualPadEnd,
  visualWidth,
} from "./formatter";
import { climateInfoFrameLevel } from "../engine/presentation/level-helpers";

/** controlTitle 空時のフォールバック表示名 */
const DEFAULT_CONTROL_TITLE = "天候情報";

/**
 * 平年差の符号付き表記を返す (列内統一の小数桁つき)。
 *   value=1.6 / unit="℃" / decimals=1 → "+1.6℃"
 *   value=-0.5 / unit="℃" / decimals=1 → "−0.5℃"
 */
function formatSignedAnomaly(
  value: number,
  unit: string,
  decimals: number,
): string {
  const abs = Math.abs(value).toFixed(decimals);
  if (value > 0) return `+${abs}${unit}`;
  if (value < 0) return `−${abs}${unit}`;
  return `±${abs}${unit}`;
}

/** 数値の小数桁数 (列内最大小数桁の算出用) */
function decimalsOf(v: number): number {
  const s = String(v);
  const idx = s.indexOf(".");
  return idx < 0 ? 0 : s.length - idx - 1;
}

/** 観測点数値列: 列内統一フォーマッタと最大視覚幅 */
interface NumColumn {
  format: (v: number) => string;
  width: number;
}

/**
 * 列内の非 null 値から数値列を構築する。値が 1 つも無ければ null (列ごと省略)。
 * 小数桁を列内最大に統一する理由: 電文原文は同一表内で小数桁が揃っている
 * (例: VPZI50 の降水量 "58.0") が、parseFloat で末尾の .0 が落ちて "58mm" と
 * 表示され列がずれていた。列内最大小数桁へ揃えることで原文の精度表記を復元する。
 */
function makeColumn(
  values: Array<number | null>,
  toText: (v: number, decimals: number) => string,
): NumColumn | null {
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) return null;
  const decimals = Math.max(...present.map(decimalsOf));
  const format = (v: number) => toText(v, decimals);
  const width = Math.max(...present.map((v) => visualWidth(format(v))));
  return { format, width };
}

/** visualWidth ベースの右揃えパディング */
function padStartVisual(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visualWidth(text))) + text;
}

/** "(平年 ...)" 装飾の固定幅分 */
const NORMAL_DECOR_WIDTH = visualWidth("(平年 )");
/** "平年比 " ラベルの固定幅分 */
const RATIO_LABEL_WIDTH = visualWidth("平年比 ");

/**
 * 観測点別気候値の行群を整形する (フレーム折返し前の生文字列)。
 *
 * 列揃え: 全観測点をスキャンして各数値フィールド (気温値・平年差・平年値・
 * 降水量・平年比・平年値) の最大視覚幅を事前計算し、右揃えパディングで
 * 「気温」「降水」「平年比」の開始桁を揃える。フィールドが無い観測点は
 * 同幅の空白で埋めて後続列のずれを防ぐ。
 *
 * 全フィールド null の観測点 (「表題」型などで今後も発生し得る) は
 * 1 行 1 局の縦積みにせず " / " 区切りで連結する
 * (" / " は wrapSingleLine の delimiters にあり折返しも自然に効く)。
 */
function formatStationLines(stations: ClimateStationValue[]): string[] {
  const hasAnyValue = (s: ClimateStationValue): boolean =>
    s.temperatureCelsius != null ||
    s.temperatureAnomalyCelsius != null ||
    s.temperatureNormalCelsius != null ||
    s.precipitationMm != null ||
    s.precipitationAnomalyPercent != null ||
    s.precipitationNormalMm != null;
  const valued = stations.filter(hasAnyValue);
  const empty = stations.filter((s) => !hasAnyValue(s));

  const lines: string[] = [];

  if (valued.length > 0) {
    const tempCol = makeColumn(
      valued.map((s) => s.temperatureCelsius),
      (v, d) => `${v.toFixed(d)}℃`,
    );
    const tempAnomCol = makeColumn(
      valued.map((s) => s.temperatureAnomalyCelsius),
      (v, d) => formatSignedAnomaly(v, "℃", d),
    );
    const tempNormCol = makeColumn(
      valued.map((s) => s.temperatureNormalCelsius),
      (v, d) => `${v.toFixed(d)}℃`,
    );
    const precipCol = makeColumn(
      valued.map((s) => s.precipitationMm),
      (v, d) => `${v.toFixed(d)}mm`,
    );
    const precipAnomCol = makeColumn(
      valued.map((s) => s.precipitationAnomalyPercent),
      (v, d) => `${v.toFixed(d)}%`,
    );
    const precipNormCol = makeColumn(
      valued.map((s) => s.precipitationNormalMm),
      (v, d) => `${v.toFixed(d)}mm`,
    );

    // 観測点名は max(既存 8, 実最大)。8 固定だと長い名前で列が崩れるため
    const nameWidth = Math.max(
      8,
      ...valued.map((s) => visualWidth(s.stationName)),
    );

    /** 気温ブロックの固定幅 ("気温 値 平年差 (平年 値)") */
    const tempBlockWidth =
      tempCol || tempAnomCol || tempNormCol
        ? visualWidth("気温 ") +
          (tempCol?.width ?? 0) +
          (tempAnomCol ? 1 + tempAnomCol.width : 0) +
          (tempNormCol ? 1 + NORMAL_DECOR_WIDTH + tempNormCol.width : 0)
        : 0;
    /** 降水ブロックの固定幅 ("降水 値 平年比 値% (平年 値)") */
    const precipBlockWidth =
      precipCol || precipAnomCol || precipNormCol
        ? visualWidth("降水 ") +
          (precipCol?.width ?? 0) +
          (precipAnomCol ? 1 + RATIO_LABEL_WIDTH + precipAnomCol.width : 0) +
          (precipNormCol ? 1 + NORMAL_DECOR_WIDTH + precipNormCol.width : 0)
        : 0;

    const renderTempBlock = (s: ClimateStationValue): string => {
      if (tempBlockWidth === 0) return "";
      const has =
        s.temperatureCelsius != null ||
        s.temperatureAnomalyCelsius != null ||
        s.temperatureNormalCelsius != null;
      if (!has) return " ".repeat(tempBlockWidth);
      let out = `${chalk.yellow("気温")} `;
      if (tempCol) {
        out +=
          s.temperatureCelsius != null
            ? padStartVisual(tempCol.format(s.temperatureCelsius), tempCol.width)
            : " ".repeat(tempCol.width);
      }
      if (tempAnomCol) {
        out +=
          s.temperatureAnomalyCelsius != null
            ? ` ${chalk.gray(
                padStartVisual(
                  tempAnomCol.format(s.temperatureAnomalyCelsius),
                  tempAnomCol.width,
                ),
              )}`
            : " ".repeat(1 + tempAnomCol.width);
      }
      if (tempNormCol) {
        out +=
          s.temperatureNormalCelsius != null
            ? ` ${chalk.gray(
                `(平年 ${padStartVisual(
                  tempNormCol.format(s.temperatureNormalCelsius),
                  tempNormCol.width,
                )})`,
              )}`
            : " ".repeat(1 + NORMAL_DECOR_WIDTH + tempNormCol.width);
      }
      return out;
    };

    const renderPrecipBlock = (s: ClimateStationValue): string => {
      if (precipBlockWidth === 0) return "";
      const has =
        s.precipitationMm != null ||
        s.precipitationAnomalyPercent != null ||
        s.precipitationNormalMm != null;
      if (!has) return " ".repeat(precipBlockWidth);
      let out = `${chalk.cyan("降水")} `;
      if (precipCol) {
        out +=
          s.precipitationMm != null
            ? padStartVisual(precipCol.format(s.precipitationMm), precipCol.width)
            : " ".repeat(precipCol.width);
      }
      if (precipAnomCol) {
        out +=
          s.precipitationAnomalyPercent != null
            ? ` ${chalk.gray(
                `平年比 ${padStartVisual(
                  precipAnomCol.format(s.precipitationAnomalyPercent),
                  precipAnomCol.width,
                )}`,
              )}`
            : " ".repeat(1 + RATIO_LABEL_WIDTH + precipAnomCol.width);
      }
      if (precipNormCol) {
        out +=
          s.precipitationNormalMm != null
            ? ` ${chalk.gray(
                `(平年 ${padStartVisual(
                  precipNormCol.format(s.precipitationNormalMm),
                  precipNormCol.width,
                )})`,
              )}`
            : " ".repeat(1 + NORMAL_DECOR_WIDTH + precipNormCol.width);
      }
      return out;
    };

    for (const s of valued) {
      const nameLabel = chalk.bold.white(visualPadEnd(s.stationName, nameWidth));
      const blocks = [renderTempBlock(s), renderPrecipBlock(s)].filter(
        (b) => b !== "",
      );
      lines.push(`  ${nameLabel} ${blocks.join("  ")}`.replace(/ +$/, ""));
    }
  }

  // 全フィールド null の観測点はスラッシュ区切りで連結 (折返しは wrap に任せる)
  if (empty.length > 0) {
    lines.push(
      `  ${empty.map((s) => chalk.bold.white(s.stationName)).join(" / ")}`,
    );
  }

  return lines;
}

/** 本文ブロックの type ラベル装飾 */
function bodyTextHeaderLabel(bt: ClimateBodyText): string {
  if (bt.textType == null) return "本文";
  return bt.textType;
}

/** 天候情報 (VPZI50 全般 / VPCI50 地方) を表示 */
export function displayClimateInfo(info: ParsedClimateInfo): void {
  const level = climateInfoFrameLevel(info);
  const width = getFrameWidth();
  // info.controlTitle は string 型だが空文字になりうるので || を使用
  const label = info.controlTitle || DEFAULT_CONTROL_TITLE;

  const buf = createRenderBuffer();
  buf.pushEmpty();
  buf.push(frameTop(level, width));

  // テスト電文バッジ
  if (info.isTest) {
    buf.push(
      frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width),
    );
  }

  // タイトル行
  const titleContent =
    chalk.bold(label) +
    chalk.gray(`  ${info.infoType}`) +
    chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLine(level, titleContent, width));

  if (info.title && info.title !== label) {
    for (const wrapped of wrapFrameLines(level, chalk.white(info.title), width)) {
      buf.push(wrapped);
    }
  }

  // 取消は短く
  if (info.infoType === "取消") {
    buf.push(frameDivider(level, width));
    buf.push(
      frameLine(level, chalk.gray(`${label}は取り消されました`), width),
    );
    renderFooter(
      level,
      info.type,
      info.reportDateTime,
      info.publishingOffice,
      width,
      buf,
    );
    buf.push(frameBottom(level, width));
    buf.pushEmpty();
    flushWithRecap(buf, level, width);
    return;
  }

  // Headline
  if (info.headline) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, chalk.gray("[ヘッドライン]"), width));
    for (const rawLine of info.headline.split("\n")) {
      const trimmed = rawLine.replace(/　/g, " ");
      for (const wrapped of wrapFrameLines(
        level,
        `  ${chalk.white(trimmed)}`,
        width,
      )) {
        buf.push(wrapped);
      }
    }
  }

  // 対象地域
  if (info.targetArea) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, chalk.gray("[対象地域]"), width));
    buf.push(frameLine(level, `  ${chalk.white(info.targetArea.name)}`, width));
  }

  // 本文ブロック (概況 / 今後の見通し / 防災事項 等)
  if (info.bodyTexts.length > 0) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, chalk.gray("[本文]"), width));
    for (const bt of info.bodyTexts) {
      // [レビュー Minor] 外側の controlTitle 由来 `label` と shadowing しないよう btLabel
      const btLabel = bodyTextHeaderLabel(bt);
      buf.push(
        frameLine(level, `  ${chalk.bold.yellow(`▸ ${btLabel}`)}`, width),
      );
      for (const rawLine of bt.text.split("\n")) {
        const trimmed = rawLine.replace(/　/g, " ");
        for (const wrapped of wrapFrameLines(
          level,
          `    ${chalk.white(trimmed)}`,
          width,
        )) {
          buf.push(wrapped);
        }
      }
      // 地域 (TargetArea と異なる細分のみ表示)
      const areaNames = bt.areas
        .filter((a) => info.targetArea == null || a.code !== info.targetArea.code)
        .map((a) => a.name);
      if (areaNames.length > 0) {
        for (const wrapped of wrapFrameLines(
          level,
          `    ${chalk.gray("対象: " + areaNames.join(", "))}`,
          width,
        )) {
          buf.push(wrapped);
        }
      }
    }
  }

  // 季節イベント (梅雨入り/明け等。VPCI50 のみ)
  if (info.seasonEvents.length > 0) {
    buf.push(frameDivider(level, width));
    for (const ev of info.seasonEvents) {
      // Date 欠落 = 「発表を行わないこととした」ケース (30_03 等)。
      // 「日付不明」はミスリードなので「発表なし」と表示する。
      const main = ev.dateDescription ?? "（発表なし）";
      const subParts: string[] = [];
      if (ev.normalDescription) subParts.push(`平年 ${ev.normalDescription}`);
      if (ev.lastYearDescription) subParts.push(`昨年 ${ev.lastYearDescription}`);
      const sub = subParts.length > 0 ? chalk.gray(` (${subParts.join(" / ")})`) : "";
      const line = `  ${chalk.bold.yellow(`▸ ${ev.eventType}`)} ${chalk.white(main)}${sub}`;
      for (const wrapped of wrapFrameLines(level, line, width)) {
        buf.push(wrapped);
      }
      // 地域 (TargetArea と異なる細分のみ表示。bodyTexts と同じ挙動)
      const evAreaNames = ev.areas
        .filter((a) => info.targetArea == null || a.code !== info.targetArea.code)
        .map((a) => a.name);
      if (evAreaNames.length > 0) {
        for (const wrapped of wrapFrameLines(
          level,
          `    ${chalk.gray("対象: " + evAreaNames.join(", "))}`,
          width,
        )) {
          buf.push(wrapped);
        }
      }
    }
  }

  // 観測点別気候値
  if (info.stations.length > 0) {
    buf.push(frameDivider(level, width));
    // 期間ラベル (代表 1 件) があれば表示
    const periodLabel = info.stations.find((s) => s.periodLabel)?.periodLabel;
    if (periodLabel) {
      buf.push(
        frameLine(level, chalk.gray(`[観測点別気候値] ${periodLabel}`), width),
      );
    } else {
      buf.push(frameLine(level, chalk.gray("[観測点別気候値]"), width));
    }
    // [Codex R1 I1] 観測点名は日本語幅を考慮する (visualPadEnd)。
    // 数値列も全観測点スキャンの右揃えで列を揃える (formatStationLines)。
    for (const line of formatStationLines(info.stations)) {
      for (const wrapped of wrapFrameLines(level, line, width)) {
        buf.push(wrapped);
      }
    }
  }

  // 末文 (Comment)
  if (info.comment) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, chalk.gray("[末文]"), width));
    for (const rawLine of info.comment.split("\n")) {
      const trimmed = rawLine.replace(/　/g, " ");
      for (const wrapped of wrapFrameLines(
        level,
        `  ${chalk.dim(trimmed)}`,
        width,
      )) {
        buf.push(wrapped);
      }
    }
  }

  // フッター
  renderFooter(
    level,
    info.type,
    info.reportDateTime,
    info.publishingOffice,
    width,
    buf,
  );

  buf.push(frameBottom(level, width));
  buf.pushEmpty();

  flushWithRecap(buf, level, width);
}
