import { describe, expect, it, vi } from "vitest";

import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type { FloodCurrent, FloodIntent, FloodStation, FloodUnitState, FloodUnitStep } from "../../contracts/p3-flood-unit.types";
import { deliveryGrowth } from "../../src/notification-delivery/delivery-growth";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { intentUpdateOwner, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { classifyHeadType, placeOfHeadType } from "../../src/runtime/unit-coverage";
import { floodUnitCodec, reduceFloodUnit, toFloodView } from "../../src/units/flood/flood-unit";
import {
  SAMPLE_RIVERS, clock, decodeFixture, decodeXml, emptyState, eventId, fixtureXml, receive, replaceTag, retime, rivers, send, serial, stationsXml,
  status,
} from "./flood-fixture";
import type { Group, StationSpec } from "./flood-fixture";

const HOUR = 3_600_000, RETAIN = 36 * HOUR;
const F = { sample: "16_02_01_220728_VXKO50", discharge: "16_03_01_220728_VXKO50", vxsu: "91_01_01_241031_VXSU50",
  correction: "synthetic_VXKO50_correction", code31: "synthetic_VXKO50_code31", cancel: "synthetic_VXKO50_cancel" } as const;
const SUBJECT = "normal/VXKO50/123456789012";
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms + 32_400_000).toISOString().replace(".000Z", "+09:00");
const T0 = at("2019-05-27T09:00:00+09:00");
const HEADLINE = "【警戒レベル３相当情報［洪水］】○○川上流では、今後、氾濫危険水位に到達する見込み";
const shape = (step: FloodUnitStep) => step.decisions.map((item) => [item.subject, item.decision,
  item.decision === "changed" ? item.change : item.decision === "unchanged" || item.decision === "rejected" ? item.reason : null]);
const levels = (step: FloodUnitStep) => step.intents.map((item) => `${item.channel}:${item.payload.level}`);
const pending = (state: FloodUnitState) => state.intents.filter((item) => item.disposition === "pending");
const recordOf = (state: FloodUnitState, subject = SUBJECT) => state.currents.find((item) => item.subject === subject);
const active = (value: FloodCurrent | undefined) => value?.effective === "active" ? value : null;
const kindsOf = (value: FloodCurrent | undefined) => active(value)?.kinds.map((group) => [group.code, group.level, group.rivers.map((river) => river.code)])
  ?? value?.effective ?? null;
const roundTrip = (state: FloodUnitState) => floodUnitCodec.decode(JSON.parse(JSON.stringify(floodUnitCodec.encode(state))) as JsonValue);
const tick = (state: FloodUnitState, wallTimeMs: number) => reduceFloodUnit(state, { kind: "deadline", clock: clock(wallTimeMs) });
// 16_02_01 の中の一区間だけを書き換える（同じ要素名が雨量情報や府県予報区等にもあるため）。
const region = (pattern: RegExp) => (edit: (part: string) => string) => (xml: string) => xml.replace(pattern, edit);
const riverPart = region(/<Information type="指定河川洪水予報（河川）">[\s\S]*?<\/Information>/);
const seriesPart = region(/<MeteorologicalInfos type="水位・流量情報">[\s\S]*?<\/MeteorologicalInfos>/);
const additionPart = region(/<FloodForecastAddition>[\s\S]*?<\/FloodForecastAddition>/);
const withoutZone = (xml: string) => xml.replace(/<Information type="指定河川洪水予報（予報区域）">[\s\S]*?<\/Information>/, "");
const withoutRivers = riverPart(() => "");
const group = (code: string, list: readonly Readonly<{ code: string; name?: string }>[] = SAMPLE_RIVERS): Group => ({ code, rivers: list });
// 同じ EventID の続報（16_02_01 を書き換え、ReportDateTime を進める）。
const follow = (state: FloodUnitState, edit: (xml: string) => string, time = "2019-05-27T09:30:00+09:00") =>
  send(state, F.sample, (xml) => edit(retime(time)(xml)));
// ○○○水位観測所の現況（refID 1）の観測レベルを替える。
const observed = (level: string) => seriesPart((part) => part.replace('<jmx_eb:WaterLevel type="レベル" refID="1">2</jmx_eb:WaterLevel>',
  `<jmx_eb:WaterLevel type="レベル" refID="1">${level}</jmx_eb:WaterLevel>`));

