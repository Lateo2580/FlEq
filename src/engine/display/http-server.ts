import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { buildTipsDeck } from "./display-tips";
import type { TipContext } from "../../tips/waiting-tips";
import { encodeSseGuarded } from "./sse-clients";
import type { SseClients } from "./sse-clients";
import { RECENT_TICKER_BODY_MAX } from "./constants";
import { displayWeatherPromotionLevel, isDisplayWeatherSeverity } from "./protocol";
import type { DisplayEventDtoV1, DisplayIntensityGroupV1, DisplayRecentQuakeV1, DisplayServerMessage, DisplayStateSnapshotV1, DisplayWeatherAlertV1, DisplayWeatherChangeKindV1, DisplayWeatherChangeV1, DisplayWeatherPromotionEntryV1, DisplayWeatherPromotionV1 } from "./types";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

/** 接続時 snapshot 縮退の各段の予算 (spec: field 別の多段ラダー) */
const DEGRADED_TICKER_MAX = 20;
const QUAKE_GROUP_AREA_MAX = 8;   // latestQuake 各震度の地域上限
const WEATHER_AREA_MAX = 6;        // 気象カード各種別の地域上限
const WEATHER_EMERGENCY_FALLBACK_AREA_MAX = 512; // 予算超過時だけ使う L4/L5 の最終安全弁
const WEATHER_CHANGE_WIRE_MAX = 12; // change DTO 専用の item 上限。現況 weatherAlerts とは独立
const WEATHER_CHANGE_WIRE_COMPACT_MAX = 4;
const WEATHER_CHANGE_WIRE_MIN_MAX = 2;
const DEGRADED_RECENT_QUAKES = 3;

const WEATHER_CHANGE_KIND_ORDER: readonly DisplayWeatherChangeKindV1[] = [
  "upgraded",
  "added",
  "kindChanged",
  "downgraded",
  "released",
];

export interface DisplayRequestHandlerDeps {
  distDir: string;
  clients: SseClients;
  getSnapshot: () => DisplayStateSnapshotV1;
  log: { info(msg: string): void; warn(msg: string): void };
  /** 非 loopback 接続に要求するアクセストークン。null なら認証なし (loopback バインド時)。
   *  loopback からの接続はトークン設定時も免除する (常設 kiosk のローカルブラウザを壊さない) */
  token?: string | null;
}

/** リクエスト元 socket アドレスが loopback かどうか (IPv4-mapped IPv6 も含む) */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (addr == null) return false;
  return addr === "::1" || addr.startsWith("127.") || addr.startsWith("::ffff:127.");
}

// トークン比較は長さ差でも時間差を作らないよう sha256 digest 同士を timingSafeEqual で比べる
function tokenMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** トークン保護の対象パス。データを運ぶ /events と、その入口になるページ本体のみ。
 *  静的アセット (ページ内から token なしで参照される) と /healthz・/tips (電文データを含まない)
 *  は対象外とする */
function isTokenProtectedPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/index.html" || pathname === "/events";
}

/** node:http の RequestListener を組み立てる。ルートは /healthz・/events (SSE)・/tips・static 配信の 4 つのみ */
export function createDisplayRequestListener(
  deps: DisplayRequestHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;
    const token = deps.token;
    if (token != null && isTokenProtectedPath(pathname) && !isLoopbackAddress(req.socket.remoteAddress)) {
      const given = requestUrl.searchParams.get("token");
      if (given == null || !tokenMatches(given, token)) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        res.end("display server: アクセストークンが必要です (URL に ?token=<displayToken> を付けてください)");
        return;
      }
    }
    if (pathname === "/healthz") {
      respondJson(res, 200, { ok: true, clients: deps.clients.count() });
      return;
    }
    if (pathname === "/events") {
      handleSse(res, deps);
      return;
    }
    if (pathname === "/tips") {
      const rawContext = requestUrl.searchParams.get("context") ?? "standby";
      if (rawContext !== "standby" && rawContext !== "quakeMap" && rawContext !== "emergency") {
        respondJson(res, 400, { error: "context must be standby, quakeMap, or emergency" }, { "cache-control": "no-store" });
        return;
      }
      // 常設 kiosk のブラウザ/中間キャッシュに古いデッキを固定させない (毎接続で最新の抽選を返す)
      respondJson(res, 200, { tips: buildTipsDeck(rawContext as TipContext) }, { "cache-control": "no-store" });
      return;
    }
    serveStatic(pathname, res, deps.distDir);
  };
}

function respondJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(body));
}

function handleSse(res: ServerResponse, deps: DisplayRequestHandlerDeps): void {
  // add() が false (MAX_CLIENTS 超) の場合はまだヘッダを送っていないので通常の 503 を返せる
  if (!deps.clients.add(res)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("display server: 接続数が上限に達しています");
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  sendInitialSnapshot(res, deps);
}

/** 地域リストを max まで切り、切った分を omittedAreaCount に加算する (縮退後も「ほか N 地域」が成立)。
 *  震度6弱以上 (rank 7〜9) は省略しない — 強い揺れの把握を省略で妨げないため
 *  (目視ゲート第3波 Fix8)。5強以下 (rank 1〜6) のみ従来どおり cap する */
function capIntensityGroups(groups: DisplayIntensityGroupV1[], max: number): DisplayIntensityGroupV1[] {
  return groups.map((g) => {
    if (g.rank >= 7 && g.rank <= 9) return g;
    return g.areas.length > max
      ? { ...g, areas: g.areas.slice(0, max), omittedAreaCount: g.omittedAreaCount + (g.areas.length - max) }
      : g;
  });
}

/** recentQuakes[].intensityGroups (履歴カードの各地震度) を各震度 max 地域まで刈る。
 *  latestQuake と同じ capIntensityGroups を再利用する (震度6弱以上は cap 対象外)。
 *  intensityGroups 未設定・空 (古い経路) はそのまま通す */
function capRecentQuakeGroups(quakes: DisplayRecentQuakeV1[], max: number): DisplayRecentQuakeV1[] {
  return quakes.map((q) => (q.intensityGroups != null && q.intensityGroups.length > 0
    ? { ...q, intensityGroups: capIntensityGroups(q.intensityGroups, max) }
    : q));
}

/** host / largeQuake から参照されない地図 event だけを event 単位で落とす。
 * active な文字情報と、その文字情報に完全一致する地図は縮退対象にしない。 */
function dropUnreferencedQuakeMapEvents(
  snapshot: DisplayStateSnapshotV1,
): DisplayStateSnapshotV1 {
  const quake = snapshot.mapLayers?.quake;
  if (quake == null || quake.events.length === 0) return snapshot;
  const hostEventKey = quake.nonEmergencyHost?.eventKey;
  const events = quake.events.filter((event) =>
    event.eventKey === hostEventKey
    || snapshot.largeQuakes.some((large) =>
      large.mapEventKey === event.eventKey
      && large.mapSourceType === event.sourceType
      && large.mapRevision?.reportTimeMs === event.revision.reportTimeMs
      && large.mapRevision.serial === event.revision.serial),
  );
  if (events.length === quake.events.length) return snapshot;
  return {
    ...snapshot,
    mapLayers: {
      ...snapshot.mapLayers,
      quake: { ...quake, events },
    },
  };
}

/**
 * weatherAlerts[].items[].shownAreas を max まで切り、切った分を omittedAreaCount に加算する。
 *
 * **この点灯で追加された地域は優先して残す** (spec 追補 C3)。素朴に先頭 N 件で切ると、
 * 追加地域が後方にあったときに真っ先に消えて画面のハイライトが空振りする — 大量発表で
 * 縮退が起きるときこそ「どこが増えたか」を見たいので、そこを守る。
 * 残す順序は「追加地域 → 元の並び」で、元の並び自体は保つ (読み手の見え方を変えない)。
 */
function capWeatherAreas(
  alerts: DisplayWeatherAlertV1[],
  max: number,
  promotion?: DisplayWeatherPromotionV1,
): DisplayWeatherAlertV1[] {
  return alerts.map((alert) => {
    const promoted = promotion?.[alert.source] != null;
    const added = addedAreaSetOf(promotion?.[alert.source]);
    return {
      ...alert,
      items: alert.items.map((item) => {
        // 主役パネルが読む L4/L5 行だけ全件を守る。同じ source に併載された L3 以下まで
        // 無制限にすると、通常カード用の行だけで SSE 予算を使い切る。
        if (promoted && isPromotedWeatherItem(item)) return item;
        return capWeatherItemAreas(item, max, added.get(item.kind));
      }),
    };
  });
}

function isPromotedWeatherItem(item: DisplayWeatherAlertV1["items"][number]): boolean {
  return isDisplayWeatherSeverity(item.displaySeverity)
    && displayWeatherPromotionLevel(item.displaySeverity) != null;
}

function capWeatherItemAreas(
  item: DisplayWeatherAlertV1["items"][number],
  max: number,
  priority?: Set<string>,
): DisplayWeatherAlertV1["items"][number] {
  if (item.shownAreas.length <= max) return item;
  const kept = priority == null
    ? item.shownAreas.slice(0, max)
    : [
      ...item.shownAreas.filter((a) => priority.has(a)),
      ...item.shownAreas.filter((a) => !priority.has(a)),
    ].slice(0, max);
  const keptSet = new Set(kept);
  const shownAreas = item.shownAreas.filter((a) => keptSet.has(a));
  return {
    ...item,
    shownAreas,
    omittedAreaCount: item.omittedAreaCount + (item.shownAreas.length - shownAreas.length),
  };
}

/** 通常縮退と ticker 除去後も超過するときだけ使う weather の代替段。
 * 昇格 source では緊急パネルが読む L4/L5 行を優先して残し、L3 以下を落としたうえで
 * 各緊急行にも大きめの上限を掛ける。全地域保持より「SSE 自体が届かない」を避ける最終安全弁。 */
function prioritizePromotedWeatherItems(
  alerts: DisplayWeatherAlertV1[],
  promotion?: DisplayWeatherPromotionV1,
): DisplayWeatherAlertV1[] {
  return alerts.map((alert) => {
    const promoted = promotion?.[alert.source];
    if (promoted == null) return alert;
    const added = addedAreaSetOf(promoted);
    return {
      ...alert,
      items: alert.items
        .filter(isPromotedWeatherItem)
        .map((item) => capWeatherItemAreas(
          item,
          WEATHER_EMERGENCY_FALLBACK_AREA_MAX,
          added.get(item.kind),
        )),
    };
  });
}

/** change DTO は構造を壊さず item だけを代表枠アルゴリズムで縮退する。 */
function capWeatherChangeItems(
  change: DisplayWeatherChangeV1,
  max: number,
): DisplayWeatherChangeV1 {
  if (change.changes.length <= max) return change;
  const byKind = new Map<DisplayWeatherChangeKindV1, DisplayWeatherChangeV1["changes"]>();
  for (const kind of WEATHER_CHANGE_KIND_ORDER) byKind.set(kind, []);
  for (const item of change.changes) byKind.get(item.kind)?.push(item);

  const presentKinds = WEATHER_CHANGE_KIND_ORDER.filter((kind) =>
    (byKind.get(kind)?.length ?? 0) > 0,
  );
  const reservedKinds = max >= presentKinds.length
    ? presentKinds
    : max >= 2
      && presentKinds.length >= 3
      && (byKind.get("upgraded")?.length ?? 0) > 0
      && (byKind.get("released")?.length ?? 0) > 0
      ? ["upgraded", "released"] as const
      : presentKinds.slice(0, max);
  const selected = new Set<DisplayWeatherChangeV1["changes"][number]>();
  for (const kind of reservedKinds) {
    const item = byKind.get(kind)?.[0];
    if (item != null) selected.add(item);
  }
  for (const kind of WEATHER_CHANGE_KIND_ORDER) {
    for (const item of byKind.get(kind) ?? []) {
      if (selected.size >= max) break;
      selected.add(item);
    }
    if (selected.size >= max) break;
  }

  const changes = change.changes.filter((item) => selected.has(item));
  const omitted: DisplayWeatherChangeV1["omitted"] = {};
  for (const kind of WEATHER_CHANGE_KIND_ORDER) {
    const total = (byKind.get(kind)?.length ?? 0) + (change.omitted[kind] ?? 0);
    const retained = changes.filter((item) => item.kind === kind).length;
    if (total > retained) omitted[kind] = total - retained;
  }
  return { ...change, changes, omitted };
}

/** 昇格 entry の addedAreas を「種別 → 地域名の集合」へ */
function addedAreaSetOf(entry: DisplayWeatherPromotionEntryV1 | null | undefined): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const a of entry?.addedAreas ?? []) map.set(a.kind, new Set(a.areas));
  return map;
}

