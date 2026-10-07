// P3-C4-AC11（版をまたぐ証拠の採用）: 判定の前に条件を替えた Blocked の母集団（Q-C4-DEADLINE-SUBJECT の型）を新しい manifestId で測り直したとき、
// P3E01Verdict を採用表から組む。
//   node reconstruction/test/eew-e01/adoption.mjs --table <採用表 JSON> --out <結果 JSON>
// runner の合算（buildA10Result・e01Verdict）は 1 つの manifest の窓しか読まない。無いと、旧 manifest の窓と新 manifest の窓を 1 つの verdict に
// するのが手作業になり、窓ごとの版・記録の hash・測定 commit の照合が抜ける。runner は広げない（再開の照合は manifest ごとのまま緩めない）。
// 採用表: { schemaVersion: "p3-c4-adoption-table-v1", baseManifestId, manifests: [{ manifestId, path, commit, questionResolution? }],
//   rows: [{ window, manifestId, manifestSha256, recordPath, recordSha256 }] }。commit はその manifest の窓を測った commit で、採る窓の記録の
//   preflight.gitHead と一致しなければならない。新しい manifest は、差分を認めた closed の questionResolution の ID を持つ。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { A10_MANIFEST, SEQUENCES_FILE, SMOKE_FILE, contractTextsFor } from "./draft.mjs";
import { REPO, sha256Hex } from "./frames.mjs";
import { latestById, readRawJson, resumeProblems } from "./run.mjs";

import { quantiles } from "../../dist/src/measurement/eew-e01/judge.js";
import { ZERO_HASH, sealSelfHash, verifyFrozenP3Manifest } from "../../dist/src/measurement/eew-e01/frozen.js";

const POPULATION_OF = /^e01-(.+)-run(\d+)$/;
// 版をまたいで違ってよい field（版の名前と、commit で検証する契約 hash）。それ以外は、questionResolution が認めた path だけ。
const IDENTITY = new Set(["manifestId", "manifestSha256", "contractSha256"]);
const ALLOWED_CHANGES = { "Q-C4-DEADLINE-SUBJECT": ["populations.forecastDeadlineOverlap.trigger"] };
// manifest をまたいで同じでなければならない測定の条件（runnerSha256 と gitHead は版で変わる）。
const CROSS_FIELDS = ["distSha256", "machine", "nodeVersion", "chromeVersion", "osVersion"];
const aggregate = (list) => (list.includes("Fail") ? "Fail" : list.length > 0 && list.every((st) => st === "Pass") ? "Pass" : "未確認");

// 元の manifest との差（top level の field、populations は母集団の field ごと）。
export function manifestDiff(base, other) {
  const diff = [];
  const compare = (path, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) diff.push({ path, base: a ?? null, value: b ?? null }); };
  for (const key of new Set([...Object.keys(base), ...Object.keys(other)])) {
    if (key !== "populations") { compare(key, base[key], other[key]); continue; }
    for (const p of new Set([...Object.keys(base.populations), ...Object.keys(other.populations)])) {
      const [a, b] = [base.populations[p], other.populations[p]];
      if (a == null || b == null) { compare(`populations.${p}`, a, b); continue; }
      for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) compare(`populations.${p}.${field}`, a[field], b[field]);
    }
  }
  return diff;
}

