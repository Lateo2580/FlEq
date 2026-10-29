import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, InputBoundary, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { DmdataClassification } from "../../contracts/p3-dmdata-connect.types";
import type { BodyResult, ListHead, ListPage, ListQuery, PollResult, PoolPosition, RecoveryDigestHead, RecoveryDigestUnit, RecoveryDigestView, UnitWalk,
  UnitWalkResult } from "../../contracts/p3-recovery.types";
import { familyFor } from "../decode-material/decode-material";
import { TRANSIENT_TYPES, VISIBLE_TRANSIENT } from "../domains/local-bulletins/local-bulletins";
import { exchange } from "../host/dmdata-rest";
import { operationOf } from "../ingress/ingress";
import { classifyHeadType, rowsByHeadType } from "../runtime/unit-coverage";

// P3-RECOVERY-001【発注 1】: 起動時の一覧の辿り（穴 d）と、その頭だけで作るダイジェスト（H32）。本文は取らず、mailbox にも入れない。
// 【発注 2】: 一覧の要求の待ちを 1 本にする ListRequestLane と、鮮度の突き合わせ（H41）の区分の一覧（pollClassification）。

// P3-REC-D-ORDER-AND-LIMIT=A: 量の上限に当たったら、この順でその unit から後ろを落とす。U-E は一覧に出ない（H28）。
const WALK_ORDER = ["U-T", "U-V", "U-Q", "U-N", "U-W", "U-L", "U-R", "U-F", "U-B", "U-M", "U-Y"] as const satisfies readonly RuntimeUnitId[];
const BUNDLE_TYPES = 5; // P3-REC-D-LIST-QUERY: type はカンマで 5 つまで
const PAGE_LIMIT = 300; // P3-REC-RES-02（試行の回数で数える。再試行も dmdata の枠を使うので）
const POLL_PAGE_LIMIT = 30, FULL_PAGE = 100; // P3-REC-RES-07（同じく試行の回数で数える）、limit=100 の満杯
const GAP_MS = 500; // P3-REC-RES-05: 前の要求の終わりから
const RETRY_LIMIT = 3, RETRY_BUDGET_MS = 30_000, BACKOFF_MS = 1_000; // P3-REC-AC03 (3)(4)、spec:2218
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // P3-REC-D-DIGEST-WINDOW=A
const DMDATA_MARGIN_MS = 60_000, RECEIVED_MARGIN_MS = 10 * 60_000; // P3-REC-AC02 (2) の余白（置き値）
const DIGEST_HEADS = 500, DIGEST_BYTES = 16_384, STRING_BYTES = 256; // P3-REC-RES-04・RES-06、P2-A8-RES-05
const DIGEST_UNIT_HEADS = 3; // P3-REC-D-DIGEST-BUDGET=D: 分野ごとに新しい順で見出しを 3 件まで
const TRUNCATED_MARKER = "[truncated:fieldLimit]";
// 【発注 3・4a・4b-1・4b-2】本文を流す unit の集合（P3-REC-AC12）。4b-2 で U-W を足す。U-F は取り直さない（P3-REC-D-UF-BASE=C）。
// N2: 型・最新だけで足りるか（latest、subject ごとに 1 件）・窓（P3-REC-D-START-WINDOW=B、Q-REC-PRECHECK-4 の M1）。U-T は P3-C5-N2、U-V は P3-C9-N2、U-N は P3-C8-N2（訂正・取消は同じ報にだけ効くので窓の中を全部、受信の順に）、U-Q は P3-C7-N2（長周期の 36 時間と記憶の 6 時間）。
// 4b-1（Q-REC-PRECHECK-5 の M1）: U-L 54 時間・U-R 42 時間・U-B 9 時間・U-M 3 日・U-Y 7 日。型は各 unit の ready の型の全部。
// 4b-2（Q-REC-PRECHECK-8 の N1）: U-W 24 時間。
const RECOVERABLE_UNITS = ["U-T", "U-V", "U-N", "U-Q", "U-W", "U-L", "U-R", "U-B", "U-M", "U-Y"] as const satisfies readonly RuntimeUnitId[];
const readyTypes = (unit: RuntimeUnitId): readonly string[] => [...rowsByHeadType].filter(([, row]) => row.status === "ready" && row.unit === unit).map(([type]) => type);
const N2: Readonly<Record<(typeof RECOVERABLE_UNITS)[number], Readonly<{ types: readonly string[]; windowMs: number; latest: boolean }>>> = { "U-T": { types: ["VTSE41"], windowMs: 7 * 86_400_000, latest: true },
  "U-V": { types: ["VFVO50", "VFVO54", "VFVO55"], windowMs: 30 * 86_400_000, latest: true }, "U-N": { types: ["VYSE50", "VYSE51", "VYSE52", "VYSE60"], windowMs: 30 * 86_400_000, latest: false }, "U-Q": { types: ["VXSE51", "VXSE52", "VXSE53", "VXSE61", "VXSE62"], windowMs: 42 * 3_600_000, latest: true },
  "U-W": { types: readyTypes("U-W"), windowMs: 24 * 3_600_000, latest: true }, "U-L": { types: readyTypes("U-L"), windowMs: 54 * 3_600_000, latest: true }, "U-R": { types: readyTypes("U-R"), windowMs: 42 * 3_600_000, latest: true },
  "U-B": { types: readyTypes("U-B"), windowMs: 9 * 3_600_000, latest: true }, "U-M": { types: readyTypes("U-M"), windowMs: 3 * 86_400_000, latest: true },
  "U-Y": { types: readyTypes("U-Y"), windowMs: 7 * 86_400_000, latest: true } };
