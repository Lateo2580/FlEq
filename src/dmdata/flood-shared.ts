import { createHash } from "node:crypto";
import {
  FLOOD_KIND_CODE_TO_LEVEL,
  FLOOD_LEVEL_RANK,
} from "../types";
import type {
  FloodCriteria,
  FloodHeadline,
  FloodKindCode,
  FloodLevel,
  FloodMeasurementUnit,
  FloodSeriesWindow,
} from "../types";
import { dig, str } from "./telegram-parser";
import { listOf, nodeText, toNumberOrNull } from "./timeseries-common";

/**
 * 洪水・水位系電文 (VXKO50-89 / VXSU50-59) パーサ群の共有 helper。
 *
 * 旧 `flood-forecast-parser.ts` から、複数のドメインパーサ
 * (station / vxsu-stub / rainfall 等) で再利用されるユーティリティを切り出した。
 *
 * - `FloodTimeDefine` + `buildFloodTimeDefineMap`: station + rainfall で共有
 * - `parseCriteriaFromPart`: station + vxsu-stub で共有
 * - `computeStationObservedLevel`: station で参照 (将来 vxsu でも使える共通形)
 * - `resolveHeadlineKindForStation`: station + vxsu-stub で共有
 * - `computeMainItemCodeAndHash` (+ private `itemMatchesStation`): station + vxsu-stub で共有
 */

/** TimeDefine の単純化 (timeseries-common の汎用版は duration 必須なので簡略版を用意) */
export interface FloodTimeDefine {
  refId: string;
  dateTime: string;
  name: string;
  /** ISO 8601 duration 生文字列 (例 "PT48H", "PT12H40M"). 未指定なら null */
  durationIso: string | null;
  /** durationIso をパースした分単位値. 解析失敗または duration 不在なら null */
  durationMinutes: number | null;
}

export function buildFloodTimeDefineMap(
  timeDefinesNode: unknown,
): Map<string, FloodTimeDefine> {
  const map = new Map<string, FloodTimeDefine>();
  if (timeDefinesNode == null) return map;
  for (const td of listOf(dig(timeDefinesNode, "TimeDefine"))) {
    const refId = str(dig(td, "@_timeId"));
    if (refId === "") continue;
    const durationRaw = str(dig(td, "Duration"));
    const durationIso = durationRaw === "" ? null : durationRaw;
    map.set(refId, {
      refId,
      dateTime: str(dig(td, "DateTime")),
      name: str(dig(td, "Name")),
      durationIso,
      durationMinutes: durationIso == null ? null : parseIsoDurationMinutes(durationIso),
    });
  }
  return map;
}

/**
 * `<Criteria>` ノードから `FloodCriteria` を抽出する。
 * `<jmx_eb:WaterLevel type="レベル１水防団待機水位" unit="m">142.00</jmx_eb:WaterLevel>` の
 * type 文字列から L1-L4 / L4Plan を分類する。
 * Discharge 系電文 (16_03_01) では `<jmx_eb:Discharge>` で同型の構造を取る。
 */
export function parseCriteriaFromPart(criteriaNode: unknown): FloodCriteria {
  // Discharge ノードを試し、なければ WaterLevel を採用
  const dischargeElements = listOf(dig(criteriaNode, "jmx_eb:Discharge"));
  const waterElements = listOf(dig(criteriaNode, "jmx_eb:WaterLevel"));
  const isDischarge = dischargeElements.length > 0;
  const elements = isDischarge ? dischargeElements : waterElements;
  const unit: FloodMeasurementUnit = isDischarge ? "立方メートル毎秒" : "m";

  const c: FloodCriteria = {
    L1: null,
    L2: null,
    L3: null,
    L4: null,
    L4Plan: null,
    unit,
    rawUnit: unit,
  };
  for (const el of elements) {
    if (el == null) continue;
    const t = str(dig(el, "@_type"));
    const unitAttr = str(dig(el, "@_unit"));
    if (unitAttr) c.rawUnit = unitAttr;
    const raw = nodeText(el);
    const value = toNumberOrNull(raw);
    if (value == null) continue;
    if (/レベル４計画高/.test(t)) c.L4Plan = value;
    else if (/レベル４/.test(t) || t === "氾濫危険水位" || t === "氾濫危険流量") {
      c.L4 = value;
    } else if (/レベル３/.test(t) || t === "避難判断水位" || t === "避難判断流量") {
      c.L3 = value;
    } else if (/レベル２/.test(t) || t === "氾濫注意水位" || t === "氾濫注意流量") {
      c.L2 = value;
    } else if (/レベル１/.test(t) || t === "水防団待機水位" || t === "水防団待機流量") {
      c.L1 = value;
    }
  }
  return c;
}

