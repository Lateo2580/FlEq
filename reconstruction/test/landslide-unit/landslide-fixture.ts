import { readFileSync } from "node:fs";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, PersistenceStatus } from "../../contracts/p2-shared-runtime.types";
import type { LandslideUnitState, LandslideUnitStep } from "../../contracts/p3-landslide-unit.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { reduceLandslideUnit } from "../../src/units/landslide/landslide-unit";

// P3-UNIT-L-001 の試験の共通部（続報と Q-LIMIT の境界入力は fixture を焼かずに試験内で作る、T02・T04）。

const saved: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null,
  savedAckAt: null, dirtySince: null };
function emptyState(): LandslideUnitState {
  return { schemaVersion: "p3-landslide-unit-v1", contentRevision: 0, currents: [], intents: [], persistence: saved };
}
function clock(wallTimeMs: number, monotonicMs = 0): ClockReading {
  return { wallTimeMs, monotonicMs };
}

let sequence = 0;
function decodeXml(xml: string, inputId = `input-${++sequence}`, origin: "replay" | "recovery" = "replay"): DecodedMaterial {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: 0, origin, kind: "replay", headType: "VPWW56", body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
// name は test/fixtures の下の名前（拡張子なし）か test/ からの path。
const pathOf = (name: string) => name.startsWith("test/") ? name : `test/fixtures/${name}.xml`;
function fixtureXml(name: string): string {
  return readFileSync(pathOf(name), "utf8");
}
function decodeFixture(name: string, transform: (xml: string) => string = (xml) => xml, inputId?: string): DecodedMaterial {
  return decodeXml(transform(fixtureXml(name)), inputId ?? `${name.split("/").at(-1)!.slice(0, 40)}#${++sequence}`);
}
const replaceTag = (tag: string, value: string) => (xml: string) =>
  xml.replace(new RegExp(`<${tag}>[^<]*</${tag}>|<${tag}/>|<${tag} />`), `<${tag}>${value}</${tag}>`);
const retime = (at: string) => replaceTag("ReportDateTime", at);
const status = (value: string) => (xml: string) => xml.replace("<Status>通常</Status>", `<Status>${value}</Status>`);
const office = (name: string) => (xml: string) => xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${name}</EditorialOffice>`);
// 市町村等の Warning を Item の列で置き換える（続報と境界の報を試験内で作る）。
const MUNICIPALITY = /<Warning type="気象警報・注意報（市町村等）">[\s\S]*?<\/Warning>/;
type Area = Readonly<{ code: string; kind?: string; name?: string; status?: string; area?: string }>;
const NAMES: Readonly<Record<string, string>> = { "29": "レベル２土砂災害注意報", "09": "レベル３土砂災害警報", "49": "レベル４土砂災害危険警報",
  "39": "レベル５土砂災害特別警報" };
// 15_16_01 の市町村等（稚内市 49・猿払村 09・ほか 8 区域 29）。
const SOYA = ["0121400", "0151100", "0151200", "0151300", "0151400", "0151600", "0151700", "0151800", "0151900", "0152000"] as const;
function item({ code, kind = "29", name = NAMES[kind] ?? `種別${kind}`, status: value = "発表", area = `区域${code}` }: Area): string {
  const body = value === "発表警報・注意報はなし" ? "" : `<Name>${name}</Name><Code>${kind}</Code>`;
  return `<Item><Kind>${body}<Status>${value}</Status></Kind><Area><Name>${area}</Name><Code>${code}</Code></Area></Item>`;
}
const areas = (items: readonly Area[]) => (xml: string) =>
  xml.replace(MUNICIPALITY, `<Warning type="気象警報・注意報（市町村等）">${items.map(item).join("")}</Warning>`);

function receive(state: LandslideUnitState, material: DecodedMaterial, at: ClockReading): LandslideUnitStep {
  return reduceLandslideUnit(state, { kind: "receive", material, clock: at });
}
// 受信時刻は報の時刻（期限の手前）。
function send(state: LandslideUnitState, name: string, transform?: (xml: string) => string, now?: number, monotonicMs = 0): LandslideUnitStep {
  const material = decodeFixture(name, transform);
  return receive(state, material, clock(now ?? Date.parse(material.reportDateTimeRaw), monotonicMs));
}

export { SOYA, areas, clock, decodeFixture, decodeXml, emptyState, fixtureXml, item, office, receive, replaceTag, retime, send, status };
export type { Area };
