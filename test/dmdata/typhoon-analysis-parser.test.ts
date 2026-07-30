import { describe, it, expect } from "vitest";
import { createMockWsDataMessage, createMockWsDataMessageFromXml, readFixture } from "../helpers/mock-message";
import {
  FIXTURE_VPTW60_2020,
  FIXTURE_VPTW60_2017,
  FIXTURE_VPTW61,
  FIXTURE_VPTW60_CANCEL,
} from "../helpers/mock-message";
import { parseTyphoonAnalysis } from "../../src/dmdata/typhoon-analysis-parser";

describe("parseTyphoonAnalysis", () => {
  it("2020形式: 実況+予報6コマ=7コマ、実況は確定座標、予報は予報円", () => {
    const info = parseTyphoonAnalysis(createMockWsDataMessage(FIXTURE_VPTW60_2020));
    expect(info).not.toBeNull();
    expect(info!.type).toBe("VPTW60");
    expect(info!.infoKindVersion).toBe("1.0_2");
    expect(info!.frames).toHaveLength(7);
    const now = info!.frames[0];
    expect(now.kind).toBe("実況");
    expect(now.center.coordinate).toContain("北緯");
    expect(now.center.forecastCircleRadiusKm).toBeNull();
    expect(now.center.pressureHpa).toBe(1002);
    expect(now.wind!.maxWindMs).toBe(15);
    expect(now.wind!.maxGustMs).toBe(23);
    const f12 = info!.frames[1];
    expect(f12.kind).toBe("予報");
    expect(f12.center.forecastCircleRadiusKm).toBe(110);
    expect(f12.center.coordinate).toBeNull();
    expect(f12.typhoonClass.category).toBe("台風(TS)");
    expect(info!.lifecycle).toBe("forming");
  });

  it("2017形式: 14コマ、命名済(TALIM)、推定コマは確定座標", () => {
    const info = parseTyphoonAnalysis(createMockWsDataMessage(FIXTURE_VPTW60_2017));
    expect(info!.frames).toHaveLength(14);
    expect(info!.name?.name).toBe("TALIM");
    expect(info!.name?.number).toBe("1718");
    const estimate = info!.frames.find((f) => f.kind === "推定")!;
    expect(estimate.center.coordinate).toContain("北緯");
    expect(estimate.center.forecastCircleRadiusKm).toBeNull();
    expect(estimate.typhoonClass.intensity).toBe("非常に強い");
    expect(estimate.wind!.stormArea?.axes[0].radiusKm).toBe(150);
    expect(info!.lifecycle).toBe("active");
  });

  it("VPTW61: 実況のみ1コマ", () => {
    const info = parseTyphoonAnalysis(createMockWsDataMessage(FIXTURE_VPTW61));
    expect(info!.type).toBe("VPTW61");
    expect(info!.frames).toHaveLength(1);
    expect(info!.frames[0].kind).toBe("実況");
    expect(info!.lifecycle).toBe("formationCancelled");
  });

  it("取消", () => {
    const info = parseTyphoonAnalysis(createMockWsDataMessage(FIXTURE_VPTW60_CANCEL));
    expect(info!.infoType).toBe("取消");
  });

  it("実況が温帯低気圧へ遷移した報を終了 lifecycle にする", () => {
    const xml = readFixture(FIXTURE_VPTW60_2020)
      .replace("<Remark>台風発生予想</Remark>", "<Remark>台風消滅（温帯低気圧化）</Remark>")
      .replace("熱帯低気圧(TD)", "温帯低気圧(LOW)");
    const info = parseTyphoonAnalysis(createMockWsDataMessageFromXml(xml, "VPTW60"));
    expect(info?.lifecycle).toBe("transitionedToLow");
  });
});
