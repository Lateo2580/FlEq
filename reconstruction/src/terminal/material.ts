import type { DecodedMaterial, ParserMailboxResult, XmlElement } from "../../contracts/p1-parser-boundary.types";
import type { RuntimePublishedOutcome, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type {
  TerminalBandLevel, TerminalHead, TerminalHypocenter, TerminalIntensityArea, TerminalReport, TerminalTsunamiArea, TerminalTsunamiStation, TerminalValue,
} from "../../contracts/p3-terminal-output.types";
import { attribute, children, first, localName, scalar, text } from "../decode-material/xml-read";
import { levelOf as floodLevel } from "../domains/flood/flood";
import { levelOf as landslideLevel } from "../domains/landslide/landslide";
import { classifyHeadType } from "../runtime/unit-coverage";

// P3-TO-AC01 (3)・RES-02: 端末の材料を owner の worker で 1 報に 1 回だけ作る。XML の生の文字を写すだけで、整形は端末の側。
// 件数の上限は細分区域 188・津波予報区 66・観測点 1,024 の上に置く（RES-02）。無いと 1 報の材料が publisher の列を埋める。
const AREA_LIMIT = 256, STATION_LIMIT = 1024, TEXT_LIMIT = 4096;

type Budget = { left: number; omitted: number };

// RES-02: 文字列は 4,096 字まで（越えた分は … にし、omitted には数えない）。
function clip(value: string | null): string | null {
  return value == null || value.length <= TEXT_LIMIT ? value : `${value.slice(0, TEXT_LIMIT - 1)}…`;
}
const read = (parent: XmlElement | null, name: string): string | null => clip(text(parent, name));
const take = (budget: Budget): boolean => {
  if (budget.left > 0) { budget.left -= 1; return true; }
  budget.omitted += 1;
  return false;
};

function value(node: XmlElement | null): TerminalValue | null {
  return node == null ? null : { raw: clip(scalar(node)) ?? "",
    description: clip(attribute(node, "description")), condition: clip(attribute(node, "condition")) };
}

function head(material: DecodedMaterial): TerminalHead {
  const control = first(material.xml, "Control"), heading = first(material.xml, "Head");
  return {
    headType: material.headType, controlTitle: read(control, "Title"), title: read(heading, "Title"),
    headline: read(first(heading, "Headline"), "Text"), reportDateTimeRaw: read(heading, "ReportDateTime"), infoType: read(heading, "InfoType"),
    status: read(control, "Status"), eventId: read(heading, "EventID"), serial: read(heading, "Serial"),
    publishingOffice: read(control, "PublishingOffice"),
  };
}

// 座標の選び方は U-E の facts.report と同じ（type が「震源位置（度分）」でないものを先に採る）。
function hypocenter(earthquake: XmlElement | null): TerminalHypocenter | null {
  if (earthquake == null) return null;
  const area = first(first(earthquake, "Hypocenter"), "Area");
  const coordinates = children(area, "Coordinate");
  return { name: read(area, "Name"),
    coordinate: value(coordinates.find((node) => attribute(node, "type") !== "震源位置（度分）") ?? coordinates[0] ?? null),
    magnitude: value(first(earthquake, "Magnitude")) };
}

function seismic(material: DecodedMaterial, body: XmlElement | null): TerminalReport {
  const observation = first(first(body, "Intensity"), "Observation");
  const budget: Budget = { left: AREA_LIMIT, omitted: 0 };
  const areas: TerminalIntensityArea[] = [];
  for (const pref of children(observation, "Pref")) for (const area of children(pref, "Area")) {
    if (take(budget)) areas.push({ name: read(area, "Name") ?? "", maxInt: read(area, "MaxInt"),
      maxIntCondition: clip(attribute(first(area, "MaxInt"), "condition")), maxLgInt: read(area, "MaxLgInt") });
  }
  const comments = first(body, "Comments");
  const heading = head(material), earthquake = first(body, "Earthquake");
  // P3-TL-AC06 (4): 発生の時刻。震源の情報は OriginTime、震度速報（VXSE51）には震源が無いので Head/TargetDateTime。
  const origin = read(earthquake, "OriginTime") ?? (material.headType === "VXSE51" ? read(first(material.xml, "Head"), "TargetDateTime") : null);
  return { kind: "seismic", head: heading, hypocenter: hypocenter(earthquake),
    maxInt: read(observation, "MaxInt"), maxIntCondition: clip(attribute(first(observation, "MaxInt"), "condition")),
    maxLgInt: read(observation, "MaxLgInt"), originDateTimeRaw: origin, areas, forecastComment: read(first(comments, "ForecastComment"), "Text"),
    uri: read(comments, "URI"), text: read(body, "Text"), omitted: budget.omitted };
}

function tsunamiArea(item: XmlElement, stations: Budget): TerminalTsunamiArea {
  const firstHeight = first(item, "FirstHeight");
  const tides: { name: string; highTideDateTimeRaw: string | null }[] = [];
  for (const station of children(item, "Station")) {
    const highTide = read(station, "HighTideDateTime");
    if (highTide != null && take(stations)) tides.push({ name: read(station, "Name") ?? "", highTideDateTimeRaw: highTide });
  }
  return { kindName: read(first(first(item, "Category"), "Kind"), "Name"), name: read(first(item, "Area"), "Name") ?? "",
    height: value(first(first(item, "MaxHeight"), "TsunamiHeight")), arrivalTimeRaw: read(firstHeight, "ArrivalTime"),
    arrivalCondition: read(firstHeight, "Condition"), stations: tides };
}

function tsunami(material: DecodedMaterial, body: XmlElement | null): TerminalReport {
  const root = first(body, "Tsunami");
  // RES-02 の観測点 1,024 は、満潮時刻を持つ観測点（Forecast と Estimation の Item/Station）と観測した観測点（Observation）で分け合う
  // （1 報の観測点の材料の合計を 1 つの上限で縛る）。区域と推定区域はそれぞれ 256。
  const areaBudget: Budget = { left: AREA_LIMIT, omitted: 0 }, stationBudget: Budget = { left: STATION_LIMIT, omitted: 0 };
  const estimationBudget: Budget = { left: AREA_LIMIT, omitted: 0 };
  const areas = children(first(root, "Forecast"), "Item").flatMap((item) => take(areaBudget) ? [tsunamiArea(item, stationBudget)] : []);
  const estimations = children(first(root, "Estimation"), "Item").flatMap((item) => take(estimationBudget) ? [tsunamiArea(item, stationBudget)] : []);
  const stations: TerminalTsunamiStation[] = [];
  for (const item of children(first(root, "Observation"), "Item")) for (const station of children(item, "Station")) {
    if (!take(stationBudget)) continue;
    const firstHeight = first(station, "FirstHeight"), maxHeight = first(station, "MaxHeight");
    stations.push({ name: read(station, "Name") ?? "", arrivalTimeRaw: read(firstHeight, "ArrivalTime"), initial: read(firstHeight, "Initial"),
      arrivalCondition: read(firstHeight, "Condition"), maxHeight: value(first(maxHeight, "TsunamiHeight")),
      maxHeightDateTimeRaw: read(maxHeight, "DateTime"), maxHeightCondition: read(maxHeight, "Condition") });
  }
  return { kind: "tsunami", head: head(material), hypocenter: hypocenter(first(body, "Earthquake")), areas, stations, estimations,
    warningComment: read(first(first(body, "Comments"), "WarningComment"), "Text"), text: read(body, "Text"),
    omitted: areaBudget.omitted + stationBudget.omitted + estimationBudget.omitted };
}

// ---- 短い形（AC09、spec §5.4）----
type ShortUnit = Exclude<RuntimeUnitId, "U-E" | "U-Q" | "U-T">;
type Kind = Readonly<{ name: string | null; code: string | null; status: string | null }>;
// Body を文書の順に 1 回だけ辿り、最初の Area/Name（対象）と、Kind（LastKind は名前が違うので入らない）と InfoSerial/Name を集める（AC08 (2)）。
// Kind は 256 まで（RES-02 の区域と同じ上限。帯の段は最も重い段だけを使うので、越えた分を数えない）。
function scan(body: XmlElement | null): { target: string | null; kinds: Kind[]; serialName: string | null } {
  const found: { target: string | null; kinds: Kind[]; serialName: string | null } = { target: null, kinds: [], serialName: null };
  const visit = (node: XmlElement): void => {
    const name = localName(node);
    if (name === "Area" && found.target == null) found.target = read(node, "Name");
    else if (name === "Kind" && found.kinds.length < AREA_LIMIT) found.kinds.push({ name: read(node, "Name"), code: read(node, "Code"), status: read(node, "Status") });
    else if (name === "InfoSerial" && found.serialName == null) found.serialName = read(node, "Name");
    for (const child of children(node)) visit(child);
  };
  if (body != null) visit(body);
  return found;
}
// 気象・土砂で今の段に数えない Kind/Status（weather-current-notice.ts の NOT_CURRENT と同じ 2 つ）。
const NOT_CURRENT = new Set(["解除", "発表警報・注意報はなし"]);
const RANK: Readonly<Record<TerminalBandLevel, number>> = { cancel: 0, plain: 0, caution: 1, warning: 2, purple: 3 };
const heaviest = (levels: readonly TerminalBandLevel[]): TerminalBandLevel =>
  levels.reduce<TerminalBandLevel>((best, level) => RANK[level] > RANK[best] ? level : best, "plain");
// Q-TO-S-2 の表を unit ごとの読み方で段にする（成果物の AC09 (2) の表）。段は 5・4・3 相当が purple・warning・caution、それより下は plain。
const byLevel = (level: number | null): TerminalBandLevel => level === 5 ? "purple" : level === 4 ? "warning" : level === 3 ? "caution" : "plain";
function shortLevel(unit: ShortUnit, material: DecodedMaterial, eventId: string | null, found: ReturnType<typeof scan>): TerminalBandLevel {
  const { headType } = material;
  // 洪水予報の段は Head/Headline の「（河川）」の Information の Kind にある（flood.ts と同じ在りか。Body の Kind は文の種類）。
  const kinds = unit === "U-R" ? scan(first(first(material.xml, "Head"), "Headline")).kinds : found.kinds;
  const codes = kinds.flatMap(({ code, status }) => code != null && (status == null || !NOT_CURRENT.has(status)) ? [code] : []);
  switch (unit) {
    // 気象警報（2026 年の新しい区分）の Kind/Code: 十の位 3 が特別警報（L5）、4 が危険警報（L4）、0 が警報（L3、00 は解除）。1・2 は注意報。
    case "U-W": return heaviest(codes.map((code) => /^3\d$/.test(code) ? "purple" : /^4\d$/.test(code) ? "warning" : /^0[1-9]$/.test(code) ? "caution" : "plain"));
    // 土砂災害（landslide.ts の LEVELS: 39 L5・49 L4・09 L3・29 L2）。
    case "U-L": return heaviest(codes.map((code) => byLevel(landslideLevel(code))));
    // 指定河川洪水予報（flood.ts の LEVELS: 51・53 L5、40・41 L4、30・31 L3）。
    case "U-R": return heaviest(codes.map((code) => byLevel(floodLevel(code))));
    // 噴火警戒レベルの Kind/Code（11〜15 がレベル 1〜5）。噴火速報（VFVO56）は最も重い段。
    case "U-V": return headType === "VFVO56" ? "purple"
      : heaviest(codes.map((code) => code === "15" || code === "14" ? "purple" : code === "13" ? "warning" : code === "12" ? "caution" : "plain"));
    // 南海トラフ地震臨時情報の InfoSerial/Name。解説情報（VYSE51・52）と調査終了は plain。
    case "U-N": return found.serialName === "巨大地震警戒" ? "purple" : found.serialName === "巨大地震注意" || found.serialName === "調査中" ? "warning" : "plain";
    // 竜巻注意情報（VPHW50・51）。
    case "U-M": return headType === "VPHW50" || headType === "VPHW51" ? "caution" : "plain";
    // 記録的短時間大雨情報（VPOA50）と、その対応報（EventID が K の VPBS50、notification-gate の categoryOf と同じ読み）。
    case "U-B": return headType === "VPOA50" || (headType === "VPBS50" && eventId?.startsWith("K") === true) ? "caution" : "plain";
    case "U-F": case "U-Y": return "plain";
    default: { const unknown: never = unit; throw new Error(`unknown short unit ${String(unknown)}`); }
  }
}
function short(material: DecodedMaterial, unit: ShortUnit, body: XmlElement | null): TerminalReport {
  const heading = head(material), found = scan(body);
  const level = heading.infoType === "取消" ? "cancel" : shortLevel(unit, material, heading.eventId, found);
  return { kind: "short", unit, head: heading, target: unit === "U-N" ? null : found.target, level };
}

// P3-TO-AC01 (2)・D-ORIGIN: 端末に出すのは live か replay の報だけ。U-E は facts.report を使うので作らない。
function terminalReport(material: DecodedMaterial, unit: RuntimeUnitId): TerminalReport | null {
  if (material.origin === "recovery") return null;
  const body = first(material.xml, "Body");
  switch (unit) {
    case "U-E": return null;
    case "U-Q": return seismic(material, body);
    case "U-T": return tsunami(material, body);
    default: return short(material, unit, body);
  }
}

// P3-TO-AC01 (2)・D-EXTRACT-PATH: その入力の unit が採った報（accepted で semantic か revisionOnly）だけに 1 回呼ぶ。
// 無いと deliveryOnly・duplicate・stale の入力でも端末に同じ報が出る。
function inputTerminal(result: ParserMailboxResult, outcomes: readonly RuntimePublishedOutcome[]): TerminalReport | null {
  if (result.kind !== "decoded") return null;
  const route = classifyHeadType(result.material.headType);
  if (route.status !== "ready") return null;
  const taken = outcomes.some(({ unit, outcome }) => unit === route.unit && outcome.kind === "accepted" && outcome.change !== "deliveryOnly");
  return taken ? terminalReport(result.material, route.unit) : null;
}

export { inputTerminal, terminalReport };
