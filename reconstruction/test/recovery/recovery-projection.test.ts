import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ClockReading, NotificationResult, RuntimeDisplayChange, RuntimeUnitId, RuntimeUnitStates } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt } from "../../contracts/p2-notification-delivery.types";
import type { BodyResult, ListHead, UnitWalk, UnitWalkResult } from "../../contracts/p3-recovery.types";
import type { OwnerReply } from "../../contracts/p3-execution-split.types";
import type { UnitTable } from "../../contracts/p3-unit-table.types";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { walkStart } from "../../src/recovery/recovery";
import { linkedUnitCodecs, linkedUnitTable, snapshotInput } from "../../src/runtime/composition-root";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { envelope, harnessedRoot, startHarness, submit } from "../execution-split/owner-harness";
import { observation, vtse41 } from "../tsunami-unit/tsunami-fixture";
import { vxse53 } from "../seismic-unit/seismic-fixture";

// P3-RECOVERY-001【投影の直し】P3-REC-T21（Q-REC-PRECHECK-7 の (4)・(5)）: 採用の step の正味の displayChanges。製品の publisher と
// in-process の owner（TEST-PATH (2)）で、採用・live の続報・期限・取消の各段の後の投影を、同じ時点の state を全走査で射影した参照と比べる。

class MemoryFiles implements CheckpointFileSystem {
  readonly files = new Map<string, Uint8Array>();
  unlinkSync(path: string): void { this.files.delete(path); }
  readFile(path: string): Uint8Array | null { return this.files.get(path) ?? null; }
  async mkdir(): Promise<void> {}
  async open(path: string): Promise<WritableCheckpoint> {
    let bytes = new Uint8Array();
    return { write: async (value) => { bytes = value.slice(); }, sync: async () => {}, close: async () => { this.files.set(path, bytes); } };
  }
  async rename(from: string, to: string): Promise<void> { this.files.set(to, this.files.get(from)!); this.files.delete(from); }
  async syncDirectory(): Promise<void> {}
}
class MemoryDiagnostics implements DiagnosticFileSystem {
  readonly lines = new Map<string, string>();
  async mkdir(): Promise<void> {}
  async appendFile(path: string, data: string): Promise<void> { this.lines.set(path, (this.lines.get(path) ?? "") + data); }
  async readLastByte(path: string): Promise<number | null> { return Buffer.from(this.lines.get(path) ?? "").at(-1) ?? null; }
  async writeFile(path: string, data: string): Promise<void> { this.lines.set(path, data); }
  async rename(from: string, to: string): Promise<void> { this.lines.set(to, this.lines.get(from) ?? ""); this.lines.delete(from); }
  async readFile(path: string): Promise<string> { return this.lines.get(path) ?? ""; }
  async files(): Promise<readonly { name: string; size: number; mtimeMs: number }[]> { return []; }
  async unlink(path: string): Promise<void> { this.lines.delete(path); }
}

const config = { appName: "fleq-p3", stateDirectory: "rec-state", legacyAppName: "fleq", legacyStateDirectory: "legacy-state",
  diagnosticDirectory: "rec-diagnostics" } as const;
const T0 = Date.parse("2026-10-28T03:00:00Z");
const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const jst = (ms: number) => new Date(ms + 9 * HOUR).toISOString().replace(".000Z", "+09:00");
const xml = (text: string): BodyResult => ({ kind: "ok", bytes: Buffer.from(text), contentType: "application/xml" });
const fixture = (name: string) => readFileSync(`test/fixtures/${name}.xml`, "utf8");
// 報の時刻を ms に置き換える（Control/DateTime・Head の ReportDateTime と TargetDateTime）。
const retime = (text: string, ms: number) => text.replace(/(<Control>[\s\S]*?<DateTime>)[^<]*/, `$1${iso(ms)}`)
  .replace(/<ReportDateTime>[^<]*/, `<ReportDateTime>${jst(ms)}`).replace(/<TargetDateTime>[^<]*/, `<TargetDateTime>${jst(ms)}`);
const tag = (name: string, value: string) => (text: string) => text.replace(new RegExp(`<${name}>[^<]*</${name}>`), `<${name}>${value}</${name}>`);

type Domain = "tsunami" | "earthquake" | "nankai" | "volcano" | "landslide" | "flood" | "briefing" | "localBulletins" | "typhoon";
const DOMAINS: Readonly<Record<Domain, RuntimeUnitId>> = { tsunami: "U-T", earthquake: "U-Q", nankai: "U-N", volcano: "U-V", landslide: "U-L",
  flood: "U-R", briefing: "U-B", localBulletins: "U-M", typhoon: "U-Y" };

