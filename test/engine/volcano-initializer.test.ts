import { testTelegramMeta } from "../helpers/telegram-meta";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchVolcanoHistoricalPaginationUnion,
  proveVolcanoTypeCoverage,
  repairVolcanoState,
  restoreVolcanoState,
  VolcanoRepairJournal,
} from "../../src/engine/startup/volcano-initializer";
import {
  emptyVolcanoRepairState,
  VOLCANO_MAX_SOURCE_EVENT_IDS_PER_COMPOSITE,
  VolcanoStateHolder,
} from "../../src/engine/messages/volcano-state";
import { StandbyStateStore } from "../../src/engine/display/standby-state-store";
import { StandbyPersistenceAdmissionCoordinator } from "../../src/engine/display/standby-persistence-admission";
import { FloodForecastStateHolder } from "../../src/engine/messages/flood-forecast-state";
import { TsunamiStateHolder } from "../../src/engine/messages/tsunami-state";
import { VolcanoTransactionCoordinator } from "../../src/engine/messages/volcano-transaction-coordinator";
import { Vpws50StateHolder } from "../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../src/engine/messages/vpww56-state";
import { createTelegramMeta } from "../../src/dmdata/telegram-meta";
import { normalizeTelegramMessage } from "../../src/dmdata/telegram-ingress";
import {
  volcanoRevisionFamilyPolicy,
} from "../../src/engine/messages/revision-family-registry";
import {
  semanticPayloadFingerprint,
  telegramRevisionSemanticKey,
  TelegramRevisionGate,
  type TelegramRevisionGateInput,
} from "../../src/engine/messages/telegram-revision-gate";
import * as restClient from "../../src/dmdata/rest-client";
import {
  ParsedVolcanoAshfallInfo,
  ParsedVolcanoAlertInfo,
  TelegramListItem,
  TelegramListResponse,
  WsDataMessage,
} from "../../src/types";
import type {
  WsSubscriptionAcknowledgement,
  WsTransportIdentity,
} from "../../src/dmdata/ws-client";

