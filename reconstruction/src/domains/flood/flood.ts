import type { DecodedMaterial, Operation, XmlElement, XmlNode } from "../../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, RejectionReason, ReportRef } from "../../../contracts/p2-shared-runtime.types";
import type { FloodCriteria, FloodKindGroup, FloodRiver, FloodStation } from "../../../contracts/p3-flood-unit.types";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";

// P3-UNIT-R-001 の adapter: VXKO50〜89・VXSU50〜59 の本文を Q-ENUM の順で確かめ、候補を項目ごとに組み立てる。

// Q-ENUM.revisionOrder の InfoType の優先（取消 > 訂正 > 発表）。
const INFO_RANK: ReadonlyMap<string, number> = new Map([["発表", 1], ["訂正", 2], ["取消", 3]]);
// Q-ENUM.codeTable。表に無い 2 桁の code は null（解除として数えない、fail-bright）。
const LEVELS: ReadonlyMap<string, 0 | 2 | 3 | 4 | 5> = new Map([["10", 0], ["20", 2], ["21", 2], ["22", 2], ["30", 3], ["31", 3],
  ["40", 4], ["41", 4], ["51", 5], ["53", 5]]);
const SERIES = "水位・流量情報";
// 基準水位の段（P3-C11-STATIONS=A、旧称も引く）。計画高を先に見る（「レベル４計画高水位等」は「レベル４」も含む）。
const CRITERIA: readonly (readonly [keyof FloodCriteria, RegExp])[] = [["level4Plan", /計画高/], ["level4", /レベル４|氾濫危険/],
  ["level3", /レベル３|避難判断/], ["level2", /レベル２|氾濫注意/], ["level1", /レベル１|水防団待機/]];

// I-U-R.bounds（UTF-16 の長さ）と P3-C11-BOUNDS=B の件数、Q-ENUM.identity の ReportRef の長さ。
// 観測所の名前は (code, name) の identity なので切らない。上限を超えた名前の観測所はその観測所だけを捨てる（外部監査 F13、統合担当の決定）。
const BOUNDS = { title: 128, areaName: 64, name: 32, stationName: 48, headline: 256 } as const;
const LIMITS = { inputId: 64, reportDateTime: 40, infoType: 8, eventId: 40, riverCode: 16, stationCode: 20, groups: 16, rivers: 32,
  stations: 20, points: 40, sections: 4 } as const;

const validHeadType = (value: string): boolean => /^(?:VXKO[5-8]\d|VXSU5\d)$/.test(value);
const validEventId = (value: string): boolean => value.length <= LIMITS.eventId && /^[\x21-\x7e]+$/.test(value);
const validSerial = (value: string): boolean => /^\d{1,10}$/.test(value);
// inputId は JSON でエスケープされない印字可能な ASCII（「"」と「\」を除く）に限る（品質レビュー P2、I-U-R.capacityReserve の 1 文字 1 byte）。
const validInputId = (value: string): boolean => /^[\x21\x23-\x5b\x5d-\x7e]{1,64}$/.test(value);
// ReportDateTime の raw は A1 の受理と同じ時刻の形（ASCII だけ。保存物の decode も同じ形で確かめる）。
const validReportDateTime = (value: string): boolean => value.length <= LIMITS.reportDateTime
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
// InfoType の raw は trim せずに持ち、比較は trim した値で引く（I-U-R.bounds）。
const infoRankOf = (raw: string): number | undefined => raw.length <= LIMITS.infoType ? INFO_RANK.get(raw.trim()) : undefined;
const validKindCode = (value: string): boolean => /^\d{2}$/.test(value);
const validRiverCode = (value: string): boolean => value.length <= LIMITS.riverCode && /^\d+$/.test(value);
const validStationCode = (value: string): boolean => value.length <= LIMITS.stationCode && /^\d+$/.test(value);
const validTime = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(value);
const validValue = (value: string): boolean => /^-?\d{1,6}(?:\.\d{1,3})?$/.test(value);
const loneSurrogate = (value: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);
// 名前（areaName・河川名・観測所名・Kind の名前）は制御文字と孤立したサロゲートを拒む（I-U-R.bounds）。
const validName = (value: string): boolean => value !== "" && !/[\u0000-\u001f\u007f]/.test(value) && !loneSurrogate(value);
const levelOf = (code: string): FloodKindGroup["level"] => LEVELS.get(code) ?? null;
// 点のレベルは 0〜5 を数とし、ほかの 1 桁（9 = 未計算）は null（Q-ENUM.codeTable）。
const POINT_LEVELS = [0, 1, 2, 3, 4, 5] as const;
const pointLevel = (raw: string): FloodStation["levels"][number] => POINT_LEVELS.find((level) => String(level) === raw) ?? null;

