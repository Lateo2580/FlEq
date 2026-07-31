import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { restoreTsunamiState } from "../../src/engine/startup/tsunami-initializer";
import { TsunamiStateHolder } from "../../src/engine/messages/tsunami-state";
import { TelegramRevisionGate } from "../../src/engine/messages/telegram-revision-gate";
import * as restClient from "../../src/dmdata/rest-client";
import type { ParsedTsunamiInfo, TelegramListItem, TelegramListResponse } from "../../src/types";
import { createTelegramMeta } from "../../src/dmdata/telegram-meta";
import { processTsunami } from "../../src/engine/presentation/processors/process-tsunami";
import { toWsDataMessage } from "../../src/engine/startup/telegram-adapter";
import {
  StandbyPersistence,
  type PersistedStandbyStateV1,
} from "../../src/engine/display/standby-persistence";

// sound-player をモック
vi.mock("../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

// rest-client をモック
vi.mock("../../src/dmdata/rest-client");

// telegram-parser の decodeBody を部分モック
// (実際の XML 処理は不要なので parseTsunamiTelegram ごとモック)
vi.mock("../../src/dmdata/telegram-parser", () => ({
  parseTsunamiTelegram: vi.fn(),
}));

import { parseTsunamiTelegram } from "../../src/dmdata/telegram-parser";

const mockListTelegrams = vi.mocked(restClient.listTelegrams);
const mockParseTsunami = vi.mocked(parseTsunamiTelegram);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function persistencePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-tsunami-initializer-"));
  tempDirs.push(dir);
  return path.join(dir, "display-active-state-v1.json");
}

function emptyStandbyState(): PersistedStandbyStateV1 {
  return {
    version: 1,
    savedAt: "2025-01-01T00:03:00+09:00",
    heat: [], typhoons: [], volcanoes: [], floods: { events: [], seen: [] },
    weatherAlerts: [], tornado: [], longPeriod: [], quakeHost: null,
    nankaiTrough: null, seen: [],
  };
}

