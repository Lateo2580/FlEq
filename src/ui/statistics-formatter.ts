import {
  frameTop,
  frameBottom,
  frameLine,
  frameDivider,
  visualWidth,
  intensityColor,
} from "./formatter";
import type { FrameLevel } from "./formatter";
import * as theme from "./theme";
import type { RoleName } from "./theme";
import type { StatsSnapshot, StatsCategory } from "../engine/messages/telegram-stats";

// ── 定数 ──

const TYPE_LABELS: Record<string, string> = {
  VXSE43: "緊急地震速報(警報)",
  VXSE44: "緊急地震速報(予報)",
  VXSE45: "緊急地震速報(地震動予報)",
  VXSE51: "震度速報",
  VXSE52: "震源に関する情報",
  VXSE53: "震源・震度に関する情報",
  VXSE56: "地震の活動状況等に関する情報",
  VXSE60: "地震解説",
  VXSE61: "顕著な地震の震度速報",
  VXSE62: "長周期地震動に関する観測情報",
  VZSE40: "地震回数に関する情報",
  VTSE41: "津波警報・注意報・予報",
  VTSE51: "津波情報",
  VTSE52: "沖合の津波観測に関する情報",
  VYSE50: "南海トラフ地震臨時情報",
  VYSE51: "南海トラフ地震関連解説情報(臨時)",
  VYSE52: "南海トラフ地震関連解説情報(定例)",
  VYSE60: "南海トラフ地震関連解説情報(経過)",
  VFVO50: "噴火警報・予報",
  VFVO51: "火山の状況に関する解説情報",
  VFVO52: "噴火に関する火山観測報",
  VFVO53: "降灰予報(定時)",
  VFVO54: "降灰予報(速報)",
  VFVO55: "降灰予報(詳細)",
  VFVO56: "噴火速報",
  VFVO60: "推定噴煙流向報",
  VFSVii: "火山現象に関する海上警報",
  VZVO40: "火山に関するお知らせ",
  VPWW55: "大雨警報・注意報",
  VPWW56: "土砂災害警戒情報",
  VPWW57: "高潮警報・注意報",
  VPWW58: "暴風・暴風雪警報・注意報",
  VPWW59: "波浪警報・注意報",
  VPWW60: "大雪警報・注意報",
  VPWW61: "その他気象警報・注意報",
  VPWS50: "気象警報・注意報(集約)",
  VPHW50: "竜巻注意情報",
  VPHW51: "竜巻注意情報(目撃情報付き)",
  VPBS50: "気象防災速報",
  VPAW51: "早期天候情報",
  VPWP50: "気象警報・注意報時系列情報",
  VPZI50: "全般天候情報",
  VPCI50: "地方天候情報",
  VPCJ51: "地方気象解説情報",
  VPZJ51: "全般気象解説情報",
  VPFJ51: "府県気象解説情報",
  VMCJ53: "全般気象解説情報(潮位)",
  VMCJ54: "地方気象解説情報(潮位)",
  VMCJ55: "府県気象解説情報(潮位)",
  VPFT50: "熱中症警戒アラート",
  VPTW60: "台風解析(5日)",
  VPTW61: "台風実況",
  VPTW62: "台風発生予想",
};

const CATEGORY_LABELS: Record<StatsCategory, string> = {
  eew: "EEW",
  earthquake: "地震",
  tsunami: "津波",
  volcano: "火山",
  nankaiTrough: "南海トラフ",
  weather: "気象",
  tornado: "竜巻",
  briefing: "防災速報",
  earlyWeather: "早期天候",
  weatherWarningTimeseries: "気象時系列",
  climateInfo: "全般天候",
  weatherExplanation: "気象解説",
  heatAlert: "熱中症",
  typhoonAnalysis: "台風",
  typhoonProbability: "台風確率",
  floodForecast: "洪水予報",
  other: "その他",
};

const CATEGORY_ROLE: Record<StatsCategory, RoleName> = {
  eew: "statsCategoryEew",
  earthquake: "statsCategoryEarthquake",
  tsunami: "statsCategoryTsunami",
  volcano: "statsCategoryVolcano",
  nankaiTrough: "statsCategoryNankaiTrough",
  weather: "statsCategoryOther",
  tornado: "statsCategoryOther",
  briefing: "statsCategoryOther",
  earlyWeather: "statsCategoryOther",
  weatherWarningTimeseries: "statsCategoryOther",
  climateInfo: "statsCategoryOther",
  weatherExplanation: "statsCategoryOther",
  heatAlert: "statsCategoryOther",
  typhoonAnalysis: "statsCategoryOther",
  typhoonProbability: "statsCategoryOther",
  floodForecast: "statsCategoryOther",
  other: "statsCategoryOther",
};