const BODY_URL = "https://data.api.dmdata.jp/v1/", BODY_ID = /^[0-9A-Za-z]{1,128}$/;
const BODY_GAP_MS = 7_500; // P3-REC-RES-05: 本文は 5 分 40 回
const BODY_TARGET = { hostname: "data.api.dmdata.jp", prefix: "/v1", accept: "application/xml", limitBytes: 8 * 1024 * 1024, identity: true };
const recoverable = (unit: RuntimeUnitId): unit is (typeof RECOVERABLE_UNITS)[number] => RECOVERABLE_UNITS.some((item) => item === unit);
// 本文を流す型（その item は url と id の文字を境界で確かめる、P3-REC-AC01）。
const bodyType = (unit: RuntimeUnitId, type: string): boolean => recoverable(unit) && N2[unit].types.includes(type);
const windowOf = (unit: RuntimeUnitId): number => recoverable(unit) ? N2[unit].windowMs : WINDOW_MS;

type WalkStart = Readonly<{ fetchFromMs: number; digestAfterMs: number; stopAtId: string | null; beforeWindow: boolean }>;
type Restored = Readonly<{ restoration: "restored" | "empty" | "unavailable"; boundary: InputBoundary | null }>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value != null && typeof value === "object" && !Array.isArray(value);
const optionalText = (value: unknown): value is string | null | undefined => value == null || typeof value === "string";
const textOrNull = (value: unknown): string | null => typeof value === "string" ? value : null;

function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

// item を項目ごとに確かめて頭を組む。束・区分に無い型と test の item は head が null（捨てる）、形の壊れた item は invalid（そのページを failed）。
// receivedAtMs は濾す前の生の受信時刻（満杯・遡り・位置を生の値で決める、P3-REC-AC13 (2)）。refused は本文を流す型の item の url・id が合わない
// unit（その item は捨て、ページは failed にしない、P3-REC-AC01）。
function headOf(item: unknown, query: ListQuery): Readonly<{ head: ListHead | null; receivedAtMs: number; refused?: RuntimeUnitId }> | "invalid" {
  if (!isRecord(item) || !isRecord(item.head) || !isRecord(item.xmlReport)) return "invalid";
  const { id, receivedTime } = item;
  const { type, test } = item.head;
  const receivedAtMs = typeof receivedTime === "string" ? Date.parse(receivedTime) : NaN;
  if (typeof id !== "string" || id === "" || typeof type !== "string" || typeof test !== "boolean" || !Number.isFinite(receivedAtMs)) return "invalid";
  // 1 型の束は前方一致で返る（P3-REC-D-LIST-QUERY）。test 区分は購読しない（operationContract）。区分の一覧は U-E を除く（P3-REC-AC13 (6)）。
  const row = classifyHeadType(type);
  if (test || row.status !== "ready" || ("types" in query ? !query.types.includes(type)
    : row.unit === "U-E" || familyFor(type) !== query.classification)) return { head: null, receivedAtMs };
  const report = item.xmlReport.head, control = item.xmlReport.control;
  const operation: Operation | undefined = isRecord(control) ? operationOf(control.status) : undefined;
  if (!isRecord(report) || !isRecord(control) || typeof report.title !== "string" || typeof control.status !== "string" || operation == null) return "invalid";
  if (bodyType(row.unit, type) && (!BODY_ID.test(id) || item.url !== BODY_URL + id)) return { head: null, receivedAtMs, refused: row.unit };
  return { receivedAtMs, head: { id, unit: row.unit, headType: type, receivedAtMs, operation, title: report.title, headline: textOrNull(report.headline),
    reportDateTime: textOrNull(report.reportDateTime), infoType: textOrNull(report.infoType), serial: textOrNull(report.serial),
    eventId: textOrNull(report.eventId), controlDateTime: textOrNull(control.dateTime), controlStatus: control.status, test,
    editorialOffice: textOrNull(control.editorialOffice) } };
}

