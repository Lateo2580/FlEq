import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { JsonValue, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { DisplayDomainView, DisplaySeverity, DisplaySummaryItem } from "../../contracts/p2-snapshot-sse.types";
import type { DmdataClassification } from "../../contracts/p3-dmdata-connect.types";
import type { BodyResult, ListHead, UnitWalk } from "../../contracts/p3-recovery.types";
import { createNotificationGate } from "../../src/cli/notification-gate";
import { notificationSettingsFrom } from "../../src/cli/repl";
import { buildCapacityExceededLine, summaryRowVisible } from "../../src/display/chrome-eew/pure";
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

type Trial = Readonly<{ scenario: Scenario; dispatches: readonly Dispatch[]; prepare?: RunOptions["prepare"] }>;

// 流す順の (時刻, headType, 本文の sha256) の列の sha256（scenario.ts の digestOf と同じ形）。
function ready(id: string, frames: readonly Frame[], startMs: number, endMs: number): Scenario {
  const hash = createHash("sha256");
  for (const item of frames) hash.update(`${new Date(item.atMs).toISOString()}\t${item.headType}\t${sha256(item.body)}\n`);
  return { kind: "ready", id, frames, digest: hash.digest("hex"), startMs, endMs, checkpoints: [], expectations: [], synth: null, t0: null };
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
    const cancel = { atMs: at("23:31:20"), xml: retimed("77_01_33_240613_VXSE45", at("23:31:20"), b) };
    const finalAt = at("23:31:38");
    const frames = [first, third, other, cancel].map((item) => frame(item.atMs, "VXSE45", item.xml));
    frames.push(frame(finalAt, "VXSE45", retimed("77_01_03_240613_VXSE45", finalAt, a, (xml) => finalReport(xml.replace(/<Serial>\d+<\/Serial>/, "<Serial>4</Serial>")))));
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
  const coast = (kind: string) => [{ code: "310", name: "千葉県九十九里・外房", kind }, { code: "300", name: "茨城県", kind: "62" },
    { code: "311", name: "千葉県内房", kind: "62" }, { code: "320", name: "伊豆諸島", kind: "62" }, { code: "312", name: "東京湾内湾", kind: "62" }];
  const live = [...eew, frame(at("18:13:40"), "VXSE51", retimed("32-35_01_01_260824_VXSE51", at("18:13:40"), event)),
    frame(at("18:15:20"), "VTSE41", vtse41({ eventId: event, at: new Date(at("18:15:20")).toISOString(), areas: coast("51") }))].sort((x, y) => x.atMs - y.atMs);
  // 切断中に出た報（一覧の頭と本文）。
  const missed: readonly (readonly [ListHead, string])[] = [
    [head("m1", "U-Q", "VXSE53", at("18:16:50"), "震源・震度に関する情報", event, "1"), retimed("32-35_04_04_240613_VXSE53", at("18:16:50"), event)],
    [head("m2", "U-T", "VTSE41", at("18:21:10"), "津波警報", event, null), vtse41({ eventId: event, at: new Date(at("18:21:10")).toISOString(), areas: coast("52") })],
    [head("m3", "U-T", "VTSE51", at("18:23:00"), "津波観測に関する情報", event, "1"), observation({ eventId: event, at: new Date(at("18:23:00")).toISOString(), serial: 1,
      stations: [{ code: "31101", name: "銚子", condition: "第１波", height: "0.4" }] })],
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
  return { scenario: ready(id, live, start, at("18:30:00")), dispatches: connection(start, at("18:17:15"), at("18:24:15")), prepare };
}
function head(id: string, unit: RuntimeUnitId, headType: string, receivedAtMs: number, title: string, eventId: string, serial: string | null): ListHead {
  return { id, unit, headType, receivedAtMs, operation: "normal", title, headline: null, reportDateTime: null, infoType: "発表", serial, eventId,
    controlDateTime: null, controlStatus: "通常", test: false, editorialOffice: null };
}

// 製品の定数（composition-root.ts の RECOVERY_GAP_MS〔P3-REC-D-COALESCE=A〕と EEW_CONFIRM_MS〔P3-REC-D-EEW-CONFIRM=B〕）。export されておらず src は
// 本契約で変えないので、定義の行から読む（値を写すと製品を変えたときに古びる）。行が無ければ例外。
function productMs(name: string): number {
  const found = new RegExp(`^const ${name} = ([\\d_ *]+);`, "m").exec(readFileSync("reconstruction/src/runtime/composition-root.ts", "utf8"))?.[1];
  if (found == null) throw new Error(`${name} is not defined in composition-root.ts`);
  return found.split("*").reduce((product, factor) => product * Number(factor.trim().replace(/_/g, "")), 1);
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

// ---- 場面の file ----

const PERSONAS: Readonly<Record<string, string>> = { W2: "直人", "T2-naoto": "直人", N1: "沙織", N2: "沙織", N3: "沙織", R2: "沙織", "T2-saori": "沙織", "T2-yu": "悠" };
// 人物の契約の区分（P4-PWT-AC05 (1) の取り直しの classifications。発注 3 で AC07 (1) の表にする）。
const CLASSIFICATIONS: Readonly<Record<string, readonly DmdataClassification[]>> = { 直人: ["eew.warning"], 悠: ["eew.forecast"],
  沙織: ["eew.warning", "eew.forecast", "telegram.earthquake"] };
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
// 取消は最も重く置く（先に省くと、演じ手は取り消されていない警報だけを見て、製品の画面に無い状態になる。P4-PWT-AC02）。
type Notice = Readonly<{ atMs: number; rank: number; count: string; json: Readonly<Record<string, JsonValue>> }>;
const LEVEL_RANK: Readonly<Record<string, number>> = { cancel: 4, critical: 3, warning: 2, normal: 1 };
const assetOf = (attempt: SceneAttempt): string | null => attempt.soundAsset?.replace(/^.*\//, "").replace(/\.wav$/, "") ?? null;
function noticeOf(attempt: SceneAttempt): Notice {
  const { title, body, level } = attempt.payload;
  return { atMs: attempt.atMs, rank: LEVEL_RANK[String(level)] ?? 0, count: attempt.channel === "desktop" ? String(title ?? "") : `（音）${assetOf(attempt) ?? ""}`,
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
    return [{ atMs: item.atMs, rank: 0, count: "FlEq", json: { at: jstText(item.atMs), channel: "desktop", title: "FlEq",
      body: `回線が切れました（${jstText(from).slice(11, 19)} から受信できていません）` } }];
  });
}

// 演じ手には前の場面からの通知の 20 件と、題名ごとの件数と「ほか n 件」だけを渡す（統合担当の決め、SCENE-TEXT の追加の「渡す量を絞る」の内。
// 23 時間分の 1,844 件を 1 場面で読む利用者はいない）。評価者の file は全部を持つ。
const NOTIFICATION_LIMIT = 20;
function notificationsOf(notices: readonly Notice[]): Readonly<{ notifications: JsonValue[]; notificationCounts: Record<string, number>; notificationsOmitted: number }> {
  const counts: Record<string, number> = {};
  for (const notice of notices) counts[notice.count] = (counts[notice.count] ?? 0) + 1;
  // P4-PWT-AC02（実不具合: R2 S6 の 03:20 の大津波警報、W1-09-21 S8 の大島の L5 が新しい順の 20 件の切りで落ちた）: 段の重い順・同じ段は新しい順に残し、時刻の順に戻す。
  const kept = notices.map((notice, index) => ({ notice, index })).sort((a, b) => b.notice.rank - a.notice.rank || b.index - a.index)
    .slice(0, NOTIFICATION_LIMIT).sort((a, b) => a.index - b.index);
  return { notifications: kept.map(({ notice }) => notice.json), notificationCounts: counts, notificationsOmitted: Math.max(0, notices.length - NOTIFICATION_LIMIT) };
}
// 時刻の順（同じ時刻は元の順、試行が切断の行より先）。
const byTime = (list: readonly Notice[]): Notice[] => [...list].sort((a, b) => a.atMs - b.atMs);
// 製品の operationVisible（pure.ts、P2-CHROME-EEW の AC09: normal はいつも、training・test はその operation の EEW・容量超過の行・notice が出ている間だけ）。
// shortcut: 写し。operationVisible は DisplaySnapshot 全体を受け、場面の写し（fullScreen）からは呼べない。pure.ts の条件を変えたらここも変える。
function operationShown(screen: NonNullable<SceneCapture["fullScreen"]>, item: DisplaySummaryItem): boolean {
  if (item.operation === "normal") return true;
  const eew = screen.current.eew, tsunami = screen.current.tsunami.items.find((row) => row.operation === item.operation);
  return (eew.delivery === "full" ? eew.view.current.some((current) => current.operation === item.operation) : summaryRowVisible(item))
    || buildCapacityExceededLine(item) != null || (tsunami != null && buildCapacityExceededLine(tsunami) != null)
    || screen.notices.some((notice) => notice.operation === item.operation);
}
// P4-PWT-AC05 (2)（実不具合 T2-naoto.md:29）: 製品は items から確認状態の行を出すので、演じ手の screen の full の分野に要約の分野と同じ 3 欄を添える。
// 行は製品が見せる operation だけ（実装レビュー: 見せない training・test の startup の行を渡していた）。
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
      : { ...shown, items: domain.items.filter((item) => operationShown(fullScreen, item)).map(({ operation, confirmation, unconfirmed }) => ({ operation, confirmation, unconfirmed })) };
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
    const persona = id.startsWith("W1:") ? "直人" : PERSONAS[id] ?? null, classifications = CLASSIFICATIONS[persona ?? ""];
    if (t2 == null && classifications == null) throw new Error(`no persona contract for ${id}`);
    const { dispatches, options } = sceneRun(scenario, t2, classifications ?? []);
    const dir = join(out, id.replace(/[^A-Za-z0-9-]/g, "-"));
    mkdirSync(dir, { recursive: true });
    const blocked: string[] = [];

    const first = await runStage1(scenario, options({ times: [], write: () => {} }));
    // 門で止めた試行は場面の候補にしない（P4-PWT-AC01）。
    const chosen = scenario.kind === "ready" && first.scenes != null
      ? choose(candidatesOf(scenario, first.result, dispatches, { ...first.scenes, attempts: first.scenes.attempts.filter(passed) })) : [];
    const lost = connectionNotices(dispatches, scenario.kind === "ready" ? scenario.frames : []);
    // P3-FG-D-EXTERNAL-SEND=A: 採取物の EEW の EventID を含む場面は外部の演じ手に送らない。
    const realEew = scenario.kind === "ready" ? scenario.frames.filter((item) => item.origin === "real" && /^VXSE4[345]$/.test(item.headType)) : [];
    const realIds = new Set(realEew.map((item) => tag(Buffer.from(item.body).toString("utf8"), "EventID") ?? ""));
    const carriesRealEew = (scene: SceneCapture) => [...scene.attempts.filter((item) => item.unit === "U-E").map((item) => item.subject),
      ...(scene.facts["U-E"] ?? []).map((item) => item.subject)].some((subject) => [...realIds].some((eventId) => subject.includes(eventId)));
    const written: SceneCapture[] = [];
    const second = await runStage1(scenario, options({ times: chosen.map((item) => item.atMs), write: (scene) => {
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
    // capture の経路: U-Q・U-T を要約にする筋書き（P3-DC-T09 と同じ組み立て）の場面で、要約の分野の事実は subject が残り shown が全部 false。
    const t0 = jst("2026-06-26T00:00:00"), synthetic = synthesize("N1", 1, { t0Ms: t0 });
    const quake = Buffer.from(synthetic.filter((item) => item.headType === "VXSE53").reduce((a, b) => b.body.byteLength > a.body.byteLength ? b : a).body).toString("utf8");
    const forecast = Buffer.from(synthetic.find((item) => item.headType === "VTSE41")?.body ?? []).toString("utf8").replace(/<Comments>[\s\S]*?<\/Comments>/, "");
    const swap = (xml: string, index: number) => xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${20260626000100 + index}</EventID>`);
    const inputs = [0, 1, 2, 3].flatMap((index) => [...index < 3 ? [frame(t0 + index * MINUTE, "VXSE53", swap(quake, index))] : [],
      frame(t0 + index * MINUTE + 1_000, "VTSE41", swap(forecast, index))]);
    const scenes: SceneCapture[] = [];
    await runStage1(ready("P4-PWT-T04a", inputs, t0, t0 + 10 * MINUTE), { scenes: { times: [t0 + 10 * MINUTE], write: (scene) => scenes.push(scene) } });
    const summarized = Object.entries(scenes[0]?.screen?.current ?? {}).filter(([, domain]) => domain.delivery === "summary").map(([key]) => key);
    const facts = ["U-Q", "U-T"].map((unit) => scenes[0]?.facts[unit] ?? []);
    expect([summarized, facts.map((list) => list.length > 0 && list.every((item) => !item.shown))]).toEqual([["tsunami", "earthquake"], [true, true]]);
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
    // T09 と同じ sceneRun・actorFile を通る。normal の行で見る。沙織の契約（telegram.earthquake）で起動の取り直しが U-T・U-Q・U-N・U-M を流し始めに確かめ、
    // U-E は接続から 10 分の tick（接続の層の 2 点の tick の 2 つ目。製品の毎秒の tick と同じ時刻）で確かめる。契約に無い分野は startup のまま（host も辿らない）。
    const start = jst("2026-10-19T18:00:00");
    const scenario = ready("P4-PWT-T05", [frame(start + 5 * MINUTE, "VXSE53", retimed("32-35_04_04_240613_VXSE53", start + 5 * MINUTE, "20261019180500"))],
      start, start + 15 * MINUTE);
    const { options } = sceneRun(scenario, null, CLASSIFICATIONS["沙織"] ?? []);
    const scenes: SceneCapture[] = [];
    await runStage1(scenario, options({ times: [start, start + 10 * MINUTE - 1_000, start + 10 * MINUTE], write: (scene) => scenes.push(scene) }));
    const screens = scenes.map((scene) => actorFile({}, scene, []).screen);
    const startup = screens.map((screen) => screen == null ? null : Object.entries(screen.current).flatMap(([key, domain]) => domain.delivery === "full"
      && domain.items.some((item) => item.operation === "normal" && "startup" in item.unconfirmed) ? [key] : []));
    const outside = ["weatherCurrent", "weatherTimeseries", "volcano", "landslide", "flood", "briefing", "typhoon"];
    expect(startup).toEqual([["eew", ...outside], ["eew", ...outside], outside]);
    // 3 欄の写しは製品が見せる operation だけ（training・test は EEW・容量超過・notice が無いので出ない）。U-Q の normal は接続から 60 秒の tick の
    // 取り直し（最初の接続のきっかけ）で確かめ直した時刻、U-E の normal は 10 分の確認の時刻。
    const items = (key: string) => { const domain = screens[2]?.current[key]; return domain?.delivery === "full" ? domain.items : null; };
    expect([items("earthquake"), items("eew")]).toEqual([[{ operation: "normal", confirmation: { state: "confirmed", confirmedAt: start + MINUTE }, unconfirmed: {} }],
      [{ operation: "normal", confirmation: { state: "confirmed", confirmedAt: start + 10 * MINUTE }, unconfirmed: {} }]]);
  });
});
