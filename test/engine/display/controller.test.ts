import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDisplayController, createNoopDisplayController } from "../../../src/engine/display/controller";
import type { DisplayControllerDeps } from "../../../src/engine/display/controller";
import type { DisplayRuntime } from "../../../src/engine/display/runtime";
import type { DisplayCallbacks } from "../../../src/engine/messages/display-callbacks";
import { DEFAULT_CONFIG, type AppConfig } from "../../../src/types";

const mockStartDisplayRuntime = vi.fn();
const mockSetActiveDisplayRuntime = vi.fn();

vi.mock("../../../src/engine/display/runtime", () => ({
  startDisplayRuntime: (...args: unknown[]) => mockStartDisplayRuntime(...args),
  setActiveDisplayRuntime: (...args: unknown[]) => mockSetActiveDisplayRuntime(...args),
}));

function mockDisplay(): DisplayCallbacks {
  return {
    displayOutcome: vi.fn(),
    displayRawHeader: vi.fn(),
    displayVolcano: vi.fn(),
    displayVolcanoBatch: vi.fn(),
    getDisplayMode: () => "normal",
    renderSummaryLine: () => "要約",
  };
}

function testConfig(): AppConfig {
  return { ...DEFAULT_CONFIG, apiKey: "test", display: true, displayPort: 0 };
}

