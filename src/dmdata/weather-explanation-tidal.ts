import { dig, str } from "./telegram-parser";
import {
  listOf,
  nodeText,
  buildTimeDefineMap,
  parseJmxEbElement,
} from "./timeseries-common";
import type {
  WeatherExplanationTidal,
  WeatherExplanationTidalEntry,
} from "../types";

/**
 * jmx_eb:TidalLevel / jmx_eb:TidalPeriod ノードから description / @type / #text を取る。
 * @type (例: "満潮潮位"/"干潮潮位") は 89_02 型電文で Sentence に満潮/干潮の語が
 * 無いときの唯一の区別情報なので保全する (parseJmxEbElement を再利用)。
 */
function tidalValue(node: unknown): {
  description: string | null;
  type: string | null;
  raw: string | null;
} {
  if (node == null) return { description: null, type: null, raw: null };
  const el = parseJmxEbElement(node);
  return {
    description: el.description,
    type: el.type || null,
    raw: el.raw || null,
  };
}

/** TidalLevelPart 直下 (実況) または Sequence (予想) 1 ノードを TidalEntry に変換 */
function toEntry(
  node: unknown,
  stationName: string | null,
): WeatherExplanationTidalEntry | null {
  const sentence = nodeText(dig(node, "Sentence"));
  if (!sentence) return null;
  const level = tidalValue(dig(node, "jmx_eb:TidalLevel"));
  const period = tidalValue(dig(node, "jmx_eb:TidalPeriod"));
  return {
    sentence,
    stationName,
    time: nodeText(dig(node, "Time")) || null,
    levelDescription: level.description,
    levelType: level.type,
    periodDescription: period.description,
    rawLevel: level.raw,
    rawPeriod: period.raw,
    refId: str(dig(node, "@_refID")) || null,
    timeName: null, // 予想系で後段の TimeDefines 解決により上書き
    seriesIndex: null, // 予想系で後段の文書順採番により上書き
  };
}

/**
 * ノード直下 Station の Name を取る。
 * [注意] Station を XMLParser の isArray に追加してはならない —
 * 既存 extractObservation (VPFJ51) が単一ノード前提で壊れる。
 * 同名 sibling の可能性には listOf で耐性を持たせる (先頭を採用)。
 */
function stationNameOf(node: unknown): string | null {
  const stations = listOf(dig(node, "Station"));
  if (stations.length === 0) return null;
  return str(dig(stations[0], "Name")) || null;
}

/**
 * Body.MeteorologicalInfos を走査し TidalLevelPart を抽出する (VMCJ53-55)。
 * - MeteorologicalInfo 直下 Item (実況) → observations
 * - TimeSeriesInfo 直下 Item (予想、Base/Sequence) → forecasts
 * TidalLevelPart がひとつも無ければ null。
 */
export function extractTidal(body: unknown): WeatherExplanationTidal | null {
  if (body == null) return null;
  const observations: WeatherExplanationTidalEntry[] = [];
  const forecasts: WeatherExplanationTidalEntry[] = [];

  // 予想系 (@type="予想") TimeSeriesInfo の文書順カウンタ。
  // extractForecast の sourceIndex 採番 (type="予想" filter 後の TimeSeriesInfo 文書順) と
  // 一致させ、formatter で「▸ 予想: …」見出しへの統合に使う
  let forecastTsiIndex = 0;

  for (const infos of listOf(dig(body, "MeteorologicalInfos"))) {
    const isForecastInfos = str(dig(infos, "@_type")) === "予想";
    // 実況系: MeteorologicalInfo / Item / Kind / Property / TidalLevelPart
    for (const info of listOf(dig(infos, "MeteorologicalInfo"))) {
      for (const item of listOf(dig(info, "Item"))) {
        const stationName = stationNameOf(item);
        for (const kind of listOf(dig(item, "Kind"))) {
          for (const prop of listOf(dig(kind, "Property"))) {
            for (const part of listOf(dig(prop, "TidalLevelPart"))) {
              const entry = toEntry(part, stationName);
              if (entry != null) observations.push(entry);
            }
          }
        }
      }
    }
    // 予想系: TimeSeriesInfo / Item / Kind / Property / TidalLevelPart / Base / Sequence
    // TimeDefines の refID → 期間名 (例 "９月１９日") を解決して timeName に載せる
    for (const tsi of listOf(dig(infos, "TimeSeriesInfo"))) {
      // 予想系以外の TimeSeriesInfo は extractForecast の採番対象外なので null (対応付け不能)
      const seriesIndex = isForecastInfos ? forecastTsiIndex : null;
      if (isForecastInfos) forecastTsiIndex++;
      const timeDefineMap = buildTimeDefineMap(dig(tsi, "TimeDefines"));
      for (const item of listOf(dig(tsi, "Item"))) {
        const itemStation = stationNameOf(item);
        for (const kind of listOf(dig(item, "Kind"))) {
          for (const prop of listOf(dig(kind, "Property"))) {
            for (const part of listOf(dig(prop, "TidalLevelPart"))) {
              const base = dig(part, "Base");
              for (const seq of listOf(dig(base, "Sequence"))) {
                // Station の所在を Item 直下に楽観しない。Sequence → Base → Item の順でフォールバック
                const stationName =
                  stationNameOf(seq) ?? stationNameOf(base) ?? itemStation;
                const entry = toEntry(seq, stationName);
                if (entry != null) {
                  entry.timeName =
                    entry.refId != null
                      ? timeDefineMap.get(entry.refId)?.name ?? null
                      : null;
                  entry.seriesIndex = seriesIndex;
                  forecasts.push(entry);
                }
              }
            }
          }
        }
      }
    }
  }

  if (observations.length === 0 && forecasts.length === 0) return null;
  return { observations, forecasts };
}
