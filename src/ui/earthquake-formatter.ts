import chalk from "chalk";
import {
  ParsedEarthquakeInfo,
  ParsedTsunamiInfo,
  ParsedSeismicTextInfo,
  ParsedNankaiTroughInfo,
  ParsedLgObservationInfo,
} from "../types";
import * as theme from "./theme";
import {
  FrameLevel,
  HighlightRule,
  getFrameWidth,
  getDisplayMode,
  getInfoFullText,
  getTruncation,
  getMaxObservations,
  SEVERITY_LABELS,
  frameColor,
  frameTop,
  frameLine,
  frameDivider,
  frameBottom,
  createRenderBuffer,
  flushWithRecap,
  renderFrameTable,
  stripAnsi,
  visualWidth,
  visualPadEnd,
  wrapFrameLines,
  highlightAndWrap,
  formatTimestamp,
  intensityColor,
  lgIntensityColor,
  intensityToNumeric,
  lgIntToNumeric,
  colorMagnitude,
  renderFooter,
} from "./formatter";

// ── テーブル幅閾値 ──

/** テーブル幅がこの値以上のとき、津波情報をカラム区切りテーブルで表示 */
const WIDE_TABLE_THRESHOLD = 80;

// ── 電文タイプラベル ──

/** 電文タイプの日本語名 */
export function typeLabel(type: string): string {
  const map: Record<string, string> = {
    VXSE51: "震度速報",
    VXSE52: "震源に関する情報",
    VXSE53: "震源・震度に関する情報",
    VXSE56: "地震の活動状況等に関する情報",
    VXSE60: "地震回数に関する情報",
    VXSE61: "顕著な地震の震源要素更新のお知らせ",
    VTSE41: "津波警報・注意報・予報",
    VTSE51: "津波情報",
    VTSE52: "沖合の津波情報",
    VXSE43: "緊急地震速報（警報）",
    VXSE44: "緊急地震速報（予報）",
    VXSE45: "緊急地震速報（地震動予報）",
    VXSE62: "長周期地震動に関する観測情報",
    VZSE40: "地震・津波に関するお知らせ",
    VYSE50: "南海トラフ地震臨時情報",
    VYSE51: "南海トラフ地震関連解説情報（臨時）",
    VYSE52: "南海トラフ地震関連解説情報（定例）",
    VYSE60: "北海道・三陸沖後発地震注意情報",
  };
  return map[type] || type;
}

// ── 地震情報ヘルパー ──

/** 地震情報のフレームレベルを決定 */
function earthquakeFrameLevel(info: ParsedEarthquakeInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (info.intensity) {
    const num = intensityToNumeric(info.intensity.maxInt);
    if (num >= 7) return "critical";  // 6弱以上
    if (num >= 4) return "warning";   // 4以上
  }
  return "normal";
}

/** 津波情報の短縮テキスト */
function tsunamiShort(info: ParsedEarthquakeInfo): string {
  if (!info.tsunami) return "";
  const t = info.tsunami.text;
  if (t.includes("心配はありません") || t.includes("心配なし")) return theme.getRoleChalk("tsunamiNone")("津波なし");
  if (t.includes("注意")) return theme.getRoleChalk("tsunamiAdvisory")("津波注意");
  if (t.includes("警報")) return theme.getRoleChalk("tsunamiWarning")("津波警報");
  return chalk.white(t.length > 10 ? t.substring(0, 10) + "…" : t);
}

// ── ハイライトルール ──

/** 南海トラフ共通ルール */
const NANKAI_COMMON_RULES: readonly HighlightRule[] = [
  { source: "巨大地震警戒", flags: "", style: () => theme.getRoleChalk("nankaiSerialCritical") },
  { source: "大規模地震", flags: "", style: () => theme.getRoleChalk("nankaiSerialCritical") },
  { source: "巨大地震注意|後発地震注意情報|後発地震への注意", flags: "", style: () => theme.getRoleChalk("nankaiSerialWarning") },
  { source: "調査中|調査を開始", flags: "", style: () => theme.getRoleChalk("nankaiSerialWarning") },
  { source: "モーメントマグニチュード[（Ｍｗ）０-９0-9．.クラス以上]*|マグニチュード[（Ｍ）０-９0-9．.クラス以上]*|Ｍｗ[０-９0-9]+", flags: "", style: () => chalk.bold.white },
  { source: "防災対応をとってください|今後の情報に注意してください|身の安全を守る行動", flags: "", style: () => theme.getRoleChalk("nextAdvisory") },
  { source: "相対的に高まっている", flags: "", style: () => theme.getRoleChalk("warningComment") },
  { source: "調査終了", flags: "", style: () => theme.getRoleChalk("textMuted") },
];

