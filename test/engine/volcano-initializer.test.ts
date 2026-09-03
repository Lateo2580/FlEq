import { readFileSync } from "node:fs";
import { testTelegramMeta } from "../helpers/telegram-meta";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchVolcanoHistoricalPaginationUnion,
  proveVolcanoTypeCoverage,
  repairVolcanoState,
  VolcanoRepairJournal,
  type VolcanoStartupRepairResult,
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

type TelegramListXmlHead = NonNullable<TelegramListItem["xmlReport"]>["head"];

/**
 * テスト用 TelegramListItem を生成 (id と head.time で電文を区別する)。
 *
 * 実 API の一覧応答に合わせて `body` / `compression` / `encoding` を**持たない**。
 * 本文は Telegram Data v1 (`url`) から取る。
 */
function createTelegramItem(
  id: string,
  time: string,
  overrides: Partial<TelegramListItem> = {},
  xmlHead: Partial<TelegramListXmlHead> = {},
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
    receivedTime: time,
    xmlReport: {
      control: {
        title: "火山",
        dateTime: time,
        status: "通常",
        editorialOffice: "気象庁",
        publishingOffice: "気象庁",
      },
      head: {
        title: "噴火警報・予報",
        reportDateTime: time,
        targetDateTime: time,
        eventId: "volcano-506",
        serial: "1",
        infoType: "発表",
        infoKind: "火山",
        infoKindVersion: "1.0_0",
        headline: null,
        ...xmlHead,
      },
    },
    format: "xml",
    url: `https://data.api.dmdata.jp/v1/${id}`,
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

const REPAIR_NOW = Date.parse("2026-07-10T00:00:00.000Z");
const REPAIR_RETENTION_MS = 24 * 60 * 60_000;
const REPAIR_ACK: WsSubscriptionAcknowledgement = {
  subscriptionGeneration: 1,
  socketId: 42,
  transportId: "socket:42:generation:1",
  acknowledgedAtMs: REPAIR_NOW - 60_000,
  classifications: ["telegram.volcano"],
};

/**
 * 本物の `parseVolcanoTelegram` と同じく、meta を **body ではなく xmlReport.head から**
 * 組む (`normalizeTelegramMessage` の性質)。identity 段の fingerprint と
 * commit 段の fingerprint が一致する条件をテスト側でも守るため。
 */
function alertFromXmlReport(msg: WsDataMessage): ParsedVolcanoAlertInfo | null {
  const receivedAtMs = msg.meta?.receivedAtMs;
  const head = msg.xmlReport?.head;
  if (receivedAtMs == null || head == null) return null;
  // createFoundationAlert は meta を自前で組み直すので使えない (head 値が消える)
  return createVolcanoAlert({
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

function mockNormalizedAlertParser(): void {
  mockParseVolcano.mockImplementation(alertFromXmlReport);
}

/** 本文取得モック: id ごとに区別できる XML を返す */
function mockBodyLoader() {
  return vi.fn(async (
    _apiKey: string,
    id: string,
    _expectedUrl?: string,
  ): Promise<restClient.TelegramBodyResult> => ({
    kind: "ok",
    xml: `<Report id="${id}"/>`,
  }));
}

function repairItem(
  id: string,
  receivedTimeMs: number,
  xmlHead: Partial<TelegramListXmlHead> = {},
): TelegramListItem {
  return createTelegramItem(id, new Date(receivedTimeMs).toISOString(), {}, xmlHead);
}

function repairAshfallItem(
  id: string,
  receivedTimeMs: number,
  headType: "VFVO54" | "VFVO55",
  xmlHead: Partial<TelegramListXmlHead> = {},
): TelegramListItem {
  const item = repairItem(id, receivedTimeMs, xmlHead);
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

/**
 * WS 由来の同一電文。`xmlReport.head` は REST 一覧と同じ値でなければならない
 * (発表時刻は配信経路によらず同じ)。localTimeMs は受信ローカル時刻だけに効く。
 */
function liveRepairMessage(
  id: string,
  serverTimeMs: number,
  localTimeMs: number,
  xmlHead: Partial<TelegramListXmlHead> = {},
): WsDataMessage {
  const item = repairItem(id, serverTimeMs, xmlHead);
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
      nowMs: REPAIR_NOW,
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
      nowMs: REPAIR_NOW,
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
      nowMs: REPAIR_NOW,
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
      nowMs: REPAIR_NOW,
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
      nowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      loadPage,
      loadBody: mockBodyLoader(),
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
      nowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      loadPage,
      loadBody: mockBodyLoader(),
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
      nowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      loadPage: vi.fn().mockResolvedValue(createResponse([
        repairItem(` ${decomposed} `, REPAIR_NOW),
      ])),
    });
    expect(historical.items[0]).toMatchObject({ itemId: canonical });

    // 本文取得を通した commit 入力側でも canonical id が使われる
    const proof = await proveVolcanoTypeCoverage({
      apiKey: "key",
      headType: "VFVO50",
      nowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]),
      getAcknowledgement: () => REPAIR_ACK,
      loadPage: vi.fn().mockResolvedValue(createResponse([
        repairItem(` ${decomposed} `, REPAIR_NOW),
      ])),
      loadBody: mockBodyLoader(),
    });
    expect(proof.historical.items[0]).toMatchObject({
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
      nowMs: REPAIR_NOW,
      coordinator,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      // first head, historical terminal, and stable second head are all empty.
      loadPage: vi.fn().mockResolvedValue(createResponse([])),
      loadBody: mockBodyLoader(),
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
    const cancellation = repairAshfallItem(cancellationId, REPAIR_NOW - 1_000, "VFVO54", {
      infoType: "取消",
    });
    mockParseVolcano.mockImplementation((msg) => msg.id === cancellationId
      ? createRepairAshfallCancellation(cancellationId, REPAIR_NOW - 1_000)
      : null);
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["ashfall"]);
    const loadPage = vi.fn(async (_apiKey, query) => createResponse(
      query.type === "VFVO54" ? [cancellation] : [],
    ));

    await expect(repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW,
      coordinator,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      loadPage,
      loadBody: mockBodyLoader(),
    })).resolves.toEqual({
      targets: [{ target: "ashfall", kind: "failed", reason: "ashfallReplayRejected" }],
    });
    expect(coordinator.snapshot()).toEqual(before);
  });
});

