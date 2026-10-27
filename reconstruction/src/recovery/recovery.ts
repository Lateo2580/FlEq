import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, InputBoundary, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { DmdataClassification } from "../../contracts/p3-dmdata-connect.types";
import type { ListHead, ListPage, ListQuery, RecoveryDigestHead, RecoveryDigestUnit, RecoveryDigestView, UnitWalk,
  UnitWalkResult } from "../../contracts/p3-recovery.types";
import { familyFor } from "../decode-material/decode-material";
import { exchange } from "../host/dmdata-rest";
import { operationOf } from "../ingress/ingress";
import { classifyHeadType, rowsByHeadType } from "../runtime/unit-coverage";

// P3-RECOVERY-001【発注 1】: 起動時の一覧の辿り（穴 d）と、その頭だけで作るダイジェスト（H32）。本文は取らず、mailbox にも入れない。

// P3-REC-D-ORDER-AND-LIMIT=A: 量の上限に当たったら、この順でその unit から後ろを落とす。U-E は一覧に出ない（H28）。
const WALK_ORDER = ["U-T", "U-V", "U-Q", "U-N", "U-W", "U-L", "U-R", "U-F", "U-B", "U-M", "U-Y"] as const satisfies readonly RuntimeUnitId[];
const BUNDLE_TYPES = 5; // P3-REC-D-LIST-QUERY: type はカンマで 5 つまで
const PAGE_LIMIT = 300; // P3-REC-RES-02（試行の回数で数える。再試行も dmdata の枠を使うので）
const GAP_MS = 500; // P3-REC-RES-05: 前の要求の終わりから
const RETRY_LIMIT = 3, RETRY_BUDGET_MS = 30_000, BACKOFF_MS = 1_000; // P3-REC-AC03 (3)(4)、spec:2218
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // P3-REC-D-DIGEST-WINDOW=A
const DMDATA_MARGIN_MS = 60_000, RECEIVED_MARGIN_MS = 10 * 60_000; // P3-REC-AC02 (2) の余白（置き値）
const DIGEST_HEADS = 500, DIGEST_BYTES = 16_384, STRING_BYTES = 256; // P3-REC-RES-04・RES-06、P2-A8-RES-05
const TRUNCATED_MARKER = "[truncated:fieldLimit]";

type WalkStart = Readonly<{ fetchFromMs: number; digestAfterMs: number; stopAtId: string | null; beforeWindow: boolean }>;
type Restored = Readonly<{ restoration: "restored" | "empty" | "unavailable"; boundary: InputBoundary | null }>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value != null && typeof value === "object" && !Array.isArray(value);
const optionalText = (value: unknown): value is string | null | undefined => value == null || typeof value === "string";
const textOrNull = (value: unknown): string | null => typeof value === "string" ? value : null;

function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

// item を項目ごとに確かめて頭を組む。束に無い型と test の item は null（捨てる）、形の壊れた item は invalid（そのページを failed）。
function headOf(item: unknown, types: readonly string[]): ListHead | null | "invalid" {
  if (!isRecord(item) || !isRecord(item.head) || !isRecord(item.xmlReport)) return "invalid";
  const { id, receivedTime } = item;
  const { type, test } = item.head;
  const receivedAtMs = typeof receivedTime === "string" ? Date.parse(receivedTime) : NaN;
  if (typeof id !== "string" || id === "" || typeof type !== "string" || typeof test !== "boolean" || !Number.isFinite(receivedAtMs)) return "invalid";
  // 1 型の束は前方一致で返る（P3-REC-D-LIST-QUERY）。test 区分は購読しない（operationContract）。
  const row = classifyHeadType(type);
  if (!types.includes(type) || test || row.status !== "ready") return null;
  const report = item.xmlReport.head, control = item.xmlReport.control;
  const operation: Operation | undefined = isRecord(control) ? operationOf(control.status) : undefined;
  if (!isRecord(report) || typeof report.title !== "string" || operation == null) return "invalid";
  return { id, unit: row.unit, headType: type, receivedAtMs, operation, title: report.title, headline: textOrNull(report.headline),
    reportDateTime: textOrNull(report.reportDateTime), infoType: textOrNull(report.infoType) };
}

