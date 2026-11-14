import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  ClockReading, DiagnosticDetails, NoticeEvidence, NoticeKind, NoticeMark, NotificationIntent, ReportRef,
} from "../../../contracts/p2-shared-runtime.types";
import type {
  WeatherCurrentInput, WeatherCurrentSnapshot, WeatherCurrentUnitState, WeatherCurrentUnitStep,
} from "../../../contracts/p2-weather-current-unit.types";
import type { WeatherCurrentNotice, WeatherCurrentNoticeTarget, WeatherCurrentNotificationPayload } from "../../../contracts/p3-weather-notice.types";
import { attribute, children, first, text } from "../../decode-material/xml-read";
import { cut } from "../../domains/landslide/landslide";
import { WARNING_TYPES, dirty, nextWeatherCurrentDeadline, seriesExists } from "../../domains/weather-current/weather-current";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth";
import {
  cancelText, freshState, heard, markNotice, noticeId, noticed, raiseEvidence, readNoticeMark, recoveredPayload, versionDigest,
} from "../notice-mark";
import { areaEntry, weatherCurrentAreas } from "./weather-current-public";

// P3-WEATHER-NOTICE-001（C20、H11・H16・H19・H27）: U-W の通知 intent・系列ごとの通知の印・pending の上限と外す規則。
// 無いと U-W は通知を作れず、H19 の取消と再起動の後の照合も効かない（P3-WN-AC14 (1)）。

type State = WeatherCurrentUnitState;
type Step = Omit<WeatherCurrentUnitStep, "displayChanges" | "confirmationEvidence">;
type Entry = NonNullable<ReturnType<typeof areaEntry>>;
type Cell = Entry["cells"][number];
type Level = 4 | 5;
type Raised = Readonly<{ prefecture: string; layer: number; areaCode: string; phenomenon: string; level: Level; cell: Cell }>;

const PENDING_ITEMS = 128, PENDING_BYTES = 131_072;
const TTL = { desktop: 180_000, sound: 60_000 } as const;
const NOTICE_BOUNDS = { title: 160, body: 512 } as const;
const PREFIX: Readonly<Record<Operation, string>> = { normal: "", training: "【訓練】", test: "【試験】" };
const NOT_CURRENT = new Set(["解除", "発表警報・注意報はなし"]);
const PAYLOAD_LEVELS = ["info", "warning", "critical", "cancel"] as const;
const PAYLOAD_KEYS: ReadonlySet<string> = new Set(["domain", "level", "title", "body", "targets", "reportDateTime", "recovered"]);
const encoder = new TextEncoder();
const EMPTY: ReadonlyMap<string, Readonly<{ level: Level; cell: Cell }>> = new Map();

const seriesKey = (item: Readonly<{ subject: string; operation: Operation }>) => `${item.operation}\u0000${item.subject}`;
const cellKey = (layer: number, areaCode: string, phenomenon: string) => `${layer}\u0000${areaCode}\u0000${phenomenon}`;
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

// P3-WN-AC01 (1)(2): 段は Kind/Code の十の位（3 は L5、4 は L4。土砂の 39・49 は U-L が出すので外す、P3-WN-D-LANDSLIDE=A）。
// 現象は一の位（33 と 43 は同じ大雨）。解除・なし・Code 00 は段を持たない。復元して未確認の行も数える（Q-NOTICE.restart）。
function levelOf(code: string | null, status: unknown): Level | null {
  if (code == null || typeof status !== "string" || NOT_CURRENT.has(status) || !/^[34]\d$/.test(code) || code === "39" || code === "49") return null;
  return code[0] === "3" ? 5 : 4;
}

