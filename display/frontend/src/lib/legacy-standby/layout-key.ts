/**
 * 待機画面の再計測トリガとなる「レイアウト入力キー」の合成。
 *
 * 由来: spec: 2026-09-07-standby-metadata-resettle.md（作業ノート、repo 外）（Issue #15）。
 * 従来の contentKey は `snapshot.generatedAt` / `snapshot.seq` を含んでいたため、
 * カード内容も表示寸法も変わらない state 配信のたびに settle 全体をやり直していた。
 *
 * 方式は spec §3.1 の案 A（除外リスト方式）。**snapshot の全 field をキーへ入れるのが既定**で、
 * 「レイアウトに効かないことを file:line で証明できた field」だけを LAYOUT_IRRELEVANT_KEYS で除く。
 * 分類漏れは自動的に「再計測する」側へ倒れるので、失敗モードは無駄な再計測（性能劣化）であって
 * 「レイアウトが更新されない」（表示の誤り）にはならない。
 *
 * この設計を選んだ決定打は severityTier である（spec §2.8）。StandbyScreen は
 * `snapshot.severityTier` を一度も読まないが、App.svelte が `<main data-tier>` を立て、
 * lib/theme.css:346-353 が `--num-weight` を 700→800 へ離散上書きする。font-weight は字送りを
 * 変えるため実測寸法が動く。「効くものを列挙する」方式ではこの種の間接依存を構造的に見落とす。
 *
 * **theme.css を触る人へ**: `main[data-tier]`（lib/theme.css:346-353）と
 * `main[data-background-tone]`（同 241-249）に寸法へ効く宣言を足したら、本ファイルの分類を見直すこと。
 * 2026-09-07 時点の実測では、前者の寸法宣言は `--num-weight` のみ（`--surface-panel` /
 * `--surface-panel-raised` は色）、後者は `--bg` の色のみである。
 */
import type { DisplayConnectionStateV1, DisplayStateSnapshotV1, DisplayStatsV1, DisplayTsunamiStateV1 } from "../protocol";
import { formatHm } from "../format";

type SnapshotKey = keyof DisplayStateSnapshotV1;

/**
 * レイアウト寸法に効かないと file:line で証明できた field。
 * 出典は spec §2.5 の被覆表（`7aabcf2` 実測）。
 *
 * - `version`         … プロトコル定数
 * - `generatedAt`     … src/engine/display/state-store.ts:1237 の `new Date(nowMs).toISOString()`
 * - `seq`             … lib/protocol.ts:1115 の hub 採番。配信のたびに必ず変わる
 * - `activeEews`      … StandbyScreen が読まない（緊急画面の入力）
 * - `largeQuakes`     … StandbyScreen が読まない
 * - `weatherChange`   … StandbyScreen が読まない
 * - `weatherPromotion`… StandbyScreen が読まない
 * - `weatherL5Active` … StandbyScreen が読まない（night-dim は App の `dim` prop 経由）
 * - `backgroundTone`  … lib/theme.css:241-249 は `--bg` の色のみ
 * - `recentTicker`    … StandbyScreen が読まない（TickerLane の入力）
 * - `mapLayers`       … StandbyScreen が読まない
 * - `tickerSynced`    … lib/store.ts:170,177 の ticker 制御のみ
 * - `frontendBuildId` … reload 判定のみ
 */
export const LAYOUT_IRRELEVANT_KEYS = [
  "version",
  "generatedAt",
  "seq",
  "activeEews",
  "largeQuakes",
  "weatherChange",
  "weatherPromotion",
  "weatherL5Active",
  "backgroundTone",
  "recentTicker",
  "mapLayers",
  "tickerSynced",
  "frontendBuildId",
] as const satisfies readonly SnapshotKey[];

