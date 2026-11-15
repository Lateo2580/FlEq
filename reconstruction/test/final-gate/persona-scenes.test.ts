import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { JsonValue, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { BodyResult, ListHead, UnitWalk } from "../../contracts/p3-recovery.types";
import { walkStart } from "../../src/recovery/recovery";
import { runStage1 } from "../disaster/runner";
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
  const eew: Frame[] = [["77_01_01_240613_VXSE45", "VXSE45"], ["77_01_03_240613_VXSE45", "VXSE45"], ["37_01_01_240613_VXSE43", "VXSE43"],
    ["77_01_04_240613_VXSE45", "VXSE45"], ["37_01_02_240613_VXSE43", "VXSE43"]].map(([name, headType]) => {
    const item = shiftedBy(name, delta, event);
    return frame(item.atMs, headType, item.xml);
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

// 演じ手には前の場面からの通知の最後の 20 件と、題名ごとの件数と「ほか n 件」だけを渡す（統合担当の決め、SCENE-TEXT の追加の「渡す量を絞る」の内。
// 23 時間分の 1,844 件を 1 場面で読む利用者はいない）。音の試行は題名が無いので「（音）資材の名前」で数える。評価者の file は全部を持つ。
const NOTIFICATION_LIMIT = 20;
function notificationsOf(attempts: readonly SceneAttempt[]): Readonly<{ notifications: JsonValue[]; notificationCounts: Record<string, number>; notificationsOmitted: number }> {
  const counts: Record<string, number> = {};
  for (const attempt of attempts) {
    const title = attempt.channel === "desktop" ? String(attempt.payload["title"] ?? "") : `（音）${attempt.soundAsset?.replace(/^.*\//, "").replace(/\.wav$/, "") ?? ""}`;
    counts[title] = (counts[title] ?? 0) + 1;
  }
  return { notifications: attempts.slice(-NOTIFICATION_LIMIT).map(notificationOf), notificationCounts: counts,
    notificationsOmitted: Math.max(0, attempts.length - NOTIFICATION_LIMIT) };
}
function notificationOf(attempt: SceneAttempt): JsonValue {
  const { title, body } = attempt.payload;
  return attempt.channel === "desktop" ? { at: jstText(attempt.atMs), channel: "desktop", title: title ?? null, body: body ?? null }
    : { at: jstText(attempt.atMs), channel: "sound", sound: attempt.soundAsset?.replace(/^.*\//, "").replace(/\.wav$/, "") ?? null };
}

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
    const chosen = scenario.kind === "ready" && first.scenes != null ? choose(candidatesOf(scenario, first.result, dispatches, first.scenes)) : [];
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
      // 外の演じ手に送れない場面は file の名前でも分ける（P3-FG-D-EXTERNAL-SEND=A。中身の印だけだと貼り付けで見落とす）。
      writeFileSync(join(dir, `${number}-actor${externalSend ? "" : "-local-only"}.json`), `${JSON.stringify({ scenario: id, persona, scene: written.length, at: jstText(scene.atMs), externalSend,
        ...notificationsOf(scene.attempts), screen: scene.screen }, null, 1)}\n`);
      writeFileSync(join(dir, `${number}-evaluator.json`), `${JSON.stringify({ scenario: id, scene: written.length, at: jstText(scene.atMs), rule,
        notifications: scene.attempts.map(notificationOf), facts: scene.facts }, null, 1)}\n`);
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
