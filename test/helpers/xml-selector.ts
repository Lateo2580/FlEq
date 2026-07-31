import type { XMLParser } from "fast-xml-parser";
import { createJmxShadowXmlParser } from "../../src/dmdata/xml-shape";

type XmlRecord = Record<string, unknown>;

export function createXmlEvidenceParser(): XMLParser {
  return createJmxShadowXmlParser();
}

function isXmlRecord(value: unknown): value is XmlRecord {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function localName(name: string): string {
  return name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
}

function asValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

export function directXmlChildren(node: unknown, name: string): unknown[] {
  if (!isXmlRecord(node)) return [];
  return Object.entries(node)
    .filter(([key]) => !key.startsWith("@_") && key !== "#text" && localName(key) === name)
    .flatMap(([, value]) => asValues(value));
}

function descendants(node: unknown, name: string): unknown[] {
  if (!isXmlRecord(node) && !Array.isArray(node)) return [];
  const values = Array.isArray(node) ? node : Object.values(node);
  const found: unknown[] = [];
  if (isXmlRecord(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (!key.startsWith("@_") && key !== "#text" && localName(key) === name) {
        found.push(...asValues(value));
      }
    }
  }
  for (const value of values) {
    for (const child of asValues(value)) {
      if (isXmlRecord(child) || Array.isArray(child)) found.push(...descendants(child, name));
    }
  }
  return found;
}

export function xmlRawText(node: unknown): string | undefined {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!isXmlRecord(node)) return undefined;
  const text = node["#text"];
  return typeof text === "string" || typeof text === "number" ? String(text) : undefined;
}

export function xmlText(node: unknown): string | undefined {
  return xmlRawText(node)?.trim();
}

export function xmlAttribute(node: unknown, name: string): string | undefined {
  if (!isXmlRecord(node)) return undefined;
  const value = node[`@_${name}`];
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : undefined;
}

function parseSelectorSegment(segment: string): {
  name: string;
  predicates: Array<{ attribute: boolean; name: string; value: string }>;
} {
  const name = segment.slice(0, segment.indexOf("[") < 0 ? segment.length : segment.indexOf("["));
  const predicates: Array<{ attribute: boolean; name: string; value: string }> = [];
  const pattern = /\[(@?)([^=\]]+)=([^\]]*)\]/g;
  for (const match of segment.matchAll(pattern)) {
    predicates.push({ attribute: match[1] === "@", name: match[2], value: match[3] });
  }
  return { name, predicates };
}

function matchesPredicates(
  node: unknown,
  predicates: Array<{ attribute: boolean; name: string; value: string }>,
): boolean {
  return predicates.every((predicate) => {
    const actual = predicate.attribute
      ? xmlAttribute(node, predicate.name)
      : directXmlChildren(node, predicate.name).map(xmlText).find((value) => value != null);
    return actual === predicate.value;
  });
}

export function selectXml(root: unknown, selector: string): unknown | undefined {
  const segments = selector.split("/").map(parseSelectorSegment);
  const first = segments[0];
  if (first == null) return undefined;
  let current = descendants(root, first.name)
    .filter((node) => matchesPredicates(node, first.predicates));
  for (const segment of segments.slice(1)) {
    current = current
      .flatMap((node) => directXmlChildren(node, segment.name))
      .filter((node) => matchesPredicates(node, segment.predicates));
  }
  return current[0];
}
