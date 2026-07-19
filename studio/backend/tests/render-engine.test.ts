import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { render, renderDiff } from "../lib/render-engine";
import { getFrameWidth } from "../../../src/ui/formatter";
import { isNightMode, getThemePath, loadTheme } from "../../../src/ui/theme";

const DEFAULT_OPTS = {
  compact: false,
  width: 100,
  noColor: false,
  nightMode: false,
};

describe("render-engine", () => {
  it("VPWW55 fixture を render すると ANSI 文字列が返る", async () => {
    const result = await render({
      fixtureId: "15_17_01_251222_VPWW55.xml",
      themeOverride: { palette: {}, roles: {} },
      options: DEFAULT_OPTS,
    });
    expect(result.ansi.length).toBeGreaterThan(0);
    expect(result.ansi).toContain("\x1b["); // ANSI escape
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("noColor: true 時は ANSI escape を含まない", async () => {
    const result = await render({
      fixtureId: "15_17_01_251222_VPWW55.xml",
      themeOverride: { palette: {}, roles: {} },
      options: { ...DEFAULT_OPTS, noColor: true },
    });
    expect(result.ansi).not.toContain("\x1b[");
    expect(result.ansi.length).toBeGreaterThan(0);
  });

  it("幅 80 と 120 で異なる出力になる", async () => {
    const w80 = await render({
      fixtureId: "15_17_01_251222_VPWW55.xml",
      themeOverride: { palette: {}, roles: {} },
      options: { ...DEFAULT_OPTS, noColor: true, width: 80 },
    });
    const w120 = await render({
      fixtureId: "15_17_01_251222_VPWW55.xml",
      themeOverride: { palette: {}, roles: {} },
      options: { ...DEFAULT_OPTS, noColor: true, width: 120 },
    });
    expect(w80.ansi).not.toBe(w120.ansi);
  });

  it("render 後に frame width と night mode が元に戻る", async () => {
    const originalWidth = getFrameWidth();
    const originalNight = isNightMode();
    await render({
      fixtureId: "15_17_01_251222_VPWW55.xml",
      themeOverride: { palette: {}, roles: {} },
      options: { ...DEFAULT_OPTS, width: 80, nightMode: true },
    });
    expect(getFrameWidth()).toBe(originalWidth);
    expect(isNightMode()).toBe(originalNight);
  });

  it("compact: true で 1 行サマリーが返る (Phase 1d で対応)", async () => {
    const result = await render({
      fixtureId: "15_17_01_251222_VPWW55.xml",
      themeOverride: { palette: {}, roles: {} },
      options: { ...DEFAULT_OPTS, compact: true, noColor: true },
    });
    const lines = result.ansi.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("大雨");
    expect(lines[0]).not.toContain("║");
  });

  it("compact 出力は無着色で theme 非依存 (本番 message-router と同等)", async () => {
    const base = await render({
      fixtureId: "15_17_01_251222_VPWW55.xml",
      themeOverride: { palette: {}, roles: {} },
      options: { ...DEFAULT_OPTS, compact: true },
    });
    const overridden = await render({
      fixtureId: "15_17_01_251222_VPWW55.xml",
      themeOverride: { palette: { vermillion: "#FF00FF" } },
      options: { ...DEFAULT_OPTS, compact: true },
    });
    expect(base.ansi).not.toContain("\x1b[");      // summary/ は chalk 不使用 (レビュー実証)
    expect(overridden.ansi).toBe(base.ansi);       // theme 非依存 = 本番同等
  });

  it("未登録の fixture type は error を返す", async () => {
    await expect(
      render({
        // VPTW60 (台風解析・予報情報) は Phase 4b 時点でも registry 未登録
        fixtureId: "10_04_03_170913_VPTW60.xml",
        themeOverride: { palette: {}, roles: {} },
        options: DEFAULT_OPTS,
      }),
    ).rejects.toThrow(/未対応|unsupported/i);
  });

  it("存在しない fixture は error を返す", async () => {
    await expect(
      render({
        fixtureId: "nonexistent.xml",
        themeOverride: { palette: {}, roles: {} },
        options: DEFAULT_OPTS,
      }),
    ).rejects.toThrow(/見つからない|not found/i);
  });

  it("theme override の warnings が返される", async () => {
    const result = await render({
      fixtureId: "15_17_01_251222_VPWW55.xml",
      themeOverride: { palette: { vermillion: "not-a-hex" } },
      options: DEFAULT_OPTS,
    });
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("renderDiff", () => {
  afterEach(() => {
    try { fs.unlinkSync(getThemePath()); } catch { /* none */ }
    loadTheme();
  });

  it("保存済み theme 無し: before はデフォルト、after は override 適用で異なる", async () => {
    const result = await renderDiff({
      fixtureId: "15_17_01_251222_VPWW55.xml",
      themeOverride: { palette: { vermillion: "#FF00FF" } },
      options: { compact: false, width: 80, noColor: false, nightMode: false },
    });
    expect(result.before.length).toBeGreaterThan(0);
    expect(result.after.length).toBeGreaterThan(0);
    expect(result.before).not.toBe(result.after);          // 色 override が after にだけ効く
    expect(result.after).toContain("255;0;255");           // override の TrueColor
    expect(result.before).not.toContain("255;0;255");
  });

  it("保存済み theme あり: before に保存済みの色が効く", async () => {
    fs.mkdirSync(path.dirname(getThemePath()), { recursive: true });
    fs.writeFileSync(getThemePath(), JSON.stringify({ palette: { vermillion: "#00FF00" } }));
    const result = await renderDiff({
      fixtureId: "15_17_01_251222_VPWW55.xml",
      themeOverride: { palette: { vermillion: "#FF00FF" } },
      options: { compact: false, width: 80, noColor: false, nightMode: false },
    });
    expect(result.before).toContain("0;255;0");
    expect(result.after).toContain("255;0;255");
  });

  it("override が保存内容と同一なら before === after (色付きで baseline 解決を実証)", async () => {
    // noColor: true だと theme が出力に影響せず vacuous になる (レビュー指摘) — 色付きで検証
    fs.mkdirSync(path.dirname(getThemePath()), { recursive: true });
    fs.writeFileSync(getThemePath(), JSON.stringify({ palette: { vermillion: "#123456" } }));
    const result = await renderDiff({
      fixtureId: "15_17_01_251222_VPWW55.xml",
      themeOverride: { palette: { vermillion: "#123456" } },
      options: { compact: false, width: 80, noColor: false, nightMode: false },
    });
    expect(result.before).toContain("18;52;86");   // #123456 が before (保存) にも
    expect(result.before).toBe(result.after);      // 同一 override なら一致
  });

  it("未対応 fixture は従来どおり throw する", async () => {
    await expect(renderDiff({
      fixtureId: "nonexistent.xml",
      themeOverride: { palette: {}, roles: {} },
      options: { compact: false, width: 80, noColor: true, nightMode: false },
    })).rejects.toThrow(/見つからない/);
  });
});
