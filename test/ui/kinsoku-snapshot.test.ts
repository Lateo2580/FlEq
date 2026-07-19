import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { KINSOKU_LINE_START, KINSOKU_LINE_END } from "../../src/ui/formatter";

// snapshot 全体を走査し、フレーム本文の行頭/行末禁則違反を検出する恒久テスト
// (spec §9 受け入れ基準 2)。検査文字集合は wrapTextLines v2 の実装定数を直接 import
// するため、集合の増減に自動追従する (ASCII !? を含む — 手書き grep パターンのズレ防止)。

// 既知の許容違反はここに追記する。
// 形式: "ファイル名:行内容の一意な断片"。追記時はコメントで許容の根拠を書くこと。
// wrapTextLines v2 の禁則調整は「wrap 改行点」にのみ効く。論理行そのものの先頭文字
// (リスト bullet「・」や省略サマリ「…」) は wrap 継続行ではないため対象外で、表示として
// 正しい (直後の継続行は禁則対象外の文字で始まることを snapshot で確認済み)。
const FAIL_OPEN_ALLOWLIST: string[] = [
  // 熱中症警戒の「実施していただきたいこと」箇条書き — 論理行先頭のリスト bullet
  "heat-alert-formatter.test.ts.snap:・脱水状態にある人",
  "heat-alert-formatter.test.ts.snap:・管理者がいる場所",
  // 電文本文の省略サマリ行 — 論理行先頭の三点リーダ (wrap 由来ではない)
  "seismic-text-formatter-no-color.snapshot.test.ts.snap:… 他 13 行",
];

function isAllowed(file: string, line: string): boolean {
  return FAIL_OPEN_ALLOWLIST.some((entry) => {
    const [f, fragment] = entry.split(":");
    return file === f && line.includes(fragment);
  });
}

describe("snapshot 禁則検査 (spec §9 受け入れ基準 2 の恒久化)", () => {
  const snapDir = path.join(__dirname, "__snapshots__");
  const snapFiles = fs.readdirSync(snapDir).filter((f) => f.endsWith(".snap"));

  it("snapshot が 1 件以上ある (走査対象の存在確認 — vacuous pass 防止)", () => {
    expect(snapFiles.length).toBeGreaterThan(0);
  });

  it("本文行頭 (罫線 + 空白の直後の最初の可視文字) に行頭禁則文字が来ない", () => {
    const violations: string[] = [];
    for (const file of snapFiles) {
      const lines = fs.readFileSync(path.join(snapDir, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        // ║ / │ で始まるフレーム本文行の、空白 (半角/全角インデント含む) を除いた先頭可視文字
        const m = /^[║│]\s+(\S)/.exec(line);
        if (m != null && KINSOKU_LINE_START.has(m[1]) && !isAllowed(file, line)) {
          violations.push(`${file}:${i + 1}: ${line}`);
        }
      });
    }
    expect(violations, `行頭禁則違反:\n${violations.join("\n")}`).toEqual([]);
  });

  it("本文行末 (右罫線手前の最後の可視文字) に行末禁則文字 (開き括弧) が残らない", () => {
    const violations: string[] = [];
    for (const file of snapFiles) {
      const lines = fs.readFileSync(path.join(snapDir, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        const m = /(\S)\s*[║│]$/.exec(line);
        if (m != null && KINSOKU_LINE_END.has(m[1]) && !isAllowed(file, line)) {
          violations.push(`${file}:${i + 1}: ${line}`);
        }
      });
    }
    expect(violations, `行末禁則違反:\n${violations.join("\n")}`).toEqual([]);
  });
});
