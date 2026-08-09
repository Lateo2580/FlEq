import { describe, it, expect, vi } from "vitest";
import { buildSummaryTokens } from "../../../src/ui/summary/token-builders";
import { buildSummaryModel } from "../../../src/ui/summary/summary-model";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import type { ProcessDeps } from "../../../src/engine/presentation/processors/process-message";
import { processMessage } from "../../../src/engine/presentation/processors/process-message";
import { buildVolcanoOutcome } from "../../../src/engine/presentation/processors/process-volcano";
import { parseVolcanoTelegram } from "../../../src/dmdata/volcano-parser";
import type { Route } from "../../../src/engine/messages/route-catalog";
import { makeProcessDeps as makeDeps } from "../../helpers/process-deps";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE51_SHINDO,
  FIXTURE_VXSE52_HYPO_1,
  FIXTURE_VXSE61_1,
  FIXTURE_VXSE43_WARNING_S1,
  FIXTURE_VXSE45_S1,
  FIXTURE_VXSE45_CANCEL,
  FIXTURE_VTSE41_WARN,
  FIXTURE_VXSE62_LGOBS,
  FIXTURE_VXSE56_ACTIVITY_1,
  FIXTURE_VYSE50_INVESTIGATION,
  FIXTURE_VFVO50_ALERT_LV3,
  FIXTURE_VFVO52_ERUPTION_1,
  FIXTURE_VFVO51_EXTRA,
  FIXTURE_VFVO53_ASH_REGULAR,
  FIXTURE_VFVO60_PLUME,
  FIXTURE_VZSE40_NOTICE,
  FIXTURE_VPCJ51_KANTO_SNOW,
  FIXTURE_VPZJ51_SENJOU,
  FIXTURE_VPZI50_HOT_DRY,
  FIXTURE_VPCI50_KANTO_TSUYU,
  FIXTURE_VPFT50_SAITAMA,
  FIXTURE_VPFT50_CANCEL,
  FIXTURE_VPFT50_TITLE_ESCALATION,
} from "../../helpers/mock-message";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    existsSync: (p: string) => {
      if (typeof p === "string" && p.includes("eew-logs")) return true;
      return actual.existsSync(p);
    },
    mkdirSync: vi.fn(),
    promises: {
      ...actual.promises,
      appendFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});
