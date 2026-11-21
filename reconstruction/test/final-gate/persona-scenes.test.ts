import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { JsonValue, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { DisplayDomainView, DisplaySeverity, DisplaySummaryItem } from "../../contracts/p2-snapshot-sse.types";
import type { DmdataClassification } from "../../contracts/p3-dmdata-connect.types";
import type { BodyResult, ListHead, UnitWalk } from "../../contracts/p3-recovery.types";
import { createNotificationGate } from "../../src/cli/notification-gate";
import { familyFor } from "../../src/decode-material/decode-material";
import { notificationSettingsFrom } from "../../src/cli/repl";
import { startupPlan, walkStart } from "../../src/recovery/recovery";
import { runtimeUnits } from "../../src/runtime/unit-coverage";
import { PING_INTERVAL_MS, factsOf, runStage1, screenOf } from "../disaster/runner";
import type { Dispatch, RunOptions, SceneAttempt, SceneCapture } from "../disaster/runner";
import { readScenario } from "../disaster/scenario";
import type { Scenario } from "../disaster/scenario";
import { synthesize } from "../disaster/synth";
import type { Frame } from "../disaster/synth";
import { shiftTimestamps } from "../eew-e01/frames.mjs";
import type { Harness } from "../execution-split/owner-harness";
import { observation, vtse41 } from "../tsunami-unit/tsunami-fixture";

// P3-FINAL-GATE-001 発注 3b の T09（AC10）: 筋書きを runner で 2 回流し、1 回目で場面の候補を集めて P3-FG-D-SCENE-RULE で 8 つまで選び、
// 2 回目で選んだ時刻の通知・音の段・snapshot の写し（P3-FG-D-SCENE-TEXT）と評価者用の事実を repo の外へ書く。場面は手で書かない（AC10 (1)）。

const env = process.env;
const MINUTE = 60_000;
const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const jst = (iso: string): number => Date.parse(`${iso}+09:00`);
const jstText = (ms: number): string => `${new Date(ms + 9 * 3_600_000).toISOString().slice(0, 19)}+09:00`;
const fixture = (name: string): string => readFileSync(`test/fixtures/${name}.xml`, "utf8");
const tag = (xml: string, name: string): string | null => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? null;
const frame = (atMs: number, headType: string, xml: string): Frame => ({ atMs, headType, body: Buffer.from(xml), origin: "synthetic", source: "T2" });
const isRecord = (value: JsonValue | undefined): value is Readonly<{ [key: string]: JsonValue }> => typeof value === "object" && value != null && !Array.isArray(value);

// 公開サンプルの報を、報時刻が reportAtMs になるよう全時刻を同じだけ動かし、EventID（と Serial）を替える（disaster.test.ts の variant と同じ形）。
function retimed(name: string, reportAtMs: number, eventId: string, edit: (xml: string) => string = (xml) => xml): string {
  const xml = fixture(name);
  return edit(shiftTimestamps(xml, reportAtMs - Date.parse(tag(xml, "ReportDateTime")!)).replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`));
}
// 同じ地震の報は 1 つの差で動かす（発生時刻と報の間隔を保つ）。
const shiftedBy = (name: string, deltaMs: number, eventId: string, edit?: (xml: string) => string) => {
  const at = Date.parse(tag(fixture(name), "ReportDateTime")!) + deltaMs;
  return { atMs: at, xml: retimed(name, at, eventId, edit) };
};
const finalReport = (xml: string) => xml.replace("</Body>", "<NextAdvisory>この情報をもって、緊急地震速報：最終報とします。</NextAdvisory></Body>");
// 豊後水道の地震の第 1 報（予報 77_01_01・警報 37_01_01）の報時刻。試行 2 の地震はこの列を時刻だけ動かして作る。
const BUNGO_45 = Date.parse("2024-04-17T23:14:57+09:00"), BUNGO_43 = Date.parse("2024-04-17T23:14:59+09:00");

// missed は切断中に出て取り直しで拾う報の本文（T2-saori だけ。T06 が報の組を確かめる）。
type Trial = Readonly<{ scenario: Scenario; dispatches: readonly Dispatch[]; prepare?: RunOptions["prepare"]; missed?: readonly string[] }>;

// 流す順の (受信時刻, headType, 本文の sha256) の列の sha256（scenario.ts の digestOf と同じ形。実電文は telegrams.json の生の文字列）。
function digestOf(frames: readonly Frame[]): string {
  const hash = createHash("sha256");
  for (const item of frames) hash.update(`${item.receivedTime ?? new Date(item.atMs).toISOString()}\t${item.headType}\t${sha256(item.body)}\n`);
  return hash.digest("hex");
}
function ready(id: string, frames: readonly Frame[], startMs: number, endMs: number): Scenario {
  return { kind: "ready", id, frames, digest: digestOf(frames), startMs, endMs, checkpoints: [], expectations: [], synth: null, t0: null };
}
const connection = (startMs: number, lost: number, back: number): Dispatch[] => [{ atMs: startMs, kind: "watchEewWindow" }, { atMs: startMs, kind: "connected" },
  { atMs: lost, kind: "connectionLost" }, { atMs: back, kind: "connected" }];

// 試行 2 の 3 人（作業ノートの試行 2 の設計 P1・P3・P4、時刻は設計の場面）。契約に無い種類の報は流さない（受け取らない）。
// 地名と震度は公開サンプルのもので、設計の地名とは違う。
function trial(id: string): Trial {
  if (id === "T2-naoto") {
    // 直人（EEW 警報だけ）: 02:10 の警報 2 報、02:48 に切断に気付き、03:02 に繋がり直す（S6・S7 の札）。
    const event = "20261020021016", delta = jst("2026-10-20T02:10:24") - BUNGO_43;
    const reports = ["37_01_01_240613_VXSE43", "37_01_02_240613_VXSE43"].map((name) => shiftedBy(name, delta, event));
    const start = jst("2026-10-19T23:50:00");
    return { scenario: ready(id, reports.map((item) => frame(item.atMs, "VXSE43", item.xml)), start, jst("2026-10-20T03:10:00")),
      dispatches: connection(start, jst("2026-10-20T02:48:10"), jst("2026-10-20T03:02:30")) };
  }
  if (id === "T2-yu") {
    // 悠（EEW 予報だけ）: 地震 A の続報と最終報、別の地震 B と B の取消、切断と繋がり直しの後に A の第 3 報がもう一度届く（S7）。
    // 77_01_04 から先は警報の地域を含むので、予報の小さい地震として 77_01_01・77_01_03 だけを使い、最終報は 77_01_03 の Serial を 4 にして作る。
    const a = "20261019233001", b = "20261019233102", deltaA = jst("2026-10-19T23:30:09") - BUNGO_45;
    const [first, third] = ["77_01_01_240613_VXSE45", "77_01_03_240613_VXSE45"].map((name) => shiftedBy(name, deltaA, a));
    const at = (iso: string) => jst(`2026-10-19T${iso}`);
    const other = { atMs: at("23:31:05"), xml: retimed("77_02_01_260101_VXSE45_PLUM", at("23:31:05"), b) };
    // 取消の Serial は PLUM（Serial 3）の続きの 4（P4-PWT2-AC02 (3)、T2-yu#6。取消の型に震源を置く所は無いので震源は直さない）。
    const cancel = { atMs: at("23:31:20"), xml: retimed("77_01_33_240613_VXSE45", at("23:31:20"), b, (xml) => xml.replace(/<Serial>\d+<\/Serial>/, "<Serial>4</Serial>")) };
    const finalAt = at("23:31:38");
    const frames = [first, third, other, cancel].map((item) => frame(item.atMs, "VXSE45", item.xml));
    // 第 3 報と最終報の間に、第 3 報の予報のまま Serial を進めた続報を 10 秒ごとに挟み、最終報も第 3 報から作る（P4-PWT-AC06 (11)、帳簿 T2-yu.md:24）。
    // 変えるのは送信・発表・対象の時刻と Serial（と最終報の印）だけで、発生時刻は動かさない。予報の続報は通知を出さないので、演じ手の通知の数は変わらない。
    const resent = (atMs: number, serial: number) => third.xml.replace(/<DateTime>[^<]*<\/DateTime>/, `<DateTime>${new Date(atMs).toISOString().slice(0, 19)}Z</DateTime>`)
      .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${jstText(atMs)}</ReportDateTime>`)
      .replace(/<TargetDateTime>[^<]*<\/TargetDateTime>/, `<TargetDateTime>${jstText(atMs)}</TargetDateTime>`).replace(/<Serial>\d+<\/Serial>/, `<Serial>${serial}</Serial>`);
    const updates = Array.from({ length: 8 }, (_, index) => at("23:30:21") + index * 10_000).map((atMs, index) => frame(atMs, "VXSE45", resent(atMs, 4 + index)));
    frames.push(...updates, frame(finalAt, "VXSE45", finalReport(resent(finalAt, 4 + updates.length))));
    const start = at("23:20:00");
    return { scenario: ready(id, frames.sort((x, y) => x.atMs - y.atMs), start, jst("2026-10-20T00:05:00")),
      dispatches: [...connection(start, at("23:52:10"), at("23:58:40")), { atMs: at("23:58:41"), kind: "frame", frame: frame(at("23:58:41"), "VXSE45", third.xml) }] };
  }
  if (id === "T2-saori") return saori(id);
  throw new Error(`unknown trial ${id}`);
}

