import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectDisplayEvent,
  projectQuakeMapCommand,
  projectRecentQuake,
} from "../../../src/engine/display/project-event";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { quakeObservationMetaOf } from "../../../src/engine/display/quake-observation-merge";
import { DailyQuakeCounter } from "../../../src/engine/messages/daily-quake-counter";
import { DailyQuakePersistence } from "../../../src/engine/messages/daily-quake-persistence";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import type { PresentationEvent, ProcessOutcome } from "../../../src/engine/presentation/types";
import {
  createMockWsDataMessage,
  FIXTURE_PHASE7_5_VXSE51_072850,
  FIXTURE_PHASE7_5_VXSE53_073149,
  FIXTURE_PHASE7_5_VXSE61_113024,
} from "../../helpers/mock-message";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function realEvent(fixture: string): PresentationEvent {
  let outcome: ProcessOutcome | null = null;
  const runtime = createMessageHandler({
    outcomeTaps: [(candidate) => {
      if (candidate.domain === "volcano" && "sources" in candidate) return;
      outcome = candidate;
    }],
  });
  runtime.handler(createMockWsDataMessage(fixture));
  if (outcome == null) throw new Error(`${fixture} did not produce a linear outcome`);
  return toPresentationEvent(outcome);
}

function applyToDisplay(store: DisplayStateStore, event: PresentationEvent): void {
  const nowMs = Date.parse(event.reportDateTime);
  const mapCommand = projectQuakeMapCommand(event, nowMs);
  const dto = projectDisplayEvent(event, "§7.5 unit 6", mapCommand);
  store.applyEvent(dto, nowMs, null, mapCommand);
}

describe("§7.5 unit 6: real fixture persistence", () => {
  it("実 VXSE51→VXSE61 は daily save/restart 後も観測値保持と震源諸元更新が live と一致する", () => {
    const first = realEvent(FIXTURE_PHASE7_5_VXSE51_072850);
    const followup = realEvent(FIXTURE_PHASE7_5_VXSE61_113024);
    const firstNowMs = Date.parse(first.reportDateTime);
    const followupNowMs = Date.parse(followup.reportDateTime);
    const firstRecent = projectRecentQuake(first);
    const followupRecent = projectRecentQuake(followup);
    if (firstRecent == null || followupRecent == null) {
      throw new Error("real VXSE51/VXSE61 did not produce recent projections");
    }

    expect(quakeObservationMetaOf(firstRecent)).toMatchObject({
      sourceType: "VXSE51",
      observationSourceType: "VXSE51",
      maxIntValue: { presence: "value", value: "7" },
    });
    expect(quakeObservationMetaOf(followupRecent)).toMatchObject({
      sourceType: "VXSE61",
      intensityStructureMissing: true,
      maxIntValue: { presence: "missing" },
    });

    const liveDaily = new DailyQuakeCounter(firstNowMs);
    liveDaily.record(first, firstNowMs);
    liveDaily.recordRecentQuake(firstRecent, firstNowMs);
    liveDaily.recordRecentQuake(followupRecent, followupNowMs);

    const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".phase7_5-persistence-"));
    tempDirs.push(tempDir);
    const persistence = new DailyQuakePersistence(path.join(tempDir, "daily-quake.json"), 0);
    const persistedAt = followupNowMs + 1;
    const beforeRestart = new DailyQuakeCounter(firstNowMs);
    beforeRestart.record(first, firstNowMs);
    beforeRestart.recordRecentQuake(firstRecent, firstNowMs);
    persistence.save(beforeRestart.export(), persistedAt);

    const loaded = persistence.load(persistedAt + 1);
    expect(loaded).not.toBeNull();
    const restartedDaily = new DailyQuakeCounter(followupNowMs);
    expect(loaded == null ? false : restartedDaily.restore(loaded, followupNowMs)).toBe(true);
    restartedDaily.recordRecentQuake(followupRecent, followupNowMs);
    expect(restartedDaily.getRecentQuakes(followupNowMs)).toEqual(
      liveDaily.getRecentQuakes(followupNowMs),
    );

    const liveStore = new DisplayStateStore();
    applyToDisplay(liveStore, first);
    applyToDisplay(liveStore, followup);

    const restartedStore = new DisplayStateStore(
      undefined,
      undefined,
      undefined,
      () => restartedDaily.getRecentQuakes(followupNowMs),
    );
    applyToDisplay(restartedStore, followup);

    const liveSnapshot = liveStore.snapshot(1, followupNowMs);
    const restartedSnapshot = restartedStore.snapshot(1, followupNowMs);
    expect(restartedSnapshot.latestQuake).toEqual(liveSnapshot.latestQuake);
    expect(restartedSnapshot.recentQuakes).toEqual(liveSnapshot.recentQuakes);
    expect(restartedSnapshot.largeQuakes[0]).toMatchObject({
      eventId: "20260728162718",
      maxInt: "7",
      maxIntRank: 9,
      hypocenterName: liveSnapshot.largeQuakes[0]?.hypocenterName,
    });
  });

  it("実 VXSE53 の qualifier を含む詳細履歴は exact area semantic を daily restart で保つ", () => {
    const event = realEvent(FIXTURE_PHASE7_5_VXSE53_073149);
    const nowMs = Date.parse(event.reportDateTime);
    const recent = projectRecentQuake(event);
    if (recent == null) throw new Error("real VXSE53 did not produce a recent projection");

    const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".phase7_5-persistence-"));
    tempDirs.push(tempDir);
    const persistence = new DailyQuakePersistence(path.join(tempDir, "daily-quake.json"), 0);
    const counter = new DailyQuakeCounter(nowMs);
    counter.record(event, nowMs);
    counter.recordRecentQuake(recent, nowMs);
    persistence.save(counter.export(), nowMs + 1);

    const loaded = persistence.load(nowMs + 2);
    expect(loaded).not.toBeNull();
    const restored = new DailyQuakeCounter(nowMs + 2);
    expect(loaded == null ? false : restored.restore(loaded, nowMs + 2)).toBe(true);
    expect(restored.getSnapshot(nowMs + 2)).toMatchObject({
      todayQuakeCount: 1,
      todayMaxInt: "7",
      todayMaxIntRank: 9,
    });
    expect(restored.getRecentQuakes(nowMs + 2)[0]).toMatchObject({
      eventId: "20260728162718",
      maxInt: "7",
      maxIntRank: 9,
      intensityGroups: recent.intensityGroups,
    });
    expect(quakeObservationMetaOf(restored.getRecentQuakes(nowMs + 2)[0]!)).toMatchObject({
      sourceType: "VXSE53",
      observationSourceType: "VXSE53",
      maxIntValue: { presence: "value", value: "7" },
    });
  });
});
