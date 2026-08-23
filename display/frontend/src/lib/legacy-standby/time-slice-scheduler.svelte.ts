import { tick } from "svelte";
import { createSubscriber } from "svelte/reactivity";
import type { EpochCoordinator } from "./epoch-coordinator";
import { planCardPageRuntimeUpdate } from "./page-partition";
import type { CardKey, CardPageRuntime, LadderStage, PageableKey } from "./types";

export const TIME_SLICE_PERIOD_MS = 15_000;
export const TIME_SLICE_TRANSITION_DEADLINE_MS = 500;

type Timer = ReturnType<typeof setTimeout>;
const PAGEABLE_KEYS = ["quake", "weather", "flood", "tornado"] as const satisfies readonly PageableKey[];

export interface MonotonicClock {
  now(): number;
}

export function createMonotonicClock(): MonotonicClock {
  let originPerformanceMs: number | null = null;
  let originDateMs: number | null = null;
  let lastMs = 0;
  return {
    now(): number {
      const performanceNow = typeof performance === "undefined" ? Number.NaN : performance.now();
      const dateNow = Date.now();
      originPerformanceMs ??= Number.isFinite(performanceNow) ? performanceNow : 0;
      originDateMs ??= dateNow;
      const performanceDelta = Number.isFinite(performanceNow) ? performanceNow - originPerformanceMs : 0;
      const dateDelta = dateNow - originDateMs;
      lastMs = Math.max(lastMs, performanceDelta, dateDelta);
      return lastMs;
    },
  };
}

function idleEpochCoordinator(): EpochCoordinator {
  return {
    isBusy: () => false,
    onSettled: () => () => {},
    enqueueProbe: (_id, measure) => measure(),
    epochKey: () => "standalone",
    dispose: () => {},
  };
}

interface SchedulerOptions {
  epoch?: EpochCoordinator;
  clock?: MonotonicClock;
  periodMs?: number;
}

export interface RotationSchedulerOptions extends SchedulerOptions {
  tickOverride?: number | null;
  reducedMotion?: () => boolean;
  onAppearance?: (key: CardKey) => void;
}

export interface RotationSync {
  stage: LadderStage;
  keys: readonly CardKey[];
  /** A transient measurement absence is a suspension, not a stage-3 exit. */
  suspended?: boolean;
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function successorAfterRemoval(previousKeys: readonly CardKey[], activeKey: CardKey | null, nextKeys: readonly CardKey[]): CardKey | null {
  if (nextKeys.length === 0) return null;
  if (activeKey == null) return nextKeys[0] ?? null;
  const activeIndex = previousKeys.indexOf(activeKey);
  if (activeIndex >= 0) {
    for (let offset = 1; offset <= previousKeys.length; offset += 1) {
      const candidate = previousKeys[(activeIndex + offset) % previousKeys.length];
      if (candidate != null && nextKeys.includes(candidate)) return candidate;
    }
  }
  return nextKeys[0] ?? null;
}

export class RotationScheduler {
  activeKey: CardKey | null = null;
  keys: CardKey[] = [];
  suspended = false;
  processedTick = 0;
  tickPending = false;
  mounted = true;

  private readonly epoch: EpochCoordinator;
  private readonly clock: MonotonicClock;
  private readonly periodMs: number;
  private readonly tickOverride: number | null;
  private readonly reducedMotion: () => boolean;
  private readonly onAppearance: (key: CardKey) => void;
  private stage: LadderStage | null = null;
  private phaseKey: CardKey | null = null;
  private phaseStartedAtMs = 0;
  private activeStartedAtMs = 0;
  private seenKeys = new Set<CardKey>();
  private timer: Timer | null = null;
  private target: HTMLElement | null = null;
  private transition: Animation | null = null;
  private transitionDeadline: Timer | null = null;
  private transitionToken = 0;
  private epochHeld = false;
  private unsubscribeSettled: () => void;
  private notify = (): void => {};
  private readonly subscribe = createSubscriber((update) => {
    this.notify = update;
    return () => {
      if (this.notify === update) this.notify = () => {};
    };
  });

