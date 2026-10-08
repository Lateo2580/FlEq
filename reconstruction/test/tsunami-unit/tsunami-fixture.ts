import { readFileSync } from "node:fs";

import type { DecodedMaterial, Operation } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, PersistenceStatus } from "../../contracts/p2-shared-runtime.types";
import type { TsunamiInput, TsunamiUnitState, TsunamiUnitStep } from "../../contracts/p3-tsunami-unit.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { reduceTsunamiUnit } from "../../src/units/tsunami/tsunami-unit";

// P3-TSUNAMI-UNIT-001 の試験の共通部（Q-LIMIT の境界入力は fixture を焼かずにここで作る、Q-C5-CORPUS (3)）。

const STATUS: Readonly<Record<Operation, string>> = { normal: "通常", training: "訓練", test: "試験" };
const saved: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null,
  savedAckAt: null, dirtySince: null };

function emptyState(): TsunamiUnitState {
  return { schemaVersion: "p3-tsunami-unit-v1", contentRevision: 0, forecasts: [], observations: [], intents: [], persistence: saved };
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
  return readFileSync(file.includes("/") ? file : `test/fixtures/${file}.xml`, "utf8");
}
function decodeFixture(file: string, headType: string, transform: (xml: string) => string = (xml) => xml): DecodedMaterial {
  return decodeXml(transform(fixtureXml(file)), headType, file.split("/").at(-1));
}

type Area = Readonly<{ code?: string; name: string; kind: string; kindName?: string }>;
const KIND_NAME: Readonly<Record<string, string>> = { "52": "大津波警報", "53": "大津波警報：発表", "51": "津波警報", "62": "津波注意報",
  "71": "津波予報（若干の海面変動）", "50": "警報解除", "60": "津波注意報解除", "00": "津波なし" };
// 合成の VTSE41。EventID・時刻・区域を指定する（O09 の入力の型、P3-C5-E01-SERIES.inputs）。
function vtse41(options: Readonly<{ eventId?: string; at: string; infoType?: "発表" | "訂正" | "取消"; operation?: Operation;
  areas?: readonly Area[] }>): string {
  const items = (options.areas ?? []).map((area) => `<Item><Area><Name>${area.name}</Name>${area.code == null ? ""
    : `<Code>${area.code}</Code>`}</Area><Category><Kind><Name>${area.kindName ?? KIND_NAME[area.kind] ?? "不明"}</Name><Code>${area.kind}</Code></Kind></Category>`
    + "</Item>").join("");
  const body = options.infoType === "取消" ? "<Text>先ほどの津波警報を取り消します。</Text>"
    : `<Tsunami><Forecast>${items}</Forecast></Tsunami>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Report xmlns="http://xml.kishou.go.jp/jmaxml1/">`
    + `<Control><Title>津波警報・注意報・予報a</Title><DateTime>2099-01-01T00:00:00Z</DateTime><Status>${STATUS[options.operation ?? "normal"]}</Status>`
    + "<EditorialOffice>気象庁本庁</EditorialOffice><PublishingOffice>気象庁</PublishingOffice></Control>"
    + `<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>津波警報</Title><ReportDateTime>${options.at}</ReportDateTime>`
    + `<TargetDateTime>${options.at}</TargetDateTime><EventID>${options.eventId ?? "20990101000011"}</EventID>`
    + `<InfoType>${options.infoType ?? "発表"}</InfoType><Serial></Serial><InfoKind>津波警報・注意報・予報</InfoKind>`
    + "<InfoKindVersion>1.0_1</InfoKindVersion><Headline><Text>合成の報</Text></Headline></Head>"
    + `<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">${body}</Body></Report>`;
}
type Station = Readonly<{ code: string; name?: string; condition?: string; height?: string }>;
// 合成の VTSE51/52。station は 32-39_11_10 の Station の形を複製する（T04 の境界入力）。
function observation(options: Readonly<{ family?: "VTSE51" | "VTSE52"; eventId?: string; at: string; serial: number;
  infoType?: "発表" | "訂正" | "取消"; operation?: Operation; stations?: readonly Station[] }>): string {
  const stations = (options.stations ?? []).map((station) => `<Station><Name>${station.name ?? `観測点${station.code}`}</Name>`
    + `<Code>${station.code}</Code><MaxHeight><Condition>${station.condition ?? "観測中"}</Condition>${station.height == null ? ""
      : `<jmx_eb:TsunamiHeight type="これまでの最大波の高さ" unit="m">${station.height}</jmx_eb:TsunamiHeight>`}</MaxHeight></Station>`).join("");
  const body = options.infoType === "取消" ? "<Text>先ほどの津波観測に関する情報を取り消します。</Text>"
    : `<Tsunami><Observation><Item><Area><Name>岩手県</Name><Code>210</Code></Area>${stations}</Item></Observation></Tsunami>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Report xmlns="http://xml.kishou.go.jp/jmaxml1/">`
    + `<Control><Title>津波観測に関する情報</Title><DateTime>2099-01-01T00:00:00Z</DateTime><Status>${STATUS[options.operation ?? "normal"]}</Status>`
    + "<EditorialOffice>気象庁本庁</EditorialOffice><PublishingOffice>気象庁</PublishingOffice></Control>"
    + `<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>津波観測に関する情報</Title><ReportDateTime>${options.at}</ReportDateTime>`
    + `<TargetDateTime>${options.at}</TargetDateTime><EventID>${options.eventId ?? "20990101000011"}</EventID>`
    + `<InfoType>${options.infoType ?? "発表"}</InfoType><Serial>${options.serial}</Serial><InfoKind>津波情報</InfoKind>`
    + "<InfoKindVersion>1.0_1</InfoKindVersion><Headline></Headline></Head>"
    + `<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">${body}</Body></Report>`;
}

function receive(state: TsunamiUnitState, material: DecodedMaterial, at: ClockReading): TsunamiUnitStep {
  return reduceTsunamiUnit(state, { kind: "receive", material, clock: at });
}
function run(state: TsunamiUnitState, input: TsunamiInput): TsunamiUnitStep {
  return reduceTsunamiUnit(state, input);
}

export { clock, decodeFixture, decodeXml, emptyState, fixtureXml, observation, receive, run, vtse41 };
export type { Area, Station };
