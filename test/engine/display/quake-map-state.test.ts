import { describe, expect, it } from "vitest";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import type {
  DisplayEventDtoV1,
  DisplayQuakeMapCommandV1,
  DisplayStandbyRevisionV1,
} from "../../../src/engine/display/types";
import { displayEventDto } from "../../helpers/display-fixtures";
import {
  attachQuakeObservationBridge,
  withQuakeObservationMeta,
} from "../../../src/engine/display/quake-observation-merge";

const MINUTE = 60_000;
const T0 = Date.parse("2026-07-30T12:00:00+09:00");

function revision(reportTimeMs: number, serial: string | null): DisplayStandbyRevisionV1 {
  return { reportTimeMs, serial };
}

function upsert(
  eventKey: string,
  rank: number,
  reportTimeMs = T0,
  serial: string | null = "1",
  sourceType = "VXSE53",
): DisplayQuakeMapCommandV1 {
  return {
    kind: "upsert",
    sourceType,
    revision: revision(reportTimeMs, serial),
    event: {
      eventKey,
      eventId: eventKey.slice("earthquake:".length),
      reportDateTime: new Date(reportTimeMs).toISOString(),
      originTime: new Date(reportTimeMs - MINUTE).toISOString(),
      hypocenterName: "test hypocenter",
      depth: "10km",
      magnitude: "5.0",
      maxInt: rank >= 5 ? "5-" : String(rank),
      maxIntRank: rank,
      tsunamiWarning: false,
      intensityGroups: [{ intensity: String(rank), rank, areas: ["A"], omittedAreaCount: 0 }],
      localAreas: [{ code: "440", rank }],
      updatedAtMs: reportTimeMs,
    },
  };
}

function unknownUpsert(
  eventKey: string,
  reportTimeMs = T0,
  serial: string | null = "1",
): DisplayQuakeMapCommandV1 {
  return {
    kind: "upsert",
    sourceType: "VXSE53",
    revision: revision(reportTimeMs, serial),
    event: {
      eventKey,
      eventId: eventKey.slice("earthquake:".length),
      reportDateTime: new Date(reportTimeMs).toISOString(),
      originTime: new Date(reportTimeMs - MINUTE).toISOString(),
      hypocenterName: "test unknown hypocenter",
      depth: "10km",
      magnitude: "5.0",
      maxInt: "不明（未入電）",
      maxIntRank: -1,
      maxIntSemantic: {
        raw: "未入電", presence: "unknown", label: "不明（未入電）",
        condition: "未入電", description: null, lowerBound: null, upperBound: null,
        rawLowerBound: null, rawUpperBound: null, badge: "?", color: "unknown", render: true,
        safetyLowerRank: null, safetyUpperRank: null, safetyRank: null, colorRank: null,
      },
      tsunamiWarning: false,
      intensityGroups: [],
      localAreas: [{
        code: "440", rank: -1,
        intensitySemantic: {
          raw: "未入電", presence: "unknown", label: "不明（未入電）",
          condition: "未入電", description: null, lowerBound: null, upperBound: null,
          rawLowerBound: null, rawUpperBound: null, badge: "?", color: "unknown", render: true,
          safetyLowerRank: null, safetyUpperRank: null, safetyRank: null, colorRank: null,
        },
      }],
      updatedAtMs: reportTimeMs,
    },
  };
}

function remove(
  eventKey: string,
  reportTimeMs: number,
  serial: string | null,
  sourceType = "VXSE53",
): DisplayQuakeMapCommandV1 {
  return {
    kind: "remove",
    eventKey,
    sourceType,
    reason: "cancelled",
    revision: revision(reportTimeMs, serial),
  };
}

