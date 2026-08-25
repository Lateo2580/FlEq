/**
 * router へ渡す表示系の sink。
 *
 * display runtime は `display on/off` で作り直されるため、router には実体 hub ではなく
 * この遅延 sink を渡し、向き先 (getHub) を差し替える。
 *
 * monitor 所有の状態 (standby active-state・気象警報の昇格) は **hub の有無に関わらず**
 * ここで更新する。display は表示の都合であって電文受理の事実とは無関係で、hub 側に置くと
 * `display off` の間だけ更新が失われる。
 */

import type { PresentationEvent } from "../presentation/types";
import type {
  DisplayCardIngestResult,
  DisplayCardReconcileResult,
  DisplayIngestResult,
  DisplayIngestSink,
  DisplayIngestOutcome,
  DisplayLateCounterpartContext,
  DisplayLateCounterpartResult,
} from "../display/types";
import type { ActiveStandbyCardV1 } from "../display/protocol";
import { briefingCardIdentity } from "../display/standby-state-store";
import type { CardReconcileResult } from "../display/standby-state-store";
import {
  applyWeatherPromotionOnIngest,
  type WeatherPromotionViewSources,
} from "../display/weather-promotion-ingest";
import type { WeatherPromotionStore } from "../display/weather-promotion-store";
import type { QuakeExtremeStore } from "../display/quake-extreme-store";
import { projectRecentQuake } from "../display/project-event";
import type { DailyQuakeCounter } from "../messages/daily-quake-counter";
import { weatherAlertsFromVpws50, weatherAlertsFromVpww56 } from "../display/weather-alert-view";
import type { DisplayWeatherAlertV1, DisplayWeatherSourceV1 } from "../display/types";
import type { WeatherReportIdentity } from "../messages/vpws50-state";

export interface DisplaySinkDeps {
  /** monitor 所有の待機画面 state */
  standby: {
    applyEvent(event: PresentationEvent, nowMs: number): unknown;
    /** normal ingest の card mutation を generation 単位で観測する。 */
    briefingCardGeneration?(): number;
    /** card 専用 state の source→canonical 置換。ticker state を参照しない。 */
    reconcileBriefingCard?(
      sourceKey: string,
      canonicalEvent: PresentationEvent,
      nowMs: number,
    ): CardReconcileResult;
    /** reconcile frame／authoritative snapshot に載せる monitor 所有 card。 */
    snapshotBriefingCard?(): Extract<ActiveStandbyCardV1, { kind: "briefing" }> | null;
    applyWeatherAlerts?(
      source: DisplayWeatherSourceV1,
      alerts: DisplayWeatherAlertV1[],
      reportDateTime: string,
      serial: string | null,
      nowMs: number,
      isCorrection?: boolean,
    ): unknown;
  };
  /** monitor 所有の昇格 lifecycle */
  promotions: WeatherPromotionStore;
  /** 震度 7 の 12 時間保持。display off 中も電文受理と同時に更新する。 */
  quakeExtreme?: QuakeExtremeStore;
  /** 当日地震履歴。display off 中も更新し、runtime 起動時の seed に使う。 */
  dailyQuakes?: DailyQuakeCounter;
  /** 昇格判定に使う現況 view (state holder) */
  weatherViews: WeatherPromotionViewSources;
  /** restorePrevious 後の active snapshot revision を legacy dual-write に使う。 */
  vpws50Identity?: () => WeatherReportIdentity | null;
  /** 現在の display hub (未起動なら null) */
  getHub: () => DisplayIngestSink | null;
  /** combined reconcile の間だけ monitor の通常 standby dirty 通知を抑止する。 */
  withStandbyDirtySuppressed?<T>(callback: () => T): T;
  /** テスト注入用。省略時 Date.now */
  now?: () => number;
}

interface BriefingCardReconcileState {
  cardResult?: DisplayCardReconcileResult;
  card?: DisplayLateCounterpartContext["card"];
  /** card payload を combined frame に載せられず、snapshot 再同期が必要。 */
  cardSnapshotUnavailable?: boolean;
}

