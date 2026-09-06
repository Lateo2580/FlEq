import { describe, expect, it } from "vitest";
import { ReplayClock, ReplayScheduler } from "../../../src/engine/replay/replay-clock";

describe("Phase 1 replay clock and scheduler", () => {
  it("deadline・登録 ordinal 順に due callback だけを同期 drain する", () => {
    const clock = new ReplayClock(1_000);
    const scheduler = new ReplayScheduler(clock);
    const calls: string[] = [];
    scheduler.set(20, () => calls.push("late"));
    scheduler.set(10, () => calls.push("first"));
    scheduler.set(10, () => calls.push("second"));

    clock.advanceTo(1_010);
    expect(calls).toEqual(["first", "second"]);
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.drainDue();
    expect(calls).toEqual(["first", "second"]);
    clock.advanceTo(1_020);
    expect(calls).toEqual(["first", "second", "late"]);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("business time regression を拒否し、clear 済み callback を実行しない", () => {
    const clock = new ReplayClock(100);
    const scheduler = new ReplayScheduler(clock);
    const calls: number[] = [];
    const handle = scheduler.set(1, () => calls.push(1));
    scheduler.clear(handle);
    expect(() => clock.advanceTo(99)).toThrow(/regression/);
    clock.advanceTo(101);
    expect(calls).toEqual([]);
  });
});