/** VYSE52 追加ルール */
const NANKAI_VYSE52_EXTRA_RULES: readonly HighlightRule[] = [
  { source: "特段の変化は観測されていません", flags: "", style: () => theme.getRoleChalk("textMuted") },
  { source: "短期的ゆっくりすべり|長期的ゆっくりすべり", flags: "", style: () => chalk.bold.white },
];

/** テキスト系ルール */
const SEISMIC_TEXT_RULES: readonly HighlightRule[] = [
  { source: "活発", flags: "", style: () => theme.getRoleChalk("warningComment") },
  { source: "最大マグニチュード[０-９0-9Ｍ．.]+程度|マグニチュード[０-９0-9．.]+", flags: "", style: () => theme.getRoleChalk("warningComment") },
  { source: "最大震度[０-９0-9][弱強]?|震度[０-９0-9][弱強]?を観測", flags: "", style: () => theme.getRoleChalk("warningComment") },
  { source: "防災上の留意事項|見通し", flags: "", style: () => chalk.bold.white },
];

/** 電文種別に応じた南海トラフルールを返す */
function getNankaiRules(type: string): readonly HighlightRule[] {
  if (type === "VYSE52") {
    return [...NANKAI_COMMON_RULES, ...NANKAI_VYSE52_EXTRA_RULES];
  }
  return NANKAI_COMMON_RULES;
}

/** 電文種別に応じたテキスト系ルールを返す */
function getSeismicTextRules(_type: string): readonly HighlightRule[] {
  return SEISMIC_TEXT_RULES;
}

// ── 津波情報ヘルパー ──

/** 津波情報のフレームレベルを決定 */
function tsunamiFrameLevel(info: ParsedTsunamiInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  const kinds = (info.forecast || []).map((f) => f.kind);
  if (kinds.some((kind) => kind.includes("大津波警報"))) return "critical";
  if (kinds.some((kind) => kind.includes("津波警報"))) return "warning";
  return "normal";
}

/** 津波電文のバナーラベルを forecast の kind から決定する */
function tsunamiBannerLabel(info: ParsedTsunamiInfo): string {
  // 取消や forecast がない場合は電文タイプラベルをそのまま使う
  if (info.infoType === "取消" || !info.forecast || info.forecast.length === 0) {
    return typeLabel(info.type);
  }

  const kinds = info.forecast.map((f) => f.kind);
  const hasMajor = kinds.some((k) => k.includes("大津波警報"));
  const hasWarning = kinds.some((k) => k.includes("津波警報") && !k.includes("大津波警報"));
  const hasAdvisory = kinds.some((k) => k.includes("津波注意報"));
  const hasForecast = kinds.some((k) => k.includes("津波予報"));

  const parts: string[] = [];
  if (hasMajor) parts.push("大津波警報");
  if (hasWarning) parts.push("津波警報");
  if (hasAdvisory) parts.push("津波注意報");
  if (hasForecast) parts.push("津波予報");

  return parts.length > 0 ? parts.join("・") : typeLabel(info.type);
}

/** 津波種別の表示順 */
function tsunamiKindRank(kind: string): number {
  if (kind.includes("大津波警報")) return 0;
  if (kind.includes("津波警報")) return 1;
  if (kind.includes("津波注意報")) return 2;
  if (kind.includes("津波予報")) return 3;
  return 99;
}

/** 時刻文字列なら整形し、そうでなければそのまま返す */
function prettyTimeOrText(value: string): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    return value;
  }
  return formatTimestamp(value);
}

// ── 南海トラフ・長周期ヘルパー ──

/** 南海トラフ関連情報のフレームレベルを決定 */
function nankaiTroughFrameLevel(info: ParsedNankaiTroughInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (!info.infoSerial) {
    // VYSE60 (InfoSerial なし) → warning
    return "warning";
  }
  const code = info.infoSerial.code;
  if (code === "120") return "critical";    // 巨大地震警戒
  if (code === "130") return "warning";     // 巨大地震注意
  if (code === "111" || code === "112" || code === "113") return "warning"; // 調査中
  if (code === "210" || code === "219") return "warning"; // 臨時解説
  if (code === "190" || code === "200") return "info";    // 調査終了 / 定例解説
  return "warning";
}

