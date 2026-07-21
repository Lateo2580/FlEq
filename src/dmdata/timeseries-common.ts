import { dig, str, listOf, nodeText } from "./xml-shape";

// listOf / nodeText は xml-shape に集約済み。従来 timeseries-common から
// import している各所を壊さないよう re-export する。
export { listOf, nodeText };

/** 数値文字列を number|null に (空/非数は null。"0" は 0 を返す) */
export function toNumberOrNull(value: string): number | null {
  if (value === "" || value == null) return null;
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

/** TimeDefine 1 件 */
export interface TimeDefineEntry {
  timeId: string;
  dateTime: string;
  duration: string;
  name: string;
}

/** <TimeDefines> から timeId→TimeDefineEntry の Map を構築 (系列ローカル) */
export function buildTimeDefineMap(
  timeDefinesNode: unknown,
): Map<string, TimeDefineEntry> {
  const map = new Map<string, TimeDefineEntry>();
  if (timeDefinesNode == null) return map;
  for (const td of listOf(dig(timeDefinesNode, "TimeDefine"))) {
    const timeId = str(dig(td, "@_timeId"));
    if (!timeId) continue;
    map.set(timeId, {
      timeId,
      dateTime: str(dig(td, "DateTime")),
      duration: str(dig(td, "Duration")),
      name: str(dig(td, "Name")),
    });
  }
  return map;
}

/** jmx_eb 要素 1 件のパース結果 (worst 選定せず全属性保持) */
export interface JmxEbElement {
  refID: string;
  type: string;             // @type ("最大風速" / "波高" 等)
  unit: string;             // @unit ("m/s" / "m" / "mm")
  condition: string | null; // @condition ("値なし" / "うねり" 等)
  description: string | null; // @description ("２２メートル")
  value: number | null;     // #text の数値 (condition=値なし 等で null)
  raw: string;              // #text 原文
}

/** jmx_eb:WindSpeed / Precipitation / WaveHeight など 1 要素を欠落なくパース */
export function parseJmxEbElement(node: unknown): JmxEbElement {
  const raw = nodeText(node);
  return {
    refID: str(dig(node, "@_refID")),
    type: str(dig(node, "@_type")),
    unit: str(dig(node, "@_unit")),
    condition: str(dig(node, "@_condition")) || null,
    description: str(dig(node, "@_description")) || null,
    value: toNumberOrNull(raw),
    raw,
  };
}
