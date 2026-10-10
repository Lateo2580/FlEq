import { readFileSync } from "node:fs";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, PersistenceStatus } from "../../contracts/p2-shared-runtime.types";
import type { BriefingUnitState, BriefingUnitStep } from "../../contracts/p3-briefing-unit.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { reduceBriefingUnit } from "../../src/units/briefing/briefing-unit";

// P3-UNIT-B-001 の試験の共通部（続報と Q-LIMIT の境界入力は fixture を焼かずに試験内で作る）。

const saved: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null,
  savedAckAt: null, dirtySince: null };
function emptyState(): BriefingUnitState {
  return { schemaVersion: "p3-briefing-unit-v1", contentRevision: 0, currents: [], intents: [], persistence: saved };
}
function clock(wallTimeMs: number, monotonicMs = 0): ClockReading {
  return { wallTimeMs, monotonicMs };
}

let sequence = 0;
function decodeXml(xml: string, headType = "VPBS50", inputId = `input-${++sequence}`, origin: "replay" | "recovery" = "replay"): DecodedMaterial {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: 0, origin, kind: "replay", headType, body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
// name は test/fixtures の下の名前（拡張子なし）か test/ からの path。headType は名前の VPBS50・VPOA50 から。
const pathOf = (name: string) => name.startsWith("test/") ? name : `test/fixtures/${name}.xml`;
const headTypeOf = (name: string) => /VPOA50/.test(name) ? "VPOA50" : "VPBS50";
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
const iso = (ms: number) => new Date(ms + 32_400_000).toISOString().replace(".000Z", "+09:00");
// 情報タグの Information を item の列で置き換える（続報と境界の報を試験内で作る）。
type Area = Readonly<{ code: string; name?: string }>;
type Tag = Readonly<{ condition?: string; areas: readonly Area[] }>;
const TAG_INFO = /<Information type="情報タグ">[\s\S]*?<\/Information>/;
function tagInfo(items: readonly Tag[]): string {
  return `<Information type="情報タグ">${items.map((item) => `<Item><Kind><Name>情報タグ</Name>${item.condition == null ? ""
    : `<Condition>${item.condition}</Condition>`}</Kind><Areas codeType="気象情報／府県予報区・細分区域等">${item.areas.map((area) =>
    `<Area><Name>${area.name ?? `区域${area.code}`}</Name><Code>${area.code}</Code></Area>`).join("")}</Areas></Item>`).join("")}</Information>`;
}
const tags = (items: readonly Tag[]) => (xml: string) => xml.replace(TAG_INFO, tagInfo(items));
// Body の観測実況を観測の列で置き換える（観測の境界）。
const BODY_INFOS = /<MeteorologicalInfos type="観測実況">[\s\S]*?<\/MeteorologicalInfos>/;
function rainItem(code: string, name: string, value: string, attributes = 'type="前１時間解析雨量" unit="mm" condition="約"'): string {
  return `<Item><Kind><Property><Type>雨の実況</Type><PrecipitationPart><jmx_eb:Precipitation ${attributes}>${value}</jmx_eb:Precipitation>`
    + `<Time>2026-08-22T17:00:00+09:00</Time></PrecipitationPart></Property></Kind><Area><Name>${name}</Name><Code>${code}</Code></Area></Item>`;
}
const observations = (items: readonly string[]) => (xml: string) => xml.replace(BODY_INFOS,
  `<MeteorologicalInfos type="観測実況"><MeteorologicalInfo><DateTime>2026-08-22T17:09:00+09:00</DateTime>${items.join("")}</MeteorologicalInfo></MeteorologicalInfos>`);
const withoutHeadline = (xml: string) => xml.replace(/<Headline>\s*<Text>[\s\S]*?<\/Text>/, "<Headline>");

function receive(state: BriefingUnitState, material: DecodedMaterial, at: ClockReading): BriefingUnitStep {
  return reduceBriefingUnit(state, { kind: "receive", material, clock: at });
}
// 受信時刻は報の時刻（期限の手前）。
function send(state: BriefingUnitState, name: string, transform?: (xml: string) => string, now?: number, monotonicMs = 0): BriefingUnitStep {
  const material = decodeFixture(name, transform);
  return receive(state, material, clock(now ?? Date.parse(material.reportDateTimeRaw), monotonicMs));
}
const tick = (state: BriefingUnitState, wallTimeMs: number) => reduceBriefingUnit(state, { kind: "deadline", clock: clock(wallTimeMs) });

export { clock, decodeFixture, decodeXml, emptyState, eventId, fixtureXml, iso, observations, rainItem, receive, replaceTag, retime, send, serial,
  status, tagInfo, tags, tick, withoutHeadline };
export type { Area, Tag };
