import * as log from "../../logger";
import * as perf from "../perf/receipt-timing";
import {
  TelegramRevisionGate,
  TELEGRAM_REVISION_MAX_ENTRIES,
  TELEGRAM_REVISION_MAX_SEMANTIC_KEYS,
  type TelegramRevisionGateSnapshot,
} from "../messages/telegram-revision-gate";
import {
  Vpws50StateHolder,
  type Vpws50StateSnapshot,
} from "../messages/vpws50-state";
import {
  Vpww56StateHolder,
  VPWW56_SNAPSHOT_GENERATION,
  type Vpww56StateSnapshot,
} from "../messages/vpww56-state";
import {
  TsunamiStateHolder,
  type TsunamiStateSnapshot,
} from "../messages/tsunami-state";
import {
  FloodForecastStateHolder,
  type FloodForecastStateSnapshot,
} from "../messages/flood-forecast-state";
import {
  VolcanoStateHolder,
  VOLCANO_MAX_SOURCE_EVENT_IDS_PER_COMPOSITE,
  emptyVolcanoRepairState,
  type VolcanoHolderSnapshot,
  type VolcanoRepairStateV1,
} from "../messages/volcano-state";
import {
  StandbyStateStore,
  type StandbyStateStoreSnapshot,
} from "./standby-state-store";
import {
  STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE,
  VOLCANO_PERSISTENCE_MAX_SUBTREE_BYTES_PER_FILE,
} from "./constants";
import { ALL_REVISION_FAMILY_POLICIES } from "../messages/revision-family-registry";
import {
  weatherAlertsFromVpws50,
  weatherAlertsFromVpww56,
} from "./weather-alert-view";
import type {
  PersistedStandbyStateV2,
  StandbyPersistence,
  StandbyPersistencePairMeasurement,
} from "./standby-persistence";

export type StandbyPersistenceOwnerKey =
  | "telegramRevisionGate"
  | "standbyStateStore"
  | "vpws50State"
  | "vpww56State"
  | "tsunamiState"
  | "volcanoHolderAndRepair"
  | "floodForecastState";

export interface StandbyPersistenceDomainSnapshots {
  telegramRevisionGate: TelegramRevisionGateSnapshot;
  standbyStateStore: StandbyStateStoreSnapshot;
  vpws50State: Vpws50StateSnapshot;
  vpww56State: Vpww56StateSnapshot;
  tsunamiState: TsunamiStateSnapshot;
  volcanoHolderAndRepair: {
    runtimeVersion: number;
    holder: VolcanoHolderSnapshot;
    repair: VolcanoRepairStateV1;
  };
  floodForecastState: FloodForecastStateSnapshot;
}

export interface StandbyPersistenceVersionToken {
  compositionVersion: number;
  ownerVersions: Record<StandbyPersistenceOwnerKey, number>;
}

export interface StandbyPersistenceAdmissionSnapshot {
  token: StandbyPersistenceVersionToken;
  domains: Readonly<StandbyPersistenceDomainSnapshots>;
}

export type StandbyDurableMutationKey =
  | "weather:VPWS50"
  | "weather:VPWW56"
  | "tsunami:VTSE41"
  | "tsunamiObservation:VTSE51"
  | "tsunamiObservation:VTSE52"
  | "volcano:volcanoAlert"
  | "volcano:volcanoEruption"
  | "volcano:volcanoAshfall"
  | "floodForecast:floodForecast"
  | "standby:tornado"
  | "standby:heatAlert"
  | "standby:typhoonAnalysis"
  | "typhoonProbability:VPTA50"
  | "weatherWarningTimeseries:VPWP50"
  | "standby:nankaiTrough"
  | "standby:lgObservation"
  | "standby:briefingCritical"
  | "standby:quakeHost";

export interface StandbyPersistenceCandidate {
  key: StandbyDurableMutationKey;
  base: StandbyPersistenceVersionToken;
  touchedOwners: readonly StandbyPersistenceOwnerKey[];
  domains: Readonly<StandbyPersistenceDomainSnapshots>;
  durableChanged: boolean;
}

export type StandbyCandidateReducer<T> = (
  draft: StandbyPersistenceDomainSnapshots,
) =>
  | { kind: "accepted"; value: T; durableChanged: boolean }
  | { kind: "rejected"; reason: string };

export type StandbyTransactionResult<T> =
  | { kind: "committed"; value: T; token: StandbyPersistenceVersionToken }
  | { kind: "rejected"; reason: string }
  | { kind: "staleVersion" };

export type StandbyDeferredTransactionResult<T> =
  | {
      kind: "committed";
      value: T;
      token: StandbyPersistenceVersionToken;
      durableChanged: boolean;
    }
  | { kind: "rejected"; reason: string }
  | { kind: "staleVersion" };

export type StandbyDeferredDurableMutationKey =
  | "typhoonProbability:VPTA50"
  | "weatherWarningTimeseries:VPWP50";

export interface AllDomainSweepResult {
  changedKeys: StandbyDurableMutationKey[];
  durableChanged: boolean;
}

export type PersistenceLogicalGeneration = string;

export interface StandbySerializationEnvelope {
  logicalGeneration: PersistenceLogicalGeneration;
  savedAt: string;
}

export interface StandbySerializedPair {
  v2: Uint8Array;
  v1: Uint8Array;
}

/**
 * envelope 適用**前**の中間表現 (spec
 * `docs/specs/2026-09-09-receipt-serialize-reduction.md` §3.1 A)。
 *
 * 実装ごとに形が違うので判別共用体にする。`prospectiveV2` が本番配線
 * (`standbyAdmissionSerializeSplit`)、`domains` が旧 `serializePair` dep から
 * 合成する互換 split。`encode` は自分が作った kind 以外を受けたら throw する
 * (coordinator は生涯 1 つの split しか使わないので、混ざるのは配線の誤り)。
 */
export type StandbyAdmissionSerializationBody =
  | { readonly kind: "prospectiveV2"; readonly v2: PersistedStandbyStateV2 }
  | { readonly kind: "domains"; readonly domains: Readonly<StandbyPersistenceDomainSnapshots> };

/**
 * `serializePair` を「中間表現を作る段 (`serIn`)」と「envelope を被せてバイト列にする段
 * (`serEnc`)」へ割ったもの。この dep を渡した coordinator だけが commit 後の body 再利用
 * (spec §3.1 A) を行う。
 */
export interface StandbyAdmissionSerializeSplit {
  build(domains: Readonly<StandbyPersistenceDomainSnapshots>): StandbyAdmissionSerializationBody;
  encode(
    body: StandbyAdmissionSerializationBody,
    envelope: StandbySerializationEnvelope,
  ): StandbySerializedPair;
}

export interface StandbyPersistenceAdmissionOwners {
  telegramRevisionGate: TelegramRevisionGate;
  standbyStateStore: StandbyStateStore;
  vpws50State: Vpws50StateHolder;
  vpww56State: Vpww56StateHolder;
  tsunamiState: TsunamiStateHolder;
  volcanoState: VolcanoStateHolder;
  floodForecastState: FloodForecastStateHolder;
}

export interface StandbyPersistenceAdmissionCoordinatorDeps {
  owners: StandbyPersistenceAdmissionOwners;
  repairState?: VolcanoRepairStateV1;
  serializePair?: (
    domains: Readonly<StandbyPersistenceDomainSnapshots>,
    envelope: StandbySerializationEnvelope,
  ) => StandbySerializedPair;
  /**
   * 2 段に割った serializer (spec §3.1 A)。**渡したときだけ** commit 後の body 再利用が
   * 効く。渡さない場合は `serializePair` から互換 split を合成し、
   * `captureSerializedPair` は従来どおり `capture()` + 全体 serialize を払う。
   */
  serializePairSplit?: StandbyAdmissionSerializeSplit;
  validateCandidate?: (
    domains: Readonly<StandbyPersistenceDomainSnapshots>,
    pair: Readonly<StandbySerializedPair>,
  ) => string | null;
  canReserveLogicalGeneration?: () => boolean;
  /**
   * テスト専用。`sweepAll` の事前判定 (spec §3.3) を無効化し、常に通常経路を通す
   * 参照実装として使う。差分テスト (spec §4.3) が事前判定あり / なしを突き合わせる。
   * 本番配線では設定しない。
   */
  disableSweepPrecheck?: boolean;
}

const OWNER_ORDER: readonly StandbyPersistenceOwnerKey[] = [
  "telegramRevisionGate",
  "standbyStateStore",
  "vpws50State",
  "vpww56State",
  "tsunamiState",
  "volcanoHolderAndRepair",
  "floodForecastState",
];