/** 長周期地震動観測情報のフレームレベルを決定 */
function lgObservationFrameLevel(info: ParsedLgObservationInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (info.maxLgInt) {
    const num = lgIntToNumeric(info.maxLgInt);
    if (num >= 4) return "critical";
    if (num >= 3) return "warning";
    if (num >= 2) return "normal";
  }
  return "info";
}

// ══════════════════════════════════════════════
// 表示関数
// ══════════════════════════════════════════════

/** 地震情報を整形して表示 */
export function displayEarthquakeInfo(info: ParsedEarthquakeInfo): void {
  const level = earthquakeFrameLevel(info);
  const label = typeLabel(info.type);
  const width = getFrameWidth();

  // コンパクトモード: 1行サマリー
  if (getDisplayMode() === "compact") {
    const parts: string[] = [];
    parts.push(SEVERITY_LABELS[level]);
    parts.push(label);
    if (info.earthquake) {
      parts.push(info.earthquake.hypocenterName);
      parts.push(`M${info.earthquake.magnitude}`);
    }
    if (info.intensity) parts.push(`震度${info.intensity.maxInt}`);
    const ts = tsunamiShort(info);
    if (ts) parts.push(stripAnsi(ts));
    const color = frameColor(level);
    console.log(color(parts.join("  ")));
    return;
  }

  const buf = createRenderBuffer();

  buf.pushEmpty();
  buf.push(frameTop(level, width));

  // テスト電文
  if (info.isTest) {
    buf.push(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  // タイトル行 (severity ラベル付き)
  const titleContent = chalk.bold(`${label}`) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLine(level, titleContent, width));

  // ヘッドライン
  if (info.headline) {
    buf.push(frameDivider(level, width));
    const headlineWrapped = wrapFrameLines(level, chalk.bold.white(info.headline), width);
    for (let i = 0; i < headlineWrapped.length; i++) {
      if (i === 0) {
        buf.pushHeadline(headlineWrapped[i]);
      } else {
        buf.push(headlineWrapped[i]);
      }
    }
  }

  // カード1行目: 最重要項目
  const cardParts: string[] = [];
  if (info.intensity) {
    const ic = intensityColor(info.intensity.maxInt);
    cardParts.push(chalk.white("最大震度 ") + ic.bold(info.intensity.maxInt));
  }
  if (info.intensity?.maxLgInt && lgIntToNumeric(info.intensity.maxLgInt) >= 1) {
    const lc = lgIntensityColor(info.intensity.maxLgInt);
    cardParts.push(chalk.white("長周期階級 ") + lc.bold(info.intensity.maxLgInt));
  }
  if (info.earthquake?.magnitude) {
    cardParts.push(colorMagnitude(info.earthquake.magnitude));
  }
  if (info.earthquake?.depth) {
    cardParts.push(chalk.white("深さ ") + chalk.white(info.earthquake.depth));
  }
  const tsunamiText = tsunamiShort(info);
  if (tsunamiText) {
    cardParts.push(tsunamiText);
  }
  if (cardParts.length > 0) {
    buf.push(frameDivider(level, width));
    buf.pushCard(frameLine(level, cardParts.join(chalk.gray("  │  ")), width));
  }

  // 震源詳細
  if (info.earthquake) {
    const eq = info.earthquake;
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, chalk.white("震源地: ") + theme.getRoleChalk("hypocenter")(eq.hypocenterName), width));
    if (eq.originTime) {
      buf.push(frameLine(level, chalk.white("発生: ") + chalk.white(formatTimestamp(eq.originTime)), width));
    }
    if (eq.latitude && eq.longitude) {
      buf.push(frameLine(level, chalk.white("位置: ") + chalk.white(`${eq.latitude} ${eq.longitude}`), width));
    }
  } else if (info.type === "VXSE51") {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, chalk.yellow("※ 震源についてはただいま調査中です"), width));
  }

  // 震度一覧
  if (info.intensity && info.intensity.areas.length > 0) {
    buf.push(frameDivider(level, width));

    // 震度×地域名 → エリアデータの Map を事前構築 (O(n) ルックアップ用)
    const areaDataMap = new Map<string, typeof info.intensity.areas[0]>();
    const byIntensity = new Map<string, string[]>();
    for (const area of info.intensity.areas) {
      const key = area.intensity;
      if (!byIntensity.has(key)) byIntensity.set(key, []);
      byIntensity.get(key)!.push(area.name);
      areaDataMap.set(`${key}:${area.name}`, area);
    }

    const order = ["7", "6+", "6強", "6-", "6弱", "5+", "5強", "5-", "5弱", "4", "3", "2", "1"];
    const sorted = [...byIntensity.entries()].sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    // 折りたたみ: 表示地点数を制限
    let totalAreas = 0;
    let hiddenAreas = 0;
    const maxObs = getMaxObservations();

    for (const [int, names] of sorted) {
      // 折りたたみ判定
      let displayNames = names;
      if (maxObs != null) {
        const remaining = maxObs - totalAreas;
        if (remaining <= 0) {
          hiddenAreas += names.length;
          continue;
        }
        if (names.length > remaining) {
          hiddenAreas += names.length - remaining;
          displayNames = names.slice(0, remaining);
        }
        totalAreas += displayNames.length;
      }

      const color = intensityColor(int);
      // 長周期地震動階級付きの地域名を生成
      const areaTexts = displayNames.map((name) => {
        const areaData = areaDataMap.get(`${int}:${name}`);
        if (areaData?.lgIntensity && lgIntToNumeric(areaData.lgIntensity) >= 1) {
          const lc = lgIntensityColor(areaData.lgIntensity);
          return chalk.white(name) + lc(` [長周期${areaData.lgIntensity}]`);
        }
        return chalk.white(name);
      });
      const prefix = color(`震度${int}: `);
      const indentWidth = visualWidth(stripAnsi(prefix));
      const content = prefix + areaTexts.join(chalk.white(", "));
      for (const line of wrapFrameLines(level, content, width, indentWidth)) {
        buf.push(line);
      }
    }

    if (hiddenAreas > 0) {
      buf.push(frameLine(level, chalk.gray(`... 他 ${hiddenAreas} 地点`), width));
    }
  }

  // 津波 (詳細)
  if (info.tsunami) {
    buf.push(frameDivider(level, width));
    for (const wl of wrapFrameLines(level, chalk.white(`${info.tsunami.text}`), width)) {
      buf.push(wl);
    }
  }

  // フッター
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf);

  buf.push(frameBottom(level, width));
  buf.pushEmpty();

  flushWithRecap(buf, level, width);
}

