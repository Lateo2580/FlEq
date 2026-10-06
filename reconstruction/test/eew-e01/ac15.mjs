// A10 WP3c U4（P2-A10-AC15）: probe-preload の stringify 記録（FLEQ_STRINGIFY_OUT）を受信 1 回ごとの区間へ振り分けて判定する。
// 規則（統合担当の決定: key 集合の指紋）。区間 = その入力の T0 から次の入力の T0 まで（host の performance.now）。
//   Fail（p2-snapshot-sse.json:99-100、p2-checkpoint-shutdown.json:382 E10）:
//     RuntimeState・UnitState・unit の集まりの全体／checkpoint 区間の外で入力の unit 以外の要素・保存 payload／
//     checkpoint 区間の外の自 unit の保存 payload／他 unit の入力が起こした保存（attempt の inputIds、区間に関係なく）／
//     EEW・U-W の区間で自 unit の要素が上限超え／checkpoint 区間の外の自 unit の要素の配列で 2 件を超えるもの（集合の全量）／
//     保持量 full と half で checkpoint 区間外の直列化の回数が保持 1 件あたり 0.5 回を超えて増える（compareRetention）
//   未確認: U-F の区間で自 unit の要素が上限超え／要素数の分からない自 unit の要素の配列／checkpoint 区間の外の ambiguous の配列で
//     2 件を超えるもの／指紋表の取りこぼしの疑い（U-W の履歴 entry が無いなど）
//   報告: checkpoint 区間の中の payload・要素（持ち越しの保存を含む）・envelope・配送 snapshot・その他（台帳 49 の例外を含む）
// 指紋表は充填後に保存された各 unit の checkpoint と配送 snapshot の view から実行時に作る（固定の key 一覧を持たない）。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import judge from "../../dist/src/measurement/eew-e01/judge.js";
import { executionPlaces } from "../../dist/src/runtime/unit-coverage.js";

const { quantiles } = judge;
const UNITS = ["U-E", "U-W", "U-F"];
// 実行中の *UnitState = 保存 payload の key ＋ この 2 つ（p2-eew-unit / p2-weather-current-unit / p2-weather-timeseries-unit の types）。
// 無いと、保存 payload（checkpoint 経路で必ず直列化される）と実行中 state の全量を区別できない。
const RUNTIME_ONLY_KEYS = ["contentRevision", "persistence"];
// RuntimeState（p2-shared-runtime.types.ts:376-389）の特徴の key。全部を持つ形は state 全体（変更検出の全量 stringify・JSON roundtrip）。
const RUNTIME_STATE_KEYS = ["units", "views", "restoration"];
// 自 unit の要素（checkpoint 区間の外）の上限 = (1 + 明示の退去件数) × before/after の 2 × 係数 2。係数 = subject 1 件が持つ要素の形の数
// （U-F は subject と gate、U-W は snapshot と history）。退去件数は P2HostObservation（p2-eew-e01.types.ts:103-109）に
// displayChanges・outcome が無いので観測できない。EEW（同じ EventID の Serial を進める）と U-W（同じ官署の時刻を進める）は入力規則の上で
// 退去 0 なので超過は Fail。U-F は期限回収・保持期限の削除が副作用の退去になりうるので、U-F の区間の超過だけ未確認にする。
const OWN_ELEMENT_LIMIT = (1 + 0) * 2 * 2;
const EVICTION_UNOBSERVABLE_UNITS = ["U-F"];
// 1 回の直列化で単件計量とみなす要素の配列の長さ（当該 subject の before/after）。これを超える配列は集合の全量（p2-snapshot-sse.json:100）。
// 無いと、state.current 相当の配列全体の直列化が要素 1 回と数えられて Pass になる。
const OWN_ELEMENT_PAIR = 2;
const FAILING = ["runtimeState", "unitState", "unitCollection", "foreignElement", "foreignPayload", "payloadOutsideCheckpoint", "ownElementCollection"];
// 未確認に倒す形: 要素数の分からない自 unit の要素の配列と、checkpoint 区間の外の ambiguous の配列で 2 件を超えるもの・要素数の分からないもの
// （unit を決められない集合の全量。intents の上限計量 eew-unit.ts:90 も同じ形になりうるので Fail にしない）。
const UNSURE = ["ownElementLengthUnknown", "ambiguousCollection", "otherArrayLengthUnknown"];
// 指紋表を作る時点で要素が 1 つも無いと、その形を分類できない payload の field。無いと、U-W の履歴 entry の直列化が「その他」に落ちる。
const REQUIRED_ELEMENT_FIELDS = [["U-W", "histories"]];
// 保持量の対照（compareRetention）で比べる、checkpoint 区間の外の入力 1 件あたりの回数。
const RETENTION_MEASURES = ["outsideOtherPerInput", "outsidePrimitivePerInput", "outsideOwnElementPerInput", "outsideAmbiguousPerInput"];

