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
    headline: read(first(heading, "Headline"), "Text"), reportDateTimeRaw: read(heading, "ReportDateTime"),
    // P3-TL5-AC01: 門（tideOnly）と同じ値を読む。x:InfoType を混ぜた電文で、門は発表と読み、表示が取消になって満潮の表が消えた。
    infoType: clip(material.infoTypeRaw.trim()),
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
// typhoon は文書の順で最初の台風呼称（P3-TL9-AC05。同じ辿りの中で覚え、新しい辿りを足さない）。
// risks は withRisks（取消でない VPWP50）のときだけ作る Significancy の type → 組の表（P3-TL11-AC02 (2)(3)。同じ辿りの中で type ごとに 1 回引く）。
// 親が Base か Local のものだけを読む（U-F が予報の値として読む階層。付加事項 Addition の中は親が Addition なので入らない）。
type Risk = NonNullable<Extract<TerminalReport, { kind: "short" }>["risks"]>[number];
const RISK_LIMIT = 32;
function scan(body: XmlElement | null, withRisks = false): { target: string | null; kinds: Kind[]; serialName: string | null; typhoon: XmlElement | null; risks: Map<string, Risk> | null } {
  const found: { target: string | null; kinds: Kind[]; serialName: string | null; typhoon: XmlElement | null; risks: Map<string, Risk> | null } = { target: null, kinds: [], serialName: null, typhoon: null, risks: withRisks ? new Map() : null };
  const visit = (node: XmlElement, parent: string | null): void => {
    const name = localName(node);
    if (name === "Area" && found.target == null) found.target = read(node, "Name");
    else if (name === "Kind" && found.kinds.length < AREA_LIMIT) found.kinds.push({ name: read(node, "Name"), code: read(node, "Code"), status: read(node, "Status") });
    else if (name === "InfoSerial" && found.serialName == null) found.serialName = read(node, "Name");
    else if (name === "TyphoonNamePart" && found.typhoon == null) found.typhoon = node;
    else if (name === "Significancy" && found.risks != null && (parent === "Base" || parent === "Local")) {
      // Code は並べるかと並べる順だけに使い、出す字は電文の type と Name のまま（D-TS-KINDS=A）。同じ Code なら電文で先の組を残す。
      const type = attribute(node, "type"), label = read(node, "Name"), code = read(node, "Code");
      if (type != null && type !== "" && type.length <= RISK_LIMIT && label != null && label !== "" && label.length <= RISK_LIMIT && code != null && /^[2-5][0-9]$/.test(code)) {
        const before = found.risks.get(type);
        if (before == null ? found.risks.size < RISK_LIMIT : Number(code) > Number(before.code)) found.risks.set(type, { type, name: label, code });
      }
    }
    for (const child of children(node)) visit(child, name);
  };
  if (body != null) visit(body, null);
  return found;
}
// 気象・土砂で今の段に数えない Kind/Status（weather-current-notice.ts の NOT_CURRENT と同じ 2 つ）。
const NOT_CURRENT = new Set(["解除", "発表警報・注意報はなし"]);
const RANK: Readonly<Record<TerminalBandLevel, number>> = { cancel: 0, plain: 0, caution: 1, warning: 2, purple: 3, top: 4 };
// 段と、その段を決めた Kind の名前（P3-TL2-AC08）。同じ段が複数なら電文で最初の 1 つを残す（reduce は厳密に重いときだけ置き換える）。
type Ranked = Readonly<{ level: TerminalBandLevel; name: string | null }>;
const heaviest = (items: readonly Ranked[]): Ranked =>
  items.reduce<Ranked>((best, item) => RANK[item.level] > RANK[best.level] ? item : best, { level: "plain", name: null });