// 沙織（EEW 警報＋予報＋地震・津波、千葉県九十九里・外房）: EEW・震度速報・津波警報の後に切断し、切断中に出た VXSE53・大津波警報への引上げ・
// 津波の観測を、繋がり直しの取り直しで拾う（S5〜S7）。取り直しの口は偽物で、一覧はその時刻までに受けた報だけを返す（P3-FG-D-T2-RECONNECT=A）。
function saori(id: string): Trial {
  const event = "20261019181202", at = (iso: string) => jst(`2026-10-19T${iso}`), delta = at("18:12:06") - BUNGO_45;
  // 予報も受ける契約なので VXSE43 は流さない（本物の host は eew.forecast の接続で VXSE43 を捨てる、P3-ED43-AC01。SCENE-TEXT の 2026-11-15 夕の (iv)）。
  const eew: Frame[] = ["77_01_01_240613_VXSE45", "77_01_03_240613_VXSE45", "77_01_04_240613_VXSE45"].map((name) => {
    const item = shiftedBy(name, delta, event);
    return frame(item.atMs, "VXSE45", item.xml);
  });
  const last = shiftedBy("77_01_26_240613_VXSE45", delta, event, finalReport);
  eew.push(frame(last.atMs, "VXSE45", last.xml));
  // 別々の公開サンプルを 1 つの地震に束ねるので、地震の報の震源・発生時刻・見出しの時刻を EEW の最後の報に揃え、津波警報の後の VXSE53 の
  // 「津波の心配はありません」を発表中の付加文に替える（P4-PWT-AC06 (10)、帳簿 T2-saori.md:24・:40）。VXSE51 は発生時刻を TargetDateTime に持つ。
  const origin = tag(last.xml, "OriginTime")!, hypocenter = /<Hypocenter><Area><Name>([^<]*)<\/Name><Code type="震央地名">([^<]*)<\/Code>(<jmx_eb:Coordinate[^>]*>[^<]*<\/jmx_eb:Coordinate>)/.exec(last.xml)!;
  const clock = (ms: number) => { const date = new Date(ms + 9 * 3_600_000); return `${date.getUTCDate()}日${String(date.getUTCHours()).padStart(2, "0")}時${String(date.getUTCMinutes()).padStart(2, "0")}分`
    .replace(/\d/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)); };
  const sameQuake = (xml: string) => {
    const from = /<Hypocenter>\s*<Area>\s*<Name>([^<]*)<\/Name>\s*<Code type="震央地名">([^<]*)<\/Code>\s*(<jmx_eb:Coordinate[^>]*>[^<]*<\/jmx_eb:Coordinate>)/.exec(xml);
    return (from == null ? xml : xml.split(from[1]).join(hypocenter[1]).replace(`<Code type="震央地名">${from[2]}</Code>`, `<Code type="震央地名">${hypocenter[2]}</Code>`).replace(from[3], hypocenter[3]))
      .replace(/<OriginTime>[^<]*<\/OriginTime>/, `<OriginTime>${origin}</OriginTime>`).replace(/[０-９]+日[０-９]+時[０-９]+分ころ/g, `${clock(Date.parse(origin))}ころ`);
  };
  // 津波の報は JST の時刻で渡し、見出しを区分に合う文にして、区域に到達予想時刻と予想の高さを入れる（AC06 (10)、帳簿 T2-saori.md:28・:32・:36）。
  const coast = (kind: string) => [{ code: "310", name: "千葉県九十九里・外房", kind }, { code: "300", name: "茨城県", kind: "62" },
    { code: "311", name: "千葉県内房", kind: "62" }, { code: "320", name: "伊豆諸島", kind: "62" }, { code: "312", name: "東京湾内湾", kind: "62" }];
  const height: Readonly<Record<string, readonly [string, string]>> = { "52": ["10", "１０ｍ"], "51": ["3", "３ｍ"], "62": ["1", "１ｍ"] };
  const tsunami = (atMs: number, kind: string) => vtse41({ eventId: event, at: jstText(atMs), areas: coast(kind) })
    .replace("<Headline><Text>合成の報</Text></Headline>", `<Headline><Text>${kind === "52" ? "大津波警報" : "津波警報"}・津波注意報を発表しました。ただちに避難してください。</Text></Headline>`)
    .replace('<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">', '<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">')
    .replace(/<Code>(\d+)<\/Code><\/Kind><\/Category><\/Item>/g, (_whole, code: string) => `<Code>${code}</Code></Kind></Category><FirstHeight><ArrivalTime>${jstText(at("18:45:00"))}</ArrivalTime></FirstHeight>`
      + `<MaxHeight><jmx_eb:TsunamiHeight type="津波の高さ" unit="m" description="${height[code]?.[1] ?? ""}">${height[code]?.[0] ?? "NaN"}</jmx_eb:TsunamiHeight></MaxHeight></Item>`);
  const live = [...eew, frame(at("18:13:40"), "VXSE51", sameQuake(retimed("32-35_01_01_260824_VXSE51", at("18:13:40"), event))
    .replace(/<TargetDateTime>[^<]*<\/TargetDateTime>/, `<TargetDateTime>${origin}</TargetDateTime>`)),
  frame(at("18:15:20"), "VTSE41", tsunami(at("18:15:20"), "51"))].sort((x, y) => x.atMs - y.atMs);
  // 切断中に出た報（一覧の頭と本文）。
  const missed: readonly (readonly [ListHead, string])[] = [
    // 時刻は切断（18:17:15）より後、規模は EEW の最後の報の Magnitude（P4-PWT2-AC02 (1)(2)、T2-saori#5・#10。震度の地域と津波の沿岸は公開の型の都合で直さない）。
    [head("m1", "U-Q", "VXSE53", at("18:17:40"), "震源・震度に関する情報", event, "1"), sameQuake(retimed("32-35_04_04_240613_VXSE53", at("18:17:40"), event))
      .replace(/<jmx_eb:Magnitude[^>]*>[^<]*<\/jmx_eb:Magnitude>/, /<jmx_eb:Magnitude[^>]*>[^<]*<\/jmx_eb:Magnitude>/.exec(last.xml)![0])
      .replace(/<ForecastComment[\s\S]*?<\/ForecastComment>/, "<ForecastComment codeType=\"固定付加文\"><Text>津波警報等（大津波警報・津波警報あるいは津波注意報）を発表中です。</Text><Code>0211</Code></ForecastComment>")],
    [head("m2", "U-T", "VTSE41", at("18:21:10"), "津波警報", event, null), tsunami(at("18:21:10"), "52")],
    [head("m3", "U-T", "VTSE51", at("18:23:00"), "津波観測に関する情報", event, "1"), observation({ eventId: event, at: jstText(at("18:23:00")), serial: 1,
      stations: [{ code: "31001", name: "銚子", condition: "第１波", height: "0.4" }] })
      .replace("<Headline></Headline>", `<Headline><Text>${clock(at("18:23:00"))}現在の、津波の観測値をお知らせします。</Text></Headline>`)
      .replace("<Area><Name>岩手県</Name><Code>210</Code></Area>", "<Area><Name>千葉県九十九里・外房</Name><Code>310</Code></Area>")],
  ];
  const start = at("17:50:00");
  const units: readonly RuntimeUnitId[] = ["U-T", "U-Q"];
  const prepare = async (h: Harness) => {
    const listed = (plan: readonly Pick<UnitWalk, "unit" | "fetchFromMs">[]) => plan.map(({ unit, fetchFromMs }) => ({ unit, kind: "listed" as const,
      heads: missed.map(([item]) => item).filter((item) => item.unit === unit && item.receivedAtMs >= fetchFromMs && item.receivedAtMs <= h.clock().wallTimeMs) }));
    const bodies = new Map(missed.map(([item, xml]) => [item.id, xml]));
    h.root.attachRecovery({ classifications: ["telegram.earthquake"], walk: async (plan) => listed(plan), notBefore: () => -Infinity,
      fetchBody: async (item): Promise<BodyResult> => {
        const xml = bodies.get(item.id);
        return xml == null ? { kind: "failed" } : { kind: "ok", bytes: Buffer.from(xml), contentType: "application/xml" };
      } }, Object.fromEntries(units.map((unit) => [unit, walkStart(null, "empty", h.clock().wallTimeMs)])),
    Promise.resolve(listed(units.map((unit) => ({ unit, fetchFromMs: -Infinity })))));
  };
  return { scenario: ready(id, live, start, at("18:30:00")), dispatches: connection(start, at("18:17:15"), at("18:24:15")), prepare, missed: missed.map(([, xml]) => xml) };
}
function head(id: string, unit: RuntimeUnitId, headType: string, receivedAtMs: number, title: string, eventId: string, serial: string | null): ListHead {
  return { id, unit, headType, receivedAtMs, operation: "normal", title, headline: null, reportDateTime: null, infoType: "発表", serial, eventId,
    controlDateTime: null, controlStatus: "通常", test: false, editorialOffice: null };
}

// 製品の定数（composition-root.ts の RECOVERY_GAP_MS〔P3-REC-D-COALESCE=A〕と EEW_CONFIRM_MS〔P3-REC-D-EEW-CONFIRM=B〕）。export されておらず src は
// 本契約で変えないので、定義の行から読む（値を写すと製品を変えたときに古びる）。行が無ければ例外。
// 受けるのは整数 1 つか、整数 2 つの 1 回の積（10 * 60_000）だけ。ほかの書き方（** など）は読み違えないよう例外にする。
function productMs(name: string, source = readFileSync("reconstruction/src/runtime/composition-root.ts", "utf8")): number {
  const found = new RegExp(`^const ${name} = (\\d[\\d_]*)(?: \\* (\\d[\\d_]*))?;`, "m").exec(source);
  if (found == null) throw new Error(`${name} is not defined as an integer or a product of two integers in composition-root.ts`);
  return Number(found[1].replace(/_/g, "")) * Number((found[2] ?? "1").replace(/_/g, ""));
}

// P4-PWT-AC05 (1)（実不具合 N1.md:30）: AC09 の筋書きにも試行 2 と同じ始まりの操作と、起動の取り直しの空の一覧を渡す。無いと確認状態が全部 startup のまま残る。
// unit と束は host と同じく startupPlan が契約の区分で決める（telegram.* の無い契約は null で、host も attachRecovery を呼ばない）。本文は取らない。
// tick は接続から 60 秒（最初の接続のきっかけの取り直しの待ち）と 600 秒（U-E の確認）の 2 点だけ足す。製品は 1 秒ごとに tick するので、無いと
// 2 つの確認が次の frame の後の tick まで遅れる（R2 の S1 の U-Q・S3 の U-E、実装レビュー）。毎秒にはしない（AC09 の長い筋書きの run の時間）。
function connectionLayer(startMs: number, classifications: readonly DmdataClassification[]): Pick<Trial, "dispatches" | "prepare"> & Pick<RunOptions, "everySecond"> {
  const prepare = async (h: Harness) => {
    const walk = startupPlan(classifications, h.root.restoredBoundaries, h.clock().wallTimeMs);
    if (walk == null) return;
    const empty = (plan: readonly Pick<UnitWalk, "unit">[]) => plan.map(({ unit }) => ({ unit, kind: "listed" as const, heads: [] }));
    h.root.attachRecovery({ classifications, walk: async (plan) => empty(plan), notBefore: () => -Infinity,
      fetchBody: async (): Promise<BodyResult> => ({ kind: "failed" }) }, walk.starts, Promise.resolve(empty(walk.plan)));
  };
  return { dispatches: [{ atMs: startMs, kind: "watchEewWindow" }, { atMs: startMs, kind: "connected" }], prepare,
    everySecond: [productMs("RECOVERY_GAP_MS"), productMs("EEW_CONFIRM_MS")].map((ms) => ({ fromMs: startMs + ms, toMs: startMs + ms })) };
}

// ---- P3-FG-D-SCENE-RULE ----

const RANKS = ["ii", "iii", "iv", "v", "vi", "vii", "i"] as const;
type Item = (typeof RANKS)[number];
type Candidate = Readonly<{ item: Item; atMs: number }>;
const levelOf = (attempt: SceneAttempt): string | null => attempt.soundAsset == null ? null : /-([a-z]+)\.wav$/.exec(attempt.soundAsset)?.[1] ?? null;

function candidatesOf(scenario: Extract<Scenario, { kind: "ready" }>, result: Readonly<Record<string, JsonValue>>, dispatches: readonly Dispatch[],
  log: Readonly<{ attempts: readonly SceneAttempt[]; newSubjects: readonly number[]; deadlines: readonly number[] }>): Candidate[] {
  const found: Candidate[] = [];
  const add = (item: Item, times: readonly number[]) => { for (const atMs of times) found.push({ item, atMs }); };
  add("ii", log.attempts.filter((item) => item.priorityGroup === "normalEew" || item.priorityGroup === "normalTsunamiEmergency").map((item) => item.atMs));
  let level: string | null | undefined;
  for (const attempt of log.attempts.filter((item) => item.channel === "sound")) {
    if (levelOf(attempt) !== level) found.push({ item: "iii", atMs: attempt.atMs });
    level = levelOf(attempt);
  }
  const transitions = result["summaryTransitions"];
  add("iv", Array.isArray(transitions) ? transitions.flatMap((item) => isRecord(item) && typeof item["atMs"] === "number" ? [item["atMs"]] : []) : []);
  // 最初の接続は切断と繋がり直しに数えない。
  add("v", dispatches.filter((item, index) => item.kind === "connectionLost" || (item.kind === "connected" && dispatches.slice(0, index).some((before) => before.kind === "connectionLost")))
    .map((item) => item.atMs));
  add("vi", log.newSubjects);
  add("vii", log.deadlines);
  add("i", scenario.expectations.map((item) => item.atMs));
  return found;
}

// 同じ 60 秒の内の候補は最初の 1 つにまとめ、順位の高い項から 1 つずつ（項の中では最も早い時刻）採る周を 8 つまで繰り返す。
function choose(found: readonly Candidate[]): Candidate[] {
  const merged: Candidate[] = [];
  for (const item of [...found].sort((a, b) => a.atMs - b.atMs || RANKS.indexOf(a.item) - RANKS.indexOf(b.item)))
    if (merged.length === 0 || item.atMs >= merged[merged.length - 1].atMs + MINUTE) merged.push(item);
  const queues = RANKS.map((rank) => merged.filter((item) => item.item === rank));
  const chosen: Candidate[] = [];
  while (chosen.length < 8 && queues.some((queue) => queue.length > 0))
    for (const queue of queues) { const next = queue.shift(); if (next != null && chosen.length < 8) chosen.push(next); }
  return chosen.sort((a, b) => a.atMs - b.atMs);
}

// P4-PWT-AC08 (3): W1 は前日の 18:00 から流すが、場面はその日の 0 時から選ぶ（前日の分は最初の場面の通知に入る）。
const sinceMidnight = (id: string, found: readonly Candidate[]): Candidate[] => id.startsWith("W1:") ? found.filter((item) => item.atMs >= jst(`${id.slice(3)}T00:00:00`)) : [...found];

// ---- 場面の file ----

// W1 は 4 人目の千尋（P4-PWT-D-W1-PERSONA=A）。W2 と N3 は歩きに回さない（P4-PWT-D-N3=A・P4-PWT-AC07 (1)）。
const PERSONAS: Readonly<Record<string, string>> = { "T2-naoto": "直人", N1: "沙織", N2: "沙織", R2: "沙織", "T2-saori": "沙織", "T2-yu": "悠" };
// 人物の契約の区分（P4-PWT-AC07 (1)。AC05 (1) の取り直しの classifications にも使う）。
const CLASSIFICATIONS: Readonly<Record<string, readonly DmdataClassification[]>> = { 直人: ["eew.warning"], 悠: ["eew.forecast"],
  沙織: ["eew.warning", "eew.forecast", "telegram.earthquake"], 千尋: ["telegram.weather", "eew.warning"] };
