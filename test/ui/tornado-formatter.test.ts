import { describe, it, expect, afterEach } from "vitest";
import { displayTornadoAdvisory } from "../../src/ui/tornado-formatter";
import { parseTornadoAdvisory } from "../../src/dmdata/tornado-parser";
import { setDisplayMode, clearFrameWidth, setFrameWidth, visualWidth } from "../../src/ui/formatter";
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
