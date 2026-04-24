import { describe, it, expect } from "vitest";
import { applyFilter } from "../../../src/engine/template/filters";

describe("applyFilter", () => {
  // ── default ──

  describe("default", () => {
    it("null → デフォルト値", () => {
      expect(applyFilter("default", null, ["N/A"])).toBe("N/A");
    });

    it("undefined → デフォルト値", () => {
      expect(applyFilter("default", undefined, ["N/A"])).toBe("N/A");
    });

    it("空文字 → デフォルト値", () => {
      expect(applyFilter("default", "", ["N/A"])).toBe("N/A");
    });

    it("値あり → そのまま", () => {
      expect(applyFilter("default", "hello", ["N/A"])).toBe("hello");
    });

    it("数値 0 → そのまま (falsy だがデフォルトにしない)", () => {
      expect(applyFilter("default", 0, ["N/A"])).toBe(0);
    });
  });

  // ── truncate ──

  describe("truncate", () => {
    it("文字数制限", () => {
      expect(applyFilter("truncate", "abcdefghij", [5])).toBe("abcde");
    });

    it("短い文字列はそのまま", () => {
      expect(applyFilter("truncate", "abc", [10])).toBe("abc");
    });

    it("ちょうど同じ長さ → そのまま", () => {
      expect(applyFilter("truncate", "abc", [3])).toBe("abc");
    });
  });

  // ── pad ──

  describe("pad", () => {
    it("右パディング", () => {
      expect(applyFilter("pad", "ab", [4])).toBe("ab  ");
    });

    it("既に十分な長さ → そのまま", () => {
      expect(applyFilter("pad", "abcde", [3])).toBe("abcde");
    });
  });

  // ── join (削除済み: 表示専用ポリシー対応) ──

  describe("join (削除済み)", () => {
    it("未知のフィルタ扱い: 値をそのまま返す", () => {
      // 表示専用ポリシー対応で join フィルタは削除された。
      // applyFilter は未知フィルタ名を受けたら値をそのまま返す仕様。
      expect(applyFilter("join", ["a", "b", "c"], [", "])).toEqual(["a", "b", "c"]);
    });
  });

  // ── replace ──

  describe("replace", () => {
    it("文字列置換 (2引数)", () => {
      expect(applyFilter("replace", "hello world", ["world", "earth"])).toBe("hello earth");
    });

    it("複数箇所を置換", () => {
      expect(applyFilter("replace", "aXbXc", ["X", "-"])).toBe("a-b-c");
    });

    it("改行文字を含む search は禁止 (表示専用ポリシー対応)", () => {
      expect(() => applyFilter("replace", "a\nb", ["\n", "|"])).toThrow(/改行文字/);
    });

    it("改行文字を含む replacement は禁止 (表示専用ポリシー対応)", () => {
      expect(() => applyFilter("replace", "ax", ["x", "y\n"])).toThrow(/改行文字/);
    });

    it("配列も改行で結合されたうえで置換される (1行化できない)", () => {
      // 配列はまず \n join され、カンマは含まれないため置換は無効となる
      expect(applyFilter("replace", ["a", "b", "c"], [",", "|"])).toBe("a\nb\nc");
    });
  });

  // ── upper / lower ──

  describe("upper", () => {
    it("大文字変換", () => {
      expect(applyFilter("upper", "hello", [])).toBe("HELLO");
    });

    it("配列は改行区切りのまま大文字化 (1行化できない)", () => {
      expect(applyFilter("upper", ["abc", "def"], [])).toBe("ABC\nDEF");
    });
  });

  describe("lower", () => {
    it("小文字変換", () => {
      expect(applyFilter("lower", "HELLO", [])).toBe("hello");
    });

    it("配列は改行区切りのまま小文字化 (1行化できない)", () => {
      expect(applyFilter("lower", ["ABC", "DEF"], [])).toBe("abc\ndef");
    });
  });

  // ── date ──

  describe("date", () => {
    const iso = "2024-03-15T14:30:45+09:00";

    it("HH:mm フォーマット", () => {
      const result = applyFilter("date", iso, ["HH:mm"]);
      // タイムゾーンに依存するので時刻パターンで検証
      expect(result).toMatch(/^\d{2}:\d{2}$/);
    });

    it("HH:mm:ss フォーマット", () => {
      const result = applyFilter("date", iso, ["HH:mm:ss"]);
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it("MM/DD HH:mm フォーマット", () => {
      const result = applyFilter("date", iso, ["MM/DD HH:mm"]);
      expect(result).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
    });

    it("Date オブジェクトも受け付ける", () => {
      const date = new Date("2024-01-01T00:00:00Z");
      const result = applyFilter("date", date, ["HH:mm"]);
      expect(result).toMatch(/^\d{2}:\d{2}$/);
    });

    it("不正な日時文字列 → そのまま返す", () => {
      expect(applyFilter("date", "invalid", ["HH:mm"])).toBe("invalid");
    });
  });

  // ── 未知のフィルタ ──

  describe("未知のフィルタ", () => {
    it("そのまま返す", () => {
      expect(applyFilter("nonexistent", "value", [])).toBe("value");
    });

    it("オブジェクトもそのまま返す", () => {
      const obj = { a: 1 };
      expect(applyFilter("unknown", obj, [])).toBe(obj);
    });
  });
});
