import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ParsedVolcanoAlertInfo,
  ParsedVolcanoEruptionInfo,
  ParsedVolcanoTextInfo,
  WsDataMessage,
} from "../../../src/types";
import { createTelegramMeta } from "../../../src/dmdata/telegram-meta";
import { VolcanoRouteHandler } from "../../../src/engine/messages/volcano-route-handler";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import {
  VOLCANO_ALERT_TOMBSTONE_RETENTION_MS,
  VOLCANO_ERUPTION_TOMBSTONE_RETENTION_MS,
  volcanoRevisionFamilyPolicy,
} from "../../../src/engine/messages/revision-family-registry";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { RevisionGuard } from "../../../src/engine/display/revision-guard";
import { revisionOf } from "../../../src/engine/display/standby-registry";
import {
  StandbyPersistence,
  standbyPersistenceV2Path,
} from "../../../src/engine/display/standby-persistence";
import { fromVolcanoOutcome } from "../../../src/engine/presentation/events/from-volcano";
import type { ProcessOutcome, VolcanoBatchOutcome, VolcanoOutcome } from "../../../src/engine/presentation/types";

const T0 = Date.parse("2026-08-01T09:00:00+09:00");
const TEST_NOW = Date.parse("2026-07-31T12:30:00+09:00");
const roots: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: TEST_NOW, toFake: ["Date"] });
});

function tempRoot(label: string): string {
  const root = join(
    process.cwd(),
    ".tmp-workflow-out",
    "phase3b-volcano",
    `${label}-${process.pid}-${Date.now()}`,
  );
  rmSync(root, { recursive: true, force: true });
  roots.push(root);
  return root;
}

function message(id: string, type: string, reportDateTime: string): WsDataMessage {
  return {
    type: "data", version: "2.0", classification: "telegram.volcano", id, passing: [],
    head: { type, author: "気象庁", time: reportDateTime, test: false, xml: true },
    format: "xml", compression: null, encoding: "utf-8", body: "",
  };
}

function meta(
  id: string,
  type: string,
  reportDateTime: string,
  serial: string | null,
  infoType: "発表" | "訂正" | "取消" = "発表",
  eventId: string | null = null,
) {
  return createTelegramMeta({
    messageId: id, eventId, type, reportDateTime, serial, infoType,
    receivedAtMs: Date.parse(reportDateTime), status: "通常", isTest: false,
  });
}

function alert(
  id: string,
  code: string,
  reportDateTime: string,
  serial: string | null,
  overrides: Partial<ParsedVolcanoAlertInfo> = {},
): ParsedVolcanoAlertInfo {
  const infoType = (overrides.infoType ?? "発表") as "発表" | "訂正" | "取消";
  return {
    meta: meta(id, "VFVO50", reportDateTime, serial, infoType, overrides.meta?.eventId.value ?? null),
    domain: "volcano", kind: "alert", type: "VFVO50", infoType,
    title: "噴火警報・予報", reportDateTime, eventDateTime: null, headline: null,
    publishingOffice: "気象庁", volcanoName: code === "506" ? "桜島" : "浅間山",
    volcanoCode: code, coordinate: null, isTest: false,
    alertLevel: 3, alertLevelCode: "13", alertClass: null, action: "issue",
    previousLevelCode: "12", warningKind: "噴火警報（火口周辺）",
    municipalities: [], marineAreas: [], marineWarningKind: null,
    marineAlertLevelCode: null, bodyText: "", preventionText: "", isMarine: false,
    ...overrides,
  };
}

function text(
  id: string,
  reportDateTime: string,
  serial: string,
  entries: ParsedVolcanoTextInfo["alertClasses"],
): ParsedVolcanoTextInfo {
  return {
    meta: meta(id, "VFVO51", reportDateTime, serial, "発表", null),
    domain: "volcano", kind: "text", type: "VFVO51", infoType: "発表",
    title: "火山の状況に関する解説情報", reportDateTime, eventDateTime: null,
    headline: null, publishingOffice: "気象庁", volcanoName: "", volcanoCode: "",
    coordinate: null, isTest: false, alertLevel: null, alertLevelCode: null,
    alertClasses: entries, isExtraordinary: false, bodyText: "", nextAdvisory: null,
  };
}

function eruption(
  id: string,
  code: string,
  reportDateTime: string,
  serial: string,
  infoType: "発表" | "訂正" | "取消",
  eventId: string | null,
): ParsedVolcanoEruptionInfo {
  return {
    meta: meta(id, "VFVO56", reportDateTime, serial, infoType, eventId),
    domain: "volcano", kind: "eruption", type: "VFVO56", infoType,
    title: "噴火速報", reportDateTime, eventDateTime: reportDateTime, headline: null,
    publishingOffice: "気象庁", volcanoName: code === "506" ? "桜島" : "",
    volcanoCode: code, coordinate: null, isTest: false, phenomenonCode: "52",
    phenomenonName: "噴火", craterName: null, plumeHeight: null,
    plumeHeightUnknown: false, plumeDirection: null, isFlashReport: true, bodyText: "",
  };
}

