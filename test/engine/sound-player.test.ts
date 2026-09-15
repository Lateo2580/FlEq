import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// setup.ts のグローバル playSound モックを外し、本物の sound-player を検証する
// (実音は下の child_process モックで遮断される)
vi.unmock("../../src/engine/notification/sound-player");

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

const mockWriteFileSync = vi.fn();

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    // 実装が差し込まれたときだけ差し替え、既定は本物 (probe の無音 WAV 書き込みに使う)
    writeFileSync: (...args: unknown[]) =>
      mockWriteFileSync.getMockImplementation() != null
        ? mockWriteFileSync(...args)
        : (actual.writeFileSync as (...a: unknown[]) => void)(...args),
  };
});

describe("sound-player", () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    vi.resetModules();
    originalPlatform = process.platform;
    // mockReset で前テストの mockImplementation / mockImplementationOnce を必ずクリア
    mockExecFile.mockReset();
    mockExec.mockReset();
    mockExistsSync.mockReset();
    mockWriteFileSync.mockReset();
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

  it("checkSoundBackend(): Linux で ffplay プローブ成功なら ok=true", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockExecFile.mockImplementationOnce((..._args: unknown[]) => {
      const cb = _args[_args.length - 1];
      if (typeof cb === "function") {
        (cb as (err: Error | null) => void)(null);
      }
      return { kill: vi.fn() };
    });
    const sp = await import("../../src/engine/notification/sound-player");
    const result = await sp.checkSoundBackend();
    expect(result.ok).toBe(true);
    expect(result.label).toBe("ffplay");
  });

  it("checkSoundBackend(): Linux で ffplay/paplay/aplay が全て失敗なら ok=false", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockExecFile.mockImplementation((..._args: unknown[]) => {
      const cb = _args[_args.length - 1];
      if (typeof cb === "function") {
        (cb as (err: Error | null) => void)(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      }
      return { kill: vi.fn() };
    });
    const sp = await import("../../src/engine/notification/sound-player");
    const result = await sp.checkSoundBackend();
    expect(result.ok).toBe(false);
    expect(mockExecFile.mock.calls.map((c) => c[0])).toEqual(["ffplay", "paplay", "aplay"]);
    expect(result.reason).toMatch(/ffplay: not found in PATH; paplay: not found in PATH; aplay: not found in PATH/);
  });

  // Issue #20: bundled WAV 化後に再生 (paplay→aplay) と probe (ffplay) が食い違い、
  // ffplay しか使えない Pi で通知音が鳴らず bell に退避していた実不具合の再発防止
  it("Linux wav: ffplay が使えるなら再生も probe も ffplay を使う", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockExistsSync.mockImplementation((p: string) => p.endsWith("info.wav"));
    const sp = await import("../../src/engine/notification/sound-player");
    sp.playSound("info");
    expect(mockExecFile.mock.calls.map((c) => c[0])).toEqual(["ffplay"]);
    expect((mockExecFile.mock.calls[0][1] as string[]).at(-1)).toMatch(/info\.wav$/);
    const result = await sp.checkSoundBackend();
    expect(result).toEqual({ ok: true, label: "ffplay" });
  });

  // 契約境界: 再生と probe は同じ fallback 列 (ffplay → paplay → aplay) を辿り、label は実際に成功した player
  it("Linux wav: ffplay・paplay が無ければ aplay へ進み、probe の label も aplay になる", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockExistsSync.mockImplementation((p: string) => p.endsWith("info.wav"));
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(args[0] === "aplay" ? null : Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      return { kill: vi.fn() };
    });
    const sp = await import("../../src/engine/notification/sound-player");
    sp.playSound("info");
    expect(mockExecFile.mock.calls.map((c) => c[0])).toEqual(["ffplay", "paplay", "aplay"]);
    expect(stdoutWriteSpy).not.toHaveBeenCalledWith("\x07");
    mockExecFile.mockClear();
    const result = await sp.checkSoundBackend();
    expect(mockExecFile.mock.calls.map((c) => c[0])).toEqual(["ffplay", "paplay", "aplay"]);
    expect(result).toEqual({ ok: true, label: "aplay" });
  });

  // 契約境界: カスタム mp3 は ffplay しか鳴らせないので、再生も probe も ffplay だけを見る
  // (wav の列で probe すると paplay OK と出るのに mp3 は鳴らない、という食い違いを再導入しない)
  it("Linux mp3: 再生も probe も ffplay のみで、paplay/aplay へ進まない", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockExistsSync.mockImplementation((p: string) => p.endsWith(".mp3"));
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(args[0] === "ffplay" ? Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) : null);
      return { kill: vi.fn() };
    });
    const sp = await import("../../src/engine/notification/sound-player");
    sp.playSound("info");
    expect(mockExecFile.mock.calls.map((c) => c[0])).toEqual(["ffplay"]);
    expect(stdoutWriteSpy).toHaveBeenCalledWith("\x07");
    mockExecFile.mockClear();
    const result = await sp.checkSoundBackend();
    expect(mockExecFile.mock.calls.map((c) => c[0])).toEqual(["ffplay"]);
    expect(result.ok).toBe(false);
    expect(result.label).toBe("ffplay");
  });

  // 契約境界: probe 用 WAV の書き込みに失敗したら専用ディレクトリを残さず、元のエラーで reject する
  it("checkSoundBackend(): 無音 WAV の書き込み失敗で一時ディレクトリを残さず reject する", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockWriteFileSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const os = await import("os");
    const fs = await vi.importActual<typeof import("fs")>("fs");
    const countProbeDirs = (): number =>
      fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("fleq-sound-probe-")).length;
    const before = countProbeDirs();
    const sp = await import("../../src/engine/notification/sound-player");
    await expect(sp.checkSoundBackend()).rejects.toThrow("EACCES");
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(countProbeDirs()).toBe(before);
  });

  // 契約境界: timeout で kill された player の失敗では次の player を起動しない
  it("Linux wav: timeout kill 後は次の player へ進まない", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockExistsSync.mockImplementation((p: string) => p.endsWith("info.wav"));
    const killFn = vi.fn();
    let ffplayCb: ((err: Error | null) => void) | null = null;
    mockExecFile.mockImplementationOnce((...args: unknown[]) => {
      ffplayCb = args[args.length - 1] as (err: Error | null) => void;
      return { kill: killFn };
    });
    vi.useFakeTimers();
    const sp = await import("../../src/engine/notification/sound-player");
    sp.playSound("info");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(killFn).toHaveBeenCalled();
    ffplayCb!(Object.assign(new Error("killed"), { killed: true }));
    expect(mockExecFile.mock.calls.map((c) => c[0])).toEqual(["ffplay"]);
  });

  it("checkSoundBackend(): プローブが 2 秒超で timeout 扱い", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const killFn = vi.fn();
    mockExecFile.mockImplementationOnce(() => {
      // コールバックを呼ばずハングさせる
      return { kill: killFn };
    });

    vi.useFakeTimers();
    const sp = await import("../../src/engine/notification/sound-player");
    const promise = sp.checkSoundBackend();
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timeout/i);
    expect(killFn).toHaveBeenCalled();
  });

  it("checkSoundBackend(): Windows は ok=true を即返す", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const sp = await import("../../src/engine/notification/sound-player");
    const result = await sp.checkSoundBackend();
    expect(result.ok).toBe(true);
    expect(result.label).toBe("winmm");
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
