import { createHash } from "node:crypto";

import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { NotificationPriorityGroup } from "../../contracts/p2-notification-delivery.types";
import type {
  FailureMark, NoticeEvidence, NoticeKind, NoticeMark, NotificationIntent, NotificationIntentUpdate, MarkViewed, UnitId, UnreadableMark,
} from "../../contracts/p2-shared-runtime.types";
import { versionKey } from "../contracts-revision/version";
import type { VersionRef } from "../contracts-revision/version";
import { markView } from "./unreadable";

// P3-NOTICE-LEDGER-001（K8）: 通知の ID・印の照合と更新・intent の新しい欄の読み戻しの正本。無いと 10 unit が同じ規則と codec の
// 検査を別々に持ち、規則の直しが 10 か所に散る（P3-VM-AC02 の version.ts と同じ理由）。

const KINDS: readonly NoticeKind[] = ["report", "cancel", "expiry"];
const EVIDENCE_RANK: Readonly<Record<NoticeEvidence, number>> = { unattempted: 0, possible: 1, unknown: 2 };
// P3-NL-RES-02（置き値）: U-T の観測の fragment の鍵は系列・版ごとに 16 件まで。
const FRAGMENT_LIMIT = 16;
const HEX16 = /^[0-9a-f]{16}$/;

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

// P3-NL-AC02 (1): 印の版は versionKey の sha256 の先頭 16 桁（上界を 16 文字に縛る、Q-NL-BYTES）。受理 1 回に 1 回だけ呼ぶ。
function versionDigest(ref: VersionRef): string {
  return digest(versionKey(ref));
}

// P3-NL-AC03 (1): fragment の鍵。受けた fragment そのものの中身（code の順の観測点と areaCode の順の推定区域）の JSON から作る。
function fragmentKey(stations: readonly (readonly [string, unknown])[], estimations: readonly (readonly [string, unknown])[]): string {
  const order = (left: readonly [string, unknown], right: readonly [string, unknown]) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
  return digest(JSON.stringify([[...stations].sort(order), [...estimations].sort(order)]));
}

// P3-NL-AC01 (2): 遷移を 3 つの種類にまとめる（報・取消・期限）。
function noticeKind(transition: NotificationIntent["transition"]): NoticeKind {
  return transition === "cancelled" ? "cancel" : transition === "expired" ? "expiry" : "report";
}

// P3-NL-AC01 (1): 世代番号を含まない ID。series は U-V の海上だけ "marine"、fragment は U-T の観測だけ。
function noticeId(unit: UnitId, subject: string, series: string, ref: VersionRef, transition: NotificationIntent["transition"],
  channel: NotificationIntent["channel"], fragment?: string): string {
  return JSON.stringify([unit, subject, series, versionKey(ref), transition, channel, ...fragment == null ? [] : [fragment]]);
}

// P3-NL-AC01 (4): U-T・U-Q の失敗警報の ID（段階の照合は失敗の印で行う）。
function failureNoticeId(unit: UnitId, subject: string, rejected: VersionRef, channel: NotificationIntent["channel"]): string {
  return JSON.stringify([unit, subject, versionKey(rejected), channel]);
}

// P3-NL-AC01 (2)・AC03 (2): 系列の印に同じ版の鍵と同じ種類（観測は同じ fragment の鍵も）があれば、もう作らない。channel は問わない。
function noticed(mark: NoticeMark | undefined, version: string, kind: NoticeKind, fragment?: string): boolean {
  return mark != null && mark.version === version && mark.kinds.includes(kind)
    && (fragment == null || mark.fragments?.includes(fragment) === true);
}

// P3-NL-AC02 (3)・AC03 (2)(3): admit を通った版と種類を印に足す。版が変われば種類と fragment は新しい版から数え直し、evidence は下げない。
function markNotice(mark: NoticeMark | undefined, version: string, kind: NoticeKind, fragment?: string): NoticeMark {
  const same = mark?.version === version;
  const kinds = same ? KINDS.filter((item) => item === kind || mark.kinds.includes(item)) : [kind];
  const kept = same ? mark.fragments ?? [] : [];
  const fragments = fragment == null ? same ? mark.fragments : undefined
    : [...kept.filter((item) => item !== fragment), fragment].slice(-FRAGMENT_LIMIT);
  return { version, kinds, evidence: mark?.evidence ?? "unattempted", ...fragments == null ? {} : { fragments } };
}

// unattempted → possible → unknown の向きだけ（下げない）。U-E の latch の証拠も同じ規則。
function strongerEvidence(current: NoticeEvidence, evidence: NoticeEvidence): NoticeEvidence {
  return EVIDENCE_RANK[evidence] > EVIDENCE_RANK[current] ? evidence : current;
}
function raiseEvidence(mark: NoticeMark, evidence: NoticeEvidence): NoticeMark {
  const next = strongerEvidence(mark.evidence, evidence);
  return next === mark.evidence ? mark : { ...mark, evidence: next };
}

