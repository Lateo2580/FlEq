import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLayoutMotionCoordinator } from "../layout-motion.svelte";

class ControlledAnimation {
  playState: AnimationPlayState = "running";
  private resolveFinished!: () => void;
  private rejectFinished!: (reason?: unknown) => void;
  private readonly finishedPromise = new Promise<void>((resolve, reject) => {
    this.resolveFinished = resolve;
    this.rejectFinished = reject;
  });
  readonly cancel = vi.fn(() => {
    this.playState = "idle";
    this.rejectFinished(new DOMException("cancelled", "AbortError"));
  });

  get finished(): Promise<void> {
    return this.finishedPromise;
  }

  finish(): void {
    this.playState = "finished";
    this.resolveFinished();
  }
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

describe("legacy standby layout motion coordinator", () => {
  let animations: ControlledAnimation[];
  let animateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    animations = [];
    vi.stubGlobal("Animation", ControlledAnimation);
    animateSpy = vi.spyOn(Element.prototype, "animate").mockImplementation(() => {
      const animation = new ControlledAnimation();
      animations.push(animation);
      return animation as unknown as Animation;
    });
  });

  afterEach(() => {
    animateSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses finished as the primary completion and excludes the deadline path", async () => {
    const root = document.createElement("div");
    const card = document.createElement("article");
    card.textContent = "old";
    let currentRect = rect(10, 20, 100, 40);
    card.getBoundingClientRect = () => currentRect;
    root.append(card);
    document.body.append(root);
    const complete = vi.fn();
    const motion = createLayoutMotionCoordinator({ root: () => root, durationMs: 10 });
    motion.register(card, { key: "quake", surface: "left" });

    motion.preEpochCapture("2");
    card.textContent = "new";
    currentRect = rect(30, 25, 100, 60);
    motion.runForEpoch("2", complete);

    expect(animations).toHaveLength(2);
    expect(root.querySelectorAll("[data-layout-motion-shell]")).toHaveLength(1);
    animations.forEach((animation) => animation.finish());
    await Promise.resolve();
    await Promise.resolve();
    expect(complete).toHaveBeenCalledOnce();
    expect(root.querySelector("[data-layout-motion-shell]")).toBeNull();
    vi.advanceTimersByTime(20);
    expect(animations.every((animation) => animation.cancel.mock.calls.length === 0)).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    motion.dispose();
    root.remove();
  });

  it("cancels every animation at the deadline and completes exactly once", async () => {
    const root = document.createElement("div");
    const card = document.createElement("article");
    card.getBoundingClientRect = () => rect(0, 0, 100, 40);
    root.append(card);
    document.body.append(root);
    const complete = vi.fn();
    const motion = createLayoutMotionCoordinator({ root: () => root, durationMs: 10 });
    motion.register(card, { key: "weather", surface: "right" });
    motion.preEpochCapture("3");
    card.textContent = "changed";
    motion.runForEpoch("3", complete);

    vi.advanceTimersByTime(20);
    await Promise.resolve();
    expect(animations).toHaveLength(2);
    expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    expect(motion.diagnostics()).toMatchObject({ inFlight: false, animations: 0, shells: 0 });
    motion.dispose();
    root.remove();
  });

