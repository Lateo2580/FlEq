import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecodedMaterial, Operation, ParserMailboxResult } from "../../contracts/p1-parser-boundary.types";
import type {
  DiagnosticDetails,
  MailboxControl,
  RuntimeInput,
  RuntimeState,
} from "../../contracts/p2-shared-runtime.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { boundDiagnosticDetails, completeDiagnostic } from "../../src/runtime/runtime-diagnostic";
import { reduceRuntime, validateSemanticEnvelope } from "../../src/runtime/shared-runtime";

const clock = { wallTimeMs: 1_780_650_000_001, monotonicMs: 12 } as const;
const state = Object.freeze({ units: Object.freeze({}), persistence: Object.freeze({}), shutdown: "running" as const });

function parserInput(result: ParserMailboxResult, runId = "run"): RuntimeInput {
  return {
    kind: "mailboxCompleted",
    clock,
    completion: {
      kind: "parser",
      messageId: "message",
      runId,
      encodedByteLength: 1,
      startedMonotonicMs: 1,
      completedMonotonicMs: 2,
      inputId: result.kind === "decoded" ? result.material.inputId : result.diagnostic.inputId,
      inputSequence: 1,
      result,
    },
  };
}

function fixture(path: string, headType: string): DecodedMaterial {
  const inputId = path;
  const entered = ingestXmlData({
    kind: "replay",
    inputId,
    inputSequence: 1,
    receivedAt: clock.wallTimeMs,
    origin: "replay",
    headType,
    body: readFileSync(path),
  });
  if (entered.kind !== "accepted") throw new Error(`ingress rejected ${path}`);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(`decode rejected ${path}`);
  return decoded.material;
}

const valid = fixture("test/fixtures/telegram-foundation/phase7_5_VXSE51_20260728162718_059a2b392646.xml", "VXSE51");


function controlInput(control: MailboxControl): RuntimeInput {
  return { kind: "mailboxCompleted", clock, completion: {
    kind: "control", messageId: "control", runId: "run", encodedByteLength: 0,
    startedMonotonicMs: 1, completedMonotonicMs: 2, control,
  } };
}

function savedState(inspect: () => void) {
  const unit = Object.freeze({
    get current() { inspect(); return { operation: "normal", subject: "event", expiresAt: clock.wallTimeMs + 60_000 }; },
    gate: 1, intents: Object.freeze([]),
  });
  return new Proxy(Object.freeze({
    units: Object.freeze({ "U-E": unit }),
    persistence: Object.freeze({ "U-E": Object.freeze({
      kind: "saved" as const, currentGeneration: 1, savedGeneration: 1,
      savedCapturedAt: clock.wallTimeMs - 100, savedAckAt: clock.wallTimeMs - 50, dirtySince: null,
    }) }),
    shutdown: "running" as const,
  }), { ownKeys(target) { inspect(); return Reflect.ownKeys(target); } });
}

