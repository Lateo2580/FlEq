import type { DecodedMaterial, Operation, XmlElement, XmlNode } from "../../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, RejectionReason, ReportRef } from "../../../contracts/p2-shared-runtime.types";
import type {
  TyphoonFrame, TyphoonFrameKind, TyphoonName, TyphoonPoint, TyphoonPrefecture, TyphoonProbabilityArea, TyphoonWindArea, TyphoonWindAxis,
} from "../../../contracts/p3-typhoon-unit.types";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";
import { cut, infoRankOf, validInputId, validName, validReportDateTime, validSerial } from "../flood/flood";

// P3-UNIT-Y-001 の adapter: VPTW60〜65・VPTA50〜55 の本文を Q-ENUM の順で確かめ、候補を項目ごとに組み立てる。
// 値の形の検査（cut・validName・validSerial ほか）は U-R と同じ規則なので domains/flood の export を使い、XML の読み取りだけを写す（AC13）。

const HOUR = 3_600_000, DAY = 24 * HOUR;
// P3-C14-BOUNDS=A（UTF-16 の長さ）。
const BOUNDS = { title: 64, name: 24, nameKana: 24, remark: 32, category: 32, intensity: 24, size: 24, location: 32, direction: 8, condition: 16,
  areaName: 24 } as const;
// 一報の時刻 24・域の軸 2・確率の地域 384・府県予報区等 96（P3-C14-RET-03）と、sliceごとの件数 64（RET-01・RET-02）。
const LIMITS = { frames: 24, axes: 2, areas: 384, prefectures: 96, slots: 64, subjects: 64 } as const;
// P3-C14-EXPIRY=A: 見える期限は元報の ReportDateTime + 12 時間、記憶は + 7 日。
const VISIBLE = 12 * HOUR, RETAIN = 7 * DAY, SLOT = 3 * HOUR;

type AnalysisHeadType = "VPTW60" | "VPTW61" | "VPTW62" | "VPTW63" | "VPTW64" | "VPTW65";
type ProbabilityHeadType = "VPTA50" | "VPTA51" | "VPTA52" | "VPTA53" | "VPTA54" | "VPTA55";
const ANALYSIS_TYPES: readonly AnalysisHeadType[] = ["VPTW60", "VPTW61", "VPTW62", "VPTW63", "VPTW64", "VPTW65"];
const PROBABILITY_TYPES: readonly ProbabilityHeadType[] = ["VPTA50", "VPTA51", "VPTA52", "VPTA53", "VPTA54", "VPTA55"];
// P3-C14-LIFECYCLE=A: 実況の Remark がこの 4 つのどれかに完全一致するときだけ台風の終わり。
const TERMINAL_REMARKS: ReadonlySet<string> = new Set(["台風消滅（温帯低気圧化）", "台風消滅（熱帯低気圧化）", "台風消滅（域外へ出る）", "台風発生の可能性が小さくなった"]);

// EventID は trim して 1〜32 文字の印字可能 ASCII で「/」「"」「\」と空白を含まない（P3-C14-BOUNDS）。
const validEventId = (value: string): boolean => /^[\x21\x23-\x2e\x30-\x5b\x5d-\x7e]{1,32}$/.test(value);
const validCode6 = (value: string): boolean => /^\d{6}$/.test(value);

// ---- XML の読み取り（domains/briefing・flood・local-bulletins と同じ写し。共有化は統合担当が決める、AC13） ----

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

// ---- 候補 ----