/** GET /v2/telegram の 1 ページ。401/403 は authRejected を返すだけで、host の接続には触れない（P3-REC-AC03 (3)）。 */
async function listTelegramPage(apiKey: string, query: ListQuery, signal: AbortSignal): Promise<ListPage> {
  const cursor = query.cursorToken == null ? "" : `&cursorToken=${encodeURIComponent(query.cursorToken)}`;
  const answer = await exchange("GET", `/telegram?type=${query.types.join(",")}&limit=100&formatMode=raw&xmlReport=true${cursor}`, apiKey, signal);
  if (answer.kind !== "answered") return { kind: "failed" };
  if (answer.status === 401 || answer.status === 403) return { kind: "authRejected" };
  if (answer.status === 429) return { kind: "throttled", retryAfterMs: answer.retryAfter };
  if (answer.status < 200 || answer.status >= 300) return { kind: "failed" };
  const body = parse(answer.text);
  if (!isRecord(body) || body.status !== "ok" || !Array.isArray(body.items) || !optionalText(body.nextToken) || !optionalText(body.nextPooling))
    return { kind: "failed" };
  const heads: ListHead[] = [];
  for (const item of body.items) {
    const head = headOf(item, query.types);
    if (head === "invalid") return { kind: "failed" };
    if (head != null) heads.push(head);
  }
  return { kind: "ok", heads, nextToken: body.nextToken ?? null, nextPooling: body.nextPooling ?? null };
}

/** P3-REC-AC02 (2)(3): restored の返信の境界から、取得の下限・ダイジェストの下限・止める id・7 日の印を決める。 */
function walkStart(boundary: InputBoundary | null, restoration: "restored" | "empty" | "unavailable", startupWallMs: number): WalkStart {
  const windowFromMs = startupWallMs - WINDOW_MS;
  const known = restoration !== "restored" || boundary == null ? null
    : boundary.dmdataTime != null ? { atMs: boundary.dmdataTime, marginMs: DMDATA_MARGIN_MS }
      : boundary.receivedAt?.basis === "verified" ? { atMs: boundary.receivedAt.wallTimeMs, marginMs: RECEIVED_MARGIN_MS } : null;
  return {
    fetchFromMs: Math.max(known == null ? -Infinity : known.atMs - known.marginMs, windowFromMs),
    digestAfterMs: Math.max(known?.atMs ?? -Infinity, windowFromMs),
    stopAtId: restoration === "restored" ? boundary?.dmdataId ?? null : null,
    // 起点が分からないか、余白を引いた下限を 7 日で実際に切ったら「7 日より前は取り直していない」（P3-REC-AC15 (1)、統合担当の決め r1）。
    beforeWindow: known == null || known.atMs - known.marginMs < windowFromMs,
  };
}

/** 起動時の辿りの計画。購読している区分の型だけで束を作り、型を 1 つも持たない unit は入れない（P3-REC-AC02 (6)）。 */
function startupPlan(classifications: readonly DmdataClassification[], restored: Readonly<Partial<Record<RuntimeUnitId, Restored>>>,
  startupWallMs: number): Readonly<{ plan: readonly UnitWalk[]; starts: Readonly<Partial<Record<RuntimeUnitId, WalkStart>>> }> | null {
  const plan: UnitWalk[] = [];
  const starts: Partial<Record<RuntimeUnitId, WalkStart>> = {};
  for (const unit of WALK_ORDER) {
    // 束は unit 表の ready の型のうち購読している区分のものだけ（契約に無い区分の一覧は 401 になる、レビュー R1）。
    const types = [...rowsByHeadType].filter(([type, row]) => row.status === "ready" && row.unit === unit
      && classifications.some((item) => item === familyFor(type))).map(([type]) => type);
    if (types.length === 0) continue;
    const from = restored[unit];
    const start = walkStart(from?.boundary ?? null, from?.restoration ?? "unavailable", startupWallMs);
    starts[unit] = start;
    const bundles: string[][] = [];
    for (let at = 0; at < types.length; at += BUNDLE_TYPES) bundles.push(types.slice(at, at + BUNDLE_TYPES));
    plan.push({ unit, bundles, fetchFromMs: start.fetchFromMs, stopAtId: start.stopAtId });
  }
  return plan.length === 0 ? null : { plan, starts };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) { done(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); done(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish);
  });
}

/**
 * plan の順に束を新しい方から辿る。ページの上限・間隔・429・401/403・再試行をここで数える（P3-REC-AC02・AC03・AC04）。
 * signal は host の停止の開始で abort する一覧の歩き専用のもの（P3-REC-AC03 (6)）。now は host の時計の monotonic で、
 * 再試行の 30 秒の正本はこの経過時間（timer の abort は早く切るための手段、レビュー r1 ヘルツ P2）。
 */
