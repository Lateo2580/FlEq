import { describe, it, expect, afterEach } from "vitest";
import chalk from "chalk";
import { displayHeatAlertInfo } from "../../src/ui/heat-alert-formatter";
import { parseHeatAlert } from "../../src/dmdata/heat-alert-parser";
import { clearFrameWidth, setFrameWidth, visualWidth } from "../../src/ui/formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VPFT50_SAITAMA,
  FIXTURE_VPFT50_CANCEL,
  FIXTURE_VPFT50_TITLE_ESCALATION,
} from "../helpers/mock-message";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
function capture(fn: () => void): string {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => logs.push(String(m ?? ""));
  try { fn(); } finally { console.log = orig; }
  return logs.join("\n");
}
afterEach(() => { clearFrameWidth(); });

describe("displayHeatAlertInfo", () => {
  it("発表: タイトル・対象府県・本文が表示される", () => {
    setFrameWidth(80);
    const info = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA))!;
    const out = stripAnsi(capture(() => displayHeatAlertInfo(info)));
    expect(out).toContain("熱中症警戒アラート");
    expect(out).toContain("埼玉県");
    expect(out).toContain("熱中症予防");
  });

  it("取消表示に info.title (対象府県入り) が含まれる", () => {
    setFrameWidth(80);
    const info = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_CANCEL))!;
    const out = stripAnsi(capture(() => displayHeatAlertInfo(info)));
    expect(out).toContain("埼玉県熱中症警戒アラート");
    expect(out).toContain("この情報は取り消されました");
  });

  it("題名昇格 (critical) でバナーが出る", () => {
    setFrameWidth(80);
    const info = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_TITLE_ESCALATION))!;
    const out = stripAnsi(capture(() => displayHeatAlertInfo(info)));
    expect(out).toContain(info.title);
    // バナー (フレーム外の色面) の存在は snapshot で固定
  });

  it("通常の発表 (warning) ではバナーが出ない", () => {
    setFrameWidth(80);
    const info = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA))!;
    const out = capture(() => displayHeatAlertInfo(info));
    // 先頭行がフレーム上辺であること (バナー無し)。枠文字は実 formatter の出力に合わせる
    const firstLine = out.split("\n").find((l) => stripAnsi(l).trim() !== "")!;
    expect(stripAnsi(firstLine)).toMatch(/^[┏┌╔]/);
  });

  it.each([60, 80, 120])("幅 %i で全描画行 (バナー含む) の visualWidth が width 以下", (w) => {
    setFrameWidth(w);
    for (const fx of [FIXTURE_VPFT50_SAITAMA, FIXTURE_VPFT50_TITLE_ESCALATION, FIXTURE_VPFT50_CANCEL]) {
      const info = parseHeatAlert(createMockWsDataMessage(fx))!;
      const out = capture(() => displayHeatAlertInfo(info));
      for (const line of out.split("\n")) {
        expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(w);
      }
    }
  });

  it("フレーム全面が severity 色 (下辺にも nonLevelWarning の ANSI が乗る)", () => {
    // weather 系の「本文罫線は白系」言語から意図的に離れ、VPFT50 は全面 severity 色
    // (2026-06-13 レビュー決定。上下分裂の解消)。nonLevelWarning text RGB = (213, 94, 0)
    const prevLevel = chalk.level;
    chalk.level = 3;
    try {
      setFrameWidth(80);
      const info = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA))!;
      const out = capture(() => displayHeatAlertInfo(info));
      // warning level のフレーム下辺は ╚ (FRAME_CHARS.warning.bl)
      const bottomLine = out.split("\n").find((l) => stripAnsi(l).includes("╚"))!;
      expect(bottomLine).toBeDefined();
      expect(bottomLine).toContain("\x1b[38;2;213;94;0m");
    } finally {
      chalk.level = prevLevel;
    }
  });

  it.each([
    ["発表", FIXTURE_VPFT50_SAITAMA],
    ["題名昇格", FIXTURE_VPFT50_TITLE_ESCALATION],
    ["取消", FIXTURE_VPFT50_CANCEL],
  ])("NO_COLOR snapshot: %s", (_label, fx) => {
    setFrameWidth(80);
    const info = parseHeatAlert(createMockWsDataMessage(fx))!;
    expect(stripAnsi(capture(() => displayHeatAlertInfo(info)))).toMatchSnapshot();
  });
});
