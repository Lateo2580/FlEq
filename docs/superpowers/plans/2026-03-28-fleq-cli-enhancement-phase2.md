# Phase 2: --filter / --template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PresentationEvent に対する条件式フィルタ (`--filter`) とユーザー定義テンプレート (`--template`) を実装し、CLI / REPL 経由で電文の絞り込みと1行要約カスタマイズを可能にする。

**Architecture:** filter は手書き再帰下降パーサで `tokenize → parse(AST) → typeCheck → compile(predicate)` パイプラインを構築する。template は別パーサで `tokenize → parse(AST) → compile(renderer)` とする。両者とも PresentationEvent を入力として評価し、router の handler 内で filter → template の順に適用する。フィールドアクセスは FilterField レジストリ（フラットな getter + エイリアス）で統一する。

**Tech Stack:** TypeScript strict, vitest, chalk v4 (CommonJS), commander

---

## Codex レビュー反映事項

以下の修正を実装時に適用すること（元タスクの記述より優先）。

### [重大1] 火山パイプライン統合
- 火山 aggregator の emit コールバック内で `VolcanoOutcome` → `toPresentationEvent` を通し、filter/template パイプラインを適用する
- `emitSingle` / `emitBatch` の前に PresentationEvent を生成し、`shouldDisplay` でフィルタ判定する
- Task 13 (Router 統合) にこの作業を含める

### [重大2] Pipeline 注入経路
- `FilterTemplatePipeline` を **mutable なオブジェクト参照** として設計する
- `cli-run.ts` → `startMonitor(config, pipeline)` → `createMessageHandler({ pipeline })` + `new ReplHandler(..., pipeline)` の経路で同一参照を共有
- REPL の `filter set/clear` は `pipeline.filter` を直接書き換える
- Task 12 (CLI) と Task 13 (Router) と Task 14 (REPL) にこの経路を反映する

### [重大3] Template エラーハンドリング
- template コンパイルエラー時は `process.exit(1)` **しない**
- `log.warn()` で警告を出し、templateRenderer を null のままにする（通常表示にフォールバック）
- Task 12 のコード例を修正する

### [高4] Template パーサ: index access + 複数引数
- `TemplateExpr.path` は `(string | number)[]` に拡張し、`areaItems[0].name` をサポート
- `filterCall` の `:` 区切り引数は複数対応する（`replace:"foo":"bar"` → args: ["foo", "bar"]）
- Task 9 のパーサ実装を修正する

### [高5] REPL filter: 最終更新時刻 + prompt F:on
- `filterUpdatedAt: Date | null` を ReplHandler に追加
- `filter` 状態表示に最終更新時刻を含める
- prompt に `F:on` / `F:off` セグメントを追加（PromptStatusProvider 経由）
- Task 14 に反映する

### [高6] Filter 適用範囲: statusline / bell
- Phase 2 では **表示 + prompt** のみ filter 適用とする
- statusline / bell / activity は Phase 4 (focus mode) で対応する旨を明記する

### [中7] depth の「ごく浅い」テスト
- field-registry の depth getter テストに `"ごく浅い" → null`、`"10km" → 10`、`null → null` を追加
- Task 4 に反映する

### [中8] 公開 API 一本化
- filter: `src/engine/filter/index.ts` から `compileFilter` のみ export（`compile-filter.ts` は内部モジュール、index.ts が re-export）
- template: `src/engine/template/index.ts` から `compileTemplate` のみ export（`compile-template.ts` は内部）
- CLI/REPL は常に `index.ts` 経由で import する

### [中9] Router/REPL 統合テスト追加
- `test/engine/message-router.test.ts` に: filter 有効時に display 抑制・notify は通る・stats は増えるテスト
- Task 15 に反映する

---

## File Structure

### Filter サブシステム (`src/engine/filter/`)

| フ��イル | 責務 |
|---------|------|
| `types.ts` | FilterToken, FilterAST, FilterField, FilterKind 型定義 |
| `tokenizer.ts` | 入力文字列 → FilterToken[] |
| `parser.ts` | FilterToken[] → FilterAST (再帰下降) |
| `type-checker.ts` | AST のフィールド参照・型整合チェック |
| `compiler.ts` | AST → `(event: PresentationEvent) => boolean` |
| `field-registry.ts` | FilterField 定義レジストリ (全フィールドの getter + 型 + エイリアス) |
| `rank-maps.ts` | frameLevel / intensity / lgInt のランク変換 |
| `index.ts` | `compileFilter(expr: string): FilterPredicate` 公開 API |
| `errors.ts` | FilterSyntaxError, FilterTypeError 等の日本語エラー |

### Template サブシステム (`src/engine/template/`)

| ファイル | 責務 |
|---------|------|
| `types.ts` | TemplateNode, TemplateExpr, TemplatePredicate, TemplateFilterCall 型定義 |
| `tokenizer.ts` | テンプレート文字列 → TemplateToken[] |
| `parser.ts` | TemplateToken[] → TemplateNode[] |
| `filters.ts` | default, truncate, pad, join, date, replace, upper, lower フィルタ実装 |
| `compiler.ts` | TemplateNode[] → `(event: PresentationEvent) => string` |
| `field-accessor.ts` | PresentationEvent からのフィールド値取得 (template 用) |
| `index.ts` | `compileTemplate(tpl: string): TemplateRenderer` 公開 API |

### 統合 (`src/engine/filter-template/`)

| ファイル | 責務 |
|---------|------|
| `pipeline.ts` | FilterPredicate + TemplateRenderer をまとめて event に適用する関数 |

### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/engine/cli/cli.ts` | `--filter`, `--template` オプション追加 |
| `src/engine/cli/cli-run.ts` | RunMonitorOptions に filter/template 追加、コンパイル+注入 |
| `src/engine/messages/message-router.ts` | handler で filter 判定 → template 評価の呼び出し |
| `src/ui/repl.ts` | `filter` REPL コマンド追加 |
| `src/types.ts` | AppConfig に filter/template フィールド追加 |

### テストファイル

| ファイル | テスト対象 |
|---------|-----------|
| `test/engine/filter/tokenizer.test.ts` | トークナイザー |
| `test/engine/filter/parser.test.ts` | パーサ |
| `test/engine/filter/type-checker.test.ts` | 型チェック |
| `test/engine/filter/compiler.test.ts` | コンパイラ + 評価 |
| `test/engine/filter/field-registry.test.ts` | フィールド定義 |
| `test/engine/filter/integration.test.ts` | 文字列→predicate の統合テスト |
| `test/engine/template/tokenizer.test.ts` | テンプレートトークナイザー |
| `test/engine/template/parser.test.ts` | テンプレートパーサ |
| `test/engine/template/filters.test.ts` | テンプレートフィルタ |
| `test/engine/template/compiler.test.ts` | テンプレートコンパイラ |
| `test/engine/template/integration.test.ts` | 文字列→renderer の統合テスト |

---

## Task 1: Filter 型定義 + ランクマップ

**Files:**
- Create: `src/engine/filter/types.ts`
- Create: `src/engine/filter/rank-maps.ts`
- Create: `src/engine/filter/errors.ts`
- Test: `test/engine/filter/rank-maps.test.ts`

- [ ] **Step 1: Filter 型定義を作成**

```ts
// src/engine/filter/types.ts
import type { PresentationEvent } from "../presentation/types";

// ── Token ──

export type TokenKind =
  | "ident" | "string" | "number" | "boolean" | "null"
  | "op" | "lparen" | "rparen" | "lbracket" | "rbracket" | "comma"
  | "and" | "or" | "not"
  | "eof";

export interface FilterToken {
  kind: TokenKind;
  value: string;
  pos: number;
}

// ── AST ──

export type FilterAST =
  | OrNode
  | AndNode
  | NotNode
  | ComparisonNode
  | TruthyNode;

export interface OrNode {
  kind: "or";
  children: FilterAST[];
}

export interface AndNode {
  kind: "and";
  children: FilterAST[];
}

export interface NotNode {
  kind: "not";
  operand: FilterAST;
}

export interface ComparisonNode {
  kind: "comparison";
  left: ValueNode;
  op: CompOp;
  right: ValueNode;
}

export interface TruthyNode {
  kind: "truthy";
  value: ValueNode;
}

export type CompOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "~" | "!~" | "in" | "contains";

export type ValueNode =
  | { kind: "path"; segments: string[]; pos: number }
  | { kind: "string"; value: string; pos: number }
  | { kind: "number"; value: number; pos: number }
  | { kind: "boolean"; value: boolean; pos: number }
  | { kind: "null"; pos: number }
  | { kind: "list"; items: ValueNode[]; pos: number };

// ── Field Registry ──

export type FilterKind =
  | "string" | "number" | "boolean"
  | "string[]" | "number[]"
  | "enum:frameLevel" | "enum:intensity" | "enum:lgInt";

export interface FilterField<T = unknown> {
  kind: FilterKind;
  aliases: string[];
  get: (event: PresentationEvent) => T | null | undefined;
  supportsOrder?: boolean;
}

// ── Compiled ──

export type FilterPredicate = (event: PresentationEvent) => boolean;
```

- [ ] **Step 2: ランクマップを作成**

```ts
// src/engine/filter/rank-maps.ts
import type { FrameLevel } from "../../ui/formatter";

/** frameLevel → 数値ランク (順序比較用) */
export const FRAME_LEVEL_RANK: Record<string, number> = {
  cancel: 0,
  info: 1,
  normal: 2,
  warning: 3,
  critical: 4,
};

/** 震度文字列 → 数値ランク (順序比較用) */
export const INTENSITY_RANK: Record<string, number> = {
  "1": 1, "2": 2, "3": 3, "4": 4,
  "5-": 5, "5弱": 5, "5+": 6, "5強": 6,
  "6-": 7, "6弱": 7, "6+": 8, "6強": 8, "7": 9,
};

/** 長周期地震動階級 → 数値ランク */
export const LG_INT_RANK: Record<string, number> = {
  "0": 0, "1": 1, "2": 2, "3": 3, "4": 4,
};

/** 文字列からランク値を返す。未知の値は null */
export function toFrameLevelRank(value: string): number | null {
  return FRAME_LEVEL_RANK[value] ?? null;
}

export function toIntensityRank(value: string): number | null {
  return INTENSITY_RANK[value.replace(/\s+/g, "")] ?? null;
}

export function toLgIntRank(value: string): number | null {
  return LG_INT_RANK[value] ?? null;
}
```

- [ ] **Step 3: エラー型を作成**

```ts
// src/engine/filter/errors.ts

export class FilterSyntaxError extends Error {
  constructor(
    public readonly source: string,
    public readonly position: number,
    message: string,
  ) {
    super(message);
    this.name = "FilterSyntaxError";
  }

  /** 位置付きフォーマット済みエラー表示 */
  format(): string {
    const pointer = " ".repeat(this.position) + "^";
    return `フィルタ構文エラー: ${this.position + 1}文字目${this.message}\n${this.source}\n${pointer}`;
  }
}

export class FilterTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterTypeError";
  }
}

export class FilterFieldError extends Error {
  constructor(
    public readonly fieldName: string,
    public readonly availableFields: string[],
  ) {
    super(`未知のフィ���ルド: ${fieldName}`);
    this.name = "FilterFieldError";
  }

  format(): string {
    const examples = this.availableFields.slice(0, 6).join(", ");
    return `未知のフィールド: ${this.fieldName}\n使える例: ${examples}`;
  }
}
```

- [ ] **Step 4: ランクマップのテストを書く**