function quakeDto(
  eventKey: string,
  rank: number,
  command?: DisplayQuakeMapCommandV1 | null,
): DisplayEventDtoV1 {
  const eventId = eventKey.slice("earthquake:".length);
  const mapReference = command?.kind === "upsert"
    ? {
        mapEventKey: eventKey,
        mapSourceType: command.sourceType,
        mapRevision: command.revision,
      }
    : {};
  return displayEventDto({
    id: `${eventId}-${command?.revision.serial ?? "no-map"}`,
    domain: "earthquake",
    type: command?.sourceType ?? "VXSE53",
    eventKey: `${eventKey}:${command?.revision.serial ?? "no-map"}`,
    reportDateTime: command?.kind === "upsert"
      ? command.event.reportDateTime
      : new Date(T0).toISOString(),
    emergency: rank >= 5
      ? {
          kind: "largeQuake",
          eventId,
          originTime: null,
          hypocenterName: "test hypocenter",
          magnitude: "5.0",
          maxInt: "5-",
          maxIntRank: rank,
          intensityGroups: [],
          reportDateTime: new Date(T0).toISOString(),
          depth: "10km",
          maxLgInt: null,
          tsunamiWarning: false,
          ...mapReference,
        }
      : null,
  });
}

function apply(
  store: DisplayStateStore,
  command: DisplayQuakeMapCommandV1,
  rank: number,
  nowMs = T0,
): boolean {
  const eventKey = command.kind === "upsert" ? command.event.eventKey : command.eventKey;
  return store.applyEvent(quakeDto(eventKey, rank, command), nowMs, null, command);
}

