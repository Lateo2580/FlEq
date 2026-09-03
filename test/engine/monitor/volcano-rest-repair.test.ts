import { describe, it, expect, vi, beforeEach } from "vitest";
import { testTelegramMeta } from "../../helpers/telegram-meta";
import {
  createVolcanoRestRepair,
  VOLCANO_REST_REPAIR_COOLDOWN_MS,
  volcanoFoundationAuthoritativeFrom,
} from "../../../src/engine/monitor/monitor";
import { VolcanoRepairJournal } from "../../../src/engine/startup/volcano-initializer";
import {
  emptyVolcanoRepairState,
  VolcanoStateHolder,
} from "../../../src/engine/messages/volcano-state";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { StandbyPersistenceAdmissionCoordinator } from "../../../src/engine/display/standby-persistence-admission";
import { FloodForecastStateHolder } from "../../../src/engine/messages/flood-forecast-state";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import {
  VolcanoTransactionCoordinator,
  type VolcanoRestRepairResult,
  type VolcanoRestRepairTargetOutcome,
} from "../../../src/engine/messages/volcano-transaction-coordinator";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import { createTelegramMeta } from "../../../src/dmdata/telegram-meta";
import { normalizeTelegramMessage } from "../../../src/dmdata/telegram-ingress";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  StandbyPersistence,
  standbyPersistenceV2Path,
  type VolcanoManualBackupResult,
} from "../../../src/engine/display/standby-persistence";
import type {
  ParsedVolcanoAlertInfo,
  TelegramListItem,
  TelegramListResponse,
  WsDataMessage,
} from "../../../src/types";
import type { WsSubscriptionAcknowledgement } from "../../../src/dmdata/ws-client";

// 実 REST も node-notifier も踏まない。adapter が注入する loader だけを見る。
vi.mock("../../../src/dmdata/rest-client");
vi.mock("../../../src/engine/notification/sound-player", () => ({ playSound: vi.fn() }));
vi.mock("../../../src/dmdata/volcano-parser", () => ({ parseVolcanoTelegram: vi.fn() }));

import { parseVolcanoTelegram } from "../../../src/dmdata/volcano-parser";

const mockParseVolcano = vi.mocked(parseVolcanoTelegram);

const NOW = Date.parse("2026-07-10T00:00:00.000Z");
const ACK: WsSubscriptionAcknowledgement = {
  subscriptionGeneration: 1,
  socketId: 42,
  transportId: "socket:42:generation:1",
  acknowledgedAtMs: NOW - 60_000,
  classifications: ["telegram.volcano"],
};

function emptyResponse(): TelegramListResponse {
  return {
    responseId: "test-response",
    responseTime: "2026-07-01T00:00:00.000Z",
    status: "ok",
    items: [],
  };
}

function listItem(id: string, receivedTimeMs: number): TelegramListItem {
  const time = new Date(receivedTimeMs).toISOString();
  return {
    serial: 1,
    id,
    classification: "telegram.volcano",
    head: { type: "VFVO50", author: "気象庁", time, test: false, xml: true },
    receivedTime: time,
    xmlReport: {
      control: {
        title: "火山", dateTime: time, status: "通常",
        editorialOffice: "気象庁", publishingOffice: "気象庁",
      },
      head: {
        title: "噴火警報・予報", reportDateTime: time, targetDateTime: time,
        eventId: "volcano-506", serial: "1", infoType: "発表",
        infoKind: "火山", infoKindVersion: "1.0_0", headline: null,
      },
    },
    format: "xml",
    url: `https://data.api.dmdata.jp/v1/${id}`,
  };
}

