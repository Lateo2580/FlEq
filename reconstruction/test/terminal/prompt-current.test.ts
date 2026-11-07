import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeUnitView, WallBasis } from "../../contracts/p2-shared-runtime.types";
import type { BodyResult, ListHead, UnitWalk } from "../../contracts/p3-recovery.types";
import type { NotificationSettings } from "../../src/cli/notification-gate";
import { painter } from "../../src/terminal/color";
import { walkStart } from "../../src/recovery/recovery";
import type { RuntimeMirror } from "../../src/runtime/shared-runtime";
import { localClock, width } from "../../src/terminal/format";
import { currentItems, itemsOf } from "../../src/terminal/prompt-current";
import { replaceTag } from "../volcano-unit/volcano-fixture";
import { MemoryFiles, fixture, reportMs, world } from "./prompt-fixture";
import { at, harness, levelFive, plain } from "./terminal-fixture";

const TSUNAMI = "32-39_11_02_250206_VTSE41";
const WARNING = "selected_xml/74_01_04_200512_VYSE50", INVESTIGATING = "selected_xml/74_01_01_200512_VYSE50", ENDED = "selected_xml/74_01_07_200512_VYSE50";
const SUBSEQUENT = "selected_xml/80_01_01_240821_VYSE60";
const VOLCANO_L5 = "45_02_01_200522_VFVO50", VOLCANO_L3 = "45_01_01_200522_VFVO50";
const FUKUI = "18_00_01_260830_VPWW55_fukui_L5", FLOOD = "16_00_01_260603_VXKO70_kozagawa_l5", LANDSLIDE = "15_16_01_241031_VPWW56";
const HOUR = 3_600_000, DAY = 24 * HOUR;
const MEGA = "南海トラフ地震臨時情報（巨大地震警戒）";
const TOP_THREE = ["大津波警報 岩手県", "大津波警報 宮城県", "大津波警報 福島県"];

type World = Awaited<ReturnType<typeof world>>;
const opened: World[] = [];
const open = async (...args: Parameters<typeof world>): Promise<World> => { const w = await world(...args); opened.push(w); return w; };
const stdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const columns = (value: number) => { Object.defineProperty(process.stdout, "columns", { value, configurable: true, writable: true }); };
// 走らせる端末の幅に左右されないように固定する。
beforeEach(() => { columns(100); });
afterEach(async () => {
  vi.useRealTimers();
  for (const w of opened.splice(0)) await w.close();
  if (stdoutColumns == null) Reflect.deleteProperty(process.stdout, "columns"); else Object.defineProperty(process.stdout, "columns", stdoutColumns);
});

// 書き換えた報（配信原本でない）。
const training = (xml: string): string => xml.replaceAll("<Status>通常</Status>", "<Status>訓練</Status>");
const landslideL5 = (xml: string): string => xml.replaceAll("<Code>49</Code>", "<Code>39</Code>").replaceAll("レベル４土砂災害危険警報", "レベル５土砂災害特別警報");
const volcanoKind = (code: string, name: string) => (xml: string): string => xml.replaceAll("<Code>15</Code>", `<Code>${code}</Code>`).replaceAll("レベル５（避難）", name);
const cancelled = (time: string) => (xml: string): string => replaceTag("ReportDateTime", time)(xml).replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>");
const unnamed = (name: string) => (xml: string): string => xml.replaceAll(`<Name>${name}</Name>`, "<Name></Name>");
const later = (time: string) => (xml: string): string => xml.replace(/<ReportDateTime>[^<]*</, `<ReportDateTime>${time}<`).replace(/(<Control>[\s\S]*?<DateTime>)[^<]*(<)/, `$1${time}$2`);

async function mirrorOf(...paths: readonly string[]): Promise<RuntimeMirror> {
  const w = await open();
  for (const path of paths) await w.send(path);
  return w.mirror();
}
const unitView = (w: World, unit: keyof RuntimeMirror) => w.mirror()[unit].view;
const seen = async (...args: Parameters<World["send"]>): Promise<World> => { const w = await open(); await w.send(...args); return w; };
const isUnit = <K extends RuntimeUnitView["unit"]>(view: RuntimeUnitView, unit: K): view is Extract<RuntimeUnitView, { unit: K }> => view.unit === unit;

describe("P3-TP-T01 受入条件 津波の項目", () => {
  it("32-39_11_02 は大津波警報の 3 地域だけで、津波警報と津波注意報の地域は出ず、字に「：発表」が入らない", async () => {
    const w = await open();
    await w.send(TSUNAMI);
    expect(w.items()).toEqual(TOP_THREE);
    const all = itemsOf(unitView(w, "U-T"));
    expect(new Set(all.map((item) => item.band))).toEqual(new Set(["top", "warning", "caution"]));
    expect(all.filter((item) => item.text.includes("：") || item.text.startsWith("津波予報"))).toEqual([]);
  });
});

