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
import type { P3E01Manifest, P3EewEstablishment, P3EewPopulation } from "../../../contracts/p3-e01-reaccept.types";

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
const P3_ESTABLISHMENT: Readonly<Record<P3EewPopulation, P3EewEstablishment["kind"]>> = {
  fixedBacklog: "none", maxVpws50ParseStarted: "startOffset", maxWeatherCheckpointEncodeStarted: "startOffset",
  maxForecastCheckpointSave: "startOffset", forecastDeadlineOverlap: "startOffset", maxVpws50ReceivedThenEew: "sentBeforeLargeFrameIngested",
};

// P3-C4-AC10: P3 manifest の凍結境界。A10 と同じ照合（自己 hash・trialSetup・smoke・使用契約）に、継承する A10 の負荷・初期状態・fixture の
// hash の一致と、6 母集団の条件の形を足す。無いと、P2 の型（正式は fixedBacklog だけ）で 6 母集団を表せず、型の無い manifest で凍結する。
// 衝突母集団の scope・origin は P3-C4-COLLISION-VERDICT の 2 つの形（参考・T0 か、正式・injectorSend）だけを通す。
function verifyFrozenP3Manifest(input: Readonly<{
  manifestText: string;
  trialSetupText: string;
  smokeConditionsText: string;
  contractTexts: Readonly<Record<string, string>>;
  // 継承元: A10 の凍結 manifest と、その trialSetup が指す initial-state の保存 text。
  inherited: Readonly<{ manifestText: string; initialStateText: string }>;
}>): Readonly<{ manifest: P3E01Manifest; trialSetup: EewTrialSetup }> {
  const m = readSelfHashed(input.manifestText, "manifestSha256") as P3E01Manifest;
  need(m.schemaVersion === "p3-e01-manifest-v1", "manifest schemaVersion");
  verifyCommon(m);
  const a10 = readSelfHashed(input.inherited.manifestText, "manifestSha256") as EewMeasurementManifest;
  need(a10.manifestId === m.inheritsManifestId, "inheritsManifestId does not name the inherited manifest");
  for (const id of ["N", "P", "C"] as const) need(JSON.stringify(m.loads[id]) === JSON.stringify(a10.loads[id]), `load ${id} differs from ${a10.manifestId}`);
  need(m.trialSetupRef === a10.trialSetupRef && m.trialSetupSha256 === a10.trialSetupSha256, `trialSetup differs from ${a10.manifestId}`);
  need(Object.entries(a10.fixtureSha256).every(([id, h]) => m.fixtureSha256[id] === h), `fixtureSha256 differs from ${a10.manifestId}`);
  const t = verifyTrialSetup(m, input.trialSetupText);
  need(sha256Hex(input.inherited.initialStateText) === t.initialStateSha256, "initial-state sha256 differs from trialSetup.initialStateSha256");
  const states = (JSON.parse(input.inherited.initialStateText) as { populations: Record<string, unknown> }).populations;
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
    need(e.kind === P3_ESTABLISHMENT[key] && (e.kind !== "startOffset" || (e.targetOffsetMs === 1 && e.acceptedOffsetRangeMs[0] === 0 && e.acceptedOffsetRangeMs[1] === 5)),
      `population ${key} establishment`);
    const scopeOrigin = `${p.scope}/${p.origin}`;
    need(key === "maxVpws50ReceivedThenEew" ? ["reference/T0", "formal/injectorSend"].includes(scopeOrigin) : scopeOrigin === "formal/T0", `population ${key} scope/origin`);
    need(key === "fixedBacklog" ? p.forecast != null && forecastWithinAllowance({ formal: { forecast: p.forecast } }, p.forecast)
      && nonEmpty(p.forecast.saveCondition) && nonEmpty(p.forecast.deadlineCondition) : p.forecast == null, `population ${key} forecast`);
    const s = p.stopCondition;
    need(Number.isInteger(s.maxAttempts) && s.maxAttempts >= m.warmupPerRun + m.samplesPerRun && Number.isFinite(s.maxDurationMs) && s.maxDurationMs > 0, `population ${key} stopCondition`);
  }
  need(m.liveness.pingEveryMs === 20000 && m.liveness.maxFrameGapMs === 90000, "liveness");
  for (const key of ["E03", "E05", "E06", "E07", "E12", "E15"] as const) {
    const a = m.auxiliary[key];
    need(a != null && nonEmpty(a.condition) && (a.sharesWindowWith == null || !/e01/i.test(a.sharesWindowWith)), `auxiliary ${key} (E01 windows are never shared)`);
  }
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
