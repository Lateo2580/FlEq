import { createHash } from "node:crypto";

import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type { DisplayVersion } from "../../../contracts/p2-snapshot-sse.types";
import type {
  ChromeEewMarkerDetail,
  ChromeSmokeConditions,
  EewMeasurementManifest,
  EewReferencePopulation,
  EewTrialSetup,
} from "../../../contracts/p2-eew-e01.types";
import type { P3E01Manifest, P3EewEstablishment, P3EewPopulation, P3EewPopulationCondition } from "../../../contracts/p3-e01-reaccept.types";

// P2-A10-AC01/AC14 の凍結境界。無いと、結果を見た後に manifest を書き換えても検出できず、
// smoke 条件との差異や使用契約の hash 不一致が黙って通る。

const ZERO_HASH = "0".repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;
const HASH_CONVENTION = "sha256 of UTF-8 file bytes with meta.sha256 replaced by 64 ASCII zeroes";

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// JSON.parse は重複キーを黙って潰すので、保存 bytes を走査して検出する。
// トップレベルの文字列値だけ位置（引用符の内側）を返す。text は JSON.parse で構文検証済みとして扱う。
function scanTopLevelStrings(text: string): Map<string, { start: number; end: number }> {
  const top = new Map<string, { start: number; end: number }>();
  let i = 0;
  const ws = (): void => {
    while (i < text.length && " \t\r\n".includes(text[i]!)) i++;
  };
  const str = (): { start: number; end: number } => {
    const start = ++i;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    return { start, end: i++ };
  };
  const value = (depth: number): { start: number; end: number } | null => {
    ws();
    const c = text[i];
    if (c === '"') return str();
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") { i++; return null; }
      const keys = new Set<string>();
      for (;;) {
        ws();
        const k = str();
        const key = JSON.parse(text.slice(k.start - 1, k.end + 1)) as string;
        if (keys.has(key)) throw new Error(`duplicate key: ${key}`);
        keys.add(key);
        ws();
        i++; // ':'
        const v = value(depth + 1);
        if (depth === 0 && v != null) top.set(key, v);
        ws();
        if (text[i++] === "}") return null;
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") { i++; return null; }
      for (;;) {
        value(depth + 1);
        ws();
        if (text[i++] === "]") return null;
      }
    }
    while (i < text.length && !",]} \t\r\n".includes(text[i]!)) i++;
    return null;
  };
  value(0);
  return top;
}

// text は呼び出し側が JSON.parse で構文検証済みであること。
function selfHashRange(text: string, field: string): { start: number; end: number } {
  const range = scanTopLevelStrings(text).get(field);
  if (range == null) throw new Error(`top-level ${field} is missing`);
  return range;
}

// 保存 bytes のまま、トップレベルの自己 hash field だけを 64 個の 0 に置換して sha256 を取り、保存値と照合する。
// parse/stringify による正規化はしない。検証済みの parse 結果を返す（型付けは呼び出し側の境界検証が行う）。
function readSelfHashed(text: string, field: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const { start, end } = selfHashRange(text, field);
  const stored = text.slice(start, end);
  if (!HEX64.test(stored)) throw new Error(`${field} is not 64 lowercase hex`);
  if (sha256Hex(text.slice(0, start) + ZERO_HASH + text.slice(end)) !== stored) throw new Error(`${field} mismatch`);
  return parsed;
}

// result の保存直前に使う。field が 0 埋めのまま直列化された text に、自己 hash を書き込んだ text を返す。
function sealSelfHash(text: string, field: string): string {
  JSON.parse(text);
  const { start, end } = selfHashRange(text, field);
  const zeroed = text.slice(0, start) + ZERO_HASH + text.slice(end);
  return text.slice(0, start) + sha256Hex(zeroed) + text.slice(end);
}

