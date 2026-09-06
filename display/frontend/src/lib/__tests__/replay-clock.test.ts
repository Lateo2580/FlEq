import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClock } from "../clock.svelte";

afterEach(() => vi.useRealTimers());

describe("Phase 1 replay clock handoff", () => {
  it("wall-clock mode への反復 null 設定は時刻も object identity も変えない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
    const clock = createClock();
    const initial = clock.now;
    vi.advanceTimersByTime(500);
    clock.setReplayNow(null);
    clock.setReplayNow(undefined);
    expect(clock.now).toBe(initial);
    expect(clock.now.toISOString()).toBe("2040-01-01T00:00:00.000Z");
    clock.stop();
  });

  it("server replay clock は host wall clock tick に影響されず、更新時だけ進む", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
    const clock = createClock();
    clock.setReplayNow("2026-08-26T17:58:00.000Z");
    vi.advanceTimersByTime(60_000);
    expect(clock.now.toISOString()).toBe("2026-08-26T17:58:00.000Z");

    clock.setReplayNow("2026-08-26T18:08:00.000Z");
    expect(clock.now.toISOString()).toBe("2026-08-26T18:08:00.000Z");
    clock.setReplayNow(null);
    expect(clock.now.toISOString()).toBe("2040-01-01T00:01:00.000Z");
    clock.stop();
  });

  it("App は snapshot の replay clock を business clock へ配線する", () => {
    const source = readFileSync(resolve("frontend/src/App.svelte"), "utf8");
    expect(source).toContain('const replayClock = connection.state.snapshot?.clock;');
    expect(source).toContain('clock.setReplayNow(replayClock?.mode === "replay" ? replayClock.now : null);');
  });
});
