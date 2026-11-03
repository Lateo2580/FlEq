import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationSettings } from "../../src/cli/notification-gate";
import { notificationSettingsFrom } from "../../src/cli/repl";
import { checkSettings } from "../../src/cli/settings";
import { at, harness } from "./terminal-fixture";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at(21, 3, 0)); });
afterEach(() => { vi.useRealTimers(); });

const RULE = "━".repeat(80);
const lostBand = (time: string): string => `━ 回線が切れました ${"━".repeat(80 - 16 - 6 - 8)} ${time} ━`;
// 時刻 ms まで 1 秒ごとの読みを進める（読みは attach の時刻から 1 秒ごと）。
const until = (ms: number) => { vi.advanceTimersByTime(ms - Date.now()); };

describe("P3-TO-T10 回線（spec §6.1、AC10）", () => {
  it("切れた行・戻った行・通知を出し、30 分で 3 回目は「回線が不安定です」、その後は 30 分繋がるまで通知しない", async () => {
    const h = harness();
    h.attach();
    until(at(21, 3, 39));
    h.set({ connection: "disconnected", lostConnections: 1, lastLossFrameWallMs: at(21, 3, 12), lastFrameWallMs: at(21, 3, 12) });
    until(at(21, 3, 40));
    expect(h.lines).toEqual([lostBand("21:03:40"), "21:03:12 から受信できていません。自動で繋ぎ直しています。", RULE]);
    expect(h.notices).toEqual(["回線が切れました（21:03:12 から受信できていません）"]);
    until(at(21, 6, 1));
    h.set({ connection: "connected", lastFrameWallMs: at(21, 6, 1) });
    until(at(21, 6, 2));
    // 戻った 3 行（作者裁定 2026-11-03）。
    expect(h.lines.slice(3)).toEqual([`━ 回線が戻りました ${"━".repeat(80 - 16 - 3)}`, "21:03:12 から 21:06:02 まで（2 分 50 秒）受信できていませんでした", RULE]);

    // 2 回目と 3 回目（30 分の中）。3 回目の通知はまとめの文。
    for (const [minute, count] of [[10, 2], [15, 3]] as const) {
      h.set({ connection: "disconnected", lostConnections: count, lastLossFrameWallMs: at(21, minute, 0) });
      until(at(21, minute, 5));
      h.set({ connection: "connected" });
      until(at(21, minute, 10));
    }
    expect(h.notices.slice(1)).toEqual(["回線が切れました（21:10:00 から受信できていません）", "回線が不安定です（30 分で 3 回切れました）"]);
    // 29 分の中の 4 回目は通知なし、端末の行はあり。
    h.set({ connection: "disconnected", lostConnections: 4, lastLossFrameWallMs: at(21, 40, 0) });
    until(at(21, 40, 5));
    expect(h.notices).toHaveLength(3);
    expect(h.lines.at(-2)).toBe("21:40:00 から受信できていません。自動で繋ぎ直しています。");
    // 30 分続けて繋がった後の切断は、また通知する。
    h.set({ connection: "connected" });
    until(at(22, 10, 10));
    h.set({ connection: "disconnected", lostConnections: 5, lastLossFrameWallMs: at(22, 10, 10) });
    until(at(22, 10, 15));
    expect(h.notices.slice(3)).toEqual(["回線が切れました（22:10:10 から受信できていません）"]);
    await h.output.close();
  });

  it("読みの間に切れて retry で繋がり直しても、時刻は切断の時点で固めた最後の受信", async () => {
    const h = harness();
    h.attach();
    until(at(21, 3, 12));
    // 読みの直後に切断（21:03:12 で固まる）→ 次の読みの前に繋がり直して lastFrameWallMs が進む。
    h.set({ lostConnections: 1, lastLossFrameWallMs: at(21, 3, 12), lastFrameWallMs: at(21, 3, 13) });
    until(at(21, 3, 13));
    expect(h.lines.slice(0, 3)).toEqual([lostBand("21:03:13"), "21:03:12 から受信できていません。自動で繋ぎ直しています。", RULE]);
    expect(h.notices).toEqual(["回線が切れました（21:03:12 から受信できていません）"]);
    await h.output.close();
  });

  it("分野 connection の key が無い間は通知し、mute の間は rules の有無によらず通知しない", async () => {
    const settings: NotificationSettings = { notify: {}, sound: true, mute: null, version: 0 };
    const h = harness({ notification: settings });
    h.attach();
    const lose = (count: number, minute: number) => {
      h.set({ connection: "disconnected", lostConnections: count, lastLossFrameWallMs: at(21, minute, 0) });
      until(at(21, minute, 5));
      h.set({ connection: "connected" });
      until(at(21, minute, 10));
    };
    lose(1, 4);
    settings.mute = { endsAtMonotonicMs: null, until: null, rules: [] };
    lose(2, 5);
    settings.mute = { endsAtMonotonicMs: null, until: null, rules: [{ category: "earthquake", level: "warning" }] };
    // 30 分の中の 3 回目でも mute なら通知しない（まとめの文も出さない）。
    lose(3, 6);
    expect(h.notices).toEqual(["回線が切れました（21:04:00 から受信できていません）"]);
    await h.output.close();
  });
});

