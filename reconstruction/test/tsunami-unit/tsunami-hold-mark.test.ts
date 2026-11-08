import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ExecutionPlace } from "../../contracts/p3-execution-split.types";
import type { ClockReading, RestoreUnitResult, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { placeUnits, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import type { OwnerState, OwnerStep, ParserCompletion } from "../../src/runtime/owner-runtime";
import { receive as receiveUnit } from "./tsunami-fixture";

// P3-TSUNAMI-HOLD-MARK-001 の試験: U-T の hold で付けた未確認の印を、付けた受信の表示差分と views に載せる。

const at = (wallTimeMs: number): ClockReading => ({ wallTimeMs, monotonicMs: 0 });
const xmlOf = (name: string) => readFileSync(`test/fixtures/${name}.xml`, "utf8");
const corrected = (xml: string) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>");

let sequence = 0;
function input(xml: string, headType: string, receivedAt: number): ParserCompletion {
  const entered = ingestXmlData({ inputId: `hold-mark-${++sequence}`, inputSequence: sequence, receivedAt, origin: "replay", kind: "replay", headType,
    body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  return { runId: "run", inputId: entered.item.inputId, result: decodeMaterial(entered.item), headType, receivedAt };
}
function owner(place: ExecutionPlace, now: number): OwnerState {
  const restored: Partial<Record<RuntimeUnitId, RestoreUnitResult>> = {};
  for (const unit of placeUnits(place)) restored[unit] = { kind: "empty" };
  return restoreOwner({ runId: "run", place, clock: at(now), restored }, linkedUnitTable, linkedUnitCodecs).state;
}
const receive = (state: OwnerState, completion: ParserCompletion, now: number) => receiveOwner(state, completion, at(now), linkedUnitTable);
const unitT = (step: OwnerStep) => step.state.units["U-T"]!;
const viewT = (step: OwnerStep) => step.views.find((item) => item.unit === "U-T");

describe("P3-TSUNAMI-HOLD-MARK-001", () => {
  it("P3-THM-T01 acceptance / AC01,AC02,AC03: the hold mark reaches displayChanges and the same reply's views", () => {
    // 予報: 10:00 の版に、同じ Control/DateTime で InfoType を訂正にした写しが届く。
    const forecastAt = Date.parse("2011-03-11T15:00:00+09:00");
    const forecastXml = xmlOf("32-39_11_09_250206_VTSE41");
    // 観測: P3-C5-T03 の同じ報の fragment の食い違い（観測は late にならない fixture の時刻で受ける）。
    const observationAt = 1_299_823_320_000;
    const conflict = (xml: string) => xml.replace("<Station><Name>大船渡</Name><Code>21002</Code>", "<Station><Name>宮古</Name><Code>21001</Code>");
    for (const [kind, first, late, headType, now] of [
      ["forecasts", forecastXml, corrected(forecastXml), "VTSE41", forecastAt],
      ["observations", xmlOf("synthetic_VTSE51_fragmentA"), conflict(xmlOf("synthetic_VTSE51_fragmentB")), "VTSE51", observationAt],
    ] as const) {
      const before = receive(owner("urgent", now), input(first, headType, now), now);
      const lateInput = input(late, headType, now + 1);
      const held = receive(before.state, lateInput, now + 1);
      // 決定は unit の step で読む（owner の出力は決定を持たない）。
      const material = lateInput.result.kind === "decoded" ? lateInput.result.material : null;
      expect(material && receiveUnit(unitT(before), material, at(now + 1)).decisions).toMatchObject([{ decision: "unchanged", reason: "stale" }]);
      expect([held.outcomes.filter((item) => item.unit === "U-T"), unitT(held).intents.length]).toEqual([[], unitT(before).intents.length]);
      expect(held.diagnostics).toMatchObject([{ level: "WARN", reason: "tsunamiRevisionConflict", unit: "U-T" }]);
      expect(held.displayChanges).toHaveLength(1);
      const after = held.displayChanges[0].after;
      expect(after != null && after.unit === "U-T" && after.current?.unconfirmed?.inputId).toBe(lateInput.inputId);
      expect(unitT(held).contentRevision).toBe(unitT(before).contentRevision + 1);
      const view = viewT(held);
      expect(view?.unit === "U-T" ? view[kind] : null).toMatchObject([{ unconfirmed: { inputId: lateInput.inputId } }]);
    }
  });

  it("P3-THM-T02 contractBoundary / AC01 (3)(4): a repeated mark and a mark on an invisible record add no display change", () => {
    const forecastAt = Date.parse("2011-03-11T15:00:00+09:00");
    const forecastXml = xmlOf("32-39_11_09_250206_VTSE41");
    const marked = receive(receive(owner("urgent", forecastAt), input(forecastXml, "VTSE41", forecastAt), forecastAt).state,
      input(corrected(forecastXml), "VTSE41", forecastAt + 1), forecastAt + 1);
    // 同じ後着の写しの再送: 印は同じ版の鍵なので据え置き、state も変えない。
    const repeated = receive(marked.state, input(corrected(forecastXml), "VTSE41", forecastAt + 2), forecastAt + 2);
    expect([repeated.displayChanges, unitT(repeated).forecasts, unitT(repeated).contentRevision])
      .toEqual([[], unitT(marked).forecasts, unitT(marked).contentRevision]);

    // 初めから released で view に出ない記録（訓練の注意報の解除）: 印は state に入るが表示差分も view も出ない。
    const releasedAt = Date.parse("2018-12-04T19:30:00+09:00");
    const releasedXml = xmlOf("32-39_13_07_250206_VTSE41");
    const released = receive(owner("urgent", releasedAt), input(releasedXml, "VTSE41", releasedAt), releasedAt);
    const lateInput = input(corrected(releasedXml), "VTSE41", releasedAt + 1);
    const held = receive(released.state, lateInput, releasedAt + 1);
    expect(unitT(held).forecasts.map((item) => [item.effective, item.unconfirmed?.inputId])).toEqual([["released", lateInput.inputId]]);
    expect([held.displayChanges, unitT(held).contentRevision, viewT(held)]).toEqual([[], unitT(released).contentRevision, undefined]);
  });
});