async function setup() {
  let now: ClockReading = { wallTimeMs: T0, monotonicMs: 1_000 };
  // 通知の adapter は試行を記録して即 delivered を返す（本物を呼ばない）。
  const sent: NotificationAttempt[] = [];
  const adapter = { run: async (attempt: NotificationAttempt, at: () => ClockReading): Promise<NotificationResult> => { sent.push(attempt);
    return { kind: "delivered", attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: at() }; },
  abort: async () => ({ stopped: true }) };
  const h = harnessedRoot(config, linkedUnitCodecs, { clock: () => now, notificationAdapter: adapter,
    checkpointFileSystem: new MemoryFiles(), diagnosticFileSystem: new MemoryDiagnostics(), display: { publish: () => {} } });
  await startHarness(h, "rec-proj", now);
  let sequence = 0;
  h.root.attachSequence(() => ++sequence, () => sequence);
  const bodies = new Map<string, BodyResult | (() => Promise<BodyResult>)>();
  const io = {
    classifications: ["telegram.earthquake"] as const,
    walk: async (plan: readonly UnitWalk[]): Promise<readonly UnitWalkResult[]> => plan.map(({ unit }) => ({ unit, kind: "listed", heads: [] })),
    fetchBody: async (item: ListHead) => { const body = bodies.get(item.id); return typeof body === "function" ? body() : body ?? { kind: "failed" as const }; },
    notBefore: () => -Infinity,
  };
  const t = {
    h, bodies, sent,
    get now() { return now; },
    advance(ms: number) { now = { wallTimeMs: now.wallTimeMs + ms, monotonicMs: now.monotonicMs + ms }; },
    async startup(heads: readonly ListHead[], unit: RuntimeUnitId) {
      h.root.attachRecovery(io, { [unit]: walkStart(null, "empty", now.wallTimeMs) }, Promise.resolve([{ unit, kind: "listed", heads }]));
      await t.drive();
    },
    async drive() { for (let turn = 0; turn < 30; turn += 1) { await h.settle(); await new Promise((done) => setTimeout(done, 0)); } },
    progress(unit: RuntimeUnitId) { return h.root["progressView"]?.find((item) => item.unit === unit); },
    live(type: string, text: string) { const at = ++sequence; return submit(h, envelope(h.root.state.runId, type, `input-${at}`, Buffer.from(text), now, at)); },
    async tick() { h.root.tick(now); await t.drive(); },
    replies() { return h.delivered.flatMap(({ reply }) => reply.kind === "recoveryDone" ? [reply] : []); },
    adopted(unit: RuntimeUnitId): Extract<OwnerReply, { kind: "recoveryDone" }> {
      const found = t.replies().filter((reply) => reply.unit === unit && reply.result.kind === "adopted");
      expect(found).toHaveLength(1);
      return found[0];
    },
    // 印から後に届いた owner の返信のうち、その unit の表示の変化（鍵 → [before の有無, after の有無]）。
    changedSince(mark: number, unit: RuntimeUnitId) {
      return Object.fromEntries(h.delivered.slice(mark).flatMap(({ reply }) => "output" in reply ? reply.output.displayChanges : [])
        .filter((change) => change.unit === unit).map((change) => [change.subject, [change.before != null, change.after != null]]));
    },
    // 印から後のその unit の通知の試行（channel と取り直しの印）。
    sentSince(mark: number, unit: RuntimeUnitId) {
      return sent.slice(mark).filter((attempt) => attempt.unit === unit)
        .map((attempt) => [attempt.channel, "recovered" in attempt.payload && attempt.payload.recovered === true]);
    },
  };
  return t;
}
type Run = Awaited<ReturnType<typeof setup>>;

