import { describe, expect, it, vi } from "vitest";

import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type { BriefingCurrent, BriefingIntent, BriefingUnitState, BriefingUnitStep } from "../../contracts/p3-briefing-unit.types";
import { deliveryGrowth } from "../../src/notification-delivery/delivery-growth";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { intentUpdateOwner, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { classifyHeadType, placeOfHeadType } from "../../src/runtime/unit-coverage";
import { briefingUnitCodec, reduceBriefingUnit, toBriefingView } from "../../src/units/briefing/briefing-unit";
import {
  clock, decodeFixture, decodeXml, emptyState, eventId, fixtureXml, iso, observations, rainItem, receive, replaceTag, retime, send, serial, status,
  tags, tick, withoutHeadline,
} from "./briefing-fixture";

const HOUR = 3_600_000, SHORT = 2 * HOUR, LONG = 3 * HOUR;
const F = { k1: "phase6b_VPBS50_KJPTK202608221709_202608221709", k2: "phase6b_VPBS50_KJPTK202608221709_202608221717",
  k3: "phase6b_VPBS50_KJPTK202608221709_202608221727", correction: "synthetic_VPBS50_KJPTK_correction", kcancel: "synthetic_VPBS50_KJPTK_cancel",
  oa1: "phase6b_VPOA50_JPTK202608221709_202608221709", oa2: "phase6b_VPOA50_JPTK202608221709_202608221717", oacancel: "synthetic_VPOA50_JPTK_cancel",
  tc: "phase6b_VPOA50_JPTC202608221709_202608221709", sample: "82_01_01_260324_VPBS50", multi: "synthetic_VPBS50_multi",
  unknown: "synthetic_VPBS50_unknown-tag", empty: "synthetic_VPBS50_empty", fallback: "synthetic_VPBS50_fallback-tag", cancel: "synthetic_VPBS50_cancel",
  hjpna: "VPBS50_HJPNA202608270258", yjpna: "VPBS50_YJPNA202608270448", hjpnb: "VPBS50_HJPNB202608270308", yjpnb: "VPBS50_YJPNB202608270448",
  replayH: "test/fixtures/replay/VPBS50_HJPNB202608270458.xml" } as const;
const K = "normal/VPBS50/KJPTK202608221709", P = "normal/VPOA50/JPTK202608221709";
const KANAZAWA_H = "normal/VPBS50/HJPNB202608270308", KANAZAWA_Y = "normal/VPBS50/YJPNB202608270448";
const at = (value: string) => Date.parse(value);
const T0 = at("2026-08-22T17:09:00+09:00");
const shape = (step: BriefingUnitStep) => step.decisions.map((item) => [item.subject, item.decision,
  item.decision === "changed" ? item.change : item.decision === "unchanged" || item.decision === "rejected" ? item.reason : null]);
const channels = (step: BriefingUnitStep) => step.intents.map((item) => `${item.channel}:${item.payload.level}:${item.transition}`);
const pending = (state: BriefingUnitState, subject?: string) => state.intents.filter((item) => item.disposition === "pending"
  && (subject == null || item.subject === subject));
const recordOf = (state: BriefingUnitState, subject = K) => state.currents.find((item) => item.subject === subject);
const effective = (state: BriefingUnitState, subject = K) => recordOf(state, subject)?.effective ?? null;
const areasOf = (value: BriefingCurrent | undefined) => value?.effective === "active" ? value.items.map((item) => [item.kind,
  item.areas.map((area) => area.code)]) : value?.effective ?? null;
const roundTrip = (state: BriefingUnitState) => briefingUnitCodec.decode(JSON.parse(JSON.stringify(briefingUnitCodec.encode(state))) as JsonValue);
const body = (edit: (part: string) => string) => (xml: string) => xml.replace(/<Body[\s\S]*<\/Body>/, edit);
const head = (edit: (part: string) => string) => (xml: string) => xml.replace(/<Head [\s\S]*<\/Head>/, edit);
// 合成の取消（InfoType 取消・Serial を進める）。
const cancelOf = (serialRaw: string) => (xml: string) => serial(serialRaw)(replaceTag("InfoType", "取消")(xml));

describe("P3-UNIT-B-001 U-B reducer", () => {
  // contractBoundary: Q-ENUM の順と原子性、合法の縮退、coverage と実行場所（AC01）。
  it("P3-C12-T01 contractBoundary / AC01: first reason only, unchanged state, a legal empty cancel and the U-B route", () => {
    const base = emptyState();
    const now = clock(T0);
    const reject = (source: string, headType = "VPBS50", inputId?: string) => {
      const step = receive(base, decodeXml(source, headType, inputId), now);
      expect(step.state).toBe(base);
      expect([step.intents, step.outcomes, step.displayChanges, step.diagnostics.length, step.decisions.length]).toEqual([[], [], [], 1, 1]);
      const result = step.decisions[0];
      return result.decision === "rejected" ? `${result.reason} ${result.subject}`.trim() : result.decision;
    };
    const xml = fixtureXml(F.k1), record = fixtureXml(F.oa1);
    const ids = (value: string) => xml.replace("<EventID>KJPTK202608221709_202608221709</EventID>", value);
    const tag = (edit: (part: string) => string) => (source: string) => source.replace(/<Information type="情報タグ">[\s\S]*?<\/Information>/, edit);
    const kind = /<Kind>\s*<Name>情報タグ<\/Name>[\s\S]*?<\/Kind>/;
    const area = /<Area codeType="気象・地震・火山情報／市町村等">[\s\S]*?<\/Area>/;
    const precipitation = '<jmx_eb:Precipitation condition="約" description="約１００ミリ" type="前１時間解析雨量" unit="mm">100</jmx_eb:Precipitation>';
    const withUnit = (unit: string) => body((part) => part.replace(precipitation, precipitation.replace('unit="mm"', `unit="${unit}"`)));
    const cases: [string, string, string?][] = [
      [ids(""), "identityMissing"], [ids("<EventID> </EventID>"), "identityMissing"],
      [ids("<EventID>KJPTK202608221709_1</EventID><EventID>KJPTK202608221709_2</EventID>"), "identityInvalid"],
      [eventId("K".repeat(41))(xml), "identityInvalid"], [eventId("ＫＪＰ")(xml), "identityInvalid"], [eventId("_202608221709")(xml), "identityInvalid"],
      [xml.replace("<Serial>1</Serial>", ""), `identityMissing ${K}`], [serial("1a")(xml), `identityInvalid ${K}`],
      [serial("12345678901")(xml), `identityInvalid ${K}`],
      [retime("2026-08-22T17:09:00.0000000000000000+09:00")(xml), `identityInvalid ${K}`],
      [replaceTag("InfoType", "発表        ")(xml), `identityInvalid ${K}`],
      [xml.replace("<Title>東京都気象防災速報（記録的短時間大雨）</Title>", ""), `requiredStructureMissing ${K}`],
      [replaceTag("InfoType", "不明")(xml), `requiredStructureInvalid ${K}`],
      [tag((part) => part.replace(kind, ""))(xml), `requiredStructureInvalid ${K}`],
      [tag((part) => part.replace(kind, (value) => value + value))(xml), `requiredStructureInvalid ${K}`],
      [tag((part) => part.replace("<Code>130010</Code>", "<Code>13001A</Code>"))(xml), `requiredStructureInvalid ${K}`],
      [tag((part) => part.replace("<Code>130010</Code>", "<Code>130010000</Code>"))(xml), `requiredStructureInvalid ${K}`],
      [tag((part) => part.replace("<Name>東京地方</Name>", "<Name>東京\u007f地方</Name>"))(xml), `requiredStructureInvalid ${K}`],
      [xml.replace("１７時、東京都北区", "１７時、\t東京都北区"), `requiredStructureInvalid ${K}`],
      [body((part) => part.replace(">100</jmx_eb:Precipitation>", ">100.1234</jmx_eb:Precipitation>"))(xml), `requiredStructureInvalid ${K}`],
      [body((part) => part.replace("<Time>2026-08-22T17:00:00+09:00</Time>", "<Time>2026-08-22T17:00:00Z</Time>"))(xml), `requiredStructureInvalid ${K}`],
      [body((part) => part.replace(area, ""))(xml), `requiredStructureInvalid ${K}`],
      [body((part) => part.replace(area, (value) => `${value}<Station><Name>北</Name><Code>44132</Code></Station>`))(xml), `requiredStructureInvalid ${K}`],
      [withUnit("m".repeat(9))(xml), `requiredStructureInvalid ${K}`], [withUnit("m\u007fm")(xml), `requiredStructureInvalid ${K}`],
      // 取消でも Control/EditorialOffice の有無と形を確かめる（Q-ENUM.familyTable.required、統合担当の決定）。
      [cancelOf("2")(xml).replace("<EditorialOffice>気象庁本庁</EditorialOffice>", ""), `requiredStructureMissing ${K}`],
      // 存在が妥当性より先（Q-ENUM.priorityRule）: Kind の 2 個より区域の code の欠落。
      [tag((part) => part.replace(kind, (value) => value + value).replace("<Code>130010</Code>", ""))(xml), `requiredStructureMissing ${K}`],
      [record.replace(/<Information type="記録的短時間大雨情報（発表細分）">[\s\S]*?<\/Information>/, ""), `requiredStructureInvalid ${P}`, "VPOA50"],
      [record.replace("<Code>1</Code>", "<Code>2</Code>"), `requiredStructureInvalid ${P}`, "VPOA50"],
      [record.replace("<Condition>発表</Condition>", "<Condition>解除</Condition>"), `requiredStructureInvalid ${P}`, "VPOA50"],
    ];
    expect(cases.map(([source, , headType]) => reject(source, headType))).toEqual(cases.map(([, reason]) => reason));
    // 保存する inputId の上限（64 文字、「"」「\」を除く印字可能な ASCII）。40 文字の EventID と 64 文字の inputId は合法。
    expect(reject(xml, "VPBS50", "i".repeat(65))).toBe(`identityInvalid ${K}`);
    expect(reject(xml, "VPBS50", 'in"put')).toBe(`identityInvalid ${K}`);
    expect(receive(base, decodeXml(eventId("~".repeat(40))(xml), "VPBS50", "i".repeat(64)), now).decisions[0].decision).toBe("changed");
    // 合法: Body・Headline の無い取消（記憶だけ、revisionOnly）。
    const bare = cancelOf("2")(xml).replace(/<Headline>[\s\S]*<\/Headline>/, "").replace(/<Body[\s\S]*<\/Body>/, "");
    expect(shape(receive(base, decodeXml(bare), now))).toEqual([[K, "changed", "revisionOnly"]]);

    expect([classifyHeadType("VPBS50"), classifyHeadType("VPOA50"), classifyHeadType("VPBS51"), placeOfHeadType("VPBS50"),
      placeOfHeadType("VPOA50")]).toEqual([{ status: "ready", unit: "U-B" }, { status: "ready", unit: "U-B" },
      { status: "notPorted", candidate: "U-B", reason: "S3: 配信開始時期未定" }, "deferred", "deferred"]);
    // 一入力は U-B だけへ届き、同じ deferred の U-F・U-L・U-R の state は同じ参照のまま。
    const owner = restoreOwner({ runId: "run", place: "deferred", clock: now, restored: { "U-F": { kind: "empty" }, "U-L": { kind: "empty" },
      "U-R": { kind: "empty" }, "U-B": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const material = decodeFixture(F.k1);
    const routed = receiveOwner(owner, { runId: "run", inputId: material.inputId, result: { kind: "decoded", material } }, now, linkedUnitTable);
    expect(routed.changedUnits).toEqual(["U-B"]);
    for (const unit of ["U-F", "U-L", "U-R"] as const) expect(routed.state.units[unit]).toBe(owner.units[unit]);
    // alias と予測の置換を伴う一入力も、入力の前の state を変えず一回の参照交換で適用する。
    const held = send(emptyState(), F.oa1).state;
    const frozen = structuredClone(held);
    const aliased = send(held, F.k1, undefined, T0 + 7);
    expect([held, effective(aliased.state, P), effective(aliased.state)]).toEqual([frozen, "aliased", "active"]);
  });

  // acceptance: 系列の current（AC02）。続報は試験内で書き換えて作る。
  it("P3-C12-T02 acceptance / AC02: facts of the series current, kinds, observations, replacement by the series and operations", () => {
    const sample = send(emptyState(), F.sample);
    const chiba = "normal/VPBS50/JPTE202309081000";
    expect(shape(sample)).toEqual([[chiba, "changed", "semantic"]]);
    expect(recordOf(sample.state, chiba)).toMatchObject({ headType: "VPBS50", series: "JPTE202309081000", effective: "active",
      title: "千葉県気象防災速報（線状降水帯発生）", editorialOffice: "銚子地方気象台", truncated: false,
      retainUntil: at("2023-09-08T10:19:00+09:00") + SHORT,
      items: [{ kind: "linearRainObserved", condition: "線状降水帯発生", areas: [{ code: "120010", name: "北西部" }, { code: "120020", name: "北東部" },
        { code: "120030", name: "南部" }] }] });
    const sampleRecord = recordOf(sample.state, chiba);
    expect(sampleRecord?.effective === "active" && sampleRecord.observations.map((item) => [item.part, item.areaName, item.label, item.value,
      item.unit, item.approximation, item.time])).toEqual(["北西部", "北東部", "南部"].map((name) => ["event", name, "線状降水帯発生", null, null,
      "unknown", "2023-09-08T10:10:00+09:00"]));
    // 記録雨の観測（値 120・以上・前１時間解析雨量）。系列の続報（Serial 1→2→3）は同じ記録を置き換える。
    let state = send(emptyState(), F.k1).state;
    state = send(state, F.k2).state;
    const second = recordOf(state);
    expect(second?.effective === "active" && second.observations).toEqual([{ part: "precipitation", areaCode: "1311900", areaName: "板橋区",
      label: "前１時間解析雨量", value: 120, unit: "mm", approximation: "atLeast", time: "2026-08-22T17:00:00+09:00" }]);
    state = send(state, F.k3).state;
    expect([state.currents.length, recordOf(state)?.source.serialRaw]).toEqual([1, "3"]);
    // 複数の item（短時間大雪と記録的短時間大雨）、表に無い Condition と Condition の無い Kind は unknown、情報タグの無い報は items 空。
    const kinds = (name: string) => {
      const value = send(emptyState(), name).state.currents[0];
      return value.effective === "active" ? value.items.map((item) => [item.kind, item.condition]) : value.effective;
    };
    expect([kinds(F.multi), kinds(F.unknown), kinds(F.empty), kinds(F.fallback)]).toEqual([[["shortSnow", "短時間大雪"], ["recordRain", "記録的短時間大雨"]],
      [["unknown", "謎の現象"]], [["unknown", null]], []]);
    const snow = send(emptyState(), F.multi).state.currents[0];
    expect(snow.effective === "active" && snow.observations).toEqual([{ part: "snowfall", areaCode: "60026", areaName: "長浜市余呉町柳ケ瀬",
      label: "６時間の降雪深さ", value: 37, unit: "cm", approximation: "exact", time: "2024-01-24T06:00:00+09:00" }]);
    // 別の系列の報は記録を変えない。試験の報は区分を交差しない。
    const other = send(state, F.k1, eventId("KJPTK202608221800_202608221800"));
    expect([other.state.currents.length, recordOf(other.state)]).toEqual([2, recordOf(state)]);
    const test = send(state, F.k3, (xml) => serial("4")(status("試験")(xml)));
    expect([shape(test), recordOf(test.state), recordOf(test.state, "test/VPBS50/KJPTK202608221709")?.operation]).toEqual([
      [["test/VPBS50/KJPTK202608221709", "changed", "semantic"]], recordOf(state), "test"]);
    // label の元（EventName・type 属性・Property/Type）がどれも無い観測は、その観測だけを捨てて truncated にする（統合担当の決定、fail-bright）。
    const unlabeled = send(emptyState(), F.k1, body((part) => part.replace(/<Type>雨の実況<\/Type>/, "")
      .replace('type="前１時間解析雨量" unit="mm">100<', 'unit="mm">100<')));
    const unlabeledRecord = recordOf(unlabeled.state);
    expect([shape(unlabeled), unlabeledRecord?.effective === "active" && [unlabeledRecord.observations.map((item) => item.areaName),
      unlabeledRecord.truncated]]).toEqual([[[K, "changed", "semantic"]], [["板橋区"], true]]);
    // 非 BMP の文字で切る位置がサロゲートの組にかかる名前は、孤立したサロゲートを作らず切る（decode も通す）。
    const wide = send(emptyState(), F.k1, tags([{ condition: "記録雨", areas: [{ code: "130010", name: `あ${"𠮷".repeat(16)}` }] }])).state;
    const named = recordOf(wide);
    expect([named?.effective === "active" && named.items[0].areas[0].name, named?.effective === "active" && named.truncated, roundTrip(wide).kind])
      .toEqual([`あ${"𠮷".repeat(7)}`, true, "restored"]);
  });

  // acceptance: 版・取消・期限（AC03）。
  it("P3-C12-T03 acceptance / AC03: revisions, subject-scoped cancel, the TTL=B lifetimes, late reports and the final-state outcome", () => {
    const first = send(emptyState(), F.k1);
    // 同じ版の重複と食い違い（先着を保ち WARN）。
    const duplicate = send(first.state, F.k1);
    expect([shape(duplicate), duplicate.diagnostics, duplicate.state === first.state]).toEqual([[[K, "unchanged", "duplicate"]], [], true]);
    const conflict = send(first.state, F.k1, (xml) => xml.replace("猛烈な雨が降っており", "非常に激しい雨が降っており"));
    expect([shape(conflict), conflict.diagnostics, conflict.state === first.state]).toEqual([[[K, "unchanged", "stale"]],
      [{ level: "WARN", component: "briefing", reason: "briefingRevisionConflict", inputId: expect.any(String), unit: "U-B" }], true]);
    // 同じ版の訂正は採用（事実が同じなので revisionOnly）。取消はその subject だけを cancelled にし、前の事実を戻さない。
    const third = send(send(first.state, F.k2).state, F.k3).state;
    expect(shape(send(third, F.correction))).toEqual([[K, "changed", "revisionOnly"]]);
    const withOther = send(third, F.tc, undefined, T0 + HOUR).state;
    const cancelled = send(withOther, F.kcancel, undefined, T0 + HOUR);
    expect([shape(cancelled), recordOf(cancelled.state)]).toEqual([[[K, "changed", "semantic"]], { subject: K, operation: "normal",
      headType: "VPBS50", series: "KJPTK202608221709", source: expect.objectContaining({ infoTypeRaw: "取消" }),
      retainUntil: at("2026-08-22T17:27:00+09:00") + LONG, effective: "cancelled" }]);
    expect(recordOf(cancelled.state, "normal/VPOA50/JPTC202608221709")).toBe(recordOf(withOther, "normal/VPOA50/JPTC202608221709"));
    // 取消以前の版は stale で復活しない。取消より新しい発表は active に戻す（activated）。
    for (const name of [F.k1, F.k3]) expect(shape(send(cancelled.state, name, undefined, T0 + HOUR))).toEqual([[K, "unchanged", "stale"]]);
    const again = send(cancelled.state, F.k3, (xml) => serial("5")(retime("2026-08-22T17:40:00+09:00")(xml)));
    expect([shape(again), effective(again.state), again.intents.map((item) => item.transition)]).toEqual([[[K, "changed", "semantic"]],
      "active", ["activated", "activated"]]);
    // 記録の無い subject への取消は記憶だけで鳴らない（revisionOnly）。残っていた pending は置き換える（改訂1）。
    const memory = send(emptyState(), F.kcancel);
    expect([shape(memory), effective(memory.state), memory.intents]).toEqual([[[K, "changed", "revisionOnly"]], "cancelled", []]);
    const orphan = send({ ...emptyState(), intents: first.state.intents }, F.kcancel);
    expect([shape(orphan), orphan.intents, orphan.state.intents.map((item) => item.disposition)]).toEqual([[[K, "changed", "revisionOnly"]], [],
      ["superseded", "superseded"]]);
    // held への採用は revisionOnly で currentEstablished は今回の報。
    const held = send(emptyState(), F.oa1);
    expect([shape(held), held.decisions[0].decision === "changed" && held.decisions[0].currentEstablished?.family]).toEqual([
      [[P, "changed", "revisionOnly"]], "VPOA50"]);

    // 期限（P3-C12-TTL=B）: 予測だけの記録は 3 時間、ほかは 2 時間、記憶は 3 時間。1 ms 前は残り、到来で黙って除く。
    const lifetimes = [send(emptyState(), F.yjpna).state, send(emptyState(), F.hjpna).state, memory.state];
    const ends = [at("2026-08-27T04:48:00+09:00") + LONG, at("2026-08-27T02:58:00+09:00") + SHORT, at("2026-08-22T17:27:00+09:00") + LONG];
    expect(lifetimes.map((state, index) => [tick(state, ends[index] - 1).state.currents.length, tick(state, ends[index]).state.currents,
      tick(state, ends[index]).intents.length])).toEqual([[1, [], 0], [1, [], 0], [1, [], 0]]);
    // 期限の来ていない deadline 入力は同じ state 参照と空の結果。
    const idle = tick(first.state, T0 + 30_000);
    expect([idle.decisions, idle.intents, idle.outcomes, idle.displayChanges, idle.diagnostics, idle.state === first.state]).toEqual([[], [], [], [],
      [], true]);
    // 記憶が消えた後に遅れて届いた古い報（受理の時点で retainUntil+1 分）は stale で鳴らない。記録が無いか記憶だけの subject への
    // 遅着も参照と保存世代を変えない。
    const forgotten = tick(memory.state, ends[2]).state;
    const late = send(forgotten, F.k1, undefined, T0 + SHORT + 60_000);
    expect([shape(late), late.intents, late.displayChanges, late.state === forgotten]).toEqual([[[K, "unchanged", "stale"]], [], [], true]);
    const kept = send(memory.state, F.k3, (xml) => serial("4")(retime("2026-08-22T17:30:00+09:00")(xml)), at("2026-08-22T19:30:00+09:00"));
    expect([shape(kept), kept.state === memory.state]).toEqual([[[K, "unchanged", "stale"]], true]);
  });

  // acceptance: 予測の置換と alias（AC04、作者裁定 REPLACE=B・VPOA=A・COUNTERPART-CANCEL=B）。
  it("P3-C12-T04 acceptance / AC04: forecast replacement by observation and the VPOA50 alias, hold, release and counterpart cancel", () => {
    // 富山の実際の組: 発生 {西部} の後の予測 {東部,西部} は西部が最初から除かれる。
    const toyama = send(send(emptyState(), F.hjpna).state, F.yjpna);
    expect(areasOf(recordOf(toyama.state, "normal/VPBS50/YJPNA202608270448"))).toEqual([["linearRainPredicted", ["160010"]]]);
    // 金沢の実際の組: 発生 {加賀,能登} の後の予測 {能登} は replaced として採り、通知しない。
    const kanazawa = send(send(emptyState(), F.hjpnb).state, F.yjpnb);
    expect([shape(kanazawa), effective(kanazawa.state, KANAZAWA_Y), kanazawa.intents]).toEqual([[[KANAZAWA_Y, "changed", "revisionOnly"]], "replaced", []]);
    // replay の金沢の組（予測→時刻をずらした発生）: 予測は replaced で、通知は発生の 1 件だけ。予測の pending は撤回する。
    const forecast = send(emptyState(), F.yjpnb);
    const replay = send(forecast.state, F.replayH);
    expect([effective(replay.state, KANAZAWA_Y), replay.intents.map((item) => item.subject), pending(replay.state, KANAZAWA_Y)]).toEqual([
      "replaced", [KANAZAWA_H, KANAZAWA_H], []]);
    // 発生の記録の期限の後に出た予測は残る。発生の取消・期限で除いた区域は戻らない。運用区分をまたいで置換しない。
    const expired = tick(send(emptyState(), F.hjpnb).state, at("2026-08-27T05:08:00+09:00")).state;
    expect(areasOf(recordOf(send(expired, F.yjpnb, undefined, at("2026-08-27T05:08:00+09:00")).state, KANAZAWA_Y))).toEqual([["linearRainPredicted", ["170020"]]]);
    const withdrawn = send(kanazawa.state, F.hjpnb, cancelOf("2"));
    expect([effective(withdrawn.state, KANAZAWA_H), effective(withdrawn.state, KANAZAWA_Y)]).toEqual(["cancelled", "replaced"]);
    expect(areasOf(recordOf(tick(toyama.state, at("2026-08-27T04:58:00+09:00")).state, "normal/VPBS50/YJPNA202608270448")))
      .toEqual([["linearRainPredicted", ["160010"]]]);
    const crossed = send(send(emptyState(), F.hjpnb, status("訓練")).state, F.yjpnb);
    expect(areasOf(recordOf(crossed.state, KANAZAWA_Y))).toEqual([["linearRainPredicted", ["170020"]]]);

    // alias: VPOA50 → 7 ms 後に対応する VPBS50。VPOA50 は held→aliased、通知は VPBS50 の 1 件だけ。
    const held = send(emptyState(), F.oa1);
    expect([effective(held.state, P), held.intents, toBriefingView(held.state).currents]).toEqual(["held", [], []]);
    const paired = send(held.state, F.k1, undefined, T0 + 7);
    expect([effective(paired.state, P), paired.intents.map((item) => item.subject)]).toEqual(["aliased", [K, K]]);
    // VPBS50 が先なら VPOA50 は aliased で採られ通知 0。運用区分をまたいで alias しない。
    const counterpartFirst = send(send(emptyState(), F.k1).state, F.oa1, undefined, T0 + 7);
    expect([effective(counterpartFirst.state, P), counterpartFirst.intents]).toEqual(["aliased", []]);
    expect(effective(send(send(emptyState(), F.k1, status("訓練")).state, F.oa1).state, P)).toBe("held");
    // 対応報の無い VPOA50 は 59,999 ms では held、60 秒で released（「対応電文未確認」の 1 件）。
    expect(effective(tick(held.state, T0 + 59_999).state, P)).toBe("held");
    const released = tick(held.state, T0 + 60_000);
    expect([effective(released.state, P), channels(released), released.intents[0].payload.title]).toEqual(["released",
      ["desktop:warning:activated", "sound:warning:activated"], "東京都記録的短時間大雨情報（対応電文未確認）"]);
    // released の後の対応報で aliased（release の pending は撤回）。released の系列の続報は通知する。
    const late = send(released.state, F.k1, undefined, T0 + 61_000);
    expect([effective(late.state, P), pending(late.state, P)]).toEqual(["aliased", []]);
    const follow = send(released.state, F.oa2, undefined, at("2026-08-22T17:17:00+09:00"));
    expect([effective(follow.state, P), channels(follow)]).toEqual(["released", ["desktop:warning:updated", "sound:warning:updated"]]);
    // held の間の続報は holdUntil を延ばさない。窓から 60 秒以後の移行・終了入力・restore 入力では無音で released。
    const heldFollow = send(held.state, F.oa2, undefined, T0 + 10_000).state;
    expect(recordOf(heldFollow, P)).toMatchObject({ effective: "held", holdUntil: T0 + 60_000, source: { serialRaw: "2" } });
    const silent = tick(held.state, T0 + 120_000);
    expect([effective(silent.state, P), silent.intents]).toEqual(["released", []]);
    const shutdown = reduceBriefingUnit(held.state, { kind: "shutdown", clock: clock(T0 + 1_000) });
    expect([effective(shutdown.state, P), shutdown.intents]).toEqual(["released", []]);
    const restored = reduceBriefingUnit(emptyState(), { kind: "restore", persisted: briefingUnitCodec.encode(held.state), clock: clock(T0 + 1_000) });
    expect([effective(restored.state, P), restored.intents]).toEqual(["released", []]);
    // aliased の続報: 対応報が active なら aliased のまま revisionOnly、対応報が期限で消えていれば held に戻る（新しい holdUntil）。
    const aliasedFollow = send(paired.state, F.oa2, undefined, at("2026-08-22T17:17:00+09:00"));
    expect([shape(aliasedFollow), effective(aliasedFollow.state, P)]).toEqual([[[P, "changed", "revisionOnly"]], "aliased"]);
    const lapsed = tick(paired.state, T0 + SHORT).state;
    expect([effective(lapsed), effective(lapsed, P)]).toEqual([null, "aliased"]);
    const reheld = send(lapsed, F.oa2, (xml) => retime("2026-08-22T19:10:00+09:00")(xml), T0 + SHORT + 60_000);
    expect(recordOf(reheld.state, P)).toMatchObject({ effective: "held", holdUntil: T0 + SHORT + 120_000 });
    // 対応する VPBS50 の取消で aliased の VPOA50 を無音で released（P3-C12-COUNTERPART-CANCEL=B）。取消は他の subject へ波及しない。
    const counterCancel = send(paired.state, F.k1, cancelOf("2"), T0 + 1_000);
    expect([effective(counterCancel.state), effective(counterCancel.state, P), counterCancel.intents.map((item) => item.subject)]).toEqual([
      "cancelled", "released", [K, K]]);
    expect(recordOf(counterCancel.state, P)?.retainUntil).toBe(T0 + SHORT);
    const ownCancel = send(paired.state, F.oacancel, undefined, T0 + 1_000);
    expect([effective(ownCancel.state), effective(ownCancel.state, P), ownCancel.intents]).toEqual(["active", "cancelled", []]);
    // cancelled の VPOA50 に対応報が来ても取消の記憶が残る（expected:O03:18）。
    const kept = send(send(held.state, F.oacancel, undefined, T0 + 1).state, F.k1, undefined, T0 + 2);
    expect(effective(kept.state, P)).toBe("cancelled");
  });

  // contractBoundary: 容量と受信 1 回の費用（AC05）。境界入力は試験内で作る。
  it("P3-C12-T05 contractBoundary / AC05: 256/257 subjects, eviction order, report bounds, pending and terminal budgets, no whole encode", () => {
    const now = T0 + HOUR;
    const seed = recordOf(send(emptyState(), F.k1).state)!;
    const evictedDiagnostic = { level: "INFO", component: "briefing", reason: "briefingCapacityEvicted", unit: "U-B", count: 1 };
    const report = (id: string, mark = "通常") => decodeFixture(F.k1, (xml) => status(mark)(eventId(id)(retime(iso(now))(xml))));
    const full = Array.from({ length: 256 }, (_, index) => subjectRecord(seed, now, index));
    expect(receive(filled(full.slice(1)), report("N1"), clock(now)).diagnostics).toEqual([]);
    const pushed = receive(filled(full), report("N1"), clock(now));
    expect([pushed.diagnostics, pushed.state.currents.length, pushed.state.currents.includes(full[0]), shape(pushed)]).toEqual([[evictedDiagnostic],
      256, false, [["normal/VPBS50/N1", "changed", "semantic"]]]);
    // 退去の順（normal の受理）: (1) retainUntil を過ぎた記録 → (2) 記憶 → (3) training/test の生きた記録 → (4) normal の最古。
    let state = filled([subjectRecord(seed, now, 0), subjectRecord(seed, now, 1, { operation: "training" }), subjectRecord(seed, now, 2, { memory: true }),
      subjectRecord(seed, now, 3, { retainUntil: now }), ...Array.from({ length: 252 }, (_, index) => subjectRecord(seed, now, index + 10))]);
    const evicted: string[] = [];
    for (const id of ["N2", "N3", "N4", "N5"]) {
      const before = state.currents.map((item) => item.subject);
      const step = receive(state, report(id), clock(now));
      expect(step.decisions[0].decision).toBe("changed");
      state = step.state;
      evicted.push(...before.filter((subject) => !state.currents.some((item) => item.subject === subject)));
    }
    expect(evicted).toEqual([3, 2, 1, 0].map((index) => subjectRecord(seed, now, index, { operation: index === 1 ? "training" : "normal" }).subject));

    // P3-C12-BOUNDS=A: item 4/5・区域の延べ 16/17・観測 8/9（電文順の後ろから捨てて truncated）。
    const bounded = (edit: (xml: string) => string, name: string = F.k1) => send(emptyState(), name, edit).state.currents[0];
    const items = (count: number) => bounded(tags(Array.from({ length: count }, (_, index) => ({ condition: `種別${index}`, areas: [{ code: String(100 + index) }] }))));
    expect([items(5), items(4)]).toMatchObject([{ items: { length: 4 }, truncated: true }, { items: { length: 4 }, truncated: false }]);
    const areas = (count: number) => bounded(tags([{ condition: "記録雨", areas: Array.from({ length: count }, (_, index) => ({ code: String(100 + index) })) }]));
    expect([areas(17), areas(16)]).toMatchObject([{ items: [{ areas: { length: 16 } }], truncated: true }, { items: [{ areas: { length: 16 } }], truncated: false }]);
    const observed = (count: number) => bounded(observations(Array.from({ length: count }, (_, index) => rainItem(String(1_000 + index), `地点${index}`, "100"))));
    expect([observed(9), observed(8)]).toMatchObject([{ observations: { length: 8 }, truncated: true }, { observations: { length: 8 }, truncated: false }]);
    const vpoa = (count: number) => bounded((xml) => xml.replace(/<Areas codeType="気象情報／府県予報区・細分区域等">[\s\S]*?<\/Areas>/,
      `<Areas>${Array.from({ length: count }, (_, index) => `<Area><Name>区域${index}</Name><Code>${100 + index}</Code></Area>`).join("")}</Areas>`), F.oa1);
    expect([vpoa(17), vpoa(16)]).toMatchObject([{ areas: { length: 16 }, truncated: true }, { areas: { length: 16 }, truncated: false }]);
    // P3-C12-TRUNCATED-EVIDENCE: 発生の報の区域の延べ 17 件目にだけある区域の予測は除かれない。
    const forecast = send(emptyState(), F.yjpnb, tags([{ condition: "線状降水帯直前", areas: [{ code: "170099" }, { code: "170020" }] }])).state;
    const cut17 = send(forecast, F.hjpnb, tags([{ condition: "線状降水帯発生", areas: [...Array.from({ length: 15 }, (_, index) => ({ code: String(100 + index) })),
      { code: "170020" }, { code: "170099" }] }]));
    expect(areasOf(recordOf(cut17.state, KANAZAWA_Y))).toEqual([["linearRainPredicted", ["170099"]]]);
    // title 64/65・headline 192/193・名前 16/17 単位の切り詰め。
    const titled = (length: number) => bounded((xml) => xml.replace("<Title>東京都気象防災速報（記録的短時間大雨）</Title>", `<Title>${"題".repeat(length)}</Title>`));
    expect([titled(65), titled(64)]).toMatchObject([{ title: "題".repeat(64), truncated: true }, { title: "題".repeat(64), truncated: false }]);
    const headlined = (length: number) => bounded((xml) => xml.replace(/<Text>[\s\S]*?<\/Text>/, `<Text>${"見".repeat(length)}</Text>`));
    expect([headlined(193), headlined(192)]).toMatchObject([{ headline: "見".repeat(192), truncated: true }, { headline: "見".repeat(192), truncated: false }]);
    const named = (length: number) => bounded(tags([{ condition: "記録雨", areas: [{ code: "130010", name: "名".repeat(length) }] }]));
    expect([named(17), named(16)]).toMatchObject([{ items: [{ areas: [{ name: "名".repeat(16) }] }], truncated: true },
      { items: [{ areas: [{ name: "名".repeat(16) }] }], truncated: false }]);

    // pending 128/129 件と「実 byte＋予約」131,072/131,073（予約は delivery-growth.ts の deliveryGrowth、式を写さない）。
    const template = send(emptyState(), F.k1).intents[0];
    const seeded = (count: number, pad = 0): BriefingIntent[] => Array.from({ length: count }, (_, index) => ({ ...template, id: `seed-${index}`,
      subject: `normal/VPBS50/S${index}`, source: { ...template.source, subject: `normal/VPBS50/S${index}` },
      payload: { ...template.payload, body: index === 0 ? "x".repeat(1 + pad) : "x" }, createdAt: T0 - 1000, expiresAt: T0 + 179_000 }));
    const fits = send({ ...emptyState(), intents: seeded(126) }, F.k1);
    expect([fits.intents.length, pending(fits.state).length, fits.diagnostics]).toEqual([2, 128, []]);
    const over = send({ ...emptyState(), intents: seeded(127) }, F.k1);
    expect([over.intents.map((item) => item.channel), over.diagnostics]).toMatchObject([["sound"], [{ reason: "notificationCapacityEvicted", count: 1 }]]);
    const bytesOf = (values: readonly BriefingIntent[]) => Buffer.byteLength(JSON.stringify(values));
    const fresh = send(emptyState(), F.k1).intents;
    const pad = 131_072 - bytesOf([...seeded(10), ...fresh]) - [...seeded(10), ...fresh].reduce((sum, item) => sum + deliveryGrowth(item), 0);
    expect(pending(send({ ...emptyState(), intents: seeded(10, pad) }, F.k1).state)).toHaveLength(12);
    expect(send({ ...emptyState(), intents: seeded(10, pad + 1) }, F.k1).intents.map((item) => item.channel)).toEqual(["sound"]);
    // 新しい intent が容量で外れただけなら intent の配列を変えない（C9 の Q-C9-IMPL-AMEND(9)(e)）。currents は変わるので保存世代は進む。
    const busy: BriefingUnitState = { ...emptyState(), intents: seeded(128) };
    const dropped = send(busy, F.k1, status("訓練"));
    expect([dropped.intents, dropped.diagnostics, dropped.state.intents === busy.intents]).toEqual([[], [{ level: "INFO", component: "briefing",
      reason: "notificationCapacityEvicted", unit: "U-B", count: 1 }], true]);
    // 配送の更新で attempts が 1 桁から 5 桁・nextAttemptAt の桁が増えても、予約の内側で decode が受ける。
    const budget = send({ ...emptyState(), intents: seeded(10, pad) }, F.k1).state;
    const grown = reduceBriefingUnit(budget, { kind: "intentUpdate", clock: clock(T0), intentUpdate: pending(budget).map((item) => ({ id: item.id,
      attempts: 12_345, nextAttemptAt: T0 + 0.123456, disposition: "pending" as const })) });
    expect(roundTrip(grown.state).kind).toBe("restored");

    // I-U-B.capacityMeasurement の同時最大状態（実配信の最大の記録の形 82_01_01）と、上限の文字列での上界（I-U-B.capacityReserve）。
    const real = budgetState(false), bound = budgetState(true);
    const sizes = [real, bound].map((item) => Buffer.byteLength(JSON.stringify(briefingUnitCodec.encode(item))));
    const one = (value: object) => Buffer.byteLength(JSON.stringify(value));
    const heldBound = boundRecord("VPOA50", 0);
    console.info("P3-C12 capacity", JSON.stringify({ realPayload: sizes[0], contractReal: 616_800 - 293, boundPayload: sizes[1],
      contractBound: 1_647_712 - 293, realActive: one(real.currents[0]), contractActive: 1_507, boundActive: one(bound.currents[0]), contractBoundActive: 5_534,
      boundHeld: one(heldBound), contractBoundHeld: 2_872, realReleased: one(recordOf(tick(send(emptyState(), F.oa1).state, T0 + 60_000).state, P)!),
      contractReleased: 823, realCancelled: one(recordOf(send(emptyState(), F.kcancel).state)!), contractCancelled: 416,
      realIntent: one(template), counts: [real.currents.length, real.intents.length, bound.intents.length] }));
    for (const item of [real, bound]) expect(roundTrip(item).kind).toBe("restored");
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2_097_152);
    expect(sizes[1] + 293).toBeLessThanOrEqual(1_647_712);

    // 保持上限付近で、受信 1 回は記録単位の加算だけ（state・配列・既存の記録を直列化しない）。
    receive(real, report("N9"), clock(now));
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      receive(real, report("N9"), clock(now));
      const whole = new Set<unknown>([real, real.currents, real.intents, ...real.currents, ...real.intents]);
      expect(stringify.mock.calls.filter(([value]) => whole.has(value))).toEqual([]);
    } finally { stringify.mockRestore(); }
    // 区域の索引は構築中の配列に足す（品質レビュー P2、RES-03）: 同じ区域に集中させた予測 64 件・256 件に既存の系列の続報を受けたとき、
    // 索引の位置の配列（数の配列）を反復した要素の数が記録の数を超えない（要素ごとに複写すると 2,016・32,640）。反復の計数は試験の中だけの差し替え。
    const forecastSeed = recordOf(send(emptyState(), F.yjpnb).state, KANAZAWA_Y)!;
    const crowdOn = (count: number) => filled(Array.from({ length: count }, (_, index) => {
      const subject = `normal/VPBS50/Y${index}`;
      return { ...forecastSeed, subject, series: `Y${index}`, source: { ...forecastSeed.source, subject } };
    }));
    const followUp = decodeFixture(F.yjpnb, (xml) => serial("2")(retime("2026-08-27T04:50:00+09:00")(eventId("Y0_202608270450")(xml))));
    const iterated = (count: number): number => {
      const crowd = crowdOn(count);
      const original = Array.prototype[Symbol.iterator];
      let elements = 0;
      Array.prototype[Symbol.iterator] = function (this: unknown[]) {
        if (this.length !== 0 && typeof this[0] === "number") elements += this.length;
        return original.call(this);
      };
      try {
        expect(shape(receive(crowd, followUp, clock(Date.parse(followUp.reportDateTimeRaw))))).toEqual([["normal/VPBS50/Y0", "changed", "revisionOnly"]]);
      } finally { Array.prototype[Symbol.iterator] = original; }
      return elements;
    };
    for (const count of [64, 256]) expect(iterated(count), String(count)).toBeLessThanOrEqual(count);
  });

  // 実不具合の再発防止の型（C8 の Q-C8-IMPL-AMEND(1)(2) を U-B で）: owner を通した更新・保存・復元。
  it("P3-C12-T05 contractBoundary / AC05: an owner terminal update at the terminal budget and pending at its budget survive save and restore", () => {
    const template = send(emptyState(), F.k1).intents[0];
    const terminalBytes = (values: readonly BriefingIntent[]) => values.filter((item) => item.disposition !== "pending")
      .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + 1, 0);
    const old: BriefingIntent = { ...template, id: "old-pending", createdAt: T0 - 100_000, expiresAt: T0 + 80_000 };
    const done = (index: number): BriefingIntent => ({ ...template, id: `done-${index}`, createdAt: T0 + index, disposition: "delivered" });
    let count = 0;
    while (terminalBytes(Array.from({ length: count + 1 }, (_, index) => done(index))) <= 98_304) count++;
    const now = clock(T0 + 1_000);
    const empty = restoreOwner({ runId: "run", place: "deferred", clock: now, restored: { "U-F": { kind: "empty" }, "U-L": { kind: "empty" },
      "U-R": { kind: "empty" }, "U-B": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const owner = { ...empty, units: { ...empty.units, "U-B": { ...emptyState(), intents: [old, ...Array.from({ length: count }, (_, index) => done(index))] } } };
    const updated = intentUpdateOwner(owner, "U-B", [{ id: old.id, attempts: 1, nextAttemptAt: now.wallTimeMs, disposition: "delivered" }], now,
      linkedUnitTable);
    expect(updated.adopted).toBe(true);
    expect(updated.state.units["U-B"]!.intents.find((item) => item.id === old.id)?.disposition).toBe("delivered");
    // 終端記録の合計が 98,304 byte を超える分は最古（done-0）から期限前に回収し、更新で終端にした記録は回収しない。
    expect(updated.state.units["U-B"]!.intents.some((item) => item.id === "done-0")).toBe(false);
    expect(roundTrip(updated.state.units["U-B"]!).kind).toBe("restored");
    // 予算いっぱいに受理した pending が、最長の配送の更新（attempts 16 桁・nextAttemptAt 25 文字）の後も保存・復元できる。
    let full = emptyState();
    for (let index = 0; index < 200; index++)
      full = send(full, F.k1, (xml) => eventId(`E${index}`)(xml).replace(/<Text>[\s\S]*?<\/Text>/, `<Text>${"雨".repeat(192)}</Text>`), T0 + index).state;
    expect(pending(full).length).toBeLessThan(128);
    const first = roundTrip(full);
    if (first.kind !== "restored") throw new Error("the admitted state does not decode");
    const grown = intentUpdateOwner({ ...empty, units: { ...empty.units, "U-B": first.state } }, "U-B", pending(first.state).map((item, index) => ({
      id: item.id, attempts: Number.MAX_SAFE_INTEGER, nextAttemptAt: -0.0000018927186924017318,
      disposition: index % 3 === 0 ? "superseded" as const : "pending" as const })), now, linkedUnitTable);
    expect(grown.adopted).toBe(true);
    expect(roundTrip(grown.state.units["U-B"]!).kind).toBe("restored");
  });

  // contractBoundary: I-U-B.persisted・I-U-B.decode、復元で intent を作らない、view（AC06）。
  it("P3-C12-T06 contractBoundary / AC06: one codec, persisted fields only, every decode check, restore without new intents and the view", () => {
    let state = send(emptyState(), F.k1).state;
    state = send(state, F.oa1, eventId("JPTC202608221709_202608221709"), T0 + 1_000).state;
    state = send(state, F.yjpnb, undefined, T0 + 2_000).state;
    state = send(state, F.cancel).state;
    const payload = JSON.parse(JSON.stringify(briefingUnitCodec.encode(state))) as JsonValue;
    expect(Object.keys(payload as object).sort()).toEqual(["currents", "intents", "schemaVersion"]);
    expect(briefingUnitCodec.decode(payload)).toEqual({ kind: "restored", state: { ...state, contentRevision: 0,
      persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } } });
    type Row = Record<string, unknown>;
    const value = payload as { currents: Row[]; intents: Row[] };
    const [record] = value.currents, [intent] = value.intents;
    const held = value.currents.find((item) => item.effective === "held")!;
    const forecast = value.currents.find((item) => item.subject === KANAZAWA_Y)!;
    const memory = value.currents.find((item) => item.effective === "cancelled")!;
    const source = record.source as Row;
    const items = record.items as Row[];
    const observations0 = record.observations as Row[];
    const withActive = (patch: Row) => ({ ...value, currents: [{ ...record, ...patch }] });
    const withHeld = (patch: Row) => ({ ...value, currents: [{ ...held, ...patch }] });
    const withObservation = (patch: Row) => withActive({ observations: [{ ...observations0[0], ...patch }] });
    const many = <T>(length: number, make: (index: number) => T): T[] => Array.from({ length }, (_, index) => make(index));
    const renamed = (subject: string) => withActive({ subject, source: { ...source, subject } });
    const invalid: [string, unknown][] = [
      ["schemaVersion", { ...value, schemaVersion: "p3-briefing-unit-v0" }],
      ["currents > 256", { ...value, currents: many(257, (index) => ({ ...record, series: `E${index}`, subject: `normal/VPBS50/E${index}`,
        source: { ...source, subject: `normal/VPBS50/E${index}` } })) }],
      ["duplicate subject", { ...value, currents: [record, record] }],
      ["subject and series", withActive({ series: "KJPTK202608221710" })],
      ["subject and headType", withActive({ headType: "VPOA50" })],
      ["series with underscore", renamed("normal/VPBS50/KJPTK_1")],
      ["subject and operation", renamed("training/VPBS50/KJPTK202608221709")],
      ["headType and effective", withActive({ effective: "held", holdUntil: T0 })],
      ["VPOA50 replaced", { ...value, currents: [{ ...memory, headType: "VPOA50", subject: "normal/VPOA50/JPOD240001",
        source: { ...(memory.source as Row), subject: "normal/VPOA50/JPOD240001", family: "VPOA50" }, effective: "replaced" }] }],
      ["kind and condition", withActive({ items: [{ ...items[0], kind: "linearRainPredicted" }] })],
      ["unknown with a table condition", withActive({ items: [{ ...items[0], kind: "unknown" }] })],
      ["forecast without areas", { ...value, currents: [{ ...forecast, items: [{ ...(forecast.items as Row[])[0], areas: [] }] }] }],
      ["items over 4", withActive({ items: many(5, (index) => ({ kind: "unknown", condition: `種${index}`, areas: [] })) })],
      ["areas over 16", withActive({ items: [{ ...items[0], areas: many(17, (index) => ({ code: String(index), name: "x" })) }] })],
      ["area code over 8 bytes", withActive({ items: [{ ...items[0], areas: [{ code: "123456789", name: "x" }] }] })],
      ["name lone surrogate", withActive({ items: [{ ...items[0], areas: [{ code: "130010", name: "東京\ud842" }] }] })],
      ["title over 64", withActive({ title: "x".repeat(65) })],
      ["headline control character", withActive({ headline: "雨\t雨" })],
      ["observations over 8", withActive({ observations: many(9, () => observations0[0]) })],
      ["observation value over 11 characters", withObservation({ value: 1234567.1 })],
      ["observation unit over 8", withObservation({ unit: "m".repeat(9) })],
      ["observation time form", withObservation({ time: "2026-08-22T17:00:00Z" })],
      ["observation part", withObservation({ part: "wind" })],
      ["retainUntil", withActive({ retainUntil: Number(record.retainUntil) + 1 })],
      ["factless keeps facts", { ...value, currents: [{ ...memory, title: "x" }] }],
      ["released keeps holdUntil", withHeld({ effective: "released" })],
      ["holdUntil not finite", withHeld({ holdUntil: null })],
      ["aliased without facts", { ...value, currents: [{ subject: held.subject, operation: "normal", headType: "VPOA50", series: held.series,
        source: held.source, retainUntil: Number(held.retainUntil) + HOUR, effective: "aliased" }] }],
      ["inputId escaped character", withActive({ source: { ...source, inputId: 'in"put' } })],
      ["ReportDateTime form", withActive({ source: { ...source, reportDateTimeRaw: "\n2026-08-22T17:09:00+09:00" } })],
      ["InfoType", withActive({ source: { ...source, infoTypeRaw: "\t不明" } })],
      ["source family", withActive({ source: { ...source, family: "VPOA50" } })],
      ["pending + delivery reserve > 131072 bytes", { ...value, intents: reserveOver(intent) }],
      ["pending + terminal > 229,376 bytes", { ...value, intents: terminalOver(intent) }],
      ["attempts negative", { ...value, intents: [{ ...intent, attempts: -1 }] }],
      ["nextAttemptAt not finite", { ...value, intents: [{ ...intent, nextAttemptAt: null }] }],
      ["intent of another unit", { ...value, intents: [{ ...intent, unit: "U-R" }] }],
      ["intent subject form", { ...value, intents: [{ ...intent, subject: "normal/VXKO50/1", source: { ...(intent.source as Row), subject: "normal/VXKO50/1" } }] }],
    ];
    for (const [name, candidate] of invalid) expect(briefingUnitCodec.decode(candidate as JsonValue).kind, name).toBe("invalid");
    // 回収された記録の intent は期限まで残るので、state に残る subject との一致は求めない。
    expect(briefingUnitCodec.decode({ ...value, currents: [] } as JsonValue).kind).toBe("restored");
    // 受理が通す上限ちょうどの記録（truncated・headline の改行・非 BMP の文字で切った名前・表に無い 16 単位の condition）は decode も通す。
    const widest = send(emptyState(), F.k1, tags([{ condition: "謎".repeat(20), areas: Array.from({ length: 17 }, (_, index) => ({ code: String(10_000_000 + index),
      name: `あ${"𠮷".repeat(16)}` })) }]));
    const widestRecord = recordOf(widest.state);
    expect([widestRecord?.effective === "active" && [widestRecord.truncated, widestRecord.headline.includes("\n"), widestRecord.items[0].condition],
      roundTrip(widest.state).kind]).toEqual([[true, true, "謎".repeat(16)], "restored"]);

    // 復元で intent を作らず、pending の期限を延ばさない。view には held・aliased・replaced・cancelled が載らない。
    const restoredAt = T0 + 61_000;
    const restored = reduceBriefingUnit(emptyState(), { kind: "restore", persisted: briefingUnitCodec.encode(state), clock: clock(restoredAt) });
    expect([restored.intents, restored.state.intents.map((item) => [item.id, item.createdAt, item.expiresAt])]).toEqual([[],
      state.intents.filter((item) => item.expiresAt > restoredAt).map((item) => [item.id, item.createdAt, item.expiresAt])]);
    const replaced = send(state, F.hjpnb, undefined, T0 + 4_000).state;
    const aliased = send(send(emptyState(), F.oa1).state, F.k1, undefined, T0 + 7).state;
    const visibleSubjects = (value: BriefingUnitState) => toBriefingView(value).currents.map((item) => [item.subject, item.effective]);
    expect([visibleSubjects(state), visibleSubjects(replaced), visibleSubjects(aliased)]).toEqual([[[K, "active"], [KANAZAWA_Y, "active"]],
      [[K, "active"], [KANAZAWA_H, "active"]], [[K, "active"]]]);
  });

  // acceptance: Q-NOTICE の速報分（AC07、作者裁定 NOTICE-LEVELS=A・TRAINING=A）。
  it("P3-C12-T07 acceptance / AC07: opportunities, levels, replacement, the largest body within the bounds is not cut and keeps its prefixes and suffixes, training and restart", () => {
    const first = send(emptyState(), F.k1);
    const record = recordOf(first.state);
    const headline = record?.effective === "active" ? record.headline : "";
    const title = "東京都気象防災速報（記録的短時間大雨）";
    expect(first.intents.map((item) => [item.channel, item.transition, item.payload.domain, item.payload.level, item.payload.title,
      item.payload.body, item.expiresAt - item.createdAt])).toEqual([["desktop", "activated", "weather", "warning", title, headline, 180_000],
      ["sound", "activated", "weather", "warning", title, headline, 60_000]]);
    // 公開事実の変わった続報は updated、同じ事実の新しい版は revisionOnly で作らない。訂正は事実が同じでも作る（[訂正]・「訂正: 」）。
    expect(channels(send(first.state, F.k2))).toEqual(["desktop:warning:updated", "sound:warning:updated"]);
    const same = send(first.state, F.k1, (xml) => serial("5")(retime("2026-08-22T17:10:00+09:00")(xml)));
    expect([shape(same), same.intents]).toEqual([[[K, "changed", "revisionOnly"]], []]);
    const corrected = send(first.state, F.k1, replaceTag("InfoType", "訂正"));
    expect(corrected.intents.map((item) => [item.transition, item.payload.title, item.payload.body])).toEqual(Array(2).fill(["updated",
      `[訂正] ${title}`, `訂正: ${headline}`]));
    // active の取消は cancel。記憶だけ・held・aliased の取消では作らない。
    expect(channels(send(first.state, F.k1, cancelOf("2")))).toEqual(["desktop:cancel:cancelled", "sound:cancel:cancelled"]);
    expect(send(send(emptyState(), F.oa1).state, F.oacancel).intents).toEqual([]);
    // 置換（P3-C12-REPLACEMENT=A）: 同じ subject・channel の新しい intent は古い pending を、取消は対象 subject の全 pending を置き換える。
    const replaced = send(first.state, F.k2, undefined, T0 + 30_000).state;
    expect(replaced.intents.map((item) => item.disposition)).toEqual(["superseded", "superseded", "pending", "pending"]);
    expect(pending(send(replaced, F.k3, cancelOf("4"), T0 + 40_000).state).map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
    expect(send(first.state, F.k1, eventId("KJPTK202608221800_202608221800")).state.intents.slice(0, 2)).toEqual(first.state.intents);
    // 本文: Headline の無い報は item ごとの「種別 区域」、それも無ければ題。VPOA50 は題と本文の末尾に「（対応電文未確認）」。
    expect(send(emptyState(), F.k1, withoutHeadline).intents[0].payload.body).toBe("記録雨 東京地方");
    expect(send(emptyState(), F.fallback, withoutHeadline).intents[0].payload.body).toBe("滋賀県気象防災速報");
    const release = tick(send(emptyState(), F.oa1).state, T0 + 60_000);
    expect(release.intents[0].payload.body.endsWith("（対応電文未確認）")).toBe(true);
    // 上限の内側の最大（items 4・区域 16・上限の長さの名前の要約、345 単位）でも本文は 512 に届かず切られず、【訓練】・[訂正]・「訂正: 」と
    // VPOA50 の「（対応電文未確認）」が残る（K5 の F15 の型）。
    const crowded = send(emptyState(), F.k1, (xml) => replaceTag("InfoType", "訂正")(status("訓練")(withoutHeadline(tags(Array.from({ length: 4 },
      (_, item) => ({ condition: "記".repeat(16), areas: Array.from({ length: 4 }, (_, at) => ({ code: String(100 + item * 4 + at), name: "区".repeat(16) })) })))(xml)))));
    const notice = crowded.intents[0].payload;
    expect([crowded.intents.map((item) => item.channel), notice.title, notice.body.length, notice.body.startsWith("訂正: 記")]).toEqual([["desktop"],
      `【訓練】[訂正] ${title}`, 4 + 4 * (16 + 1 + 4 * 16 + 3) + 3 * 3, true]);
    const drill = tick(send(emptyState(), F.oa1, status("訓練")).state, T0 + 60_000).state;
    const drillCorrected = send(drill, F.oa1, (xml) => replaceTag("InfoType", "訂正")(status("訓練")(xml)), T0 + 61_000).intents[0].payload;
    expect([drillCorrected.title, drillCorrected.body.startsWith("訂正: "), drillCorrected.body.endsWith("（対応電文未確認）")]).toEqual([
      "【訓練】[訂正] 東京都記録的短時間大雨情報（対応電文未確認）", true, true]);
    // training/test は desktop だけ（P3-C12-TRAINING=A）。
    expect(["訓練", "試験"].map((mark) => send(emptyState(), F.k1, status(mark)).intents.map((item) => [item.channel, item.payload.title]))).toEqual([
      [["desktop", `【訓練】${title}`]], [["desktop", `【試験】${title}`]]]);
    // intentUpdate: 既存 id だけを一括で更新し、保存世代を 1 つ進める。未知 id・同値は no-op。
    const [desktop] = first.intents;
    const updated = reduceBriefingUnit(first.state, { kind: "intentUpdate", clock: clock(desktop.createdAt), intentUpdate: [{ id: desktop.id,
      attempts: 1, nextAttemptAt: desktop.createdAt + 1_000, disposition: "pending" }, { id: "unknown", attempts: 1, nextAttemptAt: 0, disposition: "delivered" }] });
    expect([updated.state.persistence.currentGeneration, updated.decisions]).toMatchObject([first.state.persistence.currentGeneration + 1,
      [{ decision: "changed", change: "deliveryOnly" }]]);
    expect(reduceBriefingUnit(updated.state, { kind: "intentUpdate", clock: clock(desktop.createdAt), intentUpdate: { id: desktop.id, attempts: 1,
      nextAttemptAt: desktop.createdAt + 1_000, disposition: "pending" } }).state).toBe(updated.state);
    // 復元直後の続報は復元した記録との差で決める（同じ報は duplicate で鳴らさない、事実の変わった続報は鳴る）。
    const restored = reduceBriefingUnit(emptyState(), { kind: "restore", persisted: briefingUnitCodec.encode(first.state), clock: clock(T0 + 1) }).state;
    expect([send(restored, F.k1).intents, channels(send(restored, F.k2))]).toEqual([[], ["desktop:warning:updated", "sound:warning:updated"]]);
  });

  // contractBoundary: E22 の U-B は対象外（P3-C12-N2、AC13）。
  it("P3-C12-T11 contractBoundary / AC13: origin=recovery is not applied", () => {
    const state = send(emptyState(), F.k1).state;
    const recovery = receive(state, decodeXml(fixtureXml(F.k2), "VPBS50", "recovered", "recovery"), clock(T0 + 8 * 60_000));
    expect(recovery.state).toBe(state);
    expect(recovery.decisions).toEqual([{ subject: K, operation: "normal", decision: "unchanged", reason: "noChange" }]);
    expect([recovery.intents, recovery.outcomes, recovery.confirmationEvidence, recovery.displayChanges]).toEqual([[], [], [], []]);
  });

  // contractBoundary: 退去の operation の適格性と自身の退去（AC14、監査 F04 の型を未配送の U-B で先に止める）。
  it("P3-C12-T12 contractBoundary / AC14: training never evicts normal records, self-eviction, its cancel and the normal order", () => {
    const now = T0 + HOUR;
    const seed = recordOf(send(emptyState(), F.k1).state)!;
    const evictedDiagnostic = { level: "INFO", component: "briefing", reason: "briefingCapacityEvicted", unit: "U-B", count: 1 };
    const report = (id: string, mark = "通常", edit: (xml: string) => string = (xml) => xml, time = now) =>
      decodeFixture(F.k1, (xml) => edit(status(mark)(eventId(id)(retime(iso(time))(xml)))));
    const normals = Array.from({ length: 255 }, (_, index) => subjectRecord(seed, now, index));
    const memory = subjectRecord(seed, now, 300, { memory: true });
    const crowded = filled([...normals, memory]);
    // (a) normal の生きた記録 255＋取消の記憶 1 に training の新しい系列 → 記憶は残り、受けた記録が自身を退去する。
    const self = receive(crowded, report("T1", "訓練"), clock(now));
    expect([shape(self), self.decisions[0], self.outcomes, self.diagnostics, self.intents, self.state.currents === crowded.currents,
      self.state.persistence]).toEqual([[["training/VPBS50/T1", "changed", "revisionOnly"]], expect.objectContaining({ currentEstablished: null }),
      [{ kind: "accepted", change: "revisionOnly", subjects: [] }], [evictedDiagnostic], [], true, crowded.persistence]);
    // 続く取消より古い normal の報は unchanged/stale（取消の記憶が残る）。
    expect(shape(receive(self.state, report("S300", "通常", (xml) => xml, now - 400_000), clock(now)))).toEqual([["normal/VPBS50/S300", "unchanged", "stale"]]);
    // (b) training 1 件を含む満杯では training の記録だけが退去し、normal の記憶は残る。
    const drill = subjectRecord(seed, now, 400, { operation: "training" });
    const withDrill = receive(filled([...normals.slice(1), drill, memory]), report("T2", "訓練"), clock(now)).state.currents;
    expect([withDrill.includes(drill), withDrill.includes(memory), withDrill.length]).toEqual([false, true, 256]);
    // (c) reducer を直に呼んだ retainUntil を過ぎた normal の記録も、training の受理で退去しない（D-PAST-RETENTION=A）。
    const past = filled([subjectRecord(seed, now, 0, { retainUntil: now }), ...normals.slice(1), memory]);
    expect(receive(past, report("T3", "訓練"), clock(now)).state.currents).toBe(past.currents);
    // (d) 自身を退去した training の取消は、その subject の pending を superseded にし、intents が変わったときだけ保存世代を進める。
    const drilled = receive(filled(normals), report("T4", "訓練"), clock(now)).state;
    const evictedDrill = receive(drilled, report("N1"), clock(now)).state;
    expect(evictedDrill.currents.some((item) => item.operation === "training")).toBe(false);
    const withdrawn = receive(evictedDrill, report("T4", "訓練", cancelOf("2")), clock(now));
    expect([withdrawn.state.currents === evictedDrill.currents, pending(withdrawn.state, "training/VPBS50/T4"),
      withdrawn.state.persistence.currentGeneration - evictedDrill.persistence.currentGeneration]).toEqual([true, [], 1]);
    const again = receive(withdrawn.state, report("T4", "訓練", cancelOf("3")), clock(now));
    expect(again.state).toBe(withdrawn.state);
    // (e) normal の受理は期限切れ → 記憶 → training/test → normal の順（ここでは記憶）。
    expect(receive(crowded, report("N2"), clock(now)).state.currents.includes(memory)).toBe(false);
    // 遅着の報は満杯でも退去を起こさない（P3-C12-EVICT-OPERATION(5)・AC03）: 記録の無い subject への遅着は state が同じ参照。
    const lateFull = receive(crowded, report("N3", "通常", (xml) => xml, now - SHORT), clock(now));
    expect([shape(lateFull), lateFull.state === crowded]).toEqual([[["normal/VPBS50/N3", "unchanged", "stale"]], true]);
  });

  // 実不具合の再発防止（品質レビュー P2）: 退去の前は対応報があるので aliased（3 時間）で遅着でない VPOA50 も、対応報を退去すると held
  // （2 時間）になる。退去の後の候補で遅着を判定し直し、遅着なら退去も確定せず unchanged/stale で同じ state 参照を返す。
  it("P3-C12-T12 contractBoundary / AC14: a VPOA50 that is late once its counterpart would be evicted evicts nothing and is stale", () => {
    const now = T0 + SHORT + 1_000;
    const counterpart = recordOf(send(emptyState(), F.k1).state)!;
    const full = filled([counterpart, ...Array.from({ length: 255 }, (_, index) => subjectRecord(counterpart, now, index))]);
    const late = send(full, F.oa1, undefined, now);
    expect([shape(late), late.state === full, late.intents, late.outcomes, late.diagnostics]).toEqual([[[P, "unchanged", "stale"]], true, [], [], []]);
  });

  // contractBoundary: 最大の保存状態からの閉包（AC15、台帳 74 の (c)、P3-X-C4）。
  it("P3-C12-T13 contractBoundary / AC15: every transition from the largest decodable state encodes, decodes and stays within the bound", () => {
    const k = recordOf(send(emptyState(), F.k1).state)!, held = recordOf(send(emptyState(), F.oa1).state, P)!;
    const fill = budgetState(true).intents.map((item, index) => index === 0 ? { ...item, subject: P,
      source: { ...item.source, subject: P, family: "VPOA50" } } : item);
    const start: BriefingUnitState = { ...emptyState(), currents: [...Array.from({ length: 254 }, (_, index) => boundRecord("VPBS50", index)), k, held],
      intents: fill };
    const steps: [string, BriefingUnitStep][] = [];
    const aliased = send(start, F.k2, undefined, at("2026-08-22T17:17:00+09:00"));
    steps.push(["(i) alias", aliased]);
    expect([effective(aliased.state, P), pending(aliased.state, P)]).toEqual(["aliased", []]);
    const unaliased = send(aliased.state, F.kcancel, undefined, at("2026-08-22T17:28:00+09:00"));
    steps.push(["(ii) counterpart cancel", unaliased]);
    expect([effective(unaliased.state, P), unaliased.intents.map((item) => item.subject)]).toEqual(["released", [K, K]]);
    steps.push(["(iii) intentUpdate", reduceBriefingUnit(aliased.state, { kind: "intentUpdate", clock: clock(T0), intentUpdate: pending(aliased.state)
      .map((item, index) => ({ id: item.id, attempts: Number.MAX_SAFE_INTEGER, nextAttemptAt: -0.0000018927186924017318,
        disposition: index % 3 === 0 ? "superseded" as const : "pending" as const })) })]);
    const windowed = tick(start, T0 + 60_000);
    steps.push(["(iv) hold window", windowed], ["(iv) retention", tick(windowed.state, T0 + SHORT)]);
    expect(effective(windowed.state, P)).toBe("released");
    steps.push(["(v) restore", reduceBriefingUnit(emptyState(), { kind: "restore", persisted: briefingUnitCodec.encode(start), clock: clock(T0 + 1_000) })]);
    const evicting = send(start, F.k1, eventId("KJPXX202608221709_202608221709"), T0 + 1_000);
    steps.push(["(vi) eviction", evicting]);
    expect(evicting.diagnostics).toContainEqual(expect.objectContaining({ reason: "briefingCapacityEvicted" }));
    const sizes = [["start", start] as const, ...steps.map(([name, step]) => [name, step.state] as const)].map(([name, state]) => {
      expect(roundTrip(state).kind, name).toBe("restored");
      return [name, Buffer.byteLength(JSON.stringify(briefingUnitCodec.encode(state))) + 293] as const;
    });
    console.info("P3-C12-T13 generation bytes", JSON.stringify(Object.fromEntries(sizes)));
    for (const [name, size] of sizes) expect(size, name).toBeLessThanOrEqual(1_647_712);
  });

  // contractBoundary: held の復元・alias の解除の後の期限と dirty（AC16、台帳 74 の (b)、P3-X-C2・C3）。
  it("P3-C12-T14 contractBoundary / AC16: restore, shutdown, counterpart cancel and aliased follow-ups move deadlines and generations", () => {
    const generation = (state: BriefingUnitState) => state.persistence.currentGeneration;
    const held = send(emptyState(), F.oa1).state;
    const paired = send(held, F.k1, undefined, T0 + 7).state;
    const restoreAt = (state: BriefingUnitState, now: number) => reduceBriefingUnit({ ...emptyState(), persistence: state.persistence },
      { kind: "restore", persisted: briefingUnitCodec.encode(state), clock: clock(now) });
    const lapsed = tick(paired, T0 + SHORT).state;
    // intent の期限を過ぎた後の alias の組（nextDeadline を記録と新しい intent だけで決める）。
    const quiet = tick(paired, T0 + 200_000).state;
    const rows: [string, BriefingUnitState, BriefingUnitStep, Readonly<{ p: string | null; deadline: number | null; advanced: boolean }>][] = [
      ["restore before holdUntil", held, restoreAt(held, T0 + 1_000), { p: "released", deadline: T0 + SHORT, advanced: true }],
      ["restore after holdUntil", held, restoreAt(held, T0 + 120_000), { p: "released", deadline: T0 + SHORT, advanced: true }],
      ["restore after retainUntil", held, restoreAt(held, T0 + SHORT), { p: null, deadline: null, advanced: true }],
      ["restore without held", tick(paired, T0 + 200_000).state, restoreAt(tick(paired, T0 + 200_000).state, T0 + 201_000),
        { p: "aliased", deadline: T0 + SHORT, advanced: false }],
      ["shutdown", held, reduceBriefingUnit(held, { kind: "shutdown", clock: clock(T0 + 1_000) }), { p: "released", deadline: T0 + SHORT, advanced: true }],
      ["counterpart cancel", quiet, send(quiet, F.k1, cancelOf("2"), T0 + 201_000), { p: "released", deadline: T0 + 261_000, advanced: true }],
      ["counterpart cancel after the released lifetime", quiet, send(quiet, F.k1, cancelOf("2"), T0 + SHORT),
        { p: null, deadline: T0 + SHORT + 60_000, advanced: true }],
      ["aliased follow-up without the counterpart", lapsed, send(lapsed, F.oa2, undefined, T0 + SHORT + 60_000),
        { p: "held", deadline: T0 + SHORT + 120_000, advanced: true }],
    ];
    for (const [name, before, step, expected] of rows) {
      const deadlines = [...step.state.currents.map((item) => item.effective === "held" ? Math.min(item.retainUntil, item.holdUntil) : item.retainUntil),
        ...step.state.intents.map((item) => item.expiresAt)];
      expect([effective(step.state, P), step.nextDeadline?.wallTimeMs ?? null, generation(step.state) > generation(before),
        roundTrip(step.state).kind, step.intents.filter((item) => item.subject === P)], name).toEqual([expected.p, expected.deadline, expected.advanced,
        "restored", []]);
      expect(step.nextDeadline?.wallTimeMs ?? null, name).toBe(deadlines.length === 0 ? null : Math.min(...deadlines));
    }
    // released にした記録は restore の displayChanges に出る。
    expect(restoreAt(held, T0 + 1_000).displayChanges.map((item) => [item.subject, item.after?.unit === "U-B" ? item.after.current?.effective : null])).toEqual([[P, "released"]]);
  });

  // acceptance: 作者裁定 LATE-INVERSION=A・REPLACE-PENDING=A・EVICT-PROTECT=A の受入（AC17、各 1 行）。
  it("P3-C12-T15 acceptance / AC17: late inversion, pending withdrawal on replacement and eviction that changes no other subject", () => {
    const t = at("2026-08-27T04:48:00+09:00");
    const late = (xml: string) => serial("2")(retime("2026-08-27T05:18:00+09:00")(xml));
    const withoutTags = (xml: string) => xml.replace(/<Information type="情報タグ">[\s\S]*?<\/Information>/, "");
    // LATE-INVERSION: 予測だけの報（3 時間）を t+2h44m で受け、60 秒後に items の空の新しい版（t+30 分、2 時間）を受けると前の記録が消える。
    const forecast = send(send(emptyState(), F.yjpna, undefined, t + 164 * 60_000).state, F.yjpnb, undefined, t + 164 * 60_000);
    expect(pending(forecast.state, KANAZAWA_Y)).toHaveLength(2);
    const inverted = send(forecast.state, F.yjpnb, (xml) => late(withoutTags(xml)), t + 165 * 60_000);
    expect([effective(inverted.state, KANAZAWA_Y), inverted.intents, pending(inverted.state, KANAZAWA_Y), shape(inverted), inverted.decisions[0],
      inverted.outcomes, inverted.state.persistence.currentGeneration - forecast.state.persistence.currentGeneration]).toEqual([null, [], [],
      [[KANAZAWA_Y, "changed", "semantic"]], expect.objectContaining({ currentEstablished: null }), [{ kind: "accepted", change: "semantic", subjects: [] }], 1]);
    // 前の記録が取消の記憶なら unchanged/stale で記憶は残る。新しい版が発生を含んでも、他の subject の予測は区域を除かれない。
    const memory = send(emptyState(), F.yjpnb, cancelOf("1"), t + 164 * 60_000);
    const kept = send(memory.state, F.yjpnb, (xml) => late(withoutTags(xml)), t + 165 * 60_000);
    expect([shape(kept), effective(kept.state, KANAZAWA_Y)]).toEqual([[[KANAZAWA_Y, "unchanged", "stale"]], "cancelled"]);
    const observed = send(forecast.state, F.yjpnb, (xml) => late(tags([{ condition: "線状降水帯発生", areas: [{ code: "160010" }] }])(xml)), t + 165 * 60_000);
    expect([effective(observed.state, KANAZAWA_Y), areasOf(recordOf(observed.state, "normal/VPBS50/YJPNA202608270448"))]).toEqual([null,
      [["linearRainPredicted", ["160010", "160020"]]]]);
    // REPLACE-PENDING: 予測（pending）の 30 秒後に同じ区域を全部覆う発生 → replaced で pending 0。一部の区域だけなら active のまま pending も残る。
    const predicted = send(emptyState(), F.yjpnb, undefined, t);
    const covered = send(predicted.state, F.hjpnb, undefined, t + 30_000);
    expect([effective(covered.state, KANAZAWA_Y), pending(covered.state, KANAZAWA_Y)]).toEqual(["replaced", []]);
    const two = send(emptyState(), F.yjpnb, tags([{ condition: "線状降水帯直前", areas: [{ code: "170010" }, { code: "170020" }] }]), t);
    const partial = send(two.state, F.hjpnb, tags([{ condition: "線状降水帯発生", areas: [{ code: "170020" }] }]), t + 30_000);
    expect([areasOf(recordOf(partial.state, KANAZAWA_Y)), pending(partial.state, KANAZAWA_Y)]).toEqual([[["linearRainPredicted", ["170010"]]],
      pending(two.state, KANAZAWA_Y)]);
    // 自分の系列の予測の続報が全区域を除かれて replaced として採られ前の版が active なら、changed/semantic でその subject の pending は 0（D-WITHDRAW=A）。
    const first = send(partial.state, F.yjpnb, (xml) => serial("2")(retime("2026-08-27T04:50:00+09:00")(tags([{ condition: "線状降水帯直前",
      areas: [{ code: "170010" }] }])(xml))), t + 60_000);
    const own = send(first.state, F.yjpnb, (xml) => serial("3")(retime("2026-08-27T04:58:00+09:00")(xml)), t + 90_000);
    expect([effective(own.state, KANAZAWA_Y), shape(own), own.intents, pending(own.state, KANAZAWA_Y)]).toEqual(["replaced",
      [[KANAZAWA_Y, "changed", "semantic"]], [], []]);
    // EVICT-PROTECT: normal で満杯の state で対応報（期限を過ぎた K 系列）を退去しても、aliased の VPOA50 は aliased のまま。
    const now = T0 + SHORT + 1_000;
    const paired = send(send(emptyState(), F.oa1).state, F.k1, undefined, T0 + 7).state;
    const seed = recordOf(paired)!;
    const full = filled([...paired.currents, ...Array.from({ length: 254 }, (_, index) => subjectRecord(seed, now, index))]);
    const evicting = receive(full, decodeFixture(F.k1, (xml) => eventId("N1")(retime(iso(now))(xml))), clock(now));
    expect([effective(evicting.state), effective(evicting.state, P), evicting.state.currents.length]).toEqual([null, "aliased", 256]);
  });
});

function filled(values: readonly BriefingCurrent[]): BriefingUnitState {
  return { ...emptyState(), currents: values };
}
// 満杯の試験の記録（KJPTK の Serial 1 の事実を持つ VPBS50 の active か、取消の記憶）。報の時刻は now の数分前で retainUntil の内側。
function subjectRecord(seed: BriefingCurrent, now: number, index: number,
  patch: Partial<{ operation: Operation; retainUntil: number; memory: boolean }> = {}): BriefingCurrent {
  const operation = patch.operation ?? "normal", series = `S${String(index).padStart(3, "0")}`, subject = `${operation}/VPBS50/${series}`;
  const reported = now - (600 - index) * 1_000;
  const source = { ...seed.source, operation, subject, reportDateTimeRaw: iso(reported) };
  const base = { subject, operation, headType: "VPBS50" as const, series, source };
  return patch.memory ? { ...base, retainUntil: reported + LONG, effective: "cancelled" }
    : seed.effective === "active" ? { ...seed, ...base, retainUntil: patch.retainUntil ?? reported + SHORT } : seed;
}
// I-U-B.capacityReserve の上界の形の記録: 制御文字と孤立したサロゲートを拒むので文字列は 1 単位 3 byte、系列は 40 文字の「\」、
// ReportDateTime は A1 の形の 40 文字、InfoType は trim で消える U+000B 6 個＋2 文字、inputId 64 文字、operation は training。
function boundRecord(headType: "VPBS50" | "VPOA50", index: number): BriefingCurrent {
  const kanji = (length: number) => "雨".repeat(length);
  const series = `${"\\".repeat(36)}${String(index).padStart(4, "0")}`, subject = `training/${headType}/${series}`;
  const reportDateTimeRaw = "9999-12-31T23:59:59.99999999999999-23:59";
  const source = { inputId: "i".repeat(64), origin: "replay" as const, operation: "training" as const, family: headType, subject, reportDateTimeRaw,
    serialRaw: "1234567890", infoTypeRaw: `${"\u000b".repeat(6)}訂正` };
  const text = { title: kanji(64), headline: kanji(192), editorialOffice: kanji(16), truncated: true };
  const areas = (count: number, from: number) => Array.from({ length: count }, (_, at) => ({ code: String(10_000_000 + from + at), name: kanji(16) }));
  if (headType === "VPOA50") return { subject, operation: "training", headType, series, source, retainUntil: Date.parse(reportDateTimeRaw) + SHORT,
    effective: "held", holdUntil: -1.2345678901234567e-300, ...text, areas: areas(16, 0) };
  return { subject, operation: "training", headType, series, source, retainUntil: Date.parse(reportDateTimeRaw) + SHORT, effective: "active", ...text,
    items: Array.from({ length: 4 }, (_, at) => ({ kind: "unknown" as const, condition: kanji(16), areas: areas(4, at * 4) })),
    observations: Array.from({ length: 8 }, (_, at) => ({ part: "precipitation" as const, areaCode: String(10_000_000 + at), areaName: kanji(16),
      label: kanji(16), value: -123456.789, unit: kanji(8), approximation: "atLeast" as const, time: "2026-08-22T17:00:00+09:00" })) };
}
// I-U-B.capacityMeasurement の同時最大状態: 実配信の最大の記録の形（82_01_01、区域 3・観測 3）を 256 subject に置き、上界は 256 subject を
// 上限の長さの記録で満たす。どちらも pending と終端記録を byte の上限まで詰める。
function budgetState(bounded: boolean): BriefingUnitState {
  const sample = send(emptyState(), F.sample).state.currents[0];
  const currents = Array.from({ length: 256 }, (_, index): BriefingCurrent => {
    if (bounded) return boundRecord("VPBS50", index);
    const series = `JPTE${String(index).padStart(12, "0")}`, subject = `normal/VPBS50/${series}`;
    return { ...sample, subject, series, source: { ...sample.source, subject, inputId: "i".repeat(36) } };
  });
  const intentBase = send(emptyState(), F.k1).intents[0];
  const sized = (index: number, disposition: BriefingIntent["disposition"]): BriefingIntent => ({ ...intentBase, id: `${intentBase.id}:${index}`,
    disposition, createdAt: T0, expiresAt: T0 + 180_000 });
  const bytes = (item: BriefingIntent) => Buffer.byteLength(JSON.stringify(item));
  const pendingIntents: BriefingIntent[] = [];
  let size = 2;
  for (let index = 0; pendingIntents.length < 128; index++) {
    const item = sized(index, "pending"), width = bytes(item) + (pendingIntents.length === 0 ? 0 : 1) + deliveryGrowth(item);
    if (size + width > 131_072) break;
    pendingIntents.push(item);
    size += width;
  }
  // 終端記録は配送の更新で終端にした記録を含めて「pending の実 byte＋予約＋終端記録」229,376 byte まで。
  const terminal: BriefingIntent[] = [];
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