const canon = (keys) => [...new Set(keys)].filter((key) => key !== "").sort().join(",");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// 値の中の要素（配列の要素と、object 値の object 子）の指紋。
const childFingerprints = (value) => (Array.isArray(value) ? value : isObject(value) ? Object.values(value) : [])
  .filter(isObject).map((child) => canon(Object.keys(child)));

// state directory の U-*-{A,B}.json から unit ごとに世代の新しい envelope を 1 つ読む。
export function readLatestEnvelopes(stateDirectory) {
  const latest = {};
  for (const name of readdirSync(stateDirectory)) {
    const match = /^(U-[EWF])-[AB]\.json$/.exec(name);
    if (match == null) continue;
    const envelope = JSON.parse(readFileSync(join(stateDirectory, name), "utf8"));
    if (latest[match[1]] == null || envelope.generation > latest[match[1]].generation) latest[match[1]] = envelope;
  }
  return Object.values(latest);
}

// 指紋表（JSON にそのまま書ける形）。要素 = 保存 payload の各 field の要素 ＋ 配送 snapshot の full view の各 field の要素
// （view-projector.ts:166・:191・:239 が計量する形。U-E の current は payload に無いのでここで補う）。
// snapshots は 1 つか配列。保持上限では view が summary に落ちるので、full の view が残る充填途中の snapshot も渡せる。
// ambiguous = 複数 unit に出る指紋と、複数 unit に同じ名前で出る field（payload の intents、view の subjects など）の要素の指紋
// （中身の有無に関係なく。payload と view は別々に数える）。
export function fingerprintTable(envelopes, snapshots) {
  const list = Array.isArray(snapshots) ? snapshots : [snapshots];
  const unitState = {};
  const payload = {};
  const viewUnits = new Set();
  // [unit, field 名, 値] の並び。source ごとに field 名を共有する unit を数える。
  const fields = { payload: [], view: [] };
  for (const envelope of envelopes) {
    const keys = Object.keys(envelope.payload);
    unitState[envelope.unit] = canon([...keys, ...RUNTIME_ONLY_KEYS]);
    payload[envelope.unit] = canon(keys);
    for (const [key, value] of Object.entries(envelope.payload)) fields.payload.push([envelope.unit, key, value]);
  }
  for (const snapshot of list) {
    for (const domain of Object.values(snapshot.current ?? {})) {
      if (domain?.delivery !== "full") continue;
      viewUnits.add(domain.unit);
      for (const [key, value] of Object.entries(domain.view)) fields.view.push([domain.unit, key, value]);
    }
  }
  const owners = new Map();
  const shared = new Set();
  for (const rows of Object.values(fields)) {
    const fieldUnits = new Map();
    for (const [unit, key] of rows) fieldUnits.set(key, (fieldUnits.get(key) ?? new Set()).add(unit));
    for (const [unit, key, value] of rows) {
      for (const fp of childFingerprints(value)) {
        if (fieldUnits.get(key).size > 1) shared.add(fp);
        else owners.set(fp, (owners.get(fp) ?? new Set()).add(unit));
      }
    }
  }
  const elements = {};
  const ambiguous = [...shared];
  for (const [fp, units] of owners) {
    if (shared.has(fp)) continue;
    if (units.size === 1) elements[fp] = [...units][0];
    else ambiguous.push(fp);
  }
  const emptyRequiredFields = REQUIRED_ELEMENT_FIELDS.filter(([unit, field]) => !fields.payload.some(([u, key, value]) => u === unit && key === field
    && childFingerprints(value).length > 0)).map(([unit, field]) => `${unit}.${field}`);
  return { unitState, runtimeState: canon(RUNTIME_STATE_KEYS), unitCollection: canon(UNITS), payload,
    envelope: envelopes.length === 0 ? null : canon(Object.keys(envelopes[0])), snapshot: canon(Object.keys(list[0])),
    viewUnits: [...viewUnits].sort(), elements, ambiguous, emptyRequiredFields };
}

