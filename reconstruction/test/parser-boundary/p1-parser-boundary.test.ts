import { Buffer } from "node:buffer";
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { deflateSync, gunzipSync, unzipSync } from "node:zlib";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { afterEach, expect, it, vi } from "vitest";
import type { Operation, OperationSourceEvidence, XmlNode } from "../../contracts/p1-parser-boundary.types";
import { ingestXmlData } from "../../src/ingress/ingress";
import { decodeMaterial, classifyMaterial, parserLimits } from "../../src/decode-material/decode-material";
import { resolveOperation } from "../../src/contracts-revision/operation";
import { classifyCorpus, envelope, measure } from "./evidence.mjs";

vi.mock("node:zlib", async (original) => {
  const z = await original<typeof import("node:zlib")>();
  return { ...z, gunzipSync: vi.fn(z.gunzipSync), unzipSync: vi.fn(z.unzipSync) };
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
const api = { ingestXmlData, decodeMaterial, classifyMaterial };
const context = { inputId: "test", inputSequence: 1, receivedAt: 0, origin: "replay" as const };
const base = "<Report><Control><Status>通常</Status></Control><Head><EventID>001</EventID><Serial>02</Serial></Head><Body/></Report>";
function ingress(body: string | Uint8Array, kind: "replay" | "rest" = "replay") {
  return ingestXmlData({ ...context, kind, headType: "VPWS50", body: typeof body === "string" ? Buffer.from(body) : body });
}
// P3-WL2-T03: 木を作ったかは parseTimes.endedMs で読む（受理で値、事前拒否で null。旧は XMLParser.parse の回数で数えた）。
function parseTimes(): { startedMs: number | null; endedMs: number | null } { return { startedMs: null, endedMs: null }; }
function decode(body: string | Uint8Array, times = parseTimes()) {
  const entered = ingress(body);
  return entered.kind === "accepted" ? decodeMaterial(entered.item, times) : entered;
}
function ws(frame: Uint8Array) { return ingestXmlData({ ...context, kind: "ws", frame }); }
function wsDecode(body: Uint8Array, times = parseTimes()) {
  const entered = ws(envelope(body));
  return entered.kind === "accepted" ? decodeMaterial(entered.item, times) : entered;
}
function sizedXml(size: number) {
  // Insert padding inside Body, before the closing Report.
  const xml = base.replace("<Body/>", "<Body><!----></Body>");
  return xml.replace("<!---->", `<!--${"x".repeat(size - Buffer.byteLength(xml))}-->`);
}

it("P1-T01 corpusHistory / AC01: independently compares every XML and the explicit rejected fragment", () => {
  const rows = classifyCorpus(api);
  expect(rows).toHaveLength(267);
  expect(rows.filter(r => r.difference != null)).toEqual([]);
  expect(rows.filter(r => r.actual.kind === "decoded")).toHaveLength(266);
  const rejectedRows = classifyCorpus({ ...api, decodeMaterial: () => ({ kind: "rejected", diagnostic: { reason: "xmlInvalid" } }) });
  expect(rejectedRows.filter(r => r.difference != null)).toHaveLength(266);
});

it("P1-T02 acceptance / AC02-04: spies count decode, expansion and full parse, including pre-rejection", () => {
  // P3-WL2-T03: 普通の入力は FXP の木を作らず（XMLParser.parse 0 回＝旧の経路にも入らない、P3-WL2-RES-01）、validator は受理で 1 回。
  const parse = vi.spyOn(XMLParser.prototype, "parse");
  const validate = vi.spyOn(XMLValidator, "validate");
  const frame = envelope(Buffer.from(base));
  const entered = ws(frame);
  expect(entered.kind).toBe("accepted");
  if (entered.kind !== "accepted") throw Error("ingress");
  const from = vi.spyOn(Buffer, "from");
  const times = parseTimes();
  const result = decodeMaterial(entered.item, times);
  expect(result.kind).toBe("decoded");
  // Buffer.from のどのオーバーロードを spy が拾うかで引数タプル長が変わるので、呼び出し記録は位置で読む
  expect(from.mock.calls.filter((args: readonly unknown[]) => args[1] === "base64")).toHaveLength(1);
  expect(gunzipSync).toHaveBeenCalledTimes(1);
  expect(unzipSync).toHaveBeenCalledTimes(0);
  expect(times.endedMs).not.toBeNull();
  expect(validate).toHaveBeenCalledTimes(1);
  if (result.kind === "decoded") { classifyMaterial(result.material); classifyMaterial(result.material); }
  expect(parse).not.toHaveBeenCalled();
  const zip = ws(envelope(Buffer.from(base), "VPWS50", { compression: "zip", body: deflateSync(Buffer.from(base)).toString("base64") }));
  if (zip.kind !== "accepted") throw Error("ingress");
  expect(decodeMaterial(zip.item).kind).toBe("decoded");
  expect(unzipSync).toHaveBeenCalledTimes(1);
  expect(gunzipSync).toHaveBeenCalledTimes(1);
  expect(ws(Buffer.alloc(parserLimits.inputBytes + 1))).toMatchObject({ kind: "rejected", diagnostic: { reason: "inputTooLarge" } });
  validate.mockClear();
  const limited = parseTimes();
  expect(decode(base.replace("<Body/>", `<Body>${"<n>".repeat(parserLimits.depth)}${"</n>".repeat(parserLimits.depth)}</Body>`), limited)).toMatchObject({ kind: "rejected", diagnostic: { reason: "xmlLimitExceeded" } });
  expect(limited.endedMs).toBeNull();
  expect(validate).not.toHaveBeenCalled();
  expect(parse).not.toHaveBeenCalled();
});

it("P1-T03 acceptance / AC05-08: corpus special values and lossless raw metadata", () => {
  const result = decode(readFileSync("test/fixtures/synthetic_phase4a_VXSE53_special.xml"));
  expect(result.kind).toBe("decoded");
  if (result.kind !== "decoded") throw Error("decode");
  const material = classifyMaterial(result.material);
  expect(material.materialValues).toEqual(expect.arrayContaining([
    { kind: "number", value: 4, raw: "４" }, { kind: "empty", raw: " 　" }, { kind: "range", bound: "lower", value: 5, raw: "" },
  ]));
  const overflow = `${"9".repeat(400)}以上`;
  const extra = decode(base.replace("<Body/>", `<Body><n a="007">0</n><n>不明</n><n>3以下</n><n> keep </n><n>${overflow}</n></Body>`));
  if (extra.kind !== "decoded") throw Error("decode");
  expect(extra.material).toMatchObject({ eventIdRaw: "001", serialRaw: "02" });
  expect(classifyMaterial(extra.material).materialValues).toEqual(expect.arrayContaining([
    { kind: "number", value: 0, raw: "0" }, { kind: "unknown", raw: "不明" }, { kind: "range", bound: "upper", value: 3, raw: "3以下" }, { kind: "text", value: " keep ", raw: " keep " },
    // 桁あふれの境界は range にせず text に落とす（保存の JSON で Infinity が null になるのを防ぐ）。
    { kind: "text", value: overflow, raw: overflow },
  ]));
  expect(JSON.stringify(extra.material.xml)).toContain('"name":"a","value":"007"');
  const absent = decode(base.replace("<EventID>001</EventID>", ""));
  if (absent.kind !== "decoded") throw Error("decode");
  expect(classifyMaterial(absent.material).metadata.eventId).toEqual({ kind: "missing" });
});

it("P1-T04 contractBoundary / AC09,R12: checks every source import and runtime export", async () => {
  function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]); }
  const source = files("reconstruction/src").filter(p => p.endsWith(".ts")).map(p => readFileSync(p, "utf8")).join("\n");
  expect(source).not.toMatch(/(?:from|import\()\s*["'][^"']*(?:\.\.\/\.\.\/\.\.\/src|engine|ui)[/"']/);
  expect([...source.matchAll(/export (?:async )?function (\w+)|export const (\w+)/g)].map(m => m[1] ?? m[2]).sort()).toEqual(["classifyMaterial", "decodeMaterial", "ingestXmlData", "parserLimits", "parserMailboxLimits", "recordParserDiagnostic", "resolveOperation"].sort());
});