  it("supersedes an old run without releasing it and ignores its late callbacks", async () => {
    const root = document.createElement("div");
    const card = document.createElement("article");
    card.textContent = "a";
    card.getBoundingClientRect = () => rect(0, 0, 100, 40);
    root.append(card);
    document.body.append(root);
    const oldComplete = vi.fn();
    const nextComplete = vi.fn();
    const motion = createLayoutMotionCoordinator({ root: () => root, durationMs: 10 });
    motion.register(card, { key: "quake", surface: "left" });
    motion.preEpochCapture("old");
    card.textContent = "b";
    motion.runForEpoch("old", oldComplete);
    const oldAnimations = [...animations];

    motion.preEpochCapture("new");
    expect(oldAnimations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(oldComplete).not.toHaveBeenCalled();
    card.textContent = "c";
    motion.runForEpoch("new", nextComplete);
    animations.slice(oldAnimations.length).forEach((animation) => animation.finish());
    await Promise.resolve();
    await Promise.resolve();
    expect(nextComplete).toHaveBeenCalledOnce();
    expect(oldComplete).not.toHaveBeenCalled();
    expect(root.querySelector("[data-layout-motion-shell]")).toBeNull();
    motion.dispose();
    root.remove();
  });

  it("captures the visible in-flight translate before cancelling a superseded run", () => {
    const root = document.createElement("div");
    const card = document.createElement("article");
    let currentRect = rect(0, 0, 100, 40);
    card.getBoundingClientRect = () => currentRect;
    root.append(card);
    document.body.append(root);
    const motion = createLayoutMotionCoordinator({ root: () => root, durationMs: 10 });
    motion.register(card, { key: "quake", surface: "left" });

    motion.preEpochCapture("old");
    currentRect = rect(100, 0, 100, 40);
    motion.runForEpoch("old", vi.fn());
    const oldAnimation = animations[0]!;
    // Simulate a composited translate at x=60. Cancelling restores x=100.
    currentRect = rect(60, 0, 100, 40);
    oldAnimation.cancel.mockImplementation(() => {
      currentRect = rect(100, 0, 100, 40);
      oldAnimation.playState = "idle";
    });

    motion.preEpochCapture("new");
    currentRect = rect(200, 0, 100, 40);
    motion.runForEpoch("new", vi.fn());

    const frames = animateSpy.mock.calls.at(-1)?.[0] as Keyframe[];
    // The new FLIP starts at visual x=60, not the cancelled base x=100.
    expect(frames[0]).toMatchObject({ translate: "-140px 0px" });
    motion.dispose();
    root.remove();
  });

  it("uses a tokenized timer fallback without creating visual shells when WAAPI is unavailable", () => {
    vi.stubGlobal("Animation", undefined);
    const root = document.createElement("div");
    const card = document.createElement("article");
    card.textContent = "old";
    card.getBoundingClientRect = () => rect(0, 0, 100, 40);
    root.append(card);
    document.body.append(root);
    const complete = vi.fn();
    const motion = createLayoutMotionCoordinator({ root: () => root, durationMs: 10 });
    motion.register(card, { key: "quake", surface: "left" });
    motion.preEpochCapture("fallback");
    card.textContent = "new";
    motion.runForEpoch("fallback", complete);

    expect(animateSpy).not.toHaveBeenCalled();
    expect(root.querySelector("[data-layout-motion-shell]")).toBeNull();
    vi.advanceTimersByTime(9);
    expect(complete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(complete).toHaveBeenCalledOnce();
    motion.dispose();
    root.remove();
  });

  it("disposes a running fallback timer before it can retain resources or release", () => {
    vi.stubGlobal("Animation", undefined);
    const root = document.createElement("div");
    const card = document.createElement("article");
    card.getBoundingClientRect = () => rect(0, 0, 100, 40);
    root.append(card);
    document.body.append(root);
    const complete = vi.fn();
    const motion = createLayoutMotionCoordinator({ root: () => root, durationMs: 10 });
    motion.register(card, { key: "quake", surface: "left" });
    motion.preEpochCapture("fallback-dispose");
    card.textContent = "new";
    motion.runForEpoch("fallback-dispose", complete);

    expect(vi.getTimerCount()).toBe(1);
    motion.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(20);
    expect(complete).not.toHaveBeenCalled();
    expect(motion.diagnostics()).toMatchObject({ inFlight: false, animations: 0, shells: 0 });
    root.remove();
  });

  it("uses independent translate for a same-key surface FLIP without overwriting transform", async () => {
    const root = document.createElement("div");
    const card = document.createElement("article");
    card.style.transform = "scale(0.98)";
    let currentRect = rect(0, 0, 100, 40);
    card.getBoundingClientRect = () => currentRect;
    root.append(card);
    document.body.append(root);
    const complete = vi.fn();
    const motion = createLayoutMotionCoordinator({ root: () => root, durationMs: 10 });
    const registration = motion.register(card, { key: "quake", surface: "left" });
    motion.preEpochCapture("move");
    registration.update({ key: "quake", surface: "center" });
    currentRect = rect(80, 30, 100, 40);
    motion.runForEpoch("move", complete);

    expect(animations).toHaveLength(1);
    expect(root.querySelector("[data-layout-motion-shell]")).toBeNull();
    const frames = animateSpy.mock.calls[0]?.[0] as Keyframe[];
    expect(frames[0]).toMatchObject({ translate: "-80px -30px" });
    expect(card.style.transform).toBe("scale(0.98)");
    animations[0]?.finish();
    await Promise.resolve();
    expect(complete).toHaveBeenCalledOnce();
    motion.dispose();
    root.remove();
  });

  it("animates an added card and keeps a captured removed shell until completion", async () => {
    const root = document.createElement("div");
    const removed = document.createElement("article");
    removed.textContent = "removed";
    removed.getBoundingClientRect = () => rect(0, 0, 100, 40);
    root.append(removed);
    document.body.append(root);
    const complete = vi.fn();
    const motion = createLayoutMotionCoordinator({ root: () => root, durationMs: 10 });
    const oldRegistration = motion.register(removed, { key: "quake", surface: "left" });
    motion.preEpochCapture("replace");
    oldRegistration.destroy();
    removed.remove();
    const added = document.createElement("article");
    added.textContent = "added";
    added.getBoundingClientRect = () => rect(40, 0, 100, 40);
    root.append(added);
    motion.register(added, { key: "weather", surface: "right" });
    motion.runForEpoch("replace", complete);

    expect(animations).toHaveLength(2);
    expect(root.querySelector("[data-layout-motion-shell]")?.textContent).toBe("removed");
    animations.forEach((animation) => animation.finish());
    await Promise.resolve();
    await Promise.resolve();
    expect(complete).toHaveBeenCalledOnce();
    expect(root.querySelector("[data-layout-motion-shell]")).toBeNull();
    motion.dispose();
    root.remove();
  });

  it("replaces immediately under reduced motion while leaving scheduling to its owner", () => {
    const root = document.createElement("div");
    const card = document.createElement("article");
    card.textContent = "old";
    card.getBoundingClientRect = () => rect(0, 0, 100, 40);
    root.append(card);
    document.body.append(root);
    const complete = vi.fn();
    const motion = createLayoutMotionCoordinator({ root: () => root, durationMs: 10, reducedMotion: () => true });
    motion.register(card, { key: "weather", surface: "right" });
    motion.preEpochCapture("reduced");
    card.textContent = "new";
    motion.runForEpoch("reduced", complete);

    expect(complete).toHaveBeenCalledOnce();
    expect(animateSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(root.querySelector("[data-layout-motion-shell]")).toBeNull();
    motion.dispose();
    root.remove();
  });

  it("disposes animations, fallback timers, shells, and all late callbacks", async () => {
    const root = document.createElement("div");
    const card = document.createElement("article");
    card.textContent = "old";
    card.getBoundingClientRect = () => rect(0, 0, 100, 40);
    root.append(card);
    document.body.append(root);
    const complete = vi.fn();
    const motion = createLayoutMotionCoordinator({ root: () => root, durationMs: 10 });
    motion.register(card, { key: "weather", surface: "right" });
    motion.preEpochCapture("dispose");
    card.textContent = "new";
    motion.runForEpoch("dispose", complete);
    motion.dispose();

    expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(root.querySelector("[data-layout-motion-shell]")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    animations.forEach((animation) => animation.finish());
    await Promise.resolve();
    vi.advanceTimersByTime(20);
    expect(complete).not.toHaveBeenCalled();
    root.remove();
  });
});
