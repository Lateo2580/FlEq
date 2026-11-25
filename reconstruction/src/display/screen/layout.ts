// P4-DISPLAY-SHELL-001（S0）配置と押下の純粋な関数。DOM を読まない（P4-DS-AC04 (4)、D-AC06）。
// 値は tokens.ts の LAYOUT だけから読む。決まりと出どころは表 p4-display-shell-tables.md（§3 層、§4 割り、§5 押下）。

import type {
  ShellCard, ShellCardForm, ShellCardSlice, ShellColumn, ShellColumnPage, ShellColumnPages, ShellEvent, ShellLayerInput, ShellLayerResult,
  ShellMiddle, ShellPlacement, ShellRect, ShellRow, ShellState,
} from "../../../contracts/p4-display-shell.types";
import { LAYOUT } from "./tokens.js";

const rect = (x: number, y: number, w: number, h: number): ShellRect => ({ x, y, w, h });
const overlaps = (a: ShellRect, b: ShellRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const contains = (r: ShellRect, x: number, y: number): boolean => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

// r の全体が rects の和に入るか。r の中の辺で区切った小区画の中心がどれかに入ることを全部の区画で見る（rects は 12 枚以下の定数）。
function covered(r: ShellRect, rects: readonly ShellRect[]): boolean {
  const cut = (lo: number, hi: number, edges: number[]) => [...new Set([lo, hi, ...edges.filter((edge) => edge > lo && edge < hi)])].sort((a, b) => a - b);
  const xs = cut(r.x, r.x + r.w, rects.flatMap((q) => [q.x, q.x + q.w]));
  const ys = cut(r.y, r.y + r.h, rects.flatMap((q) => [q.y, q.y + q.h]));
  for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
    if (!rects.some((q) => contains(q, cx, cy))) return false;
  }
  return true;
}

function eewSlots(count: number): readonly ShellRect[] {
  const n = Math.min(Math.max(Math.trunc(count), 0), 6);
  const { right, left, eew } = LAYOUT;
  if (n === 0) return [];
  if (n === 1) return [rect(right.x, right.top, right.w, eew.one.h)];
  if (n === 2) return [rect(right.x, right.top, right.w, eew.two.h), rect(right.x, right.top + eew.two.h + eew.two.gap, right.w, eew.two.h)];
  return Array.from({ length: n }, (_, i) => rect(i < 3 ? right.x : left.x, eew.small.tops[i % 3], right.w, eew.small.h));
}

function clockRect(count: number): ShellRect {
  const { clock } = LAYOUT;
  return rect(count >= 6 ? clock.sixX : clock.x, clock.y, clock.w, clock.h);
}

// 上下に隣り合う場所の間（宣言値 LAYOUT.eew.two.gap・LAYOUT.gap だけ。宣言値に無い並びは数えない、DS-LAYER-13）
function gapsBetween(slots: readonly ShellRect[]): ShellRect[] {
  const out: ShellRect[] = [];
  for (const a of slots) for (const b of slots) {
    const gap = b.y - (a.y + a.h);
    if (a.x === b.x && a.w === b.w && (gap === LAYOUT.eew.two.gap || gap === LAYOUT.gap)) out.push(rect(a.x, a.y + a.h, a.w, gap));
  }
  return out;
}

const shiftOf = (column: ShellColumn, r: ShellRect): ShellRect => rect(column === "left" ? r.x + LAYOUT.shift : r.x - LAYOUT.shift, r.y, r.w, r.h);

