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

  it("exposes a commit guard without notifying until the owner settles after flush", () => {
    const coordinator = createEpochCoordinator();
    const listener = vi.fn();
    coordinator.onSettled(listener);
    coordinator.begin("layout-final");

    expect(coordinator.canSettle("other")).toBe(false);
    expect(coordinator.canSettle("layout-final")).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    expect(coordinator.settle()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("rejects a stale final commit when a newer epoch is queued", () => {
    const coordinator = createEpochCoordinator();
    coordinator.begin("old");
    coordinator.begin("new");

    expect(coordinator.canSettle("old")).toBe(false);
    expect(coordinator.settle()).toBe(false);
    expect(coordinator.epochKey()).toBe("new");
    expect(coordinator.canSettle("new")).toBe(true);
  });

  it("keeps a same-epoch late probe busy until its bounded owner loop drains it", () => {
    const coordinator = createEpochCoordinator();
    const lateMeasure = vi.fn();
    coordinator.begin("same");
    expect(coordinator.canSettle("same")).toBe(true);

    // Models a page partition probe registered synchronously by final DOM
    // commit. This is not an epoch supersede.
    coordinator.enqueueProbe("page:late", lateMeasure);
    expect(coordinator.settle()).toBe(false);
    expect(coordinator.epochKey()).toBe("same");
    expect(coordinator.isBusy()).toBe(true);

    coordinator.drainProbes();
    expect(lateMeasure).toHaveBeenCalledOnce();
    expect(coordinator.settle()).toBe(true);
    expect(coordinator.isBusy()).toBe(false);
  });

  it("discards a terminal pending probe so the coordinator can settle", () => {
    const coordinator = createEpochCoordinator();
    const dropped = vi.fn();
    coordinator.begin("terminal");
    coordinator.enqueueProbe("late", dropped);
    coordinator.discardPendingProbes();

    expect(coordinator.settle()).toBe(true);
    expect(coordinator.isBusy()).toBe(false);
    expect(dropped).not.toHaveBeenCalled();
  });
});