// P3-NL-AC02 (3): 試行の開始（lastAttempt started の採用）と delivered の採用で possible。
function updateEvidence(intent: NotificationIntent): NoticeEvidence | null {
  return intent.lastAttempt === "started" || intent.disposition === "delivered" ? "possible" : null;
}

// P3-NL-AC05 (1)・AC06 (1): 更新を intent に写す。変化が無ければ null（採らない）。disposition が pending でなければ呼ぶ側が intents から外す。
function applyIntentUpdate<T extends NotificationIntent>(current: T, update: NotificationIntentUpdate): T | null {
  if (update.attempts < current.attempts || update.attempts === current.attempts && update.nextAttemptAt === current.nextAttemptAt
    && update.disposition === current.disposition && update.lastAttempt === current.lastAttempt && update.replayed === current.replayed
    && update.expiresAt === current.expiresAt) return null;
  return { ...current, attempts: update.attempts, nextAttemptAt: update.nextAttemptAt, disposition: update.disposition,
    lastAttempt: update.lastAttempt, replayed: update.replayed, expiresAt: update.expiresAt };
}

// P3-NL-AC08 (1): 復元で started のまま残った pending（通知したか不明。再試行しない）を外す。
function restoreStarted<T extends NotificationIntent>(intents: readonly T[]): Readonly<{ intents: readonly T[]; started: readonly T[] }> {
  const started = intents.filter((item) => item.lastAttempt === "started");
  return started.length === 0 ? { intents, started } : { intents: intents.filter((item) => item.lastAttempt !== "started"), started };
}

// P3-NL-AC11 (2): 群は owner が作るときに決め、A7 はこの欄を読むだけ（level から決めない）。emergency は U-T の報が警報以上
// （未知の区分を含む）への発令・引上げ・区域拡大を含むか。
function priorityGroupOf(unit: UnitId, operation: Operation, emergency = false): NotificationPriorityGroup {
  if (operation !== "normal") return "other";
  if (unit === "U-E") return "normalEew";
  return unit === "U-T" && emergency ? "normalTsunamiEmergency" : "other";
}

// 新しく作る intent の 3 つの欄（P3-NL-AC06 (1)・AC11 (2)）。
function freshState(unit: UnitId, operation: Operation, emergency = false): Pick<NotificationIntent, "lastAttempt" | "replayed" | "priorityGroup"> {
  return { lastAttempt: null, replayed: false, priorityGroup: priorityGroupOf(unit, operation, emergency) };
}

// P3-NL-AC09 (1): 取消を通知する条件の後ろ半分。系列の印の証拠が possible か unknown（通知が外へ出たかもしれない）。
function heard(mark: NoticeMark | undefined): boolean {
  return mark != null && mark.evidence !== "unattempted";
}

// P3-NL-AC10 (3): 取消の title（接頭辞の前）と body。kind は取消の報の Head/Title（末尾の「の取消」は除く。付けたままだと「…の取消を
// 取り消しました」になり、承認した表の形と食い違う）、at は取り消した記録の ReportDateTime（JST の HH:MM、読めなければ書かない）、
// name は震源名・火山名（無ければ書かない）。
function cancelText(kind: string, at: string | null, name: string | null = null): Readonly<{ title: string; body: string }> {
  const type = kind.replace(/\s+/g, " ").trim().replace(/の取消$/, "") || kind.trim();
  const ms = at == null ? Number.NaN : Date.parse(at);
  const what = [name, Number.isFinite(ms) ? `${new Date(ms + 32_400_000).toISOString().slice(11, 16)} 発表` : null]
    .filter((part) => part != null && part !== "").join(" ");
  return what === "" ? { title: `[取消] ${type}`, body: `${type}を取り消しました` }
    : { title: `[取消] ${type}（${what}）`, body: `${what}の${type}を取り消しました` };
}

type Fields = Readonly<Record<string, unknown>>;

// P3-NL-AC06・AC11 (5)・AC05: codec が intent の新しい欄を項目ごとに確かめる。保存するのは pending だけ（終端は印に置き換わる）、
// 群は owner の作る値と一致（U-T の normal は other か、level が warning・critical のときの normalTsunamiEmergency。群は level から
// 決められないので上界だけを確かめる）、desktop は鳴らし直さないので replayed は false。
function readIntentState(row: Fields, unit: UnitId, operation: Operation, level: unknown):
  Pick<NotificationIntent, "lastAttempt" | "replayed" | "priorityGroup"> | null {
  const lastAttempt = row.lastAttempt === "started" || row.lastAttempt === "failed" || row.lastAttempt === null ? row.lastAttempt : undefined;
  const priorityGroup = row.priorityGroup === priorityGroupOf(unit, operation) ? priorityGroupOf(unit, operation)
    : row.priorityGroup === "normalTsunamiEmergency" && unit === "U-T" && operation === "normal" && (level === "warning" || level === "critical")
      ? row.priorityGroup : null;
  if (lastAttempt === undefined || typeof row.replayed !== "boolean" || priorityGroup == null
    || row.disposition !== "pending" || row.replayed && row.channel === "desktop") return null;
  return { lastAttempt, replayed: row.replayed, priorityGroup };
}