// 表 §3.1 の 1〜9。緊急地震速報の場所・開いたカード・上がったカード・列のカードから、層・暗さ・ずらし・cover を決める。
function placeLayers(input: ShellLayerInput): ShellLayerResult {
  const { eew, open, middle } = input;
  const eewRects = eew.map((slot) => slot.rect);
  // 覆い E: 緊急地震速報のカード全部（最上層も下がったものも）の場所とその間、開いたカード（D1、DS-LAYER-20）
  const cover = [...eewRects, ...gapsBetween(eewRects), ...(open == null ? [] : [open.rect])];
  const placedOf = (card: ShellMiddle) => {
    const dimmed = cover.some((q) => overlaps(card.rect, q));
    const shifted = dimmed && covered(card.rect, cover);
    return { dimmed, shifted, rect: shifted ? shiftOf(card.column, card.rect) : card.rect };
  };
  const placed = middle.map((card) => ({ card, ...placedOf(card) }));
  // 上がったカード: raised の id で、緊急地震速報の場所に面で重なるもの。重ならない id は上がっていない扱い（D2）
  const raisedIds = new Set(input.raised);
  const raised = placed.filter((item) => raisedIds.has(item.card.id) && eewRects.some((q) => overlaps(item.rect, q)));
  const raisedRects = raised.map((item) => item.rect);
  // 下がった緊急地震速報のカード: 上がったカードの矩形と面で重なるものは何枚でも全部（DS-LAYER-15）
  const fallen = eew.flatMap((slot) => {
    const under = raised.filter((item) => overlaps(slot.rect, item.rect));
    if (under.length === 0) return [];
    const shifted = covered(slot.rect, under.map((item) => item.rect));
    const out: ShellPlacement = { id: slot.id, layer: "middle", rect: shifted ? shiftOf(slot.column, slot.rect) : slot.rect, dimmed: true, shifted, under: under.map((item) => item.card.id) };
    return [out];
  });
  const fallenIds = new Set(fallen.map((item) => item.id));
  const topEew = eew.filter((slot) => !fallenIds.has(slot.id));
  const top: ShellPlacement[] = [
    ...(open == null ? [] : [{ id: open.id, layer: "top" as const, rect: open.rect, dimmed: false, shifted: false, under: [] }]),
    ...topEew.map((slot) => ({ id: slot.id, layer: "top" as const, rect: slot.rect, dimmed: false, shifted: false, under: [] })),
    ...raised.map((item) => ({ id: item.card.id, layer: "top" as const, rect: item.rect, dimmed: false, shifted: item.shifted, under: [] })),
  ];
  const raisedSet = new Set(raised.map((item) => item.card.id));
  const columnCards: ShellPlacement[] = placed.filter((item) => !raisedSet.has(item.card.id))
    .map((item) => ({ id: item.card.id, layer: "middle" as const, rect: item.rect, dimmed: item.dimmed, shifted: item.shifted, under: [] }));
  const topRects = topEew.map((slot) => slot.rect);
  return { top, middle: [...columnCards, ...fallen], cover: [...top.map((item) => item.rect), ...gapsBetween(topRects)] };
}

// ---- 列の割り（表 §4）----

type Plan = Readonly<{ card: ShellCard; index: number; form: ShellCardForm; headH: number; bodyless: boolean; fitted: boolean }>;
type Placed = { plan: number; from: number; to: number; cont: boolean; natural: number; height: number; y: number };
type Division = Readonly<{ pages: Placed[][]; overflow: boolean; reached: number[]; started: number[] }>;
type Solved = Readonly<{ plans: readonly Plan[]; division: Division }>;

const sumHeights = (rows: readonly ShellRow[]): number => rows.reduce((total, row) => total + row.height, 0);
const SEP = "\u0001";

// 1 回の流し込み。本文のあるカードは place の順に、前のカードの本文が全部置き終わってから次を始める（統合担当の決め 2026-11-25 21:04）。
// 本文の無い形のカードは全ページに出る。markH は右の列で数える表示の行（そのページの一番下のカードの高さに足す）。
// fixed は前の回の組ごとの最大の高さ（同じカードの組が並ぶページのそのカードにだけ、足りない分を空けて当てる）。
function flow(plans: readonly Plan[], limit: number, markH: number, fixed: ReadonlyMap<string, number> | null): Division {
  const gap = LAYOUT.gap;
  const next = plans.map(() => 0);
  // 後ろの本文の無いカードの高さの和（末尾からの累積）
  const reserve = Array.from({ length: plans.length }, () => ({ size: 0, any: false }));
  for (let i = plans.length - 2; i >= 0; i--) {
    const after = plans[i + 1], rest = reserve[i + 1];
    reserve[i] = after.bodyless ? { size: rest.size + after.headH + gap, any: true } : rest;
  }
  const totalRows = plans.reduce((total, plan) => total + plan.form.body.length, 0);
  const pages: Placed[][] = [];
  const reached = plans.map(() => -1), started = plans.map(() => -1);
  let overflow = false, stall = 0;
  const rowsLeft = () => plans.some((plan, i) => !plan.bodyless && next[i] < plan.form.body.length);
  // 新しいページに 1 行も置けない入力でも、2 ページ続けて何も置けなければ 1 行を置いて進む（止まらないため。答えは定めない）
  for (let guard = 0; (pages.length === 0 || rowsLeft()) && guard < 2 * totalRows + plans.length + 4; guard++) {
    const page: Placed[] = [];
    let used = 0, blocked = false, placedBody = false;
    plans.forEach((plan, i) => {
      const before = page.length > 0 ? gap : 0;
      if (plan.bodyless) { page.push({ plan: i, from: 0, to: 0, cont: false, natural: plan.headH, height: 0, y: 0 }); used += before + plan.headH; return; }
      const body = plan.form.body;
      if (blocked || next[i] >= body.length) return;
      if (reached[i] < 0) reached[i] = pages.length;
      const later = reserve[i];
      const mark = later.any ? 0 : markH;
      const avail = limit - used - before - later.size - (later.any ? markH : 0);
      const contH = next[i] > 0 ? sumHeights(body[next[i]].continuation) : 0;
      let h = plan.headH + contH, n = 0;
      while (next[i] + n < body.length && h + body[next[i] + n].height + mark <= avail) { h += body[next[i] + n].height; n++; }
      if (n === 0) {
        if (placedBody || stall < 1) { blocked = true; return; }
        h += body[next[i]].height; n = 1; overflow = true;
      }
      if (started[i] < 0) started[i] = pages.length;
      page.push({ plan: i, from: next[i], to: next[i] + n, cont: contH > 0, natural: h, height: 0, y: 0 });
      used += before + h;
      next[i] += n; placedBody = true;
      if (next[i] < body.length) blocked = true;
    });
    stall = placedBody ? 0 : stall + 1;
    const last = page[page.length - 1];
    if (last != null) last.natural += markH;
    // 組ごとの固定した高さ。足りない分は、ページに残る高さの範囲で空ける
    const sig = page.map((item) => plans[item.plan].card.id).join(SEP);
    let free = limit - page.reduce((total, item, k) => total + item.natural + (k > 0 ? gap : 0), 0);
    if (free < 0) overflow = true;
    let y = LAYOUT.left.top;
    page.forEach((item) => {
      const want = fixed?.get(plans[item.plan].card.id + SEP + sig) ?? 0;
      const pad = Math.max(0, Math.min(want - item.natural, free));
      free -= pad;
      item.height = item.natural + pad; item.y = y; y += item.height + gap;
    });
    pages.push(page);
  }
  return { pages, overflow, reached, started };
}

