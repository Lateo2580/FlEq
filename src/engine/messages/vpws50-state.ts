import type {
  ParsedWeatherWarning,
  WeatherSeverity,
  Vpws50Diff,
  Vpws50AreaChange,
  Vpws50KindTransition,
  Vpws50CurrentAreasForDisplay,
  Vpws50DisplayKindGroup,
  PhenomenonKey,
  DetailProvider,
  DetailSnapshotOf,
  DisplaySeverity,
  OfficialAlertLevel,
  ResolutionSource,
} from "../../types";
import * as log from "../../logger";
import { kindCodeToPhenomenonKey } from "../../dmdata/weather-phenomenon-key";
import {
  resolvePhenomenonFamily,
  resolveDisplaySeverity,
  DISPLAY_SEVERITY_RANK,
} from "../../dmdata/weather-warning-level";
// Plan-R3: displayVpws50FromState は Task 6 で実装される。dynamic import で順序問題を回避

const HISTORY_DEPTH = 8;
const RECAP_INTERVAL_MS = 60 * 60 * 1000;
const ABNORMAL_RELEASE_THRESHOLD = 0.8;

type AreaSnapshot = Map<string, {
  phenomenonKey: PhenomenonKey;
  kindCode: string;
  kindName: string;
  severity: WeatherSeverity;            // 旧 3 段 (集計互換用)
  displaySeverity: DisplaySeverity;     // Phase C: 昇降格判定の主軸
  officialAlertLevel: OfficialAlertLevel | null;
  resolutionSource: ResolutionSource;   // 監査用に保持 (現状未参照。nameFallback ヒットの検出は resolver 側テストが担う)
}>;

interface Snapshot {
  areas: Map<string, { areaName: string; kinds: AreaSnapshot }>;
}

export interface PersistedVpws50KindV2 {
  phenomenonKey: PhenomenonKey;
  kindCode: string;
  kindName: string;
  severity: WeatherSeverity;
  displaySeverity: DisplaySeverity;
  officialAlertLevel: OfficialAlertLevel | null;
  resolutionSource: ResolutionSource;
}

export interface PersistedVpws50SnapshotV2 {
  areas: Array<{
    areaCode: string;
    areaName: string;
    kinds: PersistedVpws50KindV2[];
  }>;
}

export interface PersistedVpws50StateV2 {
  current: {
    messageId: string;
    identity: WeatherReportIdentity;
    snapshot: PersistedVpws50SnapshotV2;
  } | null;
  history: Array<{
    messageId: string;
    identity: WeatherReportIdentity | null;
    snapshot: PersistedVpws50SnapshotV2;
  }>;
  lastSuccessfulFullDisplayAt: string | null;
}

function serializeSnapshot(snapshot: Snapshot): PersistedVpws50SnapshotV2 {
  return {
    areas: [...snapshot.areas].map(([areaCode, area]) => ({
      areaCode,
      areaName: area.areaName,
      kinds: [...area.kinds.values()].map((kind) => ({ ...kind })),
    })),
  };
}

function restoreSnapshot(snapshot: PersistedVpws50SnapshotV2): Snapshot {
  return {
    areas: new Map(snapshot.areas.map((area) => [
      area.areaCode,
      {
        areaName: area.areaName,
        kinds: new Map(area.kinds.map((kind) => [kind.phenomenonKey, { ...kind }])),
      },
    ])),
  };
}

/** 気象警報系電文の単調性・取消対象を識別する Head identity。 */
export interface WeatherReportIdentity {
  reportDateTime: string;
  serial: string | null;
}

function normalizeSerial(serial: string | null): string | null {
  const normalized = serial?.trim() ?? "";
  return normalized === "" ? null : normalized;
}

function compareSerial(a: string | null, b: string | null): number {
  const normalizedA = normalizeSerial(a);
  const normalizedB = normalizeSerial(b);
  if (normalizedA === normalizedB) return 0;
  if (normalizedA == null) return -1;
  if (normalizedB == null) return 1;

  if (/^\d+$/.test(normalizedA) && /^\d+$/.test(normalizedB)) {
    const numericA = BigInt(normalizedA);
    const numericB = BigInt(normalizedB);
    if (numericA === numericB) return 0;
    return numericA < numericB ? -1 : 1;
  }
  return normalizedA < normalizedB ? -1 : 1;
}