/**
 * `series[0].level` (現況のレベル) → `FloodLevel` を導出。
 * 欠測など level=null のときは "unknown"。
 */
export function computeStationObservedLevel(
  series: FloodSeriesWindow[],
): FloodLevel {
  if (series.length === 0) return "unknown";
  const lvl = series[0].level;
  if (lvl == null) return "unknown";
  if (lvl === 0 || lvl === 1) return "L1";
  if (lvl === 2) return "L2";
  if (lvl === 3) return "L3";
  if (lvl === 4) return "L4";
  if (lvl === 5) return "L5";
  return "unknown";
}

/**
 * spec §3.1 ルールで Headline 代表 kindCode を station に割り付ける。
 *
 * 1. `scope === "河川"` の headlines から `FLOOD_LEVEL_RANK[level]` 最大を抽出 (同 rank は先頭採用)
 * 2. 0 件なら `scope === "予報区域"` の同基準で fallback、それも 0 件なら "unknown"
 * 3. station の primaryRiverCode が headlines のいずれかの areas[].code と一致すれば
 *    そちらの kindCode を優先 (一致なしはグローバル代表)
 */
export function resolveHeadlineKindForStation(
  headlines: FloodHeadline[],
  primaryRiverCode: string | null,
): FloodKindCode {
  // §3.1 step 1: 河川 scope の Headline 集合
  const riverHeadlines = headlines.filter((h) => h.scope === "河川");
  // §3.1 step 5: primaryRiverCode が areas[].code に一致するなら、その Headline.kindCode を採用
  if (primaryRiverCode != null && primaryRiverCode !== "") {
    for (const h of riverHeadlines) {
      if (h.areas.some((a) => a.code === primaryRiverCode)) {
        return h.kindCode;
      }
    }
  }
  // §3.1 step 2-3: 河川 scope の中で rank 最大、同 rank は先頭採用
  const pickMaxRank = (list: FloodHeadline[]): FloodKindCode => {
    let best: FloodHeadline | null = null;
    let bestRank = -Infinity;
    for (const h of list) {
      const level = FLOOD_KIND_CODE_TO_LEVEL[h.kindCode];
      const rank = FLOOD_LEVEL_RANK[level];
      if (rank > bestRank) {
        bestRank = rank;
        best = h;
      }
    }
    return best?.kindCode ?? "unknown";
  };
  const fromRiver = pickMaxRank(riverHeadlines);
  if (fromRiver !== "unknown") return fromRiver;

  // §3.1 step 4: 予報区域 scope で fallback
  const forecastHeadlines = headlines.filter((h) => h.scope === "予報区域");
  return pickMaxRank(forecastHeadlines);
}

/**
 * 対象 station が Warning.Item に含まれるか判定する。
 * - Stations.Station.Code/Name 一致 (主文系 Warning.Item)
 * - Areas.Area.Name/Code 一致 (浸水想定地区系 Warning.Item)
 *
 * `computeMainItemCodeAndHash` 専用の private helper だが、内部での再利用を
 * 想定して `flood-shared.ts` 内に置く (export はしない)。
 */
