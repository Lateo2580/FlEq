import type { RainfallSummary } from "../types";
import { dig, str } from "./telegram-parser";
import { listOf, nodeText, toNumberOrNull } from "./timeseries-common";
import { buildFloodTimeDefineMap, type FloodTimeDefine } from "./flood-shared";
import * as log from "../logger";

/**
 * Body.MeteorologicalInfos[type=雨量情報] から `RainfallSummary[]` を抽出する。
 *
 * 設計上の決定 (spec §F + Codex review hardening):
 *  - **multi-TimeSeriesInfo 走査**: 旧実装の `[0]` 単発取得は流域 2 件目以降を取りこぼすバグ。
 *    本実装は MeteorologicalInfos[雨量].TimeSeriesInfo を全件走査し、per-basin で別 RainfallSummary を push。
 *  - **windowMinutes 駆動**: TimeDefine.Duration を primary、Name regex を fallback (NFKC normalize 済で全角数字対応)。
 *  - **forecast 判定**: Name "見込み" 専一 (Duration PT3H fallback は廃止 — PT3H cumulative actual を forecast に
 *    誤分類するリスクを回避)。Name に "見込み" が含まれない PT3H は cumulative 側 (1 件目) として扱う。
 *  - **windowMinutes は raw 値**: forecastShort.windowMinutes も cumulative と対称に nullable で、180 default invent はしない
 *    (Duration / Name 両失敗時は null を返す)。
 *  - **observability**: 1 流域内多窓累積 / 多重 forecast は先頭のみ採用 + log.debug。
 */
export function parseRainfallSummaries(body: unknown): RainfallSummary[] {
  if (body == null) return [];
  const result: RainfallSummary[] = [];
  const meteoInfos = listOf(dig(body, "MeteorologicalInfos"));
  const rainInfo = meteoInfos.find(
    (m) => str(dig(m, "@_type")) === "雨量情報",
  );
  if (rainInfo == null) return result;

  // VXSU 向け trend (PrecipitationBasedIndex.@_condition) を抽出
  let trend: RainfallSummary["trend"] = null;
  const metInfos = listOf(dig(rainInfo, "MeteorologicalInfo"));
  for (const metInfo of metInfos) {
    if (metInfo == null) continue;
    const items = listOf(dig(metInfo, "Item"));
    for (const item of items) {
      const kindNode = listOf(dig(item, "Kind"))[0];
      const propertyNode = listOf(dig(kindNode, "Property"))[0];
      const indexPart = dig(propertyNode, "PrecipitationBasedIndexPart");
      if (indexPart == null) continue;
      const els = listOf(dig(indexPart, "jmx_eb:PrecipitationBasedIndex"));
      for (const el of els) {
        if (el == null) continue;
        const t = str(dig(el, "@_type"));
        if (t === "流域雨量指数変化傾向") {
          const cond = str(dig(el, "@_condition"));
          if (cond === "上昇" || cond === "下降" || cond === "横ばい") {
            trend = cond;
          }
        }
      }
    }
  }

  // multi-TimeSeriesInfo 外側ループ (spec §4.3.1)
  let pushed = false;
  const tsiList = listOf(dig(rainInfo, "TimeSeriesInfo"));
  for (const tsi of tsiList) {
    if (tsi == null) continue;
    const timeMap = buildFloodTimeDefineMap(dig(tsi, "TimeDefines"));
    const items = listOf(dig(tsi, "Item"));
    for (const item of items) {
      if (item == null) continue;
      const kindNode = listOf(dig(item, "Kind"))[0];
      const propertyNode = listOf(dig(kindNode, "Property"))[0];
      const basinAreaNode = listOf(dig(item, "Area"))[0];
      const basinName = str(dig(basinAreaNode, "Name")) || null;

      // (a) VXKO: PrecipitationPart の jmx_eb:Precipitation
      const precipPart = dig(propertyNode, "PrecipitationPart");
      if (precipPart != null) {
        const summary = buildVxkoRainfallSummary(precipPart, timeMap, basinName, trend);
        result.push(summary);
        pushed = true;
        continue;
      }

      // (b) VXSU: PrecipitationBasedIndexPart の jmx_eb:PrecipitationBasedIndex
      const indexPart = dig(propertyNode, "PrecipitationBasedIndexPart");
      if (indexPart != null) {
        const summary = buildVxsuRainfallSummary(indexPart, basinName, trend);
        result.push(summary);
        pushed = true;
        continue;
      }
    }
  }

  // VXSU で TimeSeriesInfo がない場合に備えて MeteorologicalInfo 単独でも 1 件出力。
  // 実 fixture 91_01_01 は VXSU の TimeSeriesInfo に PrecipitationBasedIndexPart Item を持つため
  // この分岐に来ない (上のループで pushed=true)。本分岐は将来 VXSU 配信形態が変化した場合の保険。
  if (!pushed && trend != null) {
    result.push({
      basinName: null,
      cumulativeActual: null,
      forecastShort: null,
      trend,
      currentBasinIndex: null,
      rawUnit: "",
    });
  }

  return result;
}

