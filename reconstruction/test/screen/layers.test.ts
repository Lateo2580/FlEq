import { describe, expect, it } from "vitest";

import type { ShellFrame, ShellLayerInput, ShellMiddle, ShellState } from "../../contracts/p4-display-shell.types";
import { clockRect, eewSlots, placeLayers, reduceShell } from "../../src/display/screen/layout";
import { frameOf, middle, rect } from "./screen-fixture";

const eewOf = (ids: readonly string[]): ShellMiddle[] => {
  const slots = eewSlots(ids.length);
  return ids.map((id, i) => middle(id, slots[i].x < 1000 ? "left" : "right", slots[i]));
};
const NONE: ShellState = { open: false, raised: [], eew: [] };
const home = middle("home", "left", rect(40, 40, 540, 258.5));
const warn = middle("warn", "right", rect(1340, 40, 540, 543));
const find = (result: ReturnType<typeof placeLayers>, id: string) => [...result.top, ...result.middle].find((item) => item.id === id);
const place = (input: Partial<ShellLayerInput>) => placeLayers({ eew: [], open: null, raised: [], middle: [], ...input });

// T02 受入条件（P4-DS-AC06・AC13・AC04）: 場所の矩形と、表 §3.2 の L1〜L9。割りの矩形のまま動かないこと（AC13 (1)）。
describe("P4-DS-T02 eewSlots・clockRect・placeLayers L1〜L9", () => {
  it("eewSlots は 1〜6 件の矩形を表 §1.2 のとおり返す", () => {
    expect(eewSlots(1)).toEqual([rect(1340, 40, 540, 1000)]);
    expect(eewSlots(2)).toEqual([rect(1340, 40, 540, 492), rect(1340, 548, 540, 492)]);
    expect(eewSlots(3)).toEqual([rect(1340, 40, 540, 322), rect(1340, 379, 540, 322), rect(1340, 718, 540, 322)]);
    expect(eewSlots(6).slice(3)).toEqual([rect(40, 40, 540, 322), rect(40, 379, 540, 322), rect(40, 718, 540, 322)]);
  });

  it("clockRect は 0〜5 件で左 40、6 件で左 620", () => {
    for (const count of [0, 1, 2, 3, 4, 5]) expect(clockRect(count)).toEqual(rect(40, 960, 540, 80));
    expect(clockRect(6)).toEqual(rect(620, 960, 540, 80));
  });

  it("eewSlots の 4・5 件は、4 件目から左の列の上端 40・379 に置く", () => {
    expect(eewSlots(4)).toEqual([...eewSlots(3), rect(40, 40, 540, 322)]);
    expect(eewSlots(5)).toEqual([...eewSlots(3), rect(40, 40, 540, 322), rect(40, 379, 540, 322)]);
  });

  // 全カードの層・暗さ・ずらし・矩形をそのまま見る（表 §3.2 の期待）
  const shape = (result: ReturnType<typeof placeLayers>) => Object.fromEntries([...result.top, ...result.middle].map((item) => [item.id, [item.layer, item.dimmed, item.shifted, item.rect]]));
  const topSlots = (ids: readonly string[]) => Object.fromEntries(eewOf(ids).map((slot) => [slot.id, ["top", false, false, slot.rect]]));
  const A = rect(1340, 40, 540, 322), B = rect(1340, 379, 540, 322), C = rect(1340, 718, 540, 322), D = rect(40, 40, 540, 322), E = rect(40, 379, 540, 322);
  const gapAB = rect(1340, 362, 540, 17), gapBC = rect(1340, 701, 540, 17), gapDE = rect(40, 362, 540, 17);
  const tsunami = middle("tsunami", "left", rect(40, 315.5, 540, 322));
  const quake5 = middle("quake", "left", rect(40, 315.5, 540, 300));

  it("L1: 最上層が無ければ暗くもずらしもせず、cover は空で、矩形は割りのまま", () => {
    const l1 = place({ middle: [home, warn] });
    expect(l1.cover).toEqual([]);
    expect(shape(l1)).toEqual({ home: ["middle", false, false, home.rect], warn: ["middle", false, false, warn.rect] });
  });

  it("L2・L3: 右の列の警報は覆われて暗く (1244, 40) へずれ、2 件のとき cover に間 16px が入る", () => {
    const l2 = place({ eew: eewOf(["A"]), middle: [warn] });
    expect(l2.cover).toEqual([rect(1340, 40, 540, 1000)]);
    expect(shape(l2).warn).toEqual(["middle", true, true, rect(1244, 40, 540, 543)]);
    const l3 = place({ eew: eewOf(["A", "B"]), middle: [warn] });
    expect(l3.cover).toEqual([...eewSlots(2), rect(1340, 532, 540, 16)]);
    expect(shape(l3).warn).toEqual(["middle", true, true, rect(1244, 40, 540, 543)]);
  });

  it("L4: 3 件で cover に間 17px が 2 つ入り、警報はずれる。A〜C は最上層で動かない", () => {
    const l4 = place({ eew: eewOf(["A", "B", "C"]), middle: [warn] });
    expect(l4.cover).toEqual([A, B, C, gapAB, gapBC]);
    expect(shape(l4)).toEqual({ ...topSlots(["A", "B", "C"]), warn: ["middle", true, true, rect(1244, 40, 540, 543)] });
  });

  it("L5・L6: 4 件で設定した地域はずれ、一部だけ覆われた今日の地震・津波は暗いだけ", () => {
    const four = eewOf(["A", "B", "C", "D"]);
    const l5 = place({ eew: four, middle: [home, quake5, warn] });
    expect(l5.cover).toEqual([A, B, C, D, gapAB, gapBC]);
    expect(shape(l5)).toEqual({ ...topSlots(["A", "B", "C", "D"]), home: ["middle", true, true, rect(136, 40, 540, 258.5)],
      quake: ["middle", true, false, quake5.rect], warn: ["middle", true, true, rect(1244, 40, 540, 543)] });
    const l6 = place({ eew: four, middle: [home, tsunami] });
    expect(l6.cover).toEqual([A, B, C, D, gapAB, gapBC]);
    expect(shape(l6)).toEqual({ ...topSlots(["A", "B", "C", "D"]), home: ["middle", true, true, rect(136, 40, 540, 258.5)], tsunami: ["middle", true, false, tsunami.rect] });
  });

  it("L7: 5 件で cover に左の間 362〜379 も入り、設定した地域と津波はずれ、今日の地震は暗いだけ", () => {
    const late = middle("quake", "left", rect(40, 654.5, 540, 288.5));
    const l7 = place({ eew: eewOf(["A", "B", "C", "D", "E"]), middle: [home, tsunami, late] });
    expect(l7.cover).toEqual([A, B, C, D, E, gapAB, gapBC, gapDE]);
    expect(shape(l7)).toEqual({ ...topSlots(["A", "B", "C", "D", "E"]), home: ["middle", true, true, rect(136, 40, 540, 258.5)],
      tsunami: ["middle", true, true, rect(136, 315.5, 540, 322)], quake: ["middle", true, false, late.rect] });
  });

  it("L9: 開いたカードは先頭の最上層で cover は開いたカードの矩形、重なった津波はずれ、設定した地域は暗いだけ", () => {
    const open = rect(40, 145, 540, 717);
    const l9 = place({ open: { id: "open", rect: open }, middle: [home, tsunami] });
    expect(l9.cover).toEqual([open]);
    expect(shape(l9)).toEqual({ open: ["top", false, false, open], home: ["middle", true, false, home.rect], tsunami: ["middle", true, true, rect(136, 315.5, 540, 322)] });
    expect(l9.top[0].id).toBe("open");
  });
});