// Q-TO-S-2 と Q-TO3-LEVEL の表を unit ごとの読み方で段にする。警戒レベル 5・4・3・2 が 最も重い・紫・警報・注意、それより下は plain。
const byLevel = (level: number | null): TerminalBandLevel => level === 5 ? "top" : level === 4 ? "purple" : level === 3 ? "warning" : level === 2 ? "caution" : "plain";
// 気象警報（2026 年の新しい区分）の Kind/Code: 十の位 3 が特別警報（L5）、4 が危険警報（L4）、0 が警報（L3、00 は解除）。1・2 は注意報で、レベルの付かないものも注意の段（Q-TO3-LEVEL）。
// 全国の集約通報の表も同じ読み方で段にする（P3-TL8-AC01 (3)）。
const weatherLevel = (code: string): TerminalBandLevel => /^3\d$/.test(code) ? "top" : /^4\d$/.test(code) ? "purple" : /^0[1-9]$/.test(code) ? "warning" : /^[12]\d$/.test(code) ? "caution" : "plain";
function shortLevel(unit: ShortUnit, material: DecodedMaterial, eventId: string | null, found: ReturnType<typeof scan>): Ranked {
  const { headType } = material;
  // 洪水予報の段は Head/Headline の「（河川）」の Information の Kind にある（flood.ts と同じ在りか。Body の Kind は文の種類）。
  const kinds = unit === "U-R" ? scan(first(first(material.xml, "Head"), "Headline")).kinds : found.kinds;
  const current = kinds.flatMap(({ name, code, status }) => code != null && (status == null || !NOT_CURRENT.has(status)) ? [{ name, code }] : []);
  const ranked = (level: (code: string) => TerminalBandLevel): Ranked => heaviest(current.map(({ name, code }) => ({ level: level(code), name })));
  switch (unit) {
    case "U-W": return ranked(weatherLevel);
    // 土砂災害（landslide.ts の LEVELS: 39 L5・49 L4・09 L3・29 L2）。
    case "U-L": return ranked((code) => byLevel(landslideLevel(code)));
    // 指定河川洪水予報（flood.ts の LEVELS: 51・53 L5、40・41 L4、30・31 L3、20〜22 L2）。
    case "U-R": return ranked((code) => byLevel(floodLevel(code)));
    // 噴火警戒レベルの Kind/Code（11〜15 がレベル 1〜5）。噴火速報（VFVO56）は最も重い段で、段を電文の種類で決めるので理由の名前は無い。
    // レベルの無い火山は P3-TL6-D-CRATER=A・D-SOUND=A で 24・25 が top、23 が warning、22・36 が caution（P3-C9-NOTICE-LEVELS=C と同じ重さ）。
    case "U-V": return headType === "VFVO56" ? { level: "top", name: null }
      : ranked((code) => code === "15" || code === "14" || code === "24" || code === "25" ? "top" : code === "13" || code === "23" ? "warning" : code === "12" || code === "22" || code === "36" ? "caution" : "plain");
    // 南海トラフ地震臨時情報の InfoSerial/Name。解説情報（VYSE51・52）と調査終了は plain。
    // VYSE60 は InfoSerial の有無によらず警報の段で、段を電文の種類で決めるので理由の名前は無い（P3-TL6-D-VYSE60=A）。
    case "U-N": return headType === "VYSE60" ? { level: "warning", name: null } : { level: found.serialName === "巨大地震警戒" ? "top" : found.serialName === "巨大地震注意" || found.serialName === "調査中" ? "warning" : "plain", name: found.serialName };
    // 気象防災速報（竜巻注意・竜巻目撃、VPHW50・51）は警報。Body の Kind が 1〜255 個で全部が Code「0」か Name「なし」の解除の報は普通（P3-TL9-AC04、
    // U-M の P3-C13-TORNADO-FACTS と同じ規則）。256 に届いた報は読まなかった Kind に発表がありうるので警報のまま。
    case "U-M": return { level: headType !== "VPHW50" && headType !== "VPHW51" ? "plain"
      : kinds.length > 0 && kinds.length < AREA_LIMIT && kinds.every(({ name, code }) => code === "0" || name === "なし") ? "plain" : "warning", name: null };
    // 気象防災速報（記録的短時間大雨、VPOA50 と、その対応報で EventID が K の VPBS50。notification-gate の categoryOf と同じ読み）は紫。
    case "U-B": return { level: headType === "VPOA50" || (headType === "VPBS50" && eventId?.startsWith("K") === true) ? "purple" : "plain", name: null };
    case "U-F": case "U-Y": return { level: "plain", name: null };
    default: { const unknown: never = unit; throw new Error(`unknown short unit ${String(unknown)}`); }
  }
}
// 全国の月間火山概況（Q-TO4-MONTHLY）の表。Body の全 VolcanoInfo の Item を電文の順に行にし、「活火山であることに留意」の Item と AREA_LIMIT を越えた火山は others に数える。
// 火山名の Areas だけを読む（volcano.ts の volcanoItems・volcanoAreas と同じ絞り方。対象市町村等の Areas が混ざる報がある）。
// AREA_LIMIT は読む前に全 Area で数える（AC03 (4)）。無いと留意の Area が多い報で、後ろの火山が表に出てしまう。
function monthlyTable(body: XmlElement | null): NonNullable<Extract<TerminalReport, { kind: "short" }>["monthly"]> {
  const rows: { label: string; areas: string[] }[] = [];
  const budget: Budget = { left: AREA_LIMIT, omitted: 0 };
  let others = 0;
  for (const info of children(body, "VolcanoInfo")) for (const item of children(info, "Item")) {
    const kind = read(first(item, "Kind"), "Name") ?? "", areas: string[] = [];
    const lists = children(item, "Areas").filter((node) => attribute(node, "codeType") === "火山名");
    for (const area of lists.flatMap((node) => children(node, "Area"))) {
      if (!take(budget)) continue;
      const name = read(area, "Name");
      if (name == null || kind.includes("活火山であることに留意")) others += 1;
      else areas.push(name);
    }
    if (areas.length > 0) rows.push({ label: kind, areas });
  }
  return { rows, others: others + budget.omitted };
}
// 噴火速報（Q-TO5-FLASH）の活動の文と対象の市町村。Areas は codeType が市町村等のものだけを全 VolcanoInfo から電文の順に読み、AREA_LIMIT は読む前に全 Area で数える。
// 無いと市町村等でない Areas が数に混ざり、上限の境界（256 件は「ほか」なし、257 件は 1）がずれる。
function flashBody(body: XmlElement | null): NonNullable<Extract<TerminalReport, { kind: "short" }>["flash"]> {
  const budget: Budget = { left: AREA_LIMIT, omitted: 0 }, towns: string[] = [];
  for (const info of children(body, "VolcanoInfo")) for (const item of children(info, "Item")) {
    const lists = children(item, "Areas").filter((node) => attribute(node, "codeType") === "気象・地震・火山情報／市町村等");
    for (const area of lists.flatMap((node) => children(node, "Area"))) {
      if (!take(budget)) continue;
      const name = read(area, "Name");
      if (name == null || name === "") budget.omitted += 1;
      else towns.push(name);
    }
  }
  return { activity: read(first(body, "VolcanoInfoContent"), "VolcanoActivity"), towns, others: budget.omitted };
}
// 全国の集約通報（VPWS50）の区域の層（P3-TL8-D-LAYER）。全国 64 の予報区で、細かい層は段ごとの Kind が同じで名前が増えるだけなので読まない。
const PREFECTURE_LAYER = "気象警報・注意報（府県予報区等）";
// P3-TL8-AC01 (3)・AC02・AC03・AC05 (1): 層の Item を AREA_LIMIT まで 1 回辿り、今の Kind の最も重い段と、その段の Kind の Code ごとの行を作る。
// 行は Code の昇順（電文の順だと予報区の出入りで並びが入れ替わり、端末の比べ〔AC04〕で出し直しになる）。注意報だけの段は予報区を持たない（AC03 (1)）。
function nationalTable(layer: XmlElement): { level: TerminalBandLevel; national: NonNullable<Extract<TerminalReport, { kind: "short" }>["national"]> } {
  const budget: Budget = { left: AREA_LIMIT, omitted: 0 };
  const byCode = new Map<string, { label: string; level: TerminalBandLevel; areas: string[]; item: XmlElement | null }>();
  let level: TerminalBandLevel = "plain";
  for (const item of children(layer, "Item")) {
    if (!take(budget)) continue;
    const area = read(first(item, "Area"), "Name");
    for (const kind of children(item, "Kind")) {
      const code = read(kind, "Code"), status = read(kind, "Status");
      const rank = code == null || (status != null && NOT_CURRENT.has(status)) ? "plain" : weatherLevel(code);
      if (code == null || rank === "plain") continue;
      let row = byCode.get(code);
      if (row == null) { row = { label: read(kind, "Name") ?? "", level: rank, areas: [], item: null }; byCode.set(code, row); }
      // 1 つの Item が同じ Code の Kind を 2 つ持っても予報区は 1 回（AC02 (2)）。
      if (area != null && row.item !== item) { row.item = item; row.areas.push(area); }
      if (RANK[rank] > RANK[level]) level = rank;
    }
  }
  const rows = [...byCode].filter(([, row]) => row.level === level).sort(([left], [right]) => left < right ? -1 : 1)
    .map(([, row]) => ({ label: row.label, areas: level === "caution" ? [] : row.areas }));
  return { level, national: { rows, others: budget.omitted } };
}
// P3-TL9-AC05・D-TYPHOON-LABEL: 台風の帯の対象。番号（半角 4 桁）があれば通知の題（typhoon-unit.ts の labelOf）と同じ形、無ければ Remark、どちらも無ければ null（最初の Area）。
function typhoonLabel(part: XmlElement | null): string | null {
  const number = read(part, "Number"), name = read(part, "Name"), remark = read(part, "Remark");
  if (number != null && /^[0-9]{4}$/.test(number)) return `台風第${Number(number.slice(-2))}号${name == null || name === "" ? "" : `（${name}）`}`;
  return remark == null || remark === "" ? null : remark;
}
function short(material: DecodedMaterial, unit: ShortUnit, body: XmlElement | null): TerminalReport {
  const heading = head(material);
  const cancel = heading.infoType === "取消";
  // P3-TL8-AC01: 全国の集約通報は対象を「全国」にする（Body の最初の Area/Name は使わない）。府県予報区等の層がある取消でない報は、段と表を層だけから決めて scan を省く（AC05 (1)）。
  const nationwide = unit === "U-W" && material.headType === "VPWS50";
  const layer = nationwide && !cancel ? children(body, "Warning").find((node) => attribute(node, "type") === PREFECTURE_LAYER) ?? null : null;
  if (layer != null) {
    const table = nationalTable(layer);
    return { kind: "short", unit, head: heading, target: "全国", level: table.level, reason: null, cancelText: null, monthly: null, flash: null, national: table.national, risks: null };
  }
  const found = scan(body, unit === "U-F" && material.headType === "VPWP50" && !cancel);
  // Head の Title に全国の活火山を含む VFVO51。EventID 900 は「その他の火山」の番号でもあるので使わない（P3-TL3-D-DETECT）。
  const monthly = material.headType === "VFVO51" && heading.title?.includes("全国の活火山") === true;
  const { level, name } = cancel ? { level: "cancel" as const, name: null } : monthly ? { level: "plain" as const, name: null } : shortLevel(unit, material, heading.eventId, found);
  return { kind: "short", unit, head: heading, target: monthly ? "全国の活火山" : nationwide ? "全国" : unit === "U-N" ? null : (unit === "U-Y" ? typhoonLabel(found.typhoon) : null) ?? found.target, level, reason: RANK[level] >= RANK.warning ? name : null,
    // 取消の文は取消の報だけ読む（P3-TL3-AC05 (4)）。read は Body の直下の子だけを見るので VolcanoInfo の中の Text は読まない。
    cancelText: cancel ? read(body, "Text") : null, monthly: monthly && !cancel ? monthlyTable(body) : null,
    flash: material.headType === "VFVO56" && !cancel ? flashBody(body) : null, national: null, risks: found.risks == null ? null : [...found.risks.values()] };
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

// P3-TL5-AC01 (1): 満潮時刻だけの VTSE51（取消でなく、Body/Tsunami の直下に Observation の要素が 1 つも無い）。空の Observation の要素がある報は対象でない。
function tideOnly(material: DecodedMaterial): boolean {
  const root = first(first(material.xml, "Body"), "Tsunami");
  return material.headType === "VTSE51" && root != null && children(root, "Observation").length === 0 && material.infoTypeRaw.trim() !== "取消";
}

// P3-TO-AC01 (2)・D-EXTRACT-PATH: その入力の unit が採った報（accepted で semantic か revisionOnly）だけに 1 回呼ぶ。
// 無いと deliveryOnly・duplicate・stale の入力でも端末に同じ報が出る。
// P3-TL5-AC01 (2): 観測の無い VTSE51 は U-T が outcome を出さない（state を変えず鳴らさない）ので、unit が拒否しなかった（rejected=false）入力だけ例外で通す。
// 無いと満潮時刻の報が端末に 0 行になる。rejected は owner の confirmationEvidence の unreadableReport（拒否された報は読めなかった報のカードの側）。
function inputTerminal(result: ParserMailboxResult, outcomes: readonly RuntimePublishedOutcome[], rejected: boolean): TerminalReport | null {
  if (result.kind !== "decoded") return null;
  const route = classifyHeadType(result.material.headType);
  if (route.status !== "ready") return null;
  // Q-TO5-VPNO50: 報知は発表も切替も出さない（本文は VPWW の報で出る）。U-W の state の処理は reducer の側で変えない。
  if (result.material.headType === "VPNO50") return null;
  const taken = outcomes.some(({ unit, outcome }) => unit === route.unit && outcome.kind === "accepted" && outcome.change !== "deliveryOnly");
  return taken || (!rejected && tideOnly(result.material)) ? terminalReport(result.material, route.unit) : null;
}

export { inputTerminal, terminalReport };
