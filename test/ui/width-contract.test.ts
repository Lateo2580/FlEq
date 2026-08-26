import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import {
  createRenderBuffer,
  frameLine,
  frameLineColored,
  getFrameLineClampFallbackCount,
  pushWrappedFrameLine,
  resetFrameLineClampFallbackCount,
  stripAnsi,
  visualWidth,
} from "../../src/ui/formatter";
import { FORMATTER_TEST_REGISTRY } from "../../src/ui/test-samples";

const WIDTHS = [40, 60, 80, 120, 200] as const;

// docs/specs/2026-08-26-cli-width-contract.md §6 の source 30 本。
const FRAME_LINE_SOURCE_CATALOG = [
  "briefing-formatter.ts", "climate-info-formatter.ts", "early-weather-formatter.ts",
  "earthquake-info-formatter.ts", "eew-formatter.ts", "flood-forecast-formatter.ts",
  "formatter.ts", "frame-table-builder.ts", "heat-alert-formatter.ts",
  "legacy-counterpart-formatter.ts", "lg-observation-formatter.ts", "nankai-trough-formatter.ts",
  "responsive-table-engine.ts", "seismic-text-formatter.ts", "statistics-formatter.ts",
  "tornado-formatter.ts", "tsunami-formatter.ts", "typhoon-analysis-formatter.ts",
  "typhoon-probability-formatter.ts", "volcano-formatter.ts", "vpwp50-detail-formatter.ts",
  "weather-core-action-guide.ts", "weather-core-detail.ts", "weather-core-formatter.ts",
  "weather-core-table.ts", "weather-core-tail-blocks.ts", "weather-explanation-formatter.ts",
  "weather-formatter-vpws50.ts", "weather-formatter.ts", "weather-warning-timeseries-formatter.ts",
] as const;

// §6 の移行対象の残り 11 本。縦切り patch が進むごとにここから空にしていく。
const MIGRATION_PENDING_FRAME_LINE_SOURCES = [
  "briefing-formatter.ts", "climate-info-formatter.ts", "early-weather-formatter.ts",
  "flood-forecast-formatter.ts",
  "legacy-counterpart-formatter.ts", "statistics-formatter.ts",
  "typhoon-analysis-formatter.ts", "typhoon-probability-formatter.ts", "vpwp50-detail-formatter.ts",
  "weather-explanation-formatter.ts", "weather-warning-timeseries-formatter.ts",
] as const;

const WIDTH_PROVEN_FRAME_LINE_SOURCES = [
  "earthquake-info-formatter.ts", "eew-formatter.ts", "formatter.ts", "frame-table-builder.ts",
  "heat-alert-formatter.ts",
  "lg-observation-formatter.ts", "nankai-trough-formatter.ts", "responsive-table-engine.ts",
  "seismic-text-formatter.ts", "tornado-formatter.ts",
  "tsunami-formatter.ts", "volcano-formatter.ts", "weather-core-action-guide.ts",
  "weather-core-detail.ts", "weather-core-formatter.ts", "weather-core-table.ts",
  "weather-core-tail-blocks.ts", "weather-formatter-vpws50.ts", "weather-formatter.ts",
] as const;

/** §6 の可変 call site を source 単位ではなく site 単位で固定する。 */
function siteIds(file: string, lines: number[]): string[] {
  return lines.map((line) => `${file}:${line}`);
}

const MIGRATION_PENDING_FRAME_LINE_SITES = new Set([
  ...siteIds("briefing-formatter.ts", [90, 99, 102, 109, 123, 147, 159]),
  ...siteIds("climate-info-formatter.ts", [276, 285, 297, 316, 332, 333, 339, 344, 410, 413, 427]),
  ...siteIds("early-weather-formatter.ts", [84, 93, 96, 103, 117, 123, 124, 132, 133, 139, 186]),
  ...siteIds("flood-forecast-formatter.ts", [75, 78, 102, 121, 155, 165, 195, 206, 254, 534, 566, 633, 644, 679, 739, 825, 878, 888]),
  ...siteIds("legacy-counterpart-formatter.ts", [38, 62, 65, 73, 78]),
  // const 渡しでも値解決しない規則のため、移行待ち site として明示管理する。
  ...siteIds("statistics-formatter.ts", [192, 193, 236]),
  ...siteIds("typhoon-analysis-formatter.ts", [27, 74, 83, 87, 106]),
  ...siteIds("typhoon-probability-formatter.ts", [100, 135, 143, 159, 187, 236, 279, 335]),
  ...siteIds("vpwp50-detail-formatter.ts", [31, 74]),
  ...siteIds("weather-explanation-formatter.ts", [240, 295, 306, 429, 457, 480, 489, 558, 568, 580, 602, 608, 618, 681]),
  ...siteIds("weather-warning-timeseries-formatter.ts", [312, 332, 635, 815, 819, 827]),
]);

