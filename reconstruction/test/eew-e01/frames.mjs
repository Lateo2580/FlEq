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
export function dataFrame(headType, xml) {
  return JSON.stringify({ type: "data", version: "2.0", classification: "eew.forecast", id: "a10", format: "xml",
    encoding: "base64", compression: "gzip", head: { type: headType, author: "JMA", time: "2024-06-13T00:00:00Z", test: false, xml: true },
    xmlReport: { control: { status: "通常" } }, body: gzipSync(xml).toString("base64") });
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
    events.push({ offsetMs, headType: it.head.type, fixture, frame: dataFrame(it.head.type, fixtureText(fixture)) });
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
  const xml = fixtureText(name).toString("utf8");
  const report = Date.parse(/<ReportDateTime>([^<]+)</.exec(xml)[1]);
  return dataFrame(headType, Buffer.from(shiftTimestamps(xml, atWallMs - report)));
}