function volcanoAlert(overrides: Partial<ParsedVolcanoAlertInfo> = {}): ParsedVolcanoAlertInfo {
  return {
    meta: testTelegramMeta(false),
    domain: "volcano", kind: "alert", type: "VFVO50", infoType: "発表",
    title: "噴火警報・予報", reportDateTime: "2026-07-01T00:00:00+09:00",
    eventDateTime: null, headline: null, publishingOffice: "気象庁",
    volcanoName: "桜島", volcanoCode: "506", coordinate: null, isTest: false,
    alertLevel: 3, alertLevelCode: "31", alertClass: null, action: "issue",
    previousLevelCode: null, warningKind: "噴火警報", municipalities: [],
    marineAreas: [], marineWarningKind: null, marineAlertLevelCode: null,
    bodyText: "", preventionText: "", isMarine: false,
    ...overrides,
  };
}

/** 本物の parser と同じく meta を xmlReport.head から組む */
function alertFromXmlReport(msg: WsDataMessage): ParsedVolcanoAlertInfo | null {
  const receivedAtMs = msg.meta?.receivedAtMs;
  const head = msg.xmlReport?.head;
  if (receivedAtMs == null || head == null) return null;
  return volcanoAlert({
    infoType: head.infoType as "発表" | "訂正" | "取消",
    reportDateTime: head.reportDateTime,
    meta: createTelegramMeta({
      messageId: msg.id,
      eventId: head.eventId,
      type: msg.head.type,
      reportDateTime: head.reportDateTime,
      serial: head.serial,
      infoType: head.infoType,
      receivedAtMs,
      status: "通常",
      isTest: false,
    }),
  });
}

function liveMessage(id: string, serverTimeMs: number, localTimeMs: number): WsDataMessage {
  const item = listItem(id, serverTimeMs);
  return normalizeTelegramMessage({
    type: "data",
    version: "2.0",
    classification: item.classification,
    id: item.id,
    passing: [],
    head: item.head,
    xmlReport: {
      ...item.xmlReport!,
      control: { ...item.xmlReport!.control, dateTime: new Date(localTimeMs).toISOString() },
    },
    format: item.format,
    compression: null,
    encoding: "utf-8",
    body: `<Report id="${id}"/>`,
  }, localTimeMs).message;
}

function coordinatorFixture() {
  const gate = new TelegramRevisionGate();
  const holder = new VolcanoStateHolder();
  const standby = new StandbyStateStore();
  standby.replaceVolcanoDerived(holder.snapshot());
  const repair = emptyVolcanoRepairState();
  const admission = new StandbyPersistenceAdmissionCoordinator({
    owners: {
      telegramRevisionGate: gate,
      standbyStateStore: standby,
      vpws50State: new Vpws50StateHolder(),
      vpww56State: new Vpww56StateHolder(),
      tsunamiState: new TsunamiStateHolder(),
      volcanoState: holder,
      floodForecastState: new FloodForecastStateHolder(),
    },
    repairState: repair,
  });
  return { coordinator: new VolcanoTransactionCoordinator(admission), holder, repair };
}

interface Harness {
  restRepair: ReturnType<typeof createVolcanoRestRepair>;
  journal: { current: VolcanoRepairJournal | null };
  coordinator: VolcanoTransactionCoordinator;
  holder: VolcanoStateHolder;
  loadPage: ReturnType<typeof vi.fn>;
  loadBody: ReturnType<typeof vi.fn>;
  backup: ReturnType<typeof vi.fn>;
  schedule: ReturnType<typeof vi.fn>;
  applyRepairState: ReturnType<typeof vi.fn>;
  ack: { current: WsSubscriptionAcknowledgement | null };
  clock: { now: number };
}

/** `completed` を型で確定させてから targets を読む */
function completedTargets(
  result: VolcanoRestRepairResult,
): readonly VolcanoRestRepairTargetOutcome[] {
  if (result.kind !== "completed") throw new Error(`expected completed, got ${result.kind}`);
  return result.targets;
}

const BACKED_UP: VolcanoManualBackupResult = {
  kind: "backedUp",
  files: [{ source: "v2", path: "/tmp/standby.v2.json.1.0.manual-backup", reused: false }],
};