const WIDTH_PROVEN_FRAME_LINE_SITES = new Set([
  ...siteIds("earthquake-info-formatter.ts", [191, 196, 258]),
  ...siteIds("formatter.ts", [272, 275, 681, 682, 771, 786, 1614, 1619]),
  ...siteIds("lg-observation-formatter.ts", [134, 139, 195]),
  ...siteIds("nankai-trough-formatter.ts", [99, 104, 112]),
  ...siteIds("responsive-table-engine.ts", [71]),
  ...siteIds("seismic-text-formatter.ts", [71, 94, 99]),
  ...siteIds("tsunami-formatter.ts", [354, 358, 419, 445, 471, 495]),
  ...siteIds("volcano-formatter.ts", [454, 457, 510, 549, 552, 561, 619, 662, 779, 817, 1032, 1043]),
  ...siteIds("weather-core-action-guide.ts", [51]),
  ...siteIds("weather-core-detail.ts", [59]),
  ...siteIds("weather-core-table.ts", [68, 70]),
  ...siteIds("weather-core-tail-blocks.ts", [15]),
]);

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

interface FrameLineCallSite {
  file: string;
  line: number;
  classification: "fixed" | "width-proven" | "migration-pending" | "unapproved";
}

function findFrameLineCallSites(): FrameLineCallSite[] {
  const uiDir = path.join(process.cwd(), "src/ui");
  const files = collectTypeScriptFiles(uiDir);
  return files.flatMap((absolutePath) => {
    const file = path.relative(uiDir, absolutePath);
    const source = ts.createSourceFile(file, readFileSync(absolutePath, "utf8"), ts.ScriptTarget.Latest, true);
    return collectFrameLineCallSites(source, file);
  });
}

function collectTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
    return entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

function collectFrameLineCallSites(source: ts.SourceFile, file: string): FrameLineCallSite[] {
  const directImports = new Map<string, "frameLine" | "frameLineColored">();
  const namespaces = new Set<string>();
  const isFormatterImport = (specifier: string): boolean => path.posix.normalize(
    path.posix.join(path.posix.dirname(file), `${specifier}.ts`),
  ) === "formatter.ts";
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && isFormatterImport(statement.moduleSpecifier.text)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings != null && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings != null && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === "frameLine" || imported === "frameLineColored") directImports.set(element.name.text, imported);
        }
      }
    }
  }
  if (file === "formatter.ts") {
    directImports.set("frameLine", "frameLine");
    directImports.set("frameLineColored", "frameLineColored");
  }

  const sites: FrameLineCallSite[] = [];
  const isStatic = (expression: ts.Expression): boolean => ts.isStringLiteral(expression)
    || ts.isNoSubstitutionTemplateLiteral(expression);
  const isFrameLineCall = (expression: ts.LeftHandSideExpression): "frameLine" | "frameLineColored" | null => {
    if (ts.isIdentifier(expression)) return directImports.get(expression.text) ?? null;
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
      && namespaces.has(expression.expression.text) && (expression.name.text === "frameLine" || expression.name.text === "frameLineColored")) return expression.name.text;
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = isFrameLineCall(node.expression);
      if (kind != null) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        const id = `${file}:${position.line + 1}`;
        const content = node.arguments[kind === "frameLine" ? 1 : 2];
        sites.push({
          file,
          line: position.line + 1,
          classification: content != null && isStatic(content) ? "fixed"
            : MIGRATION_PENDING_FRAME_LINE_SITES.has(id) ? "migration-pending"
              : WIDTH_PROVEN_FRAME_LINE_SITES.has(id) ? "width-proven" : "unapproved",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function findDispatcherFormatterImports(): string[] {
  const file = path.join(process.cwd(), "src/ui/display-adapter.ts");
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const specifier = statement.moduleSpecifier.text;
    return specifier.endsWith("-formatter") ? [specifier.slice(2)] : [];
  });
}

