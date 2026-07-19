import { XMLParser } from "fast-xml-parser";
import type {
  WsDataMessage,
  ParsedTyphoonProbability,
  TyphoonProbabilityFallback,
  TyphoonProbParserDiagnostics,
  TyphoonProbPeak,
} from "../types";
import { decodeBody, dig, str } from "./telegram-parser";
import { listOf, nodeText, toNumberOrNull } from "./timeseries-common";
import * as log from "../logger";

const FALLBACK_RAW_BYTES = 5 * 1024 * 1024;
const FALLBACK_COMPACT_AREAS = 600;
const FALLBACK_COMPACT_STEPS = 60;

export function decideFallback(
  regionCount: number,
  stepCount: number,
  decodedBytes: number,
): TyphoonProbabilityFallback {
  if (decodedBytes > FALLBACK_RAW_BYTES) return "raw";
  if (regionCount > FALLBACK_COMPACT_AREAS) return "compactOnly";
  if (stepCount > FALLBACK_COMPACT_STEPS) return "compactOnly";
  return "none";
}

function findProperty(item: unknown, typeName: string): unknown {
  for (const kind of listOf(dig(item, "Kind"))) {
    for (const prop of listOf(dig(kind, "Property"))) {
      if (str(dig(prop, "Type")) === typeName) return prop;
    }
  }
  return null;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  isArray: (name) =>
    ["MeteorologicalInfo", "Item", "Kind", "Property", "TimeDefine",
     "FiftyKtWindProbability", "TimeSeriesInfo"].includes(name),
});

function emptyDiagnostics(): TyphoonProbParserDiagnostics {
  return {
    duplicateCodes: [],
    missingCodesPerSection: [],
    sectionCodeCountMismatch: false,
    dailyAnomalies: [],
    unknownAttributes: [],
  };
}

