import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramMeta } from "../../../src/dmdata/telegram-meta";
import {
  StandbyPersistence,
  standbyPersistenceV2Path,
  type PersistedStandbyStateV1,
  type PersistedStandbyStateV2,
} from "../../../src/engine/display/standby-persistence";
import {
  ALL_REVISION_FAMILY_POLICIES,
  FRAGMENT_MERGE_ALLOWLIST_KEYS,
  TSUNAMI_REVISION_FAMILY_POLICIES,
  validateRevisionFamilyPolicy,
  validateRevisionFamilyPolicies,
} from "../../../src/engine/messages/revision-family-registry";
import {
  TELEGRAM_REVISION_MAX_ENTRIES,
  TelegramRevisionGate,
} from "../../../src/engine/messages/telegram-revision-gate";
import {
  TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY,
  TsunamiStateHolder,
} from "../../../src/engine/messages/tsunami-state";
import { processTsunami } from "../../../src/engine/presentation/processors/process-tsunami";
import { fromTsunamiOutcome } from "../../../src/engine/presentation/events/from-tsunami";
import { projectDisplayEvent } from "../../../src/engine/display/project-event";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import type {
  ParsedTsunamiInfo,
  TsunamiForecastItem,
  TsunamiObservationStation,
  WsDataMessage,
} from "../../../src/types";
import {
  canonicalizeLegacyTsunamiInfo,
  canonicalizeLegacyTsunamiObservation,
  type LegacyTsunamiForecastItemInput,
} from "../../../src/dmdata/tsunami-legacy-adapter";

const { parseTsunamiMock } = vi.hoisted(() => ({ parseTsunamiMock: vi.fn() }));
vi.mock("../../../src/dmdata/telegram-parser", () => ({
  parseTsunamiTelegram: parseTsunamiMock,
}));

const T1 = "2026-01-01T00:00:00+09:00";
const T2 = "2026-01-01T00:01:00+09:00";
const T3 = "2026-01-01T00:02:00+09:00";
const T4 = "2026-01-01T00:03:00+09:00";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function persistencePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-tsunami-foundation-"));
  tempDirs.push(dir);
  return path.join(dir, "display-active-state-v1.json");
}

function legacyState(): PersistedStandbyStateV1 {
  return {
    version: 1,
    savedAt: T2,
    heat: [], typhoons: [], volcanoes: [], floods: { events: [], seen: [] },
    weatherAlerts: [], tornado: [], longPeriod: [], quakeHost: null,
    nankaiTrough: null, seen: [],
  };
}

function message(type: "VTSE41" | "VTSE51" | "VTSE52", id: string): WsDataMessage {
  return {
    type: "data",
    version: "2.0",
    classification: "telegram.earthquake",
    id,
    passing: [],
    head: { type, author: "気象庁", time: T1, test: false, xml: true },
    format: "xml",
    compression: null,
    encoding: "utf-8",
    body: "mocked",
  };
}

function observation(code: string | null, name: string, value: string): TsunamiObservationStation {
  return canonicalizeLegacyTsunamiObservation({
    areaName: "岩手県",
    stationCode: code,
    name,
    sensor: "",
    arrivalTime: "",
    initial: "押し",
    maxHeightCondition: "観測中",
    maxHeightValue: value,
  });
}

function info(options: {
  type?: "VTSE41" | "VTSE51" | "VTSE52";
  infoType?: "発表" | "訂正" | "取消";
  at?: string;
  serial?: string | null;
  observations?: TsunamiObservationStation[];
  kind?: string;
  eventId?: string;
  areaCode?: string | null;
  kindCode?: string | null;
  messageId?: string;
  forecast?: LegacyTsunamiForecastItemInput[];
  earthquake?: ParsedTsunamiInfo["earthquake"];
} = {}): ParsedTsunamiInfo {
  const type = options.type ?? "VTSE41";
  const infoType = options.infoType ?? "発表";
  const at = options.at ?? T1;
  const meta = createTelegramMeta({
    messageId: options.messageId ?? `${type}:${infoType}:${at}:${options.serial ?? ""}`,
    eventId: options.eventId ?? "tsunami-event",
    type,
    reportDateTime: at,
    serial: options.serial ?? (type === "VTSE41" ? null : "1"),
    infoType,
    receivedAtMs: Date.parse(at) + 1_000,
    status: "通常",
    isTest: false,
  });
  return canonicalizeLegacyTsunamiInfo({
    type,
    infoType,
    title: "津波警報・注意報・予報",
    reportDateTime: at,
    headline: null,
    publishingOffice: "気象庁",
    forecast: type === "VTSE41"
      ? options.forecast ?? (infoType !== "取消" ? [{
          areaCode: options.areaCode === undefined ? "210" : options.areaCode,
          areaName: "岩手県",
          kindCode: options.kindCode === undefined ? "51" : options.kindCode,
          kind: options.kind ?? "津波警報",
          maxHeightDescription: "3m",
          firstHeight: "到達中と推測",
        }] : undefined)
      : undefined,
    observations: options.observations,
    warningComment: "",
    ...(options.earthquake == null ? {} : { earthquake: options.earthquake }),
    meta,
    isTest: false,
  });
}

function deps() {
  return {
    tsunamiState: new TsunamiStateHolder(),
    revisionGate: new TelegramRevisionGate(),
  };
}

function run(parsed: ParsedTsunamiInfo, shared: ReturnType<typeof deps>) {
  parseTsunamiMock.mockReturnValueOnce(parsed);
  return processTsunami(message(parsed.type as "VTSE41" | "VTSE51" | "VTSE52", parsed.meta.messageId), shared);
}

