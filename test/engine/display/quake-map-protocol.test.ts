import { describe, expect, it } from "vitest";
import { MAX_EVENT_BYTES, MAX_SNAPSHOT_BYTES } from "../../../src/engine/display/constants";
import {
  projectDisplayEvent,
  projectQuakeMapCommand,
} from "../../../src/engine/display/project-event";
import type { DisplayStateSnapshotV1 } from "../../../src/engine/display/types";
import { encodeSseGuarded } from "../../../src/engine/display/sse-clients";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { fromEarthquakeOutcome } from "../../../src/engine/presentation/events/from-earthquake";
import { processEarthquake } from "../../../src/engine/presentation/processors/process-earthquake";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE53_DRILL_1,
  FIXTURE_VXSE53_DRILL_2,
} from "../../helpers/mock-message";

function fixtureProjection(name: string, nowMs: number) {
  const outcome = processEarthquake(createMockWsDataMessage(name));
  if (outcome == null) throw new Error(`${name}: parse failed`);
  const event = fromEarthquakeOutcome(outcome);
  const command = projectQuakeMapCommand(event, nowMs);
  if (command?.kind !== "upsert") throw new Error(`${name}: map upsert was not projected`);
  return {
    event,
    command,
    dto: projectDisplayEvent(event, "fixture earthquake", command),
  };
}

describe("quake map protocol/SSE", () => {
  it("実 VXSE53 fixture の最大 payload でも event は32KiBを圧迫せず snapshot は256KiB未満", () => {
    const nowMs = Date.parse("2026-07-30T12:00:00+09:00");
    const candidates = [FIXTURE_VXSE53_DRILL_1, FIXTURE_VXSE53_DRILL_2]
      .map((name) => fixtureProjection(name, nowMs))
      .sort((a, b) => JSON.stringify(b.command).length - JSON.stringify(a.command).length);
    const largest = candidates[0]!;

    const eventWire = encodeSseGuarded({ type: "event", event: largest.dto });
    expect(eventWire).not.toBeNull();
    expect(Buffer.byteLength(eventWire!, "utf8")).toBeLessThan(MAX_EVENT_BYTES);
    expect(JSON.stringify(largest.dto)).not.toContain('"localAreas"');

    const store = new DisplayStateStore();
    store.applyEvent(largest.dto, nowMs, null, largest.command);
    const snapshot = store.snapshot(1, nowMs);
    const snapshotWire = encodeSseGuarded({ type: "snapshot", snapshot });
    expect(snapshotWire).not.toBeNull();
    expect(Buffer.byteLength(snapshotWire!, "utf8")).toBeLessThan(MAX_SNAPSHOT_BYTES);
  });

  it("snapshot JSON round-trip で code/rank/event/source/revision/期限を保持する", () => {
    const nowMs = Date.parse("2026-07-30T12:00:00+09:00");
    const projected = fixtureProjection(FIXTURE_VXSE53_DRILL_1, nowMs);
    const store = new DisplayStateStore();
    store.applyEvent(projected.dto, nowMs, null, projected.command);
    const restored = JSON.parse(JSON.stringify(store.snapshot(1, nowMs))) as DisplayStateSnapshotV1;
    const quake = restored.mapLayers?.quake;
    expect(quake?.events[0]).toEqual(expect.objectContaining({
      eventKey: projected.command.event.eventKey,
      sourceType: projected.command.sourceType,
      revision: projected.command.revision,
      localAreas: projected.command.event.localAreas,
    }));
    expect(quake?.nonEmergencyHost).toEqual(
      projected.command.event.maxIntRank < 5
        ? { eventKey: projected.command.event.eventKey, expiresAtMs: nowMs + 5 * 60_000 }
        : null,
    );
  });
});
