import type { ParsedFloodForecastInfo, FloodLevel, FloodKindCode } from "../../types";

/**
 * 指定河川洪水予報 (VXKO50-89 / VXSU50-59) の station-level 差分結果。
 * spec §8 / plan Task 23 (本実装) 参照。
 *   - hasChange: 変化 (新規 / フィールド差分 / 削除) があった場合のみ true
 *   - changedStations: stationCode と変化理由 (複数可) のリスト
 *   - removedStations: 前回あって今回ない station code のリスト
 */
export interface FloodForecastDiff {
  hasChange: boolean;
  changedStations: Array<{
    stationCode: string;
    reasons: Array<
      | "new"
      | "kindCode"
      | "headlineLevel"
      | "stationObservedLevel"
      | "condition"
      | "mainItemCode"
      | "mainText"
    >;
  }>;
  removedStations: string[];
}

/**
 * 観測点ごとの差分検出用ダイジェスト。
 * buildStationDigests が ParsedFloodForecastInfo.rawStations から組み立てる。
 *   - kindCode: 観測点の headlineKindCode (parser が §3.1 ルールで解決)
 *   - condition: series[0]?.condition (最新観測の変化方向)。欠測時は "欠測"
 *   - mainItemCode / mainTextHash: Warning.Item の本文差分検出 (16_11 系の主文更新で発火)
 */
export interface StationDigest {
  stationCode: string;
  kindCode: FloodKindCode;
  headlineLevel: FloodLevel;
  stationObservedLevel: FloodLevel;
  condition: string;
  mainItemCode: "1" | "2" | null;
  mainTextHash: string;
}

/** store 内の前回値 (digest + 観測時刻) */
interface DedupValue extends StationDigest {
  receivedAt: string | null;
}

/**
 * ParsedFloodForecastInfo から StationDigest[] を組み立てる。
 * rawStations が空 (Headline-only 電文) のときは [] を返す。
 */
export function buildStationDigests(info: ParsedFloodForecastInfo): StationDigest[] {
  return info.rawStations.map((s) => ({
    stationCode: s.stationCode,
    kindCode: s.headlineKindCode,
    headlineLevel: s.headlineLevel,
    stationObservedLevel: s.stationObservedLevel,
    condition: s.series[0]?.condition ?? "欠測",
    mainItemCode: s.mainItemCode,
    mainTextHash: s.mainTextHash,
  }));
}

/**
 * 同一 EventID で前回の観測点状態を覚えて station 単位 dedup する state holder。
 * Vpws50StateHolder / TyphoonProbabilityStateHolder と同思想 (in-memory, restart=全 reset)。
 *
 * key 設計: `${eventId}|${stationCode}` で、異なる EventID は完全独立。
 * 取消 (rollback) は同一 eventId の全 station entry を削除する。
 *
 * 空 eventId ("") は履歴に乗せない (誤った dedup を避ける)。hasChange=true を返すが
 * changedStations は空のため、呼び出し側は通知だけ行って station 個別 diff は使わない。
 */
export class FloodForecastStateHolder {
  private last: Map<string, DedupValue> = new Map();

  diffAndUpdate(
    eventId: string,
    digests: StationDigest[],
    receivedAt: string | null,
  ): FloodForecastDiff {
    if (eventId === "") {
      // EventID 不明の発表は履歴に乗せない (TyphoonProbabilityStateHolder と同じ方針)
      return { hasChange: true, changedStations: [], removedStations: [] };
    }

    const changed: FloodForecastDiff["changedStations"] = [];
    const incomingCodes = new Set(digests.map((d) => d.stationCode));

    for (const d of digests) {
      const key = `${eventId}|${d.stationCode}`;
      const prev = this.last.get(key);
      const reasons: FloodForecastDiff["changedStations"][number]["reasons"] = [];
      if (prev == null) {
        reasons.push("new");
      } else {
        if (prev.kindCode !== d.kindCode) reasons.push("kindCode");
        if (prev.headlineLevel !== d.headlineLevel) reasons.push("headlineLevel");
        if (prev.stationObservedLevel !== d.stationObservedLevel) {
          reasons.push("stationObservedLevel");
        }
        if (prev.condition !== d.condition) reasons.push("condition");
        if (prev.mainItemCode !== d.mainItemCode) reasons.push("mainItemCode");
        if (prev.mainTextHash !== d.mainTextHash) reasons.push("mainText");
      }
      if (reasons.length > 0) {
        changed.push({ stationCode: d.stationCode, reasons });
      }
      this.last.set(key, { ...d, receivedAt });
    }

    // 前回あって今回 incoming に含まれない station code を removedStations に
    const removed: string[] = [];
    const prefix = `${eventId}|`;
    for (const key of Array.from(this.last.keys())) {
      if (!key.startsWith(prefix)) continue;
      const stationCode = key.slice(prefix.length);
      if (!incomingCodes.has(stationCode)) {
        removed.push(stationCode);
        this.last.delete(key);
      }
    }

    return {
      hasChange: changed.length > 0 || removed.length > 0,
      changedStations: changed,
      removedStations: removed,
    };
  }

  /** 取消 (info.infoType==="取消") 時に呼ぶ。同一 eventId の全 station entry を削除する */
  rollback(eventId: string): void {
    if (eventId === "") return;
    const prefix = `${eventId}|`;
    for (const key of Array.from(this.last.keys())) {
      if (key.startsWith(prefix)) this.last.delete(key);
    }
  }
}
