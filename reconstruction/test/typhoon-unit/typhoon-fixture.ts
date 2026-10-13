import { readFileSync } from "node:fs";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, PersistenceStatus } from "../../contracts/p2-shared-runtime.types";
import type { TyphoonUnitState, TyphoonUnitStep } from "../../contracts/p3-typhoon-unit.types";
import { deliveryGrowth as reserve } from "../../src/notification-delivery/delivery-growth";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { reduceTyphoonUnit } from "../../src/units/typhoon/typhoon-unit";

// P3-UNIT-Y-001 の試験の共通部（続報と Q-LIMIT の境界入力は fixture を焼かずに試験内で作る）。

const saved: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null,
  savedAckAt: null, dirtySince: null };
function emptyState(): TyphoonUnitState {
  return { schemaVersion: "p3-typhoon-unit-v1", contentRevision: 0, analysis: [], probability: [], intents: [], persistence: saved };
}
function clock(wallTimeMs: number, monotonicMs = 0): ClockReading {
  return { wallTimeMs, monotonicMs };
}

let sequence = 0;
// 連番は桁を固定する（inputId は intent の source に入って保存の byte を決める）。
const next = () => String(++sequence).padStart(6, "0");
function decodeXml(xml: string, headType: string, inputId = `input-${next()}`, origin: "replay" | "recovery" = "replay"): DecodedMaterial {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: 0, origin, kind: "replay", headType, body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
// name は test/fixtures の下の名前（拡張子なし）か test/ からの path。
const pathOf = (name: string) => name.startsWith("test/") ? name : `test/fixtures/${name}.xml`;
const headTypeOf = (name: string): string => (name.split("/").at(-1)!.match(/V[A-Z]{3}\d{2}/gi)?.at(-1) ?? "VPTW60").toUpperCase();
const cache = new Map<string, string>();
function fixtureXml(name: string): string {
  let xml = cache.get(name);
  if (xml == null) { xml = readFileSync(pathOf(name), "utf8"); cache.set(name, xml); }
  return xml;
}
function decodeFixture(name: string, transform: (xml: string) => string = (xml) => xml, inputId?: string, headType = headTypeOf(name),
  origin: "replay" | "recovery" = "replay"): DecodedMaterial {
  return decodeXml(transform(fixtureXml(name)), headType, inputId ?? `${name.split("/").at(-1)!.slice(0, 40)}#${next()}`, origin);
}
const replaceTag = (tag: string, value: string) => (xml: string) =>
  xml.replace(new RegExp(`<${tag}>[^<]*</${tag}>|<${tag}/>|<${tag} />`), `<${tag}>${value}</${tag}>`);
const retime = (at: string) => replaceTag("ReportDateTime", at);
const serial = (value: string) => replaceTag("Serial", value);
const eventId = (value: string) => replaceTag("EventID", value);
const infoType = (value: string) => replaceTag("InfoType", value);
const status = (value: string) => (xml: string) => xml.replace("<Status>通常</Status>", `<Status>${value}</Status>`);
const compose = (...steps: readonly ((xml: string) => string)[]) => (xml: string) => steps.reduce((value, step) => step(value), xml);
const iso = (ms: number) => new Date(ms + 32_400_000).toISOString().replace(".000Z", "+09:00");
const ms = (text: string) => Date.parse(text);

function receive(state: TyphoonUnitState, material: DecodedMaterial, at: ClockReading): TyphoonUnitStep {
  return reduceTyphoonUnit(state, { kind: "receive", material, clock: at });
}
// 受信時刻は報の時刻（期限の手前）。
function send(state: TyphoonUnitState, name: string, transform?: (xml: string) => string, now?: number, monotonicMs = 0): TyphoonUnitStep {
  const material = decodeFixture(name, transform);
  return receive(state, material, clock(now ?? Date.parse(material.reportDateTimeRaw), monotonicMs));
}
const tick = (state: TyphoonUnitState, wallTimeMs: number) => reduceTyphoonUnit(state, { kind: "deadline", clock: clock(wallTimeMs) });

// ---- 合成 XML（境界の入力は fixture を焼かずに試験内で組む） ----

const HOUR = 3_600_000;
const head = (o: { title: string; eventId: string; report: string; target: string | null; info: string; serial: string | null; status?: string }) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">\n`
  + `<Control><Title>${o.title}</Title><DateTime>${o.report}</DateTime><Status>${o.status ?? "通常"}</Status><EditorialOffice>気象庁本庁</EditorialOffice><PublishingOffice>気象庁</PublishingOffice></Control>\n`
  + `<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>${o.title}</Title><ReportDateTime>${o.report}</ReportDateTime>`
  + (o.target == null ? "" : `<TargetDateTime>${o.target}</TargetDateTime>`) + `<EventID>${o.eventId}</EventID><InfoType>${o.info}</InfoType>`
  + (o.serial == null ? "" : `<Serial>${o.serial}</Serial>`) + `<Headline><Text/></Headline></Head>\n`;

type AnalysisOptions = Readonly<{
  eventId?: string; report?: string; target?: string; info?: string; serial?: string | null; remark?: string; number?: string; name?: string;
  category?: string; intensity?: string; size?: string; coordinate?: string;
  // 実況の後ろの DateTime の type の列（既定は予報 3 時間後 1 個）。
  later?: readonly string[]; axes?: number; items?: number;
}>;
// 実況 1 時刻＋later の時刻の解析。軸の数（axes）と Item の数（items）は境界の試験で変える。
function analysisXml(o: AnalysisOptions = {}): string {
  const report = o.report ?? "2026-05-31T10:45:00+09:00", target = o.target ?? "2026-05-31T10:00:00+09:00";
  const axis = `<jmx_eb:Axis><jmx_eb:Direction type="方向" unit="８方位漢字">北東</jmx_eb:Direction><jmx_eb:Radius unit="海里" type="半径">80</jmx_eb:Radius><jmx_eb:Radius unit="km" type="半径">150</jmx_eb:Radius></jmx_eb:Axis>`;
  const frame = (type: string, index: number) => {
    const now = type === "実況", forecast = !now && !type.startsWith("推定");
    const center = forecast
      ? `<ProbabilityCircle type="予報円"><jmx_eb:BasePoint type="中心位置（度）">+26.${index % 10}+126.0/</jmx_eb:BasePoint><jmx_eb:Axes><jmx_eb:Axis><jmx_eb:Direction condition="全域" type="方向" unit="８方位漢字"/><jmx_eb:Radius unit="km" type="７０パーセント確率半径">${100 + index}</jmx_eb:Radius></jmx_eb:Axis></jmx_eb:Axes></ProbabilityCircle>`
      : `<jmx_eb:Coordinate type="中心位置（度）">${o.coordinate ?? "+25.5+125.5/"}</jmx_eb:Coordinate>`;
    const naming = now ? `<Kind><Property><Type>呼称</Type><TyphoonNamePart><Name>${o.name ?? "JANGMI"}</Name><NameKana>チャンミー</NameKana><Number>${o.number ?? "2606"}</Number><Remark>${o.remark ?? ""}</Remark></TyphoonNamePart></Property></Kind>` : "";
    const area = `<WarningAreaPart type="暴風域"><jmx_eb:WindSpeed unit="m/s" type="風速">25</jmx_eb:WindSpeed><jmx_eb:Circle><jmx_eb:Axes>${axis.repeat(o.axes ?? 1)}</jmx_eb:Axes></jmx_eb:Circle></WarningAreaPart>`;
    const one = `<Item>${naming}<Kind><Property><Type>階級</Type><ClassPart><jmx_eb:TyphoonClass type="熱帯擾乱種類">${o.category ?? "台風(TS)"}</jmx_eb:TyphoonClass>`
      + `<jmx_eb:AreaClass type="大きさ階級">${o.size ?? ""}</jmx_eb:AreaClass><jmx_eb:IntensityClass type="強さ階級">${o.intensity ?? ""}</jmx_eb:IntensityClass></ClassPart></Property></Kind>`
      + `<Kind><Property><Type>中心</Type><CenterPart>${center}<Location>日本の南</Location><jmx_eb:Direction type="移動方向" unit="１６方位漢字">北</jmx_eb:Direction>`
      + `<jmx_eb:Speed unit="km/h" type="移動速度">20</jmx_eb:Speed><jmx_eb:Pressure unit="hPa" type="中心気圧">985</jmx_eb:Pressure></CenterPart></Property></Kind>`
      + `<Kind><Property><Type>風</Type><WindPart><jmx_eb:WindSpeed unit="m/s" type="最大風速">30</jmx_eb:WindSpeed><jmx_eb:WindSpeed unit="m/s" type="最大瞬間風速">40</jmx_eb:WindSpeed></WindPart>${area}</Property></Kind></Item>`;
    return `<MeteorologicalInfo><DateTime type="${type}">${target}</DateTime>${one.repeat(o.items ?? 1)}</MeteorologicalInfo>`;
  };
  return head({ title: "台風解析・予報情報", eventId: o.eventId ?? "TC2606", report, target, info: o.info ?? "発表", serial: o.serial === undefined ? "42" : o.serial })
    + `<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/"><MeteorologicalInfos type="台風情報">`
    + ["実況", ...o.later ?? ["予報　３時間後"]].map(frame).join("") + `</MeteorologicalInfos></Body></Report>`;
}

type ProbabilityArea = Readonly<{ code: string; name?: string; prefectureCode?: string; prefecture?: string; daily?: readonly number[]; slots?: readonly number[] }>;
type ProbabilityOptions = Readonly<{
  eventId?: string; report?: string; target?: string; info?: string; serial?: string | null; areas: readonly ProbabilityArea[]; slotCount?: number;
  duration?: string; skipDays?: readonly number[]; seriesAreas?: readonly ProbabilityArea[];
}>;
const six = (value: number) => String(value).padStart(6, "0");
// 地域 n 件の確率の報。areas の daily（5 つ、既定 0）と slots（slotCount 個、既定 0）を持つ。seriesAreas で時系列だけ別の地域にできる。
function probabilityXml(o: ProbabilityOptions): string {
  const report = o.report ?? "2026-05-31T09:55:00+09:00", target = o.target ?? "2026-05-31T09:00:00+09:00";
  const slotCount = o.slotCount ?? 40, baseMs = Date.parse(target);
  const area = (a: ProbabilityArea) => `<Area><Name>${a.name ?? `地域${a.code}`}</Name><Code>${a.code}</Code><Prefecture>${a.prefecture ?? "県"}</Prefecture><PrefectureCode>${a.prefectureCode ?? "010000"}</PrefectureCode></Area>`;
  const kind = (values: string) => `<Kind><Property><Type>台風の暴風域に入る確率</Type><FiftyKtWindProbabilityPart>${values}</FiftyKtWindProbabilityPart></Property></Kind>`;
  const day = (index: number) => `<MeteorologicalInfo type="台風の暴風域に入る確率（${index + 1}日積算）"><DateTime>${target}</DateTime><Duration>PT${24 * (index + 1)}H</Duration>`
    + o.areas.map((a) => `<Item>${kind(`<FiftyKtWindProbability unit="%">${a.daily?.[index] ?? 0}</FiftyKtWindProbability>`)}${area(a)}</Item>`).join("") + `</MeteorologicalInfo>`;
  const defines = Array.from({ length: slotCount }, (_, index) => `<TimeDefine timeId="${index + 1}"><DateTime>${iso(baseMs + index * 3 * HOUR)}</DateTime><Duration>${o.duration ?? "PT3H"}</Duration></TimeDefine>`).join("");
  const series = (o.seriesAreas ?? o.areas).map((a) => `<Item>${kind(Array.from({ length: slotCount }, (_, index) =>
    `<FiftyKtWindProbability refID="${index + 1}" unit="%">${a.slots?.[index] ?? 0}</FiftyKtWindProbability>`).join(""))}${area(a)}</Item>`).join("");
  return head({ title: "台風の暴風域に入る確率", eventId: o.eventId ?? "TC2606", report, target, info: o.info ?? "発表", serial: o.serial === undefined ? "41" : o.serial })
    + `<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/"><MeteorologicalInfos type="台風情報"><MeteorologicalInfo type="台風呼称"><DateTime>${target}</DateTime><Item><Kind><Property><Type>呼称</Type>`
    + `<TyphoonNamePart><Name>JANGMI</Name><NameKana>チャンミー</NameKana><Number>2606</Number></TyphoonNamePart></Property></Kind></Item></MeteorologicalInfo>`
    + [0, 1, 2, 3, 4].filter((index) => !(o.skipDays ?? []).includes(index)).map(day).join("") + `<TimeSeriesInfo><TimeDefines>${defines}</TimeDefines>${series}</TimeSeriesInfo></MeteorologicalInfos></Body></Report>`;
}
const decodeBuilt = (xml: string, headType: string, inputId?: string) => decodeXml(xml, headType, inputId);
// 構築した報を直接送る。
function sendXml(state: TyphoonUnitState, xml: string, headType: string, now?: number, monotonicMs = 0): TyphoonUnitStep {
  const material = decodeBuilt(xml, headType);
  return receive(state, material, clock(now ?? Date.parse(material.reportDateTimeRaw), monotonicMs));
}

// 合法最大の保存物（I-U-Y.capacityReserve の形）を JSON で直接組む: 解析 64・確率 64、各文字列・配列・数値を decode の上限の最長にし、
// pending は「実 byte＋予約」131,072 ちょうど、終端記録は 98,304 byte 以内の最大。時刻は Date の範囲 ±8.64e15 の内側の最長、報の時刻は 15 桁。
function maximumPayload() {
  const day = 24 * HOUR;
  const wide = (units: number, glyph = "あ") => glyph.repeat(units);
  const eventIdOf = (index: number) => `${"T".repeat(28)}${String(index).padStart(4, "0")}`;
  const REPORT = "9000-01-01T00:00:00.12345678901234+09:00";
  const reportMs = Date.parse(REPORT), EDGE = 8.64e15;
  const ref = (subject: string, family: string) => ({ inputId: "i".repeat(64), origin: "replay", operation: "normal", family, subject, reportDateTimeRaw: REPORT, serialRaw: "9999999999", infoTypeRaw: "発表" });
  const axes = [{ direction: wide(8), radiusKm: 9999 }, { direction: wide(8), radiusKm: 9999 }];
  const windArea = { thresholdMs: 999, axes };
  const frame = (kind: string, hours: number) => ({ kind, hours, validTime: EDGE, category: wide(32), intensity: wide(24), size: wide(24), center: { latitude: -89.9, longitude: -179.9 },
  circleRadiusKm: kind === "forecast" ? 9999 : null, location: wide(32), moveDirection: wide(8), moveSpeedKmh: 999, moveCondition: wide(16), pressureHpa: 9999, maxWindMs: 999,
  maxGustMs: 999, storm: windArea, gale: windArea, stormWarning: windArea });
  const name = { name: wide(24), nameKana: wide(24), number: "9999", remark: wide(32) };
  const analysisRecord = (index: number) => { const subject = `normal/typhoonAnalysis/${eventIdOf(index)}`;
  return { subject, operation: "normal", source: ref(subject, "VPTW65"), retainUntil: reportMs + 7 * day, effective: "active", activeUntil: reportMs + 12 * HOUR, baseTime: EDGE,
    title: wide(64), name, frames: [frame("analysis", 0), frame("estimate", 1), ...Array.from({ length: 22 }, () => frame("forecast", 120))], truncated: true }; };
  const prefectureCode = (index: number) => six(100000 + index * 1000);
  const probabilityRecord = (index: number) => { const subject = `normal/typhoonProbability/${eventIdOf(index)}`;
  return { subject, operation: "normal", source: ref(subject, "VPTA55"), retainUntil: reportMs + 7 * day, effective: "active", activeUntil: reportMs + 12 * HOUR, baseTime: EDGE,
    slotCount: 64, title: wide(64), name, maxFiveDay: 100, prefectures: Array.from({ length: 96 }, (_, at) => ({ code: prefectureCode(at), name: wide(24) })),
    areas: Array.from({ length: 384 }, (_, at) => ({ code: six(100000 + at), name: wide(24), prefectureCode: prefectureCode(at % 96), daily: [100, 100, 100, 100, 100], peak: 100, peakSlot: 63 })),
    truncated: true }; };
  const own = (subject: string) => ({ id: "", unit: "U-Y", subject, operation: "normal", source: ref(subject, subject.includes("Analysis") ? "VPTW65" : "VPTA55"), transition: "updated", channel: "desktop",
  payload: { domain: "weather", level: "normal", title: "t".repeat(160), body: "b".repeat(512) }, createdAt: EDGE, expiresAt: EDGE, nextAttemptAt: EDGE, attempts: 0, configRevision: "p3-typhoon-unit-v1", disposition: "pending" });
  const intentOf = (index: number, bodyLength: number, disposition: string) => ({ ...own(`normal/typhoonAnalysis/${eventIdOf(0)}`), id: `U-Y:${"x".repeat(60)}:${String(index).padStart(6, "0")}:desktop`,
  payload: { domain: "weather", level: "normal", title: "t".repeat(160), body: "b".repeat(bodyLength) }, disposition });
  // pending は「実 byte＋予約」131,072 ちょうど、終端記録は 98,304 byte 以内の最大。
  const pendingTotal = (list: readonly object[]) => 2 + Math.max(list.length - 1, 0) + list.reduce<number>((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + reserve(item as never), 0);
  const lengths: number[] = [];
  while (pendingTotal(lengths.map((length, index) => intentOf(index, length, "pending"))) <= 131_072) lengths.push(512);
  let excess = pendingTotal(lengths.map((length, index) => intentOf(index, length, "pending"))) - 131_072;
  for (let index = lengths.length - 1; excess > 0; index--) { const cutBy = Math.min(excess, 511); lengths[index] -= cutBy; excess -= cutBy; }
  const pendingList = lengths.map((length, index) => intentOf(index, length, "pending"));
  const terminalList: object[] = [];
  let terminalSize = 0;
  while (terminalSize + Buffer.byteLength(JSON.stringify(intentOf(1000 + terminalList.length, 512, "delivered"))) + 1 <= 98_304) {
  const next = intentOf(1000 + terminalList.length, 512, "delivered");
  terminalList.push(next);
  terminalSize += Buffer.byteLength(JSON.stringify(next)) + 1;
  }
  const payload = { schemaVersion: "p3-typhoon-unit-v1", analysis: Array.from({ length: 64 }, (_, index) => analysisRecord(index)),
  probability: Array.from({ length: 64 }, (_, index) => probabilityRecord(index)), intents: [...pendingList, ...terminalList] };

  return { payload, reportMs, EDGE, pendingTotal, pendingList, eventIdOf };
}

export { maximumPayload, analysisXml, probabilityXml, sendXml, six, HOUR, clock, compose, decodeFixture, decodeXml, emptyState, eventId, fixtureXml, headTypeOf, infoType, iso, ms, receive, replaceTag, retime, send, serial, status, tick };
