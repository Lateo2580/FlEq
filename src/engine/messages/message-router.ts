import chalk from "chalk";
import * as log from "../../logger";
import type { WsDataMessage } from "../../types";
import {
  normalizeTelegramMessage,
} from "../../dmdata/telegram-ingress";
import type { TelegramIngressDiagnostics } from "../../dmdata/telegram-ingress";
import { telegramDateDiagnosticReason } from "../../dmdata/telegram-meta";
import { EewTracker } from "../eew/eew-tracker";
import { EewEventLogger } from "../eew/eew-logger";
import { Notifier } from "../notification/notifier";
import { TsunamiStateHolder } from "./tsunami-state";
import { VolcanoStateHolder } from "./volcano-state";
import { Vpws50StateHolder } from "./vpws50-state";
import { Vpww56StateHolder } from "./vpww56-state";
import { Vpwp50DetailCache } from "./vpwp50-detail-cache";
import { TornadoDetailProvider } from "./tornado-detail-provider";
import { TyphoonProbabilityStateHolder } from "./typhoon-probability-state";
import { FloodForecastStateHolder } from "./flood-forecast-state";
import { TelegramStats, routeToCategory } from "./telegram-stats";
import { classifyMessage } from "./route-catalog";
import type { Route } from "./route-catalog";
import { assertNever } from "../../utils/assert-never";
import { SummaryWindowTracker } from "./summary-tracker";
import { DailyQuakeCounter } from "./daily-quake-counter";
import type {
  DisplayCardIngestResult,
  DisplayCardMutationMetricEvent,
  DisplayCardReconcileResult,
  DisplayIngestOutcome,
  DisplayIngestResult,
  DisplayLateCounterpartResult,
  DisplayReceiptClock,
  DisplayReceiptTimerScheduler,
  DisplayLateCounterpartContext,
  DisplayStatsV1,
  VptaAdmissionCompletion,
  VptaAdmissionCompletionAdapter,
  VptaDisplayIngestCommand,
  VptaFailureStage,
  VptaPersistenceCompletionAck,
} from "../display/types";
import {
  assertVptaAdmissionCompletion,
  createVptaRouterOwnerToken,
  withVptaRouterOwnerToken,
} from "../display/types";
import type { StandbyPersistenceFlushThroughResult } from "../display/standby-persistence";
import { processMessageInternal as processMsg, ProcessDeps } from "../presentation/processors/process-message";
import { toPresentationEvent } from "../presentation/events/to-presentation-event";
import { expandVolcanoBatchForDisplay } from "../presentation/events/from-volcano";
import { shouldDisplay, renderTemplate } from "../filter-template/pipeline";
import type { FilterTemplatePipeline } from "../filter-template/pipeline";
import { PresentationDiffStore } from "../presentation/diff-store";
import type {
  LegacyCounterpartOutcome,
  ProcessOutcome,
  PresentationEvent,
  VolcanoBatchOutcome,
} from "../presentation/types";
import { VolcanoRouteHandler } from "./volcano-route-handler";
import type { VolcanoTransactionCoordinator } from "./volcano-transaction-coordinator";
import type { StandbyPersistenceAdmissionCoordinator } from "../display/standby-persistence-admission";
import type { DisplayCallbacks } from "./display-callbacks";
import type { DisplayIngestSink } from "../display/types";
import { TelegramTransportDeduplicator } from "./telegram-transport-dedup";
import {
  dateDiagnosticPresentationEvent,
  telegramDateDiagnostic,
} from "./telegram-diagnostic";
import { TelegramRevisionGate, type TelegramRevisionDecision } from "./telegram-revision-gate";
import { routeHasExplicitRevisionFamilyPolicy } from "./revision-family-registry";
import { isVpws50StateHeadType } from "./weather-stream-key";
import {
  createUnknownDeliveryCapabilities,
  type DeliveryCapabilities,
} from "../../dmdata/delivery-capabilities";
import {
  LegacyCounterpartCorrelator,
  type LegacyCounterpartAction,
  type LegacyCounterpartAffectedSource,
  type LegacyCounterpartCorrelatorFactory,
  type LegacyCounterpartLifecycleEvent,
} from "./legacy-counterpart-correlator";

export const LEGACY_DISPLAY_RECEIPT_CAPACITY = 512;
export const LEGACY_DISPLAY_RECEIPT_EVENT_KEY_CAPACITY = 32;
export const LEGACY_DISPLAY_RECEIPT_RETENTION_MS = 11 * 60_000;
export const ROUTER_REENTRANT_QUEUE_MAX_ITEMS = 256;
export const ROUTER_REENTRANT_QUEUE_MAX_BYTES = 64 * 1024 * 1024;
export const ROUTER_MAX_DRAINED_ENVELOPES_PER_TURN = 512;

export type ReadonlyDeep<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends readonly (infer U)[] ? readonly ReadonlyDeep<U>[]
      : T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
        : T;

export class RouterSerializerPoisonedError extends Error {
  constructor(readonly serializerCause: unknown) {
    super("message router serializer is poisoned");
    this.name = "RouterSerializerPoisonedError";
  }
}

interface RouterEnvelope {
  readonly message: ReadonlyDeep<WsDataMessage>;
  readonly route: Route;
  readonly diagnostics: Readonly<TelegramIngressDiagnostics>;
  readonly ingressObservedAtMs: number;
  readonly ordinal: number;
  readonly byteLength: number;
}

function deepFreezeRouterSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value == null) return value;
  const object = value as object;
  if (seen.has(object) || Object.isFrozen(object)) return value;
  seen.add(object);
  // ArrayBuffer views cannot be frozen on every supported Node release. WsDataMessage
  // does not normally contain one, but treating the view as an opaque leaf keeps the
  // generic guard from turning a valid transport payload into a platform-dependent error.
  if (!ArrayBuffer.isView(object)) {
    for (const key of Reflect.ownKeys(object)) {
      deepFreezeRouterSnapshot(Reflect.get(object, key), seen);
    }
    Object.freeze(object);
  }
  return value;
}

type DisplayIngestOperation = (
  event: PresentationEvent,
) => DisplayIngestResult | DisplayIngestOutcome | DisplayLateCounterpartResult | void | number;

interface DisplayIngestCapture {
  result?: DisplayIngestResult;
  cardResult?: DisplayCardIngestResult | DisplayCardReconcileResult;
}

interface DisplayReceipt {
  sourceIdentity: string;
  generation: number;
  createdOrder: number;
  expiresAtMs: number;
  sourceVersionToken: string;
  eventKeys: Set<string>;
  keyOverflowed: boolean;
  timer: unknown | null;
}

interface DisplayReceiptView {
  record: DisplayReceipt;
  generation: number;
  sourceEventKeys: readonly string[];
}

interface ConsumedDisplayReceipt {
  generation: number;
  createdOrder: number;
  expiresAtMs: number;
  sourceVersionToken: string;
  timer: unknown | null;
}

function isDisplayIngestResult(value: unknown): value is DisplayIngestResult {
  if (typeof value !== "object" || value == null || !("kind" in value)) return false;
  const kind = value.kind;
  return kind === "applied" || kind === "unsupported" || kind === "failure" || kind === "failed";
}

function tickerResultOf(result: unknown): DisplayIngestResult | undefined {
  if (isDisplayIngestResult(result)) return result;
  if (typeof result !== "object" || result == null || !("tickerResult" in result)) return undefined;
  return isDisplayIngestResult(result.tickerResult) ? result.tickerResult : undefined;
}

function cardResultOf(result: unknown): DisplayCardIngestResult | DisplayCardReconcileResult | undefined {
  if (typeof result !== "object" || result == null || !("cardResult" in result)) return undefined;
  const cardResult = result.cardResult;
  if (typeof cardResult !== "object" || cardResult == null || !("kind" in cardResult)) return undefined;
  return cardResult as DisplayCardIngestResult | DisplayCardReconcileResult;
}

function vptaMutationOf(result: unknown): { viewChanged: boolean; durableChanged: boolean } | undefined {
  if (typeof result !== "object" || result == null || !("vptaMutation" in result)) return undefined;
  const mutation = result.vptaMutation;
  if (typeof mutation !== "object" || mutation == null
    || !("viewChanged" in mutation) || !("durableChanged" in mutation)
    || typeof mutation.viewChanged !== "boolean"
    || typeof mutation.durableChanged !== "boolean") return undefined;
  return mutation as { viewChanged: boolean; durableChanged: boolean };
}

function vptaFailureOf(result: unknown): {
  stage: "standbyReducer" | "managedRetention" | "displaySinkPostStandby";
  cause: unknown;
} | undefined {
  if (typeof result !== "object" || result == null || !("vptaFailure" in result)) return undefined;
  const failure = result.vptaFailure;
  if (typeof failure !== "object" || failure == null || !("stage" in failure) || !("cause" in failure)) {
    return undefined;
  }
  if (failure.stage !== "standbyReducer"
    && failure.stage !== "managedRetention"
    && failure.stage !== "displaySinkPostStandby") return undefined;
  return failure as {
    stage: "standbyReducer" | "managedRetention" | "displaySinkPostStandby";
    cause: unknown;
  };
}

function displayIngestApplied(result: unknown): result is Extract<DisplayIngestResult, { kind: "applied" }> {
  const tickerResult = tickerResultOf(result);
  return tickerResult != null && tickerResult.kind === "applied";
}

function cardMutationMetric(
  result: DisplayIngestCapture["cardResult"],
  kind: "ingest" | "reconcile",
  sourceType: string,
): DisplayCardMutationMetricEvent | undefined {
  if (result?.kind !== "applied") return undefined;
  return {
    kind,
    generation: result.generation,
    sourceType,
    ...(result.evictedKey == null ? {} : { evictedKey: result.evictedKey }),
  };
}

function displayIngestEventKeys(result: unknown): readonly string[] {
  const tickerResult = tickerResultOf(result);
  if (tickerResult?.kind !== "applied") return [];
  const candidates = [
    ...(tickerResult.eventKeys ?? []),
    ...(tickerResult.tickerEventKeys ?? []),
    ...(tickerResult.eventKey == null ? [] : [tickerResult.eventKey]),
  ];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const candidate of candidates) {
    if (candidate.trim() === "" || seen.has(candidate)) continue;
    seen.add(candidate);
    keys.push(candidate);
  }
  return keys;
}

function sourceReceivedAtMs(outcome: LegacyCounterpartOutcome, fallbackMs: number): number {
  const receivedAtMs = outcome.parsed.meta.receivedAtMs;
  return Number.isFinite(receivedAtMs) ? receivedAtMs : fallbackMs;
}

function sourceVersionToken(outcome: LegacyCounterpartOutcome): string {
  const meta = outcome.parsed.meta;
  return JSON.stringify([
    meta.messageId,
    meta.reportDateTime.raw,
    meta.serial.raw,
  ]);
}

