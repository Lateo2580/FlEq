import { describe, it, expect } from "vitest";
import { fromHeatAlertOutcome } from "../../../../src/engine/presentation/events/from-heat-alert";
import { processHeatAlert } from "../../../../src/engine/presentation/processors/process-heat-alert";
import {
  createMockWsDataMessage,
  FIXTURE_VPFT50_SAITAMA,
  FIXTURE_VPFT50_CANCEL,
  FIXTURE_VPFT50_TITLE_ESCALATION,
  FIXTURE_VPFT50_NO_BODY,
} from "../../../helpers/mock-message";

describe("fromHeatAlertOutcome", () => {
  it("targetAreaName が areaNames/areaItems に流れる (探索クラスタの region 解決)", () => {
    const outcome = processHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA))!;
    const event = fromHeatAlertOutcome(outcome);
    expect(event.areaNames).toEqual(["埼玉県"]);
    expect(event.areaItems[0].name).toBe("埼玉県");
    expect(event.areaCount).toBe(1);
  });

  it("headline は Comment 先頭文がフォールバック合成される (表示 headline)", () => {
    const outcome = processHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA))!;
    const event = fromHeatAlertOutcome(outcome);
    expect(event.headline).toContain("熱中症による人の健康に係る被害");
    expect(event.headline!.endsWith("。")).toBe(true);
  });

  it("isWarning は frameLevel 基準 (warning → true)", () => {
    const outcome = processHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA))!;
    expect(fromHeatAlertOutcome(outcome).isWarning).toBe(true);
  });

  it("isWarning は frameLevel 基準 (題名昇格 critical → true)", () => {
    const outcome = processHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_TITLE_ESCALATION))!;
    const event = fromHeatAlertOutcome(outcome);
    expect(event.frameLevel).toBe("critical");
    expect(event.isWarning).toBe(true);
  });

  it("取消は isCancellation=true / isWarning=false", () => {
    const outcome = processHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_CANCEL))!;
    const event = fromHeatAlertOutcome(outcome);
    expect(event.isCancellation).toBe(true);
    expect(event.isWarning).toBe(false);
  });

  it("bodyText が event に載る", () => {
    const outcome = processHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA))!;
    expect(fromHeatAlertOutcome(outcome).bodyText).toContain("ＷＢＧＴ");
  });

  it("本文なし電文では headline/bodyText とも null (フォールバックが空文字を作らない)", () => {
    const outcome = processHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_NO_BODY))!;
    const event = fromHeatAlertOutcome(outcome);
    expect(event.headline).toBeNull();
    expect(event.bodyText).toBeNull();
  });
});
