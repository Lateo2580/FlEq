import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMessageHandler } from "../../src/engine/messages/message-router";
import { createDisplayAdapter } from "../../src/ui/display-adapter";
import { TelegramStats } from "../../src/engine/messages/telegram-stats";
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
  FIXTURE_VFVO53_ASH_REGULAR,
  FIXTURE_VFVO54_ASH_RAPID,
} from "../helpers/mock-message";
import { WsDataMessage } from "../../src/types";
import * as fs from "fs";

// sound-player をモックしてテスト中に通知音が鳴るのを抑制
vi.mock("../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

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
  const display = createDisplayAdapter();

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

  /** display adapter 付きで createMessageHandler を呼ぶヘルパー */
  function createHandler(opts?: Parameters<typeof createMessageHandler>[0]) {
    return createMessageHandler({ display, ...opts });
  }

  describe("EEW ルーティング", () => {
    it("VXSE43 EEW 警報を処理する", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("緊急地震速報");
    });

    it("VXSE44 EEW 予報は常時抑制される", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE44_S10);
      handler(msg);

      const output = getOutput();
      expect(output).not.toContain("緊急地震速報");
    });

    it("VXSE45 EEW 地震動予報を処理する", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_S1);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("緊急地震速報");
    });

    it("VXSE45 取消報を処理する", () => {
      const { handler } = createHandler();
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
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_FINAL);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("最終報");
    });

    it("NextAdvisory 付き電文でログが '最終報' 理由で閉じられる", async () => {
      const { handler } = createHandler();
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
      const { handler } = createHandler();

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
      const { handler } = createHandler();

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
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE51_SHINDO);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("震度速報");
    });

    it("VXSE51 取消報を処理する", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE51_CANCEL);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("取消");
    });

    it("VXSE52 震源に関する情報を処理する", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE52_HYPO_1);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("駿河湾");
    });

    it("VXSE53 震源・震度情報を処理する", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
      handler(msg);

      const output = getOutput();
      // XMLから解析されたタイトルまたは震源名が含まれる
      expect(output).toContain("南太平洋");
    });

    it("VXSE61 震源要素更新を処理する", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE61_1);
      handler(msg);

      const output = getOutput();
      // VXSE61 は地震情報パスでルーティング
      expect(output.length).toBeGreaterThan(0);
    });
  });

  describe("テキスト系ルーティング", () => {
    it("VXSE56 地震活動情報を処理する", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE56_ACTIVITY_1);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("伊豆東部");
    });

    it("VXSE60 地震回数情報を処理する", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE60_1);
      handler(msg);

      const output = getOutput();
      expect(output.length).toBeGreaterThan(0);
    });
  });

  describe("津波情報ルーティング", () => {
    it("VTSE41 津波警報を処理する", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("津波");
    });

    it("VTSE41 受信で tsunamiState が更新される", () => {
      const { handler, tsunamiState } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
      handler(msg);

      // VTSE41 の警報レベルが設定される
      expect(tsunamiState.getLevel()).not.toBeNull();
    });

    it("VTSE41 取消報で tsunamiState がクリアされる", () => {
      const { handler, tsunamiState } = createHandler();
      // まず警報
      handler(createMockWsDataMessage(FIXTURE_VTSE41_WARN));
      expect(tsunamiState.getLevel()).not.toBeNull();

      // 取消
      handler(createMockWsDataMessage(FIXTURE_VTSE41_CANCEL));
      expect(tsunamiState.getLevel()).toBeNull();
    });

    it("VTSE51 では tsunamiState が更新されない", () => {
      const { handler, tsunamiState } = createHandler();
      handler(createMockWsDataMessage(FIXTURE_VTSE51_INFO));
      expect(tsunamiState.getLevel()).toBeNull();
    });

    it("createMessageHandler() が tsunamiState を返す", () => {
      const result = createHandler();
      expect(result.tsunamiState).toBeDefined();
      expect(result.tsunamiState.category).toBe("tsunami");
    });

    it("VTSE41 取消報を処理する", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VTSE41_CANCEL);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("取消");
    });

    it("VTSE51 津波情報を処理する", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VTSE51_INFO);
      handler(msg);

      const output = getOutput();
      expect(output).toContain("津波");
    });

    it("VTSE52 沖合津波情報を処理する", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VTSE52_OFFSHORE);
      handler(msg);

      const output = getOutput();
      expect(output.length).toBeGreaterThan(0);
    });
  });

  describe("VFVO53 アグリゲータ統合", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("VFVO53 はバッファリングされ、即時表示されない", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR);
      handler(msg);

      // aggregator がバッファリングするため、quiet window 前は表示されない
      const output = getOutput();
      expect(output).not.toContain("降灰予報");
    });

    it("VFVO53 は quiet window 後に表示される", () => {
      const { handler } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR);
      handler(msg);

      vi.advanceTimersByTime(8_000);

      const output = getOutput();
      expect(output).toContain("降灰予報");
      expect(output).toContain("桜島");
    });

    it("flushAndDisposeVolcanoBuffer でバッファ内の VFVO53 が表示される", () => {
      const { handler, flushAndDisposeVolcanoBuffer } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR);
      handler(msg);

      // タイマー待ちなしでも flushAndDispose で強制 flush
      flushAndDisposeVolcanoBuffer();

      const output = getOutput();
      expect(output).toContain("降灰予報");
      expect(output).toContain("桜島");
    });

    it("VFVO54 割り込みで VFVO53 バッファが flush され、VFVO54 も表示される", () => {
      const { handler } = createHandler();

      // VFVO53 をバッファリング
      handler(createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR));
      expect(getOutput()).not.toContain("降灰予報");

      // VFVO54 割り込み → バッファ flush + VFVO54 即時表示
      handler(createMockWsDataMessage(FIXTURE_VFVO54_ASH_RAPID));

      const output = getOutput();
      // VFVO53 の flush 分 (通知なし flush だが表示はされる)
      expect(output).toContain("降灰予報（定時）");
      // VFVO54 の即時表示分
      expect(output).toContain("降灰予報（速報）");
    });

    it("VFVO54 割り込み時、flush された VFVO53 の通知は抑制される", () => {
      const { handler, notifier } = createHandler();
      const volcanoSpy = vi.spyOn(notifier, "notifyVolcano");
      const batchSpy = vi.spyOn(notifier, "notifyVolcanoBatch");

      // VFVO53 をバッファリング
      handler(createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR));

      // VFVO54 割り込み
      handler(createMockWsDataMessage(FIXTURE_VFVO54_ASH_RAPID));

      // flush された VFVO53 は notify: false なので notifyVolcano が呼ばれない
      // VFVO54 は直接委譲なので notifyVolcano が1回呼ばれる
      const volcanoInfoArgs = volcanoSpy.mock.calls.map((c) => c[0]);
      expect(volcanoInfoArgs).toHaveLength(1);
      expect(volcanoInfoArgs[0].type).toBe("VFVO54");

      // バッチ通知は呼ばれない (1件なので emitSingle 経由)
      expect(batchSpy).not.toHaveBeenCalled();
    });
  });

  describe("フォールバック", () => {
    it("非 XML メッセージはヘッダ表示する", () => {
      const { handler } = createHandler();
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
      const { handler } = createHandler();
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

  describe("統計記録 (TelegramStats)", () => {
    it("地震電文を統計に記録する", () => {
      const { handler, stats } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
      handler(msg);

      const snap = stats.getSnapshot();
      expect(snap.countByType.get("VXSE53")).toBe(1);
      expect(snap.categoryByType.get("VXSE53")).toBe("earthquake");
    });

    it("EEW 重複報は統計に含まれない", () => {
      const { handler, stats } = createHandler();
      const msg1 = createMockWsDataMessage(FIXTURE_VXSE45_S1);
      const msg2 = createMockWsDataMessage(FIXTURE_VXSE45_S1);
      handler(msg1);
      handler(msg2);

      const snap = stats.getSnapshot();
      expect(snap.countByType.get("VXSE45")).toBe(1);
    });

    it("非 XML メッセージは統計に含まれない", () => {
      const { handler, stats } = createHandler();
      const msg: WsDataMessage = {
        type: "data",
        version: "2.0",
        classification: "telegram.earthquake",
        id: "test-non-xml",
        passing: [],
        head: { type: "VXSE53", author: "気象庁", time: new Date().toISOString(), test: false, xml: false },
        format: null,
        compression: null,
        encoding: null,
        body: "not-xml",
      };
      handler(msg);

      const snap = stats.getSnapshot();
      expect(snap.totalCount).toBe(0);
    });

    it("EEW パース失敗は統計に含まれない", () => {
      const { handler, stats } = createHandler();
      // xml: true だが body が壊れた EEW 電文 → parseEewTelegram が null を返す
      const msg: WsDataMessage = {
        type: "data",
        version: "2.0",
        classification: "eew.forecast",
        id: "test-eew-parse-fail",
        passing: [],
        head: { type: "VXSE45", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
        format: "xml",
        compression: null,
        encoding: "utf-8",
        body: "not-valid-eew-xml",
      };
      handler(msg);

      const snap = stats.getSnapshot();
      expect(snap.totalCount).toBe(0);
    });

    it("非 EEW パース失敗 (フォールバック表示) は統計に含まれる", () => {
      const { handler, stats } = createHandler();
      // xml: true だが body が壊れた地震電文 → parseEarthquakeTelegram が null → displayRawHeader
      // ただし stats.record() はルーティング時点で呼ばれるのでカウントされる
      const msg: WsDataMessage = {
        type: "data",
        version: "2.0",
        classification: "telegram.earthquake",
        id: "test-eq-parse-fail",
        passing: [],
        head: { type: "VXSE53", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
        format: "xml",
        compression: null,
        encoding: "utf-8",
        body: "not-valid-earthquake-xml",
      };
      handler(msg);

      const snap = stats.getSnapshot();
      expect(snap.countByType.get("VXSE53")).toBe(1);
      expect(snap.categoryByType.get("VXSE53")).toBe("earthquake");
    });

    it("テスト電文は通常電文と同様にカウントされる", () => {
      const { handler, stats } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI, {
        head: { type: "VXSE53", author: "気象庁", time: new Date().toISOString(), test: true, xml: true },
      });
      handler(msg);

      const snap = stats.getSnapshot();
      expect(snap.countByType.get("VXSE53")).toBe(1);
    });
  });

});
