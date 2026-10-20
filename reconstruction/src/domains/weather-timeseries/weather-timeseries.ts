import type { DecodedMaterial, MaterialValue, XmlElement, XmlNode } from "../../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, RejectionReason, ReportRef } from "../../../contracts/p2-shared-runtime.types";
import type { WeatherTimeseriesCompoundField, WeatherTimeseriesSnapshot, WeatherTimeseriesValue } from "../../../contracts/p2-weather-timeseries-unit.types";
import { classifyMaterial } from "../../decode-material/decode-material";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";

const TYPE = "量的予想時系列（市町村等）";
const PARTS = new Set(["SignificancyPart", "PrecipitationPart", "WindDirectionPart", "WindSpeedPart",
  "SnowfallDepthPart", "WaveHeightPart", "TidalLevelPart", "VisibilityPart", "HumidityPart"]);
// P3-WS-AC01: 値の名前。これに無い Base・Local の子は、period として欠けなく読めるときだけ値にする（P3-WS-D-ADDITION）。
const VALUES: ReadonlySet<string> = new Set(["PeakTime", "CriteriaPeriod", ...[...PARTS].map((name) => name.slice(0, -"Part".length))]);
const CODES = new Set(["00", "01", "11", "20", "21", "22", "30", "31", "41", "50", "51"]);
type Candidate = Readonly<{ source: ReportRef; reportDateTimeMs: number; cancelled: boolean;
  snapshot: WeatherTimeseriesSnapshot; validUntil: number | null }>;
