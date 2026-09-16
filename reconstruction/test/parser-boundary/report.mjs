import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { classifyCorpus, measurements } from './evidence.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node reconstruction/test/parser-boundary/report.mjs OUTPUT_DIRECTORY (run reconstruction tsc first)');
const directory = resolve(process.argv[2]);
const contract = JSON.parse(readFileSync('reconstruction/contracts/p1-parser-boundary.json', 'utf8')).contract;
const comparisons = classifyCorpus();
const timings = await measurements();
const responses = [
  '1: B03 checks the entire WS frame or REST/replay Uint8Array length before JSON parse/body allocation; body has a single Buffer allocation.',
  '2: Quote-aware bounded scan counts newline-containing attributes and accumulated direct text across comments/CDATA; rejects each structural excess before full parse.',
  '3: XMLValidator checks well-formedness after the bounded scan. It produces no tree; XMLParser.parse is the sole full tree parse (one on accepted input, zero on pre-rejection). DTD is rejected.',
  '4: Base64 uses Buffer decode plus canonical round-trip/length validation, without a recursive whole-input regex; decode exceptions return bodyDecodeFailed.',
  '5: The B03 discriminated ws/rest/replay input assigns required WS evidence and notProvided for raw REST/replay; origin remains independent.',
  '6: classifyMaterial converts NFKC numeric text, whitespace empty, and condition lower/upper ranges while keeping raw strings and XML attributes.',
  '7: Diagnostic ring retains bounded three-source evidence, reason, inputId, byte counts and truncationReason; escaped line <=8192 bytes and ring <=256 entries/1MiB are tested.',
  '8: Corpus expected and actual are independent, including document dates and headType; Evidence/WindSpeed expects xmlInvalid. An all-rejected stub must produce 238 differences.',
  '9: Test helper sends actual ParserMailboxItem and ParserMailboxResult through MessageChannel; records both deliveries. Metadata/SpecialValue includes actual extraction; routing has its own stage; null stages have explicit reasons.',
  '10: Spies count base64 Buffer decode, gunzip/unzip and full parse; every byte/structure boundary tests -1/exact/+1 and zero full parses on excess. All 180 source-value/presence combinations include resolved operation expectations; broken XML/expanded excess preserve unobserved-source omission.',
  '11: Status normalization uses Map allowlists, tested with toString/__proto__/constructor in envelope and document.',
  '12: Measurement lives only in test helper. Vitest does not write reports; this explicit output-directory script generates all five report files. Runtime exports are checked.',
  '13: Removed discarded classifyMaterial call in decodeMaterial. The consumer invokes classification once and uses its returned extraction and timing results.',
  'A: One xmlValue helper expands decimal/hex character references and the five predefined entities for both scan counts and tree values; attribute/text exact and +1 limits, numeric/Status semantics and nonrecursive expansion are tested.',
  'B: The scan rejects undeclared entities, malformed references and references outside XML 1.0 Char before full parse (xmlInvalid); DTD remains forbidden. CDATA is literal, not entity-expanded.',
  'C: Removed internal three-byte headers and all byte-sniffing; B03 validates encoding/compression and carries them in ParserMailboxItem. encodedByteLength is the unmodified body byte length; whole-frame limits still precede JSON parsing.',
  'D: Fatal UTF-8 TextDecoder with ignoreBOM:false consumes the leading BOM before validation/tree parse; expanded byte counts retain BOM bytes.',
];
const notes = `# P1 review corrections\n\n${responses.map(x => '- ' + x).join('\n')}\n\n## Public boundary (R-a)\n\n` +
  '- reconstruction/src/contracts-revision/operation.ts: resolveOperation(evidence: OperationEvidence): OperationResolution\n' +
  '- reconstruction/src/decode-material/decode-material.ts: decodeMaterial(item: ParserMailboxItem): ParserMailboxResult\n' +
  '- reconstruction/src/decode-material/decode-material.ts: classifyMaterial(material: DecodedMaterial): Readonly<{route:string;family:string;materialValues:MaterialValue[];fields:{path:string;value:MaterialValue}[];metadata:{eventId:MaterialValue;serial:MaterialValue};marks:ProcessingMarks}>\n' +
  '- reconstruction/src/diagnostics/parser-diagnostic.ts: recordParserDiagnostic(diagnostic: ParserDiagnostic): void\n' +
  '- reconstruction/src/ingress/ingress.ts: ingestXmlData(input: IngressInput): {kind:"accepted",item:ParserMailboxItem,ingressJsonMs:number|null} | {kind:"rejected",diagnostic:ParserDiagnostic}\n' +
  '- reconstruction/src/decode-material/decode-material.ts: parserLimits (8MiB input, 10MiB expanded, 320000 elements, depth 24, 16 attributes, 256 attribute characters, 16384 accumulated direct-text characters)\n' +
  '- reconstruction/src/mailbox/parser-boundary.ts: parserMailboxLimits (128/16MiB total, 120/14MiB normal)\n\n' +
  'IngressInput is local (not exported): inputId/inputSequence/receivedAt/origin plus {kind:"ws",frame:Uint8Array} or {kind:"rest"|"replay",body:Uint8Array,headType:string}.\n\n' +
  '## Decisions and interpretation\n\n' +
  '- head.type: A 採用（統合担当裁定 2026-09-16）。Required ParserMailboxItem.headType; no XML Head/Type fallback or sidecar.\n' +
  '- Encoding transport: B 採用（統合担当裁定 R-e、2026-09-16）。ParserMailboxItem.encoding/compression carry transport metadata; A (internal three-byte header) is removed. REST/replay use utf-8/null; encodedBody is unchanged and encodedByteLength counts only body bytes.\n' +
  '- XML validity: A = existing XMLValidator after early bounded scan; B = implement a second XML grammar. Recommended/adopted A; validator is a validation scan, not a full tree parse.\n' +
  '- Measurement: decodeMaterial extracts metadata; classifyMaterial extracts SpecialValue and returns combined metadataSpecialValueMs and route-classification domainExtractionMs. No M01-M18 semantic reducer/aggregation is implemented in P1.\n' +
  '- Node count is element count; text limit sums direct text within each element, ignoring comments and retaining CDATA characters.\n\n' +
  '## Parser options\n\n' +
  'preserveOrder:true retains child order; ignoreAttributes:false and attributeNamePrefix:"" retain attribute names/values; textNodeName:"#text" preserves text; trimValues:false retains whitespace; parseTagValue:false and parseAttributeValue:false retain leading zeroes and fullwidth raw strings. XML tree is reused; no shadow parse.\n\n' +
  '- Entity settings: processEntities:false prevents library-specific/double expansion; cdataPropName:"#cdata" distinguishes literal CDATA. Tree conversion uses the same xmlValue decoder as the scan for normal text/attributes, never CDATA.\n' +
  '- Counting: Unicode code points after one expansion of decimal/hex references and amp/lt/gt/apos/quot; XML 1.0 Char is enforced, unknown entities rejected, adjacent direct text accumulated across comments/CDATA, CDATA counted literally.\n\n' +
  '## Reasons\n\n' +
  'formatUnsupported, inputTooLarge, envelopeInvalid, encodingUnsupported, compressionUnsupported, bodyDecodeFailed, expandedBodyInvalid, expandedBodyTooLarge, xmlLimitExceeded, xmlInvalid; operationMissing, operationInvalid, operationMismatch, operationAmbiguous. Missing precedes invalid, then mismatch, then ambiguous; head.test alone cannot resolve operation.\n\n' +
  '## Remaining boundaries\n\n' +
  'B05 scheduling/credit, persistent diagnostic sink, semantic reducers and real worker scheduling remain outside P1. MessageChannel measures real payload delivery in one process; it is not worker-thread scheduling or real-paint acceptance. Corpus provenance and sequence unmet decisions remain unchanged and are not waived. Root build invokes its existing clean script, so old root dist preservation cannot be claimed for root build; reconstruction build writes only reconstruction/dist.\n\n' +
  'Report command: node reconstruction/test/parser-boundary/report.mjs ' + directory + '\n';