describe("Phase 3B tsunami common registry", () => {
  beforeEach(() => parseTsunamiMock.mockReset());

  it("VTSE41 は EventID subject の clearCurrent で取消後の遅着報を拒否する", () => {
    const shared = deps();
    expect(run(info({ at: T1 }), shared).kind).toBe("ok");
    expect(run(info({ infoType: "取消", at: T2 }), shared).kind).toBe("ok");
    expect(run(info({ at: T1, messageId: "delayed" }), shared)).toEqual({ kind: "suppressed" });
    expect(shared.tsunamiState.getLevel()).toBeNull();
  });

  it("VTSE41 の取消は名称でなく EventID + code keyed state を対象にする", () => {
    const shared = deps();
    expect(run(info({ eventId: "event-a", areaCode: "210", at: T1 }), shared).kind).toBe("ok");
    expect(run(info({ eventId: "event-b", areaCode: "220", at: T2 }), shared).kind).toBe("ok");
    expect(run(info({ eventId: "event-a", infoType: "取消", at: T3 }), shared).kind).toBe("ok");

    expect(shared.tsunamiState.getLastInfo()?.forecast).toEqual([
      expect.objectContaining({ areaCode: "220", areaName: "岩手県", kindCode: "51" }),
    ]);
  });

  it("Presentation→DisplayStateStore は複数 EventID の安全側 aggregate を維持し、取消後は残存 Event を表示する", () => {
    const shared = deps();
    const displayStore = new DisplayStateStore();
    const applyToDisplay = (result: ReturnType<typeof run>, now: number): void => {
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      const event = fromTsunamiOutcome(result.outcome);
      displayStore.applyEvent(
        projectDisplayEvent(event, "津波警報・注意報"),
        now,
        event.tsunamiObservations,
        null,
        event.tsunamiObservationGroups,
      );
    };

    const major = run(info({
      eventId: "event-a",
      areaCode: "210",
      kindCode: "53",
      kind: "大津波警報",
      at: T1,
      messageId: "event-a-major",
    }), shared);
    applyToDisplay(major, Date.parse(T1));
    const advisory = run(info({
      eventId: "event-b",
      at: T2,
      messageId: "event-b-advisory",
      forecast: [{
        areaCode: "220",
        areaName: "宮城県",
        kindCode: "62",
        kind: "津波注意報",
        maxHeightDescription: "1m",
        firstHeight: "",
      }],
    }), shared);
    expect(advisory.kind).toBe("ok");
    if (advisory.kind !== "ok") return;
    expect(advisory.outcome.parsed.forecast?.map((item) => item.areaCode))
      .toEqual(["220"]);
    expect(advisory.outcome.displaySnapshot.forecast?.map((item) => item.areaCode).sort())
      .toEqual(["210", "220"]);
    expect(advisory.outcome.presentation).toMatchObject({
      frameLevel: "critical",
      soundLevel: "critical",
    });
    const advisoryEvent = fromTsunamiOutcome(advisory.outcome);
    const advisoryDto = projectDisplayEvent(advisoryEvent, "津波注意報");
    expect(advisoryEvent.tsunamiKinds).toEqual(["津波注意報"]);
    expect(advisoryEvent.forecastAreaNames).toEqual(["宮城県"]);
    expect(advisoryDto).toMatchObject({
      tickerSentence: "宮城県に津波注意報",
      tickerPriority: "mid",
      tickerSurface: "none",
      emergency: { kind: "tsunami", level: "majorWarning" },
    });
    applyToDisplay(advisory, Date.parse(T2));

    expect(displayStore.snapshot(1, Date.parse(T2)).tsunami).toMatchObject({
      level: "majorWarning",
    });

    const cancellation = run(info({
      eventId: "event-a",
      infoType: "取消",
      at: T3,
      messageId: "event-a-cancel",
    }), shared);
    expect(cancellation.kind).toBe("ok");
    if (cancellation.kind !== "ok") return;
    expect(cancellation.outcome.parsed).toMatchObject({ infoType: "取消" });
    expect(cancellation.outcome.displaySnapshot.forecast).toEqual([
      expect.objectContaining({ areaCode: "220", kindCode: "62" }),
    ]);
    expect(cancellation.outcome.presentation).toMatchObject({
      frameLevel: "normal",
      soundLevel: "cancel",
    });
    const cancellationEvent = fromTsunamiOutcome(cancellation.outcome);
    const cancellationDto = projectDisplayEvent(cancellationEvent, "津波取消");
    expect(cancellationEvent.isCancellation).toBe(true);
    expect(cancellationDto.tickerSentence).toBe("津波情報は取り消されました。");
    expect(cancellationDto.emergency).toMatchObject({ kind: "tsunami", level: "advisory" });
    applyToDisplay(cancellation, Date.parse(T3));

    expect(displayStore.snapshot(2, Date.parse(T3)).tsunami).toMatchObject({
      level: "advisory",
    });
  });

  it("unkeyed VTSE41 は state・永続化に入れず Presentation→DisplayStateStore へ fail-open 表示する", () => {
    const shared = deps();
    const result = run(info({
      eventId: "event-unkeyed",
      at: T1,
      messageId: "event-unkeyed-warning",
      forecast: [{
        areaCode: null,
        areaName: "名称だけの予報区",
        kindCode: null,
        kind: "津波警報",
        maxHeightDescription: "3m",
        firstHeight: "到達中と推測",
      }],
    }), shared);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(shared.tsunamiState.getLastInfo()).toBeNull();
    expect(shared.tsunamiState.getPersistedActive()).toBeNull();

    const displayStore = new DisplayStateStore();
    const event = fromTsunamiOutcome(result.outcome);
    expect(displayStore.applyEvent(
      projectDisplayEvent(event, "津波警報"),
      Date.parse(T1),
      event.tsunamiObservations,
      null,
      event.tsunamiObservationGroups,
    )).toBe(true);
    expect(displayStore.snapshot(1, Date.parse(T1)).tsunami).toMatchObject({
      level: "warning",
    });
  });

  it("同一 revision の訂正を一度だけ受理し、presentation に訂正を明示する", () => {
    const shared = deps();
    expect(run(info({ at: T1 }), shared).kind).toBe("ok");
    const correction = info({ infoType: "訂正", at: T1, kind: "大津波警報", messageId: "correction-1" });
    const accepted = run(correction, shared);
    expect(accepted.kind).toBe("ok");
    if (accepted.kind === "ok") expect(accepted.outcome.presentation.acceptedCorrection).toBe(true);
    expect(shared.tsunamiState.getLevel()).toBe("大津波警報");
    expect(run({ ...correction, meta: { ...correction.meta, messageId: "correction-retry" } }, shared)).toEqual({ kind: "suppressed" });
  });

  it("VTSE51 の同一 revision 分割 item を順序に依存せず保持対象へ通す", () => {
    const a = observation("21001", "宮古", "1.0m");
    const b = observation("21002", "大船渡", "1.2m");
    for (const order of [[a, b], [b, a]]) {
      const shared = deps();
      const first = run(info({ type: "VTSE51", observations: [order[0]], messageId: `first-${order[0].name}` }), shared);
      const second = run(info({ type: "VTSE51", observations: [order[1]], messageId: `second-${order[1].name}` }), shared);
      expect(first.kind).toBe("ok");
      expect(second.kind).toBe("ok");
      if (first.kind === "ok" && second.kind === "ok") {
        expect([first.outcome.parsed.observations?.[0].stationCode, second.outcome.parsed.observations?.[0].stationCode].sort()).toEqual(["21001", "21002"]);
      }
    }
  });

  it("同一 station fragment の再送は抑制し、code 欠落 item は fail-open 表示する", () => {
    const shared = deps();
    const station = observation("21001", "宮古", "1.0m");
    expect(run(info({ type: "VTSE51", observations: [station], messageId: "station-1" }), shared).kind).toBe("ok");
    expect(run(info({ type: "VTSE51", observations: [station], messageId: "station-retry" }), shared)).toEqual({ kind: "suppressed" });
    const missingCode = observation(null, "名称のみ", "0.2m");
    const result = run(info({ type: "VTSE51", observations: [missingCode], messageId: "missing-code" }), shared);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.outcome.parsed.observations).toEqual([missingCode]);
  });

  it("VTSE51 の遅延旧報は未見 station を含んでも whole gate で棄却する", () => {
    const shared = deps();
    expect(run(info({
      type: "VTSE51",
      at: T2,
      serial: "2",
      observations: [observation("21001", "宮古", "2.0m")],
      messageId: "newer-observation",
    }), shared).kind).toBe("ok");
    expect(run(info({
      type: "VTSE51",
      at: T1,
      serial: "1",
      observations: [
        observation("21001", "宮古（旧報）", "0.5m"),
        observation("99999", "旧報だけの点", "9.9m"),
      ],
      messageId: "delayed-observation",
    }), shared)).toEqual({ kind: "suppressed" });
  });

  it("VTSE51 の同一 station 訂正は置換対象として一度だけ通す", () => {
    const shared = deps();
    const initial = observation("21001", "宮古", "1.0m");
    const corrected = observation("21001", "宮古", "1.5m");
    expect(run(info({ type: "VTSE51", observations: [initial], messageId: "obs-initial" }), shared).kind).toBe("ok");
    const correction = info({
      type: "VTSE51",
      infoType: "訂正",
      observations: [corrected],
      messageId: "obs-correction",
    });
    const accepted = run(correction, shared);
    expect(accepted.kind).toBe("ok");
    if (accepted.kind === "ok") {
      expect(accepted.outcome.parsed.observations).toEqual([corrected]);
      expect(accepted.outcome.presentation.acceptedCorrection).toBe(true);
    }
    expect(run({ ...correction, meta: { ...correction.meta, messageId: "obs-correction-retry" } }, shared))
      .toEqual({ kind: "suppressed" });
  });

  it("VTSE51 の同一 station・同一 revision の Area.Code だけの訂正を受理する", () => {
    const shared = deps();
    const initial = { ...observation("21001", "宮古", "1.0m"), areaCode: null };
    const corrected = { ...initial, areaCode: "210" };
    expect(run(info({
      type: "VTSE51",
      observations: [initial],
      messageId: "area-code-initial",
    }), shared).kind).toBe("ok");

    const firstCorrection = info({
      type: "VTSE51",
      infoType: "訂正",
      observations: [initial],
      messageId: "area-code-first-correction",
    });
    expect(run(firstCorrection, shared).kind).toBe("ok");
    expect(shared.tsunamiState.getObservationGroups().VTSE51).toEqual([initial]);

    const codeOnlyCorrection = info({
      type: "VTSE51",
      infoType: "訂正",
      observations: [corrected],
      messageId: "area-code-second-correction",
    });
    const accepted = run(codeOnlyCorrection, shared);
    expect(accepted.kind).toBe("ok");
    if (accepted.kind === "ok") {
      expect(accepted.outcome.parsed.observations).toEqual([corrected]);
      expect(accepted.outcome.presentation.acceptedCorrection).toBe(true);
    }
    expect(shared.tsunamiState.getObservationGroups().VTSE51).toEqual([corrected]);
    expect(run({
      ...codeOnlyCorrection,
      meta: { ...codeOnlyCorrection.meta, messageId: "area-code-second-correction-retry" },
    }, shared)).toEqual({ kind: "suppressed" });
  });

  it("VTSE51 の item 順序反転では訂正 fingerprint が変わらず再通知しない", () => {
    const shared = deps();
    const a = observation("21001", "宮古", "1.0m");
    const b = observation("21002", "大船渡", "1.2m");
    expect(run(info({
      type: "VTSE51",
      observations: [a, b],
      messageId: "ordered-initial",
    }), shared).kind).toBe("ok");
    const correction = info({
      type: "VTSE51",
      infoType: "訂正",
      observations: [{ ...a, maxHeightValue: "1.1m" }, b],
      messageId: "ordered-correction",
    });
    expect(run(correction, shared).kind).toBe("ok");
    expect(run({
      ...correction,
      observations: [...(correction.observations ?? [])].reverse(),
      meta: { ...correction.meta, messageId: "reordered-correction-retry" },
    }, shared)).toEqual({ kind: "suppressed" });
  });

  it("VTSE51 active observation と watermark を v2 往復して再送を抑止する", () => {
    const shared = deps();
    const station = observation("21001", "宮古", "1.0m");
    expect(run(info({
      type: "VTSE51",
      at: T1,
      observations: [station],
      messageId: "active-before-restart",
    }), shared).kind).toBe("ok");

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries().filter(
          (entry) => entry.domain === "tsunamiObservation",
        ),
      },
    }));
    persistence.save(legacyState());

    const loaded = persistence.load();
    expect(loaded?.telegramFoundation.tsunami.observations.VTSE51).toEqual([station]);
    const restored = deps();
    restored.tsunamiState.restoreObservationGroups(
      loaded!.telegramFoundation.tsunami.observations,
    );
    restored.revisionGate.restoreDurableEntries(
      loaded!.telegramFoundation.tsunami.gateEntries,
    );
    expect(run(info({
      type: "VTSE51",
      at: T1,
      observations: [station],
      messageId: "active-retry-after-restart",
    }), restored)).toEqual({ kind: "suppressed" });
    expect(restored.tsunamiState.getObservationGroups().VTSE51).toEqual([station]);
  });

  it("津波地震要素の Magnitude/Depth semantic を往復し、scalar-only v2 を読込移行する", () => {
    const shared = deps();
    const earthquake: NonNullable<ParsedTsunamiInfo["earthquake"]> = {
      originTime: T1,
      hypocenterName: "日本海溝",
      latitude: "+38.0",
      longitude: "+144.0",
      magnitude: "",
      magnitudeValue: {
        raw: "NaN",
        value: null,
        condition: null,
        description: "Ｍ８を超える巨大地震",
        presence: "qualitative",
      },
      depth: "600km",
      depthValue: {
        raw: "-600000",
        value: null,
        condition: "600km以上",
        description: "深さ600km以上",
        presence: "range",
        lowerBound: 600,
        rawLowerBound: "６００",
        rawUpperBound: null,
      },
    };
    expect(run(info({ earthquake, messageId: "earthquake-semantic" }), shared).kind).toBe("ok");
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        keyedActive: shared.tsunamiState.getPersistedKeyedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries().filter(
          (entry) => entry.domain === "tsunami",
        ),
      },
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    const persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    const persistedEarthquake = persisted.telegramFoundation.tsunami.keyedActive?.[0]?.earthquake;
    expect(persistedEarthquake).toMatchObject({
      magnitude: "",
      magnitudeValue: { presence: "qualitative", description: "Ｍ８を超える巨大地震" },
      depth: "600km",
      depthValue: { presence: "range", lowerBound: 600, rawLowerBound: "６００" },
    });
    expect(Object.hasOwn(persistedEarthquake!.magnitudeValue!, "lowerBound")).toBe(false);
    expect(Object.hasOwn(persistedEarthquake!.depthValue!, "upperBound")).toBe(false);
    const loadedEarthquake = persistence.load()?.telegramFoundation.tsunami.keyedActive?.[0]?.earthquake;
    expect(loadedEarthquake).toMatchObject({
      ...earthquake,
      depthValue: {
        raw: "-600000",
        value: null,
        condition: "600km以上",
        description: "深さ600km以上",
        presence: "range",
        lowerBound: 600,
        rawLowerBound: "６００",
      },
    });
    expect(Object.hasOwn(loadedEarthquake!.depthValue!, "rawUpperBound")).toBe(false);

    const scalarOnly = structuredClone(persisted);
    const scalarEarthquake = scalarOnly.telegramFoundation.tsunami.keyedActive![0]!.earthquake!;
    scalarEarthquake.magnitude = "6.0";
    scalarEarthquake.depth = "30km";
    delete scalarEarthquake.magnitudeValue;
    delete scalarEarthquake.depthValue;
    fs.writeFileSync(v2Path, JSON.stringify(scalarOnly), "utf8");
    expect(persistence.load()?.telegramFoundation.tsunami.keyedActive?.[0]?.earthquake)
      .toMatchObject({
        magnitude: "6.0",
        magnitudeValue: { presence: "value", value: 6, raw: "6.0" },
        depth: "30km",
        depthValue: { presence: "value", value: 30, raw: "30km" },
      });

    const nullableLegacy = scalarEarthquake as unknown as {
      magnitude: string | null;
      depth: string | null;
      magnitudeValue?: unknown;
      depthValue?: unknown;
    };
    nullableLegacy.magnitude = null;
    nullableLegacy.depth = "";
    delete nullableLegacy.magnitudeValue;
    delete nullableLegacy.depthValue;
    fs.writeFileSync(v2Path, JSON.stringify(scalarOnly), "utf8");
    expect(persistence.load()?.telegramFoundation.tsunami.keyedActive?.[0]?.earthquake)
      .toMatchObject({
        magnitude: "",
        magnitudeValue: { raw: null, presence: "missing", value: null },
        depth: "",
        depthValue: { raw: null, presence: "missing", value: null },
      });
  });

  it("津波地震要素の upper-only numeric bounds を standby owner で round-trip する", () => {
    const shared = deps();
    const earthquake: NonNullable<ParsedTsunamiInfo["earthquake"]> = {
      originTime: T1,
      hypocenterName: "日本海溝",
      latitude: "+38.0",
      longitude: "+144.0",
      magnitude: "7.0",
      magnitudeValue: {
        raw: "7.0", value: null, condition: "7.0以下", description: "M7.0以下",
        presence: "range", upperBound: 7, rawUpperBound: "７．０",
        diagnostics: ["unmappedSpecialValue"],
      },
      depth: "999km",
      depthValue: {
        raw: "-999000", value: null, condition: "999km以下", description: "深さ999km以下",
        presence: "range", upperBound: 999, rawUpperBound: "９９９",
        diagnostics: ["specialValueConflict"],
      },
    };
    expect(run(info({ earthquake, messageId: "earthquake-upper-only" }), shared).kind).toBe("ok");
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        keyedActive: shared.tsunamiState.getPersistedKeyedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries().filter(
          (entry) => entry.domain === "tsunami",
        ),
      },
    }));
    persistence.save(legacyState());

    const loaded = persistence.load()!.telegramFoundation.tsunami.keyedActive![0]!.earthquake;
    expect(loaded).toMatchObject({
      magnitudeValue: {
        presence: "range", upperBound: 7, rawUpperBound: "７．０",
        diagnostics: ["unmappedSpecialValue"],
      },
      depthValue: {
        presence: "range", upperBound: 999, rawUpperBound: "９９９",
        diagnostics: ["specialValueConflict"],
      },
    });
    expect(Object.hasOwn(loaded!.magnitudeValue!, "lowerBound")).toBe(false);
    expect(Object.hasOwn(loaded!.depthValue!, "rawLowerBound")).toBe(false);
  });

  it.each(["scalar", "legacyActive"] as const)(
    "津波の壊れた旧 %s active は対応する non-cancel gate も局所破棄する",
    (shape) => {
      const shared = deps();
      const earthquake: NonNullable<ParsedTsunamiInfo["earthquake"]> = {
        originTime: T1,
        hypocenterName: "日本海溝",
        latitude: "+38.0",
        longitude: "+144.0",
        magnitude: "6.0",
        magnitudeValue: {
          raw: "6.0", value: 6, condition: null, description: null, presence: "value",
        },
        depth: "30km",
        depthValue: {
          raw: "-30000", value: 30, condition: null, description: null, presence: "value",
        },
      };
      expect(run(info({
        eventId: `broken-${shape}`,
        earthquake,
        messageId: `broken-${shape}-active`,
      }), shared).kind).toBe("ok");
      const file = persistencePath();
      const persistence = new StandbyPersistence(file, 0, () => ({
        vpws50: { authoritative: true, state: null, gateEntries: [] },
        tsunami: {
          keyedActive: shared.tsunamiState.getPersistedKeyedActive(),
          observations: shared.tsunamiState.getObservationGroups(),
          gateEntries: shared.revisionGate.exportDurableEntries().filter(
            (entry) => entry.domain === "tsunami",
          ),
        },
      }));
      persistence.save(legacyState());
      const v2Path = standbyPersistenceV2Path(file);
      const persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
      const broken = structuredClone(persisted.telegramFoundation.tsunami.keyedActive![0]!);
      broken.earthquake!.magnitudeValue = {
        raw: "6.0", value: 6, condition: null, description: null, presence: "range",
      };
      if (shape === "scalar") {
        persisted.telegramFoundation.tsunami.active = broken;
        delete persisted.telegramFoundation.tsunami.keyedActive;
        delete persisted.telegramFoundation.tsunami.legacyActive;
      } else {
        persisted.telegramFoundation.tsunami.keyedActive = [];
        persisted.telegramFoundation.tsunami.legacyActive = broken;
        delete persisted.telegramFoundation.tsunami.active;
      }
      fs.writeFileSync(v2Path, JSON.stringify(persisted), "utf8");

      const loaded = persistence.load()!.telegramFoundation.tsunami;
      expect(loaded.keyedActive).toEqual([]);
      expect(loaded.legacyActive).toBeNull();
      expect(loaded.gateEntries.filter((entry) => entry.domain === "tsunami")).toEqual([]);
    },
  );

  it("観測 Area.Code を v2 schema へ保存し、再保存しても observation shape を維持する", () => {
    const shared = deps();
    const legacyStation = observation("21001", "宮古", "1.0m");
    const legacyActiveStation = observation("22001", "釜石", "0.8m");
    const stationWithAreaCode: TsunamiObservationStation = {
      ...legacyStation,
      areaCode: "210",
    };
    const activeStationWithAreaCode: TsunamiObservationStation = {
      ...legacyActiveStation,
      areaCode: "220",
    };
    expect(run(info({
      type: "VTSE41",
      at: T1,
      observations: [activeStationWithAreaCode],
      messageId: "coded-active-before-persist",
    }), shared).kind).toBe("ok");
    expect(run(info({
      type: "VTSE51",
      at: T1,
      observations: [stationWithAreaCode],
      messageId: "coded-observation-before-persist",
    }), shared).kind).toBe("ok");

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries().filter(
          (entry) => entry.domain === "tsunami" || entry.domain === "tsunamiObservation",
        ),
      },
    }));
    persistence.save(legacyState());

    const firstPersisted = JSON.parse(
      fs.readFileSync(standbyPersistenceV2Path(file), "utf8"),
    ) as PersistedStandbyStateV2;
    const firstObservation = firstPersisted.telegramFoundation.tsunami.observations.VTSE51[0];
    expect(firstObservation).toEqual(stationWithAreaCode);
    expect(firstObservation).toHaveProperty("areaCode", "210");
    expect(firstPersisted.telegramFoundation.tsunami.keyedActive?.[0]?.observations)
      .toEqual([activeStationWithAreaCode]);
    expect(JSON.stringify({
      active: firstPersisted.telegramFoundation.tsunami.keyedActive?.[0]?.observations,
      groups: firstPersisted.telegramFoundation.tsunami.observations,
    }))
      .toContain("areaCode");

    const loaded = persistence.load()!;
    expect(loaded.telegramFoundation.tsunami.observations.VTSE51).toEqual([stationWithAreaCode]);
    expect(loaded.telegramFoundation.tsunami.keyedActive?.[0]?.observations)
      .toEqual([activeStationWithAreaCode]);
    const roundTrip = new StandbyPersistence(file, 0, () => loaded.telegramFoundation);
    roundTrip.save(loaded);

    const secondPersisted = JSON.parse(
      fs.readFileSync(standbyPersistenceV2Path(file), "utf8"),
    ) as PersistedStandbyStateV2;
    expect(secondPersisted.telegramFoundation.tsunami.observations.VTSE51[0])
      .toEqual(firstObservation);
    expect(JSON.stringify({
      active: secondPersisted.telegramFoundation.tsunami.keyedActive?.[0]?.observations,
      groups: secondPersisted.telegramFoundation.tsunami.observations,
    }))
      .toContain("areaCode");
  });

  it("保存済み v2 JSON の観測 Area.Code を load 時に保持する", () => {
    const shared = deps();
    const station = observation("21001", "宮古", "1.0m");
    const activeStation = observation("22001", "釜石", "0.8m");
    expect(run(info({
      type: "VTSE41",
      at: T1,
      observations: [activeStation],
      messageId: "active-before-read-sanitize",
    }), shared).kind).toBe("ok");
    expect(run(info({
      type: "VTSE51",
      at: T1,
      observations: [station],
      messageId: "observation-before-read-sanitize",
    }), shared).kind).toBe("ok");

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries().filter(
          (entry) => entry.domain === "tsunami" || entry.domain === "tsunamiObservation",
        ),
      },
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    const persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    const leakedObservation = persisted.telegramFoundation.tsunami.observations
      .VTSE51[0] as unknown as TsunamiObservationStation;
    const leakedActiveObservation = persisted.telegramFoundation.tsunami.keyedActive?.[0]
      ?.observations?.[0] as unknown as TsunamiObservationStation;
    leakedObservation.areaCode = "210";
    leakedActiveObservation.areaCode = "220";
    fs.writeFileSync(v2Path, JSON.stringify(persisted), "utf8");
    const injected = JSON.parse(fs.readFileSync(v2Path, "utf8")) as unknown as {
      telegramFoundation: {
        tsunami: {
          keyedActive: Array<{ observations: TsunamiObservationStation[] }>;
          observations: { VTSE51: TsunamiObservationStation[] };
        };
      };
    };
    expect(injected.telegramFoundation.tsunami.observations.VTSE51[0]?.areaCode).toBe("210");
    expect(injected.telegramFoundation.tsunami.keyedActive[0]?.observations[0]?.areaCode).toBe("220");

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    const loadedObservation = loaded.observations.VTSE51[0];
    expect(loadedObservation).toEqual({ ...station, areaCode: "210" });
    expect(loadedObservation).toHaveProperty("areaCode", "210");
    expect(loaded.keyedActive?.[0]?.observations).toEqual([{ ...activeStation, areaCode: "220" }]);
    expect(JSON.stringify({
      active: loaded.keyedActive?.[0]?.observations,
      groups: loaded.observations,
    })).toContain("areaCode");
  });

  it("VTSE41 active snapshot と watermark を v2 往復し、REST 不通でも警報を維持する", () => {
    const shared = deps();
    const active = info({ type: "VTSE41", at: T1, messageId: "active-vtse41" });
    expect(run(active, shared).kind).toBe("ok");

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries().filter(
          (entry) => entry.domain === "tsunami" || entry.domain === "tsunamiObservation",
        ),
      },
    }));
    persistence.save(legacyState());

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.active).toEqual(active);
    expect(loaded.gateEntries).toEqual([
      expect.objectContaining({
        domain: "tsunami",
        revisionFamily: "VTSE41",
        stateSubjectKey: "tsunami:tsunami-event",
        cancelled: false,
      }),
    ]);
    const restarted = deps();
    restarted.tsunamiState.restorePersistedState(loaded.active ?? null, loaded.observations);
    restarted.revisionGate.restoreDurableEntries(loaded.gateEntries);
    // REST が失敗して何も補完できない場合でも、disk snapshot が active state の真実源になる。
    expect(restarted.tsunamiState.getLevel()).toBe("津波警報");
    expect(restarted.tsunamiState.getLastInfo()).toEqual(active);
  });

  it("複数 EventID の VTSE41 keyed state を実ファイル経由で往復し、取消後も残存 EventID を保つ", () => {
    const shared = deps();
    expect(run(info({
      eventId: "event-a",
      areaCode: "210",
      kindCode: "53",
      kind: "大津波警報",
      at: T1,
      messageId: "persist-event-a",
    }), shared).kind).toBe("ok");
    expect(run(info({
      eventId: "event-b",
      areaCode: "220",
      kindCode: "62",
      kind: "津波注意報",
      at: T2,
      messageId: "persist-event-b",
    }), shared).kind).toBe("ok");
    expect(shared.tsunamiState.getPersistedActive()).toBeNull();

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        keyedActive: shared.tsunamiState.getPersistedKeyedActive(),
        legacyActive: shared.tsunamiState.getPersistedLegacyActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries().filter(
          (entry) => entry.domain === "tsunami" || entry.domain === "tsunamiObservation",
        ),
      },
    }));
    persistence.save(legacyState());

    let loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.active).toBeUndefined();
    expect(loaded.keyedActive?.map((item) => item.meta.eventId.value).sort())
      .toEqual(["event-a", "event-b"]);
    expect(loaded.gateEntries.filter((entry) => entry.domain === "tsunami")).toHaveLength(2);
    const restarted = new TsunamiStateHolder();
    restarted.restorePersistedState(
      null,
      loaded.observations,
      loaded.keyedActive ?? [],
      loaded.legacyActive ?? null,
    );
    expect(restarted.getLastInfo()?.forecast?.map((item) => item.areaCode).sort())
      .toEqual(["210", "220"]);

    expect(run(info({
      eventId: "event-a",
      infoType: "取消",
      at: T3,
      messageId: "persist-event-a-cancel",
    }), shared).kind).toBe("ok");
    persistence.save(legacyState());

    loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.active?.meta.eventId.value).toBe("event-b");
    expect(loaded.keyedActive?.map((item) => item.meta.eventId.value)).toEqual(["event-b"]);
    expect(loaded.active?.forecast).toEqual([
      expect.objectContaining({ areaCode: "220", kindCode: "62" }),
    ]);
  });

  it("警報レベルなしの keyed state は実ファイル往復し、forecast 空 state は書かない", () => {
    const shared = deps();
    expect(run(info({
      eventId: "sea-level-only",
      areaCode: "210",
      kindCode: "71",
      kind: "津波予報（若干の海面変動）",
      at: T1,
      messageId: "sea-level-only",
    }), shared).kind).toBe("ok");
    expect(shared.tsunamiState.getLevel()).toBeNull();
    expect(shared.tsunamiState.getPersistedKeyedActive()).toHaveLength(1);

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        keyedActive: shared.tsunamiState.getPersistedKeyedActive(),
        legacyActive: null,
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());

    let loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.keyedActive).toEqual([
      expect.objectContaining({
        meta: expect.objectContaining({ eventId: expect.objectContaining({ value: "sea-level-only" }) }),
        forecast: [expect.objectContaining({ kindCode: "71" })],
      }),
    ]);
    const restarted = new TsunamiStateHolder();
    restarted.restorePersistedState(null, loaded.observations, loaded.keyedActive ?? []);
    expect(restarted.getLevel()).toBeNull();
    expect(restarted.getPersistedKeyedActive()).toHaveLength(1);

    expect(run(info({
      eventId: "sea-level-only",
      forecast: [],
      at: T2,
      messageId: "sea-level-empty",
    }), shared).kind).toBe("ok");
    persistence.save(legacyState());
    loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.keyedActive).toEqual([]);
    expect(loaded.gateEntries).toEqual([
      expect.objectContaining({ stateSubjectKey: "tsunami:sea-level-only", cancelled: false }),
    ]);
  });

  it("壊れた旧 scalar と keyed 一要素を局所破棄し、正常 EventID と gate を救済する", () => {
    const shared = deps();
    expect(run(info({ eventId: "salvage-a", at: T1, messageId: "salvage-a" }), shared).kind).toBe("ok");
    expect(run(info({ eventId: "salvage-b", at: T2, messageId: "salvage-b" }), shared).kind).toBe("ok");
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        keyedActive: shared.tsunamiState.getPersistedKeyedActive(),
        legacyActive: null,
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    const persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    persisted.telegramFoundation.tsunami.active = { broken: true } as never;
    const broken = persisted.telegramFoundation.tsunami.keyedActive!.find(
      (active) => active.meta.eventId.value === "salvage-a",
    ) as unknown as Record<string, unknown>;
    broken.title = 42;
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.keyedActive?.map((active) => active.meta.eventId.value)).toEqual(["salvage-b"]);
    expect(loaded.gateEntries.filter((entry) => entry.domain === "tsunami")
      .map((entry) => entry.stateSubjectKey)).toEqual(["tsunami:salvage-b"]);
  });

  it("同一 EventID の keyed＋legacy 混在は legacy を退場させ、keyed と gate を同期して復元する", () => {
    const shared = deps();
    const canonical = info({ eventId: "mixed-event", at: T2, messageId: "mixed-keyed" });
    const legacy = info({
      eventId: "mixed-event",
      areaCode: null,
      kindCode: null,
      kind: "大津波警報",
      at: T1,
      messageId: "mixed-legacy",
    });
    expect(run(canonical, shared).kind).toBe("ok");
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        keyedActive: shared.tsunamiState.getPersistedKeyedActive(),
        legacyActive: legacy,
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    const persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    expect(persisted.telegramFoundation.tsunami.legacyActive).toBeNull();
    expect(persisted.telegramFoundation.tsunami.keyedActive).toHaveLength(1);
    expect(persisted.telegramFoundation.tsunami.gateEntries).toHaveLength(1);
    // reader 側にも混在 raw を与え、同じ解決規則を検証する。
    persisted.telegramFoundation.tsunami.legacyActive = legacy;
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.keyedActive?.map((active) => active.meta.eventId.value)).toEqual(["mixed-event"]);
    expect(loaded.legacyActive).toBeNull();
    expect(loaded.gateEntries).toEqual([
      expect.objectContaining({ stateSubjectKey: "tsunami:mixed-event", cancelled: false }),
    ]);
    const restored = new TsunamiStateHolder();
    restored.restorePersistedState(null, loaded.observations, loaded.keyedActive ?? [], loaded.legacyActive ?? null);
    expect(restored.getLastInfo()?.forecast).toHaveLength(1);
    expect(restored.getLastInfo()?.forecast?.[0]).toMatchObject({ areaCode: "210" });
  });

  it("keyed EventID 重複は新しい revision を残し、512 compaction 後も holder と gate を一対一にする", () => {
    const shared = deps();
    expect(run(info({ eventId: "capacity-0", at: T2, messageId: "capacity-base" }), shared).kind).toBe("ok");
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        keyedActive: shared.tsunamiState.getPersistedKeyedActive(),
        legacyActive: null,
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    const persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    const baseActive = persisted.telegramFoundation.tsunami.keyedActive![0]!;
    const baseGate = persisted.telegramFoundation.tsunami.gateEntries[0]!;
    persisted.telegramFoundation.tsunami.keyedActive = Array.from({ length: 513 }, (_, index) => {
      const active = structuredClone(baseActive);
      const eventId = `capacity-${index}`;
      active.meta.eventId = { raw: eventId, value: eventId, valid: true };
      active.meta.messageId = `capacity-active-${index}`;
      return active;
    });
    persisted.telegramFoundation.tsunami.gateEntries = Array.from({ length: 513 }, (_, index) => {
      const gate = structuredClone(baseGate);
      const eventId = `capacity-${index}`;
      const subject = `tsunami:${eventId}`;
      gate.stateSubjectKey = subject;
      gate.comparison.stateSubjectKey = subject;
      gate.comparison.revision.eventId = { raw: subject, value: subject, valid: true };
      gate.acceptedAtMs += index;
      return gate;
    });
    persisted.telegramFoundation.tsunami.keyedActive.push(info({
      eventId: "capacity-512",
      at: T1,
      messageId: "capacity-duplicate-older",
    }));
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    const keyedSubjects = loaded.keyedActive!.map((active) => `tsunami:${active.meta.eventId.value}`);
    const gateSubjects = loaded.gateEntries
      .filter((entry) => entry.domain === "tsunami")
      .map((entry) => entry.stateSubjectKey);
    expect(loaded.keyedActive).toHaveLength(TSUNAMI_REVISION_FAMILY_POLICIES.VTSE41.maxSubjects);
    expect(gateSubjects).toHaveLength(TSUNAMI_REVISION_FAMILY_POLICIES.VTSE41.maxSubjects);
    expect(new Set(keyedSubjects)).toEqual(new Set(gateSubjects));
    expect(loaded.keyedActive?.find((active) => active.meta.eventId.value === "capacity-512")
      ?.meta.reportDateTime.raw).toBe(T2);
  });

  it("persisted 取消 payload は keyed／legacy active にせず gate だけを残す", () => {
    const shared = deps();
    expect(run(info({ eventId: "cancel-payload", at: T1, messageId: "cancel-base" }), shared).kind).toBe("ok");
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        keyedActive: shared.tsunamiState.getPersistedKeyedActive(),
        legacyActive: null,
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    const persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    const cancellation = structuredClone(persisted.telegramFoundation.tsunami.keyedActive![0]!);
    (cancellation as unknown as Record<string, unknown>).infoType = "取消";
    cancellation.meta.infoType = { raw: "取消", value: "取消", valid: true };
    persisted.telegramFoundation.tsunami.gateEntries[0]!.comparison.revision.infoType = {
      raw: "取消", value: "取消", valid: true,
    };
    persisted.telegramFoundation.tsunami.keyedActive = [cancellation];
    persisted.telegramFoundation.tsunami.legacyActive = cancellation;
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.keyedActive).toEqual([]);
    expect(loaded.legacyActive).toBeNull();
    expect(loaded.gateEntries).toEqual([
      expect.objectContaining({ stateSubjectKey: "tsunami:cancel-payload", cancelled: false }),
    ]);
    const restored = new TsunamiStateHolder();
    restored.restorePersistedState(null, loaded.observations, loaded.keyedActive ?? [], loaded.legacyActive ?? null);
    expect(restored.getLastInfo()).toBeNull();
  });

  it("古い active と新しい取消 tombstone の併存は active だけを捨て、再起動後も遅延報を拒否する", () => {
    const shared = deps();
    const stale = info({ eventId: "stale-before-cancel", at: T1, messageId: "stale-active" });
    expect(run(stale, shared).kind).toBe("ok");
    expect(run(info({
      eventId: "stale-before-cancel",
      infoType: "取消",
      at: T2,
      messageId: "newer-cancellation",
    }), shared).kind).toBe("ok");
    const foundation = {
      keyedActive: [stale],
      legacyActive: null,
      observations: shared.tsunamiState.getObservationGroups(),
      gateEntries: shared.revisionGate.exportDurableEntries(),
    };
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: foundation,
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    let persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    // writer も stale active だけを落とし、tombstone を残す。
    expect(persisted.telegramFoundation.tsunami.keyedActive).toEqual([]);
    expect(persisted.telegramFoundation.tsunami.gateEntries).toEqual([
      expect.objectContaining({ stateSubjectKey: "tsunami:stale-before-cancel", cancelled: true }),
    ]);
    // 部分書込みで stale active が残った raw を reader に直接与える。
    persisted.telegramFoundation.tsunami = structuredClone(foundation);
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.keyedActive).toEqual([]);
    expect(loaded.gateEntries).toEqual([
      expect.objectContaining({ stateSubjectKey: "tsunami:stale-before-cancel", cancelled: true }),
    ]);
    const restarted = deps();
    restarted.tsunamiState.restorePersistedState(null, loaded.observations, loaded.keyedActive ?? []);
    restarted.revisionGate.restoreDurableEntries(loaded.gateEntries);
    expect(run({
      ...stale,
      meta: { ...stale.meta, messageId: "delayed-after-tombstone-restart" },
    }, restarted)).toEqual({ kind: "suppressed" });
    expect(restarted.tsunamiState.getLastInfo()).toBeNull();
  });

  it("legacy 表示と同 EventID の新しい取消 tombstone を併存保存し、再起動後も遅延報を拒否する", () => {
    const shared = deps();
    const legacy = info({
      eventId: "legacy-with-tombstone",
      areaCode: null,
      kindCode: null,
      kind: "大津波警報",
      at: T1,
      messageId: "legacy-before-cancel",
    });
    shared.tsunamiState.restorePersistedState(
      null,
      { VTSE51: [], VTSE52: [] },
      [],
      legacy,
    );
    expect(run(info({
      eventId: "legacy-with-tombstone",
      infoType: "取消",
      at: T2,
      messageId: "canonical-cancel-after-legacy",
    }), shared).kind).toBe("ok");
    expect(shared.tsunamiState.getPersistedLegacyActive()).not.toBeNull();
    expect(shared.revisionGate.exportDurableEntries()).toEqual([
      expect.objectContaining({ stateSubjectKey: "tsunami:legacy-with-tombstone", cancelled: true }),
    ]);

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        keyedActive: shared.tsunamiState.getPersistedKeyedActive(),
        legacyActive: shared.tsunamiState.getPersistedLegacyActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());

    const raw = JSON.parse(
      fs.readFileSync(standbyPersistenceV2Path(file), "utf8"),
    ) as PersistedStandbyStateV2;
    expect(raw.telegramFoundation.tsunami.legacyActive).not.toBeNull();
    expect(raw.telegramFoundation.tsunami.gateEntries).toEqual([
      expect.objectContaining({ stateSubjectKey: "tsunami:legacy-with-tombstone", cancelled: true }),
    ]);
    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.legacyActive).not.toBeNull();
    expect(loaded.gateEntries).toEqual([
      expect.objectContaining({ stateSubjectKey: "tsunami:legacy-with-tombstone", cancelled: true }),
    ]);

    const restarted = deps();
    restarted.tsunamiState.restorePersistedState(
      null,
      loaded.observations,
      loaded.keyedActive ?? [],
      loaded.legacyActive ?? null,
    );
    restarted.revisionGate.restoreDurableEntries(loaded.gateEntries);
    const delayed = info({
      eventId: "legacy-with-tombstone",
      at: T1,
      messageId: "delayed-after-legacy-tombstone",
    });
    expect(run(delayed, restarted)).toEqual({ kind: "suppressed" });
    expect(restarted.tsunamiState.getPersistedLegacyActive()).not.toBeNull();
  });

  it("同一 EventID・同一日時で Serial が片側だけ欠落する重複 active は subject 単位で拒否する", () => {
    const shared = deps();
    const serialActive = info({
      eventId: "unordered-active",
      serial: "2",
      at: T1,
      messageId: "unordered-active-serial-2",
    });
    expect(run(serialActive, shared).kind).toBe("ok");
    const missingSerialActive = info({
      eventId: "unordered-active",
      serial: null,
      at: T1,
      messageId: "unordered-active-no-serial",
    });
    const foundation = {
      keyedActive: [serialActive, missingSerialActive],
      legacyActive: null,
      observations: shared.tsunamiState.getObservationGroups(),
      gateEntries: shared.revisionGate.exportDurableEntries(),
    };
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: foundation,
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    let persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    expect(persisted.telegramFoundation.tsunami.keyedActive).toEqual([]);
    expect(persisted.telegramFoundation.tsunami.gateEntries).toEqual([]);
    persisted.telegramFoundation.tsunami = structuredClone(foundation);
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.keyedActive).toEqual([]);
    expect(loaded.gateEntries).toEqual([]);
  });

  it("同一 subject の重複 gate は acceptedAtMs でなく revision 順で新しい取消 tombstone を残す", () => {
    const shared = deps();
    const stale = info({ eventId: "duplicate-gate", at: T1, messageId: "duplicate-gate-active" });
    expect(run(stale, shared).kind).toBe("ok");
    expect(run(info({
      eventId: "duplicate-gate",
      infoType: "取消",
      at: T2,
      messageId: "duplicate-gate-cancel",
    }), shared).kind).toBe("ok");
    const tombstone = shared.revisionGate.exportDurableEntries()[0]!;
    const oldNonCancel = structuredClone(tombstone);
    oldNonCancel.cancelled = false;
    oldNonCancel.acceptedAtMs = tombstone.acceptedAtMs + 60_000;
    oldNonCancel.comparison.revision.reportDateTime = {
      raw: T1, epochMs: Date.parse(T1), valid: true,
    };
    oldNonCancel.comparison.revision.infoType = { raw: "発表", value: "発表", valid: true };
    const foundation = {
      keyedActive: [],
      legacyActive: null,
      observations: shared.tsunamiState.getObservationGroups(),
      gateEntries: [oldNonCancel, tombstone],
    };
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: foundation,
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    let persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    expect(persisted.telegramFoundation.tsunami.gateEntries).toEqual([
      expect.objectContaining({ cancelled: true, acceptedAtMs: tombstone.acceptedAtMs }),
    ]);
    persisted.telegramFoundation.tsunami = structuredClone(foundation);
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.gateEntries).toEqual([
      expect.objectContaining({
        cancelled: true,
        comparison: expect.objectContaining({
          revision: expect.objectContaining({
            reportDateTime: expect.objectContaining({ raw: T2 }),
          }),
        }),
      }),
    ]);
    const restarted = deps();
    restarted.revisionGate.restoreDurableEntries(loaded.gateEntries);
    expect(run({
      ...stale,
      meta: { ...stale.meta, messageId: "delayed-after-duplicate-gate" },
    }, restarted)).toEqual({ kind: "suppressed" });
  });

  it("同一 subject・同一日時で Serial が片側だけ欠落する重複 gate は subject 単位で拒否する", () => {
    const shared = deps();
    expect(run(info({
      eventId: "unordered-gate",
      serial: "2",
      at: T1,
      messageId: "unordered-gate-serial-2",
    }), shared).kind).toBe("ok");
    const serialGate = shared.revisionGate.exportDurableEntries()[0]!;
    const missingSerialGate = structuredClone(serialGate);
    missingSerialGate.comparison.revision.serial = { raw: null, numeric: null, valid: false };
    missingSerialGate.acceptedAtMs += 60_000;
    const foundation = {
      keyedActive: [],
      legacyActive: null,
      observations: shared.tsunamiState.getObservationGroups(),
      gateEntries: [serialGate, missingSerialGate],
    };
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: foundation,
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    let persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    expect(persisted.telegramFoundation.tsunami.gateEntries).toEqual([]);
    persisted.telegramFoundation.tsunami = structuredClone(foundation);
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");
    expect(persistence.load()!.telegramFoundation.tsunami.gateEntries).toEqual([]);
  });

  it("3 件以上の重複 gate に unordered ペアが含まれれば、縮約順に関係なく subject 全体を拒否する", () => {
    const shared = deps();
    expect(run(info({
      eventId: "unordered-three-gates",
      serial: "3",
      at: T2,
      messageId: "unordered-three-base",
    }), shared).kind).toBe("ok");
    const t2Serial3 = shared.revisionGate.exportDurableEntries()[0]!;
    const t1Missing = structuredClone(t2Serial3);
    t1Missing.comparison.revision.reportDateTime = {
      raw: T1, epochMs: Date.parse(T1), valid: true,
    };
    t1Missing.comparison.revision.serial = { raw: null, numeric: null, valid: false };
    const t1Serial2 = structuredClone(t1Missing);
    t1Serial2.comparison.revision.serial = { raw: "2", numeric: 2, valid: true };
    const foundation = {
      keyedActive: [],
      legacyActive: null,
      observations: shared.tsunamiState.getObservationGroups(),
      // 旧逐次縮約が見落とした順: T1 欠落 → T2/3 → T1/2。
      gateEntries: [t1Missing, t2Serial3, t1Serial2],
    };
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: foundation,
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    let persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    expect(persisted.telegramFoundation.tsunami.gateEntries).toEqual([]);
    persisted.telegramFoundation.tsunami = structuredClone(foundation);
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");
    expect(persistence.load()!.telegramFoundation.tsunami.gateEntries).toEqual([]);
  });

  it("旧 scalar＋tsunami:current gate だけの snapshot を EventID keyed schema へ一方向 migration する", () => {
    const shared = deps();
    const active = info({ eventId: "fixed-only", at: T1, messageId: "fixed-only-active" });
    expect(run(active, shared).kind).toBe("ok");
    const fixedGate = structuredClone(shared.revisionGate.exportDurableEntries()[0]!);
    fixedGate.stateSubjectKey = "tsunami:current";
    fixedGate.comparison.stateSubjectKey = "tsunami:current";
    fixedGate.comparison.revision.eventId = {
      raw: "tsunami:current", value: "tsunami:current", valid: true,
    };
    const foundation = {
      active,
      observations: shared.tsunamiState.getObservationGroups(),
      gateEntries: [fixedGate],
    };
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: foundation,
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    let persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    // writer は旧 fixed gate を EventID subject へ同時 migration する。
    expect(persisted.telegramFoundation.tsunami.keyedActive).toEqual([
      expect.objectContaining({ meta: expect.objectContaining({ eventId: expect.objectContaining({ value: "fixed-only" }) }) }),
    ]);
    expect(persisted.telegramFoundation.tsunami.gateEntries).toEqual([
      expect.objectContaining({ stateSubjectKey: "tsunami:fixed-only", cancelled: false }),
    ]);
    // reader に旧 snapshot そのものを与えても同じ canonical shape へ移る。
    persisted.telegramFoundation.tsunami = structuredClone(foundation);
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.keyedActive?.map((item) => item.meta.eventId.value)).toEqual(["fixed-only"]);
    expect(loaded.legacyActive).toBeNull();
    expect(loaded.gateEntries).toEqual([
      expect.objectContaining({ stateSubjectKey: "tsunami:fixed-only", cancelled: false }),
    ]);
    const restarted = new TsunamiStateHolder();
    restarted.restorePersistedState(null, loaded.observations, loaded.keyedActive ?? []);
    expect(restarted.getLevel()).toBe("津波警報");
  });

  it("名称-only legacy scalar と旧 fixed tombstone を EventID subject へ移行し、REST なし再起動後も遅延報を拒否する", () => {
    const shared = deps();
    expect(run(info({
      eventId: "legacy-fixed-cancel",
      at: T1,
      messageId: "legacy-fixed-cancel-active",
    }), shared).kind).toBe("ok");
    expect(run(info({
      eventId: "legacy-fixed-cancel",
      infoType: "取消",
      at: T2,
      messageId: "legacy-fixed-cancel-tombstone",
    }), shared).kind).toBe("ok");
    const fixedTombstone = structuredClone(shared.revisionGate.exportDurableEntries()[0]!);
    fixedTombstone.stateSubjectKey = "tsunami:current";
    fixedTombstone.comparison.stateSubjectKey = "tsunami:current";
    fixedTombstone.comparison.revision.eventId = {
      raw: "tsunami:current", value: "tsunami:current", valid: true,
    };
    const legacy = info({
      eventId: "legacy-fixed-cancel",
      areaCode: null,
      kindCode: null,
      kind: "大津波警報",
      at: T1,
      messageId: "legacy-fixed-name-only",
    });
    const foundation = {
      active: legacy,
      observations: { VTSE51: [], VTSE52: [] },
      gateEntries: [fixedTombstone],
    };
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: foundation,
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    let persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    expect(persisted.telegramFoundation.tsunami.keyedActive).toEqual([]);
    expect(persisted.telegramFoundation.tsunami.legacyActive?.meta.eventId.value)
      .toBe("legacy-fixed-cancel");
    expect(persisted.telegramFoundation.tsunami.gateEntries).toEqual([
      expect.objectContaining({
        stateSubjectKey: "tsunami:legacy-fixed-cancel",
        cancelled: true,
      }),
    ]);
    // reader に migration 前の scalar/fixed 形を直接与える。
    persisted.telegramFoundation.tsunami = structuredClone(foundation);
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.legacyActive?.meta.eventId.value).toBe("legacy-fixed-cancel");
    expect(loaded.gateEntries).toEqual([
      expect.objectContaining({
        stateSubjectKey: "tsunami:legacy-fixed-cancel",
        cancelled: true,
      }),
    ]);
    // REST 補完を呼ばず disk state だけを復元し、取消前の canonical 遅延報を流す。
    const restarted = deps();
    restarted.tsunamiState.restorePersistedState(
      null,
      loaded.observations,
      loaded.keyedActive ?? [],
      loaded.legacyActive ?? null,
    );
    restarted.revisionGate.restoreDurableEntries(loaded.gateEntries);
    expect(run(info({
      eventId: "legacy-fixed-cancel",
      at: T1,
      messageId: "delayed-without-rest",
    }), restarted)).toEqual({ kind: "suppressed" });
    expect(restarted.tsunamiState.getPersistedLegacyActive()).not.toBeNull();
  });

  it("名称-only legacyActive の中間形でも旧 fixed tombstone を EventID subject へ移行し、遅延報を拒否する", () => {
    const shared = deps();
    expect(run(info({
      eventId: "legacy-field-fixed-cancel",
      at: T1,
      messageId: "legacy-field-active",
    }), shared).kind).toBe("ok");
    expect(run(info({
      eventId: "legacy-field-fixed-cancel",
      infoType: "取消",
      at: T2,
      messageId: "legacy-field-tombstone",
    }), shared).kind).toBe("ok");
    const fixedTombstone = structuredClone(shared.revisionGate.exportDurableEntries()[0]!);
    fixedTombstone.stateSubjectKey = "tsunami:current";
    fixedTombstone.comparison.stateSubjectKey = "tsunami:current";
    fixedTombstone.comparison.revision.eventId = {
      raw: "tsunami:current", value: "tsunami:current", valid: true,
    };
    const legacy = info({
      eventId: "legacy-field-fixed-cancel",
      areaCode: null,
      kindCode: null,
      kind: "大津波警報",
      at: T1,
      messageId: "legacy-field-name-only",
    });
    const intermediateFoundation = {
      keyedActive: [],
      legacyActive: legacy,
      observations: { VTSE51: [], VTSE52: [] },
      gateEntries: [fixedTombstone],
    };
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: intermediateFoundation,
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    let persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    expect(persisted.telegramFoundation.tsunami.keyedActive).toEqual([]);
    expect(persisted.telegramFoundation.tsunami.legacyActive?.meta.eventId.value)
      .toBe("legacy-field-fixed-cancel");
    expect(persisted.telegramFoundation.tsunami.gateEntries).toEqual([
      expect.objectContaining({
        stateSubjectKey: "tsunami:legacy-field-fixed-cancel",
        cancelled: true,
      }),
    ]);

    // reader に前版 writer が生成しえた中間形を直接与える。
    persisted.telegramFoundation.tsunami = structuredClone(intermediateFoundation);
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");
    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.legacyActive?.meta.eventId.value).toBe("legacy-field-fixed-cancel");
    expect(loaded.gateEntries).toEqual([
      expect.objectContaining({
        stateSubjectKey: "tsunami:legacy-field-fixed-cancel",
        cancelled: true,
      }),
    ]);

    const restarted = deps();
    restarted.tsunamiState.restorePersistedState(
      null,
      loaded.observations,
      loaded.keyedActive ?? [],
      loaded.legacyActive ?? null,
    );
    restarted.revisionGate.restoreDurableEntries(loaded.gateEntries);
    expect(run(info({
      eventId: "legacy-field-fixed-cancel",
      at: T1,
      messageId: "legacy-field-delayed-without-rest",
    }), restarted)).toEqual({ kind: "suppressed" });
    expect(restarted.tsunamiState.getPersistedLegacyActive()).not.toBeNull();
  });

  it("同一 EventID の active T1/T3 と gate T2 は、最新 T3 の結合失敗で subject 全体を拒否する", () => {
    const shared = deps();
    expect(run(info({
      eventId: "newest-before-gate-match",
      at: T2,
      messageId: "middle-gate",
    }), shared).kind).toBe("ok");
    const t1 = info({
      eventId: "newest-before-gate-match",
      at: T1,
      messageId: "old-active-t1",
    });
    const t3 = info({
      eventId: "newest-before-gate-match",
      at: T3,
      messageId: "new-active-t3",
    });
    const foundation = {
      keyedActive: [t1, t3],
      legacyActive: null,
      observations: { VTSE51: [], VTSE52: [] },
      gateEntries: shared.revisionGate.exportDurableEntries(),
    };
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: foundation,
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    let persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    expect(persisted.telegramFoundation.tsunami.keyedActive).toEqual([]);
    expect(persisted.telegramFoundation.tsunami.gateEntries).toEqual([]);
    persisted.telegramFoundation.tsunami = structuredClone(foundation);
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");
    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.keyedActive).toEqual([]);
    expect(loaded.gateEntries).toEqual([]);
  });

  it("完全 keyed legacyActive は gate 結合時だけ keyedActive へ昇格し、結合不能なら除外する", () => {
    const shared = deps();
    const keyedLegacy = info({
      eventId: "keyed-in-legacy",
      at: T1,
      messageId: "keyed-legacy-payload",
    });
    expect(run(keyedLegacy, shared).kind).toBe("ok");
    const promotedFoundation = {
      keyedActive: [],
      legacyActive: keyedLegacy,
      observations: { VTSE51: [], VTSE52: [] },
      gateEntries: shared.revisionGate.exportDurableEntries(),
    };
    const promotedFile = persistencePath();
    const promotedPersistence = new StandbyPersistence(promotedFile, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: promotedFoundation,
    }));
    promotedPersistence.save(legacyState());

    const promotedPath = standbyPersistenceV2Path(promotedFile);
    let promotedRaw = JSON.parse(fs.readFileSync(promotedPath, "utf8")) as PersistedStandbyStateV2;
    expect(promotedRaw.telegramFoundation.tsunami.keyedActive?.map((item) => item.meta.eventId.value))
      .toEqual(["keyed-in-legacy"]);
    expect(promotedRaw.telegramFoundation.tsunami.legacyActive).toBeNull();
    promotedRaw.telegramFoundation.tsunami = structuredClone(promotedFoundation);
    fs.writeFileSync(promotedPath, `${JSON.stringify(promotedRaw)}\n`, "utf8");
    const promoted = promotedPersistence.load()!.telegramFoundation.tsunami;
    expect(promoted.keyedActive?.map((item) => item.meta.eventId.value)).toEqual(["keyed-in-legacy"]);
    expect(promoted.legacyActive).toBeNull();
    const restored = new TsunamiStateHolder();
    restored.restorePersistedState(
      null,
      promoted.observations,
      promoted.keyedActive ?? [],
      promoted.legacyActive ?? null,
    );
    expect(restored.getPersistedKeyedActive()).toHaveLength(1);
    expect(restored.getPersistedLegacyActive()).toBeNull();

    const rejectedFoundation = {
      ...promotedFoundation,
      gateEntries: [],
    };
    const rejectedFile = persistencePath();
    const rejectedPersistence = new StandbyPersistence(rejectedFile, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: rejectedFoundation,
    }));
    rejectedPersistence.save(legacyState());
    const rejectedPath = standbyPersistenceV2Path(rejectedFile);
    let rejectedRaw = JSON.parse(fs.readFileSync(rejectedPath, "utf8")) as PersistedStandbyStateV2;
    expect(rejectedRaw.telegramFoundation.tsunami.keyedActive).toEqual([]);
    expect(rejectedRaw.telegramFoundation.tsunami.legacyActive).toBeNull();
    rejectedRaw.telegramFoundation.tsunami = structuredClone(rejectedFoundation);
    fs.writeFileSync(rejectedPath, `${JSON.stringify(rejectedRaw)}\n`, "utf8");
    const rejected = rejectedPersistence.load()!.telegramFoundation.tsunami;
    expect(rejected.keyedActive).toEqual([]);
    expect(rejected.legacyActive).toBeNull();
  });

  it("forecast 空続報で A が消滅した後は、非 cancel A gate が残っても B scalar を保存する", () => {
    const shared = deps();
    expect(run(info({ eventId: "event-a", areaCode: "210", at: T1, messageId: "empty-a" }), shared).kind)
      .toBe("ok");
    expect(run(info({ eventId: "event-b", areaCode: "220", at: T2, messageId: "empty-b" }), shared).kind)
      .toBe("ok");
    expect(run(info({
      eventId: "event-a",
      at: T3,
      forecast: [],
      messageId: "empty-a-followup",
    }), shared).kind).toBe("ok");

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.active?.meta.eventId.value).toBe("event-b");
    expect(loaded.gateEntries.filter((entry) =>
      entry.domain === "tsunami" && !entry.cancelled)).toHaveLength(2);
  });

  it("同一 EventID の unkeyed 通常続報は直前 keyed active と後続 watermark を保存し、restart 後も警報を維持する", () => {
    const shared = deps();
    const active = info({
      eventId: "event-a",
      areaCode: "210",
      kindCode: "51",
      kind: "津波警報",
      at: T1,
      messageId: "keyed-before-unkeyed",
    });
    expect(run(active, shared).kind).toBe("ok");
    const unkeyedFollowup = info({
      eventId: "event-a",
      at: T2,
      messageId: "unkeyed-followup",
      forecast: [{
        areaCode: null,
        areaName: "コード欠落の続報",
        kindCode: null,
        kind: "津波注意報",
        maxHeightDescription: "1m",
        firstHeight: "",
      }],
    });
    expect(run(unkeyedFollowup, shared).kind).toBe("ok");
    expect(shared.tsunamiState.getLastInfo()?.meta.reportDateTime.raw).toBe(T1);
    expect(shared.tsunamiState.getLevel()).toBe("津波警報");

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.active?.meta.reportDateTime.raw).toBe(T1);
    expect(loaded.gateEntries.find((entry) => entry.stateSubjectKey === "tsunami:event-a")
      ?.comparison.revision.reportDateTime.raw).toBe(T2);
    const restarted = deps();
    restarted.tsunamiState.restorePersistedState(loaded.active ?? null, loaded.observations);
    restarted.revisionGate.restoreDurableEntries(loaded.gateEntries);
    expect(restarted.tsunamiState.getLevel()).toBe("津波警報");
    expect(restarted.tsunamiState.getLastInfo()?.meta.reportDateTime.raw).toBe(T1);
    expect(run({ ...unkeyedFollowup, meta: {
      ...unkeyedFollowup.meta,
      messageId: "unkeyed-followup-rest-replay",
    } }, restarted)).toEqual({ kind: "suppressed" });
    expect(restarted.tsunamiState.getLevel()).toBe("津波警報");
  });

  it("同一日時でも Serial が active 1 → watermark 2 の順なら unkeyed 続報との結合を許可する", () => {
    const shared = deps();
    expect(run(info({
      eventId: "serial-order",
      serial: "1",
      at: T1,
      messageId: "serial-order-active",
    }), shared).kind).toBe("ok");
    expect(run(info({
      eventId: "serial-order",
      serial: "2",
      at: T1,
      messageId: "serial-order-unkeyed",
      forecast: [{
        areaCode: null,
        areaName: "コード欠落の同時刻続報",
        kindCode: null,
        kind: "津波注意報",
        maxHeightDescription: "1m",
        firstHeight: "",
      }],
    }), shared).kind).toBe("ok");

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.active?.meta.serial.raw).toBe("1");
    expect(loaded.gateEntries[0]?.comparison.revision.serial.raw).toBe("2");
    const restarted = deps();
    restarted.tsunamiState.restorePersistedState(loaded.active ?? null, loaded.observations);
    restarted.revisionGate.restoreDurableEntries(loaded.gateEntries);
    expect(restarted.tsunamiState.getLevel()).toBe("津波警報");
  });

  it.each([
    { label: "Serial 逆転", raw: "1", numeric: 1, valid: true },
    { label: "watermark 側だけ Serial 欠落", raw: null, numeric: null, valid: false },
  ])("同一日時の $label snapshot は active 2 と結合せず tsunami foundation を拒否する", ({
    raw, numeric, valid,
  }) => {
    const shared = deps();
    expect(run(info({
      eventId: "broken-serial-order",
      serial: "2",
      at: T1,
      messageId: "broken-serial-active",
    }), shared).kind).toBe("ok");

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    const persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    persisted.telegramFoundation.tsunami.gateEntries[0].comparison.revision.serial = {
      raw,
      numeric,
      valid,
    };
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.keyedActive).toEqual([]);
    expect(loaded.gateEntries).toEqual([]);
  });

  it("旧 tsunami:current gate が新 EventID gate と併存すれば canonical EventID gate 一件へ畳む", () => {
    const shared = deps();
    expect(run(info({ eventId: "event-b", areaCode: "220", at: T2, messageId: "fixed-b" }), shared).kind)
      .toBe("ok");
    const entries = shared.revisionGate.exportDurableEntries();
    const current = entries.find((entry) => entry.stateSubjectKey === "tsunami:event-b")!;
    const legacyFixed = structuredClone(current);
    legacyFixed.stateSubjectKey = "tsunami:current";
    legacyFixed.comparison.stateSubjectKey = "tsunami:current";
    legacyFixed.comparison.revision.eventId = {
      ...legacyFixed.comparison.revision.eventId,
      raw: "tsunami:current",
      value: "tsunami:current",
      valid: true,
    };

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: [legacyFixed, ...entries],
      },
    }));
    persistence.save(legacyState());

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.active?.meta.eventId.value).toBe("event-b");
    expect(loaded.gateEntries.filter((entry) => entry.domain === "tsunami")).toEqual([
      expect.objectContaining({ stateSubjectKey: "tsunami:event-b", cancelled: false }),
    ]);
  });

  it("同一 EventID の keyed 部分取消は残存 item と non-cancel gate を persistence→restart 後も維持する", () => {
    const shared = deps();
    const active = info({
      eventId: "event-a",
      at: T1,
      messageId: "partial-active",
      forecast: [
        {
          areaCode: "210",
          areaName: "解除対象",
          kindCode: "51",
          kind: "津波警報",
          maxHeightDescription: "3m",
          firstHeight: "",
        },
        {
          areaCode: "220",
          areaName: "残存対象",
          kindCode: "62",
          kind: "津波注意報",
          maxHeightDescription: "1m",
          firstHeight: "",
        },
      ],
    });
    expect(run(active, shared).kind).toBe("ok");
    const cancellationForecast: LegacyTsunamiForecastItemInput[] = [{
      areaCode: "210",
      areaName: "名称は照合に使わない",
      kindCode: "51",
      kind: "津波警報",
      maxHeightDescription: "3m",
      firstHeight: "",
    }];
    const cancellation = info({
      eventId: "event-a",
      infoType: "取消",
      at: T2,
      messageId: "partial-cancellation",
      forecast: cancellationForecast,
    });
    expect(run(cancellation, shared).kind).toBe("ok");
    expect(shared.tsunamiState.getLastInfo()?.forecast).toEqual([
      expect.objectContaining({ areaCode: "220", kindCode: "62", areaName: "残存対象" }),
    ]);
    expect(shared.revisionGate.exportDurableEntries()).toEqual([
      expect.objectContaining({
        stateSubjectKey: "tsunami:event-a",
        cancelled: false,
        semanticKeys: expect.arrayContaining([expect.stringContaining("取消:")]),
        comparison: expect.objectContaining({
          revision: expect.objectContaining({ reportDateTime: expect.objectContaining({ raw: T2 }) }),
        }),
      }),
    ]);

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());
    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.active?.forecast).toEqual([
      expect.objectContaining({ areaCode: "220", kindCode: "62", areaName: "残存対象" }),
    ]);
    expect(loaded.gateEntries[0]).toMatchObject({ cancelled: false });

    const restarted = deps();
    restarted.tsunamiState.restorePersistedState(loaded.active ?? null, loaded.observations);
    restarted.revisionGate.restoreDurableEntries(loaded.gateEntries);
    expect(restarted.tsunamiState.getLastInfo()?.forecast).toEqual([
      expect.objectContaining({ areaCode: "220", kindCode: "62", areaName: "残存対象" }),
    ]);
    expect(run(info({
      eventId: "event-a",
      infoType: "取消",
      at: T2,
      messageId: "partial-cancellation-replay",
      forecast: cancellationForecast,
    }), restarted)).toEqual({ kind: "suppressed" });
  });

  it("コード欠落取消は gate を tombstone 化せず、persistence→restart 後も警報を維持する", () => {
    const shared = deps();
    const active = info({ eventId: "event-a", areaCode: "210", at: T1, messageId: "neutral-active" });
    expect(run(active, shared).kind).toBe("ok");
    const cancellation = info({
      eventId: "event-a",
      infoType: "取消",
      at: T2,
      messageId: "neutral-cancellation",
      forecast: [{
        areaCode: null,
        areaName: "名称だけの取消対象",
        kindCode: null,
        kind: "津波警報",
        maxHeightDescription: "3m",
        firstHeight: "",
      }],
    });
    const cancelled = run(cancellation, shared);
    expect(cancelled.kind).toBe("ok");
    if (cancelled.kind !== "ok") return;
    expect(cancelled.outcome.parsed.infoType).toBe("取消");
    expect(shared.tsunamiState.getLevel()).toBe("津波警報");
    expect(run(info({
      eventId: "event-a",
      infoType: "取消",
      at: T2,
      messageId: "neutral-cancellation-replay",
      forecast: [{
        areaCode: null,
        areaName: "名称だけの取消対象",
        kindCode: null,
        kind: "津波警報",
        maxHeightDescription: "3m",
        firstHeight: "",
      }],
    }), shared)).toEqual({ kind: "suppressed" });
    expect(shared.revisionGate.exportDurableEntries()).toEqual([
      expect.objectContaining({
        stateSubjectKey: "tsunami:event-a",
        cancelled: false,
        semanticKeys: expect.arrayContaining([expect.stringContaining("取消:")]),
        comparison: expect.objectContaining({
          revision: expect.objectContaining({ reportDateTime: expect.objectContaining({ raw: T2 }) }),
        }),
      }),
    ]);

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());
    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.active?.meta.eventId.value).toBe("event-a");
    expect(loaded.gateEntries[0]).toMatchObject({ cancelled: false });

    const restarted = deps();
    restarted.tsunamiState.restorePersistedState(loaded.active ?? null, loaded.observations);
    restarted.revisionGate.restoreDurableEntries(loaded.gateEntries);
    expect(restarted.tsunamiState.getLevel()).toBe("津波警報");
    expect(run(active, restarted)).toEqual({ kind: "suppressed" });
    expect(restarted.tsunamiState.getLevel()).toBe("津波警報");
  });

  it("persisted active なしの起動時 REST 部分取消 replay は空 holder を再構成しない", () => {
    const shared = deps();
    expect(run(info({
      eventId: "event-a",
      at: T1,
      messageId: "restore-guard-active",
      forecast: [
        {
          areaCode: "210",
          areaName: "解除対象",
          kindCode: "51",
          kind: "津波警報",
          maxHeightDescription: "3m",
          firstHeight: "",
        },
        {
          areaCode: "220",
          areaName: "残存対象",
          kindCode: "62",
          kind: "津波注意報",
          maxHeightDescription: "1m",
          firstHeight: "",
        },
      ],
    }), shared).kind).toBe("ok");
    const cancellationForecast: LegacyTsunamiForecastItemInput[] = [{
      areaCode: "210",
      areaName: "解除対象",
      kindCode: "51",
      kind: "津波警報",
      maxHeightDescription: "3m",
      firstHeight: "",
    }];
    expect(run(info({
      eventId: "event-a",
      infoType: "取消",
      at: T2,
      messageId: "restore-guard-cancellation",
      forecast: cancellationForecast,
    }), shared).kind).toBe("ok");

    // 複数 EventID scalar 非保存などを模し、gate だけ復元して holder は空のままにする。
    const restarted = deps();
    restarted.revisionGate.restoreDurableEntries(shared.revisionGate.exportDurableEntries());
    expect(restarted.tsunamiState.getLastInfo()).toBeNull();
    const replay = info({
      eventId: "event-a",
      infoType: "取消",
      at: T2,
      messageId: "restore-guard-cancellation-rest",
      forecast: cancellationForecast,
    });
    parseTsunamiMock.mockReturnValueOnce(replay);
    expect(processTsunami(message("VTSE41", replay.meta.messageId), {
      ...restarted,
      restoreStateOnDuplicate: true,
    })).toEqual({ kind: "suppressed" });
    expect(restarted.tsunamiState.getLastInfo()).toBeNull();
    expect(restarted.tsunamiState.getLevel()).toBeNull();
  });

  it("Phase 4B 前の scalar-only 津波 v2 persistence を canonical DTO にして復元する", () => {
    const shared = deps();
    const active = info({ type: "VTSE41", at: T1, messageId: "legacy-active-vtse41" });
    const station = observation("201", "legacy-station", "1.2m");
    expect(run(active, shared).kind).toBe("ok");
    expect(run(info({
      type: "VTSE51",
      at: T2,
      serial: "1",
      observations: [station],
      messageId: "legacy-observation-vtse51",
    }), shared).kind).toBe("ok");

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries().filter(
          (entry) => entry.domain === "tsunami" || entry.domain === "tsunamiObservation",
        ),
      },
    }));
    persistence.save(legacyState());

    const persisted = JSON.parse(
      fs.readFileSync(standbyPersistenceV2Path(file), "utf8"),
    ) as PersistedStandbyStateV2;
    expect(Object.hasOwn(persisted.telegramFoundation.tsunami, "active")).toBe(false);
    // Phase 4B 前に書かれた scalar-only v2 fixture を明示的に構成する。
    persisted.telegramFoundation.tsunami.active = persisted.telegramFoundation.tsunami.keyedActive![0]!;
    delete persisted.telegramFoundation.tsunami.keyedActive;
    delete persisted.telegramFoundation.tsunami.legacyActive;
    for (const item of persisted.telegramFoundation.tsunami.active?.forecast ?? []) {
      const legacyItem = item as Partial<TsunamiForecastItem>;
      delete legacyItem.areaCode;
      delete legacyItem.kindCode;
      delete legacyItem.kindName;
      delete legacyItem.maxHeight;
    }
    for (const family of ["VTSE51", "VTSE52"] as const) {
      for (const item of persisted.telegramFoundation.tsunami.observations[family]) {
        delete (item as Partial<TsunamiObservationStation>).maxHeight;
      }
    }
    fs.writeFileSync(standbyPersistenceV2Path(file), JSON.stringify(persisted), "utf8");

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.keyedActive).toEqual([]);
    expect(loaded.legacyActive?.forecast?.[0]).toMatchObject({
      areaCode: null,
      kindCode: null,
    });
    expect(loaded.gateEntries.filter((entry) => entry.domain === "tsunami")).toEqual([]);
    expect(loaded.active?.forecast?.[0]).toMatchObject({
      areaCode: null,
      kindCode: null,
      kindName: active.forecast![0].kind,
      maxHeight: { value: 3, presence: "value" },
    });
    expect(loaded.observations.VTSE51[0]).toMatchObject({
      stationCode: "201",
      maxHeight: { value: 1.2, presence: "value" },
    });
  });

  it("keyed state と名称-only legacy 表示を実ファイルで併存させ、legacy を取消対象へ入れない", () => {
    const shared = deps();
    const canonical = info({
      eventId: "canonical-event",
      areaCode: "210",
      kindCode: "51",
      at: T1,
      messageId: "canonical-before-legacy-roundtrip",
    });
    expect(run(canonical, shared).kind).toBe("ok");
    const legacy = info({
      eventId: "legacy-event",
      areaCode: null,
      kindCode: null,
      kind: "大津波警報",
      at: T2,
      messageId: "name-only-legacy-roundtrip",
    });
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        keyedActive: shared.tsunamiState.getPersistedKeyedActive(),
        legacyActive: legacy,
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());

    const raw = JSON.parse(
      fs.readFileSync(standbyPersistenceV2Path(file), "utf8"),
    ) as PersistedStandbyStateV2;
    expect(Object.hasOwn(raw.telegramFoundation.tsunami, "active")).toBe(false);
    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.keyedActive?.map((item) => item.meta.eventId.value)).toEqual(["canonical-event"]);
    expect(loaded.legacyActive?.meta.eventId.value).toBe("legacy-event");
    expect(loaded.gateEntries.some((entry) => entry.stateSubjectKey === "tsunami:legacy-event"))
      .toBe(false);

    const restored = new TsunamiStateHolder();
    restored.restorePersistedState(
      null,
      loaded.observations,
      loaded.keyedActive ?? [],
      loaded.legacyActive ?? null,
    );
    restored.clearAccepted(info({
      eventId: "legacy-event",
      forecast: [],
      at: T3,
      messageId: "legacy-cancellation-must-not-apply",
    }));
    expect(restored.getLastInfo()?.forecast?.map((item) => item.areaName).sort())
      .toEqual([canonical.forecast![0]!.areaName, legacy.forecast![0]!.areaName].sort());
  });

  it("津波 v2 persistence の正しい canonical field は保持し、破損 field は scalar から再構成する", () => {
    const shared = deps();
    const baseActive = info({ type: "VTSE41", at: T1, messageId: "canonical-active-vtse41" });
    const canonicalForecast: TsunamiForecastItem = {
      ...baseActive.forecast![0],
      areaCode: "210",
      kindCode: "52",
      kindName: baseActive.forecast![0].kind,
      maxHeight: {
        raw: " 3 ",
        value: 3,
        condition: null,
        description: " 3m ",
        presence: "value",
      },
    };
    const canonicalActive: ParsedTsunamiInfo = {
      ...baseActive,
      forecast: [canonicalForecast],
    };
    const canonicalStation: TsunamiObservationStation = {
      ...observation("201", "canonical-station", "1.2m"),
      areaCode: "210",
      maxHeight: {
        raw: "1.20",
        value: 1.2,
        condition: "観測中",
        description: " 1.2m ",
        presence: "value",
      },
    };
    expect(run(canonicalActive, shared).kind).toBe("ok");
    expect(run(info({
      type: "VTSE51",
      at: T2,
      serial: "1",
      observations: [canonicalStation],
      messageId: "canonical-observation-vtse51",
    }), shared).kind).toBe("ok");

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries().filter(
          (entry) => entry.domain === "tsunami" || entry.domain === "tsunamiObservation",
        ),
      },
    }));
    persistence.save(legacyState());

    const validLoaded = persistence.load()!.telegramFoundation.tsunami;
    expect(validLoaded.active?.forecast?.[0]).toMatchObject({
      areaCode: "210",
      kindCode: "52",
      kindName: canonicalForecast.kindName,
      maxHeight: canonicalForecast.maxHeight,
    });
    expect(validLoaded.observations.VTSE51[0]).toMatchObject({
      areaCode: "210",
      maxHeight: canonicalStation.maxHeight,
    });

    const persisted = JSON.parse(
      fs.readFileSync(standbyPersistenceV2Path(file), "utf8"),
    ) as PersistedStandbyStateV2;
    // scalar migration reader は壊れた code field を名称-only legacy 表示へ落とす。
    persisted.telegramFoundation.tsunami.active = persisted.telegramFoundation.tsunami.keyedActive![0]!;
    delete persisted.telegramFoundation.tsunami.keyedActive;
    delete persisted.telegramFoundation.tsunami.legacyActive;
    const brokenForecast = persisted.telegramFoundation.tsunami.active!
      .forecast![0] as unknown as Record<string, unknown>;
    brokenForecast.areaCode = 210;
    brokenForecast.kindCode = { code: "52" };
    brokenForecast.kindName = 123;
    brokenForecast.maxHeight = {};
    const brokenObservation = persisted.telegramFoundation.tsunami.observations
      .VTSE51[0] as unknown as Record<string, unknown>;
    brokenObservation.maxHeight = {
      raw: "1.2",
      value: 1.2,
      condition: null,
      description: "1.2m",
      presence: "range",
      lowerBound: null,
      upperBound: null,
    };
    fs.writeFileSync(standbyPersistenceV2Path(file), JSON.stringify(persisted), "utf8");

    const recovered = persistence.load()!.telegramFoundation.tsunami;
    expect(recovered.active?.forecast?.[0]).toMatchObject({
      areaCode: null,
      kindCode: null,
      kindName: canonicalForecast.kind,
      maxHeight: { value: 3, presence: "value" },
    });
    expect(recovered.observations.VTSE51[0]).toMatchObject({
      stationCode: "201",
      maxHeight: { value: 1.2, presence: "value" },
    });
  });

  it("津波 v2 persistence の正しい parser diagnostics は保持し、不正値だけを局所破棄する", () => {
    const shared = deps();
    const baseActive = info({ type: "VTSE41", at: T1, messageId: "diagnostics-active-vtse41" });
    const active: ParsedTsunamiInfo = {
      ...baseActive,
      diagnostics: ["unknownTsunamiAreaCode"],
      forecast: baseActive.forecast?.map((item) => ({
        ...item,
        diagnostics: ["unknownTsunamiKindCode"],
      })),
    };
    expect(run(active, shared).kind).toBe("ok");

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries().filter(
          (entry) => entry.domain === "tsunami" || entry.domain === "tsunamiObservation",
        ),
      },
    }));
    persistence.save(legacyState());

    const validLoaded = persistence.load()!.telegramFoundation.tsunami.active!;
    expect(validLoaded.diagnostics).toEqual(["unknownTsunamiAreaCode"]);
    expect(validLoaded.forecast?.[0]?.diagnostics).toEqual(["unknownTsunamiKindCode"]);

    const persisted = JSON.parse(
      fs.readFileSync(standbyPersistenceV2Path(file), "utf8"),
    ) as PersistedStandbyStateV2;
    const brokenActive = persisted.telegramFoundation.tsunami.keyedActive![0] as unknown as Record<string, unknown>;
    brokenActive.diagnostics = [123, "not-a-tsunami-diagnostic"];
    const brokenForecast = persisted.telegramFoundation.tsunami.keyedActive![0]!
      .forecast![0] as unknown as Record<string, unknown>;
    brokenForecast.diagnostics = ["unknownTsunamiAreaCode", { invalid: true }];
    fs.writeFileSync(standbyPersistenceV2Path(file), JSON.stringify(persisted), "utf8");

    const recovered = persistence.load()!.telegramFoundation.tsunami.active!;
    expect(recovered.diagnostics).toBeUndefined();
    expect(recovered.forecast?.[0]?.diagnostics).toBeUndefined();
    expect(recovered.forecast?.[0]).toMatchObject({
      areaName: active.forecast![0].areaName,
      kind: active.forecast![0].kind,
    });
  });

  it("同一 revision 訂正後の VTSE41 active と現況 watermark を v2 往復する", () => {
    const shared = deps();
    const normal = info({
      type: "VTSE41",
      at: T1,
      kind: "津波警報",
      messageId: "warning-before-correction",
    });
    const correction = info({
      type: "VTSE41",
      infoType: "訂正",
      at: T1,
      kind: "大津波警報",
      messageId: "major-correction",
    });
    expect(run(normal, shared).kind).toBe("ok");
    expect(run(correction, shared).kind).toBe("ok");
    expect(shared.tsunamiState.getLevel()).toBe("大津波警報");

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries().filter(
          (entry) => entry.domain === "tsunami" || entry.domain === "tsunamiObservation",
        ),
      },
    }));
    persistence.save(legacyState());

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.active).toEqual(correction);
    expect(loaded.gateEntries[0]?.comparison.revision.infoType.value).toBe("訂正");
    const restarted = deps();
    restarted.tsunamiState.restorePersistedState(loaded.active ?? null, loaded.observations);
    restarted.revisionGate.restoreDurableEntries(loaded.gateEntries);
    expect(restarted.tsunamiState.getLevel()).toBe("大津波警報");
    expect(restarted.tsunamiState.getLastInfo()).toEqual(correction);
  });

  it("VTSE41 取消 tombstone を v2 往復し、REST 不通後の遅延警報を拒否する", () => {
    const shared = deps();
    expect(run(info({ type: "VTSE41", at: T1, messageId: "warning-before-cancel" }), shared).kind)
      .toBe("ok");
    expect(run(info({
      type: "VTSE41",
      infoType: "取消",
      at: T2,
      messageId: "warning-cancel",
    }), shared).kind).toBe("ok");

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries().filter(
          (entry) => entry.domain === "tsunami" || entry.domain === "tsunamiObservation",
        ),
      },
    }));
    persistence.save(legacyState());

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    expect(loaded.active).toBeNull();
    expect(loaded.gateEntries).toEqual([
      expect.objectContaining({
        domain: "tsunami",
        revisionFamily: "VTSE41",
        stateSubjectKey: "tsunami:tsunami-event",
        cancelled: true,
        tombstoneRetentionMs: null,
      }),
    ]);
    const restarted = deps();
    restarted.tsunamiState.restorePersistedState(loaded.active ?? null, loaded.observations);
    restarted.revisionGate.restoreDurableEntries(loaded.gateEntries);
    expect(run(info({
      type: "VTSE41",
      at: T1,
      messageId: "delayed-warning-after-restart",
    }), restarted)).toEqual({ kind: "suppressed" });
    expect(restarted.tsunamiState.getLevel()).toBeNull();
  });

  it("VTSE51 取消 tombstone を v2 往復し、旧欠落 retention を無期限 policy へ補完する", () => {
    const shared = deps();
    expect(run(info({
      type: "VTSE51",
      at: T1,
      observations: [observation("21001", "宮古", "1.0m")],
      messageId: "before-cancel",
    }), shared).kind).toBe("ok");
    expect(run(info({
      type: "VTSE51",
      infoType: "取消",
      at: T2,
      observations: [],
      messageId: "cancel",
    }), shared).kind).toBe("ok");
    expect(shared.tsunamiState.getObservationGroups().VTSE51).toEqual([]);

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries().filter(
          (entry) => entry.domain === "tsunamiObservation",
        ),
      },
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    const oldV2 = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    const whole = oldV2.telegramFoundation.tsunami.gateEntries.find(
      (entry) => entry.stateSubjectKey === "tsunami:observations:VTSE51",
    );
    expect(whole?.cancelled).toBe(true);
    delete whole!.tombstoneRetentionMs;
    fs.writeFileSync(v2Path, `${JSON.stringify(oldV2)}\n`, "utf8");

    const loaded = persistence.load();
    const loadedEntries = loaded!.telegramFoundation.tsunami.gateEntries;
    expect(loadedEntries.find(
      (entry) => entry.stateSubjectKey === "tsunami:observations:VTSE51",
    )?.tombstoneRetentionMs).toBeNull();
    const restored = deps();
    restored.tsunamiState.restoreObservationGroups(
      loaded!.telegramFoundation.tsunami.observations,
    );
    restored.revisionGate.restoreDurableEntries(loadedEntries);
    expect(run(info({
      type: "VTSE51",
      at: T1,
      observations: [observation("21001", "宮古（遅着）", "9.9m")],
      messageId: "delayed-after-restart",
    }), restored)).toEqual({ kind: "suppressed" });
    expect(restored.tsunamiState.getObservationGroups().VTSE51).toEqual([]);
  });

  it("VTSE51 取消後の新部分報は clear 済み family へ新 station だけを保持する", () => {
    const shared = deps();
    expect(run(info({
      type: "VTSE51", at: T1,
      observations: [
        observation("21001", "旧 A", "1.0m"),
        observation("21002", "旧 B", "1.2m"),
      ],
      messageId: "active-before-clear",
    }), shared).kind).toBe("ok");
    expect(run(info({
      type: "VTSE51", infoType: "取消", at: T2,
      observations: [], messageId: "clear-family",
    }), shared).kind).toBe("ok");
    expect(run(info({
      type: "VTSE51", at: T3,
      observations: [observation("21002", "新 B", "1.5m")],
      messageId: "new-partial-after-clear",
    }), shared).kind).toBe("ok");
    expect(shared.tsunamiState.getObservationGroups().VTSE51).toEqual([
      observation("21002", "新 B", "1.5m"),
    ]);
  });

  it("VTSE51 が VTSE41 より先でも holder に保持し、同報再送を要求しない", () => {
    const shared = deps();
    const station = observation("21001", "宮古", "1.0m");
    expect(run(info({
      type: "VTSE51",
      observations: [station],
      messageId: "observation-before-warning",
    }), shared).kind).toBe("ok");
    expect(shared.tsunamiState.getObservationGroups().VTSE51).toEqual([station]);
    expect(run(info({ type: "VTSE41", at: T2, messageId: "warning-after-observation" }), shared).kind).toBe("ok");
    expect(shared.tsunamiState.getObservationGroups().VTSE51).toEqual([station]);
    expect(run(info({
      type: "VTSE51",
      observations: [station],
      messageId: "observation-retry",
    }), shared)).toEqual({ kind: "suppressed" });
  });

  it("観測先着後に display が起動しても、後着 VTSE41 の表示へ holder 観測を合流する", () => {
    const shared = deps();
    const station = observation("21001", "宮古", "1.0m");
    expect(run(info({
      type: "VTSE51",
      observations: [station],
      messageId: "observation-while-display-off",
    }), shared).kind).toBe("ok");

    // display on 時点では VTSE41 がなく、表示 state はまだ存在しない。
    const displayStore = new DisplayStateStore();
    expect(displayStore.snapshot(0, Date.parse(T1)).tsunami).toBeNull();

    const warning = run(info({
      type: "VTSE41",
      at: T2,
      messageId: "warning-after-display-on",
    }), shared);
    expect(warning.kind).toBe("ok");
    if (warning.kind !== "ok") return;
    const event = fromTsunamiOutcome(warning.outcome);
    const dto = projectDisplayEvent(event, "津波警報");
    expect(displayStore.applyEvent(
      dto,
      Date.parse(T2),
      event.tsunamiObservations,
      null,
      event.tsunamiObservationGroups,
    )).toBe(true);
    expect(displayStore.snapshot(1, Date.parse(T2)).tsunami?.observations).toEqual([
      expect.objectContaining({ stationCode: "21001", stationName: "宮古" }),
    ]);
  });

  it("display が保留した code 欠落観測を後着 VTSE41 の holder bridge で失わない", () => {
    const shared = deps();
    const displayStore = new DisplayStateStore();
    const missingCode = observation(null, "名称のみ", "0.2m");
    const pending = run(info({
      type: "VTSE51",
      observations: [missingCode],
      messageId: "missing-code-before-warning",
    }), shared);
    expect(pending.kind).toBe("ok");
    if (pending.kind !== "ok") return;
    const pendingEvent = fromTsunamiOutcome(pending.outcome);
    expect(displayStore.applyEvent(
      projectDisplayEvent(pendingEvent, "津波観測情報"),
      Date.parse(T1),
      pendingEvent.tsunamiObservations,
      null,
      pendingEvent.tsunamiObservationGroups,
    )).toBe(false);
    expect(shared.tsunamiState.getObservationGroups().VTSE51).toEqual([]);

    const warning = run(info({
      type: "VTSE41",
      at: T2,
      messageId: "warning-after-missing-code",
    }), shared);
    expect(warning.kind).toBe("ok");
    if (warning.kind !== "ok") return;
    const warningEvent = fromTsunamiOutcome(warning.outcome);
    expect(displayStore.applyEvent(
      projectDisplayEvent(warningEvent, "津波警報"),
      Date.parse(T2),
      warningEvent.tsunamiObservations,
      null,
      warningEvent.tsunamiObservationGroups,
    )).toBe(true);
    const observations = displayStore.snapshot(1, Date.parse(T2)).tsunami?.observations ?? [];
    expect(observations).toEqual([
      expect.objectContaining({ stationName: "名称のみ" }),
    ]);
    expect(observations[0]).not.toHaveProperty("stationCode");
  });

  it("VTSE51 family 取消で item watermark を除去し、whole tombstone だけを維持する", () => {
    const shared = deps();
    expect(run(info({
      type: "VTSE51",
      at: T1,
      observations: [observation("21001", "旧 A", "1.0m")],
      messageId: "first-lifecycle",
    }), shared).kind).toBe("ok");
    expect(run(info({
      type: "VTSE51",
      infoType: "取消",
      at: T2,
      observations: [],
      messageId: "first-lifecycle-cancel",
    }), shared).kind).toBe("ok");
    let entries = shared.revisionGate.exportDurableEntries().filter(
      (entry) => entry.domain === "tsunamiObservation" && entry.revisionFamily === "VTSE51",
    );
    expect(entries).toEqual([
      expect.objectContaining({
        stateSubjectKey: "tsunami:observations:VTSE51",
        cancelled: true,
      }),
    ]);

    expect(run(info({
      type: "VTSE51",
      at: T3,
      observations: [observation("21002", "新 B", "1.5m")],
      messageId: "second-lifecycle",
    }), shared).kind).toBe("ok");
    expect(run(info({
      type: "VTSE51",
      infoType: "取消",
      at: T4,
      observations: [],
      messageId: "second-lifecycle-cancel",
    }), shared).kind).toBe("ok");
    entries = shared.revisionGate.exportDurableEntries().filter(
      (entry) => entry.domain === "tsunamiObservation" && entry.revisionFamily === "VTSE51",
    );
    expect(entries).toEqual([
      expect.objectContaining({
        stateSubjectKey: "tsunami:observations:VTSE51",
        cancelled: true,
      }),
    ]);
  });

  it("VTSE41 sanitizer は active を優先して 512 件へ切り詰め、restart 後の新規 admission で active を退場させない", () => {
    const shared = deps();
    const active = info({
      eventId: "capacity-active",
      areaCode: "210",
      kindCode: "51",
      kind: "津波警報",
      at: T1,
      messageId: "capacity-active",
    });
    expect(run(active, shared).kind).toBe("ok");
    const activeEntry = shared.revisionGate.exportDurableEntries().find(
      (entry) => entry.stateSubjectKey === "tsunami:capacity-active",
    )!;
    const tombstone = (index: number) => {
      const entry = structuredClone(activeEntry);
      const subject = `tsunami:capacity-tombstone-${index}`;
      entry.stateSubjectKey = subject;
      entry.comparison.stateSubjectKey = subject;
      entry.comparison.revision.eventId = {
        raw: subject,
        value: subject,
        valid: true,
      };
      entry.comparison.revision.infoType = {
        raw: "取消",
        value: "取消",
        valid: true,
      };
      entry.semanticKeys = [`capacity-cancel-${index}`];
      entry.cancelled = true;
      entry.acceptedAtMs = Date.parse(T1) + index + 1;
      entry.tombstoneRetentionMs = null;
      return entry;
    };

    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: shared.tsunamiState.getPersistedActive(),
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: [
          activeEntry,
          ...Array.from({ length: 511 }, (_, index) => tombstone(index)),
        ],
      },
    }));
    persistence.save(legacyState());

    const v2Path = standbyPersistenceV2Path(file);
    const persisted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    persisted.telegramFoundation.tsunami.gateEntries.push(tombstone(511));
    fs.writeFileSync(v2Path, `${JSON.stringify(persisted)}\n`, "utf8");

    const loaded = persistence.load()!.telegramFoundation.tsunami;
    const loadedVtse41 = loaded.gateEntries.filter((entry) => entry.domain === "tsunami");
    expect(loadedVtse41).toHaveLength(TSUNAMI_REVISION_FAMILY_POLICIES.VTSE41.maxSubjects);
    expect(loadedVtse41).toContainEqual(expect.objectContaining({
      stateSubjectKey: "tsunami:capacity-active",
      cancelled: false,
    }));
    expect(loaded.active?.meta.eventId.value).toBe("capacity-active");

    const restarted = deps();
    restarted.tsunamiState.restorePersistedState(loaded.active ?? null, loaded.observations);
    restarted.revisionGate.restoreDurableEntries(loaded.gateEntries);
    expect(run(info({
      eventId: "capacity-new",
      areaCode: "220",
      at: T3,
      messageId: "capacity-new",
    }), restarted)).toEqual({ kind: "suppressed" });
    expect(restarted.tsunamiState.getLevel()).toBe("津波警報");
    expect(restarted.revisionGate.exportDurableEntries()).toContainEqual(expect.objectContaining({
      stateSubjectKey: "tsunami:capacity-active",
      cancelled: false,
    }));
  });

  it("観測 holder と durable item gate を family 上限へ同期 compaction する", () => {
    const shared = deps();
    const stations = Array.from(
      { length: TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY + 2 },
      (_, index) => observation(String(100000 + index), `station-${index}`, "1.0m"),
    );
    expect(run(info({
      type: "VTSE51",
      observations: stations,
      messageId: "bounded-observations",
    }), shared).kind).toBe("ok");

    const retained = shared.tsunamiState.getObservationGroups().VTSE51;
    expect(retained).toHaveLength(TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY);
    expect(retained[0].stationCode).toBe("100002");
    const entries = shared.revisionGate.exportDurableEntries().filter(
      (entry) => entry.domain === "tsunamiObservation" && entry.revisionFamily === "VTSE51",
    );
    expect(entries).toHaveLength(TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY + 1);
    expect(entries.some((entry) => entry.stateSubjectKey === "100000")).toBe(false);
    expect(entries.some((entry) => entry.stateSubjectKey === "100001")).toBe(false);
  });

  it("VTSE51 の保護対象だけで 1,025 件に達した場合は新規観測を fail-closed にする", () => {
    const capacityError = vi.fn();
    const gate = new TelegramRevisionGate(capacityError);
    const policy = TSUNAMI_REVISION_FAMILY_POLICIES.VTSE51;
    const decide = (
      subject: string,
      infoType: "発表" | "取消",
      retain: boolean,
      at = T1,
      serial = "1",
    ) =>
      gate.decide({
        domain: policy.domain,
        revisionFamily: policy.revisionFamily,
        stateSubjectKey: subject,
        meta: createTelegramMeta({
          messageId: `${subject}:${infoType}:${serial}`,
          eventId: "tsunami-capacity",
          type: "VTSE51",
          reportDateTime: at,
          serial,
          infoType,
          receivedAtMs: Date.parse(at),
          status: "通常",
          isTest: false,
        }),
        comparator: policy.comparator,
        cancellationPolicy: policy.cancellationPolicy,
        terminal: false,
        cancellationTargetMatches: true,
        durable: policy.durable,
        tombstoneRetentionMs: policy.tombstoneRetentionMs,
        maxSubjects: policy.maxSubjects,
        retainForFamilyCapacity: retain,
        fragmentMerge: policy.fragmentMerge,
        payloadFingerprint: `${subject}:${infoType}:${serial}`,
      });

    expect(decide("tsunami:observations:VTSE51", "発表", true).accepted).toBe(true);
    for (let index = 0; index < TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY; index++) {
      expect(decide(`cancelled-${index}`, "取消", false).accepted).toBe(true);
    }

    expect(decide("new-station", "発表", false).kind).toBe("capacityExceeded");
    expect(capacityError).toHaveBeenCalledOnce();
    expect(decide("tsunami:observations:VTSE51", "発表", true, T2, "2").kind)
      .toBe("accept");
    expect(decide("new-station-2", "発表", false, T2, "2").kind)
      .toBe("capacityExceeded");
    expect(decide("tsunami:observations:VTSE51", "発表", true, T3, "3").kind)
      .toBe("accept");
    expect(decide("new-station-3", "発表", false, T3, "3").kind)
      .toBe("capacityExceeded");
    expect(capacityError).toHaveBeenCalledOnce();
    expect(gate.exportDurableEntries().filter((entry) =>
      entry.domain === "tsunamiObservation" && entry.revisionFamily === "VTSE51"))
      .toHaveLength(TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY + 1);
  });

  it("上限到達後の逆順一括更新でも holder と item gate の退場対象を一致させる", () => {
    const shared = deps();
    const initial = Array.from(
      { length: TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY },
      (_, index) => observation(String(200000 + index), `station-${index}`, "1.0m"),
    );
    expect(run(info({
      type: "VTSE51",
      at: T1,
      serial: "1",
      observations: initial,
      messageId: "fill-observation-limit",
    }), shared).kind).toBe("ok");

    const reversedUpdates = [...initial].reverse().map((item) => ({
      ...item,
      maxHeightValue: "1.1m",
    }));
    const added = observation("299999", "new-station", "1.2m");
    expect(run(info({
      type: "VTSE51",
      at: T2,
      serial: "2",
      observations: [...reversedUpdates, added],
      messageId: "reverse-update-and-add",
    }), shared).kind).toBe("ok");

    const holderCodes = new Set(
      shared.tsunamiState.getObservationGroups().VTSE51.map((item) => item.stationCode),
    );
    const gateEntries = shared.revisionGate.exportDurableEntries().filter(
      (entry) => entry.domain === "tsunamiObservation" && entry.revisionFamily === "VTSE51",
    );
    const gateItemCodes = new Set(
      gateEntries
        .map((entry) => entry.stateSubjectKey)
        .filter((subject) => subject !== "tsunami:observations:VTSE51"),
    );
    const evictedCode = initial[initial.length - 1].stationCode;

    expect(holderCodes).toEqual(gateItemCodes);
    expect(holderCodes.size).toBe(TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY);
    expect(holderCodes.has(evictedCode)).toBe(false);
    expect(holderCodes.has(added.stationCode)).toBe(true);
    expect(gateEntries).toHaveLength(TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY + 1);
  });

  it("orphan 観測を含む壊れた tsunami foundation だけを破棄し、VPWS50 foundation を保全する", () => {
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: { observations: { VTSE51: [], VTSE52: [] }, gateEntries: [] },
    }));
    persistence.save(legacyState());
    const v2Path = standbyPersistenceV2Path(file);
    const corrupted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    corrupted.telegramFoundation.tsunami.observations.VTSE51 = [
      observation("21001", "orphan", "1.0m"),
    ];
    fs.writeFileSync(v2Path, `${JSON.stringify(corrupted)}\n`, "utf8");

    const loaded = persistence.load();
    expect(loaded?.telegramFoundation.vpws50).toEqual({
      authoritative: true,
      state: null,
      gateEntries: [],
    });
    expect(loaded?.telegramFoundation.tsunami).toEqual({
      active: null,
      keyedActive: [],
      legacyActive: null,
      observations: { VTSE51: [], VTSE52: [] },
      gateEntries: [],
    });
  });

  it("壊れた VPWS50 foundation だけを破棄し、正常な tsunami tombstone を保全する", () => {
    const shared = deps();
    expect(run(info({ type: "VTSE41", at: T1, messageId: "before-vpws-corruption" }), shared).kind)
      .toBe("ok");
    expect(run(info({
      type: "VTSE41",
      infoType: "取消",
      at: T2,
      messageId: "cancel-before-vpws-corruption",
    }), shared).kind).toBe("ok");
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: null,
        observations: shared.tsunamiState.getObservationGroups(),
        gateEntries: shared.revisionGate.exportDurableEntries().filter(
          (entry) => entry.domain === "tsunami" || entry.domain === "tsunamiObservation",
        ),
      },
    }));
    persistence.save(legacyState());
    const v2Path = standbyPersistenceV2Path(file);
    const corrupted = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    corrupted.telegramFoundation.vpws50.state = { broken: true } as never;
    fs.writeFileSync(v2Path, `${JSON.stringify(corrupted)}\n`, "utf8");

    const loaded = persistence.load();
    expect(loaded?.telegramFoundation.vpws50).toEqual({
      authoritative: true,
      state: null,
      gateEntries: [],
    });
    expect(loaded?.telegramFoundation.tsunami.gateEntries).toEqual([
      expect.objectContaining({
        domain: "tsunami",
        revisionFamily: "VTSE41",
        stateSubjectKey: "tsunami:tsunami-event",
        cancelled: true,
      }),
    ]);
  });

  it("writer は gate eviction 後の orphan 観測を正規化して自己整合した v2 を書く", () => {
    const file = persistencePath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        observations: {
          VTSE51: [observation("21001", "orphan-after-eviction", "1.0m")],
          VTSE52: [],
        },
        gateEntries: [],
      },
    }));
    persistence.save(legacyState());

    const written = JSON.parse(
      fs.readFileSync(standbyPersistenceV2Path(file), "utf8"),
    ) as PersistedStandbyStateV2;
    expect(written.telegramFoundation.tsunami).toEqual({
      keyedActive: [],
      legacyActive: null,
      observations: { VTSE51: [], VTSE52: [] },
      gateEntries: [],
    });
    expect(persistence.load()?.telegramFoundation.vpws50.authoritative).toBe(true);
  });

  it("VTSE51 と VTSE52 は独立 family で、allowlist evidence を持つ", () => {
    expect(TSUNAMI_REVISION_FAMILY_POLICIES.VTSE51.fragmentMerge).toBe(true);
    expect(TSUNAMI_REVISION_FAMILY_POLICIES.VTSE52.fragmentMerge).toBe(true);
    expect(TSUNAMI_REVISION_FAMILY_POLICIES.VTSE51.fragmentEvidence.corpusFixtures).toContain("32-39_11_10_250206_VTSE51.xml");
    expect(TSUNAMI_REVISION_FAMILY_POLICIES.VTSE52.fragmentEvidence.corpusFixtures).toContain("61_11_01_250206_VTSE52.xml");
    expect(TSUNAMI_REVISION_FAMILY_POLICIES.VTSE41.tombstoneRetentionMs).toBeNull();
    expect(TSUNAMI_REVISION_FAMILY_POLICIES.VTSE51.tombstoneRetentionMs).toBeNull();
    const shared = deps();
    expect(run(info({ type: "VTSE51", at: T2, observations: [observation("21001", "宮古", "1m")] }), shared).kind).toBe("ok");
    expect(run(info({ type: "VTSE52", at: T1, observations: [observation("90001", "沖合", "2m")] }), shared).kind).toBe("ok");
  });

  it("durable な無期限 tombstone family は有限 maxSubjects 宣言を必須とする", () => {
    const policy = {
      ...TSUNAMI_REVISION_FAMILY_POLICIES.VTSE41,
      maxSubjects: null,
    } as unknown as Parameters<typeof validateRevisionFamilyPolicy>[0];
    expect(() => validateRevisionFamilyPolicy(policy)).toThrow(/bounded maxSubjects/);

    expect(TSUNAMI_REVISION_FAMILY_POLICIES.VTSE41.maxSubjects).toBe(512);
    expect(TSUNAMI_REVISION_FAMILY_POLICIES.VTSE51.maxSubjects)
      .toBe(TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY + 1);
  });

  it("family 単体と無期限 durable family 合計の maxSubjects が gate 容量を超える構成を拒否する", () => {
    expect(() => validateRevisionFamilyPolicy({
      ...TSUNAMI_REVISION_FAMILY_POLICIES.VTSE41,
      maxSubjects: TELEGRAM_REVISION_MAX_ENTRIES + 1,
    })).toThrow(/maxSubjects is invalid/);

    const halfPlusOne = Math.floor(TELEGRAM_REVISION_MAX_ENTRIES / 2) + 1;
    const first = {
      ...TSUNAMI_REVISION_FAMILY_POLICIES.VTSE41,
      domain: "synthetic-a",
      revisionFamily: "A",
      maxSubjects: halfPlusOne,
    };
    const second = {
      ...TSUNAMI_REVISION_FAMILY_POLICIES.VTSE41,
      domain: "synthetic-b",
      revisionFamily: "B",
      maxSubjects: halfPlusOne,
    };
    expect(() => validateRevisionFamilyPolicies([first, second]))
      .toThrow(/total exceeds gate capacity/);
  });

  it("allowlist 外の fragment family は registry validation で拒否する", () => {
    const policy = {
      ...TSUNAMI_REVISION_FAMILY_POLICIES.VTSE51,
      domain: "earthquake",
    } as unknown as Parameters<typeof validateRevisionFamilyPolicy>[0];
    expect(() => validateRevisionFamilyPolicy(policy)).toThrow(/not allowlisted/);
  });

  it("全 registry policy を起動時 validator の対象にし、fragment family を型付き allowlist と一致させる", () => {
    expect(() => {
      for (const policy of ALL_REVISION_FAMILY_POLICIES) {
        validateRevisionFamilyPolicy(policy);
      }
    }).not.toThrow();
    expect(ALL_REVISION_FAMILY_POLICIES
      .filter((policy) => policy.fragmentMerge)
      .map((policy) => policy.fragmentAllowlistKey)
      .sort()).toEqual([...FRAGMENT_MERGE_ALLOWLIST_KEYS].sort());
  });
});

describe("revision family capacity budget", () => {
  it("budgets every registered family within the partitioned gate capacity", () => {
    expect(ALL_REVISION_FAMILY_POLICIES.every((policy) => policy.maxSubjects != null)).toBe(true);
    const total = ALL_REVISION_FAMILY_POLICIES.reduce(
      (sum, policy) => sum + (policy.maxSubjects ?? 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(TELEGRAM_REVISION_MAX_ENTRIES);
    expect(() => validateRevisionFamilyPolicies(ALL_REVISION_FAMILY_POLICIES)).not.toThrow();
  });
});
