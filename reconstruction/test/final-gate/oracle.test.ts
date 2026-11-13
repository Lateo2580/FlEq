import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ClockReading, JsonValue, RuntimeUnitId, RuntimeUnitInputs, RuntimeUnitSteps } from "../../contracts/p2-shared-runtime.types";
import type { ExecutionPlace, OwnerReply, OwnerRequest } from "../../contracts/p3-execution-split.types";
import type { UnitModule, UnitTable } from "../../contracts/p3-unit-table.types";
import type { CheckpointFileSystem } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { linkedRuntimeCalls, linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { parserDiagnosticReasons } from "../../src/runtime/runtime-diagnostic";
import { classifyHeadType, placeOfHeadType, rowsByHeadType, runtimeUnits } from "../../src/runtime/unit-coverage";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import { envelope, harnessedRoot, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";

// P3-FINAL-GATE-001 発注 1: sequences.json の全 sequence を 12 unit の結線（owner-harness の TEST-PATH）に step の順と時計のまま流し（AC01、
// P3-FG-D-ORACLE=A）、同じ 1 回の run の記録で一入力一保存単位と共有資源の不変条件を数える（AC02）。表は FLEQ_FINAL_GATE_OUT の 1 file に書く。

type Step = (typeof corpus.sequences)[number]["steps"][number];
type Expectation = (typeof corpus.expectations)[number];
type Table = "withdrawn" | "injectFailure" | "afterInjectFailure" | "unmet" | "dependsOnUnmet" | "flow";

const expectations = new Map(corpus.expectations.map((item) => [item.expectedId, item]));
const fixtures = new Map(manifest.fixtures.map((item) => [item.fixtureId, item]));
const required = (step: Step) => expectations.get(step.expectedRef)?.input?.required ?? "";
// AC01 (4): 旧築の保存物の fixture で起動する取り下げの restart（計画:673）。
const WITHDRAWN = new Set(["expected:O04:2", "expected:O06:29", ...[19, 20, 21, 22, 23, 24, 25, 26].map((position) => `expected:O07:${position}`)]);
// 直前の保存から復元する restart（O07・O10 の字）。ほかの restart は空の state から始める（meta.execution[3]）。
const restores = (step: Step) => /復元|再読込|crash\/restart/.test(required(step));
// 空の state でなく、文で書いた準備（試験コードで生成した state、保存済みの g1）を前提にする restart。step に無い準備は作らず、表に出す。
const preparedInProse = (step: Step) => step.action === "restart" && !restores(step) && !/^新しい隔離 ?harness を空/.test(required(step));

// 各 step を表の 1 つにだけ置く（AC01 (4)〜(6)）。injectFailure の窓は O10・O11 だけで、unmet の injectFailure も窓を開く（O11:6〜10）。
// unmet の後は、次の独立した初期化の restart までをその状態に頼るとして別表へ（meta.execution[0]）。O08・O09 の unmet の injectFailure は負荷の設定で、後を止めない。
function partition(): Map<string, Readonly<{ table: Table; after: string | null }>> {
  const tables = new Map<string, Readonly<{ table: Table; after: string | null }>>();
  for (const sequence of corpus.sequences) {
    let failing = false, unmetFrom: string | null = null;
    const windowed = sequence.sequenceId === "O10" || sequence.sequenceId === "O11";
    for (const step of sequence.steps) {
      const unmet = step.expectedRef.startsWith("unmet:");
      if (step.action === "restart" && !restores(step)) unmetFrom = null;
      const put = (table: Table, after: string | null = null) => { tables.set(step.expectedRef, { table, after }); };
      if (WITHDRAWN.has(step.expectedRef)) put("withdrawn");
      else if (step.action === "injectFailure") { if (windowed) failing = true; put(unmet ? "unmet" : "injectFailure"); }
      // unmet は窓の中でも unmet の表へ（AC03 の帳簿に 1 回だけ数える。O11:4）。窓の中の依存は窓の表が受ける。
      else if (unmet) { put("unmet"); if (!failing) unmetFrom ??= step.expectedRef; else if (step.action === "recover") failing = false; }
      else if (failing) { put("afterInjectFailure"); if (step.action === "recover") failing = false; }
      else if (unmetFrom != null) put("dependsOnUnmet", unmetFrom);
      else put("flow");
    }
  }
  return tables;
}

// ---- 結線の上の観測 ----

type Reduced = Readonly<{ unit: RuntimeUnitId; input: RuntimeUnitInputs[RuntimeUnitId]; step: RuntimeUnitSteps[RuntimeUnitId] }>;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value != null && !Array.isArray(value);

// 12 unit の reduce を結果を変えずに包み、step の間に呼ばれた reduce を順に残す（runner.ts の ObservationTable と同じ包み方）。
function observed(log: Reduced[]): UnitTable {
  const wrap = <K extends RuntimeUnitId>(module: UnitModule<K>): UnitModule<K> => ({ ...module, reduce: (state, input) => {
    const step = module.reduce(state, input);
    const given: RuntimeUnitInputs[RuntimeUnitId] = input, taken: RuntimeUnitSteps[RuntimeUnitId] = step;
    log.push({ unit: module.unit, input: given, step: taken });
    return step;
  } });
  const base = linkedUnitTable;
  return { "U-E": wrap(base["U-E"]), "U-W": wrap(base["U-W"]), "U-F": wrap(base["U-F"]), "U-T": wrap(base["U-T"]), "U-Q": wrap(base["U-Q"]),
    "U-N": wrap(base["U-N"]), "U-V": wrap(base["U-V"]), "U-L": wrap(base["U-L"]), "U-R": wrap(base["U-R"]), "U-B": wrap(base["U-B"]),
    "U-M": wrap(base["U-M"]), "U-Y": wrap(base["U-Y"]) };
}

// 必ず成功するメモリの保存（runner.ts の memoryFiles と同じ形）。restart の復元はこの file 群を次の harness に渡して読む。
function memoryFiles(): CheckpointFileSystem {
  const files = new Map<string, Uint8Array>();
  return { readFile: (path) => files.get(path) ?? null, unlinkSync: (path) => { files.delete(path); },
    mkdir: async () => {}, rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from); }, syncDirectory: async () => {},
    open: async (path) => {
      let bytes = new Uint8Array();
      return { write: async (data) => { bytes = data.slice(); }, sync: async () => {}, close: async () => { files.set(path, bytes); } };
    } };
}
const noDiagnostics: DiagnosticFileSystem = { mkdir: async () => {}, appendFile: async () => {}, readLastByte: async () => null, writeFile: async () => {},
  rename: async () => {}, readFile: async () => "", files: async () => [], unlink: async () => {} };

