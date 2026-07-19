import Anser from "anser";
import { diffChars } from "diff";

export interface DiffSegment {
  text: string;     // strip 済みテキスト断片
  changed: boolean; // after 側で追加/変更された部分
}

export interface DiffRow {
  kind: "unchanged" | "colorChanged" | "textChanged";
  beforeAnsi: string;            // 行の生 ANSI (表示は ansiToHtml で行う)
  afterAnsi: string;
  afterSegments?: DiffSegment[]; // textChanged のときのみ (strip 済み + 変更部マーク)
}

function stripAnsi(s: string): string {
  return Anser.ansiToText(s);
}

/**
 * before/after の ANSI 全文を行単位で突き合わせて分類する (spec §4.8)。
 * - テキストも色も同じ → unchanged
 * - テキスト同一・ANSI 相違 → colorChanged (黄枠のみ。色変化は目視できる)
 * - テキスト相違 → textChanged (黄枠 + after 側の変更部を <mark> 用セグメントに)
 * 行対応は素朴なインデックス対齐 (テーマ編集 diff では行のずれは稀。
 * 行数差は不足側を空行で埋める)。
 */
export function classifyDiffLines(beforeAnsi: string, afterAnsi: string): DiffRow[] {
  const beforeLines = beforeAnsi.replace(/\n$/, "").split("\n");
  const afterLines = afterAnsi.replace(/\n$/, "").split("\n");
  const len = Math.max(beforeLines.length, afterLines.length);
  const rows: DiffRow[] = [];
  for (let i = 0; i < len; i++) {
    const b = beforeLines[i] ?? "";
    const a = afterLines[i] ?? "";
    const bText = stripAnsi(b);
    const aText = stripAnsi(a);
    if (bText === aText) {
      rows.push({ kind: b === a ? "unchanged" : "colorChanged", beforeAnsi: b, afterAnsi: a });
    } else {
      const segments: DiffSegment[] = diffChars(bText, aText)
        .filter((part) => !part.removed) // after 側の表示なので削除部は出さない
        .map((part) => ({ text: part.value, changed: part.added === true }));
      rows.push({ kind: "textChanged", beforeAnsi: b, afterAnsi: a, afterSegments: segments });
    }
  }
  return rows;
}
