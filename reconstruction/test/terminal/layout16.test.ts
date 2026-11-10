import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { HostStatus } from "../../contracts/p3-cli-repl.types";
import type { RecoveryDigestView } from "../../contracts/p3-recovery.types";
import type { TerminalReport } from "../../contracts/p3-terminal-output.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { placeUnits, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { createRenderer } from "../../src/terminal/format";
import { inputTerminal, terminalReport } from "../../src/terminal/material";
import { createTerminalOutput } from "../../src/terminal/output";
import { decodeFixture, inputDoneOf, reportOf, reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-016 の試験（台風の暴風域に入る確率の府県の行・起動時のまとめの「ほか」の行の折り）。
const JANGMI = "76_01_02_260531_VPTA50.xml", DAMREY = "76_01_01_200630_VPTA50.xml", ZERO = "76_01_03_260602_VPTA50.xml";
const FIVE_DAY = '<MeteorologicalInfo type="台風の暴風域に入る確率（5日積算）">';

// layout15.test.ts の sink と同じ本物の出力の経路（createTerminalOutput）。桁数は書き出しの batch で差し替える。
const CONNECTED: HostStatus = { connection: "connected", socketId: 1, failedAttempts: 0, lastFailure: null, lastFrameWallMs: null, lostConnections: 0,
  lastLossFrameWallMs: null, display: null, classifications: null };
function sink(columns: number) {
  const renderer = createRenderer(0), lines: string[] = [];
  const output = createTerminalOutput({ tipInterval: 0, notify: async () => {}, clock: () => ({ wallTimeMs: Date.now(), monotonicMs: Date.now() }),
    write: (batch, done) => { lines.push(...renderer.render({ ...batch, columns }).replace(/\n$/, "").split("\n")); done(); } });
  output.attach({ status: () => CONNECTED });
  return { output, lines };
}

// layout5.test.ts の through と同じ owner の道（deferred の owner、空の state、時計は ReportDateTime の 60 秒後）で材料を作り、sink.inputDone に渡す。
async function owned(path: string, columns: number) {
  const xml = readFileSync(`test/fixtures/${path}`, "utf8");
  const now = { wallTimeMs: Date.parse(/<ReportDateTime>([^<]+)/.exec(xml)![1]) + 60_000, monotonicMs: 0 };
  const inputId = `l16-${path.replace(/\W/g, "")}`;
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: now.wallTimeMs, origin: "live", kind: "replay", body: Buffer.from(xml), headType: "VPTA50" });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const result = decodeMaterial(entered.item);
  const owner = restoreOwner({ runId: "run", place: "deferred", clock: now,
    restored: Object.fromEntries(placeUnits("deferred").map((unit) => [unit, { kind: "empty" }])) as never }, linkedUnitTable, linkedUnitCodecs);
  const step = receiveOwner(owner.state, { runId: "run", inputId, result }, now, linkedUnitTable);
  const rejected = step.confirmationEvidence.some(({ source }) => source === "unreadableReport");
  const report = inputTerminal(result, step.outcomes, rejected);
  const s = sink(columns);
  s.output.sink.inputDone(inputDoneOf(inputId, report, step.outcomes));
  await s.output.close();
  return { lines: s.lines, outcome: step.outcomes.find(({ unit }) => unit === "U-Y")?.outcome ?? null };
}

const probabilityOf = (report: TerminalReport) => report.kind === "short" ? report.probability : undefined;
// 節（open から close まで）の中の Item ごとに edit を当てる。節の外の Item は変えない。
function editItems(open: string, close: string, edit: (item: string) => string) {
  return (xml: string): string => {
    const start = xml.indexOf(open), end = xml.indexOf(close, start);
    const next = xml.slice(0, start) + xml.slice(start, end).replace(/<Item>[\s\S]*?<\/Item>/g, edit) + xml.slice(end);
    expect(next).not.toBe(xml);
    return next;
  };
}
const setValues = (item: string, value: string): string => item.replace(/(<FiftyKtWindProbability(?: [^>]*)?>)[^<]*</g, (_, tag: string) => `${tag}${value}<`);
// 5日積算の値を表の Area/Code のほかは 0 にする（T08）。
const fiveDay = (table: Readonly<Record<string, number>>) => editItems(FIVE_DAY, "</MeteorologicalInfo>",
  (item) => setValues(item, String(table[/<Code>(\d+)<\/Code>/.exec(item)![1]] ?? 0)));

