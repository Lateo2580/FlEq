import { describe, it, expect } from "vitest";
import {
  TYPHOON_PROBABILITY_MAX_EVENTS,
  TyphoonProbabilityStateHolder,
} from "../../../src/engine/messages/typhoon-probability-state";

describe("TyphoonProbabilityStateHolder", () => {
  it("初回発表は isUnchangedZero=false", () => {
    const h = new TyphoonProbabilityStateHolder();
    const d = h.diffAndUpdate("TC2606", 0, "2026-06-02T15:55:00+09:00");
    expect(d.isUnchangedZero).toBe(false);
    expect(d.shouldRecap).toBe(false);
  });

  it("2回目も maxDaily5=0 なら isUnchangedZero=true", () => {
    const h = new TyphoonProbabilityStateHolder();
    h.diffAndUpdate("TC2606", 0, "t1");
    const d = h.diffAndUpdate("TC2606", 0, "t2");
    expect(d.isUnchangedZero).toBe(true);
  });

  it("1→0 への遷移は isUnchangedZero=false", () => {
    const h = new TyphoonProbabilityStateHolder();
    h.diffAndUpdate("TC2606", 50, "t1");
    const d = h.diffAndUpdate("TC2606", 0, "t2");
    expect(d.isUnchangedZero).toBe(false);
  });

  it("0→1 への遷移は isUnchangedZero=false", () => {
    const h = new TyphoonProbabilityStateHolder();
    h.diffAndUpdate("TC2606", 0, "t1");
    const d = h.diffAndUpdate("TC2606", 50, "t2");
    expect(d.isUnchangedZero).toBe(false);
  });

  it("異なる eventId は独立して扱う", () => {
    const h = new TyphoonProbabilityStateHolder();
    h.diffAndUpdate("TC2001", 0, "t1");
    const d = h.diffAndUpdate("TC2606", 0, "t2"); // 新EventID初回
    expect(d.isUnchangedZero).toBe(false);
  });

  it("rollback 後は初回扱い", () => {
    const h = new TyphoonProbabilityStateHolder();
    h.diffAndUpdate("TC2606", 0, "t1");
    h.rollback("TC2606");
    const d = h.diffAndUpdate("TC2606", 0, "t2");
    expect(d.isUnchangedZero).toBe(false);
  });

  it("空 eventId('') は履歴に乗せない（複数発表が混ざらない）", () => {
    const h = new TyphoonProbabilityStateHolder();
    h.diffAndUpdate("", 0, "t1");
    const d = h.diffAndUpdate("", 0, "t2");
    expect(d.isUnchangedZero).toBe(false);
  });

  it("keeps the most recently updated EventID when enforcing the shared subject bound", () => {
    const h = new TyphoonProbabilityStateHolder();
    for (let index = 0; index < TYPHOON_PROBABILITY_MAX_EVENTS; index++) {
      h.diffAndUpdate(`event-${index}`, 0, `t${index}`);
    }
    expect(h.diffAndUpdate("event-0", 0, "latest").isUnchangedZero).toBe(true);
    h.diffAndUpdate(`event-${TYPHOON_PROBABILITY_MAX_EVENTS}`, 0, "new");
    expect(h.diffAndUpdate("event-0", 0, "still-retained").isUnchangedZero).toBe(true);
    expect(h.diffAndUpdate("event-1", 0, "evicted").isUnchangedZero).toBe(false);
  });
});
