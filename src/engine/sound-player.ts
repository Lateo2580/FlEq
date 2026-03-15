import { execFile, exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as log from "../logger";

/** 通知音レベル一覧 (型導出の信頼できる唯一のソース) */
export const SOUND_LEVELS = ["critical", "warning", "normal", "info", "cancel"] as const;

/** 通知音レベル */
export type SoundLevel = (typeof SOUND_LEVELS)[number];

/** 文字列が有効な SoundLevel かを判定する型ガード */
export function isSoundLevel(value: string): value is SoundLevel {
  return (SOUND_LEVELS as readonly string[]).includes(value);
}

/** カスタム効果音ディレクトリ (プロジェクトルート/assets/sounds/) */
const CUSTOM_SOUNDS_DIR = path.resolve(__dirname, "..", "..", "assets", "sounds");

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

/**
 * カスタム効果音ファイルのパスを返す。見つからなければ null。
 * mp3 → wav の順で探索する。
 */
function findCustomSound(level: SoundLevel): string | null {
  const baseName = CUSTOM_SOUND_FILES[level];
  for (const ext of SUPPORTED_EXTENSIONS) {
    const filePath = path.join(CUSTOM_SOUNDS_DIR, baseName + ext);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * 通知音を再生する (fire-and-forget)。
 * カスタム効果音ファイルがあればそちらを優先、なければ OS システムサウンドにフォールバック。
 * 再生失敗はログに記録するのみで例外は投げない。
 */
export function playSound(level: SoundLevel): void {
  try {
    const customPath = findCustomSound(level);
    const platform = process.platform;

    if (customPath) {
      playCustomSound(customPath, platform);
    } else if (platform === "win32") {
      playSystemSoundWindows(level);
    } else if (platform === "darwin") {
      playSystemSoundMacOS(level);
    } else {
      playSystemSoundLinux(level);
    }
  } catch (err) {
    if (err instanceof Error) {
      log.debug(`通知音の再生に失敗しました: ${err.message}`);
    }
  }
}

// ── カスタム効果音再生 ──

function playCustomSound(filePath: string, platform: string): void {
  if (platform === "win32") {
    playCustomSoundWindows(filePath);
  } else if (platform === "darwin") {
    playCustomSoundMacOS(filePath);
  } else {
    playCustomSoundLinux(filePath);
  }
}

/** Windows: WPF MediaPlayer で mp3/wav を再生 */
function playCustomSoundWindows(filePath: string): void {
  // MediaPlayer は mp3/wav 両対応。PlaySync 相当のため Open→Play→Sleep で待機。
  const psCommand = [
    `Add-Type -AssemblyName PresentationCore;`,
    `$p = New-Object System.Windows.Media.MediaPlayer;`,
    `$p.Open([Uri]'${filePath.replace(/'/g, "''")}');`,
    `$p.Play();`,
    `Start-Sleep -Milliseconds 100;`,
    `while($p.Position -lt $p.NaturalDuration.TimeSpan){Start-Sleep -Milliseconds 100};`,
    `$p.Close()`,
  ].join(" ");
  exec(`powershell -NoProfile -Command "${psCommand}"`, (err) => {
    if (err) {
      log.debug(`Windows カスタム通知音の再生に失敗しました: ${err.message}`);
    }
  });
}

/** macOS: afplay で mp3/wav を再生 */
function playCustomSoundMacOS(filePath: string): void {
  execFile("afplay", [filePath], (err) => {
    if (err) {
      log.debug(`macOS カスタム通知音の再生に失敗しました: ${err.message}`);
    }
  });
}

/** Linux: ffplay → paplay → aplay のフォールバック */
function playCustomSoundLinux(filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".mp3") {
    // mp3 は ffplay で再生
    execFile("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath], (err) => {
      if (err) {
        log.debug(`Linux ffplay での再生に失敗しました: ${err.message}`);
        printBell();
      }
    });
  } else {
    // wav は paplay → aplay のフォールバック
    execFile("paplay", [filePath], (err) => {
      if (err) {
        execFile("aplay", ["-q", filePath], (err2) => {
          if (err2) {
            log.debug(`Linux 通知音の再生に失敗しました: ${err2.message}`);
            printBell();
          }
        });
      }
    });
  }
}

// ── システムサウンドフォールバック ──

function playSystemSoundWindows(level: SoundLevel): void {
  const soundFile = WINDOWS_SOUNDS[level];
  const soundPath = path.join(
    process.env.SYSTEMROOT || "C:\\Windows",
    "Media",
    soundFile
  );
  const psCommand = `(New-Object System.Media.SoundPlayer '${soundPath}').PlaySync()`;
  exec(`powershell -NoProfile -Command "${psCommand}"`, (err) => {
    if (err) {
      log.debug(`Windows 通知音の再生に失敗しました: ${err.message}`);
    }
  });
}

function playSystemSoundMacOS(level: SoundLevel): void {
  const soundFile = MACOS_SOUNDS[level];
  const soundPath = `/System/Library/Sounds/${soundFile}`;
  execFile("afplay", [soundPath], (err) => {
    if (err) {
      log.debug(`macOS 通知音の再生に失敗しました: ${err.message}`);
    }
  });
}

function playSystemSoundLinux(level: SoundLevel): void {
  const eventName = LINUX_CANBERRA_EVENTS[level];

  if (eventName === "bell") {
    printBell();
    return;
  }

  execFile("canberra-gtk-play", ["-i", eventName], (err) => {
    if (err) {
      log.debug(`canberra-gtk-play 失敗、bell にフォールバック: ${err.message}`);
      printBell();
    }
  });
}

function printBell(): void {
  try {
    process.stdout.write("\x07");
  } catch {
    // ignore
  }
}