function reconcileBriefingCardState(
  deps: DisplaySinkDeps,
  event: PresentationEvent,
  context: DisplayLateCounterpartContext | undefined,
  nowMs: number,
): BriefingCardReconcileState {
  const sourceKey = context?.sourceEvent == null
    ? null
    : briefingCardIdentity(context.sourceEvent);
  if (sourceKey == null || deps.standby.reconcileBriefingCard == null) return {};

  let cardResult: CardReconcileResult;
  try {
    cardResult = deps.standby.reconcileBriefingCard(sourceKey, event, nowMs);
  } catch {
    return { cardResult: { kind: "failure", status: "failure", applied: false, reason: "cardReconcileFailed" } };
  }

  let card: DisplayLateCounterpartContext["card"] | undefined;
  let cardSnapshotUnavailable = deps.standby.snapshotBriefingCard == null;
  if (deps.standby.snapshotBriefingCard != null) {
    try {
      card = deps.standby.snapshotBriefingCard();
    } catch {
      cardSnapshotUnavailable = true;
    }
  }
  return { cardResult, card, cardSnapshotUnavailable };
}

function briefingCardIngestResult(
  event: PresentationEvent,
  beforeGeneration: number | undefined,
  afterGeneration: number | undefined,
): DisplayCardIngestResult | undefined {
  if (
    !["briefing", "legacyCounterpart"].includes(event.domain)
    || beforeGeneration == null
    || afterGeneration == null
    || beforeGeneration === afterGeneration
  ) return undefined;
  return { kind: "applied", status: "applied", applied: true, generation: afterGeneration };
}

function tickerResultOf(value: unknown): DisplayIngestResult | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  if ("tickerResult" in value) {
    return tickerResultOf(value.tickerResult);
  }
  if (!("kind" in value)) return undefined;
  return value.kind === "applied" || value.kind === "unsupported" || value.kind === "failure" || value.kind === "failed"
    ? value as DisplayIngestResult
    : undefined;
}