describe("P3-TP-T02 受入条件 分野ごとの段と字", () => {
  it.each([
    ["U-N", WARNING, undefined, "top", MEGA],
    ["U-N", SUBSEQUENT, undefined, "warning", "北海道・三陸沖後発地震注意情報"],
    ["U-V", VOLCANO_L5, undefined, "top", "レベル５（避難） 箱根山"],
    ["U-V", VOLCANO_L5, volcanoKind("24", "山麓厳重警戒"), "top", "山麓厳重警戒 箱根山"],
    ["U-V", VOLCANO_L5, volcanoKind("25", "居住地域厳重警戒"), "top", "居住地域厳重警戒 箱根山"],
    ["U-W", FUKUI, undefined, "top", "レベル５大雨特別警報"],
    ["U-R", FLOOD, undefined, "top", "レベル５氾濫特別警報 古座川"],
    ["U-L", LANDSLIDE, landslideL5, "top", "レベル５土砂災害特別警報"],
  ] as const)("%s %s", async (unit, path, transform, band, text) => {
    const w = await open();
    await w.send(path, transform);
    expect(itemsOf(unitView(w, unit))).toContainEqual({ band, text });
    expect(w.items()).toEqual([text]);
  });
});

describe("P3-TP-T02 受入条件 手作りの mirror の順と段", () => {
  it("分野の順、subject の昇順、同じ字のまとめ、U-N の順、unknown の段、unkeyedAreas、河川なしの areaName、両方が当たる火山、Code 14、調査中の段", async () => {
    const tsunami = unitView(await seen(TSUNAMI), "U-T"), nankai = unitView(await seen(WARNING), "U-N"), subsequent = unitView(await seen(SUBSEQUENT), "U-N");
    const volcano = unitView(await seen(VOLCANO_L5), "U-V"), weather = unitView(await seen(FUKUI), "U-W"), flood = unitView(await seen(FLOOD), "U-R");
    const landslide = unitView(await seen(LANDSLIDE, landslideL5), "U-L");
    if (!isUnit(tsunami, "U-T") || !isUnit(nankai, "U-N") || !isUnit(subsequent, "U-N") || !isUnit(volcano, "U-V") || !isUnit(weather, "U-W") || !isUnit(flood, "U-R") || !isUnit(landslide, "U-L")) throw new Error("view");
    const [forecast] = tsunami.forecasts, [megaquake] = nankai.currents, [later60] = subsequent.currents, [alert] = volcano.alerts;
    const [river] = flood.currents, [slope] = landslide.currents, area = forecast.areas[0], special = weather.areas.find((item) => "33" in item.codes)!;
    if (megaquake.line !== "nankai") throw new Error("nankai");
    const group = river.kinds.find((item) => item.level === 5)!, slopeGroup = slope.kinds.find((item) => item.level === 5)!;
    const place = (name: string, kindName: string, areaClass: typeof area.areaClass) => ({ ...area, name, kindName, areaClass });
    const mirrorOfViews = (base: RuntimeMirror, views: readonly RuntimeUnitView[]): RuntimeMirror =>
      views.reduce((mirror, view) => ({ ...mirror, [view.unit]: { ...mirror[view.unit], view } }), base);
    const base = await mirrorOf();
    const top = mirrorOfViews(base, [
      // 配列は subject の降順に置く。
      { ...landslide, currents: [{ ...slope, subject: "normal/l/b", kinds: [{ ...slopeGroup, name: "土砂 B" }] }, { ...slope, subject: "normal/l/a", kinds: [{ ...slopeGroup, name: "土砂 A" }] }] },
      { ...flood, currents: [{ ...river, subject: "normal/r/b", areaName: "和歌山", kinds: [{ ...group, name: "洪水 B", rivers: [{ code: "1", name: "" }, { code: "2", name: "川" }] }] },
        { ...river, subject: "normal/r/a", areaName: "奈良", kinds: [{ ...group, name: "洪水 A", rivers: [] }] }] },
      { ...weather, areas: [special] },
      { ...volcano, alerts: [
        { ...alert, subject: "normal/v/c", volcanoName: "丙", kind: { code: "36", name: "周辺海域警戒", condition: null }, landKind: { code: "15", name: "レベル５（避難）", condition: null } },
        { ...alert, subject: "normal/v/b", volcanoName: "乙", kind: { code: "15", name: "海の字", condition: null }, landKind: { code: "14", name: "陸の字", condition: null } },
        { ...alert, subject: "normal/v/a", volcanoName: "甲", kind: { code: "14", name: "レベル４（高齢者等避難）", condition: null }, landKind: null }] },
      { ...nankai, currents: [megaquake] },
      { ...tsunami, forecasts: [
        { ...forecast, subject: "normal/VTSE41/b", areas: [place("丙地域", "大津波警報：発表", "majorWarning"), place("甲地域", "大津波警報：発表", "majorWarning")], unkeyedAreas: [] },
        { ...forecast, subject: "normal/VTSE41/a", areas: [place("甲地域", "大津波警報：発表", "majorWarning"), place("軽い地域", "津波注意報：発表", "advisory")],
          unkeyedAreas: [{ name: "無鍵地域", kindCode: "52", kindName: "大津波警報：発表" }] }] },
    ]);
    expect(currentItems(top, new WeakMap()).map((item) => item.text)).toEqual(["大津波警報 甲地域", "大津波警報 無鍵地域", "大津波警報 丙地域", MEGA,
      "レベル４（高齢者等避難） 甲", "海の字 乙", "レベル５（避難） 丙", "レベル５大雨特別警報", "洪水 A 奈良", "洪水 B 和歌山", "洪水 B 川", "土砂 A", "土砂 B"]);
    const warning = mirrorOfViews(base, [
      { ...nankai, currents: [later60, { ...megaquake, status: "investigating" }] },
      { ...tsunami, forecasts: [{ ...forecast, areas: [place("未知地域", "未知の区分：発表", "unknown"), place("注意地域", "津波注意報：発表", "advisory")], unkeyedAreas: [{ name: "無鍵地域", kindCode: "99", kindName: "表に無い区分" }] }] },
    ]);
    expect(currentItems(warning, new WeakMap()).map((item) => item.text)).toEqual(["未知の区分 未知地域", "表に無い区分 無鍵地域", "南海トラフ地震臨時情報（調査中）", "北海道・三陸沖後発地震注意情報"]);
  });
});