// P4-PWT-AC07（Q3=A）: 人物の契約の区分の報だけを流す（familyFor）。予報も受ける契約では VXSE43 も流さない（host の捨て、P3-ED43-AC01）。
// 無いと、直人に W1 の気象を全部流し、沙織に VXSE43 の警報の行が VXSE45 と 2 行並ぶ。
// shortcut: 捨てた VXSE43 の recordInput は写さない。合成の VXSE43 は同じ報の VXSE45 と同じ時刻に流れるので lastInputAt は変わらない。VXSE43 だけが来る筋書きを足すときは received() だけ呼ぶ形にする。
const contracted = (frames: readonly Frame[], classifications: readonly DmdataClassification[]): Frame[] => frames.filter((item) =>
  classifications.some((classification) => classification === familyFor(item.headType)) && !(item.headType === "VXSE43" && classifications.includes("eew.forecast")));
// 本体の hash（disaster.test.ts の bodyHash と同じく run の所要と自己 hash を除く）。
const bodyHash = (text: string): string => {
  const parsed: JsonValue = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("result is not a record");
  return sha256(JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "timing" && key !== "selfSha256"))));
};

// P4-PWT-AC01（Q2=A）: 歩きの通知は、CLI が既定の設定（設定ファイルが空）で host に渡す門を通るものだけ。既定の設定は mute が無いので時計を読まない。
const fixedClock = () => ({ wallTimeMs: 0, monotonicMs: 0 });
const defaultGate = createNotificationGate(notificationSettingsFrom({}, fixedClock), fixedClock);
// 門で止めた段（通れば null）。門が読むのは channel・unit・subject・payload の level だけなので、場面の試行に無い欄は空の値で埋める。
function stoppedAt(attempt: SceneAttempt): "sound" | "category" | "mute" | null {
  const unit = runtimeUnits.find((item) => item === attempt.unit);
  if (unit == null) throw new Error(`unknown unit ${attempt.unit}`);
  const verdict = defaultGate({ ...attempt, unit, attemptId: "", intentId: "", operation: "normal", selectedAtMonotonicMs: 0, timeoutAtMonotonicMs: 0, expiresAt: 0 });
  return verdict.allow ? null : verdict.stage;
}
const passed = (attempt: SceneAttempt): boolean => stoppedAt(attempt) == null;

