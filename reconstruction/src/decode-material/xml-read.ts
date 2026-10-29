import type { DecodedMaterial, MaterialValue, XmlElement, XmlNode } from "../../contracts/p1-parser-boundary.types";
import { classifyMaterial } from "./decode-material";

// domain ごとに写していた XML の読み取り（P3-XML-READERS-001、計画 §9）をここに 1 つだけ置く。
// 無いと、11 か所の localName・10 か所の children／scalar の 1 か所だけを直したとき、型も試験も止めない。
// eew・weather-current は要素名・trim・大文字小文字の扱いが違う（D-EXACT=A）ので、ここへは寄せない。
const localName = (node: XmlElement): string => node.name.split(":").at(-1)!;
function children(parent: XmlElement | null, name?: string): XmlElement[] {
  return parent == null ? [] : parent.children.filter((node): node is XmlElement =>
    node.kind === "element" && (name == null || localName(node) === name));
}
function first(parent: XmlElement | null, name: string): XmlElement | null {
  return children(parent, name)[0] ?? null;
}
function scalar(node: XmlElement): string | null {
  return children(node).length === 0 ? node.children.filter((part): part is Extract<XmlNode, { kind: "text" }> =>
    part.kind === "text").map((part) => part.value).join("").trim() : null;
}
function text(parent: XmlElement | null, name: string): string | null {
  const node = first(parent, name);
  return node == null ? null : scalar(node);
}
// 最初の 1 個の値を trim する。node が null なら null（D-ATTR=A）。
function attribute(node: XmlElement | null, name: string): string | null {
  return node?.attributes.find((item) => item.name === name)?.value.trim() ?? null;
}
const blank = (value: string | null): string | null => value == null || value === "" ? null : value;

// classifyMaterial と同じ順の葉に MaterialValue を対応させる（1 入力に 1 回。値は P1 のまま書き換えない、P3-C7-VALUE-UNKNOWN=A）。
function leafValues(material: DecodedMaterial): ReadonlyMap<XmlElement, MaterialValue> {
  const leaves: XmlElement[] = [];
  const visit = (node: XmlElement): void => {
    const nested = children(node);
    if (nested.length === 0) leaves.push(node);
    else nested.forEach(visit);
  };
  visit(material.xml);
  const values = classifyMaterial(material).materialValues;
  return new Map(leaves.map((leaf, index) => [leaf, values[index]]));
}

export { attribute, blank, children, first, leafValues, localName, scalar, text };
