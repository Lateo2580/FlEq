import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";
import {
  hexToRgb,
  rgbToHex,
  resolveTheme,
  loadThemeFromPath,
  getRoleChalk,
  getPalette,
  getRole,
  generateDefaultThemeJson,
  validateThemeFile,
  resetTheme,
  getThemePath,
  DEFAULT_PALETTE,
  DEFAULT_ROLES,
} from "../../src/ui/theme";
import type {
  ThemeFile,
  ResolvedTheme,
  PaletteColorName,
  RgbTuple,
  RoleName,
} from "../../src/ui/theme";
import * as config from "../../src/config";

// ── hexToRgb ──

describe("hexToRgb", () => {
  it("正常な HEX 文字列を RGB に変換する", () => {
    expect(hexToRgb("#FF0000")).toEqual([255, 0, 0]);
    expect(hexToRgb("#00FF00")).toEqual([0, 255, 0]);
    expect(hexToRgb("#0000FF")).toEqual([0, 0, 255]);
    expect(hexToRgb("#84919E")).toEqual([132, 145, 158]);
  });

  it("小文字 HEX も変換できる", () => {
    expect(hexToRgb("#ff0000")).toEqual([255, 0, 0]);
    expect(hexToRgb("#abcdef")).toEqual([171, 205, 239]);
  });

  it("不正な文字列は null を返す", () => {
    expect(hexToRgb("FF0000")).toBeNull();      // # なし
    expect(hexToRgb("#FFF")).toBeNull();          // 短縮形
    expect(hexToRgb("#GGGGGG")).toBeNull();       // 不正文字
    expect(hexToRgb("")).toBeNull();
    expect(hexToRgb("#12345")).toBeNull();        // 5文字
    expect(hexToRgb("#1234567")).toBeNull();      // 7文字
  });
});

// ── rgbToHex ──

describe("rgbToHex", () => {
  it("RGB を HEX に変換する", () => {
    expect(rgbToHex([255, 0, 0])).toBe("#FF0000");
    expect(rgbToHex([0, 255, 0])).toBe("#00FF00");
    expect(rgbToHex([132, 145, 158])).toBe("#84919E");
  });

  it("ラウンドトリップ: HEX → RGB → HEX", () => {
    const hex = "#D55E00";
    const rgb = hexToRgb(hex);
    expect(rgb).not.toBeNull();
    expect(rgbToHex(rgb!)).toBe(hex);
  });
});

// ── resolveTheme ──

