// 表示ブロックレイアウト設定 (display-layout.json) のローダと resolver。
// theme.ts の作法 (警告リスト返し・デフォルトフォールバック) を踏襲する。
// spec: 設計メモ 2026-06-10-display-studio-phase2-block-layout-design.md

import * as fs from "fs";
import * as path from "path";
import { getConfigDir } from "../config";

// ── 型定義 ──

/** body ブロック id。registry (weather-core-blocks.ts) との一致は registry 側のテストで担保 */
export type WeatherBlockId = "table" | "unknown" | "comments" | "actionGuide";

export const VALID_BLOCK_IDS: readonly WeatherBlockId[] = [
  "table",
  "unknown",
  "comments",
  "actionGuide",
];

/** validation を通過した解決済み layout。formatter はこの型しか受け取らない */
export interface ResolvedWeatherCoreLayout {
  banner: boolean;
  footer: boolean;
  body: WeatherBlockId[];
  tableOverflowDetail: boolean;
}

export const DEFAULT_WEATHER_CORE_LAYOUT: ResolvedWeatherCoreLayout = {
  banner: true,
  footer: true,
  body: ["table", "unknown", "comments", "actionGuide"],
  tableOverflowDetail: true,
};

export interface LayoutResolution {
  layout: ResolvedWeatherCoreLayout;
  errors: string[];
  warnings: string[];
}

function defaultLayoutCopy(): ResolvedWeatherCoreLayout {
  return { ...DEFAULT_WEATHER_CORE_LAYOUT, body: [...DEFAULT_WEATHER_CORE_LAYOUT.body] };
}

// ── 共通 resolver (純粋関数) ──
// singleton ロードと Studio の per-call 解決の両方がここを通る (挙動差を防ぐ)。
// error がある場合は fail-safe としてデフォルト layout を返す。

function readBool(
  value: unknown,
  field: string,
  fallback: boolean,
  warnings: string[],
): boolean {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  warnings.push(`${field}: boolean である必要があります (デフォルト値を使用)`);
  return fallback;
}

const KNOWN_WEATHER_CORE_KEYS = new Set([
  "banner",
  "footer",
  "body",
  "tableOverflowDetail",
  "allowHiddenUnknown",
]);

export function resolveWeatherCoreLayout(raw: unknown): LayoutResolution {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (raw == null) {
    return { layout: defaultLayoutCopy(), errors, warnings };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("weatherCore はオブジェクトである必要があります");
    return { layout: defaultLayoutCopy(), errors, warnings };
  }
  const v = raw as Record<string, unknown>;

  // typo (例: "bodey") が黙ってデフォルト扱いになるのを防ぐ
  for (const key of Object.keys(v)) {
    if (!KNOWN_WEATHER_CORE_KEYS.has(key)) {
      warnings.push(`未知のキー "${key}" を無視しました (typo の可能性)`);
    }
  }

  const banner = readBool(v.banner, "banner", DEFAULT_WEATHER_CORE_LAYOUT.banner, warnings);
  const footer = readBool(v.footer, "footer", DEFAULT_WEATHER_CORE_LAYOUT.footer, warnings);
  const tableOverflowDetail = readBool(
    v.tableOverflowDetail,
    "tableOverflowDetail",
    DEFAULT_WEATHER_CORE_LAYOUT.tableOverflowDetail,
    warnings,
  );
  const allowHiddenUnknown = v.allowHiddenUnknown === true;

  if (tableOverflowDetail === false) {
    warnings.push(
      "tableOverflowDetail: false — narrow/standard 幅でテーブルに収まらない詳細情報が失われます",
    );
  }

  // body の解決
  let body: WeatherBlockId[];
  if (v.body == null) {
    body = [...DEFAULT_WEATHER_CORE_LAYOUT.body];
  } else if (!Array.isArray(v.body)) {
    errors.push("body: 配列である必要があります");
    return { layout: defaultLayoutCopy(), errors, warnings };
  } else {
    const seen = new Set<WeatherBlockId>();
    body = [];
    for (const item of v.body) {
      if (typeof item !== "string" || !VALID_BLOCK_IDS.includes(item as WeatherBlockId)) {
        warnings.push(`body: 未知のブロック id "${String(item)}" を無視しました`);
        continue;
      }
      const id = item as WeatherBlockId;
      if (seen.has(id)) {
        warnings.push(`body: 重複したブロック id "${id}" は初出のみ採用しました`);
        continue;
      }
      seen.add(id);
      body.push(id);
    }
  }

  // 安全制約 (error 級): spec §4.2
  if (body.length === 0) {
    errors.push("body: 空にはできません (少なくとも table と unknown が必要)");
  } else {
    if (!body.includes("table")) {
      errors.push("body: table は必須です (警報テーブルは表示の根幹)");
    }
    if (!body.includes("unknown") && !allowHiddenUnknown) {
      errors.push(
        'body: unknown を外すには "allowHiddenUnknown": true の明示が必要です (未知の警報コードが表示されなくなるため)',
      );
    }
  }
  if (body.includes("table") && !body.includes("unknown") && allowHiddenUnknown) {
    warnings.push("body: unknown が無効化されています — 未知の警報コードは表示されません");
  }

  if (errors.length > 0) {
    return { layout: defaultLayoutCopy(), errors, warnings };
  }
  return { layout: { banner, footer, body, tableOverflowDetail }, errors, warnings };
}

