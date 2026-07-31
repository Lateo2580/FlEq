import { testTelegramMeta } from "../../helpers/telegram-meta";
import { describe, it, expect } from "vitest";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import type { ParsedTsunamiInfo } from "../../../src/types";

/**
 * TsunamiStateHolder の敵対的シーケンステスト。
 *
 * tsunami-state.test.ts に基本挙動 (レベル追従・取消クリア・同時刻重複棄却・
 * 発表→取消→古い発表の後着) が入っているので、このファイルは「古い取消が
 * アクティブ警報を消してしまわないか」「順序逆転した格下げ報」「取消後の
 * 再発表」「壊れた reportDateTime」といった別シーケンスだけを集める。
 *
 * watermark 判定 (reportTime <= watermark → suppressed) が 取消 branch より
 * 前段にあるため、遅れて届いた取消は現行警報を消せない、という契約が要点。
 */

function tsunami(overrides: Partial<ParsedTsunamiInfo> = {}): ParsedTsunamiInfo {
  return {
    meta: testTelegramMeta(false),
    type: "VTSE41",
    infoType: "発表",
    title: "津波警報・注意報・予報",
    reportDateTime: "2025-01-01T00:00:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    forecast: [],
    warningComment: "",
    isTest: false,
    ...overrides,
  };
}

function warningAt(reportDateTime: string, kind: string): ParsedTsunamiInfo {
  return tsunami({
    reportDateTime,
    forecast: [{ areaName: "岩手県", kind, maxHeightDescription: "3m", firstHeight: "到達中と推測" }],
  });
}

describe("TsunamiStateHolder 敵対シーケンス", () => {
  it("watermark より古い取消はアクティブ警報を消さない (遅着取消の無効化)", () => {
    const holder = new TsunamiStateHolder();
    expect(holder.update(warningAt("2025-01-01T00:02:00+09:00", "津波警報")).kind).toBe("updated");
    expect(holder.getLevel()).toBe("津波警報");

    // 警報より前の時刻を持つ取消が遅れて届く → watermark で棄却され、警報は残る
    const staleCancel = tsunami({ infoType: "取消", reportDateTime: "2025-01-01T00:01:00+09:00" });
    expect(holder.update(staleCancel).kind).toBe("suppressed");
    expect(holder.getLevel()).toBe("津波警報");
    expect(holder.getLastInfo()).not.toBeNull();
  });

  it("順序逆転した格下げ報は棄却され、高いレベルを維持する", () => {
    const holder = new TsunamiStateHolder();
    expect(holder.update(warningAt("2025-01-01T00:02:00+09:00", "大津波警報")).kind).toBe("updated");
    expect(holder.getLevel()).toBe("大津波警報");

    // 古い時刻の 津波注意報 が遅れて届く → 棄却され、大津波警報のまま
    expect(holder.update(warningAt("2025-01-01T00:01:00+09:00", "津波注意報")).kind).toBe("suppressed");
    expect(holder.getLevel()).toBe("大津波警報");
  });

  it("取消でクリア後、より新しい発表で警報が復活する (tombstone は新報を止めない)", () => {
    const holder = new TsunamiStateHolder();
    expect(holder.update(warningAt("2025-01-01T00:01:00+09:00", "津波警報")).kind).toBe("updated");
    expect(holder.update(tsunami({ infoType: "取消", reportDateTime: "2025-01-01T00:02:00+09:00" })).kind).toBe("updated");
    expect(holder.getLevel()).toBeNull();

    // 取消より新しい発表は tombstone を越えて受理される
    expect(holder.update(warningAt("2025-01-01T00:03:00+09:00", "大津波警報")).kind).toBe("updated");
    expect(holder.getLevel()).toBe("大津波警報");
  });

  it("壊れた reportDateTime の発表を棄却し、状態を汚染しない", () => {
    const holder = new TsunamiStateHolder();
    expect(holder.update(warningAt("not-a-date", "津波警報")).kind).toBe("suppressed");
    expect(holder.getLevel()).toBeNull();

    // 壊れた報の後でも正常な発表は受理される (watermark は null のまま)
    expect(holder.update(warningAt("2025-01-01T00:01:00+09:00", "津波警報")).kind).toBe("updated");
    expect(holder.getLevel()).toBe("津波警報");
  });
});
