import { execFile, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as log from "../../logger";

/** 通知音レベル一覧 (型導出の信頼できる唯一のソース) */
export const SOUND_LEVELS = ["critical", "warning", "normal", "info", "cancel"] as const;

/** 通知音レベル */
export type SoundLevel = (typeof SOUND_LEVELS)[number];

/** 文字列が有効な SoundLevel かを判定する型ガード */
export function isSoundLevel(value: string): value is SoundLevel {
  return (SOUND_LEVELS as readonly string[]).includes(value);
}

/** カスタム効果音ディレクトリ (プロジェクトルート/assets/sounds/) */
const CUSTOM_SOUNDS_DIR = path.resolve(__dirname, "..", "..", "..", "assets", "sounds");

/** カスタム効果音のファイル名 (拡張子なし — mp3 → wav の順で探索) */
const CUSTOM_SOUND_FILES: Record<SoundLevel, string> = {
  critical: "critical",
  warning: "warning",
  normal: "normal",
  info: "info",
  cancel: "cancel",
};

/** サポートする拡張子 (優先順) */
const SUPPORTED_EXTENSIONS = [".mp3", ".wav"];

/** Windows システムサウンドフォールバック */
const WINDOWS_SOUNDS: Record<SoundLevel, string> = {
  critical: "Windows Critical Stop.wav",
  warning: "Windows Exclamation.wav",
  normal: "Windows Notify Calendar.wav",
  info: "Windows Notify Email.wav",
  cancel: "Windows Recycle.wav",
};

/** macOS システムサウンドフォールバック */
const MACOS_SOUNDS: Record<SoundLevel, string> = {
  critical: "Sosumi.aiff",
  warning: "Basso.aiff",
  normal: "Glass.aiff",
  info: "Tink.aiff",
  cancel: "Pop.aiff",
};

/** Linux canberra イベント名フォールバック */
const LINUX_CANBERRA_EVENTS: Record<SoundLevel, string> = {
  critical: "dialog-error",
  warning: "dialog-warning",
  normal: "message-new-instant",
  info: "dialog-information",
  cancel: "bell",
};

// ── findCustomSound キャッシュ ──

/** findCustomSound の結果キャッシュ (null = 存在しない, undefined = 未検索) */
const customSoundCache = new Map<SoundLevel, string | null>();

/**
 * カスタム効果音ファイルのパスを返す。見つからなければ null。
 * mp3 → wav の順で探索する。結果はキャッシュして再利用する。
 */
function findCustomSound(level: SoundLevel): string | null {
  if (customSoundCache.has(level)) {
    return customSoundCache.get(level) as string | null;
  }
  const baseName = CUSTOM_SOUND_FILES[level];
  for (const ext of SUPPORTED_EXTENSIONS) {
    const filePath = path.join(CUSTOM_SOUNDS_DIR, baseName + ext);
    if (fs.existsSync(filePath)) {
      customSoundCache.set(level, filePath);
      return filePath;
    }
  }
  customSoundCache.set(level, null);
  return null;
}

/** サウンドキャッシュをクリアする (テスト用) */
export function clearCustomSoundCache(): void {
  customSoundCache.clear();
  windowsSoundCache.clear();
}

// ── 起動ウィンドウ用の単調時計 ──

/** 起動後リトライのウィンドウ (ms) */
const STARTUP_WINDOW_MS = 60_000;
/** 失敗時のリトライ待機 (ms) */
const RETRY_DELAY_MS = 20_000;

/** テスト用に差し替え可能な uptime プロバイダ (秒) */
let uptimeProvider: (() => number) | null = null;

/** プロセス起動からの経過ミリ秒 (Date.now の非単調性を避ける) */
function nowMs(): number {
  const seconds = uptimeProvider != null ? uptimeProvider() : process.uptime();
  return Math.floor(seconds * 1000);
}

/** テスト用: uptime プロバイダを差し替える (null で本物に戻す) */
export function _setUptimeProviderForTest(fn: (() => number) | null): void {
  uptimeProvider = fn;
}

/** テスト用: 現在の nowMs 値を返す */
export function _nowMsForTest(): number {
  return nowMs();
}

// ── 有界キュー ──

/** 同時再生の最大数 */
const MAX_CONCURRENT = 1;
/** キューの最大サイズ (超えたら古いエントリを破棄) */
const MAX_QUEUE_SIZE = 3;
/** 再生プロセスのタイムアウト (ms) */
const PLAY_TIMEOUT_MS = 10_000;

/** 再生中のプロセス数 */
let activeCount = 0;
/** 再生待ちキュー (level と isRetry フラグを保持) */
const playQueue: { level: SoundLevel; isRetry: boolean }[] = [];
/** 現在再生中のプロセス (タイムアウト kill 用) */
let activeProcess: ChildProcess | null = null;
/** タイムアウトタイマー */
let activeTimer: ReturnType<typeof setTimeout> | null = null;
/** 起動後リトライのタイマーハンドル集合 (dispose でクリア) */
const retryTimers = new Set<ReturnType<typeof setTimeout>>();

/** dispose 済みフラグ */
let disposed = false;

/**
 * 再生完了後にキューから次のエントリを取り出して再生する。
 */
function onPlayFinished(): void {
  activeCount--;
  activeProcess = null;
  if (activeTimer != null) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  if (disposed) return;
  if (playQueue.length > 0) {
    const next = playQueue.shift()!;
    runPlay(next.level, { isRetry: next.isRetry });
  }
}

/**
 * 完了権ハンドル。launch 関数の error callback や timeout で先に claim() した
 * 側だけが後続処理 (ログ・bell・キューの進行) を行う。
 */
interface DoneHandle {
  /** 完了権を取得する。既に他経路で完了済みなら false */
  claim(): boolean;
  /** 完了処理を行う (claim() 成功後に呼ぶ)。failed=true ならリトライ判定が走る */
  done(failed?: boolean): void;
}

/**
 * 起動ウィンドウ内で失敗した場合に、指定秒後の再試行をスケジュールする。
 * - リトライ由来の失敗 (opts.isRetry) は再リトライしない
 * - 起動後 STARTUP_WINDOW_MS を過ぎていればスケジュールしない
 */
function scheduleRetryIfNeeded(level: SoundLevel, opts?: { isRetry?: boolean }): void {
  if (opts?.isRetry) return;
  if (disposed) return;
  if (nowMs() >= STARTUP_WINDOW_MS) return;
  log.warn(`通知音を ${RETRY_DELAY_MS / 1000} 秒後に再試行します (${level})`);
  const timer = setTimeout(() => {
    retryTimers.delete(timer);
    if (!disposed) playSound(level, { isRetry: true });
  }, RETRY_DELAY_MS);
  retryTimers.add(timer);
}

/**
 * プロセスを起動して再生を実行する。
 * タイムアウトと launch 経路のコールバックが競合した場合、先に claim() した
 * 側だけが log/bell/キュー進行を実行する (二重完了ガード)。
 */
function runPlay(level: SoundLevel, opts?: { isRetry?: boolean }): void {
  activeCount++;
  let finished = false;

  const handle: DoneHandle = {
    claim: (): boolean => {
      if (finished) return false;
      finished = true;
      return true;
    },
    done: (failed?: boolean): void => {
      if (failed === true) scheduleRetryIfNeeded(level, opts);
      onPlayFinished();
    },
  };

  try {
    const customPath = findCustomSound(level);
    const platform = process.platform;

    if (customPath) {
      activeProcess = launchCustomSound(customPath, platform, handle);
    } else if (platform === "win32") {
      activeProcess = launchSystemSoundWindows(level, handle);
    } else if (platform === "darwin") {
      activeProcess = launchSystemSoundMacOS(level, handle);
    } else {
      activeProcess = launchSystemSoundLinux(level, handle);
    }

    if (activeProcess != null) {
      activeTimer = setTimeout(() => {
        if (!handle.claim()) return;
        log.warn(`通知音の再生がタイムアウトしました (${PLAY_TIMEOUT_MS}ms)`);
        try {
          activeProcess?.kill();
        } catch {
          // ignore
        }
        handle.done(true);
      }, PLAY_TIMEOUT_MS);
    }
  } catch (err) {
    if (!handle.claim()) return;
    if (err instanceof Error) {
      log.warn(`通知音の再生に失敗しました: ${err.message}`);
    }
    handle.done(true);
  }
}

/**
 * 通知音を再生する (fire-and-forget)。
 * 同時再生は MAX_CONCURRENT 件に制限し、超えた場合はキューに積む。
 * キューが MAX_QUEUE_SIZE を超えた場合は先頭 (最古) を破棄する。
 * カスタム効果音ファイルがあればそちらを優先、なければ OS システムサウンドにフォールバック。
 * 再生失敗はログに記録するのみで例外は投げない。
 */
export function playSound(level: SoundLevel, opts?: { isRetry?: boolean }): void {
  if (disposed) return;

  if (activeCount < MAX_CONCURRENT) {
    runPlay(level, opts);
  } else {
    if (playQueue.length >= MAX_QUEUE_SIZE) {
      const dropped = playQueue.shift();
      log.debug(`通知音キューが上限 (${MAX_QUEUE_SIZE}) に達したため破棄しました: ${dropped?.level}`);
    }
    playQueue.push({ level, isRetry: opts?.isRetry === true });
  }
}

/**
 * 進行中の再生を停止し、キューをクリアする。
 * アプリ終了時に呼ぶことでプロセスリークを防ぐ。
 */
export function dispose(): void {
  disposed = true;
  playQueue.length = 0;
  if (activeTimer != null) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  for (const timer of retryTimers) {
    clearTimeout(timer);
  }
  retryTimers.clear();
  if (activeProcess != null) {
    try {
      activeProcess.kill();
    } catch {
      // ignore
    }
    activeProcess = null;
  }
  activeCount = 0;
}

/**
 * dispose 後に再利用できるよう内部状態をリセットする (テスト用)。
 */
export function resetSoundPlayer(): void {
  disposed = false;
  activeCount = 0;
  playQueue.length = 0;
  activeProcess = null;
  if (activeTimer != null) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  for (const timer of retryTimers) {
    clearTimeout(timer);
  }
  retryTimers.clear();
}

// ── カスタム効果音再生 ──

function launchCustomSound(
  filePath: string,
  platform: string,
  onDone: DoneHandle,
): ChildProcess | null {
  if (platform === "win32") {
    return launchCustomSoundWindows(filePath, onDone);
  } else if (platform === "darwin") {
    return launchCustomSoundMacOS(filePath, onDone);
  } else {
    return launchCustomSoundLinux(filePath, onDone);
  }
}

/** Windows: winmm.dll mciSendString で mp3/wav を同期再生 */
function launchCustomSoundWindows(filePath: string, onDone: DoneHandle): ChildProcess | null {
  // MediaPlayer (WPF) は非同期ロードのためタイミング問題が起きやすい。
  // mciSendString は同期 (wait) で確実に再生できる。
  // execFile を使い cmd.exe のダブルクォーテーション解釈を回避する。
  const escaped = filePath.replace(/'/g, "''");
  const psCommand = [
    `Add-Type -Namespace Win32 -Name Mci -MemberDefinition '[DllImport("winmm.dll",CharSet=CharSet.Unicode)]public static extern int mciSendStringW(string cmd,System.Text.StringBuilder ret,int retLen,System.IntPtr hwnd);';`,
    `[Win32.Mci]::mciSendStringW('open "' + '${escaped}' + '" type mpegvideo alias fleqsnd',$null,0,[IntPtr]::Zero)|Out-Null;`,
    `[Win32.Mci]::mciSendStringW('play fleqsnd wait',$null,0,[IntPtr]::Zero)|Out-Null;`,
    `[Win32.Mci]::mciSendStringW('close fleqsnd',$null,0,[IntPtr]::Zero)|Out-Null`,
  ].join(" ");
  const proc = execFile("powershell", ["-NoProfile", "-Command", psCommand], (err) => {
    if (!onDone.claim()) return;
    if (err) {
      log.warn(`Windows カスタム通知音の再生に失敗しました: ${err.message}`);
      onDone.done(true);
    } else {
      onDone.done();
    }
  });
  return proc;
}

/** macOS: afplay で mp3/wav を再生 */
function launchCustomSoundMacOS(filePath: string, onDone: DoneHandle): ChildProcess | null {
  const proc = execFile("afplay", [filePath], (err) => {
    if (!onDone.claim()) return;
    if (err) {
      log.warn(`macOS カスタム通知音の再生に失敗しました: ${err.message}`);
      onDone.done(true);
    } else {
      onDone.done();
    }
  });
  return proc as unknown as ChildProcess;
}

/** Linux: ffplay → paplay → aplay のフォールバック */
function launchCustomSoundLinux(filePath: string, onDone: DoneHandle): ChildProcess | null {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".mp3") {
    // mp3 は ffplay で再生
    const proc = execFile("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath], (err) => {
      if (!onDone.claim()) return;
      if (err) {
        log.warn(`Linux ffplay での再生に失敗しました: ${err.message}`);
        printBell();
        onDone.done(true);
      } else {
        onDone.done();
      }
    });
    return proc as unknown as ChildProcess;
  } else {
    // wav は paplay → aplay のフォールバック
    const proc = execFile("paplay", [filePath], (err) => {
      if (err) {
        execFile("aplay", ["-q", filePath], (err2) => {
          if (!onDone.claim()) return;
          if (err2) {
            log.warn(`Linux 通知音の再生に失敗しました: ${err2.message}`);
            printBell();
            onDone.done(true);
          } else {
            onDone.done();
          }
        });
      } else {
        if (!onDone.claim()) return;
        onDone.done();
      }
    });
    return proc as unknown as ChildProcess;
  }
}

