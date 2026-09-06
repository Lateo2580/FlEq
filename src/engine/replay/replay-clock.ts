export interface ReplayScheduledTask {
  readonly id: number;
}

interface PendingTask {
  handle: ReplayScheduledTask;
  deadlineMs: number;
  ordinal: number;
  callback: () => void;
  cancelled: boolean;
}

export class ReplayClock {
  private currentMs: number;
  private readonly advanceListeners = new Set<() => void>();

  constructor(initialMs: number) {
    if (!Number.isSafeInteger(initialMs)) throw new Error("invalid replay clock initial time");
    this.currentMs = initialMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  onAdvance(listener: () => void): () => void {
    this.advanceListeners.add(listener);
    return () => this.advanceListeners.delete(listener);
  }

  advanceTo(nextMs: number): void {
    if (!Number.isSafeInteger(nextMs)) throw new Error("invalid replay clock time");
    if (nextMs < this.currentMs) throw new Error("replay business time regression");
    this.currentMs = nextMs;
    for (const listener of this.advanceListeners) listener();
  }
}

export class ReplayScheduler {
  private readonly tasks = new Map<number, PendingTask>();
  private nextId = 1;
  private nextOrdinal = 1;
  private draining = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly clock: ReplayClock) {
    this.unsubscribe = clock.onAdvance(() => this.drainDue());
  }

  set(delayMs: number, callback: () => void): ReplayScheduledTask {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("invalid replay scheduler delay");
    const handle = Object.freeze({ id: this.nextId++ });
    this.tasks.set(handle.id, {
      handle,
      deadlineMs: this.clock.nowMs() + delayMs,
      ordinal: this.nextOrdinal++,
      callback,
      cancelled: false,
    });
    return handle;
  }

  clear(handle: unknown): void {
    if (typeof handle !== "object" || handle == null || !("id" in handle)) return;
    const id = (handle as { id?: unknown }).id;
    if (typeof id !== "number") return;
    const task = this.tasks.get(id);
    if (task != null) task.cancelled = true;
    this.tasks.delete(id);
  }

  drainDue(maxCallbacks = 1024): number {
    if (this.draining) return 0;
    this.draining = true;
    let count = 0;
    try {
      while (true) {
        const next = [...this.tasks.values()]
          .filter((task) => !task.cancelled && task.deadlineMs <= this.clock.nowMs())
          .sort((a, b) => a.deadlineMs - b.deadlineMs || a.ordinal - b.ordinal)[0];
        if (next == null) return count;
        if (count >= maxCallbacks) throw new Error("replay scheduler drain limit exceeded");
        this.tasks.delete(next.handle.id);
        count += 1;
        next.callback();
      }
    } finally {
      this.draining = false;
    }
  }

  pendingDueCount(): number {
    return [...this.tasks.values()].filter((task) => task.deadlineMs <= this.clock.nowMs()).length;
  }

  pendingCount(): number {
    return this.tasks.size;
  }

  dispose(): void {
    this.unsubscribe();
    this.tasks.clear();
  }
}
