import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DailyQuakeCounter } from "../../../src/engine/messages/daily-quake-counter";
import { DailyQuakePersistence } from "../../../src/engine/messages/daily-quake-persistence";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import type { JmaIntensity, SpecialValue } from "../../../src/types";
import { projectRecentQuake } from "../../../src/engine/display/project-event";
import { quakeObservationMetaOf } from "../../../src/engine/display/quake-observation-merge";
import { extractSpecialValue } from "../../../src/dmdata/special-value";
import { specialValueCanonicalEquals } from "../../../src/utils/magnitude";

const T0 = Date.parse("2026-07-29T12:00:00+09:00");
const dirs: string[] = [];

interface PersistedTestSpecialValue {
  raw: string | null;
  value: JmaIntensity | null;
  condition: string | null;
  description: string | null;
  presence: SpecialValue<JmaIntensity>["presence"];
  lowerBound?: JmaIntensity | null;
}

interface PersistedTestRecent {
  eventId: string | null;
  maxInt: string | null;
  maxIntRank: number | null;
  maxIntSemantic?: Record<string, unknown> | null;
  magnitudeSemantic?: Record<string, unknown> | null;
  depthSemantic?: Record<string, unknown> | null;
  observation: {
    sourceType: string | null;
    observationSourceType: string | null;
    intensityStructureMissing: boolean;
    maxIntValue: PersistedTestSpecialValue;
    magnitudeValue?: Record<string, unknown>;
    depthValue?: Record<string, unknown>;
  };
}

interface PersistedTestFile {
  state: { recentQuakes: PersistedTestRecent[] };
}

function specialRecord(
  presence: SpecialValue<JmaIntensity>["presence"],
  raw: string | null,
): PersistedTestSpecialValue {
  return {
    raw,
    value: null,
    condition: null,
    description: null,
    presence,
  };
}

function filePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-daily-quake-"));
  dirs.push(dir);
  return path.join(dir, "daily-quake-v1.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function intensityValue(maxInt: string | null | undefined): SpecialValue<JmaIntensity> {
  if (maxInt == null) {
    return { raw: null, value: null, condition: null, description: null, presence: "missing" };
  }
  const canonical = ({
    "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
    "5弱": "5-", "5強": "5+", "6弱": "6-", "6強": "6+", "7": "7",
  } as const)[maxInt as "0" | "1" | "2" | "3" | "4" | "5弱" | "5強" | "6弱" | "6強" | "7"];
  return canonical == null
    ? { raw: maxInt, value: null, condition: null, description: null, presence: "unknown" }
    : { raw: maxInt, value: canonical, condition: null, description: null, presence: "value" };
}

function numericValue(raw: string, value: number): SpecialValue<number> {
  return { raw, value, condition: null, description: null, presence: "value" };
}

function event(overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  const result = {
    id: "id", classification: "telegram.earthquake", domain: "earthquake", type: "VXSE51",
    infoType: "発表", title: "震源・震度に関する情報", headline: null,
    reportDateTime: new Date(T0).toISOString(), publishingOffice: "気象庁", isTest: false,
    frameLevel: "warning", isCancellation: false, eventId: "Q1", maxInt: "4",
    maxIntRank: 4,
    originTime: new Date(T0).toISOString(), hypocenterName: "東京湾", magnitude: "4.0", depth: "30km",
    tsunamiWarning: false, areaItems: [], ...overrides,
  } as PresentationEvent;
  result.maxIntValue ??= intensityValue(result.maxInt);
  return result;
}

function addQuake(counter: DailyQuakeCounter, e = event(), nowMs = T0): void {
  counter.record(e, nowMs);
  counter.recordRecentQuake(projectRecentQuake(e), nowMs);
}