// 合わせの府県 1 つの区域×現象の段の最大と、その段の行。合わせの Entry は変わらない府県で使い回されるので、Entry ごとに 1 回だけ数える。
const levelCache = new WeakMap<Entry, ReadonlyMap<string, Readonly<{ level: Level; cell: Cell }>>>();
function levels(entry: Entry | null): ReadonlyMap<string, Readonly<{ level: Level; cell: Cell }>> {
  if (entry == null) return EMPTY;
  let found = levelCache.get(entry);
  if (found == null) {
    const map = new Map<string, Readonly<{ level: Level; cell: Cell }>>();
    for (const cell of entry.cells) {
      const level = levelOf(cell.code, cell.status);
      if (level == null) continue;
      const key = cellKey(cell.type, cell.areaCode, cell.code![1]);
      if ((map.get(key)?.level ?? 0) < level) map.set(key, { level, cell });
    }
    found = map;
    levelCache.set(entry, found);
  }
  return found;
}
const entryOf = (state: State, operation: Operation, prefecture: string) => areaEntry(state, `${operation}\u0000${prefecture}`);

// 報の版の段の最大（取消の channel、P3-WN-D-CANCEL-HEARD=A）。0 は L4・L5 の行が無い。
const snapshotCache = new WeakMap<WeatherCurrentSnapshot, number>();
function snapshotLevel(snapshot: WeatherCurrentSnapshot | null): number {
  if (snapshot == null) return 0;
  let found = snapshotCache.get(snapshot);
  if (found == null) {
    found = 0;
    for (const rows of Object.values(snapshot.phenomena)) if (Array.isArray(rows)) for (const row of rows) {
      if (row == null || typeof row !== "object" || Array.isArray(row)) continue;
      const code = row.code;
      found = Math.max(found, levelOf(typeof code === "string" ? code : null, row.status) ?? 0);
    }
    snapshotCache.set(snapshot, found);
  }
  return found;
}

// ---- 文面（P3-WN-AC04、P3-WN-D-TEXT=A） ----

const kindName = (cell: Cell, level: Level) => cell.name?.replace(/^レベル[0-9０-９]+/, "") || (level === 5 ? "特別警報" : "危険警報");

type Kind = { code: string; level: Level; name: string; cells: Raised[] };
// 上がった Kind を重い順（L5 が先、同じ段は Code の昇順）に。
function kindsOf(raised: readonly Raised[]): Kind[] {
  const kinds = new Map<string, Kind>();
  for (const item of raised) {
    const code = item.cell.code!;
    const found = kinds.get(code);
    if (found == null) kinds.set(code, { code, level: item.level, name: kindName(item.cell, item.level), cells: [item] });
    else found.cells.push(item);
  }
  return [...kinds.values()].sort((left, right) => right.level - left.level || compareText(left.code, right.code));
}
// 一次細分区域等の層に上がった区域があればその層だけ、無ければ最も粗い層（P3-WN-AC04 (2)）。府県・区域の Code の昇順。
function shownCells(kind: Kind): Raised[] {
  const layer = kind.cells.some((item) => item.layer === 1) ? 1 : Math.min(...kind.cells.map((item) => item.layer));
  return kind.cells.filter((item) => item.layer === layer).sort((left, right) => compareText(left.areaCode, right.areaCode));
}

// 受けた報の Body の区域名を 1 回の走査で引く（上がった区域があるときだけ呼ぶ、P3-WN-AC13 (2)）。府県名は同じ報の府県予報区等の層の Name。
function areaNames(material: Extract<WeatherCurrentInput, { kind: "receive" }>["material"], wanted: ReadonlySet<string>):
  Readonly<{ prefectures: ReadonlyMap<string, string>; areas: ReadonlyMap<string, string> }> {
  const prefectures = new Map<string, string>(), areas = new Map<string, string>();
  for (const warning of children(first(material.xml, "Body"), "Warning")) {
    const layer = (WARNING_TYPES as readonly string[]).indexOf(attribute(warning, "type") ?? "");
    if (layer < 0) continue;
    for (const item of children(warning, "Item")) for (const area of children(item, "Area")) {
      const code = text(area, "Code"), name = text(area, "Name");
      if (code == null || name == null || name === "") continue;
      if (layer === 0 && !prefectures.has(code.slice(0, 2))) prefectures.set(code.slice(0, 2), name);
      if (wanted.has(`${layer}\u0000${code}`)) areas.set(`${layer}\u0000${code}`, name);
    }
  }
  return { prefectures, areas };
}

