import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockExecFile = vi.fn();
const mockExec = vi.fn();
const mockExistsSync = vi.fn();

vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => {
    // mockImplementationOnce 等で指定された戻り値があればそれを返す
    const result = mockExecFile(...args);
    if (result != null) return result;
    // デフォルト: コールバックを即呼び空オブジェクトを返す
    const cb = args[args.length - 1];
    if (typeof cb === "function") {
      (cb as (err: Error | null) => void)(null);
    }
    return {};
  },
  exec: (...args: unknown[]) => {
    const result = mockExec(...args);
    if (result != null) return result;
    const cb = args[args.length - 1];
    if (typeof cb === "function") {
      (cb as (err: Error | null) => void)(null);
    }
    return {};
  },
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, existsSync: (...args: unknown[]) => mockExistsSync(...args) };
});

describe("sound-player", () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    vi.resetModules();
    originalPlatform = process.platform;
    mockExecFile.mockClear();
    mockExec.mockClear();
    // デフォルトではカスタム効果音なし (システムサウンドフォールバックのテスト用)
    mockExistsSync.mockReturnValue(false);
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("Windows: PowerShell execFile 経由で WAV ファイルを再生する", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    // システムサウンドファイルが存在する環境をシミュレート
    mockExistsSync.mockImplementation((p: string) =>
      typeof p === "string" && p.includes("Media") ? true : false
    );
    const { playSound } = await import("../../src/engine/notification/sound-player");
    playSound("critical");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0][0]).toBe("powershell");
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-Command");
    const cmd = args[args.length - 1];
    expect(cmd).toContain("Windows Critical Stop.wav");
  });

  it("Windows: warning レベルで正しいサウンドファイルを使用する", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    mockExistsSync.mockImplementation((p: string) =>
      typeof p === "string" && p.includes("Media") ? true : false
    );
    const { playSound } = await import("../../src/engine/notification/sound-player");
    playSound("warning");
    const args = mockExecFile.mock.calls[0][1] as string[];
    const cmd = args[args.length - 1];
    expect(cmd).toContain("Windows Exclamation.wav");
  });

  it("macOS: afplay でサウンドファイルを再生する", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { playSound } = await import("../../src/engine/notification/sound-player");
    playSound("critical");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0][0]).toBe("afplay");
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("/System/Library/Sounds/Sosumi.aiff");
  });

  it("macOS: info レベルで Tink.aiff を使用する", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { playSound } = await import("../../src/engine/notification/sound-player");
    playSound("info");
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("/System/Library/Sounds/Tink.aiff");
  });

  it("Linux: canberra-gtk-play でイベント音を再生する", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { playSound } = await import("../../src/engine/notification/sound-player");
    playSound("critical");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0][0]).toBe("canberra-gtk-play");
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-i");
    expect(args).toContain("dialog-error");
  });

  it("Linux: cancel レベルではターミナルbell を使用する", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { playSound } = await import("../../src/engine/notification/sound-player");
    playSound("cancel");
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(stdoutWriteSpy).toHaveBeenCalledWith("\x07");
  });

  it("カスタム効果音: ファイルが存在すればカスタムパスで再生する (Windows)", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    mockExistsSync.mockImplementation((p: string) => p.endsWith("critical.mp3"));
    const { playSound } = await import("../../src/engine/notification/sound-player");
    playSound("critical");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0][0]).toBe("powershell");
    const args = mockExecFile.mock.calls[0][1] as string[];
    const cmd = args[args.length - 1];
    expect(cmd).toContain("critical.mp3");
    expect(cmd).toContain("mciSendStringW");
    expect(cmd).not.toContain("Windows Critical Stop.wav");
  });

  it("カスタム効果音: ファイルが存在すればカスタムパスで再生する (macOS)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistsSync.mockImplementation((p: string) => p.endsWith("warning.mp3"));
    const { playSound } = await import("../../src/engine/notification/sound-player");
    playSound("warning");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0][0]).toBe("afplay");
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args[0]).toContain("warning.mp3");
  });

  it("カスタム効果音: ファイルが存在すればカスタムパスで再生する (Linux mp3)", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockExistsSync.mockImplementation((p: string) => p.endsWith("info.mp3"));
    const { playSound } = await import("../../src/engine/notification/sound-player");
    playSound("info");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0][0]).toBe("ffplay");
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args.some((a: string) => a.endsWith("info.mp3"))).toBe(true);
  });

  it("全サウンドレベルに対応する", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    mockExistsSync.mockImplementation((p: string) =>
      typeof p === "string" && p.includes("Media") ? true : false
    );
    const { playSound } = await import("../../src/engine/notification/sound-player");
    const levels = ["critical", "warning", "normal", "info", "cancel"] as const;
    for (const level of levels) {
      expect(() => playSound(level)).not.toThrow();
    }
    // Windows では全レベルが PowerShell 経由 (execFile) で再生される
    expect(mockExecFile).toHaveBeenCalledTimes(5);
  });

  it("dispose() を呼んだ後は playSound が無視される", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { playSound, dispose } = await import("../../src/engine/notification/sound-player");
    dispose();
    playSound("critical");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("findCustomSound の結果をキャッシュする", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    mockExistsSync.mockImplementation((p: string) => p.endsWith("critical.mp3"));
    const { playSound, clearCustomSoundCache } = await import("../../src/engine/notification/sound-player");

    // 初回: existsSync を呼んでキャッシュを作成する
    playSound("critical");
    mockExistsSync.mockClear();

    // 2回目: キャッシュヒットのため existsSync は呼ばれない
    playSound("critical");
    expect(mockExistsSync).not.toHaveBeenCalled();

    // キャッシュクリア後は再度 existsSync を呼ぶ
    clearCustomSoundCache();
    playSound("critical");
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
  });

  it("_setUptimeProviderForTest で nowMs を上書きできる", async () => {
    const sp = await import("../../src/engine/notification/sound-player");
    sp._setUptimeProviderForTest(() => 12.5);
    expect(sp._nowMsForTest()).toBe(12500);
    sp._setUptimeProviderForTest(null);
  });

  it("起動直後 (uptime<60s) の再生失敗は 20 秒後に再試行される", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    // execFile は毎回 error で呼ばれる (canberra-gtk-play が失敗する想定)
    mockExecFile.mockImplementation((..._args: unknown[]) => {
      const cb = _args[_args.length - 1];
      if (typeof cb === "function") {
        (cb as (err: Error | null) => void)(new Error("device busy"));
      }
      return { kill: vi.fn() };
    });

    vi.useFakeTimers();
    const sp = await import("../../src/engine/notification/sound-player");
    sp._setUptimeProviderForTest(() => 5); // 5 秒経過
    sp.resetSoundPlayer();

    sp.playSound("critical");
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    // 20 秒進めるとリトライが走る
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockExecFile).toHaveBeenCalledTimes(2);

    sp._setUptimeProviderForTest(null);
    sp.resetSoundPlayer();
  });

  it("起動後 60 秒を超えた失敗はリトライされない", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockExecFile.mockImplementation((..._args: unknown[]) => {
      const cb = _args[_args.length - 1];
      if (typeof cb === "function") {
        (cb as (err: Error | null) => void)(new Error("device busy"));
      }
      return { kill: vi.fn() };
    });

    vi.useFakeTimers();
    const sp = await import("../../src/engine/notification/sound-player");
    sp._setUptimeProviderForTest(() => 90); // 起動後 90 秒経過
    sp.resetSoundPlayer();

    sp.playSound("info");
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(mockExecFile).toHaveBeenCalledTimes(1); // リトライなし

    sp._setUptimeProviderForTest(null);
    sp.resetSoundPlayer();
  });

  it("リトライ経由の失敗は再度リトライされない", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockExecFile.mockImplementation((..._args: unknown[]) => {
      const cb = _args[_args.length - 1];
      if (typeof cb === "function") {
        (cb as (err: Error | null) => void)(new Error("device busy"));
      }
      return { kill: vi.fn() };
    });

    vi.useFakeTimers();
    const sp = await import("../../src/engine/notification/sound-player");
    sp._setUptimeProviderForTest(() => 5);
    sp.resetSoundPlayer();

    sp.playSound("warning");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockExecFile).toHaveBeenCalledTimes(2); // 1 回目のリトライが走る

    // さらに 25 秒進めても 3 回目は起きない (isRetry 経由の失敗は再リトライしない)
    await vi.advanceTimersByTimeAsync(25_000);
    expect(mockExecFile).toHaveBeenCalledTimes(2);

    sp._setUptimeProviderForTest(null);
    sp.resetSoundPlayer();
  });

  it("タイムアウト発火後に遅延 callback が走ってもキュー進行が二重化しない", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    // 1 回目の execFile: コールバックをキャプチャだけして実行しない (ハング再現)
    const captured: Array<(err: Error | null) => void> = [];
    const killFn = vi.fn();
    mockExecFile.mockImplementationOnce((..._args: unknown[]) => {
      const cb = _args[_args.length - 1];
      if (typeof cb === "function") captured.push(cb as (err: Error | null) => void);
      return { kill: killFn };
    });
    // 2 回目以降はデフォルトモック (cb 即呼び) が使われる

    vi.useFakeTimers();
    const sp = await import("../../src/engine/notification/sound-player");
    sp.resetSoundPlayer();

    sp.playSound("info");     // 1 枚目: キャプチャ版が動き、完了しない
    sp.playSound("warning");  // 2 枚目: キューに入る (MAX_CONCURRENT=1)

    expect(mockExecFile).toHaveBeenCalledTimes(1);

    // 10 秒で timeout 発火 → kill → handle.done → キューから warning を取り出して runPlay
    await vi.advanceTimersByTimeAsync(10_000);
    expect(killFn).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledTimes(2); // warning が実行された

    // 1 枚目の遅延コールバックを今さら呼ぶ。
    // 旧実装 (二重完了バグあり) なら onPlayFinished が再度走り、activeCount が減って
    // キューから余計に取り出そうとする。現実装 (DoneHandle) では claim() が false で skip。
    captured[0]?.(new Error("killed"));

    // 追加の execFile 呼び出しが起きないこと
    expect(mockExecFile).toHaveBeenCalledTimes(2);

    sp.resetSoundPlayer();
  });
});
