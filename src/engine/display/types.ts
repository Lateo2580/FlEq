export * from "./protocol";
import type { PresentationEvent } from "../presentation/types";
import type {
  ActiveStandbyCardV1,
  DisplayQuakeIntensityMapEventV1,
  DisplayServerMessageWithReconcile,
  DisplayStatsV1,
} from "./protocol";
import type {
  BriefingCardMutationResult,
  CardReconcileResult,
} from "./standby-state-store";
import type { StandbyRevision } from "./standby-registry";
import type {
  FinalizedTyphoonProbabilityClassification,
} from "./project-typhoon-probability";
import type { VptaAcceptedCommit } from "../messages/telegram-revision-gate";
import type {
  StandbyPersistenceFlushThroughResult,
  StandbyPersistenceScheduleReceipt,
} from "./standby-persistence";

declare const vptaRouterOwnerTokenBrand: unique symbol;
export type VptaRouterOwnerToken = Readonly<{
  readonly [vptaRouterOwnerTokenBrand]: true;
}>;

let currentVptaRouterOwnerToken: VptaRouterOwnerToken | null = null;

/** A command token is valid only during the synchronous serializer owner that issued it. */
export function createVptaRouterOwnerToken(): VptaRouterOwnerToken {
  return Object.freeze({}) as VptaRouterOwnerToken;
}

export function withVptaRouterOwnerToken<T>(
  token: VptaRouterOwnerToken,
  callback: () => T,
): T {
  const previous = currentVptaRouterOwnerToken;
  currentVptaRouterOwnerToken = token;
  try {
    return callback();
  } finally {
    currentVptaRouterOwnerToken = previous;
  }
}

export function requireVptaRouterOwnerToken(): VptaRouterOwnerToken {
  if (currentVptaRouterOwnerToken == null) {
    throw new Error("VPTA router owner token unavailable");
  }
  return currentVptaRouterOwnerToken;
}

export function assertVptaRouterOwnerToken(token: VptaRouterOwnerToken): void {
  if (currentVptaRouterOwnerToken !== token) {
    throw new Error("VPTA router owner token mismatch");
  }
}

/** Router-private VPTA command. It is never a ProcessOutcome/PresentationEvent field. */
export interface VptaDisplayIngestCommand {
  domain: "typhoonProbability";
  ownerToken: VptaRouterOwnerToken;
  finalized: FinalizedTyphoonProbabilityClassification;
  commit: VptaAcceptedCommit;
  /** Router-private post-commit family view used by managed retention. */
  activeSubjects: readonly string[];
}

export interface VptaDurableChangeFlags {
  gateExpiry: boolean;
  projectionCleanup: boolean;
  incomingGate: boolean;
  projectionOrRetention: boolean;
}

export type VptaFailureStage =
  | "classificationClock" | "infoTypeCanonicalization" | "processorBaseline"
  | "projector" | "admissionGateExpiry" | "activeSubjectSnapshot"
  | "projectionCleanup" | "protectionSnapshot" | "serialCanonicalization"
  | "capacityPlan" | "gateEvaluate" | "gateCommitInvariant"
  | "genericRevisionCallback" | "standbyRevisionObserver" | "finalizer"
  | "notificationHolder" | "outcomeBinding" | "recordStats" | "correlator"
  | "notifier" | "postNotifierStats" | "outcomeTapPoison" | "eventConversion"
  | "displayPreprocess" | "standbyReducer" | "managedRetention"
  | "displaySinkPostStandby";

export type VptaAdmissionCompletion =
  | { kind: "accepted"; nowMs: number; durableChanged: true; persistence: "deferred"; changes: VptaDurableChangeFlags }
  | { kind: "suppressed"; nowMs: number; durableChanged: false; persistence: "none"; changes: VptaDurableChangeFlags }
  | { kind: "suppressed"; nowMs: number; durableChanged: true; persistence: "deferred"; changes: VptaDurableChangeFlags }
  | { kind: "failed"; nowMs: number; durableChanged: false; persistence: "none"; changes: VptaDurableChangeFlags; stage: VptaFailureStage }
  | { kind: "failed"; nowMs: number; durableChanged: true; persistence: "immediate"; changes: VptaDurableChangeFlags; stage: VptaFailureStage };