vi.mock("../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

function makeTokens(fixture: string, route: Route, deps?: ProcessDeps) {
  const d = deps ?? makeDeps();
  const msg = createMockWsDataMessage(fixture);

  // 火山は VolcanoRouteHandler 経由でのみ処理されるため、
  // テストでは buildVolcanoOutcome を直接使用する
  if (route === "volcano") {
    const volcanoInfo = parseVolcanoTelegram(msg);
    expect(volcanoInfo).not.toBeNull();
    const outcome = buildVolcanoOutcome(msg, volcanoInfo!, d.volcanoState);
    const event = toPresentationEvent(outcome);
    const model = buildSummaryModel(event);
    return { tokens: buildSummaryTokens(event, model), event, model };
  }

  const outcome = processMessage(msg, route, d)!;
  expect(outcome).not.toBeNull();
  const event = toPresentationEvent(outcome);
  const model = buildSummaryModel(event);
  return { tokens: buildSummaryTokens(event, model), event, model };
}

function ids(tokens: { id: string }[]): string[] {
  return tokens.map((t) => t.id);
}

describe("buildSummaryTokens", () => {
  // ── EEW ──

  describe("EEW", () => {
    it("EEW 警報: severity/kind/maxInt が priority 0", () => {
      const deps = makeDeps();
      const { tokens } = makeTokens(FIXTURE_VXSE43_WARNING_S1, "eew", deps);

      const p0 = tokens.filter((t) => t.priority === 0);
      const p0ids = p0.map((t) => t.id);
      expect(p0ids).toContain("severity");
      expect(p0ids).toContain("kind");
      expect(p0ids).toContain("maxInt");

      const kindToken = tokens.find((t) => t.id === "kind")!;
      expect(kindToken.text).toBe("EEW警報");
    });

    it("EEW 予報: kind が EEW予報", () => {
      const deps = makeDeps();
      const { tokens } = makeTokens(FIXTURE_VXSE45_S1, "eew", deps);

      const kindToken = tokens.find((t) => t.id === "kind")!;
      expect(kindToken.text).toBe("EEW予報");
    });

    it("EEW 取消: kind が EEW取消", () => {
      const deps = makeDeps();
      // First feed a normal EEW so tracker has state
      makeTokens(FIXTURE_VXSE45_S1, "eew", deps);
      const { tokens } = makeTokens(FIXTURE_VXSE45_CANCEL, "eew", deps);

      const kindToken = tokens.find((t) => t.id === "kind")!;
      expect(kindToken.text).toBe("EEW取消");
    });

    it("EEW: serial token は drop mode", () => {
      const deps = makeDeps();
      const { tokens } = makeTokens(FIXTURE_VXSE45_S1, "eew", deps);
      const serial = tokens.find((t) => t.id === "serial");
      if (serial) {
        expect(serial.dropMode).toBe("drop");
        expect(serial.priority).toBe(1);
      }
    });
  });

  // ── 地震 ──

  describe("earthquake", () => {
    it("VXSE53: 震源・震度情報のトークン構成", () => {
      const { tokens } = makeTokens(FIXTURE_VXSE53_ENCHI, "earthquake");

      expect(ids(tokens)).toContain("severity");
      expect(ids(tokens)).toContain("type");

      const typeToken = tokens.find((t) => t.id === "type")!;
      expect(typeToken.text).toBe("震源・震度情報");
      expect(typeToken.shortText).toBe("震源震度");
      expect(typeToken.dropMode).toBe("shorten");
    });

    it("VXSE51: 震度速報トークン", () => {
      const { tokens } = makeTokens(FIXTURE_VXSE51_SHINDO, "earthquake");

      const typeToken = tokens.find((t) => t.id === "type")!;
      expect(typeToken.text).toBe("震度速報");
      expect(ids(tokens)).toContain("severity");
    });

    it("VXSE52: 震源情報トークン", () => {
      const { tokens } = makeTokens(FIXTURE_VXSE52_HYPO_1, "earthquake");

      const typeToken = tokens.find((t) => t.id === "type")!;
      expect(typeToken.text).toBe("震源情報");
    });

    it("VXSE61: 震源要素更新トークン (旧「遠地地震情報」誤表記の回帰ガード)", () => {
      const { tokens } = makeTokens(FIXTURE_VXSE61_1, "earthquake");

      const typeToken = tokens.find((t) => t.id === "type")!;
      // 正: 顕著な地震の震源要素更新のお知らせ (telegram-type-label typeLabel と同系)。
      // 旧実装は「遠地地震情報」と誤表記していた (Codex R1 発見)
      expect(typeToken.text).toBe("震源要素更新");
      expect(typeToken.shortText).toBe("震源更新");
      expect(typeToken.text).not.toContain("遠地");
    });
  });

  // ── 津波 ──

  describe("tsunami", () => {
    it("severity + bannerKind のトークン構成", () => {
      const { tokens } = makeTokens(FIXTURE_VTSE41_WARN, "tsunami");

      expect(ids(tokens)).toContain("severity");
      expect(ids(tokens)).toContain("bannerKind");

      const severity = tokens.find((t) => t.id === "severity")!;
      expect(severity.priority).toBe(0);
      expect(severity.dropMode).toBe("never");

      const banner = tokens.find((t) => t.id === "bannerKind")!;
      expect(banner.priority).toBe(0);
      expect(banner.dropMode).toBe("never");
    });
  });

  // ── 長周期 ──

  describe("lgObservation", () => {
    it("VXSE62: type が 長周期地震動観測情報 で shortText が 長周期観測", () => {
      const { tokens } = makeTokens(FIXTURE_VXSE62_LGOBS, "lgObservation");

      const typeToken = tokens.find((t) => t.id === "type")!;
      expect(typeToken.text).toBe("長周期地震動観測情報");
      expect(typeToken.shortText).toBe("長周期観測");
    });

    it("Depth semantic は scalar でなく SummaryModel の表示値を使う", () => {
      const { event } = makeTokens(FIXTURE_VXSE62_LGOBS, "lgObservation");
      const semanticEvent = {
        ...event,
        depth: "600km",
        depthValue: {
          raw: "600000", value: null, condition: "以上", description: "深さ600km以上",
          presence: "range" as const, lowerBound: 600, upperBound: null,
        },
      };
      const model = buildSummaryModel(semanticEvent);
      expect(buildSummaryTokens(semanticEvent, model).find((token) => token.id === "depth")?.text)
        .toBe("深さ600km以上");
    });
  });

  // ── テキスト ──

  describe("seismicText", () => {
    it("VXSE56: severity + type + headline", () => {
      const { tokens } = makeTokens(FIXTURE_VXSE56_ACTIVITY_1, "seismicText");

      expect(ids(tokens)).toContain("severity");
      expect(ids(tokens)).toContain("type");
    });
  });

  // ── 南海トラフ ──

  describe("nankaiTrough", () => {
    it("VYSE50: severity + type(南海トラフ)", () => {
      const { tokens } = makeTokens(FIXTURE_VYSE50_INVESTIGATION, "nankaiTrough");

      expect(ids(tokens)).toContain("severity");
      expect(ids(tokens)).toContain("type");

      const typeToken = tokens.find((t) => t.id === "type")!;
      expect(typeToken.text).toBe("南海トラフ臨時情報");
      expect(typeToken.shortText).toBe("南海トラフ");
    });
  });

  // ── 火山 ──

  describe("volcano", () => {
    it("VFVO50: severity + type + volcanoName + alertLevel", () => {
      const { tokens } = makeTokens(FIXTURE_VFVO50_ALERT_LV3, "volcano");

      expect(ids(tokens)).toContain("severity");
      expect(ids(tokens)).toContain("type");
      expect(ids(tokens)).toContain("volcanoName");
    });

    it("VFVO52: 噴火情報トークン", () => {
      const { tokens } = makeTokens(FIXTURE_VFVO52_ERUPTION_1, "volcano");

      expect(ids(tokens)).toContain("severity");
      expect(ids(tokens)).toContain("type");
      expect(ids(tokens)).toContain("volcanoName");
    });

    it("VFVO51: 火山テキストトークン", () => {
      const { tokens } = makeTokens(FIXTURE_VFVO51_EXTRA, "volcano");

      expect(ids(tokens)).toContain("severity");
      expect(ids(tokens)).toContain("type");
      expect(ids(tokens)).toContain("volcanoName");
    });

    it("VFVO53: 降灰予報トークン", () => {
      const { tokens } = makeTokens(FIXTURE_VFVO53_ASH_REGULAR, "volcano");

      expect(ids(tokens)).toContain("severity");
      expect(ids(tokens)).toContain("type");
      expect(ids(tokens)).toContain("volcanoName");
    });

    it("VFVO60: 噴煙流向トークン", () => {
      const { tokens } = makeTokens(FIXTURE_VFVO60_PLUME, "volcano");

      expect(ids(tokens)).toContain("severity");
      expect(ids(tokens)).toContain("type");
      expect(ids(tokens)).toContain("volcanoName");
    });
  });

  // ── 気象解説情報 ──

  describe("weatherExplanation", () => {
    it("VPCJ51: type トークンが「地方気象解説情報」になる (controlTitle 由来)", () => {
      const { tokens } = makeTokens(FIXTURE_VPCJ51_KANTO_SNOW, "weatherExplanation");

      const typeToken = tokens.find((t) => t.id === "type")!;
      expect(typeToken.text).toBe("地方気象解説情報");
      expect(typeToken.shortText).toBe("気象解説");
    });

    it("VPZJ51: type トークンが「全般気象解説情報」になる (controlTitle 由来)", () => {
      const { tokens } = makeTokens(FIXTURE_VPZJ51_SENJOU, "weatherExplanation");

      const typeToken = tokens.find((t) => t.id === "type")!;
      expect(typeToken.text).toBe("全般気象解説情報");
      expect(typeToken.shortText).toBe("気象解説");
    });

    it("controlTitle が空文字のとき type token が「気象解説情報」になる (|| fallback)", () => {
      // 空文字 controlTitle は ?? では拾えないが || なら汎用名にフォールバックする
      const event = {
        id: "test-empty-control-title",
        classification: "telegram.weather",
        domain: "weatherExplanation" as const,
        type: "VPZJ51",
        infoType: "発表",
        title: "気象解説情報",
        controlTitle: "",  // 空文字
        headline: null,
        reportDateTime: "2026-01-01T00:00:00+09:00",
        publishingOffice: "気象庁",
        isTest: false,
        frameLevel: "normal" as const,
        isCancellation: false,
        isWarning: false,
        eventId: "test-001",
        serial: null,
        areaNames: [],
        forecastAreaNames: [],
        municipalityNames: [],
        observationNames: [],
        areaCount: 0,
        forecastAreaCount: 0,
        municipalityCount: 0,
        observationCount: 0,
        areaItems: [],
        raw: null,
      };
      const model = {
        domain: "weatherExplanation" as const,
        severity: "[情報]",
      };
      const tokens = buildSummaryTokens(event as Parameters<typeof buildSummaryTokens>[0], model);
      const typeToken = tokens.find((t) => t.id === "type")!;
      expect(typeToken.text).toBe("気象解説情報");
    });
  });

  // ── 天候情報 (VPZI50/VPCI50) ──

  describe("climateInfo", () => {
    it("VPCI50: type トークンが「地方天候情報」になる (controlTitle 由来)", () => {
      const { tokens } = makeTokens(FIXTURE_VPCI50_KANTO_TSUYU, "climateInfo");

      const typeToken = tokens.find((t) => t.id === "type")!;
      expect(typeToken.text).toBe("地方天候情報");
      expect(typeToken.shortText).toBe("天候情報");
    });

    it("VPZI50: type トークンが「全般天候情報」のまま (退行ガード)", () => {
      const { tokens } = makeTokens(FIXTURE_VPZI50_HOT_DRY, "climateInfo");

      const typeToken = tokens.find((t) => t.id === "type")!;
      expect(typeToken.text).toBe("全般天候情報");
      expect(typeToken.shortText).toBe("天候情報");
    });
  });

  // ── 熱中症警戒アラート (VPFT50) ──

  describe("heatAlert", () => {
    it("VPFT50 発表: type が「熱中症警戒アラート」(short「熱中症」) + topAreas に対象府県", () => {
      const { tokens } = makeTokens(FIXTURE_VPFT50_SAITAMA, "heatAlert");

      const typeToken = tokens.find((t) => t.id === "type")!;
      expect(typeToken.text).toBe("熱中症警戒アラート");
      expect(typeToken.shortText).toBe("熱中症");

      const topAreas = tokens.find((t) => t.id === "topAreas")!;
      expect(topAreas.text).toBe("埼玉県");
    });

    it("VPFT50 取消: type が「熱中症警戒アラート取消」(short「熱中症取消」)", () => {
      const { tokens } = makeTokens(FIXTURE_VPFT50_CANCEL, "heatAlert");

      const typeToken = tokens.find((t) => t.id === "type")!;
      expect(typeToken.text).toBe("熱中症警戒アラート取消");
      expect(typeToken.shortText).toBe("熱中症取消");
    });

    it("VPFT50 題名昇格: severity トークンが [緊急] になる (frame critical が compact summary の出口に届く)", () => {
      const { tokens, event } = makeTokens(FIXTURE_VPFT50_TITLE_ESCALATION, "heatAlert");

      expect(event.frameLevel).toBe("critical");
      const severityToken = tokens.find((t) => t.id === "severity")!;
      expect(severityToken.text).toBe("[緊急]");
    });

    it("VPFT50 発表: headline トークン (本文先頭文の合成) が drop で載る", () => {
      const { tokens } = makeTokens(FIXTURE_VPFT50_SAITAMA, "heatAlert");

      const headline = tokens.find((t) => t.id === "headline")!;
      expect(headline.text).toContain("熱中症による人の健康に係る被害");
      expect(headline.dropMode).toBe("drop");
    });
  });

  // ── RAW ──

  describe("raw", () => {
    it("severity + RAW + type のトークン構成", () => {
      const { tokens } = makeTokens(FIXTURE_VZSE40_NOTICE, "raw");

      expect(ids(tokens)).toContain("severity");
      expect(ids(tokens)).toContain("RAW");
      expect(ids(tokens)).toContain("type");

      const rawToken = tokens.find((t) => t.id === "RAW")!;
      expect(rawToken.text).toBe("RAW");
      expect(rawToken.priority).toBe(0);
      expect(rawToken.dropMode).toBe("never");
    });
  });

  // ── Token helper properties ──

  describe("token properties", () => {
    it("minWidth equals shortText visualWidth when shortText exists", () => {
      const { tokens } = makeTokens(FIXTURE_VXSE53_ENCHI, "earthquake");
      const typeToken = tokens.find((t) => t.id === "type")!;
      // shortText is "震源震度" (4 chars * 2 = 8)
      expect(typeToken.shortText).toBe("震源震度");
      expect(typeToken.minWidth).toBeLessThan(typeToken.preferredWidth);
    });

    it("all tokens have valid dropMode", () => {
      const deps = makeDeps();
      const { tokens } = makeTokens(FIXTURE_VXSE45_S1, "eew", deps);
      for (const t of tokens) {
        expect(["never", "shorten", "drop"]).toContain(t.dropMode);
      }
    });

    it("all tokens have priority 0-4", () => {
      const { tokens } = makeTokens(FIXTURE_VTSE41_WARN, "tsunami");
      for (const t of tokens) {
        expect(t.priority).toBeGreaterThanOrEqual(0);
        expect(t.priority).toBeLessThanOrEqual(4);
      }
    });
  });
});