// diagnostics は受理した報の読み飛ばしの診断（P3-WS-AC02）。unit の receive がそのまま step へ写す。
type Result = Readonly<{ kind: "accepted"; candidate: Candidate; diagnostics: readonly DiagnosticDetails[] }> | Readonly<{
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
// 表に無い子要素か空白でない地の文を持つ（Q-WS-LEVELS の外の階層の知らないもの）。
const foreign = (node: XmlElement, known: readonly string[]): boolean => nonemptyText(node) || children(node).some((child) => !known.includes(localName(child)));
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
  // P3-WS-AC10: Item・Area の知らない子は識別の検査に入れない（全部の Item の Area を検査する）。
  const items = seriesNodes.flatMap(({ series }) => children(series, "Item"));
  const areas = items.flatMap((item) => children(item, "Area"));
  const codes = areas.flatMap((area) => children(area, "Code"));
  if (items.some((item) => children(item, "Area").length === 0) || areas.some((area) => children(area, "Code").length === 0
    || children(area, "Code").length === 1 && scalar(children(area, "Code")[0]) === "")) return reject("identityMissing");
  if (controls.length !== 1 || offices.length !== 1 || office == null
    || items.some((item) => children(item, "Area").length !== 1) || areas.some((area) => children(area, "Code").length !== 1)
    || codes.some((code) => scalar(code) == null || !/^\d+$/.test(scalar(code)!))) return reject("identityInvalid");

  const infoType = heads.length === 1 ? field(heads[0], "InfoType") : { value: null, reason: "requiredStructureInvalid" as const };
  const validInfoType = infoType.reason == null && (["発表", "訂正", "取消"] as readonly string[]).includes(infoType.value!);
  let missing = infoType.reason === "requiredStructureMissing" || bodies.length === 0;
  let invalid = material.headType !== "VPWP50" || !validInfoType || bodies.length > 1;
  // P3-WS-AC10/Q-WS-LEVELS: 外の階層の知らないものは読まずに残りを読む。outer はそれが報に 1 つでもあったか、scoped はその範囲の period の数。
  // skipped は値の階層で読み飛ばした要素と地の文の数（P3-WS-AC02、付加事項は数えない）。
  let outer = false, scoped = 0, skipped = 0;
  const note = (own: boolean): boolean => { if (own) outer = true; return own; };
  const validBody = bodies.length === 1, wholeReport = validBody && note(nonemptyText(bodies[0]));
  if (validBody && containers.length === 0) missing = true;
  // 有効な容器の位置 → その範囲に知らないものがあるか。
  const validContainers = new Map<number, boolean>();
  if (validBody) containers.forEach((node, position) => {
    const types = attr(node, "type");
    if (types.length === 0 || types.length === 1 && types[0].trim() === "") missing = true;
    else if (types.length !== 1 || types[0] !== TYPE) invalid = true;
    else if (validInfoType) validContainers.set(position, note(foreign(node, ["TimeSeriesInfo"])) || wholeReport);
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
    const timeContainers = children(seriesNode, "TimeDefines"), timeContainer = timeContainers[0] ?? null;
    // TimeSeriesInfo と TimeDefines の直下の知らないものは、その系列が範囲。TimeDefine の直下はその timeId を引く period。
    const inSeries = note(foreign(seriesNode, ["TimeDefines", "Item"])) || validContainers.get(position) === true
      || timeContainers.length === 1 && note(foreign(timeContainers[0], ["TimeDefine"]));
    if (timeContainers.length === 0) missing = true;
    if (timeContainers.length > 1) invalid = true;
    const timeNodes = timeContainers.length > 1 ? [] : children(timeContainer, "TimeDefine"), itemNodes = children(seriesNode, "Item");
    if (timeContainers.length <= 1 && timeNodes.length === 0 || itemNodes.length === 0) missing = true;
    const times: WeatherTimeseriesSnapshot["series"][number]["timeDefines"][number][] = [];
    const byId = new Map<string, number>(), unclearTimes = new Set<number>();
    for (const time of timeNodes) {
      if (note(foreign(time, ["DateTime", "Duration", "Name"]))) unclearTimes.add(times.length);
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
      // 知らないものだけの範囲（その階層に読み飛ばしたものがあって必須の子が欠ける）は missing にしない（Q-WS-LEVELS）。
      const area = children(item, "Area")[0], ownItem = note(foreign(item, ["Kind", "Area"]));
      const inItem = inSeries || ownItem || note(foreign(area, ["Name", "Code"]));
      const areaIndex = shared(areaTable, areaKeys, { code: intern(scalar(children(area, "Code")[0]) ?? ""), name: optional(area, "Name") });
      const kindNodes = children(item, "Kind");
      if (kindNodes.length === 0 && !ownItem) missing = true;
      for (const kind of kindNodes) {
        const ownKind = note(foreign(kind, ["Status", "DateTime", "Property"])), inKind = inItem || ownKind;
        const date = children(kind, "DateTime");
        if (date.length > 1 || date.length === 1 && (scalar(date[0]) == null || attr(date[0], "type").length > 1)) invalid = true;
        const kindIndex = shared(kinds, kindKeys, { status: optional(kind, "Status"),
          dateTimeRaw: date.length === 1 && scalar(date[0]) != null ? intern(scalar(date[0])!) : null,
          dateTimeType: date.length === 1 && attr(date[0], "type").length === 1 ? intern(attr(date[0], "type")[0]) : null });
        const properties = children(kind, "Property");
        if (properties.length === 0 && !ownKind) missing = true;
        for (const property of properties) {
          const ownProperty = note(foreign(property, ["Type", "CriteriaPeriod", ...PARTS])), inProperty = inKind || ownProperty;
          const type = read(property, "Type"), parts = children(property).filter((node) => PARTS.has(localName(node)));
          if (parts.length === 0 && children(property, "CriteriaPeriod").length === 0 && !ownProperty) missing = true;
          const keyOf = (node: XmlElement, placement: string, localIndex: number | null): string => JSON.stringify([position, index,
            scalar(children(area, "Code")[0]), type, placement, localIndex == null ? null : locals[localIndex], node.name,
            attr(node, "type")[0] ?? null, attr(node, "refID")[0] ?? null]);
          // P3-WS-D-ADDITION の (b): 値の名前でない要素は、period として欠けなく読めるときだけ値にする。
          const readable = (node: XmlElement, placement: string, localIndex: number | null): boolean => attr(node, "refID").length === 1
            && byId.has(attr(node, "refID")[0]) && attr(node, "type").length <= 1 && children(node).length === 0 && !seen.has(keyOf(node, placement, localIndex));
          const add = (node: XmlElement, placement: string, localIndex: number | null, inScope: boolean) => {
            const refs = attr(node, "refID");
            if (refs.length === 0 || refs[0].trim() === "") missing = true;
            if (refs.length !== 1 || !byId.has(refs[0])) invalid = true;
            const time = byId.get(refs[0]);
            const valueType = attr(node, "type"), attrs = node.attributes.filter((item) => item.name !== "refID" && item.name !== "type")
              .map((item) => [intern(item.name), intern(item.value)] as const);
            if (valueType.length > 1) invalid = true;
            const key = keyOf(node, placement, localIndex);
            if (seen.has(key)) invalid = true;
            seen.add(key);
            const value = compound(node, leaves);
            // Significancy の Name・Code の他の子は、その period が範囲（Q-WS-LEVELS）。Name・Code の 2 個以上・子を持つものは今どおり拒否。
            const ownValue = localName(node) === "Significancy" && note(children(node).some((child) => !["Name", "Code"].includes(localName(child))));
            if (localName(node) === "Significancy" && (["Name", "Code"].some((name) => children(node, name).length > 1)
              || children(node).some((child) => ["Name", "Code"].includes(localName(child)) && scalar(child) == null))) invalid = true;
            if (!["Significancy", "PeakTime", "CriteriaPeriod"].includes(localName(node)) && children(node).length > 0) invalid = true;
            const row = [seriesIndex, areaIndex, kindIndex, intern(type ?? ""), intern(placement), localIndex,
              intern(node.name), valueType.length === 1 ? intern(valueType[0]) : null, time ?? 0,
              shared(attributes, attributeKeys, attrs), shared(values, valueKeys, value)] as const;
            periods.push(row);
            if (inScope || ownValue || time != null && unclearTimes.has(time)) scoped++;
            if (time != null) validUntil = Math.max(validUntil ?? -Infinity, times[time].endMs);
          };
          for (const part of parts) {
            const ownPart = note(foreign(part, ["Base"])), inPart = inProperty || ownPart;
            const bases = children(part, "Base");
            if (bases.length === 0 && !ownPart) missing = true;
            if (bases.length > 1) invalid = true;
            for (const base of bases) {
              if (nonemptyText(base)) skipped++;
              const visit = (parent: XmlElement, localIndex: number | null) => {
                const placement = part.name + "/Base" + (localIndex == null ? "" : "/Local");
                for (const node of children(parent).filter((child) => localName(child) !== "Local"
                  && (localIndex == null || !["Code", "AreaName", "Name"].includes(localName(child))))) {
                  // 付加事項（Addition）は数えずに読み飛ばす（P3-WS-D-ADDITION の (a)）。判定は表に何も足す前に行う。
                  if (localName(node) === "Addition") continue;
                  if (!VALUES.has(localName(node)) && !readable(node, placement, localIndex)) skipped++;
                  else add(node, placement, localIndex, inPart);
                }
              };
              visit(base, null);
              children(base, "Local").forEach((local, localPosition) => {
                const areaName = children(local, "AreaName")[0] ?? null;
                if (areaName != null && attr(areaName, "code").length > 1) { invalid = true; return; }
                if (nonemptyText(local)) skipped++;
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
          for (const node of children(property, "CriteriaPeriod")) add(node, "Property", null, inProperty);
        }
      }
    }
  }
  // 知らないものだけの報を「なし」に読み替えない（Q-WS-LEVELS）。
  if ((seriesNodes.length > 0 || outer) && periods.length === 0 && !invalid) missing = true;
  if (missing) return reject("requiredStructureMissing");
  if (invalid) return reject("requiredStructureInvalid");
  const source: ReportRef = { inputId: material.inputId, origin: material.origin, operation: material.operation,
    family: "VPWP50", subject, reportDateTimeRaw: material.reportDateTimeRaw,
    serialRaw: material.serialRaw, infoTypeRaw: infoType.value! };
  const diagnostic = (level: "INFO" | "WARN", reason: "weatherTimeseriesElementSkipped" | "weatherTimeseriesScopeUnclear",
    count: number): DiagnosticDetails => ({ level, component: "weather-timeseries", reason, inputId: material.inputId, unit: "U-F", count });
  return { kind: "accepted", candidate: { source, reportDateTimeMs: common.envelope.reportDateTimeMs,
    cancelled: infoType.value === "取消", snapshot: periods.length === 0 ? EMPTY
      : { strings, attributes, values, series, areas: areaTable, locals, kinds, periods }, validUntil },
  diagnostics: [...skipped > 0 ? [diagnostic("INFO", "weatherTimeseriesElementSkipped", skipped)] : [],
    ...outer ? [diagnostic("WARN", "weatherTimeseriesScopeUnclear", scoped)] : []] };
}

export { EMPTY, inspect };
export type { Candidate, Result };
