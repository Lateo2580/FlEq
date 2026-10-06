import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readSelfHashed } from "../../src/measurement/eew-e01/frozen";
import { buildA10Result, hashRaw, parseArgs, resumeProblems, trialConditionDeviation } from "./run.mjs";
import type { WindowRecord } from "./run.mjs";
import { H } from "./fixtures";

const record = (id: string, attempt: number, status: WindowRecord["status"], extra: Partial<WindowRecord> = {}): WindowRecord => ({
  id, attempt, status, manifestId: "m", manifestSha256: H, rawDir: `/runs/m/${id}`, command: "node run.mjs --manifest m.json",
  commands: ["node run.mjs --manifest m.json", "caffeinate -dims -w 1"], startedAt: "2026-10-01T00:00:00.000Z",
  preflight: { gitHead: "a".repeat(40) }, resultFiles: [], ...extra,
});

describe("P2-A10-T01 runner side: a10-result aggregate (AC10)", () => {
  it("窓の status は記録のまま写し（Blocked を Pass・Fail に変えない）、封印した bytes が自己 hash 検証を通る", () => {
    const windows = [
      record("e01-fixedBacklog-run2", 1, "Blocked", { reason: "host launcher exited mid-run", childExit: { code: 1, signal: null }, lastProgress: { trialsStarted: 400 } }),
      record("e01-fixedBacklog-run1", 2, "Pass"),
      record("e01-fixedBacklog-run1", 1, "Blocked", { reason: "window deadline exceeded" }),
      record("e01-fixedBacklog-run3", 1, "Fail"),
    ];
    const text = buildA10Result({ manifest: { manifestId: "m", manifestSha256: H }, windows, e01: { verdict: { status: "未確認" } } });
    const parsed = readSelfHashed(text, "resultSha256") as { windows: (WindowRecord & { latest: boolean })[] };
    expect(parsed.windows.map((w) => [w.id, w.attempt, w.status, w.latest])).toEqual([
      ["e01-fixedBacklog-run1", 1, "Blocked", false],
      ["e01-fixedBacklog-run1", 2, "Pass", true],
      ["e01-fixedBacklog-run2", 1, "Blocked", true],
      ["e01-fixedBacklog-run3", 1, "Fail", true],
    ]);
    expect(parsed.windows[2]).toMatchObject({ reason: "host launcher exited mid-run", childExit: { code: 1, signal: null } });
    expect(() => readSelfHashed(text.replace('"Fail"', '"Pass"'), "resultSha256")).toThrow("resultSha256 mismatch");
  });
});

describe("P2-A10-T01 runner side: 正式窓の再実行制限（ヘルツ総合レビュー 指摘 6 の再現）", () => {
  it("--manifest に予備専用オプション（--period 等）を足すと、記録先が evidence-scratch に変わる前に拒否する", () => {
    expect(() => parseArgs(["--manifest", "m.json", "--period", "1370", "--windows", "e01-fixedBacklog-run1"])).toThrow("--period is allowed only with --preliminary");
  });
});

describe("P2-A10-T01 runner side: 窓記録の raw（ヘルツ最終確認 指摘 2 の再現）", () => {
  it("下位 dir にある集計の入力（AC15 の full/host-obs.jsonl など）も raw に入り、checkpoint の state/ は入らない", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleq-hashraw-"));
    try {
      for (const f of ["aux-ac15.json", "full/host-obs.jsonl", "full/stringify.jsonl", "full/state/U-E-A.json", "state/U-W-A.json"]) {
        mkdirSync(join(dir, f, ".."), { recursive: true });
        writeFileSync(join(dir, f), f);
      }
      expect(hashRaw(dir).map((r) => r.file)).toEqual(["aux-ac15.json", "full/host-obs.jsonl", "full/stringify.jsonl"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// P3-C4 工程2d（ヘルツ節目 P2）の再発防止。
describe("P3-C4 resume and foreground checks", () => {
  it("a resume is refused when the measured commit, the build, the runner or the machine differs from the first window's record", () => {
    const first = { gitHead: "a", distSha256: "d", runnerSha256: "r", machine: { cpu: "M4", cores: 10, memoryBytes: 16 }, nodeVersion: "v22", chromeVersion: "154", osVersion: "27" };
    const records = [{ startedAt: "2026-10-08T01:00:00Z", preflight: first }, { startedAt: "2026-10-07T01:00:00Z", preflight: null }];
    expect(resumeProblems(first, records)).toEqual([]);
    expect(resumeProblems({ ...first, distSha256: "x", machine: { ...first.machine, memoryBytes: 32 } }, records).map((p) => p.split(":")[0])).toEqual(["distSha256", "machine"]);
    expect(resumeProblems({ ...first, gitHead: "b" }, [])).toEqual([]);
  });

  it("a trial whose page is hidden, unfocused or off the manifest's motion is a deviation", () => {
    const ok = { visibility: "visible", focus: true, reducedMotion: false };
    expect(trialConditionDeviation(ok, "full")).toBeNull();
    expect(trialConditionDeviation({ ...ok, visibility: "hidden" }, "full")).toMatch(/visibility hidden/);
    expect(trialConditionDeviation({ ...ok, focus: false }, "full")).toMatch(/not focused/);
    expect(trialConditionDeviation(ok, "reduced")).toMatch(/prefers-reduced-motion/);
  });
});
