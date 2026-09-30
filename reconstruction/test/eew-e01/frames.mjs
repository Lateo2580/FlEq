// P2-A10-AC01/AC16: 投入する frame の作り方。試行の初期化（続報方式）と通常負荷 N の再生を、決まった規則だけで作る。
// 無いと、試行ごとに入力が揺れ、trialSetup に固定した hash と規則が再現できない。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// 契約 allowedDependencies に zlib が無いのは契約の欠落。総合レビューへ送る（本物の dmdata の frame は gzip で、製品の decode に解凍の段がある）。
import { gzipSync } from "node:zlib";

export const REPO = join(import.meta.dirname, "../../..");
export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

// trialSetup.clock.wallTimeOriginMs。全 fixture の報より後ろに置き、EEW 変種の時刻はここへ寄せる。
export const WALL_ORIGIN_MS = Date.parse("2026-06-05T18:00:00+09:00");
const EEW_FIXTURE = "37_01_01_240613_VXSE43";
const EEW_REPORT_MS = Date.parse("2024-04-17T23:14:59+09:00");

export const fixtureText = (name) => readFileSync(join(REPO, `test/fixtures/${name}.xml`));
export const fixtureId = (name) => `test__fixtures__${name}`;

// dmdata と同じ data frame（形は ingress.ts と host.test.ts の dataFrame を正とする）。
// 外側の運用（xmlReport.control.status、head.test は訓練・試験で true）は本文の Control/Status に揃える。違うと製品が operationMismatch で捨てる
// （operation.ts:37、RES-07 の訓練・試験の national で実際に起きた）。通常の本文は従来と同じ bytes。
export function dataFrame(headType, xml) {
  const status = /<Status>([^<]+)<\/Status>/.exec(String(xml))?.[1] ?? "通常";
  return JSON.stringify({ type: "data", version: "2.0", classification: "eew.forecast", id: "a10", format: "xml",
    encoding: "base64", compression: "gzip", head: { type: headType, author: "JMA", time: "2024-06-13T00:00:00Z", test: status !== "通常", xml: true },
    xmlReport: { control: { status } }, body: gzipSync(xml).toString("base64") });
}

