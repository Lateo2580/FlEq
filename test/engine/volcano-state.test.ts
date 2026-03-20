import { describe, it, expect, beforeEach, vi } from "vitest";
import { VolcanoStateHolder } from "../../src/engine/messages/volcano-state";
import { ParsedVolcanoAlertInfo } from "../../src/types";

/** テスト用のアラート情報を生成するヘルパー */
function createAlertInfo(overrides: Partial<ParsedVolcanoAlertInfo> = {}): ParsedVolcanoAlertInfo {
  return {
    domain: "volcano",
    kind: "alert",
    type: "VFVO50",
    infoType: "発表",
    title: "噴火警報・予報",
    reportDateTime: "2025-01-01T00:00:00+09:00",
    eventDateTime: null,
    headline: null,
    publishingOffice: "気象庁",
    volcanoName: "浅間山",
    volcanoCode: "306",
    coordinate: "+3624.38+13831.38+2568/",
    isTest: false,
    alertLevel: 3,
    alertLevelCode: "13",
    action: "raise",
    previousLevelCode: "12",
    warningKind: "噴火警報（火口周辺）",
    municipalities: [],
    bodyText: "",
    preventionText: "",
    isMarine: false,
    ...overrides,
  };
}

describe("VolcanoStateHolder", () => {
  let state: VolcanoStateHolder;

  beforeEach(() => {
    state = new VolcanoStateHolder();
  });

  describe("update", () => {
    it("alert 情報でエントリが追加される", () => {
      const info = createAlertInfo();
      state.update(info);
      expect(state.size()).toBe(1);
      expect(state.getEntry("306")).toBeDefined();
    });

    it("alert 以外の kind は無視される", () => {
      state.update({
        domain: "volcano",
        kind: "eruption",
        type: "VFVO52",
        volcanoCode: "306",
      } as never);
      expect(state.size()).toBe(0);
    });

    it("取消報でエントリが削除される", () => {
      state.update(createAlertInfo());
      expect(state.size()).toBe(1);
      state.update(createAlertInfo({ infoType: "取消" }));
      expect(state.size()).toBe(0);
    });

    it("解除でエントリが削除される", () => {
      state.update(createAlertInfo());
      state.update(createAlertInfo({ action: "release" }));
      expect(state.size()).toBe(0);
    });

    it("レベル1+継続でエントリが削除される (通常状態)", () => {
      state.update(createAlertInfo());
      state.update(createAlertInfo({ alertLevel: 1, alertLevelCode: "11", action: "continue" }));
      expect(state.size()).toBe(0);
    });

    it("レベル2+継続ではエントリが保持される", () => {
      state.update(createAlertInfo({ alertLevel: 2, alertLevelCode: "12", action: "continue" }));
      expect(state.size()).toBe(1);
    });

    it("複数火山を同時追跡できる", () => {
      state.update(createAlertInfo({ volcanoCode: "306", volcanoName: "浅間山" }));
      state.update(createAlertInfo({ volcanoCode: "315", volcanoName: "箱根山", alertLevel: 2 }));
      state.update(createAlertInfo({ volcanoCode: "506", volcanoName: "桜島", alertLevel: 5 }));
      expect(state.size()).toBe(3);
    });

    it("同一火山コードでエントリが上書きされる", () => {
      state.update(createAlertInfo({ alertLevel: 2, action: "raise" }));
      state.update(createAlertInfo({ alertLevel: 3, action: "raise" }));
      expect(state.size()).toBe(1);
      expect(state.getEntry("306")!.alertLevel).toBe(3);
    });
  });

  describe("isRenotification", () => {
    it("新規は再通知ではない", () => {
      const info = createAlertInfo();
      expect(state.isRenotification(info)).toBe(false);
    });

    it("同一内容の繰り返しは再通知と判定される", () => {
      const info = createAlertInfo({ action: "continue" });
      state.update(info);
      expect(state.isRenotification(info)).toBe(true);
    });

    it("レベルが変わると再通知ではない", () => {
      state.update(createAlertInfo({ alertLevel: 2, alertLevelCode: "12", action: "continue" }));
      const next = createAlertInfo({ alertLevel: 3, alertLevelCode: "13", action: "continue" });
      expect(state.isRenotification(next)).toBe(false);
    });

    it("アクションが変わると再通知ではない", () => {
      state.update(createAlertInfo({ action: "continue" }));
      const next = createAlertInfo({ action: "raise" });
      expect(state.isRenotification(next)).toBe(false);
    });
  });

  describe("clear", () => {
    it("全エントリが削除される", () => {
      state.update(createAlertInfo({ volcanoCode: "306" }));
      state.update(createAlertInfo({ volcanoCode: "315" }));
      state.clear();
      expect(state.size()).toBe(0);
    });
  });

  describe("getPromptStatus", () => {
    it("エントリがない場合は null", () => {
      expect(state.getPromptStatus()).toBeNull();
    });

    it("最も高いレベルの火山が表示される", () => {
      state.update(createAlertInfo({ volcanoCode: "306", volcanoName: "浅間山", alertLevel: 3 }));
      state.update(createAlertInfo({ volcanoCode: "506", volcanoName: "桜島", alertLevel: 5 }));
      const status = state.getPromptStatus();
      expect(status).not.toBeNull();
      // text は chalk でカラーリングされているが、桜島の名前を含むはず
      expect(status!.text).toContain("桜島");
    });
  });

  describe("hasDetail / showDetail", () => {
    it("エントリがない場合は false", () => {
      expect(state.hasDetail()).toBe(false);
    });

    it("エントリがある場合は true", () => {
      state.update(createAlertInfo());
      expect(state.hasDetail()).toBe(true);
    });

    it("showDetail がエラーなく実行される", () => {
      state.update(createAlertInfo({ volcanoCode: "306", volcanoName: "浅間山", alertLevel: 3 }));
      state.update(createAlertInfo({ volcanoCode: "506", volcanoName: "桜島", alertLevel: 5 }));
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      state.showDetail();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("category / emptyMessage", () => {
    it("category が 'volcano'", () => {
      expect(state.category).toBe("volcano");
    });

    it("emptyMessage が設定されている", () => {
      expect(state.emptyMessage).toBeTruthy();
    });
  });
});
