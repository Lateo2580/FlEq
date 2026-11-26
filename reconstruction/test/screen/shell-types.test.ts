import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { DisplayWireSnapshot } from "../../contracts/p4-display-wire.types";
import type { ShellCard, ShellCardEntry, ShellClientState, ShellFrameInput, ShellRow, ShellState } from "../../contracts/p4-display-shell.types";
import type { ShellPart } from "../../contracts/p4-shell-types.types";
import { areaName } from "../../src/display/screen/area-names";
import { screenFrame } from "../../src/display/screen/frame";
import { formatJstTime } from "../../src/display/screen/time";
import { buildAreaNames } from "../../tools/gis/build-area-names.mjs";
import { card, form, rect, row, rows, textOf } from "./screen-fixture";

const registry = vi.hoisted(() => ({ list: [] as ShellCardEntry[] }));
vi.mock("../../src/display/screen/cards", () => ({ get CARD_SOURCES() { return registry.list; } }));

const snapshot = { schemaVersion: "p4-display-wire-v3", streamId: "a", sequence: 1, current: {} } as unknown as DisplayWireSnapshot;
const live: ShellClientState = { snapshot, unsupported: false, changed: [], detail: null };
const IDLE: ShellState = { open: false, raised: [], eew: [] };
const input = (extra: Partial<ShellFrameInput> = {}): ShellFrameInput =>
  ({ state: live, nowMs: Date.UTC(2026, 10, 25, 12, 34), page: { left: 0, right: 0 }, innerPage: {}, shell: IDLE, ...extra });
// source が呼ばれるたびに今の list を返す（snapshot ごとに替わるカードを表す）
let list: readonly ShellCard[] = [];
registry.list = [{ source: () => list, max: 8 }];
const find = (frame: ReturnType<typeof screenFrame>, id: string) => frame.cards.find((item) => item.id === id);
const idRow = (id: string, text: string): ShellRow => ({ ...row(100, text), id });
const groupRow = (token: string): ShellRow => ({ ...row(100), id: "g", texts: [{ kind: "group", token, texts: [{ kind: "text", text: "5弱", token: null }] }] });
const groupToken = (target: ShellRow | undefined): string | null | undefined => {
  const part: ShellPart | undefined = target?.texts[0];
  return part?.kind === "group" ? part.token : undefined;
};
const pages = (prefix: string, count: number): [ShellRow[], ...ShellRow[][]] => [[row(50, `${prefix}1`)], ...Array.from({ length: count - 1 }, (_, i) => [row(50, `${prefix}${i + 2}`)])];

// T01 契約境界・corpus 履歴（P4-ST-AC06）: 区域名の生成物と引き方。
describe("P4-ST-T01 area-names", () => {
  it("(ア) area-names.ts は buildAreaNames() の字と同じ", () => {
    expect(readFileSync(join(__dirname, "../../src/display/screen/area-names.ts"), "utf8")).toBe(buildAreaNames());
  });

  it("(イ) 層をまたぐ同じ Code は層ごとの名前、表に無いコードと継承したキーは null", () => {
    expect(areaName("forecastLocalE", "100")).toBe("石狩地方北部");
    expect(areaName("tsunamiArea", "100")).toBe("北海道太平洋沿岸東部");
    expect(areaName("city", "0123600")).toBe("渡島北斗市");
    expect(areaName("weatherCity", "0123600")).toBe("北斗市");
    expect(areaName("tsunamiAreaGroup", "191")).toBe("北海道太平洋沿岸");
    expect(areaName("pref", "01")).toBe("北海道");
    for (const code of ["0123600", "9999999", "constructor"]) expect(areaName("pref", code)).toBeNull();
  });

  it("(ウ) VPWS50 の市町村等の Code 1,718 個のうち weatherCity に無い 15 個は floodCity にある", () => {
    const xml = readFileSync(join(__dirname, "../../../test/fixtures/15_18_01_250630_VPWS50.xml"), "utf8");
    const block = /<Information type="気象警報・注意報（市町村等）">([\s\S]*?)<\/Information>/.exec(xml)?.[1] ?? "";
    const codes = [...block.matchAll(/<Code>(\d{7})<\/Code>/g)].map((match) => match[1]);
    expect(codes).toHaveLength(1718);
    const missing = codes.filter((code) => areaName("weatherCity", code) == null);
    expect(missing).toHaveLength(15);
    for (const code of missing) expect(areaName("floodCity", code)).not.toBeNull();
    expect(areaName("floodCity", "0920600")).toBe("日光市");
    expect(areaName("floodCity", "1410000")).toBe("横浜市");
  });
});