/** Runtime boundary for completion values supplied through test seams/adapters. */
export function assertVptaAdmissionCompletion(
  completion: VptaAdmissionCompletion,
): void {
  const durableChanged = completion.changes.gateExpiry
    || completion.changes.projectionCleanup
    || completion.changes.incomingGate
    || completion.changes.projectionOrRetention;
  const validKind = completion.kind === "accepted"
    ? completion.durableChanged === true && completion.persistence === "deferred"
      && completion.changes.incomingGate
    : completion.kind === "suppressed"
      ? completion.durableChanged === durableChanged
        && completion.persistence === (durableChanged ? "deferred" : "none")
      : completion.durableChanged === durableChanged
        && completion.persistence === (durableChanged ? "immediate" : "none");
  if (completion.durableChanged !== durableChanged || !validKind) {
    throw new Error("invalid VPTA admission completion");
  }
}

export type VptaPersistenceCompletionAck =
  | { kind: "notRequired" }
  | { kind: "scheduled"; receipt: StandbyPersistenceScheduleReceipt }
  | {
      kind: "flushed";
      receipt: StandbyPersistenceScheduleReceipt;
      result: Extract<StandbyPersistenceFlushThroughResult, { kind: "written" | "alreadyWritten" }>;
    }
  | {
      kind: "failed";
      operation: "completionCallback" | "exportActiveState" | "schedule" | "flushThrough";
      completionAlreadyEmitted: boolean;
      receipt: StandbyPersistenceScheduleReceipt | null;
      cause: unknown;
    };

export type VptaAdmissionCompletionAdapter = (
  completion: VptaAdmissionCompletion,
) => VptaPersistenceCompletionAck;

/** 表示 sink が mutation／配信の成否を返すときの client 配送状態。 */
export type DisplayIngestDelivery =
  | "delivered"
  | "noClients"
  | "blockedSkipped"
  | "byteGuardDropped";

/**
 * ticker surface の ingest 結果。
 *
 * `ingest()` は旧 sink との段階導入互換のため `void` も返し得る。新しい hub は
 * `applied` と exact ticker key 集合を返し、router はその結果だけを receipt の根拠にする。
 */
export type DisplayIngestResult =
  | {
      kind: "applied";
      /** 移行期の wire／テスト実装が status を使う場合の additive alias。 */
      status?: "applied";
      /** 通常 ingest の canonical event key。 */
      eventKey?: string;
      /** 通常 ingest が作った ticker の exact key 集合。 */
      eventKeys?: readonly string[];
      /** 上記の別名。protocol／hub 実装の段階導入用。 */
      tickerEventKeys?: readonly string[];
      /** mutation 後の server seq。未実装 sink では省略可。 */
      seq?: number;
      /** no client／backpressure／byte guard を mutation と分離して観測する。 */
      delivery?: DisplayIngestDelivery;
    }
  | {
      kind: "unsupported";
      status?: "unsupported";
      reason: string;
    }
  | {
      kind: "failure" | "failed";
      status?: "failure" | "failed";
      reason: string;
    };

/** 通常 ingest で card generation が進んだことだけを表す、metric 境界用の結果。 */
export interface DisplayCardIngestResult {
  kind: "applied";
  status: "applied";
  applied: true;
  generation: number;
  /** 容量超過で同一 mutation 中に追い出した card entry。 */
  evictedKey?: string;
}

/** card reconcile が例外になった場合も ticker result と独立して返す。 */
export type DisplayCardReconcileResult = CardReconcileResult | {
  kind: "failure";
  status: "failure";
  applied: false;
  reason: "cardReconcileFailed";
};

/** 通常 ingest の ticker/card 分離結果。旧 sink は ticker result を直接返してよい。 */
export interface DisplayIngestOutcome {
  tickerResult?: DisplayIngestResult;
  cardResult?: DisplayCardIngestResult;
  /** Router-private VPTA reducer evidence; never serialized. */
  vptaMutation?: { viewChanged: boolean; durableChanged: boolean };
  /**
   * VPTA の standby mutation 後に起きた同期 failure。mutation evidence を失わず
   * router の admission completion へ返すためだけの private transport である。
   */
  vptaFailure?: {
    stage: "standbyReducer" | "managedRetention" | "displaySinkPostStandby";
    cause: unknown;
  };
}

/** late counterpart action 専用の ticker/card 分離結果。 */
export interface DisplayLateCounterpartResult {
  tickerResult?: DisplayIngestResult;
  cardResult?: DisplayCardReconcileResult;
}

/** Unit 4 が card metric へ接続するための、generation 単位の型付き境界。 */
export interface DisplayCardMutationMetricEvent {
  kind: "ingest" | "reconcile";
  generation: number;
  sourceType: string;
  /** 容量 eviction を伴う applied mutation のときだけ存在する。 */
  evictedKey?: string;
}

