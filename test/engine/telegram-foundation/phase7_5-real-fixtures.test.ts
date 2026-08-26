import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSpecialValue } from "../../../src/dmdata/special-value";
import { parseEarthquakeTelegram } from "../../../src/dmdata/telegram-parser";
import { createMockWsDataMessage, readFixture } from "../../helpers/mock-message";
import { createXmlEvidenceParser, selectXml, xmlText } from "../../helpers/xml-selector";
import {
  INTENSITY_CONDITION_SYNTHETIC_FIXTURE_PROVENANCE,
  KUMAMOTO_0728_REAL_FIXTURE_PROVENANCE,
} from "./phase0-manifest";

const CORPUS_ROOT = resolve(__dirname, "../../../corpus-kumamoto-0728");
const corpusByteEqualityTest = existsSync(CORPUS_ROOT) ? it : it.skip;
const corpusIndexValidationTest = existsSync(CORPUS_ROOT) ? it : it.skip;
const xmlParser = createXmlEvidenceParser();
const REAL_SPECIAL_VALUE = "震度５弱以上未入電";

interface CorpusIndexEntry {
  file: string;
  originalId: string;
}

function readCorpusIndex(): CorpusIndexEntry[] {
  return readFileSync(resolve(CORPUS_ROOT, "index.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed == null) {
        throw new Error("invalid Kumamoto corpus index entry");
      }
      const { file, originalId } = parsed as Record<string, unknown>;
      if (typeof file !== "string" || typeof originalId !== "string") {
        throw new Error("Kumamoto corpus index entry lacks file or originalId");
      }
      return { file, originalId };
    });
}

function findXmlElementWithText(node: unknown, name: string, text: string): unknown | undefined {
  if (Array.isArray(node)) {
    return node.map((item) => findXmlElementWithText(item, name, text)).find((item) => item != null);
  }
  if (typeof node !== "object" || node == null) return undefined;
  for (const [key, value] of Object.entries(node)) {
    if (key === name && xmlText(value) === text) return value;
    const found = findXmlElementWithText(value, name, text);
    if (found != null) return found;
  }
  return undefined;
}