/** 津波情報を整形して表示 */
export function displayTsunamiInfo(info: ParsedTsunamiInfo): void {
  const level = tsunamiFrameLevel(info);
  const label = typeLabel(info.type);
  const bannerLabel = tsunamiBannerLabel(info);
  const width = getFrameWidth();

  // コンパクトモード
  if (getDisplayMode() === "compact") {
    const parts: string[] = [];
    parts.push(SEVERITY_LABELS[level]);
    parts.push(bannerLabel);
    if (info.forecast && info.forecast.length > 0) {
      const areas = info.forecast.slice(0, getTruncation().tsunamiCompactForecastAreas).map((f) => f.areaName);
      parts.push(areas.join(", "));
    }
    const color = frameColor(level);
    console.log(color(parts.join("  ")));
    return;
  }

  const buf = createRenderBuffer();

  buf.pushEmpty();

  // バナー表示 (津波注意報/津波警報/大津波警報)
  if (level === "critical") {
    const bannerText = ` ${bannerLabel}`;
    const decorStyle = theme.getRoleChalk("tsunamiMajorBannerDecor");
    const majorStyle = theme.getRoleChalk("tsunamiMajorBanner");
    buf.push(decorStyle(" ".repeat(width)));
    buf.push(majorStyle(visualPadEnd(bannerText, width)));
    buf.push(decorStyle(" ".repeat(width)));
  } else if (level === "warning") {
    const bannerText = ` ${bannerLabel}`;
    const warnStyle = theme.getRoleChalk("tsunamiWarningBanner");
    buf.push(warnStyle(" ".repeat(width)));
    buf.push(warnStyle(visualPadEnd(bannerText, width)));
    buf.push(warnStyle(" ".repeat(width)));
  } else if (level === "normal") {
    const bannerText = ` ${bannerLabel}`;
    const advStyle = theme.getRoleChalk("tsunamiAdvisoryBanner");
    buf.push(advStyle(" ".repeat(width)));
    buf.push(advStyle(visualPadEnd(bannerText, width)));
    buf.push(advStyle(" ".repeat(width)));
  }

  buf.push(frameTop(level, width));

  if (info.isTest) {
    buf.push(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  const titleContent = chalk.bold(`${label}`) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLine(level, titleContent, width));

  if (info.headline) {
    buf.push(frameDivider(level, width));
    const headlineLines = info.headline
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);
    let firstHeadline = true;
    for (const hl of headlineLines) {
      for (const wrapped of wrapFrameLines(level, chalk.bold.white(hl), width)) {
        if (firstHeadline) {
          buf.pushHeadline(wrapped);
          firstHeadline = false;
        } else {
          buf.push(wrapped);
        }
      }
    }
  }

  if (info.earthquake) {
    const eq = info.earthquake;
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, chalk.white("震源地: ") + theme.getRoleChalk("hypocenter")(eq.hypocenterName), width));
    if (eq.originTime) {
      buf.push(frameLine(level, chalk.white("発生: ") + chalk.white(formatTimestamp(eq.originTime)), width));
    }
    if (eq.latitude && eq.longitude) {
      buf.push(frameLine(level, chalk.white("位置: ") + chalk.white(`${eq.latitude} ${eq.longitude}`), width));
    }
    if (eq.magnitude && !isNaN(parseFloat(eq.magnitude))) {
      buf.push(frameLine(level, chalk.white("規模: ") + colorMagnitude(eq.magnitude), width));
    }
  }

  if (info.forecast && info.forecast.length > 0) {
    buf.push(frameDivider(level, width));
    const sorted = [...info.forecast].sort(
      (a, b) => tsunamiKindRank(a.kind) - tsunamiKindRank(b.kind)
    );

    // 折りたたみ
    const maxObs = getMaxObservations();
    const displaySorted = maxObs != null ? sorted.slice(0, maxObs) : sorted;
    const hiddenForecast = sorted.length - displaySorted.length;

    if (width >= WIDE_TABLE_THRESHOLD) {
      const headers = ["区分", "地域名", "波高", "到達予想"];
      const rows = displaySorted.map((item) => {
        let kindText = chalk.white(item.kind);
        if (item.kind.includes("大津波警報")) {
          kindText = theme.getRoleChalk("tsunamiMajor")(item.kind);
        } else if (item.kind.includes("津波警報")) {
          kindText = theme.getRoleChalk("tsunamiWarning")(item.kind);
        } else if (item.kind.includes("津波注意報")) {
          kindText = theme.getRoleChalk("tsunamiAdvisory")(item.kind);
        }
        return [
          kindText,
          chalk.white(item.areaName),
          item.maxHeightDescription ? chalk.white(item.maxHeightDescription) : chalk.gray("―"),
          item.firstHeight ? chalk.white(prettyTimeOrText(item.firstHeight)) : chalk.gray("―"),
        ];
      });
      renderFrameTable(level, headers, rows, width, buf);
    } else {
      for (const item of displaySorted) {
        let kindText = chalk.white(item.kind);
        if (item.kind.includes("大津波警報")) {
          kindText = theme.getRoleChalk("tsunamiMajor")(item.kind);
        } else if (item.kind.includes("津波警報")) {
          kindText = theme.getRoleChalk("tsunamiWarning")(item.kind);
        } else if (item.kind.includes("津波注意報")) {
          kindText = theme.getRoleChalk("tsunamiAdvisory")(item.kind);
        }

        const extra: string[] = [];
        if (item.maxHeightDescription) extra.push(item.maxHeightDescription);
        if (item.firstHeight) extra.push(prettyTimeOrText(item.firstHeight));
        const extraText = extra.length > 0 ? chalk.gray(` (${extra.join(" / ")})`) : "";
        for (const wl of wrapFrameLines(level, kindText + chalk.white(` ${item.areaName}`) + extraText, width)) {
          buf.push(wl);
        }
      }
    }

    if (hiddenForecast > 0) {
      buf.push(frameLine(level, chalk.gray(`... 他 ${hiddenForecast} 地点`), width));
    }
  }

  if (info.observations && info.observations.length > 0) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, chalk.bold.white("沖合観測"), width));

    const maxObs = getMaxObservations();
    const displayObs = maxObs != null ? info.observations.slice(0, maxObs) : info.observations;
    const hiddenObs = info.observations.length - displayObs.length;

    if (width >= WIDE_TABLE_THRESHOLD) {
      const headers = ["観測点", "センサー", "初動", "最大波高", "到達時刻"];
      const rows = displayObs.map((station) => [
        chalk.white(station.name),
        station.sensor ? chalk.white(station.sensor) : chalk.gray("―"),
        station.initial ? chalk.white(station.initial) : chalk.gray("―"),
        station.maxHeightCondition ? chalk.white(station.maxHeightCondition) : chalk.gray("―"),
        station.arrivalTime ? chalk.white(prettyTimeOrText(station.arrivalTime)) : chalk.gray("―"),
      ]);
      renderFrameTable(level, headers, rows, width, buf);
    } else {
      for (const station of displayObs) {
        const parts = [
          station.name,
          station.sensor,
          station.initial,
          station.maxHeightCondition,
        ].filter((v) => Boolean(v));
        const arrival = station.arrivalTime ? ` ${prettyTimeOrText(station.arrivalTime)}` : "";
        buf.push(frameLine(level, chalk.white(parts.join(" / ") + arrival), width));
      }
    }

    if (hiddenObs > 0) {
      buf.push(frameLine(level, chalk.gray(`... 他 ${hiddenObs} 地点`), width));
    }
  }

  if (info.estimations && info.estimations.length > 0) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, chalk.bold.white("沿岸推定"), width));

    const maxObs = getMaxObservations();
    const displayEst = maxObs != null ? info.estimations.slice(0, maxObs) : info.estimations;
    const hiddenEst = info.estimations.length - displayEst.length;

    if (width >= WIDE_TABLE_THRESHOLD) {
      const headers = ["地域名", "波高", "到達予想"];
      const rows = displayEst.map((estimation) => [
        chalk.white(estimation.areaName),
        estimation.maxHeightDescription ? chalk.white(estimation.maxHeightDescription) : chalk.gray("―"),
        estimation.firstHeight ? chalk.white(prettyTimeOrText(estimation.firstHeight)) : chalk.gray("―"),
      ]);
      renderFrameTable(level, headers, rows, width, buf);
    } else {
      for (const estimation of displayEst) {
        const extra: string[] = [];
        if (estimation.maxHeightDescription) extra.push(estimation.maxHeightDescription);
        if (estimation.firstHeight) extra.push(prettyTimeOrText(estimation.firstHeight));
        buf.push(
          frameLine(
            level,
            chalk.white(`${estimation.areaName}${extra.length ? ` (${extra.join(" / ")})` : ""}`),
            width
          )
        );
      }
    }

    if (hiddenEst > 0) {
      buf.push(frameLine(level, chalk.gray(`... 他 ${hiddenEst} 地点`), width));
    }
  }

  if (info.warningComment) {
    buf.push(frameDivider(level, width));
    const warnStyle = theme.getRoleChalk("warningComment");
    const commentLines = info.warningComment
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);
    for (const line of commentLines) {
      for (const wrapped of wrapFrameLines(level, warnStyle(line), width)) {
        buf.push(wrapped);
      }
    }
  }

  // フッター
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf);

  buf.push(frameBottom(level, width));
  buf.pushEmpty();

  flushWithRecap(buf, level, width);
}