describe("P3-TP-T03 契約境界 項目にならないもの", () => {
  it("訓練の津波の報は view にあっても項目にならない", async () => {
    const w = await open();
    await w.send(TSUNAMI, training);
    const view = unitView(w, "U-T");
    expect(view.unit === "U-T" && view.forecasts.map((item) => item.operation)).toEqual(["training"]);
    expect(w.items()).toEqual([]);
  });
  it.each([[LANDSLIDE, "レベル 4 まで"], [VOLCANO_L3, "レベル 3"], ["67_01_01_140927_VFVO56", "噴火速報"]])("%s（%s）は項目にならない", async (path) => {
    const w = await open();
    await w.send(path);
    expect(w.items()).toEqual([]);
  });
  it("U-Q と U-E の mirror の値を読まない", async () => {
    const base = await mirrorOf(TSUNAMI);
    let reads = 0;
    const trap = <T extends object>(target: T): T => new Proxy(target, { get(item, key, receiver) { reads += 1; return Reflect.get(item, key, receiver); } });
    const mirror: RuntimeMirror = { ...base, "U-Q": trap(base["U-Q"]), "U-E": trap(base["U-E"]) };
    const h = harness({}, {});
    h.attach();
    h.output.sink.mirror(mirror);
    expect(h.output.control.promptLabel("clock")).toContain("大津波警報");
    expect(reads).toBe(0);
    await h.output.close();
  });
  it("Kind の名前が空の洪水と土砂は「（読めず）」が字になり、空文字の項目が無い", async () => {
    const flood = await open();
    await flood.send(FLOOD, unnamed("レベル５氾濫特別警報"));
    expect(flood.items()).toEqual(["（読めず） 古座川"]);
    const landslide = await open();
    await landslide.send(LANDSLIDE, (xml) => unnamed("レベル５土砂災害特別警報")(landslideL5(xml)));
    expect(landslide.items()).toEqual(["（読めず）"]);
  });
  it("津波の区分・地域名と火山の区分・火山名が空でも「（読めず）」が字になり、字の頭と尻に空白が残らない", async () => {
    const tsunami = unitView(await seen(TSUNAMI), "U-T"), volcano = unitView(await seen(VOLCANO_L5), "U-V");
    if (!isUnit(tsunami, "U-T") || !isUnit(volcano, "U-V")) throw new Error("view");
    const [forecast] = tsunami.forecasts, [alert] = volcano.alerts;
    const area = forecast.areas.find((item) => item.areaClass === "majorWarning")!;
    expect(itemsOf({ ...tsunami, forecasts: [{ ...forecast, areas: [{ ...area, kindName: "" }, { ...area, kindName: "：発表" }, { ...area, name: "" }], unkeyedAreas: [{ name: "無鍵", kindCode: "52", kindName: "" }] }] }).map((item) => item.text))
      .toEqual([`（読めず） ${area.name}`, `（読めず） ${area.name}`, "大津波警報 （読めず）", "（読めず） 無鍵"]);
    expect(itemsOf({ ...volcano, alerts: [{ ...alert, kind: { ...alert.kind, name: "" } }] }).map((item) => item.text)).toEqual(["（読めず） 箱根山"]);
    expect(itemsOf({ ...volcano, alerts: [{ ...alert, volcanoName: "" }] }).map((item) => item.text)).toEqual(["レベル５（避難） （読めず）"]);
  });
});

