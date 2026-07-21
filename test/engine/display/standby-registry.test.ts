import { describe, expect, it } from "vitest";
import {
  STANDBY_CARD_REGISTRY,
  compareRevision,
  expiryFromReport,
  revisionOf,
  sortStandbyItems,
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

  it("sortStandbyItems は priority 降順、同 priority は updatedAt 降順", () => {
    expect(sortStandbyItems([card("heat"), card("flood")]).map((item) => item.kind)).toEqual(["flood", "heat"]);
    expect(
      sortStandbyItems([card("longPeriod", new Date(T0).toISOString()), card("nankaiTrough", new Date(T0 + 1).toISOString())])
        .map((item) => item.kind),
    ).toEqual(["nankaiTrough", "longPeriod"]);
  });
});
