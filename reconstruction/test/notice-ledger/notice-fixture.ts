import { expect } from "vitest";

import type { ClockReading, NoticeMark, NotificationIntent } from "../../contracts/p2-shared-runtime.types";

// P3-NL-AC08 (1)(4)・AC15 (4) の unit ごとの行。started の pending は復元で外れて鳴らず（印の証拠は unknown、notificationOutcomeUnknown）、
// failed・null の pending は欄（lastAttempt・replayed・延ばした期限）ごと戻る。intents の先頭は外れる側、2 件目は戻る側（sound なら鳴らし直し済み）。
export function expectRestoreStarted<S extends Readonly<{ intents: readonly NotificationIntent[] }>, I extends NotificationIntent>(rows: Readonly<{
  intents: readonly [I, I];
  make: (intents: readonly I[]) => S;
  restore: (state: S, clock: ClockReading) => Readonly<{ state: S; diagnostics: readonly Readonly<{ reason: string }>[] }>;
  markOf?: (state: S, subject: string) => NoticeMark | undefined;
}>): void {
  const [first, second] = rows.intents;
  const clock = { wallTimeMs: first.createdAt + 1, monotonicMs: 1 };
  const started: I = { ...first, attempts: 1, lastAttempt: "started" };
  const failed: I = { ...second, attempts: 1, lastAttempt: "failed", replayed: second.channel === "sound",
    expiresAt: second.channel === "sound" ? 2 * second.expiresAt - second.createdAt : second.expiresAt };
  const restored = rows.restore(rows.make([started, failed]), clock);
  expect(restored.state.intents).toEqual([failed]);
  expect(restored.diagnostics).toContainEqual(expect.objectContaining({ reason: "notificationOutcomeUnknown", count: 1 }));
  if (rows.markOf != null) expect(rows.markOf(restored.state, first.subject)?.evidence).toBe("unknown");
  expect(rows.restore(rows.make([first]), clock).state.intents).toEqual([first]);
}

// P3-NL-AC15 (2): 静的上界の試験に置く最長の通知の印（種類 3 つ・unattempted、印 1 件の上界 noticeMarkBytes と同じ形）。
export const LONGEST_NOTICE = { version: "0".repeat(16), kinds: ["report", "cancel", "expiry"], evidence: "unattempted" } as const;
