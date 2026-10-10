import { promises as fileSystem, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, DiagnosticEvent } from "../../contracts/p2-shared-runtime.types";
import { PersistentDiagnosticSink } from "../../src/checkpoint/persistent-diagnostic-sink";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedRuntimeCalls, linkedUnitCodecs, nodeDiagnosticFileSystem } from "../../src/runtime/composition-root";
import { receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { classifyHeadType } from "../../src/runtime/unit-coverage";

const clock: ClockReading = { wallTimeMs: 1_800_000_000_000, monotonicMs: 100 };
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await fileSystem.rm(path, { recursive: true, force: true });
});

function decode(file: string, headType: string, transform: (xml: string) => string = (xml) => xml): DecodedMaterial {
  const entered = ingestXmlData({ inputId: `${file}:${headType}`, inputSequence: 1, receivedAt: 0, origin: "replay",
    kind: "replay", headType, body: Buffer.from(transform(readFileSync(`test/fixtures/${file}.xml`, "utf8"))) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}

// A started deferred owner (P3-C3A-NONREADY: inputs no ready unit owns are decoded there) whose U-F deadline has not
// arrived: any change in the steps below would be the route's doing.
function idleOwner() {
  const started = restoreOwner({ runId: "run", place: "deferred", clock, restored: { "U-F": { kind: "empty" }, "U-L": { kind: "empty" },
    "U-R": { kind: "empty" } } },
    linkedRuntimeCalls.units, linkedUnitCodecs).state;
  return { ...started, deadlines: { ...started.deadlines, "U-F": { wallTimeMs: clock.wallTimeMs + 60_000, monotonicMs: null } } };
}

describe("P3-UNIT-TABLE-001 route classes", () => {
  // P3-C0-T01 regression (ledger 52 1): headTypes outside the route are seen, one diagnostic per input, no state change.
  it("P3-C0-T01 regression: unlisted, notPorted and ignored inputs each leave one diagnostic and change nothing", () => {
    const state = idleOwner();
    const blank = (xml: string) => xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, "<ReportDateTime></ReportDateTime>");
    const cases = [
      { material: decode("37_01_01_240613_VXSE43", "VZZZ99"), expected: { reason: "routeUnlisted", level: "WARN" } },
      // P3-C5: VTSE41 is ready (U-T); VTSE41 bytes under VPBS50 keep a notPorted route on the deferred owner (VFVO50 is ready, P3-C9;
      // VPWW56 is ready, P3-C10; VXKO50 is ready, P3-C11).
      { material: decode("32-39_11_02_250206_VTSE41", "VPBS50"), expected: { reason: "routeNotPorted", level: "INFO", unit: "U-B" } },
      { material: decode("36_01_10_240613_VXSE44", "VXSE44"), expected: { reason: "routeIgnored", level: "INFO" } },
      // The envelope check comes first: a rejected notPorted input gets its existing rejection only.
      { material: decode("32-39_11_02_250206_VTSE41", "VPBS50", blank), expected: { reason: "reportDateTimeMissing", level: "WARN" } },
    ];
    for (const { material, expected } of cases) {
      const step = receiveOwner(state, { runId: "run", inputId: material.inputId, result: { kind: "decoded", material } },
        clock, linkedRuntimeCalls.units);
      expect(step.diagnostics, material.inputId).toMatchObject([{ ...expected, component: "shared-runtime", inputId: material.inputId }]);
      expect(step.state.units).toBe(state.units);
      expect(step.views).toEqual([]);
      expect(step.changedUnits).toEqual([]);
      expect(step.generationInputIds).toEqual({});
    }
  });

  // Inherited names must not be read as table rows (AC05).
  it("P3-C0-AC05 contractBoundary: classifyHeadType reads own keys only", () => {
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) expect(classifyHeadType(name)).toEqual({ status: "unlisted" });
  });

  // P3-C0-T03 contractBoundary
  it("P3-C0-T03 contractBoundary: every corpus headType is in the coverage table except VFSVii", () => {
    const manifest: { fixtures: { transport: { headType: string | null } }[] } = JSON.parse(
      readFileSync("reconstruction/tools/corpus/manifest.json", "utf8"));
    const types = new Set(manifest.fixtures.flatMap((fixture) => fixture.transport.headType ?? []));
    expect([...types].filter((type) => classifyHeadType(type).status === "unlisted")).toEqual(["VFSVii"]);
  });

  // P3-C0-T06 contractBoundary: the sink reason list must carry the new reasons across a restart.
  it("P3-C0-T06 contractBoundary: the persistent sink keeps the route reasons across a restart", async () => {
    const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-p3-c0-"));
    temporary.push(path);
    const events: DiagnosticEvent[] = [
      { timestamp: 1_000, level: "INFO", component: "shared-runtime", reason: "routeIgnored", runId: "run", inputId: "a" },
      { timestamp: 1_001, level: "INFO", component: "shared-runtime", reason: "routeNotPorted", runId: "run", inputId: "b", unit: "U-T" },
      { timestamp: 1_002, level: "WARN", component: "shared-runtime", reason: "routeUnlisted", runId: "run", inputId: "c" },
    ];
    const sink = new PersistentDiagnosticSink(path, nodeDiagnosticFileSystem(), () => 2_000, () => {});
    for (const event of events) expect(sink.enqueueDiagnostic(event).kind).toBe("accepted");
    await sink.flush();
    const restarted = new PersistentDiagnosticSink(path, nodeDiagnosticFileSystem(), () => 2_000, () => {});
    expect((await restarted.readDiagnostics({ limit: 256 })).records).toEqual(events);
  });
});