it("P1-T05 contractBoundary / AC10: below/exact/over bytes and structure; no full parse on excess", () => {
  for (const delta of [-1, 0, 1]) {
    const size = parserLimits.inputBytes + delta;
    const raw = Buffer.from(sizedXml(size));
    expect(raw.length).toBe(size);
    for (const kind of ["rest", "replay"] as const) {
      const times = parseTimes();
      const entered = ingress(raw, kind);
      const result = entered.kind === "accepted" ? decodeMaterial(entered.item, times) : entered;
      expect(result.kind).toBe(delta > 0 ? "rejected" : "decoded");
      expect(times.endedMs != null).toBe(delta <= 0);
    }
    const tiny = envelope(Buffer.from(base));
    const frame = Buffer.concat([tiny, Buffer.alloc(size - tiny.length, 32)]);
    const json = vi.spyOn(JSON, "parse");
    const entered = ws(frame);
    expect(json).toHaveBeenCalledTimes(delta > 0 ? 0 : 1);
    json.mockRestore();
    expect(entered.kind).toBe(delta > 0 ? "rejected" : "accepted");
    if (entered.kind === "accepted") expect(decodeMaterial(entered.item).kind).toBe("decoded");
    const expandedTimes = parseTimes();
    const expanded = wsDecode(Buffer.from(sizedXml(parserLimits.expandedBytes + delta)), expandedTimes);
    expect(expanded.kind).toBe(delta > 0 ? "rejected" : "decoded");
    if (delta > 0) expect(expanded).toMatchObject({ diagnostic: { reason: "expandedBodyTooLarge" } });
    expect(expandedTimes.endedMs != null).toBe(delta <= 0);
  }
  const nodeBase = 8; // Report, Control, Status, Head, EventID, Serial, Body plus n container.
  const generators: Array<[number, (n: number) => string]> = [
    [320000, n => base.replace("<Body/>", `<Body><n>${"<x/>".repeat(n - nodeBase)}</n></Body>`)],
    [24, n => base.replace("<Body/>", `<Body>${"<n>".repeat(n - 2)}${"</n>".repeat(n - 2)}</Body>`)],
    [16, n => base.replace("<Body/>", `<Body ${Array.from({ length: n }, (_, i) => `a${i}=">"`).join(" ")}/>`)],
    [256, n => base.replace("<Body/>", `<Body a="${"x\n".repeat(Math.floor(n / 2))}${n % 2 ? "x" : ""}"/>`)],
    [16384, n => base.replace("<Body/>", `<Body>${"x".repeat(Math.floor(n / 2))}<!--split-->${"x".repeat(Math.ceil(n / 2))}</Body>`)],
  ];
  for (const [limit, generate] of generators) for (const delta of [-1, 0, 1]) {
    const times = parseTimes();
    const result = decode(generate(limit + delta), times);
    expect(result.kind, `${limit}/${delta}`).toBe(delta > 0 ? "rejected" : "decoded");
    if (delta > 0) expect(result).toMatchObject({ diagnostic: { reason: "xmlLimitExceeded" } });
    expect(times.endedMs != null).toBe(delta <= 0);
  }
  const large = decodeMaterial({ ...context, headType: "VPWS50", encoding: "base64", compression: null, encodedBody: Buffer.alloc(8388608, 65), encodedByteLength: 8388608, headTest: { kind: "notProvided" }, envelopeStatus: { kind: "notProvided" } });
  expect(large.kind).toBe("rejected");
});

