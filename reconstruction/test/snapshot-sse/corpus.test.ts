import { describe, expect, it } from "vitest";

import type { RuntimeDisplayChange, RuntimePublishedOutcome } from "../../contracts/p2-shared-runtime.types";
import type { SnapshotProjectionState } from "../../contracts/p2-snapshot-sse.types";
import { currentSubject } from "../../src/units/eew/eew-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import {
  atTime, combine, decode, eewReport, expectConsistent, expectMatchesReference, projected, projectionInput, received, reference, startup, step,
  timeseriesChange, unavailableChange,
} from "./projection-fixture";
import type { Step } from "./projection-fixture";

// sequences.json: each expected step's fixture, evaluatedAt and adopted subject/revision.
const cases = [
  { ref: "expected:O02:2", file: "81_02_01_260605_VPWP50_high_severity", type: "VPWP50", at: 1780650000000,
    key: "weatherTimeseries", subject: "normal/VPWP50/稚内地方気象台", time: "2026-06-05T17:00:00+09:00",
    severity: "specialWarning", areas: { forecastArea: 1 } },
  { ref: "expected:O02:14", file: "81_09_01_260605_VPWP50", type: "VPWP50", at: 1780693200001,
    key: "weatherTimeseries", subject: "normal/VPWP50/長野地方気象台", time: "2026-06-06T05:00:00+09:00",
    severity: "advisory", areas: { forecastArea: 81 } },
  { ref: "expected:O06:10", file: "15_16_02_251222_VPWW57", type: "VPWW57", at: 1592834400001,
    key: "weatherCurrent", subject: "normal/VPWW57/京都地方気象台", time: "2020-06-22T23:00:00+09:00",
    severity: "danger", areas: { prefecture: 1, primary: 1, municipalityGroup: 2, municipality: 5, stormSurge: 1 } },
  { ref: "expected:O07:16", file: "37_01_01_240613_VXSE43", type: "VXSE43", at: 1713363299001,
    key: "eew", subject: "normal/VXSE43/20240417231454", time: "2024-04-17T23:14:59+09:00",
    severity: "warning", areas: { eewArea: 9 } },
  { ref: "expected:O09:12", file: "77_01_01_240613_VXSE45", type: "VXSE45", at: 1713363297001,
    key: "eew", subject: "normal/VXSE45/20240417231454", time: "2024-04-17T23:14:57+09:00",
    severity: "forecast", areas: { eewArea: 0 } },
] as const;

function begin(at: number) {
  const clock = { wallTimeMs: at, monotonicMs: 1 };
  const started = startup(clock);
  return { clock, started, state: projected(projectSnapshot(projectionInput(started, at), null)).state };
}

function advance(state: SnapshotProjectionState, value: Step, at: number) {
  const result = projectSnapshot(projectionInput(value, at), state);
  expectConsistent(result.state, result.kind === "projected" ? result.snapshot : undefined,
    result.kind === "projected" ? result.utf8Bytes : undefined);
  expectMatchesReference(result.state, reference(value, at));
  return result;
}

