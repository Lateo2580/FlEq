import { XMLParser } from "fast-xml-parser";

/**
 * dmdata (JMX) 電文 XML を parse する共通の XMLParser factory と、
 * parse 結果の `unknown` ツリーを安全に walk するための汎用ヘルパを集約する。
 *
 * 各系統パーサ (weather / flood / telegram 等) はここから
 * `createJmxXmlParser` を呼び、系統固有の `isArray` predicate だけを渡す。
 * 基礎 4 設定 (`ignoreAttributes` / `attributeNamePrefix` / `textNodeName` /
 * `parseTagValue`) はここで固定し、系統間でブレさせない。
 */

/**
 * `isArray` predicate 型。各パーサの predicate は tagName しか参照しないため
 * 1 引数に絞る (引数の少ない関数は fast-xml-parser の option 型に代入可能)。
 */
type IsArrayPredicate = (tagName: string) => boolean;

/**
 * JMX 電文用 XMLParser を生成する。
 *
 * 固定設定:
 * - `ignoreAttributes: false` — 属性 (`@_type` 等) を保持
 * - `attributeNamePrefix: "@_"` — 属性キーの接頭辞
 * - `textNodeName: "#text"` — 属性付き要素のテキストノードキー
 * - `parseTagValue: false` — "03" / "011000" のような先頭ゼロ・Code を文字列で保持
 * - `parseAttributeValue: false` — 属性値も文字列のまま保持 (既定値と同じだが、
 *   依存更新で既定値が変わっても挙動が動かないよう明示する)
 *
 * `isArray` は各パーサ固有の配列化 predicate をそのまま渡す。
 * 省略時は fast-xml-parser の既定 (`() => false`) に委ねるため、
 * `isArray` キー自体を渡さない (undefined を渡すと既定を上書きしてしまう)。
 */
export function createJmxXmlParser(isArray?: IsArrayPredicate): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    parseTagValue: false,
    parseAttributeValue: false,
    ...(isArray ? { isArray } : {}),
  });
}

// ── 汎用ノードアクセスヘルパ ──

/** キー列を順にたどって安全にプロパティアクセスする (欠落時 undefined) */
export function dig(obj: unknown, ...keys: string[]): unknown {
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** 値を文字列化 (null/undefined は "") */
export function str(val: unknown): string {
  if (val == null) return "";
  return String(val);
}

/** 配列なら先頭要素、そうでなければそのまま返す */
export function first<T>(val: T | T[]): T {
  return Array.isArray(val) ? val[0] : val;
}

/** node を配列に正規化 (単一/配列/null 対応) */
export function listOf(node: unknown): unknown[] {
  if (node == null) return [];
  return Array.isArray(node) ? node : [node];
}

/** 属性付き要素から #text を取り出す */
export function nodeText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "object") return str(dig(node, "#text"));
  return str(node);
}