// ── システムサウンドフォールバック ──

/** Windows システムサウンドの存在確認キャッシュ (null = 存在しない, undefined = 未検索) */
const windowsSoundCache = new Map<SoundLevel, string | null>();

/** Windows サウンドファイルの確認済みパスを返す。存在しなければ null。 */
function findWindowsSystemSound(level: SoundLevel): string | null {
  if (windowsSoundCache.has(level)) {
    return windowsSoundCache.get(level) as string | null;
  }
  const soundFile = WINDOWS_SOUNDS[level];
  const soundPath = path.join(
    process.env.SYSTEMROOT || "C:\\Windows",
    "Media",
    soundFile
  );
  if (fs.existsSync(soundPath)) {
    windowsSoundCache.set(level, soundPath);
    return soundPath;
  }
  // フォールバック: Windows Default.wav
  const defaultPath = path.join(
    process.env.SYSTEMROOT || "C:\\Windows",
    "Media",
    "Windows Default.wav"
  );
  if (fs.existsSync(defaultPath)) {
    windowsSoundCache.set(level, defaultPath);
    return defaultPath;
  }
  windowsSoundCache.set(level, null);
  return null;
}

function launchSystemSoundWindows(level: SoundLevel, onDone: DoneHandle): ChildProcess | null {
  const soundPath = findWindowsSystemSound(level);
  if (soundPath == null) {
    if (!onDone.claim()) return null;
    log.warn(`Windows 通知音が見つかりません。bell にフォールバックします: ${WINDOWS_SOUNDS[level]}`);
    printBell();
    onDone.done(true);
    return null;
  }
  const psCommand = `(New-Object System.Media.SoundPlayer '${soundPath}').PlaySync()`;
  const proc = execFile("powershell", ["-NoProfile", "-Command", psCommand], (err) => {
    if (!onDone.claim()) return;
    if (err) {
      log.warn(`Windows 通知音の再生に失敗しました: ${err.message}`);
      onDone.done(true);
    } else {
      onDone.done();
    }
  });
  return proc;
}

