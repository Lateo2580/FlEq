import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTest } from "../../../src/ui/repl-handlers/operation-handlers";
import type { ReplContext } from "../../../src/ui/repl-handlers/types";

// test-samples の評価タイミングを観測する。factory は最初の import 時にだけ走るので、
// operation-handlers を静的 import しただけでは count が 0 のままであることを検証できる。
const tracker = vi.hoisted(() => ({ evaluated: 0, ran: 0 }));

vi.mock("../../../src/ui/test-samples", () => {
  tracker.evaluated++;
  return {
    TEST_TABLES: {
      earthquake: {
        label: "地震情報",
        variants: [
          { label: "サンプル1", run: () => { tracker.ran++; } },
          { label: "サンプル2", run: () => { tracker.ran++; } },
        ],
      },
    },
  };
});

function makeCtx(): ReplContext {
  return {
    commands: {
      test: {
        description: "テスト機能",
        category: "operation",
        subcommands: { sound: { description: "サウンドテスト" }, table: { description: "表示形式テスト" } },
        handler: () => {},
      },
    },
  } as unknown as ReplContext;
}

describe("handleTest — test-samples の遅延ロード", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("operation-handlers の import だけでは test-samples が評価されない", () => {
    expect(tracker.evaluated).toBe(0);
  });

  it("test (引数なし) と test sound では test-samples が評価されない", async () => {
    await handleTest(makeCtx(), "");
    await handleTest(makeCtx(), "sound");
    expect(tracker.evaluated).toBe(0);
  });

  it("test table を実行した時点で初めて test-samples が評価される", async () => {
    await handleTest(makeCtx(), "table");
    expect(tracker.evaluated).toBe(1);
    expect(logSpy.mock.calls.flat().join("\n")).toContain("地震情報");
  });

  it("test table <type> <番号> でバリアントが実行される (エイリアス含む)", async () => {
    await handleTest(makeCtx(), "table eq 2");
    expect(tracker.ran).toBe(1);
    expect(logSpy.mock.calls.flat().join("\n")).toContain("サンプル2");
  });

  it("不明な電文タイプは有効な値を案内する", async () => {
    await handleTest(makeCtx(), "table nosuchtype");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("不明な電文タイプ");
  });
});