describe("P3-TP-T04 受入条件 消える", () => {
  it("津波: 取消で消える", async () => {
    const w = await open();
    await w.send(TSUNAMI);
    expect(w.items()).toEqual(TOP_THREE);
    await w.send("synthetic_VTSE41_cancel");
    expect(w.items()).toEqual([]);
  });
  it("津波: 解除の報で消える", async () => {
    const w = await open();
    await w.send("synthetic_VTSE41_e01_311major");
    expect(w.items().length).toBeGreaterThan(0);
    await w.send("synthetic_VTSE41_e01_released", later("2026-01-01T12:10:00+09:00"));
    expect(w.items()).toEqual([]);
  });
  it("気象: 引下げで 33 が消え、解除まで特別警報は戻らない", async () => {
    const w = await open();
    await w.send(FUKUI);
    expect(w.items()).toEqual(["レベル５大雨特別警報"]);
    await w.send("18_00_01_260830_VPWW55_fukui_downgrade");
    expect(w.items()).toEqual([]);
    await w.send("18_00_01_260830_VPWW55_fukui_release");
    expect(w.items()).toEqual([]);
  });
  it("洪水: 取消の報で消える", async () => {
    const w = await open();
    await w.send(FLOOD);
    await w.send(FLOOD, cancelled("2026-06-03T06:35:00+09:00"));
    expect(w.items()).toEqual([]);
  });
  it("火山: Lv5 が取消で消える", async () => {
    const w = await open();
    await w.send(VOLCANO_L3, levelFive);
    expect(w.items()).toEqual(["レベル５（避難） 浅間山"]);
    await w.send("synthetic_VFVO50_cancel");
    expect(w.items()).toEqual([]);
  });
  it("南海トラフ: 調査中が調査終了で消える", async () => {
    const w = await open();
    await w.send(INVESTIGATING);
    expect(w.items()).toEqual(["南海トラフ地震臨時情報（調査中）"]);
    await w.send(ENDED);
    expect(w.items()).toEqual([]);
  });
  it("VYSE60: validUntil の deadline で消える", async () => {
    const w = await open();
    await w.send(SUBSEQUENT);
    expect(w.items()).toEqual(["北海道・三陸沖後発地震注意情報"]);
    await w.tick(reportMs(fixture(SUBSEQUENT)) + 7 * DAY + 1);
    expect(w.items()).toEqual([]);
  });
  it("洪水: 36 時間の deadline で消える", async () => {
    const w = await open();
    await w.send(FLOOD);
    await w.tick(reportMs(fixture(FLOOD)) + 36 * HOUR - 1_000);
    expect(w.items()).toEqual(["レベル５氾濫特別警報 古座川"]);
    await w.tick(reportMs(fixture(FLOOD)) + 36 * HOUR + 1);
    expect(w.items()).toEqual([]);
  });
});

describe("P3-TP-T05 契約境界 移行と海上の報", () => {
  it("巨大地震警戒は warningUntil の後に status で巨大地震注意へ移り、段も警報に下がる（title と infoSerial は報の字のまま）", async () => {
    const w = await open();
    await w.send(WARNING);
    await w.tick(reportMs(fixture(WARNING)) + 7 * DAY + 1);
    const view = unitView(w, "U-N");
    if (view.unit !== "U-N") throw new Error("U-N");
    expect(itemsOf(view)).toEqual([{ band: "warning", text: "南海トラフ地震臨時情報（巨大地震注意）" }]);
    expect(view.currents[0].title).toContain("巨大地震警戒");
  });
  it("Lv5 の後の VFSV で kind=36・landKind=15 になっても項目が残る", async () => {
    const w = await open();
    await w.send(VOLCANO_L5);
    await w.send("46_01_01_170103_VFSVii", (xml) => later("2020-05-22T14:00:00+09:00")(xml).replaceAll("<Code>506</Code>", "<Code>315</Code>").replaceAll("<Name>桜島</Name>", "<Name>箱根山</Name>"), "VFSV50");
    const view = unitView(w, "U-V");
    if (view.unit !== "U-V") throw new Error("U-V");
    expect(view.alerts.map((alert) => [alert.kind.code, alert.landKind?.code])).toEqual([["36", "15"]]);
    expect(w.items()).toEqual(["レベル５（避難） 箱根山"]);
  });
});

// 枠 slot が出る時刻（5 秒の区切り）。base より後で最初のもの。
function slotAt(base: number, frames: number, slot: number): number {
  let ms = Math.ceil(base / 5_000) * 5_000;
  while (Math.floor(ms / 5_000) % frames !== slot) ms += 5_000;
  return ms;
}
// 実物の mirror を偽の時計の端末に渡す（読みは attach の時）。
function fakeTerminal(mirror: RuntimeMirror, settings?: NotificationSettings, status: Parameters<typeof harness>[1] = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(at(21, 40, 0));
  const h = harness({ ...settings == null ? {} : { notification: settings } }, status);
  h.attach();
  h.output.sink.mirror(mirror);
  const after = (frames: number, slot: number, mode: "clock" | "elapsed" | "uptime" = "clock") => {
    vi.setSystemTime(slotAt(Date.now() + 1, frames, slot));
    return h.output.control.promptLabel(mode);
  };
  return { h, after, mode: (mode: "clock" | "elapsed" | "uptime") => h.output.control.promptLabel(mode) };
}
const DOWN = { connection: "disconnected", lostConnections: 1, lastLossFrameWallMs: at(21, 3, 12), failedAttempts: 3 } as const;
const ENDS = at(21, 50, 0);
const muted = (): NotificationSettings => ({ notify: {}, sound: true, mute: { endsAtMonotonicMs: ENDS, until: null, rules: [] }, version: 0 });