function raiseText(material: Extract<WeatherCurrentInput, { kind: "receive" }>["material"], raised: readonly Raised[]): Readonly<{ title: string; body: string }> {
  const kinds = kindsOf(raised);
  const names = areaNames(material, new Set(kinds.flatMap((kind) => shownCells(kind).map((item) => `${item.layer}\u0000${item.areaCode}`))));
  const top = kinds[0], prefectures = [...new Set(top.cells.map((item) => item.prefecture))].sort(compareText);
  const place = names.prefectures.get(prefectures[0]);
  const correction = material.infoTypeRaw === "訂正";
  const title = `${PREFIX[material.operation]}${correction ? "[訂正] " : ""}${top.name}${place == null ? "" : `（${place}${prefectures.length > 1 ? "ほか" : ""}）`}`;
  const body = kinds.map((kind) => {
    const shown = [...new Set(shownCells(kind).map((item) => item.layer === 0 ? names.prefectures.get(item.prefecture) ?? ""
      : `${names.prefectures.get(item.prefecture) ?? ""}${names.areas.get(`${item.layer}\u0000${item.areaCode}`) ?? ""}`).filter((name) => name !== ""))];
    return shown.length === 0 ? kind.name : `${kind.name} ${shown.join("、")}`;
  }).join(" / ");
  return { title: cut(title, NOTICE_BOUNDS.title), body: cut(`${correction ? "訂正: " : ""}${body}`, NOTICE_BOUNDS.body) };
}

const targetsOf = (raised: readonly Raised[]): WeatherCurrentNoticeTarget[] => [...raised]
  .sort((left, right) => left.layer - right.layer || compareText(left.areaCode, right.areaCode) || compareText(left.phenomenon, right.phenomenon))
  .map((item) => [item.prefecture, item.layer, item.areaCode, item.phenomenon, item.level] as const);

// ---- intent・admit・印 ----

function intentsOf(state: State, source: ReportRef, transition: NotificationIntent["transition"], payload: WeatherCurrentNotificationPayload,
  sound: boolean, now: number): NotificationIntent[] {
  // P3-WN-D-TRAINING=A: training・test は desktop だけ。
  const channels = source.operation === "normal" && sound ? ["desktop", "sound"] as const : ["desktop"] as const;
  return channels.map((channel) => ({ id: noticeId("U-W", source.subject, "", source, transition, channel), unit: "U-W", subject: source.subject,
    operation: source.operation, source, transition, channel, payload, createdAt: now, expiresAt: now + TTL[channel], nextAttemptAt: now,
    attempts: 0, configRevision: state.schemaVersion, disposition: "pending", ...freshState("U-W", source.operation) }));
}

const byteCache = new WeakMap<NotificationIntent, number>();
function intentBytes(item: NotificationIntent): number {
  let size = byteCache.get(item);
  if (size == null) { size = encoder.encode(JSON.stringify(item)).byteLength; byteCache.set(item, size); }
  return size;
}
// A7 の選択順（期限 → 生成時刻 → ID）。U-W の intent は全部 other の群（spec:951）。
const a7Order = (left: NotificationIntent, right: NotificationIntent) => left.expiresAt - right.expiresAt || left.createdAt - right.createdAt
  || compareText(left.id, right.id);
// Q-NOTICE.capacity（P3-WN-AC06 (1)(2)）。置換はしない。同じ id の pending があれば足さない（無いと encode の id の一意で throw し続ける）。
// 満杯なら A7 の選択順の後ろから外す。予約は配送の更新で伸びうる byte（deliveryGrowth）。
function admit(current: readonly NotificationIntent[], fresh: readonly NotificationIntent[]):
  Readonly<{ intents: readonly NotificationIntent[]; admitted: readonly NotificationIntent[]; dropped: number }> {
  const ids = new Set(current.map((item) => item.id)), adding = fresh.filter((item) => !ids.has(item.id));
  if (adding.length === 0) return { intents: current, admitted: [], dropped: 0 };
  const pool = [...current, ...adding], out = new Set<NotificationIntent>();
  let count = pool.length, size = 2 + Math.max(count - 1, 0) + pool.reduce((sum, item) => sum + intentBytes(item) + deliveryGrowth(item), 0);
  if (count > PENDING_ITEMS || size > PENDING_BYTES)
    for (const item of [...pool].sort(a7Order).reverse()) {
      if (count <= PENDING_ITEMS && size <= PENDING_BYTES) break;
      out.add(item);
      count--;
      size -= intentBytes(item) + 1 + deliveryGrowth(item);
    }
  const admitted = adding.filter((item) => !out.has(item));
  if (admitted.length === 0 && [...out].every((item) => adding.includes(item))) return { intents: current, admitted: [], dropped: adding.length };
  return { intents: [...current.filter((item) => !out.has(item)), ...admitted], admitted, dropped: out.size };
}