function need(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.length > 0;
const isHex = (v: unknown): boolean => typeof v === "string" && HEX64.test(v);

function verifyChromeSmokeConditions(text: string): ChromeSmokeConditions {
  // 境界で一度だけ型を主張する。以下の検査で形を確かめる。
  const c = readSelfHashed(text, "conditionsSha256") as ChromeSmokeConditions;
  need(c.schemaVersion === "p2-chrome-smoke-conditions-v1", "smoke schemaVersion");
  need(isHex(c.geometrySha256) && Object.values(c.fixtureSha256).every(isHex), "smoke hash fields");
  return c;
}

const REFERENCE_POPULATIONS: readonly EewReferencePopulation[] = ["maxVpws50DecodeStarted", "maxWeatherCheckpointEncodeStarted", "maxForecastCheckpointSave", "forecastDeadlineOverlap"];

type CommonManifest = Omit<EewMeasurementManifest, "schemaVersion" | "formal" | "reference" | "auxiliary">;

// A10 と P3 の manifest が共有する固定値の検査。
function verifyCommon(m: CommonManifest): void {
  need(m.measuredSseClients === 1 && m.warmupPerRun === 100 && m.samplesPerRun === 1000 && m.runCount === 3, "manifest run counts");
  need(m.missingAfterMs === 10000 && m.callbackDeadlineAfterInjectionMs === 10000 && m.clockProbeEveryMs === 30000, "manifest deadlines");
  need(m.maxClockIntervalWidthMs === 5 && m.quantile === "nearestRank", "manifest clock/quantile");
  need(m.health.loads.length === 2 && m.health.loads[0] === "N" && m.health.loads[1] === "P" &&m.health.requestEveryMs === 1000 && m.health.minSamplesPerRun === 1000 && m.health.runCount === 3 && m.health.requestTimeoutMs > 0, "health conditions");
  need(isHex(m.geometrySha256) && Object.values(m.fixtureSha256).every(isHex), "manifest hash fields");
}

// trialSetup: 全保存 bytes の素の sha256。手順は非空、使用単位の checkpoint entry は省略不可。
function verifyTrialSetup(m: CommonManifest, trialSetupText: string): EewTrialSetup {
  need(sha256Hex(trialSetupText) === m.trialSetupSha256, "trialSetupSha256 mismatch");
  const t = JSON.parse(trialSetupText) as EewTrialSetup;
  scanTopLevelStrings(trialSetupText); // 重複キー拒否
  need(t.schemaVersion === "p2-eew-trial-setup-v1" && nonEmpty(t.initialStateRef) && isHex(t.initialStateSha256), "trialSetup identity");
  need(t.clock.monotonicOrigin === "runNodeClock", "trialSetup clock");
  for (const steps of [t.resetBeforeEachTrial, t.prepareDirtyGeneration, t.preventReplacementUntilPaintOrTimeout]) {
    need(steps.length > 0 && steps.every(nonEmpty), "trialSetup steps must be non-empty");
  }
  for (const unit of ["U-E", "U-W", "U-F"] as const) {
    const entry = t.initialCheckpoints[unit];
    need(entry != null, `trialSetup checkpoint entry missing: ${unit}`);
    const absent = entry.ref == null && entry.sha256 == null;
    need(absent || (nonEmpty(entry.ref) && isHex(entry.sha256)), `trialSetup checkpoint ref/hash: ${unit}`);
  }
  return t;
}

// smoke 条件: hash 一致と、差異が実在するなら差異記録を必須にする。
function verifySmokeAgainst(m: CommonManifest, smokeConditionsText: string): ChromeSmokeConditions {
  const smoke = verifyChromeSmokeConditions(smokeConditionsText);
  need(m.smokeConditionsSha256 === smoke.conditionsSha256, "smokeConditionsSha256 mismatch");
  const differs =
    JSON.stringify([m.chrome.version, m.chrome.foregroundTab, m.chrome.viewportCssPx, m.chrome.dpr, m.chrome.motion]) !==
      JSON.stringify([smoke.chrome.version, smoke.chrome.foregroundTab, smoke.chrome.viewportCssPx, smoke.chrome.dpr, smoke.chrome.motion]) ||
    m.geometrySha256 !== smoke.geometrySha256 ||
    Object.entries(smoke.fixtureSha256).some(([id, h]) => m.fixtureSha256[id] !== h);
  need(!differs || m.smokeConditionDifferences.length > 0, "smoke differences must be recorded");
  return smoke;
}

// 使用契約: 各契約の hashConvention（meta.sha256 だけを 0 置換した保存 bytes の sha256）で再計算して照合する。
function verifyContractHashes(contractSha256: Readonly<Record<string, string>>, contractTexts: Readonly<Record<string, string>>): void {
  need(Object.keys(contractSha256).length > 0, "contractSha256 must not be empty");
  // check-contract.mjs:57 と同じ規約（複製）。変えるときは両方直す。
  const prefix = /^(\{\s*"meta"\s*:\s*\{\s*"draftedFromOid"\s*:\s*"[^"]+"\s*,\s*"sha256"\s*:\s*")([a-f0-9]{64})(")/;
  for (const [id, expected] of Object.entries(contractSha256)) {
    const text = contractTexts[id];
    need(text != null, `contract text missing: ${id}`);
    const meta = (JSON.parse(text) as { meta: { sha256: string; hashConvention: string } }).meta;
    need(isHex(expected) && meta.sha256 === expected && meta.hashConvention === HASH_CONVENTION, `contract hash: ${id}`);
    need(prefix.test(text) && sha256Hex(text.replace(prefix, (_, a: string, _h: string, c: string) => a + ZERO_HASH + c)) === expected, `contract digest: ${id}`);
  }
}

function verifyFrozenManifest(input: Readonly<{
  manifestText: string;
  trialSetupText: string;
  smokeConditionsText: string;
  // contractId → 契約 JSON の保存 text
  contractTexts: Readonly<Record<string, string>>;
}>): Readonly<{ manifest: EewMeasurementManifest; trialSetup: EewTrialSetup; smoke: ChromeSmokeConditions }> {
  const m = readSelfHashed(input.manifestText, "manifestSha256") as EewMeasurementManifest;
  need(m.schemaVersion === "p2-eew-e01-manifest-v2", "manifest schemaVersion");
  verifyCommon(m);
  const t = verifyTrialSetup(m, input.trialSetupText);
  const smoke = verifySmokeAgainst(m, input.smokeConditionsText);
  verifyContractHashes(m.contractSha256, input.contractTexts);
  for (const id of ["N", "P", "C"] as const) {
    const ld = m.loads[id];
    need(ld.ordering.length > 0 && ld.offsetsMs.length === ld.ordering.length, `load ${id} ordering/offsets`);
    need(m.loads[id].id === id && isHex(m.loads[id].sha256) && m.loads[id].fixtureRefs.length > 0, `load ${id}`);
  }
  const f = m.formal;
  need(f.population === "fixedBacklog" && Object.hasOwn(m.loads, f.load), "formal population/load");
  need([f.trigger, f.forecast.saveCondition, f.forecast.deadlineCondition].every(nonEmpty), "formal conditions");
  need(forecastWithinAllowance(m, f.forecast), "formal forecast outside its own allowance");
  for (const key of REFERENCE_POPULATIONS) {
    const r = m.reference[key];
    need(r != null && Object.hasOwn(m.loads, r.load) && nonEmpty(r.trigger) && nonEmpty(r.stateRef) && isHex(r.stateSha256), `reference ${key}`);
    need(r.targetOffsetMs === 1 && r.acceptedOffsetRangeMs[0] === 0 && r.acceptedOffsetRangeMs[1] === 5, `reference offset ${key}`);
    need(Number.isInteger(r.warmupPerRun) && r.warmupPerRun >= 0 && Number.isInteger(r.samplesPerRun) && r.samplesPerRun > 0, `reference counts ${key}`);
    need([1, 2, 3].includes(r.runCount) && ["sampleCount", "elapsed", "blocked"].includes(r.stopCondition.kind), `reference stop ${key}`);
  }
  return { manifest: m, trialSetup: t, smoke };
}

const P3_POPULATIONS: readonly P3EewPopulation[] = ["fixedBacklog", "maxVpws50ParseStarted", "maxWeatherCheckpointEncodeStarted",
  "maxForecastCheckpointSave", "forecastDeadlineOverlap", "maxVpws50ReceivedThenEew"];
const LEAD_POPULATIONS: ReadonlySet<P3EewPopulation> = new Set(["maxWeatherCheckpointEncodeStarted", "maxForecastCheckpointSave", "forecastDeadlineOverlap"]);
const P3_ESTABLISHMENT: Readonly<Record<P3EewPopulation, P3EewEstablishment["kind"]>> = {
  fixedBacklog: "none", maxVpws50ParseStarted: "startOffset", maxWeatherCheckpointEncodeStarted: "startOffset",
  maxForecastCheckpointSave: "startOffset", forecastDeadlineOverlap: "startOffset", maxVpws50ReceivedThenEew: "sentBeforeLargeFrameIngested",
};

// Q-C4-O09-SUBSET: o09Subset の sha が sequences.json の meta.sha256 と、その hashConvention で計算した値の両方に一致し、各 position が
// O09 に在ること（check-sequences.mjs と同じ規約の複製。変えるときは両方直す）。
function verifyO09Subset(subset: P3E01Manifest["o09Subset"], sequencesText: string): void {
  const prefix = /^(\{\s*"meta"\s*:\s*\{\s*"baseOid"\s*:\s*"[^"]+"\s*,\s*"sha256"\s*:\s*")([a-f0-9]{64})(")/;
  const parsed: unknown = JSON.parse(sequencesText);
  const meta = isRecord(parsed) && isRecord(parsed["meta"]) ? parsed["meta"] : null;
  need(meta != null && meta["sha256"] === subset.sequencesSha256 && meta["hashConvention"] === HASH_CONVENTION && prefix.test(sequencesText)
    && sha256Hex(sequencesText.replace(prefix, (_, a: string, _h: string, c: string) => a + ZERO_HASH + c)) === subset.sequencesSha256, "o09Subset sequencesSha256");
  const sequences = isRecord(parsed) && Array.isArray(parsed["sequences"]) ? parsed["sequences"] : [];
  const o09 = sequences.find((q: unknown) => isRecord(q) && q["sequenceId"] === "O09");
  const positions = new Set(isRecord(o09) && Array.isArray(o09["steps"]) ? o09["steps"].flatMap((step: unknown) => isRecord(step) && typeof step["position"] === "number" ? [step["position"]] : []) : []);
  need(subset.sequenceId === "O09" && subset.positions.every((position) => positions.has(position)), "o09Subset positions must be steps of O09");
}

// P3 manifest の読み戻しの境界（AGENTS.md）: 形（型・必須の有無・key の集合・固定値）を確かめた値を項目ごとに組み立てる。全体を as で
// 言い換えると、型に項目を足したときに確かめの足し忘れをコンパイラが止められない。意味の検査（hash・継承・母集団ごとの規則）は
// verifyFrozenP3Manifest の need が行う。固定値の拒否の理由は verifyCommon と同じ文字列にする。
type Json = Record<string, unknown>;
function obj(v: unknown, what: string): Json {
  need(isRecord(v), `${what} must be an object`);
  return v;
}
// keys と同じ集合の key だけを持つ object（余分・不足は拒否）。
function exactKeys(v: unknown, keys: readonly string[], what: string): Json {
  const o = obj(v, what);
  need(Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k)), `${what} must have exactly ${keys.join(",")}`);
  return o;
}
function text(v: unknown, what: string): string {
  need(typeof v === "string", `${what} must be a string`);
  return v;
}
function count(v: unknown, what: string): number {
  need(typeof v === "number" && Number.isFinite(v), `${what} must be a finite number`);
  return v;
}
const countOrNull = (v: unknown, what: string): number | null => (v === null ? null : count(v, what));
const textOrNull = (v: unknown, what: string): string | null => (v === null ? null : text(v, what));
function list<T>(v: unknown, read: (x: unknown, what: string) => T, what: string): readonly T[] {
  need(Array.isArray(v), `${what} must be an array`);
  return v.map((x, i) => read(x, `${what}[${i}]`));
}
function oneOf<T extends string>(v: unknown, values: readonly T[], what: string): T {
  const found = values.find((x) => x === v);
  need(found != null, `${what} must be one of ${values.join("|")}`);
  return found;
}
function exactly<T extends string | number | boolean>(v: unknown, expected: T, message: string): T {
  need(v === expected, message);
  return expected;
}
function textRecord(v: unknown, what: string): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(obj(v, what)).map(([k, x]) => [k, text(x, `${what}.${k}`)]));
}
const LOADS = ["N", "P", "C"] as const;
const load = (v: unknown, what: string) => oneOf(v, LOADS, what);
function readLoad(v: unknown, what: string): EewMeasurementManifest["loads"]["N"] {
  const o = obj(v, what);
  return { id: load(o["id"], `${what}.id`), fixtureRefs: list(o["fixtureRefs"], text, `${what}.fixtureRefs`), ordering: list(o["ordering"], text, `${what}.ordering`),
    offsetsMs: list(o["offsetsMs"], count, `${what}.offsetsMs`), durationMs: count(o["durationMs"], `${what}.durationMs`), sha256: text(o["sha256"], `${what}.sha256`) };
}
function readForecast(v: unknown, what: string): NonNullable<P3EewPopulationCondition["forecast"]> {
  const o = obj(v, what);
  const allowed = obj(o["allowed"], `${what}.allowed`);
  return { subjects: count(o["subjects"], `${what}.subjects`), encodedBytes: count(o["encodedBytes"], `${what}.encodedBytes`),
    saveCondition: text(o["saveCondition"], `${what}.saveCondition`), deadlineCondition: text(o["deadlineCondition"], `${what}.deadlineCondition`),
    allowed: { maxSubjects: count(allowed["maxSubjects"], `${what}.allowed.maxSubjects`), maxEncodedBytes: count(allowed["maxEncodedBytes"], `${what}.allowed.maxEncodedBytes`) } };
}
// 種類の形だけを確かめる。母集団ごとの種類と固定値（1ms・0〜5ms・span の置き場所）は呼び出し側の need（理由 "establishment"）。
function readEstablishment(v: unknown, what: string): P3EewEstablishment {
  const o = obj(v, `${what}.establishment`);
  const kind = oneOf(o["kind"], ["none", "startOffset", "sentBeforeLargeFrameIngested"], `${what}.establishment.kind`);
  if (kind !== "startOffset") return { kind };
  const range = list(o["acceptedOffsetRangeMs"], count, `${what}.establishment.acceptedOffsetRangeMs`);
  return { kind, targetOffsetMs: exactly(o["targetOffsetMs"], 1, `${what} establishment`), acceptedOffsetRangeMs: [exactly(range[0], 0, `${what} establishment`),
    exactly(range[1], 5, `${what} establishment`)], span: oneOf(o["span"], ["population", "encodeThroughWrite"], `${what}.establishment.span`) };
}
function readCondition(v: unknown, what: string): P3EewPopulationCondition {
  const o = obj(v, what);
  const stop = obj(o["stopCondition"], `${what}.stopCondition`);
  return { scope: oneOf(o["scope"], ["formal", "reference"], `${what}.scope`), load: load(o["load"], `${what}.load`), periodMs: count(o["periodMs"], `${what}.periodMs`),
    trigger: text(o["trigger"], `${what}.trigger`), stateRef: text(o["stateRef"], `${what}.stateRef`), stateSha256: text(o["stateSha256"], `${what}.stateSha256`),
    establishment: readEstablishment(o["establishment"], what), origin: oneOf(o["origin"], ["T0", "injectorSend"], `${what}.origin`),
    forecast: o["forecast"] === null ? null : readForecast(o["forecast"], `${what}.forecast`),
    stopCondition: { maxAttempts: count(stop["maxAttempts"], `${what}.stopCondition.maxAttempts`), maxDurationMs: count(stop["maxDurationMs"], `${what}.stopCondition.maxDurationMs`) },
    triggerLeadMs: countOrNull(o["triggerLeadMs"], `${what}.triggerLeadMs`) };
}
function readAuxiliary(v: unknown, what: string): P3E01Manifest["auxiliary"]["E03"] {
  const o = obj(v, what);
  return { loads: list(o["loads"], load, `${what}.loads`), minSamplesPerRun: countOrNull(o["minSamplesPerRun"], `${what}.minSamplesPerRun`),
    runCount: countOrNull(o["runCount"], `${what}.runCount`), condition: text(o["condition"], `${what}.condition`),
    sharesWindowWith: textOrNull(o["sharesWindowWith"], `${what}.sharesWindowWith`), intervalMs: countOrNull(o["intervalMs"], `${what}.intervalMs`) };
}
function readP3Manifest(v: unknown): P3E01Manifest {
  const m = obj(v, "manifest");
  const health = obj(m["health"], "manifest.health");
  const chrome = obj(m["chrome"], "manifest.chrome");
  const viewport = list(chrome["viewportCssPx"], count, "manifest.chrome.viewportCssPx");
  need(viewport.length === 2, "manifest.chrome.viewportCssPx must be [width, height]");
  const probe = exactKeys(m["notificationProbe"], ["desktop", "sound"], "manifest.notificationProbe");
  const loads = exactKeys(m["loads"], LOADS, "manifest.loads");
  const populations = exactKeys(m["populations"], P3_POPULATIONS, "manifest.populations");
  const liveness = obj(m["liveness"], "manifest.liveness");
  const auxiliary = exactKeys(m["auxiliary"], ["E03", "E05", "E06", "E07", "E12", "E14", "E15", "ownerHeap"], "manifest.auxiliary");
  const machines = exactKeys(m["machines"], ["formal", "gate", "piBackend"], "manifest.machines");
  const places = exactKeys(m["judgmentPlaces"], ["E01", "E02", "E03", "E05", "E06", "E07", "E14", "E15"], "manifest.judgmentPlaces");
  const o09 = obj(m["o09Subset"], "manifest.o09Subset");
  const population = (key: P3EewPopulation) => readCondition(populations[key], `population ${key}`);
  const aux = (key: keyof P3E01Manifest["auxiliary"]) => readAuxiliary(auxiliary[key], `auxiliary ${key}`);
  const place = (key: keyof P3E01Manifest["judgmentPlaces"]) => text(places[key], `judgmentPlaces.${key}`);
  const probed = (key: "desktop" | "sound") => oneOf(probe[key], ["idle", "unavailable"], `notificationProbe.${key}`);
  const healthLoads = list(health["loads"], text, "manifest.health.loads");
  return {
    schemaVersion: exactly(m["schemaVersion"], "p3-e01-manifest-v1", "manifest schemaVersion"),
    manifestId: text(m["manifestId"], "manifestId"), manifestSha256: text(m["manifestSha256"], "manifestSha256"),
    contractSha256: textRecord(m["contractSha256"], "contractSha256"), trialSetupRef: text(m["trialSetupRef"], "trialSetupRef"),
    trialSetupSha256: text(m["trialSetupSha256"], "trialSetupSha256"), smokeConditionsSha256: text(m["smokeConditionsSha256"], "smokeConditionsSha256"),
    smokeConditionDifferences: list(m["smokeConditionDifferences"], text, "smokeConditionDifferences"),
    measuredSseClients: exactly(m["measuredSseClients"], 1, "manifest run counts"),
    notificationProbe: { desktop: probed("desktop"), sound: probed("sound") },
    loads: { N: readLoad(loads["N"], "load N"), P: readLoad(loads["P"], "load P"), C: readLoad(loads["C"], "load C") },
    warmupPerRun: exactly(m["warmupPerRun"], 100, "manifest run counts"), samplesPerRun: exactly(m["samplesPerRun"], 1000, "manifest run counts"),
    runCount: exactly(m["runCount"], 3, "manifest run counts"), missingAfterMs: exactly(m["missingAfterMs"], 10000, "manifest deadlines"),
    callbackDeadlineAfterInjectionMs: exactly(m["callbackDeadlineAfterInjectionMs"], 10000, "manifest deadlines"),
    quantile: exactly(m["quantile"], "nearestRank", "manifest clock/quantile"), clockProbeEveryMs: exactly(m["clockProbeEveryMs"], 30000, "manifest deadlines"),
    maxClockIntervalWidthMs: exactly(m["maxClockIntervalWidthMs"], 5, "manifest clock/quantile"),
    health: { loads: [exactly(healthLoads[0], "N", "health conditions"), exactly(healthLoads[1], "P", "health conditions")],
      requestEveryMs: exactly(health["requestEveryMs"], 1000, "health conditions"), requestTimeoutMs: count(health["requestTimeoutMs"], "health.requestTimeoutMs"),
      minSamplesPerRun: exactly(health["minSamplesPerRun"], 1000, "health conditions"), runCount: exactly(health["runCount"], 3, "health conditions") },
    chrome: { version: text(chrome["version"], "chrome.version"), foregroundTab: exactly(chrome["foregroundTab"], true, "chrome.foregroundTab must be true"),
      viewportCssPx: [viewport[0], viewport[1]], dpr: count(chrome["dpr"], "chrome.dpr"), motion: oneOf(chrome["motion"], ["reduced", "full"], "chrome.motion") },
    nodeVersion: text(m["nodeVersion"], "nodeVersion"), osVersion: text(m["osVersion"], "osVersion"), device: text(m["device"], "device"),
    geometrySha256: text(m["geometrySha256"], "geometrySha256"), fixtureSha256: textRecord(m["fixtureSha256"], "fixtureSha256"),
    inheritsManifestId: exactly(m["inheritsManifestId"], "a10-p2-20260930b", "inheritsManifestId does not name the inherited manifest"),
    populations: { fixedBacklog: population("fixedBacklog"), maxVpws50ParseStarted: population("maxVpws50ParseStarted"),
      maxWeatherCheckpointEncodeStarted: population("maxWeatherCheckpointEncodeStarted"), maxForecastCheckpointSave: population("maxForecastCheckpointSave"),
      forecastDeadlineOverlap: population("forecastDeadlineOverlap"), maxVpws50ReceivedThenEew: population("maxVpws50ReceivedThenEew") },
    liveness: { pingEveryMs: exactly(liveness["pingEveryMs"], 20000, "liveness"), maxFrameGapMs: exactly(liveness["maxFrameGapMs"], 90000, "liveness") },
    auxiliary: { E03: aux("E03"), E05: aux("E05"), E06: aux("E06"), E07: aux("E07"), E12: aux("E12"), E14: aux("E14"), E15: aux("E15"), ownerHeap: aux("ownerHeap") },
    machines: { formal: text(machines["formal"], "machines.formal"), gate: text(machines["gate"], "machines.gate"), piBackend: text(machines["piBackend"], "machines.piBackend") },
    judgmentPlaces: { E01: place("E01"), E02: place("E02"), E03: place("E03"), E05: place("E05"), E06: place("E06"), E07: place("E07"), E14: place("E14"), E15: place("E15") },
    o09Subset: { sequenceId: exactly(o09["sequenceId"], "O09", "o09Subset positions must be steps of O09"),
      sequencesSha256: text(o09["sequencesSha256"], "o09Subset.sequencesSha256"), positions: list(o09["positions"], count, "o09Subset.positions") },
  };
}

// P3-C4-AC10: P3 manifest の凍結境界。A10 と同じ照合（自己 hash・trialSetup・smoke・使用契約）に、継承する A10 の負荷・初期状態・fixture の
// hash の一致と、6 母集団の条件の形を足す。無いと、P2 の型（正式は fixedBacklog だけ）で 6 母集団を表せず、型の無い manifest で凍結する。
// 衝突母集団の scope・origin は P3-C4-COLLISION-VERDICT の 2 つの形（参考・T0 か、正式・injectorSend）だけを通す。
function verifyFrozenP3Manifest(input: Readonly<{
  manifestText: string;
  trialSetupText: string;
  smokeConditionsText: string;
  sequencesText: string;
  contractTexts: Readonly<Record<string, string>>;
  // 継承元: A10 の凍結 manifest と、その trialSetup が指す initial-state の保存 text。
  inherited: Readonly<{ manifestText: string; initialStateText: string }>;
}>): Readonly<{ manifest: P3E01Manifest; trialSetup: EewTrialSetup }> {
  const m = readP3Manifest(readSelfHashed(input.manifestText, "manifestSha256"));
  verifyCommon(m);
  // 継承元の A10 manifest は照合に使う項目だけを読む（loads は保存の形のまま文字列で比べる）。
  const a10 = obj(readSelfHashed(input.inherited.manifestText, "manifestSha256"), "inherited manifest");
  const a10Id = text(a10["manifestId"], "inherited manifestId");
  const a10Loads = obj(a10["loads"], "inherited loads");
  need(a10Id === m.inheritsManifestId, "inheritsManifestId does not name the inherited manifest");
  for (const id of ["N", "P", "C"] as const) need(JSON.stringify(m.loads[id]) === JSON.stringify(a10Loads[id]), `load ${id} differs from ${a10Id}`);
  need(m.trialSetupRef === a10["trialSetupRef"] && m.trialSetupSha256 === a10["trialSetupSha256"], `trialSetup differs from ${a10Id}`);
  need(Object.entries(textRecord(a10["fixtureSha256"], "inherited fixtureSha256")).every(([id, h]) => m.fixtureSha256[id] === h), `fixtureSha256 differs from ${a10Id}`);
  const t = verifyTrialSetup(m, input.trialSetupText);
  need(sha256Hex(input.inherited.initialStateText) === t.initialStateSha256, "initial-state sha256 differs from trialSetup.initialStateSha256");
  const states = obj(obj(JSON.parse(input.inherited.initialStateText), "initial-state")["populations"], "initial-state populations");
  verifySmokeAgainst(m, input.smokeConditionsText);
  need(Object.hasOwn(m.contractSha256, "P3-E01-REACCEPT-001"), "contractSha256 lacks P3-E01-REACCEPT-001");
  verifyContractHashes(m.contractSha256, input.contractTexts);

  need(Object.keys(m.populations).length === P3_POPULATIONS.length, "populations must be exactly the six");
  for (const key of P3_POPULATIONS) {
    const p = m.populations[key];
    need(p != null && Object.hasOwn(m.loads, p.load) && Number.isFinite(p.periodMs) && p.periodMs > 0 && nonEmpty(p.trigger), `population ${key}`);
    const state = /#populations\.(.+)$/.exec(p.stateRef)?.[1];
    need(p.stateRef === `${t.initialStateRef}#populations.${state}` && state != null && Object.hasOwn(states, state) && p.stateSha256 === t.initialStateSha256,
      `population ${key} state is not the inherited initial state`);
    const e = p.establishment;
    need(e.kind === P3_ESTABLISHMENT[key] && (e.kind !== "startOffset" || (e.targetOffsetMs === 1 && e.acceptedOffsetRangeMs[0] === 0 && e.acceptedOffsetRangeMs[1] === 5
      && (e.span === "population" || (e.span === "encodeThroughWrite" && key === "forecastDeadlineOverlap")))), `population ${key} establishment`);
    // P3-C4-AC13(1): lead は保存・期限回収の母集団だけ。
    need(LEAD_POPULATIONS.has(key) ? typeof p.triggerLeadMs === "number" && Number.isFinite(p.triggerLeadMs) && p.triggerLeadMs > 0 : p.triggerLeadMs === null,
      `population ${key} triggerLeadMs`);
    const scopeOrigin = `${p.scope}/${p.origin}`;
    need(key === "maxVpws50ReceivedThenEew" ? ["reference/T0", "formal/injectorSend"].includes(scopeOrigin) : scopeOrigin === "formal/T0", `population ${key} scope/origin`);
    need(key === "fixedBacklog" ? p.forecast != null && forecastWithinAllowance({ formal: { forecast: p.forecast } }, p.forecast)
      && nonEmpty(p.forecast.saveCondition) && nonEmpty(p.forecast.deadlineCondition) : p.forecast == null, `population ${key} forecast`);
    const s = p.stopCondition;
    need(Number.isInteger(s.maxAttempts) && s.maxAttempts >= m.warmupPerRun + m.samplesPerRun && Number.isFinite(s.maxDurationMs) && s.maxDurationMs > 0, `population ${key} stopCondition`);
  }
  need(m.liveness.pingEveryMs === 20000 && m.liveness.maxFrameGapMs === 90000, "liveness");
  for (const key of ["E03", "E05", "E06", "E07", "E12", "E14", "E15", "ownerHeap"] as const) {
    const a = m.auxiliary[key];
    need(a != null && nonEmpty(a.condition) && (a.sharesWindowWith == null || !/e01/i.test(a.sharesWindowWith)), `auxiliary ${key} (E01 windows are never shared)`);
    need(key === "E14" ? typeof a.intervalMs === "number" && a.intervalMs > 0 && (a.minSamplesPerRun ?? 0) > 0 && (a.minSamplesPerRun ?? 0) <= 512
      : a.intervalMs === null, `auxiliary ${key} intervalMs`);
  }
  verifyO09Subset(m.o09Subset, input.sequencesText);
  need((["formal", "gate", "piBackend"] as const).every((k) => nonEmpty(m.machines[k])), "machines");
  need((["E01", "E02", "E03", "E05", "E06", "E07", "E14", "E15"] as const).every((k) => nonEmpty(m.judgmentPlaces[k])), "judgmentPlaces");
  return { manifest: m, trialSetup: t };
}

// U-F の件数・byte が許容範囲を外れた試行は正式標本から除かず別条件として記録し、その run の正式 Pass を主張しない（AC01）。
// 試行ごとの観測は型に入力が無いので、run の Pass を落とす処理は runner が持つ。
function forecastWithinAllowance(
  manifest: Readonly<{ formal: Readonly<{ forecast: EewMeasurementManifest["formal"]["forecast"] }> }>,
  observed: Readonly<{ subjects: number; encodedBytes: number }>,
): boolean {
  const { maxSubjects, maxEncodedBytes } = manifest.formal.forecast.allowed;
  return observed.subjects <= maxSubjects && observed.encodedBytes <= maxEncodedBytes;
}

// A9 の marker は固定名 2 種だけ（AC14）。それ以外は拒否する。既知 field だけで組み直すので、候補時刻などの余計な field は落ちる（正式 T6 へ転記できない）。
const OPERATIONS: readonly Operation[] = ["normal", "training", "test"];
const isRecord = (v: unknown): v is Record<string, unknown> => v != null && typeof v === "object";

function displayVersionOf(v: unknown): DisplayVersion | null {
  return isRecord(v) && typeof v["streamId"] === "string" && typeof v["semanticRevision"] === "string" && typeof v["sequence"] === "number" && Number.isInteger(v["sequence"])
    ? { streamId: v["streamId"], semanticRevision: v["semanticRevision"], sequence: v["sequence"] }
    : null;
}

function parseChromeMarkerDetail(detail: unknown): ChromeEewMarkerDetail | null {
  if (!isRecord(detail)) return null;
  const displayVersion = displayVersionOf(detail["displayVersion"]);
  if (displayVersion == null) return null;
  if (detail["name"] === "fleq:p2:eew:T5") return { name: "fleq:p2:eew:T5", displayVersion };
  if (detail["name"] !== "fleq:p2:eew:T6-candidate") return null;
  const { subject, cardMarkerId, mapMarkerId, mapAreaCodes } = detail;
  const operation = OPERATIONS.find((o) => o === detail["operation"]);
  if (operation == null || typeof subject !== "string" || !nonEmpty(subject) || typeof cardMarkerId !== "string" || !nonEmpty(cardMarkerId) ||
    typeof mapMarkerId !== "string" || !nonEmpty(mapMarkerId) || !Array.isArray(mapAreaCodes) || !mapAreaCodes.every((c) => typeof c === "string")) return null;
  return { name: "fleq:p2:eew:T6-candidate", displayVersion, operation, subject, cardMarkerId, mapMarkerId, mapAreaCodes: mapAreaCodes.filter((c): c is string => typeof c === "string") };
}

export { ZERO_HASH, nonEmpty, REFERENCE_POPULATIONS, P3_POPULATIONS, verifyFrozenP3Manifest, sha256Hex, readSelfHashed, sealSelfHash, verifyChromeSmokeConditions, verifyFrozenManifest, forecastWithinAllowance, parseChromeMarkerDetail };