describe("P3-TP-T06 受入条件 回り方と形", () => {
  it("5 秒ごとに 1/3、2/3、3/3、1/3 と回り、4.9 秒では回らず、軽い段は出ない", async () => {
    const t = fakeTerminal(await mirrorOf(TSUNAMI));
    const start = slotAt(Date.now() + 1, 3, 0), label = () => t.h.output.control.promptLabel("clock");
    const seen: string[] = [];
    for (let step = 0; step < 4; step += 1) {
      vi.setSystemTime(start + step * 5_000);
      seen.push(label());
      vi.setSystemTime(start + step * 5_000 + 4_900);
      expect(label().replace(/\d\d:\d\d:\d\d/, "")).toBe(seen[step].replace(/\d\d:\d\d:\d\d/, ""));
    }
    expect(seen.map((text) => text.replace(/\d\d:\d\d:\d\d /, ""))).toEqual([
      "FlEq [● 大津波警報 岩手県 1/3]> ", "FlEq [● 大津波警報 宮城県 2/3]> ", "FlEq [● 大津波警報 福島県 3/3]> ", "FlEq [● 大津波警報 岩手県 1/3]> "]);
    await t.h.output.close();
  });
  it("1 件なら番号が無い。項目が無いと今の字と同じ", async () => {
    const single = await mirrorOf(WARNING), empty = await mirrorOf();
    const one = fakeTerminal(single);
    columns(100);
    expect(one.after(1, 0)).toBe(`FlEq [● ${localClock(Date.now())} ${MEGA}]> `);
    await one.h.output.close();
    const none = fakeTerminal(empty);
    expect(none.after(1, 0)).toBe(`FlEq [● ${localClock(Date.now())}]> `);
    await none.h.output.close();
    const waiting = fakeTerminal(empty, undefined, { connection: "connecting" });
    expect(waiting.after(1, 0)).toBe("FlEq [○ --:--:--]> ");
    await waiting.h.output.close();
  });
  it("clock・elapsed・uptime・ミュート・切断の字が §9.1 のとおりで、色の制御の字が無い", async () => {
    columns(100);
    const mirror = await mirrorOf(TSUNAMI);
    const plain = fakeTerminal(mirror);
    expect(plain.after(3, 0)).toBe(`FlEq [● ${localClock(Date.now())} 大津波警報 岩手県 1/3]> `);
    expect(plain.mode("elapsed")).toMatch(/^FlEq \[● \d\d:\d\d:\d\d 大津波警報 岩手県 1\/3\]> $/);
    expect(plain.mode("uptime")).toMatch(/^FlEq \[● \d{3}:\d\d:\d\d:\d\d 大津波警報 岩手県 1\/3\]> $/);
    expect(plain.mode("clock")).not.toContain("\x1b");
    await plain.h.output.close();
    const mute = fakeTerminal(mirror, muted());
    expect(mute.after(3, 0)).toBe(`FlEq [● ${localClock(Date.now())} ミュート中 21:50 まで 大津波警報 岩手県 1/3]> `);
    await mute.h.output.close();
    const down = fakeTerminal(mirror, undefined, DOWN);
    expect(down.after(3, 0)).toBe("FlEq [21:03:12 から 切断中・繋ぎ直し 3 回目 大津波警報 岩手県 1/3]> ");
    await down.h.output.close();
    const both = fakeTerminal(mirror, muted(), DOWN);
    expect(both.after(3, 0)).toBe("FlEq [21:03:12 から 切断中・ミュート中 大津波警報 岩手県 1/3]> ");
    await both.h.output.close();
  });
  it("status が null の間は「FlEq> 」のまま", async () => {
    const mirror = await mirrorOf(TSUNAMI);
    const h = harness();
    h.output.sink.mirror(mirror);
    expect(h.output.control.promptLabel("clock")).toBe("FlEq> ");
    await h.output.close();
  });
});

// 地域を keep 件にした mirror（枠の数の変化を見る）。
function narrowed(mirror: RuntimeMirror, keep: number): RuntimeMirror {
  const { view } = mirror["U-T"];
  if (view.unit !== "U-T") throw new Error("U-T");
  const forecast = view.forecasts[0], next: RuntimeUnitView = { ...view, forecasts: [{ ...forecast, areas: forecast.areas.filter((area) => area.areaClass === "majorWarning").slice(0, keep) }] };
  return { ...mirror, "U-T": { ...mirror["U-T"], view: next } };
}

