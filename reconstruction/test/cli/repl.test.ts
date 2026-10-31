import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationAttempt } from "../../contracts/p2-notification-delivery.types";
import type { ClockReading, UnitId } from "../../contracts/p2-shared-runtime.types";
import type { HostCommandPort, HostStatus, LegacyNotifyCategory, ReplCommand } from "../../contracts/p3-cli-repl.types";
import { categoryOf, createNotificationGate } from "../../src/cli/notification-gate";
import type { NotificationSettings } from "../../src/cli/notification-gate";
import { notificationSettingsFrom, parseReplLine, runRepl } from "../../src/cli/repl";
import { checkSettings } from "../../src/cli/settings";

// readline は行と close を試験から起こす fake（REPL が使うのは on・setPrompt・prompt・close だけ）。
type FakeReadline = { line(text: string): void; close(): void };
const mocks = vi.hoisted(() => ({ readline: null as FakeReadline | null }));
vi.mock("node:readline", () => ({
  createInterface: () => {
    const handlers: Record<string, ((text: string) => void)[]> = {};
    let closed = false;
    const fake = {
      on: (event: string, handler: (text: string) => void) => { (handlers[event] ??= []).push(handler); return fake; },
      setPrompt: () => {}, prompt: () => {},
      close: () => { if (closed) return; closed = true; for (const handler of handlers.close ?? []) handler(""); },
      line: (text: string) => { for (const handler of handlers.line ?? []) handler(text); },
    };
    mocks.readline = fake;
    return fake;
  },
}));

let tmp = "";
let stdout = "";
const configFile = () => join(tmp, "fleq-next", "config.json");
const readConfig = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), "utf8"));
const writeConfig = (value: unknown) => { mkdirSync(join(tmp, "fleq-next"), { recursive: true }); writeFileSync(configFile(), JSON.stringify(value)); };
const turn = () => new Promise((done) => setImmediate(done));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fleq-repl-"));
  vi.stubEnv("XDG_CONFIG_HOME", tmp);
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

const attempt = (unit: UnitId, subject: string, level: string, channel: "desktop" | "sound" = "desktop"): NotificationAttempt => ({
  attemptId: "attempt-1", intentId: "intent-1", unit, subject, operation: "normal", channel, priorityGroup: "other", payload: { level },
  soundAsset: null, selectedAtMonotonicMs: 0, timeoutAtMonotonicMs: 0, expiresAt: 0,
});
const quake = (level: string) => attempt("U-Q", "normal/VXSE53/20240613000000", level);
const fakeClock = () => {
  const now = { wallTimeMs: Date.now(), monotonicMs: 1_000_000 };
  return { now, clock: (): ClockReading => ({ ...now }), advance: (ms: number) => { now.wallTimeMs += ms; now.monotonicMs += ms; } };
};
const settingsOf = (notify: NotificationSettings["notify"] = {}): NotificationSettings => ({ notify, sound: true, mute: null, version: 0 });
const fakeHost = (status: Partial<HostStatus> = {}) => {
  const port = {
    displayPort: null, stop: vi.fn(), reconnect: vi.fn((): ReturnType<HostCommandPort["reconnect"]> => "connected"),
    openDisplay: vi.fn(async (): Promise<Awaited<ReturnType<HostCommandPort["openDisplay"]>>> => ({ kind: "portInUse" })),
    closeDisplay: vi.fn(async (): Promise<"closed" | "notOpen"> => "notOpen"),
    status: vi.fn((): HostStatus => ({ connection: "connected", socketId: 77, failedAttempts: 0, display: null, ...status })),
  };
  return port;
};
// 1 行を流し、REPL がその行を捌き終えるまで待つ（行は届いた順に 1 つずつ、AC12 (5)）。
async function type(...lines: string[]): Promise<void> {
  for (const line of lines) mocks.readline!.line(line);
  for (let index = 0; index < 20; index++) await turn();
}