```ts
// test/engine/filter/rank-maps.test.ts
import { describe, it, expect } from "vitest";
import { toFrameLevelRank, toIntensityRank, toLgIntRank } from "../../../src/engine/filter/rank-maps";

describe("toFrameLevelRank", () => {
  it.each([
    ["cancel", 0], ["info", 1], ["normal", 2], ["warning", 3], ["critical", 4],
  ])("%s → %d", (input, expected) => {
    expect(toFrameLevelRank(input)).toBe(expected);
  });

  it("未知の値は null", () => {
    expect(toFrameLevelRank("unknown")).toBeNull();
  });
});

describe("toIntensityRank", () => {
  it.each([
    ["1", 1], ["4", 4], ["5-", 5], ["5弱", 5], ["5+", 6], ["5強", 6],
    ["6-", 7], ["6弱", 7], ["6+", 8], ["6強", 8], ["7", 9],
  ])("%s → %d", (input, expected) => {
    expect(toIntensityRank(input)).toBe(expected);
  });

  it("未知の値は null", () => {
    expect(toIntensityRank("unknown")).toBeNull();
  });
});

describe("toLgIntRank", () => {
  it.each([
    ["0", 0], ["1", 1], ["2", 2], ["3", 3], ["4", 4],
  ])("%s → %d", (input, expected) => {
    expect(toLgIntRank(input)).toBe(expected);
  });
});
```

- [ ] **Step 5: テスト実行**

Run: `npx vitest run test/engine/filter/rank-maps.test.ts`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/engine/filter/types.ts src/engine/filter/rank-maps.ts src/engine/filter/errors.ts test/engine/filter/rank-maps.test.ts
git commit -m "feat(filter): add filter type definitions, rank maps, and error types"
```

---

## Task 2: Filter トーク���イザー

**Files:**
- Create: `src/engine/filter/tokenizer.ts`
- Test: `test/engine/filter/tokenizer.test.ts`

- [ ] **Step 1: テストを書く**

```ts
// test/engine/filter/tokenizer.test.ts
import { describe, it, expect } from "vitest";
import { tokenize } from "../../../src/engine/filter/tokenizer";

