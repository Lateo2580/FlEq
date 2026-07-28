import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEATHER_PROMOTION_DEMOTE_MIN,
  WEATHER_PROMOTION_MAX_RESTORE_AGE_MS,
  WEATHER_PROMOTION_CLOCK_SKEW_TOLERANCE_MS,
} from "../../../src/engine/display/constants";
import type { Vpws50CurrentAreasForDisplay } from "../../../src/types";
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

const SNAPSHOT_ITEM = {
  kind: "L5 大雨特別警報",
  displaySeverity: "officialL5",
  rank: "emergency" as const,
  shownAreas: ["東京都"],
  omittedAreaCount: 0,
};

/** 装飾 (spec 追補 C4) の既定。テストが個別に上書きできるよう素の値で持つ */
const SNAPSHOT_MEMBER = {
  level: 5 as const,
  severity: "officialL5",
  kindCode: "33",        // 大雨特別警報 (実データのコード)
  phenomenonKey: "大雨",  // kindCodeToPhenomenonKey("33")
  areaCode: "東京都",
  kind: "L5 大雨特別警報",
  areaName: "東京都",
};

function activeRecord(
  over: Partial<Extract<WeatherPromotionRecord, { state: "active" }>> = {},
): Extract<WeatherPromotionRecord, { state: "active" }> {
  return {
    state: "active" as const,
    level: 5 as const,
    promotedAtMs: T0,
    generation: 3,
    signature: "sig-a",
    items: [SNAPSHOT_ITEM],
    members: [SNAPSHOT_MEMBER],
    trigger: "new" as const,
    addedAreas: [],
    activationSeq: 1,
    ...over,
  };
}

/** (severity, areas) から holder view を組む (旧 alertsOf と同じ引数形。apply の入力を模す)。
 *  kindCode は severity をまたいで同じ現象になるよう固定する — spec 追補 C2 の
 *  「レベル変化を地域追加と数えない」判定はこのキーで行う */
function rawView(severity: string, areas: string[]): Vpws50CurrentAreasForDisplay | undefined {
  if (areas.length === 0) return undefined;
  return {
    totalAreas: areas.length,
    specialAreas: 0,
    warningAreas: 0,
    advisoryAreas: 0,
    kinds: [
      {
        kindCode: "03",
        kindShortName: `${severity} 大雨警報`,
        kindName: `${severity} 大雨警報`,
        displaySeverity: severity as Vpws50CurrentAreasForDisplay["kinds"][number]["displaySeverity"],
        officialAlertLevel: null,
        areas: areas.map((a) => ({ areaName: a, areaCode: a })),
      },
    ],
  };
}

/** 複数 kind を 1 つの holder view にまとめる (1 電文に複数種別が載る状況を模す) */
function mergeViews(
  ...views: Array<Vpws50CurrentAreasForDisplay | undefined>
): Vpws50CurrentAreasForDisplay {
  const kinds = views.flatMap((v) => v?.kinds ?? []);
  return {
    totalAreas: new Set(kinds.flatMap((k) => k.areas.map((a) => a.areaCode))).size,
    specialAreas: 0,
    warningAreas: 0,
    advisoryAreas: 0,
    kinds,
  };
}

// ── 復元判定 (WeatherPromotionStore.restore) ──

