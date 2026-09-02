import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ── https モック ──

interface MockResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
}

interface MockRequest extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  setTimeout: (ms: number, cb: () => void) => void;
  /** テストから setTimeout のコールバックを発火させる窓口 */
  _triggerTimeout: () => void;
}

let lastMockReq: MockRequest;
let lastMockRes: MockResponse;
let requestCallback: ((res: MockResponse) => void) | null = null;
let lastRequestOptions: Record<string, unknown> | null = null;
/** https.request が呼ばれるたびに蓄積するキュー（リトライテスト用） */
let requestCallbacks: Array<(res: MockResponse) => void> = [];
let requestCount = 0;

function createMockRequest(): MockRequest {
  const emitter = new EventEmitter() as MockRequest;
  emitter.write = vi.fn();
  emitter.end = vi.fn();
  emitter.destroy = vi.fn((err?: Error) => {
    emitter.emit("error", err ?? new Error("destroyed"));
  });
  let timeoutCb: (() => void) | null = null;
  emitter.setTimeout = (_ms: number, cb: () => void) => {
    timeoutCb = cb;
  };
  // expose timeout trigger for tests
  emitter._triggerTimeout = () => {
    if (timeoutCb) timeoutCb();
  };
  return emitter;
}

function createMockResponse(
  statusCode: number,
  headers: Record<string, string> = { "content-type": "application/json" }
): MockResponse {
  const res = new EventEmitter() as MockResponse;
  res.statusCode = statusCode;
  res.headers = headers;
  return res;
}

vi.mock("https", () => ({
  default: {
    request: (
      options: unknown,
      callback: (res: MockResponse) => void
    ) => {
      lastRequestOptions = options as Record<string, unknown>;
      requestCallback = callback;
      requestCallbacks.push(callback);
      requestCount++;
      lastMockReq = createMockRequest();
      return lastMockReq;
    },
    Agent: class MockAgent {
      constructor(_opts?: Record<string, unknown>) {
        // stub
      }
    },
  },
}));

vi.mock("../../src/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import {
  listContracts,
  listEarthquakes,
  listSockets,
  listTelegrams,
  closeSocket,
  startSocket,
  fetchTelegramBody,
  TELEGRAM_DATA_BASE,
  TELEGRAM_BODY_MAX_BYTES,
} from "../../src/dmdata/rest-client";
import { AppConfig, DEFAULT_CONFIG, TelegramListResponse } from "../../src/types";
import { readFileSync } from "fs";
import { resolve } from "path";

function respondWith(
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>
): void {
  lastMockRes = createMockResponse(statusCode, {
    "content-type": "application/json",
    ...headers,
  });
  requestCallback!(lastMockRes);
  lastMockRes.emit("data", JSON.stringify(body));
  lastMockRes.emit("end");
}

/** 特定の requestCallback に対してレスポンスを返す（リトライテスト用） */
function respondToNth(
  index: number,
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>
): void {
  const cb = requestCallbacks[index];
  if (cb == null) throw new Error(`requestCallbacks[${index}] is not set`);
  const res = createMockResponse(statusCode, {
    "content-type": "application/json",
    ...headers,
  });
  cb(res);
  res.emit("data", JSON.stringify(body));
  res.emit("end");
}

function respondWithRaw(
  statusCode: number,
  rawBody: string,
  headers?: Record<string, string>
): void {
  lastMockRes = createMockResponse(statusCode, {
    "content-type": "application/json",
    ...headers,
  });
  requestCallback!(lastMockRes);
  lastMockRes.emit("data", rawBody);
  lastMockRes.emit("end");
}

const TEST_API_KEY = "test-key";