// 状態の記録を subject で引く（top の配列・map の要素と、その中の配列の要素。U-Q の寄与は source.subject）。
const SKIPPED = new Set(["intents", "deliveryRecords", "notificationLatches", "persistence", "notices", "unreadableNotices"]);
function recordOf(state: object, subject: string): Readonly<Record<string, unknown>> | null {
  let bySource: Readonly<Record<string, unknown>> | null = null;
  const entries: [string, unknown][] = Object.entries(state);
  for (const [key, value] of entries) {
    if (SKIPPED.has(key)) continue;
    const elements = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
    for (const element of elements) {
      if (!isRecord(element)) continue;
      const items = [element, ...Object.values(element).flatMap((nested) => Array.isArray(nested) ? nested.filter(isRecord) : [])];
      for (const item of items) {
        if (item["subject"] === subject) return item;
        const source = item["source"];
        if (bySource == null && isRecord(source) && source["subject"] === subject) bySource = item;
      }
    }
  }
  return bySource;
}

// sequences.json の effective の語彙へ（各 unit の corpus 試験の読み: 記録が無ければ expired、zero は noActiveItems、ended は終わりの原因、
// U-T は取消のほかを released、effective の欄を持たない記録〔U-E の current〕は在れば active）。
function effectiveOf(unit: RuntimeUnitId, record: Readonly<Record<string, unknown>> | null): JsonValue {
  if (record == null) return { kind: "inactive", cause: { kind: "expired" } };
  const effective = record["effective"];
  if (effective === undefined || effective === "active") return { kind: "active" };
  if (effective === "unavailable") return { kind: "unavailable", reason: typeof record["unavailableReason"] === "string" ? record["unavailableReason"] : null };
  if (unit === "U-T") return { kind: "inactive", cause: { kind: effective === "cancelled" ? "cancelled" : "released" } };
  // U-M の熱中症（VPFT50）の ended は対象日の終わりの到来（P3-C13-HEAT-EXPIRY、O08:4 の expired）。竜巻の ended は解除（O08:24 の released）。
  if (unit === "U-M" && effective === "ended" && typeof record["subject"] === "string" && record["subject"].split("/")[1] === "VPFT50")
    return { kind: "inactive", cause: { kind: "expired" } };
  const cause = effective === "zero" ? "noActiveItems" : effective === "ended" ? (record["endCause"] === "expired" ? "expired" : "released") : String(effective);
  return { kind: "inactive", cause: { kind: cause } };
}

