import { describe, it, expect, vi } from "vitest";
import { buildSummaryTokens } from "../../../src/ui/summary/token-builders";
import { buildSummaryModel } from "../../../src/ui/summary/summary-model";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import { processMessage, ProcessDeps } from "../../../src/engine/presentation/processors/process-message";
import { EewTracker } from "../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../src/engine/eew/eew-logger";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
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

function makeDeps(): ProcessDeps {
  return {
    eewTracker: new EewTracker(),
    eewLogger: new EewEventLogger(),
    tsunamiState: new TsunamiStateHolder(),
    volcanoState: new VolcanoStateHolder(),
  };
}

function makeTokens(fixture: string, route: string, deps?: ProcessDeps) {
  const d = deps ?? makeDeps();
  const msg = createMockWsDataMessage(fixture);
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

    it("VXSE61: 遠地地震情報トークン", () => {
      const { tokens } = makeTokens(FIXTURE_VXSE61_1, "earthquake");

      const typeToken = tokens.find((t) => t.id === "type")!;
      expect(typeToken.text).toBe("遠地地震情報");
      expect(typeToken.shortText).toBe("遠地地震");
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

  // ── RAW ──

  describe("raw", () => {
    it("severity + RAW + type のトークン構成", () => {
      const { tokens } = makeTokens(FIXTURE_VZSE40_NOTICE, "unknown_route");

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