describe("CLI width contract — primitive matrix", () => {
  it.each(WIDTHS)("W=%i の frame primitive は外幅を正確に守る", (width) => {
    resetFrameLineClampFallbackCount();
    const line = frameLine("warning", "あ".repeat(300), width);
    expect(visualWidth(stripAnsi(line))).toBe(width);
    expect(stripAnsi(line).endsWith("║")).toBe(true);
    expect(getFrameLineClampFallbackCount()).toBe(1);
  });

  it.each(WIDTHS)("W=%i の wrapper は全文 wrap し clamp fallback を使わない", (width) => {
    resetFrameLineClampFallbackCount();
    const buf = createRenderBuffer();
    pushWrappedFrameLine(buf, "warning", { width, purpose: "diagnostic" }, "診断文 ".repeat(200));
    expect(buf.getLines().length).toBeGreaterThan(1);
    for (const line of buf.getLines()) expect(visualWidth(stripAnsi(line))).toBe(width);
    expect(getFrameLineClampFallbackCount()).toBe(0);
  });

  it("title/type は 2 行を上限に part を縮退する", () => {
    const buf = createRenderBuffer();
    pushWrappedFrameLine(buf, "warning", { width: 40, purpose: "title" }, [
      { text: "長い電文タイトル", priority: 0, omission: "never" },
      { text: "追加種別情報", shortText: "種別", priority: 2, omission: "shorten" },
      { text: "低優先の補足", priority: 4, omission: "drop" },
    ]);
    expect(buf.getLines()).toHaveLength(2);
    for (const line of buf.getLines()) expect(visualWidth(stripAnsi(line))).toBe(40);
  });

  it("文字列入力の title/type も 2 行上限で最終省略する", () => {
    resetFrameLineClampFallbackCount();
    const buf = createRenderBuffer();
    pushWrappedFrameLine(buf, "warning", { width: 40, purpose: "type" }, "あ".repeat(200));
    expect(buf.getLines()).toHaveLength(1);
    expect(stripAnsi(buf.getLines()[0])).toContain("…");
    expect(getFrameLineClampFallbackCount()).toBe(0);
  });

  it("title/type は複数段落入力も正規化後に 2 行上限を適用する", () => {
    resetFrameLineClampFallbackCount();
    const buf = createRenderBuffer();
    pushWrappedFrameLine(buf, "warning", { width: 40, purpose: "title" }, "第一段落\n第二段落\r\n第三段落\r第四段落");
    expect(buf.getLines().length).toBeLessThanOrEqual(2);
    expect(buf.getLines().flatMap((line) => stripAnsi(line).match(/[\r\n]/g) ?? [])).toEqual([]);
    expect(getFrameLineClampFallbackCount()).toBe(0);
  });

  it("primitive の最終切詰めは OSC 8 hyperlink を閉じる", () => {
    const open = "\x1b]8;;https://example.test\x1b\\";
    const close = "\x1b]8;;\x1b\\";
    const line = frameLine("warning", `${open}${"長いリンク文字列".repeat(20)}${close}`, 40);
    expect(line).toContain(close);
    expect(line.lastIndexOf(close)).toBeLessThan(line.lastIndexOf("…"));
  });

  it("OSC 8 の params 付き開始形式も最終切詰めで閉じる", () => {
    const open = "\x1b]8;id=alert;https://example.test\x1b\\";
    const close = "\x1b]8;;\x1b\\";
    const line = frameLine("warning", `${open}${"長いリンク文字列".repeat(20)}`, 40);
    expect(line).toContain(close);
    expect(line.lastIndexOf(close)).toBeLessThan(line.lastIndexOf("…"));
  });

  it("plain / colored primitive は単独の CR も枠内に残さない", () => {
    const plain = frameLine("warning", "前\r後", 40);
    const colored = frameLineColored("warning", (text) => text, "前\r後", 40);
    expect(stripAnsi(plain)).not.toMatch(/[\r\n]/);
    expect(stripAnsi(colored)).not.toMatch(/[\r\n]/);
  });
});

