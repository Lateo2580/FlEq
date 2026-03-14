import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ── モック定義 ──

// WebSocket モック
class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;

  send = vi.fn();
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = MockWebSocket.CLOSED;
  });
}

let mockWsInstance: MockWebSocket;

vi.mock("ws", () => {
  return {
    default: class {
      static OPEN = 1;
      static CLOSED = 3;

      readyState: number;
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;

      private emitter: EventEmitter;

      constructor(_url: string, _protocols?: string[]) {
        mockWsInstance = new MockWebSocket();
        this.readyState = mockWsInstance.readyState;
        this.send = mockWsInstance.send;
        this.close = mockWsInstance.close;
        this.emitter = mockWsInstance;

        // readyState をプロキシで同期
        const self = this;
        Object.defineProperty(this, "readyState", {
          get() {
            return mockWsInstance.readyState;
          },
          set(v: number) {
            mockWsInstance.readyState = v;
          },
        });

        // on/emit をデレゲート
        this.on = (event: string, listener: (...args: unknown[]) => void) => {
          self.emitter.on(event, listener);
          return this;
        };
      }

      on(_event: string, _listener: (...args: unknown[]) => void): this {
        // 上書きされる
        return this;
      }
    },
  };
});

vi.mock("../../src/dmdata/rest-client", () => ({
  prepareAndStartSocket: vi.fn(),
}));

vi.mock("../../src/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { WebSocketManager, WsManagerEvents } from "../../src/dmdata/ws-client";
import { prepareAndStartSocket } from "../../src/dmdata/rest-client";
import { AppConfig } from "../../src/types";

const mockPrepare = vi.mocked(prepareAndStartSocket);

function createConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    apiKey: "test-api-key",
    classifications: ["telegram.earthquake"],
    testMode: "no",
    appName: "test-app",
    maxReconnectDelaySec: 60,
    keepExistingConnections: false,
    tableWidth: null,
    infoFullText: false,
    displayMode: "normal",
    promptClock: "elapsed",
    waitTipIntervalMin: 30,
    notify: { eew: true, earthquake: true, tsunami: true, seismicText: true, nankaiTrough: true, lgObservation: true },
    sound: true,
    eewLog: true,
    eewLogFields: { hypocenter: true, magnitude: true, forecastIntensity: true, forecastAreas: true, diff: true },
    ...overrides,
  };
}

function createEvents(overrides?: Partial<WsManagerEvents>): WsManagerEvents {
  return {
    onData: vi.fn(),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    ...overrides,
  };
}

function mockSocketStartSuccess(): void {
  mockPrepare.mockResolvedValue({
    responseId: "res-1",
    responseTime: new Date().toISOString(),
    status: "ok",
    websocket: {
      id: 42,
      url: "wss://ws.example.com?ticket=abc123",
      protocol: ["dmdata.v2"],
      expiration: 300,
    },
  });
}

