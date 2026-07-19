// VPWW55-61 状態列の表記 (発表/継続/解除 + family ベース昇降格 symbol)。
// spec: 設計メモ 2026-06-07-vpww-warning-phase-a.md (Phase A.5)
import type { WarningEntry } from "./weather-core-entry";
import {
  DISPLAY_SEVERITY_RANK,
  resolveDisplaySeverity,
  resolvePhenomenonFamily,
  type DisplaySeverity,
} from "../dmdata/weather-warning-level";

const SHORT_LABEL: Partial<Record<DisplaySeverity, string>> = {
  officialL5: "特", officialL4: "危", officialL3: "警", officialL2: "注", officialL1: "予",
  nonLevelSpecial: "特", nonLevelWarning: "警", nonLevelAdvisory: "注",
};

function shortOf(s: DisplaySeverity): string {
  return SHORT_LABEL[s] ?? "?";
}

/** entry の状態列文字列を返す。発表は family 内の前報との severity 比較で昇降格を判定。 */
export function formatTransitionStatus(e: WarningEntry): string {
  // Status=解除、または Code 00 等の解除 kind (displaySeverity=release) は解除表記に統一
  if (e.status === "解除" || e.displaySeverity === "release") return "▼解除";
  if (e.status !== "発表") return e.status; // 継続 等そのまま
  if (e.lastKindCode == null || e.lastKindName == null) return "発表 ▲新規";
  // 前報 Kind 自身の family で解決 (防御的; 正規データでは同一 Kind スロット=同 family)
  const lastFamily = resolvePhenomenonFamily(e.lastKindCode, e.lastKindName);
  const last = resolveDisplaySeverity(e.lastKindCode, e.lastKindName, lastFamily);
  const cur = DISPLAY_SEVERITY_RANK[e.displaySeverity];
  const prev = DISPLAY_SEVERITY_RANK[last.displaySeverity];
  if (cur > prev) return `▲ ${shortOf(last.displaySeverity)}→${shortOf(e.displaySeverity)}`;
  if (cur < prev) return `▽ ${shortOf(last.displaySeverity)}→${shortOf(e.displaySeverity)}`;
  return "発表 ▲新規";
}
