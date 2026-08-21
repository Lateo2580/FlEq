/**
 * The ownership boundary between the layout epoch and the U4 schedulers.
 *
 * Measurement probes and external layout requests share this gate so a
 * scheduler added later cannot observe a partly measured or superseded layout.
 */
export interface EpochCoordinator {
  isBusy(): boolean;
  onSettled(cb: () => void): () => void;
  enqueueProbe(id: string, measure: () => void): void;
  epochKey(): string;
  dispose(): void;
}

export interface EpochCoordinatorControl extends EpochCoordinator {
  begin(key: string): void;
  /** Runs queued probes in FIFO order. The caller owns the DOM flush. */
  drainProbes(): void;
  /** Drops same-epoch probes when a bounded owner must terminally commit. */
  discardPendingProbes(): void;
  hasPendingProbes(): boolean;
  /** True only when this epoch may commit immediately before settle(). */
  canSettle(expectedKey: string): boolean;
  /** false when a probe arrived after the caller's final read. */
  settle(): boolean;
}

export function createEpochCoordinator(): EpochCoordinatorControl {
  let busy = false;
  let disposed = false;
  let key = "0";
  let queuedKey: string | null = null;
  let probes: Array<{ id: string; measure: () => void }> = [];
  const listeners = new Set<() => void>();

  const notify = (): void => {
    if (busy || disposed) return;
    for (const listener of listeners) listener();
  };

  return {
    isBusy: () => busy,
    onSettled(cb) {
      if (!disposed) listeners.add(cb);
      return () => listeners.delete(cb);
    },
    enqueueProbe(id, measure) {
      if (disposed) return;
      // Replacing an id makes repeated registrations deterministic without
      // allowing the queue to grow across an epoch.
      probes = [...probes.filter((probe) => probe.id !== id), { id, measure }];
      busy = true;
    },
    epochKey: () => key,
    begin(nextKey) {
      if (disposed) return;
      if (busy) {
        if (nextKey !== key) {
          // A newer external epoch invalidates probes owned by the active one.
          // Keep the gate busy and promote the queued key before any settled
          // notification can escape for the superseded epoch.
          queuedKey = nextKey;
          probes = [];
        }
        return;
      }
      key = nextKey;
      busy = true;
    },
    drainProbes() {
      if (disposed) return;
      while (probes.length > 0) probes.shift()?.measure();
    },
    discardPendingProbes() {
      if (disposed) return;
      probes = [];
    },
    hasPendingProbes: () => probes.length > 0,
    canSettle(expectedKey) {
      return !disposed && busy && probes.length === 0 && queuedKey == null && key === expectedKey;
    },
    settle() {
      if (disposed || probes.length > 0) return false;
      if (queuedKey != null) {
        key = queuedKey;
        queuedKey = null;
        busy = true;
        return false;
      }
      busy = false;
      notify();
      return true;
    },
    dispose() {
      disposed = true;
      probes = [];
      queuedKey = null;
      listeners.clear();
    },
  };
}