async function walkList(apiKey: string, plan: readonly UnitWalk[], signal: AbortSignal, now: () => number): Promise<readonly UnitWalkResult[]> {
  let requests = 0;
  // 1 要求の試行。"limit" はページの上限、"ended" は 429 が尽きたか Retry-After が残りの期限を越えたか停止。
  const request = async (query: ListQuery): Promise<Exclude<ListPage, { kind: "throttled" }> | "limit" | "ended"> => {
    const started = now();
    // 合計 30 秒は試行の中の要求にも効かせる（exchange の 15 秒の timeout だけだと 30 秒を越える、レビュー r0 ヘルツ P2）。
    // 期限は停止と同じく exchange を壊し、期限の後に揃った応答は採らない。
    const deadline = new AbortController();
    const expired = () => deadline.signal.aborted || now() - started >= RETRY_BUDGET_MS;
    const expire = () => deadline.abort();
    const timer = setTimeout(expire, RETRY_BUDGET_MS);
    signal.addEventListener("abort", expire);
    let wait = 0, backoff = BACKOFF_MS, throttled = false;
    try {
      for (let retry = 0; ; retry += 1) {
        if (requests > 0) await pause(Math.max(GAP_MS, wait), deadline.signal);
        if (signal.aborted) return "ended";
        if (requests >= PAGE_LIMIT) return "limit";
        if (expired()) return throttled ? "ended" : { kind: "failed" };
        requests += 1;
        const page = await listTelegramPage(apiKey, query, deadline.signal);
        if (signal.aborted) return "ended";
        if (expired()) return throttled || page.kind === "throttled" ? "ended" : { kind: "failed" };
        if (page.kind === "ok" || page.kind === "authRejected") return page;
        throttled ||= page.kind === "throttled";
        wait = page.kind === "throttled" ? page.retryAfterMs ?? backoff : 0;
        if (page.kind === "throttled" && page.retryAfterMs == null) backoff *= 2;
        if (retry === RETRY_LIMIT || now() - started + Math.max(GAP_MS, wait) > RETRY_BUDGET_MS)
          return page.kind === "throttled" ? "ended" : page;
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", expire);
    }
  };
  const results: UnitWalkResult[] = [];
  let ended: "recoveryLimit" | "fetchFailed" | "authRejected" | null = null;
  for (const walk of plan) {
    const { unit } = walk;
    if (ended != null) { results.push({ unit, kind: "unsatisfied", reason: ended, listedPages: 0 }); continue; }
    const heads: ListHead[] = [];
    const seen = new Set<string>();
    let listedPages = 0, stopAtMs = -Infinity;
    let failed: "recoveryLimit" | "fetchFailed" | "authRejected" | null = null;
    bundles: for (const types of walk.bundles) {
      const tokens = new Set<string>();
      let cursorToken: string | null = null;
      for (;;) {
        const page = await request({ types, cursorToken });
        if (page === "limit" || page === "ended" || page.kind === "authRejected") {
          failed = ended = page === "limit" ? "recoveryLimit" : page === "ended" ? "fetchFailed" : "authRejected";
          break bundles;
        }
        if (page.kind === "failed") { failed = "fetchFailed"; break bundles; }
        listedPages += 1;
        let reached = false;
        for (const head of page.heads) {
          if (head.id === walk.stopAtId) stopAtMs = head.receivedAtMs;
          if (head.id === walk.stopAtId || head.receivedAtMs < walk.fetchFromMs) { reached = true; break; }
          // 束の重なりとページの間に届いた分の重複を id で除く（P3-REC-AC02 (3)）。
          if (!seen.has(head.id)) { seen.add(head.id); heads.push(head); }
        }
        if (reached || page.nextToken == null) break;
        if (tokens.has(page.nextToken)) { failed = "fetchFailed"; break bundles; }
        tokens.add(page.nextToken);
        cursorToken = page.nextToken;
      }
    }
    // 途中まで取れた unit も部分的に済みにしない（P3-REC-D-ORDER-AND-LIMIT、spec:2222）。境界の id の item より古い頭は、
    // どの束で見つけたかを問わず unit の全部の束から除く（P3-REC-AC15、統合担当の決め r1）。
    results.push(failed == null ? { unit, kind: "listed", heads: heads.filter((head) => head.receivedAtMs >= stopAtMs) }
      : { unit, kind: "unsatisfied", reason: failed, listedPages });
  }
  return results;
}

/** 辿れなかった unit ごとの WARN と、401/403 の 1 件（P3-REC-AC03 (3)(4)・AC04）。API キーと応答本文は載せない。 */
function walkDiagnostics(results: readonly UnitWalkResult[]): readonly DiagnosticDetails[] {
  const details: DiagnosticDetails[] = [];
  for (const result of results) {
    if (result.kind !== "unsatisfied") continue;
    if (result.reason === "authRejected") {
      if (!details.some((item) => item.reason === "recoveryAuthRejected"))
        details.push({ level: "WARN", component: "recovery", reason: "recoveryAuthRejected" });
    } else details.push({ level: "WARN", component: "recovery", reason: result.reason === "fetchFailed" ? "recoveryFetchFailed" : "recoveryLimit", unit: result.unit });
  }
  return details;
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

// 文字列 1 本を escape 込み 256 byte（印を含む）に切る（P3-REC-RES-06、P2-A8-RES-05）。
function bounded(text: string): string {
  if (jsonBytes(text) - 2 <= STRING_BYTES) return text;
  let prefix = "", bytes = 0;
  for (const character of text) {
    const size = jsonBytes(character) - 2;
    if (bytes + size > STRING_BYTES - TRUNCATED_MARKER.length) break;
    prefix += character;
    bytes += size;
  }
  return prefix + TRUNCATED_MARKER;
}

/**
 * 起動時のダイジェスト（P3-REC-AC15）。unit は plan の順、その中は新しい順に見出しを残し、件数（RES-04）か byte（RES-06）の枠に
 * 入らない所から後ろは型ごとの件数だけにする。utf8Bytes は作るときに 1 回だけ数えた digest の JSON の byte。
 */
function buildDigest(results: readonly UnitWalkResult[], starts: Readonly<Partial<Record<RuntimeUnitId, ReturnType<typeof walkStart>>>>):
  Readonly<{ digest: RecoveryDigestView; utf8Bytes: number }> {
  const listed: { heads: RecoveryDigestHead[]; omitted: Record<string, number>; candidates: readonly ListHead[] }[] = [];
  const units: RecoveryDigestUnit[] = results.map((result) => {
    const start = starts[result.unit];
    const beforeWindow = start?.beforeWindow ?? true;
    if (result.kind === "unsatisfied") return { unit: result.unit, beforeWindow, kind: "unsatisfied", reason: result.reason };
    const after = start?.digestAfterMs ?? -Infinity;
    const candidates = result.heads.filter((head) => head.receivedAtMs > after).sort((left, right) => right.receivedAtMs - left.receivedAtMs);
    const heads: RecoveryDigestHead[] = [], omitted: Record<string, number> = {};
    for (const head of candidates) omitted[head.headType] = (omitted[head.headType] ?? 0) + 1;
    listed.push({ heads, omitted, candidates });
    return { unit: result.unit, beforeWindow, kind: "listed", heads, omitted };
  });
  // 全部を件数にした形から始め、見出しを 1 件ずつ足す。件数を減らす・型の鍵を消すことは byte を増やさないので、
  // bytes は最後の digest の byte の上界のまま枠の内に留まる（型は 122 で、件数だけの形は枠に十分収まる）。
  let bytes = jsonBytes({ units }), shown = 0;
  fill: for (const entry of listed) for (const head of entry.candidates) {
    const view: RecoveryDigestHead = { headType: head.headType, operation: head.operation, title: bounded(head.title),
      headline: head.headline == null ? null : bounded(head.headline), reportDateTime: head.reportDateTime == null ? null : bounded(head.reportDateTime),
      receivedAt: head.receivedAtMs };
    const size = jsonBytes(view) + 1;
    if (shown >= DIGEST_HEADS || bytes + size > DIGEST_BYTES) break fill;
    entry.heads.push(view);
    if (--entry.omitted[head.headType] === 0) delete entry.omitted[head.headType];
    bytes += size;
    shown += 1;
  }
  const digest: RecoveryDigestView = { units };
  return { digest, utf8Bytes: jsonBytes(digest) };
}

export { buildDigest, listTelegramPage, startupPlan, walkDiagnostics, walkList, walkStart };
export type { Restored, WalkStart };
