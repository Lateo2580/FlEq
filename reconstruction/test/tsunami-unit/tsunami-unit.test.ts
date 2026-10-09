import { describe, expect, it, vi } from "vitest";

import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type {
  TsunamiAreaClass, TsunamiForecastSubject, TsunamiIntent, TsunamiObservationSubject, TsunamiTransitionRecord, TsunamiUnitState,
  TsunamiUnitStep,
} from "../../contracts/p3-tsunami-unit.types";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { classifyHeadType, placeOfHeadType } from "../../src/runtime/unit-coverage";
import { toTsunamiView, tsunamiUnitCodec } from "../../src/units/tsunami/tsunami-unit";
import { clock, decodeFixture, decodeXml, emptyState, fixtureXml, observation, receive, run, vtse41 } from "./tsunami-fixture";

const EVENT = "20110311144640";
const SUBJECT = `normal/VTSE41/${EVENT}`;
const changed = (step: TsunamiUnitStep) => step.decisions[0];
const facts = (step: TsunamiUnitStep) => {
  const outcome = step.outcomes.find((item) => item.kind === "accepted");
  if (outcome?.kind !== "accepted") throw new Error("no accepted outcome");
  return outcome.subjects[0].facts;
};
const transitionsOf = (step: TsunamiUnitStep) => facts(step).areaTransitions as readonly TsunamiTransitionRecord[];
const forecast = (state: TsunamiUnitState, subject = SUBJECT) => state.forecasts.find((item) => item.subject === subject);

// P3-C5-E01-SERIES の期待を XML から独立に出す（Q-ENUM.kindTable と I-U-T.forecastSemantics の式）。
const RANK: Readonly<Record<string, number>> = { "52": 4, "53": 4, "51": 3, "62": 2, "71": 1, "72": 1, "73": 1, "50": 0, "60": 0, "00": 0 };
function bodyKinds(xml: string): Map<string, string> {
  const body = xml.slice(xml.indexOf("<Body"));
  return new Map([...body.matchAll(/<Area><Name>[^<]*<\/Name><Code>(\d{3})<\/Code><\/Area>\s*<Category>\s*<Kind><Name>[^<]*<\/Name><Code>(\d+)<\/Code>/g)]
    .map((match) => [match[1], match[2]]));
}
function expectedTransitions(before: Map<string, string>, after: Map<string, string>, wasActive: boolean): string[] {
  const result: string[] = [];
  for (const code of new Set([...after.keys(), ...before.keys()])) {
    const from = RANK[before.get(code) ?? "00"], to = RANK[after.get(code) ?? "00"];
    const transition = from === 0 ? to === 0 ? null : wasActive ? "expanded" : "issued" : to === 0 ? "released"
      : to > from ? "upgraded" : to < from ? "downgraded" : null;
    if (transition != null) result.push(`${code}:${transition}`);
  }
  return result.sort();
}

function intentsOf(subject: string, count: number, level: TsunamiIntent["payload"]["level"], from: number): TsunamiIntent[] {
  const operation = subject.startsWith("training") ? "training" : "normal";
  return Array.from({ length: count }, (_, index) => ({ id: `U-T:${subject}:seed${index}:desktop`, unit: "U-T", subject, operation,
    source: { inputId: `seed-${index}`, origin: "replay", operation, family: subject.includes("VTSE41") ? "VTSE41" : "VTSE51", subject,
      reportDateTimeRaw: "2099-01-01T09:00:00+09:00", serialRaw: "", infoTypeRaw: "発表" }, transition: "updated", channel: "desktop",
    payload: { domain: "tsunami", level, title: "試験", body: "試験" }, createdAt: from + index, expiresAt: from + index + 180_000,
    nextAttemptAt: from + index, attempts: 0, configRevision: "test", disposition: "pending" }));
}