it("P1-T06 contractBoundary / AC11-13,15: all values/presences, B03 origins, and unobserved sources", () => {
  const absent = { kind: "notProvided" as const };
  const special = [absent, { kind: "missing" as const }, { kind: "invalid" as const, observed: "toString" }];
  const heads: OperationSourceEvidence<boolean>[] = [{ kind: "provided", value: false }, { kind: "provided", value: true }, ...special];
  const statuses: OperationSourceEvidence<Operation>[] = (["normal", "training", "test"] as const).map(value => ({ kind: "provided", value }));
  statuses.push(...special);
  for (const headTest of heads) for (const controlStatus of statuses) for (const envelopeStatus of statuses) {
    const e = { headTest, controlStatus, envelopeStatus };
    const all = Object.values(e);
    const real = [controlStatus, envelopeStatus].flatMap(s => s.kind === "provided" ? [s.value] : []);
    const reason = all.some(s => s.kind === "missing") ? "operationMissing" : all.some(s => s.kind === "invalid") ? "operationInvalid"
      : real.length === 0 ? "operationAmbiguous" : new Set(real).size > 1 || (headTest.kind === "provided" && headTest.value !== (real[0] !== "normal")) ? "operationMismatch" : null;
    const result = resolveOperation(e);
    expect(result).toMatchObject(reason == null ? { kind: "resolved", operation: real[0] } : { kind: "rejected", reason });
  }
  for (const origin of ["live", "recovery", "replay"] as const) {
    const entered = origin === "live" ? ingestXmlData({ ...context, origin, kind: "ws", frame: envelope(Buffer.from(base)) }) : ingestXmlData({ ...context, origin, kind: origin === "recovery" ? "rest" : "replay", body: Buffer.from(base), headType: "VPWS50" });
    if (entered.kind !== "accepted") throw Error("ingress");
    expect(entered.item.headTest.kind).toBe(origin === "live" ? "provided" : "notProvided");
    expect(decodeMaterial(entered.item)).toMatchObject({ kind: "decoded", material: { origin, operation: "normal" } });
  }
  for (const value of ["toString", "__proto__", "constructor"]) {
    expect(decode(base.replace("通常", value))).toMatchObject({ kind: "rejected", diagnostic: { reason: "operationInvalid" } });
    const entered = ws(envelope(Buffer.from(base), "VPWS50", { xmlReport: { control: { status: value } } }));
    if (entered.kind !== "accepted") throw Error("ingress");
    expect(decodeMaterial(entered.item)).toMatchObject({ diagnostic: { reason: "operationInvalid" } });
  }
  for (const format of ["json", "a/n", "binary", null]) expect(ws(envelope(Buffer.from(base), "VPWS50", { format }))).toMatchObject({ kind: "rejected", diagnostic: { reason: "formatUnsupported" } });
  for (const body of [base.replace("<Body/>", "<Body><x></y></Body>"), sizedXml(10485761)]) {
    const result = wsDecode(Buffer.from(body));
    if (result.kind !== "rejected") throw Error("unexpected acceptance");
    expect(result.diagnostic.operation).toEqual({ kind: "undetermined", sources: { headTest: { kind: "provided", value: false }, envelopeStatus: { kind: "provided", value: "normal" } } });
  }
  const broken = ws(envelope(Buffer.from(base), "VPWS50", { body: Buffer.from("broken gzip").toString("base64") }));
  if (broken.kind !== "accepted") throw Error("ingress");
  expect(decodeMaterial(broken.item)).toMatchObject({ kind: "rejected", diagnostic: { reason: "expandedBodyInvalid", operation: { kind: "undetermined" } } });
});

