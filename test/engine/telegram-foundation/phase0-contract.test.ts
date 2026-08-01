import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTsunamiTelegram } from "../../../src/dmdata/telegram-parser";
import type { PresentationDomain } from "../../../src/engine/presentation/types";
import { formatMagnitudeLabel } from "../../../src/utils/magnitude";
import {
  createMockWsDataMessage,
  FIXTURE_VTSE41_WARN,
} from "../../helpers/mock-message";
import {
  createXmlEvidenceParser,
  directXmlChildren,
  selectXml,
  xmlAttribute,
  xmlText,
} from "../../helpers/xml-selector";
import {
  CANCELLATION_CHARACTERIZATION,
  CANCELLATION_MUTATION_EVIDENCE,
  CANCELLATION_STATE_SCOPE,
  FIVE_STATE_SPECIAL_VALUE_MATRIX,
  FRAGMENT_MERGE_ALLOWLIST,
  INVALID_REPORT_DATETIME_FIXTURE_EXPECTATION,
  LEGACY_COUNTERPART_CHARACTERIZATION,
  ORDINARY_VALUE_EVIDENCE,
  PHASE0_ACCEPTANCE_CRITERIA,
  PHASE0_TIMING_CONTRACT,
  REPAIR_A_TO_C_BASELINES,
  STATE_HOLDER_CHARACTERIZATION,
  TELEGRAM_META_CHARACTERIZATION,
  WEATHER_CW_CORPUS_EVIDENCE,
  isFragmentMergeAllowed,
  type FiveStatePresence,
  type SpecialValueDomain,
} from "./phase0-manifest";

const xmlParser = createXmlEvidenceParser();

function classifyXmlEvidence(node: unknown | null): FiveStatePresence[] {
  if (node == null) return ["missing"];
  const states: FiveStatePresence[] = [];
  const raw = xmlText(node);
  const condition = xmlAttribute(node, "condition") ?? "";
  const description = xmlAttribute(node, "description") ?? "";
  const from = directXmlChildren(node, "From").map(xmlText).find((value) => value != null);
  const to = directXmlChildren(node, "To").map(xmlText).find((value) => value != null);
  if (raw == null && from == null && to == null) states.push("empty");
  if (raw?.toLowerCase() === "nan" || condition.includes("不明") || condition.includes("不詳")) {
    states.push("unknown");
  }
  if (
    condition === "以上"
    || !description.includes("巨大地震") && /超|未満|以上|以下/.test(description)
    || from != null && to != null
  ) states.push("range");
  if (
    condition === "なし"
    || condition === "ゆっくり"
    || /巨大|高い|巨大地震/.test(description)
  ) states.push("qualitative");
  return states;
}

const PRESENTATION_DOMAINS = [
  "eew",
  "earthquake",
  "seismicText",
  "lgObservation",
  "tsunami",
  "volcano",
  "nankaiTrough",
  "weather",
  "tornado",
  "briefing",
  "earlyWeather",
  "weatherWarningTimeseries",
  "climateInfo",
  "weatherExplanation",
  "heatAlert",
  "typhoonAnalysis",
  "typhoonProbability",
  "floodForecast",
  "raw",
] as const satisfies readonly PresentationDomain[];

const SPECIAL_VALUE_DOMAINS = [
  "Magnitude",
  "Depth",
  "Intensity",
  "TsunamiHeight",
  "LgInt",
  "Pressure",
  "WindSpeed",
  "MovementSpeed",
  "PlumeHeight",
] as const satisfies readonly SpecialValueDomain[];

const FIVE_SPECIAL_STATES = [
  "missing",
  "empty",
  "unknown",
  "qualitative",
  "range",
] as const satisfies readonly FiveStatePresence[];