// P3-NL-AC02 (3): admit を通った版と種類を系列の印に足す。系列が state に無ければ印を作らない（codec の孤児の印にしない、P3-WN-AC05 (5)）。
function marked(state: State, series: Readonly<{ subject: string; operation: Operation }>, version: string, kind: NoticeKind): readonly WeatherCurrentNotice[] {
  if (!seriesExists(state, series.operation, series.subject)) return state.notices;
  const at = state.notices.findIndex((item) => item.subject === series.subject && item.operation === series.operation);
  const notice = { subject: series.subject, operation: series.operation, notice: markNotice(at < 0 ? undefined : state.notices[at].notice, version, kind) };
  return at < 0 ? [...state.notices, notice] : state.notices.map((item, index) => index === at ? notice : item);
}
// 系列の Map は notices の配列ごとに 1 回作る（取り直しは cell ごとに印を引く、契約適合 r0 の P3-6）。
const markIndex = new WeakMap<readonly WeatherCurrentNotice[], ReadonlyMap<string, NoticeMark>>();
function markOf(state: State, series: Readonly<{ subject: string; operation: Operation }>): NoticeMark | undefined {
  let index = markIndex.get(state.notices);
  if (index == null) { index = new Map(state.notices.map((item) => [seriesKey(item), item.notice])); markIndex.set(state.notices, index); }
  return index.get(seriesKey(series));
}

// P3-NL-AC02 (3)・AC08 (1): 系列の印の evidence を上げる（下げない）。印の無い系列は飛ばす（P3-WN-AC05 (7)）。
function raiseNotices(state: State, raised: ReadonlyMap<string, NoticeEvidence>): State {
  if (raised.size === 0) return state;
  let changed = false;
  const notices = state.notices.map((item) => {
    const evidence = raised.get(seriesKey(item));
    const notice = evidence == null ? item.notice : raiseEvidence(item.notice, evidence);
    if (notice === item.notice) return item;
    changed = true;
    return { ...item, notice };
  });
  return changed ? { ...state, notices } : state;
}

// ---- 外す規則（P3-WN-AC06 (2)、Q-WN-PENDING-TARGETS の 3） ----

const targetCache = new WeakMap<object, readonly WeatherCurrentNoticeTarget[] | null>();
const targetsIn = (item: NotificationIntent) => {
  let found = targetCache.get(item.payload);
  if (found === undefined) { found = readTargets(item.payload.targets); targetCache.set(item.payload, found); }
  return found;
};
const holds = (state: State, operation: Operation, [prefecture, layer, areaCode, phenomenon, level]: WeatherCurrentNoticeTarget) =>
  (levels(entryOf(state, operation, prefecture)).get(cellKey(layer, areaCode, phenomenon))?.level ?? 0) >= level;
// 引上げの pending（targets を持つ）は、どの target も合わせでその段以上で成り立たないときだけ外す。rebuilt（operation\0府県）が null なら全部を見る
// （取り直しの採用の 1 回）。作り直した府県に target を持たない pending は読まない（費用は作り直した府県の pending の targets の和）。
function prune(intents: readonly NotificationIntent[], state: State, rebuilt: ReadonlySet<string> | null): readonly NotificationIntent[] {
  if (intents.length === 0 || rebuilt?.size === 0) return intents;
  const kept = intents.filter((item) => {
    const targets = targetsIn(item);
    if (targets == null || rebuilt != null && !targets.some((target) => rebuilt.has(`${item.operation}\u0000${target[0]}`))) return true;
    return targets.some((target) => holds(state, item.operation, target));
  });
  return kept.length === intents.length ? intents : kept;
}