describe("tokenize", () => {
  it("単純な比較: domain = \"eew\"", () => {
    const tokens = tokenize('domain = "eew"');
    expect(tokens.map((t) => [t.kind, t.value])).toEqual([
      ["ident", "domain"],
      ["op", "="],
      ["string", "eew"],
      ["eof", ""],
    ]);
  });

  it("数値リテラル: magnitude >= 6.5", () => {
    const tokens = tokenize("magnitude >= 6.5");
    expect(tokens.map((t) => [t.kind, t.value])).toEqual([
      ["ident", "magnitude"],
      ["op", ">="],
      ["number", "6.5"],
      ["eof", ""],
    ]);
  });

  it("論理演算子: domain = \"eew\" and isWarning = true", () => {
    const tokens = tokenize('domain = "eew" and isWarning = true');
    expect(tokens[3]).toEqual({ kind: "and", value: "and", pos: 15 });
    expect(tokens[4]).toEqual({ kind: "ident", value: "isWarning", pos: 19 });
  });

  it("not 演算子", () => {
    const tokens = tokenize("not isTest");
    expect(tokens[0]).toEqual({ kind: "not", value: "not", pos: 0 });
  });

  it("リスト: domain in [\"eew\", \"earthquake\"]", () => {
    const tokens = tokenize('domain in ["eew", "earthquake"]');
    const kinds = tokens.map((t) => t.kind);
    expect(kinds).toEqual(["ident", "op", "lbracket", "string", "comma", "string", "rbracket", "eof"]);
  });

  it("括弧", () => {
    const tokens = tokenize("(a or b)");
    expect(tokens[0].kind).toBe("lparen");
    expect(tokens[4].kind).toBe("rparen");
  });

  it("boolean と null", () => {
    const tokens = tokenize("true false null");
    expect(tokens[0]).toEqual({ kind: "boolean", value: "true", pos: 0 });
    expect(tokens[1]).toEqual({ kind: "boolean", value: "false", pos: 5 });
    expect(tokens[2]).toEqual({ kind: "null", value: "null", pos: 11 });
  });

  it("��規表現演算子: ~ と !~", () => {
    const tokens = tokenize('name ~ "能登"');
    expect(tokens[1]).toEqual({ kind: "op", value: "~", pos: 5 });
  });

  it("contains 演算子", () => {
    const tokens = tokenize("areaNames contains \"石川\"");
    expect(tokens[1]).toEqual({ kind: "op", value: "contains", pos: 10 });
  });

  it("dot パス: diff.previousMaxInt", () => {
    const tokens = tokenize("diff.previousMaxInt");
    expect(tokens[0]).toEqual({ kind: "ident", value: "diff.previousMaxInt", pos: 0 });
  });

  it("空文字は eof のみ", () => {
    const tokens = tokenize("");
    expect(tokens).toEqual([{ kind: "eof", value: "", pos: 0 }]);
  });

  it("閉じ引用符がない場合エラー", () => {
    expect(() => tokenize('"unclosed')).toThrow();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run test/engine/filter/tokenizer.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: トークナイザーを実装**

```ts
// src/engine/filter/tokenizer.ts
import { FilterToken, TokenKind } from "./types";
import { FilterSyntaxError } from "./errors";

const KEYWORDS: Record<string, TokenKind> = {
  and: "and",
  or: "or",
  not: "not",
  true: "boolean",
  false: "boolean",
  null: "null",
  in: "op",
  contains: "op",
};

const OPERATORS = ["!=", "<=", ">=", "!~", "=", "<", ">", "~"];

export function tokenize(source: string): FilterToken[] {
  const tokens: FilterToken[] = [];
  let i = 0;

  while (i < source.length) {
    // 空白スキップ
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }

    // 文字列リテラル
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      const start = i;
      i++; // 開き引用符
      let value = "";
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < source.length) {
          i++;
          value += source[i];
        } else {
          value += source[i];
        }
        i++;
      }
      if (i >= source.length) {
        throw new FilterSyntaxError(source, start, "で文字列が閉じられていない");
      }
      i++; // 閉じ引用符
      tokens.push({ kind: "string", value, pos: start });
      continue;
    }

    // 数値リテラル
    if (/[0-9]/.test(source[i]) || (source[i] === "-" && i + 1 < source.length && /[0-9]/.test(source[i + 1]))) {
      const start = i;
      if (source[i] === "-") i++;
      while (i < source.length && /[0-9]/.test(source[i])) i++;
      if (i < source.length && source[i] === ".") {
        i++;
        while (i < source.length && /[0-9]/.test(source[i])) i++;
      }
      tokens.push({ kind: "number", value: source.slice(start, i), pos: start });
      continue;
    }

    // 括弧・ブラケット・カンマ
    if (source[i] === "(") { tokens.push({ kind: "lparen", value: "(", pos: i }); i++; continue; }
    if (source[i] === ")") { tokens.push({ kind: "rparen", value: ")", pos: i }); i++; continue; }
    if (source[i] === "[") { tokens.push({ kind: "lbracket", value: "[", pos: i }); i++; continue; }
    if (source[i] === "]") { tokens.push({ kind: "rbracket", value: "]", pos: i }); i++; continue; }
    if (source[i] === ",") { tokens.push({ kind: "comma", value: ",", pos: i }); i++; continue; }

    // 演算子
    let matchedOp: string | null = null;
    for (const op of OPERATORS) {
      if (source.startsWith(op, i)) {
        matchedOp = op;
        break;
      }
    }
    if (matchedOp != null) {
      tokens.push({ kind: "op", value: matchedOp, pos: i });
      i += matchedOp.length;
      continue;
    }

    // 識別子 / キーワード (dot パス含む)
    if (/[a-zA-Z_]/.test(source[i])) {
      const start = i;
      while (i < source.length && /[a-zA-Z0-9_.]/.test(source[i])) i++;
      const word = source.slice(start, i);
      const keyword = KEYWORDS[word];
      if (keyword != null) {
        tokens.push({ kind: keyword, value: word, pos: start });
      } else {
        tokens.push({ kind: "ident", value: word, pos: start });
      }
      continue;
    }

    throw new FilterSyntaxError(source, i, `で予期しない文字 '${source[i]}'`);
  }

  tokens.push({ kind: "eof", value: "", pos: source.length });
  return tokens;
}
```

- [ ] **Step 4: テスト実行**

Run: `npx vitest run test/engine/filter/tokenizer.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/engine/filter/tokenizer.ts test/engine/filter/tokenizer.test.ts
git commit -m "feat(filter): add tokenizer for filter expressions"
```

---

## Task 3: Filter パーサ

**Files:**
- Create: `src/engine/filter/parser.ts`
- Test: `test/engine/filter/parser.test.ts`

- [ ] **Step 1: テストを書く**

```ts
// test/engine/filter/parser.test.ts
import { describe, it, expect } from "vitest";
import { parse } from "../../../src/engine/filter/parser";
import { tokenize } from "../../../src/engine/filter/tokenizer";

function parseExpr(source: string) {
  return parse(tokenize(source), source);
}

describe("parse", () => {
  it("単一比較: domain = \"eew\"", () => {
    const ast = parseExpr('domain = "eew"');
    expect(ast).toEqual({
      kind: "comparison",
      left: { kind: "path", segments: ["domain"], pos: 0 },
      op: "=",
      right: { kind: "string", value: "eew", pos: 9 },
    });
  });

  it("and 結合", () => {
    const ast = parseExpr('domain = "eew" and isWarning = true');
    expect(ast.kind).toBe("and");
    if (ast.kind === "and") {
      expect(ast.children).toHaveLength(2);
      expect(ast.children[0].kind).toBe("comparison");
      expect(ast.children[1].kind).toBe("comparison");
    }
  });

  it("or 結合", () => {
    const ast = parseExpr('a = 1 or b = 2');
    expect(ast.kind).toBe("or");
  });

  it("and は or より優先", () => {
    const ast = parseExpr('a = 1 or b = 2 and c = 3');
    expect(ast.kind).toBe("or");
    if (ast.kind === "or") {
      expect(ast.children[1].kind).toBe("and");
    }
  });

  it("not 演算子", () => {
    const ast = parseExpr("not isTest");
    expect(ast.kind).toBe("not");
    if (ast.kind === "not") {
      expect(ast.operand.kind).toBe("truthy");
    }
  });

  it("括弧でグループ化", () => {
    const ast = parseExpr("(a = 1 or b = 2) and c = 3");
    expect(ast.kind).toBe("and");
  });

  it("in リスト", () => {
    const ast = parseExpr('domain in ["eew", "earthquake"]');
    expect(ast.kind).toBe("comparison");
    if (ast.kind === "comparison") {
      expect(ast.op).toBe("in");
      expect(ast.right.kind).toBe("list");
    }
  });

  it("truthy (単一パス)", () => {
    const ast = parseExpr("isWarning");
    expect(ast.kind).toBe("truthy");
  });

  it("パース失敗: 演算子の後に値がない", () => {
    expect(() => parseExpr('domain =')).toThrow();
  });

  it("パース失敗: 閉じ括弧がない", () => {
    expect(() => parseExpr("(a = 1")).toThrow();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run test/engine/filter/parser.test.ts`
Expected: FAIL

- [ ] **Step 3: パーサを実装**

```ts
// src/engine/filter/parser.ts
import type { FilterToken, FilterAST, ValueNode, CompOp } from "./types";
import { FilterSyntaxError } from "./errors";

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: FilterToken[],
    private readonly source: string,
  ) {}

  parse(): FilterAST {
    const ast = this.parseOr();
    if (this.current().kind !== "eof") {
      throw new FilterSyntaxError(this.source, this.current().pos, "で予期しないトークン");
    }
    return ast;
  }

  private parseOr(): FilterAST {
    const children: FilterAST[] = [this.parseAnd()];
    while (this.current().kind === "or") {
      this.advance();
      children.push(this.parseAnd());
    }
    return children.length === 1 ? children[0] : { kind: "or", children };
  }

  private parseAnd(): FilterAST {
    const children: FilterAST[] = [this.parseUnary()];
    while (this.current().kind === "and") {
      this.advance();
      children.push(this.parseUnary());
    }
    return children.length === 1 ? children[0] : { kind: "and", children };
  }

  private parseUnary(): FilterAST {
    if (this.current().kind === "not") {
      this.advance();
      return { kind: "not", operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FilterAST {
    if (this.current().kind === "lparen") {
      this.advance();
      const expr = this.parseOr();
      this.expect("rparen", "で閉じ括弧 ')' が必要");
      return expr;
    }

    const left = this.parseValue();
    const op = this.tryCompOp();
    if (op == null) {
      return { kind: "truthy", value: left };
    }
    const right = this.parseValue();
    return { kind: "comparison", left, op, right };
  }

  private parseValue(): ValueNode {
    const token = this.current();
    switch (token.kind) {
      case "ident":
        this.advance();
        return { kind: "path", segments: token.value.split("."), pos: token.pos };
      case "string":
        this.advance();
        return { kind: "string", value: token.value, pos: token.pos };
      case "number":
        this.advance();
        return { kind: "number", value: Number(token.value), pos: token.pos };
      case "boolean":
        this.advance();
        return { kind: "boolean", value: token.value === "true", pos: token.pos };
      case "null":
        this.advance();
        return { kind: "null", pos: token.pos };
      case "lbracket":
        return this.parseList();
      default:
        throw new FilterSyntaxError(this.source, token.pos, "で値が必要");
    }
  }

  private parseList(): ValueNode {
    const start = this.current().pos;
    this.expect("lbracket", "で '[' が必要");
    const items: ValueNode[] = [];
    while (this.current().kind !== "rbracket") {
      if (items.length > 0) {
        this.expect("comma", "で ',' が必要");
      }
      items.push(this.parseValue());
    }
    this.expect("rbracket", "で ']' が必要");
    return { kind: "list", items, pos: start };
  }

  private tryCompOp(): CompOp | null {
    const token = this.current();
    if (token.kind === "op") {
      this.advance();
      return token.value as CompOp;
    }
    return null;
  }

  private current(): FilterToken {
    return this.tokens[this.pos];
  }

  private advance(): FilterToken {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return token;
  }

  private expect(kind: string, errorMsg: string): void {
    if (this.current().kind !== kind) {
      throw new FilterSyntaxError(this.source, this.current().pos, errorMsg);
    }
    this.advance();
  }
}

export function parse(tokens: FilterToken[], source: string): FilterAST {
  return new Parser(tokens, source).parse();
}
```

- [ ] **Step 4: テスト実行**

Run: `npx vitest run test/engine/filter/parser.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/engine/filter/parser.ts test/engine/filter/parser.test.ts
git commit -m "feat(filter): add recursive descent parser for filter expressions"
```

---

## Task 4: フィールドレジストリ

**Files:**
- Create: `src/engine/filter/field-registry.ts`
- Test: `test/engine/filter/field-registry.test.ts`

- [ ] **Step 1: テストを書く**

```ts
// test/engine/filter/field-registry.test.ts
import { describe, it, expect } from "vitest";
import { resolveField, FILTER_FIELDS } from "../../../src/engine/filter/field-registry";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

function makeEvent(overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  return {
    id: "test-1",
    classification: "eew.forecast",
    domain: "eew",
    type: "VXSE43",
    infoType: "発表",
    title: "緊急地震速報（警報）",
    headline: null,
    reportDateTime: "2025-01-01T00:00:00+09:00",
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: "critical",
    isCancellation: false,
    areaNames: [],
    forecastAreaNames: ["石川県能登"],
    municipalityNames: [],
    observationNames: [],
    areaCount: 0,
    forecastAreaCount: 1,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],
    raw: null,
    ...overrides,
  };
}

describe("resolveField", () => {
  it("正式名でフィールドを取得", () => {
    const field = resolveField("domain");
    expect(field).not.toBeNull();
    expect(field!.kind).toBe("string");
  });

  it("エイリアスでフィールドを取得", () => {
    const field = resolveField("type");
    expect(field).not.toBeNull();
  });

  it("未知のフィールドは null", () => {
    expect(resolveField("nonExistent")).toBeNull();
  });
});

describe("field getters", () => {
  it("domain を取得", () => {
    const event = makeEvent({ domain: "eew" });
    const field = resolveField("domain")!;
    expect(field.get(event)).toBe("eew");
  });

  it("frameLevel を取得", () => {
    const event = makeEvent({ frameLevel: "critical" });
    const field = resolveField("frameLevel")!;
    expect(field.get(event)).toBe("critical");
  });

  it("maxInt を取得", () => {
    const event = makeEvent({ maxInt: "6+" });
    const field = resolveField("maxInt")!;
    expect(field.get(event)).toBe("6+");
  });

  it("magnitude (number型) を取得", () => {
    const event = makeEvent({ magnitude: "7.3" });
    const field = resolveField("magnitude")!;
    expect(field.get(event)).toBe(7.3);
  });

  it("isWarning (boolean型) を取得", () => {
    const event = makeEvent({ isWarning: true });
    const field = resolveField("isWarning")!;
    expect(field.get(event)).toBe(true);
  });

  it("forecastAreaNames (string[]型) を取得", () => {
    const event = makeEvent({ forecastAreaNames: ["石川県能登", "新潟県上越"] });
    const field = resolveField("forecastAreaNames")!;
    expect(field.get(event)).toEqual(["石川県能登", "新潟県上越"]);
  });

  it("volcanoName を取得", () => {
    const event = makeEvent({ volcanoName: "桜島" });
    const field = resolveField("volcanoName")!;
    expect(field.get(event)).toBe("桜島");
  });

  it("alertLevel (number型) を取得", () => {
    const event = makeEvent({ alertLevel: 3 });
    const field = resolveField("alertLevel")!;
    expect(field.get(event)).toBe(3);
  });

  it("depth (number型) を取得", () => {
    const event = makeEvent({ depth: "10km" });
    const field = resolveField("depth")!;
    expect(field.get(event)).toBe(10);
  });

  it("tsunamiKinds (string[]型) を取得", () => {
    const event = makeEvent({ tsunamiKinds: ["津波警報", "津波注意報"] });
    const field = resolveField("tsunamiKinds")!;
    expect(field.get(event)).toEqual(["津波警報", "津波注意報"]);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run test/engine/filter/field-registry.test.ts`
Expected: FAIL

- [ ] **Step 3: フィールドレジストリを実装**

```ts
// src/engine/filter/field-registry.ts
import type { PresentationEvent } from "../presentation/types";
import type { FilterField, FilterKind } from "./types";

function field<T>(kind: FilterKind, aliases: string[], get: (e: PresentationEvent) => T | null | undefined, supportsOrder?: boolean): FilterField<T> {
  return { kind, aliases, get, supportsOrder };
}

/** depth 文字列 "10km" → 数値 10 */
function parseDepth(d: string | null | undefined): number | null {
  if (d == null) return null;
  const m = d.match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

/** magnitude 文字列 → 数値 */
function parseMagnitude(m: string | null | undefined): number | null {
  if (m == null) return null;
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
}

export const FILTER_FIELDS: Record<string, FilterField> = {
  // 識別
  domain: field("string", [], (e) => e.domain),
  type: field("string", ["headType"], (e) => e.type),
  subType: field("string", [], (e) => e.subType),
  classification: field("string", [], (e) => e.classification),
  id: field("string", [], (e) => e.id),
  infoType: field("string", [], (e) => e.infoType),

  // レベル
  frameLevel: field("enum:frameLevel", ["level"], (e) => e.frameLevel, true),

  // 状態フラグ
  isCancellation: field("boolean", ["isCancelled"], (e) => e.isCancellation),
  isWarning: field("boolean", [], (e) => e.isWarning),
  isFinal: field("boolean", [], (e) => e.isFinal),
  isTest: field("boolean", [], (e) => e.isTest),
  isRenotification: field("boolean", [], (e) => e.isRenotification),

  // イベント追跡
  eventId: field("string", [], (e) => e.eventId),
  serial: field("string", [], (e) => e.serial),
  volcanoCode: field("string", [], (e) => e.volcanoCode),
  volcanoName: field("string", [], (e) => e.volcanoName),

  // 震源情報
  hypocenterName: field("string", ["hypocenter"], (e) => e.hypocenterName),
  depth: field("number", [], (e) => parseDepth(e.depth), true),
  magnitude: field("number", ["mag"], (e) => parseMagnitude(e.magnitude), true),

  // 強度
  maxInt: field("enum:intensity", [], (e) => e.maxInt, true),
  maxLgInt: field("enum:lgInt", [], (e) => e.maxLgInt, true),
  forecastMaxInt: field("enum:intensity", [], (e) => e.forecastMaxInt, true),
  alertLevel: field("number", [], (e) => e.alertLevel, true),

  // テキスト
  title: field("string", [], (e) => e.title),
  headline: field("string", [], (e) => e.headline),

  // 地域集約
  areaNames: field("string[]", [], (e) => e.areaNames),
  forecastAreaNames: field("string[]", [], (e) => e.forecastAreaNames),
  municipalityNames: field("string[]", [], (e) => e.municipalityNames),
  observationNames: field("string[]", [], (e) => e.observationNames),
  areaCount: field("number", [], (e) => e.areaCount),

  // 津波
  tsunamiKinds: field("string[]", [], (e) => e.tsunamiKinds),
};

/** フィールド名 or エイリアスから FilterField を解決する */
export function resolveField(name: string): FilterField | null {
  if (name in FILTER_FIELDS) return FILTER_FIELDS[name];
  for (const [, field] of Object.entries(FILTER_FIELDS)) {
    if (field.aliases.includes(name)) return field;
  }
  return null;
}

/** 公開フィールド名一覧 (エラーメッセージ用) */
export function fieldNames(): string[] {
  return Object.keys(FILTER_FIELDS);
}
```

- [ ] **Step 4: テスト実行**

Run: `npx vitest run test/engine/filter/field-registry.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/engine/filter/field-registry.ts test/engine/filter/field-registry.test.ts
git commit -m "feat(filter): add field registry with getter functions and aliases"
```

---

## Task 5: 型チェッカー

**Files:**
- Create: `src/engine/filter/type-checker.ts`
- Test: `test/engine/filter/type-checker.test.ts`

- [ ] **Step 1: テストを書く**

```ts
// test/engine/filter/type-checker.test.ts
import { describe, it, expect } from "vitest";
import { typeCheck } from "../../../src/engine/filter/type-checker";
import { parse } from "../../../src/engine/filter/parser";
import { tokenize } from "../../../src/engine/filter/tokenizer";

function check(source: string) {
  const ast = parse(tokenize(source), source);
  return typeCheck(ast, source);
}

describe("typeCheck", () => {
  it("正常: string = string", () => {
    expect(() => check('domain = "eew"')).not.toThrow();
  });

  it("正常: number >= number", () => {
    expect(() => check("magnitude >= 6.5")).not.toThrow();
  });

  it("正常: enum:intensity 順序比較", () => {
    expect(() => check('maxInt >= "5-"')).not.toThrow();
  });

  it("正常: enum:frameLevel 順序比較", () => {
    expect(() => check('frameLevel >= "warning"')).not.toThrow();
  });

  it("正常: boolean truthy", () => {
    expect(() => check("isWarning")).not.toThrow();
  });

  it("正常: string[] contains string", () => {
    expect(() => check('forecastAreaNames contains "石川県"')).not.toThrow();
  });

  it("正常: in リスト", () => {
    expect(() => check('domain in ["eew", "earthquake"]')).not.toThrow();
  });

  it("正常: regex マッチ", () => {
    expect(() => check('hypocenterName ~ "能登|佐渡"')).not.toThrow();
  });

  it("エラー: 未知のフィールド", () => {
    expect(() => check('foo = "bar"')).toThrow(/未知のフィールド/);
  });

  it("エラー: enum:intensity に数値リテラル", () => {
    expect(() => check("maxInt >= 5")).toThrow(/震度文字列/);
  });

  it("エラー: 不正な正規表現", () => {
    expect(() => check('hypocenterName ~ "能登("')).toThrow(/正規表現/);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run test/engine/filter/type-checker.test.ts`
Expected: FAIL

- [ ] **Step 3: 型チェッカーを実装**

```ts
// src/engine/filter/type-checker.ts
import type { FilterAST, ValueNode, CompOp } from "./types";
import { resolveField, fieldNames } from "./field-registry";
import { FilterTypeError, FilterFieldError } from "./errors";

/** AST を走査し、フィールド参照と演算子の型整合を検証す�� */
export function typeCheck(ast: FilterAST, source: string): void {
  switch (ast.kind) {
    case "or":
    case "and":
      for (const child of ast.children) typeCheck(child, source);
      break;
    case "not":
      typeCheck(ast.operand, source);
      break;
    case "truthy":
      validateFieldExists(ast.value);
      break;
    case "comparison":
      validateComparison(ast.left, ast.op, ast.right, source);
      break;
  }
}

function validateFieldExists(node: ValueNode): void {
  if (node.kind === "path") {
    const name = node.segments.join(".");
    const field = resolveField(name);
    if (field == null) {
      throw new FilterFieldError(name, fieldNames());
    }
  }
}

function validateComparison(left: ValueNode, op: CompOp, right: ValueNode, source: string): void {
  // パスが左辺にある場合のフィールド検証
  if (left.kind === "path") {
    const name = left.segments.join(".");
    const field = resolveField(name);
    if (field == null) {
      throw new FilterFieldError(name, fieldNames());
    }

    // enum 型に対する数値リテラルチェック
    if (field.kind === "enum:intensity" && right.kind === "number") {
      throw new FilterTypeError(
        `型が不一致: ${name} ${op} ${right.value}\n` +
        `\`${name}\` は震度文字列("1", "5-", "6+"等)で比較する。数値リテラルは使えない`
      );
    }

    if (field.kind === "enum:lgInt" && right.kind === "number") {
      throw new FilterTypeError(
        `型が不一致: ${name} ${op} ${right.value}\n` +
        `\`${name}\` は長周期階級文字列("0"〜"4")で比較する。数値リテラルは使えない`
      );
    }

    // 順序比較の型検���
    if (op === "<" || op === "<=" || op === ">" || op === ">=") {
      if (!field.supportsOrder) {
        throw new FilterTypeError(
          `\`${name}\` (${field.kind}) は順序比較に対応していない`
        );
      }
    }

    // regex 演算子の検証
    if (op === "~" || op === "!~") {
      if (field.kind !== "string" && field.kind !== "enum:frameLevel" && field.kind !== "enum:intensity" && field.kind !== "enum:lgInt") {
        throw new FilterTypeError(`\`${name}\` (${field.kind}) は正規表現マッチに対応していない`);
      }
      if (right.kind === "string") {
        try {
          new RegExp(right.value);
        } catch {
          throw new FilterTypeError(`正規表現が不正だ: "~" の右辺 "${right.value}" を解釈できない`);
        }
      }
    }

    // contains の検証
    if (op === "contains") {
      if (field.kind !== "string[]" && field.kind !== "number[]" && field.kind !== "string") {
        throw new FilterTypeError(`\`${name}\` (${field.kind}) は contains に対応していない`);
      }
    }
  }

  // 右辺のパスも検証
  if (right.kind === "path") {
    validateFieldExists(right);
  }
}
```

- [ ] **Step 4: テスト実行**

Run: `npx vitest run test/engine/filter/type-checker.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/engine/filter/type-checker.ts test/engine/filter/type-checker.test.ts
git commit -m "feat(filter): add type checker for field/operator validation"
```

---

## Task 6: Filter コンパイラ

**Files:**
- Create: `src/engine/filter/compiler.ts`
- Test: `test/engine/filter/compiler.test.ts`

- [ ] **Step 1: テストを書く**

```ts
// test/engine/filter/compiler.test.ts
import { describe, it, expect } from "vitest";
import { compile } from "../../../src/engine/filter/compiler";
import { parse } from "../../../src/engine/filter/parser";
import { tokenize } from "../../../src/engine/filter/tokenizer";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

