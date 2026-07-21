import { describe, it, expect } from "vitest";
import { TyphoonProbabilityStateHolder } from "../../../src/engine/messages/typhoon-probability-state";

/**
 * TyphoonProbabilityStateHolder の敵対的シーケンステスト。
 *
 * typhoon-probability-state.test.ts に単発の遷移 (初回/連続ゼロ/0↔非0/rollback/
 * 空 eventId) が入っているので、このファイルは複数 EventID が交互に届く実運用
 * シーケンスでの独立性と、この holder が「時刻順序を判定しない」設計であること
 * を固定する。
 *
 * この holder は receivedAt を保持するが順序比較には使わない (連続ゼロ dedup のみ)。
 * よって遅着した非ゼロ報も抑制されず必ず再通知される — 安全側 (見落とさない) の
 * 契約を回帰テストとして明示する。
 */

describe("TyphoonProbabilityStateHolder 敵対シーケンス", () => {
  it("複数 EventID が交互に届いても連続ゼロ判定が混線しない", () => {
    const h = new TyphoonProbabilityStateHolder();
    expect(h.diffAndUpdate("TC-A", 0, "t1").isUnchangedZero).toBe(false); // A 初回ゼロ
    expect(h.diffAndUpdate("TC-B", 0, "t2").isUnchangedZero).toBe(false); // B 初回ゼロ
    expect(h.diffAndUpdate("TC-A", 0, "t3").isUnchangedZero).toBe(true); // A 連続ゼロ
    expect(h.diffAndUpdate("TC-B", 50, "t4").isUnchangedZero).toBe(false); // B 上昇 (A の履歴に影響しない)
    // A の連続ゼロ判定は B の遷移に汚染されず維持される
    expect(h.diffAndUpdate("TC-A", 0, "t5").isUnchangedZero).toBe(true);
  });

  it("遅着した非ゼロ報は順序を問わず再通知される (時刻順序で dedup しない)", () => {
    const h = new TyphoonProbabilityStateHolder();
    h.diffAndUpdate("TC-A", 0, "2026-06-02T15:00:00+09:00");
    expect(h.diffAndUpdate("TC-A", 0, "2026-06-02T16:00:00+09:00").isUnchangedZero).toBe(true);

    // 上の 2 報より前の時刻の非ゼロ報が遅れて届く → receivedAt は比較されず、非ゼロなので再通知
    const late = h.diffAndUpdate("TC-A", 50, "2026-06-02T15:30:00+09:00");
    expect(late.isUnchangedZero).toBe(false);
  });

  it("未受信 EventID の rollback は no-op で他 EventID を壊さない", () => {
    const h = new TyphoonProbabilityStateHolder();
    h.diffAndUpdate("TC-A", 0, "t1");
    expect(() => h.rollback("TC-UNSEEN")).not.toThrow();
    // 無関係な rollback で A の履歴は消えない
    expect(h.diffAndUpdate("TC-A", 0, "t2").isUnchangedZero).toBe(true);
  });
});