// 通知の 1 行。count は題名ごとの件数の鍵（音の試行は題名が無いので「（音）資材の名前」）、rank は 20 件に絞るときの段の重さ。
// pair は同じ時刻・unit・subject の desktop と音を 1 行にまとめる鍵（切断の行は無い。P4-PWT2-AC01 (2)）。
// 取消は最も重く置く（先に省くと、演じ手は取り消されていない警報だけを見て、製品の画面に無い状態になる。P4-PWT-AC02）。
type Notice = Readonly<{ atMs: number; rank: number; count: string; pair: string | null; json: Readonly<Record<string, JsonValue>> }>;
const LEVEL_RANK: Readonly<Record<string, number>> = { cancel: 4, critical: 3, warning: 2, normal: 1 };
const assetOf = (attempt: SceneAttempt): string | null => attempt.soundAsset?.replace(/^.*\//, "").replace(/\.wav$/, "") ?? null;
function noticeOf(attempt: SceneAttempt): Notice {
  const { title, body, level } = attempt.payload;
  return { atMs: attempt.atMs, rank: LEVEL_RANK[String(level)] ?? 0, count: attempt.channel === "desktop" ? String(title ?? "") : `（音）${assetOf(attempt) ?? ""}`,
    pair: `${attempt.atMs}\t${attempt.unit}\t${attempt.subject}`,
    json: attempt.channel === "desktop" ? { at: jstText(attempt.atMs), channel: "desktop", title: title ?? null, body: body ?? null }
      : { at: jstText(attempt.atMs), channel: "sound", sound: assetOf(attempt) } };
}
// P4-PWT-AC03（実不具合 T2-naoto:40）: 切断の desktop 通知は端末の出力（output.ts の lost）が adapter を通さずに出すので runner が拾わない。
// 接続中の connectionLost ごとに同じ字の 1 行を足す（host は確立した接続を失ったときだけ数える。繋がり直さずに続く切断と、接続の無い切断には出ない）。
// 接続中かは dispatch の順で最後の接続か切断かで見る（runner の connectionLost と同じ）。時刻は切断の時点の最後の受信で、runner と同じ規則
// （P4-PWT-AC04 (2)）: 最後の frame・接続と、最後の接続から ping の間隔の倍数で切断を越えない最後の時刻の遅い方。
// shortcut: 30 分で 3 回の「回線が不安定です」のまとめ・mute・connection の分野の設定は写さない。試行 2 は切断が 1 回だけ。切断の多い筋書きを足すときに写す。
function connectionNotices(dispatches: readonly Dispatch[], frames: readonly Frame[]): Notice[] {
  return dispatches.flatMap((item, index) => {
    const before = dispatches.slice(0, index), last = before.filter((step) => step.kind === "connected" || step.kind === "connectionLost").at(-1);
    if (item.kind !== "connectionLost" || last?.kind !== "connected") return [];
    const from = Math.max(last.atMs + Math.floor((item.atMs - last.atMs) / PING_INTERVAL_MS) * PING_INTERVAL_MS,
      ...frames.filter((frame) => frame.atMs <= item.atMs).map((frame) => frame.atMs), ...before.filter((step) => step.kind === "frame").map((step) => step.atMs));
    return [{ atMs: item.atMs, rank: 0, count: "FlEq", pair: null, json: { at: jstText(item.atMs), channel: "desktop", title: "FlEq",
      body: `回線が切れました（${jstText(from).slice(11, 19)} から受信できていません）` } }];
  });
}

// 演じ手には前の場面からの通知の 20 件と、題名ごとの件数と「ほか n 件」だけを渡す（統合担当の決め、SCENE-TEXT の追加の「渡す量を絞る」の内。
// 23 時間分の 1,844 件を 1 場面で読む利用者はいない）。評価者の file は全部を持つ。
const NOTIFICATION_LIMIT = 20;
// P4-PWT2-AC01 (2)（実不具合 W1-06-03#1 ほか族 S）: 同じ時刻・unit・subject の desktop と音の試行を 1 行にまとめ、行に sound（資材の名前か null）を持たせる。
// 段は 2 つの重い方、件数の鍵は desktop の題名。無いと、音の無い desktop 通知を演じ手が鳴ったと読む。音だけの試行は音の行のまま。
function paired(notices: readonly Notice[]): Notice[] {
  const sounds = new Map<string, Notice>();
  for (const notice of notices) if (notice.pair != null && notice.json["channel"] === "sound" && !sounds.has(notice.pair)) sounds.set(notice.pair, notice);
  const used = new Set<Notice>();
  const rows = notices.flatMap((notice): Notice[] => {
    if (notice.json["channel"] !== "desktop") return [notice];
    const sound = notice.pair == null ? undefined : sounds.get(notice.pair);
    if (sound != null) { used.add(sound); sounds.delete(notice.pair ?? ""); }
    return [{ ...notice, rank: Math.max(notice.rank, sound?.rank ?? 0), json: { ...notice.json, sound: sound?.json["sound"] ?? null } }];
  });
  return rows.filter((notice) => !used.has(notice));
}
function notificationsOf(all: readonly Notice[]): Readonly<{ notifications: JsonValue[]; notificationCounts: Record<string, number>; notificationsOmitted: number;
  omittedCounts: Record<string, number>; omittedFrom: string | null; omittedTo: string | null }> {
  const notices = paired(all);
  const counts: Record<string, number> = {};
  for (const notice of notices) counts[notice.count] = (counts[notice.count] ?? 0) + 1;
  // P4-PWT-AC02（実不具合: R2 S6 の 03:20 の大津波警報、W1-09-21 S8 の大島の L5 が新しい順の 20 件の切りで落ちた）: 段の重い順・同じ段は新しい順に残し、時刻の順に戻す。
  // P4-PWT2-AC01 (1)（実不具合 N1#7・N2#9: 同じ題名の critical の 25 件が、題名の違う warning・normal の最終報や解除を押し出した）: 先に題名と段の組ごとの新しい 1 件を採り、残りの枠をその順で埋める。
  const ordered = notices.map((notice, index) => ({ notice, index })).sort((a, b) => b.notice.rank - a.notice.rank || b.index - a.index);
  const groups = new Set<string>();
  const firsts = ordered.filter(({ notice }) => { const key = `${notice.count}\t${notice.rank}`; return !groups.has(key) && groups.add(key); }).slice(0, NOTIFICATION_LIMIT);
  const chosen = new Set([...firsts, ...ordered.filter((item) => !firsts.includes(item))].slice(0, NOTIFICATION_LIMIT));
  const kept = [...chosen].sort((a, b) => a.index - b.index);
  // P4-PWT2-AC01 (3)（実不具合 R2#8・W1-06-03#7）: 省いた行だけの題名ごとの数と、省いた行の最初と最後の時刻。
  const omitted = ordered.filter((item) => !chosen.has(item)).sort((a, b) => a.index - b.index);
  const omittedCounts: Record<string, number> = {};
  for (const { notice } of omitted) omittedCounts[notice.count] = (omittedCounts[notice.count] ?? 0) + 1;
  return { notifications: kept.map(({ notice }) => notice.json), notificationCounts: counts, notificationsOmitted: omitted.length, omittedCounts,
    omittedFrom: omitted.length === 0 ? null : jstText(omitted[0].notice.atMs), omittedTo: omitted.length === 0 ? null : jstText(omitted[omitted.length - 1].notice.atMs) };
}
// 時刻の順（同じ時刻は元の順、試行が切断の行より先）。
const byTime = (list: readonly Notice[]): Notice[] => [...list].sort((a, b) => a.atMs - b.atMs);
// P4-PWT-AC05 (2)（実不具合 T2-naoto.md:29）: 製品は items から確認状態の行を出すので、演じ手の screen の full の分野に要約の分野と同じ 3 欄を添える。
// shortcut: 演じ手の画面は snapshot の写しで、chrome-eew の行ごとの一致は別の項（バックログ）。
type Shown = NonNullable<SceneCapture["screen"]>["current"][string];
type ActorDomain = Exclude<Shown, { delivery: "full" }>
  | (Extract<Shown, { delivery: "full" }> & Readonly<{ items: readonly Pick<DisplaySummaryItem, "operation" | "confirmation" | "unconfirmed">[] }>);
function actorScreen(scene: SceneCapture) {
  const { screen, fullScreen } = scene;
  // 2 つは同じ snapshot から作るので、片方だけ null にはならない。
  if (screen == null || fullScreen == null) return null;
  const current: Record<string, ActorDomain> = {};
  for (const [key, domain] of Object.entries(fullScreen.current)) {
    const shown = screen.current[key];
    if (shown != null) current[key] = shown.delivery !== "full" ? shown
      : { ...shown, items: domain.items.map(({ operation, confirmation, unconfirmed }) => ({ operation, confirmation, unconfirmed })) };
  }
  return { ...screen, current };
}
// 演じ手の file の中身（P4-PWT-AC01〜AC03・AC05 (2)）。T09 が書き、T05 が同じ関数の結果を確かめる。
function actorFile(head: Readonly<Record<string, JsonValue>>, scene: SceneCapture, lines: readonly Notice[]) {
  return { ...head, ...notificationsOf(byTime([...scene.attempts.filter(passed).map(noticeOf), ...lines])), screen: actorScreen(scene) };
}
// T09 の場面の run の設定。試行 2 は本物の host と同じく 1 秒ごとに tick する（取り直しの開始・札の射影は publisher の tick が起こす。格子を飛ばすと
// 繋がり直しの後に何も起きない）。AC09 の筋書きは接続の層（P4-PWT-AC05 (1)、2 点の tick つき）を、流し始め（runner と同じく最初の frame が早ければそこ）から渡す。
// T05 も同じ関数を通る。
function sceneRun(scenario: Scenario, t2: Trial | null, classifications: readonly DmdataClassification[]): Readonly<{ dispatches: readonly Dispatch[];
  options: (scenes: RunOptions["scenes"]) => RunOptions }> {
  const ready = scenario.kind === "ready" ? scenario : null;
  const layer = t2 == null ? ready == null ? null : connectionLayer(Math.min(ready.startMs, ready.frames[0]?.atMs ?? Infinity), classifications)
    : { dispatches: t2.dispatches, prepare: t2.prepare, everySecond: ready == null ? [] : [{ fromMs: ready.startMs, toMs: ready.endMs }] };
  const dispatches = layer?.dispatches ?? [];
  // 1 回の run は 35 分で止めて blocked にする（2 回で 75 分の timeout に収め、落ちる前に index を書く）。
  return { dispatches, options: (scenes) => ({ scenes, budgetMs: 35 * MINUTE, dispatches, ...layer?.prepare == null ? {} : { prepare: layer.prepare },
    ...layer?.everySecond == null ? {} : { everySecond: layer.everySecond } }) };
}

describe.runIf(env["FLEQ_C22_SCENES"] != null)("P3-FINAL-GATE-001 persona scenes", () => {
  it("P3-FG-T09 acceptance / AC10: scenes are cut from two identical runs by the scene rule and written outside the repo", async () => {
    const id = env["FLEQ_C22_SCENES"]!, out = env["FLEQ_C22_SCENES_OUT"];
    if (out == null) throw new Error("FLEQ_C22_SCENES_OUT is required");
    const t2 = id.startsWith("T2-") ? trial(id) : null;
    const scenario = t2?.scenario ?? readScenario({ id, dataDir: env["FLEQ_DISASTER_DATA"] ?? null, expectedDigest: env["FLEQ_DISASTER_DIGEST"] ?? null });
    const persona = id.startsWith("W1:") ? "千尋" : PERSONAS[id] ?? null, classifications = CLASSIFICATIONS[persona ?? ""];
    if (classifications == null) throw new Error(`no persona contract for ${id}`);
    // 流すのは人物の契約で絞った列で、digest は絞った後の列で取り直す（P4-PWT-AC07 (2)）。AC09 との照合は絞る前の digest で行う。
    const kept = scenario.kind === "ready" ? contracted(scenario.frames, classifications) : [];
    const walked: Scenario = scenario.kind === "ready" ? { ...scenario, frames: kept, digest: digestOf(kept) } : scenario;
    const { dispatches, options } = sceneRun(walked, t2, classifications);
    const dir = join(out, id.replace(/[^A-Za-z0-9-]/g, "-"));
    mkdirSync(dir, { recursive: true });
    const blocked: string[] = [];

    const first = await runStage1(walked, options({ times: [], write: () => {} }));
    // 門で止めた試行は場面の候補にしない（P4-PWT-AC01）。
    const chosen = walked.kind === "ready" && first.scenes != null
      ? choose(sinceMidnight(id, candidatesOf(walked, first.result, dispatches, { ...first.scenes, attempts: first.scenes.attempts.filter(passed) }))) : [];
    const lost = connectionNotices(dispatches, kept);
    // P3-FG-D-EXTERNAL-SEND=A: 採取物の EEW の EventID を含む場面は外部の演じ手に送らない。
    const realEew = kept.filter((item) => item.origin === "real" && /^VXSE4[345]$/.test(item.headType));
    const realIds = new Set(realEew.map((item) => tag(Buffer.from(item.body).toString("utf8"), "EventID") ?? ""));
    const carriesRealEew = (scene: SceneCapture) => [...scene.attempts.filter((item) => item.unit === "U-E").map((item) => item.subject),
      ...(scene.facts["U-E"] ?? []).map((item) => item.subject)].some((subject) => [...realIds].some((eventId) => subject.includes(eventId)));
    const written: SceneCapture[] = [];
    const second = await runStage1(walked, options({ times: chosen.map((item) => item.atMs), write: (scene) => {
      written.push(scene);
      const number = String(written.length).padStart(2, "0"), rule = chosen[written.length - 1]?.item ?? null, externalSend = !carriesRealEew(scene);
      const since = written.at(-2)?.atMs ?? -Infinity, lines = lost.filter((item) => item.atMs > since && item.atMs <= scene.atMs);
      // 外の演じ手に送れない場面は file の名前でも分ける（P3-FG-D-EXTERNAL-SEND=A。中身の印だけだと貼り付けで見落とす）。
      writeFileSync(join(dir, `${number}-actor${externalSend ? "" : "-local-only"}.json`), `${JSON.stringify(actorFile({ scenario: id, persona, scene: written.length, at: jstText(scene.atMs), externalSend }, scene, lines), null, 1)}\n`);
      writeFileSync(join(dir, `${number}-evaluator.json`), `${JSON.stringify({ scenario: id, scene: written.length, at: jstText(scene.atMs), rule,
        // 評価者には門で止めた試行も段の印つきで渡す（P4-PWT-AC01）。
        notifications: byTime([...scene.attempts.map((attempt) => { const notice = noticeOf(attempt); return { ...notice, json: { ...notice.json, stoppedBy: stoppedAt(attempt) } }; }),
          ...lines.map((line) => ({ ...line, json: { ...line.json, stoppedBy: null } }))])
          .map((notice) => notice.json), facts: scene.facts, screen: scene.fullScreen }, null, 1)}\n`);
    } }));

    // (1) 2 回の run は同じ本体（場面の口は観測だけ）。
    const hashes = [bodyHash(first.text), bodyHash(second.text)];
    for (const run of [first, second]) if (run.result["status"] === "blocked") blocked.push(`run blocked: ${JSON.stringify(run.result["blocked"])}`);
    if (hashes[0] !== hashes[1]) blocked.push("bodyHash differs between the two runs");
    // (2) AC09 の筋書きは AC09 の同じ筋書きの結果と流す列の digest（readScenario の、絞る前の列）が一致し、その gitHead から src と災害の日の道具が
    // 変わっていない。場面の run は接続の層を足すので本体は比べない（P4-PWT-D-T09-MATCH=A）。
    let ac09: JsonValue = null;
    if (t2 == null) {
      const path = env["FLEQ_C22_SCENES_AC09"];
      if (path == null) blocked.push("FLEQ_C22_SCENES_AC09 is required for an AC09 scenario");
      else {
        const text = readFileSync(path, "utf8"), recorded: JsonValue = JSON.parse(text);
        const head = isRecord(recorded) && typeof recorded["gitHead"] === "string" ? recorded["gitHead"] : null;
        let unchanged = false;
        try { if (head != null) { execFileSync("git", ["diff", "--quiet", head, "--", "reconstruction/src", "reconstruction/test/disaster"]); unchanged = true; } } catch { unchanged = false; }
        const digestMatches = isRecord(recorded) && recorded["digest"] === scenario.digest;
        ac09 = { path, gitHead: head, digestMatches, sourceUnchanged: unchanged };
        if (!digestMatches) blocked.push("digest differs from the AC09 result");
        if (!unchanged) blocked.push("reconstruction/src or test/disaster changed since the AC09 gitHead");
      }
    }
    const { digest, gitHead, effectiveLimits } = second.result;
    writeFileSync(join(dir, "index.json"), `${JSON.stringify({ contractId: "P3-FINAL-GATE-001", test: "P3-FG-T09", scenario: id, persona, digest, gitHead, effectiveLimits,
      digestBeforeFilter: scenario.digest, digestAfterFilter: walked.digest, droppedFrames: scenario.kind === "ready" ? scenario.frames.length - kept.length : 0,
      bodyHash: hashes, ac09, realEewFrames: realEew.length, blocked,
      scenes: written.map((scene, index) => ({ scene: index + 1, at: jstText(scene.atMs), atMs: scene.atMs, rule: chosen[index]?.item ?? null, externalSend: !carriesRealEew(scene) })) }, null, 1)}\n`);
    console.info(`[P3-FG-T09] ${id} scenes=${written.length} blocked=${JSON.stringify(blocked)} runMs=${JSON.stringify([first.result["timing"], second.result["timing"]])}`);

    expect(blocked).toEqual([]);
    // (3) 場面は 1〜8、各場面の attempt の列と場面の列は時刻の順。
    expect(written.length).toBeGreaterThanOrEqual(1);
    expect(written.length).toBeLessThanOrEqual(8);
    const times = written.flatMap((scene) => [...scene.attempts.map((item) => item.atMs), scene.atMs]);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  }, 75 * MINUTE);
});

// ---- 場面の道具の直し（P3-FG-D-SCENE-TEXT の 2026-11-15 夕の追加の裁定、発注 3b3）。実不具合の再発防止なので門なしで回す ----

describe("P3-FINAL-GATE-001 scene tool fixes (3b3)", () => {
  const row = (operation: Operation, activeCount = 0, highestSeverity: DisplaySeverity | null = null): DisplaySummaryItem => ({ operation, informationType: "eew",
    activeCount, highestSeverity, areaCounts: {}, updatedAt: null, unavailable: {}, unconfirmed: {}, unknownCode: {}, freshness: {}, confirmation: { state: "confirmed", confirmedAt: null } });
  const rows = (activeCount = 0, top: DisplaySeverity | null = null) => [row("normal", activeCount, top), row("training"), row("test")] as const;
  const full = (unit: RuntimeUnitId, view: unknown): DisplayDomainView<unknown> => ({ unit, contentRevision: "1", items: rows(), delivery: "full", view });
  const screen = (current: Readonly<Record<string, DisplayDomainView<unknown>>>) =>
    screenOf({ connection: { state: "connected", disconnectedAt: null, lastInputAt: null }, current, recovery: { eewUnverified: null }, notices: [] });
  const source = (second: number) => ({ subject: "s", reportDateTimeRaw: `2026-10-19T23:00:0${second}+09:00`, serialRaw: "1", infoTypeRaw: "発表" });
  const viewOf = (key: string, current: Readonly<Record<string, DisplayDomainView<unknown>>>): JsonValue => {
    const domain = screen(current).current[key];
    return domain?.delivery === "full" ? domain.view : null;
  };

  it("(i) lists are ordered heaviest and newest first before the screen limit cuts them", () => {
    // 実不具合: 古い警報 1 件と新しい予報 6 件で、上限 6 の切りが警報を落とした。府県は段の重い順（同じ段は更新の新しい順）。
    const current = [{ warningClass: "warning", source: source(0) }, ...[1, 2, 3, 4, 5, 6].map((second) => ({ warningClass: "forecast", source: source(second) }))];
    expect(viewOf("eew", { eew: full("U-E", { current }) })).toMatchObject({ currentOmitted: 1, current: [{ warningClass: "warning", 発表時刻: source(0).reportDateTimeRaw },
      ...[6, 5, 4, 3, 2].map((second) => ({ warningClass: "forecast", 発表時刻: source(second).reportDateTimeRaw }))] });
    const prefecture = (name: string, codes: Readonly<Record<string, number>>, second: number) => ({ prefecture: name, codes, source: source(second),
      areas: [["primary", `${name}-2`], ["prefecture", `${name}-1`]] });
    const areas = [prefecture("注意報の古い", { "10": 1 }, 0), prefecture("警報", { "03": 1 }, 1), prefecture("危険警報", { "43": 2 }, 2),
      prefecture("注意報の新しい", { "13": 1 }, 6), prefecture("特別警報", { "33": 1, "13": 3 }, 3), prefecture("警報の新しい", { "03": 1, "20": 1 }, 5)];
    expect(viewOf("weatherCurrent", { weatherCurrent: full("U-W", { areas }) })).toMatchObject({ areasOmitted: 1,
      areas: ["特別警報", "危険警報", "警報の新しい", "警報", "注意報の新しい"].map((name) => ({ prefecture: name, areas: [["primary", `${name}-2`], ["prefecture", `${name}-1`]] })) });
  });

  it("(ii) a summarized domain keeps the reason and the active count and highest severity of each operation", () => {
    // 実不具合: 要約の分野が {delivery} だけで、大津波警報が有効なことが演じ手に見えなかった。
    const tsunami: DisplayDomainView<unknown> = { unit: "U-T", contentRevision: "1", items: rows(2, "specialWarning"), delivery: "summary", reason: "snapshotBudget",
      originalBytes: 2_000_000, budgetBytes: 1_048_576 };
    const confirmation = { state: "confirmed", confirmedAt: null };
    expect(screen({ tsunami }).current["tsunami"]).toEqual({ delivery: "summary", reason: "snapshotBudget", items: [
      { operation: "normal", activeCount: 2, highestSeverity: "specialWarning", confirmation, unconfirmed: {} },
      { operation: "training", activeCount: 0, highestSeverity: null, confirmation, unconfirmed: {} },
      { operation: "test", activeCount: 0, highestSeverity: null, confirmation, unconfirmed: {} }] });
  });

  it("(iii) EEW prediction areas carry the place name of the same code from the report areas, or keep the code", () => {
    // 実不具合: 予測の地域が code ごと落ちて地名が無く、reportAreas の lgInt の 0 を震度 0 と読ませた。
    const intensity = (to: string) => ({ from: to, to, condition: null, description: null });
    const prediction = { maximum: intensity("5-"), areaCoverage: "present", areas: [{ code: "390", intensity: intensity("5-") }, { code: "391", intensity: intensity("4") }] };
    const reportAreas = [{ code: "390", name: "高知県西部", lgInt: null, arrivalTimeRaw: null }, { code: "391", name: null, lgInt: null, arrivalTimeRaw: null }];
    expect(viewOf("eew", { eew: full("U-E", { current: [{ warningClass: "warning", source: source(0), prediction, reportAreas }] }) })).toMatchObject({
      current: [{ prediction: { areas: [{ name: "高知県西部", intensity: intensity("5-") }, { 地域コード: "391", intensity: intensity("4") }] } }] });
  });

  it("(v) evaluator facts give the display deadline apart from the retention, and a U-W report on a prefecture row is shown", () => {
    // 実不具合: 保持の 24 時間を表示の期限として並べた（EEW の gate）。U-W は view の行が府県なので、報の事実が毎回 shown:false になった（3b3 のレビュー）。
    const subject = "normal/VXSE45/20261019233001", gate = (currentUntil: number | null) => ({ current: [], gates: [{ subject, currentUntil, retainUntil: 90_000 }] });
    expect(factsOf(gate(1_000), [{ subject, source: { subject } }], 500)).toEqual([{ subject, shown: true, until: 1_000, retainUntil: 90_000 }]);
    expect(factsOf(gate(null), [], 2_000)).toEqual([{ subject, shown: false, until: null, retainUntil: 90_000 }]);
    const report = "normal/VPWW55/宇都宮地方気象台", other = "normal/VPWW55/前橋地方気象台";
    const weather = { national: {}, partials: [report, other].map((item) => ({ subject: item, source: { subject: item } })) };
    expect(factsOf(weather, [{ subject: "normal/area/09", source: { subject: report } }], 0)).toEqual([
      { subject: report, shown: true, until: null, retainUntil: null }, { subject: other, shown: false, until: null, retainUntil: null }]);
  });

  it("(iv) T2-saori (forecast contract) streams no VXSE43, T2-naoto (warning only) still does", () => {
    // 実不具合: 予報も受ける沙織の筋書きに、本物の host が捨てる VXSE43 を流していた（P3-ED43-AC01）。
    const headTypes = (id: string) => { const { scenario } = trial(id); return scenario.kind === "ready" ? scenario.frames.map((item) => item.headType) : []; };
    expect(headTypes("T2-saori")).not.toContain("VXSE43");
    expect(headTypes("T2-saori")).toContain("VXSE45");
    expect(new Set(headTypes("T2-naoto"))).toEqual(new Set(["VXSE43"]));
  });
});

// ---- ペルソナ歩きの道具の直し（P4-PERSONA-WALK-TOOLS-001 の発注 1）。門なしで回す ----

describe("P4-PERSONA-WALK-TOOLS-001 order 1", () => {
  const attempt = (atMs: number, unit: string, subject: string, level: "normal" | "warning" | "critical" | "cancel", channel: "desktop" | "sound" = "desktop"): SceneAttempt => ({
    atMs, unit, subject, channel, priorityGroup: "other", payload: { level, title: `${unit} ${level}`, body: "b" },
    soundAsset: channel === "sound" ? `reconstruction/assets/sounds/weather-${level}.wav` : null });

  it("P4-PWT-T01 the default CLI gate stops the categories that are off by default", () => {
    // 契約の境界（Q2=A）: 既定で off の分野（洪水予報・竜巻・解説の briefing）は止まり、weather（記録的短時間大雨の VPBS50 を含む）・EEW は通る。
    const stages = [attempt(0, "U-R", "normal/VXKO50/x", "warning"), attempt(0, "U-M", "normal/tornado/x", "warning"), attempt(0, "U-B", "normal/VPBS50/X1", "normal"),
      attempt(0, "U-B", "normal/VPBS50/K1", "warning"), attempt(0, "U-W", "normal/VPWW55/x", "warning"), attempt(0, "U-E", "normal/VXSE45/x", "critical", "sound")].map(stoppedAt);
    expect(stages).toEqual(["category", "category", "category", null, null, null]);
  });

  it("P4-PWT-T02 the actor keeps the heaviest then newest 20 notifications in time order", () => {
    // 実不具合（R2 S6 の 03:20 の大津波警報、W1-09-21 S8 の大島の L5）: 最も古い critical 1 件が、後の normal 24 件の新しい順の 20 件の切りで落ちた。
    // 取消も段の最上位として残る（P4-PWT-AC02）。
    const list = [attempt(0, "U-T", "normal/VTSE41/x", "critical"), attempt(500, "U-E", "normal/VXSE45/x", "cancel"),
      ...Array.from({ length: 24 }, (_, index) => attempt((index + 1) * 1_000, "U-W", "normal/VPWW55/x", "normal"))];
    const { notifications, notificationsOmitted, notificationCounts } = notificationsOf(list.map(noticeOf));
    expect([notifications.map((item) => isRecord(item) ? item["title"] : null), notificationsOmitted, notificationCounts]).toEqual([
      ["U-T critical", "U-E cancel", ...Array.from({ length: 18 }, () => "U-W normal")], 6, { "U-T critical": 1, "U-E cancel": 1, "U-W normal": 24 }]);
    expect(notifications.slice(2).map((item) => isRecord(item) ? item["at"] : null)).toEqual(list.slice(8).map((item) => jstText(item.atMs)));
  });

  it("P4-PWT-T03 a connection loss gives the terminal's desktop line with the last received time", () => {
    // 実不具合（T2-naoto:40）: 切断の desktop 通知が場面に写らなかった。
    // 時刻は 23:50:00 の接続から ping の間隔ごとの、02:48:10 の切断を越えない最後の ping（P4-PWT-AC04 (2) で最後の frame から替えた）。
    const { scenario, dispatches } = trial("T2-naoto");
    const frames = scenario.kind === "ready" ? scenario.frames : [];
    const connected = jst("2026-10-19T23:50:00"), lost = jst("2026-10-20T02:48:10");
    expect(connectionNotices(dispatches, frames).map((item) => item.json)).toEqual([{ at: "2026-10-20T02:48:10+09:00", channel: "desktop", title: "FlEq",
      body: `回線が切れました（${jstText(connected + Math.floor((lost - connected) / PING_INTERVAL_MS) * PING_INTERVAL_MS).slice(11, 19)} から受信できていません）` }]);
    // 接続中の切断だけ: 繋がり直さずに続く切断と、接続の無い切断には出ない（host は確立した接続を失ったときだけ数える。実装レビューで、
    // 接続の無い切断の期待を 1 行〔切断の時刻〕から 0 行に改めた）。
    const at = jst("2026-10-20T01:00:00");
    expect(connectionNotices([{ atMs: at, kind: "connected" }, { atMs: at + 30_000, kind: "connectionLost" }, { atMs: at + 70_000, kind: "connectionLost" }], [])
      .map((item) => item.json["body"])).toEqual(["回線が切れました（01:00:20 から受信できていません）"]);
    expect(connectionNotices([{ atMs: at, kind: "connectionLost" }], [])).toEqual([]);
  });
});

// ---- ペルソナ歩きの道具の直し（P4-PERSONA-WALK-TOOLS-001 の発注 2）。門なしで回す ----

describe("P4-PERSONA-WALK-TOOLS-001 order 2", () => {
  it("P4-PWT-T04 (a) facts of a summarized domain keep the subject with shown false and the same until", async () => {
    // 実不具合（N2.md:60）: 要約の分野（U-E・U-T・U-Q）の報が画面に出ていないのに、評価者の事実で shown:true だった。until は view の行の有無のまま。
    const subject = "normal/VTSE41/20110311144600", state = { forecasts: [{ subject, retainUntil: 90_000 }] }, rows = [{ subject, source: { subject } }];
    expect([factsOf(state, rows, 500), factsOf(state, rows, 500, false)]).toEqual([[{ subject, shown: true, until: 90_000, retainUntil: 90_000 }],
      [{ subject, shown: false, until: 90_000, retainUntil: 90_000 }]]);
    // capture の経路: U-E・U-T・U-Q を要約にする筋書き（P3-DC-T09 の組み立てに EEW と通常の津波 512 件を足す。実装レビュー r1 の再現）の場面で、
    // 要約の分野の事実は subject が残り shown が全部 false。
    const t0 = jst("2026-06-26T00:00:00"), synthetic = synthesize("N1", 1, { t0Ms: t0 }), body = (item: Frame | undefined) => Buffer.from(item?.body ?? []).toString("utf8");
    const quake = body(synthetic.filter((item) => item.headType === "VXSE53").reduce((a, b) => b.body.byteLength > a.body.byteLength ? b : a));
    const forecast = body(synthetic.find((item) => item.headType === "VTSE41")).replace(/<Comments>[\s\S]*?<\/Comments>/, "");
    const eew = body(synthetic.filter((item) => item.headType === "VXSE45")[19]);
    const swap = (xml: string, index: number) => xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${20260626000100 + index}</EventID>`);
    const small = (atMs: number, eventId: string) => vtse41({ eventId, at: new Date(atMs).toISOString(), areas: [{ code: "310", name: "千葉県九十九里・外房", kind: "51" }] });
    const inputs = [...[0, 1, 2, 3].flatMap((index) => [...index < 3 ? [frame(t0 + index * 1_000, "VXSE53", swap(quake, index))] : [],
      frame(t0 + index * 1_000 + 100, "VTSE41", swap(forecast, index))]), ...[0, 1, 2, 3, 4].map((index) => frame(t0 + 4_000 + index * 100, "VXSE45", swap(eew, 10 + index))),
    ...Array.from({ length: 508 }, (_, index) => frame(t0 + 4_500 + index * 3, "VTSE41", small(t0 + 4_500 + index * 3, String(20260626100000 + index)))),
    frame(t0 + 7 * MINUTE, "VXSE45", swap(eew, 20)), frame(t0 + 7 * MINUTE, "VTSE41", small(t0 + 7 * MINUTE, "20260626200000").replace("<Status>通常</Status>", "<Status>訓練</Status>"))]
      .sort((a, b) => a.atMs - b.atMs);
    const scenes: SceneCapture[] = [];
    await runStage1(ready("P4-PWT-T04a", inputs, t0, t0 + 8 * MINUTE), { scenes: { times: [t0 + 7 * MINUTE], write: (scene) => scenes.push(scene) } });
    const summarized = Object.entries(scenes[0]?.screen?.current ?? {}).filter(([, domain]) => domain.delivery === "summary").map(([key]) => key);
    const facts = ["U-E", "U-T", "U-Q"].map((unit) => scenes[0]?.facts[unit] ?? []);
    expect([summarized, facts.map((list) => list.length > 0 && list.every((item) => !item.shown))]).toEqual([["eew", "tsunami", "earthquake"], [true, true, true]]);
  });

  it("P4-PWT-T04 (b) the card of a connection loss starts at the last ping before the loss, the same time as the actor's line", async () => {
    // 実不具合（T2-naoto.md:18）: ping を流さず、02:48:10 の切断の札の始まりが最後の data（02:10）で、製品（ping でも recordFrame）より 37 分早かった。
    const { scenario, dispatches } = trial("T2-naoto");
    if (scenario.kind !== "ready") throw new Error("T2-naoto is not ready");
    const lost = jst("2026-10-20T02:48:10"), scenes: SceneCapture[] = [];
    await runStage1(scenario, { dispatches, everySecond: [{ fromMs: scenario.startMs, toMs: scenario.endMs }],
      scenes: { times: [jst("2026-10-20T03:02:40")], write: (scene) => scenes.push(scene) } });
    const from = scenes[0]?.fullScreen?.recovery.eewUnverified?.fromWallMs ?? null;
    expect(from == null ? null : lost - from).toBeGreaterThanOrEqual(0);
    expect(from == null ? null : lost - from).toBeLessThan(PING_INTERVAL_MS);
    expect(connectionNotices(dispatches, scenario.frames)[0]?.json["body"]).toBe(`回線が切れました（${jstText(from ?? 0).slice(11, 19)} から受信できていません）`);
    // 繋がり直さずに続く切断は ping を作らない（実装レビュー: 製品は最後の受信 00:00:20 のまま、runner は 00:01:00 を記録した）。
    const at = jst("2026-10-20T00:00:00"), held: Harness[] = [];
    await runStage1(ready("P4-PWT-T04b", [], at, at + 2 * MINUTE), { prepare: async (h) => { held.push(h); },
      dispatches: [{ atMs: at, kind: "connected" }, { atMs: at + 30_000, kind: "connectionLost" }, { atMs: at + 70_000, kind: "connectionLost" }] });
    expect(held[0]?.root.lastReceivedWallMs).toBe(at + 20_000);
  });

  it("P4-PWT-T05 with the connection layer the startup confirmation leaves as in the product, and the actor file shows the three columns", async () => {
    // 実不具合（N1.md:30・T2-naoto.md:29）: AC09 の筋書きは接続の層が無く確認状態が全部 startup のまま残り、full の分野の確認状態の行が場面に写らなかった。
    // T09 と同じ sceneRun・actorFile を通る。U-E は接続から 10 分の tick（接続の層の 2 点の tick の 2 つ目。製品の毎秒の tick と同じ時刻）で確かめる。
    const start = jst("2026-10-19T18:00:00");
    const scenario = ready("P4-PWT-T05", [frame(start + 5 * MINUTE, "VXSE53", retimed("32-35_04_04_240613_VXSE53", start + 5 * MINUTE, "20261019180500"))],
      start, start + 15 * MINUTE);
    const { options } = sceneRun(scenario, null, CLASSIFICATIONS["沙織"] ?? []);
    const scenes: SceneCapture[] = [];
    await runStage1(scenario, options({ times: [start, start + 10 * MINUTE - 1_000, start + 10 * MINUTE], write: (scene) => scenes.push(scene) }));
    const screens = scenes.map((scene) => actorFile({}, scene, []).screen);
    // normal の行で見る。沙織の契約（telegram.earthquake）で起動の取り直しが U-T・U-Q・U-N・U-M を流し始めに確かめる。契約に無い分野は startup のまま（host も辿らない）。
    const startup = screens.map((screen) => Object.entries(screen?.current ?? {}).flatMap(([key, domain]) => domain.delivery === "full"
      && domain.items.some((item) => item.operation === "normal" && "startup" in item.unconfirmed) ? [key] : []));
    const outside = ["weatherCurrent", "weatherTimeseries", "volcano", "landslide", "flood", "briefing", "typhoon"];
    expect(startup).toEqual([["eew", ...outside], ["eew", ...outside], outside]);
    // 3 欄の写し（全 operation）。U-Q の normal は接続から 60 秒の tick の取り直し（最初の接続のきっかけ）で確かめ直した時刻、U-E は 10 分の確認で
    // normal と training（P3-REC-D-EEW-CONFIRM=B）。取り直しが確かめるのは normal だけ。
    const items = (key: string) => { const domain = screens[2]?.current[key]; return domain?.delivery === "full" ? domain.items : null; };
    const row = (operation: string, confirmedAt: number | null) => ({ operation, confirmation: confirmedAt == null ? { state: "unconfirmed", confirmedAt: null }
      : { state: "confirmed", confirmedAt }, unconfirmed: confirmedAt == null ? { startup: 1 } : {} });
    expect([items("earthquake"), items("eew")]).toEqual([[row("normal", start + MINUTE), row("training", null), row("test", null)],
      [row("normal", start + 10 * MINUTE), row("training", start + 10 * MINUTE), row("test", null)]]);
    // 2 点の tick の値の読み: 整数 1 つか 1 回の積だけを受け、** などは例外（実装レビュー r1: 10 ** 3 * 600 を 0 と読んだ）。
    expect([productMs("X", "const X = 10 * 60_000;"), productMs("X", "const X = 60_000;")]).toEqual([600_000, 60_000]);
    expect(() => productMs("X", "const X = 10 ** 3 * 600;")).toThrow();
  });
});

// ---- ペルソナ歩きの道具の直し（P4-PERSONA-WALK-TOOLS-001 の発注 3）。門なしで回す ----

describe("P4-PERSONA-WALK-TOOLS-001 order 3", () => {
  const text = (item: Frame) => Buffer.from(item.body).toString("utf8");
  const wide = (value: number) => String(value).replace(/\d/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

  it("P4-PWT-T06 the synthesized reports keep their count and times and read as reports of the scenario", () => {
    const t0 = jst("2026-06-26T00:00:00");
    const lists = { N1: synthesize("N1", 1, { t0Ms: t0 }), N2: synthesize("N2", 1, { t0Ms: t0 }), R2: synthesize("R2", 1) };
    const release = (item: Frame) => item.source === "synth:M7:VTSE41:release";
    // 受入条件（Q1=A）: 解除の VTSE41（P4-PWT-D-M7-RELEASE=A）を除いた (atMs, headType) の列は、発注 3 の前の synth.ts で取った値と同じ。
    // P4-PWT2-AC03 (5)（D-R2-QUAKE=A）で R2 に本震の報 17 通（EEW 15・VXSE51・VXSE53、89→106 通）を足したので取り直した。N1・N2 の列は前の値のまま（2 つの synth.ts で id ごとに照合）。
    expect(sha256(Object.entries(lists).map(([id, list]) => `${id}\n${list.filter((item) => !release(item)).map((item) => `${item.atMs}\t${item.headType}\n`).join("")}`).join("")))
      .toBe("5330afc2a19552b6355d50762e796b96111eed9dfc2fbb39d83750b56c151487");
    // 解除は M7 級の余震の注意報ごとに 1 通で、同じ EventID。
    const eventIds = (list: readonly Frame[], source: string) => list.filter((item) => item.source === source).map((item) => tag(text(item), "EventID"));
    expect([lists.N1, lists.N2].map((list) => eventIds(list, "synth:M7:VTSE41:release"))).toEqual([lists.N1, lists.N2].map((list) => eventIds(list, "synth:M7:VTSE41")));
    expect([lists.N1, lists.N2].map((list) => list.filter(release).length)).toEqual([2, 4]);
    // 伏せ字と訓練の文が無い。VYSE51 の号は報ごとに増える。
    expect(Object.values(lists).flat().filter((item) => /[●▲]|これは訓練です/.test(text(item))).map((item) => item.source)).toEqual([]);
    expect([lists.N1, lists.N2].map((list) => list.filter((item) => item.headType === "VYSE51").map((item) => tag(text(item).slice(text(item).indexOf("<Head")), "Title"))))
      .toEqual([2, 14].map((count) => Array.from({ length: count }, (_, index) => `南海トラフ地震関連解説情報（第${wide(index + 1)}号）`)));
    // 各 EventID の EEW は最後の報だけが最終報。
    const unfinished = (list: readonly Frame[]) => {
      const reports = new Map<string, Frame[]>();
      for (const item of list.filter((frame) => frame.headType === "VXSE45")) reports.set(tag(text(item), "EventID") ?? "", [...reports.get(tag(text(item), "EventID") ?? "") ?? [], item]);
      return [...reports].filter(([, items]) => items.map((item) => text(item).includes("<NextAdvisory>")).join() !== [...items.slice(1).map(() => false), true].join()).map(([eventId]) => eventId);
    };
    expect([lists.N1, lists.N2].map(unfinished)).toEqual([[], []]);
    // 本震の EEW の区域の ForecastLgInt は型の同じ予想震度の区域の最大（型に無い 6 強は型の最大）、Body は区域の最大、到達は報時刻以後で、報時刻より前の区域は Condition（P4-PWT2-AC03 (1)）。
    const main = tag(text(lists.N1.find((item) => item.headType === "VXSE51")!), "EventID");
    const lg = (headType: string, serial: string) => {
      const xml = text(lists.N1.find((item) => item.headType === headType && tag(text(item), "EventID") === main && tag(text(item), "Serial") === serial)!);
      const body = xml.slice(xml.indexOf("<Body")), reported = Date.parse(tag(xml, "ReportDateTime")!);
      const areas = [...body.matchAll(/<\/Category><ForecastInt><From>([^<]*)<\/From><To>[^<]*<\/To><\/ForecastInt><ForecastLgInt><From>([^<]*)<\/From><To>[^<]*<\/To><\/ForecastLgInt>(?:<ArrivalTime>([^<]*)<|<Condition>)/g)];
      return { pairs: [...new Set(areas.map(([, int, lgInt]) => `${int}:${lgInt}`))].sort(), body: /<Forecast>[\s\S]*?<ForecastLgInt><From>([^<]*)</.exec(body)?.[1],
        after: areas.every(([, , , arrival]) => arrival == null || Date.parse(arrival) >= reported) };
    };
    // VXSE45 は 188 区域の 20 報目、VXSE43 は最後の 10 報目（震度 4 の区域はまだ無い）。
    expect([lg("VXSE45", "20"), lg("VXSE43", "10")]).toEqual([{ pairs: ["4:1", "5-:2", "6+:2"], body: "2", after: true }, { pairs: ["5-:0", "6+:1"], body: "1", after: true }]);
    // 実装レビュー r1 の回帰（製品の通知・表示・保存に届いた値）。
    // EEW の区域は、その時点の最後の VXSE43 の区域だけが警報 10、ほかは予報 00 で、Headline の警報の細分区域も同じ。
    const ofMain = (headType: string) => lists.N1.filter((item) => item.headType === headType && tag(text(item), "EventID") === main);
    const codesOf = (item: Frame, pattern: RegExp) => [...text(item).matchAll(pattern)].map((match) => match[1]).sort().join();
    const kinds = (item: Frame, code: string) => codesOf(item, new RegExp(`<Area><Name>[^<]*</Name><Code>(\\d+)</Code><Category><Kind><Name>[^<]*</Name><Code>${code}</Code>`, "g"));
    const warnedAt = (item: Frame) => kinds(ofMain("VXSE43").filter((warning) => warning.atMs <= item.atMs).at(-1)!, "1[01]");
    expect(ofMain("VXSE45").filter((item) => kinds(item, "1[01]") !== warnedAt(item) || codesOf(item, /<Area><Name>[^<]*<\/Name><Code>(\d+)<\/Code><Category>/g) !== [kinds(item, "1[01]"), kinds(item, "0[01]")].filter((list) => list !== "").join().split(",").sort().join()
      || codesOf({ ...item, body: Buffer.from(/<Information type="緊急地震速報（細分区域）">[\s\S]*?<\/Information>/.exec(text(item))?.[0] ?? "") }, /<Code>(\d+)<\/Code><\/Area>/g) !== warnedAt(item))
      .map((item) => tag(text(item), "Serial"))).toEqual([]);
    // 同じ地震の確定した報（地震と津波）は規模が 1 つ、震源は筋書きの震源。M7 級の余震も同じ。
    const magnitude = (item: Frame) => /<jmx_eb:Magnitude[^>]*>[^<]*<\/jmx_eb:Magnitude>/.exec(text(item))?.[0];
    const settled = (eventId: string | null) => lists.N1.filter((item) => /^(VXSE5[1-3]|VXSE6[12]|VTSE4[1-9]|VTSE5[12])$/.test(item.headType) && tag(text(item), "EventID") === eventId);
    expect([main, ...eventIds(lists.N1, "synth:M7:VTSE41")].map((eventId) => [...new Set(settled(eventId).flatMap((item) => magnitude(item) ?? []))].length)).toEqual([1, 1, 1]);
    expect([...new Set(lists.N1.flatMap((item) => /<Hypocenter>\s*<Area>\s*<Name>([^<]*)/.exec(text(item))?.[1] ?? []))]).toEqual(["和歌山県南方沖"]);
    // 注意報の解除は 62→60、全部の解除の題名は「津波予報」で、見出しは出ていた区分の解除。震源の更新の見出しの時刻は報時刻。
    expect([...new Set(lists.N1.filter(release).flatMap((item) => [...text(item).matchAll(/<Kind><Name>([^<]*)<\/Name><Code>(\d+)<\/Code><\/Kind>\s*<LastKind><Name>[^<]*<\/Name><Code>(\d+)/g)].map((match) => match.slice(1).join())))])
      .toEqual(["津波注意報解除,60,62"]);
    const r2End = text(lists.R2.filter((item) => item.source === "synth:R2:VTSE41").at(-1)!);
    expect([tag(r2End.slice(r2End.indexOf("<Head")), "Title"), /<Headline>\s*<Text>([^<]*)/.exec(r2End)?.[1]]).toEqual(["津波予報", "津波注意報を解除しました。"]);
    expect(text(lists.N1.find((item) => item.headType === "VXSE61")!)).toContain("令和　８年　６月２６日０４時００分をもって");
    // 観測の第 1 波 ≦ 最大波 ≦ 報時刻、沿岸の観測点は予報区の沿岸の組（code の頭 3 桁が予報区）。
    const observations = Object.values(lists).flat().filter((item) => /^synth:.*VTSE5[12]$/.test(item.source));
    const observed = (item: Frame) => text(item).slice(text(item).indexOf("<Observation>"), text(item).indexOf("</Observation>"));
    expect(observations.filter((item) => [...observed(item).matchAll(/<FirstHeight>\s*<ArrivalTime>([^<]*)<\/ArrivalTime>[\s\S]*?<MaxHeight>\s*<DateTime>([^<]*)</g)]
      .some(([, first, max]) => !(Date.parse(first) <= Date.parse(max) && Date.parse(max) <= Date.parse(tag(text(item), "ReportDateTime")!)))).map((item) => item.source)).toEqual([]);
    expect(observations.filter((item) => item.headType === "VTSE51").flatMap((item) => [...observed(item).matchAll(/<Item>\s*<Area><Name>[^<]*<\/Name><Code>(\d+)<\/Code><\/Area>([\s\S]*?)<\/Item>/g)]
      .flatMap(([, area, stations]) => [...stations.matchAll(/<Station><Name>[^<]*<\/Name><Code>(\d+)/g)].filter(([, code]) => code.slice(0, 3) !== area).map(([, code]) => code)))).toEqual([]);
    // 沖合の観測の推定の区域は同じ地震の津波の予報の大津波警報の区域の中で、時刻は発生より後（実装レビュー r1: N 系に 2011 の型の青森・岩手の推定が残った）。
    const forecastAreas = (list: readonly Frame[], eventId: string | null) => new Set(list.filter((item) => item.headType === "VTSE41" && tag(text(item), "EventID") === eventId)
      .flatMap((item) => [...text(item).matchAll(/<Item>\s*<Area><Name>[^<]*<\/Name><Code>(\d+)<\/Code><\/Area>\s*<Category>\s*<Kind><Name>[^<]*<\/Name><Code>5[23]<\/Code>/g)].map((match) => match[1])));
    const strays = (list: readonly Frame[]) => list.filter((item) => item.source === "synth:VTSE52").flatMap((item) => {
      const xml = text(item), estimation = xml.slice(xml.indexOf("<Estimation>"), xml.indexOf("</Estimation>")), areas = forecastAreas(list, tag(xml, "EventID"));
      const items = [...estimation.matchAll(/<Area><Name>[^<]*<\/Name><Code>(\d+)<\/Code><\/Area>\s*<FirstHeight>\s*<ArrivalTime>([^<]*)/g)];
      return items.length === 0 || items.some(([, code, arrival]) => !areas.has(code) || Date.parse(arrival) <= Date.parse(tag(xml, "OriginTime")!)) ? [item.atMs] : [];
    });
    expect([strays(lists.N1), strays(lists.N2)]).toEqual([[], []]);
    // 本文の最大予測震度は、どの報でも区域の最大（実装レビュー r2: 第 1〜4 報が 6 強の区域に 6 弱のままだった）。
    expect(ofMain("VXSE45").filter((item) => {
      const body = text(item).slice(text(item).indexOf("<Body")), areaInts = [...body.matchAll(/<\/Category><ForecastInt><From>([^<]*)</g)].map((match) => match[1]);
      const order = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];
      return /<Forecast>[\s\S]*?<ForecastInt><From>([^<]*)</.exec(body)?.[1] !== areaInts.reduce((top, int) => order.indexOf(int) > order.indexOf(top) ? int : top, "0");
    }).map((item) => tag(text(item), "Serial"))).toEqual([]);
    // 推定は同じ地震の予報の大津波警報の区域のうち到達の早い 2 区域で、到達はその予報の到達、最大波はその 10 分後。
    const firstForecast = text(lists.N1.find((item) => item.source === "synth:VTSE41")!);
    const expected = [...firstForecast.matchAll(/<Area><Name>[^<]*<\/Name><Code>(\d+)<\/Code><\/Area>\s*<Category>\s*<Kind><Name>[^<]*<\/Name><Code>5[23]<\/Code>[\s\S]*?<ArrivalTime>([^<]*)</g)]
      .map(([, code, arrival]) => ({ code, arrival: Date.parse(arrival) })).sort((a, b) => a.arrival - b.arrival).slice(0, 2)
      .map(({ code, arrival }) => `${code},${jstText(arrival)},${jstText(arrival + 10 * MINUTE)}`);
    expect([...new Set(lists.N1.filter((item) => item.source === "synth:VTSE52").map((item) => [...text(item).slice(text(item).indexOf("<Estimation>"))
      .matchAll(/<Code>(\d+)<\/Code><\/Area>\s*<FirstHeight>\s*<ArrivalTime>([^<]*)<\/ArrivalTime>[\s\S]*?<MaxHeight>\s*<DateTime>([^<]*)</g)].map((match) => match.slice(1).join()).join("|")))])
      .toEqual([expected.join("|")]);
    // 警告の文と code は区分から（注意報だけは 0123、全部の解除は 0107）、領域表現は載せない。
    const warningComment = (item: Frame) => /<WarningComment[^>]*>\s*<Text>([^<]*)<\/Text>\s*<Code>([^<]*)</.exec(text(item))?.slice(1).map((value) => value.slice(0, 11)).join();
    expect([warningComment(lists.N1.find((item) => item.source === "synth:M7:VTSE41")!), warningComment(lists.N1.find(release)!),
      Object.values(lists).flat().some((item) => item.headType === "VTSE41" && item.origin === "synthetic" && text(item).includes("津波予報領域表現"))])
      .toEqual(["＜津波注意報＞\n海の中,0123", "現在、大津波警報・津波,0107", false]);
    // 臨時情報: M7 級の余震の後も巨大地震警戒（P4-PWT-D-NANKAI-M7=A）、筋書きで決まる伏せ字（警戒の期限・次回の時刻・中心の地方）は埋める。
    const nankaiCode = (item: Frame) => /<Code>(\d+)<\/Code>\s*<\/InfoSerial>/.exec(text(item))?.[1];
    expect(lists.N1.filter((item) => item.headType === "VYSE50").map(nankaiCode)).toEqual(["111", "111", "120", "120", "111", "120"]);
    const commentary = lists.N2.filter((item) => item.headType === "VYSE51");
    // 期限は最初の巨大地震警戒の発表から 7 日、次回は次の臨時解説の時刻（列から照らす）。
    const hourOf = (ms: number, month: boolean) => { const date = new Date(ms + 9 * 60 * MINUTE);
      return `${month ? `${wide(date.getUTCMonth() + 1)}月` : ""}${wide(date.getUTCDate())}日${wide(date.getUTCHours()).padStart(2, "０")}時`; };
    const until = hourOf(lists.N2.find((item) => item.source === "synth:VYSE50:120")!.atMs + 7 * 24 * 60 * MINUTE, true);
    expect([commentary.every((item) => text(item).includes(`${until}まで警戒する措置`)),
      commentary.slice(0, -1).every((item, index) => text(item).includes(`次回の情報発表は、${hourOf(commentary[index + 1].atMs, false)}頃を予定`)),
      text(commentary.at(-1)!).includes("次回の情報発表は"), text(lists.N2.find((item) => item.source === "synth:VYSE50:120")!).includes("近畿地方を中心に")]).toEqual([true, true, false, true]);
    // T2-saori（AC06 (10)）: 地震の報は EEW の最後の報と同じ発生時刻と震源、津波の報は JST、観測点の組は公開型と同じ（銚子は千葉県九十九里・外房の 31001）。
    const saori = trial("T2-saori"), saoriFrames = saori.scenario.kind === "ready" ? saori.scenario.frames.map(text) : [];
    const origin = tag(saoriFrames.filter((xml) => xml.includes("<Title>緊急地震速報（地震動予報）</Title>")).at(-1)!, "OriginTime");
    const [quake, warning, coastal] = saori.missed ?? [];
    expect([tag(saoriFrames.find((xml) => xml.includes("<InfoKind>震度速報</InfoKind>"))!, "TargetDateTime"), tag(quake, "OriginTime"), /<Hypocenter>\s*<Area>\s*<Name>([^<]*)/.exec(quake)?.[1],
      quake.includes("津波の心配はありません"), tag(warning, "ReportDateTime")?.endsWith("+09:00"), warning.includes("<ArrivalTime>") && warning.includes("TsunamiHeight")])
      .toEqual([origin, origin, "豊後水道", false, true, true]);
    const pair = (xml: string) => /<Area><Name>([^<]*)<\/Name><Code>(\d+)<\/Code><\/Area>(?:(?!<Area>)[\s\S])*?<Station><Name>銚子<\/Name><Code>(\d+)/.exec(xml)?.slice(1).join();
    expect(pair(coastal)).toBe(pair(fixture("32-39_11_10_250206_VTSE51").replace(/>\s+</g, "><")));
    // T2-yu（AC06 (11)）: 地震 A の第 3 報からの報は発生時刻が 1 つ、続報と最終報の発表と対象の時刻は受ける時刻、Serial は増え、最後だけ最終報。
    const yu = trial("T2-yu"), events = (yu.scenario.kind === "ready" ? yu.scenario.frames : []).filter((item) => tag(text(item), "EventID") === "20261019233001");
    // 発生時刻は第 3 報から 1 つ（第 1 報の 77_01_01 は公開型どおり 1 秒早い）。
    expect([new Set(events.slice(1).map((item) => tag(text(item), "OriginTime"))).size, events.slice(2).every((item) => tag(text(item), "ReportDateTime") === jstText(item.atMs)
      && tag(text(item), "TargetDateTime") === jstText(item.atMs)), events.map((item) => Number(tag(text(item), "Serial"))).every((serial, index, all) => index === 0 || serial > all[index - 1]),
    events.map((item) => text(item).includes("<NextAdvisory>")).lastIndexOf(true), events.length]).toEqual([1, true, true, 10, 11]);
  }, 180_000); // N1・N2・R2 の合成と試行 2 の組み立てで、CI の node 22 では 42〜65 秒かかる（run 44280793644）

  it("P4-PWT-T07 each persona gets only the reports of their contract", () => {
    // 実不具合（W1-06-03.md:32・N1.md:22・N3.md:35）: 直人に W1 の気象を全部流し、沙織に host が捨てる VXSE43 を流していた。
    const types = (list: readonly Frame[], persona: string) => contracted(list, CLASSIFICATIONS[persona] ?? []).map((item) => item.headType);
    const n1 = types(synthesize("N1", 1, { t0Ms: jst("2026-06-26T00:00:00") }), "沙織");
    expect([n1.includes("VXSE43"), n1.includes("VXSE45")]).toEqual([false, true]);
    const { scenario } = trial("T2-naoto");
    expect(new Set(types(scenario.kind === "ready" ? scenario.frames : [], "直人"))).toEqual(new Set(["VXSE43"]));
    expect(types(["VXWW50", "VXKO50", "VPWW55", "VXSE45"].map((headType) => frame(0, headType, "")), "千尋")).toEqual(["VXWW50", "VXKO50", "VPWW55"]);
  });

  it("P4-PWT-T08 W1 streams from 18:00 of the day before while the cuts and the scenes keep the midnight of the day", () => {
    // 実不具合（W1-2026-09-21.md:50）: W1 は 0 時に空の状態から始まり、09-21 は U-L が空なのに U-W に土砂があった。
    const dir = mkdtempSync(join(tmpdir(), "fleq-pwt-"));
    try {
      const put = (date: string, rows: readonly (readonly [string, string, string])[]) => {
        mkdirSync(join(dir, `x-${date}`));
        rows.forEach(([, , name], index) => writeFileSync(join(dir, `x-${date}`, `${index}.xml`), fixture(name)));
        writeFileSync(join(dir, `x-${date}`, "telegrams.json"), JSON.stringify(rows.map(([receivedTime, type], index) => ({ filename: `${index}.xml`, format: "xml", head: { type }, receivedTime }))));
      };
      const read = () => readScenario({ id: "W1:2026-06-03", dataDir: dir, expectedDigest: null });
      put("2026-06-03", [["2026-06-03T00:10:00.000Z", "VPWW57", "15_16_02_251222_VPWW57"]]);
      expect(read()).toMatchObject({ kind: "blocked", reason: "dataMissing" });
      put("2026-06-02", [["2026-06-02T08:59:00.000Z", "VPWW57", "15_16_02_251222_VPWW57"], ["2026-06-02T09:00:00.000Z", "VPWW55", "15_17_01_251222_VPWW55"]]);
      const scenario = read();
      if (scenario.kind !== "ready") throw new Error("W1 did not read");
      const midnight = jst("2026-06-03T00:00:00");
      expect([scenario.startMs, scenario.frames.map((item) => item.receivedTime), scenario.endMs, scenario.checkpoints.map((item) => item.atMs)]).toEqual([
        jst("2026-06-02T18:00:00"), ["2026-06-02T09:00:00.000Z", "2026-06-03T00:10:00.000Z"], midnight + 24 * 60 * MINUTE, [6, 12, 18, 24].map((hour) => midnight + hour * 60 * MINUTE)]);
      // 場面の候補はその日の 0 時から（AC08 (3)）。W1 でない筋書きは切らない。
      const found: Candidate[] = [{ item: "ii", atMs: midnight - 1_000 }, { item: "ii", atMs: midnight }];
      expect([sinceMidnight("W1:2026-06-03", found), sinceMidnight("N1", found)]).toEqual([found.slice(1), found]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- ペルソナ歩きの道具の直し（P4-PERSONA-WALK-TOOLS-002 の発注 1）。門なしで回す ----

describe("P4-PERSONA-WALK-TOOLS-002 order 1", () => {
  const sent = (atMs: number, title: string, level: "normal" | "warning" | "critical", channel: "desktop" | "sound" = "desktop", subject = "s"): SceneAttempt => ({
    atMs, unit: "U-E", subject, channel, priorityGroup: "other", payload: { level, title, body: "b" },
    soundAsset: channel === "sound" ? `reconstruction/assets/sounds/earthquake-eew-${level}.wav` : null });

  it("P4-PWT2-T01 a title and level group keeps its newest row before the 20 are filled by weight", () => {
    // 実不具合（N1#7・N2#9）: 同じ題名の critical 25 件が、題名 A の warning・normal（EEW の最終報の形）と題名 B の normal を 20 件の切りで押し出した。
    const list = [sent(0, "A", "warning"), sent(1_000, "A", "normal"), sent(2_000, "B", "normal"), ...Array.from({ length: 25 }, (_, index) => sent((index + 3) * 1_000, "A", "critical"))];
    const { notifications, notificationsOmitted, notificationCounts } = notificationsOf(list.map(noticeOf));
    expect([notifications.map((item) => isRecord(item) ? item["at"] : null), notificationsOmitted, notificationCounts]).toEqual([
      list.filter((item, index) => index < 3 || index >= 11).map((item) => jstText(item.atMs)), 8, { A: 27, B: 1 }]);
  });

  it("P4-PWT2-T02 a desktop and a sound of the same time, unit and subject are one row that carries the sound", () => {
    // 実不具合（W1-06-03#1 ほか族 S）: 音の無い desktop 通知を演じ手が鳴ったと読んだ。評価者の file は試行ごとの行のまま。
    const list = [sent(1_000, "A", "critical"), sent(1_000, "A", "critical", "sound"), sent(2_000, "B", "normal"), sent(3_000, "C", "warning", "sound")];
    const { notifications, notificationCounts } = notificationsOf(list.map(noticeOf));
    expect([notifications.map((item) => isRecord(item) ? [item["channel"], item["title"] ?? null, item["sound"]] : null), notificationCounts]).toEqual([
      [["desktop", "A", "earthquake-eew-critical"], ["desktop", "B", null], ["sound", null, "earthquake-eew-warning"]], { A: 1, B: 1, "（音）earthquake-eew-warning": 1 }]);
    expect(noticeOf(list[0]).json).toEqual({ at: jstText(1_000), channel: "desktop", title: "A", body: "b" });
  });

  it("P4-PWT2-T03 the omitted counts and times cover only the rows left out", () => {
    // 実不具合（R2#8・W1-06-03#7）: 『このほかに N 件』の内訳が全部の数で、省いた通知の時刻の幅も分からなかった。
    const list = Array.from({ length: 30 }, (_, index) => sent(index * 1_000, ["X", "Y", "Z"][Math.floor(index / 10)] ?? "", "normal"));
    const { notificationsOmitted, omittedCounts, omittedFrom, omittedTo, notificationCounts } = notificationsOf(list.map(noticeOf));
    expect([notificationsOmitted, omittedCounts, omittedFrom, omittedTo, notificationCounts]).toEqual([10, { X: 9, Y: 1 }, jstText(0), jstText(10_000), { X: 10, Y: 10, Z: 10 }]);
  });
});

// ---- ペルソナ歩きの道具の直し（P4-PERSONA-WALK-TOOLS-002 の発注 2）。門なしで回す ----

describe("P4-PERSONA-WALK-TOOLS-002 order 2", () => {
  const text = (item: Frame) => Buffer.from(item.body).toString("utf8");

  it("P4-PWT2-T04 the synthesized reports keep one arrival, one magnitude and the continuing kinds, and R2 has its own main shock", () => {
    // 受入条件（AC03）: N1・N2（t0 は固定）と R2 の合成の報。件数と時刻は P4-PWT-T06 が確かめる。
    const t0 = jst("2026-06-26T00:00:00");
    const lists = { N1: synthesize("N1", 1, { t0Ms: t0 }), N2: synthesize("N2", 1, { t0Ms: t0 }), R2: synthesize("R2", 1) };
    // (1) EEW の区域の到達は同じ EventID の報で同じ値。報の時刻より前の区域は Condition『既に主要動到達と推測』、そうでなければ ArrivalTime。
    let conditions = 0;
    for (const list of [lists.N1, lists.N2, lists.R2]) {
      const arrivals = new Map<string, string>(), seen: { eventId: string | null; code: string; reported: number; arrival: string | null }[] = [];
      for (const item of list.filter((report) => report.headType === "VXSE45" || report.headType === "VXSE43")) {
        const xml = text(item), eventId = tag(xml, "EventID"), reported = Date.parse(tag(xml, "ReportDateTime")!);
        for (const [, code, arrival] of xml.matchAll(/<Area><Name>[^<]*<\/Name><Code>(\d+)<\/Code><Category>(?:(?!<\/Area>)[\s\S])*?<\/ForecastLgInt>(?:<ArrivalTime>([^<]*)<\/ArrivalTime>|<Condition>既に主要動到達と推測<\/Condition>)<\/Area>/g)) {
          seen.push({ eventId, code, reported, arrival: arrival ?? null });
          if (arrival != null) arrivals.set(`${eventId}:${code}`, arrival);
        }
      }
      conditions += seen.filter((area) => area.arrival == null).length;
      expect(seen.filter((area) => { const known = arrivals.get(`${area.eventId}:${area.code}`);
        return area.arrival == null ? known != null && Date.parse(known) >= area.reported : Date.parse(area.arrival) < area.reported; })).toEqual([]);
      expect(seen.filter((area) => area.arrival != null && area.arrival !== arrivals.get(`${area.eventId}:${area.code}`))).toEqual([]);
    }
    expect(conditions).toBeGreaterThan(0);
    // 到達済み（Condition）の区域の Kind は 11（警報）か 01（予報）（公開の型の形）。
    const reachedKinds = [lists.N1, lists.N2, lists.R2].flatMap((list) => list.filter((report) => report.headType === "VXSE45" || report.headType === "VXSE43")
      .flatMap((report) => [...text(report).matchAll(/<Code>(\d+)<\/Code><\/Kind><\/Category><ForecastInt>(?:(?!<\/Area>)[\s\S])*?<Condition>既に主要動到達と推測/g)].map((match) => match[1])));
    expect([reachedKinds.length > 0, reachedKinds.filter((kind) => kind !== "11" && kind !== "01")]).toEqual([true, []]);
    // 同じ点の最大波の高さは、版を追って下がらない（区域の最初の点の決め方が版で変わらない）。
    const falls = [lists.N1, lists.N2, lists.R2].map((list) => {
      const last = new Map<string, number>();
      let count = 0;
      for (const report of list.filter((item) => /^synth:.*VTSE5[12]$/.test(item.source))) {
        const xml = text(report), eventId = tag(xml, "EventID");
        for (const [, code, height] of xml.slice(xml.indexOf("<Observation>"), xml.indexOf("</Observation>")).matchAll(/<Station><Name>[^<]*<\/Name><Code>(\d+)<\/Code>[\s\S]*?TsunamiHeight[^>]*>([^<]*)</g)) {
          const key = `${eventId}:${report.headType}:${code}`;
          if (last.has(key) && Number(height) < last.get(key)!) count++;
          last.set(key, Number(height));
        }
      }
      return count;
    });
    expect(falls).toEqual([0, 0, 0]);
    // (3) 余震の EventID ごとに、EEW・震源に関する情報・震源・震度に関する情報の規模は 1 つ。
    const magnitudes = (list: readonly Frame[]) => {
      const events = new Set(list.filter((item) => item.source.startsWith("synth:aftershock:")).map((item) => tag(text(item), "EventID")));
      return [...events].map((eventId) => new Set(list.filter((item) => /^VXSE(45|52|53)$/.test(item.headType) && tag(text(item), "EventID") === eventId)
        .map((item) => /<jmx_eb:Magnitude[^>]*>[^<]*<\/jmx_eb:Magnitude>/.exec(text(item))?.[0])).size);
    };
    expect([lists.N1, lists.N2].map((list) => magnitudes(list).filter((size) => size !== 1))).toEqual([[], []]);
    // (4) 津波の区分の Kind: R2 の 15:30 は新しく大津波警報の 100・101・102・320 が 53、続く大津波警報の区域は 52。N の +3 分は全部 53、+15 分は全部 52。
    const kinds = (item: Frame | undefined) => new Map([...text(item!).matchAll(/<Area><Name>[^<]*<\/Name><Code>(\d+)<\/Code><\/Area>\s*<Category>\s*<Kind><Name>[^<]*<\/Name><Code>(\d+)<\/Code>/g)]
      .map(([, code, kind]) => [code, kind]));
    const majors = (item: Frame | undefined) => [...kinds(item)].filter(([, kind]) => kind === "52" || kind === "53");
    const r2At = (iso: string) => lists.R2.find((item) => item.source === "synth:R2:VTSE41" && item.atMs === jst(iso))!;
    const raised = majors(r2At("2011-03-11T15:30:00"));
    expect([raised.filter(([, kind]) => kind === "53").map(([code]) => code).sort(), raised.some(([, kind]) => kind === "52")]).toEqual([["100", "101", "102", "320"], true]);
    expect(majors(r2At("2011-03-12T03:20:00")).filter(([, kind]) => kind === "53")).toEqual([]);
    const n1 = lists.N1.filter((item) => item.source === "synth:VTSE41" && tag(text(item), "EventID") === tag(text(lists.N1.find((report) => report.headType === "VXSE51")!), "EventID"));
    expect([majors(n1[0]).every(([, kind]) => kind === "53"), majors(n1[1]).every(([, kind]) => kind === "52"), majors(n1[1]).length > 0]).toEqual([true, true, true]);
    // (4)⑤ R2 の 3/12 20:20 は津波予報の区域が 71 のまま、3/13 17:58 の全解除には津波予報（71）の行も、前が津波予報の行も無い。
    const forecastRows = (item: Frame) => [...kinds(item).values()].filter((kind) => kind === "71").length;
    expect([forecastRows(r2At("2011-03-12T20:20:00")) > 0, forecastRows(r2At("2011-03-13T17:58:00"))]).toEqual([true, 0]);
    // (4)③ R2 の VTSE51: 版 4 に観測点 20102、版 5 に無い。観測点は同じ版の中で高さと第 1 波が全点同じではない（①）。
    const coastal = lists.R2.filter((item) => item.source === "synth:R2:VTSE51"), observationOf = (xml: string) => xml.slice(xml.indexOf("<Observation>"), xml.indexOf("</Observation>"));
    const serial = (n: number) => observationOf(text(coastal.find((item) => tag(text(item), "Serial") === String(n))!));
    expect([serial(4).includes("<Code>20102</Code>"), serial(5).includes("<Code>20102</Code>")]).toEqual([true, false]);
    const last = observationOf(text(coastal.at(-1)!)), distinct = (pattern: RegExp) => new Set([...last.matchAll(pattern)].map((match) => match[1])).size;
    expect([distinct(/<jmx_eb:TsunamiHeight[^>]*>([^<]*)</g) > 1, distinct(/<FirstHeight>\s*<ArrivalTime>([^<]*)</g) > 1]).toEqual([true, true]);
    // (5) R2 の本震: R2 の EventID の VXSE45 15 報（最後だけ最終報）・VXSE51（14:50）・VXSE53（14:54）、VXSE43 は無く、VXSE51 の最大の震度の府県は帯 0 の県。
    const ofR2 = (headType: string) => lists.R2.filter((item) => item.headType === headType && tag(text(item), "EventID") === "20110311144640");
    const eew = ofR2("VXSE45");
    expect([eew.length, eew.map((item) => text(item).includes("<NextAdvisory>")).lastIndexOf(true), lists.R2.some((item) => item.headType === "VXSE43"),
      ofR2("VXSE51").map((item) => item.atMs), ofR2("VXSE53").map((item) => item.atMs)]).toEqual([15, 14, false, [jst("2011-03-11T14:50:00")], [jst("2011-03-11T14:54:00")]]);
    const order = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"], prefs = [...text(ofR2("VXSE51")[0]).matchAll(/<Pref>\s*<Name>([^<]*)<\/Name><Code>\d+<\/Code><MaxInt>([^<]*)</g)];
    const top = prefs.reduce((max, match) => order.indexOf(match[2]) > order.indexOf(max) ? match[2] : max, "0");
    expect(prefs.length).toBeGreaterThan(0);
    expect(prefs.filter((match) => match[2] === top).map((match) => match[1]).every((name) => ["宮城県", "福島県", "茨城県", "栃木県"].includes(name))).toBe(true);
  }, 180_000);
});