const table: UnitTable = linkedUnitTable;
function added<K extends RuntimeUnitId>(unit: K, state: RuntimeUnitStates[K]): readonly RuntimeDisplayChange[] {
  const changes = table[unit].recoveryChanges;
  if (changes == null) throw new Error(`${unit} has no recoveryChanges`);
  return changes(initialUnits[unit], state);
}
// 全走査の参照: 9 unit の今の state を初期の state からの全件の追加（before=null）にして、初回の射影（previous=null）を作る。
// view-projector の初回の検査が、全件の追加が view の byte を覆うことを確かめる。差分の関数を共有するので独立した正解とは扱わない（(5) 1）。
function reference(t: Run) {
  const changes: RuntimeDisplayChange[] = [];
  for (const unit of Object.values(DOMAINS)) changes.push(...added(unit, t.h.unit(unit)));
  const root = t.h.root, state = root.state;
  return projectSnapshot(snapshotInput({ state, outcomes: [], displayChanges: changes }, "reference", t.now.wallTimeMs, root["connectionView"](state),
    root["snapshotWorker"], { digest: null, eewUnverified: null, progress: null }), null).state;
}
// 各段の後: root の投影の 9 domain が参照と等しく、utf8Bytes が実の JSON の byte 数に合う。
function expectProjection(t: Run) {
  const live = t.h.root["projection"]!, ref = reference(t);
  for (const domain of Object.keys(DOMAINS) as Domain[]) {
    const mine = live.domains[domain], theirs = ref.domains[domain];
    expect([domain, mine.full.items, mine.areaRefs, mine.severityRefs, mine.timeRefs, mine.utf8Bytes])
      .toEqual([domain, theirs.full.items, theirs.areaRefs, theirs.severityRefs, theirs.timeRefs, theirs.utf8Bytes]);
    expect([domain, mine.utf8Bytes]).toEqual([domain, Buffer.byteLength(JSON.stringify(mine.full))]);
  }
}
// (5) 1: 生の displayChanges の鍵の一意・両側 null の禁止・内外の鍵の一致。返すのは鍵 → [before の有無, after の有無]。
function rawChanges(changes: readonly RuntimeDisplayChange[]) {
  const keys = changes.map((change) => JSON.stringify([change.unit, change.operation, change.subject]));
  expect(new Set(keys).size).toBe(keys.length);
  for (const change of changes) {
    expect(change.before != null || change.after != null).toBe(true);
    for (const side of [change.before, change.after]) if (side != null)
      expect([side.unit, side.operation, side.subject]).toEqual([change.unit, change.operation, change.subject]);
  }
  return Object.fromEntries(changes.map((change) => [change.subject, [change.before != null, change.after != null]]));
}