function makeEvent(overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  return {
    id: "test-1", classification: "eew.forecast", domain: "eew", type: "VXSE43",
    infoType: "発表", title: "緊急地震速報（警報）", headline: null,
    reportDateTime: "2025-01-01T00:00:00+09:00", publishingOffice: "気象庁",
    isTest: false, frameLevel: "critical", isCancellation: false,
    areaNames: [], forecastAreaNames: [], municipalityNames: [], observationNames: [],
    areaCount: 0, forecastAreaCount: 0, municipalityCount: 0, observationCount: 0,
    areaItems: [], raw: null, ...overrides,
  };
}

function compileFilter(source: string) {
  const ast = parse(tokenize(source), source);
  return compile(ast);
}

describe("compile", () => {
  it("= 完全一致", () => {
    const pred = compileFilter('domain = "eew"');
    expect(pred(makeEvent({ domain: "eew" }))).toBe(true);
    expect(pred(makeEvent({ domain: "earthquake" }))).toBe(false);
  });

  it("!= 不一致", () => {
    const pred = compileFilter('domain != "eew"');
    expect(pred(makeEvent({ domain: "earthquake" }))).toBe(true);
  });

  it(">= number", () => {
    const pred = compileFilter("magnitude >= 6.5");
    expect(pred(makeEvent({ magnitude: "7.3" }))).toBe(true);
    expect(pred(makeEvent({ magnitude: "5.0" }))).toBe(false);
  });

  it(">= enum:intensity", () => {
    const pred = compileFilter('maxInt >= "5-"');
    expect(pred(makeEvent({ maxInt: "6+" }))).toBe(true);
    expect(pred(makeEvent({ maxInt: "4" }))).toBe(false);
    expect(pred(makeEvent({ maxInt: "5-" }))).toBe(true);
  });

  it(">= enum:frameLevel", () => {
    const pred = compileFilter('frameLevel >= "warning"');
    expect(pred(makeEvent({ frameLevel: "critical" }))).toBe(true);
    expect(pred(makeEvent({ frameLevel: "info" }))).toBe(false);
  });

  it("~ regex マッチ", () => {
    const pred = compileFilter('hypocenterName ~ "能登|佐渡"');
    expect(pred(makeEvent({ hypocenterName: "石川県能登地方" }))).toBe(true);
    expect(pred(makeEvent({ hypocenterName: "日向灘" }))).toBe(false);
  });

  it("!~ regex 非マッチ", () => {
    const pred = compileFilter('hypocenterName !~ "能登"');
    expect(pred(makeEvent({ hypocenterName: "日向灘" }))).toBe(true);
  });

  it("in リスト", () => {
    const pred = compileFilter('domain in ["eew", "earthquake"]');
    expect(pred(makeEvent({ domain: "eew" }))).toBe(true);
    expect(pred(makeEvent({ domain: "tsunami" }))).toBe(false);
  });

  it("contains (配列)", () => {
    const pred = compileFilter('forecastAreaNames contains "石川県能登"');
    expect(pred(makeEvent({ forecastAreaNames: ["石川県能登", "新潟県上越"] }))).toBe(true);
    expect(pred(makeEvent({ forecastAreaNames: ["福岡県"] }))).toBe(false);
  });

  it("contains (文字列部分一致)", () => {
    const pred = compileFilter('title contains "警報"');
    expect(pred(makeEvent({ title: "緊急地震速報（警報）" }))).toBe(true);
    expect(pred(makeEvent({ title: "震度速報" }))).toBe(false);
  });

  it("and 結合", () => {
    const pred = compileFilter('domain = "eew" and isWarning = true');
    expect(pred(makeEvent({ domain: "eew", isWarning: true }))).toBe(true);
    expect(pred(makeEvent({ domain: "eew", isWarning: false }))).toBe(false);
  });

  it("or 結合", () => {
    const pred = compileFilter('domain = "eew" or domain = "earthquake"');
    expect(pred(makeEvent({ domain: "eew" }))).toBe(true);
    expect(pred(makeEvent({ domain: "tsunami" }))).toBe(false);
  });

  it("not 演算子", () => {
    const pred = compileFilter("not isTest");
    expect(pred(makeEvent({ isTest: false }))).toBe(true);
    expect(pred(makeEvent({ isTest: true }))).toBe(false);
  });

  it("truthy (boolean フィールド)", () => {
    const pred = compileFilter("isWarning");
    expect(pred(makeEvent({ isWarning: true }))).toBe(true);
    expect(pred(makeEvent({ isWarning: false }))).toBe(false);
  });

  it("null フィールドとの比較は false", () => {
    const pred = compileFilter('maxInt >= "4"');
    expect(pred(makeEvent({ maxInt: null }))).toBe(false);
    expect(pred(makeEvent({}))).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run test/engine/filter/compiler.test.ts`
Expected: FAIL

- [ ] **Step 3: コンパイラを実装**

```ts
// src/engine/filter/compiler.ts
import type { FilterAST, ValueNode, CompOp, FilterPredicate } from "./types";
import type { PresentationEvent } from "../presentation/types";
import { resolveField } from "./field-registry";
import { toFrameLevelRank, toIntensityRank, toLgIntRank } from "./rank-maps";

export function compile(ast: FilterAST): FilterPredicate {
  switch (ast.kind) {
    case "or":
      return compileOr(ast.children.map(compile));
    case "and":
      return compileAnd(ast.children.map(compile));
    case "not":
      return compileNot(compile(ast.operand));
    case "truthy":
      return compileTruthy(ast.value);
    case "comparison":
      return compileComparison(ast.left, ast.op, ast.right);
  }
}

function compileOr(predicates: FilterPredicate[]): FilterPredicate {
  return (event) => predicates.some((p) => p(event));
}

function compileAnd(predicates: FilterPredicate[]): FilterPredicate {
  return (event) => predicates.every((p) => p(event));
}

function compileNot(predicate: FilterPredicate): FilterPredicate {
  return (event) => !predicate(event);
}

function compileTruthy(node: ValueNode): FilterPredicate {
  const getter = makeGetter(node);
  return (event) => {
    const val = getter(event);
    return val != null && val !== false && val !== "" && val !== 0;
  };
}

function compileComparison(left: ValueNode, op: CompOp, right: ValueNode): FilterPredicate {
  const getLeft = makeGetter(left);
  const getRight = makeGetter(right);

  // フィールドの型情報を取得 (enum ランク変換用)
  const leftField = left.kind === "path" ? resolveField(left.segments.join(".")) : null;
  const rankFn = leftField ? getRankFn(leftField.kind) : null;

  switch (op) {
    case "=":
      return (event) => {
        const l = getLeft(event);
        const r = getRight(event);
        if (l == null || r == null) return false;
        return l === r;
      };
    case "!=":
      return (event) => {
        const l = getLeft(event);
        const r = getRight(event);
        if (l == null || r == null) return false;
        return l !== r;
      };
    case "<": case "<=": case ">": case ">=":
      return (event) => {
        let l = getLeft(event);
        let r = getRight(event);
        if (l == null || r == null) return false;
        if (rankFn != null) {
          l = rankFn(String(l));
          r = rankFn(String(r));
          if (l == null || r == null) return false;
        }
        return compareOrdered(l as number, op, r as number);
      };
    case "~":
      return (event) => {
        const l = getLeft(event);
        const r = getRight(event);
        if (l == null || r == null) return false;
        return new RegExp(String(r)).test(String(l));
      };
    case "!~":
      return (event) => {
        const l = getLeft(event);
        const r = getRight(event);
        if (l == null || r == null) return false;
        return !new RegExp(String(r)).test(String(l));
      };
    case "in":
      return (event) => {
        const l = getLeft(event);
        const r = getRight(event);
        if (l == null || r == null) return false;
        if (Array.isArray(r)) return r.includes(l);
        return false;
      };
    case "contains":
      return (event) => {
        const l = getLeft(event);
        const r = getRight(event);
        if (l == null || r == null) return false;
        if (Array.isArray(l)) return l.includes(r);
        if (typeof l === "string" && typeof r === "string") return l.includes(r);
        return false;
      };
  }
}

function makeGetter(node: ValueNode): (event: PresentationEvent) => unknown {
  switch (node.kind) {
    case "path": {
      const field = resolveField(node.segments.join("."));
      if (field == null) return () => null;
      return (event) => field.get(event);
    }
    case "string":
      return () => node.value;
    case "number":
      return () => node.value;
    case "boolean":
      return () => node.value;
    case "null":
      return () => null;
    case "list":
      return () => node.items.map((item) => {
        switch (item.kind) {
          case "string": return item.value;
          case "number": return item.value;
          case "boolean": return item.value;
          default: return null;
        }
      });
  }
}

function compareOrdered(l: number, op: string, r: number): boolean {
  switch (op) {
    case "<": return l < r;
    case "<=": return l <= r;
    case ">": return l > r;
    case ">=": return l >= r;
    default: return false;
  }
}

function getRankFn(kind: string): ((s: string) => number | null) | null {
  switch (kind) {
    case "enum:frameLevel": return toFrameLevelRank;
    case "enum:intensity": return toIntensityRank;
    case "enum:lgInt": return toLgIntRank;
    default: return null;
  }
}
```

- [ ] **Step 4: テスト実行**

Run: `npx vitest run test/engine/filter/compiler.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/engine/filter/compiler.ts test/engine/filter/compiler.test.ts
git commit -m "feat(filter): add compiler that produces predicate functions from AST"
```

---

## Task 7: Filter 公開 API + 統合テスト

**Files:**
- Create: `src/engine/filter/index.ts`
- Test: `test/engine/filter/integration.test.ts`

- [ ] **Step 1: 公開 API を作成**

```ts
// src/engine/filter/index.ts
export type { FilterPredicate, FilterAST, FilterField, FilterKind } from "./types";
export { FilterSyntaxError, FilterTypeError, FilterFieldError } from "./errors";
export { resolveField, fieldNames } from "./field-registry";
export { compileFilter } from "./compile-filter";

// src/engine/filter/compile-filter.ts (分離)
import type { FilterPredicate } from "./types";
import { tokenize } from "./tokenizer";
import { parse } from "./parser";
import { typeCheck } from "./type-checker";
import { compile } from "./compiler";

/**
 * フィルタ式をコンパイルして predicate 関数を返す。
 * 構文エラー・型エラー時は FilterSyntaxError / FilterTypeError / FilterFieldError を投げる。
 */
export function compileFilter(expr: string): FilterPredicate {
  const tokens = tokenize(expr);
  const ast = parse(tokens, expr);
  typeCheck(ast, expr);
  return compile(ast);
}
```

- [ ] **Step 2: 統合テストを書く**

```ts
// test/engine/filter/integration.test.ts
import { describe, it, expect } from "vitest";
import { compileFilter } from "../../../src/engine/filter/compile-filter";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

function makeEvent(overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  return {
    id: "test-1", classification: "eew.forecast", domain: "eew", type: "VXSE43",
    infoType: "発表", title: "緊急地震速報（警報）", headline: null,
    reportDateTime: "2025-01-01T00:00:00+09:00", publishingOffice: "気象庁",
    isTest: false, frameLevel: "critical", isCancellation: false, isWarning: true,
    areaNames: [], forecastAreaNames: ["石川県能登"], municipalityNames: [],
    observationNames: [], areaCount: 0, forecastAreaCount: 1, municipalityCount: 0,
    observationCount: 0, areaItems: [], raw: null, ...overrides,
  };
}

describe("compileFilter 統合テスト", () => {
  it("EEW 警報のみ", () => {
    const pred = compileFilter('domain = "eew" and isWarning = true');
    expect(pred(makeEvent())).toBe(true);
    expect(pred(makeEvent({ isWarning: false }))).toBe(false);
    expect(pred(makeEvent({ domain: "earthquake" }))).toBe(false);
  });

  it("震度5弱以上の地震", () => {
    const pred = compileFilter('domain = "earthquake" and maxInt >= "5-"');
    expect(pred(makeEvent({ domain: "earthquake", maxInt: "6+" }))).toBe(true);
    expect(pred(makeEvent({ domain: "earthquake", maxInt: "4" }))).toBe(false);
  });

  it("複合条件: (critical or alertLevel >= 4) and not isTest", () => {
    const pred = compileFilter('(frameLevel = "critical" or alertLevel >= 4) and not isTest');
    expect(pred(makeEvent({ frameLevel: "critical", isTest: false }))).toBe(true);
    expect(pred(makeEvent({ frameLevel: "info", alertLevel: 4, isTest: false }))).toBe(true);
    expect(pred(makeEvent({ frameLevel: "critical", isTest: true }))).toBe(false);
  });

  it("火山: 特定火山名", () => {
    const pred = compileFilter('volcanoName ~ "桜島|阿蘇"');
    expect(pred(makeEvent({ volcanoName: "桜島" }))).toBe(true);
    expect(pred(makeEvent({ volcanoName: "富士山" }))).toBe(false);
  });

  it("津波: tsunamiKinds contains", () => {
    const pred = compileFilter('tsunamiKinds contains "大津波警報"');
    expect(pred(makeEvent({ tsunamiKinds: ["大津波警報", "津波警報"] }))).toBe(true);
    expect(pred(makeEvent({ tsunamiKinds: ["津波注意報"] }))).toBe(false);
  });

  it("複数 filter (AND 結合) をシミュレート", () => {
    const pred1 = compileFilter('domain = "eew"');
    const pred2 = compileFilter("isWarning = true");
    const combined = (event: PresentationEvent) => pred1(event) && pred2(event);
    expect(combined(makeEvent())).toBe(true);
    expect(combined(makeEvent({ isWarning: false }))).toBe(false);
  });

  it("構文エラー: 不完全な式", () => {
    expect(() => compileFilter('domain =')).toThrow();
  });

  it("型エラー: maxInt に数値", () => {
    expect(() => compileFilter("maxInt >= 5")).toThrow(/震度文字列/);
  });

  it("フィールドエラー: 未知のフィールド", () => {
    expect(() => compileFilter('foo = "bar"')).toThrow(/未知のフィールド/);
  });
});
```

- [ ] **Step 3: テスト実行**

Run: `npx vitest run test/engine/filter/integration.test.ts`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
git add src/engine/filter/index.ts src/engine/filter/compile-filter.ts test/engine/filter/integration.test.ts
git commit -m "feat(filter): add public API and integration tests"
```

---

## Task 8: Template 型定義 + トークナイザー

**Files:**
- Create: `src/engine/template/types.ts`
- Create: `src/engine/template/tokenizer.ts`
- Test: `test/engine/template/tokenizer.test.ts`

- [ ] **Step 1: 型定義を作成**

```ts
// src/engine/template/types.ts
import type { PresentationEvent } from "../presentation/types";

export type TemplateNode =
  | TextNode
  | InterpolationNode
  | IfBlockNode;

export interface TextNode {
  kind: "text";
  value: string;
}

export interface InterpolationNode {
  kind: "interpolation";
  expr: TemplateExpr;
  filters: TemplateFilterCall[];
}

export interface IfBlockNode {
  kind: "if";
  test: TemplatePredicate;
  body: TemplateNode[];
  elseBody?: TemplateNode[];
}

export type TemplateExpr =
  | { kind: "path"; segments: string[] }
  | { kind: "literal"; value: string | number | boolean | null };

export type TemplatePredicate =
  | { kind: "truthy"; expr: TemplateExpr }
  | { kind: "compare"; op: "eq" | "ne" | "gt" | "ge" | "lt" | "le"; left: TemplateExpr; right: TemplateExpr };

export interface TemplateFilterCall {
  name: string;
  args: TemplateExpr[];
}

export type TemplateRenderer = (event: PresentationEvent) => string;

// トークン
export type TemplateTokenKind = "text" | "open" | "close" | "pipe" | "colon" | "if_open" | "else" | "endif" | "eof";

export interface TemplateToken {
  kind: TemplateTokenKind;
  value: string;
  pos: number;
}
```

- [ ] **Step 2: トークナイザーのテストを書く**

```ts
// test/engine/template/tokenizer.test.ts
import { describe, it, expect } from "vitest";
import { tokenizeTemplate } from "../../../src/engine/template/tokenizer";

describe("tokenizeTemplate", () => {
  it("テキストのみ", () => {
    const tokens = tokenizeTemplate("hello world");
    expect(tokens).toEqual([
      { kind: "text", value: "hello world", pos: 0 },
      { kind: "eof", value: "", pos: 11 },
    ]);
  });

  it("単純な interpolation", () => {
    const tokens = tokenizeTemplate("{{domain}}");
    expect(tokens.map(t => t.kind)).toEqual(["open", "text", "close", "eof"]);
    expect(tokens[1].value).toBe("domain");
  });

  it("テキスト + interpolation + テキスト", () => {
    const tokens = tokenizeTemplate("M{{magnitude}} 震度{{maxInt}}");
    expect(tokens.map(t => [t.kind, t.value])).toEqual([
      ["text", "M"],
      ["open", "{{"],
      ["text", "magnitude"],
      ["close", "}}"],
      ["text", " 震度"],
      ["open", "{{"],
      ["text", "maxInt"],
      ["close", "}}"],
      ["eof", ""],
    ]);
  });

  it("フィルタ付き interpolation", () => {
    const tokens = tokenizeTemplate('{{magnitude|default:"-"}}');
    const kinds = tokens.map(t => t.kind);
    expect(kinds).toContain("pipe");
    expect(kinds).toContain("colon");
  });

  it("if ブロック", () => {
    const tokens = tokenizeTemplate("{{#if isWarning}}警報{{else}}予報{{/if}}");
    const kinds = tokens.map(t => t.kind);
    expect(kinds).toContain("if_open");
    expect(kinds).toContain("else");
    expect(kinds).toContain("endif");
  });
});
```

- [ ] **Step 3: トークナイザーを実装**

```ts
// src/engine/template/tokenizer.ts
import type { TemplateToken } from "./types";

export function tokenizeTemplate(source: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let i = 0;

  while (i < source.length) {
    // {{#if ...}}
    if (source.startsWith("{{#if", i)) {
      tokens.push({ kind: "if_open", value: "{{#if", pos: i });
      i += 5;
      // 空白スキップ
      while (i < source.length && source[i] === " ") i++;
      // 条件式を "}}" まで読む
      const start = i;
      while (i < source.length && !source.startsWith("}}", i)) i++;
      tokens.push({ kind: "text", value: source.slice(start, i), pos: start });
      if (source.startsWith("}}", i)) {
        tokens.push({ kind: "close", value: "}}", pos: i });
        i += 2;
      }
      continue;
    }

    // {{else}}
    if (source.startsWith("{{else}}", i)) {
      tokens.push({ kind: "else", value: "{{else}}", pos: i });
      i += 8;
      continue;
    }

    // {{/if}}
    if (source.startsWith("{{/if}}", i)) {
      tokens.push({ kind: "endif", value: "{{/if}}", pos: i });
      i += 7;
      continue;
    }

    // {{ interpolation }}
    if (source.startsWith("{{", i)) {
      tokens.push({ kind: "open", value: "{{", pos: i });
      i += 2;
      // interpolation 内容を解析
      while (i < source.length && !source.startsWith("}}", i)) {
        if (source[i] === "|") {
          tokens.push({ kind: "pipe", value: "|", pos: i });
          i++;
        } else if (source[i] === ":") {
          tokens.push({ kind: "colon", value: ":", pos: i });
          i++;
        } else if (source[i] === " ") {
          i++;
        } else if (source[i] === '"' || source[i] === "'") {
          // 文字列リテラル
          const quote = source[i];
          const start = i;
          i++;
          while (i < source.length && source[i] !== quote) {
            if (source[i] === "\\" && i + 1 < source.length) i++;
            i++;
          }
          if (i < source.length) i++; // 閉じ引用符
          tokens.push({ kind: "text", value: source.slice(start, i), pos: start });
        } else {
          // 識別子/数値
          const start = i;
          while (i < source.length && !source.startsWith("}}", i) && source[i] !== "|" && source[i] !== ":" && source[i] !== " ") {
            i++;
          }
          tokens.push({ kind: "text", value: source.slice(start, i), pos: start });
        }
      }
      if (source.startsWith("}}", i)) {
        tokens.push({ kind: "close", value: "}}", pos: i });
        i += 2;
      }
      continue;
    }

    // テキスト
    const start = i;
    while (i < source.length && !source.startsWith("{{", i)) i++;
    tokens.push({ kind: "text", value: source.slice(start, i), pos: start });
  }

  tokens.push({ kind: "eof", value: "", pos: source.length });
  return tokens;
}
```

- [ ] **Step 4: テスト実行**

Run: `npx vitest run test/engine/template/tokenizer.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/engine/template/types.ts src/engine/template/tokenizer.ts test/engine/template/tokenizer.test.ts
git commit -m "feat(template): add type definitions and tokenizer"
```

---

## Task 9: Template パーサ

**Files:**
- Create: `src/engine/template/parser.ts`
- Test: `test/engine/template/parser.test.ts`

- [ ] **Step 1: テストを書く**

```ts
// test/engine/template/parser.test.ts
import { describe, it, expect } from "vitest";
import { parseTemplate } from "../../../src/engine/template/parser";

describe("parseTemplate", () => {
  it("テキストのみ", () => {
    const nodes = parseTemplate("hello");
    expect(nodes).toEqual([{ kind: "text", value: "hello" }]);
  });

  it("単純な interpolation", () => {
    const nodes = parseTemplate("{{domain}}");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("interpolation");
    if (nodes[0].kind === "interpolation") {
      expect(nodes[0].expr).toEqual({ kind: "path", segments: ["domain"] });
      expect(nodes[0].filters).toEqual([]);
    }
  });

  it("フィルタ付き interpolation", () => {
    const nodes = parseTemplate('{{magnitude|default:"-"}}');
    expect(nodes).toHaveLength(1);
    if (nodes[0].kind === "interpolation") {
      expect(nodes[0].filters).toHaveLength(1);
      expect(nodes[0].filters[0].name).toBe("default");
      expect(nodes[0].filters[0].args).toHaveLength(1);
    }
  });

  it("複数フィルタ", () => {
    const nodes = parseTemplate("{{hypocenterName|truncate:10|default:\"-\"}}");
    if (nodes[0].kind === "interpolation") {
      expect(nodes[0].filters).toHaveLength(2);
      expect(nodes[0].filters[0].name).toBe("truncate");
      expect(nodes[0].filters[1].name).toBe("default");
    }
  });

  it("if ブロック", () => {
    const nodes = parseTemplate("{{#if isWarning}}警報{{/if}}");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("if");
    if (nodes[0].kind === "if") {
      expect(nodes[0].test.kind).toBe("truthy");
      expect(nodes[0].body).toHaveLength(1);
      expect(nodes[0].elseBody).toBeUndefined();
    }
  });

  it("if/else ブロック", () => {
    const nodes = parseTemplate("{{#if isWarning}}警報{{else}}予報{{/if}}");
    if (nodes[0].kind === "if") {
      expect(nodes[0].body[0]).toEqual({ kind: "text", value: "警報" });
      expect(nodes[0].elseBody).toHaveLength(1);
      expect(nodes[0].elseBody![0]).toEqual({ kind: "text", value: "予報" });
    }
  });

  it("混合: テキスト + interpolation + if", () => {
    const nodes = parseTemplate("M{{magnitude}} {{#if isWarning}}⚠{{/if}}");
    expect(nodes.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: パーサを実装**

```ts
// src/engine/template/parser.ts
import type { TemplateNode, TemplateExpr, TemplatePredicate, TemplateFilterCall, TemplateToken } from "./types";
import { tokenizeTemplate } from "./tokenizer";

export function parseTemplate(source: string): TemplateNode[] {
  const tokens = tokenizeTemplate(source);
  return new TemplateParser(tokens).parse();
}

class TemplateParser {
  private pos = 0;

  constructor(private readonly tokens: TemplateToken[]) {}

  parse(): TemplateNode[] {
    return this.parseNodes();
  }

  private parseNodes(): TemplateNode[] {
    const nodes: TemplateNode[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos];
      if (token.kind === "eof" || token.kind === "else" || token.kind === "endif") break;

      if (token.kind === "text" && this.peek(-1)?.kind !== "open" && this.peek(-1)?.kind !== "if_open") {
        // 外側テキスト
        nodes.push({ kind: "text", value: token.value });
        this.pos++;
        continue;
      }

      if (token.kind === "if_open") {
        nodes.push(this.parseIfBlock());
        continue;
      }

      if (token.kind === "open") {
        nodes.push(this.parseInterpolation());
        continue;
      }

      // 未消費トークンはテキストとして扱う
      nodes.push({ kind: "text", value: token.value });
      this.pos++;
    }
    return nodes;
  }

  private parseInterpolation(): TemplateNode {
    this.expect("open"); // {{
    const exprToken = this.tokens[this.pos];
    this.pos++;
    const expr = this.parseExpr(exprToken.value);
    const filters: TemplateFilterCall[] = [];

    while (this.pos < this.tokens.length && this.tokens[this.pos].kind === "pipe") {
      this.pos++; // |
      const nameToken = this.tokens[this.pos];
      this.pos++;
      const args: TemplateExpr[] = [];
      if (this.pos < this.tokens.length && this.tokens[this.pos].kind === "colon") {
        this.pos++; // :
        const argToken = this.tokens[this.pos];
        this.pos++;
        args.push(this.parseExpr(argToken.value));
      }
      filters.push({ name: nameToken.value, args });
    }

    this.expect("close"); // }}
    return { kind: "interpolation", expr, filters };
  }

  private parseIfBlock(): TemplateNode {
    this.expect("if_open"); // {{#if
    const condToken = this.tokens[this.pos];
    this.pos++;
    const test = this.parsePredicate(condToken.value);
    this.expect("close"); // }}

    const body = this.parseNodes();
    let elseBody: TemplateNode[] | undefined;

    if (this.pos < this.tokens.length && this.tokens[this.pos].kind === "else") {
      this.pos++; // {{else}}
      elseBody = this.parseNodes();
    }

    if (this.pos < this.tokens.length && this.tokens[this.pos].kind === "endif") {
      this.pos++; // {{/if}}
    }

    return { kind: "if", test, body, elseBody };
  }

  private parseExpr(raw: string): TemplateExpr {
    const trimmed = raw.trim();

    // 文字列リテラル
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return { kind: "literal", value: trimmed.slice(1, -1) };
    }
    // 数値
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return { kind: "literal", value: Number(trimmed) };
    }
    // boolean / null
    if (trimmed === "true") return { kind: "literal", value: true };
    if (trimmed === "false") return { kind: "literal", value: false };
    if (trimmed === "null") return { kind: "literal", value: null };

    // パス
    return { kind: "path", segments: trimmed.split(".") };
  }

  private parsePredicate(raw: string): TemplatePredicate {
    const trimmed = raw.trim();
    // 簡易比較: "field op value" 形式
    const cmpMatch = trimmed.match(/^(\S+)\s+(=|!=|>|>=|<|<=)\s+(.+)$/);
    if (cmpMatch) {
      const opMap: Record<string, "eq" | "ne" | "gt" | "ge" | "lt" | "le"> = {
        "=": "eq", "!=": "ne", ">": "gt", ">=": "ge", "<": "lt", "<=": "le",
      };
      return {
        kind: "compare",
        op: opMap[cmpMatch[2]],
        left: this.parseExpr(cmpMatch[1]),
        right: this.parseExpr(cmpMatch[3]),
      };
    }
    // truthy
    return { kind: "truthy", expr: this.parseExpr(trimmed) };
  }

  private expect(kind: string): void {
    if (this.pos < this.tokens.length && this.tokens[this.pos].kind === kind) {
      this.pos++;
    }
  }

  private peek(offset: number): TemplateToken | undefined {
    return this.tokens[this.pos + offset];
  }
}
```

- [ ] **Step 3: テスト実行**

Run: `npx vitest run test/engine/template/parser.test.ts`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
git add src/engine/template/parser.ts test/engine/template/parser.test.ts
git commit -m "feat(template): add template parser"
```

---

## Task 10: Template フィルタ関数

**Files:**
- Create: `src/engine/template/filters.ts`
- Test: `test/engine/template/filters.test.ts`

- [ ] **Step 1: テストを書く**

```ts
// test/engine/template/filters.test.ts
import { describe, it, expect } from "vitest";
import { applyFilter } from "../../../src/engine/template/filters";

describe("applyFilter", () => {
  it("default: null → デフォルト値", () => {
    expect(applyFilter("default", null, ["-"])).toBe("-");
  });

  it("default: 値あり → そのまま", () => {
    expect(applyFilter("default", "6+", ["-"])).toBe("6+");
  });

  it("truncate: 文字数制限", () => {
    expect(applyFilter("truncate", "石川県能登地方", [4])).toBe("石川県能");
  });

  it("truncate: 短い文字列はそのまま", () => {
    expect(applyFilter("truncate", "能登", [10])).toBe("能登");
  });

  it("pad: 右パディング", () => {
    const result = applyFilter("pad", "6+", [4]);
    expect(result).toBe("6+  ");
  });

  it("join: 配列結合", () => {
    expect(applyFilter("join", ["石川", "富山"], [", "])).toBe("石川, 富山");
  });

  it("join: 非配列はそのまま", () => {
    expect(applyFilter("join", "text", [", "])).toBe("text");
  });

  it("replace: 文字列置換", () => {
    expect(applyFilter("replace", "に関する情報です", ["に関する情報", ""])).toBe("です");
  });

  it("upper: 大文字変換", () => {
    expect(applyFilter("upper", "eew", [])).toBe("EEW");
  });

  it("lower: 小文字変換", () => {
    expect(applyFilter("lower", "EEW", [])).toBe("eew");
  });

  it("date: 日時フォーマット HH:mm", () => {
    const result = applyFilter("date", "2025-01-01T09:30:00+09:00", ["HH:mm"]);
    expect(result).toBe("09:30");
  });

  it("未知のフィルタは値をそのまま返す", () => {
    expect(applyFilter("unknown", "value", [])).toBe("value");
  });
});
```

- [ ] **Step 2: テンプレートフィルタを実装**

```ts
// src/engine/template/filters.ts

type FilterValue = unknown;
type FilterArg = string | number | boolean | null;

const FILTERS: Record<string, (value: FilterValue, args: FilterArg[]) => FilterValue> = {
  default: (value, args) => {
    if (value == null || value === "") return args[0] ?? "";
    return value;
  },

  truncate: (value, args) => {
    const str = String(value ?? "");
    const len = typeof args[0] === "number" ? args[0] : 10;
    return str.length > len ? str.slice(0, len) : str;
  },

  pad: (value, args) => {
    const str = String(value ?? "");
    const width = typeof args[0] === "number" ? args[0] : 0;
    return str.padEnd(width);
  },

  join: (value, args) => {
    if (!Array.isArray(value)) return String(value ?? "");
    const sep = typeof args[0] === "string" ? args[0] : ", ";
    return value.join(sep);
  },

  date: (value, args) => {
    if (value == null) return "";
    const str = String(value);
    const format = typeof args[0] === "string" ? args[0] : "HH:mm";
    try {
      const d = new Date(str);
      if (Number.isNaN(d.getTime())) return str;
      if (format === "HH:mm") {
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      }
      if (format === "HH:mm:ss") {
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
      }
      if (format === "MM/DD HH:mm") {
        return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      }
      return str;
    } catch {
      return str;
    }
  },

  replace: (value, args) => {
    const str = String(value ?? "");
    const search = typeof args[0] === "string" ? args[0] : "";
    const replacement = typeof args[1] === "string" ? args[1] : "";
    return str.replace(search, replacement);
  },

  upper: (value) => String(value ?? "").toUpperCase(),
  lower: (value) => String(value ?? "").toLowerCase(),
};

/** テンプレートフィルタを適用する */
export function applyFilter(name: string, value: FilterValue, args: FilterArg[]): FilterValue {
  const fn = FILTERS[name];
  if (fn == null) return value;
  return fn(value, args);
}
```

- [ ] **Step 3: テスト実行**

Run: `npx vitest run test/engine/template/filters.test.ts`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
git add src/engine/template/filters.ts test/engine/template/filters.test.ts
git commit -m "feat(template): add template filter functions"
```

---

## Task 11: Template コンパイラ + 公開 API

**Files:**
- Create: `src/engine/template/compiler.ts`
- Create: `src/engine/template/field-accessor.ts`
- Create: `src/engine/template/index.ts`
- Test: `test/engine/template/compiler.test.ts`
- Test: `test/engine/template/integration.test.ts`

- [ ] **Step 1: フィールドアクセサを作成**

```ts
// src/engine/template/field-accessor.ts
import type { PresentationEvent } from "../presentation/types";

/** PresentationEvent からドットパスで値を取得する */
export function getFieldValue(event: PresentationEvent, segments: string[]): unknown {
  if (segments.length === 1) {
    const key = segments[0];
    // PresentationEvent の直接プロパティ
    if (key in event) {
      return (event as Record<string, unknown>)[key];
    }
    return undefined;
  }

  // ネストアクセス: raw.xxx のみ許可
  if (segments[0] === "raw" && event.raw != null) {
    let current: unknown = event.raw;
    for (let i = 1; i < segments.length; i++) {
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[segments[i]];
    }
    return current;
  }

  // stateSnapshot アクセス
  if (segments[0] === "stateSnapshot" && event.stateSnapshot != null) {
    let current: unknown = event.stateSnapshot;
    for (let i = 1; i < segments.length; i++) {
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[segments[i]];
    }
    return current;
  }

  return undefined;
}
```

- [ ] **Step 2: コンパイラを作成**

```ts
// src/engine/template/compiler.ts
import type { TemplateNode, TemplateExpr, TemplatePredicate, TemplateRenderer } from "./types";
import type { PresentationEvent } from "../presentation/types";
import { getFieldValue } from "./field-accessor";
import { applyFilter } from "./filters";

export function compileTemplate(nodes: TemplateNode[]): TemplateRenderer {
  const compiled = nodes.map(compileNode);
  return (event) => compiled.map((fn) => fn(event)).join("");
}

function compileNode(node: TemplateNode): (event: PresentationEvent) => string {
  switch (node.kind) {
    case "text":
      return () => node.value;
    case "interpolation":
      return compileInterpolation(node);
    case "if":
      return compileIf(node);
  }
}

function compileInterpolation(node: { expr: TemplateExpr; filters: { name: string; args: TemplateExpr[] }[] }): (event: PresentationEvent) => string {
  return (event) => {
    let value: unknown = evalExpr(node.expr, event);
    for (const filter of node.filters) {
      const args = filter.args.map((a) => evalExpr(a, event));
      value = applyFilter(filter.name, value, args as (string | number | boolean | null)[]);
    }
    if (value == null) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  };
}

function compileIf(node: { test: TemplatePredicate; body: TemplateNode[]; elseBody?: TemplateNode[] }): (event: PresentationEvent) => string {
  const bodyFn = compileTemplate(node.body);
  const elseFn = node.elseBody ? compileTemplate(node.elseBody) : null;
  return (event) => {
    if (evalPredicate(node.test, event)) {
      return bodyFn(event);
    }
    return elseFn ? elseFn(event) : "";
  };
}

function evalExpr(expr: TemplateExpr, event: PresentationEvent): unknown {
  if (expr.kind === "literal") return expr.value;
  return getFieldValue(event, expr.segments);
}

function evalPredicate(pred: TemplatePredicate, event: PresentationEvent): boolean {
  if (pred.kind === "truthy") {
    const val = evalExpr(pred.expr, event);
    return val != null && val !== false && val !== "" && val !== 0;
  }
  const l = evalExpr(pred.left, event);
  const r = evalExpr(pred.right, event);
  if (l == null || r == null) return false;
  switch (pred.op) {
    case "eq": return l === r;
    case "ne": return l !== r;
    case "gt": return (l as number) > (r as number);
    case "ge": return (l as number) >= (r as number);
    case "lt": return (l as number) < (r as number);
    case "le": return (l as number) <= (r as number);
  }
}
```

- [ ] **Step 3: 公開 API を作成**

```ts
// src/engine/template/index.ts
export type { TemplateNode, TemplateRenderer } from "./types";
export { parseTemplate } from "./parser";
export { compileTemplate as compileTemplateAst } from "./compiler";
export { compileTemplateString } from "./compile-template";

// src/engine/template/compile-template.ts
import type { TemplateRenderer } from "./types";
import { parseTemplate } from "./parser";
import { compileTemplate } from "./compiler";

/**
 * テンプレート文字列をコンパイルして renderer 関数を返す。
 * 構文エラー時は Error を投げる。
 */
export function compileTemplateString(template: string): TemplateRenderer {
  const nodes = parseTemplate(template);
  return compileTemplate(nodes);
}
```

- [ ] **Step 4: コンパイラテストを書く**

```ts
// test/engine/template/compiler.test.ts
import { describe, it, expect } from "vitest";
import { compileTemplateString } from "../../../src/engine/template/compile-template";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

function makeEvent(overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  return {
    id: "test-1", classification: "eew.forecast", domain: "eew", type: "VXSE43",
    infoType: "発表", title: "緊急地震速報（警報）", headline: null,
    reportDateTime: "2025-01-01T09:30:00+09:00", publishingOffice: "気象庁",
    isTest: false, frameLevel: "critical", isCancellation: false, isWarning: true,
    magnitude: "6.1", hypocenterName: "日向灘", maxInt: "6弱",
    areaNames: [], forecastAreaNames: ["石川県能登"], municipalityNames: [],
    observationNames: [], areaCount: 0, forecastAreaCount: 1, municipalityCount: 0,
    observationCount: 0, areaItems: [], raw: null, ...overrides,
  };
}

describe("compileTemplateString", () => {
  it("テキストのみ", () => {
    const render = compileTemplateString("hello");
    expect(render(makeEvent())).toBe("hello");
  });

  it("単純な変数展開", () => {
    const render = compileTemplateString("{{domain}}");
    expect(render(makeEvent())).toBe("eew");
  });

  it("複数変数展開", () => {
    const render = compileTemplateString("M{{magnitude}} 震度{{maxInt}}");
    expect(render(makeEvent())).toBe("M6.1 震度6弱");
  });

  it("default フィルタ", () => {
    const render = compileTemplateString('{{magnitude|default:"-"}}');
    expect(render(makeEvent({ magnitude: null }))).toBe("-");
    expect(render(makeEvent({ magnitude: "7.3" }))).toBe("7.3");
  });

  it("if ブロック (truthy)", () => {
    const render = compileTemplateString("{{#if isWarning}}警報{{else}}予報{{/if}}");
    expect(render(makeEvent({ isWarning: true }))).toBe("警報");
    expect(render(makeEvent({ isWarning: false }))).toBe("予報");
  });

  it("未定義変数は空文字", () => {
    const render = compileTemplateString("{{volcanoName}}");
    expect(render(makeEvent())).toBe("");
  });

  it("配列は join される", () => {
    const render = compileTemplateString("{{forecastAreaNames}}");
    expect(render(makeEvent({ forecastAreaNames: ["石川", "富山"] }))).toBe("石川, 富山");
  });

  it("join フィルタ", () => {
    const render = compileTemplateString('{{forecastAreaNames|join:"/"}}');
    expect(render(makeEvent({ forecastAreaNames: ["石川", "富山"] }))).toBe("石川/富山");
  });

  it("upper フィルタ", () => {
    const render = compileTemplateString("{{domain|upper}}");
    expect(render(makeEvent())).toBe("EEW");
  });
});
```

- [ ] **Step 5: テスト実行**

Run: `npx vitest run test/engine/template/compiler.test.ts`
Expected: PASS

- [ ] **Step 6: 統合テストを書く**

```ts
// test/engine/template/integration.test.ts
import { describe, it, expect } from "vitest";
import { compileTemplateString } from "../../../src/engine/template/compile-template";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

function makeEvent(overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  return {
    id: "test-1", classification: "eew.forecast", domain: "eew", type: "VXSE43",
    infoType: "発表", title: "緊急地震速報（警報）", headline: null,
    reportDateTime: "2025-01-01T09:30:00+09:00", publishingOffice: "気象庁",
    isTest: false, frameLevel: "critical", isCancellation: false, isWarning: true,
    magnitude: "6.1", hypocenterName: "日向灘", maxInt: "6弱",
    areaNames: [], forecastAreaNames: ["石川県能登"], municipalityNames: [],
    observationNames: [], areaCount: 0, forecastAreaCount: 1, municipalityCount: 0,
    observationCount: 0, areaItems: [], raw: null, ...overrides,
  };
}

describe("template 統合テスト", () => {
  it("EEW 1行要約テンプレート", () => {
    const render = compileTemplateString(
      '{{#if isWarning}}[緊急]{{else}}[警告]{{/if}} {{title}} {{hypocenterName|default:"-"}} M{{magnitude|default:"-"}} 最大{{maxInt|default:"-"}}'
    );
    const result = render(makeEvent());
    expect(result).toBe("[緊急] 緊急地震速報（警報） 日向灘 M6.1 最大6弱");
  });

  it("地震テンプレート (震度なし)", () => {
    const render = compileTemplateString("{{title}} {{hypocenterName}} 震度{{maxInt|default:\"-\"}}");
    const result = render(makeEvent({
      domain: "earthquake", type: "VXSE52", title: "震源に関する情報",
      hypocenterName: "能登半島沖", maxInt: null,
    }));
    expect(result).toBe("震源に関する情報 能登半島沖 震度-");
  });

  it("replace フィルタで文言短縮", () => {
    const render = compileTemplateString('{{title|replace:"に関する情報":""}}');
    const result = render(makeEvent({ title: "震源に関する情報" }));
    expect(result).toBe("震源");
  });
});
```

- [ ] **Step 7: テスト実行**

Run: `npx vitest run test/engine/template/integration.test.ts`
Expected: PASS

- [ ] **Step 8: コミット**

```bash
git add src/engine/template/compiler.ts src/engine/template/field-accessor.ts src/engine/template/index.ts src/engine/template/compile-template.ts test/engine/template/compiler.test.ts test/engine/template/integration.test.ts
git commit -m "feat(template): add template compiler, field accessor, and public API"
```

---

## Task 12: CLI オプション + 起動時コンパイル

**Files:**
- Modify: `src/engine/cli/cli.ts`
- Modify: `src/engine/cli/cli-run.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: AppConfig に filter/template フィールドを追加**

`src/types.ts` の `AppConfig` interface に追加:

```ts
// AppConfig の既存フィールドの後に追加
filterExprs?: string[];
templateExpr?: string;
```

- [ ] **Step 2: RunMonitorOptions に filter/template を追加**

`src/engine/cli/cli-run.ts` の `RunMonitorOptions` に追加:

```ts
filter?: string[];
template?: string;
```

- [ ] **Step 3: CLI オプションを追加**

`src/engine/cli/cli.ts` の `.option("--debug", ...)` の前に:

```ts
.option(
  "--filter <expr>",
  "条件式で電文を絞り込みます (複数指定で AND 結合)",
  (val: string, prev: string[]) => [...prev, val],
  [] as string[],
)
.option(
  "--template <template>",
  "電文の1行要約テンプレートを指定します (@ でファイル読込)",
)
```

- [ ] **Step 4: 起動時コンパイルを追加**

`src/engine/cli/cli-run.ts` の `runMonitor` 内、`setTruncation` の後に:

```ts
// Filter / Template コンパイル
import { compileFilter } from "../filter/compile-filter";
import { compileTemplateString } from "../template/compile-template";
import * as fs from "fs";

let filterPredicate: ((event: PresentationEvent) => boolean) | null = null;
let templateRenderer: ((event: PresentationEvent) => string) | null = null;

if (opts.filter && opts.filter.length > 0) {
  try {
    const predicates = opts.filter.map((expr) => compileFilter(expr));
    filterPredicate = (event) => predicates.every((p) => p(event));
    log.info(`フィルタ: ${opts.filter.join(" AND ")}`);
  } catch (err) {
    if (err instanceof Error) {
      log.error(`フィルタのコンパイルに失敗しました:\n${err.message}`);
    }
    process.exit(1);
  }
}

if (opts.template) {
  try {
    let tplSource = opts.template;
    if (tplSource.startsWith("@")) {
      const filePath = tplSource.slice(1).replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? "");
      tplSource = fs.readFileSync(filePath, "utf-8").trim();
    }
    templateRenderer = compileTemplateString(tplSource);
    log.info("テンプレート: カスタム");
  } catch (err) {
    if (err instanceof Error) {
      log.error(`テンプレートのコンパイルに失敗しました:\n${err.message}`);
    }
    process.exit(1);
  }
}
```

**注意**: import 文は実際にはファイル先頭に配置する。上記は概念的な配置を示している。

- [ ] **Step 5: ビルドしてテスト**

Run: `npm run build && npm test`
Expected: ビルド成功、全テスト PASS

- [ ] **Step 6: コミット**

```bash
git add src/engine/cli/cli.ts src/engine/cli/cli-run.ts src/types.ts
git commit -m "feat(cli): add --filter and --template CLI options with startup compilation"
```

---

## Task 13: Router にフィルタ + テンプレート適用を組込

**Files:**
- Modify: `src/engine/messages/message-router.ts`
- Create: `src/engine/filter-template/pipeline.ts`

- [ ] **Step 1: パイプライン関数を作成**

```ts
// src/engine/filter-template/pipeline.ts
import type { PresentationEvent } from "../presentation/types";
import type { FilterPredicate } from "../filter/types";
import type { TemplateRenderer } from "../template/types";

export interface FilterTemplatePipeline {
  filter: FilterPredicate | null;
  template: TemplateRenderer | null;
}

/** PresentationEvent にフィルタを適用する。true = 表示、false = 非表示 */
export function shouldDisplay(event: PresentationEvent, pipeline: FilterTemplatePipeline): boolean {
  if (pipeline.filter == null) return true;
  return pipeline.filter(event);
}

/** テンプレートが設定されていれば1行に変換する。null = テンプレートなし */
export function renderTemplate(event: PresentationEvent, pipeline: FilterTemplatePipeline): string | null {
  if (pipeline.template == null) return null;
  return pipeline.template(event);
}
```

- [ ] **Step 2: MessageHandlerResult にパイプライン設定を追加**

`src/engine/messages/message-router.ts` の `createMessageHandler` にパイプラインパラメータを追加:

```ts
import { shouldDisplay, renderTemplate, FilterTemplatePipeline } from "../filter-template/pipeline";

export interface MessageHandlerOptions {
  pipeline?: FilterTemplatePipeline;
}

export function createMessageHandler(options?: MessageHandlerOptions): MessageHandlerResult {
  // ... 既存コード ...
  const pipeline: FilterTemplatePipeline = options?.pipeline ?? { filter: null, template: null };
```

handler 内の `toPresentationEvent` 周辺を変更:

```ts
    // Phase 2: filter → template 適用
    const event = toPresentationEvent(outcome);

    if (!shouldDisplay(event, pipeline)) {
      // フィルタで除外 — 通知・統計は既に処理済み
      return;
    }

    const templateOutput = renderTemplate(event, pipeline);
    if (templateOutput != null) {
      console.log(templateOutput);
      return;
    }

    dispatchDisplay(outcome, notifier);
```

**重要**: filter の適用範囲に従い、`recordStats` と notifier 呼び出しは filter の前に行う（統計・通知は filter の影響を受けない）。dispatchDisplay 内の notifier 呼び出しを分離する必要がある。

handler の構造を調整:

```ts
    recordStats(outcome, stats);

    // 通知は filter 非適用
    dispatchNotify(outcome, notifier);

    const event = toPresentationEvent(outcome);

    if (!shouldDisplay(event, pipeline)) {
      return; // 表示のみ抑制
    }

    const templateOutput = renderTemplate(event, pipeline);
    if (templateOutput != null) {
      console.log(templateOutput);
      return;
    }

    dispatchDisplayOnly(outcome);
```

`dispatchDisplay` を `dispatchNotify` (通知のみ) と `dispatchDisplayOnly` (表示のみ) に分離する。

- [ ] **Step 3: dispatchDisplay を分離**

```ts
/** 通知のみ実行 (filter 非適用) */
function dispatchNotify(outcome: ProcessOutcome, notifier: Notifier): void {
  switch (outcome.domain) {
    case "eew":
      notifier.notifyEew(outcome.parsed, outcome.eewResult);
      break;
    case "earthquake":
      notifier.notifyEarthquake(outcome.parsed);
      break;
    case "seismicText":
      notifier.notifySeismicText(outcome.parsed);
      break;
    case "lgObservation":
      notifier.notifyLgObservation(outcome.parsed);
      break;
    case "tsunami":
      notifier.notifyTsunami(outcome.parsed);
      break;
    case "nankaiTrough":
      notifier.notifyNankaiTrough(outcome.parsed);
      break;
    // raw, volcano: 通知なし
  }
}

/** 表示のみ実行 (filter 適用後) */
function dispatchDisplayOnly(outcome: ProcessOutcome): void {
  switch (outcome.domain) {
    case "eew":
      displayEewInfo(outcome.parsed, {
        activeCount: outcome.eewResult.activeCount,
        diff: outcome.eewResult.diff,
        colorIndex: outcome.eewResult.colorIndex,
      });
      break;
    case "earthquake":
      displayEarthquakeInfo(outcome.parsed);
      break;
    case "seismicText":
      displaySeismicTextInfo(outcome.parsed);
      break;
    case "lgObservation":
      displayLgObservationInfo(outcome.parsed);
      break;
    case "tsunami":
      displayTsunamiInfo(outcome.parsed);
      break;
    case "nankaiTrough":
      displayNankaiTroughInfo(outcome.parsed);
      break;
    case "raw":
      displayRawHeader(outcome.msg);
      break;
  }
}
```

- [ ] **Step 4: ビルドとテスト**

Run: `npm run build && npm test`
Expected: ビルド成功、全テスト PASS

- [ ] **Step 5: コミット**

```bash
git add src/engine/filter-template/pipeline.ts src/engine/messages/message-router.ts
git commit -m "feat(router): integrate filter/template pipeline into message handler"
```

---

## Task 14: REPL filter コマンド

**Files:**
- Modify: `src/ui/repl.ts`

- [ ] **Step 1: filter コマンドを REPL に追加**

`repl.ts` の `this.commands` オブジェクト内、`mode` の後に追加:

```ts
filter: {
  description: "フィルタの表示・設定 (例: filter set domain = \"eew\")",
  detail: "filter: 現在のフィルタ状態を表示\n  filter set <expr>: フィルタを即時適用\n  filter clear: フィルタを解除\n  filter test <expr>: 構文チェックのみ（適用しない）",
  category: "settings",
  subcommands: {
    set: { description: "フィルタを即時適用" },
    clear: { description: "フィルタを解除" },
    test: { description: "構文チェックのみ" },
  },
  handler: (args) => this.handleFilter(args),
},
```

- [ ] **Step 2: handleFilter を実装**

ReplHandler クラスに以下を追加:

```ts
import { compileFilter } from "../engine/filter/compile-filter";
import type { FilterPredicate } from "../engine/filter/types";

// constructor に追加
private filterPredicate: FilterPredicate | null = null;
private filterExpr: string | null = null;

private handleFilter(args: string): void {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    // 状態表示
    if (this.filterExpr == null) {
      console.log("  フィルタ: 無効");
    } else {
      console.log(`  フィルタ: 有効`);
      console.log(chalk.gray(`  式: ${this.filterExpr}`));
    }
    return;
  }

  if (trimmed === "clear") {
    this.filterPredicate = null;
    this.filterExpr = null;
    // pipeline の filter をクリア (TODO: pipeline 参照を保持)
    console.log("  フィルタを解除しました。");
    return;
  }

  const isTestOnly = trimmed.startsWith("test ");
  const expr = isTestOnly ? trimmed.slice(5).trim() : trimmed.startsWith("set ") ? trimmed.slice(4).trim() : trimmed;

  try {
    const predicate = compileFilter(expr);
    if (isTestOnly) {
      console.log(chalk.green("  構文OK"));
      console.log(chalk.gray(`  正規化: ${expr}`));
      return;
    }
    this.filterPredicate = predicate;
    this.filterExpr = expr;
    // pipeline の filter を更新 (TODO: pipeline 参照を保持)
    console.log(`  フィルタを適用しました。`);
    console.log(chalk.gray(`  式: ${expr}`));
  } catch (err) {
    if (err instanceof Error) {
      console.log(chalk.red(`  ${err.message}`));
    }
  }
}
```

**注意**: REPL から pipeline の filter を動的に更新するため、FilterTemplatePipeline のフィールドを mutable にするか、setter を用意する必要がある。`pipeline.filter` に直接代入する方式が最もシンプル。

- [ ] **Step 3: ビルドとテスト**

Run: `npm run build && npm test`
Expected: ビルド成功、全テスト PASS

- [ ] **Step 4: コミット**

```bash
git add src/ui/repl.ts
git commit -m "feat(repl): add filter command for runtime filter management"
```

---

## Task 15: 統合テスト + Codex レビュー

**Files:**
- 全体

- [ ] **Step 1: 全テスト実行**

Run: `npm test`
Expected: 全テスト PASS

- [ ] **Step 2: ビルド確認**

Run: `npm run build`
Expected: 成功

- [ ] **Step 3: Codex レビュー依頼**

Phase 2 全体の変更に対して Codex にレビューを依頼する。レビュー観点:
1. filter パーサの正確性 (演算子優先順位、エッジケース)
2. template パーサの正確性 (ネスト、エスケープ)
3. router 統合の正しさ (filter/通知/統計の適用範囲)
4. REPL 連携の動的更新
5. エラーメッセージの品質

- [ ] **Step 4: レビュー指摘の修正**

- [ ] **Step 5: コミット**

```bash
git add -A
git commit -m "fix(filter/template): address Codex review findings for Phase 2"
```