it("P1-T06 diagnostic boundary / RES08-10: stored evidence and escaped line/queue byte limits", () => {
  const scope = { exports: {}, require: () => ({ Buffer }), Buffer };
  const script = readFileSync("reconstruction/dist/src/diagnostics/parser-diagnostic.js", "utf8") + "\nexports.inspect = () => ({ diagnostics, diagnosticBytes });";
  runInNewContext(script, scope);
  const module = scope.exports as { recordParserDiagnostic: (d: unknown) => void; inspect: () => { diagnostics: string[]; diagnosticBytes: number } };
  for (let i = 0; i < 500; i++) module.recordParserDiagnostic({ inputId: "\u0000".repeat(9000), reason: "xmlInvalid", encodedByteLength: i, expandedByteLength: null, operation: { kind: "undetermined", sources: { headTest: { kind: "provided", value: false }, envelopeStatus: { kind: "invalid", observed: "toString" } } } });
  const saved = module.inspect();
  expect(saved.diagnostics.length).toBeLessThanOrEqual(256);
  expect(saved.diagnosticBytes).toBeLessThanOrEqual(1048576);
  for (const line of saved.diagnostics) {
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(8192);
    expect(JSON.parse(line)).toMatchObject({ reason: "xmlInvalid", truncationReason: "fieldLimit", expandedByteLength: null, operation: { kind: "undetermined", sources: { headTest: { kind: "provided", value: false }, envelopeStatus: { kind: "invalid", observed: "toString" } } } });
    expect(JSON.parse(line).operation.sources).not.toHaveProperty("controlStatus");
  }
});

it("P1-T07 acceptance / AC14: actual input/result transfer and null stage reasons", async () => {
  for (const [file, type] of [["15_18_01_250630_VPWS50", "VPWS50"], ["81_09_01_260605_VPWP50", "VPWP50"], ["synthetic_phase4a_VXSE53_special", "VXSE53"]]) {
    const frame = envelope(readFileSync(`test/fixtures/${file}.xml`), type);
    const record = await measure({ ...context, inputId: file, kind: "ws", frame }, file, api);
    expect(Object.values(record.marks).every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)).toBe(true);
    expect(record.unexecutedReasons).toEqual({});
    expect(record.transfer.inputBytes).toBeGreaterThan(500);
    expect(record.transfer.resultInputId).toBe(file);
    expect(record.transfer.resultNodes).toBe(record.nodes);
    if (type === "VPWS50") expect(record.nodes).toBe(155247);
  }
  const raw = await measure({ ...context, kind: "replay", headType: "VPWS50", body: Buffer.from(base) }, "raw", api);
  for (const key of ["ingressJsonMs", "base64DecodeMs", "decompressionMs"]) { expect(raw.marks[key]).toBeNull(); expect(raw.unexecutedReasons[key]).toBeTruthy(); }
});

it("A / AC05-07,10: references have identical semantic values and expanded character limits", () => {
  for (const reference of ["&#65;", "&#x41;", "&#x1F600;", "&amp;", "&lt;", "&gt;", "&apos;", "&quot;"]) {
    const character = reference === "&#65;" || reference === "&#x41;" ? "A" : reference === "&#x1F600;" ? "😀" : ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&apos;": "'", "&quot;": '"' })[reference]!;
    for (const attribute of [false, true]) for (const delta of [0, 1]) {
      const limit = attribute ? 256 : 16384;
      const value = reference.repeat(limit + delta);
      const times = parseTimes();
      const result = decode(base.replace("<Body/>", attribute ? `<Body a="${value}"/>` : `<Body>${value}</Body>`), times);
      expect(result.kind).toBe(delta === 0 ? "decoded" : "rejected");
      expect(times.endedMs != null).toBe(delta === 0);
      if (result.kind === "decoded") {
        const body = result.material.xml.children.find(n => n.kind === "element" && n.name === "Body");
        if (body?.kind !== "element") throw Error("Body");
        expect(attribute ? body.attributes[0].value : body.children.map(n => n.kind === "text" ? n.value : "").join("")).toBe(character.repeat(limit));
      } else expect(result.diagnostic.reason).toBe("xmlLimitExceeded");
    }
  }
  const semantic = decode(base.replace("通常", "&#36890;&#x5E38;").replace("<Body/>", "<Body><n>&#52;</n><n>&amp;#65;</n><n><![CDATA[&#65;&bogus;]]></n></Body>"));
  if (semantic.kind !== "decoded") throw Error("references");
  expect(semantic.material.operation).toBe("normal");
  expect(classifyMaterial(semantic.material).materialValues).toEqual(expect.arrayContaining([{ kind: "number", value: 4, raw: "4" }, { kind: "text", value: "&#65;", raw: "&#65;" }, { kind: "text", value: "&#65;&bogus;", raw: "&#65;&bogus;" }]));
});

it("B / AC15: undeclared entities and non-XML character references reject before full parse", () => {
  for (const value of ["&bogus;", "&#0;", "&#xD800;", "&#xDFFF;", "&#x110000;", "&#xFFFF;", "&#x1;", "&AMP;", "&#x;", "&amp", "\u0000"]) {
    for (const body of [`<Body>${value}</Body>`, `<Body a="${value}"/>`]) {
      const times = parseTimes();
      const result = decode(base.replace("<Body/>", body), times);
      expect(result).toMatchObject({ kind: "rejected", diagnostic: { reason: "xmlInvalid", operation: { kind: "undetermined" } } });
      expect(times.endedMs).toBeNull();
    }
  }
});