function launchSystemSoundMacOS(level: SoundLevel, onDone: DoneHandle): ChildProcess | null {
  const soundFile = MACOS_SOUNDS[level];
  const soundPath = `/System/Library/Sounds/${soundFile}`;
  const proc = execFile("afplay", [soundPath], (err) => {
    if (!onDone.claim()) return;
    if (err) {
      log.warn(`macOS 通知音の再生に失敗しました: ${err.message}`);
      onDone.done(true);
    } else {
      onDone.done();
    }
  });
  return proc as unknown as ChildProcess;
}

function launchSystemSoundLinux(level: SoundLevel, onDone: DoneHandle): ChildProcess | null {
  const eventName = LINUX_CANBERRA_EVENTS[level];

  if (eventName === "bell") {
    if (!onDone.claim()) return null;
    printBell();
    onDone.done();
    return null;
  }

  const proc = execFile("canberra-gtk-play", ["-i", eventName], (err) => {
    if (!onDone.claim()) return;
    if (err) {
      log.warn(`canberra-gtk-play 失敗、bell にフォールバック: ${err.message}`);
      printBell();
      onDone.done(true);
    } else {
      onDone.done();
    }
  });
  return proc as unknown as ChildProcess;
}

function printBell(): void {
  try {
    process.stdout.write("\x07");
  } catch {
    // ignore
  }
}

