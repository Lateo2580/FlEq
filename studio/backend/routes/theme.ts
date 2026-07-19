import * as fs from "fs";
import * as path from "path";
import { Hono } from "hono";
import {
  getThemePath,
  getRoleNames,
  getPaletteNames,
  generateDefaultThemeJson,
  loadTheme,
  type ThemeFile,
} from "../../../src/ui/theme";
import { ROLE_CATEGORIES } from "../lib/role-categories";
import { isThemeFileShape, normalizeThemeFile } from "../lib/theme-file-guard";
import { withRenderMutex } from "../lib/render-mutex";
import { readSavedTheme } from "../lib/saved-theme";

export function themeRoute(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const defaults = JSON.parse(generateDefaultThemeJson()) as ThemeFile;
    const { saved, warnings } = readSavedTheme();
    return c.json({
      paletteNames: getPaletteNames(),
      roleNames: getRoleNames(),
      categories: ROLE_CATEGORIES,
      defaults,
      saved,
      warnings,
    });
  });

  app.post("/save", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body は valid な JSON である必要があります" }, 400);
    }
    const theme = (body as Record<string, unknown> | null)?.theme;
    if (!isThemeFileShape(theme)) {
      return c.json({ error: "theme フィールドが不正です (ThemeFile 形式)" }, 400);
    }
    const normalized = normalizeThemeFile(theme); // 未知キーは保存しない

    // 書込 + singleton 更新は render mutex の内側で行う (レビュー反映)。
    // render-engine は mutex 内で theme singleton を swap→復元するため、
    // mutex 外の loadTheme() は実行中 render のテーマを横取りしてしまう。
    try {
      const warnings = await withRenderMutex(async () => {
        const themePath = getThemePath();
        fs.mkdirSync(path.dirname(themePath), { recursive: true, mode: 0o700 });
        if (fs.existsSync(themePath)) {
          fs.copyFileSync(themePath, themePath + ".bak"); // 1 世代退避 (spec §5.2)
        }
        // tmp に書いてから rename で置換 (書込途中の失敗で theme.json 本体を壊さない)
        const tmpPath = themePath + ".tmp";
        fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2) + "\n", {
          encoding: "utf-8",
          mode: 0o600, // theme.ts 自身の resetTheme と同じ権限 (Raspi500 で意味を持つ)
        });
        fs.renameSync(tmpPath, themePath);
        // studio プロセスの singleton を保存内容に追従させ、warnings も loadTheme から得る
        return loadTheme();
      });
      return c.json({ ok: true, warnings });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "不明なエラー";
      return c.json({ error: `theme.json の書込に失敗しました: ${msg}` }, 500);
    }
  });

  return app;
}