// ---- 受信の step（P3-WN-AC02・AC03） ----

// 受理の step（作り直した府県 rebuilt）に通知を当てる。origin=recovery の候補の作成では作らず外さない（P3-REC-D-UNIT-ENTRANCE=A、AC12 で 1 回）。
function receiveNotices(before: State, step: Step, input: Extract<WeatherCurrentInput, { kind: "receive" }>, rebuilt: ReadonlySet<string>): Step {
  const { material, clock } = input;
  if (material.origin === "recovery" || step.state === before) return step;
  const pending = prune(step.state.intents, step.state, rebuilt);
  const accepted = step.outcomes.find((item) => item.kind === "accepted");
  const outcome = accepted?.kind === "accepted" ? accepted.subjects[0] : undefined;
  let fresh: NotificationIntent[] = [], version = "", kind: NoticeKind = "report";
  if (outcome?.source != null && (outcome.transition === "activated" || outcome.transition === "updated")) {
    const source = outcome.source;
    const raised: Raised[] = [];
    for (const key of rebuilt) {
      const [operation, prefecture] = key.split("\u0000");
      if (operation !== source.operation) continue;
      const old = levels(entryOf(before, source.operation, prefecture));
      for (const [at, { level, cell }] of levels(entryOf(step.state, source.operation, prefecture)))
        // P3-WN-AC02 (2): 後の段が前の段より高く、その段の行が受けた報のものである区域×現象だけ（P3-WN-D-MERGED=A）。L4 の行で採った行が「特別警報から危険警報」（前回電文は特別警報）なら引下げで数えない（P3-USD-AC01）。
        if (cell.source.subject === source.subject && cell.source.inputId === source.inputId && (old.get(at)?.level ?? 0) < level && (level !== 4 || cell.status !== "特別警報から危険警報"))
          raised.push({ prefecture, layer: cell.type, areaCode: cell.areaCode, phenomenon: cell.code![1], level, cell });
    }
    if (raised.length !== 0) {
      version = versionDigest(source);
      if (!noticed(markOf(step.state, source), version, "report")) {
        const loud = raised.some((item) => item.level === 5);
        const payload: WeatherCurrentNotificationPayload = { domain: "weather", level: loud ? "critical" : "warning", ...raiseText(material, raised),
          targets: targetsOf(raised) };
        fresh = intentsOf(step.state, source, outcome.transition, payload, loud, clock.wallTimeMs);
      }
    }
  } else if (outcome != null && material.infoTypeRaw === "取消" && (outcome.transition === "cancelled" || outcome.transition === "unavailable"
    && step.state.unavailable.some((item) => item.subject === outcome.subject && item.operation === outcome.operation
      && item.reason === "historyUnavailable" && item.source?.inputId === material.inputId))) {
    const series = { subject: outcome.subject, operation: outcome.operation };
    const current = (state: State) => state.national[series.operation]?.subject === series.subject ? state.national[series.operation]!
      : state.partials.find((item) => item.subject === series.subject && item.operation === series.operation) ?? null;
    const source = step.state.tombstones.find((item) => item.subject === series.subject && item.operation === series.operation
      && item.source.inputId === material.inputId)?.source;
    // P3-WN-D-CANCEL・CANCEL-HEARD=A: 取消の前の版（戻す前の current、履歴なしなら lastKnown と同じ）と後の版（戻した版）の段で読む。
    const previous = current(before), restored = outcome.transition === "cancelled" ? current(step.state) : null;
    const top = Math.max(snapshotLevel(previous), snapshotLevel(restored)), mark = markOf(step.state, series);
    if (source != null && (top >= 4 || heard(mark))) {
      version = versionDigest(source);
      kind = "cancel";
      if (!noticed(mark, version, kind)) {
        const textValue = cancelText(text(first(material.xml, "Head"), "Title") ?? "", previous?.source.reportDateTimeRaw ?? null);
        fresh = intentsOf(step.state, source, "cancelled", { domain: "weather", level: "cancel",
          title: cut(PREFIX[series.operation] + textValue.title, NOTICE_BOUNDS.title), body: cut(textValue.body, NOTICE_BOUNDS.body) },
        top === 5, clock.wallTimeMs);
      }
    }
  }
  const notices = admit(pending, fresh);
  // 新しい intent が容量で外れただけでも欠けは数える（H39）。
  const diagnostics: DiagnosticDetails[] = notices.dropped === 0 ? [...step.diagnostics] : [...step.diagnostics,
    { level: "INFO", component: "weather-current", reason: "notificationCapacityEvicted", unit: "U-W", count: notices.dropped }];
  if (notices.intents === step.state.intents) return notices.dropped === 0 ? step : { ...step, diagnostics };
  const notice = notices.admitted.length === 0 ? step.state.notices : marked(step.state, fresh[0], version, kind);
  const persistence = step.state.persistence === before.persistence ? dirty(before.persistence, clock.monotonicMs) : step.state.persistence;
  const state = { ...step.state, intents: notices.intents, notices: notice, persistence };
  // P3-WN-AC06 (4): domain の期限は intent の無い state で計算したので取り直す。
  return { ...step, state, nextDeadline: nextWeatherCurrentDeadline(state), intents: [...step.intents, ...notices.admitted], diagnostics };
}

