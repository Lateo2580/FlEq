/**
 * 情報ディスプレイの組み立てヘルパ。
 * StateStore / InfoDisplayHub / InProcessSseDisplayTransport を束ねて起動し、
 * 起動時 seed (津波・気象警報) と REPL コマンド用の module registry を提供する。
 * ui への依存は持たない (summarize は DisplayCallbacks の DI 経由)。
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AppConfig, DisplaySeverity, ParsedTsunamiInfo, Vpws50CurrentAreasForDisplay } from "../../types";
import * as log from "../../logger";
import type { DisplayCallbacks } from "../messages/display-callbacks";
import { detectTsunamiAlertLevel } from "../messages/tsunami-state";
import { formatLevelLabel } from "../../dmdata/weather-warning-level";
import { buildTsunamiObservations } from "../presentation/events/tsunami-observations";
import { DISPLAY_SUMMARY_WIDTH } from "./constants";
import { createFrontendBuildIdReader } from "./frontend-build-id";
import { InfoDisplayHub } from "./hub";
import { DisplayStateStore } from "./state-store";
import { InProcessSseDisplayTransport, isLoopbackHost } from "./transport";
import type {
  DisplayTsunamiInputV1,
  DisplayTsunamiLevel,
  DisplayWeatherAlertItemV1,
  DisplayWeatherAlertV1,
  DisplayWeatherRank,
} from "./types";

export interface DisplayRuntime {
  hub: InfoDisplayHub;
  transport: InProcessSseDisplayTransport;
  stop(): Promise<void>;
}

export interface DisplaySeedSources {
  tsunami: () => ParsedTsunamiInfo | null;
  weather: () => Vpws50CurrentAreasForDisplay | undefined;
  /** VPWW56 (土砂災害警戒情報。Vpww56StateHolder.getCurrentAreasForDisplay) */
  landslide: () => Vpws50CurrentAreasForDisplay | undefined;
}

// ── 変換関数 ──

/**
 * ParsedTsunamiInfo (TsunamiStateHolder.getLastInfo) を起動時 seed 用の入力に変換する。
 * 取消報・警報レベルなし (津波予報のみ等) は null。
 */
export function tsunamiSeedFromParsed(info: ParsedTsunamiInfo): DisplayTsunamiInputV1 | null {
  if (info.infoType === "取消") return null;
  const forecast = info.forecast ?? [];
  const label = detectTsunamiAlertLevel(forecast.map((f) => f.kind));
  if (label == null) return null;
  const level: DisplayTsunamiLevel =
    label === "大津波警報" ? "majorWarning" : label === "津波警報" ? "warning" : "advisory";
  // 津波予報 (0.2m 以下) の沿岸を一覧に混ぜない (project-event.ts の pickAlertCoasts と同方針)
  const coasts = forecast
    .filter((f) => /警報|注意報/.test(f.kind))
    .map((f) => ({
      name: f.areaName,
      kind: f.kind,
      maxHeight: f.maxHeightDescription || null,
      firstHeight: f.firstHeight || null,
    }));
  return {
    kind: "tsunami",
    level,
    levelLabel: label,
    coasts,
    warningComment: info.warningComment || null,
    observations: buildTsunamiObservations(info),
    reportDateTime: info.reportDateTime,
  };
}

/** displaySeverity → 気象カードの rank (意味ベース、frame level とは別軸)。
 * officialL5/nonLevelSpecial=emergency, officialL4/officialL3/nonLevelWarning=warning,
 * それ以外 (officialL2/nonLevelAdvisory/officialL1/unknown)=advisory */
function weatherRankOf(displaySeverity: DisplaySeverity): DisplayWeatherRank {
  if (displaySeverity === "officialL5" || displaySeverity === "nonLevelSpecial") return "emergency";
  if (
    displaySeverity === "officialL4" ||
    displaySeverity === "officialL3" ||
    displaySeverity === "nonLevelWarning"
  ) {
    return "warning";
  }
  return "advisory";
}

const WEATHER_RANK_BUCKETS: Array<{
  rank: DisplayWeatherRank;
  label: string;
  role: "weatherEmergency" | "weatherWarning" | "weatherAdvisory";
}> = [
  { rank: "emergency", label: "気象特別警報", role: "weatherEmergency" },
  { rank: "warning", label: "気象警報", role: "weatherWarning" },
  { rank: "advisory", label: "気象注意報", role: "weatherAdvisory" },
];

/**
 * Vpws50CurrentAreasForDisplay を表示プロトコルの weatherAlerts に変換する。
 * displaySeverity から意味ベースで rank (emergency/warning/advisory) を導出し、警報・特別警報の 2 バケツに分ける。
 * advisory rank は気象カードに載せない (注意報はティッカーのみに任せる)。空バケツは含めない。
 * updatedAt は呼び出し側が供給する (hub: dto.reportDateTime / seed 時: 起動時刻 ISO)。
 */