  constructor(options: RotationSchedulerOptions = {}) {
    this.epoch = options.epoch ?? idleEpochCoordinator();
    this.clock = options.clock ?? createMonotonicClock();
    this.periodMs = options.periodMs ?? TIME_SLICE_PERIOD_MS;
    this.tickOverride = options.tickOverride ?? null;
    this.reducedMotion = options.reducedMotion ?? (() => typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    this.onAppearance = options.onAppearance ?? (() => {});
    this.unsubscribeSettled = this.epoch.onSettled(() => {
      if (!this.mounted || this.epochHeld) return;
      if (this.tickPending) {
        this.tickPending = false;
        this.processTick();
      } else {
        this.scheduleTimer();
      }
    });
  }

  setTransitionTarget(node: HTMLElement | null): void {
    this.target = node;
  }

  holdForEpoch(): void {
    if (!this.mounted) return;
    this.epochHeld = true;
    this.tickPending = true;
    this.clearTimer();
    this.cancelTransition();
    this.notify();
  }

  releaseAfterLayoutMotion(): void {
    if (!this.mounted || !this.epochHeld) return;
    this.epochHeld = false;
    if (this.tickPending) {
      this.tickPending = false;
      this.processTick();
    } else {
      this.scheduleTimer();
      this.notify();
    }
  }

  currentKey(): CardKey | null {
    this.subscribe();
    return this.activeKey;
  }

  private clearTimer(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
  }

  private cancelTransition(): void {
    this.transitionToken += 1;
    if (this.transitionDeadline != null) clearTimeout(this.transitionDeadline);
    this.transitionDeadline = null;
    const animation = this.transition;
    this.transition = null;
    animation?.cancel();
  }

  private resetPhase(key: CardKey, startedAtMs: number): void {
    this.phaseKey = key;
    this.phaseStartedAtMs = startedAtMs;
    this.activeStartedAtMs = startedAtMs;
    this.processedTick = 0;
  }

  private completeTransition(token: number, animation: Animation): void {
    if (token !== this.transitionToken || this.transition !== animation) return;
    if (this.transitionDeadline != null) clearTimeout(this.transitionDeadline);
    this.transitionDeadline = null;
    this.transition = null;
    this.notify();
    if (this.tickPending && !this.epoch.isBusy()) {
      this.tickPending = false;
      this.processTick();
    }
  }

  private startTransition(): void {
    if (this.target == null || this.reducedMotion() || typeof this.target.animate !== "function") return;
    const token = ++this.transitionToken;
    const animation = this.target.animate(
      [{ opacity: "0.72" }, { opacity: "1" }],
      { duration: TIME_SLICE_TRANSITION_DEADLINE_MS / 2, easing: "ease-out" },
    );
    this.transition = animation;
    this.notify();
    animation.onfinish = () => this.completeTransition(token, animation);
    animation.oncancel = () => this.completeTransition(token, animation);
    this.transitionDeadline = setTimeout(() => {
      if (token !== this.transitionToken) return;
      animation.cancel();
      this.completeTransition(token, animation);
    }, TIME_SLICE_TRANSITION_DEADLINE_MS);
  }

  private applyKey(key: CardKey | null, animate: boolean): void {
    if (key == null || key === this.activeKey) return;
    this.cancelTransition();
    // Replace the key atomically. The slot never passes through a null frame.
    this.activeKey = key;
    if (!animate || this.tickOverride != null || this.stage !== 3 || this.reducedMotion()) return;
    const token = this.transitionToken;
    void tick().then(() => {
      if (token !== this.transitionToken || this.activeKey !== key || this.stage !== 3) return;
      this.startTransition();
    });
  }

  private recordAppearance(key: CardKey): void {
    if (this.seenKeys.has(key)) this.onAppearance(key);
    this.seenKeys.add(key);
  }

  private scheduleTimer(nowMs = this.clock.now()): void {
    this.clearTimer();
    if (!this.mounted || this.epochHeld || this.tickOverride != null || this.stage !== 3 || this.suspended || this.keys.length === 0) return;
    const elapsedTicks = Math.max(0, Math.floor((nowMs - this.phaseStartedAtMs) / this.periodMs));
    const deadline = this.phaseStartedAtMs + (elapsedTicks + 1) * this.periodMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.epoch.isBusy()) {
        this.tickPending = true;
        return;
      }
      this.processTick();
    }, Math.max(0, deadline - nowMs));
  }

  private processTickInternal(): void {
    if (!this.mounted || this.stage !== 3 || this.suspended || this.keys.length === 0) return;
    if (this.epochHeld || this.epoch.isBusy() || (this.transition != null && this.transition.playState === "running")) {
      this.tickPending = true;
      return;
    }
    const nowMs = this.clock.now();
    const elapsedTicks = Math.max(0, Math.floor((nowMs - this.phaseStartedAtMs) / this.periodMs));
    if (elapsedTicks <= this.processedTick) {
      this.scheduleTimer(nowMs);
      return;
    }
    const phaseIndex = this.phaseKey == null ? 0 : this.keys.indexOf(this.phaseKey);
    const activeIndex = this.activeKey == null ? -1 : this.keys.indexOf(this.activeKey);
    const originIndex = phaseIndex >= 0 ? phaseIndex : Math.max(0, activeIndex);
    let virtualActive = this.activeKey;
    for (let index = this.processedTick + 1; index <= elapsedTicks; index += 1) {
      const stepped = this.keys[(originIndex + index) % this.keys.length];
      if (stepped == null) continue;
      if (stepped === virtualActive) {
        if (this.keys.length === 1) this.recordAppearance(stepped);
        continue;
      }
      this.recordAppearance(stepped);
      virtualActive = stepped;
    }
    this.processedTick = elapsedTicks;
    this.applyKey(this.keys[(originIndex + elapsedTicks) % this.keys.length] ?? null, true);
    this.activeStartedAtMs = this.phaseStartedAtMs + elapsedTicks * this.periodMs;
    this.scheduleTimer(nowMs);
  }

  processTick(): void {
    this.processTickInternal();
    this.notify();
  }

  private syncInternal(input: RotationSync): void {
    if (!this.mounted) return;
    const nextKeys = [...input.keys];
    const previousKeys = this.keys;
    const previousActive = this.activeKey;
    const collectionChanged = !sameKeys(previousKeys, nextKeys);
    const stageChanged = this.stage !== input.stage;
    if (stageChanged || collectionChanged || input.suspended === true) this.cancelTransition();

    if (input.stage !== 3 || nextKeys.length === 0) {
      if (input.suspended === true && this.stage === 3) {
        this.suspended = true;
        this.clearTimer();
        return;
      }
      this.clearTimer();
      this.stage = null;
      this.keys = [];
      this.suspended = false;
      this.phaseKey = null;
      this.phaseStartedAtMs = 0;
      this.activeStartedAtMs = 0;
      this.processedTick = 0;
      this.seenKeys = new Set();
      this.activeKey = null;
      this.tickPending = false;
      return;
    }

    const resuming = this.suspended;
    if (this.stage !== 3) {
      this.stage = 3;
      this.keys = nextKeys;
      this.suspended = false;
      const nowMs = this.clock.now();
      const initial = this.tickOverride == null
        ? nextKeys[0]
        : nextKeys[this.tickOverride % nextKeys.length];
      if (initial != null) {
        this.resetPhase(initial, nowMs);
        this.seenKeys = new Set([initial]);
        this.applyKey(initial, false);
      }
    } else {
      this.keys = nextKeys;
      this.suspended = false;
      if (this.tickOverride != null) {
        this.applyKey(nextKeys[this.tickOverride % nextKeys.length] ?? null, false);
      } else if (collectionChanged) {
        const nowMs = this.clock.now();
        if (previousActive != null && nextKeys.includes(previousActive)) {
          this.resetPhase(previousActive, this.activeStartedAtMs);
        } else {
          const next = successorAfterRemoval(previousKeys, previousActive, nextKeys);
          if (next != null) {
            this.resetPhase(next, nowMs);
            this.recordAppearance(next);
            this.applyKey(next, false);
          }
        }
      }
    }
    if (resuming) this.tickPending = true;
    if (this.epochHeld) return;
    if (this.tickPending && !this.epoch.isBusy()) {
      this.tickPending = false;
      this.processTick();
    } else {
      this.scheduleTimer();
    }
  }

  sync(input: RotationSync): void {
    this.syncInternal(input);
    this.notify();
  }

  diagnostics(): object {
    this.subscribe();
    return {
      stage: this.stage,
      keys: this.keys,
      activeKey: this.activeKey,
      phaseKey: this.phaseKey,
      phaseStartedAtMs: this.phaseStartedAtMs,
      activeStartedAtMs: this.activeStartedAtMs,
      seenKeys: [...this.seenKeys],
      processedTick: this.processedTick,
      tickPending: this.tickPending,
      epochHeld: this.epochHeld,
      suspended: this.suspended,
      tickOverride: this.tickOverride,
      timerActive: this.timer != null,
      inFlight: this.transition != null,
    };
  }

  dispose(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.unsubscribeSettled();
    this.clearTimer();
    this.cancelTransition();
    this.keys = [];
    this.activeKey = null;
    this.tickPending = false;
    this.epochHeld = false;
    this.notify();
  }
}

