import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEarthquakeTelegram } from "../../../src/dmdata/telegram-parser";
import { processEarthquake } from "../../../src/engine/presentation/processors/process-earthquake";
import { fromEarthquakeOutcome } from "../../../src/engine/presentation/events/from-earthquake";
import { buildTickerSentence } from "../../../src/engine/display/ticker-sentence";
import { projectRecentQuake } from "../../../src/engine/display/project-event";
import { DailyQuakeCounter } from "../../../src/engine/messages/daily-quake-counter";
import { DailyQuakePersistence } from "../../../src/engine/messages/daily-quake-persistence";
import { Notifier } from "../../../src/engine/notification/notifier";
import { displayEarthquakeInfo } from "../../../src/ui/earthquake-info-formatter";
import { stripAnsi } from "../../../src/ui/formatter";
import { notifyMock } from "../../setup";
import { createMockWsDataMessageFromXml, readFixture } from "../../helpers/mock-message";

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Phase 5A Magnitude/Depth transverse contract", () => {
  it("同一 XML を parser→formatter→notification→ticker→wire→persistence で意味維持する", () => {
    const msg = createMockWsDataMessageFromXml(
      readFixture("synthetic_phase5a_depth_600km_or_more.xml"),
      "VXSE52",
    );
    const parsed = parseEarthquakeTelegram(msg);
    expect(parsed?.earthquake?.magnitudeValue).toMatchObject({ presence: "value", value: 5 });
    expect(parsed?.earthquake?.depthValue).toMatchObject({
      presence: "range", lowerBound: 600, upperBound: null,
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    displayEarthquakeInfo(parsed!);
    const cli = stripAnsi(log.mock.calls.map((call) => String(call[0] ?? "")).join("\n"));
    log.mockRestore();
    expect(cli).toContain("M5.0");
    expect(cli).toContain("深さ 600km以上");

    notifyMock.mockClear();
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    notifier.notifyEarthquake(parsed!);
    expect(notifyMock.mock.calls.at(-1)?.[0]).toMatchObject({ message: expect.stringContaining("M5.0") });

    const outcome = processEarthquake(msg);
    expect(outcome).not.toBeNull();
    const event = fromEarthquakeOutcome(outcome!);
    expect(buildTickerSentence(event)).toContain("マグニチュード5.0の地震");

    const recent = projectRecentQuake(event);
    if (recent == null) throw new Error("recent quake projection が null");
    const wire = JSON.parse(JSON.stringify(recent)) as typeof recent;
    expect(wire.magnitudeSemantic).toMatchObject({
      presence: "value", value: 5, lowerBound: null, upperBound: null,
      rank: { kind: "value", value: 5 },
    });
    expect(wire.depthSemantic).toMatchObject({
      presence: "range", lowerBound: 600, upperBound: null,
    });
    const now = Date.parse("2026-08-09T00:00:01+09:00");
    const counter = new DailyQuakeCounter(now);
    counter.recordRecentQuake(recent, now);
    const sandbox = fs.mkdtempSync(path.join(process.cwd(), `.phase5a-contract-${process.pid}-`));
    sandboxes.push(sandbox);
    const persistence = new DailyQuakePersistence(path.join(sandbox, "daily-quake.json"), 0);
    persistence.save({ ...counter.export(), recentQuakes: [recent] }, now);
    const restored = persistence.load(now);
    expect(restored?.recentQuakes).toHaveLength(1);
    expect(restored?.recentQuakes[0]?.magnitudeSemantic).toEqual(recent.magnitudeSemantic);
    expect(restored?.recentQuakes[0]?.depthSemantic).toEqual(recent.depthSemantic);
  });
});
