import { readFileSync } from "node:fs";
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

/**
 * 旧 `restoreVolcanoState` 経路だけが使う、一覧 item に body が同梱された形。
 * 実 API はこの形を返さない (同型欠陥は別項目として起票済み)。
 */
function createLegacyTelegramItem(
  id: string,
  time: string,
  overrides: Partial<TelegramListItem> = {}
): TelegramListItem {
  return {
    ...createTelegramItem(id, time),
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
      createLegacyTelegramItem("tg-asama", "2026-07-02T00:00:00+09:00"),
      createLegacyTelegramItem("tg-sakura", "2026-07-01T00:00:00+09:00"),
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
      createLegacyTelegramItem("tg-release", "2026-07-02T00:00:00+09:00"),
      createLegacyTelegramItem("tg-issue", "2026-07-01T00:00:00+09:00"),
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
      createLegacyTelegramItem("tg-broken", "2026-07-02T00:00:00+09:00", { body: undefined }),
      createLegacyTelegramItem("tg-sakura", "2026-07-01T00:00:00+09:00"),
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
      createLegacyTelegramItem("tg-unparsable", "2026-07-02T00:00:00+09:00"),
      createLegacyTelegramItem("tg-sakura", "2026-07-01T00:00:00+09:00"),
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
      createLegacyTelegramItem("tg-lower", "2026-07-02T00:00:00+09:00"),
      createLegacyTelegramItem("tg-issue3", "2026-07-01T00:00:00+09:00"),
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
      createLegacyTelegramItem("rest-old", issue.reportDateTime),
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
      createLegacyTelegramItem("rest-active", active.reportDateTime),
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
      startupNowMs: REPAIR_NOW,
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
      startupNowMs: REPAIR_NOW,
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
      startupNowMs: REPAIR_NOW,
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
      startupNowMs: REPAIR_NOW,
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
      startupNowMs: REPAIR_NOW,
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
        startupNowMs: REAL_FIXTURE_NOW,
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
      startupNowMs: REPAIR_NOW,
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
      startupNowMs: REPAIR_NOW,
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
      startupNowMs: REPAIR_NOW,
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
      startupNowMs: REPAIR_NOW,
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
      startupNowMs: REPAIR_NOW,
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
        startupNowMs: REPAIR_NOW,
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
      startupNowMs: REPAIR_NOW,
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
      startupNowMs: REPAIR_NOW,
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
      startupNowMs: REPAIR_NOW,
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
      startupNowMs: REPAIR_NOW,
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