// T11 受入条件（P4-DS-AC16・AC06）: 上がったカードがある場面 L11〜L14 と、下がったカードを押して戻す動き。
describe("P4-DS-T11 placeLayers L11〜L14", () => {
  it("L11: 警報を上げると A・B は下がって暗く、ずれない。C は最上層のまま", () => {
    const result = place({ eew: eewOf(["A", "B", "C"]), raised: ["warn"], middle: [warn] });
    expect(result.top.map((item) => item.id)).toEqual(["C", "warn"]);
    expect(find(result, "warn")).toMatchObject({ layer: "top", dimmed: false, rect: rect(1244, 40, 540, 543) });
    expect(result.middle.map((item) => item.id)).toEqual(["A", "B"]);
    for (const id of ["A", "B"]) expect(find(result, id)).toMatchObject({ layer: "middle", dimmed: true, shifted: false, under: ["warn"] });
  });

  it("L11 の下がった A を押すと、A・B が最上層に戻り、警報は中間の層の (1244, …) に残る", () => {
    const raised: ShellState = { open: false, raised: ["warn"], eew: ["A", "B", "C"] };
    const input = { eew: eewOf(["A", "B", "C"]), middle: [warn] };
    const frame = frameOf(raised, place({ ...input, raised: ["warn"] }));
    const next = reduceShell(raised, { kind: "press", frame, x: 1850, y: 100 });
    expect(next.raised).toEqual([]);
    const back = place({ ...input, raised: next.raised });
    expect(back.top.map((item) => item.id)).toEqual(["A", "B", "C"]);
    expect(find(back, "warn")).toMatchObject({ layer: "middle", dimmed: true, rect: rect(1244, 40, 540, 543) });
  });

  it("L12: 津波を上げると D・E は下がって暗くずれず、設定した地域は (136, 40) のまま暗い", () => {
    const tsunami = middle("tsunami", "left", rect(40, 315.5, 540, 322));
    const result = place({ eew: eewOf(["A", "B", "C", "D", "E"]), raised: ["tsunami"], middle: [home, tsunami] });
    expect(find(result, "tsunami")).toMatchObject({ layer: "top", dimmed: false, shifted: true, rect: rect(136, 315.5, 540, 322) });
    for (const id of ["D", "E"]) expect(find(result, id)).toMatchObject({ layer: "middle", dimmed: true, shifted: false, under: ["tsunami"] });
    expect(find(result, "home")).toMatchObject({ dimmed: true, shifted: true, rect: rect(136, 40, 540, 258.5) });
    expect(result.middle.map((item) => item.id)).toEqual(["home", "D", "E"]);
  });

  it("L13: 今日の地震を上げると、全体が覆われた E は 96px ずれ、D は暗いだけ（文 4）", () => {
    const quake = middle("quake", "left", rect(40, 315.5, 540, 464.5));
    const result = place({ eew: eewOf(["A", "B", "C", "D", "E"]), raised: ["quake"], middle: [quake] });
    expect(find(result, "quake")).toMatchObject({ layer: "top", dimmed: false, shifted: false, rect: rect(40, 315.5, 540, 464.5), under: [] });
    expect(find(result, "D")).toMatchObject({ layer: "middle", dimmed: true, shifted: false, under: ["quake"] });
    expect(find(result, "E")).toMatchObject({ layer: "middle", dimmed: true, shifted: true, under: ["quake"], rect: rect(136, 379, 540, 322) });
  });

  it("L14: 緊急地震速報に重ならない上がったカードは、上がっていない扱い（D2）", () => {
    const quake = middle("quake", "left", rect(40, 700, 540, 200));
    const result = place({ eew: eewOf(["A", "B", "C", "D"]), raised: ["quake"], middle: [quake] });
    expect(find(result, "quake")).toMatchObject({ layer: "middle", dimmed: false });
    expect(find(result, "D")).toMatchObject({ layer: "top" });
  });
});

