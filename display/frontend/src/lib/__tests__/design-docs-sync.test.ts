import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseTokens, buildTokenMap, generateBlocks, extractBlock,
  evaluatePairs, applyAllowlist, ALLOWLIST, auditGate, validateAllowlist,
} from "../../../../scripts/generate-design-docs.mjs";

const css = readFileSync(join(__dirname, "..", "theme.css"), "utf-8");
const docPath = join(__dirname, "..", "..", "..", "..", "..", "docs", "specs", "display-design-system.md");
const doc = readFileSync(docPath, "utf-8");

describe("design-docs 乖離検知 (theme.css 変更後に docs:design 忘れを落とす)", () => {
  const blocks = generateBlocks(css);

  it("committed の tokens 区間が再生成と一致する", () => {
    expect(extractBlock(doc, "tokens"), "npm run docs:design を実行して再生成せよ").toBe(blocks.tokens.trim());
  });
  it("committed の contrast 区間が再生成と一致する", () => {
    expect(extractBlock(doc, "contrast"), "npm run docs:design を実行して再生成せよ").toBe(blocks.contrast.trim());
  });
  it("トークン表の件数が theme.css の :root + tier ブロックのカスタムプロパティ定義数と一致する", () => {
    // 独立カウント: :root 本体と全 main[data-tier] 本体だけを抽出し、コメント除去後に --x: を数える。
    // css.slice(indexOf(":root")) 全域を対象にすると、将来 :root 外に custom property が増えたとき
    // parseTokens はそれを拾わないのにこのカウントは拾い、spec と無関係に落ちる。対象ブロック本体に限定する。
    // 行頭アンカーにしない (header 行の 1 行 3 宣言を取りこぼさないため)。カウント方法は
    // parseTokens の行単位 state 機械 (collectDecls) とは別実装 (独立性の担保)。
    const bodies: string[] = [];
    const root = css.match(/:root\s*\{([\s\S]*?)\n\}/);
    if (root != null) bodies.push(root[1]);
    for (const m of css.matchAll(/main\[data-tier[^{]*\{([\s\S]*?)\n\}/g)) bodies.push(m[1]);
    const declCount = bodies
      .map((b) => b.replace(/\/\*[\s\S]*?\*\//g, ""))
      .reduce((sum, b) => sum + (b.match(/--[\w-]+\s*:/g) ?? []).length, 0);
    expect(parseTokens(css).length).toBe(declCount);
  });
  it("許容リストに無い FAIL / STALE が存在しない (status ゲート)", () => {
    const map = buildTokenMap(parseTokens(css));
    const audited = applyAllowlist(evaluatePairs(map), ALLOWLIST);
    expect(auditGate(audited), "許容外の FAIL/STALE がある。許容リスト追記か色修正が要る").toEqual([]);
  });
  it("実 ALLOWLIST は validateAllowlist を通る (全エントリの pair_ids/state/hash が健全)", () => {
    // status ゲートと独立に、エントリ単位で hash を再審査する。全ペアが一時 PASS でも
    // hash 不一致 (色を戻した等) を STALE として捕まえる契約 (§6) の常時ガード。
    const map = buildTokenMap(parseTokens(css));
    const evaluated = evaluatePairs(map);
    expect(validateAllowlist(ALLOWLIST, evaluated), "許容リストの hash/state が古い。再審査して更新せよ").toEqual([]);
  });
});