// 生の指紋 → { category, unit, fp, array, length }。配列は probe が "[<要素数>]" ＋ 先頭要素の key で書く。要素数の無い "[" は
// 要素数を持たない旧 probe の配列（length = null。判別できない）。区別の順: 全体（superset）→ envelope → snapshot → 保存 payload → 要素 → ambiguous → その他。
function classifier(table) {
  const supersetOf = (keys, required) => required.split(",").every((key) => keys.has(key));
  const memo = new Map();
  return (raw) => {
    let found = memo.get(raw);
    if (found != null) return found;
    const sized = /^\[(\d+)\]/.exec(raw);
    const prefix = sized?.[0] ?? (raw.startsWith("[") ? "[" : "");
    const fp = canon(raw.slice(prefix.length).split(","));
    const keys = new Set(fp.split(","));
    const whole = Object.entries(table.unitState).find(([, required]) => supersetOf(keys, required));
    const payload = Object.entries(table.payload).find(([, value]) => value === fp);
    const [category, unit] = supersetOf(keys, table.runtimeState) ? ["runtimeState", null]
      : whole != null ? ["unitState", whole[0]]
      : supersetOf(keys, table.unitCollection) ? ["unitCollection", null]
      : fp === table.envelope ? ["envelope", null]
      : fp === table.snapshot ? ["snapshot", null]
      : payload != null ? ["payload", payload[0]]
      : table.elements[fp] != null ? ["element", table.elements[fp]]
      : table.ambiguous.includes(fp) ? ["ambiguous", null]
      : ["other", null];
    found = { category, unit, fp, array: prefix !== "", length: sized == null ? null : Number(sized[1]) };
    memo.set(raw, found);
    return found;
  };
}

// host の JSON Lines（{"t":"obs",...}）から区間を作る。obs は発生順に並ぶので、publishSerialization（時刻を持たない）は直前の T0 の区間に入れる。
// unitOf: 測る inputId → "U-E"|"U-W"|"U-F"（warm-up を含めない）。最後の区間の終わりは endMs。
export function ac15Intervals(hostRecords, unitOf, { endMs = Infinity } = {}) {
  const all = [];
  const byInput = new Map();
  for (const record of hostRecords) {
    if (record.t !== "obs") continue;
    const o = record.o;
    if (o.kind === "marker" && o.point === "T0" && o.inputId != null) {
      if (all.length > 0) all.at(-1).endMs = o.monotonicMs;
      const interval = { inputId: o.inputId, unit: unitOf.get(o.inputId) ?? null, startMs: o.monotonicMs, endMs, processingMs: null, publishCount: 0 };
      all.push(interval);
      byInput.set(o.inputId, interval);
    } else if (o.kind === "publishSerialization" && all.length > 0) all.at(-1).publishCount++;
    else if (o.kind === "processing" && byInput.has(o.measurement.inputId)) {
      byInput.get(o.measurement.inputId).processingMs = o.measurement.endedMonotonicMs - o.measurement.startedMonotonicMs;
    }
  }
  return all.filter((interval) => interval.unit != null);
}

