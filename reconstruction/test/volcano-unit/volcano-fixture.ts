import { readFileSync } from "node:fs";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, PersistenceStatus } from "../../contracts/p2-shared-runtime.types";
import type { VolcanoUnitState, VolcanoUnitStep } from "../../contracts/p3-volcano-unit.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { reduceVolcanoUnit } from "../../src/units/volcano/volcano-unit";
import manifest from "../../tools/corpus/manifest.json";

// P3-UNIT-V-001 の試験の共通部（Q-LIMIT の境界入力は fixture を焼かずに試験内で作る、T05）。

const saved: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null,
  savedAckAt: null, dirtySince: null };
function emptyState(): VolcanoUnitState {
  return { schemaVersion: "p3-volcano-unit-v6", contentRevision: 0, alerts: [], eruptions: [], ashfalls: [], shortfalls: [],
    scheduledAshfalls: [], batch: null, bulletins: [], intents: [], persistence: saved };
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
// name は test/fixtures の下の名前（拡張子なし）。
const pathOf = (name: string) => name.startsWith("test/") ? name : `test/fixtures/${name}.xml`;
function fixtureXml(name: string): string {
  return readFileSync(pathOf(name), "utf8");
}
// P3-C9-MARINE=A: corpus の VFSVii は file 名の略記なので、配信の headType VFSV50 として投入する。
// P3-VM-AC03: 試験が Head/ReportDateTime を替えて作った報は、送信の時刻（Control/DateTime、XML の最初の DateTime）も同じだけ動かす
// （新旧は Control/DateTime で決まる）。Serial や InfoType だけを替えた報は元の報と同じ時刻のまま（同じ時刻の別の版）。
// 試験が Control/DateTime を自分で替えた報はそのまま。
function followHead(original: string, xml: string): string {
  const head = (text: string) => Date.parse(/<ReportDateTime>([^<]*)<\/ReportDateTime>/.exec(text)?.[1] ?? "");
  const control = (text: string) => /<DateTime>([^<]*)<\/DateTime>/.exec(text)?.[1];
  const delta = head(xml) - head(original);
  return !Number.isFinite(delta) || delta === 0 || control(xml) !== control(original) ? xml : xml.replace(/<DateTime>([^<]*)<\/DateTime>/, (_, at: string) =>
    `<DateTime>${new Date(Date.parse(at) + delta).toISOString()}</DateTime>`);
}
// 同じ電文を後の送信にする（Control/DateTime を seconds だけ進める）。
function sentLater(xml: string, seconds = 1): string {
  return xml.replace(/<DateTime>([^<]*)<\/DateTime>/, (_, at: string) =>
    `<DateTime>${new Date(Date.parse(at) + seconds * 1000).toISOString()}</DateTime>`);
}
function decodeFixture(name: string, transform: (xml: string) => string = (xml) => xml, inputId?: string): DecodedMaterial {
  const headType = manifest.fixtures.find((item) => item.path === pathOf(name))?.transport.headType;
  if (headType == null) throw new Error(`${name} has no headType in the manifest`);
  const original = fixtureXml(name);
  return decodeXml(followHead(original, transform(original)), headType === "VFSVii" ? "VFSV50" : headType,
    inputId ?? `${name.split("/").at(-1)!.slice(0, 40)}#${++sequence}`);
}
const replaceTag = (tag: string, value: string) => (xml: string) =>
  xml.replace(new RegExp(`<${tag}>[^<]*</${tag}>|<${tag} />`), `<${tag}>${value}</${tag}>`);
// ReportDateTime を替える（報の時刻順の境界を作る）。
const retime = (at: string) => replaceTag("ReportDateTime", at);
const status = (value: string) => (xml: string) => xml.replace("<Status>通常</Status>", `<Status>${value}</Status>`);

function receive(state: VolcanoUnitState, material: DecodedMaterial, at: ClockReading): VolcanoUnitStep {
  return reduceVolcanoUnit(state, { kind: "receive", material, clock: at });
}
// 受信時刻は報の時刻（期限の手前）。
function send(state: VolcanoUnitState, name: string, transform?: (xml: string) => string, now?: number, monotonicMs = 0): VolcanoUnitStep {
  const material = decodeFixture(name, transform);
  return receive(state, material, clock(now ?? Date.parse(material.reportDateTimeRaw), monotonicMs));
}
function chain(names: readonly string[], state = emptyState()): VolcanoUnitStep[] {
  const steps: VolcanoUnitStep[] = [];
  for (const name of names) { const step = send(state, name); steps.push(step); state = step.state; }
  return steps;
}

export { chain, clock, decodeFixture, decodeXml, emptyState, fixtureXml, followHead, receive, replaceTag, retime, send, sentLater, status };
