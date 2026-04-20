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
/** 再生待ちキュー */
const playQueue: SoundLevel[] = [];
/** 現在再生中のプロセス (タイムアウト kill 用) */
let activeProcess: ChildProcess | null = null;
/** タイムアウトタイマー */
let activeTimer: ReturnType<typeof setTimeout> | null = null;

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
    runPlay(next);
  }
}

/**
 * プロセスを起動して再生を実行する。
 * タイムアウトと execFile コールバックのいずれか先に発火した側だけが
 * 完了処理を行う (finishOnce による二重完了ガード)。
 */
function runPlay(level: SoundLevel): void {
  activeCount++;
  let finished = false;

  const finishOnce = (): void => {
    if (finished) return;
    finished = true;
    onPlayFinished();
  };

  try {
    const customPath = findCustomSound(level);
    const platform = process.platform;

    if (customPath) {
      activeProcess = launchCustomSound(customPath, platform, finishOnce);
    } else if (platform === "win32") {
      activeProcess = launchSystemSoundWindows(level, finishOnce);
    } else if (platform === "darwin") {
      activeProcess = launchSystemSoundMacOS(level, finishOnce);
    } else {
      activeProcess = launchSystemSoundLinux(level, finishOnce);
    }

    if (activeProcess != null) {
      activeTimer = setTimeout(() => {
        log.debug(`通知音の再生がタイムアウトしました (${PLAY_TIMEOUT_MS}ms)`);
        try {
          activeProcess?.kill();
        } catch {
          // ignore
        }
        finishOnce();
      }, PLAY_TIMEOUT_MS);
    }
  } catch (err) {
    if (err instanceof Error) {
      log.debug(`通知音の再生に失敗しました: ${err.message}`);
    }
    finishOnce();
  }
}

/**
 * 通知音を再生する (fire-and-forget)。
 * 同時再生は MAX_CONCURRENT 件に制限し、超えた場合はキューに積む。
 * キューが MAX_QUEUE_SIZE を超えた場合は先頭 (最古) を破棄する。
 * カスタム効果音ファイルがあればそちらを優先、なければ OS システムサウンドにフォールバック。
 * 再生失敗はログに記録するのみで例外は投げない。
 */
export function playSound(level: SoundLevel): void {
  if (disposed) return;

  if (activeCount < MAX_CONCURRENT) {
    runPlay(level);
  } else {
    if (playQueue.length >= MAX_QUEUE_SIZE) {
      const dropped = playQueue.shift();
      log.debug(`通知音キューが上限 (${MAX_QUEUE_SIZE}) に達したため破棄しました: ${dropped}`);
    }
    playQueue.push(level);
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
}

// ── カスタム効果音再生 ──

function launchCustomSound(
  filePath: string,
  platform: string,
  onDone: () => void,
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
function launchCustomSoundWindows(filePath: string, onDone: () => void): ChildProcess | null {
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
    if (err) {
      log.debug(`Windows カスタム通知音の再生に失敗しました: ${err.message}`);
    }
    onDone();
  });
  return proc;
}

/** macOS: afplay で mp3/wav を再生 */
function launchCustomSoundMacOS(filePath: string, onDone: () => void): ChildProcess | null {
  const proc = execFile("afplay", [filePath], (err) => {
    if (err) {
      log.debug(`macOS カスタム通知音の再生に失敗しました: ${err.message}`);
    }
    onDone();
  });
  return proc as unknown as ChildProcess;
}

/** Linux: ffplay → paplay → aplay のフォールバック */
function launchCustomSoundLinux(filePath: string, onDone: () => void): ChildProcess | null {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".mp3") {
    // mp3 は ffplay で再生
    const proc = execFile("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath], (err) => {
      if (err) {
        log.debug(`Linux ffplay での再生に失敗しました: ${err.message}`);
        printBell();
      }
      onDone();
    });
    return proc as unknown as ChildProcess;
  } else {
    // wav は paplay → aplay のフォールバック
    const proc = execFile("paplay", [filePath], (err) => {
      if (err) {
        execFile("aplay", ["-q", filePath], (err2) => {
          if (err2) {
            log.debug(`Linux 通知音の再生に失敗しました: ${err2.message}`);
            printBell();
          }
          onDone();
        });
      } else {
        onDone();
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

function launchSystemSoundWindows(level: SoundLevel, onDone: () => void): ChildProcess | null {
  const soundPath = findWindowsSystemSound(level);
  if (soundPath == null) {
    log.debug(`Windows 通知音が見つかりません。bell にフォールバックします: ${WINDOWS_SOUNDS[level]}`);
    printBell();
    onDone();
    return null;
  }
  const psCommand = `(New-Object System.Media.SoundPlayer '${soundPath}').PlaySync()`;
  const proc = execFile("powershell", ["-NoProfile", "-Command", psCommand], (err) => {
    if (err) {
      log.debug(`Windows 通知音の再生に失敗しました: ${err.message}`);
    }
    onDone();
  });
  return proc;
}

function launchSystemSoundMacOS(level: SoundLevel, onDone: () => void): ChildProcess | null {
  const soundFile = MACOS_SOUNDS[level];
  const soundPath = `/System/Library/Sounds/${soundFile}`;
  const proc = execFile("afplay", [soundPath], (err) => {
    if (err) {
      log.debug(`macOS 通知音の再生に失敗しました: ${err.message}`);
    }
    onDone();
  });
  return proc as unknown as ChildProcess;
}

function launchSystemSoundLinux(level: SoundLevel, onDone: () => void): ChildProcess | null {
  const eventName = LINUX_CANBERRA_EVENTS[level];

  if (eventName === "bell") {
    printBell();
    onDone();
    return null;
  }

  const proc = execFile("canberra-gtk-play", ["-i", eventName], (err) => {
    if (err) {
      log.debug(`canberra-gtk-play 失敗、bell にフォールバック: ${err.message}`);
      printBell();
    }
    onDone();
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
