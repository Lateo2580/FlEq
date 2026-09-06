/**
 * 情報ディスプレイの組み立てヘルパ。
 * StateStore / InfoDisplayHub / InProcessSseDisplayTransport を束ねて起動し、
 * 起動時 seed (津波・気象警報) と REPL コマンド用の module registry を提供する。
 * ui への依存は持たない (summarize は DisplayCallbacks の DI 経由)。
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AppConfig, DisplaySeverity, ParsedTsunamiInfo, TsunamiObservationStation, Vpws50CurrentAreasForDisplay } from "../../types";
import * as log from "../../logger";
import type { DisplayCallbacks } from "../messages/display-callbacks";
import { detectTsunamiAlertLevel, type TsunamiObservationGroups } from "../messages/tsunami-state";
import { formatLevelLabel } from "../../dmdata/weather-warning-level";
import { buildTsunamiObservations } from "../presentation/events/tsunami-observations";
import { DISPLAY_SUMMARY_WIDTH } from "./constants";
import { createFrontendBuildIdReader } from "./frontend-build-id";
import { InfoDisplayHub, type DisplayTimeoutScheduler } from "./hub";
import { DisplayStateStore } from "./state-store";
import type { DisplayQuakeLifecyclePersistedV1 } from "./state-store";
import { weatherAlertsFromVpws50, weatherAlertsFromVpww56 } from "./weather-alert-view";
import { WeatherPromotionStore } from "./weather-promotion-store";
import { QuakeExtremeStore } from "./quake-extreme-store";
import { InProcessSseDisplayTransport, isLoopbackHost } from "./transport";
import { projectDisplayTsunamiObservations } from "./tsunami-observation-projection";
import { projectTsunamiHeightSemantic } from "./tsunami-height-semantic";
import {
  projectDepthSemantic,
  projectMagnitudeSemantic,
} from "./magnitude-depth-semantic";
import type {
  ActiveStandbyCardV1,
  DisplayRecentQuakeV1,
  DisplayTsunamiInputV1,
  DisplayTsunamiLevel,
  DisplayWeatherAlertItemV1,
  DisplayWeatherAlertV1,
  DisplayWeatherRank,
  DisplayStatsV1,
} from "./types";
import type { DisplayMutation } from "./standby-registry";

export interface DisplayRuntime {
  hub: InfoDisplayHub;
  transport: InProcessSseDisplayTransport;
  stop(): Promise<void>;
}

export interface DisplayRuntimeOptions {
  now?: () => number;
  timeoutScheduler?: DisplayTimeoutScheduler;
  replayMetadata?: () => {
    clock?: { mode: "replay"; now: string };
    replay?: { step: number; total: number; inputDigest: string };
  };
  /** replay は periodic business sweep を起動せず、明示 flush が所有する。 */
  startTimers?: boolean;
}

export interface DisplaySeedSources {
  tsunami: () => ParsedTsunamiInfo | null;
  /** monitor 所有の VTSE51/52 観測 state。display off/on をまたいで seed する。 */
  tsunamiObservations?: () => TsunamiObservationGroups;
  weather: () => Vpws50CurrentAreasForDisplay | undefined;
  /** VPWW56 (土砂災害警戒情報。Vpww56StateHolder.getCurrentAreasForDisplay) */
  landslide: () => Vpws50CurrentAreasForDisplay | undefined;
  /** monitor 所有の active standby state。旧テスト/埋込利用との互換のため省略可 */
  standbyItems?: () => ActiveStandbyCardV1[];
  /**
   * monitor 所有の気象警報 昇格 lifecycle。display runtime は起動ごとに作り直されるため、
   * ここで注入しないと `display off` → `on` で昇格の時計が途切れる。省略時は runtime 内に
   * 閉じた新規ストアになる (旧テスト/埋込利用との互換)。
   */
  weatherPromotions?: () => WeatherPromotionStore;
  /** monitor 所有の震度 7 専用保持時計。display off/on をまたいで維持する。 */
  quakeExtreme?: () => QuakeExtremeStore;
  /** monitor 所有の当日地震履歴。display off/on・再起動をまたぐ。 */
  recentQuakes?: () => DisplayRecentQuakeV1[];
  /** monitor 所有の地図 host／contribution／large-quake reference／revision。 */
  quakeLifecycle?: () => DisplayQuakeLifecyclePersistedV1;
  /** monitor 所有の、再起動をまたぐ気象警報カード現況。 */
  weatherAlerts?: () => DisplayWeatherAlertV1[];
  /** 起動直後 snapshot に載せる当日統計。 */
  stats?: () => DisplayStatsV1;
  /** hub 稼働中の sweep は既存 hub タイマーへ統合する */
  standbySweep?: (nowMs: number) => DisplayMutation;
  /** standby state と寿命を共有する ticker の active groupKey */
  standbyTickerGroupKeys?: () => ReadonlySet<string>;
}

// ── 変換関数 ──