/**
 * GET /v2/telegram の 1 ページ。401/403 は authRejected を返すだけで、host の接続には触れない（P3-REC-AC03 (3)）。
 * nextPooling を渡すときも絞り込みの query を毎回付ける（token に入らない、P3-REC-AC13 (6)）。
 */
async function listTelegramPage(apiKey: string, query: ListQuery, signal: AbortSignal): Promise<ListPage> {
  const cursor = query.cursorToken == null ? "" : `&cursorToken=${encodeURIComponent(query.cursorToken)}`;
  const filter = "types" in query ? `type=${query.types.join(",")}` : `classification=${query.classification}`;
  const answer = await exchange("GET", `/telegram?${filter}&limit=100&formatMode=raw&xmlReport=true${cursor}`, apiKey, signal);
  if (answer.kind !== "answered") return { kind: "failed" };
  if (answer.status === 401 || answer.status === 403) return { kind: "authRejected" };
  if (answer.status === 429) return { kind: "throttled", retryAfterMs: answer.retryAfter };
  if (answer.status < 200 || answer.status >= 300) return { kind: "failed" };
  const body = parse(answer.text);
  if (!isRecord(body) || body.status !== "ok" || !Array.isArray(body.items) || !optionalText(body.nextToken) || !optionalText(body.nextPooling))
    return { kind: "failed" };
  const interval = body.nextPoolingInterval;
  if (interval != null && (typeof interval !== "number" || !Number.isFinite(interval) || interval < 0)) return { kind: "failed" };
  const heads: ListHead[] = [];
  const refused = new Set<RuntimeUnitId>();
  let oldest: number | null = null, latest: number | null = null;
  for (const item of body.items) {
    const read = headOf(item, query);
    if (read === "invalid") return { kind: "failed" };
    if (read.head != null) heads.push(read.head);
    if (read.refused != null) refused.add(read.refused);
    oldest = Math.min(oldest ?? Infinity, read.receivedAtMs);
    latest = Math.max(latest ?? -Infinity, read.receivedAtMs);
  }
  return { kind: "ok", heads, nextToken: body.nextToken ?? null, nextPooling: body.nextPooling ?? null, nextPoolingInterval: interval ?? null,
    rawCount: body.items.length, oldestRawReceivedAtMs: oldest, latestRawReceivedAtMs: latest, refused: [...refused] };
}

/**
 * P3-REC-AC02 (2)(3): restored の返信の境界から、取得の下限・ダイジェストの下限・止める id・7 日の印を決める。
 * windowMs は unit の N2 の窓で、取得の下限だけを替える（ダイジェストの下限と 7 日の印は 7 日のまま、P3-REC-AC02 (8)）。
 */
function walkStart(boundary: InputBoundary | null, restoration: "restored" | "empty" | "unavailable", startupWallMs: number,
  windowMs = WINDOW_MS): WalkStart {
  const windowFromMs = startupWallMs - WINDOW_MS;
  const known = restoration !== "restored" || boundary == null ? null
    : boundary.dmdataTime != null ? { atMs: boundary.dmdataTime, marginMs: DMDATA_MARGIN_MS }
      : boundary.receivedAt?.basis === "verified" ? { atMs: boundary.receivedAt.wallTimeMs, marginMs: RECEIVED_MARGIN_MS } : null;
  return {
    fetchFromMs: Math.max(known == null ? -Infinity : known.atMs - known.marginMs, startupWallMs - windowMs),
    digestAfterMs: Math.max(known?.atMs ?? -Infinity, windowFromMs),
    stopAtId: restoration === "restored" ? boundary?.dmdataId ?? null : null,
    // 起点が分からないか、余白を引いた下限を 7 日で実際に切ったら「7 日より前は取り直していない」（P3-REC-AC15 (1)、統合担当の決め r1）。
    beforeWindow: known == null || known.atMs - known.marginMs < windowFromMs,
  };
}