describe("resolveTheme", () => {
  const defaults = {
    palette: DEFAULT_PALETTE,
    roles: DEFAULT_ROLES,
  };

  it("空入力で全デフォルトが返る", () => {
    const { theme, warnings } = resolveTheme({}, defaults);
    expect(warnings).toEqual([]);
    expect(theme.palette.gray).toEqual([132, 145, 158]);
    expect(theme.palette.vermillion).toEqual([213, 94, 0]);
    expect(theme.roles.frameCritical).toEqual({ fg: [213, 94, 0], bold: false });
  });

  it("パレット部分上書き", () => {
    const { theme, warnings } = resolveTheme(
      { palette: { gray: "#AABBCC" } },
      defaults,
    );
    expect(warnings).toEqual([]);
    expect(theme.palette.gray).toEqual([170, 187, 204]);
    // 他の色はデフォルト維持
    expect(theme.palette.sky).toEqual([86, 180, 233]);
  });

  it("パレット上書き → role もそのパレットを参照する", () => {
    const { theme } = resolveTheme(
      { palette: { gray: "#AABBCC" } },
      defaults,
    );
    // intensity1 は "gray" を参照 → 上書き後の値
    expect(theme.roles.intensity1.fg).toEqual([170, 187, 204]);
  });

  it("role を文字列値でパレット参照する", () => {
    const { theme, warnings } = resolveTheme(
      { roles: { frameCritical: "blue" } },
      defaults,
    );
    expect(warnings).toEqual([]);
    expect(theme.roles.frameCritical).toEqual({ fg: [0, 114, 178], bold: false });
  });

  it("role を文字列値で直接 HEX 指定する", () => {
    const { theme, warnings } = resolveTheme(
      { roles: { frameCritical: "#FF00FF" } },
      defaults,
    );
    expect(warnings).toEqual([]);
    expect(theme.roles.frameCritical).toEqual({ fg: [255, 0, 255], bold: false });
  });

  it("role をオブジェクトで fg/bg/bold 個別指定する", () => {
    const { theme, warnings } = resolveTheme(
      { roles: { testBadge: { fg: "sky", bg: "#112233", bold: true } } },
      defaults,
    );
    expect(warnings).toEqual([]);
    expect(theme.roles.testBadge).toEqual({
      fg: [86, 180, 233],
      bg: [17, 34, 51],
      bold: true,
    });
  });

  it("不正なパレット色名で警告 + デフォルト維持", () => {
    const { theme, warnings } = resolveTheme(
      { palette: { gray: "not-a-hex" } },
      defaults,
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("不正なHEX値");
    expect(theme.palette.gray).toEqual([132, 145, 158]); // デフォルト維持
  });

  it("不正な role 値で警告 + デフォルトにフォールバック", () => {
    const { theme, warnings } = resolveTheme(
      { roles: { frameCritical: "#ZZZZZZ" } },
      defaults,
    );
    expect(warnings.length).toBeGreaterThan(0);
    // デフォルトにフォールバック
    expect(theme.roles.frameCritical).toEqual({ fg: [213, 94, 0], bold: false });
  });

  it("未知のパレットキーで警告", () => {
    const { warnings } = resolveTheme(
      { palette: { unknownColor: "#FF0000" } },
      defaults,
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("未知のキー");
  });

  it("未知の roles キーで警告", () => {
    const { warnings } = resolveTheme(
      { roles: { unknownRole: "sky" } },
      defaults,
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("未知のキー");
  });

  it("不正型 role 値 (数値) で警告 + デフォルトフォールバック", () => {
    const { theme, warnings } = resolveTheme(
      { roles: { frameCritical: 123 as unknown as string } },
      defaults,
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("不正な値の形式です");
    expect(theme.roles.frameCritical).toEqual({ fg: [213, 94, 0], bold: false });
  });

  it("不正型 role 値 (配列) で警告 + デフォルトフォールバック", () => {
    const { theme, warnings } = resolveTheme(
      { roles: { frameWarning: [] as unknown as string } },
      defaults,
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("不正な値の形式です");
    expect(theme.roles.frameWarning).toEqual({ fg: [230, 159, 0], bold: false });
  });

  it("不正型 role 値 (fg が数値) で警告 + デフォルトフォールバック", () => {
    const { theme, warnings } = resolveTheme(
      { roles: { frameCritical: { fg: 1 } as unknown as string } },
      defaults,
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("不正な値の形式です");
    expect(theme.roles.frameCritical).toEqual({ fg: [213, 94, 0], bold: false });
  });

  it("不正型 role 値 (bold が文字列) で警告 + デフォルトフォールバック", () => {
    const { theme, warnings } = resolveTheme(
      { roles: { frameCritical: { bold: "true" } as unknown as string } },
      defaults,
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("不正な値の形式です");
    expect(theme.roles.frameCritical).toEqual({ fg: [213, 94, 0], bold: false });
  });
});

// ── loadThemeFromPath ──

describe("loadThemeFromPath", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "theme-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ファイルが存在しない場合はデフォルトテーマで警告なし", () => {
    const warnings = loadThemeFromPath(path.join(tmpDir, "theme.json"));
    expect(warnings).toEqual([]);
    // デフォルトパレットが使用される
    expect(getPalette().gray).toEqual([132, 145, 158]);
  });

  it("正常な theme.json を読み込める", () => {
    const themeFile: ThemeFile = {
      palette: { gray: "#AABBCC" },
    };
    fs.writeFileSync(
      path.join(tmpDir, "theme.json"),
      JSON.stringify(themeFile),
    );
    const warnings = loadThemeFromPath(path.join(tmpDir, "theme.json"));
    expect(warnings).toEqual([]);
    expect(getPalette().gray).toEqual([170, 187, 204]);
  });

  it("不正な JSON で警告を返しデフォルトにフォールバック", () => {
    fs.writeFileSync(path.join(tmpDir, "theme.json"), "{ invalid json");
    const warnings = loadThemeFromPath(path.join(tmpDir, "theme.json"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("JSONパース");
    expect(getPalette().gray).toEqual([132, 145, 158]);
  });

  it("配列形式で警告を返しデフォルトにフォールバック", () => {
    fs.writeFileSync(path.join(tmpDir, "theme.json"), "[]");
    const warnings = loadThemeFromPath(path.join(tmpDir, "theme.json"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("不正");
  });

  it("palette が配列の場合は無視される", () => {
    fs.writeFileSync(path.join(tmpDir, "theme.json"), JSON.stringify({ palette: [1, 2, 3] }));
    const warnings = loadThemeFromPath(path.join(tmpDir, "theme.json"));
    expect(warnings.some((w) => w.includes("palette"))).toBe(true);
    expect(getPalette().gray).toEqual([132, 145, 158]);
  });

  it("roles が文字列の場合は無視される", () => {
    fs.writeFileSync(path.join(tmpDir, "theme.json"), JSON.stringify({ roles: "invalid" }));
    const warnings = loadThemeFromPath(path.join(tmpDir, "theme.json"));
    expect(warnings.some((w) => w.includes("roles"))).toBe(true);
  });

  it("不正型 role 値を含む theme.json で警告 + フォールバック", () => {
    fs.writeFileSync(
      path.join(tmpDir, "theme.json"),
      JSON.stringify({ roles: { frameCritical: 123 } }),
    );
    const warnings = loadThemeFromPath(path.join(tmpDir, "theme.json"));
    expect(warnings.some((w) => w.includes("不正な値の形式です"))).toBe(true);
    // デフォルトにフォールバック
    const role = getRole("frameCritical");
    expect(role).toEqual({ fg: [213, 94, 0], bold: false });
  });
});

// ── getRoleChalk ──

describe("getRoleChalk", () => {
  beforeEach(() => {
    chalk.level = 3;
    // デフォルトテーマに戻す
    loadThemeFromPath("/nonexistent-path");
  });

  it("fg のみの role は chalk.rgb を返す", () => {
    const c = getRoleChalk("frameCritical");
    const result = c("test");
    expect(result).toBe(chalk.rgb(213, 94, 0)("test"));
  });

  it("fg + bold の role は chalk.rgb.bold を返す", () => {
    const c = getRoleChalk("intensity6Lower");
    const result = c("test");
    expect(result).toBe(chalk.rgb(213, 94, 0).bold("test"));
  });

  it("bg + fg + bold の role は chalk.bgRgb.rgb.bold を返す", () => {
    const c = getRoleChalk("intensity7");
    const result = c("test");
    expect(result).toBe(chalk.bgRgb(122, 30, 0).rgb(255, 255, 255).bold("test"));
  });

  it("同一 chalk.level で同一参照を返す (キャッシュ)", () => {
    const c1 = getRoleChalk("frameCritical");
    const c2 = getRoleChalk("frameCritical");
    expect(c1).toBe(c2);
  });

  it("テーマリロード後はキャッシュがクリアされる", () => {
    const c1 = getRoleChalk("frameCritical");
    loadThemeFromPath("/nonexistent-path"); // キャッシュクリア
    const c2 = getRoleChalk("frameCritical");
    // 同じ結果だが異なるインスタンス（キャッシュクリア済み）
    expect(c1).not.toBe(c2);
    expect(c1("test")).toBe(c2("test"));
  });
});

// ── validateThemeFile ──

describe("validateThemeFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "theme-validate-"));
    vi.spyOn(config, "getConfigDir").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("theme.json がない場合は valid: true", () => {
    const result = validateThemeFile();
    expect(result.valid).toBe(true);
    expect(result.warnings[0]).toContain("見つかりません");
  });

  it("正常な theme.json で valid: true + 警告なし", () => {
    fs.writeFileSync(
      path.join(tmpDir, "theme.json"),
      JSON.stringify({ palette: { gray: "#AABBCC" } }),
    );
    const result = validateThemeFile();
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("不正構造の theme.json で valid: false", () => {
    fs.writeFileSync(path.join(tmpDir, "theme.json"), "[]");
    const result = validateThemeFile();
    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toContain("不正");
  });

  it("palette が配列の場合は警告", () => {
    fs.writeFileSync(path.join(tmpDir, "theme.json"), JSON.stringify({ palette: [] }));
    const result = validateThemeFile();
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes("palette"))).toBe(true);
  });
});

// ── resetTheme ──

describe("resetTheme", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "theme-reset-"));
    vi.spyOn(config, "getConfigDir").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("デフォルト theme.json を書き出し、再読込で警告なし", () => {
    const warnings = resetTheme();
    expect(warnings).toEqual([]);
    // ファイルが存在する
    expect(fs.existsSync(path.join(tmpDir, "theme.json"))).toBe(true);
    // 書き出された内容が有効な JSON
    const content = fs.readFileSync(path.join(tmpDir, "theme.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed).toHaveProperty("palette");
    expect(parsed).toHaveProperty("roles");
  });

  it("既存 theme.json があっても上書きされる", () => {
    fs.writeFileSync(path.join(tmpDir, "theme.json"), '{"palette":{}}');
    const warnings = resetTheme();
    expect(warnings).toEqual([]);
    const content = fs.readFileSync(path.join(tmpDir, "theme.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.palette.gray).toBe("#84919E");
  });
});

// ── generateDefaultThemeJson ──

describe("generateDefaultThemeJson", () => {
  it("有効な JSON を生成する", () => {
    const json = generateDefaultThemeJson();
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty("palette");
    expect(parsed).toHaveProperty("roles");
    expect(parsed.palette.gray).toBe("#84919E");
  });
});
