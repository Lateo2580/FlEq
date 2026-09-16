import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const { ingestXmlData } = require('../../dist/src/ingress/ingress.js');
const { decodeMaterial, classifyMaterial } = require('../../dist/src/decode-material/decode-material.js');

export const manifest = JSON.parse(readFileSync('reconstruction/tools/corpus/manifest.json', 'utf8'));
export function rawInput(fixture, body = readFileSync(fixture.path)) {
  return { kind: 'replay', origin: 'replay', inputId: fixture.fixtureId, inputSequence: 1, receivedAt: 0, headType: fixture.transport.headType, body };
}
export function envelope(body, headType = 'VPWS50', extras = {}) {
  return Buffer.from(JSON.stringify({ type: 'data', head: { type: headType, test: false }, xmlReport: { control: { status: '通常' } }, format: 'xml', encoding: 'base64', compression: 'gzip', body: gzipSync(body).toString('base64'), ...extras }));
}
export function classifyCorpus(api = { ingestXmlData, decodeMaterial, classifyMaterial }) {
  return manifest.fixtures.filter(f => f.path.endsWith('.xml')).map(f => {
    const fragment = f.fixtureId === 'test__fixtures__telegram-foundation__weathercw-10_03_01_171016_VPTW60-wind-range';
    const expected = fragment ? { kind: 'rejected', reason: 'xmlInvalid' } : { kind: 'decoded', classification: f.transport.classification, headType: f.transport.headType, ...f.documentTimes };
    const ingress = api.ingestXmlData(rawInput(f));
    const result = ingress.kind === 'accepted' ? api.decodeMaterial(ingress.item) : ingress;
    let actual;
    if (result.kind === 'rejected') actual = { kind: 'rejected', reason: result.diagnostic.reason };
    else {
      const m = result.material;
      const head = m.xml.children.find(n => n.kind === 'element' && n.name === 'Head');
      const text = name => head?.children.find(n => n.kind === 'element' && n.name === name)?.children.filter(n => n.kind === 'text').map(n => n.value).join('') ?? null;
      actual = { kind: 'decoded', classification: api.classifyMaterial(m).route, headType: m.headType, reportDateTimeRaw: text('ReportDateTime'), targetDateTimeRaw: text('TargetDateTime') };
    }
    return { fixtureId: f.fixtureId, role: f.role, expected, actual, difference: JSON.stringify(expected) === JSON.stringify(actual) ? null : { expected, actual } };
  });
}

function structure(xml) {
  const counts = { nodes: 0, depth: 0, attributes: 0, attributeCharacters: 0, maxAttributes: 0, maxAttributeValue: 0, textCharacters: 0, maxText: 0 };
  function visit(node, depth) {
    if (node.kind === 'text') { counts.textCharacters += Array.from(node.value).length; counts.maxText = Math.max(counts.maxText, Array.from(node.value).length); return; }
    counts.nodes++; counts.depth = Math.max(counts.depth, depth); counts.attributes += node.attributes.length;
    counts.maxAttributes = Math.max(counts.maxAttributes, node.attributes.length);
    for (const a of node.attributes) { counts.attributeCharacters += Array.from(a.value).length; counts.maxAttributeValue = Math.max(counts.maxAttributeValue, Array.from(a.value).length); }
    node.children.forEach(c => visit(c, depth + 1));
  }
  visit(xml, 1); return counts;
}

// Measures actual encoded input and ParserMailboxResult delivery, excluding decoder CPU time.
export async function measure(input, fixtureId, api = { ingestXmlData, decodeMaterial, classifyMaterial }) {
  const ingress = api.ingestXmlData(input);
  if (ingress.kind !== 'accepted') throw new Error(ingress.diagnostic.reason);
  const { port1, port2 } = new MessageChannel();
  let transferMs = 0;
  let started = performance.now();
  let receivedBytes = 0;
  const result = await new Promise((resolve, reject) => {
    port2.once('message', item => {
      transferMs += performance.now() - started;
      receivedBytes = item.encodedBody.byteLength;
      try { const decoded = api.decodeMaterial(item); started = performance.now(); port2.postMessage(decoded); }
      catch (error) { reject(error); }
    });
    port1.once('message', result => { transferMs += performance.now() - started; resolve(result); });
    port1.postMessage(ingress.item);
  }).finally(() => { port1.close(); port2.close(); });
  if (result.kind !== 'decoded') throw new Error(result.diagnostic.reason);
  const classification = api.classifyMaterial(result.material);
  const marks = { ...classification.marks, ingressJsonMs: ingress.ingressJsonMs, workerTransferMs: transferMs };
  const reasons = Object.fromEntries(Object.entries(marks).filter(([,v]) => v === null).map(([key]) => [key, key === 'ingressJsonMs' ? 'raw XML: no JSON envelope' : key === 'base64DecodeMs' ? 'raw UTF-8: no base64' : key === 'decompressionMs' ? 'uncompressed body' : 'not executed']));
  return { inputId: input.inputId, fixtureId, encodedByteLength: ingress.item.encodedByteLength, decodedByteLength: result.material.decodedByteLength, expandedByteLength: result.material.expandedByteLength, ...structure(result.material.xml), marks, unexecutedReasons: reasons, transfer: { inputBytes: receivedBytes, resultInputId: result.material.inputId, resultNodes: structure(result.material.xml).nodes }, classification: { route: classification.route, family: classification.family } };
}

export async function measurements() {
  const ids = [
    ['expected:O09:2', 'test__fixtures__15_18_01_250630_VPWS50'],
    ['expected:O02:14', 'test__fixtures__81_09_01_260605_VPWP50'],
    ['expected:O02:27', 'test__fixtures__synthetic_phase4a_VXSE53_special'],
  ];
  const rows = [];
  for (const [inputId, fixtureId] of ids) {
    const f = manifest.fixtures.find(f => f.fixtureId === fixtureId);
    rows.push(await measure({ kind: 'ws', origin: 'replay', inputId, inputSequence: 1, receivedAt: 0, frame: envelope(readFileSync(f.path), f.transport.headType) }, fixtureId));
  }
  const f = manifest.fixtures.find(f => f.fixtureId === ids[2][1]);
  rows.push(await measure(rawInput(f), f.fixtureId));
  return rows;
}