type Base = Readonly<{
  operation: Operation; subject: string; eventId: string; source: ReportRef; reportDateTimeMs: number; infoRank: number; cancelled: boolean;
  title: string; name: TyphoonName; truncated: boolean;
}>;
type AnalysisCandidate = Base & Readonly<{
  slice: "analysis"; headType: AnalysisHeadType; baseTime: number; frames: readonly TyphoonFrame[];
  // 実況の Remark が台風の終わりの表のどれかに一致した（P3-C14-LIFECYCLE）。
  terminal: boolean;
}>;
type ProbabilityCandidate = Base & Readonly<{
  slice: "probability"; headType: ProbabilityHeadType; baseTime: number; slotCount: number; maxFiveDay: number;
  prefectures: readonly TyphoonPrefecture[]; areas: readonly TyphoonProbabilityArea[];
  // 全地域・全時間の確率が 0（P3-C14-ZERO）。areas は空。
  zero: boolean;
}>;
type TyphoonCandidate = AnalysisCandidate | ProbabilityCandidate;
type ParseResult = Readonly<{ kind: "accepted"; candidate: TyphoonCandidate }>
  | Readonly<{ kind: "rejected"; subject: string; reason: RejectionReason; diagnostic: DiagnosticDetails }>;

// 読み取りで見つけた不備の記録（Q-ENUM.priorityRule: 欠落が妥当性より先に報告される）。
type Found = { missing: boolean; invalid: boolean; truncated: boolean };

const bound = (found: Found, value: string, limit: number): string => {
  if (value.length > limit) found.truncated = true;
  return cut(value, limit);
};
// 0 個は missing、2 個以上は invalid。
function only(parent: XmlElement | null, tag: string, found: Found): XmlElement | null {
  const nodes = children(parent, tag);
  if (nodes.length === 0) found.missing = true;
  else if (nodes.length > 1) found.invalid = true;
  return nodes.length === 1 ? nodes[0] : null;
}
// 任意の scalar（0 個・空は null、2 個以上・子要素・制御文字は invalid）。
function optional(parent: XmlElement | null, tag: string, found: Found, limit: number): string | null {
  const nodes = children(parent, tag);
  if (nodes.length === 0) return null;
  const text = nodes.length > 1 ? null : scalar(nodes[0]);
  if (text == null || text !== "" && !validName(text)) { found.invalid = true; return null; }
  return text === "" ? null : bound(found, text, limit);
}
// 数字だけの整数（桁数は max の桁以内）。空は null、形か範囲の外は invalid。
function whole(text: string | null, max: number, found: Found): number | null {
  if (text == null || text === "") { if (text == null) found.invalid = true; return null; }
  if (!/^\d{1,4}$/.test(text) || Number(text) > max) { found.invalid = true; return null; }
  return Number(text);
}
// 「±DD.D±DDD.D/」の度（10 進）。度分の表記は読まない（R50）。
function point(text: string | null, found: Found): TyphoonPoint | null {
  if (text == null) { found.invalid = true; return null; }
  if (text === "") return null;
  const match = /^([+-]\d{2}\.\d)([+-]\d{3}\.\d)\/$/.exec(text);
  if (match == null || Math.abs(Number(match[1])) > 90 || Math.abs(Number(match[2])) > 180) { found.invalid = true; return null; }
  // +0 で -0 を 0 に揃える（保存物の比較と JSON で食い違わせない）。
  return { latitude: Number(match[1]) + 0, longitude: Number(match[2]) + 0 };
}
const DIGITS = /[０-９]/g;
const halfWidth = (value: string): string => value.replace(DIGITS, (digit) => String(digit.charCodeAt(0) - 0xff10)).replace(/[\s　]+/g, " ").trim();

function nameOf(part: XmlElement | null, found: Found): TyphoonName {
  if (part == null) return { name: null, nameKana: null, number: null, remark: null };
  const number = optional(part, "Number", found, 8);
  if (number != null && !/^\d{4}$/.test(number)) found.invalid = true;
  return { name: optional(part, "Name", found, BOUNDS.name), nameKana: optional(part, "NameKana", found, BOUNDS.nameKana),
    number: number != null && /^\d{4}$/.test(number) ? number : null, remark: optional(part, "Remark", found, BOUNDS.remark) };
}

