import { afterEach, describe, expect, it, vi } from "vitest";

import { harness } from "./terminal-fixture";

afterEach(() => { vi.useRealTimers(); });

const BANNER = ["", "fleq-next v4.1.0 — Project DM-D.S.S リアルタイム地震・津波情報モニター", ""];
const startup = (classifications: readonly string[] | null) => ({ appName: "fleq-next", version: "4.1.0", testMode: "no", classifications });

// P3-TL7-T04（受入条件 P3-TL7-AC04、spec §6.7 の図）
describe("P3-TL7-T04 起動画面", () => {
  it("帯は作った時に出し、区分の行は start の区分が読めた最初の確立で 1 回だけ出す。繋ぎ直しでは出さない", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 8, 7, 0, 0));
    const h = harness({ startup: startup(["telegram.earthquake", "eew.forecast", "telegram.volcano", "eew.warning"]) }, { socketId: null });
    expect(h.lines).toEqual(BANNER);
    h.attach();
    expect(h.lines).toEqual(BANNER);
    h.set({ socketId: 12345, classifications: ["eew.forecast", "eew.warning"] });
    vi.advanceTimersByTime(1_000);
    const session = [
      "telegram.earthquake は未契約のため受信できません", "telegram.volcano は未契約のため受信できません",
      "セッション開始: socketId=12345", "区分: [eew.forecast, eew.warning]", "テスト電文: no", "リアルタイム受信中...",
      "help でコマンド一覧を表示（終了は quit か Ctrl+C）"];
    expect(h.lines).toEqual([...BANNER, ...session]);
    h.set({ connection: "disconnected", lostConnections: 1, lastLossFrameWallMs: Date.now() });
    vi.advanceTimersByTime(1_000);
    h.set({ connection: "connected", socketId: 12346 });
    vi.advanceTimersByTime(1_000);
    expect(h.lines.filter((line) => line.startsWith("セッション開始"))).toEqual(["セッション開始: socketId=12345"]);
    expect(h.lines.some((line) => line.startsWith("━ 回線が戻りました"))).toBe(true);
    await h.output.close();
  });
  it("端末なら帯の前に端末の題名を付け、close で空に戻す（端末でなければ付けない、上の試験の BANNER）", async () => {
    const saved = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true, writable: true });
    try {
      const h = harness({ startup: startup(null) });
      await h.output.close();
      const text = h.lines.join("\n"), set = text.indexOf("\x1b]2;fleq-next v4.1.0\x07"), reset = text.lastIndexOf("\x1b]2;\x07");
      expect([set >= 0 && set < text.indexOf(BANNER[1]), reset > text.indexOf(BANNER[1])]).toEqual([true, true]);
    } finally {
      if (saved == null) Reflect.deleteProperty(process.stdout, "isTTY"); else Object.defineProperty(process.stdout, "isTTY", saved);
    }
  });
  it("偽の dmdata（classifications が null）は帯だけで、区分の行を出さない", async () => {
    const h = harness({ startup: startup(null) }, { classifications: ["eew.forecast"] });
    h.attach();
    expect(h.lines).toEqual(BANNER);
    await h.output.close();
  });
});
