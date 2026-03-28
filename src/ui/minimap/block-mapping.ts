import type { BlockId, BlockDef } from "./types";

/** All 12 region blocks of the minimap */
export const BLOCK_DEFS: readonly BlockDef[] = [
  { id: "HKD", name: "北海道", prefectures: ["北海道"] },
  { id: "TOH", name: "東北", prefectures: ["青森", "岩手", "宮城", "秋田", "山形", "福島"] },
  { id: "KKS", name: "関東甲信", prefectures: ["茨城", "栃木", "群馬", "埼玉", "千葉", "東京", "神奈川", "山梨", "長野"] },
  { id: "IZO", name: "伊豆小笠原", prefectures: ["東京島しょ", "小笠原"] },
  { id: "HKR", name: "北陸", prefectures: ["新潟", "富山", "石川", "福井"] },
  { id: "TOK", name: "東海", prefectures: ["岐阜", "静岡", "愛知", "三重"] },
  { id: "KIN", name: "近畿", prefectures: ["滋賀", "京都", "大阪", "兵庫", "奈良", "和歌山"] },
  { id: "CHG", name: "中国", prefectures: ["鳥取", "島根", "岡山", "広島", "山口"] },
  { id: "SKK", name: "四国", prefectures: ["徳島", "香川", "愛媛", "高知"] },
  { id: "KNB", name: "九州北部", prefectures: ["福岡", "佐賀", "長崎", "熊本", "大分"] },
  { id: "KNS", name: "九州南部奄美", prefectures: ["宮崎", "鹿児島", "奄美"] },
  { id: "OKN", name: "沖縄", prefectures: ["沖縄"] },
] as const;

/** All block IDs in display order */
export const ALL_BLOCK_IDS: readonly BlockId[] = BLOCK_DEFS.map((b) => b.id);

/**
 * Build a flat lookup from prefecture substring to block ID.
 * IZO prefectures ("東京島しょ", "小笠原") are checked before KKS "東京"
 * to avoid false matches.
 */
function buildPrefectureIndex(): { exact: Map<string, BlockId>; ordered: Array<{ pref: string; blockId: BlockId }> } {
  const exact = new Map<string, BlockId>();
  const ordered: Array<{ pref: string; blockId: BlockId }> = [];

  // IZO first so "東京島しょ" matches before "東京"
  for (const block of BLOCK_DEFS) {
    for (const pref of block.prefectures) {
      exact.set(pref, block.id);
    }
  }

  // Build ordered list: longer prefectures first for substring matching
  for (const block of BLOCK_DEFS) {
    for (const pref of block.prefectures) {
      ordered.push({ pref, blockId: block.id });
    }
  }
  // Sort by length descending so "東京島しょ" is tried before "東京"
  ordered.sort((a, b) => b.pref.length - a.pref.length);

  return { exact, ordered };
}

const prefIndex = buildPrefectureIndex();

/**
 * Map an area name (e.g. "石川県能登地方") to its block ID.
 * Uses substring matching: finds the first prefecture name contained in the area name.
 * Returns null if no match is found.
 */
export function mapAreaToBlock(areaName: string): BlockId | null {
  for (const { pref, blockId } of prefIndex.ordered) {
    if (areaName.includes(pref)) {
      return blockId;
    }
  }
  return null;
}
