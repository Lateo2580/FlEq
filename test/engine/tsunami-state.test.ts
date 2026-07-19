import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TsunamiStateHolder } from "../../src/engine/messages/tsunami-state";
import { ParsedTsunamiInfo } from "../../src/types";

// sound-player をモック
vi.mock("../../src/engine/notification/sound-player", () => ({
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
      holder.update(
        createTsunamiInfo({
          infoType: "取消",
          reportDateTime: "2025-01-01T00:01:00+09:00",
        }),
      );

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
          reportDateTime: "2025-01-01T00:01:00+09:00",
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
          reportDateTime: "2025-01-01T00:01:00+09:00",
          forecast: [
            { areaName: "岩手県", kind: "大津波警報", maxHeightDescription: "10m超", firstHeight: "到達中と推測" },
            { areaName: "宮城県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
          ],
        })
      );
      expect(holder.getLevel()).toBe("大津波警報");
    });

    it("発表→取消→古い発表の後着で取消状態と tombstone を維持する", () => {
      const warning = createTsunamiInfo({
        reportDateTime: "2025-01-01T00:00:00+09:00",
        forecast: [
          { areaName: "岩手県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
        ],
      });
      const cancellation = createTsunamiInfo({
        infoType: "取消",
        reportDateTime: "2025-01-01T00:02:00+09:00",
      });
      const staleWarning = createTsunamiInfo({
        reportDateTime: "2025-01-01T00:01:00+09:00",
        forecast: [
          { areaName: "岩手県", kind: "大津波警報", maxHeightDescription: "10m超", firstHeight: "到達中と推測" },
        ],
      });

      expect(holder.update(warning).kind).toBe("updated");
      expect(holder.update(cancellation).kind).toBe("updated");
      expect(holder.update(staleWarning).kind).toBe("suppressed");
      expect(holder.getLevel()).toBeNull();
      expect(holder.getLastInfo()).toBeNull();
    });

    it("同じ reportDateTime の重複報を棄却して状態を変更しない", () => {
      const first = createTsunamiInfo({
        forecast: [
          { areaName: "岩手県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
        ],
      });
      const duplicate = createTsunamiInfo({
        forecast: [
          { areaName: "岩手県", kind: "津波注意報", maxHeightDescription: "1m", firstHeight: "" },
        ],
      });

      expect(holder.update(first).kind).toBe("updated");
      expect(holder.update(duplicate).kind).toBe("suppressed");
      expect(holder.getLevel()).toBe("津波警報");
      expect(holder.getLastInfo()).toBe(first);
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
