import { readFileSync } from "node:fs";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, PersistenceStatus } from "../../contracts/p2-shared-runtime.types";
import type { LocalBulletinsUnitState, LocalBulletinsUnitStep } from "../../contracts/p3-local-bulletins-unit.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { HOUR } from "../../src/domains/local-bulletins/local-bulletins";
import { reduceLocalBulletinsUnit } from "../../src/units/local-bulletins/local-bulletins-unit";

// P3-UNIT-M-001 の試験の共通部（続報と Q-LIMIT の境界入力は fixture を焼かずに試験内で作る）。

const saved: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null,
  savedAckAt: null, dirtySince: null };
function emptyState(): LocalBulletinsUnitState {
  return { schemaVersion: "p3-local-bulletins-unit-v1", contentRevision: 0, tornado: [], heat: [], transient: [], intents: [], persistence: saved };
}
function clock(wallTimeMs: number, monotonicMs = 0): ClockReading {
  return { wallTimeMs, monotonicMs };
}

let sequence = 0;
// 連番は桁を固定する（inputId は intent の source に入って保存の byte を決める。briefing の fixture と同じ理由）。
const next = () => String(++sequence).padStart(6, "0");
function decodeXml(xml: string, headType: string, inputId = `input-${next()}`, origin: "replay" | "recovery" = "replay"): DecodedMaterial {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: 0, origin, kind: "replay", headType, body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
// name は test/fixtures の下の名前（拡張子なし）か test/ からの path。
const pathOf = (name: string) => name.startsWith("test/") ? name : `test/fixtures/${name}.xml`;
const headTypeOf = (name: string): string => (name.split("/").at(-1)!.match(/V[A-Z]{3}\d{2}/gi)?.at(-1) ?? "VPHW50").toUpperCase();
function fixtureXml(name: string): string {
  return readFileSync(pathOf(name), "utf8");
}
function decodeFixture(name: string, transform: (xml: string) => string = (xml) => xml, inputId?: string, headType = headTypeOf(name)): DecodedMaterial {
  return decodeXml(transform(fixtureXml(name)), headType, inputId ?? `${name.split("/").at(-1)!.slice(0, 40)}#${next()}`);
}
const replaceTag = (tag: string, value: string) => (xml: string) =>
  xml.replace(new RegExp(`<${tag}>[^<]*</${tag}>|<${tag}/>|<${tag} />`), `<${tag}>${value}</${tag}>`);
const retime = (at: string) => replaceTag("ReportDateTime", at);
const serial = (value: string) => replaceTag("Serial", value);
const eventId = (value: string) => replaceTag("EventID", value);
const infoType = (value: string) => replaceTag("InfoType", value);
const status = (value: string) => (xml: string) => xml.replace("<Status>通常</Status>", `<Status>${value}</Status>`);
const headTitle = (value: string) => (xml: string) => xml.replace(/(<Head[^>]*>\s*)<Title>[^<]*<\/Title>/, `$1<Title>${value}</Title>`);
const office = (value: string) => (xml: string) => xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${value}</EditorialOffice>`);
const compose = (...steps: readonly ((xml: string) => string)[]) => (xml: string) => steps.reduce((value, step) => step(value), xml);
const iso = (ms: number) => new Date(ms + 32_400_000).toISOString().replace(".000Z", "+09:00");

function receive(state: LocalBulletinsUnitState, material: DecodedMaterial, at: ClockReading): LocalBulletinsUnitStep {
  return reduceLocalBulletinsUnit(state, { kind: "receive", material, clock: at });
}
// 受信時刻は報の時刻（期限の手前）。
function send(state: LocalBulletinsUnitState, name: string, transform?: (xml: string) => string, now?: number, monotonicMs = 0): LocalBulletinsUnitStep {
  const material = decodeFixture(name, transform);
  return receive(state, material, clock(now ?? Date.parse(material.reportDateTimeRaw), monotonicMs));
}
const tick = (state: LocalBulletinsUnitState, wallTimeMs: number) => reduceLocalBulletinsUnit(state, { kind: "deadline", clock: clock(wallTimeMs) });

// 全 slice・family の記録（竜巻 128・熱中症 256・transient 768＝計 1,152）の retainUntil が同じ時刻 due に来る報の組（一括の期限回収の最大の入力）。
// 竜巻は ValidDateTime も due（activeUntil＝retainUntil の active）、熱中症と transient は見える期限が過ぎた記憶として採られる。
const DAY = 24 * HOUR;
function bulkReports(due: number): readonly Readonly<{ headType: string; xml: string }>[] {
  const pad = (index: number) => String(index).padStart(4, "0");
  const many = (count: number, headType: string, name: string, retain: number, make: (index: number, at: string) => (xml: string) => string) =>
    Array.from({ length: count }, (_, index) => ({ headType, xml: make(index, iso(due - retain))(fixtureXml(name)) }));
  return [
    ...many(128, "VPHW50", "19_03_01_130906_VPHW50", 36 * HOUR, (index, at) => compose(headTitle(`第${pad(index)}府県竜巻注意情報`), replaceTag("ReportDateTime", at), replaceTag("ValidDateTime", iso(due)))),
    ...many(256, "VPFT50", "57_03_01_240401_VPFT50", 72 * HOUR, (index, at) => compose(eventId(`JPTC24${pad(index)}`), replaceTag("ReportDateTime", at), replaceTag("TargetDateTime", at))),
    ...many(256, "VXSE56", "32-35_09_01_191111_VXSE56", 36 * HOUR, (index, at) => compose(eventId(`S${pad(index)}`), replaceTag("ReportDateTime", at))),
    ...many(256, "VPFJ51", "85_01_01_250630_VPFJ51", 36 * HOUR, (index, at) => compose(eventId(`JPTK23${pad(index)}`), replaceTag("ReportDateTime", at))),
    ...many(128, "VPCI50", "30_01_01_100915_VPCI50", 30 * DAY, (index, at) => compose(eventId(`C${pad(index)}`), replaceTag("ReportDateTime", at))),
    ...many(128, "VPAW51", "72_01_01_190327_VPAW51", 7 * DAY, (index, at) => compose(headTitle(`高温に関する早期天候情報（${pad(index)}）`), replaceTag("ReportDateTime", at))),
  ];
}

export { bulkReports, clock, compose, decodeFixture, decodeXml, emptyState, eventId, fixtureXml, headTitle, headTypeOf, infoType, iso, office, receive, replaceTag, retime, send,
  serial, status, tick };
