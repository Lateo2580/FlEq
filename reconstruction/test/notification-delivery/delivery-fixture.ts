import { readFileSync } from "node:fs";
import type { ClockReading, MailboxEnvelope, NotificationIntent } from "../../contracts/p2-shared-runtime.types";
import { linkedRuntimeCalls } from "../../src/runtime/composition-root";
import { applyNotificationResult, selectNotificationAttempt } from "../../src/notification-delivery/notification-delivery";
import { envelope } from "../execution-split/owner-harness";

// AC02: C1/C2 share the frozen A4 input and background so neither measures a hand-built emergency attempt.
export const calls = { ...linkedRuntimeCalls, applyNotificationResult, selectNotificationAttempt };
export const at = (time: number): ClockReading => ({ wallTimeMs: 1_713_363_299_000 + time, monotonicMs: time });
let sequence = 0;
// The frozen A4 EEW report as the host would enqueue it; event A/B rewrites it to a warning of another event.
export function eewEnvelope(runId: string, clock: ClockReading, event?: "A" | "B"): MailboxEnvelope {
  let xml = readFileSync("test/fixtures/37_01_01_240613_VXSE43.xml", "utf8");
  if (event != null) xml = xml.replace(/<Code>31<\/Code>/g, "<Code>30</Code>")
    .replace(/<Code>1[0-9]<\/Code>/g, "<Code>00</Code>")
    .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>2099010100000${event === "A" ? 1 : 2}</EventID>`)
    .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${new Date(clock.wallTimeMs).toISOString()}</ReportDateTime>`);
  const inputId = event ?? "O07:15";
  return envelope(runId, event == null ? "VXSE43" : "VXSE45", inputId, Buffer.from(xml), clock, ++sequence);
}
export function notice(id: string, channel: "desktop" | "sound" = "desktop", createdAt = at(0).wallTimeMs): NotificationIntent {
  return { id, unit: "U-W", subject: id, operation: "normal", source: { inputId: id, origin: "replay",
    operation: "normal", family: "VPWS50", subject: id, reportDateTimeRaw: new Date(createdAt).toISOString(), serialRaw: "1", infoTypeRaw: "発表" },
    transition: "activated", channel, payload: { domain: "weather", level: "info", title: "E21背景", body: "E21背景" },
    createdAt, expiresAt: createdAt + (channel === "sound" ? 60_000 : 180_000), nextAttemptAt: createdAt,
    attempts: 0, configRevision: "e21-v1", disposition: "pending" };
}
// The frozen four-pending U-W background of C1.
export function background(foreground: ClockReading): NotificationIntent[] {
  return (["desktop", "sound"] as const).flatMap(channel => [
    notice(`lower-${channel}`, channel, foreground.wallTimeMs - 1_000),
    { ...notice(`retry-${channel}`, channel, foreground.wallTimeMs - 1_000), attempts: 1, nextAttemptAt: foreground.wallTimeMs },
  ]);
}