describe("DailyQuakePersistence", () => {
  it("同日 restore で counter と表示 DTO 5件履歴を一体で復元する", () => {
    const file = filePath();
    const source = new DailyQuakeCounter(T0);
    for (let i = 0; i < 6; i += 1) {
      addQuake(source, event({ eventId: `Q${i}`, reportDateTime: new Date(T0 + i).toISOString(), originTime: new Date(T0 + i).toISOString() }));
    }
    new DailyQuakePersistence(file).save(source.export(), T0 + 10);

    const loaded = new DailyQuakePersistence(file).load(T0 + 20);
    const restored = new DailyQuakeCounter(T0 + 20);
    expect(loaded == null ? false : restored.restore(loaded, T0 + 20)).toBe(true);
    expect(restored.getSnapshot(T0 + 20)).toMatchObject({ todayQuakeCount: 6, todayMaxInt: "4" });
    expect(restored.getRecentQuakes(T0 + 20).map((q) => q.eventId)).toEqual(["Q5", "Q4", "Q3", "Q2", "Q1"]);
  });

  it("観測済み震度を restore 後の震度なし続報でも保持し、実ファイル round-trip する", () => {
    const file = filePath();
    const source = new DailyQuakeCounter(T0);
    const observed = event({
      type: "VXSE51",
      eventId: "Q1",
      reportDateTime: new Date(T0).toISOString(),
      originTime: new Date(T0).toISOString(),
      hypocenterName: "初期震源",
      magnitude: "4.8",
      magnitudeValue: numericValue("4.8", 4.8),
      maxInt: "4",
      maxIntValue: intensityValue("4"),
      maxIntRank: 4,
      depth: "10km",
      depthValue: numericValue("-10000", 10),
      areaItems: [{ name: "茨城県北部", maxInt: "4", maxIntValue: intensityValue("4") }],
    });
    source.recordRecentQuake(projectRecentQuake(observed), T0);

    const persistence = new DailyQuakePersistence(file);
    persistence.save(source.export(), T0 + 1);
    const loadedObserved = persistence.load(T0 + 2);
    const restoredObserved = new DailyQuakeCounter(T0 + 2);
    expect(loadedObserved == null ? false : restoredObserved.restore(loadedObserved, T0 + 2)).toBe(true);
    expect(loadedObserved?.recentQuakes[0]).toMatchObject({
      magnitudeSemantic: { presence: "value", value: 4.8 },
      depthSemantic: { presence: "value", value: 10 },
    });
    const followup = projectRecentQuake(event({
      type: "VXSE52",
      eventId: "Q1",
      reportDateTime: new Date(T0 + 60_000).toISOString(),
      originTime: new Date(T0).toISOString(),
      hypocenterName: "更新震源",
      magnitude: "5.2",
      magnitudeValue: numericValue("5.2", 5.2),
      maxInt: null,
      maxIntValue: intensityValue(null),
      maxIntRank: null,
      depth: "20km",
      depthValue: numericValue("-20000", 20),
      areaItems: [],
    }));
    source.recordRecentQuake(followup, T0 + 60_000);
    restoredObserved.recordRecentQuake(followup, T0 + 60_000);
    expect(restoredObserved.getRecentQuakes(T0 + 60_000)).toEqual(
      source.getRecentQuakes(T0 + 60_000),
    );

    persistence.save(restoredObserved.export(), T0 + 60_001);
    const loaded = persistence.load(T0 + 60_002);
    const restored = new DailyQuakeCounter(T0 + 60_002);
    expect(loaded == null ? false : restored.restore(loaded, T0 + 60_002)).toBe(true);
    expect(restored.getRecentQuakes(T0 + 60_002)[0]).toMatchObject({
      hypocenterName: "更新震源",
      magnitude: "5.2",
      magnitudeSemantic: { presence: "value", value: 5.2 },
      depth: "20km",
      depthSemantic: { presence: "value", value: 20 },
      maxInt: "4",
      maxIntRank: 4,
      intensityGroups: [{ intensity: "4", areas: ["茨城県北部"] }],
    });
    expect(quakeObservationMetaOf(restored.getRecentQuakes(T0 + 60_002)[0]!)).toMatchObject({
      sourceType: "VXSE52",
      observationSourceType: "VXSE51",
      maxIntValue: { presence: "value", value: "4", raw: "4" },
    });
  });

  it("Magnitude/Depth semantic を explicit-null bounds と JSON-safe rank で round-trip する", () => {
    const file = filePath();
    const magnitudeValue: SpecialValue<number> = {
      raw: "NaN",
      value: null,
      condition: null,
      description: "Ｍ８を超える巨大地震",
      presence: "qualitative",
    };
    const depthValue: SpecialValue<number> = {
      raw: "-600000",
      value: null,
      condition: "600km以上",
      description: "深さ600km以上",
      presence: "range",
      lowerBound: 600,
      rawLowerBound: "６００",
      diagnostics: ["specialValueConflict"],
    };
    const counter = new DailyQuakeCounter(T0);
    counter.recordRecentQuake(projectRecentQuake(event({
      eventId: "Q-semantic-md",
      magnitude: "",
      magnitudeValue,
      depth: "600km",
      depthValue,
    })), T0);
    const persistence = new DailyQuakePersistence(file);
    persistence.save(counter.export(), T0 + 1);

    const serialized = JSON.parse(fs.readFileSync(file, "utf8")) as {
      state: { recentQuakes: Array<Record<string, unknown>> };
    };
    expect(serialized.state.recentQuakes[0]).toMatchObject({
      magnitudeSemantic: {
        presence: "qualitative",
        lowerBound: null,
        upperBound: null,
        rank: { kind: "giant" },
      },
      depthSemantic: {
        presence: "range",
        lowerBound: 600,
        upperBound: null,
        rawLowerBound: "６００",
        rawUpperBound: null,
      },
      observation: {
        magnitudeValue: { presence: "qualitative", description: "Ｍ８を超える巨大地震" },
        depthValue: {
          presence: "range",
          lowerBound: 600,
          rawLowerBound: "６００",
          diagnostics: ["specialValueConflict"],
        },
      },
    });
    const loaded = persistence.load(T0 + 2);
    expect(loaded?.recentQuakes[0]).toEqual(counter.export().recentQuakes[0]);
    expect(quakeObservationMetaOf(loaded!.recentQuakes[0]!)).toMatchObject({
      magnitudeValue,
      depthValue,
    });
  });

  it("旧 shallow の canonical-only／wire-only／scalar-only／新旧同時を daily 実 load で同じ canonical へ移行する", () => {
    const file = filePath();
    const fresh = extractSpecialValue("Depth", { "#text": "-0" }) as SpecialValue<number>;
    const giant: SpecialValue<number> = {
      raw: "NaN", value: null, condition: null,
      description: "Ｍ８を超える巨大地震", presence: "qualitative",
    };
    const counter = new DailyQuakeCounter(T0);
    for (let index = 0; index < 4; index += 1) {
      addQuake(counter, event({
        eventId: `Q-shallow-${index}`,
        reportDateTime: new Date(T0 + index).toISOString(),
        originTime: new Date(T0 + index).toISOString(),
        magnitude: "",
        magnitudeValue: giant,
        depth: "ごく浅い",
        depthValue: fresh,
      }), T0 + index);
    }
    const persistence = new DailyQuakePersistence(file);
    persistence.save(counter.export(), T0 + 10);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedTestFile;
    const [both, scalar, wire, canonical] = persisted.state.recentQuakes;
    for (const entry of [both, wire, canonical]) {
      delete entry!.observation.depthValue!.upperBound;
    }
    for (const entry of [both, wire]) {
      Object.assign(entry!.depthSemantic!, {
        upperBound: null,
        badge: "?",
        color: "unknown",
      });
    }
    delete canonical!.depthSemantic;
    delete wire!.observation.depthValue;
    delete scalar!.observation.depthValue;
    delete scalar!.depthSemantic;
    fs.writeFileSync(file, JSON.stringify(persisted), "utf8");

    const loaded = persistence.load(T0 + 20)!;
    expect(loaded.recentQuakes).toHaveLength(4);
    for (const quake of loaded.recentQuakes) {
      const meta = quakeObservationMetaOf(quake)!;
      expect(specialValueCanonicalEquals(meta.depthValue, fresh)).toBe(true);
      expect(quake.depthSemantic).toMatchObject({
        presence: "qualitative",
        upperBound: 5,
        badge: null,
        color: "safetyRank",
      });
      expect(quake.magnitudeSemantic).toMatchObject({ rank: { kind: "giant" } });
      expect(Object.hasOwn(meta.magnitudeValue!, "upperBound")).toBe(false);
    }
  });

  it("upper-only numeric bounds を daily owner で canonical/semantic とも round-trip する", () => {
    const file = filePath();
    const magnitudeValue: SpecialValue<number> = {
      raw: "7.0",
      value: null,
      condition: "7.0以下",
      description: "M7.0以下",
      presence: "range",
      upperBound: 7,
      rawUpperBound: "７．０",
      diagnostics: ["unmappedSpecialValue"],
    };
    const depthValue: SpecialValue<number> = {
      raw: "-999000",
      value: null,
      condition: "999km以下",
      description: "深さ999km以下",
      presence: "range",
      upperBound: 999,
      rawUpperBound: "９９９",
      diagnostics: ["specialValueConflict"],
    };
    const counter = new DailyQuakeCounter(T0);
    counter.recordRecentQuake(projectRecentQuake(event({
      eventId: "Q-upper-only",
      magnitude: "7.0",
      magnitudeValue,
      depth: "999km",
      depthValue,
    })), T0);
    const persistence = new DailyQuakePersistence(file);
    persistence.save(counter.export(), T0 + 1);

    const loaded = persistence.load(T0 + 2);
    expect(quakeObservationMetaOf(loaded!.recentQuakes[0]!)).toMatchObject({
      magnitudeValue,
      depthValue,
    });
    expect(loaded?.recentQuakes[0]).toMatchObject({
      magnitudeSemantic: {
        presence: "range", lowerBound: null, upperBound: 7,
        rawLowerBound: null, rawUpperBound: "７．０",
      },
      depthSemantic: {
        presence: "range", lowerBound: null, upperBound: 999,
        rawLowerBound: null, rawUpperBound: "９９９",
      },
    });
  });

  it("valid canonical があれば壊れた派生 semantic を再生成して EventID を救済する", () => {
    const file = filePath();
    const magnitudeValue: SpecialValue<number> = {
      raw: "6.3", value: 6.3, condition: null, description: null, presence: "value",
      diagnostics: ["specialValueConflict"],
    };
    const depthValue: SpecialValue<number> = {
      raw: "-600000", value: null, condition: "600km以上", description: "深さ600km以上",
      presence: "range", lowerBound: 600, rawLowerBound: "６００",
      diagnostics: ["specialValueConflict"],
    };
    const counter = new DailyQuakeCounter(T0);
    addQuake(counter, event({
      eventId: "Q-canonical-rescue",
      magnitude: "6.3",
      magnitudeValue,
      depth: "600km",
      depthValue,
    }));
    const persistence = new DailyQuakePersistence(file);
    persistence.save(counter.export(), T0 + 1);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedTestFile;
    persisted.state.recentQuakes[0]!.magnitudeSemantic!.rank = Number.POSITIVE_INFINITY;
    persisted.state.recentQuakes[0]!.depthSemantic!.label = "解析保留";
    fs.writeFileSync(file, JSON.stringify(persisted), "utf8");

    const loaded = persistence.load(T0 + 2);
    expect(loaded?.recentQuakes).toHaveLength(1);
    expect(loaded?.recentQuakes[0]).toMatchObject({
      eventId: "Q-canonical-rescue",
      magnitudeSemantic: { presence: "value", value: 6.3, rank: { kind: "value", value: 6.3 } },
      depthSemantic: { presence: "range", label: "600km以上", lowerBound: 600 },
    });
    expect(quakeObservationMetaOf(loaded!.recentQuakes[0]!)).toMatchObject({
      magnitudeValue,
      depthValue,
    });
  });

  it("daily writer は canonical optional bounds の明示 null を省略形へ正規化する", () => {
    const file = filePath();
    const magnitudeValue: SpecialValue<number> = {
      raw: "6.0", value: 6, condition: null, description: null, presence: "value",
      lowerBound: null, upperBound: null, rawLowerBound: null, rawUpperBound: null,
    };
    const depthValue: SpecialValue<number> = {
      raw: "-600000", value: null, condition: "600km以上", description: "深さ600km以上",
      presence: "range", lowerBound: 600, upperBound: null,
      rawLowerBound: "６００", rawUpperBound: null,
    };
    const counter = new DailyQuakeCounter(T0);
    addQuake(counter, event({
      eventId: "Q-null-bounds",
      magnitude: "6.0",
      magnitudeValue,
      depth: "600km",
      depthValue,
    }));
    const persistence = new DailyQuakePersistence(file);
    persistence.save(counter.export(), T0 + 1);

    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as {
      state: { recentQuakes: Array<{ observation: {
        magnitudeValue: Record<string, unknown>;
        depthValue: Record<string, unknown>;
      } }> };
    };
    const observation = persisted.state.recentQuakes[0]!.observation;
    for (const key of ["lowerBound", "upperBound", "rawLowerBound", "rawUpperBound"]) {
      expect(Object.hasOwn(observation.magnitudeValue, key)).toBe(false);
    }
    expect(Object.hasOwn(observation.depthValue, "upperBound")).toBe(false);
    expect(Object.hasOwn(observation.depthValue, "rawUpperBound")).toBe(false);
    expect(persistence.load(T0 + 2)?.recentQuakes).toHaveLength(1);
  });

  it("SpecialValue の presence/bounds/raw/condition/description を v2 で対称に保存する", () => {
    const file = filePath();
    const qualitative: SpecialValue<JmaIntensity> = {
      raw: " 5弱以上未入電 ",
      value: null,
      condition: "5弱以上未入電",
      description: "震度5弱以上の地域は未入電",
      presence: "qualitative",
      lowerBound: "5-",
      upperBound: null,
      rawLowerBound: "５－",
      rawUpperBound: "over",
      diagnostics: ["specialValueConflict"],
    };
    const counter = new DailyQuakeCounter(T0);
    counter.recordRecentQuake(projectRecentQuake(event({
      type: "VXSE51",
      maxInt: null,
      maxIntRank: null,
      maxIntValue: qualitative,
    })), T0);
    const persistence = new DailyQuakePersistence(file);
    persistence.save(counter.export(), T0 + 1);
    const loaded = persistence.load(T0 + 2);
    expect(loaded).not.toBeNull();
    expect(quakeObservationMetaOf(loaded!.recentQuakes[0]!)!.maxIntValue).toEqual(qualitative);
  });

  it("maxIntSemantic を save→load→save で冪等に復元する", () => {
    const first = filePath();
    const second = filePath();
    const qualitative: SpecialValue<JmaIntensity> = {
      raw: "", value: null, condition: "5弱以上未入電", description: null,
      presence: "qualitative", lowerBound: "5-",
    };
    const counter = new DailyQuakeCounter(T0);
    counter.recordRecentQuake(projectRecentQuake(event({
      eventId: "Q-semantic",
      maxInt: null,
      maxIntRank: null,
      maxIntValue: qualitative,
    })), T0);
    const firstPersistence = new DailyQuakePersistence(first);
    firstPersistence.save(counter.export(), T0 + 1);
    const loaded = firstPersistence.load(T0 + 2);
    expect(loaded?.recentQuakes[0]?.maxIntSemantic).toMatchObject({
      presence: "qualitative", badge: "≥", safetyRank: 5,
    });
    new DailyQuakePersistence(second).save(loaded!, T0 + 1);
    expect(JSON.parse(fs.readFileSync(second, "utf8"))).toEqual(
      JSON.parse(fs.readFileSync(first, "utf8")),
    );
  });

  it("意味矛盾した maxIntSemantic は entry 単位で fail-closed にする", () => {
    const file = filePath();
    const counter = new DailyQuakeCounter(T0);
    const qualitative: SpecialValue<JmaIntensity> = {
      raw: "", value: null, condition: "5弱以上未入電", description: null,
      presence: "qualitative", lowerBound: "5-",
    };
    addQuake(counter, event({
      eventId: "Q1", maxInt: null, maxIntRank: null, maxIntValue: qualitative,
    }), T0);
    addQuake(counter, event({
      eventId: "Q2", reportDateTime: new Date(T0 + 1).toISOString(),
    }), T0 + 1);
    const persistence = new DailyQuakePersistence(file);
    persistence.save(counter.export(), T0 + 2);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedTestFile;
    const broken = persisted.state.recentQuakes.find((entry) => entry.eventId === "Q1")!;
    expect(broken.maxIntSemantic).not.toBeNull();
    broken.maxIntSemantic!.color = "normalRank";
    broken.maxIntSemantic!.safetyRank = 5;
    fs.writeFileSync(file, JSON.stringify(persisted), "utf8");
    expect(persistence.load(T0 + 3)?.recentQuakes.map((entry) => entry.eventId)).toEqual(["Q2"]);
  });

  it("負 rank と per-group semantic を含む混在カードを save/restart で対称に復元する", () => {
    const file = filePath();
    const exact = intensityValue("4");
    const unknown: SpecialValue<JmaIntensity> = {
      raw: "未入電", value: null, condition: "未入電", description: "地域値未入電",
      presence: "unknown",
    };
    const empty: SpecialValue<JmaIntensity> = {
      raw: "", value: null, condition: null, description: null, presence: "empty",
    };
    const counter = new DailyQuakeCounter(T0);
    counter.recordRecentQuake(projectRecentQuake(event({
      maxInt: "4",
      maxIntRank: 4,
      maxIntValue: exact,
      areaItems: [
        { name: "地域A", maxInt: "4", maxIntValue: exact },
        { name: "地域B", maxIntValue: unknown },
        { name: "地域C", maxIntValue: empty },
      ],
    })), T0);
    const before = counter.getRecentQuakes(T0)[0]!;
    expect(before.intensityGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({ rank: 4, areas: ["地域A"] }),
      expect.objectContaining({
        rank: -1,
        areas: ["地域B"],
        intensitySemantic: expect.objectContaining({
          presence: "unknown", badge: "?", description: "地域値未入電",
        }),
      }),
      expect.objectContaining({
        rank: -1,
        areas: ["地域C"],
        intensitySemantic: expect.objectContaining({ presence: "empty", badge: "∅" }),
      }),
    ]));

    const persistence = new DailyQuakePersistence(file);
    persistence.save(counter.export(), T0 + 1);
    const loaded = persistence.load(T0 + 2);
    const restored = new DailyQuakeCounter(T0 + 2);
    expect(loaded == null ? false : restored.restore(loaded, T0 + 2)).toBe(true);
    expect(restored.getRecentQuakes(T0 + 2)[0]?.intensityGroups).toEqual(
      before.intensityGroups,
    );
  });

  it("expandedAreas と candidateTruncated を保存・load で保持し、候補なし旧 JSON も読む", () => {
    const file = filePath();
    const counter = new DailyQuakeCounter(T0);
    const quake = projectRecentQuake(event({
      eventId: "candidate-round-trip",
      maxInt: "4",
      maxIntRank: 4,
      maxIntValue: intensityValue("4"),
      areaItems: [{ name: "地域A", maxInt: "4", maxIntValue: intensityValue("4") }],
    }))!;
    quake.intensityGroups = [{
      intensity: "4",
      rank: 4,
      areas: ["地域A"],
      omittedAreaCount: 2,
      expandedAreas: ["地域A", "候補B", "候補C"],
      candidateTruncated: true,
    }];
    counter.recordRecentQuake(quake, T0);

    const persistence = new DailyQuakePersistence(file);
    persistence.save(counter.export(), T0 + 1);
    const loaded = persistence.load(T0 + 2);
    expect(loaded?.recentQuakes[0]?.intensityGroups).toEqual(quake.intensityGroups);

    const legacy = counter.export();
    const legacyRecent = legacy.recentQuakes.map((recent) => ({
      ...recent,
      intensityGroups: recent.intensityGroups?.map((group) => {
        const { expandedAreas: _expandedAreas, candidateTruncated: _candidateTruncated, ...withoutCandidates } = group;
        return withoutCandidates;
      }),
    }));
    persistence.save({ ...legacy, recentQuakes: legacyRecent }, T0 + 3);
    const loadedLegacy = persistence.load(T0 + 4);
    expect(loadedLegacy?.recentQuakes[0]?.intensityGroups).toEqual([{
      intensity: "4",
      rank: 4,
      areas: ["地域A"],
      omittedAreaCount: 2,
    }]);
  });

  it("persists cancelled observation provenance and blocks post-restart structural-missing preservation", () => {
    const file = filePath();
    const source = new DailyQuakeCounter(T0);
    const magnitudeValue: SpecialValue<number> = {
      raw: "4.0", value: 4, condition: null, description: null, presence: "value",
      diagnostics: ["specialValueConflict"],
    };
    const depthValue: SpecialValue<number> = {
      raw: "-30000", value: 30, condition: null, description: null, presence: "value",
      diagnostics: ["specialValueConflict"],
    };
    source.recordRecentQuake(projectRecentQuake(event({
      type: "VXSE51",
      eventId: "Q1",
      maxInt: "4",
      maxIntRank: 4,
      maxIntValue: intensityValue("4"),
      magnitudeValue,
      depthValue,
    })), T0);
    source.recordRecentQuake(projectRecentQuake(event({
      type: "VXSE52",
      eventId: "Q1",
      infoType: "取消",
      isCancellation: true,
      foundationResolvedTrigger: "explicitCancellation",
      foundationCancellationPolicy: "markCancelled",
      reportDateTime: new Date(T0 + 2 * 60_000).toISOString(),
      maxInt: null,
      maxIntRank: null,
      maxIntValue: intensityValue(null),
      areaItems: [],
    })), T0 + 2 * 60_000);

    const persistence = new DailyQuakePersistence(file);
    persistence.save(source.export(), T0 + 2 * 60_000 + 1);
    const loaded = persistence.load(T0 + 2 * 60_000 + 2);
    const restored = new DailyQuakeCounter(T0 + 2 * 60_000 + 2);
    expect(loaded == null ? false : restored.restore(loaded, T0 + 2 * 60_000 + 2)).toBe(true);
    expect(quakeObservationMetaOf(restored.getRecentQuakes(T0 + 2 * 60_000 + 2)[0]!))
      .toMatchObject({
        sourceType: "VXSE52",
        observationSourceType: "VXSE51",
        resolvedTrigger: "explicitCancellation",
        maxIntValue: { presence: "value", value: "4" },
        magnitudeValue,
        depthValue,
      });

    restored.recordRecentQuake(projectRecentQuake(event({
      type: "VXSE61",
      eventId: "Q1",
      reportDateTime: new Date(T0 + 60_000).toISOString(),
      maxInt: null,
      maxIntRank: null,
      maxIntValue: intensityValue(null),
      areaItems: [],
    })), T0 + 3 * 60_000);
    const afterDelayed = restored.getRecentQuakes(T0 + 3 * 60_000)[0]!;
    expect(afterDelayed).toMatchObject({ maxInt: null, maxIntRank: null, intensityGroups: [] });
    expect(quakeObservationMetaOf(afterDelayed)?.maxIntValue.presence).toBe("missing");
  });

  it.each([
    ["unknown", {
      raw: "不明",
      value: null,
      condition: "不明",
      description: null,
      presence: "unknown",
    }],
    ["empty", {
      raw: " ",
      value: null,
      condition: null,
      description: null,
      presence: "empty",
    }],
    ["qualitative", {
      raw: "5弱以上未入電",
      value: null,
      condition: "5弱以上未入電",
      description: "震度5弱以上の地域は未入電",
      presence: "qualitative",
      lowerBound: "5-",
    }],
  ] satisfies ReadonlyArray<readonly [string, SpecialValue<JmaIntensity>]>)
  ("round-trips a cancelled %s observation through v2 persistence", (_label, nonExact) => {
    const file = filePath();
    const source = new DailyQuakeCounter(T0);
    source.recordRecentQuake(projectRecentQuake(event({
      type: "VXSE51",
      eventId: "Q1",
      maxInt: null,
      maxIntRank: null,
      maxIntValue: nonExact,
    })), T0);
    source.recordRecentQuake(projectRecentQuake(event({
      type: "VXSE52",
      eventId: "Q1",
      infoType: "取消",
      isCancellation: true,
      foundationResolvedTrigger: "explicitCancellation",
      foundationCancellationPolicy: "markCancelled",
      reportDateTime: new Date(T0 + 60_000).toISOString(),
      maxInt: null,
      maxIntRank: null,
      maxIntValue: intensityValue(null),
      areaItems: [],
    })), T0 + 60_000);

    const persistence = new DailyQuakePersistence(file);
    persistence.save(source.export(), T0 + 60_001);
    const loaded = persistence.load(T0 + 60_002);
    const restored = new DailyQuakeCounter(T0 + 60_002);
    expect(loaded == null ? false : restored.restore(loaded, T0 + 60_002)).toBe(true);

    const terminal = restored.getRecentQuakes(T0 + 60_002)[0]!;
    expect(terminal).toMatchObject({ maxInt: null, maxIntRank: null });
    expect(quakeObservationMetaOf(terminal)).toMatchObject({
      sourceType: "VXSE52",
      observationSourceType: "VXSE51",
      resolvedTrigger: "explicitCancellation",
      maxIntValue: nonExact,
    });
  });

  it("旧 v1 persistence は表示値を復元しつつ source provenance 不明として移行する", () => {
    const file = filePath();
    const counter = new DailyQuakeCounter(T0);
    addQuake(counter);
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      savedAt: new Date(T0 + 1).toISOString(),
      state: counter.export(),
    }), "utf8");
    const loaded = new DailyQuakePersistence(file).load(T0 + 2);
    expect(loaded?.recentQuakes[0]).toMatchObject({ maxInt: "4", maxIntRank: 4 });
    expect(loaded?.recentQuakes[0]).toMatchObject({
      magnitude: "4.0",
      magnitudeSemantic: { presence: "value", value: 4, rank: { kind: "value", value: 4 } },
      depth: "30km",
      depthSemantic: { presence: "value", value: 30 },
    });
    expect(quakeObservationMetaOf(loaded!.recentQuakes[0]!)).toMatchObject({
      sourceType: null,
      observationSourceType: null,
      maxIntValue: { presence: "value", value: "4" },
    });
  });

  it("旧 v1 の判別不能な maxInt:null は migration reason 付き unknown へ移行する", () => {
    const file = filePath();
    const counter = new DailyQuakeCounter(T0);
    addQuake(counter);
    const state = counter.export();
    state.recentQuakes[0] = {
      ...state.recentQuakes[0]!,
      maxInt: null,
      maxIntRank: null,
      intensityGroups: [],
    };
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      savedAt: new Date(T0 + 1).toISOString(),
      state,
    }), "utf8");
    const loaded = new DailyQuakePersistence(file).load(T0 + 2);
    expect(quakeObservationMetaOf(loaded!.recentQuakes[0]!)).toMatchObject({
      sourceType: null,
      observationSourceType: null,
      intensityStructureMissing: false,
      maxIntValue: {
        raw: null,
        value: null,
        presence: "unknown",
        diagnostics: ["legacyNullUnknown"],
      },
    });
  });

  it("migrates legacy empty scalar to null while preserving raw empty through v2 round-trip", () => {
    const file = filePath();
    const counter = new DailyQuakeCounter(T0);
    addQuake(counter);
    const state = counter.export();
    state.recentQuakes[0] = {
      ...state.recentQuakes[0]!,
      maxInt: "",
      maxIntRank: 0,
      intensityGroups: [],
    };
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      savedAt: new Date(T0 + 1).toISOString(),
      state,
    }), "utf8");

    const persistence = new DailyQuakePersistence(file);
    const migrated = persistence.load(T0 + 2);
    expect(migrated?.recentQuakes[0]).toMatchObject({ maxInt: null, maxIntRank: null });
    expect(quakeObservationMetaOf(migrated!.recentQuakes[0]!)?.maxIntValue).toMatchObject({
      raw: "",
      value: null,
      presence: "empty",
    });

    persistence.save(migrated!, T0 + 3);
    const roundTripped = persistence.load(T0 + 4);
    expect(roundTripped?.recentQuakes[0]).toMatchObject({ maxInt: null, maxIntRank: null });
    expect(quakeObservationMetaOf(roundTripped!.recentQuakes[0]!)?.maxIntValue).toMatchObject({
      raw: "",
      value: null,
      presence: "empty",
    });
  });

  it.each([
    ["scalar と SpecialValue の不一致", (entry: PersistedTestRecent) => {
      entry.maxInt = "5弱";
      entry.maxIntRank = 5;
    }],
    ["provenance と構造的 missing の不一致", (entry: PersistedTestRecent) => {
      entry.observation.intensityStructureMissing = true;
    }],
    ["生成不能な current/observation provenance", (entry: PersistedTestRecent) => {
      entry.observation.sourceType = "VXSE53";
      entry.observation.observationSourceType = "VXSE51";
    }],
    ["明示構造なのに observation provenance が null", (entry: PersistedTestRecent) => {
      entry.maxInt = null;
      entry.maxIntRank = null;
      entry.observation.sourceType = "VXSE52";
      entry.observation.observationSourceType = null;
      entry.observation.intensityStructureMissing = false;
      entry.observation.maxIntValue = specialRecord("missing", null);
    }],
    ["bounds のない range", (entry: PersistedTestRecent) => {
      entry.maxInt = null;
      entry.maxIntRank = null;
      entry.observation.maxIntValue = specialRecord("range", "4");
    }],
    ["raw:null の value", (entry: PersistedTestRecent) => {
      entry.observation.maxIntValue.raw = null;
    }],
    ["raw:null の empty", (entry: PersistedTestRecent) => {
      entry.maxInt = null;
      entry.maxIntRank = null;
      entry.observation.maxIntValue = specialRecord("empty", null);
    }],
    ["value に canonical bounds", (entry: PersistedTestRecent) => {
      entry.observation.maxIntValue.lowerBound = "4";
    }],
    ["Magnitude semantic の非 JSON-safe rank", (entry: PersistedTestRecent) => {
      entry.magnitudeSemantic!.rank = Number.POSITIVE_INFINITY;
    }],
    ["Depth semantic の scalar と矛盾する label", (entry: PersistedTestRecent) => {
      entry.depthSemantic!.label = "解析保留";
    }],
  ] as const)("破損 v2 entry (%s) だけを fail-closed にして別 EventID を salvage する", (_label, corrupt) => {
    const file = filePath();
    const counter = new DailyQuakeCounter(T0);
    addQuake(counter, event({ eventId: "Q1" }), T0);
    addQuake(counter, event({ eventId: "Q2", reportDateTime: new Date(T0 + 1).toISOString() }), T0 + 1);
    const persistence = new DailyQuakePersistence(file);
    persistence.save(counter.export(), T0 + 2);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedTestFile;
    const broken = persisted.state.recentQuakes.find((entry) => entry.eventId === "Q1")!;
    corrupt(broken);
    fs.writeFileSync(file, JSON.stringify(persisted), "utf8");
    const loaded = persistence.load(T0 + 3);
    expect(loaded?.recentQuakes.map((entry) => entry.eventId)).toEqual(["Q2"]);
  });

  it("JST 00:00 sweep は空の当日状態にし、前日ファイルは restore しない", () => {
    const file = filePath();
    const before = Date.parse("2026-07-29T23:59:00+09:00");
    const midnight = Date.parse("2026-07-30T00:00:00+09:00");
    const counter = new DailyQuakeCounter(before);
    addQuake(counter, event({ originTime: new Date(before).toISOString(), reportDateTime: new Date(before).toISOString() }), before);
    const persistence = new DailyQuakePersistence(file);
    persistence.save(counter.export(), before);
    expect(counter.sweep(midnight)).toBe(true);
    persistence.save(counter.export(), midnight);
    const loaded = persistence.load(midnight + 1);
    const restored = new DailyQuakeCounter(midnight + 1);
    expect(loaded == null ? false : restored.restore(loaded, midnight + 1)).toBe(true);
    expect(restored.getSnapshot(midnight + 1).todayQuakeCount).toBe(0);
    expect(restored.getRecentQuakes(midnight + 1)).toEqual([]);
  });

  it("深夜の続報は履歴外でも eventId 単位カウンタを維持し、同一 eventId は二重計上しない", () => {
    const now = Date.parse("2026-07-30T00:05:00+09:00");
    const counter = new DailyQuakeCounter(now);
    const late = event({ eventId: "Q1", originTime: "2026-07-29T23:58:00+09:00", reportDateTime: new Date(now).toISOString() });
    counter.record(late, now);
    counter.recordRecentQuake({ eventId: "Q1", reportDateTime: late.reportDateTime, originTime: late.originTime ?? null, hypocenterName: null, magnitude: null, maxInt: "4", maxIntRank: 4, depth: null, tsunamiWarning: false }, now);
    counter.record({ ...late, maxInt: "5弱", maxIntValue: intensityValue("5弱") }, now + 1);
    expect(counter.getSnapshot(now + 1)).toMatchObject({ todayQuakeCount: 1, todayMaxInt: "5弱" });
    expect(counter.getRecentQuakes(now + 1)).toEqual([]);
  });

  it("envelope 破損は空開始、未来日時の recent entry は event 単位 salvage する", () => {
    const file = filePath();
    const persistence = new DailyQuakePersistence(file);
    const warn = vi.spyOn(console, "log").mockImplementation(() => undefined);
    fs.writeFileSync(file, "{broken", "utf8");
    expect(persistence.load(T0)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 99, savedAt: new Date(T0).toISOString(), state: {} }), "utf8");
    expect(persistence.load(T0)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 1, savedAt: new Date(T0 + 1).toISOString(), state: {} }), "utf8");
    expect(persistence.load(T0)).toBeNull();
    const counter = new DailyQuakeCounter(T0);
    addQuake(counter);
    const futureState = counter.export();
    futureState.recentQuakes[0] = { ...futureState.recentQuakes[0]!, originTime: new Date(T0 + 1).toISOString() };
    fs.writeFileSync(file, JSON.stringify({ version: 1, savedAt: new Date(T0).toISOString(), state: futureState }), "utf8");
    expect(persistence.load(T0)).toMatchObject({
      count: 1,
      recentQuakes: [],
    });
    expect(warn).toHaveBeenCalled();
  });

  it.each([
    ["count より EventID 集合が大きい", { count: 0, countedEventIds: ["Q1"] }],
    ["EventID 配列に重複がある", { count: 1, countedEventIds: ["Q1", "Q1"] }],
    ["maxInt=null なのに rank が残る", { count: 1, maxInt: null, maxIntRank: 4 }],
    ["maxInt と rank が一致しない", { count: 1, maxInt: "4", maxIntRank: 3 }],
    ["count=0 なのに最大震度が残る", { count: 0, maxInt: "4", maxIntRank: 4 }],
  ])("クロスフィールド破損 (%s) は受理しない", (_label, patch) => {
    const file = filePath();
    const state = {
      ...new DailyQuakeCounter(T0).export(),
      ...patch,
    };
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      savedAt: new Date(T0).toISOString(),
      state,
    }), "utf8");

    expect(new DailyQuakePersistence(file).load(T0)).toBeNull();
  });

  it("debounce は最新状態だけを書き、shutdown 相当の dispose + save は予約を上書きする", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const file = filePath();
    const persistence = new DailyQuakePersistence(file, 100);
    const first = new DailyQuakeCounter(T0);
    const latest = new DailyQuakeCounter(T0);
    addQuake(first);
    addQuake(latest);
    addQuake(latest, event({ eventId: "Q2" }));
    persistence.schedule(first.export(), T0);
    persistence.schedule(latest.export(), T0 + 1);
    vi.advanceTimersByTime(100);
    expect(new DailyQuakePersistence(file).load(T0 + 200)?.count).toBe(2);
    persistence.schedule(first.export(), T0 + 201);
    persistence.dispose();
    persistence.save(latest.export(), T0 + 202);
    vi.advanceTimersByTime(100);
    expect(new DailyQuakePersistence(file).load(T0 + 300)?.count).toBe(2);
  });
});
