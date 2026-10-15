import { readFileSync } from "node:fs";

import { shiftTimestamps } from "../eew-e01/frames.mjs";

// P3-DC-SYNTH（P3-DISASTER-CAPACITY-001 の AC02）: 公開 fixture を型に、決まった規則と種だけで合成の電文を作る。
// 無いと、南海トラフと 2011 の後半は実電文が無く筋書きが作れず、続報で OriginTime が動くと強震保持の期限が変わる。
// 数の印: 〔公式〕公式の資料、〔上界〕コード表などの最大、〔実例〕corpus の実電文、〔推測〕根拠の無い置き値（P3-DC-SOURCES）。
// 書き換えるのは EventID・Serial・ReportDateTime（と TargetDateTime・Control/DateTime）・観測と到達の時刻・区域と観測点の列・
// InfoType と Control/Status（通常へ）だけ。型を置く時刻は shiftTimestamps で全体を動かして決める。
// TargetDateTime を報の時刻に書き換えるのは、TargetDateTime が ReportDateTime と同じ型か製品が読まない型だけ。VXSE51 は発生時刻に使うので書き換えない。

// origin: real は採取物の実電文、sample は筋書きが中身を決める気象庁の公開サンプル、synthetic は合成。receivedTime は telegrams.json の
// 生の文字列（実電文だけ、digest に使う）。unchanged は筋書きが明示した unchanged の reason（P3-DC-ORACLE (5)、例: Observation の無い VTSE51 の noChange）。
type Frame = Readonly<{ atMs: number; headType: string; body: Uint8Array; origin: "real" | "sample" | "synthetic"; source: string;
  receivedTime?: string; unchanged?: "duplicate" | "stale" | "noChange" }>;
type SynthId = "R2" | "R2S" | "N1" | "N2" | "W2" | "R1";
type Context = Readonly<{ t0Ms?: number; real?: readonly Frame[] }>;

const SECOND = 1_000, MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const fixture = (name: string): string => readFileSync(`test/fixtures/${name}.xml`, "utf8");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---- 時刻と head ----

const jst = (ms: number): string => `${new Date(ms + 9 * HOUR).toISOString().slice(0, 19)}+09:00`;
const utc = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const eventIdAt = (ms: number): string => jst(ms).slice(0, 19).replace(/\D/g, "");
const textOf = (xml: string, tag: string): string | null => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? null;

// 型の OriginTime（無ければ ReportDateTime）を at に合わせて、全時刻を同じだけ動かす。
function placed(xml: string, at: number): string {
  const anchor = textOf(xml, "OriginTime") ?? textOf(xml, "ReportDateTime")!;
  return shiftTimestamps(xml, at - Date.parse(anchor));
}