function byPlace(plans: readonly Plan[]): Plan[] {
  return [...plans].sort((a, b) => a.card.place - b.card.place || a.card.take - b.card.take || a.index - b.index);
}

// fitted は、形の条件を満たして採られたカード。どの形も満たさず最後の形を使ったカード（mayHide でない）は、後から足す候補の検査から外す
function makePlan(card: ShellCard, index: number, formIndex: number, fitted: boolean): Plan {
  const form = card.forms[formIndex];
  return { card, index, form, headH: sumHeights(form.head), bodyless: form.body.length === 0, fitted };
}

// 形の選び（表 §4.1）: take の順に、先に選び終えたカードとこの形で 1 回流し、4 つの条件を見る。
function choose(cards: readonly ShellCard[], limit: number, markH: number): Plan[] {
  const chosen: Plan[] = [];
  const order = cards.map((card, index) => ({ card, index })).filter((item) => item.card.forms.length > 0)
    .sort((a, b) => a.card.take - b.card.take || a.index - b.index);
  for (const { card, index } of order) {
    let pick: Plan | null = null;
    for (let f = 0; f < card.forms.length && pick == null; f++) {
      const plan = makePlan(card, index, f, true);
      if (formFits(plan, byPlace([...chosen, plan]), limit, markH)) pick = plan;
    }
    if (pick == null) {
      if (card.mayHide) continue;
      pick = makePlan(card, index, card.forms.length - 1, false);
    }
    chosen.push(pick);
  }
  return byPlace(chosen);
}

// 候補を足して流した割りで、候補と、先に条件を満たして採られたカード全部の形の条件が成り立つこと（候補が後から割りを変えても保つ）
function formFits(candidate: Plan, plans: readonly Plan[], limit: number, markH: number): boolean {
  const division = flow(plans, limit, markH, null);
  if (division.overflow) return false;
  // 本文の無い形のカードだけが並ぶ新しいページの高さ
  const bodyless = plans.reduce((total, other) => total + (other.bodyless ? other.headH + LAYOUT.gap : 0), 0);
  return plans.every((plan, at) => {
    if (plan !== candidate && !plan.fitted) return true;
    const { maxPages, minBodyRows } = plan.form;
    // 本文の無い形は全ページに出るので、出るページの数は列のページの数
    if (plan.bodyless) return maxPages == null || division.pages.length <= maxPages;
    const mine = division.pages.flatMap((page) => page.filter((item) => item.plan === at));
    if (maxPages != null && mine.length > maxPages) return false;
    if (mine.slice(0, -1).some((item) => item.to - item.from < minBodyRows)) return false;
    if (division.started[at] !== division.reached[at]) return false;
    // 本文のどの行も、本文の無い形のカードだけが並ぶ新しいページに、head と continuation と一緒に入る
    return plan.form.body.every((row, j) => plan.headH + (j > 0 ? sumHeights(row.continuation) : 0) + row.height + markH + bodyless <= limit);
  });
}

function groupMax(solved: Solved): Map<string, number> {
  const out = new Map<string, number>();
  for (const page of solved.division.pages) {
    const sig = page.map((item) => solved.plans[item.plan].card.id).join(SEP);
    for (const item of page) {
      const key = solved.plans[item.plan].card.id + SEP + sig;
      out.set(key, Math.max(out.get(key) ?? 0, item.natural));
    }
  }
  return out;
}