describe("REST Client", () => {
  beforeEach(() => {
    requestCallback = null;
    lastRequestOptions = null;
    requestCallbacks = [];
    requestCount = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("listContracts", () => {
    it("正常な JSON レスポンスから契約済み区分を返す", async () => {
      const promise = listContracts(TEST_API_KEY);

      respondWith(200, {
        responseId: "r1",
        responseTime: "2024-01-01",
        status: "ok",
        items: [
          { id: 1, classification: "telegram.earthquake", isValid: true },
          { id: 2, classification: "eew.forecast", isValid: true },
          { id: 3, classification: "old.expired", isValid: false },
        ],
      });

      const result = await promise;
      expect(result).toEqual(["telegram.earthquake", "eew.forecast"]);
      expect(lastRequestOptions).toMatchObject({
        path: "/v2/contract",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from(`${TEST_API_KEY}:`).toString("base64")}`,
          Accept: "application/json",
        }),
      });
    });

    it("エラーステータスの場合 throw する", async () => {
      const promise = listContracts(TEST_API_KEY);

      respondWith(200, {
        status: "error",
        error: { message: "invalid key", code: 401 },
      });

      await expect(promise).rejects.toThrow("Contract List failed");
    });
  });

  describe("HTTP ステータスコード", () => {
    it("204 No Content を正常処理する", async () => {
      const promise = closeSocket(TEST_API_KEY, 1);

      lastMockRes = createMockResponse(204, {});
      requestCallback!(lastMockRes);
      lastMockRes.emit("data", "");
      lastMockRes.emit("end");

      // 204 は {} を返すので closeSocket はエラーにならない
      await promise;
    });

    it("HTTP 非2xx でリジェクトする", async () => {
      const promise = listContracts(TEST_API_KEY);

      respondWith(403, {
        error: { message: "Forbidden", code: 403 },
      });

      await expect(promise).rejects.toThrow("HTTP 403");
    });
  });

  describe("Content-Type チェック", () => {
    it("JSON でない Content-Type を拒否する", async () => {
      const promise = listContracts(TEST_API_KEY);

      lastMockRes = createMockResponse(200, {
        "content-type": "text/html",
      });
      requestCallback!(lastMockRes);
      lastMockRes.emit("data", "<html>error</html>");
      lastMockRes.emit("end");

      await expect(promise).rejects.toThrow("予期しない Content-Type");
    });
  });

  describe("タイムアウト", () => {
    it("15秒タイムアウトで接続を破棄する", async () => {
      const promise = listContracts(TEST_API_KEY);

      // タイムアウトをトリガー
      lastMockReq._triggerTimeout();

      await expect(promise).rejects.toThrow("Request timeout (15s)");
    });
  });

  describe("ネットワークエラー", () => {
    it("接続エラーでリジェクトする", async () => {
      const promise = listContracts(TEST_API_KEY);

      lastMockReq.emit("error", new Error("ECONNREFUSED"));

      await expect(promise).rejects.toThrow("ECONNREFUSED");
    });
  });

  describe("closeSocket", () => {
    it("正常にソケットを閉じる", async () => {
      const promise = closeSocket(TEST_API_KEY, 42);

      respondWith(200, { status: "ok" });

      await promise; // エラーなしで完了
    });

    it("エラーレスポンスの場合はログ警告のみ（throw しない）", async () => {
      const log = await import("../../src/logger");
      const promise = closeSocket(TEST_API_KEY, 42);

      respondWith(200, {
        status: "error",
        error: { message: "not found", code: 404 },
      });

      await promise;
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Socket Close failed")
      );
    });
  });

  describe("startSocket", () => {
    it("正常に WebSocket URL を取得する", async () => {
      const config: AppConfig = {
        apiKey: TEST_API_KEY,
        // 既定値を土台に敷き、以降の明示値で上書きする (AppConfig にフィールドが増えても壊れない)
        ...DEFAULT_CONFIG,
        classifications: ["telegram.earthquake"],
        testMode: "no",
        appName: "test",
        maxReconnectDelaySec: 60,
        keepExistingConnections: false,
        tableWidth: null,
        infoFullText: false,
        displayMode: "normal",
        promptClock: "elapsed",
        waitTipIntervalMin: 30,
        notify: { ...DEFAULT_CONFIG.notify },
        sound: true,
        eewLog: true,
        eewLogFields: { ...DEFAULT_CONFIG.eewLogFields },
        maxObservations: null,
        backup: false,
        truncation: { ...DEFAULT_CONFIG.truncation },
      };

      const promise = startSocket(config);

      respondWith(200, {
        responseId: "r1",
        responseTime: "2024-01-01",
        status: "ok",
        websocket: {
          id: 1,
          url: "wss://ws.example.com",
          protocol: ["dmdata.v2"],
          expiration: 300,
        },
      });

      const result = await promise;
      expect(result.websocket!.url).toBe("wss://ws.example.com");
    });
  });

  describe("listEarthquakes", () => {
    it("地震履歴を取得する", async () => {
      const promise = listEarthquakes(TEST_API_KEY, 5);

      respondWith(200, {
        responseId: "r1",
        responseTime: "2024-01-01",
        status: "ok",
        items: [{ id: 1, eventId: "ev1" }],
      });

      const result = await promise;
      expect(result.items).toHaveLength(1);
    });

    it("エラーステータスで throw する", async () => {
      const promise = listEarthquakes(TEST_API_KEY);

      respondWith(200, {
        status: "error",
        error: { message: "failed", code: 500 },
      });

      await expect(promise).rejects.toThrow("Earthquake List failed");
    });
  });

  describe("listSockets", () => {
    it("ソケット一覧を取得する", async () => {
      const promise = listSockets(TEST_API_KEY);

      respondWith(200, {
        responseId: "r1",
        responseTime: "2024-01-01",
        status: "ok",
        items: [{ id: 1, status: "open" }],
      });

      const result = await promise;
      expect(result.items).toHaveLength(1);
    });
  });

  describe("リトライ機構", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("503 レスポンスをリトライして成功する", async () => {
      const promise = listContracts(TEST_API_KEY);

      // 1回目: 503
      respondWith(503, { error: { message: "Service Unavailable", code: 503 } });

      // リトライ待機のタイマーを進める
      await vi.advanceTimersByTimeAsync(2_000);

      // 2回目: 成功
      respondWith(200, {
        responseId: "r1",
        responseTime: "2024-01-01",
        status: "ok",
        items: [{ id: 1, classification: "telegram.earthquake", isValid: true }],
      });

      const result = await promise;
      expect(result).toEqual(["telegram.earthquake"]);
      expect(requestCount).toBe(2);
    });

    it("429 で Retry-After ヘッダーを尊重する", async () => {
      const log = await import("../../src/logger");
      const promise = listContracts(TEST_API_KEY);

      // 1回目: 429 with Retry-After: 5
      respondWith(429, { error: { message: "Rate Limited", code: 429 } }, {
        "retry-after": "5",
      });

      // log.warn がリトライメッセージを出力していることを確認
      await vi.advanceTimersByTimeAsync(100);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("リトライします")
      );

      // Retry-After の 5秒 + ジッターを十分カバーする時間を進める
      await vi.advanceTimersByTimeAsync(6_000);

      // 2回目: 成功
      respondWith(200, {
        responseId: "r1",
        responseTime: "2024-01-01",
        status: "ok",
        items: [],
      });

      const result = await promise;
      expect(result).toEqual([]);
      expect(requestCount).toBe(2);
    });

    it("500 を最大リトライ回数まで繰り返し、最終的にリジェクトする", async () => {
      const promise = listContracts(TEST_API_KEY);

      // 1回目: 500
      respondWith(500, { error: { message: "Internal Server Error", code: 500 } });

      // リトライ1 (attempt=0, delay ≈ 1s + jitter)
      await vi.advanceTimersByTimeAsync(2_000);
      // 2回目: 500
      respondWith(500, { error: { message: "Internal Server Error", code: 500 } });

      // リトライ2 (attempt=1, delay ≈ 2s + jitter)
      await vi.advanceTimersByTimeAsync(3_000);
      // 3回目: 500
      respondWith(500, { error: { message: "Internal Server Error", code: 500 } });

      // リトライ3 (attempt=2, delay ≈ 4s + jitter)
      await vi.advanceTimersByTimeAsync(5_000);
      // 4回目: 500 (最後の試行)
      respondWith(500, { error: { message: "Internal Server Error", code: 500 } });

      await expect(promise).rejects.toThrow("HTTP 500");
      expect(requestCount).toBe(4); // 初回 + 3回リトライ
    });

    it("403 (リトライ不可) は即座にリジェクトする", async () => {
      const promise = listContracts(TEST_API_KEY);

      respondWith(403, { error: { message: "Forbidden", code: 403 } });

      await expect(promise).rejects.toThrow("HTTP 403");
      expect(requestCount).toBe(1); // リトライなし
    });

    it("ネットワークエラーはリトライしない", async () => {
      const promise = listContracts(TEST_API_KEY);

      lastMockReq.emit("error", new Error("ECONNREFUSED"));

      await expect(promise).rejects.toThrow("ECONNREFUSED");
      expect(requestCount).toBe(1);
    });

    it("502 → 200 でリトライ後に成功する", async () => {
      const promise = listSockets(TEST_API_KEY);

      // 1回目: 502
      respondWith(502, { error: { message: "Bad Gateway", code: 502 } });

      await vi.advanceTimersByTimeAsync(2_000);

      // 2回目: 成功
      respondWith(200, {
        responseId: "r1",
        responseTime: "2024-01-01",
        status: "ok",
        items: [{ id: 1, status: "open" }],
      });

      const result = await promise;
      expect(result.items).toHaveLength(1);
      expect(requestCount).toBe(2);
    });
  });

  // ── 単位 1 / 2: xmlReport と Telegram Data v1 本文取得 ──

  /** 生テキスト応答（content-type を明示指定する）を返す */
  function respondWithText(
    statusCode: number,
    contentType: string,
    body: string | Buffer[],
  ): void {
    lastMockRes = createMockResponse(statusCode, { "content-type": contentType });
    requestCallback!(lastMockRes);
    for (const chunk of Array.isArray(body) ? body : [Buffer.from(body, "utf-8")]) {
      lastMockRes.emit("data", chunk);
    }
    lastMockRes.emit("end");
  }

  const TELEGRAM_LIST_OK = {
    responseId: "r1",
    responseTime: "2026-09-01T00:00:00Z",
    status: "ok" as const,
    items: [],
  };

  function requestPath(): string {
    return String((lastRequestOptions ?? {}).path ?? "");
  }

  describe("listTelegrams の xmlReport", () => {
    it("legacy string 形でも xmlReport=true が付く", async () => {
      const promise = listTelegrams(TEST_API_KEY, "VTSE41", 1);
      respondWith(200, TELEGRAM_LIST_OK);
      await promise;
      expect(requestPath()).toContain("xmlReport=true");
      expect(requestPath()).toContain("type=VTSE41");
    });

    it("query object 形でも xmlReport=true が付く", async () => {
      const promise = listTelegrams(TEST_API_KEY, {
        type: "VFVO54",
        limit: 100,
        formatMode: "raw",
        cursorToken: "tok",
      });
      respondWith(200, TELEGRAM_LIST_OK);
      await promise;
      expect(requestPath()).toContain("xmlReport=true");
      expect(requestPath()).toContain("cursorToken=tok");
    });

    it("xmlReport: false を明示するとパラメータ自体が出ない", async () => {
      const promise = listTelegrams(TEST_API_KEY, { type: "VFVO50", xmlReport: false });
      respondWith(200, TELEGRAM_LIST_OK);
      await promise;
      expect(requestPath()).not.toContain("xmlReport");
    });
  });

  describe("実 API 応答の形 (2026-09-02 採取)", () => {
    const REAL_LIST_FIXTURES = ["vfvo50", "vfvo54", "vfvo55"] as const;

    function loadRealList(slug: string): TelegramListResponse {
      const raw: unknown = JSON.parse(
        readFileSync(resolve(__dirname, `../fixtures/rest/telegram-list-${slug}-real.json`), "utf-8"),
      );
      return raw as TelegramListResponse;
    }

    it.each(REAL_LIST_FIXTURES)("%s: 一覧 item に body キーが存在しない", (slug) => {
      const res = loadRealList(slug);
      expect(res.items.length).toBeGreaterThan(0);
      for (const item of res.items) {
        // 実 API は一覧に本文を載せない。body 前提のコードはここで止める。
        expect(Object.prototype.hasOwnProperty.call(item, "body")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(item, "compression")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(item, "encoding")).toBe(false);
      }
    });

    it.each(REAL_LIST_FIXTURES)("%s: xmlReport / receivedTime / url が載る", (slug) => {
      const res = loadRealList(slug);
      for (const item of res.items) {
        expect(item.xmlReport?.head.infoType).toBeTruthy();
        expect(item.receivedTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(item.url).toBe(`${TELEGRAM_DATA_BASE}/${item.id}`);
        expect(item.format).toBe("xml");
      }
    });

    it("VFVO50 の xmlReport.head.serial は null、VFVO54/55 は文字列", () => {
      expect(loadRealList("vfvo50").items[0]!.xmlReport!.head.serial).toBeNull();
      expect(loadRealList("vfvo54").items[0]!.xmlReport!.head.serial).toBe("1");
      expect(loadRealList("vfvo55").items[0]!.xmlReport!.head.serial).toBe("1");
    });
  });

  describe("fetchTelegramBody", () => {
    const ID = "e34c5754b921e7bd6f2514d519727e4af820b08170273f079c44c288318c7a322887f729371e026b22266d91269eabbf";
    const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<Report><Head/></Report>';

    it("application/xml の生 XML をそのまま返す", async () => {
      const promise = fetchTelegramBody(TEST_API_KEY, ID);
      respondWithText(200, "application/xml", XML);
      await expect(promise).resolves.toEqual({ kind: "ok", xml: XML });
    });

    it("data.api.dmdata.jp/v1/<id> を Accept: application/xml で叩く", async () => {
      const promise = fetchTelegramBody(TEST_API_KEY, ID);
      respondWithText(200, "application/xml; charset=utf-8", XML);
      await promise;
      expect(lastRequestOptions).toMatchObject({
        hostname: "data.api.dmdata.jp",
        path: `/v1/${ID}`,
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/xml",
          "Accept-Encoding": "identity",
          Authorization: `Basic ${Buffer.from(`${TEST_API_KEY}:`).toString("base64")}`,
        }),
      });
    });

    it("expectedUrl が別ホストのとき送信せずに失敗する", async () => {
      const result = await fetchTelegramBody(TEST_API_KEY, ID, `https://evil.example.com/v1/${ID}`);
      expect(result).toEqual({ kind: "failed", reason: "network" });
      expect(requestCount).toBe(0);
    });

    it("expectedUrl が一致すれば送信する", async () => {
      const promise = fetchTelegramBody(TEST_API_KEY, ID, `${TELEGRAM_DATA_BASE}/${ID}`);
      respondWithText(200, "application/xml", XML);
      await expect(promise).resolves.toEqual({ kind: "ok", xml: XML });
    });

    it("id が英数字以外を含むとき送信せずに失敗する", async () => {
      const result = await fetchTelegramBody(TEST_API_KEY, "../v2/contract");
      expect(result).toEqual({ kind: "failed", reason: "network" });
      expect(requestCount).toBe(0);
    });

    it("403 は forbidden", async () => {
      const promise = fetchTelegramBody(TEST_API_KEY, ID);
      respondWithText(403, "application/json", '{"error":{"code":403}}');
      await expect(promise).resolves.toEqual({ kind: "failed", reason: "forbidden" });
    });

    it("404 は notFound (本文は text/plain で JSON ではない)", async () => {
      const promise = fetchTelegramBody(TEST_API_KEY, ID);
      respondWithText(404, "text/plain", "404 Not Found");
      await expect(promise).resolves.toEqual({ kind: "failed", reason: "notFound" });
    });

    it("200 でも content-type が JSON なら contentType 失敗", async () => {
      const promise = fetchTelegramBody(TEST_API_KEY, ID);
      respondWithText(200, "application/json", "{}");
      await expect(promise).resolves.toEqual({ kind: "failed", reason: "contentType" });
    });

    it("4 MiB 超過は tooLarge で受信を打ち切る", async () => {
      const promise = fetchTelegramBody(TEST_API_KEY, ID);
      const chunk = Buffer.alloc(TELEGRAM_BODY_MAX_BYTES / 2 + 1, 0x61);
      respondWithText(200, "application/xml", [chunk, chunk]);
      await expect(promise).resolves.toEqual({ kind: "failed", reason: "tooLarge" });
      expect(lastMockReq.destroy).toHaveBeenCalled();
    });

    it("ネットワークエラーは network", async () => {
      const promise = fetchTelegramBody(TEST_API_KEY, ID);
      lastMockReq.emit("error", new Error("ECONNREFUSED"));
      await expect(promise).resolves.toEqual({ kind: "failed", reason: "network" });
    });

    it("503 は既存と同じバックオフでリトライする", async () => {
      vi.useFakeTimers();
      try {
        const promise = fetchTelegramBody(TEST_API_KEY, ID);
        respondWithText(503, "text/plain", "Service Unavailable");
        await vi.advanceTimersByTimeAsync(2_000);
        const cb = requestCallbacks[1]!;
        const res = createMockResponse(200, { "content-type": "application/xml" });
        cb(res);
        res.emit("data", Buffer.from(XML, "utf-8"));
        res.emit("end");
        await expect(promise).resolves.toEqual({ kind: "ok", xml: XML });
        expect(requestCount).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