/** 起動時の辿りの計画。購読している区分の型だけで束を作り、型を 1 つも持たない unit は入れない（P3-REC-AC02 (6)）。 */
function startupPlan(classifications: readonly DmdataClassification[], restored: Readonly<Partial<Record<RuntimeUnitId, Restored>>>,
  startupWallMs: number): Readonly<{ plan: readonly UnitWalk[]; starts: Readonly<Partial<Record<RuntimeUnitId, WalkStart>>> }> | null {
  const starts: Partial<Record<RuntimeUnitId, WalkStart>> = {}, listed: Partial<Record<RuntimeUnitId, WalkStart>> = {};
  for (const unit of WALK_ORDER) {
    const from = restored[unit];
    const start = walkStart(from?.boundary ?? null, from?.restoration ?? "unavailable", startupWallMs, windowOf(unit));
    starts[unit] = start;
    // Q-REC-PRECHECK-10 N2（AC02 (8)・AC15 (1)）: 一覧だけはダイジェストの 7 日も覆うまで辿る。返す starts（uncovered と本文の起点）は N2 の窓のまま。
    listed[unit] = { ...start, fetchFromMs: Math.min(start.fetchFromMs, start.digestAfterMs) };
  }
  const plan = recoveryPlan(classifications, listed, WALK_ORDER);
  return plan.length === 0 ? null : { plan, starts: Object.fromEntries(plan.map(({ unit }) => [unit, starts[unit]])) };
}

/** 【発注 3】run の中のきっかけの起点（P3-REC-AC02 (7)）。境界は InputBoundaries.boundary(unit)（穴があれば穴の直前）で、余白と id は (2)(3) と同じ。 */
function recoveryStart(boundary: InputBoundary | null, nowWallMs: number, windowMs: number): WalkStart {
  return walkStart(boundary, "restored", nowWallMs, windowMs);
}

/** 起点を広げる（AC02 (7)）。下限は古い方で、2 つの起点が違えば止める id は使わない（片方の id で止まると古い方の範囲を覆わない）。 */
function widerStart(left: WalkStart | null, right: WalkStart): WalkStart {
  if (left == null || left === right) return right;
  return { ...left.fetchFromMs <= right.fetchFromMs ? left : right, fetchFromMs: Math.min(left.fetchFromMs, right.fetchFromMs),
    stopAtId: left.fetchFromMs === right.fetchFromMs && left.stopAtId === right.stopAtId ? left.stopAtId : null };
}

/** unit の部分集合の辿りの計画（startupPlan と同じ束）。購読している区分の型を 1 つも持たない unit と、起点の無い unit は入れない（P3-REC-AC02 (6)）。 */
function recoveryPlan(classifications: readonly DmdataClassification[], starts: Readonly<Partial<Record<RuntimeUnitId, WalkStart>>>,
  units: readonly RuntimeUnitId[]): readonly UnitWalk[] {
  const plan: UnitWalk[] = [];
  for (const unit of WALK_ORDER) {
    const start = starts[unit];
    if (!units.includes(unit) || start == null) continue;
    // 束は unit 表の ready の型のうち購読している区分のものだけ（契約に無い区分の一覧は 401 になる、レビュー R1）。
    const types = [...rowsByHeadType].filter(([type, row]) => row.status === "ready" && row.unit === unit
      && classifications.some((item) => item === familyFor(type))).map(([type]) => type);
    if (types.length === 0) continue;
    const bundles: string[][] = [];
    for (let at = 0; at < types.length; at += BUNDLE_TYPES) bundles.push(types.slice(at, at + BUNDLE_TYPES));
    plan.push({ unit, bundles, fetchFromMs: start.fetchFromMs, stopAtId: start.stopAtId });
  }
  return plan;
}

