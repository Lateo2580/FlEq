import { testTelegramMeta } from "../../helpers/telegram-meta";
import { describe, expect, it } from "vitest";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { ParsedTsunamiInfo } from "../../../src/types";

/** テスト用の ParsedTsunamiInfo を生成する (test/engine/tsunami-state.test.ts:11 と同じ形) */
function createTsunamiInfo(
  overrides: Partial<ParsedTsunamiInfo> = {}
): ParsedTsunamiInfo {
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

describe("TsunamiStateHolder.getLastInfo", () => {
  it("初期状態は null", () => {
    expect(new TsunamiStateHolder().getLastInfo()).toBeNull();
  });

  it("applyAccepted 後は lastInfo を返し、clear で null に戻る", () => {
    const holder = new TsunamiStateHolder();
    const info = createTsunamiInfo({
      forecast: [
        {
          areaName: "石川県能登",
          kind: "津波警報",
          maxHeightDescription: "３ｍ",
          firstHeight: "",
        },
      ],
    });
    holder.applyAccepted(info);
    expect(holder.getLastInfo()).not.toBeNull();
    holder.clear();
    expect(holder.getLastInfo()).toBeNull();
  });
});