// 気象カード view の変換は weather-alert-view.ts へ移設 (monitor からも使うため)。
// 既存の import 経路を保つためここから re-export する
export { weatherAlertsFromVpws50, weatherAlertsFromVpww56 };

/**
 * ParsedTsunamiInfo (TsunamiStateHolder.getLastInfo) を起動時 seed 用の入力に変換する。
 * 取消報・警報レベルなし (津波予報のみ等) は null。
 */
export function tsunamiSeedFromParsed(
  info: ParsedTsunamiInfo,
  observations: readonly TsunamiObservationStation[] = info.observations ?? [],
): DisplayTsunamiInputV1 | null {
  if (info.infoType === "取消") return null;
  const forecast = info.forecast ?? [];
  const label = detectTsunamiAlertLevel(forecast.map((f) => f.kind));
  if (label == null) return null;
  const level: DisplayTsunamiLevel =
    label === "大津波警報" ? "majorWarning" : label === "津波警報" ? "warning" : "advisory";
  const magnitudeSemantic = projectMagnitudeSemantic(info.earthquake?.magnitudeValue);
  const depthSemantic = projectDepthSemantic(info.earthquake?.depthValue);
  const eventId = info.meta.eventId.valid ? info.meta.eventId.value?.trim() : null;
  // 津波予報 (0.2m 以下) の沿岸を一覧に混ぜない (project-event.ts の pickAlertCoasts と同方針)
  const coasts = forecast
    .filter((f) => /警報|注意報/.test(f.kind))
    .map((f) => {
      const maxHeightSemantic = projectTsunamiHeightSemantic(f.maxHeight, f.maxHeightDescription);
      return {
        name: f.areaName,
        kind: f.kind,
        areaCode: f.areaCode,
        kindCode: f.kindCode,
        maxHeight: f.maxHeightDescription || null,
        ...(maxHeightSemantic == null ? {} : { maxHeightSemantic }),
        firstHeight: f.firstHeight || null,
      };
    });
  return {
    kind: "tsunami",
    eventId: eventId === "" || eventId == null ? null : eventId,
    level,
    levelLabel: label,
    coasts,
    warningComment: info.warningComment || null,
    observations: projectDisplayTsunamiObservations(
      buildTsunamiObservations({ ...info, observations: [...observations] }),
    ),
    reportDateTime: info.reportDateTime,
    ...(magnitudeSemantic == null ? {} : { magnitudeSemantic }),
    ...(depthSemantic == null ? {} : { depthSemantic }),
  };
}

// ── 組み立て ──

function resolveDistDir(): string {
  return process.env.FLEQ_DISPLAY_DIST ?? join(__dirname, "../../../display/dist");
}

/**
 * 情報ディスプレイ一式を起動する。
 * transport.start() 失敗 (dist 欠落・ポート衝突) は warn ログ + null 返却で本体は継続する。
 */
