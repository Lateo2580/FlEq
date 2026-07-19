// display/frontend/src/lib/alert-roles.ts
// 意味重大度の判定表 (spec D5)。tickerPriority (high/mid/low) は走行優先度であって意味重大度では
// ない (気象通常警報は mid)。ここは色 role (DisplayColorRole) を意味の真実源として使い、
// 「平常系の閉集合以外はすべて警報級」の反転定義で未知 role を明るい側へ倒す (fail-bright)。
export const CALM_ROLES: ReadonlySet<string> = new Set([
  "normal",
  "info",
  "cancel",
  "muted",
  "connectionOk",
  "connectionStale",
  "eewForecast", // EEW 予報 (警報ではない)
  "tsunamiAdvisory", // 津波注意報
  "weatherAdvisory", // 気象注意報
]);

export function isAlertRole(role: string): boolean {
  return !CALM_ROLES.has(role);
}

// 網羅 manifest: DisplayColorRole の全 member を列挙する。member 追加時は下の型検査
// (_exhaustive) がコンパイルエラーになり、CALM/ALERT 分類と監査集合の更新を強制する
import type { DisplayColorRole } from "./protocol";
export const KNOWN_COLOR_ROLES = [
  "critical", "warning", "normal", "info", "cancel",
  "eewWarning", "eewForecast", "tsunamiMajor", "tsunamiWarning", "tsunamiAdvisory",
  "quakeMajor", "weatherEmergency", "weatherWarning", "weatherAdvisory",
  "connectionOk", "connectionStale", "muted",
] as const satisfies readonly DisplayColorRole[];
type MissingRole = Exclude<DisplayColorRole, (typeof KNOWN_COLOR_ROLES)[number]>;
const _exhaustive: MissingRole extends never ? true : MissingRole = true;
void _exhaustive;