// T04 受入条件（P4-DS-AC07）: 表 §5.3 の点の組 Q1〜Q9。
describe("P4-DS-T04 reduceShell の press Q1〜Q9", () => {
  const press = (shell: ShellState, frame: ShellFrame, x: number, y: number) => reduceShell(shell, { kind: "press", frame, x, y });
  const l4 = (shell: ShellState) => frameOf(shell, place({ eew: eewOf(["A", "B", "C"]), middle: [warn] }));
  const tsunami = middle("tsunami", "left", rect(40, 315.5, 540, 322));
  const l12 = (shell: ShellState) => frameOf(shell, place({ eew: eewOf(["A", "B", "C", "D", "E"]), raised: shell.raised, middle: [home, tsunami] }));

  it("Q1〜Q3: 間は地図で変えない、ずれて出た所は上がる、最上層のカードは変えない", () => {
    const state: ShellState = { ...NONE, eew: ["A", "B", "C"] };
    const frame = l4(state);
    expect(press(state, frame, 1500, 370)).toBe(state);
    expect(press(state, frame, 1260, 300)).toEqual({ ...state, raised: ["warn"] });
    expect(press(state, frame, 1500, 300)).toBe(state);
  });

  it("Q4・Q5: 下がった D は under を外し、暗い設定した地域は上がる", () => {
    const state: ShellState = { open: false, raised: ["tsunami"], eew: ["A", "B", "C", "D", "E"] };
    const frame = l12(state);
    expect(press(state, frame, 60, 100).raised).toEqual([]);
    expect(press(state, frame, 600, 100).raised).toEqual(["tsunami", "home"]);
  });

  it("Q6・Q7: 開いたカードの中は変えず、外は閉じる", () => {
    const state: ShellState = { open: true, raised: [], eew: [] };
    const frame = frameOf(state, place({ open: { id: "open", rect: rect(40, 145, 540, 717) }, middle: [home, tsunami] }));
    expect(press(state, frame, 300, 500)).toBe(state);
    expect(press(state, frame, 700, 300)).toEqual({ ...state, open: false });
  });

  it("Q8・Q9: 暗くない今日の地震は、左の列に緊急地震速報が無ければ開き、4 件以上なら変えない", () => {
    const quake = middle("quake", "left", rect(40, 700, 540, 200));
    const four: ShellState = { ...NONE, eew: ["A", "B", "C", "D"] };
    const q8 = frameOf(four, place({ eew: eewOf(["A", "B", "C", "D"]), middle: [quake] }), ["quake"]);
    expect(press(four, q8, 300, 800)).toBe(four);
    const three: ShellState = { ...NONE, eew: ["A", "B", "C"] };
    const q9 = frameOf(three, place({ eew: eewOf(["A", "B", "C"]), middle: [middle("quake", "left", rect(40, 315.5, 540, 300))] }), ["quake"]);
    expect(press(three, q9, 300, 400)).toEqual({ ...three, open: true });
  });
});