// ── 実採取した /v2/telegram 応答 (2026-09-02, xmlReport=true) ──
// 一覧 API は本文を返さない。この形を試験で固定しておかないと、
// 「一覧に body がある」前提の実装が再び緑のまま通る。
function readRestFixture(name: string): TelegramListResponse {
  // vitest は repo ルートを cwd にして走る
  return JSON.parse(
    readFileSync(`test/fixtures/rest/${name}`, "utf8"),
  ) as TelegramListResponse;
}

const REAL_LIST_FIXTURES = {
  VFVO50: readRestFixture("telegram-list-vfvo50-real.json"),
  VFVO54: readRestFixture("telegram-list-vfvo54-real.json"),
  VFVO55: readRestFixture("telegram-list-vfvo55-real.json"),
} as const;

const REAL_FIXTURE_NOW = Date.parse("2026-09-02T13:00:00.000Z");
const REAL_FIXTURE_RETENTION_MS = 40 * 24 * 60 * 60_000;

function ashfallFromXmlReport(msg: WsDataMessage): ParsedVolcanoAshfallInfo {
  const head = msg.xmlReport!.head;
  return {
    meta: createTelegramMeta({
      messageId: msg.id,
      eventId: head.eventId,
      type: msg.head.type,
      reportDateTime: head.reportDateTime,
      serial: head.serial,
      infoType: head.infoType,
      receivedAtMs: msg.meta!.receivedAtMs,
      status: "通常",
      isTest: false,
    }),
    domain: "volcano",
    kind: "ashfall",
    type: msg.head.type as "VFVO54" | "VFVO55",
    subKind: msg.head.type === "VFVO54" ? "rapid" : "detailed",
    infoType: "発表",
    title: "降灰予報",
    reportDateTime: head.reportDateTime,
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

describe("volcano REST repair against real telegram list responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fixes that the real telegram list carries no body, compression, or encoding", () => {
    for (const response of Object.values(REAL_LIST_FIXTURES)) {
      expect(response.items.length).toBeGreaterThan(0);
      for (const item of response.items) {
        expect(item).not.toHaveProperty("body");
        expect(item).not.toHaveProperty("compression");
        expect(item).not.toHaveProperty("encoding");
        expect(item.url).toMatch(/^https:\/\/data\.api\.dmdata\.jp\/v1\//);
        expect(item.xmlReport?.head.reportDateTime).toEqual(expect.any(String));
      }
    }
  });

  it.each(["VFVO50", "VFVO54", "VFVO55"] as const)(
    "proves %s coverage from the real list page and loads every body from its url",
    async (headType) => {
      mockParseVolcano.mockImplementation((msg) => headType === "VFVO50"
        ? alertFromXmlReport(msg)
        : ashfallFromXmlReport(msg));
      const response = REAL_LIST_FIXTURES[headType];
      const loadBody = mockBodyLoader();

      const proof = await proveVolcanoTypeCoverage({
        apiKey: "key",
        headType,
        nowMs: REAL_FIXTURE_NOW,
        retentionMs: REAL_FIXTURE_RETENTION_MS,
        journal: new VolcanoRepairJournal(REPAIR_ACK, [
          headType === "VFVO50" ? "vfvo50" : "ashfall",
        ]),
        getAcknowledgement: () => REPAIR_ACK,
        loadPage: vi.fn().mockResolvedValue(response),
        loadBody,
      });

      expect(proof.historical.items.map((item) => item.itemId))
        .toEqual(response.items.map((item) => item.id));
      expect(loadBody.mock.calls.map((call) => [call[1], call[2]]))
        .toEqual(response.items.map((item) => [item.id, item.url]));
    },
  );
});

describe("volcano REST repair body loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNormalizedAlertParser();
  });

  it("loads bodies only for window items missing from the journal", async () => {
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]);
    const localReceipt = REPAIR_NOW + 5_000;
    expect(journal.record(
      liveRepairMessage("known", REPAIR_NOW - 2_000, localReceipt),
      { ...REPAIR_ACK, receivedAtMs: localReceipt },
    )).toEqual({ kind: "recorded" });
    const loadBody = mockBodyLoader();

    await proveVolcanoTypeCoverage({
      apiKey: "key",
      headType: "VFVO50",
      nowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      loadPage: vi.fn().mockResolvedValue(createResponse([
        repairItem("fresh", REPAIR_NOW - 1_000),
        repairItem("known", REPAIR_NOW - 2_000),
        repairItem("stale", REPAIR_NOW - REPAIR_RETENTION_MS - 1),
      ])),
      loadBody,
    });

    // journal 収録済み "known" と窓外 "stale" は取りに行かない。
    // head sample が 2 回以上走っても "fresh" は 1 回だけ。
    expect(loadBody.mock.calls.map((call) => call[1])).toEqual(["fresh"]);
  });

  it("loads a body at most once per id even when the load failed", async () => {
    const bodyCache = new Map<string, restClient.TelegramBodyResult>();
    const loadBody = vi.fn(async () => ({ kind: "failed" as const, reason: "forbidden" as const }));
    const options = {
      apiKey: "key",
      headType: "VFVO50" as const,
      nowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      getAcknowledgement: () => REPAIR_ACK,
      loadPage: vi.fn().mockResolvedValue(createResponse([
        repairItem("repeat", REPAIR_NOW - 1_000),
      ])),
      loadBody,
      bodyCache,
    };

    await expect(proveVolcanoTypeCoverage({
      ...options,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]),
    })).rejects.toThrow("historicalBodyUnavailable:forbidden");
    await expect(proveVolcanoTypeCoverage({
      ...options,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]),
    })).rejects.toThrow("historicalBodyUnavailable:forbidden");

    expect(loadBody).toHaveBeenCalledTimes(1);
  });

  it("revalidates the subscription after the awaited body load", async () => {
    let bodyLoaded = false;
    const loadBody = vi.fn(async (_apiKey: string, id: string) => {
      bodyLoaded = true;
      return { kind: "ok" as const, xml: `<Report id="${id}"/>` };
    });

    await expect(proveVolcanoTypeCoverage({
      apiKey: "key",
      headType: "VFVO50",
      nowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]),
      getAcknowledgement: () => bodyLoaded
        ? { ...REPAIR_ACK, subscriptionGeneration: 2 }
        : REPAIR_ACK,
      loadPage: vi.fn().mockResolvedValue(createResponse([
        repairItem("during-body", REPAIR_NOW - 1_000),
      ])),
      loadBody,
    })).rejects.toThrow("subscriptionGenerationChanged");

    expect(loadBody).toHaveBeenCalledTimes(1);
  });

  it("detects a head revision difference between the journal and the REST list", async () => {
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]);
    const localReceipt = REPAIR_NOW + 5_000;
    expect(journal.record(
      liveRepairMessage("drifted", REPAIR_NOW - 1_000, localReceipt, { serial: "1" }),
      { ...REPAIR_ACK, receivedAtMs: localReceipt },
    )).toEqual({ kind: "recorded" });

    await expect(proveVolcanoTypeCoverage({
      apiKey: "key",
      headType: "VFVO50",
      nowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      // 同一 id・同一 receivedTime だが Head revision (serial) が違う
      loadPage: vi.fn().mockResolvedValue(createResponse([
        repairItem("drifted", REPAIR_NOW - 1_000, { serial: "2" }),
      ])),
      loadBody: mockBodyLoader(),
    })).rejects.toThrow("transportInconsistency");
  });
});

