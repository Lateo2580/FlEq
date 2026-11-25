import { describe, expect, it, vi } from "vitest";

import type { DisplayWireSnapshot } from "../../contracts/p4-display-wire.types";
import type { ShellCard, ShellCardEntry, ShellClientState, ShellDetail, ShellFrameInput, ShellState } from "../../contracts/p4-display-shell.types";
import { clockText, formatJst, screenFrame, shellSync } from "../../src/display/screen/frame";
import { card, form, rect, row, rows } from "./screen-fixture";

const registry = vi.hoisted(() => ({ list: [] as ShellCardEntry[] }));
vi.mock("../../src/display/screen/cards", () => ({ get CARD_SOURCES() { return registry.list; } }));

const snapshot = { schemaVersion: "p4-display-wire-v3", streamId: "a", sequence: 1, current: { weatherCurrent: { unit: "U-W", contentRevision: "r", items: [] } } } as unknown as DisplayWireSnapshot;
const live: ShellClientState = { snapshot, unsupported: false, changed: [], detail: null };
const IDLE: ShellState = { open: false, raised: [], eew: [] };
const NOW = Date.UTC(2026, 10, 25, 12, 34);
const input = (state: ShellClientState, extra: Partial<ShellFrameInput> = {}): ShellFrameInput => ({ state, nowMs: NOW, page: { left: 0, right: 0 }, shell: IDLE, ...extra });
const use = (...sources: ShellCardEntry[]) => { registry.list = sources; };
const cards = (list: readonly ShellCard[], max = list.length): ShellCardEntry => ({ source: () => list, max });
const find = (frame: ReturnType<typeof screenFrame>, id: string) => frame.cards.find((item) => item.id === id);