/** reportDateTime を主、同時刻では Serial を従として identity を比較する。 */
export function compareWeatherReportIdentity(
  a: WeatherReportIdentity,
  b: WeatherReportIdentity,
): number | null {
  const timeA = Date.parse(a.reportDateTime);
  const timeB = Date.parse(b.reportDateTime);
  if (!Number.isFinite(timeA) || !Number.isFinite(timeB)) return null;
  if (timeA !== timeB) return timeA < timeB ? -1 : 1;
  return compareSerial(a.serial, b.serial);
}

export function weatherReportIdentityEquals(
  a: WeatherReportIdentity,
  b: WeatherReportIdentity,
): boolean {
  return compareWeatherReportIdentity(a, b) === 0;
}

/** 電文由来の Kind 名称からレベル接頭辞・種別接尾辞を取り除く。Vpww56StateHolder からも再利用 (DRY) */
export function shortKindName(name: string): string {
  return name
    .replace(/^レベル[０-９0-9]+/, "")
    .replace(/特別警報$/, "")
    .replace(/危険警報$/, "")
    .replace(/警戒情報$/, "")
    .replace(/警報$/, "")
    .replace(/注意報$/, "")
    .trim() || name;
}

function infoToSnapshot(info: ParsedWeatherWarning): Snapshot | null {
  const layer = info.layers.find((l) => l.type.includes("府県予報区等"));
  if (!layer) return null;
  const areas = new Map<string, { areaName: string; kinds: AreaSnapshot }>();
  for (const item of layer.items) {
    const kinds: AreaSnapshot = new Map();
    for (const k of item.kinds) {
      const family = resolvePhenomenonFamily(k.code, k.name);
      const resolved = resolveDisplaySeverity(k.code, k.name, family);
      // Phase C: release のみ除外。unknown (rank 30) も保持して沈黙させない (Codex R1 P1)
      if (resolved.displaySeverity === "release") continue;
      if (k.severity === "release") continue; // 名前ベース解除の防御 (従来挙動維持)
      const phenomenonKey = kindCodeToPhenomenonKey(k.code);
      const existing = kinds.get(phenomenonKey);
      if (existing == null ||
          DISPLAY_SEVERITY_RANK[resolved.displaySeverity] > DISPLAY_SEVERITY_RANK[existing.displaySeverity]) {
        kinds.set(phenomenonKey, {
          phenomenonKey,
          kindCode: k.code,
          kindName: k.name,
          severity: k.severity,
          displaySeverity: resolved.displaySeverity,
          officialAlertLevel: resolved.officialAlertLevel,
          resolutionSource: resolved.source,
        });
      }
    }
    areas.set(item.areaCode, { areaName: item.areaName, kinds });
  }
  return { areas };
}

function computeDiff(prev: Snapshot | null, curr: Snapshot): {
  added: Vpws50AreaChange[];
  upgraded: Vpws50AreaChange[];
  downgraded: Vpws50AreaChange[];
  released: Vpws50AreaChange[];
} {
  const added: Vpws50AreaChange[] = [];
  const upgraded: Vpws50AreaChange[] = [];
  const downgraded: Vpws50AreaChange[] = [];
  const released: Vpws50AreaChange[] = [];

  const prevAreas = prev?.areas ?? new Map<string, { areaName: string; kinds: AreaSnapshot }>();

  for (const [areaCode, currArea] of curr.areas) {
    const prevArea = prevAreas.get(areaCode);
    const addedKinds: Vpws50KindTransition[] = [];
    const upgradedKinds: Vpws50KindTransition[] = [];
    const downgradedKinds: Vpws50KindTransition[] = [];

    for (const [phKey, currKind] of currArea.kinds) {
      const prevKind = prevArea?.kinds.get(phKey);
      const t: Vpws50KindTransition = {
        phenomenonKey: phKey,
        kindShortName: shortKindName(currKind.kindName),
        prevKindCode: prevKind?.kindCode ?? null,
        newKindCode: currKind.kindCode,
        prevSeverity: prevKind?.severity ?? null,
        newSeverity: currKind.severity,
        prevDisplaySeverity: prevKind?.displaySeverity ?? null,
        newDisplaySeverity: currKind.displaySeverity,
        prevOfficialAlertLevel: prevKind?.officialAlertLevel ?? null,
        newOfficialAlertLevel: currKind.officialAlertLevel,
      };
      if (prevKind == null) {
        addedKinds.push(t);
      } else if (prevKind.displaySeverity !== currKind.displaySeverity) {
        const prevRank = DISPLAY_SEVERITY_RANK[prevKind.displaySeverity];
        const currRank = DISPLAY_SEVERITY_RANK[currKind.displaySeverity];
        if (currRank > prevRank) upgradedKinds.push(t);
        else downgradedKinds.push(t);
      }
      // 同 displaySeverity (Code 変化のみ等) は変化なし扱い (従来挙動と同じ粒度)
    }
    if (addedKinds.length > 0) added.push({ areaName: currArea.areaName, areaCode, changes: addedKinds });
    if (upgradedKinds.length > 0) upgraded.push({ areaName: currArea.areaName, areaCode, changes: upgradedKinds });
    if (downgradedKinds.length > 0) downgraded.push({ areaName: currArea.areaName, areaCode, changes: downgradedKinds });
  }

  for (const [areaCode, prevArea] of prevAreas) {
    const currArea = curr.areas.get(areaCode);
    const releasedKinds: Vpws50KindTransition[] = [];
    for (const [phKey, prevKind] of prevArea.kinds) {
      if (currArea == null || !currArea.kinds.has(phKey)) {
        releasedKinds.push({
          phenomenonKey: phKey,
          kindShortName: shortKindName(prevKind.kindName),
          prevKindCode: prevKind.kindCode,
          newKindCode: null,
          prevSeverity: prevKind.severity,
          newSeverity: null,
          prevDisplaySeverity: prevKind.displaySeverity,
          newDisplaySeverity: null,
          prevOfficialAlertLevel: prevKind.officialAlertLevel,
          newOfficialAlertLevel: null,
        });
      }
    }
    if (releasedKinds.length > 0) {
      released.push({ areaName: prevArea.areaName, areaCode, changes: releasedKinds });
    }
  }

  return { added, upgraded, downgraded, released };
}

