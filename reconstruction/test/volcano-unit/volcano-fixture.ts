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
  return { schemaVersion: "p3-volcano-unit-v1", contentRevision: 0, alerts: [], eruptions: [], ashfalls: [], shortfalls: [],
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
function decodeFixture(name: string, transform: (xml: string) => string = (xml) => xml, inputId?: string): DecodedMaterial {
  const headType = manifest.fixtures.find((item) => item.path === pathOf(name))?.transport.headType;
  if (headType == null) throw new Error(`${name} has no headType in the manifest`);
  return decodeXml(transform(fixtureXml(name)), headType === "VFSVii" ? "VFSV50" : headType,
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

export { chain, clock, decodeFixture, decodeXml, emptyState, fixtureXml, receive, replaceTag, retime, send, status };
