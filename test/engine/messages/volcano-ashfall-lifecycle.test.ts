import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StandbyPersistence } from "../../../src/engine/display/standby-persistence";
import {
  serializeStandbyAdmissionPair,
  StandbyPersistenceAdmissionCoordinator,
} from "../../../src/engine/display/standby-persistence-admission";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { FloodForecastStateHolder } from "../../../src/engine/messages/flood-forecast-state";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { VolcanoRouteHandler } from "../../../src/engine/messages/volcano-route-handler";
import {
  VolcanoStateHolder,
  VOLCANO_MAX_SOURCE_EVENT_IDS_PER_COMPOSITE,
} from "../../../src/engine/messages/volcano-state";
import { VolcanoTransactionCoordinator } from "../../../src/engine/messages/volcano-transaction-coordinator";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_VFVO50_ALERT_LV3,
  FIXTURE_VFVO52_ERUPTION_1,
  FIXTURE_VFVO54_ASH_RAPID,
  FIXTURE_VFVO55_ASH_DETAIL,
  readFixture,
} from "../../helpers/mock-message";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type CrossSliceFlag = "A0" | "A1";
type CrossSliceEruption = "E0" | "E1";
type CrossSliceAshfall = "H0" | "H54" | "H55" | "GA" | "GT";
type CrossSliceIncoming = "active" | "expired" | "nonProjectable" | "cancellation";

const CROSS_SLICE_CASES = (["A0", "A1"] as const).flatMap((alert) =>
  (["E0", "E1"] as const).flatMap((eruption) =>
    (["H0", "H54", "H55", "GA", "GT"] as const).flatMap((ashfall) =>
      (["active", "expired", "nonProjectable", "cancellation"] as const).map((incoming) => ({
        alert,
        eruption,
        ashfall,
        incoming,
      })))));

function rewriteVolcanoXml(
  fixture: string,
  options: {
    reportDateTime: string;
    controlDateTime: string;
    serial: string;
    infoType?: "発表" | "取消";
    ashfallSubject?: boolean;
    firstForecastEnd?: string;
  },
): string {
  let xml = readFixture(fixture)
    .replace(/<DateTime>[^<]*<\/DateTime>/, `<DateTime>${options.controlDateTime}</DateTime>`)
    .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/,
      `<ReportDateTime>${options.reportDateTime}</ReportDateTime>`)
    .replace(/<Serial\s*\/>|<Serial>[^<]*<\/Serial>/, `<Serial>${options.serial}</Serial>`)
    .replace(/<InfoType>[^<]*<\/InfoType>/, `<InfoType>${options.infoType ?? "発表"}</InfoType>`);
  if (options.ashfallSubject === true) {
    xml = xml.replaceAll("桜島", "浅間山").replaceAll(">506<", ">306<");
  }
  if (options.firstForecastEnd != null) {
    xml = xml.replace(/<EndTime>[^<]*<\/EndTime>/,
      `<EndTime>${options.firstForecastEnd}</EndTime>`);
  }
  return xml;
}

function createCrossSliceOwners() {
  return {
    telegramRevisionGate: new TelegramRevisionGate(),
    standbyStateStore: new StandbyStateStore(),
    vpws50State: new Vpws50StateHolder(),
    vpww56State: new Vpww56StateHolder(),
    tsunamiState: new TsunamiStateHolder(),
    volcanoState: new VolcanoStateHolder(),
    floodForecastState: new FloodForecastStateHolder(),
  };
}

