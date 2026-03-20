import { describe, it, expect, beforeEach } from "vitest";
import { resolveVolcanoPresentation } from "../../src/engine/notification/volcano-presentation";
import { VolcanoStateHolder } from "../../src/engine/messages/volcano-state";
import {
  ParsedVolcanoAlertInfo,
  ParsedVolcanoEruptionInfo,
  ParsedVolcanoAshfallInfo,
  ParsedVolcanoTextInfo,
  ParsedVolcanoPlumeInfo,
} from "../../src/types";

// ── テストヘルパー ──

function createBase(overrides: Record<string, unknown> = {}) {
  return {
    domain: "volcano" as const,
    infoType: "発表",
    title: "テスト",
    reportDateTime: "2025-01-01T00:00:00+09:00",
    eventDateTime: null,
    headline: null,
    publishingOffice: "気象庁",
    volcanoName: "浅間山",
    volcanoCode: "306",
    coordinate: null,
    isTest: false,
    ...overrides,
  };
}

function createAlert(overrides: Partial<ParsedVolcanoAlertInfo> = {}): ParsedVolcanoAlertInfo {
  return {
    ...createBase(),
    kind: "alert",
    type: "VFVO50",
    alertLevel: 3,
    alertLevelCode: "13",
    action: "raise",
    previousLevelCode: null,
    warningKind: "噴火警報（火口周辺）",
    municipalities: [],
    bodyText: "",
    preventionText: "",
    isMarine: false,
    ...overrides,
  };
}

function createEruption(overrides: Partial<ParsedVolcanoEruptionInfo> = {}): ParsedVolcanoEruptionInfo {
  return {
    ...createBase(),
    kind: "eruption",
    type: "VFVO52",
    phenomenonCode: "52",
    phenomenonName: "噴火",
    craterName: null,
    plumeHeight: null,
    plumeHeightUnknown: false,
    plumeDirection: null,
    isFlashReport: false,
    bodyText: "",
    ...overrides,
  };
}

function createAshfall(overrides: Partial<ParsedVolcanoAshfallInfo> = {}): ParsedVolcanoAshfallInfo {
  return {
    ...createBase(),
    kind: "ashfall",
    type: "VFVO54",
    subKind: "rapid",
    craterName: null,
    ashForecasts: [],
    plumeHeight: null,
    plumeDirection: null,
    bodyText: "",
    ...overrides,
  };
}

function createText(overrides: Partial<ParsedVolcanoTextInfo> = {}): ParsedVolcanoTextInfo {
  return {
    ...createBase(),
    kind: "text",
    type: "VFVO51",
    alertLevel: null,
    alertLevelCode: null,
    isExtraordinary: false,
    bodyText: "",
    nextAdvisory: null,
    ...overrides,
  };
}

function createPlume(overrides: Partial<ParsedVolcanoPlumeInfo> = {}): ParsedVolcanoPlumeInfo {
  return {
    ...createBase(),
    kind: "plume",
    type: "VFVO60",
    phenomenonCode: "51",
    craterName: null,
    plumeHeight: 1800,
    plumeDirection: "南東",
    windProfile: [],
    bodyText: "",
    ...overrides,
  };
}

