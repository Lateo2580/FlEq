import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { adoptionResult, backgroundSplit, rawOf, rawReport } from "./adoption.mjs";
import type { AdoptionTable } from "./adoption.mjs";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const frozen = JSON.parse(readFileSync("reconstruction/test/eew-e01/evidence/p3/manifest.json", "utf8"));
// 正式 2 母集団 × 2 run に絞った元の manifest と、母集団 5 の trigger の文だけを替えた新しい manifest。
const base = { ...frozen, manifestId: "old", manifestSha256: "a".repeat(64), runCount: 2,
  populations: { fixedBacklog: frozen.populations.fixedBacklog, forecastDeadlineOverlap: frozen.populations.forecastDeadlineOverlap } };
const withDeadline = (patch: Record<string, unknown>) => ({ ...base, manifestId: "new", manifestSha256: "b".repeat(64),
  contractSha256: { ...base.contractSha256, "P3-E01-REACCEPT-001": "c".repeat(64) },
  populations: { ...base.populations, forecastDeadlineOverlap: { ...base.populations.forecastDeadlineOverlap, trigger: "官署を替えた", ...patch } } });
const next = withDeadline({});
const COMMIT = { old: "1".repeat(40), new: "2".repeat(40) };
const machine = { cpu: "Apple M2", cores: 8, memoryBytes: 8 };
const rec = (m: "old" | "new", id: string, attempt: number, status: string, preflight: Record<string, unknown> = {}) => {
  const text = JSON.stringify({ id, attempt, status, manifestId: m, manifestSha256: m === "old" ? base.manifestSha256 : next.manifestSha256,
    startedAt: `2026-10-0${attempt}T00:00:00.000Z`, preflight: { gitHead: COMMIT[m], distSha256: "d", runnerSha256: `r-${m}`, machine,
      nodeVersion: "v22", chromeVersion: "154", osVersion: "27", ...preflight } });
  return { path: `windows/${m}/${id}-${attempt}.json`, text };
};
const old = [rec("old", "e01-fixedBacklog-run1", 1, "Pass"), rec("old", "e01-fixedBacklog-run2", 1, "Pass"),
  rec("old", "e01-forecastDeadlineOverlap-run1", 1, "Blocked")];
const neu = [rec("new", "e01-forecastDeadlineOverlap-run1", 1, "Blocked"), rec("new", "e01-forecastDeadlineOverlap-run1", 2, "Pass"),
  rec("new", "e01-forecastDeadlineOverlap-run2", 1, "Pass")];
const row = (r: { path: string; text: string }) => { const j = JSON.parse(r.text); return { window: j.id as string, manifestId: j.manifestId as string,
  manifestSha256: j.manifestSha256 as string, recordPath: r.path, recordSha256: sha(r.text) }; };
const table: AdoptionTable = { schemaVersion: "p3-c4-adoption-table-v1", baseManifestId: "old",
  manifests: [{ manifestId: "old", path: "old.json", commit: COMMIT.old },
    { manifestId: "new", path: "new.json", commit: COMMIT.new, questionResolution: "Q-C4-DEADLINE-SUBJECT" }],
  rows: [row(old[0]!), row(old[1]!), row(neu[1]!), row(neu[2]!)] };
const input = { table, manifests: { old: base, new: next }, records: { old, new: neu }, closedQuestions: { new: ["Q-C4-DEADLINE-SUBJECT"] } };
const refused = (patch: Partial<Parameters<typeof adoptionResult>[0]>) => adoptionResult({ ...input, ...patch }).problems.join("\n");