describe("WeatherPromotionStore.restore (残り時間だけ復元する)", () => {
  function restored(records: Partial<WeatherPromotionPersistedV1["records"]>, nowMs: number, generations = { vpws50: 0, vpww56: 0 }) {
    const store = new WeatherPromotionStore();
    store.restore({ records: { vpws50: null, vpww56: null, ...records }, generations }, nowMs);
    return store;
  }

  it("保持時間内の active は残り時間を引き継いで active のまま復元される", () => {
    const store = restored({ vpws50: activeRecord() }, T0 + DEMOTE_MS / 3);
    const rec = store.get("vpws50");
    expect(rec?.state).toBe("active");
    // promotedAtMs は据置 = 残り時間が減った状態。延命していない
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(T0);
    // 残り時間を過ぎたら通常どおり降格する
    expect(store.sweepDemote(T0 + DEMOTE_MS + 5_000)).toBe(true);
    expect(store.get("vpws50")?.state).toBe("demoted");
  });

  it("既に保持時間を過ぎた active は demoted で復元される (再起動による延命なし)", () => {
    const store = restored({ vpws50: activeRecord() }, T0 + DEMOTE_MS + 1);
    const rec = store.get("vpws50");
    expect(rec?.state).toBe("demoted");
    expect(rec?.level).toBe(5);
    expect(rec?.generation).toBe(3);
  });

  it("永続化された無客期間を経過判定前に除外し、復元後も無客状態を継続する", () => {
    const store = new WeatherPromotionStore();
    const restoredAt = T0 + 10 * MIN;
    store.restore({
      records: { vpws50: activeRecord(), vpww56: null },
      generations: { vpws50: 3, vpww56: 0 },
      unseenSinceMs: T0 + MIN,
    }, restoredAt);

    const record = store.get("vpws50");
    expect(record?.state).toBe("active");
    expect(record?.state === "active" ? record.promotedAtMs : null).toBe(T0 + 9 * MIN);
    expect(store.export().unseenSinceMs).toBe(restoredAt);

    store.endUnseenPeriod(2 * MIN, T0 + 12 * MIN);
    expect(store.get("vpws50")?.state).toBe("active");
    expect(store.sweepDemote(T0 + 12 * MIN + DEMOTE_MS - MIN + 1)).toBe(true);
  });

  it("永続化された無客開始時刻が復元時刻より未来なら負の区間を 0 に clamp する", () => {
    const store = new WeatherPromotionStore();
    const restoredAt = T0 + 30_000;
    store.restore({
      records: { vpws50: activeRecord(), vpww56: null },
      generations: { vpws50: 3, vpww56: 0 },
      unseenSinceMs: T0 + MIN,
    }, restoredAt);

    const record = store.get("vpws50");
    expect(record?.state).toBe("active");
    expect(record?.state === "active" ? record.promotedAtMs : null).toBe(T0);
    expect(store.export().unseenSinceMs).toBe(restoredAt);
  });

  // ヘルツ指摘 4: 未来時刻では「保持時間が経ったか」も「まだ有効か」も判定できない。
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
      store.apply("vpws50", rawView("officialL4", ["千葉県"]), T0);
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
      { vpww56: { state: "demoted", level: 4, generation: 7, signature: "s", items: [SNAPSHOT_ITEM] , members: [], trigger: "update" as const, addedAreas: [], activationSeq: 0 } },
      T0,
    );
    const rec = store.get("vpww56");
    expect(rec).toEqual({ state: "demoted", level: 4, generation: 7, signature: "s", items: [SNAPSHOT_ITEM] , members: [], trigger: "update" as const, addedAreas: [], activationSeq: 0 });
  });

  it("watermark は保存値と record の generation の大きい方を採る", () => {
    // 保存 watermark(1) < record.generation(3) のとき、次の新規昇格は 4 になる
    const store = restored({ vpws50: activeRecord({ generation: 3 }) }, T0, { vpws50: 1, vpww56: 0 });
    store.apply("vpws50", rawView("officialL4", ["千葉県"]), T0 + MIN);
    expect(store.get("vpws50")?.generation).toBe(4);
  });

  it("復元後に同内容の続報が来たら generation は据置 (signature が保存されている)", () => {
    const view = rawView("officialL5", ["東京都"]);
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
      { records: { vpws50: { state: "demoted", level: 5, generation: 1, signature: "s", items: [SNAPSHOT_ITEM] , members: [], trigger: "update" as const, addedAreas: [], activationSeq: 0 }, vpww56: null }, generations: { vpws50: 1, vpww56: 0 } },
      T0,
    );
    const store = new DisplayStateStore(undefined, promotions);
    const snap = store.snapshot(1, T0);
    expect(snap.severityTier).toBe("critical");
    expect(snap.weatherL5Active).toBe(true);
    // demoted は wire 上 null
    expect(snap.weatherPromotion?.vpws50).toBeNull();
    expect(snap.weatherPromotion?.vpww56).toBeNull();
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
    expect(raw.version).toBe(2);
  });

  it("records が全 null の状態も書き込む (解除済みの昇格が再起動で復活しない)", () => {
    const p = new WeatherPromotionPersistence(file);
    p.save({ records: { vpws50: activeRecord(), vpww56: null }, generations: { vpws50: 3, vpww56: 0 } }, T0);
    p.save({ records: { vpws50: null, vpww56: null }, generations: { vpws50: 3, vpww56: 0 } }, T0 + MIN);
    const loaded = p.load(T0 + 2 * MIN);
    expect(loaded?.records.vpws50).toBeNull();
    expect(loaded?.unseenSinceMs).toBeNull(); // フィールド欠落の旧 envelope
    // watermark は残る
    expect(loaded?.generations.vpws50).toBe(3);
  });

  it("ファイルが無ければ null (起動を妨げない)", () => {
    expect(new WeatherPromotionPersistence(file).load(T0)).toBeNull();
  });

  // 「ファイルが無い (初回起動)」だけが null。**中身を使えなかった場合は null にしない** —
  // null は store にとって「記録なし = 本当の新規発表」を意味してしまう (spec 追補 C5)
  it("ファイルが無いときだけ null (初回起動と復元失敗を区別する)", () => {
    expect(new WeatherPromotionPersistence(file).load(T0)).toBeNull();
  });

  it("壊れた JSON は起動を妨げず、材料なしの印を返す", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      write("{ not json");
      const loaded = new WeatherPromotionPersistence(file).load(T0);
      expect(loaded?.records).toEqual({ vpws50: null, vpww56: null });
      expect(loaded?.uncertainSources).toEqual({ vpws50: null, vpww56: null });
    } finally {
      warn.mockRestore();
    }
  });

  it("version 不一致は材料なしの印を返す", () => {
    write({ version: 99, savedAt: new Date(T0).toISOString(), records: {}, generations: {} });
    const loaded = new WeatherPromotionPersistence(file).load(T0);
    expect(loaded?.records).toEqual({ vpws50: null, vpww56: null });
    expect(loaded?.uncertainSources).toEqual({ vpws50: null, vpww56: null });
  });

  it("savedAt 欠落は材料なしの印を返す", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      write({ version: 2, records: {}, generations: {} });
      const loaded = new WeatherPromotionPersistence(file).load(T0);
      expect(loaded?.uncertainSources).toEqual({ vpws50: null, vpww56: null });
    } finally {
      warn.mockRestore();
    }
  });

  it("保存から 24 時間以上経てば record は捨てるが、signature は tombstone に残す", () => {
    const p = new WeatherPromotionPersistence(file);
    const record = activeRecord();
    p.save({ records: { vpws50: record, vpww56: null }, generations: { vpws50: 3, vpww56: 0 } }, T0);
    expect(p.load(T0 + WEATHER_PROMOTION_MAX_RESTORE_AGE_MS - MIN)?.records.vpws50).not.toBeNull();

    const aged = p.load(T0 + WEATHER_PROMOTION_MAX_RESTORE_AGE_MS + MIN);
    expect(aged?.records.vpws50).toBeNull();          // lifecycle は捨てる
    expect(aged?.generations.vpws50).toBe(3);         // watermark は時刻と無関係なので残す
    expect(aged?.uncertainSources?.vpws50).toBe(record.signature); // 内容は比較できる
  });

  it("source 片方が壊れていても、もう片方は生きる", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      write({
        version: 2,
        savedAt: new Date(T0).toISOString(),
        records: {
          vpws50: { state: "active", level: 99, generation: 1, signature: "s", promotedAtMs: T0, items: [SNAPSHOT_ITEM] , members: [], trigger: "update" as const, addedAreas: [], activationSeq: 0 }, // level 不正
          vpww56: { state: "demoted", level: 4, generation: 2, signature: "s", items: [SNAPSHOT_ITEM] , members: [], trigger: "update" as const, addedAreas: [], activationSeq: 0 },
        },
        generations: { vpws50: 5, vpww56: 2 },
      });
      const loaded = new WeatherPromotionPersistence(file).load(T0);
      expect(loaded?.records.vpws50).toBeNull();
      // 装飾 (members) を持たない保存データなので、trigger は null に落ちる
      // (捏造しない = バッジを出さない、Codex レビュー 2026-07-27)
      expect(loaded?.records.vpww56).toEqual({ state: "demoted", level: 4, generation: 2, signature: "s", items: [SNAPSHOT_ITEM] , members: [], trigger: null, addedAreas: [], activationSeq: 0 });
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
        version: 2,
        savedAt: new Date(T0).toISOString(),
        records: { vpws50: { state: "active", level: 5, generation: 1, promotedAtMs: T0, items: [SNAPSHOT_ITEM] , members: [], trigger: "update" as const, addedAreas: [], activationSeq: 0 }, vpww56: null },
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
        version: 2,
        savedAt: new Date(T0).toISOString(),
        records: { vpws50: { state: "active", level: 5, generation: 1, signature: "s", promotedAtMs: 1e20, items: [SNAPSHOT_ITEM] , members: [], trigger: "update" as const, addedAreas: [], activationSeq: 0 }, vpww56: null },
        generations: { vpws50: 1, vpww56: 0 },
      });
      const loaded = new WeatherPromotionPersistence(file).load(T0);
      expect(loaded?.records.vpws50).toBeNull();
      // 万一 sanitize を抜けても restore で落ちないこと
      const store = new WeatherPromotionStore();
      expect(() => store.restore(
        { records: { vpws50: { state: "active", level: 5, generation: 1, signature: "s", promotedAtMs: 1e20, items: [SNAPSHOT_ITEM] , members: [], trigger: "update" as const, addedAreas: [], activationSeq: 0 }, vpww56: null }, generations: { vpws50: 1, vpww56: 0 } },
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
      p.save({ records: { vpws50: { state: "demoted", level: 5, generation: 4, signature: "s", items: [SNAPSHOT_ITEM] , members: [], trigger: "update" as const, addedAreas: [], activationSeq: 0 }, vpww56: null }, generations: { vpws50: 4, vpww56: 0 } }, T0);
      // 現在時刻が保存時刻より前 = savedAt が未来
      const loaded = p.load(T0 - 60 * MIN);
      expect(loaded).not.toBeNull();
      expect(loaded?.records.vpws50).toBeNull();
      expect(loaded?.generations.vpws50).toBe(4);

      // 復元後の次の昇格は generation 5 から (1 に戻らない)
      const store = new WeatherPromotionStore();
      store.restore(loaded!, T0);
      store.apply("vpws50", rawView("officialL5", ["東京都"]), T0);
      expect(store.get("vpws50")?.generation).toBe(5);
    } finally {
      warn.mockRestore();
    }
  });

  it("generation が safe integer でなければ破棄する (++ が効かなくなるため)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      write({
        version: 2,
        savedAt: new Date(T0).toISOString(),
        records: { vpws50: { state: "demoted", level: 5, generation: 1e308, signature: "s", items: [SNAPSHOT_ITEM] , members: [], trigger: "update" as const, addedAreas: [], activationSeq: 0 }, vpww56: null },
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

// ── display on 時の測り直し (spec 追補 C6 = 案 B) ──

describe("WeatherPromotionStore.resume (display on 時の測り直し)", () => {
  const L5 = rawView("officialL5", ["東京都"]);

  // spec 追補 C6 (ご主人決定 2026-07-27 = 案 B): display off 中は sweep が止まっているので、
  // display on の時点で active が残っている = その点灯は誰にも見られていない。
  // ここで経過判定を通して捨てると「更新が誰にも見られないまま終わる」ままで、C6 が
  // 塞ごうとしている穴そのものになる。経過時間にかかわらず display on から測り直す
  it("display off が保持時間を超えても、on の時点から測り直す (見られていない点灯を捨てない)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", L5, T0);
    const onAt = T0 + 60 * MIN; // 保持時間 (3 分) をはるかに超えた display off
    expect(store.resume(onAt)).toBe(true);
    const rec = store.get("vpws50");
    expect(rec?.state).toBe("active");
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(onAt);
    // 測り直した先から改めて 3 分もつ
    expect(store.sweepDemote(onAt + DEMOTE_MS - 1)).toBe(false);
    expect(store.sweepDemote(onAt + DEMOTE_MS + 1)).toBe(true);
    expect(store.get("vpws50")?.state).toBe("demoted");
  });

  // 「再起動で延命しない」は restore() の責務。resume に経過判定を持ち込まない代わりに、
  // 起動経路では restore が先に走って経過済みの active を demoted へ落とす
  it("再起動経路では restore が先に落とすので resume で復活しない", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const source = new WeatherPromotionStore();
      source.apply("vpws50", L5, T0);
      const persisted = JSON.parse(JSON.stringify(source.export())) as WeatherPromotionPersistedV1;

      const store = new WeatherPromotionStore();
      const bootAt = T0 + 60 * MIN;
      store.restore(persisted, bootAt);
      expect(store.get("vpws50")?.state).toBe("demoted");
      // 起動 seed の resume は demoted に触らない
      expect(store.resume(bootAt)).toBe(false);
      expect(store.get("vpws50")?.state).toBe("demoted");
    } finally {
      warn.mockRestore();
    }
  });

  // generation は動かさない — 内容は変わっていないので「更新」ではない
  it("保持時間内でも時計は display on 時点へ測り直す (generation は不変)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", L5, T0);
    const onAt = T0 + 1 * MIN; // 保持時間 (3 分) 内に display on
    expect(store.resume(onAt)).toBe(true);
    const rec = store.get("vpws50");
    expect(rec?.state).toBe("active");
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(onAt);
    expect(rec?.generation).toBe(1);
  });

  it("demoted は測り直さない (降格は既に見られた点灯の結末)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", L5, T0);
    store.sweepDemote(T0 + DEMOTE_MS + 1);
    expect(store.resume(T0 + 10 * MIN)).toBe(false);
    expect(store.get("vpws50")?.state).toBe("demoted");
  });

  it("record が無ければ何もしない (view から昇格させる経路は存在しない)", () => {
    const store = new WeatherPromotionStore();
    expect(store.resume(T0)).toBe(false);
    expect(store.get("vpws50")).toBeNull();
  });

  // 旧実装の resume は reviveRecord を共有していたため、display off 中に時計が巻き戻ると
  // record ごと破棄され、しかも tombstone が残らず次の受理が「新規発表」になっていた。
  // resume から経過判定を外したので**破棄経路そのものが無くなる** (Codex 4 巡目 指摘 2)
  it("時計が巻き戻っていても record を捨てない (未来時刻の破棄経路が resume から消えた)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", L5, T0);
    // display off 中に NTP 同期で時計が 1 時間戻った = record の promotedAtMs が未来
    const onAt = T0 - 60 * MIN;
    expect(store.resume(onAt)).toBe(true);
    const rec = store.get("vpws50");
    expect(rec?.state).toBe("active");
    expect(rec?.state === "active" ? rec.promotedAtMs : null).toBe(onAt);
    // 破棄されていないので「新規発表」と偽る余地がない (同内容の再掲では点灯しない)
    expect(store.apply("vpws50", L5, onAt + MIN)).toBe(false);
    expect(store.get("vpws50")?.trigger).toBe("new"); // 最初の点灯の trigger がそのまま生きる
  });

  it("測り直しは durable 通知を出す (変化が無ければ出さない)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", L5, T0);
    let count = 0;
    store.onDurable(() => { count += 1; });
    store.resume(T0 + MIN);
    expect(count).toBe(1);
    // 同じ時刻での再呼び出しは変化なし
    store.resume(T0 + MIN);
    expect(count).toBe(1);
  });
});

