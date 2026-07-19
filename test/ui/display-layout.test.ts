import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, afterEach } from "vitest";
import {
  resolveWeatherCoreLayout,
  DEFAULT_WEATHER_CORE_LAYOUT,
  loadDisplayLayoutFromPath,
  getWeatherCoreLayout,
  getDisplayLayoutPath,
  generateDefaultDisplayLayoutJson,
  resetDisplayLayoutForTest,
} from "../../src/ui/display-layout";

describe("resolveWeatherCoreLayout (共通 resolver)", () => {
  it("null/undefined はデフォルトを返す (エラー・警告なし)", () => {
    for (const raw of [null, undefined]) {
      const r = resolveWeatherCoreLayout(raw);
      expect(r.layout).toEqual(DEFAULT_WEATHER_CORE_LAYOUT);
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
    }
  });

  it("完全なデフォルト相当の指定は警告なしで通る", () => {
    const r = resolveWeatherCoreLayout({
      banner: true,
      footer: true,
      body: ["table", "unknown", "comments", "actionGuide"],
      tableOverflowDetail: true,
      allowHiddenUnknown: false,
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.layout).toEqual(DEFAULT_WEATHER_CORE_LAYOUT);
  });

  it("body の並び替えはそのまま反映される", () => {
    const r = resolveWeatherCoreLayout({
      body: ["actionGuide", "table", "unknown", "comments"],
    });
    expect(r.errors).toEqual([]);
    expect(r.layout.body).toEqual(["actionGuide", "table", "unknown", "comments"]);
  });

  it("非オブジェクト (配列/文字列) は error + デフォルト fallback", () => {
    for (const raw of [[], "x", 42]) {
      const r = resolveWeatherCoreLayout(raw);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.layout).toEqual(DEFAULT_WEATHER_CORE_LAYOUT);
    }
  });

  it("body 空配列は error + デフォルト fallback", () => {
    const r = resolveWeatherCoreLayout({ body: [] });
    expect(r.errors.some((e) => e.includes("body"))).toBe(true);
    expect(r.layout).toEqual(DEFAULT_WEATHER_CORE_LAYOUT);
  });

  it("table 欠落は error", () => {
    const r = resolveWeatherCoreLayout({ body: ["unknown", "comments"] });
    expect(r.errors.some((e) => e.includes("table"))).toBe(true);
    expect(r.layout).toEqual(DEFAULT_WEATHER_CORE_LAYOUT);
  });

  it("unknown 欠落 + allowHiddenUnknown なしは error", () => {
    const r = resolveWeatherCoreLayout({ body: ["table", "comments"] });
    expect(r.errors.some((e) => e.includes("unknown"))).toBe(true);
    expect(r.layout).toEqual(DEFAULT_WEATHER_CORE_LAYOUT);
  });

  it("unknown 欠落 + allowHiddenUnknown: true は warning で採用", () => {
    const r = resolveWeatherCoreLayout({
      body: ["table", "comments"],
      allowHiddenUnknown: true,
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("未知"))).toBe(true);
    expect(r.layout.body).toEqual(["table", "comments"]);
  });

  it("未知の block id は warning で無視、残りは採用", () => {
    const r = resolveWeatherCoreLayout({
      body: ["table", "nosuch", "unknown"],
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("nosuch"))).toBe(true);
    expect(r.layout.body).toEqual(["table", "unknown"]);
  });

  it("重複 id は warning で初出のみ採用", () => {
    const r = resolveWeatherCoreLayout({
      body: ["table", "unknown", "table"],
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("重複"))).toBe(true);
    expect(r.layout.body).toEqual(["table", "unknown"]);
  });

  it("tableOverflowDetail: false は warning で採用", () => {
    const r = resolveWeatherCoreLayout({ tableOverflowDetail: false });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("詳細"))).toBe(true);
    expect(r.layout.tableOverflowDetail).toBe(false);
  });

  it("boolean フィールドの型不正は warning + デフォルト値", () => {
    const r = resolveWeatherCoreLayout({ banner: "yes", footer: 1 });
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
    expect(r.layout.banner).toBe(true);
    expect(r.layout.footer).toBe(true);
  });

  it("body 非配列は error + デフォルト fallback", () => {
    const r = resolveWeatherCoreLayout({ body: "table" });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.layout).toEqual(DEFAULT_WEATHER_CORE_LAYOUT);
  });

  it("weatherCore 内の未知キー (typo) は warning で無視、正しいキーは反映", () => {
    const r = resolveWeatherCoreLayout({ bodey: ["table"], banner: false });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes('"bodey"'))).toBe(true);
    expect(r.layout.body).toEqual(DEFAULT_WEATHER_CORE_LAYOUT.body); // typo 側は無視
    expect(r.layout.banner).toBe(false);
  });
});