/** router handler 内だけで生存する、遅着 counterpart 用 ticker receipt。 */
class LegacyDisplayReceiptStore {
  private readonly records = new Map<string, DisplayReceipt>();
  /** 同一 receipt generation の action 重送は通常 ingest へ fail-open させない。 */
  private readonly consumed = new Map<string, ConsumedDisplayReceipt>();
  private nextGeneration = 1;
  private nextCreatedOrder = 1;

  constructor(
    private readonly clock: DisplayReceiptClock,
    private readonly scheduler: DisplayReceiptTimerScheduler,
  ) {}

  /** 同じ source identity の新 lifecycle admission は旧 receipt を再利用しない。 */
  beginNewLifecycle(sourceIdentity: string): void {
    this.remove(sourceIdentity);
    this.removeConsumed(sourceIdentity);
  }

  recordSourceIngest(
    sourceIdentity: string,
    outcome: LegacyCounterpartOutcome,
    result: DisplayIngestResult | void,
    reason: "timeout" | "releasedUpdate" | "counterpartCancelled" | "correlatorCapacityExceeded",
    nowMs: number,
  ): void {
    if (reason === "counterpartCancelled" || reason === "correlatorCapacityExceeded") return;
    const eventKeys = displayIngestEventKeys(result);
    if (reason === "timeout") {
      // timeout は新 lifecycle の表示。旧 EventID の receipt が残っていてもここで切り替える。
      this.remove(sourceIdentity);
      this.removeConsumed(sourceIdentity);
      const expiresAtMs = sourceReceivedAtMs(outcome, nowMs) + LEGACY_DISPLAY_RECEIPT_RETENTION_MS;
      if (eventKeys.length === 0 || nowMs > expiresAtMs) return;
      this.evictIfFull();
      const record: DisplayReceipt = {
        sourceIdentity,
        generation: this.nextGeneration++,
        createdOrder: this.nextCreatedOrder++,
        expiresAtMs,
        sourceVersionToken: sourceVersionToken(outcome),
        eventKeys: new Set(),
        keyOverflowed: false,
        timer: null,
      };
      this.records.set(sourceIdentity, record);
      this.addKeys(record, eventKeys);
      this.arm(record, nowMs);
      return;
    }

    const record = this.records.get(sourceIdentity);
    if (record == null) return;
    if (nowMs > record.expiresAtMs) {
      this.remove(sourceIdentity, record);
      return;
    }
    this.addKeys(record, eventKeys);
    record.sourceVersionToken = sourceVersionToken(outcome);
  }

  viewForLateAction(
    sourceIdentity: string,
    sourceOutcome: LegacyCounterpartOutcome,
    nowMs: number,
  ): DisplayReceiptView | null {
    const record = this.records.get(sourceIdentity);
    if (record == null) return null;
    if (nowMs > record.expiresAtMs) {
      this.remove(sourceIdentity, record);
      return null;
    }
    if (record.sourceVersionToken !== sourceVersionToken(sourceOutcome)) return null;
    if (record.keyOverflowed || record.eventKeys.size === 0) return null;
    return {
      record,
      generation: record.generation,
      sourceEventKeys: [...record.eventKeys],
    };
  }

  wasConsumedForLateAction(
    sourceIdentity: string,
    sourceOutcome: LegacyCounterpartOutcome,
    nowMs: number,
  ): boolean {
    const consumed = this.consumed.get(sourceIdentity);
    if (consumed == null) return false;
    if (nowMs > consumed.expiresAtMs) {
      this.removeConsumed(sourceIdentity, consumed);
      return false;
    }
    return consumed.sourceVersionToken === sourceVersionToken(sourceOutcome);
  }

  consume(view: DisplayReceiptView): boolean {
    if (
      this.records.get(view.record.sourceIdentity) !== view.record
      || view.record.generation !== view.generation
    ) return false;
    this.remove(view.record.sourceIdentity, view.record);
    const consumed: ConsumedDisplayReceipt = {
      generation: view.generation,
      createdOrder: this.nextCreatedOrder++,
      expiresAtMs: view.record.expiresAtMs,
      sourceVersionToken: view.record.sourceVersionToken,
      timer: null,
    };
    this.evictIfFull();
    this.consumed.set(view.record.sourceIdentity, consumed);
    this.armConsumed(view.record.sourceIdentity, consumed);
    return true;
  }

  dispose(): void {
    for (const record of this.records.values()) this.clearTimer(record);
    this.records.clear();
    for (const [sourceIdentity, consumed] of this.consumed) {
      this.removeConsumed(sourceIdentity, consumed);
    }
  }

  private addKeys(record: DisplayReceipt, eventKeys: readonly string[]): void {
    if (record.keyOverflowed) return;
    for (const eventKey of eventKeys) {
      if (record.eventKeys.has(eventKey)) continue;
      if (record.eventKeys.size >= LEGACY_DISPLAY_RECEIPT_EVENT_KEY_CAPACITY) {
        record.keyOverflowed = true;
        return;
      }
      record.eventKeys.add(eventKey);
    }
  }

  private evictIfFull(): void {
    if (this.records.size + this.consumed.size < LEGACY_DISPLAY_RECEIPT_CAPACITY) return;
    const oldestRecord = [
      ...[...this.records.values()].map((record) => ({
        kind: "record" as const,
        sourceIdentity: record.sourceIdentity,
        createdOrder: record.createdOrder,
        record,
      })),
      ...[...this.consumed.entries()].map(([sourceIdentity, consumed]) => ({
        kind: "consumed" as const,
        sourceIdentity,
        createdOrder: consumed.createdOrder,
        consumed,
      })),
    ]
      .sort((left, right) => left.createdOrder - right.createdOrder)[0];
    if (oldestRecord?.kind === "record") this.remove(oldestRecord.sourceIdentity, oldestRecord.record);
    if (oldestRecord?.kind === "consumed") this.removeConsumed(oldestRecord.sourceIdentity, oldestRecord.consumed);
  }

  private arm(record: DisplayReceipt, nowMs = this.clock.nowMs()): void {
    this.clearTimer(record);
    const delayMs = Math.max(0, record.expiresAtMs + 1 - nowMs);
    const generation = record.generation;
    try {
      record.timer = this.scheduler.set(delayMs, () => {
        if (
          this.records.get(record.sourceIdentity) !== record
          || record.generation !== generation
        ) return;
        record.timer = null;
        const nowMs = this.clock.nowMs();
        if (nowMs <= record.expiresAtMs) {
          this.arm(record);
          return;
        }
        this.records.delete(record.sourceIdentity);
      });
    } catch {
      // timer を張れない receipt は late reconcile の根拠に残さない。
      this.records.delete(record.sourceIdentity);
    }
  }

  private clearTimer(record: DisplayReceipt): void {
    if (record.timer == null) return;
    try {
      this.scheduler.clear(record.timer);
    } catch {
      // disposal must not leave the receipt map half alive when a DI scheduler fails.
    } finally {
      record.timer = null;
    }
  }

  private armConsumed(sourceIdentity: string, consumed: ConsumedDisplayReceipt, nowMs = this.clock.nowMs()): void {
    this.clearConsumedTimer(consumed);
    const delayMs = Math.max(0, consumed.expiresAtMs + 1 - nowMs);
    const generation = consumed.generation;
    try {
      consumed.timer = this.scheduler.set(delayMs, () => {
        if (
          this.consumed.get(sourceIdentity) !== consumed
          || consumed.generation !== generation
        ) return;
        consumed.timer = null;
        const nowMs = this.clock.nowMs();
        if (nowMs <= consumed.expiresAtMs) {
          this.armConsumed(sourceIdentity, consumed);
          return;
        }
        this.consumed.delete(sourceIdentity);
      });
    } catch {
      // timer を張れない consumed marker は重送抑止の根拠に残さない。
      this.consumed.delete(sourceIdentity);
    }
  }

  private clearConsumedTimer(consumed: ConsumedDisplayReceipt): void {
    if (consumed.timer == null) return;
    try {
      this.scheduler.clear(consumed.timer);
    } catch {
      // disposal must not leave the consumed marker half alive when a DI scheduler fails.
    } finally {
      consumed.timer = null;
    }
  }

  private remove(sourceIdentity: string, expected?: DisplayReceipt): void {
    const record = this.records.get(sourceIdentity);
    if (record == null || (expected != null && record !== expected)) return;
    this.clearTimer(record);
    this.records.delete(sourceIdentity);
  }

  private removeConsumed(sourceIdentity: string, expected?: ConsumedDisplayReceipt): void {
    const consumed = this.consumed.get(sourceIdentity);
    if (consumed == null || (expected != null && consumed !== expected)) return;
    this.clearConsumedTimer(consumed);
    this.consumed.delete(sourceIdentity);
  }
}

// ── 電文分類 (Route) ──
//
// Route 型・分類関数 (classifyMessage)・head.type 集合・優先順位はすべて
// `route-catalog.ts` に集約した。ここでは既存 import 互換のため Route を再 export する。

export type { Route } from "./route-catalog";

// ── dispatch helpers ──