// 採用表の照合と verdict の組み立て（I/O なし）。manifests は検証済みの manifest、records は manifest ごとの窓記録の path と text（その manifest の
// records dir の全部）、closedQuestions は manifest の測定 commit の P3 契約で closed の questionResolution の ID、unusable は窓 → 生データが
// 照合できない理由（e01Verdict と同じく「未確認」）。窓の status は窓記録のまま写し、標本から判定し直さない。
export function adoptionResult({ table, manifests, records, closedQuestions = {}, unusable = {} }) {
  const problems = [];
  const base = manifests[table.baseManifestId];
  if (base == null) return { problems: [`base manifest ${table.baseManifestId} is not in the table`], body: null };
  const parsed = Object.fromEntries(Object.entries(records).map(([id, list]) => [id, list.map((r) => ({ ...r, record: JSON.parse(r.text) }))
    .filter((r) => r.record.manifestSha256 === manifests[id]?.manifestSha256)]));
  const entryOf = Object.fromEntries(table.manifests.map((m) => [m.manifestId, m]));
  for (const [id, list] of Object.entries(parsed)) {
    const seen = new Set();
    for (const { record } of list) {
      const key = `${record.id}#${record.attempt}`;
      if (seen.has(key)) problems.push(`${id}: ${record.id} has two records of attempt ${record.attempt}`);
      seen.add(key);
    }
  }
  const baseRecords = parsed[table.baseManifestId] ?? [];
  const diffs = {};
  const affected = {};
  for (const [id, m] of Object.entries(manifests)) {
    if (id === table.baseManifestId) continue;
    const q = entryOf[id]?.questionResolution;
    const allowed = ALLOWED_CHANGES[q] ?? [];
    if (ALLOWED_CHANGES[q] == null) problems.push(`${id}: questionResolution ${q ?? "(none)"} allows no change`);
    else if (!(closedQuestions[id] ?? []).includes(q)) problems.push(`${id}: ${q} is not a closed questionResolution of the contract at ${entryOf[id].commit}`);
    diffs[id] = manifestDiff(base, m);
    const outside = diffs[id].filter((d) => !IDENTITY.has(d.path) && !allowed.includes(d.path));
    if (outside.length > 0) problems.push(`${id}: differs from the base beyond ${q}: ${outside.map((d) => d.path).join(", ")}`);
    affected[id] = [...new Set(diffs[id].filter((d) => d.path.startsWith("populations.")).map((d) => d.path.split(".")[1]))];
    if (affected[id].length === 0) problems.push(`${id}: no population differs from the base`);
  }
  const byWindow = new Map();
  const adopted = [];
  for (const row of table.rows) {
    if (byWindow.has(row.window)) problems.push(`${row.window}: adopted twice`);
    byWindow.set(row.window, row);
    const m = manifests[row.manifestId];
    if (m == null) { problems.push(`${row.window}: manifest ${row.manifestId} is not in the table`); continue; }
    if (m.manifestSha256 !== row.manifestSha256) problems.push(`${row.window}: manifestSha256 differs from ${row.manifestId}`);
    const all = parsed[row.manifestId] ?? [];
    const entry = all.find((r) => r.path === row.recordPath);
    if (entry == null) { problems.push(`${row.window}: ${row.recordPath} is not a record of ${row.manifestId}`); continue; }
    adopted.push({ row, entry });
    if (sha256Hex(entry.text) !== row.recordSha256) problems.push(`${row.window}: record sha256 differs`);
    if (entry.record.id !== row.window) problems.push(`${row.window}: the record is of ${entry.record.id}`);
    if (entry.record.preflight?.gitHead !== entryOf[row.manifestId]?.commit) problems.push(`${row.window}: measured at ${entry.record.preflight?.gitHead}, the table has ${entryOf[row.manifestId]?.commit}`);
    // 同じ manifest の中の再開照合（最初の窓の記録と commit・dist・runner・機械）を、採る窓ごとにもう一度通す。
    for (const p of resumeProblems(entry.record.preflight ?? {}, all.map((r) => r.record))) problems.push(`${row.window}: ${p}`);
    // 同じ manifest の中では最新の attempt だけ（古い attempt を選び直さない）。
    const latest = latestById(all.map((r) => r.record)).find((r) => r.id === row.window);
    if (latest?.attempt !== entry.record.attempt) problems.push(`${row.window}: attempt ${entry.record.attempt} is not the latest (${latest?.attempt}) of ${row.manifestId}`);
    const population = POPULATION_OF.exec(row.window)?.[1];
    if (row.manifestId !== table.baseManifestId && !affected[row.manifestId]?.includes(population))
      problems.push(`${row.window}: ${row.manifestId} may replace only the windows of ${affected[row.manifestId]?.join(", ") || "no population"}`);
  }
  // manifest をまたいで dist と機械が同じこと（基準は採る元の manifest の最初の窓）。
  const reference = adopted.find((a) => a.row.manifestId === table.baseManifestId)?.entry.record.preflight;
  for (const { row, entry } of adopted) for (const field of CROSS_FIELDS)
    if (reference != null && JSON.stringify(entry.record.preflight?.[field]) !== JSON.stringify(reference[field])) problems.push(`${row.window}: preflight ${field} differs from the base manifest's`);
  // 影響する母集団は全 run を新しい manifest から採り、旧の記録は status を問わず superseded に並べる。この規則が受けるのは、判定の前に
  // 条件を替えた Blocked の母集団だけ（旧の窓が Blocked か未実施）。判定の済んだ窓の測り直し（FAIL-PATH・未確認）はこの規則の外。
  const superseded = [];
  for (const [id, populations] of Object.entries(affected)) for (const p of populations) for (let r = 1; r <= base.runCount; r++) {
    const window = `e01-${p}-run${r}`;
    if (byWindow.get(window)?.manifestId !== id) problems.push(`${window}: every run of ${p} is taken from ${id}`);
    const old = baseRecords.filter((x) => x.record.id === window).sort((a, b) => a.record.attempt - b.record.attempt);
    const judged = old.filter((x) => x.record.status !== "Blocked");
    if (judged.length > 0) problems.push(`${window}: the base window is ${judged.map((x) => x.record.status).join(", ")}; only a Blocked or unrun population is replaced by this rule`);
    if (old.length === 0) superseded.push({ window, manifestId: table.baseManifestId, status: "未実施" });
    for (const x of old) superseded.push({ window, manifestId: table.baseManifestId, attempt: x.record.attempt, recordPath: x.path, recordSha256: sha256Hex(x.text),
      status: x.record.status, reason: x.record.reason ?? null });
  }
  for (const id of new Set(latestById(baseRecords.map((r) => r.record)).map((r) => r.id)))
    if (!byWindow.has(id)) problems.push(`${id}: a window of the base manifest is not in the table`);
  const statusOf = (window) => {
    const row = byWindow.get(window);
    if (row == null || unusable[window] != null) return "未確認";
    return (parsed[row.manifestId] ?? []).find((r) => r.path === row.recordPath)?.record.status ?? "未確認";
  };
  const populations = {};
  const formal = [];
  for (const [p, c] of Object.entries(base.populations)) {
    if (c.scope !== "formal") { populations[p] = "reference"; continue; }
    const runs = Array.from({ length: base.runCount }, (_, i) => statusOf(`e01-${p}-run${i + 1}`));
    formal.push(...runs);
    populations[p] = aggregate(runs);
  }
  const rows = table.rows.map((row) => ({ ...row, attempts: (parsed[row.manifestId] ?? []).filter((r) => r.record.id === row.window)
    .map((r) => ({ attempt: r.record.attempt, status: r.record.status, recordPath: r.path })).sort((a, b) => a.attempt - b.attempt) }));
  const verdict = { label: "P3 E01", status: aggregate(formal), populations,
    evidenceRefs: table.rows.filter((r) => POPULATION_OF.test(r.window)).map((r) => `${r.recordPath} (${r.manifestId}, ${r.recordSha256})`) };
  return { problems, body: { verdict, rows, manifests: table.manifests, manifestDiffs: diffs, superseded, unusable } };
}

