import { describe, expect, it } from "vitest";
import { createMockWsDataMessage, FIXTURE_VPWW56_DOSHA } from "../../helpers/mock-message";
import { parseWeatherWarning } from "../../../src/dmdata/weather-parser";
import {
  VPWW56_MAX_SUBJECTS,
  Vpww56StateHolder,
  vpww56StateSubjectKey,
} from "../../../src/engine/messages/vpww56-state";

function baseInfo() {
  const info = parseWeatherWarning(createMockWsDataMessage(FIXTURE_VPWW56_DOSHA));
  expect(info).not.toBeNull();
  return info!;
}

describe("Vpww56StateHolder mutation 境界", () => {
  it("官署欠落は durable subject に昇格しない", () => {
    expect(vpww56StateSubjectKey("VPWW56", "")).toBeNull();
    const holder = new Vpww56StateHolder();
    holder.update({ ...baseInfo(), publishingOffice: "" });
    expect(holder.getCurrentAreasForDisplay()).toBeUndefined();
  });

  it("clearSubject は指定した官署×type だけを削除する", () => {
    const holder = new Vpww56StateHolder();
    const first = { ...baseInfo(), publishingOffice: "稚内地方気象台" };
    const second = { ...baseInfo(), publishingOffice: "旭川地方気象台" };
    holder.applyAccepted(first, vpww56StateSubjectKey(first.type, first.publishingOffice)!);
    holder.applyAccepted(second, vpww56StateSubjectKey(second.type, second.publishingOffice)!);
    holder.clearSubject(vpww56StateSubjectKey(first.type, first.publishingOffice)!);
    expect(holder.activeSubjectKeys()).toEqual(["weather:VPWW56:旭川地方気象台"]);
  });

  it("可変 subject は gate と同じ上限で最終受理順に compact する", () => {
    const holder = new Vpww56StateHolder();
    for (let index = 0; index <= VPWW56_MAX_SUBJECTS; index++) {
      const info = { ...baseInfo(), publishingOffice: `office-${index}` };
      holder.applyAccepted(info, vpww56StateSubjectKey(info.type, info.publishingOffice)!);
    }
    expect(holder.trackedStreamCount()).toBe(VPWW56_MAX_SUBJECTS);
    expect(holder.activeSubjectKeys()).not.toContain("weather:VPWW56:office-0");
    expect(holder.activeSubjectKeys()).toContain(`weather:VPWW56:office-${VPWW56_MAX_SUBJECTS}`);
  });
});
