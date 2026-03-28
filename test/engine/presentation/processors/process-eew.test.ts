import { describe, it, expect, vi, beforeEach } from "vitest";
import { processEew } from "../../../../src/engine/presentation/processors/process-eew";
import { EewTracker } from "../../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../../src/engine/eew/eew-logger";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE43_WARNING_S1,
  FIXTURE_VXSE43_WARNING_S2,
  FIXTURE_VXSE45_S1,
  FIXTURE_VXSE45_CANCEL,
} from "../../../helpers/mock-message";

// fs mock for EewEventLogger
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    existsSync: (p: string) => {
      if (typeof p === "string" && p.includes("eew-logs")) return true;
      return actual.existsSync(p);
    },
    mkdirSync: vi.fn(),
    promises: { ...actual.promises, appendFile: vi.fn().mockResolvedValue(undefined) },
  };
});

describe("processEew", () => {
  let eewTracker: EewTracker;
  let eewLogger: EewEventLogger;

  beforeEach(() => {
    eewTracker = new EewTracker();
    eewLogger = new EewEventLogger();
  });

  it("正常な EEW を処理して ok + EewOutcome を返す", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const result = processEew(msg, eewTracker, eewLogger);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.outcome.domain).toBe("eew");
    expect(result.outcome.parsed.isWarning).toBe(true);
    expect(result.outcome.presentation.frameLevel).toBe("critical");
    expect(result.outcome.presentation.soundLevel).toBe("critical");
    expect(result.outcome.stats.shouldRecord).toBe(true);
    expect(result.outcome.stats.eventId).toBeDefined();
    expect(result.outcome.statsCategory).toBe("eew");
  });

  it("重複報は duplicate を返す", () => {
    const msg1 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    processEew(msg1, eewTracker, eewLogger);

    const msg2 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const result = processEew(msg2, eewTracker, eewLogger);
    expect(result.kind).toBe("duplicate");
  });

  it("異なる Serial は ok を返す", () => {
    const msg1 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    processEew(msg1, eewTracker, eewLogger);

    const msg2 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S2);
    const result = processEew(msg2, eewTracker, eewLogger);
    expect(result.kind).toBe("ok");
  });

  it("パース失敗は parse-failed を返す", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "eew.forecast",
      id: "test-bad",
      passing: [],
      head: { type: "VXSE45", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid-xml",
    };
    const result = processEew(msg, eewTracker, eewLogger);
    expect(result.kind).toBe("parse-failed");
  });

  it("取消報の frameLevel は cancel", () => {
    const first = createMockWsDataMessage(FIXTURE_VXSE45_S1);
    processEew(first, eewTracker, eewLogger);

    const cancel = createMockWsDataMessage(FIXTURE_VXSE45_CANCEL);
    const result = processEew(cancel, eewTracker, eewLogger);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.outcome.presentation.frameLevel).toBe("cancel");
  });

  it("state フィールドが正しく設定される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const result = processEew(msg, eewTracker, eewLogger);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.outcome.state.activeCount).toBeGreaterThanOrEqual(1);
    expect(result.outcome.state.colorIndex).toBeGreaterThanOrEqual(0);
    expect(result.outcome.state.isDuplicate).toBe(false);
  });
});