/** 地震活動テキスト情報を整形して表示 */
export function displaySeismicTextInfo(info: ParsedSeismicTextInfo): void {
  const level: FrameLevel = info.infoType === "取消" ? "cancel" : "info";
  const label = typeLabel(info.type);
  const width = getFrameWidth();

  // コンパクトモード
  if (getDisplayMode() === "compact") {
    const parts: string[] = [];
    parts.push(SEVERITY_LABELS[level]);
    parts.push(label);
    if (info.headline) parts.push(info.headline.slice(0, 40));
    const color = frameColor(level);
    console.log(color(parts.join("  ")));
    return;
  }

  const buf = createRenderBuffer();

  buf.pushEmpty();
  buf.push(frameTop(level, width));

  if (info.isTest) {
    buf.push(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  const titleContent = chalk.bold(`${label}`) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLine(level, titleContent, width));

  if (info.headline) {
    buf.push(frameDivider(level, width));
    const headlineWrapped = wrapFrameLines(level, chalk.bold.white(info.headline), width);
    for (let i = 0; i < headlineWrapped.length; i++) {
      if (i === 0) {
        buf.pushHeadline(headlineWrapped[i]);
      } else {
        buf.push(headlineWrapped[i]);
      }
    }
  }

  const bodyLines = info.bodyText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (bodyLines.length > 0) {
    buf.push(frameDivider(level, width));
    const showFull = getInfoFullText();
    const maxLines = getTruncation().seismicTextLines;
    const innerWidth = width - 4;
    const rules = getSeismicTextRules(info.type);
    const displayLines = showFull ? bodyLines : bodyLines.slice(0, maxLines);
    for (const line of displayLines) {
      for (const highlighted of highlightAndWrap(line, rules, innerWidth)) {
        buf.push(frameLine(level, highlighted, width));
      }
    }
    if (!showFull && bodyLines.length > maxLines) {
      buf.push(frameLine(level, chalk.gray(`... (全${bodyLines.length}行)`), width));
    }
  }

  // フッター
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf);

  buf.push(frameBottom(level, width));
  buf.pushEmpty();

  flushWithRecap(buf, level, width);
}