/** テスト用 TelegramListItem を生成 */
function createTelegramItem(
  overrides: Partial<TelegramListItem> = {}
): TelegramListItem {
  return {
    serial: 1,
    id: "test-telegram-001",
    classification: "telegram.earthquake",
    head: {
      type: "VTSE41",
      author: "気象庁",
      time: "2025-01-01T00:00:00+09:00",
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
    responseTime: "2025-01-01T00:00:00.000Z",
    status: "ok",
    items,
  };
}

describe("restoreTsunamiState", () => {
  let tsunamiState: TsunamiStateHolder;
  let revisionGate: TelegramRevisionGate;

  beforeEach(() => {
    tsunamiState = new TsunamiStateHolder();
    revisionGate = new TelegramRevisionGate();
    vi.clearAllMocks();
  });

  it("最新の VTSE41 に警報がある場合 → 状態を復元する", async () => {
    const item = createTelegramItem();
    mockListTelegrams.mockResolvedValue(createResponse([item]));
    mockParseTsunami.mockReturnValue({
      meta: createTelegramMeta({ messageId: "restore-1", eventId: "tsunami", type: "VTSE41", reportDateTime: "2025-01-01T00:00:00+09:00", serial: null, infoType: "発表", receivedAtMs: Date.parse("2025-01-01T00:00:01+09:00"), status: "通常", isTest: false }),
      type: "VTSE41",
      infoType: "発表",
      title: "津波警報・注意報・予報",
      reportDateTime: "2025-01-01T00:00:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      forecast: [
        { areaName: "三陸沿岸", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "すでに到達と推測" },
      ],
      warningComment: "",
      isTest: false,
    });

    const result = await restoreTsunamiState("test-key", tsunamiState, revisionGate);

    expect(result).not.toBeNull();
    expect(tsunamiState.getLevel()).toBe("津波警報");
    expect(mockListTelegrams).toHaveBeenCalledWith("test-key", "VTSE41", 1);
  });

  it("REST 復元を共通 gate の watermark として seed し、遅着旧報を拒否する", async () => {
    const item = createTelegramItem({ id: "restore-new" });
    mockListTelegrams.mockResolvedValue(createResponse([item]));
    const restored: ParsedTsunamiInfo = {
      meta: createTelegramMeta({ messageId: "restore-new", eventId: "tsunami", type: "VTSE41", reportDateTime: "2025-01-01T00:02:00+09:00", serial: null, infoType: "発表", receivedAtMs: Date.parse("2025-01-01T00:02:01+09:00"), status: "通常", isTest: false }),
      type: "VTSE41",
      infoType: "発表",
      title: "津波警報・注意報・予報",
      reportDateTime: "2025-01-01T00:02:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      forecast: [{ areaName: "三陸沿岸", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "" }],
      warningComment: "",
      isTest: false,
    };
    mockParseTsunami.mockReturnValueOnce(restored);
    expect(await restoreTsunamiState("test-key", tsunamiState, revisionGate)).not.toBeNull();

    mockParseTsunami.mockReturnValueOnce({
      ...restored,
      meta: createTelegramMeta({ messageId: "delayed-old", eventId: "tsunami", type: "VTSE41", reportDateTime: "2025-01-01T00:01:00+09:00", serial: null, infoType: "発表", receivedAtMs: Date.parse("2025-01-01T00:03:00+09:00"), status: "通常", isTest: false }),
      reportDateTime: "2025-01-01T00:01:00+09:00",
    });
    const delayedMessage = toWsDataMessage(
      createTelegramItem({ id: "delayed-old" }),
      "dGVzdA==",
    );
    expect(processTsunami(delayedMessage, { tsunamiState, revisionGate }))
      .toEqual({ kind: "suppressed" });
    expect(tsunamiState.getLastInfo()?.reportDateTime).toBe("2025-01-01T00:02:00+09:00");
  });

  it("persisted watermark と同じ REST 報でも空 holder を安全に再構成する", async () => {
    const active: ParsedTsunamiInfo = {
      meta: createTelegramMeta({
        messageId: "persisted-active",
        eventId: "tsunami",
        type: "VTSE41",
        reportDateTime: "2025-01-01T00:02:00+09:00",
        serial: null,
        infoType: "発表",
        receivedAtMs: Date.parse("2025-01-01T00:02:01+09:00"),
        status: "通常",
        isTest: false,
      }),
      type: "VTSE41",
      infoType: "発表",
      title: "津波警報・注意報・予報",
      reportDateTime: "2025-01-01T00:02:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      forecast: [{
        areaName: "三陸沿岸",
        kind: "津波警報",
        maxHeightDescription: "3m",
        firstHeight: "",
      }],
      warningComment: "",
      isTest: false,
    };
    mockParseTsunami.mockReturnValueOnce(active);
    expect(processTsunami(toWsDataMessage(
      createTelegramItem({ id: "persisted-active" }),
      "dGVzdA==",
    ), { tsunamiState, revisionGate }).kind).toBe("ok");

    const restartedState = new TsunamiStateHolder();
    const restartedGate = new TelegramRevisionGate();
    restartedGate.restoreDurableEntries(revisionGate.exportDurableEntries());
    mockListTelegrams.mockResolvedValue(createResponse([
      createTelegramItem({ id: "same-rest-active" }),
    ]));
    mockParseTsunami.mockReturnValueOnce({
      ...active,
      meta: { ...active.meta, messageId: "same-rest-active" },
    });
    const persistReconstructedState = vi.fn();

    expect(await restoreTsunamiState(
      "test-key",
      restartedState,
      restartedGate,
      persistReconstructedState,
    )).toEqual(expect.objectContaining({ reportDateTime: active.reportDateTime }));
    expect(restartedState.getLevel()).toBe("津波警報");
    expect(persistReconstructedState).toHaveBeenCalledTimes(1);
  });

  it("同一 revision 訂正後の active を実ファイル往復し、REST 不通でも維持する", async () => {
    const normal: ParsedTsunamiInfo = {
      meta: createTelegramMeta({
        messageId: "normal-before-correction",
        eventId: "tsunami",
        type: "VTSE41",
        reportDateTime: "2025-01-01T00:02:00+09:00",
        serial: null,
        infoType: "発表",
        receivedAtMs: Date.parse("2025-01-01T00:02:01+09:00"),
        status: "通常",
        isTest: false,
      }),
      type: "VTSE41",
      infoType: "発表",
      title: "津波警報・注意報・予報",
      reportDateTime: "2025-01-01T00:02:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      forecast: [{ areaName: "三陸沿岸", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "" }],
      warningComment: "",
      isTest: false,
    };
    const correction: ParsedTsunamiInfo = {
      ...normal,
      meta: createTelegramMeta({
        messageId: "major-correction",
        eventId: "tsunami",
        type: "VTSE41",
        reportDateTime: normal.reportDateTime,
        serial: null,
        infoType: "訂正",
        receivedAtMs: Date.parse("2025-01-01T00:02:02+09:00"),
        status: "通常",
        isTest: false,
      }),
      infoType: "訂正",
      forecast: [{ areaName: "三陸沿岸", kind: "大津波警報", maxHeightDescription: "10m超", firstHeight: "" }],
    };
    mockParseTsunami.mockReturnValueOnce(normal);
    expect(processTsunami(toWsDataMessage(
      createTelegramItem({ id: "normal-before-correction" }),
      "dGVzdA==",
    ), { tsunamiState, revisionGate }).kind).toBe("ok");
    mockParseTsunami.mockReturnValueOnce(correction);
    expect(processTsunami(toWsDataMessage(
      createTelegramItem({ id: "major-correction" }),
      "dGVzdA==",
    ), { tsunamiState, revisionGate }).kind).toBe("ok");

    const persistence = new StandbyPersistence(persistencePath(), 0, () => ({
      vpws50: { authoritative: true, state: null, gateEntries: [] },
      tsunami: {
        active: tsunamiState.getPersistedActive(),
        observations: tsunamiState.getObservationGroups(),
        gateEntries: revisionGate.exportDurableEntries(),
      },
    }));
    persistence.save(emptyStandbyState());
    const loaded = persistence.load()!.telegramFoundation.tsunami;
    const restartedState = new TsunamiStateHolder();
    const restartedGate = new TelegramRevisionGate();
    restartedState.restorePersistedState(loaded.active ?? null, loaded.observations);
    restartedGate.restoreDurableEntries(loaded.gateEntries);

    mockListTelegrams.mockRejectedValue(new Error("REST unavailable"));
    expect(await restoreTsunamiState("test-key", restartedState, restartedGate)).toBeNull();
    expect(restartedState.getLevel()).toBe("大津波警報");
    expect(restartedState.getLastInfo()).toEqual(correction);
  });

  it("persisted 取消 tombstone と同一 revision の通常 REST 報で警報を復活させない", async () => {
    const active: ParsedTsunamiInfo = {
      meta: createTelegramMeta({
        messageId: "same-revision-active",
        eventId: "tsunami",
        type: "VTSE41",
        reportDateTime: "2025-01-01T00:02:00+09:00",
        serial: null,
        infoType: "発表",
        receivedAtMs: Date.parse("2025-01-01T00:02:01+09:00"),
        status: "通常",
        isTest: false,
      }),
      type: "VTSE41",
      infoType: "発表",
      title: "津波警報・注意報・予報",
      reportDateTime: "2025-01-01T00:02:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      forecast: [{ areaName: "三陸沿岸", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "" }],
      warningComment: "",
      isTest: false,
    };
    const cancelled: ParsedTsunamiInfo = {
      ...active,
      meta: createTelegramMeta({
        messageId: "same-revision-cancel",
        eventId: "tsunami",
        type: "VTSE41",
        reportDateTime: active.reportDateTime,
        serial: null,
        infoType: "取消",
        receivedAtMs: Date.parse("2025-01-01T00:02:02+09:00"),
        status: "通常",
        isTest: false,
      }),
      infoType: "取消",
      forecast: [],
    };
    mockParseTsunami.mockReturnValueOnce(active);
    expect(processTsunami(toWsDataMessage(
      createTelegramItem({ id: "same-revision-active" }),
      "dGVzdA==",
    ), { tsunamiState, revisionGate }).kind).toBe("ok");
    mockParseTsunami.mockReturnValueOnce(cancelled);
    expect(processTsunami(toWsDataMessage(
      createTelegramItem({ id: "same-revision-cancel" }),
      "dGVzdA==",
    ), { tsunamiState, revisionGate }).kind).toBe("ok");

    const restartedState = new TsunamiStateHolder();
    const restartedGate = new TelegramRevisionGate();
    restartedGate.restoreDurableEntries(revisionGate.exportDurableEntries());
    mockListTelegrams.mockResolvedValue(createResponse([
      createTelegramItem({ id: "stale-rest-before-cancel" }),
    ]));
    mockParseTsunami.mockReturnValueOnce({
      ...active,
      meta: { ...active.meta, messageId: "stale-rest-before-cancel" },
    });

    expect(await restoreTsunamiState("test-key", restartedState, restartedGate)).toBeNull();
    expect(restartedState.getLevel()).toBeNull();
  });

  it("persisted 訂正 active を同一 revision の通常 REST 報で巻き戻さない", async () => {
    const normal: ParsedTsunamiInfo = {
      meta: createTelegramMeta({
        messageId: "normal-before-persisted-correction",
        eventId: "tsunami",
        type: "VTSE41",
        reportDateTime: "2025-01-01T00:02:00+09:00",
        serial: null,
        infoType: "発表",
        receivedAtMs: Date.parse("2025-01-01T00:02:01+09:00"),
        status: "通常",
        isTest: false,
      }),
      type: "VTSE41",
      infoType: "発表",
      title: "津波警報・注意報・予報",
      reportDateTime: "2025-01-01T00:02:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      forecast: [{ areaName: "三陸沿岸", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "" }],
      warningComment: "",
      isTest: false,
    };
    const correction: ParsedTsunamiInfo = {
      ...normal,
      meta: createTelegramMeta({
        messageId: "persisted-correction",
        eventId: "tsunami",
        type: "VTSE41",
        reportDateTime: normal.reportDateTime,
        serial: null,
        infoType: "訂正",
        receivedAtMs: Date.parse("2025-01-01T00:02:02+09:00"),
        status: "通常",
        isTest: false,
      }),
      infoType: "訂正",
      forecast: [{ areaName: "三陸沿岸", kind: "大津波警報", maxHeightDescription: "10m超", firstHeight: "" }],
    };
    mockParseTsunami.mockReturnValueOnce(normal);
    expect(processTsunami(toWsDataMessage(
      createTelegramItem({ id: "normal-before-persisted-correction" }),
      "dGVzdA==",
    ), { tsunamiState, revisionGate }).kind).toBe("ok");
    mockParseTsunami.mockReturnValueOnce(correction);
    expect(processTsunami(toWsDataMessage(
      createTelegramItem({ id: "persisted-correction" }),
      "dGVzdA==",
    ), { tsunamiState, revisionGate }).kind).toBe("ok");

    const restartedState = new TsunamiStateHolder();
    restartedState.restorePersistedState(correction, { VTSE51: [], VTSE52: [] });
    const restartedGate = new TelegramRevisionGate();
    restartedGate.restoreDurableEntries(revisionGate.exportDurableEntries());
    mockListTelegrams.mockResolvedValue(createResponse([
      createTelegramItem({ id: "old-normal-rest" }),
    ]));
    mockParseTsunami.mockReturnValueOnce({
      ...normal,
      meta: { ...normal.meta, messageId: "old-normal-rest" },
    });

    expect(await restoreTsunamiState("test-key", restartedState, restartedGate))
      .toEqual(correction);
    expect(restartedState.getLevel()).toBe("大津波警報");
    expect(restartedState.getLastInfo()).toEqual(correction);
  });

  it("persisted VTSE41 取消 tombstone は REST 失敗後も遅延警報を拒否する", async () => {
    const active: ParsedTsunamiInfo = {
      meta: createTelegramMeta({
        messageId: "before-cancel",
        eventId: "tsunami",
        type: "VTSE41",
        reportDateTime: "2025-01-01T00:01:00+09:00",
        serial: null,
        infoType: "発表",
        receivedAtMs: Date.parse("2025-01-01T00:01:01+09:00"),
        status: "通常",
        isTest: false,
      }),
      type: "VTSE41",
      infoType: "発表",
      title: "津波警報・注意報・予報",
      reportDateTime: "2025-01-01T00:01:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      forecast: [{
        areaName: "三陸沿岸",
        kind: "津波警報",
        maxHeightDescription: "3m",
        firstHeight: "",
      }],
      warningComment: "",
      isTest: false,
    };
    const cancelled: ParsedTsunamiInfo = {
      ...active,
      meta: createTelegramMeta({
        messageId: "cancelled",
        eventId: "tsunami",
        type: "VTSE41",
        reportDateTime: "2025-01-01T00:02:00+09:00",
        serial: null,
        infoType: "取消",
        receivedAtMs: Date.parse("2025-01-01T00:02:01+09:00"),
        status: "通常",
        isTest: false,
      }),
      infoType: "取消",
      reportDateTime: "2025-01-01T00:02:00+09:00",
      forecast: [],
    };
    mockParseTsunami.mockReturnValueOnce(active);
    expect(processTsunami(toWsDataMessage(
      createTelegramItem({ id: "before-cancel" }),
      "dGVzdA==",
    ), { tsunamiState, revisionGate }).kind).toBe("ok");
    mockParseTsunami.mockReturnValueOnce(cancelled);
    expect(processTsunami(toWsDataMessage(
      createTelegramItem({ id: "cancelled" }),
      "dGVzdA==",
    ), { tsunamiState, revisionGate }).kind).toBe("ok");

    const restartedState = new TsunamiStateHolder();
    const restartedGate = new TelegramRevisionGate();
    restartedGate.restoreDurableEntries(revisionGate.exportDurableEntries());
    mockListTelegrams.mockRejectedValue(new Error("REST unavailable"));
    expect(await restoreTsunamiState("test-key", restartedState, restartedGate)).toBeNull();

    mockParseTsunami.mockReturnValueOnce({
      ...active,
      meta: { ...active.meta, messageId: "delayed-after-rest-failure" },
    });
    expect(processTsunami(toWsDataMessage(
      createTelegramItem({ id: "delayed-after-rest-failure" }),
      "dGVzdA==",
    ), { tsunamiState: restartedState, revisionGate: restartedGate }))
      .toEqual({ kind: "suppressed" });
    expect(restartedState.getLevel()).toBeNull();
  });

  it("最新の VTSE41 が取消報の場合 → 状態は null のまま", async () => {
    const item = createTelegramItem();
    mockListTelegrams.mockResolvedValue(createResponse([item]));
    mockParseTsunami.mockReturnValue({
      meta: createTelegramMeta({ messageId: "restore-2", eventId: "tsunami", type: "VTSE41", reportDateTime: "2025-01-01T00:00:00+09:00", serial: null, infoType: "取消", receivedAtMs: Date.parse("2025-01-01T00:00:01+09:00"), status: "通常", isTest: false }),
      type: "VTSE41",
      infoType: "取消",
      title: "津波警報・注意報・予報",
      reportDateTime: "2025-01-01T00:00:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      forecast: [],
      warningComment: "",
      isTest: false,
    });
    tsunamiState.applyAcceptedObservations("VTSE51", [{
      areaName: "三陸沿岸",
      stationCode: "21001",
      name: "宮古",
      sensor: "検潮所",
      arrivalTime: "",
      initial: "",
      maxHeightCondition: "観測中",
      maxHeightValue: "1.0m",
    }]);
    const persistAcceptedRevision = vi.fn(() => {
      expect(tsunamiState.getObservationGroups().VTSE51).toEqual([]);
    });

    const result = await restoreTsunamiState(
      "test-key",
      tsunamiState,
      revisionGate,
      persistAcceptedRevision,
    );

    expect(result).toBeNull();
    expect(tsunamiState.getLevel()).toBeNull();
    expect(persistAcceptedRevision).toHaveBeenCalledTimes(1);
  });

  it("VTSE41 電文がない場合 → null を返す", async () => {
    mockListTelegrams.mockResolvedValue(createResponse([]));

    const result = await restoreTsunamiState("test-key", tsunamiState, revisionGate);

    expect(result).toBeNull();
    expect(tsunamiState.getLevel()).toBeNull();
  });

  it("パースに失敗した場合 → null を返す", async () => {
    const item = createTelegramItem();
    mockListTelegrams.mockResolvedValue(createResponse([item]));
    mockParseTsunami.mockReturnValue(null);

    const result = await restoreTsunamiState("test-key", tsunamiState, revisionGate);

    expect(result).toBeNull();
    expect(tsunamiState.getLevel()).toBeNull();
  });

  it("API エラーの場合 → null を返し、例外は throw しない", async () => {
    mockListTelegrams.mockRejectedValue(new Error("API error"));

    const result = await restoreTsunamiState("test-key", tsunamiState, revisionGate);

    expect(result).toBeNull();
    expect(tsunamiState.getLevel()).toBeNull();
  });

  it("parseTsunamiTelegram に WsDataMessage 互換のオブジェクトが渡される", async () => {
    const item = createTelegramItem({
      id: "tg-123",
      classification: "telegram.earthquake",
      head: {
        type: "VTSE41",
        author: "気象庁",
        time: "2025-06-01T12:00:00+09:00",
        test: false,
        xml: true,
      },
      compression: "gzip",
      encoding: "base64",
      body: "encoded-body",
    });
    mockListTelegrams.mockResolvedValue(createResponse([item]));
    mockParseTsunami.mockReturnValue(null);

    await restoreTsunamiState("test-key", tsunamiState, revisionGate);

    const passedMsg = mockParseTsunami.mock.calls[0][0];
    expect(passedMsg.type).toBe("data");
    expect(passedMsg.id).toBe("tg-123");
    expect(passedMsg.head.type).toBe("VTSE41");
    expect(passedMsg.body).toBe("encoded-body");
    expect(passedMsg.compression).toBe("gzip");
    expect(passedMsg.encoding).toBe("base64");
  });
});
