export function createClock(): {
  readonly now: Date;
  setReplayNow(value: string | null | undefined): void;
  stop(): void;
} {
  let now = $state(new Date());
  let replayNow = $state<Date | null>(null);
  const id = setInterval(() => {
    if (replayNow == null) now = new Date();
  }, 1000);

  return {
    get now() {
      return replayNow ?? now;
    },
    setReplayNow(value): void {
      if (value == null) {
        if (replayNow == null) return;
        replayNow = null;
        now = new Date();
        return;
      }
      const parsed = new Date(value);
      if (!Number.isFinite(parsed.getTime())) return;
      replayNow = parsed;
    },
    stop(): void {
      clearInterval(id);
    },
  };
}
