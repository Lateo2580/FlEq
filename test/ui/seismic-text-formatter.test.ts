import { describe, it, expect, beforeEach, afterEach, vi , type MockInstance } from "vitest";
import chalk from "chalk";
import {
  displaySeismicTextInfo,
  pushTextBodyBlock,
  SEISMIC_TEXT_RULES,
} from "../../src/ui/seismic-text-formatter";
import { parseSeismicTextTelegram } from "../../src/dmdata/telegram-parser";
import { setFrameWidth, stripAnsi, createRenderBuffer, flushWithRecap } from "../../src/ui/formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE56_ACTIVITY_1,
  FIXTURE_VZSE40_NOTICE,
  FIXTURE_VZSE40_CANCEL,
  FIXTURE_VXSE60_CANCEL,
} from "../helpers/mock-message";

// ── 共用 helper (displaySeismicTextInfo 系 describe 群で共有) ──

let logSpy: MockInstance<typeof console.log>;

beforeEach(() => {
  chalk.level = 3;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  setFrameWidth(60);
});

function render(fixture: string, type: string): string {
  const msg = createMockWsDataMessage(fixture, {
    head: { type, author: "気象庁", time: new Date().toISOString(), test: false },
  });
  const info = parseSeismicTextTelegram(msg);
  expect(info).not.toBeNull();
  displaySeismicTextInfo(info!);
  return logSpy.mock.calls.map((args) => String(args[0])).join("\n");
}

describe("displaySeismicTextInfo (新デザイン言語)", () => {
  it("VXSE56: タイトル・本文・labeled divider「本文」が表示される", () => {
    const output = render(FIXTURE_VXSE56_ACTIVITY_1, "VXSE56");
    expect(output).toContain("伊豆東部");
    expect(output).toContain("地震の活動状況等に関する情報");
    expect(stripAnsi(output)).toContain("本文");
  });

  it("VZSE40: 地震・津波に関するお知らせのラベルで表示される", () => {
    const output = render(FIXTURE_VZSE40_NOTICE, "VZSE40");
    expect(output).toContain("地震・津波に関するお知らせ");
  });

  it("本文トリムは残行数明示 (… 他 N 行（全 M 行）) 形式", () => {
    // maxLines=2 で 5 行本文 → 他 3 行（全 5 行）
    const buf = createRenderBuffer();
    pushTextBodyBlock(buf, "info", 60, "一行目\n二行目\n三行目\n四行目\n五行目", SEISMIC_TEXT_RULES, 2);
    flushWithRecap(buf, "info", 60);
    const out = stripAnsi(logSpy.mock.calls.map((c) => String(c[0])).join("\n"));
    expect(out).toContain("一行目");
    expect(out).toContain("二行目");
    expect(out).not.toContain("三行目");
    expect(out).toContain("他 3 行（全 5 行）");
  });

  it("compact 分岐が存在しない: displayMode によらず full 表示が出る", () => {
    // 旧実装は getDisplayMode()==="compact" で 1 行 console.log に落ちていた。
    // 新実装は formatter に compact が無い (summary パイプラインの責務)。
    const output = render(FIXTURE_VXSE56_ACTIVITY_1, "VXSE56");
    expect(output).toMatch(/[┌└│┐┘]/); // info フレーム罫線が常に出る
  });
});

// ── displaySeismicTextInfo ハイライトテスト (formatter.test.ts より移設) ──

describe("displaySeismicTextInfo ハイライト", () => {
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("VXSE56: 「活発」にANSI色が付く", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE56_ACTIVITY_1, {
      head: {
        type: "VXSE56",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });
    const info = parseSeismicTextTelegram(msg);
    expect(info).not.toBeNull();

    displaySeismicTextInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    // 本文中の「活発」にANSIエスケープが付いている
    // warningComment ロール = orange (230, 159, 0)
    expect(output).toContain("230");
    expect(output).toContain("159");
  });
});

describe("地震テキスト: 取消・isTest・golden inventory", () => {
  it("取消報 (VZSE40 実 fixture): cancel フレームで表示される", () => {
    const output = render(FIXTURE_VZSE40_CANCEL, "VZSE40");
    // "取消" 単体は infoType 由来の可能性があるため、cancel level 専用の severity ラベルで固定する
    expect(stripAnsi(output)).toContain("[取消]");
  });

  it("取消報 (VXSE60 実 fixture): cancel フレームで表示される", () => {
    const output = render(FIXTURE_VXSE60_CANCEL, "VXSE60");
    expect(stripAnsi(output)).toContain("[取消]");
  });

  it("isTest: テスト電文バッジが出る (Studio loader は test:false 固定のため CLI 側でのみ担保)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE56_ACTIVITY_1, {
      head: { type: "VXSE56", author: "気象庁", time: new Date().toISOString(), test: false },
    });
    const info = parseSeismicTextTelegram(msg)!;
    displaySeismicTextInfo({ ...info, isTest: true });
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stripAnsi(output)).toContain("テスト電文");
  });

  it("golden inventory: タイトル / infoType / headline / 本文 divider / footer (type + 発表官署)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE56_ACTIVITY_1, {
      head: { type: "VXSE56", author: "気象庁", time: new Date().toISOString(), test: false },
    });
    const info = parseSeismicTextTelegram(msg)!;
    displaySeismicTextInfo(info);
    const plain = stripAnsi(logSpy.mock.calls.map((c) => String(c[0])).join("\n"));
    expect(plain).toContain("地震の活動状況等に関する情報");   // タイトル (typeLabel)
    expect(plain).toContain(info.infoType);
    if (info.headline) expect(plain).toContain(info.headline.slice(0, 10));
    expect(plain).toContain("本文");                            // labeled divider
    expect(plain).toContain("VXSE56");                          // footer type
    expect(plain).toContain(info.publishingOffice);
  });
});

describe("本文の再改行 (spec §8 R2-3)", () => {
  it("VXSE56 standard (幅 140): 電文の 34 字改行が解除され、旧改行位置の断片が同一行に現れる", () => {
    setFrameWidth(140);
    const output = stripAnsi(render(FIXTURE_VXSE56_ACTIVITY_1, "VXSE56"));
    const lines = output.split("\n");
    // 正 assert: fixture (32-35_09_01_191111_VXSE56.xml L27-28) では「縮みのひずみ変」で
    // 物理行が切れ「化が観測され」が次行に続く。再結合 + 幅 140 折返し後は同一行に収まる。
    // 後続の divider/footer 行では成立しない断片ペアなので、範囲を絞らなくても誤検知しない
    // (幅計測方式は本文外の行で max>閾値 が成立しうるため不採用 — Codex 実装前レビュー)
    const joined = lines.findIndex((l) => l.includes("縮みのひずみ変化が観測され"));
    expect(joined).toBeGreaterThan(-1);
    // 負 assert: 旧改行位置で行が切れていない (中途半端な折返しの代表形が消えている)
    const clipped = lines.findIndex((l) => l.trimEnd().endsWith("縮みのひずみ変"));
    expect(clipped).toBe(-1);
  });
});
