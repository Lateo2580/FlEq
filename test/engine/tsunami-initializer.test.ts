import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { restoreTsunamiState } from "../../src/engine/startup/tsunami-initializer";
import { TsunamiStateHolder } from "../../src/engine/messages/tsunami-state";
import { TelegramRevisionGate } from "../../src/engine/messages/telegram-revision-gate";
import * as restClient from "../../src/dmdata/rest-client";
import * as log from "../../src/logger";
import type {
  ParsedTsunamiInfo,
  TelegramListItem,
  TelegramListResponse,
} from "../../src/types";
import { createTelegramMeta } from "../../src/dmdata/telegram-meta";
import {
  canonicalizeLegacyTsunamiInfo,
  canonicalizeLegacyTsunamiObservation,
  type LegacyParsedTsunamiInfoInput,
} from "../../src/dmdata/tsunami-legacy-adapter";
import { processTsunami } from "../../src/engine/presentation/processors/process-tsunami";
import { toWsDataMessageFromRestBody } from "../../src/engine/startup/telegram-adapter";
import {
  StandbyPersistence,
  type PersistedStandbyStateV1,
} from "../../src/engine/display/standby-persistence";
import { StandbyPersistenceAdmissionCoordinator } from "../../src/engine/display/standby-persistence-admission";
import { StandbyStateStore } from "../../src/engine/display/standby-state-store";
import { Vpws50StateHolder } from "../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../src/engine/messages/vpww56-state";
import { FloodForecastStateHolder } from "../../src/engine/messages/flood-forecast-state";
import {
  emptyVolcanoRepairState,
  VolcanoStateHolder,
} from "../../src/engine/messages/volcano-state";

// sound-player をモック
vi.mock("../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

// rest-client をモック (listTelegrams / fetchTelegramBody の両方)
vi.mock("../../src/dmdata/rest-client");

// telegram-parser は既定で実装をそのまま使い、必要なテストだけ差し替える
vi.mock("../../src/dmdata/telegram-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/dmdata/telegram-parser")>();
  return { ...actual, parseTsunamiTelegram: vi.fn(actual.parseTsunamiTelegram) };
});

import { parseTsunamiTelegram } from "../../src/dmdata/telegram-parser";

let actualParser: typeof import("../../src/dmdata/telegram-parser");

beforeAll(async () => {
  actualParser = await vi.importActual<typeof import("../../src/dmdata/telegram-parser")>(
    "../../src/dmdata/telegram-parser",
  );
});

const mockListTelegrams = vi.mocked(restClient.listTelegrams);
const mockFetchTelegramBody = vi.mocked(restClient.fetchTelegramBody);
const mockParseTsunami = vi.mocked(parseTsunamiTelegram);
const tempDirs: string[] = [];

/**
 * 実採取 fixture (2026-09-03)。一覧 item は body / compression / encoding を持たず、
 * `xmlReport.head.serial` は null。本文は Telegram Data v1 の生 XML (津波注意報解除)。
 */
const REAL_LIST: TelegramListResponse = JSON.parse(
  fs.readFileSync("test/fixtures/rest/telegram-list-vtse41-real.json", "utf8"),
) as TelegramListResponse;
const REAL_RELEASE_XML = fs.readFileSync(
  "test/fixtures/rest/telegram-body-vtse41-real.xml",
  "utf8",
);
const REAL_RELEASE_ITEM = REAL_LIST.items[0];

/** テスト用の fake 本文。パーサをモックするテストでは中身を読まない。 */
const FAKE_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<Report><Head/></Report>';

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

/**
 * 実 API の一覧 item 形でテスト用 TelegramListItem を生成する。
 * body / compression / encoding は持たない (一覧 API は本文を返さない)。
 */