describe("display-layout ファイル I/O + singleton", () => {
  const tmpFiles: string[] = [];

  function writeTmpLayout(content: string): string {
    const p = path.join(os.tmpdir(), `fleq-layout-test-${process.pid}-${tmpFiles.length}.json`);
    fs.writeFileSync(p, content);
    tmpFiles.push(p);
    return p;
  }

  afterEach(() => {
    for (const p of tmpFiles) {
      try { fs.unlinkSync(p); } catch { /* best-effort */ }
    }
    tmpFiles.length = 0;
    resetDisplayLayoutForTest(); // singleton をデフォルトに戻す (テスト隔離)
  });

  it("ファイル無しはデフォルト (エラー・警告なし)", () => {
    const r = loadDisplayLayoutFromPath(path.join(os.tmpdir(), "fleq-layout-nonexistent.json"));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(getWeatherCoreLayout()).toEqual(DEFAULT_WEATHER_CORE_LAYOUT);
  });

  it("正常ファイルを読み込むと singleton に反映される", () => {
    const p = writeTmpLayout(JSON.stringify({
      weatherCore: { body: ["actionGuide", "table", "unknown", "comments"] },
    }));
    const r = loadDisplayLayoutFromPath(p);
    expect(r.errors).toEqual([]);
    expect(getWeatherCoreLayout().body).toEqual(["actionGuide", "table", "unknown", "comments"]);
  });

  it("JSON parse 失敗は error + デフォルト fallback", () => {
    const p = writeTmpLayout("{ broken json");
    const r = loadDisplayLayoutFromPath(p);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(getWeatherCoreLayout()).toEqual(DEFAULT_WEATHER_CORE_LAYOUT);
  });

  it("error 級の config は singleton をデフォルトに保つ", () => {
    const p = writeTmpLayout(JSON.stringify({ weatherCore: { body: [] } }));
    const r = loadDisplayLayoutFromPath(p);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(getWeatherCoreLayout()).toEqual(DEFAULT_WEATHER_CORE_LAYOUT);
  });

  it("トップレベルの未知キー (weatherCore の typo) は warning + デフォルト", () => {
    const p = writeTmpLayout(JSON.stringify({ wetherCore: { banner: false } }));
    const r = loadDisplayLayoutFromPath(p);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes('"wetherCore"'))).toBe(true);
    expect(getWeatherCoreLayout()).toEqual(DEFAULT_WEATHER_CORE_LAYOUT);
  });

  it("getDisplayLayoutPath は config dir 配下の display-layout.json を返す", () => {
    expect(getDisplayLayoutPath().endsWith("display-layout.json")).toBe(true);
  });

  it("generateDefaultDisplayLayoutJson は parse 可能でデフォルトに解決される", () => {
    const parsed: unknown = JSON.parse(generateDefaultDisplayLayoutJson());
    const r = resolveWeatherCoreLayout((parsed as { weatherCore: unknown }).weatherCore);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.layout).toEqual(DEFAULT_WEATHER_CORE_LAYOUT);
  });
});
