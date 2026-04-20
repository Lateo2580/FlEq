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
    mockExecFile(...args);
    // コールバックがあれば呼ぶ
    const cb = args[args.length - 1];
    if (typeof cb === "function") {
      (cb as (err: Error | null) => void)(null);
    }
    return {};
  },
  exec: (...args: unknown[]) => {
    mockExec(...args);
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
});