// ---- 取り直しの採用（P3-WN-AC12、H27） ----

// open は取り直しを始めた時の state、candidate は採用する state、live は採用の直前の live。外す規則を最終の candidate に 1 回当て、
// open より上がった cell のうち、印の同じ版と live の同じ段以上を除いたものの全部を targets に info を 1 組作る（P3-WN-D-H27-L4=A）。
// raise が false なら外す規則だけを当てる（器を越える H27 を足さないとき、unit の行が使う）。
function recoveryNotices(open: State, candidate: State, live: State, clock: ClockReading, raise = true): State {
  const pending = prune(candidate.intents, candidate, null);
  if (!raise) return pending === candidate.intents ? candidate : { ...candidate, intents: pending };
  const raised: Raised[] = [], versions = new Map<ReportRef, string>();
  for (const area of weatherCurrentAreas(candidate)) {
    const old = levels(entryOf(open, area.operation, area.prefecture)), shown = levels(entryOf(live, area.operation, area.prefecture));
    for (const [at, { level, cell }] of levels(entryOf(candidate, area.operation, area.prefecture))) {
      if ((old.get(at)?.level ?? 0) >= level || (shown.get(at)?.level ?? 0) >= level) continue;
      let version = versions.get(cell.source);
      if (version == null) { version = versionDigest(cell.source); versions.set(cell.source, version); }
      if (noticed(markOf(candidate, cell.source), version, "report")) continue;
      raised.push({ prefecture: area.prefecture, layer: cell.type, areaCode: cell.areaCode, phenomenon: cell.code![1], level, cell });
    }
  }
  // operation ごとに 1 組（統合担当の決め 2026-11-01、r1）。代表は最も重い段、同じ段は府県の Code の昇順（区域は層・Code・現象の順）。
  // 文面は代表の Kind と区域の数（名前は保存していない）。targets はその operation の上がった cell 全部。
  let intents = pending, notices = candidate.notices;
  for (const operation of ["normal", "training", "test"] as const) {
    const own = raised.filter((item) => item.cell.source.operation === operation);
    if (own.length === 0) continue;
    const best = [...own].sort((left, right) => right.level - left.level || compareText(left.prefecture, right.prefecture)
      || left.layer - right.layer || compareText(left.areaCode, right.areaCode) || compareText(left.phenomenon, right.phenomenon))[0];
    const { source } = best.cell, kind = kindsOf(own).find((item) => item.code === best.cell.code)!;
    const at = new Date(Date.parse(source.reportDateTimeRaw) + 32_400_000).toISOString().slice(11, 16);
    const payload: WeatherCurrentNotificationPayload = { domain: "weather", level: "info", title: cut(`${PREFIX[operation]}${kind.name}（${at} 発表）`, NOTICE_BOUNDS.title),
      body: cut(`${kind.name} ${shownCells(kind).length}地域`, NOTICE_BOUNDS.body), reportDateTime: source.reportDateTimeRaw, recovered: true, targets: targetsOf(own) };
    const admitted = admit(intents, intentsOf(candidate, source, "updated", payload, true, clock.wallTimeMs));
    if (admitted.admitted.length === 0) continue;
    intents = admitted.intents;
    notices = marked({ ...candidate, notices }, source, versions.get(source)!, "report");
  }
  return intents === candidate.intents ? candidate : { ...candidate, intents, notices };
}

