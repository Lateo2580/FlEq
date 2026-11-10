import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationIntent, PersistenceStatus } from "../../contracts/p2-shared-runtime.types";
import type { TerminalReport } from "../../contracts/p3-terminal-output.types";
import { painter } from "../../src/terminal/color";
import { width } from "../../src/terminal/format";
import { at, band, filled, harness, inputDoneOf, plain, reportOf, reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-008（Q-TO9-VPWS50-TARGET・REPEAT）の試験。15_18_01 は 4.5 MB なので、書き換えた報だけを decode し直す。
const PATH = "15_18_01_250630_VPWS50.xml", TITLE = "気象警報・注意報（集約通報） 全国";
const LAYER = /<Warning type="気象警報・注意報（府県予報区等）">[\s\S]*?<\/Warning>/;
type Short = Extract<TerminalReport, { kind: "short" }>;
function vpws50(transform?: (xml: string) => string): Short {
  const report = reportOf(PATH, "U-W", transform);
  if (report.kind !== "short") throw new Error("not short");
  return report;
}
let cached: Short | null = null;
const original = (): Short => cached ??= vpws50();
// 府県予報区等の層だけを書き換える（Headline と細かい層にも同じ名前と Code がある）。
const inLayer = (edit: (layer: string) => string) => (xml: string): string => {
  const next = xml.replace(LAYER, edit);
  expect(next).not.toBe(xml);
  return next;
};
const kind = (name: string, code: string, status = "発表"): string => `<Kind><Name>${name}</Name><Code>${code}</Code><Status>${status}</Status></Kind>`;
const item = (area: string, ...kinds: string[]): string => `<Item>${kinds.join("")}<Area><Name>${area}</Name><Code>0</Code></Area></Item>`;
const layerOf = (...items: string[]) => inLayer(() => `<Warning type="気象警報・注意報（府県予報区等）">${items.join("")}</Warning>`);
const editItem = (area: string, edit: (text: string) => string) =>
  inLayer((layer) => layer.replace(/<Item>[\s\S]*?<\/Item>/g, (text) => text.includes(`<Name>${area}</Name>`) ? edit(text) : text));
const release = (area: string, code: string) => editItem(area, (text) => text.replace(new RegExp(`(<Code>${code}</Code>\\s*<Status>)[^<]*`), "$1解除"));
const both = (...transforms: ((xml: string) => string)[]) => (xml: string): string => transforms.reduce((text, transform) => transform(text), xml);
// T03: 層の危険警報と警報（4x・0x）を同じ現象の注意報に替える。
const CAUTION = [["レベル３大雨警報", "03", "レベル２大雨注意報", "10"], ["暴風警報", "05", "強風注意報", "15"], ["波浪警報", "07", "波浪注意報", "16"],
  ["レベル３高潮警報", "08", "レベル２高潮注意報", "19"], ["レベル４土砂災害危険警報", "49", "レベル２土砂災害注意報", "29"]] as const;
const cautionOnly = inLayer((layer) => CAUTION.reduce((text, [from, fromCode, to, toCode]) =>
  text.replace(new RegExp(`<Name>${from}</Name>\\s*<Code>${fromCode}</Code>`, "g"), `<Name>${to}</Name><Code>${toCode}</Code>`), layer));
const render = (report: TerminalReport, columns = 80, level: 0 | 3 = 0): string[] => terminal(columns, level)([reportUnit(report)]);
const PREFECTURES = ["茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県", "山梨県", "長野県", "静岡県", "三重県", "大阪府", "奈良県"];
const LEVEL4 = "レベル４土砂災害危険警報";

describe("P3-TL8 全国の集約通報の帯と表", () => {
  // P3-TL8-T01 regression / AC01・AC02（2026-11-08 Mac mini の実配信）
  it("T01 帯は全国で、段は府県予報区等の層の最も重い段、直下はその段の Kind と予報区。宗谷地方が帯にも表にも出ない", () => {
    const report = original();
    expect([report.target, report.level, report.reason]).toEqual(["全国", "purple", null]);
    const lines = render(report, 60, 3).map(plain);
    expect(lines).toEqual(["", filled(TITLE, "09:09:00", 60), `  ${LEVEL4}  茨城県　栃木県　群馬県　埼玉県`, `  ${LEVEL4}  千葉県　東京都　神奈川県　山梨県`,
      `  ${LEVEL4}  長野県　静岡県　三重県　大阪府`, `  ${LEVEL4}  奈良県`, "  VPWS50 ・ 気象庁"]);
    // 2026-11-08 15:00 の形: 層の先頭の宗谷地方は注意報だけで、波浪警報は網走・北見・紋別地方と根室地方。
    const afternoon = vpws50(layerOf(item("宗谷地方", kind("強風注意報", "15"), kind("波浪注意報", "16")),
      item("網走・北見・紋別地方", kind("波浪警報", "07"), kind("強風注意報", "15")), item("根室地方", kind("波浪警報", "07"), kind("強風注意報", "15"))));
    expect([afternoon.target, afternoon.level]).toEqual(["全国", "warning"]);
    expect(render(afternoon)).toEqual(["", band(TITLE, "09:09:00"), "波浪警報  網走・北見・紋別地方　根室地方", "VPWS50 ・ 気象庁"]);
  });

  // P3-TL8-T02 acceptance / AC02
  it("T02 56・80・100 桁で行が桁数を越えず、名前の途中で折れず、折り返した行の左の列は薄い字で、表の上下に罫線が無い", () => {
    const dim = painter(3)("dim", LEVEL4);
    for (const columns of [56, 80, 100]) {
      const raw = render(original(), columns, 3), lines = raw.map(plain);
      for (const text of lines) expect(width(text.trimEnd())).toBeLessThanOrEqual(columns);
      const rows = lines.flatMap((text, index) => text.trim().startsWith(LEVEL4) ? [index] : []);
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.flatMap((index) => lines[index].trim().slice(LEVEL4.length).trim().split("　"))).toEqual(PREFECTURES);
      expect(rows.map((index) => raw[index].includes(dim))).toEqual(rows.map((_, at) => at > 0));
      expect(lines.some((text) => /^ *─+$/.test(text))).toBe(false);
    }
  });

  // P3-TL8-T03 acceptance / AC03
  it("T03 注意報だけの報は Kind の名前の並びだけ、今の Kind の無い報は帯と末尾だけ、特別警報の報はその段の 1 行だけ", () => {
    const caution = vpws50(cautionOnly);
    expect(caution.level).toBe("caution");
    expect(render(caution)).toEqual(["", band(TITLE, "09:09:00"), "レベル２大雨注意報　雷注意報　強風注意報　波浪注意報　レベル２高潮注意報", "濃霧注意報　レベル２土砂災害注意報",
      "VPWS50 ・ 気象庁"]);
    const none = vpws50(inLayer((layer) => layer.replace(/<Status>[^<]*<\/Status>/g, "<Status>解除</Status>")));
    expect(none.level).toBe("plain");
    expect(render(none)).toEqual(["", band(TITLE, "09:09:00"), "VPWS50 ・ 気象庁"]);
    const top = vpws50(editItem("宗谷地方", (text) => text.replace(/<Name>濃霧注意報<\/Name>\s*<Code>20<\/Code>\s*<Status>解除<\/Status>/, "<Name>大雨特別警報</Name><Code>33</Code><Status>発表</Status>")));
    expect(top.level).toBe("top");
    expect(render(top)).toEqual(["", band(TITLE, "09:09:00"), "大雨特別警報  宗谷地方", "VPWS50 ・ 気象庁"]);
  });

  // P3-TL8-T05 contractBoundary / AC01 (6)・AC02 (2)(6)・AC04 (6)・AC05 (1)
  it("T05 層の無い報は全国で表が無く理由の行が今のまま、257 の Item は先頭 256 で決めて「ほか 1」、同じ Code の Kind 2 つは 1 行で予報区 1 回", () => {
    const untyped = vpws50(inLayer((layer) => layer.replace("（府県予報区等）", "（府県予報区等の試験）")));
    expect([untyped.target, untyped.national, untyped.level, untyped.reason]).toEqual(["全国", null, "purple", LEVEL4]);
    expect(render(untyped).slice(2)).toEqual([LEVEL4, "VPWS50 ・ 気象庁"]);
    const h = harness();
    for (const id of ["a", "b"]) h.output.sink.inputDone(inputDoneOf(id, untyped));
    expect(h.lines.filter((text) => text.startsWith(`━ ${TITLE}`))).toHaveLength(2);

    const names = Array.from({ length: 257 }, (_, index) => `予報区${index + 1}`);
    const many = vpws50(layerOf(...names.map((name, index) => index === 256 ? item(name, kind("大雨特別警報", "33"), kind("波浪警報", "07")) : item(name, kind("波浪警報", "07")))));
    expect([many.level, many.national]).toEqual(["warning", { rows: [{ label: "波浪警報", areas: names.slice(0, 256) }], others: 1 }]);
    expect(render(many).at(-2)).toBe("ほか 1 予報区は読んでいません");
    const twice = vpws50(layerOf(item("宗谷地方", kind("波浪警報", "07"), kind("波浪警報", "07", "継続")), item("根室地方", kind("波浪警報", "07"))));
    expect(twice.national).toEqual({ rows: [{ label: "波浪警報", areas: ["宗谷地方", "根室地方"] }], others: 0 });
  });
});

