import type { PrefId, PrefPlacement } from "./types";

export const GRID_ROWS = 12;
export const GRID_COLS = 13;

/** Helper to create a placement */
function p(id: PrefId, cells: [number, number][], anchor: [number, number]): PrefPlacement {
  return {
    id,
    cells: cells.map(([row, col]) => ({ row, col })),
    anchor: { row: anchor[0], col: anchor[1] },
  };
}

/**
 * All 47 prefecture placements on the 12×13 grid.
 *
 * Grid layout (from spec):
 * Col:  0    1    2    3    4    5    6    7    8    9    10   11   12
 * r00:                      HK  *HK   HK   HK
 * r01:                      HK   HK   HK   HK                   *AO   AO
 * r02:                                                            AK   IT
 * r03:                                                            YG   MG
 * r04: OK                                                        *FS   FS
 * r05:                                              *IS    *NI NI  TC   IB
 * r06:                                     TM        IS  *NA   GI  GU   ST
 * r07:           SM   TT  *HG   KY  *FI   FI        NA   YN   TY      *CB
 * r08:      YA   HS   OY   HG   SI  *ME   AI   SZ   KN       CB
 * r09: NS   SG   FO              OS   NR   ME
 * r10:      KU   OI        EH   KA         WA
 * r11:      KG   MZ  *KO   KO   TK
 */
export const PREF_PLACEMENTS: readonly PrefPlacement[] = [
  // ── 北海道 (4×2) ──
  p("HK", [[0,3],[0,4],[0,5],[0,6],[1,3],[1,4],[1,5],[1,6]], [0,4]),

  // ── 東北 ──
  p("AO", [[1,11],[1,12]], [1,11]),
  p("AK", [[2,11]], [2,11]),
  p("IT", [[2,12]], [2,12]),
  p("YG", [[3,11]], [3,11]),
  p("MG", [[3,12]], [3,12]),
  p("FS", [[4,11],[4,12]], [4,11]),

  // ── 関東 ──
  p("IB", [[5,12]], [5,12]),
  p("TC", [[5,11]], [5,11]),
  p("GU", [[6,11]], [6,11]),
  p("ST", [[6,12]], [6,12]),
  p("CB", [[7,12],[8,12]], [7,12]),
  p("TY", [[7,11]], [7,11]),
  p("KN", [[8,11]], [8,11]),

  // ── 中部 ──
  p("NI", [[5,9],[5,10]], [5,9]),
  p("TM", [[6,7]], [6,7]),
  p("IS", [[5,8],[6,8]], [5,8]),
  p("FI", [[7,7],[7,8]], [7,7]),
  p("YN", [[7,10]], [7,10]),
  p("NA", [[6,9],[7,9]], [6,9]),
  p("GI", [[6,10]], [6,10]),
  p("SZ", [[8,10]], [8,10]),
  p("AI", [[8,9]], [8,9]),

  // ── 近畿 ──
  p("ME", [[8,8],[9,8]], [8,8]),
  p("SI", [[8,6]], [8,6]),
  p("KY", [[7,6]], [7,6]),
  p("OS", [[9,6]], [9,6]),
  p("HG", [[7,5],[8,5]], [7,5]),
  p("NR", [[9,7]], [9,7]),
  p("WA", [[10,7]], [10,7]),

  // ── 中国 ──
  p("TT", [[7,4]], [7,4]),
  p("SM", [[7,3]], [7,3]),
  p("OY", [[8,4]], [8,4]),
  p("HS", [[8,3]], [8,3]),
  p("YA", [[8,2]], [8,2]),

  // ── 四国 ──
  p("TK", [[11,5]], [11,5]),
  p("KA", [[10,5]], [10,5]),
  p("EH", [[10,4]], [10,4]),
  p("KO", [[11,3],[11,4]], [11,3]),

  // ── 九州 ──
  p("FO", [[9,2]], [9,2]),
  p("SG", [[9,1]], [9,1]),
  p("NS", [[9,0]], [9,0]),
  p("KU", [[10,1]], [10,1]),
  p("OI", [[10,2]], [10,2]),
  p("MZ", [[11,2]], [11,2]),
  p("KG", [[11,1]], [11,1]),

  // ── 沖縄 ──
  p("OK", [[4,0]], [4,0]),
] as const;

/** All prefecture IDs in definition order */
export const ALL_PREF_IDS: readonly PrefId[] = PREF_PLACEMENTS.map((pp) => pp.id);
