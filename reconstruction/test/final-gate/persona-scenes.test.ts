import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { JsonValue, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { DisplayDomainView, DisplaySeverity, DisplaySummaryItem } from "../../contracts/p2-snapshot-sse.types";
import type { BodyResult, ListHead, UnitWalk } from "../../contracts/p3-recovery.types";
import { createNotificationGate } from "../../src/cli/notification-gate";
import { notificationSettingsFrom } from "../../src/cli/repl";
import { walkStart } from "../../src/recovery/recovery";
import { runtimeUnits } from "../../src/runtime/unit-coverage";
import { factsOf, runStage1, screenOf } from "../disaster/runner";
import type { Dispatch, RunOptions, SceneAttempt, SceneCapture } from "../disaster/runner";
import { readScenario } from "../disaster/scenario";
import type { Scenario } from "../disaster/scenario";
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
const bodyOf = (text: string, drop: readonly string[]): string => {
  const parsed: JsonValue = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("result is not a record");
  return sha256(JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([key]) => !drop.includes(key)))));
};
// 本体の hash（disaster.test.ts の bodyHash と同じく run の所要と自己 hash を除く）。AC09 との照合は gitHead も除く（T09 (2)）。
const bodyHash = (text: string) => bodyOf(text, ["timing", "selfSha256"]);
const ac09Hash = (text: string) => bodyOf(text, ["timing", "selfSha256", "gitHead"]);

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
// connectionLost ごとに同じ字の 1 行を足す。時刻は切断の時点の最後の受信（runner は ping を流さないので、最後の frame か接続の時刻）。
// 受信が 1 つも無ければ切断の時刻（output.ts の fromWallMs ?? now と同じ）。
// shortcut: 30 分で 3 回の「回線が不安定です」のまとめ・mute・connection の分野の設定は写さない。試行 2 は切断が 1 回だけ。切断の多い筋書きを足すときに写す。
function connectionNotices(dispatches: readonly Dispatch[], frames: readonly Frame[]): Notice[] {
  return dispatches.flatMap((item) => {
    if (item.kind !== "connectionLost") return [];
    const received = [...frames.filter((frame) => frame.atMs <= item.atMs).map((frame) => frame.atMs),
      ...dispatches.filter((before) => (before.kind === "connected" || before.kind === "frame") && before.atMs <= item.atMs).map((before) => before.atMs)];
    const from = received.length === 0 ? item.atMs : Math.max(...received);
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

describe.runIf(env["FLEQ_C22_SCENES"] != null)("P3-FINAL-GATE-001 persona scenes", () => {
  it("P3-FG-T09 acceptance / AC10: scenes are cut from two identical runs by the scene rule and written outside the repo", async () => {
    const id = env["FLEQ_C22_SCENES"]!, out = env["FLEQ_C22_SCENES_OUT"];
    if (out == null) throw new Error("FLEQ_C22_SCENES_OUT is required");
    const t2 = id.startsWith("T2-") ? trial(id) : null;
    const scenario = t2?.scenario ?? readScenario({ id, dataDir: env["FLEQ_DISASTER_DATA"] ?? null, expectedDigest: env["FLEQ_DISASTER_DIGEST"] ?? null });
    const dispatches = t2?.dispatches ?? [];
    // 試行 2 は本物の host と同じく 1 秒ごとに tick する（取り直しの開始・札の射影は publisher の tick が起こす。格子を飛ばすと繋がり直しの後に何も起きない）。
    const everySecond = scenario.kind === "ready" ? [{ fromMs: scenario.startMs, toMs: scenario.endMs }] : [];
    // 1 回の run は 35 分で止めて blocked にする（2 回で 75 分の timeout に収め、落ちる前に index を書く）。
    const options = (scenes: RunOptions["scenes"]): RunOptions => ({ scenes, budgetMs: 35 * MINUTE, ...t2 == null ? {} : { dispatches, everySecond, ...t2.prepare == null ? {} : { prepare: t2.prepare } } });
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
    const persona = id.startsWith("W1:") ? "直人" : PERSONAS[id] ?? null;
    const second = await runStage1(scenario, options({ times: chosen.map((item) => item.atMs), write: (scene) => {
      written.push(scene);
      const number = String(written.length).padStart(2, "0"), rule = chosen[written.length - 1]?.item ?? null, externalSend = !carriesRealEew(scene);
      const since = written.at(-2)?.atMs ?? -Infinity, lines = lost.filter((item) => item.atMs > since && item.atMs <= scene.atMs);
      // 外の演じ手に送れない場面は file の名前でも分ける（P3-FG-D-EXTERNAL-SEND=A。中身の印だけだと貼り付けで見落とす）。
      writeFileSync(join(dir, `${number}-actor${externalSend ? "" : "-local-only"}.json`), `${JSON.stringify({ scenario: id, persona, scene: written.length, at: jstText(scene.atMs), externalSend,
        ...notificationsOf(byTime([...scene.attempts.filter(passed).map(noticeOf), ...lines])), screen: scene.screen }, null, 1)}\n`);
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
    // (2) AC09 の筋書きは AC09 の同じ筋書きの結果と本体が一致し、その gitHead から src と災害の日の道具が変わっていない。
    let ac09: JsonValue = null;
    if (t2 == null) {
      const path = env["FLEQ_C22_SCENES_AC09"];
      if (path == null) blocked.push("FLEQ_C22_SCENES_AC09 is required for an AC09 scenario");
      else {
        const text = readFileSync(path, "utf8"), recorded: JsonValue = JSON.parse(text);
        const head = isRecord(recorded) && typeof recorded["gitHead"] === "string" ? recorded["gitHead"] : null;
        let unchanged = false;
        try { if (head != null) { execFileSync("git", ["diff", "--quiet", head, "--", "reconstruction/src", "reconstruction/test/disaster"]); unchanged = true; } } catch { unchanged = false; }
        ac09 = { path, gitHead: head, bodyMatches: ac09Hash(text) === ac09Hash(second.text), sourceUnchanged: unchanged };
        if (ac09Hash(text) !== ac09Hash(second.text)) blocked.push("body differs from the AC09 result");
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
    const { scenario, dispatches } = trial("T2-naoto");
    const frames = scenario.kind === "ready" ? scenario.frames : [];
    expect(connectionNotices(dispatches, frames).map((item) => item.json)).toEqual([{ at: "2026-10-20T02:48:10+09:00", channel: "desktop", title: "FlEq",
      body: `回線が切れました（${jstText(Math.max(...frames.map((frame) => frame.atMs))).slice(11, 19)} から受信できていません）` }]);
    // 切断より前に受信が無ければ切断の時刻（output.ts の fromWallMs ?? now）。
    expect(connectionNotices([{ atMs: jst("2026-10-20T01:00:00"), kind: "connectionLost" }], []).map((item) => item.json["body"])).toEqual(["回線が切れました（01:00:00 から受信できていません）"]);
  });
});