// P3-NL-AC02 (5): 印の読み戻し。version は 16 桁の 16 進、kinds は 1〜3 件の決まった順、fragments は観測だけで 16 件以下。形の外は null。
function readNoticeMark(value: unknown, fragmentsAllowed = false): NoticeMark | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const row: Fields = Object.fromEntries(Object.entries(value));
  const { version, kinds, evidence, fragments } = row;
  if (typeof version !== "string" || !HEX16.test(version) || !Array.isArray(kinds) || kinds.length === 0
    || Object.keys(row).some((key) => key !== "version" && key !== "kinds" && key !== "evidence" && key !== "fragments")) return null;
  const read = KINDS.filter((item) => kinds.includes(item));
  const proof = evidence === "unattempted" || evidence === "possible" || evidence === "unknown" ? evidence : null;
  if (proof == null || read.length !== kinds.length || read.some((item, index) => kinds[index] !== item)) return null;
  if (fragments === undefined) return { version, kinds: read, evidence: proof };
  if (!fragmentsAllowed || !Array.isArray(fragments) || fragments.length === 0 || fragments.length > FRAGMENT_LIMIT
    || !fragments.every((item): item is string => typeof item === "string" && HEX16.test(item)) || new Set(fragments).size !== fragments.length) return null;
  return { version, kinds: read, evidence: proof, fragments: [...fragments] };
}

// 印は配送の記録で、表示（view と表示の変化）には出さない。無いと表示の変化の前後と view の byte が印の変化（証拠の更新）で
// 食い違い、snapshot の件数・byte の差分の計量が合わなくなる。印の無い記録は同じ参照を返す。
// 判別共用体の記録（U-N の現況など）でも型を保つよう、印の鍵を外した形を共用体の各型ごとに返す（実装はその鍵だけを外す）。
// 読めない所の印（P3-UM-AC10）は原文の本文を外した view の形（鍵 unreadableView）に置き換える（原文は snapshot の予算に入らない、P3-UM-D-VIEW）。
type Shown<T> = T extends unknown ? MarkViewed<Omit<T, "notice" | "marineNotice">> : never;
type Marks = Readonly<{ notice?: NoticeMark; marineNotice?: NoticeMark; unreadable?: UnreadableMark; marineUnreadable?: UnreadableMark }>;
function shown<T extends Marks>(record: T): Shown<T>;
function shown(record: Marks): object {
  if (record.notice == null && record.marineNotice == null && record.unreadable == null && record.marineUnreadable == null) return record;
  const { notice: _notice, marineNotice: _marine, unreadable, marineUnreadable, ...rest } = record;
  return { ...rest, ...unreadable == null ? {} : { unreadableView: markView(unreadable) },
    ...marineUnreadable == null ? {} : { marineUnreadableView: markView(marineUnreadable) } };
}

// 印 1 件の上界（キーの ,"<key>": を含む JSON UTF-8）。上界の式に系列の数を掛けて足す（P3-NL-AC15 (2)）。
function noticeMarkBytes(key: string, fragments = false): number {
  const longest: NoticeMark = { version: "0".repeat(16), kinds: KINDS, evidence: "unattempted",
    ...fragments ? { fragments: Array.from({ length: FRAGMENT_LIMIT }, () => "0".repeat(16)) } : {} };
  return new TextEncoder().encode(`,${JSON.stringify(key)}:${JSON.stringify(longest)}`).byteLength;
}

// P3-NL-AC02 (6): 失敗の印の読み戻し。operation ごとに 1 件まで（最大 3 件）。形の外は null。
function readFailureMarks(value: unknown): readonly FailureMark[] | null {
  if (!Array.isArray(value) || value.length > 3) return null;
  const marks: FailureMark[] = [];
  for (const item of value) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) return null;
    const row: Fields = Object.fromEntries(Object.entries(item));
    const operation = row.operation === "normal" || row.operation === "training" || row.operation === "test" ? row.operation : null;
    if (operation == null || row.level !== "warning" && row.level !== "critical" || typeof row.until !== "number" || !Number.isFinite(row.until)
      || marks.some((mark) => mark.operation === operation)) return null;
    marks.push({ operation, level: row.level, until: row.until });
  }
  return marks;
}
// 失敗の印 3 件の上界（要素と区切り。キーと [] は空の envelope の式に含める）。until は有限な数の JSON の最長 25 文字。
const FAILURE_MARKS_MAX_BYTES = new TextEncoder().encode(JSON.stringify((["training", "training", "training"] as const).map((operation) =>
  ({ operation, level: "critical", until: -0.0000012345678901234567 })))).byteLength - 2;

export {
  FAILURE_MARKS_MAX_BYTES, readFailureMarks,
  applyIntentUpdate, cancelText, failureNoticeId, fragmentKey, freshState, heard, markNotice, noticeId, noticeKind, noticeMarkBytes, noticed,
  priorityGroupOf, raiseEvidence, readIntentState, readNoticeMark, restoreStarted, shown, strongerEvidence, updateEvidence, versionDigest,
};
