import { describe, expect, it } from "vitest";
import { highestTsunamiLevel, summarizeTsunamiLevels } from "../tsunami-banner";
import type { DisplayTsunamiStateV1 } from "../protocol";

type Coasts = DisplayTsunamiStateV1["coasts"];

function coast(name: string, kind: string): Coasts[number] {
  return { name, kind, maxHeight: null, firstHeight: null };
}

describe("summarizeTsunamiLevels", () => {
  it("単一レベルのみなら 1 件のサマリーになる", () => {
    const coasts: Coasts = [coast("宮崎県", "津波警報"), coast("大分県", "津波警報")];
    expect(summarizeTsunamiLevels(coasts)).toEqual([{ level: "warning", label: "津波警報", count: 2 }]);
  });

  it("複数レベル混在時はレベル降順 (大津波警報 → 津波警報 → 津波注意報) で並ぶ", () => {
    const coasts: Coasts = [
      coast("沖縄本島地方", "津波注意報"),
      coast("宮崎県", "大津波警報"),
      coast("高知県", "大津波警報"),
      coast("鹿児島県東部", "津波警報"),
    ];
    expect(summarizeTsunamiLevels(coasts)).toEqual([
      { level: "majorWarning", label: "大津波警報", count: 2 },
      { level: "warning", label: "津波警報", count: 1 },
      { level: "advisory", label: "津波注意報", count: 1 },
    ]);
  });

  it("接尾辞つき表記 (「大津波警報：発表」等) も前方一致で分類する (サーバ側正規化前の古い state への備え)", () => {
    const coasts: Coasts = [coast("岩手県", "大津波警報：発表"), coast("宮城県", "津波警報：発表")];
    expect(summarizeTsunamiLevels(coasts)).toEqual([
      { level: "majorWarning", label: "大津波警報", count: 1 },
      { level: "warning", label: "津波警報", count: 1 },
    ]);
  });

  it("分類できない kind (津波予報等) はカウントに含めない", () => {
    const coasts: Coasts = [coast("大阪府", "津波予報（若干の海面変動）"), coast("宮崎県", "津波警報")];
    expect(summarizeTsunamiLevels(coasts)).toEqual([{ level: "warning", label: "津波警報", count: 1 }]);
  });

  it("coasts が空なら空配列を返す", () => {
    expect(summarizeTsunamiLevels([])).toEqual([]);
  });
});

describe("highestTsunamiLevel", () => {
  it("summaries の先頭 (最も深刻なレベル) を返す", () => {
    const summaries = summarizeTsunamiLevels([coast("宮崎県", "津波警報"), coast("高知県", "大津波警報")]);
    expect(highestTsunamiLevel(summaries, "advisory")).toBe("majorWarning");
  });

  it("summaries が空 (coasts が分類不能) なら fallback を返す", () => {
    expect(highestTsunamiLevel([], "warning")).toBe("warning");
  });
});
