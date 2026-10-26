import { describe, expect, it, vi } from "vitest";

import { expectRestoreStarted } from "../notice-ledger/notice-fixture";
import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type {
  TsunamiAreaClass, TsunamiForecastSubject, TsunamiIntent, TsunamiObservationSubject, TsunamiTransitionRecord, TsunamiUnitState,
  TsunamiUnitStep,
} from "../../contracts/p3-tsunami-unit.types";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import { CheckpointCoordinator, INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, hashEnvelope, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import { deliveryGrowth } from "../../src/notification-delivery/delivery-growth";
import { PENDING_MARK_BYTES } from "../../src/units/expiry";
import { UNREADABLE_CARDS_MAX_BYTES, unreadableMarkBytes } from "../../src/units/unreadable";
import { withLongestMarks } from "../unreadable-mark/longest-mark";
import { linkedUnitCodecs, linkedUnitTable, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { capturedOwner, checkpointResultOwner, intentUpdateOwner, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { selectNotificationAttempt } from "../../src/notification-delivery/notification-delivery";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnitTable } from "../../contracts/p3-unit-table.types";
import type { OwnerReply } from "../../contracts/p3-execution-split.types";
import type { CheckpointFileSystem } from "../../src/checkpoint/checkpoint";
import { OwnerHost } from "../../src/runtime/owner-host";
import { envelope } from "../execution-split/owner-harness";
import type { NotificationAttempt } from "../../contracts/p2-notification-delivery.types";
import { classifyHeadType, placeOfHeadType } from "../../src/runtime/unit-coverage";
import { toTsunamiView, tsunamiUnitCodec } from "../../src/units/tsunami/tsunami-unit";
import { freshState } from "../../src/units/notice-mark";
import { versionKey } from "../../src/contracts-revision/version";
import { clock, decodeFixture, decodeXml, emptyState, fixtureXml, observation, receive, run, sentLater, vtse41 } from "./tsunami-fixture";

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
      reportDateTimeRaw: "2099-01-01T09:00:00+09:00", controlDateTimeRaw: "2099-01-01T00:00:00Z", serialRaw: "", infoTypeRaw: "発表" }, transition: "updated", channel: "desktop",
    payload: { domain: "tsunami", level, title: "試験", body: "試験" }, createdAt: from + index, expiresAt: from + index + 180_000,
    nextAttemptAt: from + index, attempts: 0, configRevision: "test", disposition: "pending", ...freshState("U-T", operation, level === "warning" || level === "critical") }));
}