function windArea(part: XmlElement, found: Found): TyphoonWindArea {
  const speed = children(part, "WindSpeed").find((node) => attribute(node, "unit") === "m/s");
  const axes: TyphoonWindAxis[] = [];
  const nodes = children(children(children(part, "Circle")[0] ?? null, "Axes")[0] ?? null, "Axis");
  // P3-WS-D-TYPHOON (5): 一部の軸だけを残すと、残らない向きで域を小さく描きうるので、軸を持たず閾値だけを残す。
  if (nodes.length > LIMITS.axes) found.truncated = true;
  else for (const axis of nodes) {
    const direction = optional(axis, "Direction", found, BOUNDS.direction);
    const radius = children(axis, "Radius").find((node) => attribute(node, "unit") === "km");
    axes.push({ direction, radiusKm: radius == null ? null : whole(scalar(radius), 9999, found) });
  }
  return { thresholdMs: speed == null ? null : whole(scalar(speed), 999, found), axes };
}

const KIND_OF_PREFIX: Readonly<Record<string, TyphoonFrameKind>> = { 推定: "estimate", 予報: "forecast", 延長予報: "extendedForecast" };
const FRAME_LABEL = /^(推定|予報|延長予報) ?(\d{1,3})時間後$/;
// 時刻の DateTime の type（全角数字と空白を揃えた形）。DateTime の無い時刻は MeteorologicalInfo の type。
const labelOf = (info: XmlElement): string => halfWidth(attribute(children(info, "DateTime")[0] ?? info, "type") ?? "");