// snapshot は field 別予算で縮退する (軽い縮退から順に累積)。
// 順序の設計原則 (2026-07-11): 待機画面の地震履歴 recentQuakes は「軽量なのに巻き添えで先に
// 消える」ことを避けるため最後に回す。肥大源 (recentTicker 本文/件数・weatherAlerts 地域・
// 未参照の地図 event) を先に刈り尽くしてから recentQuakes に手を付ける。
// 1. recentTicker の tickerBody を先頭 N 件 (最新) 以外 null 化 (本文間引き。件数は削らない)
// 2. recentTicker full → 20
// 3. latestQuake.intensityGroups[] 各震度 max 8 地域 + omittedAreaCount (震度6弱以上は cap 対象外)
// 4. weatherAlerts[].items[].shownAreas 各種別 max 6 地域 + omittedAreaCount
// 5. weatherChange の item だけをカテゴリ代表枠つきで max 12
// 6. recentTicker 0 (recentQuakes はまだ触らない)
// 7. weather の緊急優先代替縮退 (L3 以下を落とし、L4/L5 を大きめの上限まで保持)
// 8. weatherChange の item だけを max 4 へ再縮退
// 9. active host / largeQuake から参照されない地図 event を event 単位で除外
// 10. recentQuakes[].intensityGroups を各震度 max 8 地域に刈る (件数は削らず各地震度の地域列だけ間引く)
// 11. recentQuakes[].intensityGroups を空配列化 (履歴カードの各地震度を諦める。件数・骨子情報は残す)
// 12. recentQuakes 5 → 3 (肥大源を刈り尽くした後の最終手前。カード自体を減らす)
// 13. weatherChange の item を max 2 へ再縮退
// 14. weatherChange の item を 0 件へ縮退 (カテゴリ別 omitted は残す)
// 15. recentQuakes 空 (最後の手段)
//
// 設計原則 (2026-07-14 各地震度配線): 履歴カードの各地震度 (intensityGroups) は「1 枚のカードに
// 付随する詳細」なので、カードの件数 (段 10) やカード自体 (段 11) を削るより前に、詳細の地域列 (段 8)
// → 詳細全体 (段 9) の順で先に諦める。骨子 (震源・M・最大震度) を持つカードを 5 枚残すことを、
// 各カードの各地震度より優先する。
//
// 設計原則 (2026-07-17 Fix11B): stats.sparklineData は数百バイトしかない軽量フィールドであり、
// 待機画面インストゥルメントの表示に必須のため、このラダーでは一切間引かない・空にしない。
// (recentTicker 本文・weatherAlerts 地域・未参照の地図 event など重い肥大源のみを刈る。)
function buildDegradeAttempts(full: DisplayStateSnapshotV1): DisplayStateSnapshotV1[] {
  const attempts: DisplayStateSnapshotV1[] = [full];
  let s = full;
  // まず本文を間引く (件数を削るより軽い縮退。先頭 N 件だけ tickerBody を残す)
  s = {
    ...s,
    // 本文を落とす段では重要語句強調 (tickerEmphasis) も一緒に落とす (本文なしの index span は無意味)
    recentTicker: s.recentTicker.map((dto, i) =>
      i < RECENT_TICKER_BODY_MAX || dto.tickerBody == null ? dto : { ...dto, tickerBody: null, tickerEmphasis: null }),
  };
  attempts.push(s);
  s = {
    ...s,
    recentTicker: capTickerKeepingActiveEews(s.recentTicker, s.activeEews, DEGRADED_TICKER_MAX),
  };
  attempts.push(s);
  s = {
    ...s,
    latestQuake: s.latestQuake != null
      ? { ...s.latestQuake, intensityGroups: capIntensityGroups(s.latestQuake.intensityGroups, QUAKE_GROUP_AREA_MAX) }
      : s.latestQuake,
  };
  attempts.push(s);
  s = { ...s, weatherAlerts: capWeatherAreas(s.weatherAlerts, WEATHER_AREA_MAX, s.weatherPromotion) };
  attempts.push(s);
  const wireWeatherChange = s.weatherChange;
  if (wireWeatherChange != null) {
    s = { ...s, weatherChange: capWeatherChangeItems(wireWeatherChange, WEATHER_CHANGE_WIRE_MAX) };
    attempts.push(s);
  }
  s = { ...s, recentTicker: [] };
  attempts.push(s);
  s = { ...s, weatherAlerts: prioritizePromotedWeatherItems(s.weatherAlerts, s.weatherPromotion) };
  attempts.push(s);
  const compactWeatherChange = s.weatherChange;
  if (compactWeatherChange != null) {
    s = { ...s, weatherChange: capWeatherChangeItems(compactWeatherChange, WEATHER_CHANGE_WIRE_COMPACT_MAX) };
    attempts.push(s);
  }
  s = dropUnreferencedQuakeMapEvents(s);
  attempts.push(s);
  s = { ...s, recentQuakes: capRecentQuakeGroups(s.recentQuakes, QUAKE_GROUP_AREA_MAX) };
  attempts.push(s);
  s = { ...s, recentQuakes: s.recentQuakes.map((q) => ({ ...q, intensityGroups: [] })) };
  attempts.push(s);
  s = { ...s, recentQuakes: s.recentQuakes.slice(0, DEGRADED_RECENT_QUAKES) };
  attempts.push(s);
  const minWeatherChange = s.weatherChange;
  if (minWeatherChange != null) {
    s = { ...s, weatherChange: capWeatherChangeItems(minWeatherChange, WEATHER_CHANGE_WIRE_MIN_MAX) };
    attempts.push(s);
    // 空 changes の DTO は wire に出さない契約。最終段では差分 surface 全体を落とし、
    // 現況 snapshot の配信可能性を優先する。
    s = { ...s, weatherChange: null };
    attempts.push(s);
  }
  s = { ...s, recentQuakes: [] };
  attempts.push(s);
  return attempts;
}

