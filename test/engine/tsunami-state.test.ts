import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectTsunamiAlertLevel, TsunamiStateHolder } from "../../src/engine/tsunami-state";
import { ParsedTsunamiInfo } from "../../src/types";

// sound-player をモック
vi.mock("../../src/engine/sound-player", () => ({
  playSound: vi.fn(),
}));

/** テスト用の ParsedTsunamiInfo を生成する */
function createTsunamiInfo(
  overrides: Partial<ParsedTsunamiInfo> = {}
): ParsedTsunamiInfo {
  return {
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

describe("detectTsunamiAlertLevel", () => {
  it("大津波警報を含む場合 → '大津波警報'", () => {
    expect(detectTsunamiAlertLevel(["津波注意報", "大津波警報", "津波警報"])).toBe("大津波警報");
  });

  it("津波警報が最大の場合 → '津波警報'", () => {
    expect(detectTsunamiAlertLevel(["津波注意報", "津波警報"])).toBe("津波警報");
  });

  it("津波注意報のみ → '津波注意報'", () => {
    expect(detectTsunamiAlertLevel(["津波注意報"])).toBe("津波注意報");
  });

  it("津波予報のみ → null", () => {
    expect(detectTsunamiAlertLevel(["津波予報（若干の海面変動）"])).toBeNull();
  });

  it("空配列 → null", () => {
    expect(detectTsunamiAlertLevel([])).toBeNull();
  });
});

describe("TsunamiStateHolder", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let holder: TsunamiStateHolder;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    holder = new TsunamiStateHolder();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe("update", () => {
    it("津波警報で更新される", () => {
      const info = createTsunamiInfo({
        forecast: [
          { areaName: "岩手県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
        ],
      });

      holder.update(info);

      expect(holder.getLevel()).toBe("津波警報");
      expect(holder.hasDetail()).toBe(true);
    });

    it("取消報でクリアされる", () => {
      // まず警報を設定
      holder.update(
        createTsunamiInfo({
          forecast: [
            { areaName: "岩手県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
          ],
        })
      );
      expect(holder.getLevel()).toBe("津波警報");

      // 取消報
      holder.update(createTsunamiInfo({ infoType: "取消" }));

      expect(holder.getLevel()).toBeNull();
      expect(holder.hasDetail()).toBe(false);
    });

    it("警報レベルなし (津波予報のみ) でクリアされる", () => {
      // まず警報を設定
      holder.update(
        createTsunamiInfo({
          forecast: [
            { areaName: "岩手県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
          ],
        })
      );

      // 津波予報のみに変更
      holder.update(
        createTsunamiInfo({
          forecast: [
            { areaName: "岩手県", kind: "津波予報（若干の海面変動）", maxHeightDescription: "0.2m未満", firstHeight: "" },
          ],
        })
      );

      expect(holder.getLevel()).toBeNull();
    });

    it("レベル変更に追従する (津波警報 → 大津波警報)", () => {
      holder.update(
        createTsunamiInfo({
          forecast: [
            { areaName: "岩手県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
          ],
        })
      );
      expect(holder.getLevel()).toBe("津波警報");

      holder.update(
        createTsunamiInfo({
          forecast: [
            { areaName: "岩手県", kind: "大津波警報", maxHeightDescription: "10m超", firstHeight: "到達中と推測" },
            { areaName: "宮城県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
          ],
        })
      );
      expect(holder.getLevel()).toBe("大津波警報");
    });
  });

  describe("getPromptStatus", () => {
    it("アクティブ時はセグメントを返す", () => {
      holder.update(
        createTsunamiInfo({
          forecast: [
            { areaName: "岩手県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
          ],
        })
      );

      const segment = holder.getPromptStatus();
      expect(segment).not.toBeNull();
      expect(segment!.priority).toBe(10);
      // テキストには chalk 適用済みの "津波警報" が含まれる (ANSI エスケープ付き)
      expect(segment!.text).toContain("津波警報");
    });

    it("非アクティブ時は null を返す", () => {
      expect(holder.getPromptStatus()).toBeNull();
    });
  });

  describe("hasDetail / showDetail", () => {
    it("情報がある場合 hasDetail() は true", () => {
      holder.update(
        createTsunamiInfo({
          forecast: [
            { areaName: "岩手県", kind: "津波注意報", maxHeightDescription: "1m", firstHeight: "" },
          ],
        })
      );

      expect(holder.hasDetail()).toBe(true);
    });

    it("情報がない場合 hasDetail() は false", () => {
      expect(holder.hasDetail()).toBe(false);
    });

    it("showDetail() で displayTsunamiInfo が呼ばれる", () => {
      holder.update(
        createTsunamiInfo({
          forecast: [
            { areaName: "岩手県", kind: "津波注意報", maxHeightDescription: "1m", firstHeight: "" },
          ],
        })
      );

      holder.showDetail();

      // displayTsunamiInfo が console.log を呼ぶことを確認
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe("category / emptyMessage", () => {
    it("category は 'tsunami'", () => {
      expect(holder.category).toBe("tsunami");
    });

    it("emptyMessage が定義されている", () => {
      expect(holder.emptyMessage).toBe("現在、継続中の津波情報はありません。");
    });
  });
});