const GATE_STANDBY = ["telegramRevisionGate", "standbyStateStore"] as const;
const DURABLE_VOLCANO_GATE_PREFIXES = [
  "volcano:volcanoAlert:",
  "volcano:volcanoEruption:",
  "volcano:volcanoAshfall:",
] as const;

export const STANDBY_PERSISTED_FAMILY_DURABLE_KEYS: Readonly<
  Record<string, StandbyDurableMutationKey>
> = Object.freeze({
  "weather:VPWS50": "weather:VPWS50",
  "weather:VPWW56": "weather:VPWW56",
  "tsunami:VTSE41": "tsunami:VTSE41",
  "tsunamiObservation:VTSE51": "tsunamiObservation:VTSE51",
  "tsunamiObservation:VTSE52": "tsunamiObservation:VTSE52",
  "volcano:volcanoAlert": "volcano:volcanoAlert",
  "volcano:volcanoEruption": "volcano:volcanoEruption",
  "volcano:volcanoAshfall": "volcano:volcanoAshfall",
  "floodForecast:floodForecast": "floodForecast:floodForecast",
  "tornado:tornado": "standby:tornado",
  "heatAlert:VPFT50": "standby:heatAlert",
  "typhoonAnalysis:typhoonAnalysis": "standby:typhoonAnalysis",
  "typhoonProbability:VPTA50": "typhoonProbability:VPTA50",
  "weatherWarningTimeseries:VPWP50": "weatherWarningTimeseries:VPWP50",
  "nankaiTrough:nankaiTrough": "standby:nankaiTrough",
  "lgObservation:VXSE62": "standby:lgObservation",
});
const COORDINATED_SWEEP_FAMILIES = new Set(
  Object.keys(STANDBY_PERSISTED_FAMILY_DURABLE_KEYS),
);
const DEFERRED_DURABLE_KEYS = new Set<StandbyDurableMutationKey>([
  "typhoonProbability:VPTA50",
  "weatherWarningTimeseries:VPWP50",
]);
const EXPECTED_OWNERS: Record<StandbyDurableMutationKey, readonly StandbyPersistenceOwnerKey[]> = {
  "weather:VPWS50": ["telegramRevisionGate", "standbyStateStore", "vpws50State"],
  "weather:VPWW56": ["telegramRevisionGate", "standbyStateStore", "vpww56State"],
  "tsunami:VTSE41": ["telegramRevisionGate", "tsunamiState"],
  "tsunamiObservation:VTSE51": ["telegramRevisionGate", "tsunamiState"],
  "tsunamiObservation:VTSE52": ["telegramRevisionGate", "tsunamiState"],
  "volcano:volcanoAlert": ["telegramRevisionGate", "standbyStateStore", "volcanoHolderAndRepair"],
  "volcano:volcanoEruption": ["telegramRevisionGate", "standbyStateStore", "volcanoHolderAndRepair"],
  "volcano:volcanoAshfall": ["telegramRevisionGate", "standbyStateStore", "volcanoHolderAndRepair"],
  "floodForecast:floodForecast": ["telegramRevisionGate", "standbyStateStore", "floodForecastState"],
  "standby:tornado": GATE_STANDBY,
  "standby:heatAlert": GATE_STANDBY,
  "standby:typhoonAnalysis": GATE_STANDBY,
  "typhoonProbability:VPTA50": GATE_STANDBY,
  "weatherWarningTimeseries:VPWP50": GATE_STANDBY,
  "standby:nankaiTrough": GATE_STANDBY,
  "standby:lgObservation": GATE_STANDBY,
  "standby:briefingCritical": GATE_STANDBY,
  "standby:quakeHost": GATE_STANDBY,
};

const PREFLIGHT_ENVELOPE: StandbySerializationEnvelope = {
  logicalGeneration: "18446744073709551615",
  // Longest possible ECMAScript ISO representation occupies 27 code units.
  savedAt: "+275760-09-13T00:00:00.000Z",
};

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (child instanceof Map) return { $map: [...child] };
    if (child instanceof Set) return { $set: [...child] };
    return child;
  });
}

function assertLosslessOwnerSnapshot(
  owner: StandbyPersistenceOwnerKey,
  input: unknown,
  reconstructed: unknown,
): void {
  if (canonicalJson(input) !== canonicalJson(reconstructed)) {
    throw new Error(`${owner} owner snapshot is not lossless`);
  }
}

function defaultSerializePair(
  domains: Readonly<StandbyPersistenceDomainSnapshots>,
  envelope: StandbySerializationEnvelope,
): StandbySerializedPair {
  const encoder = new TextEncoder();
  const body = canonicalJson({ envelope, domains });
  return { v2: encoder.encode(body), v1: encoder.encode(body) };
}

function standbyAdmissionSerializationInput(
  domains: Readonly<StandbyPersistenceDomainSnapshots>,
): {
  projection: ReturnType<StandbyStateStore["exportActiveState"]>;
  foundation: Parameters<StandbyPersistence["serializeProspectivePair"]>[1];
} {
  const gate = TelegramRevisionGate.fromSnapshot(domains.telegramRevisionGate);
  assertLosslessOwnerSnapshot(
    "telegramRevisionGate",
    domains.telegramRevisionGate,
    gate.cloneSnapshot(),
  );
  if (domains.telegramRevisionGate.states.length > TELEGRAM_REVISION_MAX_ENTRIES
    || domains.telegramRevisionGate.states.some((entry) =>
      entry.semanticKeys.length > TELEGRAM_REVISION_MAX_SEMANTIC_KEYS
      || new Set(entry.semanticKeys).size !== entry.semanticKeys.length)) {
    throw new Error("telegram revision gate writer invariant failed");
  }
  const durableEntries = gate.exportDurableEntries();
  const standby = StandbyStateStore.fromSnapshot(domains.standbyStateStore);
  standby.snapshotItems();
  assertLosslessOwnerSnapshot(
    "standbyStateStore",
    domains.standbyStateStore,
    standby.cloneSnapshot(),
  );
  const projection = standby.exportActiveState();
  const vpws50 = Vpws50StateHolder.fromSnapshot(domains.vpws50State);
  assertLosslessOwnerSnapshot("vpws50State", domains.vpws50State, vpws50.cloneSnapshot());
  const vpww56 = Vpww56StateHolder.fromSnapshot(domains.vpww56State);
  assertLosslessOwnerSnapshot("vpww56State", domains.vpww56State, vpww56.cloneSnapshot());
  const tsunami = TsunamiStateHolder.fromSnapshot(domains.tsunamiState);
  assertLosslessOwnerSnapshot("tsunamiState", domains.tsunamiState, tsunami.cloneSnapshot());
  const volcano = VolcanoStateHolder.fromSnapshot(
    domains.volcanoHolderAndRepair.holder,
  );
  const volcanoCompositeCodes = domains.volcanoHolderAndRepair.holder.composites
    .map((entry) => entry.volcanoCode);
  const volcanoRestoredCodes = domains.volcanoHolderAndRepair.holder.restored
    .map((entry) => entry.volcanoCode);
  const legacyEruptionCodes = domains.volcanoHolderAndRepair.holder.legacyEruptionIdentities
    .map((entry) => entry.volcanoCode);
  const volcanoCompositeCodeSet = new Set(volcanoCompositeCodes);
  const volcanoRestoredCodeSet = new Set(volcanoRestoredCodes);
  if (new Set(volcanoCompositeCodes).size !== volcanoCompositeCodes.length
    || new Set(volcanoRestoredCodes).size !== volcanoRestoredCodes.length
    || new Set(legacyEruptionCodes).size !== legacyEruptionCodes.length
    || volcanoCompositeCodeSet.size !== volcanoRestoredCodeSet.size
    || [...volcanoCompositeCodeSet].some((code) => !volcanoRestoredCodeSet.has(code))
    || domains.volcanoHolderAndRepair.holder.composites.some((entry) =>
      entry.sourceEventIds.length > VOLCANO_MAX_SOURCE_EVENT_IDS_PER_COMPOSITE
      || new Set(entry.sourceEventIds).size !== entry.sourceEventIds.length)) {
    throw new Error("volcanoHolderAndRepair owner snapshot is not lossless");
  }
  const floodForecast = FloodForecastStateHolder.fromSnapshot(domains.floodForecastState);
  assertLosslessOwnerSnapshot(
    "floodForecastState",
    domains.floodForecastState,
    floodForecast.cloneSnapshot(),
  );
  const canonicalStandby = StandbyStateStore.fromSnapshot(domains.standbyStateStore);
  canonicalStandby.replaceVolcanoDerived(domains.volcanoHolderAndRepair.holder);
  if (canonicalJson(projection.volcanoes)
    !== canonicalJson(canonicalStandby.exportActiveState().volcanoes)) {
    throw new Error("standby volcano mirror coupling mismatch");
  }
  const persistedDurableEntries = durableEntries.filter((entry) =>
    Object.hasOwn(
      STANDBY_PERSISTED_FAMILY_DURABLE_KEYS,
      `${entry.domain}:${entry.revisionFamily}`,
    ));
  if (persistedDurableEntries.length !== durableEntries.length) {
    throw new Error("unmapped durable revision gate entry");
  }
  return { projection, foundation: {
    vpws50: {
      authoritative: true,
      state: vpws50.exportPersistedState(),
      gateEntries: durableEntries.filter((entry) => entry.domain === "weather"
        && entry.revisionFamily === "VPWS50"),
    },
    vpww56: {
      generation: VPWW56_SNAPSHOT_GENERATION,
      authoritative: true,
      state: vpww56.exportPersistedState(),
      gateEntries: durableEntries.filter((entry) => entry.domain === "weather"
        && entry.revisionFamily === "VPWW56"),
    },
    tsunami: {
      keyedActive: tsunami.getPersistedKeyedActive(),
      legacyActive: tsunami.getPersistedLegacyActive(),
      observations: tsunami.getObservationGroups(),
      gateEntries: durableEntries.filter((entry) =>
        entry.domain === "tsunami" && entry.revisionFamily === "VTSE41"
        || entry.domain === "tsunamiObservation"
          && (entry.revisionFamily === "VTSE51" || entry.revisionFamily === "VTSE52")),
    },
    volcano: {
      authoritative: true,
      ashfallSchemaGeneration: 1,
      repairState: structuredClone(domains.volcanoHolderAndRepair.repair),
      state: volcano.exportPersistedState(),
      // Canonical state is the only source. normalizeVolcanoFoundationForWrite
      // derives every rollback mirror from it.
      active: [],
      gateEntries: durableEntries.filter((entry) => entry.domain === "volcano"
        && (entry.revisionFamily === "volcanoAlert"
          || entry.revisionFamily === "volcanoEruption"
          || entry.revisionFamily === "volcanoAshfall")),
    },
    floodForecast: {
      authoritative: true,
      active: projection.floods?.events ?? [],
      legacyEventIds: standby.floodLegacyEventIds(),
      gateEntries: durableEntries.filter((entry) => entry.domain === "floodForecast"
        && entry.revisionFamily === "floodForecast"),
    },
    standbyDomains: {
      gateEntries: durableEntries.filter((entry) =>
        ["tornado", "heatAlert", "typhoonAnalysis", "typhoonProbability",
          "nankaiTrough", "lgObservation", "weatherWarningTimeseries"]
          .includes(entry.domain)),
    },
  } };
}

