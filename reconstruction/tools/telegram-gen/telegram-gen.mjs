// watch へ注入する電文を作る（P3-REPLAY-WATCH-002 AC07〜AC10）。無いと: ブラウザだけで震源や区域を変えた電文を試せない。
// 骨組みは気象庁の公開サンプル（契約の fixtureIds 13 本）に限り、区域・震央地名のコード表は repo に入れず手元の xlsx から読む（D-CODES）。
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { fixtureText, shiftTimestamps } from "../../test/eew-e01/frames.mjs";

const TEMPLATE = {
  VXSE43: "37_01_01_240613_VXSE43", VXSE45: "77_01_26_240613_VXSE45", VXSE51: "32-35_07_01_100915_VXSE51",
  VXSE52: "32-35_01_02_240613_VXSE52", VXSE53: "32-35_01_03_240613_VXSE53", VTSE41: "32-39_11_09_250206_VTSE41",
  VTSE51: "32-39_11_10_250206_VTSE51", VTSE52: "61_11_02_250206_VTSE52",
};
// D-CANCEL: 公開の取消の型がある 5 種だけ。
const CANCEL = {
  VXSE43: "37_01_03_240613_VXSE43", VXSE45: "77_01_33_240613_VXSE45", VXSE51: "32-35_10_01_220510_VXSE51",
  VTSE41: "38-39_03_01_210805_VTSE41", VTSE51: "38-39_03_03_210805_VTSE51",
};
const FAMILIES = Object.keys(TEMPLATE);
const EEW = new Set(["VXSE43", "VXSE45"]);
const TSUNAMI = new Set(["VTSE41", "VTSE51", "VTSE52"]);
const HAS_SERIAL = new Set(["VXSE43", "VXSE45", "VXSE53", "VTSE51", "VTSE52"]);
const SOURCE = ["placeCode", "lat", "lon", "depthKm", "magnitude"];
const INTENSITIES = ["1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];
const LABEL = { 1: "震度１", 2: "震度２", 3: "震度３", 4: "震度４", "5-": "震度５弱", "5+": "震度５強", "6-": "震度６弱", "6+": "震度６強", 7: "震度７" };
const FINAL_TEXT = "この情報をもって、緊急地震速報：最終報とします。";
const SPACING_MS = 4000;

// ---- 時刻（synth.ts の jst・eventIdAt・textOf・placed・head の写し。synth.ts を変えると災害測定の sourceSha256 が変わる、D-FRAMES） ----
const HOUR = 3_600_000;
const jst = (ms) => `${new Date(ms + 9 * HOUR).toISOString().slice(0, 19)}+09:00`;
const utc = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const eventIdAt = (ms) => jst(ms).slice(0, 19).replace(/\D/g, "");
const textOf = (xml, tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? null;
const placed = (xml, at) => shiftTimestamps(xml, at - Date.parse(textOf(xml, "OriginTime") ?? textOf(xml, "ReportDateTime")));
function head(xml, at, { eventId, serial, target } = {}) {
  let out = xml.replace(/<Status>[^<]*<\/Status>/, "<Status>通常</Status>") // D-STATUS
    .replace(/<DateTime>[^<]*<\/DateTime>/, `<DateTime>${utc(at)}</DateTime>`)
    .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${jst(at)}</ReportDateTime>`)
    .replace(/<TargetDateTime>[^<]*<\/TargetDateTime>/, `<TargetDateTime>${jst(target ?? at)}</TargetDateTime>`);
  if (eventId != null) out = out.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`);
  if (serial != null) out = out.replace(/<Serial>[^<]*<\/Serial>/, `<Serial>${serial}</Serial>`);
  return out;
}

// ---- xlsx の読み取り（D-CODES。依存を足さず node:zlib だけで読む） ----
const unesc = (s) => s.replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (_, name, dec, hex) =>
  name ? { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name.toLowerCase()] : String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16)));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function unzip(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(end + 10);
  if (count === 0xffff || buf.readUInt32LE(end + 16) === 0xffffffff) throw new Error("zip64 is not supported");
  const entries = new Map();
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++, at += 46 + buf.readUInt16LE(at + 28) + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("broken zip directory");
    entries.set(buf.toString("utf8", at + 46, at + 46 + buf.readUInt16LE(at + 28)),
      { flag: buf.readUInt16LE(at + 8), method: buf.readUInt16LE(at + 10), size: buf.readUInt32LE(at + 20), local: buf.readUInt32LE(at + 42) });
  }
  return (name) => {
    const entry = entries.get(name);
    if (entry == null) throw new Error(`zip entry ${name} is missing`);
    // shortcut: zip64・暗号化・deflate と無圧縮の外の圧縮方式は受けない。Excel の保存する xlsx がこれらを使うようになったら足す
    if ((entry.flag & 1) !== 0 || entry.size === 0xffffffff || (entry.method !== 8 && entry.method !== 0)) throw new Error(`zip entry ${name} is not supported`);
    const start = entry.local + 30 + buf.readUInt16LE(entry.local + 26) + buf.readUInt16LE(entry.local + 28);
    const data = buf.subarray(start, start + entry.size);
    return (entry.method === 8 ? inflateRawSync(data) : data).toString("utf8");
  };
}