function harness(overrides: {
  loadPage?: ReturnType<typeof vi.fn>;
  loadBody?: ReturnType<typeof vi.fn>;
  backup?: ReturnType<typeof vi.fn>;
} = {}): Harness {
  const { coordinator, holder } = coordinatorFixture();
  const journal: { current: VolcanoRepairJournal | null } = { current: null };
  const ack: { current: WsSubscriptionAcknowledgement | null } = { current: ACK };
  const clock = { now: NOW };
  const loadPage = overrides.loadPage ?? vi.fn(async () => emptyResponse());
  const loadBody = overrides.loadBody
    ?? vi.fn(async (_apiKey: string, id: string) => ({ kind: "ok" as const, xml: `<Report id="${id}"/>` }));
  const backup = overrides.backup ?? vi.fn(() => BACKED_UP);
  const schedule = vi.fn();
  const applyRepairState = vi.fn();
  const restRepair = createVolcanoRestRepair({
    apiKey: "key",
    coordinator,
    getJournal: () => journal.current,
    setJournal: (value) => { journal.current = value; },
    getAcknowledgement: () => ack.current,
    backupCurrentMirrors: backup as unknown as () => VolcanoManualBackupResult,
    applyRepairState,
    scheduleStandbyPersistence: schedule,
    now: () => clock.now,
    loadPage: loadPage as never,
    loadBody: loadBody as never,
  });
  return {
    restRepair, journal, coordinator, holder,
    loadPage, loadBody, backup, schedule, applyRepairState, ack, clock,
  };
}

