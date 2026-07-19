import { describe, it, expect, vi } from "vitest";
import { processMessage, ProcessDeps } from "../../../../src/engine/presentation/processors/process-message";
import { EewTracker } from "../../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../../src/engine/eew/eew-logger";
import { TsunamiStateHolder } from "../../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../../src/engine/messages/volcano-state";
import { Vpws50StateHolder } from "../../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../../src/engine/messages/vpww56-state";
import { Vpwp50DetailCache } from "../../../../src/engine/messages/vpwp50-detail-cache";
import { TyphoonProbabilityStateHolder } from "../../../../src/engine/messages/typhoon-probability-state";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE45_S1,
  FIXTURE_VXSE43_WARNING_S1,
  FIXTURE_VTSE41_WARN,
  FIXTURE_VTSE41_CANCEL,
  FIXTURE_VPWS50_AGGREGATE,
  FIXTURE_VPCI50_KANTO_TSUYU,
  FIXTURE_VMCJ55_FUKUSHINDO,
  FIXTURE_VPFT50_SAITAMA,
} from "../../../helpers/mock-message";
import type { WsDataMessage } from "../../../../src/types";
import zlib from "node:zlib";

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
    promises: { ...actual.promises, appendFile: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock("../../../../src/engine/notification/sound-player", () => ({ playSound: vi.fn() }));

function makeDeps(): ProcessDeps {
  return {
    eewTracker: new EewTracker(),
    eewLogger: new EewEventLogger(),
    tsunamiState: new TsunamiStateHolder(),
    volcanoState: new VolcanoStateHolder(),
    vpws50State: new Vpws50StateHolder(),
    vpww56State: new Vpww56StateHolder(),
    vpwp50Cache: new Vpwp50DetailCache(),
    typhoonProbabilityState: new TyphoonProbabilityStateHolder(),
  };
}

function withWeatherIdentity(
  source: WsDataMessage,
  opts: { id: string; reportDateTime: string; serial: string; infoType: string },
): WsDataMessage {
  const xml = zlib.gunzipSync(Buffer.from(source.body, "base64")).toString("utf8")
    .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${opts.reportDateTime}</ReportDateTime>`)
    .replace(/<TargetDateTime>[^<]*<\/TargetDateTime>/, `<TargetDateTime>${opts.reportDateTime}</TargetDateTime>`)
    .replace(/<InfoType>[^<]*<\/InfoType>/, `<InfoType>${opts.infoType}</InfoType>`)
    .replace(/<Serial(?:\s*\/|>[^<]*<\/Serial)>/, `<Serial>${opts.serial}</Serial>`);
  return {
    ...source,
    id: opts.id,
    head: { ...source.head, time: opts.reportDateTime },
    xmlReport: source.xmlReport == null ? undefined : {
      ...source.xmlReport,
      head: {
        ...source.xmlReport.head,
        reportDateTime: opts.reportDateTime,
        targetDateTime: opts.reportDateTime,
        serial: opts.serial,
        infoType: opts.infoType,
      },
    },
    body: zlib.gzipSync(Buffer.from(xml, "utf8")).toString("base64"),
  };
}

describe("processMessage", () => {
  it("earthquake ルート → EarthquakeOutcome", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processMessage(msg, "earthquake", makeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("earthquake");
  });

  it("eew ルート → EewOutcome", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE45_S1);
    const outcome = processMessage(msg, "eew", makeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("eew");
  });

  it("eew 重複 → null", () => {
    const deps = makeDeps();
    const msg1 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    processMessage(msg1, "eew", deps);
    const msg2 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const outcome = processMessage(msg2, "eew", deps);
    expect(outcome).toBeNull();
  });

  it("津波の発表→取消→古い発表は null となり、表示・通知・統計へ流れない", () => {
    const deps = makeDeps();
    const warning = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
    const cancellation = createMockWsDataMessage(FIXTURE_VTSE41_CANCEL);

    expect(processMessage(warning, "tsunami", deps)?.domain).toBe("tsunami");
    expect(processMessage(cancellation, "tsunami", deps)?.domain).toBe("tsunami");

    // EEW の suppressed と同じ null 経路なので、棄却報は統計にも数えず、
    // notification / CLI display / display ingest / event 出力の入口をすべて閉じる。
    expect(processMessage(warning, "tsunami", deps)).toBeNull();
    expect(deps.tsunamiState.getLevel()).toBeNull();
    expect(deps.tsunamiState.getLastInfo()).toBeNull();
  });

  it("同時刻の津波重複報も null となり、現在状態を変更しない", () => {
    const deps = makeDeps();
    const warning = createMockWsDataMessage(FIXTURE_VTSE41_WARN);

    expect(processMessage(warning, "tsunami", deps)?.domain).toBe("tsunami");
    expect(processMessage(warning, "tsunami", deps)).toBeNull();
    expect(deps.tsunamiState.getLevel()).toBe("大津波警報");
  });

  it("VPWS50 の取消後に後着した古い発表は null となり、全出力の入口を閉じる", () => {
    const deps = makeDeps();
    const base = createMockWsDataMessage(FIXTURE_VPWS50_AGGREGATE);
    const currentTime = "2026-07-19T10:00:00+09:00";
    const warning = withWeatherIdentity(base, {
      id: "vpws-current",
      reportDateTime: currentTime,
      serial: "2",
      infoType: "発表",
    });
    const cancellation = withWeatherIdentity(base, {
      id: "vpws-cancel",
      reportDateTime: currentTime,
      serial: "2",
      infoType: "取消",
    });
    const oldWarning = withWeatherIdentity(base, {
      id: "vpws-old",
      reportDateTime: "2026-07-19T09:00:00+09:00",
      serial: "1",
      infoType: "発表",
    });

    expect(processMessage(warning, "weather", deps)?.domain).toBe("weather");
    expect(processMessage(cancellation, "weather", deps)?.domain).toBe("weather");
    expect(processMessage(oldWarning, "weather", deps)).toBeNull();
    expect(deps.vpws50State.getCurrentAreasForDisplay()).toBeUndefined();
  }, 15000); // VPWS50 集約 fixture のパース×3 が全体実行の負荷下で既定 5s を超えるため

  it("VPCI50 (telegram.weather) は climateInfo ルートで ClimateInfoOutcome になる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPCI50_KANTO_TSUYU);
    const outcome = processMessage(msg, "climateInfo", makeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("climateInfo");
    expect(outcome!.statsCategory).toBe("climateInfo");
    expect(outcome!.presentation.frameLevel).toBe("normal");
    expect(outcome!.presentation.soundLevel).toBe("normal");
  });

  it("VMCJ55 (telegram.weather) は weatherExplanation ルートで WeatherExplanationOutcome になる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VMCJ55_FUKUSHINDO);
    const outcome = processMessage(msg, "weatherExplanation", makeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("weatherExplanation");
    expect(outcome!.statsCategory).toBe("weatherExplanation");
    expect(outcome!.presentation.frameLevel).toBe("normal");
    expect(outcome!.presentation.soundLevel).toBe("normal");
  });

  it("VPFT50 (telegram.weather) は heatAlert ルートに分類され processor が動く", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA);
    const outcome = processMessage(msg, "heatAlert", makeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("heatAlert");
    expect(outcome!.statsCategory).toBe("heatAlert");
    expect(outcome!.presentation.frameLevel).toBe("warning");
    expect(outcome!.presentation.soundLevel).toBe("warning");
    expect(outcome!.presentation.notifyCategory).toBe("heatAlert");
  });

  it("unknown ルート → RawOutcome", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI, {
      classification: "unknown",
      head: { type: "ZZZZ99", author: "テスト", time: new Date().toISOString(), test: false, xml: true },
    });
    const outcome = processMessage(msg, "unknown", makeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("raw");
    expect(outcome!.statsCategory).toBe("other");
  });

  it("EEW パース失敗 → RawOutcome (表示するが統計には含めない)", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "eew.forecast",
      id: "bad-eew",
      passing: [],
      head: { type: "VXSE45", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid-xml",
    };
    const outcome = processMessage(msg, "eew", makeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("raw");
    expect(outcome!.statsCategory).toBe("eew");
    expect(outcome!.stats.shouldRecord).toBe(false);
  });

  it("非 EEW パース失敗 → RawOutcome (元カテゴリ保持)", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "telegram.earthquake",
      id: "bad-eq",
      passing: [],
      head: { type: "VXSE53", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid",
    };
    const outcome = processMessage(msg, "earthquake", makeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("raw");
    expect(outcome!.statsCategory).toBe("earthquake");
  });
});
