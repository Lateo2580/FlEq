import * as log from "../../logger";
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
  validateCandidate?: (
    domains: Readonly<StandbyPersistenceDomainSnapshots>,
    pair: Readonly<StandbySerializedPair>,
  ) => string | null;
  canReserveLogicalGeneration?: () => boolean;
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

  constructor(deps: StandbyPersistenceAdmissionCoordinatorDeps) {
    this.owners = deps.owners;
    this.repairState = structuredClone(deps.repairState ?? emptyVolcanoRepairState());
    this.volcanoRuntimeVersion = deps.owners.volcanoState.version();
    this.serializePair = deps.serializePair ?? defaultSerializePair;
    this.validateCandidate = deps.validateCandidate;
    this.canReserveLogicalGeneration = deps.canReserveLogicalGeneration ?? (() => true);
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

  capture(): StandbyPersistenceAdmissionSnapshot {
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

  private transactInternal<T>(
    key: StandbyDurableMutationKey,
    touchedOwners: readonly StandbyPersistenceOwnerKey[],
    reduce: StandbyCandidateReducer<T>,
    deferDurable: boolean,
  ): StandbyDeferredTransactionResult<T> {
    const expected = EXPECTED_OWNERS[key];
    if (!sameOwnerList(touchedOwners, expected)) {
      return { kind: "rejected", reason: "invalidTouchedOwners" };
    }
    const captured = this.capture();
    const draft = structuredClone(captured.domains) as StandbyPersistenceDomainSnapshots;
    let reduced: ReturnType<StandbyCandidateReducer<T>>;
    try {
      reduced = reduce(draft);
    } catch {
      return { kind: "rejected", reason: "reducerException" };
    }
    if (reduced.kind === "rejected") return reduced;
    const changed = changedOwnerKeys(captured.domains as StandbyPersistenceDomainSnapshots, draft);
    if (changed.some((owner) => !expected.includes(owner))) {
      return { kind: "rejected", reason: "unexpectedOwnerMutation" };
    }
    let candidatePair: StandbySerializedPair;
    let basePair: StandbySerializedPair;
    let admissionFailure: string | null;
    try {
      candidatePair = this.serializePair(draft, PREFLIGHT_ENVELOPE);
      basePair = this.serializePair(captured.domains, PREFLIGHT_ENVELOPE);
      admissionFailure = this.preflight(draft, candidatePair);
    } catch {
      admissionFailure = "candidateSerializationFailed";
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
    if (changed.length > 0) this.commit(draft, changed);
    const token = this.currentToken();
    if (durableChanged && !deferDurable) this.emitDurable();
    return { kind: "committed", value: reduced.value, token, durableChanged };
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

  sweepAll(nowMs: number): StandbyTransactionResult<AllDomainSweepResult> {
    if (!Number.isSafeInteger(nowMs) || Math.abs(nowMs) > 8_640_000_000_000_000) {
      return { kind: "rejected", reason: "invalidSweepClock" };
    }
    const captured = this.capture();
    const draft = structuredClone(captured.domains) as StandbyPersistenceDomainSnapshots;
    const gate = TelegramRevisionGate.fromSnapshot(draft.telegramRevisionGate);
    const expiredGateKeys = new Set<StandbyDurableMutationKey>();
    for (const policy of ALL_REVISION_FAMILY_POLICIES) {
      const familyKey = `${policy.domain}:${policy.revisionFamily}`;
      if (policy.tombstoneRetentionMs == null
        || !COORDINATED_SWEEP_FAMILIES.has(familyKey)) continue;
      const changed = gate.expireRevisionFamily(
        policy.domain,
        policy.revisionFamily,
        nowMs,
        policy.tombstoneRetentionMs,
      );
      const durableKey = STANDBY_PERSISTED_FAMILY_DURABLE_KEYS[familyKey];
      if (changed && durableKey != null) expiredGateKeys.add(durableKey);
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
    const floodBefore = canonicalJson(flood.cloneSnapshot());
    flood.retainActiveEventIds(activeFloodIds);
    flood.sweep(nowMs);
    const floodChanged = floodBefore !== canonicalJson(flood.cloneSnapshot());
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
    const changed = changedOwnerKeys(captured.domains as StandbyPersistenceDomainSnapshots, draft);
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
      const before = captured.domains.standbyStateStore.data;
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
        || changedField("rawCriticalProvenance")
        || changedField("rawBriefingAliases")
        || changedField("briefingGeneration")
        || changedField("briefingDurableGeneration")
        || changedField("revisionGuard")
      ) changedKeys.push("standby:briefingCritical");
    }
    if (changed.length === 0) {
      return {
        kind: "committed",
        value: { changedKeys: [], durableChanged: false },
        token: captured.token,
      };
    }
    let candidatePair: StandbySerializedPair;
    let basePair: StandbySerializedPair;
    let failure: string | null;
    try {
      candidatePair = this.serializePair(draft, PREFLIGHT_ENVELOPE);
      basePair = this.serializePair(captured.domains, PREFLIGHT_ENVELOPE);
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
    const captured = this.capture();
    const pair = this.serializePair(captured.domains, envelope);
    if (pair.v2.byteLength > STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE
      || pair.v1.byteLength > STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE) {
      throw new Error("standby persistence serialized pair exceeds the full-file byte limit");
    }
    if (!tokenEquals(captured.token, this.currentToken())) {
      throw new Error("standby persistence serialized pair became stale");
    }
    return { token: captured.token, ...pair };
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
  const sweep = coordinator.sweepAll(nowMs);
  if (sweep.kind === "committed") return true;
  log.warn(
    `[standby-admission] key=${key} preAdmissionSweep=${sweep.kind === "rejected" ? sweep.reason : "staleVersion"}`,
  );
  return false;
}

export const STANDBY_PERSISTENCE_OWNER_ORDER = OWNER_ORDER;
export const STANDBY_EXPECTED_TOUCHED_OWNERS = EXPECTED_OWNERS;
