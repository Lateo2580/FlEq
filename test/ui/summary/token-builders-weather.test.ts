import { describe, it, expect } from "vitest";
import { buildSummaryTokens } from "../../../src/ui/summary/token-builders";
import { buildSummaryModel } from "../../../src/ui/summary/summary-model";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import { processMessage, ProcessDeps } from "../../../src/engine/presentation/processors/process-message";
import { EewTracker } from "../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../src/engine/eew/eew-logger";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { Vpwp50DetailCache } from "../../../src/engine/messages/vpwp50-detail-cache";
import { TyphoonProbabilityStateHolder } from "../../../src/engine/messages/typhoon-probability-state";
import { createMockWsDataMessage } from "../../helpers/mock-message";

function makeDeps(): ProcessDeps {
  return {
    eewTracker: new EewTracker(),
    eewLogger: new EewEventLogger(),
    tsunamiState: new TsunamiStateHolder(),
    volcanoState: new VolcanoStateHolder(),
    vpws50State: new Vpws50StateHolder(),
    vpwp50Cache: new Vpwp50DetailCache(),
    typhoonProbabilityState: new TyphoonProbabilityStateHolder(),
  };
}

function tokenTexts(fixture: string): string[] {
  const msg = createMockWsDataMessage(fixture);
  const outcome = processMessage(msg, "weather", makeDeps())!;
  expect(outcome).not.toBeNull();
  const event = toPresentationEvent(outcome);
  const model = buildSummaryModel(event);
  return buildSummaryTokens(event, model).map((t) => t.text);
}

describe("buildWeatherTokens 拡張 (VPWW55-61 compact)", () => {
  it("VPWW55 大雨警報 → tier prefix (☆) + L 表記が type トークンに出る", () => {
    const texts = tokenTexts("15_17_01_251222_VPWW55.xml");
    // 大雨警報 (Code 03) は officialL3 → ☆ + "L3 大雨警報"
    const joined = texts.join(" | ");
    expect(joined).toMatch(/[○△☆★]/);   // tier prefix が含まれる
    expect(joined).toMatch(/L[1-5] /);     // L 表記が含まれる
  });

  it("VPWW56 土砂災害 → ★ (L4) prefix が出る", () => {
    const joined = tokenTexts("15_16_01_241031_VPWW56.xml").join(" | ");
    // 土砂災害危険警報 (Code 49) は officialL4 → ★
    expect(joined).toMatch(/[★☆]/);
    expect(joined).toMatch(/L[1-5] /);
  });
});