export function weatherAlertsFromVpws50(
  view: Vpws50CurrentAreasForDisplay | undefined,
  updatedAt: string,
): DisplayWeatherAlertV1[] {
  if (view == null) return [];
  const itemsByRank: Record<DisplayWeatherRank, DisplayWeatherAlertItemV1[]> = {
    emergency: [],
    warning: [],
    advisory: [],
  };
  const areasByRank: Record<DisplayWeatherRank, Set<string>> = {
    emergency: new Set(),
    warning: new Set(),
    advisory: new Set(),
  };
  for (const group of view.kinds) {
    if (group.displaySeverity === "release") continue;
    const rank = weatherRankOf(group.displaySeverity);
    if (rank === "advisory") continue;
    const item: DisplayWeatherAlertItemV1 = {
      kind: formatLevelLabel(group.officialAlertLevel, group.kindName),
      displaySeverity: group.displaySeverity,
      rank,
      shownAreas: group.areas.map((a) => a.areaName),
      omittedAreaCount: 0,
    };
    itemsByRank[rank].push(item);
    for (const a of group.areas) areasByRank[rank].add(a.areaCode);
  }
  const alerts: DisplayWeatherAlertV1[] = [];
  for (const bucket of WEATHER_RANK_BUCKETS) {
    const items = itemsByRank[bucket.rank];
    if (items.length === 0) continue;
    alerts.push({
      source: "vpws50",
      label: bucket.label,
      role: bucket.role,
      totalAreas: areasByRank[bucket.rank].size,
      items,
      updatedAt,
    });
  }
  return alerts;
}

/**
 * VPWW56 (土砂災害警戒情報) の現況を気象カード用に変換する。
 * rank は weatherAlertsFromVpws50 と同じ displaySeverity 由来 (weatherRankOf 共有)。
 * 現実の土砂災害警戒情報は警報級だが、displaySeverity が advisory 級に落ちるデータは
 * weatherAlertsFromVpws50 と同様に除外する (advisory を気象カードに載せない契約を守る)。
 */
export function weatherAlertsFromVpww56(
  view: Vpws50CurrentAreasForDisplay | undefined,
  updatedAt: string,
): DisplayWeatherAlertV1[] {
  if (view == null || view.kinds.length === 0) return [];
  const items: DisplayWeatherAlertItemV1[] = view.kinds
    .filter((g) => g.displaySeverity !== "release" && weatherRankOf(g.displaySeverity) !== "advisory")
    .map((g) => ({
      kind: formatLevelLabel(g.officialAlertLevel, g.kindName),
      displaySeverity: g.displaySeverity,
      rank: weatherRankOf(g.displaySeverity),
      shownAreas: g.areas.map((a) => a.areaName),
      omittedAreaCount: 0,
    }));
  if (items.length === 0) return [];
  const rankOrder: Record<DisplayWeatherRank, number> = { emergency: 3, warning: 2, advisory: 1 };
  const top = items.reduce(
    (best, it) => (rankOrder[it.rank] > rankOrder[best] ? it.rank : best),
    "advisory" as DisplayWeatherRank,
  );
  const role = top === "emergency" ? "weatherEmergency" : top === "warning" ? "weatherWarning" : "weatherAdvisory";
  return [{ source: "vpww56", label: "土砂災害警戒情報", role, totalAreas: view.totalAreas, items, updatedAt }];
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
): Promise<DisplayRuntime | null> {
  const store = new DisplayStateStore();
  const distDir = resolveDistDir();
  const frontendBuildId = createFrontendBuildIdReader(distDir);
  const hub = new InfoDisplayHub(store, {
    summarize: (e) => display.renderSummaryLine(e, DISPLAY_SUMMARY_WIDTH),
    weatherAlerts: (updatedAt) => [
      ...weatherAlertsFromVpws50(seeds.weather(), updatedAt),
      ...weatherAlertsFromVpww56(seeds.landslide(), updatedAt),
    ],
    frontendBuildId,
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
    token: displayToken,
  });
  hub.attachTransport(transport);

  // 起動時 seed: 津波は restore 済み state から、気象警報は現況 (通常は未受信で空)
  const nowMs = Date.now();
  const tsunamiInfo = seeds.tsunami();
  if (tsunamiInfo != null) {
    const seed = tsunamiSeedFromParsed(tsunamiInfo);
    if (seed != null) store.seedTsunami(seed, nowMs);
  }
  const nowIso = new Date(nowMs).toISOString();
  const weatherSeed = [
    ...weatherAlertsFromVpws50(seeds.weather(), nowIso),
    ...weatherAlertsFromVpww56(seeds.landslide(), nowIso),
  ];
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
  hub.startTimers();
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