/** 通知のみ実行 (filter 非適用) */
function dispatchNotify(outcome: ProcessOutcome, notifier: Notifier): boolean {
  if (outcome.presentation.foundationMutationAccepted === false) return false;
  if (
    ["tornado", "heatAlert", "typhoonAnalysis", "typhoonProbability", "nankaiTrough",
      "weatherWarningTimeseries", "lgObservation"].includes(outcome.domain)
    && outcome.presentation.standbyStateMutationAccepted === false
  ) return false;
  switch (outcome.domain) {
    case "eew":
      notifier.notifyEew(outcome.parsed, outcome.eewResult);
      return true;
    case "earthquake":
      notifier.notifyEarthquake(outcome.parsed);
      return true;
    case "seismicText":
      notifier.notifySeismicText(outcome.parsed);
      return true;
    case "lgObservation":
      notifier.notifyLgObservation(outcome.parsed);
      return true;
    case "tsunami":
      notifier.notifyTsunami(outcome.parsed);
      return true;
    case "nankaiTrough":
      notifier.notifyNankaiTrough(outcome.parsed, outcome.presentation.soundLevel);
      return true;
    case "weather": {
      // 官署欠落などで authoritative subject を確定できなかった VPWW56 は
      // ticker 表示だけへ流し、OS 通知・通知音・notified 統計には数えない。
      if (
        outcome.headType === "VPWW56"
        && outcome.presentation.weatherStateMutationAccepted !== true
      ) return false;
      const diff = outcome.presentation.weatherDiff;
      // 変化なし (再掲対象でなければ) は通知を抑制 (spec §4.3)
      const acceptedVpws50Correction = isVpws50StateHeadType(outcome.headType)
        && outcome.parsed.infoType === "訂正";
      if (diff?.isUnchanged && !diff.shouldRecap && !acceptedVpws50Correction) {
        return false;
      }
      // Codex 最終レビュー F-3: processWeather の unsafe 昇格 (soundLevel="warning") を
      // notifier 内の weatherSoundLevel 再計算で潰さないよう presentation.soundLevel を渡す
      notifier.notifyWeatherWarning(outcome.parsed, outcome.presentation.soundLevel);
      return true;
    }
    case "tornado":
      // weather F-3 の横展開: notifier 内再計算との drift を防ぐ
      notifier.notifyTornadoAdvisory(outcome.parsed, outcome.presentation.soundLevel);
      return true;
    case "briefing":
      // weather F-3 の横展開: notifier 内再計算との drift を防ぐ
      notifier.notifyWeatherBriefing(outcome.parsed, outcome.presentation.soundLevel);
      return true;
    case "earlyWeather":
      notifier.notifyEarlyWeather(outcome.parsed);
      return true;
    case "weatherWarningTimeseries":
      notifier.notifyWeatherWarningTimeseries(outcome.parsed);
      return true;
    case "climateInfo":
      notifier.notifyClimateInfo(outcome.parsed);
      return true;
    case "weatherExplanation":
      notifier.notifyWeatherExplanation(outcome.parsed);
      return true;
    case "heatAlert":
      // 再計算 drift 予防: presentation.soundLevel を第 2 引数で渡す (weather F-3 の横展開)
      notifier.notifyHeatAlert(outcome.parsed, outcome.presentation.soundLevel);
      return true;
    case "typhoonAnalysis":
      notifier.notifyTyphoonAnalysis(outcome.parsed, outcome.presentation.soundLevel);
      return true;
    case "typhoonProbability": {
      if (outcome.presentation.suppressNotify) return false;
      notifier.notifyTyphoonProbability(
        outcome.parsed,
        outcome.presentation.soundLevel,
      );
      return true;
    }
    case "floodForecast": {
      if (outcome.presentation.floodStateMutationAccepted !== true) return false;
      // suppressNotify=true (VXKO 通常発表で station 内容変化なし) は通知を抑制
      if (outcome.presentation.suppressNotify) return false;
      notifier.notifyFloodForecast(
        outcome.parsed,
        outcome.presentation.soundLevel,
      );
      return true;
    }
    case "legacyCounterpart":
      return notifier.notifyLegacyCounterpart(
        outcome.parsed,
        outcome.severity === "high",
      );
    case "raw":
      // raw: 通知なし (フォールバック表示のみ)
      return false;
    case "volcano":
      // 特殊ルート: 火山は VolcanoRouteHandler が通知を担当するため dispatchNotify には到達しない。
      // 網羅性のため明示的に no-op で受ける。
      return false;
    default:
      // PresentationDomain に新メンバーが増えて case を足し忘れるとコンパイルエラー。
      assertNever(outcome);
  }
}

/** outcome.stats に基づいて統計を記録する */
function recordStats(outcome: ProcessOutcome, stats: TelegramStats, nowMs?: number): void {
  if (outcome.stats.shouldRecord) {
    stats.record({
      headType: outcome.headType,
      category: outcome.statsCategory,
      eventId: outcome.stats.eventId,
    }, nowMs);
  }
  if (outcome.stats.maxIntUpdate) {
    const u = outcome.stats.maxIntUpdate;
    stats.updateMaxInt(u.eventId, u.maxInt, u.headType, nowMs);
  }
}

/** 情報ディスプレイ向け DisplayStatsV1 を組み立てる (毎回 fresh object を返す) */
function buildDisplayStats(
  summary: SummaryWindowTracker,
  stats: TelegramStats,
  daily: DailyQuakeCounter,
  persistenceSalvageDiagnostics: (() => {
    persistenceSalvageBackupBlocked: number;
    persistenceSalvageBackupRecovered: number;
    pendingSources: number;
  }) | undefined,
  now?: number,
): DisplayStatsV1 {
  const s = summary.getSnapshot(now);
  const d = daily.getSnapshot(now);
  const repair = persistenceSalvageDiagnostics?.() ?? {
    persistenceSalvageBackupBlocked: 0,
    persistenceSalvageBackupRecovered: 0,
    pendingSources: 0,
  };
  return {
    sparklineData: s.sparklineData,
    totalReceived: stats.totalCount(now),
    todayQuakeCount: d.todayQuakeCount,
    todayMaxInt: d.todayMaxInt,
    todayMaxIntRank: d.todayMaxIntRank,
    persistenceSalvageBackupBlocked: repair.persistenceSalvageBackupBlocked,
    persistenceSalvageBackupRecovered: repair.persistenceSalvageBackupRecovered,
    persistenceSalvageBackupPendingSources: repair.pendingSources,
    revisionCapacityExceeded: stats.getSnapshot(now).foundation.capacityExceeded,
  };
}

// ── ファクトリ ──

/**
 * 分類済みの全電文を観測できる汎用購読点。
 *
 * `classifyMessage()` 直後 (ignore 早期 return・火山分岐・各種 suppression より前) に
 * 同期呼び出しされる。ignore / raw / 後段 suppressed / 火山を含む「XML かつ分類済みの
 * 全電文」が渡る。
 *
 * 契約: 重い処理をここに置かない (キュー投入や軽量な記録までに留める)。tap 内の例外は
 * 呼び出し側で握り潰され本体処理には波及しないが、その分の失敗は listener 側の責務。
 */
export type RoutedMessageTap = (event: {
  route: Route;
  message: ReadonlyDeep<WsDataMessage>;
}) => void;

/** tap の throw/reject 値を安全に文字列化する (null や非 Error でも二次例外を出さない) */
function describeTapError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** raw fallback は画面から抑止するが、未対応電文の受信事実は 1 件ずつ観測可能にする。 */
function logUnknownRawFallback(msg: WsDataMessage): void {
  const receivedAtMs = msg.meta?.receivedAtMs;
  const receivedAt = receivedAtMs != null && Number.isFinite(receivedAtMs)
    ? new Date(receivedAtMs)
    : new Date();
  log.info(
    `[unknown-telegram] type=${msg.head.type} receivedAt=${receivedAt.toISOString()}`,
  );
}

/**
 * 処理済み outcome を観測できる汎用購読点。
 *
 * `runDisplayPipeline()` の入口 (shouldDisplay 判定・diff 適用より前) で同期呼び出しされる。
 * 線形ルートの ProcessOutcome に加えて火山単発・火山バッチ (VolcanoBatchOutcome) も渡る。
 * suppressed で null に落ちた電文は通らない (処理済み outcome が存在するもののみ)。
 *
 * 契約: 重い処理をここに置かない (キュー投入や軽量な記録までに留める)。tap 内の例外は
 * 呼び出し側で握り潰され本体処理には波及しないが、その分の失敗は listener 側の責務。
 */
export type ProcessedOutcomeTap = (
  outcome: ProcessOutcome | VolcanoBatchOutcome,
) => void;

/** createMessageHandler のオプション */
export interface MessageHandlerOptions {
  pipeline?: FilterTemplatePipeline;
  display?: DisplayCallbacks;
  displaySink?: DisplayIngestSink;
  /** Unit 4 が telegram-stats へ接続する card mutation の generation 境界。 */
  onCardMutationApplied?: (event: DisplayCardMutationMetricEvent) => void;
  /** 分類済みの全電文を観測する汎用 tap (同期・軽量前提)。@see RoutedMessageTap */
  routeTaps?: readonly RoutedMessageTap[];
  /** 処理済み outcome を観測する汎用 tap (同期・軽量前提)。@see ProcessedOutcomeTap */
  outcomeTaps?: readonly ProcessedOutcomeTap[];
  /** monitor 所有の日次地震状態。未指定時は従来どおり handler 専用の instance を作る。 */
  dailyQuakeCounter?: DailyQuakeCounter;
  /** monitor が永続状態を復元するときに同一 instance を注入する。 */
  vpws50State?: Vpws50StateHolder;
  vpww56State?: Vpww56StateHolder;
  tsunamiState?: TsunamiStateHolder;
  volcanoState?: VolcanoStateHolder;
  floodForecastState?: FloodForecastStateHolder;
  typhoonProbabilityState?: TyphoonProbabilityStateHolder;
  /** durable revision watermark の復元用。 */
  revisionGate?: TelegramRevisionGate;
  persistenceAdmission?: StandbyPersistenceAdmissionCoordinator;
  volcanoTransactionCoordinator?: VolcanoTransactionCoordinator;
  /** 最初の durable domain が v1 表示復元状態を脱したことを monitor へ伝える。 */
  onVpws50RevisionDecision?: (decision: TelegramRevisionDecision) => void;
  /** VPNO50 cross-type clear/watermark の commit 完了を persistence owner へ伝える。 */
  onVpws50StateMutationAccepted?: () => void;
  /** VPWW56 stream/gate の commit 完了を persistence owner へ伝える。 */
  onVpww56RevisionDecision?: (decision: TelegramRevisionDecision) => void;
  /** tsunami gate/item state の commit 完了を persistence owner へ伝える。 */
  onTsunamiRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  /** volcano gate/holder の commit 完了を persistence owner へ伝える。 */
  onVolcanoRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  onFloodRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  /** tornado/heat/typhoon/nankai/VPWP/VXSE62 common gate commit. */
  onStandbyRevisionDecision?: (
    decision: TelegramRevisionDecision,
    context?: { domain: string; revisionFamily: string },
  ) => void;
  /** VPTA observer only. Persistence is owned by onVptaAdmissionCompletion. */
  onVptaStandbyRevisionDecision?: (decision: TelegramRevisionDecision) => void;
  /**
   * VPTA persistence owner. Omission is tolerated only when no durable completion
   * occurs; a durable completion without this adapter poisons the router.
   */
  onVptaAdmissionCompletion?: VptaAdmissionCompletionAdapter;
  withStandbyDurableNotificationsSuppressed?: <T>(callback: () => T) => T;
  flushStandbyThrough?: (requiredSeq: number) => StandbyPersistenceFlushThroughResult;
  /** message 処理時点の process-wide capability を読む遅延 getter。 */
  getDeliveryCapabilities?: () => DeliveryCapabilities;
  getPersistenceSalvageDiagnostics?: () => {
    persistenceSalvageBackupBlocked: number;
    persistenceSalvageBackupRecovered: number;
    pendingSources: number;
  };
  /** Phase 6B integration test 用。未指定時は production correlator を handler が所有する。 */
  legacyCounterpartCorrelatorFactory?: LegacyCounterpartCorrelatorFactory;
  /** 6B後半の display receipt timer 用 clock DI。省略時は Date.now。 */
  displayReceiptClock?: DisplayReceiptClock;
  /** 6B後半の display receipt timer 用 scheduler DI。省略時は setTimeout。 */
  displayReceiptTimerScheduler?: DisplayReceiptTimerScheduler;
  /** replay など、process wall clock と業務時刻を分離する composition root 用。 */
  clock?: DisplayReceiptClock;
  /** replay は実 logger constructor を呼ばず、明示した隔離 sink を渡す。 */
  eewLogger?: EewEventLogger;
  /** replay は実 notifier constructor を呼ばず、明示した隔離 sink を渡す。 */
  notifier?: Notifier;
  /** replay は必ず専用 persistRoot を持つ cache を渡す。 */
  vpwp50Cache?: Vpwp50DetailCache;
  /** replay clock を constructor fallback へ漏らさないための明示 instance。 */
  summaryTracker?: SummaryWindowTracker;
}