type Decision = RuntimeUnitSteps[RuntimeUnitId]["decisions"][number];
const shapeOf = (made: Decision): JsonValue => ({ kind: made.decision, ...("change" in made ? { change: made.change } : {}),
  ...(made.decision === "unchanged" || made.decision === "rejected" ? { reason: made.reason } : {}) });
const revisionOf = (record: Readonly<Record<string, unknown>> | null): JsonValue => {
  const source = record?.["source"];
  if (!isRecord(source)) return null;
  const text = (key: string) => typeof source[key] === "string" && source[key] !== "" ? source[key] : null;
  return { reportDateTimeRaw: text("reportDateTimeRaw"), serialRaw: text("serialRaw"), infoTypeRaw: text("infoTypeRaw") };
};

type Mismatch = Readonly<{ expectedRef: string; action: string; unit: RuntimeUnitId | null; field: string; expected: unknown; actual: unknown }>;
type Flowed = Readonly<{ expectedRef: string; sequenceId: string; action: string; headType: string | null; unit: RuntimeUnitId | null;
  kind: "normal" | "cancel" | "restore" | "control"; matched: boolean; fields: number;
  // 文で書いた準備（preparedInProse）を作らずに始めた run の中の step。一致しても、期待が前提にする state の上では確かめていない。
  hollow: boolean }>;

// AC02 (4) の記録: owner へ渡した要求と publisher へ渡した返信を、渡した順に 1 本で残す（hold の述語は渡す順に全部を見る、owner-harness.ts の flush）。
type Event = Readonly<{ kind: "grant"; unit: RuntimeUnitId; id: string } | { kind: "done"; unit: RuntimeUnitId; id: string }
  | { kind: "input"; place: ExecutionPlace; id: string; headType: string } | { kind: "inputDone"; place: ExecutionPlace; id: string }>;
function eventOf(place: ExecutionPlace, message: Readonly<{ request: OwnerRequest } | { reply: OwnerReply }>): Event | null {
  if ("request" in message) {
    const { request } = message;
    if (request.kind === "checkpointGrant") return { kind: "grant", unit: request.unit, id: request.grantId };
    if (request.kind === "input") return { kind: "input", place, id: request.envelope.messageId, headType: request.envelope.payload.item.headType };
    return null;
  }
  const { reply } = message;
  if (reply.kind === "checkpointDone") return { kind: "done", unit: reply.unit, id: reply.grantId };
  if (reply.kind === "inputDone") return { kind: "inputDone", place, id: reply.settlement.inputId };
  return null;
}

type GateRun = Readonly<{
  tables: Map<string, Readonly<{ table: Table; after: string | null }>>;
  flowed: Flowed[];
  mismatches: Mismatch[];
  prepared: string[];
  // AC02
  saved: Map<string, Set<RuntimeUnitId>>;
  receives: Readonly<{ expectedRef: string; headType: string; route: string; changedUnits: RuntimeUnitId[]; reducedUnits: RuntimeUnitId[]; probe: boolean }>[];
  diagnostics: Map<string, string[]>;
  events: Event[];
  mailboxPeaks: { items: number; bytes: number };
}>;

