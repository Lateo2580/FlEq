import {
  WsDataMessage,
  ParsedTyphoonAnalysis,
  TyphoonName,
  TyphoonFrame,
  TyphoonClass,
  TyphoonCenter,
  TyphoonWind,
  TyphoonWindArea,
  TyphoonWindAxis,
  TyphoonLifecycle,
} from "../types";
import { decodeBody, dig, str } from "./telegram-parser";
import { listOf, toNumberOrNull, nodeText } from "./timeseries-common";
import { requireTelegramMeta } from "./telegram-ingress";
import { createJmxXmlParser } from "./xml-shape";
import { extractSpecialValue } from "./special-value";
import * as log from "../logger";

const typhoonXmlParser = createJmxXmlParser((name) =>
  ["MeteorologicalInfo", "Item", "Kind", "Property", "WarningAreaPart"].includes(name),
);

function findProperty(item: unknown, typeName: string): unknown {
  for (const kind of listOf(dig(item, "Kind"))) {
    for (const prop of listOf(dig(kind, "Property"))) {
      if (str(dig(prop, "Type")) === typeName) return prop;
    }
  }
  return null;
}

function nodeByUnit(nodes: unknown, unit: string): unknown {
  for (const n of listOf(nodes)) {
    if (str(dig(n, "@_unit")) === unit) return n;
  }
  return undefined;
}

/** 既存 scalar adapter。canonical の presence にかかわらず従来の数値化を維持する。 */
function numByUnit(nodes: unknown, unit: string): number | null {
  const node = nodeByUnit(nodes, unit);
  return node === undefined ? null : toNumberOrNull(nodeText(node));
}

function parseWindArea(wap: unknown): TyphoonWindArea {
  const thresholdMs = numByUnit(dig(wap, "jmx_eb:WindSpeed"), "m/s");
  const axes: TyphoonWindAxis[] = [];
  const circle = dig(wap, "jmx_eb:Circle");
  const axesNode = dig(circle, "jmx_eb:Axes");
  for (const axis of listOf(dig(axesNode, "jmx_eb:Axis"))) {
    const dirNode = dig(axis, "jmx_eb:Direction");
    const direction =
      str(dig(dirNode, "@_description")) || nodeText(dirNode) || null;
    let radiusKm: number | null = null;
    for (const r of listOf(dig(axis, "jmx_eb:Radius"))) {
      if (str(dig(r, "@_unit")) !== "km") continue;
      radiusKm =
        str(dig(r, "@_condition")) === "なし" ? null : toNumberOrNull(nodeText(r));
    }
    axes.push({ direction, radiusKm });
  }
  return { thresholdMs, axes };
}

function parseFrame(info: unknown): TyphoonFrame {
  const dt = dig(info, "DateTime");
  const label = str(dig(dt, "@_type"));
  const kind = label.startsWith("実況")
    ? "実況"
    : label.startsWith("推定")
    ? "推定"
    : "予報";
  const item = listOf(dig(info, "Item"))[0];

  const classPart = dig(findProperty(item, "階級"), "ClassPart");
  const typhoonClass: TyphoonClass = {
    category: nodeText(dig(classPart, "jmx_eb:TyphoonClass")) || null,
    intensity: nodeText(dig(classPart, "jmx_eb:IntensityClass")) || null,
    size: nodeText(dig(classPart, "jmx_eb:AreaClass")) || null,
  };

  const centerPart = dig(findProperty(item, "中心"), "CenterPart");
  const probCircle = dig(centerPart, "ProbabilityCircle");
  let coordinate: string | null = null;
  let forecastCircleRadiusKm: number | null = null;
  if (probCircle != null) {
    const axis = listOf(dig(dig(probCircle, "jmx_eb:Axes"), "jmx_eb:Axis"))[0];
    forecastCircleRadiusKm = numByUnit(dig(axis, "jmx_eb:Radius"), "km");
  } else {
    for (const c of listOf(dig(centerPart, "jmx_eb:Coordinate"))) {
      if (str(dig(c, "@_type")) === "中心位置（度）") {
        coordinate = str(dig(c, "@_description")) || null;
      }
    }
  }
  const movementSpeedNode = nodeByUnit(dig(centerPart, "jmx_eb:Speed"), "km/h");
  const pressureNode = nodeByUnit(dig(centerPart, "jmx_eb:Pressure"), "hPa");
  const center: TyphoonCenter = {
    location: str(dig(centerPart, "Location")) || null,
    coordinate,
    forecastCircleRadiusKm,
    moveDirection: nodeText(dig(centerPart, "jmx_eb:Direction")) || null,
    moveSpeedKmh: numByUnit(dig(centerPart, "jmx_eb:Speed"), "km/h"),
    pressureHpa: numByUnit(dig(centerPart, "jmx_eb:Pressure"), "hPa"),
    moveSpeedKmhValue: extractSpecialValue("MovementSpeed", movementSpeedNode),
    pressureHpaValue: extractSpecialValue("Pressure", pressureNode),
  };

  const windProp = findProperty(item, "風");
  let wind: TyphoonWind | null = null;
  if (windProp != null) {
    const windPart = dig(windProp, "WindPart");
    let maxWindMs: number | null = null;
    let maxGustMs: number | null = null;
    let maxWindMsValue = extractSpecialValue("WindSpeed", undefined);
    let maxGustMsValue = extractSpecialValue("WindSpeed", undefined);
    for (const w of listOf(dig(windPart, "jmx_eb:WindSpeed"))) {
      if (str(dig(w, "@_unit")) !== "m/s") continue;
      const t = str(dig(w, "@_type"));
      if (t === "最大風速") {
        maxWindMs = toNumberOrNull(nodeText(w));
        maxWindMsValue = extractSpecialValue("WindSpeed", w);
      } else if (t === "最大瞬間風速") {
        maxGustMs = toNumberOrNull(nodeText(w));
        maxGustMsValue = extractSpecialValue("WindSpeed", w);
      }
    }
    let stormArea: TyphoonWindArea | null = null;
    let galeArea: TyphoonWindArea | null = null;
    let stormWarningArea: TyphoonWindArea | null = null;
    for (const wap of listOf(dig(windProp, "WarningAreaPart"))) {
      const t = str(dig(wap, "@_type"));
      const area = parseWindArea(wap);
      if (t === "暴風域") stormArea = area;
      else if (t === "強風域") galeArea = area;
      else if (t === "暴風警戒域") stormWarningArea = area;
    }
    wind = {
      maxWindMs,
      maxGustMs,
      maxWindMsValue,
      maxGustMsValue,
      stormArea,
      galeArea,
      stormWarningArea,
    };
  }

  return { kind, label, validTime: nodeText(dt), typhoonClass, center, wind };
}