function sameSplit(a: Solved, b: Solved): boolean {
  const same = (x: Placed[][], y: Placed[][], pa: readonly Plan[], pb: readonly Plan[]) => x.length === y.length && x.every((page, p) =>
    page.length === y[p].length && page.every((item, k) => pa[item.plan].card.id === pb[y[p][k].plan].card.id
      && pa[item.plan].form === pb[y[p][k].plan].form && item.from === y[p][k].from && item.to === y[p][k].to));
  return same(a.division.pages, b.division.pages, a.plans, b.plans);
}

// 数えない割り 1 回と、2 ページ以上の列は数える回（右の列は表示の行 45.5px、固定は 2 回目から）を K＋1 回まで。合わせて K＋2 回（P4-DS-RES-02）。
// K は cards.length（登録の max で切った後の枚数で、K 以下。統合担当の決め 2026-11-25 21:04）。
function paginateColumn(column: ShellColumn, cards: readonly ShellCard[]): ShellColumnPages {
  const limit = column === "left" ? LAYOUT.left.usable : LAYOUT.right.h;
  const markH = column === "right" ? LAYOUT.pageMarkRow + LAYOUT.pageMarkGap : 0;
  // 形の選びは固定に依らないので、数えない割りと数える割りの 2 回だけ選ぶ。固定の組み直しは選んだ形で flow だけ回す
  let plans = choose(cards, limit, 0);
  let current: Solved = { plans, division: flow(plans, limit, 0, null) };
  if (current.division.pages.length < 2) return build(column, current, limit, false);
  let counted = 1;
  if (markH > 0) {
    plans = choose(cards, limit, markH);
    current = { plans, division: flow(plans, limit, markH, null) };
    if (current.division.pages.length < 2) return build(column, current, limit, false);
  }
  while (counted < cards.length + 1) {
    const next: Solved = { plans, division: flow(plans, limit, markH, groupMax(current)) };
    counted++;
    const same = sameSplit(next, current);
    current = next;
    if (same) break;
  }
  return build(column, current, limit, true);
}

function build(column: ShellColumn, solved: Solved, limit: number, multi: boolean): ShellColumnPages {
  const x = column === "left" ? LAYOUT.left.x : LAYOUT.right.x;
  const { plans, division } = solved;
  const count = division.pages.length;
  const pages: ShellColumnPage[] = division.pages.map((page, p) => {
    const alone = multi && column === "right" && page.length === 1;
    const cardsOut: ShellCardSlice[] = page.map((item) => {
      const { card, form } = plans[item.plan];
      const body = form.body.slice(item.from, item.to);
      const rows = [...form.head, ...(item.cont ? form.body[item.from].continuation : []), ...body];
      const y = alone ? LAYOUT.right.top : item.y;
      return { id: card.id, rect: rect(x, y, LAYOUT.right.w, alone ? limit : item.height), form: card.forms.indexOf(form), rows };
    });
    const bottom = cardsOut[cardsOut.length - 1];
    return { cards: cardsOut, mark: multi && bottom != null ? { cardId: bottom.id, page: p, pages: count, dots: count <= 7 } : null };
  });
  return { pages };
}

// ---- 押したときと sync（表 §5）----

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id) => b.includes(id));

function reduceShell(state: ShellState, event: ShellEvent): ShellState {
  if (event.kind === "sync") {
    if (!sameIds(event.eew, state.eew)) return { open: false, raised: [], eew: event.eew };
    return state.open && !event.openable ? { ...state, open: false } : state;
  }
  // 描いた frame を組んだ時の状態と違えば効かない（R2、表 §5.2 の 1 行目）
  if (event.frame.shell !== state) return state;
  const { cards, cover } = event.frame;
  const hit = (card: { rect: ShellRect }) => contains(card.rect, event.x, event.y);
  if (state.open) return cards.length > 0 && hit(cards[0]) ? state : { ...state, open: false };
  // 一番手前の面: 最上層は前から奥、中間の層は手前から奥。中間の層は cover の中なら当たらない
  const target = cards.find((card) => card.layer === "top" && hit(card))
    ?? [...cards].reverse().find((card) => card.layer === "middle" && hit(card) && !cover.some((q) => contains(q, event.x, event.y)));
  if (target == null || target.layer === "top") return state;
  if (target.under.length > 0) {
    const raised = state.raised.filter((id) => !target.under.includes(id));
    return raised.length === state.raised.length ? state : { ...state, raised };
  }
  if (target.dimmed) return state.raised.includes(target.id) ? state : { ...state, raised: [...state.raised, target.id] };
  if (target.openable && state.eew.length <= 3) return { ...state, open: true };
  return state;
}

export { clockRect, eewSlots, paginateColumn, placeLayers, reduceShell };