async function runGate(): Promise<GateRun> {
  const tables = partition();
  const flowed: Flowed[] = [], mismatches: Mismatch[] = [], prepared: string[] = [];
  const saved = new Map<string, Set<RuntimeUnitId>>();
  const receives: GateRun["receives"][number][] = [];
  const events: Event[] = [];
  const diagnostics = new Map<string, string[]>();
  const mailboxPeaks = { items: 0, bytes: 0 };
  const log: Reduced[] = [];
  const units = observed(log);
  let now: ClockReading = { wallTimeMs: 0, monotonicMs: 1 };
  // 壁時計は sequence の時刻（advanceClock は戻りうる）、単調時計は戻さずに進める。
  const setNow = (wallTimeMs: number) => { now = { wallTimeMs, monotonicMs: now.monotonicMs + Math.max(1, wallTimeMs - now.wallTimeMs) }; };
  let runs = 0, inputSequence = 0;
  const open = async (files: CheckpointFileSystem): Promise<Harness> => {
    const h = harnessedRoot({ appName: "fleq-final-gate", legacyAppName: "fleq", stateDirectory: "final-gate-state",
      legacyStateDirectory: "final-gate-legacy", diagnosticDirectory: "final-gate-diagnostics" }, linkedUnitCodecs, {
      clock: () => now, runtimeCalls: { ...linkedRuntimeCalls, units }, checkpointFileSystem: files, diagnosticFileSystem: noDiagnostics,
      reportFailure: () => {}, onMeasurements: (list) => {
        for (const item of list) if (item.stage === "encode") for (const inputId of item.inputIds) {
          const unit = runtimeUnits.find((candidate) => candidate === item.unit);
          if (unit != null) saved.set(inputId, (saved.get(inputId) ?? new Set()).add(unit));
        }
      } });
    h.holdRequests((place, request) => { const event = eventOf(place, { request }); if (event != null) events.push(event); return false; });
    h.hold((place, reply) => {
      const event = eventOf(place, { reply });
      if (event != null) events.push(event);
      if ("output" in reply) for (const item of reply.output.diagnostics) if (item.inputId != null) diagnostics.set(item.inputId, [...diagnostics.get(item.inputId) ?? [], item.reason]);
      return false;
    });
    await startHarness(h, `final-gate-${++runs}`, now);
    return h;
  };

  for (const sequence of corpus.sequences) {
    let h: Harness | null = null, files = memoryFiles();
    // effective を持つ制御の step は subjects が空なので、その run の直前の receive の subject で引く。
    let lastSubjects: readonly string[] = [], lastUnit: RuntimeUnitId | null = null, hollow = false;
    for (const step of sequence.steps) {
      if (tables.get(step.expectedRef)?.table !== "flow") continue;
      const expected: Expectation = expectations.get(step.expectedRef)!;
      log.length = 0;
      const label = step.expectedRef;
      const miss = (unit: RuntimeUnitId | null, field: string, want: unknown, actual: unknown) => { mismatches.push({ expectedRef: label, action: step.action, unit, field, expected: want, actual }); };
      const before = mismatches.length;
      let fields = 0, headType: string | null = null, unit: RuntimeUnitId | null = null;
      try {
        setNow(step.receivedAt ?? step.evaluatedAt);
        if (step.action === "restart") {
          if (!restores(step)) files = memoryFiles();
          hollow = preparedInProse(step);
          if (hollow) prepared.push(label);
          h = await open(files);
        } else {
          h ??= await open(files);
          if (step.action === "receive") {
            const fixture = fixtures.get(step.fixtureId!)!;
            headType = fixture.transport.headType!;
            await submit(h, envelope(h.root.state.runId, headType, label, readFileSync(fixture.path), now, ++inputSequence));
          } else if (step.action === "save") {
            await h.root.driveCheckpoint();
            await h.settle();
          } else {
            h.root.tick(now);
            await h.settle();
          }
        }
        // owner-harness は送った要求と届いた返信を全部残す。読まないこの run では step ごとに捨てる（runner.ts と同じ）。
        h.sent.length = 0;
        h.delivered.length = 0;
        const stats = h.root.mailbox.stats(now.monotonicMs);
        mailboxPeaks.items = Math.max(mailboxPeaks.items, stats.highWaterItems);
        mailboxPeaks.bytes = Math.max(mailboxPeaks.bytes, stats.highWaterBytes);
        // この step の reduce: receive はこの入力の receive、advanceClock は期限、restart は復元。
        const kind = step.action === "receive" ? "receive" : step.action === "restart" ? "restore" : "deadline";
        const own = log.filter((item) => item.input.kind === kind
          && (kind !== "receive" || (item.input.kind === "receive" && item.input.material.inputId === label)));
        const decisions = own.flatMap((item) => item.step.decisions.map((made) => ({ unit: item.unit, made })));
        const intents = own.reduce((sum, item) => sum + item.step.intents.length, 0);
        // decision: 期待の最後の subject の decision（1 入力で複数 subject を変える step は最後の subject の射影、typhoon-corpus.test.ts の PER_SUBJECT）。
        const wanted = expected.subjects.at(-1)?.subject;
        const made = (wanted == null ? decisions[0] : decisions.find((item) => item.made.subject === wanted) ?? decisions[0])?.made ?? null;
        // unit に届く前に parser が断った入力（P1 の拒否の経路、p2-order-plan.md の O02:11・12）は、その診断の reason を rejected の reason と読む。
        const parserRejection = step.action !== "receive" || made != null ? null
          : (diagnostics.get(label) ?? []).find((reason) => parserDiagnosticReasons.some((candidate) => candidate === reason)) ?? null;
        if (step.action === "receive") {
          const route = classifyHeadType(headType!);
          const changed = [...new Set(decisions.filter(({ made }) => made.decision === "changed").map((item) => item.unit))];
          receives.push({ expectedRef: label, headType: headType!, route: route.status === "ready" ? route.unit : route.status,
            changedUnits: changed, reducedUnits: [...new Set(own.map((item) => item.unit))], probe: false });
          unit = own[0]?.unit ?? (route.status === "ready" ? route.unit : null);
          lastSubjects = expected.subjects.map((item) => item.subject);
          lastUnit = unit;
          // subjects（AC01 (1)）: 入力の decision の subject の組。U-N・U-V は期待の subject を含めば足りる（各 corpus 試験の arrayContaining）。
          // 報を同定できずに断った入力（subject の無い rejected と parser の拒否）の期待の subject は印（rejected/VPTW60/identity未確定 など）なので比べない。
          const actualSubjects = [...new Set(decisions.map(({ made }) => made.subject))].sort();
          const unidentified = expected.decision?.kind === "rejected" && (parserRejection != null || isDeepStrictEqual(actualSubjects, [""]));
          if (!unidentified) {
            fields++;
            const contained = (unit === "U-N" || unit === "U-V") && lastSubjects.every((subject) => actualSubjects.includes(subject));
            if (!contained && !isDeepStrictEqual(actualSubjects, [...lastSubjects].sort())) miss(unit, "subjects", [...lastSubjects].sort(), actualSubjects);
          }
        } else unit = step.action === "restart" ? null : lastUnit;
        if (expected.decision != null) {
          fields++;
          // advanceClock で owner が unit の reduce を呼ばなかった（unit の期限が来ていない、owner-runtime の deadline）ときは unchanged/noChange と読む（統合担当の決め、O08:5）。
          const idle = step.action === "advanceClock" && own.length === 0 ? { kind: "unchanged", reason: "noChange" } : null;
          const actual: unknown = made != null ? shapeOf(made) : parserRejection != null ? { kind: "rejected", reason: parserRejection } : idle;
          // 期待の rejected の reason が null は未決（Q-ENUM）なので、kind だけを比べる。
          const want = expected.decision.kind === "rejected" && expected.decision.reason == null && isRecord(actual) ? { ...expected.decision, reason: actual["reason"] } : expected.decision;
          if (!isDeepStrictEqual(actual, want)) miss(unit, "decision", expected.decision, actual);
        }
        // revision: stale と rejected の報の revision は報自身のもので、保存した記録には入らない（各 unit の corpus 試験と同じ）。
        const stateUnit = unit ?? lastUnit;
        // 期待の subject の文字列は比べる組の表記で wire の鍵ではない（sequences.json の meta.expectedRecord）。state に無ければ同じ位置の decision の subject で引く。
        const live = (subject: string) => {
          if (stateUnit == null) return null;
          const state = h!.unit(stateUnit);
          const index = expected.subjects.findIndex((item) => item.subject === subject);
          const fallback = decisions.length === expected.subjects.length && index >= 0 ? decisions[index].made.subject : null;
          return recordOf(state, subject) ?? (fallback == null ? null : recordOf(state, fallback));
        };
        if (step.action === "receive" && made != null && made.decision !== "rejected" && !(made.decision === "unchanged" && made.reason === "stale"))
          for (const subject of expected.subjects) {
            fields++;
            const actual = revisionOf(live(subject.subject));
            // 空の serialRaw は null と同じに読み（revisionOf と同じ）、期待の serialRaw が null なら比べない（p3-tsunami の corpus 試験の読み）。
            const serialRaw = subject.revision.serialRaw === "" ? null : subject.revision.serialRaw;
            const want = { ...subject.revision, serialRaw: serialRaw == null && isRecord(actual) ? actual["serialRaw"] ?? null : serialRaw };
            if (!isDeepStrictEqual(actual, want)) miss(unit, `revision ${subject.subject}`, subject.revision, actual);
          }
        if (expected.effective != null) {
          fields++;
          const subject = expected.subjects[0]?.subject ?? lastSubjects[0];
          const actual = subject == null || stateUnit == null ? null : effectiveOf(stateUnit, live(subject));
          if (!isDeepStrictEqual(actual, expected.effective)) miss(stateUnit, "effective", expected.effective, actual);
        }
        if (expected.intents != null) { fields++; if (intents > 0 !== expected.intents) miss(unit, "intents", expected.intents, intents); }
        if (expected.notices != null) { fields++; if (intents > 0 !== expected.notices) miss(unit, "notices", expected.notices, intents); }
      } catch (error) {
        miss(unit, "error", null, error instanceof Error ? error.message : String(error));
      }
      const cancel = expected.subjects.some((item) => item.revision.infoTypeRaw === "取消");
      flowed.push({ expectedRef: label, sequenceId: sequence.sequenceId, action: step.action, headType, unit,
        kind: step.action === "receive" ? (cancel ? "cancel" : "normal") : step.action === "restart" ? "restore" : "control",
        matched: mismatches.length === before, fields, hollow: hollow && step.action !== "restart" });
    }
  }
  // AC02 (3): 流す step の headType は全部 ready なので、表に無い・notPorted・ignored の 3 つを同じ結線に 1 本ずつ入れる（T01 には数えない）。
  // VFSVii は file 名から補った表に無い headType（P3-C0-T03）、VPBS51 は notPorted、VPWW53 は ignored の行。
  log.length = 0;
  const probe = await open(memoryFiles());
  for (const [headType, file] of [["VFSVii", "46_01_01_170103_VFSVii"], ["VPBS51", "phase6b_VPBS50_KJPTK202608221709_202608221709"],
    ["VPWW53", "15_16_02_251222_VPWW57"]] as const) {
    const body = readFileSync(`test/fixtures/${file}.xml`);
    setNow(Date.parse(/<ReportDateTime>([^<]+)<\/ReportDateTime>/.exec(body.toString("utf8"))![1]) + 1_000);
    const label = `route:${headType}`;
    await submit(probe, envelope(probe.root.state.runId, headType, label, body, now, ++inputSequence));
    const route = classifyHeadType(headType);
    const own = log.filter((item) => item.input.kind === "receive" && item.input.material.inputId === label);
    receives.push({ expectedRef: label, headType, route: route.status === "ready" ? route.unit : route.status, probe: true,
      changedUnits: [...new Set(own.flatMap((item) => item.step.decisions.some((made) => made.decision === "changed") ? [item.unit] : []))],
      reducedUnits: [...new Set(own.map((item) => item.unit))] });
  }
  const stats = probe.root.mailbox.stats(now.monotonicMs);
  mailboxPeaks.items = Math.max(mailboxPeaks.items, stats.highWaterItems);
  mailboxPeaks.bytes = Math.max(mailboxPeaks.bytes, stats.highWaterBytes);
  return { tables, flowed, mismatches, prepared, saved, receives, diagnostics, events, mailboxPeaks };
}