describe("CLI width contract — static inventory gates", () => {
  it("AST は import alias / namespace を解決し、無関係な同名関数を除外する", () => {
    const source = ts.createSourceFile("nested/example.ts", [
      'import { frameLine as line } from "../formatter";',
      'import * as format from "../formatter";',
      'function render(): void {',
      '  const fixed = "固定";',
      '  line("info", `可変${name}`, 40);',
      '  format.frameLineColored("info", (s) => s, fixed, 40);',
      '}',
      'function frameLine(): void {}',
      'frameLine();',
    ].join("\n"), ts.ScriptTarget.Latest, true);
    expect(collectFrameLineCallSites(source, "nested/example.ts")).toEqual([
      { file: "nested/example.ts", line: 5, classification: "unapproved" },
      { file: "nested/example.ts", line: 6, classification: "unapproved" },
    ]);
  });

  it("AST は let・分割代入・関数引数 shadow をすべて可変扱いにする", () => {
    const source = ts.createSourceFile("nested/non-literal.ts", [
      'import { frameLine } from "../formatter";',
      'let fromLet = "固定";',
      'const { value: fromDestructure } = { value: "固定" };',
      'const label = "固定";',
      'function render(label: string): void {',
      '  frameLine("info", fromLet, 40);',
      '  frameLine("info", fromDestructure, 40);',
      '  frameLine("info", label, 40);',
      '}',
    ].join("\n"), ts.ScriptTarget.Latest, true);
    expect(collectFrameLineCallSites(source, "nested/non-literal.ts")).toEqual([
      { file: "nested/non-literal.ts", line: 6, classification: "unapproved" },
      { file: "nested/non-literal.ts", line: 7, classification: "unapproved" },
      { file: "nested/non-literal.ts", line: 8, classification: "unapproved" },
    ]);
  });

  it("AST 抽出した frameLine* source 30 本は §6 表と exact-set-equal", () => {
    const sources = [...new Set(findFrameLineCallSites().map((site) => site.file))];
    expect(sorted(sources)).toEqual(sorted(FRAME_LINE_SOURCE_CATALOG));
  });

  it("既知 source 内の新規可変 call site も site allowlist 外なら fail 対象にする", () => {
    const source = ts.createSourceFile("briefing-formatter.ts", [
      'import { frameLine } from "./formatter";',
      'declare const dynamicText: string;',
      'frameLine("info", dynamicText, 40);',
    ].join("\n"), ts.ScriptTarget.Latest, true);
    expect(collectFrameLineCallSites(source, "briefing-formatter.ts")).toEqual([
      { file: "briefing-formatter.ts", line: 3, classification: "unapproved" },
    ]);
  });

  it("各 call site を固定・幅証明済み・移行待ちへ分類し、可変 site allowlist を双方向 exact に照合する", () => {
    const sites = findFrameLineCallSites();
    const pendingSites = sites.filter((site) => site.classification === "migration-pending");
    const widthProvenSites = sites.filter((site) => site.classification === "width-proven");
    expect(new Set(pendingSites.map((site) => `${site.file}:${site.line}`))).toEqual(MIGRATION_PENDING_FRAME_LINE_SITES);
    expect(new Set(widthProvenSites.map((site) => `${site.file}:${site.line}`))).toEqual(WIDTH_PROVEN_FRAME_LINE_SITES);
    expect(sites.filter((site) => site.classification === "unapproved")).toEqual([]);
    expect(pendingSites.length).toBeGreaterThan(0);
    expect(new Set(MIGRATION_PENDING_FRAME_LINE_SOURCES).size).toBe(11);
    expect(sorted([...MIGRATION_PENDING_FRAME_LINE_SOURCES, ...WIDTH_PROVEN_FRAME_LINE_SOURCES])).toEqual(sorted(FRAME_LINE_SOURCE_CATALOG));
  });

  it("dispatcher entry formatter と test registry は別集合として exact-set-equal", () => {
    expect(sorted(findDispatcherFormatterImports())).toEqual(sorted(FORMATTER_TEST_REGISTRY));
  });
});
