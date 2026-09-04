import { describe, it, expect } from "vitest";
import {
  isTsunamiReleaseOnlyForecast,
  normalizeTsunamiKind,
  resolveTsunamiLevel,
} from "../../src/utils/tsunami-kind";

describe("normalizeTsunamiKind", () => {
  it("接尾辞つき表記を canonical ラベルへ正規化する", () => {
    expect(normalizeTsunamiKind("大津波警報：発表")).toBe("大津波警報");
    expect(normalizeTsunamiKind("津波警報：発表")).toBe("津波警報");
    expect(normalizeTsunamiKind("津波注意報：発表")).toBe("津波注意報");
  });

  it("既に canonical な表記はそのまま返す", () => {
    expect(normalizeTsunamiKind("大津波警報")).toBe("大津波警報");
  });

  it("「大津波警報」を「津波警報」に誤判定しない (大津波警報を先に判定する)", () => {
    expect(normalizeTsunamiKind("大津波警報：発表")).not.toBe("津波警報");
  });

  it("前後に空白があっても trim してから判定する", () => {
    expect(normalizeTsunamiKind("  大津波警報  ")).toBe("大津波警報");
    expect(normalizeTsunamiKind(" 津波警報：発表")).toBe("津波警報");
  });

  it("一致しない表記 (津波予報等) は trim 後の文字列をそのまま返す", () => {
    expect(normalizeTsunamiKind("津波予報（若干の海面変動）")).toBe("津波予報（若干の海面変動）");
  });
});

describe("resolveTsunamiLevel", () => {
  it("大津波警報を含む場合は最上位を返す", () => {
    expect(resolveTsunamiLevel(["津波注意報", "大津波警報", "津波警報"])).toEqual({
      level: "majorWarning",
      label: "大津波警報",
    });
  });

  it("津波警報が最大の場合は警報を返す", () => {
    expect(resolveTsunamiLevel(["津波注意報", "津波警報"])).toEqual({
      level: "warning",
      label: "津波警報",
    });
  });

  it("津波注意報のみの場合は注意報を返す", () => {
    expect(resolveTsunamiLevel(["津波注意報"])).toEqual({
      level: "advisory",
      label: "津波注意報",
    });
  });

  it("津波予報のみ、または空配列の場合は null を返す", () => {
    expect(resolveTsunamiLevel(["津波予報（若干の海面変動）"])).toBeNull();
    expect(resolveTsunamiLevel([])).toBeNull();
  });

  it("接尾辞・前後空白を正規化して最高レベルを返す", () => {
    expect(resolveTsunamiLevel(["津波警報", " 大津波警報：発表 ", "津波注意報"])).toEqual({
      level: "majorWarning",
      label: "大津波警報",
    });
  });
});

describe("解除 kind (Kind Code 60 系) の扱い", () => {
  it.each([
    { label: "Code 60 only", forecast: [{ kindCode: "60" }, { kindCode: " 60 " }], expected: true },
    { label: "Code 60 + 62", forecast: [{ kindCode: "60" }, { kindCode: "62" }], expected: false },
    { label: "Code 71 only", forecast: [{ kindCode: "71" }], expected: false },
    { label: "empty", forecast: [], expected: false },
    { label: "missing code", forecast: [{ kindCode: null }], expected: false },
    { label: "unknown code", forecast: [{ kindCode: "999" }], expected: false },
  ])("release-only predicate: $label => $expected", ({ forecast, expected }) => {
    expect(isTsunamiReleaseOnlyForecast(forecast)).toBe(expected);
  });

  it("名称だけが解除でも unknown code は release-only と推測しない", () => {
    const nameOnlyRelease = [{ kindCode: "999", kind: "津波注意報解除" }];
    expect(isTsunamiReleaseOnlyForecast(nameOnlyRelease)).toBe(false);
  });

  it("「〜解除」を含む kind は canonical ラベルへ潰さない", () => {
    expect(normalizeTsunamiKind("津波注意報解除")).toBe("津波注意報解除");
    expect(normalizeTsunamiKind("津波警報解除")).toBe("津波警報解除");
    expect(normalizeTsunamiKind("大津波警報解除")).toBe("大津波警報解除");
  });

  it("解除 kind も前後の空白は trim する", () => {
    expect(normalizeTsunamiKind("  津波注意報解除 ")).toBe("津波注意報解除");
    expect(normalizeTsunamiKind("\t津波警報解除\n")).toBe("津波警報解除");
  });

  it("解除のみの kind 列は level を立てない (解除報が警報として数えられない)", () => {
    expect(resolveTsunamiLevel(["津波注意報解除"])).toBeNull();
    expect(resolveTsunamiLevel(["津波警報解除"])).toBeNull();
    expect(resolveTsunamiLevel(["大津波警報解除"])).toBeNull();
    expect(resolveTsunamiLevel(["津波注意報解除", "津波注意報解除"])).toBeNull();
  });

  it("一部解除・他継続では継続分の level を維持する", () => {
    expect(resolveTsunamiLevel(["津波警報", "津波注意報解除"])).toEqual({
      level: "warning",
      label: "津波警報",
    });
    expect(resolveTsunamiLevel(["津波注意報解除", "津波注意報"])).toEqual({
      level: "advisory",
      label: "津波注意報",
    });
    expect(resolveTsunamiLevel(["津波警報解除", "大津波警報：発表"])).toEqual({
      level: "majorWarning",
      label: "大津波警報",
    });
  });
});
