import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEATHER_PROMOTION_DEMOTE_MIN,
  WEATHER_PROMOTION_MAX_RESTORE_AGE_MS,
  WEATHER_PROMOTION_CLOCK_SKEW_TOLERANCE_MS,
} from "../../../src/engine/display/constants";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { WeatherPromotionPersistence } from "../../../src/engine/display/weather-promotion-persistence";
import {
  WeatherPromotionStore,
  type WeatherPromotionPersistedV1,
  type WeatherPromotionRecord,
} from "../../../src/engine/display/weather-promotion-store";
import type { DisplayWeatherAlertV1 } from "../../../src/engine/display/types";
import * as log from "../../../src/logger";

const MIN = 60_000;
const T0 = Date.parse("2026-07-25T21:00:00+09:00");
const DEMOTE_MS = WEATHER_PROMOTION_DEMOTE_MIN * MIN;

function alertsOf(source: "vpws50" | "vpww56", severity: string, areas: string[]): DisplayWeatherAlertV1[] {
  return [
    {
      source,
      label: "気象警報",
      role: "weatherWarning",
      totalAreas: areas.length,
      items: [{ kind: `${severity} 大雨警報`, displaySeverity: severity, rank: "warning", shownAreas: areas, omittedAreaCount: 0 }],
      updatedAt: "2026-07-25T21:00:00+09:00",
    },
  ];
}

function activeRecord(over: Partial<Extract<WeatherPromotionRecord, { state: "active" }>> = {}) {
  return {
    state: "active" as const,
    level: 5 as const,
    promotedAtMs: T0,
    generation: 3,
    signature: "sig-a",
    ...over,
  };
}

// ── 復元判定 (WeatherPromotionStore.restore) ──