export function parseTyphoonProbability(
  msg: WsDataMessage,
): ParsedTyphoonProbability | null {
  try {
    const xmlStr = decodeBody(msg);
    const decodedBytes = Buffer.byteLength(xmlStr, "utf-8");

    if (decodedBytes > FALLBACK_RAW_BYTES) {
      log.debug(`parseTyphoonProbability: decoded ${decodedBytes} bytes > 5MB → raw fallback`);
      return null;
    }

    const parsed = xmlParser.parse(xmlStr);
    const report = dig(parsed, "Report") || dig(parsed, "jmx:Report");
    if (report == null) return null;

    const control = dig(report, "Control");
    const head = dig(report, "Head");
    if (head == null) return null;

    const type = str(msg.head.type) || "VPTA50";
    // controlTitle は string (nullable ではない) なので、空文字で fallback
    const controlTitle = str(dig(control, "Title")) || "";
    const title = str(dig(head, "Title")) || controlTitle;
    const infoType = str(dig(head, "InfoType")) || "発表";
    const eventId = str(dig(head, "EventID")) || null;
    const serial = str(dig(head, "Serial")) || null;
    const reportDateTime = str(dig(head, "ReportDateTime")) || null;
    const baseTime = str(dig(head, "TargetDateTime")) || null;
    const publishingOffice = str(dig(control, "PublishingOffice")) || null;
    const isTest = str(dig(control, "Status")) === "試験";

    const base: ParsedTyphoonProbability = {
      type, infoType, title, controlTitle,
      name: null, baseTime, reportDateTime, publishingOffice,
      timeDefines: [], regions: [],
      eventId, serial, isTest,
      fallback: "none",
      parserDiagnostics: emptyDiagnostics(),
    };

    if (infoType === "取消") return base;

    // ─── TyphoonName 抽出 ───
    const body = dig(report, "Body");
    const metInfos = dig(body, "MeteorologicalInfos");
    const metInfoList = listOf(dig(metInfos, "MeteorologicalInfo"));

    for (const mi of metInfoList) {
      const miType = str(dig(mi, "@_type"));
      if (miType === "台風呼称") {
        const item = listOf(dig(mi, "Item"))[0];
        const prop = findProperty(item, "呼称");
        const np = dig(prop, "TyphoonNamePart");
        if (np != null) {
          base.name = {
            name: str(dig(np, "Name")) || null,
            nameKana: str(dig(np, "NameKana")) || null,
            number: str(dig(np, "Number")) || null,
            remark: str(dig(np, "Remark")) || null,
          };
        }
      }
    }

    // ─── 日別積算セクション ───
    const DAY_TYPES: Record<string, number> = {
      "台風の暴風域に入る確率（1日積算）": 0,
      "台風の暴風域に入る確率（2日積算）": 1,
      "台風の暴風域に入る確率（3日積算）": 2,
      "台風の暴風域に入る確率（4日積算）": 3,
      "台風の暴風域に入る確率（5日積算）": 4,
    };

    type RegionAccumulator = {
      areaName: string; areaCode: string; prefName: string; prefCode: string;
      daily: (number | null)[]; series40: (number | null)[];
    };
    const regionMap = new Map<string, RegionAccumulator>();

    function ensureRegion(item: unknown): RegionAccumulator | null {
      const area = dig(item, "Area");
      const code = str(dig(area, "Code"));
      if (!code) return null;
      let r = regionMap.get(code);
      if (r == null) {
        r = {
          areaName: str(dig(area, "Name")),
          areaCode: code,
          prefName: str(dig(area, "Prefecture")),
          prefCode: str(dig(area, "PrefectureCode")),
          daily: [null, null, null, null, null],
          series40: [],
        };
        regionMap.set(code, r);
      }
      return r;
    }

    for (const mi of metInfoList) {
      const miType = str(dig(mi, "@_type"));
      if (miType in DAY_TYPES) {
        const dayIdx = DAY_TYPES[miType];
        const seenInSection = new Set<string>();
        for (const item of listOf(dig(mi, "Item"))) {
          const r = ensureRegion(item);
          if (r == null) continue;
          if (seenInSection.has(r.areaCode)) {
            base.parserDiagnostics.duplicateCodes.push(r.areaCode);
            continue;
          }
          seenInSection.add(r.areaCode);
          const prop = findProperty(item, "台風の暴風域に入る確率");
          const part = dig(prop, "FiftyKtWindProbabilityPart");
          const vals = listOf(dig(part, "FiftyKtWindProbability"));
          if (vals.length > 0) {
            r.daily[dayIdx] = toNumberOrNull(nodeText(vals[0]));
          }
        }
      }
    }

    // ─── TimeSeriesInfo ───
    const timeDefineByTimeId = new Map<number, string>();
    const tsiList = listOf(dig(metInfos, "TimeSeriesInfo"));
    if (tsiList.length > 0) {
      if (tsiList.length > 1) {
        base.parserDiagnostics.unknownAttributes.push(
          `TimeSeriesInfo count=${tsiList.length} (expected 1)`,
        );
      }
      const tsi = tsiList[0];

      const tdNodes = listOf(dig(dig(tsi, "TimeDefines"), "TimeDefine"));
      for (const td of tdNodes) {
        const timeIdStr = str(dig(td, "@_timeId"));
        const timeId = parseInt(timeIdStr, 10);
        if (isNaN(timeId)) {
          base.parserDiagnostics.unknownAttributes.push(`timeId=${timeIdStr}`);
          continue;
        }
        if (timeDefineByTimeId.has(timeId)) {
          base.parserDiagnostics.unknownAttributes.push(`timeId duplicate: ${timeId}`);
        } else {
          timeDefineByTimeId.set(timeId, str(dig(td, "DateTime")));
        }
        base.timeDefines.push({
          timeId,
          dateTime: str(dig(td, "DateTime")),
          duration: str(dig(td, "Duration")),
        });
      }
      const stepCount = base.timeDefines.length;
      const seenInTs = new Set<string>();
      for (const item of listOf(dig(tsi, "Item"))) {
        const r = ensureRegion(item);
        if (r == null) continue;
        if (seenInTs.has(r.areaCode)) {
          base.parserDiagnostics.duplicateCodes.push(r.areaCode);
          continue;
        }
        seenInTs.add(r.areaCode);
        const prop = findProperty(item, "台風の暴風域に入る確率");
        const part = dig(prop, "FiftyKtWindProbabilityPart");
        const vals = listOf(dig(part, "FiftyKtWindProbability"));
        r.series40 = new Array(stepCount).fill(null);
        for (const v of vals) {
          const refIdStr = str(dig(v, "@_refID"));
          const refId = parseInt(refIdStr, 10);
          const unit = str(dig(v, "@_unit"));
          if (unit !== "%") {
            base.parserDiagnostics.unknownAttributes.push(`unit=${unit}`);
          }
          if (isNaN(refId) || refId < 1 || refId > stepCount) {
            base.parserDiagnostics.unknownAttributes.push(
              `refID=${refIdStr} (out of range 1..${stepCount})`,
            );
            continue;
          }
          r.series40[refId - 1] = toNumberOrNull(nodeText(v));
        }
      }
    }

    // ─── regions 組み立て + peak 算出 ───
    base.regions = Array.from(regionMap.values()).map(r => {
      let peak: TyphoonProbPeak;
      if (base.timeDefines.length === 0) {
        peak = { kind: "noData", reason: "missingTimeDefines" };
      } else if (r.series40.length === 0 || r.series40.every(v => v == null)) {
        peak = { kind: "noData", reason: "missingSeries" };
      } else {
        const maxVal = Math.max(...r.series40.map(v => v ?? 0));
        if (maxVal === 0) {
          peak = { kind: "allZero" };
        } else {
          const ties: number[] = [];
          let argmax = 0;
          for (let i = 0; i < r.series40.length; i++) {
            const v = r.series40[i] ?? 0;
            if (v === maxVal) {
              ties.push(i + 1);
              if (ties.length === 1) argmax = i;
            }
          }
          peak = {
            kind: "value",
            step: argmax + 1,
            time: timeDefineByTimeId.get(argmax + 1) ?? "",
            value: maxVal,
            ties,
          };
        }
      }
      return { ...r, peak };
    });

    // ─── daily 単調性チェック ───
    for (const r of base.regions) {
      for (let i = 0; i < r.daily.length - 1; i++) {
        const a = r.daily[i], b = r.daily[i + 1];
        if (a != null && b != null && a > b) {
          base.parserDiagnostics.dailyAnomalies.push({
            areaCode: r.areaCode,
            daily: r.daily,
            reason: `day${i + 1} (${a}%) > day${i + 2} (${b}%)`,
          });
          break;
        }
      }
    }

    // ─── section code 集合一致チェック（簡易） ───
    for (const r of base.regions) {
      const missingInDaily = r.daily.some(v => v == null);
      const missingInTs = base.timeDefines.length > 0 && r.series40.length === 0;
      if (missingInDaily || missingInTs) {
        base.parserDiagnostics.sectionCodeCountMismatch = true;
        break;
      }
    }

    // ─── diagnostics warn 集計 ───
    const d = base.parserDiagnostics;
    if (d.duplicateCodes.length || d.dailyAnomalies.length || d.sectionCodeCountMismatch) {
      log.warn(
        `[VPTA50] diagnostics: duplicateCodes=${d.duplicateCodes.length} ` +
        `dailyAnomalies=${d.dailyAnomalies.length} sectionMismatch=${d.sectionCodeCountMismatch}`
      );
    }

    // ─── memory guard (compactOnly / raw) ───
    const fb = decideFallback(base.regions.length, base.timeDefines.length, decodedBytes);
    if (fb === "raw") {
      // 現状の閾値だけなら到達しない (5MB は冒頭で raw 返却済)。
      // 将来 raw 判定を厳しくしたとき防御的に効くよう置く。
      return null;
    }
    base.fallback = fb;

    return base;
  } catch (err) {
    log.error(`parseTyphoonProbability: parse error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