// sound-player をモック
vi.mock("../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

// rest-client をモック
vi.mock("../../src/dmdata/rest-client");

// volcano-parser ごとモック (XML 処理は volcano-parser 自身のテストの責務)
vi.mock("../../src/dmdata/volcano-parser", () => ({
  parseVolcanoTelegram: vi.fn(),
}));

import { parseVolcanoTelegram } from "../../src/dmdata/volcano-parser";

const mockListTelegrams = vi.mocked(restClient.listTelegrams);
const mockParseVolcano = vi.mocked(parseVolcanoTelegram);

/** テスト用 TelegramListItem を生成 (id と head.time で電文を区別する) */
function createTelegramItem(
  id: string,
  time: string,
  overrides: Partial<TelegramListItem> = {}
): TelegramListItem {
  return {
    serial: 1,
    id,
    classification: "telegram.volcano",
    head: {
      type: "VFVO50",
      author: "気象庁",
      time,
      test: false,
      xml: true,
    },
    format: "xml",
    compression: "gzip",
    encoding: "base64",
    body: "dGVzdA==",
    ...overrides,
  };
}

/** テスト用レスポンスを生成 */
function createResponse(items: TelegramListItem[]): TelegramListResponse {
  return {
    responseId: "test-response",
    responseTime: "2026-07-01T00:00:00.000Z",
    status: "ok",
    items,
  };
}

/** テスト用 ParsedVolcanoAlertInfo を生成 */
function createVolcanoAlert(
  overrides: Partial<ParsedVolcanoAlertInfo> = {}
): ParsedVolcanoAlertInfo {
  return {
    meta: testTelegramMeta(false),
    domain: "volcano",
    kind: "alert",
    type: "VFVO50",
    infoType: "発表",
    title: "噴火警報・予報",
    reportDateTime: "2026-07-01T00:00:00+09:00",
    eventDateTime: null,
    headline: null,
    publishingOffice: "気象庁",
    volcanoName: "桜島",
    volcanoCode: "506",
    coordinate: null,
    isTest: false,
    alertLevel: 3,
    alertLevelCode: "31",
    alertClass: null,
    action: "issue",
    previousLevelCode: null,
    warningKind: "噴火警報",
    municipalities: [],
    marineAreas: [],
    marineWarningKind: null,
    marineAlertLevelCode: null,
    bodyText: "",
    preventionText: "",
    isMarine: false,
    ...overrides,
  };
}

function createFoundationAlert(
  id: string,
  reportDateTime: string,
  serial: string,
  overrides: Partial<ParsedVolcanoAlertInfo> = {},
): ParsedVolcanoAlertInfo {
  const infoType = (overrides.infoType ?? "発表") as "発表" | "訂正" | "取消";
  return createVolcanoAlert({
    ...overrides,
    infoType,
    reportDateTime,
    meta: createTelegramMeta({
      messageId: id,
      eventId: "volcano-506",
      type: "VFVO50",
      reportDateTime,
      serial,
      infoType,
      receivedAtMs: Date.parse(reportDateTime),
      status: "通常",
      isTest: false,
    }),
  });
}

function foundationInput(info: ParsedVolcanoAlertInfo): TelegramRevisionGateInput {
  const policy = volcanoRevisionFamilyPolicy(info.type)!;
  const subject = policy.extractStateSubjectKey(info.meta, info);
  if (typeof subject !== "string") throw new Error("expected one volcano subject");
  const { meta: _meta, isTest: _isTest, ...payload } = info;
  return {
    domain: policy.domain,
    revisionFamily: policy.revisionFamily,
    stateSubjectKey: subject,
    meta: info.meta,
    comparator: policy.comparator,
    cancellationPolicy: policy.cancellationPolicy,
    terminal: policy.terminalPredicate(info.meta, info),
    deactivation: policy.deactivationPredicate(info.meta, info),
    cancellationTargetMatches: true,
    durable: policy.durable,
    tombstoneRetentionMs: policy.tombstoneRetentionMs,
    maxSubjects: policy.maxSubjects,
    allowMissingSerial: policy.allowMissingSerial,
    payloadFingerprint: semanticPayloadFingerprint(payload),
    volcanoProvenance: { kind: "alert", sourceFamily: "VFVO50" },
  };
}

/** id → ParsedVolcanoAlertInfo の対応でパーサモックを構成する */
function mockParserByIds(infoById: Record<string, ParsedVolcanoAlertInfo | null>): void {
  mockParseVolcano.mockImplementation((msg: WsDataMessage) => infoById[msg.id] ?? null);
}

describe("restoreVolcanoState", () => {
  let volcanoState: VolcanoStateHolder;

  beforeEach(() => {
    volcanoState = new VolcanoStateHolder();
    vi.clearAllMocks();
  });

  it("複数火山の警報が窓に混在 → 両火山とも復元される", async () => {
    // API は新しい順で返す想定
    const items = [
      createTelegramItem("tg-asama", "2026-07-02T00:00:00+09:00"),
      createTelegramItem("tg-sakura", "2026-07-01T00:00:00+09:00"),
    ];
    mockListTelegrams.mockResolvedValue(createResponse(items));
    mockParserByIds({
      "tg-sakura": createVolcanoAlert({ volcanoCode: "506", volcanoName: "桜島" }),
      "tg-asama": createVolcanoAlert({ volcanoCode: "306", volcanoName: "浅間山", alertLevel: 2, alertLevelCode: "22" }),
    });

    await restoreVolcanoState("test-key", volcanoState);

    expect(volcanoState.size()).toBe(2);
    expect(volcanoState.getEntry("506")).toBeDefined();
    expect(volcanoState.getEntry("306")).toBeDefined();
    expect(mockListTelegrams).toHaveBeenCalledWith("test-key", "VFVO50", 100);
  });

  it("同一火山の発表→解除が窓に含まれる → entries に残らない (昇順 replay の検証)", async () => {
    // 新しい順の返却: 解除 (t2) が先頭、発表 (t1) が後ろ。
    // ソートせず返却順のまま replay すると「解除→発表」の順になり警報が残ってしまう
    const items = [
      createTelegramItem("tg-release", "2026-07-02T00:00:00+09:00"),
      createTelegramItem("tg-issue", "2026-07-01T00:00:00+09:00"),
    ];
    mockListTelegrams.mockResolvedValue(createResponse(items));
    mockParserByIds({
      "tg-issue": createVolcanoAlert({ volcanoCode: "506" }),
      "tg-release": createVolcanoAlert({ volcanoCode: "506", action: "release", alertLevel: 1, alertLevelCode: "11" }),
    });

    await restoreVolcanoState("test-key", volcanoState);

    expect(volcanoState.size()).toBe(0);
    expect(volcanoState.getEntry("506")).toBeUndefined();
  });

  it("途中の電文に body がない → skip して他火山は復元される", async () => {
    const items = [
      createTelegramItem("tg-broken", "2026-07-02T00:00:00+09:00", { body: undefined }),
      createTelegramItem("tg-sakura", "2026-07-01T00:00:00+09:00"),
    ];
    mockListTelegrams.mockResolvedValue(createResponse(items));
    mockParserByIds({
      "tg-sakura": createVolcanoAlert({ volcanoCode: "506" }),
    });

    await restoreVolcanoState("test-key", volcanoState);

    expect(volcanoState.size()).toBe(1);
    expect(volcanoState.getEntry("506")).toBeDefined();
    // body なしの電文はパーサまで到達しない
    expect(mockParseVolcano).toHaveBeenCalledTimes(1);
  });

  it("途中の電文がパース不能 → skip して他火山は復元される", async () => {
    const items = [
      createTelegramItem("tg-unparsable", "2026-07-02T00:00:00+09:00"),
      createTelegramItem("tg-sakura", "2026-07-01T00:00:00+09:00"),
    ];
    mockListTelegrams.mockResolvedValue(createResponse(items));
    mockParserByIds({
      "tg-sakura": createVolcanoAlert({ volcanoCode: "506" }),
      "tg-unparsable": null,
    });

    await restoreVolcanoState("test-key", volcanoState);

    expect(volcanoState.size()).toBe(1);
    expect(volcanoState.getEntry("506")).toBeDefined();
  });

  it("窓内に Lv3 発表 → Lv1 引下げ (lower) → entries に残らない", async () => {
    const items = [
      createTelegramItem("tg-lower", "2026-07-02T00:00:00+09:00"),
      createTelegramItem("tg-issue3", "2026-07-01T00:00:00+09:00"),
    ];
    mockListTelegrams.mockResolvedValue(createResponse(items));
    mockParserByIds({
      "tg-issue3": createVolcanoAlert({ volcanoCode: "506" }),
      "tg-lower": createVolcanoAlert({ volcanoCode: "506", action: "lower", alertLevel: 1, alertLevelCode: "11" }),
    });

    await restoreVolcanoState("test-key", volcanoState);

    expect(volcanoState.size()).toBe(0);
  });

  it("VFVO50 電文が 0 件 → 何もせず正常終了", async () => {
    mockListTelegrams.mockResolvedValue(createResponse([]));

    await restoreVolcanoState("test-key", volcanoState);

    expect(volcanoState.size()).toBe(0);
  });

  it("API エラー → 例外を throw せず状態は空のまま", async () => {
    mockListTelegrams.mockRejectedValue(new Error("API error"));

    await expect(
      restoreVolcanoState("test-key", volcanoState)
    ).resolves.toBe("failed");
    expect(volcanoState.size()).toBe(0);
  });

  it("persisted 取消 tombstone を REST の取消前報で復活させない", async () => {
    const gate = new TelegramRevisionGate();
    const issue = createFoundationAlert("issue", new Date(Date.now() - 120_000).toISOString(), "1");
    const cancel = createFoundationAlert("cancel", new Date(Date.now() - 60_000).toISOString(), "2", {
      infoType: "取消",
      action: "cancel",
    });
    expect(gate.decide(foundationInput(issue)).accepted).toBe(true);
    expect(gate.decide(foundationInput(cancel)).kind).toBe("clearCurrent");
    mockListTelegrams.mockResolvedValue(createResponse([
      createTelegramItem("rest-old", issue.reportDateTime),
    ]));
    mockParserByIds({ "rest-old": { ...issue, meta: { ...issue.meta, messageId: "rest-old" } } });

    expect(await restoreVolcanoState("test-key", volcanoState, gate, true)).toBe("success");

    expect(volcanoState.getEntry("506")).toBeUndefined();
    expect(gate.exportDurableEntries()).toEqual([
      expect.objectContaining({
        domain: "volcano",
        revisionFamily: "volcanoAlert",
        stateSubjectKey: "volcano:alert:506",
        cancelled: true,
      }),
    ]);
  });

  it("persisted active と semantic 一致する REST 報だけで空 holder を再構成する", async () => {
    const gate = new TelegramRevisionGate();
    const active = createFoundationAlert("active", "2026-07-01T00:00:00+09:00", "1");
    expect(gate.decide(foundationInput(active)).accepted).toBe(true);
    mockListTelegrams.mockResolvedValue(createResponse([
      createTelegramItem("rest-active", active.reportDateTime),
    ]));
    mockParserByIds({ "rest-active": { ...active, meta: { ...active.meta, messageId: "rest-active" } } });

    expect(await restoreVolcanoState("test-key", volcanoState, gate, true)).toBe("success");

    expect(volcanoState.getEntry("506")).toMatchObject({ alertLevel: 3 });
  });
});

const REPAIR_NOW = Date.parse("2026-07-10T00:00:00.000Z");
const REPAIR_RETENTION_MS = 24 * 60 * 60_000;
const REPAIR_ACK: WsSubscriptionAcknowledgement = {
  subscriptionGeneration: 1,
  socketId: 42,
  transportId: "socket:42:generation:1",
  acknowledgedAtMs: REPAIR_NOW - 60_000,
  classifications: ["telegram.volcano"],
};

function mockNormalizedAlertParser(): void {
  mockParseVolcano.mockImplementation((msg: WsDataMessage) => {
    const receivedAtMs = msg.meta?.receivedAtMs;
    if (receivedAtMs == null) return null;
    const reportDateTime = new Date(receivedAtMs).toISOString();
    return createFoundationAlert(msg.id, reportDateTime, "1", {
      meta: createTelegramMeta({
        messageId: msg.id,
        eventId: "volcano-506",
        type: "VFVO50",
        reportDateTime,
        serial: "1",
        infoType: "発表",
        receivedAtMs,
        status: "通常",
        isTest: false,
      }),
    });
  });
}

function repairItem(id: string, receivedTimeMs: number): TelegramListItem {
  return createTelegramItem(id, new Date(receivedTimeMs).toISOString());
}

function repairAshfallItem(
  id: string,
  receivedTimeMs: number,
  headType: "VFVO54" | "VFVO55",
): TelegramListItem {
  const item = repairItem(id, receivedTimeMs);
  return { ...item, head: { ...item.head, type: headType } };
}

function createRepairAshfallCancellation(
  id: string,
  receivedTimeMs: number,
): ParsedVolcanoAshfallInfo {
  const reportDateTime = new Date(receivedTimeMs).toISOString();
  return {
    meta: createTelegramMeta({
      messageId: id,
      eventId: "volcano-506",
      type: "VFVO54",
      reportDateTime,
      serial: "1",
      infoType: "取消",
      receivedAtMs: receivedTimeMs,
      status: "通常",
      isTest: false,
    }),
    domain: "volcano",
    kind: "ashfall",
    type: "VFVO54",
    subKind: "rapid",
    infoType: "取消",
    title: "降灰予報（速報）",
    reportDateTime,
    eventDateTime: null,
    headline: null,
    publishingOffice: "気象庁",
    volcanoName: "桜島",
    volcanoCode: "506",
    coordinate: null,
    isTest: false,
    craterName: null,
    ashForecasts: [],
    plumeHeight: null,
    plumeDirection: null,
    bodyText: "",
  };
}

function liveRepairMessage(id: string, serverTimeMs: number, localTimeMs: number): WsDataMessage {
  const item = repairItem(id, serverTimeMs);
  return normalizeTelegramMessage({
    type: "data",
    version: "2.0",
    classification: item.classification,
    id: item.id,
    passing: [],
    head: item.head,
    xmlReport: {
      control: {
        title: "火山",
        dateTime: new Date(localTimeMs).toISOString(),
        status: "通常",
        editorialOffice: "気象庁",
        publishingOffice: "気象庁",
      },
      head: {
        title: "噴火警報・予報",
        reportDateTime: new Date(localTimeMs).toISOString(),
        targetDateTime: new Date(localTimeMs).toISOString(),
        eventId: "volcano-506",
        serial: "1",
        infoType: "発表",
        infoKind: "火山",
        infoKindVersion: "1.0_0",
        headline: null,
      },
    },
    format: item.format,
    compression: item.compression,
    encoding: item.encoding,
    body: item.body!,
  }, localTimeMs).message;
}

describe("volcano REST repair coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNormalizedAlertParser();
  });

  it("includes the exact lower boundary and follows an opaque cursor until an older sentinel", async () => {
    const boundary = REPAIR_NOW - REPAIR_RETENTION_MS;
    const loadPage = vi.fn()
      .mockResolvedValueOnce({
        ...createResponse([
          repairItem("newer", boundary + 1),
          repairItem("boundary", boundary),
        ]),
        nextToken: "opaque-token",
      })
      .mockResolvedValueOnce(createResponse([
        repairItem("older-sentinel", boundary - 1),
      ]));

    const result = await fetchVolcanoHistoricalPaginationUnion({
      apiKey: "key",
      headType: "VFVO50",
      startupNowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      loadPage,
    });

    expect(result.pages).toBe(2);
    expect(result.items.map((item) => item.itemId)).toEqual(["newer", "boundary"]);
    expect(loadPage).toHaveBeenNthCalledWith(2, "key", {
      type: "VFVO50",
      limit: 100,
      formatMode: "raw",
      cursorToken: "opaque-token",
    });
  });

  it("continues through an empty page and rejects repeated cursor tokens", async () => {
    const loadPage = vi.fn()
      .mockResolvedValueOnce({ ...createResponse([]), nextToken: "same-token" })
      .mockResolvedValueOnce({ ...createResponse([]), nextToken: "same-token" });

    await expect(fetchVolcanoHistoricalPaginationUnion({
      apiKey: "key",
      headType: "VFVO50",
      startupNowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      loadPage,
    })).rejects.toThrow("historicalNextTokenLoop");
  });

  it("rejects a historical response that exceeds the requested 100-item page", async () => {
    const items = Array.from({ length: 101 }, (_, index) =>
      repairItem(`history-${index}`, REPAIR_NOW - index));
    await expect(fetchVolcanoHistoricalPaginationUnion({
      apiKey: "key",
      headType: "VFVO50",
      startupNowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      loadPage: vi.fn().mockResolvedValue(createResponse(items)),
    })).rejects.toThrow("historicalPageSizeExceeded");
  });

  it("rejects a head response that exceeds the requested 100-item page", async () => {
    const items = Array.from({ length: 101 }, (_, index) =>
      repairItem(`head-${index}`, REPAIR_NOW - index));
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]);
    await expect(proveVolcanoTypeCoverage({
      apiKey: "key",
      headType: "VFVO50",
      startupNowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      loadPage: vi.fn().mockResolvedValue(createResponse(items)),
    })).rejects.toThrow("headPageLimitExceeded");
  });

  it("fails when the first relevant head item is absent from history and journal", async () => {
    const head = repairItem("head-only", REPAIR_NOW - 1_000);
    const loadPage = vi.fn()
      .mockResolvedValueOnce(createResponse([head]))
      .mockResolvedValueOnce(createResponse([]));
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]);

    await expect(proveVolcanoTypeCoverage({
      apiKey: "key",
      headType: "VFVO50",
      startupNowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      loadPage,
    })).rejects.toThrow("lowerCoverageHeadGap");
  });

  it("refreshes journal evidence after each awaited head request", async () => {
    const first = repairItem("first", REPAIR_NOW - 2_000);
    const arrived = repairItem("arrived", REPAIR_NOW - 1_000);
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]);
    const localReceipt = REPAIR_NOW + 30_000;
    const transport: WsTransportIdentity = { ...REPAIR_ACK, receivedAtMs: localReceipt };
    let call = 0;
    const loadPage = vi.fn(async () => {
      call += 1;
      if (call === 1) return createResponse([first]);
      if (call === 2) return createResponse([first]);
      if (call === 3) {
        expect(journal.record(
          liveRepairMessage("arrived", REPAIR_NOW - 1_000, localReceipt),
          transport,
        )).toEqual({ kind: "recorded" });
      }
      return createResponse([arrived, first]);
    });

    await expect(proveVolcanoTypeCoverage({
      apiKey: "key",
      headType: "VFVO50",
      startupNowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      loadPage,
    })).resolves.toMatchObject({ headSamples: 3 });
  });

  it("fails target proof on an invalid journal transport ID without parsing it", () => {
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]);
    const localReceipt = REPAIR_NOW + 1;
    const message = liveRepairMessage("valid-id", REPAIR_NOW, localReceipt);
    const invalid = { ...message, id: "bad\nid", meta: { ...message.meta!, messageId: "bad\nid" } };
    mockParseVolcano.mockClear();

    expect(journal.record(invalid, { ...REPAIR_ACK, receivedAtMs: localReceipt })).toEqual({
      kind: "proofFailed",
      target: "vfvo50",
      reason: "targetTransportInvalid",
    });
    expect(mockParseVolcano).not.toHaveBeenCalled();
  });

  it("uses the first journal sequence and fails an inconsistent repeated transport ID", () => {
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]);
    const localReceipt = REPAIR_NOW + 1;
    const transport: WsTransportIdentity = { ...REPAIR_ACK, receivedAtMs: localReceipt };
    const message = liveRepairMessage("repeat-id", REPAIR_NOW, localReceipt);

    expect(journal.record(message, transport)).toEqual({ kind: "recorded" });
    expect(journal.record(message, transport)).toEqual({ kind: "duplicate" });
    expect(journal.snapshot("vfvo50")).toHaveLength(1);
    expect(journal.record({ ...message, body: "different-body" }, transport)).toEqual({
      kind: "proofFailed",
      target: "vfvo50",
      reason: "transportInconsistency",
    });
    expect(mockParseVolcano).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes REST and journal source transport IDs before proof identity", async () => {
    const decomposed = "source-e\u0301";
    const canonical = "source-é";
    const localReceipt = REPAIR_NOW + 1;
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]);
    const live = liveRepairMessage(`  ${decomposed}  `, REPAIR_NOW, localReceipt);

    expect(journal.record(live, { ...REPAIR_ACK, receivedAtMs: localReceipt }))
      .toEqual({ kind: "recorded" });
    expect(journal.snapshot("vfvo50")[0]).toMatchObject({
      itemId: canonical,
      normalizedInput: { sourceEventId: canonical },
    });

    const historical = await fetchVolcanoHistoricalPaginationUnion({
      apiKey: "key",
      headType: "VFVO50",
      startupNowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      loadPage: vi.fn().mockResolvedValue(createResponse([
        repairItem(` ${decomposed} `, REPAIR_NOW),
      ])),
    });
    expect(historical.items[0]).toMatchObject({
      itemId: canonical,
      normalizedInput: { sourceEventId: canonical },
    });
  });

  it("rebases complete VFVO50 coverage onto a safe current VFVO50 baseline", async () => {
    const current = createFoundationAlert(
      "baseline-live",
      "2026-07-09T23:00:00.000Z",
      "7",
    );
    const gate = new TelegramRevisionGate();
    const gateInput = foundationInput(current);
    expect(gate.decide(gateInput).accepted).toBe(true);
    const holder = new VolcanoStateHolder();
    expect(holder.applyAcceptedAlert(current, {
      sourceEventId: "baseline-live",
      revision: {
        reportTimeMs: current.meta.reportDateTime.epochMs!,
        serial: current.meta.serial.raw,
      },
      appliedSemanticKey: telegramRevisionSemanticKey(gateInput),
    })).toBe(true);
    const standby = new StandbyStateStore();
    standby.replaceVolcanoDerived(holder.snapshot());
    const repair = emptyVolcanoRepairState();
    repair.vfvo50Repairable = true;
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
    const coordinator = new VolcanoTransactionCoordinator(admission);
    const before = coordinator.snapshot();
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]);

    await expect(repairVolcanoState({
      apiKey: "key",
      startupNowMs: REPAIR_NOW,
      coordinator,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      // first head, historical terminal, and stable second head are all empty.
      loadPage: vi.fn().mockResolvedValue(createResponse([])),
    })).resolves.toEqual({ targets: [{ target: "vfvo50", kind: "committed" }] });

    const after = coordinator.snapshot();
    const { version: _beforeHolderVersion, ...beforeHolder } = before.holder;
    const { version: _afterHolderVersion, ...afterHolder } = after.holder;
    expect(afterHolder).toEqual(beforeHolder);
    const { version: _beforeGateVersion, ...beforeGates } = before.gates;
    const { version: _afterGateVersion, ...afterGates } = after.gates;
    expect(afterGates).toEqual(beforeGates);
    expect(after.repair).toEqual({ ...before.repair, vfvo50Repairable: false });
  });

  it("rejects an ashfall REST cancellation when another slice keeps saturated lineage", async () => {
    const current = createFoundationAlert(
      "baseline-alert",
      "2026-07-09T23:00:00.000Z",
      "7",
    );
    const gate = new TelegramRevisionGate();
    const gateInput = foundationInput(current);
    expect(gate.decide(gateInput).accepted).toBe(true);
    const holder = new VolcanoStateHolder();
    expect(holder.applyAcceptedAlert(current, {
      sourceEventId: "baseline-alert",
      revision: {
        reportTimeMs: current.meta.reportDateTime.epochMs!,
        serial: current.meta.serial.raw,
      },
      appliedSemanticKey: telegramRevisionSemanticKey(gateInput),
    })).toBe(true);
    const saturated = holder.snapshot();
    saturated.composites[0]!.sourceEventIds = [
      "baseline-alert",
      ...Array.from(
        { length: VOLCANO_MAX_SOURCE_EVENT_IDS_PER_COMPOSITE - 1 },
        (_, index) => `repair-source-${index.toString().padStart(4, "0")}`,
      ),
    ].sort();
    holder.replacePrevalidated(saturated);
    const standby = new StandbyStateStore();
    standby.replaceVolcanoDerived(holder.snapshot());
    const repair = emptyVolcanoRepairState();
    repair.ashfallRepairable = true;
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
    const coordinator = new VolcanoTransactionCoordinator(admission);
    const before = coordinator.snapshot();
    const cancellationId = "ashfall-rest-cancellation";
    const cancellation = repairAshfallItem(cancellationId, REPAIR_NOW - 1_000, "VFVO54");
    mockParseVolcano.mockImplementation((msg) => msg.id === cancellationId
      ? createRepairAshfallCancellation(cancellationId, REPAIR_NOW - 1_000)
      : null);
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["ashfall"]);
    const loadPage = vi.fn(async (_apiKey, query) => createResponse(
      query.type === "VFVO54" ? [cancellation] : [],
    ));

    await expect(repairVolcanoState({
      apiKey: "key",
      startupNowMs: REPAIR_NOW,
      coordinator,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      loadPage,
    })).resolves.toEqual({
      targets: [{ target: "ashfall", kind: "failed", reason: "ashfallReplayRejected" }],
    });
    expect(coordinator.snapshot()).toEqual(before);
  });
});
