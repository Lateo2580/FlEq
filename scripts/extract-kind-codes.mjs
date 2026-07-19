#!/usr/bin/env node
// usage: node scripts/extract-kind-codes.mjs test/fixtures/15_17_01_251222_VPWW55.xml [...]
// 気象警報・注意報 XML から (telegram, kindCode, kindName) を XML parse で抽出する。
// <Kind><Code> は別行構造のため grep では取れない。fixture 網羅性テストの補助。
import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";

// parseTagValue: false で <Code>03</Code> の先頭ゼロを保持 (実 weather-parser と同設定)
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false });
const seen = new Map(); // key = `${telegram}|${code}|${name}` → entry

function walk(node, telegram) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, telegram);
    return;
  }
  if ("Kind" in node) {
    const kinds = Array.isArray(node.Kind) ? node.Kind : [node.Kind];
    for (const k of kinds) {
      const code = String(k?.Code ?? "");
      const name = String(k?.Name ?? "");
      if (code) {
        const key = `${telegram}|${code}|${name}`;
        if (!seen.has(key)) seen.set(key, { telegram, code, name });
      }
    }
  }
  for (const v of Object.values(node)) walk(v, telegram);
}

for (const file of process.argv.slice(2)) {
  const xml = readFileSync(file, "utf8");
  const data = parser.parse(xml);
  const telegram =
    data?.Report?.Control?.Title ??
    file.match(/VPWW\d+|VPWS\d+/)?.[0] ??
    file;
  walk(data, telegram);
}

console.log(JSON.stringify([...seen.values()], null, 2));