interface CardPageSubstate {
  mode: "real" | "logical";
  appearanceHost: CardKey | null;
  escalationGeneration: number;
  phaseStartedAtMs: number;
  processedTick: number;
  pageCount: number;
  resetKey: string;
}

export interface CardPageRegistration {
  key: PageableKey;
  identities: readonly string[];
  labels?: readonly string[];
  rotationMember?: boolean;
  /** Layout-card appearance that advances this logical dependent pager. */
  appearanceHost?: CardKey;
  resetKey?: string | number;
  /** Increases only for a false-to-true tornado sighting escalation. */
  escalationGeneration?: number;
  suppressAddedKeys?: boolean;
}

export interface CardPageCoordinatorOptions extends SchedulerOptions {
  tickOverride?: number | null;
}

const EMPTY_RUNTIME = (): CardPageRuntime => ({ activeKey: null, knownKeys: [], pendingKeys: [], cycleOriginKey: null });
const EMPTY_SUBSTATE = (): CardPageSubstate => ({ mode: "real", appearanceHost: null, escalationGeneration: 0, phaseStartedAtMs: 0, processedTick: 0, pageCount: 0, resetKey: "" });

export class CardPageCoordinator {
  revision = 0;
  processedTick = 0;
  tickPending = false;
  mounted = true;

