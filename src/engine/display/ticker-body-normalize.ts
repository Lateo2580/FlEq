// テロップ本文 (tickerBody) だけに効く正規化 (spec §2 / §5)。project-event の DTO 射影で 1 回だけ噛ませる。
// CLI・通知・統計・events JSON には波及させない (単一チョークポイント)。全処理は冪等。
// 改行は半角スペース1個に置換し、テロップ全体を1本の文として扱う。

/** 全角数字・全角ラテン英字を半角へ (カナ・記号・句読点は触らない)。 */
function toHalfWidthAlnum(s: string): string {
  return s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** テロップ本文を正規化する。空/全空白は null (呼び出し側が tickerSentence へフォールバック)。 */
export function normalizeTickerBody(body: string | null | undefined): string | null {
  if (body == null) return null;
  // CRLF/CR を LF へ統一してから分割 (\r が行末に残ると結合後の空白重複・冪等性崩れの原因になる)
  const lines = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      // ① 行頭の字下げ (全角/半角スペース・タブ) を除去
      const dedented = line.replace(/^[\s　]+/, "");
      // ② 行内の連続空白 (全角/半角/タブ混在) を半角1個へ圧縮
      const collapsed = dedented.replace(/[\s　]{2,}/g, " ");
      // ③ 行末の空白を除去 (結合時にスペースが二重になるのを防ぐ)
      const untrailed = collapsed.replace(/[\s　]+$/, "");
      // ④ 全角英数字→半角
      return toHalfWidthAlnum(untrailed);
    })
    .filter((line) => line !== "");
  // ⑤ 改行を半角スペース1個へ結合し、念のため結合後の連続空白も1個へ圧縮
  const out = lines.join(" ").replace(/[\s　]{2,}/g, " ").trim();
  return out === "" ? null : out;
}