/** 南海トラフ関連情報を整形して表示 */
export function displayNankaiTroughInfo(info: ParsedNankaiTroughInfo): void {
  const level = nankaiTroughFrameLevel(info);
  const label = typeLabel(info.type);
  const width = getFrameWidth();

  // コンパクトモード
  if (getDisplayMode() === "compact") {
    const parts: string[] = [];
    parts.push(SEVERITY_LABELS[level]);
    parts.push(label);
    if (info.infoSerial) parts.push(info.infoSerial.name);
    const color = frameColor(level);
    console.log(color(parts.join("  ")));
    return;
  }

  const buf = createRenderBuffer();

  buf.pushEmpty();

  // critical/warning 時はバナー表示
  if (level === "critical") {
    const bannerText = ` ${info.title}`;
    const critBanner = theme.getRoleChalk("nankaiCriticalBanner");
    buf.push(critBanner(" ".repeat(width)));
    buf.push(critBanner(visualPadEnd(bannerText, width)));
    buf.push(critBanner(" ".repeat(width)));
  } else if (level === "warning") {
    const bannerText = ` ${info.title}`;
    const warnBanner = theme.getRoleChalk("nankaiWarningBanner");
    buf.push(warnBanner(" ".repeat(width)));
    buf.push(warnBanner(visualPadEnd(bannerText, width)));
    buf.push(warnBanner(" ".repeat(width)));
  }

  buf.push(frameTop(level, width));

  // テスト電文
  if (info.isTest) {
    buf.push(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  // タイトル行
  const titleContent = chalk.bold(`${label}`) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLine(level, titleContent, width));

  // InfoSerial (状態名)
  if (info.infoSerial) {
    buf.push(frameDivider(level, width));
    const serialColor = level === "critical" ? theme.getRoleChalk("nankaiSerialCritical") : theme.getRoleChalk("nankaiSerialWarning");
    buf.push(frameLine(level, chalk.white("状態: ") + serialColor(info.infoSerial.name), width));
  }

  // 本文
  const bodyLines = info.bodyText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (bodyLines.length > 0) {
    buf.push(frameDivider(level, width));
    const showFull = getInfoFullText();
    const maxLines = getTruncation().nankaiTroughLines;
    const innerWidth = width - 4;
    const rules = getNankaiRules(info.type);
    const displayLines = showFull ? bodyLines : bodyLines.slice(0, maxLines);
    for (const line of displayLines) {
      for (const highlighted of highlightAndWrap(line, rules, innerWidth)) {
        buf.push(frameLine(level, highlighted, width));
      }
    }
    if (!showFull && bodyLines.length > maxLines) {
      buf.push(frameLine(level, chalk.gray(`... (全${bodyLines.length}行)`), width));
    }
  }

  // 次回情報予告
  if (info.nextAdvisory) {
    buf.push(frameDivider(level, width));
    for (const line of wrapFrameLines(level, theme.getRoleChalk("nextAdvisory")(info.nextAdvisory), width)) {
      buf.push(line);
    }
  }

  // フッター
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf);

  buf.push(frameBottom(level, width));
  buf.pushEmpty();

  flushWithRecap(buf, level, width);
}

