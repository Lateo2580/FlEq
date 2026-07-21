import { describe, it, expect } from "vitest";
import { FloodForecastStateHolder } from "../../../src/engine/messages/flood-forecast-state";
import type { StationDigest } from "../../../src/engine/messages/flood-forecast-state";

/**
 * FloodForecastStateHolder の敵対的シーケンステスト。
 *
 * flood-forecast-state.test.ts に各 reason の差分検出・削除・EventID 独立・
 * rollback が入っているので、このファイルは「観測点が消えて再登場するフラッピング」
 * 「取消(rollback)後に旧報が遅着する」といったシーケンスと、この holder が
 * 時刻順序を判定しない設計であることを固定する。
 *
 * この holder は receivedAt を保持するが順序比較には使わない (station digest の
 * dedup のみ)。取消/訂正/遅着の順序解決は processor 側の責務。
 */

const mkDigest = (over: Partial<StationDigest>): StationDigest => ({
  stationCode: "s1",
  kindCode: "20",
  headlineLevel: "L2",
  stationObservedLevel: "L2",
  condition: "正常",
  mainItemCode: "1",
  mainTextHash: "h1",
  ...over,
});

describe("FloodForecastStateHolder 敵対シーケンス", () => {
  it("観測点が消えて再登場すると 'new' 扱いに戻る (削除で履歴が消える)", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate("e1", [mkDigest({ stationCode: "s1" }), mkDigest({ stationCode: "s2" })], null);
    // s2 が report から消える → removedStations
    const removed = h.diffAndUpdate("e1", [mkDigest({ stationCode: "s1" })], null);
    expect(removed.removedStations).toEqual(["s2"]);

    // s2 が再登場 → 履歴は消えているので 'new'、s1 は無変化なので changedStations に出ない
    const back = h.diffAndUpdate("e1", [mkDigest({ stationCode: "s1" }), mkDigest({ stationCode: "s2" })], null);
    expect(back.hasChange).toBe(true);
    expect(back.changedStations).toHaveLength(1);
    expect(back.changedStations[0].stationCode).toBe("s2");
    expect(back.changedStations[0].reasons).toEqual(["new"]);
  });

  it("取消(rollback)後に旧報が遅着しても新規扱いで再通知し、静かに握り潰さない", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate("e1", [mkDigest({ stationCode: "s1", condition: "正常" })], null);
    h.rollback("e1");

    // 取消前と同一内容の旧報が遅れて届く → 履歴が消えているので 'new' として再通知
    const late = h.diffAndUpdate("e1", [mkDigest({ stationCode: "s1", condition: "正常" })], null);
    expect(late.hasChange).toBe(true);
    expect(late.changedStations[0].reasons).toEqual(["new"]);
  });

  it("時刻順序は判定しない: 遅着した古い digest が新しい状態を上書きする (dedup のみ)", () => {
    const h = new FloodForecastStateHolder();
    // 新しい観測 (上昇) を先に受信
    h.diffAndUpdate("e1", [mkDigest({ stationCode: "s1", condition: "上昇" })], "2026-06-14T16:00:00+09:00");
    // より古い時刻の digest (正常) が遅れて届く → receivedAt は比較されず condition 差分として通る
    const stale = h.diffAndUpdate("e1", [mkDigest({ stationCode: "s1", condition: "正常" })], "2026-06-14T15:00:00+09:00");
    expect(stale.hasChange).toBe(true);
    expect(stale.changedStations[0].reasons).toEqual(["condition"]);
  });

  it("未受信 EventID の rollback は no-op で他 EventID を壊さない", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate("e1", [mkDigest({})], null);
    expect(() => h.rollback("e-unseen")).not.toThrow();
    // 無関係な rollback で e1 の履歴は維持される
    const d = h.diffAndUpdate("e1", [mkDigest({})], null);
    expect(d.hasChange).toBe(false);
  });
});