export function createDisplaySink(deps: DisplaySinkDeps): DisplayIngestSink {
  const now = deps.now ?? Date.now;
  const ingest = (event: PresentationEvent): DisplayIngestResult | DisplayIngestOutcome | void | number => {
      const nowMs = now();
      const beforeCardGeneration = deps.standby.briefingCardGeneration?.();
      deps.standby.applyEvent(event, nowMs);
      const cardResult = briefingCardIngestResult(
        event,
        beforeCardGeneration,
        deps.standby.briefingCardGeneration?.(),
      );
      const unsafeVpws50 = event.type === "VPWS50" && event.weatherConfidence === "unsafe";
      const acceptedVpww56Mutation = event.type !== "VPWW56"
        || event.weatherStateMutationAccepted === true;
      if (event.type === "VPWS50" && !unsafeVpws50) {
        const activeIdentity = event.infoType === "取消" ? deps.vpws50Identity?.() : null;
        const activeReportDateTime = activeIdentity?.reportDateTime ?? event.reportDateTime;
        deps.standby.applyWeatherAlerts?.(
          "vpws50",
          weatherAlertsFromVpws50(deps.weatherViews.vpws50(), activeReportDateTime),
          activeReportDateTime,
          activeIdentity?.serial ?? event.serial ?? null,
          nowMs,
          ...(event.infoType === "訂正" ? [true] as const : []),
        );
      } else if (event.type === "VPWW56" && acceptedVpww56Mutation) {
        const activeRevision = event.weatherStateRevision;
        const activeReportDateTime = activeRevision?.reportDateTime ?? event.reportDateTime;
        deps.standby.applyWeatherAlerts?.(
          "vpww56",
          weatherAlertsFromVpww56(deps.weatherViews.vpww56(), activeReportDateTime),
          activeReportDateTime,
          activeRevision?.serial ?? event.serial ?? null,
          nowMs,
          ...(event.infoType === "訂正" ? [true] as const : []),
        );
      }
      if (!unsafeVpws50 && acceptedVpww56Mutation) {
        applyWeatherPromotionOnIngest(deps.promotions, deps.weatherViews, event, nowMs);
      }
      const quakeExtremeChanged = deps.quakeExtreme?.applyPresentationEvent(event, nowMs) ?? false;
      const dailyQuakeChanged = deps.dailyQuakes?.recordRecentQuake(projectRecentQuake(event), nowMs) ?? false;
      const hub = deps.getHub();
      // monitor 側で先に更新した store は hub の state-store からは差分に見えない。
      // 特に取消・下方修正を即時に snapshot へ反映するため、外部 dirty を明示する。
      if (quakeExtremeChanged || dailyQuakeChanged) hub?.markExternalStateDirty?.();
      const tickerResult = tickerResultOf(hub?.ingest(event));
      return cardResult == null ? tickerResult : {
        ...(tickerResult == null || typeof tickerResult !== "object" ? {} : { tickerResult }),
        cardResult,
      };
    };
  const reconcileLateCounterpart = (
    event: PresentationEvent,
    sourceEventKeys: readonly string[],
    context?: DisplayLateCounterpartContext,
  ): DisplayLateCounterpartResult => {
      const exactSourceKeys = sourceEventKeys.filter((key) => key.trim() !== "");
      const hub = deps.getHub();
      const combined = exactSourceKeys.length > 0 && hub?.reconcileLateCounterpart != null;
      const cardState = deps.withStandbyDirtySuppressed == null
        ? reconcileBriefingCardState(deps, event, context, now())
        : deps.withStandbyDirtySuppressed(() => reconcileBriefingCardState(deps, event, context, now()));
      const { cardResult, card, cardSnapshotUnavailable } = cardState;
      if (combined) {
        const hubContext: DisplayLateCounterpartContext = {
          ...(context?.sourceEvent == null ? {} : { sourceEvent: context.sourceEvent }),
          ...(card === undefined ? {} : { card }),
        };
        // method を取り出すと InfoDisplayHub の receiver が失われる。hub 自身を経由して
        // 呼び、recent/transport/state の this を保つ。
        try {
          const tickerResult = tickerResultOf(Object.keys(hubContext).length === 0
            ? hub.reconcileLateCounterpart!(event, exactSourceKeys)
            : hub.reconcileLateCounterpart!(event, exactSourceKeys, hubContext));
          // hub stopped/failure では combined frame は存在しない。card の applied は
          // authoritative snapshot へ切り替えて保持する。
          if (
            cardResult?.kind === "applied"
            && (tickerResult?.kind !== "applied" || cardSnapshotUnavailable)
          ) {
            hub?.markExternalStateDirty?.();
          }
          return { tickerResult, ...(cardResult == null ? {} : { cardResult }) };
        } catch {
          // card mutation は rollback しない。single frame を作れなかったので snapshot で収束する。
          if (cardResult?.kind === "applied") hub?.markExternalStateDirty?.();
          return {
            tickerResult: { kind: "failure", status: "failure", reason: "tickerReconcileFailed" },
            ...(cardResult == null ? {} : { cardResult }),
          };
        }
      }
      if (cardResult?.kind === "applied") hub?.markExternalStateDirty?.();
      return { ...(cardResult == null ? {} : { cardResult }) };
    };
  const reconcileLateCounterpartCard = (
    event: PresentationEvent,
    context: DisplayLateCounterpartContext,
  ): DisplayLateCounterpartResult => {
    const cardState = deps.withStandbyDirtySuppressed == null
      ? reconcileBriefingCardState(deps, event, context, now())
      : deps.withStandbyDirtySuppressed(() => reconcileBriefingCardState(deps, event, context, now()));
    const hub = deps.getHub();
    // ticker receipt が無い場合は card だけを確定し、表示中なら authoritative snapshot
    // の再配信へ渡す。hub 不在／停止中は次回 display on の seed が唯一の配送経路になる。
    if (cardState.cardResult?.kind === "applied") hub?.markExternalStateDirty?.();
    return cardState.cardResult == null ? {} : { cardResult: cardState.cardResult };
  };
  const ingestTickerOnly = (event: PresentationEvent): DisplayIngestResult | void =>
    tickerResultOf(deps.getHub()?.ingest(event));
  return {
    ingest,
    ingestTickerOnly,
    reconcileLateCounterpart,
    reconcileLateCounterpartCard,
  };
}
