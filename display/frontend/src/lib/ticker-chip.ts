import type { DisplayColorRole } from "./protocol";

export interface ChipTokens {
  /** チップ container 面 (CSS 値文字列)。インライン --chip-container に流す */
  container: string;
  /** on-container 文字色 */
  on: string;
}

/** --header-<key>-* を直接引く pair を作る */
function header(key: string): ChipTokens {
  return {
    container: `var(--header-${key}-container)`,
    on: `var(--header-${key}-on)`,
  };
}

/** --surface-high 中立面 + role 色を on に載せる pair */
function neutral(role: DisplayColorRole): ChipTokens {
  return {
    container: "var(--surface-high)",
    on: `var(--role-${role})`,
  };
}

/**
 * DisplayColorRole → チップの container/on トークン (Spec C §3-4)。
 * ヘッダ container token は 10 role 分しかないため、別名流用 (新色なし) と
 * 機械導出 (cancel) と中立フォールバックで 17 role を漏れなく埋める。
 * exhaustive switch で全 role を型強制する (default を置かない)。
 */
export function resolveChipTokens(role: DisplayColorRole): ChipTokens {
  switch (role) {
    // ── 直接 8: --header-<role>-* が存在する ──
    case "eewWarning":
    case "eewForecast":
    case "tsunamiMajor":
    case "tsunamiWarning":
    case "tsunamiAdvisory":
    case "weatherEmergency":
    case "weatherWarning":
    case "weatherAdvisory":
      return header(role);
    // ── 別名 3: 既存 token 流用 (新色なし) ──
    case "critical": // vermillion。quakeCritical と同トーン
    case "quakeMajor":
      return header("quakeCritical");
    case "warning": // orange。quakeWarning と同トーン
      return header("quakeWarning");
    // ── 機械導出 1: cancel (解除=状態変化シグナル) ──
    case "cancel":
      return {
        container: "color-mix(in srgb, var(--role-cancel) 20%, var(--surface-low))",
        on: "var(--role-cancel)",
      };
    // ── 中立 5: 低シグナル/中立の役割 ──
    case "normal":
    case "info":
    case "connectionStale":
    case "muted":
      return neutral(role);
    // connectionOk は `--role-connectionOk` (=`--fg-faint`) が接続ドット等の「沈んでいてよい」
    // 用途向けの意図的に暗いトークンで、チップ on 文字には暗すぎる (実測コントラスト比 2.842 <
    // 3.0、Task 7 自動測定で検出)。`--role-connectionOk` 自体や他 UI は変えず、チップ文脈限定で
    // info/muted と同じ `--c-gray` (実測 5.665) に lift する
    case "connectionOk":
      return {
        container: "var(--surface-high)",
        on: "var(--c-gray)",
      };
  }
}