  private readonly epoch: EpochCoordinator;
  private readonly clock: MonotonicClock;
  private readonly periodMs: number;
  private readonly tickOverride: number | null;
  private runtime: Record<PageableKey, CardPageRuntime> = { quake: EMPTY_RUNTIME(), weather: EMPTY_RUNTIME(), flood: EMPTY_RUNTIME(), tornado: EMPTY_RUNTIME() };
  private substates: Record<PageableKey, CardPageSubstate> = { quake: EMPTY_SUBSTATE(), weather: EMPTY_SUBSTATE(), flood: EMPTY_SUBSTATE(), tornado: EMPTY_SUBSTATE() };
  private labels: Record<PageableKey, string[]> = { quake: [], weather: [], flood: [], tornado: [] };
  private timer: Timer | null = null;
  private epochHeld = false;
  private pendingAppearanceKeys = new Set<PageableKey>();
  private unsubscribeSettled: () => void;
  private notify = (): void => {};
  private readonly subscribe = createSubscriber((update) => {
    this.notify = update;
    return () => {
      if (this.notify === update) this.notify = () => {};
    };
  });

  constructor(options: CardPageCoordinatorOptions = {}) {
    this.epoch = options.epoch ?? idleEpochCoordinator();
    this.clock = options.clock ?? createMonotonicClock();
    this.periodMs = options.periodMs ?? TIME_SLICE_PERIOD_MS;
    this.tickOverride = options.tickOverride ?? null;
    this.unsubscribeSettled = this.epoch.onSettled(() => {
      if (!this.mounted || this.epochHeld) return;
      if (this.tickPending) {
        this.tickPending = false;
        this.processTick();
      } else {
        this.scheduleTimer();
      }
    });
  }