function countAreaKeys(snap: Snapshot | null): number {
  if (snap == null) return 0;
  let n = 0;
  for (const a of snap.areas.values()) n += a.kinds.size;
  return n;
}

/** 60 分再掲条件: displaySeverity が警報級相当 (rank >= nonLevelWarning) 以上を含むか */
function hasWarningOrHigher(snap: Snapshot | null): boolean {
  if (snap == null) return false;
  const threshold = DISPLAY_SEVERITY_RANK["nonLevelWarning"];
  for (const a of snap.areas.values()) {
    for (const k of a.kinds.values()) {
      if (DISPLAY_SEVERITY_RANK[k.displaySeverity] >= threshold) return true;
    }
  }
  return false;
}

export class Vpws50StateHolder implements DetailProvider<"vpws50"> {
  readonly category = "vpws50";
  readonly emptyMessage = "VPWS50 の最新電文を受信していません";

  private current: Snapshot | null = null;
  private currentMessageId: string | null = null;
  private currentIdentity: WeatherReportIdentity | null = null;
  private history: Array<{
    messageId: string;
    identity: WeatherReportIdentity | null;
    snapshot: Snapshot;
  }> = [];
  private lastSuccessfulFullDisplayAt: Date | null = null;

  diffAndUpdate(info: ParsedWeatherWarning, messageId: string): Vpws50Diff;
  diffAndUpdate(
    info: ParsedWeatherWarning,
    messageId: string,
    identity: WeatherReportIdentity,
    options?: { replaceCurrentRevision?: boolean },
  ): Vpws50Diff | null;
  diffAndUpdate(
    info: ParsedWeatherWarning,
    messageId: string,
    identity?: WeatherReportIdentity,
    options?: { replaceCurrentRevision?: boolean },
  ): Vpws50Diff | null {
    const newSnap = infoToSnapshot(info);
    const unsafeReason = this.unsafeReasonFor(newSnap);
    if (unsafeReason != null) return this.buildUnsafeDiff(unsafeReason);
    if (newSnap == null) return this.buildUnsafeDiff("layer_missing");

    const isFirstReport = this.current == null;
    const diffParts = isFirstReport
      ? { added: [], upgraded: [], downgraded: [], released: [] }
      : computeDiff(this.current, newSnap);
    const isUnchanged =
      !isFirstReport &&
      diffParts.added.length === 0 &&
      diffParts.upgraded.length === 0 &&
      diffParts.downgraded.length === 0 &&
      diffParts.released.length === 0;

    const shouldRecap = (() => {
      if (!isUnchanged) return false;
      if (!hasWarningOrHigher(newSnap)) return false;
      if (this.lastSuccessfulFullDisplayAt == null) return false;
      return Date.now() - this.lastSuccessfulFullDisplayAt.getTime() >= RECAP_INTERVAL_MS;
    })();

    if (this.current != null && options?.replaceCurrentRevision !== true) {
      this.history.push({
        messageId: this.currentMessageId ?? "",
        identity: this.currentIdentity,
        snapshot: this.current,
      });
      while (this.history.length > HISTORY_DEPTH) this.history.shift();
    }
    this.current = newSnap;
    this.currentMessageId = messageId;
    this.currentIdentity = identity ?? null;

    if (!isUnchanged || shouldRecap || isFirstReport) {
      this.lastSuccessfulFullDisplayAt = new Date();
    }

    return {
      isFirstReport,
      isUnchanged,
      isCancelRollback: false,
      shouldRecap,
      confidence: "confirmed",
      ...diffParts,
    };
  }