// 別表の行き先（AC01 (6)）: その expectedRef を引く試験・契約の file。
function referencesOf(expectedRefs: readonly string[]): Record<string, string[]> {
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) { if (name.name !== "evidence" && name.name !== "final-gate") walk(path); }
    else if (/\.(ts|mjs|cjs)$/.test(name.name)) files.push(path);
  } };
  walk("reconstruction/test");
  for (const name of readdirSync("reconstruction/contracts")) if (name.endsWith(".json")) files.push(join("reconstruction/contracts", name));
  const texts = files.map((path) => [path, readFileSync(path, "utf8")] as const);
  return Object.fromEntries(expectedRefs.map((ref) => {
    const pattern = new RegExp(`${ref.replace(/[:]/g, ":")}(?![0-9])`);
    return [ref, texts.filter(([, text]) => pattern.test(text)).map(([path]) => path)];
  }));
}

// sequence ごとの別表の行き先（AC01 (6)、AC03 の振り分け）。
const DESTINATION: Readonly<Record<string, string>> = {
  O04: "O04:4 の後続 O04:5〜8 は unmet（AC03）",
  O09: "E01 の母集団の負荷の設定。C4・C6 の測定の母集団（後続の receive・restart は T01 で流す）",
  O10: "実の注入で確かめた P2-CHECKPOINT-SHUTDOWN-001・P3-CHECKPOINT-STEP1-001・P3-EXECUTION-SPLIT-001・P3-EXECUTION-LIFECYCLE-001・P2-NOTIFICATION-DELIVERY-001 の試験",
  O11: "P4（計画:40、§5.2）",
};

