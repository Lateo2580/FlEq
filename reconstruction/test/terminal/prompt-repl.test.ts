import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostStatus } from "../../contracts/p3-cli-repl.types";
import { runRepl } from "../../src/cli/repl";
import type { RuntimeMirror } from "../../src/runtime/shared-runtime";
import { createRenderer } from "../../src/terminal/format";
import { createTerminalOutput } from "../../src/terminal/output";
import { world } from "./prompt-fixture";
import { inputDoneOf, reportOf } from "./terminal-fixture";

const STATUS: HostStatus = { connection: "connected", socketId: 1, failedAttempts: 0, lastFailure: null, lastFrameWallMs: null, lostConnections: 0,
  lastLossFrameWallMs: null, display: null };
const WARNING_TEXT = "南海トラフ地震臨時情報（巨大地震警戒）", ADVISORY_TEXT = "南海トラフ地震臨時情報（巨大地震注意）";
const stdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns"), stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const put = (key: "columns" | "isTTY", value: number | boolean) => { Object.defineProperty(process.stdout, key, { value, configurable: true, writable: true }); };
const restore = (key: "columns" | "isTTY", saved: PropertyDescriptor | undefined) => {
  if (saved == null) Reflect.deleteProperty(process.stdout, key); else Object.defineProperty(process.stdout, key, saved);
};
beforeEach(() => { put("columns", 56); put("isTTY", true); vi.stubEnv("NO_COLOR", "1"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); restore("columns", stdoutColumns); restore("isTTY", stdoutTty); });

// 字の違う 2 つの現況。56 桁では時計が外れるので、字は時刻で変わらない。
async function mirrors(): Promise<readonly [advisory: RuntimeMirror, warning: RuntimeMirror]> {
  const w = await world();
  await w.send("selected_xml/74_01_04_200512_VYSE50");
  const warning = w.mirror(), { view } = warning["U-N"];
  await w.close();
  if (view.unit !== "U-N" || view.currents[0].line !== "nankai") throw new Error("nankai");
  return [{ ...warning, "U-N": { ...warning["U-N"], view: { ...view, currents: [{ ...view.currents[0], status: "megaquakeAdvisory" }] } } }, warning];
}

describe("P3-TP-T12 受入条件 見送った書き直し", () => {
  it("待機する writer の間に積んだ字が画面に出た後、字が前の字へ戻っても次の 1 秒で書き直す", async () => {
    const [advisory, warning] = await mirrors();
    const before = `FlEq [● ${ADVISORY_TEXT}]> `, shown = `FlEq [● ${WARNING_TEXT}]> `;
    vi.useFakeTimers();
    const renderer = createRenderer(0), waiting: (() => void)[] = [];
    let screen = "";
    const output = createTerminalOutput({ tipInterval: 0, clock: () => ({ wallTimeMs: Date.now(), monotonicMs: Date.now() }),
      write: (batch, done) => { const text = renderer.render(batch); waiting.push(() => { screen += text; done(); }); } });
    const release = () => { while (waiting.length > 0) waiting.shift()!(); };
    output.sink.mirror(advisory);
    output.attach({ status: () => STATUS });
    const host = { displayPort: null, stop: vi.fn(), reconnect: () => "connected" as const, closeDisplay: async () => "notOpen" as const, status: () => STATUS,
      openDisplay: async () => ({ kind: "opened" as const, port: 7789 }) };
    const repl = runRepl({ host, settings: { notify: {}, sound: true, mute: null, version: 0 }, savedMute: undefined, displayPort: 7789,
      clock: () => ({ wallTimeMs: Date.now(), monotonicMs: Date.now() }), onClose: () => {}, terminal: output, control: output.control, drained: output.drained,
      initial: { summaryMinutes: 0, tipMinutes: 0, clock: "clock", eewLog: false, eewLogFields: {} } });
    release();
    expect(screen).toContain(before);
    // 書き出しの待ちの間に字が変わり、書き直しは見送られる。電文の後の入力の行が、その字を画面に書く。
    output.line("待ちの行");
    output.sink.mirror(warning);
    vi.advanceTimersByTime(1_000);
    expect(screen).not.toContain(shown);
    output.sink.inputDone(inputDoneOf("report", reportOf("32-39_11_02_250206_VTSE41.xml", "U-T")));
    release();
    expect(screen.lastIndexOf(shown)).toBeGreaterThan(screen.lastIndexOf(before));
    // 字が前の字へ戻る。written と同じ字でも、画面の字は違う。
    output.sink.mirror(advisory);
    vi.advanceTimersByTime(1_000);
    release();
    expect(screen.lastIndexOf(before)).toBeGreaterThan(screen.lastIndexOf(shown));
    repl.close();
    await output.close();
  });
});