type Report = Readonly<{ type: string; xml: string }>;
type Row = Readonly<{
  unit: RuntimeUnitId;
  // 採用の前の live（取り直しの型が届かない slice か、別の subject。空でない live からの採用）。
  seed: (at: number) => readonly Report[];
  // 候補の本文（同じ鍵の複数の更新を含む行がある）。
  bodies: (at: number) => readonly Report[];
  update: (at: number) => Report;
  cancel: (at: number) => Report;
  // 表示の期限が来るまでの時間（採用の時刻から）。
  expiry: number;
  // 期待: 採用で足される鍵、H27 の引上げの有無、続報・期限・取消の段のその unit の表示の変化（鍵 → [before, after] の有無）と通知の試行の数。
  adopted: readonly string[];
  raise: boolean;
  updated: Readonly<Record<string, readonly [boolean, boolean]>>; updateSent: number;
  expired: Readonly<Record<string, readonly [boolean, boolean]>>; expirySent: number;
  cancelled: Readonly<Record<string, readonly [boolean, boolean]>>; cancelSent: number;
}>;
const B = [true, true] as const, GONE = [true, false] as const, NEW = [false, true] as const;
const ttRep = (eventId: string, at: number, kind: string) => vtse41({ eventId, at: iso(at), areas: [{ code: "311", name: "区域311", kind }] });
const ROWS: readonly Row[] = [
  { unit: "U-T", adopted: ["normal/VTSE41/20991231000911"], raise: true,
    updated: { "normal/VTSE41/20991231000911": B }, updateSent: 2,
    // VTSE41 の予報は表示の期限を持たない（解除・取消まで active）ので、期限の列は空でない live の観測（validUntil＝報時刻＋1 日）で見る。
    expired: { "normal/tsunamiObservation:VTSE51/20991231000901": GONE }, expirySent: 0,
    cancelled: { "normal/VTSE41/20991231000911": GONE }, cancelSent: 2,
    expiry: 2 * DAY,
    seed: (at) => [{ type: "VTSE51", xml: observation({ eventId: "20991231000901", at: iso(at), serial: 1, stations: [{ code: "1", height: "0.2" }] }) }],
    bodies: (at) => [{ type: "VTSE41", xml: ttRep("20991231000911", at, "62") }],
    update: (at) => ({ type: "VTSE41", xml: ttRep("20991231000911", at, "51") }),
    cancel: (at) => ({ type: "VTSE41", xml: vtse41({ eventId: "20991231000911", at: iso(at), infoType: "取消" }) }) },
  { unit: "U-Q", adopted: ["normal/earthquake/20991231000922"], raise: false,
    updated: { "normal/earthquake/20991231000922": B }, updateSent: 2,
    expired: { "normal/earthquake/20991231000921": GONE, "normal/earthquake/20991231000922": GONE }, expirySent: 0,
    // U-Q の取消は一覧の行（cancelledSummary）が残る（一律の削除ではない、P3-QC-AC07 (4)）。
    cancelled: { "normal/earthquake/20991231000922": B }, cancelSent: 2,
    expiry: 2 * DAY,
    seed: (at) => [{ type: "VXSE53", xml: vxse53({ eventId: "20991231000921", at: iso(at) }) }],
    bodies: (at) => [{ type: "VXSE53", xml: vxse53({ eventId: "20991231000922", at: iso(at - MINUTE) }) },
      { type: "VXSE61", xml: tag("EventID", "20991231000922")(retime(fixture("32-35_03_02_240613_VXSE61"), at)) }],
    update: (at) => ({ type: "VXSE53", xml: vxse53({ eventId: "20991231000922", at: iso(at), maxInt: "5-" }) }),
    cancel: (at) => ({ type: "VXSE53", xml: vxse53({ eventId: "20991231000922", at: iso(at), infoType: "取消" }) }) },
  { unit: "U-N", adopted: ["normal/nankai/current", "normal/VYSE50/20200512163200", "normal/VYSE50/20200512162800"], raise: true,
    updated: { "normal/nankai/current": B, "normal/VYSE50/20200512163400": NEW }, updateSent: 2,
    expired: { "normal/nankai/current": GONE, "normal/VYSE51/20200512163800": GONE, "normal/VYSE50/20200512163200": GONE, "normal/VYSE50/20200512162800": GONE }, expirySent: 0,
    cancelled: { "normal/VYSE50/20200512163200": GONE }, cancelSent: 2,
    expiry: 15 * DAY,
    seed: (at) => [{ type: "VYSE51", xml: retime(fixture("selected_xml/75_01_01_200512_VYSE51"), at) }],
    bodies: (at) => [{ type: "VYSE50", xml: retime(fixture("selected_xml/74_01_05_200512_VYSE50"), at - MINUTE) },
      { type: "VYSE50", xml: retime(fixture("selected_xml/74_01_04_200512_VYSE50"), at) }],
    update: (at) => ({ type: "VYSE50", xml: retime(fixture("selected_xml/74_01_06_200512_VYSE50"), at) }),
    cancel: (at) => ({ type: "VYSE50", xml: retime(fixture("synthetic_VYSE50_cancel"), at) }) },
  { unit: "U-V", adopted: ["normal/volcano:alert/306"], raise: true,
    updated: { "normal/volcano:alert/306": B }, updateSent: 2,
    // 噴火警報（alerts）の active は期限で消えないので、期限の列は空でない live の噴火（報時刻＋1 日）・降灰（予報の終わり）・解説で見る。
    expired: { "normal/VFVO51/350": GONE, "normal/volcano:ashfall/506": GONE, "normal/volcano:eruption/20200522144900_306": GONE }, expirySent: 0,
    cancelled: { "normal/volcano:alert/306": GONE }, cancelSent: 2,
    expiry: 2 * DAY,
    // 噴火（VFVO52）・降灰（VFVO54）・解説（VFVO51）の slice に 1 件ずつ（差分の関数が slice を落とすと参照の照合で落ちる）。
    seed: (at) => [{ type: "VFVO52", xml: retime(fixture("43_01_01_200522_VFVO52"), at) },
      { type: "VFVO54", xml: retime(fixture("66_01_02_210514_VFVO54"), at).replaceAll(/<StartTime>[^<]*/g, `<StartTime>${jst(at)}`)
        .replaceAll(/<(EndTime|ValidDateTime)>[^<]*/g, (_, name: string) => `<${name}>${jst(at + HOUR)}`) },
      { type: "VFVO51", xml: retime(fixture("44_02_01_200522_VFVO51"), at) }],
    bodies: (at) => [{ type: "VFVO50", xml: retime(fixture("45_01_01_200522_VFVO50"), at) }],
    update: (at) => ({ type: "VFVO50", xml: retime(fixture("synthetic_VFVO50_continuation"), at) }),
    cancel: (at) => ({ type: "VFVO50", xml: retime(fixture("synthetic_VFVO50_cancel"), at) }) },
  { unit: "U-L", adopted: ["normal/VPWW56/稚内地方気象台"], raise: true,
    // 同じ中身の新しい版は表示の版だけを替え、段が変わらないので鳴らない（live の規則）。
    updated: { "normal/VPWW56/稚内地方気象台": B }, updateSent: 0,
    expired: { "normal/VPWW56/宇都宮地方気象台": GONE, "normal/VPWW56/稚内地方気象台": GONE }, expirySent: 0,
    cancelled: { "normal/VPWW56/稚内地方気象台": GONE }, cancelSent: 2,
    expiry: 2 * DAY + HOUR,
    seed: (at) => [{ type: "VPWW56", xml: tag("EditorialOffice", "宇都宮地方気象台")(retime(fixture("15_16_01_241031_VPWW56"), at)) }],
    bodies: (at) => [{ type: "VPWW56", xml: retime(fixture("15_16_01_241031_VPWW56"), at) }],
    update: (at) => ({ type: "VPWW56", xml: retime(fixture("15_16_01_241031_VPWW56"), at) }),
    cancel: (at) => ({ type: "VPWW56", xml: retime(fixture("synthetic_VPWW56_cancel"), at) }) },
  { unit: "U-R", adopted: ["normal/VXKO50/123456789012"], raise: true,
    updated: { "normal/VXKO50/123456789012": B }, updateSent: 2,
    // U-R は表示の期限で期限切れの desktop を 1 件ずつ出す（P3-C11-ACTIVE-EXPIRY）。
    expired: { "normal/VXKO50/123456789099": GONE, "normal/VXKO50/123456789012": GONE }, expirySent: 2,
    cancelled: { "normal/VXKO50/123456789012": GONE }, cancelSent: 2,
    expiry: 37 * HOUR,
    seed: (at) => [{ type: "VXKO50", xml: tag("EventID", "123456789099")(retime(fixture("16_02_01_220728_VXKO50"), at)) }],
    bodies: (at) => [{ type: "VXKO50", xml: retime(fixture("16_02_01_220728_VXKO50"), at) }],
    update: (at) => ({ type: "VXKO50", xml: tag("EventID", "123456789012")(retime(fixture("16_02_02_220728_VXKO50"), at)) }),
    cancel: (at) => ({ type: "VXKO50", xml: retime(fixture("synthetic_VXKO50_cancel"), at) }) },
  { unit: "U-B", adopted: ["normal/VPBS50/KJPTK202608221709_202608221709"], raise: false,
    updated: { "normal/VPBS50/KJPTK202608221709_202608221709": B }, updateSent: 2,
    expired: { "normal/VPBS50/KJPTK202608221800_202608221800": GONE, "normal/VPBS50/KJPTK202608221709_202608221709": GONE }, expirySent: 0,
    cancelled: { "normal/VPBS50/KJPTK202608221709_202608221709": GONE }, cancelSent: 2,
    expiry: 4 * HOUR,
    seed: (at) => [{ type: "VPBS50", xml: tag("EventID", "KJPTK202608221800_202608221800")(retime(fixture("phase6b_VPBS50_KJPTK202608221709_202608221709"), at)) }],
    bodies: (at) => [{ type: "VPBS50", xml: retime(fixture("phase6b_VPBS50_KJPTK202608221709_202608221709"), at) }],
    update: (at) => ({ type: "VPBS50", xml: tag("EventID", "KJPTK202608221709_202608221709")(retime(fixture("synthetic_VPBS50_KJPTK_correction"), at)) }),
    cancel: (at) => ({ type: "VPBS50", xml: tag("EventID", "KJPTK202608221709_202608221709")(retime(fixture("synthetic_VPBS50_KJPTK_cancel"), at)) }) },
  { unit: "U-M", adopted: ["normal/tornado/長崎地方気象台/長崎県竜巻注意情報"], raise: false,
    updated: { "normal/tornado/長崎地方気象台/長崎県竜巻注意情報": B }, updateSent: 0,
    expired: { "normal/tornado/宇都宮地方気象台/長崎県竜巻注意情報": GONE, "normal/tornado/長崎地方気象台/長崎県竜巻注意情報": GONE }, expirySent: 0,
    cancelled: { "normal/tornado/長崎地方気象台/長崎県竜巻注意情報": GONE }, cancelSent: 2,
    expiry: 2 * HOUR,
    seed: (at) => [{ type: "VPHW50", xml: tag("EditorialOffice", "宇都宮地方気象台")(retime(fixture("19_03_01_130906_VPHW50"), at)) }],
    bodies: (at) => [{ type: "VPHW50", xml: retime(fixture("19_03_01_130906_VPHW50"), at) }],
    update: (at) => ({ type: "VPHW50", xml: retime(fixture("19_03_01_130906_VPHW50"), at) }),
    cancel: (at) => ({ type: "VPHW50", xml: tag("InfoType", "取消")(retime(fixture("19_03_01_130906_VPHW50"), at)) }) },
  { unit: "U-Y", adopted: ["normal/typhoonAnalysis/TC2001"], raise: false,
    updated: { "normal/typhoonAnalysis/TC2001": B }, updateSent: 2,
    expired: { "normal/typhoonAnalysis/TC2099": GONE, "normal/typhoonAnalysis/TC2001": GONE }, expirySent: 0,
    cancelled: { "normal/typhoonAnalysis/TC2001": GONE }, cancelSent: 2,
    expiry: 8 * DAY,
    seed: (at) => [{ type: "VPTW60", xml: tag("EventID", "TC2099")(retime(fixture("10_05_01_200826_VPTW60"), at)) }],
    bodies: (at) => [{ type: "VPTW60", xml: retime(fixture("10_05_01_200826_VPTW60"), at) }],
    update: (at) => ({ type: "VPTW60", xml: retime(fixture("10_05_02_200826_VPTW60"), at) }),
    cancel: (at) => ({ type: "VPTW60", xml: retime(fixture("synthetic_VPTW60_cancel"), at) }) },
];