// subject の鍵を作る一覧の頭の欄（Q-REC-PRECHECK-5 の M3）。U-L は官署、U-M の竜巻は型ごとに官署と題、VPAW51 は対象の code が本文にしか無いので
// 絞らない（null）。ほかは EventID。鍵の欄が null の頭は絞らない。U-W の VPWS50 は官署を見ない（全国の現況は運用区分に 1 つで、別の官署の報も
// 置き換える）、partial は U-L と同じ官署（Q-REC-PRECHECK-8 の N1）。
function bodyKey(unit: RuntimeUnitId, head: ListHead): string | null {
  const prefix = `${head.operation}/${head.headType}/`;
  if (unit === "U-W" && head.headType === "VPWS50") return prefix;
  if (unit === "U-L" || unit === "U-W") return head.editorialOffice == null ? null : prefix + head.editorialOffice;
  if (unit === "U-M" && (head.headType === "VPHW50" || head.headType === "VPHW51"))
    return head.editorialOffice == null ? null : `${prefix}${head.editorialOffice}/${head.title}`;
  return unit === "U-M" && head.headType === "VPAW51" || head.eventId == null ? null : prefix + head.eventId;
}
// Q-REC-PRECHECK-5 の M2: U-M の短命の解説は報から 3 時間を過ぎると届いても証拠の記憶になるだけで画面に出ないので本文にしない。時刻の読めない頭は取る。
const lapsedTransient = (unit: RuntimeUnitId, head: ListHead, nowWallMs: number): boolean => unit === "U-M" && head.reportDateTime != null
  && TRANSIENT_TYPES.some((type) => type === head.headType) && Date.parse(head.reportDateTime) + VISIBLE_TRANSIENT <= nowWallMs;

/**
 * N2 の型の頭を、最新だけで足りる型は subject（運用区分と bodyKey の鍵）ごとに最新の 1 件に絞り、古い順に並べる（P3-REC-AC12・RES-03）。
 * 鍵の無い頭と、最新だけで足りない unit（U-N）の頭は絞らない。本文を流す unit の外は空。
 * shortcut: nowWallMs の既定は Date.now()（呼び手の composition-root は 4b-1 の allowedPaths の外）。root の時計を渡すのは次に root を触る発注で。
 */
