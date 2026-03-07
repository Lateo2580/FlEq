import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMessageHandler } from "../../src/engine/message-router";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE51_SHINDO,
  FIXTURE_VXSE51_CANCEL,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE53_DRILL_1,
  FIXTURE_VXSE52_HYPO_1,
  FIXTURE_VXSE56_ACTIVITY_1,
  FIXTURE_VXSE60_1,
  FIXTURE_VXSE61_1,
  FIXTURE_VTSE41_WARN,
  FIXTURE_VTSE41_CANCEL,
  FIXTURE_VTSE51_INFO,
  FIXTURE_VTSE52_OFFSHORE,
  FIXTURE_VXSE43_WARNING_S1,
  FIXTURE_VXSE43_WARNING_S2,
  FIXTURE_VXSE44_S10,
  FIXTURE_VXSE45_S1,
  FIXTURE_VXSE45_S26,
  FIXTURE_VXSE45_CANCEL,
  FIXTURE_VXSE45_FINAL,
} from "../helpers/mock-message";
import { WsDataMessage } from "../../src/types";
import * as fs from "fs";

// fs をモックして eew-logger のファイル書き込みを抑制
const { appendFileMock } = vi.hoisted(() => {
  const appendFileMock = vi.fn().mockResolvedValue(undefined);
  return { appendFileMock };
});
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    existsSync: (p: string) => {
      // eew-logs ディレクトリのチェックは true を返す
      if (typeof p === "string" && p.includes("eew-logs")) return true;
      return actual.existsSync(p);
    },
    mkdirSync: vi.fn(),
    promises: {
      ...actual.promises,
      appendFile: appendFileMock,
    },
  };
});

describe("message-router 統合テスト", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function getOutput(): string {
    return consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
  }

  describe("EEW ルーティング", () => {
    it("VXSE43 EEW 警報を処理する", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("緊急地震速報");
    });

    it("VXSE44 EEW 予報を処理する", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE44_S10);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("緊急地震速報");
    });

    it("VXSE45 EEW 地震動予報を処理する", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_S1);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("緊急地震速報");
    });

    it("VXSE45 取消報を処理する", () => {
      const { handler } = createMessageHandler();
      // まず初報を送る
      const first = createMockWsDataMessage(FIXTURE_VXSE45_S1);
      handler(first);

      const cancel = createMockWsDataMessage(FIXTURE_VXSE45_CANCEL);
      handler(cancel);

      const output = getOutput();
      expect(output).toContain("取消");
    });
  });

  describe("EEW 最終報", () => {
    it("NextAdvisory 付き電文で最終報テキストが表示される", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_FINAL);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("最終報");
    });

    it("NextAdvisory 付き電文でログが '最終報' 理由で閉じられる", async () => {
      const { handler } = createMessageHandler();
      appendFileMock.mockClear();

      const msg = createMockWsDataMessage(FIXTURE_VXSE45_FINAL);
      handler(msg);

      // 非同期書き込みが完了するのを待つ
      await vi.waitFor(() => {
        const calls = appendFileMock.mock.calls.map((c: unknown[]) => String(c[1]));
        const hasCloseCall = calls.some((text: string) => text.includes("記録終了 (最終報)"));
        expect(hasCloseCall).toBe(true);
      });
    });
  });

  describe("EEW 重複報スキップ", () => {
    it("同一 EventID・同一 Serial の重複報をスキップする", () => {
      const { handler } = createMessageHandler();

      const msg1 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
      handler(msg1);
      const firstCallCount = consoleSpy.mock.calls.length;

      // 同一メッセージを再送信
      const msg2 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
      handler(msg2);
      const secondCallCount = consoleSpy.mock.calls.length;

      // 重複報はスキップされるので追加の console.log がない
      expect(secondCallCount).toBe(firstCallCount);
    });

    it("同一 EventID でも異なる Serial は処理する", () => {
      const { handler } = createMessageHandler();

      const msg1 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
      handler(msg1);
      const firstCallCount = consoleSpy.mock.calls.length;

      const msg2 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S2);
      handler(msg2);
      const secondCallCount = consoleSpy.mock.calls.length;

      // 異なる Serial なので追加表示される
      expect(secondCallCount).toBeGreaterThan(firstCallCount);
    });
  });

  describe("地震情報ルーティング", () => {
    it("VXSE51 震度速報を処理する", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE51_SHINDO);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("震度速報");
    });

    it("VXSE51 取消報を処理する", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE51_CANCEL);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("取消");
    });

    it("VXSE52 震源に関する情報を処理する", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE52_HYPO_1);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("駿河湾");
    });

    it("VXSE53 震源・震度情報を処理する", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
      handler(msg);

      const output = getOutput();
      // XMLから解析されたタイトルまたは震源名が含まれる
      expect(output).toContain("南太平洋");
    });

    it("VXSE61 震源要素更新を処理する", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE61_1);
      handler(msg);

      const output = getOutput();
      // VXSE61 は地震情報パスでルーティング
      expect(output.length).toBeGreaterThan(0);
    });
  });

  describe("テキスト系ルーティング", () => {
    it("VXSE56 地震活動情報を処理する", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE56_ACTIVITY_1);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("伊豆東部");
    });

    it("VXSE60 地震回数情報を処理する", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE60_1);
      handler(msg);

      const output = getOutput();
      expect(output.length).toBeGreaterThan(0);
    });
  });

  describe("津波情報ルーティング", () => {
    it("VTSE41 津波警報を処理する", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("津波");
    });

    it("VTSE41 取消報を処理する", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VTSE41_CANCEL);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("取消");
    });

    it("VTSE51 津波情報を処理する", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VTSE51_INFO);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("津波");
    });

    it("VTSE52 沖合津波情報を処理する", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VTSE52_OFFSHORE);
      handler(msg);

      const output = getOutput();
      expect(output.length).toBeGreaterThan(0);
    });
  });

  describe("フォールバック", () => {
    it("非 XML メッセージはヘッダ表示する", () => {
      const { handler } = createMessageHandler();
      const msg: WsDataMessage = {
        type: "data",
        version: "2.0",
        classification: "telegram.earthquake",
        id: "test-id-001",
        passing: [],
        head: {
          type: "UNKNOWN",
          author: "テスト",
          time: new Date().toISOString(),
          test: false,
          xml: false,
        },
        format: null,
        compression: null,
        encoding: null,
        body: "raw text data",
      };

      handler(msg);

      const output = getOutput();
      // displayRawHeader が呼ばれる
      expect(output.length).toBeGreaterThan(0);
    });

    it("未知の classification の XML メッセージはフォールバック表示", () => {
      const { handler } = createMessageHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI, {
        classification: "unknown.type",
        head: {
          type: "ZZZZ99",
          author: "テスト",
          time: new Date().toISOString(),
          test: false,
          xml: true,
        },
      });

      handler(msg);

      const output = getOutput();
      expect(output.length).toBeGreaterThan(0);
    });
  });
});