describe("§7.5 unit 1: Kumamoto 2026-07-28 real fixtures", () => {
  it("provenance table は dmdata originalId・eventId・採取日・SHA-256 を8通分固定する", () => {
    expect(KUMAMOTO_0728_REAL_FIXTURE_PROVENANCE).toHaveLength(8);
    for (const provenance of KUMAMOTO_0728_REAL_FIXTURE_PROVENANCE) {
      expect(provenance.corpusPath.startsWith("corpus-kumamoto-0728/")).toBe(true);
      expect(provenance.dmdataOriginalId).toMatch(/^[0-9a-f]{96}$/);
      expect(provenance.eventId).toBe("20260728162718");
      expect(provenance.acquiredDate).toBe("2026-08-26");
      expect(provenance.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(resolve(__dirname, "../../fixtures", provenance.fixture))).toBe(true);
    }
  });

  it("tracked 8 fixture の SHA-256 は manifest と常に一致する", () => {
    for (const provenance of KUMAMOTO_0728_REAL_FIXTURE_PROVENANCE) {
      const fixture = readFileSync(resolve(__dirname, "../../fixtures", provenance.fixture));
      expect(createHash("sha256").update(fixture).digest("hex")).toBe(provenance.sha256);
    }
  });

  corpusByteEqualityTest("持込済み8 fixture は corpus 原本と byte equality を持つ", () => {
    for (const provenance of KUMAMOTO_0728_REAL_FIXTURE_PROVENANCE) {
      const fixture = readFileSync(resolve(__dirname, "../../fixtures", provenance.fixture));
      const corpus = readFileSync(resolve(__dirname, "../../../", provenance.corpusPath));
      expect(fixture, provenance.fixture).toEqual(corpus);
    }
  });

  corpusIndexValidationTest("corpus index の8 originalId は manifest と一致する", () => {
    const indexEntries = readCorpusIndex();
    expect(indexEntries).toHaveLength(8);
    const originalIdsByFile = new Map(
      indexEntries.map(({ file, originalId }) => [file, originalId]),
    );
    expect(originalIdsByFile.size).toBe(8);
    for (const provenance of KUMAMOTO_0728_REAL_FIXTURE_PROVENANCE) {
      const corpusFile = provenance.corpusPath.replace("corpus-kumamoto-0728/", "");
      expect(originalIdsByFile.get(corpusFile)).toBe(provenance.dmdataOriginalId);
    }
  });

  it("実 VXSE53 2通は全角・震度前置の特殊値を Condition／Int／Name に各7箇所持つ", () => {
    const detailedFixtures = KUMAMOTO_0728_REAL_FIXTURE_PROVENANCE
      .filter(({ fixture }) => fixture.includes("_VXSE53_"));
    expect(detailedFixtures).toHaveLength(2);

    for (const provenance of detailedFixtures) {
      const xml = readFixture(provenance.fixture);
      expect(xml.match(new RegExp(REAL_SPECIAL_VALUE, "g"))).toHaveLength(7);
      expect(xml.match(/<Condition>震度５弱以上未入電<\/Condition>/g)).toHaveLength(2);
      expect(xml.match(/<Int>震度５弱以上未入電<\/Int>/g)).toHaveLength(4);
      expect(xml.match(/<Name>震度５弱以上未入電<\/Name>/g)).toHaveLength(1);
    }
  });

  // §7.5 単位2 で matcher 修正後、fails を外して通常 assertion に戻すこと。
  it("Condition／Int／Name の実表層を matcher が Intensity SpecialValue として分類する", () => {
    const fixture = KUMAMOTO_0728_REAL_FIXTURE_PROVENANCE
      .find(({ fixture: name }) => name.includes("_VXSE53_") && name.includes("99e82c812e72"));
    if (fixture == null) throw new Error("missing VXSE53 real fixture provenance");
    const parsed = xmlParser.parse(readFixture(fixture.fixture)) as unknown;
    const nodes = [
      findXmlElementWithText(parsed, "Name", REAL_SPECIAL_VALUE),
      selectXml(parsed, "Report/Body/Intensity/Observation/Pref/Area/City[Code=4344200]/Condition"),
      selectXml(parsed, "Report/Body/Intensity/Observation/Pref/Area/City[Code=4344200]/IntensityStation/Int"),
    ];

    for (const node of nodes) {
      expect(xmlText(node)).toBe(REAL_SPECIAL_VALUE);
      expect(extractSpecialValue("Intensity", node)).toMatchObject({
        raw: REAL_SPECIAL_VALUE,
        value: null,
        presence: "qualitative",
        lowerBound: "5-",
      });
    }
  });

  it("実 VXSE53 の City sibling Condition を municipality intensityValue へ保持する", () => {
    const fixture = KUMAMOTO_0728_REAL_FIXTURE_PROVENANCE
      .find(({ fixture: name }) => name.includes("_VXSE53_") && name.includes("99e82c812e72"));
    if (fixture == null) throw new Error("missing VXSE53 real fixture provenance");
    const parsed = parseEarthquakeTelegram(createMockWsDataMessage(fixture.fixture));
    expect(parsed).not.toBeNull();

    for (const [code, name] of [["4344200", "嘉島町"], ["4344400", "甲佐町"]] as const) {
      const city = parsed!.intensity!.municipalities.find((item) => item.code === code);
      expect(city).toMatchObject({
        name,
        code,
        intensity: "",
        intensityValue: {
          raw: "",
          value: null,
          condition: REAL_SPECIAL_VALUE,
          description: null,
          presence: "qualitative",
          lowerBound: "5-",
        },
      });
    }
  });

  it("synthetic 2 fixture は実 XML に無い単独 未入電の補完として明記する", () => {
    expect(INTENSITY_CONDITION_SYNTHETIC_FIXTURE_PROVENANCE).toMatchObject({
      source: "synthetic",
      confirmed: false,
      realCorpus: "dmdata GD earthquake event API 2026-08-26 / eventId 20260728162718",
      uncoveredShape: "単独「未入電」（実 VXSE53 は「震度５弱以上未入電」のみ）",
    });
  });
});