/** 長周期地震動観測情報を整形して表示 */
export function displayLgObservationInfo(info: ParsedLgObservationInfo): void {
  const level = lgObservationFrameLevel(info);
  const label = typeLabel(info.type);
  const width = getFrameWidth();

  // コンパクトモード
  if (getDisplayMode() === "compact") {
    const parts: string[] = [];
    parts.push(SEVERITY_LABELS[level]);
    parts.push(label);
    if (info.earthquake) parts.push(info.earthquake.hypocenterName);
    if (info.maxLgInt) parts.push(`長周期${info.maxLgInt}`);
    if (info.maxInt) parts.push(`震度${info.maxInt}`);
    const color = frameColor(level);
    console.log(color(parts.join("  ")));
    return;
  }

  const buf = createRenderBuffer();

  buf.pushEmpty();
  buf.push(frameTop(level, width));

  // テスト電文
  if (info.isTest) {
    buf.push(frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
  }

  // タイトル行
  const titleContent = chalk.bold(`${label}`) + chalk.gray(`  ${info.infoType}`) + chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLine(level, titleContent, width));

  // ヘッドライン
  if (info.headline) {
    buf.push(frameDivider(level, width));
    const headlineWrapped = wrapFrameLines(level, chalk.bold.white(info.headline), width);
    for (let i = 0; i < headlineWrapped.length; i++) {
      if (i === 0) {
        buf.pushHeadline(headlineWrapped[i]);
      } else {
        buf.push(headlineWrapped[i]);
      }
    }
  }

  // カード: 長周期階級 / 震度 / M / 深さ
  buf.push(frameDivider(level, width));
  const cardParts: string[] = [];
  if (info.maxLgInt) {
    const lc = lgIntensityColor(info.maxLgInt);
    cardParts.push(chalk.white("長周期階級 ") + lc.bold(info.maxLgInt));
  }
  if (info.maxInt) {
    const ic = intensityColor(info.maxInt);
    cardParts.push(chalk.white("最大震度 ") + ic.bold(info.maxInt));
  }
  if (info.earthquake?.magnitude) {
    cardParts.push(colorMagnitude(info.earthquake.magnitude));
  }
  if (info.earthquake?.depth) {
    cardParts.push(chalk.white("深さ ") + chalk.white(info.earthquake.depth));
  }
  if (cardParts.length > 0) {
    buf.pushCard(frameLine(level, cardParts.join(chalk.gray("  │  ")), width));
  }

  // 震源詳細
  if (info.earthquake) {
    const eq = info.earthquake;
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, chalk.white("震源地: ") + theme.getRoleChalk("hypocenter")(eq.hypocenterName), width));
    if (eq.originTime) {
      buf.push(frameLine(level, chalk.white("発生: ") + chalk.white(formatTimestamp(eq.originTime)), width));
    }
    if (eq.latitude && eq.longitude) {
      buf.push(frameLine(level, chalk.white("位置: ") + chalk.white(`${eq.latitude} ${eq.longitude}`), width));
    }
  }

  // 地域リスト (LgInt 降順)
  if (info.areas.length > 0) {
    buf.push(frameDivider(level, width));
    const sorted = [...info.areas].sort((a, b) =>
      lgIntToNumeric(b.maxLgInt) - lgIntToNumeric(a.maxLgInt)
    );

    // 折りたたみ
    const maxObs = getMaxObservations();
    const displayAreas = maxObs != null ? sorted.slice(0, maxObs) : sorted;
    const hiddenCount = sorted.length - displayAreas.length;

    for (const area of displayAreas) {
      const lc = lgIntensityColor(area.maxLgInt);
      const ic = intensityColor(area.maxInt);
      buf.push(frameLine(level,
        lc(`長周期${area.maxLgInt}: `) +
        chalk.white(area.name) +
        ic(` (震度${area.maxInt})`),
        width
      ));
    }

    if (hiddenCount > 0) {
      buf.push(frameLine(level, chalk.gray(`... 他 ${hiddenCount} 地点`), width));
    }
  }

  // コメント
  if (info.comment) {
    buf.push(frameDivider(level, width));
    const commentLines = info.comment.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of commentLines) {
      const wrapped = wrapFrameLines(level, chalk.gray(line.trimEnd()), width);
      for (const wl of wrapped) {
        buf.push(wl);
      }
    }
  }

  // 詳細URI
  if (info.detailUri) {
    buf.push(frameDivider(level, width));
    const uriWrapped = wrapFrameLines(level, theme.getRoleChalk("detailUri")(info.detailUri), width);
    for (const wl of uriWrapped) {
      buf.push(wl);
    }
  }

  // フッター
  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf);

  buf.push(frameBottom(level, width));
  buf.pushEmpty();

  flushWithRecap(buf, level, width);
}