const JANGMI_ROWS = [
  "奄美地方                  北部            100%  06/02 03時頃",
  "沖縄本島地方              南部            100%  06/01 15時頃",
  "鹿児島県（奄美地方除く）  種子島地方       98%  06/02 12時頃",
  "宮崎県                    日南・串間地区   83%  06/02 15時頃",
  "和歌山県                  新宮・東牟婁     79%  06/03 03時頃",
  "東京都                    三宅島           74%  06/03 12時頃",
  "三重県                    紀勢・東紀州     73%  06/03 06時頃",
];

describe("P3-TL16 台風の暴風域に入る確率の府県の行", () => {
  // P3-TL16-T01 corpusHistory / AC01・AC02
  it("T01 76_01_02 を owner の道と本物の出力の経路に通すと、100・80 桁で 70% 以上の 7 府県の 1 行と「ほか」、56 桁で府県ごとに 2 行", async () => {
    const wide = await owned(JANGMI, 100);
    expect(wide.lines).toEqual(["", "━ 台風の暴風域に入る確率 台風第6号（JANGMI） ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 09:55:00 発表 ━",
      ...JANGMI_ROWS, "ほか 37 府県", "VPTA50 ・ 気象庁"]);
    expect((await owned(JANGMI, 80)).lines.slice(2)).toEqual(wide.lines.slice(2));
    expect((await owned(JANGMI, 56)).lines).toEqual(["", "━ 台風の暴風域に入る確率 台風第6号（JANGMI） ━━━━━━━━━━━", "09:55:00 発表",
      "奄美地方", "  北部            100%  06/02 03時頃", "沖縄本島地方", "  南部            100%  06/01 15時頃",
      "鹿児島県（奄美地方除く）", "  種子島地方       98%  06/02 12時頃", "宮崎県", "  日南・串間地区   83%  06/02 15時頃",
      "和歌山県", "  新宮・東牟婁     79%  06/03 03時頃", "東京都", "  三宅島           74%  06/03 12時頃",
      "三重県", "  紀勢・東紀州     73%  06/03 06時頃", "ほか 37 府県", "VPTA50 ・ 気象庁"]);
  });

  // P3-TL16-T02 corpusHistory / AC01・AC02
  it("T02 76_01_01 は 70% 以上の 17 府県が全部出て、大東島地方は地域の欄が空", () => {
    expect(terminal(80)([reportUnit(reportOf(DAMREY, "U-Y"))]).slice(2, -1)).toEqual([
      "奄美地方                  北部              100%  10/01 18時頃",
      "沖縄本島地方              国頭地区          100%  10/01 18時頃",
      "大東島地方                                  100%  10/01 09時頃",
      "長崎県                    長崎地区           99%  10/02 21時頃",
      "熊本県                    天草地方           99%  10/02 21時頃",
      "鹿児島県（奄美地方除く）  出水・伊佐         99%  10/02 21時頃",
      "福岡県                    筑後南部           98%  10/03 00時頃",
      "佐賀県                    鹿島地区           98%  10/02 21時頃",
      "大分県                    日田玖珠           97%  10/03 00時頃",
      "山口県                    下関               95%  10/03 03時頃",
      "宮崎県                    小林・えびの地区   95%  10/02 21時頃",
      "島根県                    益田地区           92%  10/03 03時頃",
      "広島県                    広島・呉           91%  10/03 03時頃",
      "愛媛県                    南予北部           86%  10/03 00時頃",
      "鳥取県                    米子地区           79%  10/03 06時頃",
      "岡山県                    新見地域           77%  10/03 06時頃",
      "高知県                    幡多               75%  10/03 00時頃",
      "ほか 28 府県"]);
  });

  // P3-TL16-T03 corpusHistory / AC02 (5)
  it("T03 全部 0% の 76_01_03 は U-Y が revisionOnly で採り、帯と末尾の 2 行のまま", async () => {
    const { lines, outcome } = await owned(ZERO, 100);
    expect(outcome).toMatchObject({ kind: "accepted", change: "revisionOnly" });
    expect(lines).toEqual(["", "━ 台風の暴風域に入る確率 台風第6号（JANGMI） ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 15:55:00 発表 ━", "VPTA50 ・ 気象庁"]);
  });

  // P3-TL16-T04 contractBoundary / AC01 (1)〜(4)
  it("T04 材料の probability の値と、null になる報", () => {
    const rows = [
      { prefecture: "奄美地方", area: "北部", percent: "100", peakRaw: "2026-06-02T03:00:00+09:00" },
      { prefecture: "沖縄本島地方", area: "南部", percent: "100", peakRaw: "2026-06-01T15:00:00+09:00" },
      { prefecture: "鹿児島県（奄美地方除く）", area: "種子島地方", percent: "98", peakRaw: "2026-06-02T12:00:00+09:00" },
      { prefecture: "宮崎県", area: "日南・串間地区", percent: "83", peakRaw: "2026-06-02T15:00:00+09:00" },
      { prefecture: "和歌山県", area: "新宮・東牟婁", percent: "79", peakRaw: "2026-06-03T03:00:00+09:00" },
      { prefecture: "東京都", area: "三宅島", percent: "74", peakRaw: "2026-06-03T12:00:00+09:00" },
      { prefecture: "三重県", area: "紀勢・東紀州", percent: "73", peakRaw: "2026-06-03T06:00:00+09:00" },
    ];
    const expected = { rows, others: 37 };
    expect(probabilityOf(reportOf(JANGMI, "U-Y"))).toEqual(expected);
    expect(probabilityOf(reportOf(ZERO, "U-Y"))).toEqual({ rows: [], others: 0 });
    const vpta51 = terminalReport(decodeFixture(JANGMI, "replay", (xml) => xml, "VPTA51"), "U-Y");
    expect(vpta51 == null ? null : probabilityOf(vpta51)).toEqual(expected);
    const wideDigit = (xml: string): string => {
      const next = xml.replace(FIVE_DAY, '<MeteorologicalInfo type="台風の暴風域に入る確率（５日積算） ">');
      expect(next).not.toBe(xml);
      return next;
    };
    expect(probabilityOf(reportOf(JANGMI, "U-Y", wideDigit))).toEqual(expected);
    expect(probabilityOf(reportOf("synthetic_VPTA50_cancel.xml", "U-Y"))).toBeNull();
    expect(probabilityOf(reportOf("10_04_03_170913_VPTW60.xml", "U-Y"))).toBeNull();
  });

  // P3-TL16-T05 contractBoundary / AC01 (4)・AC02 (2)
  it("T05 最悪の地域の時系列が全部 0 なら peakRaw は null で、時刻の欄が空", () => {
    const flat = editItems("<TimeSeriesInfo>", "</TimeSeriesInfo>", (item) => item.includes("<Code>460041</Code>") ? setValues(item, "0") : item);
    const report = reportOf(JANGMI, "U-Y", flat);
    expect(probabilityOf(report)?.rows[0]).toEqual({ prefecture: "奄美地方", area: "北部", percent: "100", peakRaw: null });
    expect(terminal(80)([reportUnit(report)]).slice(2, -1)).toEqual(["奄美地方                  北部            100%", ...JANGMI_ROWS.slice(1), "ほか 37 府県"]);
  });

  // P3-TL16-T08 contractBoundary / AC01 (3)
  it("T08 70 未満の同じ確率は PrefectureCode の順で 5 行目で切り、70 ちょうどの府県は 5 を越えても全部", () => {
    const names = (table: Readonly<Record<string, number>>) => {
      const probability = probabilityOf(reportOf(JANGMI, "U-Y", fiveDay(table)));
      return { rows: probability?.rows.map((row) => row.prefecture), others: probability?.others };
    };
    expect(names({ 460041: 90, 450012: 60, 300022: 50, 130032: 30, 240022: 30, 290022: 30 }))
      .toEqual({ rows: ["奄美地方", "宮崎県", "和歌山県", "東京都", "三重県"], others: 1 });
    expect(names({ 130032: 70, 300022: 70, 450012: 70, 460041: 70, 460031: 70, 471011: 70, 240022: 69 }))
      .toEqual({ rows: ["東京都", "和歌山県", "宮崎県", "奄美地方", "鹿児島県（奄美地方除く）", "沖縄本島地方"], others: 1 });
  });
});