// target: TargetDateTime（既定は報の時刻）。VXSE51 は TargetDateTime を発生時刻に使う（I-U-Q の originTimeRaw）ので、続報でも origin に保つ。
function head(xml: string, at: number, fields: Readonly<{ eventId?: string; serial?: string; infoType?: string; office?: string; target?: number }> = {}): string {
  let out = xml.replace(/<Status>[^<]*<\/Status>/, "<Status>通常</Status>")
    .replace(/<DateTime>[^<]*<\/DateTime>/, `<DateTime>${utc(at)}</DateTime>`)
    .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${jst(at)}</ReportDateTime>`)
    .replace(/<TargetDateTime>[^<]*<\/TargetDateTime>/, `<TargetDateTime>${jst(fields.target ?? at)}</TargetDateTime>`);
  if (fields.eventId != null) out = out.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${fields.eventId}</EventID>`);
  if (fields.serial != null) out = out.replace(/<Serial>[^<]*<\/Serial>/, `<Serial>${fields.serial}</Serial>`);
  if (fields.infoType != null) out = out.replace(/<InfoType>[^<]*<\/InfoType>/, `<InfoType>${fields.infoType}</InfoType>`);
  if (fields.office != null) out = out.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${fields.office}</EditorialOffice>`);
  return out;
}

// 区間 [open, close) の中身を差し替える（型の構造はそのまま、列だけを替える）。
function between(xml: string, open: string, close: string, inner: string, from = 0): string {
  const start = xml.indexOf(open, from);
  const end = xml.indexOf(close, start + open.length);
  if (start < 0 || end < 0) throw new Error(`synth: ${open}…${close} not found`);
  return xml.slice(0, start + open.length) + inner + xml.slice(end);
}

// 種だけで決まる擬似乱数（mulberry32）。
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const FULL: Readonly<Record<string, string>> = { ".": "．", m: "ｍ" };
const fullWidth = (value: string): string => value.replace(/[0-9.m]/g, (c) => FULL[c] ?? String.fromCharCode(c.charCodeAt(0) + 0xfee0));

// 足りない分の code: 型の code と重ならない同じ桁の通し番号。
function codes(used: Set<string>, digits: number) {
  let next = 10 ** (digits - 1);
  return () => {
    while (used.has(String(next))) next++;
    const code = String(next++);
    used.add(code);
    return code;
  };
}

// ---- 地震の観測網（震度観測点 4,361・市町村等 1,894・細分区域 188・都道府県 47〔上界、P3-DC-SOURCES (8)〕） ----

// 地震情報／都道府県等の 47（code は 01〜47、型の 43 熊本県・46 鹿児島県などと同じ並び）。
const PREFS = ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県",
  "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県",
  "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県",
  "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"] as const;
const UPPER = { stations: 4_361, cities: 1_894, areas: 188, prefs: 47, longPeriod: 703 } as const;

type Ref = Readonly<{ name: string; code: string }>;
type Station = Readonly<{ pref: Ref; area: Ref; city: Ref | null; name: string; code: string; int: string; lg?: string; element?: string }>;

const TREE = /<(Pref|Area|City|IntensityStation)>\s*<Name>([^<]*)<\/Name>\s*<Code>([^<]*)<\/Code>(?:\s*<(?:MaxInt|Int)>([^<]*)<\/(?:MaxInt|Int)>)?/g;

// 型の Observation の木を観測点の列に読む（VXSE62 は City が無い）。
function stationsOf(xml: string): Station[] {
  const observation = xml.slice(xml.indexOf("<Observation>"), xml.indexOf("</Observation>"));
  const out: Station[] = [];
  let pref: Ref | null = null, area: Ref | null = null, city: Ref | null = null;
  for (const match of observation.matchAll(TREE)) {
    const [, level, name, code, int] = match;
    if (level === "Pref") { pref = { name, code }; area = null; city = null; }
    else if (level === "Area") { area = { name, code }; city = null; }
    else if (level === "City") city = { name, code };
    else {
      const start = match.index!;
      const element = observation.slice(start, observation.indexOf("</IntensityStation>", start) + "</IntensityStation>".length);
      out.push({ pref: pref!, area: area!, city, name, code, int: int ?? "", element });
    }
  }
  return out;
}

type NetworkStation = Readonly<{ prefIndex: number; area: Ref; city: Ref; name: string; code: string }>;
type LongStation = Readonly<{ prefIndex: number; area: Ref; name: string; code: string }>;
type Network = Readonly<{ stations: readonly NetworkStation[]; longPeriod: readonly LongStation[]; lgElement: string }>;

let networkCache: Network | null = null;
// 型（2026-07-28 M7.1 の VXSE53 第 2 報 1,248 点・VXSE62 57 点）の実在の値を先に使い、足りない分を合成する。
function network(): Network {
  if (networkCache != null) return networkCache;
  const real = stationsOf(fixture("telegram-foundation/phase7_5_VXSE53_20260728162718_bf35e8ea1825"));
  const areas: { ref: Ref; pref: number }[] = [], cities: { ref: Ref; area: number }[] = [];
  const stations: { ref: Ref; city: number }[] = [];
  const areaAt = new Map<string, number>(), cityAt = new Map<string, number>();
  for (const item of real) {
    if (!areaAt.has(item.area.code)) { areaAt.set(item.area.code, areas.length); areas.push({ ref: item.area, pref: Number(item.pref.code) - 1 }); }
    if (!cityAt.has(item.city!.code)) { cityAt.set(item.city!.code, cities.length); cities.push({ ref: item.city!, area: areaAt.get(item.area.code)! }); }
    stations.push({ ref: { name: item.name, code: item.code }, city: cityAt.get(item.city!.code)! });
  }
  const areaCode = codes(new Set(areas.map((item) => item.ref.code)), 3);
  const cityCode = codes(new Set(cities.map((item) => item.ref.code)), 7);
  const stationCode = codes(new Set(stations.map((item) => item.ref.code)), 7);
  // 親は、まだ子の無い親を先に埋め、その後は順に回す（どの県・区域・市町村にも 1 つ以上ある木になる）。
  const parent = (counts: number[], k: number) => { const empty = counts.findIndex((count) => count === 0); return empty >= 0 ? empty : k % counts.length; };
  const areaNames = areas.map((item) => item.ref.name), cityNames = cities.map((item) => item.ref.name), stationNames = stations.map((item) => item.ref.name);
  const prefCount = PREFS.map((_, index) => areas.filter((item) => item.pref === index).length);
  for (let k = 0; areas.length < UPPER.areas; k++) {
    const pref = parent(prefCount, k);
    prefCount[pref]++;
    areas.push({ ref: { name: `${areaNames[k % areaNames.length]}${k + 1}`, code: areaCode() }, pref });
  }
  const areaCount = areas.map((_, index) => cities.filter((item) => item.area === index).length);
  for (let k = 0; cities.length < UPPER.cities; k++) {
    const area = parent(areaCount, k);
    areaCount[area]++;
    cities.push({ ref: { name: `${cityNames[k % cityNames.length]}${k + 1}`, code: cityCode() }, area });
  }
  const cityCount = cities.map((_, index) => stations.filter((item) => item.city === index).length);
  for (let k = 0; stations.length < UPPER.stations; k++) {
    const city = parent(cityCount, k);
    cityCount[city]++;
    stations.push({ ref: { name: `${stationNames[k % stationNames.length]}${k + 1}`, code: stationCode() }, city });
  }
  const all = stations.map((item): NetworkStation => {
    const city = cities[item.city], area = areas[city.area];
    return { prefIndex: area.pref, area: area.ref, city: city.ref, name: item.ref.name, code: item.ref.code };
  });
  // 長周期地震動観測点 703〔上界〕: 型の 57 点の後に、細分区域を順に回して足す。
  const longTemplate = stationsOf(fixture("telegram-foundation/phase7_5_VXSE62_20260728162718_f9786edc27df"));
  const longCode = codes(new Set(longTemplate.map((item) => item.code)), 7);
  const longPeriod: LongStation[] = longTemplate.map((item) => ({ prefIndex: Number(item.pref.code) - 1, area: item.area, name: item.name, code: item.code }));
  for (let k = 0; longPeriod.length < UPPER.longPeriod; k++) {
    const area = areas[k % areas.length];
    longPeriod.push({ prefIndex: area.pref, area: area.ref, name: `${longTemplate[k % longTemplate.length].name}${k + 1}`, code: longCode() });
  }
  networkCache = { stations: all, longPeriod, lgElement: longTemplate[0].element! };
  return networkCache;
}

// ---- 震度の帯（県ごと。P3-DC-SYNTH の本震の地震） ----

type Band = 0 | 1 | 2;
// N1 の震度 7 の 10 県〔公式、P3-DC-SOURCES (1) p.32〕と、6 弱〜5 弱の県〔推測〕。
const STRONG = ["静岡県", "愛知県", "三重県", "兵庫県", "和歌山県", "徳島県", "香川県", "愛媛県", "高知県", "宮崎県"];
const MIDDLE = ["神奈川県", "山梨県", "長野県", "岐阜県", "滋賀県", "京都府", "大阪府", "奈良県", "岡山県", "広島県", "山口県", "福岡県",
  "大分県", "熊本県", "鹿児島県"];
// N2 の側ごとの震度 7 の県〔推測〕。もう一方の側の県は 6 弱〜5 弱の帯に下げ、ほかは N1 と同じ帯。
// 下げるのは、半割れでは割れていない側の県は震源域から遠く、全割れの震度 7 を置くと全割れと同じ揺れの広がりになるため〔推測〕。
const EAST_STRONG = ["静岡県", "愛知県", "三重県"];
const WEST_STRONG = ["兵庫県", "和歌山県", "徳島県", "香川県", "愛媛県", "高知県", "宮崎県"];
type Side = "whole" | "east" | "west";
function bandOf(prefIndex: number, side: Side): Band {
  const name = PREFS[prefIndex];
  const strong = side === "whole" ? STRONG : side === "east" ? EAST_STRONG : WEST_STRONG;
  if (strong.includes(name)) return 0;
  return STRONG.includes(name) || MIDDLE.includes(name) ? 1 : 2;
}
const INT_CYCLE: Readonly<Record<Band, readonly string[]>> = { 0: ["7", "6+", "6-"], 1: ["6-", "5+", "5-"], 2: ["4", "3", "2", "1"] };
const LG_CYCLE: Readonly<Record<Band, readonly string[]>> = { 0: ["4", "3"], 1: ["2", "1"], 2: ["1", "0"] };
const RANK = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];
const rank = (value: string): number => RANK.indexOf(value);
const higher = (left: string, right: string): string => rank(right) > rank(left) ? right : left;
const LABEL: Readonly<Record<string, string>> = { "7": "震度７", "6+": "震度６強", "6-": "震度６弱", "5+": "震度５強", "5-": "震度５弱", "4": "震度４", "3": "震度３" };

// 帯の中の並びの始まりを県ごとに種で決める（同じ種なら同じ bytes、種を変えると値の並びが変わる）。
function intensities(side: Side, seed: number): Readonly<{ ordered: readonly Station[]; areaMax: ReadonlyMap<string, string> }> {
  const net = network();
  const next = random(seed);
  const offset = PREFS.map(() => Math.floor(next() * 12));
  const counter = PREFS.map(() => 0);
  const stations = net.stations.map((item, index) => {
    const band = bandOf(item.prefIndex, side);
    const cycle = INT_CYCLE[band];
    return { index, band, station: { pref: { name: PREFS[item.prefIndex], code: String(item.prefIndex + 1).padStart(2, "0") },
      area: item.area, city: item.city, name: item.name, code: item.code, int: cycle[(counter[item.prefIndex]++ + offset[item.prefIndex]) % cycle.length] } };
  });
  // 報が観測点を増やす順: 強い帯の県から（同じ帯は観測網の順）。
  const ordered = stations.sort((a, b) => a.band - b.band || a.index - b.index).map((item) => item.station);
  const areaMax = new Map<string, string>();
  for (const item of ordered) areaMax.set(item.area.code, higher(areaMax.get(item.area.code) ?? "0", item.int));
  return { ordered, areaMax };
}

type Grouped = { ref: Ref; max: string; lg: string; children: Grouped[]; stations: Station[] };
function group(stations: readonly Station[], withCity: boolean): Grouped[] {
  const prefs: Grouped[] = [];
  const at = new Map<string, Grouped>();
  const node = (key: string, ref: Ref, into: Grouped[]) => {
    let found = at.get(key);
    if (found == null) { found = { ref, max: "0", lg: "0", children: [], stations: [] }; at.set(key, found); into.push(found); }
    return found;
  };
  for (const item of stations) {
    const pref = node(`p${item.pref.code}`, item.pref, prefs);
    const area = node(`a${item.area.code}`, item.area, pref.children);
    const leaf = withCity ? node(`c${item.city!.code}`, item.city!, area.children) : area;
    leaf.stations.push(item);
    for (const target of withCity ? [pref, area, leaf] : [pref, area]) {
      target.max = higher(target.max, item.int);
      if (item.lg != null && Number(item.lg) > Number(target.lg)) target.lg = item.lg;
    }
  }
  return prefs;
}
const maxOf = (nodes: readonly Grouped[]) => nodes.reduce((max, item) => higher(max, item.max), "0");

// VXSE53 の Observation（Pref → Area → City → IntensityStation）。
function cityTree(prefs: readonly Grouped[]): string {
  const lines: string[] = [];
  for (const pref of prefs) {
    lines.push(`<Pref><Name>${pref.ref.name}</Name><Code>${pref.ref.code}</Code><MaxInt>${pref.max}</MaxInt>`);
    for (const area of pref.children) {
      lines.push(`<Area><Name>${area.ref.name}</Name><Code>${area.ref.code}</Code><MaxInt>${area.max}</MaxInt>`);
      for (const city of area.children) {
        lines.push(`<City><Name>${city.ref.name}</Name><Code>${city.ref.code}</Code><MaxInt>${city.max}</MaxInt>`);
        for (const item of city.stations) lines.push(`<IntensityStation><Name>${item.name}</Name><Code>${item.code}</Code><Int>${item.int}</Int></IntensityStation>`);
        lines.push("</City>");
      }
      lines.push("</Area>");
    }
    lines.push("</Pref>");
  }
  return lines.join("\n");
}

// Headline の震度 3 以上の区域・市町村の列（Kind ごとの Item）。
function headlineItems(entries: readonly Readonly<{ ref: Ref; max: string }>[], codeType: string): string {
  const items: string[] = [];
  for (const level of ["7", "6+", "6-", "5+", "5-", "4", "3"]) {
    const hit = entries.filter((item) => item.max === level);
    if (hit.length === 0) continue;
    items.push(`<Item>\n<Kind><Name>${LABEL[level]}</Name></Kind>\n<Areas codeType="${codeType}">\n${hit.map((item) =>
      `<Area><Name>${item.ref.name}</Name><Code>${item.ref.code}</Code></Area>`).join("\n")}\n</Areas>\n</Item>`);
  }
  return items.join("\n");
}

function withObservation(xml: string, inner: string): string {
  return between(xml, "</CodeDefine>", "</Observation>", `\n${inner}\n`);
}

// VXSE53: 観測点の列を差し替え、Headline の区域・市町村の列も作り直す。
function quake53(template: string, stations: readonly Station[]): string {
  const prefs = group(stations, true);
  const areas = prefs.flatMap((pref) => pref.children);
  const cities = areas.flatMap((area) => area.children);
  let xml = withObservation(template, `<MaxInt>${maxOf(prefs)}</MaxInt>\n${cityTree(prefs)}`);
  const info = (type: string, codeType: string, entries: readonly Grouped[]) =>
    `<Information type="${type}">\n${headlineItems(entries, codeType)}\n</Information>`;
  if (xml.includes("<Information type=")) xml = between(xml, "</Text>", "</Headline>", `\n${info("震源・震度に関する情報（細分区域）", "地震情報／細分区域", areas)}\n`
    + `${info("震源・震度に関する情報（市町村等）", "気象・地震・火山情報／市町村等", cities)}\n`);
  return xml;
}

// VXSE51: Pref → Area の MaxInt だけ。
function quake51(template: string, areas: readonly Readonly<{ pref: Ref; area: Ref; max: string }>[]): string {
  const prefs: Grouped[] = [];
  const at = new Map<string, Grouped>();
  for (const item of areas) {
    let pref = at.get(item.pref.code);
    if (pref == null) { pref = { ref: item.pref, max: "0", lg: "0", children: [], stations: [] }; at.set(item.pref.code, pref); prefs.push(pref); }
    pref.max = higher(pref.max, item.max);
    pref.children.push({ ref: item.area, max: item.max, lg: "0", children: [], stations: [] });
  }
  const tree = prefs.map((pref) => `<Pref>\n<Name>${pref.ref.name}</Name><Code>${pref.ref.code}</Code><MaxInt>${pref.max}</MaxInt>\n${pref.children.map((area) =>
    `<Area><Name>${area.ref.name}</Name><Code>${area.ref.code}</Code><MaxInt>${area.max}</MaxInt></Area>`).join("\n")}\n</Pref>`).join("\n");
  const xml = withObservation(template, `<MaxInt>${maxOf(prefs)}</MaxInt>\n${tree}`);
  return between(xml, "</Text>", "</Headline>", `\n<Information type="震度速報">\n${headlineItems(prefs.flatMap((pref) => pref.children), "地震情報／細分区域")}\n</Information>\n`);
}

// VXSE62: Pref → Area → IntensityStation（型の観測点の要素の Name・Code・Int・LgInt だけを替える）。
function quake62(template: string, stations: readonly Station[]): string {
  const prefs = group(stations, false);
  const element = network().lgElement;
  const station = (item: Station) => element.replace(/<Name>[^<]*<\/Name>/, `<Name>${item.name}</Name>`)
    .replace(/<Code>[^<]*<\/Code>/, `<Code>${item.code}</Code>`).replace(/<Int>[^<]*<\/Int>/, `<Int>${item.int}</Int>`)
    .replace(/<LgInt>[^<]*<\/LgInt>/, `<LgInt>${item.lg}</LgInt>`);
  const tree = prefs.map((pref) => `<Pref>\n<Name>${pref.ref.name}</Name>\n<Code>${pref.ref.code}</Code>\n<MaxInt>${pref.max}</MaxInt>\n<MaxLgInt>${pref.lg}</MaxLgInt>\n${
    pref.children.map((area) => `<Area>\n<Name>${area.ref.name}</Name>\n<Code>${area.ref.code}</Code>\n<MaxInt>${area.max}</MaxInt>\n<MaxLgInt>${area.lg}</MaxLgInt>\n${
      area.stations.map(station).join("\n")}\n</Area>`).join("\n")}\n</Pref>`).join("\n");
  const lg = prefs.reduce((max, item) => Math.max(max, Number(item.lg)), 0);
  const category = textOf(template, "LgCategory") ?? "1";
  return withObservation(template, `<MaxInt>${maxOf(prefs)}</MaxInt>\n<MaxLgInt>${lg}</MaxLgInt>\n<LgCategory>${category}</LgCategory>\n${tree}`);
}

function longPeriodStations(count: number, side: Side, seed: number): Station[] {
  const net = network();
  const next = random(seed + 1);
  const list = net.longPeriod.map((item, index) => ({ index, band: bandOf(item.prefIndex, side), item }))
    .sort((a, b) => a.band - b.band || a.index - b.index).slice(0, count);
  return list.map(({ band, item }) => ({ pref: { name: PREFS[item.prefIndex], code: String(item.prefIndex + 1).padStart(2, "0") }, area: item.area,
    city: null, name: item.name, code: item.code, int: INT_CYCLE[band][Math.floor(next() * INT_CYCLE[band].length)],
    lg: LG_CYCLE[band][Math.floor(next() * LG_CYCLE[band].length)] }));
}

// ---- 津波予報区 66〔上界〕（32-39_12_02 の区域と、都県の対応。東京湾内湾・瀬戸内などの県境は主な都県に寄せた） ----

type Coast = Readonly<{ code: string; name: string; pref: string }>;
const COASTS: readonly Coast[] = [
  ["300", "茨城県", "茨城"], ["310", "千葉県九十九里・外房", "千葉"], ["311", "千葉県内房", "千葉"], ["320", "伊豆諸島", "東京"],
  ["321", "小笠原諸島", "東京"], ["330", "相模湾・三浦半島", "神奈川"], ["380", "静岡県", "静岡"], ["390", "愛知県外海", "愛知"],
  ["391", "伊勢・三河湾", "愛知"], ["400", "三重県南部", "三重"], ["510", "大阪府", "大阪"], ["521", "兵庫県瀬戸内海沿岸", "兵庫"],
  ["522", "淡路島南部", "兵庫"], ["530", "和歌山県", "和歌山"], ["580", "徳島県", "徳島"], ["590", "香川県", "香川"],
  ["600", "愛媛県宇和海沿岸", "愛媛"], ["601", "愛媛県瀬戸内海沿岸", "愛媛"], ["610", "高知県", "高知"], ["701", "山口県瀬戸内海沿岸", "山口"],
  ["750", "大分県瀬戸内海沿岸", "大分"], ["751", "大分県豊後水道沿岸", "大分"], ["760", "宮崎県", "宮崎"], ["770", "鹿児島県東部", "鹿児島"],
  ["771", "種子島・屋久島地方", "鹿児島"], ["772", "奄美群島・トカラ列島", "鹿児島"], ["773", "鹿児島県西部", "鹿児島"], ["800", "沖縄本島地方", "沖縄"],
  ["801", "大東島地方", "沖縄"], ["100", "北海道太平洋沿岸東部", "北海道"], ["101", "北海道太平洋沿岸中部", "北海道"], ["102", "北海道太平洋沿岸西部", "北海道"],
  ["201", "青森県太平洋沿岸", "青森"], ["210", "岩手県", "岩手"], ["220", "宮城県", "宮城"], ["250", "福島県", "福島"],
  ["312", "東京湾内湾", "東京湾"], ["560", "岡山県", "岡山"], ["570", "広島県", "広島"], ["710", "福岡県瀬戸内海沿岸", "福岡"],
  ["712", "有明・八代海", "熊本"], ["730", "長崎県西方", "長崎"], ["740", "熊本県天草灘沿岸", "熊本"], ["802", "宮古島・八重山地方", "沖縄"],
  ["110", "北海道日本海沿岸北部", "北海道"], ["111", "北海道日本海沿岸南部", "北海道"], ["120", "オホーツク海沿岸", "北海道"], ["200", "青森県日本海沿岸", "青森"],
  ["202", "陸奥湾", "青森"], ["230", "秋田県", "秋田"], ["240", "山形県", "山形"], ["340", "新潟県上中下越", "新潟"],
  ["341", "佐渡", "新潟"], ["350", "富山県", "富山"], ["360", "石川県能登", "石川"], ["361", "石川県加賀", "石川"],
  ["370", "福井県", "福井"], ["500", "京都府", "京都"], ["520", "兵庫県北部", "兵庫"], ["540", "鳥取県", "鳥取"],
  ["550", "島根県出雲・石見", "島根"], ["551", "隠岐", "島根"], ["700", "山口県日本海沿岸", "山口"], ["711", "福岡県日本海沿岸", "福岡"],
  ["720", "佐賀県北部", "佐賀"], ["731", "壱岐・対馬", "長崎"],
].map(([code, name, pref]) => ({ code, name, pref }));
// 平均 5 m 以上の 13 都県〔公式、P3-DC-SOURCES (1) p.14 のケース①〕。東西は紀伊半島沖を境にした側〔推測〕。
const EAST_COAST = ["千葉", "東京", "神奈川", "静岡", "愛知", "三重"];
const WEST_COAST = ["和歌山", "徳島", "愛媛", "高知", "大分", "宮崎", "鹿児島"];

type Grade = "major" | "warning" | "advisory" | "forecast" | "released";
const KIND: Readonly<Record<string, Grade>> = { "52": "major", "53": "major", "51": "warning", "62": "advisory", "71": "forecast", "72": "forecast", "73": "forecast", "50": "released" };
const LOWER: Readonly<Record<Grade, Grade>> = { major: "warning", warning: "advisory", advisory: "released", forecast: "released", released: "released" };

let gradeItems: Readonly<Record<Grade, string>> | null = null;
// 区分ごとの Item の形（32-39_12_02 の大津波警報：発表・津波警報・津波注意報、32-39_11_11 の津波予報）。解除は Kind だけの形。
function itemOf(grade: Grade): string {
  if (gradeItems == null) {
    const pick = (xml: string, code: string) => new RegExp(`<Item>(?:(?!</Item>)[\\s\\S])*?<Kind><Name>[^<]*</Name><Code>${code}</Code>[\\s\\S]*?</Item>`)
      .exec(xml.slice(xml.indexOf("<Body")))![0];
    const base = fixture("32-39_12_02_250206_VTSE41"), sample = fixture("32-39_11_11_250206_VTSE41");
    gradeItems = { major: pick(base, "53"), warning: pick(base, "51"), advisory: pick(base, "62"), forecast: pick(sample, "71"),
      released: "<Item>\n<Area><Name></Name><Code></Code></Area>\n<Category>\n<Kind><Name>津波注意報解除</Name><Code>50</Code></Kind>\n</Category>\n</Item>" };
  }
  return gradeItems[grade];
}

type Forecast = Readonly<{ coast: Coast; grade: Grade; arrivalMs: number }>;
function forecastItems(rows: readonly Forecast[]): string {
  return rows.map(({ coast, grade, arrivalMs }) => itemOf(grade).replace(/<Area><Name>[^<]*<\/Name><Code>[^<]*<\/Code><\/Area>/,
    `<Area><Name>${coast.name}</Name><Code>${coast.code}</Code></Area>`).replace(/<ArrivalTime>[^<]*<\/ArrivalTime>/, `<ArrivalTime>${jst(arrivalMs)}</ArrivalTime>`)).join("\n");
}
function tsunami41(template: string, at: number, eventId: string, rows: readonly Forecast[], origin: number | null): string {
  const xml = head(origin == null ? template : placed(template, origin), at, { eventId });
  const body = xml.indexOf("<Body");
  return xml.slice(0, body) + between(xml.slice(body), "</CodeDefine>", "</Forecast>", `\n${forecastItems(rows)}\n`);
}

// 観測点（VTSE51 は沿岸 191、VTSE52 は沖合 420〔上界、P3-DC-SOURCES (8)〕）。型の実在の観測点を先に使う。
type Gauge = Readonly<{ coast: Coast; name: string; code: string }>;
function gauges(template: string, count: number, offset: number): Gauge[] {
  const real = [...template.slice(template.indexOf("<Observation>"), template.indexOf("</Observation>")).matchAll(/<Station><Name>([^<]*)<\/Name><Code>([^<]*)<\/Code>/g)]
    .map(([, name, code], index) => ({ coast: COASTS[index % COASTS.length], name, code }));
  const next = codes(new Set(real.map((item) => item.code)), 5);
  const out: Gauge[] = real.slice(0, count);
  for (let k = 0; out.length < count; k++)
    out.push({ coast: COASTS[(k + offset) % COASTS.length], name: `${real[k % real.length].name}${k + 1}`, code: next() });
  return out;
}

// 観測の高さ: 区分の公式の基準の範囲〔公式、P3-DC-SOURCES (11)〕。大津波警報の区域は 3 時間で想定の 10 m〔公式、p.13〕まで上げる。
function heightOf(grade: Grade, sinceMs: number): number {
  const rise = Math.min(1, Math.max(0, sinceMs) / (3 * HOUR));
  return grade === "major" ? 3.1 + 6.9 * rise : grade === "warning" ? 1.1 + 1.9 * rise : 0.2 + 0.8 * rise;
}
function gaugeElement(gauge: Gauge, grade: Grade, at: number, origin: number, sensor: boolean): string {
  const value = heightOf(grade, at - origin).toFixed(1);
  return `<Station><Name>${gauge.name}</Name><Code>${gauge.code}</Code>${sensor ? "\n<Sensor>ＧＰＳ波浪計</Sensor>" : ""}
