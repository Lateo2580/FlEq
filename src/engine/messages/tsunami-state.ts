import {
  ParsedTsunamiInfo,
  PromptStatusProvider,
  PromptStatusSegment,
  PromptStatusRole,
  DetailProvider,
  DetailSnapshotOf,
  TsunamiObservationStation,
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

export type TsunamiObservationFamily = "VTSE51" | "VTSE52";

/**
 * 気象庁の観測点集合を十分に収めつつ、durable item watermark と表示配列を
 * 無制限に増やさないための family 単位上限。
 */
export const TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY = 1024;

export interface TsunamiObservationGroups {
  VTSE51: TsunamiObservationStation[];
  VTSE52: TsunamiObservationStation[];
}

function emptyObservationGroups(): TsunamiObservationGroups {
  return { VTSE51: [], VTSE52: [] };
}

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
  private observationGroups = emptyObservationGroups();

  /** 現在の警報レベルを返す (テスト用) */
  getLevel(): TsunamiLevelLabel | null {
    return this.currentLevel;
  }

  /** 表示ディスプレイ用: 最後に受信した津波情報 (発表中でなければ null) */
  getLastInfo(): ParsedTsunamiInfo | null {
    return this.lastInfo;
  }

  getObservationGroups(): TsunamiObservationGroups {
    return structuredClone(this.observationGroups);
  }

  getPersistedActive(): ParsedTsunamiInfo | null {
    return this.lastInfo == null ? null : structuredClone(this.lastInfo);
  }

  applyAcceptedObservations(
    family: TsunamiObservationFamily,
    observations: readonly TsunamiObservationStation[],
  ): string[] {
    const merged = new Map(
      this.observationGroups[family].flatMap((item) => {
        const code = item.stationCode?.trim();
        return code ? [[code, item] as const] : [];
      }),
    );
    for (const item of observations) {
      const code = item.stationCode?.trim();
      // code 欠落 item は live presentation のみ。runtime seed state へは保持しない。
      if (code) {
        // 更新された観測点を末尾へ移し、上限到達時は最終更新が古い点から落とす。
        merged.delete(code);
        merged.set(code, item);
      }
    }
    const evictedCodes: string[] = [];
    while (merged.size > TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY) {
      const oldest = merged.keys().next().value as string | undefined;
      if (oldest == null) break;
      merged.delete(oldest);
      evictedCodes.push(oldest);
    }
    this.observationGroups[family] = structuredClone([...merged.values()]);
    return evictedCodes;
  }

  clearObservationFamily(family: TsunamiObservationFamily): void {
    this.observationGroups[family] = [];
  }

  restoreObservationGroups(groups: TsunamiObservationGroups): void {
    this.observationGroups = {
      VTSE51: structuredClone(groups.VTSE51.slice(-TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY)),
      VTSE52: structuredClone(groups.VTSE52.slice(-TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY)),
    };
  }

  restorePersistedState(
    active: ParsedTsunamiInfo | null,
    groups: TsunamiObservationGroups,
  ): void {
    this.restoreObservationGroups(groups);
    if (active == null) this.clearActiveState();
    else this.applyAccepted(structuredClone(active));
  }

  /** 共通 revision gate が受理した VTSE41 を active state へ反映する。 */
  applyAccepted(info: ParsedTsunamiInfo): void {
    const kinds = (info.forecast ?? []).map((f) => f.kind);
    const level = resolveTsunamiLevel(kinds)?.label ?? null;

    if (level == null) {
      this.clearActiveState();
      return;
    }

    this.currentLevel = level;
    this.lastInfo = info;
  }

  /** 共通 clearCurrent decision を active state へ反映する。watermark は registry が保持する。 */
  clearActive(): void {
    this.clearActiveState();
    this.observationGroups = emptyObservationGroups();
  }

  /** holder 全体を明示的にリセットする。 */
  clear(): void {
    this.clearActiveState();
    this.observationGroups = emptyObservationGroups();
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