// T12 受入条件（D3・DS-LAYER-22）: sync と、状態が変わった後の旧い frame への押下。
describe("P4-DS-T12 sync", () => {
  const base: ShellState = { open: true, raised: ["x"], eew: ["A"] };
  const sync = (state: ShellState, eew: string[], openable = true) => reduceShell(state, { kind: "sync", eew, openable });

  it("組が増えると raised を空にして閉じ、同じ組（並びだけ違う組を含む）は変えない", () => {
    expect(sync(base, ["A", "B"])).toEqual({ open: false, raised: [], eew: ["A", "B"] });
    expect(sync(base, ["A"])).toBe(base);
    const two: ShellState = { ...base, eew: ["A", "B"] };
    expect(sync(two, ["B", "A"])).toBe(two);
  });

  it("描く前に {A,B}・{A} と届いても raised は空、組が同じで openable が偽なら閉じる", () => {
    const state: ShellState = { open: false, raised: ["x"], eew: ["A"] };
    expect(sync(sync(state, ["A", "B"]), ["A"]).raised).toEqual([]);
    expect(sync(base, ["A"], false)).toEqual({ ...base, open: false });
  });

  it("状態が変わった後は、旧い frame への押下は効かない", () => {
    const state: ShellState = { open: false, raised: ["x"], eew: ["A"] };
    const old = frameOf(state, place({ eew: eewOf(["A"]), middle: [warn] }));
    const changed = sync(state, ["A", "B"]);
    expect(reduceShell(changed, { kind: "press", frame: old, x: 1260, y: 300 })).toBe(changed);
    expect(sync(changed, ["A"]).raised).toEqual([]);
  });
});
