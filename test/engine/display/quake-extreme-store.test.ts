import { describe, expect, it } from "vitest";
import { QUAKE_EXTREME_HOLD_MS, QuakeExtremeStore } from "../../../src/engine/display/quake-extreme-store";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { displayEventDto } from "../../helpers/display-fixtures";
import {
  attachQuakeObservationBridge,
  withQuakeObservationMeta,
} from "../../../src/engine/display/quake-observation-merge";

const T0 = Date.parse("2026-07-29T00:00:00Z");
const originTime = new Date(T0).toISOString();

function quake(rank: number, over: {
  groupKey?: string | null;
  cancellation?: boolean;
  origin?: string | null;
  report?: string;
  serial?: string | null;
  type?: string;
} = {}) {
  const reportDateTime = over.report ?? originTime;
  const dto = displayEventDto({
    domain: "earthquake",
    type: over.type ?? "VXSE53",
    groupKey: over.groupKey === undefined ? "quake:Q1" : over.groupKey,
    isCancellation: over.cancellation ?? false,
    reportDateTime,
    serial: over.serial ?? "1",
    latestQuake: {
      eventId: "Q1", headline: null, originTime: over.origin === undefined ? originTime : over.origin,
      hypocenterName: "沖", depth: null, magnitude: null, maxInt: rank === 9 ? "7" : "6強",
      maxIntRank: rank, tsunamiWarning: false, intensityGroups: [], reportDateTime,
    },
  });
  const latest = dto.latestQuake!;
  attachQuakeObservationBridge(dto, {
    recent: null,
    latest: withQuakeObservationMeta(latest, {
      sourceType: dto.type,
      observationSourceType: dto.type,
      infoType: over.cancellation ? "取消" : "発表",
      resolvedTrigger: over.cancellation ? "explicitCancellation" : null,
      cancellationPolicy: "markCancelled",
      intensityStructureMissing: false,
      maxIntValue: {
        raw: rank === 9 ? "7" : "6+",
        value: rank === 9 ? "7" : "6+",
        condition: null,
        description: null,
        presence: "value",
      },
    }),
  });
  return dto;
}