let gate: GateRun;
beforeAll(async () => {
  // 捨てた harness の noticeTimer・ackTimer が本物の時計で後から走らないよう、setTimeout は進めない偽物にする（runner.ts と同じ）。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  gate = await runGate();
  const out = process.env["FLEQ_FINAL_GATE_OUT"];
  if (out == null) return;
  const separate = (table: Table) => corpus.sequences.flatMap((sequence) => sequence.steps.filter((step) => gate.tables.get(step.expectedRef)?.table === table)
    .map((step) => ({ expectedRef: step.expectedRef, action: step.action, fixtureId: step.fixtureId, after: gate.tables.get(step.expectedRef)?.after ?? null })));
  const failureRefs = [...separate("injectFailure"), ...separate("afterInjectFailure")].map((item) => item.expectedRef);
  const references = referencesOf(failureRefs);
  const routes: Record<string, number> = {};
  for (const item of gate.flowed) if (item.headType != null) routes[`${item.headType}->${item.unit ?? classifyHeadType(item.headType).status}`] = (routes[`${item.headType}->${item.unit ?? classifyHeadType(item.headType).status}`] ?? 0) + 1;
  writeFileSync(out, `${JSON.stringify({
    flowed: gate.flowed, mismatches: gate.mismatches, routes, preparedInProse: gate.prepared,
    counts: { flowed: gate.flowed.length, matched: gate.flowed.filter((item) => item.matched && !item.hollow).length,
      hollowMatched: gate.flowed.filter((item) => item.matched && item.hollow).length, mismatchedSteps: gate.flowed.filter((item) => !item.matched).length },
    withdrawn: separate("withdrawn"), dependsOnUnmet: separate("dependsOnUnmet"),
    injectFailure: separate("injectFailure").map((item) => ({ ...item, destination: DESTINATION[item.expectedRef.split(":")[1]] ?? null, references: references[item.expectedRef] })),
    afterInjectFailure: separate("afterInjectFailure").map((item) => ({ ...item, destination: DESTINATION[item.expectedRef.split(":")[1]] ?? null, references: references[item.expectedRef] })),
  }, null, 1)}\n`);
}, 600_000);
afterAll(() => { vi.useRealTimers(); });

