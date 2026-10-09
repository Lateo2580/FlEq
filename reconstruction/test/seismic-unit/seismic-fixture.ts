import { readFileSync } from "node:fs";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, PersistenceStatus } from "../../contracts/p2-shared-runtime.types";
import type { SeismicUnitState, SeismicUnitStep } from "../../contracts/p3-seismic-unit.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { emptyDaily, reduceSeismicUnit } from "../../src/units/seismic/seismic-unit";
import manifest from "../../tools/corpus/manifest.json";

// P3-UNIT-Q-001 の試験の共通部（Q-LIMIT の境界入力は fixture を焼かずに試験内で作る、T05）。

const saved: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null,
  savedAckAt: null, dirtySince: null };

function emptyState(): SeismicUnitState {
  return { schemaVersion: "p3-seismic-unit-v1", contentRevision: 0, earthquakes: [], longPeriods: [], daily: emptyDaily, intents: [],
    persistence: saved };
}
function clock(wallTimeMs: number, monotonicMs = 0): ClockReading {
  return { wallTimeMs, monotonicMs };
}

let sequence = 0;
function decodeXml(xml: string, headType: string, inputId = `input-${++sequence}`, origin: "replay" | "recovery" = "replay"): DecodedMaterial {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: 0, origin, kind: "replay", headType, body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
function fixtureXml(file: string): string {
  return readFileSync(file.startsWith("test/") ? file : `test/fixtures/${file}.xml`, "utf8");
}
// file は test/fixtures の下の名前（拡張子なし）。headType は corpus manifest の transport から取る。
function decodeFixture(file: string, transform: (xml: string) => string = (xml) => xml, inputId?: string): DecodedMaterial {
  const path = file.startsWith("test/") ? file : `test/fixtures/${file}.xml`;
  const headType = manifest.fixtures.find((item) => item.path === path)?.transport.headType;
  if (headType == null) throw new Error(`${file} has no headType in the manifest`);
  return decodeXml(transform(fixtureXml(file)), headType, inputId ?? `${file.split("/").at(-1)}#${++sequence}`);
}
const replaceTag = (tag: string, value: string) => (xml: string) =>
  xml.replace(new RegExp(`<${tag}>[^<]*</${tag}>`), `<${tag}>${value}</${tag}>`);

function receive(state: SeismicUnitState, material: DecodedMaterial, at: ClockReading): SeismicUnitStep {
  return reduceSeismicUnit(state, { kind: "receive", material, clock: at });
}

// 合成の VXSE53。震度と時刻を指定する（T04・T07 の境界入力。形は 32-35_04_04 の Body と同じ）。
function vxse53(options: Readonly<{ eventId?: string; at: string; origin?: string; serial?: number; infoType?: "発表" | "訂正" | "取消";
  maxInt?: string; operation?: "通常" | "訓練" | "試験"; city?: string }>): string {
  const maxInt = options.maxInt ?? "4";
  const body = options.infoType === "取消" ? "<Text>先ほどの、震源・震度に関する情報を取り消します。</Text>"
    : `<Earthquake><OriginTime>${options.origin ?? options.at}</OriginTime><ArrivalTime>${options.origin ?? options.at}</ArrivalTime>`
      + "<Hypocenter><Area><Name>合成震央</Name><Code type=\"震央地名\">999</Code><jmx_eb:Coordinate description=\"北緯３５．０度　東経１３５．０度　深さ　１０ｋｍ\">"
      + "+35.0+135.0-10000/</jmx_eb:Coordinate></Area></Hypocenter><jmx_eb:Magnitude type=\"Mj\" description=\"Ｍ５．０\">5.0</jmx_eb:Magnitude>"
      + `</Earthquake><Intensity><Observation><MaxInt>${maxInt}</MaxInt><Pref><Name>合成県</Name><Code>99</Code><MaxInt>${maxInt}</MaxInt>`
      + `<Area><Name>合成地域</Name><Code>990</Code><MaxInt>${maxInt}</MaxInt>${options.city ?? ""}</Area></Pref></Observation></Intensity>`
      + "<Comments><ForecastComment codeType=\"固定付加文\"><Text>この地震による津波の心配はありません。</Text><Code>0215</Code></ForecastComment></Comments>";
  return `<?xml version="1.0" encoding="UTF-8"?><Report xmlns="http://xml.kishou.go.jp/jmaxml1/">`
    + `<Control><Title>震源・震度に関する情報</Title><DateTime>2099-01-01T00:00:00Z</DateTime><Status>${options.operation ?? "通常"}</Status>`
    + "<EditorialOffice>気象庁本庁</EditorialOffice><PublishingOffice>気象庁</PublishingOffice></Control>"
    + `<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>震源・震度情報</Title><ReportDateTime>${options.at}</ReportDateTime>`
    + `<TargetDateTime>${options.at}</TargetDateTime><EventID>${options.eventId ?? "20990101000000"}</EventID>`
    + `<InfoType>${options.infoType ?? "発表"}</InfoType><Serial>${options.serial ?? 1}</Serial><InfoKind>地震情報</InfoKind>`
    + "<InfoKindVersion>1.0_1</InfoKindVersion><Headline><Text>合成の報</Text></Headline></Head>"
    + `<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">${body}</Body></Report>`;
}

export { clock, decodeFixture, decodeXml, emptyState, fixtureXml, receive, replaceTag, vxse53 };