describe("P3-CLI-REPL-001 発注 2 の REPL と通知の門", () => {
  // P3-CLI-T08 acceptance (AC12)
  it("12 入口の各形が期待の typed command になる", () => {
    const cases: [string, ReplCommand][] = [
      ["help", { kind: "help", topic: null, sub: null }], ["help notify", { kind: "help", topic: "notify", sub: null }],
      ["help mute", { kind: "help", topic: "mute", sub: null }], ["?", { kind: "help", topic: null, sub: null }],
      ["commands", { kind: "commands", query: null }], ["commands settings", { kind: "commands", query: "settings" }], ["cmds", { kind: "commands", query: null }],
      ["status", { kind: "status" }], ["stat", { kind: "status" }], ["config", { kind: "config" }],
      ["notify", { kind: "notify", action: { kind: "show" } }], ["notify all:on", { kind: "notify", action: { kind: "all", enabled: true } }],
      ["notify aoff", { kind: "notify", action: { kind: "all", enabled: false } }],
      ["notify eq off", { kind: "notify", action: { kind: "category", category: "earthquake", enabled: false } }],
      ["notify EEW", { kind: "notify", action: { kind: "category", category: "eew", enabled: "toggle" } }],
      ["sound", { kind: "sound", enabled: null }], ["snd on", { kind: "sound", enabled: true }],
      ["mute", { kind: "mute", action: { kind: "on", durationMs: null, rules: [] } }],
      ["mute 30m", { kind: "mute", action: { kind: "on", durationMs: 1_800_000, rules: [] } }], ["mute off", { kind: "mute", action: { kind: "off" } }],
      ["mute earthquake:warning", { kind: "mute", action: { kind: "on", durationMs: null, rules: [{ category: "earthquake", level: "warning" }] } }],
      ["mute 1h earthquake:warning,eew:critical,earthquake:warning", { kind: "mute", action: { kind: "on", durationMs: 3_600_000,
        rules: [{ category: "earthquake", level: "warning" }, { category: "eew", level: "critical" }] } }],
      ["retry", { kind: "retry" }], ["display", { kind: "display", action: "status" }], ["display on", { kind: "display", action: "on" }],
      ["quit", { kind: "quit" }], ["exit", { kind: "quit" }],
    ];
    for (const [line, expected] of cases) expect(parseReplLine(line), line).toEqual({ kind: "command", command: expected });
    expect(parseReplLine("   ")).toEqual({ kind: "empty" });
  });

  // P3-CLI-T09 contractBoundary (AC12)
  it("変えられない行は旧築の文の 1 行だけを出し、port も通知の設定も設定ファイルも変えない", async () => {
    writeConfig({ apiKey: "k0" });
    const before = readFileSync(configFile());
    const host = fakeHost();
    const settings = settingsOf();
    const { clock } = fakeClock();
    const repl = runRepl({ host, settings, savedMute: undefined, displayPort: 7789, clock, onClose: () => {} });
    const lines: [string, string][] = [
      ["hlep", "  不明なコマンド: hlep — もしかして: help"], ["foo", "  不明なコマンド: foo (help で一覧を表示)"],
      ["notify bogus", "  不明なカテゴリ: bogus (有効: eew, earthquake, tsunami, seismicText, nankaiTrough, lgObservation, volcano, weather, tornado, briefing, earlyWeather, weatherWarningTimeseries, climateInfo, weatherExplanation, heatAlert, typhoonAnalysis, typhoonProbability, floodForecast)"],
      ["notify eew maybe", "  使い方: notify <category> [on|off] / notify all:on / notify all:off"], ["sound loud", "  on または off を指定してください。"],
      ["mute 0m", "  無効な時間指定です。例: 30m, 1h, 90s"], ["mute 5x", "  無効な時間指定です。例: 30m, 1h, 90s"], ["mute 24h1", "  無効な時間指定です。例: 30m, 1h, 90s"],
      ["mute 86401s", "  ミュートは 24 時間（24h・1440m・86400s）までです。"], [`mute ${"9".repeat(309)}s`, "  ミュートは 24 時間（24h・1440m・86400s）までです。"],
      ...["mute eew:loud", "mute bogus:critical", "mute earthquake:warning 1h", "mute 1h eew:critical extra"].map((line): [string, string] =>
        [line, "  使い方: mute / mute <時間> / mute [<時間>] <category>:<normal|warning|critical>[,...] / mute off（時間の例: 30m, 1h, 90s）"]),
      ["display foo", "  使い方: display / display on / display off"],
    ];
    for (const [line, message] of lines) {
      stdout = "";
      await type(line);
      expect(stdout, line).toBe(`${message}\n`);
    }
    await repl.idle();
    for (const call of [host.stop, host.reconnect, host.openDisplay, host.closeDisplay, host.status]) expect(call).not.toHaveBeenCalled();
    expect(settings).toEqual(settingsOf());
    expect(readFileSync(configFile()).equals(before)).toBe(true);
    repl.close();
    for (const line of ["mute 24h", "mute 86400s"]) expect(parseReplLine(line)).toEqual({ kind: "command", command: { kind: "mute", action: { kind: "on", durationMs: 86_400_000, rules: [] } } });
  });

  // P3-CLI-T10 contractBoundary (AC13)
  it("門は分野の表・sound・分野・mute の順で決め、条件は分野の off と sound off を越えない", () => {
    const { clock, advance } = fakeClock();
    // (a) 分野の表: 各 domain の subject の書式どおりの試行 1 つずつ
    const rows: [NotificationAttempt, LegacyNotifyCategory][] = [
      [attempt("U-E", "normal/eew/20240613000000", "critical"), "eew"], [attempt("U-T", "normal/VTSE41/1", "warning"), "tsunami"],
      [attempt("U-N", "normal/VYSE50/1", "warning"), "nankaiTrough"], [attempt("U-V", "normal/VFVO50/1", "warning"), "volcano"],
      [attempt("U-L", "normal/VPWW56/1", "warning"), "weather"], [attempt("U-R", "normal/VXKO50/1", "warning"), "floodForecast"],
      [attempt("U-W", "normal/VPWW54/1", "warning"), "weather"], [attempt("U-F", "normal/VPWW54/1", "warning"), "weatherWarningTimeseries"],
      [quake("normal"), "earthquake"], [attempt("U-Q", "normal/VXSE62/20240613000000", "normal"), "lgObservation"],
      [attempt("U-Q", "normal/capacityRejected", "normal"), "earthquake"],
      [attempt("U-M", "normal/tornado/宇都宮地方気象台/竜巻注意情報", "warning"), "tornado"], [attempt("U-M", "normal/VPAW51/090000/早期天候情報", "normal"), "earlyWeather"],
      [attempt("U-M", "normal/VPFT50/20240613", "normal"), "heatAlert"], [attempt("U-M", "normal/VXSE56/20240613", "normal"), "seismicText"],
      [attempt("U-M", "normal/VPZI50/20240613", "normal"), "climateInfo"], [attempt("U-M", "normal/VPCJ51/20240613", "normal"), "weatherExplanation"],
      [attempt("U-Y", "normal/typhoonAnalysis/TC2401", "normal"), "typhoonAnalysis"], [attempt("U-Y", "normal/typhoonProbability/TC2401", "normal"), "typhoonProbability"],
      [attempt("U-B", "normal/VPBS50/20240613", "normal"), "briefing"], [attempt("U-B", "normal/VPOA50/20240613_1", "warning"), "weather"],
    ];
    for (const [tried, category] of rows) {
      expect(categoryOf(tried), tried.subject).toBe(category);
      expect(createNotificationGate(settingsOf({ [category]: false }), clock)(tried).allow, tried.subject).toBe(false);
      expect(createNotificationGate(settingsOf({ [category]: true }), clock)(tried).allow, tried.subject).toBe(true);
    }
    const allOff = settingsOf(Object.fromEntries(rows.map(([, category]) => [category, false])));
    expect(createNotificationGate(allOff, clock)(attempt("U-M", "normal/VXXX99/1", "normal")).allow).toBe(true);
    // (b) 順
    const settings = settingsOf();
    const gate = createNotificationGate(settings, clock);
    settings.sound = false;
    expect(gate(attempt("U-Q", "normal/VXSE53/1", "critical", "sound"))).toEqual({ allow: false, stage: "sound", settingsVersion: 0 });
    expect(gate(quake("critical")).allow).toBe(true);
    settings.sound = true;
    settings.notify.earthquake = false;
    settings.version = 4;
    expect(gate(quake("critical"))).toEqual({ allow: false, stage: "category", settingsVersion: 4 });
    delete settings.notify.earthquake;
    settings.mute = { endsAtMonotonicMs: clock().monotonicMs + 60_000, until: null, rules: [] };
    expect([gate(quake("critical")), gate(attempt("U-E", "normal/eew/1", "critical"))].map((verdict) => verdict.allow)).toEqual([false, false]);
    expect(gate(quake("critical"))).toMatchObject({ stage: "mute" });
    settings.mute = { endsAtMonotonicMs: clock().monotonicMs + 60_000, until: null, rules: [{ category: "eew", level: "critical" }, { category: "earthquake", level: "critical" }] };
    expect([quake("critical"), quake("warning"), attempt("U-T", "normal/VTSE41/1", "critical"), quake("cancel")].map((tried) => gate(tried).allow))
      .toEqual([true, false, false, false]);
    settings.notify.earthquake = false;
    expect(gate(quake("critical")).allow).toBe(false);
    delete settings.notify.earthquake;
    advance(60_000);
    expect(gate(quake("warning")).allow).toBe(true);
    settings.mute = { endsAtMonotonicMs: null, until: null, rules: [] };
    advance(30 * 86_400_000);
    expect(gate(quake("warning")).allow).toBe(false);
    // (c) weather の欄の無い設定では U-L は鳴らない（P3-CLI-D-O2-WEATHER-NOW=B）
    expect(createNotificationGate(settingsOf(), clock)(attempt("U-L", "normal/VPWW56/1", "warning")).allow).toBe(false);
  });

  // P3-CLI-T11 acceptance (AC15・AC17・AC14)
  it("mute・notify・sound は今の実行に効き、変えた欄だけを保存し、mute は起動し直しても続く", async () => {
    const { clock, advance } = fakeClock();
    const start = (settings: NotificationSettings, savedMute?: Parameters<typeof runRepl>[0]["savedMute"], host = fakeHost()) =>
      ({ repl: runRepl({ host, settings, savedMute, displayPort: 7789, clock, onClose: () => {} }), gate: createNotificationGate(settings, clock) });
    const fromFile = () => {
      const checked = checkSettings(readConfig());
      if (!checked.ok) throw new Error(checked.reason);
      return checked.settings;
    };
    // (a) mute 30m
    let { repl, gate } = start(settingsOf());
    stdout = "";
    await type("mute 30m");
    expect(stdout).toBe("  通知を 30分 ミュートしました。\n  ミュートの間は、通知も音も出ません。\n");
    expect(gate(quake("critical")).allow).toBe(false);
    // (b) 条件つきの mute と保存
    stdout = "";
    await type("mute 1h earthquake:warning");
    expect(stdout.split("\n")[1]).toBe("  ミュートの間も、次に当たる通知は鳴ります: 地震情報（警報の音以上）。");
    expect([gate(quake("warning")).allow, gate(attempt("U-T", "normal/VTSE41/1", "critical")).allow]).toEqual([true, false]);
    await repl.idle();
    const saved = readConfig().mute as { until: number; rules: unknown };
    expect(Math.abs(saved.until - (Date.now() + 3_600_000))).toBeLessThan(60_000);
    expect(saved.rules).toEqual([{ category: "earthquake", level: "warning" }]);
    repl.close();
    // (c) 続けて 2 つの変更（1 つ目の保存が終わる前に 2 つ目）: 変えた欄だけを重ね、ほかの欄を残す
    writeConfig({ region: "栃木県宇都宮市" });
    ({ repl } = start(settingsOf()));
    await type("notify eew off", "sound off");
    await repl.idle();
    expect(readConfig()).toEqual({ region: "栃木県宇都宮市", notify: { eew: false }, sound: false });
    repl.close();
    // (d) status・display on・retry の文
    const host = fakeHost({ failedAttempts: 2, connection: "disconnected" });
    ({ repl } = start(settingsOf(), undefined, host));
    stdout = "";
    await type("status", "display on", "retry");
    expect(stdout).toBe("\n  WebSocket 接続状態:\n  状態: 切断\n  SocketID: 77\n  再接続試行: #2\n\n"
      + "  情報ディスプレイのポート 7789 は使われています\n  既に接続中です。\n");
    repl.close();
    // (e) mute 1h の後に設定ファイルから起こし直しても mute のまま。時間なしの mute も同じで until は null
    for (const line of ["mute 1h", "mute"]) {
      ({ repl } = start(settingsOf()));
      await type(line);
      await repl.idle();
      repl.close();
      const file = fromFile();
      expect(file.mute?.until === null).toBe(line === "mute");
      ({ repl, gate } = start(notificationSettingsFrom(file, clock), file.mute));
      expect(gate(quake("critical")).allow).toBe(false);
      await repl.idle();
      expect(fromFile().mute).toEqual(file.mute);
      repl.close();
    }
    // (f) 終わりを過ぎた mute は解けた扱いで、起動の後に欄が消える
    writeConfig({ mute: { until: clock().wallTimeMs - 1, rules: [] } });
    ({ repl, gate } = start(notificationSettingsFrom(fromFile(), clock), fromFile().mute));
    expect(gate(quake("critical")).allow).toBe(true);
    await repl.idle();
    expect(readConfig()).toEqual({});
    repl.close();
    // (g) mute off の保存で欄が消える
    ({ repl } = start(settingsOf()));
    await type("mute 1h", "mute off");
    await repl.idle();
    expect(readConfig()).not.toHaveProperty("mute");
    repl.close();
    // (h) 読み戻しは mute の形の外を断る
    expect(checkSettings({ mute: { until: "x", rules: [] } }).ok).toBe(false);
    expect(checkSettings({ mute: { until: null, rules: [{ category: "bogus", level: "critical" }] } }).ok).toBe(false);
    // (i) mute 1h の後の mute 2h は、1 時間を過ぎても古い timer に解かれない
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    ({ repl, gate } = start(settingsOf()));
    await type("mute 1h", "mute 2h");
    advance(3_600_001);
    vi.advanceTimersByTime(3_600_001);
    expect(gate(quake("critical")).allow).toBe(false);
    await repl.idle();
    expect(Math.abs((readConfig().mute as { until: number }).until - (Date.now() + 7_200_000))).toBeLessThan(60_000);
    repl.close();
  });
});
