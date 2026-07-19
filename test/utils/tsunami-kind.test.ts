import { describe, it, expect } from "vitest";
import {
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