  /** revision gate を確定する前に、state を変更せず安全性だけを判定する。 */
  previewUnsafe(info: ParsedWeatherWarning): Vpws50Diff | null {
    const reason = this.unsafeReasonFor(infoToSnapshot(info));
    return reason == null ? null : this.buildUnsafeDiff(reason);
  }

  private unsafeReasonFor(newSnap: Snapshot | null): "layer_missing" | "abnormal_release_rate" | null {
    if (newSnap == null) return "layer_missing";
    const prevCount = countAreaKeys(this.current);
    // 80% 以上消失は abnormal だが、prevCount<2 では single release が 100% に
    // 化けるため誤検出を避けて閾値判定をスキップ。
    if (prevCount < 2 || this.current == null) return null;
    let actualReleased = 0;
    for (const [areaCode, prevArea] of this.current.areas) {
      const currArea = newSnap.areas.get(areaCode);
      for (const phKey of prevArea.kinds.keys()) {
        if (currArea == null || !currArea.kinds.has(phKey)) actualReleased++;
      }
    }
    // 全解除は正当な一斉解除。発表中種別が残る部分大量解除だけを防御する。
    const remaining = countAreaKeys(newSnap);
    return remaining > 0 && actualReleased / prevCount >= ABNORMAL_RELEASE_THRESHOLD
      ? "abnormal_release_rate"
      : null;
  }

  rollback(target: string | WeatherReportIdentity): Vpws50Diff | null {
    if (!this.matchesCurrentReport(target)) {
      const identityText = typeof target === "string"
        ? `messageId=${target}`
        : `reportDateTime=${target.reportDateTime}, serial=${target.serial ?? ""}`;
      log.warn(`[vpws50-state] cancellation target does not match current report - ignored (${identityText})`);
      return null;
    }

    const last = this.history.pop();
    if (last == null) {
      this.current = null;
      this.currentMessageId = null;
      this.currentIdentity = null;
      return {
        isFirstReport: true,
        isUnchanged: false,
        isCancelRollback: true,
        shouldRecap: false,
        confidence: "confirmed",
        added: [], upgraded: [], downgraded: [], released: [],
      };
    }
    this.current = last.snapshot;
    this.currentMessageId = last.messageId;
    this.currentIdentity = last.identity;
    this.lastSuccessfulFullDisplayAt = new Date();
    return {
      isFirstReport: false,
      isUnchanged: false,
      isCancelRollback: true,
      shouldRecap: false,
      confidence: "confirmed",
      added: [], upgraded: [], downgraded: [], released: [],
      currentAreasForDisplay: this.buildCurrentAreasForDisplay(),
    };
  }

  private matchesCurrentReport(target: string | WeatherReportIdentity): boolean {
    if (typeof target === "string") {
      return this.current != null && target === this.currentMessageId;
    }
    if (this.current == null || this.currentIdentity == null) {
      return false;
    }
    return weatherReportIdentityEquals(target, this.currentIdentity);
  }

  /** 共通 revision gate が対象一致を確認した後に、一つ前の完全 snapshot へ戻す。 */
  restorePrevious(): Vpws50Diff {
    const last = this.history.pop();
    if (last == null) {
      this.current = null;
      this.currentMessageId = null;
      this.currentIdentity = null;
      return {
        isFirstReport: true, isUnchanged: false, isCancelRollback: true,
        shouldRecap: false, confidence: "confirmed",
        added: [], upgraded: [], downgraded: [], released: [],
      };
    }
    this.current = last.snapshot;
    this.currentMessageId = last.messageId;
    this.currentIdentity = last.identity;
    this.lastSuccessfulFullDisplayAt = new Date();
    return {
      isFirstReport: false, isUnchanged: false, isCancelRollback: true,
      shouldRecap: false, confidence: "confirmed",
      added: [], upgraded: [], downgraded: [], released: [],
      currentAreasForDisplay: this.buildCurrentAreasForDisplay(),
    };
  }

