import { describe, it, expect, vi, beforeEach, afterEach , type MockInstance } from "vitest";
import { handleDisplay } from "../../../src/ui/repl-handlers/operation-handlers";
import type { ReplContext } from "../../../src/ui/repl-handlers/types";
import type { DisplayController } from "../../../src/engine/display/controller";

function makeCtx(displayController: DisplayController): ReplContext {
  return { displayController } as unknown as ReplContext;
}

function mockController(overrides: Partial<DisplayController> = {}): DisplayController {
  return {
    start: vi.fn().mockResolvedValue({ ok: true, message: "起動しました" }),
    stop: vi.fn().mockResolvedValue({ ok: true, message: "停止しました" }),
    status: vi.fn().mockReturnValue({ running: false, port: null, clientCount: null }),
    ...overrides,
  };
}

describe("handleDisplay", () => {
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("引数なし・停止中: 「停止中」を表示する", async () => {
    const controller = mockController({ status: vi.fn().mockReturnValue({ running: false, port: null, clientCount: null }) });
    await handleDisplay(makeCtx(controller), "");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("停止中");
  });

  it("引数なし・稼働中: ポートと接続クライアント数を表示する", async () => {
    const controller = mockController({ status: vi.fn().mockReturnValue({ running: true, port: 7788, clientCount: 3 }) });
    await handleDisplay(makeCtx(controller), "");
    const out = logSpy.mock.calls.flat().join("\n");
    expect(out).toContain("稼働中");
    expect(out).toContain("7788");
    expect(out).toContain("3");
  });

  it("on: displayController.start() を呼び、結果メッセージを表示する", async () => {
    const controller = mockController({ start: vi.fn().mockResolvedValue({ ok: true, message: "情報ディスプレイを起動しました (ポート 7788)" }) });
    await handleDisplay(makeCtx(controller), "on");
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.flat().join("\n")).toContain("情報ディスプレイを起動しました");
  });

  it("off: displayController.stop() を呼び、結果メッセージを表示する", async () => {
    const controller = mockController({ stop: vi.fn().mockResolvedValue({ ok: true, message: "情報ディスプレイを停止しました" }) });
    await handleDisplay(makeCtx(controller), "off");
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.flat().join("\n")).toContain("情報ディスプレイを停止しました");
  });

  it("on を既に稼働中に呼ぶと ok:false のメッセージを表示する (start() 自体は呼ばれる)", async () => {
    const controller = mockController({ start: vi.fn().mockResolvedValue({ ok: false, message: "情報ディスプレイは既に稼働中です" }) });
    await handleDisplay(makeCtx(controller), "on");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("既に稼働中です");
  });

  it("不明な引数: 使い方を表示する", async () => {
    const controller = mockController();
    await handleDisplay(makeCtx(controller), "foo");
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("使い方");
  });
});