describe("volcano REST repair body failure isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNormalizedAlertParser();
  });

  function repairFixture(targets: { vfvo50: boolean; ashfall: boolean }) {
    const gate = new TelegramRevisionGate();
    const holder = new VolcanoStateHolder();
    const standby = new StandbyStateStore();
    standby.replaceVolcanoDerived(holder.snapshot());
    const repair = emptyVolcanoRepairState();
    repair.vfvo50Repairable = targets.vfvo50;
    repair.ashfallRepairable = targets.ashfall;
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
    return { coordinator: new VolcanoTransactionCoordinator(admission), standby, repair };
  }

  it("fails only the ashfall target when its body load is forbidden", async () => {
    const { coordinator, standby, repair } = repairFixture({ vfvo50: true, ashfall: true });
    const standbyBefore = standby.cloneSnapshot();
    const before = coordinator.snapshot();
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50", "ashfall"]);

    const result = await repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW,
      coordinator,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      loadPage: vi.fn(async (_apiKey, query) => createResponse(
        query.type === "VFVO54"
          ? [repairAshfallItem("ashfall-body", REPAIR_NOW - 1_000, "VFVO54")]
          : [],
      )),
      loadBody: vi.fn(async () => ({ kind: "failed" as const, reason: "forbidden" as const })),
    });

    expect(result).toEqual({
      targets: [
        { target: "vfvo50", kind: "committed" },
        {
          target: "ashfall",
          kind: "failed",
          reason: "historicalBodyUnavailable:forbidden",
        },
      ],
    });
    // 失敗した target 側は holder / gate / standby / repair フラグを動かさない
    expect(coordinator.snapshot().repair).toEqual({ ...before.repair, vfvo50Repairable: false });
    expect(repair.ashfallRepairable).toBe(true);
    expect(standby.cloneSnapshot()).toEqual(standbyBefore);
  });

  it.each(["notFound", "contentType", "tooLarge", "network"] as const)(
    "keeps every ashfall owner untouched when the body load fails with %s",
    async (reason) => {
      const { coordinator, standby, repair } = repairFixture({ vfvo50: false, ashfall: true });
      const standbyBefore = standby.cloneSnapshot();
      const before = coordinator.snapshot();

      await expect(repairVolcanoState({
        apiKey: "key",
        nowMs: REPAIR_NOW,
        coordinator,
        journal: new VolcanoRepairJournal(REPAIR_ACK, ["ashfall"]),
        getAcknowledgement: () => REPAIR_ACK,
        loadPage: vi.fn(async (_apiKey, query) => createResponse(
          query.type === "VFVO55"
            ? [repairAshfallItem("ashfall-body", REPAIR_NOW - 1_000, "VFVO55")]
            : [],
        )),
        loadBody: vi.fn(async () => ({ kind: "failed" as const, reason })),
      })).resolves.toEqual({
        targets: [{
          target: "ashfall",
          kind: "failed",
          reason: `historicalBodyUnavailable:${reason}`,
        }],
      });

      expect(coordinator.snapshot()).toEqual(before);
      expect(repair.ashfallRepairable).toBe(true);
      expect(standby.cloneSnapshot()).toEqual(standbyBefore);
    },
  );
});

