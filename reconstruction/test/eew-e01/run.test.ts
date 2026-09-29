import { describe, expect, it } from "vitest";

import { readSelfHashed } from "../../src/measurement/eew-e01/frozen";
import { buildA10Result } from "./run.mjs";
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