function bodiesFor(unit: RuntimeUnitId, heads: readonly ListHead[], nowWallMs = Date.now()): readonly ListHead[] {
  if (!recoverable(unit)) return [];
  // P3-REC-D-UW-PARTIALS=A: U-W の partial は同じ運用区分の窓の中の最新の取消でない VPWS50 より後に受けたものだけ（その区分に無ければ切らない）。
  // 取消で切ると、1 つ前の VPWS50 から取消までの partial を取らないまま確認済みになる（4b-2 r1、統合担当の決め）。
  const national = new Map<string, number>();
  if (unit === "U-W") for (const head of heads) if (head.headType === "VPWS50" && head.infoType !== "取消")
    national.set(head.operation, Math.max(national.get(head.operation) ?? -Infinity, head.receivedAtMs));
  const latest = new Map<string, ListHead>();
  for (const head of heads) {
    if (!bodyType(unit, head.headType) || lapsedTransient(unit, head, nowWallMs)) continue;
    if (head.headType !== "VPWS50" && head.receivedAtMs <= (national.get(head.operation) ?? -Infinity)) continue;
    const subject = N2[unit].latest ? bodyKey(unit, head) : null;
    const key = subject ?? `#${head.id}`;
    const found = latest.get(key);
    if (found == null || head.receivedAtMs > found.receivedAtMs) latest.set(key, head);
  }
  return [...latest.values()].sort((left, right) => left.receivedAtMs - right.receivedAtMs);
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
 * 取り直しの一覧の要求の待ち（P3-REC-AC13 (7)・RES-05）。run ごとに 1 つを host が持ち、起動の辿り・H41・発注 3 の取り直しが共有する。
 * 同時に走る要求は 1 本で、次の要求は notBefore まで待つ。notBefore には前の要求の終わり＋500 ms・429 の Retry-After（無ければ 1 秒から倍々）・
 * nextPoolingInterval の遅い方を書き、区分・周期・切断・再接続をまたいで引き継ぐ（リセットしない）。再試行はしない（呼び手の send）。
 * 無いと: 起動の辿りと H41 の要求が並んで走り、2 req/s と 429 の待ちを互いに知らずに破る。
 */
class ListRequestLane {
  notBeforeMonotonicMs = -Infinity;
  private running: Promise<unknown> = Promise.resolve();
  // 倍々の基点。Retry-After の無い 429 が続く間だけ伸び、429 でない応答で 1 秒へ戻す（統合担当の決めが無いので、続いた 429 だけを倍々と読んだ）。
  private backoffMs = BACKOFF_MS;

  request(apiKey: string, query: ListQuery, signal: AbortSignal, now: () => number): Promise<ListPage> {
    const sent = this.running.then(async (): Promise<ListPage> => {
      const waitMs = this.notBeforeMonotonicMs - now();
      if (waitMs > 0) await pause(waitMs, signal);
      if (signal.aborted) return { kind: "failed" };
      const page = await listTelegramPage(apiKey, query, signal);
      const after = page.kind === "throttled" ? page.retryAfterMs ?? this.backoffMs : page.kind === "ok" ? page.nextPoolingInterval ?? 0 : 0;
      this.backoffMs = page.kind === "throttled" && page.retryAfterMs == null ? this.backoffMs * 2 : BACKOFF_MS;
      this.notBeforeMonotonicMs = Math.max(this.notBeforeMonotonicMs, now() + Math.max(GAP_MS, after));
      return page;
    });
    this.running = sent.catch(() => {});
    return sent;
  }
}

/**
 * 【発注 3】本文の要求の待ち（P3-REC-AC03 (9)・RES-05）。本文は一覧と別の枠（data.api.dmdata.jp）なので run に 1 つを別に持つ。
 * 1 本ずつ、前の要求の終わりから 7.5 秒・429 の Retry-After（無ければ 1 秒から倍々）の遅い方まで待つ。ListRequestLane と同じ形。
 * 無いと: 本文の要求が 5 分 40 回を越えて dmdata の枠を食い、同じ回線の他の取得を止める。
 */
class BodyRequestLane {
  notBeforeMonotonicMs = -Infinity;
  private running: Promise<unknown> = Promise.resolve();
  private backoffMs = BACKOFF_MS;

  request(apiKey: string, id: string, signal: AbortSignal, now: () => number): Promise<BodyResult> {
    const sent = this.running.then(async (): Promise<BodyResult> => {
      const waitMs = this.notBeforeMonotonicMs - now();
      if (waitMs > 0) await pause(waitMs, signal);
      if (signal.aborted) return { kind: "lost" };
      const answer = await exchange("GET", `/${id}`, apiKey, signal, undefined, BODY_TARGET);
      // 8 MiB を越える本文は断る（lost と分け、再試行しない、P3-REC-AC01）。
      const result: BodyResult = answer.kind === "tooLarge" ? { kind: "failed" } : answer.kind !== "answered" ? { kind: "lost" }
        : answer.status === 401 || answer.status === 403 ? { kind: "authRejected" }
          : answer.status === 429 ? { kind: "throttled", retryAfterMs: answer.retryAfter }
            // 旧築 rest-client.ts と同じく XML を名乗る応答だけを本文にする（P3-REC-AC01）。
            : answer.status < 200 || answer.status >= 300 || !/^(application|text)\/xml\b/i.test(answer.contentType?.trim() ?? "") ? { kind: "failed" }
              : { kind: "ok", bytes: answer.bytes, contentType: answer.contentType! };
      const after = result.kind === "throttled" ? result.retryAfterMs ?? this.backoffMs : 0;
      this.backoffMs = result.kind === "throttled" && result.retryAfterMs == null ? this.backoffMs * 2 : BACKOFF_MS;
      this.notBeforeMonotonicMs = Math.max(this.notBeforeMonotonicMs, now() + Math.max(BODY_GAP_MS, after));
      return result;
    });
    this.running = sent.catch(() => {});
    return sent;
  }
}

/**
 * 本文 1 件の取得（P3-REC-AC01・AC03 (4)(7)）。id は英数字だけ（一覧の url は headOf で確かめた）。lost は 1 回だけ、429 は 3 回まで
 * lane の待ちで再試行し、再試行の合計 30 秒は send と同じく呼び手の時計 now の経過時間で数える（要求の前と応答の後で比べ、timer の abort は
 * 早く切るための手段）。期限の後に揃った応答は採らない。再試行も本文の間隔（lane）と枠（呼び手の RES-01）に数える。
 */
async function fetchBody(lane: BodyRequestLane, apiKey: string, head: ListHead, signal: AbortSignal, now: () => number): Promise<BodyResult> {
  if (!BODY_ID.test(head.id)) return { kind: "failed" };
  const started = now();
  const deadline = new AbortController();
  const expire = () => deadline.abort();
  const timer = setTimeout(expire, RETRY_BUDGET_MS);
  signal.addEventListener("abort", expire);
  const expired = () => deadline.signal.aborted || now() - started >= RETRY_BUDGET_MS;
  let retriedLost = false, throttled = false;
  try {
    for (let retry = 0; ; retry += 1) {
      if (signal.aborted) return { kind: "lost" };
      if (expired()) return throttled ? { kind: "throttled", retryAfterMs: null } : { kind: "failed" };
      const result = await lane.request(apiKey, head.id, deadline.signal, now);
      if (signal.aborted) return { kind: "lost" };
      throttled ||= result.kind === "throttled";
      if (expired()) return throttled ? { kind: "throttled", retryAfterMs: null } : { kind: "failed" };
      if (result.kind === "lost" && !retriedLost) { retriedLost = true; continue; }
      if (result.kind === "throttled" && retry < RETRY_LIMIT && lane.notBeforeMonotonicMs - started <= RETRY_BUDGET_MS) continue;
      return result;
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", expire);
  }
}

/**
 * 1 要求の試行（P3-REC-AC03 (3)(4)）。再試行は 3 回・合計 30 秒で、30 秒の正本は呼び手の時計 now の経過時間（要求の前と応答の後で比べる。
 * timer の abort は早く切るための手段、レビュー r1 ヘルツ P2）。pages は試行の回数とその上限（再試行も dmdata の枠を使うので試行で数える）。
 * "limit" はページの上限、"ended" は 429 が尽きたか Retry-After が残りの期限を越えたか停止。
 */
async function send(lane: ListRequestLane, apiKey: string, query: ListQuery, signal: AbortSignal, now: () => number,
  pages: { sent: number; readonly limit: number }): Promise<Exclude<ListPage, { kind: "throttled" }> | "limit" | "ended"> {
  const started = now();
  // 合計 30 秒は試行の中の要求にも効かせる（exchange の 15 秒の timeout だけだと 30 秒を越える、レビュー r0 ヘルツ P2）。
  // 期限は停止と同じく待ちと exchange を壊し、期限の後に揃った応答は採らない。
  const deadline = new AbortController();
  const expired = () => deadline.signal.aborted || now() - started >= RETRY_BUDGET_MS;
  const expire = () => deadline.abort();
  const timer = setTimeout(expire, RETRY_BUDGET_MS);
  signal.addEventListener("abort", expire);
  let throttled = false;
  try {
    // 引き継いだ待ち（429・nextPoolingInterval）が期限を越えるなら待たずに終える（P3-REC-AC03 (3)・AC13 (7)）。
    if (lane.notBeforeMonotonicMs - started > RETRY_BUDGET_MS) return "ended";
    for (let retry = 0; ; retry += 1) {
      if (signal.aborted) return "ended";
      if (pages.sent >= pages.limit) return "limit";
      if (expired()) return throttled ? "ended" : { kind: "failed" };
      pages.sent += 1;
      const page = await lane.request(apiKey, query, deadline.signal, now);
      if (signal.aborted) return "ended";
      if (expired()) return throttled || page.kind === "throttled" ? "ended" : { kind: "failed" };
      if (page.kind === "ok" || page.kind === "authRejected") return page;
      throttled ||= page.kind === "throttled";
      // 次の試行の待ち（lane の notBefore）が残りの期限を越えるなら待たずに終える（P3-REC-AC03 (3)）。
      if (retry === RETRY_LIMIT || lane.notBeforeMonotonicMs - started > RETRY_BUDGET_MS) return page.kind === "throttled" ? "ended" : page;
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", expire);
  }
}

/**
 * plan の順に束を新しい方から辿る。ページの上限・間隔・429・401/403・再試行をここで数える（P3-REC-AC02・AC03・AC04）。
 * signal は host の停止の開始で abort する一覧の歩き専用のもの（P3-REC-AC03 (6)）。now は host の時計の monotonic。
 */
async function walkList(lane: ListRequestLane, apiKey: string, plan: readonly UnitWalk[], signal: AbortSignal, now: () => number):
  Promise<readonly UnitWalkResult[]> {
  const pages = { sent: 0, limit: PAGE_LIMIT };
  const request = (query: ListQuery) => send(lane, apiKey, query, signal, now, pages);
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
        if (page.refused.includes(unit)) { failed = "fetchFailed"; break bundles; }
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

/**
 * H41 の 1 区分 1 周期の一覧（P3-REC-AC13 (1)(2)(6)(7)）。位置が無いか token が無ければ素の query で位置を作るだけ（seeded）。
 * 位置があれば nextPooling で前回より新しい頭を引き、生の 100 件の応答は nextToken で位置の時刻まで遡る（RES-07 で打ち切る）。
 * 比べるのは dmdata の時刻どうしだけで、host の wall は使わない。unmatched では位置を進めない。
 */
async function pollClassification(lane: ListRequestLane, apiKey: string, classification: DmdataClassification, position: PoolPosition | null,
  signal: AbortSignal, now: () => number): Promise<PollResult> {
  const pages = { sent: 0, limit: POLL_PAGE_LIMIT };
  // "ended" は 429 の尽きか停止（停止の後の結果は呼び手が捨てる）。
  const unmatched = (page: Awaited<ReturnType<typeof send>>): PollResult => ({ kind: "unmatched",
    reason: page === "limit" ? "pageLimit" : page === "ended" ? "throttled" : page.kind === "authRejected" ? "authRejected" : "fetchFailed" });
  const first = await send(lane, apiKey, { classification, cursorToken: position?.token ?? null }, signal, now, pages);
  if (first === "limit" || first === "ended" || first.kind !== "ok") return unmatched(first);
  const reached = { token: first.nextPooling, latestRawReceivedAtMs: first.latestRawReceivedAtMs ?? position?.latestRawReceivedAtMs ?? null };
  if (position?.token == null) return { kind: "seeded", position: reached };
  const since = position.latestRawReceivedAtMs;
  // 境界の検査で item を捨てた unit は、その周期は突き合わせない（P3-REC-AC01）。
  const refused = new Set(first.refused);
  // ページの間に届いた分の重複を id で除く（walkList と同じ扱い、P3-REC-AC02 (3)）。
  const seen = new Set(first.heads.map((head) => head.id));
  const heads = [...first.heads];
  // 一覧は新しい順。満杯は濾す前の生の件数で決め、生の最も古い受信時刻が位置の時刻以下になるまで遡る（P3-REC-AC13 (2)）。
  for (let page = first; page.rawCount >= FULL_PAGE && !(since != null && page.oldestRawReceivedAtMs != null && page.oldestRawReceivedAtMs <= since);) {
    if (page.nextToken == null) return { kind: "unmatched", reason: "fetchFailed" };
    const next = await send(lane, apiKey, { classification, cursorToken: page.nextToken }, signal, now, pages);
    if (next === "limit" || next === "ended" || next.kind !== "ok") return unmatched(next);
    for (const head of next.heads) if (!seen.has(head.id)) { seen.add(head.id); heads.push(head); }
    for (const unit of next.refused) refused.add(unit);
    page = next;
  }
  return { kind: "ok", heads: heads.filter((head) => (since == null || head.receivedAtMs > since) && !refused.has(head.unit)), position: reached };
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
 * 起動時のダイジェスト（P3-REC-AC15）。unit は plan の順、その中は新しい順に見出しを 3 件まで残し（P3-REC-D-DIGEST-BUDGET=D）、
 * 件数（RES-04）か byte（RES-06）の枠に入らない所から後ろは型ごとの件数だけにする。utf8Bytes は作るときに 1 回だけ数えた digest の JSON の byte。
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
  fill: for (const entry of listed) for (const head of entry.candidates.slice(0, DIGEST_UNIT_HEADS)) {
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

export { BodyRequestLane, ListRequestLane, RECOVERABLE_UNITS, WALK_ORDER, windowOf, bodiesFor, buildDigest, fetchBody, listTelegramPage, pollClassification, recoveryPlan,
  recoveryStart, startupPlan, walkDiagnostics, walkList, walkStart, widerStart };
export type { Restored, WalkStart };
