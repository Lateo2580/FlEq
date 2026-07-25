import { describe, it, expect, beforeEach, afterEach, vi , type MockInstance } from "vitest";
import chalk from "chalk";
import { displayNankaiTroughInfo } from "../../src/ui/nankai-trough-formatter";
import { parseNankaiTroughTelegram } from "../../src/dmdata/telegram-parser";
import { setFrameWidth, stripAnsi } from "../../src/ui/formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VYSE50_ALERT,
  FIXTURE_VYSE50_CLOSED,
  FIXTURE_VYSE50_CANCEL,
  FIXTURE_VYSE52_REGULAR,
  FIXTURE_VYSE60_AFTERSHOCK,
} from "../helpers/mock-message";

describe("displayNankaiTroughInfo (新デザイン言語)", () => {
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    setFrameWidth(60);
  });

  function render(fixture: string, type: string): { output: string; lines: string[] } {
    const msg = createMockWsDataMessage(fixture, {
      head: { type, author: "気象庁", time: new Date().toISOString(), test: false },
    });
    const info = parseNankaiTroughTelegram(msg);
    expect(info).not.toBeNull();
    displayNankaiTroughInfo(info!);
    const lines = logSpy.mock.calls.map((args) => String(args[0] ?? ""));
    return { output: lines.join("\n"), lines };
  }

  /** バナー行 = 罫線を含まない非空行が frameTop より前に出る (3 行バナー) */
  function firstNonBlankStripped(lines: string[]): string {
    return lines.map((l) => stripAnsi(l)).find((l) => l.trim().length > 0) ?? "";
  }

  it("critical (code 120 巨大地震警戒): バナーが出て二重枠 + 状態カード", () => {
    const { output, lines } = render(FIXTURE_VYSE50_ALERT, "VYSE50");
    expect(output).toMatch(/[╔╚║╗╝╠╣═]/);
    expect(output).toContain("巨大地震警戒");
    // バナー: 最初の非空行はフレーム外 (罫線なし) のタイトル面
    expect(firstNonBlankStripped(lines)).not.toMatch(/[╔┌]/);
    expect(stripAnsi(output)).toContain("状態:");
  });

  it("warning (VYSE60 後発地震注意 — infoSerial なし): バナーが出て状態カードは省略", () => {
    const { output, lines } = render(FIXTURE_VYSE60_AFTERSHOCK, "VYSE60");
    expect(output).toMatch(/[╔╚║╗╝╠╣═]/);
    expect(output).toContain("三陸沖");
    expect(firstNonBlankStripped(lines)).not.toMatch(/[╔┌]/);
    expect(stripAnsi(output)).not.toContain("状態:");
  });

  it("info (code 190 調査終了): バナーなし — 最初の非空行が枠上辺", () => {
    const { output, lines } = render(FIXTURE_VYSE50_CLOSED, "VYSE50");
    expect(output).toContain("調査終了");
    expect(firstNonBlankStripped(lines)).toMatch(/[┌]/);
  });

  it("info (code 200 定例解説 VYSE52): バナーなし", () => {
    const { lines } = render(FIXTURE_VYSE52_REGULAR, "VYSE52");
    expect(firstNonBlankStripped(lines)).toMatch(/[┌]/);
  });

  it("取消: cancel フレームで表示される (既存 :942-960 踏襲)", () => {
    const { output } = render(FIXTURE_VYSE50_CANCEL, "VYSE50");
    // "取消" 単体は infoType/本文由来の可能性があるため、cancel level 専用の severity ラベルで固定する
    expect(output).toContain("[取消]");
    expect(output).toContain("取り消します");
  });

  it("本文が labeled divider「本文」に乗る", () => {
    const { output } = render(FIXTURE_VYSE50_ALERT, "VYSE50");
    expect(stripAnsi(output)).toContain("本文");
  });
});

// ── displayNankaiTroughInfo ハイライトテスト (formatter.test.ts :1277 付近から移設) ──

