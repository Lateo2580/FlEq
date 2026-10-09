import { readFileSync } from "node:fs";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, PersistenceStatus } from "../../contracts/p2-shared-runtime.types";
import type { NankaiUnitState, NankaiUnitStep } from "../../contracts/p3-nankai-unit.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { reduceNankaiUnit } from "../../src/units/nankai/nankai-unit";
import manifest from "../../tools/corpus/manifest.json";

// P3-UNIT-N-001 の試験の共通部（Q-LIMIT の境界入力は fixture を焼かずに試験内で作る、T04）。

const saved: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null,
  savedAckAt: null, dirtySince: null };
function emptyState(): NankaiUnitState {
  return { schemaVersion: "p3-nankai-unit-v1", contentRevision: 0, currents: [], information: [], intents: [], persistence: saved };
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
// name は test/fixtures の下の名前（拡張子なし）。74_01 などは selected_xml の下。
const pathOf = (name: string) => name.startsWith("test/") ? name : /^\d/.test(name) ? `test/fixtures/selected_xml/${name}.xml` : `test/fixtures/${name}.xml`;
function fixtureXml(name: string): string {
  return readFileSync(pathOf(name), "utf8");
}
function decodeFixture(name: string, transform: (xml: string) => string = (xml) => xml, inputId?: string): DecodedMaterial {
  const headType = manifest.fixtures.find((item) => item.path === pathOf(name))?.transport.headType;
  if (headType == null) throw new Error(`${name} has no headType in the manifest`);
  return decodeXml(transform(fixtureXml(name)), headType, inputId ?? `${name.split("/").at(-1)!.slice(0, 40)}#${++sequence}`);
}
const replaceTag = (tag: string, value: string) => (xml: string) =>
  xml.replace(new RegExp(`<${tag}>[^<]*</${tag}>`), `<${tag}>${value}</${tag}>`);
// ReportDateTime と TargetDateTime を同じ時刻へ替える（報の時刻順の境界を作る）。
const retime = (at: string) => (xml: string) => replaceTag("TargetDateTime", at)(replaceTag("ReportDateTime", at)(xml));

function receive(state: NankaiUnitState, material: DecodedMaterial, at: ClockReading): NankaiUnitStep {
  return reduceNankaiUnit(state, { kind: "receive", material, clock: at });
}
// 受信時刻は報の時刻（期限の手前）。
function send(state: NankaiUnitState, name: string, transform?: (xml: string) => string, now?: number): NankaiUnitStep {
  const material = decodeFixture(name, transform);
  return receive(state, material, clock(now ?? Date.parse(material.reportDateTimeRaw)));
}
function chain(names: readonly string[], state = emptyState()): NankaiUnitStep[] {
  const steps: NankaiUnitStep[] = [];
  for (const name of names) { const step = send(state, name); steps.push(step); state = step.state; }
  return steps;
}

export { chain, clock, decodeFixture, decodeXml, emptyState, fixtureXml, receive, replaceTag, retime, send };
