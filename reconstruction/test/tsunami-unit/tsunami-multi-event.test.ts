import { describe, expect, it } from "vitest";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { intentUpdateOwner, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { terminalReport } from "../../src/terminal/material";
import { decodeFixture as decodeTerminal, reportUnit, terminal } from "../terminal/terminal-fixture";
import { clock, decodeFixture, emptyState, receive } from "./tsunami-fixture";

// P4-TSUNAMI-MULTI-EVENT-001。津波の Head/EventID は、寄与する地震が 2 つ以上あると番号を空白で並べる（解説資料の共通別紙イ 3.・出現例 6）。
// 並びの先頭の番号を記録の鍵にする（P4-TME-D-IDENTITY=A）。
const FIRST = "20151114055157", PAIR = `${FIRST} 20151114061750`;
const file = (n: number, type: "VTSE41" | "VTSE51") => `38-39_02_0${n}_250206_${type}`;
const at = (material: DecodedMaterial) => clock(Date.parse(material.reportDateTimeRaw));
const empty = () => restoreOwner({ runId: "run", place: "urgent", clock: clock(0), restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
  "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
type Owner = ReturnType<typeof empty>;
const feed = (state: Owner, material: DecodedMaterial): Owner => receiveOwner(state, { runId: "run", inputId: material.inputId,
  result: { kind: "decoded", material } }, at(material), linkedUnitTable).state;
const records = (state: Owner) => state.units["U-T"]!.forecasts.map((item) => [item.subject, item.effective] as const);
const unreadable = (state: Owner) => [state.unreadable["U-T"]?.length ?? 0,
  state.units["U-T"]!.intents.filter((item) => item.subject === "normal/unreadable").length];
const withEvent = (id: string) => (xml: string) => xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${id}</EventID>`);
// 取消（_04 より後の時刻）。替えるのは EventID と時刻の要素だけ。
const cancelOf = (id: string) => decodeFixture("38-39_03_01_210805_VTSE41", "VTSE41", (xml) => withEvent(id)(xml)
  .replace("2021-08-05T03:56:58Z", "2015-11-13T22:25:00Z").replace(/2021-08-05T12:56:00\+09:00/g, "2015-11-14T07:25:00+09:00"));

// 受入条件 P4-TME-AC01・AC02（corpus 履歴）: 公式サンプルの 2015-11-14 の列。
describe("P4-TME-T01 corpus 履歴", () => {
  it("_01〜_05 を順に受けると、並びの報が先頭の番号の記録に続き、解除で注意報が消え、読めない報が増えない", () => {
    let state = empty();
    const steps = [[1, "VTSE41"], [2, "VTSE51"], [3, "VTSE51"], [4, "VTSE41"], [5, "VTSE51"]] as const;
    const seen = steps.map(([n, type]) => {
      state = feed(state, decodeFixture(file(n, type), type));
      return { forecasts: records(state), unreadable: unreadable(state) };
    });
    const f = `normal/VTSE41/${FIRST}`, o = `normal/tsunamiObservation:VTSE51/${FIRST}`;
    expect(seen.map((step) => step.unreadable)).toEqual(Array(5).fill([0, 0]));
    expect(seen[0].forecasts).toEqual([[f, "active"]]);
    expect(seen[2].forecasts).toEqual([[f, "active"]]);
    expect(seen[3].forecasts).toEqual([[f, "released"]]);
    expect(state.units["U-T"]!.forecasts.flatMap((item) => item.areas.map((area) => [area.code, area.areaClass]))
      .sort()).toEqual([["771", "released"], ["772", "released"], ["773", "released"]]);
    const observations = state.units["U-T"]!.observations;
    expect(observations.map((item) => [item.subject, item.effective])).toEqual([[o, "forecastEnded"]]);
    expect(state.units["U-T"]!.forecasts.filter((item) => item.effective === "active")).toEqual([]);
  });
});

// 契約境界 P4-TME-AC03: 番号 1 つの記録は、並びを持つ取消 1 通で消える。通知の条件は今のまま。
describe("P4-TME-T02 取消", () => {
  const first = () => feed(empty(), decodeFixture(file(1, "VTSE41"), "VTSE41"));
  const cancelsOf = (state: Owner) => state.units["U-T"]!.intents.filter((item) => item.transition === "cancelled").length;
  const record = (state: Owner) => state.units["U-T"]!.forecasts[0];
  const tried = (state: Owner) => intentUpdateOwner(state, "U-T", state.units["U-T"]!.intents.map((item) => ({ ...item, attempts: 1,
    lastAttempt: "started" as const, lossReason: null })), clock(0), linkedUnitTable).state;
  const released = (state: Owner) => feed(state, decodeFixture(file(4, "VTSE41"), "VTSE41"));
  it("(i) 発表の直後・(ii) 試みた印のある解除の後は通知し、(iii) 試みていない解除の後は通知しない。どれも区域 0 件の cancelled", () => {
    const rows = [[feed(first(), cancelOf(PAIR)), 2], [feed(released(tried(first())), cancelOf(PAIR)), 2], [feed(released(first()), cancelOf(PAIR)), 0]] as const;
    for (const [state, notified] of rows) {
      expect([record(state).subject, record(state).effective, record(state).areas.length, cancelsOf(state)])
        .toEqual([`normal/VTSE41/${FIRST}`, "cancelled", 0, notified]);
    }
  });
});

// 契約境界 P4-TME-AC01・AC04（P4-TME-D-FORMAT=A）: 区切りは xs:list の空白だけ。
describe("P4-TME-T03 並びの区切り", () => {
  // reducer を直に呼ぶ（owner は断った報を読めない報のカードにするので、同じ参照は reducer で見る）。
  const through = (id: string) => {
    const before = emptyState();
    const material = decodeFixture(file(4, "VTSE41"), "VTSE41", withEvent(id));
    return { before, after: receive(before, material, at(material)).state };
  };
  it("13 桁・カンマ・全角スペースの区切りは identityInvalid で state は同じ参照、改行の区切りは先頭の番号の記録になる", () => {
    for (const bad of [`${FIRST} 2015111406175`, `${FIRST},20151114061750`, `${FIRST}　20151114061750`]) {
      const { before, after } = through(bad);
      expect(after).toBe(before);
    }
    expect(through(`${FIRST}\n20151114061750`).after.forecasts.map((item) => [item.subject, item.effective])).toEqual([[`normal/VTSE41/${FIRST}`, "released"]]);
  });
});

// 契約境界 P4-TME-AC06: 端末の続報の覚えのキーも先頭の番号。
describe("P4-TME-T04 端末の続報の覚え", () => {
  const unit = (n: number, type: "VTSE41" | "VTSE51", transform?: (xml: string) => string) => {
    const report = terminalReport(decodeTerminal(`${file(n, type)}.xml`, "replay", transform), "U-T");
    if (report == null) throw new Error(file(n, type));
    return reportUnit(report);
  };
  const raiseToWarning = (xml: string) => xml.replace(/<Name>津波注意報解除<\/Name>\s*<Code>60<\/Code>/g, "<Name>津波警報</Name><Code>51</Code>");
  const cancel = (xml: string) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>");
  it("A の注意報の後の「A B」の警報に引き上げの行が出て末尾の EventID は字のまま、「A B」の取消の後は出ない", () => {
    // 端末は 1 つ（覚えを持つ）で続けて出す。
    const print = terminal();
    print([unit(1, "VTSE41")]);
    const lines = print([unit(4, "VTSE41", raiseToWarning)]);
    expect(lines.some((line) => line.startsWith("津波警報に引き上げ  "))).toBe(true);
    expect(lines.some((line) => line.includes(PAIR))).toBe(true);
    const after = terminal();
    after([unit(1, "VTSE41")]);
    after([unit(4, "VTSE41", (xml) => cancel(raiseToWarning(xml)))]);
    expect(after([unit(4, "VTSE41", raiseToWarning)]).some((line) => line.includes("引き上げ"))).toBe(false);
  });
});