  private realKeys(): PageableKey[] {
    return PAGEABLE_KEYS.filter((key) => {
      const state = this.substates[key];
      return state.pageCount > 1 && state.mode === "real";
    });
  }

  holdForEpoch(): void {
    if (!this.mounted) return;
    this.epochHeld = true;
    this.tickPending = true;
    this.clearTimer();
    this.notify();
  }

  releaseAfterLayoutMotion(): void {
    if (!this.mounted || !this.epochHeld) return;
    this.epochHeld = false;
    const pendingAppearances = [...this.pendingAppearanceKeys];
    this.pendingAppearanceKeys.clear();
    if (this.tickPending) {
      this.tickPending = false;
      this.processTick();
    } else {
      this.scheduleTimer();
    }
    for (const key of pendingAppearances) {
      if (this.substates[key].mode === "logical" && this.substates[key].pageCount > 1) this.advance(key, 1);
    }
    this.notify();
  }

  private clearTimer(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
  }

  private setRuntime(key: PageableKey, runtime: CardPageRuntime): void {
    this.runtime = { ...this.runtime, [key]: runtime };
  }

  private advance(key: PageableKey, steps: number): void {
    if (this.tickOverride != null || steps <= 0) return;
    const keys = this.runtime[key].knownKeys;
    if (keys.length <= 1) return;
    let runtime = this.runtime[key];
    let activeKey = runtime.activeKey;
    let pendingKeys = runtime.pendingKeys;
    let cycleOriginKey = runtime.cycleOriginKey;
    for (let step = 0; step < steps; step += 1) {
      const stableKeys = keys.filter((candidate) => !pendingKeys.includes(candidate));
      const eligibleKeys = stableKeys.length > 0 ? stableKeys : keys;
      const currentIndex = Math.max(0, eligibleKeys.indexOf(activeKey ?? ""));
      const nextStableKey = eligibleKeys[(currentIndex + 1) % eligibleKeys.length] ?? eligibleKeys[0] ?? null;
      if (pendingKeys.length > 0 && cycleOriginKey != null && nextStableKey === cycleOriginKey) {
        pendingKeys = [];
        cycleOriginKey = null;
        activeKey = nextStableKey;
      } else if (pendingKeys.length > 0) {
        activeKey = nextStableKey;
      } else {
        const nextIndex = Math.max(0, keys.indexOf(activeKey ?? ""));
        activeKey = keys[(nextIndex + 1) % keys.length] ?? keys[0] ?? null;
      }
    }
    this.setRuntime(key, { activeKey, knownKeys: [...keys], pendingKeys: [...pendingKeys], cycleOriginKey });
    this.revision += 1;
  }