function createHarness(restored?: {
  gate: TelegramRevisionGate;
  holder: VolcanoStateHolder;
  standby: StandbyStateStore;
}) {
  const gate = restored?.gate ?? new TelegramRevisionGate();
  const holder = restored?.holder ?? new VolcanoStateHolder();
  const standby = restored?.standby ?? new StandbyStateStore();
  const notifyVolcano = vi.fn();
  const decisions: string[] = [];
  const persisted = vi.fn();
  const outcomes: ProcessOutcome[] = [];
  const handler = new VolcanoRouteHandler({
    volcanoState: holder,
    revisionGate: gate,
    notifier: { notifyVolcano, notifyVolcanoBatch: vi.fn() } as never,
    onRevisionDecision: (decision) => decisions.push(decision.kind),
    onVolcanoRevisionDecision: persisted,
    runDisplayPipeline: (outcome: ProcessOutcome | VolcanoBatchOutcome, displayFn) => {
      if (!("isBatch" in outcome)) {
        const volcanoOutcome = outcome as VolcanoOutcome;
        outcomes.push(volcanoOutcome);
        standby.applyEvent(
          fromVolcanoOutcome(volcanoOutcome),
          Date.parse(volcanoOutcome.parsed.reportDateTime),
        );
      }
      displayFn();
      return true;
    },
  });
  return { gate, holder, standby, notifyVolcano, decisions, persisted, outcomes, handler };
}

// Each test replaces the parser at the module boundary without changing runtime DTO contracts.
vi.mock("../../../src/dmdata/volcano-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dmdata/volcano-parser")>();
  return {
    ...actual,
    parseVolcanoTelegram: (msg: WsDataMessage) => currentParsed.get(msg.id) ?? null,
  };
});
const currentParsed = new Map<string, ParsedVolcanoAlertInfo | ParsedVolcanoTextInfo | ParsedVolcanoEruptionInfo>();

