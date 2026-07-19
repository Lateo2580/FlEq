import * as fs from "fs";
import { getThemePath, validateThemeFile, type ThemeFile } from "../../../src/ui/theme";
import { isThemeFileShape } from "./theme-file-guard";

/**
 * theme.json の raw 読込。形式不正は { saved: null } に落とす (fail-safe)。
 * warnings は validateThemeFile() (theme.ts:527、ディスク上の検証専用 API) から取る —
 * 不正 HEX 等が「最初の render まで無言」にならないようにする (レビュー反映)。
 * theme route (GET /api/theme) と diff route (baseline 解決) が共用する。
 */
export function readSavedTheme(): { saved: ThemeFile | null; warnings: string[] } {
  const p = getThemePath();
  if (!fs.existsSync(p)) return { saved: null, warnings: [] };
  const { warnings } = validateThemeFile();
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (!isThemeFileShape(parsed)) {
      return { saved: null, warnings: warnings.length > 0 ? warnings : ["theme.json の形式が不正です"] };
    }
    return { saved: parsed, warnings };
  } catch {
    return { saved: null, warnings: warnings.length > 0 ? warnings : ["theme.json の JSON パースに失敗しました"] };
  }
}
