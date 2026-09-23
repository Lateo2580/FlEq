import { readFileSync } from "node:fs";
import type { ClockReading, NotificationIntent, RuntimeInput, RuntimeState } from "../../contracts/p2-shared-runtime.types";
import { ingestXmlData } from "../../src/ingress/ingress";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { linkedRuntimeCalls, linkedUnitCodecs } from "../../src/runtime/composition-root";
import { reduceRuntime } from "../../src/runtime/shared-runtime";
import { applyNotificationResult, selectNotificationAttempt } from "../../src/notification-delivery/notification-delivery";

// AC02: C1/C2 share the frozen A4 input and background so neither measures a hand-built emergency attempt.
export const calls = { ...linkedRuntimeCalls, codecs: linkedUnitCodecs, applyNotificationResult, selectNotificationAttempt };
export const at = (time: number): ClockReading => ({ wallTimeMs: 1_713_363_299_000 + time, monotonicMs: time });
export const empty = (clock = at(0)) => reduceRuntime(null, { kind: "startup", runId: "a7", clock,
  restored: { "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" } } }, calls).state;
export function tick(state: RuntimeState, clock: ClockReading): RuntimeInput {
  return { kind: "mailboxCompleted", clock, completion: { kind: "control", runId: state.runId,
    messageId: "tick", encodedByteLength: 0, startedMonotonicMs: clock.monotonicMs, completedMonotonicMs: clock.monotonicMs, control: { kind: "deadline", clock } } };
}
export function eewInput(state: RuntimeState, clock: ClockReading, event?: "A" | "B"): RuntimeInput {
  let xml = readFileSync("test/fixtures/37_01_01_240613_VXSE43.xml", "utf8");
  if (event != null) xml = xml.replace(/<Code>31<\/Code>/g, "<Code>30</Code>")
    .replace(/<Code>1[0-9]<\/Code>/g, "<Code>00</Code>")
    .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>2099010100000${event === "A" ? 1 : 2}</EventID>`)
    .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${new Date(clock.wallTimeMs).toISOString()}</ReportDateTime>`);
  const inputId = event ?? "O07:15";
  const entered = ingestXmlData({ kind: "replay", inputId, inputSequence: 1, receivedAt: clock.wallTimeMs,
    origin: "replay", headType: event == null ? "VXSE43" : "VXSE45", body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return { kind: "mailboxCompleted", clock, completion: { kind: "parser", runId: state.runId, inputId,
    messageId: inputId, inputSequence: 1, encodedByteLength: 0, startedMonotonicMs: clock.monotonicMs,
    completedMonotonicMs: clock.monotonicMs, result: decoded } };
}
export function notice(id: string, channel: "desktop" | "sound" = "desktop", createdAt = at(0).wallTimeMs): NotificationIntent {
  return { id, unit: "U-W", subject: id, operation: "normal", source: { inputId: id, origin: "replay",
    operation: "normal", family: "VPWS50", subject: id, reportDateTimeRaw: new Date(createdAt).toISOString(), serialRaw: "1", infoTypeRaw: "発表" },
    transition: "activated", channel, payload: { domain: "weather", level: "info", title: "E21背景", body: "E21背景" },
    createdAt, expiresAt: createdAt + (channel === "sound" ? 60_000 : 180_000), nextAttemptAt: createdAt,
    attempts: 0, configRevision: "e21-v1", disposition: "pending" };
}
export function background(state: RuntimeState, foreground: ClockReading): RuntimeState {
  const intents = (["desktop", "sound"] as const).flatMap(channel => [
    notice(`lower-${channel}`, channel, foreground.wallTimeMs - 1_000),
    { ...notice(`retry-${channel}`, channel, foreground.wallTimeMs - 1_000), attempts: 1, nextAttemptAt: foreground.wallTimeMs },
  ]);
  return { ...state, units: { ...state.units, "U-W": { ...state.units["U-W"], intents } } };
}
