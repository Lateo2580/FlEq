import { describe, it, expect, afterEach } from "vitest";
import chalk from "chalk";
import { displayWeatherBriefing } from "../../src/ui/briefing-formatter";
import { parseWeatherBriefing } from "../../src/dmdata/briefing-parser";
import {
  setDisplayMode,
  clearFrameWidth,
  setFrameWidth,
  visualWidth,
  getFrameLineClampFallbackCount,
  resetFrameLineClampFallbackCount,
} from "../../src/ui/formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VPBS50_LINEAR_OBSERVED,
  FIXTURE_VPBS50_SHORT_SNOW,
  FIXTURE_VPBS50_SYNTH_MULTI,
  FIXTURE_VPBS50_SYNTH_UNKNOWN,
} from "../helpers/mock-message";
import { SEVERITY_LABELS } from "../../src/ui/formatter";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
function capture(fn: () => void): string {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => logs.push(String(m ?? ""));
  try { fn(); } finally { console.log = orig; }
  return logs.join("\n");
}
afterEach(() => { setDisplayMode("normal"); clearFrameWidth(); });

describe("displayWeatherBriefing - Phase D 配色言語", () => {
  it("nonLevelSpecial (線状降水帯発生): severity バナー (3 行色面) が出る", () => {
    const info = parseWeatherBriefing(createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED))!;
    const out = capture(() => displayWeatherBriefing(info));
    expect(out).toContain("線状降水帯発生");
    const plain = stripAnsi(out);
    expect(plain).toContain("◆◆"); // nonLevelSpecial の tier prefix
  });

  it("nonLevelWarning (短時間大雪): severity バナーは出ず、タグはテキストで残る", () => {
    const info = parseWeatherBriefing(createMockWsDataMessage(FIXTURE_VPBS50_SHORT_SNOW))!;
    const out = capture(() => displayWeatherBriefing(info));
    expect(stripAnsi(out)).toContain("短時間大雪");
    expect(stripAnsi(out)).not.toContain("◆◆");
  });

  it.each([60, 80, 120])("幅 %i で全描画行 (バナー含む) の visualWidth が width 以下", (w) => {
    setFrameWidth(w);
    const info = parseWeatherBriefing(createMockWsDataMessage(FIXTURE_VPBS50_SYNTH_MULTI))!;
    const out = capture(() => displayWeatherBriefing(info));
    for (const line of out.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(w);
    }
  });

  it("バナーはラベル固定 (地域名なし) でも幅 60 端末で全行が幅以下 (clip 保険)", () => {
    // 2026-06-12 レビュー決定: バナーから地域名を除去。バナーは「◆◆ 線状降水帯発生」固定。
    // 長い地域名を本文に注入しても、本文 [対象地域] は折返し・バナーは clip で幅を超えないことを検証。
    setFrameWidth(60);
    const info = parseWeatherBriefing(createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED))!;
    info.targetAreas = [{ name: "とてもとてもとてもとてもとてもとても長い地域名の例示テキスト", code: "999999" }];
    const out = capture(() => displayWeatherBriefing(info));
    // バナー行に地域名が混ざらないこと (固定ラベルのみ)
    expect(stripAnsi(out)).toContain("◆◆ 線状降水帯発生");
    for (const line of out.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(60);
    }
  });

  it("取消: フレームが短形式のまま (取消文言 + フッター)", () => {
    const info = parseWeatherBriefing(createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED))!;
    info.infoType = "取消";
    const out = capture(() => displayWeatherBriefing(info));
    expect(stripAnsi(out)).toContain("取り消されました");
  });

  it.each([40, 60, 80, 120, 200])("過長 title / region / type / headline / prose を幅 %i に収める", (width) => {
    const originalLevel = chalk.level;
    try {
      for (const level of [0, 3] as const) {
        chalk.level = level;
        setFrameWidth(width);
        resetFrameLineClampFallbackCount();
        const base = parseWeatherBriefing(
          createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED),
        )!;
        const info = {
          ...base,
          infoType: `発表 ${"追加種別情報 ".repeat(10)}`,
          title: `長い気象防災速報タイトル ${"対象地域情報・電文情報 ".repeat(20)}`,
          headline: `長いヘッドライン ${"安全な場所へ移動してください。 ".repeat(40)}`,
          targetAreas: Array.from({ length: 4 }, (_, index) => ({
            name: `非常に長い対象地域名${index + 1} ${"北部・南部・沿岸部 ".repeat(8)}`,
            code: `99${String(index + 1).padStart(4, "0")}`,
          })),
          observations: [
            ...base.observations.map((observation) => ({
              ...observation,
              observationType: `長い観測種別 ${"気象観測情報 ".repeat(6)}`,
              description: `長い観測本文 ${"観測値と今後の推移を確認してください。 ".repeat(20)}`,
              locationName: `長い観測地点名 ${"観測地点情報 ".repeat(8)}`,
            })),
            {
              partKind: "other" as const,
              observationType: `長い予測種別 ${"予測情報 ".repeat(6)}`,
              description: `長い予測本文 ${"今後の情報に注意してください。 ".repeat(20)}`,
              value: 123,
              unit: "mm",
              time: "2026-08-27T12:34:00+09:00",
              locationName: `長い予測地点名 ${"対象地点 ".repeat(8)}`,
              locationCode: "999999",
              sourceType: "予測",
              contextTime: "2026-08-27T12:00:00+09:00",
              duration: null,
              approximation: "unknown" as const,
            },
          ],
        };
        const out = capture(() => displayWeatherBriefing(info));
        for (const line of out.split("\n")) {
          const plain = stripAnsi(line);
          const widthOfLine = visualWidth(plain);
          expect(widthOfLine, `color=${level} width=${width} line=${JSON.stringify(plain.slice(0, 60))}`)
            .toBeLessThanOrEqual(width);
          if (/^[┏┓┗┛┌┐├╠│║└╚]/.test(plain)) expect(widthOfLine).toBe(width);
        }
        expect(getFrameLineClampFallbackCount(), `color=${level} width=${width}`).toBe(0);
      }
    } finally {
      chalk.level = originalLevel;
      clearFrameWidth();
    }
  });

  // 代表 NO_COLOR snapshot (Codex R3 P1-5。stripAnsi で色を落とし構造を固定)
  it.each([
    ["nonLevelSpecial", FIXTURE_VPBS50_LINEAR_OBSERVED],
    ["nonLevelWarning", FIXTURE_VPBS50_SHORT_SNOW],
    ["multi", FIXTURE_VPBS50_SYNTH_MULTI],
  ])("NO_COLOR snapshot: %s", (_label, fx) => {
    setFrameWidth(80);
    const info = parseWeatherBriefing(createMockWsDataMessage(fx))!;
    expect(stripAnsi(capture(() => displayWeatherBriefing(info)))).toMatchSnapshot();
  });

  it("NO_COLOR snapshot: 取消", () => {
    setFrameWidth(80);
    const info = parseWeatherBriefing(createMockWsDataMessage(FIXTURE_VPBS50_LINEAR_OBSERVED))!;
    info.infoType = "取消";
    expect(stripAnsi(capture(() => displayWeatherBriefing(info)))).toMatchSnapshot();
  });
});
