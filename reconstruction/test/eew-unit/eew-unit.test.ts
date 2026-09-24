import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { DecodedMaterial, Operation } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading } from "../../contracts/p2-shared-runtime.types";
import type { NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import type { EewInput, EewUnitState, EewUnitStep } from "../../contracts/p2-eew-unit.types";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { RuntimeCompositionRoot } from "../../src/runtime/composition-root";
import { eewUnitCodec, reduceEewUnit, toEewView } from "../../src/units/eew/eew-unit";
import { fixtureDriver , testNotificationChannels, recordingNotificationAdapter} from "../checkpoint-shutdown/runtime-fixture";

const BASE_TIME = 1_713_363_299_001;

function emptyState(): EewUnitState {
  return {
    schemaVersion: "p2-eew-unit-v1", contentRevision: 0, current: [], gates: [], intents: [], deliveryRecords: [], notificationLatches: [],
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

function clock(wallTimeMs: number, monotonicMs = 0) {
  return { wallTimeMs, monotonicMs };
}

function receive(state: EewUnitState, material: DecodedMaterial, nowMs = BASE_TIME) {
  return reduceEewUnit(state, { kind: "receive", material, clock: clock(nowMs) });
}

function withOperation(xml: string, operation: Operation): string {
  return xml.replace("<Status>通常</Status>", `<Status>${{ normal: "通常", training: "訓練", test: "試験" }[operation]}</Status>`);
}

function pendingIntent(subject = "normal/VXSE43/20240417231454", createdAt = BASE_TIME): EewUnitState["intents"][number] {
  const [operation, family] = subject.split("/");
  if (operation !== "normal" && operation !== "training" && operation !== "test") throw new Error("invalid operation");
  const channel = operation === "normal" ? "sound" : "desktop";
  return {
    id: `U-E:${subject}:${createdAt}:${channel}`, unit: "U-E", subject, operation,
    source: { inputId: "intent-source", origin: "replay", operation, family, subject,
      reportDateTimeRaw: "2024-04-17T23:14:59+09:00", serialRaw: "1", infoTypeRaw: "発表" },
    transition: "activated", channel, payload: { domain: "earthquake-eew", level: "warning", title: "緊急地震速報（予報）", body: "予報" },
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
  async readLastByte(path: string): Promise<number | null> { return Buffer.from(this.filesByPath.get(path) ?? "").at(-1) ?? null; }
  async writeFile(path: string, data: string): Promise<void> { this.filesByPath.set(path, data); }
  async rename(from: string, to: string): Promise<void> {
    this.filesByPath.set(to, this.filesByPath.get(from) ?? ""); this.filesByPath.delete(from);
  }
  async readFile(path: string): Promise<string> { return this.filesByPath.get(path) ?? ""; }
  async files(): Promise<readonly { name: string; size: number; mtimeMs: number }[]> { return []; }
  async unlink(path: string): Promise<void> { this.filesByPath.delete(path); }
}

function config() {
  return { appName: "fleq-p2", stateDirectory: "eew-state", legacyAppName: "fleq",
    legacyStateDirectory: "legacy-state", diagnosticDirectory: "eew-diagnostics" } as const;
}

describe("P2 EEW unit", () => {
  it("P2-A4-T11 contractBoundary / AC11: accepted notices replace pending by event and keep operation separate", () => {
    const first = decodeFixture("37_01_01_240613_VXSE43", "VXSE43");
    const second = decodeFixture("37_01_02_240613_VXSE43", "VXSE43");
    const cancelled = decodeFixture("37_01_03_240613_VXSE43", "VXSE43");
    const initial = receive(emptyState(), first);
    expect(initial.intents).toHaveLength(2);
    expect(initial.intents.map((item) => item.channel)).toEqual(["desktop", "sound"]);
    expect(initial.intents[0].payload).toMatchObject({ domain: "earthquake-eew", level: "critical",
      title: "緊急地震速報（警報）" });
    expect(initial.intents[0].payload.body).toContain("M5.8");
    const continued = receive(initial.state, second);
    expect(continued.intents).toHaveLength(2);
    expect(continued.intents[0].payload.body).toMatch(/^続報: /);
    expect(continued.state.deliveryRecords).toHaveLength(2);
    const ending = receive(continued.state, cancelled);
    expect(ending.intents).toHaveLength(0);
    expect(ending.state.deliveryRecords.filter((item) => item.disposition === "superseded")).toHaveLength(4);
    expect(ending.state.intents).toEqual([]);
    const training = receive(ending.state, decodeFixture("37_01_01_240613_VXSE43", "VXSE43",
      (xml) => withOperation(xml, "training")));
    expect(training.intents).toHaveLength(1);
    expect(training.intents[0]).toMatchObject({ operation: "training", channel: "desktop",
      payload: { title: "【訓練】緊急地震速報（警報）" } });
    expect(training.intents[0].payload.body).toContain("訓練の電文です。");
    expect(training.state.intents.filter((item) => item.operation === "normal")).toEqual([]);
    const cross = receive(initial.state, decodeFixture("37_01_01_240613_VXSE43", "VXSE45"));
    expect(cross.intents).toEqual([]);
    expect(cross.state.notificationLatches[0].vxse45Accepted).toBe(true);
    expect(receive(cross.state, second).intents).toEqual([]);
    const crossCancel = receive(cross.state, cancelled);
    expect(crossCancel.intents).toEqual([]);
    expect(crossCancel.state.intents).toEqual([]);
    const forecast = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE45", (xml) =>
      xml.replace(/<Code>31<\/Code>/g, "<Code>30</Code>").replace(/<Code>1[0-9]<\/Code>/g, "<Code>00</Code>")));
    expect(forecast.intents[0].payload.level).toBe("warning");
    expect(forecast.state.current[0]).toMatchObject({ eventId: "20240417231454", warningClass: "forecast" });
    const upgraded = receive(forecast.state, decodeFixture("37_01_01_240613_VXSE43", "VXSE45", (xml) =>
      xml.replace(/<Code>31<\/Code>/g, "<Code>30</Code>").replace(/<Code>1[0-9]<\/Code>/g, "<Code>13</Code>")));
    expect(upgraded.intents).toHaveLength(2);
    expect(upgraded.intents[0].payload).toMatchObject({ level: "critical", title: "緊急地震速報（警報）" });
    expect(upgraded.state.current[0].warningClass).toBe("warning");
    expect(upgraded.state.current[0].prediction).toEqual(forecast.state.current[0].prediction);
    expect(upgraded.outcomes[0]).toMatchObject({ change: "semantic", subjects: [{ facts: {
      eventId: "20240417231454", warningClass: "warning" } }] });
    expect(upgraded.displayChanges[0]).toMatchObject({ before: { current: { warningClass: "forecast" } },
      after: { current: { warningClass: "warning" } } });
    expect(upgraded.state.contentRevision).toBe(forecast.state.contentRevision + 1);
  });

  it("P2-A4-T11 regression / payloadRules: preserves forecast bounds and unknown magnitude in the notice body", () => {
    for (const [to, label] of [["6+", "5弱〜6強"], ["over", "5弱程度以上"], [null, "5弱"]] as const) {
      const material = decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => xml
        .replace(/<From>[^<]*<\/From>/g, "<From>5-</From>")
        .replace(/<To>[^<]*<\/To>/g, to == null ? "" : `<To>${to}</To>`)
        .replace(/<jmx_eb:Magnitude[^>]*>[^<]*<\/jmx_eb:Magnitude>/,
          "<jmx_eb:Magnitude>NaN</jmx_eb:Magnitude>"));
      const step = receive(emptyState(), material);
      expect(step.intents).toHaveLength(2);
      expect(step.intents[0].payload.body).toBe(`豊後水道 / M不明 / 最大予測震度${label}`);
      expect(step.intents[1].payload).toEqual(step.intents[0].payload);
    }
    const qualitative = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => xml
      .replace(/<ForecastInt>[\s\S]*?<\/ForecastInt>/g, '<ForecastInt condition="5弱以上未入電"/>')));
    expect(qualitative.intents[0].payload.body).toBe("豊後水道 / M5.8 / 最大予測震度5弱以上未入電");
    expect(qualitative.intents[1].payload).toEqual(qualitative.intents[0].payload);
    const conflict = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => xml
      .replace(/<ForecastInt>[\s\S]*?<\/ForecastInt>/g, '<ForecastInt condition="不明" description="5弱以上未入電"/>')));
    expect(conflict.intents[0].payload.body).toBe("豊後水道 / M5.8 / 最大予測震度不明");
    expect(conflict.intents[1].payload).toEqual(conflict.intents[0].payload);
    const unknown = receive(qualitative.state, decodeFixture("37_01_02_240613_VXSE43", "VXSE43", (xml) => xml
      .replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>")
      .replace(/<ForecastInt>[\s\S]*?<\/ForecastInt>/g, "<ForecastInt><From>不明</From><To>不明</To></ForecastInt>")));
    expect(unknown.state.current[0].prediction.areas.some((area) => area.intensity.condition === "既に主要動到達と推測")).toBe(true);
    expect(unknown.intents[0].payload.body).toBe("訂正: 豊後水道 / M6.6 / 最大予測震度不明");
    expect(unknown.intents[1].payload).toEqual(unknown.intents[0].payload);
  });

  it("P2-A4-T11 contractBoundary / AC11: correction and final report replace the prior channel pair", () => {
    const first = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE43"));
    const correction = receive(first.state, decodeFixture("37_01_02_240613_VXSE43", "VXSE43",
      (xml) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>")));
    expect(correction.intents).toHaveLength(2);
    expect(correction.intents[0].payload).toMatchObject({ title: "[訂正] 緊急地震速報（警報）" });
    expect(correction.intents[0].payload.body).toContain("訂正: ");
    expect(correction.state.deliveryRecords).toHaveLength(2);
    const final = receive(correction.state, decodeFixture("37_01_02_240613_VXSE43", "VXSE43",
      (xml) => xml.replace("</Body>", "<NextAdvisory>最終報</NextAdvisory></Body>")));
    expect(final.intents).toHaveLength(2);
    expect(final.intents[0].transition).toBe("released");
    expect(final.state.deliveryRecords).toHaveLength(4);
  });

  it("P2-A4-T11 contractBoundary / R35: cancellation follows attempted or unknown delivery evidence", () => {
    const first = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE43"));
    const cancelled = decodeFixture("37_01_03_240613_VXSE43", "VXSE43");
    const silent = receive(first.state, cancelled);
    expect(silent.intents).toEqual([]);
    expect(silent.state.intents).toEqual([]);
    expect(silent.state.deliveryRecords).toHaveLength(2);
    const selected = reduceEewUnit(first.state, { kind: "intentUpdate", clock: clock(BASE_TIME),
      intentUpdate: { id: first.intents[0].id, attempts: 1, nextAttemptAt: BASE_TIME, disposition: "pending" } });
    expect(selected.state.notificationLatches[0].deliveryEvidence).toBe("possible");
    expect(receive(selected.state, cancelled).intents).toHaveLength(2);
    const delivered = reduceEewUnit(selected.state, { kind: "intentUpdate", clock: clock(BASE_TIME),
      intentUpdate: selected.state.intents.map((item) => ({ id: item.id, attempts: 1,
        nextAttemptAt: BASE_TIME, disposition: "delivered" as const })) });
    for (const [saved, evidence] of [[first.state, "unknown"], [silent.state, "unknown"],
      [selected.state, "possible"], [delivered.state, "possible"]] as const) {
      const restored = reduceEewUnit(emptyState(), { kind: "restore", persisted: eewUnitCodec.encode(saved), clock: clock(BASE_TIME) });
      expect(restored.state.notificationLatches[0]).toMatchObject({ deliveryEvidence: evidence, firstReportNotified: false });
      const continued = receive(restored.state, decodeFixture("37_01_02_240613_VXSE43", "VXSE43"));
      expect(continued.state.notificationLatches[0].deliveryEvidence).toBe(evidence);
      expect(receive(continued.state, cancelled).intents).toHaveLength(2);
    }
    const orphan = reduceEewUnit({ ...first.state, current: [], gates: [], notificationLatches: [] }, {
      kind: "intentUpdate", clock: clock(BASE_TIME), intentUpdate: { id: first.intents[0].id,
        attempts: 1, nextAttemptAt: BASE_TIME, disposition: "expired" } });
    const reclaimed = reduceEewUnit(orphan.state, { kind: "deadline", clock: clock(BASE_TIME + 15_001) });
    const continued = receive(reclaimed.state, decodeFixture("37_01_02_240613_VXSE43", "VXSE43"), BASE_TIME + 15_002);
    expect(continued.state.notificationLatches[0].deliveryEvidence).toBe("possible");
    expect(receive(continued.state, cancelled, BASE_TIME + 15_003).intents).toHaveLength(2);

    // (a) Reclaimed delivered records leave a valid empty checkpoint, not proof of no delivery.
    const cleared = reduceEewUnit(delivered.state, { kind: "deadline", clock: clock(BASE_TIME + 15_001) });
    const savedEmpty = eewUnitCodec.encode(cleared.state);
    expect(savedEmpty).toEqual({ schemaVersion: "p2-eew-unit-v1", intents: [], deliveryRecords: [] });
    const restarted = reduceEewUnit(emptyState(), { kind: "restore", persisted: savedEmpty, clock: clock(BASE_TIME + 16_000) });
    expect(restarted.state.evidenceUnknownUntil).toBe(BASE_TIME + 616_000);
    const afterRestart = receive(restarted.state, decodeFixture("37_01_02_240613_VXSE43", "VXSE43"), BASE_TIME + 16_001);
    expect(afterRestart.state.notificationLatches[0].deliveryEvidence).toBe("unknown");
    expect(receive(afterRestart.state, cancelled, BASE_TIME + 16_002).intents).toHaveLength(2);
    const atBoundary = receive(restarted.state, decodeFixture("37_01_02_240613_VXSE43", "VXSE43"), BASE_TIME + 616_000);
    expect(atBoundary.state.notificationLatches[0].deliveryEvidence).toBe("unattempted");
    expect(receive(atBoundary.state, cancelled, BASE_TIME + 616_001).intents).toEqual([]);

    // (b) Evict the last owner of a delivered training event at the real 512-subject boundary.
    const training = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => withOperation(xml, "training")));
    const sent = reduceEewUnit(training.state, { kind: "intentUpdate", clock: clock(BASE_TIME),
      intentUpdate: { id: training.intents[0].id, attempts: 1, nextAttemptAt: BASE_TIME, disposition: "delivered" } });
    const owner = sent.state.current[0];
    const gate = sent.state.gates[0];
    const fillerSubjects = Array.from({ length: 511 }, (_, index) => `training/VXSE43/${String(index).padStart(14, "0")}`);
    const crowded: EewUnitState = { ...sent.state,
      current: [owner, ...fillerSubjects.map((subject) => ({ ...owner, subject,
        source: { ...owner.source, subject, reportDateTimeRaw: "2024-04-18T00:00:00Z" } }))],
      gates: [gate, ...fillerSubjects.map((subject) => ({ ...gate, subject,
        source: { ...gate.source, subject, reportDateTimeRaw: "2024-04-18T00:00:00Z" } }))],
    };
    const evicted = receive(crowded, decodeFixture("37_01_01_240613_VXSE43", "VXSE43"), BASE_TIME + 1_000);
    expect(evicted.state.gates.some((item) => item.subject === owner.subject)).toBe(false);
    expect(evicted.state.notificationLatches.some((item) => item.operation === "training")).toBe(false);
    expect(evicted.state.evidenceUnknownUntil).toBe(BASE_TIME + 601_000);
    const expired = reduceEewUnit(evicted.state, { kind: "deadline", clock: clock(BASE_TIME + 16_001) });
    expect(expired.state.deliveryRecords).toEqual([]);
    const afterEviction = receive(expired.state, decodeFixture("37_01_02_240613_VXSE43", "VXSE43",
      (xml) => withOperation(xml, "training")), BASE_TIME + 16_002);
    expect(afterEviction.state.notificationLatches.find((item) => item.operation === "training")?.deliveryEvidence).toBe("unknown");
    const trainingCancel = receive(afterEviction.state, decodeFixture("37_01_03_240613_VXSE43", "VXSE43",
      (xml) => withOperation(xml, "training")), BASE_TIME + 16_003);
    expect(trainingCancel.intents).toHaveLength(1);
    expect(trainingCancel.intents[0].payload.level).toBe("cancel");
  });

  it("P2-A4-T11 contractBoundary / R36: notified maximum rank never falls back", () => {
    const first = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE43"));
    const second = receive(first.state, decodeFixture("37_01_02_240613_VXSE43", "VXSE43"));
    expect(second.intents).toHaveLength(2);
    expect(second.intents[0].payload).toMatchObject({ level: "critical", title: "緊急地震速報（警報）" });
    expect(second.intents[0].payload.body).toMatch(/^続報: /);
    const trainingFirst = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE43",
      (xml) => withOperation(xml, "training")));
    const trainingIncrease = receive(trainingFirst.state, decodeFixture("37_01_02_240613_VXSE43", "VXSE43",
      (xml) => withOperation(xml, "training")));
    expect(trainingIncrease.intents).toHaveLength(1);
    expect(trainingIncrease.intents[0].channel).toBe("desktop");
    expect(trainingIncrease.intents[0].payload.body).toMatch(/^続報: 訓練の電文です。/);
    const lower = receive(second.state, decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
      xml.replace("<Serial>1</Serial>", "<Serial>3</Serial>")));
    expect(lower.intents).toEqual([]);
    const rebound = receive(lower.state, decodeFixture("37_01_02_240613_VXSE43", "VXSE43", (xml) =>
      xml.replace("<Serial>2</Serial>", "<Serial>4</Serial>")));
    expect(rebound.intents).toEqual([]);
  });

  it("P2-A4-T11 contractBoundary / R36: new warning area notifies once", () => {
    const first = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE43"));
    const added = receive(first.state, decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
      xml.replace("<Serial>1</Serial>", "<Serial>2</Serial>").replaceAll("<Code>622</Code>", "<Code>999</Code>")));
    expect(added.intents).toHaveLength(2);
    expect(added.intents[0].payload.body).toMatch(/^続報: /);
    const originalArea = receive(added.state, decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
      xml.replace("<Serial>1</Serial>", "<Serial>3</Serial>")));
    expect(originalArea.intents).toEqual([]);
    const repeated = receive(originalArea.state, decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
      xml.replace("<Serial>1</Serial>", "<Serial>4</Serial>").replaceAll("<Code>622</Code>", "<Code>999</Code>")));
    expect(repeated.intents).toEqual([]);
    const spaced = receive(repeated.state, decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
      xml.replace("<Serial>1</Serial>", "<Serial>5</Serial>").replaceAll("<Code>622</Code>", "<Code> 999 </Code>")));
    expect(spaced.intents).toEqual([]);
    const unsupported = receive(spaced.state, decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
      xml.replace("<Serial>1</Serial>", "<Serial>6</Serial>").replaceAll("<Code>622</Code>", "<Code>1000</Code>")));
    expect(unsupported.decisions[0].decision).toBe("changed");
    expect(unsupported.intents).toEqual([]);
  });

  it("P2-A4-T11 contractBoundary / R36: warning area history is bounded by the 1000 normalized codes", () => {
    const material = decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => xml.replace(/<Forecast>[\s\S]*?<\/Forecast>/,
      '<Forecast><ForecastInt><From>5-</From><To>5-</To></ForecastInt><Pref><Code>01</Code>'
      + Array.from({ length: 1001 }, (_, index) => `<Area><Code>${String(index).padStart(3, "0")}</Code>`
        + '<Category><Kind><Code>10</Code></Kind></Category><ForecastInt><From>5-</From><To>5-</To></ForecastInt></Area>').join("")
      + '</Pref></Forecast>'));
    const step = receive(emptyState(), material);
    expect(step.intents).toHaveLength(2);
    expect(step.state.current[0].prediction.areas).toHaveLength(1001);
    expect(step.state.notificationLatches[0].notifiedWarningAreas).toBe((1n << 1000n) - 1n);
  });

  it("P2-A4-T11 regression / I-09: assumed hypocenter hides magnitude in body and view", () => {
    const assumed = decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
      xml.replace("<Earthquake>", "<Earthquake><Condition>仮定震源要素</Condition>"));
    const byCondition = receive(emptyState(), assumed);
    expect(byCondition.intents[0].payload.body).toBe("仮定震源 / 最大予測震度5弱");
    expect(toEewView(byCondition.state).current[0].isAssumedHypocenter).toBe(true);
    for (const [coordinate, magnitude, reason] of [["+.5+132.4-10000/", "1.0", "9"],
      ["+33.2+132.4-10000/", "1.0", "09"], ["+33.2+132.4-10000/", "1.04", "9"]]) {
      const fallback = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => xml
        .replace("+33.2+132.4-30000/", coordinate)
        .replace(">5.8</jmx_eb:Magnitude>", `>${magnitude}</jmx_eb:Magnitude>`)
        .replace("<MaxIntChangeReason>0</MaxIntChangeReason>", `<MaxIntChangeReason>${reason}</MaxIntChangeReason>`)));
      expect(fallback.intents[0].payload.body).toBe("仮定震源 / 最大予測震度5弱");
      expect(toEewView(fallback.state).current[0].isAssumedHypocenter).toBe(true);
    }
  });

  it("P2-A4-T11 regression / R37: same-version correction compares original hypocenter and visible magnitude", () => {
    const correction = (transform: (xml: string) => string) => decodeFixture("37_01_01_240613_VXSE43", "VXSE43",
      (xml) => transform(xml.replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>")));
    const first = receive(emptyState(), correction((xml) => xml));
    const name = receive(first.state, correction((xml) => xml.replace("<Name>豊後水道</Name>", "<Name>別府湾</Name>")));
    expect(name.intents).toHaveLength(2);
    expect(name.intents[0].payload.body).toContain("別府湾");
    const magnitude = receive(name.state, correction((xml) => xml
      .replace("<Name>豊後水道</Name>", "<Name>別府湾</Name>")
      .replace(">5.8</jmx_eb:Magnitude>", ">6.0</jmx_eb:Magnitude>")));
    expect(magnitude.intents[0].payload.body).toContain("M6.0");
    const assumed = decodeFixture("37_01_01_240613_VXSE43", "VXSE43",
      (xml) => xml.replace("<Earthquake>", "<Earthquake><Condition>仮定震源要素</Condition>"));
    const assumedFirst = receive(emptyState(), assumed);
    const hiddenMagnitude = receive(assumedFirst.state, correction((xml) => xml
      .replace("<Earthquake>", "<Earthquake><Condition>仮定震源要素</Condition>")
      .replace(">5.8</jmx_eb:Magnitude>", ">6.0</jmx_eb:Magnitude>")));
    expect(hiddenMagnitude.decisions[0]).toMatchObject({ decision: "unchanged", reason: "duplicate" });
    const correctedName = correction((xml) => xml
      .replace("<Earthquake>", "<Earthquake><Condition>仮定震源要素</Condition>")
      .replace("<Name>豊後水道</Name>", "<Name>別府湾</Name>"));
    const named = receive(assumedFirst.state, correctedName);
    expect(named.intents).toHaveLength(2);
    expect(named.intents[0].payload.body).toBe("訂正: 仮定震源 / 最大予測震度5弱");
    expect(receive(named.state, correctedName).decisions[0]).toMatchObject({ decision: "unchanged", reason: "duplicate" });
    const final = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => xml
      .replace("<Earthquake>", "<Earthquake><Condition>仮定震源要素</Condition>")
      .replace("</Body>", "<NextAdvisory>最終報</NextAdvisory></Body>")));
    const finalCorrection = receive(final.state, correction((xml) => xml
      .replace("<Earthquake>", "<Earthquake><Condition>仮定震源要素</Condition>")
      .replace("</Body>", "<NextAdvisory>最終報</NextAdvisory></Body>")
      .replace(">5.8</jmx_eb:Magnitude>", ">6.0</jmx_eb:Magnitude>")));
    expect(final.state.current).toEqual([]);
    expect(finalCorrection.decisions[0]).toMatchObject({ decision: "unchanged", reason: "duplicate" });
  });

  it("P2-A4-T11 contractBoundary / R-04: unapplied recovery cannot suppress a later live cancellation", () => {
    const first = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE43"));
    const cancelled = decodeFixture("37_01_03_240613_VXSE43", "VXSE43");
    const recovered = receive(first.state, { ...cancelled, origin: "recovery" });
    expect(recovered.decisions[0]).toMatchObject({ decision: "unchanged", reason: "noChange" });
    expect(recovered.state).toBe(first.state);
    expect(recovered.outcomes).toEqual([]);
    expect(recovered.intents).toEqual([]);
    expect(recovered.state.intents).toEqual(first.state.intents);
    expect(recovered.state.deliveryRecords).toEqual(first.state.deliveryRecords);
    expect(recovered.state.notificationLatches[0].firstReportNotified).toBe(true);
    const live = receive(recovered.state, { ...cancelled, origin: "live" });
    expect(live.decisions[0].decision).toBe("changed");
    expect(live.state.current).toEqual([]);
    expect(live.state.intents).toEqual([]);
    const empty = emptyState();
    const historicalFirst = receive(empty, { ...decodeFixture("37_01_01_240613_VXSE43", "VXSE43"), origin: "recovery" });
    expect(historicalFirst.intents).toEqual([]);
    expect(historicalFirst.state).toBe(empty);
  });

  it("P2-A4-T11 contractBoundary / AC11: failed atomic admission does not latch a first report", () => {
    const occupied = { ...emptyState(), intents: Array.from({ length: 128 }, (_, index) =>
      pendingIntent(`normal/VXSE43/${String(index).padStart(14, "0")}`)) };
    const first = decodeFixture("37_01_01_240613_VXSE43", "VXSE43");
    const refused = receive(occupied, first);
    expect(refused.intents).toEqual([]);
    expect(refused.state.intents).toEqual(occupied.intents);
    expect(refused.state.notificationLatches[0]).toMatchObject({ firstReportNotified: false,
      warningNotified: false });
    const second = decodeFixture("37_01_02_240613_VXSE43", "VXSE43");
    const admitted = receive(refused.state, second, BASE_TIME + 15_001);
    expect(admitted.intents).toHaveLength(2);
    expect(admitted.state.notificationLatches[0]).toMatchObject({ firstReportNotified: true,
      warningNotified: true });
    const lower = { ...emptyState(), intents: [
      ...occupied.intents.slice(0, 126),
      pendingIntent("training/VXSE43/00000000000126"), pendingIntent("test/VXSE43/00000000000127"),
    ] };
    const preempted = receive(lower, first);
    expect(preempted.intents).toHaveLength(2);
    expect(preempted.diagnostics).toContainEqual({ level: "INFO", component: "eew",
      reason: "notificationCapacityEvicted", unit: "U-E", count: 2 });
    expect(preempted.state.deliveryRecords).toHaveLength(2);
    expect(preempted.state.intents).toHaveLength(128);
    expect(preempted.state.intents.filter((intent) => intent.operation !== "normal")).toEqual([]);
    const pair = receive(emptyState(), first).intents;
    const held = pendingIntent("normal/VXSE43/00000000000999");
    const body = `${held.payload.body}\n"境界"`;
    const padded = { ...held, payload: { ...held.payload, body } };
    const padding = 131_072 - Buffer.byteLength(JSON.stringify([padded, ...pair]));
    for (const extra of [0, 1]) {
      const pending = { ...padded, payload: { ...padded.payload, body: body + "x".repeat(padding + extra) } };
      expect(Buffer.byteLength(JSON.stringify([pending, ...pair]))).toBe(131_072 + extra);
      const step = receive({ ...emptyState(), intents: [pending] }, first);
      expect(step.intents).toEqual(extra === 0 ? pair : []);
      expect(step.state.intents).toEqual(extra === 0 ? [pending, ...pair] : [pending]);
      expect(step.state.notificationLatches[0].firstReportNotified).toBe(extra === 0);
    }
  });
  it("P2-A4-T01 contractBoundary / AC01: frozen validation order and legal reduced structures are atomic", () => {
    const first = decodeFixture("37_01_01_240613_VXSE43", "VXSE43");
    const cancelled43 = decodeFixture("37_01_03_240613_VXSE43", "VXSE43");
    const cancelled44 = decodeFixture("37_01_03_240613_VXSE43", "VXSE44");
    const regionless45 = decodeFixture("77_01_30_260101_VXSE45_FINAL", "VXSE45", (xml) =>
      xml.replace(/<Pref>[\s\S]*?<\/Pref>/g, "").replace("<NextAdvisory>この情報をもって、緊急地震速報：最終報とします。</NextAdvisory>", ""));

    const state = { ...receive(emptyState(), first).state, intents: [pendingIntent()] };
    expect(receive(state, cancelled43).decisions[0]).toMatchObject({ decision: "changed" });
    expect(receive(emptyState(), cancelled44).decisions[0]).toMatchObject({ decision: "rejected" });
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
    for (const family of ["VXSE43", "VXSE45"] as const) {
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
      const structures = [
        ["valid", "valid"], ["valid", "missing"], ["valid", "empty"], ["valid", "bad"],
        ["missing", "valid"], ["empty", "valid"], ["bad", "valid"],
      ] as const;
      for (const [pref, area] of structures) {
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
    expect(unknownStep.state.current[0].retainedPrediction).toEqual({ prediction: state.current[0].prediction, source: state.current[0].source });
    expect(unknownStep.state.current[0].source.serialRaw).toBe("2");
    expect(unknownStep.state.current[0].prediction.maximum.from).toMatchObject({ raw: "不明" });
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

  });

  it("P2-A4-T02-legal-values acceptance / AC02: missing and empty preserve report evidence without changing raw kinds", () => {
    const absent = ["missing", "empty", "unknown"] as const;
    const patterns: readonly (readonly string[])[] = [
      ...absent.flatMap((from) => absent.map((to) => [from, to])), absent,
    ];
    let cases = 0;
    for (const operation of ["normal", "training", "test"] as const)
      for (const coverage of ["VXSE43", "VXSE45", "regionless"] as const)
        for (const pattern of patterns) {
          const family = coverage === "regionless" ? "VXSE45" : coverage;
          const material = (serial: number, values: readonly string[], known?: string, inputId = `${serial}-${values}-${known}`) =>
            decodeFixture("37_01_01_240613_VXSE43", family, (xml) => {
              let index = 0;
              let value = withOperation(xml, operation).replace("<Serial>1</Serial>", `<Serial>${serial}</Serial>`);
              if (coverage === "regionless") value = value.replace(/<Pref>[\s\S]*?<\/Pref>/g, "");
              return value.replace(/(<ForecastInt\b[^>]*>)([\s\S]*?)(<\/ForecastInt>)/g, (_, open: string, body: string, close: string) =>
                open + body.replace(/<(From|To)>[^<]*<\/(From|To)>/g, (_, tag: string) => {
                const kind = tag === "From" && known != null ? known : values[index++ % values.length];
                return kind === "missing" ? "" : kind === "empty" ? `<${tag}/>`
                  : `<${tag}>${kind === "unknown" ? "不明" : kind}</${tag}>`;
                }) + close);
            }, inputId);
          const latest = (serial: number, values: readonly string[], known?: string) => receive(emptyState(), material(serial, values, known)).state.current[0];
          const first = receive(emptyState(), material(1, ["5-"])).state;
          const evidence = { prediction: first.current[0].prediction, source: first.current[0].source };
          let state = first;
          for (const [serial, values] of [[2, pattern], [3, [...pattern].reverse()], [4, ["unknown"]]] as const) {
            const raw = latest(serial, values);
            expect(raw.retainedPrediction).toBeNull(); // No earlier known report.
            const step = receive(state, material(serial, values));
            expect(step.state.current[0]).toEqual({ ...raw, retainedPrediction: evidence });
            expect(step.outcomes[0].subjects[0]).toMatchObject({ source: raw.source, facts: { prediction: raw.prediction } });
            const bounds = [raw.prediction.maximum, ...raw.prediction.areas.map((area) => area.intensity)];
            const kinds = bounds.flatMap((value) => [value.from.kind, value.to.kind]);
            expect(kinds).toEqual(kinds.map((_, index) => values[index % values.length]));
            const repeated = receive(step.state, material(serial, values, undefined, "different-input-id"));
            expect(repeated.state).toBe(step.state);
            expect(repeated.decisions[0]).toMatchObject({ reason: "duplicate" });
            state = step.state;
          }
          for (const known of ["3", "5-", "3以下"]) {
            const recovered = receive(state, material(5, pattern, known));
            expect(recovered.state.current[0]).toEqual(latest(5, pattern, known));
            expect(recovered.state.current[0].retainedPrediction).toBeNull();
            expect(receive(recovered.state, material(5, pattern, known, "known-retry")).state).toBe(recovered.state);
            const unknown = receive(recovered.state, material(6, ["unknown"]));
            expect(unknown.state.current[0].retainedPrediction).toEqual({
              prediction: recovered.state.current[0].prediction, source: recovered.state.current[0].source,
            });
          }
          cases++;
        }
    expect(cases).toBe(90);
  });

  it("P2-A4-T06-R14 contractBoundary / AC03,06: atomic normal-protecting admission and deterministic eviction", () => {
    const material = (id: number, operation: Operation, time = "2024-04-17T23:14:59+09:00", family: "VXSE43" | "VXSE45" = "VXSE43") =>
      decodeFixture("37_01_01_240613_VXSE43", family, (xml) => withOperation(xml, operation)
        .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${String(id).padStart(14, "0")}</EventID>`)
        .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${time}</ReportDateTime>`), `${operation}-${id}-${time}`);
    const operations = ["normal", "training", "test"] as const;
    const mixed = Array.from({ length: 512 }, (_, index) => material(index + 1, operations[index % 3]));
    let matrix = 0;
    for (const reverse of [false, true])
      for (const size of [510, 511, 512]) {
        const inputs = mixed.slice(0, size);
        const base = (reverse ? inputs.reverse() : inputs).reduce((state, input) => receive(state, input).state, emptyState());
        for (const operation of operations) {
          const protectedCurrent = base.current.filter((item) => item.operation === "normal");
          const old = base.current.find((item) => item.subject === "test/VXSE43/00000000000003")!;
          const pending = pendingIntent(old.subject);
          const state = { ...base, intents: [pending, pendingIntent(protectedCurrent[0].subject)] };
          const step = receive(state, material(9000, operation));
          expect(step.decisions[0]).toMatchObject({ decision: "changed" });
          expect(step.state.current).toHaveLength(Math.min(size + 1, 512));
          expect(step.state.gates).toHaveLength(Math.min(size + 1, 512));
          expect(step.displayChanges).toHaveLength(size < 512 ? 1 : 2);
          expect(step.displayChanges.filter((item) => item.before == null)).toHaveLength(1);
          if (size === 512) expect(step.displayChanges.find((item) => item.after == null)?.before?.unit === "U-E"
            && step.displayChanges.find((item) => item.after == null)?.before?.current).toBe(old);
          for (const item of protectedCurrent) expect(step.state.current.find((next) => next.subject === item.subject)).toBe(item);
          expect(step.diagnostics).toEqual(size < 512 ? [] : [{ level: "INFO", component: "eew", reason: "eewCapacityEvicted", unit: "U-E", count: 1 }]);
          expect(step.intents).toHaveLength(operation === "normal" ? 2 : 1);
          expect(step.outcomes.flatMap((outcome) => outcome.subjects).map((subject) => subject.transition)).toEqual(["activated"]);
          expect(step.state.current.some((item) => item.subject === old.subject)).toBe(size < 512);
          if (size === 512) {
            expect(step.state.deliveryRecords).toContainEqual({ intentId: pending.id, disposition: "superseded", expiresAt: pending.expiresAt });
            expect(step.state.intents.map((intent) => intent.subject))
              .toEqual([protectedCurrent[0].subject, ...step.intents.map((intent) => intent.subject)]);
            const readmitted = receive(step.state, mixed[2]);
            expect(readmitted.decisions[0]).toMatchObject({ decision: "changed" });
            expect(readmitted.outcomes[0].subjects[0].transition).toBe("activated");
            expect(readmitted.state.current.find((item) => item.subject === old.subject)).toEqual(old);
            expect(readmitted.state.intents.some((intent) => intent.id === pending.id)).toBe(false);
            expect(receive(readmitted.state, mixed[2]).state).toBe(readmitted.state);
          }
          matrix++;
        }
      }
    expect(matrix).toBe(18);

    const normalInputs = Array.from({ length: 512 }, (_, index) => material(index + 1, "normal"));
    const full = normalInputs.reduce((state, input) => receive(state, input).state, emptyState());
    const heldInput = decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => xml
      .replace(/<EventID>[^<]*<\/EventID>/, "<EventID>00000000000001</EventID>")
      .replace("<Serial>1</Serial>", "<Serial>2</Serial>")
      .replace(/<(From|To)>[^<]*<\/(From|To)>/g, "<$1>不明</$1>"));
    const normalState = { ...receive(full, heldInput).state, intents: [pendingIntent(full.current[0].subject)] };
    expect(normalState.current.find((item) => item.subject === full.current[0].subject)?.retainedPrediction)
      .toEqual({ prediction: full.current[0].prediction, source: full.current[0].source });
    for (const operation of operations) {
      const attempted = material(9000, operation);
      const refused = receive(normalState, attempted);
      const decision: Extract<EewUnitStep["decisions"][number], { decision: "capacityExceeded" }> = {
        decision: "capacityExceeded", subject: `${operation}/VXSE43/00000000009000`, operation,
        rejection: { family: "VXSE43", reportDateTimeMs: Date.parse(attempted.reportDateTimeRaw), affectedScope: "subject" },
      };
      expect(refused).toEqual({ state: normalState, nextDeadline: { wallTimeMs: BASE_TIME + 15_000, monotonicMs: null },
        decisions: [decision], intents: [], outcomes: [], diagnostics: [], displayChanges: [], confirmationEvidence: [] });
      expect(refused.state).toBe(normalState);
    }
    expect(receive(full, normalInputs[0]).state).toBe(full); // Existing subject consumes no additional slot.
    const followup = decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => xml
      .replace(/<EventID>[^<]*<\/EventID>/, "<EventID>00000000000001</EventID>")
      .replace("<Serial>1</Serial>", "<Serial>2</Serial>"));
    const replacement = receive(full, followup);
    expect(replacement.decisions[0].decision).toBe("changed");
    expect(replacement.state.gates).toHaveLength(512);
    expect(replacement.diagnostics).toEqual([]);

    // Deliberately unordered, gate-only/current-only entries, and timezone strings whose lexical order is wrong.
    const fixtures = [
      material(9101, "training", "2024-04-17T23:00:00+09:00"),
      material(9102, "training", "2024-04-17T23:05:00+09:00"),
      material(9103, "training", "2024-04-17T14:10:00Z"),
      material(9104, "test", "2024-04-17T14:10:00Z"),
      material(9105, "test", "2024-04-17T14:10:00Z"),
    ];
    let ordered = fixtures.reduce<EewUnitState>((state, input) => receive(state, input).state,
      { ...full, current: full.current.slice(0, 507), gates: full.gates.slice(0, 507) });
    const unknown = decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => withOperation(xml, "training")
      .replace(/<EventID>[^<]*<\/EventID>/, "<EventID>00000000009101</EventID>")
      .replace("<Serial>1</Serial>", "<Serial>2</Serial>")
      .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, "<ReportDateTime>2024-04-17T23:20:00+09:00</ReportDateTime>")
      .replace(/<(From|To)>[^<]*<\/(From|To)>/g, "<$1>不明</$1>"), "latest-z");
    ordered = receive(ordered, unknown).state;
    const current9101 = receive(emptyState(), fixtures[0]).state.current[0];
    ordered = { ...ordered,
      current: ordered.current.filter((item) => !item.subject.endsWith("09104")),
      gates: ordered.gates.filter((item) => !item.subject.endsWith("09102")),
    };
    // Keep retained source ancient; independently make current source older than gate to prove gate precedence.
    ordered = { ...ordered, current: ordered.current.map((item) => item.subject === current9101.subject
      ? { ...item, source: current9101.source } : item) };
    const otherFamily = receive(emptyState(), material(9200, "test", "2024-04-17T00:00:00Z", "VXSE45")).state;
    ordered = { ...ordered, current: [...ordered.current, ...otherFamily.current], gates: [...ordered.gates, ...otherFamily.gates] };
    const expected = [9102, 9104, 9105, 9103, 9101];
    for (const reverse of [false, true]) {
      let state = reverse ? { ...ordered, current: [...ordered.current].reverse(), gates: [...ordered.gates].reverse() } : ordered;
      for (const [index, id] of expected.entries()) {
        const before = new Set([...state.current, ...state.gates].map((item) => item.subject));
        const step = receive(state, material(9300 + index, "normal"));
        const after = new Set([...step.state.current, ...step.state.gates].map((item) => item.subject));
        expect([...before].filter((subject) => !after.has(subject))).toEqual([
          `${id === 9104 || id === 9105 ? "test" : "training"}/VXSE43/${String(id).padStart(14, "0")}`,
        ]);
        expect(step.diagnostics).toEqual([{ level: "INFO", component: "eew", reason: "eewCapacityEvicted", unit: "U-E", count: 1 }]);
        expect(step.state.current.find((item) => item.family === "VXSE45")).toBe(otherFamily.current[0]);
        state = step.state;
      }
    }
    const invalid = decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => xml.replace("<Serial>1</Serial>", "<Serial/>"));
    expect(receive(ordered, invalid).state).toBe(ordered);
    expect(receive(ordered, invalid).diagnostics.every((item) => item.reason !== "eewCapacityEvicted")).toBe(true);
    // Inject an over-limit union: enough candidates must be established before any removal can commit.
    const extra = fixtures.slice(0, 2).reduce((state, input) => receive(state, input).state, emptyState());
    const overfull = { ...normalState, current: [...normalState.current, ...extra.current], gates: [...normalState.gates, ...extra.gates] };
    const refused = receive(overfull, material(9400, "normal"));
    expect(refused.state).toBe(overfull);
    expect(refused.decisions[0].decision).toBe("capacityExceeded");
    expect(refused.diagnostics).toEqual([]);
    const repairable = { ...overfull, current: overfull.current.slice(1), gates: overfull.gates.slice(1) };
    const repaired = receive(repairable, material(9400, "normal"));
    expect(repaired.state.gates).toHaveLength(512);
    expect(repaired.diagnostics).toEqual([{ level: "INFO", component: "eew", reason: "eewCapacityEvicted", unit: "U-E", count: 2 }]);

    // Same operation/event has two family owners; only eviction of the last owner ends its latch.
    let lifetime = receive({ ...full, current: full.current.slice(1), gates: full.gates.slice(1) },
      material(9500, "training", "2024-04-17T00:00:00Z")).state;
    lifetime = receive(lifetime, material(9500, "training", "2024-04-17T00:00:00Z", "VXSE45")).state;
    const latch = lifetime.notificationLatches.find((item) => item.operation === "training" && item.eventId === "00000000009500");
    expect(latch).toMatchObject({ vxse45Accepted: true });
    lifetime = receive(lifetime, material(9501, "normal")).state;
    expect(lifetime.gates.some((item) => item.operation === "training" && item.subject === "training/VXSE43/00000000009500")).toBe(false);
    expect(lifetime.gates.some((item) => item.operation === "training" && item.subject === "training/VXSE45/00000000009500")).toBe(true);
    expect(lifetime.notificationLatches.find((item) => item.operation === "training" && item.eventId === "00000000009500")).toEqual(latch);
    for (let index = 1; index <= 511; index++)
      lifetime = receive(lifetime, material(index, "normal", "2024-04-17T14:00:00Z", "VXSE45")).state;
    const lastOwner = receive(lifetime, material(9501, "normal", "2024-04-17T14:00:00Z", "VXSE45"));
    expect(lastOwner.diagnostics).toContainEqual({ level: "INFO", component: "eew", reason: "eewCapacityEvicted", unit: "U-E", count: 1 });
    expect(lastOwner.state.gates.some((item) => item.operation === "training" && item.subject.endsWith("/00000000009500"))).toBe(false);
    expect(lastOwner.state.notificationLatches.some((item) => item.operation === "training" && item.eventId === "00000000009500")).toBe(false);
  });

  it("P2-A4-T11 contractBoundary: evicts earliest terminal records at the generation budget and keeps admitting", () => {
    const first = decodeFixture("37_01_01_240613_VXSE43", "VXSE43");
    const state: EewUnitState = { ...emptyState(), deliveryRecords: [
      { intentId: "later", disposition: "delivered", expiresAt: BASE_TIME + 20_000 },
      { intentId: "earliest", disposition: "superseded", expiresAt: BASE_TIME + 10_000 },
    ] };
    const envelope = { schemaVersion: "p2-eew-unit-v1", unit: "U-E", generation: Number.MAX_SAFE_INTEGER,
      capturedAt: Number.MAX_SAFE_INTEGER, payload: eewUnitCodec.encode(state), sha256: "0".repeat(64) };
    const padding = 262_144 - Buffer.byteLength(JSON.stringify(envelope));
    const full = { ...state, deliveryRecords: [state.deliveryRecords[0],
      { ...state.deliveryRecords[1], intentId: "earliest" + "x".repeat(padding) }] };
    expect(() => eewUnitCodec.encode(full)).not.toThrow();
    const accepted = receive(full, first);
    expect(accepted.decisions[0]).toMatchObject({ decision: "changed" });
    expect(accepted.intents.map((item) => item.channel)).toEqual(["desktop", "sound"]);
    expect(accepted.state.deliveryRecords).toEqual([state.deliveryRecords[0]]);
    expect(accepted.state.persistence.currentGeneration).toBe(1);
    expect(eewUnitCodec.decode(eewUnitCodec.encode(accepted.state)).kind).toBe("restored");
    const following = receive(accepted.state, decodeFixture("37_01_02_240613_VXSE43", "VXSE43"));
    expect(following.decisions[0]).toMatchObject({ decision: "changed" });
    expect(following.intents).toHaveLength(2);
    expect(following.intents[0].payload.body).toContain("続報: ");
  });

  it("P2-A4-T11 contractBoundary: capacity pressure selects the oldest prefix once for metadata and receive", () => {
    const notice = { ...pendingIntent(), attempts: 9 };
    const records = Array.from({ length: 2_500 }, (_, index) => ({ intentId: `terminal-${index}`,
      disposition: "delivered" as const, expiresAt: BASE_TIME + 20_000 + (index * 137 + 701) % 1_250 }));
    const seed = { ...emptyState(), intents: [notice], deliveryRecords: records };
    const envelope = { schemaVersion: seed.schemaVersion, unit: "U-E", generation: Number.MAX_SAFE_INTEGER,
      capturedAt: Number.MAX_SAFE_INTEGER, payload: eewUnitCodec.encode(seed), sha256: "0".repeat(64) };
    records[0] = { ...records[0], intentId: records[0].intentId + "x".repeat(262_144 - Buffer.byteLength(JSON.stringify(envelope))) };
    const payload = eewUnitCodec.encode(seed);
    expect(Buffer.byteLength(JSON.stringify({ ...envelope, payload }))).toBe(262_144);
    const decoded = eewUnitCodec.decode(payload);
    if (decoded.kind !== "restored") throw new Error("exact generation boundary must restore");
    const earliest = records.reduce((left, right) => left.expiresAt <= right.expiresAt ? left : right);
    let reads = 0;
    for (const record of decoded.state.deliveryRecords) {
      const expiresAt = record.expiresAt;
      Object.defineProperty(record, "expiresAt", { enumerable: true, get: () => { reads++; return expiresAt; } });
    }
    const started = performance.now();
    const updated = reduceEewUnit(decoded.state, { kind: "intentUpdate", clock: clock(BASE_TIME),
      intentUpdate: { id: notice.id, attempts: 10, nextAttemptAt: notice.nextAttemptAt, disposition: "pending" } });
    console.info("2500 terminal / attempts 9->10", { ms: performance.now() - started, expiresAtReads: reads });
    const selectionBound = 4 * records.length * Math.ceil(Math.log2(records.length));
    expect(reads).toBeLessThan(selectionBound);
    expect(updated.state.deliveryRecords.map((record) => record.intentId))
      .toEqual(records.filter((record) => record !== earliest).map((record) => record.intentId));
    expect(updated.state.intents[0].attempts).toBe(10);
    expect(eewUnitCodec.decode(eewUnitCodec.encode(updated.state)).kind).toBe("restored");
    reads = 0;
    const withinBudget = reduceEewUnit(updated.state, { kind: "intentUpdate", clock: clock(BASE_TIME),
      intentUpdate: { id: notice.id, attempts: 11, nextAttemptAt: notice.nextAttemptAt, disposition: "pending" } });
    expect(reads).toBeLessThan(3 * records.length);
    expect(withinBudget.state.deliveryRecords).toEqual(updated.state.deliveryRecords);
    for (const name of ["豊後水道", "震".repeat(6_000)]) {
      const material = decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) =>
        xml.replace("<Hypocenter><Area><Name>豊後水道</Name>", `<Hypocenter><Area><Name>${name}</Name>`));
      const withoutRecords = receive({ ...decoded.state, deliveryRecords: [] }, material);
      const candidates = [...records, ...withoutRecords.state.deliveryRecords];
      const oldestFirst = [...candidates].sort((a, b) => a.expiresAt - b.expiresAt);
      reads = 0;
      const start = performance.now();
      const received = receive(decoded.state, material);
      const measuredReads = reads;
      const removed = candidates.length - received.state.deliveryRecords.length;
      console.info("2500 terminal / receive", { nameLength: name.length, removed,
        expiresAtReads: measuredReads, ms: performance.now() - start });
      expect(measuredReads).toBeLessThan(selectionBound);
      expect(removed).toBeGreaterThan(name.length > 4 ? 100 : 1);
      expect(received.intents.map((item) => item.channel)).toEqual(["desktop", "sound"]);
      const expectedRemoved = new Set(oldestFirst.slice(0, removed).map((record) => record.intentId));
      expect(received.state.deliveryRecords.map((record) => record.intentId))
        .toEqual(candidates.filter((record) => !expectedRemoved.has(record.intentId)).map((record) => record.intentId));
      const kept = eewUnitCodec.encode(received.state);
      expect(eewUnitCodec.decode(kept).kind).toBe("restored");
      expect(eewUnitCodec.decode({ ...kept,
        deliveryRecords: [...kept.deliveryRecords, oldestFirst[removed - 1]] }).kind).toBe("invalid");
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
    const envelope = { schemaVersion: "p2-eew-unit-v1", unit: "U-E", generation: Number.MAX_SAFE_INTEGER,
      capturedAt: Number.MAX_SAFE_INTEGER, payload: eewUnitCodec.encode(withRecord(0)), sha256: "0".repeat(64) };
    const recordPadding = 262_144 - Buffer.byteLength(JSON.stringify(envelope));
    for (const extra of [0, 1]) {
      const boundary = withRecord(recordPadding + extra);
      const payload = { ...envelope.payload, deliveryRecords: boundary.deliveryRecords };
      expect(Buffer.byteLength(JSON.stringify({ ...envelope, payload }))).toBe(262_144 + extra);
      expect(eewUnitCodec.decode(payload).kind).toBe(extra === 0 ? "restored" : "invalid");
      if (extra === 0) expect(eewUnitCodec.encode(boundary)).toEqual(payload);
      else expect(() => eewUnitCodec.encode(boundary)).toThrow(/persisted boundary/);
    }
    for (const count of [127, 128, 129]) {
      const many = { ...emptyState(), intents: Array.from({ length: count }, (_, index) =>
        pendingIntent(`normal/VXSE43/${String(index).padStart(14, "0")}`)) };
      if (count === 129) expect(() => eewUnitCodec.encode(many)).toThrow(/persisted boundary/);
      else expect(eewUnitCodec.decode(eewUnitCodec.encode(many))).toMatchObject({ kind: "restored", state: { intents: many.intents } });
    }
    const small = pendingIntent();
    const padding = 131_072 - Buffer.byteLength(JSON.stringify([small]));
    for (const extra of [0, 1]) {
      const intents = [{ ...small, payload: { ...small.payload, body: small.payload.body + "x".repeat(padding + extra) } }];
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
    expect(accepted.intents.map((item) => item.channel)).toEqual(["desktop", "sound"]);

    const intentValue = pendingIntent("normal/VXSE43/20240417231454", 1_000);
    const intentState = { ...emptyState(), intents: [intentValue] };
    expect(reduceEewUnit(intentState, { kind: "deadline", clock: clock(15_999) }).state.intents).toHaveLength(1);
    expect(reduceEewUnit(intentState, { kind: "deadline", clock: clock(16_000) }).state.intents).toHaveLength(0);
    expect(reduceEewUnit(intentState, { kind: "deadline", clock: clock(16_001) }).state.intents).toHaveLength(0);

    const restored = reduceEewUnit(emptyState(), { kind: "restore", persisted: eewUnitCodec.encode(intentState), clock: clock(15_999) });
    const deadline = reduceEewUnit(intentState, { kind: "deadline", clock: clock(16_000) });
    const shutdown = reduceEewUnit(emptyState(), { kind: "shutdown", clock: clock(16_000) });
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
    const runtimeCalls = { ...fixtureDriver().calls,
      selectNotificationAttempt: (delivery: NotificationDeliveryState) => ({
        state: delivery, attempts: [], abortRequests: [], diagnostics: [],
      }),
      reduceEewUnit: (state: EewUnitState, input: EewInput) => {
      const step = reduceEewUnit(state, input);
      return input.kind === "receive" && state.persistence.currentGeneration === 0
        && input.material.inputId === first.inputId ? { ...step, state: unit } : step;
    }, toEewView };
    // Unit-local fault injection: A1 adopts the real EEW receive result at the due control call.
    // Parser routing is outside this checkpoint test; do not replace root.state from the caller.
    const cancellationCalls: typeof runtimeCalls = { ...runtimeCalls,
      reduceEewUnit: (state, input) => runtimeCalls.reduceEewUnit(state, input.kind === "deadline"
        ? { kind: "receive", material: cancelled, clock: input.clock } : input),
    };
    const root = new RuntimeCompositionRoot(config(), { "U-E": eewUnitCodec }, { notificationAdapter: recordingNotificationAdapter(),
      checkpointFileSystem: adapter, diagnosticFileSystem: diagnostics,
      runtimeCalls,
      clock: () => ({ wallTimeMs: now, monotonicMs: now }),
    });
    const initial = emptyState();
    expect(root.restoreUnit("U-E").kind).not.toBe("restored");
    const accepted = receive(initial, first);
    const received = accepted.state;
    const unit = { ...received, intents: [pendingIntent()],
      persistence: { kind: "pending" as const, currentGeneration: 1, savedGeneration: null,
        savedCapturedAt: null, savedAckAt: null, dirtySince: BASE_TIME } };
    const seed = (target: RuntimeCompositionRoot) => {
      const at = { wallTimeMs: now, monotonicMs: now };
      return target.dispatch(target.startRuntime("eew-test", at, testNotificationChannels).state, { kind: "mailboxCompleted", clock: at, completion: {
        kind: "parser", messageId: first.inputId, inputId: first.inputId, runId: "eew-test",
        encodedByteLength: 0, startedMonotonicMs: now, completedMonotonicMs: now, inputSequence: 1,
        result: { kind: "decoded", material: first },
      } }).state;
    };
    const cancelAt = (target: RuntimeCompositionRoot, at: ClockReading) => target.dispatch(target.state,
      { kind: "mailboxCompleted", clock: at, completion: { kind: "parser", messageId: cancelled.inputId,
        inputId: cancelled.inputId, runId: "eew-test", encodedByteLength: 0,
        startedMonotonicMs: at.monotonicMs, completedMonotonicMs: at.monotonicMs,
        inputSequence: 2, result: { kind: "decoded", material: cancelled } } });
    let running = seed(root);
    const correlation = { "U-E": { inputIds: [first.inputId], retryReason: "notRetry" as const } };
    const scheduled = root.scheduleCheckpoint(running, { wallTimeMs: now, monotonicMs: now }, "o07", correlation);
    if (scheduled?.request == null) throw new Error("O07 checkpoint was not captured");
    expect(root.state.checkpointAttempts["U-E"]).toEqual({ ...scheduled.capture, postCaptureDirtySince: null });
    const saved = await root.executeCheckpoint(scheduled.request, "o07", [first.inputId], "notRetry");
    running = root.applyCheckpointResult(running, saved.result, { wallTimeMs: ++now, monotonicMs: now }).state;
    const checkpoint = root.restoreUnit("U-E");
    expect(checkpoint.kind).toBe("restored");
    if (checkpoint.kind !== "restored") throw new Error("checkpoint not restored");
    expect(eewUnitCodec.decode(checkpoint.envelope.payload)).toMatchObject({ kind: "restored", state: {
      current: [], gates: [], intents: [{ expiresAt: BASE_TIME + 15_000 }],
    } });
    const payload = eewUnitCodec.decode(scheduled.request!.envelope.payload);
    if (payload.kind !== "restored") throw new Error(payload.reason);
    const restored = reduceEewUnit(emptyState(), { kind: "restore", persisted: eewUnitCodec.encode(payload.state),
      clock: clock(BASE_TIME + 2) });
    expect(restored.intents[0].expiresAt).toBe(BASE_TIME + 15_000);
    expect(receive(restored.state, second, BASE_TIME + 3).state.current[0].serial).toBe(2);

    // Match the checked-in subset, not a hand-maintained copy of its semantic oracle.
    const refs = corpus.meta.p2Subsets.find((item) => item.subsetId === "P2-O07-U-E-v1")!.stepRefs;
    expect(refs).toEqual([15, 16, 17, 18].map((position) => `expected:O07:${position}`));
    const decision = accepted.decisions[0];
    const actual = [
      { decision: null, effective: null, subjects: [], intents: initial.intents.length !== 0, notices: false },
      { decision: { kind: decision.decision, reason: "reason" in decision ? decision.reason : null,
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
    expect(running.units["U-E"].persistence).toMatchObject({ kind: "saved", savedGeneration: 1 });
    const savedPayload = scheduled.request!.envelope.payload;
    if (savedPayload == null || typeof savedPayload !== "object") throw new Error("invalid checkpoint payload");
    expect(Object.keys(savedPayload)).toEqual(["schemaVersion", "intents", "deliveryRecords"]);
    expect(restored.state.current).toEqual([]);
    expect(restored.state.gates).toEqual([]);

    const oldAckRoot = new RuntimeCompositionRoot(config(), { "U-E": eewUnitCodec }, { notificationAdapter: recordingNotificationAdapter(),
      checkpointFileSystem: new MemoryCheckpointFileSystem(), diagnosticFileSystem: new MemoryDiagnosticFileSystem(),
      runtimeCalls: cancellationCalls,
      clock: () => ({ wallTimeMs: now, monotonicMs: now }),
    });
    let oldAckState = seed(oldAckRoot);
    const old = oldAckRoot.scheduleCheckpoint(oldAckState, { wallTimeMs: now, monotonicMs: now }, "old", correlation);
    if (old?.request == null) throw new Error("old-ack checkpoint was not captured");
    const oldResult = await oldAckRoot.executeCheckpoint(old.request, "old", [first.inputId], "notRetry");
    const cancellationClock = { wallTimeMs: ++now, monotonicMs: now };
    oldAckState = cancelAt(oldAckRoot, cancellationClock).state;
    expect(oldAckState.checkpointAttempts["U-E"]).toEqual({ ...old.capture, postCaptureDirtySince: cancellationClock.monotonicMs });
    expect(oldAckState.units["U-E"].current).toEqual([]);
    oldAckState = oldAckRoot.applyCheckpointResult(oldAckState, oldResult.result,
      { wallTimeMs: ++now, monotonicMs: now }).state;
    expect(oldAckState.units["U-E"].current).toEqual([]);
    expect(oldAckState.units["U-E"].persistence).toMatchObject({ currentGeneration: 2, savedGeneration: 1, kind: "pending" });
    expect(oldAckState.units["U-E"].persistence?.dirtySince).toBe(cancellationClock.monotonicMs);

    const failedAdapter = new MemoryCheckpointFileSystem();
    const failedRoot = new RuntimeCompositionRoot(config(), { "U-E": eewUnitCodec }, { notificationAdapter: recordingNotificationAdapter(),
      checkpointFileSystem: failedAdapter, diagnosticFileSystem: new MemoryDiagnosticFileSystem(),
      runtimeCalls: cancellationCalls,
      clock: () => ({ wallTimeMs: now, monotonicMs: now }),
    });
    let failedState = seed(failedRoot);
    const failedRequest = failedRoot.scheduleCheckpoint(failedState,
      { wallTimeMs: now, monotonicMs: now }, "failed", correlation);
    if (failedRequest?.request == null) throw new Error("failure checkpoint was not captured");
    failedAdapter.failWrite = true;
    const failure = await failedRoot.executeCheckpoint(failedRequest.request!, "failed", [first.inputId], "notRetry");
    failedState = failedRoot.applyCheckpointResult(failedState, failure.result,
      { wallTimeMs: ++now, monotonicMs: now }).state;
    expect(failedState.units["U-E"].persistence?.kind).toBe("failed");
    failedState = cancelAt(failedRoot, { wallTimeMs: ++now, monotonicMs: now }).state;
    const afterFailureCancel = failedState.units["U-E"];
    expect(afterFailureCancel.current).toEqual([]);
    expect(afterFailureCancel.persistence).toMatchObject({ kind: "failed", currentGeneration: 2, savedGeneration: null });
    expect(afterFailureCancel.deliveryRecords).toContainEqual({
      intentId: unit.intents[0].id, disposition: "superseded", expiresAt: unit.intents[0].expiresAt,
    });

    const shutdownRoot = new RuntimeCompositionRoot(config(), { "U-E": eewUnitCodec }, { notificationAdapter: recordingNotificationAdapter(),
      checkpointFileSystem: new MemoryCheckpointFileSystem(), diagnosticFileSystem: new MemoryDiagnosticFileSystem(),
      runtimeCalls,
      clock: () => ({ wallTimeMs: now, monotonicMs: now }),
    });
    const shutdownState = seed(shutdownRoot);
    const summary = await shutdownRoot.shutdownRuntime(shutdownRoot.state, 1,
      { wallTimeMs: ++now, monotonicMs: now });
    expect(summary.code).toBe(0);
    expect(summary.persistence["U-E"]).toMatchObject({ kind: "saved", currentGeneration: 1, savedGeneration: 1 });
    expect(shutdownRoot.state.shutdown.stage).toBe("completed");
    expect(shutdownRoot.restoreUnit("U-E").kind).toBe("restored");
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
    expect(cancelled.state.intents.filter((intent) => intent.operation !== "normal"))
      .toEqual(state.intents.filter((intent) => intent.operation !== "normal"));
    expect(cancelled.intents).toHaveLength(0);
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
          const restored = reduceEewUnit(emptyState(), { kind: "restore", persisted: conflicting, clock: clock(BASE_TIME + age) });
          expect(restored.intents).toEqual([]);
          expect(restored.decisions[0].decision).toBe("rejected");
        }
      for (const ttl of [14_999, 15_000, 15_001]) {
        const altered = { ...value, intents: [{ ...intent, expiresAt: intent.createdAt + ttl }] };
        expect(eewUnitCodec.decode(altered).kind).toBe(ttl > 15_000 ? "invalid" : "restored");
        const restored = reduceEewUnit(emptyState(), { kind: "restore", persisted: altered, clock: clock(BASE_TIME + 14_999) });
        expect(restored.intents).toHaveLength(ttl === 15_000 ? 1 : 0);
        if (ttl === 15_000) expect(restored.intents[0].expiresAt).toBe(intent.expiresAt);
      }
      expect(eewUnitCodec.decode({ ...value, intents: [intent, intent] }).kind).toBe("invalid");
      if (operation !== "normal") expect(eewUnitCodec.decode({ ...value, intents: [{ ...intent, channel: "sound" }] }).kind).toBe("invalid");
    }
  });

  it("P2-A4-T09 corpusHistory / AC09: E13 EEW manifest population has no persistent semantic unavailable", () => {
    const counts = { fixtures: 0, normalCorpus: 0, rejected: 0, invalidSynthetic: 0,
      semanticUnavailable: 0, deliverySummary: "N/A: A8 not connected" };
    for (const fixture of manifest.fixtures) {
      const family = fixture.transport.headType;
      if (family !== "VXSE43" && family !== "VXSE45") continue;
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
      const afterDeadline = reduceEewUnit(step.state, { kind: "deadline", clock: clock(BASE_TIME + 15_001) });
      const view = toEewView(afterDeadline.state);
      counts.semanticUnavailable += view.subjects.filter((subject) => subject.transition === "unavailable").length;
      expect(view.activeCount).toBe(step.state.gates[0].terminal ? 0 : 1);
      expect(eewUnitCodec.decode(eewUnitCodec.encode(afterDeadline.state)).kind).toBe("restored");
    }
    expect(counts).toEqual({ fixtures: 11, normalCorpus: 9, rejected: 0, invalidSynthetic: 2,
      semanticUnavailable: 0, deliverySummary: "N/A: A8 not connected" });
  });

  it("P2-A4-T11 regression / AC02: same-version corrections compare received raw before retention", () => {
    for (const operation of ["normal", "training", "test"] as const)
      for (const family of ["VXSE43", "VXSE45"] as const) {
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
          expect(step.state.current[0].prediction.maximum).toMatchObject({ from: { raw: from }, to: { raw: to } });
          expect(step.state.current[0].retainedPrediction).toBeNull();
          const repeated = receive(step.state, decodeFixture("37_01_01_240613_VXSE43", family, change, "correction-redelivery"));
          expect(repeated.state).toBe(step.state);
          expect(repeated.outcomes).toEqual([]);
          if (from === "不明") {
            const changedRaw = receive(step.state, decodeFixture("37_01_01_240613_VXSE43", family,
              (xml) => change(xml).replace("<To>7</To>", "<To>6+</To>"), "different-unknown-raw"));
            expect(changedRaw.decisions[0]).toMatchObject({ decision: "changed", change: "semantic" });
            expect(changedRaw.state.current[0].prediction.maximum).toMatchObject({ from: { raw: "不明" }, to: { raw: "6+" } });
            expect(changedRaw.outcomes).toHaveLength(1);
            const knownAgain = receive(step.state, decodeFixture("37_01_01_240613_VXSE43", family, correction, "known-again"));
            expect(knownAgain.decisions[0]).toMatchObject({ decision: "changed", change: "semantic" });
            expect(knownAgain.state.current[0].source.inputId).toBe("known-again");
            expect(knownAgain.outcomes).toHaveLength(1);
          }
        }
      }
  });

  it("P2-A4-T10 regression / AC02,04: partial unknown follow-ups use remaining report evidence", () => {
    const initial = receive(emptyState(), decodeFixture("37_01_01_240613_VXSE43", "VXSE43")).state;
    const unknown = (part: string): string => part.replace(/<(From|To)>[^<]*<\/(From|To)>/g, "<$1>不明</$1>");
    const cases = [
      ["maximum", (xml: string) => xml.replace(/<ForecastInt>[\s\S]*?<\/ForecastInt>/, unknown)],
      ["area", (xml: string) => xml.replace(/<Pref>[\s\S]*?<\/Pref>/, unknown)],
    ] as const;
    for (const [scope, change] of cases) {
      const material = decodeFixture("37_01_02_240613_VXSE43", "VXSE43", change, `unknown-${scope}`);
      const step = receive(initial, material);
      expect(step.state.current[0]).toMatchObject({ source: { serialRaw: "2" }, retainedPrediction: null });
      expect(step.state.current[0].prediction.maximum.from.kind).toBe(scope === "maximum" ? "unknown" : "text");
      expect(step.state.current[0].prediction.areas[0].intensity.from.kind).toBe(scope === "area" ? "unknown" : "text");
      expect(step.outcomes[0].subjects[0]).toMatchObject({ source: { serialRaw: "2" } });
      expect(receive(step.state, material).decisions[0]).toMatchObject({ decision: "unchanged", reason: "duplicate" });
    }
  });

  it("P2-A4-T12 acceptance / AC02,04 R13: report-level evidence updates, clears and never revives on restore", () => {
    for (const operation of ["normal", "training", "test"] as const)
      for (const regionless of [false, true]) {
        const family = regionless ? "VXSE45" : "VXSE43";
        const material = (serial: number, mode: "known" | "unknown" | "partial", to = "7") =>
          decodeFixture("37_01_01_240613_VXSE43", family, (xml) => {
            let value = withOperation(xml, operation).replace("<Serial>1</Serial>", `<Serial>${serial}</Serial>`);
            if (regionless) value = value.replace(/<Pref>[\s\S]*?<\/Pref>/g, "");
            if (mode !== "known") value = value.replace(/<(From|To)>[^<]*<\/(From|To)>/g, "<$1>不明</$1>");
            if (mode === "partial") value = regionless ? value.replace("<To>不明</To>", `<To>${to}</To>`)
              : value.replace(/<Pref>[\s\S]*?<\/Pref>/, (pref) => pref.replace("<To>不明</To>", `<To>${to}</To>`));
            return value;
          }, `${operation}-${serial}-${mode}-${to}`);
        const known = receive(emptyState(), material(1, "known")).state.current[0];
        let state = receive(emptyState(), material(1, "known")).state;
        for (const serial of [2, 3]) {
          const step = receive(state, material(serial, "unknown"));
          expect(step.state.current[0].source.serialRaw).toBe(String(serial));
          expect(step.state.current[0].prediction.maximum.from).toMatchObject({ kind: "unknown" });
          expect(step.state.current[0].retainedPrediction).toEqual({ prediction: known.prediction, source: known.source });
          expect(step.outcomes[0].subjects[0].facts.prediction).toEqual(step.state.current[0].prediction);
          state = step.state;
        }
        const partial = receive(state, material(4, "partial"));
        expect(partial.state.current[0].retainedPrediction).toBeNull();
        const corrected = receive(partial.state, material(4, "partial", "6+"));
        expect(corrected.decisions[0]).toMatchObject({ decision: "changed", change: "semantic" });
        expect(corrected.outcomes[0].subjects[0].facts.prediction).toEqual(corrected.state.current[0].prediction);
        expect(receive(corrected.state, material(4, "partial", "6+")).state).toBe(corrected.state);
        const held = receive(corrected.state, material(5, "unknown"));
        expect(held.state.current[0].retainedPrediction).toEqual({
          prediction: corrected.state.current[0].prediction, source: corrected.state.current[0].source,
        });
        expect(toEewView(held.state).current[0]).toEqual(held.state.current[0]);
        expect(receive(held.state, material(4, "partial")).state).toBe(held.state);
        const restored = reduceEewUnit(held.state, { kind: "restore", persisted: eewUnitCodec.encode(held.state), clock: clock(BASE_TIME) });
        expect(restored.state.current).toEqual([]);
        const afterRestore = receive(restored.state, material(6, "unknown"));
        expect(afterRestore.state.current[0].retainedPrediction).toBeNull();
        const terminalBase = operation === "normal" ? afterRestore.state : held.state;
        const terminalSerial = operation === "normal" ? 6 : 5;
        const ended = receive(terminalBase, decodeFixture("37_01_03_240613_VXSE43", family, (xml) =>
          withOperation(xml, operation).replace("<Serial>2</Serial>", `<Serial>${terminalSerial}</Serial>`)));
        expect(ended.state.current).toEqual([]);
      }
  });

  it("P2-A4-T13 contractBoundary / R13 AC06: deadlines on every branch and result-free intent updates", () => {
    const first = decodeFixture("37_01_01_240613_VXSE43", "VXSE43");
    const second = decodeFixture("37_01_02_240613_VXSE43", "VXSE43");
    const pending = pendingIntent();
    const state = { ...receive(emptyState(), first).state, intents: [pending] };
    const expected = { wallTimeMs: pending.expiresAt, monotonicMs: null };
    expect(receive(state, first).nextDeadline).toEqual(expected);
    expect(receive(state, decodeFixture("37_01_01_240613_VXSE43", "VXSE43", (xml) => xml.replace("<Serial>1</Serial>", "<Serial/>"))).nextDeadline).toEqual(expected);
    const newer = { ...receive(state, second).state, intents: [pending] };
    expect(receive(newer, first).nextDeadline).toEqual(expected);
    expect(receive(state, second).nextDeadline).toEqual(expected);
    expect(reduceEewUnit(state, { kind: "restore", persisted: eewUnitCodec.encode(state), clock: clock(BASE_TIME) }).nextDeadline).toEqual(expected);
    expect(reduceEewUnit(state, { kind: "restore", persisted: { ...eewUnitCodec.encode(state), intents: [pending, pending] }, clock: clock(BASE_TIME) }).nextDeadline).toEqual(expected);

    const selection = { id: pending.id, attempts: 1, nextAttemptAt: BASE_TIME + 500, disposition: "pending" as const };
    const selected = reduceEewUnit(state, { kind: "intentUpdate", intentUpdate: selection, clock: clock(BASE_TIME, 123) });
    expect(selected.state.persistence).toMatchObject({ kind: "pending", currentGeneration: 2, dirtySince: 0 });
    expect(selected.state.intents[0]).toMatchObject({ ...selection, createdAt: pending.createdAt, expiresAt: pending.expiresAt });
    expect(selected.decisions[0]).toMatchObject({ change: "deliveryOnly" });
    expect(selected.nextDeadline).toEqual(expected);
    for (const update of [selection, { ...selection, id: "unknown" }, { ...selection, attempts: 0 }]) {
      const same = reduceEewUnit(selected.state, { kind: "intentUpdate", intentUpdate: update, clock: clock(BASE_TIME, 999) });
      expect(same).toEqual({ state: selected.state, nextDeadline: expected, decisions: [], intents: [], outcomes: [],
        diagnostics: [], displayChanges: [], confirmationEvidence: [] });
      expect(same.state).toBe(selected.state);
    }
    const delivered = reduceEewUnit(selected.state, { kind: "intentUpdate", intentUpdate: { ...selection, disposition: "delivered" }, clock: clock(BASE_TIME + 1, 124) });
    expect(delivered.state.intents).toEqual([]);
    expect(delivered.state.persistence.currentGeneration).toBe(3);
    expect(delivered.nextDeadline).toEqual(expected);
    const reclaimed = reduceEewUnit(delivered.state, { kind: "deadline", clock: clock(pending.expiresAt, 125) });
    expect(reclaimed.state.deliveryRecords).toEqual([]);
    expect(reclaimed.nextDeadline).toBeNull();
    expect(reclaimed.state.persistence.currentGeneration).toBe(4);
    for (const age of [14_999, 15_000, 15_001]) {
      for (const monotonic of [0, Number.MAX_SAFE_INTEGER]) {
        const tick = reduceEewUnit(state, { kind: "deadline", clock: clock(BASE_TIME + age, monotonic) });
        expect(tick.nextDeadline).toEqual(age < 15_000 ? expected : null);
        expect(tick.state.intents).toHaveLength(age < 15_000 ? 1 : 0);
        if (age >= 15_000) expect(tick.diagnostics).toContainEqual({ level: "INFO", component: "eew",
          reason: "notificationExpired", unit: "U-E", count: 1 });
        if (age < 15_000) {
          expect(tick.state).toBe(state);
          expect([tick.decisions, tick.intents, tick.outcomes, tick.diagnostics]).toEqual([[], [], [], []]);
        }
      }
      for (const terminal of [false, true]) {
        const end = decodeFixture(terminal ? "37_01_01_240613_VXSE43" : "37_01_03_240613_VXSE43", "VXSE43", (xml) => terminal
          ? xml.replace("</Body>", "<NextAdvisory>最終報</NextAdvisory></Body>") : xml);
        expect(receive(state, end, BASE_TIME + age).nextDeadline)
          .toEqual(age < 15_000 ? expected : terminal
            ? { wallTimeMs: BASE_TIME + age + 15_000, monotonicMs: null } : null);
      }
      const result = reduceEewUnit(state, { kind: "intentUpdate", intentUpdate: selection, clock: clock(BASE_TIME + age) });
      expect(result.nextDeadline).toEqual(age < 15_000 ? expected : null);
      expect(reduceEewUnit(state, { kind: "shutdown", clock: clock(BASE_TIME + age) }).nextDeadline)
        .toEqual(age < 15_000 ? expected : null);
    }
    const later = pendingIntent("normal/VXSE43/20240417231455", BASE_TIME + 1_000);
    expect(reduceEewUnit({ ...state, intents: [later, pending] }, { kind: "deadline", clock: clock(pending.expiresAt) }).nextDeadline)
      .toEqual({ wallTimeMs: later.expiresAt, monotonicMs: null });
    expect(receive(emptyState(), first).nextDeadline).toEqual(expected);
  });
});