/**
 * Exact production pair serializer shared by monitor wiring and boundary
 * tests. It derives every rollback mirror from one coordinator capture and
 * runs completed-card wire validation before persistence serialization.
 */
export function serializeStandbyAdmissionPair(
  persistence: Pick<StandbyPersistence, "serializeProspectivePair">,
  domains: Readonly<StandbyPersistenceDomainSnapshots>,
  envelope: StandbySerializationEnvelope,
): StandbySerializedPair {
  const input = standbyAdmissionSerializationInput(domains);
  return persistence.serializeProspectivePair(input.projection, input.foundation, envelope);
}

/**
 * `serializeStandbyAdmissionPair` を 2 段へ割った本番配線 (spec §3.1 A)。
 * `build` + `encode` の合成は `serializeStandbyAdmissionPair` とバイト列が一致する
 * — 同じ `standbyAdmissionSerializationInput` を通し、`encodeProspectivePair` が
 * 分割前と同じ spread 順序・同じ上限検査を踏むため。
 */
export function standbyAdmissionSerializeSplit(
  persistence: Pick<StandbyPersistence, "buildProspectiveV2" | "encodeProspectivePair">,
): StandbyAdmissionSerializeSplit {
  return {
    build: (domains) => {
      const input = standbyAdmissionSerializationInput(domains);
      return {
        kind: "prospectiveV2",
        v2: persistence.buildProspectiveV2(input.projection, input.foundation),
      };
    },
    encode: (body, envelope) => {
      if (body.kind !== "prospectiveV2") {
        throw new Error("standby admission serialization body kind mismatch");
      }
      return persistence.encodeProspectivePair(body.v2, envelope);
    },
  };
}

/** Exact byte measurement for valid candidates, including rejected maxima. */
export function measureStandbyAdmissionPair(
  persistence: Pick<StandbyPersistence, "measureProspectivePair">,
  domains: Readonly<StandbyPersistenceDomainSnapshots>,
  envelope: StandbySerializationEnvelope,
): StandbyPersistencePairMeasurement {
  const input = standbyAdmissionSerializationInput(domains);
  return persistence.measureProspectivePair(input.projection, input.foundation, envelope);
}

