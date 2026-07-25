import { describe, it, expect, vi, beforeEach, afterEach , type MockInstance } from "vitest";
import { handleTest } from "../../../src/ui/repl-handlers/operation-handlers";
import type { ReplContext } from "../../../src/ui/repl-handlers/types";

// test-samples の遅延ロードだけを見る専用ファイル。
// 「まだ評価されていない」は module registry が手つかずであることを前提にした一方向の性質で、
// 同じファイル内に test table を実行する別の it があると、実行順によっては先に評価されて落ちる。
// vitest は test file ごとに module registry を分離するので、この 1 本だけを置いて順序依存を消す
// (テーブル描画・バリアント実行の検証は operation-handlers-test-table.test.ts に置く)。
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
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("test table を実行するまで test-samples は評価されない", async () => {
    // operation-handlers を静的 import しただけでは評価されない
    expect(tracker.evaluated).toBe(0);

    // test (引数なし) と test sound でも評価されない
    await handleTest(makeCtx(), "");
    await handleTest(makeCtx(), "sound");
    expect(tracker.evaluated).toBe(0);

    // test table を実行した時点で初めて評価される
    await handleTest(makeCtx(), "table");
    expect(tracker.evaluated).toBe(1);
    expect(logSpy.mock.calls.flat().join("\n")).toContain("地震情報");
  });
});
