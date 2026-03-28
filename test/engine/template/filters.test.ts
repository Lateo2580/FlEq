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

  // ── join ──

  describe("join", () => {
    it("配列結合", () => {
      expect(applyFilter("join", ["a", "b", "c"], [", "])).toBe("a, b, c");
    });

    it("非配列はそのまま文字列化", () => {
      expect(applyFilter("join", 42, [", "])).toBe("42");
    });

    it("セパレータ省略時はカンマ", () => {
      expect(applyFilter("join", ["x", "y"], [])).toBe("x,y");
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
  });

  // ── upper / lower ──

  describe("upper", () => {
    it("大文字変換", () => {
      expect(applyFilter("upper", "hello", [])).toBe("HELLO");
    });
  });

  describe("lower", () => {
    it("小文字変換", () => {
      expect(applyFilter("lower", "HELLO", [])).toBe("hello");
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