describe("volcano manual REST repair adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseVolcano.mockImplementation(alertFromXmlReport);
  });

  // spec §14.2 #13
  it("spec §14.2 #13: shared journal が非 null なら busy を返し journal を差し替えない", async () => {
    const h = harness();
    const installed = new VolcanoRepairJournal(ACK, ["vfvo50"]);
    h.journal.current = installed;

    await expect(h.restRepair({ targets: ["vfvo50"], dryRun: false, reason: "r" }))
      .resolves.toEqual({ kind: "busy" });

    expect(h.journal.current).toBe(installed);
    expect(h.backup).not.toHaveBeenCalled();
    expect(h.loadPage).not.toHaveBeenCalled();
  });

  // spec §14.2 #14
  it("spec §14.2 #14: 1 本目が await 中なら 2 本目は busy になる", async () => {
    let release: (() => void) | null = null;
    let call = 0;
    const loadPage = vi.fn(() => {
      call += 1;
      if (call > 1) return Promise.resolve(emptyResponse());
      return new Promise<TelegramListResponse>((resolve) => {
        release = () => resolve(emptyResponse());
      });
    });
    // setJournal を no-op にして「shared journal ではなく in-flight フラグ」だけを見る
    const { coordinator } = coordinatorFixture();
    const restRepair = createVolcanoRestRepair({
      apiKey: "key",
      coordinator,
      getJournal: () => null,
      setJournal: () => { /* shared 変数を追跡しない */ },
      getAcknowledgement: () => ACK,
      backupCurrentMirrors: () => BACKED_UP,
      applyRepairState: vi.fn(),
      scheduleStandbyPersistence: vi.fn(),
      now: () => NOW,
      loadPage: loadPage as never,
    });

    const first = restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" });
    await Promise.resolve();
    await expect(restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" }))
      .resolves.toEqual({ kind: "busy" });

    release!();
    await expect(first).resolves.toMatchObject({ kind: "completed" });
  });

  // spec §14.2 #15
  it("spec §14.2 #15: ack が null なら notConnected を返し REST も backup も出さない", async () => {
    const h = harness();
    h.ack.current = null;

    await expect(h.restRepair({ targets: ["vfvo50"], dryRun: false, reason: "r" }))
      .resolves.toEqual({ kind: "notConnected" });

    expect(h.backup).not.toHaveBeenCalled();
    expect(h.loadPage).not.toHaveBeenCalled();
    expect(h.journal.current).toBeNull();
  });

  // spec §14.2 #16
  it("spec §14.2 #16: 成功経路で journal が install され live ingress が記録される", async () => {
    let installedDuringRun: VolcanoRepairJournal | null = null;
    const loadPage = vi.fn(async () => {
      installedDuringRun = h.journal.current;
      installedDuringRun?.record(
        liveMessage("live-1", NOW - 1_000, NOW + 1_000),
        { ...ACK, receivedAtMs: NOW + 1_000 },
      );
      return emptyResponse();
    });
    const h = harness({ loadPage });

    const result = await h.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" });

    expect(installedDuringRun).not.toBeNull();
    expect(installedDuringRun!.snapshot("vfvo50").map((item) => item.itemId)).toEqual(["live-1"]);
    expect(result).toMatchObject({ kind: "completed", dryRun: true });
    expect(h.journal.current).toBeNull();
  });

  // spec §14.2 #17
  it("spec §14.2 #17: backup 実行中に届いた電文が journal に入り commit へ反映される", async () => {
    let recordedDuringBackup = false;
    const backup = vi.fn(() => {
      // journal install が backup より前であることをここで固定する
      recordedDuringBackup = h.journal.current?.record(
        liveMessage("during-backup", NOW - 2_000, NOW + 2_000),
        { ...ACK, receivedAtMs: NOW + 2_000 },
      ).kind === "recorded";
      return BACKED_UP;
    });
    const h = harness({ backup });

    const result = await h.restRepair({ targets: ["vfvo50"], dryRun: false, reason: "適用" });

    expect(recordedDuringBackup).toBe(true);
    expect(result).toMatchObject({ kind: "completed" });
    expect(completedTargets(result)).toEqual([{ target: "vfvo50", kind: "committed" }]);
    const composites = h.coordinator.snapshot().holder.composites;
    expect(composites.map((composite) => composite.volcanoCode)).toContain("506");
  });

  // spec §14.2 #18 / #19 / §14.6 #59
  it("spec §14.2 #18 #19: 全離脱経路で journal と in-flight が解除される", async () => {
    const cases: { name: string; build: () => Harness }[] = [
      { name: "success", build: () => harness() },
      {
        name: "proofFailure",
        build: () => harness({
          loadPage: vi.fn(async () => { throw new Error("historicalResponseMissingBody"); }),
        }),
      },
      {
        name: "throw",
        build: () => harness({ backup: vi.fn(() => { throw new Error("boom"); }) }),
      },
      { name: "backupFailed", build: () => harness({
        backup: vi.fn(() => ({ kind: "failed" as const, reason: "noMirrorPresent" as const, detail: "x" })),
      }) },
    ];
    for (const testCase of cases) {
      const h = testCase.build();
      try {
        await h.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" });
      } catch {
        // throw 経路でも finally は通る
      }
      expect(h.journal.current, testCase.name).toBeNull();
      // 直後の 2 本目が busy にならない = in-flight が false に戻っている
      h.clock.now += VOLCANO_REST_REPAIR_COOLDOWN_MS;
      const second = await h.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" })
        .catch(() => ({ kind: "threw" as const }));
      expect(second.kind, testCase.name).not.toBe("busy");
    }

    // ack が null / journal ctor throw の 2 経路も同じく解除される
    const nullAck = harness();
    nullAck.ack.current = null;
    await nullAck.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" });
    nullAck.ack.current = ACK;
    expect(nullAck.journal.current).toBeNull();
    await expect(nullAck.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" }))
      .resolves.toMatchObject({ kind: "completed" });

    const badAck = harness();
    badAck.ack.current = { ...ACK, classifications: [] };
    await expect(badAck.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" }))
      .resolves.toEqual({ kind: "notConnected" });
    expect(badAck.journal.current).toBeNull();
  });

  // spec §14.2 #20
  it("spec §14.2 #20: prove await 中の onDisconnected で fail-closed になり解除もされる", async () => {
    const loadPage = vi.fn(async () => {
      // monitor.ts の onDisconnected 相当
      h.journal.current?.failAll("subscriptionDisconnected");
      return emptyResponse();
    });
    const h = harness({ loadPage });
    const before = h.coordinator.snapshot().runtimeVersion;

    const result = await h.restRepair({ targets: ["vfvo50"], dryRun: false, reason: "切断" });

    expect(result).toMatchObject({ kind: "completed" });
    expect(completedTargets(result)[0]!.kind).toBe("failed");
    expect(h.coordinator.snapshot().runtimeVersion).toBe(before);
    expect(h.journal.current).toBeNull();
    expect(h.schedule).not.toHaveBeenCalled();

    // 解除後に次の実行が受理される
    h.clock.now += VOLCANO_REST_REPAIR_COOLDOWN_MS;
    const next = harness();
    await expect(next.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" }))
      .resolves.toMatchObject({ kind: "completed" });
  });

  // spec §14.2 #21
  it("spec §14.2 #21: commit 成功後に派生状態を再計算し schedule を 1 回だけ呼ぶ", async () => {
    const h = harness();

    await h.restRepair({ targets: ["vfvo50"], dryRun: false, reason: "適用" });

    expect(h.schedule).toHaveBeenCalledTimes(1);
    expect(h.applyRepairState).toHaveBeenCalledTimes(1);
    const [repairState, authoritative] = h.applyRepairState.mock.calls[0]!;
    expect(repairState).toEqual(h.coordinator.snapshot().repair);
    expect(authoritative).toBe(volcanoFoundationAuthoritativeFrom(repairState));
    expect(repairState.vfvo50Repairable).toBe(false);
  });

  // spec §14.2 #22
  it("spec §14.2 #22: 全 target 失敗時は schedule を呼ばない", async () => {
    const h = harness({
      loadPage: vi.fn(async () => { throw new Error("historicalResponseMissingBody"); }),
    });

    const result = await h.restRepair({ targets: ["vfvo50"], dryRun: false, reason: "失敗" });

    expect(completedTargets(result)[0]!.kind).toBe("failed");
    expect(h.schedule).not.toHaveBeenCalled();
    expect(h.applyRepairState).not.toHaveBeenCalled();
  });

  // spec §14.2 #23
  it("spec §14.2 #23: クールダウン中の再実行は REST も backup も出さない", async () => {
    const h = harness();
    await h.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" });
    h.backup.mockClear();
    h.loadPage.mockClear();

    h.clock.now += 1_000;
    const result = await h.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" });

    expect(result).toEqual({
      kind: "cooldown",
      remainingMs: VOLCANO_REST_REPAIR_COOLDOWN_MS - 1_000,
    });
    expect(h.backup).not.toHaveBeenCalled();
    expect(h.loadPage).not.toHaveBeenCalled();
  });

  // spec §14.2 #24
  it("spec §14.2 #24: notConnected はクールダウン時計を進めない", async () => {
    const h = harness();
    h.ack.current = null;
    await expect(h.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" }))
      .resolves.toEqual({ kind: "notConnected" });

    h.ack.current = ACK;
    await expect(h.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" }))
      .resolves.toMatchObject({ kind: "completed" });
  });

  // spec §14.2 #25
  it("spec §14.2 #25: backupFailed はクールダウン時計を進めない", async () => {
    let fail = true;
    const backup = vi.fn((): VolcanoManualBackupResult => fail
      ? { kind: "failed", reason: "noMirrorPresent", detail: "x" }
      : BACKED_UP);
    const h = harness({ backup });

    await expect(h.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" }))
      .resolves.toEqual({ kind: "backupFailed", reason: "noMirrorPresent", detail: "x" });

    fail = false;
    await expect(h.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" }))
      .resolves.toMatchObject({ kind: "completed" });
  });

  // spec §14.2 #26
  it("spec §14.2 #26: REST を出した dry-run は終了時刻を記録し直後の再実行が cooldown になる", async () => {
    const h = harness();

    await h.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" });
    expect(h.loadPage).toHaveBeenCalled();

    await expect(h.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" }))
      .resolves.toEqual({ kind: "cooldown", remainingMs: VOLCANO_REST_REPAIR_COOLDOWN_MS });
  });

  // spec §14.6 #58
  it("spec §14.6 #58: backup 失敗時は loadPage / loadBody を 1 回も呼ばない", async () => {
    const h = harness({
      backup: vi.fn(() => ({ kind: "failed" as const, reason: "writeFailed" as const, detail: "EIO" })),
    });

    await expect(h.restRepair({ targets: ["vfvo50", "ashfall"], dryRun: false, reason: "適用" }))
      .resolves.toEqual({ kind: "backupFailed", reason: "writeFailed", detail: "EIO" });

    expect(h.loadPage).not.toHaveBeenCalled();
    expect(h.loadBody).not.toHaveBeenCalled();
  });

  // spec §14.4 #44
  it("spec §14.4 #44: ingress を止めた隔離環境で dry-run が増やすのは .manual-backup だけ", async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "fleq-manual-backup-"));
    const persistPath = join(directory, "standby.json");
    const v2Path = standbyPersistenceV2Path(persistPath);
    fs.writeFileSync(persistPath, '{"v":1}');
    fs.writeFileSync(v2Path, '{"v":2}');
    fs.writeFileSync(join(directory, "standby.json.20260101.0.salvage-backup"), '{"v":1}');
    const persistence = new StandbyPersistence(persistPath);

    const digest = (): Record<string, string> => Object.fromEntries(
      fs.readdirSync(directory).sort().map((name) => [
        name,
        createHash("sha256").update(fs.readFileSync(join(directory, name))).digest("hex"),
      ]),
    );
    const before = digest();

    const { coordinator } = coordinatorFixture();
    const restRepair = createVolcanoRestRepair({
      apiKey: "key",
      coordinator,
      getJournal: () => null,
      setJournal: () => { /* noop */ },
      getAcknowledgement: () => ACK,
      backupCurrentMirrors: () => persistence.backupCurrentMirrors("manual"),
      applyRepairState: vi.fn(),
      scheduleStandbyPersistence: vi.fn(),
      now: () => NOW,
      loadPage: (async () => emptyResponse()) as never,
    });

    const result = await restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" });
    expect(result).toMatchObject({ kind: "completed", dryRun: true });

    const after = digest();
    // (a) 既存ファイルの sha256 が全件一致、(b) 削除・改名が 0 件
    for (const [name, hash] of Object.entries(before)) {
      expect(after[name], name).toBe(hash);
    }
    // (c) 新規ファイルは .manual-backup 拡張子だけ
    const added = Object.keys(after).filter((name) => !(name in before));
    expect(added.length).toBe(2);
    expect(added.every((name) => name.endsWith(".manual-backup"))).toBe(true);

    fs.rmSync(directory, { recursive: true, force: true });
  });

  // spec §14.4 #43（adapter 側）
  it("spec §14.4 #43: dry-run は schedule を 0 回で終え coordinator を変えない", async () => {
    const h = harness();
    const before = JSON.stringify(h.coordinator.snapshot());

    const result = await h.restRepair({ targets: ["vfvo50"], dryRun: true, reason: "" });

    expect(result).toMatchObject({ kind: "completed", dryRun: true });
    expect(h.schedule).not.toHaveBeenCalled();
    expect(h.applyRepairState).not.toHaveBeenCalled();
    expect(JSON.stringify(h.coordinator.snapshot())).toBe(before);
  });
});
