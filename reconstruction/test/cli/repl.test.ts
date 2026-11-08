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
    status: vi.fn((): HostStatus => ({ connection: "connected", socketId: 77, failedAttempts: 0, lastFailure: null, lastFrameWallMs: null, lostConnections: 0, display: null, lastLossFrameWallMs: null, classifications: null, ...status })),
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
      ["notify EEW", { kind: "notify", action: { kind: "category", category: "eew", enabled: null } }],
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
    const repl = runRepl({ host, settings, savedMute: undefined, displayPort: 7789, clock, onClose: () => {}, terminal: { output: process.stdout, line: (text: string) => { process.stdout.write(`${text}\n`); }, bind: () => {} }, ...terminalOptions() });
    const lines: [string, string][] = [
      ["hlep", "  不明なコマンド: hlep — もしかして: help"], ["foo", "  不明なコマンド: foo (help で一覧を表示)"],
      ["notify bogus", "  不明なカテゴリ: bogus (有効: eew, earthquake, tsunami, seismicText, nankaiTrough, lgObservation, volcano, weather, tornado, briefing, earlyWeather, weatherWarningTimeseries, climateInfo, weatherExplanation, heatAlert, typhoonAnalysis, typhoonProbability, floodForecast, connection)"],
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
    // (c) weather の欄の無い設定では U-L が鳴る（P3-CLI-D-O2-WEATHER-NOW=B の「C20 の配送で on」、P3-WN-AC10）
    expect(createNotificationGate(settingsOf(), clock)(attempt("U-L", "normal/VPWW56/1", "warning")).allow).toBe(true);
  });

  // P3-WN-T10 acceptance（P3-WEATHER-NOTICE-001 の AC10）: weather の既定 on と、記録的短時間大雨の対応報（K の VPBS50）の分野。
  it("P3-WN-T10 acceptance / AC10: weather is on by default, U-F and briefing stay off, a K VPBS50 rings as weather", () => {
    const { clock } = fakeClock();
    const weather = [attempt("U-W", "normal/VPWW55/福井地方気象台", "critical"), attempt("U-L", "normal/VPWW56/1", "warning"),
      attempt("U-B", "normal/VPOA50/JPTK202608221709_202608221709", "normal"), attempt("U-B", "normal/VPBS50/KJPTK202608221709_202608221709", "normal")];
    const off = [attempt("U-F", "normal/VPWW54/1", "warning"), attempt("U-B", "normal/VPBS50/YJPNB202608270448", "warning")];
    const allow = (settings: NotificationSettings, tried: NotificationAttempt) => createNotificationGate(settings, clock)(tried).allow;
    expect([...weather, ...off].map((tried) => allow(settingsOf(), tried))).toEqual([true, true, true, true, false, false]);
    expect(weather.map((tried) => [categoryOf(tried), allow(settingsOf({ weather: false }), tried)])).toEqual(weather.map(() => ["weather", false]));
  });

  // P3-CLI-T11 acceptance (AC15・AC17・AC14)
  it("mute・notify・sound は今の実行に効き、変えた欄だけを保存し、mute は起動し直しても続く", async () => {
    const { clock, advance } = fakeClock();
    const start = (settings: NotificationSettings, savedMute?: Parameters<typeof runRepl>[0]["savedMute"], host = fakeHost()) =>
      ({ repl: runRepl({ host, settings, savedMute, displayPort: 7789, clock, onClose: () => {}, terminal: { output: process.stdout, line: (text: string) => { process.stdout.write(`${text}\n`); }, bind: () => {} }, ...terminalOptions() }), gate: createNotificationGate(settings, clock) });
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
    expect(stdout).toBe("\n  WebSocket 接続状態:\n  状態: 切断\n  SocketID: 77\n  再接続試行: #2\n  ミュート: なし\n\n"
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

// 【発注 3】runRepl の新しい欄（AC26 (2)）。control は値を変える関数の呼び出しを記録する（promptLabel は入力の行の文字を作るだけで、T17 が見る）。
type ReplOptions = Parameters<typeof runRepl>[0];
function fakeControl() {
  const calls: unknown[][] = [];
  const control: ReplOptions["control"] = {
    setSummaryInterval: (minutes) => { calls.push(["setSummaryInterval", minutes]); }, summaryNow: () => { calls.push(["summaryNow"]); },
    setTipInterval: (minutes) => { calls.push(["setTipInterval", minutes]); }, setEewLog: (enabled, fields) => { calls.push(["setEewLog", enabled, fields]); },
    clear: () => { calls.push(["clear"]); }, promptLabel: () => "FlEq> ",
  };
  return { calls, control };
}
function terminalOptions(control = fakeControl().control): Pick<ReplOptions, "control" | "drained" | "initial"> {
  return { control, drained: () => true, initial: { summaryMinutes: 0, tipMinutes: 30, clock: "elapsed", eewLog: false, eewLogFields: {} } };
}

describe("P3-CLI-REPL-001 発注 3 の 5 入口と一覧・状態の表示", () => {
  // P3-CLI-T14 acceptance (AC21・AC25・AC24)
  it("5 入口と、見せるだけになった notify の形が期待の typed command になる", () => {
    const cases: [string, ReplCommand][] = [
      ["summary", { kind: "summary", action: { kind: "show" } }], ["summary on", { kind: "summary", action: { kind: "on", minutes: 10 } }],
      ["summary ON 30", { kind: "summary", action: { kind: "on", minutes: 30 } }], ["summary off", { kind: "summary", action: { kind: "off" } }],
      ["summary now", { kind: "summary", action: { kind: "now" } }], ["eewlog", { kind: "eewlog", action: { kind: "show" } }],
      ["ewlg on", { kind: "eewlog", action: { kind: "enabled", enabled: true } }], ["eewlog off", { kind: "eewlog", action: { kind: "enabled", enabled: false } }],
      ["eewlog fields", { kind: "eewlog", action: { kind: "fields" } }], ["eewlog fld", { kind: "eewlog", action: { kind: "fields" } }],
      ["eewlog fields magnitude off", { kind: "eewlog", action: { kind: "field", field: "magnitude", enabled: false } }],
      ["eewlog fld Magnitude", { kind: "eewlog", action: { kind: "field", field: "magnitude", enabled: null } }],
      ["tipinterval", { kind: "tipinterval", minutes: null }], ["tint 15", { kind: "tipinterval", minutes: 15 }], ["tipinterval 0", { kind: "tipinterval", minutes: 0 }],
      ["clock", { kind: "clock", mode: null }], ["clock now", { kind: "clock", mode: "clock" }], ["CLOCK UPTIME", { kind: "clock", mode: "uptime" }],
      ["clock elapsed", { kind: "clock", mode: "elapsed" }], ["clear", { kind: "clear" }], ["cls", { kind: "clear" }], ["clear foo", { kind: "clear" }],
      ["notify eq", { kind: "notify", action: { kind: "category", category: "earthquake", enabled: null } }], ["notify all", { kind: "notify", action: { kind: "show" } }],
      ["notify connection off", { kind: "notify", action: { kind: "category", category: "connection", enabled: false } }],
      ["notify all:off", { kind: "notify", action: { kind: "all", enabled: false } }],
    ];
    for (const [line, expected] of cases) expect(parseReplLine(line), line).toEqual({ kind: "command", command: expected });
  });

  // P3-CLI-T15 contractBoundary (AC21・AC24)
  it("5 入口の変えられない行は旧築の文の 1 行だけを出し、control も通知の設定も設定ファイルも変えない", async () => {
    writeConfig({ apiKey: "k0" });
    const before = readFileSync(configFile());
    const { calls, control } = fakeControl();
    const settings = settingsOf();
    const { clock } = fakeClock();
    const repl = runRepl({ host: fakeHost(), settings, savedMute: undefined, displayPort: 7789, clock, onClose: () => {},
      terminal: { output: process.stdout, line: (text: string) => { process.stdout.write(`${text}\n`); }, bind: () => {} }, ...terminalOptions(control) });
    const summaryRange = "  summary on の間隔は 1〜1440 の整数（分）で指定してください。", summaryUsage = "  使い方: summary on [N] / summary off / summary now";
    const eewUsage = "  使い方: eewlog on/off / eewlog fields / eewlog fields <field> [on|off]", tip = "  tipinterval は 0〜1440 の整数を指定してください。";
    const lines: [string, string][] = [
      ["summary on 0", summaryRange], ["summary on 1441", summaryRange], ["summary on 1e3", summaryRange], ["summary maybe", summaryUsage], ["summary on 5 x", summaryUsage],
      ["eewlog maybe", eewUsage],
      ["eewlog fields bogus", "  不明な項目: bogus (有効: hypocenter, originTime, coordinates, magnitude, forecastIntensity, maxLgInt, forecastAreas, lgIntensity, isPlum, hasArrived, diff, maxIntChangeReason)"],
      ["eewlog fields magnitude maybe", eewUsage], ["tipinterval 1441", tip], ["tipinterval -1", tip], ["tipinterval 0x10", tip], ["tipinterval 5 6", tip],
      ["clock later", "  elapsed, now, uptime のいずれかを指定してください。"],
      ["mute connection:critical", "  使い方: mute / mute <時間> / mute [<時間>] <category>:<normal|warning|critical>[,...] / mute off（時間の例: 30m, 1h, 90s）"],
    ];
    for (const [line, message] of lines) {
      stdout = "";
      await type(line);
      expect(stdout, line).toBe(`${message}\n`);
    }
    await repl.idle();
    expect(calls).toEqual([]);
    expect(settings).toEqual(settingsOf());
    expect(readFileSync(configFile()).equals(before)).toBe(true);
    repl.close();
  });

  // P3-CLI-T16 acceptance (AC22・AC25・AC26・AC24)。1 振る舞い 1 it。初めの値は 定期要約 0・tips 30・elapsed・EEW ログ off・項目 {}。
  // 返事を出し終えてから保存の終わりを待って閉じる（保存を残すと、片付けの後に利用者の設定の場所へ書く）。
  const t16 = () => {
    writeConfig({ region: "栃木県宇都宮市" });
    const { calls, control } = fakeControl();
    const settings = settingsOf();
    const repl = runRepl({ host: fakeHost(), settings, savedMute: undefined, displayPort: 7789, clock: fakeClock().clock, onClose: () => {},
      terminal: { output: process.stdout, line: (text: string) => { process.stdout.write(`${text}\n`); }, bind: () => {} }, ...terminalOptions(control) });
    const said = async (...lines: string[]) => { stdout = ""; calls.length = 0; await type(...lines); return stdout; };
    return { calls, settings, said, done: async () => { await repl.idle(); repl.close(); } };
  };

  it("T16 (a) summary は setSummaryInterval を呼んで旧築の文を返し、now は要約の 1 行だけ", async () => {
    const { calls, said, done } = t16();
    expect(await said("summary on 15")).toBe("  定期要約を ON にしました (15分間隔)。\n");
    expect(calls).toEqual([["setSummaryInterval", 15]]);
    expect(await said("summary")).toBe("  定期要約: ON (15分間隔)\n  使い方: summary on [N] / summary off / summary now\n");
    expect(await said("summary off")).toBe("  定期要約を OFF にしました。\n");
    expect(calls).toEqual([["setSummaryInterval", 0]]);
    expect(await said("summary now")).toBe("");
    expect(calls).toEqual([["summaryNow"]]);
    await done();
  });

  it("T16 (b) tipinterval 0 は setTipInterval(0) と無効化の文", async () => {
    const { calls, said, done } = t16();
    expect(await said("tipinterval 0")).toBe("  待機中ヒントを無効化しました。\n");
    expect(calls).toEqual([["setTipInterval", 0]]);
    await done();
  });

  it("T16 (c) clock の引数なしは旧築どおり順に切り替える（P3-CLI-D-O3-CLOCK=B）", async () => {
    const { said, done } = t16();
    expect(await said("clock now", "clock", "clock", "clock now")).toBe("  プロンプト時計を 現在時刻 に変更しました。\n  プロンプト時計を 稼働時間 に切り替えました。\n"
      + "  プロンプト時計を 経過時間 に切り替えました。\n  プロンプト時計を 現在時刻 に変更しました。\n");
    await done();
  });

  it("T16 (d) eewlog は setEewLog を今の値で呼び、fields <項目> は見せるだけ", async () => {
    const { calls, said, done } = t16();
    await said("eewlog on");
    expect(calls).toEqual([["setEewLog", true, {}]]);
    expect(await said("eewlog fields magnitude off")).toBe("  M値・深さ (magnitude): OFF\n");
    expect(calls).toEqual([["setEewLog", true, { magnitude: false }]]);
    expect(await said("eewlog fields magnitude")).toBe("  M値・深さ (magnitude): OFF（変えるには eewlog fields magnitude on か off）\n");
    expect(calls).toEqual([]);
    await done();
  });

  it("T16 (e) clear は control.clear だけで文を出さない", async () => {
    const { calls, said, done } = t16();
    expect(await said("clear")).toBe("");
    expect(calls).toEqual([["clear"]]);
    await done();
  });

  it("T16 (f) help・?・commands は同じ一覧で、[値] に tipinterval・clock・eewlog と 19 分野の notify", async () => {
    const { said, done } = t16();
    await said("tipinterval 0", "clock now", "eewlog on", "eewlog fields magnitude off");
    const listed = await said("help");
    expect([await said("?"), await said("commands")]).toEqual([listed, listed]);
    for (const value of ["[9/19 ON]", "[無効]", "[現在時刻]", "[ON (11/12項目)]"]) expect(listed).toContain(value);
    await done();
  });

  it("T16 (g) notify <分野> は見せるだけ、notify all は notify と同じ一覧で、最後の分野が connection", async () => {
    const { settings, said, done } = t16();
    expect(await said("notify eq")).toBe("  地震情報 (earthquake): ON（変えるには notify earthquake on か off）\n");
    expect(settings.version).toBe(0);
    const all = await said("notify all");
    expect(all).toBe(await said("notify"));
    expect(all.split("\n").filter((line) => /^ {2}\w+ +\S/.test(line)).at(-1)).toBe("  connection    回線の切断  ON");
    await done();
  });

  it("T16 (h) status の最後の空行の前にミュートの行", async () => {
    const { said, done } = t16();
    const muteLine = (text: string) => text.split("\n").at(-3);
    expect(muteLine(await said("status"))).toBe("  ミュート: なし");
    await said("mute 1h earthquake:warning");
    expect(muteLine(await said("status"))).toBe("  ミュート中: 残り 1時間、条件: 地震情報（警報の音以上）");
    await done();
  });

  it("T16 (i) notify connection off で通知の設定の connection が false", async () => {
    const { settings, said, done } = t16();
    await said("notify connection off");
    expect(settings.notify.connection).toBe(false);
    await done();
  });

  it("T16 (j) 保存は変えた欄だけで、summary は書かない（P3-CLI-D-O3-SUMMARY-SAVE=A）", async () => {
    const { said, done } = t16();
    await said("summary on 15", "tipinterval 0", "clock now", "eewlog on", "eewlog fields magnitude off", "notify connection off", "mute 1h earthquake:warning");
    await done();
    expect(readConfig()).toEqual({ region: "栃木県宇都宮市", waitTipIntervalMin: 0, promptClock: "clock", eewLog: true, eewLogFields: { magnitude: false },
      notify: { connection: false }, mute: { until: expect.any(Number), rules: [{ category: "earthquake", level: "warning" }] } });
  });
});

// 実不具合の再発防止（発注 3 の品質レビュー r1 の G1、発注 2 から）: 閉じた REPL の mute の期限の timer が、後から保存を要求していた。
// 試験の片付けの後に鳴ると、利用者の設定の場所に書く。
it("閉じた REPL は、復元した mute の期限を過ぎても保存を要求せず、設定の file を変えない", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { clock, advance } = fakeClock();
  const mute = { until: clock().wallTimeMs + 60_000, rules: [] };
  writeConfig({ region: "栃木県宇都宮市", mute });
  const before = readFileSync(configFile());
  const checked = checkSettings(readConfig());
  if (!checked.ok) throw new Error(checked.reason);
  const repl = runRepl({ host: fakeHost(), settings: notificationSettingsFrom(checked.settings, clock), savedMute: mute, displayPort: 7789, clock, onClose: () => {},
    terminal: { output: process.stdout, line: (text: string) => { process.stdout.write(`${text}\n`); }, bind: () => {} }, ...terminalOptions() });
  repl.close();
  advance(60_001);
  vi.advanceTimersByTime(60_001);
  for (let index = 0; index < 20; index++) await turn();
  await repl.idle();
  expect(readFileSync(configFile()).equals(before)).toBe(true);
});