function typhoonLifecycle(name: TyphoonName | null, frames: TyphoonFrame[]): TyphoonLifecycle {
  const remark = name?.remark?.trim() ?? "";
  if (/台風発生の可能性が小さくなった|台風発生予想.*(?:終了|中止|取りやめ)/u.test(remark)) {
    return "formationCancelled";
  }
  const current = frames.find((frame) => frame.kind === "実況") ?? frames[0];
  const category = current?.typhoonClass.category ?? "";
  if (category.includes("温帯低気圧") || category === "LOW" || /台風消滅|温帯低気圧化/u.test(remark)) {
    return "transitionedToLow";
  }
  if (remark.includes("台風発生予想")) return "forming";
  return "active";
}

export function parseTyphoonAnalysis(
  msg: WsDataMessage,
): ParsedTyphoonAnalysis | null {
  try {
    const meta = requireTelegramMeta(msg);
    const xmlStr = decodeBody(msg);
    const parsed = typhoonXmlParser.parse(xmlStr) as Record<string, unknown>;
    const report =
      (dig(parsed, "Report") as Record<string, unknown> | undefined) ??
      (dig(parsed, "jmx:Report") as Record<string, unknown> | undefined);
    if (report == null) return null;

    const control = dig(report, "Control");
    const head = dig(report, "Head");
    const body = dig(report, "Body");
    const infosList = listOf(dig(body, "MeteorologicalInfos"));
    if (infosList.length > 1) {
      log.warn(
        `parseTyphoonAnalysis: MeteorologicalInfos が ${infosList.length} 件。先頭を採用`,
      );
    }
    const infos = infosList[0];

    let name: TyphoonName | null = null;
    const frames: TyphoonFrame[] = [];
    for (const info of listOf(dig(infos, "MeteorologicalInfo"))) {
      const item = listOf(dig(info, "Item"))[0];
      const namingProp = findProperty(item, "呼称");
      if (namingProp != null && name == null) {
        const np = dig(namingProp, "TyphoonNamePart");
        name = {
          name: str(dig(np, "Name")) || null,
          nameKana: str(dig(np, "NameKana")) || null,
          number: str(dig(np, "Number")) || null,
          remark: str(dig(np, "Remark")) || null,
        };
      }
      frames.push(parseFrame(info));
    }

    return {
      type: msg.head.type,
      infoType: str(dig(head, "InfoType")),
      title: str(dig(head, "Title")),
      controlTitle: str(dig(control, "Title")),
      infoKind: str(dig(head, "InfoKind")),
      infoKindVersion: str(dig(head, "InfoKindVersion")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      publishingOffice:
        msg.xmlReport?.control?.publishingOffice ||
        str(dig(control, "PublishingOffice")),
      eventId: str(dig(head, "EventID")) || null,
      serial: str(dig(head, "Serial")) || null,
      headline: str(dig(dig(head, "Headline"), "Text")) || null,
      name,
      frames,
      lifecycle: typhoonLifecycle(name, frames),
      meta,
      isTest: meta.isTest,
    };
  } catch (err) {
    log.error(
      `parseTyphoonAnalysis: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
