import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { expectRestoreStarted } from "../notice-ledger/notice-fixture";
import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type { LocalBulletinsUnitState, LocalBulletinsUnitStep } from "../../contracts/p3-local-bulletins-unit.types";
import { noticeMarkBytes } from "../../src/units/notice-mark";
import { generationBytes, localBulletinsUnitCodec, reduceLocalBulletinsUnit, toLocalBulletinsView } from "../../src/units/local-bulletins/local-bulletins-unit";
import { deliveryGrowth as reserve } from "../../src/notification-delivery/delivery-growth";
import { linkedRuntimeCalls, linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { classifyHeadType, placeOfHeadType } from "../../src/runtime/unit-coverage";
import {
  bulkReports, clock, compose, control, decodeFixture, decodeXml, emptyState, eventId, fixtureXml, headTitle, infoType, iso, office, receive, replaceTag, retime, send, serial, status, tick,
} from "./local-bulletins-fixture";

// P3-UNIT-M-001 の unit 試験（T01〜T08・T12〜T14）。続報と Q-LIMIT の境界入力は fixture を焼かずに試験内で作る。

const TOKYO = "normal/tornado/気象庁本庁/東京都竜巻注意情報", NAGASAKI = "normal/tornado/長崎地方気象台/長崎県竜巻注意情報";
const T50 = "19_01_01_091210_VPHW50", N50 = "19_03_01_130906_VPHW50", T51 = "19_04_01_140425_VPHW51", HEAT = "57_03_01_240401_VPFT50";
const HEAT_SUBJECT = "normal/VPFT50/JPTC240001";
const records = (state: LocalBulletinsUnitState) => [...state.tornado, ...state.heat, ...state.transient];
const recordOf = (state: LocalBulletinsUnitState, subject: string) => records(state).find((item) => item.subject === subject);
const evictions = (step: LocalBulletinsUnitStep) => step.diagnostics.filter((item) => item.reason === "localBulletinsCapacityEvicted");
const pendingOf = (state: LocalBulletinsUnitState, subject: string) => state.intents.filter((item) => item.subject === subject && item.disposition === "pending");
const reasonOf = (step: LocalBulletinsUnitStep) => {
  const made = step.decisions[0];
  return made.decision === "changed" ? "changed" : made.reason;
};
const ms = (value: string) => Date.parse(value);
const hours = (count: number) => count * 3_600_000;
// 報の時刻と受信の時計を揃えて送る（decodeFixture の headType を指定できる）。
function sendAs(state: LocalBulletinsUnitState, name: string, headType: string, transform?: (xml: string) => string, now?: number): LocalBulletinsUnitStep {
  const material = decodeFixture(name, transform, undefined, headType);
  return receive(state, material, clock(now ?? Date.parse(material.reportDateTimeRaw)));
}
// 続報の時刻は報の時刻へ寄せる。
const at = (time: string) => retime(time);
const areaItem = (code: string, name: string) => `<Item><Kind><Name>竜巻注意情報</Name><Code>1</Code><Condition>発表</Condition></Kind>`
  + `<Areas codeType="気象情報／府県予報区・細分区域等"><Area><Name>${name}</Name><Code>${code}</Code></Area></Areas></Item>`;
const noneItem = (code: string, name: string) => `<Item><Kind><Name>なし</Name><Code>0</Code><Condition>なし</Condition></Kind>`
  + `<Areas codeType="気象情報／府県予報区・細分区域等"><Area><Name>${name}</Name><Code>${code}</Code></Area></Areas></Item>`;
// Headline の Information を差し替える（層ごとの item の列）。
const INFOS = /(<Headline>\s*<Text>[\s\S]*?<\/Text>)[\s\S]*?(<\/Headline>)/;
const infos = (layers: Readonly<Record<string, string>>) => (xml: string) => xml.replace(INFOS, (_all, head: string, tail: string) =>
  `${head}${Object.entries(layers).map(([type, body]) => `<Information type="${type}">${body}</Information>`).join("")}${tail}`);
const MUNICIPALITY = "竜巻注意情報（市町村等）";

// 容量の試験用の入力: 同じ報の題名と時刻だけを変えた n 番目の報（時刻の順に古い）。
const T0 = ms("2013-07-26T09:20:00+09:00");
const tornadoN = (index: number, base = T0) => compose(headTitle(`第${String(index).padStart(3, "0")}府県竜巻注意情報`), at(iso(base + index * 60_000)),
  replaceTag("ValidDateTime", "2013-07-27T00:00:00+09:00"));
const heatN = (index: number) => compose(eventId(`JPTC24${String(index).padStart(4, "0")}`), at(iso(ms("2024-08-11T05:00:00+09:00") + index * 60_000)),
  replaceTag("TargetDateTime", "2024-08-11T05:00:00+09:00"));
const explanationN = (index: number) => compose(eventId(`JPTK23${String(index).padStart(4, "0")}`), at(iso(ms("2023-09-07T17:03:00+09:00") + index * 60_000)));

describe("P3-UNIT-M-001 U-M reducer", () => {
  // contractBoundary: Q-ENUM の順で最初の一 reason だけを返し、state の参照が変わらない。
  it("P3-C13-T01 contractBoundary / AC01: first reason only with the state reference unchanged, a legal empty cancel and the U-M route", () => {
    const base = emptyState();
    const long = (count: number) => "あ".repeat(count);
    const cases: readonly [label: string, name: string, transform: (xml: string) => string, reason: string][] = [
      ["office missing (heat)", HEAT, office(""), "requiredStructureMissing"],
      ["office 25 units (heat)", HEAT, office(long(25)), "requiredStructureInvalid"],
      ["office control (heat)", HEAT, office("熊谷\t気象台"), "requiredStructureInvalid"],
      ["office missing (tornado)", N50, office(""), "identityMissing"],
      ["office slash (tornado)", N50, office("長崎/気象台"), "identityInvalid"],
      ["office 25 units (tornado)", N50, office(long(25)), "identityInvalid"],
      ["EventID missing", HEAT, eventId(""), "identityMissing"],
      ["EventID 65 units", HEAT, eventId("A".repeat(65)), "identityInvalid"],
      ["EventID control", HEAT, eventId("JP\tTC1"), "identityInvalid"],
      ["Serial not digits", HEAT, serial("1a"), "identityInvalid"],
      ["Serial 11 digits", HEAT, serial("12345678901"), "identityInvalid"],
      ["ReportDateTime raw 50 chars", HEAT, at("2024-08-11T05:00:00.1234567890123456789012345+09:00"), "identityInvalid"],
      ["Head/Title missing (heat)", HEAT, (xml) => xml.replace(/(<Head[^>]*>\s*)<Title>[^<]*<\/Title>/, "$1"), "requiredStructureMissing"],
      ["Head/Title missing (tornado)", N50, (xml) => xml.replace(/(<Head[^>]*>\s*)<Title>[^<]*<\/Title>/, "$1"), "identityMissing"],
      ["Head/Title 65 units (tornado)", N50, headTitle(long(65)), "identityInvalid"],
      ["InfoType outside the vocabulary", HEAT, infoType("速報"), "requiredStructureInvalid"],
      ["heat TargetDateTime missing", HEAT, (xml) => xml.replace(/<TargetDateTime>[^<]*<\/TargetDateTime>/, ""), "requiredStructureMissing"],
      ["heat TargetDateTime not a time", HEAT, replaceTag("TargetDateTime", "未定"), "requiredStructureInvalid"],
      ["tornado Kind 0", N50, infos({ [MUNICIPALITY]: "<Item><Areas><Area><Name>市</Name><Code>1</Code></Area></Areas></Item>" }), "requiredStructureInvalid"],
      ["tornado Area/Code not digits", N50, infos({ [MUNICIPALITY]: areaItem("42x", "市") }), "requiredStructureInvalid"],
      ["tornado name control", N50, infos({ [MUNICIPALITY]: areaItem("420", "市\t町") }), "requiredStructureInvalid"],
      ["tornado ValidDateTime not a time", N50, replaceTag("ValidDateTime", "夕方"), "requiredStructureInvalid"],
      ["VPAW51 TargetArea/Code missing", "72_01_01_190327_VPAW51", (xml) => xml.replace(/(<TargetArea[^>]*>[\s\S]*?)<Code>[^<]*<\/Code>/, "$1"), "identityMissing"],
      ["VPAW51 TargetArea/Code not digits", "72_01_01_190327_VPAW51", (xml) => xml.replace(/(<TargetArea[^>]*>[\s\S]*?<Code>)[^<]*(<\/Code>)/, "$1ab$2"), "identityInvalid"],
      ["transient Area/Code not digits", "85_01_01_250630_VPFJ51", (xml) => xml.replace(/<Code>130010<\/Code>/, "<Code>13a</Code>"), "requiredStructureInvalid"],
    ];
    for (const [label, name, transform, reason] of cases) {
      const step = send(base, name, transform);
      expect([label, reasonOf(step)], label).toEqual([label, reason]);
      expect(step.state, label).toBe(base);
      expect(step.intents, label).toEqual([]);
    }
    // inputId の 65 文字と「"」は identityInvalid。
    for (const inputId of ["a".repeat(65), 'quote"id']) {
      const step = receive(base, decodeFixture(HEAT, undefined, inputId), clock(ms("2024-08-11T05:00:00+09:00")));
      expect([inputId, reasonOf(step)]).toEqual([inputId, "identityInvalid"]);
    }
    // Head の無い報は headMissing、Headline・Body の無い取消は採用（記憶だけの取消）。
    expect(reasonOf(send(base, "synthetic/vpfj51_no_head"))).toBe("headMissing");
    expect(send(base, "synthetic_VPCI50_cancel").decisions[0]).toMatchObject({ decision: "changed", change: "revisionOnly" });
    // coverage 表と実行場所: 15 型は ready＋U-M、VXWW50 は ignored、VPNO50 は U-W のまま、U-M は deferred。
    const types = ["VXSE56", "VXSE60", "VZSE40", "VPZJ51", "VPCJ51", "VPFJ51", "VMCJ53", "VMCJ54", "VMCJ55", "VPZI50", "VPCI50", "VPAW51", "VPHW50", "VPHW51", "VPFT50"];
    expect(types.map((type) => classifyHeadType(type))).toEqual(types.map(() => ({ status: "ready", unit: "U-M" })));
    expect([classifyHeadType("VXWW50").status, classifyHeadType("VPNO50")]).toEqual(["ignored", { status: "ready", unit: "U-W" }]);
    expect(placeOfHeadType("VPHW50")).toBe("deferred");
    expect(linkedUnitTable["U-M"].unit).toBe("U-M");
    expect(linkedRuntimeCalls.units["U-M"]).toBe(linkedUnitTable["U-M"]);
    expect(linkedUnitCodecs["U-M"]).toBe(localBulletinsUnitCodec);
  });

  // acceptance: 竜巻（P3-C13-TORNADO-SUBJECT・PAIR・FACTS・EXPIRY）。
  it("P3-C13-T02 acceptance / AC02: tornado subjects, the same-version pair, facts, expiry and operation separation", () => {
    // 事実: 東京都 VPHW50（区域 60）・長崎県 VPHW50（区域 40）・東京都 VPHW51（sighted、目撃の層 1、区域 61）。
    const tokyo = send(emptyState(), T50).state, nagasaki = send(emptyState(), N50).state, sighted = send(emptyState(), T51).state;
    expect([tokyo, nagasaki, sighted].map((state) => state.tornado[0])).toMatchObject([
      { subject: TOKYO, effective: "active", sighted: false, editorialOffice: "気象庁本庁", retainUntil: ms("2009-08-10T07:38:00+09:00") + hours(36),
        activeUntil: ms("2009-08-10T08:40:00+09:00") },
      { subject: NAGASAKI, effective: "active", sighted: false, activeUntil: ms("2013-07-26T10:30:00+09:00") },
      { subject: TOKYO, effective: "active", sighted: true }]);
    expect([tokyo, nagasaki, sighted].map((state) => state.tornado[0].effective === "active" ? state.tornado[0].areas.length : -1)).toEqual([60, 40, 61]);
    const sightingLayer = sighted.tornado[0].effective === "active" ? sighted.tornado[0].areas.filter((area) => area.layer === "sighting") : [];
    expect(sightingLayer).toHaveLength(1);
    // 通知の本文の区域の数は最も細かい層（長崎は市町村等の 24）、ValidDateTime の無い報は有効期限を出さない。
    expect(send(emptyState(), N50).intents.map((item) => item.payload.body)).toEqual(["発表中 24地域 / 有効期限 10:30", "発表中 24地域 / 有効期限 10:30"]);
    expect(send(emptyState(), N50, (xml) => xml.replace(/<ValidDateTime>[^<]*<\/ValidDateTime>/, "")).intents[0].payload.body).toBe("発表中 24地域");

    // 同じ版の対（P3-C13-TORNADO-PAIR=A）: 50→51 は 51 の事実へ置き換え・食い違いの診断 0、51→50 は 50 が stale。目撃の無い 50 の後に目撃の 51 が
    // 来たら warning を channel ごとに作り、50 の pending を置き換える（P3-EF-AC07 (4)）。
    const same51 = (xml: string) => retime("2009-08-10T07:38:00+09:00")(xml);
    const first50 = send(emptyState(), T50);
    const then51 = sendAs(first50.state, T51, "VPHW51", compose(same51, serial("2"), (xml) => xml.replace(/<ValidDateTime>[^<]*<\/ValidDateTime>/, "<ValidDateTime>2009-08-10T08:40:00+09:00</ValidDateTime>")));
    expect(then51.decisions[0]).toMatchObject({ decision: "changed", change: "semantic" });
    expect([then51.intents.map((item) => [item.channel, item.payload.level]), then51.diagnostics, pendingOf(then51.state, TOKYO).length])
      .toEqual([[["desktop", "warning"], ["sound", "warning"]], [], 2]);
    expect(recordOf(then51.state, TOKYO)).toMatchObject({ sighted: true, source: { family: "VPHW51" } });
    const reverse = sendAs(then51.state, T50, "VPHW50", compose(same51, serial("2")));
    expect([reasonOf(reverse), reverse.diagnostics, reverse.state]).toEqual(["stale", [], then51.state]);
    // 取消の対: 50→51 は 50 の取消の通知が残り（撤回せず）1 件、51 の取消の後着は通知を作らない。51→50 は 51 の取消の通知 1 件で 50 は stale。
    const cancel50 = sendAs(first50.state, "synthetic_VPHW50_tokyo_cancel", "VPHW50", compose(same51, serial("2")));
    const cancel51 = sendAs(cancel50.state, "synthetic_VPHW50_tokyo_cancel", "VPHW51", compose(same51, serial("2")));
    expect([cancel50.intents.map((item) => item.payload.level), cancel51.intents, cancel51.decisions[0].decision]).toEqual([["cancel", "cancel"], [], "changed"]);
    expect(pendingOf(cancel51.state, TOKYO).map((item) => item.transition)).toEqual(["cancelled", "cancelled"]);
    const first51 = sendAs(emptyState(), T51, "VPHW51", compose(same51, serial("2")));
    const cancelBoth = sendAs(first51.state, "synthetic_VPHW50_tokyo_cancel", "VPHW51", compose(same51, serial("2")));
    const lateCancel50 = sendAs(cancelBoth.state, "synthetic_VPHW50_tokyo_cancel", "VPHW50", compose(same51, serial("2")));
    expect([cancelBoth.intents.length, reasonOf(lateCancel50)]).toEqual([2, "stale"]);
    // 訂正の対: 両方の順で訂正の通知 1 件（channel ごと）。訂正は後の Control/DateTime（同じ時刻なら未確認の印、P3-VM-AC03）で、対の判定は
    // Head/ReportDateTime・Serial・InfoType（Control/DateTime を見ない、P3-VM-D-SAME-REPORT=A）。
    const correct = (type: string) => compose(same51, control("2009-08-10T07:39:00+09:00"), serial("3"), infoType("訂正"), (xml: string) => xml + `<!-- ${type} -->`);
    const c50 = sendAs(first50.state, T50, "VPHW50", correct("a")), c51 = sendAs(c50.state, T51, "VPHW51", correct("b"));
    expect([c50.intents.length, c51.intents.length]).toEqual([2, 2]);
    const d51 = sendAs(first51.state, T51, "VPHW51", correct("c")), d50 = sendAs(d51.state, T50, "VPHW50", correct("d"));
    expect([d51.intents.length, reasonOf(d50)]).toEqual([2, "stale"]);

    // Serial が戻った新しい時刻の報は採る。Title の書式が変わった報は別の subject（前の記録は有効期限で消える）。
    const back = send(send(emptyState(), N50, serial("2")).state, N50, compose(serial("1"), at("2013-07-26T09:50:00+09:00"),
      replaceTag("ValidDateTime", "2013-07-26T11:00:00+09:00")));
    expect(back.decisions[0]).toMatchObject({ decision: "changed" });
    const renamed = send(send(emptyState(), N50).state, N50, compose(headTitle("長崎県気象防災速報（竜巻注意）"), at("2013-07-26T09:40:00+09:00"),
      replaceTag("ValidDateTime", "2013-07-26T11:30:00+09:00")));
    expect(renamed.state.tornado.map((item) => item.subject)).toEqual([NAGASAKI, "normal/tornado/長崎地方気象台/長崎県気象防災速報（竜巻注意）"]);
    expect(tick(renamed.state, ms("2013-07-26T10:30:00+09:00")).state.tornado.map((item) => item.effective)).toEqual(["expired", "active"]);
    // 気象庁本庁の伊豆諸島の 3 つの Title は別の記録、同じ官署の別の府県予報区の題名も別の記録。
    let island = emptyState();
    for (const title of ["東京都（伊豆諸島北部）竜巻注意情報", "東京都（伊豆諸島南部）竜巻注意情報", "東京都（伊豆諸島）竜巻注意情報", "神奈川県竜巻注意情報"])
      island = send(island, T50, headTitle(title)).state;
    expect(island.tornado).toHaveLength(4);

    // 解除: Headline に竜巻の Information が無く Body/Warning が全部なしの報は ended（info）。Body に active があれば active（Body の層から区域）、
    // どちらにも Item が無ければ拒否。
    const release = send(first50.state, "synthetic_VPHW50_tokyo_release", at("2009-08-10T07:50:00+09:00"));
    expect([recordOf(release.state, TOKYO)?.effective, release.intents.map((item) => item.payload.level)]).toEqual(["ended", ["info", "info"]]);
    const bodyActive = send(emptyState(), "synthetic_VPHW50_tokyo_release", (xml) => xml.replace(/<Name>なし<\/Name>\s*<Code>0<\/Code>\s*<Status>なし<\/Status>/,
      "<Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status>"));
    expect(recordOf(bodyActive.state, TOKYO)).toMatchObject({ effective: "active", sighted: false, areas: [{ layer: "announcement", code: "130010" }] });
    expect(reasonOf(send(emptyState(), "synthetic_VPHW50_tokyo_empty"))).toBe("requiredStructureMissing");
    // 表に無い層だけに active がある報は active で区域を持たず truncated。
    const unknown = send(emptyState(), N50, infos({ "竜巻注意情報（新しい層）": areaItem("420", "長崎県") }));
    expect(recordOf(unknown.state, NAGASAKI)).toMatchObject({ effective: "active", areas: [], truncated: true });
    // 区域が全部なしでも ValidDateTime が ReportDateTime 以前の報は拒否しない（ended）。
    const pastValid = send(emptyState(), N50, compose(infos({ [MUNICIPALITY]: noneItem("420", "市") }), replaceTag("ValidDateTime", "2013-07-26T09:00:00+09:00")));
    expect(recordOf(pastValid.state, NAGASAKI)?.effective).toBe("ended");

    // 区域 129 の報は 128 に切り、通知の本文の数は切る前（129）。ValidDateTime が +36 時間を超える報は +36 時間に切り詰め、ReportDateTime 以前は拒否。
    const many = Array.from({ length: 129 }, (_, index) => areaItem(String(1000 + index), `市${index}`)).join("");
    const wide = send(emptyState(), N50, infos({ [MUNICIPALITY]: many }));
    expect(recordOf(wide.state, NAGASAKI)).toMatchObject({ truncated: true });
    expect([wide.state.tornado[0].effective === "active" ? wide.state.tornado[0].areas.length : 0, wide.intents[0].payload.body]).toEqual([128, "発表中 129地域 / 有効期限 10:30"]);
    const longValid = send(emptyState(), N50, replaceTag("ValidDateTime", "2013-07-30T09:20:00+09:00"));
    expect(recordOf(longValid.state, NAGASAKI)).toMatchObject({ activeUntil: ms("2013-07-26T09:20:00+09:00") + hours(36) });
    expect(reasonOf(send(emptyState(), N50, replaceTag("ValidDateTime", "2013-07-26T09:20:00+09:00")))).toBe("requiredStructureInvalid");
    // 有効期限の 1 ms 前は残り、到来で expired（無音、P3-EF-AC07 (1)）。ValidDateTime の無い報は +1 時間、記録は +36 時間で除く。
    const edge = send(emptyState(), N50).state;
    expect(tick(edge, ms("2013-07-26T10:30:00+09:00") - 1).state.tornado).toBe(edge.tornado);
    expect(tick(edge, ms("2013-07-26T10:30:00+09:00")).state.tornado[0].effective).toBe("expired");
    const noValid = send(emptyState(), N50, (xml) => xml.replace(/<ValidDateTime>[^<]*<\/ValidDateTime>/, "")).state;
    expect([tick(noValid, ms("2013-07-26T10:20:00+09:00") - 1).state.tornado[0].effective, tick(noValid, ms("2013-07-26T10:20:00+09:00")).state.tornado[0].effective]).toEqual(["active", "expired"]);
    expect(tick(edge, ms("2013-07-26T09:20:00+09:00") + hours(36)).state.tornado).toEqual([]);
    // activeUntil＝retainUntil（ValidDateTime が +36 時間以上）の active は、先に見えなくなる変化（changed/semantic・deadlineApplied）を出してから除く。
    const atRetain = tick(longValid.state, ms("2013-07-26T09:20:00+09:00") + hours(36));
    expect([atRetain.state.tornado, atRetain.decisions.map((item) => [item.subject, item.decision, "change" in item ? item.change : null]),
      atRetain.outcomes.map((item) => item.kind), atRetain.displayChanges.length]).toEqual([[], [[NAGASAKI, "changed", "semantic"]], ["deadlineApplied"], 1]);
    // sighted は headType で決めない: 目撃の層も見出しの印も無い VPHW51 は sighted=false。
    const noMark = sendAs(emptyState(), T51, "VPHW51", compose((xml) => xml.replace(/<Information type="竜巻注意情報（目撃情報あり）">[\s\S]*?<\/Information>/, ""),
      (xml) => xml.replace("【目撃情報あり】", "")));
    expect(noMark.state.tornado[0]).toMatchObject({ effective: "active", sighted: false, source: { family: "VPHW51" } });
    // 同じ版の対の後着が遅着 (2) でも、前の pending は撤回しない（P3-C13-TORNADO-PAIR=A）。
    const first = send(emptyState(), N50);
    const latePair = sendAs(first.state, N50, "VPHW51", replaceTag("ValidDateTime", "2013-07-26T09:30:00+09:00"), ms("2013-07-26T09:40:00+09:00"));
    expect([recordOf(latePair.state, NAGASAKI)?.effective, latePair.decisions[0].decision, latePair.intents, latePair.state.intents.filter((item) => item.disposition === "superseded")])
      .toEqual(["expired", "changed", [], []]);
    // Head/Headline の無い非取消の報は requiredStructureMissing。
    expect(reasonOf(send(emptyState(), N50, (xml) => xml.replace(/<Headline>[\s\S]*?<\/Headline>/, "")))).toBe("requiredStructureMissing");
    // Body/Warning の Item に Area が無くても拒否せず、その Item は区域を出さない（区域を 1 つも取れなければ areas 空・truncated）。Area の形の外は invalid。
    const noArea = (xml: string) => xml.replace(/<Name>なし<\/Name>\s*<Code>0<\/Code>\s*<Status>なし<\/Status>\s*<\/Kind>\s*<Area>[\s\S]*?<\/Area>/, "<Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status></Kind>");
    expect(send(emptyState(), "synthetic_VPHW50_tokyo_release", noArea).state.tornado[0]).toMatchObject({ effective: "active", areas: [], truncated: true });
    expect(reasonOf(send(emptyState(), "synthetic_VPHW50_tokyo_release", (xml) => xml.replace("<Code>130010</Code>", "<Code>13x</Code>").replace(/<Name>なし<\/Name>\s*<Code>0<\/Code>\s*<Status>なし<\/Status>/,
      "<Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status>")))).toBe("requiredStructureInvalid");
    // Headline に竜巻の Information があれば Item が 0 個でも Body は読まない（Item が無ければ requiredStructureMissing）。
    const emptyInformation = (xml: string) => xml.replace(/<Headline>\s*<Text \/>\s*<\/Headline>/, '<Headline><Text /><Information type="竜巻注意情報（発表細分）"></Information></Headline>')
      .replace(/<Name>なし<\/Name>\s*<Code>0<\/Code>\s*<Status>なし<\/Status>/, "<Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status>");
    expect(reasonOf(send(emptyState(), "synthetic_VPHW50_tokyo_release", emptyInformation))).toBe("requiredStructureMissing");
    // 運用区分: training に替えた同じ報は別の subject で、normal の記録と交差しない。
    const both = send(send(emptyState(), N50).state, N50, status("訓練"));
    expect(both.state.tornado.map((item) => [item.operation, item.subject])).toEqual([["normal", NAGASAKI], ["training", NAGASAKI.replace("normal", "training")]]);
    expect(both.intents.map((item) => item.channel)).toEqual(["desktop"]);
  });

  // acceptance: 熱中症（P3-C13-HEAT-SUBJECT・FACTS・EXPIRY）。
  it("P3-C13-T03 acceptance / AC03: heat facts, target day expiry, no special branch and the 48 hour window", () => {
    const active = send(emptyState(), HEAT);
    expect(active.state.heat[0]).toMatchObject({ subject: HEAT_SUBJECT, effective: "active", targetDate: "2024-08-11", areaName: "埼玉県",
      activeUntil: 1723388400000, retainUntil: ms("2024-08-11T05:00:00+09:00") + 3 * 24 * hours(1) });
    // 特別警戒を持たない: title_escalation は同じ版なので別の state でふつうの発表（areaName null）。同じ state では食い違いの stale で、
    // 先着を保って未確認の印を付ける（P3-VM-AC03・AC04）。
    expect(send(emptyState(), "synthetic_VPFT50_title_escalation").state.heat[0]).toMatchObject({ effective: "active", areaName: null });
    const conflict = send(active.state, "synthetic_VPFT50_title_escalation");
    const { unconfirmed: mark, ...held } = conflict.state.heat[0];
    expect([reasonOf(conflict), conflict.diagnostics.map((item) => item.reason), held, mark?.inputId]).toEqual(["stale", ["localBulletinsRevisionConflict"],
      active.state.heat[0], conflict.diagnostics[0]?.inputId]);
    // 本文の無い報は合法な発表、取消は cancelled（前が見えれば cancel の通知）。
    expect(send(emptyState(), "synthetic_VPFT50_no_body").state.heat[0].effective).toBe("active");
    const cancelled = send(active.state, "synthetic_VPFT50_cancel", retime("2024-08-11T05:30:00+09:00"));
    expect([cancelled.state.heat[0].effective, cancelled.intents.map((item) => item.payload.level)]).toEqual(["cancelled", ["cancel", "cancel"]]);
    // 対象日の終わりの 1 ms 前は残り、到来で ended（changed/semantic、通知 0）。時計を戻しても復活しない。+3 日で除く。
    const end = 1723388400000;
    expect(tick(active.state, end - 1).state.heat).toBe(active.state.heat);
    const ended = tick(active.state, end);
    expect([ended.state.heat[0].effective, ended.decisions, ended.intents, ended.displayChanges.length]).toEqual(["ended",
      [{ subject: HEAT_SUBJECT, operation: "normal", decision: "changed", reason: null, change: "semantic", currentEstablished: null }], [], 1]);
    expect(tick(ended.state, end - hours(1)).state).toBe(ended.state);
    expect(tick(ended.state, ms("2024-08-11T05:00:00+09:00") + 72 * hours(1)).state.heat).toEqual([]);
    // 実配信の形: 前日 17 時の第 1 号（TargetDateTime＝翌日 00:00）の対象日と通知の本文の日付は翌日で、当日 05:00 の報が同じ記録を置き換える。
    const evening = send(emptyState(), HEAT, compose(retime("2024-08-10T17:00:00+09:00"), replaceTag("TargetDateTime", "2024-08-11T00:00:00+09:00"), serial("1")));
    expect([evening.state.heat[0].effective === "active" ? evening.state.heat[0].targetDate : "", evening.intents[0].payload.body]).toEqual(["2024-08-11", "埼玉県 8月11日"]);
    const morning = send(evening.state, HEAT);
    expect([morning.state.heat.length, morning.state.heat[0].source.serialRaw, morning.intents]).toEqual([1, "2", []]);
    // P3-C13-HEAT-EXPIRY=A の式の境界: 対象日の終わりが ReportDateTime＋48 時間ちょうどは受け、+1 s と ReportDateTime 以前は拒否。
    const window = (report: string, target: string) => send(emptyState(), HEAT, compose(retime(report), replaceTag("TargetDateTime", target)));
    expect(reasonOf(window("2024-08-11T00:00:00+09:00", "2024-08-12T20:00:00+09:00"))).toBe("changed");
    expect(reasonOf(window("2024-08-10T23:59:59+09:00", "2024-08-12T20:00:00+09:00"))).toBe("requiredStructureInvalid");
    expect(reasonOf(window("2024-08-11T00:00:00+09:00", "2024-08-10T10:00:00+09:00"))).toBe("requiredStructureInvalid");
    // EditorialOffice の欠落した取消は拒否。64 単位を超える Title の地域名は切り詰めの前に引く。
    expect(reasonOf(send(emptyState(), "synthetic_VPFT50_cancel", office("")))).toBe("requiredStructureMissing");
    const longTitle = `${"北".repeat(70)}熱中症警戒アラート`;
    const cut = send(emptyState(), HEAT, headTitle(longTitle)).state.heat[0];
    expect(cut).toMatchObject({ effective: "active", areaName: "北".repeat(24), truncated: true });
    expect(cut.effective === "active" ? cut.title.length : 0).toBe(64);
    // Title は 64 単位以内で地域名だけが 24 単位を超えるときも truncated が立つ（地域名の切り詰め単独の境界）。
    const shortTitle = send(emptyState(), HEAT, headTitle(`${"北".repeat(30)}熱中症警戒アラート`)).state.heat[0];
    expect(shortTitle).toMatchObject({ effective: "active", areaName: "北".repeat(24), truncated: true });
    expect(shortTitle.effective === "active" ? shortTitle.title.length : 0).toBe(39);
    expect(send(emptyState(), HEAT, headTitle(`${"北".repeat(24)}熱中症警戒アラート`)).state.heat[0]).toMatchObject({ areaName: "北".repeat(24), truncated: false });
  });

  // acceptance: transient（P3-C13-TRANSIENT-FAMILIES・TTL・EVIDENCE）。
  it("P3-C13-T04 acceptance / AC04: transient families, subjects, visible time, memory length and evidence", () => {
    const representatives: readonly [string, string, string, number, readonly string[]][] = [
      ["32-35_09_01_191111_VXSE56", "seismicText", "normal/VXSE56/20191111170000", 0, []],
      ["selected_xml/42_01_01_100514_VZSE40", "seismicText", "normal/VZSE40/20091106160000", 0, []],
      ["72_01_01_190327_VPAW51", "earlyWeather", "normal/VPAW51/010200/高温に関する早期天候情報（東北地方）", 1, []],
      ["29_01_01_140129_VPZI50", "climateInfo", "normal/VPZI50/202401101600全般天候情報気象庁本庁", 1, []],
      ["30_01_01_100915_VPCI50", "climateInfo", "normal/VPCI50/200806021330地方天候情報気象庁", 1, []],
      ["83_01_01_250630_VPZJ51", "weatherExplanation", "normal/VPZJ51/JPTK240129", 2, ["線状降水帯予測"]],
      ["85_01_01_250630_VPFJ51", "weatherExplanation", "normal/VPFJ51/JPTK230120", 3, ["台風", "大雨", "落雷", "突風", "強風", "高波"]],
      ["89_01_01_250630_VMCJ55", "weatherExplanation", "normal/VMCJ55/JPSE230021", 2, ["副振動"]],
    ];
    for (const [name, family, subject, areas, tags] of representatives) {
      const found = send(emptyState(), name).state.transient[0];
      expect([name, found.family, found.subject, found.effective === "active" ? [found.areas.length, found.tags] : null], name).toEqual([name, family, subject, [areas, tags]]);
    }
    // VPFJ51 の Serial 6→10→13 は同じ記録の置き換え（題名の変わる続報は題名を置き換える）。接尾「_yyyymmddhhmm」の有無をまたいだ Serial の続き。
    let chain = send(emptyState(), "85(82)_02_01_250630_VPFJ51").state;
    for (const name of ["85(82)_02_04_260326_VPFJ51", "85(82)_02_07_260326_VPFJ51"]) chain = send(chain, name, undefined, ms("2024-01-24T16:49:00+09:00")).state;
    expect(chain.transient.map((item) => [item.subject, item.source.serialRaw])).toEqual([["normal/VPFJ51/JPNC240004", "13"]]);
    const suffixed = send(emptyState(), "85_01_01_250630_VPFJ51", compose(eventId("FJPGA260001_202601011200"), serial("7")));
    const plain = send(suffixed.state, "85_01_01_250630_VPFJ51", compose(eventId("FJPGA260001"), serial("8"), at("2023-09-07T17:30:00+09:00")), ms("2023-09-07T17:30:00+09:00"));
    expect(plain.state.transient.map((item) => [item.subject, item.source.serialRaw])).toEqual([["normal/VPFJ51/FJPGA260001", "8"]]);
    // VPAW51 の 72_01〜08 を同じ state に同じ時刻で流すと、全部が別の記録（食い違いで捨てない）。
    let early = emptyState();
    for (let index = 1; index <= 8; index++) early = send(early, `72_0${index}_01_190327_VPAW51`).state;
    expect(new Set(early.transient.map((item) => item.subject)).size).toBe(8);
    // 区域の Code・Name が欠けた Area は区域を出さず、報は拒否しない（区域の欠落は合法）。形の外は invalid（T01）。
    const partial = send(emptyState(), "85_01_01_250630_VPFJ51", (xml) => xml.replace("<Code>130010</Code>", ""));
    expect([reasonOf(partial), partial.state.transient[0].effective === "active" ? partial.state.transient[0].areas.map((area) => area.code) : null]).toEqual(["changed", ["130020", "130030"]]);
    // 見える記録は +3 時間で evidence（通知なし、保存世代を進めない、view から消える）。
    const first = send(emptyState(), "85_01_01_250630_VPFJ51").state;
    // 配送の期限（180 秒）の処理を先に済ませて、evidence への移行だけを測る。
    const shown = tick(first, ms("2023-09-07T17:03:00+09:00") + 181_000).state;
    expect(shown.intents).toEqual([]);
    const visibleEnd = ms("2023-09-07T17:03:00+09:00") + hours(3);
    expect(tick(shown, visibleEnd - 1).state.transient).toBe(shown.transient);
    const evidence = tick(shown, visibleEnd);
    expect([evidence.state.transient[0].effective, evidence.state.persistence.currentGeneration, evidence.intents, evidence.displayChanges.length,
      evidence.state.contentRevision]).toEqual(["evidence", shown.persistence.currentGeneration, [], 1, shown.contentRevision + 1]);
    // family の記憶の長さで除く（seismicText 36 h・weatherExplanation 36 h・earlyWeather 7 d・climateInfo 30 d）。
    const lengths: readonly [string, number][] = [["32-35_09_01_191111_VXSE56", 36 * hours(1)], ["85_01_01_250630_VPFJ51", 36 * hours(1)],
      ["72_01_01_190327_VPAW51", 7 * 24 * hours(1)], ["30_01_01_100915_VPCI50", 30 * 24 * hours(1)]];
    for (const [name, length] of lengths) {
      const state = send(emptyState(), name).state;
      const start = ms(state.transient[0].source.reportDateTimeRaw);
      expect([name, tick(state, start + length - 1).state.transient.length, tick(state, start + length).state.transient.length]).toEqual([name, 1, 0]);
    }
    // encode は active を evidence として書き、restore の後の同じ報は duplicate、取消より古い報は stale。
    const encoded = JSON.parse(JSON.stringify(localBulletinsUnitCodec.encode(shown))) as JsonValue;
    const decoded = localBulletinsUnitCodec.decode(encoded);
    expect(decoded.kind).toBe("restored");
    const restored = decoded.kind === "restored" ? decoded.state : emptyState();
    expect(restored.transient.map((item) => item.effective)).toEqual(["evidence"]);
    expect(reasonOf(send(restored, "85_01_01_250630_VPFJ51"))).toBe("duplicate");
    const older = compose(eventId("JPTK260001"), at("2026-06-06T08:00:00+09:00"));
    const cancelled = send(send(emptyState(), "85_01_01_250630_VPFJ51", older).state, "synthetic/vpfj51_cancel");
    expect(cancelled.state.transient.map((item) => item.effective)).toEqual(["cancelled"]);
    expect(reasonOf(send(cancelled.state, "85_01_01_250630_VPFJ51", older))).toBe("stale");
  });

  // acceptance: 版・取消・遅着（Q-ENUM.revisionOrder・P3-C13-CANCEL-SCOPE・P3-C13-RETENTION）。
  it("P3-C13-T05 acceptance / AC05: revision order, cancel scope and the late arrival rule", () => {
    const base = send(emptyState(), HEAT);
    // 同じ版の重複・食い違い（localBulletinsRevisionConflict）・訂正の採用。
    expect(reasonOf(send(base.state, HEAT))).toBe("duplicate");
    const correction = send(base.state, HEAT, compose(infoType("訂正"), replaceTag("Title", "x"), control("2024-08-11T05:01:00+09:00")));
    expect(correction.decisions[0]).toMatchObject({ decision: "changed" });
    expect(correction.intents.map((item) => [item.transition, item.payload.title, item.payload.body.startsWith("訂正: ")])).toEqual([
      ["updated", "[訂正] 埼玉県熱中症警戒アラート", true], ["updated", "[訂正] 埼玉県熱中症警戒アラート", true]]);
    // Serial は新旧に使わない（P3-VM-AC03）: 同じ Control/DateTime で Serial だけが違う報は、欠落と 1・9 と 10 のどちらの順でも同じ版の duplicate。
    const missing = send(emptyState(), "32-35_09_01_191111_VXSE56");
    expect(reasonOf(send(missing.state, "32-35_09_01_191111_VXSE56", serial("1")))).toBe("duplicate");
    expect(reasonOf(send(send(emptyState(), "32-35_09_01_191111_VXSE56", serial("1")).state, "32-35_09_01_191111_VXSE56"))).toBe("duplicate");
    expect(reasonOf(send(send(emptyState(), HEAT, serial("9")).state, HEAT, serial("10")))).toBe("duplicate");
    // 未確認の印は記録が state から消えるまで残る（P3-VM-AC04）: 印→保存→見える期限（証拠になる）→保存・復元のどこでも同じ印。
    const roundTrip = (state: LocalBulletinsUnitState) => {
      const decoded = localBulletinsUnitCodec.decode(JSON.parse(JSON.stringify(localBulletinsUnitCodec.encode(state))) as JsonValue);
      return decoded.kind === "restored" ? decoded.state : emptyState();
    };
    const marked = send(missing.state, "32-35_09_01_191111_VXSE56", (xml) => xml.replace(/<Text>([^<]*)<\/Text>/, "<Text>$1（別の本文）</Text>"));
    const visibleEnd = tick(marked.state, ms("2019-11-11T17:00:00+09:00") + hours(3)).state;
    expect([reasonOf(marked), roundTrip(marked.state).transient[0].unconfirmed?.inputId, visibleEnd.transient[0].effective,
      visibleEnd.transient[0].unconfirmed?.inputId, roundTrip(visibleEnd).transient[0].unconfirmed?.inputId]).toEqual(["stale",
      marked.diagnostics[0]?.inputId, "evidence", marked.diagnostics[0]?.inputId, marked.diagnostics[0]?.inputId]);
    // 実不具合の再発防止（K7 発注 2b のレビュー）: 同じ Head・Control/DateTime の訂正は、復元の前（見える記録）も後（証拠）も stale で印を付ける。
    const correct = (state: LocalBulletinsUnitState) => send(state, "32-35_09_01_191111_VXSE56", infoType("訂正"));
    const restored = reduceLocalBulletinsUnit(emptyState(), { kind: "restore", clock: clock(ms("2019-11-11T17:00:00+09:00")),
      persisted: localBulletinsUnitCodec.encode(missing.state) }).state;
    expect([missing.state, restored].map((state) => { const step = correct(state); return [reasonOf(step), step.state.transient[0].unconfirmed?.infoTypeRaw]; }))
      .toEqual([["stale", "訂正"], ["stale", "訂正"]]);
    // 取消は cancelled にして前の事実を戻さない。記録の無い subject への取消は記憶だけ（通知 0）。
    const memoryOnly = send(emptyState(), "32-35_09_02_220316_VXSE56");
    expect([memoryOnly.state.transient[0].effective, memoryOnly.intents, memoryOnly.decisions[0]]).toMatchObject(["cancelled", [], { decision: "changed", change: "revisionOnly" }]);
    expect(send(emptyState(), "selected_xml/42_03_01_220402_VZSE40").intents).toEqual([]);
    // 取消以前の報は stale で復活せず、取消より新しい報は activated。
    const old = send(emptyState(), "32-35_09_01_191111_VXSE56", compose(eventId("20220316133000"), at("2022-03-16T13:30:00+09:00")));
    const cancelled = send(old.state, "32-35_09_02_220316_VXSE56");
    expect(cancelled.state.transient.map((item) => item.effective)).toEqual(["cancelled"]);
    expect(reasonOf(send(cancelled.state, "32-35_09_01_191111_VXSE56", compose(eventId("20220316133000"), at("2022-03-16T13:30:00+09:00"))))).toBe("stale");
    const newer = send(cancelled.state, "32-35_09_01_191111_VXSE56", compose(eventId("20220316133000"), at("2022-03-16T13:50:00+09:00")));
    expect(newer.intents.map((item) => item.transition)).toEqual(["activated", "activated"]);

    // 遅着(1): 記憶の期限 +1 分の報は unchanged/stale で state の参照を変えない（退去も起こさない）。
    const lateMemory = receive(base.state, decodeFixture(HEAT, compose(eventId("JPTC240099"), retime("2024-08-11T04:00:00+09:00"), replaceTag("TargetDateTime", "2024-08-11T04:00:00+09:00"))),
      clock(ms("2024-08-11T04:00:00+09:00") + 3 * 24 * hours(1) + 60_000));
    expect([reasonOf(lateMemory), lateMemory.state]).toEqual(["stale", base.state]);
    // 遅着(2): 竜巻の有効期限の後・36 時間の内側の新しい版は期限切れの記憶としてだけ採り、前の active を expired にして pending を 0 にする
    // （changed/semantic、通知 0、P3-EF-AC05 (5)）。
    const nagasaki = send(emptyState(), N50);
    const late = compose(serial("2"), at("2013-07-26T10:35:00+09:00"), replaceTag("ValidDateTime", "2013-07-26T10:50:00+09:00"));
    const lateNew = receive(nagasaki.state, decodeFixture(N50, late), clock(ms("2013-07-26T10:55:00+09:00")));
    expect([recordOf(lateNew.state, NAGASAKI)?.effective, pendingOf(lateNew.state, NAGASAKI), lateNew.intents, lateNew.decisions[0]]).toMatchObject([
      "expired", [], [], { decision: "changed", change: "semantic" }]);
    expect(toLocalBulletinsView(lateNew.state).tornado).toEqual([]);
    expect(lateNew.displayChanges).toHaveLength(1);
    // 前が記憶（ended）なら revisionOnly。
    const ended = tick(nagasaki.state, ms("2013-07-26T10:30:00+09:00")).state;
    expect(receive(ended, decodeFixture(N50, late), clock(ms("2013-07-26T10:55:00+09:00"))).decisions[0]).toMatchObject({ decision: "changed", change: "revisionOnly" });
    // 遅着(3): 満杯の slice に記録の無い subject の遅着は unchanged/stale で、退去も自身の退去もしない。
    let full = emptyState();
    for (let index = 0; index < 128; index++) full = send(full, N50, tornadoN(index)).state;
    const lateFull = receive(full, decodeFixture(N50, compose(headTitle("遅れた府県竜巻注意情報"), at("2013-07-26T10:35:00+09:00"), replaceTag("ValidDateTime", "2013-07-26T10:50:00+09:00"))),
      clock(ms("2013-07-26T10:55:00+09:00")));
    expect([reasonOf(lateFull), lateFull.state, lateFull.diagnostics]).toEqual(["stale", full, []]);
    // 遅着 (2) は熱中症と transient でも同じ: 対象日の終わり／visibleUntil の後の続報は記憶（ended／evidence）としてだけ採り、前の active を終わらせて pending 0・通知 0。
    const heatFollow = receive(base.state, decodeFixture(HEAT, compose(serial("3"), retime("2024-08-11T05:30:00+09:00"), replaceTag("TargetDateTime", "2024-08-11T05:30:00+09:00"))),
      clock(ms("2024-08-12T00:10:00+09:00")));
    expect([heatFollow.state.heat[0].effective, pendingOf(heatFollow.state, HEAT_SUBJECT), heatFollow.intents, heatFollow.decisions[0]]).toMatchObject([
      "ended", [], [], { decision: "changed", change: "semantic" }]);
    const explanation = send(emptyState(), "85_01_01_250630_VPFJ51");
    const explanationFollow = receive(explanation.state, decodeFixture("85_01_01_250630_VPFJ51", compose(serial("8"), at("2023-09-07T17:10:00+09:00"))), clock(ms("2023-09-07T20:11:00+09:00")));
    expect([explanationFollow.state.transient[0].effective, pendingOf(explanationFollow.state, explanation.state.transient[0].subject), explanationFollow.intents,
      explanationFollow.decisions[0]]).toMatchObject(["evidence", [], [], { decision: "changed", change: "semantic" }]);
    // 官署だけが変わった新しい版は公開事実を変えない（revisionOnly・通知 0）。
    const officeOnly = send(base.state, HEAT, compose(office("別の気象台"), serial("3"), retime("2024-08-11T05:10:00+09:00"), replaceTag("TargetDateTime", "2024-08-11T05:00:00+09:00")));
    expect([officeOnly.decisions[0], officeOnly.intents]).toMatchObject([{ decision: "changed", change: "revisionOnly" }, []]);
    // 版の比較は遅着の判定より先: 記憶の期限の後に届く同じ版は stale でなく duplicate。
    const afterRetain = receive(base.state, decodeFixture(HEAT), clock(ms("2024-08-11T05:00:00+09:00") + 3 * 24 * hours(1) + 60_000));
    expect([reasonOf(afterRetain), afterRetain.state]).toEqual(["duplicate", base.state]);
  });

  // contractBoundary: 容量・文字列と件数の上限（P3-C13-CAPACITY・BOUNDS）。
  it("P3-C13-T06 contractBoundary / AC06: per-slice and per-family counts, bounds with code point cuts, pending and terminal budgets", () => {
    const evicted = { level: "INFO", component: "localBulletins", reason: "localBulletinsCapacityEvicted", unit: "U-M", count: 1 };
    const fill = (name: string, make: (index: number) => (xml: string) => string, count: number, state = emptyState()) => {
      let current = state;
      for (let index = 0; index < count; index++) current = send(current, name, make(index)).state;
      return current;
    };
    // 竜巻 128/129・熱中症 256/257・family の上限/+1: normal の受理は最も古い見える記録を退去し、診断を返す。ほかの slice・family は同じ参照。
    const seismic = send(emptyState(), "32-35_09_01_191111_VXSE56").state;
    let state = fill(HEAT, heatN, 256, fill(N50, tornadoN, 128, seismic));
    expect([state.tornado.length, state.heat.length]).toEqual([128, 256]);
    const heat257 = send(state, HEAT, heatN(256));
    expect(evictions(heat257)).toEqual([evicted]);
    expect([heat257.state.heat.length, heat257.state.heat.some((item) => item.subject === "normal/VPFT50/JPTC240000"), heat257.state.tornado, heat257.state.transient])
      .toEqual([256, false, state.tornado, state.transient]);
    const tornado129 = send(state, N50, tornadoN(128));
    expect([evictions(tornado129), tornado129.state.tornado.length, tornado129.state.tornado.some((item) => item.subject.endsWith("/第000府県竜巻注意情報")), tornado129.state.heat])
      .toEqual([[evicted], 128, false, state.heat]);
    // 128 件目までは診断 0、family の満杯（weatherExplanation 256）で他 family・他 slice が不変。
    expect(evictions(send(fill(N50, tornadoN, 127), N50, tornadoN(127)))).toEqual([]);
    state = fill("85_01_01_250630_VPFJ51", explanationN, 256, state);
    expect(state.transient.length).toBe(257);
    const explanation257 = send(state, "85_01_01_250630_VPFJ51", explanationN(256));
    expect([evictions(explanation257), explanation257.state.transient.length, explanation257.state.tornado, explanation257.state.heat]).toEqual([[evicted], 257, state.tornado, state.heat]);
    expect(explanation257.state.transient.filter((item) => item.family === "seismicText")).toHaveLength(1);
    const climate = fill("30_01_01_100915_VPCI50", (index) => eventId(`C${String(index).padStart(4, "0")}`), 128);
    expect(evictions(send(climate, "30_01_01_100915_VPCI50", eventId("C0128")))).toEqual([evicted]);

    // 文字列と件数の上限（ちょうどと +1）: title 64/65・headline 384/385・名前 24/25・区域 16/17・tag 16/17（コードポイントの境界で切る）。
    const boundary = (title: number, headline: number, name: number, areas: number, tags: number) => {
      const area = (index: number) => `<Area><Name>${"名".repeat(name)}</Name><Code>${100 + index}</Code></Area>`;
      const xml = fixtureXml("85_01_01_250630_VPFJ51").replace(/<Title>[^<]*<\/Title>(\s*<ReportDateTime)/, `<Title>${"題".repeat(title)}</Title>$1`)
        .replace(/<Text>[^<]*<\/Text>/, `<Text>${"文".repeat(headline)}</Text>`).replace(/<Condition>[^<]*<\/Condition>/, `<Condition>${Array.from({ length: tags }, (_, index) => `語${index}`).join(" ")}</Condition>`)
        .replace(/<Areas[^>]*>[\s\S]*?<\/Areas>/, `<Areas>${Array.from({ length: areas }, (_, index) => area(index)).join("")}</Areas>`);
      const found = receive(emptyState(), decodeXml(xml, "VPFJ51"), clock(ms("2023-09-07T17:03:00+09:00"))).state.transient[0];
      return found.effective === "active" ? found : null;
    };
    const exact = boundary(64, 384, 24, 16, 16), over = boundary(65, 385, 25, 17, 17);
    expect([exact?.truncated, exact?.title.length, exact?.headline.length, exact?.areas.length, exact?.tags.length]).toEqual([false, 64, 384, 16, 16]);
    expect([over?.truncated, over?.title.length, over?.headline.length, over?.areas.length, over?.tags.length, over?.areas[0].name.length]).toEqual([true, 64, 384, 16, 16, 24]);
    // 切る位置がサロゲートの組の間なら 1 単位短く切る（孤立したサロゲートを作らない）。
    const surrogate = boundary(1, 1, 23, 1, 1);
    const wide = decodeXml(fixtureXml("85_01_01_250630_VPFJ51").replace(/<Areas[^>]*>[\s\S]*?<\/Areas>/, `<Areas><Area><Name>${"あ".repeat(23)}𠮷</Name><Code>1</Code></Area></Areas>`), "VPFJ51");
    const cutName = receive(emptyState(), wide, clock(ms("2023-09-07T17:03:00+09:00"))).state.transient[0];
    expect(surrogate).not.toBeNull();
    expect(cutName.effective === "active" ? [cutName.areas[0].name.length, cutName.truncated, /[\ud800-\udbff]$/.test(cutName.areas[0].name)] : null).toEqual([23, true, false]);
    // 竜巻の区域 128/129。
    const tornadoAreas = (count: number) => {
      const many = Array.from({ length: count }, (_, index) => areaItem(String(1000 + index), `市${index}`)).join("");
      const found = send(emptyState(), N50, infos({ [MUNICIPALITY]: many })).state.tornado[0];
      return found.effective === "active" ? [found.areas.length, found.truncated] : null;
    };
    expect([tornadoAreas(128), tornadoAreas(129)]).toEqual([[128, false], [128, true]]);

    // pending は 128 件まで（64 subject × 2 channel）。129 件目からは新しい intent が外れ、診断 notificationCapacityEvicted を返し、保存世代を進めない。
    let pending = emptyState();
    for (let index = 0; index < 64; index++) pending = send(pending, N50, tornadoN(index)).state;
    expect(pending.intents.filter((item) => item.disposition === "pending")).toHaveLength(128);
    const over64 = send(pending, N50, tornadoN(64));
    expect(over64.diagnostics).toEqual([{ level: "INFO", component: "localBulletins", reason: "notificationCapacityEvicted", unit: "U-M", count: 2 }]);
    // A7 の選択順の後ろから外すので、pending は 128 件のまま（外れた分は intents から外れる、P3-NL-AC05 (1)）。
    expect(over64.state.intents.filter((item) => item.disposition === "pending")).toHaveLength(128);
    // byte の予算: 長い intent の 120 subject を送っても pending の「実 byte＋予約」は 131,072 以内で、保存物は decode できる。
    let heavy = emptyState();
    for (let index = 0; index < 120; index++) heavy = send(heavy, "85_01_01_250630_VPFJ51", compose(explanationN(index), replaceTag("Text", "長".repeat(380)))).state;
    const heavyPending = heavy.intents.filter((item) => item.disposition === "pending");
    expect(heavyPending.length).toBeLessThan(120 * 2);
    expect(localBulletinsUnitCodec.decode(JSON.parse(JSON.stringify(localBulletinsUnitCodec.encode(heavy))) as JsonValue).kind).toBe("restored");
    // intentUpdate で attempts が 1 桁から 5 桁になっても予約の内側で decode できる。
    const grown = reduceLocalBulletinsUnit(pending, { kind: "intentUpdate", clock: clock(T0), intentUpdate: pending.intents.map((item) => ({ ...item, attempts: 12_345,
      nextAttemptAt: T0 + 1_234_567_890, disposition: "pending" as const, lossReason: null })) });
    expect(localBulletinsUnitCodec.decode(JSON.parse(JSON.stringify(localBulletinsUnitCodec.encode(grown.state))) as JsonValue).kind).toBe("restored");
    // 終端記録の予算は無くなった（P3-NL-AC05 (2)）: 終端の更新は intent を外す。
    const ids = pending.intents.map((item) => item.id);
    const delivered = reduceLocalBulletinsUnit(pending, { kind: "intentUpdate", clock: clock(T0), intentUpdate: ids.map((id) => ({ id, attempts: 1, nextAttemptAt: T0, disposition: "delivered" as const, lastAttempt: null, replayed: false, expiresAt: 0, lossReason: null })) });
    expect(delivered.state.intents).toEqual([]);
    // 受信 1 回の費用は記録・intent 単位の加算だけ: 満杯の slice へ受信しても、直列化は 1 つの intent ごと（16 KB 未満）で、state・slice の全体は 1 度も直列化しない。
    // 変えない slice の配列は同じ参照のまま。
    const material = decodeFixture("30_01_01_100915_VPCI50", eventId("C9999"));
    const sizes: number[] = [];
    const stringify = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
      const out = stringify(value, replacer as never, space as never);
      sizes.push(out.length);
      return out;
    });
    let probe: LocalBulletinsUnitStep;
    try { probe = receive(state, material, clock(Date.parse(material.reportDateTimeRaw))); } finally { spy.mockRestore(); }
    expect(Math.max(...sizes, 0)).toBeLessThan(16_384);
    expect(Math.max(...state.tornado.map((item) => Buffer.byteLength(stringify(item))))).toBeGreaterThan(1_000);
    expect(probe.state.tornado).toBe(state.tornado);
    expect(probe.state.heat).toBe(state.heat);

    // 退去の順位（normal の受理）: retainUntil を過ぎた記録 → 記憶 → training/test の見える記録 → normal の見える記録、それぞれ古い順。
    const base0 = T0;
    let order = send(emptyState(), N50, compose(headTitle("A期限切れ"), at(iso(base0)), replaceTag("ValidDateTime", iso(base0 + hours(40)))), base0).state;
    order = send(order, "synthetic_VPHW50_tokyo_cancel", compose(office("長崎地方気象台"), headTitle("B記憶"), at(iso(base0 + hours(30))), serial("1")), base0 + hours(30)).state;
    order = send(order, N50, compose(status("訓練"), headTitle("C訓練"), at(iso(base0 + hours(36) + 1_800_000)), replaceTag("ValidDateTime", iso(base0 + hours(45)))), base0 + hours(36) + 1_800_000).state;
    for (let index = 0; index < 125; index++)
      order = send(order, N50, compose(headTitle(`D${String(index).padStart(3, "0")}`), at(iso(base0 + hours(36) + 2_400_000 + index * 60_000)),
        replaceTag("ValidDateTime", iso(base0 + hours(45)))), base0 + hours(36) + 2_400_000 + index * 60_000).state;
    expect(order.tornado).toHaveLength(128);
    const evictAt = base0 + hours(40);
    const gone: string[] = [];
    for (let index = 0; index < 4; index++) {
      const before = new Set(order.tornado.map((item) => item.subject));
      order = receive(order, decodeFixture(N50, compose(headTitle(`E${index}`), at(iso(base0 + hours(39) + 3_000_000 + index * 60_000)), replaceTag("ValidDateTime", iso(base0 + hours(45))))), clock(evictAt)).state;
      gone.push(...[...before].filter((subject) => !order.tornado.some((item) => item.subject === subject)).map((subject) => subject.split("/").at(-1)!));
    }
    expect(gone).toEqual(["A期限切れ", "B記憶", "C訓練", "D000"]);

    // pending の「実 byte＋予約」の境界: 131,072 ちょうどは decode でき、131,073 は unavailable。
    const own = send(emptyState(), N50).state.tornado[0];
    const pendingAt = (index: number, bodyLength: number) => ({ id: `U-M:${own.subject}:${String(index).padStart(6, "0")}:desktop`, unit: "U-M" as const, subject: own.subject,
      operation: "normal" as const, source: own.source, transition: "updated" as const, channel: "desktop" as const,
      payload: { domain: "weather" as const, level: "warning" as const, title: "t".repeat(160), body: "b".repeat(bodyLength) }, createdAt: T0, expiresAt: T0 + 180_000,
      nextAttemptAt: T0, attempts: 0, configRevision: "p3-local-bulletins-unit-v5", disposition: "pending" as const, lastAttempt: null, replayed: false, priorityGroup: "other" as const });
    const total = (list: readonly ReturnType<typeof pendingAt>[]) => 2 + Math.max(list.length - 1, 0) + list.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + reserve(item), 0);
    const lengths: number[] = [];
    while (total(lengths.map((length, index) => pendingAt(index, length))) <= 131_072) lengths.push(512);
    let excess = total(lengths.map((length, index) => pendingAt(index, length))) - 131_072;
    for (let index = lengths.length - 1; excess > 0; index--) { const cutBy = Math.min(excess, 511); lengths[index] -= cutBy; excess -= cutBy; }
    const exactList = lengths.map((length, index) => pendingAt(index, length));
    expect([total(exactList), exactList.length <= 128]).toEqual([131_072, true]);
    const persistedWith = (list: readonly object[]) => ({ ...(JSON.parse(JSON.stringify(localBulletinsUnitCodec.encode(emptyState()))) as Record<string, JsonValue>), intents: list as JsonValue });
    expect(localBulletinsUnitCodec.decode(persistedWith(exactList)).kind).toBe("restored");
    const oneOver = exactList.map((item, index) => index === 0 ? { ...item, payload: { ...item.payload, body: `${item.payload.body}b` } } : item);
    expect([total(oneOver), localBulletinsUnitCodec.decode(persistedWith(oneOver)).kind]).toEqual([131_073, "invalid"]);
  });

  // contractBoundary: 保存と復元と view（P3-C13-SNAPSHOT・I-U-M.decode・I-U-M.restore）。
  it("P3-C13-T07 contractBoundary / AC07: codec round trip, every decode bound, restore inputs and the view", () => {
    let state = send(emptyState(), N50).state;
    state = send(state, HEAT).state;
    state = send(state, "85_01_01_250630_VPFJ51").state;
    state = send(state, "32-35_09_02_220316_VXSE56").state;
    // 往復で保存 field だけが残る（transient は evidence）。contentRevision と persistence は保存しない。
    const encoded = localBulletinsUnitCodec.encode(state);
    const payload = JSON.parse(JSON.stringify(encoded)) as Record<string, any>; // 試験の変更用（検証ではなく入力の加工）
    const decoded = localBulletinsUnitCodec.decode(payload);
    expect(decoded.kind).toBe("restored");
    if (decoded.kind !== "restored") return;
    expect([decoded.state.tornado, decoded.state.heat, decoded.state.intents, decoded.state.contentRevision]).toEqual([state.tornado, state.heat, state.intents, 0]);
    expect(decoded.state.transient.map((item) => [item.subject, item.effective])).toEqual(state.transient.map((item) => [item.subject, item.effective === "active" ? "evidence" : item.effective]));
    expect(Object.keys(payload)).toEqual(["schemaVersion", "tornado", "heat", "transient", "intents"]);
    expect(JSON.stringify(payload.transient)).not.toContain("headline");

    // decode の各検査に外れる保存物は unavailable（stateを推測で直さない）。
    const copy = (): Record<string, any> => JSON.parse(JSON.stringify(payload)) as Record<string, any>;
    const rename = (record: Record<string, any>, index: number) => {
      const title = `${record.title}${index}`;
      const subject = `normal/tornado/${record.editorialOffice}/${title}`;
      return { ...record, subject, title, source: { ...record.source, subject } };
    };
    const bad: readonly [label: string, change: (value: Record<string, any>) => void][] = [
      ["tornado 129", (value) => { value.tornado = Array.from({ length: 129 }, (_, index) => rename(value.tornado[0], index)); }],
      ["weatherExplanation 257", (value) => { value.transient = Array.from({ length: 257 }, (_, index) => { const subject = `normal/VPFJ51/X${index}`; return { ...value.transient[0], subject, source: { ...value.transient[0].source, subject } }; }); }],
      ["tornado activeUntil beyond retainUntil", (value) => { value.tornado[0].activeUntil = value.tornado[0].retainUntil + 1; }],
      ["tornado title differs from the subject", (value) => { value.tornado[0].title = "別の題名"; }],
      ["tornado office differs from the subject", (value) => { value.tornado[0].editorialOffice = "別の官署"; }],
      ["intent subject outside the forms", (value) => { value.intents[0].subject = "garbage"; value.intents[0].source.subject = "garbage"; }],
      ["duplicate subject", (value) => { value.tornado = [value.tornado[0], value.tornado[0]]; }],
      ["retainUntil mismatch", (value) => { value.tornado[0].retainUntil += 1; }],
      ["tornado activeUntil before the report", (value) => { value.tornado[0].activeUntil = Date.parse(value.tornado[0].source.reportDateTimeRaw); }],
      ["heat targetDate mismatch", (value) => { value.heat[0].targetDate = "2024-08-12"; }],
      ["heat activeUntil beyond 48 hours", (value) => { value.heat[0].targetDate = "2024-08-15"; value.heat[0].activeUntil += 4 * 86_400_000; }],
      ["transient active", (value) => { value.transient[0].effective = "active"; }],
      ["transient fact field", (value) => { value.transient[0].title = "事実"; }],
      ["layer outside the table", (value) => { value.tornado[0].areas[0].layer = "bogus"; }],
      ["lone surrogate in a name", (value) => { value.tornado[0].areas[0].name = "\ud800"; }],
      ["area name 25 units", (value) => { value.tornado[0].areas[0].name = "名".repeat(25); }],
      ["unit mismatch in an intent", (value) => { value.intents[0].unit = "U-B"; }],
      ["inputId with a quote", (value) => { value.tornado[0].source.inputId = 'a"b'; }],
      ["mark of another subject", (value) => { value.tornado[0].unconfirmed = { ...value.tornado[0].source, subject: "normal/VPFT50/X" }; }],
      ["pending over 128", (value) => { value.intents = Array.from({ length: 129 }, (_, index) => ({ ...value.intents[0], id: `${value.intents[0].id}#${index}` })); }],
      ["terminal intent (P3-NL-AC05)", (value) => { value.intents = [{ ...value.intents[0], disposition: "delivered" }]; }],
    ];
    for (const [label, change] of bad) {
      const value = copy();
      change(value);
      expect([label, localBulletinsUnitCodec.decode(value).kind]).toEqual([label, "invalid"]);
    }
    // 受理が通す上限ちょうどの記録は decode も通す: 官署 24・題名 64・名前 24・headline 384・区域 128。
    const exactAreas = Array.from({ length: 128 }, (_, index) => areaItem(String(10_000_000 + index), `名${"前".repeat(22)}${index % 10}`)).join("");
    const exact = send(emptyState(), N50, compose(office("官".repeat(24)), headTitle("題".repeat(64)), infos({ [MUNICIPALITY]: exactAreas }),
      (xml) => xml.replace(/<Text>[^<]*<\/Text>/, `<Text>${"文".repeat(384)}</Text>`))).state;
    expect(exact.tornado[0]).toMatchObject({ truncated: false });
    expect(localBulletinsUnitCodec.decode(JSON.parse(JSON.stringify(localBulletinsUnitCodec.encode(exact))) as JsonValue).kind).toBe("restored");

    // restore 入力: retainUntil を過ぎた記録は除き（世代 +1）、見える期限を過ぎた active は無音で ended（世代 +1、displayChanges 0）、どちらも無ければ世代を進めない。
    // 復元で intent を作らず、pending は元の期限で戻る。nextDeadline は残った期限の最小。
    const single = send(emptyState(), N50);
    const persisted = JSON.parse(JSON.stringify(localBulletinsUnitCodec.encode(single.state))) as ReturnType<typeof localBulletinsUnitCodec.encode>;
    const fresh = { ...emptyState(), persistence: { kind: "saved" as const, currentGeneration: 7, savedGeneration: 7, savedCapturedAt: null, savedAckAt: null, dirtySince: null } };
    const restoreAt = (time: number) => reduceLocalBulletinsUnit(fresh, { kind: "restore", persisted, clock: clock(time, time) });
    const rows: readonly [label: string, time: number, generation: number, displays: number, kinds: readonly string[]][] = [
      ["no deadline yet", T0 + 600_000, 7, 1, ["active"]],
      ["visible deadline passed", ms("2013-07-26T10:30:00+09:00"), 8, 0, ["expired"]],
      ["retainUntil passed", T0 + hours(36), 8, 0, []],
    ];
    for (const [label, time, generation, displays, kinds] of rows) {
      const step = restoreAt(time);
      expect([label, step.state.persistence.currentGeneration, step.displayChanges.length, step.state.tornado.map((item) => item.effective), step.intents],
        label).toEqual([label, generation, displays, kinds, []]);
      expect(step.state.intents, label).toEqual(single.state.intents);
    }
    expect(restoreAt(T0 + 600_000).nextDeadline).toEqual({ wallTimeMs: T0 + 60_000, monotonicMs: null });
    expect(restoreAt(ms("2013-07-26T10:30:00+09:00")).nextDeadline).toEqual({ wallTimeMs: T0 + 60_000, monotonicMs: null });
    expect(restoreAt(T0 + hours(36)).nextDeadline).toEqual({ wallTimeMs: T0 + 60_000, monotonicMs: null });
    // view と snapshot の元: active の記録だけを載せ、ended・cancelled・evidence は載せない。
    const view = toLocalBulletinsView(state);
    expect([view.tornado.length, view.heat.length, view.transient.length, view.subjects.length]).toEqual([1, 1, 1, 3]);
    expect(toLocalBulletinsView(tick(state, ms("2013-07-26T10:30:00+09:00")).state).tornado).toEqual([]);
  });

  // acceptance: Q-NOTICE の機会・level・domain・channel・置換・組み立て（P3-C13-NOTICE-LEVELS・TRAINING・REPLACEMENT）。
  it("P3-C13-T08 acceptance / AC08: generation opportunities, levels, silent cases, replacement, payload and operation channels", () => {
    const shape = (step: LocalBulletinsUnitStep) => step.intents.map((item) => [item.channel, item.transition, item.payload.domain, item.payload.level, item.payload.title,
      item.payload.body]);
    const both = (transition: string, domain: string, level: string, title: string, body: string) => [["desktop", transition, domain, level, title, body],
      ["sound", transition, domain, level, title, body]];
    // 竜巻の新しい active（目撃が無いので normal、H13）・目撃・公開事実の変わった続報（updated）・同じ続報（作らない）・解除・取消。
    const first = send(emptyState(), N50);
    expect(shape(first)).toEqual(both("activated", "weather", "normal", "長崎県竜巻注意情報", "発表中 24地域 / 有効期限 10:30"));
    expect(first.intents.map((item) => item.expiresAt - item.createdAt)).toEqual([180_000, 60_000]);
    const followUp = send(first.state, N50, compose(serial("2"), at("2013-07-26T09:30:00+09:00"), replaceTag("ValidDateTime", "2013-07-26T11:00:00+09:00")));
    expect(shape(followUp)).toEqual(both("updated", "weather", "normal", "長崎県竜巻注意情報", "発表中 24地域 / 有効期限 11:00"));
    expect(pendingOf(followUp.state, NAGASAKI).filter((item) => item.createdAt === ms("2013-07-26T09:30:00+09:00"))).toHaveLength(2);
    // P3-NL-AC05 (1): 置き換えた pending は intents から外れる。
    expect(followUp.state.intents).toHaveLength(2);
    expect(send(followUp.state, N50, compose(serial("3"), at("2013-07-26T09:40:00+09:00"), replaceTag("ValidDateTime", "2013-07-26T11:00:00+09:00"))).intents).toEqual([]);
    const cancel = send(first.state, "synthetic_VPHW50_tokyo_cancel", compose(office("長崎地方気象台"), headTitle("長崎県竜巻注意情報"), at("2013-07-26T09:25:00+09:00"), serial("2")));
    expect(shape(cancel)).toEqual(both("cancelled", "weather", "cancel", "[取消] 長崎県竜巻注意情報（09:20 発表）", "09:20 発表の長崎県竜巻注意情報を取り消しました"));
    expect(pendingOf(cancel.state, NAGASAKI).map((item) => item.transition)).toEqual(["cancelled", "cancelled"]);
    // 熱中症は warning、解説は seismicText が info（earthquake-eew）、ほかは normal（weather）。
    expect(shape(send(emptyState(), HEAT))).toEqual(both("activated", "weather", "warning", "埼玉県熱中症警戒アラート", "埼玉県 8月11日"));
    expect(shape(send(emptyState(), "32-35_09_01_191111_VXSE56"))).toEqual(both("activated", "earthquake-eew", "info", "地震の活動状況等に関する情報", "伊豆東部の地震活動の見通しに関する情報を発表します。"));
    expect(shape(send(emptyState(), "selected_xml/42_01_01_100514_VZSE40"))[0].slice(2, 4)).toEqual(["earthquake-eew", "info"]);
    for (const name of ["72_01_01_190327_VPAW51", "29_01_01_140129_VPZI50", "83_01_01_250630_VPZJ51"])
      expect(send(emptyState(), name).intents.map((item) => [item.payload.domain, item.payload.level]), name).toEqual([["weather", "normal"], ["weather", "normal"]]);
    // 訂正は事実が同じでも作る（title の接頭辞「[訂正] 」、本文の接頭辞「訂正: 」。接頭辞は切る範囲の外）。
    const longTitle = "題".repeat(64);
    const longBase = send(emptyState(), "85_01_01_250630_VPFJ51", headTitle(longTitle));
    const sameFacts = send(longBase.state, "85_01_01_250630_VPFJ51", compose(headTitle(longTitle), infoType("訂正"), serial("8"), at("2023-09-07T17:10:00+09:00")), ms("2023-09-07T17:10:00+09:00"));
    expect(sameFacts.intents.map((item) => [item.transition, item.payload.title, item.payload.body.startsWith("訂正: ")])).toEqual([
      ["updated", `[訂正] ${longTitle}`, true], ["updated", `[訂正] ${longTitle}`, true]]);
    // 記憶だけの取消・期限・遅着の記憶だけの採用・復元・遅着では作らない。
    expect(send(emptyState(), "32-35_09_02_220316_VXSE56").intents).toEqual([]);
    expect(tick(first.state, ms("2013-07-26T10:30:00+09:00")).intents).toEqual([]);
    expect(receive(first.state, decodeFixture(N50, compose(serial("2"), at("2013-07-26T10:35:00+09:00"), replaceTag("ValidDateTime", "2013-07-26T10:50:00+09:00"))),
      clock(ms("2013-07-26T10:55:00+09:00"))).intents).toEqual([]);
    // 一入力 1 intent/channel。置換は同じ subject・channel の pending を superseded にする（上の followUp）。release は info の released。
    const release = send(first.state, "synthetic_VPHW50_tokyo_release", compose(office("長崎地方気象台"), headTitle("長崎県竜巻注意情報"), at("2013-07-26T09:50:00+09:00")));
    expect(shape(release)).toEqual(both("released", "weather", "info", "長崎県竜巻注意情報", "竜巻注意情報は解除されました"));
    // 記録が無いか記憶（cancelled）の subject への解除では tornadoRelease を作らない。
    const releaseXml = compose(office("長崎地方気象台"), headTitle("長崎県竜巻注意情報"), at("2013-07-26T09:50:00+09:00"));
    expect(send(emptyState(), "synthetic_VPHW50_tokyo_release", releaseXml).intents).toEqual([]);
    expect(send(cancel.state, "synthetic_VPHW50_tokyo_release", releaseXml).intents).toEqual([]);
    // training/test は desktop だけ（接頭辞【訓練】・【試験】）。
    expect(shape(send(emptyState(), N50, status("訓練")))).toEqual([["desktop", "activated", "weather", "normal", "【訓練】長崎県竜巻注意情報", "発表中 24地域 / 有効期限 10:30"]]);
    expect(shape(send(emptyState(), HEAT, status("試験")))[0].slice(0, 5)).toEqual(["desktop", "activated", "weather", "warning", "【試験】埼玉県熱中症警戒アラート"]);
    // 復元直後の続報は復元した記録との差で updated（同じ報は作らない）。
    const restored = reduceLocalBulletinsUnit(emptyState(), { kind: "restore", clock: clock(T0), persisted: localBulletinsUnitCodec.encode(first.state) });
    expect(send(restored.state, N50, compose(serial("2"), at("2013-07-26T09:30:00+09:00"), replaceTag("ValidDateTime", "2013-07-26T11:00:00+09:00"))).intents.map((item) => item.transition)).toEqual(["updated", "updated"]);
    expect(reasonOf(send(restored.state, N50))).toBe("duplicate");
  });

  // contractBoundary: origin=recovery は適用しない（P3-C13-N2）。
  it("P3-C13-T12 contractBoundary / AC14: recovery inputs leave every slice unchanged", () => {
    const base = send(send(send(emptyState(), N50).state, HEAT).state, "85_01_01_250630_VPFJ51").state;
    for (const [name, headType] of [[N50, "VPHW50"], [HEAT, "VPFT50"], ["85_01_01_250630_VPFJ51", "VPFJ51"], ["32-35_09_01_191111_VXSE56", "VXSE56"]] as const) {
      const material = decodeXml(fixtureXml(name), headType, `recovery-${name}`, "recovery");
      const step = receive(base, material, clock(Date.parse(material.reportDateTimeRaw)));
      expect([name, step.state, step.intents, step.outcomes, step.decisions.map((item) => [item.decision, "reason" in item ? item.reason : null])]).toEqual([
        name, base, [], [], [["unchanged", "noChange"]]]);
    }
    // 意味検証の後に適用しない: 検証に外れた recovery の報は拒否の reason を返す。
    const invalid = decodeXml(fixtureXml(HEAT).replace(/<EventID>[^<]*<\/EventID>/, "<EventID></EventID>"), "VPFT50", "recovery-bad", "recovery");
    expect(reasonOf(receive(base, invalid, clock(1)))).toBe("identityMissing");
  });

  // contractBoundary: 最大の保存状態からの閉包（P3-X-C4、AC15）。decode が通る最大の形（I-U-M.capacityReserve の見積もり）。
  it("P3-C13-T13 contractBoundary / AC15: from the largest decodable state every operation re-encodes and re-decodes within the generation budget", () => {
    const repeat = (text: string, count: number) => text.repeat(count);
    const reportRaw = "2013-07-26T09:20:00.12345678901234+09:00";
    expect(reportRaw).toHaveLength(40);
    const REPORT = Date.parse(reportRaw);
    // infoTypeRaw は trim で消える空白 6 文字＋「発表」（JSON で 42 byte）。inputId は 64 文字。
    const source = (subject: string, family: string, index: number) => ({ inputId: `${"i".repeat(60)}${String(index).padStart(4, "0")}`, origin: "replay" as const,
      operation: "training" as const, family, subject, reportDateTimeRaw: reportRaw, controlDateTimeRaw: reportRaw, serialRaw: "9999999999", infoTypeRaw: `${"\u000b".repeat(6)}発表` });
    // P3-VM-AC08: 全記録に読み戻しが受ける上限いっぱい（inputId 64・origin recovery）の未確認の印。
    const mark = (subject: string, family: string) => ({ ...source(subject, family, 0), inputId: "i".repeat(64), origin: "recovery" as const });
    const tornado = Array.from({ length: 128 }, (_, index) => {
      const title = `${repeat("題", 61)}${String(index).padStart(3, "0")}`, officeName = repeat("官", 24);
      const subject = `training/tornado/${officeName}/${title}`;
      return { subject, operation: "training", source: source(subject, "VPHW51", index), unconfirmed: mark(subject, "VPHW51"), retainUntil: REPORT + hours(36), effective: "active", activeUntil: REPORT + hours(36),
        title, headline: repeat("文", 384), editorialOffice: officeName, sighted: true, truncated: true,
        areas: Array.from({ length: 128 }, () => ({ layer: "municipalityGroup", code: "12345678", name: repeat("名", 24) })), expiryPending: true };
    });
    const heatReport = Date.parse("2024-08-11T05:00:00+09:00");
    const heat = Array.from({ length: 256 }, (_, index) => {
      const subject = `training/VPFT50/${repeat("E", 60)}${String(index).padStart(4, "0")}`;
      return { subject, operation: "training", source: { ...source(subject, "VPFT50", index), reportDateTimeRaw: "2024-08-11T05:00:00+09:00" }, unconfirmed: mark(subject, "VPFT50"), retainUntil: heatReport + 72 * hours(1),
        effective: "active", activeUntil: Date.parse("2024-08-12T00:00:00+09:00"), targetDate: "2024-08-11", title: repeat("題", 64), headline: repeat("文", 384),
        editorialOffice: repeat("官", 24), areaName: repeat("域", 24), truncated: true, expiryPending: true };
    });
    const families: readonly [family: string, headType: string, count: number, length: number][] = [["seismicText", "VXSE56", 256, 36 * hours(1)],
      ["earlyWeather", "VPAW51", 128, 7 * 24 * hours(1)], ["climateInfo", "VPCI50", 128, 30 * 24 * hours(1)], ["weatherExplanation", "VMCJ55", 256, 36 * hours(1)]];
    const transient = families.flatMap(([family, headType, count, length]) => Array.from({ length: count }, (_, index) => {
      const subject = headType === "VPAW51" ? `training/VPAW51/12345678/${repeat("題", 61)}${String(index).padStart(3, "0")}`
        : `training/${headType}/${repeat("E", 60)}${String(index).padStart(4, "0")}`;
      return { subject, operation: "training", family, source: source(subject, headType, index), unconfirmed: mark(subject, headType), retainUntil: REPORT + length,
        effective: index % 2 === 0 ? "evidence" : "cancelled" };
    }));
    // pending は「実 byte＋予約」131,072 まで（終端記録は P3-NL-AC05 で無くなった）。
    const intentAt = (index: number) => {
      const subject = tornado[index % 128].subject;
      return { id: `U-M:${subject}:${String(index).padStart(6, "0")}:desktop`, unit: "U-M" as const, subject, operation: "training" as const, source: tornado[index % 128].source,
        transition: "updated" as const, channel: "desktop" as const, payload: { domain: "weather", level: "warning", title: repeat("題", 160), body: repeat("文", 512) },
        createdAt: REPORT, expiresAt: REPORT + 180_000, nextAttemptAt: REPORT, attempts: 99_999, configRevision: "p3-local-bulletins-unit-v5", disposition: "pending" as const, lastAttempt: null, replayed: false, priorityGroup: "other" as const };
    };
    const intents: ReturnType<typeof intentAt>[] = [];
    const sizeOf = (list: readonly object[]) => list.reduce<number>((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + 1, 0);
    const growth = (item: ReturnType<typeof intentAt>) => reserve(item);
    for (let index = 0; intents.length < 128; index++) {
      const next = intentAt(index);
      if (sizeOf([...intents, next]) + [...intents, next].reduce((sum, entry) => sum + growth(entry), 0) > 131_072) break;
      intents.push(next);
    }
    const pendingCount = intents.length;
    // P3-NL-AC15 (2): 全部の記録に最長の通知の印。竜巻の印は目撃の fragment の鍵（SIGHTED）も持つ（P3-EF-AC14 (19)）。
    const notice = { version: "0".repeat(16), kinds: ["report", "cancel", "expiry"] as const, evidence: "unattempted" as const };
    const SIGHTED = createHash("sha256").update("sighted").digest("hex").slice(0, 16), sightedBytes = Buffer.byteLength(`,"fragments":["${SIGHTED}"]`);
    const maximum = { schemaVersion: "p3-local-bulletins-unit-v6", tornado: tornado.map((item) => ({ ...item, notice: { ...notice, fragments: [SIGHTED] } })),
      heat: heat.map((item) => ({ ...item, notice })),
      transient: transient.map((item) => ({ ...item, notice })), intents };
    const decoded = localBulletinsUnitCodec.decode(JSON.parse(JSON.stringify(maximum)) as JsonValue);
    expect(decoded.kind).toBe("restored");
    if (decoded.kind !== "restored") return;
    expect([pendingCount, decoded.state.tornado.length, decoded.state.heat.length, decoded.state.transient.length]).toEqual([pendingCount, 128, 256, 768]);
    const closes = (label: string, state: LocalBulletinsUnitState) => {
      const again = localBulletinsUnitCodec.decode(JSON.parse(JSON.stringify(localBulletinsUnitCodec.encode(state))) as JsonValue);
      expect([label, again.kind]).toEqual([label, "restored"]);
      if (again.kind === "restored") expect(generationBytes(localBulletinsUnitCodec.encode(again.state)), label).toBeLessThanOrEqual(GENERATION_STATIC_BOUND);
    };
    const GENERATION_STATIC_BOUND = localBulletinsUnitCodec.maxEnvelopeBytes!;
    const unmarked = (json: string) => Buffer.byteLength(json.replace(/,"(?:unconfirmed|notice)":\{[^}]*\}/g, ""));
    expect(generationBytes(localBulletinsUnitCodec.encode(decoded.state))).toBeLessThanOrEqual(GENERATION_STATIC_BOUND);
    // P3-VM-AC08（作者裁定 2026-10-21 夜）・P3-NL-D-CAPACITY=A: 器を広げた量は未確認の印と通知の印の分（外した終端記録の 98,304 を引く）。印を
    // 外した最大の状態は 4 MiB−98,304 の内側で、各 slice の受理が受ける最長の subject（1 単位 3 byte）の記録に上限いっぱいの未確認の印を付けて
    // encode した印の byte を件数の上限に掛けた和と、通知の印の上界の和が、広げた量の内側。
    const empty = localBulletinsUnitCodec.encode(emptyState());
    expect(unmarked(JSON.stringify(localBulletinsUnitCodec.encode(decoded.state))) + generationBytes(empty) - Buffer.byteLength(JSON.stringify(empty)))
      .toBeLessThanOrEqual(4_194_304 - 98_304);
    const wide = repeat("あ", 64), probes = [["tornado", 128, { ...tornado[0], subject: `training/tornado/${repeat("あ", 24)}/${wide}`, title: wide,
      editorialOffice: repeat("あ", 24) }, "VPHW51"], ["heat", 256, { ...heat[0], subject: `training/VPFT50/${wide}` }, "VPFT50"],
    ["transient", 768, { ...transient[257], subject: `training/VPAW51/12345678/${wide}` }, "VPAW51"]] as const;
    const marks = probes.map(([slice, count, record, family]) => {
      const probe = { ...record, source: { ...record.source, subject: record.subject, family }, unconfirmed: mark(record.subject, family) };
      const json = JSON.stringify({ ...maximum, tornado: [], heat: [], transient: [], intents: [], [slice]: [probe] });
      expect([slice, localBulletinsUnitCodec.decode(JSON.parse(json) as JsonValue).kind]).toEqual([slice, "restored"]);
      return count * (Buffer.byteLength(json) - unmarked(json));
    });
    expect(marks.reduce((sum, item) => sum + item, 0) + (128 + 256 + 768) * noticeMarkBytes("notice") + 128 * sightedBytes)
      .toBeLessThanOrEqual(localBulletinsUnitCodec.maxEnvelopeBytes! - 4_194_304 + 98_304);
    // (i) 竜巻の続報（最大の記録を新しい版で置き換える）。(ii) 熱中症の取消。(iii) transient の新しい報による退去。(iv) intentUpdate で attempts・nextAttemptAt の桁を伸ばす。
    // (v) 期限処理（見える期限・retainUntil の一括の到来）。(vi) restore 入力。
    const training = status("訓練");
    const t0 = tornado[0], h0 = heat[0];
    const followUp = send(decoded.state, N50, compose(training, office(repeat("官", 24)), headTitle(t0.title), at("2013-07-26T09:30:00+09:00"), serial("5"),
      replaceTag("ValidDateTime", "2013-07-26T11:00:00+09:00")));
    expect(followUp.decisions[0]).toMatchObject({ decision: "changed" });
    closes("(i) tornado follow-up", followUp.state);
    const cancelHeat = send(decoded.state, "synthetic_VPFT50_cancel", compose(training, eventId(h0.subject.split("/")[2]), at("2024-08-11T06:00:00+09:00")), ms("2024-08-11T06:00:00+09:00"));
    expect(cancelHeat.decisions[0]).toMatchObject({ decision: "changed" });
    closes("(ii) heat cancel", cancelHeat.state);
    const evictor = send(decoded.state, "89_01_01_250630_VMCJ55", compose(training, eventId("NEWMAX0001"), at("2013-07-26T09:25:00+09:00")), ms("2013-07-26T09:25:00+09:00"));
    expect(evictor.diagnostics.map((item) => item.reason)).toContain("localBulletinsCapacityEvicted");
    closes("(iii) transient eviction", evictor.state);
    const updated = reduceLocalBulletinsUnit(decoded.state, { kind: "intentUpdate", clock: clock(REPORT), intentUpdate: intents.map((item) => ({ ...item, attempts: 123_456_789_012,
      nextAttemptAt: 1_700_000_000_000_000, disposition: "pending" as const, lossReason: null })) });
    closes("(iv) intent update", updated.state);
    // 一括の期限（全 subject の同時の期限）: 件数と所要を計測して報告する（AC12 の一部）。
    const sweptAt = REPORT + hours(37);
    const startedAt = performance.now();
    const swept = tick(decoded.state, sweptAt);
    const sweepMs = performance.now() - startedAt;
    expect(swept.state.tornado.every((item) => item.effective !== "active")).toBe(true);
    closes("(v) deadline", swept.state);
    const farther = tick(decoded.state, heatReport + 31 * 24 * hours(1));
    expect([farther.state.tornado.length, farther.state.heat.length, farther.state.transient.length]).toEqual([0, 0, 0]);
    closes("(v) deadline retention", farther.state);
    const restoredAgain = reduceLocalBulletinsUnit(emptyState(), { kind: "restore", clock: clock(REPORT + 600_000), persisted: localBulletinsUnitCodec.encode(decoded.state) });
    closes("(vi) restore", restoredAgain.state);
    // 一括の期限は数えた件数で出す: 全 slice・family の retainUntil が同じ時刻に来る 1,152 記録を小さな報で作り、到来で全部除かれることを数える。
    const due = ms("2026-10-12T12:00:00+09:00");
    let bulk = emptyState();
    for (const { headType, xml } of bulkReports(due)) bulk = receive(bulk, decodeXml(xml, headType), clock(due - 60_000)).state;
    const held = bulk.tornado.length + bulk.heat.length + bulk.transient.length;
    const bulkStart = performance.now();
    const bulkSwept = tick(bulk, due);
    const bulkMs = performance.now() - bulkStart;
    expect([held, bulk.tornado.filter((item) => item.effective === "active").length, bulkSwept.state.tornado.length + bulkSwept.state.heat.length + bulkSwept.state.transient.length,
      bulkSwept.decisions.length]).toEqual([1152, 128, 0, 128]);
    console.info("P3-C13-T13 closure", { bytes: generationBytes(localBulletinsUnitCodec.encode(decoded.state)), sweepMs: Math.round(sweepMs * 100) / 100, bulkRecords: held,
      bulkSweepMs: Math.round(bulkMs * 100) / 100 });
  });

  // contractBoundary: 退去の operation の適格性と自身の退去（P3-C13-EVICT-OPERATION、K4 の P3-OPCAP-AC01・AC02 と K4N の AC01・AC02 と同じ受入）。
  it("P3-C13-T14 contractBoundary / AC16: eligibility by operation, self eviction and the pending of a self-evicted cancel", () => {
    const evicted = { level: "INFO", component: "localBulletins", reason: "localBulletinsCapacityEvicted", unit: "U-M", count: 1 };
    const trainingOffice = compose(status("訓練"), office("訓練官署"));
    const fill = (count: number, extra?: (index: number) => (xml: string) => string) => {
      let state = emptyState();
      for (let index = 0; index < count; index++) state = send(state, N50, extra == null ? tornadoN(index) : compose(tornadoN(index), extra(index))).state;
      return state;
    };
    // (a) normal の見える 127 件＋normal の cancelled の記憶 1 件の満杯に、training の新しい官署の VPHW50 を受けると、記憶は残り、受けた記録が自身を退去する。
    let full = fill(127);
    full = send(full, "synthetic_VPHW50_tokyo_cancel", compose(office("長崎地方気象台"), headTitle("取消済み府県竜巻注意情報"), at("2013-07-26T09:19:00+09:00"), serial("1"))).state;
    expect([full.tornado.length, full.tornado.filter((item) => item.effective === "cancelled").length]).toEqual([128, 1]);
    const trainingReport = compose(trainingOffice, at("2013-07-26T09:25:00+09:00"), replaceTag("ValidDateTime", "2013-07-27T00:00:00+09:00"));
    const self = send(full, N50, trainingReport);
    expect(self.decisions).toEqual([{ subject: "training/tornado/訓練官署/長崎県竜巻注意情報", operation: "training", decision: "changed", reason: null, change: "revisionOnly", currentEstablished: null }]);
    expect([self.outcomes, self.diagnostics, self.intents, self.state]).toEqual([[{ kind: "accepted", change: "revisionOnly", subjects: [] }], [evicted], [], full]);
    expect(self.state.persistence.currentGeneration).toBe(full.persistence.currentGeneration);
    // 続く取消より古い normal の報は unchanged/stale。
    expect(reasonOf(send(self.state, N50, compose(headTitle("取消済み府県竜巻注意情報"), at("2013-07-26T09:10:00+09:00"))))).toBe("stale");
    // (b) training 1 件を含む満杯では training の記録だけが退去する。
    const mixed = send(fill(127), N50, compose(trainingOffice, at("2013-07-26T09:21:00+09:00"), replaceTag("ValidDateTime", "2013-07-27T00:00:00+09:00"))).state;
    const nextTraining = send(mixed, N50, compose(trainingOffice, headTitle("別の訓練竜巻注意情報"), at("2013-07-26T09:26:00+09:00"), replaceTag("ValidDateTime", "2013-07-27T00:00:00+09:00")));
    expect([evictions(nextTraining), nextTraining.state.tornado.filter((item) => item.operation === "normal").length, nextTraining.state.tornado.filter((item) => item.operation === "training").length])
      .toEqual([[evicted], 127, 1]);
    expect(nextTraining.state.tornado.some((item) => item.subject.endsWith("/長崎県竜巻注意情報") && item.operation === "training")).toBe(false);
    // (c) retainUntil を過ぎた normal の記録も、training の受理で退去しない（期限処理の前の状態）。
    const pastRetain = send(full, N50, compose(trainingOffice, at("2013-07-26T09:25:00+09:00")), T0 + hours(40));
    expect([pastRetain.decisions[0], pastRetain.state.tornado]).toMatchObject([{ decision: "unchanged", reason: "stale" }, full.tornado]);
    const expiredNormal = receive(full, decodeFixture(N50, trainingReport), clock(ms("2013-07-26T09:25:00+09:00")));
    expect(expiredNormal.state.tornado).toBe(full.tornado);
    // (d) 自身を退去した training の取消は、その subject の pending を superseded にし、intents が変わったときだけ保存世代を進める。
    const lone = send(fill(127), N50, compose(trainingOffice, at("2013-07-26T09:21:00+09:00"), replaceTag("ValidDateTime", "2013-07-27T00:00:00+09:00")));
    const evictedTraining = send(lone.state, N50, tornadoN(127));
    expect(evictedTraining.state.tornado.some((item) => item.operation === "training")).toBe(false);
    const trainingSubject = "training/tornado/訓練官署/長崎県竜巻注意情報";
    expect(pendingOf(evictedTraining.state, trainingSubject)).toHaveLength(1);
    const cancelTraining = send(evictedTraining.state, "synthetic_VPHW50_tokyo_cancel", compose(status("訓練"), office("訓練官署"), headTitle("長崎県竜巻注意情報"), at("2013-07-26T09:30:00+09:00"), serial("2")));
    expect([cancelTraining.decisions[0], pendingOf(cancelTraining.state, trainingSubject), cancelTraining.state.tornado, cancelTraining.diagnostics.map((item) => item.reason)]).toMatchObject([
      { decision: "changed", change: "revisionOnly", currentEstablished: null }, [], evictedTraining.state.tornado, ["localBulletinsCapacityEvicted"]]);
    expect(cancelTraining.state.persistence.currentGeneration).toBe(evictedTraining.state.persistence.currentGeneration + 1);
    const again = send(cancelTraining.state, "synthetic_VPHW50_tokyo_cancel", compose(status("訓練"), office("訓練官署"), headTitle("長崎県竜巻注意情報"), at("2013-07-26T09:31:00+09:00"), serial("3")));
    expect(again.state.persistence.currentGeneration).toBe(cancelTraining.state.persistence.currentGeneration);
    // (e) transient の weatherExplanation が満杯でも、竜巻・熱中症・ほかの family の記録は退去されない。
    let others = send(send(send(emptyState(), N50).state, HEAT).state, "32-35_09_01_191111_VXSE56").state;
    for (let index = 0; index < 256; index++) others = send(others, "85_01_01_250630_VPFJ51", explanationN(index)).state;
    const next = send(others, "85_01_01_250630_VPFJ51", explanationN(256));
    expect([evictions(next), next.state.tornado, next.state.heat, next.state.transient.filter((item) => item.family === "seismicText")]).toEqual([
      [evicted], others.tornado, others.heat, others.transient.filter((item) => item.family === "seismicText")]);
  });
});
// P3-NL-AC08 (1)(4)・AC15 (4): started の pending は復元で外れ、failed・null の pending は欄ごと戻る。
it("P3-NL-T07 contractBoundary / AC08・AC15 (4): U-M restores failed and null pending with their fields and drops a started one", () => {
  const issued = send(emptyState(), N50);
  expect(issued.intents.length).toBeGreaterThanOrEqual(2);
  expectRestoreStarted({ intents: [issued.intents[0], issued.intents[1]], make: (intents) => ({ ...issued.state, intents }),
    restore: (state, at) => reduceLocalBulletinsUnit(emptyState(), { kind: "restore", persisted: localBulletinsUnitCodec.encode(state), clock: at }),
    markOf: (state, subject) => records(state).find((item) => item.subject === subject)?.notice });
});
