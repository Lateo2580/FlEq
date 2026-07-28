import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { buildTipsDeck } from "./display-tips";
import { encodeSseGuarded } from "./sse-clients";
import type { SseClients } from "./sse-clients";
import { RECENT_TICKER_BODY_MAX } from "./constants";
import type { DisplayEventDtoV1, DisplayIntensityGroupV1, DisplayRecentQuakeV1, DisplayServerMessage, DisplayStateSnapshotV1, DisplayWeatherAlertV1, DisplayWeatherPromotionEntryV1, DisplayWeatherPromotionV1 } from "./types";

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
const DEGRADED_RECENT_QUAKES = 3;

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
    const pathname = (req.url ?? "/").split("?")[0] || "/";
    const token = deps.token;
    if (token != null && isTokenProtectedPath(pathname) && !isLoopbackAddress(req.socket.remoteAddress)) {
      const given = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
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
      // 常設 kiosk のブラウザ/中間キャッシュに古いデッキを固定させない (毎接続で最新の抽選を返す)
      respondJson(res, 200, { tips: buildTipsDeck() }, { "cache-control": "no-store" });
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
    const added = addedAreaSetOf(promotion?.[alert.source]);
    return {
      ...alert,
      items: alert.items.map((item) => {
        if (item.shownAreas.length <= max) return item;
        const priority = added.get(item.kind);
        const kept = priority == null
          ? item.shownAreas.slice(0, max)
          : [
            ...item.shownAreas.filter((a) => priority.has(a)),
            ...item.shownAreas.filter((a) => !priority.has(a)),
          ].slice(0, max);
        // 元の並び順で描くため、選抜後に出現順へ戻す
        const keptSet = new Set(kept);
        const shownAreas = item.shownAreas.filter((a) => keptSet.has(a));
        return {
          ...item,
          shownAreas,
          omittedAreaCount: item.omittedAreaCount + (item.shownAreas.length - shownAreas.length),
        };
      }),
    };
  });
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
// largeQuakes.intensityGroups) を先に刈り尽くしてから recentQuakes に手を付ける。
// 1. recentTicker の tickerBody を先頭 N 件 (最新) 以外 null 化 (本文間引き。件数は削らない)
// 2. recentTicker full → 20
// 3. latestQuake.intensityGroups[] 各震度 max 8 地域 + omittedAreaCount (震度6弱以上は cap 対象外)
// 4. weatherAlerts[].items[].shownAreas 各種別 max 6 地域 + omittedAreaCount
// 5. recentTicker 0 (recentQuakes はまだ触らない)
// 6. largeQuakes[].intensityGroups を空配列化 (緊急パネル側に表示があるため standby snapshot では可)
// 7. recentQuakes[].intensityGroups を各震度 max 8 地域に刈る (件数は削らず各地震度の地域列だけ間引く)
// 8. recentQuakes[].intensityGroups を空配列化 (履歴カードの各地震度を諦める。件数・骨子情報は残す)
// 9. recentQuakes 5 → 3 (肥大源を刈り尽くした後の最終手前。カード自体を減らす)
// 10. recentQuakes 空 (最後の手段)
//
// 設計原則 (2026-07-14 各地震度配線): 履歴カードの各地震度 (intensityGroups) は「1 枚のカードに
// 付随する詳細」なので、カードの件数 (段 9) やカード自体 (段 10) を削るより前に、詳細の地域列 (段 7)
// → 詳細全体 (段 8) の順で先に諦める。骨子 (震源・M・最大震度) を持つカードを 5 枚残すことを、
// 各カードの各地震度より優先する。
//
// 設計原則 (2026-07-17 Fix11B): stats.sparklineData は数百バイトしかない軽量フィールドであり、
// 待機画面インストゥルメントの表示に必須のため、このラダーでは一切間引かない・空にしない。
// (recentTicker 本文・weatherAlerts 地域・largeQuakes.intensityGroups など重い肥大源のみを刈る。)
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
  s = { ...s, recentTicker: [] };
  attempts.push(s);
  s = { ...s, largeQuakes: s.largeQuakes.map((q) => ({ ...q, intensityGroups: [] })) };
  attempts.push(s);
  s = { ...s, recentQuakes: capRecentQuakeGroups(s.recentQuakes, QUAKE_GROUP_AREA_MAX) };
  attempts.push(s);
  s = { ...s, recentQuakes: s.recentQuakes.map((q) => ({ ...q, intensityGroups: [] })) };
  attempts.push(s);
  s = { ...s, recentQuakes: s.recentQuakes.slice(0, DEGRADED_RECENT_QUAKES) };
  attempts.push(s);
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
  /** 0 = 縮退なし (full のまま収まった)。1〜10 は buildDegradeAttempts の段番号
   *  (最終段 level 10 = recentQuakes 空) */
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

// recentTicker を一切削らない縮退ラダー (buildDegradeAttempts の段 3・4・6・7・8・9・10 相当のみ)。
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
  // 肥大源 largeQuakes.intensityGroups を recentQuakes より先に刈る (段順序の設計原則)
  s = { ...s, largeQuakes: s.largeQuakes.map((q) => ({ ...q, intensityGroups: [] })) };
  attempts.push(s);
  // recentQuakes[].intensityGroups も件数削減より先に刈る (標準ラダーと同じ段順序の設計原則)
  s = { ...s, recentQuakes: capRecentQuakeGroups(s.recentQuakes, QUAKE_GROUP_AREA_MAX) };
  attempts.push(s);
  s = { ...s, recentQuakes: s.recentQuakes.map((q) => ({ ...q, intensityGroups: [] })) };
  attempts.push(s);
  s = { ...s, recentQuakes: s.recentQuakes.slice(0, DEGRADED_RECENT_QUAKES) };
  attempts.push(s);
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
