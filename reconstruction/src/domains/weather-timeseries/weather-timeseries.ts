import type { DecodedMaterial, MaterialValue, XmlElement, XmlNode } from "../../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, RejectionReason, ReportRef } from "../../../contracts/p2-shared-runtime.types";
import type { WeatherTimeseriesCompoundField, WeatherTimeseriesSnapshot, WeatherTimeseriesValue } from "../../../contracts/p2-weather-timeseries-unit.types";
import { classifyMaterial } from "../../decode-material/decode-material";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";

const TYPE = "量的予想時系列（市町村等）";
const PARTS = new Set(["SignificancyPart", "PrecipitationPart", "WindDirectionPart", "WindSpeedPart",
  "SnowfallDepthPart", "WaveHeightPart", "TidalLevelPart", "VisibilityPart", "HumidityPart"]);
const CODES = new Set(["00", "01", "11", "20", "21", "22", "30", "31", "41", "50", "51"]);
type Candidate = Readonly<{ source: ReportRef; reportDateTimeMs: number; cancelled: boolean;
  snapshot: WeatherTimeseriesSnapshot; validUntil: number | null }>;
type Result = Readonly<{ kind: "accepted"; candidate: Candidate }> | Readonly<{
  kind: "rejected"; subject: string; reason: RejectionReason; diagnostic: DiagnosticDetails }>;

const localName = (node: XmlElement): string => node.name.split(":").at(-1)!;
function children(parent: XmlElement | null, name?: string): XmlElement[] {
  return parent == null ? [] : parent.children.filter((node): node is XmlElement =>
    node.kind === "element" && (name == null || localName(node) === name));
}
function scalar(node: XmlElement): string | null {
  return children(node).length === 0 ? node.children.filter((part): part is Extract<XmlNode, { kind: "text" }> =>
    part.kind === "text").map((part) => part.value).join("").trim() : null;
}
function field(parent: XmlElement | null, name: string): { value: string | null; reason: RejectionReason | null } {
  const found = children(parent, name);
  if (found.length === 0 || found.length === 1 && scalar(found[0]) === "")
    return { value: null, reason: "requiredStructureMissing" };
  if (found.length !== 1 || scalar(found[0]) == null)
    return { value: null, reason: "requiredStructureInvalid" };
  return { value: scalar(found[0]), reason: null };
}
function attr(node: XmlElement, name: string): string[] {
  return node.attributes.filter((item) => item.name === name).map((item) => item.value);
}
function nonemptyText(node: XmlElement): boolean {
  return node.children.some((part) => part.kind === "text" && part.value.trim() !== "");
}
function timestamp(raw: string): number | null {
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
  if (match == null) return null;
  const [, y, mo, d, h, mi, s, zone] = match;
  const local = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  if ([local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCHours(),
    local.getUTCMinutes(), local.getUTCSeconds()].some((value, index) => value !== +[y, mo, d, h, mi, s][index])) return null;
  if (zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4, 6) > 59)) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
function duration(raw: string): number | null {
  const match = raw.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (match == null || match.slice(1).every((part) => part == null)) return null;
  const ms = (((+(match[1] ?? 0) * 24 + +(match[2] ?? 0)) * 60 + +(match[3] ?? 0)) * 60 + +(match[4] ?? 0)) * 1000;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}
function rawText(node: XmlElement): string {
  return node.children.filter((part): part is Extract<XmlNode, { kind: "text" }> => part.kind === "text")
    .map((part) => part.value).join("");
}
function compound(node: XmlElement, leaves: ReadonlyMap<XmlElement, MaterialValue>): WeatherTimeseriesValue {
  const value = (part: XmlElement): MaterialValue => leaves.get(part) ?? { kind: "missing" };
  const fields = (parent: XmlElement): readonly WeatherTimeseriesCompoundField[] => children(parent).map(fieldValue);
  const fieldValue = (part: XmlElement): WeatherTimeseriesCompoundField => ({ name: part.name, attributes: part.attributes,
    value: children(part).length === 0 ? value(part) : fields(part) });
  if (localName(node) === "Significancy") {
    const name = children(node, "Name")[0], code = children(node, "Code")[0];
    const raw = code == null ? null : rawText(code);
    return { kind: "significancy", name: name == null ? { kind: "missing" } : value(name),
      code: raw == null ? { kind: "missing" } : raw.trim() === "" ? { kind: "empty", raw }
        : CODES.has(raw) ? { kind: "text", value: raw, raw } : { kind: "unknown", raw } };
  }
  if (localName(node) === "PeakTime" || localName(node) === "CriteriaPeriod")
    return { kind: localName(node) === "PeakTime" ? "peakTime" : "criteriaPeriod", fields: fields(node) };
  return value(node);
}
const EMPTY: WeatherTimeseriesSnapshot = { strings: [], attributes: [], values: [], series: [], areas: [], locals: [], kinds: [], periods: [] };

