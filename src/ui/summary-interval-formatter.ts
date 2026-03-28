import chalk from "chalk";
import type { SummaryWindowSnapshot } from "../engine/messages/summary-tracker";

/** sparkline で使う8段階の文字 */
const SPARK_CHARS = "▁▂▃▄▅▆▇█";

/** ドメインの表示ラベル */
const DOMAIN_LABELS: Record<string, string> = {
  eew: "EEW",
  earthquake: "地震",
  tsunami: "津波",
  seismicText: "テキスト",
  lgObservation: "長周期",
  volcano: "火山",
  nankaiTrough: "南海トラフ",
  raw: "その他",
};

/**
 * sparklineData (数値配列) から sparkline 文字列を生成する。
 * 最大値に対する比率で8段階の文字を選択する。全部0なら ▁ の繰り返し。
 */
export function buildSparkline(data: number[]): string {
  const max = Math.max(...data);
  if (max === 0) {
    return SPARK_CHARS[0].repeat(data.length);
  }
  return data
    .map((v) => {
      const ratio = v / max;
      const idx = Math.min(Math.round(ratio * (SPARK_CHARS.length - 1)), SPARK_CHARS.length - 1);
      return SPARK_CHARS[idx];
    })
    .join("");
}

/**
 * 要約行をフォーマットする。
 * @param snapshot SummaryWindowTracker のスナップショット
 * @param intervalMinutes 要約間隔(分)
 * @param sparkline sparkline を含めるか
 */
export function formatSummaryInterval(
  snapshot: SummaryWindowSnapshot,
  intervalMinutes: number,
  sparkline: boolean,
): string {
  const parts: string[] = [];

  // ドメイン別件数
  const domainParts: string[] = [];
  for (const [domain, count] of Object.entries(snapshot.byDomain)) {
    if (count > 0) {
      const label = DOMAIN_LABELS[domain] ?? domain;
      domainParts.push(`${label} ${count}件`);
    }
  }

  // ヘッダ
  const header = chalk.gray(`── ${intervalMinutes}分要約 ──`);
  const domainStr = domainParts.length > 0
    ? domainParts.join(chalk.gray(" | "))
    : chalk.gray("受信なし");

  // maxInt
  const maxIntStr = snapshot.maxIntSeen != null
    ? chalk.gray(` (最大${snapshot.maxIntSeen})`)
    : "";

  parts.push(`${header} ${domainStr}${maxIntStr}`);

  // sparkline 行
  if (sparkline) {
    const sparkStr = buildSparkline(snapshot.sparklineData);
    parts.push(chalk.gray("受信 ") + sparkStr + chalk.gray("  (30分)"));
  }

  return parts.join("\n");
}