// 1 時刻（MeteorologicalInfo 1 個）。名前は実況の時刻の呼称だけを返す。now は全部の時刻で数えた実況か（P3-WS-D-TYPHOON (3)）。
function parseFrame(info: XmlElement, now: boolean, report: Found): Readonly<{ frame: TyphoonFrame; name: TyphoonName | null; remark: string | null }> | null {
  const stamps = children(info, "DateTime");
  const label = stamps.length === 1 ? halfWidth(attribute(stamps[0], "type") ?? "") : "";
  const stamp = stamps.length === 1 ? scalar(stamps[0]) : null;
  const parts = FRAME_LABEL.exec(label);
  const kind: TyphoonFrameKind | null = label === "実況" ? "analysis" : parts == null ? null : KIND_OF_PREFIX[parts[1]];
  const hours = label === "実況" ? 0 : parts == null ? -1 : Number(parts[2]);
  const items = children(info, "Item");
  if (stamps.length !== 1 || items.length !== 1 || stamp == null || !validReportDateTime(stamp) || kind == null
    || kind === "estimate" && hours !== 1 || (kind === "forecast" || kind === "extendedForecast") && (hours < 3 || hours > 120)) {
    // P3-WS-D-TYPHOON (3): 時刻として読めない実況でない時刻は落とす。実況は解析の芯なので今どおり拒否。
    if (!now) report.truncated = true;
    else if (stamps.length === 0 || items.length === 0) report.missing = true;
    else report.invalid = true;
    return null;
  }

  // P3-WS-D-TYPHOON (4): 時刻の中の欄の不備はその時刻だけの記録で受け、欄を null にして truncated にする。
  const found: Found = { missing: false, invalid: false, truncated: false };
  const properties = new Map<string, XmlElement>(), twice = new Set<string>();
  for (const kindNode of children(items[0], "Kind"))
    for (const property of children(kindNode, "Property")) {
      const type = children(property, "Type")[0];
      const key = type == null ? null : scalar(type);
      if (key == null) continue;
      if (properties.has(key)) twice.add(key);
      properties.set(key, property);
    }
  // 同じ Type の Property は後のもので上書きせず、全部を無いものとする（推測を止める）。
  for (const key of twice) { properties.delete(key); found.invalid = true; }
  const naming = properties.get("呼称");
  const namePart = children(naming ?? null, "TyphoonNamePart")[0] ?? null;
  const name = naming == null ? null : nameOf(namePart, found);
  // 台風の終わりは切る前の Remark で決める（表の文は上限の内側）。
  const remarkNode = children(namePart, "Remark")[0];
  const remark = remarkNode == null ? null : scalar(remarkNode);
  const classPart = children(properties.get("階級") ?? null, "ClassPart")[0] ?? null;
  const centerPart = children(properties.get("中心") ?? null, "CenterPart")[0] ?? null;
  const windProperty = properties.get("風") ?? null;

  // 中心: 実況・推定は Coordinate（中心位置（度））、予報・延長予報は予報円の BasePoint と 70% 確率半径（km）。
  let center: TyphoonPoint | null = null, circleRadiusKm: number | null = null;
  const degrees = (nodes: readonly XmlElement[]): XmlElement[] => nodes.filter((node) => attribute(node, "type") === "中心位置（度）");
  if (kind === "analysis" || kind === "estimate") {
    const coordinates = degrees(children(centerPart, "Coordinate"));
    if (coordinates.length > 1) found.invalid = true;
    if (coordinates.length === 1) center = point(scalar(coordinates[0]), found);
  } else {
    const circle = children(centerPart, "ProbabilityCircle")[0] ?? null;
    const bases = degrees(children(circle, "BasePoint"));
    if (bases.length > 1) found.invalid = true;
    if (bases.length === 1) center = point(scalar(bases[0]), found);
    const axis = children(children(circle, "Axes")[0] ?? null, "Axis")[0] ?? null;
    const radius = children(axis, "Radius").find((node) => attribute(node, "unit") === "km");
    if (radius != null) circleRadiusKm = whole(scalar(radius), 9999, found);
  }
  const speed = children(centerPart, "Speed").find((node) => attribute(node, "unit") === "km/h");
  const direction = children(centerPart, "Direction")[0] ?? null;
  // 移動の condition は、空タグの Speed か Direction のものだけ（値のあるタグの condition は読まない）。
  const emptyCondition = (node: XmlElement | null | undefined): string | null => node != null && scalar(node) === "" ? attribute(node, "condition") : null;
  const condition = emptyCondition(speed) ?? emptyCondition(direction);
  const pressure = children(centerPart, "Pressure").find((node) => attribute(node, "unit") === "hPa");
  const winds = children(children(windProperty, "WindPart")[0] ?? null, "WindSpeed").filter((node) => attribute(node, "unit") === "m/s");
  const windOf = (type: string): number | null => {
    const node = winds.find((item) => attribute(item, "type") === type);
    return node == null ? null : whole(scalar(node), 999, found);
  };
  const areaOf = (type: string): TyphoonWindArea | null => {
    const nodes = children(windProperty, "WarningAreaPart").filter((node) => attribute(node, "type") === type);
    // 域を null にすると暴風域なしと見分けられないので、同じ type の域の 2 個以上は報ごと拒否する（Q-WS-REJECTIONS）。
    if (nodes.length > 1) report.invalid = true;
    return nodes.length === 0 ? null : windArea(nodes[0], found);
  };
  const frame: TyphoonFrame = {
    kind, hours, validTime: Date.parse(stamp),
    category: optional(classPart, "TyphoonClass", found, BOUNDS.category), intensity: optional(classPart, "IntensityClass", found, BOUNDS.intensity),
    size: optional(classPart, "AreaClass", found, BOUNDS.size), center, circleRadiusKm,
    location: optional(centerPart, "Location", found, BOUNDS.location), moveDirection: direction == null ? null : optional(centerPart, "Direction", found, BOUNDS.direction),
    moveSpeedKmh: speed == null ? null : whole(scalar(speed), 999, found), moveCondition: condition == null || condition === "" ? null : bound(found, condition, BOUNDS.condition),
    pressureHpa: pressure == null ? null : whole(scalar(pressure), 9999, found), maxWindMs: windOf("最大風速"), maxGustMs: windOf("最大瞬間風速"),
    storm: areaOf("暴風域"), gale: areaOf("強風域"), stormWarning: areaOf("暴風警戒域"),
  };
  if (found.invalid || found.truncated) report.truncated = true;
  return { frame, name, remark };
}