// P3-TL8-T04 acceptance / AC01 (5)・AC04
describe("P3-TL8-T04 前と同じ全国の集約通報を出さない", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at(11, 50)); });
  afterEach(() => { vi.useRealTimers(); });
  const shown = (lines: readonly string[]): string[] => lines.filter((text) => text.startsWith(`━ ${TITLE}`) || text.startsWith("━ 気象警報・注意報（集約通報） 取消"));
  const SAVED: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null };
  const intent = (inputId: string): NotificationIntent => ({ id: `n-${inputId}`, unit: "U-W", subject: "s", operation: "normal",
    source: { inputId, origin: "live", operation: "normal", family: "VPWS50", subject: "s", reportDateTimeRaw: "", controlDateTimeRaw: "", serialRaw: "", infoTypeRaw: "発表" },
    transition: "activated", channel: "desktop", payload: {}, createdAt: 0, expiresAt: 0, nextAttemptAt: 0, attempts: 0, configRevision: "", disposition: "pending",
    lastAttempt: null, replayed: false, priorityGroup: "other" });

  it("ReportDateTime だけが違う 15 通は最初の 1 つだけ出て、定期要約に 15 件と数え、入力の行の経過の時刻を戻さない", async () => {
    const h = harness();
    h.attach();
    const base = original();
    for (let index = 0; index < 15; index += 1) {
      const minutes = 11 * 60 + 50 + index * 10, time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;
      if (index > 0) vi.advanceTimersByTime(10 * 60_000);
      h.output.sink.inputDone(inputDoneOf(`r${index}`, { ...base, head: { ...base.head, reportDateTimeRaw: `2019-10-12T${time}+09:00` } }));
    }
    expect(shown(h.lines)).toEqual([band(TITLE, "11:50:00")]);
    expect(h.output.control.promptLabel("elapsed")).toContain("02:20:00");
    h.output.control.summaryNow();
    expect(h.lines.at(-1)).toBe("── 11:50〜14:10 の受信 ── 気象 15件");
    await h.output.close();
  });

  it("表に出ない予報区の出入りは出ず、危険警報の予報区が増えると出る。注意報だけの報は種類が同じなら出ない", async () => {
    const h = harness();
    const send = (id: string, report: TerminalReport) => { h.output.sink.inputDone(inputDoneOf(id, report)); return shown(h.lines).length; };
    expect(send("r0", original())).toBe(1);
    // 上川地方の濃霧注意報だけを解除（予報区は減るが、表の段の行は同じ）。
    expect(send("r1", vpws50(release("上川地方", "20")))).toBe(1);
    const more = vpws50(editItem("上川地方", (text) => text.replace("<Item>", `<Item>${kind(LEVEL4, "49")}`)));
    expect([send("r2", more), send("r3", more)]).toEqual([2, 2]);
    expect(send("c0", vpws50(cautionOnly))).toBe(3);
    expect(send("c1", vpws50(both(cautionOnly, release("上川地方", "20"))))).toBe(3);
    // 日高地方は強風注意報を持つ先頭の Item。解除すると強風注意報は後ろの岩手県に残り、電文で出た順が大雨注意報の後ろに入れ替わる。
    expect(send("c2", vpws50(both(cautionOnly, release("日高地方", "15"))))).toBe(3);
    expect(send("c3", vpws50(both(cautionOnly, inLayer((layer) => layer.replace(/(<Code>14<\/Code>\s*<Status>)[^<]*/g, "$1解除")))))).toBe(4);
    await h.output.close();
  });

  it("その入力の通知の intent がある返信は前と同じでも出て、回線の切断と回復、取り直しの返信の後は前と同じ報が出ない", async () => {
    const h = harness();
    h.attach();
    const base = original();
    const withIntent = (id: string, owner: string) => inputDoneOf(id, base, [], [{ unit: "U-W", persistence: SAVED, view: null, pendingIntents: [intent(owner)] }]);
    h.output.sink.inputDone(inputDoneOf("r0", base));
    h.output.sink.inputDone(withIntent("r1", "r0"));
    expect(shown(h.lines)).toHaveLength(1);
    h.output.sink.inputDone(withIntent("r2", "r2"));
    expect(shown(h.lines)).toHaveLength(2);
    h.set({ connection: "disconnected", lostConnections: 1, lastLossFrameWallMs: Date.now() });
    vi.advanceTimersByTime(1_000);
    h.set({ connection: "connected" });
    vi.advanceTimersByTime(1_000);
    expect(h.lines.some((text) => text.startsWith("━ 回線が戻りました"))).toBe(true);
    h.output.sink.inputDone(inputDoneOf("r3", base));
    h.output.sink.inputDone(inputDoneOf("recovered", null, [], [], false));
    h.output.sink.inputDone(inputDoneOf("r4", base));
    expect(shown(h.lines)).toHaveLength(2);
    await h.output.close();
  });

  it("clear の後と取消の報の後は前と同じ報が出て、取消は全国で表が無い。起動し直した端末では最初の 1 通が出る", async () => {
    const h = harness();
    const base = original();
    h.output.sink.inputDone(inputDoneOf("r0", base));
    h.output.control.clear();
    h.output.sink.inputDone(inputDoneOf("r1", base));
    const cancel = vpws50((xml) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>"));
    expect([cancel.target, cancel.level, cancel.national]).toEqual(["全国", "cancel", null]);
    h.output.sink.inputDone(inputDoneOf("x", cancel));
    h.output.sink.inputDone(inputDoneOf("r2", base));
    expect(shown(h.lines)).toEqual([band(TITLE, "09:09:00"), band(TITLE, "09:09:00"), band("気象警報・注意報（集約通報） 取消 全国", "09:09:00"), band(TITLE, "09:09:00")]);
    expect(h.lines.filter((text) => text.startsWith(LEVEL4))).toHaveLength(9);
    await h.output.close();
    const restarted = harness();
    restarted.output.sink.inputDone(inputDoneOf("r3", base));
    expect(shown(restarted.lines)).toHaveLength(1);
    await restarted.output.close();
  });

  it("--debug の行は「出さない・前と同じ」で読めなかった報のカードを出さず、--debug なしでは出さない報が tips の待ちを動かさない", async () => {
    const base = original();
    const card = { kind: "unreadable", inputId: "r1", headType: "VXSE53", operation: "normal", receivedAt: Date.now(), reason: "requiredStructureInvalid",
      title: "震源・震度に関する情報", headline: null, reportDateTimeRaw: null, rawCut: false, count: 1, hasRaw: true } as const;
    const debug = harness({ debug: true });
    debug.output.sink.inputDone(inputDoneOf("r0", base));
    debug.output.sink.inputDone(inputDoneOf("r1", base, [], [{ unit: "U-N", persistence: SAVED, pendingIntents: null,
      view: { unit: "U-N", semanticRevision: "", contentRevision: "", subjects: [], currents: [], information: [], unreadableCards: [card] } }]));
    expect(debug.lines.filter((text) => text.startsWith("debug: "))).toEqual(["debug: VPWS50 r0（U-W、出した）", "debug: VPWS50 r1（U-W、出さない・前と同じ）"]);
    expect(debug.lines.some((text) => text.includes("処理できなかった電文"))).toBe(false);
    await debug.output.close();
    const h = harness({ tipInterval: 1 });
    h.attach();
    h.output.sink.inputDone(inputDoneOf("r0", base));
    vi.advanceTimersByTime(30_000);
    h.output.sink.inputDone(inputDoneOf("r1", base));
    vi.advanceTimersByTime(30_000);
    expect(h.lines.filter((text) => text.includes("Tip:"))).toHaveLength(1);
    await h.output.close();
  });
});

describe("P3-TDT-T01 --debug の行は tips の待ちの起点を動かさない", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at(11, 50)); });
  afterEach(() => { vi.useRealTimers(); });

  it("同じ全国の集約通報が 10 分ごとに届いても、--debug の起動で最初の報から 30 分に Tip が 1 つ出る", async () => {
    const base = original();
    const h = harness({ debug: true, tipInterval: 30 });
    h.attach();
    h.output.sink.inputDone(inputDoneOf("r0", base));
    vi.advanceTimersByTime(10 * 60_000);
    h.output.sink.inputDone(inputDoneOf("r1", base));
    vi.advanceTimersByTime(10 * 60_000);
    h.output.sink.inputDone(inputDoneOf("r2", base));
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.lines.filter((text) => text.startsWith("debug: "))).toEqual(["debug: VPWS50 r0（U-W、出した）", "debug: VPWS50 r1（U-W、出さない・前と同じ）", "debug: VPWS50 r2（U-W、出さない・前と同じ）"]);
    expect(h.lines.filter((text) => text.includes("Tip:"))).toHaveLength(1);
    await h.output.close();
  });
});