const eventOf = (text: string) => /<EventID>([^<]*)<\/EventID>/.exec(text)?.[1] ?? null;
const officeOf = (text: string) => /<EditorialOffice>([^<]*)<\/EditorialOffice>/.exec(text)?.[1] ?? null;
// 一覧の頭（本文の EventID・官署・題を写す）。
function headOf(unit: RuntimeUnitId, id: string, report: Report, receivedAtMs: number): ListHead {
  return { id, unit, headType: report.type, receivedAtMs, operation: "normal", title: /<Head[^>]*>\s*<Title>([^<]*)/.exec(report.xml)?.[1] ?? "",
    headline: null, reportDateTime: null, infoType: "発表", serial: null, eventId: eventOf(report.xml), controlDateTime: null, controlStatus: "通常",
    test: false, editorialOffice: officeOf(report.xml) };
}
// 空でない live → 取り直し（候補の本文）→ 採用。返すのは採用の返信の生の差分の鍵の表。
// cut は採用の返信を publisher へ届ける前に切断を入れる（AC07 の切断をまたぐ候補: 採用はするが coverageVerified を出さない）。
async function adopt(row: Row, t: Run, cut = false) {
  for (const seed of row.seed(T0 - 3 * MINUTE)) await t.live(seed.type, seed.xml);
  const sentMark = t.sent.length;
  const bodies = row.bodies(T0 - MINUTE);
  bodies.forEach((report, index) => t.bodies.set(`b${index}`, xml(report.xml)));
  const held = cut ? t.h.hold((_, reply) => reply.kind === "recoveryDone" && reply.result.kind === "adopted") : null;
  await t.startup(bodies.map((report, index) => headOf(row.unit, `b${index}`, report, T0 - MINUTE + index)), row.unit);
  if (held != null) {
    t.h.root.dispatch({ kind: "connectionLost", acceptedThroughSequence: t.h.root.state.confirmation.epoch, clock: t.now });
    held();
    t.h.release();
    await t.drive();
  }
  const reply = t.adopted(row.unit);
  // H27: 引上げのある unit だけ、採用の step で取り直しの印つきの通知が desktop と sound に 1 件ずつ。
  expect(t.sentSince(sentMark, row.unit)).toEqual(row.raise ? [["desktop", true], ["sound", true]] : []);
  // (5) 1: 採用の返信の生の差分は、取り直しで足した鍵だけが before=null で入る（空でない live の記録は動かない）。
  expect(rawChanges(reply.output.displayChanges)).toEqual(Object.fromEntries(row.adopted.map((key) => [key, NEW])));
  expectProjection(t);
  return reply;
}
// 1 列: 採用 → live の続報・期限・取消のどれか 1 段。各段の後に投影を参照と照らし、その段の表示の変化と通知の試行の数を固定する。
async function column(row: Row, step: "update" | "expiry" | "cancel", adopted: (t: Run) => void = () => {}) {
  const t = await setup();
  await adopt(row, t);
  adopted(t);
  const mark = t.h.delivered.length, sentMark = t.sent.length;
  if (step === "expiry") { t.advance(row.expiry); await t.tick(); }
  else { const report = row[step](T0); await t.live(report.type, report.xml); }
  const [changes, sent] = step === "update" ? [row.updated, row.updateSent] : step === "expiry" ? [row.expired, row.expirySent] : [row.cancelled, row.cancelSent];
  expect([t.changedSince(mark, row.unit), t.sentSince(sentMark, row.unit).length]).toEqual([changes, sent]);
  expectProjection(t);
}
const events = (t: Run) => t.h.root.state.confirmation.units["U-T"].normal.scopes.flatMap(({ scope }) => scope.kind === "event" ? [scope.eventId] : []);