// T06 受入条件（P4-DS-AC03・AC04・AC05・AC08・AC10・AC16）: CARD_SOURCES を作り物に差し替えた screenFrame と shellSync。
describe("P4-DS-T06 screenFrame・shellSync", () => {
  it("(a)(b) snapshot が無い・unsupported ならカード 0 で時計だけ、札は版が合わないときだけ。平常は札なし", () => {
    use(cards([card("c", "right", { forms: [form(90, rows(1))] })]));
    const none = screenFrame(input({ ...live, snapshot: null }));
    expect(none).toMatchObject({ cards: [], status: [], map: [], marks: [], clock: { rect: rect(40, 960, 540, 80), text: "2026/11/25 (Wed) 21:34" } });
    expect(screenFrame(input({ ...live, unsupported: true })).status).toEqual(["受け取った情報を表示できません"]);
    expect(screenFrame(input({ ...live, unsupported: true })).cards).toEqual([]);
    expect(screenFrame(input(live))).toMatchObject({ status: [], cards: [{ id: "c" }] });
  });

  it("(c)(d)(f) ページの番号が多ければ最後のページ、取消で消えたカードは今のページの外でも消え、分野の包みはそのまま関数へ渡る", () => {
    const long = card("long", "right", { forms: [form(90, rows(30))] });
    const seen: unknown[] = [];
    use({ source: (snap) => { seen.push(snap.current.weatherCurrent); return snap === snapshot ? [long] : []; }, max: 1 });
    const last = screenFrame(input(live, { page: { left: 0, right: 99 } }));
    expect(last.pageCount.right).toBe(4);
    expect(find(last, "long")?.rows.at(-1)?.texts[0]?.text).toBe("r30");
    expect(seen[0]).toBe(snapshot.current.weatherCurrent);
    expect(screenFrame(input({ ...live, snapshot: { ...snapshot, sequence: 2 } as DisplayWireSnapshot })).cards).toEqual([]);
  });

  it("(e)(k)(l) slot のカードは eewSlots の場所で最上層、開いたカードは先頭で中間の層に無く、同じ集め方で shellSync が組を返し、7 枚目は置かない", () => {
    const slots = Array.from({ length: 7 }, (_, i) => card(`e${i}`, "right", { slot: i, forms: [form(100, [])] }));
    const quake = card("quake", "left", { mayHide: true, forms: [form(90, rows(2))], opened: { rect: rect(40, 145, 540, 717), rows: [row(50, "open")] } });
    use(cards(slots.slice(0, 2), 2), cards([quake]));
    const frame = screenFrame(input(live, { shell: { open: true, raised: [], eew: ["e0", "e1"] } }));
    expect(frame.cards.map((item) => item.id)).toEqual(["quake", "e0", "e1"]);
    expect(frame.cards[0]).toMatchObject({ layer: "top", rect: rect(40, 145, 540, 717), openable: true });
    expect(find(frame, "e1")).toMatchObject({ layer: "top", rect: rect(1340, 548, 540, 492) });
    expect(shellSync(live, NOW)).toEqual({ kind: "sync", eew: ["e0", "e1"], openable: true });
    expect(shellSync({ ...live, unsupported: true }, NOW)).toEqual({ kind: "sync", eew: [], openable: false });

    use(cards(slots, 7));
    const seven = screenFrame(input(live));
    expect(seven.eew).toHaveLength(6);
    expect(seven.clock.rect).toEqual(rect(620, 960, 540, 80));
  });

  it("(g) 2 ページ以上の右の列は一番下のカードの mark（last）、左の列は今日の地震の mark（head、点なし）に入る", () => {
    const right = card("right", "right", { forms: [form(90, rows(30))] });
    const home = card("home", "left", { place: 0, take: 0, forms: [form(200, [])] });
    const quake = card("quake", "left", { place: 1, take: 1, mayHide: true, forms: [form(90, rows(10))] });
    use(cards([right, home, quake]));
    const frame = screenFrame(input(live));
    expect(find(frame, "right")?.mark).toMatchObject({ text: "1/4", at: "last", dots: true });
    expect(find(frame, "quake")?.mark).toMatchObject({ text: "1/2", at: "head", dots: false });
    expect(find(frame, "home")?.mark).toBeNull();
  });

  it("(h) 同じ入力は割りを組み直さず、place と take だけ入れ替えると順が変わる", () => {
    const make = (placeA: number, placeB: number) => [
      card("A", "right", { place: placeA, take: placeA, forms: [form(100, rows(2))] }),
      card("B", "right", { place: placeB, take: placeB, forms: [form(100, rows(2))] })];
    let list = make(0, 1);
    use({ source: () => list, max: 2 });
    const first = screenFrame(input(live)), second = screenFrame(input(live));
    expect(find(second, "A")?.rows).toBe(find(first, "A")?.rows);
    expect(find(first, "A")?.rect.y).toBeLessThan(find(first, "B")?.rect.y ?? 0);
    list = make(1, 0);
    const swapped = screenFrame(input(live));
    expect(find(swapped, "B")?.rect.y).toBeLessThan(find(swapped, "A")?.rect.y ?? 0);
  });

  it("(i) max を越えて返す source は前から max 枚だけが描かれ、診断が 1 件残る", () => {
    const three = ["a", "b", "c"].map((id, i) => card(id, "right", { place: i, take: i, forms: [form(100, [])] }));
    use({ source: () => three, max: 2 });
    const frame = screenFrame(input(live));
    expect(frame.cards.map((item) => item.id)).toEqual(["a", "b"]);
    expect(frame.diagnostics).toEqual([{ reason: "cardSourceOverMax", entry: 0, returned: 3, max: 2 }]);
    expect(shellSync(live, NOW)).toMatchObject({ openable: false });
  });

  it("(j) 詳細が failed の札は 1 つ、版が合わない札が先、loading と refetch では出ない", () => {
    use();
    const detail = (status: ShellDetail["status"]): ShellDetail => ({ request: { unit: "U-T", part: "index", revision: "1", page: 0 }, streamId: "a", status, response: null });
    expect(screenFrame(input({ ...live, detail: detail("failed") })).status).toEqual(["詳細を表示できません"]);
    expect(screenFrame(input({ ...live, unsupported: true, detail: detail("failed") })).status).toEqual(["受け取った情報を表示できません", "詳細を表示できません"]);
    for (const status of ["loading", "refetch"] as const) expect(screenFrame(input({ ...live, detail: detail(status) })).status).toEqual([]);
  });
});

// T07 受入条件（P4-DS-AC09）: 日本時間の整形。端末の時差に依らない。
describe("P4-DS-T07 formatJst・clockText", () => {
  it("epoch・Z・±hh:mm は同じ日本時間になり、時差の無い字・null・読めない字は「時刻不明」", () => {
    const want = "2026/11/25 21:34:56";
    for (const value of [Date.UTC(2026, 10, 25, 12, 34, 56), "2026-11-25T12:34:56Z", "2026-11-25T21:34:56+09:00", "2026-11-25T07:34:56-05:00"]) expect(formatJst(value)).toBe(want);
    for (const value of ["2026-11-25T21:34:56", null, "garbage", Number.NaN]) expect(formatJst(value)).toBe("時刻不明");
  });

  it("process.env.TZ を替えても結果は変わらず、時計の曜日と 0 埋めが出る", () => {
    const original = process.env.TZ;
    try {
      for (const zone of ["America/New_York", "Asia/Tokyo", "UTC"]) {
        process.env.TZ = zone;
        expect(formatJst("2026-11-25T12:34:56Z")).toBe("2026/11/25 21:34:56");
        expect(clockText(Date.UTC(2026, 0, 4, 15, 5))).toBe("2026/01/05 (Mon) 00:05");
      }
    } finally { if (original == null) delete process.env.TZ; else process.env.TZ = original; }
  });
});