// ── durable 通知 ──

describe("WeatherPromotionStore の durable 通知", () => {
  it("昇格・降格・解除で通知が飛ぶ (変化なしでは飛ばない)", () => {
    const store = new WeatherPromotionStore();
    let count = 0;
    store.onDurable(() => { count += 1; });

    store.apply("vpws50", rawView("officialL5", ["東京都"]), T0);
    expect(count).toBe(1);

    store.sweepDemote(T0 + DEMOTE_MS + 5_000);
    expect(count).toBe(2);

    store.apply("vpws50", undefined, T0 + DEMOTE_MS + 6_000); // 解除
    expect(count).toBe(3);

    store.apply("vpws50", undefined, T0 + DEMOTE_MS + 7_000); // 既に無い → 変化なし
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
    first.applyWeatherSource("vpws50", rawView("officialL5", ["東京都"]), T0);
    expect(first.snapshot(1, T0).weatherPromotion?.vpws50?.promotedAt).toBe(new Date(T0).toISOString());

    // display off → on 相当。store は作り直されるが promotion は monitor 所有のまま
    const second = new DisplayStateStore(undefined, promotions);
    const snap = second.snapshot(1, T0 + 10 * MIN);
    expect(snap.weatherPromotion?.vpws50?.promotedAt).toBe(new Date(T0).toISOString());
    expect(snap.weatherPromotion?.vpws50?.generation).toBe(1);

    // 経過ぶんはそのまま進み、保持時間で降格する
    expect(second.sweep(T0 + DEMOTE_MS + 5_000)).toBe(true);
    expect(second.snapshot(2, T0 + DEMOTE_MS + 5_000).weatherPromotion?.vpws50).toBeNull();
  });

  it("注入しない DisplayStateStore は自前のストアを持つ (旧テスト互換)", () => {
    const a = new DisplayStateStore();
    const b = new DisplayStateStore();
    a.applyWeatherSource("vpws50", rawView("officialL5", ["東京都"]), T0);
    expect(a.snapshot(1, T0).weatherPromotion?.vpws50).not.toBeNull();
    expect(b.snapshot(1, T0).weatherPromotion?.vpws50).toBeNull();
  });
});

