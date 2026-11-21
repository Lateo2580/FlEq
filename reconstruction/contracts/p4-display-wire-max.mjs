// P4-DISPLAY-WIRE-001（B0）の型の上限の表（p4-display-wire-tables.md §1）から最大の形の object を組み、
// JSON.stringify の UTF-8 byte で保護 3 分野の合計を数える。B0 の受入の「型の最大値の試験」の下書き。
// 実行: node reconstruction/contracts/p4-display-wire-max.mjs
// 鍵の名前は数えるための仮の名で、B0 の型で決め直したらここも直す（鍵 1 字の差が行の数だけ効く）。

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
// 同じ欄に入りうる値のうち、直列化が最も長いものを選ぶ（null・false・負の番号を取りこぼさない、ヘルツ r2 #3）。
const widest = (...candidates) => candidates.reduce((a, b) => (bytes(b) > bytes(a) ? b : a));
// escape 後 n byte の字（引用符を除く）。1 byte 字で埋めると escape 後の byte と字数が同じになる。
const text = (n) => "x".repeat(n);
const MS = Number.MAX_SAFE_INTEGER;

// §1.3 の上限（escape 後の byte）
const LIMIT = {
  eventId: 40, time: 40, hypocenter: 192, coordinate: 64, valueRaw: 32, description: 96, place: 192,
  firstWave: 48, height: 24, unkeyedName: 192, tsunamiEval: 384, cardTitle: 1536, cardHeadline: 1536,
  cardTitleShort: 96, cardHeadlineShort: 384, comment: 2048,
  // unit が持つ 4,096 字（tsunami.ts:197）を、1 字が \u00XX の 6 byte に escape される最悪で数えた値。
  commentFull: 4096 * 6,
};
const OPERATION = widest("normal", "training", "test");
const LEVEL = widest(null, -2, -1, 0, 9, 10); // 段の番号（§1.2）。欠けは null
const MINI_LEVEL = widest(null, -2, -1, 19); // カードの最小の欄（以上は ＋10）
const COMP_LEVEL = widest(-1, 9); // 合成（既知の最大の段、不明だけは −1）
const ARRIVAL = widest(null, -2, 0, 1, 9); // 区域の Kind/Code の下 1 桁
const CONDITION = widest(null, "arrived", "unknown");
const TSUNAMI_CLASS = widest("majorWarning", "warning", "advisory", "forecast", "released", "none", "unknown");
const MARKS = ["unconfirmed", "restored", "expiryPending", "capacityExceeded"];
const BOOL = widest(true, false);
const cut = (n) => ({ text: text(n), cut: BOOL });
const nullable = (value) => widest(null, value);
// 詳細の要求に要る参照（§2.1）: id＝sha256([unit, operation, subject]) の hex、rev＝その part が返す view の object の JSON の sha256 の hex
const REF = { id: text(64), rev: text(64) };

const array = (n, item) => Array.from({ length: n }, () => item);

// ---- EEW ----
const eewHeader = {
  eventId: text(LIMIT.eventId), operation: OPERATION, letter: "A", warning: BOOL, serial: MS, final: BOOL,
  reportTime: nullable(text(LIMIT.time)), max: { f: LEVEL, t: LEVEL },
  hypo: nullable(cut(LIMIT.hypocenter)),
  mag: nullable({ v: text(LIMIT.valueRaw), desc: text(LIMIT.description), cut: BOOL }),
  depth: nullable({ v: text(LIMIT.valueRaw), desc: text(LIMIT.description), cut: BOOL }),
  epi: nullable(cut(LIMIT.coordinate)), assumed: BOOL, detectOnly: BOOL, place: nullable(cut(LIMIT.place)),
  lg: { f: LEVEL, t: LEVEL }, unread: BOOL, marks: MARKS, unknownAreas: MS, dupAreas: MS, ref: REF,
};
const eewRow = { c: "622", f: LEVEL, t: LEVEL, cd: CONDITION, ks: ARRIVAL, at: nullable(text(LIMIT.time)), lg: { f: LEVEL, t: LEVEL } };
const eewMini = ["622", MINI_LEVEL];
const subareaComposite = array(188, ["622", COMP_LEVEL]);
const municipalityComposite = array(1894, ["2230600", COMP_LEVEL]);

function eew(paintOperations) {
  const one = { cards: [{ ...eewHeader, rows: array(188, eewRow) }], composites: [subareaComposite], omitted: MS };
  const two = { cards: array(2, { ...eewHeader, mini: array(188, eewMini), top: array(2, eewRow) }),
    composites: array(Math.min(2, paintOperations), subareaComposite), omitted: MS };
  const six = { cards: array(6, { ...eewHeader, mini: array(188, eewMini) }),
    composites: array(paintOperations, subareaComposite), omitted: MS };
  return Math.max(bytes(one), bytes(two), bytes(six));
}