describe("P3-TO-T11 一度も繋がらない（H29、AC10 (5)）", () => {
  it("理由が変わったときだけ 1 回ずつ出し、5 種の文は spec の表の字", async () => {
    const h = harness({}, { connection: "connecting" });
    h.attach();
    for (const reason of ["network", "network", "authRejected"] as const) {
      h.set({ lastFailure: reason });
      vi.advanceTimersByTime(1_000);
    }
    // 文は spec の表の字（80 桁で折り返して 2 字下げ、AC04 (5)）。続く行を繋いで比べる。
    const joined = () => h.lines.join("\n").replace(/\n {2}/g, "").split("\n");
    expect(joined()).toEqual([
      "dmdata.jp に繋がりません。ネットワークの接続を確かめてください。繋がるまで自動で試し続けます。",
      "API キーが dmdata.jp に受け付けられませんでした。fleq init か fleq config set apiKey <key> で設定し直してください。",
    ]);
    for (const reason of ["capacity", "dmdata", "startUncertain"] as const) {
      h.set({ lastFailure: reason });
      vi.advanceTimersByTime(1_000);
    }
    expect(joined().slice(2)).toEqual([
      "この API キーで開ける接続の数が上限に達しています。ほかのパソコンなどで動いている FlEq を止めるか、dmdata.jp の契約の接続数を確かめてください。",
      "dmdata.jp が接続を受け付けませんでした。しばらくしてから自動で繋ぎ直します。",
      "接続を始められたか確かめられませんでした。自動で繋ぎ直します。",
    ]);
    // 最初に受信したら以後出さない。
    h.set({ lastFrameWallMs: Date.now(), lastFailure: "network" });
    vi.advanceTimersByTime(1_000);
    expect(joined()).toHaveLength(5);
    await h.output.close();
  });
});

// P3-CLI-T20 contractBoundary (P3-CLI-AC24): 設定の読み戻しから端末の判定までの経路。保存の側は T16 (j)。
describe("P3-CLI-T20 分野 connection の設定", () => {
  it("設定ファイルの notify.connection が false なら切断の行だけを出して通知せず、欄が無ければ通知する", async () => {
    expect(checkSettings({ notify: { connection: "x" } }).ok).toBe(false);
    for (const [notify, notices] of [[{ connection: false }, 0], [{}, 1]] as const) {
      const checked = checkSettings({ notify });
      if (!checked.ok) throw new Error(checked.reason);
      vi.setSystemTime(at(21, 3, 0));
      const h = harness({ notification: notificationSettingsFrom(checked.settings, () => ({ wallTimeMs: Date.now(), monotonicMs: Date.now() })) });
      h.attach();
      h.set({ connection: "disconnected", lostConnections: 1, lastLossFrameWallMs: at(21, 3, 0) });
      until(at(21, 3, 5));
      expect(h.lines).toContain("21:03:00 から受信できていません。自動で繋ぎ直しています。");
      expect(h.notices).toHaveLength(notices);
      await h.output.close();
    }
  });
});