/** 縮退段 2 でも active EEW の最新 DTO は保持する。 */
function capTickerKeepingActiveEews(
  recentTicker: DisplayEventDtoV1[],
  activeEews: DisplayStateSnapshotV1["activeEews"],
  max: number,
): DisplayEventDtoV1[] {
  const activeKeys = new Set(
    activeEews.filter((e) => e.eventId != null).map((e) => `eew:${e.eventId}`),
  );
  if (activeKeys.size === 0) return recentTicker.slice(0, max);
  const kept = new Set<DisplayEventDtoV1>();
  const seenActive = new Set<string>();
  for (const dto of recentTicker) {
    if (dto.groupKey != null && activeKeys.has(dto.groupKey) && !seenActive.has(dto.groupKey)) {
      seenActive.add(dto.groupKey);
      kept.add(dto);
    }
  }
  const limit = Math.max(max, kept.size);
  for (const dto of recentTicker) {
    if (kept.size >= limit) break;
    kept.add(dto);
  }
  return recentTicker.filter((dto) => kept.has(dto));
}

export interface SnapshotDegradeResult {
  snapshot: DisplayStateSnapshotV1;
  /** 0 = 縮退なし。1 以上は buildDegradeAttempts の段番号。 */
  level: number;
}

/**
 * snapshot を多段ラダーで縮退させ、msgType の SSE encode (encodeSseGuarded と同じバイト上限)
 * に収まる最初の段を返す純関数。初回接続 snapshot と定期 state 配信の両方の安全弁として使う。
 * 全段を尽くしてなお上限を超える場合は null (呼び出し元が fail-loud に扱う)。
 */