function tokenEquals(
  left: StandbyPersistenceVersionToken,
  right: StandbyPersistenceVersionToken,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameOwnerList(
  supplied: readonly StandbyPersistenceOwnerKey[],
  expected: readonly StandbyPersistenceOwnerKey[],
): boolean {
  return supplied.length === expected.length
    && supplied.every((owner, index) => owner === expected[index]);
}

function changedOwnerKeys(
  base: StandbyPersistenceDomainSnapshots,
  draft: StandbyPersistenceDomainSnapshots,
): StandbyPersistenceOwnerKey[] {
  return OWNER_ORDER.filter((owner) => canonicalJson(base[owner]) !== canonicalJson(draft[owner]));
}

/**
 * `sweepAll` 専用の owner 変更検出 (spec §3.4.2)。base の全文を作らずに、capture 時の
 * owner version と draft snapshot の version を突き合わせる。正しさは段階 1 の
 * 双方向不変条件 (保存状態が変わったなら version は必ず進み、変わらなければ進まない) に
 * 依存する。`transactInternal` は分岐 5-A により全文比較 (`changedOwnerKeys`) のまま。
 *
 * `Record<StandbyPersistenceOwnerKey, number>` にしてあるので、owner が増えたら
 * ここがコンパイルエラーになる (取りこぼしを型で防ぐ)。
 */
function draftOwnerVersions(
  draft: StandbyPersistenceDomainSnapshots,
): Record<StandbyPersistenceOwnerKey, number> {
  return {
    telegramRevisionGate: draft.telegramRevisionGate.version,
    standbyStateStore: draft.standbyStateStore.version,
    vpws50State: draft.vpws50State.version,
    vpww56State: draft.vpww56State.version,
    tsunamiState: draft.tsunamiState.version,
    // volcano は holder の version ではなく coordinator の runtimeVersion が権威
    // (`capture()` :522 / `commit()` :670 と同じ値を見る)。
    volcanoHolderAndRepair: draft.volcanoHolderAndRepair.runtimeVersion,
    floodForecastState: draft.floodForecastState.version,
  };
}

function changedOwnerKeysByVersion(
  token: StandbyPersistenceVersionToken,
  draft: StandbyPersistenceDomainSnapshots,
): StandbyPersistenceOwnerKey[] {
  const draftVersions = draftOwnerVersions(draft);
  return OWNER_ORDER.filter((owner) => token.ownerVersions[owner] !== draftVersions[owner]);
}

/** owner snapshot から version カウンタを落とす (strict モードの ground truth 用)。 */
function withoutVersion<T extends { version: number }>(snapshot: T): Omit<T, "version"> {
  const { version: _version, ...payload } = snapshot;
  return payload;
}

/**
 * strict モードの ground truth (spec §3.4.3)。**version カウンタを含めない** payload だけを
 * owner ごとに canonical 比較する。`changedOwnerKeys` の全文比較は snapshot の `version` を
 * 含むので「version が動いた ⟹ 全文も動く」が恒真になり、過剰 bump を素通りさせる。
 *
 * **volcano の `runtimeVersion` だけは落とさない。** これは owner 内部の派生カウンタではなく
 * coordinator の外へ観測される値で、`VolcanoTransactionCoordinator` の楽観ロックが
 * `expectedRuntimeVersion` として突き合わせ (`src/engine/messages/volcano-transaction-coordinator.ts:220,242,261`)、
 * `monitor.ts:218,256` が repair ログに出す。`standby-persistence.ts` は参照しないので
 * pair serializer には届かない。
 * `sweepAll` は gate が volcano family を期限切れにしただけのとき (`volcanoGateChanged`)
 * holder / repair が不変でも `runtimeVersion` を進める。従来の全文比較もこれを変更と
 * 見て volcano owner を commit していたので、落とすと既存契約を壊す
 * (実測: `standby-wiring.test.ts` の volcanoAlert / volcanoEruption / volcanoAshfall /
 * 31 日 active の 4 test が `version=[telegramRevisionGate,volcanoHolderAndRepair]`
 * `payload=[telegramRevisionGate]` で落ちる)。holder 内部の `version` だけ落とす。
 * その代償として volcano の過剰 bump は strict では捕まらない。
 */
function changedOwnerPayloadKeys(
  base: StandbyPersistenceDomainSnapshots,
  draft: StandbyPersistenceDomainSnapshots,
): StandbyPersistenceOwnerKey[] {
  const payloads = (
    domains: StandbyPersistenceDomainSnapshots,
  ): Record<StandbyPersistenceOwnerKey, string> => ({
    telegramRevisionGate: canonicalJson(withoutVersion(domains.telegramRevisionGate)),
    standbyStateStore: canonicalJson(withoutVersion(domains.standbyStateStore)),
    vpws50State: canonicalJson(withoutVersion(domains.vpws50State)),
    vpww56State: canonicalJson(withoutVersion(domains.vpww56State)),
    tsunamiState: canonicalJson(withoutVersion(domains.tsunamiState)),
    volcanoHolderAndRepair: canonicalJson({
      runtimeVersion: domains.volcanoHolderAndRepair.runtimeVersion,
      holder: withoutVersion(domains.volcanoHolderAndRepair.holder),
      repair: domains.volcanoHolderAndRepair.repair,
    }),
    floodForecastState: canonicalJson(withoutVersion(domains.floodForecastState)),
  });
  const basePayloads = payloads(base);
  const draftPayloads = payloads(draft);
  return OWNER_ORDER.filter((owner) => basePayloads[owner] !== draftPayloads[owner]);
}

/**
 * テスト専用の検証モード (spec §3.4.3)。on のとき `sweepAll` は version 比較の結果を
 * version 抜き payload の比較と突き合わせ、不一致なら throw する。既定 off。
 * 環境変数 `FLEQ_STANDBY_SWEEP_STRICT=1` でも有効になる (テストスイート全体を
 * strict で 1 度回すため)。
 */
let strictSweepOwnerDiff = process.env.FLEQ_STANDBY_SWEEP_STRICT === "1";

/** テスト専用。strict モードを切り替え、直前の値を返す (finally で必ず戻すこと)。 */
export function __test_setStandbySweepStrictOwnerDiff(enabled: boolean): boolean {
  const previous = strictSweepOwnerDiff;
  strictSweepOwnerDiff = enabled;
  return previous;
}

/**
 * commit 後の body 再利用 (spec §3.1 A)。既定 on。
 *
 * 受入 A1 は「再利用が効いた経路」と「フォールバックした経路」の**両方**でバイト列を
 * 比べるので、テストから off にできないと後者を安定して作れない。
 */
let standbyBodyReuseEnabled = true;

/** テスト専用。body 再利用を切り替え、直前の値を返す (finally で必ず戻すこと)。 */
export function __test_setStandbyBodyReuseEnabled(enabled: boolean): boolean {
  const previous = standbyBodyReuseEnabled;
  standbyBodyReuseEnabled = enabled;
  return previous;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function pairEqual(left: StandbySerializedPair, right: StandbySerializedPair): boolean {
  return bytesEqual(left.v2, right.v2) && bytesEqual(left.v1, right.v1);
}

export class StandbyPersistenceAdmissionCoordinator {
  private readonly owners: StandbyPersistenceAdmissionOwners;
  private readonly serializePair: NonNullable<StandbyPersistenceAdmissionCoordinatorDeps["serializePair"]>;
  private readonly validateCandidate?: StandbyPersistenceAdmissionCoordinatorDeps["validateCandidate"];
  private readonly canReserveLogicalGeneration: () => boolean;
  private repairState: VolcanoRepairStateV1;
  private volcanoRuntimeVersion: number;
  private compositionVersion = 0;
  private readonly durableCallbacks: Array<() => void> = [];
  private readonly sweepPrecheckEnabled: boolean;
  /** `serIn` 区間。domains から envelope 適用前の中間表現を組み立てる。 */
  private readonly buildSerializationBody: (
    domains: Readonly<StandbyPersistenceDomainSnapshots>,
  ) => StandbyAdmissionSerializationBody;
  /** `serEnc` 区間。中間表現に envelope を被せてバイト列にする。 */
  private readonly encodeSerializationBody: (
    body: StandbyAdmissionSerializationBody,
    envelope: StandbySerializationEnvelope,
  ) => StandbySerializedPair;
  /** `serializePairSplit` dep が渡されたときだけ body 再利用を許す (spec §3.1 A)。 */
  private readonly bodyReuseSupported: boolean;
  /**
   * 直近の commit が確定させた「現在の保存状態と等価な中間表現」。**1 世代だけ**持つ。
   *
   * commit に到達しなかった transact では更新しない。無効化は `token` 判定に一本化する
   * (`restorePrevalidated` / `rollback` / `sweepAll` の commit はすべて owner version か
   * `compositionVersion` を進めるので、古い body は必ずミスする)。無効化点を列挙する
   * 方式は漏れるが、token は漏れない (spec §3.1 A)。
   *
   * **A の正しさは「coordinator を経由せずに holder を変異させる経路が無い」配線に
   * 依存する。** `currentToken()` の volcano 成分は holder の `version()` ではなく
   * coordinator 自身の `volcanoRuntimeVersion` なので、その経路ができると token に
   * 現れない (spec §3.1 A の注記)。
   *
   * **memory**: v2 body 1 世代ぶんが次の commit まで常駐する (Pi では約 1.4MB)。
   * 分割前は `serD` の直後から GC 対象だった。Pi は `--optimize-for-size` 運用なので、
   * 常駐 heap の増分は §4.8 の Pi 観測項目で採る。1 世代しか持たないので上限は body 1 つ。
   */
  private reusableBody: {
    token: StandbyPersistenceVersionToken;
    body: StandbyAdmissionSerializationBody;
  } | null = null;
  /**
   * 直近の「何も変えなかった sweep」。ここに記録があるときだけ事前判定が働く。
   *
   * commit した sweep では**記録しない**。変更を起こした周期の次は必ず通常経路を通し、
   * 収束 (同じ入力・同じ時計で二度目が no-op になること) をその場で確かめてから
   * skip を再開する。これにより事前判定の健全性が「収束済み状態が時計前進だけでは
   * 変わらない」という弱い前提だけに依存する (spec §2.6 / §3.3)。
   */
  private lastNoopSweep: { atMs: number; token: StandbyPersistenceVersionToken } | null = null;

  constructor(deps: StandbyPersistenceAdmissionCoordinatorDeps) {
    this.owners = deps.owners;
    this.repairState = structuredClone(deps.repairState ?? emptyVolcanoRepairState());
    this.volcanoRuntimeVersion = deps.owners.volcanoState.version();
    const serializePair = deps.serializePair ?? defaultSerializePair;
    // spec §3.1 A / M2: serializer を 2 段に割り、`serIn` / `serEnc` の内訳を採る。
    // split dep が無いときは旧 `serializePair` から互換 split を合成する
    // (`build` は素通し、`encode` が全部やる)。この形では body 再利用を行わない —
    // 旧 dep は「domains 1 つ + envelope 1 つ」しか受けないので、再利用しても
    // `serIn` 相当を省けず、deps 差し替えの計数と `serCalls` がずれるだけになる。
    const split: StandbyAdmissionSerializeSplit = deps.serializePairSplit ?? {
      build: (domains) => ({ kind: "domains", domains }),
      encode: (body, envelope) => {
        if (body.kind !== "domains") {
          throw new Error("standby admission serialization body kind mismatch");
        }
        // 元の呼び出しは `this.serializePair(...)` で `this` が coordinator に
        // 束縛されていた。ラッパで bare call にすると `this` が undefined へ変わるので、
        // `call` で復元する。
        return serializePair.call(this, body.domains, envelope);
      },
    };
    this.bodyReuseSupported = deps.serializePairSplit != null;
    this.buildSerializationBody = (domains) => perf.mark("serIn", () => split.build(domains));
    this.encodeSerializationBody = (body, envelope) =>
      perf.mark("serEnc", () => split.encode(body, envelope));
    // 計測 spec §3.3 P4: `serializePair` の呼び出し点を 1 箇所で数える。
    // `serializeStandbyAdmissionPair` ではなくここを包むのは、既定の
    // `defaultSerializePair` が別実装で、テストではそちらしか動かないため (spec §2.3)。
    //
    // **削減 spec 段階 1 以降、この計数の意味は「body を build した回数」である。**
    // 再利用が効いた `save` は `encodeSerializationBody` だけを呼ぶので、
    // 1.4MB の `JSON.stringify` を 2 本実走しても `serCalls` には出ない
    // (計測ログ spec §4.3.1 の定義変更)。
    this.serializePair = (domains, envelope) => {
      perf.countSerializePair();
      return this.encodeSerializationBody(this.buildSerializationBody(domains), envelope);
    };
    this.validateCandidate = deps.validateCandidate;
    this.canReserveLogicalGeneration = deps.canReserveLogicalGeneration ?? (() => true);
    this.sweepPrecheckEnabled = deps.disableSweepPrecheck !== true;
  }

  onDurable(callback: () => void): void {
    this.durableCallbacks.push(callback);
  }

  private currentToken(): StandbyPersistenceVersionToken {
    return {
      compositionVersion: this.compositionVersion,
      ownerVersions: {
        telegramRevisionGate: this.owners.telegramRevisionGate.version(),
        standbyStateStore: this.owners.standbyStateStore.version(),
        vpws50State: this.owners.vpws50State.version(),
        vpww56State: this.owners.vpww56State.version(),
        tsunamiState: this.owners.tsunamiState.version(),
        volcanoHolderAndRepair: this.volcanoRuntimeVersion,
        floodForecastState: this.owners.floodForecastState.version(),
      },
    };
  }

  /**
   * `capture()` の実体。各 owner の `cloneSnapshot()` / `snapshot()` は複製を返すので、
   * ここで作った `domains` は呼び出し側が自由に書き換えてよい (実 owner へ波及しない)。
   * 公開 API の `capture()` は `Readonly<...>` へ狭めて返し、書き換えたい経路
   * (`sweepAll` の draft / base) だけがこちらを使う。`as` で Readonly を剥がさない。
   */
  private captureMutable(): {
    token: StandbyPersistenceVersionToken;
    domains: StandbyPersistenceDomainSnapshots;
  } {
    const domains: StandbyPersistenceDomainSnapshots = {
      telegramRevisionGate: this.owners.telegramRevisionGate.cloneSnapshot(),
      standbyStateStore: this.owners.standbyStateStore.cloneSnapshot(),
      vpws50State: this.owners.vpws50State.cloneSnapshot(),
      vpww56State: this.owners.vpww56State.cloneSnapshot(),
      tsunamiState: this.owners.tsunamiState.cloneSnapshot(),
      volcanoHolderAndRepair: {
        runtimeVersion: this.volcanoRuntimeVersion,
        holder: this.owners.volcanoState.snapshot(),
        repair: structuredClone(this.repairState),
      },
      floodForecastState: this.owners.floodForecastState.cloneSnapshot(),
    };
    return { token: this.currentToken(), domains };
  }

  capture(): StandbyPersistenceAdmissionSnapshot {
    return this.captureMutable();
  }

  transact<T>(
    key: StandbyDurableMutationKey,
    touchedOwners: readonly StandbyPersistenceOwnerKey[],
    reduce: StandbyCandidateReducer<T>,
  ): StandbyTransactionResult<T> {
    const result = this.transactInternal(key, touchedOwners, reduce, false);
    if (result.kind !== "committed") return result;
    return { kind: "committed", value: result.value, token: result.token };
  }

  /**
   * VPTA50 and VPWP50 retain their typed completion/save-coalescing contracts.
   * This still performs the same global candidate preflight and atomic owner
   * replacement, but the caller must dispatch persistence after the returned
   * commit instead of receiving the coordinator's ordinary durable callback.
   */
  transactDeferred<T>(
    key: StandbyDeferredDurableMutationKey,
    touchedOwners: readonly StandbyPersistenceOwnerKey[],
    reduce: StandbyCandidateReducer<T>,
  ): StandbyDeferredTransactionResult<T> {
    if (!DEFERRED_DURABLE_KEYS.has(key)) {
      return { kind: "rejected", reason: "invalidDeferredDurableKey" };
    }
    return this.transactInternal(key, touchedOwners, reduce, true);
  }

  /**
   * spec §3.3 P3i: `admit=` は出口 1 箇所で決める。`transactInternalCore` は早期 return を
   * 8 本持つので (:675 :683 :685 :688 :702 :709 :712 :714)、各 return に散らすと取りこぼす。
   */
  private transactInternal<T>(
    key: StandbyDurableMutationKey,
    touchedOwners: readonly StandbyPersistenceOwnerKey[],
    reduce: StandbyCandidateReducer<T>,
    deferDurable: boolean,
  ): StandbyDeferredTransactionResult<T> {
    const result = this.transactInternalCore(key, touchedOwners, reduce, deferDurable);
    if (result.kind === "rejected") perf.setAdmissionResult("rejected", result.reason);
    else perf.setAdmissionResult(result.kind);
    return result;
  }

  private transactInternalCore<T>(
    key: StandbyDurableMutationKey,
    touchedOwners: readonly StandbyPersistenceOwnerKey[],
    reduce: StandbyCandidateReducer<T>,
    deferDurable: boolean,
  ): StandbyDeferredTransactionResult<T> {
    const expected = EXPECTED_OWNERS[key];
    if (!sameOwnerList(touchedOwners, expected)) {
      return { kind: "rejected", reason: "invalidTouchedOwners" };
    }
    const captured = perf.mark("cap", () => this.capture());
    const draft = perf.mark(
      "draft",
      () => structuredClone(captured.domains),
    ) as StandbyPersistenceDomainSnapshots;
    let reduced: ReturnType<StandbyCandidateReducer<T>>;
    try {
      reduced = perf.mark("red", () => reduce(draft));
    } catch {
      return { kind: "rejected", reason: "reducerException" };
    }
    if (reduced.kind === "rejected") return reduced;
    const changed = perf.mark(
      "diff",
      () => changedOwnerKeys(captured.domains as StandbyPersistenceDomainSnapshots, draft),
    );
    if (changed.some((owner) => !expected.includes(owner))) {
      return { kind: "rejected", reason: "unexpectedOwnerMutation" };
    }
    if (changed.length === 0) {
      // spec §3.1 C: 全 owner が canonical 同一なので commit も durable 変化も起きない。
      // `serD` / `serB` / `pre` を払わずに committed を返す。
      //
      // **消えるのは「検出」であって「状態」ではない。** base が既に壊れていた場合、
      // 現行は何も変えないこの電文が `rejected` で通報していた。C 後は通報しない
      // (実際に違反を捕まえるのは「次に何かを変える transact」だけ)。strict では
      // 従来どおり serialize して検査し、壊れた base を throw で露出させる。
      if (strictSweepOwnerDiff) {
        this.assertNoopTransactSerialization(
          captured.domains as StandbyPersistenceDomainSnapshots,
          draft,
        );
      }
      // `:743` の契約を必ず残す。VPTA50 / VPWP50 の `transactDeferred` がここに乗る。
      if (deferDurable && reduced.durableChanged !== false) {
        return { kind: "rejected", reason: "deferredDurabilityMismatch" };
      }
      if (!tokenEquals(captured.token, this.currentToken())) return { kind: "staleVersion" };
      return {
        kind: "committed",
        value: reduced.value,
        token: this.currentToken(),
        durableChanged: false,
      };
    }
    let candidateBody: StandbyAdmissionSerializationBody | null = null;
    let candidatePair: StandbySerializedPair;
    let basePair: StandbySerializedPair;
    let admissionFailure: string | null;
    try {
      // body は commit 後の 3 回目 serialize (`save`) で再利用する (spec §3.1 A)。
      const built = perf.mark("serD", () => {
        perf.countSerializePair();
        const body = this.buildSerializationBody(draft);
        return { body, pair: this.encodeSerializationBody(body, PREFLIGHT_ENVELOPE) };
      });
      candidateBody = built.body;
      candidatePair = built.pair;
      basePair = perf.mark(
        "serB",
        () => this.serializePair(captured.domains, PREFLIGHT_ENVELOPE),
      );
      admissionFailure = perf.mark("pre", () => this.preflight(draft, candidatePair));
    } catch {
      admissionFailure = "candidateSerializationFailed";
      candidateBody = null;
      candidatePair = { v2: new Uint8Array(), v1: new Uint8Array() };
      basePair = candidatePair;
    }
    if (admissionFailure != null) return { kind: "rejected", reason: admissionFailure };
    // Reducers report whether they expect a durable mutation, but the exact
    // pair serializer is the authority.  This keeps transient gate cleanup
    // committable at generation exhaustion while preventing a missed callback
    // when a reducer under-reports a persisted change.
    const durableChanged = changed.length > 0 && !pairEqual(basePair, candidatePair);
    if (deferDurable && reduced.durableChanged !== durableChanged) {
      return { kind: "rejected", reason: "deferredDurabilityMismatch" };
    }
    if (durableChanged && !this.canReserveLogicalGeneration()) {
      return { kind: "rejected", reason: "logicalGenerationExhausted" };
    }
    if (!tokenEquals(captured.token, this.currentToken())) return { kind: "staleVersion" };
    if (changed.length > 0) perf.mark("commit", () => this.commit(draft, changed));
    const token = this.currentToken();
    // spec §3.1 A: commit 直後の保存状態は draft と等価 (`replacePrevalidated` →
    // `cloneSnapshot` の往復性。実行時の担保は `assertLosslessOwnerSnapshot`)。
    // この token のまま `captureSerializedPair` が呼ばれたら body をそのまま encode する。
    if (this.bodyReuseSupported && candidateBody !== null) {
      this.reusableBody = { token, body: candidateBody };
    }
    if (durableChanged && !deferDurable) this.emitDurable();
    return { kind: "committed", value: reduced.value, token, durableChanged };
  }

  /**
   * spec §3.1 C の strict 経路。`changed.length === 0` の transact でも従来どおり
   * serialize と `preflight` を走らせ、**壊れた base を throw で露出させる**。
   *
   * 既定 off の C が「検出を 1 本閉じる」代わりに、strict 便 (CI 恒久) では検出能力を
   * 残す。ここが空回りでないことは受入 A8 が壊した base fixture で確かめる。
   *
   * **実効的な検出は 2 本だけ**である: serializer が投げる不変条件群
   * (`candidateSerializationFailed` 系) と `preflight` の失敗。
   * `pairEqual(basePair, candidatePair)` は**恒真**なので検査しない —
   * `changedOwnerKeys` が全 owner の canonical 全文一致を確かめた後にここへ来るうえ、
   * `serializePair` は domains と envelope の純関数なので、両者は必ず同じバイト列になる。
   */
  private assertNoopTransactSerialization(
    base: StandbyPersistenceDomainSnapshots,
    draft: StandbyPersistenceDomainSnapshots,
  ): void {
    let failure: string | null;
    try {
      const candidatePair = perf.mark(
        "serD",
        () => this.serializePair(draft, PREFLIGHT_ENVELOPE),
      );
      perf.mark("serB", () => this.serializePair(base, PREFLIGHT_ENVELOPE));
      failure = perf.mark("pre", () => this.preflight(draft, candidatePair));
    } catch (error) {
      throw new Error(
        "standby admission strict no-op check failed: candidateSerializationFailed"
        + ` (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (failure != null) {
      throw new Error(`standby admission strict no-op check failed: ${failure}`);
    }
  }

  private preflight(
    domains: StandbyPersistenceDomainSnapshots,
    serializedPair?: StandbySerializedPair,
  ): string | null {
    const volcanoes = domains.volcanoHolderAndRepair.holder.composites;
    if (volcanoes.length > 128) return "volcanoCompositeCapacityExceeded";
    if (volcanoes.some((entry) =>
      entry.sourceEventIds.length > VOLCANO_MAX_SOURCE_EVENT_IDS_PER_COMPOSITE)) {
      return "volcanoSourceCapacityExceeded";
    }
    const gateCounts = new Map<string, number>();
    for (const entry of domains.telegramRevisionGate.states) {
      if (!entry.key.startsWith("volcano:")) continue;
      const family = entry.key.split(":")[1] ?? "";
      gateCounts.set(family, (gateCounts.get(family) ?? 0) + 1);
    }
    if (["volcanoAlert", "volcanoEruption", "volcanoAshfall"]
      .some((family) => (gateCounts.get(family) ?? 0) > 128)) return "volcanoFamilyCapacityExceeded";
    const pair = serializedPair ?? this.serializePair(domains, PREFLIGHT_ENVELOPE);
    if (pair.v2.byteLength > STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE) return "v2FileBytesExceeded";
    if (pair.v1.byteLength > STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE) return "v1FileBytesExceeded";
    const volcanoBytes = new TextEncoder().encode(canonicalJson({
      state: domains.volcanoHolderAndRepair.holder.composites,
      repair: domains.volcanoHolderAndRepair.repair,
      gates: domains.telegramRevisionGate.states.filter((entry) =>
        DURABLE_VOLCANO_GATE_PREFIXES.some((prefix) => entry.key.startsWith(prefix))),
    })).byteLength;
    if (volcanoBytes > VOLCANO_PERSISTENCE_MAX_SUBTREE_BYTES_PER_FILE) {
      return "volcanoSubtreeBytesExceeded";
    }
    return this.validateCandidate?.(domains, pair) ?? null;
  }

  private commit(
    domains: StandbyPersistenceDomainSnapshots,
    changed: readonly StandbyPersistenceOwnerKey[],
  ): void {
    for (const owner of OWNER_ORDER) {
      if (!changed.includes(owner)) continue;
      switch (owner) {
        case "telegramRevisionGate":
          this.owners.telegramRevisionGate.replacePrevalidated(domains.telegramRevisionGate);
          break;
        case "standbyStateStore":
          this.owners.standbyStateStore.replacePrevalidated(domains.standbyStateStore);
          break;
        case "vpws50State":
          this.owners.vpws50State.replacePrevalidated(domains.vpws50State);
          break;
        case "vpww56State":
          this.owners.vpww56State.replacePrevalidated(domains.vpww56State);
          break;
        case "tsunamiState":
          this.owners.tsunamiState.replacePrevalidated(domains.tsunamiState);
          break;
        case "volcanoHolderAndRepair":
          this.owners.volcanoState.replacePrevalidated(domains.volcanoHolderAndRepair.holder);
          this.repairState = structuredClone(domains.volcanoHolderAndRepair.repair);
          this.volcanoRuntimeVersion += 1;
          break;
        case "floodForecastState":
          this.owners.floodForecastState.replacePrevalidated(domains.floodForecastState);
          break;
      }
    }
    this.compositionVersion += 1;
  }

  private emitDurable(): void {
    for (const callback of this.durableCallbacks) {
      try {
        callback();
      } catch (error) {
        log.warn(`[standby-admission] durable callback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  restorePrevalidated(domains: StandbyPersistenceDomainSnapshots): void {
    this.owners.telegramRevisionGate.replacePrevalidated(domains.telegramRevisionGate);
    this.owners.standbyStateStore.replacePrevalidated(domains.standbyStateStore);
    this.owners.vpws50State.replacePrevalidated(domains.vpws50State);
    this.owners.vpww56State.replacePrevalidated(domains.vpww56State);
    this.owners.tsunamiState.replacePrevalidated(domains.tsunamiState);
    this.owners.volcanoState.replacePrevalidated(domains.volcanoHolderAndRepair.holder);
    this.repairState = structuredClone(domains.volcanoHolderAndRepair.repair);
    this.owners.floodForecastState.replacePrevalidated(domains.floodForecastState);
    this.volcanoRuntimeVersion += 1;
    this.compositionVersion += 1;
  }

  /**
   * どの owner にも「今回やるべき仕事」が無いか。JSON も clone も使わない O(entries) の
   * 述語を owner ごとに評価する (spec §3.3 分岐 1-A: キャッシュしない)。
   *
   * gate の active subject 集合に追従するだけの holder (vpws50 / vpww56 / tsunami) は
   * 自前の時計駆動 sweep を持たない。その追従は gate の owner version 前進として
   * 判定 3 の token 比較で捕まる。
   */
  private hasDueSweepWork(nowMs: number): boolean {
    for (const policy of ALL_REVISION_FAMILY_POLICIES) {
      if (!COORDINATED_SWEEP_FAMILIES.has(`${policy.domain}:${policy.revisionFamily}`)) continue;
      if (this.owners.telegramRevisionGate.hasDueRevisionFamilyLifecycleWork(
        policy.domain,
        policy.revisionFamily,
        nowMs,
        {
          tombstoneRetentionMs: policy.tombstoneRetentionMs,
          activeRetentionMs: "activeRetentionMs" in policy ? policy.activeRetentionMs : undefined,
        },
      )) return true;
    }
    if (this.owners.volcanoState.hasDueSweepWork(nowMs)) return true;
    if (this.owners.standbyStateStore.hasDueSweepWork(nowMs, {
      includeLegacyCompletionFamilies: false,
    })) return true;
    // sweepAll は完了所有 family を maintain 系で別に掃除する。
    if (this.owners.standbyStateStore.hasDueTyphoonProbabilityMaintenance(nowMs)) return true;
    if (this.owners.standbyStateStore.hasDueWeatherWarningForecastMaintenance(nowMs)) return true;
    if (this.owners.floodForecastState.hasDueSweepWork(nowMs)) return true;
    if (this.owners.vpws50State.hasDueSweepWork(nowMs)) return true;
    if (this.owners.vpww56State.hasDueSweepWork(nowMs)) return true;
    if (this.owners.tsunamiState.hasDueSweepWork(nowMs)) return true;
    return false;
  }

  sweepAll(nowMs: number): StandbyTransactionResult<AllDomainSweepResult> {
    if (!Number.isSafeInteger(nowMs) || Math.abs(nowMs) > 8_640_000_000_000_000) {
      return { kind: "rejected", reason: "invalidSweepClock" };
    }
    // capture の前に「今回やるべき仕事があるか」を安価に判定する (spec §3.3)。
    // 判定 3 (入力変化) は段階 1 の O(1) owner version に依存する。
    const lastNoop = this.lastNoopSweep;
    if (this.sweepPrecheckEnabled && lastNoop != null
      && nowMs >= lastNoop.atMs
      && tokenEquals(lastNoop.token, this.currentToken())
      && !this.hasDueSweepWork(nowMs)) {
      // spec §3.3 P2': 成功出口 3 つは上 2 つの戻り値が同一で呼び出し側から区別できない。
      perf.setSweepPath("precheck", 0, false);
      this.lastNoopSweep = { atMs: nowMs, token: lastNoop.token };
      return {
        kind: "committed",
        value: { changedKeys: [], durableChanged: false },
        token: lastNoop.token,
      };
    }
    // 通常経路に入った時点で基準を捨てる。rejected / staleVersion で抜けたときに
    // 古い「収束済み」の印が残らないようにする。
    this.lastNoopSweep = null;
    // spec §3.4.1: capture が返す snapshot はすでに複製済み (各 owner の cloneSnapshot)
    // なので、draft にそのまま使う。base の全文が要るのは「変更あり」と分かった後の
    // basePair 生成と changedField 比較だけなので、そこで 2 回目の capture を取る。
    // token は 1 回目の capture の値を使い続ける (stale 判定の意味を変えない)。
    const captured = this.captureMutable();
    const draft = captured.domains;
    const gate = TelegramRevisionGate.fromSnapshot(draft.telegramRevisionGate);
    const expiredGateKeys = new Set<StandbyDurableMutationKey>();
    for (const policy of ALL_REVISION_FAMILY_POLICIES) {
      const familyKey = `${policy.domain}:${policy.revisionFamily}`;
      if (!COORDINATED_SWEEP_FAMILIES.has(familyKey)) continue;
      const changed = gate.expireRevisionFamilyByLifecycle(
        policy.domain,
        policy.revisionFamily,
        nowMs,
        {
          tombstoneRetentionMs: policy.tombstoneRetentionMs,
          activeRetentionMs: "activeRetentionMs" in policy
            ? policy.activeRetentionMs
            : undefined,
        },
      );
      const durableKey = STANDBY_PERSISTED_FAMILY_DURABLE_KEYS[familyKey];
      if (changed.changed && durableKey != null) expiredGateKeys.add(durableKey);
    }
    draft.telegramRevisionGate = gate.cloneSnapshot();
    const volcano = VolcanoStateHolder.fromSnapshot(draft.volcanoHolderAndRepair.holder);
    const volcanoGateChanged = expiredGateKeys.has("volcano:volcanoAlert")
      || expiredGateKeys.has("volcano:volcanoEruption")
      || expiredGateKeys.has("volcano:volcanoAshfall");
    const volcanoCouplingChanged = volcano.retainActiveSubjects(
      gate.activeRevisionFamilySubjects("volcano", "volcanoAlert"),
      gate.activeRevisionFamilySubjects("volcano", "volcanoEruption"),
      gate.activeRevisionFamilySubjects("volcano", "volcanoAshfall"),
    );
    const volcanoSweep = volcano.sweep(nowMs);
    draft.volcanoHolderAndRepair.holder = volcano.snapshot();
    if (volcanoGateChanged || volcanoCouplingChanged || volcanoSweep.changed) {
      if (draft.volcanoHolderAndRepair.runtimeVersion >= Number.MAX_SAFE_INTEGER) {
        return { kind: "rejected", reason: "volcanoRuntimeVersionExhausted" };
      }
      draft.volcanoHolderAndRepair.runtimeVersion += 1;
    }
    const standby = StandbyStateStore.fromSnapshot(draft.standbyStateStore);
    if (volcanoSweep.changed || volcanoCouplingChanged) {
      standby.replaceVolcanoDerived(draft.volcanoHolderAndRepair.holder);
    }
    const flood = FloodForecastStateHolder.fromSnapshot(draft.floodForecastState);

    const vpws50 = Vpws50StateHolder.fromSnapshot(draft.vpws50State);
    const activeVpws50Subjects = gate.activeRevisionFamilySubjects("weather", "VPWS50");
    const vpws50Changed = vpws50.retainActiveSubjects(activeVpws50Subjects);
    if (vpws50Changed) {
      const identity = vpws50.getCurrentIdentity();
      const latest = gate.latestActiveRevisionFamilyRevision("weather", "VPWS50");
      const reportDateTime = identity?.reportDateTime
        ?? latest?.reportDateTime
        ?? new Date(nowMs).toISOString();
      standby.applyWeatherAlerts(
        "vpws50",
        weatherAlertsFromVpws50(vpws50.getCurrentAreasForDisplay(), reportDateTime),
        reportDateTime,
        identity?.serial ?? latest?.serial ?? null,
        nowMs,
      );
    }
    draft.vpws50State = vpws50.cloneSnapshot();

    const vpww56 = Vpww56StateHolder.fromSnapshot(draft.vpww56State);
    const activeVpww56Subjects = gate.activeRevisionFamilySubjects("weather", "VPWW56");
    const vpww56Changed = vpww56.retainActiveSubjects(activeVpww56Subjects);
    if (vpww56Changed) {
      const latest = gate.latestActiveRevisionFamilyRevision("weather", "VPWW56");
      const reportDateTime = latest?.reportDateTime ?? new Date(nowMs).toISOString();
      standby.applyWeatherAlerts(
        "vpww56",
        weatherAlertsFromVpww56(vpww56.getCurrentAreasForDisplay(), reportDateTime),
        reportDateTime,
        latest?.serial ?? null,
        nowMs,
      );
    }
    draft.vpww56State = vpww56.cloneSnapshot();

    const tsunami = TsunamiStateHolder.fromSnapshot(draft.tsunamiState);
    const activeTsunamiEventIds = gate.activeRevisionFamilySubjects("tsunami", "VTSE41")
      .flatMap((subject) => subject.startsWith("tsunami:")
        ? [subject.slice("tsunami:".length)]
        : []);
    const tsunamiChanged = tsunami.retainActiveEventIds(activeTsunamiEventIds);
    draft.tsunamiState = tsunami.cloneSnapshot();
    const activeFloodIds = gate.activeRevisionFamilySubjects(
      "floodForecast",
      "floodForecast",
    ).flatMap((subject) => subject.startsWith("flood:event:")
      ? [subject.slice("flood:event:".length)]
      : []);
    // spec §3.2: holder が実削除の有無を返すので、snapshot の前後 canonicalJson は要らない。
    const floodRetained = flood.retainActiveEventIds(activeFloodIds);
    const floodSwept = flood.sweep(nowMs);
    const floodChanged = floodRetained || floodSwept;
    const floodStandbyMutation = standby.retainCanonicalFloodEvents(activeFloodIds);
    const vptaProjectionMutation = standby.maintainTyphoonProbabilitySubjects(
      nowMs,
      gate.activeRevisionFamilySubjects("typhoonProbability", "VPTA50"),
    );
    const vpwp50ProjectionMutation = standby.maintainWeatherWarningForecastSubjects(
      nowMs,
      gate.revisionFamilySubjectKeys("weatherWarningTimeseries", "VPWP50"),
    );
    // Both completion-owned families are part of the global sweep candidate.
    // Only live admissions defer the durable callback to their typed completion.
    const standbyMutation = standby.sweep(nowMs, {
      includeLegacyCompletionFamilies: false,
    });
    draft.standbyStateStore = standby.cloneSnapshot();
    draft.floodForecastState = flood.cloneSnapshot();
    // spec §3.4.2: base の全文を作らず、capture 時の owner version と draft の version を比較する。
    const changed = changedOwnerKeysByVersion(captured.token, draft);
    let strictBase: StandbyPersistenceDomainSnapshots | null = null;
    if (strictSweepOwnerDiff) {
      // spec §3.4.3: テスト時だけ ground truth と突き合わせ、不一致なら止める。
      // ground truth は **version カウンタを落とした payload** で取る。snapshot 全文で
      // 比べると `version` 自体が payload に含まれるため「version が動いた ⟹ 全文も動く」が
      // 恒真になり、捕まるのは取りこぼし (under-bump) だけになる。payload で比べることで
      // 過剰 bump (version だけ進んで中身は不変) も捕まる。過剰 bump は spurious commit を
      // 起こし、`lastNoopSweep` が立たないので段階 3 の事前判定を無効化する。
      strictBase = this.captureMutable().domains;
      const canonical = changedOwnerPayloadKeys(strictBase, draft);
      if (canonical.join(",") !== changed.join(",")) {
        throw new Error(
          "[standby-admission] strict sweep owner diff mismatch: "
          + `version=[${changed.join(",")}] payload=[${canonical.join(",")}]`,
        );
      }
    }
    if (changed.length === 0) {
      // 収束が確認できた周期だけを事前判定の基準にする。
      perf.setSweepPath("nochange", 0, false);
      this.lastNoopSweep = { atMs: nowMs, token: captured.token };
      return {
        kind: "committed",
        value: { changedKeys: [], durableChanged: false },
        token: captured.token,
      };
    }
    // 変更ありと分かったのでここで base を取る (no-op 経路では 1 度も取らない)。
    // strict モードで既に取っていればそれを再利用する (commit 経路で capture は増えない)。
    const base = strictBase ?? this.captureMutable().domains;
    const changedKeys: StandbyDurableMutationKey[] = [...expiredGateKeys];
    if (vpws50Changed) changedKeys.push("weather:VPWS50");
    if (vpww56Changed) changedKeys.push("weather:VPWW56");
    if (tsunamiChanged) changedKeys.push("tsunami:VTSE41");
    if (volcanoSweep.changed || volcanoCouplingChanged) {
      changedKeys.push(
        "volcano:volcanoAlert",
        "volcano:volcanoEruption",
        "volcano:volcanoAshfall",
      );
    }
    if (floodChanged || floodStandbyMutation.durableChanged) {
      changedKeys.push("floodForecast:floodForecast");
    }
    if (vptaProjectionMutation.durableChanged) {
      changedKeys.push("typhoonProbability:VPTA50");
    }
    if (vpwp50ProjectionMutation.durableChanged) {
      changedKeys.push("weatherWarningTimeseries:VPWP50");
    }
    if (standbyMutation.durableChanged) {
      const before = base.standbyStateStore.data;
      const after = draft.standbyStateStore.data;
      const changedField = (field: keyof typeof before): boolean =>
        canonicalJson(before[field]) !== canonicalJson(after[field]);
      if (changedField("heatAlerts")) changedKeys.push("standby:heatAlert");
      if (changedField("typhoons")) changedKeys.push("standby:typhoonAnalysis");
      if (changedField("typhoonProbabilities")) {
        changedKeys.push("typhoonProbability:VPTA50");
      }
      if (changedField("tornadoByOffice")) changedKeys.push("standby:tornado");
      if (changedField("longPeriodByEvent")) changedKeys.push("standby:lgObservation");
      if (changedField("nankaiTrough")) changedKeys.push("standby:nankaiTrough");
      if (changedField("quakeHost")) changedKeys.push("standby:quakeHost");
      if (changedField("weatherAlerts")) {
        changedKeys.push("weather:VPWS50", "weather:VPWW56");
      }
      if (changedField("weatherWarningForecasts")) {
        changedKeys.push("weatherWarningTimeseries:VPWP50");
      }
      if (changedField("volcanoes")) {
        changedKeys.push(
          "volcano:volcanoAlert",
          "volcano:volcanoEruption",
          "volcano:volcanoAshfall",
        );
      }
      if (changedField("floods")) changedKeys.push("floodForecast:floodForecast");
      if (
        changedField("briefingEntries")
        || changedField("briefingRevisionWatermarks")
        || changedField("linearRainForecastReplacementWatermarks")
        || changedField("rawCriticalProvenance")
        || changedField("rawBriefingAliases")
        || changedField("briefingGeneration")
        || changedField("briefingDurableGeneration")
        || changedField("revisionGuard")
      ) changedKeys.push("standby:briefingCritical");
    }
    let candidatePair: StandbySerializedPair;
    let basePair: StandbySerializedPair;
    let failure: string | null;
    try {
      candidatePair = this.serializePair(draft, PREFLIGHT_ENVELOPE);
      basePair = this.serializePair(base, PREFLIGHT_ENVELOPE);
      failure = this.preflight(draft, candidatePair);
    } catch {
      failure = "candidateSerializationFailed";
      candidatePair = { v2: new Uint8Array(), v1: new Uint8Array() };
      basePair = candidatePair;
    }
    if (failure != null) return { kind: "rejected", reason: failure };
    const durableChanged = !pairEqual(basePair, candidatePair);
    if (durableChanged && !this.canReserveLogicalGeneration()) {
      return { kind: "rejected", reason: "logicalGenerationExhausted" };
    }
    if (!tokenEquals(captured.token, this.currentToken())) return { kind: "staleVersion" };
    perf.setSweepPath("full", changed.length, durableChanged);
    this.commit(draft, changed);
    if (durableChanged) this.emitDurable();
    return {
      kind: "committed",
      value: { changedKeys: [...new Set(changedKeys)], durableChanged },
      token: this.currentToken(),
    };
  }

  captureSerializedPair(envelope: StandbySerializationEnvelope): {
    token: StandbyPersistenceVersionToken;
    v2: Uint8Array;
    v1: Uint8Array;
  } {
    // spec §3.1 A: 判定は `capture()` の**前**に置く。`this.capture().token` で判定すると
    // 再利用が効く行でも 7 owner の deep clone (Pi 実測 約 55ms) を払い続ける。
    // `currentToken()` は owner の `version()` を読むだけで clone を伴わない。
    const reusable = this.bodyReuseSupported && standbyBodyReuseEnabled
      ? this.reusableBody
      : null;
    let token: StandbyPersistenceVersionToken;
    let pair: StandbySerializedPair;
    if (reusable !== null && tokenEquals(reusable.token, this.currentToken())) {
      token = reusable.token;
      pair = this.encodeSerializationBody(reusable.body, envelope);
    } else {
      const captured = this.capture();
      token = captured.token;
      pair = this.serializePair(captured.domains, envelope);
    }
    if (pair.v2.byteLength > STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE
      || pair.v1.byteLength > STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE) {
      throw new Error("standby persistence serialized pair exceeds the full-file byte limit");
    }
    if (!tokenEquals(token, this.currentToken())) {
      throw new Error("standby persistence serialized pair became stale");
    }
    return { token, ...pair };
  }
}

/**
 * Commit lifecycle expiry independently of the incoming candidate.  A later
 * count/byte/serialization rejection must not resurrect state that had already
 * expired at the admission clock.
 */
export function sweepStandbyBeforeAdmission(
  coordinator: StandbyPersistenceAdmissionCoordinator,
  key: StandbyDurableMutationKey,
  nowMs: number,
): boolean {
  // spec §3.3 P2: 受理前 sweep は同じ電文の受理コールスタック上にある。5 秒タイマーの
  // sweep は別 tick なので `[perf-sweep]` の独立行になる (spec §2.5)。
  const sweep = perf.mark("sweepPre", () => coordinator.sweepAll(nowMs));
  if (sweep.kind === "committed") return true;
  log.warn(
    `[standby-admission] key=${key} preAdmissionSweep=${sweep.kind === "rejected" ? sweep.reason : "staleVersion"}`,
  );
  return false;
}

export const STANDBY_PERSISTENCE_OWNER_ORDER = OWNER_ORDER;
export const STANDBY_EXPECTED_TOUCHED_OWNERS = EXPECTED_OWNERS;