/**
 * キーに入れる field。除外の証明が付かないものはすべてここへ入る（既定側）。
 *
 * - `tsunami`             … StandbyScreen.svelte:807・838・2113-2114。`observations` は除く（tsunamiPart）
 * - `weatherAlerts`       … 同 341・352。`updatedAt` 同値の訂正報を取りこぼさないため全体を採る（spec §2.6）
 * - `weatherExpandedKinds`… 同 383
 * - `recentQuakes`        … 同 305・995・1389-1390・2441
 * - `latestQuake`         … 同 556・828・838-839・873。engine 採番の `updatedAtMs` を revision として採る（spec 分岐 3 A）
 * - `stats`               … 同 994・1389-1390・2440。桁数だけを採る（spec 分岐 2 A、§2.7）
 * - `severityTier`        … CSS 経由の間接依存（spec §2.8）
 * - `connection`          … 同 343・2456・2470。`dmdata` と切断時の描画文字列だけを採る（connectionPart）
 * - `standbyItems`        … 同 314・2058-2069。既存の standbyContentIdentity をそのまま使う
 * - `clock` / `replay`    … replay harness の additive field（lib/protocol.ts:1157-1161）。
 *   spec §2.5 の被覆表は宣言マージ分を数え落としているため、除外の証明が付かない側として
 *   既定どおりキーへ入れる。production の snapshot には現れないので実コストはゼロ。
 */
export const LAYOUT_RELEVANT_KEYS = [
  "tsunami",
  "weatherAlerts",
  "weatherExpandedKinds",
  "recentQuakes",
  "latestQuake",
  "stats",
  "severityTier",
  "connection",
  "standbyItems",
  "clock",
  "replay",
] as const satisfies readonly SnapshotKey[];

type IrrelevantKey = (typeof LAYOUT_IRRELEVANT_KEYS)[number];
type RelevantKey = (typeof LAYOUT_RELEVANT_KEYS)[number];

type AssertNever<T extends never> = T;

/**
 * 分類の網羅性をコンパイル時に強制する。protocol に field が増えると、
 * どちらのリストにも入っていない間 `Exclude<...>` が `never` でなくなり型エラーになる。
 */
export type LayoutKeyClassificationIsExhaustive = AssertNever<Exclude<SnapshotKey, IrrelevantKey | RelevantKey>>;

/** 同じ field を両方に入れる取り違えをコンパイル時に弾く。 */
export type LayoutKeyClassificationIsDisjoint = AssertNever<Extract<IrrelevantKey, RelevantKey>>;

/**
 * 区切り文字は NUL。JSON.stringify は制御文字をすべてエスケープするので、
 * 直列化された部分文字列の中に生の NUL は決して現れず、境界が曖昧にならない。
 */
const PART_SEPARATOR = "\u0000";

function jsonPart(value: unknown): string {
  return value == null ? "" : JSON.stringify(value);
}

/**
 * stats のうち寸法に効くのは「行が出るか」と「数値の文字数」だけ（spec §2.7）。
 *
 * - sparkline は `viewBox` 固定 + CSS `width:120px; height:20px`（InstrumentRow.svelte:5-7,23,39）なので
 *   `sparklineData` の中身は寸法に効かない。1 分ごとに変わるためキーに入れると毎分の再計測を招く。
 * - 数値は `.instrument-row` の `font-variant-numeric: tabular-nums`（同 37）により
 *   描画幅が文字数だけで決まる。描画されるのは `totalReceived` と `todayQuakeCount` のみ（同 26・28）。
 * - `todayMaxInt` / `todayMaxIntRank` / 運用カウンタ群（protocol.ts:382-394）は描画されない。
 */
function statsPart(stats: DisplayStatsV1 | null | undefined): string {
  if (stats == null) return "absent";
  // InstrumentRow は値をそのまま補間するので、描画文字列の長さが幅の入力になる。
  return `present:${String(stats.totalReceived).length}:${String(stats.todayQuakeCount).length}`;
}