export function degradeSnapshotToBudget(
  full: DisplayStateSnapshotV1,
  msgType: "snapshot" | "state",
): SnapshotDegradeResult | null {
  const attempts = buildDegradeAttempts(full);
  for (let level = 0; level < attempts.length; level++) {
    const snapshot = attempts[level]!;
    const msg: DisplayServerMessage = { type: msgType, snapshot };
    if (encodeSseGuarded(msg) != null) return { snapshot, level };
  }
  return null;
}

// recentTicker を一切削らない縮退ラダー (buildDegradeAttempts の weather/地図/履歴詳細相当のみ)。
// tickerSynced:true の state は recentTicker が「権威値」であることが前提のため、段1 (本文間引き)・
// 段2/5 (件数削減・空化) を通すと不完全な構成が権威として全置換されてしまう (レビュー R2 Important)。
// 完全な recentTicker を保ったまま他フィールドだけ縮退し、それでも収まらなければ呼び出し元が
// 通常の (recentTicker を諦める) ラダーへフォールバックする。
// stats.sparklineData は軽量なため縮退対象外 (Fix11B、標準ラダーと同じ原則)。
function buildDegradeAttemptsPreserveTicker(full: DisplayStateSnapshotV1): DisplayStateSnapshotV1[] {
  const attempts: DisplayStateSnapshotV1[] = [full];
  let s = full;
  s = {
    ...s,
    latestQuake: s.latestQuake != null
      ? { ...s.latestQuake, intensityGroups: capIntensityGroups(s.latestQuake.intensityGroups, QUAKE_GROUP_AREA_MAX) }
      : s.latestQuake,
  };
  attempts.push(s);
  s = { ...s, weatherAlerts: capWeatherAreas(s.weatherAlerts, WEATHER_AREA_MAX, s.weatherPromotion) };
  attempts.push(s);
  const syncedWireWeatherChange = s.weatherChange;
  if (syncedWireWeatherChange != null) {
    s = { ...s, weatherChange: capWeatherChangeItems(syncedWireWeatherChange, WEATHER_CHANGE_WIRE_MAX) };
    attempts.push(s);
  }
  s = { ...s, weatherAlerts: prioritizePromotedWeatherItems(s.weatherAlerts, s.weatherPromotion) };
  attempts.push(s);
  const syncedCompactWeatherChange = s.weatherChange;
  if (syncedCompactWeatherChange != null) {
    s = { ...s, weatherChange: capWeatherChangeItems(syncedCompactWeatherChange, WEATHER_CHANGE_WIRE_COMPACT_MAX) };
    attempts.push(s);
  }
  // active な文字・地図を保護し、未参照地図だけを原子的に落とす
  s = dropUnreferencedQuakeMapEvents(s);
  attempts.push(s);
  // recentQuakes[].intensityGroups も件数削減より先に刈る (標準ラダーと同じ段順序の設計原則)
  s = { ...s, recentQuakes: capRecentQuakeGroups(s.recentQuakes, QUAKE_GROUP_AREA_MAX) };
  attempts.push(s);
  s = { ...s, recentQuakes: s.recentQuakes.map((q) => ({ ...q, intensityGroups: [] })) };
  attempts.push(s);
  s = { ...s, recentQuakes: s.recentQuakes.slice(0, DEGRADED_RECENT_QUAKES) };
  attempts.push(s);
  const syncedMinWeatherChange = s.weatherChange;
  if (syncedMinWeatherChange != null) {
    s = { ...s, weatherChange: capWeatherChangeItems(syncedMinWeatherChange, WEATHER_CHANGE_WIRE_MIN_MAX) };
    attempts.push(s);
    s = { ...s, weatherChange: null };
    attempts.push(s);
  }
  s = { ...s, recentQuakes: [] };
  attempts.push(s);
  return attempts;
}

