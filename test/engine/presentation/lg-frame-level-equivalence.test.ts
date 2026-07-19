import { describe, it, expect } from "vitest";
import {
  lgObservationFrameLevel,
  nankaiTroughFrameLevel,
  seismicTextFrameLevel,
} from "../../../src/engine/presentation/level-helpers";
import type { ParsedLgObservationInfo, ParsedNankaiTroughInfo, ParsedSeismicTextInfo } from "../../../src/types";

function lgInfo(overrides: Partial<ParsedLgObservationInfo>): ParsedLgObservationInfo {
  return {
    type: "VXSE62", infoType: "発表", title: "長周期地震動に関する観測情報",
    reportDateTime: "2024-06-13T00:00:00+09:00", headline: null,
    publishingOffice: "気象庁", areas: [], isTest: false, ...overrides,
  };
}

/**
 * Phase 4a: UI コピー (earthquake-formatter.ts:125-134, lgIntToNumeric ベース) 撤去前の
 * 実値域同値性の固定。canonical (Number() + NaN ガード) は実 fixture 値域 "1"-"4" と
 * 欠損・取消で UI コピーと同値 (Codex R2 確認)。
 * 非正規文字列での差異 (canonical を真実源として採用):
 *   - "03": UI コピー lgIntToNumeric → -1 → info / canonical Number("03")=3 → warning
 *   - "3.5": UI コピー → -1 → info / canonical 3.5 → warning
 * frame と通知の一致を優先し canonical に寄せる (spec §2)。
 */
describe("lgObservationFrameLevel 実値域同値性 (UI コピー撤去の前提固定)", () => {
  it("実値域 '1'-'4' / 欠損 / 取消 で旧 UI コピーと同じ FrameLevel を返す", () => {
    expect(lgObservationFrameLevel(lgInfo({ maxLgInt: "4" }))).toBe("critical");
    expect(lgObservationFrameLevel(lgInfo({ maxLgInt: "3" }))).toBe("warning");
    expect(lgObservationFrameLevel(lgInfo({ maxLgInt: "2" }))).toBe("normal");
    expect(lgObservationFrameLevel(lgInfo({ maxLgInt: "1" }))).toBe("info");
    expect(lgObservationFrameLevel(lgInfo({}))).toBe("info");
    expect(lgObservationFrameLevel(lgInfo({ infoType: "取消", maxLgInt: "4" }))).toBe("cancel");
  });
});

describe("nankaiTroughFrameLevel / seismicTextFrameLevel (UI 側判定撤去の前提固定)", () => {
  function nankai(code: string | null, infoType = "発表"): ParsedNankaiTroughInfo {
    return {
      type: "VYSE50", infoType, title: "南海トラフ地震臨時情報",
      reportDateTime: "2024-08-08T00:00:00+09:00", headline: null,
      publishingOffice: "気象庁", bodyText: "", isTest: false,
      ...(code != null ? { infoSerial: { name: "x", code } } : {}),
    };
  }
  it("南海トラフ: 120=critical / 130,111-113,210,219,未知,欠損(VYSE60)=warning / 190,200=info / 取消=cancel", () => {
    expect(nankaiTroughFrameLevel(nankai("120"))).toBe("critical");
    for (const c of ["130", "111", "112", "113", "210", "219", "999"]) {
      expect(nankaiTroughFrameLevel(nankai(c)), c).toBe("warning");
    }
    expect(nankaiTroughFrameLevel(nankai(null))).toBe("warning");
    expect(nankaiTroughFrameLevel(nankai("190"))).toBe("info");
    expect(nankaiTroughFrameLevel(nankai("200"))).toBe("info");
    expect(nankaiTroughFrameLevel(nankai("120", "取消"))).toBe("cancel");
  });
  it("地震テキスト: 取消=cancel / その他=info", () => {
    const st = (infoType: string): ParsedSeismicTextInfo => ({
      type: "VXSE56", infoType, title: "t", reportDateTime: "2024-01-01T00:00:00+09:00",
      headline: null, publishingOffice: "気象庁", bodyText: "", isTest: false,
    });
    expect(seismicTextFrameLevel(st("発表"))).toBe("info");
    expect(seismicTextFrameLevel(st("取消"))).toBe("cancel");
  });
});