// 確率の報の地域 1 件（5 つの日積算と時系列の両方で同じ読み取り）。
type AreaRead = Readonly<{ code: string; name: string; prefectureCode: string; prefecture: string }>;
function readArea(item: XmlElement, found: Found): AreaRead | null {
  const area = only(item, "Area", found);
  if (area == null) return null;
  const code = optional(area, "Code", found, 8), prefectureCode = optional(area, "PrefectureCode", found, 8);
  const name = optional(area, "Name", found, BOUNDS.areaName), prefecture = optional(area, "Prefecture", found, BOUNDS.areaName);
  if (code == null || prefectureCode == null || name == null || prefecture == null) { found.missing = true; return null; }
  if (!validCode6(code) || !validCode6(prefectureCode)) { found.invalid = true; return null; }
  return { code, name, prefectureCode, prefecture };
}
// 確率の値 1 個（unit が % の 0〜100 の整数）。
function readPercent(node: XmlElement, found: Found): number {
  const value = whole(scalar(node), 100, found);
  if (attribute(node, "unit") !== "%" || value == null) { found.invalid = true; return 0; }
  return value;
}

// Q-ENUM.priorityRule の順に最初の一 RejectionReason を返す。拒否の subject は identity を読めた後だけ subject。
function parseTyphoon(material: DecodedMaterial): ParseResult {
  const common = validateSemanticEnvelope(material);
  if (common.kind === "rejected") return { kind: "rejected", subject: "", reason: common.reason, diagnostic: common.diagnostic };
  const reject = (reason: RejectionReason, subject = ""): ParseResult => ({ kind: "rejected", subject, reason,
    diagnostic: { level: "WARN", component: "typhoon", reason, inputId: material.inputId, unit: "U-Y" } });

  const headType = material.headType;
  const analysisType = ANALYSIS_TYPES.find((item) => item === headType) ?? null;
  const probabilityType = PROBABILITY_TYPES.find((item) => item === headType) ?? null;
  if (analysisType == null && probabilityType == null) return reject("identityInvalid");
  const head = children(material.xml, "Head")[0] ?? null;
  const operation = material.operation;

  // ---- identity（存在 → 妥当性）。subject は P3-C14-SUBJECT（ii を鍵に入れない） ----
  const ids = children(head, "EventID");
  const idText = ids.length === 1 ? scalar(ids[0]) : null;
  if (ids.length === 0 || idText === "") return reject("identityMissing");
  if (ids.length > 1 || idText == null || !validEventId(idText)) return reject("identityInvalid");
  const slice = analysisType != null ? "analysis" : "probability";
  const subject = `${operation}/${slice === "analysis" ? "typhoonAnalysis" : "typhoonProbability"}/${idText}`;
  const serialRaw = material.serialRaw.trim();
  if (serialRaw !== "" && !validSerial(serialRaw) || !validReportDateTime(material.reportDateTimeRaw) || material.infoTypeRaw.length > 8
    || !validInputId(material.inputId)) return reject("identityInvalid", subject);

  // ---- 必須構造（存在を全部確かめてから妥当性を見る） ----
  const found: Found = { missing: false, invalid: false, truncated: false };
  const titles = children(head, "Title");
  const titleText = titles.length === 1 ? scalar(titles[0]) : null;
  if (titles.length === 0 || titleText === "") found.missing = true;
  else if (titles.length > 1 || titleText == null || !validName(titleText)) found.invalid = true;
  const infoTypes = children(head, "InfoType");
  const infoTypeText = infoTypes.length === 0 ? null : scalar(infoTypes[0]);
  const infoRank = infoTypes.length === 1 && infoTypeText === material.infoTypeRaw.trim() ? infoRankOf(material.infoTypeRaw) : undefined;
  if (infoTypes.length === 0 || infoTypeText === "") found.missing = true;
  else if (infoRank == null) found.invalid = true;
  const cancelled = infoRank === 3;
  const reportMs = common.envelope.reportDateTimeMs;
  const source: ReportRef = { inputId: material.inputId, origin: material.origin, operation, family: material.headType, subject,
    reportDateTimeRaw: material.reportDateTimeRaw, serialRaw, infoTypeRaw: material.infoTypeRaw };
  const title = bound(found, titleText ?? "", BOUNDS.title);
  const fail = (): ParseResult => found.missing ? reject("requiredStructureMissing", subject) : reject("requiredStructureInvalid", subject);

  // 取消は TargetDateTime・Body を読まない（P3-C14-AC01）。
  let baseTime = 0;
  let name: TyphoonName = { name: null, nameKana: null, number: null, remark: null };
  const base = (): Base => ({ operation, subject, eventId: idText, source, reportDateTimeMs: reportMs, infoRank: infoRank ?? 0, cancelled, title,
    name, truncated: found.truncated });
  if (cancelled) {
    if (found.missing || found.invalid || infoRank == null) return fail();
    return analysisType != null ? { kind: "accepted", candidate: { ...base(), slice: "analysis", headType: analysisType, baseTime, frames: [], terminal: false } }
      : { kind: "accepted", candidate: { ...base(), slice: "probability", headType: probabilityType!, baseTime, slotCount: 0, maxFiveDay: 0,
        prefectures: [], areas: [], zero: false } };
  }
  const targets = children(head, "TargetDateTime");
  const targetText = targets.length === 1 ? scalar(targets[0]) : null;
  if (targets.length === 0 || targetText === "") found.missing = true;
  else if (targets.length > 1 || targetText == null || !validReportDateTime(targetText)) found.invalid = true;
  else baseTime = Date.parse(targetText);
  const bodies = children(material.xml, "Body");
  if (bodies.length === 0) found.missing = true;
  else if (bodies.length > 1) found.invalid = true;
  const infosList = children(bodies[0] ?? null, "MeteorologicalInfos");
  if (bodies.length === 1 && infosList.length === 0) found.missing = true;
  else if (infosList.length > 1 || infosList.length === 1 && attribute(infosList[0], "type") !== "台風情報") found.invalid = true;
  const infos = infosList.length === 1 ? infosList[0] : null;

  if (analysisType != null) {
    const nodes = children(infos, "MeteorologicalInfo");
    if (infos != null && nodes.length === 0) found.missing = true;
    const frames: TyphoonFrame[] = [];
    let remark: string | null = null;
    // 実況の時刻の数は DateTime の type だけで数える（ほかの不備で時刻が読めなくても、実況の欠落と取り違えない）。
    const labels = nodes.map(labelOf), nowCount = labels.filter((label) => label === "実況").length;
    // P3-WS-D-TYPHOON (1)(2): type が表の外の時刻を落とし（欠けか空は残す）、残りが 25 個以上なら実況と先の時刻で 24 個を文書の順に残す。
    // 落とした時刻と残さない時刻は type のほかを読まない。
    let room = LIMITS.frames - nowCount;
    const kept = nodes.filter((_, at) => labels[at] === "実況" || (labels[at] === "" || FRAME_LABEL.test(labels[at])) && room-- > 0);
    if (kept.length < nodes.length) found.truncated = true;
    for (const node of kept) {
      const read = parseFrame(node, labelOf(node) === "実況", found);
      if (read == null) continue;
      frames.push(read.frame);
      if (read.frame.kind === "analysis") {
        if (read.name != null) name = read.name;
        remark = read.remark;
      }
    }
    if (infos != null && nodes.length > 0 && nowCount === 0) found.missing = true;
    if (nowCount > 1) found.invalid = true;
    if (found.missing || found.invalid || infoRank == null) return fail();
    return { kind: "accepted", candidate: { ...base(), slice: "analysis", headType: analysisType, baseTime, frames, terminal: remark != null && TERMINAL_REMARKS.has(remark) } };
  }

  // ---- 確率（P3-C14-PROB-VALIDATION） ----
  const sections = new Map<number, XmlElement>();
  let named: XmlElement | null = null;
  // 節か時間帯を落としたか。落とした所にだけ確率があるかもしれないので、全ゼロ（zero）とは言えない。
  let dropped = false;
  for (const node of children(infos, "MeteorologicalInfo")) {
    const type = halfWidth(attribute(node, "type") ?? "");
    const day = /^台風の暴風域に入る確率（(\d)日積算）$/.exec(type);
    if (type === "台風呼称") named = node;
    // P3-WS-D-TYPHOON (6): 知らない節と 1〜5 日の外の節は落とす（その地域は集合の照合に入らない）。同じ日の節の 2 個以上は今どおり拒否。
    else if (day == null || Number(day[1]) < 1 || Number(day[1]) > 5) found.truncated = dropped = true;
    else if (sections.has(Number(day[1]))) found.invalid = true;
    else sections.set(Number(day[1]), node);
  }
  if (infos != null && [1, 2, 3, 4, 5].some((day) => !sections.has(day))) found.missing = true;
  if (named != null) {
    const part = children(children(children(children(named, "Item")[0] ?? null, "Kind")[0] ?? null, "Property")[0] ?? null, "TyphoonNamePart")[0] ?? null;
    // 台風呼称の節の欄の不備も (4) と同じく欄を null にして truncated にする。
    const own: Found = { missing: false, invalid: false, truncated: false };
    name = nameOf(part, own);
    if (own.invalid || own.truncated) found.truncated = true;
  }
  const series = infos == null ? null : only(infos, "TimeSeriesInfo", found);

  // 日積算の地域: 節ごとに code → 値。5 つと時系列で地域の集合が同じ。
  const daily: Map<string, number>[] = [];
  const areaTable = new Map<string, AreaRead>();
  const prefectureNames = new Map<string, string>();
  let itemsSeen = 0;
  const remember = (area: AreaRead): void => {
    const known = prefectureNames.get(area.prefectureCode);
    if (known != null && known !== area.prefecture) found.invalid = true;
    prefectureNames.set(area.prefectureCode, area.prefecture);
    if (!areaTable.has(area.code)) areaTable.set(area.code, area);
  };
  for (let day = 1; day <= 5; day++) {
    const values = new Map<string, number>();
    daily.push(values);
    for (const item of children(sections.get(day) ?? null, "Item")) {
      itemsSeen++;
      const area = readArea(item, found);
      const property = children(children(item, "Kind")[0] ?? null, "Property")[0] ?? null;
      const probability = only(children(property, "FiftyKtWindProbabilityPart")[0] ?? null, "FiftyKtWindProbability", found);
      if (area == null || probability == null) continue;
      if (values.has(area.code)) found.invalid = true;
      values.set(area.code, readPercent(probability, found));
      remember(area);
    }
  }

  // 時系列: TimeDefine は timeId が 1 から連続、最初が TargetDateTime、PT3H で隙間がない。
  // P3-WS-D-TYPHOON (7): 外れた最初の時間帯か 65 個目で止め、そこから後の時間帯と値を読まない（時刻の意味が分からない値は推測しない）。
  const defines = children(children(series, "TimeDefines")[0] ?? null, "TimeDefine");
  if (series != null && defines.length === 0) found.missing = true;
  let slotCount = 0;
  for (const define of defines.slice(0, LIMITS.slots)) {
    const at = children(define, "DateTime")[0], span = children(define, "Duration")[0];
    const text = at == null ? null : scalar(at);
    if (span == null || attribute(define, "timeId") !== String(slotCount + 1) || scalar(span) !== "PT3H" || text == null || !validReportDateTime(text)
      || Date.parse(text) !== baseTime + slotCount * SLOT) break;
    slotCount++;
  }
  if (slotCount < defines.length) found.truncated = dropped = true;
  // 最初の時間帯で止まる報は今どおり拒否する（slotCount の 0 は保存の形に無い）。
  if (defines.length > 0 && slotCount === 0) {
    if (children(defines[0], "DateTime").length === 0 || children(defines[0], "Duration").length === 0) found.missing = true;
    else found.invalid = true;
  }
  const peaks = new Map<string, Readonly<{ peak: number; slot: number | null }>>();
  for (const item of children(series, "Item")) {
    itemsSeen++;
    const area = readArea(item, found);
    const property = children(children(item, "Kind")[0] ?? null, "Property")[0] ?? null;
    const nodes = children(children(property, "FiftyKtWindProbabilityPart")[0] ?? null, "FiftyKtWindProbability");
    if (area == null) continue;
    if (peaks.has(area.code)) found.invalid = true;
    if (nodes.length !== defines.length) found.invalid = true;
    let peak = 0, slot: number | null = null;
    nodes.slice(0, slotCount).forEach((node, index) => {
      if (attribute(node, "refID") !== String(index + 1)) found.invalid = true;
      const value = readPercent(node, found);
      if (value > peak) { peak = value; slot = index; }
    });
    peaks.set(area.code, { peak, slot });
    remember(area);
  }
  const total = areaTable.size;
  if (itemsSeen === 0) found.missing = true;
  // 地域の集合の一致: areaTable は全部の節の和集合なので、各節の件数が和集合と同じなら全部同じ集合。
  else if (peaks.size !== total || daily.some((values) => values.size !== total)) found.invalid = true;
  if (found.missing || found.invalid || infoRank == null) return fail();

  // 1 以上の地域だけを持つ。5 日積算の高い順（同じなら code の小さい順）に 384 まで採り、府県予報区等が 97 個目になる地域は飛ばす（truncated）。
  type Kept = TyphoonProbabilityArea;
  const kept: Kept[] = [];
  for (const [code, area] of areaTable) {
    const dailyValues = daily.map((values) => values.get(code)!);
    const { peak, slot } = peaks.get(code)!;
    if (dailyValues.some((value) => value > 0) || peak > 0)
      kept.push({ code, name: area.name, prefectureCode: area.prefectureCode, daily: dailyValues, peak, peakSlot: slot });
  }
  // 読まなかった所があるのに「1%以上の地域なし」と告げないよう、その全ゼロは今どおり拒否する（P3-WS-D-TYPHOON (6)(7)）。
  if (kept.length === 0 && dropped) { found.invalid = true; return fail(); }
  if (kept.length === 0)
    return { kind: "accepted", candidate: { ...base(), slice: "probability", headType: probabilityType!, baseTime, slotCount, maxFiveDay: 0, prefectures: [], areas: [], zero: true } };
  const order = [...kept].sort((left, right) => right.daily[4] - left.daily[4] || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
  const taken: Kept[] = [], covered = new Set<string>();
  let truncated = found.truncated;
  for (const area of order) {
    if (taken.length >= LIMITS.areas) { truncated = true; break; }
    if (!covered.has(area.prefectureCode) && covered.size >= LIMITS.prefectures) { truncated = true; continue; }
    covered.add(area.prefectureCode);
    taken.push(area);
  }
  const areas = taken.sort((left, right) => left.code < right.code ? -1 : left.code > right.code ? 1 : 0);
  // 5 日積算が全部 0 の地域だけでは maxFiveDay（1〜100）を決められない（積算が単調でない報）ので拒否する。
  const maxFiveDay = areas.reduce((most, area) => Math.max(most, area.daily[4]), 0);
  if (maxFiveDay === 0) { found.invalid = true; return fail(); }
  const prefectures = [...covered].sort().map((code) => ({ code, name: prefectureNames.get(code)! }));
  return { kind: "accepted", candidate: { ...base(), truncated, slice: "probability", headType: probabilityType!, baseTime, slotCount, maxFiveDay, prefectures, areas, zero: false } };
}

export {
  BOUNDS, DAY, HOUR, LIMITS, RETAIN, SLOT, VISIBLE, parseTyphoon, validCode6, validEventId,
};
export type { AnalysisCandidate, AnalysisHeadType, ProbabilityCandidate, ProbabilityHeadType, TyphoonCandidate };
export { ANALYSIS_TYPES, PROBABILITY_TYPES };
