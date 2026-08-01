import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractSpecialValue,
  type SpecialValueDomain,
} from "../../../src/dmdata/special-value";
import {
  parseEarthquakeTelegram,
  parseEewTelegram,
  parseTsunamiTelegram,
} from "../../../src/dmdata/telegram-parser";
import { parseTyphoonAnalysis } from "../../../src/dmdata/typhoon-analysis-parser";
import { parseVolcanoTelegram } from "../../../src/dmdata/volcano-parser";
import { parseWeatherExplanation } from "../../../src/dmdata/weather-explanation-parser";
import {
  createXmlEvidenceParser,
  selectXml,
} from "../../helpers/xml-selector";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  readFixture,
} from "../../helpers/mock-message";
import {
  FIVE_STATE_SPECIAL_VALUE_MATRIX,
  type CorpusEvidence,
  type FiveStatePresence,
  type SpecialValueCell,
} from "./phase0-manifest";
import {
  LEGACY_INVALID_DATE_NOW_PATHS,
  PHASE1_COMMON_HELPERS,
  PHASE1_SHADOW_CLASSIFICATION_CONTRACT,
} from "./phase1-manifest";

const xmlParser = createXmlEvidenceParser();

function observedEvidence(): Array<{
  domain: SpecialValueDomain;
  presence: FiveStatePresence;
  evidence: CorpusEvidence;
}> {
  const matrix = FIVE_STATE_SPECIAL_VALUE_MATRIX as Record<
    SpecialValueDomain,
    Record<FiveStatePresence, SpecialValueCell>
  >;
  return Object.entries(matrix).flatMap(([domain, cells]) =>
    Object.entries(cells).flatMap(([presence, cell]) =>
      cell.evidence
        .filter((evidence) => evidence.observed)
        .map((evidence) => ({
          domain: domain as SpecialValueDomain,
          presence: presence as FiveStatePresence,
          evidence,
        }))
    )
  );
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function occurrenceCount(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

type LegacyComparison = keyof typeof PHASE1_SHADOW_CLASSIFICATION_CONTRACT;

interface LegacyRuntimeProjection {
  comparison: LegacyComparison;
  route: string;
  value: unknown;
  reason: string;
}

function legacyRuntimeProjection(
  domain: SpecialValueDomain,
  presence: FiveStatePresence,
  evidence: CorpusEvidence,
): LegacyRuntimeProjection {
  const message = createMockWsDataMessage(evidence.fixture);
  const key = `${domain}:${evidence.fixture}`;
  switch (key) {
    case "Magnitude:32-39_11_02_250206_VTSE41.xml": {
      const earthquake = parseTsunamiTelegram(message)?.earthquake;
      return {
        comparison: "preserved",
        route: "parseTsunamiTelegram().earthquake",
        value: {
          displayMagnitude: earthquake?.magnitude ?? null,
          magnitudeInfo: earthquake?.magnitudeInfo ?? null,
        },
        reason:
          "当該 fixture の raw・condition・description を magnitudeInfo が保持し、unknown/qualitative の根拠を再構成できる",
      };
    }
    case "Depth:36_01_10_240613_VXSE44.xml": {
      const accuracy = parseEewTelegram(message)?.accuracy;
      return {
        comparison: "collapsed",
        route: "parseEewTelegram().accuracy.depthRank",
        value: { depthRank: accuracy?.depthRank ?? null },
        reason:
          "本文を読まず rank=4 だけを返すため、unknown の NaN・通常数値・empty が同じ返却値へ潰れる",
      };
    }
    case "Intensity:32-35_01_02_240613_VXSE52.xml": {
      const intensity = parseEarthquakeTelegram(message)?.intensity;
      return {
        comparison: "preserved",
        route: "parseEarthquakeTelegram().intensity",
        value: intensity ?? null,
        reason:
          "当該 fixture の missing は carrier 欠落、Body/Intensity の self-closing empty は maxIntValue/maxLgIntValue の empty として区別する",
      };
    }
    case "Intensity:36_01_10_240613_VXSE44.xml": {
      const area = parseEewTelegram(message)?.forecastIntensity?.areas
        .find((item) => item.name === "福岡県福岡");
      return {
        comparison: "preserved",
        route: "parseEewTelegram().forecastIntensity.areas[福岡県福岡]",
        value: area ?? null,
        reason:
          "From=3・To=4 の canonical/raw bounds と condition・description を SpecialValue で保持し、旧 scalar adapter も維持する",
      };
    }
    case "TsunamiHeight:32-39_11_10_250206_VTSE51.xml": {
      const station = parseTsunamiTelegram(message)?.observations
        ?.find((item) => item.stationCode === "20102");
      return {
        comparison: "collapsed",
        route: "parseTsunamiTelegram().observations[stationCode=20102]",
        value: station == null
          ? null
          : {
              maxHeightValue: station.maxHeightValue,
              maxHeightValueCondition: station.maxHeightValueCondition,
            },
        reason: "欠落を null/空属性へ潰し、self-closing empty と区別できない",
      };
    }
    case "TsunamiHeight:32-39_11_03_250206_VTSE51.xml": {
      const forecast = parseTsunamiTelegram(message)?.forecast
        ?.find((item) => item.maxHeightDescription === "巨大");
      return {
        comparison: presence === "unknown" ? "collapsed" : "partially-preserved",
        route: "parseTsunamiTelegram().forecast[maxHeightDescription=巨大]",
        value: forecast == null
          ? null
          : { maxHeightDescription: forecast.maxHeightDescription },
        reason: presence === "unknown"
          ? "condition=不明を失い description=巨大だけを返すため、observed unknown が qualitative と同じ返却値へ潰れる"
          : "observed qualitative の表示用「巨大」は区別して残るが、raw=NaN と condition=不明は失われる",
      };
    }
    case "TsunamiHeight:32-39_11_11_250206_VTSE41.xml": {
      const forecast = parseTsunamiTelegram(message)?.forecast
        ?.find((item) => item.maxHeightDescription === "１０ｍ超");
      return {
        comparison: "partially-preserved",
        route: "parseTsunamiTelegram().forecast[maxHeightDescription=１０ｍ超]",
        value: forecast == null
          ? null
          : { maxHeightDescription: forecast.maxHeightDescription },
        reason: "表示文は保持するが lowerBound=10 の構造は持たない",
      };
    }
    case "LgInt:36_01_10_240613_VXSE44.xml": {
      const forecast = parseEewTelegram(message)?.forecastIntensity;
      return {
        comparison: "preserved",
        route: "parseEewTelegram().forecastIntensity.maxLgIntValue",
        value: {
          maxLgInt: forecast?.maxLgInt ?? null,
          maxLgIntValue: forecast?.maxLgIntValue ?? null,
        },
        reason:
          "ForecastLgInt の missing を maxLgIntValue.presence=missing として保持し、self-closing empty と区別する",
      };
    }
    case "LgInt:37_01_02_240613_VXSE43.xml": {
      const forecast = parseEewTelegram(message)?.forecastIntensity;
      return {
        comparison: "preserved",
        route: "parseEewTelegram().forecastIntensity.maxLgIntValue",
        value: {
          maxLgInt: forecast?.maxLgInt ?? null,
          maxLgIntValue: forecast?.maxLgIntValue ?? null,
        },
        reason: "From=To=2 の canonical value と raw bounds を maxLgIntValue に保持する",
      };
    }
    case "WindSpeed:83_02_02_250630_VPZJ51.xml": {
      const parsed = parseWeatherExplanation(message);
      const values = parsed?.forecast?.series.flatMap((series) =>
        series.metrics.flatMap((metric) =>
          metric.locals.flatMap((local) =>
            local.phases.flatMap((phase) => phase.values)
          )
        )
      ) ?? [];
      const value = values.find((item) =>
        item.subType === "最大風速" && item.condition === "値なし"
      );
      return {
        comparison: "preserved",
        route: "parseWeatherExplanation().forecast.metrics.values",
        value: value ?? null,
        reason: "raw empty・condition・description・unit・value null を既存 DTO が保持済み",
      };
    }
    case "WindSpeed:10_05_01_200826_VPTW60.xml": {
      const target = parseTyphoonAnalysis(message)?.frames
        .find((frame) => frame.label === "予報　１２０時間後");
      return {
        comparison: "collapsed",
        route: "parseTyphoonAnalysis().frames[予報 120時間後].wind.maxWindMs",
        value: { maxWindMs: target?.wind?.maxWindMs ?? null },
        reason: "condition=なしを失い、raw 0 を通常の数値0として返す",
      };
    }
    case "WindSpeed:telegram-foundation/weathercw-10_03_01_171016_VPTW60-wind-range.xml": {
      const parsed = parseTyphoonAnalysis(message);
      return {
        comparison: "unproven",
        route: "parseTyphoonAnalysis()",
        value: parsed,
        reason: "Phase 0 fixture は selector 証拠だけの抜粋で完全な Report ではなく runtime parser 比較不能",
      };
    }
    case "MovementSpeed:10_04_03_170913_VPTW60.xml": {
      const target = parseTyphoonAnalysis(message)?.frames
        .find((frame) => frame.label === "予報　６時間後");
      return {
        comparison: "collapsed",
        route: "parseTyphoonAnalysis().frames[予報 6時間後].center.moveSpeedKmh",
        value: { moveSpeedKmh: target?.center.moveSpeedKmh ?? null },
        reason: "condition=ゆっくり と description を失い null に縮約する",
      };
    }
    case "PlumeHeight:67_01_01_140927_VFVO56.xml": {
      const parsed = parseVolcanoTelegram(message);
      return {
        comparison: "collapsed",
        route: "parseVolcanoTelegram().plumeHeight/plumeHeightUnknown",
        value: parsed?.kind === "eruption"
          ? {
              plumeHeight: parsed.plumeHeight,
              plumeHeightUnknown: parsed.plumeHeightUnknown,
            }
          : null,
        reason: "欠落を null/false に縮約し、明示 empty と区別できない",
      };
    }
    case "PlumeHeight:43_01_01_200522_VFVO52.xml": {
      const parsed = parseVolcanoTelegram(message);
      return {
        comparison: "partially-preserved",
        route: "parseVolcanoTelegram().plumeHeight/plumeHeightUnknown",
        value: parsed?.kind === "eruption"
          ? {
              plumeHeight: parsed.plumeHeight,
              plumeHeightUnknown: parsed.plumeHeightUnknown,
            }
          : null,
        reason: "unknown の意味は boolean に残るが raw・condition・description は失われる",
      };
    }
    default:
      return {
        comparison: "unproven",
        route: "no runtime projection registered",
        value: null,
        reason: `実 runtime 返却値への対応を未登録: ${key}`,
      };
  }
}

describe("telegram foundation Phase 1 shadow", () => {
  it("Phase 0 evidence を shadow parse し、同じ fixture の実 runtime parser 返却値と比較する", () => {
    const comparisons = observedEvidence().map(({ domain, presence, evidence }) => {
      const expected = evidence.expected;
      expect(expected).toBeDefined();
      const fixturePath = resolve("test/fixtures", evidence.fixture);
      expect(existsSync(fixturePath), fixturePath).toBe(true);
      const root = xmlParser.parse(readFileSync(fixturePath, "utf8")) as unknown;
      const node = selectXml(root, evidence.selector);
      const shadow = extractSpecialValue(domain, node);
      const legacy = legacyRuntimeProjection(domain, presence, evidence);

      const sameCanonicalBounds = (domain === "Intensity" || domain === "LgInt")
        && expected!.children?.From != null
        && expected!.children.From === expected!.children.To;
      if (sameCanonicalBounds) {
        expect(shadow.presence, `${domain}.${presence}: ${evidence.selector}`).toBe("value");
      } else {
        expect(shadow.presence, `${domain}.${presence}: ${evidence.selector}`)
          .toSatisfy((actual: string) => expected!.states.includes(actual as FiveStatePresence));
      }
      expect(shadow.raw).toBe(expected!.exists ? expected!.raw ?? "" : null);
      if (expected!.attributes?.condition != null) {
        expect(shadow.condition).toBe(expected!.attributes.condition);
      }
      if (expected!.attributes?.description != null) {
        expect(shadow.description).toBe(expected!.attributes.description);
      }

      return {
        domain,
        fixture: evidence.fixture,
        selector: evidence.selector,
        shadow,
        legacy,
      };
    });

    expect(comparisons).toMatchSnapshot();
  });

  it("manifest の統一基準で preserved / partially-preserved / collapsed / unproven に分類する", () => {
    expect(PHASE1_SHADOW_CLASSIFICATION_CONTRACT).toEqual({
      preserved:
        "旧返却型が observed state を他 state（特に missing/empty）と区別し、raw・属性・bounds を欠落なく保持する",
      "partially-preserved":
        "observed state の値または表示意味は他 state と区別して残るが、raw・属性・bounds の一部を失う",
      collapsed:
        "observed state が旧返却型で別 state と同じ表現へ潰れる。missing/empty の同一化や、本文を捨て同じ rank・属性・派生値だけを返す経路を含む",
      unproven:
        "完全な Report を既存 runtime parser に通せず、返却型との比較を実証できない",
    });
    const classifications = observedEvidence().map(({ domain, presence, evidence }) =>
      legacyRuntimeProjection(domain, presence, evidence).comparison
    );
    expect(new Set(classifications)).toEqual(new Set([
      "preserved",
      "partially-preserved",
      "collapsed",
      "unproven",
    ]));
    expect(classifications.filter((value) => value === "unproven")).toHaveLength(1);
  });

  it("parser は Depth rank の縮約を残すが Intensity/LgInt の missing/empty を区別する", () => {
    const depthUnknownXml = readFixture("36_01_10_240613_VXSE44.xml");
    const depthNumericXml = depthUnknownXml.replace(
      '<Depth rank="4">NaN</Depth>',
      '<Depth rank="4">40</Depth>',
    );
    const depthEmptyXml = depthUnknownXml.replace(
      '<Depth rank="4">NaN</Depth>',
      '<Depth rank="4"/>',
    );
    expect(depthNumericXml).not.toBe(depthUnknownXml);
    expect(depthEmptyXml).not.toBe(depthUnknownXml);
    for (const xml of [depthUnknownXml, depthNumericXml, depthEmptyXml]) {
      expect(parseEewTelegram(createMockWsDataMessageFromXml(
        xml,
        "VXSE44",
      ))?.accuracy?.depthRank).toBe(4);
    }

    const intensityMissingXml = readFixture("32-35_01_02_240613_VXSE52.xml");
    const intensityEmptyXml = intensityMissingXml.replace(
      "</Body>",
      "<Intensity/></Body>",
    );
    expect(intensityEmptyXml).not.toBe(intensityMissingXml);
    expect(parseEarthquakeTelegram(createMockWsDataMessageFromXml(
      intensityMissingXml,
      "VXSE52",
    ))?.intensity).toBeUndefined();
    expect(parseEarthquakeTelegram(createMockWsDataMessageFromXml(
      intensityEmptyXml,
      "VXSE52",
    ))?.intensity).toMatchObject({
      maxIntValue: { raw: "", presence: "empty" },
      maxLgIntValue: { raw: "", presence: "empty" },
      areas: [],
      municipalities: [],
    });

    const lgIntMissingXml = readFixture("36_01_10_240613_VXSE44.xml");
    const lgIntEmptyXml = lgIntMissingXml.replace(
      "<Forecast>",
      "<Forecast><ForecastLgInt/>",
    );
    expect(lgIntEmptyXml).not.toBe(lgIntMissingXml);
    expect(parseEewTelegram(createMockWsDataMessageFromXml(
      lgIntMissingXml,
      "VXSE44",
    ))?.forecastIntensity?.maxLgIntValue).toMatchObject({
      raw: null,
      presence: "missing",
    });
    const lgIntEmpty = parseEewTelegram(createMockWsDataMessageFromXml(
      lgIntEmptyXml,
      "VXSE44",
    ))?.forecastIntensity;
    expect(lgIntEmpty?.maxLgInt).toBeUndefined();
    expect(lgIntEmpty?.maxLgIntValue).toMatchObject({
      raw: "",
      presence: "empty",
    });
  });

  it("legacy invalid ReportDateTime → nowMs 昇格の全 call site を双方向で固定する", () => {
    const helper = LEGACY_INVALID_DATE_NOW_PATHS.helper;
    const helperSource = readFileSync(resolve(helper.sourceFile), "utf8");
    expect(helperSource).toContain(`function ${helper.symbol}(`);
    expect(helperSource).toContain(helper.fallbackNeedle);

    const actualCallers = sourceFiles(resolve("src"))
      .map((path) => ({
        sourceFile: relative(resolve("."), path).replaceAll("\\", "/"),
        callCount: occurrenceCount(readFileSync(path, "utf8"), `${helper.symbol}(`),
      }))
      .filter(({ sourceFile, callCount }) =>
        sourceFile !== helper.sourceFile && callCount > 0
      )
      .sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
    const expectedCallers = LEGACY_INVALID_DATE_NOW_PATHS.callers
      .map(({ sourceFile, callCount }) => ({ sourceFile, callCount }))
      .sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
    expect(actualCallers).toEqual(expectedCallers);
  });

  it("Phase 1 共通 helper は legacy revisionOf / Date.now を新規利用しない", () => {
    for (const sourceFile of PHASE1_COMMON_HELPERS) {
      const source = readFileSync(resolve(sourceFile), "utf8");
      expect(source).not.toContain("revisionOf");
      expect(source).not.toContain("Date.now(");
    }
  });
});