describe("volcano REST repair body fetch budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNormalizedAlertParser();
  });

  /** 1 ページ 100 件の newest-first ページ列を作る */
  function historicalPages(count: number): TelegramListResponse[] {
    const items = Array.from({ length: count }, (_, index) =>
      repairItem(`bulk-${String(index).padStart(4, "0")}`, REPAIR_NOW - 1_000 - index));
    const pages: TelegramListResponse[] = [];
    for (let offset = 0; offset < items.length; offset += 100) {
      const slice = items.slice(offset, offset + 100);
      const hasMore = offset + 100 < items.length;
      pages.push(hasMore
        ? { ...createResponse(slice), nextToken: `token-${offset}` } as TelegramListResponse
        : createResponse(slice));
    }
    return pages;
  }

  /** call 1 = head sample、続く N 回 = historical pages、以降 = head sample */
  function sequencedLoadPage(pages: TelegramListResponse[]) {
    let call = 0;
    return vi.fn(async () => {
      call += 1;
      if (call === 1) return createResponse([]);
      const pageIndex = call - 2;
      return pageIndex < pages.length ? pages[pageIndex]! : createResponse([]);
    });
  }

  it("loads exactly 256 bodies for one repair without failing", async () => {
    const loadBody = mockBodyLoader();

    const proof = await proveVolcanoTypeCoverage({
      apiKey: "key",
      headType: "VFVO50",
      nowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]),
      getAcknowledgement: () => REPAIR_ACK,
      loadPage: sequencedLoadPage(historicalPages(256)),
      loadBody,
    });

    expect(proof.historical.items).toHaveLength(256);
    expect(loadBody).toHaveBeenCalledTimes(256);
  });

  it("fails the target on the 257th body of one repair without issuing the request", async () => {
    // 別 head type が既に 256 件取得済みの repair scope を模す
    const bodyCache = new Map<string, restClient.TelegramBodyResult>(
      Array.from({ length: 256 }, (_, index) => [
        `other-type-${index}`,
        { kind: "ok" as const, xml: "<Report/>" },
      ]),
    );
    const loadBody = mockBodyLoader();

    await expect(proveVolcanoTypeCoverage({
      apiKey: "key",
      headType: "VFVO50",
      nowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]),
      getAcknowledgement: () => REPAIR_ACK,
      loadPage: vi.fn().mockResolvedValue(createResponse([
        repairItem("over-budget", REPAIR_NOW - 1_000),
      ])),
      loadBody,
      bodyCache,
    })).rejects.toThrow("historicalBodyUnavailable:fetchLimitExceeded");

    expect(loadBody).not.toHaveBeenCalled();
  });

  it("skips the body of an item that reached the journal during an earlier body load", async () => {
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]);
    const localReceipt = REPAIR_NOW + 5_000;
    const loadBody = vi.fn(async (_apiKey: string, id: string) => {
      if (id === "first") {
        // 本文取得の await 中に WS ingress が "late" を journal へ入れる
        expect(journal.record(
          liveRepairMessage("late", REPAIR_NOW - 2_000, localReceipt),
          { ...REPAIR_ACK, receivedAtMs: localReceipt },
        )).toEqual({ kind: "recorded" });
      }
      return { kind: "ok" as const, xml: `<Report id="${id}"/>` };
    });

    const proof = await proveVolcanoTypeCoverage({
      apiKey: "key",
      headType: "VFVO50",
      nowMs: REPAIR_NOW,
      retentionMs: REPAIR_RETENTION_MS,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      loadPage: vi.fn().mockResolvedValue(createResponse([
        repairItem("first", REPAIR_NOW - 1_000),
        repairItem("late", REPAIR_NOW - 2_000),
      ])),
      loadBody,
    });

    expect(loadBody.mock.calls.map((call) => call[1])).toEqual(["first"]);
    const late = proof.historical.items.find((item) => item.itemId === "late")!;
    expect(late.normalizedInput.parsed.meta.receivedAtMs).toBe(localReceipt);
  });
});