/** TimeDefine の Duration を primary、Name regex を fallback で windowMinutes を解決
 *  Name は NFKC normalize した上で `\d+時間` を抽出する (実電文は半角だが、全角数字のフェイルセーフ) */
function resolveWindowMinutes(td: FloodTimeDefine | undefined): number | null {
  if (td == null) return null;
  if (td.durationMinutes != null) return td.durationMinutes;
  const normalized = td.name.normalize("NFKC");
  const m = normalized.match(/(\d+)時間/);
  if (m == null) return null;
  return Number(m[1]) * 60;
}

/** VXKO の 1 Item から RainfallSummary を組み立てる (spec §4.3.3) */
function buildVxkoRainfallSummary(
  precipPart: unknown,
  timeMap: Map<string, FloodTimeDefine>,
  basinName: string | null,
  trend: RainfallSummary["trend"],
): RainfallSummary {
  const precipElements = listOf(dig(precipPart, "jmx_eb:Precipitation"));
  let cumulativeActual: RainfallSummary["cumulativeActual"] = null;
  let forecastShort: RainfallSummary["forecastShort"] = null;

  for (const el of precipElements) {
    if (el == null) continue;
    const refId = str(dig(el, "@_refID"));
    const value = toNumberOrNull(nodeText(el));
    const td = timeMap.get(refId);
    const windowMinutes = resolveWindowMinutes(td);

    // 予測判定: Name "見込み" 専一 (Codex review W1 反映)。Duration PT3H fallback は廃止
    // (PT3H cumulative actual を forecast に誤分類するリスクを回避)。
    // Name に "見込み" を含まない PT3H は cumulative 側 (1 件目) として扱う。
    const isForecast = td?.name.includes("見込み") ?? false;

    if (isForecast) {
      if (forecastShort == null) {
        // 180 default invent は廃止 (Codex review W3 反映)。raw 値 (null 含む) を入れる
        forecastShort = { value, unit: "ミリ", windowMinutes };
      } else {
        log.debug(
          `parseRainfallSummaries: 多重 forecast を検知 (basin=${basinName ?? "?"}, refId=${refId}, windowMinutes=${windowMinutes}). 現実装は先頭のみ採用`,
        );
      }
    } else if (cumulativeActual == null) {
      cumulativeActual = { value, unit: "ミリ", windowMinutes };
    } else {
      log.debug(
        `parseRainfallSummaries: 多窓累積を検知 (basin=${basinName ?? "?"}, refId=${refId}, windowMinutes=${windowMinutes}). 現実装は先頭のみ採用`,
      );
    }
  }

  return {
    basinName,
    cumulativeActual,
    forecastShort,
    trend,
    currentBasinIndex: null,
    rawUnit: "ミリ",
  };
}

/** VXSU の 1 Item から RainfallSummary を組み立てる */
function buildVxsuRainfallSummary(
  indexPart: unknown,
  basinName: string | null,
  trend: RainfallSummary["trend"],
): RainfallSummary {
  const indexEls = listOf(dig(indexPart, "jmx_eb:PrecipitationBasedIndex"));
  let currentBasinIndex: number | null = null;
  for (const el of indexEls) {
    if (el == null) continue;
    const refId = str(dig(el, "@_refID"));
    if (refId !== "1") continue;
    const value = toNumberOrNull(nodeText(el));
    if (value != null) currentBasinIndex = value;
  }
  return {
    basinName,
    cumulativeActual: null,
    forecastShort: null,
    trend,
    currentBasinIndex,
    rawUnit: "",
  };
}