// AC01(3)〜(5): 負荷 N の背景の VPWP50（最初の投入）の前後で、成立と p99 を分けて報告する（合否は分けない）。時点は run-record の others
// （kind background・headType VPWP50）の実投入から引き、新しい観測は足さない（N の VPWP50 の fixture は 81_01_04 の 1 つだけ）。
export function backgroundSplit(assembled, others) {
  const at = others.find((o) => o.kind === "background" && o.headType === "VPWP50" && o.injectedHrMs != null)?.injectedHrMs ?? null;
  const formal = assembled.injections.filter((i) => i.attemptIndex >= assembled.spec.warmup);
  const samples = new Map(assembled.samples.map((s) => [s.sampleIndex, s]));
  const part = (list) => {
    const linked = list.flatMap((i) => (i.sampleIndex == null || !samples.has(i.sampleIndex) ? [] : [samples.get(i.sampleIndex)]));
    const p99 = (key) => quantiles(linked.filter((s) => !s.missing && s[key] != null).map((s) => s[key]))?.p99 ?? null;
    return { attempts: list.length, established: linked.length, missing: linked.filter((s) => s.missing).length, p99LowerMs: p99("latencyLowerMs"), p99UpperMs: p99("latencyUpperMs") };
  };
  const time = (i) => i.injectedInjectorMonotonicMs ?? i.scheduledInjectorMonotonicMs;
  return { backgroundVpwp50InjectedHrMs: at, before: part(at == null ? formal : formal.filter((i) => time(i) < at)), after: at == null ? null : part(formal.filter((i) => time(i) >= at)) };
}

