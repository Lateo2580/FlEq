import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STANDBY_CARD_REGISTRY,
  compareRevision,
  expiryFromReport,
  revisionOf,
  sortStandbyItems,
  tombstoneTtlForKey,
} from "../../../src/engine/display/standby-registry";
import type { ActiveStandbyCardV1 } from "../../../src/engine/display/protocol";

const T0 = Date.parse("2026-07-21T12:00:00+09:00");

function card(kind: ActiveStandbyCardV1["kind"], updatedAt = new Date(T0).toISOString()): ActiveStandbyCardV1 {
  return { kind, key: kind, updatedAt } as ActiveStandbyCardV1;
}

describe("standby-registry", () => {
  it("全 kind の policy が定義されている", () => {
    expect(Object.keys(STANDBY_CARD_REGISTRY).sort()).toEqual(
      ["flood", "heat", "longPeriod", "nankaiTrough", "tornado", "typhoon", "volcano"].sort(),
    );
  });

  it("spec 附属 A は7種別の lifecycle と実装関数・回帰テストを対応付ける", () => {
    const spec = readFileSync(join(
      process.cwd(),
      "docs/superpowers/specs/2026-07-21-standby-cards-expansion-design.md",
    ), "utf8");
    const appendix = spec.slice(spec.indexOf("## 附属 A: lifecycle 表"), spec.indexOf("## 9. 受け入れ条件"));

    expect(appendix).toContain("識別キー");
    expect(appendix).toContain("revision / 重複時 TTL");
    expect(appendix).toContain("tombstone");
    expect(appendix).toContain("取消");
    expect(appendix).toContain("訂正");
    expect(appendix).toContain("失効");
    expect(appendix).toContain("永続化");
    expect(appendix).toContain("実装関数");
    expect(appendix).toContain("回帰テスト");
    for (const kind of ["heat", "typhoon", "volcano", "flood", "tornado", "longPeriod", "nankaiTrough"]) {
      expect(appendix).toContain(`| ${kind} |`);
    }
  });

  it("優先順位は竜巻 > 洪水 > 火山 > 台風 > 熱中症", () => {
    const r = STANDBY_CARD_REGISTRY;
    expect(r.tornado.priority).toBeGreaterThan(r.flood.priority);
    expect(r.flood.priority).toBeGreaterThan(r.volcano.priority);
    expect(r.volcano.priority).toBeGreaterThan(r.typhoon.priority);
    expect(r.typhoon.priority).toBeGreaterThan(r.heat.priority);
  });

  it("compareRevision は報時刻を優先し、同時刻は serial で比較する", () => {
    expect(compareRevision({ reportTimeMs: T0 + 1, serial: "1" }, { reportTimeMs: T0, serial: "9" })).toBeGreaterThan(0);
    expect(compareRevision({ reportTimeMs: T0, serial: "2" }, { reportTimeMs: T0, serial: "10" })).toBeLessThan(0);
    expect(compareRevision({ reportTimeMs: T0, serial: "b" }, { reportTimeMs: T0, serial: "a" })).toBeGreaterThan(0);
    expect(compareRevision({ reportTimeMs: T0, serial: null }, { reportTimeMs: T0, serial: null })).toBe(0);
  });

  it("revisionOf は壊れた時刻と15分超の未来時刻を nowMs へフォールバックする", () => {
    expect(revisionOf("invalid", "1", T0).reportTimeMs).toBe(T0);
    expect(revisionOf(new Date(T0 + 16 * 60_000).toISOString(), "1", T0).reportTimeMs).toBe(T0);
    expect(revisionOf(new Date(T0 - 60_000).toISOString(), "1", T0).reportTimeMs).toBe(T0 - 60_000);
  });

  it("expiryFromReport は報時刻 + TTL を返す", () => {
    expect(expiryFromReport(T0, T0 + 5_000, 60_000)).toBe(T0 + 60_000);
  });

  it("tombstone は fallback TTL + 24h 以上を保ち、南海14日・火山alert 30日を使う", () => {
    const day = 24 * 60 * 60_000;
    expect(STANDBY_CARD_REGISTRY.flood.tombstoneTtlMs).toBeGreaterThanOrEqual(
      STANDBY_CARD_REGISTRY.flood.fallbackTtlMs! + day,
    );
    expect(STANDBY_CARD_REGISTRY.longPeriod.tombstoneTtlMs).toBeGreaterThanOrEqual(
      STANDBY_CARD_REGISTRY.longPeriod.fallbackTtlMs! + day,
    );
    expect(tombstoneTtlForKey("nankai:current")).toBe(14 * day);
    expect(tombstoneTtlForKey("volcano:alert:V-1")).toBe(30 * day);
  });

  it("sortStandbyItems は priority 降順、同 priority は updatedAt 降順", () => {
    expect(sortStandbyItems([card("heat"), card("flood")]).map((item) => item.kind)).toEqual(["flood", "heat"]);
    expect(
      sortStandbyItems([card("longPeriod", new Date(T0).toISOString()), card("nankaiTrough", new Date(T0 + 1).toISOString())])
        .map((item) => item.kind),
    ).toEqual(["nankaiTrough", "longPeriod"]);
  });
});