// host の checkpoint 観測から checkpoint 経路の区間を作る。attempt ごとに encode・verify の段と、encode の終わりから次の段の始まりまで
// （kind "gap"。checkpoint.ts:266-300 の restoreUnit/latestValidSlot の decode は段として測られない）。gap は checkpoint.ts:302 の
// await の間に別の入力が入りうるので、その中に T0 があれば最初の T0 で切る。retry の attempt（retryReason ≠ notRetry）には
// 全段を覆う "retrySpan" を足す（判定の区間には使わず、Fail の理由の手がかりにだけ使う。retained の保存は encode が測られない: checkpoint.ts:225）。
export function checkpointWindows(hostRecords) {
  const attempts = new Map();
  const t0s = [];
  for (const record of hostRecords) {
    if (record.t !== "obs") continue;
    const o = record.o;
    if (o.kind === "marker" && o.point === "T0") t0s.push(o.monotonicMs);
    if (o.kind !== "checkpoint") continue;
    const key = `${o.measurement.runId}\u0000${o.measurement.attemptId}`;
    if (!attempts.has(key)) attempts.set(key, []);
    attempts.get(key).push(o.measurement);
  }
  const windows = [];
  for (const stages of attempts.values()) {
    const { unit, attemptId, inputIds, retryReason } = stages[0];
    const window = (kind, fromMs, toMs) => windows.push({ kind, unit, attemptId, inputIds, retryReason, fromMs, toMs });
    for (const m of stages) if (m.stage === "encode" || m.stage === "verify") window(m.stage, m.startedMonotonicMs, m.endedMonotonicMs);
    const encode = stages.find((m) => m.stage === "encode");
    const next = stages.filter((m) => m.stage !== "encode").map((m) => m.startedMonotonicMs);
    if (encode != null && next.length > 0) {
      const toMs = Math.min(...next);
      window("gap", encode.endedMonotonicMs, t0s.find((t) => t > encode.endedMonotonicMs && t < toMs) ?? toMs);
    }
    if (retryReason !== "notRetry") {
      window("retrySpan", Math.min(...stages.map((m) => m.startedMonotonicMs)), Math.max(...stages.map((m) => m.endedMonotonicMs)));
    }
  }
  return windows;
}

const tally = () => ({ count: 0, ms: 0, chars: 0, maxChars: 0 });
const add = (t, row) => { t.count++; t.ms += row[1]; t.chars += row[2]; t.maxChars = Math.max(t.maxChars, row[2]); };

// probeRecords: probe の行（配列）。intervals: ac15Intervals の返り値（startMs 昇順・重ならない）。checkpointWindows: 同名関数の返り値
// （渡さなければ保存 payload の直列化はすべて区間外として Fail）。unitOfInput: 測定で流した全入力（warm-up を含む）の inputId → unit。
// owner の probe の完全性（P3-C4 工程2d）: owner ごとの最後に書いた時刻（probe-preload の .written、無ければ null）が窓の終わりより前なら、
// その owner の直列化の行が欠けうる。欠けうる owner の place を返す（空なら完全）。
export const AC15_OWNERS = ["urgent", "weatherCurrent", "deferred"];
export function ownerProbeIncomplete(writtenAt, endMs) {
  return AC15_OWNERS.filter((place) => !(typeof writtenAt[place] === "number" && writtenAt[place] >= endMs));
}

