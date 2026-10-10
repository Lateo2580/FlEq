import { readFileSync } from "node:fs";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, PersistenceStatus } from "../../contracts/p2-shared-runtime.types";
import type { FloodUnitState, FloodUnitStep } from "../../contracts/p3-flood-unit.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { reduceFloodUnit } from "../../src/units/flood/flood-unit";

// P3-UNIT-R-001 の試験の共通部（続報と Q-LIMIT の境界入力は fixture を焼かずに試験内で作る、T02・T04）。

const saved: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null,
  savedAckAt: null, dirtySince: null };
function emptyState(): FloodUnitState {
  return { schemaVersion: "p3-flood-unit-v1", contentRevision: 0, currents: [], intents: [], persistence: saved };
}
function clock(wallTimeMs: number, monotonicMs = 0): ClockReading {
  return { wallTimeMs, monotonicMs };
}

let sequence = 0;
function decodeXml(xml: string, headType = "VXKO50", inputId = `input-${++sequence}`, origin: "replay" | "recovery" = "replay"): DecodedMaterial {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: 0, origin, kind: "replay", headType, body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
// name は test/fixtures の下の名前（拡張子なし）か test/ からの path。headType は名前の VXKO・VXSU から。
const pathOf = (name: string) => name.startsWith("test/") ? name : `test/fixtures/${name}.xml`;
const headTypeOf = (name: string) => /(VXKO\d\d|VXSU\d\d)/.exec(name)?.[1] ?? "VXKO50";
function fixtureXml(name: string): string {
  return readFileSync(pathOf(name), "utf8");
}
function decodeFixture(name: string, transform: (xml: string) => string = (xml) => xml, inputId?: string): DecodedMaterial {
  return decodeXml(transform(fixtureXml(name)), headTypeOf(name), inputId ?? `${name.split("/").at(-1)!.slice(0, 40)}#${++sequence}`);
}
const replaceTag = (tag: string, value: string) => (xml: string) =>
  xml.replace(new RegExp(`<${tag}>[^<]*</${tag}>|<${tag}/>|<${tag} />`), `<${tag}>${value}</${tag}>`);
const retime = (at: string) => replaceTag("ReportDateTime", at);
const eventId = (value: string) => replaceTag("EventID", value);
const serial = (value: string) => replaceTag("Serial", value);
const status = (value: string) => (xml: string) => xml.replace("<Status>通常</Status>", `<Status>${value}</Status>`);
// 「（河川）」の Information を group の列で置き換える（続報と境界の報を試験内で作る）。
const RIVER_INFO = /<Information type="指定河川洪水予報（河川）">[\s\S]*?<\/Information>/;
type River = Readonly<{ code: string; name?: string }>;
type Group = Readonly<{ code: string; name?: string; rivers: readonly River[] }>;
function riverInfo(groups: readonly Group[]): string {
  return `<Information type="指定河川洪水予報（河川）">${groups.map((group) => `<Item><Kind><Name>${group.name ?? `種別${group.code}`}</Name>`
    + `<Code>${group.code}</Code></Kind><Areas codeType="河川">${group.rivers.map((river) => `<Area><Name>${river.name ?? `川${river.code}`}</Name>`
    + `<Code>${river.code}</Code></Area>`).join("")}</Areas></Item>`).join("")}</Information>`;
}
const rivers = (groups: readonly Group[]) => (xml: string) => xml.replace(RIVER_INFO, riverInfo(groups));
// 16_02_01 の河川（○○川 1234567890・△△川 9876543210、Kind/Code 30）。
const SAMPLE_RIVERS = [{ code: "1234567890", name: "○○川" }, { code: "9876543210", name: "△△川" }] as const;
// 水位・流量情報と HydrometricStationPart を観測所の列で置き換える（観測所・点の境界）。
type StationSpec = Readonly<{ code: string; name: string; values: readonly string[]; levels: readonly string[]; sections?: readonly string[] }>;
const SERIES = /<MeteorologicalInfos type="水位・流量情報">[\s\S]*?<\/MeteorologicalInfos>/;
const ADDITION = /<FloodForecastAddition>[\s\S]*?<\/FloodForecastAddition>/;
function stationsXml(points: number, stations: readonly StationSpec[]) {
  return (xml: string) => xml.replace(SERIES, `<MeteorologicalInfos type="水位・流量情報"><TimeSeriesInfo><TimeDefines>${
    Array.from({ length: points }, (_, index) => `<TimeDefine timeId="${index + 1}"><DateTime>2019-05-27T${String(9 + Math.floor(index / 6)).padStart(2, "0")}:${
      String(index % 6 * 10).padStart(2, "0")}:00+09:00</DateTime></TimeDefine>`).join("")}</TimeDefines>${stations.map((station) =>
    `<Item><Kind><Property><Type>水位</Type><WaterLevelPart>${station.values.map((value, index) =>
      `<jmx_eb:WaterLevel type="水位" refID="${index + 1}">${value}</jmx_eb:WaterLevel><jmx_eb:WaterLevel type="レベル" refID="${index + 1}">${
        station.levels[index] ?? ""}</jmx_eb:WaterLevel>`).join("")}</WaterLevelPart></Property></Kind><Station><Name>${station.name}</Name>`
    + `<Code type="水位観測所">${station.code}</Code></Station></Item>`).join("")}</TimeSeriesInfo></MeteorologicalInfos>`)
    .replace(ADDITION, `<FloodForecastAddition>${stations.map((station) => `<HydrometricStationPart><Area codeType="水位観測所"><Name>${station.name}</Name>`
      + `<Code>${station.code}</Code></Area>${(station.sections ?? []).map((section) => `<ChargeSection>${section}\n左岸：…</ChargeSection>`).join("")}`
      + "</HydrometricStationPart>").join("")}</FloodForecastAddition>`);
}

function receive(state: FloodUnitState, material: DecodedMaterial, at: ClockReading): FloodUnitStep {
  return reduceFloodUnit(state, { kind: "receive", material, clock: at });
}
// 受信時刻は報の時刻（期限の手前）。
function send(state: FloodUnitState, name: string, transform?: (xml: string) => string, now?: number, monotonicMs = 0): FloodUnitStep {
  const material = decodeFixture(name, transform);
  return receive(state, material, clock(now ?? Date.parse(material.reportDateTimeRaw), monotonicMs));
}

export { SAMPLE_RIVERS, clock, decodeFixture, decodeXml, emptyState, eventId, fixtureXml, receive, replaceTag, retime, riverInfo, rivers, send, serial,
  stationsXml, status };
export type { Group, StationSpec };