afterEach(() => {
  vi.useRealTimers();
  currentParsed.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("Phase 3B volcano foundation", () => {
  it("alert/eruption family の境界を固定し VFVO53 batch は transient のままにする", () => {
    expect(volcanoRevisionFamilyPolicy("VFVO50")?.revisionFamily).toBe("volcanoAlert");
    expect(volcanoRevisionFamilyPolicy("VFVO51")?.revisionFamily).toBe("volcanoAlert");
    expect(volcanoRevisionFamilyPolicy("VFSVii")?.revisionFamily).toBe("volcanoAlert");
    expect(volcanoRevisionFamilyPolicy("VFVO52")?.revisionFamily).toBe("volcanoEruption");
    expect(volcanoRevisionFamilyPolicy("VFVO56")?.revisionFamily).toBe("volcanoEruption");
    expect(volcanoRevisionFamilyPolicy("VFVO53")).toMatchObject({
      revisionFamily: "volcanoAshfall",
      cancellationPolicy: "markCancelled",
      durable: false,
    });
  });

  it("VFVO51 を火山コードごとに展開し EventID 欠落でも部分解除を他火山へ波及させない", () => {
    const first = text("multi", new Date(T0).toISOString(), "1", [
      { volcanoCode: "306", volcanoName: "浅間山", alertClass: { code: "23", name: "入山危険", severity: "warning", isActive: true } },
      { volcanoCode: "506", volcanoName: "桜島", alertClass: { code: "22", name: "火口周辺危険", severity: "warning", isActive: true } },
    ]);
    const release = text("partial", new Date(T0 + 60_000).toISOString(), "2", [
      { volcanoCode: "306", volcanoName: "浅間山", alertClass: { code: "21", name: "活火山であることに留意", severity: "info", isActive: false } },
    ]);
    currentParsed.set("multi", first);
    currentParsed.set("partial", release);
    const h = createHarness();
    h.handler.handle(message("multi", "VFVO51", first.reportDateTime));
    h.handler.handle(message("partial", "VFVO51", release.reportDateTime));
    expect(h.holder.getEntry("306")).toBeUndefined();
    expect(h.holder.getEntry("506")?.alertClass?.code).toBe("22");
    expect(h.standby.exportActiveState().volcanoes.map((item) => item.code)).toEqual(["506"]);
  });

  it("subject 欠落取消は fail-open 表示だけに留め、state・通知・永続化を変更しない", () => {
    const first = alert("first-506", "506", new Date(T0 - 120_000).toISOString(), "1");
    const second = alert("first-306", "306", new Date(T0 - 120_000).toISOString(), "1");
    const missing = alert("missing", "", new Date(T0).toISOString(), "1", { infoType: "取消", action: "cancel" });
    currentParsed.set("first-506", first);
    currentParsed.set("first-306", second);
    currentParsed.set("missing", missing);
    const h = createHarness();
    h.handler.handle(message("first-506", "VFVO50", first.reportDateTime));
    h.handler.handle(message("first-306", "VFVO50", second.reportDateTime));
    h.notifyVolcano.mockClear();
    h.persisted.mockClear();
    h.handler.handle(message("missing", "VFVO50", missing.reportDateTime));
    expect(h.outcomes.at(-1)?.presentation.volcanoStateMutationAccepted).toBe(false);
    expect(h.standby.exportActiveState().volcanoes.map((entry) => entry.code).sort())
      .toEqual(["306", "506"]);
    expect(h.holder.size()).toBe(2);
    expect(h.notifyVolcano).not.toHaveBeenCalled();
    expect(h.persisted).not.toHaveBeenCalled();
  });

  it("A と C が同時成立する取消を clearCurrent 一回だけに解決する", () => {
    const issue = alert("issue", "506", new Date(T0).toISOString(), "1");
    const cancel = alert("cancel", "506", new Date(T0 + 60_000).toISOString(), "2", {
      infoType: "取消", action: "cancel",
    });
    currentParsed.set("issue", issue);
    currentParsed.set("cancel", cancel);
    const h = createHarness();
    h.handler.handle(message("issue", "VFVO50", issue.reportDateTime));
    h.decisions.length = 0;
    h.persisted.mockClear();
    h.handler.handle(message("cancel", "VFVO50", cancel.reportDateTime));
    expect(h.decisions).toEqual(["clearCurrent"]);
    expect(h.persisted).toHaveBeenCalledTimes(1);
    expect(h.holder.getEntry("506")).toBeUndefined();
  });

  it("空コード VFVO56 取消を EventID の一意対象だけへ適用する", () => {
    const first = eruption("eruption-1", "506", new Date(T0).toISOString(), "1", "発表", "event-506");
    const other = eruption("eruption-2", "306", new Date(T0).toISOString(), "1", "発表", "event-306");
    const cancel = eruption("eruption-cancel", "", new Date(T0 + 60_000).toISOString(), "2", "取消", "event-506");
    for (const item of [first, other, cancel]) currentParsed.set(item.meta.messageId, item);
    const h = createHarness();
    h.handler.handle(message("eruption-1", "VFVO56", first.reportDateTime));
    h.handler.handle(message("eruption-2", "VFVO56", other.reportDateTime));
    h.handler.handle(message("eruption-cancel", "VFVO56", cancel.reportDateTime));
    expect(h.standby.exportActiveState().volcanoes.map((item) => item.code)).toEqual(["306"]);
    expect(h.holder.resolveEruptionCancellation("event-506")).toBeNull();
    expect(h.holder.resolveEruptionCancellation("event-306")).toBe("306");
  });

  it("v1 表示専用の噴火 event を別 alert で消さず、空コード取消の一意対象へ昇格する", () => {
    const legacyEvent = eruption("legacy-eruption", "506", new Date(T0).toISOString(), "1", "発表", "legacy-event");
    currentParsed.set("legacy-eruption", legacyEvent);
    const legacyHarness = createHarness();
    legacyHarness.handler.handle(message("legacy-eruption", "VFVO56", legacyEvent.reportDateTime));
    const legacyState = legacyHarness.standby.exportActiveState();
    legacyState.volcanoes[0].latestEventId = null;

    const gate = new TelegramRevisionGate();
    const holder = new VolcanoStateHolder();
    holder.seedLegacyEruptionIdentities([{ volcanoCode: "506", eventId: null }]);
    expect(holder.exportPersistedState().eruptions).toEqual([{
      volcanoCode: "506",
      eventId: null,
      legacyV1Fallback: true,
    }]);
    const restoredHolder = new VolcanoStateHolder();
    restoredHolder.restorePersistedState(holder.exportPersistedState());
    const standby = new StandbyStateStore();
    standby.restoreActiveState(legacyState, T0 + 1);
    const restarted = createHarness({ gate, holder: restoredHolder, standby });
    const unrelated = alert("unrelated-alert", "306", new Date(T0 + 60_000).toISOString(), "1");
    currentParsed.set("unrelated-alert", unrelated);
    restarted.handler.handle(message("unrelated-alert", "VFVO50", unrelated.reportDateTime));
    expect(restarted.standby.exportActiveState().volcanoes.map((entry) => entry.code).sort())
      .toEqual(["306", "506"]);

    const cancel = eruption("legacy-cancel", "", new Date(T0 + 120_000).toISOString(), "2", "取消", "legacy-event");
    currentParsed.set("legacy-cancel", cancel);
    restarted.handler.handle(message("legacy-cancel", "VFVO56", cancel.reportDateTime));
    expect(restarted.standby.exportActiveState().volcanoes.map((entry) => entry.code)).toEqual(["306"]);
    expect(restarted.gate.exportDurableEntries()).toContainEqual(expect.objectContaining({
      stateSubjectKey: "volcano:eruption:506",
      cancelled: true,
    }));
  });

  it("同一 revision 訂正を一度だけ受理し、遅着通常報を抑止する", () => {
    const issued = alert("issued", "506", new Date(T0).toISOString(), "1");
    const corrected = alert("corrected", "506", new Date(T0).toISOString(), "1", {
      infoType: "訂正", alertLevel: 4, alertLevelCode: "14", action: "raise",
    });
    const replay = { ...corrected, meta: { ...corrected.meta, messageId: "corrected-replay" } };
    currentParsed.set("issued", issued);
    currentParsed.set("corrected", corrected);
    currentParsed.set("corrected-replay", replay);
    const h = createHarness();
    h.handler.handle(message("issued", "VFVO50", issued.reportDateTime));
    h.handler.handle(message("corrected", "VFVO50", corrected.reportDateTime));
    h.handler.handle(message("corrected-replay", "VFVO50", corrected.reportDateTime));
    expect(h.holder.getEntry("506")?.alertLevel).toBe(4);
    expect(h.notifyVolcano).toHaveBeenCalledTimes(2);
    expect(h.outcomes[1].presentation.acceptedCorrection).toBe(true);
    expect(h.decisions).toContain("replaceCorrection");
    expect(h.decisions.at(-1)).toBe("semanticDuplicate");
  });

  it("VFVO51 訂正内の同一 subject は最後の entry を一度だけ適用する", () => {
    const issued = text("text-issued", new Date(T0).toISOString(), "1", [{
      volcanoCode: "506", volcanoName: "桜島",
      alertClass: { code: "22", name: "火口周辺危険", severity: "warning", isActive: true },
    }]);
    const corrected = {
      ...text("text-corrected", new Date(T0).toISOString(), "1", [
        {
          volcanoCode: "506", volcanoName: "桜島",
          alertClass: { code: "22", name: "火口周辺危険", severity: "warning", isActive: true },
        },
        {
          volcanoCode: "506", volcanoName: "桜島",
          alertClass: { code: "23", name: "入山危険", severity: "warning", isActive: true },
        },
      ]),
      infoType: "訂正" as const,
      meta: meta("text-corrected", "VFVO51", new Date(T0).toISOString(), "1", "訂正", null),
    };
    currentParsed.set("text-issued", issued);
    currentParsed.set("text-corrected", corrected);
    const h = createHarness();
    h.handler.handle(message("text-issued", "VFVO51", issued.reportDateTime));
    h.decisions.length = 0;
    h.persisted.mockClear();
    h.handler.handle(message("text-corrected", "VFVO51", corrected.reportDateTime));

    expect(h.decisions).toEqual(["replaceCorrection"]);
    expect(h.persisted).toHaveBeenCalledTimes(1);
    expect(h.holder.getEntry("506")?.alertClass?.code).toBe("23");
  });

  it("レベル引下げ後の古い report を共通 gate で拒否する", () => {
    const issued = alert("level-four", "506", new Date(T0).toISOString(), "1", {
      alertLevel: 4,
      alertLevelCode: "4",
    });
    const lowered = alert("level-two", "506", new Date(T0 + 60_000).toISOString(), "2", {
      alertLevel: 2,
      alertLevelCode: "2",
      action: "lower",
    });
    const delayed = { ...issued, meta: { ...issued.meta, messageId: "delayed-level-four" } };
    currentParsed.set("level-four", issued);
    currentParsed.set("level-two", lowered);
    currentParsed.set("delayed-level-four", delayed);
    const h = createHarness();
    h.handler.handle(message("level-four", "VFVO50", issued.reportDateTime));
    h.handler.handle(message("level-two", "VFVO50", lowered.reportDateTime));
    expect(h.handler.handle(message("delayed-level-four", "VFVO50", issued.reportDateTime))).toMatchObject({ kind: "suppressed" });
    expect(h.holder.getEntry("506")?.alertLevel).toBe(2);
    expect(h.decisions.at(-1)).toBe("stale");
  });

  it("非数値 Serial は current state・通知を変更しない", () => {
    const invalid = alert("invalid-serial", "506", new Date(T0).toISOString(), "X");
    currentParsed.set("invalid-serial", invalid);
    const h = createHarness();
    expect(h.handler.handle(message("invalid-serial", "VFVO50", invalid.reportDateTime))).toMatchObject({ kind: "suppressed" });
    expect(h.holder.size()).toBe(0);
    expect(h.standby.exportActiveState().volcanoes).toEqual([]);
    expect(h.notifyVolcano).not.toHaveBeenCalled();
    expect(h.decisions).toEqual(["invalidRevision"]);
  });

  it("v2 を実ファイル往復し、取消 tombstone が restart 後の遅延報を拒否する", () => {
    const issue = alert("issue", "506", new Date(T0).toISOString(), "1");
    const cancel = alert("cancel", "506", new Date(T0 + 60_000).toISOString(), "2", {
      infoType: "取消", action: "cancel",
    });
    currentParsed.set("issue", issue);
    currentParsed.set("cancel", cancel);
    const h = createHarness();
    h.handler.handle(message("issue", "VFVO50", issue.reportDateTime));
    h.handler.handle(message("cancel", "VFVO50", cancel.reportDateTime));

    const root = tempRoot("roundtrip");
    const path = join(root, "display-active-state-v1.json");
    mkdirSync(dirname(path), { recursive: true });
    const foundation = () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      volcano: {
        authoritative: true,
        state: h.holder.exportPersistedState(),
        active: h.standby.exportActiveState().volcanoes,
        gateEntries: h.gate.exportDurableEntries().filter((entry) => entry.domain === "volcano"),
      },
    });
    new StandbyPersistence(path, 0, foundation).save(h.standby.exportActiveState());
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
    expect(JSON.parse(readFileSync(standbyPersistenceV2Path(path), "utf8")).version).toBe(2);

    const loaded = new StandbyPersistence(path).load()!;
    expect(loaded.telegramFoundation.volcano.gateEntries).toEqual([
      expect.objectContaining({
        stateSubjectKey: "volcano:alert:506",
        cancelled: true,
        tombstoneRetentionMs: 30 * 24 * 60 * 60_000,
      }),
    ]);
    const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(loaded.telegramFoundation.volcano.gateEntries);
    const holder = new VolcanoStateHolder();
    if (loaded.telegramFoundation.volcano.state != null) {
      holder.restorePersistedState(loaded.telegramFoundation.volcano.state);
    }
    const standby = new StandbyStateStore();
    standby.restoreActiveState(loaded, T0 + 120_000);
    standby.restoreCanonicalVolcanoes(
      loaded.telegramFoundation.volcano.active,
      loaded.telegramFoundation.volcano.gateEntries,
      T0 + 120_000,
    );
    currentParsed.set("late", { ...issue, meta: { ...issue.meta, messageId: "late" } });
    const restarted = createHarness({ gate, holder, standby });
    expect(restarted.handler.handle(message("late", "VFVO50", issue.reportDateTime))).toMatchObject({ kind: "suppressed" });
    expect(restarted.holder.getEntry("506")).toBeUndefined();
    expect(restarted.standby.exportActiveState().volcanoes).toEqual([]);
  });

  it("VFVO56 取消 watermark を旧 reader 用 v1 seen へ dual-write する", () => {
    const issue = eruption("eruption-v1", "506", new Date(T0).toISOString(), "1", "発表", "event-506");
    const cancel = eruption("eruption-v1-cancel", "", new Date(T0 + 60_000).toISOString(), "2", "取消", "event-506");
    currentParsed.set("eruption-v1", issue);
    currentParsed.set("eruption-v1-cancel", cancel);
    const h = createHarness();
    h.handler.handle(message("eruption-v1", "VFVO56", issue.reportDateTime));
    h.handler.handle(message("eruption-v1-cancel", "VFVO56", cancel.reportDateTime));

    const root = tempRoot("rollback");
    const path = join(root, "display-active-state-v1.json");
    mkdirSync(dirname(path), { recursive: true });
    new StandbyPersistence(path, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      volcano: {
        authoritative: true,
        state: h.holder.exportPersistedState(),
        active: h.standby.exportActiveState().volcanoes,
        gateEntries: h.gate.exportDurableEntries().filter((entry) => entry.domain === "volcano"),
      },
    })).save(h.standby.exportActiveState());

    const legacy = JSON.parse(readFileSync(path, "utf8"));
    expect(legacy.version).toBe(1);
    expect(legacy.seen).toContainEqual(expect.objectContaining({
      key: "volcano:event:event-506",
      revision: { reportTimeMs: T0 + 60_000, serial: "2" },
      forgetAtMs: T0 + 60_000 + VOLCANO_ERUPTION_TOMBSTONE_RETENTION_MS + 1,
    }));
    const oldReaderGuard = new RevisionGuard();
    oldReaderGuard.restore(legacy.seen, T0 + 120_000);
    expect(oldReaderGuard.accept(
      "volcano:event:event-506",
      revisionOf(issue.reportDateTime, "1", T0 + 120_001),
      T0 + 120_001,
      VOLCANO_ERUPTION_TOMBSTONE_RETENTION_MS,
    )).toBe(false);
  });

  it("噴火取消は2日以内の遅延報を拒否し、保持期限後は新 lifecycle として受理する", () => {
    const issue = eruption("ttl-issue", "506", new Date(T0).toISOString(), "1", "発表", "ttl-event");
    const cancel = eruption("ttl-cancel", "", new Date(T0 + 60_000).toISOString(), "2", "取消", "ttl-event");
    const delayed = {
      ...issue,
      meta: {
        ...issue.meta,
        messageId: "ttl-delayed",
        receivedAtMs: T0 + 60_000 + VOLCANO_ERUPTION_TOMBSTONE_RETENTION_MS - 1,
      },
    };
    const sweepTrigger = alert(
      "ttl-sweep-trigger",
      "306",
      new Date(T0 + 60_000 + VOLCANO_ERUPTION_TOMBSTONE_RETENTION_MS + 1).toISOString(),
      "1",
    );
    const afterRetention = {
      ...issue,
      meta: {
        ...issue.meta,
        messageId: "ttl-after-retention",
        receivedAtMs: sweepTrigger.meta.receivedAtMs + 1,
      },
    };
    for (const item of [issue, cancel, delayed, sweepTrigger, afterRetention]) {
      currentParsed.set(item.meta.messageId, item);
    }
    const h = createHarness();
    h.handler.handle(message("ttl-issue", "VFVO56", issue.reportDateTime));
    h.handler.handle(message("ttl-cancel", "VFVO56", cancel.reportDateTime));

    expect(h.handler.handle(message("ttl-delayed", "VFVO56", issue.reportDateTime))).toMatchObject({ kind: "suppressed" });
    h.handler.handle(message("ttl-sweep-trigger", "VFVO50", sweepTrigger.reportDateTime));
    expect(h.handler.handle(message("ttl-after-retention", "VFVO56", issue.reportDateTime))).toMatchObject({ kind: "accepted" });
    expect(h.holder.resolveEruptionCancellation("ttl-event")).toBe("506");
  });

  it("active snapshot を v2 の真実源として往復し、volcano 破損を他 domain から分離する", () => {
    const issue = alert("active", "506", new Date(T0).toISOString(), "1");
    currentParsed.set("active", issue);
    const h = createHarness();
    h.handler.handle(message("active", "VFVO50", issue.reportDateTime));
    const root = tempRoot("active");
    const path = join(root, "display-active-state-v1.json");
    mkdirSync(dirname(path), { recursive: true });
    const foundation = () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      volcano: {
        authoritative: true,
        state: h.holder.exportPersistedState(),
        active: h.standby.exportActiveState().volcanoes,
        gateEntries: h.gate.exportDurableEntries().filter((entry) => entry.domain === "volcano"),
      },
    });
    new StandbyPersistence(path, 0, foundation).save(h.standby.exportActiveState());
    const loaded = new StandbyPersistence(path).load()!;
    expect(loaded.telegramFoundation.volcano).toMatchObject({ authoritative: true });
    expect(loaded.telegramFoundation.volcano.active[0]).toMatchObject({ code: "506", alertLevel: 3 });
    expect(loaded.telegramFoundation.volcano.state?.alerts[0]).toMatchObject({ volcanoCode: "506" });

    const v2Path = standbyPersistenceV2Path(path);
    const originalV1 = readFileSync(path, "utf8");
    const originalV2 = readFileSync(v2Path, "utf8");
    const conflictingV1 = JSON.parse(originalV1);
    const conflictingV2 = JSON.parse(originalV2);
    conflictingV1.volcanoes[0].alertLevel = 2;
    conflictingV2.volcanoes[0].alertLevel = 2;
    writeFileSync(path, JSON.stringify(conflictingV1), "utf8");
    writeFileSync(v2Path, JSON.stringify(conflictingV2), "utf8");
    const conflicted = new StandbyPersistence(path);
    expect(conflicted.load()?.telegramFoundation.volcano.active[0]?.alertLevel).toBe(3);
    expect(conflicted.takeMigrationConflictCount()).toBe(1);
    writeFileSync(path, originalV1, "utf8");
    writeFileSync(v2Path, originalV2, "utf8");

    const broken = JSON.parse(readFileSync(v2Path, "utf8"));
    broken.telegramFoundation.volcano.state.alerts[0].reportDateTime = "invalid";
    writeFileSync(v2Path, JSON.stringify(broken), "utf8");
    const salvaged = new StandbyPersistence(path).load()!;
    expect(salvaged.telegramFoundation.volcano).toEqual({
      authoritative: false, state: null, active: [], gateEntries: [],
    });
    expect(salvaged.telegramFoundation.vpws50).toEqual({
      authoritative: true, state: null, gateEntries: [],
    });
    expect(salvaged.volcanoes[0]?.code).toBe("506");
  });

  it("subject 上限超過時も gate・holder・standby が同じ LRU 順で退場する", () => {
    const h = createHarness();
    const initialTime = new Date(T0).toISOString();
    for (let index = 0; index < 512; index++) {
      const code = index.toString().padStart(3, "0");
      const id = `initial-${code}`;
      const item = alert(id, code, initialTime, "1");
      currentParsed.set(id, item);
      h.handler.handle(message(id, "VFVO50", initialTime));
    }
    const nextTime = new Date(T0 + 60_000).toISOString();
    const refreshed = alert("refresh-000", "000", nextTime, "2", { alertLevel: 4 });
    const added = alert("add-512", "512", nextTime, "1");
    currentParsed.set("refresh-000", refreshed);
    currentParsed.set("add-512", added);
    h.handler.handle(message("refresh-000", "VFVO50", nextTime));
    h.handler.handle(message("add-512", "VFVO50", nextTime));

    const gateCodes = h.gate.activeRevisionFamilySubjects("volcano", "volcanoAlert")
      .map((subject) => subject.replace("volcano:alert:", ""));
    const holderCodes = h.holder.exportPersistedState().alerts.map((entry) => entry.volcanoCode);
    const standbyCodes = h.standby.exportActiveState().volcanoes.map((entry) => entry.code);
    expect(gateCodes).toHaveLength(512);
    expect(holderCodes).toEqual(gateCodes);
    expect(new Set(standbyCodes)).toEqual(new Set(gateCodes));
    expect(gateCodes).toContain("000");
    expect(gateCodes).toContain("512");
    expect(gateCodes).not.toContain("001");
    expect(standbyCodes).not.toContain("001");
    expect(T0 + 60_000).toBeLessThan(T0 + VOLCANO_ALERT_TOMBSTONE_RETENTION_MS);
  });

  it("keeps an unkeyed VFVO51 transient and suppresses notification and durable mutation", () => {
    const unkeyed = text("unkeyed-text", new Date(T0).toISOString(), "1", []);
    currentParsed.set("unkeyed-text", unkeyed);
    const h = createHarness();

    expect(h.handler.handle(message("unkeyed-text", "VFVO51", unkeyed.reportDateTime))).toMatchObject({ kind: "accepted" });
    expect(h.outcomes.at(-1)?.presentation.volcanoStateMutationAccepted).toBe(false);
    expect(h.notifyVolcano).not.toHaveBeenCalled();
    expect(h.persisted).not.toHaveBeenCalled();
    expect(h.holder.size()).toBe(0);
    expect(h.standby.exportActiveState().volcanoes).toEqual([]);
    expect(h.gate.exportDurableEntries().filter((entry) => entry.domain === "volcano")).toEqual([]);
  });

  it("recovers an active eruption EventID when dual-writing a pre-legacyRevisionKey v2 state", () => {
    const issue = eruption(
      "pre-key-eruption",
      "506",
      new Date(T0).toISOString(),
      "1",
      "発表",
      "active-event-506",
    );
    currentParsed.set("pre-key-eruption", issue);
    const h = createHarness();
    h.handler.handle(message("pre-key-eruption", "VFVO56", issue.reportDateTime));

    const gateEntries = h.gate.exportDurableEntries().filter((entry) => entry.domain === "volcano");
    for (const entry of gateEntries) {
      delete entry.legacyRevisionKey;
      delete entry.legacyRevisionKeyProvenance;
    }
    const root = tempRoot("pre-key");
    const path = join(root, "display-active-state-v1.json");
    mkdirSync(dirname(path), { recursive: true });
    const foundation = {
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      volcano: {
        authoritative: true,
        state: h.holder.exportPersistedState(),
        active: h.standby.exportActiveState().volcanoes,
        gateEntries,
      },
    };
    new StandbyPersistence(path, 0, () => foundation).save(h.standby.exportActiveState());
    const loaded = new StandbyPersistence(path).load()!;
    new StandbyPersistence(path, 0, () => loaded.telegramFoundation).save(loaded);

    const legacy = JSON.parse(readFileSync(path, "utf8"));
    expect(legacy.seen.filter((entry: { key: string }) => entry.key.startsWith("volcano:event:")))
      .toEqual([expect.objectContaining({
        key: "volcano:event:active-event-506",
        revision: { reportTimeMs: T0, serial: "1" },
      })]);
  });

  it("prefers a trusted volcano gate projection over an untrusted legacy seen entry", () => {
    const issue = alert("trusted-alert", "506", new Date(T0).toISOString(), "1");
    currentParsed.set("trusted-alert", issue);
    const h = createHarness();
    h.handler.handle(message("trusted-alert", "VFVO50", issue.reportDateTime));
    const state = h.standby.exportActiveState();
    state.seen.push({
      key: "volcano:alert:506",
      revision: { reportTimeMs: T0 + 10 * 24 * 60 * 60_000, serial: "999" },
      forgetAtMs: T0 + 40 * 24 * 60 * 60_000,
    });

    const root = tempRoot("trusted");
    const path = join(root, "display-active-state-v1.json");
    mkdirSync(dirname(path), { recursive: true });
    new StandbyPersistence(path, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      volcano: {
        authoritative: true,
        state: h.holder.exportPersistedState(),
        active: state.volcanoes,
        gateEntries: h.gate.exportDurableEntries().filter((entry) => entry.domain === "volcano"),
      },
    })).save(state);

    const legacy = JSON.parse(readFileSync(path, "utf8"));
    expect(legacy.seen.filter((entry: { key: string }) => entry.key === "volcano:alert:506"))
      .toEqual([expect.objectContaining({
        revision: { reportTimeMs: T0, serial: "1" },
      })]);
  });

  it("does not treat a live eruption with no EventID as a legacy-v1 cancellation fallback", () => {
    const issue = eruption("live-no-event", "506", new Date(T0).toISOString(), "1", "発表", null);
    currentParsed.set("live-no-event", issue);
    const initial = createHarness();
    initial.handler.handle(message("live-no-event", "VFVO56", issue.reportDateTime));
    const persistedHolder = initial.holder.exportPersistedState();
    expect(persistedHolder.eruptions).toEqual([{ volcanoCode: "506", eventId: null }]);

    const holder = new VolcanoStateHolder();
    holder.restorePersistedState(persistedHolder);
    const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(initial.gate.exportDurableEntries());
    const standby = new StandbyStateStore();
    standby.restoreActiveState(initial.standby.exportActiveState(), T0 + 1);
    const restarted = createHarness({ gate, holder, standby });
    const unrelatedCancel = eruption(
      "unrelated-cancel",
      "",
      new Date(T0 + 60_000).toISOString(),
      "2",
      "取消",
      "unrelated-event",
    );
    currentParsed.set("unrelated-cancel", unrelatedCancel);

    expect(restarted.handler.handle(
      message("unrelated-cancel", "VFVO56", unrelatedCancel.reportDateTime),
    )).toMatchObject({ kind: "accepted" });
    expect(restarted.outcomes.at(-1)?.presentation.volcanoStateMutationAccepted).toBe(false);
    expect(restarted.notifyVolcano).not.toHaveBeenCalled();
    expect(restarted.holder.exportPersistedState().eruptions)
      .toEqual([{ volcanoCode: "506", eventId: null }]);
    expect(restarted.standby.exportActiveState().volcanoes.map((entry) => entry.code))
      .toEqual(["506"]);
    expect(restarted.gate.exportDurableEntries().find(
      (entry) => entry.stateSubjectKey === "volcano:eruption:506",
    )?.cancelled).toBe(false);
  });

  it("does not reverse a code-fallback rollback key as a real EventID after restart", () => {
    const issue = eruption("collision-issue", "506", new Date(T0).toISOString(), "1", "\u767a\u8868", null);
    currentParsed.set("collision-issue", issue);
    const initial = createHarness();
    initial.handler.handle(message("collision-issue", "VFVO56", issue.reportDateTime));

    const root = tempRoot("key-provenance");
    const path = join(root, "display-active-state-v1.json");
    mkdirSync(dirname(path), { recursive: true });
    new StandbyPersistence(path, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      volcano: {
        authoritative: true,
        state: initial.holder.exportPersistedState(),
        active: initial.standby.exportActiveState().volcanoes,
        gateEntries: initial.gate.exportDurableEntries().filter((entry) => entry.domain === "volcano"),
      },
    })).save(initial.standby.exportActiveState());
    const loaded = new StandbyPersistence(path).load()!;
    const persistedEntries = loaded.telegramFoundation.volcano.gateEntries;
    expect(persistedEntries).toContainEqual(expect.objectContaining({
      stateSubjectKey: "volcano:eruption:506",
      legacyRevisionKey: "volcano:event:506",
      legacyRevisionKeyProvenance: "codeFallback",
      cancelled: false,
    }));
    const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(persistedEntries);
    const holder = new VolcanoStateHolder();
    holder.restorePersistedState(initial.holder.exportPersistedState());
    const standby = new StandbyStateStore();
    standby.restoreActiveState(initial.standby.exportActiveState(), T0 + 1);
    const restarted = createHarness({ gate, holder, standby });

    const collidingCancel = eruption(
      "collision-cancel",
      "",
      new Date(T0 + 60_000).toISOString(),
      "2",
      "\u53d6\u6d88",
      "506",
    );
    currentParsed.set("collision-cancel", collidingCancel);
    expect(restarted.handler.handle(
      message("collision-cancel", "VFVO56", collidingCancel.reportDateTime),
    )).toMatchObject({ kind: "accepted" });

    expect(restarted.outcomes.at(-1)?.presentation.volcanoStateMutationAccepted).toBe(false);
    expect(restarted.notifyVolcano).not.toHaveBeenCalled();
    expect(restarted.persisted).not.toHaveBeenCalled();
    expect(restarted.holder.exportPersistedState().eruptions)
      .toEqual([{ volcanoCode: "506", eventId: null }]);
    expect(restarted.standby.exportActiveState().volcanoes.map((entry) => entry.code))
      .toEqual(["506"]);
    expect(restarted.gate.exportDurableEntries()).toContainEqual(expect.objectContaining({
      stateSubjectKey: "volcano:eruption:506",
      legacyRevisionKey: "volcano:event:506",
      legacyRevisionKeyProvenance: "codeFallback",
      cancelled: false,
    }));
  });

  it("preserves the previous EventID rollback key for an EventID-less coded cancellation", () => {
    const issue = eruption("coded-issue", "506", new Date(T0).toISOString(), "1", "発表", "event-E");
    const cancel = eruption(
      "coded-cancel",
      "506",
      new Date(T0 + 60_000).toISOString(),
      "2",
      "取消",
      null,
    );
    currentParsed.set("coded-issue", issue);
    currentParsed.set("coded-cancel", cancel);
    const h = createHarness();
    h.handler.handle(message("coded-issue", "VFVO56", issue.reportDateTime));
    const preKeyEntries = h.gate.exportDurableEntries();
    for (const entry of preKeyEntries) {
      delete entry.legacyRevisionKey;
      delete entry.legacyRevisionKeyProvenance;
    }
    const preKeyGate = new TelegramRevisionGate();
    preKeyGate.restoreDurableEntries(preKeyEntries);
    const migrated = createHarness({ gate: preKeyGate, holder: h.holder, standby: h.standby });
    migrated.handler.handle(message("coded-cancel", "VFVO56", cancel.reportDateTime));

    expect(migrated.gate.exportDurableEntries()).toContainEqual(expect.objectContaining({
      stateSubjectKey: "volcano:eruption:506",
      legacyRevisionKey: "volcano:event:event-E",
      legacyRevisionKeyProvenance: "eventId",
      cancelled: true,
    }));

    const root = tempRoot("missing-cancel-id");
    const path = join(root, "display-active-state-v1.json");
    mkdirSync(dirname(path), { recursive: true });
    new StandbyPersistence(path, 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      volcano: {
        authoritative: true,
        state: migrated.holder.exportPersistedState(),
        active: migrated.standby.exportActiveState().volcanoes,
        gateEntries: migrated.gate.exportDurableEntries().filter((entry) => entry.domain === "volcano"),
      },
    })).save(migrated.standby.exportActiveState());
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    expect(legacy.seen).toContainEqual(expect.objectContaining({
      key: "volcano:event:event-E",
      revision: { reportTimeMs: T0 + 60_000, serial: "2" },
    }));
    const oldReaderGuard = new RevisionGuard();
    oldReaderGuard.restore(legacy.seen, T0 + 120_000);
    expect(oldReaderGuard.accept(
      "volcano:event:event-E",
      revisionOf(issue.reportDateTime, "1", T0 + 120_001),
      T0 + 120_001,
      VOLCANO_ERUPTION_TOMBSTONE_RETENTION_MS,
    )).toBe(false);
  });

  it("resolves repeated empty-code cancellation from its durable EventID tombstone", () => {
    const issue = eruption("replay-issue", "506", new Date(T0).toISOString(), "1", "発表", "replay-event");
    const cancel = eruption(
      "replay-cancel",
      "",
      new Date(T0 + 60_000).toISOString(),
      "2",
      "取消",
      "replay-event",
    );
    const replay = {
      ...cancel,
      meta: { ...cancel.meta, messageId: "replay-cancel-2" },
    };
    currentParsed.set("replay-issue", issue);
    currentParsed.set("replay-cancel", cancel);
    currentParsed.set("replay-cancel-2", replay);
    const h = createHarness();
    h.handler.handle(message("replay-issue", "VFVO56", issue.reportDateTime));
    h.handler.handle(message("replay-cancel", "VFVO56", cancel.reportDateTime));
    const outcomeCount = h.outcomes.length;
    const notificationCount = h.notifyVolcano.mock.calls.length;
    const persistenceCount = h.persisted.mock.calls.length;

    expect(h.handler.handle(message("replay-cancel-2", "VFVO56", replay.reportDateTime))).toMatchObject({ kind: "suppressed" });
    expect(h.decisions.at(-1)).toBe("semanticDuplicate");
    expect(h.outcomes).toHaveLength(outcomeCount);
    expect(h.notifyVolcano).toHaveBeenCalledTimes(notificationCount);
    expect(h.persisted).toHaveBeenCalledTimes(persistenceCount);

    const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(h.gate.exportDurableEntries());
    const restarted = createHarness({ gate, holder: new VolcanoStateHolder(), standby: new StandbyStateStore() });
    const afterRestart = {
      ...cancel,
      meta: { ...cancel.meta, messageId: "replay-cancel-after-restart" },
    };
    currentParsed.set("replay-cancel-after-restart", afterRestart);
    expect(restarted.handler.handle(message(
      "replay-cancel-after-restart",
      "VFVO56",
      afterRestart.reportDateTime,
    ))).toMatchObject({ kind: "suppressed" });
    expect(restarted.decisions).toEqual(["semanticDuplicate"]);
    expect(restarted.outcomes).toEqual([]);
    expect(restarted.notifyVolcano).not.toHaveBeenCalled();
    expect(restarted.persisted).not.toHaveBeenCalled();
  });
});
