import fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { processTsunami } from "../../../../src/engine/presentation/processors/process-tsunami";
import { TsunamiStateHolder } from "../../../../src/engine/messages/tsunami-state";
import { TelegramRevisionGate } from "../../../../src/engine/messages/telegram-revision-gate";
import { makeProcessDeps } from "../../../helpers/process-deps";
import { createMockWsDataMessage, createMockWsDataMessageFromXml, FIXTURE_VTSE41_WARN, FIXTURE_VTSE41_CANCEL } from "../../../helpers/mock-message";

vi.mock("../../../../src/engine/notification/sound-player", () => ({ playSound: vi.fn() }));

function requireOutcome(result: ReturnType<typeof processTsunami>) {
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error(`processTsunami returned ${result.kind}`);
  return result.outcome;
}

function cancellationForWarning() {
  const cancellation = createMockWsDataMessage(FIXTURE_VTSE41_CANCEL);
  return {
    ...cancellation,
    xmlReport: cancellation.xmlReport == null
      ? undefined
      : {
          ...cancellation.xmlReport,
          head: { ...cancellation.xmlReport.head, eventId: "20110311144640" },
        },
  };
}

describe("processTsunami", () => {
  it("正常な津波電文 → TsunamiOutcome", () => {
    const tsunamiState = new TsunamiStateHolder();
    const msg = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
    const outcome = requireOutcome(processTsunami(msg, makeProcessDeps({ tsunamiState })));
    expect(outcome.domain).toBe("tsunami");
    expect(outcome.statsCategory).toBe("tsunami");
  });

  it("VTSE41 で state.levelBefore/levelAfter を記録する", () => {
    const tsunamiState = new TsunamiStateHolder();
    const msg = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
    const outcome = requireOutcome(processTsunami(msg, makeProcessDeps({ tsunamiState })));
    expect(outcome.state.levelBefore).toBeNull();
    expect(outcome.state.levelAfter).not.toBeNull();
    expect(outcome.state.changed).toBe(true);
  });

  it("取消報 → frameLevel cancel + state changed", () => {
    const tsunamiState = new TsunamiStateHolder();
    // First set state
    const warn = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
    const deps = makeProcessDeps({ tsunamiState });
    processTsunami(warn, deps);
    // Then cancel
    const cancel = cancellationForWarning();
    const outcome = requireOutcome(processTsunami(cancel, deps));
    expect(outcome.presentation.frameLevel).toBe("cancel");
    expect(outcome.presentation.soundLevel).toBe("cancel");
  });

  it("発表→取消→古い発表の後着を suppressed にし、状態を復活させない", () => {
    const tsunamiState = new TsunamiStateHolder();
    const warn = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
    const cancel = cancellationForWarning();

    const deps = makeProcessDeps({ tsunamiState });
    expect(processTsunami(warn, deps).kind).toBe("ok");
    expect(processTsunami(cancel, deps).kind).toBe("ok");
    expect(processTsunami(warn, deps)).toEqual({ kind: "suppressed" });
    expect(tsunamiState.getLevel()).toBeNull();
    expect(tsunamiState.getLastInfo()).toBeNull();
  });

  it("live 初見の全解除は non-cancel gate だけを残す", () => {
    const tsunamiState = new TsunamiStateHolder();
    const revisionGate = new TelegramRevisionGate();
    const callback = vi.fn();
    const release = createMockWsDataMessage("32-39_13_07_250206_VTSE41.xml");
    const eventId = "20181204180000";

    expect(processTsunami(release, makeProcessDeps({
      tsunamiState,
      revisionGate,
      onTsunamiRevisionDecision: callback,
    })).kind).toBe("ok");
    expect(revisionGate.exportDurableEntries()).toEqual([
      expect.objectContaining({ stateSubjectKey: `tsunami:${eventId}`, cancelled: false }),
    ]);
    expect(tsunamiState.getPersistedKeyedActive()).toEqual([]);
    expect(tsunamiState.getLastInfo()).toBeNull();
    expect(tsunamiState.getDetail()).toBeNull();
    expect(tsunamiState.getPromptStatus()).toBeNull();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("警報→全解除→新しい transport time の古い警報を stale 抑止する", () => {
    const tsunamiState = new TsunamiStateHolder();
    const revisionGate = new TelegramRevisionGate();
    const decisions: string[] = [];
    const warn = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
    const releaseXml = fs.readFileSync("test/fixtures/32-39_13_07_250206_VTSE41.xml", "utf8")
      .replace("20181204180000", "20110311144640")
      .replace("2018-12-04T19:30:00+09:00", "2011-03-11T15:30:00+09:00");
    const release = createMockWsDataMessageFromXml(releaseXml, "VTSE41");
    const delayedWarn = { ...warn, head: { ...warn.head, time: "2026-01-01T00:00:00.000Z" } };
    const deps = makeProcessDeps({
      tsunamiState,
      revisionGate,
      onRevisionDecision: (decision) => decisions.push(decision.kind),
    });

    expect(processTsunami(warn, deps).kind).toBe("ok");
    expect(processTsunami(release, deps).kind).toBe("ok");
    expect(processTsunami(delayedWarn, deps)).toEqual({ kind: "suppressed" });
    expect(decisions.at(-1)).toBe("stale");
    expect(tsunamiState.getPersistedKeyedActive()).toEqual([]);
  });

  it("パース失敗 → parse-failed", () => {
    const tsunamiState = new TsunamiStateHolder();
    const msg = { type: "data" as const, version: "2.0", classification: "telegram.earthquake", id: "bad", passing: [], head: { type: "VTSE41", author: "気象庁", time: new Date().toISOString(), test: false, xml: true }, format: "xml" as const, compression: null, encoding: "utf-8" as const, body: "invalid" };
    expect(processTsunami(msg, makeProcessDeps({ tsunamiState }))).toEqual({ kind: "parse-failed" });
  });
});
