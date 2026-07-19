import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { fixturesRoute } from "../routes/fixtures";

function makeApp() {
  const app = new Hono();
  app.route("/api/fixtures", fixturesRoute());
  return app;
}

describe("GET /api/fixtures", () => {
  it("weather fixture 一覧を JSON で返す", async () => {
    const app = makeApp();
    const res = await app.request("/api/fixtures");
    expect(res.status).toBe(200);
    const body = await res.json() as { fixtures: Array<{ id: string; type: string; label: string; supported: boolean }> };
    expect(Array.isArray(body.fixtures)).toBe(true);
    expect(body.fixtures.length).toBeGreaterThan(0);

    const vpww55 = body.fixtures.find((f) => f.id === "15_17_01_251222_VPWW55.xml");
    expect(vpww55).toBeDefined();
    expect(vpww55!.supported).toBe(true);

    // VPWW56-61 も core formatter 経路でカバー済み
    const vpww56 = body.fixtures.find((f) => f.id === "15_16_01_241031_VPWW56.xml");
    expect(vpww56).toBeDefined();
    expect(vpww56!.supported).toBe(true);
  });

  it("registry 拡大後は weather 一覧の全 fixture が supported (洪水含む)", async () => {
    const app = makeApp();
    const res = await app.request("/api/fixtures");
    const body = await res.json() as { fixtures: Array<{ id: string; type: string; supported: boolean }> };
    const vpws50 = body.fixtures.find((f) => f.id === "15_18_01_250630_VPWS50.xml");
    expect(vpws50).toBeDefined();
    expect(vpws50!.supported).toBe(true); // Phase 1a では false だった (registry 拡大 2026-06-11)
    const vpwp50 = body.fixtures.find((f) => f.id === "81_01_01_260129_VPWP50.xml");
    expect(vpwp50).toBeDefined();
    expect(vpwp50!.supported).toBe(true);
    // 洪水・水位系 (VXKO50-89 / VXSU50-59) は 2026-06-16 に registry 9 系統目として登録。
    // 1 entry で VXKO/VXSU 両方をカバー (formatter 内部で schema 分岐)。
    const vxko50 = body.fixtures.find((f) => f.id === "16_01_01_220728_VXKO50.xml");
    expect(vxko50).toBeDefined();
    expect(vxko50!.supported).toBe(true);
    const vxsu50 = body.fixtures.find((f) => f.id === "91_01_01_241031_VXSU50.xml");
    expect(vxsu50).toBeDefined();
    expect(vxsu50!.supported).toBe(true);
  });

  it("地震 (VXSE51/52/53/61) / 津波 (VTSE41/51/52) / EEW (VXSE43) が一覧に出て supported (Phase 4b で EEW も登録)", async () => {
    const app = makeApp();
    const res = await app.request("/api/fixtures");
    const body = await res.json() as { fixtures: Array<{ id: string; type: string; supported: boolean }> };

    const vxse51 = body.fixtures.find((f) => f.id === "32-35_08_03_100915_VXSE51.xml");
    expect(vxse51).toBeDefined();
    expect(vxse51!.supported).toBe(true);
    const vxse61 = body.fixtures.find((f) => f.id === "32-35_03_02_240613_VXSE61.xml");
    expect(vxse61).toBeDefined();
    expect(vxse61!.supported).toBe(true);
    const vtse41 = body.fixtures.find((f) => f.id === "32-39_11_02_250206_VTSE41.xml");
    expect(vtse41).toBeDefined();
    expect(vtse41!.supported).toBe(true);

    // Phase 4b: EEW (VXSE43/44/45) も registry 登録済み → supported=true
    const vxse43 = body.fixtures.find((f) => f.id === "37_01_01_240613_VXSE43.xml");
    expect(vxse43).toBeDefined();
    expect(vxse43!.supported).toBe(true);
  });

  it("Phase 4a 追加分 (地震活動テキスト/南海トラフ/長周期観測) が一覧に出て supported", async () => {
    const app = makeApp();
    const res = await app.request("/api/fixtures");
    const body = await res.json() as { fixtures: Array<{ id: string; type: string; supported: boolean }> };

    const vxse56 = body.fixtures.find((f) => f.id === "32-35_09_01_191111_VXSE56.xml");
    expect(vxse56).toBeDefined();
    expect(vxse56!.supported).toBe(true);
    const vzse40 = body.fixtures.find((f) => f.id === "42_01_01_100514_VZSE40.xml");
    expect(vzse40).toBeDefined();
    expect(vzse40!.supported).toBe(true);
    const vyse50 = body.fixtures.find((f) => f.id === "74_01_04_200512_VYSE50.xml");
    expect(vyse50).toBeDefined();
    expect(vyse50!.supported).toBe(true);
    const vxse62 = body.fixtures.find((f) => f.id === "78_01_01_240613_VXSE62.xml");
    expect(vxse62).toBeDefined();
    expect(vxse62!.supported).toBe(true);
  });
});