// ---- 起動時のまとめ（digest.test.ts と同じく sink.digest） ----
const volcanoHead = (title: string) => ({ headType: "VFVO53", operation: "normal" as const, title, headline: "見出し文",
  reportDateTime: "2026-11-09T20:00:00+09:00", receivedAt: 0 });
async function digestLines(view: RecoveryDigestView, columns: number): Promise<string[]> {
  const s = sink(columns);
  s.output.sink.digest(view);
  await s.output.close();
  return s.lines;
}

describe("P3-TL16 起動時のまとめの「ほか」の行", () => {
  // P3-TL16-T06 regression / AC03（2026-11-09 23:05 の Mac mini の写しで題名の途中で割れた）
  it("T06 「ほか」の行は「題名 n 件」の組の境で折り、続きの行を 7 桁下げる", async () => {
    // 題名は写しの 3 行の代わり（「ほか」の行の字には効かない）。
    const view: RecoveryDigestView = { units: [{ unit: "U-V", beforeWindow: true, kind: "listed",
      heads: [volcanoHead("火山名　霧島山（新燃岳）　降灰予報（定時）"), volcanoHead("火山名　桜島　降灰予報（定時）"), volcanoHead("火山名　諏訪之瀬島　降灰予報（定時）")],
      omitted: { VFVO53: 289, VFVO51: 11, VFVO60: 3, VFVO52: 3, VFVO50: 1 } }] };
    const wide = await digestLines(view, 100);
    expect(wide.slice(-2)).toEqual(["  ほか 降灰予報（定時） 289 件　火山の状況に関する解説情報 11 件　推定噴煙流向報 3 件", "       噴火に関する火山観測報 3 件　噴火警報・予報 1 件"]);
    const narrow = await digestLines(view, 56);
    expect(narrow).toContain("火山       310 件");
    expect(narrow.slice(-4)).toEqual(["  ほか 降灰予報（定時） 289 件", "       火山の状況に関する解説情報 11 件", "       推定噴煙流向報 3 件　噴火に関する火山観測報 3 件", "       噴火警報・予報 1 件"]);
  });

  // P3-TL16-T07 contractBoundary / AC03 (3)
  it("T07 1 つの組だけで幅を越えるときは組の中を字の境目で折り、続きの行も 7 桁下げる", async () => {
    const view: RecoveryDigestView = { units: [{ unit: "U-V", beforeWindow: false, kind: "listed", heads: [], omitted: { VFSV50: 2, VFVO53: 1 } }] };
    const others = (lines: string[]) => lines.slice(lines.findIndex((text) => text.startsWith("  ほか")));
    expect(others(await digestLines(view, 30))).toEqual(["  ほか 火山現象に関する海上警", "       報・海上予報 2 件", "       降灰予報（定時） 1 件"]);
    expect(others(await digestLines(view, 56))).toEqual(["  ほか 火山現象に関する海上警報・海上予報 2 件", "       降灰予報（定時） 1 件"]);
  });
});
