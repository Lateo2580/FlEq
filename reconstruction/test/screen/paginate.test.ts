import { describe, expect, it } from "vitest";

import type { ShellCard, ShellColumn, ShellColumnPages } from "../../contracts/p4-display-shell.types";
import { paginateColumn } from "../../src/display/screen/layout";
import { card, form, rect, row, rows } from "./screen-fixture";

// 全部の組に共通の性質（AC05 (7)）: 本文の行はちょうど 1 つのページに出る、各ページの高さの和は列の高さ以下、同じ入力から同じ結果。
function check(column: ShellColumn, cards: readonly ShellCard[]): ShellColumnPages {
  const result = paginateColumn(column, cards);
  const limit = column === "left" ? 903 : 1000;
  for (const page of result.pages) expect(page.cards.reduce((sum, slice, i) => sum + slice.rect.h + (i > 0 ? 17 : 0), 0)).toBeLessThanOrEqual(limit);
  for (const source of cards) {
    const shown = result.pages.flatMap((page) => page.cards.filter((slice) => slice.id === source.id));
    if (shown.length === 0) continue;
    const used = source.forms[shown[0].form];
    if (used.body.length === 0) continue;
    const bodyTexts = shown.flatMap((slice) => slice.rows.filter((r) => used.body.includes(r)).map((r) => r.texts[0]?.text));
    expect(bodyTexts).toEqual(used.body.map((r) => r.texts[0]?.text));
  }
  expect(paginateColumn(column, cards)).toEqual(result);
  return result;
}
const counts = (result: ShellColumnPages, id: string) => result.pages.map((page) => page.cards.find((slice) => slice.id === id)?.rows.filter((r) => r.texts[0]?.text.startsWith("r")).length ?? 0);
const mayHideQ = (...forms: ReturnType<typeof form>[]) => card("Q", "left", { place: 1, take: 1, mayHide: true, forms });

// T03 受入条件（P4-DS-AC05）: 表 §4.2 の P1〜P11。
describe("P4-DS-T03 paginateColumn P1〜P11", () => {
  it("P1・P2・P3: 1 ページは中身の高さ、2 ページは同じ組なので高さが揃い、continuation は次のページの頭に出る", () => {
    const p1 = check("left", [mayHideQ(form(90, rows(3)))]);
    expect(p1.pages).toHaveLength(1);
    expect(p1.pages[0].cards[0].rect).toEqual(rect(40, 40, 540, 390));
    expect(p1.pages[0].mark).toBeNull();

    const p2 = check("left", [mayHideQ(form(90, rows(10)))]);
    expect(counts(p2, "Q")).toEqual([8, 2]);
    expect(p2.pages.map((page) => page.cards[0].rect.h)).toEqual([890, 890]);
    expect(p2.pages.map((page) => page.mark?.pages)).toEqual([2, 2]);

    const body = rows(10);
    body[8] = row(100, "r9", [row(50, "cont")]);
    const p3 = check("left", [mayHideQ(form(90, body))]);
    expect(p3.pages[1].cards[0].rows.map((r) => r.height)).toEqual([90, 50, 100, 100]);
    expect(p3.pages.map((page) => page.cards[0].rect.h)).toEqual([890, 890]);
  });

  const a = (head: number) => card("A", "left", { place: 1, take: 0, forms: [form(head, [])] });
  const b = card("B", "left", { place: 2, take: 1, mayHide: true, forms: [
    form(90, rows(2), 1, 1), form(90, rows(2), null, 2), form(90, [row(50, "r1")], null, 1), form(90, [], 1, 0)] });

  it("P4・P5・P6: 残りの高さに入る最初の形を使い、どの形も入らない mayHide のカードは出さない", () => {
    const p4 = check("left", [a(700), b]);
    expect(p4.pages).toHaveLength(1);
    expect(p4.pages[0].cards.map((slice) => slice.rect)).toEqual([rect(40, 40, 540, 700), rect(40, 757, 540, 140)]);
    const p5 = check("left", [a(786), b]);
    expect(p5.pages[0].cards[1].rect).toEqual(rect(40, 843, 540, 90));
    const p6 = check("left", [a(806), b]);
    expect(p6.pages[0].cards.map((slice) => slice.id)).toEqual(["A"]);
  });

  it("P7・P8・P9: 右の列は 1 ページなら伸ばさず、2 ページ以上は表示の行を数え、1 枚だけのページは列いっぱい。8 ページ以上は点なし", () => {
    const p7 = check("right", [card("Y", "right", { forms: [form(90, rows(3))] })]);
    expect(p7.pages[0].cards[0].rect).toEqual(rect(1340, 40, 540, 390));
    expect(p7.pages[0].mark).toBeNull();

    const x = card("X", "right", { place: 0, take: 0, forms: [form(90, rows(2, 100, "x"))] });
    const y = card("Y", "right", { place: 1, take: 1, forms: [form(90, rows(20))] });
    const p8 = check("right", [x, y]);
    expect(counts(p8, "Y")).toEqual([5, 8, 7]);
    expect(p8.pages.map((page) => page.cards.map((slice) => slice.id))).toEqual([["X", "Y"], ["Y"], ["Y"]]);
    expect(p8.pages[0].cards.map((slice) => slice.rect)).toEqual([rect(1340, 40, 540, 290), rect(1340, 347, 540, 635.5)]);
    expect(p8.pages[1].cards[0].rect).toEqual(rect(1340, 40, 540, 1000));
    expect(p8.pages.map((page) => page.mark)).toEqual([0, 1, 2].map((page) => ({ cardId: "Y", page, pages: 3, dots: true })));

    const p9 = check("right", [card("Y", "right", { forms: [form(90, rows(70))] })]);
    expect(counts(p9, "Y")).toEqual([8, 8, 8, 8, 8, 8, 8, 8, 6]);
    expect(p9.pages.every((page) => page.mark?.dots === false && page.mark.pages === 9)).toBe(true);
  });

  it("P10・P11: 本文の無い形は全ページに出て、後ろの行が入らない形は使わずカードを出さない", () => {
    const p10 = check("left", [card("A", "left", { place: 0, take: 0, forms: [form(200, [])] }), mayHideQ(form(90, rows(10)))]);
    expect(counts(p10, "Q")).toEqual([5, 5]);
    expect(p10.pages.map((page) => page.cards.map((slice) => slice.rect))).toEqual(
      [[rect(40, 40, 540, 200), rect(40, 257, 540, 590)], [rect(40, 40, 540, 200), rect(40, 257, 540, 590)]]);
    const p11 = check("left", [a(700), mayHideQ(form(90, [row(50, "r1"), row(800, "r2")]))]);
    expect(p11.pages).toHaveLength(1);
    expect(p11.pages[0].cards.map((slice) => [slice.id, slice.rect])).toEqual([["A", rect(40, 40, 540, 700)]]);
  });

  it("P12: 本文の無い形にも maxPages を当てる。A が 2 ページなら、1 ページの形しか無い mayHide の B は出さない", () => {
    const a2 = card("A", "right", { place: 0, take: 0, forms: [form(90, rows(2, 700))] });
    const b = card("B", "right", { place: 1, take: 1, mayHide: true, forms: [form(90, [], 1, 0)] });
    const p12 = check("right", [a2, b]);
    expect(p12.pages).toHaveLength(2);
    expect(p12.pages.flatMap((page) => page.cards.map((slice) => slice.id))).toEqual(["A", "A"]);
  });
});