// ── 昇格時 view スナップショット (Phase 2 の穴を塞ぐ) ──

describe("昇格時の view スナップショット", () => {
  const L5 = rawView("officialL5", ["東京都"]);
  const L3 = rawView("officialL3", ["東京都"]);

  it("昇格の根拠になった item が record に載る (L3 以下は載せない)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", mergeViews(rawView("officialL5", ["東京都"]), rawView("officialL3", ["千葉県"])), T0);
    const items = store.get("vpws50")?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.displaySeverity).toBe("officialL5");
  });

  it("再起動後: weatherAlerts が空でも snapshot に控えが載る", () => {
    const promotions = new WeatherPromotionStore();
    promotions.apply("vpws50", L5, T0);
    const persisted = JSON.parse(JSON.stringify(promotions.export()));

    const restoredStore = new WeatherPromotionStore();
    restoredStore.restore(persisted, T0 + MIN);
    const store = new DisplayStateStore(undefined, restoredStore);
    // 起動直後は holder が空なので weatherAlerts は seed されない
    const entry = store.snapshot(1, T0 + MIN).weatherPromotion?.vpws50;
    expect(entry?.level).toBe(5);
    expect(entry?.restoredItems).toHaveLength(1);
    expect(entry?.restoredItems?.[0]?.displaySeverity).toBe("officialL5");
  });

  it("実データ (weatherAlerts) が来たら控えは載らない", () => {
    const promotions = new WeatherPromotionStore();
    promotions.apply("vpws50", L5, T0);
    const store = new DisplayStateStore(undefined, promotions);
    store.seedWeatherAlerts(alertsOf("vpws50", "officialL5", ["東京都"]));
    const entry = store.snapshot(1, T0).weatherPromotion?.vpws50;
    expect(entry?.level).toBe(5);
    expect(entry?.restoredItems).toBeUndefined();
  });

  it("他 source の weatherAlerts があっても、当該 source が無ければ控えを載せる", () => {
    const promotions = new WeatherPromotionStore();
    promotions.apply("vpws50", L5, T0);
    const store = new DisplayStateStore(undefined, promotions);
    store.seedWeatherAlerts(alertsOf("vpww56", "officialL5", ["島根県"]));
    expect(store.snapshot(1, T0).weatherPromotion?.vpws50?.restoredItems).toHaveLength(1);
  });

  it("スナップショットからは昇格が発生しない (控えは昇格の根拠にならない)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", L5, T0);
    // 解除を受理すれば、控えを持っていた record ごと消える
    store.apply("vpws50", L3, T0 + MIN);
    expect(store.get("vpws50")).toBeNull();
    // resume は控えを見て昇格を作り直したりしない
    expect(store.resume(T0 + 2 * MIN)).toBe(false);
    expect(store.get("vpws50")).toBeNull();
  });

  it("confirmed update のたびに控えが最新へ入れ替わる", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", L5, T0);
    store.apply("vpws50", rawView("officialL5", ["東京都", "千葉県"]), T0 + MIN);
    expect(store.get("vpws50")?.items[0]?.shownAreas).toEqual(["東京都", "千葉県"]);
  });

  it("降格しても控えは保たれる (record と一緒に生きる)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", L5, T0);
    store.sweepDemote(T0 + DEMOTE_MS + 5_000);
    expect(store.get("vpws50")?.items).toHaveLength(1);
  });

  it("WeatherAlertCard 用の weatherAlerts は控えで汚染されない", () => {
    const promotions = new WeatherPromotionStore();
    promotions.apply("vpws50", L5, T0);
    const store = new DisplayStateStore(undefined, promotions);
    // 復元しただけの状態では気象カードは空のまま (従来動作)
    expect(store.snapshot(1, T0).weatherAlerts).toEqual([]);
  });
});

