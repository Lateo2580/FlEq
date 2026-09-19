import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { DecodedMaterial, Operation } from "../../contracts/p1-parser-boundary.types";
import type { NotificationIntent, RuntimeState } from "../../contracts/p2-shared-runtime.types";
import type { EewUnitState } from "../../contracts/p2-eew-unit.types";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { RuntimeCompositionRoot } from "../../src/runtime/composition-root";
import { eewUnitCodec, reduceEewUnit, toEewView } from "../../src/units/eew/eew-unit";

const BASE_TIME = 1_713_363_299_001;

function emptyState(): EewUnitState {
  return {
    schemaVersion: "p2-eew-unit-v1", current: [], gates: [], intents: [], deliveryRecords: [],
    persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0,
      savedCapturedAt: null, savedAckAt: null, dirtySince: null },
  };
}

function decodeFixture(file: string, headType: "VXSE43" | "VXSE44" | "VXSE45",
  transform: (xml: string) => string = (xml) => xml, inputId = file): DecodedMaterial {
  const body = Buffer.from(transform(readFileSync(`test/fixtures/${file}.xml`, "utf8")));
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: BASE_TIME,
    origin: "replay", kind: "replay", body, headType });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}

function receive(state: EewUnitState, material: DecodedMaterial, nowMs = BASE_TIME) {
  return reduceEewUnit(state, { kind: "receive", material, nowMs });
}

function withOperation(xml: string, operation: Operation): string {
  return xml.replace("<Status>通常</Status>", `<Status>${{ normal: "通常", training: "訓練", test: "試験" }[operation]}</Status>`);
}

function pendingIntent(subject = "normal/VXSE43/20240417231454", createdAt = BASE_TIME): NotificationIntent {
  const [operation, family] = subject.split("/");
  if (operation !== "normal" && operation !== "training" && operation !== "test") throw new Error("invalid operation");
  const channel = operation === "normal" ? "sound" : "desktop";
  return {
    id: `U-E:${subject}:${createdAt}:${channel}`, unit: "U-E", subject, operation,
    source: { inputId: "intent-source", origin: "replay", operation, family, subject,
      reportDateTimeRaw: "2024-04-17T23:14:59+09:00", serialRaw: "1", infoTypeRaw: "発表" },
    transition: "activated", channel, payload: { operation },
    createdAt, expiresAt: createdAt + 15_000, nextAttemptAt: createdAt,
    attempts: 0, configRevision: "test", disposition: "pending",
  };
}

class MemoryCheckpointFileSystem implements CheckpointFileSystem {
  readonly files = new Map<string, Uint8Array>();
  failWrite = false;
  unlinkSync(path: string): void { this.files.delete(path); }
  readFile(path: string): Uint8Array | null { return this.files.get(path) ?? null; }
  async mkdir(): Promise<void> {}
  async open(path: string): Promise<WritableCheckpoint> {
    let bytes = new Uint8Array();
    return {
      write: async (value) => { if (this.failWrite) throw new Error("injected write failure"); bytes = value.slice(); },
      sync: async () => {},
      close: async () => { this.files.set(path, bytes); },
    };
  }
  async rename(from: string, to: string): Promise<void> {
    const bytes = this.files.get(from);
    if (bytes == null) throw new Error("missing temporary");
    this.files.set(to, bytes); this.files.delete(from);
  }
  async syncDirectory(): Promise<void> {}
}

class MemoryDiagnosticFileSystem implements DiagnosticFileSystem {
  readonly filesByPath = new Map<string, string>();
  async mkdir(): Promise<void> {}
  async appendFile(path: string, data: string): Promise<void> {
    this.filesByPath.set(path, (this.filesByPath.get(path) ?? "") + data);
  }
  async writeFile(path: string, data: string): Promise<void> { this.filesByPath.set(path, data); }
  async rename(from: string, to: string): Promise<void> {
    this.filesByPath.set(to, this.filesByPath.get(from) ?? ""); this.filesByPath.delete(from);
  }
  async readFile(path: string): Promise<string> { return this.filesByPath.get(path) ?? ""; }
  async files(): Promise<readonly { name: string; size: number; mtimeMs: number }[]> { return []; }
  async unlink(path: string): Promise<void> { this.filesByPath.delete(path); }
}

function runtime(unit: EewUnitState): RuntimeState<Readonly<{ "U-E": EewUnitState }>> {
  return { units: { "U-E": unit }, persistence: { "U-E": unit.persistence }, shutdown: "running" };
}

function config() {
  return { appName: "fleq-p2", stateDirectory: "eew-state", legacyAppName: "fleq",
    legacyStateDirectory: "legacy-state", diagnosticDirectory: "eew-diagnostics" } as const;
}

