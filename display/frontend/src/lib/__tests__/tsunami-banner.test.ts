import { describe, expect, it } from "vitest";
import { groupCoastsByLevel, highestTsunamiLevel, summarizeTsunamiLevels } from "../tsunami-banner";
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

  it("解除 kind (Kind Code 60) はカウントに含めない", () => {
    const coasts: Coasts = [
      coast("大阪府", "津波注意報解除"),
      coast("和歌山県", "大津波警報解除"),
      coast("宮崎県", "津波警報"),
    ];
    expect(summarizeTsunamiLevels(coasts)).toEqual([{ level: "warning", label: "津波警報", count: 1 }]);
  });

  it("解除のみなら空配列 (継続バナーを点灯させない)", () => {
    const coasts: Coasts = [coast("大阪府", "津波注意報解除"), coast("宮崎県", "津波警報解除")];
    expect(summarizeTsunamiLevels(coasts)).toEqual([]);
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

describe("groupCoastsByLevel", () => {
  it("混在報では警報・解除・未分類を別グループに分け、解除には「解除」ラベルを付ける", () => {
    const coasts: Coasts = [
      coast("宮崎県", "津波警報"),
      coast("大阪府", "津波注意報解除"),
      coast("和歌山県", "津波注意報解除"),
      coast("福井県", "津波予報（若干の海面変動）"),
    ];
    expect(groupCoastsByLevel(coasts)).toEqual([
      { kind: "level", level: "warning", label: "津波警報", names: ["宮崎県"] },
      { kind: "released", level: null, label: "解除", names: ["大阪府", "和歌山県"] },
      { kind: "unclassified", level: null, label: null, names: ["福井県"] },
    ]);
  });

  it("件数チップ (summarizeTsunamiLevels) は同じ混在報でも解除を数えない", () => {
    const coasts: Coasts = [
      coast("宮崎県", "津波警報"),
      coast("大阪府", "津波注意報解除"),
      coast("和歌山県", "津波注意報解除"),
      coast("福井県", "津波予報（若干の海面変動）"),
    ];
    expect(summarizeTsunamiLevels(coasts)).toEqual([{ level: "warning", label: "津波警報", count: 1 }]);
  });

  it("解除のみの報でも解除グループを残す (どこが解除されたか読めるようにする)", () => {
    const coasts: Coasts = [coast("大阪府", "津波注意報解除"), coast("宮崎県", "大津波警報解除")];
    expect(groupCoastsByLevel(coasts)).toEqual([
      { kind: "released", level: null, label: "解除", names: ["大阪府", "宮崎県"] },
    ]);
  });

  it("解除は「大津波警報解除」でも警報グループへ落ちない (前方一致より解除判定が優先)", () => {
    const coasts: Coasts = [coast("岩手県", "大津波警報"), coast("宮城県", "大津波警報解除")];
    expect(groupCoastsByLevel(coasts)).toEqual([
      { kind: "level", level: "majorWarning", label: "大津波警報", names: ["岩手県"] },
      { kind: "released", level: null, label: "解除", names: ["宮城県"] },
    ]);
  });

  it("警報グループはレベル降順、解除・未分類はその後ろに並ぶ", () => {
    const coasts: Coasts = [
      coast("福井県", "津波予報（若干の海面変動）"),
      coast("大阪府", "津波注意報解除"),
      coast("沖縄本島地方", "津波注意報"),
      coast("宮崎県", "大津波警報"),
    ];
    expect(groupCoastsByLevel(coasts).map((g) => g.kind)).toEqual([
      "level", "level", "released", "unclassified",
    ]);
    expect(groupCoastsByLevel(coasts).map((g) => g.label)).toEqual([
      "大津波警報", "津波注意報", "解除", null,
    ]);
  });

  it("coasts が空なら空配列を返す", () => {
    expect(groupCoastsByLevel([])).toEqual([]);
  });
});