function itemMatchesStation(
  item: unknown,
  stationCode: string,
  stationName: string,
): boolean {
  if (stationCode === "" && stationName === "") return false;
  // Stations.Station 経由
  const stations = listOf(dig(item, "Stations"));
  for (const stationsNode of stations) {
    for (const s of listOf(dig(stationsNode, "Station"))) {
      const sCode = nodeText(dig(s, "Code"));
      const sName = str(dig(s, "Name"));
      if (
        (stationCode !== "" && sCode === stationCode) ||
        (stationName !== "" && sName === stationName)
      ) {
        return true;
      }
    }
  }
  // Areas.Area 経由 (浸水想定地区 Item で codeType="水位観測所" のとき)
  const areasList = listOf(dig(item, "Areas"));
  for (const areasNode of areasList) {
    for (const a of listOf(dig(areasNode, "Area"))) {
      const aCodeType = str(dig(a, "@_codeType"));
      if (aCodeType !== "水位観測所") continue;
      const aCode = str(dig(a, "Code"));
      const aName = str(dig(a, "Name"));
      if (
        (stationCode !== "" && aCode === stationCode) ||
        (stationName !== "" && aName === stationName)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Warning 配下の Item から、対象 station が含まれるものを探し、Item の
 * Kind.Code を `mainItemCode` ("1"/"2" に narrowing)、主文 Text を
 * SHA1 で hash して `mainTextHash` を解決する。
 *
 * spec の意図:
 * - 浸水想定地区 Item の Kind.Code は "1" (通常) / "2" (氾濫発生情報) に切り替わる。
 *   16_11_02 (疑似復旧) では "1" → "2" → "1" のような遷移を検知する必要があるため、
 *   station ごとに「この station が現れる Item の Kind.Code」を保持する。
 * - 主文 Item (Property.Type=主文) は Kind.Code を持たない (undefined → null)。
 *   その場合は Text のみが hash 対象。
 *
 * 複数 Item が当該 station を含む場合は、Code が "1"/"2" のものを優先採用
 * (Code 不在の主文 Item よりも 浸水想定地区 Item を選ぶ)。
 * 該当 Item が無い場合は `{ mainItemCode: null, mainTextHash: "" }`。
 */
export function computeMainItemCodeAndHash(
  body: unknown,
  stationCode: string,
  stationName: string,
): { mainItemCode: "1" | "2" | null; mainTextHash: string } {
  if (body == null || (stationCode === "" && stationName === "")) {
    return { mainItemCode: null, mainTextHash: "" };
  }

  let preferred:
    | { mainItemCode: "1" | "2" | null; mainTextHash: string }
    | null = null;
  let fallback:
    | { mainItemCode: "1" | "2" | null; mainTextHash: string }
    | null = null;

  const warnings = listOf(dig(body, "Warning"));
  for (const warning of warnings) {
    if (warning == null) continue;
    const items = listOf(dig(warning, "Item"));
    for (const item of items) {
      if (item == null) continue;
      if (!itemMatchesStation(item, stationCode, stationName)) continue;

      const kindNode = listOf(dig(item, "Kind"))[0];
      const codeRaw = str(dig(kindNode, "Code"));
      const mainItemCode: "1" | "2" | null =
        codeRaw === "1" || codeRaw === "2" ? codeRaw : null;
      // 主文 Text を解決:
      //  - 主文 Item (Property.Type=主文 or 浸水想定地区) → Property.Text
      //  - 該当 Property がなければ Kind.Property[0].Text
      const props = listOf(dig(kindNode, "Property"));
      let mainText = "";
      for (const p of props) {
        const t = str(dig(p, "Type"));
        const txt = str(dig(p, "Text"));
        if (t === "主文" && txt !== "") {
          mainText = txt;
          break;
        }
        if (mainText === "" && txt !== "") mainText = txt;
      }
      const hashSource = mainText + "|" + (codeRaw ?? "");
      const mainTextHash = createHash("sha1").update(hashSource).digest("hex");
      const candidate = { mainItemCode, mainTextHash };

      if (mainItemCode !== null && preferred == null) {
        preferred = candidate;
      } else if (fallback == null) {
        fallback = candidate;
      }
    }
  }
  return preferred ?? fallback ?? { mainItemCode: null, mainTextHash: "" };
}

/**
 * ISO 8601 duration 文字列を分単位値に変換する。
 *
 * サポート範囲 (実 fixture VXKO50-89 雨量 TimeDefine.Duration に出現するもののみ):
 *   - PT{H}H        (例: PT48H → 2880)
 *   - PT{H}H{M}M    (例: PT12H40M → 760)
 *
 * 範囲外 (null 返却、意図的に未対応):
 *   - PT{M}M 単独 / 小数時間 (PT1.5H) / 年月日週 (P1Y / P2W / P3D) / 秒 (PT3S)
 *   - 全部ゼロ (PT0H / PT0H0M)
 *   - 空文字 / 不正形式 / PT 単独
 */
export function parseIsoDurationMinutes(iso: string): number | null {
  const m = iso.match(/^PT(\d+)H(?:(\d+)M)?$/);
  if (m == null) return null;
  const hours = Number(m[1]);
  const minutes = m[2] == null ? 0 : Number(m[2]);
  if (hours === 0 && minutes === 0) return null;
  return hours * 60 + minutes;
}