describe("VFVO54/55 ashfall lifecycle through the production transaction", () => {
  it.each(CROSS_SLICE_CASES)(
    "$alert/$eruption/$ashfall × $incoming keeps the other slices atomic",
    ({ alert, eruption, ashfall, incoming }: {
      alert: CrossSliceFlag;
      eruption: CrossSliceEruption;
      ashfall: CrossSliceAshfall;
      incoming: CrossSliceIncoming;
    }) => {
      vi.useFakeTimers({ now: Date.parse("2021-05-14T12:00:00+09:00") });
      const owners = createCrossSliceOwners();
      const admission = new StandbyPersistenceAdmissionCoordinator({ owners });
      const coordinator = new VolcanoTransactionCoordinator(admission);
      const durable = vi.fn();
      const revision = vi.fn();
      const notify = vi.fn();
      const display = vi.fn();
      admission.onDurable(durable);
      const handler = new VolcanoRouteHandler({
        volcanoState: owners.volcanoState,
        revisionGate: owners.telegramRevisionGate,
        volcanoTransactionCoordinator: coordinator,
        notifier: {
          notifyVolcano: notify,
          notifyVolcanoBatch: vi.fn(),
        } as never,
        onRevisionDecision: revision,
        runDisplayPipeline: (_outcome, show) => {
          show();
          return true;
        },
        display: {
          displayVolcano: display,
          displayVolcanoBatch: vi.fn(),
        } as never,
      });
      const expectedSeedSources: string[] = [];

      if (alert === "A1") {
        vi.setSystemTime(Date.parse("2021-05-14T12:00:00+09:00"));
        const message = createMockWsDataMessageFromXml(rewriteVolcanoXml(
          FIXTURE_VFVO50_ALERT_LV3,
          {
            reportDateTime: "2021-05-14T12:00:00+09:00",
            controlDateTime: "2021-05-14T03:00:00Z",
            serial: "1",
          },
        ), "VFVO50");
        expect(handler.handle(message).kind).toBe("accepted");
        expectedSeedSources.push(message.id);
      }
      if (eruption === "E1") {
        vi.setSystemTime(Date.parse("2021-05-14T12:05:00+09:00"));
        const message = createMockWsDataMessageFromXml(rewriteVolcanoXml(
          FIXTURE_VFVO52_ERUPTION_1,
          {
            reportDateTime: "2021-05-14T12:05:00+09:00",
            controlDateTime: "2021-05-14T03:05:00Z",
            serial: "1",
          },
        ), "VFVO52");
        expect(handler.handle(message).kind).toBe("accepted");
        expectedSeedSources.push(message.id);
      }
      if (ashfall !== "H0") {
        const detailed = ashfall === "H55";
        const seedClock = detailed
          ? "2021-05-14T12:51:00+09:00"
          : ashfall === "GA"
            ? "2021-05-14T12:41:00+09:00"
            : "2021-05-14T12:40:00+09:00";
        vi.setSystemTime(Date.parse(seedClock));
        const message = createMockWsDataMessageFromXml(rewriteVolcanoXml(
          detailed ? FIXTURE_VFVO55_ASH_DETAIL : FIXTURE_VFVO54_ASH_RAPID,
          {
            reportDateTime: detailed
              ? "2021-05-14T12:51:00+09:00"
              : "2021-05-14T12:40:00+09:00",
            controlDateTime: detailed ? "2021-05-14T03:51:00Z" : "2021-05-14T03:40:00Z",
            serial: "1",
            infoType: ashfall === "GT" ? "取消" : "発表",
            ashfallSubject: true,
            ...(ashfall === "GA"
              ? { firstForecastEnd: "2021-05-14T12:41:00+09:00" }
              : {}),
          },
        ), detailed ? "VFVO55" : "VFVO54");
        expect(handler.handle(message).kind).toBe("accepted");
        if (ashfall === "H54" || ashfall === "H55" || alert === "A1" || eruption === "E1") {
          expectedSeedSources.push(message.id);
        }
      }

      const before = coordinator.snapshot();
      const beforeComposite = before.holder.composites.find((entry) => entry.volcanoCode === "306");
      expect(beforeComposite?.alert != null).toBe(alert === "A1");
      expect(beforeComposite?.eruption != null).toBe(eruption === "E1");
      expect(beforeComposite?.ashfall?.sourceType ?? null).toBe(
        ashfall === "H54" ? "VFVO54" : ashfall === "H55" ? "VFVO55" : null,
      );
      expect(beforeComposite?.sourceEventIds ?? []).toEqual([...expectedSeedSources].sort());

      durable.mockClear();
      revision.mockClear();
      notify.mockClear();
      display.mockClear();
      const finalClock = incoming === "expired"
        ? "2021-05-14T13:01:00+09:00"
        : "2021-05-14T13:00:00+09:00";
      vi.setSystemTime(Date.parse(finalClock));
      const finalMessage = createMockWsDataMessageFromXml(rewriteVolcanoXml(
        FIXTURE_VFVO54_ASH_RAPID,
        {
          reportDateTime: "2021-05-14T13:00:00+09:00",
          controlDateTime: "2021-05-14T04:00:00Z",
          serial: "2",
          infoType: incoming === "cancellation" ? "取消" : "発表",
          ashfallSubject: true,
          ...(incoming === "expired"
            ? { firstForecastEnd: "2021-05-14T13:01:00+09:00" }
            : incoming === "nonProjectable"
              ? { firstForecastEnd: "2021-05-14T12:31:00+09:00" }
              : {}),
        },
      ), "VFVO54");

      expect(handler.handle(finalMessage).kind).toBe("accepted");
      const after = coordinator.snapshot();
      const afterComposite = after.holder.composites.find((entry) => entry.volcanoCode === "306");
      expect(afterComposite?.alert ?? null).toEqual(beforeComposite?.alert ?? null);
      expect(afterComposite?.eruption ?? null).toEqual(beforeComposite?.eruption ?? null);
      expect(after.repair).toEqual(before.repair);
      const finalIsActive = incoming === "active";
      expect(afterComposite?.ashfall ?? null).toEqual(finalIsActive
        ? expect.objectContaining({
            sourceType: "VFVO54",
            sourceEventId: finalMessage.id,
            generation: ashfall === "H54" || ashfall === "H55" ? 2 : 1,
          })
        : null);
      const compositeSurvives = finalIsActive || alert === "A1" || eruption === "E1";
      expect(afterComposite?.sourceEventIds ?? []).toEqual(compositeSurvives
        ? [...new Set([...expectedSeedSources, finalMessage.id])].sort()
        : []);
      const ashGate = after.gates.states.find((entry) =>
        entry.key === "volcano:volcanoAshfall:volcano:ashfall:306");
      expect(ashGate).toMatchObject({
        cancelled: incoming === "cancellation",
        semanticKeys: [expect.any(String)],
        volcanoProvenance: {
          kind: "ashfall",
          actualEventId: "306",
          sourceType: "VFVO54",
        },
      });
      expect(durable).toHaveBeenCalledTimes(1);
      expect(revision).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(display).toHaveBeenCalledTimes(1);
      handler.flushAndDispose();
    },
  );

  it("updates only the composite name when another slice supplies a newer canonical name", () => {
    vi.useFakeTimers({ now: Date.parse("2021-05-14T12:00:00+09:00") });
    const root = mkdtempSync(join(tmpdir(), "fleq-volcano-name-independence-"));
    roots.push(root);
    const persistencePath = join(root, "display-active-state-v1.json");
    const persistence = new StandbyPersistence(persistencePath);
    const owners = createCrossSliceOwners();
    const admission = new StandbyPersistenceAdmissionCoordinator({
      owners,
      serializePair: (domains, envelope) =>
        serializeStandbyAdmissionPair(persistence, domains, envelope),
      canReserveLogicalGeneration: () => persistence.canReserveLogicalGeneration(),
    });
    const coordinator = new VolcanoTransactionCoordinator(admission);
    const handler = new VolcanoRouteHandler({
      volcanoState: owners.volcanoState,
      revisionGate: owners.telegramRevisionGate,
      volcanoTransactionCoordinator: coordinator,
      notifier: { notifyVolcano: vi.fn(), notifyVolcanoBatch: vi.fn() } as never,
      runDisplayPipeline: (_outcome, show) => {
        show();
        return true;
      },
      display: { displayVolcano: vi.fn(), displayVolcanoBatch: vi.fn() } as never,
    });
    const alert = createMockWsDataMessageFromXml(rewriteVolcanoXml(
      FIXTURE_VFVO50_ALERT_LV3,
      {
        reportDateTime: "2021-05-14T12:00:00+09:00",
        controlDateTime: "2021-05-14T03:00:00Z",
        serial: "1",
      },
    ), "VFVO50");
    expect(handler.handle(alert).kind).toBe("accepted");

    vi.setSystemTime(Date.parse("2021-05-14T12:40:00+09:00"));
    const ashXml = rewriteVolcanoXml(FIXTURE_VFVO54_ASH_RAPID, {
      reportDateTime: "2021-05-14T12:40:00+09:00",
      controlDateTime: "2021-05-14T03:40:00Z",
      serial: "1",
      ashfallSubject: true,
    }).replaceAll("浅間山", "浅間山 新名");
    const ashfall = createMockWsDataMessageFromXml(ashXml, "VFVO54");
    expect(handler.handle(ashfall).kind).toBe("accepted");

    expect(coordinator.snapshot().holder.composites[0]).toMatchObject({
      volcanoCode: "306",
      volcanoName: "浅間山 新名",
      alert: { volcanoName: "浅間山" },
      ashfall: { volcanoName: "浅間山 新名" },
    });
    const pair = admission.captureSerializedPair(persistence.reserveSerializationEnvelope());
    expect(persistence.saveSerializedPair(pair).kind).toBe("written");
    expect(new StandbyPersistence(persistencePath).loadWithResult().state
      ?.telegramFoundation.volcano.state).toMatchObject({
        generation: 1,
        volcanoes: [{
          volcanoName: "浅間山 新名",
          alert: { volcanoName: "浅間山" },
          ashfall: { volcanoName: "浅間山 新名" },
        }],
      });
    handler.flushAndDispose();
  });

  it("rejects an H0 cancellation when another slice keeps a full source-ID set alive", () => {
    vi.useFakeTimers({ now: Date.parse("2021-05-14T12:00:00+09:00") });
    const owners = createCrossSliceOwners();
    const admission = new StandbyPersistenceAdmissionCoordinator({ owners });
    const durable = vi.fn();
    const notify = vi.fn();
    const display = vi.fn();
    admission.onDurable(durable);
    const handler = new VolcanoRouteHandler({
      volcanoState: owners.volcanoState,
      revisionGate: owners.telegramRevisionGate,
      volcanoTransactionCoordinator: new VolcanoTransactionCoordinator(admission),
      notifier: { notifyVolcano: notify, notifyVolcanoBatch: vi.fn() } as never,
      runDisplayPipeline: (_outcome, show) => {
        show();
        return true;
      },
      display: { displayVolcano: display, displayVolcanoBatch: vi.fn() } as never,
    });
    const alert = createMockWsDataMessageFromXml(rewriteVolcanoXml(
      FIXTURE_VFVO50_ALERT_LV3,
      {
        reportDateTime: "2021-05-14T12:00:00+09:00",
        controlDateTime: "2021-05-14T03:00:00Z",
        serial: "1",
        ashfallSubject: true,
      },
    ), "VFVO50");
    expect(handler.handle(alert).kind).toBe("accepted");

    const saturated = structuredClone(admission.capture().domains);
    const composite = saturated.volcanoHolderAndRepair.holder.composites[0]!;
    composite.sourceEventIds = [
      alert.id,
      ...Array.from(
        { length: VOLCANO_MAX_SOURCE_EVENT_IDS_PER_COMPOSITE - 1 },
        (_, index) => `saturated-source-${index.toString().padStart(4, "0")}`,
      ),
    ].sort();
    const standby = StandbyStateStore.fromSnapshot(saturated.standbyStateStore);
    standby.replaceVolcanoDerived(saturated.volcanoHolderAndRepair.holder);
    admission.restorePrevalidated({
      ...saturated,
      standbyStateStore: standby.cloneSnapshot(),
    });

    durable.mockClear();
    notify.mockClear();
    display.mockClear();
    vi.setSystemTime(Date.parse("2021-05-14T13:00:00+09:00"));
    const cancellation = createMockWsDataMessageFromXml(rewriteVolcanoXml(
      FIXTURE_VFVO54_ASH_RAPID,
      {
        reportDateTime: "2021-05-14T13:00:00+09:00",
        controlDateTime: "2021-05-14T04:00:00Z",
        serial: "1",
        infoType: "取消",
        ashfallSubject: true,
      },
    ), "VFVO54");
    const before = admission.capture();

    expect(handler.handle(cancellation)).toEqual({ kind: "suppressed" });
    expect(admission.capture()).toEqual(before);
    expect(durable).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
    handler.flushAndDispose();
  });

  it("accepts a cancellation at the source-ID ceiling when it removes the last slice", () => {
    vi.useFakeTimers({ now: Date.parse("2021-05-14T12:40:00+09:00") });
    const owners = createCrossSliceOwners();
    const admission = new StandbyPersistenceAdmissionCoordinator({ owners });
    const durable = vi.fn();
    admission.onDurable(durable);
    const handler = new VolcanoRouteHandler({
      volcanoState: owners.volcanoState,
      revisionGate: owners.telegramRevisionGate,
      volcanoTransactionCoordinator: new VolcanoTransactionCoordinator(admission),
      notifier: { notifyVolcano: vi.fn(), notifyVolcanoBatch: vi.fn() } as never,
      runDisplayPipeline: (_outcome, show) => {
        show();
        return true;
      },
      display: { displayVolcano: vi.fn(), displayVolcanoBatch: vi.fn() } as never,
    });
    const active = createMockWsDataMessageFromXml(rewriteVolcanoXml(
      FIXTURE_VFVO54_ASH_RAPID,
      {
        reportDateTime: "2021-05-14T12:40:00+09:00",
        controlDateTime: "2021-05-14T03:40:00Z",
        serial: "1",
        ashfallSubject: true,
      },
    ), "VFVO54");
    expect(handler.handle(active).kind).toBe("accepted");

    const saturated = structuredClone(admission.capture().domains);
    const composite = saturated.volcanoHolderAndRepair.holder.composites[0]!;
    composite.sourceEventIds = [
      active.id,
      ...Array.from(
        { length: VOLCANO_MAX_SOURCE_EVENT_IDS_PER_COMPOSITE - 1 },
        (_, index) => `last-slice-source-${index.toString().padStart(4, "0")}`,
      ),
    ].sort();
    const standby = StandbyStateStore.fromSnapshot(saturated.standbyStateStore);
    standby.replaceVolcanoDerived(saturated.volcanoHolderAndRepair.holder);
    admission.restorePrevalidated({
      ...saturated,
      standbyStateStore: standby.cloneSnapshot(),
    });

    durable.mockClear();
    vi.setSystemTime(Date.parse("2021-05-14T13:00:00+09:00"));
    const cancellation = createMockWsDataMessageFromXml(rewriteVolcanoXml(
      FIXTURE_VFVO54_ASH_RAPID,
      {
        reportDateTime: "2021-05-14T13:00:00+09:00",
        controlDateTime: "2021-05-14T04:00:00Z",
        serial: "2",
        infoType: "取消",
        ashfallSubject: true,
      },
    ), "VFVO54");

    expect(handler.handle(cancellation).kind).toBe("accepted");
    expect(admission.capture().domains.volcanoHolderAndRepair.holder.composites).toEqual([]);
    expect(durable).toHaveBeenCalledTimes(1);
    handler.flushAndDispose();
  });

  it("real EventID 506 rapid→detailed is atomic, generation monotonic, and duplicate-neutral", () => {
    vi.useFakeTimers({ now: Date.parse("2021-05-14T12:40:00+09:00") });
    const root = mkdtempSync(join(tmpdir(), "fleq-volcano-ashfall-lifecycle-"));
    roots.push(root);
    const persistence = new StandbyPersistence(join(root, "display-active-state-v1.json"));
    const owners = {
      telegramRevisionGate: new TelegramRevisionGate(),
      standbyStateStore: new StandbyStateStore(),
      vpws50State: new Vpws50StateHolder(),
      vpww56State: new Vpww56StateHolder(),
      tsunamiState: new TsunamiStateHolder(),
      volcanoState: new VolcanoStateHolder(),
      floodForecastState: new FloodForecastStateHolder(),
    };
    const admission = new StandbyPersistenceAdmissionCoordinator({
      owners,
      serializePair: (domains, envelope) =>
        serializeStandbyAdmissionPair(persistence, domains, envelope),
      canReserveLogicalGeneration: () => persistence.canReserveLogicalGeneration(),
    });
    const coordinator = new VolcanoTransactionCoordinator(admission);
    const order: string[] = [];
    const durable = vi.fn(() => { order.push("durable"); });
    const revision = vi.fn(() => { order.push("revision"); });
    const notify = vi.fn(() => { order.push("notify"); });
    const display = vi.fn(() => { order.push("display"); });
    admission.onDurable(durable);
    const handler = new VolcanoRouteHandler({
      volcanoState: owners.volcanoState,
      revisionGate: owners.telegramRevisionGate,
      volcanoTransactionCoordinator: coordinator,
      notifier: {
        notifyVolcano: notify,
        notifyVolcanoBatch: vi.fn(),
      } as never,
      onRevisionDecision: revision,
      runDisplayPipeline: (_outcome, show) => {
        show();
        return true;
      },
      display: {
        displayVolcano: display,
        displayVolcanoBatch: vi.fn(),
      } as never,
    });

    const rapid = createMockWsDataMessage(FIXTURE_VFVO54_ASH_RAPID);
    expect(handler.handle(rapid).kind).toBe("accepted");
    expect(order[0]).toBe("durable");
    expect(order.indexOf("durable")).toBeLessThan(order.indexOf("revision"));
    expect(order.indexOf("revision")).toBeLessThan(order.indexOf("notify"));
    expect(coordinator.snapshot().holder.composites[0]?.ashfall).toMatchObject({
      volcanoCode: "506",
      eventId: "506",
      sourceType: "VFVO54",
      sourceEventId: rapid.id,
      generation: 1,
    });

    vi.setSystemTime(Date.parse("2021-05-14T12:51:00+09:00"));
    order.length = 0;
    const detailed = createMockWsDataMessage(FIXTURE_VFVO55_ASH_DETAIL);
    expect(handler.handle(detailed).kind).toBe("accepted");
    const afterDetailed = coordinator.snapshot();
    expect(afterDetailed.holder.composites[0]).toMatchObject({
      volcanoCode: "506",
      sourceEventIds: [rapid.id, detailed.id],
      ashfall: {
        eventId: "506",
        sourceType: "VFVO55",
        sourceEventId: detailed.id,
        generation: 2,
      },
    });
    expect(afterDetailed.gates.states).toContainEqual(expect.objectContaining({
      key: "volcano:volcanoAshfall:volcano:ashfall:506",
      volcanoProvenance: {
        kind: "ashfall",
        actualEventId: "506",
        sourceType: "VFVO55",
      },
      comparison: expect.objectContaining({ variantRank: 1 }),
    }));
    expect(owners.standbyStateStore.exportActiveState().volcanoes[0]).toMatchObject({
      code: "506",
      sourceEventIds: [rapid.id, detailed.id],
      ashfall: expect.objectContaining({
        kind: "detailed",
        sourceEventId: detailed.id,
        generation: 2,
      }),
      ashfallRevision: afterDetailed.holder.composites[0]?.ashfall?.revision,
    });

    const beforeDuplicate = coordinator.snapshot();
    const callbackCounts = {
      durable: durable.mock.calls.length,
      notify: notify.mock.calls.length,
      display: display.mock.calls.length,
    };
    expect(handler.handle(detailed)).toEqual({ kind: "suppressed" });
    expect(coordinator.snapshot()).toEqual(beforeDuplicate);
    expect({
      durable: durable.mock.calls.length,
      notify: notify.mock.calls.length,
      display: display.mock.calls.length,
    }).toEqual(callbackCounts);
    handler.flushAndDispose();
  });

  it("does not escape into a direct holder mutation when full-file admission rejects an alert", () => {
    const owners = {
      telegramRevisionGate: new TelegramRevisionGate(),
      standbyStateStore: new StandbyStateStore(),
      vpws50State: new Vpws50StateHolder(),
      vpww56State: new Vpww56StateHolder(),
      tsunamiState: new TsunamiStateHolder(),
      volcanoState: new VolcanoStateHolder(),
      floodForecastState: new FloodForecastStateHolder(),
    };
    const admission = new StandbyPersistenceAdmissionCoordinator({
      owners,
      serializePair: () => {
        throw new Error("synthetic full-file admission failure");
      },
    });
    const durable = vi.fn();
    admission.onDurable(durable);
    const notify = vi.fn();
    const display = vi.fn();
    const revision = vi.fn();
    const handler = new VolcanoRouteHandler({
      volcanoState: owners.volcanoState,
      revisionGate: owners.telegramRevisionGate,
      volcanoTransactionCoordinator: new VolcanoTransactionCoordinator(admission),
      notifier: {
        notifyVolcano: notify,
        notifyVolcanoBatch: vi.fn(),
      } as never,
      onRevisionDecision: revision,
      runDisplayPipeline: (_outcome, show) => {
        show();
        return true;
      },
      display: {
        displayVolcano: display,
        displayVolcanoBatch: vi.fn(),
      } as never,
    });
    const before = admission.capture();

    expect(handler.handle(createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LV3)))
      .toEqual({ kind: "suppressed" });
    expect(admission.capture()).toEqual(before);
    expect(durable).not.toHaveBeenCalled();
    expect(revision).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
    handler.flushAndDispose();
  });
});