const ISO = /(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(\.\d+)?(Z|\+09:00)/g;
// XML 内の全ての時刻（Z と +09:00）を deltaMs だけ動かす。EEW 変種と、期限を合わせる weather 変種が使う。
export function shiftTimestamps(xml, deltaMs) {
  return xml.replace(ISO, (whole, y, mo, d, h, mi, s, frac, zone) => {
    const at = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone === "Z" ? "Z" : "+09:00"}`) + deltaMs;
    const iso = new Date(zone === "Z" ? at : at + 9 * 3_600_000).toISOString();
    // 秒未満を捨てない（期限の位置が最大 1 秒ずれて狙った tick の 1 つ前に落ちるため）。元が整数秒で結果も整数秒なら元の形のまま。
    const fraction = at % 1000 === 0 ? (frac ?? "") : iso.slice(19, 23);
    return `${iso.slice(0, 19)}${fraction}${zone}`;
  });
}

const B_FROM = "<Name>愛媛県東予</Name><Code>620</Code><Category><Kind><Name>緊急地震速報（警報）</Name><Code>10</Code></Kind></Category><ForecastInt><From>4</From><To>4</To>";
const B_TO = B_FROM.replace("<From>4</From><To>4</To>", "<From>5-</From><To>5-</To>");

// 続報方式の変種。元 fixture に対する規則は「EventID・Serial・全時刻の平行移動・予測 A/B」だけ。
// A は元の予測、B は愛媛県東予の予測震度 4 を 5- に替える（contentRevision が進み、card と map が描き直される）。
export function eewVariant({ eventId, serial, reportAtMs, variant }) {
  let xml = fixtureText(EEW_FIXTURE).toString("utf8");
  xml = shiftTimestamps(xml, reportAtMs - EEW_REPORT_MS)
    .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`)
    .replace(/<Serial>\d+<\/Serial>/, `<Serial>${serial}</Serial>`);
  if (variant === "B") {
    if (!xml.includes(B_FROM)) throw new Error("EEW variant B anchor not found");
    xml = xml.replace(B_FROM, B_TO);
  }
  return xml;
}

// 母集団ごとの EventID（14 桁）。warm-up と正式で別、run で別、母集団で別。
export const eventIdOf = (populationCode, phase, run) => `2026060518${populationCode}${phase === "warmup" ? 0 : 1}${run}0`;

// 通常負荷 N: 実ストリームの窓（dmdata Telegram List v2）から受信間隔と headType を借りる。中身は同じ headType の fixture。
const N_FIXTURES = {
  VPWS50: "15_18_01_250630_VPWS50", VPWW55: "15_17_01_251222_VPWW55", VPWW56: "15_16_01_241031_VPWW56",
  VPWW61: "15_16_07_250825_VPWW61", VPWP50: "81_01_04_251222_VPWP50", VPFJ51: "85_01_01_250630_VPFJ51", VPTW61: "10_05_05_200826_VPTW61",
};
export const N_WINDOW_MS = 3_600_000; // 窓は 09:00〜10:00 JST（最後の受信は 09:50:56）。周期は窓の長さで繰り返す。
export function loadN(windowFile) {
  const text = readFileSync(windowFile);
  const items = JSON.parse(text.toString("utf8")).body.items;
  const start = Date.parse("2026-09-28T00:00:00Z");
  const events = [];
  const skipped = [];
  for (const it of items.slice().sort((a, b) => a.receivedTime.localeCompare(b.receivedTime))) {
    const offsetMs = Date.parse(it.receivedTime) - start;
    const fixture = N_FIXTURES[it.head.type];
    if (fixture == null) { skipped.push({ headType: it.head.type, offsetMs, reason: "noFixtureForHeadType" }); continue; }
    events.push({ offsetMs, headType: it.head.type, fixture });
  }
  return { windowSha256: sha256Hex(text), windowMs: N_WINDOW_MS, events, skipped };
}

// ReplayLoad（manifest.loads の 1 件）。ordering は fixture id、offsetsMs は窓の先頭からの受信時刻。sha256 は順序・offset・fixture bytes の hash。
export function replayLoad(id, n, speedup) {
  const ordering = n.events.map((e) => fixtureId(e.fixture));
  const offsetsMs = n.events.map((e) => Math.round(e.offsetMs / speedup));
  const durationMs = Math.round(n.windowMs / speedup);
  const fixtureRefs = [...new Set(ordering)];
  const fixtures = fixtureRefs.map((ref) => sha256Hex(fixtureText(ref.replace("test__fixtures__", ""))));
  return { id, fixtureRefs, ordering, offsetsMs, durationMs, sha256: sha256Hex(JSON.stringify({ ordering, offsetsMs, durationMs, fixtures })) };
}

// manifest の ReplayLoad から投入する frame 列を作る。hash が合わなければ拒否する（凍結した入力と違うものを流さない）。
export function loadEvents(load) {
  const again = replayLoad(load.id, { events: load.ordering.map((ref, i) => ({ fixture: ref.replace("test__fixtures__", ""), offsetMs: load.offsetsMs[i] })), windowMs: load.durationMs }, 1);
  if (again.sha256 !== load.sha256) throw new Error(`load ${load.id}: sha256 does not match its ordering/offsets/fixtures`);
  return load.ordering.map((ref, i) => {
    const name = ref.replace("test__fixtures__", "");
    const headType = /_(V[A-Z]{3}\d{2}|WTJP\d{2})/.exec(name)?.[1];
    return { offsetMs: load.offsetsMs[i], headType, name };
  });
}

// weather の入力は報告時刻を投入時点の壁時計（秒）へ平行移動して流す。fixture の日付が host の壁時計とずれると、
// U-F の期限（報告の 49 時間後など）が最初から過ぎて状態が空になるため。移動は全時刻を同じ量だけ動かす。
export function weatherFrame(name, headType, atWallMs) {
  return dataFrame(headType, Buffer.from(weatherXml(name, atWallMs)));
}
function weatherXml(name, atWallMs) {
  const xml = xmlOf(name);
  return shiftTimestamps(xml, atWallMs - reportMs(xml));
}

// ── Q-PERF §3.1・§3.6・§3.7 の入力規則（P2-A10-AC08/AC15/AC16）。規則ごとに関数 1 つ ──
// 返すのは { headType, xml }。frame にするのは投入の直前（dataFrame）。規則の文と件数は draft.mjs が initial-state の recipe に書き、
// この file の sha256 も同じ recipe に固定する（ReplayLoad が書き換え規則を持てないため、契約の穴 §6 c）。
const xmlCache = new Map();
const xmlOf = (name) => { let xml = xmlCache.get(name); if (xml == null) xmlCache.set(name, xml = fixtureText(name).toString("utf8")); return xml; };
const reportMs = (xml) => Date.parse(/<ReportDateTime>([^<]+)</.exec(xml)[1]);
const jst = (ms) => `${new Date(ms + 9 * 3_600_000).toISOString().slice(0, 19)}+09:00`;
const atReport = (xml, ms) => xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${jst(ms)}</ReportDateTime>`);
const office = (xml, name) => xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${name}</EditorialOffice>`);
const withEventId = (xml, eventId) => xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`);
// U-F の validUntil（製品は時間定義の終端の最大、weather-timeseries.ts:235）。書き換えの基準に使う。
export function validUntilMs(xml) {
  const ends = [...xml.matchAll(/<TimeDefine[^>]*><DateTime>([^<]+)<\/DateTime><Duration>PT(\d+)H<\/Duration>/g)].map((m) => Date.parse(m[1]) + Number(m[2]) * 3_600_000);
  if (ends.length === 0) throw new Error("no TimeDefine with PTnH");
  return Math.max(...ends);
}

export const FIX = {
  vxse43: EEW_FIXTURE, vxse43Cancel: "37_01_03_240613_VXSE43", vxse45: "77_01_01_240613_VXSE45", vpws50: "15_18_01_250630_VPWS50",
  vpww57: "15_16_02_251222_VPWW57", vpwp50: "81_02_01_260605_VPWP50_high_severity", vpwp50Large: "81_09_01_260605_VPWP50",
};
const EVENT_BASE = 20240417000000;

// 同時最大状態（A8 RES-07 の合法最大）。作り方は cost.test.ts:155-165 と同じ（EventID・運用・官署名だけを替え、時刻は動かさない）。
// host の壁時計起点（WALL_ORIGIN_MS）は A8 試験の at と同じ時刻で、U-F（validUntil 翌 03:00）も U-W（時刻で消えない）も充填中・窓の間に消えない。
// leaveRoomForP は P の再生が新しく足す U-W partial と U-F subject の数（room、統合担当が予備で数えて凍結する）だけ上限から空ける。
// cycleC は full と同じ件数で、VXSE43 の最後の 1 件（EventID +511）だけを訓練の種 TRAINING_EVENT(0) に替える（C の U-E を一定に保つため。cycleCFrames）。
// half は AC15 の保持量の対照（走査対象が保持量に比例しないことを full と比べて確かめる）。U-E の EventID・U-W partial・U-F subject が full の半分、
// national は同じ。無いと、要素ごとの計量で出る原始値やその他の直列化が保持量に比例していても判定されない。
// full・half（AC15 の充填）は partial の官署ごとに ReportDateTime を 1 秒ずつ進めた更新を PARTIAL_HISTORY_UPDATES 回送り、履歴を作る。
// 無いと、指紋表を作る時点の U-W に履歴が無く、履歴 entry の形（subject,operation,reports）が指紋表に載らない。
export const RES07 = { eventIdsPerFamily: 512, national: ["通常", "訓練", "試験"], partials: 128, forecastSubjects: 512 };
export const PARTIAL_HISTORY_UPDATES = 2;
export function nearCapacityFrames({ mode, room = null }) {
  const counted = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  if (mode === "leaveRoomForP" ? !(counted(room?.partials, RES07.partials) && counted(room?.forecastSubjects, RES07.forecastSubjects))
    : !["full", "half", "cycleC"].includes(mode) || room != null)
    throw new Error(`nearCapacityFrames: full/half/cycleC take no room; leaveRoomForP needs room {partials ≤ ${RES07.partials}, forecastSubjects ≤ ${RES07.forecastSubjects}}`);
  const scale = mode === "half" ? 2 : 1;
  const updates = mode === "full" || mode === "half" ? PARTIAL_HISTORY_UPDATES : 0;
  const out = [];
  for (let i = 0; i < RES07.eventIdsPerFamily / scale; i++) {
    const seed = mode === "cycleC" && i === RES07.eventIdsPerFamily - 1;
    out.push({ headType: "VXSE43", xml: seed ? trainingEew(0) : withEventId(xmlOf(FIX.vxse43), String(EVENT_BASE + i)) });
    out.push({ headType: "VXSE45", xml: withEventId(xmlOf(FIX.vxse45), String(EVENT_BASE + i)) });
  }
  for (const operation of RES07.national) out.push({ headType: "VPWS50", xml: xmlOf(FIX.vpws50).replace("<Status>通常</Status>", `<Status>${operation}</Status>`) });
  for (let i = 0; i < RES07.partials / scale - (room?.partials ?? 0); i++) {
    const xml = office(xmlOf(FIX.vpww57), `官署${i}`);
    out.push({ headType: "VPWW57", xml });
    for (let k = 1; k <= updates; k++) out.push({ headType: "VPWW57", xml: atReport(xml, reportMs(xml) + k * 1000) });
  }
  for (let i = 0; i < RES07.forecastSubjects / scale - (room?.forecastSubjects ?? 0); i++) out.push({ headType: "VPWP50", xml: office(xmlOf(FIX.vpwp50), `官署${i}`) });
  return out;
}

// 固定周期負荷 C（E06 の系列）の周期 c の 7 入力。初期状態は nearCapacityFrames({ mode: "cycleC" })。
// 周期の終わりの保持量（保存件数・表示件数）を周期をまたいで一定にする（E06 は RSS・heap の傾きで漏れを見るので、保持量が目減りすると
// 傾きが負へ偏って漏れを隠す）。
// - U-E: 通常の EventID +c を Serial 2 に更新。訓練の新しい EventID T(c+1) を足し（family 512 を超えるので、製品が最古の非通常 =
//   前の周期の T(c) の gate を追い出す、eew.ts:366-381）、同じ周期のうちに T(c+1) を取消す。current・gate・予算とも周期の終わりで一定
// - U-F: 官署0 を周期の開始 + 1 時間まで有効な報告で入れ直し、周期の 40 秒に validUntil が周期の開始 + 50 秒の報告で更新して期限回収させる
// - U-W: national（通常）と partial 官署{c} の更新
// どの subject も EEW は (Serial, ReportDateTime)、weather は ReportDateTime が前の報告より新しい（stale・duplicate で捨てられない、
// spec §9.9「重複拒否だけの反復で代用しない」）。cycleStartWallMs は周期の開始の host 壁時計。
export const C_CYCLE = { periodMs: 60_000, offsetsMs: [0, 5_000, 10_000, 20_000, 25_000, 30_000, 40_000], validUntilAfterStartMs: 50_000,
  restoreValidForMs: 3_600_000, forecastOffice: "官署0", warmupCycles: 5 };
const TRAINING_EVENT_BASE = 20260930000000; // 充填の通常 EventID（20240417000000+i）と重ならない訓練の EventID
const trainingEew = (k) => withEventId(xmlOf(FIX.vxse43), String(TRAINING_EVENT_BASE + k)).replace("<Status>通常</Status>", "<Status>訓練</Status>");
export function cycleCFrames(c, cycleStartWallMs) {
  if (!(Number.isInteger(c) && c >= 0 && c < RES07.partials)) throw new Error(`cycle ${c}: C touches only existing partials (官署0..${RES07.partials - 1})`);
  const step = (c + 1) * 60_000;
  const [o0, o1, o2, o3, o4, o5, o6] = C_CYCLE.offsetsMs;
  const forecast = office(xmlOf(FIX.vpwp50), C_CYCLE.forecastOffice);
  // 期限を合わせるため全時刻を動かすと報告が充填時（17:00）より古くなるので、ReportDateTime だけは充填時 + 周期ぶん進めた値に置き直す。
  const forecastUntil = (untilMs, reportAtMs) => atReport(shiftTimestamps(forecast, untilMs - validUntilMs(forecast)), reportAtMs);
  const cancel = withEventId(xmlOf(FIX.vxse43Cancel), String(TRAINING_EVENT_BASE + c + 1)).replace("<Status>通常</Status>", "<Status>訓練</Status>");
  return [
    { offsetMs: o0, headType: "VPWS50", xml: shiftTimestamps(xmlOf(FIX.vpws50), step) },
    { offsetMs: o1, headType: "VPWP50", xml: forecastUntil(cycleStartWallMs + C_CYCLE.restoreValidForMs, reportMs(forecast) + step - 30_000) },
    { offsetMs: o2, headType: "VPWW57", xml: atReport(office(xmlOf(FIX.vpww57), `官署${c}`), reportMs(xmlOf(FIX.vpww57)) + step) },
    { offsetMs: o3, headType: "VXSE43", xml: eewVariant({ eventId: String(EVENT_BASE + c), serial: 2, reportAtMs: EEW_REPORT_MS + step, variant: c % 2 === 0 ? "A" : "B" }) },
    { offsetMs: o4, headType: "VXSE43", xml: trainingEew(c + 1) },
    { offsetMs: o5, headType: "VXSE43", xml: cancel },
    { offsetMs: o6, headType: "VPWP50", xml: forecastUntil(cycleStartWallMs + C_CYCLE.validUntilAfterStartMs, reportMs(forecast) + step) },
  ];
}

// E03: VPWS50 15_18_01 を 1,200ms 周期で warm-up 20＋1,000。k 番目の報告時刻は投入予定（start + k × 周期）の秒へ全時刻を平行移動する
// （周期が 1 秒より長いので報告時刻は厳密に増え、duplicate にならない）。
export const E03_SERIES = { fixture: FIX.vpws50, periodMs: 1200, warmup: 20, samples: 1000 };
export function e03Frame(k, startWallMs) {
  return { headType: "VPWS50", xml: weatherXml(FIX.vpws50, Math.floor((startWallMs + k * E03_SERIES.periodMs) / 1000) * 1000) };
}

// AC15（p2-snapshot-sse.json:100）: 保持上限ちょうどから 4 シナリオ（EEW 1 件／metadata のみ／U-W 1 subject／U-F 1 subject、
// A8 cost.test.ts:182-191 と同じ入力）を各 warm-up 10＋100、1,500ms 間隔。新しい EventID・官署を足さない（U-E は 2 family × 512 で
// 新しい EventID が capacityExceeded になる）。metadata のみは frame ではなく投入側の WS 切断: host が connectionLost を流し
// （host.ts:228-231）、RECONNECT_MS 5 秒後に再接続する。unit の内容は変わらず、connection だけが変わる。区間は切断の時刻（投入側 hrtime を
// host 時計へ写したもの）から次の区間の起点まで。間隔 metadataIntervalMs は実走の再接続所要（予備で 5.0〜5.1 秒）より長く取る。
// retention: 同じシナリオを保持上限ちょうど（full）と約半分（half）の充填から回し、checkpoint 区間外の直列化回数（入力 1 件あたりの中央値）の
// 差を保持件数の差で割った傾きが maxSlopePerRetained（回／保持 1 件）を超えたら Fail（走査対象が保持量に比例＝当該 subject だけでない）。
export const AC15_SCENARIOS = { warmup: 10, samples: 100, intervalMs: 1500, metadataIntervalMs: 7000, scenarios: ["U-E", "metadata", "U-W", "U-F"],
  retention: { modes: ["full", "half"], maxSlopePerRetained: 0.5 } };
export function ac15Frame(unit, index) {
  if (unit === "U-E") return { headType: "VXSE43", xml: atReport(withEventId(xmlOf(FIX.vxse43), String(EVENT_BASE)), EEW_REPORT_MS + (index + 1) * 1000)
    .replace(/<Serial>\d+<\/Serial>/, `<Serial>${index + 2}</Serial>`) };
  if (unit === "U-W") return { headType: "VPWW57", xml: atReport(office(xmlOf(FIX.vpww57), "官署0"), reportMs(xmlOf(FIX.vpww57)) + (index + 1) * 60_000) };
  if (unit === "U-F") return { headType: "VPWP50", xml: atReport(office(xmlOf(FIX.vpwp50), "官署0"), reportMs(xmlOf(FIX.vpwp50)) + (index + 1) * 1000) };
  throw new Error(unit === "metadata" ? "AC15 metadata は frame ではなく投入側の WS 切断で起こす（AC15_SCENARIOS の注記）" : `unknown AC15 unit ${unit}`);
}

// E12: class 別の frame 列（e12-run.mjs の frames.jsonl の 1 行 = { atMs, frame }）。frame の形は e12-run.mjs の frame() と同じ
// （旧 handler が読む xmlReport と新 ingress が読む head/encoding の両方、utf-8・無圧縮）。weather は k 番目の全時刻を baseWallMs + k × 周期へ
// 平行移動する（同じ報告の繰り返しは新側で duplicate として捨てられ、処理の費用を測れない）。EEW は Serial を 1 ずつ進める（今の e12-run と同じ）。
export const E12_CLASSES = {
  small: { fixture: FIX.vxse45, headType: "VXSE45", count: 200, intervalMs: 200 },
  large: { fixture: FIX.vpwp50Large, headType: "VPWP50", count: 30, intervalMs: 2000 },
  max: { fixture: FIX.vpws50, headType: "VPWS50", count: 30, intervalMs: 2000 },
};
export function e12Frame(xml, headType, classification, meta) {
  const now = "2024-06-13T00:00:00.000Z";
  return JSON.stringify({ type: "data", version: "2.0", classification, id: `e12-${headType}-${meta.serial ?? 0}`,
    passing: [{ name: "e12", time: now }], head: { type: headType, author: "気象庁", time: now, test: false, xml: true },
    xmlReport: { control: { title: meta.title, dateTime: now, status: "通常", editorialOffice: "気象庁本庁", publishingOffice: "気象庁" },
      head: { title: meta.title, reportDateTime: now, targetDateTime: now, eventId: meta.eventId, serial: meta.serial, infoType: "発表",
        infoKind: meta.infoKind, infoKindVersion: "1.0_0", headline: null } },
    format: "xml", compression: null, encoding: "utf-8", body: xml });
}
export function e12Frames(cls, baseWallMs) {
  const spec = E12_CLASSES[cls];
  if (spec == null) throw new Error(`unknown E12 class ${cls}`);
  const base = Math.floor(baseWallMs / 1000) * 1000;
  const source = xmlOf(spec.fixture);
  const title = /<Title>([^<]+)<\/Title>/.exec(source)[1];
  const infoKind = /<InfoKind>([^<]+)<\/InfoKind>/.exec(source)[1];
  return Array.from({ length: spec.count }, (_, k) => {
    const atMs = (k + 1) * spec.intervalMs;
    if (spec.headType === "VXSE45") return { atMs, frame: e12Frame(source.replace("<Serial>1</Serial>", `<Serial>${k + 1}</Serial>`), "VXSE45", "eew.forecast",
      { title, eventId: "20240417231454", serial: String(k + 1), infoKind }) };
    return { atMs, frame: e12Frame(shiftTimestamps(source, base + k * spec.intervalMs - reportMs(source)), spec.headType, "telegram.weather", { title, eventId: null, serial: null, infoKind }) };
  });
}

// 充填・窓の投入の流量制御（§3.6 の地雷）。送った数 − host の decode 観測数（mailbox から取り出した件数）を未処理とみなし、32 件以下で送る。
// EEW（VXSE43/45）は予約枠（mailbox.ts:13 の 8 件）に入るので未処理 8 件以下、VPWS50 は未処理 0 件のときだけ送る。無いと mailbox の枠
// （p2-mailbox.json RES-03/04）で拒否され、host が自分の接続を切り、送った frame が黙って失われる（予備で EEW の 9 件目が実際に拒否された）。processed() は呼び出し側が host の JSONL から数える decode 観測の累計。
// sentBefore は呼び出し側がこの host へ既に送った data frame の数。前提: それらは全て mailbox に入り decode 観測で数えられる
// （ingress 拒否が無い）。decode 観測が送った数を超えたら、別の送り手が混ざっているので throw。送れなかった（seq が null）・捌けないときも throw。
const EEW_LANE_ITEMS = 8;
export async function sendPaced(items, { send, processed, sentBefore, maxPending = 32, pollMs = 50, stallMs = 60_000 }) {
  if (!(Number.isInteger(sentBefore) && sentBefore >= 0)) throw new Error("sendPaced: sentBefore (frames already sent to this host) is required");
  let sent = sentBefore;
  let lastProgress = { at: performance.now(), done: -1 };
  const pending = () => {
    const done = processed();
    if (done > sent) throw new Error(`sendPaced: processed ${done} > sent ${sent} (another sender is feeding this host)`);
    if (done !== lastProgress.done) lastProgress = { at: performance.now(), done };
    else if (performance.now() - lastProgress.at > stallMs) throw new Error(`sendPaced: no progress for ${stallMs}ms (sent ${sent}, processed ${done})`);
    return sent - done;
  };
  const started = performance.now();
  for (const item of items) {
    const limit = item.headType === "VPWS50" ? 0 : /^VXSE4[35]$/.test(item.headType) ? EEW_LANE_ITEMS - 1 : maxPending - 1;
    while (pending() > limit) await new Promise((wake) => setTimeout(wake, pollMs));
    if (send(dataFrame(item.headType, item.xml)).seq == null) throw new Error(`sendPaced: send failed after ${sent} frames`);
    sent += 1;
  }
  while (pending() > 0) await new Promise((wake) => setTimeout(wake, pollMs));
  return { sent: sent - sentBefore, durationMs: performance.now() - started };
}