<FirstHeight>\n<ArrivalTime>${jst(Math.min(at, origin + 10 * MINUTE))}</ArrivalTime>\n<Initial>押し</Initial>\n</FirstHeight>
<MaxHeight>\n<DateTime>${jst(at - MINUTE)}</DateTime>\n<Condition>重要</Condition>
<jmx_eb:TsunamiHeight type="これまでの最大波の高さ" unit="m" description="${fullWidth(`${value}m`)}">${value}</jmx_eb:TsunamiHeight>\n</MaxHeight>\n</Station>`;
}
function tsunami51(origin: number, at: number, eventId: string, serial: number, list: readonly Gauge[], grades: ReadonlyMap<string, Grade>): string {
  const xml = head(placed(fixture("32-39_11_10_250206_VTSE51"), origin), at, { eventId, serial: String(serial) });
  const items = new Map<string, string[]>();
  for (const gauge of list) {
    const lines = items.get(gauge.coast.code) ?? [];
    lines.push(gaugeElement(gauge, grades.get(gauge.coast.code) ?? "advisory", at, origin, false));
    items.set(gauge.coast.code, lines);
  }
  const inner = [...items].map(([code, lines]) => {
    const coast = COASTS.find((item) => item.code === code)!;
    return `<Item>\n<Area><Name>${coast.name}</Name><Code>${coast.code}</Code></Area>\n${lines.join("\n")}\n</Item>`;
  }).join("\n");
  return between(xml, "</CodeDefine>", "</Observation>", `\n${inner}\n`, xml.indexOf("<Observation>"));
}
function tsunami52(origin: number, at: number, eventId: string, serial: number, list: readonly Gauge[], grades: ReadonlyMap<string, Grade>): string {
  const xml = head(placed(fixture("61_11_02_250206_VTSE52"), origin), at, { eventId, serial: String(serial) });
  const inner = `<Item>\n<Area><Name></Name><Code></Code></Area>\n${list.map((gauge) =>
    gaugeElement(gauge, grades.get(gauge.coast.code) ?? "advisory", at, origin, true)).join("\n")}\n</Item>`;
  return between(xml, "</CodeDefine>", "</Observation>", `\n${inner}\n`, xml.indexOf("<Observation>"));
}

// ---- 緊急地震速報（型は 77_01_26・77_01_01・37_01_01 だけ） ----

type EewArea = Readonly<{ pref: Ref; area: Ref; int: string }>;
let eewAreasCache: readonly Readonly<{ pref: Ref; area: Ref; prefIndex: number }>[] | null = null;
// 予想震度の区域 188〔上界〕: 77_01_26 の府県予報区・細分区域を先に、観測網の細分区域を後に足す（府県予報区の code は 9000＋県 code×10）。
function eewAreas(): readonly Readonly<{ pref: Ref; area: Ref; prefIndex: number }>[] {
  if (eewAreasCache != null) return eewAreasCache;
  const template = fixture("77_01_26_240613_VXSE45");
  const body = template.slice(template.indexOf("<Body"));
  const out: { pref: Ref; area: Ref; prefIndex: number }[] = [];
  const used = new Set<string>();
  for (const [, prefName, prefCode, areaName, areaCode] of body.matchAll(/<Pref><Name>([^<]*)<\/Name><Code>([^<]*)<\/Code><Area><Name>([^<]*)<\/Name><Code>([^<]*)<\/Code>/g)) {
    if (used.has(areaCode)) continue;
    used.add(areaCode);
    out.push({ pref: { name: prefName, code: prefCode }, area: { name: areaName, code: areaCode }, prefIndex: PREFS.findIndex((name) => name.startsWith(prefName)) });
  }
  for (const item of network().stations) {
    if (used.has(item.area.code)) continue;
    used.add(item.area.code);
    const short = PREFS[item.prefIndex].replace(/[都府県]$/, "");
    out.push({ pref: { name: short, code: String(9000 + (item.prefIndex + 1) * 10) }, area: item.area, prefIndex: item.prefIndex });
  }
  eewAreasCache = out.slice(0, UPPER.areas);
  return eewAreasCache;
}
const EEW_INT: Readonly<Record<Band, string>> = { 0: "6+", 1: "5-", 2: "4" };
function eewAreaList(count: number, side: Side): EewArea[] {
  const list = eewAreas().map((item, index) => ({ index, band: item.prefIndex < 0 ? 2 : bandOf(item.prefIndex, side), item }))
    .sort((a, b) => a.band - b.band || a.index - b.index).slice(0, count);
  return list.map(({ band, item }) => ({ pref: item.pref, area: item.area, int: EEW_INT[band] }));
}
function eewBody(template: string, at: number, origin: number, eventId: string, serial: number, areas: readonly EewArea[] | null, warning: boolean): string {
  let xml = head(placed(template, origin), at, { eventId, serial: String(serial) });
  if (areas == null) return xml;
  const kind = warning ? "<Kind><Name>緊急地震速報（警報）</Name><Code>10</Code></Kind>" : "<Kind><Name>緊急地震速報（予報）</Name><Code>19</Code></Kind>";
  const blocks = areas.map((item, index) => `<Pref><Name>${item.pref.name}</Name><Code>${item.pref.code}</Code><Area><Name>${item.area.name}</Name><Code>${item.area.code}</Code><Category>${kind}</Category><ForecastInt><From>${item.int}</From><To>${item.int}</To></ForecastInt><ForecastLgInt><From>0</From><To>0</To></ForecastLgInt><ArrivalTime>${jst(origin + 10 * SECOND + 2 * SECOND * index)}</ArrivalTime></Area></Pref>`);
  const body = xml.indexOf("<Body");
  const first = xml.indexOf("<Pref>", body), last = xml.lastIndexOf("</Pref>") + "</Pref>".length;
  xml = xml.slice(0, first) + blocks.join("") + xml.slice(last);
  const max = areas.reduce((value, item) => higher(value, item.int), "0");
  return xml.slice(0, body) + xml.slice(body).replace(/<ForecastInt><From>[^<]*<\/From><To>[^<]*<\/To><\/ForecastInt>/, `<ForecastInt><From>${max}</From><To>${max}</To></ForecastInt>`);
}

// ---- 組み立て ----

class Out {
  readonly frames: Frame[] = [];
  private readonly eventIds = new Set<string>();
  put(atMs: number, headType: string, xml: string, source: string): void {
    this.frames.push({ atMs, headType, body: encoder.encode(xml), origin: "synthetic", source });
  }
  // EventID は発生時刻の 14 桁。同じ秒の別の地震は 1 秒ずらす。
  eventId(originMs: number): Readonly<{ id: string; originMs: number }> {
    let at = originMs;
    while (this.eventIds.has(eventIdAt(at))) at += SECOND;
    this.eventIds.add(eventIdAt(at));
    return { id: eventIdAt(at), originMs: at };
  }
}

const M71 = "telegram-foundation/phase7_5_VXSE5";
const T53 = `${M71}3_20260728162718_bf35e8ea1825`, T51 = `${M71}1_20260728162718_059a2b392646`;
const T61 = "telegram-foundation/phase7_5_VXSE61_20260728162718_d7e630bbb653", T62 = "telegram-foundation/phase7_5_VXSE62_20260728162718_f9786edc27df";

// 本震の地震・EEW・津波（P3-DC-SYNTH の本震の地震・本震の EEW・津波）。
function mainShock(out: Out, origin: number, eventId: string, side: Side, seed: number): void {
  const { ordered, areaMax } = intensities(side, seed);
  const quake = (minutes: number, count: number, serial: number) => out.put(origin + minutes * MINUTE, "VXSE53",
    quake53(head(placed(fixture(T53), origin), origin + minutes * MINUTE, { eventId, serial: String(serial) }), ordered.slice(0, count)), "synth:VXSE53");
  // VXSE51 は t0＋4 分〔実例〕に細分区域 150〔推測〕。
  const seen = new Set<string>();
  const areas51: { pref: Ref; area: Ref; max: string }[] = [];
  for (const item of ordered) if (!seen.has(item.area.code) && areas51.length < 150) { seen.add(item.area.code); areas51.push({ pref: item.pref, area: item.area, max: areaMax.get(item.area.code)! }); }
  out.put(origin + 4 * MINUTE, "VXSE51", quake51(head(placed(fixture(T51), origin), origin + 4 * MINUTE, { eventId, target: origin }), areas51), "synth:VXSE51");
  // VXSE53 は＋4 分〔実例〕に 2,000〔推測〕・＋8 分〔実例〕に 3,500〔推測〕・＋20 分〔推測〕に 4,361〔上界〕。
  quake(4, 2_000, 1);
  quake(8, 3_500, 2);
  quake(20, UPPER.stations, 3);
  // VXSE62 は＋10 分〔実例〕に 400〔推測〕・＋30 分〔推測〕に 703〔上界〕。VXSE61 は＋4 時間〔実例〕。
  for (const [minutes, count, serial] of [[10, 400, 1], [30, UPPER.longPeriod, 2]] as const)
    out.put(origin + minutes * MINUTE, "VXSE62", quake62(head(placed(fixture(T62), origin), origin + minutes * MINUTE, { eventId, serial: String(serial) }),
      longPeriodStations(count, side, seed)), "synth:VXSE62");
  out.put(origin + 4 * HOUR, "VXSE61", head(placed(fixture(T61), origin), origin + 4 * HOUR, { eventId }), "synth:VXSE61");
  // EEW: VXSE45 の 45 報を＋8 秒から 4 秒ごと〔推測〕、予想震度の区域は 20 から 20 報目に 188〔上界〕。VXSE43 は 1・5・10 報目〔推測〕。
  for (let report = 1; report <= 45; report++) {
    const at = origin + 8 * SECOND + (report - 1) * 4 * SECOND;
    const areas = eewAreaList(report >= 20 ? UPPER.areas : 20 + Math.round(((UPPER.areas - 20) * (report - 1)) / 19), side);
    if (report === 1 || report === 5 || report === 10)
      out.put(at, "VXSE43", eewBody(fixture("37_01_01_240613_VXSE43"), at, origin, eventId, report, areas, true), "synth:VXSE43");
    out.put(at, "VXSE45", eewBody(fixture("77_01_26_240613_VXSE45"), at, origin, eventId, report, areas, false), "synth:VXSE45");
  }
  tsunamiSequence(out, origin, eventId, side);
}

// 津波: VTSE41 は 66 予報区〔上界〕、13 都県〔公式〕を大津波警報へ。報は＋3 分〔公式〕・15 分・30 分・1 時間・3 時間・6 時間・12 時間・
// 24 時間・36 時間（引き下げ）・48 時間（全解除）〔推測〕。到達は駿河湾＋3 分・高知＋20 分・伊勢湾と大阪湾＋60 分〔公式〕、ほかは＋30〜120 分〔推測〕。
function tsunamiSequence(out: Out, origin: number, eventId: string, side: Side): void {
  const base = new Map<string, Grade>();
  const template = fixture("32-39_12_02_250206_VTSE41");
  for (const [, code, kind] of template.slice(template.indexOf("<Body")).matchAll(/<Code>(\d{3})<\/Code><\/Area>\s*<Category>\s*<Kind><Name>[^<]*<\/Name><Code>(\d+)<\/Code>/g))
    base.set(code, KIND[kind] ?? "advisory");
  const elevated = side === "whole" ? [...EAST_COAST, ...WEST_COAST] : side === "east" ? EAST_COAST : WEST_COAST;
  const arrival = (coast: Coast, index: number) => coast.code === "380" ? 3 * MINUTE : coast.code === "610" ? 20 * MINUTE
    : coast.code === "391" || coast.code === "510" ? 60 * MINUTE : 30 * MINUTE + ((index * 7) % 91) * MINUTE;
  const rows = COASTS.map((coast, index): Forecast => ({ coast, grade: elevated.includes(coast.pref) ? "major" : base.get(coast.code)!, arrivalMs: origin + arrival(coast, index) }));
  const lowered = rows.map((row) => ({ ...row, grade: LOWER[row.grade] }));
  const released = rows.map((row) => ({ ...row, grade: "released" as const }));
  for (const minutes of [3, 15, 30, 60, 180, 360, 720, 1_440, 2_160, 2_880]) {
    const at = origin + minutes * MINUTE;
    out.put(at, "VTSE41", tsunami41(template, at, eventId, minutes === 2_160 ? lowered : minutes === 2_880 ? released : rows, origin), "synth:VTSE41");
  }
  const grades = new Map(rows.map((row) => [row.coast.code, row.grade]));
  // VTSE51 は＋5 分から 15 分ごとに 12 時間〔推測〕、沿岸の観測点は 3 時間で 191〔上界〕。VTSE52 は＋5 分から 10 分ごとに 6 時間〔推測〕、沖合は 1 時間 30 分で 420〔上界〕。
  const coastal = gauges(fixture("32-39_11_10_250206_VTSE51"), 191, 0);
  for (let serial = 1, at = origin + 5 * MINUTE; at <= origin + 12 * HOUR; serial++, at += 15 * MINUTE)
    out.put(at, "VTSE51", tsunami51(origin, at, eventId, serial, coastal.slice(0, Math.max(1, Math.ceil((191 * (at - origin)) / (3 * HOUR)))), grades), "synth:VTSE51");
  const offshore = gauges(fixture("61_11_02_250206_VTSE52"), 420, 7);
  for (let serial = 1, at = origin + 5 * MINUTE; at <= origin + 6 * HOUR; serial++, at += 10 * MINUTE)
    out.put(at, "VTSE52", tsunami52(origin, at, eventId, serial, offshore.slice(0, Math.max(1, Math.ceil((420 * (at - origin)) / (90 * MINUTE)))), grades), "synth:VTSE52");
}

// 臨時情報（型は 74_01_01 調査中 111・74_01_04 巨大地震警戒 120・74_01_05 巨大地震注意 130・75_01_01 臨時解説 210）。EventID は報の時刻。
const NANKAI = { 111: "selected_xml/74_01_01_200512_VYSE50", 120: "selected_xml/74_01_04_200512_VYSE50", 130: "selected_xml/74_01_05_200512_VYSE50",
  210: "selected_xml/75_01_01_200512_VYSE51" } as const;
function nankai(out: Out, at: number, code: keyof typeof NANKAI): void {
  const headType = code === 210 ? "VYSE51" : "VYSE50";
  out.put(at, headType, head(placed(fixture(NANKAI[code]), at), at, { eventId: eventIdAt(at) }), `synth:${headType}:${code}`);
}

// 余震: 本震ごとに 24 時間で 400 event〔推測〕、大森の形の累積 N(t)=K・ln(1+t/c)（c=0.05 時間、N(24 時間)=400）〔推測〕。
// 20 件ごとに大 1（32-35_01_03 の形）・中 5（32-35_04_04 の形）・小 14（32-35_01_02 の VXSE52 と、32-35_04_04 を観測点 5 に切った VXSE53）〔推測の比〕。
// 中と大の全部と小の 12/14 に EEW（77_01_01 の形、5 報を 2 秒ごと）〔推測〕。報は発生の＋3 分（VXSE52）・＋4 分（VXSE53）〔推測〕。
function aftershocks(out: Out, origin: number): void {
  const c = 0.05 * HOUR, k = 400 / Math.log(1 + DAY / c);
  const small53 = fixture("32-35_04_04_240613_VXSE53");
  const cut = quake53(small53, stationsOf(small53).slice(0, 5));
  for (let index = 1; index <= 400; index++) {
    const event = out.eventId(origin + Math.round((c * (Math.exp(index / k) - 1)) / SECOND) * SECOND);
    const slot = (index - 1) % 20;
    const kind = slot === 0 ? "big" : slot <= 5 ? "middle" : "small";
    const at = (minutes: number) => event.originMs + minutes * MINUTE;
    if (kind === "small") out.put(at(3), "VXSE52", head(placed(fixture("32-35_01_02_240613_VXSE52"), event.originMs), at(3), { eventId: event.id }), "synth:aftershock:VXSE52");
    const template = kind === "big" ? fixture("32-35_01_03_240613_VXSE53") : kind === "middle" ? small53 : cut;
    out.put(at(4), "VXSE53", head(placed(template, event.originMs), at(4), { eventId: event.id }), `synth:aftershock:${kind}`);
    if (kind !== "small" || slot < 18) aftershockEew(out, event.originMs, event.id, 5, false);
  }
}
// wide: 77_01_26 の形（型の区域のまま）、でなければ 77_01_01 の形（区域なし）。
function aftershockEew(out: Out, origin: number, eventId: string, reports: number, wide: boolean): void {
  for (let report = 1; report <= reports; report++) {
    const at = origin + 5 * SECOND + (report - 1) * 2 * SECOND;
    out.put(at, "VXSE45", eewBody(fixture(wide ? "77_01_26_240613_VXSE45" : "77_01_01_240613_VXSE45"), at, origin, eventId, report, null, false), "synth:VXSE45");
  }
}

// M7 級の余震を本震ごとに 2 件（＋40 分・＋9 時間）〔推測〕: 観測点 1,500 の VXSE53、新しい EventID の VTSE41（注意報 5 区域）と VTSE51 4 報（観測点 20）、
// VYSE50 の 111→130〔推測〕。
function largeAftershocks(out: Out, origin: number, side: Side, seed: number): void {
  const { ordered } = intensities(side, seed + 7);
  for (const offset of [40 * MINUTE, 9 * HOUR]) {
    const event = out.eventId(origin + offset);
    const at = (minutes: number) => event.originMs + minutes * MINUTE;
    out.put(at(4), "VXSE53", quake53(head(placed(fixture(T53), event.originMs), at(4), { eventId: event.id, serial: "1" }), ordered.slice(0, 1_500)), "synth:M7:VXSE53");
    const rows = COASTS.slice(0, 5).map((coast): Forecast => ({ coast, grade: "advisory", arrivalMs: event.originMs + 30 * MINUTE }));
    out.put(at(3), "VTSE41", tsunami41(fixture("32-39_12_02_250206_VTSE41"), at(3), event.id, rows, event.originMs), "synth:M7:VTSE41");
    const list = gauges(fixture("32-39_11_10_250206_VTSE51"), 20, 3);
    const grades = new Map(rows.map((row) => [row.coast.code, row.grade]));
    for (let serial = 1; serial <= 4; serial++) out.put(at(10 + 15 * (serial - 1)), "VTSE51", tsunami51(event.originMs, at(10 + 15 * (serial - 1)), event.id, serial, list, grades), "synth:M7:VTSE51");
    nankai(out, at(20), 111);
    nankai(out, at(120), 130);
  }
}

const startOfJstDay = (ms: number) => Math.floor((ms + 9 * HOUR) / DAY) * DAY - 9 * HOUR;

function n1(out: Out, t0: number, seed: number): void {
  const e0 = out.eventId(t0);
  mainShock(out, e0.originMs, e0.id, "whole", seed);
  aftershocks(out, e0.originMs);
  largeAftershocks(out, e0.originMs, "whole", seed);
  // N1: VYSE50 の 111 を t0＋20 分〔推測〕、120 を＋2 時間〔公式、最短約 2 時間〕、VYSE51 を＋6 時間・＋20 時間〔推測〕。
  nankai(out, t0 + 20 * MINUTE, 111);
  nankai(out, t0 + 2 * HOUR, 120);
  nankai(out, t0 + 6 * HOUR, 210);
  nankai(out, t0 + 20 * HOUR, 210);
}

function n2(out: Out, t0: number, seed: number): void {
  const e0 = out.eventId(t0);
  mainShock(out, e0.originMs, e0.id, "east", seed);
  aftershocks(out, e0.originMs);
  largeAftershocks(out, e0.originMs, "east", seed);
  // 後発は t0＋12 時間〔公式、内閣府の参考計算〕。
  const e1 = out.eventId(t0 + 12 * HOUR);
  mainShock(out, e1.originMs, e1.id, "west", seed + 1);
  aftershocks(out, e1.originMs);
  largeAftershocks(out, e1.originMs, "west", seed + 1);
  // N2: 111 を t0＋20 分と＋12 時間 20 分〔推測〕、120 を＋2 時間と＋14 時間〔公式の最短に合わせる〕、VYSE51 を 1〜7 日目の 10:00 と 17:00 に計 14〔推測〕、
  // 報ごとに別の EventID〔上界〕、130 を t0＋7 日〔公式、警戒約 1 週間の後〕。
  nankai(out, t0 + 20 * MINUTE, 111);
  nankai(out, t0 + 12 * HOUR + 20 * MINUTE, 111);
  nankai(out, t0 + 2 * HOUR, 120);
  nankai(out, t0 + 14 * HOUR, 120);
  for (let day = 1; day <= 7; day++) for (const hour of [10, 17]) nankai(out, startOfJstDay(t0) + day * DAY + hour * HOUR, 210);
  nankai(out, t0 + 7 * DAY, 130);
}

// R2（2011-03-11 14:46）: 公開サンプルの VTSE41・VTSE51・VTSE52 と、その後の合成。時刻は P3-DC-SCENARIOS（Q-DC-BASE で原文と照合済み）。
const QUAKE_2011 = Date.parse("2011-03-11T14:46:00+09:00");
const EVENT_2011 = "20110311144640";
function sample(out: Out, name: string, headType: string, unchanged?: Frame["unchanged"]): void {
  const xml = fixture(name);
  out.frames.push({ atMs: Date.parse(textOf(xml, "ReportDateTime")!), headType, body: encoder.encode(xml), origin: "sample", source: `fixture:${name}`, unchanged });
}
function r2(out: Out, small: boolean): void {
  sample(out, "32-39_11_02_250206_VTSE41", "VTSE41");
  sample(out, "32-39_11_09_250206_VTSE41", "VTSE41");
  sample(out, "32-39_11_11_250206_VTSE41", "VTSE41");
  // 32-39_11_03 は Observation の無い報（満潮時刻・到達予想時刻の情報）で、合法に state を変えない（unchanged を明示する）。
  sample(out, "32-39_11_03_250206_VTSE51", "VTSE51", "noChange");
  sample(out, "32-39_11_10_250206_VTSE51", "VTSE51");
  sample(out, "61_11_01_250206_VTSE52", "VTSE52");
  sample(out, "61_11_02_250206_VTSE52", "VTSE52");
  const latest = fixture("32-39_11_11_250206_VTSE41");
  const listed = new Map<string, Forecast>();
  for (const [, name, code, kind, rest] of latest.slice(latest.indexOf("<Body")).matchAll(/<Area><Name>([^<]*)<\/Name><Code>(\d{3})<\/Code><\/Area>\s*<Category>\s*<Kind><Name>[^<]*<\/Name><Code>(\d+)<\/Code>([\s\S]*?)<\/Item>/g)) {
    const arrival = /<ArrivalTime>([^<]*)<\/ArrivalTime>/.exec(rest)?.[1];
    listed.set(code, { coast: COASTS.find((item) => item.code === code) ?? { code, name, pref: "" }, grade: KIND[kind] ?? "advisory",
      arrivalMs: arrival == null ? QUAKE_2011 + 30 * MINUTE : Date.parse(arrival) });
  }
  const put41 = (at: number, rows: readonly Forecast[]) => out.put(at, "VTSE41", tsunami41(latest, at, EVENT_2011, rows, null), "synth:R2:VTSE41");
  if (small) {
    // R2 の小さい版（T02）: 地震の 28 時間後に 32-39_11_11 の区域を全部解除する VTSE41 を 1 通。
    put41(QUAKE_2011 + 28 * HOUR, [...listed.values()].map((row) => ({ ...row, grade: "released" as const })));
    return;
  }
  // 15:30: 北海道太平洋沿岸東部・中部・西部と伊豆諸島を大津波警報へ。3/12 03:20: 全予報区（66）。
  const at1530 = Date.parse("2011-03-11T15:30:00+09:00");
  const raised = new Map(listed);
  for (const code of ["100", "101", "102", "320"]) {
    const coast = COASTS.find((item) => item.code === code)!;
    raised.set(code, { coast, grade: "major", arrivalMs: raised.get(code)?.arrivalMs ?? at1530 + 30 * MINUTE });
  }
  put41(at1530, [...raised.values()]);
  const all = COASTS.map((coast): Forecast => raised.get(coast.code) ?? { coast, grade: "advisory", arrivalMs: Date.parse("2011-03-12T04:00:00+09:00") });
  put41(Date.parse("2011-03-12T03:20:00+09:00"), all);
  // 3/12 20:20 と 3/13 07:30 は時間経過による引き下げ〔推測: 区分を 1 段ずつ下げる〕、3/13 17:58 に全解除。
  const first = all.map((row) => ({ ...row, grade: LOWER[row.grade] }));
  put41(Date.parse("2011-03-12T20:20:00+09:00"), first);
  put41(Date.parse("2011-03-13T07:30:00+09:00"), first.map((row) => ({ ...row, grade: row.grade === "warning" ? "advisory" as const : row.grade })));
  put41(Date.parse("2011-03-13T17:58:00+09:00"), all.map((row) => ({ ...row, grade: "released" as const })));
  const grades = new Map(all.map((row) => [row.coast.code, row.grade]));
  // VTSE51 は 15:21 から 3/12 12:00 まで 20 分ごと、沿岸の観測点を 18:00 までに 191〔上界〕へ増やす〔推測〕。
  // 2 通目は 1 通目の最初の観測点 B を落とす（P3-C5-OBS-MERGE で B が残ることを期待例で見る）。
  const coastal = gauges(fixture("32-39_11_10_250206_VTSE51"), 191, 0);
  // Serial はサンプル（32-39_11_10 が 3）の続き。
  let serial = 4;
  for (let at = Date.parse("2011-03-11T15:21:00+09:00"); at <= Date.parse("2011-03-12T12:00:00+09:00"); at += 20 * MINUTE, serial++) {
    const count = Math.min(191, 5 + Math.ceil((186 * (at - Date.parse("2011-03-11T15:01:00+09:00"))) / (3 * HOUR)));
    const list = coastal.slice(0, count);
    out.put(at, "VTSE51", tsunami51(QUAKE_2011, at, EVENT_2011, serial, serial === 5 ? list.slice(1) : list, grades), "synth:R2:VTSE51");
  }
  // VTSE52 は 15:15 から 3/11 20:00 まで 20 分ごと、沖合の観測点は 15 まで〔推測〕。
  const offshore = gauges(fixture("61_11_02_250206_VTSE52"), 15, 7);
  serial = 3;
  for (let at = Date.parse("2011-03-11T15:15:00+09:00"); at <= Date.parse("2011-03-11T20:00:00+09:00"); at += 20 * MINUTE, serial++)
    out.put(at, "VTSE52", tsunami52(QUAKE_2011, at, EVENT_2011, serial, offshore.slice(0, Math.min(15, 4 + serial - 2)), grades), "synth:R2:VTSE52");
}

// R1 の EEW: 実電文の VXSE51・VXSE53 で最大震度 3 以上の EventID ごとに、77_01_01 の形の VXSE45 を発生時刻＋5 秒から 2 秒ごとに 5 報
// （最大震度 6 弱以上は 77_01_26 の形で 15 報）〔推測〕。EventID は地震の報と同じ。
function r1(out: Out, real: readonly Frame[]): void {
  const events = new Map<string, { originMs: number; max: string }>();
  for (const frame of real) {
    if (frame.headType !== "VXSE51" && frame.headType !== "VXSE53") continue;
    const xml = decoder.decode(frame.body);
    const eventId = textOf(xml, "EventID"), origin = textOf(xml, "OriginTime") ?? textOf(xml, "TargetDateTime");
    const observation = xml.indexOf("<Observation>");
    const max = observation < 0 ? null : textOf(xml.slice(observation), "MaxInt");
    if (textOf(xml, "Status") !== "通常" || eventId == null || origin == null || max == null || rank(max) < 0) continue;
    const known = events.get(eventId);
    events.set(eventId, { originMs: known?.originMs ?? Date.parse(origin), max: higher(known?.max ?? "0", max) });
  }
  for (const [eventId, { originMs, max }] of [...events].sort((a, b) => a[1].originMs - b[1].originMs || (a[0] < b[0] ? -1 : 1))) {
    if (rank(max) < rank("3")) continue;
    aftershockEew(out, originMs, eventId, rank(max) >= rank("6-") ? 15 : 5, rank(max) >= rank("6-"));
  }
}

// W2 の鍵の埋め: 58 官署 × 7 family（VPWW55・57〜61・VPNO50）のうち W1 に出ていない鍵を、family ごとの公開 fixture の
// EditorialOffice を替えた報で、W1 の最後の受信の後から 10 分ごとに 1 つずつ埋める（鍵の空間の上界 406）。
const W2_FAMILIES: Readonly<Record<string, string>> = { VPWW55: "15_17_01_251222_VPWW55", VPWW57: "15_16_02_251222_VPWW57",
  VPWW58: "15_16_04_251222_VPWW58", VPWW59: "15_16_05_241226_VPWW59", VPWW60: "15_16_06_241226_VPWW60",
  VPWW61: "15_16_07_250825_VPWW61", VPNO50: "18_00_01_260830_VPNO50_issue" };
const OFFICE_FAMILIES = ["VPWW55", "VPWW56", "VPWW57", "VPWW58", "VPWW59", "VPWW60", "VPWW61", "VPNO50"];
// W1 の実電文から、官署（VPWW55〜61・VPNO50 の EditorialOffice、出た順）と、出た鍵（family\u0000官署）を読む。
function weatherKeys(real: readonly Frame[]): Readonly<{ offices: readonly string[]; keys: ReadonlySet<string> }> {
  const offices: string[] = [];
  const keys = new Set<string>();
  for (const frame of real) {
    if (!OFFICE_FAMILIES.includes(frame.headType)) continue;
    const xml = decoder.decode(frame.body);
    const office = textOf(xml, "EditorialOffice");
    if (office == null || textOf(xml, "Status") !== "通常") continue;
    if (!offices.includes(office)) offices.push(office);
    if (frame.headType in W2_FAMILIES) keys.add(`${frame.headType}\u0000${office}`);
  }
  return { offices, keys };
}
function w2(out: Out, real: readonly Frame[]): void {
  const { offices, keys } = weatherKeys(real);
  let at = Math.max(...real.map((frame) => frame.atMs)) + 10 * MINUTE;
  for (const office of offices) for (const [family, name] of Object.entries(W2_FAMILIES)) {
    if (keys.has(`${family}\u0000${office}`)) continue;
    out.put(at, family, head(placed(fixture(name), at), at, { office }), `synth:W2:${family}`);
    at += 10 * MINUTE;
  }
}

// 合成器: 筋書きの id と種だけで決まる電文の列（同じ種なら同じ bytes）。N1・N2 は context.t0Ms、W2・R1 は context.real（実電文の列）を使う。
function synthesize(id: SynthId, seed: number, context: Context = {}): Frame[] {
  const out = new Out();
  if (id === "R2" || id === "R2S") r2(out, id === "R2S");
  else if (id === "N1" || id === "N2") {
    if (context.t0Ms == null) throw new Error(`synth ${id} needs t0Ms`);
    (id === "N1" ? n1 : n2)(out, context.t0Ms, seed);
  } else if (id === "W2") w2(out, context.real ?? []);
  else r1(out, context.real ?? []);
  // 同じ時刻は作った順（安定な並べ替え）。
  return out.frames.map((frame, index) => ({ frame, index })).sort((a, b) => a.frame.atMs - b.frame.atMs || a.index - b.index).map((item) => item.frame);
}

export { synthesize };
export type { Frame, SynthId };
