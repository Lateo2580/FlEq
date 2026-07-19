import type { ThemeFile } from "../../../src/ui/theme";
import { setNightMode, isNightMode } from "../../../src/ui/theme";
import { setFrameWidth, getFrameWidth } from "../../../src/ui/formatter";
import { loadFixture } from "./fixture-loader";
import { withStdoutCapture } from "./stdout-capture";
import { withThemeSwap } from "./theme-swap";
import { withRenderMutex } from "./render-mutex";
import { findWeatherEntry } from "../registry/weather-registry";
import { readSavedTheme } from "./saved-theme";

export interface RenderOptions {
  compact: boolean; // Phase 1d: registry の compactLine (renderSummaryLine 経由) で対応
  width: number;
  noColor: boolean;
  nightMode: boolean;
}

export interface RenderRequest {
  fixtureId: string;
  themeOverride: ThemeFile;
  options: RenderOptions;
}

export interface RenderResult {
  ansi: string;
  warnings: string[];
  durationMs: number;
}

export interface DiffResult {
  before: string;
  after: string;
  warnings: string[]; // after 側 + 保存側 (before: prefix) の warnings
  durationMs: number;
}

export async function render(req: RenderRequest): Promise<RenderResult> {
  return await withRenderMutex(() => renderInner(req));
}

/**
 * before (保存済み theme.json、無ければデフォルト) と after (themeOverride) を
 * 1 回の mutex 保持で逐次 render する (spec §5.3)。間に save が割り込んで
 * baseline がずれるのを防ぐため、render() を 2 回呼ぶのではなく renderInner を使う
 * (withRenderMutex はネスト再入するとデッドロックするため、この分離は必須)。
 */
export async function renderDiff(req: RenderRequest): Promise<DiffResult> {
  return await withRenderMutex(async () => {
    const start = Date.now();
    const { saved, warnings: savedWarnings } = readSavedTheme();
    const beforeResult = await renderInner({
      fixtureId: req.fixtureId,
      themeOverride: saved ?? {},
      options: req.options,
    });
    const afterResult = await renderInner(req);
    return {
      before: beforeResult.ansi,
      after: afterResult.ansi,
      // 保存側の不正 (壊れた theme.json 等) も diff モードで見えるよう prefix 付きでマージ (レビュー反映)
      warnings: [...savedWarnings.map((w) => `before: ${w}`), ...afterResult.warnings],
      durationMs: Date.now() - start,
    };
  });
}

/**
 * 現在のテーマと、指定ロールだけを番兵色に置換したテーマを同じ mutex 内で描画する。
 * frontend は両方を diff-lines に渡し、ロールが使われたプレビュー行を強調する。
 */
export async function renderRoleHighlight(req: RenderRequest, roleName: string): Promise<DiffResult> {
  return await withRenderMutex(async () => {
    const start = Date.now();
    const beforeResult = await renderInner(req);
    const afterResult = await renderInner({
      ...req,
      themeOverride: {
        ...req.themeOverride,
        roles: { ...req.themeOverride.roles, [roleName]: "#ff00ff" },
      },
    });
    return {
      before: beforeResult.ansi,
      after: afterResult.ansi,
      warnings: [...beforeResult.warnings.map((w) => `before: ${w}`), ...afterResult.warnings],
      durationMs: Date.now() - start,
    };
  });
}

/** render 本体 (mutex なし)。必ず withRenderMutex の内側から呼ぶこと。 */
async function renderInner(req: RenderRequest): Promise<RenderResult> {
  const start = Date.now();
  let ansi = "";
  let warnings: string[] = [];

  warnings = await withThemeSwap(req.themeOverride, async () => {
    const previousWidth = getFrameWidth();
    const previousNight = isNightMode();
    setNightMode(req.options.nightMode);
    setFrameWidth(req.options.width);

    try {
      ansi = await withStdoutCapture({ noColor: req.options.noColor }, async () => {
        const msg = loadFixture(req.fixtureId);
        if (msg == null) {
          throw new Error(`fixture が見つからない: ${req.fixtureId}`);
        }
        const entry = findWeatherEntry(req.fixtureId);
        if (entry == null) {
          throw new Error(`未対応の電文タイプ: ${req.fixtureId}`);
        }
        const parsed = entry.parse(msg);
        if (parsed == null) {
          throw new Error(`parse 失敗: ${req.fixtureId}`);
        }
        if (req.options.compact) {
          if (entry.compactLine == null) {
            // 「未対応」を含むメッセージ → routes/render.ts の 400 判定に乗る
            throw new Error(`compact プレビューは未対応の電文タイプ: ${req.fixtureId}`);
          }
          console.log(entry.compactLine(msg, parsed, req.options.width));
        } else {
          const eewCtx = entry.eewContext?.(msg, parsed);
          if (eewCtx != null) {
            entry.format(parsed, eewCtx);
          } else {
            entry.format(parsed);
          }
        }
      });
    } finally {
      setFrameWidth(previousWidth);
      setNightMode(previousNight);
    }
  });

  return {
    ansi,
    warnings,
    durationMs: Date.now() - start,
  };
}
