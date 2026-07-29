import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DailyQuakeCounter } from "../../../src/engine/messages/daily-quake-counter";
import { DailyQuakePersistence } from "../../../src/engine/messages/daily-quake-persistence";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

const T0 = Date.parse("2026-07-29T12:00:00+09:00");
const dirs: string[] = [];

function filePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-daily-quake-"));
  dirs.push(dir);
  return path.join(dir, "daily-quake-v1.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function event(overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  return {
    id: "id", classification: "telegram.earthquake", domain: "earthquake", type: "VXSE51",
    infoType: "発表", title: "震源・震度に関する情報", headline: null,
    reportDateTime: new Date(T0).toISOString(), publishingOffice: "気象庁", isTest: false,
    frameLevel: "warning", isCancellation: false, eventId: "Q1", maxInt: "4",
    originTime: new Date(T0).toISOString(), hypocenterName: "東京湾", magnitude: "4.0", depth: "30km",
    tsunamiWarning: false, areaItems: [], ...overrides,
  } as PresentationEvent;
}

function addQuake(counter: DailyQuakeCounter, e = event(), nowMs = T0): void {
  counter.record(e, nowMs);
  counter.recordRecentQuake({
    eventId: e.eventId ?? null, reportDateTime: e.reportDateTime, originTime: e.originTime ?? null,
    hypocenterName: e.hypocenterName ?? null, magnitude: e.magnitude ?? null, maxInt: e.maxInt ?? null,
    maxIntRank: 4, depth: e.depth ?? null, tsunamiWarning: false, intensityGroups: [],
  }, nowMs);
}

describe("DailyQuakePersistence", () => {
  it("同日 restore で counter と表示 DTO 5件履歴を一体で復元する", () => {
    const file = filePath();
    const source = new DailyQuakeCounter(T0);
    for (let i = 0; i < 6; i += 1) {
      addQuake(source, event({ eventId: `Q${i}`, reportDateTime: new Date(T0 + i).toISOString(), originTime: new Date(T0 + i).toISOString() }));
    }
    new DailyQuakePersistence(file).save(source.export(), T0 + 10);

    const loaded = new DailyQuakePersistence(file).load(T0 + 20);
    const restored = new DailyQuakeCounter(T0 + 20);
    expect(loaded == null ? false : restored.restore(loaded, T0 + 20)).toBe(true);
    expect(restored.getSnapshot(T0 + 20)).toMatchObject({ todayQuakeCount: 6, todayMaxInt: "4" });
    expect(restored.getRecentQuakes(T0 + 20).map((q) => q.eventId)).toEqual(["Q5", "Q4", "Q3", "Q2", "Q1"]);
  });

  it("JST 00:00 sweep は空の当日状態にし、前日ファイルは restore しない", () => {
    const file = filePath();
    const before = Date.parse("2026-07-29T23:59:00+09:00");
    const midnight = Date.parse("2026-07-30T00:00:00+09:00");
    const counter = new DailyQuakeCounter(before);
    addQuake(counter, event({ originTime: new Date(before).toISOString(), reportDateTime: new Date(before).toISOString() }), before);
    const persistence = new DailyQuakePersistence(file);
    persistence.save(counter.export(), before);
    expect(counter.sweep(midnight)).toBe(true);
    persistence.save(counter.export(), midnight);
    const loaded = persistence.load(midnight + 1);
    const restored = new DailyQuakeCounter(midnight + 1);
    expect(loaded == null ? false : restored.restore(loaded, midnight + 1)).toBe(true);
    expect(restored.getSnapshot(midnight + 1).todayQuakeCount).toBe(0);
    expect(restored.getRecentQuakes(midnight + 1)).toEqual([]);
  });

  it("深夜の続報は履歴外でも eventId 単位カウンタを維持し、同一 eventId は二重計上しない", () => {
    const now = Date.parse("2026-07-30T00:05:00+09:00");
    const counter = new DailyQuakeCounter(now);
    const late = event({ eventId: "Q1", originTime: "2026-07-29T23:58:00+09:00", reportDateTime: new Date(now).toISOString() });
    counter.record(late, now);
    counter.recordRecentQuake({ eventId: "Q1", reportDateTime: late.reportDateTime, originTime: late.originTime ?? null, hypocenterName: null, magnitude: null, maxInt: "4", maxIntRank: 4, depth: null, tsunamiWarning: false }, now);
    counter.record({ ...late, maxInt: "5弱" }, now + 1);
    expect(counter.getSnapshot(now + 1)).toMatchObject({ todayQuakeCount: 1, todayMaxInt: "5弱" });
    expect(counter.getRecentQuakes(now + 1)).toEqual([]);
  });

  it("破損・未知 version・未来日時は warn して空開始へ縮退する", () => {
    const file = filePath();
    const persistence = new DailyQuakePersistence(file);
    const warn = vi.spyOn(console, "log").mockImplementation(() => undefined);
    fs.writeFileSync(file, "{broken", "utf8");
    expect(persistence.load(T0)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 99, savedAt: new Date(T0).toISOString(), state: {} }), "utf8");
    expect(persistence.load(T0)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 1, savedAt: new Date(T0 + 1).toISOString(), state: {} }), "utf8");
    expect(persistence.load(T0)).toBeNull();
    const counter = new DailyQuakeCounter(T0);
    addQuake(counter);
    const futureState = counter.export();
    futureState.recentQuakes[0] = { ...futureState.recentQuakes[0]!, originTime: new Date(T0 + 1).toISOString() };
    fs.writeFileSync(file, JSON.stringify({ version: 1, savedAt: new Date(T0).toISOString(), state: futureState }), "utf8");
    expect(persistence.load(T0)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it.each([
    ["count より EventID 集合が大きい", { count: 0, countedEventIds: ["Q1"] }],
    ["EventID 配列に重複がある", { count: 1, countedEventIds: ["Q1", "Q1"] }],
    ["maxInt=null なのに rank が残る", { count: 1, maxInt: null, maxIntRank: 4 }],
    ["maxInt と rank が一致しない", { count: 1, maxInt: "4", maxIntRank: 3 }],
    ["count=0 なのに最大震度が残る", { count: 0, maxInt: "4", maxIntRank: 4 }],
  ])("クロスフィールド破損 (%s) は受理しない", (_label, patch) => {
    const file = filePath();
    const state = {
      ...new DailyQuakeCounter(T0).export(),
      ...patch,
    };
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      savedAt: new Date(T0).toISOString(),
      state,
    }), "utf8");

    expect(new DailyQuakePersistence(file).load(T0)).toBeNull();
  });

  it("debounce は最新状態だけを書き、shutdown 相当の dispose + save は予約を上書きする", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const file = filePath();
    const persistence = new DailyQuakePersistence(file, 100);
    const first = new DailyQuakeCounter(T0);
    const latest = new DailyQuakeCounter(T0);
    addQuake(first);
    addQuake(latest);
    addQuake(latest, event({ eventId: "Q2" }));
    persistence.schedule(first.export(), T0);
    persistence.schedule(latest.export(), T0 + 1);
    vi.advanceTimersByTime(100);
    expect(new DailyQuakePersistence(file).load(T0 + 200)?.count).toBe(2);
    persistence.schedule(first.export(), T0 + 201);
    persistence.dispose();
    persistence.save(latest.export(), T0 + 202);
    vi.advanceTimersByTime(100);
    expect(new DailyQuakePersistence(file).load(T0 + 300)?.count).toBe(2);
  });
});