  private scheduleTimer(nowMs = this.clock.now()): void {
    this.clearTimer();
    const realKeys = this.realKeys();
    if (!this.mounted || this.epochHeld || this.tickOverride != null || realKeys.length === 0) return;
    const deadline = Math.min(...realKeys.map((key) => {
      const state = this.substates[key];
      return state.phaseStartedAtMs + (state.processedTick + 1) * this.periodMs;
    }));
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.epoch.isBusy()) {
        this.tickPending = true;
        this.notify();
        return;
      }
      this.processTick();
    }, Math.max(0, deadline - nowMs));
  }

  processTick(): void {
    if (!this.mounted || this.realKeys().length === 0) return;
    if (this.epochHeld || this.epoch.isBusy()) {
      this.tickPending = true;
      this.notify();
      return;
    }
    const nowMs = this.clock.now();
    let nextSubstates = { ...this.substates };
    for (const key of this.realKeys()) {
      const state = nextSubstates[key];
      const elapsedTicks = Math.max(0, Math.floor((nowMs - state.phaseStartedAtMs) / this.periodMs));
      if (elapsedTicks <= state.processedTick) continue;
      this.advance(key, elapsedTicks - state.processedTick);
      nextSubstates = { ...nextSubstates, [key]: { ...state, processedTick: elapsedTicks } };
    }
    this.substates = nextSubstates;
    this.processedTick = Math.max(0, ...Object.values(nextSubstates).map((state) => state.processedTick));
    this.scheduleTimer(nowMs);
    this.notify();
  }

  register(input: CardPageRegistration): void {
    if (!this.mounted) return;
    this.clearTimer();
    const key = input.key;
    const identities = [...input.identities];
    const labels = input.labels == null ? identities : [...input.labels];
    const previousState = this.substates[key];
    const previousCount = previousState.pageCount;
    const nextCount = identities.length;
    const nextMode = input.rotationMember === true ? "logical" : "real";
    const appearanceHost = input.appearanceHost ?? (key === "tornado" ? null : key);
    const escalationGeneration = input.escalationGeneration ?? previousState.escalationGeneration;
    const resetKey = String(input.resetKey ?? "");
    const exit = previousCount > 1 && nextCount <= 1;
    const entry = previousCount <= 1 && nextCount > 1;
    const explicitReset = previousState.resetKey !== "" && previousState.resetKey !== resetKey;
    const escalationReset = key === "tornado" && escalationGeneration > previousState.escalationGeneration;
    const reset = exit || entry || explicitReset || escalationReset;
    const nowMs = this.clock.now();
    let runtime = planCardPageRuntimeUpdate(this.runtime[key], identities, reset, input.suppressAddedKeys === true);
    if (this.tickOverride != null && identities.length > 0) {
      runtime = { ...runtime, activeKey: identities[this.tickOverride % identities.length] ?? identities[0] ?? null };
    }
    this.setRuntime(key, runtime);
    this.labels = { ...this.labels, [key]: labels };
    const modeChanged = previousState.mode !== nextMode;
    this.substates = {
      ...this.substates,
      [key]: {
        mode: nextMode,
        appearanceHost,
        escalationGeneration,
        phaseStartedAtMs: modeChanged || reset ? nowMs : previousState.phaseStartedAtMs,
        processedTick: modeChanged || reset ? 0 : previousState.processedTick,
        pageCount: nextCount,
        resetKey,
      },
    };
    this.processedTick = Math.max(0, ...Object.values(this.substates).map((state) => state.processedTick));
    this.scheduleTimer(nowMs);
    this.notify();
  }

  unregister(key: PageableKey): void {
    if (!this.mounted) return;
    this.clearTimer();
    this.pendingAppearanceKeys.delete(key);
    this.setRuntime(key, EMPTY_RUNTIME());
    this.labels = { ...this.labels, [key]: [] };
    this.substates = { ...this.substates, [key]: EMPTY_SUBSTATE() };
    this.revision += 1;
    this.scheduleTimer();
    this.notify();
  }

  recordRotationAppearance(key: CardKey): void {
    const dependentKeys = PAGEABLE_KEYS.filter((pageableKey) => {
      const state = this.substates[pageableKey];
      return state.appearanceHost === key && state.mode === "logical" && state.pageCount > 1;
    });
    if (dependentKeys.length === 0) return;
    if (this.epochHeld) {
      for (const dependentKey of dependentKeys) this.pendingAppearanceKeys.add(dependentKey);
      this.notify();
      return;
    }
    for (const dependentKey of dependentKeys) this.advance(dependentKey, 1);
    this.notify();
  }

  jumpTo(key: PageableKey, index: number): void {
    const keys = this.runtime[key].knownKeys;
    if (keys.length === 0) return;
    const normalized = ((index % keys.length) + keys.length) % keys.length;
    this.setRuntime(key, { ...this.runtime[key], activeKey: keys[normalized] ?? keys[0] ?? null });
    const nowMs = this.clock.now();
    this.substates = { ...this.substates, [key]: { ...this.substates[key], phaseStartedAtMs: nowMs, processedTick: 0 } };
    this.revision += 1;
    this.scheduleTimer(nowMs);
    this.notify();
  }

  activeIndex(key: PageableKey): number {
    // Reading revision makes this getter reactive even when only nested runtime state changed.
    this.subscribe();
    const runtime = this.runtime[key];
    const index = runtime.activeKey == null ? -1 : runtime.knownKeys.indexOf(runtime.activeKey);
    return index < 0 ? 0 : index;
  }

  cardDiagnostics(key: PageableKey): { page: string; keys: string[]; identities: string[]; activeKey: string | null } {
    this.subscribe();
    const state = this.substates[key];
    return {
      page: `${state.pageCount === 0 ? 0 : this.activeIndex(key) + 1}/${state.pageCount}`,
      keys: this.labels[key],
      identities: this.runtime[key].knownKeys,
      activeKey: this.runtime[key].activeKey,
    };
  }

  diagnostics(): object {
    this.subscribe();
    return {
      processedTick: this.processedTick,
      tickPending: this.tickPending,
      epochHeld: this.epochHeld,
      pendingAppearanceKeys: [...this.pendingAppearanceKeys],
      tickOverride: this.tickOverride,
      timerActive: this.timer != null,
      cards: {
        quake: { ...this.cardDiagnostics("quake"), ...this.substates.quake, ...this.runtime.quake },
        weather: { ...this.cardDiagnostics("weather"), ...this.substates.weather, ...this.runtime.weather },
        flood: { ...this.cardDiagnostics("flood"), ...this.substates.flood, ...this.runtime.flood },
        tornado: { ...this.cardDiagnostics("tornado"), ...this.substates.tornado, ...this.runtime.tornado },
      },
      activeSubstates: PAGEABLE_KEYS
        .filter((key) => this.substates[key].pageCount > 0)
        .map((key) => ({ key, ...this.substates[key], ...this.runtime[key] })),
    };
  }

  dispose(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.unsubscribeSettled();
    this.clearTimer();
    this.tickPending = false;
    this.epochHeld = false;
    this.pendingAppearanceKeys.clear();
    this.runtime = { quake: EMPTY_RUNTIME(), weather: EMPTY_RUNTIME(), flood: EMPTY_RUNTIME(), tornado: EMPTY_RUNTIME() };
    this.substates = { quake: EMPTY_SUBSTATE(), weather: EMPTY_SUBSTATE(), flood: EMPTY_SUBSTATE(), tornado: EMPTY_SUBSTATE() };
    this.labels = { quake: [], weather: [], flood: [], tornado: [] };
    this.notify();
  }
}

export function createRotationScheduler(options: RotationSchedulerOptions = {}): RotationScheduler {
  return new RotationScheduler(options);
}

export function createCardPageCoordinator(options: CardPageCoordinatorOptions = {}): CardPageCoordinator {
  return new CardPageCoordinator(options);
}
