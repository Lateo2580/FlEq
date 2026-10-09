import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { DecodedMaterial, Operation, XmlElement } from "../../contracts/p1-parser-boundary.types";
import type { WeatherTimeseriesCompoundField, WeatherTimeseriesValue, WeatherTimeseriesSnapshot, WeatherTimeseriesSubject, WeatherTimeseriesUnitState } from "../../contracts/p2-weather-timeseries-unit.types";
import { serializedEnvelope } from "../../src/checkpoint/checkpoint";
import { classifyMaterial, decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { callsWith } from "../unit-table/linked-calls";
import { deliveryGrowth } from "../../src/notification-delivery/delivery-growth";
import { checkpointResultOwner, intentUpdateOwner, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { linkedUnitCodecs, linkedUnitTable, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { reduceWeatherTimeseriesUnit, toWeatherTimeseriesView, weatherTimeseriesUnitCodec } from "../../src/units/weather-timeseries/weather-timeseries-unit";
import { fixtureDriver, fixtureState, ownerFixture, recordingNotificationAdapter } from "../checkpoint-shutdown/runtime-fixture";
import { envelope, harnessedRoot, seeded, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";

const DATE = Date.parse("2026-06-05T17:00:00+09:00");
const clock = (wallTimeMs = DATE, monotonicMs = 1) => ({ wallTimeMs, monotonicMs });
function empty(): WeatherTimeseriesUnitState {
  return { schemaVersion: "p2-weather-timeseries-unit-v1", contentRevision: 0, subjects: [], gates: [], intents: [],
    persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0,
      savedCapturedAt: null, savedAckAt: null, dirtySince: null } };
}
function fixtureBody(name: string, transform: (xml: string) => string = (xml) => xml, operation: Operation = "normal"): Buffer {
  const xml = transform(readFileSync(`test/fixtures/${name}.xml`, "utf8"));
  return Buffer.from(operation === "normal" ? xml : xml.replace("<Status>通常</Status>",
    `<Status>${operation === "training" ? "訓練" : "試験"}</Status>`));
}
function fixture(name: string, transform: (xml: string) => string = (xml) => xml, operation: Operation = "normal"): DecodedMaterial {
  const body = fixtureBody(name, transform, operation);
  const entered = ingestXmlData({ inputId: name, inputSequence: 1, receivedAt: DATE, origin: "replay", kind: "replay",
    body, headType: "VPWP50" });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
const unknown = "81_03_01_260605_VPWP50_unknown_code";
const cancel = "81_04_01_260605_VPWP50_cancel";
function receive(state: WeatherTimeseriesUnitState, material: DecodedMaterial, wallTimeMs = DATE) {
  return reduceWeatherTimeseriesUnit(state, { kind: "receive", material, clock: clock(wallTimeMs) });
}
function first(state: WeatherTimeseriesUnitState): WeatherTimeseriesSubject { return state.subjects[0]; }
function inflated(state: WeatherTimeseriesUnitState, targetBytes: number): WeatherTimeseriesUnitState {
  const item = first(state), at = item.areas[0].name!;
  const payload = weatherTimeseriesUnitCodec.encode(state);
  const base = serializedEnvelope({ schemaVersion: state.schemaVersion, unit: "U-F", generation: 0,
    capturedAt: 0, payload, sha256: "0".repeat(64) }).byteLength + 62;
  const added = targetBytes - base;
  if (added < 0) throw new Error("target is below base size");
  return { ...state, subjects: state.subjects.map((subject, position) => position === 0
    ? { ...subject, strings: subject.strings.map((value, index) => index === at ? value + "x".repeat(added) : value) }
    : subject) };
}

// T03/AC04: an XML oracle keys values by the contract's logical ID, independently of table indexes.
function xmlMeaning(material: DecodedMaterial): string[] {
  const children = (node: XmlElement, name?: string): XmlElement[] => node.children.filter((child): child is XmlElement =>
    child.kind === "element" && (name == null || child.name === name));
  const raw = (node: XmlElement): string => node.children.filter((child) => child.kind === "text").map((child) => child.value).join("");
  const text = (node: XmlElement, name: string): string | null => {
    const child = children(node, name)[0]; return child == null ? null : raw(child);
  };
  const attr = (node: XmlElement, name: string) => node.attributes.find((item) => item.name === name)?.value ?? null;
  const fields = (node: XmlElement): unknown[] => children(node).map((child) =>
    [child.name, child.attributes, children(child).length === 0 ? raw(child) : fields(child)]);
  const result: string[] = [];
  children(children(material.xml, "Body")[0], "MeteorologicalInfos").forEach((infos, infoPosition) => {
    children(infos, "TimeSeriesInfo").forEach((series, seriesPosition) => {
      const times = children(children(series, "TimeDefines")[0], "TimeDefine");
      for (const item of children(series, "Item")) {
        const area = children(item, "Area")[0];
        for (const kind of children(item, "Kind")) for (const property of children(kind, "Property")) {
          const visit = (parent: XmlElement, placement: string, local: readonly unknown[] | null) => {
            for (const value of children(parent)) {
              const ref = attr(value, "refID");
              if (ref == null) continue;
              const time = times.find((time) => attr(time, "timeId") === ref)!;
              const date = children(kind, "DateTime")[0];
              result.push(JSON.stringify([[infoPosition, seriesPosition, text(area, "Code"), text(property, "Type"),
                placement, local, value.name, attr(value, "type"), ref],
              [text(area, "Name"), text(kind, "Status"), date == null ? null : raw(date), date == null ? null : attr(date, "type"),
                text(time, "DateTime"), text(time, "Duration"), text(time, "Name")],
              value.attributes.filter((item) => !["refID", "type"].includes(item.name)).map((item) => [item.name, item.value]),
              value.name === "Significancy" ? [text(value, "Name"), text(value, "Code")]
                : ["PeakTime", "CriteriaPeriod"].includes(value.name) ? fields(value) : raw(value)]));
            }
          };
          visit(property, "Property", null);
          for (const part of children(property).filter((part) => part.name.endsWith("Part"))) {
            for (const base of children(part, "Base")) {
              visit(base, part.name + "/Base", null);
              children(base, "Local").forEach((local, position) => {
                const areaName = children(local, "AreaName")[0];
                const identity = [text(local, "Code"), areaName == null ? null : attr(areaName, "code"),
                  text(local, "AreaName"), text(local, "Name")];
                visit(local, part.name + "/Base/Local", [...identity,
                  identity.every((value) => value == null || value === "") ? position : null]);
              });
            }
          }
        }
      }
    });
  });
  return result.sort();
}
function storedMeaning(snapshot: WeatherTimeseriesSnapshot): string[] {
  const text = (index: number | null) => index == null ? null : snapshot.strings[index];
  const fields = (values: readonly WeatherTimeseriesCompoundField[]): unknown[] => values.map((field) =>
    [field.name, field.attributes, Array.isArray(field.value) ? fields(field.value) : raw(field.value as WeatherTimeseriesValue)]);
  const raw = (value: WeatherTimeseriesValue): unknown => value.kind === "significancy" ? [raw(value.name), raw(value.code)]
    : value.kind === "peakTime" || value.kind === "criteriaPeriod" ? fields(value.fields) : "raw" in value ? value.raw : null;
  return snapshot.periods.map((row) => {
    const series = snapshot.series[row[0]], area = snapshot.areas[row[1]], kind = snapshot.kinds[row[2]],
      time = series.timeDefines[row[8]], local = row[5] == null ? null : snapshot.locals[row[5]];
    return JSON.stringify([[series.meteorologicalInfosPosition, series.timeSeriesInfoPosition, text(area.code), text(row[3]),
      text(row[4]), local == null ? null : [text(local.code), text(local.areaNameCode), text(local.areaName), text(local.name), local.anonymousPosition],
      text(row[6]), text(row[7]), text(time.timeId)],
    [text(area.name), text(kind.status), text(kind.dateTimeRaw), text(kind.dateTimeType), text(time.dateTimeRaw), text(time.durationRaw), text(time.name)],
    snapshot.attributes[row[9]].map(([name, value]) => [text(name), text(value)]), raw(snapshot.values[row[10]])]);
  }).sort();
}

// T03: independently reindex every string reference to detect cross-snapshot index assumptions.
function reordered(snapshot: WeatherTimeseriesSnapshot): WeatherTimeseriesSnapshot {
  const index = (at: number): number => snapshot.strings.length - 1 - at;
  const optional = (at: number | null): number | null => at == null ? null : index(at);
  return { ...snapshot, strings: [...snapshot.strings].reverse(),
    attributes: snapshot.attributes.map((pairs) => pairs.map(([a, b]) => [index(a), index(b)])),
    series: snapshot.series.map((series) => ({ ...series, timeDefines: series.timeDefines.map((time) => ({ ...time,
      timeId: index(time.timeId), dateTimeRaw: index(time.dateTimeRaw), durationRaw: index(time.durationRaw), name: optional(time.name) })) })),
    areas: snapshot.areas.map((area) => ({ code: index(area.code), name: optional(area.name) })),
    locals: snapshot.locals.map((local) => ({ ...local, code: optional(local.code), areaNameCode: optional(local.areaNameCode),
      areaName: optional(local.areaName), name: optional(local.name) })),
    kinds: snapshot.kinds.map((kind) => ({ status: optional(kind.status), dateTimeRaw: optional(kind.dateTimeRaw), dateTimeType: optional(kind.dateTimeType) })),
    periods: snapshot.periods.map((row) => [row[0], row[1], row[2], index(row[3]), index(row[4]), row[5],
      index(row[6]), optional(row[7]), row[8], row[9], row[10]]) };
}

describe("P2-A6 weather timeseries", () => {
  it("A8-COST regression: real A6 delivery updates reuse subject deadlines without reading elements", () => {
    const active = receive(empty(), fixture(unknown)).state;
    const seed = first(active);
    let reads = 0;
    const subjects = new Proxy(Array.from({ length: 512 }, (_, index) => ({ ...seed, subject: `normal/VPWP50/${index}` })), {
      get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); },
    });
    const notice = { unit: "U-F", id: "delivery", disposition: "pending", expiresAt: DATE + 1_000,
      subject: seed.subject, operation: "normal", channel: "desktop", transition: "activated", source: seed.source!,
      payload: {}, createdAt: DATE, nextAttemptAt: DATE, attempts: 0, configRevision: "test" } as const;
    const ready = reduceWeatherTimeseriesUnit({ ...active, subjects, intents: [notice] },
      { kind: "deadline", clock: clock() });
    reads = 0;
    const delivered = reduceWeatherTimeseriesUnit(ready.state, { kind: "intentUpdate", clock: clock(DATE + 1),
      intentUpdate: { id: notice.id, attempts: 1, nextAttemptAt: DATE + 1, disposition: "delivered" } });
    expect(delivered.state.intents[0].disposition).toBe("delivered");
    expect(delivered.nextDeadline).toEqual({ wallTimeMs: DATE + 1_000, monotonicMs: null });
    expect(delivered.displayChanges).toEqual([]);
    expect(reads).toBe(0);
  });
  it("A8-COST regression: an intent-only expiry keeps subjects and their cached deadline without reading elements", () => {
    const active = receive(empty(), fixture(unknown)).state;
    const seed = first(active);
    let reads = 0;
    const subjects = new Proxy(Array.from({ length: 512 }, (_, index) => index === 0 ? seed : { ...seed, subject: `normal/VPWP50/${index}` }), {
      get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); },
    });
    const notice = { unit: "U-F", id: "expiring", disposition: "delivered", expiresAt: DATE + 1_000,
      subject: seed.subject, operation: "normal", channel: "desktop", transition: "activated", source: seed.source!,
      payload: {}, createdAt: DATE, nextAttemptAt: DATE, attempts: 1, configRevision: "test" } as const;
    const ready = reduceWeatherTimeseriesUnit({ ...active, subjects, intents: [notice] }, { kind: "deadline", clock: clock() });
    reads = 0;
    const collected = reduceWeatherTimeseriesUnit(ready.state, { kind: "deadline", clock: clock(DATE + 1_000) });
    expect(collected.state.intents).toEqual([]);
    expect(collected.state.subjects).toBe(subjects);
    expect(collected.state.persistence.currentGeneration).toBe(ready.state.persistence.currentGeneration + 1);
    expect(collected.displayChanges).toEqual([]);
    expect(reads).toBe(0);
    expect(collected.nextDeadline?.wallTimeMs).toBeGreaterThan(DATE + 1_000);
  });
  it("P2-A6-T03 contractBoundary: every intent disposition needs a finite expiry before deadline scheduling", () => {
    const base = weatherTimeseriesUnitCodec.encode(empty());
    const dispositions = ["pending", "delivered", "expired", "superseded"] as const;
    for (const [index, disposition] of dispositions.entries()) {
      const notice = { unit: "U-F", id: disposition, disposition, expiresAt: DATE + 1_000,
        subject: "normal/VPWP50/test", operation: "normal", channel: "desktop", transition: "activated",
        source: { inputId: "expiry-boundary", origin: "replay", operation: "normal", family: "VPWP50",
          subject: "normal/VPWP50/test", reportDateTimeRaw: new Date(DATE).toISOString(), serialRaw: "", infoTypeRaw: "発表" },
        payload: { title: "boundary", body: "boundary" }, createdAt: DATE, nextAttemptAt: DATE,
        attempts: 0, configRevision: "test" } as const;
      const valid = weatherTimeseriesUnitCodec.decode({ ...base, intents: [notice] });
      if (valid.kind !== "restored") throw new Error("finite expiry must restore");
      expect(reduceWeatherTimeseriesUnit(valid.state, { kind: "deadline", clock: clock() }).nextDeadline)
        .toEqual({ wallTimeMs: DATE + 1_000, monotonicMs: null });
      const invalid = [null, "later", Infinity, NaN][index];
      expect(weatherTimeseriesUnitCodec.decode({ ...base, intents: [{ ...notice, expiresAt: invalid }] }).kind).toBe("invalid");
      const { expiresAt: _expiresAt, ...missing } = notice;
      expect(weatherTimeseriesUnitCodec.decode({ ...base, intents: [missing] }).kind).toBe("invalid");
    }

    // P3-IUR-AC01・AC02・AC06: 実 byte は上限ちょうどで予約を足すと超える pending と世代、予約の式が頼る attempts・nextAttemptAt の値域。
    const notice = (id: string, body: string, disposition: "pending" | "delivered" = "pending") => ({ unit: "U-F", id, disposition,
      expiresAt: DATE + 1_000, subject: "normal/VPWP50/test", operation: "normal", channel: "desktop", transition: "activated",
      source: { inputId: "reserve-boundary", origin: "replay", operation: "normal", family: "VPWP50", subject: "normal/VPWP50/test",
        reportDateTimeRaw: new Date(DATE).toISOString(), serialRaw: "", infoTypeRaw: "発表" },
      payload: { title: "boundary", body }, createdAt: DATE, nextAttemptAt: DATE, attempts: 0, configRevision: "test" } as const);
    const growth = deliveryGrowth(notice("a", ""));
    const pad = 131_072 - Buffer.byteLength(JSON.stringify([notice("a", "")]));
    expect(Buffer.byteLength(JSON.stringify([notice("a", "x".repeat(pad))]))).toBe(131_072);
    expect(weatherTimeseriesUnitCodec.decode({ ...base, intents: [notice("a", "x".repeat(pad))] }).kind).toBe("invalid");
    expect(weatherTimeseriesUnitCodec.decode({ ...base, intents: [notice("a", "x".repeat(pad - growth))] }).kind).toBe("restored");
    const wire = (length: number) => ({ ...base, intents: [notice("a", ""), notice("b", "x".repeat(length), "delivered")] });
    const generation = (length: number) => serializedEnvelope({ schemaVersion: "p2-weather-timeseries-unit-v1", unit: "U-F", generation: 0,
      capturedAt: 0, payload: wire(length), sha256: "0".repeat(64) }).byteLength + 62;
    const length = 33_554_432 - generation(0);
    expect(generation(length)).toBe(33_554_432);
    expect(weatherTimeseriesUnitCodec.decode(wire(length)).kind).toBe("invalid");
    expect(weatherTimeseriesUnitCodec.decode(wire(length - growth)).kind).toBe("restored");
    for (const patch of [{ attempts: Number.MAX_SAFE_INTEGER + 1 }, { attempts: -1 }, { attempts: 0.5 }, { nextAttemptAt: Infinity },
      { nextAttemptAt: "soon" }, { nextAttemptAt: null }])
      expect(weatherTimeseriesUnitCodec.decode({ ...base, intents: [{ ...notice("a", ""), ...patch }] }).kind, JSON.stringify(patch)).toBe("invalid");
    // 配列などの非文字列は String() で列挙値に化けて pending の計量から外れるので、型ごと拒否する（P3-IUR-AC06）。
    for (const patch of [{ disposition: ["pending"] }, { transition: ["updated"] }, { operation: ["normal"] }])
      expect(weatherTimeseriesUnitCodec.decode({ ...base, intents: [{ ...notice("a", ""), ...patch }] }).kind, JSON.stringify(patch)).toBe("invalid");
    // 値域は狭めない: 最長の attempts・nextAttemptAt は受ける。
    expect(weatherTimeseriesUnitCodec.decode({ ...base, intents: [{ ...notice("a", ""), attempts: Number.MAX_SAFE_INTEGER,
      nextAttemptAt: -0.0000018927186924017318 }] }).kind).toBe("restored");
  });

  // 実不具合の再発防止（台帳 73）: 合成の保存物の pending が予約込みの上限でも、配送の更新の後の encode が拒否しない。
  it("P3-IUR-T06 regression / P3-IUR-AC01,AC02,AC03,AC06: synthetic pending at its budget survives delivery updates, encode and decode through the owner", () => {
    const base = weatherTimeseriesUnitCodec.encode(empty());
    const make = (pad: number) => Array.from({ length: 64 }, (_, index) => ({ unit: "U-F", id: `intent-${index}`, disposition: "pending",
      expiresAt: DATE + 1_000, subject: "normal/VPWP50/test", operation: "normal", channel: "desktop", transition: "activated",
      source: { inputId: "reserve-flow", origin: "replay", operation: "normal", family: "VPWP50", subject: "normal/VPWP50/test",
        reportDateTimeRaw: new Date(DATE).toISOString(), serialRaw: "", infoTypeRaw: "発表" },
      payload: { title: "boundary", body: index === 0 ? "x".repeat(pad) : "" }, createdAt: DATE, nextAttemptAt: DATE,
      attempts: 0, configRevision: "test" } as const));
    const reserved = (items: ReturnType<typeof make>) => items.reduce((sum, item) => sum + deliveryGrowth(item), 0);
    const pending = make(131_072 - Buffer.byteLength(JSON.stringify(make(0))) - reserved(make(0)));
    expect(Buffer.byteLength(JSON.stringify(pending)) + reserved(pending)).toBe(131_072);
    const roundTrip = (state: WeatherTimeseriesUnitState) =>
      weatherTimeseriesUnitCodec.decode(JSON.parse(JSON.stringify(weatherTimeseriesUnitCodec.encode(state))));
    const first = weatherTimeseriesUnitCodec.decode(JSON.parse(JSON.stringify({ ...base, intents: pending })));
    if (first.kind !== "restored") throw new Error("the synthetic payload does not decode");
    const now = clock();
    const owner0 = restoreOwner({ runId: "run", place: "deferred", clock: now, restored: { "U-F": { kind: "empty" } } },
      linkedUnitTable, linkedUnitCodecs).state;
    const owner = { ...owner0, units: { ...owner0.units, "U-F": first.state } };
    const update = (from: Parameters<typeof intentUpdateOwner>[0], split: boolean) => intentUpdateOwner(from, "U-F", from.units["U-F"]!.intents.map((item, index) => ({ id: item.id, attempts: Number.MAX_SAFE_INTEGER,
      nextAttemptAt: -0.0000018927186924017318, disposition: split && index % 3 === 1 ? "superseded" as const : "pending" as const })), now, linkedUnitTable);
    // 全 pending が最長へ伸びる更新（予約の不変条件、AC03）→ 3 件に 1 件が終端になる更新、のそれぞれの後で保存と復元ができる。
    const widened = update(owner, false);
    expect(widened.adopted).toBe(true);
    expect(roundTrip(widened.state.units["U-F"]!).kind).toBe("restored");
    const grown = update(widened.state, true);
    expect(grown.adopted).toBe(true);
    expect(roundTrip(grown.state.units["U-F"]!).kind).toBe("restored");
  });

  // T01: one contract boundary table covers valid empty/cancel and first rejection reason.
  it("T01 accepts explicit empty and cancellation, rejects broken family structure atomically", () => {
    const initial = empty();
    const material = fixture(unknown);
    const active = receive(initial, material);
    expect(active.decisions[0]).toMatchObject({ decision: "changed", change: "semantic" });
    const cases = [
      [fixture(cancel), "cancelled"],
      [fixture(unknown, (xml) => xml.replace(/<TimeSeriesInfo>[\s\S]*?<\/TimeSeriesInfo>/, "")), "noActiveItems"],
    ] as const;
    for (const [next, effective] of cases) {
      const accepted = receive(initial, next);
      expect(accepted.decisions[0].decision).toBe("changed");
      expect(first(accepted.state).effective).toBe(effective);
    }
    const nested = receive(initial, fixture("81_06_01_260605_VPWP50_criteria_period"));
    const sibling = receive(initial, fixture("81_08_01_260605_VPWP50_criteria_property_sibling"));
    expect(first(nested.state).periods.some((row) => first(nested.state).values[row[10]].kind === "criteriaPeriod")).toBe(true);
    expect(first(sibling.state).periods.some((row) => first(sibling.state).strings[row[4]] === "Property")).toBe(true);
    const bad = [
      [fixture("81_09_01_260605_VPWP50_local_identity"), "identityMissing"],
      [fixture(unknown, (xml) => xml.replace("<Body", "<AbsentBody").replace("</Body>", "</AbsentBody>")), "requiredStructureMissing"],
      [fixture(unknown, (xml) => xml.replace('refID="2"', 'refID="bad"')), "requiredStructureInvalid"],
      [fixture(unknown, (xml) => xml.replace('timeId="2"', 'timeId="1"')), "requiredStructureInvalid"],
      // Review 6: identity wins over family invalid; invalid parent cannot invent missing children.
      [fixture(unknown, (xml) => xml.replace('type="量的予想時系列（市町村等）"', 'type="bad"')
        .replace("<Code>0121400</Code>", "")), "identityMissing"],
      [fixture(unknown, (xml) => xml.replace(/<TimeDefines>[\s\S]*?<\/TimeDefines>/,
        "<TimeDefines>broken</TimeDefines>")), "requiredStructureInvalid"],
      [fixture(unknown, (xml) => xml.replace(/<Body[^>]*>[\s\S]*?<\/Body>/, "<Body>broken</Body>")), "requiredStructureInvalid"],
      [fixture(unknown, (xml) => xml.replace(/<Kind>[\s\S]*?<\/Kind>/g, "<Kind>broken</Kind>")), "requiredStructureInvalid"],
      // A valid sibling's actual missing child still precedes a different container's invalid type.
      [fixture(unknown, (xml) => xml.replace('type="量的予想時系列（市町村等）"', 'type="bad"')
        .replace("</Body>", '<MeteorologicalInfos type="量的予想時系列（市町村等）"><TimeSeriesInfo/></MeteorologicalInfos></Body>')),
        "requiredStructureMissing"],
      // Review 2-1: invalid Base/Local text stops descendant refID checks.
      ...["broken<Significancy/>", "<Local>broken<Significancy/></Local>"].map((body) =>
        [fixture(unknown, (xml) => xml.replace(/<Base>[\s\S]*?<\/Base>/, `<Base>${body}</Base>`)),
          "requiredStructureInvalid"] as const),
      // Review 7: finite duration whose endpoint is outside Date's range.
      [fixture(unknown, (xml) => xml.replace("PT3H", "P100000000D")), "requiredStructureInvalid"],
    ] as const;
    for (const [next, reason] of bad) {
      const rejected = receive(active.state, next);
      expect(rejected.decisions).toMatchObject([{ decision: "rejected", reason }]);
      expect(rejected.state).toBe(active.state);
      expect(rejected.diagnostics).toHaveLength(1);
    }
  });

  // T02/T04: O02:6 retains known and unknown raw values with time and area.
  it("T02/T04 keeps unknown Significancy and normal source values", () => {
    const adopted = receive(empty(), fixture(unknown));
    const item = first(adopted.state);
    expect(item.effective).toBe("active");
    expect(item.periods).toHaveLength(4);
    const values = item.periods.map((row) => item.values[row[10]]);
    expect(values).toMatchObject([
      { kind: "significancy", code: { kind: "text", raw: "31" } },
      { kind: "significancy", code: { kind: "unknown", raw: "99" } },
      { kind: "significancy", code: { kind: "unknown", raw: "12" } },
      { kind: "significancy", code: { kind: "text", raw: "01" } },
    ]);
    expect(item.strings[item.areas[item.periods[0][1]].code]).toBe("0121400");
    expect(item.series[item.periods[0][0]].timeDefines[item.periods[0][8]].endMs).toBeGreaterThan(DATE);
    expect(adopted.decisions[0]).toMatchObject({ currentEstablished: { family: "VPWP50", affectedScope: "subject" } });
    expect(adopted.outcomes[0]).toMatchObject({ subjects: [{ facts: { knownMaxCode: "31" } }] });
    expect(adopted.nextDeadline).toEqual({ wallTimeMs: item.validUntil, monotonicMs: null });
    const missing = receive(empty(), fixture(unknown, (xml) => xml.replace("<Name>未知</Name><Code>99</Code>",
      "<Name/><Code/>").replace("<Name>未知</Name><Code>12</Code>", "<Name>未知</Name>")));
    const changed = first(missing.state);
    expect(changed.effective).toBe("active");
    expect(changed.values[changed.periods[1][10]]).toMatchObject({ name: { kind: "empty" }, code: { kind: "empty" } });
    expect(changed.values[changed.periods[2][10]]).toMatchObject({ code: { kind: "missing" } });
    // Review 2/3: absent names never contribute, and code syntax never becomes a numeric range.
    for (const name of ["<Name/>", ""]) {
      const excluded = receive(empty(), fixture(unknown, (xml) => xml.replace("<Name>警戒レベル3相当</Name>", name)
        .replace("<Code>99</Code>", "<Code>99以上</Code>")));
      expect(first(excluded.state).effective).toBe("active");
      expect(excluded.outcomes[0]).toMatchObject({ subjects: [{ facts: { knownMaxCode: "01" } }] });
      expect(first(excluded.state).values[first(excluded.state).periods[1][10]])
        .toMatchObject({ code: { kind: "unknown", raw: "99以上" } });
    }
    const tooSoon = reduceWeatherTimeseriesUnit(adopted.state, { kind: "deadline", clock: clock(DATE + 1) });
    expect(tooSoon.state).toBe(adopted.state);
    expect(tooSoon.decisions).toEqual([]);
    const retained = reduceWeatherTimeseriesUnit(adopted.state, { kind: "deadline", clock: clock(DATE + 7 * 86_400_000) });
    expect(retained.state.subjects).toEqual([]);
    expect(retained.state.gates).toEqual([]);
    expect(retained.outcomes).toEqual([]);
    expect(retained.displayChanges).toMatchObject([{ unit: "U-F", before: { current: { effective: "active" } }, after: null }]);
    expect(retained.state.contentRevision).toBe(adopted.state.contentRevision + 1);
    expect(retained.state.persistence.currentGeneration).toBe(adopted.state.persistence.currentGeneration + 1);
  });

  // T02 regression 1/4: compound local-name classification and P1's scalar semantics share one boundary.
  it("T02 accepts qualified compounds and reuses P1 scalar values without changing raw", () => {
    const material = fixture(unknown, (xml) => xml
      .replace('<Body xmlns=', '<Body xmlns:w="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" xmlns=')
      .replaceAll("<Significancy ", "<w:Significancy ").replaceAll("</Significancy>", "</w:Significancy>")
      .replace("</Base>", '<Value refID="1" condition="不明"/><Value refID="2">５０以上</Value>'
        + '<Amount refID="1">５０</Amount><Amount refID="2">５０以下</Amount></Base>'));
    const adopted = receive(empty(), material), item = first(adopted.state);
    expect(adopted.decisions[0].decision).toBe("changed");
    expect(item.strings[item.periods[0][6]]).toBe("w:Significancy");
    expect(item.values[item.periods[0][10]].kind).toBe("significancy");
    const p1 = classifyMaterial(material).fields.filter((field) => /\/(Value|Amount)\[/.test(field.path)).map((field) => field.value);
    const actual = item.periods.filter((row) => ["Value", "Amount"].includes(item.strings[row[6]])).map((row) => item.values[row[10]]);
    expect(actual).toEqual(p1);
    expect(actual).toMatchObject([{ kind: "unknown", raw: "" }, { kind: "range", value: 50, raw: "５０以上" },
      { kind: "number", value: 50, raw: "５０" }, { kind: "range", bound: "upper", raw: "５０以下" }]);
  });

  // T03 regression 5: persisted dictionary order cannot turn a revision into a semantic change.
  it("T03 compares newer reports by resolved values after independent dictionary restoration", () => {
    const seed = receive(empty(), fixture(unknown)).state;
    const persisted = weatherTimeseriesUnitCodec.encode({ ...seed, subjects: [{ ...first(seed), ...reordered(first(seed)) }] });
    const decoded = weatherTimeseriesUnitCodec.decode(persisted);
    expect(decoded.kind).toBe("restored");
    if (decoded.kind !== "restored") return;
    const newer = fixture(unknown, (xml) => xml.replace("17:00:00+09:00</ReportDateTime>", "18:00:00+09:00</ReportDateTime>"));
    expect(receive(decoded.state, newer).decisions[0]).toMatchObject({ decision: "changed", change: "revisionOnly" });
  });

  // T03/T04: O02:14 has 16,704 refID-bearing values, not the old 194-period cap.
  it("T03/T04 roundtrips the large fixture and independent Local identity fields", () => {
    const big = fixture("81_09_01_260605_VPWP50");
    const adopted = receive(empty(), big, Date.parse(big.reportDateTimeRaw));
    expect(first(adopted.state).periods).toHaveLength(16_704);
    expect(storedMeaning(first(adopted.state))).toEqual(xmlMeaning(big));
    const encoded = weatherTimeseriesUnitCodec.encode(adopted.state);
    const restored = weatherTimeseriesUnitCodec.decode(JSON.parse(JSON.stringify(encoded)));
    expect(restored.kind).toBe("restored");
    if (restored.kind !== "restored") return;
    expect(restored.state.subjects[0]).toEqual(first(adopted.state));
    const tinyMaterial = fixture("81_07_01_260605_VPWP50_local_area", (xml) =>
      xml.replace("<AreaName>陸上</AreaName>", '<AreaName code="L003">陸上</AreaName><Code>L004</Code>'));
    const tiny = receive(empty(), tinyMaterial);
    expect(storedMeaning(first(tiny.state))).toEqual(xmlMeaning(tinyMaterial));
    const local = first(tiny.state).locals.find((item) => item.areaNameCode != null && item.code != null);
    expect(local).toBeDefined();
    expect(first(tiny.state).strings[local!.areaNameCode!]).toBe("L003");
    expect(first(tiny.state).strings[local!.code!]).toBe("L004");
    const broken = { ...encoded, subjects: [{ ...encoded.subjects[0], periods: [[0]] }] };
    expect(weatherTimeseriesUnitCodec.decode(broken).kind).toBe("invalid");
    const envelope = serializedEnvelope({ schemaVersion: encoded.schemaVersion, unit: "U-F", generation: 1,
      capturedAt: Date.parse(big.reportDateTimeRaw), payload: encoded, sha256: "0".repeat(64) });
    expect(envelope.byteLength).toBeLessThanOrEqual(33_554_432);
  });

  // T04/AC09: available normal corpus, including O02:2 at its required evaluation clock.
  it("T04 keeps every local normal VPWP50 fixture available and verifies O02:2", () => {
    const names = ["81_01_01_260129_VPWP50", "81_01_02_260129_VPWP50", "81_01_03_260129_VPWP50",
      "81_01_04_251222_VPWP50", "81_02_01_260605_VPWP50_high_severity", unknown,
      "81_06_01_260605_VPWP50_criteria_period", "81_07_01_260605_VPWP50_local_area",
      "81_08_01_260605_VPWP50_criteria_property_sibling", "81_09_01_260605_VPWP50"];
    for (const name of names) {
      const material = fixture(name), at = name.includes("high_severity") ? DATE + 3_600_000 : Date.parse(material.reportDateTimeRaw);
      const applied = receive(empty(), material, at);
      expect(applied.decisions[0], name).toMatchObject({ decision: "changed", change: "semantic" });
      expect(first(applied.state).effective, name).toBe("active");
      expect(storedMeaning(first(applied.state)), name).toEqual(xmlMeaning(material));
      expect(applied.intents).toEqual([]);
      if (name.includes("high_severity")) {
        expect(first(applied.state)).toMatchObject({ subject: "normal/VPWP50/稚内地方気象台", operation: "normal",
          source: { reportDateTimeRaw: "2026-06-05T17:00:00+09:00", infoTypeRaw: "発表" } });
        expect(applied.outcomes[0]).toMatchObject({ subjects: [{ facts: { knownMaxCode: "50" } }] });
      }
    }
  });

  // T06/T07: candidate replacement, capacity failure and current establishment are distinct.
  it("T06/T07 preserves prior state on 513th normal subject and clears with newer cancellation", () => {
    const active = receive(empty(), fixture(unknown));
    const seed = first(active.state);
    const subjects = Array.from({ length: 512 }, (_, index) => {
      const subject = `normal/VPWP50/office${index}`;
      return { ...seed, subject, source: { ...seed.source!, subject } };
    });
    const state: WeatherTimeseriesUnitState = { ...active.state, subjects,
      gates: subjects.map((item) => ({ subject: item.subject, operation: item.operation, source: item.source! })) };
    const next = receive(state, fixture(unknown, (xml) => xml.replace("稚内地方気象台", "new-office")));
    expect(next.decisions[0].decision).toBe("capacityExceeded");
    expect(next.state).toBe(state);
    const cancelled = receive(active.state, fixture(cancel));
    expect(cancelled.decisions[0]).toMatchObject({ decision: "changed", currentEstablished: { affectedScope: "subject" } });
    expect(first(cancelled.state).effective).toBe("cancelled");
    const room: WeatherTimeseriesUnitState = { ...state, subjects: subjects.slice(0, 511), gates: state.gates.slice(0, 511) };
    const admitted = receive(room, fixture(unknown, (xml) => xml.replaceAll("稚内地方気象台", "new-office")));
    expect(admitted.decisions[0].decision).toBe("changed");
    expect(admitted.state.subjects).toHaveLength(512);
    const training = { ...subjects[0], subject: "training/VPWP50/office0", operation: "training" as const,
      source: { ...subjects[0].source!, subject: "training/VPWP50/office0", operation: "training" as const } };
    const replaceable: WeatherTimeseriesUnitState = { ...state,
      subjects: [training, ...subjects.slice(1)], gates: [
        { subject: training.subject, operation: training.operation, source: training.source }, ...state.gates.slice(1)] };
    const evicted = receive(replaceable, fixture(unknown, (xml) => xml.replaceAll("稚内地方気象台", "new-office")));
    expect(evicted.decisions[0].decision).toBe("changed");
    expect(evicted.state.subjects).toHaveLength(512);
    expect(evicted.state.subjects.some((item) => item.subject === training.subject)).toBe(false);
    expect(evicted.displayChanges).toHaveLength(2);
    const deletion = evicted.displayChanges.find((item) => item.after == null);
    expect(deletion?.before?.unit === "U-F" && deletion.before.current).toBe(training);
    const revision = fixture(unknown, (xml) => xml
      .replace("<EditorialOffice>稚内地方気象台</EditorialOffice>", "<EditorialOffice>office0</EditorialOffice>")
      .replace("2026-06-05T17:00:00+09:00</ReportDateTime>", "2026-06-05T18:00:00+09:00</ReportDateTime>"));
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const replaced = receive(state, revision);
      expect(replaced.state.subjects).toHaveLength(512);
      expect(stringify.mock.calls.filter(([value]) => value != null && typeof value === "object"
        && !Array.isArray(value) && "subject" in value && "periods" in value)).toHaveLength(1);
      expect(stringify.mock.calls.some(([value]) => value === state || value === state.subjects)).toBe(false);
    } finally { stringify.mockRestore(); }
    const unavailable = { ...subjects[0], strings: [], attributes: [], values: [], series: [], areas: [], locals: [], kinds: [], periods: [],
      effective: "unavailable" as const, unavailableReason: "capacityExceeded" as const, validUntil: null };
    const retained = { ...state, subjects: [unavailable, ...subjects.slice(1)] };
    const recovered = receive(retained, revision);
    expect(recovered.decisions[0].decision).toBe("changed");
    expect(recovered.state.subjects).toHaveLength(512);
    expect(recovered.state.subjects.find((item) => item.subject === unavailable.subject)?.effective).toBe("active");
  });

  // T03/T06: RES-01 B is the serialized envelope plus its numeric-field reserve.
  it("T03/T06 enforces 32 MiB immediately below, at, and above the reserved boundary", () => {
    const material = fixture("81_09_01_260605_VPWP50");
    const state = receive(empty(), material, Date.parse(material.reportDateTimeRaw)).state;
    for (const target of [33_554_431, 33_554_432, 33_554_433]) {
      const value = inflated(state, target);
      if (target <= 33_554_432) {
        const payload = weatherTimeseriesUnitCodec.encode(value);
        const actual = serializedEnvelope({ schemaVersion: value.schemaVersion, unit: "U-F", generation: 1,
          capturedAt: Date.parse(material.reportDateTimeRaw), payload, sha256: "0".repeat(64) }).byteLength;
        expect(actual).toBeLessThanOrEqual(target);
        expect(target - actual).toBe(62 - (String(1).length - 1)
          - (String(Date.parse(material.reportDateTimeRaw)).length - 1));
      } else expect(() => weatherTimeseriesUnitCodec.encode(value)).toThrow();
    }
  });

  // T06/T07: a large normal peer forces a valid newer report into unavailable without evicting normal.
  it("T06/T07 admits byte pressure as unavailable, then keeps stage four atomic", async () => {
    const seed = receive(empty(), fixture(unknown)).state;
    const blockerItem = { ...first(seed), subject: "normal/VPWP50/blocker",
      source: { ...first(seed).source!, subject: "normal/VPWP50/blocker" } };
    const blockerBase: WeatherTimeseriesUnitState = { ...seed, subjects: [blockerItem],
      gates: [{ subject: blockerItem.subject, operation: "normal", source: blockerItem.source! }] };
    const blocker = inflated(blockerBase, 33_554_432 - 1_000);
    const unavailable = receive(blocker, fixture(unknown));
    expect(unavailable.decisions[0]).toMatchObject({ decision: "changed", change: "semantic", currentEstablished: null });
    expect(unavailable.state.subjects.find((item) => item.subject === "normal/VPWP50/稚内地方気象台")?.effective).toBe("unavailable");
    expect(unavailable.state.subjects.find((item) => item.subject === blockerItem.subject)).toBeDefined();
    // TEST-PATH (2): U-F starts from the blocker; the publisher verified its coverage before the input arrives.
    const seeds = seeded(callsWith({ ...fixtureDriver().stubs, reduceWeatherTimeseriesUnit, toWeatherTimeseriesView }).units);
    const directory = mkdtempSync(join(tmpdir(), "fleq-a6-t07-"));
    try {
      const h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(directory, "state"),
        legacyStateDirectory: join(directory, "old"), diagnosticDirectory: join(directory, "diagnostics") }, undefined,
      { notificationAdapter: recordingNotificationAdapter(), clock: () => clock(), runtimeCalls: { ...fixtureDriver().calls,
        units: seeds.units } });
      await startHarness(h, "review", clock());
      await seeds.series(h, blocker);
      h.root.dispatch({ kind: "coverageVerified", runId: "review", epoch: h.root.state.confirmation.epoch,
        scopes: [{ unit: "U-F", operation: "normal", kind: "unit" }], clock: clock() });
      await submit(h, envelope("review", "VPWP50", unknown, fixtureBody(unknown), clock(), 1));
      expect(h.root.state.confirmation.units["U-F"].normal).toMatchObject({ whole: null,
        confirmedAt: null, confirmedScopeCount: 0, counts: { startup: 1 },
        scopes: [{ reason: "startup", confirmedAt: null }] });
      await h.root.diagnostics.flush();
    } finally { rmSync(directory, { recursive: true, force: true }); }
    const full = inflated(blockerBase, 33_554_432);
    const refused = receive(full, fixture(unknown));
    expect(refused.decisions[0].decision).toBe("capacityExceeded");
    expect(refused.state.subjects).toHaveLength(1);
    expect(refused.state).toBe(full);
  });

  // T06: lastKnown is taken after expiry and before capacity eviction, then dropped as one snapshot if needed.
  it("T06 preserves or drops whole lastKnown across stages two and three", () => {
    const seed = receive(empty(), fixture(unknown)).state;
    const old = first(seed), blockerSubject = "normal/VPWP50/blocker";
    const blocker = { ...old, subject: blockerSubject, source: { ...old.source!, subject: blockerSubject } };
    const base: WeatherTimeseriesUnitState = { ...seed, subjects: [blocker, old],
      gates: [{ subject: blockerSubject, operation: "normal", source: blocker.source! }, ...seed.gates] };
    const newer = fixture("81_09_01_260605_VPWP50", (xml) => xml
      .replace("<EditorialOffice>長野地方気象台</EditorialOffice>", "<EditorialOffice>稚内地方気象台</EditorialOffice>")
      .replace("<ReportDateTime>2026-06-06T05:00:00+09:00</ReportDateTime>",
        "<ReportDateTime>2026-06-05T18:00:00+09:00</ReportDateTime>"));
    for (const [remaining, keep] of [[1_500, true], [1, false]] as const) {
      const state = inflated(base, 33_554_432 - remaining);
      const applied = receive(state, newer, DATE + 3_600_000);
      expect(applied.decisions[0]).toMatchObject({ decision: "changed", currentEstablished: null });
      const current = applied.state.subjects.find((item) => item.subject === old.subject)!;
      expect(current.effective).toBe("unavailable");
      expect(current.periods).toHaveLength(0);
      expect(current.lastKnown !== null).toBe(keep);
      if (keep) expect(current.lastKnown).toEqual({ strings: old.strings, attributes: old.attributes,
        values: old.values, series: old.series, areas: old.areas, locals: old.locals, kinds: old.kinds,
        periods: old.periods });
      const restored = weatherTimeseriesUnitCodec.decode(weatherTimeseriesUnitCodec.encode(applied.state));
      expect(restored.kind).toBe("restored");
      if (keep && restored.kind === "restored")
        expect(storedMeaning(restored.state.subjects.find((item) => item.subject === old.subject)!.lastKnown!))
          .toEqual(xmlMeaning(fixture(unknown)));
      if (keep) {
        // Review 2-2: the empty current must not replace a nonempty lastKnown on another unavailable update.
        expect(current.lastKnown!.periods).toHaveLength(4);
        const nextMaterial = { ...newer, reportDateTimeRaw: "2026-06-05T19:00:00+09:00" };
        const replaced = receive(applied.state, nextMaterial, DATE + 7_200_000);
        expect(replaced.decisions[0]).toMatchObject({ decision: "changed", currentEstablished: null });
        expect(replaced.state.subjects).toHaveLength(2);
        const updated = replaced.state.subjects.find((item) => item.subject === current.subject)!;
        expect(updated).toMatchObject({ effective: "unavailable", periods: [],
          source: { reportDateTimeRaw: nextMaterial.reportDateTimeRaw } });
        expect(updated.lastKnown).toEqual(current.lastKnown);
        expect(storedMeaning(updated.lastKnown!)).toEqual(xmlMeaning(fixture(unknown)));
      }
    }
  });

  // T06/AC10: target operation is protected; expiry precedes lastKnown capture; stage four rolls expiry back.
  it("T06 protects training/test targets and captures lastKnown after expiry", () => {
    const limit = 33_554_432;
    const seed = receive(empty(), fixture(unknown)).state, blockerOld = first(seed);
    const blocker = first(receive(empty(), fixture(unknown, (xml) => xml.replaceAll("稚内地方気象台", "blocker")
      .replaceAll("<DateTime>2026-06-05T", "<DateTime>2026-06-06T"))).state);
    for (const operation of ["training", "test"] as const) {
      const targetSeed = receive(empty(), fixture(unknown, (xml) => xml, operation)).state, old = first(targetSeed);
      const base = { ...seed, subjects: [blocker, old], gates: [
        { subject: blocker.subject, operation: blocker.operation, source: blocker.source! }, ...targetSeed.gates] };
      const newer = fixture("81_09_01_260605_VPWP50", (xml) => xml
        .replace("<EditorialOffice>長野地方気象台</EditorialOffice>", "<EditorialOffice>稚内地方気象台</EditorialOffice>")
        .replace("<ReportDateTime>2026-06-06T05:00:00+09:00</ReportDateTime>",
          "<ReportDateTime>2026-06-06T01:00:00+09:00</ReportDateTime>"), operation);
      const full = inflated(base, limit - 1_500);
      const applied = receive(full, newer, old.validUntil!);
      const current = applied.state.subjects.find((item) => item.subject === old.subject)!;
      expect(applied.decisions[0]).toMatchObject({ decision: "changed", currentEstablished: null });
      expect(applied.state.subjects).toHaveLength(2);
      expect(current).toMatchObject({ operation, effective: "unavailable", lastKnown: { periods: [], strings: [] } });
      expect(applied.state.gates.some((gate) => gate.subject === current.subject && gate.operation === operation)).toBe(true);
      expect(applied.state.subjects.find((item) => item.subject === blocker.subject)).toBe(full.subjects[0]);

    }
    // Expiry clears one current snapshot but leaves all 512 normal subjects retained.
    const subjects = Array.from({ length: 512 }, (_, index) => {
      const subject = `normal/VPWP50/peer${index}`;
      const original = index === 0 ? blockerOld : blocker;
      return { ...original, subject, source: { ...original.source!, subject } };
    });
    const before = { ...seed, subjects, gates: subjects.map((item) =>
      ({ subject: item.subject, operation: item.operation, source: item.source! })) };
    expect(() => weatherTimeseriesUnitCodec.encode(before)).not.toThrow();
    const refused = receive(before, fixture(unknown), blockerOld.validUntil!);
    expect(refused.decisions[0].decision).toBe("capacityExceeded");
    expect(refused.state).toBe(before);
    expect(refused.state.gates).toBe(before.gates);
    expect(refused.state.persistence).toBe(before.persistence);
    expect(refused.outcomes).toEqual([]);
  });

  // T06: the two reserved unavailable reasons retain their lossless vocabulary in the codec.
  it("T06 roundtrips history and coverage unavailable records without current periods", () => {
    const seed = receive(empty(), fixture(unknown)).state, old = first(seed);
    const lastKnown = { strings: old.strings, attributes: old.attributes, values: old.values,
      series: old.series, areas: old.areas, locals: old.locals, kinds: old.kinds, periods: old.periods };
    for (const reason of ["historyUnavailable", "coverageIncomplete"] as const) {
      const subject: WeatherTimeseriesSubject = { ...old, strings: [], attributes: [], values: [], series: [],
        areas: [], locals: [], kinds: [], periods: [], effective: "unavailable", unavailableReason: reason,
        source: reason === "coverageIncomplete" ? null : old.source, lastKnown: reordered(lastKnown),
        affectedScope: ["period-id"], validUntil: null };
      const saved = weatherTimeseriesUnitCodec.encode({ ...seed, subjects: [subject] });
      const restored = weatherTimeseriesUnitCodec.decode(saved);
      expect(restored.kind).toBe("restored");
      if (restored.kind === "restored") {
        expect(first(restored.state)).toEqual(subject);
        expect(storedMeaning(first(restored.state).lastKnown!)).toEqual(xmlMeaning(fixture(unknown)));
      }
    }
  });

  // T05: A3's product startup path carries saved g into same-time cancellation and a second save.
  it("T05 restores and saves two generations through the composition root", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fleq-a6-"));
    const fail = { write: false, afterRename: false };
    const disk = nodeCheckpointFileSystem();
    let writes = 0;
    // TEST-PATH (2): each run is the publisher with its in-process owners; the business clock is the publisher's.
    let now = clock();
    const calls = callsWith({ ...fixtureDriver().stubs, reduceWeatherTimeseriesUnit, toWeatherTimeseriesView });
    const makeRoot = () => harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq",
      stateDirectory: join(directory, "state"), legacyStateDirectory: join(directory, "old"),
      diagnosticDirectory: join(directory, "diagnostics") }, { "U-F": weatherTimeseriesUnitCodec }, { notificationAdapter: recordingNotificationAdapter(),
      runtimeCalls: calls, clock: () => now,
      checkpointFileSystem: { ...disk, async rename(from, to) {
        await disk.rename(from, to);
        writes++;
        if (fail.afterRename) throw new Error("lost rename response");
      }, async open(path) { const handle = await disk.open(path);
        return { ...handle, async write(data) { if (fail.write) throw new Error("injected write failure");
          await handle.write(data); } }; } },
    });
    let inputSequence = 0;
    const start = async (h: Harness, runId: string, at: ReturnType<typeof clock>) => {
      now = at;
      await startHarness(h, runId, at);
      return h;
    };
    const route = (h: Harness, name: string, at: number, transform?: (xml: string) => string, operation: Operation = "normal") => {
      now = clock(at);
      return submit(h, envelope(h.root.state.runId, "VPWP50", name, fixtureBody(name, transform, operation), now, ++inputSequence));
    };
    // The save of the routed input: it starts at once (P3-UWR-AC03), so faults are set before route(); driving another
    // grant here would retry a failed save at this later clock (AC10(7)).
    const save = async (h: Harness, at: number) => {
      await h.settle();
      now = clock(at, at - DATE + 20_000);
      const done = h.newDone().map((reply) => reply.result);
      if (done.length !== 1 || done[0] == null) throw new Error("checkpoint not scheduled");
      return done[0];
    };
    const unit = (h: Harness) => h.unit("U-F");
    try {
      const a = await start(makeRoot(), "a", clock());
      await route(a, unknown, DATE);
      expect(unit(a).persistence.currentGeneration).toBe(1);
      const oldAck = await save(a, DATE);
      expect(oldAck.kind).toBe("acknowledged");
      const activeUntil = first(unit(a)).validUntil!;
      const expired = await start(makeRoot(), "expiry", clock(activeUntil));
      expect(unit(expired).persistence).toMatchObject({ currentGeneration: 2, savedGeneration: 1 });
      expect(first(unit(expired)).effective).toBe("noActiveItems");
      const b = await start(makeRoot(), "b", clock(DATE + 2));
      const restoredStep = b.delivered.flatMap(({ place, reply }) =>
        place === "deferred" && reply.kind === "restored" ? [reply.output] : [])[0];
      expect(restoredStep.displayChanges).toMatchObject([{ unit: "U-F", before: null,
        after: { current: { effective: "active" } } }]);
      expect(restoredStep.displayChanges[0].after?.unit === "U-F"
        && restoredStep.displayChanges[0].after.current).toEqual(unit(b).subjects[0]);
      expect(unit(b).persistence.savedGeneration).toBe(1);
      fail.write = true;
      await route(b, cancel, DATE + 2);
      expect(first(unit(b)).effective).toBe("cancelled");
      expect(unit(b).persistence.currentGeneration).toBe(2);
      expect((await save(b, DATE + 2)).kind).toBe("failed");
      expect(first(unit(b)).effective).toBe("cancelled");
      fail.write = false;
      const c = await start(makeRoot(), "c", clock(DATE + 3));
      expect(unit(c).persistence.savedGeneration).toBe(1);
      expect(first(unit(c)).effective).toBe("active");
      fail.afterRename = true;
      // The uncertain save's reconciliation, which would start at once, is kept from the owner (this runtime ends here).
      c.holdRequests((_place, request) => request.kind === "checkpointGrant" && request.mode === "reconcile");
      await route(c, cancel, DATE + 3);
      expect(first(unit(c)).effective).toBe("cancelled");
      expect((await save(c, DATE + 3)).kind).toBe("uncertain");
      expect(writes).toBe(2);
      expect(unit(c).persistence).toMatchObject({ currentGeneration: 2, savedGeneration: 1 });
      fail.afterRename = false;
      const d = await start(makeRoot(), "d", clock(DATE + 4));
      expect(unit(d).persistence.savedGeneration).toBe(2);
      expect(first(unit(d)).effective).toBe("cancelled");
      // Each route below would save at once (P3-UWR-AC03); those saves fail before any rename, so the only write of this
      // runtime is the final save (AC10(7)).
      fail.write = true;
      await route(d, unknown, DATE + 3_600_000, (xml) => xml.replace("2026-06-05T17:00:00+09:00</ReportDateTime>",
        "2026-06-05T18:00:00+09:00</ReportDateTime>").replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>"));
      expect(first(unit(d)).effective).toBe("active");
      await route(d, unknown, DATE + 7_200_000, (xml) => xml
        .replace("2026-06-05T17:00:00+09:00</ReportDateTime>", "2026-06-05T19:00:00+09:00</ReportDateTime>")
        .replace(/<TimeSeriesInfo>[\s\S]*?<\/TimeSeriesInfo>/, ""));
      expect(first(unit(d)).effective).toBe("noActiveItems");
      await route(d, unknown, DATE + 10_800_000, (xml) => xml.replace("<ReportDateTime>2026-06-05T17:00:00+09:00</ReportDateTime>",
        "<ReportDateTime>2026-06-05T20:00:00+09:00</ReportDateTime>"), "training");
      expect(unit(d).subjects.map((item) => item.operation).sort()).toEqual(["normal", "training"]);
      const beforeOldAck = unit(d);
      expect(writes).toBe(2);
      // TEST-PATH (1): the owner applies checkpoint results itself; another run's ack leaves the unit untouched.
      const owner = d.owners.get("deferred")!["state"]!;
      expect(checkpointResultOwner(owner, oldAck, calls.units).state.units["U-F"]).toBe(beforeOldAck);
      now = clock();
      fail.write = false;
      const summary = await d.root.shutdownRuntime(1, clock());
      expect(summary).toMatchObject({ code: 0, reasons: [], persistence: { "U-F": { kind: "saved" } } });
      const finalGeneration = unit(d).persistence.currentGeneration;
      expect(unit(d).persistence.savedGeneration).toBe(finalGeneration);
      const e = await start(makeRoot(), "e", clock(DATE + 10_800_002));
      expect(unit(e).persistence.savedGeneration).toBe(finalGeneration);
      expect(unit(e).subjects).toEqual(unit(d).subjects);
      expect(writes).toBe(3);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  // T08: unrelated expiry cannot make duplicate input an accepted generation contributor.
  it("T08 changes an expired office while duplicate input remains unchanged", () => {
    const one = receive(empty(), fixture(unknown));
    const otherMaterial = fixture(unknown, (xml) => xml.replaceAll("稚内地方気象台", "他官署")
      .replaceAll("<DateTime>2026-06-05T", "<DateTime>2026-06-06T"));
    const other = receive(one.state, otherMaterial);
    const at = first(one.state).validUntil!;
    const duplicate = receive(other.state, otherMaterial, at);
    expect(duplicate.state.subjects.map((item) => item.effective)).toEqual(["noActiveItems", "active"]);
    expect(duplicate.decisions).toMatchObject([{ decision: "unchanged", reason: "duplicate" }]);
    expect(duplicate.outcomes.some((item) => item.kind === "accepted")).toBe(false);
    expect(duplicate.outcomes.some((item) => item.kind === "deadlineApplied")).toBe(true);
    expect(duplicate.state.persistence.currentGeneration).toBe(other.state.persistence.currentGeneration + 1);
    const runtime = fixtureState({}, { "U-F": other.state.persistence }, "a6");
    const linked = callsWith({ reduceWeatherTimeseriesUnit }).units;
    const owner = ownerFixture("deferred", { ...runtime, units: { ...runtime.units, "U-F": other.state } });
    const routed = receiveOwner({ ...owner, deadlines: { "U-F": { wallTimeMs: at, monotonicMs: null } } },
      { runId: "a6", inputId: "duplicate", result: { kind: "decoded", material: otherMaterial } }, clock(at), linked);
    expect(routed.generationInputIds["U-F"]).toEqual([]);
    const headless = receiveOwner({ ...owner, deadlines: { "U-F": null } }, { runId: "a6", inputId: "headless",
      result: { kind: "decoded", material: fixture("81_05_01_260605_VPWP50_head_missing") } }, clock(DATE), linked);
    expect(headless.state.units["U-F"]).toBe(other.state);
    expect(headless.diagnostics).toMatchObject([{ reason: "headMissing", unit: "U-F" }]);
  });
});