// AC01/Q-ENUM: validation precedes every state mutation, including deadline collection.
function inspect(material: DecodedMaterial): Result {
  const controls = children(material.xml, "Control"), offices = controls.flatMap((node) => children(node, "EditorialOffice"));
  const office = offices.length === 1 ? scalar(offices[0]) : null;
  const subject = office != null && office !== "" ? `${material.operation}/VPWP50/${office}` : "";
  const reject = (reason: RejectionReason): Result => ({ kind: "rejected", subject, reason,
    diagnostic: { level: "WARN", component: "weather-timeseries", reason, inputId: material.inputId, unit: "U-F" } });
  const common = validateSemanticEnvelope(material);
  if (common.kind === "rejected") return reject(common.reason);
  if (controls.length === 0 || offices.length === 0 || offices.length === 1 && office === "") return reject("identityMissing");
  const heads = children(material.xml, "Head"), bodies = children(material.xml, "Body");
  const containers = bodies.flatMap((body) => children(body, "MeteorologicalInfos"));
  const seriesNodes = containers.flatMap((node, position) => children(node, "TimeSeriesInfo").map((series, index) =>
    ({ series, position, index })));
  const items = seriesNodes.flatMap(({ series }) => children(series, "Item"))
    .filter((item) => !nonemptyText(item) && children(item).every((node) => ["Kind", "Area"].includes(localName(node))));
  const areas = items.flatMap((item) => children(item, "Area"));
  const codes = areas.flatMap((area) => children(area, "Code"));
  if (items.some((item) => children(item, "Area").length === 0)
    || areas.some((area) => !nonemptyText(area) && children(area).every((node) => ["Name", "Code"].includes(localName(node)))
      && (children(area, "Code").length === 0 || children(area, "Code").length === 1 && scalar(children(area, "Code")[0]) === "")))
    return reject("identityMissing");
  if (controls.length !== 1 || offices.length !== 1 || office == null
    || items.some((item) => children(item, "Area").length !== 1)
    || areas.some((area) => children(area, "Code").length !== 1 || nonemptyText(area)
      || children(area).some((node) => !["Name", "Code"].includes(localName(node))))
    || codes.some((code) => scalar(code) == null || !/^\d+$/.test(scalar(code)!))) return reject("identityInvalid");

  const infoType = heads.length === 1 ? field(heads[0], "InfoType") : { value: null, reason: "requiredStructureInvalid" as const };
  const validInfoType = infoType.reason == null && (["発表", "訂正", "取消"] as readonly string[]).includes(infoType.value!);
  let missing = infoType.reason === "requiredStructureMissing" || bodies.length === 0;
  let invalid = material.headType !== "VPWP50" || !validInfoType || bodies.length > 1;
  const validBody = bodies.length === 1 && !nonemptyText(bodies[0]);
  if (bodies.length === 1 && !validBody) invalid = true;
  if (validBody && containers.length === 0) missing = true;
  const validContainers = new Set<number>();
  if (validBody) containers.forEach((node, position) => {
    const types = attr(node, "type");
    if (types.length === 0 || types.length === 1 && types[0].trim() === "") missing = true;
    else if (types.length !== 1 || types[0] !== TYPE || nonemptyText(node)
      || children(node).some((child) => localName(child) !== "TimeSeriesInfo")) invalid = true;
    else if (validInfoType) validContainers.add(position);
  });
  const read = (parent: XmlElement, name: string): string | null => {
    const result = field(parent, name);
    if (result.reason === "requiredStructureMissing") missing = true;
    if (result.reason === "requiredStructureInvalid") invalid = true;
    return result.value;
  };
  // AC02/Q-VALUES: P1 owns scalar classification; associate its leaf results with their XML nodes.
  const classified = classifyMaterial(material).materialValues;
  const leaves = new Map<XmlElement, MaterialValue>();
  let leafIndex = 0;
  const bindLeaves = (node: XmlElement): void => {
    const nested = children(node);
    if (nested.length === 0) leaves.set(node, classified[leafIndex++]);
    else nested.forEach(bindLeaves);
  };
  bindLeaves(material.xml);
  const strings: string[] = [], attributes: (readonly (readonly [number, number])[])[] = [], values: WeatherTimeseriesValue[] = [];
  const series: WeatherTimeseriesSnapshot["series"][number][] = [], areaTable: WeatherTimeseriesSnapshot["areas"][number][] = [];
  const locals: WeatherTimeseriesSnapshot["locals"][number][] = [], kinds: WeatherTimeseriesSnapshot["kinds"][number][] = [];
  const periods: WeatherTimeseriesSnapshot["periods"][number][] = [];
  const intern = (value: string): number => { let index = strings.indexOf(value); if (index < 0) index = strings.push(value) - 1; return index; };
  const areaKeys = new Map<string, number>(), localKeys = new Map<string, number>();
  const kindKeys = new Map<string, number>(), attributeKeys = new Map<string, number>(), valueKeys = new Map<string, number>();
  const shared = <T>(table: T[], keys: Map<string, number>, value: T): number => {
    const key = JSON.stringify(value), found = keys.get(key);
    if (found != null) return found;
    const index = table.push(value) - 1;
    keys.set(key, index);
    return index;
  };
  const optional = (parent: XmlElement, name: string): number | null => {
    const found = children(parent, name);
    if (found.length > 1 || found.length === 1 && scalar(found[0]) == null) invalid = true;
    return found.length === 0 || scalar(found[0]) == null ? null : intern(scalar(found[0])!);
  };
  let validUntil: number | null = null;
  for (const { series: seriesNode, position, index } of seriesNodes) {
    if (!validContainers.has(position)) continue;
    if (nonemptyText(seriesNode) || children(seriesNode).some((node) => !["TimeDefines", "Item"].includes(localName(node)))) {
      invalid = true; continue;
    }
    const timeContainers = children(seriesNode, "TimeDefines"), timeContainer = timeContainers[0] ?? null;
    if (timeContainers.length === 0) missing = true;
    const brokenTimes = timeContainers.length > 1 || timeContainer != null && (nonemptyText(timeContainer)
      || children(timeContainer).some((node) => localName(node) !== "TimeDefine"));
    if (brokenTimes) invalid = true;
    const timeNodes = brokenTimes ? [] : children(timeContainer, "TimeDefine"), itemNodes = children(seriesNode, "Item");
    if (!brokenTimes && timeNodes.length === 0 || itemNodes.length === 0) missing = true;
    const times: WeatherTimeseriesSnapshot["series"][number]["timeDefines"][number][] = [];
    const byId = new Map<string, number>();
    for (const time of timeNodes) {
      if (nonemptyText(time) || children(time).some((node) => !["DateTime", "Duration", "Name"].includes(localName(node)))) {
        invalid = true; continue;
      }
      const ids = attr(time, "timeId"), dateRaw = read(time, "DateTime"), durationRaw = read(time, "Duration");
      if (ids.length === 0 || ids[0].trim() === "") missing = true;
      if (ids.length !== 1 || byId.has(ids[0])) invalid = true;
      const startMs = dateRaw == null ? null : timestamp(dateRaw), length = durationRaw == null ? null : duration(durationRaw);
      if (dateRaw != null && startMs == null || durationRaw != null && length == null) invalid = true;
      if (startMs != null && length != null && !Number.isFinite(new Date(startMs + length).getTime())) invalid = true;
      if (ids.length === 1 && ids[0].trim() !== "") byId.set(ids[0], times.length);
      times.push({ timeId: intern(ids[0] ?? ""), dateTimeRaw: intern(dateRaw ?? ""), durationRaw: intern(durationRaw ?? ""),
        name: optional(time, "Name"), startMs: startMs ?? 0, endMs: startMs != null && length != null ? startMs + length : 0 });
    }
    const seriesIndex = series.push({ meteorologicalInfosPosition: position, timeSeriesInfoPosition: index, timeDefines: times }) - 1;
    const seen = new Set<string>();
    for (const item of itemNodes) {
      if (nonemptyText(item) || children(item).some((node) => !["Kind", "Area"].includes(localName(node)))) {
        invalid = true; continue;
      }
      const area = children(item, "Area")[0];
      const areaIndex = shared(areaTable, areaKeys,
        { code: intern(scalar(children(area, "Code")[0]) ?? ""), name: optional(area, "Name") });
      const kindNodes = children(item, "Kind");
      if (kindNodes.length === 0) missing = true;
      for (const kind of kindNodes) {
        if (nonemptyText(kind) || children(kind).some((node) => !["Status", "DateTime", "Property"].includes(localName(node)))) {
          invalid = true; continue;
        }
        const date = children(kind, "DateTime");
        if (date.length > 1 || date.length === 1 && (scalar(date[0]) == null || attr(date[0], "type").length > 1)) invalid = true;
        const kindIndex = shared(kinds, kindKeys, { status: optional(kind, "Status"),
          dateTimeRaw: date.length === 1 && scalar(date[0]) != null ? intern(scalar(date[0])!) : null,
          dateTimeType: date.length === 1 && attr(date[0], "type").length === 1 ? intern(attr(date[0], "type")[0]) : null });
        const properties = children(kind, "Property");
        if (properties.length === 0) missing = true;
        for (const property of properties) {
          if (nonemptyText(property) || children(property).some((node) =>
            localName(node) !== "Type" && localName(node) !== "CriteriaPeriod" && !PARTS.has(localName(node)))) {
            invalid = true; continue;
          }
          const type = read(property, "Type"), parts = children(property).filter((node) => PARTS.has(localName(node)));
          if (parts.length === 0 && children(property, "CriteriaPeriod").length === 0) missing = true;
          const add = (node: XmlElement, placement: string, localIndex: number | null) => {
            const refs = attr(node, "refID");
            if (refs.length === 0 || refs[0].trim() === "") missing = true;
            if (refs.length !== 1 || !byId.has(refs[0])) invalid = true;
            const time = byId.get(refs[0]);
            const valueType = attr(node, "type"), attrs = node.attributes.filter((item) => item.name !== "refID" && item.name !== "type")
              .map((item) => [intern(item.name), intern(item.value)] as const);
            if (valueType.length > 1) invalid = true;
            const key = JSON.stringify([position, index, scalar(children(area, "Code")[0]), type, placement,
              localIndex == null ? null : locals[localIndex], node.name, valueType[0] ?? null, refs[0] ?? null]);
            if (seen.has(key)) invalid = true;
            seen.add(key);
            const value = compound(node, leaves);
            if (localName(node) === "Significancy" && (["Name", "Code"].some((name) => children(node, name).length > 1)
              || children(node).some((child) => !["Name", "Code"].includes(localName(child)) || scalar(child) == null))) invalid = true;
            if (localName(node) !== "Significancy" && localName(node) !== "PeakTime" && localName(node) !== "CriteriaPeriod"
              && children(node).length > 0) invalid = true;
            const row = [seriesIndex, areaIndex, kindIndex, intern(type ?? ""), intern(placement), localIndex,
              intern(node.name), valueType.length === 1 ? intern(valueType[0]) : null, time ?? 0,
              shared(attributes, attributeKeys, attrs), shared(values, valueKeys, value)] as const;
            periods.push(row);
            if (time != null) validUntil = Math.max(validUntil ?? -Infinity, times[time].endMs);
          };
          for (const part of parts) {
            if (nonemptyText(part) || children(part).some((node) => localName(node) !== "Base")) {
              invalid = true; continue;
            }
            const bases = children(part, "Base");
            if (bases.length === 0) missing = true;
            if (bases.length !== 1) invalid = true;
            for (const base of bases) {
              if (nonemptyText(base)) { invalid = true; continue; }
              const visit = (parent: XmlElement, localIndex: number | null) => {
                for (const node of children(parent).filter((child) => localName(child) !== "Local"
                  && (localIndex == null || !["Code", "AreaName", "Name"].includes(localName(child)))))
                  add(node, part.name + "/Base" + (localIndex == null ? "" : "/Local"), localIndex);
              };
              visit(base, null);
              children(base, "Local").forEach((local, localPosition) => {
                const areaName = children(local, "AreaName")[0] ?? null;
                if (nonemptyText(local) || areaName != null && attr(areaName, "code").length > 1) { invalid = true; return; }
                const code = optional(local, "Code"), areaNameCode = areaName == null ? null : attr(areaName, "code").length === 1
                  ? intern(attr(areaName, "code")[0]) : null;
                const name = optional(local, "Name"), areaNameValue = optional(local, "AreaName");
                const anonymous = [code, areaNameCode, name, areaNameValue].every((value) => value == null || strings[value] === "");
                const localIndex = shared(locals, localKeys, { code, areaNameCode, areaName: areaNameValue, name,
                  anonymousPosition: anonymous ? localPosition : null });
                visit(local, localIndex);
              });
            }
          }
          for (const node of children(property, "CriteriaPeriod")) add(node, "Property", null);
        }
      }
    }
  }
  if (seriesNodes.length > 0 && periods.length === 0 && !invalid) missing = true;
  if (missing) return reject("requiredStructureMissing");
  if (invalid) return reject("requiredStructureInvalid");
  const source: ReportRef = { inputId: material.inputId, origin: material.origin, operation: material.operation,
    family: "VPWP50", subject, reportDateTimeRaw: material.reportDateTimeRaw,
    serialRaw: material.serialRaw, infoTypeRaw: infoType.value! };
  return { kind: "accepted", candidate: { source, reportDateTimeMs: common.envelope.reportDateTimeMs,
    cancelled: infoType.value === "取消", snapshot: periods.length === 0 ? EMPTY
      : { strings, attributes, values, series, areas: areaTable, locals, kinds, periods }, validUntil } };
}

export { EMPTY, inspect };
export type { Candidate, Result };