const mapping = '# P1 test mapping\n\n' + contract.testMapping.filter(t => t.testId.startsWith('P1-')).map(t => `- ${t.testId}: ${t.purpose}; ${t.referenceIds.join(', ')}; ${t.behavior}`).join('\n') + '\n- P1-T06 diagnostic boundary: contractBoundary; P1-RES-08/09/10, P1-AC12/15; stored evidence and line/ring bounds.\n- A: regression/contractBoundary; AC05-07/10; reference semantics and expanded attribute/text limits.\n- B: regression/contractBoundary; AC15; invalid entities/character references rejected before parse.\n- C: regression/contractBoundary; AC10/12; explicit encoding/compression, unchanged bytes, fake header rejection.\n- D: regression/acceptance; AC06; BOM accepted without changing XML text.\n';
mkdirSync(directory, { recursive: true });
for (const [name, body] of [
  ['acceptance-checks.md', '# Acceptance checks (requirements, not blanket PASS claims)\n\n' + contract.acceptanceChecks.map(c => `- ${c.id}: ${c.requirement}`).join('\n') + '\n'],
  ['classification-comparison.json', JSON.stringify(comparisons, null, 2) + '\n'],
  ['seven-stage-measurements.json', JSON.stringify(timings, null, 2) + '\n'],
  ['test-mapping.md', mapping], ['implementation-notes.md', notes],
]) writeFileSync(join(directory, name), body);
const differences = comparisons.filter(r => r.difference != null).length;
console.log(JSON.stringify({ output: directory, xml: comparisons.length, differences, timings: timings.map(r => ({ fixtureId: r.fixtureId, marks: r.marks, unexecutedReasons: r.unexecutedReasons })) }, null, 2));
if (differences !== 0) process.exitCode = 1;