// ---- 津波 ----
function tsunami(events, paintOperations, commentLimit) {
  const header = {
    eventId: text(LIMIT.eventId), operation: OPERATION, serial: MS, reportTime: nullable(text(LIMIT.time)),
    comment: nullable(cut(commentLimit)), unread: BOOL, marks: MARKS, omittedUnkeyed: MS, unknownAreas: MS, dupAreas: MS, ref: REF,
  };
  const row = { c: "100", k: TSUNAMI_CLASS, first: { raw: nullable(text(LIMIT.time)), cond: nullable(cut(LIMIT.firstWave)) },
    h: nullable({ raw: text(LIMIT.height), cut: BOOL }) };
  const unkeyed = { name: cut(LIMIT.unkeyedName), k: TSUNAMI_CLASS };
  const forecast = { ...header, rows: array(66, row), unkeyed: array(8, unkeyed) };
  const closed = { eventId: text(LIMIT.eventId), family: widest("VTSE51", "VTSE52"), closedAt: MS }; // 閉じた印は開ける part が無いので ref を持たない（統合担当の決め 2026-11-21）
  return bytes({
    forecasts: array(events, forecast), omittedEvents: MS,
    composites: array(paintOperations, { forecast: array(66, ["100", TSUNAMI_CLASS]), observed: array(66, ["100", text(LIMIT.height)]) }),
    // 閉じた観測の印は塗りと別で、3 区分とも残す（ヘルツ r2 #4）。
    closed: array(3, { items: array(4, closed), omitted: MS }),
  });
}

// ---- 地震 ----
function earthquake(paintOperations, municipality) {
  const row = {
    eventId: text(LIMIT.eventId), operation: OPERATION, origin: nullable(text(LIMIT.time)), reportTime: nullable(text(LIMIT.time)),
    hypo: nullable(cut(LIMIT.hypocenter)), mag: nullable({ v: text(LIMIT.valueRaw), desc: text(LIMIT.description), cut: BOOL }),
    depth: nullable({ v: text(LIMIT.valueRaw), desc: text(LIMIT.description), cut: BOOL }), maxInt: LEVEL, cancelled: BOOL,
    tsunami: nullable(cut(LIMIT.tsunamiEval)), strongest: array(8, "99999999"), omittedStrongest: MS, marks: MARKS,
    // 既知でない区域の件数（EEW・津波と同じ置き方、表 §1.1）。U-Q は同じ階層の重複を parser が断る（seismic.ts:125〜:129）ので dupAreas は持たない。
    unknownAreas: MS,
    // 最も強い地域のコードは decode が通す 8 桁で数える（統合担当の決め 2026-11-21）。日次行の ref は id だけが必ずあり、rev は同じ snapshot に event があるときだけ（表 §5.6）。
    ref: { id: text(64), rev: nullable(text(64)) },
  };
  const longPeriod = { eventId: text(LIMIT.eventId), operation: OPERATION, reportTime: nullable(text(LIMIT.time)), maxLg: LEVEL, marks: MARKS, unknownAreas: MS, ref: REF };
  return bytes({
    rows: array(15, row),
    daily: array(3, { operation: OPERATION, count: MS, maxInt: LEVEL }),
    // 合成は行に出ない地震（前の日・6 件目から）も含むので、合成ごとに既知でない区域の件数を持つ。
    composites: array(paintOperations, { areas: municipality ? municipalityComposite : subareaComposite, unknownAreas: MS }),
    longPeriods: array(2, longPeriod), omittedLongPeriods: MS,
    longPeriodComposites: array(paintOperations, { areas: array(188, ["622", COMP_LEVEL]), unknownAreas: MS }),
  });
}

// ---- 3 分野共通 ----
// summary wrapper の最大 3,882（p2-snapshot-sse.json:73）。full の wrapper はこれより小さいので上界に使う。
const WRAPPER = 3882;
// 読めない報のカード 8 枚（checkpoint.ts:688〜:690）。1 枚の題と見出し以外の欄は r3 §3 の 459 byte。
const CARD_OTHER = 3531 - 2 * 1536;
// 短く切るカードは題と見出しを {text, cut} にする（表 §1.3、契約 AC03）。字の欄を object にした分の増え（1 欄 21 byte）。
const CUT_OVERHEAD = bytes(cut(0)) - bytes(text(0));
const cards = (title, headline, cutMarks) => 8 * (CARD_OTHER + title + headline + (cutMarks ? 2 * CUT_OVERHEAD : 0)) + 28;

