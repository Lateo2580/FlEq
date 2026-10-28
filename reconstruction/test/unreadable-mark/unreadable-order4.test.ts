import { readFileSync } from "node:fs";
import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ExecutionPlace } from "../../contracts/p3-execution-split.types";
import type { ClockReading, RestoreUnitResult, RuntimeUnitId, UnreadableCard } from "../../contracts/p2-shared-runtime.types";
import { CheckpointCoordinator, hashEnvelope, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedUnitCodecs, linkedUnitTable, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { initialUnits, placeUnits, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import type { OwnerState, ParserCompletion } from "../../src/runtime/owner-runtime";
import { eewUnitCodec } from "../../src/units/eew/eew-unit";
import { tsunamiUnitCodec } from "../../src/units/tsunami/tsunami-unit";
import { volcanoUnitCodec } from "../../src/units/volcano/volcano-unit";
import { envelope, harnessedRoot, manualAdapter, startHarness, submit } from "../execution-split/owner-harness";
import { calls } from "../notification-delivery/delivery-fixture";

// P3-UNREADABLE-MARK-001（K14）発注 4 の試験: 読めない報の音（T12）・台風の地域ごとの不明（T14・T11 の areas）・取消の印（T20）。
// T12 の取り直しの列は recovery-adopt.test.ts（製品の publisher と host を通す）。

const at = (wallTimeMs: number, monotonicMs = 0): ClockReading => ({ wallTimeMs, monotonicMs });
const xmlOf = (name: string) => readFileSync(`test/fixtures/${name}.xml`, "utf8");

let sequence = 0;
function input(xml: string, headType: string, receivedAt: number): ParserCompletion {
  const entered = ingestXmlData({ inputId: `input-${++sequence}`, inputSequence: sequence, receivedAt, origin: "replay", kind: "replay", headType,
    body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  return { runId: "run", inputId: entered.item.inputId, result: decodeMaterial(entered.item), headType, receivedAt };
}
function owner(place: ExecutionPlace, now: number): OwnerState {
  const restored: Partial<Record<RuntimeUnitId, RestoreUnitResult>> = {};
  for (const unit of placeUnits(place)) restored[unit] = { kind: "empty" };
  return restoreOwner({ runId: "run", place, clock: at(now), restored }, linkedUnitTable, linkedUnitCodecs).state;
}
const receive = (state: OwnerState, completion: ParserCompletion, now: number) => receiveOwner(state, completion, at(now), linkedUnitTable);
const unreadableIntents = (state: OwnerState, unit: "U-E" | "U-T") => state.units[unit]!.intents.filter((item) => item.subject.endsWith("/unreadable"));
const losses = (state: OwnerState, unit: RuntimeUnitId) => Object.fromEntries((state.losses[unit] ?? []).map((row) => [row.reason, row.count]));

const temporary: string[] = [];
afterAll(async () => { for (const path of temporary) await fileSystem.rm(path, { recursive: true, force: true }); });
// envelope の unreadable を直接書いて読み戻す（AC16 (3)(b)）。
async function readBack(unit: RuntimeUnitId, cards: readonly unknown[], now: number): Promise<RestoreUnitResult> {
  const path = await fileSystem.mkdtemp(join(tmpdir(), "unreadable-order4-"));
  temporary.push(path);
  const codec = linkedUnitCodecs[unit]!;
  const envelope = hashEnvelope({ schemaVersion: codec.schemaVersion, unit, generation: 1, capturedAt: now, inputBoundary: null,
    payload: codec.encode(initialUnits[unit] as never), unreadable: cards as UnreadableCard[] });
  await fileSystem.writeFile(join(path, `${unit}-A.json`), serializedEnvelope(envelope));
  return new CheckpointCoordinator(path, linkedUnitCodecs, nodeCheckpointFileSystem(), () => at(now, 1), () => {}).restoreUnit(unit);
}

// ---- 台風の確率の報（AC14） ----

const PROBABILITY = xmlOf("76_01_01_200630_VPTA50");
const PROBABILITY_AT = Date.parse("2020-09-30T15:00:00+09:00");
// N 日積算の節（N=0 は時系列）の、code の地域の最初の値を value に替える。
function setValue(xml: string, day: number, code: string, value: string): string {
  const marker = day === 0 ? "<TimeSeriesInfo>" : `<MeteorologicalInfo type="台風の暴風域に入る確率（${day}日積算）">`;
  const start = xml.indexOf(marker), end = xml.indexOf(day === 0 ? "</TimeSeriesInfo>" : "</MeteorologicalInfo>", start);
  const area = xml.indexOf(`<Code>${code}</Code>`, start);
  const item = xml.lastIndexOf("<Item>", area);
  if (start < 0 || area < 0 || area > end || item < start) throw new Error(`no ${code} in day ${day}`);
  const body = xml.slice(item, area).replace(/(<FiftyKtWindProbability[^>]*>)[^<]*(<\/FiftyKtWindProbability>)/, `$1${value}$2`);
  return xml.slice(0, item) + body + xml.slice(area);
}
// 地域 count 件の確率の報（5 日積算は地域ごとに values の値、時系列は 1 時間帯）。name は地域名の長さ。
function probabilityXml(values: readonly string[], name = 4): string {
  const area = (index: number) => `<Area><Name>${"域".repeat(name - 1)}${index % 10}</Name><Code>${String(130001 + index)}</Code>`
    + "<Prefecture>東京都</Prefecture><PrefectureCode>130000</PrefectureCode></Area>";
  const item = (index: number, value: string, ref = "") => `<Item><Kind><Property><Type>台風の暴風域に入る確率</Type><FiftyKtWindProbabilityPart>`
    + `<FiftyKtWindProbability${ref} unit="%">${value}</FiftyKtWindProbability></FiftyKtWindProbabilityPart></Property></Kind>${area(index)}</Item>`;
  const days = [1, 2, 3, 4, 5].map((day) => `<MeteorologicalInfo type="台風の暴風域に入る確率（${day}日積算）">`
    + values.map((value, index) => item(index, day === 5 ? value : "1")).join("") + "</MeteorologicalInfo>").join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Report><Control><Title>台風の暴風域に入る確率</Title><DateTime>2026-08-31T00:00:00Z</DateTime>`
    + "<Status>通常</Status><PublishingOffice>気象庁</PublishingOffice></Control><Head><Title>台風の暴風域に入る確率</Title>"
    + "<ReportDateTime>2026-08-31T09:00:00+09:00</ReportDateTime><TargetDateTime>2026-08-31T09:00:00+09:00</TargetDateTime><EventID>TC2606</EventID>"
    + `<InfoType>発表</InfoType><Serial>1</Serial></Head><Body><MeteorologicalInfos type="台風情報">${days}<TimeSeriesInfo><TimeDefines>`
    + '<TimeDefine timeId="1"><DateTime>2026-08-31T09:00:00+09:00</DateTime><Duration>PT3H</Duration></TimeDefine></TimeDefines>'
    + values.map((_, index) => item(index, "1", ' refID="1"')).join("") + "</TimeSeriesInfo></MeteorologicalInfos></Body></Report>";
}
const SYNTHETIC_AT = Date.parse("2026-08-31T09:00:00+09:00");

describe("P3-UNREADABLE-MARK-001 order 4", () => {
  it("P3-UM-T12 acceptance / AC12: unreadable EEW and tsunami reports sound once per window at the K8 level; other units only make a card", () => {
    const T = Date.parse("2026-10-28T12:00:05+09:00");
    // 壊れた VXSE43（parser が断る）: critical・normalEew、カードと同じ世代（AC12 (9)）。
    const broken43 = xmlOf("37_01_01_240613_VXSE43").replace("</Head>", "</Hed>");
    const first = receive(owner("urgent", T), input(broken43, "VXSE43", T), T);
    expect(unreadableIntents(first.state, "U-E").map((item) => [item.channel, item.payload.level, item.priorityGroup, item.payload.title, item.payload.body]))
      .toEqual(["desktop", "sound"].map((channel) => [channel, "critical", "normalEew", "緊急地震速報（読めない報）を受信", "受信 12:00。内容を読めませんでした"]));
    expect([first.state.units["U-E"]!.persistence.currentGeneration, first.generationInputIds["U-E"]]).toEqual([1, [first.state.unreadable["U-E"]![0].inputId]]);
    // 3 秒後の 2 通目は窓の内で鳴らない（カードは 2 枚）。
    const second = receive(first.state, input(broken43, "VXSE43", T + 3_000), T + 3_000);
    expect([unreadableIntents(second.state, "U-E").length, second.state.unreadable["U-E"]!.length]).toEqual([2, 2]);
    // 窓（expiresAt の最大、15 秒）を過ぎた同じ壊れた報はもう一度鳴る。
    const third = receive(second.state, input(broken43, "VXSE43", T + 15_000), T + 15_000);
    expect(unreadableIntents(third.state, "U-E").filter((item) => item.createdAt === T + 15_000).map((item) => item.channel)).toEqual(["desktop", "sound"]);
    // 印は保存して読み戻せる（AC12 (8)、U-E v5）。
    const saved = eewUnitCodec.decode(JSON.parse(JSON.stringify(eewUnitCodec.encode(third.state.units["U-E"]!))));
    expect(saved.kind === "restored" && saved.state.unreadableNotices).toEqual([{ operation: "normal", level: "critical", until: T + 30_000 }]);

    // 読めない VXSE45（77_01_01 の写し）は warning。
    const at45 = Date.parse("2024-06-13T12:00:00+09:00");
    const forecast = receive(owner("urgent", at45), input(xmlOf("77_01_01_240613_VXSE45").replace("</Head>", "</Hed>"), "VXSE45", at45), at45);
    expect(unreadableIntents(forecast.state, "U-E").map((item) => item.payload.level)).toEqual(["warning", "warning"]);
    // training の VXSE43（unit が断る）は desktop だけで、題に訓練の接頭。
    const training = xmlOf("37_01_01_240613_VXSE43").replace("<Status>通常</Status>", "<Status>訓練</Status>").replace(/<EventID>[^<]*<\/EventID>/, "");
    const trained = receive(owner("urgent", T), input(training, "VXSE43", T), T);
    expect([trained.state.unreadable["U-E"]?.[0].kind, unreadableIntents(trained.state, "U-E").map((item) => [item.channel, item.operation, item.payload.title])])
      .toEqual(["unreadable", [["desktop", "training", "【訓練】緊急地震速報（読めない報）を受信"]]]);

    // 読めない VTSE41（Kind の Code の無い予報区、U-T が断る）: warning・normalTsunamiEmergency。
    const vtse41 = xmlOf("32-39_11_02_250206_VTSE41").replace(/(<Body[\s\S]*?<Category>\s*<Kind><Name>[^<]*<\/Name>)<Code>\d+<\/Code>/, "$1");
    const tAt = Date.parse("2011-03-11T14:49:01+09:00");
    const tsunami = receive(owner("urgent", tAt), input(vtse41, "VTSE41", tAt), tAt);
    expect(unreadableIntents(tsunami.state, "U-T").map((item) => [item.channel, item.payload.level, item.priorityGroup, item.payload.title]))
      .toEqual(["desktop", "sound"].map((channel) => [channel, "warning", "normalTsunamiEmergency", "津波の情報（読めない報）を受信"]));
    expect([tsunami.state.unreadable["U-T"]?.[0].kind, tsunami.state.units["U-T"]!.persistence.currentGeneration]).toEqual(["unreadable", 1]);
    const restored = tsunamiUnitCodec.decode(JSON.parse(JSON.stringify(tsunamiUnitCodec.encode(tsunami.state.units["U-T"]!))));
    expect(restored.kind === "restored" && restored.state.unreadableNotices).toEqual([{ operation: "normal", level: "warning", until: tAt + 180_000 }]);

    // 観測（VTSE51・VTSE52、parser が断る）は info・other。
    for (const [name, headType] of [["32-39_11_03_250206_VTSE51", "VTSE51"], ["32-39_12_05_250206_VTSE52", "VTSE52"]] as const) {
      const observed = receive(owner("urgent", tAt), input(xmlOf(name).replace("</Head>", "</Hed>"), headType, tAt), tAt);
      expect(unreadableIntents(observed.state, "U-T").map((item) => [item.channel, item.payload.level, item.priorityGroup]), headType)
        .toEqual([["desktop", "info", "other"], ["sound", "info", "other"]]);
    }
    // U-B の読めない報はカードだけで intent 0 件。
    const briefing = receive(owner("deferred", T), input("<Report><Head></Hed></Report>", "VPOA50", T), T);
    expect([briefing.state.unreadable["U-B"]?.map((card) => card.kind), briefing.state.units["U-B"]!.intents]).toEqual([["unidentified"], []]);
  });

  // ヘルツの品質レビュー r0 の P2: 音の再試行で intent の期限が延びたら、同じ operation の印の窓も延びる（無いと延びた音の鳴る間に、同じ段の
  // 続報がもう一度鳴る）。
  it("P3-UM-T12 regression / AC12 (4): a retried unreadable EEW sound extends the window, so a same-level report during the retry stays silent", async () => {
    const base = await fileSystem.mkdtemp(join(tmpdir(), "unreadable-retry-"));
    temporary.push(base);
    const T = Date.parse("2026-10-28T12:00:00+09:00");
    let now = at(T, 1_000);
    const adapter = manualAdapter();
    const h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: `${base}/state`, legacyStateDirectory: `${base}/legacy`,
      diagnosticDirectory: `${base}/diagnostics` }, linkedUnitCodecs, { clock: () => now, runtimeCalls: calls, notificationAdapter: adapter.adapter });
    await startHarness(h, "retry", now);
    const broken = Buffer.from(xmlOf("37_01_01_240613_VXSE43").replace("</Head>", "</Hed>"));
    await submit(h, envelope("retry", "VXSE43", "input-1", broken, now, 1));
    const sounds = () => adapter.runs.filter((run) => run.attempt.channel === "sound");
    const first = sounds()[0];
    // 9 秒で音が失敗し、再試行で期限が 24 秒に延びる。
    now = at(T + 9_000, 10_000);
    first.finish({ kind: "failed", reason: "adapterError", attemptId: first.attempt.attemptId, intentId: first.attempt.intentId, channel: "sound", completedAt: now });
    await h.settle();
    const retried = h.unit("U-E").intents.find((item) => item.id === first.attempt.intentId)!;
    expect([retried.expiresAt, h.unit("U-E").unreadableNotices]).toEqual([T + 24_000, [{ operation: "normal", level: "critical", until: T + 24_000 }]]);
    // 15 秒の同じ重さの壊れた報は延びた窓の内で鳴らない（カードは足す）。
    now = at(T + 15_000, 16_000);
    await submit(h, envelope("retry", "VXSE43", "input-2", broken, now, 2));
    expect(h.unit("U-E").intents.filter((item) => item.channel === "sound").map((item) => item.source.inputId)).toEqual(["input-1"]);
    expect(sounds().map((run) => run.attempt.intentId)).toEqual([first.attempt.intentId, first.attempt.intentId]);
  });

  it("P3-UM-T14 acceptance / AC14: a probability report with unreadable areas is rejected and its card lists each area, the unreadable ones as null", () => {
    const deferred = owner("deferred", PROBABILITY_AT);
    const before = receive(deferred, input(PROBABILITY, "VPTA50", PROBABILITY_AT), PROBABILITY_AT).state;
    const probability = before.units["U-Y"]!.probability;
    // 1 地域（宗谷北部）の 5 日積算の値を形の外に。報は断り、確率の記録は前のまま。
    const broken = receive(before, input(setValue(PROBABILITY, 5, "011011", "101"), "VPTA50", PROBABILITY_AT + 1), PROBABILITY_AT + 1);
    const card = broken.state.unreadable["U-Y"]?.[0];
    expect([broken.state.units["U-Y"]!.probability, card?.kind, card?.reason, card?.areas?.length]).toEqual([probability, "unreadable", "requiredStructureInvalid", 375]);
    expect([card?.areas?.at(-1), card?.areas?.slice(0, -1).every((area) => area.value != null)]).toEqual([{ code: "011011", name: "宗谷北部", value: null }, true]);
    const values = card!.areas!.slice(0, -1).map((area) => area.value!);
    expect(values).toEqual([...values].sort((left, right) => right - left));
    // 3 日積算だけを形の外にした報でも、その地域は null（P3-UM-D-TYPHOON-PARTIAL=A）。
    const third = receive(before, input(setValue(PROBABILITY, 3, "011011", "x"), "VPTA50", PROBABILITY_AT + 2), PROBABILITY_AT + 2);
    expect(third.state.unreadable["U-Y"]?.[0].areas?.find((area) => area.code === "011011")).toEqual({ code: "011011", name: "宗谷北部", value: null });
    // 重なる地域（synthetic_VPTA50_duplicate_area）。
    const dupAt = Date.parse("2026-08-31T09:00:00+09:00");
    const duplicated = receive(owner("deferred", dupAt), input(xmlOf("typhoon-probability-card/synthetic_VPTA50_duplicate_area"), "VPTA50", dupAt), dupAt);
    expect(duplicated.state.unreadable["U-Y"]?.[0].areas).toEqual([{ code: "130001", name: "試験地域", value: null }]);
    // 報の側の不備（題の欠け）もあれば areas の無いカード。
    const both = receive(before, input(setValue(PROBABILITY, 5, "011011", "101").replace(/(<Head[^>]*>[\s\S]*?)<Title>[^<]*<\/Title>/, "$1"), "VPTA50",
      PROBABILITY_AT + 3), PROBABILITY_AT + 3);
    expect([both.state.unreadable["U-Y"]?.[0].kind, both.state.unreadable["U-Y"]?.[0].areas]).toEqual(["unreadable", undefined]);
  });

  it("P3-UM-T11 contractBoundary / AC11 (9), AC16 (3)(b): card areas keep unreadable areas within 384 and 24,576 bytes, outlive raw and read back", async () => {
    // 400 地域（短い名前）: 384 件に落ち、不明の地域は残り、低い地域から落ちる。unreadableDropped が 1。
    const values = Array.from({ length: 400 }, (_, index) => String(index % 100));
    values[399] = "x";
    const many = receive(owner("deferred", SYNTHETIC_AT), input(probabilityXml(values), "VPTA50", SYNTHETIC_AT), SYNTHETIC_AT);
    const areas = many.state.unreadable["U-Y"]![0].areas!;
    // unreadableDropped は地域を落とした 1 件と、原文を切った（rawCut）カードの 1 件。
    expect([areas.length, areas.at(-1)?.value, areas.at(-2)?.value, many.state.unreadable["U-Y"]![0].rawCut, losses(many.state, "U-Y").unreadableDropped])
      .toEqual([384, null, 4, true, 2]);
    // 長い名前の 300 地域: 24,576 byte に収まるまで選ぶ。
    const long = receive(owner("deferred", SYNTHETIC_AT), input(probabilityXml(values.slice(100), 24), "VPTA50", SYNTHETIC_AT), SYNTHETIC_AT);
    const longAreas = long.state.unreadable["U-Y"]![0].areas!;
    expect([Buffer.byteLength(JSON.stringify(longAreas)) <= 24_576, longAreas.length < 300, longAreas.at(-1)?.value]).toEqual([true, true, null]);

    // 原文を外されても areas は残り、8 枚を越えて外れたときだけ消える。
    let state = owner("deferred", PROBABILITY_AT);
    const brokenProbability = setValue(PROBABILITY, 5, "011011", "101");
    for (let index = 0; index < 9; index++)
      state = receive(state, input(brokenProbability, "VPTA50", PROBABILITY_AT + index), PROBABILITY_AT + index).state;
    const cards = state.unreadable["U-Y"]!;
    expect([cards.length, cards[0].receivedAt, cards.some((card) => card.rawDropped === true), cards.every((card) => card.areas?.length === 375)])
      .toEqual([8, PROBABILITY_AT + 1, true, true]);
    // 欄の順（rawDropped は count の前、areas は最後）のまま保存して読み戻せる。areas は U-Y の unreadable のカードだけ・上限と要素の形を確かめる。
    const later = PROBABILITY_AT + 60_000;
    const back = await readBack("U-Y", cards, later);
    expect(back.kind === "restored" && back.envelope.unreadable).toEqual(cards);
    const card = cards.find((item) => item.rawDropped === true)!;
    for (const [unit, bad] of [["U-E", card], ["U-Y", { ...card, kind: "unidentified", reason: "xmlInvalid" }],
      ["U-Y", { ...card, areas: Array.from({ length: 385 }, (_, index) => ({ code: String(100000 + index), name: "a", value: 1 })) }],
      ["U-Y", { ...card, areas: [{ code: "12345", name: "a", value: 1 }] }], ["U-Y", { ...card, areas: [{ code: "123456", name: "a".repeat(25), value: 1 }] }],
      ["U-Y", { ...card, areas: [{ code: "123456", name: "a", value: 101 }] }], ["U-Y", { ...card, areas: [{ code: "123456", name: "a", value: 1.5 }] }]] as const)
      expect((await readBack(unit, [bad], later)).kind).toBe("unavailable");
  });

  it("P3-UM-T20 acceptance / AC19: a cancel without a volcano code that matches two ashfall forecasts marks both in the same receive's view", () => {
    const VFVO55 = xmlOf("66_01_03_210514_VFVO55");
    const ashAt = Date.parse("2021-05-14T12:51:00+09:00"), cancelAt = Date.parse("2021-05-14T12:52:00+09:00");
    const one = receive(owner("urgent", ashAt), input(VFVO55, "VFVO55", ashAt), ashAt).state;
    const two = receive(one, input(VFVO55.replaceAll("<Code>506</Code>", "<Code>999</Code>"), "VFVO55", ashAt), ashAt).state;
    const cancel = input(xmlOf("synthetic_VFVO55_cancel"), "VFVO55", cancelAt);
    const step = receive(two, cancel, cancelAt);
    const ashfalls = step.state.units["U-V"]!.ashfalls;
    // 手元は変わらず、2 件とも取消の ReportRef（subject はそれぞれの記録の subject）の印。通知は作らない。
    expect(ashfalls.map((item) => [item.effective, item.unconfirmed?.inputId, item.unconfirmed?.subject === item.subject])).toEqual([["active", cancel.inputId, true],
      ["active", cancel.inputId, true]]);
    const known = new Set(two.units["U-V"]!.intents.map((item) => item.id));
    expect(step.state.units["U-V"]!.intents.filter((item) => !known.has(item.id))).toEqual([]);
    // 同じ受信の views に U-V の view が載り、2 件に印が出る（保存・再起動を待たない）。
    const view = step.views.find((item) => item.unit === "U-V");
    expect(view != null && "ashfalls" in view && view.ashfalls.map((item) => item.unconfirmed?.inputId)).toEqual([cancel.inputId, cancel.inputId]);
    // encode → restore で 2 件の印が戻る。
    const decoded = volcanoUnitCodec.decode(JSON.parse(JSON.stringify(volcanoUnitCodec.encode(step.state.units["U-V"]!))));
    expect(decoded.kind === "restored" && decoded.state.ashfalls.map((item) => item.unconfirmed?.inputId)).toEqual([cancel.inputId, cancel.inputId]);
    // 0 件の取消は state を変えない。
    const none = receive(owner("urgent", cancelAt), input(xmlOf("synthetic_VFVO55_cancel"), "VFVO55", cancelAt), cancelAt);
    expect([none.changedUnits, none.views]).toEqual([[], []]);

    // 海上の警報（VFSV50）2 件に火山コードの無い海上の取消: 印は marineUnconfirmed（陸上の側は付けない）。
    const marineAt = Date.parse("2017-01-03T12:00:00+09:00"), marineCancelAt = Date.parse("2017-01-03T12:10:00+09:00");
    const VFSV = xmlOf("46_01_01_170103_VFSVii");
    const marines = receive(receive(owner("urgent", marineAt), input(VFSV, "VFSV50", marineAt), marineAt).state,
      input(VFSV.replaceAll("<Code>506</Code>", "<Code>999</Code>"), "VFSV50", marineAt), marineAt).state;
    const marineCancel = input(xmlOf("synthetic_VFVO50_cancel").replace(/<EventID>[^<]*<\/EventID>/, "<EventID>506</EventID>")
      .replace(/<ReportDateTime>[^<]*/, "<ReportDateTime>2017-01-03T12:10:00+09:00").replace(/(<Control>[\s\S]*?<DateTime>)[^<]*/, "$12017-01-03T03:10:00Z"),
    "VFSV50", marineCancelAt);
    const marineStep = receive(marines, marineCancel, marineCancelAt);
    expect(marineStep.state.units["U-V"]!.alerts.map((item) => [item.marineUnconfirmed?.inputId, item.marineUnconfirmed?.subject === item.subject, item.unconfirmed]))
      .toEqual([[marineCancel.inputId, true, undefined], [marineCancel.inputId, true, undefined]]);
    const marineView = marineStep.views.find((item) => item.unit === "U-V");
    expect(marineView != null && "alerts" in marineView && marineView.alerts.map((item) => item.marineUnconfirmed?.inputId)).toEqual([marineCancel.inputId,
      marineCancel.inputId]);

    // K7 の hold: 同じ Control/DateTime で中身の違う 66_01_03 の写しも、同じ受信の views に後着の報の印が出る。
    const late = input(VFVO55.replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>"), "VFVO55", ashAt);
    const held = receive(one, late, ashAt);
    const heldView = held.views.find((item) => item.unit === "U-V");
    expect([held.state.units["U-V"]!.ashfalls[0].unconfirmed?.inputId, heldView != null && "ashfalls" in heldView && heldView.ashfalls[0].unconfirmed?.inputId])
      .toEqual([late.inputId, late.inputId]);
  });
});