function createTelegramItem(
  overrides: Partial<TelegramListItem> = {}
): TelegramListItem {
  const id = overrides.id ?? "test-telegram-001";
  return {
    serial: 1,
    id,
    classification: "telegram.earthquake",
    head: {
      type: "VTSE41",
      author: "JPOS",
      time: "2025-01-01T00:00:00+09:00",
      designation: null,
      test: false,
    },
    receivedTime: "2025-01-01T00:00:11.000Z",
    xmlReport: {
      head: {
        title: "津波警報・注意報・予報",
        serial: null,
        eventId: "tsunami",
        headline: null,
        infoKind: "津波警報・注意報・予報",
        infoType: "発表",
        reportDateTime: "2025-01-01T00:00:00+09:00",
        targetDateTime: "2025-01-01T00:00:00+09:00",
        infoKindVersion: "1.0_1",
      },
      control: {
        title: "津波警報・注意報・予報a",
        status: "通常",
        dateTime: "2024-12-31T15:00:10Z",
        editorialOffice: "大阪管区気象台",
        publishingOffice: "気象庁",
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
    responseTime: "2025-01-01T00:00:00.000Z",
    status: "ok",
    items,
  };
}

function legacyInfo(info: LegacyParsedTsunamiInfoInput): ParsedTsunamiInfo {
  return canonicalizeLegacyTsunamiInfo({
    ...info,
    forecast: info.forecast?.map((item, index) => {
      const { areaCode, kindCode, ...rest } = item;
      return {
        ...rest,
        areaCode: areaCode === undefined ? `test-area-${index}` : areaCode,
        kindCode: kindCode === undefined ? `test-kind-${index}` : kindCode,
      };
    }),
  });
}

/** 実採取 fixture と同じ EventID / 予報区 (有明・八代海 712) の津波注意報 (16:29 発表) */
function realEventAdvisory(messageId: string): ParsedTsunamiInfo {
  return legacyInfo({
    meta: createTelegramMeta({
      messageId,
      eventId: "20260728162718",
      type: "VTSE41",
      reportDateTime: "2026-07-28T16:29:00+09:00",
      serial: null,
      infoType: "発表",
      receivedAtMs: Date.parse("2026-07-28T07:29:00.000Z"),
      status: "通常",
      isTest: false,
    }),
    type: "VTSE41",
    infoType: "発表",
    title: "津波注意報・津波予報",
    reportDateTime: "2026-07-28T16:29:00+09:00",
    headline: "津波注意報を発表しました。",
    publishingOffice: "気象庁",
    forecast: [{
      areaCode: "712",
      areaName: "有明・八代海",
      kindCode: "62",
      kind: "津波注意報",
      maxHeightDescription: "1m",
      firstHeight: "",
    }],
    warningComment: "",
    isTest: false,
  });
}

/** 一覧 API と本文 API の両方を 1 件で応答させる */
function mockRestResponse(item: TelegramListItem, xml: string = FAKE_XML): void {
  mockListTelegrams.mockResolvedValue(createResponse([item]));
  mockFetchTelegramBody.mockResolvedValue({ kind: "ok", xml });
}

function createAdmissionCoordinator(
  tsunamiState: TsunamiStateHolder,
  revisionGate: TelegramRevisionGate,
): StandbyPersistenceAdmissionCoordinator {
  const volcanoState = new VolcanoStateHolder();
  const coordinator = new StandbyPersistenceAdmissionCoordinator({
    owners: {
      telegramRevisionGate: revisionGate,
      standbyStateStore: new StandbyStateStore(),
      vpws50State: new Vpws50StateHolder(),
      vpww56State: new Vpww56StateHolder(),
      tsunamiState,
      volcanoState,
      floodForecastState: new FloodForecastStateHolder(),
    },
    repairState: emptyVolcanoRepairState(),
  });
  return coordinator;
}

describe("restoreTsunamiState", () => {
  let tsunamiState: TsunamiStateHolder;
  let revisionGate: TelegramRevisionGate;

  beforeEach(() => {
    tsunamiState = new TsunamiStateHolder();
    revisionGate = new TelegramRevisionGate();
    vi.clearAllMocks();
    mockParseTsunami.mockReset();
    mockParseTsunami.mockImplementation(actualParser.parseTsunamiTelegram);
    mockFetchTelegramBody.mockReset();
    mockFetchTelegramBody.mockResolvedValue({ kind: "ok", xml: FAKE_XML });
  });

  it("最新の VTSE41 に警報がある場合 → 状態を復元する", async () => {
    const item = createTelegramItem();
    mockRestResponse(item);
    mockParseTsunami.mockReturnValue(legacyInfo({
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
    }));

    const result = await restoreTsunamiState("test-key", tsunamiState, revisionGate);

    expect(result).not.toBeNull();
    expect(tsunamiState.getLevel()).toBe("津波警報");
    expect(mockListTelegrams).toHaveBeenCalledWith("test-key", { type: "VTSE41", limit: 1 });
  });

  it("一覧 item の id と url で本文を取得する (url は expectedUrl として渡す)", async () => {
    const item = createTelegramItem({ id: "tg-real-id" });
    mockRestResponse(item);
    mockParseTsunami.mockReturnValue(null);

    await restoreTsunamiState("test-key", tsunamiState, revisionGate);

    expect(mockFetchTelegramBody).toHaveBeenCalledTimes(1);
    expect(mockFetchTelegramBody).toHaveBeenCalledWith(
      "test-key",
      "tg-real-id",
      "https://data.api.dmdata.jp/v1/tg-real-id",
    );
  });

  it("REST 復元を共通 gate の watermark として seed し、遅着旧報を拒否する", async () => {
    const item = createTelegramItem({ id: "restore-new" });
    mockRestResponse(item);
    const restored = legacyInfo({
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
    });
    mockParseTsunami.mockReturnValueOnce(restored);
    expect(await restoreTsunamiState("test-key", tsunamiState, revisionGate)).not.toBeNull();

    mockParseTsunami.mockReturnValueOnce({
      ...restored,
      meta: createTelegramMeta({ messageId: "delayed-old", eventId: "tsunami", type: "VTSE41", reportDateTime: "2025-01-01T00:01:00+09:00", serial: null, infoType: "発表", receivedAtMs: Date.parse("2025-01-01T00:03:00+09:00"), status: "通常", isTest: false }),
      reportDateTime: "2025-01-01T00:01:00+09:00",
    });
    const delayedMessage = toWsDataMessageFromRestBody(
      createTelegramItem({ id: "delayed-old" }),
      FAKE_XML,
    );
    expect(processTsunami(delayedMessage, { tsunamiState, revisionGate }))
      .toEqual({ kind: "suppressed" });
    expect(tsunamiState.getLastInfo()?.reportDateTime).toBe("2025-01-01T00:02:00+09:00");
  });

  it("persisted watermark と同じ REST 報でも空 holder を安全に再構成する", async () => {
    const active = legacyInfo({
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
    });
    mockParseTsunami.mockReturnValueOnce(active);
    expect(processTsunami(toWsDataMessageFromRestBody(
      createTelegramItem({ id: "persisted-active" }),
      FAKE_XML,
    ), { tsunamiState, revisionGate }).kind).toBe("ok");

    const restartedState = new TsunamiStateHolder();
    const restartedGate = new TelegramRevisionGate();
    restartedGate.restoreDurableEntries(revisionGate.exportDurableEntries());
    mockRestResponse(createTelegramItem({ id: "same-rest-active" }));
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

  it("holder と gate の両方が永続復元済みなら、同一電文の REST は suppressed で状態も永続化通知も変えない", async () => {
    const active = realEventAdvisory("persisted-both");
    mockParseTsunami.mockReturnValueOnce(active);
    expect(processTsunami(toWsDataMessageFromRestBody(
      createTelegramItem({ id: "persisted-both" }),
      FAKE_XML,
    ), { tsunamiState, revisionGate }).kind).toBe("ok");

    const restartedState = new TsunamiStateHolder();
    restartedState.restorePersistedState(null, { VTSE51: [], VTSE52: [] }, [active]);
    const restartedGate = new TelegramRevisionGate();
    restartedGate.restoreDurableEntries(revisionGate.exportDurableEntries());
    expect(restartedState.getLevel()).toBe("津波注意報");

    mockRestResponse(createTelegramItem({ id: "same-rest-both" }));
    mockParseTsunami.mockReturnValueOnce({
      ...active,
      meta: { ...active.meta, messageId: "same-rest-both" },
    });
    const persist = vi.fn();

    expect(await restoreTsunamiState("test-key", restartedState, restartedGate, persist))
      .toEqual(expect.objectContaining({ reportDateTime: active.reportDateTime }));
    expect(restartedState.getLevel()).toBe("津波注意報");
    expect(restartedState.getLastInfo()?.meta.messageId).toBe("persisted-both");
    // 既に永続化済みの状態を再構成していないので、永続化予約は増えない
    expect(persist).not.toHaveBeenCalled();
  });

  it("persisted active なしで REST が部分取消を返しても空 holder を再構成しない", async () => {
    const active = legacyInfo({
      meta: createTelegramMeta({
        messageId: "partial-restore-active",
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
      warningComment: "",
      isTest: false,
    });
    const cancellation = legacyInfo({
      ...active,
      meta: createTelegramMeta({
        messageId: "partial-restore-cancellation",
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
      forecast: [{
        areaCode: "210",
        areaName: "解除対象",
        kindCode: "51",
        kind: "津波警報",
        maxHeightDescription: "3m",
        firstHeight: "",
      }],
    });
    mockParseTsunami.mockReturnValueOnce(active);
    expect(processTsunami(toWsDataMessageFromRestBody(
      createTelegramItem({ id: "partial-restore-active" }),
      FAKE_XML,
    ), { tsunamiState, revisionGate }).kind).toBe("ok");
    mockParseTsunami.mockReturnValueOnce(cancellation);
    expect(processTsunami(toWsDataMessageFromRestBody(
      createTelegramItem({ id: "partial-restore-cancellation" }),
      FAKE_XML,
    ), { tsunamiState, revisionGate }).kind).toBe("ok");

    const restartedState = new TsunamiStateHolder();
    const restartedGate = new TelegramRevisionGate();
    restartedGate.restoreDurableEntries(revisionGate.exportDurableEntries());
    mockRestResponse(createTelegramItem({ id: "partial-restore-cancellation-rest" }));
    mockParseTsunami.mockReturnValueOnce({
      ...cancellation,
      meta: { ...cancellation.meta, messageId: "partial-restore-cancellation-rest" },
    });

    expect(await restoreTsunamiState("test-key", restartedState, restartedGate)).toBeNull();
    expect(restartedState.getLastInfo()).toBeNull();
    expect(restartedState.getLevel()).toBeNull();
  });

  it("同一 revision 訂正後の active を実ファイル往復し、REST 不通でも維持する", async () => {
    const normal = legacyInfo({
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
    });
    const correction = legacyInfo({
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
    });
    mockParseTsunami.mockReturnValueOnce(normal);
    expect(processTsunami(toWsDataMessageFromRestBody(
      createTelegramItem({ id: "normal-before-correction" }),
      FAKE_XML,
    ), { tsunamiState, revisionGate }).kind).toBe("ok");
    mockParseTsunami.mockReturnValueOnce(correction);
    expect(processTsunami(toWsDataMessageFromRestBody(
      createTelegramItem({ id: "major-correction" }),
      FAKE_XML,
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
    const active = legacyInfo({
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
    });
    const cancelled = legacyInfo({
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
    });
    mockParseTsunami.mockReturnValueOnce(active);
    expect(processTsunami(toWsDataMessageFromRestBody(
      createTelegramItem({ id: "same-revision-active" }),
      FAKE_XML,
    ), { tsunamiState, revisionGate }).kind).toBe("ok");
    mockParseTsunami.mockReturnValueOnce(cancelled);
    expect(processTsunami(toWsDataMessageFromRestBody(
      createTelegramItem({ id: "same-revision-cancel" }),
      FAKE_XML,
    ), { tsunamiState, revisionGate }).kind).toBe("ok");

    const restartedState = new TsunamiStateHolder();
    const restartedGate = new TelegramRevisionGate();
    restartedGate.restoreDurableEntries(revisionGate.exportDurableEntries());
    mockRestResponse(createTelegramItem({ id: "stale-rest-before-cancel" }));
    mockParseTsunami.mockReturnValueOnce({
      ...active,
      meta: { ...active.meta, messageId: "stale-rest-before-cancel" },
    });

    expect(await restoreTsunamiState("test-key", restartedState, restartedGate)).toBeNull();
    expect(restartedState.getLevel()).toBeNull();
  });

  it("persisted 訂正 active を同一 revision の通常 REST 報で巻き戻さない", async () => {
    const normal = legacyInfo({
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
    });
    const correction = legacyInfo({
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
    });
    mockParseTsunami.mockReturnValueOnce(normal);
    expect(processTsunami(toWsDataMessageFromRestBody(
      createTelegramItem({ id: "normal-before-persisted-correction" }),
      FAKE_XML,
    ), { tsunamiState, revisionGate }).kind).toBe("ok");
    mockParseTsunami.mockReturnValueOnce(correction);
    expect(processTsunami(toWsDataMessageFromRestBody(
      createTelegramItem({ id: "persisted-correction" }),
      FAKE_XML,
    ), { tsunamiState, revisionGate }).kind).toBe("ok");

    const restartedState = new TsunamiStateHolder();
    restartedState.restorePersistedState(correction, { VTSE51: [], VTSE52: [] });
    const restartedGate = new TelegramRevisionGate();
    restartedGate.restoreDurableEntries(revisionGate.exportDurableEntries());
    mockRestResponse(createTelegramItem({ id: "old-normal-rest" }));
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
    const active = legacyInfo({
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
    });
    const cancelled = legacyInfo({
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
    });
    mockParseTsunami.mockReturnValueOnce(active);
    expect(processTsunami(toWsDataMessageFromRestBody(
      createTelegramItem({ id: "before-cancel" }),
      FAKE_XML,
    ), { tsunamiState, revisionGate }).kind).toBe("ok");
    mockParseTsunami.mockReturnValueOnce(cancelled);
    expect(processTsunami(toWsDataMessageFromRestBody(
      createTelegramItem({ id: "cancelled" }),
      FAKE_XML,
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
    expect(processTsunami(toWsDataMessageFromRestBody(
      createTelegramItem({ id: "delayed-after-rest-failure" }),
      FAKE_XML,
    ), { tsunamiState: restartedState, revisionGate: restartedGate }))
      .toEqual({ kind: "suppressed" });
    expect(restartedState.getLevel()).toBeNull();
  });

  it("最新の VTSE41 が取消報の場合 → 状態は null のまま", async () => {
    const item = createTelegramItem();
    mockRestResponse(item);
    mockParseTsunami.mockReturnValue(legacyInfo({
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
    }));
    tsunamiState.applyAcceptedObservations("VTSE51", [canonicalizeLegacyTsunamiObservation({
      areaName: "三陸沿岸",
      stationCode: "21001",
      name: "宮古",
      sensor: "検潮所",
      arrivalTime: "",
      initial: "",
      maxHeightCondition: "観測中",
      maxHeightValue: "1.0m",
    })]);
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

  it("VTSE41 電文がない場合 → null を返し、本文取得もしない", async () => {
    mockListTelegrams.mockResolvedValue(createResponse([]));

    const result = await restoreTsunamiState("test-key", tsunamiState, revisionGate);

    expect(result).toBeNull();
    expect(tsunamiState.getLevel()).toBeNull();
    expect(mockFetchTelegramBody).not.toHaveBeenCalled();
  });

  it("パースに失敗した場合 → null を返す", async () => {
    const item = createTelegramItem();
    mockRestResponse(item);
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

  describe("本文取得の失敗", () => {
    const reasons = ["forbidden", "notFound", "network", "contentType", "tooLarge"] as const;

    for (const reason of reasons) {
      it(`fetchTelegramBody が ${reason} → reason 付き warn を出して null、パーサへ到達しない`, async () => {
        const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
        mockListTelegrams.mockResolvedValue(createResponse([createTelegramItem({ id: "tg-fail" })]));
        mockFetchTelegramBody.mockResolvedValue({ kind: "failed", reason });

        const result = await restoreTsunamiState("test-key", tsunamiState, revisionGate);

        expect(result).toBeNull();
        expect(tsunamiState.getLevel()).toBeNull();
        expect(mockParseTsunami).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(`reason=${reason}`);
        expect(warn.mock.calls[0][0]).toContain("id=tg-fail");
        warn.mockRestore();
      });
    }

    it("本文取得失敗でも永続復元済みの警報状態は維持され、起動を妨げない", async () => {
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const active = realEventAdvisory("persisted-before-fetch-failure");
      tsunamiState.restorePersistedState(null, { VTSE51: [], VTSE52: [] }, [active]);
      mockListTelegrams.mockResolvedValue(createResponse([createTelegramItem({ id: "tg-403" })]));
      mockFetchTelegramBody.mockResolvedValue({ kind: "failed", reason: "forbidden" });
      const persist = vi.fn();

      await expect(restoreTsunamiState("test-key", tsunamiState, revisionGate, persist))
        .resolves.toBeNull();

      expect(tsunamiState.getLevel()).toBe("津波注意報");
      expect(persist).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });

  describe("実採取 fixture (VTSE41 一覧 + Telegram Data v1 本文)", () => {
    it("parseTsunamiTelegram に本文 XML を載せた WsDataMessage が渡り、receivedAtMs は head.time 由来", async () => {
      mockRestResponse(REAL_RELEASE_ITEM, REAL_RELEASE_XML);

      await restoreTsunamiState("test-key", tsunamiState, revisionGate);

      expect(mockParseTsunami).toHaveBeenCalledTimes(1);
      const passedMsg = mockParseTsunami.mock.calls[0][0];
      expect(passedMsg.type).toBe("data");
      expect(passedMsg.id).toBe(REAL_RELEASE_ITEM.id);
      expect(passedMsg.head.type).toBe("VTSE41");
      expect(passedMsg.body).toBe(REAL_RELEASE_XML);
      expect(passedMsg.compression).toBeNull();
      expect(passedMsg.encoding).toBe("utf-8");
      const parsed = mockParseTsunami.mock.results[0].value;
      expect(parsed).not.toBeNull();
      expect(parsed!.meta.receivedAtMs).toBe(Date.parse(REAL_RELEASE_ITEM.head.time));
      expect(parsed!.meta.receivedAtMs).toBe(Date.parse("2026-07-28T09:10:00.000Z"));
      // serial null の実採取形でも identity は eventId / reportDateTime で立つ
      expect(parsed!.meta.eventId.value).toBe("20260728162718");
      expect(parsed!.meta.serial.raw).toBeNull();
    });

    // 全解除後は holder の level/lastInfo が null になるため、gate 通過の証明は
    // persist 呼び出し・gate watermark の前進・restoreTsunamiState の返り値で立てる
    // (旧版は getLastInfo() が解除報を保持する前提だったが、それは
    //  normalizeTsunamiKind が「津波注意報解除」を「津波注意報」へ潰していた頃の挙動)。
    it("永続復元済みの津波注意報が、停止中の解除電文を REST 経由で受理して解ける", async () => {
      const persisted = realEventAdvisory("persisted-advisory-1629");
      mockParseTsunami.mockReturnValueOnce(persisted);
      expect(processTsunami(toWsDataMessageFromRestBody(
        createTelegramItem({ id: "persisted-advisory-1629" }),
        FAKE_XML,
      ), { tsunamiState, revisionGate }).kind).toBe("ok");

      const restartedState = new TsunamiStateHolder();
      restartedState.restorePersistedState(null, { VTSE51: [], VTSE52: [] }, [persisted]);
      const restartedGate = new TelegramRevisionGate();
      restartedGate.restoreDurableEntries(revisionGate.exportDurableEntries());
      expect(restartedState.getLevel()).toBe("津波注意報");

      mockRestResponse(REAL_RELEASE_ITEM, REAL_RELEASE_XML);
      const persist = vi.fn();

      // 18:10 の解除報 (同一 EventID・reportDateTime が新しい) が gate を通過する
      expect(
        await restoreTsunamiState("test-key", restartedState, restartedGate, persist),
      ).toBeNull();
      expect(persist).toHaveBeenCalledTimes(1);

      // gate watermark が解除報まで前進している
      expect(restartedGate.exportDurableEntries()).toEqual([
        expect.objectContaining({
          domain: "tsunami",
          revisionFamily: "VTSE41",
          stateSubjectKey: "tsunami:20260728162718",
          comparison: expect.objectContaining({
            revision: expect.objectContaining({
              reportDateTime: expect.objectContaining({ raw: "2026-07-28T18:10:00+09:00" }),
            }),
          }),
        }),
      ]);

      // 全解除なので active state は解ける
      expect(restartedState.getLevel()).toBeNull();
      expect(restartedState.getLastInfo()).toBeNull();
      expect(restartedState.getPersistedActive()).toBeNull();
    });
  });

  describe("persistenceAdmission 経由 (永続復元済み composition との同時実行)", () => {
    function persistedRestart(persisted: ParsedTsunamiInfo, sourceGate: TelegramRevisionGate) {
      const state = new TsunamiStateHolder();
      const gate = new TelegramRevisionGate();
      const admission = createAdmissionCoordinator(state, gate);
      const seedState = new TsunamiStateHolder();
      seedState.restorePersistedState(null, { VTSE51: [], VTSE52: [] }, [persisted]);
      const seedGate = new TelegramRevisionGate();
      seedGate.restoreDurableEntries(sourceGate.exportDurableEntries());
      const volcano = new VolcanoStateHolder();
      admission.restorePrevalidated({
        telegramRevisionGate: seedGate.cloneSnapshot(),
        standbyStateStore: new StandbyStateStore().cloneSnapshot(),
        vpws50State: new Vpws50StateHolder().cloneSnapshot(),
        vpww56State: new Vpww56StateHolder().cloneSnapshot(),
        tsunamiState: seedState.cloneSnapshot(),
        volcanoHolderAndRepair: {
          runtimeVersion: volcano.version(),
          holder: volcano.snapshot(),
          repair: emptyVolcanoRepairState(),
        },
        floodForecastState: new FloodForecastStateHolder().cloneSnapshot(),
      });
      expect(state.getLevel()).toBe("津波注意報");
      return { state, gate, admission };
    }

    it("永続復元済み composition に REST の新しい報を transaction で合流させる", async () => {
      const persisted = realEventAdvisory("admission-persisted");
      mockParseTsunami.mockReturnValueOnce(persisted);
      expect(processTsunami(toWsDataMessageFromRestBody(
        createTelegramItem({ id: "admission-persisted" }),
        FAKE_XML,
      ), { tsunamiState, revisionGate }).kind).toBe("ok");
      const { state, gate, admission } = persistedRestart(persisted, revisionGate);

      mockRestResponse(REAL_RELEASE_ITEM, REAL_RELEASE_XML);
      const persist = vi.fn();
      await restoreTsunamiState("test-key", state, gate, persist, admission);

      expect(persist).toHaveBeenCalledTimes(1);
      // 合流対象は 18:10 の全解除報なので、holder の active state は解ける
      // (旧版は getLastInfo() が解除報を保持する前提だった。normalizeTsunamiKind が
      //  「津波注意報解除」を「津波注意報」へ潰していた頃の挙動)。
      expect(state.getLevel()).toBeNull();
      expect(state.getLastInfo()).toBeNull();
      // gate の watermark も同じ transaction で 18:10 まで進む
      expect(gate.exportDurableEntries()).toEqual([
        expect.objectContaining({
          domain: "tsunami",
          revisionFamily: "VTSE41",
          stateSubjectKey: "tsunami:20260728162718",
          comparison: expect.objectContaining({
            revision: expect.objectContaining({
              reportDateTime: expect.objectContaining({ raw: "2026-07-28T18:10:00+09:00" }),
            }),
          }),
        }),
      ]);
    });

    it("REST await 中に届いた live 電文 (REST より新しい) を REST 結果で上書きしない", async () => {
      const persisted = realEventAdvisory("admission-persisted-live");
      mockParseTsunami.mockReturnValueOnce(persisted);
      expect(processTsunami(toWsDataMessageFromRestBody(
        createTelegramItem({ id: "admission-persisted-live" }),
        FAKE_XML,
      ), { tsunamiState, revisionGate }).kind).toBe("ok");
      const { state, gate, admission } = persistedRestart(persisted, revisionGate);

      // live: 17:00 の続報 (注意報継続・波高更新)。REST 待ちの間に WS から到着する。
      const live = legacyInfo({
        ...persisted,
        meta: createTelegramMeta({
          messageId: "live-during-rest",
          eventId: "20260728162718",
          type: "VTSE41",
          reportDateTime: "2026-07-28T17:00:00+09:00",
          serial: null,
          infoType: "発表",
          receivedAtMs: Date.parse("2026-07-28T08:00:05.000Z"),
          status: "通常",
          isTest: false,
        }),
        reportDateTime: "2026-07-28T17:00:00+09:00",
        forecast: [{
          areaCode: "712",
          areaName: "有明・八代海",
          kindCode: "62",
          kind: "津波注意報",
          maxHeightDescription: "0.5m",
          firstHeight: "",
        }],
      });
      // REST: 16:45 の続報 (live より古い)
      const rest = legacyInfo({
        ...persisted,
        meta: createTelegramMeta({
          messageId: "rest-older-than-live",
          eventId: "20260728162718",
          type: "VTSE41",
          reportDateTime: "2026-07-28T16:45:00+09:00",
          serial: null,
          infoType: "発表",
          receivedAtMs: Date.parse("2026-07-28T07:45:00.000Z"),
          status: "通常",
          isTest: false,
        }),
        reportDateTime: "2026-07-28T16:45:00+09:00",
      });
      mockParseTsunami.mockImplementation((msg) =>
        msg.id === "live-during-rest" ? live : msg.id === "rest-older-than-live" ? rest : null);
      mockFetchTelegramBody.mockResolvedValue({ kind: "ok", xml: FAKE_XML });
      mockListTelegrams.mockImplementation(async () => {
        // 一覧 await 中の live 受信: 同じ admission transaction 経路を通る
        const liveResult = processTsunami(toWsDataMessageFromRestBody(
          createTelegramItem({ id: "live-during-rest", head: {
            type: "VTSE41", author: "JPOS", time: "2026-07-28T08:00:00.000Z", designation: null, test: false,
          } }),
          FAKE_XML,
          Date.parse("2026-07-28T08:00:05.000Z"),
        ), { tsunamiState: state, revisionGate: gate, persistenceAdmission: admission });
        expect(liveResult.kind).toBe("ok");
        return createResponse([createTelegramItem({
          id: "rest-older-than-live",
          head: { type: "VTSE41", author: "JPOS", time: "2026-07-28T07:45:00.000Z", designation: null, test: false },
        })]);
      });
      const persist = vi.fn();

      const result = await restoreTsunamiState("test-key", state, gate, persist, admission);

      // REST は stale として gate に拒否され、live の 17:00 が残る
      expect(result).toEqual(expect.objectContaining({ reportDateTime: "2026-07-28T17:00:00+09:00" }));
      expect(state.getLastInfo()?.meta.messageId).toBe("live-during-rest");
      expect(state.getLastInfo()?.forecast?.[0]?.maxHeightDescription).toBe("0.5m");
      expect(persist).not.toHaveBeenCalled();
    });
  });
});
