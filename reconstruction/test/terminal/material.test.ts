import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AcquisitionOrigin } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading } from "../../contracts/p2-shared-runtime.types";
import type { ParserEnvelope } from "../../contracts/p3-execution-split.types";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { harnessedRoot, startHarness, submit } from "../execution-split/owner-harness";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function config() {
  const path = mkdtempSync(join(tmpdir(), "fleq-terminal-"));
  directories.push(path);
  return { appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") } as const;
}
// owner-harness の envelope と同じ形で、取得の origin を選べるもの。
function input(headType: string, inputId: string, path: string, origin: AcquisitionOrigin, sequence: number, clock: ClockReading): ParserEnvelope {
  const entered = ingestXmlData({ kind: "replay", inputId, inputSequence: sequence, receivedAt: clock.wallTimeMs, origin, headType,
    body: readFileSync(`test/fixtures/${path}`) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  return { messageId: inputId, runId: "run-terminal", t0MonotonicMs: clock.monotonicMs, enqueuedMonotonicMs: clock.monotonicMs,
    priorityReason: headType === "VXSE45" ? "eewCandidate" : "normal", payload: { kind: "parser", item: entered.item } };
}

describe("P3-TO-T08 材料を作る入力（AC01 (2)）", () => {
  it("採った live の報だけが返信の terminal を持ち、duplicate・U-E・取り直しの本文は null", async () => {
    // 時計は VXSE53 の発表の直後（古い報を期限切れの記憶にしない）。
    const clock: ClockReading = { wallTimeMs: Date.parse("2010-01-25T16:19:30+09:00"), monotonicMs: 1 };
    const h = harnessedRoot(config(), linkedUnitCodecs, { clock: () => clock });
    await startHarness(h, "run-terminal");
    await submit(h, input("VXSE53", "quake-1", "32-35_04_04_240613_VXSE53.xml", "live", 1, clock));
    await submit(h, input("VXSE53", "quake-2", "32-35_04_04_240613_VXSE53.xml", "live", 2, clock));
    await submit(h, input("VXSE45", "eew-1", "77_01_01_240613_VXSE45.xml", "live", 3, clock));
    await submit(h, input("VXSE53", "recovered-1", "32-35_01_03_240613_VXSE53.xml", "recovery", 4, clock));
    const terminals = new Map(h.delivered.flatMap(({ reply }) => reply.kind === "inputDone" ? [[reply.settlement.inputId, reply.terminal] as const] : []));
    expect(terminals.get("quake-1")?.kind).toBe("seismic");
    expect([...terminals].filter(([id]) => id !== "quake-1")).toEqual([["quake-2", null], ["eew-1", null], ["recovered-1", null]]);
  });
});
