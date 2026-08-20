import { describe, expect, it, vi } from "vitest";
import { createEpochCoordinator } from "../epoch-coordinator";

describe("EpochCoordinator", () => {
  it("does not settle until its FIFO probe queue is drained", () => {
    const coordinator = createEpochCoordinator();
    const settled = vi.fn();
    const measured = vi.fn();
    coordinator.onSettled(settled);
    coordinator.begin("epoch-a");
    coordinator.enqueueProbe("quake:0", measured);
    expect(coordinator.isBusy()).toBe(true);
    coordinator.settle();
    expect(settled).not.toHaveBeenCalled();
    coordinator.drainProbes();
    expect(measured).toHaveBeenCalledOnce();
    coordinator.settle();
    expect(coordinator.isBusy()).toBe(false);
    expect(settled).toHaveBeenCalledOnce();
    expect(coordinator.epochKey()).toBe("epoch-a");
  });

  it("replaces duplicate probe ids and supports unsubscribe/dispose", () => {
    const coordinator = createEpochCoordinator();
    const first = vi.fn();
    const second = vi.fn();
    const listener = vi.fn();
    const unsubscribe = coordinator.onSettled(listener);
    coordinator.enqueueProbe("weather:0", first);
    coordinator.enqueueProbe("weather:0", second);
    coordinator.drainProbes();
    coordinator.settle();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    unsubscribe();
    coordinator.dispose();
    coordinator.enqueueProbe("late", first);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("promotes a queued epoch before notifying that the superseded epoch settled", () => {
    const coordinator = createEpochCoordinator();
    const settledKeys: string[] = [];
    const staleProbe = vi.fn();
    coordinator.onSettled(() => settledKeys.push(coordinator.epochKey()));
    coordinator.begin("epoch-old");
    coordinator.enqueueProbe("old-probe", staleProbe);

    coordinator.begin("epoch-new");
    coordinator.drainProbes();
    expect(staleProbe).not.toHaveBeenCalled();
    expect(coordinator.settle()).toBe(false);
    expect(coordinator.epochKey()).toBe("epoch-new");
    expect(settledKeys).toEqual([]);
    expect(coordinator.isBusy()).toBe(true);

    expect(coordinator.settle()).toBe(true);
    expect(settledKeys).toEqual(["epoch-new"]);
  });
});
