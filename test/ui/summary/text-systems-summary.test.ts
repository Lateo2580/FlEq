import { describe, it, expect, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import { processSeismicText } from "../../../src/engine/presentation/processors/process-seismic-text";
import { processNankaiTrough } from "../../../src/engine/presentation/processors/process-nankai-trough";
import { processLgObservation } from "../../../src/engine/presentation/processors/process-lg-observation";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import { renderSummaryLine } from "../../../src/ui/summary/summary-line";
import { stripAnsi } from "../../../src/ui/formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE56_ACTIVITY_1,
  FIXTURE_VXSE60_1,
  FIXTURE_VXSE60_CANCEL,
  FIXTURE_VZSE40_NOTICE,
  FIXTURE_VZSE40_CANCEL,
  FIXTURE_VYSE50_ALERT,
  FIXTURE_VYSE50_CANCEL,
  FIXTURE_VYSE60_AFTERSHOCK,
  FIXTURE_VXSE62_LGOBS,
} from "../../helpers/mock-message";
import type { WsDataMessage } from "../../../src/types";
import type { ProcessOutcome } from "../../../src/engine/presentation/types";

/**
 * Phase 4a Task 0 (spec §2-5): compact 分岐削除の前提 = summary パイプラインが
 * 3 系統で機能していることの現物固定。既存 summary テストは VXSE56/VYSE50/VXSE62
 * 程度しかカバーしていない (Codex R2) ため VZSE40・VXSE60・VYSE60・取消報を含める。
 */
function summaryOf(fixture: string, type: string, proc: (msg: WsDataMessage) => ProcessOutcome | null): string {
  const msg = createMockWsDataMessage(fixture, {
    head: { type, author: "気象庁", time: new Date().toISOString(), test: false },
  });
  const outcome = proc(msg);
  expect(outcome, `${fixture} の parse`).not.toBeNull();
  return stripAnsi(renderSummaryLine(toPresentationEvent(outcome!), 120));
}

describe("summary パイプライン 3 系統実出力 (compact 分岐削除の前提)", () => {
  beforeEach(() => { chalk.level = 0; });
  afterEach(() => { chalk.level = 3; });

  it("地震テキスト: VXSE56 / VXSE60 / VZSE40 / 取消 ×2 で非空 1 行が出る", () => {
    for (const [fx, type] of [
      [FIXTURE_VXSE56_ACTIVITY_1, "VXSE56"],
      [FIXTURE_VXSE60_1, "VXSE60"],
      [FIXTURE_VZSE40_NOTICE, "VZSE40"],
      [FIXTURE_VXSE60_CANCEL, "VXSE60"],
      [FIXTURE_VZSE40_CANCEL, "VZSE40"],
    ] as const) {
      const line = summaryOf(fx, type, processSeismicText);
      expect(line.trim().length, `${fx}`).toBeGreaterThan(0);
      expect(line.includes("\n"), `${fx} は 1 行`).toBe(false);
    }
  });

  it("南海トラフ: VYSE50 (120) / VYSE60 / 取消 で非空 1 行が出る", () => {
    for (const [fx, type] of [
      [FIXTURE_VYSE50_ALERT, "VYSE50"],
      [FIXTURE_VYSE60_AFTERSHOCK, "VYSE60"],
      [FIXTURE_VYSE50_CANCEL, "VYSE50"],
    ] as const) {
      const line = summaryOf(fx, type, processNankaiTrough);
      expect(line.trim().length, `${fx}`).toBeGreaterThan(0);
      expect(line.includes("\n"), `${fx} は 1 行`).toBe(false);
    }
  });

  it("長周期観測: VXSE62 で非空 1 行が出る", () => {
    const line = summaryOf(FIXTURE_VXSE62_LGOBS, "VXSE62", processLgObservation);
    expect(line.trim().length).toBeGreaterThan(0);
  });
});