// ---- XML の読み取り（domains/landslide と同じ写し。共有化は統合担当が決める、AC12） ----

const localName = (node: XmlElement): string => node.name.split(":").at(-1)!;
function children(parent: XmlElement | null, name?: string): XmlElement[] {
  return parent == null ? [] : parent.children.filter((node): node is XmlElement =>
    node.kind === "element" && (name == null || localName(node) === name));
}
function scalar(node: XmlElement): string | null {
  return children(node).length === 0 ? node.children.filter((part): part is Extract<XmlNode, { kind: "text" }> =>
    part.kind === "text").map((part) => part.value).join("").trim() : null;
}
const attribute = (node: XmlElement, name: string): string | null => node.attributes.find((item) => item.name === name)?.value.trim() ?? null;
// 切り詰めでサロゲートの対を割らない（割ると孤立したサロゲートを decode が拒み、U-R 全体の復元が落ちる）。
function cut(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = value.slice(0, limit);
  return /[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head;
}

// ---- 候補 ----

type FloodCandidate = Readonly<{
  operation: Operation; headType: string; eventId: string; subject: string; source: ReportRef; reportDateTimeMs: number;
  infoRank: number; cancelled: boolean; title: string; areaName: string; headline: string | null; kinds: readonly FloodKindGroup[];
  times: readonly string[]; stations: readonly FloodStation[]; truncated: boolean;
}>;
type ParseResult = Readonly<{ kind: "accepted"; candidate: FloodCandidate }>
  | Readonly<{ kind: "rejected"; subject: string; reason: RejectionReason; diagnostic: DiagnosticDetails }>;

// Q-ENUM.priorityRule の順に最初の一 RejectionReason を返す。拒否の subject は EventID を読めた後だけ subject。
function parseFlood(material: DecodedMaterial): ParseResult {
  const common = validateSemanticEnvelope(material);
  if (common.kind === "rejected") return { kind: "rejected", subject: "", reason: common.reason, diagnostic: common.diagnostic };
  const reject = (reason: RejectionReason, subject = ""): ParseResult => ({ kind: "rejected", subject, reason,
    diagnostic: { level: "WARN", component: "flood", reason, inputId: material.inputId, unit: "U-R" } });

  // Q-ENUM.identity: Head/EventID（P3-C11-SUBJECTS=A）と Serial（必須）。
  const head = children(material.xml, "Head")[0] ?? null;
  const eventIds = children(head, "EventID");
  const eventId = eventIds.length === 0 ? null : scalar(eventIds[0]);
  if (eventIds.length === 0 || eventIds.length === 1 && eventId === "") return reject("identityMissing");
  if (eventIds.length !== 1 || eventId == null || !validEventId(eventId) || !validHeadType(material.headType)) return reject("identityInvalid");
  const { headType } = material;
  const subject = `${material.operation}/${headType}/${eventId}`;
  const serialRaw = material.serialRaw.trim();
  if (serialRaw === "") return reject("identityMissing", subject);
  // 保存する ReportRef の byte の上限（Q-ENUM.identity、C8 の Q-C8-IMPL-AMEND(a)）。
  if (!validSerial(serialRaw) || material.reportDateTimeRaw.length > LIMITS.reportDateTime
    || material.infoTypeRaw.length > LIMITS.infoType || !validInputId(material.inputId)) return reject("identityInvalid", subject);

  // 存在を全部確かめてから妥当性を見る（Q-ENUM.priorityRule）。
  let missing = false, invalid = false, truncated = false;
  const bound = (value: string, limit: number): string => {
    if (value.length > limit) truncated = true;
    return cut(value, limit);
  };
  // 1 個の非空 scalar の名前を読む。無いか空は missing、重複・子要素・制御文字は invalid。
  const name = (parent: XmlElement | null, tag: string): string | null => {
    const nodes = children(parent, tag);
    const text = nodes.length === 0 ? null : scalar(nodes[0]);
    if (nodes.length === 0 || text === "") { missing = true; return null; }
    if (nodes.length > 1 || text == null || !validName(text)) { invalid = true; return null; }
    return text;
  };
  const titles = children(head, "Title");
  const titleText = titles.length === 0 ? null : scalar(titles[0]);
  if (titles.length === 0 || titleText === "") missing = true;
  if (titles.length > 1 || titles.length === 1 && titleText == null) invalid = true;
  // Head/InfoType も 1 個の scalar を確かめる（P1 は最初の要素の直下 text だけを読む、C10 の Q-C10-IMPL-AMEND(15)）。
  const infoTypes = children(head, "InfoType");
  const infoTypeText = infoTypes.length === 0 ? null : scalar(infoTypes[0]);
  const infoTypeRaw = material.infoTypeRaw;
  const infoRank = infoTypes.length === 1 && infoTypeText === infoTypeRaw.trim() ? infoRankOf(infoTypeRaw) : undefined;
  if (infoTypes.length === 0 || infoTypeText === "") missing = true;
  else if (infoRank == null) invalid = true;
  const cancelled = infoRank === 3;

  let areaName = "", headline: string | null = null;
  let kinds: FloodKindGroup[] = [], times: string[] = [], stations: FloodStation[] = [];
  // 取消は Body と Headline を読まない（Q-ENUM.familyTable.legalMissing）。
  if (!cancelled) {
    const headlineNode = children(head, "Headline")[0] ?? null;
    const text = children(headlineNode, "Text")[0];
    const textValue = text == null ? null : scalar(text);
    headline = textValue == null || textValue === "" ? null : cut(textValue, BOUNDS.headline);
    const informations = children(headlineNode, "Information");
    const typed = (suffix: string) => informations.filter((node) => attribute(node, "type")?.endsWith(suffix) === true);

    // P3-C11-FACTS=A: 「（予報区域）」か「（発表区間）」の最初の Information の最初の Area/Name。
    const zone = informations.find((node) => /（(?:予報区域|発表区間)）$/.test(attribute(node, "type") ?? ""));
    const zoneArea = children(children(children(zone ?? null, "Item")[0] ?? null, "Areas")[0] ?? null, "Area")[0] ?? null;
    const zoneName = children(zoneArea, "Name")[0];
    if (zoneName != null) {
      const value = scalar(zoneName);
      if (value == null || !validName(value)) invalid = true;
      else areaName = bound(value, BOUNDS.areaName);
    }

    // 「（河川）」の Information の Item ごとの group。
    const riverInfos = typed("（河川）");
    if (riverInfos.length > 1) invalid = true;
    const items = children(riverInfos[0] ?? null, "Item");
    if (riverInfos.length === 1 && items.length === 0) missing = true;
    const kindCodes = new Set<string>(), riverCodes = new Set<string>();
    const groups: { group: FloodKindGroup; order: number }[] = [];
    for (const item of items) {
      // Kind・Areas の個数の外も河川は読み続ける（存在の欠落を妥当性より先に返す、Q-ENUM.priorityRule）。
      const kindNodes = children(item, "Kind"), areasNodes = children(item, "Areas");
      if (kindNodes.length !== 1 || areasNodes.length !== 1) invalid = true;
      const codes = children(kindNodes[0] ?? null, "Code");
      const code = codes.length === 0 ? null : scalar(codes[0]);
      const kindName = kindNodes.length === 1 ? name(kindNodes[0], "Name") : null;
      if (kindNodes.length === 1 && (codes.length === 0 || code === "")) missing = true;
      // 子要素を持つ Code（scalar が null）も報ごと拒む。その group だけを落とすと残りの解除の group で現況を消す（品質レビュー P2）。
      else if (codes.length > 1 || codes.length === 1 && (code == null || !validKindCode(code) || kindCodes.has(code))) invalid = true;
      if (code != null) kindCodes.add(code);
      const rivers: FloodRiver[] = [];
      const areas = children(areasNodes[0] ?? null, "Area");
      if (areasNodes.length === 1 && areas.length === 0) missing = true;
      for (const area of areas) {
        const riverCodeNodes = children(area, "Code");
        const riverCode = riverCodeNodes.length === 0 ? null : scalar(riverCodeNodes[0]);
        const riverName = name(area, "Name");
        if (riverCodeNodes.length === 0 || riverCode === "") { missing = true; continue; }
        if (riverCodeNodes.length > 1 || riverCode == null || !validRiverCode(riverCode) || riverCodes.has(riverCode)) { invalid = true; continue; }
        riverCodes.add(riverCode);
        if (riverName != null) rivers.push({ code: riverCode, name: bound(riverName, BOUNDS.name) });
      }
      if (kindName != null && code != null) groups.push({ group: { code, name: bound(kindName, BOUNDS.name), level: levelOf(code), rivers }, order: groups.length });
    }
    // P3-C11-BOUNDS=B: group は段階の低い方（0、2、…、null は 3 の順位）から、同じ段は電文順の後ろから捨てる。河川は電文順の後ろから。
    const groupRank = (level: FloodKindGroup["level"]) => level ?? 3;
    if (groups.length > LIMITS.groups) truncated = true;
    const keptGroups = groups.length <= LIMITS.groups ? groups : [...groups]
      .sort((left, right) => groupRank(right.group.level) - groupRank(left.group.level) || left.order - right.order)
      .slice(0, LIMITS.groups).sort((left, right) => left.order - right.order);
    let riverBudget: number = LIMITS.rivers;
    kinds = keptGroups.map(({ group }) => {
      const rivers = group.rivers.slice(0, Math.max(riverBudget, 0));
      if (rivers.length < group.rivers.length) truncated = true;
      riverBudget -= rivers.length;
      return rivers.length === group.rivers.length ? group : { ...group, rivers };
    });

    // P3-C11-STATIONS=A: 水位・流量情報の series（times は電文順で i=0 が現況）。
    const body = children(material.xml, "Body")[0] ?? null;
    const seriesInfos = children(body, "MeteorologicalInfos").filter((node) => attribute(node, "type") === SERIES);
    if (seriesInfos.length > 1) invalid = true;
    const timeSeries = children(seriesInfos[0] ?? null, "TimeSeriesInfo");
    if (seriesInfos.length === 1 && timeSeries.length === 0) missing = true;
    if (timeSeries.length > 1) invalid = true;
    const timeIndex = new Map<string, number>();
    const defines = children(children(timeSeries[0] ?? null, "TimeDefines")[0] ?? null, "TimeDefine");
    if (timeSeries.length === 1 && defines.length === 0) missing = true;
    for (const define of defines) {
      const timeId = attribute(define, "timeId");
      const dateTimes = children(define, "DateTime");
      const dateTime = dateTimes.length === 0 ? null : scalar(dateTimes[0]);
      if (timeId == null || timeId === "" || dateTimes.length === 0 || dateTime === "") { missing = true; continue; }
      if (timeIndex.has(timeId) || dateTimes.length > 1 || dateTime == null || !validTime(dateTime)) { invalid = true; continue; }
      timeIndex.set(timeId, times.length);
      times.push(dateTime);
    }
    if (times.length > LIMITS.points) { truncated = true; times = times.slice(0, LIMITS.points); }

    // seriesの Item は（Station/Code, Station/Name）で引く。Map で 1 回結び付ける（I-U-R.computation）。
    type Series = { discharge: boolean; values: (number | null)[]; levels: FloodStation["levels"][number][] };
    const series = new Map<string, Series>();
    for (const item of children(timeSeries[0] ?? null, "Item")) {
      const stationNodes = children(item, "Station");
      if (stationNodes.length !== 1) { if (stationNodes.length === 0) missing = true; else invalid = true; continue; }
      const codeNodes = children(stationNodes[0], "Code");
      const code = codeNodes.length === 0 ? null : scalar(codeNodes[0]);
      const stationName = name(stationNodes[0], "Name");
      if (codeNodes.length === 0 || code === "") { missing = true; continue; }
      if (codeNodes.length > 1 || code == null) { invalid = true; continue; }
      const key = `${code}\n${stationName}`;
      if (series.has(key)) invalid = true;
      const parts = children(item, "Kind").flatMap((kind) => children(kind, "Property"))
        .flatMap((property) => [...children(property, "WaterLevelPart"), ...children(property, "DischargePart")]);
      if (parts.length !== 1) { if (parts.length === 0) missing = true; else invalid = true; continue; }
      const read: Series = { discharge: localName(parts[0]) === "DischargePart", values: times.map(() => null), levels: times.map(() => null) };
      const seen = new Set<string>();
      for (const element of children(parts[0])) {
        const type = attribute(element, "type"), refId = attribute(element, "refID");
        const value = scalar(element);
        const at = refId == null ? undefined : timeIndex.get(refId);
        if (type == null || refId == null || value == null || at == null || seen.has(`${refId}\n${type}`)) { invalid = true; continue; }
        seen.add(`${refId}\n${type}`);
        if (type === "レベル") {
          if (value !== "" && !/^\d$/.test(value)) invalid = true;
          else if (at < read.levels.length) read.levels[at] = pointLevel(value);
        } else if (type === "水位" || type === "流量") {
          if (value !== "" && !validValue(value)) invalid = true;
          else if (at < read.values.length) read.values[at] = value === "" ? null : Number(value);
        } else invalid = true;
      }
      if (stationName != null) series.set(key, read);
    }

    // 観測所は HydrometricStationPart から（code, name）で一意に作る。
    const parts = children(body, "AdditionalInfo").flatMap((node) => children(node, "FloodForecastAddition"))
      .flatMap((node) => children(node, "HydrometricStationPart"));
    const riverByName = new Map<string, string>();
    for (const group of kinds) for (const river of group.rivers) if (!riverByName.has(river.name)) riverByName.set(river.name, river.code);
    const seenStations = new Set<string>();
    const built: { station: FloodStation; order: number }[] = [];
    for (const part of parts) {
      const areas = children(part, "Area");
      if (areas.length !== 1) { if (areas.length === 0) missing = true; else invalid = true; continue; }
      const codeNodes = children(areas[0], "Code");
      const code = codeNodes.length === 0 ? null : scalar(codeNodes[0]);
      const stationName = name(areas[0], "Name");
      if (codeNodes.length === 0 || code === "") { missing = true; continue; }
      if (codeNodes.length > 1 || code == null || !validStationCode(code) || seenStations.has(`${code}\n${stationName}`)) { invalid = true; continue; }
      seenStations.add(`${code}\n${stationName}`);
      const criteriaNodes = children(part, "Criteria");
      if (criteriaNodes.length > 1) invalid = true;
      const criteria: { -readonly [K in keyof FloodCriteria]: number | null } = { level1: null, level2: null, level3: null, level4: null, level4Plan: null };
      let dischargeCriteria = false;
      for (const element of children(criteriaNodes[0] ?? null)) {
        if (localName(element) === "Discharge") dischargeCriteria = true;
        const value = scalar(element);
        if (value == null || value !== "" && !validValue(value)) { invalid = true; continue; }
        const slot = CRITERIA.find(([, pattern]) => pattern.test(attribute(element, "type") ?? ""))?.[0];
        if (slot != null && criteria[slot] == null && value !== "" && attribute(element, "condition") !== "無効") criteria[slot] = Number(value);
      }
      // riverCodes は ChargeSection（電文順に 4 個まで）の最初の行と同じ名前の、切り捨ての後の河川の code（重複なし）。
      const sections = children(part, "ChargeSection");
      if (sections.length > LIMITS.sections) truncated = true;
      const linked = new Set<string>();
      for (const section of sections.slice(0, LIMITS.sections)) {
        const text = scalar(section);
        const river = text == null ? undefined : riverByName.get(cut(text.split("\n")[0].trim(), BOUNDS.name));
        if (river != null) linked.add(river);
      }
      if (stationName == null) continue;
      if (stationName.length > BOUNDS.stationName) { truncated = true; continue; }
      const found = series.get(`${code}\n${stationName}`);
      built.push({ order: built.length, station: { code, name: stationName, riverCodes: [...linked],
        measurement: found?.discharge === true || found == null && dischargeCriteria ? "discharge" : "waterLevel", criteria,
        values: found?.values ?? times.map(() => null), levels: found?.levels ?? times.map(() => null) } });
    }
    // P3-C11-BOUNDS=B: 観測所は現況の観測レベルの低い方（null が最も低い）から、同じ段は電文順の後ろから捨てる。
    const observed = (station: FloodStation) => station.levels[0] ?? -1;
    if (built.length > LIMITS.stations) truncated = true;
    stations = (built.length <= LIMITS.stations ? built : [...built]
      .sort((left, right) => observed(right.station) - observed(left.station) || left.order - right.order)
      .slice(0, LIMITS.stations).sort((left, right) => left.order - right.order)).map((item) => item.station);
  }
  if (missing) return reject("requiredStructureMissing", subject);
  if (invalid || infoRank == null || titleText == null) return reject("requiredStructureInvalid", subject);
  return { kind: "accepted", candidate: { operation: material.operation, headType, eventId, subject,
    source: { inputId: material.inputId, origin: material.origin, operation: material.operation, family: headType, subject,
      reportDateTimeRaw: material.reportDateTimeRaw, serialRaw, infoTypeRaw },
    reportDateTimeMs: common.envelope.reportDateTimeMs, infoRank, cancelled, title: bound(titleText, BOUNDS.title), areaName, headline,
    kinds, times, stations, truncated } };
}

export { BOUNDS, INFO_RANK, LIMITS, cut, infoRankOf, levelOf, loneSurrogate, parseFlood, validEventId, validHeadType, validKindCode, validName,
  validInputId, validReportDateTime, validRiverCode, validSerial, validStationCode, validTime, validValue };
export type { FloodCandidate };
