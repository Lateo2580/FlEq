// P3-WL2-AC08: decodeMaterial の木の組立てを旧と新の両方に必ず当て、結果そのものを比べる差分の確かめ（測定用、製品からは import しない）。
// 入力は corpus 全件・境界（P3-WL2-AC03）・corpus を種にした決まった seed の変異。判定は同じ／失敗の 2 つだけで、失敗 1 件で exit 1。
//
// 使い方（reconstruction の tsc の後に、repo の root で）:
//   node reconstruction/tools/parse-diff/tree-diff.mjs [--base DIR] [--seeds 20261009,1,2] [--count 100000] [--variant NAME]
//   --base DIR  比べる相手 (a): baseOid で作った reconstruction/dist の写し。省くと (b): 同じ script の中の旧の組立て
//               （FXP の XMLParser と baseOid の xmlNode の写し）へ、変更後の dist の組立てを差し替えたもの
//   --variant   負の対照（使い捨ての写しを読み込みの時に作る）: nodetect＝検出の名前の確かめ（D3・D4・D6）と D5 の PI の確かめを外す
//               （PI は読み飛ばす）、fastonly＝旧の経路へ戻さない。どちらも失敗を表示して exit 1 になるのが正しい
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(join(root, "package.json"));
const argument = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1]; };
const baseDist = argument("base", null);
const variant = argument("variant", "new");
const seeds = argument("seeds", "20261009,1,2").split(",").map(Number);
const count = Number(argument("count", "100000"));
if (!["new", "nodetect", "fastonly"].includes(variant)) throw new Error(`unknown variant ${variant}`);
const newDist = join(root, "reconstruction/dist");