describe("WeatherPromotionStore.restore (残り時間だけ復元する)", () => {
  function restored(records: Partial<WeatherPromotionPersistedV1["records"]>, nowMs: number, generations = { vpws50: 0, vpww56: 0 }) {
    const store = new WeatherPromotionStore();
    store.restore({ records: { vpws50: null, vpww56: null, ...records }, generations }, nowMs);
    return store;
  }

  it("30 分未経過の active は残り時間を引き継いで active のまま復元される", () => {
    const store = restored({ vpws50: activeRecord() }, T0 + 10 * MIN);
    const rec = store.get("vpws50");
    expect(rec?.state).toBe("active");
    // promotedAtMs は据置 = 残り 20 分。延命していない
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(T0);
    // 残り時間を過ぎたら通常どおり降格する
    expect(store.sweepDemote(T0 + DEMOTE_MS + 5_000)).toBe(true);
    expect(store.get("vpws50")?.state).toBe("demoted");
  });

  it("既に 30 分経過済みの active は demoted で復元される (再起動による延命なし)", () => {
    const store = restored({ vpws50: activeRecord() }, T0 + DEMOTE_MS + 1);
    const rec = store.get("vpws50");
    expect(rec?.state).toBe("demoted");
    expect(rec?.level).toBe(5);
    expect(rec?.generation).toBe(3);
  });

  // ヘルツ指摘 4: 未来時刻では「30 分経ったか」も「まだ有効か」も判定できない。
  // demoted で残すと tier と weatherL5Active だけが無期限に固定される最悪の縮退になる
  it("promotedAtMs が未来なら record を破棄する (demoted にもしない)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const store = restored({ vpws50: activeRecord() }, T0 - 60 * MIN);
      expect(store.get("vpws50")).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("未来 promotedAtMs の破棄後は tier も weatherL5Active も立たない", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const promotions = new WeatherPromotionStore();
      promotions.restore(
        { records: { vpws50: activeRecord(), vpww56: null }, generations: { vpws50: 3, vpww56: 0 } },
        T0 - 60 * MIN,
      );
      const store = new DisplayStateStore(undefined, promotions);
      const snap = store.snapshot(1, T0 - 60 * MIN);
      expect(snap.severityTier).toBe("calm");
      expect(snap.weatherL5Active).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("record を破棄しても watermark は残る (generation を再利用しない)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const store = restored({ vpws50: activeRecord({ generation: 3 }) }, T0 - 60 * MIN, { vpws50: 3, vpww56: 0 });
      store.apply("vpws50", alertsOf("vpws50", "officialL4", ["千葉県"]), T0);
      expect(store.get("vpws50")?.generation).toBe(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("許容誤差 (sweep 1 周期) 以内の未来は active のまま扱う", () => {
    const store = restored({ vpws50: activeRecord() }, T0 - (WEATHER_PROMOTION_CLOCK_SKEW_TOLERANCE_MS - 1));
    expect(store.get("vpws50")?.state).toBe("active");
  });

  it("demoted record は demoted のまま復元され、level と generation を保つ", () => {
    const store = restored(
      { vpww56: { state: "demoted", level: 4, generation: 7, signature: "s" } },
      T0,
    );
    const rec = store.get("vpww56");
    expect(rec).toEqual({ state: "demoted", level: 4, generation: 7, signature: "s" });
  });

  it("watermark は保存値と record の generation の大きい方を採る", () => {
    // 保存 watermark(1) < record.generation(3) のとき、次の新規昇格は 4 になる
    const store = restored({ vpws50: activeRecord({ generation: 3 }) }, T0, { vpws50: 1, vpww56: 0 });
    store.apply("vpws50", alertsOf("vpws50", "officialL4", ["千葉県"]), T0 + MIN);
    expect(store.get("vpws50")?.generation).toBe(4);
  });

  it("復元後に同内容の続報が来たら generation は据置 (signature が保存されている)", () => {
    const view = alertsOf("vpws50", "officialL5", ["東京都"]);
    const source = new WeatherPromotionStore();
    source.apply("vpws50", view, T0);
    const exported = JSON.parse(JSON.stringify(source.export())) as WeatherPromotionPersistedV1;

    const store = new WeatherPromotionStore();
    store.restore(exported, T0 + MIN);
    store.apply("vpws50", view, T0 + 2 * MIN);
    expect(store.get("vpws50")?.generation).toBe(1);
  });

  it("records が全 null の保存内容も復元できる (前回の active が復活しない)", () => {
    const store = restored({}, T0);
    expect(store.get("vpws50")).toBeNull();
    expect(store.get("vpww56")).toBeNull();
  });

  it("復元した demoted は tier と weatherL5Active を保つ", () => {
    const promotions = new WeatherPromotionStore();
    promotions.restore(
      { records: { vpws50: { state: "demoted", level: 5, generation: 1, signature: "s" }, vpww56: null }, generations: { vpws50: 1, vpww56: 0 } },
      T0,
    );
    const store = new DisplayStateStore(undefined, promotions);
    const snap = store.snapshot(1, T0);
    expect(snap.severityTier).toBe("critical");
    expect(snap.weatherL5Active).toBe(true);
    // demoted は wire 上 null
    expect(snap.weatherPromotion).toEqual({ vpws50: null, vpww56: null });
  });
});

// ── 永続化 (WeatherPromotionPersistence) ──

describe("WeatherPromotionPersistence", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleq-promotion-"));
    file = join(dir, "weather-promotion-v1.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(content: unknown): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  }

  it("save したものを load で読み戻せる", () => {
    const p = new WeatherPromotionPersistence(file);
    const state: WeatherPromotionPersistedV1 = {
      records: { vpws50: activeRecord(), vpww56: null },
      generations: { vpws50: 3, vpww56: 0 },
    };
    p.save(state, T0);
    expect(existsSync(file)).toBe(true);
    const loaded = p.load(T0 + MIN);
    expect(loaded?.records.vpws50).toEqual(activeRecord());
    expect(loaded?.generations.vpws50).toBe(3);
  });

  it("savedAt は呼び出し側の nowMs から作る (Date.now() を内部で呼ばない)", () => {
    const p = new WeatherPromotionPersistence(file);
    p.save({ records: { vpws50: null, vpww56: null }, generations: { vpws50: 0, vpww56: 0 } }, T0);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.savedAt).toBe(new Date(T0).toISOString());
    expect(raw.version).toBe(1);
  });

  it("records が全 null の状態も書き込む (解除済みの昇格が再起動で復活しない)", () => {
    const p = new WeatherPromotionPersistence(file);
    p.save({ records: { vpws50: activeRecord(), vpww56: null }, generations: { vpws50: 3, vpww56: 0 } }, T0);
    p.save({ records: { vpws50: null, vpww56: null }, generations: { vpws50: 3, vpww56: 0 } }, T0 + MIN);
    const loaded = p.load(T0 + 2 * MIN);
    expect(loaded?.records.vpws50).toBeNull();
    // watermark は残る
    expect(loaded?.generations.vpws50).toBe(3);
  });

  it("ファイルが無ければ null (起動を妨げない)", () => {
    expect(new WeatherPromotionPersistence(file).load(T0)).toBeNull();
  });

  it("壊れた JSON は null (起動を妨げない)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      write("{ not json");
      expect(new WeatherPromotionPersistence(file).load(T0)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("version 不一致は null", () => {
    write({ version: 99, savedAt: new Date(T0).toISOString(), records: {}, generations: {} });
    expect(new WeatherPromotionPersistence(file).load(T0)).toBeNull();
  });

  it("savedAt 欠落は null", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      write({ version: 1, records: {}, generations: {} });
      expect(new WeatherPromotionPersistence(file).load(T0)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("保存から 24 時間以上経ったデータは破棄する", () => {
    const p = new WeatherPromotionPersistence(file);
    p.save({ records: { vpws50: activeRecord(), vpww56: null }, generations: { vpws50: 3, vpww56: 0 } }, T0);
    expect(p.load(T0 + WEATHER_PROMOTION_MAX_RESTORE_AGE_MS - MIN)).not.toBeNull();
    expect(p.load(T0 + WEATHER_PROMOTION_MAX_RESTORE_AGE_MS + MIN)).toBeNull();
  });

  it("source 片方が壊れていても、もう片方は生きる", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      write({
        version: 1,
        savedAt: new Date(T0).toISOString(),
        records: {
          vpws50: { state: "active", level: 99, generation: 1, signature: "s", promotedAtMs: T0 }, // level 不正
          vpww56: { state: "demoted", level: 4, generation: 2, signature: "s" },
        },
        generations: { vpws50: 5, vpww56: 2 },
      });
      const loaded = new WeatherPromotionPersistence(file).load(T0);
      expect(loaded?.records.vpws50).toBeNull();
      expect(loaded?.records.vpww56).toEqual({ state: "demoted", level: 4, generation: 2, signature: "s" });
      // 壊れた側の watermark は保存値を維持する (generation の再利用を防ぐ)
      expect(loaded?.generations.vpws50).toBe(5);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("signature 欠落の record は破棄する (復元後の unchanged 判定が壊れるため)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      write({
        version: 1,
        savedAt: new Date(T0).toISOString(),
        records: { vpws50: { state: "active", level: 5, generation: 1, promotedAtMs: T0 }, vpww56: null },
        generations: { vpws50: 1, vpww56: 0 },
      });
      expect(new WeatherPromotionPersistence(file).load(T0)?.records.vpws50).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("予約中の再呼び出しは最新で上書きし、書き込みは 1 回だけ", async () => {
    const p = new WeatherPromotionPersistence(file, 10_000);
    p.schedule({ records: { vpws50: activeRecord({ generation: 1 }), vpww56: null }, generations: { vpws50: 1, vpww56: 0 } }, T0);
    p.schedule({ records: { vpws50: activeRecord({ generation: 2 }), vpww56: null }, generations: { vpws50: 2, vpww56: 0 } }, T0);
    expect(existsSync(file)).toBe(false); // 予約直後はまだ書いていない
    await p.__test_writePending();
    expect(JSON.parse(readFileSync(file, "utf8")).generations.vpws50).toBe(2); // 最新だけが書かれる
    // 予約は消費済みなので二度目は何も書かない
    await p.__test_writePending();
    expect(JSON.parse(readFileSync(file, "utf8")).generations.vpws50).toBe(2);
  });

  it("flush は予約を同期で書き切り、予約が無ければ何もしない", () => {
    const p = new WeatherPromotionPersistence(file, 10_000);
    p.flush();
    expect(existsSync(file)).toBe(false);

    p.schedule({ records: { vpws50: activeRecord(), vpww56: null }, generations: { vpws50: 3, vpww56: 0 } }, T0);
    p.flush();
    expect(JSON.parse(readFileSync(file, "utf8")).generations.vpws50).toBe(3);
  });

  // ヘルツ指摘 3: 有限だが Date 範囲外の値。以前は未来判定のログで toISOString() が RangeError を投げ、
  // restore は load の try/catch の外なので起動ごと落ちていた
  it("有限だが Date 範囲外の promotedAtMs は破棄する (起動を妨げない)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      write({
        version: 1,
        savedAt: new Date(T0).toISOString(),
        records: { vpws50: { state: "active", level: 5, generation: 1, signature: "s", promotedAtMs: 1e20 }, vpww56: null },
        generations: { vpws50: 1, vpww56: 0 },
      });
      const loaded = new WeatherPromotionPersistence(file).load(T0);
      expect(loaded?.records.vpws50).toBeNull();
      // 万一 sanitize を抜けても restore で落ちないこと
      const store = new WeatherPromotionStore();
      expect(() => store.restore(
        { records: { vpws50: { state: "active", level: 5, generation: 1, signature: "s", promotedAtMs: 1e20 }, vpww56: null }, generations: { vpws50: 1, vpww56: 0 } },
        T0,
      )).not.toThrow();
    } finally {
      warn.mockRestore();
    }
  });

  it("savedAt が未来なら record は捨てるが watermark は残す (generation を再利用しない)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const p = new WeatherPromotionPersistence(file);
      p.save({ records: { vpws50: { state: "demoted", level: 5, generation: 4, signature: "s" }, vpww56: null }, generations: { vpws50: 4, vpww56: 0 } }, T0);
      // 現在時刻が保存時刻より前 = savedAt が未来
      const loaded = p.load(T0 - 60 * MIN);
      expect(loaded).not.toBeNull();
      expect(loaded?.records.vpws50).toBeNull();
      expect(loaded?.generations.vpws50).toBe(4);

      // 復元後の次の昇格は generation 5 から (1 に戻らない)
      const store = new WeatherPromotionStore();
      store.restore(loaded!, T0);
      store.apply("vpws50", alertsOf("vpws50", "officialL5", ["東京都"]), T0);
      expect(store.get("vpws50")?.generation).toBe(5);
    } finally {
      warn.mockRestore();
    }
  });

  it("generation が safe integer でなければ破棄する (++ が効かなくなるため)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      write({
        version: 1,
        savedAt: new Date(T0).toISOString(),
        records: { vpws50: { state: "demoted", level: 5, generation: 1e308, signature: "s" }, vpww56: null },
        generations: { vpws50: 1e308, vpww56: 0 },
      });
      const loaded = new WeatherPromotionPersistence(file).load(T0);
      expect(loaded?.records.vpws50).toBeNull();
      expect(loaded?.generations.vpws50).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("load 時に自分の残留 tmp だけを掃除する (他人の .tmp は消さない)", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.7.tmp`, "{}", "utf8");
    writeFileSync(`${file}.9.tmp`, "{}", "utf8");
    // 同ディレクトリにある無関係な .tmp (他の永続化層のもの) は保護する
    writeFileSync(join(dir, "other.tmp"), "keep", "utf8");
    writeFileSync(join(dir, "display-active-state-v1.json.tmp"), "keep", "utf8");
    writeFileSync(join(dir, "unrelated.txt"), "keep", "utf8");

    new WeatherPromotionPersistence(file).load(T0);

    expect(existsSync(`${file}.7.tmp`)).toBe(false);
    expect(existsSync(`${file}.9.tmp`)).toBe(false);
    expect(existsSync(join(dir, "other.tmp"))).toBe(true);
    expect(existsSync(join(dir, "display-active-state-v1.json.tmp"))).toBe(true);
    expect(existsSync(join(dir, "unrelated.txt"))).toBe(true);
  });

  // ヘルツ指摘 2: 同期保存と進行中の非同期保存が同じ固定 .tmp を奪い合い、
  // 古い非同期書き込みが最後に rename して最終状態を上書きしうる
  // 追い越された書き込みが rename しないことを、実時間に頼らず検査する。
  // __test_writePending() で予約分の書き込みを任意のタイミングで走らせる
  it("追い越された書き込みは rename しない (後勝ちにならない)", async () => {
    const p = new WeatherPromotionPersistence(file, 10_000);
    // seq 1: 予約だけ (まだ書かれていない)
    p.schedule({ records: { vpws50: activeRecord({ generation: 1 }), vpww56: null }, generations: { vpws50: 1, vpww56: 0 } }, T0);
    // seq 2: shutdown 相当の同期保存が先にディスクへ到達する
    p.save({ records: { vpws50: null, vpww56: null }, generations: { vpws50: 9, vpww56: 0 } }, T0 + MIN);
    expect(JSON.parse(readFileSync(file, "utf8")).generations.vpws50).toBe(9);

    // 予約分 (古い seq 1) を今実行しても、新しい内容を上書きしない
    await p.__test_writePending();
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.records.vpws50).toBeNull();
    expect(raw.generations.vpws50).toBe(9);
    // 追い越された分の tmp も残さない
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("追い越された書き込みの後も renamedSeq が逆行しない (次の保存が正しく反映される)", async () => {
    const p = new WeatherPromotionPersistence(file, 10_000);
    p.schedule({ records: { vpws50: activeRecord({ generation: 1 }), vpww56: null }, generations: { vpws50: 1, vpww56: 0 } }, T0);
    p.save({ records: { vpws50: null, vpww56: null }, generations: { vpws50: 9, vpww56: 0 } }, T0 + MIN);
    await p.__test_writePending();
    // 逆行していれば、この後の保存が「古い」と誤判定されて反映されない
    p.save({ records: { vpws50: null, vpww56: null }, generations: { vpws50: 11, vpww56: 0 } }, T0 + 2 * MIN);
    expect(JSON.parse(readFileSync(file, "utf8")).generations.vpws50).toBe(11);
  });

  it("予約が新しい場合は通常どおり書かれる", async () => {
    const p = new WeatherPromotionPersistence(file, 10_000);
    p.save({ records: { vpws50: null, vpww56: null }, generations: { vpws50: 1, vpww56: 0 } }, T0);
    p.schedule({ records: { vpws50: activeRecord({ generation: 5 }), vpww56: null }, generations: { vpws50: 5, vpww56: 0 } }, T0 + MIN);
    await p.__test_writePending();
    expect(JSON.parse(readFileSync(file, "utf8")).generations.vpws50).toBe(5);
  });

  it("固定名の .tmp を残さない (書き込みごとに一意な tmp を使う)", async () => {
    const p = new WeatherPromotionPersistence(file, 10_000);
    p.schedule({ records: { vpws50: activeRecord(), vpww56: null }, generations: { vpws50: 1, vpww56: 0 } }, T0);
    await p.__test_writePending();
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("dispose は予約を捨てるだけでディスクに触らない", () => {
    const p = new WeatherPromotionPersistence(file, 10_000);
    p.schedule({ records: { vpws50: activeRecord(), vpww56: null }, generations: { vpws50: 3, vpww56: 0 } }, T0);
    p.dispose();
    p.flush();
    expect(existsSync(file)).toBe(false);
  });
});

// ── display on 時の経過判定 (ヘルツ指摘 1) ──

describe("WeatherPromotionStore.resume (display on 時の経過判定)", () => {
  const L5 = alertsOf("vpws50", "officialL5", ["東京都"]);

  it("display off 中に 30 分を超えていたら on の時点で demoted になる (初回 sweep を待たない)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", L5, T0);
    expect(store.resume(T0 + DEMOTE_MS + 1)).toBe(true);
    expect(store.get("vpws50")?.state).toBe("demoted");
  });

  it("30 分未経過なら active のまま・時計も generation も動かさない", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", L5, T0);
    expect(store.resume(T0 + 10 * MIN)).toBe(false);
    const rec = store.get("vpws50");
    expect(rec?.state).toBe("active");
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(T0);
    expect(rec?.generation).toBe(1);
  });

  it("record が無ければ何もしない (view から昇格させる経路は存在しない)", () => {
    const store = new WeatherPromotionStore();
    expect(store.resume(T0)).toBe(false);
    expect(store.get("vpws50")).toBeNull();
  });

  it("経過判定による降格は durable 通知を出す", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", L5, T0);
    let count = 0;
    store.onDurable(() => { count += 1; });
    store.resume(T0 + DEMOTE_MS + 1);
    expect(count).toBe(1);
  });
});

// ── durable 通知 ──

describe("WeatherPromotionStore の durable 通知", () => {
  it("昇格・降格・解除で通知が飛ぶ (変化なしでは飛ばない)", () => {
    const store = new WeatherPromotionStore();
    let count = 0;
    store.onDurable(() => { count += 1; });

    store.apply("vpws50", alertsOf("vpws50", "officialL5", ["東京都"]), T0);
    expect(count).toBe(1);

    store.sweepDemote(T0 + DEMOTE_MS + 5_000);
    expect(count).toBe(2);

    store.apply("vpws50", [], T0 + DEMOTE_MS + 6_000); // 解除
    expect(count).toBe(3);

    store.apply("vpws50", [], T0 + DEMOTE_MS + 7_000); // 既に無い → 変化なし
    expect(count).toBe(3);

    store.sweepDemote(T0 + DEMOTE_MS + 8_000); // active が無い → 変化なし
    expect(count).toBe(3);
  });
});

// ── display off/on をまたぐ lifecycle ──

describe("monitor 所有ストアの共有", () => {
  it("DisplayStateStore を作り直しても昇格の時計が途切れない", () => {
    const promotions = new WeatherPromotionStore();
    const first = new DisplayStateStore(undefined, promotions);
    first.applyWeatherSource("vpws50", alertsOf("vpws50", "officialL5", ["東京都"]), T0);
    expect(first.snapshot(1, T0).weatherPromotion?.vpws50?.promotedAt).toBe(new Date(T0).toISOString());

    // display off → on 相当。store は作り直されるが promotion は monitor 所有のまま
    const second = new DisplayStateStore(undefined, promotions);
    const snap = second.snapshot(1, T0 + 10 * MIN);
    expect(snap.weatherPromotion?.vpws50?.promotedAt).toBe(new Date(T0).toISOString());
    expect(snap.weatherPromotion?.vpws50?.generation).toBe(1);

    // 経過ぶんはそのまま進み、30 分で降格する
    expect(second.sweep(T0 + DEMOTE_MS + 5_000)).toBe(true);
    expect(second.snapshot(2, T0 + DEMOTE_MS + 5_000).weatherPromotion?.vpws50).toBeNull();
  });

  it("注入しない DisplayStateStore は自前のストアを持つ (旧テスト互換)", () => {
    const a = new DisplayStateStore();
    const b = new DisplayStateStore();
    a.applyWeatherSource("vpws50", alertsOf("vpws50", "officialL5", ["東京都"]), T0);
    expect(a.snapshot(1, T0).weatherPromotion?.vpws50).not.toBeNull();
    expect(b.snapshot(1, T0).weatherPromotion?.vpws50).toBeNull();
  });
});