describe("displayNankaiTroughInfo ハイライト", () => {
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("VYSE50 巨大地震警戒: 「巨大地震警戒」本文にANSI色が付く", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE50_ALERT, {
      head: {
        type: "VYSE50",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseNankaiTroughTelegram(msg);
    expect(info).not.toBeNull();

    displayNankaiTroughInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");

    // nankaiSerialCritical = vermillion (213, 94, 0)
    // 本文中の「巨大地震警戒」がハイライトされている
    expect(output).toContain("巨大地震警戒");
    // 出力にANSIエスケープが含まれている（色情報）
    expect(output).toContain("[");
  });

  it("VYSE50 巨大地震警戒: 行動促進キーワードに色が付く", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE50_ALERT, {
      head: {
        type: "VYSE50",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseNankaiTroughTelegram(msg);
    expect(info).not.toBeNull();

    displayNankaiTroughInfo(info!);

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    // nextAdvisory ロール = sky (86, 180, 233) が出力に含まれる
    // (防災対応をとってください / 今後の情報に注意してください がマッチするはず)
    expect(output).toContain("86");
    expect(output).toContain("180");
    expect(output).toContain("233");
  });

  it("VYSE50 調査終了: 本文が過剰に色付かない", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE50_CLOSED, {
      head: {
        type: "VYSE50",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const info = parseNankaiTroughTelegram(msg);
    expect(info).not.toBeNull();

    displayNankaiTroughInfo(info!);

    const lines = logSpy.mock.calls.map((args) => String(args[0]));
    // 本文行でANSIを含む行数をカウント（フレーム色を除く）
    // 過剰着色ではないことを確認（全行にANSIが入るわけではない）
    const bodyStartIdx = lines.findIndex((l) => l.includes("調査終了")) + 1;
    const bodyLines = lines.slice(bodyStartIdx).filter((l) => !l.includes("╔") && !l.includes("╚") && !l.includes("╠") && !l.includes("┌") && !l.includes("└") && !l.includes("├"));
    // 少なくとも一部の行にはANSI以外の素通し部分がある
    const linesWithoutExtraAnsi = bodyLines.filter((l) => {
      // フレーム色以外のANSIが含まれていない行
      const stripped = l.replace(/\[[0-9;]*m/g, "");
      return stripped.length > 0;
    });
    expect(linesWithoutExtraAnsi.length).toBeGreaterThan(0);
  });
});

describe("南海トラフ: isTest・golden inventory (取消は既存 describe で固定済み)", () => {
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    setFrameWidth(60);
  });

  it("isTest: テスト電文バッジが出る", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE50_ALERT, {
      head: { type: "VYSE50", author: "気象庁", time: new Date().toISOString(), test: false },
    });
    const info = parseNankaiTroughTelegram(msg)!;
    displayNankaiTroughInfo({ ...info, isTest: true });
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stripAnsi(output)).toContain("テスト電文");
  });

  it("golden inventory: バナー / タイトル / 状態カード / headline / 本文 / nextAdvisory / footer", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE50_ALERT, {
      head: { type: "VYSE50", author: "気象庁", time: new Date().toISOString(), test: false },
    });
    const info = parseNankaiTroughTelegram(msg)!;
    displayNankaiTroughInfo(info);
    const plain = stripAnsi(logSpy.mock.calls.map((c) => String(c[0])).join("\n"));
    expect(plain).toContain(info.title);                        // バナー文言
    expect(plain).toContain("南海トラフ地震臨時情報");           // タイトル
    expect(plain).toContain("状態:");
    expect(plain).toContain(info.infoSerial!.name);
    if (info.headline) expect(plain).toContain(info.headline.slice(0, 10));
    expect(plain).toContain("本文");
    if (info.nextAdvisory) {
      expect(plain).toContain("次回発表");
      // wrapFrameLinesWith は「、」区切りでの折返し時に区切り文字自体を落とすため
      // (formatter.ts wrapSingleLine の既知挙動)、罫線・句読点・空白を除いた比較で内容一致を確認する
      const flatten = (s: string) => s.replace(/[║│╠╣╔╗╚╝═─、\s]/g, "");
      expect(flatten(plain)).toContain(flatten(info.nextAdvisory.slice(0, 10)));
    }
    expect(plain).toContain("VYSE50");
    expect(plain).toContain(info.publishingOffice);
  });
});
