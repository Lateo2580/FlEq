/**
 * 電文タイプ → docs/display-reference.md の見出し (## 行の完全一致文字列)。
 * 見出しの実在は display-reference.test.ts の同期ガードが担保する
 * (md 側の見出しが変わったらテストが落ちて map 更新を強制する)。
 */
export interface DisplayReferenceEntry {
  pattern: RegExp;
  headings: string[];
}

export const DISPLAY_REFERENCE_MAP: readonly DisplayReferenceEntry[] = [
  {
    pattern: /^VPWW(5[5-9]|6[01])/,
    headings: [
      "## 気象警報・注意報 (VPWW55-61, VPWS50)",
      "## サマリーライン (compact 表示)",
    ],
  },
  {
    pattern: /^VPWS50$/,
    headings: [
      "## 気象警報・注意報 (VPWW55-61, VPWS50)",
      "## サマリーライン (compact 表示)",
    ],
  },
  {
    pattern: /^VPWP50$/,
    headings: [
      "## 気象警報・注意報時系列情報 (VPWP50)",
      "## サマリーライン (compact 表示)",
    ],
  },
  {
    pattern: /^VP(CJ|ZJ|FJ)51$/,
    headings: [
      "## 気象解説情報 (VPCJ51, VPZJ51, VPFJ51, VMCJ53-55)",
      "## サマリーライン (compact 表示)",
    ],
  },
  // map 未登録の型は resolveHeadings が [] を返し、frontend は best-effort で
  // 参照ペインを出さない。VPAW51 は docs/display-reference.md に節が無い。
  // VPCI50/VMCJ53-55/VPFT50 は md に節があるが registry 未対応のため未登録
  // (registry 拡大時に追加する)。VPHW50-51/VPBS50/VPZI50 は registry 対応済み・
  // md に節もあるが map 追加が未着手 (追加可能。studio 参照ペイン整備時に拾う)。
];

export function resolveHeadings(type: string): string[] {
  for (const e of DISPLAY_REFERENCE_MAP) {
    if (e.pattern.test(type)) return e.headings;
  }
  return [];
}
