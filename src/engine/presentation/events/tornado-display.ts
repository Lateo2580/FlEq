import type {
  TornadoArea,
  TornadoAreaLayer,
  WsDataMessage,
} from "../../../types";
import { decodeBody } from "../../../dmdata/telegram-parser";
import { createJmxXmlParser, dig, listOf } from "../../../dmdata/xml-shape";

const TORNADO_WARNING_TYPES = [
  "竜巻注意情報（発表細分）",
  "竜巻注意情報（一次細分区域等）",
  "竜巻注意情報（市町村等をまとめた地域等）",
  "竜巻注意情報（市町村等）",
] as const;

const ANNOUNCEMENT_AREA_TYPE = "竜巻注意情報（発表細分）";
const MUNICIPALITY_AREA_TYPE = "竜巻注意情報（市町村等）";

const tornadoCoverageXmlParser = createJmxXmlParser((name) =>
  ["Warning", "Item", "Kind", "Area"].includes(name),
);

export interface TornadoCoverageLayer {
  type: string;
  source: "body";
  areas: TornadoArea[];
}

export interface TornadoDisplay {
  aggregation: "proven-full-scope" | "none";
  areaNames: string[];
  sourceAreaCount: number;
}

function requiredText(value: unknown): string | null {
  const text = typeof value === "string"
    ? value.trim()
    : value != null && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === 1 && typeof (value as Record<string, unknown>)["#text"] === "string"
      ? ((value as Record<string, unknown>)["#text"] as string).trim()
      : "";
  return text === "" ? null : text;
}

function coverageStatus(
  name: string,
  code: string,
  status: string,
): TornadoArea["status"] | null {
  if (name === "なし" && code === "0" && status === "なし") return "none";
  if (name === "竜巻注意情報" && code === "1" && status === "発表") return "active";
  return null;
}

/**
 * Body.Warning だけを表示射影用に読む。既存 parser の active-only layer や
 * fingerprint には触れず、全域を証明できない構造は null に畳む。
 */
export function readTornadoBodyCoverage(
  msg: WsDataMessage,
): TornadoCoverageLayer[] | null {
  try {
    const parsed = tornadoCoverageXmlParser.parse(decodeBody(msg));
    const report = dig(parsed, "Report") ?? dig(parsed, "jmx:Report");
    const body = dig(report, "Body");
    const warnings = listOf(dig(body, "Warning"));
    if (warnings.length !== TORNADO_WARNING_TYPES.length) return null;

    const layers: TornadoCoverageLayer[] = [];
    const seenTypes = new Set<string>();
    for (const warning of warnings) {
      const type = requiredText(dig(warning, "@_type"));
      if (
        type == null ||
        !TORNADO_WARNING_TYPES.includes(type as (typeof TORNADO_WARNING_TYPES)[number]) ||
        seenTypes.has(type)
      ) return null;
      seenTypes.add(type);

      const items = listOf(dig(warning, "Item"));
      if (items.length === 0) return null;
      const areas: TornadoArea[] = [];
      for (const item of items) {
        const kinds = listOf(dig(item, "Kind"));
        const itemAreas = listOf(dig(item, "Area"));
        if (kinds.length !== 1 || itemAreas.length !== 1) return null;

        const kind = kinds[0];
        const area = itemAreas[0];
        const name = requiredText(dig(area, "Name"));
        const code = requiredText(dig(area, "Code"));
        const kindName = requiredText(dig(kind, "Name"));
        const kindCode = requiredText(dig(kind, "Code"));
        const kindStatus = requiredText(dig(kind, "Status"));
        if (
          name == null || code == null || kindName == null || kindCode == null ||
          kindStatus == null
        ) return null;
        const status = coverageStatus(kindName, kindCode, kindStatus);
        if (status == null) return null;
        areas.push({ name, code, status });
      }
      layers.push({ type, source: "body", areas });
    }
    return seenTypes.size === TORNADO_WARNING_TYPES.length ? layers : null;
  } catch {
    return null;
  }
}

export function formatTornadoFullScopeLabel(name: string): string {
  return /[都道府県]$/.test(name) ? `${name}内全域` : `${name}全域`;
}

/** Rider 専用表示。全域の証拠がなければ既存の細粒度一覧へ安全に戻す。 */
export function projectTornadoDisplay(
  msg: WsDataMessage,
  layers: TornadoAreaLayer[],
  preferred: TornadoAreaLayer | undefined,
): TornadoDisplay {
  const fallback = {
    aggregation: "none" as const,
    areaNames: preferred?.areas.map((area) => area.name) ?? [],
    sourceAreaCount: preferred?.areas.length ?? 0,
  };
  const coverage = readTornadoBodyCoverage(msg);
  if (
    coverage == null ||
    coverage.some((layer) =>
      layer.areas.some((area) => area.status !== "active") ||
      new Set(layer.areas.map((area) => area.code)).size !== layer.areas.length,
    )
  ) {
    return fallback;
  }

  const municipalities = coverage.find((layer) => layer.type === MUNICIPALITY_AREA_TYPE);
  const announcements = coverage.find((layer) => layer.type === ANNOUNCEMENT_AREA_TYPE);
  const activeMunicipalityLayer = layers.find((layer) => layer.type === MUNICIPALITY_AREA_TYPE);
  if (municipalities == null || announcements == null || activeMunicipalityLayer == null) return fallback;

  const rosterCodes = new Set(municipalities.areas.map((area) => area.code));
  const activeCodes = new Set(activeMunicipalityLayer.areas.map((area) => area.code));
  if (
    rosterCodes.size !== activeCodes.size ||
    [...rosterCodes].some((code) => !activeCodes.has(code))
  ) return fallback;

  return {
    aggregation: "proven-full-scope",
    areaNames: announcements.areas.map((area) => formatTornadoFullScopeLabel(area.name)),
    sourceAreaCount: fallback.sourceAreaCount,
  };
}
