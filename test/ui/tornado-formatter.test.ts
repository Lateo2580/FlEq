import { describe, it, expect, afterEach } from "vitest";
import { displayTornadoAdvisory, displayTornadoAdvisoryDetail } from "../../src/ui/tornado-formatter";
import { parseTornadoAdvisory } from "../../src/dmdata/tornado-parser";
import {
  clearFrameWidth,
  getFrameLineClampFallbackCount,
  resetFrameLineClampFallbackCount,
  setDisplayMode,
  setFrameWidth,
  visualWidth,
} from "../../src/ui/formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VPHW50_TOKYO,
  FIXTURE_VPHW51_SIGHTING,
} from "../helpers/mock-message";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
function capture(fn: () => void): string {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => logs.push(String(m ?? ""));
  try { fn(); } finally { console.log = orig; }
  return logs.join("\n");
}
afterEach(() => { setDisplayMode("normal"); clearFrameWidth(); });

describe("displayTornadoAdvisory - Phase D 配色言語", () => {
  it("VPHW51 (目撃あり): severity バナーが出て、目撃地域名を含む", () => {
    const info = parseTornadoAdvisory(createMockWsDataMessage(FIXTURE_VPHW51_SIGHTING))!;
    const out = capture(() => displayTornadoAdvisory(info));
    const plain = stripAnsi(out);
    expect(plain).toContain("◆◆");
    expect(plain).toContain("目撃情報あり");
  });

  it("VPHW51 フェイルセーフ (目撃地域抽出失敗): バナーは出るが地域不明表記", () => {
    const info = parseTornadoAdvisory(createMockWsDataMessage(FIXTURE_VPHW51_SIGHTING))!;
    info.sightingAreas = [];
    info.hasSightingAreas = false;
    // displaySeverity は parser 計算値のままなので nonLevelSpecial (isSightingTelegram=true)
    const out = capture(() => displayTornadoAdvisory(info));
    expect(stripAnsi(out)).toContain("地域不明");
  });

  it("VPHW50 (通常発表): severity バナーは出ない", () => {
    const info = parseTornadoAdvisory(createMockWsDataMessage(FIXTURE_VPHW50_TOKYO))!;
    const out = capture(() => displayTornadoAdvisory(info));
    expect(stripAnsi(out)).not.toContain("◆◆");
  });

  it.each([60, 80, 120])("幅 %i で全描画行の visualWidth が width 以下", (w) => {
    setFrameWidth(w);
    const info = parseTornadoAdvisory(createMockWsDataMessage(FIXTURE_VPHW51_SIGHTING))!;
    const out = capture(() => displayTornadoAdvisory(info));
    for (const line of out.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(w);
    }
  });

  it("長文目撃地域名 (幅60): severity バナー含む全行が width 以下に clip される", () => {
    setFrameWidth(60);
    const info = parseTornadoAdvisory(createMockWsDataMessage(FIXTURE_VPHW51_SIGHTING))!;
    info.sightingAreas = [
      { name: "とてもとてもとてもとてもとても長い目撃地域名その壱", code: "990001" , status: "active" },
      { name: "とてもとてもとてもとてもとても長い目撃地域名その弐", code: "990002" , status: "active" },
      { name: "とてもとてもとてもとてもとても長い目撃地域名その参", code: "990003" , status: "active" },
    ];
    info.hasSightingAreas = true;
    const out = capture(() => displayTornadoAdvisory(info));
    for (const line of out.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(60);
    }
  });

  it("31件目以降はカードから detail tornado へ誘導し、detail では全件を表示する", () => {
    setFrameWidth(80);
    const info = parseTornadoAdvisory(createMockWsDataMessage(FIXTURE_VPHW50_TOKYO))!;
    info.layers = [{
      type: "竜巻注意情報（市町村等）",
      areas: Array.from({ length: 31 }, (_, index) => ({
        name: `検証区域${String(index + 1).padStart(2, "0")}`,
        code: String(index + 1),
        status: "active" as const,
      })),
    }];

    const card = stripAnsi(capture(() => displayTornadoAdvisory(info)));
    expect(card).toContain("ほか 1 区域 (詳細: detail tornado)");
    expect(card).not.toContain("検証区域31");

    const detail = stripAnsi(capture(() => displayTornadoAdvisoryDetail(info)));
    expect(detail).toContain("検証区域31");
  });

  it("100件超の細粒度 layer でも、カードと detail は同じ対象地域を基準にする", () => {
    setFrameWidth(80);
    const info = parseTornadoAdvisory(createMockWsDataMessage(FIXTURE_VPHW50_TOKYO))!;
    info.layers = [
      {
        type: "竜巻注意情報（市町村等をまとめた地域等）",
        areas: [{ name: "粗い地域", code: "coarse", status: "active" }],
      },
      {
        type: "竜巻注意情報（市町村等）",
        areas: Array.from({ length: 101 }, (_, index) => ({
          name: `細粒度区域${String(index + 1).padStart(3, "0")}`,
          code: String(index + 1),
          status: "active" as const,
        })),
      },
    ];

    const card = stripAnsi(capture(() => displayTornadoAdvisory(info)));
    expect(card).toContain("ほか 71 区域 (詳細: detail tornado)");
    expect(card).not.toContain("粗い地域");

    const detail = stripAnsi(capture(() => displayTornadoAdvisoryDetail(info)));
    expect(detail).toContain("細粒度区域101");
    expect(detail).not.toContain("粗い地域");
  });

  it.each([40, 60, 80, 120, 200])("過長 title / region / headline / diagnostic を幅 %i に収める", (width) => {
    const info = parseTornadoAdvisory(createMockWsDataMessage(FIXTURE_VPHW51_SIGHTING))!;
    info.infoType = `発表 ${"追加種別情報 ".repeat(10)}`;
    info.title = `長い竜巻注意情報タイトル ${"目撃情報・対象地域 ".repeat(20)}`;
    info.headline = `長いヘッドライン ${"安全な場所へ移動してください。 ".repeat(40)}`;
    info.validDateTime = "2026-08-27T23:59:00+09:00";
    info.layers = [{
      type: `竜巻注意情報（市町村等） ${"対象地域階層 ".repeat(12)}`,
      areas: Array.from({ length: 31 }, (_, index) => ({
        name: `非常に長い目撃対象地域名${String(index + 1).padStart(2, "0")} ${"北部・南部 ".repeat(6)}`,
        code: String(index + 1),
        status: "active" as const,
      })),
    }];
    info.sightingAreas = info.layers[0]!.areas.slice(0, 3);
    info.hasSightingAreas = true;
    info.activeAreaCount = info.layers[0]!.areas.length;

    setFrameWidth(width);
    resetFrameLineClampFallbackCount();
    const out = capture(() => displayTornadoAdvisory(info));
    for (const line of out.split("\n")) {
      const plain = stripAnsi(line);
      const widthOfLine = visualWidth(plain);
      expect(widthOfLine, `width=${width} line=${JSON.stringify(plain.slice(0, 60))}`).toBeLessThanOrEqual(width);
      if (/^[┌╔├╠│║└╚]/.test(plain)) expect(widthOfLine).toBe(width);
    }
    expect(getFrameLineClampFallbackCount(), `width=${width}`).toBe(0);
  });

  // 代表 NO_COLOR snapshot (Codex R3 P1-5: sighting / normal / fail-safe / cancel)
  it.each([
    ["sighting", FIXTURE_VPHW51_SIGHTING],
    ["normal", FIXTURE_VPHW50_TOKYO],
  ])("NO_COLOR snapshot: %s", (_label, fx) => {
    setFrameWidth(80);
    const info = parseTornadoAdvisory(createMockWsDataMessage(fx))!;
    expect(stripAnsi(capture(() => displayTornadoAdvisory(info)))).toMatchSnapshot();
  });

  it("NO_COLOR snapshot: フェイルセーフ (目撃地域抽出失敗)", () => {
    setFrameWidth(80);
    const info = parseTornadoAdvisory(createMockWsDataMessage(FIXTURE_VPHW51_SIGHTING))!;
    info.sightingAreas = [];
    info.hasSightingAreas = false;
    expect(stripAnsi(capture(() => displayTornadoAdvisory(info)))).toMatchSnapshot();
  });

  it("NO_COLOR snapshot: 取消", () => {
    setFrameWidth(80);
    const info = parseTornadoAdvisory(createMockWsDataMessage(FIXTURE_VPHW50_TOKYO))!;
    info.infoType = "取消";
    expect(stripAnsi(capture(() => displayTornadoAdvisory(info)))).toMatchSnapshot();
  });
});