export function judgeAc15(probeRecords, intervals, table, { checkpointWindows: windows = [], unitOfInput = null, ownElementLimit = OWN_ELEMENT_LIMIT,
  minInputsPerUnit = 100 } = {}) {
  const classify = classifier(table);
  const inputUnit = unitOfInput ?? new Map(intervals.map((interval) => [interval.inputId, interval.unit]));
  const perInterval = intervals.map(() => ({ rows: [] }));
  for (const row of probeRecords) {
    let lo = 0;
    let hi = intervals.length - 1;
    while (lo <= hi) { // startMs <= row[0] の最後の区間
      const mid = (lo + hi) >> 1;
      if (intervals[mid].startMs <= row[0]) lo = mid + 1; else hi = mid - 1;
    }
    if (hi >= 0 && row[0] < intervals[hi].endMs) perInterval[hi].rows.push(row);
  }

  const violations = [];
  const unconfirmed = [];
  const scenarios = {};
  const stacks = new Map();
  intervals.forEach((interval, i) => {
    const s = (scenarios[interval.unit] ??= { inputs: 0, runtimeState: tally(), unitState: tally(), unitCollection: tally(), foreignElement: tally(),
      ownElement: tally(), ownElementCollection: tally(), ownElementLengthUnknown: tally(), ownElementMaxPerInput: 0, checkpointElement: {}, ambiguous: tally(),
      ambiguousCollection: tally(), envelope: tally(), checkpointPayload: {}, foreignPayload: tally(), payloadOutsideCheckpoint: tally(), snapshot: tally(), publishCount: 0,
      snapshotCallsMinusPublish: 0, other: {}, outsideOtherPerInput: [], outsidePrimitivePerInput: [], outsideOwnElementPerInput: [], outsideAmbiguousPerInput: [],
      processingMs: [], stringifyMs: [] });
    s.inputs++;
    // この区間に掛かる checkpoint 区間だけを見る（行ごとに全区間を走査しない）。
    const local = windows.filter((w) => w.toMs >= interval.startMs && w.fromMs < interval.endMs);
    // 保存の区間で除外するのは、行と同じ実行場所（その unit の owner）の保存だけ（P3-C4 工程2d）。publisher の直列化が owner の encode と
    // 時刻で重なっても保存経路ではない。実行場所の無い行（A10 の単一 thread の記録）は従来どおり時刻と unit だけで見る。
    const saving = (unit, at, place) => local.filter((w) => w.kind !== "retrySpan" && (unit == null || w.unit === unit)
      && (place == null || executionPlaces[w.unit] === place) && w.fromMs <= at && at <= w.toMs);
    const counts = new Map();
    const unsure = new Map();
    let outsideOther = 0;
    let outsidePrimitive = 0;
    let outsideAmbiguous = 0;
    const fail = (category, unit, fp, length) => {
      const key = JSON.stringify([category, unit, fp]);
      const prev = counts.get(key) ?? { count: 0, maxLength: null };
      counts.set(key, { count: prev.count + 1, maxLength: length == null ? prev.maxLength : Math.max(prev.maxLength ?? 0, length) });
    };
    const ownByFingerprint = {};
    let snapshots = 0;
    let ownElements = 0;
    let stringifyMs = 0;
    for (const row of perInterval[i].rows) {
      const c = classify(row[3]);
      stringifyMs += row[1];
      let category = c.category;
      if (category === "element" || category === "payload") {
        // checkpoint 区間の判定を unit に関係なく先に行う（持ち越しの保存は報告。どの入力が起こした保存かは下の attempt 判定が見る）。
        const own = c.unit === interval.unit;
        if (saving(c.unit, row[0], row[5]).length > 0) category = category === "payload" ? "checkpointPayload" : "checkpointElement";
        else if (category === "payload") category = own ? "payloadOutsideCheckpoint" : "foreignPayload";
        else category = own ? "ownElement" : "foreignElement";
      }
      // 自 unit の要素の配列: 2 件までは単件計量として要素数ぶん数え、超えれば集合の全量（Fail）、要素数が分からなければ未確認。
      let elements = 1;
      if (category === "ownElement" && c.array) {
        if (c.length == null) category = "ownElementLengthUnknown";
        else if (c.length > OWN_ELEMENT_PAIR) category = "ownElementCollection";
        else elements = c.length;
      }
      if (category === "ambiguous" && c.array && (c.length == null || c.length > OWN_ELEMENT_PAIR) && saving(null, row[0], row[5]).length === 0) category = "ambiguousCollection";
      // 保持量の対照（compareRetention）の材料: どの unit の checkpoint 区間の外のその他と原始値の回数。配列は要素数で数える
      // （無いと、Object.keys(state.ownership) のような原始値の配列全体の直列化が保持量に関係なく 1 回になる）。要素数が無ければ未確認。
      if (category === "other" && saving(null, row[0], row[5]).length === 0) {
        if (c.array && c.length == null) category = "otherArrayLengthUnknown";
        else if (c.fp.startsWith("#")) outsidePrimitive += c.array ? c.length : 1;
        else outsideOther += c.array ? c.length : 1;
      }
      if (category === "ambiguous" && !c.array && saving(null, row[0], row[5]).length === 0) outsideAmbiguous++;
      if (category === "checkpointPayload" || category === "checkpointElement") add((s[category][c.unit] ??= tally()), row);
      else if (category === "other" || category === "otherArrayLengthUnknown") add((s.other[c.fp] ??= tally()), row);
      else add(s[category], row);
      if (category === "snapshot") snapshots++;
      if (category === "ownElement") {
        ownElements += elements;
        ownByFingerprint[c.fp] = (ownByFingerprint[c.fp] ?? 0) + elements;
      }
      if (UNSURE.includes(category)) { const key = JSON.stringify([category, c.fp]); unsure.set(key, (unsure.get(key) ?? 0) + 1); }
      if (FAILING.includes(category)) fail(category, c.unit, c.fp, c.length);
      if (row[4] != null) {
        const key = JSON.stringify([category, c.unit, row[4]]);
        stacks.set(key, (stacks.get(key) ?? 0) + 1);
      }
    }
    const retriesOf = (unit) => [...new Set(local.filter((w) => w.unit === unit && w.retryReason !== "notRetry").map((w) => w.attemptId))];
    if (ownElements > ownElementLimit) {
      const excess = { inputId: interval.inputId, inputUnit: interval.unit, category: "ownElementExcess", fingerprintUnit: interval.unit, fingerprint: null,
        count: ownElements, limit: ownElementLimit, excess: ownElements - ownElementLimit, byFingerprint: ownByFingerprint,
        retryAttemptsNearby: retriesOf(interval.unit) };
      (EVICTION_UNOBSERVABLE_UNITS.includes(interval.unit) ? unconfirmed : violations).push(excess);
    }
    s.ownElementMaxPerInput = Math.max(s.ownElementMaxPerInput, ownElements);
    for (const [key, { count, maxLength }] of counts) {
      const [category, unit, fingerprint] = JSON.parse(key);
      violations.push({ inputId: interval.inputId, inputUnit: interval.unit, category, fingerprintUnit: unit, fingerprint, count,
        ...(maxLength == null ? {} : { maxLength }), retryAttemptsNearby: unit == null ? [] : retriesOf(unit) });
    }
    for (const [key, count] of unsure) {
      const [category, fingerprint] = JSON.parse(key);
      unconfirmed.push({ inputId: interval.inputId, inputUnit: interval.unit, category, fingerprintUnit: category === "ownElementLengthUnknown" ? interval.unit : null,
        fingerprint, count, retryAttemptsNearby: [] });
    }
    s.outsideOtherPerInput.push(outsideOther);
    s.outsidePrimitivePerInput.push(outsidePrimitive);
    s.outsideOwnElementPerInput.push(ownElements);
    s.outsideAmbiguousPerInput.push(outsideAmbiguous);
    s.publishCount += interval.publishCount;
    s.snapshotCallsMinusPublish += snapshots - interval.publishCount;
    if (interval.processingMs != null) s.processingMs.push(interval.processingMs);
    s.stringifyMs.push(stringifyMs);
  });
  for (const s of Object.values(scenarios)) {
    s.processingMs = quantiles(s.processingMs);
    s.stringifyMs = quantiles(s.stringifyMs);
    for (const measure of RETENTION_MEASURES) s[measure] = quantiles(s[measure]);
    s.other = Object.entries(s.other).map(([fingerprint, t]) => ({ fingerprint, ...t })).sort((a, b) => b.ms - a.ms);
  }

  // E10: 他 unit の入力が起こした保存（attempt の inputIds に保存の unit と違う unit の入力がある）は、区間・直列化の有無に関係なく Fail。
  // driveCheckpoint は 1 tick 1 unit なので、起こした入力の区間の後へずれうる（composition-root.ts:531-551、checkpoint.ts:194-195）。
  const judgedAttempts = new Set();
  for (const w of windows) {
    if (judgedAttempts.has(w.attemptId)) continue;
    judgedAttempts.add(w.attemptId);
    for (const id of w.inputIds) {
      const unit = inputUnit.get(id);
      if (unit == null || unit === w.unit) continue;
      violations.push({ inputId: id, inputUnit: unit, category: "foreignSaveByInput", fingerprintUnit: w.unit, fingerprint: null, count: 1,
        attemptId: w.attemptId, retryAttemptsNearby: w.retryReason === "notRetry" ? [] : [w.attemptId] });
    }
  }

  const missing = [];
  if (probeRecords.length === 0) missing.push("probeRecordsEmpty");
  for (const unit of UNITS) {
    if (table.unitState[unit] == null) missing.push(`fingerprintTableLacks:${unit}`);
    if (!table.viewUnits.includes(unit)) missing.push(`fingerprintTableLacksView:${unit}`);
    if ((scenarios[unit]?.inputs ?? 0) < minInputsPerUnit) missing.push(`inputsBelow${minInputsPerUnit}:${unit}`);
    // 入力の subject 自身の要素が 1 回も見えない unit は、指紋表が実物の形と合っていない疑い。
    if (scenarios[unit] != null && scenarios[unit].ownElementMaxPerInput === 0) missing.push(`ownElementsNeverSeen:${unit}`);
  }
  if (unconfirmed.some((u) => u.category === "ownElementExcess")) missing.push("ownElementExcess:U-F(evictionsUnobservable)");
  for (const category of UNSURE) if (unconfirmed.some((u) => u.category === category)) missing.push(category);
  for (const field of table.emptyRequiredFields) missing.push(`fingerprintTableLacksElements:${field}`);
  const gaps = windows.filter((w) => w.kind === "gap").map((w) => w.toMs - w.fromMs);
  const status = violations.length > 0 ? "Fail" : missing.length > 0 ? "未確認" : "Pass";
  return { status, violations, unconfirmed, missing, scenarios, checkpointGapMaxMs: gaps.length === 0 ? null : Math.max(...gaps),
    largeCallStacks: [...stacks].map(([key, count]) => { const [category, unit, stack] = JSON.parse(key); return { category, unit, stack, count }; }),
    notes: [
      `指紋は引数の最上位の key 集合（配列は先頭要素の key と要素数）。checkpoint 区間の外の自 unit の要素の配列は ${OWN_ELEMENT_PAIR} 件まで単件計量（before/after）として要素数ぶん数え、超えれば集合の全量で Fail（ownElementCollection、maxLength）、要素数の無い配列は未確認（ownElementLengthUnknown）`,
      "key が 3 つ程度の小さな形は、無関係なオブジェクトと指紋がぶつかりうる（例: snapshot.persistence は unit id を key に持ち unitCollection と同形）",
      `複数 unit に出る要素の指紋と、複数 unit に同名で出る field（payload の intents、view の subjects など）の要素の指紋は ambiguous として報告だけにする。ただし checkpoint 区間の外の ambiguous の配列で ${OWN_ELEMENT_PAIR} 件を超えるもの・要素数の無いものは未確認（ambiguousCollection）`,
      "走査対象が当該 subject だけであることは、checkpoint 区間の外の直列化（その他・原始値・自 unit の要素・ambiguous の単件）の入力 1 件あたりの回数を保持量 full と half で比べ、保持 1 件あたりの傾きで確かめる（compareRetention）",
      "保存 payload と要素は、その unit の checkpoint の encode・verify 段と encode 後の未計測区間（checkpoint.ts:266-300、次の T0 で切る）の中なら、入力の unit に関係なく報告だけ（持ち越しの保存）。他 unit の入力が起こした保存は attempt の inputIds で区間に関係なく Fail（E10）。envelope は報告のみ",
      `自 unit の要素は checkpoint 区間の外で入力 1 件あたり ${ownElementLimit} 回まで（(1+退去件数)×2×2、退去件数は観測できず 0）。EEW・U-W は入力規則の上で退去 0 なので超過は Fail`,
      "限界: probe は JSON.stringify しか見ないので、直列化しない走査（filter・find など）は見えない。保持の一部だけの走査（半分未満）は保持 1 件あたりの傾きが 0.5 未満になり、対照を通りうる",
      "U-F の区間の超過だけ未確認（unconfirmed）: 期限回収・保持期限の削除が副作用の退去になりうるが、観測口（P2HostObservation）に退去が無い",
      "chars は UTF-16 の文字数（byte ではない）。publish の byte は publishSerialization を見る",
      "配送 snapshot の指紋は view-projector.ts:677 の shell の byte 計量（同じ key 集合）にも当たる。snapshotCallsMinusPublish は publish 以外の同形の呼出し数で、client ごとの再直列化があればここが増える",
    ] };
}