// 受入条件 P3-C4-AC11（版をまたぐ証拠の採用）: 採用表から verdict を組み、照合の外れを拒否する。
describe("P3-C4-T12 evidence adopted across manifests (AC11)", () => {
  it("takes every run of the affected population from the new manifest, lists the old records and earlier attempts, and reports the difference", () => {
    const { problems, body } = adoptionResult(input);
    expect(problems).toEqual([]);
    expect(body?.verdict).toMatchObject({ status: "Pass", populations: { fixedBacklog: "Pass", forecastDeadlineOverlap: "Pass" } });
    expect(body?.superseded.map((s) => [s.window, s.status])).toEqual([["e01-forecastDeadlineOverlap-run1", "Blocked"], ["e01-forecastDeadlineOverlap-run2", "未実施"]]);
    expect(body?.rows.find((r) => r.window === "e01-forecastDeadlineOverlap-run1")?.attempts.map((a) => [a.attempt, a.status])).toEqual([[1, "Blocked"], [2, "Pass"]]);
    expect(body?.manifestDiffs["new"]?.map((d) => d.path)).toEqual(["manifestId", "manifestSha256", "contractSha256", "populations.forecastDeadlineOverlap.trigger"]);
    expect(adoptionResult({ ...input, unusable: { "e01-fixedBacklog-run1": "e01-assembled.json sha256 differs" } }).body?.verdict.status).toBe("未確認");
  });

  it("refuses a change beyond the ruling, an unclosed ruling, mixed runs, an unaffected window, a wrong hash, an older or duplicated attempt, another commit, another dist and a broken resume", () => {
    expect(refused({ manifests: { old: base, new: withDeadline({ triggerLeadMs: 1200 }) } })).toMatch("beyond Q-C4-DEADLINE-SUBJECT: populations.forecastDeadlineOverlap.triggerLeadMs");
    expect(refused({ closedQuestions: {} })).toMatch("Q-C4-DEADLINE-SUBJECT is not a closed questionResolution");
    expect(refused({ table: { ...table, rows: [row(old[0]!), row(old[1]!), row(neu[1]!)] } })).toMatch("e01-forecastDeadlineOverlap-run2: every run of forecastDeadlineOverlap is taken from new");
    const unaffected = rec("new", "e01-fixedBacklog-run1", 1, "Pass");
    expect(refused({ records: { old, new: [...neu, unaffected] }, table: { ...table, rows: [row(unaffected), row(old[1]!), row(neu[1]!), row(neu[2]!)] } }))
      .toMatch("may replace only the windows of forecastDeadlineOverlap");
    expect(refused({ table: { ...table, rows: [{ ...row(old[0]!), recordSha256: "e".repeat(64) }, ...table.rows.slice(1)] } })).toMatch("record sha256 differs");
    expect(refused({ table: { ...table, rows: [row(old[0]!), row(old[1]!), row(neu[0]!), row(neu[2]!)] } })).toMatch("attempt 1 is not the latest (2)");
    expect(refused({ records: { old, new: [...neu, rec("new", "e01-forecastDeadlineOverlap-run2", 1, "Fail")] } })).toMatch("has two records of attempt 1");
    expect(refused({ table: { ...table, manifests: [table.manifests[0]!, { ...table.manifests[1]!, commit: "3".repeat(40) }] } })).toMatch(`measured at ${COMMIT.new}`);
    const otherDist = [neu[0]!, neu[1]!, rec("new", "e01-forecastDeadlineOverlap-run2", 1, "Pass", { distSha256: "x" })];
    const distProblems = refused({ records: { old, new: otherDist }, table: { ...table, rows: [row(old[0]!), row(old[1]!), row(otherDist[1]!), row(otherDist[2]!)] } });
    expect(distProblems).toMatch("preflight distSha256 differs from the base manifest's");
    expect(distProblems).toMatch("distSha256: \"x\" differs from the first window's");
  });

  it("reads the raw data of the adopted windows, the earlier Blocked attempts and the replaced old records; an unreadable one is unusable or not reportable", () => {
    const body = adoptionResult(input).body!;
    const texts = new Map([...old, ...neu].map((r) => [r.path, JSON.parse(r.text)]));
    const readRecord = (path: string) => texts.get(path)!;
    const ok = { assembled: { spec: { warmup: 0 }, injections: [], samples: [] }, runRecord: { others: [] } };
    const read = (w: { id: string; attempt: number; manifestId: string }) => {
      if (w.id === "e01-fixedBacklog-run1" || (w.manifestId === "new" && w.attempt === 1 && w.id.endsWith("run1"))) throw new Error("e01-assembled.json sha256 differs from the window record");
      return ok;
    };
    const report = rawReport(body, readRecord, read);
    expect(report.unusable).toEqual({ "e01-fixedBacklog-run1": "e01-assembled.json sha256 differs from the window record" });
    expect(Object.entries(report.splits).map(([path, v]) => [path, v["status"], v["split"] ?? "split"])).toEqual([
      ["windows/new/e01-forecastDeadlineOverlap-run1-1.json", "Blocked", "報告不能"],
      ["windows/new/e01-forecastDeadlineOverlap-run1-2.json", "Pass", "split"],
      ["windows/new/e01-forecastDeadlineOverlap-run2-1.json", "Pass", "split"],
      ["windows/old/e01-forecastDeadlineOverlap-run1-1.json", "Blocked", "split"],
    ]);
  });

  it("is outside the rule when the base window of the affected population was judged (FAIL-PATH re-acceptance is ruled apart)", () => {
    const judged = [old[0]!, old[1]!, rec("old", "e01-forecastDeadlineOverlap-run1", 1, "Fail")];
    expect(refused({ records: { old: judged, new: neu } })).toMatch("the base window is Fail; only a Blocked or unrun population is replaced by this rule");
  });

  it("reads the raw data only when both files are of the window's population and run and of the same trials", () => {
    const dir = mkdtempSync(join(tmpdir(), "adoption-"));
    try {
      const write = (file: string, body: unknown) => { const text = JSON.stringify(body); writeFileSync(join(dir, file), text); return { file, bytes: text.length, sha256: sha(text) }; };
      const assembled = { spec: { population: "forecastDeadlineOverlap", run: 1, warmup: 0 }, injections: [{ inputId: "input-3" }], samples: [] };
      const raw = [write("e01-assembled.json", assembled), write("run-record.json", { population: "forecastDeadlineOverlap", run: 1, trials: [{ inputId: "input-3" }], others: [] })];
      expect(rawOf({ id: "e01-forecastDeadlineOverlap-run1", rawDir: dir, raw }).assembled).toEqual(assembled);
      expect(() => rawOf({ id: "e01-forecastDeadlineOverlap-run2", rawDir: dir, raw })).toThrow("e01-assembled.json is of forecastDeadlineOverlap run1");
      const other = [raw[0]!, write("run-record.json", { population: "forecastDeadlineOverlap", run: 1, trials: [{ inputId: "input-4" }], others: [] })];
      expect(() => rawOf({ id: "e01-forecastDeadlineOverlap-run1", rawDir: dir, raw: other })).toThrow("different trials");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// 受入条件 P3-C4-AC01(3)〜(5): 背景の VPWP50 の前後で成立と p99 を分けて報告する（合否は分けない）。
describe("P3-C4-T12 report split at the background VPWP50 (AC01)", () => {
  it("splits formal attempts at the first background VPWP50 injection and leaves warm-up out", () => {
    const injection = (attemptIndex: number, sampleIndex: number | null, at: number) => ({ attemptIndex, sampleIndex, injectedInjectorMonotonicMs: at, scheduledInjectorMonotonicMs: at });
    const sample = (sampleIndex: number, upper: number) => ({ sampleIndex, missing: false, latencyLowerMs: upper - 1, latencyUpperMs: upper });
    const assembled = { spec: { warmup: 1 }, injections: [injection(0, 0, 10), injection(1, 1, 20), injection(2, null, 30), injection(3, 2, 50), injection(4, null, 60)],
      samples: [sample(0, 900), sample(1, 100), sample(2, 200)] };
    const others = [{ kind: "background", headType: "VPWS50", injectedHrMs: 5 }, { kind: "background", headType: "VPWP50", injectedHrMs: 40 }];
    expect(backgroundSplit(assembled, others)).toEqual({ backgroundVpwp50InjectedHrMs: 40,
      before: { attempts: 2, established: 1, missing: 0, p99LowerMs: 99, p99UpperMs: 100 },
      after: { attempts: 2, established: 1, missing: 0, p99LowerMs: 199, p99UpperMs: 200 } });
  });
});
