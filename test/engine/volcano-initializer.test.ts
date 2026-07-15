import { describe, it, expect, vi, beforeEach } from "vitest";
import { restoreVolcanoState } from "../../src/engine/startup/volcano-initializer";
import { VolcanoStateHolder } from "../../src/engine/messages/volcano-state";
import * as restClient from "../../src/dmdata/rest-client";
import {
  ParsedVolcanoAlertInfo,
  TelegramListItem,
  TelegramListResponse,
  WsDataMessage,
} from "../../src/types";

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
    ).resolves.toBeUndefined();
    expect(volcanoState.size()).toBe(0);
  });
});
