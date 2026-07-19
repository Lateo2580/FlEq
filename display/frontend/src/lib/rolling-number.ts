// 数値ドラムロール (odometer) の純ロジック。文字列を「回す数字セル」と「静止テキストセル」に
// 分解する。tabular-nums + 桁単位リールで桁揃え規範を崩さないため、数字だけをロール対象にする。
import { SPRING_EFFECTS_DEFAULT_MS } from "./motion";

export type RollCell =
  | { kind: "digit"; digit: number }
  | { kind: "text"; text: string };

// 例: "7.1" → [d7, text".", d1] / "20km" → [d2, d0, text"km"] / "6弱" → [d6, text"弱"]
// "ごく浅い" や "不明" のような数字を含まない値は text 1 セルのみ (ロールしない)。
export function toRollCells(value: string): RollCell[] {
  const cells: RollCell[] = [];
  let text = "";
  for (const ch of value) {
    if (ch >= "0" && ch <= "9") {
      if (text.length > 0) {
        cells.push({ kind: "text", text });
        text = "";
      }
      cells.push({ kind: "digit", digit: ch.charCodeAt(0) - 48 });
    } else {
      text += ch;
    }
  }
  if (text.length > 0) cells.push({ kind: "text", text });
  return cells;
}

// reduced-motion では 0ms (瞬時差し替え)、通常は spring effects 系の短い duration で確定。
export function rollDurationMs(reducedMotion: boolean): number {
  return reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS;
}

// 着地強調・ロールを「変化時のみ」発火させるための変化検知。初回 (prev=null) は false =
// マウント時は強調しない。同値の再代入も false = 常時アニメーション化しない。
export function hasValueChanged(prev: string | null, next: string): boolean {
  return prev != null && prev !== next;
}