function fakeRuntime(port = 12345, clientCount = 2): DisplayRuntime {
  return {
    hub: { id: "hub", publishConnection: vi.fn() } as unknown as DisplayRuntime["hub"],
    transport: {
      port: () => port,
      clientCount: () => clientCount,
    } as unknown as DisplayRuntime["transport"],
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

/** monitor.ts の displayRuntime/displayHubRef 可変変数を模した deps を作る */
function makeDeps(getConnectionState?: DisplayControllerDeps["getConnectionState"]) {
  let runtime: DisplayRuntime | null = null;
  let hubRef: unknown = null;
  const deps: DisplayControllerDeps = {
    config: testConfig(),
    display: mockDisplay(),
    seeds: { tsunami: () => null, weather: () => undefined, landslide: () => undefined },
    getRuntime: () => runtime,
    setRuntime: vi.fn((rt) => { runtime = rt; }),
    setHubRef: vi.fn((hub) => { hubRef = hub; }),
    getConnectionState,
  };
  return { deps, getHubRef: () => hubRef };
}

beforeEach(() => {
  mockStartDisplayRuntime.mockReset();
  mockSetActiveDisplayRuntime.mockReset();
});

describe("createDisplayController", () => {
  describe("start", () => {
    it("未起動なら startDisplayRuntime を呼び、deps に runtime/hub を反映して ok:true を返す", async () => {
      const rt = fakeRuntime(7788, 0);
      mockStartDisplayRuntime.mockResolvedValue(rt);
      const { deps, getHubRef } = makeDeps();
      const controller = createDisplayController(deps);

      const result = await controller.start();

      expect(mockStartDisplayRuntime).toHaveBeenCalledTimes(1);
      expect(mockStartDisplayRuntime.mock.calls[0][0]).toBe(deps.config);
      expect(mockStartDisplayRuntime.mock.calls[0][1]).toBe(deps.display);
      expect(mockStartDisplayRuntime.mock.calls[0][2]).toBe(deps.seeds);
      expect(typeof mockStartDisplayRuntime.mock.calls[0][3]).toBe("function"); // onStopped コールバック
      expect(deps.setRuntime).toHaveBeenCalledWith(rt);
      expect(getHubRef()).toBe(rt.hub);
      expect(mockSetActiveDisplayRuntime).toHaveBeenCalledWith(rt);
      expect(result).toEqual({ ok: true, message: "情報ディスプレイを起動しました (ポート 7788)" });
    });

    it("既に起動中なら startDisplayRuntime を呼ばず ok:false を返す", async () => {
      const { deps } = makeDeps();
      const controller = createDisplayController(deps);
      // 1 回目で起動状態にする
      mockStartDisplayRuntime.mockResolvedValue(fakeRuntime());
      await controller.start();
      mockStartDisplayRuntime.mockClear();

      const result = await controller.start();

      expect(mockStartDisplayRuntime).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
    });

    it("startDisplayRuntime が null を返す (起動失敗) なら deps を変更せず ok:false を返す", async () => {
      mockStartDisplayRuntime.mockResolvedValue(null);
      const { deps } = makeDeps();
      const controller = createDisplayController(deps);

      const result = await controller.start();

      expect(deps.setRuntime).not.toHaveBeenCalled();
      expect(deps.setHubRef).not.toHaveBeenCalled();
      expect(mockSetActiveDisplayRuntime).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
    });

    it("getConnectionState が現在の接続状態を返すとき、起動直後に publishConnection を呼ぶ", async () => {
      const rt = fakeRuntime();
      mockStartDisplayRuntime.mockResolvedValue(rt);
      const { deps } = makeDeps(() => "disconnected");
      const controller = createDisplayController(deps);

      await controller.start();

      expect(rt.hub.publishConnection).toHaveBeenCalledWith({ dmdata: "disconnected" });
    });

    it("getConnectionState が未注入なら publishConnection を呼ばない (state-store 初期値のまま)", async () => {
      const rt = fakeRuntime();
      mockStartDisplayRuntime.mockResolvedValue(rt);
      const { deps } = makeDeps();
      const controller = createDisplayController(deps);

      await controller.start();

      expect(rt.hub.publishConnection).not.toHaveBeenCalled();
    });

    it("kill switch (onStopped) が発火すると deps の runtime/hub が null に戻る", async () => {
      const rt = fakeRuntime();
      mockStartDisplayRuntime.mockResolvedValue(rt);
      const { deps, getHubRef } = makeDeps();
      const controller = createDisplayController(deps);

      await controller.start();
      const onStopped = mockStartDisplayRuntime.mock.calls[0][3] as () => void;
      onStopped();

      expect(deps.getRuntime()).toBeNull();
      expect(getHubRef()).toBeNull();
    });
  });

  describe("stop", () => {
    it("起動中なら runtime.stop() を呼び deps を null に戻して ok:true を返す", async () => {
      const rt = fakeRuntime();
      mockStartDisplayRuntime.mockResolvedValue(rt);
      const { deps, getHubRef } = makeDeps();
      const controller = createDisplayController(deps);
      await controller.start();

      const result = await controller.stop();

      expect(rt.stop).toHaveBeenCalledTimes(1);
      expect(deps.getRuntime()).toBeNull();
      expect(getHubRef()).toBeNull();
      expect(mockSetActiveDisplayRuntime).toHaveBeenCalledWith(null);
      expect(result).toEqual({ ok: true, message: "情報ディスプレイを停止しました" });
    });

    it("未起動なら何もせず ok:false を返す", async () => {
      const { deps } = makeDeps();
      const controller = createDisplayController(deps);

      const result = await controller.stop();

      expect(deps.setRuntime).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
    });

    it("runtime.stop() が reject しても状態はクリアされ、その後 start できる", async () => {
      const rt = fakeRuntime();
      (rt.stop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("close failed"));
      mockStartDisplayRuntime.mockResolvedValue(rt);
      const { deps, getHubRef } = makeDeps();
      const controller = createDisplayController(deps);
      await controller.start();

      const result = await controller.stop();

      expect(result.ok).toBe(false);
      expect(result.message).toContain("close failed");
      expect(deps.getRuntime()).toBeNull();
      expect(getHubRef()).toBeNull();
      expect(mockSetActiveDisplayRuntime).toHaveBeenCalledWith(null);

      // 状態がクリアされているので、二重起動扱いにならず再度 start できる
      const rt2 = fakeRuntime();
      mockStartDisplayRuntime.mockResolvedValue(rt2);
      const startResult = await controller.start();
      expect(startResult.ok).toBe(true);
    });
  });

  describe("status", () => {
    it("未起動時は running:false", () => {
      const { deps } = makeDeps();
      const controller = createDisplayController(deps);
      expect(controller.status()).toEqual({ running: false, port: null, clientCount: null });
    });

    it("起動中は port/clientCount を返す", async () => {
      const rt = fakeRuntime(9999, 3);
      mockStartDisplayRuntime.mockResolvedValue(rt);
      const { deps } = makeDeps();
      const controller = createDisplayController(deps);
      await controller.start();

      expect(controller.status()).toEqual({ running: true, port: 9999, clientCount: 3 });
    });
  });
});

describe("createNoopDisplayController", () => {
  it("start/stop は常に ok:false、status は稼働していない状態を返す", async () => {
    const controller = createNoopDisplayController();

    await expect(controller.start()).resolves.toEqual({ ok: false, message: expect.any(String) });
    await expect(controller.stop()).resolves.toEqual({ ok: false, message: expect.any(String) });
    expect(controller.status()).toEqual({ running: false, port: null, clientCount: null });
  });
});
