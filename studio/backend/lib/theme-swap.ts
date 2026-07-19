// グローバル theme を一時 swap するため再入不可。
// 必ず render-mutex の直列化の内側から呼ぶこと (render-engine 経由)。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadThemeFromPath,
  loadTheme,
  type ThemeFile,
} from "../../../src/ui/theme";

let counter = 0;

export async function withThemeSwap(
  override: ThemeFile,
  fn: () => Promise<unknown>,
): Promise<string[]> {
  const tmpDir = os.tmpdir();
  const tmpName = `fleq-studio-theme-${process.pid}-${counter++}.json`;
  const tmpPath = path.join(tmpDir, tmpName);

  let warnings: string[] = [];
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(override), { mode: 0o600 });
    warnings = loadThemeFromPath(tmpPath);
    await fn();
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort
    }
    // ユーザの theme.json から復元 (存在しない場合は default テーマに戻る)
    loadTheme();
  }
  return warnings;
}
