import {
  ParsedVolcanoInfo,
  ParsedVolcanoAlertInfo,
  PromptStatusProvider,
  PromptStatusSegment,
  DetailProvider,
  VolcanoAction,
} from "../../types";
import { getRoleChalk, RoleName } from "../../ui/theme";

/** 火山警報エントリ */
interface VolcanoAlertEntry {
  volcanoCode: string;
  volcanoName: string;
  alertLevel: number | null;
  alertLevelCode: string | null;
  action: VolcanoAction;
  reportDateTime: string;
  lastInfo: ParsedVolcanoAlertInfo;
}

/** レベルに対応するテーマロール */
function levelToRole(level: number | null): RoleName {
  switch (level) {
    case 5: return "frameCritical";
    case 4: return "frameCritical";
    case 3: return "frameWarning";
    case 2: return "frameWarning";
    case 1: return "frameNormal";
    default: return "frameNormal";
  }
}

/** レベルを表示文字列に変換 */
function levelToLabel(level: number | null): string {
  if (level == null) return "";
  return ` Lv${level}`;
}

/**
 * 火山情報の状態を保持し、プロンプト表示と detail コマンドを提供する。
 * 複数火山の同時追跡に対応 (volcanoCode をキーとする Map)。
 */
export class VolcanoStateHolder
  implements PromptStatusProvider, DetailProvider
{
  readonly category = "volcano";
  readonly emptyMessage = "現在、継続中の火山警報はありません。";

  private entries = new Map<string, VolcanoAlertEntry>();

  /** VFVO50/VFSVii 受信時に状態を更新する */
  update(info: ParsedVolcanoInfo): void {
    // alert 系のみ状態追跡
    if (info.kind !== "alert") return;
    const alertInfo = info as ParsedVolcanoAlertInfo;

    // 取消報 → エントリ削除
    if (info.infoType === "取消") {
      this.entries.delete(info.volcanoCode);
      return;
    }

    // 解除 → エントリ削除
    if (alertInfo.action === "release") {
      this.entries.delete(info.volcanoCode);
      return;
    }

    // レベル1で継続 → エントリ削除 (通常状態)
    if (alertInfo.alertLevel === 1 && alertInfo.action === "continue") {
      this.entries.delete(info.volcanoCode);
      return;
    }

    this.entries.set(info.volcanoCode, {
      volcanoCode: info.volcanoCode,
      volcanoName: info.volcanoName,
      alertLevel: alertInfo.alertLevel,
      alertLevelCode: alertInfo.alertLevelCode,
      action: alertInfo.action,
      reportDateTime: info.reportDateTime,
      lastInfo: alertInfo,
    });
  }

  /**
   * 同一火山で alertLevel・alertLevelCode・action が全て同じ場合 → 再通知と判定。
   * 新規 or 変化あり → false
   */
  isRenotification(info: ParsedVolcanoAlertInfo): boolean {
    const existing = this.entries.get(info.volcanoCode);
    if (!existing) return false;
    return (
      existing.alertLevel === info.alertLevel &&
      existing.alertLevelCode === info.alertLevelCode &&
      existing.action === info.action
    );
  }

  /** 状態をクリアする */
  clear(): void {
    this.entries.clear();
  }

  /** エントリ数を返す (テスト用) */
  size(): number {
    return this.entries.size;
  }

  /** 指定火山のエントリを返す (テスト用) */
  getEntry(volcanoCode: string): VolcanoAlertEntry | undefined {
    return this.entries.get(volcanoCode);
  }

  // ── PromptStatusProvider ──

  getPromptStatus(): PromptStatusSegment | null {
    if (this.entries.size === 0) return null;

    // 最も高い alertLevel のエントリを選択
    let highest: VolcanoAlertEntry | null = null;
    for (const entry of this.entries.values()) {
      if (!highest || (entry.alertLevel ?? 0) > (highest.alertLevel ?? 0)) {
        highest = entry;
      }
    }

    if (!highest) return null;

    const role = levelToRole(highest.alertLevel);
    const colorFn = getRoleChalk(role);
    const label = `${highest.volcanoName}${levelToLabel(highest.alertLevel)}`;
    return {
      text: colorFn(label),
      priority: 20,
    };
  }

  // ── DetailProvider ──

  hasDetail(): boolean {
    return this.entries.size > 0;
  }

  showDetail(): void {
    if (this.entries.size === 0) return;

    console.log("");
    console.log("  継続中の火山警報:");
    console.log("");

    const sorted = [...this.entries.values()].sort(
      (a, b) => (b.alertLevel ?? 0) - (a.alertLevel ?? 0)
    );

    for (const entry of sorted) {
      const role = levelToRole(entry.alertLevel);
      const colorFn = getRoleChalk(role);
      const levelStr = entry.alertLevel != null
        ? `Lv${entry.alertLevel}`
        : entry.alertLevelCode ?? "—";
      console.log(
        `    ${colorFn(entry.volcanoName)}  ${colorFn(levelStr)}  ${entry.lastInfo.warningKind}`
      );
    }
    console.log("");
  }
}
