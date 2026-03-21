import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  VolcanoVfvo53Aggregator,
  Vfvo53BatchItems,
  FlushOptions,
} from "../../src/engine/messages/volcano-vfvo53-aggregator";
import type {
  ParsedVolcanoAshfallInfo,
  ParsedVolcanoInfo,
  ParsedVolcanoEruptionInfo,
} from "../../src/types";

// ── ヘルパー ──

function createVfvo53(overrides: Partial<ParsedVolcanoAshfallInfo> = {}): ParsedVolcanoAshfallInfo {
  return {
    domain: "volcano",
    kind: "ashfall",
    type: "VFVO53",
    subKind: "scheduled",
    infoType: "発表",
    title: "降灰予報（定時）",
    reportDateTime: "2025-03-21T09:00:00+09:00",
    eventDateTime: null,
    headline: null,
    publishingOffice: "気象庁",
    volcanoName: "桜島",
    volcanoCode: "506",
    coordinate: "+31.58+130.66/",
    isTest: false,
    craterName: "南岳",
    ashForecasts: [
      {
        startTime: "2025-03-21T09:00:00+09:00",
        endTime: "2025-03-21T12:00:00+09:00",
        areas: [
          { name: "鹿児島市", code: "4620100", ashCode: "71", ashName: "少量の降灰", thickness: null },
        ],
      },
    ],
    plumeHeight: 1000,
    plumeDirection: "南東",
    bodyText: "桜島の活動状況",
    ...overrides,
  };
}

function createVfvo54(overrides: Partial<ParsedVolcanoAshfallInfo> = {}): ParsedVolcanoAshfallInfo {
  return {
    ...createVfvo53(),
    type: "VFVO54",
    subKind: "rapid",
    title: "降灰予報（速報）",
    ...overrides,
  };
}

function createVfvo52(overrides: Partial<ParsedVolcanoEruptionInfo> = {}): ParsedVolcanoEruptionInfo {
  return {
    domain: "volcano",
    kind: "eruption",
    type: "VFVO52",
    infoType: "発表",
    title: "噴火に関する火山観測報",
    reportDateTime: "2025-03-21T09:00:00+09:00",
    eventDateTime: null,
    headline: null,
    publishingOffice: "気象庁",
    volcanoName: "桜島",
    volcanoCode: "506",
    coordinate: "+31.58+130.66/",
    isTest: false,
    phenomenonCode: "explosion",
    phenomenonName: "爆発",
    craterName: "南岳",
    plumeHeight: 3000,
    plumeHeightUnknown: false,
    plumeDirection: "南東",
    isFlashReport: false,
    bodyText: "噴火に関する火山観測報の本文",
    ...overrides,
  };
}

// ── テスト ──

