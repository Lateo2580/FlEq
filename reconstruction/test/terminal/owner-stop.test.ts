import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { NotificationSettings } from "../../src/cli/notification-gate";
import { width } from "../../src/terminal/format";
import { at, harness } from "./terminal-fixture";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at(21, 12, 0)); });
afterEach(() => { vi.useRealTimers(); });

const until = (ms: number) => { vi.advanceTimersByTime(ms - Date.now()); };
const TITLE = "緊急地震速報などの処理が止まりました";
const BAND = [`━ ${TITLE} ${"━".repeat(80 - width(TITLE) - 3)}`, "21:12:00 から、緊急地震速報・津波・南海トラフ・火山の情報を処理していません。",
  "FlEq を起動し直してください。", "━".repeat(80)];
const WAV = "reconstruction/assets/sounds/weather-warning.wav";

// P3-OSN-T02 受入（P3-OSN-AC02 (1)〜(3)）: 帯はいつも出し、desktop と音は mute（条件に eew の無いもの）と sound off で止める。
it("P3-OSN-T02 acceptance / AC02: the owner-stop band always, desktop and sound once unless muted without an eew rule, sound off keeps only the desktop", async () => {
  const stopped = async (mute: NotificationSettings["mute"], sound: boolean) => {
    const sounds: string[] = [];
    const h = harness({ notification: { notify: {}, sound, mute, version: 0 }, sound: async (asset) => { sounds.push(asset); } });
    h.output.sink.ownerStopped(at(21, 12, 0));
    until(at(21, 12, 1));
    await h.output.close();
    return { lines: h.lines, notices: h.notices, sounds };
  };
  const loud = await stopped(null, true);
  expect(loud).toEqual({ lines: BAND, notices: ["緊急地震速報などの処理が止まりました。FlEq を起動し直してください。"], sounds: [WAV] });
  expect(await stopped({ endsAtMonotonicMs: null, until: null, rules: [] }, true)).toEqual({ lines: BAND, notices: [], sounds: [] });
  const eewRule = await stopped({ endsAtMonotonicMs: null, until: null, rules: [{ category: "eew", level: "warning" }] }, true);
  expect([eewRule.notices.length, eewRule.sounds.length]).toEqual([1, 1]);
  const soundOff = await stopped(null, false);
  expect([soundOff.notices.length, soundOff.sounds.length]).toEqual([1, 0]);
});