describe("P3-TP-T07 受入条件 入らない幅", () => {
  it("56 桁の切断中・ミュート中の 3 件は 4 枠を回し、全部の枠に「切断中」が入り、最後の枠は番号が無い。100 桁は §9.1 の形", async () => {
    const t = fakeTerminal(await mirrorOf(TSUNAMI), muted(), DOWN);
    columns(56);
    expect([t.after(4, 0), t.after(4, 1), t.after(4, 2), t.after(4, 3)]).toEqual([
      "FlEq [切断中 大津波警報 岩手県 1/3]> ", "FlEq [切断中 大津波警報 宮城県 2/3]> ", "FlEq [切断中 大津波警報 福島県 3/3]> ",
      "FlEq [切断中 21:03:12 から・ミュート中]> "]);
    columns(100);
    expect(t.after(3, 2)).toBe("FlEq [21:03:12 から 切断中・ミュート中 大津波警報 福島県 3/3]> ");
    await t.h.output.close();
  });
  it("繋がっている間のミュート: 項目の枠はミュートの字を除き、最後の枠は今の字の形", async () => {
    const t = fakeTerminal(await mirrorOf(TSUNAMI), muted());
    columns(56);
    expect(t.after(4, 0)).toBe(`FlEq [● ${localClock(Date.now())} 大津波警報 岩手県 1/3]> `);
    expect(t.after(4, 3)).toBe(`FlEq [● ${localClock(Date.now())} ミュート中 21:50 まで]> `);
    await t.h.output.close();
  });
  it("56 桁の長い字は時計が外れ、回線の印が残る（clock・elapsed・uptime で同じ）。繋がっていてミュートでなければ枠は増えない", async () => {
    const mirror = await mirrorOf(WARNING);
    const t = fakeTerminal(mirror);
    columns(56);
    const bare = `FlEq [● ${MEGA}]> `;
    expect([t.after(1, 0), t.mode("elapsed"), t.mode("uptime"), t.after(1, 0)]).toEqual([bare, bare, bare, bare]);
    await t.h.output.close();
    const waiting = fakeTerminal(mirror, undefined, { connection: "connecting" });
    expect(waiting.after(1, 0)).toBe(`FlEq [○ ${MEGA}]> `);
    await waiting.h.output.close();
  });
  it("56 桁で時計が外れてもミュートの枠の字は今のまま", async () => {
    const t = fakeTerminal(await mirrorOf(WARNING), muted());
    columns(56);
    expect(t.after(2, 0)).toBe(`FlEq [● ${MEGA}]> `);
    expect(t.after(2, 1)).toBe(`FlEq [● ${localClock(Date.now())} ミュート中 21:50 まで]> `);
    await t.h.output.close();
  });
  it("項目 1 件の入らない幅は枠 2 つで全周期を回し番号が無く、切断中は時計の代わりに「切断中」が残る", async () => {
    const t = fakeTerminal(await mirrorOf(WARNING), undefined, DOWN);
    columns(56);
    expect([t.after(2, 0), t.after(2, 1), t.after(2, 0)]).toEqual([`FlEq [切断中 ${MEGA}]> `, "FlEq [切断中 21:03:12 から・繋ぎ直し 3 回目]> ", `FlEq [切断中 ${MEGA}]> `]);
    await t.h.output.close();
  });
  it("幅の境界: 字の幅が桁数より 1 小さいと収まり、等しいと収まらない", async () => {
    const t = fakeTerminal(await mirrorOf(WARNING));
    const full = `FlEq [● 21:40:05 ${MEGA}]> `;
    columns(width(full) + 1);
    expect(t.after(1, 0)).toBe(`FlEq [● ${localClock(Date.now())} ${MEGA}]> `);
    columns(width(full));
    expect(t.after(1, 0)).toBe(`FlEq [● ${MEGA}]> `);
    await t.h.output.close();
  });
  it("枠の数が変わった直後の字と番号は時計の値のまま飛ぶ", async () => {
    const mirror = await mirrorOf(TSUNAMI);
    const t = fakeTerminal(mirror, muted(), DOWN);
    columns(56);
    // 4 枠の最後と 3 枠の 2 番目が同じ時刻になる所。
    let ms = slotAt(Date.now() + 1, 4, 3);
    while (Math.floor(ms / 5_000) % 3 !== 1) ms = slotAt(ms + 1, 4, 3);
    vi.setSystemTime(ms);
    expect(t.h.output.control.promptLabel("clock")).toBe("FlEq [切断中 21:03:12 から・ミュート中]> ");
    t.h.output.sink.mirror(narrowed(mirror, 2));
    expect(t.h.output.control.promptLabel("clock")).toBe("FlEq [切断中 大津波警報 宮城県 2/2]> ");
    await t.h.output.close();
  });
});

