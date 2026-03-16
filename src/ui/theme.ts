import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { getConfigDir } from "../config";
import * as log from "../logger";

// ── 型定義 ──

/** パレット色名（CUD 9色） */
export type PaletteColorName =
  | "gray"
  | "sky"
  | "blue"
  | "blueGreen"
  | "yellow"
  | "orange"
  | "vermillion"
  | "raspberry"
  | "darkRed";

export type RgbTuple = readonly [number, number, number];

/** HEX文字列 "#RRGGBB" */
type HexColor = string;

/** ロールのスタイル定義（ファイル上の形式） */
export type RoleStyleDef =
  | string
  | {
      bg?: string; // パレット名 or HEX
      fg?: string; // パレット名 or HEX
      bold?: boolean;
    };

/** RoleStyleDef の型ガード */
function isRoleStyleDef(value: unknown): value is RoleStyleDef {
  if (typeof value === "string") return true;
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.fg == null || typeof v.fg === "string") &&
    (v.bg == null || typeof v.bg === "string") &&
    (v.bold == null || typeof v.bold === "boolean")
  );
}

/** 解決済みスタイル */
export interface ResolvedStyle {
  fg?: RgbTuple;
  bg?: RgbTuple;
  bold: boolean;
}

/** テーマファイルの構造 */
export interface ThemeFile {
  palette?: Partial<Record<string, string>>;
  roles?: Partial<Record<string, RoleStyleDef>>;
}

/** 解決済みテーマ */
export interface ResolvedTheme {
  palette: Record<PaletteColorName, RgbTuple>;
  roles: Record<RoleName, ResolvedStyle>;
}

// ── デフォルトパレット ──

/** CUD 推奨色のデフォルト RGB 値 */
export const DEFAULT_PALETTE: Record<PaletteColorName, RgbTuple> = {
  gray: [132, 145, 158],
  sky: [86, 180, 233],
  blue: [0, 114, 178],
  blueGreen: [0, 158, 115],
  yellow: [240, 228, 66],
  orange: [230, 159, 0],
  vermillion: [213, 94, 0],
  raspberry: [204, 121, 167],
  darkRed: [122, 30, 0],
};

/** パレット色名の一覧 */
const PALETTE_NAMES: PaletteColorName[] = [
  "gray",
  "sky",
  "blue",
  "blueGreen",
  "yellow",
  "orange",
  "vermillion",
  "raspberry",
  "darkRed",
];

// ── デフォルトロール ──