describe("P2 shared runtime", () => {
  afterEach(() => vi.restoreAllMocks());

  it("P2-A1-T01 acceptance / AC01: saved pre-deadline state has zero work in 1,000 ticks", () => {
    const inspect = vi.fn();
    const saved = savedState(inspect);
    const input = controlInput({ kind: "deadline", clock });
    const clone = vi.spyOn(globalThis, "structuredClone");
    const stringify = vi.spyOn(JSON, "stringify");
    const parse = vi.spyOn(JSON, "parse");
    for (let index = 0; index < 1_000; index += 1) {
      const step = reduceRuntime(saved, input);
      expect(step.state).toBe(saved);
      for (const effects of [step.changedUnits, step.checkpointRequests, step.notificationIntents,
        step.outcomes, step.views, step.diagnostics]) expect(effects).toEqual([]);
    }
    expect(inspect).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    expect(stringify).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it("P2-A1-T02 contractBoundary / AC02: runtime input branches never serialize or copy business state", () => {
    const maximum = fixture("test/fixtures/15_18_01_250630_VPWS50.xml", "VPWS50");
    const inspect = vi.fn();
    const saved = savedState(inspect);
    const inputs = [
      parserInput({ kind: "decoded", material: valid }),
      parserInput({ kind: "decoded", material: { ...valid, infoTypeRaw: "取消" } }),
      parserInput({ kind: "decoded", material: maximum }),
      parserInput({ kind: "decoded", material: { ...valid, reportDateTimeRaw: "" } }),
      parserInput({ kind: "rejected", diagnostic: {
        inputId: "parser-rejected", reason: "xmlInvalid", encodedByteLength: 0,
        expandedByteLength: null, operation: { kind: "undetermined", sources: {} },
      } }),
      controlInput({ kind: "deadline", clock }),
      controlInput({ kind: "checkpointResult", clock, result: {
        kind: "acknowledged", attemptId: "save", unit: "U-E", generation: 1,
        ackAt: clock.wallTimeMs, encodedByteLength: 100,
      } }),
      controlInput({ kind: "shutdownRequested", clock, acceptedThroughSequence: 1 }),
      { kind: "notificationResult", result: {
        kind: "timeout", stopped: false, attemptId: "notice", intentId: "intent",
        channel: "sound", completedAt: clock,
      } },
    ] satisfies RuntimeInput[];
    const stringify = vi.spyOn(JSON, "stringify");
    const parse = vi.spyOn(JSON, "parse");
    const clone = vi.spyOn(globalThis, "structuredClone");
    const steps = inputs.map((input) => reduceRuntime(saved, input));
    expect(steps.map((step) => step.diagnostics.map((entry) => entry.reason))).toEqual([
      [], [], [], ["reportDateTimeMissing"], ["xmlInvalid"], [], [], [], [],
    ]);
    for (const step of steps) {
      expect(step.state).toBe(saved);
      expect(step.checkpointRequests).toEqual([]);
      expect(step.views).toEqual([]);
    }
    // Diagnostic string byte accounting is allowed; state serialization is not.
    expect(stringify.mock.calls.every(([value]) => typeof value === "string")).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  });

  it("P2-A1-T03 corpusHistory / AC03: O02:8 and O02:10 reject in fixed priority without state change", () => {
    const inspect = vi.fn();
    const saved = savedState(inspect);
    const headMissing = fixture("test/fixtures/81_05_01_260605_VPWP50_head_missing.xml", "VPWP50");
    const invalidDate = fixture("test/fixtures/telegram-foundation/invalid-report-datetime.xml", "VXSE51");
    expect(validateSemanticEnvelope(headMissing)).toMatchObject({ kind: "rejected", reason: "headMissing" });
    expect(validateSemanticEnvelope(invalidDate)).toMatchObject({ kind: "rejected", reason: "reportDateTimeInvalid" });
    expect(validateSemanticEnvelope({ ...valid, reportDateTimeRaw: "2026-02-30T00:00:00+09:00" })).toMatchObject({ kind: "rejected", reason: "reportDateTimeInvalid" });
    expect(validateSemanticEnvelope({ ...headMissing, reportDateTimeRaw: "not-a-date" })).toMatchObject({ kind: "rejected", reason: "headMissing" });
    expect(validateSemanticEnvelope({ ...valid, reportDateTimeRaw: "" })).toMatchObject({ kind: "rejected", reason: "reportDateTimeMissing" });
    for (const material of [headMissing, invalidDate]) {
      const step = reduceRuntime(saved, parserInput({ kind: "decoded", material }));
      expect(step.state).toBe(saved);
      expect(step.changedUnits).toEqual([]);
      expect(step.notificationIntents).toEqual([]);
      expect(step.diagnostics).toHaveLength(1);
    }
    expect(inspect).not.toHaveBeenCalled();
  });

  it("P2-A1-T04 contractBoundary: preserves independent state references for three operations", () => {
    const units = {
      "U-E": {
        normal: { subject: "same", value: 1 },
        training: { subject: "same", value: 2 },
        test: { subject: "same", value: 3 },
      },
    } as const;
    const separated: RuntimeState<typeof units> = { units, persistence: {}, shutdown: "running" };
    for (const operation of ["normal", "training", "test"] as const satisfies readonly Operation[]) {
      const material = { ...valid, operation };
      expect(validateSemanticEnvelope(material)).toMatchObject({ kind: "accepted", envelope: { material: { operation } } });
      expect(reduceRuntime(separated, parserInput({ kind: "decoded", material })).state.units["U-E"]).toBe(units["U-E"]);
    }
  });

  it("P2-A1-T05a contractBoundary / AC05: projection strips extra fields from structurally typed variables", () => {
    const details = {
      level: "WARN", component: "parser", reason: "xmlInvalid", inputId: "input",
      unit: "U-E", generation: 1, attemptId: "attempt", durationMs: 2, count: 3,
      raw: "<Report>secret</Report>", token: "secret", timestamp: -1, runId: "forged",
      toJSON: () => { throw new Error("must not serialize caller"); },
    } satisfies DiagnosticDetails & {
      raw: string; token: string; timestamp: number; runId: string; toJSON: () => never;
    };
    const projected = {
      level: "WARN", component: "parser", reason: "xmlInvalid", inputId: "input",
      unit: "U-E", generation: 1, attemptId: "attempt", durationMs: 2, count: 3,
    };
    expect(boundDiagnosticDetails(details)).toEqual(projected);
    expect(completeDiagnostic(details, clock, "run")).toEqual({
      timestamp: clock.wallTimeMs, ...projected, runId: "run",
    });
  });

  it("P2-A1-T05b contractBoundary / AC05: all text fields fit escaped UTF-8 budget and retain identifiers", () => {
    for (const text of ["a", "地震😀", "\u0000\n\r\t\"\\", "\ud800"]) {
      const long = text.repeat(9000);
      const details = {
        level: "ERROR", component: "checkpoint", reason: "checkpointWriteFailed",
        inputId: long, attemptId: long, unit: "U-E", generation: Number.MAX_VALUE,
        durationMs: Number.MAX_VALUE, count: Number.MAX_VALUE,
      } satisfies DiagnosticDetails;
      for (const ids of [
        { component: "checkpoint", runId: "run" },
        { component: long, runId: long },
      ]) {
        const event = completeDiagnostic({ ...details, component: ids.component }, clock, ids.runId);
        expect(Buffer.byteLength(JSON.stringify(event) + "\n")).toBeLessThanOrEqual(8192);
        expect(event.level).toBe("ERROR");
        expect(event.reason).toBe("checkpointWriteFailed");
        for (const key of ["inputId", "attemptId", "component", "runId"] as const) {
          expect(event[key]).not.toBe("");
          if ((key === "component" ? ids.component : key === "runId" ? ids.runId : long).length > 900)
            expect(event[key]).toContain("[truncated:fieldLimit]");
        }
        if (ids.runId === "run") {
          expect(event.runId).toBe("run");
          expect(event.component).toBe("checkpoint");
        }
      }
      const semantic = validateSemanticEnvelope({ ...valid, inputId: long, reportDateTimeRaw: "" });
      if (semantic.kind !== "rejected") throw new Error("rejection expected");
      expect(Buffer.byteLength(JSON.stringify(semantic.diagnostic))).toBeLessThanOrEqual(8192);
      const [event] = reduceRuntime(state, parserInput({ kind: "decoded",
        material: { ...valid, inputId: long, reportDateTimeRaw: "" } }, "run")).diagnostics;
      expect(event).toMatchObject({ timestamp: clock.wallTimeMs, runId: "run", reason: "reportDateTimeMissing" });
    }
  });

  it("P2-A1-T06/T07 contractBoundary: TypeScript compiles positive and negative shared type contracts", () => {
    const result = spawnSync(process.execPath, [
      "node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--skipLibCheck",
      "--target", "ES2022", "--module", "commonjs", "--types", "node", "--esModuleInterop",
      "reconstruction/test/shared-runtime/type-contract.ts",
      "reconstruction/test/shared-runtime/shared-runtime.test.ts",
    ], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
