import {
  frameTop,
  frameBottom,
  frameLine,
  frameDivider,
  visualWidth,
} from "./formatter";
import type { FrameLevel } from "./formatter";
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
};

const CATEGORY_LABELS: Record<StatsCategory, string> = {
  eew: "EEW",
  earthquake: "地震",
  tsunami: "津波",
  volcano: "火山",
  nankaiTrough: "南海トラフ",
  other: "その他",
};

const CATEGORY_ORDER: StatsCategory[] = [
  "eew",
  "earthquake",
  "tsunami",
  "volcano",
  "nankaiTrough",
  "other",
];

const INTENSITY_ORDER = ["1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];

const FRAME_LEVEL: FrameLevel = "info";

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
    const msg = "まだ電文を受信していません";
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

/** 最大震度内訳行を構築する */
function buildIntBreakdownLine(earthquakeMaxIntByEvent: Map<string, string>): string {
  const intCounts = new Map<string, number>();
  for (const maxInt of earthquakeMaxIntByEvent.values()) {
    intCounts.set(maxInt, (intCounts.get(maxInt) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const intensity of INTENSITY_ORDER) {
    const count = intCounts.get(intensity);
    if (count != null && count > 0) {
      parts.push(`${intensity}:${count}`);
    }
  }
  return `  最大震度内訳  ${parts.join("  ")}`;
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
  lines.push(`開始: ${startStr}  経過: ${formatStatsDuration(elapsedMs)}  合計: ${snapshot.totalCount}件`);

  // カテゴリセクション
  for (let i = 0; i < activeCategories.length; i++) {
    const category = activeCategories[i];
    lines.push("__DIVIDER__");

    // カテゴリヘッダー
    const types = typesByCategory.get(category) ?? [];
    const categoryCount = types.reduce(
      (sum, t) => sum + (snapshot.countByType.get(t) ?? 0),
      0,
    );
    const catLabel = CATEGORY_LABELS[category];
    let catHeader: string;
    if (category === "eew") {
      catHeader = `[${catLabel}] ${categoryCount}件 / ${snapshot.eewEventCount}イベント`;
    } else {
      catHeader = `[${catLabel}] ${categoryCount}件`;
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
      const count = snapshot.countByType.get(headType) ?? 0;
      if (count === 0) continue;
      const label = TYPE_LABELS[headType] ?? headType;
      const typePad = " ".repeat(Math.max(0, maxTypeWidth - visualWidth(headType)));
      const labelPad = " ".repeat(Math.max(0, maxLabelWidth - visualWidth(label)));
      const countStr = String(count).padStart(countWidth);
      lines.push(`  ${headType}${typePad}  ${label}${labelPad}  :  ${countStr}`);
    }

    // 地震カテゴリの場合は最大震度内訳を追加
    if (category === "earthquake" && snapshot.earthquakeMaxIntByEvent.size > 0) {
      lines.push(buildIntBreakdownLine(snapshot.earthquakeMaxIntByEvent));
    }
  }

  return lines;
}