// 実 byte が 131,072 ちょうどで、配送の更新の予約を足すと超える pending（P3-IUR-AC01）。
function reserveOver(intent: Record<string, unknown>): Record<string, unknown>[] {
  const make = (index: number, pad: number) => ({ ...intent, id: `fit-${index}`, disposition: "pending",
    payload: { ...(intent.payload as Record<string, unknown>), body: "x".repeat(1 + pad) } });
  const items = Array.from({ length: 64 }, (_, index) => make(index, 0));
  items[0] = make(0, 131_072 - Buffer.byteLength(JSON.stringify(items)));
  if (Buffer.byteLength(JSON.stringify(items)) !== 131_072) throw new Error("pending is not 131,072 bytes");
  return items;
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
      "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } },
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
        // corpus の訂正は元の報と Control/DateTime が同じなので、後の送信にして新しい版として受ける（P3-VM-AC03）。
        const correction = receive(step.state, decodeFixture("synthetic_VTSE41_correction", "VTSE41", sentLater), clock(times[1] + 1));
        expect(changed(correction)).toMatchObject({ decision: "changed", change: "semantic" });
        expect(facts(correction)).toMatchObject({ areaTransitions: [], series: "none" });
        expect(forecast(correction.state)!.areas.find((area) => area.code === "250")!.maxHeight?.value).toMatchObject({ value: 10 });
      }
      state = step.state;
    }
    const cancel = receive(state, decodeFixture("synthetic_VTSE41_cancel", "VTSE41"), clock(1_299_823_920_001));
    // 取消は ReportDateTime 15:05 で 15:12 の報より古いので stale。15:12 より新しい取消を作って確かめる。
    expect(changed(cancel)).toMatchObject({ decision: "unchanged", reason: "stale" });
    const later = (raw: string) => raw.replace("2011-03-11T15:05:00+09:00", "2011-03-11T15:20:00+09:00")
      .replace("2011-03-11T06:05:00Z", "2011-03-11T06:20:00Z");
    const cancelled = receive(state, decodeFixture("synthetic_VTSE41_cancel", "VTSE41", later), clock(1_299_824_400_000));
    expect(forecast(cancelled.state)).toMatchObject({ effective: "cancelled", areas: [], unkeyedAreas: [] });
    expect(toTsunamiView(cancelled.state).forecasts).toEqual([]);
    expect(cancelled.displayChanges).toMatchObject([{ subject: SUBJECT, after: null }]);
    expect(changed(receive(cancelled.state, decodeFixture("32-39_11_11_250206_VTSE41", "VTSE41"), clock(1_299_824_400_001))))
      .toMatchObject({ decision: "unchanged", reason: "stale" });
    expect(changed(receive(cancelled.state, decodeFixture("synthetic_VTSE41_cancel", "VTSE41", later), clock(1_299_824_400_001))))
      .toMatchObject({ decision: "unchanged", reason: "duplicate" });
    // 取消より新しい報は直前を全区域 none として採用し直す。
    const reissued = receive(cancelled.state, decodeXml(sentLater(xml[2].replace(/2011-03-11T15:12:00\+09:00/g, "2011-03-11T15:30:00+09:00"),
      18 * 60), "VTSE41"), clock(1_299_825_000_000));
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
      // corpus の訂正（O05:7・:15）は元の報と Control/DateTime が同じで、手元の値を残して印を付ける（P3-VM-D-SAMETIME=A）。
      const before = stations(results[aThenB].state, family);
      expect(stations(results[aThenB + 1].state, family)).toEqual(before);
      // 後の送信の訂正は新しい版で、同じ station を 1 点のまま更新し、他の station を落とさない。
      const correction = family === "VTSE51" ? "synthetic_VTSE51_correction" : "synthetic_VTSE52_correction";
      const after = stations(receive(results[aThenB].state, decodeFixture(correction, family, sentLater), clock(1_299_823_320_001)).state, family);
      expect(after.map((item) => item.code).sort()).toEqual(before.map((item) => item.code).sort());
      const target = family === "VTSE51" ? "21003" : "21090";
      expect(after.find((item) => item.code === target)).toMatchObject(family === "VTSE51"
        ? { areaCode: "220", areaName: "宮城県", revision: { infoTypeRaw: "訂正" } } : { areaCode: "210", areaName: "岩手県" });
      expect(after.filter((item) => item.code !== target)).toEqual(before.filter((item) => item.code !== target));
    }
    // 同じ revision・同じ InfoType で同じ station の値が違えば入力全体を stale にして診断を残す（部分合成しない）。値は先の報のまま、
    // 系列に未確認の印を付ける（P3-VM-AC03）。
    const fragmentA = decodeFixture("synthetic_VTSE51_fragmentA", "VTSE51");
    const merged = receive(emptyState(), fragmentA, clock(1_299_823_320_000)).state;
    const fragmentB = decodeFixture("synthetic_VTSE51_fragmentB", "VTSE51", (xml) => xml
      .replace("<Station><Name>大船渡</Name><Code>21002</Code>", "<Station><Name>宮古</Name><Code>21001</Code>"));
    const conflicting = receive(merged, fragmentB, clock(1_299_823_320_001));
    expect(changed(conflicting)).toMatchObject({ decision: "unchanged", reason: "stale" });
    const { unconfirmed, ...kept } = conflicting.state.observations[0];
    expect([kept, unconfirmed?.inputId]).toEqual([merged.observations[0], fragmentB.inputId]);
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
    // 511 → 512 は収まり、512 の normal active に 513 件目の normal は capacityExceeded（記録は不変で結果は空）。
    // P3-CC-AC10・AC07: 新しい subject には印を付けず、拒否した津波警報の段階の失敗警報と capacityRejected の 1 行だけが入る。
    const full = withForecasts(Array.from({ length: 512 }, (_, index) => clone(index)));
    expect(changed(receive(withForecasts(full.forecasts.slice(1)), report("20990101000001"), at)).decision).toBe("changed");
    const refused = receive(full, report("20990101000001"), at);
    expect(changed(refused)).toMatchObject({ decision: "capacityExceeded" });
    expect(refused.state.forecasts).toBe(full.forecasts);
    expect(refused.intents.map((item) => [item.subject, item.payload.level, item.channel])).toEqual([
      ["normal/capacityRejected", "warning", "desktop"], ["normal/capacityRejected", "warning", "sound"]]);
    expect([refused.outcomes, refused.displayChanges]).toEqual([[], []]);
    expect(refused.diagnostics.map((item) => item.reason)).toEqual(["capacityRejected"]);
    // training の受理は normal を退去させない。
    expect(changed(receive(full, report("20990101000002", "training"), at)).decision).toBe("capacityExceeded");
    // 監査 F04-T（P3-OPCAP-AC01）: normal の取消の記憶は training の受理で退去せず、取消より古い報は stale のまま。training は退去できる。
    const cancelled = clone(1, { effective: "cancelled", areas: [], unkeyedAreas: [], retainUntil: at.wallTimeMs + 1 });
    const memory = { ...cancelled, source: { ...cancelled.source, reportDateTimeRaw: "2099-01-01T09:00:01+09:00" } };
    const normals = Array.from({ length: 510 }, (_, index) => clone(index + 10));
    const kept = withForecasts([memory, clone(9), ...normals]);
    const trainingRefused = receive(kept, report("20990101000002", "training"), at);
    // 記録は退去しない（P3-CC-AC10: 入るのは training の失敗警報だけ）。
    expect([changed(trainingRefused).decision, trainingRefused.state.forecasts === kept.forecasts]).toEqual(["capacityExceeded", true]);
    expect(changed(receive(kept, report(memory.eventId), at))).toMatchObject({ decision: "unchanged", reason: "stale" });
    const drill = clone(2, { operation: "training" });
    const trainingIn = receive(withForecasts([memory, drill, ...normals]), report("20990101000002", "training"), at).state.forecasts;
    expect([trainingIn.includes(memory), trainingIn.some((item) => item.subject === drill.subject)]).toEqual([true, false]);
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

    // 器/世代（4 MiB＋印の分、P3-NL-AC15）: byte の超過は全 subject が候補。normal だけで超えるなら capacityExceeded。
    const wide = (index: number, operation: "normal" | "training") => clone(index, { operation,
      areas: Array.from({ length: 1000 }, (_, code) => ({ ...seed.areas[0], code: String(code).padStart(3, "0"), name: "区".repeat(40) })) });
    const count = Math.ceil(tsunamiUnitCodec.maxEnvelopeBytes! / Buffer.byteLength(JSON.stringify(wide(0, "normal"))));
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

    // P3-UM-AC03 (6)・RES-09: 記録の上限（予報 512・観測 512×2 family）の全部に読み戻しの上限いっぱいの印と予算いっぱいの原文を足すと、
    // 前の器（印・原文・カードの項の前）ちょうどの state も、器からカードの項を除いた内で decode が受ける。
    const gen = (state: TsunamiUnitState) => serializedEnvelope({ schemaVersion: tsunamiUnitCodec.schemaVersion, unit: "U-T", generation: 0,
      capturedAt: 0, payload: tsunamiUnitCodec.encode(state) as JsonValue, sha256: "0".repeat(64) }).byteLength + 62 + INPUT_BOUNDARY_MAX_BYTES
      + LOSS_TALLY_MAX_BYTES + PENDING_MARK_BYTES * state.observations.filter((item) => item.effective === "active").length;
    const records = Array.from({ length: 512 }, (_, index) => clone(index));
    const allObservations = (["VTSE51", "VTSE52"] as const).flatMap((family) => Array.from({ length: 512 }, (_, index) => obsClone(index, family)));
    const padded = (length: number, forecasts = records, observations = allObservations): TsunamiUnitState => ({ ...emptyState(), observations,
      forecasts: [{ ...forecasts[0], areas: [{ ...forecasts[0].areas[0], name: "x".repeat(length) }] }, ...forecasts.slice(1)] });
    const limit = tsunamiUnitCodec.maxEnvelopeBytes!, atLimit = limit - gen(padded(0));
    const decodeOf = (state: TsunamiUnitState) => tsunamiUnitCodec.decode(JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(state))) as JsonValue).kind;
    expect([gen(padded(atLimit)), decodeOf(padded(atLimit)), decodeOf(padded(atLimit + 1))]).toEqual([limit, "restored", "invalid"]);
    const before = atLimit - (512 + 512 * 2) * unreadableMarkBytes("unreadable") - 131_072 - UNREADABLE_CARDS_MAX_BYTES;
    const marked = padded(before, withLongestMarks(records, "forecastHeight", 0, 131_072), withLongestMarks(allObservations, "forecastHeight", 0, 0));
    console.info("P3-UM-AC03 (6) U-T", JSON.stringify({ marked: gen(marked), limit, cards: UNREADABLE_CARDS_MAX_BYTES }));
    expect([gen(marked) <= limit - UNREADABLE_CARDS_MAX_BYTES, decodeOf(marked)]).toEqual([true, "restored"]);
  });

  // contractBoundary: I-U-T.persisted・I-U-T.decode、復元で intent を作らない（AC05）。
  it("P3-C5-T05 contractBoundary / AC05: one codec, persisted fields only, every decode check and restore without new intents", () => {
    const first = receive(emptyState(), decodeFixture("32-39_11_02_250206_VTSE41", "VTSE41"), clock(1_299_822_540_001));
    const both = receive(first.state, decodeFixture("32-39_11_10_250206_VTSE51", "VTSE51"), clock(1_299_823_260_000)).state;
    const payload = JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(both))) as JsonValue;
    expect(Object.keys(payload as object).sort()).toEqual(["failureMarks", "forecasts", "intents", "observations", "schemaVersion"]);
    const decoded = tsunamiUnitCodec.decode(payload);
    expect(decoded).toEqual({ kind: "restored", state: { ...both, contentRevision: 0, persistence: { kind: "saved", currentGeneration: 0,
      savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } } });
    const value = payload as { forecasts: Record<string, unknown>[]; observations: Record<string, unknown>[]; intents: Record<string, unknown>[] };
    const area0 = (value.forecasts[0].areas as Record<string, unknown>[])[0];
    const measuredStation = (value.observations[0].stations as { maxHeight: { height: object | null } }[])
      .find((item) => item.maxHeight.height != null)!;
    // 実 byte は世代の上限ちょうどで、予約を足すと超える世代（P3-IUR-AC02）。終端記録は無くなった（P3-NL-AC05）ので予報の区域名で埋める。
    const withPad = (pad: number) => ({ ...value, intents: [value.intents[0]], forecasts: [{ ...value.forecasts[0],
      areas: [{ ...area0, name: `${String(area0.name)}${"x".repeat(pad)}` }, ...(value.forecasts[0].areas as unknown[]).slice(1)] }, ...value.forecasts.slice(1)] });
    const generation = (pad: number) => serializedEnvelope({ schemaVersion: "p3-tsunami-unit-v6", unit: "U-T", generation: 0, capturedAt: 0,
      payload: withPad(pad) as JsonValue, sha256: "0".repeat(64) }).byteLength + 62 + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES;
    const generationPad = tsunamiUnitCodec.maxEnvelopeBytes! - generation(0);
    expect(generation(generationPad)).toBe(tsunamiUnitCodec.maxEnvelopeBytes!);
    // 印の無い active の観測ごとの期限切れの保留の印の予約（P3-EF-AC10 (5)）も上限に数える。
    const marks = PENDING_MARK_BYTES * value.observations.filter((item) => item.effective === "active").length;
    expect(tsunamiUnitCodec.decode(withPad(generationPad - deliveryGrowth(value.intents[0] as unknown as TsunamiIntent) - marks) as JsonValue).kind).toBe("restored");
    expect(tsunamiUnitCodec.decode(withPad(generationPad - deliveryGrowth(value.intents[0] as unknown as TsunamiIntent) - marks + 1) as JsonValue).kind).toBe("invalid");
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
      ["pending real 131072 + reserve", { ...value, intents: reserveOver(value.intents[0]) }],
      ["generation real limit + reserve", withPad(generationPad)],
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

  // 実不具合の再発防止（台帳 73）: 受理の上限ちょうどの pending が配送の更新で伸びても、保存した世代を復元できる。
  it("P3-IUR-T01 regression / P3-IUR-AC01,AC03: pending admitted at its budget survives delivery updates, save and restore through the owner", () => {
    const raw = "2099-01-01T09:00:00+09:00", now = clock(Date.parse(raw));
    const next = decodeXml(vtse41({ at: raw, eventId: "20990101000022", areas: [{ code: "311", name: "区域311", kind: "51" }] }), "VTSE41");
    const pair = receive(emptyState(), next, now).intents;
    const held = intentsOf("normal/VTSE41/20990101000011", 1, "warning", now.wallTimeMs)[0];
    const body = `${held.payload.body}境界`;
    const reserved = (items: readonly TsunamiIntent[]) => items.reduce((sum, item) => sum + deliveryGrowth(item), 0);
    const padding = 131_072 - Buffer.byteLength(JSON.stringify([{ ...held, payload: { ...held.payload, body } }, ...pair]))
      - reserved([held, ...pair]);
    let admitted: TsunamiUnitState | null = null;
    for (const extra of [0, 1]) {
      const pending = { ...held, payload: { ...held.payload, body: body + "x".repeat(padding + extra) } };
      expect(Buffer.byteLength(JSON.stringify([pending, ...pair])) + reserved([pending, ...pair])).toBe(131_072 + extra);
      const step = receive({ ...emptyState(), intents: [pending] }, next, now);
      // channel ごとに全採用か未採用（P3-C5-REPLACEMENT=A）。+1 byte では sound が入らない。
      expect(step.intents).toEqual(extra === 0 ? pair : pair.slice(0, 1));
      if (extra === 0) admitted = step.state;
    }
    const roundTrip = (state: TsunamiUnitState) => tsunamiUnitCodec.decode(JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(state))) as JsonValue);
    const first = roundTrip(admitted!);
    if (first.kind !== "restored") throw new Error("the admitted state does not decode");
    const empty = restoreOwner({ runId: "run", place: "urgent", clock: now, restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const owner = { ...empty, units: { ...empty.units, "U-T": first.state } };
    const update = (from: Parameters<typeof intentUpdateOwner>[0], split: boolean) => intentUpdateOwner(from, "U-T", from.units["U-T"]!.intents.filter((item) => item.disposition === "pending").map((item, index) => ({ ...item, attempts: Number.MAX_SAFE_INTEGER, nextAttemptAt: -0.0000018927186924017318,
      disposition: split && index % 3 === 1 ? "superseded" as const : "pending" as const, lossReason: null })), now, linkedUnitTable);
    // 全 pending が最長へ伸びる更新（予約の不変条件、AC03）→ 3 件に 1 件が終端になる更新、のそれぞれの後で保存と復元ができる。
    const widened = update(owner, false);
    expect(widened.adopted).toBe(true);
    expect(roundTrip(widened.state.units["U-T"]!).kind).toBe("restored");
    const grown = update(widened.state, true);
    expect(grown.adopted).toBe(true);
    expect(roundTrip(grown.state.units["U-T"]!).kind).toBe("restored");
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
    // 発令の段階: 大津波警報 critical、津波警報 warning、注意報 warning（P3-NL-AC11 (1)、H09）、予報だけ info（直前が active でない released の題は津波予報）。
    expect(levels(send(emptyState(), 0, [{ code: "311", kind: "52" }]))).toEqual(["desktop:critical", "sound:critical"]);
    expect(levels(send(emptyState(), 0, [{ code: "311", kind: "51" }]))).toEqual(["desktop:warning", "sound:warning"]);
    expect(levels(send(emptyState(), 0, [{ code: "311", kind: "62" }]))).toEqual(["desktop:warning", "sound:warning"]);
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
    // P3-NL-AC05 (1): 置き換えた pending は intents から外れる（結果は印に残る）。
    expect(raised.state.intents).toHaveLength(2);
    const cancel = send(continued.state, 3, [], { infoType: "取消" });
    expect(cancel.intents.map((item) => [item.payload.level, item.payload.title, item.payload.body]))
      .toEqual([["cancel", "[取消] 津波警報（09:01 発表）", "09:01 発表の津波警報を取り消しました"], ["cancel", "[取消] 津波警報（09:01 発表）", "09:01 発表の津波警報を取り消しました"]]);
    expect(pending(cancel.state)).toEqual(["desktop:cancel", "sound:cancel"]);
    // active でなかった subject の取消は通知しない。
    expect(send(emptyState(), 3, [], { infoType: "取消" }).intents).toEqual([]);

    // 満杯（128 件）: 緊急は下位群を A7 の選択順の逆で退去して収まる。同群以上は退去しない。
    const lowerFull = { ...emptyState(), intents: intentsOf("training/VTSE41/20980101000001", 128, "info", at(0).wallTimeMs) };
    const admitted = send(lowerFull, 0, [{ code: "311", kind: "52" }]);
    expect(admitted.intents).toHaveLength(2);
    expect(admitted.diagnostics).toEqual([{ level: "INFO", component: "tsunami", reason: "notificationCapacityEvicted", unit: "U-T", count: 2 }]);
    // P3-NL-AC05 (1): 退去した pending は intents から外れる。
    expect(admitted.state.intents.map((item) => item.id)).toEqual([...lowerFull.intents.slice(0, 126).map((item) => item.id),
      ...admitted.intents.map((item) => item.id)]);
    const sameFull = { ...emptyState(), intents: intentsOf("normal/VTSE41/20980101000001", 128, "critical", at(0).wallTimeMs) };
    const refused = send(sameFull, 0, [{ code: "311", kind: "52" }]);
    expect([refused.intents, refused.state.intents.filter((item) => item.disposition === "pending")]).toEqual([[], sameFull.intents]);
    expect(refused.diagnostics).toMatchObject([{ reason: "notificationCapacityEvicted", count: 2 }]);

    // intentUpdate: 既存 id だけを一括で更新し、保存世代を 1 つ進める。未知 id・同値は no-op。
    const [desktop] = issued.intents;
    const updated = run(issued.state, { kind: "intentUpdate", clock: at(0), intentUpdate: [{ ...desktop, attempts: 1,
      nextAttemptAt: at(0).wallTimeMs + 1_000, disposition: "pending", lossReason: null }, { id: "unknown", attempts: 1, nextAttemptAt: 0, disposition: "delivered", lastAttempt: null, replayed: false, expiresAt: 0, lossReason: null }] });
    expect(updated.state.persistence.currentGeneration).toBe(issued.state.persistence.currentGeneration + 1);
    expect(updated.decisions).toMatchObject([{ decision: "changed", change: "deliveryOnly" }]);
    expect(run(updated.state, { kind: "intentUpdate", clock: at(0), intentUpdate: { ...desktop, attempts: 1,
      nextAttemptAt: at(0).wallTimeMs + 1_000, disposition: "pending", lossReason: null } }).state).toBe(updated.state);

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
    // :31 の corpus の訂正は元の報と Control/DateTime が同じで未確認（sequences.json の expected:O07:31）。後の送信の訂正で同じことを確かめる。
    const continued = receive(o07[3].state, decodeFixture("synthetic_VTSE41_correction", "VTSE41", sentLater), clock(1_299_823_260_000));
    expect(continued.intents.map((item) => item.payload.level)).toEqual(["normal", "normal"]);
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

// P3-CURRENCY-COVERAGE-001（C1）の U-T: 容量の拒否の印、失敗した subject の desktop の title、失敗警報。
describe("P3-CURRENCY-COVERAGE-001 U-T", () => {
  const base = Date.parse("2099-01-01T09:00:00+09:00");
  const at = (minute: number) => clock(base + minute * 60_000, minute);
  const raw = (minute: number) => `2099-01-01T09:${String(minute).padStart(2, "0")}:00+09:00`;
  const CC = "normal/VTSE41/20990101000011", FAIL = "normal/capacityRejected";
  const areas = (count: number, kind = "62") => Array.from({ length: count }, (_, index) =>
    ({ code: String(100 + index), name: `区域${index}`, kind }));
  const report = (minute: number, list = areas(1), options: { infoType?: "発表" | "訂正" | "取消"; eventId?: string } = {}) =>
    decodeXml(vtse41({ at: raw(minute), areas: list, ...options }), "VTSE41");
  const generation = (state: TsunamiUnitState) => serializedEnvelope({ schemaVersion: "p3-tsunami-unit-v6", unit: "U-T", generation: 0,
    capturedAt: 0, payload: tsunamiUnitCodec.encode(state) as JsonValue, sha256: "0".repeat(64) }).byteLength + 62 + INPUT_BOUNDARY_MAX_BYTES
    + LOSS_TALLY_MAX_BYTES + state.intents.reduce((sum, item) => sum + deliveryGrowth(item), 0);
  // 世代を器 − slack にする別の EventID の normal の active な予報。normal の active は退去の候補にならないので、slack を越える増分は
  // 拒否になる（P3-NL-AC05 で終端記録は無くなったので、詰め物は予報に置く。器は印の分だけ 4 MiB より大きい、P3-NL-AC15）。
  const PAD = "normal/VTSE41/20990101009999";
  const crowd = (state: TsunamiUnitState, slack: number): TsunamiUnitState => {
    const { notice: _notice, ...template } = state.forecasts[0];
    const pad = (name: string): TsunamiUnitState => ({ ...state, forecasts: [...state.forecasts, { ...template, subject: PAD,
      eventId: "20990101009999", source: { ...template.source, subject: PAD }, areas: template.areas.map((area) => ({ ...area, name: area.name + name })) }] });
    const crowded = pad("x".repeat(tsunamiUnitCodec.maxEnvelopeBytes! - slack - generation(pad(""))));
    expect(generation(crowded)).toBe(tsunamiUnitCodec.maxEnvelopeBytes! - slack);
    return crowded;
  };
  const free = (state: TsunamiUnitState): TsunamiUnitState => ({ ...state, forecasts: state.forecasts.filter((item) => item.subject !== PAD) });
  const markOf = (state: TsunamiUnitState) => forecast(state, CC)?.unavailable;
  const notices = (state: TsunamiUnitState) => state.intents.filter((item) => item.subject === FAIL);
  const first = () => receive(emptyState(), report(0), at(0)).state;
  // 新しい subject の 300 区域の報（拒否される大きさ）。kind 51 は warning、52 は critical。
  const big = (minute: number, eventId: string, kind = "51") => report(minute, areas(300, kind), { eventId });

  it("P3-CC-T04 contractBoundary / AC03(3): a mark stays on an older adoption and leaves on the same, a newer or a cancelling one", () => {
    const wide = report(3, areas(300));
    const rejected = receive(crowd(first(), 5_000), wide, at(3));
    expect(changed(rejected)).toEqual({ subject: CC, operation: "normal", decision: "changed", reason: null, change: "semantic",
      currentEstablished: null });
    expect(markOf(rejected.state)).toMatchObject({ reason: "capacityExceeded", source: { reportDateTimeRaw: raw(3) } });
    expect(forecast(rejected.state, CC)?.source.reportDateTimeRaw).toBe(raw(0));
    // 印を付けた拒否も失敗そのものを 1 行残し（AC07）、unit の未確認にはしない。
    expect(rejected.diagnostics).toEqual([{ level: "WARN", component: "tsunami", reason: "capacityRejected", unit: "U-T",
      inputId: wide.inputId }]);
    expect(rejected.confirmationEvidence).toEqual([]);
    const older = receive(rejected.state, report(2), at(4));
    expect([forecast(older.state, CC)?.source.reportDateTimeRaw, markOf(older.state)?.source.reportDateTimeRaw]).toEqual([raw(2), raw(3)]);
    const room = free(older.state);
    for (const [label, material] of [["same", report(3, areas(300))], ["newer", report(5)], ["cancel", report(3, [], { infoType: "取消" })]] as const) {
      const cleared = receive(room, material, at(6));
      expect(changed(cleared).decision, label).toBe("changed");
      expect(forecast(cleared.state, CC), label).not.toHaveProperty("unavailable");
      if (label === "cancel") expect(forecast(cleared.state, CC)?.effective).toBe("cancelled");
    }
  });

  it("P3-CC-T04 contractBoundary / AC03(2): a rejection no newer than the mark is covered by it and does not unconfirm the unit", () => {
    const marked = receive(crowd(first(), 5_000), report(3, areas(300)), at(3)).state;
    // 同じ報の再送と、記録より新しく印より古い報。どちらも印が覆うので負の証拠を返さず、decision は capacityExceeded のまま。
    for (const material of [report(3, areas(300)), report(2, areas(300))]) {
      const again = receive(marked, material, at(4));
      expect(changed(again)).toEqual({ subject: CC, operation: "normal", decision: "capacityExceeded" });
      expect(again.confirmationEvidence).toEqual([]);
      expect(again.state).toBe(marked);
    }
  });

  it("P3-CC-T16 contractBoundary / AC10(2): from one full state a warning rejection adds the failure notice, advisory and observation ones do not", () => {
    // 件数の上限で拒否が起き、世代には失敗警報の入る余りがある state: VTSE41 の 512 件と VTSE51 の観測点 1,024 点。
    // 取消は外す: 取消を拒否させるには世代を満たすしかなく、そこでは失敗警報も入らないので段階の門を区別できない。
    const plain = first(), seed = plain.forecasts[0];
    const clone = (index: number): TsunamiForecastSubject => {
      const eventId = String(20980101000000 + index), subject = `normal/VTSE41/${eventId}`;
      return { ...seed, eventId, subject, source: { ...seed.source, subject } };
    };
    let full: TsunamiUnitState = { ...plain, forecasts: [seed, ...Array.from({ length: 511 }, (_, index) => clone(index + 1))] };
    for (let filler = 0; filler < 4; filler++) full = receive(full, decodeXml(observation({ eventId: `2099010100010${filler}`, at: raw(1),
      serial: 1, stations: Array.from({ length: 256 }, (_, index) => ({ code: String(30_000 + filler * 256 + index) })) }), "VTSE51"), at(1)).state;
    expect(full.observations.reduce((sum, item) => sum + item.stations.length, 0)).toBe(1_024);
    for (const [label, material, count] of [["warning", report(3, areas(1, "51"), { eventId: "20990101000020" }), 2],
      ["advisory", report(3, areas(1, "62"), { eventId: "20990101000021" }), 0],
      ["observation", decodeXml(observation({ eventId: "20990101000022", at: raw(3), serial: 1, stations: [{ code: "21001" }] }), "VTSE51"), 0],
    ] as const) {
      const refused = receive(full, material, at(3));
      expect(changed(refused).decision, label).toBe("capacityExceeded");
      expect(notices(refused.state), label).toHaveLength(count);
    }
  });

  it("P3-CC-T05 contractBoundary / AC03(2)・AC04(3): without room for the mark only the desktop title changes, without room for that nothing", () => {
    const pending = (state: TsunamiUnitState) => state.intents.filter((item) => item.disposition === "pending")
      .map((item) => [item.id, item.channel, item.payload.title, item.expiresAt]);
    // 印（ReportRef 1 つ、約 300 byte）は入らず、title の『【09:00 発表】』（18 byte）は入る。
    const tight = crowd(first(), 100);
    const step = receive(tight, report(3, areas(300)), at(3));
    expect(changed(step)).toEqual({ subject: CC, operation: "normal", decision: "capacityExceeded" });
    expect(step.state.forecasts).toBe(tight.forecasts);
    expect(step.confirmationEvidence).toEqual([{ source: "capacityExceeded", scopes: [{ unit: "U-T", operation: "normal", kind: "unit" }] }]);
    expect(pending(step.state)).toEqual(pending(tight).map(([id, channel, title, expiresAt]) =>
      [id, channel, channel === "desktop" ? `【09:00 発表】${title}` : title, expiresAt]));
    const full = crowd(first(), 5);
    expect(receive(full, report(3, areas(300)), at(3)).state).toBe(full);
  });

  it("P3-CC-T09 contractBoundary / AC05: an unmarked save restores without marks, marks and failure notices round-trip, and foreign marks are invalid", () => {
    const roundTrip = (state: TsunamiUnitState) => tsunamiUnitCodec.decode(JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(state))) as JsonValue);
    const plain = roundTrip(first());
    expect(plain.kind === "restored" && plain.state.forecasts[0]).not.toHaveProperty("unavailable");
    const marked = receive(crowd(first(), 5_000), report(3, areas(300)), at(3)).state;
    const both = receive(marked, big(4, "20990101000012"), at(4)).state;
    expect(notices(both).map((item) => item.payload.level)).toEqual(["warning", "warning"]);
    const decoded = roundTrip(both);
    if (decoded.kind !== "restored") throw new Error("marked state does not restore");
    expect([decoded.state.forecasts, decoded.state.intents]).toEqual([both.forecasts, both.intents]);
    type Row = Record<string, unknown>;
    const value = JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(both))) as { forecasts: Row[]; observations: Row[]; intents: Row[] };
    const mark = value.forecasts[0].unavailable as Row, source = mark.source as Row;
    const withMark = (patch: Row) => ({ ...value, forecasts: [{ ...value.forecasts[0], unavailable: { ...mark, ...patch } }] });
    const observed = JSON.parse(JSON.stringify(receive(emptyState(), decodeXml(observation({ at: raw(1), serial: 1,
      stations: [{ code: "21001" }] }), "VTSE51"), at(1)).state.observations[0])) as Row;
    const notice = value.intents.find((item) => item.subject === FAIL)!;
    const invalid: [string, unknown][] = [
      ["reason", withMark({ reason: "historyUnavailable" })],
      ["source missing", withMark({ source: undefined })],
      ["other operation", withMark({ source: { ...source, operation: "training", subject: "training/VTSE41/20990101000011" } })],
      ["other EventID", withMark({ source: { ...source, subject: "normal/VTSE41/20990101000099" } })],
      ["other family", withMark({ source: { ...source, family: "VTSE51" } })],
      ["released record", { ...value, forecasts: [{ ...value.forecasts[0], effective: "released", areas: [], retainUntil: 1 }] }],
      ["observation", { ...value, observations: [{ ...observed, unavailable: mark }] }],
      ["notice of another unit", { ...value, intents: [...value.intents, { ...notice, id: "x", source: { ...(notice.source as Row),
        subject: "normal/VXSE53/20990101000012", family: "VXSE53" } }] }],
      ["notice of another operation", { ...value, intents: [...value.intents, { ...notice, id: "y", source: { ...(notice.source as Row),
        operation: "training", subject: "training/VTSE41/20990101000012" } }] }],
    ];
    for (const [label, payload] of invalid) expect(tsunamiUnitCodec.decode(JSON.parse(JSON.stringify(payload)) as JsonValue).kind, label).toBe("invalid");
  });

  it("P3-CC-T17 contractBoundary / AC10(5): a failure notice without room is not added and the lighter one stays pending", () => {
    const warned = receive(crowd(first(), 5_000), big(3, "20990101000012"), at(3)).state;
    const light = notices(warned);
    expect(light.map((item) => [item.payload.level, item.disposition])).toEqual([["warning", "pending"], ["warning", "pending"]]);
    // 世代: 昇格の失敗警報 2 件が入らなければ、昇格もせず軽い失敗警報がそのまま残り、何も退去しない。置き換える軽い失敗警報は
    // intents から外れる（P3-NL-AC05 (1)）ので、増えるのは題と level の数 byte。その増え分ちょうどの余りなら昇格が入り、1 byte 少なければ入らない。
    const roomy = crowd(free(warned), 5_000);
    const growth = generation(receive(roomy, big(4, "20990101000013", "52"), at(4)).state) - generation(roomy);
    const fits = crowd(free(warned), growth);
    expect(notices(receive(fits, big(4, "20990101000013", "52"), at(4)).state).map((item) => item.payload.level)).toEqual(["critical", "critical"]);
    const exact = crowd(free(warned), growth - 1);
    const byGeneration = receive(exact, big(4, "20990101000013", "52"), at(4));
    expect(changed(byGeneration).decision).toBe("capacityExceeded");
    expect(byGeneration.state).toBe(exact);
    // 件数: pending が 128 件なら最初の失敗警報も入らない（置き換える軽い失敗警報が無いので件数が増える）。
    const plain = first();
    const filler = intentsOf("normal/VTSE41/20990101000099", 128 - plain.intents.filter((item) => item.disposition === "pending").length,
      "info", base);
    const counted = crowd({ ...plain, intents: [...plain.intents, ...filler] }, 5_000);
    const byCount = receive(counted, big(4, "20990101000013", "52"), at(4));
    expect(changed(byCount).decision).toBe("capacityExceeded");
    expect(byCount.state).toBe(counted);
    // byte: pending（予約込み）が 131,072 byte の 300 byte 手前なら、件数に余りがあっても失敗警報 2 件（約 1 KB）は入らない。
    const template = plain.intents[0];
    // 詰め物は退去できない緊急群の pending にする（退去した pending は intents から外れて世代が空く、P3-NL-AC05 (1)）。
    const withPending = (body: string): TsunamiUnitState => ({ ...plain, intents: [...plain.intents,
      { ...template, id: "U-T:pending-pad", priorityGroup: "normalTsunamiEmergency", payload: { ...template.payload, level: "critical", body } }] });
    const pendingBytes = (state: TsunamiUnitState) => {
      const values = state.intents.filter((item) => item.disposition === "pending");
      return Buffer.byteLength(JSON.stringify(values)) + values.reduce((sum, item) => sum + deliveryGrowth(item), 0);
    };
    const heavy = withPending("x".repeat(131_072 - 300 - pendingBytes(withPending(""))));
    expect(pendingBytes(heavy)).toBe(131_072 - 300);
    const byBytes = crowd(heavy, 5_000);
    expect(receive(byBytes, big(4, "20990101000013", "52"), at(4)).state).toBe(byBytes);
  });

  it("P3-CC-T18 contractBoundary / AC10(6)(7): the same or a lighter rejection keeps the notice, a heavier one replaces it, a reclaimed one rings again", () => {
    const warned = receive(crowd(first(), 5_000), big(3, "20990101000012"), at(3)).state;
    const light = notices(warned);
    for (const material of [big(3, "20990101000012"), big(2, "20990101000014"), big(4, "20990101000015")]) {
      const again = receive(warned, material, at(4));
      expect(changed(again).decision).toBe("capacityExceeded");
      expect(notices(again.state)).toEqual(light);
    }
    const heavy = receive(warned, big(4, "20990101000016", "52"), at(4)).state;
    // P3-NL-AC01 (4)・AC05 (1): ID は拒否した報の版の鍵から作り、置き換えた軽い失敗警報は intents から外れる。
    expect(notices(heavy).map((item) => [item.id, item.payload.level, item.disposition])).toEqual((["desktop", "sound"] as const).map((channel) =>
      [JSON.stringify(["U-T", FAIL, JSON.stringify([Date.parse(raw(4))]), channel]), "critical", "pending"]));
    // (a) 旧警報の予約の更新は、昇格の後には採られない（owner は pending でない intent への更新を採らない）。
    const empty = restoreOwner({ runId: "run", place: "urgent", clock: at(4), restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const owner = { ...empty, units: { ...empty.units, "U-T": heavy } };
    expect(intentUpdateOwner(owner, "U-T", [{ ...light[0], attempts: 1, nextAttemptAt: base, disposition: "pending", lossReason: null }], at(4),
      linkedUnitTable).adopted).toBe(false);
    // (b) 走行中の旧警報は A7 が superseded で止め、次は新しい失敗警報（緊急群）が選ばれる。
    const deadlines = Object.fromEntries(heavy.intents.filter((item) => item.disposition === "pending" && item.channel === "desktop")
      .map((item) => [JSON.stringify(["U-T", item.id]), { retryAtMonotonicMs: 0, expiresAtMonotonicMs: 1e12 }]));
    const running: NotificationAttempt = { attemptId: "old", intentId: light[0].id, unit: "U-T", subject: FAIL, operation: "normal",
      channel: "desktop", priorityGroup: "normalTsunamiEmergency", payload: light[0].payload, soundAsset: null, selectedAtMonotonicMs: 0,
      timeoutAtMonotonicMs: 1e12, expiresAt: light[0].expiresAt };
    const stopping = selectNotificationAttempt({ intents: heavy.intents, deadlines: { desktop: deadlines, sound: {} },
      channels: { desktop: { kind: "running", attempt: running }, sound: { kind: "idle" } } }, at(4));
    expect(stopping.abortRequests).toEqual([{ attemptId: "old", cause: "superseded" }]);
    const next = selectNotificationAttempt({ intents: heavy.intents, deadlines: { desktop: deadlines, sound: {} },
      channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } } }, at(4));
    expect(next.attempts.map((item) => [item.intentId, item.priorityGroup])).toEqual([[notices(heavy)[0].id, "normalTsunamiEmergency"]]);
    // 保存して復元した後も判定は同じ（critical が残る間は warning を作らない）。
    const restored = tsunamiUnitCodec.decode(JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(heavy))) as JsonValue);
    if (restored.kind !== "restored") throw new Error("notice state does not restore");
    expect(notices(receive(restored.state, big(5, "20990101000017"), at(5)).state)).toEqual(notices(heavy));
    // 失敗警報の intent が期限で回収された後は、同じ段階の拒否でも再び鳴る。
    const reclaimed = run(heavy, { kind: "deadline", clock: at(10) }).state;
    expect(notices(reclaimed)).toEqual([]);
    expect(notices(receive(reclaimed, big(11, "20990101000018"), at(11)).state).map((item) => item.payload.level)).toEqual(["warning", "warning"]);
  });

  // P3-NL-AC02 (6): 失敗警報が配送されて intents から外れた後も、失敗の印の until の内は同じ段階の拒否で鳴らない。
  it("P3-NL-T01 acceptance / AC02 (6): a delivered failure notice leaves the intents and its mark keeps the same stage silent", () => {
    const warned = receive(crowd(first(), 5_000), big(3, "20990101000012"), at(3)).state;
    const delivered = run(warned, { kind: "intentUpdate", clock: at(3), intentUpdate: notices(warned).map((item) => ({ ...item, attempts: 1,
      nextAttemptAt: item.createdAt, disposition: "delivered" as const, lossReason: null })) }).state;
    expect([notices(delivered), delivered.failureMarks.map((item) => item.level)]).toEqual([[], ["warning"]]);
    const again = receive(delivered, big(4, "20990101000015"), at(4));
    expect([changed(again).decision, again.intents, notices(again.state)]).toEqual(["capacityExceeded", [], []]);
  });

  // P3-NL-AC08 (1)(4)・AC15 (4): 失敗警報の started も復元で外れ、もう一方は戻る。
  it("P3-NL-T07 contractBoundary / AC08・AC15 (4): a started failure notice is dropped at restore and the other one returns", () => {
    const warned = receive(crowd(first(), 5_000), big(3, "20990101000012"), at(3)).state;
    const [desktop, sound] = notices(warned);
    expectRestoreStarted({ intents: [desktop, sound], make: (intents) => ({ ...warned, intents }),
      restore: (state, clockAt) => run(emptyState(), { kind: "restore", persisted: tsunamiUnitCodec.encode(state), clock: clockAt }) });
  });

  it("P3-CC-T19 regression / AC10(9): a same-revision observation fragment is still adopted with its info notice", () => {
    const once = receive(emptyState(), decodeXml(observation({ at: raw(1), serial: 1, stations: [{ code: "21001" }] }), "VTSE51"), at(1));
    const fragment = receive(once.state, decodeXml(observation({ at: raw(1), serial: 1, stations: [{ code: "21002" }] }), "VTSE51"), at(2));
    expect(changed(fragment).decision).toBe("changed");
    expect(fragment.intents.map((item) => [item.subject, item.payload.level])).toEqual([
      ["normal/tsunamiObservation:VTSE51/20990101000011", "info"], ["normal/tsunamiObservation:VTSE51/20990101000011", "info"]]);
  });

  it("P3-CC-T20 contractBoundary / AC10(9): a rejection that only adds a failure notice is attributed to the generation it raises", () => {
    const empty = restoreOwner({ runId: "run", place: "urgent", clock: at(0), restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const state = crowd(first(), 5_000);
    const owner = { ...empty, units: { ...empty.units, "U-T": state } };
    const generationG = state.persistence.currentGeneration;
    // 世代 G の保存中（capture の後）に、新しい subject の拒否で失敗警報だけが入って G+1 へ進む。
    const captured = capturedOwner(owner, { unit: "U-T", attemptId: "save-g", generation: generationG, capturedAt: 1 }, linkedUnitTable).state;
    const material = big(3, "20990101000012");
    const rejected = receiveOwner(captured, { runId: "run", inputId: material.inputId, result: { kind: "decoded", material } }, at(3),
      linkedUnitTable);
    expect(notices(rejected.state.units["U-T"]!)).toHaveLength(2);
    expect(rejected.state.units["U-T"]!.forecasts).toBe(state.forecasts);
    expect(rejected.generationInputIds).toEqual({ "U-T": [material.inputId] });
    const acked = checkpointResultOwner(rejected.state, { kind: "acknowledged", attemptId: "save-g", unit: "U-T", generation: generationG,
      ackAt: 2, encodedByteLength: 1 }, linkedUnitTable).state.units["U-T"]!.persistence;
    expect(acked).toMatchObject({ kind: "pending", savedGeneration: generationG, currentGeneration: generationG + 1 });
  });

  it("P3-CC-T20 contractBoundary / AC08(14): after the ack of G the rejected input stays with G+1, whose save restores the failure notice", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fleq-cc-t20-"));
    try {
      const crowded = crowd(first(), 5_000);
      // "seed" の入力で U-T を拒否の起きる state にする（世代を 1 つ進める）。ほかの入力は本物の U-T。
      const units: UnitTable = { ...linkedUnitTable, "U-T": { ...linkedUnitTable["U-T"], reduce: (state, input) =>
        input.kind === "receive" && input.material.inputId === "seed" ? { state: { ...crowded, persistence: { kind: "pending",
          currentGeneration: state.persistence.currentGeneration + 1, savedGeneration: state.persistence.savedGeneration,
          savedCapturedAt: state.persistence.savedCapturedAt, savedAckAt: state.persistence.savedAckAt, dirtySince: input.clock.monotonicMs } },
          nextDeadline: null, decisions: [], intents: [], outcomes: [], diagnostics: [], displayChanges: [], confirmationEvidence: [] }
          : linkedUnitTable["U-T"].reduce(state, input) } };
      // 世代 G の保存は file を開くところで止め、その間に拒否の入力を入れる。
      let release!: () => void;
      const gate = new Promise<void>((done) => { release = done; });
      const files = nodeCheckpointFileSystem();
      let opens = 0;
      const parked: CheckpointFileSystem = { ...files, open: async (path) => { if (opens++ === 0) await gate; return files.open(path); } };
      const replies: OwnerReply[] = [];
      const host = (table: UnitTable, fileSystem: CheckpointFileSystem) => new OwnerHost({ start: { place: "urgent",
        stateDirectory: join(directory, "state"), publisherTimeOriginMs: 0, measured: false, inputHeap: false }, units: table,
        codecs: linkedUnitCodecs, fileSystem, sharedNow: () => 1, reply: (reply) => { replies.push(reply); }, fail: (error) => { throw error; } });
      const input = (inputId: string, minute: number, xml: string) => ({ kind: "input" as const, clock: at(minute), sharedMs: 1, basis: "verified" as const,
        envelope: envelope("run", "VTSE41", inputId, Buffer.from(xml), at(minute)) });
      const owner = host(units, parked);
      owner.handle({ kind: "restore", runId: "run", clock: at(0), sharedMs: 1, basis: "verified" });
      owner.handle(input("seed", 1, vtse41({ at: raw(0), areas: areas(1) })));
      owner.handle({ kind: "checkpointGrant", grantId: "save-g", unit: "U-T", mode: "save", retryReason: "notRetry", inputBoundary: null, clock: at(1), sharedMs: 1, basis: "verified" });
      owner.handle(input("reject", 3, vtse41({ eventId: "20990101000012", at: raw(3), areas: areas(300, "51") })));
      release();
      const saves = () => replies.flatMap((reply) => reply.kind === "checkpointDone" ? [reply] : []);
      await vi.waitFor(() => expect(saves()).toHaveLength(1));
      owner.handle({ kind: "checkpointGrant", grantId: "save-g1", unit: "U-T", mode: "save", retryReason: "notRetry", inputBoundary: null, clock: at(3), sharedMs: 1, basis: "verified" });
      await vi.waitFor(() => expect(saves()).toHaveLength(2));
      const [saveG, saveG1] = saves();
      expect([saveG.result?.kind, saveG.result?.generation, saveG1.result?.kind, saveG1.result?.generation]).toEqual(["acknowledged", 1, "acknowledged", 2]);
      expect(saveG1.measurements.length).toBeGreaterThan(0);
      expect(saveG1.measurements.map((item) => item.inputIds)).toEqual(saveG1.measurements.map(() => ["reject"]));
      // G+1 の保存から復元すると失敗警報が pending のまま戻る（音 60 秒の期限の内）。
      replies.length = 0;
      host(linkedUnitTable, files).handle({ kind: "restore", runId: "run-2", clock: { wallTimeMs: at(3).wallTimeMs + 30_000, monotonicMs: 0 }, sharedMs: 1, basis: "verified" });
      await vi.waitFor(() => expect(replies[0]?.kind).toBe("restored"));
      const restored = replies[0];
      if (restored.kind !== "restored") throw new Error("restored expected");
      expect(restored.units.find((item) => item.unit === "U-T")?.pendingIntents.filter((item) => item.subject === FAIL)
        .map((item) => [item.channel, item.payload.level])).toEqual([["desktop", "warning"], ["sound", "warning"]]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  // P3-NL-T06（P3-NL-AC14 の数え方。describe の最後に置く: 前に置くと decodeXml の inputId の連番の桁が変わり、P3-CC-T17 の byte の境界値がずれる）:
  // 保存済みの U-T が容量で報を断っただけ（unit の state は不変）でも owner が世代を進めてその入力に帰属させ、unit の診断（count のある
  // tsunamiCapacityEvicted を含む）と採用した更新の lossReason を理由ごとに足す。件数は保存→復元で残り、capture が外した期限の後の行は
  // 加算元からも外れて、同じ理由をまた足すと 1 件から数え直す。publisher の失効の診断を owner で二重に数えないことは notification-wiring の T06。
  it("P3-NL-T06 contractBoundary / AC14: a refusal that leaves the unit unchanged still raises a generation, and the counts survive a restore", () => {
    const saved = { kind: "saved" as const, currentGeneration: 1, savedGeneration: 1, savedCapturedAt: null, savedAckAt: null, dirtySince: null };
    const full: TsunamiUnitState = { ...crowd(first(), 5), persistence: saved };
    // 退去の件数（count）を数えることを確かめるため、拒否の 1 歩に count 3 の tsunamiCapacityEvicted を添える unit の表（owner は unit の
    // 診断をそのまま数える）。
    const units: UnitTable = { ...linkedUnitTable, "U-T": { ...linkedUnitTable["U-T"], reduce: (state, input) => {
      const step = linkedUnitTable["U-T"].reduce(state, input);
      return input.kind !== "receive" ? step : { ...step, diagnostics: [...step.diagnostics, { level: "INFO", component: "tsunami",
        reason: "tsunamiCapacityEvicted", unit: "U-T", count: 3 }] };
    } } };
    const empty = restoreOwner({ runId: "run", place: "urgent", clock: at(0), restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const refuse = (state: typeof empty, minute: number, clockAt = at(minute)) => {
      const wide = report(minute, areas(300));
      return { wide, step: receiveOwner(state, { runId: "run", inputId: wide.inputId, result: { kind: "decoded", material: wide } }, clockAt, units) };
    };
    const { wide, step: refused } = refuse({ ...empty, units: { ...empty.units, "U-T": full } }, 3);
    const unit = refused.state.units["U-T"]!;
    expect([unit.forecasts === full.forecasts, unit.persistence, refused.generationInputIds["U-T"]]).toEqual([true,
      { ...saved, kind: "pending", currentGeneration: 2, dirtySince: 3 }, [wide.inputId]]);
    const pending = unit.intents.slice(0, 2);
    const expired = intentUpdateOwner(refused.state, "U-T", pending.map((item) => ({ ...item, disposition: "expired" as const,
      lossReason: "notificationExpiredClockUnverified" as const })), at(4), linkedUnitTable);
    const losses = [{ reason: "capacityRejected", count: 1, lastAt: at(3).wallTimeMs }, { reason: "tsunamiCapacityEvicted", count: 3, lastAt: at(3).wallTimeMs },
      { reason: "notificationExpiredClockUnverified", count: 2, lastAt: at(4).wallTimeMs }];
    expect([expired.adopted, expired.state.losses["U-T"]]).toEqual([true, losses]);
    const back = restoreOwner({ runId: "run-2", place: "urgent", clock: at(5), restored: { "U-E": { kind: "empty" }, "U-Q": { kind: "empty" },
      "U-N": { kind: "empty" }, "U-V": { kind: "empty" }, "U-T": { kind: "restored", envelope: { schemaVersion: "p3-tsunami-unit-v6", unit: "U-T",
        generation: 3, capturedAt: at(4).wallTimeMs, payload: tsunamiUnitCodec.encode(expired.state.units["U-T"]!) as JsonValue,
        losses: expired.state.losses["U-T"], sha256: "0".repeat(64) }, slot: "A" } } }, linkedUnitTable, linkedUnitCodecs);
    expect(back.state.losses["U-T"]).toEqual(losses);
    // 拒否の 2 行の lastAt＋24 時間ちょうどの capture は、その 2 行を外し、加算元からも外す。同じ理由をまた足すと 1 件から。
    const generation = expired.state.units["U-T"]!.persistence.currentGeneration;
    const captured = capturedOwner(expired.state, { attemptId: "a1", unit: "U-T", generation, capturedAt: at(3).wallTimeMs + 86_400_000 }, units);
    expect(captured.state.losses["U-T"]).toEqual([losses[2]]);
    expect(refuse(captured.state, 6).step.state.losses["U-T"]).toEqual([losses[2], { reason: "capacityRejected", count: 1, lastAt: at(6).wallTimeMs },
      { reason: "tsunamiCapacityEvicted", count: 3, lastAt: at(6).wallTimeMs }]);
  });
});

// sequences.json の履歴 oracle（expected:<seq>:<position>）を step ごとに照合する。save と restart は codec を通す。
// P3-NL-T01（P3-NL-AC01・AC02・AC05 の行。H19 の取消 AC09・AC13 は発注 2）: ID は世代番号を含まず、同じ報を保存→復元の後に origin（live・replay）
// によらず受け直しても intent を作らない。終端の更新は intent を外し、owner は intents に無く世代が進んだことで採用を確かめる。
it("P3-NL-T01 acceptance / AC01・AC02・AC05: a resent warning makes no intent after a restore, and a terminal update leaves the intents", () => {
  const warning = decodeFixture("synthetic_VTSE41_e01_311warning", "VTSE41");
  const at = clock(Date.parse(warning.reportDateTimeRaw));
  const first = receive(emptyState(), warning, at);
  expect(first.intents.map((item) => item.id)).toEqual(first.intents.map((item) => JSON.stringify(["U-T", item.subject, "", versionKey(item.source),
    item.transition, item.channel])));
  const restored = run(emptyState(), { kind: "restore", persisted: tsunamiUnitCodec.encode(first.state), clock: at }).state;
  for (const origin of ["live", "replay"] as const) expect([origin, receive(restored, { ...warning, origin }, at).intents]).toEqual([origin, []]);
  const empty = restoreOwner({ runId: "run", place: "urgent", clock: at, restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
    "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
  const updated = intentUpdateOwner({ ...empty, units: { ...empty.units, "U-T": first.state } }, "U-T", first.intents.map((item) => ({ ...item, attempts: 1,
    nextAttemptAt: at.wallTimeMs, disposition: "delivered" as const, lossReason: null })), at, linkedUnitTable);
  const unit = updated.state.units["U-T"]!;
  expect([updated.adopted, unit.intents, forecast(unit, first.intents[0].subject)?.notice?.evidence]).toEqual([true, [], "possible"]);
});

// P3-NL-T01 の H19 の行（P3-NL-AC09・AC10・AC13）: owner を通し、synthetic_VTSE41_e01_311warning の警報への取消（synthetic_VTSE41_cancel の
// EventID と時刻をこの警報の後に替えたもの）は、警報が active のときと、解除で記憶になった後でも印の証拠（possible）があれば通知し、文面に種類
// （取消の報の Head/Title）と取り消した記録の発表時刻を書く。印の証拠が unattempted の解除の後と、記録の無い系列の取消は通知しない。
it("P3-NL-T01 acceptance / AC09・AC10・AC13: a cancel notifies while active or after a release with notice evidence, never for an unknown series", () => {
  const warning = decodeFixture("synthetic_VTSE41_e01_311warning", "VTSE41");
  const cancel = decodeFixture("synthetic_VTSE41_cancel", "VTSE41", (xml) => xml.replaceAll("20110311144640", "20260101115800")
    .replace("2011-03-11T15:05:00+09:00", "2026-01-01T12:05:00+09:00").replace("2011-03-11T06:05:00Z", "2026-01-01T03:05:00Z"));
  const release = decodeXml(vtse41({ eventId: "20260101115800", at: "2026-01-01T12:01:00+09:00", areas: [{ code: "311", name: "千葉県内房", kind: "50" }] }),
    "VTSE41");
  const at = clock(Date.parse(cancel.reportDateTimeRaw));
  const empty = restoreOwner({ runId: "run", place: "urgent", clock: at, restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
    "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
  const owner = (state: typeof empty, material: typeof warning) => receiveOwner(state, { runId: "run", inputId: material.inputId,
    result: { kind: "decoded", material } }, at, linkedUnitTable).state;
  const cancels = (state: typeof empty) => state.units["U-T"]!.intents.filter((item) => item.transition === "cancelled")
    .map((item) => [item.channel, item.payload.level, item.payload.title, item.payload.body]);
  const expected = ["[取消] 大津波警報・津波警報・津波注意報・津波予報（11:59 発表）", "11:59 発表の大津波警報・津波警報・津波注意報・津波予報を取り消しました"];
  const active = owner(empty, warning);
  expect(cancels(owner(active, cancel))).toEqual([["desktop", "cancel", ...expected], ["sound", "cancel", ...expected]]);
  // 解除で記憶になった系列。通知を試みた印（possible）なら取消を通知し、試みていなければ通知しない。
  const tried = intentUpdateOwner(active, "U-T", active.units["U-T"]!.intents.map((item) => ({ ...item, attempts: 1, lastAttempt: "started" as const,
    lossReason: null })), at, linkedUnitTable).state;
  for (const [base, notified] of [[tried, true], [active, false]] as const) {
    const released = owner(base, release);
    const record = released.units["U-T"]!.forecasts.find((item) => item.eventId === "20260101115800");
    expect([record?.effective, record?.notice?.evidence]).toEqual(["released", notified ? "possible" : "unattempted"]);
    expect(cancels(owner(released, cancel)).length).toBe(notified ? 2 : 0);
  }
  expect(cancels(owner(empty, cancel))).toEqual([]);
});

// P3-NL-T05（P3-NL-AC11、H09）: 津波注意報だけの報は警報の音（warning）で、群は other のまま（A7 の選択で津波緊急の群に入らない）。
// 警報の報は normalTsunamiEmergency。容量で拒否した注意報だけの報が失敗警報を作らないことは P3-CC-T16 が確かめる。
// 32-39_13_07 は訓練の注意報の解除なので、通常運用の注意報の発令に書き換えて使う（区域は同じ 5 つ）。
it("P3-NL-T05 acceptance / AC11: an advisory-only report sounds as a warning but stays in the other group", () => {
  const advisory = decodeFixture("32-39_13_07_250206_VTSE41", "VTSE41", (xml) => xml.replace("<Status>訓練</Status>", "<Status>通常</Status>")
    .replaceAll("<Name>津波注意報解除</Name>", "<Name>津波注意報</Name>").replaceAll("<Code>60</Code>", "<Code>62</Code>"));
  const warning = decodeFixture("synthetic_VTSE41_e01_311warning", "VTSE41");
  const issued = receive(emptyState(), advisory, clock(Date.parse(advisory.reportDateTimeRaw)));
  expect(issued.intents.map((item) => [item.channel, item.payload.level, item.priorityGroup])).toEqual([["desktop", "warning", "other"],
    ["sound", "warning", "other"]]);
  const desktop = issued.intents[0];
  const selected = selectNotificationAttempt({ intents: [desktop], channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
    deadlines: { desktop: { [JSON.stringify(["U-T", desktop.id])]: { retryAtMonotonicMs: 0, expiresAtMonotonicMs: 1e9 } }, sound: {} } },
  { wallTimeMs: desktop.createdAt, monotonicMs: 0 });
  expect(selected.attempts.map((item) => item.priorityGroup)).toEqual(["other"]);
  expect(receive(emptyState(), warning, clock(Date.parse(warning.reportDateTimeRaw))).intents.map((item) => item.priorityGroup))
    .toEqual(["normalTsunamiEmergency", "normalTsunamiEmergency"]);
});

// P3-NL-T02（P3-NL-AC03）: 同じ版の fragment はそれぞれ 1 回ずつ通知し、受け直しても作らない。17 件目の fragment で最古の鍵が捨てられ、
// その fragment を受け直しても state の値が同じなので作らない。
it("P3-NL-T02 acceptance / AC03: each fragment of one version notifies once, a resent one does not, and the 17th drops the oldest key", () => {
  const a = decodeFixture("synthetic_VTSE51_fragmentA", "VTSE51"), b = decodeFixture("synthetic_VTSE51_fragmentB", "VTSE51");
  const at = clock(Date.parse(a.reportDateTimeRaw));
  const one = receive(emptyState(), a, at), two = receive(one.state, b, at);
  expect([one.intents.length, two.intents.length, receive(two.state, a, at).intents]).toEqual([2, 2, []]);
  const AT = "2099-01-01T09:01:00+09:00";
  const fragment = (code: string) => decodeXml(observation({ at: AT, serial: 1, stations: [{ code }] }), "VTSE51");
  let state = emptyState();
  for (let index = 0; index < 17; index++) {
    const step = receive(state, fragment(String(21_001 + index)), clock(Date.parse(AT)));
    expect([index, step.intents.length]).toEqual([index, 2]);
    state = step.state;
  }
  expect(state.observations[0].notice?.fragments).toHaveLength(16);
  expect(receive(state, fragment("21001"), clock(Date.parse(AT))).intents).toEqual([]);
});

// P3-NL-T02 の推定区域の行（P3-NL-AC03 (1)）: 推定区域だけの fragment 2 つは観測点の差分がどちらも空でも別の鍵になり、後の fragment の通知を潰さない。
it("P3-NL-T02 acceptance / AC03: an estimation-only fragment does not suppress a later estimation-only fragment", () => {
  const estimationOnly = (xml: string) => xml.replace(/<Station>[\s\S]*?<\/Station>/g, "");
  const first = decodeFixture("synthetic_VTSE52_fragmentA", "VTSE52", estimationOnly);
  const second = decodeFixture("synthetic_VTSE52_fragmentA", "VTSE52", (xml) => estimationOnly(xml).replace("<Name>岩手県</Name><Code>210</Code>",
    "<Name>宮城県</Name><Code>220</Code>"));
  const at = clock(Date.parse(first.reportDateTimeRaw));
  const one = receive(emptyState(), first, at);
  expect([one.intents.length, receive(one.state, second, at).intents.length]).toEqual([2, 2]);
});


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

// P3-VM-AC05・AC06（修正波 3）: 予約込みの上界は受理と読み戻しで同じにし、前の上限の計り方で作られた前の版の保存は版で初期化する。
// 無いと、前の上限まで 430 byte 未満の余裕しか無い正常な保存が invalid になり、A/B の両方がそうなら unavailable でその run の保存も止まる。
it("P3-VM-AC05 regression: old-version slots start empty and the next save stays within 4 MiB", async () => {
  const first = receive(emptyState(), decodeFixture("32-39_11_02_250206_VTSE41", "VTSE41"), clock(1_299_822_540_001));
  const value = JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(first.state))) as { intents: Record<string, unknown>[];
    forecasts: (Record<string, unknown> & { areas: Record<string, unknown>[] })[] };
  // 終端記録は無くなった（P3-NL-AC05）ので予報の区域名で埋める。
  const withPad = (pad: number, schemaVersion: string = tsunamiUnitCodec.schemaVersion) => ({ ...value, schemaVersion, intents: [value.intents[0]],
    forecasts: [{ ...value.forecasts[0], areas: [{ ...value.forecasts[0].areas[0], name: `${String(value.forecasts[0].areas[0].name)}${"x".repeat(pad)}` },
      ...value.forecasts[0].areas.slice(1)] }, ...value.forecasts.slice(1)] }) as unknown as JsonValue;
  const growth = deliveryGrowth(value.intents[0] as unknown as TsunamiIntent);
  const size = (pad: number, reserve: number) => serializedEnvelope({ schemaVersion: tsunamiUnitCodec.schemaVersion, unit: "U-T", generation: 0,
    capturedAt: 0, payload: withPad(pad), sha256: "0".repeat(64) }).byteLength + 62 + reserve + LOSS_TALLY_MAX_BYTES + growth;
  const directory = mkdtempSync(join(tmpdir(), "fleq-vm-old-"));
  try {
    // 旧い版は容量の検査の前に版で捨てるので、slot の大きさは問わない。
    for (const [side, generation] of [["A", 1], ["B", 2]] as const) writeFileSync(join(directory, `U-T-${side}.json`),
      serializedEnvelope(hashEnvelope({ schemaVersion: "p3-tsunami-unit-v1", unit: "U-T", generation, capturedAt: 1, payload: withPad(0, "p3-tsunami-unit-v1") })));
    const events: { reason: string; unit?: string; component: string }[] = [];
    const files = nodeCheckpointFileSystem();
    const coordinator = new CheckpointCoordinator(directory, { "U-T": tsunamiUnitCodec }, files, () => ({ wallTimeMs: 5_000, monotonicMs: 5 }),
      (event) => { events.push(event); });
    expect(coordinator.restoreUnit("U-T")).toEqual({ kind: "empty" });
    expect(events.filter((event) => event.reason === "checkpointSchemaDiscarded"))
      .toMatchObject([{ unit: "U-T", component: "checkpoint.p3-tsunami-unit-v1" }]);
    // The next save: the largest state the unit admits now, with the longest input boundary.
    const limit = tsunamiUnitCodec.maxEnvelopeBytes!;
    const decoded = tsunamiUnitCodec.decode(withPad(limit - size(0, INPUT_BOUNDARY_MAX_BYTES)));
    if (decoded.kind !== "restored") throw new Error("the reserved limit must restore");
    expect(tsunamiUnitCodec.decode(withPad(limit - size(0, INPUT_BOUNDARY_MAX_BYTES) + 1)).kind).toBe("invalid");
    const longest = -0.0000012345678901234567;
    const captured = coordinator.capture("U-T", decoded.state, 3, "k7", { inputIds: ["live-1"], retryReason: "notRetry" },
      { receivedAt: { wallTimeMs: longest, basis: "unverified" }, dmdataTime: longest, dmdataId: "~".repeat(128), oldestHole: "disconnected" });
    if (captured.request == null) throw new Error("the admitted state must be captured");
    expect(captured.request.encodedByteLength).toBeLessThanOrEqual(limit);
    const executed = await coordinator.executeCheckpoint(captured.request, "k7", ["live-1"], "notRetry");
    expect(executed.result.kind).toBe("acknowledged");
    expect(new CheckpointCoordinator(directory, { "U-T": tsunamiUnitCodec }, files, () => ({ wallTimeMs: 0, monotonicMs: 0 }), () => {})
      .restoreUnit("U-T")).toMatchObject({ kind: "restored", slot: "A", envelope: { generation: 3 } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// P3-NL-AC08 (1)(4)・AC15 (4): started の pending は復元で外れ、failed・null の pending は欄ごと戻る。
it("P3-NL-T07 contractBoundary / AC08・AC15 (4): U-T restores failed and null pending with their fields and drops a started one", () => {
  const warning = decodeFixture("synthetic_VTSE41_e01_311warning", "VTSE41");
  const issued = receive(emptyState(), warning, clock(Date.parse(warning.reportDateTimeRaw)));
  expectRestoreStarted({ intents: [issued.intents[0], issued.intents[1]], make: (intents) => ({ ...issued.state, intents }),
    restore: (state, at) => run(emptyState(), { kind: "restore", persisted: tsunamiUnitCodec.encode(state), clock: at }),
    markOf: (state, subject) => state.forecasts.find((item) => item.subject === subject)?.notice });
});