/** createMessageHandler の戻り値 */
export interface MessageHandlerResult {
  handler: (msg: WsDataMessage) => void;
  eewLogger: EewEventLogger;
  eewTracker: EewTracker;
  notifier: Notifier;
  tsunamiState: TsunamiStateHolder;
  volcanoState: VolcanoStateHolder;
  vpws50State: Vpws50StateHolder;
  vpww56State: Vpww56StateHolder;
  floodForecastState: FloodForecastStateHolder;
  vpwp50Cache: Vpwp50DetailCache;
  tornadoDetailProvider: TornadoDetailProvider;
  stats: TelegramStats;
  summaryTracker: SummaryWindowTracker;
  dailyQuakeCounter: DailyQuakeCounter;
  /** 起動直後と display on 時に明示 publish する stats snapshot。 */
  buildDisplayStats: (now?: number) => DisplayStatsV1;
  flushAndDisposeVolcanoBuffer: () => void;
  /** handler 所有の legacy correlator／timerを冪等に破棄する唯一の口。 */
  disposeLegacyCounterpartCorrelator: () => void;
  /** replay final flush が router の同期 queue を確認するための read-only hook。 */
  getReplayQuiescence: () => { pendingEnvelopes: number; serializerOwnerActive: boolean };
}

/** 受信データのハンドリング */
export function createMessageHandler(options?: MessageHandlerOptions): MessageHandlerResult {
  const pipeline: FilterTemplatePipeline = options?.pipeline ?? { filter: null, template: null, focus: null };
  const display = options?.display;
  const displaySink = options?.displaySink;
  const hasInjectedBusinessClock = options?.clock != null;
  const routerClock: DisplayReceiptClock = options?.clock ?? { nowMs: () => Date.now() };
  const displayReceiptClock: DisplayReceiptClock = options?.displayReceiptClock ?? routerClock;
  const displayReceiptTimerScheduler: DisplayReceiptTimerScheduler =
    options?.displayReceiptTimerScheduler ?? {
      set: (delayMs, callback) => setTimeout(callback, delayMs),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  const displayReceipts = new LegacyDisplayReceiptStore(
    displayReceiptClock,
    displayReceiptTimerScheduler,
  );
  const routeTaps = options?.routeTaps;
  const outcomeTaps = options?.outcomeTaps;
  const eewLogger = options?.eewLogger ?? new EewEventLogger();
  const notifier = options?.notifier ?? new Notifier();
  const tsunamiState = options?.tsunamiState ?? new TsunamiStateHolder();
  const volcanoState = options?.volcanoState ?? new VolcanoStateHolder();
  const vpws50State = options?.vpws50State ?? new Vpws50StateHolder();
  const vpww56State = options?.vpww56State ?? new Vpww56StateHolder();
  const vpwp50Cache = options?.vpwp50Cache ?? new Vpwp50DetailCache();
  const tornadoDetailProvider = new TornadoDetailProvider();
  const typhoonProbabilityState = options?.typhoonProbabilityState
    ?? new TyphoonProbabilityStateHolder();
  const floodForecastState = options?.floodForecastState ?? new FloodForecastStateHolder();
  const stats = new TelegramStats();
  const summaryTracker = options?.summaryTracker ?? new SummaryWindowTracker();
  const dailyQuakeCounter = options?.dailyQuakeCounter
    ?? (hasInjectedBusinessClock ? new DailyQuakeCounter(routerClock.nowMs()) : new DailyQuakeCounter());
  const diffStore = new PresentationDiffStore();
  const vptaDisplayCommands = new WeakMap<ProcessOutcome, VptaDisplayIngestCommand>();
  const vptaAdmissionCompletions = new WeakMap<ProcessOutcome, Extract<VptaAdmissionCompletion, { kind: "accepted" }>>();
  const transportDedup = new TelegramTransportDeduplicator();
  const revisionGate = options?.revisionGate ?? new TelegramRevisionGate();
  const pendingEnvelopes: RouterEnvelope[] = [];
  let pendingEnvelopeBytes = 0;
  let serializerOwnerActive = false;
  let serializerPoisonError: RouterSerializerPoisonedError | null = null;
  let nextEnvelopeOrdinal = 1;
  let turnRequiredPersistenceSeq = 0;
  let turnDurableFloorSatisfiedSeq = 0;
  let turnPersistenceCause: unknown | null = null;
  let turnPersistenceDispatchFailed = false;

  const poisonSerializer = (cause: unknown): RouterSerializerPoisonedError => {
    if (serializerPoisonError == null) {
      serializerPoisonError = cause instanceof RouterSerializerPoisonedError
        ? cause
        : new RouterSerializerPoisonedError(cause);
    }
    pendingEnvelopes.length = 0;
    pendingEnvelopeBytes = 0;
    return serializerPoisonError;
  };

  const assertSerializerHealthy = (): void => {
    if (serializerPoisonError != null) throw serializerPoisonError;
  };
  let lastStatsNowMs = Number.NEGATIVE_INFINITY;
  const statsNowMs = (rawNowMs: number): number => {
    lastStatsNowMs = Math.max(lastStatsNowMs, rawNowMs);
    return lastStatsNowMs;
  };
  let activeMessageStatsNowMs: number | null = null;
  const callbackStatsNowMs = (): number => statsNowMs(activeMessageStatsNowMs ?? routerClock.nowMs());
  const withMessageStatsTime = <T>(nowMs: number, callback: () => T): T => {
    activeMessageStatsNowMs = nowMs;
    try {
      return callback();
    } finally {
      activeMessageStatsNowMs = null;
    }
  };
  const recordWindowTrackers = (
    event: PresentationEvent,
    displayed: boolean,
    injectedNowMs?: number,
  ): void => {
    if (!hasInjectedBusinessClock) {
      summaryTracker.record(event, displayed);
      dailyQuakeCounter.record(event);
      return;
    }
    const trackerNowMs = injectedNowMs ?? activeMessageStatsNowMs ?? routerClock.nowMs();
    summaryTracker.record(event, displayed, trackerNowMs);
    dailyQuakeCounter.record(event, trackerNowMs);
  };
  let highestCardMutationGeneration = 0;
  const emitCardMutationApplied = (event: DisplayCardMutationMetricEvent | undefined): void => {
    if (event == null || event.generation <= highestCardMutationGeneration) return;
    highestCardMutationGeneration = event.generation;
    const metric = event.kind === "ingest"
      ? "legacyCardDisplayed"
      : "legacyCardReconciled";
    stats.recordFoundationForHeadType(event.sourceType, metric, callbackStatsNowMs());
    if (event.evictedKey != null) {
      stats.recordFoundationForHeadType(event.sourceType, "legacyCardEvicted", callbackStatsNowMs());
    }
    try {
      options?.onCardMutationApplied?.(event);
    } catch {
      // metric observer は電文処理を止めない。
    }
  };
  const eewTracker = new EewTracker({
    onCleanup: (eventId) => {
      eewLogger.closeEvent(eventId, "タイムアウト");
    },
    onRevisionDecision: (decision) => {
      switch (decision.kind) {
        case "replaceCorrection":
          stats.recordFoundation("correctionReplaced", callbackStatsNowMs());
          break;
        case "markCancelled":
          stats.recordFoundation("cancelApplied", callbackStatsNowMs());
          break;
        case "duplicate":
        case "semanticDuplicate":
          stats.recordFoundation("semanticDuplicate", callbackStatsNowMs());
          break;
        case "stale":
          stats.recordFoundation("stale", callbackStatsNowMs());
          break;
        case "invalidMeta":
          stats.recordFoundation("invalidMeta", callbackStatsNowMs());
          break;
        case "invalidRevision":
          stats.recordFoundation("invalidRevision", callbackStatsNowMs());
          break;
        case "cancelTargetMismatch":
          stats.recordFoundation("cancelTargetMismatch", callbackStatsNowMs());
          break;
        default:
          break;
      }
    },
  });

  const recordRevisionDecision = (decision: TelegramRevisionDecision): void => {
    switch (decision.kind) {
      case "replaceCorrection": stats.recordFoundation("correctionReplaced", callbackStatsNowMs()); break;
      case "markCancelled":
      case "restorePrevious":
      case "clearCurrent": stats.recordFoundation("cancelApplied", callbackStatsNowMs()); break;
      case "duplicate":
      case "semanticDuplicate": stats.recordFoundation("semanticDuplicate", callbackStatsNowMs()); break;
      case "stale": stats.recordFoundation("stale", callbackStatsNowMs()); break;
      case "invalidMeta": stats.recordFoundation("invalidMeta", callbackStatsNowMs()); break;
      case "invalidRevision": stats.recordFoundation("invalidRevision", callbackStatsNowMs()); break;
      case "cancelTargetMismatch": stats.recordFoundation("cancelTargetMismatch", callbackStatsNowMs()); break;
      case "capacityExceeded": stats.recordFoundation("capacityExceeded", callbackStatsNowMs()); break;
      default: break;
    }
  };

  const processDeps: ProcessDeps = {
    eewTracker,
    eewLogger,
    tsunamiState,
    volcanoState,
    vpws50State,
    vpww56State,
    floodForecastState,
    vpwp50Cache,
    tornadoDetailProvider,
    typhoonProbabilityState,
    revisionGate,
    persistenceAdmission: options?.persistenceAdmission,
    onRevisionDecision: recordRevisionDecision,
    onVpws50RevisionDecision: options?.onVpws50RevisionDecision,
    onVpws50StateMutationAccepted: options?.onVpws50StateMutationAccepted,
    onVpww56RevisionDecision: options?.onVpww56RevisionDecision,
    onTsunamiRevisionDecision: options?.onTsunamiRevisionDecision,
    onFloodRevisionDecision: options?.onFloodRevisionDecision,
    onStandbyRevisionDecision: options?.onStandbyRevisionDecision,
    onVptaStandbyRevisionDecision: options?.onVptaStandbyRevisionDecision,
    assertRouterSerializerHealthy: assertSerializerHealthy,
    onVptaAdmissionCompletion: (completion) => {
      assertVptaAdmissionCompletion(completion);
      let ack: VptaPersistenceCompletionAck;
      try {
        const adapter = options?.onVptaAdmissionCompletion;
        if (adapter == null) {
          if (completion.durableChanged) {
            throw new Error("VPTA durable completion persistence adapter is not configured");
          }
          ack = { kind: "notRequired" };
        } else {
          ack = adapter(completion);
        }
      } catch (cause) {
        ack = {
          kind: "failed", operation: "completionCallback",
          completionAlreadyEmitted: true, receipt: null, cause,
        };
      }
      if (ack.kind === "scheduled" || ack.kind === "flushed") {
        turnRequiredPersistenceSeq = Math.max(turnRequiredPersistenceSeq, ack.receipt.seq);
        if (ack.kind === "flushed") {
          turnDurableFloorSatisfiedSeq = Math.max(
            turnDurableFloorSatisfiedSeq,
            ack.result.writtenSeq,
          );
        }
      } else if (ack.kind === "failed") {
        if (ack.receipt != null) {
          turnRequiredPersistenceSeq = Math.max(turnRequiredPersistenceSeq, ack.receipt.seq);
        }
        turnPersistenceCause = ack.cause;
        turnPersistenceDispatchFailed = true;
        poisonSerializer(ack.cause);
      }
      return ack;
    },
    activeTyphoonProbabilitySubjects: (nowMs) => {
      const provider = displaySink?.activeTyphoonProbabilitySubjects;
      return provider == null ? [] : provider(nowMs);
    },
    activeWeatherWarningForecastSubjects: (nowMs) => {
      const provider = displaySink?.activeWeatherWarningForecastSubjects;
      return provider == null ? [] : provider(nowMs);
    },
    maintainTyphoonProbabilitySubjects: (nowMs, activeGateSubjects) =>
      displaySink?.maintainTyphoonProbabilitySubjects?.(nowMs, activeGateSubjects)
        ?? { viewChanged: false, durableChanged: false },
    maintainWeatherWarningForecastSubjects: (nowMs, activeGateSubjects) =>
      displaySink?.maintainWeatherWarningForecastSubjects?.(nowMs, activeGateSubjects)
        ?? { viewChanged: false, durableChanged: false },
    reconcileTyphoonProbabilitySubject: (eventId) =>
      displaySink?.reconcileTyphoonProbabilitySubject?.(eventId)
        ?? { viewChanged: false, durableChanged: false },
    getDeliveryCapabilities: options?.getDeliveryCapabilities
      ?? (() => createUnknownDeliveryCapabilities()),
    onVxse44Suppressed: (reason) => {
      stats.recordFoundationForHeadType(
        "VXSE44",
        reason === "observed-vxse45"
          ? "vxse44SuppressedByObservedVxse45"
          : "vxse44SuppressedByCapability",
        callbackStatsNowMs(),
      );
    },
  };

  /**
   * 共通の表示パイプライン処理。
   * filter/diffStore/summaryTracker/focus/template/compact の6ステップを一元的に実行する。
   * @returns true なら表示済み。false ならフィルタで非表示。
   */
  function runDisplayPipeline(
    outcome: ProcessOutcome | VolcanoBatchOutcome,
    displayFn: () => void,
    statsAtMs?: number,
    displayIngestOverride?: DisplayIngestOperation,
    displayIngestCapture?: DisplayIngestCapture,
  ): boolean {
    // 処理済み outcome の汎用 tap (filter 非適用: shouldDisplay の判定より前)。
    // 線形ルート・火山単発・火山バッチの全 outcome がここを通る。例外は本体へ波及させない。
    if (outcomeTaps) {
      for (const tap of outcomeTaps) {
        try {
          const result = tap(outcome) as unknown;
          if (result instanceof Promise) {
            result.catch((e: unknown) => {
              log.warn(`[outcome-tap] async tap の reject: ${describeTapError(e)}`);
            });
          }
        } catch (e) {
          log.warn(`[outcome-tap] tap 実行で例外: ${describeTapError(e)}`);
        }
        // tap が同期再入 overload を捕捉しても sticky latch はここで必ず観測する。
        assertSerializerHealthy();
      }
    }

    const rawEvent: PresentationEvent = toPresentationEvent(outcome);
    const event = diffStore.apply(rawEvent);

    const displayed = shouldDisplay(event, pipeline);
    recordWindowTrackers(event, displayed, statsAtMs); // ← ingest より先 (1 イベント遅れ防止)
    try {
      const isVolcanoBatch =
        outcome.domain === "volcano" && "isBatch" in outcome && outcome.isBatch === true;
      if (isVolcanoBatch && outcome.sources.length > 0) {
        for (const volcanoEvent of expandVolcanoBatchForDisplay(outcome)) {
          const result = displaySink?.ingest(volcanoEvent);
          const tickerResult = tickerResultOf(result);
          const cardResult = cardResultOf(result);
          if (displayIngestCapture != null) {
            if (tickerResult != null) displayIngestCapture.result = tickerResult;
            if (cardResult != null) displayIngestCapture.cardResult = cardResult;
          }
          emitCardMutationApplied(cardMutationMetric(cardResult, "ingest", volcanoEvent.type));
        }
      } else {
        const vptaDisplayCommand = vptaDisplayCommands.get(outcome as ProcessOutcome);
        const result = displayIngestOverride == null
          ? displaySink?.ingest(event, vptaDisplayCommand)
          : displayIngestOverride(event);
        if (vptaDisplayCommand != null) vptaDisplayCommands.delete(outcome as ProcessOutcome);
        const tickerResult = tickerResultOf(result);
        const cardResult = cardResultOf(result);
        if (displayIngestCapture != null) {
          if (tickerResult != null) displayIngestCapture.result = tickerResult;
          if (cardResult != null) displayIngestCapture.cardResult = cardResult;
        }
        emitCardMutationApplied(cardMutationMetric(
          cardResult,
          displayIngestOverride == null ? "ingest" : "reconcile",
          event.type,
        ));
      }
      displaySink?.publishStats?.(buildDisplayStats(
        summaryTracker, stats, dailyQuakeCounter, options?.getPersistenceSalvageDiagnostics, statsAtMs,
      ));
    } catch {
      // 表示系の障害を本体に波及させない
    }
    assertSerializerHealthy();

    if (!displayed) {
      return false;
    }

    const isFocused = pipeline.focus == null || pipeline.focus(event);
    if (!isFocused && display) {
      console.log(chalk.dim(display.renderSummaryLine(event)));
      return true;
    }

    const templateOutput = renderTemplate(event, pipeline);
    if (templateOutput != null) {
      console.log(templateOutput);
      return true;
    }

    if (display && display.getDisplayMode() === "compact") {
      console.log(display.renderSummaryLine(event));
      return true;
    }

    displayFn();
    return true;
  }

  function emitAcceptedOutcome(
    outcome: ProcessOutcome,
    actionNowMs: number,
    allowNotification = true,
    displayIngestOverride?: DisplayIngestOperation,
  ): { notified: boolean; presented: boolean; displayIngestResult?: DisplayIngestResult } {
    const notified = allowNotification && dispatchNotify(outcome, notifier);
    assertSerializerHealthy();
    const acceptedCorrection = outcome.domain === "eew"
      ? outcome.eewResult.isCorrection === true
      : outcome.presentation.acceptedCorrection === true;
    if (acceptedCorrection && notified) {
      stats.recordFoundation("correctionNotified", actionNowMs);
    }
    if (notified) stats.recordFoundation("notified", actionNowMs);
    const displayIngestCapture: DisplayIngestCapture = {};
    const presented = runDisplayPipeline(
      outcome,
      () => display?.displayOutcome(outcome),
      actionNowMs,
      displayIngestOverride,
      displayIngestCapture,
    );
    if (presented) stats.recordFoundation("presented", actionNowMs);
    return {
      notified,
      presented,
      ...(displayIngestCapture.result == null
        ? {}
        : { displayIngestResult: displayIngestCapture.result }),
    };
  }

  /**
   * VPTA50 は standby reducer の mutation evidence を persistence completion より
   * 前に確定する必要があるため、汎用表示 pipeline と混ぜず同じ順序を明示する。
   */
  function emitAcceptedVptaOutcome(
    outcome: ProcessOutcome,
    command: VptaDisplayIngestCommand,
    acceptedCompletion: Extract<VptaAdmissionCompletion, { kind: "accepted" }>,
    actionNowMs: number,
  ): void {
    const changes = { ...acceptedCompletion.changes };
    let stage: VptaFailureStage = "recordStats";
    let displayed = false;
    let event: PresentationEvent | null = null;
    let displayResult: DisplayIngestResult | DisplayIngestOutcome | void | number;

    const failBeforeCompletion = (cause: unknown): never => {
      const causes: unknown[] = [cause];
      try {
        const reconciliation = displaySink?.reconcileTyphoonProbabilityCommand?.(command);
        changes.projectionOrRetention ||= reconciliation?.durableChanged === true;
      } catch (reconcileCause) {
        causes.push(reconcileCause);
      }
      const durableChanged = changes.gateExpiry || changes.projectionCleanup
        || changes.incomingGate || changes.projectionOrRetention;
      const completion: VptaAdmissionCompletion = durableChanged
        ? {
            kind: "failed", nowMs: acceptedCompletion.nowMs, durableChanged: true,
            persistence: "immediate", changes: { ...changes }, stage,
          }
        : {
            kind: "failed", nowMs: acceptedCompletion.nowMs, durableChanged: false,
            persistence: "none", changes: { ...changes }, stage,
          };
      try {
        processDeps.onVptaAdmissionCompletion?.(completion);
      } catch (completionCause) {
        causes.push(completionCause);
      }
      if (causes.length === 1) throw causes[0];
      throw new AggregateError(causes, "VPTA50 post-gate admission failed");
    };

    try {
      stage = "recordStats";
      recordStats(outcome, stats, actionNowMs);
      assertSerializerHealthy();

      stage = "correlator";
      const action = legacyCounterpartCorrelator.accept(outcome);
      if (action == null || action.kind !== "emitNow") {
        throw new Error("VPTA50 correlator invariant failed");
      }
      assertSerializerHealthy();

      stage = "notifier";
      const notified = dispatchNotify(outcome, notifier);
      assertSerializerHealthy();

      stage = "postNotifierStats";
      if (outcome.presentation.acceptedCorrection === true && notified) {
        stats.recordFoundation("correctionNotified", actionNowMs);
      }
      if (notified) stats.recordFoundation("notified", actionNowMs);
      assertSerializerHealthy();

      if (outcomeTaps) {
        for (const tap of outcomeTaps) {
          try {
            const result = tap(outcome) as unknown;
            if (result instanceof Promise) {
              result.catch((error: unknown) => {
                log.warn(`[outcome-tap] async tap の reject: ${describeTapError(error)}`);
              });
            }
          } catch (error) {
            log.warn(`[outcome-tap] tap 実行で例外: ${describeTapError(error)}`);
          }
          if (serializerPoisonError != null) {
            stage = "outcomeTapPoison";
            throw serializerPoisonError;
          }
        }
      }

      stage = "eventConversion";
      event = toPresentationEvent(outcome);
      assertSerializerHealthy();

      stage = "displayPreprocess";
      const diffed = diffStore.apply(event);
      event = diffed;
      displayed = shouldDisplay(diffed, pipeline);
      recordWindowTrackers(diffed, displayed, actionNowMs);
      assertSerializerHealthy();

      stage = "standbyReducer";
      displayResult = displaySink?.ingest(diffed, command);
      const mutation = vptaMutationOf(displayResult);
      changes.projectionOrRetention ||= mutation?.durableChanged === true;
      const failure = vptaFailureOf(displayResult);
      if (failure != null) {
        stage = failure.stage;
        throw failure.cause;
      }
      const cardResult = cardResultOf(displayResult);
      emitCardMutationApplied(cardMutationMetric(cardResult, "ingest", diffed.type));
      assertSerializerHealthy();
    } catch (cause) {
      failBeforeCompletion(cause);
    }

    // Exactly one successful completion. Any failure from this point is presentation
    // or infrastructure work and must never synthesize a second completion.
    processDeps.onVptaAdmissionCompletion?.({
      ...acceptedCompletion,
      changes: { ...changes },
    });
    assertSerializerHealthy();

    // Post-completion presentation is deliberately best-effort. Reentrant overload is
    // still observed at every callback boundary and the outer turn flushes its floor.
    try {
      displaySink?.publishStats?.(buildDisplayStats(
        summaryTracker, stats, dailyQuakeCounter, options?.getPersistenceSalvageDiagnostics, actionNowMs,
      ));
    } catch (cause) {
      log.warn(`[vpta50-presentation] publishStats failed: ${describeTapError(cause)}`);
    }
    assertSerializerHealthy();
    if (!displayed || event == null) return;

    let focused = true;
    if (pipeline.focus != null) {
      try {
        focused = pipeline.focus(event);
      } catch (cause) {
        log.warn(`[vpta50-presentation] focus failed: ${describeTapError(cause)}`);
        focused = true;
      }
      assertSerializerHealthy();
    }

    let outputSucceeded = false;
    if (!focused && display != null) {
      try {
        console.log(chalk.dim(display.renderSummaryLine(event)));
        outputSucceeded = true;
      } catch (cause) {
        log.warn(`[vpta50-presentation] consoleOrDisplay failed: ${describeTapError(cause)}`);
      }
      assertSerializerHealthy();
    } else {
      let templateOutput: string | null = null;
      try {
        templateOutput = renderTemplate(event, pipeline);
      } catch (cause) {
        log.warn(`[vpta50-presentation] template failed: ${describeTapError(cause)}`);
      }
      assertSerializerHealthy();
      try {
        if (templateOutput != null) {
          console.log(templateOutput);
        } else if (display != null && display.getDisplayMode() === "compact") {
          console.log(display.renderSummaryLine(event));
        } else {
          display?.displayOutcome(outcome);
        }
        outputSucceeded = true;
      } catch (cause) {
        log.warn(`[vpta50-presentation] consoleOrDisplay failed: ${describeTapError(cause)}`);
      }
      assertSerializerHealthy();
    }
    if (outputSucceeded) {
      try {
        stats.recordFoundation("presented", actionNowMs);
      } catch (cause) {
        log.warn(`[vpta50-presentation] presentedStats failed: ${describeTapError(cause)}`);
      }
      assertSerializerHealthy();
    }
  }

  function sourceDispositions(action: LegacyCounterpartAction): readonly LegacyCounterpartAffectedSource[] {
    if (action.kind === "emitNow" || action.kind === "holdSource") return [];
    if (action.affectedSources != null) return action.affectedSources;
    switch (action.kind) {
      case "suppressSource":
        return [{
          kind: action.kind,
          outcome: action.outcome,
          sourceIdentity: action.sourceIdentity,
          counterpartOutcome: action.counterpartOutcome,
        }];
      case "releaseSource":
        return [{
          kind: action.kind,
          outcome: action.outcome,
          sourceIdentity: action.sourceIdentity,
          reason: action.reason,
          ...(action.displayLifecycleOnly === true ? { displayLifecycleOnly: true } : {}),
        }];
      case "ambiguousSource":
        return [{
          kind: action.kind,
          outcome: action.outcome,
          sourceIdentity: action.sourceIdentity,
          candidateCount: action.candidateCount,
          ...(action.ambiguityReason == null ? {} : { ambiguityReason: action.ambiguityReason }),
        }];
      case "reconcileLateCounterpart":
        return [{
          kind: action.kind,
          outcome: action.outcome,
          sourceOutcome: action.sourceOutcome,
          sourceIdentity: action.sourceIdentity,
        }];
    }
  }

  function recordLegacyNotificationDisposition(
    outcome: Extract<ProcessOutcome, { domain: "legacyCounterpart" }>,
    notified: boolean,
    actionNowMs: number,
  ): void {
    if (outcome.severity === "high") {
      if (notified) {
        stats.recordFoundationForHeadType(
          outcome.parsed.type,
          "legacyUnmatchedHighSeverityNotified",
          actionNowMs,
        );
      }
      return;
    }
    stats.recordFoundationForHeadType(
      outcome.parsed.type,
      outcome.severity === "nonHigh"
        ? "legacyUnmatchedNonHighNotificationSuppressed"
        : "legacySeverityUnknownNotificationSuppressed",
      actionNowMs,
    );
  }

  function handleLegacyCounterpartAction(action: LegacyCounterpartAction): void {
    const actionNowMs = statsNowMs(action.decidedAtMs);
    // receipt の寿命は stats の単調時刻とは独立させる。別電文の stats 記録が
    // 先行しても、late counterpart の照合期限を早めてはならない。
    const receiptNowMs = displayReceiptClock.nowMs();
    if (action.kind === "emitNow") {
      emitAcceptedOutcome(action.outcome, actionNowMs);
      return;
    }
    if (action.kind === "holdSource") {
      displayReceipts.beginNewLifecycle(action.sourceIdentity);
      return;
    }

    const triggerOutcome = "triggerOutcome" in action ? action.triggerOutcome : undefined;
    if (triggerOutcome != null) {
      const emitted = emitAcceptedOutcome(triggerOutcome, actionNowMs);
      const invalidatedPendingSource = sourceDispositions(action).some(
        (disposition) => disposition.kind === "releaseSource" && disposition.displayLifecycleOnly === true,
      );
      if (invalidatedPendingSource && triggerOutcome.domain === "legacyCounterpart") {
        if (emitted.presented) {
          stats.recordFoundationForHeadType(
            triggerOutcome.parsed.type,
            "legacyUnmatchedDisplayed",
            actionNowMs,
          );
        }
        if (!(triggerOutcome.parsed.type === "VPOA50" && triggerOutcome.parsed.infoType === "取消")) {
          recordLegacyNotificationDisposition(triggerOutcome, emitted.notified, actionNowMs);
        }
      }
    }

    for (const disposition of sourceDispositions(action)) {
      switch (disposition.kind) {
        case "suppressSource":
          displayReceipts.beginNewLifecycle(disposition.sourceIdentity);
          stats.recordFoundationForHeadType(
            disposition.outcome.parsed.type,
            "legacyMatchedSuppressed",
            actionNowMs,
          );
          break;
        case "releaseSource": {
          if (disposition.displayLifecycleOnly === true) {
            displayReceipts.beginNewLifecycle(disposition.sourceIdentity);
            break;
          }
          if (disposition.reason === "correlatorCapacityExceeded") {
            displayReceipts.beginNewLifecycle(disposition.sourceIdentity);
          }
          const evaluateNotification = disposition.reason !== "counterpartCancelled";
          const emitted = emitAcceptedOutcome(
            disposition.outcome,
            actionNowMs,
            evaluateNotification,
          );
          if (emitted.presented) {
            stats.recordFoundationForHeadType(
              disposition.outcome.parsed.type,
              "legacyUnmatchedDisplayed",
              actionNowMs,
            );
          }
          // VPOA50 取消だけは共通 gate 後に fail-open 表示するが、通知評価・
          // 取消用 diagnostic / metric は増やさない。他 legacy type は既存挙動を保つ。
          if (
            evaluateNotification
            && !(disposition.outcome.parsed.type === "VPOA50" && disposition.outcome.parsed.infoType === "取消")
          ) {
            recordLegacyNotificationDisposition(
              disposition.outcome,
              emitted.notified,
              actionNowMs,
            );
          }
          if (disposition.reason === "timeout" || disposition.reason === "releasedUpdate") {
            displayReceipts.recordSourceIngest(
              disposition.sourceIdentity,
              disposition.outcome,
              emitted.displayIngestResult,
              disposition.reason,
              receiptNowMs,
            );
          }
          break;
        }
        case "ambiguousSource": {
          displayReceipts.beginNewLifecycle(disposition.sourceIdentity);
          const emitted = emitAcceptedOutcome(disposition.outcome, actionNowMs, false);
          if (emitted.presented) {
            stats.recordFoundationForHeadType(
              disposition.outcome.parsed.type,
              "legacyAmbiguousDisplayed",
              actionNowMs,
            );
          }
          break;
        }
        case "reconcileLateCounterpart": {
          const receipt = displayReceipts.viewForLateAction(
            disposition.sourceIdentity,
            disposition.sourceOutcome,
            receiptNowMs,
          );
          if (
            receipt == null
            && displayReceipts.wasConsumedForLateAction(
              disposition.sourceIdentity,
              disposition.sourceOutcome,
              receiptNowMs,
            )
          ) {
            // 同じ receipt generation の typed action が重送された。初回 reconcile は
            // 完了済みなので、canonical 通常 ingest へ落とさず状態を不変に保つ。
            break;
          }
          const hasCardOnlyCapability = displaySink?.reconcileLateCounterpartCard != null;
          const hasTickerReconcileCapability = displaySink?.reconcileLateCounterpart != null;
          const displayIngestOverride: DisplayIngestOperation | undefined = (event) => {
            let sourceEvent: PresentationEvent | undefined;
            try {
              sourceEvent = toPresentationEvent(disposition.sourceOutcome);
            } catch {
              sourceEvent = undefined;
            }
            const context: DisplayLateCounterpartContext = sourceEvent == null ? {} : { sourceEvent };
            let lateResult: DisplayLateCounterpartResult | DisplayIngestResult | void = undefined;
            try {
              if (receipt != null && hasTickerReconcileCapability) {
                lateResult = displaySink?.reconcileLateCounterpart?.(
                  event,
                  receipt.sourceEventKeys,
                  context,
                );
              } else if (hasCardOnlyCapability) {
                // receipt の有無ではなく card capability で配送を決める。
                lateResult = displaySink?.reconcileLateCounterpartCard?.(event, context);
              }
            } catch {
              lateResult = undefined;
            }

            const cardResult = cardResultOf(lateResult) as DisplayCardReconcileResult | undefined;
            const tickerResult = tickerResultOf(lateResult);
            if (receipt != null && tickerResult?.kind === "applied") {
              // ticker receipt の一回性は card generation と独立する。
              if (displayReceipts.consume(receipt)) {
                stats.recordFoundationForHeadType(
                  disposition.sourceOutcome.parsed.type,
                  "legacyLateCounterpartReconciled",
                  actionNowMs,
                );
              }
              return lateResult;
            }

            // card result では ticker fallback を止めない。card capable sink には必ず
            // ticker-only 経路を使い、canonical card を二度 apply しない。
            let fallbackResult: DisplayIngestResult | void | number | DisplayIngestOutcome;
            try {
              fallbackResult = displaySink?.ingestTickerOnly?.(event);
              // card capability を持たない旧 ticker-only sink だけは既存 ingest へ戻す。
              // card capable sink は ticker-only capability が無い場合でも card を二度 apply しない。
              if (fallbackResult == null && !hasCardOnlyCapability) {
                fallbackResult = displaySink?.ingest(event);
              }
            } catch {
              fallbackResult = undefined;
            }
            const fallbackTickerResult = tickerResultOf(fallbackResult);
            return {
              ...(fallbackTickerResult == null ? {} : { tickerResult: fallbackTickerResult }),
              ...(cardResult == null ? {} : { cardResult }),
            };
          };
          if (disposition.outcome !== triggerOutcome) {
            emitAcceptedOutcome(
              disposition.outcome,
              actionNowMs,
              true,
              displayIngestOverride,
            );
          }
          break;
        }
      }
    }
  }

  function handleLegacyCounterpartLifecycleEvent(event: LegacyCounterpartLifecycleEvent): void {
    const eventNowMs = statsNowMs(event.decidedAtMs);
    switch (event.kind) {
      case "legacySourceArrivedFirst":
        stats.recordFoundationForHeadType(event.sourceType, "legacySourceArrivedFirst", eventNowMs);
        break;
      case "legacyCounterpartArrivedFirst":
        stats.recordFoundationForHeadType(event.sourceType, "legacyCounterpartArrivedFirst", eventNowMs);
        break;
      case "legacyCorrelationExpired":
        stats.recordFoundationForHeadType(event.sourceType, "legacyCorrelationExpired", eventNowMs);
        break;
      case "legacyLateCounterpartExpired":
        stats.recordFoundationForHeadType(event.sourceType, "legacyLateCounterpartExpired", eventNowMs);
        break;
      case "legacyCorrectionMismatch":
        stats.recordFoundationForHeadType(event.sourceType, "legacyCorrectionMismatch", eventNowMs);
        break;
      case "legacyCancellationMismatch":
        stats.recordFoundationForHeadType(event.sourceType, "legacyCancellationMismatch", eventNowMs);
        break;
      case "sourceCapacityExceeded":
        log.warn(`[legacy-counterpart] source capacity exceeded: ${event.sourceIdentity}`);
        break;
      case "counterpartEvicted":
        log.warn(`[legacy-counterpart] counterpart evicted: ${event.counterpartIdentity}`);
        break;
      case "counterpartCapacityBypassed":
        log.warn(`[legacy-counterpart] counterpart capacity bypassed: ${event.counterpartIdentity}`);
        break;
    }
  }

  const legacyCounterpartCorrelatorContext = {
    actionSink: handleLegacyCounterpartAction,
    lifecycleEventSink: handleLegacyCounterpartLifecycleEvent,
  };
  const legacyCounterpartCorrelator = options?.legacyCounterpartCorrelatorFactory == null
    ? new LegacyCounterpartCorrelator({
      ...(hasInjectedBusinessClock ? { clock: routerClock } : {}),
      onAction: legacyCounterpartCorrelatorContext.actionSink,
      onLifecycleEvent: legacyCounterpartCorrelatorContext.lifecycleEventSink,
    })
    : options.legacyCounterpartCorrelatorFactory(legacyCounterpartCorrelatorContext);

  // 火山ルートハンドラ
  const volcanoHandler = new VolcanoRouteHandler({
    volcanoState,
    notifier,
    runDisplayPipeline,
    display,
    revisionGate,
    volcanoTransactionCoordinator: options?.volcanoTransactionCoordinator,
    onRevisionDecision: recordRevisionDecision,
    onVolcanoRevisionDecision: options?.onVolcanoRevisionDecision,
    onFoundationNotified: (isCorrection) => {
      const nowMs = statsNowMs(routerClock.nowMs());
      stats.recordFoundation("notified", nowMs);
      if (isCorrection) stats.recordFoundation("correctionNotified", nowMs);
    },
    onFoundationPresented: () => stats.recordFoundation("presented", statsNowMs(routerClock.nowMs())),
  });

  const processEnvelope = (envelope: RouterEnvelope): void => {
    // All downstream consumers intentionally share this single frozen graph.
    // Existing parsers are read-only but accept the historical mutable type.
    const msg = envelope.message as WsDataMessage;
    if (envelope.diagnostics.testMetadataMismatch) {
      stats.recordTestMetadataMismatch(statsNowMs(msg.meta?.receivedAtMs ?? routerClock.nowMs()));
    }

    const route = envelope.route;
    let rawFallbackLogged = false;
    const logUnknownRawFallbackOnce = (): void => {
      if (rawFallbackLogged) return;
      logUnknownRawFallback(msg);
      rawFallbackLogged = true;
    };
    // policy 未定義の route は後段で raw fallback になる。早期 return でも同じ受信記録を残す。
    const fallsBackToRaw = route === "raw"
      || route !== "ignore" && !routeHasExplicitRevisionFamilyPolicy(route, msg.head.type);

    // XML電文でない場合はヘッダ情報のみ表示
    if (msg.format !== "xml" || !msg.head.xml) {
      if (fallsBackToRaw) logUnknownRawFallbackOnce();
      display?.displayRawHeader(msg);
      return;
    }

    // 分類済みの全電文を汎用 tap に通知 (ignore / raw / suppressed / 火山も含む)。
    // tap の例外は本体処理へ波及させない (Error 以外の throw 値でもログ側で二次例外を起こさない)。
    if (routeTaps) {
      for (const tap of routeTaps) {
        try {
          const result = tap({ route, message: msg }) as unknown;
          // 契約上 tap は同期だが、誤って async 関数が渡されたときも
          // reject を未処理のまま漏らさない
          if (result instanceof Promise) {
            result.catch((e: unknown) => {
              log.warn(`[route-tap] async tap の reject: ${describeTapError(e)}`);
            });
          }
        } catch (e) {
          log.warn(`[route-tap] tap 実行で例外: ${describeTapError(e)}`);
        }
        assertSerializerHealthy();
      }
    }

    // Phase 3B 完了後は ignore 以外の全 XML route が明示 policy を持つ。
    // parser 失敗も raw family へ落ちるため、transport dedup と日時診断は parse 前に共通適用する。
    const usesFoundationGate = route !== "ignore";
    if (usesFoundationGate) {
      const meta = msg.meta;
      if (meta == null) throw new Error("router normalized meta invariant failed");
      const admissionNowMs = statsNowMs(meta.receivedAtMs);
      stats.recordFoundation("received", admissionNowMs);
      if (!transportDedup.accept(meta.messageId, meta.receivedAtMs)) {
        stats.recordFoundation("transportDuplicate", admissionNowMs);
        return;
      }
      // Envelope 自体を取得できない malformed XML は既存の raw fallback へ残す。
      // ReportDateTime を読めた電文だけを日時診断へ分離する。
      const dateReason = msg.xmlReport == null ? null : telegramDateDiagnosticReason(meta);
      if (dateReason != null) {
        if (fallsBackToRaw) logUnknownRawFallbackOnce();
        const diagnostic = telegramDateDiagnostic(msg, meta, dateReason);
        stats.recordFoundation(
          dateReason === "futureSkewExceeded"
            ? "futureDateDiagnosed"
            : "invalidDateDiagnosed",
          admissionNowMs,
        );
        log.warn(
          `[telegram-date] ${diagnostic.type} EventID=${diagnostic.eventId ?? "(none)"} ReportDateTime=${diagnostic.reportDateTimeRaw ?? "(missing)"} receivedAt=${diagnostic.receivedAtIso} futureSkewMs=${diagnostic.futureSkewMs ?? "(n/a)"} reason=${diagnostic.kind}`,
        );
        display?.displayTelegramDiagnostic?.(diagnostic);
        try {
          displaySink?.ingest(dateDiagnosticPresentationEvent(msg, diagnostic));
          displaySink?.publishStats?.(
            buildDisplayStats(
              summaryTracker, stats, dailyQuakeCounter, options?.getPersistenceSalvageDiagnostics, admissionNowMs,
            ),
          );
        } catch {
          // 診断表示の配送障害を受信本体へ波及させない。
        }
        return;
      }
    }

    let processingRoute = route;
    if (route !== "ignore" && !routeHasExplicitRevisionFamilyPolicy(route, msg.head.type)) {
      log.warn(
        `[telegram-foundation] explicit revision policy missing: route=${route} type=${msg.head.type}; raw fallback`,
      );
      processingRoute = "raw";
    }

    if (processingRoute === "raw") {
      logUnknownRawFallbackOnce();
    }

    // 特殊ルート ignore: 配信終了予定 + 既存表示と重複する電文は受信しても無視
    // (表示・通知・統計をすべてスキップ)。catalog では分類のみ担い、処理はここで早期 return。
    if (route === "ignore") {
      return;
    }

    // 特殊ルート volcano: VFVO53 バッチ集約を伴う独立ライフサイクルのため線形 processor 表に
    // 載せず、VolcanoRouteHandler に委譲する (catalog は分類のみ担う)。
    let outcome: ProcessOutcome | null;
    let vptaDisplayCommand: VptaDisplayIngestCommand | undefined;
    let vptaAdmissionCompletion: Extract<VptaAdmissionCompletion, { kind: "accepted" }> | undefined;
    let vptaTransient = false;
    const messageStatsNowMs = msg.meta?.receivedAtMs ?? routerClock.nowMs();
    if (processingRoute === "volcano") {
      const result = withMessageStatsTime(messageStatsNowMs, () => volcanoHandler.handle(msg));
      if (result.kind === "accepted") {
        stats.record({
          headType: msg.head.type,
          category: routeToCategory(processingRoute),
          eventId: msg.xmlReport?.head.eventId ?? null,
        }, statsNowMs(msg.meta?.receivedAtMs ?? routerClock.nowMs()));
        return;
      }
      if (result.kind === "suppressed") return;
      const processed = withMessageStatsTime(messageStatsNowMs, () => processMsg(msg, "raw", processDeps));
      outcome = processed?.outcome ?? null;
      vptaDisplayCommand = processed?.internal?.vptaDisplayCommand;
      vptaAdmissionCompletion = processed?.internal?.completion;
      vptaTransient = processed?.internal?.transient === true;
    } else {
      // 火山以外: processMessage → recordStats → dispatchNotify → runDisplayPipeline
      const processed = withMessageStatsTime(
        messageStatsNowMs,
        () => processMsg(msg, processingRoute, processDeps),
      );
      outcome = processed?.outcome ?? null;
      vptaDisplayCommand = processed?.internal?.vptaDisplayCommand;
      vptaAdmissionCompletion = processed?.internal?.completion;
      vptaTransient = processed?.internal?.transient === true;
    }

    if (outcome == null) {
      return;
    }
    if (vptaDisplayCommand != null) vptaDisplayCommands.set(outcome, vptaDisplayCommand);
    if (vptaAdmissionCompletion != null) {
      vptaAdmissionCompletions.set(outcome, vptaAdmissionCompletion);
    }

    if (outcome.domain === "raw" && !rawFallbackLogged) {
      logUnknownRawFallbackOnce();
    }

    if (
      outcome.domain === "typhoonProbability"
      && vptaTransient
    ) {
      if (vptaDisplayCommands.has(outcome) || vptaAdmissionCompletions.has(outcome)) {
        throw new Error("VPTA50 transient sidecar invariant failed");
      }
      // Invalid EventID is deliberately outside started admission. It still follows
      // the ordinary CLI/ticker/stats/notifier pipeline, but owns no reducer command
      // and emits no persistence completion.
    } else if (outcome.domain === "typhoonProbability") {
      const command = vptaDisplayCommands.get(outcome);
      const completion = vptaAdmissionCompletions.get(outcome);
      if (command == null || completion == null) {
        throw new Error("VPTA50 accepted sidecar invariant failed");
      }
      vptaDisplayCommands.delete(outcome);
      vptaAdmissionCompletions.delete(outcome);
      emitAcceptedVptaOutcome(
        outcome,
        command,
        completion,
        statsNowMs(outcome.msg.meta?.receivedAtMs ?? routerClock.nowMs()),
      );
      return;
    }

    if (outcome.domain === "eew" && outcome.displayLifecycleOnly === true) {
      try {
        displaySink?.ingest(toPresentationEvent(outcome));
      } catch {
        // display lifecycle command の配送障害を受信本体へ波及させない。
      }
      return;
    }

    const outcomeAdmissionNowMs = statsNowMs(outcome.msg.meta?.receivedAtMs ?? routerClock.nowMs());
    recordStats(outcome, stats, outcomeAdmissionNowMs);
    // VPNO50 の府県予報区解除は VPWW55 の緊急 overlay を直ちに降格させる state transition。
    // legacy counterpart の holdback を通すと常設表示の更新まで 60 秒遅れるため、この受理済み
    // cross-type transition だけは相関待ちをせず一度だけ通常配送する。
    if (
      outcome.domain === "legacyCounterpart"
      && outcome.parsed.type === "VPNO50"
      && outcome.presentation.weatherStateMutationAccepted === true
    ) {
      emitAcceptedOutcome(outcome, outcomeAdmissionNowMs);
      return;
    }
    const action = legacyCounterpartCorrelator.accept(outcome);
    if (action != null) handleLegacyCounterpartAction(action);
  };

  const createEnvelope = (incoming: WsDataMessage): RouterEnvelope => {
    assertSerializerHealthy();
    const ingressObservedAtMs = routerClock.nowMs();
    try {
      const normalized = normalizeTelegramMessage(incoming, ingressObservedAtMs);
      const message = deepFreezeRouterSnapshot(structuredClone(normalized.message));
      const route = classifyMessage(message.classification, message.head.type);
      const serialized = JSON.stringify(message);
      const byteLength = Buffer.byteLength(serialized, "utf8");
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        throw new Error("router snapshot byte length invariant failed");
      }
      if (!Number.isSafeInteger(nextEnvelopeOrdinal) || nextEnvelopeOrdinal < 1) {
        throw new Error("router envelope ordinal invariant failed");
      }
      const ordinal = nextEnvelopeOrdinal;
      nextEnvelopeOrdinal = ordinal === Number.MAX_SAFE_INTEGER
        ? Number.POSITIVE_INFINITY
        : ordinal + 1;
      return Object.freeze({
        message: message as ReadonlyDeep<WsDataMessage>,
        route,
        diagnostics: Object.freeze(structuredClone(normalized.diagnostics)),
        ingressObservedAtMs,
        ordinal,
        byteLength,
      });
    } catch (cause) {
      throw poisonSerializer(cause);
    }
  };

  const enqueueReentrant = (envelope: RouterEnvelope): void => {
    let nextBytes: number;
    try {
      nextBytes = pendingEnvelopeBytes + envelope.byteLength;
      if (!Number.isSafeInteger(nextBytes)
        || pendingEnvelopes.length + 1 > ROUTER_REENTRANT_QUEUE_MAX_ITEMS
        || nextBytes > ROUTER_REENTRANT_QUEUE_MAX_BYTES) {
        throw new Error("router reentrant queue capacity exceeded");
      }
      pendingEnvelopes.push(envelope);
      pendingEnvelopeBytes = nextBytes;
    } catch (cause) {
      throw poisonSerializer(cause);
    }
  };

  const throwTurnErrors = (
    recoverableErrors: readonly unknown[],
    poisonError: RouterSerializerPoisonedError | null,
    persistenceCause: unknown | null,
  ): void => {
    if (recoverableErrors.length === 0 && poisonError != null && persistenceCause == null) {
      throw poisonError;
    }
    const causes = [...recoverableErrors];
    if (poisonError != null && !causes.includes(poisonError.serializerCause)) {
      causes.push(poisonError.serializerCause);
    }
    if (persistenceCause != null && !causes.includes(persistenceCause)) causes.push(persistenceCause);
    if (causes.length === 0) return;
    if (causes.length === 1) throw causes[0];
    throw new AggregateError(causes, "message router drain failed");
  };

  const handler = (incoming: WsDataMessage): void => {
    // Sticky poison rejection deliberately precedes clock access and every ingress operation.
    assertSerializerHealthy();
    const envelope = createEnvelope(incoming);
    if (serializerOwnerActive) {
      enqueueReentrant(envelope);
      return;
    }

    serializerOwnerActive = true;
    turnRequiredPersistenceSeq = 0;
    turnDurableFloorSatisfiedSeq = 0;
    turnPersistenceCause = null;
    turnPersistenceDispatchFailed = false;
    const recoverableErrors: unknown[] = [];
    let current: RouterEnvelope | undefined = envelope;
    let drained = 0;
    try {
      while (current != null) {
        if (serializerPoisonError != null) break;
        if (drained >= ROUTER_MAX_DRAINED_ENVELOPES_PER_TURN) {
          poisonSerializer(new Error("router drain step capacity exceeded"));
          break;
        }
        drained += 1;
        try {
          const ownerToken = createVptaRouterOwnerToken();
          withVptaRouterOwnerToken(ownerToken, () => {
            if ((current!.route === "typhoonProbability"
              || current!.route === "weatherWarningTimeseries")
              && options?.withStandbyDurableNotificationsSuppressed != null) {
              options.withStandbyDurableNotificationsSuppressed(() => processEnvelope(current!));
            } else {
              processEnvelope(current!);
            }
          });
        } catch (cause) {
          if (cause !== serializerPoisonError) recoverableErrors.push(cause);
        }
        if (serializerPoisonError != null) break;
        const next = pendingEnvelopes.shift();
        if (next == null) {
          current = undefined;
        } else {
          pendingEnvelopeBytes -= next.byteLength;
          if (!Number.isSafeInteger(pendingEnvelopeBytes) || pendingEnvelopeBytes < 0) {
            poisonSerializer(new Error("router reentrant queue byte accounting invariant failed"));
            break;
          }
          current = next;
        }
      }
    } finally {
      serializerOwnerActive = false;
      if (serializerPoisonError != null) {
        pendingEnvelopes.length = 0;
        pendingEnvelopeBytes = 0;
      }
    }
    if (
      serializerPoisonError != null
      && !turnPersistenceDispatchFailed
      && turnRequiredPersistenceSeq > turnDurableFloorSatisfiedSeq
    ) {
      try {
        const result = options?.flushStandbyThrough?.(turnRequiredPersistenceSeq);
        if (result == null || result.kind === "failed" || result.writtenSeq < turnRequiredPersistenceSeq) {
          turnPersistenceCause = result?.kind === "failed"
            ? result.cause
            : new Error("standby persistence durable floor was not satisfied");
        } else {
          turnDurableFloorSatisfiedSeq = result.writtenSeq;
        }
      } catch (cause) {
        turnPersistenceCause = cause;
      }
    }
    throwTurnErrors(recoverableErrors, serializerPoisonError, turnPersistenceCause);
  };

  return {
    handler,
    eewLogger,
    eewTracker,
    notifier,
    tsunamiState,
    volcanoState,
    vpws50State,
    vpww56State,
    floodForecastState,
    vpwp50Cache,
    tornadoDetailProvider,
    stats,
    summaryTracker,
    dailyQuakeCounter,
    buildDisplayStats: (now?: number) => buildDisplayStats(
      summaryTracker,
      stats,
      dailyQuakeCounter,
      options?.getPersistenceSalvageDiagnostics,
      statsNowMs(now ?? routerClock.nowMs()),
    ),
    flushAndDisposeVolcanoBuffer: () => volcanoHandler.flushAndDispose(),
    disposeLegacyCounterpartCorrelator: () => {
      // correlator と display receipt は別 owner だが、shutdown の一つの入口から双方を破棄する。
      displayReceipts.dispose();
      legacyCounterpartCorrelator.dispose();
    },
    getReplayQuiescence: () => ({
      pendingEnvelopes: pendingEnvelopes.length,
      serializerOwnerActive,
    }),
  };
}
