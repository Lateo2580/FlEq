import {
  ParsedVolcanoInfo,
  ParsedVolcanoAlertInfo,
  PromptStatusProvider,
  PromptStatusSegment,
  PromptStatusRole,
  DetailProvider,
  DetailSnapshotOf,
  VolcanoAction,
} from "../../types";

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

export interface VolcanoReportTimeWatermark {
  volcanoCode: string;
  volcanoName: string;
  reportDateTime: string;
}

export interface VolcanoSeedEntry extends VolcanoReportTimeWatermark {
  alertLevel: number | null;
  active: boolean;
}

/** レベルに対応するテーマロール */
function levelToRole(level: number | null): PromptStatusRole {
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
  implements PromptStatusProvider, DetailProvider<"volcano">
{
  readonly category = "volcano";
  readonly emptyMessage = "現在、継続中の火山警報はありません。";

  private entries = new Map<string, VolcanoAlertEntry>();
  private reportTimeWatermarks = new Map<string, { reportTimeMs: number; volcanoName: string; reportDateTime: string }>();

  /** VFVO50/VFSVii 受信時に状態を更新する */
  update(info: ParsedVolcanoInfo): boolean {
    // alert 系のみ状態追跡
    if (info.kind !== "alert") return true;
    // volcanoCode が欠落している場合はスキップ (Map キー衝突を防ぐ)
    if (!info.volcanoCode) return true;
    const alertInfo = info as ParsedVolcanoAlertInfo;
    const reportTime = Date.parse(info.reportDateTime);
    const watermark = this.reportTimeWatermarks.get(info.volcanoCode);
    if (!Number.isNaN(reportTime)) {
      if (watermark != null && reportTime < watermark.reportTimeMs) return false;
      this.reportTimeWatermarks.set(info.volcanoCode, {
        reportTimeMs: reportTime,
        volcanoName: info.volcanoName,
        reportDateTime: info.reportDateTime,
      });
    }

    // 取消報 → エントリ削除
    if (info.infoType === "取消") {
      this.entries.delete(info.volcanoCode);
      return true;
    }

    // 解除 → エントリ削除
    if (alertInfo.action === "release") {
      this.entries.delete(info.volcanoCode);
      return true;
    }

    // レベル1で継続または引下げ → エントリ削除 (平常復帰)
    if (
      alertInfo.alertLevel === 1 &&
      (alertInfo.action === "continue" || alertInfo.action === "lower")
    ) {
      this.entries.delete(info.volcanoCode);
      return true;
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
    return true;
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
    this.reportTimeWatermarks.clear();
  }

  /** エントリ数を返す (テスト用) */
  size(): number {
    return this.entries.size;
  }

  /** 指定火山のエントリを返す (テスト用) */
  getEntry(volcanoCode: string): VolcanoAlertEntry | undefined {
    return this.entries.get(volcanoCode);
  }

  getWatermarks(): VolcanoReportTimeWatermark[] {
    return [...this.reportTimeWatermarks].map(([volcanoCode, watermark]) => ({
      volcanoCode,
      volcanoName: watermark.volcanoName,
      reportDateTime: watermark.reportDateTime,
    }));
  }

  getSeedEntries(): VolcanoSeedEntry[] {
    const active = [...this.entries.values()].map((entry) => ({
      volcanoCode: entry.volcanoCode,
      volcanoName: entry.volcanoName,
      alertLevel: entry.alertLevel,
      reportDateTime: entry.reportDateTime,
      active: true,
    }));
    const activeCodes = new Set(active.map((entry) => entry.volcanoCode));
    const released = this.getWatermarks()
      .filter((watermark) => !activeCodes.has(watermark.volcanoCode))
      .map((watermark) => ({ ...watermark, alertLevel: null, active: false }));
    return [...active, ...released];
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
    const label = `${highest.volcanoName}${levelToLabel(highest.alertLevel)}`;
    return {
      text: label,
      role,
      priority: 20,
    };
  }

  // ── DetailProvider ──

  getDetail(): DetailSnapshotOf<"volcano"> | null {
    if (this.entries.size === 0) return null;
    return {
      kind: "volcano",
      entries: [...this.entries.values()].map((entry) => ({
        volcanoName: entry.volcanoName,
        alertLevel: entry.alertLevel,
        alertLevelCode: entry.alertLevelCode,
        warningKind: entry.lastInfo.warningKind,
      })),
    };
  }

}
