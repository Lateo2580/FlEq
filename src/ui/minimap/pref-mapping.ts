import type { PrefId, PrefDef } from "./types";

/** All 47 prefecture definitions with match patterns */
export const PREF_DEFS: readonly PrefDef[] = [
  { id: "HK", name: "北海道", patterns: ["北海道"] },
  { id: "AO", name: "青森県", patterns: ["青森"] },
  { id: "IT", name: "岩手県", patterns: ["岩手"] },
  { id: "MG", name: "宮城県", patterns: ["宮城"] },
  { id: "AK", name: "秋田県", patterns: ["秋田"] },
  { id: "YG", name: "山形県", patterns: ["山形"] },
  { id: "FS", name: "福島県", patterns: ["福島"] },
  { id: "IB", name: "茨城県", patterns: ["茨城"] },
  { id: "TC", name: "栃木県", patterns: ["栃木"] },
  { id: "GU", name: "群馬県", patterns: ["群馬"] },
  { id: "ST", name: "埼玉県", patterns: ["埼玉"] },
  { id: "CB", name: "千葉県", patterns: ["千葉"] },
  { id: "TY", name: "東京都", patterns: ["東京島しょ", "小笠原", "東京"] },
  { id: "KN", name: "神奈川県", patterns: ["神奈川"] },
  { id: "NI", name: "新潟県", patterns: ["新潟"] },
  { id: "TM", name: "富山県", patterns: ["富山"] },
  { id: "IS", name: "石川県", patterns: ["石川"] },
  { id: "FI", name: "福井県", patterns: ["福井"] },
  { id: "YN", name: "山梨県", patterns: ["山梨"] },
  { id: "NA", name: "長野県", patterns: ["長野"] },
  { id: "GI", name: "岐阜県", patterns: ["岐阜"] },
  { id: "SZ", name: "静岡県", patterns: ["静岡"] },
  { id: "AI", name: "愛知県", patterns: ["愛知"] },
  { id: "ME", name: "三重県", patterns: ["三重"] },
  { id: "SI", name: "滋賀県", patterns: ["滋賀"] },
  { id: "KY", name: "京都府", patterns: ["京都"] },
  { id: "OS", name: "大阪府", patterns: ["大阪"] },
  { id: "HG", name: "兵庫県", patterns: ["兵庫"] },
  { id: "NR", name: "奈良県", patterns: ["奈良"] },
  { id: "WA", name: "和歌山県", patterns: ["和歌山"] },
  { id: "TT", name: "鳥取県", patterns: ["鳥取"] },
  { id: "SM", name: "島根県", patterns: ["島根"] },
  { id: "OY", name: "岡山県", patterns: ["岡山"] },
  { id: "HS", name: "広島県", patterns: ["広島"] },
  { id: "YA", name: "山口県", patterns: ["山口"] },
  { id: "TK", name: "徳島県", patterns: ["徳島"] },
  { id: "KA", name: "香川県", patterns: ["香川"] },
  { id: "EH", name: "愛媛県", patterns: ["愛媛"] },
  { id: "KO", name: "高知県", patterns: ["高知"] },
  { id: "FO", name: "福岡県", patterns: ["福岡"] },
  { id: "SG", name: "佐賀県", patterns: ["佐賀"] },
  { id: "NS", name: "長崎県", patterns: ["長崎"] },
  { id: "KU", name: "熊本県", patterns: ["熊本"] },
  { id: "OI", name: "大分県", patterns: ["大分"] },
  { id: "MZ", name: "宮崎県", patterns: ["宮崎"] },
  { id: "KG", name: "鹿児島県", patterns: ["奄美", "鹿児島"] },
  { id: "OK", name: "沖縄県", patterns: ["沖縄"] },
];

/**
 * Build a sorted pattern index: longer patterns first to prevent false matches.
 * e.g. "東京島しょ" is checked before "東京".
 */
function buildPatternIndex(): Array<{ pattern: string; prefId: PrefId }> {
  const entries: Array<{ pattern: string; prefId: PrefId }> = [];
  for (const def of PREF_DEFS) {
    for (const pattern of def.patterns) {
      entries.push({ pattern, prefId: def.id });
    }
  }
  entries.sort((a, b) => b.pattern.length - a.pattern.length);
  return entries;
}

const patternIndex = buildPatternIndex();

/**
 * Map an area name (e.g. "石川県能登地方") to its prefecture ID.
 * Uses substring matching with longer patterns checked first.
 * Returns null if no match is found.
 */
export function mapAreaToPref(areaName: string): PrefId | null {
  for (const { pattern, prefId } of patternIndex) {
    if (areaName.includes(pattern)) {
      return prefId;
    }
  }
  return null;
}
