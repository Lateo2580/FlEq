import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { vi } from "vitest";

import type { CheckpointMeasurement } from "../../contracts/p2-eew-e01.types";
import type { ClockReading, JsonValue, RuntimeUnitId, RuntimeUnitInputs, RuntimeUnitStates, RuntimeUnitSteps } from "../../contracts/p2-shared-runtime.types";
import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import type { UnitModule, UnitTable } from "../../contracts/p3-unit-table.types";
import type { CheckpointFileSystem } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { sealSelfHash } from "../../src/measurement/eew-e01/frozen";
import { linkedRuntimeCalls, linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { executionPlaces, runtimeUnits } from "../../src/runtime/unit-coverage";
import { envelope, harnessedRoot, places, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import type { Scenario } from "./scenario";

// P3-DISASTER-CAPACITY-001 の 1 段目: 筋書きの frame を仮想時計で製品の composition root（owner-harness の TEST-PATH）へ入れ、
// 器の使用率・拒否・退去・容量の欠け・snapshot の要約・期待例を測って、結果を 1 file に封じる。

const ZERO_HASH = "0".repeat(64);
const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value != null && !Array.isArray(value);

// ---- 観測の表（P3-DC-ORACLE (1)〜(5)、AC05） ----

// 容量の退去の reason と unit（p2-shared-runtime.types.ts の DiagnosticReason）。U-F は診断を出さずに削るので無い（未計測）。
const EVICTION: Readonly<Record<string, RuntimeUnitId>> = { eewCapacityEvicted: "U-E", tsunamiCapacityEvicted: "U-T",
  seismicCapacityEvicted: "U-Q", nankaiCapacityEvicted: "U-N", weatherCurrentCapacityEvicted: "U-W", volcanoCapacityEvicted: "U-V",
  landslideCapacityEvicted: "U-L", floodCapacityEvicted: "U-R", briefingCapacityEvicted: "U-B", localBulletinsCapacityEvicted: "U-M",
  typhoonCapacityEvicted: "U-Y" };

type Loss = Readonly<{ subject: string; unit: RuntimeUnitId; operation: string; atMs: number; inputId: string | null; reason: string;
  deadlineMs: number | null; counted: boolean }>;
type Rejection = Readonly<{ inputId: string; unit: RuntimeUnitId; operation: string; atMs: number; kind: "capacityExceeded" | "unavailable" }>;
type Usage = { limit: number; current: number; max: number; atMs: number | null };
type Outcome = { capacity: number; changed: boolean; invalid: string | null };
// step の state を unit の型のまま取り出す（K が総称のままだと step.state が全 unit の合併になるため、unit ごとに書く）。
type StateOf<K extends RuntimeUnitId> = (step: RuntimeUnitSteps[K]) => RuntimeUnitStates[K];
type Counter<K extends RuntimeUnitId> = (state: RuntimeUnitStates[K]) => readonly (readonly [string, number, number])[];
// U-W・U-F の capacityExceeded の unavailable の印（P3-DC-ORACLE (4)）。印を作った入力の inputId を返す。
type Marks<K extends RuntimeUnitId> = (state: RuntimeUnitStates[K]) => readonly (string | null)[];

const perFamily = (items: readonly Readonly<{ family: string; subject: string }>[]) => {
  const families = new Map<string, Set<string>>();
  for (const item of items) { const set = families.get(item.family) ?? new Set(); set.add(item.subject); families.set(item.family, set); }
  return families;
};
const noCount = () => [] as const;

// 状態の記録（intent・終端記録の欄を除く）の subject・source.subject と、本来の期限（retainUntil・validUntil・currentUntil の最初に有るもの。
// 入れ子の記録は自分に無ければ含む要素の値）。容量の診断が出た step だけで作る（P3-DC-RES-02）。
const SKIPPED = new Set(["intents", "deliveryRecords", "notificationLatches", "persistence"]);
function recordsOf(state: object): Map<string, number | null> {
  const found = new Map<string, number | null>();
  const deadline = (item: Readonly<Record<string, unknown>>, fallback: number | null) => {
    for (const key of ["retainUntil", "validUntil", "currentUntil"]) if (typeof item[key] === "number") return item[key];
    return fallback;
  };
  const add = (item: Readonly<Record<string, unknown>>, at: number | null) => {
    if (typeof item["subject"] === "string") found.set(item["subject"], at);
    const source = item["source"];
    if (isRecord(source) && typeof source["subject"] === "string") found.set(source["subject"], at);
  };
  const entries: [string, unknown][] = Object.entries(state);
  for (const [key, value] of entries) {
    if (SKIPPED.has(key)) continue;
    const elements = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
    for (const element of elements) {
      if (!isRecord(element)) continue;
      const at = deadline(element, null);
      add(element, at);
      for (const nested of Object.values(element)) if (Array.isArray(nested))
        for (const item of nested) if (isRecord(item)) add(item, deadline(item, at));
    }
  }
  return found;
}

// 観測の表: linkedUnitTable の 12 unit の reduce を結果を変えずに包み、step ごとに器の件数・容量の退去と欠け・入力単位の拒否・入力の結果を数える。
// 前の state は持ち続けない。無いと、区切りの間に退去して後で期限も過ぎた記録を見逃し、測りたい拒否と不正な入力を分けられない。
class ObservationTable {
  readonly units: UnitTable;
  readonly losses: Loss[] = [];
  readonly rejections: Rejection[] = [];
  readonly evictions: { atMs: number; unit: RuntimeUnitId; count: number }[] = [];
  readonly usage = new Map<string, Usage>();
  readonly marks: Partial<Record<RuntimeUnitId, number>> = {};
  private readonly outcomes = new Map<string, Outcome>();

  constructor(base: UnitTable = linkedUnitTable) {
    const units = (list: readonly (readonly [string, number])[], limit: number) => list.map(([id, value]) => [id, value, limit] as const);
    this.units = {
      // family が空になったら 0 を記録する（区切りの件数に前の値を残さない）。
      "U-E": this.wrap(base["U-E"], (step) => step.state, (state) => {
        const families = perFamily([...state.current, ...state.gates]);
        return [...new Set(["VXSE43", "VXSE45", ...families.keys()])].map((family) => [`U-E.family:${family}`, families.get(family)?.size ?? 0, 512] as const);
      }, null),
      "U-W": this.wrap(base["U-W"], (step) => step.state, (state) => [["U-W.partials", state.partials.length, 128]],
        (state) => state.unavailable.flatMap((item) => item.reason === "capacityExceeded" ? [item.source?.inputId ?? null] : [])),
      "U-F": this.wrap(base["U-F"], (step) => step.state, (state) => [["U-F.subjects", state.subjects.length, 512]],
        (state) => state.subjects.flatMap((item) => item.effective === "unavailable" && item.unavailableReason === "capacityExceeded" ? [item.source?.inputId ?? null] : [])),
      "U-T": this.wrap(base["U-T"], (step) => step.state, (state) => {
        const count = { VTSE51: [0, 0], VTSE52: [0, 0] };
        for (const item of state.observations) { count[item.family][0]++; count[item.family][1] += item.stations.length; }
        return [["U-T.forecasts", state.forecasts.length, 512], ...units([["U-T.observations:VTSE51", count.VTSE51[0]], ["U-T.observations:VTSE52", count.VTSE52[0]]], 512),
          ...units([["U-T.stations:VTSE51", count.VTSE51[1]], ["U-T.stations:VTSE52", count.VTSE52[1]]], 1_024)];
      }, null),
      "U-Q": this.wrap(base["U-Q"], (step) => step.state, (state) => [["U-Q.events", state.earthquakes.length, 512], ["U-Q.longPeriods", state.longPeriods.length, 256]], null),
      "U-N": this.wrap(base["U-N"], (step) => step.state, (state) => [["U-N.currents", state.currents.length, 6], ["U-N.information", state.information.length, 64]], null),
      "U-V": this.wrap(base["U-V"], (step) => step.state, noCount, null), "U-L": this.wrap(base["U-L"], (step) => step.state, noCount, null), "U-R": this.wrap(base["U-R"], (step) => step.state, noCount, null),
      "U-B": this.wrap(base["U-B"], (step) => step.state, noCount, null), "U-M": this.wrap(base["U-M"], (step) => step.state, noCount, null), "U-Y": this.wrap(base["U-Y"], (step) => step.state, noCount, null),
    };
  }

  // 入力 1 つの結果（そのinputId の receive の reduce が無ければ undefined）。
  outcome(inputId: string): Outcome | undefined { return this.outcomes.get(inputId); }

  record(id: string, value: number, limit: number, atMs: number): void {
    const usage = this.usage.get(id) ?? { limit, current: 0, max: 0, atMs: null };
    usage.current = value;
    if (value > usage.max) { usage.max = value; usage.atMs = atMs; }
    this.usage.set(id, usage);
  }

  private wrap<K extends RuntimeUnitId>(module: UnitModule<K>, stateOf: StateOf<K>, count: Counter<K>, marks: Marks<K> | null): UnitModule<K> {
    return { ...module, reduce: (state, input) => {
      const step = module.reduce(state, input);
      this.observe(module, state, input, step, stateOf(step), count, marks);
      return step;
    } };
  }

  private observe<K extends RuntimeUnitId>(module: UnitModule<K>, before: RuntimeUnitStates[K], input: RuntimeUnitInputs[K],
    step: RuntimeUnitSteps[K], next: RuntimeUnitStates[K], count: Counter<K>, marks: Marks<K> | null): void {
    const unit = module.unit;
    const given: RuntimeUnitInputs[RuntimeUnitId] = input;
    const taken: RuntimeUnitSteps[RuntimeUnitId] = step;
    const atMs = given.clock.wallTimeMs;
    const material = given.kind === "receive" ? given.material : null;
    const inputId = material?.inputId ?? null;
    const changed = next !== before;
    if (material != null && inputId != null) {
      const outcome = this.outcomes.get(inputId) ?? { capacity: 0, changed: false, invalid: null };
      for (const decision of taken.decisions) {
        if (decision.decision === "capacityExceeded") {
          outcome.capacity++;
          this.rejections.push({ inputId, unit, operation: decision.operation, atMs, kind: "capacityExceeded" });
        } else if (decision.decision === "changed") outcome.changed = true;
        else outcome.invalid ??= `${decision.decision}:${decision.reason}`;
      }
      // 同じ鍵への続けての拒否も、印の source がその入力なら 1 通ずつ数える。
      if (marks != null && changed) for (const id of marks(next)) if (id === inputId) {
        outcome.capacity++;
        this.rejections.push({ inputId, unit, operation: material.operation, atMs, kind: "unavailable" });
      }
      this.outcomes.set(inputId, outcome);
    }
    if (changed) {
      for (const [id, value, limit] of count(next)) this.record(id, value, limit, atMs);
      if (marks != null) this.marks[unit] = marks(next).length;
    }
    const evicted = taken.diagnostics.filter((item) => EVICTION[item.reason] === unit);
    if (evicted.length === 0) return;
    this.evictions.push({ atMs, unit, count: evicted.reduce((sum, item) => sum + (item.count ?? 1), 0) });
    // 容量の欠け（P3-DC-ORACLE (2)）: view から消えた subject のうち、後の state の記録にも無いもの。
    const after = new Set(module.toView(next).subjects.map((item) => item.subject));
    const candidates = [...new Set(module.toView(before).subjects.map((item) => item.subject))].filter((subject) => !after.has(subject));
    if (candidates.length === 0) return;
    const remaining = recordsOf(next), previous = recordsOf(before);
    for (const subject of candidates) {
      if (remaining.has(subject)) continue;
      const operation = subject.split("/")[0];
      const deadlineMs = previous.get(subject) ?? null;
      this.losses.push({ subject, unit, operation, atMs, inputId, reason: evicted[0].reason, deadlineMs,
        counted: operation === "normal" && (deadlineMs == null || deadlineMs > atMs) });
    }
  }
}

// ---- 1 段目の流し手（P3-DC-CLOCK、AC03・AC04・AC06） ----

const BYTE_LIMITS: Readonly<Partial<Record<RuntimeUnitId, number>>> = { "U-E": 262_144, "U-T": 4_194_304, "U-Q": 4_194_304, "U-N": 294_912,
  "U-W": 16_777_216, "U-F": 33_554_432 };
const DOMAIN_KEYS = ["eew", "weatherCurrent", "weatherTimeseries", "tsunami", "earthquake", "nankai", "volcano", "landslide", "flood",
  "briefing", "localBulletins", "typhoon"] as const satisfies readonly (keyof DisplaySnapshot["current"])[];
const DOMAINS: Readonly<Record<(typeof DOMAIN_KEYS)[number], RuntimeUnitId>> = { eew: "U-E", weatherCurrent: "U-W", weatherTimeseries: "U-F",
  tsunami: "U-T", earthquake: "U-Q", nankai: "U-N", volcano: "U-V", landslide: "U-L", flood: "U-R", briefing: "U-B", localBulletins: "U-M", typhoon: "U-Y" };
// P3-DC-D-SUMMARY の裁定 A': U-E・U-T・U-Q の要約は欠け。
const SUMMARY_FAILS: readonly RuntimeUnitId[] = ["U-E", "U-T", "U-Q"];
// P3-DC-OPTIONS: 届いた（と 90% を越えた）上限ごとの選択肢と行き先。
const OPTIONS: readonly (readonly [string, string, string | null])[] = [
  ["U-Q.bytes", "P3-C7-CAPACITY-BUDGET の B（震度観測点を state に持たない）・C（16 MiB、urgent の encode が最大 4 倍）か新しい案", "U-Q の容量の新しい契約"],
  ["U-Q.events", "P3-C7-CAPACITY-BUDGET の RET-01（event 512）", "U-Q の容量の新しい契約"],
  ["U-W.", "U-W の正本の持ち方（406 鍵と取消の履歴）", "3 つ目の単位"],
  ["U-F.bytes", "U-F の state の持ち方（P3-UF-PUBLIC-001 は view だけで state を変えない）", "U-F の容量の新しい契約"],
  ["U-T.stations", "P3-C5-CAPACITY（p3-tsunami-unit.json）の観測点の上限", "P3-C5-CAPACITY の行き先の契約"],
  ["U-N.information", "P3-C8-CAPACITY（p3-nankai-unit.json）の情報の深さ", "P3-C8-CAPACITY の行き先の契約"],
  ["U-E.family", "P3-EEW-GATE-EVICT-001 の family 512（10 分）", "P3-EEW-GATE-EVICT-001"],
  ["snapshot", "要約の順（P3-LIMIT-RULES-001 の P3-LIM-AC06 の起草案、作者裁定 D0 で材料として残したもの）", "2 つ目の単位（C1）"],
];
const optionOf = (id: string) => {
  const row = OPTIONS.find(([prefix]) => id.startsWith(prefix));
  return { limit: id, choices: row?.[1] ?? "P3-DC-OPTIONS に行の無い上限（統合担当が行き先を決める）", destination: row?.[2] ?? null };
};
// 測った commit の契約（Q-DC-REMEASURE）。U-W の単位（3 つ目の単位）の契約は起草の時点で無い。
const REMEASURE = ["P3-UF-PUBLIC-001", "P3-CURRENCY-COVERAGE-001"];

type BlockedReason = "dataMissing" | "digestMismatch" | "timeBudget" | "settleTimeout" | "inputNotAdopted" | "checkpointFailed";
class Blocked extends Error {
  constructor(readonly reason: BlockedReason, readonly detail: string) { super(`${reason}: ${detail}`); }
}

type RunOptions = Readonly<{
  // 結果の書き先（FLEQ_DISASTER_OUT の 1 file）。null は書かない。
  out?: string | null;
  // P3-DC-RES-01: 越えたら止めて blocked（timeBudget）。
  budgetMs?: number;
  // T10: この区間は格子を飛ばさずに 1 秒ごとに tick する。
  everySecond?: readonly Readonly<{ fromMs: number; toMs: number }>[];
  checkpointFileSystem?: CheckpointFileSystem;
  // 試験の前置き: 観測の表が包む前の unit 表と、起動の後・最初の frame の前に呼ぶもの（owner-harness の seeded）。
  units?: UnitTable;
  prepare?: (h: Harness, clock: ClockReading) => Promise<void>;
}>;

// 必ず成功するメモリの保存（projection-fixture.ts の memoryWrites と同じ形、disk に書かない）。
function memoryFiles(): CheckpointFileSystem {
  const files = new Map<string, Uint8Array>();
  return { readFile: (path) => files.get(path) ?? null, unlinkSync: (path) => { files.delete(path); },
    mkdir: async () => {}, rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from); }, syncDirectory: async () => {},
    open: async (path) => {
      let bytes = new Uint8Array();
      return { write: async (data) => { bytes = data.slice(); }, sync: async () => {}, close: async () => { files.set(path, bytes); } };
    } };
}

