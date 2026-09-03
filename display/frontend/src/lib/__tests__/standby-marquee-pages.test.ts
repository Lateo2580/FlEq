import { describe, expect, it } from "vitest";
import { heatAnchor, staticNamePages, tsunamiAnchor, tsunamiAnchorCandidates, tsunamiStaticPages, TSUNAMI_STATIC_PAGE_MAX_CHARS } from "../standby-marquee-pages";

const coasts = [
  { name: "宮崎県", kind: "大津波警報", maxHeight: null, firstHeight: null },
  { name: "高知県", kind: "津波警報", maxHeight: null, firstHeight: null },
  { name: "沖縄本島地方", kind: "津波注意報", maxHeight: null, firstHeight: null },
];

describe("standby-marquee-pages", () => {
  it("D3 anchor は最上位区分の先頭と全体総数を常設する", () => {
    expect(tsunamiAnchor(coasts, "majorWarning")).toBe("対象 3予報区・先頭 宮崎県（ほか2）");
  });

  it("津波の静止ページは各区分との対応を失わず全件を一周する", () => {
    expect(tsunamiStaticPages(coasts)).toEqual(["【大津波警報】", "宮崎県", "【津波警報】", "高知県", "【津波注意報】", "沖縄本島地方"]);
  });

  it("静止ページは scan 最小幅 7em の文字数上限を越えず、長い予報区名も終端まで残す", () => {
    const pages = tsunamiStaticPages([{ name: "大分県瀬戸内海沿岸", kind: "津波警報", maxHeight: null, firstHeight: null }]);
    expect(pages).toEqual(["【津波警報】", "大分県瀬戸内海", "沿岸"]);
    expect(pages.every((page) => Array.from(page).length <= TSUNAMI_STATIC_PAGE_MAX_CHARS)).toBe(true);
    expect(pages.join("")).toBe("【津波警報】大分県瀬戸内海沿岸");
  });

  it("津波 anchor は scan 幅を残す短縮候補と不足診断を持つ", () => {
    const candidates = tsunamiAnchorCandidates(coasts, "majorWarning");
    expect(candidates[0]).toBe("対象 3予報区・先頭 宮崎県（ほか2）");
    expect(candidates).toContain("対象 3予報区・先頭 宮…（ほか2）");
    expect(candidates.at(-1)).toBe("表示領域不足・対象 3予報区");
  });

  it("D4-B anchor は 3→2→1 の各段で総数と残数を正しく表す", () => {
    const names = ["東京都", "大阪府", "福岡県", "宮崎県"];
    expect(heatAnchor(names, 3)).toBe("東京都・大阪府・福岡県（対象4府県、ほか1）");
    expect(heatAnchor(names, 2)).toBe("東京都・大阪府（対象4府県、ほか2）");
    expect(heatAnchor(names, 1)).toBe("東京都（対象4府県、ほか3）");
  });

  it("Heat の静止ページは1/2/3/40件すべてを欠落なく巡回できる", () => {
    for (const count of [1, 2, 3, 40]) {
      const names = Array.from({ length: count }, (_, index) => `県${index + 1}`);
      expect(staticNamePages(names)).toEqual(names);
    }
  });
});

describe("standby-marquee-pages (解除の混在報)", () => {
  it("静止ページでも解除沿岸が【解除】見出し付きで巡回する", () => {
    expect(tsunamiStaticPages([
      { name: "宮崎県", kind: "津波警報", maxHeight: null, firstHeight: null },
      { name: "大阪府", kind: "津波注意報解除", maxHeight: null, firstHeight: null },
    ])).toEqual(["【津波警報】", "宮崎県", "【解除】", "大阪府"]);
  });
});