describe("P3-TP-T13 受入条件 入力の行の色（Q-TO6-COLOR）", () => {
  const paint = painter(3), level = chalk.level, tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const color = (on: boolean) => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true, writable: true });
    chalk.level = 3;
    vi.stubEnv("NO_COLOR", on ? "" : "1");
  };
  afterEach(() => {
    chalk.level = level;
    vi.unstubAllEnvs();
    if (tty == null) Reflect.deleteProperty(process.stdout, "isTTY"); else Object.defineProperty(process.stdout, "isTTY", tty);
  });
  it("項目は段の色、番号は dim、切断の字は connLost で、時計・回線の印・ミュートの字は色なし", async () => {
    const tsunami = await mirrorOf(TSUNAMI), subsequent = await mirrorOf(SUBSEQUENT), { view } = tsunami["U-T"];
    if (view.unit !== "U-T") throw new Error("U-T");
    const advisory: RuntimeMirror = { ...tsunami, "U-T": { ...tsunami["U-T"], view: { ...view, forecasts: view.forecasts.map((item) => ({ ...item, areas: item.areas.filter((area) => area.areaClass === "advisory").slice(0, 1) })) } } };
    const shown = advisory["U-T"].view.unit === "U-T" ? advisory["U-T"].view.forecasts[0].areas[0] : null;
    color(true);
    const top = fakeTerminal(tsunami);
    expect(top.after(3, 0)).toBe(`FlEq [● ${localClock(Date.now())} ${paint("rulePurple", "大津波警報 岩手県")} ${paint("dim", "1/3")}]> `);
    await top.h.output.close();
    const warning = fakeTerminal(subsequent);
    expect(warning.after(1, 0)).toBe(`FlEq [● ${localClock(Date.now())} ${paint("ruleWarning", "北海道・三陸沖後発地震注意情報")}]> `);
    await warning.h.output.close();
    const caution = fakeTerminal(advisory, muted());
    expect(caution.after(1, 0)).toBe(`FlEq [● ${localClock(Date.now())} ミュート中 21:50 まで ${paint("ruleCaution", `津波注意報 ${shown?.name}`)}]> `);
    await caution.h.output.close();
    const down = fakeTerminal(tsunami, undefined, DOWN);
    expect(down.after(3, 0)).toBe(`FlEq [${paint("connLost", "21:03:12 から 切断中・繋ぎ直し 3 回目")} ${paint("rulePurple", "大津波警報 岩手県")} ${paint("dim", "1/3")}]> `);
    columns(56);
    expect(down.after(4, 1)).toBe(`FlEq [${paint("connLost", "切断中")} ${paint("rulePurple", "大津波警報 宮城県")} ${paint("dim", "2/3")}]> `);
    expect(down.after(4, 3)).toBe(`FlEq [${paint("connLost", "切断中 21:03:12 から・繋ぎ直し 3 回目")}]> `);
    await down.h.output.close();
    const none = fakeTerminal({ ...tsunami, "U-T": { ...tsunami["U-T"], view: { ...view, forecasts: [] } } }, undefined, DOWN);
    expect(none.after(1, 0)).toBe(`FlEq [${paint("connLost", "21:03:12 から 切断中・繋ぎ直し 3 回目")}]> `);
    await none.h.output.close();
  });
  it("NO_COLOR と TTY でない端末では色の符号が 1 つも入らない", async () => {
    const mirror = await mirrorOf(TSUNAMI);
    color(false);
    const off = fakeTerminal(mirror, undefined, DOWN);
    expect(off.after(3, 0)).toBe("FlEq [21:03:12 から 切断中・繋ぎ直し 3 回目 大津波警報 岩手県 1/3]> ");
    await off.h.output.close();
    color(true);
    if (tty == null) Reflect.deleteProperty(process.stdout, "isTTY"); else Object.defineProperty(process.stdout, "isTTY", tty);
    const pipe = fakeTerminal(mirror, undefined, DOWN);
    expect(pipe.after(3, 0)).toBe("FlEq [21:03:12 から 切断中・繋ぎ直し 3 回目 大津波警報 岩手県 1/3]> ");
    await pipe.h.output.close();
  });
  it("幅の境界で色の有無で枠が変わらない", async () => {
    const mirror = await mirrorOf(WARNING);
    const full = `FlEq [● 21:40:05 ${MEGA}]> `;
    for (const size of [width(full), width(full) + 1]) {
      columns(size);
      color(true);
      const painted = fakeTerminal(mirror);
      const text = painted.after(1, 0), now = Date.now();
      await painted.h.output.close();
      color(false);
      const bare = fakeTerminal(mirror);
      vi.setSystemTime(now);
      expect(plain(text)).toBe(bare.h.output.control.promptLabel("clock"));
      expect(text).toContain("\x1b[");
      await bare.h.output.close();
    }
  });
});

describe("P3-TP-T08 契約境界 受け渡しと計算量", () => {
  it("sink.mirror は view を読まず、view の参照が変わらない unit の項目を作り直さない", async () => {
    const base = await mirrorOf(TSUNAMI, WARNING);
    const reads = { "U-T": 0, "U-N": 0 };
    const counted = (unit: "U-T" | "U-N") => new Proxy(base[unit].view, { get(item, key, receiver) { reads[unit] += 1; return Reflect.get(item, key, receiver); } });
    const tsunami = counted("U-T"), nankai = counted("U-N");
    const mirror: RuntimeMirror = { ...base, "U-T": { ...base["U-T"], view: tsunami }, "U-N": { ...base["U-N"], view: nankai } };
    const h = harness({}, {});
    h.attach();
    for (let index = 0; index < 10_000; index += 1) h.output.sink.mirror(mirror);
    expect(reads).toEqual({ "U-T": 0, "U-N": 0 });
    h.output.control.promptLabel("clock");
    const first = { ...reads };
    expect(first["U-T"]).toBeGreaterThan(0);
    h.output.control.promptLabel("clock");
    h.output.sink.mirror({ ...mirror });
    h.output.control.promptLabel("clock");
    expect(reads).toEqual(first);
    h.output.sink.mirror({ ...mirror, "U-N": { ...mirror["U-N"], view: { ...base["U-N"].view } } });
    h.output.control.promptLabel("clock");
    expect(reads).toEqual(first);
    await h.output.close();
  });
});