// 診断は捨てる（保存の再試行の予定だけ見る、P3-DC-CLOCK (6)）。
function discardDiagnostics(onRetry: () => void): DiagnosticFileSystem {
  return { mkdir: async () => {}, appendFile: async (_path, data) => { if (data.includes("checkpointRetryScheduled")) onRetry(); },
    readLastByte: async () => null, writeFile: async () => {}, rename: async () => {}, readFile: async () => "", files: async () => [], unlink: async () => {} };
}

function gitHead(): string | null {
  try {
    let dir = resolve(".git");
    if (statSync(dir).isFile()) dir = resolve(/gitdir: (.*)/.exec(readFileSync(dir, "utf8"))![1].trim());
    const head = readFileSync(join(dir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head;
    const ref = head.slice(5);
    const common = existsSync(join(dir, "commondir")) ? resolve(dir, readFileSync(join(dir, "commondir"), "utf8").trim()) : dir;
    for (const base of [dir, common]) if (existsSync(join(base, ref))) return readFileSync(join(base, ref), "utf8").trim();
    return readFileSync(join(common, "packed-refs"), "utf8").split("\n").find((line) => line.endsWith(` ${ref}`))?.split(" ")[0] ?? null;
  } catch { return null; }
}

function contractRefs(): { contractId: string; metaSha256: string | null }[] {
  const found = new Map<string, string | null>();
  for (const name of readdirSync("reconstruction/contracts")) {
    if (!name.endsWith(".json")) continue;
    const parsed: unknown = JSON.parse(readFileSync(join("reconstruction/contracts", name), "utf8"));
    const contract = isRecord(parsed) && isRecord(parsed["contract"]) ? parsed["contract"] : null;
    const meta = isRecord(parsed) && isRecord(parsed["meta"]) ? parsed["meta"] : null;
    const id = contract?.["contractId"];
    if (typeof id === "string" && REMEASURE.includes(id)) found.set(id, typeof meta?.["sha256"] === "string" ? meta["sha256"] : null);
  }
  return [...REMEASURE.map((contractId) => ({ contractId, metaSha256: found.get(contractId) ?? null })), { contractId: "U-W の単位（3 つ目の単位）", metaSha256: null }];
}

function seal(result: Readonly<Record<string, JsonValue>>, out: string | null | undefined): string {
  const text = sealSelfHash(`${JSON.stringify({ selfSha256: ZERO_HASH, ...result }, null, 1)}\n`, "selfSha256");
  if (out != null) writeFileSync(out, text);
  return text;
}

type Spans = Map<string, { fromMs: number; toMs: number | null }[]>;

const ZERO_DOMAINS = Object.fromEntries(DOMAIN_KEYS.map((key) => [key, 0]));
// snapshot の byte: 分野ごと（要約は originalBytes、全体は view の UTF-8）と、製品と同じ外枠の計量（P2-A8 RES-06 の shellBytes:
// 分野を 0 に置いた snapshot の byte から 0 の 12 byte を引く）。U-W・U-F を除いた合計が 1 MiB を越えれば災害の情報だけで溢れている。
function measureSnapshot(snapshot: DisplaySnapshot): Readonly<{ bytes: Record<string, number>; shell: number; total: number; withoutWeather: number;
  withoutWeatherOver1MiB: boolean }> {
  const bytes: Record<string, number> = {};
  for (const key of DOMAIN_KEYS) {
    const domain = snapshot.current[key];
    bytes[DOMAINS[key]] = domain.delivery === "summary" ? domain.originalBytes : Buffer.byteLength(JSON.stringify(domain));
  }
  const shell = Buffer.byteLength(JSON.stringify({ ...snapshot, current: ZERO_DOMAINS })) - DOMAIN_KEYS.length;
  const total = Object.values(bytes).reduce((sum, value) => sum + value, shell);
  const withoutWeather = total - bytes["U-W"] - bytes["U-F"];
  return { bytes, shell, total, withoutWeather, withoutWeatherOver1MiB: withoutWeather > 1_048_576 };
}

// 1 段目の流し手: 1 筋書き 1 run、空の state から。結果（自己 hash 付きの JSON）を返し、out があれば書く。
async function runStage1(scenario: Scenario, options: RunOptions = {}): Promise<Readonly<{ text: string; result: Readonly<Record<string, JsonValue>> }>> {
  const began = performance.now();
  const identity = { schema: "p3-disaster-capacity-result-v1", contractId: "P3-DISASTER-CAPACITY-001", scenario: scenario.id, gitHead: gitHead(),
    digest: scenario.digest, synth: scenario.kind === "ready" ? scenario.synth : null, t0: scenario.kind === "ready" ? scenario.t0 : null,
    contracts: contractRefs() };
  if (scenario.kind === "blocked") {
    const result = { ...identity, status: "blocked", blocked: { reason: scenario.reason, atMs: null, detail: "" }, timing: { runMs: 0, frames: 0, ticks: 0 } };
    return { text: seal(result, options.out), result };
  }
  const budgetMs = options.budgetMs ?? 60 * 60_000;
  // 採取物の受信が始まりより前なら、始まりをそこへ寄せる（時計を戻さない）。
  const startMs = Math.min(scenario.startMs, scenario.frames[0]?.atMs ?? Infinity), endMs = scenario.endMs;
  let now: ClockReading = { wallTimeMs: startMs, monotonicMs: 1 };
  const setNow = (wallTimeMs: number) => { now = { wallTimeMs, monotonicMs: wallTimeMs - startMs + 1 }; };
  let saveFailure: string | null = null;
  const table = new ObservationTable(options.units ?? linkedUnitTable);
  const spans: Spans = new Map();
  const transitions: JsonValue[] = [];
  let summarized = "";
  const measure = (list: readonly CheckpointMeasurement[]) => {
    for (const item of list) {
      if (item.outcome === "failed" || item.retryReason !== "notRetry") saveFailure ??= `${item.unit} ${item.stage} ${item.outcome} ${item.retryReason}`;
      const unit = runtimeUnits.find((candidate) => candidate === item.unit);
      const limit = unit == null ? undefined : BYTE_LIMITS[unit];
      if (item.stage === "encode" && limit != null) table.record(`${item.unit}.bytes`, item.bytes, limit, now.wallTimeMs);
    }
  };
  // snapshot の要約（AC04 (4)）: 分野ごとの要約の始まりと終わり。要約の組が変わった時刻だけ分野ごとの byte を数える。
  let lastSnapshot: DisplaySnapshot | null = null;
  const publish = (snapshot: DisplaySnapshot) => {
    lastSnapshot = snapshot;
    const current = DOMAIN_KEYS.filter((key) => snapshot.current[key].delivery === "summary");
    for (const key of DOMAIN_KEYS) {
      const list = spans.get(DOMAINS[key]) ?? [];
      const open = list.at(-1)?.toMs === null ? list.at(-1)! : null;
      if (current.includes(key) && open == null) { list.push({ fromMs: now.wallTimeMs, toMs: null }); spans.set(DOMAINS[key], list); }
      else if (!current.includes(key) && open != null) open.toMs = now.wallTimeMs;
    }
    if (current.join() === summarized) return;
    summarized = current.join();
    transitions.push({ atMs: now.wallTimeMs, summarized: current.map((key) => DOMAINS[key]), ...measureSnapshot(snapshot) });
  };
  const h = harnessedRoot({ appName: "fleq-disaster", legacyAppName: "fleq", stateDirectory: "disaster-state", legacyStateDirectory: "disaster-legacy",
    diagnosticDirectory: "disaster-diagnostics" }, linkedUnitCodecs, {
    clock: () => now, runtimeCalls: { ...linkedRuntimeCalls, units: table.units }, checkpointFileSystem: options.checkpointFileSystem ?? memoryFiles(),
    diagnosticFileSystem: discardDiagnostics(() => { saveFailure ??= "checkpointRetryScheduled"; }), reportFailure: () => {},
    notificationAdapter: { run: async (attempt, clock) => ({ kind: "delivered", attemptId: attempt.attemptId, intentId: attempt.intentId,
      channel: attempt.channel, completedAt: clock() }), abort: async () => ({ stopped: true }) },
    onMeasurements: measure, display: { publish } });

  // 製品の setTimeout・clearTimeout は fake timers（display-wiring.test.ts と同じ）。満了の時刻は呼出しを見て覚える。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const setSpy = vi.spyOn(globalThis, "setTimeout"), clearSpy = vi.spyOn(globalThis, "clearTimeout");
  const timers = new Map<unknown, number>();
  let fakeMs = startMs;
  // 読んだ呼出しは spy から消す（spy が callback を持ち続けると、callback が閉じ込めた snapshot が run の間ずっと残ってメモリが尽きる）。
  const collectTimers = () => {
    setSpy.mock.calls.forEach((call, index) => timers.set(setSpy.mock.results[index].value, now.wallTimeMs + Math.max(0, call[1] ?? 0)));
    for (const [handle] of clearSpy.mock.calls) timers.delete(handle);
    setSpy.mockClear();
    clearSpy.mockClear();
  };
  // fake timers を仮想時計の時刻まで進める。満了したものを消してから、callback が新しく置いたものを足す。
  const advance = (to: number) => {
    vi.advanceTimersByTime(to - fakeMs);
    fakeMs = to;
    for (const [handle, due] of timers) if (due <= to) timers.delete(handle);
    collectTimers();
  };
  const nextTimer = () => Math.min(Infinity, ...timers.values());
  const unresolved: JsonValue[] = [];
  let lastUnresolved = "{}";
  const unresolvedSeen = new Map<string, Record<"normal" | "training" | "test" | "marks", number>>();
  let ticks = 0, frameCount = 0;
  const realInvalid: Record<string, number> = {};
  const settled = async (action: Promise<void>) => {
    try { await action; }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("settle(): not settled")) throw new Blocked("settleTimeout", error.message);
      throw error;
    }
    collectTimers();
    // owner-harness は送った要求と届いた返信を全部残す（試験が読むため）。長い run では view を持つ返信が溜まってメモリが尽きるので、
    // 読まないこの run では settle ごとに捨てる。
    h.sent.length = 0;
    h.delivered.length = 0;
    if (saveFailure != null) throw new Blocked("checkpointFailed", saveFailure);
    // 未解消の拒否の状態（AC04 (2)）: 返信の admissionCounts と U-W・U-F の印の数。変わったときだけ残す。
    const counts: Record<string, JsonValue> = {};
    for (const unit of runtimeUnits) {
      const { normal, training, test } = h.root.state.mirror[unit].admissionCounts;
      const marks = table.marks[unit] ?? 0;
      if (normal + training + test + marks === 0) continue;
      counts[unit] = { normal, training, test, marks };
      const max = unresolvedSeen.get(unit) ?? { normal: 0, training: 0, test: 0, marks: 0 };
      unresolvedSeen.set(unit, { normal: Math.max(max.normal, normal), training: Math.max(max.training, training), test: Math.max(max.test, test),
        marks: Math.max(max.marks, marks) });
    }
    const key = JSON.stringify(counts);
    if (key !== lastUnresolved) { lastUnresolved = key; unresolved.push({ atMs: now.wallTimeMs, counts }); }
  };
  // 時計を target へ進める。途中で満了する timer は満了の時刻で発火させ、その tick も settle してから先へ進む（P3-DC-CLOCK (2)）。
  const moveTo = async (target: number) => {
    for (let due = nextTimer(); due <= target; due = nextTimer()) {
      setNow(Math.max(due, now.wallTimeMs));
      advance(now.wallTimeMs);
      await settled(h.settle());
    }
    setNow(target);
    advance(target);
  };
  // owner の state の期限（owner-runtime.ts の deadlines の wallTimeMs と monotonicMs の最小、harness の unit() と同じ読み方）。
  const ownerDeadline = () => {
    let min = Infinity;
    for (const place of places) {
      const state = h.owners.get(place)!["state"];
      if (state == null) continue;
      for (const unit of runtimeUnits) {
        const deadline = executionPlaces[unit] === place ? state.deadlines[unit] : null;
        if (deadline?.wallTimeMs != null) min = Math.min(min, deadline.wallTimeMs);
        if (deadline?.monotonicMs != null) min = Math.min(min, startMs + deadline.monotonicMs - 1);
      }
    }
    return min;
  };
  const grid = (atMs: number) => startMs + Math.ceil((atMs - startMs) / 1_000) * 1_000;
  // 区切りと期待例の時刻。その時刻までの frame と tick を済ませてから記録する（P3-DC-RES-02: 期待例は区切りの時刻だけ）。
  const points = [...scenario.checkpoints.map((item) => ({ ...item, check: null })), ...scenario.expectations].sort((a, b) => a.atMs - b.atMs);
  const checkpoints: JsonValue[] = [];
  const expectations: JsonValue[] = [];
  const evaluate = (point: (typeof points)[number]) => {
    if (point.check == null) {
      const snapshot: DisplaySnapshot | null = lastSnapshot;
      const measured = snapshot == null ? null : measureSnapshot(snapshot);
      checkpoints.push({ atMs: point.atMs, label: point.label, usage: Object.fromEntries([...table.usage].map(([id, usage]) => [id, usage.current])),
        snapshot: measured == null ? null : { total: measured.total, withoutWeather: measured.withoutWeather, withoutWeatherOver1MiB: measured.withoutWeatherOver1MiB } });
      return;
    }
    expectations.push({ atMs: point.atMs, label: point.label, ok: point.check(h, table.losses) });
  };

  let blocked: Blocked | null = null;
  try {
    await settled(startHarness(h, "disaster", now));
    if (options.prepare != null) await settled(options.prepare(h, now));
    let frameIndex = 0, pointIndex = 0, lastTick = -Infinity;
    // 直前の frame の時刻。その後の最初の格子で tick する（次の tick の候補、P3-DC-CLOCK (4)）。
    let afterFrame: number | null = null;
    const nextTick = () => {
      let trigger = Math.min(ownerDeadline(), nextTimer(), afterFrame ?? Infinity);
      const step = lastTick + 1_000;
      for (const window of options.everySecond ?? []) {
        if (step >= window.fromMs && step <= window.toMs) trigger = Math.min(trigger, step);
        else if (window.fromMs > lastTick) trigger = Math.min(trigger, window.fromMs);
      }
      return trigger === Infinity ? Infinity : Math.max(grid(trigger), lastTick === -Infinity ? startMs : lastTick + 1_000);
    };
    for (;;) {
      if (performance.now() - began > budgetMs) throw new Blocked("timeBudget", `stopped at ${new Date(now.wallTimeMs).toISOString()}`);
      const frameAt = scenario.frames[frameIndex]?.atMs ?? Infinity;
      const tickAt = nextTick();
      const next = Math.min(frameAt, tickAt);
      const point = points[pointIndex];
      if (point != null && point.atMs < Math.min(next, endMs + 1)) {
        await moveTo(Math.max(point.atMs, now.wallTimeMs));
        evaluate(point);
        pointIndex++;
        continue;
      }
      if (next > endMs) break;
      if (frameAt <= tickAt) {
        const frame = scenario.frames[frameIndex++];
        await moveTo(frame.atMs);
        const inputId = `input-${++frameCount}`;
        await settled(submit(h, envelope(h.root.state.runId, frame.headType, inputId, frame.body, now, frameCount)));
        afterFrame = frame.atMs;
        // 合成の frame の入力の結果（P3-DC-ORACLE (5)）: 容量の拒否は数えて続け、不正だけを測定不成立にする。実電文の不正は数える。
        const outcome = table.outcome(inputId);
        const declared = frame.unchanged != null && outcome?.invalid === `unchanged:${frame.unchanged}`;
        const invalid = outcome == null ? "notReduced" : outcome.capacity > 0 || outcome.changed || declared ? null : outcome.invalid ?? "noDecision";
        // 合成と公開サンプルは筋書きが中身を決める入力なので、不正は測定不成立。実電文だけ数えて続ける。
        if (invalid != null && frame.origin !== "real") throw new Blocked("inputNotAdopted", `${inputId} ${frame.source} ${frame.headType} ${invalid}`);
        if (invalid != null) realInvalid[`${frame.headType} ${invalid}`] = (realInvalid[`${frame.headType} ${invalid}`] ?? 0) + 1;
      } else {
        await moveTo(tickAt);
        h.root.tick(now);
        ticks++;
        await settled(h.settle());
        lastTick = tickAt;
        if (afterFrame != null && tickAt >= afterFrame) afterFrame = null;
      }
    }
    await moveTo(Math.max(endMs, now.wallTimeMs));
    for (; pointIndex < points.length; pointIndex++) evaluate(points[pointIndex]);
  } catch (error) {
    if (!(error instanceof Blocked)) throw error;
    blocked = error;
  } finally {
    setSpy.mockRestore();
    clearSpy.mockRestore();
    vi.useRealTimers();
  }
  const timing = { runMs: Math.round(performance.now() - began), frames: frameCount, ticks };
  if (blocked != null) {
    // blocked の結果は器の値を出さない（Fail と数えない、P3-DC-PASS）。
    const result = { ...identity, status: "blocked", blocked: { reason: blocked.reason, atMs: now.wallTimeMs, detail: blocked.detail }, timing };
    return { text: seal(result, options.out), result };
  }
  // 終わりの unit の state の保存の encode の sha256（T10 の比べ）。
  const encoded = <K extends RuntimeUnitId>(unit: K, state: RuntimeUnitStates[K]) => linkedUnitCodecs[unit]?.encode(state);
  const finalStates: Record<string, string> = {};
  for (const unit of runtimeUnits) {
    const value = encoded(unit, h.unit(unit));
    if (value !== undefined) finalStates[unit] = sha256(JSON.stringify(value));
  }
  const limits = [...table.usage].sort(([a], [b]) => a < b ? -1 : 1).map(([id, usage]) => ({ id, limit: usage.limit, max: usage.max,
    ratio: Math.round((usage.max / usage.limit) * 10_000) / 10_000, atMs: usage.atMs, over90: usage.max > usage.limit * 0.9 }));
  const evictions: Record<string, number | "unmeasured"> = { "U-F": "unmeasured" };
  for (const item of table.evictions) evictions[item.unit] = (typeof evictions[item.unit] === "number" ? Number(evictions[item.unit]) : 0) + item.count;
  const summaries = Object.fromEntries([...spans].map(([unit, list]) => [unit, list.map((span) => ({ fromMs: span.fromMs, toMs: span.toMs }))]));
  const failingSummary = SUMMARY_FAILS.filter((unit) => (spans.get(unit)?.length ?? 0) > 0);
  const countedLosses = table.losses.filter((item) => item.counted);
  // U-Q の subject は family ごとなので、event の数は EventID で数えて並べる（P3-DC-ORACLE (2)）。
  const quakeEvents = (list: readonly Loss[]) => new Set(list.filter((item) => item.unit === "U-Q").map((item) => item.subject.split("/")[2])).size;
  const unresolvedMax: Record<string, Record<string, number>> = {};
  for (const [unit, counts] of unresolvedSeen) unresolvedMax[unit] = counts;
  const pass = table.rejections.length === 0 && countedLosses.length === 0 && expectations.every((item) => isRecord(item) && item["ok"] === true)
    && failingSummary.length === 0;
  const result = { ...identity, status: pass ? "Pass" : "Fail", blocked: null,
    pass: { inputRejections: table.rejections.length, capacityLosses: countedLosses.length, capacityLossQuakeEvents: quakeEvents(countedLosses),
      expectationsFailed: expectations.filter((item) => isRecord(item) && item["ok"] !== true).length, failingSummaries: failingSummary },
    limits, over90: limits.filter((item) => item.over90).map((item) => item.id),
    options: [...limits.filter((item) => item.over90).map((item) => optionOf(item.id)), ...(failingSummary.length === 0 ? [] : [optionOf("snapshot")])],
    // EEW（U-E）は報ごとの時刻の列を書かず件数だけにする（P3-DC-AC01 (4)）。
    rejections: table.rejections.filter((item) => item.unit !== "U-E"), eewRejections: table.rejections.filter((item) => item.unit === "U-E").length,
    unresolved, unresolvedMax,
    evictions: { total: evictions, series: table.evictions.filter((item) => item.unit !== "U-E") },
    losses: table.losses.filter((item) => item.unit !== "U-E"), eewLosses: { all: table.losses.filter((item) => item.unit === "U-E").length,
      counted: countedLosses.filter((item) => item.unit === "U-E").length }, quakeEventLosses: { all: quakeEvents(table.losses), counted: quakeEvents(countedLosses) },
    realInvalid, summaries, summaryTransitions: transitions, checkpoints, expectations,
    final: { stateSha256: finalStates }, run: { startMs, endMs }, timing };
  return { text: seal(result, options.out), result };
}

export { ObservationTable, runStage1 };
export type { Loss, RunOptions };