describe("telegram foundation Phase 0 contract", () => {
  it("U1 の Holdback 60秒・相関窓前後5分・保持11分を test constant として固定する", () => {
    expect(PHASE0_TIMING_CONTRACT).toEqual({
      legacySourceHoldbackMs: 60_000,
      correlationWindowBeforeMs: 300_000,
      correlationWindowAfterMs: 300_000,
      correlationRetentionMs: 660_000,
      futureReportDateTimeSkewMs: 900_000,
    });
    expect(PHASE0_ACCEPTANCE_CRITERIA.U1).toMatchObject({
      sourceHoldbackMs: 60_000,
      windowBeforeMs: 300_000,
      windowAfterMs: 300_000,
      retentionMs: 660_000,
    });
  });

  it("U1〜U5 の acceptance criteria を固定する", () => {
    expect(PHASE0_ACCEPTANCE_CRITERIA).toMatchInlineSnapshot(`
      {
        "U1": {
          "decision": "legacyCounterpartCorrelation",
          "lateCounterpartBehavior": "replaceActiveWithCanonicalWithoutTtlExtension",
          "retentionMs": 660000,
          "sourceHoldbackMs": 60000,
          "timeoutBehavior": "failOpen",
          "windowAfterMs": 300000,
          "windowBeforeMs": 300000,
        },
        "U2": {
          "ambiguous": "displayWithoutNotification",
          "decision": "unmatchedLegacyNotification",
          "display": "allAccepted",
          "evaluatedBefore": "U5",
          "notify": "codeConfirmedHighSeverityOnly",
          "qualifier": "対応電文未確認",
        },
        "U3": {
          "decision": "invalidReportDateTime",
          "durable": false,
          "excludedSurfaces": [
            "normalTicker",
            "card",
            "map",
            "activeState",
            "notification",
            "sound",
          ],
          "reportDateTimeFallback": "none",
          "transientSurfaces": [
            "cli",
            "diagnosticTicker",
          ],
        },
        "U4": {
          "decision": "mapSpecialValueBadge",
          "empty": {
            "badge": "∅",
            "color": "neutral",
          },
          "exact": {
            "badge": null,
            "color": "normal",
          },
          "intensityLowerBound": {
            "badge": "≥",
            "color": "intensity5Lower",
            "raw": "5弱以上未入電",
          },
          "lowerBound": {
            "badge": "≥",
            "color": "safetyRank",
          },
          "missing": {
            "badge": null,
            "color": "notRendered",
          },
          "range": {
            "badge": "↔",
            "color": "safetyUpperRank",
          },
          "unknown": {
            "badge": "?",
            "color": "unknown",
          },
        },
        "U5": {
          "correctionQualifier": "訂正",
          "decision": "acceptedSameRevisionCorrectionNotification",
          "firstReportSound": "doNotReplay",
          "notifyAcceptedEligibleCorrection": true,
          "notifyWithoutPresentationDiff": true,
          "semanticDuplicate": "rejectBeforeNotification",
          "staleOrInvalid": "noNotification",
          "transportDuplicate": "rejectBeforeNotification",
        },
      }
    `);
  });

  it("対象9 domain それぞれに five-state 対応表と通常値根拠がある", () => {
    expect(Object.keys(FIVE_STATE_SPECIAL_VALUE_MATRIX).sort())
      .toEqual([...SPECIAL_VALUE_DOMAINS].sort());
    expect(Object.keys(ORDINARY_VALUE_EVIDENCE).sort())
      .toEqual([...SPECIAL_VALUE_DOMAINS].sort());

    for (const domain of SPECIAL_VALUE_DOMAINS) {
      const matrix = FIVE_STATE_SPECIAL_VALUE_MATRIX[domain];
      expect(Object.keys(matrix).sort()).toEqual([...FIVE_SPECIAL_STATES].sort());
      for (const presence of FIVE_SPECIAL_STATES) {
        const cell = matrix[presence];
        expect(cell.expectedPresence).toBe(presence);
        expect(cell.evidence.length).toBeGreaterThan(0);
        for (const evidence of cell.evidence) {
          expect(evidence.note).not.toBe("");
          if (!evidence.observed) {
            expect(evidence.source).toBe("synthetic");
            expect(evidence.expected).toBeUndefined();
            continue;
          }
          const expected = evidence.expected;
          expect(expected, `${domain}.${presence}: ${evidence.selector}`).toBeDefined();
          const fixturePath = resolve("test/fixtures", evidence.fixture);
          expect(existsSync(fixturePath), fixturePath).toBe(true);
          const parsed = xmlParser.parse(readFileSync(fixturePath, "utf8")) as unknown;
          const selected = selectXml(parsed, evidence.selector);
          expect(selected != null, `${domain}.${presence}: ${evidence.selector}`)
            .toBe(expected!.exists);
          if (!expected!.exists) {
            expect(classifyXmlEvidence(selected)).toContain(presence);
            continue;
          }
          if ("raw" in expected! && expected!.raw != null) {
            expect(xmlText(selected)).toBe(expected!.raw);
          }
          const expectedAttributes = "attributes" in expected! ? expected!.attributes : {};
          for (const [name, value] of Object.entries(expectedAttributes ?? {})) {
            expect(xmlAttribute(selected, name), `${evidence.selector}@${name}`).toBe(value);
          }
          const expectedChildren = "children" in expected! ? expected!.children : {};
          for (const [name, value] of Object.entries(expectedChildren ?? {})) {
            const actual = directXmlChildren(selected, name).map(xmlText).find((item) => item != null);
            expect(actual, `${evidence.selector}/${name}`).toBe(value);
          }
          const classified = classifyXmlEvidence(selected);
          expect(classified, `${domain}.${presence}: ${evidence.selector}`).toEqual(expected!.states);
          expect(classified).toContain(presence);
          if (evidence.source === "weathercw") {
            expect(evidence.upstreamFixture).toBe("10_03_01_171016_VPTW60.xml");
            expect(evidence.upstreamSha256).toMatch(/^[0-9a-f]{64}$/);
          }
        }
      }
    }
  });

  it("InfoType・Status・serial・ReportDateTime を repo と WeatherCW の実在／未確認を区別して固定する", () => {
    expect(new Set(TELEGRAM_META_CHARACTERIZATION.map((row) => row.field))).toEqual(
      new Set(["InfoType", "Status", "Serial", "ReportDateTime"]),
    );
    expect(TELEGRAM_META_CHARACTERIZATION.some((row) => row.source === "repo" && row.observed)).toBe(true);
    expect(TELEGRAM_META_CHARACTERIZATION.some((row) => row.source === "weathercw" && row.observed)).toBe(true);
    expect(TELEGRAM_META_CHARACTERIZATION).toContainEqual(
      expect.objectContaining({ field: "InfoType", value: "訂正", source: "weathercw", observed: true }),
    );
    expect(TELEGRAM_META_CHARACTERIZATION).toContainEqual(
      expect.objectContaining({ field: "Serial", value: "001", source: "repo", observed: true }),
    );
    expect(TELEGRAM_META_CHARACTERIZATION).toContainEqual(
      expect.objectContaining({ field: "ReportDateTime", value: "not-a-date", source: "synthetic", observed: false }),
    );
    expect(WEATHER_CW_CORPUS_EVIDENCE.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
  });

  it("counterpart は source/counterpart 両側 fixture がある pair だけを記録する", () => {
    expect(LEGACY_COUNTERPART_CHARACTERIZATION.map((entry) => entry.sourceType))
      .toEqual(["VPOA50", "VPNO50", "VXWW50"]);
    for (const entry of LEGACY_COUNTERPART_CHARACTERIZATION) {
      expect(entry.counterpartTypes.length).toBe(entry.counterpartFixtures.length);
      if (entry.counterpartTypes.length > 0) {
        expect(entry.sourceFixtures.length).toBeGreaterThan(0);
        expect(entry.counterpartFixtures.every((fixtures) => fixtures.length > 0)).toBe(true);
      } else {
        expect(entry.status).toBe("unconfirmed");
      }
    }
  });

  it("全 Presentation domain の cancellation behavior を snapshot 固定する", () => {
    expect(Object.keys(CANCELLATION_CHARACTERIZATION).sort())
      .toEqual([...PRESENTATION_DOMAINS].sort());
    const snapshot = PRESENTATION_DOMAINS.flatMap((domain) =>
      CANCELLATION_CHARACTERIZATION[domain].map((entry) =>
        `${domain}|${entry.family}|${entry.targetPolicy}|${entry.stateOwners.join(",")}`
      )
    );
    expect(snapshot).toMatchInlineSnapshot(`
      [
        "eew|eew|markCancelled|EewTracker,DisplayStateStore",
        "earthquake|earthquake|markCancelled|DisplayStateStore,QuakeExtremeStore",
        "seismicText|seismicText|markCancelled|",
        "lgObservation|lgObservation|markCancelled|StandbyStateStore",
        "tsunami|tsunami|clearCurrent|TsunamiStateHolder,DisplayStateStore",
        "volcano|volcanoAlert|clearCurrent|VolcanoStateHolder,StandbyStateStore",
        "volcano|volcanoEruption|clearCurrent|VolcanoStateHolder,StandbyStateStore",
        "volcano|volcanoAshfall|markCancelled|VolcanoVfvo53Aggregator",
        "volcano|volcanoTransient|markCancelled|",
        "nankaiTrough|nankaiTrough|clearCurrent|StandbyStateStore",
        "weather|VPWS50|restorePrevious|Vpws50StateHolder,StandbyStateStore,WeatherPromotionStore",
        "weather|VPWW56|clearCurrent|Vpww56StateHolder,StandbyStateStore,WeatherPromotionStore",
        "weather|VPWW55-61-except56|markCancelled|",
        "tornado|tornado|clearCurrent|StandbyStateStore",
        "briefing|briefing|markCancelled|",
        "earlyWeather|earlyWeather|markCancelled|",
        "weatherWarningTimeseries|weatherWarningTimeseries|clearCurrent|Vpwp50DetailCache",
        "climateInfo|climateInfo|markCancelled|",
        "weatherExplanation|weatherExplanation|markCancelled|",
        "heatAlert|heatAlert|clearCurrent|StandbyStateStore",
        "typhoonAnalysis|typhoonAnalysis|clearCurrent|StandbyStateStore",
        "typhoonProbability|typhoonProbability|clearCurrent|TyphoonProbabilityStateHolder",
        "floodForecast|floodForecast|clearCurrent|FloodForecastStateHolder,StandbyStateStore",
        "raw|raw|markCancelled|",
      ]
    `);
  });

  it("cancellation holder と実装 mutation evidence を双方向で一致させる", () => {
    const characterized = new Set(
      PRESENTATION_DOMAINS.flatMap((domain) =>
        CANCELLATION_CHARACTERIZATION[domain].flatMap((entry) =>
          entry.stateOwners.map((owner) => `${domain}|${entry.family}|${owner}`)
        )
      ),
    );
    const evidenced = new Set(
      CANCELLATION_MUTATION_EVIDENCE.map(({ domain, family, owner }) =>
        `${domain}|${family}|${owner}`
      ),
    );
    expect(characterized).toEqual(evidenced);

    const listedOwners = new Set(STATE_HOLDER_CHARACTERIZATION.map(({ owner }) => owner));
    for (const evidence of CANCELLATION_MUTATION_EVIDENCE) {
      expect(listedOwners.has(evidence.owner), `${evidence.domain}/${evidence.family}/${evidence.owner}`)
        .toBe(true);
      expect(evidence.behavior).not.toBe("");
      for (const source of evidence.sources) {
        const implementation = readFileSync(resolve(source.sourceFile), "utf8");
        for (const needle of source.needles) {
          expect(implementation, `${evidence.owner}: ${source.sourceFile}`).toContain(needle);
        }
      }
    }
    expect(CANCELLATION_STATE_SCOPE.excluded).toContain(
      "取消を特別扱いせず次回差分の比較元にする PresentationDiffStore",
    );
  });

  it("Presentation active lifecycle の state holder を source file・domain・取消責務付きで列挙する", () => {
    const referenced = new Set(
      Object.values(CANCELLATION_CHARACTERIZATION)
        .flat()
        .flatMap((entry) => entry.stateOwners),
    );
    for (const stateHolder of STATE_HOLDER_CHARACTERIZATION) {
      expect(existsSync(resolve(stateHolder.sourceFile))).toBe(true);
      expect(stateHolder.domains.length).toBeGreaterThan(0);
      expect(stateHolder.cancellationRole).not.toBe("");
    }
    expect([...referenced].every((owner) =>
      STATE_HOLDER_CHARACTERIZATION.some((stateHolder) => stateHolder.owner === owner)
    )).toBe(true);
    expect(STATE_HOLDER_CHARACTERIZATION.map((entry) => entry.owner)).toMatchInlineSnapshot(`
      [
        "DailyQuakeCounter",
        "DisplayStateStore",
        "EewTracker",
        "FloodForecastStateHolder",
        "PresentationDiffStore",
        "QuakeExtremeStore",
        "StandbyStateStore",
        "TsunamiStateHolder",
        "TyphoonProbabilityStateHolder",
        "VolcanoStateHolder",
        "VolcanoVfvo53Aggregator",
        "Vpwp50DetailCache",
        "Vpws50StateHolder",
        "Vpww56StateHolder",
        "WeatherPromotionStore",
      ]
    `);
  });

  it("fragment merge allowlist は VTSE51/52 だけで evidence 五要素と限界を持つ", () => {
    expect(Object.keys(FRAGMENT_MERGE_ALLOWLIST)).toEqual([
      "tsunamiObservation:VTSE51",
      "tsunamiObservation:VTSE52",
    ]);
    for (const entry of Object.values(FRAGMENT_MERGE_ALLOWLIST)) {
      expect(["VTSE51", "VTSE52"]).toContain(entry.headType);
      expect(entry.extractItems).not.toBe("");
      expect(entry.itemSubjectKey).not.toBe("");
      expect(entry.itemFingerprint).not.toBe("");
      expect(entry.fingerprintVersion).not.toBe("");
      expect(entry.fragmentEvidence.corpusFixtures.length).toBeGreaterThan(0);
      expect(entry.fragmentEvidence.regressionTests.length).toBeGreaterThan(0);
      expect(entry.fragmentEvidence.rationale).not.toBe("");
      expect(entry.fragmentEvidence.limits).toContain("synthetic regression");
      for (const fixture of entry.fragmentEvidence.corpusFixtures) {
        expect(existsSync(resolve("test/fixtures", fixture))).toBe(true);
      }
    }
    expect(isFragmentMergeAllowed("tsunamiObservation:VTSE51")).toBe(true);
    expect(isFragmentMergeAllowed("tsunamiObservation:VTSE52")).toBe(true);
    expect(isFragmentMergeAllowed("earthquake:VXSE51")).toBe(false);
    expect(isFragmentMergeAllowed("tsunamiObservation:VTSE41")).toBe(false);
  });

  it("invalid ReportDateTime fixture は now fallback せず診断 surface だけを期待する", () => {
    const fixture = readFileSync(
      resolve("test/fixtures", INVALID_REPORT_DATETIME_FIXTURE_EXPECTATION.fixture),
      "utf8",
    );
    expect(fixture).toContain("<ReportDateTime>not-a-date</ReportDateTime>");
    expect(fixture).toContain(`<EventID>${INVALID_REPORT_DATETIME_FIXTURE_EXPECTATION.eventId}</EventID>`);
    expect(INVALID_REPORT_DATETIME_FIXTURE_EXPECTATION).toEqual({
      fixture: "telegram-foundation/invalid-report-datetime.xml",
      transportHeadType: "VXSE51",
      eventId: "phase0-invalid-report-datetime",
      rawReportDateTime: "not-a-date",
      epochMs: null,
      valid: false,
      reason: "invalidFormat",
      diagnosticTextIncludes: [
        "VXSE51",
        "phase0-invalid-report-datetime",
        "not-a-date",
        "受信時刻",
        "日時不正",
      ],
      transientSurfaces: ["cli", "diagnosticTicker"],
      excludedSurfaces: ["normalTicker", "card", "map", "activeState", "notification", "sound"],
      durable: false,
    });
    expect(INVALID_REPORT_DATETIME_FIXTURE_EXPECTATION.diagnosticTextIncludes).toEqual(
      expect.arrayContaining([
        INVALID_REPORT_DATETIME_FIXTURE_EXPECTATION.transportHeadType,
        INVALID_REPORT_DATETIME_FIXTURE_EXPECTATION.eventId,
        INVALID_REPORT_DATETIME_FIXTURE_EXPECTATION.rawReportDateTime,
      ]),
    );
  });

  it("修正弾 A〜C の baseline test が実際の期待値を保持している", () => {
    expect(new Set(REPAIR_A_TO_C_BASELINES.map((entry) => entry.repair))).toEqual(new Set(["A", "B", "C"]));
    for (const baseline of REPAIR_A_TO_C_BASELINES) {
      const source = readFileSync(resolve(baseline.testFile), "utf8");
      for (const assertion of baseline.expectedAssertions) {
        expect(source, `${baseline.repair}: ${baseline.behavior}`).toContain(assertion);
      }
    }
  });

  it("修正弾 A の Magnitude baseline は raw を保持し、表示 helper が description を優先する", () => {
    const parsed = parseTsunamiTelegram(createMockWsDataMessage(FIXTURE_VTSE41_WARN));
    expect(parsed?.earthquake).toMatchObject({
      magnitude: "",
      magnitudeInfo: {
        value: "NaN",
        condition: "不明",
        description: "Ｍ８を超える巨大地震",
      },
    });
    expect(formatMagnitudeLabel(parsed!.earthquake!)).toBe("M8 を超える巨大地震");
    expect(formatMagnitudeLabel(parsed!.earthquake!)).not.toContain("NaN");
  });
});