/** セマンティックロール定義 */
export const DEFAULT_ROLES = {
  // frame
  frameCritical: "vermillion" as RoleStyleDef,
  frameWarning: "orange" as RoleStyleDef,
  frameNormal: "sky" as RoleStyleDef,
  frameInfo: "gray" as RoleStyleDef,
  frameCancel: "raspberry" as RoleStyleDef,

  // intensity
  intensity1: "gray" as RoleStyleDef,
  intensity2: "sky" as RoleStyleDef,
  intensity3: "blue" as RoleStyleDef,
  intensity4: "blueGreen" as RoleStyleDef,
  intensity5Lower: "yellow" as RoleStyleDef,
  intensity5Upper: "orange" as RoleStyleDef,
  intensity6Lower: { fg: "vermillion", bold: true } as RoleStyleDef,
  intensity6Upper: { bg: "vermillion", fg: "#000000", bold: true } as RoleStyleDef,
  intensity7: { bg: "darkRed", fg: "#FFFFFF", bold: true } as RoleStyleDef,

  // lgIntensity
  lgInt0: "gray" as RoleStyleDef,
  lgInt1: "sky" as RoleStyleDef,
  lgInt2: "yellow" as RoleStyleDef,
  lgInt3: "orange" as RoleStyleDef,
  lgInt4: { bg: "vermillion", fg: "#000000", bold: true } as RoleStyleDef,

  // magnitude
  magnitudeLow: "yellow" as RoleStyleDef,
  magnitudeHigh: { fg: "vermillion", bold: true } as RoleStyleDef,
  magnitudeMax: { bg: "darkRed", fg: "#FFFFFF", bold: true } as RoleStyleDef,

  // tsunami
  tsunamiNone: "blueGreen" as RoleStyleDef,
  tsunamiAdvisory: "orange" as RoleStyleDef,
  tsunamiWarning: { fg: "vermillion", bold: true } as RoleStyleDef,
  tsunamiMajor: { bg: "darkRed", fg: "#FFFFFF", bold: true } as RoleStyleDef,

  // eew
  eewWarningBanner: { bg: "darkRed", fg: "#FFFFFF", bold: true } as RoleStyleDef,
  eewForecastBanner: { bg: "yellow", fg: "#000000", bold: true } as RoleStyleDef,
  eewCancelBanner: { bg: "raspberry", fg: "#000000", bold: true } as RoleStyleDef,
  plumLabel: "raspberry" as RoleStyleDef,
  arrivedLabel: "vermillion" as RoleStyleDef,
  cancelText: "raspberry" as RoleStyleDef,

  // common
  testBadge: { bg: "raspberry", fg: "#FFFFFF", bold: true } as RoleStyleDef,
  hypocenter: { fg: "yellow", bold: true } as RoleStyleDef,
  concurrent: "orange" as RoleStyleDef,
  nextAdvisory: "sky" as RoleStyleDef,
  warningComment: "orange" as RoleStyleDef,
  detailUri: "sky" as RoleStyleDef,
  textMuted: "gray" as RoleStyleDef,

  // tsunami banner
  tsunamiAdvisoryBanner: { bg: "yellow", fg: "#000000", bold: true } as RoleStyleDef,
  tsunamiWarningBanner: { bg: "vermillion", fg: "#FFFFFF", bold: true } as RoleStyleDef,
  tsunamiMajorBanner: { bg: "darkRed", fg: "#FFFFFF", bold: true } as RoleStyleDef,
  tsunamiMajorBannerDecor: { bg: "#FFFFFF", fg: "#000000", bold: true } as RoleStyleDef,

  // nankai trough
  nankaiCriticalBanner: { bg: "darkRed", fg: "#FFFFFF", bold: true } as RoleStyleDef,
  nankaiWarningBanner: { bg: "orange", fg: "#000000", bold: true } as RoleStyleDef,
  nankaiSerialCritical: { fg: "vermillion", bold: true } as RoleStyleDef,
  nankaiSerialWarning: { fg: "orange", bold: true } as RoleStyleDef,

  // eew banner palette (additional colors)
  eewWarningBanner1: { bg: "vermillion", fg: "#FFFFFF", bold: true } as RoleStyleDef,
  eewWarningBanner2: { bg: "vermillion", fg: "#000000", bold: true } as RoleStyleDef,
  eewWarningBanner3: { bg: "orange", fg: "#000000", bold: true } as RoleStyleDef,
  eewWarningBanner4: { bg: "raspberry", fg: "#000000", bold: true } as RoleStyleDef,
  eewForecastBanner1: { bg: "orange", fg: "#000000", bold: true } as RoleStyleDef,
  eewForecastBanner2: { bg: "sky", fg: "#000000", bold: true } as RoleStyleDef,
  eewForecastBanner3: { bg: "blueGreen", fg: "#000000", bold: true } as RoleStyleDef,
  eewForecastBanner4: { bg: "gray", fg: "#FFFFFF", bold: true } as RoleStyleDef,

  // plum decor
  plumDecorWarning: { bg: "blue", fg: "#FFFFFF", bold: true } as RoleStyleDef,
  plumDecorForecast: { bg: "sky", fg: "#000000", bold: true } as RoleStyleDef,

  // raw header
  rawHeaderLabel: "sky" as RoleStyleDef,
} as const;

/** ロール名の型 */
export type RoleName = keyof typeof DEFAULT_ROLES;

/** ロール名の一覧 */
const ROLE_NAMES = Object.keys(DEFAULT_ROLES) as RoleName[];

// ── ユーティリティ関数 ──