const attr = (tag, name) => { const m = new RegExp(`(?:^|[\\s:])${name}="([^"]*)"`).exec(tag); return m == null ? null : unesc(m[1]); };

// 4 枚のシートを { 列の文字: 値 }[] で返す。シートは名前で引く（並びの番号では引かない）。
function readSheets(path, names) {
  const read = unzip(readFileSync(path));
  const rels = new Map([...read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => [attr(tag, "Id"), attr(tag, "Target")]));
  const files = new Map([...read("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)].map(([tag]) => [attr(tag, "name"), rels.get(attr(tag, "id"))]));
  // <rPh>（ふりがな）は名前に混ぜない。<r> で分かれた文字列は <t> をつなぐ。
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map(([, body = ""]) =>
    unesc([...body.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)].map(([, t = ""]) => t).join("")));
  return Object.fromEntries(names.map((name) => {
    const target = files.get(name);
    if (target == null) throw new Error(`sheet ${name} is missing`);
    const rows = [];
    for (const [, rowBody] of read(target.startsWith("/") ? target.slice(1) : `xl/${target}`).matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const row = {};
      for (const [, cellAttrs, cellBody = ""] of (rowBody ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const column = /^([A-Z]+)\d+$/.exec(attr(cellAttrs, "r") ?? "")?.[1]; // 空のセルは省かれるので、列は r の文字で合わせる
        const v = /<v>([\s\S]*?)<\/v>/.exec(cellBody)?.[1];
        const t = attr(cellAttrs, "t");
        if (column == null || v == null) continue;
        row[column] = t === "s" ? shared[Number(v)] : unesc(v);
      }
      rows.push(row);
    }
    return [name, rows];
  }));
}

function flatSheet(rows, digits, name) {
  const out = [];
  const seen = new Set();
  for (const { A: code, B: label } of rows) {
    if (code == null || !new RegExp(`^\\d{${digits}}$`).test(code)) continue;
    if (label == null || seen.has(code)) throw new Error(`sheet ${name}: code ${code} is empty or duplicated`);
    seen.add(code);
    out.push({ code, name: label });
  }
  if (out.length === 0) throw new Error(`sheet ${name} has no rows`);
  return out;
}

// シート 24: 1 行が観測点 1 つ。A の細分区域 → D の市町村等 → G の観測点に束ねる。
function areaSheet(rows) {
  const areas = new Map();
  const stations = new Set();
  for (const { A, B, D, E, G, H } of rows) {
    if (A == null || !/^\d{3}$/.test(A)) continue;
    if (B == null || D == null || E == null || G == null || H == null || !/^\d{7}$/.test(D) || !/^\d{7}$/.test(G)) throw new Error(`sheet 24: row of area ${A} lacks a column`);
    let area = areas.get(A);
    if (area == null) areas.set(A, area = { code: A, name: B, cities: new Map() });
    else if (area.name !== B) throw new Error(`sheet 24: area ${A} has two names`);
    let city = area.cities.get(D);
    if (city == null) area.cities.set(D, city = { code: D, name: E, stations: [] });
    else if (city.name !== E) throw new Error(`sheet 24: city ${D} has two names`);
    if (stations.has(G)) throw new Error(`sheet 24: station ${G} is duplicated`);
    stations.add(G);
    city.stations.push({ code: G, name: H });
  }
  if (areas.size === 0) throw new Error("sheet 24 has no rows");
  return [...areas.values()].map((area) => ({ ...area, cities: [...area.cities.values()] }));
}

// ---- 型（公開サンプル）から取る値 ----
const pair = (s) => { const m = /<Name>([^<]*)<\/Name><Code>([^<]*)<\/Code>/.exec(s); return { name: unesc(m[1]), code: m[2] }; };
const flat = (xml) => xml.replace(/>\s+</g, "><");
// 震度の Observation を Pref → Area → City → IntensityStation の値に読む。
function observationAreas(xml) {
  const x = flat(xml);
  const obs = x.slice(x.indexOf("<Observation>"), x.indexOf("</Observation>"));
  return [...obs.matchAll(/<Pref>(.*?)<\/Pref>/g)].flatMap(([, prefBody]) => [...prefBody.matchAll(/<Area>(.*?)<\/Area>/g)].map(([, areaBody]) => ({
    ...pair(areaBody), pref: pair(prefBody),
    cities: [...areaBody.matchAll(/<City>(.*?)<\/City>/g)].map(([, cityBody]) => ({ ...pair(cityBody),
      stations: [...cityBody.matchAll(/<IntensityStation><Name>([^<]*)<\/Name><Code>([^<]*)<\/Code>/g)].map(([, name, code]) => ({ code, name: unesc(name) })) })),
  })));
}
function eewAreas(xml) {
  return [...flat(xml).matchAll(/<Pref><Name>([^<]*)<\/Name><Code>([^<]*)<\/Code><Area><Name>([^<]*)<\/Name><Code>([^<]*)<\/Code>/g)].map(([, prefName, prefCode, name, code]) =>
    ({ code, name: unesc(name), pref: { name: unesc(prefName), code: prefCode }, cities: [] }));
}
const placeOf = (xml) => { const m = /<Hypocenter>\s*<Area>\s*<Name>([^<]*)<\/Name>\s*<Code type="震央地名">([^<]*)<\/Code>/.exec(xml); return m == null ? null : { name: unesc(m[1]), code: m[2] }; };

let loaded = null;
let lastSecond = -Infinity; // 最後に出した報の時刻（秒）。プロセスの中に 1 つだけ持つ
// 型 13 本と（あれば）コード表は最初の呼出しに 1 回だけ読む（P3-RW2-RES-01）。読めなければ Error を投げ、黙って型の範囲へ落とさない。
function load() {
  if (loaded != null) return loaded;
  const xml = Object.fromEntries(Object.entries(TEMPLATE).map(([family, name]) => [family, fixtureText(name).toString("utf8")]));
  const cancel = Object.fromEntries(Object.entries(CANCEL).map(([family, name]) => [family, fixtureText(name).toString("utf8")]));
  const own = Object.fromEntries(FAMILIES.map((family) => [family, placeOf(xml[family])]));
  let places = [...new Map(FAMILIES.filter((family) => own[family] != null).map((family) => [own[family].code, own[family]])).values()];
  let areas = { VXSE43: eewAreas(xml.VXSE45), VXSE45: eewAreas(xml.VXSE45), VXSE51: observationAreas(xml.VXSE51), VXSE53: observationAreas(xml.VXSE53) };
  const path = process.env.FLEQ_JMA_CODES;
  if (path != null && path !== "") {
    const sheets = readSheets(path, ["22", "23", "24", "41"]);
    const forecastPrefs = new Map(flatSheet(sheets["22"], 4, "22").map((p) => [p.code, p]));
    const prefs = new Map(flatSheet(sheets["23"], 2, "23").map((p) => [p.code, p]));
    places = flatSheet(sheets["41"], 3, "41");
    const all = areaSheet(sheets["24"]).map((area) => {
      const prefix = new Set(area.cities.map((city) => city.code.slice(0, 2)));
      const pref = prefs.get([...prefix][0]);
      if (prefix.size !== 1 || pref == null) throw new Error(`sheet 24: area ${area.code} has no single prefecture in sheet 23`);
      return { ...area, pref };
    });
    // D-EEW-AREAS: 府県予報区のコードは 9pp0（pp は市町村コードの頭 2 桁）。シート 22 に在る区域だけを EEW で選ばせる。
    const eew = all.flatMap((area) => { const pref = forecastPrefs.get(`9${area.pref.code}0`); return pref == null ? [] : [{ ...area, pref, cities: [] }]; });
    areas = { VXSE43: eew, VXSE45: eew, VXSE51: all, VXSE53: all };
  }
  // 型の震央地名は、その分野の型の値を先頭にする（コード表があるときはシートの並びのまま）。
  const sampleOnly = path == null || path === "";
  const placesFor = Object.fromEntries(FAMILIES.map((family) => [family, family === "VXSE51" ? [] : sampleOnly && own[family] != null
    ? [own[family], ...places.filter((p) => p.code !== own[family].code)] : places]));
  return loaded = { xml, cancel, placesFor, areas };
}

export function choices(family) {
  const d = load();
  const pick = ({ code, name }) => ({ code, name });
  return { places: (d.placesFor[family] ?? []).map(pick), areas: (d.areas[family] ?? []).map(pick) };
}

// ---- 入力の検査（AC08） ----
const reject = (reason, field) => ({ kind: "rejected", reason, field });
const has = (v) => v != null && v !== "";
const oneDecimal = (v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;
const within = (v, low, high) => typeof v === "number" && Number.isFinite(v) && v >= low && v <= high;

function check(d, input, now) {
  if (input == null || typeof input !== "object") return reject("missingField", "family");
  const { family } = input;
  if (!has(family)) return reject("missingField", "family");
  if (!FAMILIES.includes(family)) return reject("unknownFamily", "family");
  // cancel は boolean だけを受ける（"true" などを黙って通常報にしない）。
  if (input.cancel !== undefined && typeof input.cancel !== "boolean") return reject("fieldNotInFamily", "cancel");
  const cancel = input.cancel === true;
  const given = (k) => has(input[k]);
  const first = (keys) => keys.find(given);
  let k;
  if (cancel) {
    if ((k = first([...SOURCE, "maxInt", "areaCode", "reports", "end"])) != null) return reject("cancelWithContent", k);
    if (CANCEL[family] == null) return reject("cancelTemplateMissing", "cancel");
  }
  k = family === "VXSE51" ? first(SOURCE) : family === "VXSE52" || TSUNAMI.has(family) ? first(["maxInt", "areaCode"]) : undefined;
  if (k == null && !HAS_SERIAL.has(family) && given("serial")) k = "serial";
  if (k == null && !EEW.has(family)) k = first(["reports", "end"]);
  if (k != null) return reject("fieldNotInFamily", k);

  let origin = now;
  if (given("originTime")) {
    const m = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(String(input.originTime)) ? Date.parse(String(input.originTime)) : NaN;
    origin = Math.floor(m / 1000) * 1000;
    const [y, mo, day] = String(input.originTime).slice(0, 10).split("-").map(Number); // 2026-02-30 のような存在しない日付は Date.parse が繰り上げる
    const check = new Date(Date.UTC(y, mo - 1, day));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== day) return reject("originTimeInvalid", "originTime");
    if (!Number.isFinite(origin) || origin > now) return reject("originTimeInvalid", "originTime");
  }
  let place = null;
  if (given("placeCode") && (place = d.placesFor[family].find((p) => p.code === String(input.placeCode))) == null) return reject("placeUnknown", "placeCode");
  if (given("lat") && !(within(input.lat, 0, 90) && oneDecimal(input.lat))) return reject("coordinateOutOfRange", "lat");
  if (given("lon") && !(within(input.lon, 0, 180) && oneDecimal(input.lon))) return reject("coordinateOutOfRange", "lon");
  if (given("depthKm") && !(within(input.depthKm, 0, 700) && Number.isInteger(input.depthKm))) return reject("depthOutOfRange", "depthKm");
  if (given("magnitude") && !(within(input.magnitude, 0, 9.9) && oneDecimal(input.magnitude))) return reject("magnitudeOutOfRange", "magnitude");
  if (given("maxInt")) {
    const index = INTENSITIES.indexOf(input.maxInt);
    if (index < 0 || (family === "VXSE51" && index < 2) || (family === "VXSE43" && index < 4)) return reject("intensityOutOfRange", "maxInt");
  }
  let area = null;
  if (given("areaCode") && (area = d.areas[family].find((a) => a.code === String(input.areaCode))) == null) return reject("areaUnknown", "areaCode");
  const serial = given("serial") ? input.serial : 1;
  if (!(within(serial, 1, 999) && Number.isInteger(serial))) return reject("serialOutOfRange", "serial");
  const reports = given("reports") ? input.reports : 1;
  if (!(within(reports, 1, 60) && Number.isInteger(reports))) return reject("reportsOutOfRange", "reports");
  const end = given("end") ? input.end : "none";
  if (!["none", "final", "cancel"].includes(end)) return reject("endInvalid", "end");
  if (serial + (end === "cancel" ? reports : reports - 1) > 999) return reject("serialOutOfRange", "serial");

  if (!cancel) {
    // 津波 3 種の震源の欄は任意だが、渡すなら 5 つそろえる（座標は 3 欄で 1 つの要素になるため）。
    const need = family === "VXSE52" || family === "VXSE53" || EEW.has(family) || (TSUNAMI.has(family) && first(SOURCE) != null) ? [...SOURCE] : [];
    if (family === "VXSE51" || family === "VXSE53" || EEW.has(family)) need.push("maxInt", "areaCode");
    if ((k = need.find((key) => !given(key))) != null) return reject("missingField", k);
  }
  return { family, cancel, origin, place, area, lat: input.lat, lon: input.lon, depthKm: input.depthKm, magnitude: input.magnitude, maxInt: input.maxInt, serial, reports, end };
}

// ---- 書き換え（AC09） ----
const wide = (text) => text.replace(/[0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/\./g, "．");
function hypocenter(xml, p) {
  return xml.replace(/(<Hypocenter>\s*<Area>\s*)<Name>[^<]*<\/Name>(\s*)<Code type="震央地名">[^<]*<\/Code>/, `$1<Name>${esc(p.place.name)}</Name>$2<Code type="震央地名">${p.place.code}</Code>`)
    .replace(/<jmx_eb:Coordinate[^>]*>[^<]*<\/jmx_eb:Coordinate>/,
      `<jmx_eb:Coordinate description="北緯${wide(p.lat.toFixed(1))}度　東経${wide(p.lon.toFixed(1))}度　深さ　${wide(String(p.depthKm))}ｋｍ">+${p.lat.toFixed(1)}+${p.lon.toFixed(1)}-${p.depthKm * 1000}/</jmx_eb:Coordinate>`)
    .replace(/<jmx_eb:Magnitude[^>]*>[^<]*<\/jmx_eb:Magnitude>/, `<jmx_eb:Magnitude type="Mj" description="Ｍ${wide(p.magnitude.toFixed(1))}">${p.magnitude.toFixed(1)}</jmx_eb:Magnitude>`);
}
const hasSource = (p) => p.place != null;
const between = (xml, open, close, inner, from = 0) => {
  const start = xml.indexOf(open, from);
  if (start < 0 || xml.indexOf(close, start + open.length) < 0) throw new Error(`telegram-gen: ${open}…${close} not found`);
  return xml.slice(0, start + open.length) + inner + xml.slice(xml.indexOf(close, start + open.length));
};
const areaItem = (kind, codeType, areas) => `<Item><Kind><Name>${kind}</Name></Kind><Areas codeType="${codeType}">${areas.map((a) => `<Area><Name>${esc(a.name)}</Name><Code>${a.code}</Code></Area>`).join("")}</Areas></Item>`;

function eewReport(d, p, at, serial, final) {
  let xml = head(placed(d.xml[p.family], p.origin), at, { eventId: eventIdAt(p.origin), serial: String(serial) });
  xml = hypocenter(xml, p).replace(/<ReduceName>[^<]*<\/ReduceName>/, `<ReduceName>${esc(p.place.name)}</ReduceName>`).replace(/<LandOrSea>[^<]*<\/LandOrSea>/, "") // 型の「海域」が陸の震央に残ると製品が読む
    .replace(/<Information\b[\s\S]*?<\/Information>/g, "") // 型の Code 31 が残ると VXSE45 も警報になる
    .replace(/(<Headline><Text>)[^<]*(<\/Text>)/, `$1${esc(p.place.name)}で地震$2`);
  const warning = p.family === "VXSE43";
  const kind = warning ? "<Kind><Name>緊急地震速報（警報）</Name><Code>10</Code></Kind>" : "<Kind><Name>緊急地震速報（予報）</Name><Code>00</Code></Kind>";
  const int = `<ForecastInt><From>${p.maxInt}</From><To>${p.maxInt}</To></ForecastInt>`;
  const body = xml.indexOf("<Body");
  const from = xml.indexOf("<Pref>", body), to = xml.lastIndexOf("</Pref>") + "</Pref>".length;
  const top = xml.slice(body, from).replace(/<ForecastInt>[\s\S]*?<\/ForecastInt>/, int).replace(/<ForecastLgInt>[\s\S]*?<\/ForecastLgInt>/, "<ForecastLgInt><From>0</From><To>0</To></ForecastLgInt>"); // 型の 2 が残ると全部が長周期階級 2 になる
  const pref = `<Pref><Name>${esc(p.area.pref.name)}</Name><Code>${p.area.pref.code}</Code><Area><Name>${esc(p.area.name)}</Name><Code>${p.area.code}</Code><Category>${kind}</Category>${int}<ForecastLgInt><From>0</From><To>0</To></ForecastLgInt></Area></Pref>`;
  xml = xml.slice(0, body) + top + pref + xml.slice(to);
  return final ? xml.replace("<Comments>", `<NextAdvisory>${FINAL_TEXT}</NextAdvisory><Comments>`) : xml;
}

function quake(d, p, at) {
  const { family } = p;
  const eventId = eventIdAt(p.origin);
  const serial = HAS_SERIAL.has(family) ? String(p.serial) : undefined; // VXSE51・VXSE52・VTSE41 は型の空の <Serial/> のまま
  let xml = head(placed(d.xml[family], p.origin), at, { eventId, serial, target: family === "VXSE51" ? p.origin : at });
  if (hasSource(p)) xml = hypocenter(xml, p);
  if (family === "VXSE51") {
    const { area, maxInt } = p;
    xml = between(xml, "</CodeDefine>", "</Observation>", `<MaxInt>${maxInt}</MaxInt><Pref><Name>${esc(area.pref.name)}</Name><Code>${area.pref.code}</Code><MaxInt>${maxInt}</MaxInt><Area><Name>${esc(area.name)}</Name><Code>${area.code}</Code><MaxInt>${maxInt}</MaxInt></Area></Pref>`,
      xml.indexOf("<Observation>"));
    return between(xml, "</Text>", "</Headline>", `<Information type="震度速報">${areaItem(LABEL[maxInt], "地震情報／細分区域", [area])}</Information>`, xml.indexOf("<Headline>"));
  }
  if (family === "VXSE53") {
    const { area, maxInt } = p;
    const cities = area.cities.map((c) => `<City><Name>${esc(c.name)}</Name><Code>${c.code}</Code><MaxInt>${maxInt}</MaxInt>${c.stations.map((s) =>
      `<IntensityStation><Name>${esc(s.name)}</Name><Code>${s.code}</Code><Int>${maxInt}</Int></IntensityStation>`).join("")}</City>`).join("");
    xml = between(xml, "</CodeDefine>", "</Observation>", `<MaxInt>${maxInt}</MaxInt><Pref><Name>${esc(area.pref.name)}</Name><Code>${area.pref.code}</Code><MaxInt>${maxInt}</MaxInt><Area><Name>${esc(area.name)}</Name><Code>${area.code}</Code><MaxInt>${maxInt}</MaxInt>${cities}</Area></Pref>`,
      xml.indexOf("<Observation>"));
    // 震度 1・2 の地震情報は Headline に Information を出さない（解説資料 11-2(3)）。
    if (maxInt === "1" || maxInt === "2") return between(xml, "</Text>", "</Headline>", "", xml.indexOf("<Headline>"));
    return between(xml, "</Text>", "</Headline>", `<Information type="震源・震度に関する情報（細分区域）">${areaItem(LABEL[maxInt], "地震情報／細分区域", [area])}</Information>`
      + `<Information type="震源・震度に関する情報（市町村等）">${areaItem(LABEL[maxInt], "気象・地震・火山情報／市町村等", area.cities)}</Information>`, xml.indexOf("<Headline>"));
  }
  return xml;
}

function cancelReport(d, p, at, serial) {
  const target = p.family === "VXSE51" ? p.origin : at;
  return head(placed(d.cancel[p.family], p.origin), at, { eventId: eventIdAt(p.origin), serial: HAS_SERIAL.has(p.family) ? String(serial) : undefined, target })
    .replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>取消</InfoType>");
}

export function generateTelegrams(input) {
  const d = load();
  const real = Math.floor(Date.now() / 1000) * 1000; // 1 回の呼出しで 1 度だけ取る（D-TIME）
  // 同じ秒に作った続報は版の比べで新しくならず採られない（非 EEW は Serial を見ない）ので、報の時刻は最後に出した秒の 1 秒後より前にしない。
  const now = Math.max(real, lastSecond + 1000);
  const p = check(d, input, real);
  if (p.kind === "rejected") return p;
  const reports = [];
  const add = (serial, xml) => reports.push({ serial: HAS_SERIAL.has(p.family) ? serial : null, xml });
  if (p.cancel) add(p.serial, cancelReport(d, p, now, p.serial));
  else if (EEW.has(p.family)) {
    for (let k = 0; k < p.reports; k++) add(p.serial + k, eewReport(d, p, now + SPACING_MS * k, p.serial + k, p.end === "final" && k === p.reports - 1));
    if (p.end === "cancel") add(p.serial + p.reports, cancelReport(d, p, now + SPACING_MS * p.reports, p.serial + p.reports));
  } else add(p.serial, quake(d, p, now));
  lastSecond = now + (EEW.has(p.family) && !p.cancel ? SPACING_MS * (reports.length - 1) : 0);
  return { kind: "generated", headType: p.family, eventId: eventIdAt(p.origin), originTime: jst(p.origin), reports };
}
