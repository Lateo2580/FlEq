import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type {
  VolcanoAlert, VolcanoAreaGroup, VolcanoBulletin, VolcanoEruption, VolcanoInput, VolcanoIntent, VolcanoShortfall, VolcanoUnitState, VolcanoUnitStep,
} from "../../contracts/p3-volcano-unit.types";
import { CheckpointCoordinator } from "../../src/checkpoint/checkpoint";
import type { CheckpointFileSystem } from "../../src/checkpoint/checkpoint";
import { deliveryGrowth } from "../../src/notification-delivery/delivery-growth";
import { linkedUnitCodecs, linkedUnitTable, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { intentUpdateOwner, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { classifyHeadType, placeOfHeadType } from "../../src/runtime/unit-coverage";
import { reduceVolcanoUnit, toVolcanoView, volcanoUnitCodec } from "../../src/units/volcano/volcano-unit";
import { chain, clock, decodeFixture, decodeXml, emptyState, fixtureXml, receive, replaceTag, retime, send, status } from "./volcano-fixture";

const DAY = 86_400_000;
const F = {
  a306: "45_01_01_200522_VFVO50", a315: "45_02_01_200522_VFVO50", a350: "45_03_01_200731_VFVO50", marine: "46_01_01_170103_VFSVii",
  national: "44_01_01_151008_VFVO51", b350: "44_02_01_200522_VFVO51", b350x: "44_03_01_200731_VFVO51",
  e1: "67_01_01_140927_VFVO56", e2: "67_01_02_140927_VFVO56", e3: "67_01_03_140927_VFVO56", e4: "67_01_04_140927_VFVO56",
  o1: "43_01_01_200522_VFVO52", o2: "43_02_01_200522_VFVO52", o3: "43_03_01_200522_VFVO52", s1: "43_04_01_260807_VFVO52",
  s2: "43_04_02_260807_VFVO52", plume: "synthetic_phase5c_plume_3000m_or_more", scheduled: "66_01_01_210517_VFVO53",
  rapid: "66_01_02_210514_VFVO54", detail: "66_01_03_210514_VFVO55", flow: "79_01_01_210527_VFVO60", notice: "42_02_01_071130_VZVO40",
  continuation: "synthetic_VFVO50_continuation", alertCancel: "synthetic_VFVO50_cancel",
} as const;
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms + 32_400_000).toISOString().replace(".000Z", "+09:00");
const alertOf = (state: VolcanoUnitState, code: string, operation: Operation = "normal") =>
  state.alerts.find((item) => item.subject === `${operation}/volcano:alert/${code}`);
const eruptionOf = (state: VolcanoUnitState, eventId: string) => state.eruptions.find((item) => item.eventId === eventId);
const shape = (step: VolcanoUnitStep) => step.decisions.map((item) => [item.subject, item.decision,
  item.decision === "changed" ? item.change : item.decision === "unchanged" || item.decision === "rejected" ? item.reason : null]);
const levels = (step: VolcanoUnitStep) => step.intents.map((item) => `${item.channel}:${item.payload.level}`);
const pending = (state: VolcanoUnitState) => state.intents.filter((item) => item.disposition === "pending");
const effective = (value: { effective: string } | undefined) => value?.effective ?? null;
const roundTrip = (state: VolcanoUnitState) => volcanoUnitCodec.decode(JSON.parse(JSON.stringify(volcanoUnitCodec.encode(state))) as JsonValue);
const tick = (state: VolcanoUnitState, wallTimeMs: number, monotonicMs = 0) =>
  reduceVolcanoUnit(state, { kind: "deadline", clock: clock(wallTimeMs, monotonicMs) });
// 保存 1 世代の byte（checkpoint envelope の JSON＋generation/capturedAt の 62 byte の予約）と、pending の配送予約を足した値（P3-CODEC-RES-01）。
const generation = (state: VolcanoUnitState) => Buffer.byteLength(JSON.stringify({ schemaVersion: "p3-volcano-unit-v1", unit: "U-V",
  generation: 0, capturedAt: 0, payload: volcanoUnitCodec.encode(state), sha256: "0".repeat(64) })) + 62;
const reserved = (state: VolcanoUnitState) => generation(state) + pending(state).reduce((sum, item) => sum + deliveryGrowth(item), 0);
const emptyOwner = (now: ReturnType<typeof clock>) => restoreOwner({ runId: "run", place: "urgent", clock: now, restored: { "U-E": { kind: "empty" },
  "U-T": { kind: "empty" }, "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
// 66_01_01 の火山コードと名前を替える（同じ ReportDateTime の定時の報を火山ごとに作る）。
const volcano = (code: string, name: string) => (xml: string) => xml.replaceAll("<Code>506</Code>", `<Code>${code}</Code>`)
  .replaceAll("<Name>桜島</Name>", `<Name>${name}</Name>`);

describe("P3-UNIT-V-001 U-V reducer", () => {
  // contractBoundary: Q-ENUM の順と原子性、合法の縮退、coverage と実行場所（AC01）。
  it("P3-C9-T01 contractBoundary / AC01: first reason only, unchanged state, legal reduced forms and the U-V route", () => {
    const base = emptyState();
    const now = clock(at("2020-05-22T13:03:00+09:00"));
    const xml = fixtureXml(F.a306);
    const reject = (source: string, headType = "VFVO50", inputId?: string) => {
      const step = receive(base, decodeXml(source, headType, inputId), now);
      expect(step.state).toBe(base);
      expect([step.intents, step.outcomes, step.displayChanges]).toEqual([[], [], []]);
      expect(step.diagnostics).toHaveLength(1);
      expect(step.decisions).toHaveLength(1);
      const result = step.decisions[0];
      return result.decision === "rejected" ? `${result.reason} ${result.subject}`.trim() : result.decision;
    };
    const event = (value: string) => replaceTag("EventID", value)(xml);
    const target = /<VolcanoInfo type="噴火警報・予報（対象火山）">[\s\S]*?<\/VolcanoInfo>/;
    const areas = Array.from({ length: 129 }, (_, index) => `<Area><Name>火山${index}</Name><Code>V${index}</Code></Area>`).join("");
    // 拒否の subject は識別できた単一の subject（警報は火山コード、噴火・解説は EventID を読めた後）、識別できなければ空文字。
    const ALERT = "normal/volcano:alert/306";
    const cases: [string, string, string?][] = [
      [event(""), "identityMissing"], [event("   "), "identityMissing"], [event("30 6"), "identityInvalid"],
      [event("30/6"), "identityInvalid"], [event("a".repeat(65)), "identityInvalid"],
      [xml.replaceAll("<Code>306</Code>", `<Code>${"3".repeat(17)}</Code>`), "identityInvalid"],
      [replaceTag("Serial", "1a")(xml), "identityInvalid"], [replaceTag("Serial", "12345678901")(xml), "identityInvalid"],
      // 小数秒で 40 文字を超える ReportDateTime と、8 文字を超える InfoType の raw（保存する ReportRef の上限、Q-ENUM.identity）。
      [retime("2020-05-22T13:03:00.0000000000000000+09:00")(xml), "identityInvalid"],
      [replaceTag("InfoType", "発表        ")(xml), "identityInvalid"], [replaceTag("InfoType", "不明")(xml), "requiredStructureInvalid"],
      [xml.replace(target, ""), "requiredStructureMissing"],
      [xml.replaceAll("<Code>13</Code>", "<Code>13</Code><Code>13</Code>"), `requiredStructureInvalid ${ALERT}`],
      [xml.replaceAll("<Code>13</Code>", "<Code>123456789</Code>"), `requiredStructureInvalid ${ALERT}`],
      // 存在が妥当性より先（Q-ENUM.priorityRule）: Kind の重複より火山コードの欠落。
      [xml.replaceAll("<Code>13</Code>", "<Code>13</Code><Code>13</Code>").replaceAll("<Code>306</Code>", ""), "requiredStructureMissing"],
      [fixtureXml(F.b350).replace(/(<Areas codeType="火山名">)\s*<Area>[\s\S]*?<\/Area>/, `$1${areas}`), "requiredStructureInvalid normal/VFVO51/350", "VFVO51"],
      [replaceTag("InfoType", "不明")(fixtureXml(F.o1)), "requiredStructureInvalid normal/volcano:eruption/20200522144900_306", "VFVO52"],
    ];
    expect(cases.map(([source, , headType]) => reject(source, headType))).toEqual(cases.map(([, reason]) => reason));
    // 64 byte の EventID と 8 byte の code は合法。保存する inputId の上限（64 文字）を超える入力は identityInvalid。
    expect(receive(base, decodeXml(event("a".repeat(64)), "VFVO50"), now).decisions[0].decision).toBe("changed");
    expect(receive(base, decodeXml(xml.replaceAll("<Code>13</Code>", "<Code>12345678</Code>"), "VFVO50"), now).decisions[0].decision)
      .toBe("changed");
    expect(reject(xml, "VFVO50", "i".repeat(65))).toBe("identityInvalid");

    // 合法: 取消の Body 縮退（67_01_04）、対象火山の無い VFVO51、火山の無い VZVO40。
    const noEntries = fixtureXml(F.b350).replace(/<Information type="[^"]*対象火山[^"]*">[\s\S]*?<\/Information>/, "");
    for (const step of [send(base, F.e4), receive(base, decodeXml(noEntries, "VFVO51"), now), send(base, F.notice)])
      expect(step.decisions.map((item) => item.decision)).toEqual(["changed"]);
    const headTypes = ["VFVO50", "VFVO51", "VFVO52", "VFVO53", "VFVO54", "VFVO55", "VFVO56", "VFVO60", "VZVO40",
      ...Array.from({ length: 12 }, (_, index) => `VFSV${50 + index}`)];
    for (const headType of headTypes) {
      expect(classifyHeadType(headType)).toEqual({ status: "ready", unit: "U-V" });
      expect(placeOfHeadType(headType)).toBe("urgent");
    }
    // 一入力は U-V だけへ届き、U-E・U-T・U-Q・U-N の state は同じ参照のまま。
    const owner = restoreOwner({ runId: "run", place: "urgent", clock: now, restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const material = decodeFixture(F.a306);
    const routed = receiveOwner(owner, { runId: "run", inputId: material.inputId, result: { kind: "decoded", material } }, now, linkedUnitTable);
    expect(routed.changedUnits).toEqual(["U-V"]);
    for (const unit of ["U-E", "U-T", "U-Q", "U-N"] as const) expect(routed.state.units[unit]).toBe(owner.units[unit]);
  });

  // acceptance: 警報（AC02）。
  it("P3-C9-T02 acceptance / AC02: alerts, the national VFVO51, atomic entries, VFVO50 and VFSV fields, unknown codes and operations", () => {
    const [a306, a315] = chain([F.a306, F.a315]);
    expect(alertOf(a306.state, "306")).toMatchObject({ effective: "active", level: 3, kind: { code: "13", condition: "引上げ" },
      lastKind: { code: "11" }, volcanoName: "浅間山", municipalities: [{ kindName: "火口周辺警報", codes: ["1042500", "2020800", "2032100",
        "2032300"] }], marineAreas: [], coordinate: "+3624.38+13831.38+2568/" });
    expect(alertOf(a315.state, "315")).toMatchObject({ effective: "active", level: 5 });
    // VFSV（46_01_01 を VFSV50 として）: 周辺海域警戒 36 は level null の active、海上予報区だけを持つ。
    const marine = send(emptyState(), F.marine);
    expect(alertOf(marine.state, "506")).toMatchObject({ effective: "active", level: null, kind: { code: "36" }, volcanoName: "桜島",
      headline: null, municipalities: [], marineAreas: [{ kindName: "海上警報（噴火警報）", codes: ["5200"] }], source: null,
      marineSource: expect.objectContaining({ family: "VFSV50" }) });
    // 全国の VFVO51: active になるのはレベル 2 以上と 22・23・36 の 14 火山だけで、留意の列挙は記録を作らない。
    const national = send(emptyState(), F.national);
    expect([national.state.alerts.length, national.state.alerts.every((item) => item.effective === "active")]).toEqual([14, true]);
    expect(national.decisions.filter((item) => item.decision === "unchanged").map((item) => item.decision === "unchanged" && item.reason))
      .toEqual(Array(98).fill("noChange"));
    expect(national.intents.map((item) => item.subject)).toEqual(["normal/VFVO51/900", "normal/VFVO51/900"]);
    // 重複の再送は警報の配列の参照も保存世代も変えない。
    const resent = send(national.state, F.national);
    expect([resent.state.alerts, resent.state.persistence]).toEqual([national.state.alerts, national.state.persistence]);
    expect(resent.state.alerts).toBe(national.state.alerts);
    // VFVO51 の同じ区分の継続は VFVO50 の事実（対象市町村・Headline）を保ち、land 側の版（landKind・source）だけを進める（revisionOnly）。
    const raised = send(emptyState(), F.a350, (xml) => retime("2020-05-22T13:00:00+09:00")(xml).replaceAll("<Code>11</Code>", "<Code>12</Code>")
      .replace("<Condition>引下げ</Condition>", "<Condition>引上げ</Condition>")).state;
    const kept = send(raised, F.b350);
    expect(shape(kept)).toEqual([["normal/VFVO51/350", "changed", "semantic"], ["normal/volcano:alert/350", "changed", "revisionOnly"]]);
    expect(alertOf(kept.state, "350")).toEqual({ ...alertOf(raised, "350"), source: expect.objectContaining({ family: "VFVO51" }),
      landKind: { code: "12", name: "レベル２（火口周辺規制）", condition: "継続" }, retainUntil: expect.any(Number) });
    expect(kept.intents.map((item) => item.subject)).toEqual(["normal/VFVO51/350", "normal/VFVO51/350"]);
    // 解除・引下げ（45_03_01 のレベル 1 引下げ）で ended。記録の無い火山へは ended の記録と通知（inactiveAdoption）。
    const lowered = send(raised, F.a350);
    expect([effective(alertOf(lowered.state, "350")), lowered.intents.map((item) => [item.transition, item.payload.level])])
      .toEqual(["ended", [["released", "normal"], ["released", "normal"]]]);
    const lone = send(emptyState(), F.a350);
    expect([shape(lone), effective(alertOf(lone.state, "350")), levels(lone)]).toEqual([[["normal/volcano:alert/350", "changed", "revisionOnly"]],
      "ended", ["desktop:normal", "sound:normal"]]);
    // VFVO51 の entry の一つが stale なら警報の entry を一つも適用せず WARN、解説は採用する。
    const later = send(emptyState(), F.a306).state;
    const stale = send(later, F.national);
    expect(stale.state.alerts).toBe(later.alerts);
    expect(stale.decisions.slice(1).every((item) => item.decision === "unchanged" && item.reason === "stale")).toBe(true);
    expect(stale.diagnostics).toMatchObject([{ level: "WARN", reason: "volcanoRevisionConflict", count: 112 }]);
    expect(shape(stale)[0]).toEqual(["normal/VFVO51/900", "changed", "semantic"]);
    // 1 火山の区分だけを替えた新しい版の全国の解説: 表示が変わるのはその火山だけで、ほかの 13 火山は land 側の版（source）だけが進む。
    const next = send(national.state, F.national, (xml) => retime("2015-10-08T17:00:00+09:00")(replaceTag("Serial", "14")(xml))
      .replace("<Name>レベル５（避難）</Name>\n<Code>15</Code>", "<Name>レベル４（高齢者等避難）</Name>\n<Code>14</Code>"));
    expect(next.decisions.slice(1).flatMap((item) => item.decision === "changed" ? [[item.subject, item.change]] : [])).toEqual(
      national.state.alerts.map((item) => [item.subject, item.subject === "normal/volcano:alert/509" ? "semantic" : "revisionOnly"]));
    expect(next.state.alerts.every((item) => item.source?.serialRaw === "14")).toBe(true);
    // VFVO50 と VFSV を同じ ReportDateTime で両順に当てると、対象市町村と海上予報区が両方残る（P3-C9-MARINE=A）。
    const asMarine = (xml: string) => retime("2020-05-22T13:03:00+09:00")(xml).replaceAll("<Code>506</Code>", "<Code>306</Code>");
    for (const order of [[F.a306, F.marine], [F.marine, F.a306]]) {
      let state = emptyState();
      const steps = order.map((name) => { const step = send(state, name, name === F.marine ? asMarine : undefined); state = step.state; return step; });
      expect(alertOf(state, "306"), order.join()).toMatchObject({ municipalities: [{ kindName: "火口周辺警報" }],
        marineAreas: [{ kindName: "海上警報（噴火警報）" }], kind: { code: order[0] === F.a306 ? "13" : "36" } });
      // 同じ版で kind が違えば先着の kind を保ち、食い違いを WARN にする（kind 以外の自分の field は当てる）。
      expect(steps[1].diagnostics).toMatchObject([{ reason: "volcanoRevisionConflict" }]);
    }
    // VFVO50(T) の後に届いた VFSV(T−1) も marineSource より新しければ採用し、新しい版の kind を保つ。
    const early = send(a306.state, F.marine, (xml) => asMarine(xml).replace("13:03:00", "13:02:00"));
    expect(alertOf(early.state, "306")).toMatchObject({ kind: { code: "13" }, marineAreas: [{ codes: ["5200"] }] });
    // 表に無い code は active（level null）。訓練は別の subject で通常と交差しない。
    expect(alertOf(send(emptyState(), F.a306, (xml) => xml.replaceAll("<Code>13</Code>", "<Code>99</Code>")).state, "306"))
      .toMatchObject({ effective: "active", level: null });
    const training = send(a306.state, F.a306, status("訓練"));
    expect([alertOf(training.state, "306", "training")?.effective, alertOf(training.state, "306")]).toEqual(["active", alertOf(a306.state, "306")]);
    expect(training.intents.map((item) => [item.channel, item.payload.title])).toEqual([["desktop", "【訓練】噴火警報（火口周辺）"]]);
  });

  // acceptance: 噴火と期限（AC03・AC05）。67_01_xx・43_01〜43_03 はサンプル電文を時刻順に並べた試験用の列。
  it("P3-C9-T03 acceptance / AC03,AC05: eruption subjects by EventID, cancel scope and the 1 d / 2 d / 30 d deadlines", () => {
    const flash = chain([F.e1, F.e2, F.e3, F.e4, F.e4, F.e1]);
    expect(flash.map((step) => shape(step)[0].slice(1))).toEqual([["changed", "semantic"], ["unchanged", "stale"], ["changed", "semantic"],
      ["changed", "semantic"], ["unchanged", "duplicate"], ["unchanged", "stale"]]);
    expect(eruptionOf(flash[3].state, "20140927120000_312")).toMatchObject({ effective: "cancelled", volcanoCode: "312" });
    // 初報の無い EventID の訂正は新しい subject、取消はその EventID だけ（43_01_01 の噴火は active のまま）。
    const series = chain([F.a306, F.o1, F.o2, F.o3]);
    expect(series[3].state.eruptions.map((item) => [item.eventId, item.effective])).toEqual([["20200522144900_306", "active"],
      ["20200522143900_306", "cancelled"]]);
    expect(series[3].state.alerts).toBe(series[0].state.alerts);
    // VFVO51 の取消は解説 subject だけを取り消し、entry の火山の警報を取り消さない（P3-C9-CANCEL-SCOPE=A の (4)）。
    const commentary = send(emptyState(), F.b350).state;
    const withdrawn = send(commentary, F.b350, (xml) => replaceTag("InfoType", "取消")(retime("2020-05-22T13:57:00+09:00")(xml)));
    expect([withdrawn.state.bulletins.map((item) => item.effective), withdrawn.state.alerts, levels(withdrawn)]).toEqual([["cancelled"],
      commentary.alerts, ["desktop:cancel", "sound:cancel"]]);
    // 同じ Serial・新しい ReportDateTime の訂正を stale にしない（流向 東→西）。
    const sakura = chain([F.s1, F.s2]);
    expect([shape(sakura[1])[0].slice(1), eruptionOf(sakura[1].state, "20260807015800_506")]).toMatchObject([["changed", "semantic"],
      { plumeDirection: "西" }]);
    // 期限: active は +1 日で expired（通知しない）、記録は +2 日で除く。到来していない deadline は同じ state 参照と空の結果。
    const reported = at("2020-05-22T14:49:00+09:00");
    const one = send(emptyState(), F.o1);
    const quiet = tick(one.state, reported + 180_000).state;
    const before = tick(quiet, reported + DAY - 60_000);
    expect([before.state, before.decisions, before.outcomes, before.displayChanges, before.intents]).toEqual([quiet, [], [], [], []]);
    const expired = tick(quiet, reported + DAY);
    expect([effective(expired.state.eruptions[0]), expired.intents, expired.displayChanges.map((item) => item.after)])
      .toEqual(["expired", [], [null]]);
    expect(tick(expired.state, reported + 2 * DAY - 60_000).state.eruptions).toHaveLength(1);
    expect(tick(expired.state, reported + 2 * DAY).state.eruptions).toEqual([]);
    // 警報の inactive の記録は +30 日で除く。active の警報は期限で消えない。
    const ended = send(emptyState(), F.a350).state;
    const endedAt = at("2020-07-31T11:03:00+09:00");
    const quietEnded = tick(ended, endedAt + 180_000).state;
    expect(tick(quietEnded, endedAt + 30 * DAY - 60_000).state.alerts).toHaveLength(1);
    expect(tick(quietEnded, endedAt + 30 * DAY).state.alerts).toEqual([]);
    expect(tick(tick(series[0].state, at("2020-05-22T13:03:00+09:00") + 180_000).state, at("2021-05-22T00:00:00+09:00")).state.alerts)
      .toHaveLength(1);
    // 到着の時点で期限を過ぎた報は採用して watermark を進め、同じ reduce で回収する（view に載らず鳴らない）。
    const overdue = send(emptyState(), F.o1, undefined, reported + DAY + 1);
    expect([shape(overdue)[0].slice(1), effective(overdue.state.eruptions[0]), overdue.intents, overdue.displayChanges])
      .toEqual([["changed", "semantic"], "expired", [], []]);
    expect(shape(send(overdue.state, F.o1, undefined, reported + DAY + 2))[0].slice(1)).toEqual(["unchanged", "duplicate"]);
  });

  // acceptance: 降灰と定時の batch（AC04）。O08:11〜13 の振る舞いは 66_01_01・66_01_02 を書き換えた入力で確かめる。
  it("P3-C9-T04 acceptance / AC04: ashfall projection and variants, the VFVO53 batch on the monotonic clock", () => {
    const [rapid, detail] = chain([F.rapid, F.detail]);
    expect(rapid.state.ashfalls[0]).toMatchObject({ effective: "active", variant: "VFVO54", forecastEndsAt: at("2021-05-14T13:31:00+09:00"),
      groups: [{ hazardClass: "ballistic", ashCode: "75" }, { hazardClass: "ash", ashCode: "72", areaCount: 1 }] });
    expect(detail.state.ashfalls[0]).toMatchObject({ variant: "VFVO55", forecastEndsAt: at("2021-05-14T19:00:00+09:00") });
    // 同じ版は VFVO55 > VFVO54。
    const same = (xml: string) => retime("2021-05-14T12:51:00+09:00")(xml);
    expect(shape(send(detail.state, F.rapid, same))[0].slice(1)).toEqual(["unchanged", "stale"]);
    expect(shape(send(send(emptyState(), F.rapid, same).state, F.detail))[0].slice(1)).toEqual(["changed", "semantic"]);
    // 投影の上限 +1（期間 25・期間あたりの地域 257・延べ 2,049・49 時間の期間）は requiredStructureInvalid で拒否する。
    const report = at("2021-05-14T12:40:00+09:00");
    const ash = (periods: readonly (readonly [startMs: number, endMs: number, areas: number])[]) => (xml: string) => xml.replace(
      /<AshInfos[\s\S]*<\/AshInfos>/, `<AshInfos type="降灰予報（速報）">${periods.map(([start, end, areas], period) =>
        `<AshInfo type="予報"><StartTime>${iso(start)}</StartTime><EndTime>${iso(end)}</EndTime><Item><Kind><Name>少量の降灰</Name><Code>71</Code>`
        + `</Kind><Areas codeType="気象・地震・火山情報／市町村等">${Array.from({ length: areas }, (_, index) =>
          `<Area><Name>地域${period}-${index}</Name><Code>${period}${String(index).padStart(5, "0")}</Code></Area>`).join("")}</Areas></Item></AshInfo>`)
        .join("")}</AshInfos>`);
    const hour = 3_600_000;
    const decision = (periods: Parameters<typeof ash>[0]) => {
      const step = send(emptyState(), F.rapid, ash(periods));
      return step.decisions[0].decision === "rejected" ? step.decisions[0].reason : step.decisions[0].decision;
    };
    const periods = (count: number, areas = 1) => Array.from({ length: count }, () => [report, report + hour, areas] as const);
    expect([decision(periods(24)), decision(periods(25)), decision(periods(1, 256)), decision(periods(1, 257)),
      decision(periods(8, 256)), decision([...periods(8, 256), [report, report + hour, 1]]), decision([[report, report + 48 * hour, 1]]),
      decision([[report, report + 49 * hour, 1]]), decision([[report - 7 * hour, report, 1]]),
      // 各期間は通っても、合成した予報の期間が 54 時間（受理と decode の境界をそろえる、品質レビュー P1）。
      decision([[report - 6 * hour, report, 1], [report, report + 48 * hour, 1]])]).toEqual(["changed", "requiredStructureInvalid",
      "changed", "requiredStructureInvalid", "changed", "requiredStructureInvalid", "changed", "requiredStructureInvalid", "requiredStructureInvalid", "requiredStructureInvalid"]);
    // 到着の時点で予報の終わった報は採用して同じ reduce で回収し、鳴らさない。
    const late = send(emptyState(), F.rapid, undefined, at("2021-05-14T13:31:00+09:00"));
    expect([effective(late.state.ashfalls[0]), late.intents, late.displayChanges]).toEqual(["expired", [], []]);

    // VFVO53: 受信で changed/semantic・intent なし、quiet 8 秒（7,999 ms で flush しない、8,000 ms で 1 回）。
    const t0 = at("2021-05-17T14:00:00+09:00");
    const first = send(emptyState(), F.scheduled, undefined, t0, 0);
    expect([shape(first), first.intents, first.state.batch?.subjects]).toEqual([[["normal/VFVO53/506", "changed", "semantic"]], [],
      ["normal/VFVO53/506"]]);
    expect(first.nextDeadline?.monotonicMs).toBe(8_000);
    expect(tick(first.state, t0 + 7_999, 7_999).state).toBe(first.state);
    const quiet = tick(first.state, t0 + 8_000, 8_000);
    expect([quiet.state.batch, quiet.intents.length, quiet.outcomes]).toMatchObject([null, 2, [{ kind: "batchCompleted", reason: "deadline" }]]);
    // 期限の flush の通知が容量で外れただけなら、intent の配列も保存世代も変えない（訓練の batch は desktop だけ）。
    const seed = send(emptyState(), F.o1).intents[0];
    const seeds = Array.from({ length: 128 }, (_, index): VolcanoIntent => ({ ...seed, id: `seed-${index}`, createdAt: t0, expiresAt: t0 + 100_000 }));
    const crowded = { ...send(emptyState(), F.scheduled, status("訓練"), t0, 0).state, intents: seeds };
    const silent = tick(crowded, t0 + 8_000, 8_000);
    expect([silent.state.batch, silent.intents, silent.state.persistence]).toEqual([null, [], crowded.persistence]);
    expect(silent.state.intents).toBe(seeds);
    // batch の通知は前の batch の未配送の通知を置き換える（P3-C9-REPLACEMENT=A）。
    const again = send(quiet.state, F.scheduled, volcano("507", "霧島山"), t0 + 9_000, 9_000).state;
    expect(tick(again, t0 + 17_000, 17_000).state.intents.map((item) => [item.subject, item.disposition])).toEqual([
      ["normal/VFVO53/batch", "superseded"], ["normal/VFVO53/batch", "superseded"], ["normal/VFVO53/batch", "pending"], ["normal/VFVO53/batch", "pending"]]);
    // 7 秒おきの追加でも maxWait 90 秒で 1 回（13 火山、本文は「13火山: 先頭 3 火山 +10」）。
    let state = emptyState();
    for (let index = 0; index < 13; index++) state = send(state, F.scheduled, volcano(`V${index}`, `火山${index}`), t0 + index * 7_000,
      index * 7_000).state;
    expect(tick(state, t0 + 89_999, 89_999).intents).toEqual([]);
    const waited = tick(state, t0 + 90_000, 90_000);
    expect(waited.intents.map((item) => item.payload.body)).toEqual(Array(2).fill("13火山: 火山0、火山1、火山2 +10"));
    // 壁時計を 1 時間戻しても待ちが延びず、通知が重複しない。
    const backwards = tick(state, t0 - 3_600_000, 90_000);
    expect(backwards.intents).toHaveLength(2);
    expect(tick(backwards.state, t0 - 3_600_000, 98_000).intents).toEqual([]);
    // 20 件でただちに flush、鍵（ReportDateTime）の切替で先の batch を通知付きで flush。
    state = emptyState();
    const added: VolcanoUnitStep[] = [];
    for (let index = 0; index < 20; index++) { const step = send(state, F.scheduled, volcano(`W${index}`, `山${index}`), t0, index); added.push(step);
      state = step.state; }
    expect([added[18].intents, added[19].intents.length, added[19].state.batch]).toEqual([[], 2, null]);
    // 新しい報は最も重い区分を替える（旧 batch の通知が新しい報の記録を引かない、品質レビュー P2）。
    const switched = send(first.state, F.scheduled, (xml) => retime("2021-05-17T17:00:00+09:00")(xml).replaceAll("<Code>75</Code>", "<Code>70</Code>")
      .replaceAll("<Name>小さな噴石の落下</Name>", "<Name>降灰</Name>"), t0 + 1_000, 1_000);
    expect(switched.state.scheduledAshfalls[0]).toMatchObject({ topAshName: "降灰" });
    expect([switched.intents.map((item) => item.payload.body)[0], switched.state.batch?.reportDateTimeRaw])
      .toEqual(["桜島 / 降灰予報（定時） / 小さな噴石の落下", "2021-05-17T17:00:00+09:00"]);
    // VFVO54 の受理の前の無音 flush（interrupted）、ほかの火山の報（噴火）では止まらない。取消は batch から外す。shutdown は無音。
    const ashAt = at("2021-05-14T12:40:00+09:00");
    const waiting = send(emptyState(), F.scheduled, retime("2021-05-14T12:39:00+09:00"), ashAt - 60_000, 0).state;
    const interrupted = send(waiting, F.rapid, undefined, ashAt, 1_000);
    // 採用した 54/55 だけが flush する。duplicate の再送では待機中の batch を消さない（Q-C9-IMPL-AMEND(6)）。
    const rewaiting = send(interrupted.state, F.scheduled, retime("2021-05-14T12:39:00+09:00"), ashAt, 2_000).state;
    expect(send(rewaiting, F.rapid, undefined, ashAt, 3_000).state.batch).toBe(rewaiting.batch);
    expect([interrupted.state.batch, interrupted.outcomes[0], levels(interrupted)]).toMatchObject([null,
      { kind: "batchCompleted", reason: "interrupted" }, ["desktop:warning", "sound:warning"]]);
    expect(send(first.state, F.o1, undefined, t0 + 1_000, 1_000).state.batch).toBe(first.state.batch);
    const withdrawn = send(first.state, F.scheduled, (xml) => replaceTag("InfoType", "取消")(retime("2021-05-17T14:01:00+09:00")(xml)),
      t0 + 1_000, 1_000);
    expect([withdrawn.state.batch, levels(withdrawn), withdrawn.intents[0]?.subject]).toEqual([null, ["desktop:cancel", "sound:cancel"],
      "normal/VFVO53/506"]);
    const stopped = reduceVolcanoUnit(first.state, { kind: "shutdown", clock: clock(t0 + 1_000, 1_000) });
    expect([stopped.state.batch, stopped.intents, stopped.outcomes]).toMatchObject([null, [], [{ kind: "batchCompleted", reason: "shutdown",
      subjects: [{ subject: "normal/VFVO53/506" }] }]]);
  });

  // contractBoundary: P3-C9-CAPACITY=A と受信 1 回の費用（AC06）。境界入力は試験内で作る。
  it("P3-C9-T05 contractBoundary / AC06: 127/128/129 records, eviction order, code and value bounds, pending and terminal budgets, no whole encode", () => {
    const now = at("2020-05-22T15:00:00+09:00");
    const seed = send(emptyState(), F.o1).state.eruptions[0];
    if (seed.effective !== "active") throw new Error("inactive seed");
    const eruption = (index: number, patch: Partial<{ operation: Operation; minutes: number; retainUntil: number; cancelled: boolean }> = {}):
      VolcanoEruption => {
      const operation = patch.operation ?? "normal", eventId = `E${String(index).padStart(5, "0")}`, subject = `${operation}/volcano:eruption/${eventId}`;
      const reported = now - (patch.minutes ?? 200 - index) * 60_000;
      const source = { ...seed.source, operation, subject, reportDateTimeRaw: iso(reported) };
      return patch.cancelled ? { subject, operation, eventId, source, retainUntil: patch.retainUntil ?? reported + 2 * DAY, volcanoCode: "306",
        effective: "cancelled" } : { ...seed, subject, operation, eventId, source, retainUntil: patch.retainUntil ?? reported + 2 * DAY,
        validUntil: reported + DAY };
    };
    const report = (eventId: string, mark = "通常") => decodeFixture(F.o1, (xml) => status(mark)(retime("2020-05-22T15:00:00+09:00")(
      replaceTag("EventID", eventId)(xml))));
    const filled = (values: readonly VolcanoEruption[]): VolcanoUnitState => ({ ...emptyState(), eruptions: values });
    expect(receive(filled(Array.from({ length: 127 }, (_, index) => eruption(index))), report("N1"), clock(now)).diagnostics).toEqual([]);
    const full = Array.from({ length: 128 }, (_, index) => eruption(index));
    const pushed = receive(filled(full), report("N1"), clock(now));
    expect(pushed.diagnostics).toEqual([{ level: "INFO", component: "volcano", reason: "volcanoCapacityEvicted", unit: "U-V", count: 1 }]);
    expect([pushed.state.eruptions.length, pushed.state.eruptions.includes(full[0])]).toEqual([128, false]);
    // 退去の順: (1) retainUntil を過ぎたもの → (2) inactive → (3) training/test → (4) normal の最古。capacityExceeded を返さない。
    let state = filled([eruption(0), eruption(1, { operation: "training" }), eruption(2, { cancelled: true }), eruption(3, { retainUntil: now }),
      ...Array.from({ length: 124 }, (_, index) => eruption(index + 10))]);
    const evicted: string[] = [];
    for (const eventId of ["N2", "N3", "N4", "N5"]) {
      const before = state.eruptions.map((item) => item.subject);
      const step = receive(state, report(eventId), clock(now));
      expect(step.decisions[0].decision).toBe("changed");
      state = step.state;
      evicted.push(...before.filter((subject) => !state.eruptions.some((item) => item.subject === subject)));
    }
    expect(evicted).toEqual([eruption(3).subject, eruption(2).subject, eruption(1, { operation: "training" }).subject, eruption(0).subject]);
    // normal の active だけの満杯に training の報を受けたら、その記録自身を退去する（normal を退去させない）。
    const self = receive(filled(full), report("T1", "訓練"), clock(now));
    expect([shape(self), self.state.eruptions, self.intents, self.diagnostics]).toEqual([[["training/volcano:eruption/T1", "changed", "semantic"]],
      full, [], [{ level: "INFO", component: "volcano", reason: "volcanoCapacityEvicted", unit: "U-V", count: 1 }]]);
    // 解説は 64/65 件（保存しない系列）。
    const heading = send(emptyState(), F.b350).state.bulletins[0];
    const bulletins = Array.from({ length: 64 }, (_, index): VolcanoBulletin => ({ ...heading, subject: `normal/VFVO51/B${index}`, eventId: `B${index}`,
      source: { ...heading.source, subject: `normal/VFVO51/B${index}` } }));
    const bulletin = send({ ...emptyState(), bulletins }, F.b350);
    expect([bulletin.state.bulletins.length, bulletin.diagnostics]).toMatchObject([64, [{ reason: "volcanoCapacityEvicted", count: 1 }]]);
    // MaterialValue の text は 32 文字で切って truncated。上限 +1 の名前も同じ。
    const long = send(emptyState(), F.plume, (xml) => xml.replace(/>3000<\/jmx_eb:PlumeHeightAboveCrater>/, `>${"あ".repeat(33)}</jmx_eb:PlumeHeightAboveCrater>`)
      .replace(' condition="以上"', ""));
    expect(long.state.eruptions[0]).toMatchObject({ truncated: true, plumeAboveCrater: { kind: "text", value: "あ".repeat(32), raw: "あ".repeat(32) } });
    // P1 は condition「以上」だけでは range にしない（値は P1 のまま、I-U-V.eruptionSemantics）。
    expect(send(emptyState(), F.plume).state.eruptions[0]).toMatchObject({ truncated: false, plumeAboveCrater: { kind: "number", value: 3000 } });
    expect(alertOf(send(emptyState(), F.a306, (xml) => xml.replaceAll("<Name>浅間山</Name>", `<Name>${"山".repeat(33)}</Name>`)).state, "306"))
      .toMatchObject({ volcanoName: "山".repeat(32), truncated: true });

    // pending 128/129 件と 131,072/131,073 byte（予約は delivery-growth.ts の deliveryGrowth と同じ値）。
    const reported = at("2020-05-22T14:49:00+09:00");
    const template = send(emptyState(), F.o1).intents[0];
    const seeded = (count: number, pad = 0): VolcanoIntent[] => Array.from({ length: count }, (_, index) => ({ ...template, id: `seed-${index}`,
      subject: `normal/volcano:eruption/S${index}`, source: { ...template.source, subject: `normal/volcano:eruption/S${index}` },
      payload: { ...template.payload, body: index === 0 ? "x".repeat(1 + pad) : "x" }, createdAt: reported - 1000, expiresAt: reported + 179_000 }));
    const fits = send({ ...emptyState(), intents: seeded(126) }, F.o1);
    expect([fits.intents.length, pending(fits.state).length, fits.diagnostics]).toEqual([2, 128, []]);
    const over = send({ ...emptyState(), intents: seeded(127) }, F.o1);
    expect([over.intents.map((item) => item.channel), over.diagnostics]).toMatchObject([["sound"], [{ reason: "notificationCapacityEvicted", count: 1 }]]);
    const bytesOf = (values: readonly VolcanoIntent[]) => Buffer.byteLength(JSON.stringify(values));
    const fresh = send(emptyState(), F.o1).intents;
    const pad = 131_072 - bytesOf([...seeded(10), ...fresh]) - [...seeded(10), ...fresh].reduce((sum, item) => sum + deliveryGrowth(item), 0);
    expect(pending(send({ ...emptyState(), intents: seeded(10, pad) }, F.o1).state)).toHaveLength(12);
    expect(send({ ...emptyState(), intents: seeded(10, pad + 1) }, F.o1).intents.map((item) => item.channel)).toEqual(["sound"]);
    // 新しい intent が容量で外れただけなら intent の配列も保存世代も変えない（保存しない解説だけの変化、品質レビュー P3）。
    const crowded: VolcanoUnitState = { ...emptyState(), intents: seeded(128) };
    const dropped = send(crowded, F.notice, (xml) => status("訓練")(retime(iso(reported))(xml)), reported);
    expect([dropped.intents, dropped.diagnostics]).toEqual([[], [{ level: "INFO", component: "volcano", reason: "notificationCapacityEvicted",
      unit: "U-V", count: 1 }]]);
    expect([dropped.state.intents, dropped.state.persistence]).toEqual([crowded.intents, crowded.persistence]);
    expect(dropped.state.intents).toBe(crowded.intents);
    // 配送の更新で attempts が 1 桁から 5 桁・nextAttemptAt の桁が増えても、予約の内側で decode が受ける。
    const budget = send({ ...emptyState(), intents: seeded(10, pad) }, F.o1).state;
    const grown = reduceVolcanoUnit(budget, { kind: "intentUpdate", clock: clock(reported), intentUpdate: pending(budget).map((item) => ({ id: item.id,
      attempts: 12_345, nextAttemptAt: reported + 0.123456, disposition: "pending" as const })) });
    expect(roundTrip(grown.state).kind).toBe("restored");

    // I-U-V.capacityMeasurement の同時最大状態（実例の最大）と、上限の文字列での上界。どちらも encode でき 4,194,304 byte 以下で decode が受ける。
    const real = budgetState(false), bound = budgetState(true);
    const sizes = [real, bound].map((item) => Buffer.byteLength(JSON.stringify(volcanoUnitCodec.encode(item))));
    const one = (value: object) => Buffer.byteLength(JSON.stringify(value));
    console.info("P3-C9 capacity", JSON.stringify({ realPayload: sizes[0], contractReal: 696_093, boundPayload: sizes[1], contractBound: 3_829_597,
      realAlert: one(alertOf(send(emptyState(), F.a350, (xml) => xml.replaceAll("<Code>11</Code>", "<Code>13</Code>")).state, "350")!),
      realMarine: one(alertOf(send(emptyState(), F.marine).state, "506")!), realEruption: one(send(emptyState(), F.plume).state.eruptions[0]),
      realFlash: one(send(emptyState(), F.e1).state.eruptions[0]), realAshfall: one(send(emptyState(), F.rapid).state.ashfalls[0]),
      realDetail: one(send(emptyState(), F.detail).state.ashfalls[0]), realIntent: one(send(emptyState(), F.a306).intents[0]),
      boundAlert: one(bound.alerts[0]), boundEruption: one(bound.eruptions[0]), boundAshfall: one(bound.ashfalls[0]),
      boundShortfall: one(bound.shortfalls[0]), counts: [real.intents.length, bound.intents.length] }));
    for (const item of [real, bound]) expect(roundTrip(item).kind).toBe("restored");
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4_194_304);

    // 保持上限付近と全国の VFVO51 で、受信 1 回は記録単位の加算だけ（state・配列・既存の記録を直列化しない）。
    const near = { ...real, bulletins: [] };
    const national = decodeFixture(F.national, retime("2026-01-01T00:00:00+09:00"));
    // 1 回目で記録ごとの byte を測って保持する（記録単位の加算。2 回目に既存の記録を直列化し直さないことを確かめる）。
    receive(near, national, clock(at("2026-01-01T00:00:00+09:00")));
    receive(near, report("N9"), clock(now));
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      receive(near, national, clock(at("2026-01-01T00:00:00+09:00")));
      receive(near, report("N9"), clock(now));
      const whole = new Set<unknown>([near, near.alerts, near.eruptions, near.ashfalls, near.intents, ...near.alerts, ...near.eruptions,
        ...near.ashfalls, ...near.intents]);
      expect(stringify.mock.calls.filter(([value]) => whole.has(value))).toEqual([]);
    } finally { stringify.mockRestore(); }
    // ponytail の上限（I-U-V.computation）: 満杯の警報に全国の VFVO51 を受ける 1 回の処理（112 entry × 128 件）を測って報告する。
    const fullAlerts = { ...emptyState(), alerts: real.alerts };
    const times: number[] = [];
    for (let run = 0; run < 1_000; run++) {
      const started = performance.now();
      receive(fullAlerts, national, clock(at("2026-01-01T00:00:00+09:00")));
      times.push(performance.now() - started);
    }
    times.sort((left, right) => left - right);
    console.info("P3-C9 national VFVO51 on 128 alerts (ms)", JSON.stringify({ median: times[500], max: times.at(-1), runs: 1_000 }));
  });

  // contractBoundary: I-U-V.persisted・I-U-V.decode、復元で intent を作らない（AC07）。
  it("P3-C9-T06 contractBoundary / AC07: one codec, persisted fields only, every decode check and restore without new intents", () => {
    const at15 = at("2020-05-22T15:00:00+09:00");
    let state = chain([F.a306, F.o1]).at(-1)!.state;
    state = send(send(state, F.b350, undefined, at15).state, F.marine, retime("2020-05-22T15:00:00+09:00")).state;
    // 降灰・定時は元の時刻のまま 15:00 に受ける（期限は元報の時刻から数える）。
    state = send(send(state, F.rapid, undefined, at15).state, F.scheduled, undefined, at15).state;
    state = { ...state, shortfalls: [shortfall("s1", "volcano", "306"), shortfall("s2", "domain", null)] };
    const payload = JSON.parse(JSON.stringify(volcanoUnitCodec.encode(state))) as JsonValue;
    expect(Object.keys(payload as object).sort()).toEqual(["alerts", "ashfalls", "eruptions", "intents", "schemaVersion", "shortfalls"]);
    expect(volcanoUnitCodec.decode(payload)).toEqual({ kind: "restored", state: { ...state, contentRevision: 0, scheduledAshfalls: [], batch: null,
      bulletins: [], persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } } });
    type Row = Record<string, unknown>;
    const value = payload as { alerts: Row[]; eruptions: Row[]; ashfalls: Row[]; shortfalls: Row[]; intents: Row[] };
    const [alert] = value.alerts, [eruption] = value.eruptions, [ashfall] = value.ashfalls, [intent] = value.intents;
    const source = alert.source as Row;
    const many = <T>(length: number, make: (index: number) => T): T[] => Array.from({ length }, (_, index) => make(index));
    const withAlert = (patch: Row) => ({ ...value, alerts: [{ ...alert, ...patch }] });
    const group = (ashfall.groups as Row[])[0];
    const invalid: [string, unknown][] = [
      ["schemaVersion", { ...value, schemaVersion: "p3-volcano-unit-v0" }],
      ["alerts > 128", { ...value, alerts: many(129, (index) => ({ ...alert, volcanoCode: `V${index}`, subject: `normal/volcano:alert/V${index}`,
        source: { ...source, subject: `normal/volcano:alert/V${index}` }, marineSource: null, retainUntil: Number(alert.retainUntil) })) }],
      ["duplicate alert", { ...value, alerts: [alert, alert] }],
      ["subject and code", withAlert({ subject: "normal/volcano:alert/999" })],
      ["subject and operation", withAlert({ subject: "training/volcano:alert/306" })],
      ["EventID not printable ASCII", withAlert({ eventId: "火山" })],
      ["volcano code over 16 bytes", withAlert({ volcanoCode: "3".repeat(17) })],
      ["inputId over 64", withAlert({ source: { ...source, inputId: "i".repeat(65) } })],
      ["ReportDateTime over 40", withAlert({ source: { ...source, reportDateTimeRaw: "2020-05-22T13:03:00.0000000000000000+09:00" } })],
      ["Serial over 10 digits", withAlert({ source: { ...source, serialRaw: "12345678901" } })],
      ["InfoType", withAlert({ source: { ...source, infoTypeRaw: "不明" } })],
      ["source family", withAlert({ source: { ...source, family: "VFSV50" } })],
      ["no watermark", withAlert({ source: null, marineSource: null })],
      ["ended keeps facts", withAlert({ effective: "ended" })],
      ["inactive kind while active", withAlert({ kind: { code: "11", name: "x", condition: null }, level: null })],
      ["level and code", withAlert({ level: 2 })],
      ["retainUntil", withAlert({ retainUntil: Number(alert.retainUntil) + 1 })],
      ["headline over 256", withAlert({ headline: "x".repeat(257) })],
      ["kind code over 8", withAlert({ kind: { code: "123456789", name: "x", condition: null }, level: null })],
      ["municipality groups over 8", withAlert({ municipalities: many(9, () => ({ kindName: "x", codes: [] })) })],
      ["coordinate over 40", withAlert({ coordinate: "+".repeat(41) })],
      ["landKind code over 8", withAlert({ landKind: { code: "123456789", name: "x", condition: null } })],
      ["eruption validUntil", { ...value, eruptions: [{ ...eruption, validUntil: Number(eruption.validUntil) + 1 }] }],
      ["eruption value over 32", { ...value, eruptions: [{ ...eruption, plumeAboveCrater: { kind: "text", value: "x".repeat(33), raw: "x" } }] }],
      ["ashfall retainUntil", { ...value, ashfalls: [{ ...ashfall, retainUntil: Number(ashfall.retainUntil) + 1 }] }],
      ["ashfall span", { ...value, ashfalls: [{ ...ashfall, forecastEndsAt: Number(ashfall.forecastStartsAt) + 49 * 3_600_000 }] }],
      ["ashfall top areas", { ...value, ashfalls: [{ ...ashfall, groups: [{ ...group, areaCount: Number(group.areaCount) + 1 }] }] }],
      ["ashfall groups over 8", { ...value, ashfalls: [{ ...ashfall, groups: many(9, () => group) }] }],
      ["shortfalls > 128", { ...value, shortfalls: many(129, (index) => ({ ...value.shortfalls[0], id: `s${index}` })) }],
      ["shortfall domain with code", { ...value, shortfalls: [{ ...value.shortfalls[1], volcanoCode: "306" }] }],
      ["shortfall volcano without code", { ...value, shortfalls: [{ ...value.shortfalls[0], volcanoCode: null }] }],
      ["pending > 128", { ...value, intents: many(129, (index) => ({ ...intent, id: `pending-${index}`, disposition: "pending" })) }],
      ["pending + delivery reserve > 131072 bytes", { ...value, intents: reserveOver(intent) }],
      ["attempts negative", { ...value, intents: [{ ...intent, attempts: -1 }] }],
      ["nextAttemptAt not finite", { ...value, intents: [{ ...intent, nextAttemptAt: null }] }],
      ["pending + terminal > 229,376 bytes", { ...value, intents: terminalOver(intent) }],
      ["intent of another unit", { ...value, intents: [{ ...intent, unit: "U-N" }] }],
      ["intent subject form", { ...value, intents: [{ ...intent, subject: "normal/VYSE50/1", source: { ...(intent.source as Row), subject: "normal/VYSE50/1" } }] }],
    ];
    for (const [name, candidate] of invalid) expect(volcanoUnitCodec.decode(candidate as JsonValue).kind, name).toBe("invalid");
    // 解説・定時は復元で空なので、その subject の intent が state に無いことは unavailable の理由にしない。
    expect(value.intents.some((item) => String(item.subject).includes("/VFVO51/"))).toBe(true);

    // 復元で intent を作らず、pending の期限を延ばさない。
    const restoredAt = at("2020-05-22T15:00:30+09:00");
    const restored = reduceVolcanoUnit(emptyState(), { kind: "restore", persisted: volcanoUnitCodec.encode(state), clock: clock(restoredAt) });
    expect(restored.intents).toEqual([]);
    expect(restored.state.intents).toEqual(state.intents.filter((item) => item.expiresAt > restoredAt));
    expect(restored.state.intents.length).toBeGreaterThan(0);
    expect([restored.state.scheduledAshfalls, restored.state.bulletins, restored.state.batch]).toEqual([[], [], null]);
    expect(restored.outcomes).toMatchObject([{ kind: "recoveryApplied", scope: ["U-V"] }]);
  });

  // acceptance: Q-NOTICE の火山分（AC09）。
  it("P3-C9-T07 acceptance / AC09: opportunities, the NOTICE-LEVELS=C table, replacement, title/body, intentUpdate, training and restart", () => {
    // 警報の段階: 引上げのレベル 4 以上 critical・2 以上 warning、非数値の区分（22→2・23→3・36→2）と表に無い code は warning。
    const raise = (code: string, condition = "引上げ") => levels(send(emptyState(), F.a306, (xml) => xml.replaceAll("<Code>13</Code>",
      `<Code>${code}</Code>`).replaceAll("<Condition>引上げ</Condition>", `<Condition>${condition}</Condition>`)))[0];
    expect(["15", "14", "13", "12", "22", "23", "36", "99"].map((code) => raise(code))).toEqual(["desktop:critical", "desktop:critical",
      ...Array(6).fill("desktop:warning")]);
    expect([raise("13", "継続"), raise("11", "引下げ"), raise("11", "継続"), raise("21", "発表")]).toEqual(["desktop:normal", "desktop:normal",
      "desktop:info", "desktop:info"]);
    expect(levels(send(emptyState(), F.marine))).toEqual(["desktop:warning", "sound:warning"]);
    // 噴火: 噴火速報 critical、噴火観測報は爆発・噴火多発か火口上 3,000m 以上で normal、ほかは info。
    expect([levels(send(emptyState(), F.e1))[0], levels(send(emptyState(), F.o1))[0], levels(send(emptyState(), F.o2))[0],
      levels(send(emptyState(), F.plume))[0]]).toEqual(["desktop:critical", "desktop:info", "desktop:normal", "desktop:normal"]);
    // 解説: 全国の定例（44_01_01）は 23・22・36 を含んでも info、臨時（44_03_01）は normal。推定噴煙流向報・お知らせは info。降灰の速報 warning・詳細 normal。
    expect([F.national, F.b350x, F.flow, F.notice, F.rapid, F.detail].map((name) => levels(send(emptyState(), name))[0])).toEqual([
      "desktop:info", "desktop:normal", "desktop:info", "desktop:info", "desktop:warning", "desktop:normal"]);
    // title・body の組み方（旧築 notifier.ts の notifyVolcano と volcano-presentation.ts の要約）。
    const payload = (step: VolcanoUnitStep) => [step.intents[0].payload.title, step.intents[0].payload.body];
    expect([payload(send(emptyState(), F.a306)), payload(send(emptyState(), F.e1)), payload(send(emptyState(), F.plume)),
      payload(send(emptyState(), F.rapid)), payload(send(emptyState(), F.flow)), payload(send(emptyState(), F.notice))]).toEqual([
      ["噴火警報（火口周辺）", "浅間山 / Lv3 / レベル３（入山規制）"], ["噴火速報", "御嶽山 / 噴火"], ["噴火に関する火山観測報", "浅間山 / 噴火 / 噴煙3000m"],
      ["降灰予報（速報）", "桜島 / 降灰予報（速報） / 小さな噴石の落下"], ["桜島　推定噴煙流向報", "桜島 推定噴煙流向報"],
      ["火山に関するお知らせ", "噴火警報及び噴火予報の発表開始のお知らせ"]]);
    expect(payload(send(send(emptyState(), F.o1).state, F.o3, (xml) => replaceTag("EventID", "20200522144900_306")(xml))))
      .toEqual(["[取消] 噴火に関する火山観測報", "この情報は取り消されました"]);
    // revisionOnly・noChange・duplicate・記憶だけの取消では作らない。訂正は事実が同じでも作る。VFVO51 は複数火山が変わっても 1 件。
    const alert = send(emptyState(), F.a306);
    expect(send(alert.state, F.a306, retime("2020-05-22T13:04:00+09:00")).intents).toEqual([]);
    expect(send(emptyState(), F.e4).intents).toEqual([]);
    const corrected = send(alert.state, F.a306, replaceTag("InfoType", "訂正"));
    expect([shape(corrected)[0].slice(1), corrected.intents.map((item) => [item.transition, item.payload.title, item.payload.body.startsWith("訂正: ")])])
      .toEqual([["changed", "revisionOnly"], [["updated", "[訂正] 噴火警報（火口周辺）", true], ["updated", "[訂正] 噴火警報（火口周辺）", true]]]);
    // 置換（P3-C9-REPLACEMENT=A）: 同じ subject・channel の新しい intent は古い pending を、取消は対象 subject の全 pending を置き換える。
    const replaced = send(alert.state, F.continuation, retime("2020-05-22T13:03:30+09:00")).state;
    expect(replaced.intents.map((item) => item.disposition)).toEqual(["superseded", "superseded", "pending", "pending"]);
    const cancelled = send(replaced, F.alertCancel, retime("2020-05-22T13:03:40+09:00")).state;
    expect(pending(cancelled).map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
    expect(send(alert.state, F.o1, undefined, at("2020-05-22T13:03:10+09:00")).state.intents.slice(0, 2)).toEqual(alert.state.intents);
    // intentUpdate: 既存 id だけを一括で更新し、保存世代を 1 つ進める。未知 id・同値は no-op。
    const [desktop] = alert.intents;
    const updated = reduceVolcanoUnit(alert.state, { kind: "intentUpdate", clock: clock(desktop.createdAt), intentUpdate: [{ id: desktop.id,
      attempts: 1, nextAttemptAt: desktop.createdAt + 1_000, disposition: "pending" }, { id: "unknown", attempts: 1, nextAttemptAt: 0,
      disposition: "delivered" }] });
    expect([updated.state.persistence.currentGeneration, updated.decisions]).toMatchObject([alert.state.persistence.currentGeneration + 1,
      [{ decision: "changed", change: "deliveryOnly" }]]);
    expect(reduceVolcanoUnit(updated.state, { kind: "intentUpdate", clock: clock(desktop.createdAt), intentUpdate: { id: desktop.id, attempts: 1,
      nextAttemptAt: desktop.createdAt + 1_000, disposition: "pending" } }).state).toBe(updated.state);
    // 復元直後の続報は復元した三 slice との差で決める（同じ報は duplicate で鳴らさない、継続は info）。試験は desktop だけ。
    const restored = reduceVolcanoUnit(emptyState(), { kind: "restore", persisted: volcanoUnitCodec.encode(alert.state),
      clock: clock(desktop.createdAt + 1) }).state;
    expect(send(restored, F.a306).intents).toEqual([]);
    expect(levels(send(restored, F.continuation))).toEqual(["desktop:info", "sound:info"]);
    expect(send(emptyState(), F.e1, status("試験")).intents.map((item) => [item.channel, item.payload.title])).toEqual([["desktop", "【試験】噴火速報"]]);
    // 保存しない系列（解説）だけの変化では保存世代を進めない。
    const bulletin = send(emptyState(), F.notice).state;
    expect(send(bulletin, F.notice, retime("2007-11-30T06:00:30+09:00")).state.persistence).toBe(bulletin.persistence);
  });

  // contractBoundary: E22 の U-V は対象外（P3-C9-N2、AC15）。
  it("P3-C9-T11 contractBoundary / AC15: origin=recovery is not applied", () => {
    const state = send(emptyState(), F.a306).state;
    const recovery = receive(state, decodeXml(fixtureXml(F.continuation), "VFVO50", "recovered", "recovery"), clock(at("2020-05-22T14:54:00+09:00")));
    expect(recovery.state).toBe(state);
    expect(recovery.decisions).toMatchObject([{ decision: "unchanged", reason: "noChange" }]);
    expect([recovery.intents, recovery.outcomes, recovery.confirmationEvidence, recovery.displayChanges]).toEqual([[], [], [], []]);
  });

  // 実不具合の再発防止（品質レビュー P1・統合担当の決定 7）: VFVO50 の source がある記録への VFSV の取消は海上の部分だけを取り消す。
  it("P3-C9-T02 regression / AC02,AC09: a VFSV cancel on a record with a VFVO50 source withdraws only the marine part", () => {
    const marine = (code: string, iso: string, cancel = false) => (xml: string) => {
      const next = retime(iso)(xml).replaceAll("<Code>506</Code>", `<Code>${code}</Code>`);
      return cancel ? replaceTag("InfoType", "取消")(next) : next;
    };
    // VFVO50 のレベル 1（ended）の後に VFSV の 36 で active になった記録は、VFSV の取消で ended に戻り、期限で消える（保存・復元の後も）。
    const lowered = send(emptyState(), F.a350).state;
    const raised = send(lowered, F.marine, marine("350", "2020-07-31T11:10:00+09:00")).state;
    expect(alertOf(raised, "350")).toMatchObject({ effective: "active", kind: { code: "36" } });
    const withdrawn = send(raised, F.marine, marine("350", "2020-07-31T11:20:00+09:00", true));
    expect([effective(alertOf(withdrawn.state, "350")), levels(withdrawn)]).toEqual(["ended", ["desktop:cancel", "sound:cancel"]]);
    const restored = roundTrip(withdrawn.state);
    if (restored.kind !== "restored") throw new Error("withdrawn state does not decode");
    expect(effective(alertOf(restored.state, "350"))).toBe("ended");
    expect(tick(restored.state, at("2020-07-31T11:20:00+09:00") + 30 * DAY).state.alerts).toEqual([]);
    // VFVO50 の区分（13）が新しい記録は active を保ち、海上予報区だけを消す。VFVO50 の pending は残り、通知は海上警報の取消と分かる形。
    const both = send(send(emptyState(), F.marine, marine("306", "2020-05-22T13:02:00+09:00")).state, F.a306).state;
    const partial = send(both, F.marine, marine("306", "2020-05-22T13:03:30+09:00", true));
    expect(alertOf(partial.state, "306")).toMatchObject({ effective: "active", kind: { code: "13" }, marineAreas: [] });
    expect(partial.state.intents.filter((item) => item.source.family === "VFVO50").map((item) => item.disposition)).toEqual(["pending", "pending"]);
    expect(partial.intents.map((item) => [item.payload.level, item.payload.title, item.payload.body])).toEqual(Array(2).fill(["cancel",
      "[取消] 火山現象に関する海上警報", "火山現象に関する海上警報・海上予報が取り消されました"]));
    // VFVO50 と VFSV が同じ区分（36）で VFSV が新しくても、VFSV の取消の後は VFVO50 の区分（landKind）が active を支える。
    const sea = send(emptyState(), F.a306, (xml) => xml.replaceAll("<Code>13</Code>", "<Code>36</Code>")).state;
    const seaMarine = send(sea, F.marine, marine("306", "2020-05-22T13:10:00+09:00")).state;
    const seaWithdrawn = send(seaMarine, F.marine, marine("306", "2020-05-22T13:20:00+09:00", true)).state;
    expect(alertOf(seaWithdrawn, "306")).toMatchObject({ effective: "active", kind: { code: "36" }, landKind: { code: "36" }, marineAreas: [] });
    // VFVO50(11) → VFSV(36) → VFVO51 の entry(36、表示と同じ) → VFSV の取消でも、VFVO51 が伝えた 36 が active を支える（保存・復元の後も）。
    const level1 = send(emptyState(), F.a306, (xml) => xml.replaceAll("<Code>13</Code>", "<Code>11</Code>").replaceAll("<Condition>引上げ</Condition>",
      "<Condition>引下げ</Condition>")).state;
    const viaMarine = send(level1, F.marine, marine("306", "2020-05-22T13:10:00+09:00")).state;
    const entry = send(viaMarine, F.b350, (xml) => retime("2020-05-22T13:15:00+09:00")(xml).replaceAll(">350<", ">306<")
      .replaceAll("<Code>12</Code>", "<Code>36</Code>"));
    expect([shape(entry)[1], levels(entry).length, alertOf(entry.state, "306")]).toMatchObject([["normal/volcano:alert/306", "changed", "revisionOnly"],
      2, { kind: { code: "36" }, landKind: { code: "36" } }]);
    const lastCancel = roundTrip(send(entry.state, F.marine, marine("306", "2020-05-22T13:20:00+09:00", true)).state);
    if (lastCancel.kind !== "restored") throw new Error("the cancelled state does not decode");
    expect(alertOf(lastCancel.state, "306")).toMatchObject({ effective: "active", kind: { code: "36" } });
    // VFVO50(36、解除) → VFSV(36) → VFVO51 の entry(36 継続) → VFSV の取消: VFVO51 の新しい版が landKind を「継続」に進めるので active が残る。
    const released = send(emptyState(), F.a306, (xml) => xml.replaceAll("<Code>13</Code>", "<Code>36</Code>").replaceAll("<Condition>引上げ</Condition>",
      "<Condition>解除</Condition>")).state;
    const resumed = send(send(released, F.marine, marine("306", "2020-05-22T13:10:00+09:00")).state, F.b350, (xml) =>
      retime("2020-05-22T13:15:00+09:00")(xml).replaceAll(">350<", ">306<").replaceAll("<Code>12</Code>", "<Code>36</Code>")).state;
    expect(alertOf(resumed, "306")).toMatchObject({ landKind: { code: "36", condition: "継続" } });
    expect(alertOf(send(resumed, F.marine, marine("306", "2020-05-22T13:20:00+09:00", true)).state, "306")).toMatchObject({ effective: "active",
      kind: { code: "36" } });
    // 同じ形を VFVO50 自身の継続報（表示と同じ 36）でも確かめる: landKind と source は進み、VFSV の取消の後も active が残る。
    const continued = send(viaMarine, F.a306, (xml) => retime("2020-05-22T13:15:00+09:00")(xml).replaceAll("<Code>13</Code>", "<Code>36</Code>")
      .replaceAll("<Condition>引上げ</Condition>", "<Condition>継続</Condition>")).state;
    expect(alertOf(continued, "306")).toMatchObject({ kind: { code: "36" }, landKind: { code: "36" } });
    expect(alertOf(send(continued, F.marine, marine("306", "2020-05-22T13:20:00+09:00", true)).state, "306")).toMatchObject({ effective: "active" });
  });

  // acceptance: 復旧不足（P3-C9-SHORTFALL=A、AC16）。
  it("P3-C9-T12 acceptance / AC16: restored shortfalls in the view, live removal and the three explicit resolutions", () => {
    const base = send(send(emptyState(), F.a306).state, F.o1).state;
    const restoredAt = at("2020-05-22T14:50:00+09:00");
    const withShortfalls = { ...base, shortfalls: [shortfall("old", "volcano", "306", "2020-05-22T15:00:00+09:00"),
      shortfall("new", "volcano", "306", "2020-05-22T12:00:00+09:00"), shortfall("domain", "domain", null), shortfall("erupt", "volcano", "306", null,
        "eruption")] };
    const restored = reduceVolcanoUnit(emptyState(), { kind: "restore", persisted: volcanoUnitCodec.encode(withShortfalls), clock: clock(restoredAt) });
    expect(toVolcanoView(restored.state).shortfalls.map((item) => item.id)).toEqual(["old", "new", "domain", "erupt"]);
    // live の新しい報で volcano scope の不足が消え、古い報（lastKnown より前）と domain scope は消えない。
    const live = send(restored.state, F.continuation);
    expect(live.state.shortfalls.map((item) => item.id)).toEqual(["old", "domain", "erupt"]);
    expect(live.state.contentRevision).toBe(restored.state.contentRevision + 1);
    const resolve = (state: VolcanoUnitState, id: string, action: "acceptCurrent" | "clearCurrent" | "acknowledgeDomainLoss") =>
      reduceVolcanoUnit(state, { kind: "shortfallResolution", id, action, clock: clock(restoredAt + 1) });
    const accepted = resolve(live.state, "old", "acceptCurrent");
    expect([accepted.state.shortfalls.map((item) => item.id), accepted.state.alerts, shape(accepted)]).toEqual([["domain", "erupt"], live.state.alerts,
      [["normal/shortfall/old", "changed", "semantic"]]]);
    const cleared = resolve(live.state, "erupt", "clearCurrent");
    expect([cleared.state.eruptions.map((item) => item.effective), cleared.state.alerts, cleared.intents]).toEqual([["expired"], live.state.alerts, []]);
    const clearedAlert = resolve(restored.state, "old", "clearCurrent");
    expect(clearedAlert.state.alerts.map((item) => item.effective)).toEqual(["ended"]);
    expect(resolve(live.state, "domain", "acknowledgeDomainLoss").state.shortfalls.map((item) => item.id)).toEqual(["old", "erupt"]);
    // 合わない id・action は noChange（同じ state 参照）、通知を作らない。
    for (const [id, action] of [["missing", "acceptCurrent"], ["domain", "acceptCurrent"], ["old", "acknowledgeDomainLoss"]] as const) {
      const step = resolve(live.state, id, action);
      expect([step.state, shape(step)[0].slice(1), step.intents]).toEqual([live.state, ["unchanged", "noChange"], []]);
    }
  });

  // 実不具合の再発防止の型（C8 の Q-C8-IMPL-AMEND(1)(2) を U-V で）: owner を通した更新・保存・復元。
  it("P3-C9-T05 contractBoundary / AC06: an owner terminal update at the terminal budget and pending at its budget survive save and restore", () => {
    const reported = at("2020-05-22T14:49:00+09:00");
    const template = send(emptyState(), F.o1).intents[0];
    const terminalBytes = (values: readonly VolcanoIntent[]) => values.filter((item) => item.disposition !== "pending")
      .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + 1, 0);
    const old: VolcanoIntent = { ...template, id: "old-pending", createdAt: reported - 100_000, expiresAt: reported + 80_000 };
    const done = (index: number): VolcanoIntent => ({ ...template, id: `done-${index}`, createdAt: reported + index, disposition: "delivered" });
    let count = 0;
    while (terminalBytes(Array.from({ length: count + 1 }, (_, index) => done(index))) <= 98_304) count++;
    const now = clock(reported + 1_000);
    const empty = restoreOwner({ runId: "run", place: "urgent", clock: now, restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const owner = { ...empty, units: { ...empty.units, "U-V": { ...emptyState(), intents: [old, ...Array.from({ length: count }, (_, index) => done(index))] } } };
    const updated = intentUpdateOwner(owner, "U-V", [{ id: old.id, attempts: 1, nextAttemptAt: now.wallTimeMs, disposition: "delivered" }], now,
      linkedUnitTable);
    expect(updated.adopted).toBe(true);
    expect(updated.state.units["U-V"]!.intents.find((item) => item.id === old.id)?.disposition).toBe("delivered");
    // 終端記録の合計が 98,304 byte を超える分は最古（done-0）から期限前に回収し、更新で終端にした記録は回収しない。
    expect(updated.state.units["U-V"]!.intents.some((item) => item.id === "done-0")).toBe(false);
    expect(roundTrip(updated.state.units["U-V"]!).kind).toBe("restored");
    // 予算いっぱいに受理した pending が、最長の配送の更新（attempts 16 桁・nextAttemptAt 25 文字）の後も保存・復元できる。
    let full = emptyState();
    for (let index = 0; index < 200; index++)
      full = send(full, F.o1, (xml) => retime(iso(reported + index * 1000))(replaceTag("EventID", `G${index}`)(xml))
        .replace(/<Headline>\s*<Text>[\s\S]*?<\/Text>/, `<Headline><Text>${"火".repeat(250)}</Text>`)).state;
    expect(pending(full).length).toBeLessThan(128);
    const first = roundTrip(full);
    if (first.kind !== "restored") throw new Error("the admitted state does not decode");
    const grown = intentUpdateOwner({ ...empty, units: { ...empty.units, "U-V": first.state } }, "U-V", pending(first.state).map((item, index) => ({
      id: item.id, attempts: Number.MAX_SAFE_INTEGER, nextAttemptAt: -0.0000018927186924017318,
      disposition: index % 3 === 0 ? "superseded" as const : "pending" as const })), now, linkedUnitTable);
    expect(grown.adopted).toBe(true);
    expect(roundTrip(grown.state.units["U-V"]!).kind).toBe("restored");
  });

  // 実不具合の再発防止（F08、P3-CODEC-AC01）: 旧 4 MiB の内側で保存した state が移行なしで復元し、VFVO50 1 報で 4 MiB を超えても 5 MiB の内側で保存・復元できる。
  it("P3-CODEC-T01 regression / AC01,AC02: F08 — a state saved under 4 MiB restores, takes one VFVO50 and saves and restores within 5 MiB", () => {
    const start = f08State(109, true);
    const now = clock(at(F08_AT));
    const restored = reduceVolcanoUnit(emptyState(), { kind: "restore", persisted: volcanoUnitCodec.encode(start), clock: now });
    expect(restored.outcomes).toMatchObject([{ kind: "recoveryApplied", scope: ["U-V"] }]);
    const step = receive(restored.state, f08Report(), now);
    expect(shape(step)).toEqual([[start.alerts[0].subject, "changed", "semantic"]]);
    const sizes = [generation(restored.state), generation(step.state)];
    console.info("P3-CODEC F08 generation bytes", JSON.stringify({ start: sizes[0], afterVfvo50: sizes[1], reserved: reserved(step.state) }));
    // 開始は旧 4 MiB の decode が受ける大きさ、1 報の後は旧 4 MiB を超える（旧実装の自己 decode が invalid になった形）。
    expect(sizes[0] <= 4_194_304 && sizes[1] > 4_194_304 && reserved(step.state) <= 5_242_880, String(sizes)).toBe(true);
    const decoded = roundTrip(step.state);
    expect(decoded.kind === "restored" ? volcanoUnitCodec.encode(decoded.state) : decoded).toEqual(volcanoUnitCodec.encode(step.state));
  });

  // contractBoundary（P3-CODEC-AC02・AC03）: decoder の形の最大は合法の受信・期限の flush・配送の更新の後も RES-04 の上界の内側で復元できる。
  // 5 MiB の境界は合法の最大からは届かないので、上限ちょうど／超過は codec を通らない合成の state（巨大な headline の警報）で確かめる。
  it("P3-CODEC-T02 contractBoundary / AC02,AC03: the decoder-shaped maximum stays within RES-04; over 5 MiB a step is rejected without effects", () => {
    const now = clock(at(F08_AT));
    const sizes: number[] = [];
    const kept = (state: VolcanoUnitState) => {
      sizes.push(reserved(state));
      expect(roundTrip(state).kind).toBe("restored");
      return state;
    };
    let state = kept(f08State(128, false, true));
    state = kept(receive(state, f08Report(), now).state);
    state = kept(send(state, F.scheduled, retime("2020-05-22T15:00:00+09:00"), now.wallTimeMs, 0).state);
    const flushed = tick(state, now.wallTimeMs, 8_000);
    expect([state.batch?.subjects, flushed.state.batch, flushed.outcomes]).toMatchObject([["normal/VFVO53/506"], null,
      [{ kind: "batchCompleted", reason: "deadline" }]]);
    state = kept(flushed.state);
    const owner = emptyOwner(now);
    const updates = pending(state).map((item, index) => ({ id: item.id, attempts: Number.MAX_SAFE_INTEGER, nextAttemptAt: -0.0000018927186924017318,
      disposition: index % 2 === 0 ? "superseded" as const : "pending" as const }));
    const updated = intentUpdateOwner({ ...owner, units: { ...owner.units, "U-V": state } }, "U-V", updates, now, linkedUnitTable);
    expect(updated.adopted).toBe(true);
    state = kept(updated.state.units["U-V"]!);
    // 更新した intent は全部残る（owner は更新した記録で照合する）。
    expect(updates.every((update) => state.intents.some((item) => item.id === update.id && item.disposition === update.disposition))).toBe(true);
    console.info("P3-CODEC RES-04 maximum (reserved bytes)", JSON.stringify(sizes));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4_753_484);

    // 上限ちょうどは採り、1 byte 超えると入力前の state のまま rejected/requiredStructureInvalid と ERROR の診断 1 件だけを返す。
    const LIMIT = 5_242_880, DAY_MS = 86_400_000;
    const sample = send(emptyState(), F.a306).state.alerts[0];
    if (sample.effective !== "active") throw new Error("inactive sample");
    const withHeavy = (base: VolcanoUnitState, headline: number): VolcanoUnitState => ({ ...base, alerts: [...base.alerts, { ...sample,
      subject: "test/volcano:alert/999", operation: "test", volcanoCode: "999", headline: "x".repeat(headline) }] });
    const reported = at("2020-05-22T14:49:00+09:00"), t0 = at("2021-05-17T14:00:00+09:00");
    const material = decodeFixture(F.o1);
    const eruption = send(emptyState(), F.o1).state, batch = send(emptyState(), F.scheduled, undefined, t0, 0).state;
    // restore 後の collect も同じ共通の守りを通るが、decode を通る payload からは超過を合成できない（到達不能）ので表に入れない。
    const rows: [string, VolcanoUnitState, VolcanoInput][] = [
      ["receive", emptyState(), { kind: "receive", material, clock: clock(reported) }],
      ["deadline batch flush", batch, { kind: "deadline", clock: clock(t0 + 8_000, 8_000) }],
      ["shutdown", eruption, { kind: "shutdown", clock: clock(reported + DAY_MS) }],
      ["shortfallResolution", { ...emptyState(), shortfalls: [shortfall("s1", "volcano", "306")] }, { kind: "shortfallResolution", id: "s1",
        action: "acceptCurrent", clock: clock(reported) }],
      ["intentUpdate", eruption, { kind: "intentUpdate", clock: clock(reported), intentUpdate: { id: eruption.intents[0].id, attempts: 1,
        nextAttemptAt: reported + 1_000, disposition: "pending" } }],
    ];
    for (const [name, base, input] of rows) {
      const probe = reserved(reduceVolcanoUnit(withHeavy(base, 1_000), input).state);
      const fit = withHeavy(base, 1_000 + LIMIT - probe), over = withHeavy(base, 1_001 + LIMIT - probe);
      const accepted = reduceVolcanoUnit(fit, input);
      expect([reserved(accepted.state), accepted.decisions.some((item) => item.decision === "rejected"), accepted.state === fit], name)
        .toEqual([LIMIT, false, false]);
      const rejected = reduceVolcanoUnit(over, input);
      expect(rejected.state, name).toBe(over);
      expect(rejected, name).toEqual({ state: over, nextDeadline: reduceVolcanoUnit(over, { kind: "intentUpdate", clock: clock(reported), intentUpdate: [] })
        .nextDeadline, decisions: [{ subject: "", operation: "normal", decision: "rejected", reason: "requiredStructureInvalid" }], intents: [], outcomes: [],
        diagnostics: [{ level: "ERROR", component: "volcanoGenerationLimit", unit: "U-V", reason: "requiredStructureInvalid", count: 1 }], displayChanges: [],
        confirmationEvidence: [] });
    }
  });

  // P3-CODEC-AC07 の Mac 実測（K5_MEASURE=1 のときだけ走る。合否は持たず、値を契約の Q-CODEC-MEASUREMENT へ転記する。Pi の実測は C22）。
  it.runIf(process.env.K5_MEASURE === "1")("P3-CODEC-AC07 measurement: F08 n=128 through the product checkpoint path", async () => {
    const trials = Number(process.env.K5_TRIALS ?? 20), warmup = 3;
    const state = f08State(128, false, true);
    expect(roundTrip(state).kind).toBe("restored");
    const directory = mkdtempSync(join(process.env.K5_MEASURE_DIR ?? tmpdir(), "k5-measure-"));
    const files = () => readdirSync(directory).map((name) => { const info = statSync(join(directory, name)); return { name, bytes: info.size, disk: info.blocks * 512 }; });
    const node = nodeCheckpointFileSystem();
    let beforeRename: ReturnType<typeof files> = [];
    const fileSystem: CheckpointFileSystem = { ...node, rename: async (from, to) => { beforeRename = files(); await node.rename(from, to); } };
    const coordinator = new CheckpointCoordinator(directory, { "U-V": linkedUnitCodecs["U-V"] }, fileSystem,
      () => ({ wallTimeMs: Date.now(), monotonicMs: performance.now() }), () => {});
    const rssBefore = process.memoryUsage().rss;
    const encode: number[] = [], captureTotal: number[] = [], durable: number[] = [];
    let encodedBytes = 0;
    try {
      for (let run = 0; run < warmup + trials; run++) {
        const started = performance.now();
        const captured = coordinator.capture("U-V", state, run + 1, "k5", { inputIds: [], retryReason: "notRetry" });
        const captureMs = performance.now() - started;
        if (captured.request == null) throw new Error("encode failed");
        encodedBytes = captured.request.encodedByteLength;
        const executed = await coordinator.executeCheckpoint(captured.request, "k5", [], "notRetry");
        if (executed.result.kind !== "acknowledged") throw new Error(`save failed: ${JSON.stringify(executed.result)}`);
        const stages = executed.measurements;
        if (run < warmup) continue;
        encode.push(captured.measurements[0].endedMonotonicMs - captured.measurements[0].startedMonotonicMs);
        captureTotal.push(captureMs);
        durable.push(stages.at(-1)!.endedMonotonicMs - stages[0].startedMonotonicMs);
      }
      const afterRename = files();
      // VFVO50 1 報の reduce（AC01 の開始 state を復元した直後の 1 回目と、記録の byte が cache にある 2 回目以降）。
      const restored = reduceVolcanoUnit(emptyState(), { kind: "restore", persisted: volcanoUnitCodec.encode(f08State(109, true)), clock: clock(at(F08_AT)) }).state;
      const material = f08Report();
      const reduceMs: number[] = [];
      for (let run = 0; run < warmup + trials; run++) {
        const base = run === 0 ? restored : { ...restored };
        const started = performance.now();
        receive(base, material, clock(at(F08_AT)));
        reduceMs.push(performance.now() - started);
      }
      const stats = (values: readonly number[]) => { const sorted = [...values].sort((left, right) => left - right);
        return { median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)), max: Number(sorted.at(-1)!.toFixed(3)) }; };
      console.info("P3-CODEC AC07", JSON.stringify({ node: process.version, platform: `${process.platform} ${process.arch}`, trials, warmup,
        serializedEnvelope: encodedBytes, generationBytes: generation(state), reserved: reserved(state), staticBound: 4_753_484,
        boundMinusReserved: 4_753_484 - reserved(state), encodeMs: stats(encode), captureMs: stats(captureTotal), writeToDirectorySyncMs: stats(durable),
        reduceVfvo50FirstMs: Number(reduceMs[0].toFixed(3)), reduceVfvo50WarmMs: stats(reduceMs.slice(warmup)),
        beforeRename, afterRename, rssBefore, rssAfter: process.memoryUsage().rss, maxRssKiB: process.resourceUsage().maxRSS }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  // 版の比較（P3-REVISION-ORDER-001）: 43_01_01 の噴火を t−60 秒の初報にし、同じ時刻 t の Serial と InfoType だけを替えた報を当てる。
  const ORDER_AT = at("2020-05-22T14:49:00+09:00");
  const ordered = () => send(emptyState(), F.o1, retime("2020-05-22T14:48:00+09:00")).state;
  const version = ([serial, infoType]: readonly [string, string]) =>
    decodeFixture(F.o1, (xml) => replaceTag("InfoType", infoType)(replaceTag("Serial", serial)(xml)));
  const verdict = (step: VolcanoUnitStep) => step.decisions.map((item) => item.decision === "unchanged" ? item.reason : item.decision);
  const orderedOf = (state: VolcanoUnitState) => eruptionOf(state, "20200522144900_306");

  // regression（監査 F02）: 同時刻の Serial 2 の発表・Serial 空の訂正・Serial 1 の取消は、6 順列とも、各手順の前に復元を挟んでも取消で終わる。
  it("P3-ORDER-T01 regression / AC02: the F02 triple ends in the Serial 1 cancel in all 6 orders, with and without a restore before each step", () => {
    const first = ordered();
    const reports = { A: version(["2", "発表"]), B: version(["", "訂正"]), C: version(["1", "取消"]) };
    // owner の復元と同じく、保存物（encode→JSON）を保存世代を引き継いだ state へ restore で戻す。
    const restart = (state: VolcanoUnitState) => {
      const decoded = roundTrip(state);
      if (decoded.kind !== "restored") throw new Error("the saved state does not decode");
      const generation = state.persistence.currentGeneration;
      return reduceVolcanoUnit({ ...emptyState(), persistence: { kind: "saved", currentGeneration: generation, savedGeneration: generation,
        savedCapturedAt: null, savedAckAt: null, dirtySince: null } }, { kind: "restore", persisted: volcanoUnitCodec.encode(decoded.state),
        clock: clock(ORDER_AT) }).state;
    };
    const finals = [false, true].flatMap((restarting) => ["ABC", "ACB", "BAC", "BCA", "CAB", "CBA"].map((order) => [...order].reduce(
      (state, key) => receive(restarting ? restart(state) : state, reports[key as keyof typeof reports], clock(ORDER_AT)).state, first)));
    expect(finals.map((state) => [orderedOf(state)?.effective, orderedOf(state)?.source.serialRaw, orderedOf(state)?.source.infoTypeRaw,
      pending(state).map((item) => [item.channel, item.transition]), roundTrip(state).kind]))
      .toEqual(Array(12).fill(["cancelled", "1", "取消", [["desktop", "cancelled"], ["sound", "cancelled"]], "restored"]));
  });

  // contractBoundary: 同時刻の 2 報は InfoType の優先 → 同じ family なら Serial（欠落はどの数値よりも小、数として）→ VFVO55 > VFVO54 で決まり、
  // 到着順によらない（AC01・AC03(a)〜(c)）。family の違う VFVO50 と VFVO51 は同じ版で、先着を保って食い違い（AC03(f)）。
  it("P3-ORDER-T02 contractBoundary / AC01,AC03: InfoType before Serial, a missing Serial below any number, \"01\" = \"1\", families apart", () => {
    const first = ordered();
    // [一方, 他方, 勝つ方（null は同じ版）]
    const rows: [readonly [string, string], readonly [string, string], 0 | 1 | null][] = [
      [["9", "発表"], ["1", "訂正"], 1], [["", "訂正"], ["1", "取消"], 1], [["2", "発表"], ["1", "発表"], 0], [["", "発表"], ["1", "発表"], 1],
      [["01", "発表"], ["1", "発表"], null]];
    for (const [one, other, winner] of rows) for (const [early, late, lateWins] of [[one, other, winner === 1], [other, one, winner === 0]] as const) {
      const step = receive(receive(first, version(early), clock(ORDER_AT)).state, version(late), clock(ORDER_AT));
      expect([verdict(step), step.diagnostics, [orderedOf(step.state)?.source.serialRaw, orderedOf(step.state)?.source.infoTypeRaw]], `${early}→${late}`)
        .toEqual([[winner == null ? "duplicate" : lateWins ? "changed" : "stale"], [], lateWins ? late : early]);
    }
    // 同じ時刻の VFVO50（Serial 空）と VFVO51（Serial 13）を火山 306 に当てると、両順とも先着を保つ（VFVO51 の警報の entry は一括で stale）。
    const alertAt = at("2020-05-22T13:03:00+09:00");
    const pair = [decodeFixture(F.a306), decodeFixture(F.national, retime("2020-05-22T13:03:00+09:00"))];
    for (const [early, late] of [pair, [...pair].reverse()]) {
      const step = receive(receive(emptyState(), early, clock(alertAt)).state, late, clock(alertAt));
      expect(alertOf(step.state, "306")?.source?.family, late.headType).toBe(early.headType);
      expect(step.decisions.filter((item) => item.subject.startsWith("normal/volcano:alert/")).every((item) =>
        item.decision === "unchanged" && item.reason === "stale"), late.headType).toBe(true);
      expect(step.diagnostics, late.headType).toMatchObject([{ level: "WARN", reason: "volcanoRevisionConflict" }]);
    }
    // 降灰: 同じ時刻・同じ InfoType の VFVO54（Serial 5）と VFVO55（Serial 1）は、Serial によらず両順とも VFVO55。
    const ashAt = at("2021-05-14T12:51:00+09:00");
    const ash = [decodeFixture(F.rapid, (xml) => replaceTag("Serial", "5")(retime("2021-05-14T12:51:00+09:00")(xml))), decodeFixture(F.detail)];
    for (const [early, late] of [ash, [...ash].reverse()]) {
      const step = receive(receive(emptyState(), early, clock(ashAt)).state, late, clock(ashAt));
      expect([verdict(step), step.state.ashfalls.map((item) => item.source.family)], late.headType)
        .toEqual([[late.headType === "VFVO55" ? "changed" : "stale"], ["VFVO55"]]);
    }
  });
});

function shortfall(id: string, scope: "volcano" | "domain", volcanoCode: string | null, lastKnownAt: string | null = null,
  slice: VolcanoShortfall["slice"] = "alert"): VolcanoShortfall {
  return { id, operation: "normal", slice, scope, volcanoCode, lastKnown: lastKnownAt == null ? null : { reportDateTimeRaw: lastKnownAt, serialRaw: "" },
    reason: "provenanceMissing" };
}

// I-U-V.capacityMeasurement の同時最大状態: 三 slice 各 128 件と復旧不足 128 件に、pending と終端記録を byte の上限まで詰める。
// 実例の最大は 45_03_01 相当の警報・synthetic_phase5c_plume の噴火・66_01_02 の降灰、上界（I-U-V.capacityReserve）は上限の長さの記録。
function budgetState(bounded: boolean): VolcanoUnitState {
  const reported = at("2020-05-22T15:00:00+09:00");
  const wide = (length: number) => "\u0001".repeat(length);
  const ref = (subject: string, family: string, operation: Operation, time = reported) => ({ inputId: bounded ? "i".repeat(64) : "i".repeat(36),
    origin: "live" as const, operation, family, subject, reportDateTimeRaw: bounded ? "2020-05-22T15:00:00.00000000000000+09:00" : iso(time),
    serialRaw: bounded ? "1234567890" : "1", infoTypeRaw: "発表" });
  const alertSeed = alertOf(send(emptyState(), F.a350, (xml) => xml.replaceAll("<Code>11</Code>", "<Code>13</Code>")).state, "350")!;
  const eruptionSeed = send(emptyState(), F.plume).state.eruptions[0], ashfallSeed = send(emptyState(), F.rapid).state.ashfalls[0];
  if (alertSeed.effective !== "active" || eruptionSeed.effective !== "active" || ashfallSeed.effective !== "active") throw new Error("inactive seed");
  const real = { alert: alertSeed, eruption: eruptionSeed, ashfall: ashfallSeed };
  const operation = (index: number): Operation => bounded ? "training" : (["normal", "training", "test"] as const)[index % 3];
  const code = (index: number) => bounded ? `${"9".repeat(12)}${String(index).padStart(4, "0")}` : `V${index}`;
  const eventId = (index: number) => bounded ? `${"E".repeat(60)}${String(index).padStart(4, "0")}` : `E${index}`;
  const value = (raw: string) => ({ kind: "text" as const, value: wide(32), raw });
  const alerts = Array.from({ length: 128 }, (_, index): VolcanoAlert => {
    const subject = `${operation(index)}/volcano:alert/${code(index)}`;
    const base = { ...real.alert, subject, operation: operation(index), volcanoCode: code(index), eventId: eventId(index),
      source: ref(subject, "VFVO50", operation(index)), marineSource: bounded ? ref(subject, "VFSV50", operation(index)) : null,
      retainUntil: reported + 30 * DAY };
    if (!bounded) return base;
    const groups = (count: number, codes: number) => Array.from({ length: count }, (_, at) => ({ kindName: wide(32),
      codes: Array.from({ length: at === 0 ? codes : 0 }, (_, item) => `${"8".repeat(12)}${String(item).padStart(4, "0")}`) }));
    return { ...base, volcanoName: wide(32), kind: { code: "12345678", name: wide(32), condition: wide(8) }, lastKind: { code: "12345678", name: wide(32) },
      landKind: { code: "12345678", name: wide(32), condition: wide(8) },
      level: null, headline: wide(256), municipalities: groups(8, 128), marineAreas: groups(4, 32), coordinate: "+".repeat(40), truncated: false };
  });
  const eruptions = Array.from({ length: 128 }, (_, index): VolcanoEruption => {
    const subject = `${operation(index)}/volcano:eruption/${eventId(index)}`;
    const base = { ...real.eruption, subject, operation: operation(index), eventId: eventId(index), volcanoCode: code(index),
      source: ref(subject, "VFVO52", operation(index)), retainUntil: reported + 2 * DAY, validUntil: reported + DAY };
    return bounded ? { ...base, volcanoName: wide(32), phenomenon: { code: "12345678", name: wide(16) }, eventDateTimeRaw: "+".repeat(40),
      craterName: wide(32), plumeAboveCrater: value(wide(32)), plumeAboveSeaLevel: value(wide(32)), plumeDirection: wide(16), headline: wide(256),
      municipalities: Array.from({ length: 128 }, (_, item) => `${"7".repeat(12)}${String(item).padStart(4, "0")}`) } : base;
  });
  // 実例の降灰は元報の時刻のまま（予報の期間を元報の時刻から確かめる）。上界は表に無い 8 byte の区分で 8 group を満たす。
  const ashAt = bounded ? reported : Date.parse(real.ashfall.source.reportDateTimeRaw);
  const ashfalls = Array.from({ length: 128 }, (_, index) => {
    const subject = `${operation(index)}/volcano:ashfall/${code(index)}`;
    const base = { ...real.ashfall, subject, operation: operation(index), volcanoCode: code(index), eventId: eventId(index),
      source: ref(subject, "VFVO54", operation(index), ashAt), retainUntil: ashAt + 7 * DAY };
    return bounded ? { ...base, volcanoName: wide(32), headline: wide(256), forecastStartsAt: reported, forecastEndsAt: reported + 3_600_000,
      groups: Array.from({ length: 8 }, (_, group) => ({ hazardClass: "unknown" as const, ashCode: `7${String(group).padStart(7, "0")}`, ashName: wide(32),
        areaCount: 2_048, omittedAreaCount: 2_045, topAreas: Array.from({ length: 3 }, (_, area) => ({ code: `${"6".repeat(12)}${group}${area}00`,
          name: wide(32), firstForecastEndAt: reported + 3_600_000 })) })), omittedGroupCount: 2_040 } : base;
  });
  const shortfalls = bounded ? Array.from({ length: 128 }, (_, index): VolcanoShortfall => ({ id: `${"S".repeat(60)}${String(index).padStart(4, "0")}`,
    operation: "training", slice: "eruption", scope: "volcano", volcanoCode: code(index), lastKnown: { reportDateTimeRaw: "2020-05-22T15:00:00.00000000000000+09:00",
      serialRaw: "1234567890" }, reason: "terminalQuarantine" })) : [];
  return { ...emptyState(), alerts, eruptions, ashfalls, shortfalls, intents: fillIntents(send(emptyState(), F.a306).intents[0]) };
}
// pending（実 byte＋配送予約で 131,072 まで、128 件）と終端記録（98,304 まで）を seed の複製で詰める。
// exact は先頭の pending と先頭の終端記録の body を ASCII で伸ばし、両方の予算をちょうど使い切る（AC07 の decoder の最大）。
function fillIntents(seed: VolcanoIntent, exact = false): VolcanoIntent[] {
  const reported = at("2020-05-22T15:00:00+09:00");
  const sized = (index: number, disposition: VolcanoIntent["disposition"]): VolcanoIntent => ({ ...seed, id: `${seed.id}:${index}`,
    disposition, createdAt: reported, expiresAt: reported + 180_000 });
  const bytes = (item: VolcanoIntent) => Buffer.byteLength(JSON.stringify(item));
  const pendingIntents: VolcanoIntent[] = [];
  for (let size = 2, index = 0; pendingIntents.length < 128; index++) {
    const item = sized(index, "pending"), width = bytes(item) + (pendingIntents.length === 0 ? 0 : 1)
      + deliveryGrowth(item);
    if (size + width > 131_072) break;
    pendingIntents.push(item);
    size += width;
  }
  const terminal: VolcanoIntent[] = [];
  for (let size = 0, index = 1000; ; index++) {
    const item = sized(index, "delivered");
    if (size + bytes(item) + 1 > 98_304) break;
    terminal.push(item);
    size += bytes(item) + 1;
  }
  if (exact) {
    const pad = (item: VolcanoIntent, length: number): VolcanoIntent => ({ ...item, payload: { ...item.payload, body: item.payload.body + "x".repeat(length) } });
    const pendingSize = Buffer.byteLength(JSON.stringify(pendingIntents)) + pendingIntents.reduce((sum, item) => sum + deliveryGrowth(item), 0);
    const terminalSize = terminal.reduce((sum, item) => sum + bytes(item) + 1, 0);
    pendingIntents[0] = pad(pendingIntents[0], 131_072 - pendingSize);
    terminal[0] = pad(terminal[0], 98_304 - terminalSize);
  }
  return [...pendingIntents, ...terminal];
}

// P3-CODEC-AC01 の F08 構成: budgetState(true) の上限の記録で、先頭 escaped 件の記録の地域コードをバックスラッシュ 16 字（JSON で 32 byte）にする。
// intent の seed と報の inputId は fixture 名（実行順で inputId の桁が変わらない）。sparse は先頭の警報を seed の疎な active の記録に戻す。
// 噴火の seed は budgetState の synthetic_phase5c_plume（契約 AC01 は 43_01_01_200522_VFVO52）。上限の値で上書きしないのは flash・truncated
// だけで両方とも false なので byte は同じ（F08 の観測値と一致）。
// max は AC07 の decoder の最大: asciiCode の項目をバックスラッシュ・引用符で、bounded の項目（ReportRef.inputId を含む）を U+0001 で
// 上限まで埋め、pending と終端記録を予算ちょうどまで詰める（origin・数値・ReportDateTime は AC01 のまま）。
const F08_AT = "2020-05-22T15:00:01+09:00";
function f08State(escaped: number, sparse: boolean, max = false): VolcanoUnitState {
  const bound = max ? decoderMax(budgetState(true)) : budgetState(true);
  const slash = "\\".repeat(16);
  const groups = (values: readonly VolcanoAreaGroup[]) => values.map((group) => ({ ...group, codes: group.codes.map(() => slash) }));
  const alerts = bound.alerts.map((item, index): VolcanoAlert => item.effective !== "active" || index >= escaped ? item
    : { ...item, municipalities: groups(item.municipalities), marineAreas: groups(item.marineAreas) });
  const eruptions = bound.eruptions.map((item, index): VolcanoEruption => item.effective !== "active" || index >= escaped ? item
    : { ...item, municipalities: item.municipalities.map(() => slash) });
  const ashfalls = bound.ashfalls.map((item, index) => item.effective !== "active" || index >= escaped ? item
    : { ...item, groups: item.groups.map((group) => ({ ...group, topAreas: group.topAreas.map((area) => ({ ...area, code: slash })) })) });
  if (sparse) {
    const seed = alertOf(send(emptyState(), F.a350, (xml) => xml.replaceAll("<Code>11</Code>", "<Code>13</Code>")).state, "350")!;
    const [first] = alerts;
    alerts[0] = { ...seed, subject: first.subject, operation: first.operation, volcanoCode: first.volcanoCode, eventId: first.eventId,
      source: first.source, retainUntil: first.retainUntil, marineSource: null };
  }
  const intent = send(emptyState(), F.a306).intents[0];
  return { ...bound, alerts, eruptions, ashfalls,
    intents: fillIntents({ ...intent, source: { ...intent.source, inputId: max ? "\u0001".repeat(64) : F.a306 } }, max) };
}
function decoderMax(state: VolcanoUnitState): VolcanoUnitState {
  const code = "\\".repeat(8), text = "\\".repeat(40), id = "\u0001".repeat(64);
  const ref = <T extends { inputId: string }>(value: T): T => ({ ...value, inputId: id });
  const alerts = state.alerts.map((item): VolcanoAlert => item.effective !== "active" ? item : { ...item, source: item.source && ref(item.source),
    marineSource: item.marineSource && ref(item.marineSource), kind: { ...item.kind, code }, lastKind: item.lastKind && { ...item.lastKind, code },
    landKind: item.landKind && { ...item.landKind, code }, coordinate: text });
  const eruptions = state.eruptions.map((item): VolcanoEruption => item.effective !== "active" ? item : { ...item, source: ref(item.source),
    phenomenon: { ...item.phenomenon, code }, eventDateTimeRaw: text });
  const ashfalls = state.ashfalls.map((item) => item.effective !== "active" ? item : { ...item, source: ref(item.source),
    groups: item.groups.map((group) => ({ ...group, ashCode: code })) });
  // shortfall.id は 64 字を全部エスケープの 2 byte にし、末尾 7 字の引用符とバックスラッシュの並びで 128 件を区別する。
  const shortfalls = state.shortfalls.map((item, index) => ({ ...item, id: "\\".repeat(57)
    + Array.from({ length: 7 }, (_, bit) => (index >> bit) & 1 ? '"' : "\\").join("") }));
  return { ...state, alerts, eruptions, ashfalls, shortfalls };
}
// AC01 の VFVO50 1 報: 45_01_01 を先頭の警報（火山コード・EventID）の訓練の報にし、Headline「山」256 字と市町村 128 件で上限まで埋める。
function f08Report(): DecodedMaterial {
  const code = `${"9".repeat(12)}0000`, eventId = `${"E".repeat(60)}0000`;
  const areas = Array.from({ length: 128 }, (_, index) => `<Area><Name>${"山".repeat(32)}</Name><Code>${"\\".repeat(12)}${String(index).padStart(4, "0")}</Code></Area>`).join("");
  return decodeFixture(F.a306, (xml) => status("訓練")(retime(F08_AT)(replaceTag("EventID", eventId)(xml)))
    .replaceAll("<Code>306</Code>", `<Code>${code}</Code>`)
    .replace(/<Headline>\s*<Text>[\s\S]*?<\/Text>/, `<Headline><Text>${"山".repeat(256)}</Text>`)
    .replace(/(<VolcanoInfo type="噴火警報・予報（対象市町村等）">[\s\S]*?<Areas[^>]*>)[\s\S]*?(<\/Areas>)/, `$1${areas}$2`), F.a306);
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
