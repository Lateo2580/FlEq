import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import { createEpochCoordinator } from "../epoch-coordinator";
import {
  TIME_SLICE_PERIOD_MS,
  createCardPageCoordinator,
  createRotationScheduler,
  type MonotonicClock,
} from "../time-slice-scheduler.svelte";

function controlledClock() {
  let current = 0;
  const clock: MonotonicClock = { now: () => current };
  return {
    clock,
    advance(ms: number): void {
      current += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

describe("time-slice scheduler contract", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("gives an epoch priority and consumes rather than skips its pending tick", () => {
    const time = controlledClock();
    const epoch = createEpochCoordinator();
    const rotation = createRotationScheduler({ epoch, clock: time.clock });
    rotation.sync({ stage: 3, keys: ["weather", "typhoon"] });

    epoch.begin("layout-2");
    time.advance(TIME_SLICE_PERIOD_MS);
    expect(rotation.activeKey).toBe("weather");
    expect(rotation.diagnostics()).toMatchObject({ tickPending: true });

    expect(epoch.settle()).toBe(true);
    expect(rotation.activeKey).toBe("typhoon");
    expect(rotation.processedTick).toBe(1);
    rotation.dispose();
    epoch.dispose();
  });

  it("continues rotation under reduced motion without creating an animation", () => {
    const time = controlledClock();
    const animate = vi.fn();
    const target = document.createElement("div");
    target.animate = animate;
    const rotation = createRotationScheduler({ clock: time.clock, reducedMotion: () => true });
    rotation.setTransitionTarget(target);
    rotation.sync({ stage: 3, keys: ["weather", "typhoon"] });

    time.advance(TIME_SLICE_PERIOD_MS);
    expect(rotation.activeKey).toBe("typhoon");
    expect(animate).not.toHaveBeenCalled();
    rotation.dispose();
  });

  it("keeps finished and deadline completion exclusive and never clears the active key", async () => {
    const time = controlledClock();
    const cancel = vi.fn();
    const animation = { playState: "running", cancel, onfinish: null, oncancel: null } as unknown as Animation;
    const target = document.createElement("div");
    target.animate = vi.fn(() => animation);
    const rotation = createRotationScheduler({ clock: time.clock, reducedMotion: () => false });
    rotation.setTransitionTarget(target);
    rotation.sync({ stage: 3, keys: ["weather", "typhoon"] });

    time.advance(TIME_SLICE_PERIOD_MS);
    await tick();
    expect(rotation.activeKey).toBe("typhoon");
    expect(target.animate).toHaveBeenCalledOnce();
    animation.onfinish?.(new Event("finish") as AnimationPlaybackEvent);
    time.advance(500);
    expect(cancel).not.toHaveBeenCalled();
    expect(rotation.activeKey).toBe("typhoon");
    rotation.dispose();
  });

  it("releases rotation timer and animation on a real stage-3 exit and unmount", async () => {
    const time = controlledClock();
    const cancel = vi.fn();
    const animation = { playState: "running", cancel, onfinish: null, oncancel: null } as unknown as Animation;
    const target = document.createElement("div");
    target.animate = vi.fn(() => animation);
    const rotation = createRotationScheduler({ clock: time.clock, reducedMotion: () => false });
    rotation.setTransitionTarget(target);
    rotation.sync({ stage: 3, keys: ["weather", "typhoon"] });
    time.advance(TIME_SLICE_PERIOD_MS);
    await tick();

    rotation.sync({ stage: 2, keys: [] });
    expect(rotation.activeKey).toBeNull();
    expect(rotation.diagnostics()).toMatchObject({ timerActive: false, inFlight: false });
    expect(cancel).toHaveBeenCalledOnce();
    rotation.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("rotation instance", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rotates a stable canonical collection every 15 seconds", () => {
    const time = controlledClock();
    const rotation = createRotationScheduler({ clock: time.clock });
    rotation.sync({ stage: 3, keys: ["weather", "typhoon", "heat"] });
    expect(rotation.activeKey).toBe("weather");
    expect(rotation.diagnostics()).toMatchObject({
      stage: 3,
      phaseKey: "weather",
      seenKeys: ["weather"],
      phaseStartedAtMs: 0,
    });
    time.advance(15_000);
    expect(rotation.activeKey).toBe("typhoon");
    time.advance(15_000);
    expect(rotation.activeKey).toBe("heat");
    time.advance(15_000);
    expect(rotation.activeKey).toBe("weather");
    rotation.dispose();
  });

  it("keeps the active key and phase when a card is added", () => {
    const time = controlledClock();
    const rotation = createRotationScheduler({ clock: time.clock });
    rotation.sync({ stage: 3, keys: ["weather", "heat"] });
    time.advance(5_000);
    rotation.sync({ stage: 3, keys: ["weather", "typhoon", "heat"] });
    expect(rotation.activeKey).toBe("weather");
    time.advance(10_000);
    expect(rotation.activeKey).toBe("typhoon");
    rotation.dispose();
  });

  it("keeps phase when a non-active card is removed", () => {
    const time = controlledClock();
    const rotation = createRotationScheduler({ clock: time.clock });
    rotation.sync({ stage: 3, keys: ["weather", "typhoon", "heat"] });
    time.advance(5_000);
    rotation.sync({ stage: 3, keys: ["weather", "heat"] });
    time.advance(10_000);
    expect(rotation.activeKey).toBe("heat");
    rotation.dispose();
  });

  it("switches immediately to the old canonical successor when active is removed", () => {
    const time = controlledClock();
    const rotation = createRotationScheduler({ clock: time.clock });
    rotation.sync({ stage: 3, keys: ["weather", "typhoon", "heat"] });
    time.advance(15_000);
    expect(rotation.activeKey).toBe("typhoon");
    rotation.sync({ stage: 3, keys: ["weather", "heat"] });
    expect(rotation.activeKey).toBe("heat");
    time.advance(15_000);
    expect(rotation.activeKey).toBe("weather");
    rotation.dispose();
  });

  it("catches up a long suspension in one callback while preserving every appearance", () => {
    const time = controlledClock();
    const appearances: string[] = [];
    const rotation = createRotationScheduler({ clock: time.clock, onAppearance: (key) => appearances.push(key) });
    rotation.sync({ stage: 3, keys: ["weather", "heat"] });
    time.advance(15_000 * 5);
    expect(rotation.activeKey).toBe("heat");
    expect(rotation.processedTick).toBe(5);
    // First visits do not advance a logical page; revisits do.
    expect(appearances).toEqual(["weather", "heat", "weather", "heat"]);
    rotation.dispose();
  });

  it("counts a one-card slot boundary as a reappearance", () => {
    const time = controlledClock();
    const appearance = vi.fn();
    const rotation = createRotationScheduler({ clock: time.clock, onAppearance: appearance });
    rotation.sync({ stage: 3, keys: ["weather"] });
    time.advance(15_000);
    expect(rotation.activeKey).toBe("weather");
    expect(appearance).toHaveBeenCalledWith("weather");
    rotation.dispose();
  });

  it("uses a deterministic tick override without allocating a timer", () => {
    const rotation = createRotationScheduler({ tickOverride: 4 });
    rotation.sync({ stage: 3, keys: ["weather", "typhoon", "heat"] });
    expect(rotation.activeKey).toBe("typhoon");
    expect(rotation.diagnostics()).toMatchObject({ timerActive: false });
    rotation.dispose();
  });
});

describe("shared card-page coordinator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("advances every real-time card, and destroys the shared timer only after the last exit", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    pages.register({ key: "quake", identities: ["q1", "q2"] });
    pages.register({ key: "weather", identities: ["w1", "w2", "w3"] });
    expect(vi.getTimerCount()).toBe(1);
    time.advance(15_000);
    expect(pages.activeIndex("quake")).toBe(1);
    expect(pages.activeIndex("weather")).toBe(1);

    pages.unregister("quake");
    expect(vi.getTimerCount()).toBe(1);
    time.advance(15_000);
    expect(pages.activeIndex("weather")).toBe(2);
    pages.unregister("weather");
    expect(vi.getTimerCount()).toBe(0);
    pages.dispose();
  });

  it("defers a page tick behind the active epoch and consumes it on settle", () => {
    const time = controlledClock();
    const epoch = createEpochCoordinator();
    const pages = createCardPageCoordinator({ epoch, clock: time.clock });
    pages.register({ key: "quake", identities: ["q1", "q2"] });
    epoch.begin("layout-next");
    time.advance(15_000);
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q1");
    expect(pages.diagnostics()).toMatchObject({ tickPending: true });
    expect(epoch.settle()).toBe(true);
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q2");
    pages.dispose();
    epoch.dispose();
  });

  it("catches up a long real-time pause in one callback", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    pages.register({ key: "quake", identities: ["q1", "q2", "q3"] });
    time.advance(15_000 * 8);
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q3");
    expect(pages.diagnostics()).toMatchObject({ processedTick: 8 });
    pages.dispose();
  });

  it("resets on one-page exit but preserves identity across stage-neutral repartition", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    pages.register({ key: "quake", identities: ["q1", "q2", "q3"] });
    time.advance(15_000);
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q2");
    pages.register({ key: "quake", identities: ["q0", "q1", "q2", "q3"] });
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q2");

    pages.register({ key: "quake", identities: ["q2"] });
    expect(pages.cardDiagnostics("quake").page).toBe("1/1");
    pages.register({ key: "quake", identities: ["q1", "q2"] });
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q1");
    pages.dispose();
  });

  it("keeps newly added pages deferred until the old cycle returns to its origin", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    pages.register({ key: "quake", identities: ["q1", "q2"] });
    time.advance(15_000);
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q2");
    pages.register({ key: "quake", identities: ["q1", "q2", "q3"] });
    time.advance(15_000);
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q1");
    time.advance(15_000);
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q2");
    time.advance(15_000);
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q3");
    pages.dispose();
  });

  it("continues defer release after its cycle-origin page is removed", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    pages.register({ key: "quake", identities: ["q1", "q2", "q3"] });
    time.advance(15_000);
    pages.register({ key: "quake", identities: ["q1", "q2", "q3", "q4"] });
    pages.register({ key: "quake", identities: ["q1", "q3", "q4"] });
    const visited = new Set<string>();
    for (let step = 0; step < 6; step += 1) {
      visited.add(pages.cardDiagnostics("quake").activeKey ?? "");
      time.advance(15_000);
    }
    expect(visited).toContain("q4");
    pages.dispose();
  });

  it("uses compound identities to preserve duplicate labels without jumping", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    pages.register({ key: "weather", identities: ["rain|same|0", "wind|same|0"], labels: ["same", "same"] });
    time.advance(15_000);
    expect(pages.cardDiagnostics("weather")).toMatchObject({ activeKey: "wind|same|0", keys: ["same", "same"] });
    pages.register({ key: "weather", identities: ["rain|same|0", "wind|same|0", "snow|same|0"], labels: ["same", "same", "same"] });
    expect(pages.cardDiagnostics("weather").activeKey).toBe("wind|same|0");
    pages.dispose();
  });

  it("suspends a logical card and advances it only on rotation reappearance", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    pages.register({ key: "quake", identities: ["q1", "q2", "q3"], rotationMember: true });
    time.advance(45_000);
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q1");
    pages.recordRotationAppearance("quake");
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q2");
    pages.recordRotationAppearance("quake");
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q3");
    pages.dispose();
  });

  it("starts a fresh real-time phase after logical mode without retrospective ticks", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    pages.register({ key: "quake", identities: ["q1", "q2"], rotationMember: true });
    time.advance(60_000);
    pages.recordRotationAppearance("quake");
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q2");

    pages.register({ key: "quake", identities: ["q1", "q2"], rotationMember: false });
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q2");
    time.advance(14_999);
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q2");
    time.advance(1);
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q1");
    pages.dispose();
  });

  it("returns a composite page within 15 x R x P and applies every catch-up appearance", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    const rotation = createRotationScheduler({ clock: time.clock, onAppearance: (key) => pages.recordRotationAppearance(key) });
    pages.register({ key: "weather", identities: ["w1", "w2", "w3"], rotationMember: true });
    rotation.sync({ stage: 3, keys: ["weather", "heat"] });
    const initial = pages.cardDiagnostics("weather").activeKey;
    time.advance(15_000 * 2 * 3);
    expect(rotation.activeKey).toBe("weather");
    expect(pages.cardDiagnostics("weather").activeKey).toBe(initial);
    rotation.dispose();
    pages.dispose();
  });

  it("uses the page tick override and never starts its internal timer", () => {
    const pages = createCardPageCoordinator({ tickOverride: 5 });
    pages.register({ key: "quake", identities: ["q1", "q2", "q3"] });
    expect(pages.activeIndex("quake")).toBe(2);
    expect(pages.diagnostics()).toMatchObject({ timerActive: false });
    pages.dispose();
  });

  it("keeps an atomic active page through a non-animated tick and exposes its deferred state", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    pages.register({ key: "quake", identities: ["q1", "q2", "q3"] });
    pages.register({ key: "quake", identities: ["q1", "q2", "q3", "q4"] });
    const before = pages.cardDiagnostics("quake").activeKey;
    time.advance(TIME_SLICE_PERIOD_MS);
    const diagnostics = pages.diagnostics() as { cards: { quake: { activeKey: string; pendingKeys: string[]; cycleOriginKey: string | null } } };
    expect(before).toBe("q1");
    expect(diagnostics.cards.quake.activeKey).toBe("q2");
    expect(diagnostics.cards.quake.pendingKeys).toEqual(["q4"]);
    expect(diagnostics.cards.quake.cycleOriginKey).toBe("q1");
    pages.dispose();
  });

  it("does not starve a retained page during updates shorter than one period", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    pages.register({ key: "quake", identities: ["q1", "q2", "q3"] });
    const seen: string[] = [];
    for (let update = 0; update < 6; update += 1) {
      time.advance(5_000);
      pages.register({ key: "quake", identities: ["q1", "q2", "q3", `n${update}`] });
      seen.push(pages.cardDiagnostics("quake").activeKey ?? "");
    }
    time.advance(TIME_SLICE_PERIOD_MS * 3);
    seen.push(pages.cardDiagnostics("quake").activeKey ?? "");
    expect(seen).toContain("q2");
    expect(seen).toContain("q3");
    pages.dispose();
  });

  it("visits every composed weather page within the 15 × R × P bound", () => {
    const time = controlledClock();
    const appearances: Array<{ key: string; at: number }> = [];
    const pages = createCardPageCoordinator({ clock: time.clock });
    const rotation = createRotationScheduler({
      clock: time.clock,
      onAppearance: (key) => {
        appearances.push({ key, at: time.clock.now() });
        pages.recordRotationAppearance(key);
      },
    });
    pages.register({ key: "weather", identities: ["w1", "w2", "w3"], rotationMember: true });
    rotation.sync({ stage: 3, keys: ["weather", "heat"] });
    const visited = new Map<string, number>();
    visited.set(pages.cardDiagnostics("weather").activeKey ?? "", 0);
    for (let tickIndex = 1; tickIndex <= 6; tickIndex += 1) {
      time.advance(TIME_SLICE_PERIOD_MS);
      visited.set(pages.cardDiagnostics("weather").activeKey ?? "", tickIndex * TIME_SLICE_PERIOD_MS);
    }
    expect([...visited.keys()]).toEqual(expect.arrayContaining(["w1", "w2", "w3"]));
    expect(Math.max(...visited.values())).toBeLessThanOrEqual(TIME_SLICE_PERIOD_MS * 2 * 3);
    expect(appearances.filter((entry) => entry.key === "weather")).toHaveLength(3);
    rotation.dispose();
    pages.dispose();
  });

  it("disposes the remaining shared timer on coordinator unmount", () => {
    const pages = createCardPageCoordinator();
    pages.register({ key: "quake", identities: ["q1", "q2"] });
    expect(vi.getTimerCount()).toBe(1);
    pages.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
