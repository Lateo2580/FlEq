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

  it("keeps settle notifications held until layout motion explicitly releases one pending tick", () => {
    const time = controlledClock();
    const epoch = createEpochCoordinator();
    const rotation = createRotationScheduler({ epoch, clock: time.clock });
    rotation.sync({ stage: 3, keys: ["weather", "typhoon"] });

    epoch.begin("layout-held");
    rotation.holdForEpoch();
    time.advance(TIME_SLICE_PERIOD_MS);
    expect(epoch.settle()).toBe(true);
    expect(rotation.activeKey).toBe("weather");
    expect(rotation.diagnostics()).toMatchObject({ epochHeld: true, tickPending: true, timerActive: false });

    rotation.releaseAfterLayoutMotion();
    expect(rotation.activeKey).toBe("typhoon");
    expect(rotation.diagnostics()).toMatchObject({ epochHeld: false, tickPending: false, processedTick: 1 });
    rotation.releaseAfterLayoutMotion();
    expect(rotation.processedTick).toBe(1);
    rotation.dispose();
    epoch.dispose();
  });

  it("cancels an in-flight transition on epoch hold without clearing the active key", async () => {
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
    const active = rotation.activeKey;

    rotation.holdForEpoch();
    expect(cancel).toHaveBeenCalledOnce();
    expect(rotation.activeKey).toBe(active);
    expect(rotation.diagnostics()).toMatchObject({ epochHeld: true, inFlight: false, timerActive: false });
    rotation.dispose();
  });

  it("holds shared page ticks through settle and re-evaluates them once on release", () => {
    const time = controlledClock();
    const epoch = createEpochCoordinator();
    const pages = createCardPageCoordinator({ epoch, clock: time.clock });
    pages.register({ key: "quake", identities: ["q1", "q2"] });

    epoch.begin("page-layout");
    pages.holdForEpoch();
    time.advance(TIME_SLICE_PERIOD_MS);
    expect(epoch.settle()).toBe(true);
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q1");
    expect(pages.diagnostics()).toMatchObject({ epochHeld: true, tickPending: true, timerActive: false });

    pages.releaseAfterLayoutMotion();
    expect(pages.cardDiagnostics("quake").activeKey).toBe("q2");
    expect(pages.diagnostics()).toMatchObject({ epochHeld: false, tickPending: false, processedTick: 1 });
    pages.releaseAfterLayoutMotion();
    expect(pages.processedTick).toBe(1);
    pages.dispose();
    epoch.dispose();
  });

  it("defers one logical appearance while held without resetting page state", () => {
    const pages = createCardPageCoordinator();
    pages.register({ key: "weather", identities: ["w1", "w2"], rotationMember: true });
    pages.holdForEpoch();
    pages.recordRotationAppearance("weather");
    pages.recordRotationAppearance("weather");
    expect(pages.cardDiagnostics("weather").activeKey).toBe("w1");
    expect(pages.diagnostics()).toMatchObject({ pendingAppearanceKeys: ["weather"] });

    pages.releaseAfterLayoutMotion();
    expect(pages.cardDiagnostics("weather").activeKey).toBe("w2");
    pages.dispose();
  });

  it("holds a flood reappearance and advances it exactly once after release", () => {
    const pages = createCardPageCoordinator();
    pages.register({ key: "flood", identities: ["f1", "f2", "f3"], rotationMember: true });
    pages.holdForEpoch();
    pages.recordRotationAppearance("flood");
    pages.recordRotationAppearance("flood");
    expect(pages.cardDiagnostics("flood").activeKey).toBe("f1");
    pages.releaseAfterLayoutMotion();
    expect(pages.cardDiagnostics("flood").activeKey).toBe("f2");
    pages.releaseAfterLayoutMotion();
    expect(pages.cardDiagnostics("flood").activeKey).toBe("f2");
    pages.dispose();
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

  it("registers, jumps, indexes, and unregisters river-flood pages", () => {
    const pages = createCardPageCoordinator();
    pages.register({
      key: "flood",
      identities: ["flood-1", "flood-2", "flood-3"],
      labels: ["河川洪水: 多摩川", "河川洪水: 利根川", "河川洪水: 淀川"],
    });
    expect(pages.activeIndex("flood")).toBe(0);
    pages.jumpTo("flood", 2);
    expect(pages.activeIndex("flood")).toBe(2);
    expect(pages.cardDiagnostics("flood")).toMatchObject({
      activeKey: "flood-3",
      keys: ["河川洪水: 多摩川", "河川洪水: 利根川", "河川洪水: 淀川"],
    });
    pages.unregister("flood");
    expect(pages.activeIndex("flood")).toBe(0);
    expect(pages.cardDiagnostics("flood")).toMatchObject({ page: "0/0", keys: [], activeKey: null });
    pages.dispose();
  });

  it("advances quake, weather, and river-flood cards together in real mode", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    pages.register({ key: "quake", identities: ["q1", "q2"] });
    pages.register({ key: "weather", identities: ["w1", "w2", "w3"] });
    pages.register({ key: "flood", identities: ["f1", "f2"] });
    const visited = {
      quake: new Set([pages.cardDiagnostics("quake").activeKey]),
      weather: new Set([pages.cardDiagnostics("weather").activeKey]),
      flood: new Set([pages.cardDiagnostics("flood").activeKey]),
    };
    for (let tickIndex = 0; tickIndex < 6; tickIndex += 1) {
      time.advance(TIME_SLICE_PERIOD_MS);
      visited.quake.add(pages.cardDiagnostics("quake").activeKey);
      visited.weather.add(pages.cardDiagnostics("weather").activeKey);
      visited.flood.add(pages.cardDiagnostics("flood").activeKey);
    }
    expect(visited.quake).toEqual(new Set(["q1", "q2"]));
    expect(visited.weather).toEqual(new Set(["w1", "w2", "w3"]));
    expect(visited.flood).toEqual(new Set(["f1", "f2"]));
    pages.dispose();
  });

  it("advances a logical river-flood card only on rotation reappearance", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    pages.register({ key: "flood", identities: ["f1", "f2", "f3"], rotationMember: true });
    time.advance(TIME_SLICE_PERIOD_MS * 3);
    expect(pages.cardDiagnostics("flood").activeKey).toBe("f1");
    pages.recordRotationAppearance("flood");
    expect(pages.cardDiagnostics("flood").activeKey).toBe("f2");
    pages.recordRotationAppearance("flood");
    expect(pages.cardDiagnostics("flood").activeKey).toBe("f3");
    pages.dispose();
  });

  it("includes river-flood state in coordinator diagnostics", () => {
    const pages = createCardPageCoordinator();
    pages.register({ key: "flood", identities: ["f1", "f2"] });
    const diagnostics = pages.diagnostics() as {
      cards: { flood: { page: string; activeKey: string | null } };
      activeSubstates: Array<{ key: string }>;
    };
    expect(diagnostics.cards.flood).toMatchObject({ page: "1/2", activeKey: "f1" });
    expect(diagnostics.activeSubstates).toEqual(expect.arrayContaining([expect.objectContaining({ key: "flood" })]));
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

  it("resets flood on ordered river-key changes but not on detail-only updates", () => {
    const pages = createCardPageCoordinator();
    pages.register({ key: "flood", identities: ["a", "b", "c"], resetKey: "compact:a,b,c" });
    pages.jumpTo("flood", 2);
    pages.register({ key: "flood", identities: ["a", "b", "c"], resetKey: "compact:a,b,c" });
    expect(pages.cardDiagnostics("flood").activeKey).toBe("c");
    pages.register({ key: "flood", identities: ["b", "a", "c"], resetKey: "compact:b,a,c" });
    expect(pages.cardDiagnostics("flood").activeKey).toBe("b");
    pages.dispose();
  });

  it("visits every quake/weather/flood page within the 15×R×P logical-rotation bound", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    const rotation = createRotationScheduler({ clock: time.clock, reducedMotion: () => true });
    const members = {
      quake: ["q1", "q2", "q3"],
      weather: ["w1", "w2"],
      flood: ["f1", "f2", "f3", "f4"],
    } as const;
    for (const [key, identities] of Object.entries(members) as Array<["quake" | "weather" | "flood", readonly string[]]>) {
      pages.register({ key, identities, rotationMember: true });
    }
    const rotationKeys = ["quake", "weather", "flood"] as const;
    const pageMaximum = Math.max(...Object.values(members).map((identities) => identities.length));
    const deadlineMs = TIME_SLICE_PERIOD_MS * rotationKeys.length * pageMaximum;
    const expected = new Set(Object.entries(members).flatMap(([key, identities]) => identities.map((identity) => `${key}:${identity}`)));
    const seen = new Set<string>();
    rotation.sync({ stage: 3, keys: rotationKeys });
    const initialKey = rotation.activeKey as "quake" | "weather" | "flood";
    seen.add(`${initialKey}:${pages.cardDiagnostics(initialKey).activeKey}`);
    for (let elapsedMs = TIME_SLICE_PERIOD_MS; elapsedMs <= deadlineMs; elapsedMs += TIME_SLICE_PERIOD_MS) {
      time.advance(TIME_SLICE_PERIOD_MS);
      const key = rotation.activeKey as "quake" | "weather" | "flood";
      pages.recordRotationAppearance(key);
      seen.add(`${key}:${pages.cardDiagnostics(key).activeKey}`);
    }
    expect(deadlineMs).toBe(TIME_SLICE_PERIOD_MS * rotationKeys.length * pageMaximum);
    expect(seen).toEqual(expected);
    rotation.dispose();
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

  it("keeps a tornado runtime separate from layout card keys", () => {
    const time = controlledClock();
    const pages = createCardPageCoordinator({ clock: time.clock });
    pages.register({ key: "tornado", identities: ["t1", "t2"] });

    time.advance(TIME_SLICE_PERIOD_MS);
    expect(pages.cardDiagnostics("tornado").activeKey).toBe("t2");
    expect(pages.diagnostics()).toMatchObject({ cards: { tornado: { page: "2/2" } } });
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
