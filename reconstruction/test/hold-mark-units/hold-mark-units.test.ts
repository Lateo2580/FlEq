import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ExecutionPlace } from "../../contracts/p3-execution-split.types";
import type { ClockReading, RestoreUnitResult, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { placeUnits, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import type { OwnerState, OwnerStep, ParserCompletion } from "../../src/runtime/owner-runtime";
import { receive as receiveB } from "../briefing-unit/briefing-fixture";
import { receive as receiveR } from "../flood-unit/flood-fixture";
import { receive as receiveL } from "../landslide-unit/landslide-fixture";
import { receive as receiveM } from "../local-bulletins-unit/local-bulletins-fixture";
import { receive as receiveN } from "../nankai-unit/nankai-fixture";
import { receive as receiveY } from "../typhoon-unit/typhoon-fixture";

// P3-HOLD-MARK-UNITS-001 の試験: 6 unit の hold で付けた未確認の印を、付けた受信の表示差分と views に載せる（手本は P3-THM-T01・T02）。

const at = (wallTimeMs: number): ClockReading => ({ wallTimeMs, monotonicMs: 0 });
const xmlOf = (name: string) => readFileSync(`test/fixtures/${name}.xml`, "utf8");
const reportAt = (xml: string) => Date.parse(/<ReportDateTime>([^<]+)</.exec(xml)?.[1] ?? "");
const corrected = (xml: string) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>");

let sequence = 0;
function input(xml: string, headType: string, receivedAt: number): ParserCompletion {
  const entered = ingestXmlData({ inputId: `hold-mark-units-${++sequence}`, inputSequence: sequence, receivedAt, origin: "replay", kind: "replay", headType,
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

// 1 行 = 1 unit。own は印の付く記録の配列（U-N は現況と情報 subject）と contentRevision・intents、shown は同じ受信の views に出たその unit の記録。
type Own = Readonly<{ records: readonly unknown[]; contentRevision: number; intents: number }>;
type Row = Readonly<{ unit: RuntimeUnitId; place: ExecutionPlace; fixture: string; headType: string; own: (step: OwnerStep) => Own;
  shown: (step: OwnerStep) => readonly unknown[]; decide: (before: OwnerStep, material: DecodedMaterial, now: number) => readonly unknown[] }>;
const rows: readonly Row[] = [
  { unit: "U-R", place: "deferred", fixture: "16_02_01_220728_VXKO50", headType: "VXKO50",
    own: (step) => { const s = step.state.units["U-R"]!; return { records: s.currents, contentRevision: s.contentRevision, intents: s.intents.length }; },
    shown: (step) => step.views.flatMap((view) => view.unit === "U-R" ? view.currents : []),
    decide: (before, material, now) => receiveR(before.state.units["U-R"]!, material, at(now)).decisions },
  { unit: "U-L", place: "deferred", fixture: "15_16_01_241031_VPWW56", headType: "VPWW56",
    own: (step) => { const s = step.state.units["U-L"]!; return { records: s.currents, contentRevision: s.contentRevision, intents: s.intents.length }; },
    shown: (step) => step.views.flatMap((view) => view.unit === "U-L" ? view.currents : []),
    decide: (before, material, now) => receiveL(before.state.units["U-L"]!, material, at(now)).decisions },
  { unit: "U-B", place: "deferred", fixture: "phase6b_VPBS50_KJPTK202608221709_202608221709", headType: "VPBS50",
    own: (step) => { const s = step.state.units["U-B"]!; return { records: s.currents, contentRevision: s.contentRevision, intents: s.intents.length }; },
    shown: (step) => step.views.flatMap((view) => view.unit === "U-B" ? view.currents : []),
    decide: (before, material, now) => receiveB(before.state.units["U-B"]!, material, at(now)).decisions },
  { unit: "U-M", place: "deferred", fixture: "57_03_01_240401_VPFT50", headType: "VPFT50",
    own: (step) => { const s = step.state.units["U-M"]!; return { records: s.heat, contentRevision: s.contentRevision, intents: s.intents.length }; },
    shown: (step) => step.views.flatMap((view) => view.unit === "U-M" ? view.heat : []),
    decide: (before, material, now) => receiveM(before.state.units["U-M"]!, material, at(now)).decisions },
  { unit: "U-Y", place: "deferred", fixture: "10_05_01_200826_VPTW60", headType: "VPTW60",
    own: (step) => { const s = step.state.units["U-Y"]!; return { records: s.analysis, contentRevision: s.contentRevision, intents: s.intents.length }; },
    shown: (step) => step.views.flatMap((view) => view.unit === "U-Y" ? view.analysis : []),
    decide: (before, material, now) => receiveY(before.state.units["U-Y"]!, material, at(now)).decisions },
  { unit: "U-N", place: "urgent", fixture: "selected_xml/74_01_05_200512_VYSE50", headType: "VYSE50",
    own: (step) => { const s = step.state.units["U-N"]!;
      return { records: [...s.currents, ...s.information], contentRevision: s.contentRevision, intents: s.intents.length }; },
    shown: (step) => step.views.flatMap((view) => view.unit === "U-N" ? [...view.currents, ...view.information] : []),
    decide: (before, material, now) => receiveN(before.state.units["U-N"]!, material, at(now)).decisions },
];

// 手元の版を fixture の時刻で受け、同じ Control/DateTime で InfoType を訂正にした写しを 1 ms 後、もう 1 度を 2 ms 後に受ける。
function scenario(row: Row) {
  const xml = xmlOf(row.fixture), now = reportAt(xml);
  const before = receive(owner(row.place, now), input(xml, row.headType, now), now);
  const lateInput = input(corrected(xml), row.headType, now + 1);
  const held = receive(before.state, lateInput, now + 1);
  return { before, held, lateInput, now, repeated: receive(held.state, input(corrected(xml), row.headType, now + 2), now + 2) };
}

describe("P3-HOLD-MARK-UNITS-001", () => {
  it.each(rows.map((row, index) => [`P3-HMU-T0${index + 1}`, row] as const))(
    "%s acceptance / AC01,AC02,AC03: the hold mark reaches displayChanges and the same reply's views", (_, row) => {
      const { before, held, lateInput, now } = scenario(row);
      const material = lateInput.result.kind === "decoded" ? lateInput.result.material : null;
      const pairs = row.unit === "U-N" ? 2 : 1;
      // 決定は unit の step で読む（owner の出力は決定を持たない）。
      expect(material && row.decide(before, material, now + 1)).toEqual(Array(pairs).fill(expect.objectContaining({ decision: "unchanged", reason: "stale" })));
      expect([held.outcomes.filter((item) => item.unit === row.unit), row.own(held).intents]).toEqual([[], row.own(before).intents]);
      expect(held.displayChanges).toHaveLength(pairs);
      for (const change of held.displayChanges) {
        // before は印を付ける前の記録（直前の採用の after）。[null, 印つき] を積む実装を落とす。
        expect(change.before).toEqual(before.displayChanges.find((item) => item.subject === change.subject)?.after);
        expect(change.after).toMatchObject({ current: { unconfirmed: { inputId: lateInput.inputId } } });
      }
      expect(row.own(held).contentRevision).toBe(row.own(before).contentRevision + 1);
      expect(row.shown(held)).toEqual(Array(pairs).fill(expect.objectContaining({ unconfirmed: expect.objectContaining({ inputId: lateInput.inputId }) })));
    });

  it("P3-HMU-T07 contractBoundary / AC01 (2)(3), AC02 (3): a repeated mark and a mark on an invisible record add no display change", () => {
    // (1) 同じ後着の写しの再送: 印は同じ版の鍵なので据え置き、記録の配列と contentRevision を変えない。
    for (const row of rows) {
      const { held, repeated } = scenario(row);
      const { records, contentRevision } = row.own(held);
      expect([row.unit, repeated.displayChanges, row.own(repeated).records, row.own(repeated).contentRevision]).toEqual([row.unit, [], records, contentRevision]);
    }
    // (2) 初めから ended で view に出ない記録（P3-C14-T05 の endConflict と同じ記録）: 印は state に入るが表示差分も view も出ない。
    const xml = xmlOf("10_05_05_200826_VPTW61"), now = reportAt(xml);
    const ended = receive(owner("deferred", now), input(xml, "VPTW61", now), now);
    const lateInput = input(corrected(xml), "VPTW61", now + 1);
    const held = receive(ended.state, lateInput, now + 1);
    expect(held.state.units["U-Y"]?.analysis.map((item) => [item.effective, item.unconfirmed?.inputId])).toEqual([["ended", lateInput.inputId]]);
    expect([held.displayChanges, held.state.units["U-Y"]?.contentRevision, held.views.find((view) => view.unit === "U-Y")])
      .toEqual([[], ended.state.units["U-Y"]?.contentRevision, undefined]);
  });
});