it("C / AC10,12: explicit transport metadata, unchanged body bytes and rejected fake headers", () => {
  for (const [field, reason, invalid] of [["encoding", "encodingUnsupported", ["binary", "toString", null]], ["compression", "compressionUnsupported", ["brotli", "__proto__", false]]] as const) {
    for (const value of invalid) expect(ws(envelope(Buffer.from(base), "VPWS50", { [field]: value }))).toMatchObject({ kind: "rejected", diagnostic: { reason } });
  }
  for (const prefix of ["UN\n", "UX\n"]) expect(decode(prefix + base)).toMatchObject({ kind: "rejected", diagnostic: { reason: "xmlInvalid" } });
  for (const kind of ["rest", "replay"] as const) {
    const entered = ingress(base, kind);
    if (entered.kind !== "accepted") throw Error("ingress");
    expect(entered.item).toMatchObject({ encoding: "utf-8", compression: null, encodedByteLength: Buffer.byteLength(base) });
    expect(entered.item.encodedBody).toEqual(Buffer.from(base));
  }
  const entered = ws(envelope(Buffer.from(base), "VPWS50", { encoding: "utf-8", compression: null, body: base }));
  if (entered.kind !== "accepted") throw Error("ingress");
  expect(entered.item).toMatchObject({ encoding: "utf-8", compression: null, encodedByteLength: Buffer.byteLength(base) });
  expect(entered.item.encodedBody).toEqual(Buffer.from(base));
  expect(decodeMaterial(entered.item).kind).toBe("decoded");
});

it("D / AC06: UTF-8 BOM is accepted and does not enter the XML tree", () => {
  const plain = decode(base);
  if (plain.kind !== "decoded") throw Error("decode");
  for (const kind of ["rest", "replay"] as const) {
    const entered = ingress(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(base)]), kind);
    if (entered.kind !== "accepted") throw Error("ingress");
    const result = decodeMaterial(entered.item);
    if (result.kind !== "decoded") throw Error("BOM");
    expect(result.material.xml).toEqual(plain.material.xml);
    expect(result.material.expandedByteLength).toBe(Buffer.byteLength(base) + 3);
  }
});

// P3-WL1-T02: 文字数えを Array.from から配列なしの数え方へ替えたので、.length（UTF-16 の数）との取り違えを境界で止める。
it("P3-WL1-T02 contractBoundary / P3-WL1-AC02: raw non-BMP, CDATA non-BMP and CRLF text count code points at below/exact/over", () => {
  const cases: Array<[string, number, (n: number) => string, (n: number) => string, boolean]> = [
    ["text", 16384, n => `<Body>${"😀".repeat(n)}</Body>`, n => "😀".repeat(n), false],
    // & を含む text は置換の後に数える（AC02 の近道でない側）。
    ["reference", 16384, n => `<Body>${"&#x1F600;".repeat(n)}</Body>`, n => "😀".repeat(n), false],
    ["attribute", 256, n => `<Body a="${"😀".repeat(n)}"/>`, n => "😀".repeat(n), true],
    ["cdata", 16384, n => `<Body><![CDATA[${"😀".repeat(n)}]]></Body>`, n => "😀".repeat(n), false],
    // \r\n は 2 文字と数え、parser の正規化で LF になる。
    ["crlf", 16384, n => `<Body>${"\r\n".repeat(Math.floor(n / 2))}${n % 2 ? "x" : ""}</Body>`, n => `${"\n".repeat(Math.floor(n / 2))}${n % 2 ? "x" : ""}`, false],
  ];
  for (const [label, limit, body, value, attribute] of cases) for (const delta of [-1, 0, 1]) {
    const times = parseTimes();
    const result = decode(base.replace("<Body/>", body(limit + delta)), times);
    expect(result.kind, `${label}/${delta}`).toBe(delta > 0 ? "rejected" : "decoded");
    expect(times.endedMs != null, `${label}/${delta}`).toBe(delta <= 0);
    if (result.kind === "rejected") { expect(result.diagnostic.reason).toBe("xmlLimitExceeded"); continue; }
    const node = result.material.xml.children.find(n => n.kind === "element" && n.name === "Body");
    if (node?.kind !== "element") throw Error("Body");
    expect(attribute ? node.attributes[0].value : node.children.map(n => n.kind === "text" ? n.value : "").join(""), `${label}/${delta}`)
      .toBe(value(limit + delta));
  }
});

// P3-WL2-T02: 速い経路（FXP 5.5.8 の parseXml と xmlNode の写し）が corpus に無い構文で旧と同じ結果になることと、通る経路を表で示す。
// 期待は baseOid（b05f4a5d）の dist で取った値。path: fast＝旧の経路に入らない、fallback＝XMLParser.parse 1 回（旧の経路で処理し直す）、
// pre＝組立てに入らない事前拒否。速い経路は実電文に出る形（要素・属性・text・コメント・実体参照・最上位の XML 宣言）だけを扱い、
// PI（宣言以外）・CDATA・危険な名前と critical 名は旧の経路へ戻す（D5・D6・D4、Q-WL2-IMPL-AMEND）。fallback の行の木と理由は旧の挙動そのもの。木は Report の子を [名前, 属性, 子]（text は文字列）の形で、sort・trim・繋ぎ直しなしに比べる。
type Shape = string | [string, [string, string][], Shape[]];
const shapeOf = (node: XmlNode): Shape => node.kind === "text" ? node.value
  : [node.name, node.attributes.map((attribute): [string, string] => [attribute.name, attribute.value]), node.children.map(shapeOf)];