describe("P3-TSUNAMI-UNIT-001 U-T reducer", () => {
  // contractBoundary: Q-ENUM の順と原子性、P3-C5-KIND-ENUM=B、coverage と実行場所（AC01）。
  it("P3-C5-T01 contractBoundary / AC01: first reason only, unchanged state, legal reduced forms and the U-T route", () => {
    const base = emptyState();
    const at = clock(Date.parse("2099-01-01T09:00:00+09:00"));
    const reject = (xml: string, headType: string) => {
      const step = receive(base, decodeXml(xml, headType), at);
      expect(step.state).toBe(base);
      expect(step.intents).toEqual([]);
      expect(step.diagnostics).toHaveLength(1);
      const decision = changed(step);
      return decision.decision === "rejected" ? decision.reason : decision.decision;
    };
    const area = (code: string, kind = "51") => ({ code, name: `区域${code}`, kind });
    const cases: [string, string, string][] = [
      [vtse41({ eventId: "", at: "2099-01-01T09:00:00+09:00", areas: [] }), "VTSE41", "identityMissing"],
      [vtse41({ eventId: "2099010100001", at: "2099-01-01T09:00:00+09:00", areas: [area("311")] }), "VTSE41", "identityInvalid"],
      [vtse41({ at: "2099-01-01T09:00:00+09:00", areas: [] }), "VTSE41", "requiredStructureMissing"],
      [vtse41({ at: "2099-01-01T09:00:00+09:00", areas: [area("311")] }).replace("<Code>51</Code></Kind>", "</Kind>"), "VTSE41", "requiredStructureMissing"],
      [vtse41({ at: "2099-01-01T09:00:00+09:00", areas: [area("31")] }), "VTSE41", "requiredStructureInvalid"],
      [vtse41({ at: "2099-01-01T09:00:00+09:00", areas: [area("311"), area("311", "62")] }), "VTSE41", "requiredStructureInvalid"],
      // 存在が妥当性より先（Q-ENUM.priorityRule）。
      [vtse41({ at: "2099-01-01T09:00:00+09:00", areas: [area("31"), area("312")] }).replace("<Code>51</Code></Kind></Category></Item></Forecast>",
        "</Kind></Category></Item></Forecast>"), "VTSE41", "requiredStructureMissing"],
      [fixtureXml("32-39_11_09_250206_VTSE41").replace(">10</jmx_eb:TsunamiHeight>", ">高い</jmx_eb:TsunamiHeight>"), "VTSE41", "requiredStructureInvalid"],
      [observation({ at: "2099-01-01T09:00:00+09:00", serial: 1, stations: [{ code: "21001" }] }).replace("<Serial>1</Serial>", "<Serial></Serial>"),
        "VTSE51", "identityMissing"],
      [observation({ at: "2099-01-01T09:00:00+09:00", serial: 1, stations: [{ code: "21001" }] }).replace("<Serial>1</Serial>", "<Serial>0</Serial>"),
        "VTSE51", "identityInvalid"],
      [observation({ at: "2099-01-01T09:00:00+09:00", serial: 1, stations: [{ code: "21001" }] }).replace("<Code>21001</Code>", ""), "VTSE51",
        "requiredStructureMissing"],
      [observation({ at: "2099-01-01T09:00:00+09:00", serial: 1, stations: [{ code: "21001" }, { code: "21001" }] }), "VTSE51", "requiredStructureInvalid"],
      [fixtureXml("61_11_01_250206_VTSE52").replace("<Area><Name>岩手県</Name><Code>210</Code></Area>", ""), "VTSE52", "requiredStructureInvalid"],
    ];
    expect(cases.map(([xml, headType]) => reject(xml, headType))).toEqual(cases.map(([, , reason]) => reason));

    // P3-C5-KIND-ENUM=B: 表外の Kind は unknown（警報と同じ重さ）、Area/Code の無い区域は unkeyedAreas。
    const unknown = receive(base, decodeXml(vtse41({ at: "2099-01-01T09:00:00+09:00", areas: [{ code: "311", name: "千葉県内房", kind: "99",
      kindName: "新しい区分" }] }), "VTSE41"), at);
    expect(forecast(unknown.state, "normal/VTSE41/20990101000011")).toMatchObject({ effective: "active",
      areas: [{ code: "311", areaClass: "unknown", kindName: "新しい区分" }] });
    expect(unknown.intents.map((item) => [item.payload.level, item.payload.title])).toEqual([["warning", "新しい区分"], ["warning", "新しい区分"]]);
    const unkeyed = receive(base, decodeXml(vtse41({ at: "2099-01-01T09:00:00+09:00", areas: [{ name: "名前だけの区域", kind: "51" }] }),
      "VTSE41"), at);
    expect(forecast(unkeyed.state, "normal/VTSE41/20990101000011")).toMatchObject({ effective: "active", areas: [],
      unkeyedAreas: [{ name: "名前だけの区域", kindCode: "51" }] });
    // 変化に数えないので緊急群に入らず normal（残った区分の段階）。
    expect(transitionsOf(unkeyed)).toEqual([]);
    expect(unkeyed.intents.map((item) => item.payload.level)).toEqual(["normal", "normal"]);
    // 取消の Body 縮退と VTSE52 の空 Area は合法。
    for (const [file, headType] of [["38-39_03_01_210805_VTSE41", "VTSE41"], ["38-39_03_03_210805_VTSE51", "VTSE51"],
      ["61_11_01_250206_VTSE52", "VTSE52"]] as const) {
      const material = decodeFixture(file, headType);
      expect(changed(receive(base, material, clock(Date.parse(material.reportDateTimeRaw)))).decision, file).toBe("changed");
    }

    for (const headType of ["VTSE41", "VTSE51", "VTSE52"]) {
      expect(classifyHeadType(headType)).toEqual({ status: "ready", unit: "U-T" });
      expect(placeOfHeadType(headType)).toBe("urgent");
    }
    // 一入力は U-T だけへ届き、U-E の state は同じ参照のまま。
    const owner = restoreOwner({ runId: "run", place: "urgent", clock: at, restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" }, "U-Q": { kind: "empty" },
      "U-N": { kind: "empty" } } },
      linkedUnitTable, linkedUnitCodecs).state;
    const material = decodeFixture("32-39_11_02_250206_VTSE41", "VTSE41");
    const routed = receiveOwner(owner, { runId: "run", inputId: material.inputId, result: { kind: "decoded", material } },
      clock(Date.parse(material.reportDateTimeRaw)), linkedUnitTable);
    expect(routed.changedUnits).toEqual(["U-T"]);
    expect(routed.state.units["U-E"]).toBe(owner.units["U-E"]);
  });

  // acceptance: I-U-T.forecastSemantics と Q-ENUM.revisionOrder（AC02・AC06）。
  it("P3-C5-T02 acceptance / AC02,AC06: real series, correction, cancellation, re-adoption, releases and operation isolation", () => {
    const xml = ["32-39_11_02_250206_VTSE41", "32-39_11_09_250206_VTSE41", "32-39_11_11_250206_VTSE41"].map(fixtureXml);
    const times = [1_299_822_540_001, 1_299_823_200_000, 1_299_823_920_000];
    const first = receive(emptyState(), decodeXml(xml[0], "VTSE41"), clock(times[0]));
    const classes = (state: TsunamiUnitState) => forecast(state)!.areas.reduce<Partial<Record<TsunamiAreaClass, number>>>((count, area) =>
      ({ ...count, [area.areaClass]: (count[area.areaClass] ?? 0) + 1 }), {});
    expect(classes(first.state)).toEqual({ majorWarning: 3, warning: 5, advisory: 15, forecast: 20 });
    expect(transitionsOf(first).map((item) => `${item.areaCode}:${item.transition}`).sort())
      .toEqual(expectedTransitions(new Map(), bodyKinds(xml[0]), false));
    expect(facts(first).series).toBe("escalation");
    expect(toTsunamiView(first.state).forecasts.map((item) => item.subject)).toEqual([SUBJECT]);
    expect(first.displayChanges).toMatchObject([{ unit: "U-T", subject: SUBJECT, before: null, after: { unit: "U-T", current: { effective: "active" } } }]);
    let state = first.state;
    for (const index of [1, 2]) {
      const step = receive(state, decodeXml(xml[index], "VTSE41"), clock(times[index]));
      expect(transitionsOf(step).map((item) => `${item.areaCode}:${item.transition}`).sort(), `report ${index}`)
        .toEqual(expectedTransitions(bodyKinds(xml[index - 1]), bodyKinds(xml[index]), true));
      // 報ごとに区域集合を置き換える（報に無い区域は none）。
      expect(forecast(step.state)!.areas.map((area) => area.code).sort()).toEqual([...bodyKinds(xml[index]).keys()].sort());
      if (index === 1) {
        expect(transitionsOf(step)).toEqual([{ areaCode: "201", from: "warning", to: "majorWarning", transition: "upgraded" }]);
        const correction = receive(step.state, decodeFixture("synthetic_VTSE41_correction", "VTSE41"), clock(times[1] + 1));
        expect(changed(correction)).toMatchObject({ decision: "changed", change: "semantic" });
        expect(facts(correction)).toMatchObject({ areaTransitions: [], series: "none" });
        expect(forecast(correction.state)!.areas.find((area) => area.code === "250")!.maxHeight?.value).toMatchObject({ value: 10 });
      }
      state = step.state;
    }
    const cancel = receive(state, decodeFixture("synthetic_VTSE41_cancel", "VTSE41"), clock(1_299_823_920_001));
    // 取消は ReportDateTime 15:05 で 15:12 の報より古いので stale。15:12 より新しい取消を作って確かめる。
    expect(changed(cancel)).toMatchObject({ decision: "unchanged", reason: "stale" });
    const later = (raw: string) => raw.replace("2011-03-11T15:05:00+09:00", "2011-03-11T15:20:00+09:00");
    const cancelled = receive(state, decodeFixture("synthetic_VTSE41_cancel", "VTSE41", later), clock(1_299_824_400_000));
    expect(forecast(cancelled.state)).toMatchObject({ effective: "cancelled", areas: [], unkeyedAreas: [] });
    expect(toTsunamiView(cancelled.state).forecasts).toEqual([]);
    expect(cancelled.displayChanges).toMatchObject([{ subject: SUBJECT, after: null }]);
    expect(changed(receive(cancelled.state, decodeFixture("32-39_11_11_250206_VTSE41", "VTSE41"), clock(1_299_824_400_001))))
      .toMatchObject({ decision: "unchanged", reason: "stale" });
    expect(changed(receive(cancelled.state, decodeFixture("synthetic_VTSE41_cancel", "VTSE41", later), clock(1_299_824_400_001))))
      .toMatchObject({ decision: "unchanged", reason: "duplicate" });
    // 取消より新しい報は直前を全区域 none として採用し直す。
    const reissued = receive(cancelled.state, decodeXml(xml[2].replace(/2011-03-11T15:12:00\+09:00/g, "2011-03-11T15:30:00+09:00"),
      "VTSE41"), clock(1_299_825_000_000));
    expect(forecast(reissued.state)!.effective).toBe("active");
    expect(new Set(transitionsOf(reissued).map((item) => item.transition))).toEqual(new Set(["issued"]));

    // 訓練（32-39_12_02）は別 subject。通常の subject は同じ参照のまま。
    const training = receive(state, decodeFixture("32-39_12_02_250206_VTSE41", "VTSE41"), clock(1_472_681_580_001));
    expect(forecast(training.state)).toBe(forecast(state));
    expect(training.state.forecasts.map((item) => item.subject)).toEqual([SUBJECT, "training/VTSE41/20160901071000"]);
    expect(training.intents.map((item) => item.channel)).toEqual(["desktop"]);

    // 降格だけでは active から外さない（P3-C5-AC02）。
    const issued = receive(emptyState(), decodeXml(vtse41({ at: "2099-01-01T09:00:00+09:00", areas: [{ code: "311", name: "千葉県内房", kind: "52" }] }),
      "VTSE41"), clock(4_070_908_800_000));
    const downgraded = receive(issued.state, decodeXml(vtse41({ at: "2099-01-01T09:10:00+09:00",
      areas: [{ code: "311", name: "千葉県内房", kind: "62" }] }), "VTSE41"), clock(4_070_909_400_000));
    expect(forecast(downgraded.state, "normal/VTSE41/20990101000011")!.effective).toBe("active");
    expect(facts(downgraded)).toMatchObject({ series: "deescalation",
      areaTransitions: [{ areaCode: "311", from: "majorWarning", to: "advisory", transition: "downgraded" }] });
    expect(downgraded.displayChanges).toMatchObject([{ after: { current: { effective: "active" } } }]);

    // 通常の解除（REST 本文の注意報解除）と訓練の解除: released は区域を保ち view に載せない。予報だけの再送は duplicate。
    for (const [file, operation] of [["test/fixtures/rest/telegram-body-vtse41-real.xml", "normal"], ["32-39_13_07_250206_VTSE41", "training"]] as const) {
      const material = decodeFixture(file, "VTSE41");
      const released = receive(emptyState(), material, clock(Date.parse(material.reportDateTimeRaw)));
      expect(released.state.forecasts).toMatchObject([{ operation, effective: "released" }]);
      expect(released.state.forecasts[0].areas.length).toBeGreaterThan(0);
      expect(toTsunamiView(released.state).forecasts).toEqual([]);
      expect(released.displayChanges).toEqual([]);
      expect(changed(receive(released.state, decodeFixture(file, "VTSE41"), clock(Date.parse(material.reportDateTimeRaw) + 1))))
        .toMatchObject({ decision: "unchanged", reason: "duplicate" });
    }
  });

  // corpusHistory: O05 の全 step と同じ revision の食い違い（AC03・AC10）。
  it("P3-C5-T03 corpusHistory / AC03,AC10: O05 every step, fragment order, same-station correction and conflicting fragment", () => {
    const results = replay("O05", 1, 19);
    const stations = (state: TsunamiUnitState, family: "VTSE51" | "VTSE52") => state.observations
      .find((item) => item.family === family)!.stations;
    // results[i] は position i + 1 の結果。
    expect(stations(results[2].state, "VTSE52").map((item) => item.code).sort()).toEqual(["21050", "21090", "21091"]);
    expect(stations(results[2].state, "VTSE51").map((item) => item.code).sort()).toEqual(["20102", "21001", "21002", "21003", "22002"]);
    // ForecastのstationをObservationと混同しない: 32-39_11_10 の Forecast にだけある 20101 は無い。
    expect(stations(results[2].state, "VTSE51").some((item) => item.code === "20101")).toBe(false);
    expect(stations(results[2].state, "VTSE51").find((item) => item.code === "21003")!.maxHeight)
      .toMatchObject({ condition: "重要", height: { value: { kind: "number", value: 3.2 }, condition: "上昇中" } });
    for (const [aThenB, bThenA, family] of [[5, 9, "VTSE51"], [13, 17, "VTSE52"]] as const) {
      const strip = (state: TsunamiUnitState) => stations(state, family).map((item) => ({ ...item, revision: null }))
        .sort((left, right) => left.code.localeCompare(right.code));
      expect(strip(results[bThenA].state)).toEqual(strip(results[aThenB].state));
      // 訂正は同じ station を 1 点のまま更新し、他の station を落とさない。
      const correctedAt = aThenB + 1;
      const before = stations(results[aThenB].state, family), after = stations(results[correctedAt].state, family);
      expect(after.map((item) => item.code).sort()).toEqual(before.map((item) => item.code).sort());
      const target = family === "VTSE51" ? "21003" : "21090";
      expect(after.find((item) => item.code === target)).toMatchObject(family === "VTSE51"
        ? { areaCode: "220", areaName: "宮城県", revision: { infoTypeRaw: "訂正" } } : { areaCode: "210", areaName: "岩手県" });
      expect(after.filter((item) => item.code !== target)).toEqual(before.filter((item) => item.code !== target));
    }
    // 同じ revision・同じ InfoType で同じ station の値が違えば入力全体を stale にして診断を残す（部分合成しない）。
    const fragmentA = decodeFixture("synthetic_VTSE51_fragmentA", "VTSE51");
    const merged = receive(emptyState(), fragmentA, clock(1_299_823_320_000)).state;
    const conflicting = receive(merged, decodeFixture("synthetic_VTSE51_fragmentB", "VTSE51", (xml) => xml
      .replace("<Station><Name>大船渡</Name><Code>21002</Code>", "<Station><Name>宮古</Name><Code>21001</Code>")),
    clock(1_299_823_320_001));
    expect(changed(conflicting)).toMatchObject({ decision: "unchanged", reason: "stale" });
    expect(conflicting.state).toBe(merged);
    expect(conflicting.diagnostics).toMatchObject([{ level: "WARN", reason: "tsunamiRevisionConflict", unit: "U-T" }]);
    // family 独立: VTSE51 の採用は VTSE52 の watermark を変えない。
    const vtse52 = results[1].state.observations.find((item) => item.family === "VTSE52");
    expect(results[2].state.observations.find((item) => item.family === "VTSE52")).toBe(vtse52);
  });

  // contractBoundary: P3-C5-CAPACITY=A の 4 つの上限、退去の順、normal の保護、計算量（AC04）。
  it("P3-C5-T04 contractBoundary / AC04: 511/512/513 subjects, 1023/1024/1025 stations, 4 MiB, eviction order and no whole-state encode", () => {
    const at = clock(4_070_908_800_000);
    const seed = forecast(receive(emptyState(), decodeXml(vtse41({ at: "2099-01-01T09:00:00+09:00",
      areas: [{ code: "311", name: "千葉県内房", kind: "51" }] }), "VTSE41"), at).state, "normal/VTSE41/20990101000011")!;
    const clone = (index: number, patch: Partial<TsunamiForecastSubject> = {}): TsunamiForecastSubject => {
      const operation = patch.operation ?? "normal";
      const eventId = String(20980101000000 + index);
      const subject = `${operation}/VTSE41/${eventId}`;
      return { ...seed, eventId, subject, operation, source: { ...seed.source, subject, operation,
        reportDateTimeRaw: new Date(Date.parse("2098-01-01T00:00:00Z") + index * 1000).toISOString() }, ...patch };
    };
    const withForecasts = (forecasts: readonly TsunamiForecastSubject[]): TsunamiUnitState => ({ ...emptyState(), forecasts });
    const report = (eventId: string, operation: "normal" | "training" = "normal") => decodeXml(vtse41({ eventId, operation,
      at: "2099-01-01T09:00:00+09:00", areas: [{ code: "311", name: "千葉県内房", kind: "51" }] }), "VTSE41");
    // 511 → 512 は収まり、512 の normal active に 513 件目の normal は capacityExceeded（state・nextDeadline 不変、結果は空）。
    const full = withForecasts(Array.from({ length: 512 }, (_, index) => clone(index)));
    expect(changed(receive(withForecasts(full.forecasts.slice(1)), report("20990101000001"), at)).decision).toBe("changed");
    const refused = receive(full, report("20990101000001"), at);
    expect(changed(refused)).toMatchObject({ decision: "capacityExceeded", rejection: { family: "VTSE41", affectedScope: "subject" } });
    expect(refused.state).toBe(full);
    expect(refused.nextDeadline).toBeNull();
    expect([refused.intents, refused.outcomes, refused.diagnostics, refused.displayChanges]).toEqual([[], [], [], []]);
    // training の受理は normal を退去させない。
    expect(changed(receive(full, report("20990101000002", "training"), at)).decision).toBe("capacityExceeded");
    // 退去の順: (1) 期限切れの非 active → (2) 最古の非 active → (3) training/test の active。候補は同じ種類だけ。
    let state = withForecasts([...Array.from({ length: 509 }, (_, index) => clone(index + 10)),
      clone(900, { effective: "released", retainUntil: at.wallTimeMs - 1 }), clone(1, { effective: "released", retainUntil: at.wallTimeMs + 1 }),
      clone(0, { operation: "training" })]);
    const evicted: string[] = [];
    for (const eventId of ["20990101000003", "20990101000004", "20990101000005"]) {
      const before = new Set(state.forecasts.map((item) => item.subject));
      const step = receive(state, report(eventId), at);
      expect(step.diagnostics).toEqual([{ level: "INFO", component: "tsunami", reason: "tsunamiCapacityEvicted", unit: "U-T", count: 1 }]);
      state = step.state;
      evicted.push(...[...before].filter((subject) => !state.forecasts.some((item) => item.subject === subject)));
    }
    expect(evicted).toEqual([clone(900).subject, clone(1).subject, "training/VTSE41/20980101000000"]);
    expect(changed(receive(state, report("20990101000006"), at)).decision).toBe("capacityExceeded");

    // 観測 subject は family ごと 512。VTSE52 の数は VTSE51 の上限に数えない。
    const obsSeed = receive(emptyState(), decodeXml(observation({ at: "2099-01-01T09:00:00+09:00", serial: 1,
      stations: [{ code: "21001" }] }), "VTSE51"), at).state.observations[0];
    const obsClone = (index: number, family: "VTSE51" | "VTSE52", patch: Partial<TsunamiObservationSubject> = {}): TsunamiObservationSubject => {
      const eventId = String(20980101000000 + index);
      const operation = patch.operation ?? "normal";
      const subject = `${operation}/tsunamiObservation:${family}/${eventId}`;
      return { ...obsSeed, eventId, subject, family, operation, source: { ...obsSeed.source, subject, family, operation }, ...patch };
    };
    const observations = [...Array.from({ length: 511 }, (_, index) => obsClone(index, "VTSE51")),
      obsClone(600, "VTSE51", { effective: "cancelled", stations: [], validUntil: null, retainUntil: at.wallTimeMs + 1 }),
      ...Array.from({ length: 512 }, (_, index) => obsClone(index, "VTSE52"))];
    const observed = receive({ ...emptyState(), observations }, decodeXml(observation({ eventId: "20990101000007", at: "2099-01-01T09:00:00+09:00",
      serial: 1, stations: [{ code: "21002" }] }), "VTSE51"), at);
    expect(observed.diagnostics).toMatchObject([{ reason: "tsunamiCapacityEvicted", count: 1 }]);
    expect(observed.state.observations.some((item) => item.subject === obsClone(600, "VTSE51").subject)).toBe(false);
    expect(observed.state.observations.filter((item) => item.family === "VTSE52")).toHaveLength(512);

    // station は family ごと 1024（三区分合算）。1024 は収まり 1025 は normal なら capacityExceeded。
    const stations = (count: number, from = 0) => Array.from({ length: count }, (_, index) => ({ code: String(30000 + from + index) }));
    const stationReport = (count: number, eventId = "20990101000008", operation: "normal" | "training" = "normal", from = 0) =>
      decodeXml(observation({ eventId, operation, at: "2099-01-01T09:00:00+09:00", serial: 1, stations: stations(count, from) }), "VTSE51");
    expect(receive(emptyState(), stationReport(1023), at).state.observations[0].stations).toHaveLength(1023);
    expect(receive(emptyState(), stationReport(1024), at).state.observations[0].stations).toHaveLength(1024);
    expect(changed(receive(emptyState(), stationReport(1025), at)).decision).toBe("capacityExceeded");
    // 超過量を減らすのは同じ family の station を持つ観測 subject だけ（training の active を退去）。
    const trainingStations = receive(emptyState(), stationReport(1000, "20990101000009", "training", 5000), at).state;
    const pushed = receive(trainingStations, stationReport(25), at);
    expect(pushed.state.observations.map((item) => item.operation)).toEqual(["normal"]);
    expect(pushed.diagnostics).toMatchObject([{ reason: "tsunamiCapacityEvicted", count: 1 }]);

    // 4 MiB/世代: byte の超過は全 subject が候補。normal だけで超えるなら capacityExceeded。
    const wide = (index: number, operation: "normal" | "training") => clone(index, { operation,
      areas: Array.from({ length: 1000 }, (_, code) => ({ ...seed.areas[0], code: String(code).padStart(3, "0"), name: "区".repeat(40) })) });
    const count = Math.ceil(4_194_304 / Buffer.byteLength(JSON.stringify(wide(0, "normal"))));
    const pressed = receive(withForecasts(Array.from({ length: count }, (_, index) => wide(index, index === 0 ? "training" : "normal"))),
      report("20990101000010"), at);
    expect(pressed.diagnostics).toMatchObject([{ reason: "tsunamiCapacityEvicted", count: 1 }]);
    expect(pressed.state.forecasts.some((item) => item.operation === "training")).toBe(false);
    const normalHeavy = withForecasts(Array.from({ length: count }, (_, index) => wide(index, "normal")));
    expect(changed(receive(normalHeavy, report("20990101000010"), at)).decision).toBe("capacityExceeded");

    // 受信 1 回で state 全体（配列ごと）を直列化しない。直列化は新しい subject・intent の分だけ。
    receive(normalHeavy, report("20990101000010"), at);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      receive(normalHeavy, report("20990101000010"), at);
      const whole = new Set<unknown>([normalHeavy, normalHeavy.forecasts, normalHeavy.observations, normalHeavy.intents]);
      expect(stringify.mock.calls.filter(([value]) => whole.has(value) || normalHeavy.forecasts.includes(value as TsunamiForecastSubject)))
        .toEqual([]);
    } finally { stringify.mockRestore(); }
  });

  // contractBoundary: I-U-T.persisted・I-U-T.decode、復元で intent を作らない（AC05）。
  it("P3-C5-T05 contractBoundary / AC05: one codec, persisted fields only, every decode check and restore without new intents", () => {
    const first = receive(emptyState(), decodeFixture("32-39_11_02_250206_VTSE41", "VTSE41"), clock(1_299_822_540_001));
    const both = receive(first.state, decodeFixture("32-39_11_10_250206_VTSE51", "VTSE51"), clock(1_299_823_260_000)).state;
    const payload = JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(both))) as JsonValue;
    expect(Object.keys(payload as object).sort()).toEqual(["forecasts", "intents", "observations", "schemaVersion"]);
    const decoded = tsunamiUnitCodec.decode(payload);
    expect(decoded).toEqual({ kind: "restored", state: { ...both, contentRevision: 0, persistence: { kind: "saved", currentGeneration: 0,
      savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } } });
    const value = payload as { forecasts: Record<string, unknown>[]; observations: Record<string, unknown>[]; intents: Record<string, unknown>[] };
    const area0 = (value.forecasts[0].areas as Record<string, unknown>[])[0];
    const measuredStation = (value.observations[0].stations as { maxHeight: { height: object | null } }[])
      .find((item) => item.maxHeight.height != null)!;
    const invalid: [string, unknown][] = [
      ["schemaVersion", { ...value, schemaVersion: "p3-tsunami-unit-v0" }],
      ["VTSE41 > 512", { ...value, forecasts: Array.from({ length: 513 }, (_, index) => ({ ...value.forecasts[0],
        eventId: String(20980101000000 + index), subject: `normal/VTSE41/${20980101000000 + index}`,
        source: { ...(value.forecasts[0].source as object), subject: `normal/VTSE41/${20980101000000 + index}` } })) }],
      ["duplicate subject", { ...value, forecasts: [value.forecasts[0], value.forecasts[0]] }],
      ["duplicate area code", { ...value, forecasts: [{ ...value.forecasts[0], areas: [area0, area0] }] }],
      ["areaClass and kindCode", { ...value, forecasts: [{ ...value.forecasts[0], areas: [{ ...area0, areaClass: "advisory" }] }] }],
      ["cancelled keeps areas", { ...value, forecasts: [{ ...value.forecasts[0], effective: "cancelled" }] }],
      ["intent of another unit", { ...value, intents: [{ ...value.intents[0], unit: "U-E" }] }],
      ["intent subject form", { ...value, intents: [{ ...value.intents[0], subject: "normal/VXSE43/20110311144640",
        source: { ...(value.intents[0].source as object), subject: "normal/VXSE43/20110311144640" } }] }],
      ["stations > 1024", { ...value, observations: [{ ...value.observations[0], stations: Array.from({ length: 1025 }, (_, index) =>
        ({ ...(value.observations[0].stations as Record<string, unknown>[])[0], code: String(40000 + index) })) }] }],
      ["pending > 128", { ...value, intents: Array.from({ length: 129 }, (_, index) => ({ ...value.intents[0], id: `pending-${index}` })) }],
      ["expired keeps stations", { ...value, observations: [{ ...value.observations[0], effective: "expired", retainUntil: 1 }] }],
      ["infoTypeRaw outside INFO_RANK", { ...value, forecasts: [{ ...value.forecasts[0], source: { ...(value.forecasts[0].source as object),
        infoTypeRaw: "不明" } }] }],
      ["observation serialRaw not positive", { ...value, observations: [{ ...value.observations[0],
        source: { ...(value.observations[0].source as object), serialRaw: "0" } }] }],
      ["station height kind", { ...value, observations: [{ ...value.observations[0], stations: [{ ...measuredStation,
        maxHeight: { ...measuredStation.maxHeight, height: { ...measuredStation.maxHeight.height, value: { kind: "text", value: "高い", raw: "高い" } } } }] }] }],
    ];
    for (const [name, candidate] of invalid) expect(tsunamiUnitCodec.decode(candidate as JsonValue).kind, name).toBe("invalid");
    // 容量退去の直後でも intent の subject が state に無いことは unavailable の理由にしない（I-U-T.decode）。
    expect(tsunamiUnitCodec.decode({ ...value, forecasts: [], observations: [] } as JsonValue).kind).toBe("restored");

    const restored = run(emptyState(), { kind: "restore", persisted: tsunamiUnitCodec.encode(both), clock: clock(1_299_823_260_001) });
    expect(restored.intents).toEqual([]);
    expect(restored.state.intents).toEqual(both.intents.filter((item) => item.expiresAt > 1_299_823_260_001));
    expect(restored.state.intents.every((item) => both.intents.some((original) => original.id === item.id
      && original.createdAt === item.createdAt && original.expiresAt === item.expiresAt))).toBe(true);
  });

  // acceptance: Q-NOTICE の津波分（AC07）。
  it("P3-C5-T06 acceptance / AC07: opportunities, level formula, overlap, replacement, capacity, intentUpdate, observation, training, recovery", () => {
    const at = (minute: number) => clock(4_070_908_800_000 + minute * 60_000, minute);
    const raw = (minute: number) => new Date(4_070_908_800_000 + minute * 60_000).toISOString().replace(".000Z", "Z");
    const send = (state: TsunamiUnitState, minute: number, areas: readonly { code: string; kind: string }[],
      options: { infoType?: "発表" | "訂正" | "取消"; eventId?: string; operation?: "normal" | "training" } = {}) =>
      receive(state, decodeXml(vtse41({ at: raw(minute), ...options, areas: areas.map((area) => ({ ...area, name: `区域${area.code}` })) }),
        "VTSE41"), at(minute));
    const levels = (step: TsunamiUnitStep) => step.intents.map((item) => `${item.channel}:${item.payload.level}`);
    // 発令の段階: 大津波警報 critical、津波警報 warning、注意報 normal、予報だけ info（直前が active でない released の題は津波予報）。
    expect(levels(send(emptyState(), 0, [{ code: "311", kind: "52" }]))).toEqual(["desktop:critical", "sound:critical"]);
    expect(levels(send(emptyState(), 0, [{ code: "311", kind: "51" }]))).toEqual(["desktop:warning", "sound:warning"]);
    expect(levels(send(emptyState(), 0, [{ code: "311", kind: "62" }]))).toEqual(["desktop:normal", "sound:normal"]);
    const forecastOnly = send(emptyState(), 0, [{ code: "311", kind: "71" }]);
    expect(forecastOnly.intents.map((item) => [item.payload.level, item.payload.title])).toEqual([["info", "津波予報"], ["info", "津波予報"]]);
    const issued = send(emptyState(), 0, [{ code: "311", kind: "51" }, { code: "312", kind: "51" }]);
    expect(issued.intents.map((item) => [item.expiresAt - item.createdAt, item.createdAt, item.nextAttemptAt]))
      .toEqual([[180_000, at(0).wallTimeMs, at(0).wallTimeMs], [60_000, at(0).wallTimeMs, at(0).wallTimeMs]]);
    // 警報中に予報区域だけが増える報: info と残った区分 normal の大きい方で normal、緊急群に入らない。
    const expanded = send(issued.state, 1, [{ code: "311", kind: "51" }, { code: "312", kind: "51" }, { code: "320", kind: "71" }]);
    expect(transitionsOf(expanded)).toEqual([{ areaCode: "320", from: "none", to: "forecast", transition: "expanded" }]);
    expect(levels(expanded)).toEqual(["desktop:normal", "sound:normal"]);
    // 警報 A の解除と B の継続: 解除系、残った区分 normal。
    const partial = send(issued.state, 1, [{ code: "311", kind: "60" }, { code: "312", kind: "51" }]);
    expect(facts(partial).series).toBe("deescalation");
    expect(levels(partial)).toEqual(["desktop:normal", "sound:normal"]);
    // 上げと下げが混ざる報は mixed（E01 の標本にしない）で、段階は上がった区域の到達先。
    const mixed = send(issued.state, 1, [{ code: "311", kind: "52" }, { code: "312", kind: "60" }]);
    expect([facts(mixed).series, levels(mixed)]).toEqual(["mixed", ["desktop:critical", "sound:critical"]]);
    // 全区域の解除は info。訂正は機会を足さず接頭辞だけ。
    const released = send(issued.state, 1, [{ code: "311", kind: "60" }, { code: "312", kind: "60" }]);
    expect(released.intents.map((item) => [item.payload.level, item.transition])).toEqual([["info", "released"], ["info", "released"]]);
    // 直前が active の released は予報区域が残っていても解除の題。解除の後の予報だけの続報は津波予報の題。
    const releasedWithForecast = send(issued.state, 1, [{ code: "311", kind: "71" }, { code: "312", kind: "60" }]);
    expect(releasedWithForecast.intents.map((item) => item.payload.title)).toEqual(["津波警報・注意報の解除", "津波警報・注意報の解除"]);
    expect(send(releasedWithForecast.state, 2, [{ code: "311", kind: "71" }]).intents.map((item) => item.payload.title))
      .toEqual(["津波予報", "津波予報"]);
    const corrected = send(issued.state, 0, [{ code: "311", kind: "51" }, { code: "312", kind: "51" }], { infoType: "訂正" });
    expect(corrected.intents.map((item) => [item.payload.level, item.payload.title, item.payload.body.startsWith("訂正: ")]))
      .toEqual([["normal", "[訂正] 津波警報", true], ["normal", "[訂正] 津波警報", true]]);

    // 置換（P3-C5-REPLACEMENT=A）: 下位群の続報は緊急の pending を置き換えず、同群以上は置き換える。取消は全 pending。
    const pending = (state: TsunamiUnitState) => state.intents.filter((item) => item.disposition === "pending")
      .map((item) => `${item.channel}:${item.payload.level}`);
    const continued = send(issued.state, 1, [{ code: "311", kind: "51" }, { code: "312", kind: "51" }]);
    expect(pending(continued.state)).toEqual(["desktop:warning", "sound:warning", "desktop:normal", "sound:normal"]);
    const raised = send(continued.state, 2, [{ code: "311", kind: "52" }, { code: "312", kind: "51" }]);
    expect(pending(raised.state)).toEqual(["desktop:critical", "sound:critical"]);
    expect(raised.state.intents.filter((item) => item.disposition === "superseded")).toHaveLength(4);
    const cancel = send(continued.state, 3, [], { infoType: "取消" });
    expect(cancel.intents.map((item) => [item.payload.level, item.payload.title, item.payload.body]))
      .toEqual([["cancel", "[取消] 津波警報・注意報・予報", "この情報は取り消されました"], ["cancel", "[取消] 津波警報・注意報・予報", "この情報は取り消されました"]]);
    expect(pending(cancel.state)).toEqual(["desktop:cancel", "sound:cancel"]);
    // active でなかった subject の取消は通知しない。
    expect(send(emptyState(), 3, [], { infoType: "取消" }).intents).toEqual([]);

    // 満杯（128 件）: 緊急は下位群を A7 の選択順の逆で退去して収まる。同群以上は退去しない。
    const lowerFull = { ...emptyState(), intents: intentsOf("training/VTSE41/20980101000001", 128, "info", at(0).wallTimeMs) };
    const admitted = send(lowerFull, 0, [{ code: "311", kind: "52" }]);
    expect(admitted.intents).toHaveLength(2);
    expect(admitted.diagnostics).toEqual([{ level: "INFO", component: "tsunami", reason: "notificationCapacityEvicted", unit: "U-T", count: 2 }]);
    expect(admitted.state.intents.filter((item) => item.disposition === "superseded").map((item) => item.id))
      .toEqual([lowerFull.intents[126].id, lowerFull.intents[127].id]);
    const sameFull = { ...emptyState(), intents: intentsOf("normal/VTSE41/20980101000001", 128, "critical", at(0).wallTimeMs) };
    const refused = send(sameFull, 0, [{ code: "311", kind: "52" }]);
    expect([refused.intents, refused.state.intents.filter((item) => item.disposition === "pending")]).toEqual([[], sameFull.intents]);
    expect(refused.diagnostics).toMatchObject([{ reason: "notificationCapacityEvicted", count: 2 }]);

    // intentUpdate: 既存 id だけを一括で更新し、保存世代を 1 つ進める。未知 id・同値は no-op。
    const [desktop] = issued.intents;
    const updated = run(issued.state, { kind: "intentUpdate", clock: at(0), intentUpdate: [{ id: desktop.id, attempts: 1,
      nextAttemptAt: at(0).wallTimeMs + 1_000, disposition: "pending" }, { id: "unknown", attempts: 1, nextAttemptAt: 0, disposition: "delivered" }] });
    expect(updated.state.persistence.currentGeneration).toBe(issued.state.persistence.currentGeneration + 1);
    expect(updated.decisions).toMatchObject([{ decision: "changed", change: "deliveryOnly" }]);
    expect(run(updated.state, { kind: "intentUpdate", clock: at(0), intentUpdate: { id: desktop.id, attempts: 1,
      nextAttemptAt: at(0).wallTimeMs + 1_000, disposition: "pending" } }).state).toBe(updated.state);

    // 観測は警報中でも info で desktop＋sound（緊急群に入らない）。training/test は desktop だけ。
    const warning = receive(emptyState(), decodeFixture("32-39_11_02_250206_VTSE41", "VTSE41"), clock(1_299_822_540_001));
    const observed = receive(warning.state, decodeFixture("32-39_11_10_250206_VTSE51", "VTSE51"), clock(1_299_823_260_000));
    expect(observed.intents.map((item) => [item.channel, item.payload.level, item.payload.title]))
      .toEqual([["desktop", "info", "津波観測に関する情報"], ["sound", "info", "津波観測に関する情報"]]);
    const training = send(emptyState(), 0, [{ code: "311", kind: "52" }], { operation: "training" });
    expect(training.intents.map((item) => [item.channel, item.payload.title, item.payload.body.split("\n")[0]]))
      .toEqual([["desktop", "【訓練】大津波警報", "訓練の電文です。通常運用の警報ではありません。"]]);
    // origin=recovery は C16 の候補採用まで適用しない（Q-NOTICE.recovery）。
    const recovery = receive(warning.state, decodeXml(fixtureXml("32-39_11_09_250206_VTSE41"), "VTSE41", "recovered", "recovery"), clock(1_299_823_200_000));
    expect(recovery.state).toBe(warning.state);
    expect(recovery.decisions).toMatchObject([{ decision: "unchanged", reason: "noChange" }]);
    expect([recovery.intents, recovery.outcomes]).toEqual([[], []]);
  });

  // corpusHistory: O09 の意味部、O01:61〜67、O07:27〜34、E13（AC10）。
  it("P3-C5-T09 corpusHistory / AC10: O09:14-16/20, O01:61-67, O07:27-34 and the E13 population", () => {
    // O09:17・18 は C6 の母集団の入力で unmet のまま（Q-C5-CORPUS (4)）。
    const o09 = replay("O09", 13, 16);
    replay("O09", 19, 20);
    const xml = ["32-39_11_02_250206_VTSE41", "32-39_11_09_250206_VTSE41", "32-39_11_11_250206_VTSE41"].map((file) => bodyKinds(fixtureXml(file)));
    const series = (list: readonly string[]) => {
      const up = list.some((item) => /issued|expanded|upgraded/.test(item)), down = list.some((item) => /downgraded|released/.test(item));
      return up ? down ? "mixed" : "escalation" : down ? "deescalation" : "none";
    };
    expect(o09.slice(1).map((step) => facts(step).series)).toEqual([series(expectedTransitions(new Map(), xml[0], false)),
      series(expectedTransitions(xml[0], xml[1], true)), series(expectedTransitions(xml[1], xml[2], true))]);
    const o01 = replay("O01", 61, 67);
    // O01:63 の時点で :62 の pending は残らない（:63 の合成時計は :62 の 11 分後で、TTL 180 秒を過ぎて受信前に回収される）。
    // :65 の取消は同じ subject の pending を全部置き換える。
    expect(o01[2].state.intents.filter((item) => item.disposition === "pending" && o01[1].intents.some((old) => old.id === item.id)))
      .toEqual([]);
    expect(o01[4].state.intents.filter((item) => item.disposition === "pending").map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
    const o07 = replay("O07", 27, 34);
    // 復元したstateとの差で決める: 続報は continuation の normal で、同じ発令を再び critical にしない。
    expect(o07[4].intents.map((item) => item.payload.level)).toEqual(["normal", "normal"]);
    expect(o07[7].intents.map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
    // E13: 全正常の津波 fixture を空の state から受ける。恒常的な unavailable は U-T に無い。観測の無い VTSE51（各地の満潮時刻・
    // 津波到達予想時刻に関する情報）は noChange の別群（Q-ENUM の VTSE51.legalMissing。state・intent・outcome・診断なし）。
    const groups: Record<string, string[]> = { changed: [], noChange: [] };
    for (const fixture of manifest.fixtures) {
      const headType = fixture.transport.headType;
      if (headType == null || !/^VTSE(41|51|52)$/.test(headType) || !fixture.path.endsWith(".xml")) continue;
      const material = decodeFixture(fixture.path, headType);
      const base = emptyState();
      const step = receive(base, material, clock(Date.parse(material.reportDateTimeRaw)));
      const decision = changed(step);
      if (decision.decision === "changed") groups.changed.push(fixture.fixtureId);
      else if (decision.decision === "unchanged" && decision.reason === "noChange" && step.state === base
        && [step.intents, step.outcomes, step.diagnostics, step.displayChanges].every((list) => list.length === 0))
        groups.noChange.push(fixture.fixtureId);
      else throw new Error(`${fixture.fixtureId}: ${JSON.stringify(decision)}`);
    }
    expect(groups.noChange.sort()).toEqual(["test__fixtures__32-39_11_03_250206_VTSE51", "test__fixtures__38-39_02_02_250206_VTSE51"]);
    expect(groups.changed).toHaveLength(26);
  });

  // contractBoundary: 期限の境界（P3-C5-SEM-01・02、I-U-T.deadlines、AC02・AC03）。
  it("P3-C5-T12 contractBoundary / AC02,AC03: 24 h observation, forecastEnded first, 7-day retention and not-due deadlines", () => {
    const material = decodeFixture("61_11_01_250206_VTSE52", "VTSE52");
    const reported = Date.parse(material.reportDateTimeRaw);
    const adopted = receive(emptyState(), material, clock(reported)).state;
    const quiet = run(adopted, { kind: "deadline", clock: clock(reported + 180_000) }).state;
    expect(quiet.intents).toEqual([]);
    const notDue = run(quiet, { kind: "deadline", clock: clock(reported + 86_400_000 - 60_000) });
    expect(notDue.state).toBe(quiet);
    expect([notDue.decisions, notDue.outcomes, notDue.displayChanges, notDue.intents]).toEqual([[], [], [], []]);
    const expired = run(quiet, { kind: "deadline", clock: clock(reported + 86_400_000) });
    expect(expired.state.observations).toMatchObject([{ effective: "expired", stations: [], estimations: [],
      retainUntil: reported + 86_400_000 + 604_800_000 }]);
    expect(expired.outcomes).toMatchObject([{ kind: "deadlineApplied" }]);
    expect(expired.displayChanges).toMatchObject([{ after: null }]);
    expect(run(expired.state, { kind: "deadline", clock: clock(reported + 86_400_000 + 604_800_000 - 1) }).state).toBe(expired.state);
    expect(run(expired.state, { kind: "deadline", clock: clock(reported + 86_400_000 + 604_800_000) }).state.observations).toEqual([]);

    // VTSE41 の非 active 化が先: 観測は forecastEnded（stations を保ち view から外す）、retainUntil は VTSE41 から写す。
    const warning = receive(emptyState(), decodeXml(vtse41({ eventId: "20110311144640", at: "2011-03-11T14:49:00+09:00",
      areas: [{ code: "210", name: "岩手県", kind: "52" }] }), "VTSE41"), clock(reported)).state;
    const watched = receive(warning, decodeFixture("61_11_01_250206_VTSE52", "VTSE52"), clock(reported)).state;
    const releasedAt = reported + 600_000;
    const release = receive(watched, decodeXml(vtse41({ eventId: "20110311144640", at: "2011-03-11T15:00:00+09:00",
      areas: [{ code: "210", name: "岩手県", kind: "50" }] }), "VTSE41"), clock(releasedAt));
    expect(release.state.observations).toMatchObject([{ effective: "forecastEnded", retainUntil: releasedAt + 604_800_000,
      stations: watched.observations[0].stations }]);
    expect(toTsunamiView(release.state).observations).toEqual([]);
    expect(release.displayChanges.map((item) => item.after)).toEqual([null, null]);
    // 解除の後に届いた観測は採用して watermark を進めるが、表示も通知もしない（P3-C5-OBS-LIFETIME=A）。
    const late = receive(release.state, decodeFixture("61_11_02_250206_VTSE52", "VTSE52"), clock(releasedAt + 1));
    expect(late.state.observations[0]).toMatchObject({ effective: "forecastEnded", source: { serialRaw: "2" } });
    expect([late.intents, late.displayChanges]).toEqual([[], []]);
    // 24 時間を過ぎても forecastEnded は失効させず、VTSE41 と同じ 7 日で回収する。
    const day = run(late.state, { kind: "deadline", clock: clock(reported + 86_400_000) }).state;
    expect(day.observations[0].effective).toBe("forecastEnded");
    expect(run(day, { kind: "deadline", clock: clock(releasedAt + 604_800_000 - 1) }).state.forecasts).toHaveLength(1);
    const reclaimed = run(day, { kind: "deadline", clock: clock(releasedAt + 604_800_000) }).state;
    expect([reclaimed.forecasts, reclaimed.observations]).toEqual([[], []]);
    // 解除の後の再発表で forecastEnded の観測は active に戻る（validUntil を過ぎていれば expired）。
    const reissue = (minutesAfter: number) => receive(late.state, decodeXml(vtse41({ eventId: "20110311144640", at: "2011-03-11T15:30:00+09:00",
      areas: [{ code: "210", name: "岩手県", kind: "51" }] }), "VTSE41"), clock(reported + minutesAfter * 60_000)).state.observations[0].effective;
    expect([reissue(30), reissue(24 * 60 + 10)]).toEqual(["active", "expired"]);
  });
});