// ── record 破棄条件では控えも必ず消える (生死を共にする) ──

describe("record を破棄する全条件で控えも消える", () => {
  let dir2: string;
  let file2: string;
  beforeEach(() => {
    dir2 = mkdtempSync(join(tmpdir(), "fleq-promotion-colife-"));
    file2 = join(dir2, "weather-promotion-v1.json");
  });
  afterEach(() => rmSync(dir2, { recursive: true, force: true }));

  function writeFile2(content: unknown): void {
    writeFileSync(file2, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  }

  function saved(records: unknown, savedAtMs = T0): void {
    writeFile2({ version: 2, savedAt: new Date(savedAtMs).toISOString(), records, generations: { vpws50: 3, vpww56: 0 } });
  }

  /** 復元後に控えが残っていないことを snapshot 経由で確認する */
  function restoredEntry(nowMs: number) {
    const loaded = new WeatherPromotionPersistence(file2).load(nowMs);
    const promotions = new WeatherPromotionStore();
    if (loaded != null) promotions.restore(loaded, nowMs);
    const store = new DisplayStateStore(undefined, promotions);
    return { entry: store.snapshot(1, nowMs).weatherPromotion?.vpws50, record: promotions.get("vpws50") };
  }

  it("24 時間足切り", () => {
    saved({ vpws50: activeRecord(), vpww56: null });
    const r = restoredEntry(T0 + WEATHER_PROMOTION_MAX_RESTORE_AGE_MS + MIN);
    expect(r.record).toBeNull();
    expect(r.entry).toBeNull();
  });

  it("savedAt が未来", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      saved({ vpws50: activeRecord(), vpww56: null });
      const r = restoredEntry(T0 - 60 * MIN);
      expect(r.record).toBeNull();
      expect(r.entry).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("promotedAtMs が未来", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      saved({ vpws50: activeRecord({ promotedAtMs: T0 + 60 * MIN }), vpww56: null });
      const r = restoredEntry(T0);
      expect(r.record).toBeNull();
      expect(r.entry).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("version 不一致", () => {
    writeFile2({ version: 1, savedAt: new Date(T0).toISOString(), records: { vpws50: activeRecord(), vpww56: null }, generations: { vpws50: 3, vpww56: 0 } });
    const r = restoredEntry(T0);
    expect(r.record).toBeNull();
    expect(r.entry).toBeNull();
  });

  it("破損 (JSON として壊れている)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      writeFile2("{ broken");
      const r = restoredEntry(T0);
      expect(r.record).toBeNull();
      expect(r.entry).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("items が壊れている record は record ごと捨てる", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      saved({ vpws50: { ...activeRecord(), items: [{ kind: 1 }] }, vpww56: null });
      const r = restoredEntry(T0);
      expect(r.record).toBeNull();
      expect(r.entry).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("items が空の record は record ごと捨てる (中身の無い昇格を復元しない)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      saved({ vpws50: { ...activeRecord(), items: [] }, vpww56: null });
      const r = restoredEntry(T0);
      expect(r.record).toBeNull();
      expect(r.entry).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

// ── 装飾を持たない旧データからの復元 (Codex レビュー 2026-07-27) ──

describe("装飾なしデータの復元", () => {
  /** 追補の装飾 (members/trigger/addedAreas) を持たない、変更前 v2 形式の record */
  const legacyRecord = {
    state: "active" as const,
    level: 5 as const,
    promotedAtMs: T0,
    generation: 3,
    signature: "sig-legacy",
    items: [SNAPSHOT_ITEM],
  };

  function restoreLegacy(nowMs: number): WeatherPromotionStore {
    const store = new WeatherPromotionStore();
    store.restore(
      {
        records: { vpws50: legacyRecord as unknown as WeatherPromotionRecord, vpww56: null },
        generations: { vpws50: 3, vpww56: 0 },
      },
      nowMs,
    );
    return store;
  }

  it("record は生かすが、バッジは出さない (trigger を捏造しない)", () => {
    const rec = restoreLegacy(T0 + MIN).get("vpws50");
    expect(rec?.state).toBe("active"); // 昇格自体は生きる
    expect(rec?.trigger).toBeNull();   // 判定材料が無いので無表示
  });

  it("次の受理が内容変化なら update として点灯する (嘘の「新規発表」を出さない)", () => {
    const store = restoreLegacy(T0 + MIN);
    store.apply("vpws50", rawView("officialL5", ["東京都", "千葉県"]), T0 + 2 * MIN);
    expect(store.get("vpws50")?.trigger).toBe("update");
  });

  it("装飾が無い状態から追加地域を全件ハイライトしない (members が空なので差分を作らない)", () => {
    const store = restoreLegacy(T0 + MIN);
    store.apply("vpws50", rawView("officialL5", ["東京都", "千葉県"]), T0 + 2 * MIN);
    // members を持たない復元だったので、追加地域は求められない = 空
    expect(store.get("vpws50")?.addedAreas).toEqual([]);
  });

  // spec 追補 C5: 材料が無いときは「新規」とも「更新」とも断言しない。嘘のバッジより無表示
  it("record ごと捨てられた source は、新規発表にもせずバッジも出さない", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const store = new WeatherPromotionStore();
      // promotedAtMs が未来 = record 破棄経路
      store.restore(
        { records: { vpws50: activeRecord(), vpww56: null }, generations: { vpws50: 3, vpww56: 0 } },
        T0 - 60 * MIN,
      );
      expect(store.get("vpws50")).toBeNull();
      store.apply("vpws50", rawView("officialL5", ["東京都"]), T0);
      const rec = store.get("vpws50");
      expect(rec?.state).toBe("active");   // 画面には出す
      expect(rec?.trigger).toBeNull();     // が、「新規」とは偽らない
      expect(rec?.addedAreas).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  // tombstone があるなら「同内容の再掲」を再起動をまたいで判定できる (C5)
  it("tombstone と同内容の再掲では点灯しない", () => {
    const store = new WeatherPromotionStore();
    const first = new WeatherPromotionStore();
    first.apply("vpws50", rawView("officialL5", ["東京都"]), T0);
    const signature = first.get("vpws50")?.signature;
    expect(signature).toBeTruthy();

    store.restore(
      {
        records: { vpws50: null, vpww56: null },
        generations: { vpws50: 3, vpww56: 0 },
        uncertainSources: { vpws50: signature },
      },
      T0,
    );
    // 同内容 → 点灯しない
    expect(store.apply("vpws50", rawView("officialL5", ["東京都"]), T0 + MIN)).toBe(false);
    expect(store.get("vpws50")?.state).toBe("demoted");
    expect(store.get("vpws50")?.trigger).toBeNull();
    // その後の内容変化は update として点灯する
    expect(store.apply("vpws50", rawView("officialL5", ["東京都", "千葉県"]), T0 + 2 * MIN)).toBe(true);
    expect(store.get("vpws50")?.trigger).toBe("update");
  });
});

describe("装飾なし復元の印の寿命", () => {
  it("解除を挟んだら、その後の昇格は新規発表になる (印が残らない)", () => {
    const store = new WeatherPromotionStore();
    // 装飾を持たない旧データから復元
    store.restore(
      {
        records: {
          vpws50: {
            state: "active", level: 5, promotedAtMs: T0, generation: 3,
            signature: "sig-legacy", items: [SNAPSHOT_ITEM],
          } as unknown as WeatherPromotionRecord,
          vpww56: null,
        },
        generations: { vpws50: 3, vpww56: 0 },
      },
      T0 + MIN,
    );
    // 解除 (L3 以下だけになる)
    store.apply("vpws50", rawView("officialL3", ["東京都"]), T0 + 2 * MIN);
    expect(store.get("vpws50")).toBeNull();
    // 後日の発表は「新規発表」— 復元時の印を引きずらない
    store.apply("vpws50", rawView("officialL5", ["東京都"]), T0 + 60 * MIN);
    expect(store.get("vpws50")?.trigger).toBe("new");
  });
});

// Codex 再レビュー 2026-07-27: 点灯キーはパネル全体の watermark で、record からは復元しない
describe("点灯 watermark の永続化", () => {
  it("解除で record が消えても watermark は残り、再起動後に巻き戻らない", () => {
    const source = new WeatherPromotionStore();
    source.apply("vpws50", rawView("officialL5", ["東京都"]), T0);
    source.apply("vpws50", rawView("officialL5", ["東京都", "千葉県"]), T0 + MIN);
    const beforeRelease = source.activationWatermark();
    source.apply("vpws50", rawView("officialL3", ["東京都"]), T0 + 2 * MIN); // 解除
    expect(source.get("vpws50")).toBeNull();

    // 全 record が null の状態で保存 → 復元
    const restoredStore = new WeatherPromotionStore();
    restoredStore.restore(source.export(), T0 + 3 * MIN);
    expect(restoredStore.activationWatermark()).toBe(beforeRelease);

    // 次の昇格は必ず前より大きい番号になる (過去のキーと衝突しない)
    restoredStore.apply("vpws50", rawView("officialL5", ["東京都"]), T0 + 4 * MIN);
    expect(restoredStore.get("vpws50")?.activationSeq).toBeGreaterThan(beforeRelease);
  });

  it("source の降格では watermark が動かない (再点灯しない)", () => {
    const store = new WeatherPromotionStore();
    store.apply("vpws50", rawView("officialL5", ["東京都"]), T0);
    const before = store.activationWatermark();
    store.sweepDemote(T0 + DEMOTE_MS + 1);
    expect(store.get("vpws50")?.state).toBe("demoted");
    expect(store.activationWatermark()).toBe(before);
  });
});

// Codex 再レビュー 2026-07-27: 永続化層が壊れた record を捨てた事実を store へ伝える
describe("破損 record の復元 (load 経路)", () => {
  it("壊れた record を捨てた source は、次の受理を新規発表にしない", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "fleq-wp-"));
    try {
      const file = join(dir, "weather-promotion-v1.json");
      // items が壊れた record (sanitizeRecord が undefined を返す経路)
      writeFileSync(file, JSON.stringify({
        version: 2,
        savedAt: new Date(T0).toISOString(),
        records: { vpws50: { state: "active", level: 5, promotedAtMs: T0, generation: 3, signature: "s", items: "壊れた" }, vpww56: null },
        generations: { vpws50: 3, vpww56: 0 },
      }), "utf8");

      const persistence = new WeatherPromotionPersistence(file);
      const loaded = persistence.load(T0 + MIN);
      // 壊れた record からは signature も信用できないので、値は null (= 比較材料なし)
      expect(loaded?.uncertainSources).toHaveProperty("vpws50", null);

      const store = new WeatherPromotionStore();
      store.restore(loaded!, T0 + MIN);
      expect(store.get("vpws50")).toBeNull();
      // 継続中の警報を受理 → 「新規発表」と偽らない (材料が無いのでバッジも出さない)
      store.apply("vpws50", rawView("officialL5", ["東京都"]), T0 + 2 * MIN);
      expect(store.get("vpws50")?.state).toBe("active");
      expect(store.get("vpws50")?.trigger).toBeNull();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Codex 4 巡目 2026-07-27 指摘 3: 印は追補の実装途中 `string[]` 形だった。schema version は 2 の
// ままなので、旧形式で書かれたファイルは version 検査を通過する。実ファイル経路で往復させる
// (export → restore の直結テストでは、そもそも旧形式を作れないので検出できない)
describe("旧形式 uncertainSources (配列) からの復元", () => {
  let dir3: string;
  let file3: string;
  beforeEach(() => {
    dir3 = mkdtempSync(join(tmpdir(), "fleq-wp-legacy-"));
    file3 = join(dir3, "weather-promotion-v1.json");
  });
  afterEach(() => rmSync(dir3, { recursive: true, force: true }));

  /** 旧形式のファイルを実際に書く (records は全 null = 印だけが残っている状態) */
  function writeLegacyUncertain(uncertainSources: unknown): void {
    writeFileSync(file3, JSON.stringify({
      version: 2,
      savedAt: new Date(T0).toISOString(),
      records: { vpws50: null, vpww56: null },
      generations: { vpws50: 3, vpww56: 0 },
      activationSeq: 5,
      uncertainSources,
    }), "utf8");
  }

  it("配列の印を読み捨てず、継続中の警報に「新規発表」バッジを出さない", () => {
    writeLegacyUncertain(["vpws50"]);
    const loaded = new WeatherPromotionPersistence(file3).load(T0 + MIN);
    // 配列には signature が無いので「比較材料なし」= null へ移行する
    expect(loaded?.uncertainSources).toHaveProperty("vpws50", null);

    const store = new WeatherPromotionStore();
    store.restore(loaded!, T0 + MIN);
    store.apply("vpws50", rawView("officialL5", ["東京都"]), T0 + 2 * MIN);
    const rec = store.get("vpws50");
    expect(rec?.state).toBe("active"); // 画面には出す
    expect(rec?.trigger).toBeNull();   // が、「新規」とは偽らない
    expect(rec?.addedAreas).toEqual([]);
  });

  it("配列に載っていない source は通常どおり新規発表になる", () => {
    writeLegacyUncertain(["vpws50"]);
    const store = new WeatherPromotionStore();
    store.restore(new WeatherPromotionPersistence(file3).load(T0 + MIN)!, T0 + MIN);
    store.apply("vpww56", rawView("officialL4", ["島根県"]), T0 + 2 * MIN);
    expect(store.get("vpww56")?.trigger).toBe("new");
  });

  it("配列に未知の値が混ざっていても無視する (source 名だけを採る)", () => {
    writeLegacyUncertain(["vpws50", "vpxx99", 7, null]);
    const loaded = new WeatherPromotionPersistence(file3).load(T0 + MIN);
    expect(loaded?.uncertainSources).toEqual({ vpws50: null });
  });

  it("新形式 (object) の印は signature を保ったままファイルを往復する", () => {
    const first = new WeatherPromotionStore();
    first.apply("vpws50", rawView("officialL5", ["東京都"]), T0);
    const signature = first.get("vpws50")?.signature;
    writeLegacyUncertain({ vpws50: signature });

    const store = new WeatherPromotionStore();
    store.restore(new WeatherPromotionPersistence(file3).load(T0 + MIN)!, T0 + MIN);
    // 同内容の再掲 → 点灯しない (再起動をまたいで判定できている)
    expect(store.apply("vpws50", rawView("officialL5", ["東京都"]), T0 + 2 * MIN)).toBe(false);
    expect(store.get("vpws50")?.state).toBe("demoted");
  });
});

// Codex 3 巡目 2026-07-27: export() が返しても envelope() が書かなければディスクに残らない。
// export → restore を直接繋ぐテストではこの断線を検出できなかった (実際に落ちていた)
describe("save → load の実ファイル経路 (watermark と印の往復)", () => {
  it("activationSeq・uncertainSources・unseenSinceMs がファイルを往復する", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleq-wp-"));
    try {
      const file = join(dir, "weather-promotion-v1.json");
      const source = new WeatherPromotionStore();
      source.apply("vpws50", rawView("officialL5", ["東京都"]), T0);
      source.apply("vpww56", rawView("officialL4", ["千葉県"]), T0);
      // vpws50 を解除 = 最後に点いた source の record が消える。
      // watermark を record から復元していると、ここで番号が巻き戻る
      source.apply("vpws50", rawView("none", []), T0 + MIN);
      source.beginUnseenPeriod(T0 + MIN);
      const seq = source.activationWatermark();
      expect(seq).toBeGreaterThan(0);

      new WeatherPromotionPersistence(file).save(source.export(), T0 + MIN);

      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      expect(raw).toHaveProperty("activationSeq", seq); // ← 実ファイルに載っていること
      expect(raw).toHaveProperty("unseenSinceMs", T0 + MIN);

      const restored = new WeatherPromotionStore();
      const loaded = new WeatherPromotionPersistence(file).load(T0 + 2 * MIN);
      restored.restore(loaded!, T0 + 2 * MIN);
      expect(restored.activationWatermark()).toBe(seq);
      expect(restored.export().unseenSinceMs).toBe(T0 + 2 * MIN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("全 record が null でも印がファイルに残る", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "fleq-wp-"));
    try {
      const file = join(dir, "weather-promotion-v1.json");
      // 壊れた record を load → restore して印を立て、その状態を保存し直す
      writeFileSync(file, JSON.stringify({
        version: 2,
        savedAt: new Date(T0).toISOString(),
        records: { vpws50: { state: "active", level: 5, promotedAtMs: T0, generation: 3, signature: "s", items: "壊れた" }, vpww56: null },
        generations: { vpws50: 3, vpww56: 0 },
      }), "utf8");
      const persistence = new WeatherPromotionPersistence(file);
      const store = new WeatherPromotionStore();
      store.restore(persistence.load(T0 + MIN)!, T0 + MIN);
      persistence.save(store.export(), T0 + MIN);

      const reloaded = new WeatherPromotionPersistence(file).load(T0 + 2 * MIN);
      expect(reloaded?.uncertainSources).toHaveProperty("vpws50", null);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Codex 再レビュー 2026-07-27: 部分的に壊れた member 集合を採用しない
describe("装飾の all-or-nothing 検証", () => {
  it("member が 1 つでも壊れていたら装飾ごと落とす (部分集合を前回分として採らない)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "fleq-wp-"));
    try {
      const file = join(dir, "p.json");
      writeFileSync(file, JSON.stringify({
        version: 2,
        savedAt: new Date(T0).toISOString(),
        records: {
          vpws50: {
            state: "active", level: 5, promotedAtMs: T0, generation: 1, signature: "s",
            items: [SNAPSHOT_ITEM],
            members: [SNAPSHOT_MEMBER, { level: 5, severity: "officialL5" }], // 2 件目が壊れている
            trigger: "update", addedAreas: [], activationSeq: 4,
          },
          vpww56: null,
        },
        generations: { vpws50: 1, vpww56: 0 },
      }), "utf8");
      const loaded = new WeatherPromotionPersistence(file).load(T0 + MIN);
      const rec = loaded?.records.vpws50;
      expect(rec?.state).toBe("active");      // record 自体は生きる
      expect(rec?.members).toEqual([]);        // 装飾は丸ごと落ちる
      expect(rec?.trigger).toBeNull();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("phenomenonKey は保存値ではなく kindCode から再生成する", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleq-wp-"));
    try {
      const file = join(dir, "p.json");
      writeFileSync(file, JSON.stringify({
        version: 2,
        savedAt: new Date(T0).toISOString(),
        records: {
          vpws50: {
            state: "active", level: 5, promotedAtMs: T0, generation: 1, signature: "s",
            items: [{ ...SNAPSHOT_ITEM, phenomenonKey: "大雨" }],
            // 保存値が壊れている (古いマップで書かれた等)
            members: [{ ...SNAPSHOT_MEMBER, kindCode: "33", phenomenonKey: "でたらめ" }],
            trigger: "new", addedAreas: [], activationSeq: 2,
          },
          vpww56: null,
        },
        generations: { vpws50: 1, vpww56: 0 },
      }), "utf8");
      const loaded = new WeatherPromotionPersistence(file).load(T0 + MIN);
      expect(loaded?.records.vpws50?.members[0].phenomenonKey).toBe("大雨"); // 33 → 大雨
      expect(loaded?.records.vpws50?.items[0].phenomenonKey).toBe("大雨");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