  exportPersistedState(): PersistedVpws50StateV2 {
    return {
      current: this.current == null || this.currentIdentity == null ? null : {
        messageId: this.currentMessageId ?? "",
        identity: { ...this.currentIdentity },
        snapshot: serializeSnapshot(this.current),
      },
      history: this.history.map((entry) => ({
        messageId: entry.messageId,
        identity: entry.identity == null ? null : { ...entry.identity },
        snapshot: serializeSnapshot(entry.snapshot),
      })),
      lastSuccessfulFullDisplayAt: this.lastSuccessfulFullDisplayAt?.toISOString() ?? null,
    };
  }

  restorePersistedState(state: PersistedVpws50StateV2): void {
    this.current = state.current == null ? null : restoreSnapshot(state.current.snapshot);
    this.currentMessageId = state.current?.messageId ?? null;
    this.currentIdentity = state.current == null ? null : { ...state.current.identity };
    this.history = state.history.slice(-HISTORY_DEPTH).map((entry) => ({
      messageId: entry.messageId,
      identity: entry.identity == null ? null : { ...entry.identity },
      snapshot: restoreSnapshot(entry.snapshot),
    }));
    this.lastSuccessfulFullDisplayAt = state.lastSuccessfulFullDisplayAt == null
      ? null
      : new Date(state.lastSuccessfulFullDisplayAt);
  }

  private buildCurrentAreasForDisplay(): Vpws50CurrentAreasForDisplay | undefined {
    if (this.current == null) return undefined;
    const allAreas = new Set<string>();
    const specialAreas = new Set<string>();
    const warningAreas = new Set<string>();
    const advisoryAreas = new Set<string>();
    const byKindCode = new Map<string, Vpws50DisplayKindGroup>();
    for (const [areaCode, area] of this.current.areas) {
      for (const kind of area.kinds.values()) {
        allAreas.add(areaCode);
        // 旧 3 段カウント (サマリ行 特X/警Y/注Z 用の互換維持。Code 43/48/49 は severity=warning
        // なので警枠に入る。Task 7 (displaySeverity セクション化) 完了時に互換維持で確定 —
        // セクション側は ★ 危険警報 (L4) に独立する一方カウントは警枠のままで、見かけ上のズレは
        // 2026-06-12 目視ゲートでレビュー決定: 現状維持 (互換カウント確定))
        if (kind.severity === "specialWarning") specialAreas.add(areaCode);
        else if (kind.severity === "warning") warningAreas.add(areaCode);
        else if (kind.severity === "advisory") advisoryAreas.add(areaCode);
        let group = byKindCode.get(kind.kindCode);
        if (group == null) {
          group = {
            kindCode: kind.kindCode,
            kindShortName: shortKindName(kind.kindName),
            kindName: kind.kindName,
            displaySeverity: kind.displaySeverity,
            officialAlertLevel: kind.officialAlertLevel,
            areas: [],
          };
          byKindCode.set(kind.kindCode, group);
        }
        group.areas.push({ areaName: area.areaName, areaCode });
      }
    }
    const kinds = Array.from(byKindCode.values()).sort(
      (a, b) => DISPLAY_SEVERITY_RANK[b.displaySeverity] - DISPLAY_SEVERITY_RANK[a.displaySeverity],
    );
    return {
      totalAreas: allAreas.size,
      specialAreas: specialAreas.size,
      warningAreas: warningAreas.size,
      advisoryAreas: advisoryAreas.size,
      kinds,
    };
  }

  private buildUnsafeDiff(reason: "layer_missing" | "abnormal_release_rate"): Vpws50Diff {
    return {
      isFirstReport: false,
      isUnchanged: false,
      isCancelRollback: false,
      shouldRecap: false,
      confidence: "unsafe",
      unsafeReason: reason,
      added: [], upgraded: [], downgraded: [], released: [],
    };
  }

  /** 表示ディスプレイ用: 現在発表中の警報・注意報の集約ビュー (未受信なら undefined) */
  getCurrentAreasForDisplay(): Vpws50CurrentAreasForDisplay | undefined {
    return this.buildCurrentAreasForDisplay();
  }

  getCurrentIdentity(): WeatherReportIdentity | null {
    return this.currentIdentity == null ? null : { ...this.currentIdentity };
  }

  getDetail(): DetailSnapshotOf<"vpws50"> | null {
    const display = this.buildCurrentAreasForDisplay();
    if (display == null) return null;
    return { kind: "vpws50", display };
  }

  __test_setLastSuccessfulFullDisplayAt(d: Date | null): void {
    this.lastSuccessfulFullDisplayAt = d;
  }
  __test_getLastSuccessfulFullDisplayAt(): Date | null {
    return this.lastSuccessfulFullDisplayAt;
  }
}
