import { describe, it, expect, vi, beforeEach } from "vitest";
import { restoreTsunamiState } from "../../src/engine/startup/tsunami-initializer";
import { TsunamiStateHolder } from "../../src/engine/messages/tsunami-state";
import * as restClient from "../../src/dmdata/rest-client";
import { TelegramListItem, TelegramListResponse } from "../../src/types";

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

  beforeEach(() => {
    tsunamiState = new TsunamiStateHolder();
    vi.clearAllMocks();
  });

  it("最新の VTSE41 に警報がある場合 → 状態を復元する", async () => {
    const item = createTelegramItem();
    mockListTelegrams.mockResolvedValue(createResponse([item]));
    mockParseTsunami.mockReturnValue({
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

    const result = await restoreTsunamiState("test-key", tsunamiState);

    expect(result).not.toBeNull();
    expect(tsunamiState.getLevel()).toBe("津波警報");
    expect(mockListTelegrams).toHaveBeenCalledWith("test-key", "VTSE41", 1);
  });

  it("最新の VTSE41 が取消報の場合 → 状態は null のまま", async () => {
    const item = createTelegramItem();
    mockListTelegrams.mockResolvedValue(createResponse([item]));
    mockParseTsunami.mockReturnValue({
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

    const result = await restoreTsunamiState("test-key", tsunamiState);

    expect(result).toBeNull();
    expect(tsunamiState.getLevel()).toBeNull();
  });

  it("VTSE41 電文がない場合 → null を返す", async () => {
    mockListTelegrams.mockResolvedValue(createResponse([]));

    const result = await restoreTsunamiState("test-key", tsunamiState);

    expect(result).toBeNull();
    expect(tsunamiState.getLevel()).toBeNull();
  });

  it("パースに失敗した場合 → null を返す", async () => {
    const item = createTelegramItem();
    mockListTelegrams.mockResolvedValue(createResponse([item]));
    mockParseTsunami.mockReturnValue(null);

    const result = await restoreTsunamiState("test-key", tsunamiState);

    expect(result).toBeNull();
    expect(tsunamiState.getLevel()).toBeNull();
  });

  it("API エラーの場合 → null を返し、例外は throw しない", async () => {
    mockListTelegrams.mockRejectedValue(new Error("API error"));

    const result = await restoreTsunamiState("test-key", tsunamiState);

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

    await restoreTsunamiState("test-key", tsunamiState);

    const passedMsg = mockParseTsunami.mock.calls[0][0];
    expect(passedMsg.type).toBe("data");
    expect(passedMsg.id).toBe("tg-123");
    expect(passedMsg.head.type).toBe("VTSE41");
    expect(passedMsg.body).toBe("encoded-body");
    expect(passedMsg.compression).toBe("gzip");
    expect(passedMsg.encoding).toBe("base64");
  });
});
