import {
  ParsedTsunamiInfo,
  PromptStatusProvider,
  PromptStatusSegment,
  PromptStatusRole,
  DetailProvider,
  DetailSnapshotOf,
} from "../../types";
import {
  resolveTsunamiLevel,
  type TsunamiLevelLabel,
} from "../../utils/tsunami-kind";

/** レベルに対応するテーマロール */
const LEVEL_ROLE: Record<TsunamiLevelLabel, PromptStatusRole> = {
  "大津波警報": "tsunamiMajor",
  "津波警報": "tsunamiWarning",
  "津波注意報": "tsunamiAdvisory",
};

/** 既存の display runtime 向け互換 API。判定本体は resolveTsunamiLevel に集約する。 */
export function detectTsunamiAlertLevel(
  kinds: string[],
): TsunamiLevelLabel | null {
  return resolveTsunamiLevel(kinds)?.label ?? null;
}

export type TsunamiStateUpdateResult =
  | { kind: "updated" }
  | { kind: "suppressed" };

/**
 * 津波情報の状態を保持し、プロンプト表示と detail コマンドを提供する。
 */
export class TsunamiStateHolder
  implements PromptStatusProvider, DetailProvider<"tsunami">
{
  readonly category = "tsunami";
  readonly emptyMessage = "現在、継続中の津波情報はありません。";

  private currentLevel: TsunamiLevelLabel | null = null;
  private lastInfo: ParsedTsunamiInfo | null = null;
  private reportTimeWatermark: number | null = null;

  /** 現在の警報レベルを返す (テスト用) */
  getLevel(): TsunamiLevelLabel | null {
    return this.currentLevel;
  }

  /** 表示ディスプレイ用: 最後に受信した津波情報 (発表中でなければ null) */
  getLastInfo(): ParsedTsunamiInfo | null {
    return this.lastInfo;
  }

  /** VTSE41 受信時に状態を更新する。古い報・重複報は更新せず suppressed を返す。 */
  update(info: ParsedTsunamiInfo): TsunamiStateUpdateResult {
    const reportTime = Date.parse(info.reportDateTime);
    if (
      !Number.isFinite(reportTime) ||
      (this.reportTimeWatermark != null && reportTime <= this.reportTimeWatermark)
    ) {
      return { kind: "suppressed" };
    }

    // 表示状態を消した後も、古い報の復活を防ぐ tombstone として時刻を保持する。
    this.reportTimeWatermark = reportTime;

    // 取消報 → アクティブ状態のみクリア
    if (info.infoType === "取消") {
      this.clearActiveState();
      return { kind: "updated" };
    }

    // forecast から警報レベルを検出
    const kinds = (info.forecast ?? []).map((f) => f.kind);
    const level = resolveTsunamiLevel(kinds)?.label ?? null;

    if (level == null) {
      // 警報レベルなし (津波予報のみ等) → アクティブ状態のみクリア
      this.clearActiveState();
      return { kind: "updated" };
    }

    this.currentLevel = level;
    this.lastInfo = info;
    return { kind: "updated" };
  }

  /** holder 全体を明示的にリセットする。 */
  clear(): void {
    this.clearActiveState();
    this.reportTimeWatermark = null;
  }

  private clearActiveState(): void {
    this.currentLevel = null;
    this.lastInfo = null;
  }

  // ── PromptStatusProvider ──

  getPromptStatus(): PromptStatusSegment | null {
    if (this.currentLevel == null) return null;

    const role = LEVEL_ROLE[this.currentLevel];
    return {
      text: this.currentLevel,
      role,
      priority: 10,
    };
  }

  // ── DetailProvider ──

  getDetail(): DetailSnapshotOf<"tsunami"> | null {
    if (this.lastInfo == null) return null;
    return { kind: "tsunami", info: this.lastInfo };
  }

}