describe("P3-UNIT-R-001 U-R reducer", () => {
  // contractBoundary: Q-ENUM の順と原子性、合法の縮退、coverage と実行場所（AC01）。
  it("P3-C11-T01 contractBoundary / AC01: first reason only, unchanged state, a legal empty cancel and the U-R route", () => {
    const base = emptyState();
    const now = clock(T0);
    const xml = fixtureXml(F.sample);
    const reject = (source: string, inputId?: string) => {
      const step = receive(base, decodeXml(source, "VXKO50", inputId), now);
      expect(step.state).toBe(base);
      expect([step.intents, step.outcomes, step.displayChanges, step.diagnostics.length, step.decisions.length]).toEqual([[], [], [], 1, 1]);
      const result = step.decisions[0];
      return result.decision === "rejected" ? `${result.reason} ${result.subject}`.trim() : result.decision;
    };
    const ids = (value: string) => xml.replace("<EventID>123456789012</EventID>", value);
    const cases: [string, string][] = [
      [ids(""), "identityMissing"], [ids("<EventID> </EventID>"), "identityMissing"],
      [ids("<EventID>123456789012</EventID><EventID>123456789013</EventID>"), "identityInvalid"],
      [eventId("1".repeat(41))(xml), "identityInvalid"], [eventId("１２３")(xml), "identityInvalid"],
      [xml.replace("<Serial>3</Serial>", ""), `identityMissing ${SUBJECT}`],
      [serial("1a")(xml), `identityInvalid ${SUBJECT}`], [serial("12345678901")(xml), `identityInvalid ${SUBJECT}`],
      // 小数秒で 40 文字を超える ReportDateTime と、8 文字を超える InfoType の raw（保存する ReportRef の上限、Q-ENUM.identity）。
      [retime("2019-05-27T09:00:00.0000000000000000+09:00")(xml), `identityInvalid ${SUBJECT}`],
      [replaceTag("InfoType", "発表        ")(xml), `identityInvalid ${SUBJECT}`],
      [xml.replace("<Title>○○川上流氾濫警戒情報</Title>", ""), `requiredStructureMissing ${SUBJECT}`],
      [replaceTag("InfoType", "不明")(xml), `requiredStructureInvalid ${SUBJECT}`],
      [rivers([group("30", [SAMPLE_RIVERS[0]]), group("30", [SAMPLE_RIVERS[1]])])(xml), `requiredStructureInvalid ${SUBJECT}`],
      [riverPart((part) => part.replace(/<Kind>[\s\S]*?<\/Kind>/, ""))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [riverPart((part) => part.replace(/<Kind>[\s\S]*?<\/Kind>/, (kind) => kind + kind))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [riverPart((part) => part.replace("<Code>30</Code>", "<Code>3</Code>"))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [riverPart((part) => part.replace("9876543210", "1234567890"))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [riverPart((part) => part.replace("9876543210", "1".repeat(17)))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [riverPart((part) => part.replace("<Name>○○川</Name>", "<Name>○○\t川</Name>"))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [seriesPart((part) => part + part)(xml), `requiredStructureInvalid ${SUBJECT}`],
      [seriesPart((part) => part.replace('timeId="2"', 'timeId="1"'))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [seriesPart((part) => part.replace("2019-05-27T10:00:00+09:00", "2019-05-27T10:00:00Z"))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [seriesPart((part) => part.replace('refID="7" condition="正常">145.00', 'refID="8" condition="正常">145.00'))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [additionPart((part) => part.replace("<Name>△△△水位観測所</Name>", "<Name>○○○水位観測所</Name>"))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [seriesPart((part) => part.replace(">143.00<", ">143.0001<"))(xml), `requiredStructureInvalid ${SUBJECT}`],
      // Head/InfoType は 1 個の scalar（C10 の品質レビュー P2: 子要素や重複を取消と読まない）。
      [xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消<X/></InfoType>"), `requiredStructureInvalid ${SUBJECT}`],
      // 実不具合（品質レビュー P2）: 子要素を持つ Kind/Code は報ごと拒む（その group だけを落とすと、残った解除の group で現況を消す）。
      [rivers([{ code: "40<X/>", name: "氾濫危険情報", rivers: [SAMPLE_RIVERS[0]] }, { code: "10", rivers: [SAMPLE_RIVERS[1]] }])(xml), `requiredStructureInvalid ${SUBJECT}`],
      // 存在が妥当性より先（Q-ENUM.priorityRule）: Kind の 2 個より河川の code の欠落。
      [riverPart((part) => part.replace(/<Kind>[\s\S]*?<\/Kind>/, (kind) => kind + kind).replace("<Code>9876543210</Code>", ""))(xml),
        `requiredStructureMissing ${SUBJECT}`],
    ];
    expect(cases.map(([source]) => reject(source))).toEqual(cases.map(([, reason]) => reason));
    // 保存する inputId の上限（64 文字）を超える入力は identityInvalid。40 文字の印字可能な ASCII の EventID と 64 文字の inputId は合法。
    expect(reject(xml, "i".repeat(65))).toBe(`identityInvalid ${SUBJECT}`);
    expect(receive(base, decodeXml(eventId("~".repeat(40))(xml), "VXKO50", "i".repeat(64)), now).decisions[0].decision).toBe("changed");
    // 合法: Body・Headline の無い取消（記憶だけ）。
    // inputId は「"」と「\」を除く印字可能な ASCII（品質レビュー P2、容量の上界の 1 文字 1 byte）。
    expect(['in"put', "in\\put", "入力"].map((inputId) => reject(xml, inputId))).toEqual(Array(3).fill(`identityInvalid ${SUBJECT}`));
    // InfoType の raw は trim せずに保存し、比較は trim した値（品質レビュー P3）: 同じ版の「発表」は duplicate。
    const padded = send(base, F.sample, replaceTag("InfoType", "\t発表\t"));
    expect([shape(padded), recordOf(padded.state)?.source.infoTypeRaw, shape(send(padded.state, F.sample)), roundTrip(padded.state).kind]).toEqual([
      [[SUBJECT, "changed", "semantic"]], "\t発表\t", [[SUBJECT, "unchanged", "duplicate"]], "restored"]);
    expect(shape(send(base, F.cancel))).toEqual([[SUBJECT, "changed", "revisionOnly"]]);
    expect(shape(send(base, "synthetic_VXSU50_cancel"))).toEqual([["normal/VXSU50/8201813100", "changed", "revisionOnly"]]);

    for (const headType of ["VXKO50", "VXKO89", "VXSU50", "VXSU59"])
      expect([classifyHeadType(headType), placeOfHeadType(headType)]).toEqual([{ status: "ready", unit: "U-R" }, "deferred"]);
    // 一入力は U-R だけへ届き、同じ deferred の U-F・U-L の state は同じ参照のまま。
    const owner = restoreOwner({ runId: "run", place: "deferred", clock: now, restored: { "U-F": { kind: "empty" }, "U-L": { kind: "empty" },
      "U-R": { kind: "empty" }, "U-B": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const material = decodeFixture(F.sample);
    const routed = receiveOwner(owner, { runId: "run", inputId: material.inputId, result: { kind: "decoded", material } }, now, linkedUnitTable);
    expect(routed.changedUnits).toEqual(["U-R"]);
    expect([routed.state.units["U-F"], routed.state.units["U-L"]]).toEqual([owner.units["U-F"], owner.units["U-L"]]);
    expect(routed.state.units["U-F"]).toBe(owner.units["U-F"]);
    expect(routed.state.units["U-L"]).toBe(owner.units["U-L"]);
  });

  // acceptance: EventID の current（AC02）。続報は試験内で 16_02_01 を書き換えて作る。
  it("P3-C11-T02 acceptance / AC02: rivers, stations and series, replacement, release, unknown codes, unread rivers and operations", () => {
    const first = send(emptyState(), F.sample);
    const record = recordOf(first.state)!;
    expect(shape(first)).toEqual([[SUBJECT, "changed", "semantic"]]);
    expect(record).toMatchObject({ headType: "VXKO50", eventId: "123456789012", effective: "active", title: "○○川上流氾濫警戒情報",
      areaName: "○○川上流", basisReportDateTimeRaw: null, truncated: false, retainUntil: T0 + RETAIN,
      times: ["09", "10", "11", "12", "13", "14", "15"].map((hour) => `2019-05-27T${hour}:00:00+09:00`) });
    expect(kindsOf(record)).toEqual([["30", 3, ["1234567890", "9876543210"]]]);
    // 3 観測所は同じ code で名前が違う（(code, name) で一意）。riverCodes は ChargeSection の 1 行目と同じ名前の河川（○×川は河川に無い）。
    const station = (index: number) => active(record)!.stations[index];
    expect(active(record)!.stations.map((item) => [item.code, item.name, item.riverCodes, item.measurement])).toEqual([
      ["12345678901234567", "○○○水位観測所", ["1234567890"], "waterLevel"], ["12345678901234567", "△△△水位観測所", ["1234567890"], "waterLevel"],
      ["12345678901234567", "□□□水位観測所", ["9876543210"], "waterLevel"]]);
    expect([station(0).values, station(0).levels, station(0).criteria]).toEqual([[143, 144.8, 145, 144.8, 144.9, 145, 145], [2, 3, 4, 3, 4, 4, 4],
      { level1: 142, level2: 142.5, level3: 144.6, level4: 144.9, level4Plan: 145.1 }]);
    // 未計算の点（値なし・レベル 9）は null（欠測を 0 や正常に読み替えない、spec:1468）。
    expect([station(1).values, station(1).levels]).toEqual([[46.6, null, null, null, null, null, null], [2, null, null, null, null, null, null]]);
    // 採用時の outcome の facts には Head/Headline/Text を載せる（保存しない）。
    expect(first.outcomes[0]).toMatchObject({ kind: "accepted", subjects: [{ facts: { headline: HEADLINE } }] });
    expect("headline" in JSON.parse(JSON.stringify(floodUnitCodec.encode(first.state))).currents[0]).toBe(false);
    // 流量の観測所は discharge。VXSU は series を持たず times・values が空、基準水位は旧称の段で引く。
    expect(active(recordOf(send(emptyState(), F.discharge).state))!.stations.map((item) => item.measurement)).toEqual(["discharge", "discharge", "discharge"]);
    const vxsu = recordOf(send(emptyState(), F.vxsu).state, "normal/VXSU50/8201813100");
    expect([kindsOf(vxsu), active(vxsu)?.areaName, active(vxsu)?.times, active(vxsu)?.stations]).toEqual([[["21", 2, ["82018131"]]], "善川", [], [{
      code: "820181310000081", name: "塩浪", riverCodes: ["82018131"], measurement: "waterLevel", values: [], levels: [],
      criteria: { level1: null, level2: 2.6, level3: 3.1, level4: 3.8, level4Plan: null } }]]);

    // 続報は事実を全部置き換える。レベル2だけの報は active、表に無い code は level null の active、code 22 はレベル2。
    const kinds = (code: string) => kindsOf(recordOf(follow(first.state, rivers([group(code)])).state));
    expect([kinds("21"), kinds("22"), kinds("59")]).toEqual([[["21", 2, SAMPLE_RIVERS.map((item) => item.code)]],
      [["22", 2, SAMPLE_RIVERS.map((item) => item.code)]], [["59", null, SAMPLE_RIVERS.map((item) => item.code)]]]);
    expect(recordOf(follow(first.state, rivers([group("21")])).state)?.effective).toBe("active");
    // 全河川の code 10 は ended（事実を捨てる）、記録の無い subject への解除は watermark だけの ended（revisionOnly）。
    const ended = follow(first.state, rivers([group("10")]));
    expect([shape(ended), recordOf(ended.state)?.effective, "kinds" in recordOf(ended.state)!, toFloodView(ended.state).currents]).toEqual([
      [[SUBJECT, "changed", "semantic"]], "ended", false, []]);
    const watermark = send(emptyState(), F.sample, rivers([group("10")]));
    expect([shape(watermark), recordOf(watermark.state)?.effective, watermark.displayChanges]).toEqual([[[SUBJECT, "changed", "revisionOnly"]],
      "ended", []]);
    // kinds 空の報（「（河川）」Information が無い）は前の事実を保ち basis を持つ。記録が無ければ kinds 空の active を作る。
    const unread = follow(first.state, withoutRivers);
    expect([shape(unread), recordOf(unread.state)]).toEqual([[[SUBJECT, "changed", "semantic"]], { ...record,
      source: expect.objectContaining({ reportDateTimeRaw: "2019-05-27T09:30:00+09:00" }), retainUntil: T0 + 30 * 60_000 + RETAIN,
      basisReportDateTimeRaw: "2019-05-27T09:00:00+09:00" }]);
    expect(active(recordOf(follow(unread.state, withoutRivers, "2019-05-27T09:40:00+09:00").state))?.basisReportDateTimeRaw)
      .toBe("2019-05-27T09:00:00+09:00");
    const fresh = active(recordOf(send(emptyState(), F.sample, withoutRivers).state));
    expect([fresh?.kinds, fresh?.stations.length, fresh?.basisReportDateTimeRaw]).toEqual([[], 3, null]);
    // kinds のある報は全観測所の値が null でも active のまま事実を置き換える。
    const blank = active(recordOf(follow(first.state, seriesPart((part) => part.replace(/>[-\d.]+<\/jmx_eb:WaterLevel>/g, "></jmx_eb:WaterLevel>"))).state));
    expect([blank?.effective, blank?.stations.every((item) => item.values.every((value) => value == null) && item.levels.every((value) => value == null))])
      .toEqual(["active", true]);
    // ChargeSection が 2 個で別の河川を指す観測所の riverCodes は 2 件、名前が河川に無い観測所は空。
    const linked = active(recordOf(follow(first.state, rivers([group("30", [SAMPLE_RIVERS[0], { code: "9876543210", name: "○×川" }])])).state));
    expect(linked?.stations.map((item) => item.riverCodes)).toEqual([["1234567890", "9876543210"], ["1234567890"], []]);
    // 非 BMP の文字で切る位置がサロゲートの組にかかる名前は、孤立したサロゲートを作らず切る（decode も通す）。
    const wide = follow(first.state, rivers([group("30", [{ code: "1234567890", name: `あ${"𠮷".repeat(16)}` }])]));
    expect([active(recordOf(wide.state))?.kinds[0].rivers[0].name, active(recordOf(wide.state))?.truncated, roundTrip(wide.state).kind])
      .toEqual([`あ${"𠮷".repeat(15)}`, true, "restored"]);
    // 別の EventID の報は記録を変えない。試験の報は区分を交差しない。
    const other = send(first.state, F.sample, eventId("123456789099"));
    expect([other.state.currents.length, recordOf(other.state)]).toEqual([2, record]);
    const test = send(first.state, F.sample, status("試験"));
    expect([shape(test), recordOf(test.state), recordOf(test.state, "test/VXKO50/123456789012")?.operation]).toEqual([
      [["test/VXKO50/123456789012", "changed", "semantic"]], record, "test"]);
  });

  // acceptance: 版・取消・期限（AC03）。
  it("P3-C11-T03 acceptance / AC03: revisions, subject-scoped cancel, the 36 h expiry with its desktop notice and late reports", () => {
    const first = send(emptyState(), F.sample);
    // 同じ版の重複と食い違い（先着を保ち WARN）。
    const duplicate = send(first.state, F.sample);
    expect([shape(duplicate), duplicate.diagnostics]).toEqual([[[SUBJECT, "unchanged", "duplicate"]], []]);
    expect(duplicate.state).toBe(first.state);
    const conflict = send(first.state, F.sample, rivers([group("40")]));
    expect([shape(conflict), conflict.diagnostics]).toEqual([[[SUBJECT, "unchanged", "stale"]],
      [{ level: "WARN", component: "flood", reason: "floodRevisionConflict", inputId: expect.any(String), unit: "U-R" }]]);
    expect(conflict.state).toBe(first.state);
    // ReportDateTime が先で Serial は後（09:30 の Serial 2 の訂正、10:00 の Serial 1 の発表を採用）。
    expect(shape(send(first.state, F.correction))).toEqual([[SUBJECT, "changed", "semantic"]]);
    expect(shape(send(first.state, F.sample, (xml) => serial("1")(retime("2019-05-27T10:00:00+09:00")(xml))))).toEqual([[SUBJECT, "changed", "revisionOnly"]]);
    // 取消は subject だけを cancelled にし、前の事実を戻さない。
    const cancelled = send(send(first.state, F.code31).state, F.cancel);
    expect([shape(cancelled), recordOf(cancelled.state)]).toEqual([[[SUBJECT, "changed", "semantic"]], { subject: SUBJECT, operation: "normal",
      headType: "VXKO50", eventId: "123456789012", source: expect.objectContaining({ infoTypeRaw: "取消" }), retainUntil: T0 + 3 * HOUR + RETAIN,
      effective: "cancelled" }]);
    expect(recordOf(cancelled.state, "normal/VXKO50/123456789013")?.effective).toBe("active");
    // 取消以前の版は stale で復活しない。取消より新しい発表は新しい報として採用し active に戻す（activated）。
    for (const name of [F.sample, F.correction]) expect(shape(send(cancelled.state, name))).toEqual([[SUBJECT, "unchanged", "stale"]]);
    const again = send(cancelled.state, F.sample, (xml) => serial("5")(retime("2019-05-27T12:30:00+09:00")(xml)));
    expect([shape(again), recordOf(again.state)?.effective, again.intents.map((item) => item.transition)]).toEqual([
      [[SUBJECT, "changed", "semantic"]], "active", ["activated", "activated"]]);
    // 記録の無い subject への取消は記憶だけで鳴らない。
    const memory = send(emptyState(), F.cancel);
    expect([recordOf(memory.state)?.effective, memory.intents]).toEqual(["cancelled", []]);

    // 期限の来ていない deadline 入力は同じ state 参照と空の結果。
    const idle = tick(first.state, T0 + 30_000);
    expect([idle.decisions, idle.intents, idle.outcomes, idle.displayChanges, idle.diagnostics]).toEqual([[], [], [], [], []]);
    expect(idle.state).toBe(first.state);
    // 35 時間 59 分では残り、36 時間で active を除き、同じ reduce で desktop だけの期限切れを 1 件作る（P3-C11-ACTIVE-EXPIRY=D）。
    const kept = tick(first.state, T0 + RETAIN - 60_000);
    expect(recordOf(kept.state)?.effective).toBe("active");
    const expired = tick(kept.state, T0 + RETAIN);
    const notice = (step: FloodUnitStep) => step.intents.map((item) => [item.channel, item.transition, item.payload.level, item.payload.title,
      item.payload.body]);
    expect([expired.state.currents, notice(expired), expired.displayChanges.map((item) => [item.subject, item.after])]).toEqual([[],
      [["desktop", "expired", "info", "[期限切れ] ○○川上流氾濫警戒情報", "○○川上流の洪水予報は36時間続報がなく、現況を確認できません"]], [[SUBJECT, null]]]);
    expect(pending(expired.state)).toEqual(expired.intents);
    // areaName が空の本文、training/test の前置き、復元の後の期限切れの回収。
    const blank = send(emptyState(), F.sample, withoutZone).state;
    expect(notice(tick(blank, T0 + RETAIN))[0][4]).toBe("この洪水予報は36時間続報がなく、現況を確認できません");
    expect(["訓練", "試験"].map((mark) => notice(tick(send(emptyState(), F.sample, status(mark)).state, T0 + RETAIN))[0].slice(0, 4))).toEqual([
      ["desktop", "expired", "info", "【訓練】[期限切れ] ○○川上流氾濫警戒情報"], ["desktop", "expired", "info", "【試験】[期限切れ] ○○川上流氾濫警戒情報"]]);
    const restored = reduceFloodUnit(emptyState(), { kind: "restore", persisted: floodUnitCodec.encode(first.state), clock: clock(T0 + RETAIN + 1) });
    expect([restored.intents, recordOf(restored.state)?.effective]).toEqual([[], "active"]);
    expect(notice(tick(restored.state, T0 + RETAIN + 2)).map((item) => item[1])).toEqual(["expired"]);
    // ended・cancelled の回収では作らない。
    expect(tick(follow(first.state, rivers([group("10")])).state, T0 + 30 * 60_000 + RETAIN).intents).toEqual([]);
    // 取消の記憶（12:00 の取消）は黙って除き、同じ時刻までに期限の来た 123456789013（10:00 の active）だけが期限切れを作る。
    const forgotten = tick(cancelled.state, T0 + 3 * HOUR + RETAIN);
    expect([forgotten.state.currents, forgotten.intents.map((item) => item.subject)]).toEqual([[], ["normal/VXKO50/123456789013"]]);
    // 解除・取消の記憶が 36 時間で消えた後に遅れて届いた古い発表（受理の時点で ReportDateTime+39 時間）は stale で鳴らない。
    const late = send(forgotten.state, F.sample, undefined, T0 + 3 * HOUR + RETAIN + 60_000);
    expect([shape(late), late.intents, late.displayChanges]).toEqual([[[SUBJECT, "unchanged", "stale"]], [], []]);
    expect(late.state).toBe(forgotten.state);
    // 記録があっても、受理の時点で +36 時間を過ぎた新しい版は state を変えない（ちょうど 36 時間も遅着）。
    const overdue = send(first.state, F.sample, (xml) => serial("4")(retime("2019-05-27T10:00:00+09:00")(xml)), T0 + HOUR + RETAIN);
    expect(shape(overdue)).toEqual([[SUBJECT, "unchanged", "stale"]]);
    expect(overdue.state).toBe(first.state);
  });

  // contractBoundary: 容量と受信 1 回の費用（AC04）。境界入力は試験内で作る。
  it("P3-C11-T04 contractBoundary / AC04: 512/513 subjects, eviction order, report bounds, pending and terminal budgets, no whole encode", () => {
    const now = T0 + HOUR;
    const seed = active(recordOf(send(emptyState(), F.sample).state))!;
    const subjectRecord = (index: number, patch: Partial<{ operation: Operation; retainUntil: number; inactive: boolean }> = {}): FloodCurrent => {
      const operation = patch.operation ?? "normal", id = `E${String(index).padStart(3, "0")}`, subject = `${operation}/VXKO50/${id}`;
      const reported = now - (600 - index) * 60_000;
      const source = { ...seed.source, operation, subject, reportDateTimeRaw: iso(reported) };
      const base = { subject, operation, headType: "VXKO50", eventId: id, source, retainUntil: patch.retainUntil ?? reported + RETAIN };
      return patch.inactive ? { ...base, effective: "ended" } : { ...seed, ...base };
    };
    const report = (id: string, mark = "通常") => decodeFixture(F.sample, (xml) => status(mark)(eventId(id)(retime(iso(now))(xml))));
    const filled = (values: readonly FloodCurrent[]): FloodUnitState => ({ ...emptyState(), currents: values });
    const evictedDiagnostic = { level: "INFO", component: "flood", reason: "floodCapacityEvicted", unit: "U-R", count: 1 };
    expect(receive(filled(Array.from({ length: 511 }, (_, index) => subjectRecord(index))), report("N1"), clock(now)).diagnostics).toEqual([]);
    const full = Array.from({ length: 512 }, (_, index) => subjectRecord(index));
    const pushed = receive(filled(full), report("N1"), clock(now));
    expect([pushed.diagnostics, pushed.state.currents.length, pushed.state.currents.includes(full[0])]).toEqual([[evictedDiagnostic], 512, false]);
    // 退去の順: (1) retainUntil を過ぎたもの → (2) inactive → (3) training/test → (4) normal の最古。capacityExceeded を返さない。
    let state = filled([subjectRecord(0), subjectRecord(1, { operation: "training" }), subjectRecord(2, { inactive: true }),
      subjectRecord(3, { retainUntil: now }), ...Array.from({ length: 508 }, (_, index) => subjectRecord(index + 10))]);
    const evicted: string[] = [];
    for (const id of ["N2", "N3", "N4", "N5"]) {
      const before = state.currents.map((item) => item.subject);
      const step = receive(state, report(id), clock(now));
      expect(step.decisions[0].decision).toBe("changed");
      state = step.state;
      evicted.push(...before.filter((subject) => !state.currents.some((item) => item.subject === subject)));
    }
    expect(evicted).toEqual([subjectRecord(3).subject, subjectRecord(2).subject, subjectRecord(1, { operation: "training" }).subject,
      subjectRecord(0).subject]);
    // normal の active だけの満杯に training の報を受けたら、その記録自身を退去する（currents の参照と保存世代を変えない、通知しない）。
    const crowded = filled(full);
    const self = receive(crowded, report("T1", "訓練"), clock(now));
    expect([shape(self), self.intents, self.diagnostics]).toEqual([[["training/VXKO50/T1", "changed", "revisionOnly"]], [], [evictedDiagnostic]]);
    // 自身の退去の結果は最終の状態の時制（P3-OPCAP-AC02）。
    expect([self.decisions[0], self.outcomes]).toEqual([expect.objectContaining({ currentEstablished: null }),
      [{ kind: "accepted", change: "revisionOnly", subjects: [] }]]);
    // 監査 F04-R（P3-OPCAP-AC01）: normal の ended の記録は training の受理で退去しない。training があればそれを退去する。
    const ended = subjectRecord(900, { inactive: true }), drill = subjectRecord(901, { operation: "training" });
    const withMemory = [ended, ...full.slice(1)];
    expect(receive(filled(withMemory), report("T3", "訓練"), clock(now)).state.currents).toBe(withMemory);
    const trainingIn = receive(filled([ended, drill, ...full.slice(2)]), report("T4", "訓練"), clock(now)).state.currents;
    expect([trainingIn.includes(ended), trainingIn.includes(drill), trainingIn.length]).toEqual([true, false, 512]);
    expect([self.state.currents, self.state.persistence]).toEqual([crowded.currents, crowded.persistence]);
    expect(self.state.currents).toBe(crowded.currents);
    // 退去を伴う受理は、記録の無い subject への解除（revisionOnly の形）でも decision と outcome が semantic。
    const release = receive(crowded, decodeFixture(F.sample, (xml) => eventId("N6")(retime(iso(now))(rivers([group("10")])(xml)))), clock(now));
    expect([shape(release), release.outcomes.map((item) => item.kind === "accepted" && item.change)]).toEqual([
      [["normal/VXKO50/N6", "changed", "semantic"]], ["semantic"]]);
    // current を残さない取消（自身の退去）も、その subject の pending を置き換える（C10 の Q-C10-IMPL-AMEND(5)）。
    const mixed = receive(filled(full.slice(0, 511)), report("T2", "訓練"), clock(now)).state;
    const evictedTraining = receive(mixed, report("N7"), clock(now)).state;
    expect(evictedTraining.currents.some((item) => item.operation === "training")).toBe(false);
    const withdrawn = receive(evictedTraining, decodeFixture(F.cancel, (xml) => status("訓練")(eventId("T2")(retime(iso(now))(xml)))), clock(now));
    expect(withdrawn.state.currents).toBe(evictedTraining.currents);
    expect(withdrawn.state.intents.filter((item) => item.subject === "training/VXKO50/T2").map((item) => item.disposition)).toEqual(["superseded"]);
    expect(withdrawn.state.persistence.currentGeneration).toBe(evictedTraining.persistence.currentGeneration + 1);
    // 遅着の報（受理の時点で ReportDateTime+36 時間）は満杯でも退去を起こさない。
    const lateFull = receive(crowded, decodeFixture(F.sample, eventId("N8")), clock(T0 + RETAIN));
    expect(shape(lateFull)).toEqual([["normal/VXKO50/N8", "unchanged", "stale"]]);
    expect(lateFull.state).toBe(crowded);

    // P3-C11-BOUNDS=B: group 16/17（段階の低い方から捨てて最大の段階が残る）、河川の延べ 32/33。
    const codes = ["10", "20", "21", "22", "30", "31", "40", "41", "53", "60", "61", "62", "63", "64", "65", "66", "51"];
    const groupsOf = (count: number, per: number) => codes.slice(codes.length - count).map((code, index) =>
      group(code, Array.from({ length: per }, (_, river) => ({ code: String(1_000_000 + index * 10 + river) }))));
    const bounded = (edit: (xml: string) => string) => active(recordOf(send(emptyState(), F.sample, edit).state));
    const seventeen = bounded(rivers(groupsOf(17, 2)));
    expect([seventeen?.kinds.length, seventeen?.kinds.some((item) => item.code === "10"), seventeen?.kinds.at(-1)?.code, seventeen?.truncated])
      .toEqual([16, false, "51", true]);
    expect([bounded(rivers(groupsOf(16, 2)))?.truncated, bounded(rivers(groupsOf(16, 2)))?.kinds.length]).toEqual([false, 16]);
    const riverCount = (count: number) => bounded(rivers([group("30", Array.from({ length: count }, (_, index) => ({ code: String(1_000_000 + index) })))]));
    expect([riverCount(33)?.kinds[0].rivers.length, riverCount(33)?.truncated, riverCount(32)?.truncated]).toEqual([32, true, false]);
    // 観測所 20/21（現況の観測レベルの低い方から捨て、null が最も低い）、点 40/41、ChargeSection 4/5。
    const stationSpec = (index: number, level: string, points = 2): StationSpec => ({ code: String(100 + index), name: `観測所${index}`,
      values: Array.from({ length: points }, () => "1.00"), levels: Array.from({ length: points }, (_, at) => at === 0 ? level : "2") });
    const many = (count: number) => Array.from({ length: count }, (_, index) => stationSpec(index, index === 3 ? "" : index === count - 1 ? "5" : "2"));
    // 観測所の名前は (code, name) の identity なので切らない（外部監査 F13）: 同じ code で 32 単位を超える共通の接頭辞を持つ 2 観測所を
    // 両方保ち decode も通す。48 単位を超える名前の観測所はその観測所だけを捨てる。
    const named48 = (suffix: string, length = 48) => ({ ...stationSpec(0, "2"), code: "100", name: `${"あ".repeat(length - 1)}${suffix}` });
    const twins = send(emptyState(), F.sample, stationsXml(2, [named48("甲"), named48("乙")])).state;
    expect([active(recordOf(twins))?.stations.map((item) => item.name), active(recordOf(twins))?.truncated, roundTrip(twins).kind]).toEqual([
      [`${"あ".repeat(47)}甲`, `${"あ".repeat(47)}乙`], false, "restored"]);
    const longName = bounded(stationsXml(2, [named48("甲", 49), stationSpec(1, "2")]));
    expect([longName?.stations.map((item) => item.name), longName?.truncated]).toEqual([["観測所1"], true]);
    const crowdedStations = bounded(stationsXml(2, many(21)));
    expect([crowdedStations?.stations.length, crowdedStations?.stations.some((item) => item.name === "観測所3"),
      crowdedStations?.stations.at(-1)?.levels[0], crowdedStations?.truncated]).toEqual([20, false, 5, true]);
    expect(bounded(stationsXml(2, many(20)))?.truncated).toBe(false);
    const pointCount = (count: number) => bounded(stationsXml(count, [stationSpec(0, "2", count)]));
    expect([pointCount(41)?.times.length, pointCount(41)?.stations[0].values.length, pointCount(41)?.truncated, pointCount(40)?.truncated])
      .toEqual([40, 40, true, false]);
    const named = ["川A", "川B", "川C", "川D", "川E"];
    const sections = (count: number) => bounded((xml) => stationsXml(2, [{ ...stationSpec(0, "2"), sections: named.slice(0, count) }])(rivers([
      group("30", named.map((name, index) => ({ code: String(1_000_000 + index), name })))])(xml)));
    expect([sections(5)?.stations[0].riverCodes, sections(5)?.truncated, sections(4)?.truncated]).toEqual([["1000000", "1000001", "1000002", "1000003"],
      true, false]);
    // title 128/129 文字と Kind の名前 32/33 文字の切り詰め。
    const titled = (length: number) => bounded((xml) => xml.replace("<Title>○○川上流氾濫警戒情報</Title>", `<Title>${"題".repeat(length)}</Title>`));
    expect([titled(129), titled(128)]).toMatchObject([{ title: "題".repeat(128), truncated: true }, { title: "題".repeat(128), truncated: false }]);
    const kindNamed = (length: number) => bounded(rivers([{ ...group("30"), name: "名".repeat(length) }]));
    expect([kindNamed(33)?.kinds[0].name, kindNamed(33)?.truncated, kindNamed(32)?.truncated]).toEqual(["名".repeat(32), true, false]);

    // pending 128/129 件と 131,072/131,073 byte（予約は delivery-growth.ts の deliveryGrowth、式を写さない）。
    const template = send(emptyState(), F.sample).intents[0];
    const seeded = (count: number, pad = 0): FloodIntent[] => Array.from({ length: count }, (_, index) => ({ ...template, id: `seed-${index}`,
      subject: `normal/VXKO50/S${index}`, source: { ...template.source, subject: `normal/VXKO50/S${index}` },
      payload: { ...template.payload, body: index === 0 ? "x".repeat(1 + pad) : "x" }, createdAt: T0 - 1000, expiresAt: T0 + 179_000 }));
    const fits = send({ ...emptyState(), intents: seeded(126) }, F.sample);
    expect([fits.intents.length, pending(fits.state).length, fits.diagnostics]).toEqual([2, 128, []]);
    const over = send({ ...emptyState(), intents: seeded(127) }, F.sample);
    expect([over.intents.map((item) => item.channel), over.diagnostics]).toMatchObject([["sound"], [{ reason: "notificationCapacityEvicted", count: 1 }]]);
    const bytesOf = (values: readonly FloodIntent[]) => Buffer.byteLength(JSON.stringify(values));
    const fresh = send(emptyState(), F.sample).intents;
    const pad = 131_072 - bytesOf([...seeded(10), ...fresh]) - [...seeded(10), ...fresh].reduce((sum, item) => sum + deliveryGrowth(item), 0);
    expect(pending(send({ ...emptyState(), intents: seeded(10, pad) }, F.sample).state)).toHaveLength(12);
    expect(send({ ...emptyState(), intents: seeded(10, pad + 1) }, F.sample).intents.map((item) => item.channel)).toEqual(["sound"]);
    // 新しい intent が容量で外れただけなら intent の配列を変えない（C9 の Q-C9-IMPL-AMEND(9)(e)）。
    const busy: FloodUnitState = { ...emptyState(), intents: seeded(128) };
    const dropped = send(busy, F.sample, status("訓練"));
    expect([dropped.intents, dropped.diagnostics]).toEqual([[], [{ level: "INFO", component: "flood", reason: "notificationCapacityEvicted",
      unit: "U-R", count: 1 }]]);
    expect(dropped.state.intents).toBe(busy.intents);
    // 配送の更新で attempts が 1 桁から 5 桁・nextAttemptAt の桁が増えても、予約の内側で decode が受ける。
    const budget = send({ ...emptyState(), intents: seeded(10, pad) }, F.sample).state;
    const grown = reduceFloodUnit(budget, { kind: "intentUpdate", clock: clock(T0), intentUpdate: pending(budget).map((item) => ({ id: item.id,
      attempts: 12_345, nextAttemptAt: T0 + 0.123456, disposition: "pending" as const })) });
    expect(roundTrip(grown.state).kind).toBe("restored");

    // I-U-R.capacityMeasurement の同時最大状態（実配信の最大の記録の形）と、上限の文字列での上界（I-U-R.capacityReserve）。
    // どちらも encode でき 16,777,216 byte 以下で decode が受ける。
    const real = budgetState(false), bound = budgetState(true);
    const sizes = [real, bound].map((item) => Buffer.byteLength(JSON.stringify(floodUnitCodec.encode(item))));
    const one = (value: object) => Buffer.byteLength(JSON.stringify(value));
    console.info("P3-C11 capacity", JSON.stringify({ realPayload: sizes[0], contractReal: 2_925_920 - 293, boundPayload: sizes[1],
      contractBound: 16_654_688 - 293, realActive: one(real.currents[0]), contractActive: 5_263, realEnded: one(recordOf(watermarkState())!),
      contractEnded: 397, realCancelled: one(recordOf(send(emptyState(), F.cancel).state)!), contractCancelled: 401, realIntent: one(template),
      contractIntent: 955, boundRecord: one(bound.currents[0]), contractBoundRecord: 32_077, counts: [real.currents.length, real.intents.length,
        bound.intents.length] }));
    for (const item of [real, bound]) expect(roundTrip(item).kind).toBe("restored");
    expect(Math.max(...sizes)).toBeLessThanOrEqual(16_777_216);

    // 保持上限付近で、受信 1 回は記録単位の加算だけ（state・配列・既存の記録を直列化しない）。
    receive(real, report("N9"), clock(now));
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      receive(real, report("N9"), clock(now));
      const whole = new Set<unknown>([real, real.currents, real.intents, ...real.currents, ...real.intents]);
      expect(stringify.mock.calls.filter(([value]) => whole.has(value))).toEqual([]);
    } finally { stringify.mockRestore(); }
  });

  // contractBoundary: I-U-R.persisted・I-U-R.decode、復元で intent を作らない（AC05）。
  it("P3-C11-T05 contractBoundary / AC05: one codec, persisted fields only, every decode check and restore without new intents", () => {
    let state = send(emptyState(), F.sample).state;
    state = send(state, F.sample, (xml) => eventId("123456789013")(rivers([group("10")])(xml)), T0 + 1_000).state;
    state = send(state, F.cancel, eventId("123456789014"), T0 + 2_000).state;
    const payload = JSON.parse(JSON.stringify(floodUnitCodec.encode(state))) as JsonValue;
    expect(Object.keys(payload as object).sort()).toEqual(["currents", "intents", "schemaVersion"]);
    expect(floodUnitCodec.decode(payload)).toEqual({ kind: "restored", state: { ...state, contentRevision: 0,
      persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } } });
    type Row = Record<string, unknown>;
    const value = payload as { currents: Row[]; intents: Row[] };
    const [record] = value.currents, [intent] = value.intents;
    const ended = value.currents.find((item) => item.effective === "ended")!;
    const source = record.source as Row;
    const kinds = record.kinds as Row[];
    const stations = record.stations as Row[];
    const rivers0 = kinds[0].rivers as Row[];
    const withActive = (patch: Row) => ({ ...value, currents: [{ ...record, ...patch }] });
    const withStation = (patch: Row) => withActive({ stations: [{ ...stations[0], ...patch }, ...stations.slice(1)] });
    const many = <T>(length: number, make: (index: number) => T): T[] => Array.from({ length }, (_, index) => make(index));
    const renamed = (subject: string) => withActive({ subject, source: { ...source, subject } });
    const invalid: [string, unknown][] = [
      ["schemaVersion", { ...value, schemaVersion: "p3-flood-unit-v0" }],
      ["currents > 512", { ...value, currents: many(513, (index) => ({ ...record, eventId: `E${index}`, subject: `normal/VXKO50/E${index}`,
        source: { ...source, subject: `normal/VXKO50/E${index}` } })) }],
      ["duplicate subject", { ...value, currents: [record, record] }],
      ["subject and eventId", withActive({ eventId: "123456789099" })],
      ["subject and headType", withActive({ headType: "VXKO51" })],
      ["headType outside", { ...renamed("normal/VXKO90/123456789012"), currents: [{ ...record, headType: "VXKO90", subject: "normal/VXKO90/123456789012",
        source: { ...source, subject: "normal/VXKO90/123456789012", family: "VXKO90" } }] }],
      ["subject and operation", renamed("training/VXKO50/123456789012")],
      ["eventId not ASCII", { ...value, currents: [{ ...record, eventId: "１", subject: "normal/VXKO50/１", source: { ...source, subject: "normal/VXKO50/１" } }] }],
      ["inputId over 64", withActive({ source: { ...source, inputId: "i".repeat(65) } })],
      ["ReportDateTime over 40", withActive({ source: { ...source, reportDateTimeRaw: "2019-05-27T09:00:00.0000000000000000+09:00" } })],
      ["Serial empty", withActive({ source: { ...source, serialRaw: "" } })],
      ["Serial over 10 digits", withActive({ source: { ...source, serialRaw: "12345678901" } })],
      ["InfoType", withActive({ source: { ...source, infoTypeRaw: "不明" } })],
      ["source family", withActive({ source: { ...source, family: "VXKO51" } })],
      ["ended keeps facts", { ...value, currents: [{ ...ended, title: "x" }] }],
      ["ended retainUntil", { ...value, currents: [{ ...ended, retainUntil: Number(ended.retainUntil) + 1 }] }],
      ["active retainUntil", withActive({ retainUntil: Number(record.retainUntil) + 1 })],
      ["level and code", withActive({ kinds: [{ ...kinds[0], level: 4 }] })],
      ["duplicate group code", withActive({ kinds: [kinds[0], { ...kinds[0], rivers: [{ code: "1", name: "x" }] }] })],
      ["duplicate river code", withActive({ kinds: [{ ...kinds[0], rivers: [rivers0[0], rivers0[0]] }] })],
      ["groups over 16", withActive({ kinds: many(17, (index) => ({ code: String(60 + index), name: "x", level: null, rivers: [{ code: String(index), name: "x" }] })),
        stations: [] })],
      ["rivers over 32", withActive({ kinds: [{ ...kinds[0], rivers: many(33, (index) => ({ code: String(index), name: "x" })) }], stations: [] })],
      ["river code over 16 bytes", withActive({ kinds: [{ ...kinds[0], rivers: [{ code: "1".repeat(17), name: "x" }] }], stations: [] })],
      ["empty rivers without truncated", withActive({ kinds: [{ ...kinds[0], rivers: [] }], stations: [] })],
      ["river name lone surrogate", withActive({ kinds: [{ ...kinds[0], rivers: [{ ...rivers0[0], name: "川\ud842" }] }] })],
      ["kind name over 32", withActive({ kinds: [{ ...kinds[0], name: "x".repeat(33) }] })],
      ["title over 128", withActive({ title: "x".repeat(129) })],
      ["areaName control character", withActive({ areaName: "○○\t川" })],
      ["basis over 40", withActive({ basisReportDateTimeRaw: "x".repeat(41) })],
      ["basis form", withActive({ basisReportDateTimeRaw: "\n2019-05-27T09:00:00+09:00" })],
      ["inputId escaped character", withActive({ source: { ...source, inputId: 'in"put' } })],
      ["inputId not ASCII", withActive({ source: { ...source, inputId: "入力" } })],
      ["ReportDateTime form", withActive({ source: { ...source, reportDateTimeRaw: "\n2019-05-27T09:00:00+09:00" }, retainUntil: Number(record.retainUntil) })],
      ["InfoType raw over 8", withActive({ source: { ...source, infoTypeRaw: "\t".repeat(7) + "発表" } })],
      ["times over 40", withActive({ times: many(41, () => "2019-05-27T09:00:00+09:00"), stations: [] })],
      ["time form", withActive({ times: ["2019-05-27T09:00:00Z", ...(record.times as string[]).slice(1)] })],
      ["stations over 20", withActive({ stations: many(21, (index) => ({ ...stations[0], code: String(index) })) })],
      ["duplicate station", withActive({ stations: [stations[0], stations[0]] })],
      ["station code not digits", withStation({ code: "12A" })],
      ["station name over 48", withStation({ name: "観".repeat(49) })],
      ["values length and times", withStation({ values: [1] })],
      ["levels length and times", withStation({ levels: [2] })],
      ["value over 11 characters", withStation({ values: [1234567.1, ...(stations[0].values as unknown[]).slice(1)] })],
      ["level outside 0-5", withStation({ levels: [9, ...(stations[0].levels as unknown[]).slice(1)] })],
      ["criteria not finite", withStation({ criteria: { ...(stations[0].criteria as Row), level1: "142" } })],
      ["riverCodes outside kinds", withStation({ riverCodes: ["555"] })],
      ["riverCodes duplicate", withStation({ riverCodes: ["1234567890", "1234567890"] })],
      ["measurement", withStation({ measurement: "rain" })],
      ["pending > 128", { ...value, intents: many(129, (index) => ({ ...intent, id: `pending-${index}`, disposition: "pending" })) }],
      ["pending + delivery reserve > 131072 bytes", { ...value, intents: reserveOver(intent) }],
      ["attempts negative", { ...value, intents: [{ ...intent, attempts: -1 }] }],
      ["nextAttemptAt not finite", { ...value, intents: [{ ...intent, nextAttemptAt: null }] }],
      ["pending + terminal > 229,376 bytes", { ...value, intents: terminalOver(intent) }],
      ["intent of another unit", { ...value, intents: [{ ...intent, unit: "U-L" }] }],
      ["intent subject form", { ...value, intents: [{ ...intent, subject: "normal/VPWW56/1", source: { ...(intent.source as Row), subject: "normal/VPWW56/1" } }] }],
    ];
    for (const [name, candidate] of invalid) expect(floodUnitCodec.decode(candidate as JsonValue).kind, name).toBe("invalid");
    // 回収された記録の intent は期限まで残るので、state に残る subject との一致は求めない。
    expect(floodUnitCodec.decode({ ...value, currents: [] } as JsonValue).kind).toBe("restored");
    // 受理が通す上限ちょうどの記録（truncated の記録、title の制御文字、非 BMP の文字で切った名前、kinds 空）は decode も通す。
    const widest = send(emptyState(), F.sample, (xml) => rivers([group("30", Array.from({ length: 33 }, (_, index) => ({ code: String(10 ** 15 + index),
      name: `あ${"𠮷".repeat(16)}` })))])(xml).replace("<Title>○○川上流氾濫警戒情報</Title>", `<Title>題\t${"題".repeat(128)}</Title>`));
    expect([active(recordOf(widest.state))?.truncated, roundTrip(widest.state).kind]).toEqual([true, "restored"]);
    expect(roundTrip(send(emptyState(), F.sample, withoutRivers).state).kind).toBe("restored");

    // 復元で intent を作らず、pending の期限を延ばさない（期限を過ぎた intent と記録は復元の後の最初の期限処理で回収する）。
    const restoredAt = T0 + 61_000;
    const restored = reduceFloodUnit(emptyState(), { kind: "restore", persisted: floodUnitCodec.encode(state), clock: clock(restoredAt) });
    expect([restored.intents, restored.state.intents, restored.state.currents]).toEqual([[], state.intents, state.currents]);
    expect(tick(restored.state, restoredAt).state.intents).toEqual(state.intents.filter((item) => item.expiresAt > restoredAt));
    expect(restored.outcomes).toMatchObject([{ kind: "recoveryApplied", scope: ["U-R"], coverage: [SUBJECT] }]);
  });

  // acceptance: Q-NOTICE の洪水分（AC07）。
  it("P3-C11-T06 acceptance / AC07: opportunities, the NOTICE-LEVELS=E table, replacement, title/body, intentUpdate, training and restart", () => {
    const first = send(emptyState(), F.sample);
    expect([levels(first), first.intents.map((item) => item.transition)]).toEqual([["desktop:warning", "sound:warning"], ["activated", "activated"]]);
    expect(first.intents.map((item) => [item.payload.domain, item.payload.title, item.payload.body, item.expiresAt - item.createdAt])).toEqual([
      ["weather", "○○川上流氾濫警戒情報", HEADLINE, 180_000], ["weather", "○○川上流氾濫警戒情報", HEADLINE, 60_000]]);
    // 上がった河川の最大: レベル5 critical・4 warning・表に無い code（3 と同じ順位）は上がらない。段階が下がった・河川が減った報は normal。
    const raised = (edit: (xml: string) => string) => levels(follow(first.state, edit))[0] ?? null;
    expect([raised(rivers([group("51")])), raised(rivers([group("40")])), raised(rivers([group("59")])), raised(rivers([group("21")])),
      raised(rivers([group("30", [SAMPLE_RIVERS[0]])])), raised(rivers([group("30", [...SAMPLE_RIVERS, { code: "5555555555" }])]))]).toEqual([
      "desktop:critical", "desktop:warning", "desktop:normal", "desktop:normal", "desktop:normal", "desktop:warning"]);
    // 河川の段階が変わらない報（code 30→31 の言い換え、series の点・基準水位だけの変化）では作らない。
    expect([raised(rivers([group("31")])), raised(seriesPart((part) => part.replace(">144.80<", ">144.70<"))),
      raised(additionPart((part) => part.replace(">142.00<", ">141.00<")))]).toEqual([null, null, null]);
    // 観測所の現況レベルの最大が 2 以上へ上がった報は鳴る（3・4 warning、5 critical）。河川も上がれば大きい方。下がっても鳴らない。
    expect([raised(observed("3")), raised(observed("5")), raised((xml) => observed("5")(rivers([group("40")])(xml))), raised(observed("1"))])
      .toEqual(["desktop:warning", "desktop:critical", "desktop:critical", null]);
    // kinds 空の新しい active は warning、basis を保った報では作らない。レベル5 の新しい subject は critical。
    expect([levels(send(emptyState(), F.sample, withoutRivers)), raised((xml) => observed("5")(withoutRivers(xml))),
      levels(send(emptyState(), F.sample, rivers([group("53")])))]).toEqual([["desktop:warning", "sound:warning"], null, ["desktop:critical", "sound:critical"]]);
    // 全解除は released・normal。記録の無い subject・記憶だけの取消の subject への解除（inactiveAdoption）も作る。ended への解除では作らない。
    const ended = follow(first.state, rivers([group("10")]));
    expect([levels(ended), ended.intents[0].transition]).toEqual([["desktop:normal", "sound:normal"], "released"]);
    expect(levels(send(emptyState(), F.sample, rivers([group("10")])))).toEqual(["desktop:normal", "sound:normal"]);
    expect(levels(follow(send(emptyState(), F.cancel).state, rivers([group("10")]), "2019-05-27T12:30:00+09:00"))).toEqual(["desktop:normal", "sound:normal"]);
    expect(follow(ended.state, rivers([group("10")]), "2019-05-27T09:40:00+09:00").intents).toEqual([]);
    // 訂正は事実が同じでも作る（normal、[訂正]・「訂正: 」）。記憶だけの取消では作らない。取消は cancel。
    const corrected = send(first.state, F.sample, replaceTag("InfoType", "訂正"));
    expect([shape(corrected), corrected.intents.map((item) => [item.transition, item.payload.level, item.payload.title, item.payload.body])]).toEqual([
      [[SUBJECT, "changed", "revisionOnly"]], [["updated", "normal", "[訂正] ○○川上流氾濫警戒情報", `訂正: ${HEADLINE}`],
        ["updated", "normal", "[訂正] ○○川上流氾濫警戒情報", `訂正: ${HEADLINE}`]]]);
    expect(send(emptyState(), F.cancel).intents).toEqual([]);
    expect(send(first.state, F.cancel).intents.map((item) => [item.transition, item.payload.level])).toEqual([["cancelled", "cancel"], ["cancelled", "cancel"]]);
    // Headline の無い報の本文は group ごとの河川名。
    const plain = send(emptyState(), F.sample, (xml) => xml.replace(`<Text>${HEADLINE}</Text>`, ""));
    expect(plain.intents[0].payload.body).toBe("氾濫警戒情報 ○○川・△△川");
    // 置換（P3-C11-REPLACEMENT=A）: 同じ subject・channel の新しい intent は古い pending を、取消は対象 subject の全 pending を置き換える。
    const replaced = follow(first.state, rivers([group("40")]), "2019-05-27T09:00:30+09:00").state;
    expect(replaced.intents.map((item) => item.disposition)).toEqual(["superseded", "superseded", "pending", "pending"]);
    expect(pending(send(replaced, F.cancel, retime("2019-05-27T09:00:40+09:00")).state).map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
    expect(send(first.state, F.sample, eventId("123456789099")).state.intents.slice(0, 2)).toEqual(first.state.intents);
    // intentUpdate: 既存 id だけを一括で更新し、保存世代を 1 つ進める。未知 id・同値は no-op。
    const [desktop] = first.intents;
    const updated = reduceFloodUnit(first.state, { kind: "intentUpdate", clock: clock(desktop.createdAt), intentUpdate: [{ id: desktop.id,
      attempts: 1, nextAttemptAt: desktop.createdAt + 1_000, disposition: "pending" }, { id: "unknown", attempts: 1, nextAttemptAt: 0,
      disposition: "delivered" }] });
    expect([updated.state.persistence.currentGeneration, updated.decisions]).toMatchObject([first.state.persistence.currentGeneration + 1,
      [{ decision: "changed", change: "deliveryOnly" }]]);
    expect(reduceFloodUnit(updated.state, { kind: "intentUpdate", clock: clock(desktop.createdAt), intentUpdate: { id: desktop.id, attempts: 1,
      nextAttemptAt: desktop.createdAt + 1_000, disposition: "pending" } }).state).toBe(updated.state);
    // 復元直後の続報は復元した記録との差で決める（同じ報は duplicate で鳴らさない、観測の最大の上昇は鳴る）。訓練は desktop だけ。
    const restored = reduceFloodUnit(emptyState(), { kind: "restore", persisted: floodUnitCodec.encode(first.state),
      clock: clock(desktop.createdAt + 1) }).state;
    expect(send(restored, F.sample).intents).toEqual([]);
    expect(levels(follow(restored, observed("4")))).toEqual(["desktop:warning", "sound:warning"]);
    expect(send(emptyState(), F.sample, status("訓練")).intents.map((item) => [item.channel, item.payload.level, item.payload.title])).toEqual([
      ["desktop", "warning", "【訓練】○○川上流氾濫警戒情報"]]);
  });

  // contractBoundary: E22 の U-R は対象外（P3-C11-N2、AC13）。
  it("P3-C11-T10 contractBoundary / AC13: origin=recovery is not applied", () => {
    const state = send(emptyState(), F.sample).state;
    const recovery = receive(state, decodeXml(retime("2019-05-27T09:30:00+09:00")(fixtureXml(F.sample)), "VXKO50", "recovered", "recovery"),
      clock(T0 + 30 * 60_000));
    expect(recovery.state).toBe(state);
    expect(recovery.decisions).toEqual([{ subject: SUBJECT, operation: "normal", decision: "unchanged", reason: "noChange" }]);
    expect([recovery.intents, recovery.outcomes, recovery.confirmationEvidence, recovery.displayChanges]).toEqual([[], [], [], []]);
  });

  // 実不具合の再発防止の型（C8 の Q-C8-IMPL-AMEND(1)(2) を U-R で）: owner を通した更新・保存・復元。
  it("P3-C11-T04 contractBoundary / AC04: an owner terminal update at the terminal budget and pending at its budget survive save and restore", () => {
    const template = send(emptyState(), F.sample).intents[0];
    const terminalBytes = (values: readonly FloodIntent[]) => values.filter((item) => item.disposition !== "pending")
      .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + 1, 0);
    const old: FloodIntent = { ...template, id: "old-pending", createdAt: T0 - 100_000, expiresAt: T0 + 80_000 };
    const done = (index: number): FloodIntent => ({ ...template, id: `done-${index}`, createdAt: T0 + index, disposition: "delivered" });
    let count = 0;
    while (terminalBytes(Array.from({ length: count + 1 }, (_, index) => done(index))) <= 98_304) count++;
    const now = clock(T0 + 1_000);
    const empty = restoreOwner({ runId: "run", place: "deferred", clock: now, restored: { "U-F": { kind: "empty" }, "U-L": { kind: "empty" },
      "U-R": { kind: "empty" }, "U-B": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const owner = { ...empty, units: { ...empty.units, "U-R": { ...emptyState(), intents: [old, ...Array.from({ length: count }, (_, index) => done(index))] } } };
    const updated = intentUpdateOwner(owner, "U-R", [{ id: old.id, attempts: 1, nextAttemptAt: now.wallTimeMs, disposition: "delivered" }], now,
      linkedUnitTable);
    expect(updated.adopted).toBe(true);
    expect(updated.state.units["U-R"]!.intents.find((item) => item.id === old.id)?.disposition).toBe("delivered");
    // 終端記録の合計が 98,304 byte を超える分は最古（done-0）から期限前に回収し、更新で終端にした記録は回収しない。
    expect(updated.state.units["U-R"]!.intents.some((item) => item.id === "done-0")).toBe(false);
    expect(roundTrip(updated.state.units["U-R"]!).kind).toBe("restored");
    // 予算いっぱいに受理した pending が、最長の配送の更新（attempts 16 桁・nextAttemptAt 25 文字）の後も保存・復元できる。
    let full = emptyState();
    for (let index = 0; index < 200; index++)
      full = send(full, F.sample, (xml) => eventId(`E${index}`)(xml).replace(`<Text>${HEADLINE}</Text>`, `<Text>${"洪".repeat(250)}</Text>`), T0 + index).state;
    expect(pending(full).length).toBeLessThan(128);
    const first = roundTrip(full);
    if (first.kind !== "restored") throw new Error("the admitted state does not decode");
    const grown = intentUpdateOwner({ ...empty, units: { ...empty.units, "U-R": first.state } }, "U-R", pending(first.state).map((item, index) => ({
      id: item.id, attempts: Number.MAX_SAFE_INTEGER, nextAttemptAt: -0.0000018927186924017318,
      disposition: index % 3 === 0 ? "superseded" as const : "pending" as const })), now, linkedUnitTable);
    expect(grown.adopted).toBe(true);
    expect(roundTrip(grown.state.units["U-R"]!).kind).toBe("restored");
  });
});

function watermarkState(): FloodUnitState {
  return send(emptyState(), F.sample, rivers([group("10")])).state;
}

// I-U-R.capacityMeasurement の同時最大状態: 実配信の最大の記録の形（観測所 10・点 22・河川 7・group 1）を 512 subject に置き、
// 上界（I-U-R.capacityReserve）は 512 subject を上限の長さの記録で満たす。どちらも pending と終端記録を byte の上限まで詰める。
function budgetState(bounded: boolean): FloodUnitState {
  const realRivers = Array.from({ length: 7 }, (_, index) => ({ code: String(2_700_000_000 + index), name: `河川${index}` }));
  const realStations = Array.from({ length: 10 }, (_, index): StationSpec => ({ code: `27${String(index).padStart(15, "0")}`, name: `観測所名${index}`,
    values: Array.from({ length: 22 }, (_, at) => (10 + at / 100).toFixed(2)), levels: Array.from({ length: 22 }, () => "3"),
    sections: [realRivers[index % 7].name] }));
  const seed = active(recordOf(send(emptyState(), F.sample, (xml) => stationsXml(22, realStations)(rivers([group("40", realRivers)])(xml))).state))!;
  const wide = (length: number) => "\u0001".repeat(length);
  const kanji = (length: number) => "洪".repeat(length);
  const digits = (index: number, width: number) => String(index).padStart(width, "0");
  const number = "-123456.789";
  let code = 0;
  const currents = Array.from({ length: 512 }, (_, index): FloodCurrent => {
    const operation: Operation = bounded ? "training" : "normal";
    const id = bounded ? `${"\\".repeat(36)}${String(index).padStart(4, "0")}` : `27000000${String(index).padStart(4, "0")}`;
    const subject = `${operation}/VXKO50/${id}`;
    // 上界: A1 の形で 40 文字の時刻（retainUntil は 15 桁）、decode が通す最悪の InfoType の raw（trim で消え JSON で 6 byte の U+000B を 6 個）。
    const reportDateTimeRaw = bounded ? "9999-12-31T23:59:59.99999999999999-23:59" : seed.source.reportDateTimeRaw;
    const source = { inputId: "i".repeat(bounded ? 64 : 36), origin: "live" as const, operation, family: "VXKO50", subject, reportDateTimeRaw,
      serialRaw: bounded ? "1234567890" : "3", infoTypeRaw: bounded ? `${"\u000b".repeat(6)}訂正` : "発表" };
    const base = { subject, operation, headType: "VXKO50", eventId: id, source, retainUntil: Date.parse(reportDateTimeRaw) + RETAIN };
    if (!bounded) return { ...seed, ...base };
    const kinds = Array.from({ length: 16 }, (_, at) => ({ code: String(60 + at), name: kanji(32), level: null,
      rivers: Array.from({ length: 2 }, () => ({ code: digits(code++, 16), name: kanji(32) })) }));
    const riverCodes = kinds.flatMap((group) => group.rivers.map((river) => river.code));
    const stations = Array.from({ length: 20 }, (_, at): FloodStation => ({ code: digits(at, 20), name: kanji(48), riverCodes: riverCodes.slice(at, at + 4),
      measurement: "waterLevel", criteria: { level1: Number(number), level2: Number(number), level3: Number(number), level4: Number(number),
        level4Plan: Number(number) }, values: Array.from({ length: 40 }, () => Number(number)), levels: Array.from({ length: 40 }, () => null) }));
    return { ...base, effective: "active", title: wide(128), areaName: kanji(64), kinds, times: Array.from({ length: 40 }, () => "2019-05-27T09:00:00+09:00"),
      stations, basisReportDateTimeRaw: reportDateTimeRaw, truncated: true };
  });
  const intentBase = send(emptyState(), F.sample).intents[0];
  const sized = (index: number, disposition: FloodIntent["disposition"]): FloodIntent => ({ ...intentBase, id: `${intentBase.id}:${index}`,
    disposition, createdAt: T0, expiresAt: T0 + 180_000 });
  const bytes = (item: FloodIntent) => Buffer.byteLength(JSON.stringify(item));
  const pendingIntents: FloodIntent[] = [];
  let size = 2;
  for (let index = 0; pendingIntents.length < 128; index++) {
    const item = sized(index, "pending"), width = bytes(item) + (pendingIntents.length === 0 ? 0 : 1) + deliveryGrowth(item);
    if (size + width > 131_072) break;
    pendingIntents.push(item);
    size += width;
  }
  // 終端記録は配送の更新で終端にした記録を含めて「pending の実 byte＋予約＋終端記録」229,376 byte まで。
  const terminal: FloodIntent[] = [];
  for (let index = 1000; ; index++) {
    const item = sized(index, "delivered");
    if (size + bytes(item) + 1 > 229_376) break;
    terminal.push(item);
    size += bytes(item) + 1;
  }
  return { ...emptyState(), currents, intents: [...pendingIntents, ...terminal] };
}

// 実 byte が 131,072 ちょうどで、予約を足すと超える pending（受理と同じ式）。
function reserveOver(intent: Record<string, unknown>): Record<string, unknown>[] {
  const make = (index: number, pad: number) => ({ ...intent, id: `fit-${index}`, disposition: "pending",
    payload: { ...(intent.payload as Record<string, unknown>), body: "x".repeat(1 + pad) } });
  const items = Array.from({ length: 64 }, (_, index) => make(index, 0));
  items[0] = make(0, 131_072 - Buffer.byteLength(JSON.stringify(items)));
  if (Buffer.byteLength(JSON.stringify(items)) !== 131_072) throw new Error("pending is not 131,072 bytes");
  return items;
}
// 「pending の実 byte＋予約＋終端記録」が 229,377 byte（世代の上限より十分小さい）。
function terminalOver(intent: Record<string, unknown>): Record<string, unknown>[] {
  const make = (index: number, pad: number) => ({ ...intent, id: `done-${index}`, disposition: "delivered",
    payload: { ...(intent.payload as Record<string, unknown>), body: "x".repeat(1 + pad) } });
  const items = Array.from({ length: 80 }, (_, index) => make(index, 2_000));
  const terminal = (values: readonly Record<string, unknown>[]) => values.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + 1, 0);
  items[0] = make(0, 2_000 + 229_377 - 2 - terminal(items));
  if (2 + terminal(items) !== 229_377) throw new Error("terminal is not 229,377 bytes");
  return items;
}