/**
 * connection のうち待機画面の描画に効くのは 2 つだけ。
 *
 * - `dmdata`: バッジの出現条件そのもの（ConnectionBadge.svelte:12）。正常時はバッジ自体が
 *   描かれない（同 16-21 の `{#if disconnected}`）。
 * - `lastReceivedAt`: 切断中だけ「最終受信 HH:MM」として描かれる（同 19）。効くのは
 *   `formatHm()` を通した描画文字列であって ISO 文字列ではない。
 *
 * `disconnectedSince` と `reason` は待機画面のどこにも描かれない（protocol.ts:511-516 の
 * 4 field のうち残り 2 つ。ConnectionBadge に参照がない）。
 *
 * 丸ごと直列化してはいけない理由: `lastReceivedAt` は電文を 1 通 ingest するたびに現在時刻へ
 * 書き換えられ（src/engine/display/hub.ts:161 の `setConnection`）、その値が毎 snapshot に
 * 載る（同 state-store.ts:1258 の `connection: { ...this.connection }`）。生の ISO を鍵へ
 * 入れると、接続中でバッジが描かれていない間も受信のたびに再計測が走る。
 *
 * バッジのもう一方の出現条件 `!sseConnected` はここで見ない。`sseConnected` は StandbyScreen
 * 側で `input` の独立成分として既に効いており、かつ EventSource が閉じている間は `state`
 * メッセージ自体が届かない（lib/connection.svelte.ts:229-237 の onopen/onerror）。
 */
function connectionPart(connection: DisplayConnectionStateV1): string {
  return connection.dmdata === "disconnected"
    ? `disconnected:${formatHm(connection.lastReceivedAt)}`
    : connection.dmdata;
}

/**
 * 待機画面が描く津波は TsunamiStandbyBanner だけで（StandbyScreen.svelte:2114）、
 * これが読むのは `coasts` / `level` / `eventId` / `unkeyedSequence` / `reportDateTime` である
 * （TsunamiStandbyBanner.svelte:43-54・73・187）。`observations` は一度も読まない。
 *
 * `observations` を描くのは TsunamiPanel だけで、その唯一の描画点は緊急画面
 * （EmergencyScreen.svelte:177）であり待機画面の寸法には入らない。観測点は続報のたびに
 * 増えるため、鍵に含めると待機画面が津波観測の更新ごとに再計測する。
 *
 * 残りの field は除外の証明が付かないので既定どおり採る。
 */
function tsunamiPart(tsunami: DisplayTsunamiStateV1 | null | undefined): string {
  if (tsunami == null) return "";
  const { observations: _observations, ...rest } = tsunami;
  return JSON.stringify(rest);
}

function relevantPart(
  snapshot: DisplayStateSnapshotV1,
  key: RelevantKey,
  standbyContentIdentity: string,
): string {
  switch (key) {
    // 既存の測定タプル（briefing の generation・typhoon の analysis/probability・
    // weatherWarningForecast の pager atoms）は精査済みで、汎用直列化より安定かつ小さい。
    case "standbyItems":
      return standbyContentIdentity;
    case "stats":
      return statsPart(snapshot.stats);
    // engine 採番の内容 revision。intensityGroups の変化は必ず revision を伴う（spec 分岐 3 A）。
    case "latestQuake":
      return String(snapshot.latestQuake?.updatedAtMs ?? "");
    case "tsunami":
      return tsunamiPart(snapshot.tsunami);
    case "weatherAlerts":
      return jsonPart(snapshot.weatherAlerts);
    case "weatherExpandedKinds":
      return jsonPart(snapshot.weatherExpandedKinds);
    case "recentQuakes":
      return jsonPart(snapshot.recentQuakes);
    case "severityTier":
      return snapshot.severityTier;
    case "connection":
      return connectionPart(snapshot.connection);
    case "clock":
      return jsonPart(snapshot.clock);
    case "replay":
      return jsonPart(snapshot.replay);
  }
}

/**
 * レイアウト入力だけを安定順で直列化する。順序は LAYOUT_RELEVANT_KEYS の宣言順で、
 * オブジェクトのプロパティ挿入順には依存しない。
 */
export function standbyLayoutKey(
  snapshot: DisplayStateSnapshotV1,
  standbyContentIdentity: string,
): string {
  const parts: string[] = [];
  for (const key of LAYOUT_RELEVANT_KEYS) {
    parts.push(key, relevantPart(snapshot, key, standbyContentIdentity));
  }
  return parts.join(PART_SEPARATOR);
}