describe("P3-TP-T09 受入条件 復元と期限と切断と予算", () => {
  it("active の洪水を保存して復元すると最初の字に載り、awaiting の間は retainUntil の後も残り、unverified の deadline で消える", async () => {
    const files = new MemoryFiles();
    const saved = await open({ files });
    await saved.send(FLOOD);
    await saved.save();
    const reported = reportMs(fixture(FLOOD)), basis = { value: "awaiting" as WallBasis };
    const w = await open({ files, basis, startMs: reported + 37 * HOUR });
    expect(w.label()).toContain("レベル５氾濫特別警報 古座川");
    await w.tick(reported + 37 * HOUR + 1_000);
    expect(w.label()).toContain("レベル５氾濫特別警報 古座川");
    basis.value = "unverified";
    await w.tick(reported + 37 * HOUR + 2_000);
    expect(w.label()).not.toContain("氾濫");
  });
  it("切断中でも 36 時間の deadline で項目が消え、切断中の字は残る", async () => {
    const reported = reportMs(fixture(FLOOD));
    const w = await open({ startMs: reported, status: { connection: "disconnected", lostConnections: 1, lastLossFrameWallMs: reported, failedAttempts: 2 } });
    await w.send(FLOOD);
    expect(w.label()).toContain("切断中");
    expect(w.label()).toContain("レベル５氾濫特別警報 古座川");
    await w.tick(reported + 36 * HOUR + 1);
    expect(w.label()).toBe(`FlEq [${localClock(reported)} から 切断中・繋ぎ直し 2 回目]> `);
  });
  it("snapshot の U-T が delivery summary でも mirror の項目が字に出て、その後の取消で消える", async () => {
    const w = await open();
    await w.send(TSUNAMI);
    // 訓練の報で snapshot の予算を超えさせる（訓練は項目にならないので、取消の後に字が残らない）。
    for (let index = 0; index < 120 && w.snapshots.at(-1)?.current.tsunami.delivery !== "summary"; index += 1)
      await w.send(TSUNAMI, (xml) => training(xml).replaceAll("20110311144640", `2011031114${String(5000 + index)}`));
    expect(w.snapshots.at(-1)?.current.tsunami.delivery).toBe("summary");
    expect(w.label()).toContain("大津波警報");
    await w.send("synthetic_VTSE41_cancel");
    expect(w.label()).not.toContain("大津波警報");
  });
});

describe("P3-TP-T10 受入条件 U-W の区分名", () => {
  const namesOf = (w: World) => {
    const view = unitView(w, "U-W");
    if (view.unit !== "U-W") throw new Error("U-W");
    return view.areas.map((area) => area.names);
  };
  it("names は電文の字を持ち、解除で空になり、復元して未確認の行は入らない", async () => {
    const files = new MemoryFiles();
    const w = await open({ files });
    await w.send(FUKUI);
    expect(namesOf(w)).toContainEqual(expect.objectContaining({ 33: "レベル５大雨特別警報" }));
    await w.save();
    const restored = await open({ files, startMs: w.now.wallTimeMs });
    expect(namesOf(restored).every((names) => Object.keys(names).length === 0)).toBe(true);
    expect(restored.items()).toEqual([]);
    await w.send("18_00_01_260830_VPWW55_fukui_release");
    expect(namesOf(w).flatMap((names) => Object.keys(names))).toEqual([]);
  });
  it("Kind/Name が空の 33 は names に鍵が無く、字は「特別警報」で、空文字の項目が無い", async () => {
    const w = await open();
    await w.send(FUKUI, unnamed("レベル５大雨特別警報"));
    expect(namesOf(w).flatMap((names) => Object.keys(names))).not.toContain("33");
    expect(w.items()).toEqual(["特別警報"]);
  });
});

describe("P3-TP-T11 受入条件 取り直しの取消", () => {
  it("recovery の取消を recoveryDone まで通すと字が変わり、端末の列に報の本文が積まれない", async () => {
    const w = await open();
    await w.send(TSUNAMI);
    expect(w.label()).toContain("大津波警報");
    const lines = w.t.lines.length;
    const eventId = "20110311144640", receivedAtMs = reportMs(fixture("synthetic_VTSE41_cancel"));
    w.moveTo(receivedAtMs + 1_000);
    const head: ListHead = { id: "b1", unit: "U-T", headType: "VTSE41", receivedAtMs, operation: "normal", title: "津波警報", headline: null, reportDateTime: null,
      infoType: "取消", serial: null, eventId, controlDateTime: null, controlStatus: "通常", test: false, editorialOffice: null };
    const body: BodyResult = { kind: "ok", bytes: Buffer.from(fixture("synthetic_VTSE41_cancel")), contentType: "application/xml" };
    const io = { classifications: ["telegram.earthquake"] as const, walk: async (plan: readonly UnitWalk[]) => plan.map(({ unit }) => ({ unit, kind: "listed" as const, heads: [] })),
      fetchBody: async () => body, notBefore: () => -Infinity };
    w.h.root.attachRecovery(io, { "U-T": walkStart(null, "empty", w.now.wallTimeMs) }, Promise.resolve([{ unit: "U-T", kind: "listed", heads: [head] }]));
    for (let turn = 0; turn < 30; turn += 1) { await w.h.settle(); await new Promise((done) => setTimeout(done, 0)); }
    expect(w.h.delivered.some(({ reply }) => reply.kind === "recoveryDone" && reply.result.kind === "adopted")).toBe(true);
    expect(w.label()).not.toContain("大津波警報");
    expect(w.t.lines.length).toBe(lines);
  });
});
