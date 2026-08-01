import {
  ParsedVolcanoInfo,
  ParsedVolcanoAlertInfo,
  PromptStatusProvider,
  PromptStatusSegment,
  PromptStatusRole,
  DetailProvider,
  DetailSnapshotOf,
  VolcanoAction,
  VolcanoAlertClass,
  VolcanoAlertClassEntry,
  VolcanoAlertStateEntry,
  ParsedVolcanoEruptionInfo,
} from "../../types";

/** 火山警報エントリ */
export interface VolcanoAlertEntry {
  volcanoCode: string;
  volcanoName: string;
  alertLevel: number | null;
  alertLevelCode: string | null;
  action: VolcanoAction;
  reportDateTime: string;
  alertClass: VolcanoAlertClass | null;
  warningKind: string;
  targetKinds: string[];
  lastInfo: ParsedVolcanoAlertInfo | null;
}

export interface PersistedVolcanoStateV2 {
  alerts: Array<Omit<VolcanoAlertEntry, "lastInfo">>;
  eruptions: Array<{
    volcanoCode: string;
    eventId: string | null;
    /** true のときだけ EventID 不一致時の一意 fallback 候補にできる。欠落は live 扱い。 */
    legacyV1Fallback?: boolean;
  }>;
}

export interface VolcanoSeedEntry {
  volcanoCode: string;
  volcanoName: string;
  reportDateTime: string;
  alertLevel: number | null;
  alertClass: ParsedVolcanoAlertInfo["alertClass"];
  warningKind: string;
  targetKinds: string[];
  active: boolean;
}