describe("WebSocketManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSocketStartSuccess();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("接続ライフサイクル", () => {
    it("connect → open → onConnected コールバック", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      const connectPromise = manager.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      // open イベントを発火
      mockWsInstance.emit("open");

      expect(events.onConnected).toHaveBeenCalledOnce();
      expect(manager.getStatus().connected).toBe(true);

      manager.close();
    });

    it("close で shouldRun=false になり ws が閉じる", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      manager.close();

      expect(mockWsInstance.close).toHaveBeenCalledWith(1000, "client shutdown");
      expect(manager.getStatus().connected).toBe(false);
    });
  });

  describe("メッセージハンドリング", () => {
    it("data メッセージで onData コールバックが発火する", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      const dataMsg = {
        type: "data",
        id: "test-id-0001234567890",
        version: "2.0",
        classification: "telegram.earthquake",
        head: { type: "VXSE53", author: "test", time: "2024-01-01" },
        passing: [],
        format: "xml",
        compression: null,
        encoding: null,
        body: "",
      };

      mockWsInstance.emit("message", JSON.stringify(dataMsg));

      expect(events.onData).toHaveBeenCalledOnce();
      expect(events.onData).toHaveBeenCalledWith(
        expect.objectContaining({ type: "data", id: "test-id-0001234567890" })
      );

      manager.close();
    });

    it("ping メッセージに pong を返す", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      mockWsInstance.emit(
        "message",
        JSON.stringify({ type: "ping", pingId: "ping-123" })
      );

      expect(mockWsInstance.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "pong", pingId: "ping-123" })
      );

      manager.close();
    });

    it("start メッセージで socketId を記録する", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      mockWsInstance.emit(
        "message",
        JSON.stringify({
          type: "start",
          socketId: 99,
          classifications: ["telegram.earthquake"],
          types: [],
          test: "no",
          formats: [],
          appName: "test",
          time: new Date().toISOString(),
        })
      );

      expect(manager.getStatus().socketId).toBe(99);

      manager.close();
    });

    it("JSON パース失敗時にエラーログを出力する", async () => {
      const log = await import("../../src/logger");
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      mockWsInstance.emit("message", "invalid-json{{{");

      expect(log.error).toHaveBeenCalledWith("受信データのJSONパースに失敗");
      expect(events.onData).not.toHaveBeenCalled();

      manager.close();
    });

    it("Buffer データを正しくパースする", async () => {
      const log = await import("../../src/logger");
      vi.mocked(log.error).mockClear();

      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      const msg = { type: "pong", pingId: "buf-test" };
      mockWsInstance.emit("message", Buffer.from(JSON.stringify(msg)));

      expect(log.error).not.toHaveBeenCalledWith("受信データのJSONパースに失敗");

      manager.close();
    });

    it("ArrayBuffer データを正しくパースする", async () => {
      const log = await import("../../src/logger");
      vi.mocked(log.error).mockClear();

      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      const msg = { type: "pong", pingId: "ab-test" };
      const buf = Buffer.from(JSON.stringify(msg));
      const ab = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength
      );
      mockWsInstance.emit("message", ab);

      expect(log.error).not.toHaveBeenCalledWith("受信データのJSONパースに失敗");

      manager.close();
    });

    it("Buffer[] データを正しくパースする", async () => {
      const log = await import("../../src/logger");
      vi.mocked(log.error).mockClear();

      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      const msg = JSON.stringify({ type: "pong", pingId: "arr-test" });
      const part1 = Buffer.from(msg.slice(0, 10));
      const part2 = Buffer.from(msg.slice(10));
      mockWsInstance.emit("message", [part1, part2]);

      expect(log.error).not.toHaveBeenCalledWith("受信データのJSONパースに失敗");

      manager.close();
    });
  });

  describe("切断と再接続", () => {
    it("close イベントで onDisconnected が発火し再接続をスケジュールする", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");
      mockWsInstance.emit("close", 1006, Buffer.from("connection lost"));

      expect(events.onDisconnected).toHaveBeenCalledWith("connection lost");
      expect(manager.getStatus().reconnectAttempt).toBe(1);

      manager.close();
    });

    it("shouldRun=false の場合は再接続しない", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      manager.close();

      // close は close() 内で直接呼ばれるため、onClose イベントをシミュレートしても再接続されない
      mockPrepare.mockClear();

      // 手動で close イベントを発火（実際の ws では close() 後に発火する）
      mockWsInstance.emit("close", 1000, Buffer.from("client shutdown"));

      // タイマーを進めても再接続されない
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockPrepare).not.toHaveBeenCalled();
    });

    it("close イベント2回でも安全に1回だけ再接続する", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      // 2回連続で close イベント — 1回目で ws=null になるため2回目はスキップ
      mockWsInstance.emit("close", 1006, Buffer.from("err1"));
      mockWsInstance.emit("close", 1006, Buffer.from("err2"));

      expect(manager.getStatus().reconnectAttempt).toBe(1);
      expect(events.onDisconnected).toHaveBeenCalledOnce();

      manager.close();
    });
  });

  describe("ハートビートタイムアウト", () => {
    it("90秒間 ping がなければソケットを閉じる", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      // 90秒経過
      await vi.advanceTimersByTimeAsync(90_000);

      expect(mockWsInstance.close).toHaveBeenCalledWith(
        4000,
        "heartbeat timeout"
      );

      manager.close();
    });

    it("ping 受信でタイマーがリセットされる", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      // 80秒経過
      await vi.advanceTimersByTimeAsync(80_000);

      // ping 受信でリセット
      mockWsInstance.emit(
        "message",
        JSON.stringify({ type: "ping", pingId: "p1" })
      );

      // さらに80秒経過（リセットなしなら160秒 > 90秒で閉じるはず）
      await vi.advanceTimersByTimeAsync(80_000);

      // まだ閉じていない（タイムアウトは最後の ping + 90秒）
      expect(mockWsInstance.close).not.toHaveBeenCalledWith(
        4000,
        "heartbeat timeout"
      );

      // あと10秒でタイムアウト
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockWsInstance.close).toHaveBeenCalledWith(
        4000,
        "heartbeat timeout"
      );

      manager.close();
    });
  });

  describe("error イベント", () => {
    it("error + close 同時発火でも安全に処理する", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      // error → close の順で発火
      mockWsInstance.emit("error", new Error("connection reset"));
      mockWsInstance.emit("close", 1006, Buffer.from("error"));

      const log = await import("../../src/logger");
      expect(log.error).toHaveBeenCalledWith(
        "WebSocket エラー: connection reset"
      );
      expect(events.onDisconnected).toHaveBeenCalledOnce();

      manager.close();
    });
  });

  describe("接続失敗", () => {
    it("prepareAndStartSocket 失敗時に再接続をスケジュールする", async () => {
      mockPrepare.mockRejectedValueOnce(new Error("API error"));

      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();

      expect(manager.getStatus().reconnectAttempt).toBe(1);

      manager.close();
    });

    it("websocket URL がない場合に再接続をスケジュールする", async () => {
      mockPrepare.mockResolvedValueOnce({
        responseId: "res-1",
        responseTime: new Date().toISOString(),
        status: "ok",
        // websocket なし
      });

      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();

      expect(manager.getStatus().reconnectAttempt).toBe(1);

      manager.close();
    });
  });

  describe("サーバーエラーメッセージ", () => {
    it("error タイプのメッセージを処理する", async () => {
      const log = await import("../../src/logger");
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      mockWsInstance.emit(
        "message",
        JSON.stringify({
          type: "error",
          error: { message: "rate limit exceeded", code: 429 },
        })
      );

      expect(log.error).toHaveBeenCalledWith(
        "サーバーエラー: rate limit exceeded (code=429)"
      );

      manager.close();
    });
  });

  describe("スキーマ検証 (type=data 不正入力)", () => {
    it("id が欠落した data メッセージでもクラッシュしない", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      // id フィールドなし
      mockWsInstance.emit(
        "message",
        JSON.stringify({ type: "data", head: { type: "VXSE53" } })
      );

      expect(events.onData).not.toHaveBeenCalled();

      manager.close();
    });

    it("head が欠落した data メッセージでもクラッシュしない", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      // head フィールドなし
      mockWsInstance.emit(
        "message",
        JSON.stringify({ type: "data", id: "abc123" })
      );

      expect(events.onData).not.toHaveBeenCalled();

      manager.close();
    });

    it("head.type が数値の data メッセージでもクラッシュしない", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      // head.type が文字列でない
      mockWsInstance.emit(
        "message",
        JSON.stringify({ type: "data", id: "abc123", head: { type: 42 } })
      );

      expect(events.onData).not.toHaveBeenCalled();

      manager.close();
    });

    it("socketId が欠落した start メッセージでもクラッシュしない", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      // socketId なし
      mockWsInstance.emit(
        "message",
        JSON.stringify({ type: "start", classifications: ["telegram.earthquake"] })
      );

      // socketId が記録されていないこと (null のまま)
      expect(manager.getStatus().socketId).toBeNull();

      manager.close();
    });

    it("pingId が欠落した ping メッセージでもクラッシュしない", async () => {
      const events = createEvents();
      const manager = new WebSocketManager(createConfig(), events);

      await manager.connect();
      mockWsInstance.emit("open");

      // pingId なし
      mockWsInstance.emit(
        "message",
        JSON.stringify({ type: "ping" })
      );

      // pong は送信されない
      expect(mockWsInstance.send).not.toHaveBeenCalled();

      manager.close();
    });
  });
});