describe("DisplayStateStore quake map lifecycle", () => {
  it("all-unknown を -1 sentinel の calm unknownHost として5分保持し、続報でのみTTLを更新する", () => {
    const store = new DisplayStateStore();
    const first = unknownUpsert("earthquake:unknown", T0, "1");
    expect(apply(store, first, -1)).toBe(true);
    let quake = store.snapshot(0, T0).mapLayers?.quake;
    expect(quake?.events[0]).toMatchObject({
      eventKey: "earthquake:unknown", maxIntRank: -1,
      maxIntSemantic: { presence: "unknown", color: "unknown", badge: "?" },
    });
    expect(quake?.nonEmergencyHost).toBeNull();
    expect(quake?.unknownHost).toEqual({ eventKey: "earthquake:unknown", expiresAtMs: T0 + 5 * MINUTE });
    expect(store.snapshot(0, T0).severityTier).toBe("calm");

    const next = unknownUpsert("earthquake:unknown", T0 + MINUTE, "2");
    expect(apply(store, next, -1, T0 + MINUTE)).toBe(true);
    quake = store.snapshot(0, T0 + MINUTE).mapLayers?.quake;
    expect(quake?.unknownHost?.expiresAtMs).toBe(T0 + 6 * MINUTE);

    expect(store.sweep(T0 + 6 * MINUTE)).toBe(true);
    expect(store.snapshot(0, T0 + 6 * MINUTE).mapLayers?.quake).toEqual({
      events: [], nonEmergencyHost: null,
    });
  });

  it("known host または largeQuake 中は別 event の unknown を選択せず、同一 emergency の unknown 続報も既知地図を置換しない", () => {
    const known = new DisplayStateStore();
    apply(known, upsert("earthquake:known", 4), 4);
    apply(known, unknownUpsert("earthquake:unknown", T0 + MINUTE), -1, T0 + MINUTE);
    expect(known.snapshot(0, T0 + MINUTE).mapLayers?.quake).toEqual({
      events: [expect.objectContaining({ eventKey: "earthquake:known", maxIntRank: 4 })],
      nonEmergencyHost: { eventKey: "earthquake:known", expiresAtMs: T0 + 5 * MINUTE },
    });

    const emergency = new DisplayStateStore();
    const large = upsert("earthquake:large", 5);
    apply(emergency, large, 5);
    apply(emergency, unknownUpsert("earthquake:large", T0 + MINUTE, "2"), -1, T0 + MINUTE);
    expect(emergency.snapshot(0, T0 + MINUTE).mapLayers?.quake).toEqual({
      events: [expect.objectContaining({ eventKey: "earthquake:large", maxIntRank: 5 })],
      nonEmergencyHost: null,
    });
  });

  it("bridge 経由の emergency→unknown は元の hold 期限を保ち、震源諸元と地図 revision だけを更新する", () => {
    const store = new DisplayStateStore();
    const first = upsert("earthquake:A", 5, T0, "1", "VXSE51");
    apply(store, first, 5, T0);

    const reportTimeMs = T0 + 5 * MINUTE;
    const reportDateTime = new Date(reportTimeMs).toISOString();
    const originTime = new Date(T0 - 30_000).toISOString();
    const unknown = unknownUpsert("earthquake:A", reportTimeMs, "2");
    if (unknown.kind !== "upsert") throw new Error("test fixture must be an upsert");
    const command: DisplayQuakeMapCommandV1 = {
      ...unknown,
      event: {
        ...unknown.event,
        reportDateTime,
        originTime,
        hypocenterName: "updated unknown hypocenter",
        depth: "20km",
        magnitude: "5.8",
        tsunamiWarning: true,
      },
    };
    const latest = withQuakeObservationMeta({
      eventId: "A",
      headline: null,
      originTime,
      hypocenterName: "updated unknown hypocenter",
      depth: "20km",
      magnitude: "5.8",
      maxInt: null,
      maxIntRank: null,
      tsunamiWarning: true,
      intensityGroups: [],
      reportDateTime,
    }, {
      sourceType: "VXSE53",
      observationSourceType: "VXSE53",
      infoType: "発表",
      resolvedTrigger: null,
      cancellationPolicy: null,
      intensityStructureMissing: false,
      maxIntValue: {
        raw: "未入電",
        value: null,
        condition: "未入電",
        description: null,
        presence: "unknown",
      },
    });
    const dto = displayEventDto({
      domain: "earthquake",
      type: "VXSE53",
      groupKey: "quake:A",
      reportDateTime,
      serial: "2",
    });
    attachQuakeObservationBridge(dto, { recent: null, latest });
    expect(store.applyEvent(dto, reportTimeMs, null, command)).toBe(true);

    const snapshot = store.snapshot(0, reportTimeMs);
    expect(snapshot.mapLayers?.quake?.events[0]).toMatchObject({
      sourceType: "VXSE51",
      revision: command.revision,
      reportDateTime,
      originTime,
      hypocenterName: "updated unknown hypocenter",
      depth: "20km",
      magnitude: "5.8",
      tsunamiWarning: true,
      maxIntRank: 5,
      localAreas: [{ code: "440", rank: 5 }],
      updatedAtMs: T0,
    });
    expect(snapshot.largeQuakes[0]).toMatchObject({
      reportDateTime,
      originTime,
      hypocenterName: "updated unknown hypocenter",
      depth: "20km",
      magnitude: "5.8",
      tsunamiWarning: true,
      maxIntRank: 5,
      mapSourceType: "VXSE51",
      mapRevision: command.revision,
      updatedAtMs: T0,
    });
    expect(store.sweep(T0 + 10 * MINUTE + 1)).toBe(true);
    expect(store.snapshot(0, T0 + 10 * MINUTE + 1).largeQuakes).toEqual([]);
  });

  it("震度3〜4を5分 host として保持し、severity/background に caution として寄与する", () => {
    const store = new DisplayStateStore();
    const command = upsert("earthquake:A", 4);
    expect(apply(store, command, 4)).toBe(true);

    const snapshot = store.snapshot(0, T0);
    expect(snapshot.mapLayers?.quake).toEqual({
      events: [expect.objectContaining({ eventKey: "earthquake:A", localAreas: [{ code: "440", rank: 4 }] })],
      nonEmergencyHost: { eventKey: "earthquake:A", expiresAtMs: T0 + 5 * MINUTE },
    });
    expect(snapshot.severityTier).toBe("caution");
    expect(snapshot.backgroundTone).toBe("caution");

    const expiredBeforeSweep = store.snapshot(0, T0 + 5 * MINUTE);
    expect(expiredBeforeSweep.mapLayers?.quake?.nonEmergencyHost).not.toBeNull();
    expect(expiredBeforeSweep.severityTier).toBe("calm");
    expect(expiredBeforeSweep.backgroundTone).toBe("calm");

    expect(store.sweep(T0 + 5 * MINUTE)).toBe(true);
    expect(store.snapshot(0, T0 + 5 * MINUTE).mapLayers?.quake).toEqual({
      events: [],
      nonEmergencyHost: null,
    });
  });

  it("quakeExtreme 背景は期限内 host の caution より常に優先される", () => {
    const store = new DisplayStateStore();
    apply(store, upsert("earthquake:A", 4), 4);
    const reportDateTime = new Date(T0 + 1).toISOString();
    store.applyEvent(displayEventDto({
      domain: "earthquake",
      type: "VXSE53",
      groupKey: "quake:EXTREME",
      reportDateTime,
      latestQuake: {
        eventId: "EXTREME",
        headline: null,
        originTime: reportDateTime,
        hypocenterName: "test extreme",
        depth: "10km",
        magnitude: "7.0",
        maxInt: "7",
        maxIntRank: 9,
        tsunamiWarning: false,
        intensityGroups: [],
        reportDateTime,
      },
    }), T0 + 1);

    const snapshot = store.snapshot(0, T0 + 1);
    expect(snapshot.mapLayers?.quake?.nonEmergencyHost?.eventKey).toBe("earthquake:A");
    expect(snapshot.severityTier).toBe("alert");
    expect(snapshot.backgroundTone).toBe("quakeExtreme");
  });

  it("同一 event の続報は全置換し、旧 revision と同 revision を拒否する", () => {
    const store = new DisplayStateStore();
    const first = upsert("earthquake:A", 3, T0, "1");
    const next = upsert("earthquake:A", 4, T0 + MINUTE, "2");
    expect(apply(store, first, 3)).toBe(true);
    expect(apply(store, next, 4, T0 + MINUTE)).toBe(true);
    expect(apply(store, first, 3, T0 + 2 * MINUTE)).toBe(false);
    expect(apply(store, next, 4, T0 + 2 * MINUTE)).toBe(false);
    expect(store.snapshot(0, T0 + 2 * MINUTE).mapLayers?.quake?.events).toEqual([
      expect.objectContaining({ maxIntRank: 4, revision: next.revision }),
    ]);
  });

  it("同一 revision 訂正の known↔unknown でも host を再選択する", () => {
    const store = new DisplayStateStore();
    const known = upsert("earthquake:A", 4, T0, "1");
    expect(apply(store, known, 4)).toBe(true);

    const unknown = { ...unknownUpsert("earthquake:A", T0, "1"), isCorrection: true };
    expect(apply(store, unknown, -1, T0 + MINUTE)).toBe(true);
    expect(store.snapshot(0, T0 + MINUTE).mapLayers?.quake).toEqual({
      events: [expect.objectContaining({ maxIntRank: -1 })],
      nonEmergencyHost: null,
      unknownHost: { eventKey: "earthquake:A", expiresAtMs: T0 + 6 * MINUTE },
    });

    const knownCorrection = { ...upsert("earthquake:A", 4, T0, "1"), isCorrection: true };
    expect(apply(store, knownCorrection, 4, T0 + 2 * MINUTE)).toBe(true);
    expect(store.snapshot(0, T0 + 2 * MINUTE).mapLayers?.quake).toEqual({
      events: [expect.objectContaining({ maxIntRank: 4 })],
      nonEmergencyHost: { eventKey: "earthquake:A", expiresAtMs: T0 + 7 * MINUTE },
    });
  });

  it("同一 revision 訂正の emergency→unknown は既知地図と largeQuake を降格しない", () => {
    const store = new DisplayStateStore();
    const emergency = upsert("earthquake:A", 5, T0, "1");
    expect(apply(store, emergency, 5)).toBe(true);

    const unknown = { ...unknownUpsert("earthquake:A", T0, "1"), isCorrection: true };
    expect(apply(store, unknown, -1, T0 + MINUTE)).toBe(true);
    const snapshot = store.snapshot(0, T0 + MINUTE);
    expect(snapshot.mapLayers?.quake).toEqual({
      events: [expect.objectContaining({ maxIntRank: 5, revision: emergency.revision })],
      nonEmergencyHost: null,
    });
    expect(snapshot.largeQuakes).toEqual([
      expect.objectContaining({ maxIntRank: 5, mapRevision: emergency.revision }),
    ]);
  });

  it("同時刻で片方の serial が欠落する場合は後着を同一 revision として拒否する", () => {
    const serialFirst = new DisplayStateStore();
    const first = upsert("earthquake:A", 3, T0, "2");
    const missingLater = upsert("earthquake:A", 4, T0, null);
    expect(apply(serialFirst, first, 3)).toBe(true);
    expect(apply(serialFirst, missingLater, 4, T0 + 1)).toBe(false);
    expect(serialFirst.snapshot(0, T0 + 1).mapLayers?.quake?.events[0]).toEqual(
      expect.objectContaining({ maxIntRank: 3, revision: first.revision }),
    );

    const missingFirst = new DisplayStateStore();
    const initialMissing = upsert("earthquake:B", 3, T0, null);
    const serialLater = upsert("earthquake:B", 4, T0, "2");
    expect(apply(missingFirst, initialMissing, 3)).toBe(true);
    expect(apply(missingFirst, serialLater, 4, T0 + 1)).toBe(false);
    expect(missingFirst.snapshot(0, T0 + 1).mapLayers?.quake?.events[0]).toEqual(
      expect.objectContaining({ maxIntRank: 3, revision: initialMissing.revision }),
    );
  });

  it("同時刻の数値 serial は数値順、非数値 serial は文字列順で比較する", () => {
    const numeric = new DisplayStateStore();
    const nine = upsert("earthquake:A", 3, T0, "9");
    const ten = upsert("earthquake:A", 4, T0, "10");
    expect(apply(numeric, nine, 3)).toBe(true);
    expect(apply(numeric, ten, 4, T0 + 1)).toBe(true);
    expect(apply(numeric, nine, 3, T0 + 2)).toBe(false);
    expect(numeric.snapshot(0, T0 + 2).mapLayers?.quake?.events[0]?.revision).toEqual(ten.revision);

    const textual = new DisplayStateStore();
    const alpha = upsert("earthquake:B", 3, T0, "A");
    const beta = upsert("earthquake:B", 4, T0, "B");
    expect(apply(textual, alpha, 3)).toBe(true);
    expect(apply(textual, beta, 4, T0 + 1)).toBe(true);
    expect(apply(textual, alpha, 3, T0 + 2)).toBe(false);
    expect(textual.snapshot(0, T0 + 2).mapLayers?.quake?.events[0]?.revision).toEqual(beta.revision);
  });

  it("同一 host の続報で期限を5分後へ延長し、削除 tombstone は旧 upsert を拒否する", () => {
    const store = new DisplayStateStore();
    const first = upsert("earthquake:A", 3, T0, "1");
    const next = upsert("earthquake:A", 4, T0 + MINUTE, "2");
    apply(store, first, 3);
    apply(store, next, 4, T0 + MINUTE);
    expect(store.snapshot(0, T0 + MINUTE).mapLayers?.quake?.nonEmergencyHost?.expiresAtMs)
      .toBe(T0 + 6 * MINUTE);
    apply(store, remove("earthquake:A", T0 + 2 * MINUTE, "3"), 0, T0 + 2 * MINUTE);
    expect(apply(store, next, 4, T0 + 3 * MINUTE)).toBe(false);
    expect(store.snapshot(0, T0 + 3 * MINUTE).mapLayers?.quake?.events).toEqual([]);
  });

  it("source contribution を独立管理し、取消時は同一 EventID の全 source を解除する", () => {
    const store = new DisplayStateStore();
    const older = upsert("earthquake:A", 3, T0, "1", "VXSE51");
    const newer = upsert("earthquake:A", 4, T0 + MINUTE, "1", "VXSE53");
    apply(store, older, 3);
    apply(store, newer, 4, T0 + MINUTE);
    expect(store.snapshot(0, T0 + MINUTE).mapLayers?.quake?.events[0]?.sourceType).toBe("VXSE53");

    apply(store, remove("earthquake:A", T0 + 2 * MINUTE, "2", "VXSE53"), 0, T0 + 2 * MINUTE);
    expect(store.snapshot(0, T0 + 2 * MINUTE).mapLayers?.quake?.events).toEqual([]);
  });

  it("異種 source の同時刻 contribution は sourceType 昇順で決定する", () => {
    const store = new DisplayStateStore();
    apply(store, upsert("earthquake:A", 4, T0, "1", "VXSE53"), 4);
    apply(store, upsert("earthquake:A", 3, T0, "1", "VXSE51"), 3, T0 + 1);
    expect(store.snapshot(0, T0 + 1).mapLayers?.quake?.events[0]).toEqual(
      expect.objectContaining({ sourceType: "VXSE51", maxIntRank: 3 }),
    );
  });

  it("別 event を独立保持し、host は新しい震度3〜4 event へ置換する", () => {
    const store = new DisplayStateStore();
    apply(store, upsert("earthquake:A", 3), 3);
    apply(store, upsert("earthquake:B", 4, T0 + MINUTE), 4, T0 + MINUTE);
    const quake = store.snapshot(0, T0 + MINUTE).mapLayers?.quake;
    expect(quake?.events.map((event) => event.eventKey)).toEqual(["earthquake:B"]);
    expect(quake?.nonEmergencyHost?.eventKey).toBe("earthquake:B");
  });

  it("別 event の震度1〜2訂正は現在の host を置換しない", () => {
    const store = new DisplayStateStore();
    apply(store, upsert("earthquake:A", 4), 4);
    apply(store, {
      kind: "remove",
      eventKey: "earthquake:B",
      sourceType: "VXSE53",
      reason: "belowThreshold",
      revision: revision(T0 + MINUTE, "1"),
    }, 2, T0 + MINUTE);
    expect(store.snapshot(0, T0 + MINUTE).mapLayers?.quake?.nonEmergencyHost?.eventKey)
      .toBe("earthquake:A");
  });

  it("別 event の取消は現在の host を置換・削除しない", () => {
    const store = new DisplayStateStore();
    apply(store, upsert("earthquake:A", 4), 4);
    apply(store, remove("earthquake:B", T0 + MINUTE, "1"), 0, T0 + MINUTE);
    expect(store.snapshot(0, T0 + MINUTE).mapLayers?.quake?.nonEmergencyHost)
      .toEqual({ eventKey: "earthquake:A", expiresAtMs: T0 + 5 * MINUTE });
  });

  it("現在の host の取消は地図と nonEmergencyHost を削除する", () => {
    const store = new DisplayStateStore();
    apply(store, upsert("earthquake:A", 4), 4);
    apply(store, remove("earthquake:A", T0 + MINUTE, "2"), 0, T0 + MINUTE);
    expect(store.snapshot(0, T0 + MINUTE).mapLayers?.quake).toEqual({
      events: [],
      nonEmergencyHost: null,
    });
  });

  it("震度5弱以上は同一 host を解除し、別 event の host は維持する", () => {
    const same = new DisplayStateStore();
    apply(same, upsert("earthquake:A", 4), 4);
    const large = upsert("earthquake:A", 5, T0 + MINUTE, "2");
    apply(same, large, 5, T0 + MINUTE);
    expect(same.snapshot(0, T0 + MINUTE).mapLayers?.quake?.nonEmergencyHost).toBeNull();

    const other = new DisplayStateStore();
    apply(other, upsert("earthquake:A", 4), 4);
    const otherLarge = upsert("earthquake:B", 5, T0 + MINUTE, "1");
    apply(other, otherLarge, 5, T0 + MINUTE);
    expect(other.snapshot(0, T0 + MINUTE).mapLayers?.quake?.nonEmergencyHost?.eventKey)
      .toBe("earthquake:A");
    expect(other.snapshot(0, T0 + MINUTE).mapLayers?.quake?.events.map((event) => event.eventKey))
      .toEqual(["earthquake:B", "earthquake:A"]);
    expect(other.snapshot(0, T0 + MINUTE).severityTier).toBe("alert");
    expect(other.snapshot(0, T0 + MINUTE).backgroundTone).toBe("alert");
  });

  it("5弱以上→3〜4の訂正は旧 largeQuake を固定し、新 host は emergency 終了後も期限内なら残る", () => {
    const store = new DisplayStateStore();
    const large = upsert("earthquake:A", 5, T0, "1");
    apply(store, large, 5, T0);
    const correction = upsert("earthquake:A", 4, T0 + 9 * MINUTE, "2");
    apply(store, correction, 4, T0 + 9 * MINUTE);
    let snapshot = store.snapshot(0, T0 + 9 * MINUTE);
    expect(snapshot.largeQuakes[0]).toEqual(expect.objectContaining({
      mapRevision: large.revision,
    }));
    expect(snapshot.mapLayers?.quake?.events[0]).toEqual(expect.objectContaining({
      revision: correction.revision,
      maxIntRank: 4,
    }));
    expect(snapshot.mapLayers?.quake?.nonEmergencyHost?.eventKey).toBe("earthquake:A");

    store.sweep(T0 + 10 * MINUTE + 1);
    snapshot = store.snapshot(0, T0 + 10 * MINUTE + 1);
    expect(snapshot.largeQuakes).toEqual([]);
    expect(snapshot.mapLayers?.quake?.nonEmergencyHost?.eventKey).toBe("earthquake:A");
  });

  it("震度なし続報は既存地図と largeQuake の固定参照を消さない", () => {
    const store = new DisplayStateStore();
    const command = upsert("earthquake:A", 5);
    apply(store, command, 5);
    store.applyEvent(quakeDto("earthquake:A", 5, null), T0 + MINUTE, null, null);
    const snapshot = store.snapshot(0, T0 + MINUTE);
    expect(snapshot.mapLayers?.quake?.events).toHaveLength(1);
    expect(snapshot.largeQuakes[0]).toEqual(expect.objectContaining({
      mapEventKey: "earthquake:A",
      mapSourceType: "VXSE53",
      mapRevision: command.revision,
    }));
  });

  it("下方訂正・取消は地図を外すが largeQuake 文字は hold 中維持し、TTL 後に消す", () => {
    const store = new DisplayStateStore();
    apply(store, upsert("earthquake:A", 5), 5);
    const correction: DisplayQuakeMapCommandV1 = {
      kind: "remove",
      eventKey: "earthquake:A",
      sourceType: "VXSE53",
      reason: "belowThreshold",
      revision: revision(T0 + MINUTE, "2"),
    };
    apply(store, correction, 2, T0 + MINUTE);
    expect(store.snapshot(0, T0 + MINUTE).mapLayers?.quake?.events).toEqual([]);
    expect(store.snapshot(0, T0 + MINUTE).largeQuakes).toHaveLength(1);
    expect(store.sweep(T0 + 10 * MINUTE + 1)).toBe(true);
    expect(store.snapshot(0, T0 + 10 * MINUTE + 1).largeQuakes).toEqual([]);
  });

  it("複数 largeQuake と対応地図を更新時刻降順で保持し、新 store は空から始まる", () => {
    const store = new DisplayStateStore();
    apply(store, upsert("earthquake:A", 5, T0), 5, T0);
    apply(store, upsert("earthquake:B", 6, T0 + MINUTE), 6, T0 + MINUTE);
    const snapshot = store.snapshot(0, T0 + MINUTE);
    expect(snapshot.largeQuakes).toHaveLength(2);
    expect(snapshot.mapLayers?.quake?.events.map((event) => event.eventKey))
      .toEqual(["earthquake:B", "earthquake:A"]);

    expect(new DisplayStateStore().snapshot(0, T0 + MINUTE).mapLayers?.quake).toEqual({
      events: [],
      nonEmergencyHost: null,
    });
  });

  it("structural-missing preservation advances map and largeQuake hypocenter fields and hold time", () => {
    const store = new DisplayStateStore();
    const first = upsert("earthquake:A", 5, T0, "1", "VXSE51");
    apply(store, first, 5, T0);

    const reportDateTime = new Date(T0 + 5 * MINUTE).toISOString();
    const originTime = new Date(T0 - 30_000).toISOString();
    const command: DisplayQuakeMapCommandV1 = {
      kind: "remove",
      eventKey: "earthquake:A",
      sourceType: "VXSE52",
      reason: "structuralMissing",
      revision: revision(T0 + 5 * MINUTE, "2"),
      eventUpdate: {
        eventId: "A",
        reportDateTime,
        originTime,
        hypocenterName: "updated hypocenter",
        depth: "20km",
        magnitude: "5.8",
        tsunamiWarning: true,
        updatedAtMs: T0 + 5 * MINUTE,
      },
    };
    const latest = withQuakeObservationMeta({
      eventId: "A",
      headline: null,
      originTime,
      hypocenterName: "updated hypocenter",
      depth: "20km",
      magnitude: "5.8",
      maxInt: null,
      maxIntRank: null,
      tsunamiWarning: true,
      intensityGroups: [],
      reportDateTime,
    }, {
      sourceType: "VXSE52",
      observationSourceType: "VXSE52",
      infoType: "発表",
      resolvedTrigger: null,
      cancellationPolicy: null,
      intensityStructureMissing: true,
      maxIntValue: {
        raw: null,
        value: null,
        condition: null,
        description: null,
        presence: "missing",
      },
    });
    const dto = displayEventDto({
      domain: "earthquake",
      type: "VXSE52",
      groupKey: "quake:A",
      reportDateTime,
      serial: "2",
    });
    attachQuakeObservationBridge(dto, { recent: null, latest });
    expect(store.applyEvent(dto, T0 + 5 * MINUTE, null, command)).toBe(true);

    const snapshot = store.snapshot(0, T0 + 5 * MINUTE);
    expect(snapshot.mapLayers?.quake?.events[0]).toMatchObject({
      sourceType: "VXSE51",
      revision: command.revision,
      reportDateTime,
      originTime,
      hypocenterName: "updated hypocenter",
      depth: "20km",
      magnitude: "5.8",
      maxIntRank: 5,
      localAreas: [{ code: "440", rank: 5 }],
      updatedAtMs: T0 + 5 * MINUTE,
    });
    expect(snapshot.largeQuakes[0]).toMatchObject({
      reportDateTime,
      originTime,
      hypocenterName: "updated hypocenter",
      depth: "20km",
      magnitude: "5.8",
      maxIntRank: 5,
      mapSourceType: "VXSE51",
      mapRevision: command.revision,
      updatedAtMs: T0 + 5 * MINUTE,
    });
    store.sweep(T0 + 10 * MINUTE + 1);
    expect(store.snapshot(0, T0 + 10 * MINUTE + 1).largeQuakes).toHaveLength(1);
    expect(store.sweep(T0 + 15 * MINUTE + 1)).toBe(true);
    expect(store.snapshot(0, T0 + 15 * MINUTE + 1).largeQuakes).toEqual([]);
  });
});