// ---- codec（P3-WN-AC05 (6)・AC07 (3)） ----

// 系列ごとに 1 件、項目ごとに確かめて組み立てる。系列が state にあるかは unit の codec が系列の集合で見る。形の外は null。
function readNotices(value: unknown): readonly WeatherCurrentNotice[] | null {
  if (!Array.isArray(value)) return null;
  const notices: WeatherCurrentNotice[] = [], seen = new Set<string>();
  for (const item of value) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) return null;
    const row: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(item));
    const operation = row.operation === "normal" || row.operation === "training" || row.operation === "test" ? row.operation : null;
    const notice = readNoticeMark(row.notice);
    if (operation == null || typeof row.subject !== "string" || row.subject === "" || notice == null || Object.keys(row).length !== 3) return null;
    const key = seriesKey({ subject: row.subject, operation });
    if (seen.has(key)) return null;
    seen.add(key);
    notices.push({ subject: row.subject, operation, notice });
  }
  return notices;
}

// targets: 府県は 2 桁の数字、層は 0〜4、区域の Code は数字、現象は 1 桁の数字、段は 4 か 5、重なり無し、1 件以上。
function readTargets(value: unknown): readonly WeatherCurrentNoticeTarget[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const targets: WeatherCurrentNoticeTarget[] = [], seen = new Set<string>();
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 5) return null;
    const [prefecture, layer, areaCode, phenomenon, level] = item;
    if (typeof prefecture !== "string" || !/^\d{2}$/.test(prefecture) || typeof layer !== "number" || !Number.isInteger(layer) || layer < 0
      || layer >= WARNING_TYPES.length || typeof areaCode !== "string" || !/^\d+$/.test(areaCode) || typeof phenomenon !== "string"
      || !/^\d$/.test(phenomenon) || level !== 4 && level !== 5) return null;
    const key = `${prefecture}\u0000${cellKey(layer, areaCode, phenomenon)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    targets.push([prefecture, layer, areaCode, phenomenon, level]);
  }
  return targets;
}

// intent の payload を項目ごとに確かめて組み立てる。targets は取消でない intent だけが持ち（持つなら各項目を確かめる）、発表時刻と
// 取り直しの印は対（recoveredPayload）で targets を持つ intent だけ。形の外は null。
function readPayload(payload: unknown, transition: unknown): WeatherCurrentNotificationPayload | null {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(payload));
  const recovered = recoveredPayload(value), level = PAYLOAD_LEVELS.find((item) => item === value.level);
  if (Object.keys(value).some((key) => !PAYLOAD_KEYS.has(key)) || value.domain !== "weather" || level == null
    || typeof value.title !== "string" || value.title === "" || typeof value.body !== "string" || value.body === "" || recovered == null) return null;
  const base = { domain: "weather" as const, level, title: value.title, body: value.body };
  if (value.targets === undefined) return "recovered" in recovered ? null : base;
  const targets = transition === "cancelled" ? null : readTargets(value.targets);
  return targets == null ? null : { ...base, ...recovered, targets };
}

// 系列の印 1 件の上界（区切りを含む JSON UTF-8）。受理の器の判定に足す（P3-WN-AC06 (3)）。
function noticeReserve(series: Readonly<{ subject: string; operation: Operation }> | undefined): number {
  if (series == null || series.subject === "") return 0;
  const notice: WeatherCurrentNotice = { subject: series.subject, operation: series.operation,
    notice: { version: "0".repeat(16), kinds: ["report", "cancel", "expiry"], evidence: "unattempted" } };
  return encoder.encode(JSON.stringify(notice)).byteLength + 1;
}

export { noticeReserve, raiseNotices, readNotices, readPayload, receiveNotices, recoveryNotices, seriesKey };