/**
 * tickerSynced:true の state 専用縮退。recentTicker (と tickerSynced フラグ) は絶対に削らず、
 * 他フィールドだけを縮退して収める。「同期 state は完全か、送らないか」の二値にするための関数
 * (spec §3-2、レビュー R2 Important 対応)。全段を尽くしてもなお超える場合は null を返し、
 * 呼び出し元 (hub.ts) が recentTicker を諦めた通常の除外 state にフォールバックする。
 */
export function degradeSyncedStateToBudget(full: DisplayStateSnapshotV1): SnapshotDegradeResult | null {
  const attempts = buildDegradeAttemptsPreserveTicker(full);
  for (let level = 0; level < attempts.length; level++) {
    const snapshot = attempts[level]!;
    const msg: DisplayServerMessage = { type: "state", snapshot };
    if (encodeSseGuarded(msg) != null) return { snapshot, level };
  }
  return null;
}

// 送信は生 res.write ではなく SseClients.sendTo (broadcast と同じ backpressure ガード経路) を通す。
// それでも MAX_SNAPSHOT_BYTES を超える場合は隠さず接続を切断する (fail loud):
// 全段を尽くしてなお 256KB を超えるのは現在状態そのものがワイヤ型として破綻していることを
// 意味するため、黙って送らないより気づける形にする。
function sendInitialSnapshot(res: ServerResponse, deps: DisplayRequestHandlerDeps): void {
  const full = deps.getSnapshot();
  const result = degradeSnapshotToBudget(full, "snapshot");
  if (result == null) {
    deps.log.warn("display server: 縮退後も snapshot が上限を超えたため接続を切断しました");
    res.destroy();
    return;
  }
  if (result.level > 0) {
    deps.log.info(`display server: snapshot が上限を超えたため縮退段 ${result.level} まで縮退して送信しました`);
  }
  deps.clients.sendTo(res, { type: "snapshot", snapshot: result.snapshot });
}

// Windows の prefix 衝突 (distDir と "distDir-evil" の文字列 prefix 一致) と URL エンコードに耐える
// よう、文字列 startsWith ではなく resolve + relative + isAbsolute で判定する。
function serveStatic(pathname: string, res: ServerResponse, distDir: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const target = decoded === "/" ? "/index.html" : decoded;
  const resolved = resolve(distDir, "." + target);
  const rel = relative(distDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(resolved) || statSync(resolved).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  const body = readFileSync(resolved);
  const contentType = CONTENT_TYPES[extname(resolved)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": contentType });
  res.end(body);
}