describe("resolveVolcanoPresentation", () => {
  let volcanoState: VolcanoStateHolder;

  beforeEach(() => {
    volcanoState = new VolcanoStateHolder();
  });

  // ── 共通: 取消 ──

  describe("取消報", () => {
    it("全種別で cancel を返す", () => {
      const info = createAlert({ infoType: "取消" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("cancel");
      expect(p.soundLevel).toBe("cancel");
    });

    it("eruption 取消も cancel", () => {
      const info = createEruption({ infoType: "取消" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("cancel");
    });
  });

  // ── VFVO56: 噴火速報 ──

  describe("VFVO56 (噴火速報)", () => {
    it("critical / critical を返す", () => {
      const info = createEruption({ type: "VFVO56", isFlashReport: true });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("critical");
      expect(p.soundLevel).toBe("critical");
    });
  });

  // ── VFVO52: 噴火観測報 ──

  describe("VFVO52 (噴火観測報)", () => {
    it("爆発(51)は warning / normal", () => {
      const info = createEruption({ phenomenonCode: "51" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("warning");
      expect(p.soundLevel).toBe("normal");
    });

    it("噴火多発(56)は warning / normal", () => {
      const info = createEruption({ phenomenonCode: "56" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("warning");
    });

    it("噴煙≥3000m は warning", () => {
      const info = createEruption({ phenomenonCode: "52", plumeHeight: 3000 });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("warning");
    });

    it("軽微な噴火(52)は normal / info", () => {
      const info = createEruption({ phenomenonCode: "52", plumeHeight: 500 });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("normal");
      expect(p.soundLevel).toBe("info");
    });
  });

  // ── VFVO50: 噴火警報 ──

  describe("VFVO50 (噴火警報)", () => {
    it("Lv4-5 引上げ → critical / critical", () => {
      const info = createAlert({ alertLevel: 5, alertLevelCode: "15", action: "raise" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("critical");
      expect(p.soundLevel).toBe("critical");
    });

    it("Lv2-3 引上げ → warning / warning", () => {
      const info = createAlert({ alertLevel: 3, alertLevelCode: "13", action: "raise" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("warning");
      expect(p.soundLevel).toBe("warning");
    });

    it("引下げ → normal / normal", () => {
      const info = createAlert({ alertLevel: 1, alertLevelCode: "11", action: "lower" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("normal");
      expect(p.soundLevel).toBe("normal");
    });

    it("解除 → normal / normal", () => {
      const info = createAlert({ action: "release" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("normal");
    });

    it("Lv4-5 継続 (初見) → critical / normal", () => {
      const info = createAlert({ alertLevel: 5, alertLevelCode: "15", action: "continue" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("critical");
      expect(p.soundLevel).toBe("normal");
    });

    it("Lv4-5 継続 (再通知) → warning / normal", () => {
      const info = createAlert({ alertLevel: 5, alertLevelCode: "15", action: "continue" });
      volcanoState.update(info); // 1回目で状態登録
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("warning");
      expect(p.soundLevel).toBe("normal");
    });

    it("Lv2-3 継続 (初見) → warning / normal", () => {
      const info = createAlert({ alertLevel: 3, alertLevelCode: "13", action: "continue" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("warning");
      expect(p.soundLevel).toBe("normal");
    });

    it("Lv2-3 継続 (再通知) → normal / info", () => {
      const info = createAlert({ alertLevel: 3, alertLevelCode: "13", action: "continue" });
      volcanoState.update(info);
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("normal");
      expect(p.soundLevel).toBe("info");
    });

    it("Lv1 継続 → normal / info", () => {
      const info = createAlert({ alertLevel: 1, alertLevelCode: "11", action: "continue" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("normal");
      expect(p.soundLevel).toBe("info");
    });
  });

  // ── VFSVii: 海上警報 ──

  describe("VFSVii (海上警報)", () => {
    it("海上警報 (Code 31) → warning / warning", () => {
      const info = createAlert({ type: "VFSVii", isMarine: true, alertLevelCode: "31" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("warning");
      expect(p.soundLevel).toBe("warning");
    });

    it("海上予報 (Code 33) → normal / normal", () => {
      const info = createAlert({ type: "VFSVii", isMarine: true, alertLevelCode: "33" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("normal");
      expect(p.soundLevel).toBe("normal");
    });
  });

  // ── 降灰予報 ──

  describe("降灰予報", () => {
    it("VFVO54 速報 → warning / warning", () => {
      const info = createAshfall({ type: "VFVO54", subKind: "rapid" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("warning");
      expect(p.soundLevel).toBe("warning");
    });

    it("VFVO55 詳細 → normal / normal", () => {
      const info = createAshfall({ type: "VFVO55", subKind: "detailed" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("normal");
      expect(p.soundLevel).toBe("normal");
    });

    it("VFVO53 定時 → info / info", () => {
      const info = createAshfall({ type: "VFVO53", subKind: "scheduled" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("info");
      expect(p.soundLevel).toBe("info");
    });
  });

  // ── テキスト系 ──

  describe("テキスト系", () => {
    it("VFVO51 臨時 → warning / normal", () => {
      const info = createText({ isExtraordinary: true });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("warning");
      expect(p.soundLevel).toBe("normal");
    });

    it("VFVO51 通常 → info / info", () => {
      const info = createText({ isExtraordinary: false });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("info");
      expect(p.soundLevel).toBe("info");
    });

    it("VZVO40 → info / info", () => {
      const info = createText({ type: "VZVO40" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("info");
      expect(p.soundLevel).toBe("info");
    });
  });

  // ── 推定噴煙流向報 ──

  describe("VFVO60 (推定噴煙流向報)", () => {
    it("normal / info を返す", () => {
      const info = createPlume();
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.frameLevel).toBe("normal");
      expect(p.soundLevel).toBe("info");
    });
  });

  // ── summary ──

  describe("summary", () => {
    it("alert の summary に火山名を含む", () => {
      const info = createAlert({ volcanoName: "桜島" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.summary).toContain("桜島");
    });

    it("eruption の summary に現象名を含む", () => {
      const info = createEruption({ phenomenonName: "噴火" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.summary).toContain("噴火");
    });

    it("ashfall の summary に降灰予報を含む", () => {
      const info = createAshfall();
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.summary).toContain("降灰予報");
    });

    it("取消の summary", () => {
      const info = createAlert({ infoType: "取消" });
      const p = resolveVolcanoPresentation(info, volcanoState);
      expect(p.summary).toContain("取り消されました");
    });
  });
});
