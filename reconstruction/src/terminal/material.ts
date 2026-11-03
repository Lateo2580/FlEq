import type { DecodedMaterial, ParserMailboxResult, XmlElement } from "../../contracts/p1-parser-boundary.types";
import type { RuntimePublishedOutcome, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type {
  TerminalHead, TerminalHypocenter, TerminalIntensityArea, TerminalReport, TerminalTsunamiArea, TerminalTsunamiStation, TerminalValue,
} from "../../contracts/p3-terminal-output.types";
import { attribute, children, first, scalar, text } from "../decode-material/xml-read";
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
  return { kind: "seismic", head: head(material), hypocenter: hypocenter(first(body, "Earthquake")),
    maxInt: read(observation, "MaxInt"), maxIntCondition: clip(attribute(first(observation, "MaxInt"), "condition")),
    maxLgInt: read(observation, "MaxLgInt"), areas, forecastComment: read(first(comments, "ForecastComment"), "Text"),
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

// P3-TO-AC01 (2)・D-ORIGIN: 端末に出すのは live か replay の報だけ。U-E は facts.report を使うので作らない。
// 短い形の 9 unit は【発注 2】で足す（それまでは null）。
function terminalReport(material: DecodedMaterial, unit: RuntimeUnitId): TerminalReport | null {
  if (material.origin === "recovery") return null;
  const body = first(material.xml, "Body");
  switch (unit) {
    case "U-Q": return seismic(material, body);
    case "U-T": return tsunami(material, body);
    default: return null;
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