// ── バックエンド健康チェック ──

/** バックエンドプローブの timeout (ms) */
const BACKEND_PROBE_TIMEOUT_MS = 2_000;

/**
 * 音声バックエンドが利用可能かを判定する。
 * Linux: ffplay で 0.1 秒の無音サンプルを再生し、終了コードで判定する。
 *        PATH 上に ffplay があっても音声デバイスが使えない場合は ok=false を返す。
 * Windows / macOS: 即座に ok=true を返す (ビルトインの再生経路が常に利用可能)。
 */
export async function checkSoundBackend(): Promise<{
  ok: boolean;
  label: string;
  reason?: string;
}> {
  const platform = process.platform;
  if (platform === "win32") return { ok: true, label: "winmm" };
  if (platform === "darwin") return { ok: true, label: "afplay" };

  return await new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const proc = execFile(
      "ffplay",
      ["-f", "lavfi", "-i", "anullsrc=d=0.1", "-nodisp", "-autoexit", "-loglevel", "quiet"],
      (err) => {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimeout(timer);
        if (err) {
          resolve({ ok: false, label: "ffplay", reason: err.message });
        } else {
          resolve({ ok: true, label: "ffplay" });
        }
      },
    );
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc?.kill();
      } catch {
        // ignore
      }
      resolve({ ok: false, label: "ffplay", reason: "probe timeout" });
    }, BACKEND_PROBE_TIMEOUT_MS);
  });
}
