import {
  ParsedTsunamiInfo,
  PromptStatusProvider,
  PromptStatusSegment,
  DetailProvider,
} from "../types";
import { getRoleChalk, RoleName } from "../ui/theme";
import { displayTsunamiInfo } from "../ui/formatter";

/** 津波警報レベル (優先度順) */
type TsunamiAlertLevel = "大津波警報" | "津波警報" | "津波注意報";

/** レベルの優先度 (大きいほど深刻) */
const LEVEL_PRIORITY: Record<TsunamiAlertLevel, number> = {
  "大津波警報": 3,
  "津波警報": 2,
  "津波注意報": 1,
};

/** レベルに対応するテーマロール */
const LEVEL_ROLE: Record<TsunamiAlertLevel, RoleName> = {
  "大津波警報": "tsunamiMajor",
  "津波警報": "tsunamiWarning",
  "津波注意報": "tsunamiAdvisory",
};

/** 判定対象の kind 一覧 */
const ALERT_KINDS = new Set<string>(["大津波警報", "津波警報", "津波注意報"]);

/**
 * forecast の kind 一覧から最大警報レベルを判定する。
 * 津波予報 (0.2m 以下) や kind なしの場合は null を返す。
 */
export function detectTsunamiAlertLevel(
  kinds: string[]
): TsunamiAlertLevel | null {
  let maxLevel: TsunamiAlertLevel | null = null;
  let maxPriority = 0;

  for (const kind of kinds) {
    if (ALERT_KINDS.has(kind)) {
      const level = kind as TsunamiAlertLevel;
      const priority = LEVEL_PRIORITY[level];
      if (priority > maxPriority) {
        maxPriority = priority;
        maxLevel = level;
      }
    }
  }

  return maxLevel;
}

/**
 * 津波情報の状態を保持し、プロンプト表示と detail コマンドを提供する。
 */
export class TsunamiStateHolder
  implements PromptStatusProvider, DetailProvider
{
  readonly category = "tsunami";
  readonly emptyMessage = "現在、継続中の津波情報はありません。";

  private currentLevel: TsunamiAlertLevel | null = null;
  private lastInfo: ParsedTsunamiInfo | null = null;

  /** 現在の警報レベルを返す (テスト用) */
  getLevel(): TsunamiAlertLevel | null {
    return this.currentLevel;
  }

  /** VTSE41 受信時に状態を更新する */
  update(info: ParsedTsunamiInfo): void {
    // 取消報 → クリア
    if (info.infoType === "取消") {
      this.clear();
      return;
    }

    // forecast から警報レベルを検出
    const kinds = (info.forecast ?? []).map((f) => f.kind);
    const level = detectTsunamiAlertLevel(kinds);

    if (level == null) {
      // 警報レベルなし (津波予報のみ等) → クリア
      this.clear();
      return;
    }

    this.currentLevel = level;
    this.lastInfo = info;
  }

  /** 状態をクリアする */
  clear(): void {
    this.currentLevel = null;
    this.lastInfo = null;
  }

  // ── PromptStatusProvider ──

  getPromptStatus(): PromptStatusSegment | null {
    if (this.currentLevel == null) return null;

    const role = LEVEL_ROLE[this.currentLevel];
    const colorFn = getRoleChalk(role);
    return {
      text: colorFn(this.currentLevel),
      priority: 10,
    };
  }

  // ── DetailProvider ──

  hasDetail(): boolean {
    return this.lastInfo != null;
  }

  showDetail(): void {
    if (this.lastInfo != null) {
      displayTsunamiInfo(this.lastInfo);
    }
  }
}