function total({ paint, events, municipality, shortCards, fullComment }) {
  const paintOperations = paint === "operation" ? 3 : 1;
  const parts = {
    eew: eew(paintOperations),
    tsunami: tsunami(events, paintOperations, fullComment ? LIMIT.commentFull : LIMIT.comment),
    earthquake: earthquake(paintOperations, municipality),
    wrapperAndCards: 3 * WRAPPER + 3 * (shortCards ? cards(LIMIT.cardTitleShort, LIMIT.cardHeadlineShort, true) : cards(LIMIT.cardTitle, LIMIT.cardHeadline, false)),
  };
  const sum = Object.values(parts).reduce((a, b) => a + b, 0);
  return { ...parts, sum, margin: 262144 - sum };
}

const base = { paint: "normal", events: 3, municipality: true, shortCards: false, fullComment: false };
const groups = {
  "A": base,
  "A短": { ...base, shortCards: true },
  "A-B": { ...base, municipality: false },
  "A-C": { ...base, events: 2 },
  "R": { ...base, paint: "operation" },
  "R短": { ...base, paint: "operation", shortCards: true },
  "R-B": { ...base, paint: "operation", municipality: false },
  "R-C": { ...base, paint: "operation", events: 2 },
  // 作者の分岐の選んだ組（§6）
  "付加文全部": { ...base, fullComment: true },
  "付加文全部＋短": { ...base, fullComment: true, shortCards: true },
  "区分ごと＋短＋付加文全部": { ...base, paint: "operation", shortCards: true, fullComment: true },
  "区分ごと＋短＋付加文全部＋津波2": { ...base, paint: "operation", shortCards: true, fullComment: true, events: 2 },
  "区分ごと＋短＋細分区域": { ...base, paint: "operation", shortCards: true, municipality: false },
};
const rows = Object.entries(groups).map(([name, group]) => ({ name, ...total(group) }));

// ---- 共通部（表 §12、今の型のまま）----
// 今の共通部の上界（connection・worker・persistence・recovery〔digest 16,384・EEW の札 2,048・進み具合 4,096〕・channels・版）。
// p3-recovery.json:952 の保守の再計算 49,443 をそのまま使う（共通部は 65,536 を超えると snapshot 全体が断られる、P2-A8-RES-04）。
const COMMON_EXISTING = 49443;
const common = { existing: COMMON_EXISTING, margin: 65536 - COMMON_EXISTING };

// ---- 新しい経路の全体（表 §3.2）----
// 新しい経路は保護 3 分野と共通部だけ（9 分野は B0 の後の契約が足す）。予算いっぱいの通知と共通部を足しても 1 MiB に入るので、縮退の規則は要らない。
const ruled = rows.find((row) => row.name === "A短");
const newPath = { protected: ruled.sum, notices: 131072, common: 65536, sum: ruled.sum + 131072 + 65536, margin: 1048576 - (ruled.sum + 131072 + 65536) };

// ---- U-Q の当日の行に足す欄の増え（表 §4、契約 AC16）----
// 復元の境界（seismic-unit.ts の boundedValue と recent）は字の長さだけを確かめるので、保存の byte は 1 字が JSON の escape で
// \u00XX の 6 byte になる最悪で数える（1 字 3 byte では足りない）。strongest の区域コードは decode が 1〜8 桁の数字かを確かめる前提。
const esc = (n) => "\u0001".repeat(n);
const mv = widest({ kind: "text", value: esc(32), raw: esc(32) }, { kind: "range", bound: "upper", value: -1.2345678901234567e-300, raw: esc(32) },
  { kind: "missing" });
const rowAdded = { depth: mv, magnitudeDescription: nullable(esc(32)), tsunamiComment: nullable(esc(128)), strongest: array(8, "99999999"), omittedStrongest: MS };
// 行の object に足す鍵の分（外の括弧 2 を除き、前の鍵との区切り 1 を足す）。区分 3 × 5 行。
const recentRow = bytes(rowAdded) - 2 + 1;
const seismicRecent = { perRow: recentRow, rows: 15, growth: 15 * recentRow };

console.log(JSON.stringify({ groups: rows, common, newPath, seismicRecent }, null, 1));
// 裁定の組は A短（作者裁定 2026-11-21 08:24）。保護 3 分野・共通部・新しい経路の全体のどれかが負なら失敗にする。
if (ruled.margin < 0 || common.margin < 0 || newPath.margin < 0) process.exitCode = 1;
