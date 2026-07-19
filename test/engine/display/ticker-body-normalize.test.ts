import { describe, it, expect } from "vitest";
import { normalizeTickerBody } from "../../../src/engine/display/ticker-body-normalize";

describe("normalizeTickerBody", () => {
  it("行頭の全角字下げを除去し全角数字を半角化する", () => {
    expect(normalizeTickerBody("　　１７日１５時から")).toBe("17日15時から");
  });
  it("桁揃えの連続空白を半角1個へ圧縮し全角英数を半角化する", () => {
    expect(normalizeTickerBody("東　　　　　１００ｋｍ")).toBe("東 100km");
  });
  it("改行は半角スペース1個に置換し次行の行頭字下げは除去する", () => {
    expect(normalizeTickerBody("概況\n　防災事項")).toBe("概況 防災事項");
  });
  it("空行を挟んでも半角スペース1個にまとまる", () => {
    expect(normalizeTickerBody("概況\n\n防災事項")).toBe("概況 防災事項");
  });
  it("カナ・句読点は不変", () => {
    expect(normalizeTickerBody("桜島。")).toBe("桜島。");
  });
  it("全空白・空文字は null を返す", () => {
    expect(normalizeTickerBody("　")).toBeNull();
    expect(normalizeTickerBody("")).toBeNull();
    expect(normalizeTickerBody(null)).toBeNull();
  });
  it("冪等 (二重適用で不変)", () => {
    const x = "　　１７日　　１００ｋｍ\n　次行\n\n空行挟み";
    const once = normalizeTickerBody(x);
    expect(normalizeTickerBody(once)).toBe(once);
  });
  it("CRLF 改行はスペース1個に統一され \\r が残らない", () => {
    expect(normalizeTickerBody("概況\r\n防災事項")).toBe("概況 防災事項");
  });
  it("行末に空白があっても結合時に二重スペースにならない", () => {
    expect(normalizeTickerBody("A \nB")).toBe("A B");
  });
  it("CRLF・行末空白を含む入力でも冪等 (二重適用で不変)", () => {
    const x = "概況 \r\n　防災事項\r\n\r\n続報 ";
    const once = normalizeTickerBody(x);
    expect(normalizeTickerBody(once)).toBe(once);
    expect(once).toBe("概況 防災事項 続報");
  });
});