// ── ファイル形式 ──

interface DisplayLayoutFile {
  weatherCore?: unknown;
}

/** トップレベルの未知キー warning ("weatherCore" の typo 検出) */
function unknownFileKeyWarnings(parsed: object): string[] {
  return Object.keys(parsed)
    .filter((key) => key !== "weatherCore")
    .map((key) => `未知のキー "${key}" を無視しました (typo の可能性)`);
}

// ── モジュール状態 (singleton) ──

let currentWeatherCoreLayout: ResolvedWeatherCoreLayout = defaultLayoutCopy();

/** 解決済み weatherCore layout を返す (formatter が毎描画で呼ぶ。ファイル I/O なし) */
export function getWeatherCoreLayout(): ResolvedWeatherCoreLayout {
  return { ...currentWeatherCoreLayout, body: [...currentWeatherCoreLayout.body] };
}

/** テスト用: singleton をデフォルトに戻す (ファイル I/O なし)。test/setup.ts が毎テストで呼ぶ */
export function resetDisplayLayoutForTest(): void {
  currentWeatherCoreLayout = defaultLayoutCopy();
}

// ── パス解決 ──

/** display-layout.json のパスを返す */
export function getDisplayLayoutPath(): string {
  return path.join(getConfigDir(), "display-layout.json");
}

// ── 読込 ──

export interface LayoutLoadResult {
  errors: string[];
  warnings: string[];
}

/** display-layout.json を読み込み、singleton を更新する */
export function loadDisplayLayout(): LayoutLoadResult {
  return loadDisplayLayoutFromPath(getDisplayLayoutPath());
}

/** パス指定で読み込む (テスト用)。error 時は fail-safe でデフォルトを singleton に設定する */
export function loadDisplayLayoutFromPath(layoutPath: string): LayoutLoadResult {
  if (!fs.existsSync(layoutPath)) {
    currentWeatherCoreLayout = defaultLayoutCopy();
    return { errors: [], warnings: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(layoutPath, "utf-8"));
  } catch (err) {
    currentWeatherCoreLayout = defaultLayoutCopy();
    const msg = err instanceof SyntaxError ? "JSON パースに失敗しました" : "読み込みに失敗しました";
    return { errors: [`display-layout.json の${msg}`], warnings: [] };
  }
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    currentWeatherCoreLayout = defaultLayoutCopy();
    return { errors: ["display-layout.json はオブジェクトである必要があります"], warnings: [] };
  }
  const file = parsed as DisplayLayoutFile;
  const { layout, errors, warnings } = resolveWeatherCoreLayout(file.weatherCore);
  // resolver は error 時にデフォルトを返す (fail-safe) ため、そのまま採用してよい
  currentWeatherCoreLayout = layout;
  return { errors, warnings: [...unknownFileKeyWarnings(parsed), ...warnings] };
}

/** display-layout.json を再読込する */
export function reloadDisplayLayout(): LayoutLoadResult {
  return loadDisplayLayout();
}

// ── デフォルト書き出し ──

/** デフォルト display-layout.json の内容を JSON 文字列で返す */
export function generateDefaultDisplayLayoutJson(): string {
  const file = {
    weatherCore: {
      banner: DEFAULT_WEATHER_CORE_LAYOUT.banner,
      footer: DEFAULT_WEATHER_CORE_LAYOUT.footer,
      body: DEFAULT_WEATHER_CORE_LAYOUT.body,
      tableOverflowDetail: DEFAULT_WEATHER_CORE_LAYOUT.tableOverflowDetail,
      allowHiddenUnknown: false,
    },
  };
  return JSON.stringify(file, null, 2) + "\n";
}

/** デフォルト display-layout.json を書き出し、リロードする */
export function resetDisplayLayout(): LayoutLoadResult {
  const layoutPath = getDisplayLayoutPath();
  const dir = path.dirname(layoutPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(layoutPath, generateDefaultDisplayLayoutJson(), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "不明なエラー";
    return { errors: [`display-layout.json の書き出しに失敗しました: ${msg}`], warnings: [] };
  }
  return loadDisplayLayoutFromPath(layoutPath);
}

// ── 検証 ──

/** display-layout.json を検証し、問題点を返す (singleton は変更しない) */
export function validateDisplayLayoutFile(): { valid: boolean; errors: string[]; warnings: string[] } {
  const layoutPath = getDisplayLayoutPath();
  if (!fs.existsSync(layoutPath)) {
    return { valid: true, errors: [], warnings: ["display-layout.json が見つかりません (デフォルト設定を使用中)"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(layoutPath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "不明なエラー";
    return { valid: false, errors: [`JSON パースエラー: ${msg}`], warnings: [] };
  }
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    return { valid: false, errors: ["display-layout.json はオブジェクトである必要があります"], warnings: [] };
  }
  const { errors, warnings } = resolveWeatherCoreLayout((parsed as DisplayLayoutFile).weatherCore);
  return {
    valid: errors.length === 0,
    errors,
    warnings: [...unknownFileKeyWarnings(parsed), ...warnings],
  };
}
