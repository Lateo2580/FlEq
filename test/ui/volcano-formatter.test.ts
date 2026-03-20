import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { displayVolcanoInfo } from "../../src/ui/volcano-formatter";
import { resolveVolcanoPresentation, VolcanoPresentation } from "../../src/engine/notification/volcano-presentation";
import { VolcanoStateHolder } from "../../src/engine/messages/volcano-state";
import { parseVolcanoTelegram } from "../../src/dmdata/volcano-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VFVO50_ALERT_LV3,
  FIXTURE_VFVO50_ALERT_CONTINUE,
  FIXTURE_VFVO50_ALERT_LOWER,
  FIXTURE_VFVO52_ERUPTION_1,
  FIXTURE_VFVO56_FLASH_1,
  FIXTURE_VFSV_MARINE,
  FIXTURE_VFVO51_NORMAL,
  FIXTURE_VFVO54_ASH_RAPID,
  FIXTURE_VFVO60_PLUME,
  FIXTURE_VZVO40_NOTICE,
} from "../helpers/mock-message";

describe("displayVolcanoInfo", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let volcanoState: VolcanoStateHolder;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    volcanoState = new VolcanoStateHolder();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  /** フィクスチャからパースして表示する */
  function displayFixture(fixture: string): string {
    const msg = createMockWsDataMessage(fixture);
    const info = parseVolcanoTelegram(msg)!;
    expect(info).not.toBeNull();
    const presentation = resolveVolcanoPresentation(info, volcanoState);
    displayVolcanoInfo(info, presentation);
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  it("VFVO50 レベル3引上げが表示される", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_LV3);
    expect(output).toContain("浅間山");
    expect(output).toContain("Lv3");
  });

  it("VFVO50 レベル5引上げが表示される", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_CONTINUE);
    expect(output).toContain("箱根山");
    expect(output).toContain("Lv5");
  });

  it("VFVO50 レベル1引下げが表示される", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_LOWER);
    expect(output).toContain("Lv1");
  });

  it("VFVO52 噴火観測報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO52_ERUPTION_1);
    expect(output).toContain("浅間山");
    expect(output).toContain("噴火");
  });

  it("VFVO56 噴火速報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO56_FLASH_1);
    expect(output).toContain("御嶽山");
    expect(output).toContain("噴火速報");
  });

  it("VFSVii 海上警報が表示される", () => {
    const output = displayFixture(FIXTURE_VFSV_MARINE);
    expect(output).toContain("桜島");
  });

  it("VFVO51 解説情報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO51_NORMAL);
    expect(output).toBeTruthy();
  });

  it("VFVO54 降灰速報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO54_ASH_RAPID);
    expect(output).toContain("桜島");
  });

  it("VFVO60 推定噴煙流向報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO60_PLUME);
    expect(output).toContain("桜島");
    expect(output).toContain("南東");
  });

  it("VZVO40 お知らせが表示される", () => {
    const output = displayFixture(FIXTURE_VZVO40_NOTICE);
    expect(output).toBeTruthy();
  });

  it("取消報が表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LV3);
    const info = parseVolcanoTelegram(msg)!;
    // infoType を取消に差し替え
    (info as Record<string, unknown>).infoType = "取消";
    const presentation: VolcanoPresentation = {
      frameLevel: "cancel",
      soundLevel: "cancel",
      summary: "取り消されました",
    };
    displayVolcanoInfo(info, presentation);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("取消");
  });
});