// T02 受入条件（P4-ST-AC01・AC02・AC04）: 行の id・束の token の比べ、カードの token、カードの中のページ。
describe("P4-ST-T02 screenFrame の行の id・束・token・inner", () => {
  it("(ア) 行の id だけ・束の token だけが違う次の snapshot で、割りの使い回しが古い行を返さない", () => {
    list = [card("A", "right", { forms: [form(90, [idRow("a1", "x")])] })];
    expect(find(screenFrame(input()), "A")?.rows.at(-1)?.id).toBe("a1");
    list = [card("A", "right", { forms: [form(90, [idRow("a2", "x")])] })];
    expect(find(screenFrame(input()), "A")?.rows.at(-1)?.id).toBe("a2");
    list = [card("A", "right", { forms: [form(90, [groupRow("int-5m")])] })];
    expect(groupToken(find(screenFrame(input()), "A")?.rows.at(-1))).toBe("int-5m");
    list = [card("A", "right", { forms: [form(90, [groupRow("int-5p")])] })];
    expect(groupToken(find(screenFrame(input()), "A")?.rows.at(-1))).toBe("int-5p");
  });

  it("(イ) カードの token は ShellDrawCard へ入り、token だけ替わっても列の割りを組み直さない", () => {
    const column = (token: string) => card("C", "right", { token, forms: [form(90, rows(2))] });
    const slot = card("S", "right", { slot: 0, token: "y", forms: [form(100, [])] });
    list = [column("x"), slot];
    const first = screenFrame(input());
    expect(find(first, "C")?.token).toBe("x");
    expect(find(first, "S")?.token).toBe("y");
    list = [column("z"), slot];
    const second = screenFrame(input());
    expect(find(second, "C")?.rows).toBe(find(first, "C")?.rows);
    expect(find(second, "C")?.token).toBe("z");
  });

  it("(ウ)(エ)(オ) slot のカードの inner は番号のページだけを描き、丸め、ページの数を返す。inner が null なら forms[0]", () => {
    const withInner = (count: number) => card("E", "right", { slot: 0, inner: pages("p", count), forms: [form(100, rows(1, 50, "f"))] });
    list = [withInner(3)];
    const shown = (innerPage: ShellFrameInput["innerPage"]) => {
      const frame = screenFrame(input({ innerPage }));
      return { text: find(frame, "E")?.rows.map((r) => textOf(r)), mark: find(frame, "E")?.mark, count: frame.innerPageCount.E };
    };
    const inherited: ShellFrameInput["innerPage"] = Object.create({ E: 2 });
    expect(shown({})).toEqual({ text: ["p1"], mark: null, count: 3 });
    for (const [innerPage, want] of [[{ E: 2 }, "p3"], [{ E: 99 }, "p3"], [{ E: -1 }, "p1"], [{ E: 1.5 }, "p1"], [{ E: Number.NaN }, "p1"], [inherited, "p1"]] as const)
      expect(shown(innerPage)).toEqual({ text: [want], mark: null, count: 3 });
    // 番号 2 のまま、続報で 2 ページになると最後のページ、3 ページへ戻ると 3 ページ目（番号は直さない）
    list = [withInner(2)];
    expect(shown({ E: 2 })).toEqual({ text: ["p2"], mark: null, count: 2 });
    list = [withInner(3)];
    expect(shown({ E: 2 })).toEqual({ text: ["p3"], mark: null, count: 3 });
    list = [card("E", "right", { slot: 0, forms: [form(100, rows(1, 50, "f"))] })];
    const plain = screenFrame(input());
    expect(find(plain, "E")?.rows.map((r) => textOf(r))).toEqual(["head", "f1"]);
    expect(Object.hasOwn(plain.innerPageCount, "E")).toBe(false);
  });

  it("(カ) 開いたカードは inner の番号のページ、閉じていれば列の割り、下がった slot のカードも inner から選べばキーを持つ", () => {
    const quake = card("Q", "left", { mayHide: true, inner: pages("q", 2), forms: [form(90, rows(2))], opened: { rect: rect(40, 145, 540, 717), rows: [row(50, "open")] } });
    list = [quake];
    const opened = screenFrame(input({ shell: { open: true, raised: [], eew: [] }, innerPage: { Q: 1 } }));
    expect(find(opened, "Q")).toMatchObject({ layer: "top", rect: rect(40, 145, 540, 717) });
    expect(find(opened, "Q")?.rows.map((r) => textOf(r))).toEqual(["q2"]);
    expect(opened.innerPageCount.Q).toBe(2);
    const closed = screenFrame(input({ innerPage: { Q: 1 } }));
    expect(find(closed, "Q")?.rows.map((r) => textOf(r))).toEqual(["head", "r1", "r2"]);
    expect(Object.hasOwn(closed.innerPageCount, "Q")).toBe(false);

    list = [card("R", "right", { forms: [form(90, rows(3))] }), card("E", "right", { slot: 0, inner: pages("p", 2), forms: [form(100, [])] })];
    const lowered = screenFrame(input({ shell: { open: false, raised: ["R"], eew: ["E"] } }));
    expect(find(lowered, "E")).toMatchObject({ layer: "middle", under: ["R"] });
    expect(find(lowered, "E")?.rows.map((r) => textOf(r))).toEqual(["p1"]);
    expect(lowered.innerPageCount.E).toBe(2);
  });
});

// T03 受入条件（P4-ST-AC05）: 時分秒・時分の字。端末の時差に依らない。
describe("P4-ST-T03 formatJstTime", () => {
  it("時差の字 3 種と epoch は同じ日本時間、読めない値は「時刻不明」、process.env.TZ を替えても同じ", () => {
    const original = process.env.TZ;
    try {
      for (const zone of ["America/New_York", "Asia/Tokyo", "UTC"]) {
        process.env.TZ = zone;
        for (const value of [Date.UTC(2026, 10, 25, 12, 34, 56), "2026-11-25T12:34:56Z", "2026-11-25T21:34:56+09:00", "2026-11-25T07:34:56-05:00"]) {
          expect(formatJstTime(value, "second")).toBe("21:34:56");
          expect(formatJstTime(value, "minute")).toBe("21:34");
        }
        for (const value of ["2026-11-25T21:34:56", null, "garbage", Number.NaN, "2026-02-30T00:00:00+09:00", "2026-11-25T24:00:00+09:00"])
          for (const unit of ["second", "minute"] as const) expect(formatJstTime(value, unit)).toBe("時刻不明");
      }
    } finally { if (original == null) delete process.env.TZ; else process.env.TZ = original; }
  });
});