describe("P3-REC-T21 acceptance: the adopt step's net displayChanges (AC07, Q-REC-PRECHECK-7)", () => {
  // 受入 (a): 採用 → 同じ subject の live の続報。発注 3 からの欠陥の再発防止（採用の後の続報で view-projector が RangeError）。
  for (const row of ROWS) it(`T21-1 (a) ${row.unit}: adoption then a live update of the recovered subject`, async () => {
    // N4: U-T は採用の差分で VTSE41 の event scope が入り、成功した取り直しの coverageVerified が scope を外して whole を確認済みにする。
    await column(row, "update", (t) => { if (row.unit === "U-T") expect([t.h.root.state.confirmation.units["U-T"].normal.whole, events(t)]).toEqual([null, []]); });
  });
  // 受入 (b): 採用 → live の表示の期限。
  for (const row of ROWS) it(`T21-2 (b) ${row.unit}: adoption then a live display deadline`, async () => { await column(row, "expiry"); });
  // 受入 (c): 採用 → live の取消。U-T の行は採用の前に切断を入れ、coverageVerified の出ない列で event scope の退役を見る（(5) 2）。
  for (const row of ROWS) it(`T21-3 (c) ${row.unit}: adoption then a live cancel`, async () => {
    if (row.unit !== "U-T") { await column(row, "cancel"); return; }
    const t = await setup();
    await adopt(row, t, true);
    expect(events(t)).toEqual(["20991231000911"]);
    const mark = t.h.delivered.length, sentMark = t.sent.length;
    const report = row.cancel(T0);
    await t.live(report.type, report.xml);
    expect(t.sentSince(sentMark, "U-T").length).toBe(row.cancelSent);
    const retired = t.h.delivered.slice(mark).flatMap(({ reply }) => "output" in reply ? reply.output.retiredEvents : []);
    expect([t.changedSince(mark, "U-T"), retired, events(t)])
      .toEqual([row.cancelled, [{ unit: "U-T", operation: "normal", eventId: "20991231000911" }], []]);
    expectProjection(t);
  });

  // 当て直し: 候補の間の live の報で基点が変わり、正味の差分は今の live から（live の報の鍵は入らない）。
  it("T21-4 re-apply (U-T): a live VTSE41 during the candidate re-bases it; the net changes start from the current live", async () => {
    const t = await setup();
    let release!: () => void;
    t.bodies.set("r1", xml(ttRep("20991231000941", T0 - 3 * MINUTE, "62")));
    t.bodies.set("r2", () => new Promise((done) => { release = () => done(xml(ttRep("20991231000942", T0 - 2 * MINUTE, "62"))); }));
    const report = (id: string, eventId: string, at: number) => headOf("U-T", id, { type: "VTSE41", xml: ttRep(eventId, at, "62") }, at);
    void t.startup([report("r1", "20991231000941", T0 - 3 * MINUTE), report("r2", "20991231000942", T0 - 2 * MINUTE)], "U-T");
    await t.drive();
    await t.live("VTSE41", ttRep("20991231000943", T0 - MINUTE, "51"));
    expectProjection(t);
    release();
    await t.drive();
    expect(rawChanges(t.adopted("U-T").output.displayChanges))
      .toEqual({ "normal/VTSE41/20991231000941": NEW, "normal/VTSE41/20991231000942": NEW });
    expectProjection(t);
    await t.live("VTSE41", ttRep("20991231000941", T0, "51"));
    expectProjection(t);
  });

  // 採用の step の中の期限: 採用の時計で期限の来る記録は、live に無かったので正味の差分に入らない（期限の step の差分を二重に数えない）。
  // 採用の step の中の期限（U-R、統合担当の決め 2026-10-29）: 基点（採用の直前の live）で見えていなかった記録は、期限切れの intent を作らず正味の差分にも
  // 入らない（期限の step の差分を二重に数えない）。基点で見えていた記録は、期限切れが desktop に 1 件で、正味の差分は before だけ。
  const deadlineRows = [{ name: "a record unseen at the base", seen: false }, { name: "a record seen at the base", seen: true }] as const;
  for (const row of deadlineRows) it(`T21-5 a deadline inside the adopt step (U-R): ${row.name}`, async () => {
    const t = await setup(), old = T0 - 36 * HOUR + 4_000;
    const flood = (eventId: string, at: number) => tag("EventID", eventId)(retime(fixture("16_02_01_220728_VXKO50"), at));
    if (row.seen) await t.live("VXKO50", flood("123456789051", old));
    else t.bodies.set("r1", xml(flood("123456789051", old)));
    t.bodies.set("r2", xml(flood("123456789052", T0 - MINUTE)));
    const heldAdopt = t.h.holdRequests((_, request) => request.kind === "recovery" && request.phase === "adopt");
    await t.startup([...row.seen ? [] : [headOf("U-R", "r1", { type: "VXKO50", xml: flood("123456789051", old) }, old)],
      headOf("U-R", "r2", { type: "VXKO50", xml: flood("123456789052", T0 - MINUTE) }, T0 - MINUTE)], "U-R");
    const before = t.sent.length;
    t.advance(7_500);
    heldAdopt();
    t.h.releaseRequests();
    await t.drive();
    expect(t.h.unit("U-R").currents.map((item) => [item.eventId, item.effective]).sort())
      .toEqual([["123456789051", "expired"], ["123456789052", "active"]]);
    expect(rawChanges(t.adopted("U-R").output.displayChanges))
      .toEqual({ ...row.seen ? { "normal/VXKO50/123456789051": GONE } : {}, "normal/VXKO50/123456789052": NEW });
    const expiries = t.sent.slice(before).filter((attempt) => attempt.subject === "normal/VXKO50/123456789051").map((attempt) => attempt.channel);
    expect(expiries).toEqual(row.seen ? ["desktop"] : []);
    expectProjection(t);
  });

  // 破棄: 捨てた候補（fetchFailed の discard）と部分集合の検査に外れた候補（generationConflict）は返信の差分 0 で、投影が動かない。
  it("T21-6 discarded (fetchFailed) and generationConflict candidates give no displayChanges and leave the projection as it was", async () => {
    const t = await setup();
    await t.live("VTSE41", ttRep("20991231000961", T0 - 2 * MINUTE, "62"));
    const before = t.h.root["projection"]!.domains.tsunami;
    t.bodies.set("f1", xml(ttRep("20991231000962", T0 - MINUTE, "62")));
    await t.startup([headOf("U-T", "f1", { type: "VTSE41", xml: ttRep("20991231000962", T0 - MINUTE, "62") }, T0 - MINUTE),
      headOf("U-T", "f2", { type: "VTSE41", xml: ttRep("20991231000963", T0 - MINUTE, "62") }, T0 - MINUTE + 1)], "U-T");
    const discarded = t.replies().filter((reply) => reply.unit === "U-T" && reply.result.kind === "discarded");
    expect([t.progress("U-T"), discarded.length, discarded.flatMap((reply) => reply.output.displayChanges)])
      .toEqual([{ unit: "U-T", state: "unsatisfied", reason: "fetchFailed" }, 1, []]);
    expect(t.h.root["projection"]!.domains.tsunami).toEqual(before);
    expectProjection(t);
    // 候補の受信の前の回収で、live から引き継いだ U-R の記録の期限が来る（期限切れの intent は落とさない → 部分集合の検査に外れる、P3-REC-T19）。
    const c = await setup(), old = T0 - 36 * HOUR + 4_000;
    const flood = (eventId: string, at: number) => tag("EventID", eventId)(retime(fixture("16_02_01_220728_VXKO50"), at));
    await c.live("VXKO50", flood("123456789061", old));
    const kept = c.h.root["projection"]!.domains.flood;
    c.bodies.set("g1", xml(flood("123456789062", T0 - MINUTE)));
    let late!: () => void;
    c.bodies.set("g2", () => new Promise((done) => { late = () => done(xml(flood("123456789063", T0 - MINUTE))); }));
    await c.startup([headOf("U-R", "g1", { type: "VXKO50", xml: flood("123456789062", T0 - MINUTE) }, T0 - MINUTE),
      headOf("U-R", "g2", { type: "VXKO50", xml: flood("123456789063", T0 - MINUTE) }, T0 - MINUTE + 1)], "U-R");
    c.advance(7_500);
    late();
    await c.drive();
    const conflicts = c.replies().filter((reply) => reply.unit === "U-R" && reply.result.kind === "generationConflict");
    expect([c.progress("U-R"), conflicts.length, conflicts.flatMap((reply) => reply.output.displayChanges)])
      .toEqual([{ unit: "U-R", state: "unsatisfied", reason: "generationConflict" }, 1, []]);
    expect(c.h.root["projection"]!.domains.flood).toEqual(kept);
    expectProjection(c);
  });
});
