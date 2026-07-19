import Anser from "anser";

/**
 * ANSI 文字列を HTML 化する。先に HTML エスケープしてから変換するので
 * {@html} に直接渡して安全 (formatter 出力に < や & が含まれても崩れない)。
 * use_classes は使わない: TrueColor が data 属性化して無着色になる
 * (anser 2.3.5 実証済み、plan レビュー critical)。inline style なら
 * 16/256/TrueColor すべて style="color:rgb(...)" で出る。
 */
export function ansiToHtml(ansi: string): string {
  return Anser.ansiToHtml(Anser.escapeForHtml(ansi));
}