// 窓の生データ（e01-assembled.json と run-record.json）を、窓記録の raw の hash で照らし、その窓の母集団・run の同じ測定であることを確かめて読む。
export function rawOf(w) {
  const [, population, run] = POPULATION_OF.exec(w.id) ?? [];
  const assembled = readRawJson(w, "e01-assembled.json");
  const runRecord = readRawJson(w, "run-record.json");
  for (const [name, p, r] of [["e01-assembled.json", assembled.spec?.population, assembled.spec?.run], ["run-record.json", runRecord.population, runRecord.run]])
    if (p !== population || String(r) !== run) throw new Error(`${name} is of ${p} run${r}, not ${w.id}`);
  if (JSON.stringify(assembled.injections.map((i) => i.inputId)) !== JSON.stringify(runRecord.trials.map((t) => t.inputId)))
    throw new Error("e01-assembled.json and run-record.json are of different trials");
  return { assembled, runRecord };
}

const SPLIT_POPULATIONS = new Set(["maxWeatherCheckpointEncodeStarted", "maxForecastCheckpointSave", "forecastDeadlineOverlap"]);

// 生データの照合と背景の前後の分割（読み出しは readRecord と read に寄せる）。対象は採る窓、同じ manifest の前の attempt（Blocked）、置き換えた
// 旧の記録。採る窓は照合できなければ unusable（verdict では「未確認」、合否を Pass にしない）。分割は合否を変えずに Blocked の窓にも出し、
// 生データが無い・照合できない窓は「報告不能」と書く。
export function rawReport(body, readRecord, read = rawOf) {
  const targets = [...body.rows.flatMap((r) => r.attempts.map((a) => ({ window: r.window, recordPath: a.recordPath, adopted: a.recordPath === r.recordPath }))),
    ...body.superseded.filter((x) => x.recordPath != null).map((x) => ({ window: x.window, recordPath: x.recordPath, adopted: false }))];
  const unusable = {};
  const splits = {};
  for (const { window, recordPath, adopted } of targets) {
    const population = POPULATION_OF.exec(window)?.[1];
    if (population == null) continue;
    const w = readRecord(recordPath);
    try {
      const { assembled, runRecord } = read(w);
      if (SPLIT_POPULATIONS.has(population)) splits[recordPath] = { window, status: w.status, ...backgroundSplit(assembled, runRecord.others) };
    } catch (error) {
      const reason = String(error?.message ?? error);
      if (adopted && w.status !== "Blocked") unusable[window] = reason;
      if (SPLIT_POPULATIONS.has(population)) splits[recordPath] = { window, status: w.status, split: "報告不能", reason };
    }
  }
  return { unusable, splits };
}
const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });

// manifest を、その窓を測った commit の契約・入力の text で検証する（今の tree の契約文では meta.sha256 が変わって通らない）。
// path の今の bytes が commit のものと同じこと（凍結 manifest を書き換えていない）も確かめる。
function verifiedAt({ manifestId, path, commit }) {
  const at = (file) => git("show", `${commit}:${file}`);
  const manifestText = at(path);
  if (readFileSync(join(REPO, path), "utf8") !== manifestText) throw new Error(`${manifestId}: ${path} differs from ${commit} (a frozen manifest is not rewritten)`);
  const trialSetupText = at(JSON.parse(manifestText).trialSetupRef);
  const contracts = Object.fromEntries(git("ls-tree", "--name-only", commit, "reconstruction/contracts/").split("\n").filter((f) => f.endsWith(".json"))
    .map((f) => at(f)).map((t) => [JSON.parse(t).contract?.contractId, t]).filter(([id]) => id != null));
  const { manifest } = verifyFrozenP3Manifest({ manifestText, trialSetupText, smokeConditionsText: at(SMOKE_FILE), sequencesText: at(SEQUENCES_FILE),
    contractTexts: contractTextsFor("P3-E01-REACCEPT-001", contracts),
    inherited: { manifestText: at(A10_MANIFEST), initialStateText: at(JSON.parse(trialSetupText).initialStateRef) } });
  if (manifest.manifestId !== manifestId) throw new Error(`${path} is ${manifest.manifestId}, the table has ${manifestId}`);
  const closed = JSON.parse(contracts["P3-E01-REACCEPT-001"]).meta.questionResolutions.filter((q) => q.status === "closed").map((q) => q.id);
  return { manifest, closed };
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(`--${name}`); if (i < 0 || argv[i + 1] == null) throw new Error(`--${name} is required`); return argv[i + 1]; };
  const table = JSON.parse(readFileSync(arg("table"), "utf8"));
  if (new Set(table.manifests.map((m) => m.path)).size !== table.manifests.length) throw new Error("each manifest needs its own path (a new manifest is frozen apart from the old)");
  const verified = Object.fromEntries(table.manifests.map((m) => [m.manifestId, verifiedAt(m)]));
  const manifests = Object.fromEntries(Object.entries(verified).map(([id, v]) => [id, v.manifest]));
  const records = Object.fromEntries(table.manifests.map(({ manifestId }) => {
    const dir = join(REPO, "reconstruction/test/eew-e01/evidence/windows", manifestId);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
    return [manifestId, files.map((f) => ({ path: relative(REPO, join(dir, f)), text: readFileSync(join(dir, f), "utf8") }))];
  }));
  const closedQuestions = Object.fromEntries(Object.entries(verified).map(([id, v]) => [id, v.closed]));
  const { problems, body } = adoptionResult({ table, manifests, records, closedQuestions });
  if (problems.length > 0) throw new Error(`adoption table refused:\n  ${problems.join("\n  ")}`);
  const { unusable, splits } = rawReport(body, (path) => JSON.parse(readFileSync(join(REPO, path), "utf8")));
  const result = Object.keys(unusable).length === 0 ? body : adoptionResult({ table, manifests, records, closedQuestions, unusable }).body;
  const out = { schemaVersion: "p3-c4-adoption-v1", baseManifestId: table.baseManifestId, resultSha256: ZERO_HASH, ...result, backgroundSplit: splits };
  writeFileSync(arg("out"), sealSelfHash(`${JSON.stringify(out, null, 2)}\n`, "resultSha256"));
  console.log(JSON.stringify(result.verdict));
}

if (process.argv[1] != null && import.meta.filename === realpathSync(process.argv[1])) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error); process.exit(1); }
}
