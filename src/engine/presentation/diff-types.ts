/** diff 対象フィールドの個別差分 */
export interface PresentationDiffField {
  key: string;
  previous: string | number | boolean | null;
  current: string | number | boolean | null;
  significance: "major" | "minor";
}

/** PresentationEvent に付与される差分情報 */
export interface PresentationDiff {
  changed: boolean;
  summary: string[];           // e.g. ["M5.0→5.4", "6弱→6強"]
  fields: PresentationDiffField[];
}
