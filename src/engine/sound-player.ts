import { execFile, exec } from "child_process";
import * as path from "path";
import * as log from "../logger";

/** 通知音レベル */
export type SoundLevel = "critical" | "warning" | "normal" | "info" | "cancel";

/** Windows サウンドファイルマッピング */
const WINDOWS_SOUNDS: Record<SoundLevel, string> = {
  critical: "Windows Critical Stop.wav",
  warning: "Windows Exclamation.wav",
  normal: "Windows Notify Calendar.wav",
  info: "Windows Notify Email.wav",
  cancel: "Windows Recycle.wav",
};

/** macOS サウンドファイルマッピング */
const MACOS_SOUNDS: Record<SoundLevel, string> = {
  critical: "Sosumi.aiff",
  warning: "Basso.aiff",
  normal: "Glass.aiff",
  info: "Tink.aiff",
  cancel: "Pop.aiff",
};

/** Linux canberra イベント名マッピング */
const LINUX_CANBERRA_EVENTS: Record<SoundLevel, string> = {
  critical: "dialog-error",
  warning: "dialog-warning",
  normal: "message-new-instant",
  info: "dialog-information",
  cancel: "bell",
};

/**
 * 通知音を再生する (fire-and-forget)。
 * OS ネイティブコマンドを使用し、追加依存なし。
 * 再生失敗はログに記録するのみで例外は投げない。
 */
export function playSound(level: SoundLevel): void {
  try {
    const platform = process.platform;
    if (platform === "win32") {
      playSoundWindows(level);
    } else if (platform === "darwin") {
      playSoundMacOS(level);
    } else {
      playSoundLinux(level);
    }
  } catch (err) {
    if (err instanceof Error) {
      log.debug(`通知音の再生に失敗しました: ${err.message}`);
    }
  }
}

function playSoundWindows(level: SoundLevel): void {
  const soundFile = WINDOWS_SOUNDS[level];
  const soundPath = path.join(
    process.env.SYSTEMROOT || "C:\\Windows",
    "Media",
    soundFile
  );
  // PowerShell で .NET の SoundPlayer を使って再生
  const psCommand = `(New-Object System.Media.SoundPlayer '${soundPath}').PlaySync()`;
  exec(`powershell -NoProfile -Command "${psCommand}"`, (err) => {
    if (err) {
      log.debug(`Windows 通知音の再生に失敗しました: ${err.message}`);
    }
  });
}

function playSoundMacOS(level: SoundLevel): void {
  const soundFile = MACOS_SOUNDS[level];
  const soundPath = `/System/Library/Sounds/${soundFile}`;
  execFile("afplay", [soundPath], (err) => {
    if (err) {
      log.debug(`macOS 通知音の再生に失敗しました: ${err.message}`);
    }
  });
}

function playSoundLinux(level: SoundLevel): void {
  const eventName = LINUX_CANBERRA_EVENTS[level];

  // canberra-gtk-play → paplay → ターミナルbell のフォールバック
  if (eventName === "bell") {
    printBell();
    return;
  }

  execFile("canberra-gtk-play", ["-i", eventName], (err) => {
    if (err) {
      log.debug(`canberra-gtk-play 失敗、paplay にフォールバック: ${err.message}`);
      // paplay で XDG サウンドテーマのファイルを直接再生するのは難しいので bell にフォールバック
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