describe("volcano REST repair head revision cross-checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function liveAshfallMessage(
    id: string,
    serverTimeMs: number,
    localTimeMs: number,
    headType: "VFVO54" | "VFVO55",
    xmlHead: Partial<TelegramListXmlHead> = {},
  ): WsDataMessage {
    const base = liveRepairMessage(id, serverTimeMs, localTimeMs, xmlHead);
    return normalizeTelegramMessage(
      { ...base, meta: undefined, head: { ...base.head, type: headType } },
      localTimeMs,
    ).message;
  }

  function ashfallRepairFixture() {
    const gate = new TelegramRevisionGate();
    const holder = new VolcanoStateHolder();
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
    return { coordinator: new VolcanoTransactionCoordinator(admission), standby, repair };
  }

  it("fails the journal duplicate branch on a head revision difference without parsing it", () => {
    mockNormalizedAlertParser();
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]);
    const localReceipt = REPAIR_NOW + 1;
    const transport: WsTransportIdentity = { ...REPAIR_ACK, receivedAtMs: localReceipt };

    expect(journal.record(
      liveRepairMessage("head-drift", REPAIR_NOW, localReceipt, { serial: "1" }),
      transport,
    )).toEqual({ kind: "recorded" });
    // 受信時刻も本文も同一だが head revision (serial) だけが違う再送
    expect(journal.record(
      liveRepairMessage("head-drift", REPAIR_NOW, localReceipt, { serial: "2" }),
      transport,
    )).toEqual({
      kind: "proofFailed",
      target: "vfvo50",
      reason: "transportInconsistency",
    });
    expect(mockParseVolcano).toHaveBeenCalledTimes(1);
  });

  it("fails the ashfall commit when the journal gained a conflicting head after its proof", async () => {
    mockParseVolcano.mockImplementation(ashfallFromXmlReport);
    const { coordinator, standby, repair } = ashfallRepairFixture();
    const standbyBefore = standby.cloneSnapshot();
    const before = coordinator.snapshot();
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["ashfall"]);
    const localReceipt = REPAIR_NOW + 5_000;
    let injected = false;

    const result = await repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW,
      coordinator,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      loadPage: vi.fn(async (_apiKey, query) => {
        if (query.type === "VFVO55" && !injected) {
          injected = true;
          // VFVO54 の proof 完了後、同一 id が別 head revision で journal へ入る
          expect(journal.record(
            liveAshfallMessage("drift-x", REPAIR_NOW - 1_000, localReceipt, "VFVO54", {
              serial: "2",
            }),
            { ...REPAIR_ACK, receivedAtMs: localReceipt },
          )).toEqual({ kind: "recorded" });
        }
        return createResponse(query.type === "VFVO54"
          ? [repairAshfallItem("drift-x", REPAIR_NOW - 1_000, "VFVO54", { serial: "1" })]
          : []);
      }),
      loadBody: mockBodyLoader(),
    });

    expect(result).toEqual({
      targets: [{ target: "ashfall", kind: "failed", reason: "transportInconsistency" }],
    });
    expect(coordinator.snapshot()).toEqual(before);
    expect(repair.ashfallRepairable).toBe(true);
    expect(standby.cloneSnapshot()).toEqual(standbyBefore);
  });
});

// ── spec §14.3 / §14.4: 手動 force・二段階 commit・dry-run ──