const CATEGORY_ORDER: StatsCategory[] = [
  "eew",
  "earthquake",
  "tsunami",
  "volcano",
  "nankaiTrough",
  "weather",
  "tornado",
  "briefing",
  "earlyWeather",
  // [Codex R1 W4] Phase 4-B 積み残し: weatherWarningTimeseries が
  // CATEGORY_ORDER に追加されていなかったため、VPWP50 統計カテゴリが
  // 画面の集計表示から漏れていた。Phase 5 の climateInfo 追加と併せて修正。
  "weatherWarningTimeseries",
  "climateInfo",
  "weatherExplanation",
  "heatAlert",
  "typhoonAnalysis",
  "typhoonProbability",
  // [R1 前哨] weatherWarningTimeseries と同型の追加漏れ: floodForecast が
  // CATEGORY_ORDER に入っておらず洪水予報統計が集計表示から漏れていた。
  "floodForecast",
  "other",
];

const INTENSITY_ORDER = ["1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];

const FRAME_LEVEL: FrameLevel = "info";

// ── chalk ショートカット ──

function muted(s: string): string {
  return theme.getRoleChalk("statsMuted")(s);
}

function count(s: string): string {
  return theme.getRoleChalk("statsCount")(s);
}

// ── 公開関数 ──

/** 経過時間をミリ秒から日本語の文字列に変換する */
export function formatStatsDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / (60 * 1000));
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);

  if (totalDays >= 1) {
    const remainHours = totalHours - totalDays * 24;
    if (remainHours === 0) return `${totalDays}日`;
    return `${totalDays}日${remainHours}時間`;
  }
  if (totalHours >= 1) {
    const remainMinutes = totalMinutes - totalHours * 60;
    if (remainMinutes === 0) return `${totalHours}時間`;
    return `${totalHours}時間${remainMinutes}分`;
  }
  return `${totalMinutes}分`;
}

/** 電文受信統計をフレームボックス形式で標準出力に表示する */
export function displayStatistics(snapshot: StatsSnapshot, now?: Date): void {
  const effectiveNow = now ?? new Date();
  const elapsedMs = effectiveNow.getTime() - snapshot.startTime.getTime();

  if (snapshot.totalCount === 0) {
    const title = "統計";
    const msg = muted("まだ電文を受信していません");
    const width = calcWidth([title, msg]);
    console.log(frameTop(FRAME_LEVEL, width));
    console.log(frameLine(FRAME_LEVEL, title, width));
    console.log(frameLine(FRAME_LEVEL, msg, width));
    console.log(frameBottom(FRAME_LEVEL, width));
    return;
  }

  // カテゴリ別に headType を分類
  const typesByCategory = new Map<StatsCategory, string[]>();
  for (const [headType, category] of snapshot.categoryByType) {
    if (!typesByCategory.has(category)) {
      typesByCategory.set(category, []);
    }
    typesByCategory.get(category)!.push(headType);
  }

  // 表示するカテゴリ（件数 > 0 のもの）
  const activeCategories = CATEGORY_ORDER.filter((cat) =>
    (typesByCategory.get(cat)?.some((t) => (snapshot.countByType.get(t) ?? 0) > 0)) ?? false,
  );

  // 最大カウント値を取得してカウント列の幅を決定
  let maxCount = 0;
  for (const count of snapshot.countByType.values()) {
    if (count > maxCount) maxCount = count;
  }
  const countWidth = Math.max(4, String(maxCount).length);

  // 全コンテンツ行を収集してフレーム幅を動的計算
  const allContentLines = buildAllContentLines(
    snapshot,
    activeCategories,
    typesByCategory,
    elapsedMs,
    countWidth,
  );
  const width = calcWidth(["統計", ...allContentLines]);

  // 出力
  console.log(frameTop(FRAME_LEVEL, width));
  console.log(frameLine(FRAME_LEVEL, "統計", width));
  for (const line of allContentLines) {
    if (line === "__DIVIDER__") {
      console.log(frameDivider(FRAME_LEVEL, width));
    } else {
      console.log(frameLine(FRAME_LEVEL, line, width));
    }
  }
  console.log(frameBottom(FRAME_LEVEL, width));
}