describe("P2 EEW unit", () => {
  it("P2-A4-T01 contractBoundary / AC01: frozen validation order and legal reduced structures are atomic", () => {
    const first = decodeFixture("37_01_01_240613_VXSE43", "VXSE43");
    const cancelled43 = decodeFixture("37_01_03_240613_VXSE43", "VXSE43");
    const cancelled44 = decodeFixture("37_01_03_240613_VXSE43", "VXSE44");
    const regionless45 = decodeFixture("77_01_30_260101_VXSE45_FINAL", "VXSE45", (xml) =>
      xml.replace(/<Pref>[\s\S]*?<\/Pref>/g, "").replace("<NextAdvisory>この情報をもって、緊急地震速報：最終報とします。</NextAdvisory>", ""));

    const state = { ...receive(emptyState(), first).state, intents: [pendingIntent()] };
    expect(receive(state, cancelled43).decisions[0]).toMatchObject({ decision: "changed" });
    expect(receive(emptyState(), cancelled44).decisions[0]).toMatchObject({ decision: "changed" });
    const regionless = receive(emptyState(), regionless45);
    expect(regionless.state.current[0]?.prediction).toMatchObject({ areaCoverage: "none", areas: [] });

    const cases: readonly (readonly [DecodedMaterial, string])[] = [
      [{ ...first, xml: { ...first.xml,
        children: first.xml.children.filter((node) => node.kind !== "element" || node.name !== "Head") } }, "headMissing"],
      [decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
        xml.replace(/<EventID>[^<]*<\/EventID>/, "<EventID></EventID>").replace(/<Serial>[^<]*<\/Serial>/, "<Serial></Serial>")), "identityMissing"],
      [decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
        xml.replace(/<EventID>[^<]*<\/EventID>/, "<EventID>bad</EventID>").replace(/<Serial>[^<]*<\/Serial>/, "<Serial>0</Serial>")), "identityInvalid"],
      [decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
        xml.replace(/<EventID>[^<]*<\/EventID>/, "<EventID>bad</EventID>").replace(/<Serial>[^<]*<\/Serial>/, "<Serial/>")), "identityMissing"],
      [decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
        xml.replace(/<Serial>[^<]*<\/Serial>/, "<Serial>0</Serial>").replace(/<Intensity>[\s\S]*?<\/Intensity>/, "")), "identityInvalid"],
      [decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
        xml.replace(/<Intensity>[\s\S]*?<\/Intensity>/, "")), "requiredStructureMissing"],
      [decodeFixture("77_01_30_260101_VXSE45_FINAL", "VXSE45", (xml) =>
        xml.replace("<Code>999</Code>", "<Code>bad</Code>").replace("<NextAdvisory>この情報をもって、緊急地震速報：最終報とします。</NextAdvisory>", "")), "requiredStructureInvalid"],
    ];
    for (const [material, reason] of cases) {
      const before = state;
      const rejected = receive(state, material);
      expect(rejected.decisions[0]).toMatchObject({ decision: "rejected", reason });
      expect(rejected.state).toBe(before);
      expect(rejected.intents).toEqual([]);
      expect(rejected.outcomes).toEqual([]);
    }

    // Empty scalar is legal; a child element in the scalar slot is not.
    for (const family of ["VXSE43", "VXSE44", "VXSE45"] as const) {
      for (const field of ["From", "To"] as const)
        for (const replacement of ["", `<${field}/>`, `<${field}></${field}>`, `<${field}>不明</${field}>`, `<${field}>3以下</${field}>`]) {
        const material = decodeFixture("37_01_01_240613_VXSE43", family, (xml) =>
          xml.replace(new RegExp(`<${field}>[^<]*</${field}>`, "g"), replacement));
        const step = receive(emptyState(), material);
        expect(step.decisions[0].decision).toBe("changed");
        if (replacement === `<${field}/>`)
          expect(step.state.current[0].prediction.maximum[field === "From" ? "from" : "to"]).toEqual({ kind: "empty", raw: "" });
      }
      for (const transform of [
        (xml: string) => xml.replace(/<From>[^<]*<\/From>/, "<From><bad/></From>"),
        (xml: string) => xml.replace(/(<Intensity>[\s\S]*?<\/Intensity>)/, "$1$1"),
        (xml: string) => xml.replace(/(<Forecast>[\s\S]*?<\/Forecast>)/, "$1$1"),
        (xml: string) => xml.replace(/(<ForecastInt>[\s\S]*?<\/ForecastInt>)/, "$1$1"),
        (xml: string) => xml.replace(/<ForecastInt>[\s\S]*?<\/ForecastInt>/, "<ForecastInt>bad</ForecastInt>"),
        (xml: string) => xml.replace(/<ForecastInt>[\s\S]*?<\/ForecastInt>/, "<ForecastInt><bad/></ForecastInt>"),
      ]) {
        const step = receive(state, decodeFixture("37_01_01_240613_VXSE43", family, transform));
        expect(step.decisions[0]).toMatchObject({ decision: "rejected", reason: "requiredStructureInvalid" });
        expect(step.state).toBe(state);
      }
      // Every Pref.Code x Area.Code case, including missing/empty/non-scalar/duplicate.
      const codes = ["valid", "missing", "empty", "bad", "nested", "duplicate"] as const;
      const codeXml = (code: string, mode: typeof codes[number]): string => mode === "valid" ? `<Code>${code}</Code>`
        : mode === "missing" ? "" : mode === "empty" ? "<Code/>" : mode === "bad" ? "<Code>bad</Code>"
          : mode === "nested" ? "<Code><bad/></Code>" : `<Code>${code}</Code><Code>${code}</Code>`;
      for (const pref of codes) for (const area of codes) {
        const material = decodeFixture("77_01_30_260101_VXSE45_FINAL", family, (xml) => xml
          .replace(/<NextAdvisory>[\s\S]*?<\/NextAdvisory>/, "")
          .replace("<Code>9999</Code>", codeXml("9999", pref)).replace("<Code>999</Code>", codeXml("999", area)));
        const step = receive(state, material);
        if (pref === "valid" && area === "valid") expect(step.decisions[0].decision).toBe("changed");
        else {
          expect(step.decisions[0]).toMatchObject({ decision: "rejected", reason: "requiredStructureInvalid" });
          expect(step.state).toBe(state);
        }
      }
      // Node absence differs from an existing malformed optional Pref/Area (VXSE45).
      for (const pref of ["valid", "missing", "empty", "bad"] as const)
        for (const area of ["valid", "missing", "empty", "bad"] as const) {
          const material = decodeFixture("77_01_30_260101_VXSE45_FINAL", family, (xml) => {
            let changed = xml.replace(/<NextAdvisory>[\s\S]*?<\/NextAdvisory>/, "");
            // Only operate on Intensity: the earthquake's hypocenter also contains Area.
            return changed.replace(/<Intensity>[\s\S]*?<\/Intensity>/, (intensity) => {
              if (pref !== "valid") return intensity.replace(/<Pref>[\s\S]*?<\/Pref>/,
                pref === "missing" ? "" : pref === "empty" ? "<Pref/>" : "<Pref>bad</Pref>");
              if (area !== "valid") return intensity.replace(/<Area>[\s\S]*?<\/Area>/,
                area === "missing" ? "" : area === "empty" ? "<Area/>" : "<Area>bad</Area>");
              return intensity;
            });
          });
          const step = receive(state, material);
          const legal = pref === "valid" && area === "valid" || family === "VXSE45" && pref === "missing";
          if (legal) expect(step.decisions[0].decision).toBe("changed");
          else {
            const missing = family !== "VXSE45" || pref === "valid" && area !== "missing";
            expect(step.decisions[0]).toMatchObject({ decision: "rejected",
              reason: missing ? "requiredStructureMissing" : "requiredStructureInvalid" });
            expect(step.state).toBe(state);
          }
        }
    }
  });

  it("P2-A4-T02 acceptance / AC02: serial, terminal, cancellation, retained prediction and 511/512/513", () => {
    const first = decodeFixture("37_01_01_240613_VXSE43", "VXSE43");
    const second = decodeFixture("37_01_02_240613_VXSE43", "VXSE43");
    const cancelled = decodeFixture("37_01_03_240613_VXSE43", "VXSE43");
    const final45 = decodeFixture("77_01_30_260101_VXSE45_FINAL", "VXSE45");
    let state = receive(emptyState(), first).state;
    expect(state.current[0]?.prediction.maximum).toMatchObject({
      from: { kind: "text", raw: "5-" }, to: { kind: "text", raw: "5-" },
    });
    expect(state.current[0]?.prediction.areas.find((area) => area.code === "592")?.intensity)
      .toMatchObject({ from: { raw: "3" }, to: { raw: "4" } });
    expect(state.current[0]?.prediction.areas.find((area) => area.code === "622")?.intensity.condition)
      .toBe("既に主要動到達と推測");
    const unknown = decodeFixture("37_01_02_240613_VXSE43", "VXSE43", (xml) =>
      xml.replace(/<(From|To)>[^<]*<\/(From|To)>/g, "<$1>不明</$1>"));
    const unknownStep = receive(state, unknown);
    expect(unknownStep.state.current[0]).toBe(state.current[0]);
    expect(unknownStep.state.current[0].source).toEqual(state.current[0].source);
    expect(unknownStep.state.current[0].prediction.maximum.from).toMatchObject({ raw: "5-" });
    expect(unknownStep.state.gates[0].serial).toBe(2);
    expect(unknownStep.outcomes[0].subjects[0].facts.prediction).toMatchObject({ maximum: {
      from: { kind: "unknown", raw: "不明" }, to: { kind: "unknown", raw: "不明" },
    } });
    expect(unknownStep.state.current).toHaveLength(1);
    const special = decodeFixture("37_01_02_240613_VXSE43", "VXSE43", (xml) =>
      xml.replace("<ForecastInt><From>6-</From><To>6-</To></ForecastInt>",
        "<ForecastInt><From>3以下</From></ForecastInt>"));
    expect(receive(state, special).state.current[0]?.prediction.maximum).toMatchObject({
      from: { kind: "range", bound: "upper", value: 3, raw: "3以下" }, to: { kind: "missing" },
    });
    const qualified = decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => xml.replace("<ForecastInt>",
      '<ForecastInt condition="予測幅" description="最大予測震度幅">'));
    expect(receive(emptyState(), qualified).state.current[0].prediction.maximum)
      .toMatchObject({ condition: "予測幅", description: "最大予測震度幅" });
    state = receive(state, second).state;
    expect(receive(state, first).decisions[0]).toMatchObject({ decision: "unchanged", reason: "stale" });
    expect(receive(state, second).decisions[0]).toMatchObject({ decision: "unchanged", reason: "duplicate" });
    const third = decodeFixture("37_01_02_240613_VXSE43", "VXSE43", (xml) => xml.replace("<Serial>2</Serial>", "<Serial>3</Serial>"));
    const gap = receive(receive(emptyState(), first).state, third);
    expect(gap.decisions[0]).toMatchObject({ decision: "changed", change: "semantic" });
    expect(gap.state.current[0].serial).toBe(3);
    state = receive(state, cancelled).state;
    expect(state.current).toEqual([]);
    const correction = decodeFixture("37_01_02_240613_VXSE43", "VXSE43", (xml) =>
      xml.replace("2024-04-17T23:15:10+09:00", "2024-04-17T23:18:00+09:00"));
    expect(receive(state, correction).state.current.some((item) => item.operation === "normal")).toBe(true);

    const terminal = receive(state, final45);
    expect(terminal.state.current.some((item) => item.family === "VXSE45")).toBe(false);
    expect(terminal.state.gates.find((item) => item.family === "VXSE45")?.terminal).toBe(true);

    let bounded = emptyState();
    for (let count = 1; count <= 513; count++) {
      const next = decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
        xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${String(count).padStart(14, "0")}</EventID>`));
      bounded = receive(bounded, next).state;
      if (count >= 511) {
        expect(bounded.gates).toHaveLength(Math.min(count, 512));
        expect(bounded.current).toHaveLength(Math.min(count, 512));
        expect(bounded.gates.some((gate) => gate.subject.endsWith("/00000000000001"))).toBe(count < 513);
        expect(bounded.current.at(-1)?.subject).toBe(`normal/VXSE43/${String(count).padStart(14, "0")}`);
      }
    }
  });

  it("P2-A4-T03 contractBoundary / AC04: codec roundtrip excludes current/gate and rejects exact next-byte overflow", () => {
    const active = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE43")).state;
    const state = { ...active, intents: [pendingIntent()] };
    const value = eewUnitCodec.encode(state);
    const decoded = eewUnitCodec.decode(value);
    expect(decoded).toMatchObject({ kind: "restored", state: { current: [], gates: [], intents: [{ id: state.intents[0].id }] } });

    const withRecord = (length: number): EewUnitState => ({ ...emptyState(),
      deliveryRecords: [{ intentId: "x".repeat(length), disposition: "delivered", expiresAt: 1 }] });
    let low = 0;
    let high = 262_144;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      try { eewUnitCodec.encode(withRecord(middle)); low = middle; }
      catch { high = middle; }
    }
    expect(() => eewUnitCodec.encode(withRecord(low))).not.toThrow();
    expect(() => eewUnitCodec.encode(withRecord(low + 1))).toThrow(/persisted boundary/);
    for (const count of [127, 128, 129]) {
      const many = { ...emptyState(), intents: Array.from({ length: count }, (_, index) =>
        pendingIntent(`normal/VXSE43/${String(index).padStart(14, "0")}`)) };
      if (count === 129) expect(() => eewUnitCodec.encode(many)).toThrow(/persisted boundary/);
      else expect(eewUnitCodec.decode(eewUnitCodec.encode(many))).toMatchObject({ kind: "restored", state: { intents: many.intents } });
    }
    const small = { ...pendingIntent(), payload: { padding: "" } };
    const padding = 131_072 - Buffer.byteLength(JSON.stringify([small]));
    for (const extra of [0, 1]) {
      const intents = [{ ...small, payload: { padding: "x".repeat(padding + extra) } }];
      expect(Buffer.byteLength(JSON.stringify(intents))).toBe(131_072 + extra);
      if (extra === 0) expect(() => eewUnitCodec.encode({ ...emptyState(), intents })).not.toThrow();
      else expect(() => eewUnitCodec.encode({ ...emptyState(), intents })).toThrow(/persisted boundary/);
    }
  });

  it("P2-A4-T04 acceptance / AC05-06: all outcome variants, explicit operation view and absolute TTL", () => {
    const accepted = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE43"));
    const operations = ["normal", "training", "test"] as const;
    let mixed = emptyState();
    for (const operation of operations) mixed = receive(mixed,
      decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => withOperation(xml, operation))).state;
    expect(toEewView(mixed).current.map((item) => item.operation)).toEqual(operations);
    expect(accepted.intents).toEqual([]); // Q-NOTICE remains unresolved; no channel is guessed.

    const intentValue = pendingIntent("normal/VXSE43/20240417231454", 1_000);
    const intentState = { ...emptyState(), intents: [intentValue] };
    expect(reduceEewUnit(intentState, { kind: "deadline", nowMs: 15_999 }).state.intents).toHaveLength(1);
    expect(reduceEewUnit(intentState, { kind: "deadline", nowMs: 16_000 }).state.intents).toHaveLength(0);
    expect(reduceEewUnit(intentState, { kind: "deadline", nowMs: 16_001 }).state.intents).toHaveLength(0);

    const restored = reduceEewUnit(emptyState(), { kind: "restore", persisted: eewUnitCodec.encode(intentState), nowMs: 15_999 });
    const deadline = reduceEewUnit(intentState, { kind: "deadline", nowMs: 16_000 });
    const shutdown = reduceEewUnit(emptyState(), { kind: "shutdown", nowMs: 16_000 });
    expect([accepted.outcomes[0].kind, restored.outcomes[0].kind, deadline.outcomes[0].kind, shutdown.outcomes[0].kind])
      .toEqual(["accepted", "recoveryApplied", "deadlineApplied", "batchCompleted"]);
  });

  it("P2-A4-T05 corpusHistory / AC07-09: O07/A3 save failure, old ack, restore follow-up and normal shutdown", async () => {
    const first = decodeFixture("37_01_01_240613_VXSE43", "VXSE43");
    const second = decodeFixture("37_01_02_240613_VXSE43", "VXSE43");
    const cancelled = decodeFixture("37_01_03_240613_VXSE43", "VXSE43");
    const adapter = new MemoryCheckpointFileSystem();
    const diagnostics = new MemoryDiagnosticFileSystem();
    let now = BASE_TIME + 1;
    const root = new RuntimeCompositionRoot<Readonly<{ "U-E": EewUnitState }>>(config(), { "U-E": eewUnitCodec }, {
      checkpointFileSystem: adapter, diagnosticFileSystem: diagnostics,
      clock: () => ({ wallTimeMs: now, monotonicMs: now }),
    });
    const initial = emptyState();
    expect(root.restoreUnit("U-E").kind).not.toBe("restored");
    const accepted = receive(initial, first);
    const received = accepted.state;
    const unit = { ...received, intents: [pendingIntent()],
      persistence: { kind: "pending" as const, currentGeneration: 1, savedGeneration: null,
        savedCapturedAt: null, savedAckAt: null, dirtySince: BASE_TIME } };
    let running = runtime(unit);
    const correlation = { "U-E": { inputIds: [first.inputId], retryReason: "notRetry" as const } };
    const scheduled = root.scheduleCheckpoint(running, { wallTimeMs: now, monotonicMs: now }, "o07", correlation)!;
    const saved = await root.executeCheckpoint(scheduled.request!, "o07", [first.inputId], "notRetry");
    running = root.applyCheckpointResult(running, saved.result, { wallTimeMs: ++now, monotonicMs: now }).state;
    expect(root.restoreUnit("U-E").kind).toBe("restored");
    expect(root.checkpoint.restoredState("U-E")).toMatchObject({ current: [], gates: [],
      intents: [{ expiresAt: BASE_TIME + 15_000 }] });
    const payload = eewUnitCodec.decode(scheduled.request!.envelope.payload);
    if (payload.kind !== "restored") throw new Error(payload.reason);
    const restored = reduceEewUnit(emptyState(), { kind: "restore", persisted: eewUnitCodec.encode(payload.state),
      nowMs: BASE_TIME + 2 });
    expect(restored.intents[0].expiresAt).toBe(BASE_TIME + 15_000);
    expect(receive(restored.state, second, BASE_TIME + 3).state.current[0].serial).toBe(2);

    // Match the checked-in subset, not a hand-maintained copy of its semantic oracle.
    const refs = corpus.meta.p2Subsets.find((item) => item.subsetId === "P2-O07-U-E-v1")!.stepRefs;
    expect(refs).toEqual([15, 16, 17, 18].map((position) => `expected:O07:${position}`));
    const decision = accepted.decisions[0];
    const actual = [
      { decision: null, effective: null, subjects: [], intents: initial.intents.length !== 0, notices: false },
      { decision: { kind: decision.decision, reason: decision.reason,
        change: "change" in decision ? decision.change : null }, effective: { kind: received.current.length > 0 ? "active" : "inactive" },
      subjects: received.current.map((current) => ({ subject: current.subject, revision: {
        reportDateTimeRaw: current.source.reportDateTimeRaw, serialRaw: current.source.serialRaw, infoTypeRaw: current.source.infoTypeRaw,
      } })), intents: null, notices: null },
      { decision: null, effective: null, subjects: [], intents: null, notices: null },
      { decision: null, effective: null, subjects: [], intents: null, notices: null },
    ];
    for (const [index, ref] of refs.entries()) {
      const oracle = corpus.expectations.find((item) => item.expectedId === ref)!;
      expect(actual[index]).toEqual({ decision: oracle.decision == null ? null : {
        kind: oracle.decision.kind, reason: "reason" in oracle.decision ? oracle.decision.reason : null,
        change: "change" in oracle.decision ? oracle.decision.change : null },
      effective: oracle.effective, subjects: oracle.subjects, intents: oracle.intents, notices: oracle.notices });
    }
    expect(running.persistence["U-E"]).toMatchObject({ kind: "saved", savedGeneration: 1 });
    const savedPayload = scheduled.request!.envelope.payload;
    if (savedPayload == null || typeof savedPayload !== "object") throw new Error("invalid checkpoint payload");
    expect(Object.keys(savedPayload)).toEqual(["schemaVersion", "intents", "deliveryRecords"]);
    expect(restored.state.current).toEqual([]);
    expect(restored.state.gates).toEqual([]);

    const oldAckRoot = new RuntimeCompositionRoot<Readonly<{ "U-E": EewUnitState }>>(config(), { "U-E": eewUnitCodec }, {
      checkpointFileSystem: new MemoryCheckpointFileSystem(), diagnosticFileSystem: new MemoryDiagnosticFileSystem(),
      clock: () => ({ wallTimeMs: now, monotonicMs: now }),
    });
    let oldAckState = runtime(unit);
    const old = oldAckRoot.scheduleCheckpoint(oldAckState, { wallTimeMs: now, monotonicMs: now }, "old", correlation)!;
    const oldResult = await oldAckRoot.executeCheckpoint(old.request!, "old", [first.inputId], "notRetry");
    const cancelledUnit = receive(unit, cancelled, ++now).state;
    oldAckState = { ...oldAckState, units: { "U-E": cancelledUnit }, persistence: { "U-E": cancelledUnit.persistence } };
    oldAckState = oldAckRoot.applyCheckpointResult(oldAckState, oldResult.result,
      { wallTimeMs: ++now, monotonicMs: now }).state;
    expect(oldAckState.units["U-E"].current).toEqual([]);
    expect(oldAckState.persistence["U-E"]).toMatchObject({ currentGeneration: 2, savedGeneration: 1, kind: "pending" });

    const failedAdapter = new MemoryCheckpointFileSystem();
    const failedRoot = new RuntimeCompositionRoot<Readonly<{ "U-E": EewUnitState }>>(config(), { "U-E": eewUnitCodec }, {
      checkpointFileSystem: failedAdapter, diagnosticFileSystem: new MemoryDiagnosticFileSystem(),
      clock: () => ({ wallTimeMs: now, monotonicMs: now }),
    });
    let failedState = runtime(unit);
    const failedRequest = failedRoot.scheduleCheckpoint(failedState,
      { wallTimeMs: now, monotonicMs: now }, "failed", correlation)!;
    failedAdapter.failWrite = true;
    const failure = await failedRoot.executeCheckpoint(failedRequest.request!, "failed", [first.inputId], "notRetry");
    failedState = failedRoot.applyCheckpointResult(failedState, failure.result,
      { wallTimeMs: ++now, monotonicMs: now }).state;
    const afterFailureCancel = receive({ ...unit, persistence: failedState.persistence["U-E"]! }, cancelled, ++now).state;
    expect(afterFailureCancel.current).toEqual([]);
    expect(afterFailureCancel.persistence).toMatchObject({ kind: "failed", currentGeneration: 2, savedGeneration: null });
    expect(afterFailureCancel.deliveryRecords).toContainEqual({
      intentId: unit.intents[0].id, disposition: "superseded", expiresAt: unit.intents[0].expiresAt,
    });

    let shutdownState = runtime(unit);
    const shutdownRoot = new RuntimeCompositionRoot<Readonly<{ "U-E": EewUnitState }>>(config(), { "U-E": eewUnitCodec }, {
      checkpointFileSystem: new MemoryCheckpointFileSystem(), diagnosticFileSystem: new MemoryDiagnosticFileSystem(),
      clock: () => ({ wallTimeMs: now, monotonicMs: now }),
      shutdownHooks: { finalizeBatchesAndSideEffects: async () => ({ remainingBatches: 0, state: shutdownState,
        correlationByUnit: correlation }) },
    });
    const summary = await shutdownRoot.shutdownRuntime(shutdownState, 1,
      { wallTimeMs: ++now, monotonicMs: now });
    expect(summary.code).toBe(0);
    expect(summary.persistence["U-E"]).toMatchObject({ kind: "saved", currentGeneration: 1, savedGeneration: 1 });
  });

  it("P2-A4-T06 regression / AC02-03,06: P1 operation isolation and different-inputId duplicates before TTL", () => {
    const operations = ["normal", "training", "test"] as const;
    let state = emptyState();
    for (const operation of operations) {
      const step = receive(state, decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => withOperation(xml, operation)));
      expect(step.decisions[0]).toMatchObject({ decision: "changed", change: "semantic", operation });
      expect(step.state.current.at(-1)?.source.operation).toBe(operation);
      state = step.state;
    }
    // Q-NOTICE is unresolved: inject durable pending records, never pretend generation is covered.
    state = { ...state, intents: state.current.map((current) => pendingIntent(current.subject)) };
    for (const operation of operations) {
      const duplicate = receive(state, decodeFixture("37_01_01_240613_VXSE43", "VXSE43",
        (xml) => withOperation(xml, operation), `redelivery-${operation}`), BASE_TIME + 14_999);
      expect(duplicate.decisions[0]).toMatchObject({ decision: "unchanged", reason: "duplicate", operation });
      expect(duplicate.state).toBe(state);
      expect(duplicate.state.intents).toBe(state.intents);
      expect(duplicate.intents).toEqual([]);
    }
    const cancelled = receive(state, decodeFixture("37_01_03_240613_VXSE43", "VXSE43"), BASE_TIME + 14_999);
    expect(cancelled.state.current).toEqual(state.current.filter((current) => current.operation !== "normal"));
    expect(cancelled.state.gates.filter((gate) => gate.operation !== "normal"))
      .toEqual(state.gates.filter((gate) => gate.operation !== "normal"));
    expect(cancelled.state.intents).toEqual(state.intents.filter((intent) => intent.operation !== "normal"));
    expect(cancelled.state.deliveryRecords).toEqual([{ intentId: state.intents[0].id,
      disposition: "superseded", expiresAt: state.intents[0].expiresAt }]);
    for (const operation of ["training", "test"] as const) {
      const duplicate = receive(cancelled.state, decodeFixture("37_01_01_240613_VXSE43", "VXSE43",
        (xml) => withOperation(xml, operation), `after-cancel-${operation}`));
      expect(duplicate.state).toBe(cancelled.state);
      expect(duplicate.decisions[0]).toMatchObject({ reason: "duplicate" });
    }
    const cancelAgain = receive(cancelled.state, decodeFixture("37_01_03_240613_VXSE43", "VXSE43", (xml) => xml, "cancel-again"));
    expect(cancelAgain.state).toBe(cancelled.state);
    expect(cancelAgain.decisions[0]).toMatchObject({ reason: "duplicate" });
  });

  it("P2-A4-T07 regression / AC04,06,08: restore rejects terminal-record conflicts and extended TTL", () => {
    for (const operation of ["normal", "training", "test"] as const) {
      const intent = pendingIntent(`${operation}/VXSE43/20240417231454`);
      const value = eewUnitCodec.encode({ ...emptyState(), intents: [intent] });
      for (const disposition of ["delivered", "superseded", "expired"] as const)
        for (const age of [14_999, 15_000, 15_001]) {
          const conflicting = { ...value, deliveryRecords: [{ intentId: intent.id, disposition, expiresAt: intent.expiresAt }] };
          expect(eewUnitCodec.decode(conflicting).kind).toBe("invalid");
          const restored = reduceEewUnit(emptyState(), { kind: "restore", persisted: conflicting, nowMs: BASE_TIME + age });
          expect(restored.intents).toEqual([]);
          expect(restored.decisions[0].decision).toBe("rejected");
        }
      for (const ttl of [14_999, 15_000, 15_001]) {
        const altered = { ...value, intents: [{ ...intent, expiresAt: intent.createdAt + ttl }] };
        expect(eewUnitCodec.decode(altered).kind).toBe(ttl > 15_000 ? "invalid" : "restored");
        const restored = reduceEewUnit(emptyState(), { kind: "restore", persisted: altered, nowMs: BASE_TIME + 14_999 });
        expect(restored.intents).toHaveLength(ttl === 15_000 ? 1 : 0);
        if (ttl === 15_000) expect(restored.intents[0].expiresAt).toBe(intent.expiresAt);
      }
      expect(eewUnitCodec.decode({ ...value, intents: [intent, intent] }).kind).toBe("invalid");
      if (operation !== "normal") expect(eewUnitCodec.decode({ ...value, intents: [{ ...intent, channel: "sound" }] }).kind).toBe("invalid");
    }
  });

  it("P2-A4-T08 contractBoundary / AC02-04,06,08: crossed order, operation, termination, TTL, capacity, restore, codec limits", () => {
    let cases = 0;
    for (const operation of ["normal", "training", "test"] as const) {
      const first = decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => withOperation(xml, operation));
      const again = decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => withOperation(xml, operation), "different-input-id");
      const third = decodeFixture("37_01_02_240613_VXSE43", "VXSE43", (xml) =>
        withOperation(xml, operation).replace("<Serial>2</Serial>", "<Serial>3</Serial>"));
      const cancellation = decodeFixture("37_01_03_240613_VXSE43", "VXSE43", (xml) =>
        withOperation(xml, operation).replace("<Serial>2</Serial>", "<Serial>3</Serial>"));
      const final = decodeFixture("37_01_02_240613_VXSE43", "VXSE43", (xml) =>
        withOperation(xml, operation).replace("<Serial>2</Serial>", "<Serial>3</Serial>")
          .replace("</Body>", "<NextAdvisory>最終報</NextAdvisory></Body>"));
      let fillers = emptyState();
      for (let count = 1; count <= 512; count++) {
        fillers = receive(fillers, decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
          withOperation(xml, operation).replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${String(count).padStart(14, "0")}</EventID>`))).state;
        if (count < 510) continue;
        const base = receive(fillers, first).state; // attempts 511, 512, 513; target is newest.
        expect(base.gates).toHaveLength(Math.min(count + 1, 512));
        const target = base.current.at(-1)!;
        for (const order of ["reverse", "gap", "duplicate"] as const)
          for (const terminal of [cancellation, final])
            for (const age of [14_999, 15_000, 15_001])
              for (const restart of [false, true])
                for (const extraByte of [0, 1]) {
                  let state = order === "reverse" ? receive(base, third).state : base;
                  state = { ...state, intents: [pendingIntent(target.subject)] };
                  const ordered = receive(state, order === "gap" ? third : again, BASE_TIME + age);
                  expect(ordered.decisions[0]).toMatchObject(order === "gap"
                    ? { decision: "changed", change: "semantic" }
                    : { decision: "unchanged", reason: order === "reverse" ? "stale" : "duplicate" });
                  if (order !== "gap") expect(ordered.state).toBe(state);
                  expect(ordered.state.intents).toHaveLength(order === "gap" ? 0 : 1);
                  state = ordered.state;

                  const payload = { ...eewUnitCodec.encode(state), deliveryRecords: [
                    ...state.deliveryRecords, { intentId: "", disposition: "delivered" as const, expiresAt: 1 },
                  ] };
                  const envelope = { schemaVersion: "p2-eew-unit-v1", unit: "U-E", generation: Number.MAX_SAFE_INTEGER,
                    capturedAt: Number.MAX_SAFE_INTEGER, payload, sha256: "0".repeat(64) };
                  const pad = 262_144 - Buffer.byteLength(JSON.stringify(envelope));
                  const padded = { ...payload, deliveryRecords: payload.deliveryRecords.map((record) => record.intentId === ""
                    ? { ...record, intentId: "x".repeat(pad + extraByte) } : record) };
                  expect(Buffer.byteLength(JSON.stringify({ ...envelope, payload: padded }))).toBe(262_144 + extraByte);
                  expect(eewUnitCodec.decode(padded).kind).toBe(extraByte === 0 ? "restored" : "invalid");
                  if (restart) {
                    const recovery = reduceEewUnit(emptyState(), { kind: "restore", persisted: padded, nowMs: BASE_TIME + age });
                    expect(recovery.state.current).toEqual([]);
                    expect(recovery.state.gates).toEqual([]);
                    expect(recovery.intents).toHaveLength(extraByte === 0 && age === 14_999 && order !== "gap" ? 1 : 0);
                    for (const intent of recovery.intents) expect(intent.expiresAt).toBe(BASE_TIME + 15_000);
                    state = recovery.state;
                    const followup = receive(state, third, BASE_TIME + age);
                    expect(followup.state.current[0].serial).toBe(3);
                    expect(followup.decisions[0]).toMatchObject({ decision: "changed", change: "semantic" });
                    state = followup.state;
                  }
                  const timed = reduceEewUnit(state, { kind: "deadline", nowMs: BASE_TIME + age });
                  expect(timed.state.intents).toHaveLength(!restart && age === 14_999 && order !== "gap" ? 1 : 0);
                  const ended = receive(timed.state, terminal, BASE_TIME + age);
                  expect(ended.state.current.some((current) => current.subject === target.subject)).toBe(false);
                  expect(ended.state.gates.find((gate) => gate.subject === target.subject)?.terminal).toBe(true);
                  expect(ended.state.intents).toHaveLength(0);
                  const endedAgain = receive(ended.state, terminal, BASE_TIME + age);
                  expect(endedAgain.state).toBe(ended.state);
                  expect(endedAgain.decisions[0]).toMatchObject({ reason: "duplicate" });
                  cases++;
                }
      }
    }
    expect(cases).toBe(648);
  });

  it("P2-A4-T09 corpusHistory / AC09: E13 EEW manifest population has no persistent semantic unavailable", () => {
    const counts = { fixtures: 0, normalCorpus: 0, rejected: 0, invalidSynthetic: 0,
      semanticUnavailable: 0, deliverySummary: "N/A: A8 not connected" };
    for (const fixture of manifest.fixtures) {
      const family = fixture.transport.headType;
      if (family !== "VXSE43" && family !== "VXSE44" && family !== "VXSE45") continue;
      const material = decodeFixture(fixture.path.replace(/^test\/fixtures\//, "").replace(/\.xml$/, ""), family);
      expect(material.operation).toBe("normal");
      const step = receive(emptyState(), material);
      counts.fixtures++;
      if (fixture.fixtureId === "test__fixtures__synthetic_phase4a_VXSE45_regionless"
        || fixture.fixtureId === "test__fixtures__synthetic_phase4a_VXSE45_special") {
        expect(material.eventIdRaw.startsWith("synthetic-phase4a-eew")).toBe(true);
        expect(step.decisions[0]).toMatchObject({ decision: "rejected", reason: "identityInvalid" });
        counts.invalidSynthetic++;
        continue;
      }
      counts.normalCorpus++;
      counts.rejected += step.decisions.filter((decision) => decision.decision === "rejected").length;
      expect(step.state.gates, `${fixture.path}: ${JSON.stringify(step.decisions)}`).toHaveLength(1);
      const afterDeadline = reduceEewUnit(step.state, { kind: "deadline", nowMs: BASE_TIME + 15_001 });
      const view = toEewView(afterDeadline.state);
      counts.semanticUnavailable += view.subjects.filter((subject) => subject.transition === "unavailable").length;
      expect(view.activeCount).toBe(step.state.gates[0].terminal ? 0 : 1);
      expect(eewUnitCodec.decode(eewUnitCodec.encode(afterDeadline.state)).kind).toBe("restored");
    }
    expect(counts).toEqual({ fixtures: 12, normalCorpus: 10, rejected: 0, invalidSynthetic: 2,
      semanticUnavailable: 0, deliverySummary: "N/A: A8 not connected" });
  });

  it("P2-A4-T11 regression / AC02: same-version corrections compare received raw before retention", () => {
    for (const operation of ["normal", "training", "test"] as const)
      for (const family of ["VXSE43", "VXSE44", "VXSE45"] as const) {
        const correction = (xml: string): string => withOperation(xml, operation)
          .replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>");
        const first = decodeFixture("37_01_01_240613_VXSE43", family, correction, "correction-original");
        const initial = receive(emptyState(), first).state;
        expect(initial.current[0].source).toBe(initial.gates[0].source);
        const baseline = { ...initial, intents: [pendingIntent(initial.current[0].subject)] };
        const identical = receive(baseline, decodeFixture("37_01_01_240613_VXSE43", family, correction, "same-raw-new-id"));
        expect(identical.state).toBe(baseline);
        expect(identical.decisions[0]).toMatchObject({ decision: "unchanged", reason: "duplicate" });

        for (const [from, to] of [["6-", "6-"], ["不明", "7"]] as const) {
          const change = (xml: string): string => correction(xml).replace(
            "<ForecastInt><From>5-</From><To>5-</To></ForecastInt>",
            `<ForecastInt><From>${from}</From><To>${to}</To></ForecastInt>`);
          const material = decodeFixture("37_01_01_240613_VXSE43", family, change, `corrected-${from}-${to}`);
          expect([material.serialRaw, material.reportDateTimeRaw, material.infoTypeRaw])
            .toEqual([first.serialRaw, first.reportDateTimeRaw, "訂正"]);
          const step = receive(baseline, material);
          expect(step.decisions[0]).toMatchObject({ decision: "changed", change: "semantic", reason: null });
          expect(step.outcomes).toHaveLength(1);
          expect(step.outcomes[0]).toMatchObject({ kind: "accepted", change: "semantic", subjects: [{
            source: { inputId: material.inputId }, facts: { prediction: { maximum: { from: { raw: from }, to: { raw: to } } } },
          }] });
          expect(step.state.gates[0].source.inputId).toBe(material.inputId);
          if (from === "不明") expect(step.state.current[0]).toBe(initial.current[0]);
          else expect(step.state.current[0].prediction.maximum).toMatchObject({ from: { raw: "6-" }, to: { raw: "6-" } });
          const repeated = receive(step.state, decodeFixture("37_01_01_240613_VXSE43", family, change, "correction-redelivery"));
          expect(repeated.state).toBe(step.state);
          expect(repeated.outcomes).toEqual([]);
          if (from === "不明") {
            const knownAgain = receive(step.state, decodeFixture("37_01_01_240613_VXSE43", family, correction, "known-again"));
            expect(knownAgain.decisions[0]).toMatchObject({ decision: "changed", change: "semantic" });
            expect(knownAgain.state.current[0].source.inputId).toBe("known-again");
            expect(knownAgain.outcomes).toHaveLength(1);
          }
        }
      }
  });

  it("P2-A4-T10 regression / AC02,04: unknown follow-ups retain known evidence but restore never revives it", () => {
    let cases = 0;
    for (const operation of ["normal", "training", "test"] as const)
      for (const family of ["VXSE43", "VXSE44", "VXSE45"] as const)
        for (const scope of ["all", "maximum", "area"] as const)
          for (const restart of [false, true]) {
            const initial = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", family,
              (xml) => withOperation(xml, operation))).state;
            let state = initial;
            if (restart) {
              const restored = eewUnitCodec.decode(eewUnitCodec.encode(initial));
              if (restored.kind !== "restored") throw new Error(restored.reason);
              state = restored.state;
              expect(state.current).toEqual([]);
            }
            const change = (xml: string): string => {
              const unknown = (part: string): string => part.replace(/<(From|To)>[^<]*<\/(From|To)>/g, "<$1>不明</$1>");
              const classified = withOperation(xml, operation);
              return scope === "all" ? unknown(classified)
                : scope === "maximum" ? classified.replace(/<ForecastInt>[\s\S]*?<\/ForecastInt>/, unknown)
                  : classified.replace(/<Pref>[\s\S]*?<\/Pref>/, unknown);
            };
            const step = receive(state, decodeFixture("37_01_02_240613_VXSE43", family, change));
            expect(step.state.gates.at(-1)?.serial).toBe(2);
            if (!restart) {
              expect(step.state.current[0]).toBe(initial.current[0]);
              expect(step.state.current[0].prediction.maximum.from).toMatchObject({ raw: "5-" });
              expect(step.state.current[0].source.serialRaw).toBe("1");
            } else expect(step.state.current[0].source.serialRaw).toBe("2");
            const latest = step.outcomes[0].subjects[0];
            expect(latest.source?.serialRaw).toBe("2");
            if (scope !== "area") expect(latest.facts.prediction).toMatchObject({ maximum: {
              from: { kind: "unknown", raw: "不明" }, to: { kind: "unknown", raw: "不明" },
            } });
            const duplicate = receive(step.state, decodeFixture("37_01_02_240613_VXSE43", family, change, "unknown-redelivery"));
            expect(duplicate.state).toBe(step.state);
            expect(duplicate.decisions[0]).toMatchObject({ decision: "unchanged", reason: "duplicate" });
            cases++;
          }
    expect(cases).toBe(54);
  });
});
