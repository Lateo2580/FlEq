import type chalk from "chalk";

/** 12-block region identifiers for the ASCII minimap */
export type BlockId =
  | "HKD"
  | "TOH"
  | "KKS"
  | "IZO"
  | "HKR"
  | "TOK"
  | "KIN"
  | "CHG"
  | "SKK"
  | "KNB"
  | "KNS"
  | "OKN";

/** Block definition: region ID, display name, and member prefectures */
export interface BlockDef {
  id: BlockId;
  name: string;
  prefectures: string[];
}

/** A single cell in the minimap grid */
export interface MinimapCell {
  blockId: BlockId;
  /** Content string: intensity "5-", tsunami abbrev "MJ", or "." for no data */
  content: string;
  /** Optional chalk color for the cell */
  color?: chalk.Chalk;
}
