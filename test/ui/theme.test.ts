import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  DEFAULT_PALETTE,
} from "../../src/ui/theme";
import type {
  ThemeFile,
  ResolvedTheme,
  PaletteColorName,
  RgbTuple,
  RoleName,
} from "../../src/ui/theme";

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
    roles: {
      frameCritical: "vermillion" as const,
      frameWarning: "orange" as const,
      frameNormal: "sky" as const,
      frameInfo: "gray" as const,
      frameCancel: "raspberry" as const,
      intensity1: "gray" as const,
      intensity2: "sky" as const,
      intensity3: "blue" as const,
      intensity4: "blueGreen" as const,
      intensity5Lower: "yellow" as const,
      intensity5Upper: "orange" as const,
      intensity6Lower: { fg: "vermillion", bold: true } as const,
      intensity6Upper: { bg: "vermillion", fg: "#000000", bold: true } as const,
      intensity7: { bg: "darkRed", fg: "#FFFFFF", bold: true } as const,
      lgInt0: "gray" as const,
      lgInt1: "sky" as const,
      lgInt2: "yellow" as const,
      lgInt3: "orange" as const,
      lgInt4: { bg: "vermillion", fg: "#000000", bold: true } as const,
      magnitudeLow: "yellow" as const,
      magnitudeHigh: { fg: "vermillion", bold: true } as const,
      magnitudeMax: { bg: "darkRed", fg: "#FFFFFF", bold: true } as const,
      tsunamiNone: "blueGreen" as const,
      tsunamiAdvisory: "orange" as const,
      tsunamiWarning: { fg: "vermillion", bold: true } as const,
      tsunamiMajor: { bg: "darkRed", fg: "#FFFFFF", bold: true } as const,
      eewWarningBanner: { bg: "darkRed", fg: "#FFFFFF", bold: true } as const,
      eewForecastBanner: { bg: "yellow", fg: "#000000", bold: true } as const,
      eewCancelBanner: { bg: "raspberry", fg: "#000000", bold: true } as const,
      plumLabel: "raspberry" as const,
      arrivedLabel: "vermillion" as const,
      cancelText: "raspberry" as const,
      testBadge: { bg: "raspberry", fg: "#FFFFFF", bold: true } as const,
      hypocenter: { fg: "yellow", bold: true } as const,
      concurrent: "orange" as const,
      nextAdvisory: "sky" as const,
      warningComment: "orange" as const,
      detailUri: "sky" as const,
      textMuted: "gray" as const,
      nankaiCriticalBanner: { bg: "darkRed", fg: "#FFFFFF", bold: true } as const,
      nankaiWarningBanner: { bg: "orange", fg: "#000000", bold: true } as const,
      nankaiSerialCritical: { fg: "vermillion", bold: true } as const,
      nankaiSerialWarning: { fg: "orange", bold: true } as const,
      eewWarningBanner1: { bg: "vermillion", fg: "#FFFFFF", bold: true } as const,
      eewWarningBanner2: { bg: "vermillion", fg: "#000000", bold: true } as const,
      eewWarningBanner3: { bg: "orange", fg: "#000000", bold: true } as const,
      eewWarningBanner4: { bg: "raspberry", fg: "#000000", bold: true } as const,
      eewForecastBanner1: { bg: "orange", fg: "#000000", bold: true } as const,
      eewForecastBanner2: { bg: "sky", fg: "#000000", bold: true } as const,
      eewForecastBanner3: { bg: "blueGreen", fg: "#000000", bold: true } as const,
      eewForecastBanner4: { bg: "gray", fg: "#FFFFFF", bold: true } as const,
      plumDecorWarning: { bg: "blue", fg: "#FFFFFF", bold: true } as const,
      plumDecorForecast: { bg: "sky", fg: "#000000", bold: true } as const,
      rawHeaderLabel: "sky" as const,
    },
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