// sequences.json の履歴 oracle（expected:<seq>:<position>）を step ごとに照合する。save と restart は codec を通す。
function replay(sequenceId: string, from: number, to: number): TsunamiUnitStep[] {
  const sequence = corpus.sequences.find((item) => item.sequenceId === sequenceId)!;
  const expectations = new Map(corpus.expectations.map((item) => [item.expectedId, item]));
  let state = emptyState();
  let saved: Readonly<{ payload: JsonValue; generation: number }> | null = null;
  const steps: TsunamiUnitStep[] = [];
  for (const step of sequence.steps.filter((item) => item.position >= from && item.position <= to)) {
    const expected = expectations.get(step.expectedRef)!;
    const label = step.expectedRef;
    if (step.action === "save") {
      saved = { payload: JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(state))) as JsonValue,
        generation: state.persistence.currentGeneration };
      steps.push({ ...run(state, { kind: "deadline", clock: clock(step.evaluatedAt) }), state });
      continue;
    }
    if (step.action === "restart") {
      const restored = saved == null ? null : tsunamiUnitCodec.decode(saved.payload);
      // owner と同じく、復元した世代を persistence に置いてから restore を入れる（restoreOwner）。
      const persistence = { kind: "saved" as const, currentGeneration: saved?.generation ?? 0, savedGeneration: saved?.generation ?? 0,
        savedCapturedAt: step.evaluatedAt, savedAckAt: null, dirtySince: null };
      const next = restored?.kind === "restored" ? run({ ...emptyState(), persistence }, { kind: "restore",
        persisted: tsunamiUnitCodec.encode(restored.state), clock: clock(step.evaluatedAt) }) : null;
      if (restored != null) expect(restored.kind, label).toBe("restored");
      if (next != null) expect(next.intents, label).toEqual([]);
      state = next?.state ?? emptyState();
      saved = null;
      steps.push(next ?? run(state, { kind: "deadline", clock: clock(step.evaluatedAt) }));
      continue;
    }
    const fixture = manifest.fixtures.find((item) => item.fixtureId === step.fixtureId)!;
    // owner と同じく、受信の前に到来した期限を回収する（reclaimDeadlineBeforeReceive）。
    state = run(state, { kind: "deadline", clock: clock(step.receivedAt!) }).state;
    const result = receive(state, decodeFixture(fixture.path, fixture.transport.headType!), clock(step.receivedAt!));
    steps.push(result);
    const decision = result.decisions[0];
    if (expected.decision != null) expect({ kind: decision.decision, ...("change" in decision ? { change: decision.change } : {}),
      ...(decision.decision === "unchanged" ? { reason: decision.reason } : {}) }, label).toEqual(expected.decision);
    const subject = expected.subjects[0];
    if (expected.decision != null && subject != null) {
      expect(decision.subject, label).toBe(subject.subject);
      const current = [...result.state.forecasts, ...result.state.observations].find((item) => item.subject === subject.subject)!;
      const source = decision.decision === "changed" ? current.source : null;
      if (source != null) expect({ reportDateTimeRaw: source.reportDateTimeRaw, infoTypeRaw: source.infoTypeRaw,
        ...(subject.revision.serialRaw == null ? {} : { serialRaw: source.serialRaw }) }, label).toEqual({
        reportDateTimeRaw: subject.revision.reportDateTimeRaw, infoTypeRaw: subject.revision.infoTypeRaw,
        ...(subject.revision.serialRaw == null ? {} : { serialRaw: subject.revision.serialRaw }) });
      const effective = current.effective === "active" ? { kind: "active" }
        : { kind: "inactive", cause: { kind: current.effective === "cancelled" ? "cancelled" : "released" } };
      if (expected.effective != null) expect(effective, label).toEqual(expected.effective);
    }
    if (expected.intents != null) expect(result.intents.length > 0, label).toBe(expected.intents);
    if (expected.notices != null) expect(result.intents.length > 0, label).toBe(expected.notices);
    state = result.state;
  }
  return steps;
}