/** typed late counterpart action が sink 間を渡す、ticker/card 分離済みの補助情報。 */
export interface DisplayLateCounterpartContext {
  /** source 側の PresentationEvent。card 専用 raw identity の解決にだけ使う。 */
  sourceEvent?: PresentationEvent;
  /** card mutation 後の authoritative briefing card。null は card 消滅を表す。 */
  card?: Extract<ActiveStandbyCardV1, { kind: "briefing" }> | null;
}

/** router が所有する非永続 receipt の timer DI。 */
export interface DisplayReceiptTimerScheduler {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

/** router が所有する非永続 receipt の clock DI。 */
export interface DisplayReceiptClock {
  nowMs(): number;
}

export type DisplayQuakeMapEventUpdateV1 = Pick<
  DisplayQuakeIntensityMapEventV1,
  | "eventId"
  | "reportDateTime"
  | "originTime"
  | "hypocenterName"
  | "depth"
  | "depthSemantic"
  | "magnitude"
  | "magnitudeSemantic"
  | "tsunamiWarning"
  | "updatedAtMs"
>;

export type DisplayQuakeMapCommandV1 =
  | {
      kind: "upsert";
      event: Omit<DisplayQuakeIntensityMapEventV1, "sourceType" | "revision">;
      sourceType: string;
      revision: StandbyRevision;
      isCorrection?: boolean;
    }
  | {
      kind: "remove";
      eventKey: string;
      sourceType: string;
      reason: "cancelled" | "belowThreshold" | "nonExact" | "structuralMissing";
      revision: StandbyRevision;
      isCorrection?: boolean;
      eventUpdate?: DisplayQuakeMapEventUpdateV1;
    };

/** broadcast 1 回の配送結果。authoritative sync (tickerSynced) が全 client に届いたかを判定する */
export interface DisplayBroadcastResult {
  /** 配信対象だった client 総数 (broadcast 開始時点) */
  total: number;
  /** 既に blocked (backpressure) で今回の配信をスキップされた、または上限超過で切断され、
   *  この message を受け取れなかった client 数。0 なら全 client の socket buffer へ届いている */
  blockedSkipped: number;
  /** payload が上限を超え、今回の message を誰にも送らなかったとき true。 */
  byteGuardDropped?: boolean;
}

export interface DisplayTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  broadcast(msg: DisplayServerMessageWithReconcile): DisplayBroadcastResult;
  clientCount(): number;
}

export interface DisplayIngestSink {
  /**
   * 旧 sink は void、新 hub は discriminated result を返す段階導入型。
   * `number` は旧テスト／adapter の `array.push()` の戻り値を void 互換として受けるためだけに許す。
   */
  ingest(
    event: PresentationEvent,
    internalCommand?: VptaDisplayIngestCommand,
  ): DisplayIngestResult | DisplayIngestOutcome | void | number;
  /** card を再適用せず ticker surface だけを通常 ingest する fail-open 経路。 */
  ingestTickerOnly?(event: PresentationEvent): DisplayIngestResult | void;
  /** 遅着 counterpart の ticker surface を一回で reconcile する optional capability。 */
  reconcileLateCounterpart?(
    event: PresentationEvent,
    sourceEventKeys: readonly string[],
    context?: DisplayLateCounterpartContext,
  ): DisplayLateCounterpartResult | DisplayIngestResult | void;
  /** ticker receipt が無い late action 用。card mutation だけを必ず確定する。 */
  reconcileLateCounterpartCard?(
    event: PresentationEvent,
    context: DisplayLateCounterpartContext,
  ): DisplayLateCounterpartResult | DisplayIngestResult | void;
  /** monitor 所有の表示状態が変化したとき、snapshot の再配信を要求する。 */
  markExternalStateDirty?(): void;
  publishStats?(stats: DisplayStatsV1): void;
  /** VPTA gate capacity protection snapshot. Read-only and deterministically sorted. */
  activeTyphoonProbabilitySubjects?(nowMs: number): readonly string[];
  /** Admission/startup/runtime coupling cleanup. */
  maintainTyphoonProbabilitySubjects?(
    nowMs: number,
    activeGateSubjects: readonly string[],
  ): { viewChanged: boolean; durableChanged: boolean };
  /** Post-gate failure closes the committed subject to P+G/GA/GT without synthesizing state. */
  reconcileTyphoonProbabilityCommand?(
    command: VptaDisplayIngestCommand,
  ): { viewChanged: boolean; durableChanged: boolean };
  reconcileTyphoonProbabilitySubject?(
    eventId: string,
  ): { viewChanged: boolean; durableChanged: boolean };
}