// 旧の組立ての写し（baseOid b05f4a5d の decode-material.ts の xmlValue・attributes・xmlNode・parseTree）。(b) の旧の側で使う。
const { XMLParser } = require("fast-xml-parser");
const ENTITIES = new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["apos", "'"], ["quot", '"']]);
function oldXmlValue(raw) {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|apos|quot);|&/g, (_match, reference) => {
    if (reference == null) throw new Error("xmlInvalid");
    if (reference[0] !== "#") return ENTITIES.get(reference);
    const point = reference[1] === "x" ? Number.parseInt(reference.slice(2), 16) : Number(reference.slice(1));
    if (!(point === 9 || point === 10 || point === 13 || (point >= 0x20 && point <= 0xd7ff) || (point >= 0xe000 && point <= 0xfffd) || (point >= 0x10000 && point <= 0x10ffff))) throw new Error("xmlInvalid");
    return String.fromCodePoint(point);
  });
}
function oldAttributes(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).map(([name, attribute]) => ({ name, value: oldXmlValue(String(attribute)) }));
}
function oldXmlNode(value) {
  if (Array.isArray(value["#cdata"])) return { kind: "text", value: value["#cdata"].map((node) => String(node["#text"] ?? "")).join("") };
  const entry = Object.entries(value).find(([name]) => name !== ":@" && name !== "#text");
  if (entry == null) return typeof value["#text"] === "string" ? { kind: "text", value: oldXmlValue(value["#text"]) } : null;
  const [name, nested] = entry;
  if (!Array.isArray(nested)) return null;
  const children = nested.flatMap((child) => {
    if (child == null || typeof child !== "object" || Array.isArray(child)) return [];
    const result = oldXmlNode(child);
    return result == null ? [] : [result];
  });
  return { kind: "element", name, attributes: oldAttributes(value[":@"]), children };
}
function oldParseTree(xml) {
  const parsed = new XMLParser({ jPath: false, preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", textNodeName: "#text", cdataPropName: "#cdata", processEntities: false, trimValues: false, parseTagValue: false, parseAttributeValue: false }).parse(xml);
  const source = Array.isArray(parsed) ? parsed.find((node) => node != null && typeof node === "object" && "Report" in node) : null;
  if (source == null) return null;
  const tree = oldXmlNode(source);
  return tree != null && tree.kind === "element" ? tree : null;
}

// 読み込んだ source の組立ての入口を包み、回数（calls）・例外（error）・旧の経路の回数（fallbacks）を取る。製品に注入の口は足さない。
function replaceOnce(source, from, to) {
  const parts = source.split(from);
  if (parts.length !== 2) throw new Error(`anchor not found once: ${from}`);
  return parts.join(to);
}
function load(dist, side) {
  const file = join(dist, "src/decode-material/decode-material.js");
  let source = readFileSync(file, "utf8");
  const entry = (call) => `{ __probe.calls++; try { return ${call}; } catch (error) { __probe.error = true; throw error; } }\n`;
  if (side === "base") {
    // baseOid の dist は parseTree が組立ての入口。
    source = replaceOnce(source, "function parseTree(xml) {", `function parseTree(xml) ${entry("__baseParseTree(xml)")}function __baseParseTree(xml) {`);
  } else {
    const call = side === "oldCopy" ? "__probe.oldParseTree(xml)" : side === "fastonly" ? "fastTree(xml)" : "__buildTree(xml)";
    source = replaceOnce(source, "function buildTree(xml) {", `function buildTree(xml) ${entry(call)}function __buildTree(xml) {`);
    source = replaceOnce(source, "function parseTree(xml) {", "function parseTree(xml) { __probe.fallbacks++; return __parseTree(xml); }\nfunction __parseTree(xml) {");
    if (side === "nodetect") {
      source = replaceOnce(source, 'if (end < 0 || current !== "top" || !XML_DECLARATION.test(xml.slice(lt + 2, end)))', "if (end < 0)");
      const removed = source.replace(/if \(OLD_PATH_NAMES\.has\(name\)\)\s*fallback\(\);/, "");
      if (removed === source) throw new Error("name anchor not found");
      source = removed;
    }
  }
  // "use strict" を先頭に残すため、__probe は末尾で宣言する（組立てが呼ばれるのは読み込みの後）。
  source += "\nconst __probe = { calls: 0, fallbacks: 0, error: false, oldParseTree: null };\nmodule.exports.__probe = __probe;\n";
  const loaded = new Module(`${file}#${side}`);
  loaded.filename = file;
  // baseOid の写しは repo の外に置くので、fast-xml-parser はこの checkout の node_modules から解決する（lock の版）。
  loaded.paths = Module._nodeModulePaths(join(newDist, "src/decode-material"));
  loaded._compile(source, file);
  loaded.exports.__probe.oldParseTree = oldParseTree;
  return loaded.exports;
}

const oldApi = baseDist == null ? load(newDist, "oldCopy") : load(resolve(baseDist), "base");
const newApi = load(newDist, variant);
const { ingestXmlData } = require(join(newDist, "src/ingress/ingress.js"));

function run(api, xml) {
  const entered = ingestXmlData({ inputId: "tree-diff", inputSequence: 1, receivedAt: 0, origin: "replay", kind: "replay", headType: "VPWS50", body: Buffer.from(xml) });
  if (entered.kind !== "accepted") return { result: { ingress: entered.diagnostic.reason }, stage: "ingress", calls: 0, fellBack: false };
  const times = { startedMs: null, endedMs: null };
  Object.assign(api.__probe, { calls: 0, fallbacks: 0, error: false });
  let decoded;
  try { decoded = api.decodeMaterial(entered.item, times); } catch (error) { return { result: { threw: String(error?.message) }, stage: "threw", calls: api.__probe.calls, fellBack: false }; }
  const parse = { started: times.startedMs != null, ended: times.endedMs != null };
  // 段は組立ての入口の回数で分ける: 入らない＝事前、入って例外＝組立て、入って返った後の拒否＝組立て後（root・運用区分）。
  const { calls, fallbacks, error } = api.__probe;
  const stage = calls === 0 ? "pre" : error ? "builder" : decoded.kind === "rejected" ? "post" : "decoded";
  if (decoded.kind === "rejected") return { result: { kind: decoded.kind, diagnostic: decoded.diagnostic, parse }, stage, calls, fellBack: fallbacks > 0 };
  const { marks, ...material } = decoded.material;
  // marks は所要時間を除き、key と null の別だけを比べる。
  const markShape = Object.fromEntries(Object.entries(marks).map(([key, value]) => [key, value == null ? null : "number"]));
  return { result: { kind: decoded.kind, material, markShape, parse }, stage, calls, fellBack: fallbacks > 0 };
}

const R = (body, status = "通常") => `<Report><Control><Status>${status}</Status></Control><Head><EventID>001</EventID></Head>${body}</Report>`;
const hide = (payload, quote = '"') => `<?p a=${quote}?> <!--${quote}?>${payload}-->`;
// P3-WL2-AC03 の境界の入力（試験 P3-WL2-T02 と同じ行）と、P3-WL1-AC06(1) の理由の優先の入力。
const edges = [
  ["cdataMixed", R("<Body><![CDATA[a&b]]c<!--d\r\ne\rf]]></Body>")],
  ["cdataEmpty", R("<Body><![CDATA[]]></Body>")],
  ["cdataAdjacent", R("<Body><![CDATA[a]]><![CDATA[b]]></Body>")],
  ["textCommentText", R("<Body>a<!--c-->b</Body>")],
  ["nestedCommentOpen", R("<Body>a<!--x<!--y-->b</Body>")],
  ["textCommentCdataText", R("<Body>a<!--c-->b<![CDATA[d]]>e<!--f-->g</Body>")],
  ["crAndCrlf", R('<Body a="x\ry\r\nz">p\rq\r\nr</Body>')],
  ["crOnly", R("<Body>\r</Body>")],
  ["characterReference13", R('<Body a="&#13;">&#13;</Body>')],
  ["attributeTabNewline", R('<Body a="x\ty\nz"/>')],
  ["tabInTag", R('<Body\ta="1"\t/>')],
  ["closeWithSpace", R("<Body></Body >")],
  ["multibyte", R('<本文 属性="値">日本語😀</本文>')],
  ["references", R('<Body a="&#0065;&#x1F600;&amp;">&#00065;&#x1F600;&lt;&gt;&quot;&apos;</Body>')],
  ["attributeQuotes", R(`<Body a = 'x"y' b="a>b<c"/>`)],
  ["attributeCase", R('<Body a="1" A="2"/>')],
  ["prefixedNames", R('<jmx:Body xmlns:jmx="urn:x" jmx:a="1"/>')],
  ["emptyForms", R("<Body><A/><A /><A></A></Body>")],
  ["whitespaceText", R("<Body> \n\t </Body>")],
  ["longCommentAndPi", R(`<Body><!--${"x".repeat(200_000)}--><?p ${"y".repeat(70_000)}?></Body>`)],
  ["textAtLimit", R(`<Body>${"x".repeat(16_384)}</Body>`)],
  ["secondReportSelf", `${R("<Body/>")}<Report/>`],
  ["leadingOtherRoot", `<X/>tail${R("<Body/>")}`],
  ["textWithCdataEnd", R("<Body>a]]>b</Body>")],
  ["outsideDeclarationComment", `<?xml version="1.0" encoding="UTF-8" standalone="no" ?><!--c-->${R("<Body/>")}<!--d-->`],
  ["outsideDeclarationPiComment", `<?xml version="1.0" encoding="UTF-8"?><!--c--><?p a="1"?>${R("<Body/>")}<!--d--><?q?>`],
  ["declarationTab", `<?xml\tversion="1.0"?>${R("<Body/>")}`],
  ["declarationSingleQuote", `<?xml version='1.0'?>${R("<Body/>")}`],
  ["outsidePiBogus", `<?p a="&bogus;"?>${R("<Body/>")}`],
  ["innerXmlDeclaration", R('<Body><?xml version="1.0"?></Body>')],
  ["innerPi", R(`<Body>a<?p?>b<?q a="1" b='2'?></Body>`)],
  ["piInHead", "<Report><Control><Status>通常</Status></Control><Head><EventID>001<?p?></EventID></Head><Body/></Report>"],
  ["bomInName", R("<Body><A﻿B/></Body>")],
  ["dangerousNames", R('<Body><toString hasOwnProperty="1" valueOf="2">x</toString><__defineGetter__/><__defineSetter__/><__lookupGetter__/><__lookupSetter__/></Body>')],
  ...["hasOwnProperty", "toString", "valueOf", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "__proto__", "constructor", "prototype"]
    .flatMap((name) => [[`nameElement:${name}`, R(`<Body><${name}/></Body>`)], [`nameAttribute:${name}`, R(`<Body ${name}="1"/>`)]]),
  ["piTabsCodex", "<Report><Control><Status>通常</Status></Control><Head/><Body><?p '='\t''?></Body></Report>"],
  ["renameCollision", R('<Body toString="1" __toString="2"/>')],
  ["renameCollisionReversed", R('<Body __toString="2" toString="1"/>')],
  ["overPopOne", "<Report><Control><Status>通常</Status></Control></A/><Body/></Report>"],
  ["duplicateAttribute", R('<Body a="1" a="2"/>')],
  ["valuelessAttribute", R("<Body a/>")],
  ["unquotedAttribute", R("<Body a=1/>")],
  ["mismatchedClose", R("<Body><x></y></Body>")],
  ["truncated", R("<Body/>").slice(0, -5)],
  ["outsideText", `x${R("<Body/>")}`],
  ["doctype", `<!DOCTYPE Report>${R("<Body/>")}`],
  ["secondReportPair", `${R("<Body/>")}<Report></Report>`],
  ["noReportRoot", "<Foo/>"],
  ["prefixedRoot", "<jmx:Report/>"],
  ["piQuoteInStatus", '<Report><Control><Status>通<?p a="?>"?>常</Status></Control><Head/><Body/></Report>'],
  ["piQuoteSingle", "<Report><Control><Status>通<?p a='?>'?>常</Status></Control><Head/><Body/></Report>"],
  ["piQuoteWithTag", R('<Body><?p a="?> <A/> "?></Body>')],
  ["emptyPi", "<Report><Control><Status>通常</Status></Control><Head/><Body><?><?p?></Body></Report>"],
  ["emptyPiOutside", "<?><?p?><Report><Control><Status>通常</Status></Control><Head/><Body/></Report>"],
  ["hiddenDoctype", R(`<Body>${hide("<!DOCTYPE Report>")}</Body>`)],
  ["hiddenInternalDtd", R(`<Body>${hide("<!DOCTYPE Report [<!ELEMENT Report ANY>]>")}</Body>`)],
  ["hiddenTextKey", R(`<Body>${hide("<#text/>")}</Body>`)],
  ["hiddenCdataKey", R(`<Body>${hide("<#cdata/>")}</Body>`)],
  ["hiddenAttributeKey", R(`<Body>${hide("<:@/>")}</Body>`)],
  ["hiddenXmlRootName", R(`<Body>${hide("<!xml>before<A/>after</!xml>")}</Body>`)],
  ["hiddenDiscardedSubtree", R(`<Body>${hide('<:@><A a="&bogus;"/></:@>')}</Body>`)],
  ["postOperationPi", '<Report><Control><Status>xxx</Status></Control><Head/><Body><?p a="?>"?></Body></Report>'],
  ["piBogusEntity", R('<Body><?p a="&bogus;"?></Body>')],
  ["piUnclosedQuote", R('<Body><?p a="?></Body>')],
  ["piCritical", R('<Body><?p constructor="x"?></Body>')],
  ["piCriticalOutside", `<?p constructor="x"?>${R("<Body/>")}`],
  ["criticalElement", R("<Body><constructor/></Body>")],
  ["criticalAttribute", R('<Body prototype="1"/>')],
  ["criticalElementOutside", `<constructor/>${R("<Body/>")}`],
  ["criticalAttributeOutside", `<X __proto__="1"/>${R("<Body/>")}`],
  ["criticalLaterElement", `${R("<Body/>")}<prototype/>`],
  ["bomCritical", R("<Body><A﻿constructor/></Body>")],
  ["overPopThenElement", "<Report><Control><Status>通常</Status></Control></A/></B/><Body/></Report>"],
  ["priorityTextBareAmpersand", R(`<Body>${"x".repeat(16_385)}&</Body>`)],
  ["priorityTextBadReference", R(`<Body>${"x".repeat(16_385)}&#0;</Body>`)],
  ["priorityAttributeBadReference", R(`<Body a="${"x".repeat(257)}&bogus;"/>`)],
];

// 決まった seed の擬似乱数（mulberry32）。
function rng(state) {
  return () => { state |= 0; state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// 前処理（limits・validator）と組立てで読み方がずれる複合の型: PI の引用符の中の ?> の後のコメントに隠した markup。
const templates = ["<!DOCTYPE Report>", "<!DOCTYPE Report [<!ELEMENT Report ANY>]>", "<#text/>", "<#cdata/>", "<:@/>", "<!xml>x<A/>y</!xml>", '<:@><A a="&bogus;"/></:@>',
  '<A a="&bogus;"/>', "<constructor/>", '<A prototype="1"/>', "<toString/>", '<A toString="1" __toString="2"/>', "</A>", "<A>", "<![CDATA[x]]>", "<?q?>", '<?q a="&bogus;"?>']
  .flatMap((payload) => [hide(payload), hide(payload, "'")]);
// PI の引用符の外のタブ（FXP は空白にしてから擬似属性を読む）と引用符の組み合わせ（Codex の反例の型）。
const piTabs = ["<?p '='\t''?>", '<?p "="\t""?>', "<?p a='1'\tb='2'?>", "<?p a=\t'x'?>", "<?p '\t'='\t'?>", "<?p\ta='x'\t?>", "<?xml\tversion='1.0'?>", "<?p '=\"'\t'\"'?>"];
const snippets = [...templates, ...piTabs, '<!--<?p a="-->"?>-->', '<?p a="<!--"?>', '<?p a="<![CDATA["?>', '<?p a="]]>"?>', "<??>", "<?>", "<?><?p?>",
  "<?p?>", '<?p a="1"?>', '<?p a="?>"?>', "<?p a='?>'?>", '<?p a="&bogus;"?>', '<?p constructor="x"?>', '<?p toString="1" __toString="2"?>', '<?xml version="1.0"?>', '<?p a="<A/>"?>',
  "<!--x-->", "<!--x<!--y-->", "<!---->", "<!--a>b-->",
  "<![CDATA[a]]>", "<![CDATA[]]>", "<![CDATA[\r\nx]]>", "<![CDATA[&amp;<]]>",
  "</A/>", "</X>", "<A/>", "<A />", "<A></A>", "<toString/>", "<valueOf>1</valueOf>", "<constructor/>", '<A __proto__="1"/>', '<A toString="1" __toString="2"/>', '<A a="1" a="2"/>', "<A﻿B/>", "<A　B/>", "<A﻿constructor/>",
  "&amp;", "&#x41;", "&#0065;", "&bogus;", "&", "﻿", "\r", "\r\n", "\t", '"', "'", ">", "<", "]]>", "😀", " ",
];
const corpus = JSON.parse(readFileSync(join(root, "reconstruction/tools/corpus/manifest.json"), "utf8")).fixtures
  .map((fixture) => fixture.path).filter((path) => path.endsWith(".xml")).map((path) => [path, readFileSync(join(root, path), "utf8")]);
// 種は 40,000 文字以下の電文（変異 1 件の処理を軽く保つ）。
const seedFiles = corpus.filter(([, xml]) => xml.length <= 40_000);
function mutate(random, xml) {
  const steps = 1 + Math.floor(random() * 3);
  for (let step = 0; step < steps; step++) {
    // 半分はタグの境目（< か > の前後）、残りは任意の位置。
    let at = Math.floor(random() * (xml.length + 1));
    if (random() < 0.5) { const mark = xml.indexOf(random() < 0.5 ? "<" : ">", at); if (mark >= 0) at = mark + (random() < 0.5 ? 0 : 1); }
    const operation = random();
    if (operation < 0.7) xml = xml.slice(0, at) + snippets[Math.floor(random() * snippets.length)] + xml.slice(at);
    else if (operation < 0.85) xml = xml.slice(0, at) + xml.slice(at + 1 + Math.floor(random() * 4));
    else { const from = Math.floor(random() * xml.length); xml = xml.slice(0, at) + xml.slice(from, from + 1 + Math.floor(random() * 12)) + xml.slice(at); }
  }
  return xml;
}

// 作者裁定（2026-10-09 の 2 本目）: 変な形は旧の経路へ戻すので全入力で旧と同じ。実装の例外名や fallback の有無で差を認めない。
const failures = [];
const groups = {};
const short = (value) => { const text = JSON.stringify(value); return text.length > 300 ? `${text.slice(0, 300)}…` : text; };
function compare(group, label, xml) {
  const tally = (groups[group] ??= { inputs: 0, same: 0, failures: 0, fallbacks: 0, fallbackByOldStage: {}, oldStages: {}, newStages: {} });
  tally.inputs++;
  const before = run(oldApi, xml);
  const after = run(newApi, xml);
  tally.oldStages[before.stage] = (tally.oldStages[before.stage] ?? 0) + 1;
  tally.newStages[after.stage] = (tally.newStages[after.stage] ?? 0) + 1;
  if (after.fellBack) { tally.fallbacks++; tally.fallbackByOldStage[before.stage] = (tally.fallbackByOldStage[before.stage] ?? 0) + 1; }
  const why = before.calls > 1 || after.calls > 1 ? "builtTwice" : !isDeepStrictEqual(before.result, after.result) ? "differs"
    : group === "corpus" && after.fellBack ? "corpusFallback" : null;
  if (why == null) { tally.same++; return; }
  tally.failures++;
  failures.push({ group, label, why, xml: xml.length > 300 ? `${xml.slice(0, 300)}…(${xml.length})` : xml,
    old: `${before.stage} ${short(before.result)}`, new: `${after.stage}${after.fellBack ? "/fallback" : ""} ${short(after.result)}` });
}

for (const [path, xml] of corpus) compare("corpus", path, xml);
for (const [label, xml] of edges) compare("edges", label, xml);
for (const seed of seeds) {
  const random = rng(seed);
  for (let index = 0; index < count; index++) {
    const [path, xml] = seedFiles[Math.floor(random() * seedFiles.length)];
    compare(`mutants:${seed}`, `${seed}:${index}:${path}`, mutate(random, xml));
  }
}
const fxp = JSON.parse(readFileSync(join(dirname(require.resolve("fast-xml-parser")), "../package.json"), "utf8")).version;
console.log(JSON.stringify({ against: baseDist == null ? "(b) in-script old builder" : `(a) ${resolve(baseDist)}`, variant, seeds, count,
  seedFiles: seedFiles.length, fastXmlParser: fxp, node: process.version, groups, failures: failures.length }, null, 1));
for (const failure of failures.slice(0, 20)) console.log(JSON.stringify(failure));
process.exitCode = failures.length === 0 ? 0 : 1;