describe("VolcanoVfvo53Aggregator", () => {
  let emitSingle: ReturnType<typeof vi.fn>;
  let emitBatch: ReturnType<typeof vi.fn>;
  let aggregator: VolcanoVfvo53Aggregator;

  beforeEach(() => {
    vi.useFakeTimers();
    emitSingle = vi.fn();
    emitBatch = vi.fn();
    aggregator = new VolcanoVfvo53Aggregator(emitSingle, emitBatch, {
      quietMs: 100,
      maxWaitMs: 500,
      maxItems: 5,
    });
  });

  afterEach(() => {
    aggregator.flushAndDispose();
    vi.useRealTimers();
  });

  describe("単発 VFVO53", () => {
    it("quietMs 後に emitSingle が呼ばれる", () => {
      aggregator.handle(createVfvo53());

      expect(emitSingle).not.toHaveBeenCalled();
      expect(emitBatch).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);

      expect(emitSingle).toHaveBeenCalledTimes(1);
      expect(emitSingle).toHaveBeenCalledWith(
        expect.objectContaining({ volcanoCode: "506", type: "VFVO53" }),
        { notify: true },
      );
      expect(emitBatch).not.toHaveBeenCalled();
    });
  });

  describe("複数火山のバッチ", () => {
    it("quietMs 後に emitBatch が呼ばれる", () => {
      aggregator.handle(createVfvo53({ volcanoCode: "506", volcanoName: "桜島" }));
      vi.advanceTimersByTime(50);
      aggregator.handle(createVfvo53({ volcanoCode: "303", volcanoName: "浅間山" }));
      vi.advanceTimersByTime(50);
      aggregator.handle(createVfvo53({ volcanoCode: "503", volcanoName: "阿蘇山" }));

      expect(emitBatch).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);

      expect(emitBatch).toHaveBeenCalledTimes(1);
      const batch: Vfvo53BatchItems = emitBatch.mock.calls[0][0];
      expect(batch.items).toHaveLength(3);
      // 日本語名ソート
      expect(batch.items.map((i) => i.volcanoName)).toEqual(["阿蘇山", "桜島", "浅間山"]);
      expect(batch.isTest).toBe(false);
    });
  });

  describe("quiet window リセット", () => {
    it("到着が続く間は flush されない", () => {
      aggregator.handle(createVfvo53({ volcanoCode: "506", volcanoName: "桜島" }));
      vi.advanceTimersByTime(80);

      // 80ms 後に2通目 → quiet window リセット
      aggregator.handle(createVfvo53({ volcanoCode: "303", volcanoName: "浅間山" }));
      vi.advanceTimersByTime(80);

      // 160ms時点ではまだ flush されない
      expect(emitBatch).not.toHaveBeenCalled();

      // quiet window 満了
      vi.advanceTimersByTime(20);
      expect(emitBatch).toHaveBeenCalledTimes(1);
    });
  });

  describe("maxWaitMs 強制 flush", () => {
    it("maxWaitMs 付近で timer delay が短縮される", () => {
      // maxWaitMs=500 に対して、450ms 経過時点で到着すると delay が 50ms に短縮
      const aggr = new VolcanoVfvo53Aggregator(emitSingle, emitBatch, {
        quietMs: 200,
        maxWaitMs: 500,
        maxItems: 20,
      });

      aggr.handle(createVfvo53({ volcanoCode: "501", volcanoName: "火山1" }));
      vi.advanceTimersByTime(150); // t=150
      aggr.handle(createVfvo53({ volcanoCode: "502", volcanoName: "火山2" }));
      vi.advanceTimersByTime(150); // t=300
      aggr.handle(createVfvo53({ volcanoCode: "503", volcanoName: "火山3" }));
      vi.advanceTimersByTime(150); // t=450
      aggr.handle(createVfvo53({ volcanoCode: "504", volcanoName: "火山4" }));

      // t=450: maxWait残り50ms, delay=min(200, 50)=50
      expect(emitBatch).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50); // t=500: maxWait flush
      expect(emitBatch).toHaveBeenCalledTimes(1);
      const batch: Vfvo53BatchItems = emitBatch.mock.calls[0][0];
      expect(batch.items).toHaveLength(4);

      aggr.flushAndDispose();
    });
  });

  describe("maxItems 即 flush", () => {
    it("maxItems 到達で即 flush される", () => {
      for (let i = 0; i < 5; i++) {
        aggregator.handle(
          createVfvo53({ volcanoCode: `${500 + i}`, volcanoName: `火山${i}` }),
        );
      }

      // タイマー待ちなしで即 flush
      expect(emitBatch).toHaveBeenCalledTimes(1);
      const batch: Vfvo53BatchItems = emitBatch.mock.calls[0][0];
      expect(batch.items).toHaveLength(5);
    });
  });

  describe("取消電文", () => {
    it("即時 emitSingle され、バッファから同火山が除去される", () => {
      aggregator.handle(createVfvo53({ volcanoCode: "506", volcanoName: "桜島" }));
      aggregator.handle(createVfvo53({ volcanoCode: "303", volcanoName: "浅間山" }));

      // 桜島の取消
      aggregator.handle(createVfvo53({ volcanoCode: "506", volcanoName: "桜島", infoType: "取消" }));

      expect(emitSingle).toHaveBeenCalledTimes(1);
      expect(emitSingle).toHaveBeenCalledWith(
        expect.objectContaining({ volcanoCode: "506", infoType: "取消" }),
      );

      // quiet window 後、浅間山だけ flush → 単発なので emitSingle
      vi.advanceTimersByTime(100);
      expect(emitSingle).toHaveBeenCalledTimes(2);
      expect(emitSingle).toHaveBeenLastCalledWith(
        expect.objectContaining({ volcanoCode: "303" }),
        { notify: true },
      );
      expect(emitBatch).not.toHaveBeenCalled();
    });

    it("取消後にバッファ空ならタイマー停止", () => {
      aggregator.handle(createVfvo53({ volcanoCode: "506" }));
      aggregator.handle(createVfvo53({ volcanoCode: "506", infoType: "取消" }));

      vi.advanceTimersByTime(200);

      // 取消の1回だけ
      expect(emitSingle).toHaveBeenCalledTimes(1);
      expect(emitBatch).not.toHaveBeenCalled();
    });
  });

  describe("VFVO54 割り込み", () => {
    it("pending flush (notify: false) + VFVO54 は即時 emitSingle", () => {
      aggregator.handle(createVfvo53({ volcanoCode: "506", volcanoName: "桜島" }));
      aggregator.handle(createVfvo53({ volcanoCode: "303", volcanoName: "浅間山" }));

      // VFVO54 割り込み
      aggregator.handle(createVfvo54({ volcanoCode: "506", volcanoName: "桜島" }));

      // pending バッチが通知なしで flush
      expect(emitBatch).toHaveBeenCalledTimes(1);
      const batchOpts: FlushOptions = emitBatch.mock.calls[0][1];
      expect(batchOpts.notify).toBe(false);

      // VFVO54 は即時 emitSingle
      expect(emitSingle).toHaveBeenCalledTimes(1);
      expect(emitSingle).toHaveBeenCalledWith(
        expect.objectContaining({ type: "VFVO54" }),
      );
    });

    it("単一件バッファ中の割り込みでも notify: false が emitSingle に伝播する", () => {
      // 1件だけバッファ中
      aggregator.handle(createVfvo53({ volcanoCode: "506", volcanoName: "桜島" }));

      // VFVO54 割り込み → 単一件 flush (notify: false)
      aggregator.handle(createVfvo54({ volcanoCode: "303", volcanoName: "浅間山" }));

      // 単一件 flush は emitSingle に opts を渡す
      expect(emitSingle).toHaveBeenCalledTimes(2);
      // 1回目: バッファからの flush (notify: false)
      expect(emitSingle.mock.calls[0][0]).toMatchObject({ volcanoCode: "506", type: "VFVO53" });
      expect(emitSingle.mock.calls[0][1]).toEqual({ notify: false });
      // 2回目: VFVO54 即時委譲 (opts なし)
      expect(emitSingle.mock.calls[1][0]).toMatchObject({ type: "VFVO54" });

      expect(emitBatch).not.toHaveBeenCalled();
    });
  });

  describe("他の火山電文による割り込み", () => {
    it("VFVO52 (噴火観測報) でも pending flush + 即時委譲", () => {
      aggregator.handle(createVfvo53({ volcanoCode: "506", volcanoName: "桜島" }));
      aggregator.handle(createVfvo53({ volcanoCode: "303", volcanoName: "浅間山" }));

      aggregator.handle(createVfvo52());

      expect(emitBatch).toHaveBeenCalledTimes(1);
      const batchOpts: FlushOptions = emitBatch.mock.calls[0][1];
      expect(batchOpts.notify).toBe(false);

      expect(emitSingle).toHaveBeenCalledTimes(1);
      expect(emitSingle).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "eruption" }),
      );
    });
  });

  describe("同一火山の重複", () => {
    it("volcanoCode で上書きされる", () => {
      const first = createVfvo53({
        volcanoCode: "506",
        volcanoName: "桜島",
        bodyText: "古い情報",
      });
      const second = createVfvo53({
        volcanoCode: "506",
        volcanoName: "桜島",
        bodyText: "新しい情報",
      });

      aggregator.handle(first);
      aggregator.handle(second);

      vi.advanceTimersByTime(100);

      expect(emitSingle).toHaveBeenCalledTimes(1);
      expect(emitSingle).toHaveBeenCalledWith(
        expect.objectContaining({ bodyText: "新しい情報" }),
        { notify: true },
      );
    });
  });

  describe("バッチキー不一致", () => {
    it("reportDateTime が異なると先行バッチ flush + 新バッチ開始", () => {
      aggregator.handle(
        createVfvo53({
          volcanoCode: "506",
          volcanoName: "桜島",
          reportDateTime: "2025-03-21T09:00:00+09:00",
        }),
      );
      aggregator.handle(
        createVfvo53({
          volcanoCode: "303",
          volcanoName: "浅間山",
          reportDateTime: "2025-03-21T09:00:00+09:00",
        }),
      );

      // 別サイクルの VFVO53
      aggregator.handle(
        createVfvo53({
          volcanoCode: "506",
          volcanoName: "桜島",
          reportDateTime: "2025-03-21T15:00:00+09:00",
        }),
      );

      // 先行バッチが flush される
      expect(emitBatch).toHaveBeenCalledTimes(1);
      const batch: Vfvo53BatchItems = emitBatch.mock.calls[0][0];
      expect(batch.items).toHaveLength(2);
      expect(batch.reportDateTime).toBe("2025-03-21T09:00:00+09:00");

      // 新バッチはまだバッファ中
      vi.advanceTimersByTime(100);
      expect(emitSingle).toHaveBeenCalledTimes(1); // 新バッチ1件なので single
      expect(emitSingle).toHaveBeenCalledWith(
        expect.objectContaining({ reportDateTime: "2025-03-21T15:00:00+09:00" }),
        { notify: true },
      );
    });

    it("isTest が異なると別バッチになる", () => {
      aggregator.handle(createVfvo53({ volcanoCode: "506", isTest: false }));
      aggregator.handle(createVfvo53({ volcanoCode: "303", isTest: true }));

      // isTest が異なるので先行 flush
      expect(emitSingle).toHaveBeenCalledTimes(1);
      expect(emitSingle).toHaveBeenCalledWith(
        expect.objectContaining({ volcanoCode: "506", isTest: false }),
        { notify: true },
      );

      // 新バッチ (isTest=true) はバッファ中
      vi.advanceTimersByTime(100);
      expect(emitSingle).toHaveBeenCalledTimes(2);
    });
  });

  describe("flushAndDispose", () => {
    it("残りを全 flush + タイマー破棄", () => {
      aggregator.handle(createVfvo53({ volcanoCode: "506", volcanoName: "桜島" }));
      aggregator.handle(createVfvo53({ volcanoCode: "303", volcanoName: "浅間山" }));

      aggregator.flushAndDispose();

      expect(emitBatch).toHaveBeenCalledTimes(1);
      const batch: Vfvo53BatchItems = emitBatch.mock.calls[0][0];
      expect(batch.items).toHaveLength(2);
    });

    it("dispose 後は emitSingle に直接委譲される", () => {
      aggregator.flushAndDispose();

      aggregator.handle(createVfvo53({ volcanoCode: "506" }));
      expect(emitSingle).toHaveBeenCalledTimes(1);

      // バッファリングされない
      vi.advanceTimersByTime(200);
      expect(emitSingle).toHaveBeenCalledTimes(1);
      expect(emitBatch).not.toHaveBeenCalled();
    });

    it("二重呼び出しは安全", () => {
      aggregator.handle(createVfvo53({ volcanoCode: "506" }));
      aggregator.flushAndDispose();
      aggregator.flushAndDispose();

      expect(emitSingle).toHaveBeenCalledTimes(1);
    });
  });
});