/** HEX文字列を RGB タプルに変換。不正なら null */
export function hexToRgb(hex: string): RgbTuple | null {
  const m = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(hex);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** RGB タプルを HEX 文字列に変換 */
export function rgbToHex(rgb: RgbTuple): HexColor {
  const r = rgb[0].toString(16).padStart(2, "0").toUpperCase();
  const g = rgb[1].toString(16).padStart(2, "0").toUpperCase();
  const b = rgb[2].toString(16).padStart(2, "0").toUpperCase();
  return `#${r}${g}${b}`;
}

// ── テーマ解決 ──

/** 色参照（パレット名 or HEX）を解決する */
function resolveColorRef(
  ref: string,
  palette: Record<PaletteColorName, RgbTuple>,
): { rgb: RgbTuple | null; warning?: string } {
  // パレット名参照
  if (PALETTE_NAMES.includes(ref as PaletteColorName)) {
    return { rgb: palette[ref as PaletteColorName] };
  }
  // HEX値
  if (ref.startsWith("#")) {
    const rgb = hexToRgb(ref);
    if (rgb) return { rgb };
    return { rgb: null, warning: `不正なHEX値: "${ref}"` };
  }
  return { rgb: null, warning: `不明な色参照: "${ref}" (パレット名または #RRGGBB を指定してください)` };
}

/** RoleStyleDef を解決して ResolvedStyle にする */
function resolveRoleStyle(
  def: RoleStyleDef,
  palette: Record<PaletteColorName, RgbTuple>,
): { style: ResolvedStyle; warnings: string[] } {
  const warnings: string[] = [];

  if (typeof def === "string") {
    // 文字列 → 前景色のみ
    const { rgb, warning } = resolveColorRef(def, palette);
    if (warning) warnings.push(warning);
    return {
      style: { fg: rgb ?? undefined, bold: false },
      warnings,
    };
  }

  // オブジェクト
  let fg: RgbTuple | undefined;
  let bg: RgbTuple | undefined;

  if (def.fg != null) {
    const result = resolveColorRef(def.fg, palette);
    if (result.warning) warnings.push(`fg: ${result.warning}`);
    fg = result.rgb ?? undefined;
  }
  if (def.bg != null) {
    const result = resolveColorRef(def.bg, palette);
    if (result.warning) warnings.push(`bg: ${result.warning}`);
    bg = result.rgb ?? undefined;
  }

  return {
    style: { fg, bg, bold: def.bold ?? false },
    warnings,
  };
}

/** パース済みオブジェクトを ThemeFile として安全に変換する */
function sanitizeThemeInput(parsed: Record<string, unknown>): { themeFile: ThemeFile; warnings: string[] } {
  const warnings: string[] = [];
  const themeFile: ThemeFile = {};

  if ("palette" in parsed) {
    if (typeof parsed.palette === "object" && parsed.palette != null && !Array.isArray(parsed.palette)) {
      themeFile.palette = parsed.palette as Record<string, string>;
    } else {
      warnings.push("palette はオブジェクトである必要があります。無視します。");
    }
  }
  if ("roles" in parsed) {
    if (typeof parsed.roles === "object" && parsed.roles != null && !Array.isArray(parsed.roles)) {
      themeFile.roles = parsed.roles as Record<string, RoleStyleDef>;
    } else {
      warnings.push("roles はオブジェクトである必要があります。無視します。");
    }
  }
  return { themeFile, warnings };
}

/** 純粋関数: ThemeFile → ResolvedTheme + 警告リスト */
export function resolveTheme(
  raw: ThemeFile,
  defaults: { palette: Record<PaletteColorName, RgbTuple>; roles: typeof DEFAULT_ROLES },
): { theme: ResolvedTheme; warnings: string[] } {
  const warnings: string[] = [];

  // パレット解決
  const palette = { ...defaults.palette };
  if (raw.palette) {
    for (const [key, value] of Object.entries(raw.palette)) {
      if (!PALETTE_NAMES.includes(key as PaletteColorName)) {
        warnings.push(`palette: 未知のキー "${key}" を無視しました`);
        continue;
      }
      if (typeof value !== "string") {
        warnings.push(`palette.${key}: 値は文字列(HEX)である必要があります`);
        continue;
      }
      const rgb = hexToRgb(value);
      if (!rgb) {
        warnings.push(`palette.${key}: 不正なHEX値 "${value}"`);
        continue;
      }
      palette[key as PaletteColorName] = rgb;
    }
  }

  // ロール解決
  const roles: Record<string, ResolvedStyle> = {};

  for (const roleName of ROLE_NAMES) {
    const rawRole = raw.roles?.[roleName];
    if (rawRole != null && !isRoleStyleDef(rawRole)) {
      warnings.push(`roles.${roleName}: 不正な値の形式です (文字列またはオブジェクト{fg?,bg?,bold?}を指定してください)`);
      const fallback = resolveRoleStyle(defaults.roles[roleName], palette);
      roles[roleName] = fallback.style;
      continue;
    }
    const def = rawRole ?? defaults.roles[roleName];
    const { style, warnings: roleWarnings } = resolveRoleStyle(def, palette);
    for (const w of roleWarnings) {
      warnings.push(`roles.${roleName}: ${w}`);
    }
    // 解決失敗時はデフォルトにフォールバック
    if (rawRole != null && roleWarnings.length > 0) {
      const fallback = resolveRoleStyle(defaults.roles[roleName], palette);
      roles[roleName] = fallback.style;
    } else {
      roles[roleName] = style;
    }
  }

  // 未知の roles キーをチェック
  if (raw.roles) {
    for (const key of Object.keys(raw.roles)) {
      if (!ROLE_NAMES.includes(key as RoleName)) {
        warnings.push(`roles: 未知のキー "${key}" を無視しました`);
      }
    }
  }

  return {
    theme: { palette, roles: roles as Record<RoleName, ResolvedStyle> },
    warnings,
  };
}

// ── デフォルトテーマの事前解決 ──

/** テーマオブジェクトを再帰的にフリーズする */
function deepFreezeTheme(theme: ResolvedTheme): ResolvedTheme {
  Object.freeze(theme.palette);
  for (const rgb of Object.values(theme.palette)) Object.freeze(rgb);
  Object.freeze(theme.roles);
  for (const style of Object.values(theme.roles)) Object.freeze(style);
  Object.freeze(theme);
  return theme;
}

function buildDefaultResolvedTheme(): ResolvedTheme {
  const { theme } = resolveTheme({}, { palette: DEFAULT_PALETTE, roles: DEFAULT_ROLES });
  return deepFreezeTheme(theme);
}

// ── モジュール状態 ──

let currentTheme: ResolvedTheme = buildDefaultResolvedTheme();

// ── パス解決 ──

/** theme.json のパスを返す */
export function getThemePath(): string {
  return path.join(getConfigDir(), "theme.json");
}

// ── テーマ読込 ──

/** ファイルからテーマを読み込み、キャッシュを更新する。警告リストを返す。 */
export function loadTheme(): string[] {
  return loadThemeFromPath(getThemePath());
}

/** パス指定でテーマを読み込む (テスト用) */
export function loadThemeFromPath(themePath: string): string[] {
  chalkCache.clear();

  if (!fs.existsSync(themePath)) {
    currentTheme = buildDefaultResolvedTheme();
    return [];
  }

  try {
    const raw = fs.readFileSync(themePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
      currentTheme = buildDefaultResolvedTheme();
      return ["theme.json の形式が不正です。デフォルトテーマを使用します。"];
    }
    const { themeFile, warnings: sanitizeWarnings } = sanitizeThemeInput(parsed as Record<string, unknown>);
    const { theme, warnings } = resolveTheme(themeFile, {
      palette: DEFAULT_PALETTE,
      roles: DEFAULT_ROLES,
    });
    currentTheme = deepFreezeTheme(theme);
    return [...sanitizeWarnings, ...warnings];
  } catch (err) {
    currentTheme = buildDefaultResolvedTheme();
    if (err instanceof SyntaxError) {
      return ["theme.json のJSONパースに失敗しました。デフォルトテーマを使用します。"];
    }
    if (err instanceof Error) {
      return [`theme.json の読み込みに失敗しました: ${err.message}`];
    }
    return ["theme.json の読み込みに失敗しました。"];
  }
}

/** テーマを再読込する */
export function reloadTheme(): string[] {
  return loadTheme();
}

/** デフォルト theme.json を書き出し、リロードする */
export function resetTheme(): string[] {
  const themePath = getThemePath();
  const dir = path.dirname(themePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(themePath, generateDefaultThemeJson(), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (err) {
    if (err instanceof Error) {
      return [`theme.json の書き出しに失敗しました: ${err.message}`];
    }
    return ["theme.json の書き出しに失敗しました。"];
  }
  return loadThemeFromPath(themePath);
}

/** theme.json を検証し、問題点を返す */
export function validateThemeFile(): { valid: boolean; warnings: string[] } {
  const themePath = getThemePath();
  if (!fs.existsSync(themePath)) {
    return { valid: true, warnings: ["theme.json が見つかりません (デフォルトテーマを使用中)"] };
  }

  try {
    const raw = fs.readFileSync(themePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
      return { valid: false, warnings: ["theme.json の形式が不正です (オブジェクトである必要があります)"] };
    }
    const { themeFile, warnings: sanitizeWarnings } = sanitizeThemeInput(parsed as Record<string, unknown>);
    const { warnings } = resolveTheme(themeFile, {
      palette: DEFAULT_PALETTE,
      roles: DEFAULT_ROLES,
    });
    const allWarnings = [...sanitizeWarnings, ...warnings];
    return { valid: allWarnings.length === 0, warnings: allWarnings };
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { valid: false, warnings: [`JSONパースエラー: ${err.message}`] };
    }
    if (err instanceof Error) {
      return { valid: false, warnings: [`読み込みエラー: ${err.message}`] };
    }
    return { valid: false, warnings: ["不明なエラー"] };
  }
}

// ── テーマアクセサ ──

/** 解決済みパレットを返す */
export function getPalette(): Record<PaletteColorName, RgbTuple> {
  return currentTheme.palette;
}

/** 解決済みロールスタイルを返す */
export function getRole(name: RoleName): ResolvedStyle {
  return currentTheme.roles[name];
}

let chalkCache = new Map<string, chalk.Chalk>();

/** ResolvedStyle → chalk.Chalk に変換して返す (キャッシュ付き) */
export function getRoleChalk(name: RoleName): chalk.Chalk {
  const key = `${chalk.level}:${name}`;
  const cached = chalkCache.get(key);
  if (cached) return cached;
  const built = styleToChalk(currentTheme.roles[name]);
  chalkCache.set(key, built);
  return built;
}

/** ResolvedStyle を chalk.Chalk に変換する */
function styleToChalk(style: ResolvedStyle): chalk.Chalk {
  let c: chalk.Chalk = chalk;
  if (style.bg) {
    c = c.bgRgb(style.bg[0], style.bg[1], style.bg[2]);
  }
  if (style.fg) {
    c = c.rgb(style.fg[0], style.fg[1], style.fg[2]);
  }
  if (style.bold) {
    c = c.bold;
  }
  return c;
}

/** theme.json がカスタマイズされているか (ファイルが存在するか) */
export function isCustomized(): boolean {
  return fs.existsSync(getThemePath());
}

/** 解決済みテーマ全体を返す */
export function getResolvedTheme(): ResolvedTheme {
  return currentTheme;
}

/** 全ロール名の一覧を返す */
export function getRoleNames(): RoleName[] {
  return [...ROLE_NAMES];
}

/** 全パレット色名の一覧を返す */
export function getPaletteNames(): PaletteColorName[] {
  return [...PALETTE_NAMES];
}

// ── デフォルト theme.json 生成 ──

/** デフォルト theme.json の内容を JSON 文字列で返す */
export function generateDefaultThemeJson(): string {
  const paletteObj: Record<string, string> = {};
  for (const name of PALETTE_NAMES) {
    paletteObj[name] = rgbToHex(DEFAULT_PALETTE[name]);
  }

  const rolesObj: Record<string, RoleStyleDef> = {};
  for (const name of ROLE_NAMES) {
    rolesObj[name] = DEFAULT_ROLES[name];
  }

  return JSON.stringify({ palette: paletteObj, roles: rolesObj }, null, 2) + "\n";
}