describe("volcano manual force repair (spec §14.3 / §14.4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseVolcano.mockImplementation((msg: WsDataMessage) => msg.head.type === "VFVO50"
      ? alertFromXmlReport(msg)
      : ashfallFromXmlReport(msg));
  });

  /** repairable が両方 false の coordinator（force の前提） */
  function forceFixture(flags: { vfvo50?: boolean; ashfall?: boolean } = {}) {
    const gate = new TelegramRevisionGate();
    const holder = new VolcanoStateHolder();
    const standby = new StandbyStateStore();
    standby.replaceVolcanoDerived(holder.snapshot());
    const repair = emptyVolcanoRepairState();
    repair.vfvo50Repairable = flags.vfvo50 === true;
    repair.ashfallRepairable = flags.ashfall === true;
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
    return { coordinator: new VolcanoTransactionCoordinator(admission), standby, repair };
  }

  const emptyPages = () => vi.fn(async () => createResponse([]));

  // spec §14.3 #27
  it("spec §14.3 #27: repairable が両方 false でも targets 指定で VFVO50 を commit する", async () => {
    const { coordinator, repair } = forceFixture();
    expect(repair.vfvo50Repairable).toBe(false);
    const requestedTypes: string[] = [];
    const loadPage = vi.fn(async (_apiKey: string, query: { type: string }) => {
      requestedTypes.push(query.type);
      return createResponse([]);
    });

    const result = await repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW,
      coordinator,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]),
      getAcknowledgement: () => REPAIR_ACK,
      targets: ["vfvo50"],
      commitPolicy: "twoPhase",
      loadPage: loadPage as never,
      loadBody: mockBodyLoader(),
    });

    expect(result).toEqual({ targets: [{ target: "vfvo50", kind: "committed" }] });
    expect(new Set(requestedTypes)).toEqual(new Set(["VFVO50"]));
    expect(coordinator.snapshot().repair.vfvo50Repairable).toBe(false);
  });

  // spec §14.3 #28
  it("spec §14.3 #28: ashfall は VFVO54/55 の両 proof を走らせ片方失敗なら commit しない", async () => {
    const { coordinator } = forceFixture();
    const before = coordinator.snapshot();
    const seen: string[] = [];
    const loadPage = vi.fn(async (_apiKey: string, query: { type: string }) => {
      seen.push(query.type);
      if (query.type === "VFVO55") throw new Error("historicalResponseMissingBody");
      return createResponse([]);
    });

    const result = await repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW,
      coordinator,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["ashfall"]),
      getAcknowledgement: () => REPAIR_ACK,
      targets: ["ashfall"],
      commitPolicy: "twoPhase",
      loadPage: loadPage as never,
      loadBody: mockBodyLoader(),
    });

    expect(new Set(seen)).toEqual(new Set(["VFVO54", "VFVO55"]));
    expect(result.targets).toEqual([
      { target: "ashfall", kind: "failed", reason: "historicalResponseMissingBody" },
    ]);
    expect(coordinator.snapshot()).toEqual(before);
  });

  // spec §14.3 #29
  it("spec §14.3 #29: targets 両指定で target ごとに独立して成功・失敗する", async () => {
    const { coordinator } = forceFixture();

    const result = await repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW,
      coordinator,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50", "ashfall"]),
      getAcknowledgement: () => REPAIR_ACK,
      targets: ["vfvo50", "ashfall"],
      loadPage: vi.fn(async (_apiKey, query) => {
        if (query.type === "VFVO55") throw new Error("historicalResponseMissingBody");
        return createResponse([]);
      }),
      loadBody: mockBodyLoader(),
    });

    expect(result.targets).toEqual([
      { target: "vfvo50", kind: "committed" },
      { target: "ashfall", kind: "failed", reason: "historicalResponseMissingBody" },
    ]);
  });

  // spec §14.3 #30
  it("spec §14.3 #30: twoPhase は VFVO54 prove 中の ack 変更で VFVO50 も commit しない", async () => {
    const twoPhase = forceFixture();
    let ack: WsSubscriptionAcknowledgement = REPAIR_ACK;
    const before = twoPhase.coordinator.snapshot();

    const result = await repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW,
      coordinator: twoPhase.coordinator,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50", "ashfall"]),
      getAcknowledgement: () => ack,
      targets: ["vfvo50", "ashfall"],
      commitPolicy: "twoPhase",
      loadPage: vi.fn(async (_apiKey, query) => {
        if (query.type === "VFVO54") ack = { ...REPAIR_ACK, subscriptionGeneration: 2 };
        return createResponse([]);
      }),
      loadBody: mockBodyLoader(),
    });

    expect(result.targets).toEqual([
      { target: "vfvo50", kind: "failed", reason: "subscriptionGenerationChanged" },
      { target: "ashfall", kind: "failed", reason: "subscriptionGenerationChanged" },
    ]);
    // 二段階化の要点: runtimeVersion が実行前後で不変
    expect(twoPhase.coordinator.snapshot().runtimeVersion).toBe(before.runtimeVersion);

    // 同条件を commitPolicy 無し（起動時挙動）で走らせると VFVO50 だけ committed になる
    const sequential = forceFixture();
    let ackSeq: WsSubscriptionAcknowledgement = REPAIR_ACK;
    const sequentialResult = await repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW,
      coordinator: sequential.coordinator,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50", "ashfall"]),
      getAcknowledgement: () => ackSeq,
      targets: ["vfvo50", "ashfall"],
      loadPage: vi.fn(async (_apiKey, query) => {
        if (query.type === "VFVO54") ackSeq = { ...REPAIR_ACK, subscriptionGeneration: 2 };
        return createResponse([]);
      }),
      loadBody: mockBodyLoader(),
    });
    expect(sequentialResult.targets[0]).toEqual({ target: "vfvo50", kind: "committed" });
    expect(sequentialResult.targets[1]!.kind).toBe("failed");
  });

  // spec §14.3 #31
  it("spec §14.3 #31: commit phase は await も ack 検査も挟まない", async () => {
    const { coordinator } = forceFixture();
    const events: string[] = [];
    let ack: WsSubscriptionAcknowledgement = REPAIR_ACK;
    const transact = coordinator.transact.bind(coordinator);
    vi.spyOn(coordinator, "transact").mockImplementation((family, mutate) => {
      events.push("commit");
      // 最初の commit と同時に ack 世代が変わっても commit phase は完走する
      ack = { ...REPAIR_ACK, subscriptionGeneration: 9 };
      return transact(family, mutate);
    });

    const result = await repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW,
      coordinator,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50", "ashfall"]),
      getAcknowledgement: () => {
        events.push("ack");
        return ack;
      },
      targets: ["vfvo50", "ashfall"],
      commitPolicy: "twoPhase",
      loadPage: emptyPages(),
      loadBody: mockBodyLoader(),
    });

    expect(result.targets).toEqual([
      { target: "vfvo50", kind: "committed" },
      { target: "ashfall", kind: "committed" },
    ]);
    // commit phase 以降に ack 検査が 1 度も無いこと
    expect(events.lastIndexOf("ack")).toBeLessThan(events.indexOf("commit"));
  });

  // spec §14.3 #32
  it("spec §14.3 #32: twoPhase で VFVO50 の proof 失敗は ashfall の commit を妨げない", async () => {
    const { coordinator } = forceFixture();

    const result = await repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW,
      coordinator,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50", "ashfall"]),
      getAcknowledgement: () => REPAIR_ACK,
      targets: ["vfvo50", "ashfall"],
      commitPolicy: "twoPhase",
      loadPage: vi.fn(async (_apiKey, query) => {
        if (query.type === "VFVO50") throw new Error("historicalResponseMissingBody");
        return createResponse([]);
      }),
      loadBody: mockBodyLoader(),
    });

    expect(result.targets).toEqual([
      { target: "vfvo50", kind: "failed", reason: "historicalResponseMissingBody" },
      { target: "ashfall", kind: "committed" },
    ]);
  });

  // spec §14.3 #33
  it("spec §14.3 #33: commitPolicy 無しの起動時経路は逐次順序を保つ", async () => {
    const { coordinator } = forceFixture({ vfvo50: true, ashfall: true });
    const order: string[] = [];
    const transact = coordinator.transact.bind(coordinator);
    vi.spyOn(coordinator, "transact").mockImplementation((family, mutate) => {
      order.push(`commit:${family}`);
      return transact(family, mutate);
    });

    await repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW,
      coordinator,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50", "ashfall"]),
      getAcknowledgement: () => REPAIR_ACK,
      loadPage: vi.fn(async (_apiKey, query) => {
        const last = order.at(-1);
        if (last !== `prove:${query.type}`) order.push(`prove:${query.type}`);
        return createResponse([]);
      }),
      loadBody: mockBodyLoader(),
    });

    expect(order).toEqual([
      "prove:VFVO50",
      "commit:volcanoAlert",
      "prove:VFVO54",
      "prove:VFVO55",
      "commit:volcanoAshfall",
    ]);
  });

  // spec §14.3 #34
  it("spec §14.3 #34: force commit 後も unrecoverableAlertOmissions が不変である", async () => {
    const { coordinator } = forceFixture();
    const before = JSON.stringify(coordinator.snapshot().repair.unrecoverableAlertOmissions);

    await repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW,
      coordinator,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]),
      getAcknowledgement: () => REPAIR_ACK,
      targets: ["vfvo50"],
      commitPolicy: "twoPhase",
      loadPage: emptyPages(),
      loadBody: mockBodyLoader(),
    });

    expect(JSON.stringify(coordinator.snapshot().repair.unrecoverableAlertOmissions)).toBe(before);
  });

  // spec §14.3 #35 / #39
  it("spec §14.3 #35 #39: VFVO50 force は gate family を expire せず holder も sweep しない", async () => {
    const { coordinator } = forceFixture();
    const expireSpy = vi.spyOn(TelegramRevisionGate.prototype, "expireRevisionFamily");
    const sweepSpy = vi.spyOn(VolcanoStateHolder.prototype, "sweep");
    const clearSpy = vi.spyOn(VolcanoStateHolder.prototype, "clearAshfall");
    const retainSpy = vi.spyOn(VolcanoStateHolder.prototype, "retainActiveSubjects");

    // 起動から 30 日進んだ nowMs を渡しても VFVO50 は expiry を動かさない
    await repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW + 30 * 24 * 60 * 60_000,
      coordinator,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]),
      getAcknowledgement: () => REPAIR_ACK,
      targets: ["vfvo50"],
      commitPolicy: "twoPhase",
      loadPage: emptyPages(),
      loadBody: mockBodyLoader(),
    });

    expect(expireSpy).not.toHaveBeenCalled();
    expect(sweepSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    // 非破壊の要: active subject の温存だけを行う
    expect(retainSpy).toHaveBeenCalled();

    // 対照: ashfall force は expire も sweep も通る
    expireSpy.mockClear();
    sweepSpy.mockClear();
    await repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW,
      coordinator,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["ashfall"]),
      getAcknowledgement: () => REPAIR_ACK,
      targets: ["ashfall"],
      commitPolicy: "twoPhase",
      loadPage: emptyPages(),
      loadBody: mockBodyLoader(),
    });
    expect(expireSpy).toHaveBeenCalled();
    expect(sweepSpy).toHaveBeenCalled();
  });

  /** VFVO54 を 1 件（または 0 件）replay して ashfall gate を作り直す */
  function forceAshfall(
    coordinator: VolcanoTransactionCoordinator,
    nowMs: number,
    items: TelegramListItem[],
  ): Promise<VolcanoStartupRepairResult> {
    return repairVolcanoState({
      apiKey: "key",
      nowMs,
      coordinator,
      journal: new VolcanoRepairJournal(REPAIR_ACK, ["ashfall"]),
      getAcknowledgement: () => REPAIR_ACK,
      targets: ["ashfall"],
      commitPolicy: "twoPhase",
      loadPage: vi.fn(async (_apiKey, query) =>
        createResponse(query.type === "VFVO54" ? items : [])),
      loadBody: mockBodyLoader(),
    });
  }

  function ashfallGateKeys(coordinator: VolcanoTransactionCoordinator): string[] {
    return coordinator.snapshot().gates.states
      .map((entry) => entry.key)
      .filter((key) => key.startsWith("volcano:volcanoAshfall:"));
  }

  // spec §14.3 #36
  it("spec §14.3 #36: ashfall force は既存の降灰 gate を全削除してから窓内だけ replay する", async () => {
    const { coordinator } = forceFixture();
    const itemReceivedMs = REPAIR_NOW - 1_000;

    const seeded = await forceAshfall(coordinator, REPAIR_NOW,
      [repairAshfallItem("seed-ash", itemReceivedMs, "VFVO54")]);
    expect(seeded.targets).toEqual([{ target: "ashfall", kind: "committed" }]);
    expect(ashfallGateKeys(coordinator).length).toBeGreaterThan(0);

    // REST が 1 件も返さない再実行 = 全削除だけが残る（破壊的であることの固定）
    await forceAshfall(coordinator, REPAIR_NOW, []);
    expect(ashfallGateKeys(coordinator)).toEqual([]);
  });

  // spec §14.3 #37
  it("spec §14.3 #37: nowMs を実行時刻で渡すと coverage 窓が動いて古い item が外れる", async () => {
    const retentionMs = 7 * 24 * 60 * 60_000;
    const itemReceivedMs = REPAIR_NOW - 1_000;
    const items = [repairAshfallItem("window-ash", itemReceivedMs, "VFVO54")];

    async function provedCount(nowMs: number): Promise<number> {
      const { coordinator } = forceFixture();
      const result = await repairVolcanoState({
        apiKey: "key",
        nowMs,
        coordinator,
        journal: new VolcanoRepairJournal(REPAIR_ACK, ["ashfall"]),
        getAcknowledgement: () => REPAIR_ACK,
        targets: ["ashfall"],
        dryRun: true,
        commitPolicy: "twoPhase",
        loadPage: vi.fn(async (_apiKey, query) =>
          createResponse(query.type === "VFVO54" ? items : [])),
        loadBody: mockBodyLoader(),
      });
      return result.targets[0]!.historicalCount ?? -1;
    }

    // 境界ちょうどは窓内、1 ms 超過で窓外
    expect(await provedCount(itemReceivedMs + retentionMs)).toBe(1);
    expect(await provedCount(itemReceivedMs + retentionMs + 1)).toBe(0);
  });

  // spec §14.3 #38
  it("spec §14.3 #38: ashfall gate の tombstone 期限は nowMs 基準の境界で保持/削除される", async () => {
    const retentionMs = 7 * 24 * 60 * 60_000;
    const itemReceivedMs = REPAIR_NOW - 1_000;
    const items = [repairAshfallItem("boundary-ash", itemReceivedMs, "VFVO54")];

    // 境界ちょうど: coverage に入り expireRevisionFamily でも消えない
    const onBoundary = forceFixture();
    await forceAshfall(onBoundary.coordinator, itemReceivedMs + retentionMs, items);
    expect(ashfallGateKeys(onBoundary.coordinator).length).toBeGreaterThan(0);

    // 1 ms 超過: 窓外かつ期限切れで残らない
    const past = forceFixture();
    await forceAshfall(past.coordinator, itemReceivedMs + retentionMs + 1, items);
    expect(ashfallGateKeys(past.coordinator)).toEqual([]);
  });

  // spec §14.3 #40
  it("spec §14.3 #40: targets の空配列・重複・未知値は実行前に拒否される", async () => {
    const loadPage = emptyPages();
    for (const targets of [[], ["vfvo50", "vfvo50"], ["vfvo51"]] as const) {
      const { coordinator } = forceFixture();
      await expect(repairVolcanoState({
        apiKey: "key",
        nowMs: REPAIR_NOW,
        coordinator,
        journal: new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]),
        getAcknowledgement: () => REPAIR_ACK,
        targets: targets as never,
        commitPolicy: "twoPhase",
        loadPage,
        loadBody: mockBodyLoader(),
      })).rejects.toThrow("invalidRepairTargets");
    }
    expect(loadPage).not.toHaveBeenCalled();
  });

  // spec §14.4 #41 / #42 / #45
  it("spec §14.4 #41 #42 #45: dry-run は commit せず状態を変えず件数を返す", async () => {
    const { coordinator, standby } = forceFixture();
    const transactSpy = vi.spyOn(coordinator, "transact");
    const before = JSON.stringify(coordinator.snapshot());
    const standbyBefore = JSON.stringify(standby.cloneSnapshot());
    const journal = new VolcanoRepairJournal(REPAIR_ACK, ["vfvo50"]);
    const localReceipt = REPAIR_NOW + 3_000;
    journal.record(
      liveRepairMessage("live-dry", REPAIR_NOW - 500, localReceipt),
      { ...REPAIR_ACK, receivedAtMs: localReceipt },
    );

    const result = await repairVolcanoState({
      apiKey: "key",
      nowMs: REPAIR_NOW,
      coordinator,
      journal,
      getAcknowledgement: () => REPAIR_ACK,
      targets: ["vfvo50"],
      dryRun: true,
      commitPolicy: "twoPhase",
      loadPage: vi.fn(async () => createResponse([
        repairItem("hist-1", REPAIR_NOW - 1_000),
        repairItem("hist-2", REPAIR_NOW - 2_000),
      ])),
      loadBody: mockBodyLoader(),
    });

    expect(result.targets).toEqual([
      { target: "vfvo50", kind: "proved", historicalCount: 2, journalCount: 1 },
    ]);
    // commit を 1 つも呼ばない（transaction が 1 度も開かれない）
    expect(transactSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(coordinator.snapshot())).toBe(before);
    expect(JSON.stringify(standby.cloneSnapshot())).toBe(standbyBefore);
  });
});