export async function startDisplayRuntime(
  config: AppConfig,
  display: DisplayCallbacks,
  seeds: DisplaySeedSources,
  /** kill switch (onFatal) 発火時にも呼び出し元の runtime 参照を後始末させるための通知 */
  onStopped?: () => void,
  runtimeOptions: DisplayRuntimeOptions = {},
): Promise<DisplayRuntime | null> {
  const now = runtimeOptions.now ?? Date.now;
  const store = new DisplayStateStore(
    seeds.standbyItems,
    seeds.weatherPromotions?.(),
    seeds.quakeExtreme?.(),
    seeds.recentQuakes,
    seeds.weatherAlerts,
  );
  const distDir = resolveDistDir();
  const frontendBuildId = createFrontendBuildIdReader(distDir);
  const hub = new InfoDisplayHub(store, {
    summarize: (e) => display.renderSummaryLine(e, DISPLAY_SUMMARY_WIDTH),
    weatherAlerts: (updatedAt) => [
      ...weatherAlertsFromVpws50(seeds.weather(), updatedAt),
      ...weatherAlertsFromVpww56(seeds.landslide(), updatedAt),
    ],
    frontendBuildId,
    standbySweep: seeds.standbySweep,
    standbyTickerGroupKeys: seeds.standbyTickerGroupKeys,
    now,
    timeoutScheduler: runtimeOptions.timeoutScheduler,
    replayMetadata: runtimeOptions.replayMetadata,
    // spec §4: 表示系の連続障害では hub (kill switch が stop 済み) に加えて transport も止め、
    // monitor 本体だけを継続する。registry も外して REPL コマンドから死んだ runtime を参照させない。
    // transport.stop() (server.close) の完了を待ってから参照クリア・onStopped を行うことで、
    // ポート解放前に `display on` が打たれて EADDRINUSE になる窓を塞ぐ
    onFatal: (reason) => {
      void (async () => {
        log.warn(`情報ディスプレイを停止しました: ${reason}`);
        try {
          await transport.stop();
        } catch (err) {
          log.warn(
            `情報ディスプレイの停止処理でエラーが発生しました: ${err instanceof Error ? err.message : err}`,
          );
        } finally {
          setActiveDisplayRuntime(null);
          onStopped?.();
        }
      })();
    },
  });
  // 非 loopback バインド時はアクセストークンを必須にする (dmdata 再配信境界の技術的固定)。
  // 未設定なら起動ごとに自動生成する。loopback バインドは到達経路自体が閉じているため認証なし
  const nonLoopback = !isLoopbackHost(config.displayHost);
  // 空文字 token は resolver で未設定へ正規化済みだが、防御的にここでも弾く (空 token は認証弱化)
  const configuredToken = config.displayToken != null && config.displayToken !== "" ? config.displayToken : null;
  const generatedToken = nonLoopback && configuredToken == null ? randomBytes(16).toString("hex") : null;
  const displayToken = nonLoopback ? (configuredToken ?? generatedToken) : null;
  const transport = new InProcessSseDisplayTransport({
    host: config.displayHost,
    port: config.displayPort,
    distDir,
    getSnapshot: () => hub.buildSnapshot(),
    log: { info: (msg) => log.info(msg), warn: (msg) => log.warn(msg) },
    onClientCountChange: (count) => {
      hub.onSseClientCountChange(count);
    },
    token: displayToken,
  });
  hub.attachTransport(transport);

  // 起動時 seed: 津波は restore 済み state から、気象警報は現況 (通常は未受信で空)
  const nowMs = now();
  const quakeLifecycle = seeds.quakeLifecycle?.();
  if (quakeLifecycle != null) store.restoreQuakeLifecycle(quakeLifecycle, nowMs);
  const initialStats = seeds.stats?.();
  if (initialStats != null) store.setStats(initialStats);
  const tsunamiInfo = seeds.tsunami();
  if (tsunamiInfo != null) {
    const groups = seeds.tsunamiObservations?.();
    const seed = tsunamiSeedFromParsed(
      tsunamiInfo,
      groups == null ? undefined : [...groups.VTSE51, ...groups.VTSE52],
    );
    if (seed != null) {
      store.seedTsunami(seed, nowMs, groups == null ? undefined : {
        VTSE51: projectDisplayTsunamiObservations(
          buildTsunamiObservations({ ...tsunamiInfo, observations: groups.VTSE51 }),
        ),
        VTSE52: projectDisplayTsunamiObservations(
          buildTsunamiObservations({ ...tsunamiInfo, observations: groups.VTSE52 }),
        ),
      });
    }
  }
  const nowIso = new Date(nowMs).toISOString();
  const vpws50View = seeds.weather();
  const vpww56View = seeds.landslide();
  const vpws50Alerts = weatherAlertsFromVpws50(vpws50View, nowIso);
  const vpww56Alerts = weatherAlertsFromVpww56(vpww56View, nowIso);
  const weatherSeed = [...vpws50Alerts, ...vpww56Alerts];
  if (weatherSeed.length > 0) store.seedWeatherAlerts(weatherSeed);
  try {
    await transport.start();
  } catch (err) {
    hub.stop();
    log.warn(
      `情報ディスプレイサーバの起動に失敗しました: ${err instanceof Error ? err.message : err} (本体は継続します)`,
    );
    return null;
  }
  // 起動失敗では lifecycle に触れない。HTTP/SSE が実際に開始できた時点だけを display on とし、
  // off 中に残った active な点灯へここから表示時間を与える (spec 追補 C6)。
  const displayOnAtMs = now();
  store.resumeWeatherPromotions(displayOnAtMs);
  // display on のフルリセットとは別に、runtime 稼働中の SSE 無客区間は保持時計から除外する。
  // transport.start() とこの同期区間の間に await は無いため、初期人数との競合は起きない
  hub.startSseClientTracking(transport.clientCount(), displayOnAtMs);
  if (runtimeOptions.startTimers !== false) hub.startTimers();
  if (displayToken != null) {
    log.info(`情報ディスプレイ: http://${config.displayHost}:${transport.port()}/?token=${encodeURIComponent(displayToken)}`);
    log.info("非 loopback からの閲覧には上記 URL のトークンが必要です (loopback からの接続は不要)");
    if (generatedToken != null) {
      log.info("アクセストークンは起動ごとに自動生成されます。固定するには `fleq config set displayToken <値>` を設定してください");
    }
  } else {
    log.info(`情報ディスプレイ: http://${config.displayHost}:${transport.port()}/`);
  }
  return {
    hub,
    transport,
    async stop(): Promise<void> {
      hub.stop();
      await transport.stop();
    },
  };
}

// ── module registry (REPL コマンド用) ──

let activeRuntime: DisplayRuntime | null = null;

export function getActiveDisplayRuntime(): DisplayRuntime | null {
  return activeRuntime;
}

export function setActiveDisplayRuntime(rt: DisplayRuntime | null): void {
  activeRuntime = rt;
}
