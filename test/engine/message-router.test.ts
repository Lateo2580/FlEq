import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMessageHandler } from "../../src/engine/messages/message-router";
import { createDisplayAdapter } from "../../src/ui/display-adapter";
import { TelegramStats } from "../../src/engine/messages/telegram-stats";
import { IGNORED_HEAD_TYPES as ROUTE_CATALOG_IGNORED_HEAD_TYPES } from "../../src/engine/messages/route-catalog";
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
  FIXTURE_VPZJ51_SENJOU,
  FIXTURE_VPFJ51_KANTO,
  FIXTURE_VPCI50_KANTO_TSUYU,
  FIXTURE_VPFT50_SAITAMA,
  FIXTURE_VMCJ53_OSHIO,
  FIXTURE_VMCJ54_OSHIO,
  FIXTURE_VMCJ55_FUKUSHINDO,
  FIXTURE_VPTW60_2020,
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

  describe("表示パイプライン stats 配線", () => {
    it("record → ingest → publishStats の順で呼ばれ、publishStats の todayQuakeCount が当該イベントを反映する", () => {
      const callOrder: string[] = [];
      const ingest = vi.fn(() => callOrder.push("ingest"));
      const publishStats = vi.fn(() => callOrder.push("publishStats"));
      const { handler } = createHandler({ displaySink: { ingest, publishStats } });

      const msg = createMockWsDataMessage(FIXTURE_VXSE51_SHINDO);
      handler(msg);

      expect(callOrder).toEqual(["ingest", "publishStats"]);
      expect(publishStats).toHaveBeenCalledTimes(1);
      const stats = publishStats.mock.calls[0][0];
      expect(stats.todayQuakeCount).toBeGreaterThanOrEqual(1);
      expect(stats.todayMaxIntRank).not.toBeNull();
    });

    it("JST 日またぎで totalReceived が todayQuakeCount と同じ暦日基準でリセットされる (Codex R: buildDisplayStats の now 一貫性)", () => {
      vi.useFakeTimers();
      try {
        // JST 2025-01-01 23:59 (UTC 14:59)
        vi.setSystemTime(new Date("2025-01-01T14:59:00Z"));
        const publishStats = vi.fn();
        const { handler } = createHandler({ displaySink: { ingest: vi.fn(), publishStats } });

        handler(createMockWsDataMessage(FIXTURE_VXSE51_SHINDO));
        const beforeSnap = publishStats.mock.calls[0][0];
        expect(beforeSnap.totalReceived).toBeGreaterThanOrEqual(1);
        expect(beforeSnap.todayQuakeCount).toBeGreaterThanOrEqual(1);

        // JST 2025-01-02 00:01 (UTC 15:01) へ進める (日またぎ)
        vi.setSystemTime(new Date("2025-01-01T15:01:00Z"));
        handler(createMockWsDataMessage(FIXTURE_VXSE51_SHINDO));
        const afterSnap = publishStats.mock.calls[publishStats.mock.calls.length - 1][0];

        // 日をまたいだので、totalReceived (TelegramStats) と todayQuakeCount (DailyQuakeCounter)
        // はどちらも当日分のみを反映し、揃って新規1件になる
        expect(afterSnap.totalReceived).toBe(1);
        expect(afterSnap.todayQuakeCount).toBe(1);
      } finally {
        vi.useRealTimers();
      }
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

  describe("気象解説情報 ルーティング", () => {
    it("VPZJ51 を全般気象解説情報として処理する", () => {
      const { handler } = createHandler();
      handler(createMockWsDataMessage(FIXTURE_VPZJ51_SENJOU));
      expect(getOutput()).toContain("全般気象解説情報");
    });

    it("VPFJ51 を府県気象解説情報として処理する", () => {
      const { handler } = createHandler();
      handler(createMockWsDataMessage(FIXTURE_VPFJ51_KANTO));
      expect(getOutput()).toContain("府県気象解説情報");
    });

    it("VMCJ53 (telegram.weather) は weatherExplanation ルートに分類される", () => {
      const { handler, stats } = createHandler();
      handler(createMockWsDataMessage(FIXTURE_VMCJ53_OSHIO));

      // weatherExplanation ルートで処理され、raw フォールバックに落ちない
      const snap = stats.getSnapshot();
      expect(snap.categoryByType.get("VMCJ53")).toBe("weatherExplanation");
      expect(getOutput()).toContain("大潮");
    });

    it("VMCJ54 (telegram.weather) は weatherExplanation ルートに分類される", () => {
      const { handler, stats } = createHandler();
      handler(createMockWsDataMessage(FIXTURE_VMCJ54_OSHIO));

      const snap = stats.getSnapshot();
      expect(snap.categoryByType.get("VMCJ54")).toBe("weatherExplanation");
      expect(getOutput()).toContain("大潮");
    });

    it("VMCJ55 (telegram.weather) は weatherExplanation ルートに分類される", () => {
      const { handler, stats } = createHandler();
      handler(createMockWsDataMessage(FIXTURE_VMCJ55_FUKUSHINDO));

      const snap = stats.getSnapshot();
      expect(snap.categoryByType.get("VMCJ55")).toBe("weatherExplanation");
      expect(getOutput()).toContain("副振動");
    });
  });

  describe("天候情報 ルーティング", () => {
    it("VPCI50 (telegram.weather) は climateInfo ルートに分類される", () => {
      const { handler, stats } = createHandler();
      handler(createMockWsDataMessage(FIXTURE_VPCI50_KANTO_TSUYU));

      // climateInfo ルートで処理され、統計カテゴリも climateInfo になる
      const snap = stats.getSnapshot();
      expect(snap.categoryByType.get("VPCI50")).toBe("climateInfo");
      // raw フォールバックではなくパース済み表示が出る (タイトル由来の地域名)
      expect(getOutput()).toContain("関東甲信");
    });
  });

  describe("熱中症警戒アラート ルーティング", () => {
    it("VPFT50 (telegram.weather) は heatAlert ルートに分類され raw に落ちない", () => {
      const { handler, stats } = createHandler();
      handler(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA));

      // heatAlert ルートで処理され、統計カテゴリも heatAlert になる
      const snap = stats.getSnapshot();
      expect(snap.categoryByType.get("VPFT50")).toBe("heatAlert");
      // raw フォールバックではなくパース済み表示が出る (タイトル由来の対象府県名)
      expect(getOutput()).toContain("埼玉県");
    });
  });

  describe("台風解析・予報情報 ルーティング", () => {
    it("VPTW60/61/62 (telegram.weather) は typhoonAnalysis ルートに分類される", () => {
      const { handler, stats } = createHandler();
      handler(createMockWsDataMessage(FIXTURE_VPTW60_2020));

      const snap = stats.getSnapshot();
      expect(snap.categoryByType.get("VPTW60")).toBe("typhoonAnalysis");
      expect(getOutput()).toContain("台風解析・予報情報");
    });
  });

  describe("配信終了予定電文の無視", () => {
    // 配信終了予定 + 既存表示と内容が重複するため、受信しても
    // Ignore these telegrams across display, notification, and statistics.
    // ルート定義の真実源 (route-catalog) から取り込み、2 箇所同期を解消する。
    const IGNORED_HEAD_TYPES = ROUTE_CATALOG_IGNORED_HEAD_TYPES;

    function makeWeatherMsg(headType: string): WsDataMessage {
      return {
        type: "data",
        version: "2.0",
        classification: "telegram.weather",
        id: `test-ignored-${headType}`,
        passing: [],
        head: { type: headType, author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
        format: "xml",
        compression: null,
        encoding: "utf-8",
        body: "<Report>ignored telegram body</Report>",
      };
    }

    it.each(IGNORED_HEAD_TYPES)("%s は受信しても表示されない（フォールバックも出ない）", (headType) => {
      const { handler } = createHandler();
      handler(makeWeatherMsg(headType));
      expect(getOutput()).toBe("");
    });

    it.each(IGNORED_HEAD_TYPES)("%s は統計に記録されない", (headType) => {
      const { handler, stats } = createHandler();
      handler(makeWeatherMsg(headType));
      expect(stats.getSnapshot().totalCount).toBe(0);
    });

  });

  describe("routeTaps (汎用購読点)", () => {
    /** telegram.weather の任意 head.type で最小 XML メッセージを作る */
    function makeWeatherMsg(headType: string): WsDataMessage {
      return {
        type: "data",
        version: "2.0",
        classification: "telegram.weather",
        id: `test-tap-${headType}`,
        passing: [],
        head: { type: headType, author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
        format: "xml",
        compression: null,
        encoding: "utf-8",
        body: "<Report>tap telegram body</Report>",
      };
    }

    it("分類済み電文で route と message 付きで呼ばれる", () => {
      const tap = vi.fn();
      const { handler } = createHandler({ routeTaps: [tap] });
      const msg = createMockWsDataMessage(FIXTURE_VXSE51_SHINDO);
      handler(msg);

      expect(tap).toHaveBeenCalledTimes(1);
      const event = tap.mock.calls[0][0];
      expect(event.route).toBe("earthquake");
      expect(event.message).toBe(msg);
    });

    it("ignore 対象の電文でも tap は呼ばれる (route === 'ignore')", () => {
      const tap = vi.fn();
      const { handler } = createHandler({ routeTaps: [tap] });
      // VPWW53 は IGNORED_HEAD_TYPES → ignore 早期 return するが、tap はその前に呼ばれる
      handler(makeWeatherMsg("VPWW53"));

      expect(tap).toHaveBeenCalledTimes(1);
      expect(tap.mock.calls[0][0].route).toBe("ignore");
    });

    it("tap 内で throw しても本体処理が正常継続する", () => {
      const throwing = vi.fn(() => {
        throw new Error("tap boom");
      });
      const following = vi.fn();
      const { handler, stats } = createHandler({ routeTaps: [throwing, following] });
      const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
      handler(msg);

      // 例外を投げた tap の後続 tap も呼ばれる
      expect(throwing).toHaveBeenCalledTimes(1);
      expect(following).toHaveBeenCalledTimes(1);
      // 本体処理 (表示・統計) が正常継続する
      expect(getOutput()).toContain("南太平洋");
      expect(stats.getSnapshot().countByType.get("VXSE53")).toBe(1);
    });

    it("tap が Error 以外 (null) を throw しても本体処理が正常継続する", () => {
      const throwingNull = vi.fn(() => {
        // eslint 的には行儀が悪いが、listener 実装の事故を模す
        throw null;
      });
      const following = vi.fn();
      const { handler, stats } = createHandler({ routeTaps: [throwingNull, following] });
      const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
      handler(msg);

      expect(throwingNull).toHaveBeenCalledTimes(1);
      expect(following).toHaveBeenCalledTimes(1);
      expect(stats.getSnapshot().countByType.get("VXSE53")).toBe(1);
    });

    it("routeTaps 未指定なら従来と完全同一挙動 (表示・統計に影響なし)", () => {
      const { handler, stats } = createHandler();
      const msg = createMockWsDataMessage(FIXTURE_VXSE51_SHINDO);
      handler(msg);

      expect(getOutput()).toContain("震度速報");
      expect(stats.getSnapshot().countByType.get("VXSE51")).toBe(1);
    });
  });

  describe("outcomeTaps (処理済み outcome の汎用購読点)", () => {
    it("線形ルートの outcome が渡る (domain と headType を観測できる)", () => {
      const tap = vi.fn();
      const { handler } = createHandler({ outcomeTaps: [tap] });
      handler(createMockWsDataMessage(FIXTURE_VXSE53_ENCHI));

      expect(tap).toHaveBeenCalledTimes(1);
      const outcome = tap.mock.calls[0][0];
      expect(outcome.domain).toBe("earthquake");
      expect(outcome.headType).toBe("VXSE53");
    });

    it("火山ルート (VolcanoRouteHandler 経由) の outcome も渡る", () => {
      const tap = vi.fn();
      const { handler } = createHandler({ outcomeTaps: [tap] });
      handler(createMockWsDataMessage(FIXTURE_VFVO54_ASH_RAPID));

      expect(tap).toHaveBeenCalledTimes(1);
      expect(tap.mock.calls[0][0].domain).toBe("volcano");
    });

    it("suppressed で outcome が生成されない電文では呼ばれない (EEW 重複報)", () => {
      const tap = vi.fn();
      const { handler } = createHandler({ outcomeTaps: [tap] });
      handler(createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1));
      expect(tap).toHaveBeenCalledTimes(1);

      // 同一 EventID・同一 Serial の重複報 → processMessage が null → tap は増えない
      handler(createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1));
      expect(tap).toHaveBeenCalledTimes(1);
    });

    it("tap 内で throw しても本体処理 (表示・統計) が正常継続する", () => {
      const throwing = vi.fn(() => {
        throw new Error("outcome tap boom");
      });
      const { handler, stats } = createHandler({ outcomeTaps: [throwing] });
      handler(createMockWsDataMessage(FIXTURE_VXSE53_ENCHI));

      expect(throwing).toHaveBeenCalledTimes(1);
      expect(getOutput()).toContain("南太平洋");
      expect(stats.getSnapshot().countByType.get("VXSE53")).toBe(1);
    });
  });
});