describe("QuakeExtremeStore", () => {
  it("originTime から 12 時間だけ震度 7 を保持し、表示 TTL とは独立する", () => {
    let monotonicMs = 100;
    const store = new QuakeExtremeStore({ monotonicNow: () => monotonicMs });
    store.applyDto(quake(9), T0);
    monotonicMs += QUAKE_EXTREME_HOLD_MS - 1;
    expect(store.hasActive(T0 + QUAKE_EXTREME_HOLD_MS - 1)).toBe(true);
    monotonicMs += 1;
    expect(store.hasActive(T0 + QUAKE_EXTREME_HOLD_MS)).toBe(false);
  });

  it("DisplayStateStore は専用時計を最優先に snapshot.backgroundTone へ投影する", () => {
    const extremes = new QuakeExtremeStore();
    const state = new DisplayStateStore(undefined, undefined, extremes);
    state.applyEvent(quake(9), T0);
    expect(state.snapshot(1, T0).backgroundTone).toBe("quakeExtreme");
    state.applyEvent(quake(8, { report: new Date(T0 + 1).toISOString(), serial: "2" }), T0 + 1);
    expect(state.snapshot(2, T0 + 1).backgroundTone).toBe("alert");
  });

  it("下方修正と同一系列の取消は即時解除し、キー無し取消は他地震を消さない", () => {
    const store = new QuakeExtremeStore();
    store.applyDto(quake(9), T0);
    expect(store.applyDto(quake(8, { report: new Date(T0 + 1).toISOString(), serial: "2" }), T0 + 1)).toBe(true);
    expect(store.hasActive(T0 + 1)).toBe(false);
    store.applyDto(quake(9, { report: new Date(T0 + 2).toISOString(), serial: "3" }), T0 + 2);
    store.applyDto(quake(9, { groupKey: null, cancellation: true, report: new Date(T0 + 3).toISOString(), serial: "3" }), T0 + 3);
    expect(store.hasActive(T0 + 3)).toBe(true);
    store.applyDto(quake(9, { cancellation: true, report: new Date(T0 + 4).toISOString(), serial: "4" }), T0 + 4);
    expect(store.hasActive(T0 + 4)).toBe(false);
  });

  it("起動時復元は 12 時間以内だけを採る", () => {
    const source = new QuakeExtremeStore();
    source.applyDto(quake(9), T0);
    const restored = new QuakeExtremeStore();
    restored.restore(source.export(), T0 + 60_000);
    expect(restored.hasActive(T0 + 60_000)).toBe(true);
    const expired = new QuakeExtremeStore();
    expired.restore(source.export(), T0 + QUAKE_EXTREME_HOLD_MS);
    expect(expired.hasActive(T0 + QUAKE_EXTREME_HOLD_MS)).toBe(false);
  });

  it("7→6強の後に遅延した古い7続報が来ても再点灯しない", () => {
    const store = new QuakeExtremeStore();
    store.applyDto(quake(9, { serial: "1" }), T0);
    // reportDateTime が同一でも serial の単調性で 3 → 2 を拒否する。
    store.applyDto(quake(8, { serial: "3" }), T0 + 2_000);
    expect(store.hasActive(T0 + 2_000)).toBe(false);
    expect(store.applyDto(quake(9, { serial: "2" }), T0 + 3_000)).toBe(false);
    expect(store.hasActive(T0 + 3_000)).toBe(false);
  });

  it("取消後に遅延した古い7続報が来ても再点灯せず、tombstone は再起動をまたぐ", () => {
    const source = new QuakeExtremeStore();
    source.applyDto(quake(9, { serial: "1" }), T0);
    source.applyDto(quake(9, { cancellation: true, report: new Date(T0 + 2_000).toISOString(), serial: "3" }), T0 + 2_000);
    const restored = new QuakeExtremeStore();
    restored.restore(source.export(), T0 + 2_500);
    expect(restored.applyDto(quake(9, { report: new Date(T0 + 1_000).toISOString(), serial: "2" }), T0 + 3_000)).toBe(false);
    expect(restored.hasActive(T0 + 3_000)).toBe(false);
  });

  it("別 source の取消 group watermark は再起動後の取消前 VXSE53 を拒否する", () => {
    const source = new QuakeExtremeStore();
    source.applyDto(quake(9, { type: "VXSE53", serial: "1" }), T0);
    source.applyDto(quake(9, {
      type: "VXSE52",
      cancellation: true,
      report: new Date(T0 + 2_000).toISOString(),
      serial: "3",
    }), T0 + 2_000);
    expect(source.export().seen).toContainEqual(expect.objectContaining({ key: "quake:Q1" }));

    const restored = new QuakeExtremeStore();
    restored.restore(source.export(), T0 + 2_500);
    expect(restored.applyDto(quake(9, {
      type: "VXSE53",
      report: new Date(T0 + 1_000).toISOString(),
      serial: "2",
    }), T0 + 3_000)).toBe(false);
    expect(restored.hasActive(T0 + 3_000)).toBe(false);
  });

  it("稼働中の壁時計後退・前進では保持時間を変えず、単調時計の経過だけで失効する", () => {
    let monotonicMs = 500;
    const store = new QuakeExtremeStore({ monotonicNow: () => monotonicMs });
    store.applyDto(quake(9), T0);
    expect(store.hasActive(T0 - 6 * 60 * 60_000)).toBe(true);
    expect(store.hasActive(T0 + 48 * 60 * 60_000)).toBe(true);
    monotonicMs += QUAKE_EXTREME_HOLD_MS;
    expect(store.hasActive(T0)).toBe(false);
  });

  it("VXSE51 provenance のない構造的 missing は旧震度7を解除し、type 別 watermark は独立する", () => {
    const store = new QuakeExtremeStore();
    store.applyDto(quake(9, { type: "VXSE53", serial: "1" }), T0);
    expect(store.applyDto(displayEventDto({
      domain: "earthquake", type: "VXSE52", groupKey: "quake:Q1",
      reportDateTime: originTime, serial: "99", latestQuake: null,
    }), T0 + 1)).toBe(true);
    expect(store.hasActive(T0 + 1)).toBe(false);
    expect(store.applyDto(quake(8, { type: "VXSE53", serial: "2" }), T0 + 2)).toBe(false);
    expect(store.hasActive(T0 + 2)).toBe(false);
  });

  it("同一 EventID の取消は source type をまたいで震度7記録を解除する", () => {
    const store = new QuakeExtremeStore();
    store.applyDto(quake(9, { type: "VXSE53", serial: "1" }), T0);
    expect(store.applyDto(quake(9, { type: "VXSE52", serial: "99", cancellation: true }), T0 + 1)).toBe(true);
    expect(store.hasActive(T0 + 1)).toBe(false);
  });

  it("壁時計だけが12時間以上前進しても tombstone を保持し、古い下方修正を拒否する", () => {
    let monotonicMs = 100;
    const store = new QuakeExtremeStore({ monotonicNow: () => monotonicMs });
    store.applyDto(quake(9, { serial: "3" }), T0);
    expect(store.sweep(T0 + QUAKE_EXTREME_HOLD_MS + 1)).toBe(false);
    expect(store.export().seen).toHaveLength(2);
    expect(store.applyDto(quake(8, { serial: "2" }), T0 + QUAKE_EXTREME_HOLD_MS + 2)).toBe(false);
    expect(store.hasActive(T0 + QUAKE_EXTREME_HOLD_MS + 2)).toBe(true);
    expect(monotonicMs).toBe(100);
  });

  it("稼働中 sweep は単調時計で12時間を過ぎた tombstone を永続状態から除く", () => {
    let monotonicMs = 100;
    const store = new QuakeExtremeStore({ monotonicNow: () => monotonicMs });
    const durability: string[] = [];
    store.onDurable((mode) => durability.push(mode));
    store.applyDto(quake(9, { serial: "1" }), T0);
    store.applyDto(quake(8, { serial: "2" }), T0 + 1);
    expect(store.export().seen).toHaveLength(2);
    monotonicMs += QUAKE_EXTREME_HOLD_MS;
    expect(store.sweep(T0 + 1)).toBe(false);
    expect(store.export().seen).toHaveLength(0);
    expect(durability.at(-1)).toBe("debounced");
  });

  it("取消・下方修正の tombstone は即時永続化を要求する", () => {
    const store = new QuakeExtremeStore();
    const durability: string[] = [];
    store.onDurable((mode) => durability.push(mode));
    store.applyDto(quake(9, { serial: "1" }), T0);
    store.applyDto(quake(8, { serial: "2" }), T0 + 1);
    store.applyDto(quake(9, { serial: "3", report: new Date(T0 + 2).toISOString() }), T0 + 2);
    store.applyDto(quake(9, { serial: "4", report: new Date(T0 + 3).toISOString(), cancellation: true }), T0 + 3);
    expect(durability).toEqual(["debounced", "immediate", "debounced", "immediate"]);
  });

  it("advances the group watermark when a later source reactivates after cancellation", () => {
    const source = new QuakeExtremeStore();
    source.applyDto(quake(9, {
      type: "VXSE52",
      cancellation: true,
      report: new Date(T0 + 1_000).toISOString(),
      serial: "1",
    }), T0 + 1_000);
    source.applyDto(quake(9, {
      type: "VXSE53",
      report: new Date(T0 + 3_000).toISOString(),
      serial: "3",
    }), T0 + 3_000);

    const restored = new QuakeExtremeStore();
    restored.restore(source.export(), T0 + 3_500);
    expect(restored.applyDto(quake(8, {
      type: "VXSE51",
      report: new Date(T0 + 2_000).toISOString(),
      serial: "2",
    }), T0 + 4_000)).toBe(false);
    expect(restored.hasActive(T0 + 4_000)).toBe(true);
  });

  it("derives a group watermark from legacy source-only persisted entries", () => {
    const restored = new QuakeExtremeStore();
    restored.restore({
      records: [{
        groupKey: "quake:Q1",
        originTime,
        sourceTypes: ["VXSE53"],
      }],
      seen: [
        {
          key: "quake:Q1:VXSE52",
          revision: { reportTimeMs: T0 + 1_000, serial: "1" },
          forgetAtMs: T0 + QUAKE_EXTREME_HOLD_MS - 1_000,
        },
        {
          key: "quake:Q1:VXSE53",
          revision: { reportTimeMs: T0 + 3_000, serial: "3" },
          forgetAtMs: T0 + QUAKE_EXTREME_HOLD_MS,
        },
      ],
    }, T0 + 3_500);

    expect(restored.export().seen).toContainEqual({
      key: "quake:Q1",
      revision: { reportTimeMs: T0 + 3_000, serial: "3" },
      forgetAtMs: T0 + QUAKE_EXTREME_HOLD_MS,
    });
    expect(restored.applyDto(quake(8, {
      type: "VXSE51",
      report: new Date(T0 + 2_000).toISOString(),
      serial: "2",
    }), T0 + 4_000)).toBe(false);
    expect(restored.hasActive(T0 + 4_000)).toBe(true);
  });

  it("structural-missing preservation adopts the follow-up origin time and hold deadline", () => {
    let monotonicMs = 0;
    const store = new QuakeExtremeStore({ monotonicNow: () => monotonicMs });
    store.applyDto(quake(9, { type: "VXSE51", serial: "1" }), T0);

    monotonicMs = 5 * 60_000;
    const reportDateTime = new Date(T0 + 5 * 60_000).toISOString();
    const correctedOriginTime = new Date(T0 + 60_000).toISOString();
    const latest = withQuakeObservationMeta({
      eventId: "Q1",
      headline: null,
      originTime: correctedOriginTime,
      hypocenterName: "updated hypocenter",
      depth: "20km",
      magnitude: "5.8",
      maxInt: null,
      maxIntRank: null,
      tsunamiWarning: false,
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
      groupKey: "quake:Q1",
      reportDateTime,
      serial: "2",
    });
    attachQuakeObservationBridge(dto, { recent: null, latest });
    expect(store.applyDto(dto, T0 + 5 * 60_000)).toBe(true);
    expect(store.export().records[0]).toMatchObject({
      originTime: correctedOriginTime,
      reportDateTime,
      hypocenterName: "updated hypocenter",
      magnitude: "5.8",
      depth: "20km",
      sourceTypes: ["VXSE51", "VXSE52"],
      observationSourceType: "VXSE51",
    });

    monotonicMs = QUAKE_EXTREME_HOLD_MS + 30_000;
    expect(store.hasActive(T0 + QUAKE_EXTREME_HOLD_MS + 30_000)).toBe(true);
    monotonicMs = QUAKE_EXTREME_HOLD_MS + 60_000;
    expect(store.hasActive(T0 + QUAKE_EXTREME_HOLD_MS + 60_000)).toBe(false);
  });
});