describe("P3-FINAL-GATE-001 order 1 (TEST-PATH (2), 12 linked units)", () => {
  it("P3-FG-T01 acceptance / AC01: every flowed step of O01-O11 matches its expectation on the linked units", () => {
    const count = (table: Table, action?: string) => corpus.sequences.flatMap((sequence) => sequence.steps)
      .filter((step) => gate.tables.get(step.expectedRef)?.table === table && (action == null || step.action === action)).length;
    // AC01 (4)(6) の数（239a35f5 の起草の数に、2026-11-13 の O11:2・O11:4 の unmet 化〔R18=A と同じ扱い〕を当てた数）。規則が数を変えたら、規則を合わせずに報告する。
    expect([count("withdrawn"), count("injectFailure"), count("afterInjectFailure"), count("unmet")]).toEqual([10, 44, 47, 90]);
    expect(["recover", "receive", "advanceClock", "save", "restart"].map((action) => count("afterInjectFailure", action))).toEqual([23, 11, 6, 4, 3]);
    // AC01 (1): fixture の無い receive は unmet だけ（流す receive は全部 fixture を持つ）。
    expect(gate.flowed.filter((item) => item.action === "receive" && item.headType == null)).toEqual([]);
    const summary = gate.mismatches.slice(0, 20).map((item) => `${item.expectedRef} ${item.unit ?? "-"} ${item.field}: expected ${JSON.stringify(item.expected)} actual ${JSON.stringify(item.actual)}`).join("\n");
    expect(gate.mismatches.length, `${gate.mismatches.length} mismatches over ${new Set(gate.mismatches.map((item) => item.expectedRef)).size} steps (first 20):\n${summary}`).toBe(0);
  });

  it("P3-FG-T02 acceptance / AC02: one input, one saving unit; non-ready routes are counted; write right and mailbox invariants hold", () => {
    // (1) manifest の全 headType が coverage に 1 行ずつある。VFSVii は file 名から補った headType で、表に無い（unlisted）ことを P3-C0-T03 が確かめている。
    const headTypes = [...new Set(manifest.fixtures.flatMap((item) => item.transport.headType == null ? [] : [item.transport.headType]))];
    expect(headTypes.filter((headType) => !rowsByHeadType.has(headType))).toEqual(["VFSVii"]);
    // (2) 採られた入力は coverage の unit 1 つだけの世代を上げ、保存の inputIds に 2 つの unit で現れない。保存しない記録だけを変える採用
    // （VFVO53 の batch、I-U-V.persisted の N）は世代を上げないので、採ったことと保存されたことは同じでない。
    const wrong: string[] = [];
    for (const item of gate.receives) {
      const savedBy = [...gate.saved.get(item.expectedRef) ?? []];
      // unit の無い入力（notPorted・unlisted）は U-M のカードの世代になる（P3-UM-AC11、owner-runtime.ts の addCard）。
      const owner: RuntimeUnitId | null = runtimeUnits.find((unit) => unit === item.route) ?? (item.route === "notPorted" || item.route === "unlisted" ? "U-M" : null);
      if (savedBy.length > 1 || savedBy.some((unit) => unit !== owner)) wrong.push(`${item.expectedRef} ${item.headType} saved by ${savedBy.join(",")} (row ${item.route})`);
      if (item.changedUnits.length > 1 || item.changedUnits.some((unit) => unit !== owner)) wrong.push(`${item.expectedRef} ${item.headType} changed ${item.changedUnits.join(",")} (row ${item.route})`);
    }
    expect(wrong).toEqual([]);
    // 採ったのに保存の inputIds に無い入力は、保存しない記録だけを変える VFVO53 の batch への採用（expected:O08:8）だけ。
    expect(gate.receives.filter((item) => item.changedUnits.length !== 0 && !gate.saved.has(item.expectedRef)).map((item) => item.expectedRef)).toEqual(["expected:O08:8"]);
    // (3) 表に無い headType・not-ported・ignored は診断で区別され、ready の入力は unit の reduce に届くか parser の診断が残る（黙って捨てない）。
    const reasons: Readonly<Record<string, string>> = { ignored: "routeIgnored", notPorted: "routeNotPorted", unlisted: "routeUnlisted" };
    expect(gate.receives.filter((item) => item.probe).map((item) => [item.route, gate.diagnostics.get(item.expectedRef) ?? [], [...gate.saved.get(item.expectedRef) ?? []]]))
      .toEqual([["unlisted", ["routeUnlisted"], ["U-M"]], ["notPorted", ["routeNotPorted"], ["U-M"]], ["ignored", ["routeIgnored"], []]]);
    const silent = gate.receives.filter((item) => {
      const unit = runtimeUnits.find((candidate) => candidate === item.route);
      const seen = gate.diagnostics.get(item.expectedRef) ?? [];
      return unit != null ? !item.reducedUnits.includes(unit) && !seen.some((reason) => parserDiagnosticReasons.some((candidate) => candidate === reason))
        : !seen.includes(reasons[item.route]);
    });
    expect(silent.map((item) => `${item.expectedRef} ${item.headType} ${item.route} ${(gate.diagnostics.get(item.expectedRef) ?? []).join(",")}`)).toEqual([]);
    // (4) 書込み権は unit ごとに in-flight 1 件、mailbox は実行場所ごとに通常 data の in-flight 1 件で、同じ実行場所の完了は渡した順に照合する。
    const grants = new Map<RuntimeUnitId, string[]>(), inputs = new Map<ExecutionPlace, string[]>();
    const broken: string[] = [];
    let grantCount = 0, inputCount = 0;
    for (const event of gate.events) {
      if (event.kind === "grant") {
        const open = grants.get(event.unit) ?? [];
        if (open.length !== 0) broken.push(`grant ${event.id} for ${event.unit} while ${open.join(",")} is out`);
        grants.set(event.unit, [...open, event.id]);
        grantCount++;
      } else if (event.kind === "done") {
        const open = grants.get(event.unit) ?? [];
        if (!open.includes(event.id)) broken.push(`checkpointDone ${event.id} for ${event.unit} without its grant`);
        grants.set(event.unit, open.filter((id) => id !== event.id));
      } else if (event.kind === "input") {
        const open = inputs.get(event.place) ?? [];
        if (open.length !== 0) broken.push(`input ${event.id} to ${event.place} while ${open.join(",")} is in flight`);
        if (placeOfHeadType(event.headType) !== event.place) broken.push(`input ${event.id} (${event.headType}) sent to ${event.place}`);
        inputs.set(event.place, [...open, event.id]);
        inputCount++;
      } else {
        const open = inputs.get(event.place) ?? [];
        if (open[0] !== event.id) broken.push(`inputDone ${event.id} from ${event.place}, expected ${open[0] ?? "none"}`);
        inputs.set(event.place, open.filter((id) => id !== event.id));
      }
    }
    expect(broken).toEqual([]);
    // 流した receive は全部 owner に渡り、保存の権は 1 回以上出た（数えた記録が空でないこと）。
    expect([inputCount >= gate.receives.length, grantCount > 0]).toEqual([true, true]);
    // 件数・byte の上限は全体で 1 つ（mailbox.ts の ITEM_LIMIT・BYTE_LIMIT）。
    expect([gate.mailboxPeaks.items <= 128, gate.mailboxPeaks.bytes <= 16 * 1024 * 1024]).toEqual([true, true]);
  });
});