const R2 = (body: string, status = "通常") => `<Report><Control><Status>${status}</Status></Control><Head><EventID>001</EventID></Head>${body}</Report>`;
const H: Shape[] = [["Control", [], [["Status", [], ["通常"]]]], ["Head", [], [["EventID", [], ["001"]]]]];
const B = (children: Shape[], attributes: [string, string][] = []): Shape[] => [...H, ["Body", attributes, children]];
const hide = (payload: string, quote = '"') => `<?p a=${quote}?> <!--${quote}?>${payload}-->`;
const hiddenPi: Shape = ["?p", [["a", "?> <!--"]], [""]];
type Expected = Shape[] | { reason: string; ended: boolean };
const boundaryRows: Array<[string, string, "fast" | "fallback" | "pre", Expected]> = [
  // D5: CDATA は旧の経路へ戻す。
  ["cdataMixed", R2("<Body><![CDATA[a&b]]c<!--d\r\ne\rf]]></Body>"), "fallback", B(["a&b]]c<!--d\ne\nf"])],
  ["cdataEmpty", R2("<Body><![CDATA[]]></Body>"), "fallback", B([""])],
  ["cdataAdjacent", R2("<Body><![CDATA[a]]><![CDATA[b]]></Body>"), "fallback", B(["a", "b"])],
  ["textCommentText", R2("<Body>a<!--c-->b</Body>"), "fast", B(["ab"])],
  ["nestedCommentOpen", R2("<Body>a<!--x<!--y-->b</Body>"), "fast", B(["ab"])],
  ["textCommentCdataText", R2("<Body>a<!--c-->b<![CDATA[d]]>e<!--f-->g</Body>"), "fallback", B(["ab", "d", "eg"])],
  ["crAndCrlf", R2('<Body a="x\ry\r\nz">p\rq\r\nr</Body>'), "fast", B(["p\nq\nr"], [["a", "x\ny\nz"]])],
  ["crOnly", R2("<Body>\r</Body>"), "fast", B(["\n"])],
  ["characterReference13", R2('<Body a="&#13;">&#13;</Body>'), "fast", B(["\r"], [["a", "\r"]])],
  ["attributeTabNewline", R2('<Body a="x\ty\nz"/>'), "fast", B([], [["a", "x\ty\nz"]])],
  ["tabInTag", R2('<Body\ta="1"\t/>'), "fast", B([], [["a", "1"]])],
  ["closeWithSpace", R2("<Body></Body >"), "fast", B([])],
  ["multibyte", R2('<本文 属性="値">日本語😀</本文>'), "fast", [...H, ["本文", [["属性", "値"]], ["日本語😀"]]]],
  ["references", R2('<Body a="&#0065;&#x1F600;&amp;">&#00065;&#x1F600;&lt;&gt;&quot;&apos;</Body>'), "fast", B(["A😀<>\"'"], [["a", "A😀&"]])],
  ["attributeQuotes", R2(`<Body a = 'x"y' b="a>b<c"/>`), "fast", B([], [["a", 'x"y'], ["b", "a>b<c"]])],
  ["attributeCase", R2('<Body a="1" A="2"/>'), "fast", B([], [["a", "1"], ["A", "2"]])],
  ["prefixedNames", R2('<jmx:Body xmlns:jmx="urn:x" jmx:a="1"/>'), "fast", [...H, ["jmx:Body", [["xmlns:jmx", "urn:x"], ["jmx:a", "1"]], []]]],
  ["emptyForms", R2("<Body><A/><A /><A></A></Body>"), "fast", B([["A", [], []], ["A", [], []], ["A", [], []]])],
  ["whitespaceText", R2("<Body> \n\t </Body>"), "fast", B([" \n\t "])],
  ["longCommentAndPi", R2(`<Body><!--${"x".repeat(200_000)}--><?p ${"y".repeat(70_000)}?></Body>`), "fallback", B([["?p", [], [""]]])],
  ["textAtLimit", R2(`<Body>${"x".repeat(16_384)}</Body>`), "fast", B(["x".repeat(16_384)])],
  ["secondReportSelf", `${R2("<Body/>")}<Report/>`, "fast", B([])],
  ["leadingOtherRoot", `<X/>tail${R2("<Body/>")}`, "fast", B([])],
  ["textWithCdataEnd", R2("<Body>a]]>b</Body>"), "fast", B(["a]]>b"])],
  // 最上位の XML 宣言（実電文の形）とコメントは速い経路で読み飛ばす。宣言の形が違えば（タブ・単引用符）旧の経路へ戻す（D5）。
  ["outsideDeclarationComment", `<?xml version="1.0" encoding="UTF-8" standalone="no" ?><!--c-->${R2("<Body/>")}<!--d-->`, "fast", B([])],
  ["declarationTab", `<?xml\tversion="1.0"?>${R2("<Body/>")}`, "fallback", B([])],
  ["declarationSingleQuote", `<?xml version='1.0'?>${R2("<Body/>")}`, "fallback", B([])],
  ["outsideDeclarationPiComment", `<?xml version="1.0" encoding="UTF-8"?><!--c--><?p a="1"?>${R2("<Body/>")}<!--d--><?q?>`, "fallback", B([])],
  // D5: 宣言以外の PI は Report の外でも旧の経路へ戻す。旧は Report の外の値を展開しないので、外の PI の不正な実体は拒否にならない。
  ["outsidePiBogus", `<?p a="&bogus;"?>${R2("<Body/>")}`, "fallback", B([])],
  // D5: 旧は Report の中の PI（XML 宣言を含む）を名前 "?name" の要素にし、擬似属性と値 "" の text を子に持たせる。
  ["innerXmlDeclaration", R2('<Body><?xml version="1.0"?></Body>'), "fallback", B([["?xml", [["version", "1.0"]], [""]]])],
  ["innerPi", R2(`<Body>a<?p?>b<?q a="1" b='2'?></Body>`), "fallback", B(["a", ["?p", [], [""]], "b", ["?q", [["a", "1"], ["b", "2"]], [""]]])],
  ["piInHead", "<Report><Control><Status>通常</Status></Control><Head><EventID>001<?p?></EventID></Head><Body/></Report>", "fallback",
    [H[0], ["Head", [], [["EventID", [], ["001", ["?p", [], [""]]]]]], ["Body", [], []]]],
  // 旧の挙動を写す: 名前は \s（﻿ を含む）の前で切り、残りは値の無い属性として捨てる。
  ["bomInName", R2("<Body><A﻿B/></Body>"), "fast", B([["A", [], []]])],
  // D6: 旧は危険な名前に "__" を付けて改名し、改名先と衝突すると属性 1 つにまとめる（後の値が先の位置）。7 つと critical 名 3 つは
  // 要素と属性の両方の形で旧の経路へ戻る（critical 名は旧が組立ての中で例外にする、D4）。
  ["dangerousNames", R2('<Body><toString hasOwnProperty="1" valueOf="2">x</toString><__defineGetter__/><__defineSetter__/><__lookupGetter__/><__lookupSetter__/></Body>'), "fallback",
    B([["__toString", [["__hasOwnProperty", "1"], ["__valueOf", "2"]], ["x"]], ["____defineGetter__", [], []], ["____defineSetter__", [], []], ["____lookupGetter__", [], []], ["____lookupSetter__", [], []]])],
  ...(["hasOwnProperty", "toString", "valueOf", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]).flatMap((name): Array<[string, string, "fallback", Expected]> => [
    [`nameElement:${name}`, R2(`<Body><${name}/></Body>`), "fallback", B([[`__${name}`, [], []]])],
    [`nameAttribute:${name}`, R2(`<Body ${name}="1"/>`), "fallback", B([], [[`__${name}`, "1"]])]]),
  ...(["__proto__", "constructor", "prototype"]).flatMap((name): Array<[string, string, "fallback", Expected]> => [
    [`nameElement:${name}`, R2(`<Body><${name}/></Body>`), "fallback", { reason: "xmlInvalid", ended: false }],
    [`nameAttribute:${name}`, R2(`<Body ${name}="1"/>`), "fallback", { reason: "xmlInvalid", ended: false }]]),
  // Codex の反例（実装の品質レビュー 1 巡目）: 旧は PI の引用符の外のタブを空白にしてから擬似属性を読むので、値はタブでなく空白（D5）。
  ["piTabsCodex", "<Report><Control><Status>通常</Status></Control><Head/><Body><?p '='\t''?></Body></Report>", "fallback",
    [H[0], ["Head", [], []], ["Body", [], [["?p", [["'", " "]], [""]]]]]],
  ["renameCollision", R2('<Body toString="1" __toString="2"/>'), "fallback", B([], [["__toString", "2"]])],
  ["renameCollisionReversed", R2('<Body __toString="2" toString="1"/>'), "fallback", B([], [["__toString", "1"]])],
  // 旧の挙動を写す: 閉じタグは名前を見ずに 1 段戻るので、</A/> の後の Body は最上位（Report の外）へ出る。
  ["overPopOne", "<Report><Control><Status>通常</Status></Control></A/><Body/></Report>", "fast", [H[0]]],
  ["duplicateAttribute", R2('<Body a="1" a="2"/>'), "pre", { reason: "xmlInvalid", ended: false }],
  ["valuelessAttribute", R2("<Body a/>"), "pre", { reason: "xmlInvalid", ended: false }],
  ["unquotedAttribute", R2("<Body a=1/>"), "pre", { reason: "xmlInvalid", ended: false }],
  ["mismatchedClose", R2("<Body><x></y></Body>"), "pre", { reason: "xmlInvalid", ended: false }],
  ["truncated", R2("<Body/>").slice(0, -5), "pre", { reason: "xmlInvalid", ended: false }],
  ["outsideText", `x${R2("<Body/>")}`, "pre", { reason: "xmlInvalid", ended: false }],
  ["doctype", `<!DOCTYPE Report>${R2("<Body/>")}`, "pre", { reason: "xmlInvalid", ended: false }],
  ["secondReportPair", `${R2("<Body/>")}<Report></Report>`, "pre", { reason: "xmlInvalid", ended: false }],
  ["noReportRoot", "<Foo/>", "fast", { reason: "xmlInvalid", ended: true }],
  ["prefixedRoot", "<jmx:Report/>", "fast", { reason: "xmlInvalid", ended: true }],
  // 以下も変な形で、検出の規則に当たり、旧の経路で処理し直す（作者裁定 2026-10-09 の 2 本目、P3-WL2-AC01）。
  // D5: PI の引用符の中の ?> と <?>（limits・validator の PI の区切りと旧の組立ての区切りがずれる）。
  ["piQuoteInStatus", '<Report><Control><Status>通<?p a="?>"?>常</Status></Control><Head/><Body/></Report>', "fallback",
    [["Control", [], [["Status", [], ["通", ["?p", [["a", "?>"]], [""]], "常"]]]], ["Head", [], []], ["Body", [], []]]],
  ["piQuoteSingle", "<Report><Control><Status>通<?p a='?>'?>常</Status></Control><Head/><Body/></Report>", "fallback",
    [["Control", [], [["Status", [], ["通", ["?p", [["a", "?>"]], [""]], "常"]]]], ["Head", [], []], ["Body", [], []]]],
  ["piQuoteWithTag", R2('<Body><?p a="?> <A/> "?></Body>'), "fallback", B([["?p", [["a", "?> <A/> "]], [""]]])],
  ["emptyPi", "<Report><Control><Status>通常</Status></Control><Head/><Body><?><?p?></Body></Report>", "fallback",
    [H[0], ["Head", [], []], ["Body", [], [["", [], [""]], ["?p", [], [""]]]]]],
  ["emptyPiOutside", "<?><?p?><Report><Control><Status>通常</Status></Control><Head/><Body/></Report>", "fallback", [H[0], ["Head", [], []], ["Body", [], []]]],
  // D5: 旧の区切りではコメントの中に隠した DOCTYPE・特殊名が組立てに届く（速い経路は最初の ?> で PI を終えるので届かない）。
  ["hiddenDoctype", R2(`<Body>${hide("<!DOCTYPE Report>")}</Body>`), "fallback", B([hiddenPi, "-->"])],
  ["hiddenInternalDtd", R2(`<Body>${hide("<!DOCTYPE Report [<!ELEMENT Report ANY>]>")}</Body>`), "fallback", B([hiddenPi, "-->"])],
  ["hiddenTextKey", R2(`<Body>${hide("<#text/>")}</Body>`), "fallback", B([hiddenPi, "-->"])],
  ["hiddenCdataKey", R2(`<Body>${hide("<#cdata/>")}</Body>`), "fallback", B([hiddenPi, "", "-->"])],
  ["hiddenAttributeKey", R2(`<Body>${hide("<:@/>")}</Body>`), "fallback", B([hiddenPi, "-->"])],
  ["hiddenXmlRootName", R2(`<Body>${hide("<!xml>before<A/>after</!xml>")}</Body>`), "fallback", B([hiddenPi, ["!xml", [], [["A", [], []], "after"]], "-->"])],
  ["hiddenDiscardedSubtree", R2(`<Body>${hide('<:@><A a="&bogus;"/></:@>')}</Body>`), "fallback", B([hiddenPi, "-->"])],
  // D5 で旧の経路へ戻り、組立ての後の運用区分の判定で拒否（endedMs あり）。
  ["postOperationPi", '<Report><Control><Status>xxx</Status></Control><Head/><Body><?p a="?>"?></Body></Report>', "fallback", { reason: "operationInvalid", ended: true }],
  // D4: 旧が組立ての中で例外にする（不正な実体・閉じない引用符・critical 名・棚が空の後の要素）。理由は旧の経路が決める。
  ["piBogusEntity", R2('<Body><?p a="&bogus;"?></Body>'), "fallback", { reason: "xmlInvalid", ended: false }],
  ["piUnclosedQuote", R2('<Body><?p a="?></Body>'), "fallback", { reason: "xmlInvalid", ended: false }],
  ["piCritical", R2('<Body><?p constructor="x"?></Body>'), "fallback", { reason: "xmlInvalid", ended: false }],
  ["piCriticalOutside", `<?p constructor="x"?>${R2("<Body/>")}`, "fallback", { reason: "xmlInvalid", ended: false }],
  ["criticalElement", R2("<Body><constructor/></Body>"), "fallback", { reason: "xmlInvalid", ended: false }],
  ["criticalAttribute", R2('<Body prototype="1"/>'), "fallback", { reason: "xmlInvalid", ended: false }],
  ["criticalElementOutside", `<constructor/>${R2("<Body/>")}`, "fallback", { reason: "xmlInvalid", ended: false }],
  ["criticalAttributeOutside", `<X __proto__="1"/>${R2("<Body/>")}`, "fallback", { reason: "xmlInvalid", ended: false }],
  ["criticalLaterElement", `${R2("<Body/>")}<prototype/>`, "fallback", { reason: "xmlInvalid", ended: false }],
  ["bomCritical", R2("<Body><A﻿constructor/></Body>"), "fallback", { reason: "xmlInvalid", ended: false }],
  ["overPopThenElement", "<Report><Control><Status>通常</Status></Control></A/></B/><Body/></Report>", "fallback", { reason: "xmlInvalid", ended: false }],
];

it("P3-WL2-T02 contractBoundary / P3-WL2-AC03,AC04: corpus に無い構文で旧と同じ木・拒否と、通る経路", () => {
  const parse = vi.spyOn(XMLParser.prototype, "parse");
  for (const [label, xml, path, expected] of boundaryRows) {
    parse.mockClear();
    const times = parseTimes();
    const result = decode(xml, times);
    expect(parse.mock.calls.length, label).toBe(path === "fallback" ? 1 : 0);
    if (Array.isArray(expected)) {
      if (result.kind !== "decoded") throw Error(`${label}: ${result.kind}`);
      expect(result.material.xml.children.map(shapeOf), label).toEqual(expected);
    } else {
      expect({ reason: result.kind === "rejected" ? result.diagnostic.reason : result.kind, ended: times.endedMs != null }, label).toEqual(expected);
    }
  }
});