// P2-A10-AC15 の保持量の対照（p2-snapshot-sse.json:100「当該 subject の before/after だけ」）: 同じシナリオを full と half の充填から回した
// judgeAc15 の結果を比べる。measure ごとに slope = (full の中央値 − half の中央値) / ΔN（ΔN = 3 unit の保持件数の差の最小。シナリオの
// unit の差で割ると、保持の差が大きい別 unit の走査が薄まって通るため）。slope > maxSlope なら Fail（走査対象が保持量に比例）。ただし差が雑音の床（2 回の実走それぞれの p95 − p50 の大きい方）
// 以下なら Fail でなく未確認（unresolved。ばらつきは保持量に依存しない証拠にならない）。中央値か ΔN が無ければ未確認。比ではなく傾きにするのは、入力 1 件ごとの大きな定数に線形成分が埋もれるため。
// retained = { full, half } は unit → 保持件数（fill の observed から）。
export function compareRetention(full, half, { maxSlope, retained }) {
  const deltaRetained = Math.min(...UNITS.map((unit) => (retained.full[unit] ?? NaN) - (retained.half[unit] ?? NaN)));
  const rows = [];
  for (const scenario of new Set([...Object.keys(full.scenarios), ...Object.keys(half.scenarios)])) {
    for (const measure of RETENTION_MEASURES) {
      const [f, h] = [full.scenarios[scenario]?.[measure], half.scenarios[scenario]?.[measure]];
      const known = f != null && h != null && deltaRetained > 0;
      const difference = known ? f.p50 - h.p50 : null;
      const noiseFloor = known ? Math.max(f.p95 - f.p50, h.p95 - h.p50) : null;
      const slope = known ? difference / deltaRetained : null;
      rows.push({ scenario, measure, fullMedian: f?.p50 ?? null, halfMedian: h?.p50 ?? null, deltaRetained: Number.isFinite(deltaRetained) ? deltaRetained : null,
        noiseFloor, slope, exceeded: known && slope > maxSlope && difference > noiseFloor, unresolved: known && slope > maxSlope && difference <= noiseFloor });
    }
  }
  const status = rows.some((r) => r.exceeded) ? "Fail" : rows.some((r) => r.slope == null || r.unresolved) ? "未確認" : "Pass";
  return { status, maxSlope, retained, rows };
}