describe("P2-A8-T05 corpusHistory (AC07/AC09)", () => {
  it.each(cases)("P2-A8-T05 $ref: the owner unit's adoption reaches its fixed row", (item) => {
    const { clock, started, state } = begin(item.at);
    const adopted = step(started.state, received("run", decode(item.file, item.type), clock));
    expect(adopted.displayChanges.map((change) => [change.subject, change.after?.subjects[0]?.source?.reportDateTimeRaw]))
      .toEqual([[item.subject, item.time]]);
    const result = projected(advance(state, adopted, item.at));
    const [normal, training, test] = result.snapshot.current[item.key].items;
    expect(normal).toMatchObject({ operation: "normal", activeCount: 1, highestSeverity: item.severity,
      areaCounts: item.areas, updatedAt: Date.parse(item.time), unconfirmed: { startup: 1 } });
    expect([training.activeCount, test.activeCount]).toEqual([0, 0]);
    // Notice targets: EEW first adoption only; W/F active adoption never creates a notice.
    expect(result.snapshot.notices.map((notice) => [notice.kind, notice.source?.family, notice.expiresAt - item.at]))
      .toEqual(item.key === "eew" ? [["eewNew", item.type, 15_000]] : []);
  });

  it("P2-A8-T05 / AC09: VXSE45→VXSE43 of one event upgrades to eewWarning, and 取消 retires it across families", () => {
    const at = 1713363299001;
    const { clock, started, state } = begin(at);
    const forecast = step(started.state, received("run", decode("77_01_01_240613_VXSE45", "VXSE45"), clock));
    const first = projected(advance(state, forecast, at));
    expect(first.snapshot.notices.map((item) => item.kind)).toEqual(["eewNew"]);
    const warning = step(forecast.state, received("run", decode("37_01_01_240613_VXSE43", "VXSE43"), clock));
    const upgraded = projected(advance(first.state, warning, at));
    expect(upgraded.snapshot.notices).toMatchObject([{ kind: "eewWarning", targetId: first.snapshot.notices[0].targetId,
      text: "緊急地震速報が警報に変わりました", source: { family: "VXSE43", office: null } }]);
    expect(upgraded.snapshot.current.eew.items[0]).toMatchObject({ activeCount: 1, highestSeverity: "warning" });
    const cancelled = step(warning.state, received("run", decode("37_01_03_240613_VXSE43", "VXSE43"), clock));
    expect(cancelled.state.units["U-E"].current.map((item) => item.family)).toEqual(["VXSE45"]);
    const retired = projected(advance(upgraded.state, cancelled, at));
    expect(retired.snapshot.notices).toEqual([]);
  });

  it("P2-A8-T05 / AC09: a family added to an existing warning event makes no new notice", () => {
    const at = 1713363299001;
    const { clock, started, state } = begin(at);
    const warning = step(started.state, received("run", decode("37_01_01_240613_VXSE43", "VXSE43"), clock));
    const first = projected(advance(state, warning, at));
    const added = step(warning.state, received("run", decode("77_01_01_240613_VXSE45", "VXSE45"), clock));
    expect(added.displayChanges).toHaveLength(1);
    const result = projected(advance(first.state, added, at));
    expect(result.snapshot.notices).toEqual(first.snapshot.notices);
    expect(result.snapshot.current.eew.items[0]).toMatchObject({ activeCount: 1, highestSeverity: "warning" });
  });

  it("P2-A8-T05 / AC09, P2-A8-T06 / AC06: forecast→warning with an unchanged prediction upgrades and moves the content version", () => {
    const at = 1713363297001;
    const { clock, started, state } = begin(at);
    const forecast = step(started.state, received("run", decode("77_01_01_240613_VXSE45", "VXSE45"), clock));
    const first = projected(advance(state, forecast, at));
    const before = forecast.state.units["U-E"].current[0];
    const after = { ...before, warningClass: "warning" as const };
    const view = forecast.state.views["U-E"];
    const change: RuntimeDisplayChange = { unit: "U-E", operation: "normal", subject: before.subject,
      before: { unit: "U-E", operation: "normal", subject: before.subject, office: null, current: before, subjects: [currentSubject(before)] },
      after: { unit: "U-E", operation: "normal", subject: before.subject, office: null, current: after, subjects: [currentSubject(after)] } };
    const outcome: RuntimePublishedOutcome = { unit: "U-E", outcome: { kind: "accepted", change: "semantic",
      subjects: [{ ...currentSubject(after), transition: "updated" }] } };
    const result = projected(projectSnapshot(projectionInput({ ...forecast, outcomes: [outcome], displayChanges: [change] }, at, {
      eew: { ...view, contentRevision: "99:0", subjects: [currentSubject(after)], current: [after] } }), first.state));
    expect(after.prediction).toBe(before.prediction);
    expect(result.snapshot.notices.map((item) => item.kind)).toEqual(["eewWarning"]);
    expect(result.snapshot.semanticRevision).not.toBe(first.snapshot.semanticRevision);
  });

  it("P2-A8-T05 / AC09: W/F notices only for active→unavailable; reason changes keep expiresAt; recovery or removal retires them", () => {
    const at = 1780650000000;
    const { clock, started, state } = begin(at);
    const adopted = combine(started.state, [received("run", decode("15_16_02_251222_VPWW57", "VPWW57"), clock),
      received("run", decode("81_02_01_260605_VPWP50_high_severity", "VPWP50"), clock)]);
    const first = projected(advance(state, adopted, at));
    expect(first.snapshot.notices).toEqual([]);
    const active = adopted.state.units["U-F"].subjects[0];
    const lostF = { ...active, effective: "unavailable" as const, unavailableReason: "capacityExceeded" as const,
      periods: [], validUntil: null, lastKnown: null };
    const w = unavailableChange(adopted.state, "京都地方気象台"), f = timeseriesChange(active, lostF);
    const lost = projected(projectSnapshot(projectionInput({ ...adopted, outcomes: [w.outcome, f.outcome],
      displayChanges: [w.change, f.change] }, at), first.state));
    expect(lost.snapshot.notices.map((item) => [item.unit, item.kind, item.text, item.expiresAt, item.source?.office]).sort())
      .toEqual([["U-F", "unavailable", "気象時系列情報を確認できません", at + 60_000, "稚内地方気象台"],
        ["U-W", "unavailable", "気象警報の現況を確認できません", at + 60_000, "京都地方気象台"]]);
    const reason = timeseriesChange(lostF, { ...lostF, unavailableReason: "historyUnavailable" });
    const replaced = projected(projectSnapshot(projectionInput({ ...adopted, outcomes: [reason.outcome],
      displayChanges: [reason.change] }, at + 10_000), lost.state));
    expect(replaced.snapshot.notices.map((item) => [item.unit, item.expiresAt]).sort())
      .toEqual([["U-F", at + 60_000], ["U-W", at + 60_000]]);
    // Branch 1: U-F normal adoption resolves its notice; U-W target removal (no outcome) reclaims its notice.
    const recoveredF = timeseriesChange({ ...lostF, unavailableReason: "historyUnavailable" }, active);
    const removedW = { ...w.change, before: w.change.after, after: null };
    const done = projected(projectSnapshot(projectionInput({ ...adopted, outcomes: [recoveredF.outcome],
      displayChanges: [recoveredF.change, removedW] }, at + 20_000), replaced.state));
    expect(done.snapshot.notices).toEqual([]);
    // Branch 2: U-W normal adoption (unavailable resolved, current kept) reclaims only the U-W notice.
    const recoveredW = { ...w.change, before: w.change.after, after: w.change.before };
    const partly = projected(projectSnapshot(projectionInput({ ...adopted, outcomes: [w.outcome],
      displayChanges: [recoveredW] }, at + 20_000), replaced.state));
    expect(partly.snapshot.notices.map((item) => item.unit)).toEqual(["U-F"]);
  });

  it("P2-A8-T05 / AC09: 取消 of a family with no current retires the event notice, also against a same-step new current", () => {
    const at = 1713363299001;
    const { clock, started, state } = begin(at);
    const forecast = step(started.state, received("run", decode("77_01_01_240613_VXSE45", "VXSE45"), clock));
    const first = projected(advance(state, forecast, at));
    expect(first.snapshot.notices.map((item) => item.kind)).toEqual(["eewNew"]);
    // VXSE43 never had a current here, so the cancel produces an outcome but no display change.
    const cancelled = step(forecast.state, received("run", decode("37_01_03_240613_VXSE43", "VXSE43"), clock));
    expect(cancelled.displayChanges).toEqual([]);
    expect(cancelled.outcomes).toMatchObject([{ unit: "U-E", outcome: { kind: "accepted", change: "semantic",
      subjects: [{ transition: "cancelled", facts: { eventId: "20240417231454" } }] } }]);
    expect(projected(advance(first.state, cancelled, at)).snapshot.notices).toEqual([]);
    // Same step: a new VXSE45 current and the VXSE43 取消 of that event; invalidation wins.
    const both = combine(started.state, [received("run", decode("77_01_01_240613_VXSE45", "VXSE45"), clock),
      received("run", decode("37_01_03_240613_VXSE43", "VXSE43"), clock)]);
    const raced = projected(advance(state, both, at));
    expect([raced.snapshot.notices, raced.snapshot.current.eew.items[0].activeCount]).toEqual([[], 1]);
  });

  it("P2-A8-T05 / AC09: a final report (released) of a family with no current retires the event notice", () => {
    const at = 1713363299001;
    const { clock, started, state } = begin(at);
    const warning = step(started.state, received("run", decode("37_01_01_240613_VXSE43", "VXSE43"), clock));
    const first = projected(advance(state, warning, at));
    expect(first.snapshot.notices.map((item) => item.kind)).toEqual(["eewNew"]);
    const final = step(warning.state, received("run", eewReport("20240417231454", "normal", "77_01_01_240613_VXSE45",
      (xml) => atTime(xml, "2024-04-17T23:15:30+09:00").replace("</Body>", "<NextAdvisory>この情報をもって、緊急地震速報：最終報とします。</NextAdvisory></Body>")), clock));
    expect(final.displayChanges).toEqual([]);
    expect(final.outcomes).toMatchObject([{ unit: "U-E", outcome: { kind: "accepted", subjects: [{ transition: "released" }] } }]);
    const result = projected(advance(first.state, final, at));
    expect([result.snapshot.notices, result.snapshot.current.eew.items[0].activeCount]).toEqual([[], 1]);
  });
});
