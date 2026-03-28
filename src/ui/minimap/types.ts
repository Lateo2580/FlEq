import type chalk from "chalk";

/** 47 prefecture identifiers for the ASCII minimap */
export type PrefId =
  | "HK" | "AO" | "IT" | "MG" | "AK" | "YG" | "FS"
  | "IB" | "TC" | "GU" | "ST" | "CB" | "TY" | "KN"
  | "NI" | "TM" | "IS" | "FI" | "YN" | "NA" | "GI" | "SZ" | "AI" | "ME"
  | "SI" | "KY" | "OS" | "HG" | "NR" | "WA"
  | "TT" | "SM" | "OY" | "HS" | "YA"
  | "TK" | "KA" | "EH" | "KO"
  | "FO" | "SG" | "NS" | "KU" | "OI" | "MZ" | "KG" | "OK";

/** Prefecture definition: code, display name, and match patterns */
export interface PrefDef {
  id: PrefId;
  name: string;
  /** Substrings to match in area names (longer first for disambiguation) */
  patterns: string[];
}

/** Grid cell position */
export interface GridPos {
  row: number;
  col: number;
}

/** Prefecture placement on the grid */
export interface PrefPlacement {
  id: PrefId;
  /** All grid cells this prefecture occupies */
  cells: GridPos[];
  /** The anchor cell where the label is displayed */
  anchor: GridPos;
}

/** A single cell in the minimap */
export interface MinimapCell {
  prefId: PrefId;
  /** Content string: intensity "6+", tsunami abbrev "MJ", or ".." for no data */
  content: string;
  /** Optional chalk color for the cell */
  color?: chalk.Chalk;
}
