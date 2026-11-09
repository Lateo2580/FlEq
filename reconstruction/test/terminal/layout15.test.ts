import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimePublishedOutcome, SubjectOutcome } from "../../contracts/p2-shared-runtime.types";
import type { HostStatus } from "../../contracts/p3-cli-repl.types";
import type { TerminalReport } from "../../contracts/p3-terminal-output.types";
import { createRenderer } from "../../src/terminal/format";
import { createTerminalOutput } from "../../src/terminal/output";
import { at, band, inputDoneOf, plain, reportOf, reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-015 の試験（気象解説情報の帯・時系列のまとまりの上限・tips の英数字の並び）。
const bandLine = (report: TerminalReport): string => terminal()([reportUnit(report)])[1];

describe("P3-TL15 気象解説情報の帯", () => {
  // P3-TL15-T01 regression / AC01（2026-11-09 22:07 の VPCJ51 の帯「地方気象解説情報 沖縄本島地方」）
  it("T01 全般・地方・府県の気象解説情報の帯の題名は Head/Title の字で、対象を付けない", () => {
    expect(bandLine(reportOf("83_01_01_250630_VPZJ51.xml", "U-M"))).toBe(band("全般気象解説情報（線状降水帯半日前予測）", "16:21:00"));
    expect(bandLine(reportOf("84_01_01_260129_VPCJ51.xml", "U-M"))).toBe(band("関東甲信地方気象解説情報（強い冬型・大雪）", "15:00:00"));
    expect(bandLine(reportOf("85(82)_02_01_250630_VPFJ51.xml", "U-M"))).toBe(band("福井県気象解説情報（大雪・高波・雷）", "17:21:00"));
  });

  // P3-TL15-T02 contractBoundary / AC01 (2)
  it("T02 Head/Title の無い府県気象解説情報の帯は種類の名前だけで、最初の Area の名前を付けない", () => {
    const untitled = (xml: string): string => {
      const next = xml.replace("<Title>福井県気象解説情報（大雪・高波・雷）</Title>", "");
      expect(next).not.toBe(xml);
      return next;
    };
    expect(bandLine(reportOf("85(82)_02_01_250630_VPFJ51.xml", "U-M", untitled))).toBe(band("府県気象解説情報", "17:21:00"));
  });
});

// ---- 気象警報・注意報時系列情報（layout11.test.ts と同じ harness） ----
type Short = Extract<TerminalReport, { kind: "short" }>;
const CONNECTED: HostStatus = { connection: "connected", socketId: 1, failedAttempts: 0, lastFailure: null, lastFrameWallMs: null, lostConnections: 0,
  lastLossFrameWallMs: null, display: null, classifications: null };
function sink(columns = 80) {
  const renderer = createRenderer(0), lines: string[] = [];
  const output = createTerminalOutput({ tipInterval: 0, notify: async () => {}, clock: () => ({ wallTimeMs: Date.now(), monotonicMs: Date.now() }),
    write: (batch, done) => { lines.push(...renderer.render({ ...batch, columns }).replace(/\n$/, "").split("\n")); done(); } });
  output.attach({ status: () => CONNECTED });
  return { output, lines };
}
const TS = "81_02_01_260605_VPWP50_high_severity.xml";
function tsOf(name: string): Short {
  const report = reportOf(TS, "U-F", (xml) => xml.replace("<Title>宗谷地方警戒・注意事項時系列情報</Title>", `<Title>${name}地方警戒・注意事項時系列情報</Title>`)
    .replace("<EditorialOffice>稚内地方気象台</EditorialOffice>", `<EditorialOffice>${name}地方気象台</EditorialOffice>`)
    .replace("<PublishingOffice>稚内地方気象台</PublishingOffice>", `<PublishingOffice>${name}地方気象台</PublishingOffice>`)
    .replace(/<ReportDateTime>[^<]*/, "<ReportDateTime>2026-11-09T11:00:00+09:00"));
  if (report.kind !== "short") throw new Error(report.kind);
  return report;
}
const ufSubject = (subject: string, inputId: string): SubjectOutcome => ({ subject, operation: "normal", informationType: "発表", transition: "active",
  severity: null, facts: {}, changedFields: [], source: { inputId, origin: "live", operation: "normal", family: "VPWP50", subject, reportDateTimeRaw: "",
    controlDateTimeRaw: "", serialRaw: "", infoTypeRaw: "発表" } });
const uf = (subject: string, inputId: string): RuntimePublishedOutcome => ({ unit: "U-F", outcome: { kind: "accepted", change: "semantic", subjects: [ufSubject(subject, inputId)] } });

describe("P3-TL15 気象警報・注意報時系列情報のまとまりの上限", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at(11, 0, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  // P3-TL15-T03 acceptance / AC02（実測の便: 58 報・幅 119.0〜144.1 秒・間隔の最大 3.4〜6.2 秒、Q-TL15-TS-INTERVAL）
  it("T03 58 報を 2 秒と 6 秒の間隔で 134 秒かけて渡すと、最後の報から 8 秒の tick に 58 件のブロックが 1 つだけ出る", async () => {
    const s = sink();
    for (let index = 0; index < 58; index += 1) {
      if (index > 0) vi.advanceTimersByTime(index % 10 === 0 ? 6_000 : 2_000);
      s.output.sink.inputDone(inputDoneOf(`p${index}`, tsOf(`地方${index}`), [uf(`normal/VPWP50/地方${index}地方気象台`, `p${index}`)]));
    }
    // 最初の報から 134 秒。90 秒を過ぎても出ていない。
    expect(s.lines).toEqual([]);
    vi.advanceTimersByTime(7_000);
    expect(s.lines).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(s.lines.filter((text) => text.startsWith("━ "))).toEqual([band("気象警報・注意報時系列情報 58件", "11:00:00")]);
    await s.output.close();
  });
});

// ---- tips（layout13.test.ts の tip の形） ----
const tip = (text: string, columns: number): string[] =>
  terminal(columns, 0)([{ kind: "notice", notice: { kind: "tip", text }, prompt: null }]).map(plain);

describe("P3-TL15 tips の英数字の並び", () => {
  // P3-TL15-T04 acceptance / AC03
  it("T04 字の境目で折るとき、半角の英数字の並び（直前の開き括弧を含む）の途中で折らずに次の行へ送る", () => {
    // (a)
    expect(tip("Tip: 高温注意情報は翌日または当日の最高気温がおおむね35℃以上になると予想される場合に熱中症への注意を呼びかけていた情報です。", 56)).toEqual(["",
      "  Tip: 高温注意情報は翌日または当日の最高気温がおおむね", "    35℃以上になると予想される場合に熱中症への注意を呼び", "    かけていた情報です。"]);
    // (b)
    expect(tip("Tip: notify のカテゴリには短縮名が使えます。eq, tsu, st, nt, lgob, vc でそれぞれ earthquake, tsunami, seismicText, nankaiTrough, lgObservation, volcano を指定できます。", 56))
      .toEqual(["", "  Tip: notify のカテゴリには短縮名が使えます。", "  eq, tsu, st, nt, lgob, vc でそれぞれ earthquake,",
        "    tsunami, seismicText, nankaiTrough, lgObservation,", "    volcano を指定できます。"]);
    // (c) 開き括弧も送る
    expect(tip("Tip: 日本で記録されたマグニチュード最大の地震は2011年の東北地方太平洋沖地震(M9.0)です。", 80)).toEqual(["",
      "  Tip: 日本で記録されたマグニチュード最大の地震は2011年の東北地方太平洋沖地震", "    (M9.0)です。"]);
    // (d)
    const ansei = tip("Tip: 1854年の安政東海地震（M8.4）と安政南海地震（M8.4）は、32時間差で続いて発生しました。南海トラフ巨大地震は一度で終わるとは限らず、最初の大地震の後も次の発生に備える必要があります。", 56);
    expect(ansei[1].endsWith("安政南海地震")).toBe(true);
    expect(ansei[2]).toBe("    （M8.4）は、32時間差で続いて発生しました。");
    // (e) 2 つ目の折れ目にも並びの判定が当たる
    expect(tip("Tip: 指定河川洪水予報の標題は氾濫注意情報・氾濫警戒情報・氾濫危険情報・氾濫発生情報の4段階で、警戒レベル2〜5に対応します。", 56)).toEqual(["",
      "  Tip: 指定河川洪水予報の標題は氾濫注意情報・氾濫警戒情", "    報・氾濫危険情報・氾濫発生情報の4段階で、警戒レベル", "    2〜5に対応します。"]);
  });

  // P3-TL15-T05 contractBoundary / AC03 (3)
  it("T05 続きの行に入らない並びは送らず、今のとおり字の境目で折る", () => {
    expect(tip(`Tip: ${"a".repeat(70)} です。`, 56)).toEqual(["", `  Tip: ${"a".repeat(49)}`, `    ${"a".repeat(21)} です。`]);
  });
});