// ── 内部ヘルパー ──

/** フレーム幅をコンテンツ行の最大幅から計算する (最小40、最大200) */
function calcWidth(contentLines: string[]): number {
  let maxContentWidth = 0;
  for (const line of contentLines) {
    if (line === "__DIVIDER__") continue;
    const w = visualWidth(line);
    if (w > maxContentWidth) maxContentWidth = w;
  }
  // frameLine adds 4 chars overhead (│ + space + space + │)
  return Math.max(40, Math.min(200, maxContentWidth + 4));
}

/** 最大震度内訳行を構築する（色付き） */
function buildIntBreakdownLine(earthquakeMaxIntByEvent: Map<string, string>): string {
  const intCounts = new Map<string, number>();
  for (const maxInt of earthquakeMaxIntByEvent.values()) {
    intCounts.set(maxInt, (intCounts.get(maxInt) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const intensity of INTENSITY_ORDER) {
    const cnt = intCounts.get(intensity);
    if (cnt != null && cnt > 0) {
      const intStyle = intensityColor(intensity);
      parts.push(`${intStyle(intensity)}${muted(":")}${cnt}`);
    }
  }
  return `  ${muted("最大震度内訳")}  ${parts.join("  ")}`;
}

/** 全コンテンツ行を構築する (__DIVIDER__ はフレーム区切り線のセンチネル) */
function buildAllContentLines(
  snapshot: StatsSnapshot,
  activeCategories: StatsCategory[],
  typesByCategory: Map<StatsCategory, string[]>,
  elapsedMs: number,
  countWidth: number,
): string[] {
  const lines: string[] = [];

  // ヘッダー行
  const startStr = snapshot.startTime.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  lines.push(
    `${muted("開始:")} ${startStr}  ${muted("経過:")} ${formatStatsDuration(elapsedMs)}  ${muted("合計:")} ${count(String(snapshot.totalCount))}件`,
  );

  // カテゴリセクション
  for (const category of activeCategories) {
    lines.push("__DIVIDER__");

    // カテゴリヘッダー
    const types = typesByCategory.get(category) ?? [];
    const categoryCount = types.reduce(
      (sum, t) => sum + (snapshot.countByType.get(t) ?? 0),
      0,
    );
    const catLabel = CATEGORY_LABELS[category];
    const catStyle = theme.getRoleChalk(CATEGORY_ROLE[category]);

    let catHeader: string;
    if (category === "eew") {
      catHeader = `${catStyle(`[${catLabel}]`)} ${count(String(categoryCount))}件 / ${count(String(snapshot.eewEventCount))}イベント`;
    } else {
      catHeader = `${catStyle(`[${catLabel}]`)} ${count(String(categoryCount))}件`;
    }
    lines.push(catHeader);

    // タイプ行
    // タイプ列の幅を揃えるため最長タイプ名を求める
    let maxTypeWidth = 0;
    for (const headType of types) {
      if (visualWidth(headType) > maxTypeWidth) maxTypeWidth = visualWidth(headType);
    }
    let maxLabelWidth = 0;
    for (const headType of types) {
      const label = TYPE_LABELS[headType] ?? headType;
      if (visualWidth(label) > maxLabelWidth) maxLabelWidth = visualWidth(label);
    }

    for (const headType of types) {
      const cnt = snapshot.countByType.get(headType) ?? 0;
      if (cnt === 0) continue;
      const label = TYPE_LABELS[headType] ?? headType;
      const typePad = " ".repeat(Math.max(0, maxTypeWidth - visualWidth(headType)));
      const labelPad = " ".repeat(Math.max(0, maxLabelWidth - visualWidth(label)));
      const countStr = String(cnt).padStart(countWidth);
      lines.push(`  ${muted(headType)}${typePad}  ${label}${labelPad}  ${muted(":")}  ${count(countStr)}`);
    }

    // 地震カテゴリの場合は最大震度内訳を追加
    if (category === "earthquake" && snapshot.earthquakeMaxIntByEvent.size > 0) {
      lines.push(buildIntBreakdownLine(snapshot.earthquakeMaxIntByEvent));
    }
  }

  return lines;
}