export function activeLegacyEruptionIdentitySeeds(
  states: readonly {
    code: string;
    latestEvent?: unknown | null;
    latestEventId?: string | null;
    eventExpiresAtMs: number | null;
  }[],
  foundationSubjects: ReadonlySet<string>,
  nowMs: number,
): Array<{ volcanoCode: string; eventId: string | null }> {
  return states.flatMap((state) =>
    state.latestEvent == null
    || state.eventExpiresAtMs == null
    || state.eventExpiresAtMs <= nowMs
    || foundationSubjects.has(`volcano:eruption:${state.code}`)
      ? []
      : [{ volcanoCode: state.code, eventId: state.latestEventId ?? null }]);
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
  private eruptions = new Map<string, {
    eventId: string | null;
    legacyV1Fallback: boolean;
  }>();
  private managedAlertCodes = new Set<string>();
  private managedEruptionCodes = new Set<string>();

  /** gate 通過済みの VFVO50/VFSVii を反映する。 */
  applyAcceptedAlert(info: ParsedVolcanoAlertInfo): void {
    if (!info.volcanoCode) return;
    this.managedAlertCodes.add(info.volcanoCode);
    this.entries.delete(info.volcanoCode);
    this.entries.set(info.volcanoCode, {
      volcanoCode: info.volcanoCode,
      volcanoName: info.volcanoName,
      alertLevel: info.alertLevel,
      alertLevelCode: info.alertLevelCode,
      action: info.action,
      reportDateTime: info.reportDateTime,
      alertClass: info.alertClass,
      warningKind: info.warningKind,
      targetKinds: info.municipalities.map((municipality) => municipality.kind),
      lastInfo: info,
    });
  }

  /** gate 通過済みの VFVO51 一覧 entry を火山単位で反映する。 */
  applyAcceptedAlertClass(entry: VolcanoAlertClassEntry, reportDateTime: string): void {
    this.applyAcceptedTextAlert({
      volcanoCode: entry.volcanoCode,
      volcanoName: entry.volcanoName,
      alertLevel: null,
      alertLevelCode: entry.alertClass.code,
      action: entry.alertClass.isActive ? "continue" : "release",
      warningKind: entry.alertClass.name,
      alertClass: { ...entry.alertClass },
    }, reportDateTime);
  }

  applyAcceptedTextAlert(entry: VolcanoAlertStateEntry, reportDateTime: string): void {
    if (!entry.volcanoCode) return;
    this.managedAlertCodes.add(entry.volcanoCode);
    this.entries.delete(entry.volcanoCode);
    this.entries.set(entry.volcanoCode, {
      volcanoCode: entry.volcanoCode,
      volcanoName: entry.volcanoName,
      alertLevel: entry.alertLevel,
      alertLevelCode: entry.alertLevelCode,
      action: entry.action,
      reportDateTime,
      alertClass: entry.alertClass == null ? null : { ...entry.alertClass },
      warningKind: entry.warningKind,
      targetKinds: [],
      lastInfo: null,
    });
  }

  clearAlert(volcanoCode: string): void {
    this.entries.delete(volcanoCode);
    this.managedAlertCodes.delete(volcanoCode);
  }

  applyAcceptedEruption(info: ParsedVolcanoEruptionInfo, eventId: string | null): void {
    if (!info.volcanoCode) return;
    this.managedEruptionCodes.add(info.volcanoCode);
    this.eruptions.delete(info.volcanoCode);
    this.eruptions.set(info.volcanoCode, { eventId, legacyV1Fallback: false });
  }

  clearEruption(volcanoCode: string): void {
    this.eruptions.delete(volcanoCode);
    this.managedEruptionCodes.delete(volcanoCode);
  }

  resolveEruptionCancellation(eventId: string): string | null {
    const exact = [...this.eruptions]
      .filter(([, entry]) => entry.eventId === eventId)
      .map(([volcanoCode]) => volcanoCode);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    const legacy = [...this.eruptions]
      .filter(([, entry]) => entry.eventId == null && entry.legacyV1Fallback)
      .map(([volcanoCode]) => volcanoCode);
    return legacy.length === 1 ? legacy[0] : null;
  }

  eruptionEventId(volcanoCode: string): string | null {
    return this.eruptions.get(volcanoCode)?.eventId?.trim() || null;
  }

  /** v1 表示 snapshot の EventID 対応を取消対象解決専用に保持する。watermark には採用しない。 */
  seedLegacyEruptionIdentities(
    entries: readonly { volcanoCode: string; eventId: string | null }[],
  ): void {
    for (const entry of entries) {
      if (entry.volcanoCode === "" || this.eruptions.has(entry.volcanoCode)) continue;
      this.eruptions.set(entry.volcanoCode, {
        eventId: entry.eventId,
        legacyV1Fallback: true,
      });
    }
  }

  retainActiveSubjects(alertSubjects: readonly string[], eruptionSubjects: readonly string[]): void {
    const alerts = new Set(alertSubjects.map((subject) => subject.replace(/^volcano:alert:/, "")));
    const eruptions = new Set(eruptionSubjects.map((subject) => subject.replace(/^volcano:eruption:/, "")));
    for (const code of this.managedAlertCodes) {
      if (alerts.has(code)) continue;
      this.entries.delete(code);
      this.managedAlertCodes.delete(code);
    }
    for (const code of this.managedEruptionCodes) {
      if (eruptions.has(code)) continue;
      this.eruptions.delete(code);
      this.managedEruptionCodes.delete(code);
    }
  }

  /** @deprecated formatter/unit helper。production の単調性は TelegramRevisionGate が所有する。 */
  update(info: ParsedVolcanoInfo): boolean {
    if (info.kind !== "alert") return true;
    if (!info.volcanoCode) return true;
    const alertInfo = info as ParsedVolcanoAlertInfo;
    if (
      info.infoType === "取消"
      || alertInfo.action === "release"
      || alertInfo.action === "cancel"
      || (
      alertInfo.alertLevel === 1 &&
      (alertInfo.action === "continue" || alertInfo.action === "lower")
      )
    ) {
      this.clearAlert(info.volcanoCode);
      return true;
    }
    this.applyAcceptedAlert(alertInfo);
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
    this.eruptions.clear();
    this.managedAlertCodes.clear();
    this.managedEruptionCodes.clear();
  }

  /** エントリ数を返す (テスト用) */
  size(): number {
    return this.entries.size;
  }

  /** 指定火山のエントリを返す (テスト用) */
  getEntry(volcanoCode: string): VolcanoAlertEntry | undefined {
    return this.entries.get(volcanoCode);
  }

  getSeedEntries(): VolcanoSeedEntry[] {
    const active = [...this.entries.values()].map((entry) => ({
      volcanoCode: entry.volcanoCode,
      volcanoName: entry.volcanoName,
      alertLevel: entry.alertLevel,
      alertClass: entry.alertClass,
      warningKind: entry.warningKind,
      targetKinds: [...entry.targetKinds],
      reportDateTime: entry.reportDateTime,
      active: true,
    }));
    return active;
  }

  exportPersistedState(): PersistedVolcanoStateV2 {
    return {
      alerts: [...this.entries.values()].map(({ lastInfo: _lastInfo, ...entry }) => structuredClone(entry)),
      eruptions: [...this.eruptions].map(([volcanoCode, entry]) => ({
        volcanoCode,
        eventId: entry.eventId,
        ...(entry.legacyV1Fallback ? { legacyV1Fallback: true } : {}),
      })),
    };
  }

  restorePersistedState(state: PersistedVolcanoStateV2): void {
    this.entries.clear();
    this.eruptions.clear();
    this.managedAlertCodes.clear();
    this.managedEruptionCodes.clear();
    for (const entry of state.alerts) {
      this.entries.set(entry.volcanoCode, { ...structuredClone(entry), lastInfo: null });
      this.managedAlertCodes.add(entry.volcanoCode);
    }
    for (const entry of state.eruptions) {
      const legacyV1Fallback = entry.legacyV1Fallback === true;
      this.eruptions.set(entry.volcanoCode, {
        eventId: entry.eventId,
        // pre-provenance v2 は誤取消を避けるため live として扱う。
        legacyV1Fallback,
      });
      if (!legacyV1Fallback) this.managedEruptionCodes.add(entry.volcanoCode);
    }
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
        warningKind: entry.warningKind,
      })),
    };
  }

}
