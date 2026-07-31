import { testTelegramMeta } from "../../../helpers/telegram-meta";
import { describe, it, expect, vi } from "vitest";
import { fromVolcanoOutcome } from "../../../../src/engine/presentation/events/from-volcano";
import { buildVolcanoOutcome } from "../../../../src/engine/presentation/processors/process-volcano";
import { parseVolcanoTelegram } from "../../../../src/dmdata/volcano-parser";
import { VolcanoStateHolder } from "../../../../src/engine/messages/volcano-state";
import { createMockWsDataMessage, FIXTURE_VFVO53_ASH_REGULAR, FIXTURE_VFVO54_ASH_RAPID } from "../../../helpers/mock-message";
import type { VolcanoBatchOutcome } from "../../../../src/engine/presentation/types";
import type { ParsedVolcanoAshfallInfo } from "../../../../src/types";
import { volcanoAshfallToText } from "../../../../src/engine/presentation/events/volcano-to-text";

vi.mock("../../../../src/engine/notification/sound-player", () => ({ playSound: vi.fn() }));

function ashfall(over: Partial<ParsedVolcanoAshfallInfo>): ParsedVolcanoAshfallInfo {
  return {
    meta: testTelegramMeta(false),
    domain: "volcano", kind: "ashfall", type: "VFVO53", subKind: "scheduled", infoType: "発表", title: "降灰予報",
    reportDateTime: "2026-07-10T12:00:00+09:00", eventDateTime: null, headline: null,
    publishingOffice: "気象庁", volcanoName: "桜島", volcanoCode: "506", coordinate: null,
    isTest: false, craterName: null, ashForecasts: [], plumeHeight: null, plumeDirection: null,
    bodyText: "降灰の本文", ...over,
  };
}

describe("from-volcano 本文配線", () => {
  it("単発火山電文は kind に応じて info.bodyText または合成文を event.bodyText に反映する", () => {
    const msg = createMockWsDataMessage(FIXTURE_VFVO54_ASH_RAPID);
    const info = parseVolcanoTelegram(msg)!;
    const outcome = buildVolcanoOutcome(msg, info, new VolcanoStateHolder());
    const event = fromVolcanoOutcome(outcome);
    const expected = info.kind === "ashfall" ? (volcanoAshfallToText(info) ?? info.bodyText) : event.bodyText;
    expect(event.bodyText).toBe(expected);
    expect(typeof event.bodyText).toBe("string");
  });

  it("降灰バッチは全火山ぶんの本文を fromVolcanoOutcome まで通して連結する (別火山・同一本文も両方残る)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR);
    const parsed = [
      ashfall({ volcanoName: "桜島", volcanoCode: "506", bodyText: "多量の降灰に注意。" }),
      ashfall({ volcanoName: "阿蘇山", volcanoCode: "503", bodyText: "多量の降灰に注意。" }),
    ];
    const outcome: VolcanoBatchOutcome = {
      domain: "volcano", msg, headType: msg.head.type, statsCategory: "volcano",
      parsed,
      sources: parsed.map((info) => ({ info, msg })),
      isBatch: true,
      volcanoPresentation: { frameLevel: "normal", soundLevel: "normal", summary: "降灰予報" },
      batchReportDateTime: "2026-07-10T12:00:00+09:00", batchIsTest: false,
      stats: { shouldRecord: false },
      presentation: { frameLevel: "normal", soundLevel: "normal", notifyCategory: "volcano" },
    };
    const event = fromVolcanoOutcome(outcome);
    expect(event.bodyText).toBe("【桜島】多量の降灰に注意。\n【阿蘇山】多量の降灰に注意。");
  });
});

describe("from-volcano 降灰文章化配線 (Spec A §3-3)", () => {
  const completePeriod = {
    startTime: "2021-05-17T15:00:00+09:00", endTime: "2021-05-17T18:00:00+09:00",
    areas: [{ name: "都城市", code: "4520200", ashCode: "70", ashName: "降灰", thickness: null, plumeDirection: "東", distanceKm: 100 }],
  };

  it("単発: 全 period 完備なら bodyText が合成文になる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VFVO54_ASH_RAPID);
    const info = parseVolcanoTelegram(msg)!;
    if (info.kind !== "ashfall") throw new Error("fixture が ashfall でない");
    info.ashForecasts = [completePeriod];
    const outcome = buildVolcanoOutcome(msg, info, new VolcanoStateHolder());
    const event = fromVolcanoOutcome(outcome);
    expect(event.bodyText).toBe(volcanoAshfallToText(info));
    expect(event.bodyText).toContain("15時から18時まで");
  });

  it("単発: 1 period でも不完全なら従来平文へ戻る", () => {
    const msg = createMockWsDataMessage(FIXTURE_VFVO54_ASH_RAPID);
    const info = parseVolcanoTelegram(msg)!;
    if (info.kind !== "ashfall") throw new Error("fixture が ashfall でない");
    info.ashForecasts = [{ startTime: "", endTime: "", areas: [] }];
    info.bodyText = "原文の注意事項";
    const outcome = buildVolcanoOutcome(msg, info, new VolcanoStateHolder());
    const event = fromVolcanoOutcome(outcome);
    expect(event.bodyText).toBe("原文の注意事項");
  });
});
