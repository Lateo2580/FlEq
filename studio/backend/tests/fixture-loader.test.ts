import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { loadFixture, listWeatherFixtures } from "../lib/fixture-loader";
import { findWeatherEntry } from "../registry/weather-registry";

describe("fixture-loader", () => {
  it("VPWW55 fixture を WsDataMessage として読める", () => {
    const msg = loadFixture("15_17_01_251222_VPWW55.xml");
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("data");
    expect(msg!.classification).toBe("telegram.weather");
    expect(msg!.head.type).toBe("VPWW55");
    expect(msg!.compression).toBe("gzip");
    expect(msg!.encoding).toBe("base64");
    expect(msg!.format).toBe("xml");
    expect(typeof msg!.body).toBe("string");
    expect(msg!.body.length).toBeGreaterThan(0);
  });

  it("存在しない fixture は null を返す", () => {
    const msg = loadFixture("nonexistent.xml");
    expect(msg).toBeNull();
  });

  it("パス区切りや .. を含む id は null (fixtures 外への到達を拒否)", () => {
    expect(loadFixture("../package.json")).toBeNull();
    expect(loadFixture("..\\..\\package.json")).toBeNull();
    expect(loadFixture("selected_xml/15_17_01_251222_VPWW55.xml")).toBeNull();
    expect(loadFixture("..")).toBeNull();
  });

  it("listWeatherFixtures は VPWW55 を含む weather 系統 fixture を返す", () => {
    const fixtures = listWeatherFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    const vpww55 = fixtures.find((f) => f.id === "15_17_01_251222_VPWW55.xml");
    expect(vpww55).toBeDefined();
    expect(vpww55!.type).toBe("VPWW55");
    expect(vpww55!.label).toContain("VPWW55");
  });

  it("VPWP50 fixture を weather として読める (Phase B 対象)", () => {
    const msg = loadFixture("81_01_01_260129_VPWP50.xml");
    expect(msg).not.toBeNull();
    expect(msg!.head.type).toBe("VPWP50");
    expect(msg!.classification).toBe("telegram.weather");
  });

  it("listWeatherFixtures に VPWP50 が含まれる", () => {
    const fixtures = listWeatherFixtures();
    expect(fixtures.some((f) => f.type === "VPWP50")).toBe(true);
  });

  it("VXKO50 fixture を weather として読める (洪水・水位系、registry 未登録だが loader は拾う)", () => {
    const msg = loadFixture("16_02_01_220728_VXKO50.xml");
    expect(msg).not.toBeNull();
    expect(msg!.head.type).toBe("VXKO50");
    expect(msg!.classification).toBe("telegram.weather");
  });

  it("VXSU50 fixture を weather として読める (水位周知河川)", () => {
    const msg = loadFixture("91_01_01_241031_VXSU50.xml");
    expect(msg).not.toBeNull();
    expect(msg!.head.type).toBe("VXSU50");
    expect(msg!.classification).toBe("telegram.weather");
  });

  it("listWeatherFixtures に VXKO50 / VXSU50 が含まれる", () => {
    const fixtures = listWeatherFixtures();
    expect(fixtures.some((f) => f.type === "VXKO50")).toBe(true);
    expect(fixtures.some((f) => f.type === "VXSU50")).toBe(true);
  });

  it("listWeatherFixtures に VXSE51 (地震) / VTSE41 (津波) が含まれる (registry 登録系統の一覧表示)", () => {
    const ids = listWeatherFixtures().map((f) => f.id);
    expect(ids).toContain("32-35_08_03_100915_VXSE51.xml");
    expect(ids).toContain("32-39_11_02_250206_VTSE41.xml");
  });

  it("listWeatherFixtures に VFVO50 / VFSVii / VZVO40 (火山) が含まれる (registry 登録系統の一覧表示)", () => {
    const ids = listWeatherFixtures().map((f) => f.id);
    expect(ids).toContain("45_01_01_200522_VFVO50.xml");
    expect(ids).toContain("46_01_01_170103_VFSVii.xml");
    expect(ids).toContain("42_02_01_071130_VZVO40.xml");
  });

  it("listWeatherFixtures に VYSE / VZSE40 / VXSE62 (selected_xml 配下) が basename id で含まれる", () => {
    const list = listWeatherFixtures();
    const ids = list.map((f) => f.id);
    expect(ids).toContain("74_01_04_200512_VYSE50.xml");   // critical (code 120)
    expect(ids).toContain("80_01_01_240821_VYSE60.xml");
    expect(ids).toContain("42_01_01_100514_VZSE40.xml");
    expect(ids).toContain("78_01_01_240613_VXSE62.xml");
    // id は basename 必須 (loadFixture の path guard と整合)
    for (const id of ids) {
      expect(id).toBe(path.basename(id));
    }
  });

  it("直下と selected_xml に basename 重複がない (id 衝突 invariant、衝突時は直下優先の前提固定)", () => {
    const fixturesDir = path.resolve(__dirname, "../../../test/fixtures");
    const direct = new Set(fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".xml")));
    const selected = fs
      .readdirSync(path.join(fixturesDir, "selected_xml"))
      .filter((f) => f.endsWith(".xml"));
    const dup = selected.filter((f) => direct.has(f));
    expect(dup).toEqual([]);
  });

  it("本 Phase 追加分 (VYSE / VZSE + VXSE56/60/62) が全て registry supported — 一覧に出るのに render 未対応がない (既知の例外: EEW VXSE43/44/45 は Phase 4b)", () => {
    const targets = listWeatherFixtures().filter(
      (f) =>
        f.type.startsWith("VYSE") ||
        f.type.startsWith("VZSE") ||
        f.type === "VXSE56" || f.type === "VXSE60" || f.type === "VXSE62",
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const f of targets) {
      expect(findWeatherEntry(f.id), `${f.id} (${f.type})`).not.toBeNull();
    }
  });
});
