import { describe, expect, it, vi } from "vitest";

import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type { NankaiCurrent, NankaiInformation, NankaiIntent, NankaiUnitState, NankaiUnitStep } from "../../contracts/p3-nankai-unit.types";
import contract from "../../contracts/p3-nankai-unit.json";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { intentUpdateOwner, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { classifyHeadType, placeOfHeadType } from "../../src/runtime/unit-coverage";
import { nankaiUnitCodec, reduceNankaiUnit, toNankaiView } from "../../src/units/nankai/nankai-unit";
import { chain, clock, decodeFixture, decodeXml, emptyState, fixtureXml, receive, replaceTag, retime, send } from "./nankai-fixture";

const DAY = 86_400_000;
const F = {
  inv1: "74_01_01_200512_VYSE50", inv2: "74_01_02_200512_VYSE50", inv3: "74_01_03_200512_VYSE50", warning: "74_01_04_200512_VYSE50",
  advisory: "74_01_05_200512_VYSE50", advisory2: "74_01_06_200512_VYSE50", ended: "74_01_07_200512_VYSE50",
  otherCancel: "74_03_01_220318_VYSE50", c1: "75_01_01_200512_VYSE51", c2: "75_01_02_200512_VYSE51", c3: "75_01_03_200512_VYSE51",
  regular: "75_01_04_200512_VYSE52", vyse60: "80_01_01_240821_VYSE60", cancel: "synthetic_VYSE50_cancel",
  correction: "synthetic_VYSE51_correction", unknown: "synthetic_VYSE50_unknown_code", noInfo: "synthetic_VYSE50_no_earthquake_info",
} as const;
const NANKAI = "normal/nankai/current";
const at = (iso: string) => Date.parse(iso);
const currentOf = (state: NankaiUnitState, subject = NANKAI): NankaiCurrent | undefined => state.currents.find((item) => item.subject === subject);
const infoOf = (state: NankaiUnitState, subject: string): NankaiInformation | undefined => state.information.find((item) => item.subject === subject);
const shape = (step: NankaiUnitStep) => step.decisions.map((item) => [item.subject, item.decision,
  item.decision === "changed" ? item.change : item.decision === "unchanged" || item.decision === "rejected" ? item.reason : null]);
const levels = (step: NankaiUnitStep) => step.intents.map((item) => `${item.channel}:${item.payload.level}`);
const pending = (state: NankaiUnitState) => state.intents.filter((item) => item.disposition === "pending");
const status = (state: NankaiUnitState, subject = NANKAI) => {
  const value = currentOf(state, subject);
  return value == null ? null : value.effective === "active" ? value.status : value.effective;
};
const roundTrip = (state: NankaiUnitState) => nankaiUnitCodec.decode(JSON.parse(JSON.stringify(nankaiUnitCodec.encode(state))) as JsonValue);
// 復元で戻る証拠だけの情報 subject（P3-AUTH-AC01(2)）。
const evidenceOnly = (item: NankaiInformation): NankaiInformation => item.effective === "evidence" ? item : { subject: item.subject,
  family: item.family, eventId: item.eventId, operation: item.operation, retainUntil: item.retainUntil, effective: "evidence",
  evidence: { subject: item.subject, reportDateTimeMs: Date.parse(item.source.reportDateTimeRaw), serialRaw: item.source.serialRaw,
    infoTypeRaw: item.source.infoTypeRaw } };

describe("P3-UNIT-N-001 U-N reducer", () => {
  // contractBoundary: Q-ENUM の順と原子性、合法の縮退、coverage と実行場所（AC01）。
  it("P3-C8-T01 contractBoundary / AC01: first reason only, unchanged state, legal reduced forms and the U-N route", () => {
    const base = emptyState();
    const now = clock(at("2020-05-12T16:28:00+09:00"));
    const xml = fixtureXml(F.warning);
    const reject = (source: string, inputId?: string) => {
      const step = receive(base, decodeXml(source, "VYSE50", inputId), now);
      expect(step.state).toBe(base);
      expect([step.intents, step.outcomes, step.displayChanges]).toEqual([[], [], []]);
      expect(step.diagnostics).toHaveLength(1);
      const result = step.decisions[0];
      return result.decision === "rejected" ? result.reason : result.decision;
    };
    const event = (value: string) => replaceTag("EventID", value)(xml);
    const code = "<Code>120</Code>";
    const cases: [string, string][] = [
      [event(""), "identityMissing"], [event("   "), "identityMissing"], [event("2020 0512"), "identityInvalid"],
      [event("2020/0512"), "identityInvalid"], [event("a".repeat(65)), "identityInvalid"], [event('a"b'), "identityInvalid"],
      [event("a\\b"), "identityInvalid"], [replaceTag("Serial", "0")(xml), "identityInvalid"],
      [replaceTag("Serial", "12345678901")(xml), "identityInvalid"],
      // 小数秒で 40 文字を超える ReportDateTime と、8 文字を超える InfoType の raw（保存する ReportRef の上限、Q-ENUM.identity）。
      [retime("2020-05-12T16:28:00.0000000000000000+09:00")(xml), "identityInvalid"],
      [replaceTag("InfoType", "発表        ")(xml), "identityInvalid"],
      [replaceTag("InfoType", "不明")(xml), "requiredStructureInvalid"],
      [fixtureXml(F.noInfo), "requiredStructureMissing"],
      [xml.replace(/(<EarthquakeInfo[\s\S]*<\/EarthquakeInfo>)/, "$1$1"), "requiredStructureInvalid"],
      [xml.replace(/(<InfoSerial[\s\S]*<\/InfoSerial>)/, "$1$1"), "requiredStructureInvalid"],
      [xml.replace(code, code + code), "requiredStructureInvalid"],
      [xml.replace(code, "<Code><Value>120</Value></Code>"), "requiredStructureInvalid"],
      // 存在が妥当性より先（Q-ENUM.priorityRule）: InfoSerial の重複より EarthquakeInfo の欠落。
      [xml.replace(/<EarthquakeInfo[\s\S]*<\/EarthquakeInfo>/, ""), "requiredStructureMissing"],
    ];
    expect(cases.map(([source]) => reject(source))).toEqual(cases.map(([, reason]) => reason));
    // 64 byte の EventID は合法。保存する inputId の上限（64 文字）を超える入力は identityInvalid（受理と decode を同じ境界にする）。
    expect(receive(base, decodeXml(event("a".repeat(64)), "VYSE50"), now).decisions[0].decision).toBe("changed");
    expect(reject(xml, "i".repeat(65))).toBe("identityInvalid");
    // 識別できない拒否の subject は空文字、識別できた拒否は情報 subject。
    expect(receive(base, decodeXml(event(""), "VYSE50"), now).decisions[0].subject).toBe("");
    expect(receive(base, decodeXml(fixtureXml(F.noInfo), "VYSE50"), now).decisions[0].subject).toBe("normal/VYSE50/20200512162000");

    // 合法: 取消の Body 縮退（74_03_01）、InfoSerial の無い報（VYSE60）、表に無い code。
    for (const name of [F.otherCancel, F.vyse60, F.unknown]) expect(send(base, name).decisions.at(-1)!.decision, name).toBe("changed");
    for (const headType of ["VYSE50", "VYSE51", "VYSE52", "VYSE60"]) {
      expect(classifyHeadType(headType)).toEqual({ status: "ready", unit: "U-N" });
      expect(placeOfHeadType(headType)).toBe("urgent");
    }
    // 一入力は U-N だけへ届き、U-E・U-T・U-Q の state は同じ参照のまま。
    const owner = restoreOwner({ runId: "run", place: "urgent", clock: now, restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const material = decodeFixture(F.warning);
    const routed = receiveOwner(owner, { runId: "run", inputId: material.inputId, result: { kind: "decoded", material } }, now, linkedUnitTable);
    expect(routed.changedUnits).toEqual(["U-N"]);
    for (const unit of ["U-E", "U-T", "U-Q"] as const) expect(routed.state.units[unit]).toBe(owner.units[unit]);
  });

  // acceptance: 現況と情報系列の分離、view（AC02・AC06）。74_01_xx・75_01_xx はサンプル電文を時刻順に並べた試験用の列。
  it("P3-C8-T02 acceptance / AC02,AC06: current and information series, exclusions, old corrections, VYSE60 and operations", () => {
    const series = chain([F.inv1, F.inv2, F.inv3, F.warning, F.advisory, F.advisory2, F.ended, F.c1, F.c2, F.c3, F.regular]);
    expect(series.map((step) => status(step.state))).toEqual(["investigating", "investigating", "investigating", "megaquakeWarning",
      "megaquakeAdvisory", "megaquakeAdvisory", "megaquakeAdvisory", "megaquakeAdvisory", "megaquakeAdvisory", "megaquakeAdvisory",
      "megaquakeAdvisory"]);
    expect(series.map((step) => step.decisions.length)).toEqual([2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1]);
    // 16:36 の調査終了は注意が active の最中なので (3) により情報だけで、注意が残る。調査中の ended は 74_01_01 → 74_01_07 の並び。
    expect(shape(series[6])).toEqual([["normal/VYSE50/20200512163600", "changed", "semantic"]]);
    const ended = chain([F.inv1, F.ended]).at(-1)!;
    expect(shape(ended)).toEqual([[NANKAI, "changed", "semantic"], ["normal/VYSE50/20200512163600", "changed", "semantic"]]);
    expect(currentOf(ended.state)).toEqual({ subject: NANKAI, operation: "normal", eventId: "20200512163600", line: "nankai", effective: "ended",
      source: expect.objectContaining({ family: "VYSE50", subject: NANKAI }), retainUntil: at("2020-05-12T16:36:00+09:00") + 30 * DAY });
    expect(ended.intents.map((item) => [item.transition, item.payload.level])).toEqual([["released", "info"], ["released", "info"]]);
    // VYSE51 の第 1〜3 号は同じ EventID の情報 subject の revision で並び、現況と系統の watermark を変えない。
    expect(series.slice(7, 10).map((step) => {
      const info = infoOf(step.state, "normal/VYSE51/20200512163800");
      return info?.effective === "evidence" ? null : info?.source.serialRaw;
    })).toEqual(["1", "2", "3"]);
    expect(currentOf(series[10].state)).toBe(currentOf(series[5].state));
    // 巨大地震注意の最中の調査中は情報だけで、系統の watermark を進めない（16:35 の調査中の後も 16:34 の注意を採用する）。
    const advisory = send(emptyState(), F.advisory).state;
    const investigating = send(advisory, F.inv1, retime("2020-05-12T16:35:00+09:00"));
    expect(shape(investigating)).toEqual([["normal/VYSE50/20200512162000", "changed", "semantic"]]);
    expect(currentOf(investigating.state)).toBe(currentOf(advisory));
    expect(shape(send(investigating.state, F.advisory2))[0].slice(0, 2)).toEqual([NANKAI, "changed"]);
    // 古い報（別の EventID）の訂正は現況を巻き戻さず情報だけを変える。現況が stale とした古い報は情報系列にも入らない。
    const both = chain([F.warning, F.advisory]).at(-1)!.state;
    const oldCorrection = send(both, F.warning, (xml) => replaceTag("InfoType", "訂正")(xml).replace("巨大地震警戒</Name>", "巨大地震警戒（訂正）</Name>"));
    expect(shape(oldCorrection)).toEqual([["normal/VYSE50/20200512162800", "changed", "semantic"]]);
    expect(currentOf(oldCorrection.state)).toBe(currentOf(both));
    const late = send(send(emptyState(), F.advisory).state, F.warning);
    expect(shape(late)).toEqual([[NANKAI, "unchanged", "stale"], ["normal/VYSE50/20200512162800", "unchanged", "stale"]]);
    expect(late.state.information.map((item) => item.subject)).toEqual(["normal/VYSE50/20200512163200"]);
    // 表に無い code は情報だけ（code は文字列のまま残す）。
    const unknown = send(emptyState(), F.advisory, (xml) => xml.replace("<Code>130</Code>", "<Code>0130</Code>"));
    expect([unknown.state.currents, infoOf(unknown.state, "normal/VYSE50/20200512163200")?.effective === "active"
      && infoOf(unknown.state, "normal/VYSE50/20200512163200")]).toMatchObject([[], { infoSerial: { code: "0130", name: "巨大地震注意" } }]);
    // VYSE60 は別の系統の現況で、南海トラフの現況を変えない。
    const withVyse60 = send(both, F.vyse60, undefined, at("2020-05-12T16:50:00+09:00"));
    expect(currentOf(withVyse60.state)).toBe(currentOf(both));
    expect(status(withVyse60.state, "normal/VYSE60/current")).toBe("subsequentAdvisory");
    // 同じ revision・同じ InfoType で事実が違えば先着を保って stale＋WARN。
    const conflict = send(advisory, F.advisory, (xml) => xml.replace(/<Headline>\s*<Text>[^<]*/, "<Headline><Text>別の見出し"));
    expect(shape(conflict)).toEqual([[NANKAI, "unchanged", "stale"], ["normal/VYSE50/20200512163200", "unchanged", "stale"]]);
    expect(conflict.state).toBe(advisory);
    expect(conflict.diagnostics).toMatchObject([{ level: "WARN", reason: "nankaiRevisionConflict", unit: "U-N" }]);
    // 訓練（74_01_04 の Status を訓練に替える）は別の現況で、通常と交差しない。
    const training = send(both, F.warning, (xml) => xml.replace("<Status>通常</Status>", "<Status>訓練</Status>"));
    expect(currentOf(training.state, "training/nankai/current")).toMatchObject({ effective: "active", status: "megaquakeWarning" });
    expect(currentOf(training.state)).toBe(currentOf(both));
    expect(training.intents.map((item) => [item.channel, item.payload.title])).toEqual([["desktop", "【訓練】南海トラフ地震臨時情報（巨大地震警戒）"]]);
    // view: active の現況と active の情報の見出しだけ（本文を載せない）。
    const view = toNankaiView(series[10].state);
    expect(view.currents.map((item) => [item.subject, item.status])).toEqual([[NANKAI, "megaquakeAdvisory"]]);
    expect(view.information).toHaveLength(9);
    expect(view.information.every((item) => !("text" in item) && !("nextAdvisory" in item))).toBe(true);
    expect(view.subjects.find((item) => item.subject === "normal/VYSE52/20200512164400")?.facts).not.toHaveProperty("text");
    expect(toNankaiView(send(advisory, F.cancel).state)).toMatchObject({ currents: [], information: [] });
  });

  // acceptance: 取消・終了・期限（AC03）。
  it("P3-C8-T03 acceptance / AC03: cancel scope, stale before the cancel, re-adoption and the 7 d / 30 d / 7 d deadlines", () => {
    const advisory = send(emptyState(), F.advisory).state;
    const cancelled = send(advisory, F.cancel);
    expect([status(cancelled.state), infoOf(cancelled.state, "normal/VYSE50/20200512163200")?.effective]).toEqual(["cancelled", "cancelled"]);
    // 別の EventID の取消（74_03_01、時刻を注意の後へ替える）は現況を変えず、未受信の対象は記憶だけで鳴らない。
    const other = send(advisory, F.otherCancel, retime("2020-05-12T16:40:00+09:00"));
    expect(currentOf(other.state)).toBe(currentOf(advisory));
    expect([other.intents, other.displayChanges, shape(other)]).toEqual([[], [], [["normal/VYSE50/20220318193600", "changed", "revisionOnly"]]]);
    expect(infoOf(other.state, "normal/VYSE50/20220318193600")).toMatchObject({ effective: "cancelled" });
    // 取消の後に届いた元の報は stale、取消より新しい報で再び active。
    expect(shape(send(cancelled.state, F.advisory))[0]).toEqual([NANKAI, "unchanged", "stale"]);
    const again = send(cancelled.state, F.advisory, retime("2020-05-12T16:40:00+09:00"));
    expect([status(again.state), infoOf(again.state, "normal/VYSE50/20200512163200")?.effective]).toEqual(["megaquakeAdvisory", "active"]);
    // 期限: 現況 7 日、watermark 30 日、情報 7 日（元報の時刻から）。到来していない deadline は同じ state 参照と空の結果。
    const reported = at("2020-05-12T16:32:00+09:00");
    const quiet = reduceNankaiUnit(advisory, { kind: "deadline", clock: clock(reported + 180_000) }).state;
    const tick = (state: NankaiUnitState, ms: number) => reduceNankaiUnit(state, { kind: "deadline", clock: clock(reported + ms) });
    const before = tick(quiet, 7 * DAY - 60_000);
    expect(before.state).toBe(quiet);
    expect([before.decisions, before.outcomes, before.displayChanges, before.intents, before.diagnostics]).toEqual([[], [], [], [], []]);
    const expired = tick(quiet, 7 * DAY);
    expect([status(expired.state), expired.state.information, expired.intents]).toEqual(["expired", [], []]);
    expect(expired.displayChanges.map((item) => [item.subject, item.after])).toEqual([[NANKAI, null], ["normal/VYSE50/20200512163200", null]]);
    expect(currentOf(tick(expired.state, 30 * DAY - 60_000).state)).toBeDefined();
    expect(tick(expired.state, 30 * DAY).state.currents).toEqual([]);
    // 到着の時点で期限を過ぎた報は採用して watermark を進め、同じ reduce で回収する（view に載らず鳴らない）。
    const overdue = send(emptyState(), F.advisory, undefined, reported + 8 * DAY);
    expect([status(overdue.state), overdue.state.information, overdue.intents, overdue.displayChanges]).toEqual(["expired", [], [], []]);
    expect(shape(send(overdue.state, F.advisory, undefined, reported + 8 * DAY))[0]).toEqual([NANKAI, "unchanged", "duplicate"]);
  });
  // 監査 F04 の U-N（P3-OPCAP-N-AC01・AC02）: 復元の後でも training の報は normal の取消の証拠を退去せず、取消より古い報は stale のまま。
  it("P3-OPCAP-N-T01 regression / P3-OPCAP-N-AC01,AC02: a training report never evicts a normal cancel's evidence", () => {
    const now = at("2020-05-12T17:00:00+09:00");
    let state = send(emptyState(), F.cancel, undefined, now).state;
    for (let index = 0; index < 63; index++)
      state = send(state, F.regular, replaceTag("EventID", `N${String(index).padStart(13, "0")}`), now).state;
    const restored = reduceNankaiUnit(emptyState(), { kind: "restore", persisted: nankaiUnitCodec.encode(state), clock: clock(now) }).state;
    expect([restored.information.length, restored.information.every((item) => item.effective === "evidence")]).toEqual([64, true]);
    const training = send(restored, F.regular, (xml) => xml.replace("<Status>通常</Status>", "<Status>訓練</Status>"), now);
    expect(training.state.information).toBe(restored.information);
    expect([shape(training).at(-1), training.decisions.at(-1), training.outcomes, training.intents, training.diagnostics]).toEqual([
      ["training/VYSE52/20200512164400", "changed", "revisionOnly"], expect.objectContaining({ currentEstablished: null }),
      [{ kind: "accepted", change: "revisionOnly", subjects: [] }], [],
      [{ level: "INFO", component: "nankai", reason: "nankaiCapacityEvicted", unit: "U-N", count: 1 }]]);
    const old = send(training.state, F.advisory, undefined, now);
    expect([shape(old), old.intents, old.state.currents]).toEqual([[[NANKAI, "unchanged", "stale"], ["normal/VYSE50/20200512163200", "unchanged", "stale"]],
      [], restored.currents]);
    // 情報 subject を自身の退去で残さなくても、同じ報の現況の採用と通知は今のまま（P3-OPCAP-N-AC02）。
    const drill = send(restored, F.advisory, (xml) => xml.replace("<Status>通常</Status>", "<Status>訓練</Status>"), now);
    expect(drill.state.information).toBe(restored.information);
    expect([shape(drill), drill.decisions.at(-1), drill.intents.map((item) => [item.channel, item.payload.title.slice(0, 4)])]).toEqual([
      [["training/nankai/current", "changed", "semantic"], ["training/VYSE50/20200512163200", "changed", "revisionOnly"]],
      expect.objectContaining({ currentEstablished: null }), [["desktop", "【訓練】"]]]);
  });

  // contractBoundary: P3-C8-CAPACITY=A と受信 1 回の費用（AC04）。境界入力は試験内で作る。
  it("P3-C8-T04 contractBoundary / AC04: 63/64/65 information, eviction order, pending and terminal budgets, the budget states and no whole encode", () => {
    const now = at("2020-05-12T17:00:00+09:00");
    const seed = infoOf(send(emptyState(), F.c1).state, "normal/VYSE51/20200512163800");
    if (seed?.effective !== "active") throw new Error("the seed information is not active");
    const info = (index: number, patch: Partial<{ operation: Operation; minutes: number; retainUntil: number }> = {}): NankaiInformation => {
      const operation = patch.operation ?? "normal", eventId = `I${String(index).padStart(13, "0")}`, subject = `${operation}/VYSE51/${eventId}`;
      const reported = now - (patch.minutes ?? 100 - index) * 60_000;
      return { ...seed, subject, eventId, operation, retainUntil: patch.retainUntil ?? reported + 7 * DAY,
        source: { ...seed.source, operation, subject, reportDateTimeRaw: new Date(reported + 9 * 3_600_000).toISOString().replace(".000Z", "+09:00") } };
    };
    const report = (eventId: string) => decodeFixture(F.regular, (xml) => retime("2020-05-12T17:00:00+09:00")(replaceTag("EventID", eventId)(xml)));
    const withInformation = (information: readonly NankaiInformation[]): NankaiUnitState => ({ ...emptyState(), information });
    expect(receive(withInformation(Array.from({ length: 63 }, (_, index) => info(index))), report("N0001"), clock(now)).diagnostics).toEqual([]);
    const full = Array.from({ length: 64 }, (_, index) => info(index));
    const pushed = receive(withInformation(full), report("N0001"), clock(now));
    expect(pushed.diagnostics).toEqual([{ level: "INFO", component: "nankai", reason: "nankaiCapacityEvicted", unit: "U-N", count: 1 }]);
    expect(pushed.state.information).toHaveLength(64);
    expect(pushed.state.information.some((item) => item.subject === full[0].subject)).toBe(false);
    expect(pushed.displayChanges.some((item) => item.subject === full[0].subject && item.after == null)).toBe(true);
    // 退去の順: (1) retainUntil を過ぎたもの → (2) training/test → (3) normal の最古。capacityExceeded を返さない。
    let state = withInformation([info(0), info(1, { operation: "training" }), info(2, { retainUntil: now }),
      ...Array.from({ length: 61 }, (_, index) => info(index + 10))]);
    const evicted: string[] = [];
    for (const eventId of ["N0002", "N0003", "N0004"]) {
      const before = state.information.map((item) => item.subject);
      const step = receive(state, report(eventId), clock(now));
      expect(step.decisions.at(-1)!.decision).toBe("changed");
      state = step.state;
      evicted.push(...before.filter((subject) => !state.information.some((item) => item.subject === subject)));
    }
    expect(evicted).toEqual([info(2).subject, info(1, { operation: "training" }).subject, info(0).subject]);
    // training の報は training の記録だけを退去する（P3-OPCAP-N-AC01）。
    const drill = info(63, { operation: "training" });
    const trainingIn = receive(withInformation([...full.slice(0, 63), drill]), decodeFixture(F.regular, (xml) => retime("2020-05-12T17:00:00+09:00")(
      replaceTag("EventID", "T0001")(xml)).replace("<Status>通常</Status>", "<Status>訓練</Status>")), clock(now)).state.information;
    expect([trainingIn.includes(drill), trainingIn.filter((item) => item.operation === "normal").length, trainingIn.length]).toEqual([false, 63, 64]);
    // 上限 +1 の文字列は切り詰めて truncated（I-U-N.bounds）。
    const long = send(emptyState(), F.advisory, (xml) => xml.replace("<Title>南海トラフ地震臨時情報（巨大地震注意）</Title>", `<Title>${"題".repeat(129)}</Title>`));
    expect(currentOf(long.state)).toMatchObject({ title: "題".repeat(128), truncated: true });
    expect(currentOf(send(emptyState(), F.advisory, (xml) => xml.replace("<Title>南海トラフ地震臨時情報（巨大地震注意）</Title>",
      `<Title>${"題".repeat(128)}</Title>`)).state)).toMatchObject({ truncated: false });

    // pending 128/129 件と 131,072/131,073 byte（Q-NOTICE.capacity）。期限の遅い新しい desktop が A7 の選択順の後ろで外れる。
    const reported = at("2020-05-12T16:32:00+09:00");
    const template = send(emptyState(), F.advisory).intents[0];
    const seeded = (count: number, pad = 0): NankaiIntent[] => Array.from({ length: count }, (_, index) => ({ ...template,
      id: `seed-${index}`, subject: `normal/VYSE51/S${index}`, source: { ...template.source, family: "VYSE51", subject: `normal/VYSE51/S${index}` },
      payload: { ...template.payload, body: index === 0 ? "x".repeat(1 + pad) : "x" },
      createdAt: reported - 1000, expiresAt: reported + 179_000 }));
    const fits = send({ ...emptyState(), intents: seeded(126) }, F.advisory);
    expect([fits.intents.length, pending(fits.state).length, fits.diagnostics]).toEqual([2, 128, []]);
    const over = send({ ...emptyState(), intents: seeded(127) }, F.advisory);
    expect(over.intents.map((item) => item.channel)).toEqual(["sound"]);
    expect(over.diagnostics).toMatchObject([{ reason: "notificationCapacityEvicted", count: 1 }]);
    const bytesOf = (values: readonly NankaiIntent[]) => Buffer.byteLength(JSON.stringify(values));
    const fresh = send(emptyState(), F.advisory).intents;
    // 配送の更新で伸びうる byte（attempts 16 桁・nextAttemptAt 25 文字・disposition 3 文字まで）を予約した残りが pending の予算
    // （作者裁定、Q-C8-IMPL-AMEND(7)(8)）。
    const growth = (item: NankaiIntent) => 16 - JSON.stringify(item.attempts).length + 25 - JSON.stringify(item.nextAttemptAt).length + 3;
    const pad = 131_072 - bytesOf([...seeded(10), ...fresh]) - [...seeded(10), ...fresh].reduce((sum, item) => sum + growth(item), 0);
    expect(pending(send({ ...emptyState(), intents: seeded(10, pad) }, F.advisory).state)).toHaveLength(12);
    const byteOver = send({ ...emptyState(), intents: seeded(10, pad + 1) }, F.advisory);
    expect([byteOver.intents.map((item) => item.channel), bytesOf(pending(byteOver.state)) <= 131_072]).toEqual([["sound"], true]);
    // 終端記録の合計が 98,304 byte を超える分は最古から期限前に回収する。配送（intentUpdate）で増えた分も同じで、保存物を decode が受ける。
    const terminal = (count: number): NankaiIntent[] => seeded(count).map((item, index) => ({ ...item, id: `done-${index}`,
      createdAt: reported - 100_000 + index, disposition: "delivered" }));
    const terminalBytes = (values: readonly NankaiIntent[]) => values.filter((item) => item.disposition !== "pending")
      .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + 1, 0);
    let count = 0;
    while (terminalBytes(terminal(count + 1)) <= 98_304) count++;
    const filled: NankaiUnitState = { ...emptyState(), intents: [...terminal(count), ...seeded(1)] };
    const delivered = reduceNankaiUnit(filled, { kind: "intentUpdate", clock: clock(reported), intentUpdate: { id: "seed-0", attempts: 1,
      nextAttemptAt: reported, disposition: "delivered" } });
    expect(terminalBytes(delivered.state.intents)).toBeLessThanOrEqual(98_304);
    expect(delivered.state.intents.some((item) => item.id === "done-0")).toBe(false);
    expect(roundTrip(delivered.state).kind).toBe("restored");
    const superseding = send({ ...emptyState(), intents: [...terminal(count), ...seeded(1).map((item) => ({ ...item,
      subject: NANKAI, source: { ...item.source, family: "VYSE50", subject: NANKAI } }))] }, F.advisory);
    expect(terminalBytes(superseding.state.intents)).toBeLessThanOrEqual(98_304);

    // I-U-N.capacityMeasurement の同時最大状態（実例の最大）と、上限の文字列での上界。どちらも encode でき 262,144 byte 以下で decode が受ける。
    const real = budgetState(false);
    const bound = budgetState(true);
    const sizes = [real, bound].map((item) => Buffer.byteLength(JSON.stringify(nankaiUnitCodec.encode(item))));
    console.info("P3-C8 capacity", JSON.stringify({ realPayload: sizes[0], contractReal: 234_927, boundPayload: sizes[1], contractBound: 258_489,
      realCurrent: Buffer.byteLength(JSON.stringify(real.currents[0])), realVyse60Current: Buffer.byteLength(JSON.stringify(real.currents[3])),
      realIntent: Buffer.byteLength(JSON.stringify(real.intents[0])), boundCurrent: Buffer.byteLength(JSON.stringify(bound.currents[0])),
      realCounts: [real.intents.filter((item) => item.disposition === "pending").length, real.intents.filter((item) => item.disposition !== "pending").length],
      boundCounts: [bound.intents.filter((item) => item.disposition === "pending").length, bound.intents.filter((item) => item.disposition !== "pending").length],
      boundIntent: Buffer.byteLength(JSON.stringify(bound.intents[0])),
      realInformation: Buffer.byteLength(JSON.stringify(infoOf(send(emptyState(), F.regular).state, "normal/VYSE52/20200512164400"))),
      realHeading: Buffer.byteLength(JSON.stringify(toNankaiView(send(emptyState(), F.warning).state).information[0])) }));
    for (const item of [real, bound]) expect(roundTrip(item).kind).toBe("restored");
    expect(Math.max(...sizes)).toBeLessThanOrEqual(262_144);

    // 保持上限付近で受信 1 回は記録単位の加算だけ（state・配列・既存の記録を直列化しない）。
    const near: NankaiUnitState = { ...real, information: Array.from({ length: 64 }, (_, index) => info(index)) };
    receive(near, report("N0005"), clock(now));
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      receive(near, report("N0005"), clock(now));
      const whole = new Set<unknown>([near, near.currents, near.information, near.intents, ...near.currents, ...near.information, ...near.intents]);
      expect(stringify.mock.calls.filter(([value]) => whole.has(value))).toEqual([]);
    } finally { stringify.mockRestore(); }
  });

  // contractBoundary: I-U-N.persisted・I-U-N.decode、復元で intent を作らない（AC05）。
  it("P3-C8-T05 contractBoundary / AC05: one codec, persisted fields only, every decode check and restore without new intents", () => {
    const state = chain([F.inv1, F.warning, F.c1]).at(-1)!.state;
    const withVyse60 = send(state, F.vyse60, undefined, at("2020-05-12T16:40:00+09:00")).state;
    const payload = JSON.parse(JSON.stringify(nankaiUnitCodec.encode(withVyse60))) as JsonValue;
    expect(Object.keys(payload as object).sort()).toEqual(["currents", "evidence", "intents", "schemaVersion"]);
    expect(nankaiUnitCodec.decode(payload)).toEqual({ kind: "restored", state: { ...withVyse60, contentRevision: 0,
      information: withVyse60.information.map(evidenceOnly),
      persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } } });
    type Row = Record<string, unknown>;
    const value = payload as { currents: Row[]; intents: Row[] };
    const [nankai, vyse60] = value.currents;
    const intent = value.intents[0];
    const source = nankai.source as Row;
    const withCurrent = (patch: Row) => ({ ...value, currents: [{ ...nankai, ...patch }] });
    const ended = { subject: nankai.subject, operation: "normal", eventId: nankai.eventId, source, retainUntil: nankai.retainUntil, line: "nankai" };
    const many = <T>(length: number, make: (index: number) => T): T[] => Array.from({ length }, (_, index) => make(index));
    const invalid: [string, unknown][] = [
      ["schemaVersion", { ...value, schemaVersion: "p3-nankai-unit-v0" }],
      ["currents > 6", { ...value, currents: many(7, (index) => ({ ...nankai, subject: `normal/nankai/current${index}` })) }],
      ["duplicate current", { ...value, currents: [nankai, nankai] }],
      ["subject form", withCurrent({ subject: "normal/nankai/now", source: { ...source, subject: "normal/nankai/now" } })],
      ["line and operation", withCurrent({ subject: "training/nankai/current" })],
      ["VYSE60 family on the nankai line", withCurrent({ source: { ...source, family: "VYSE60" } })],
      ["EventID not printable ASCII", withCurrent({ eventId: "地震" })],
      ["EventID over 64 bytes", withCurrent({ eventId: "a".repeat(65) })],
      ["inputId over 64", withCurrent({ source: { ...source, inputId: "i".repeat(65) } })],
      ["ReportDateTime over 40", withCurrent({ source: { ...source, reportDateTimeRaw: "2020-05-12T16:28:00.0000000000000000+09:00" } })],
      ["Serial over 10 digits", withCurrent({ source: { ...source, serialRaw: "12345678901" } })],
      ["InfoType", withCurrent({ source: { ...source, infoTypeRaw: "不明" } })],
      ["ended keeps facts", { ...value, currents: [{ ...ended, effective: "ended", title: "x" }] }],
      ["VYSE60 ended", { ...value, currents: [{ ...vyse60, effective: "ended", status: undefined }] }],
      ["status outside the line", withCurrent({ status: "subsequentAdvisory" })],
      ["validUntil", withCurrent({ validUntil: Number(nankai.validUntil) + 1 })],
      ["retainUntil", withCurrent({ retainUntil: Number(nankai.retainUntil) + 1 })],
      ["title over 128", withCurrent({ title: "x".repeat(129) })],
      ["headline over 512", withCurrent({ headline: "x".repeat(513) })],
      ["code over 8", withCurrent({ infoSerial: { code: "123456789", name: null } })],
      ["pending > 128", { ...value, intents: many(129, (index) => ({ ...intent, id: `pending-${index}`, disposition: "pending" })) }],
      ["pending > 131072 bytes", { ...value, intents: many(100, (index) => ({ ...intent, id: `big-${index}`, disposition: "pending",
        payload: { ...(intent.payload as Row), body: "x".repeat(1400) } })) }],
      // 実 byte は 131,072 以下でも、配送の更新の予約を足すと超える pending（受理と同じ式、Q-C8-IMPL-AMEND(7)）。
      ["pending + delivery reserve > 131072 bytes", { ...value, currents: [], intents: reserveOver(intent)  }],
      ["attempts not a safe integer", { ...value, intents: [{ ...intent, attempts: Number.MAX_SAFE_INTEGER + 1 }] }],
      // 終端記録は pending との合計で数える（Q-C8-IMPL-AMEND(1)）。世代の上限の手前の 229,377〜262,143 byte に置く。
      ["pending + terminal > 229,376 bytes", { ...value, currents: [], intents: many(100, (index) => ({ ...intent, id: `done-${index}`,
        disposition: "delivered", payload: { ...(intent.payload as Row), body: "x".repeat(1_700) } })) }],
      ["duplicate intent", { ...value, intents: [intent, intent] }],
      ["intent of another unit", { ...value, intents: [{ ...intent, unit: "U-Q" }] }],
      ["intent subject form", { ...value, intents: [{ ...intent, subject: "normal/VXSE53/20200512162800",
        source: { ...(intent.source as Row), subject: "normal/VXSE53/20200512162800" } }] }],
    ];
    const combined = Buffer.byteLength(JSON.stringify((invalid.find(([name]) => name.startsWith("pending + terminal"))![1] as { intents: unknown }).intents));
    expect(combined > 229_376 && combined < 262_144 - 400, String(combined)).toBe(true);
    for (const [name, candidate] of invalid) expect(nankaiUnitCodec.decode(candidate as JsonValue).kind, name).toBe("invalid");
    // 値域は狭めない（作者裁定、Q-C8-IMPL-AMEND(8)）: worker の時計（Date.now() に performance の小数を足す）の小数の nextAttemptAt、
    // 負の時刻、大きな attempts を受ける。
    for (const [name, patch] of [["attempts 1000", { attempts: 1000 }], ["nextAttemptAt fraction", { nextAttemptAt: Number(intent.nextAttemptAt) + 0.123456 }],
      ["nextAttemptAt negative", { nextAttemptAt: -0.0000018927186924017318 }], ["attempts max safe", { attempts: Number.MAX_SAFE_INTEGER }]] as const)
      expect(nankaiUnitCodec.decode({ ...value, intents: [{ ...intent, ...patch }] } as JsonValue).kind, name).toBe("restored");
    // 情報系列は復元で空なので、情報 subject の intent が state に無いことは unavailable の理由にしない。
    expect(nankaiUnitCodec.decode({ ...value, currents: [], intents: value.intents.filter((item) => item.subject !== NANKAI) } as JsonValue).kind)
      .toBe("restored");

    // 契約境界（保存の境界）: 上限の長さの報を受信 → encode → JSON → decode まで通す。6 件の現況（2 系統 × 3 区分）を
    // EventID 64 byte・inputId 64 文字・ReportDateTime 40 文字・Serial 10 桁・上限を超える 3 byte 文字の文字列で作る。
    let bounded = emptyState();
    const now = at("2020-05-12T16:28:00+09:00");
    for (const [name, headType] of [[F.warning, "VYSE50"], [F.vyse60, "VYSE60"]] as const) for (const status of ["通常", "訓練", "試験"]) {
      const xml = boundaryXml(fixtureXml(name), status);
      const step = receive(bounded, decodeXml(xml, headType, `${headType}${status}`.padEnd(64, "i")), clock(now));
      expect(step.decisions[0].decision, `${headType} ${status}`).toBe("changed");
      bounded = step.state;
    }
    expect(bounded.currents.map((item) => [item.subject, item.effective === "active" && item.truncated])).toHaveLength(6);
    expect(bounded.currents.every((item) => item.effective === "active" && item.truncated && item.title.length === 128)).toBe(true);
    expect(roundTrip(bounded).kind).toBe("restored");

    const restoredAt = at("2020-05-12T16:29:00+09:00");
    const restored = reduceNankaiUnit(emptyState(), { kind: "restore", persisted: nankaiUnitCodec.encode(state), clock: clock(restoredAt) });
    expect(restored.intents).toEqual([]);
    expect(restored.state.intents).toEqual(state.intents.filter((item) => item.expiresAt > restoredAt));
    expect(restored.state.intents.length).toBeGreaterThan(0);
    expect(restored.state.information).toEqual(state.information.map(evidenceOnly));
    expect(restored.outcomes).toMatchObject([{ kind: "recoveryApplied", scope: ["U-N"], coverage: [NANKAI] }]);
  });

  // acceptance: Q-NOTICE の南海トラフ分（AC07）。
  it("P3-C8-T06 acceptance / AC07: opportunities, the NOTICE-LEVELS=B table, replacement, title/body, intentUpdate, training and restart", () => {
    // 報自身の InfoSerial/Code で決める（P3-C8-NOTICE-LEVELS=B）。
    const level = (code: string | null) => levels(send(emptyState(), F.advisory, (xml) => code == null
      ? xml.replace(/<InfoSerial[\s\S]*<\/InfoSerial>/, "") : xml.replace("<Code>130</Code>", `<Code>${code}</Code>`)))[0];
    expect(["120", "130", "111", "112", "113", "210", "219", "190", "200", "999", null].map(level)).toEqual(["desktop:critical",
      ...Array(6).fill("desktop:warning"), "desktop:info", "desktop:info", "desktop:warning", "desktop:warning"]);
    expect(levels(send(emptyState(), F.vyse60))).toEqual(["desktop:warning", "sound:warning"]);
    const advisory = send(emptyState(), F.advisory);
    expect(levels(send(advisory.state, F.cancel))).toEqual(["desktop:cancel", "sound:cancel"]);
    expect(advisory.intents.map((item) => [item.subject, item.transition, item.expiresAt - item.createdAt, item.nextAttemptAt - item.createdAt]))
      .toEqual([[NANKAI, "activated", 180_000, 0], [NANKAI, "activated", 60_000, 0]]);
    // revisionOnly・duplicate・stale・未受信の対象の取消では作らない。訂正は事実が同じでも作る。
    const c1 = send(emptyState(), F.c1).state;
    const sameFacts = send(c1, F.c1, (xml) => retime("2020-05-12T16:39:00+09:00")(replaceTag("Serial", "2")(xml)));
    expect([shape(sameFacts), sameFacts.intents]).toEqual([[["normal/VYSE51/20200512163800", "changed", "revisionOnly"]], []]);
    expect(send(advisory.state, F.advisory).intents).toEqual([]);
    expect(send(emptyState(), F.otherCancel).intents).toEqual([]);
    const corrected = send(advisory.state, F.advisory, (xml) => replaceTag("InfoType", "訂正")(xml));
    expect(shape(corrected)).toEqual([[NANKAI, "changed", "revisionOnly"], ["normal/VYSE50/20200512163200", "changed", "revisionOnly"]]);
    expect(corrected.intents.map((item) => [item.payload.title, item.payload.body.startsWith("訂正: "), item.transition]))
      .toEqual([["[訂正] 南海トラフ地震臨時情報（巨大地震注意）", true, "updated"], ["[訂正] 南海トラフ地震臨時情報（巨大地震注意）", true, "updated"]]);
    // 置換（P3-C8-REPLACEMENT=A）: 巨大地震警戒が未配送の調査中を置き換え、解説は互いに消さない。
    const replaced = send(send(emptyState(), F.inv1).state, F.warning, retime("2020-05-12T16:20:30+09:00")).state;
    expect(replaced.intents.map((item) => [item.payload.level, item.disposition])).toEqual([["warning", "superseded"], ["warning", "superseded"],
      ["critical", "pending"], ["critical", "pending"]]);
    const commentaries = send(send(emptyState(), F.c1).state, F.regular, retime("2020-05-12T16:38:30+09:00")).state;
    expect(pending(commentaries).map((item) => item.subject)).toEqual(["normal/VYSE51/20200512163800", "normal/VYSE51/20200512163800",
      "normal/VYSE52/20200512164400", "normal/VYSE52/20200512164400"]);
    // body は Headline、無ければ本文の先頭 80 文字、それも無ければ Head/Title。
    const noHeadline = (xml: string) => xml.replace(/<Headline>[\s\S]*?<\/Headline>/, "");
    const text = fixtureXml(F.advisory).match(/<EarthquakeInfo[\s\S]*?<Text>([\s\S]*?)<\/Text>/)![1].trim();
    expect(send(emptyState(), F.advisory, noHeadline).intents[0].payload.body).toBe(text.slice(0, 80));
    expect(send(emptyState(), F.advisory, (xml) => noHeadline(xml).replace(/(<EarthquakeInfo[\s\S]*?)<Text>[\s\S]*?<\/Text>/, "$1"))
      .intents[0].payload.body).toBe("南海トラフ地震臨時情報（巨大地震注意）");
    // intentUpdate: 既存 id だけを一括で更新し、保存世代を 1 つ進める。未知 id・同値は no-op。
    const [desktop] = advisory.intents;
    const updated = reduceNankaiUnit(advisory.state, { kind: "intentUpdate", clock: clock(desktop.createdAt), intentUpdate: [{ id: desktop.id,
      attempts: 1, nextAttemptAt: desktop.createdAt + 1_000, disposition: "pending" }, { id: "unknown", attempts: 1, nextAttemptAt: 0,
      disposition: "delivered" }] });
    expect(updated.state.persistence.currentGeneration).toBe(advisory.state.persistence.currentGeneration + 1);
    expect(updated.decisions).toMatchObject([{ decision: "changed", change: "deliveryOnly" }]);
    expect(reduceNankaiUnit(updated.state, { kind: "intentUpdate", clock: clock(desktop.createdAt), intentUpdate: { id: desktop.id, attempts: 1,
      nextAttemptAt: desktop.createdAt + 1_000, disposition: "pending" } }).state).toBe(updated.state);
    // 復元直後の続報は復元した現況との差で決める（同じ報は duplicate で鳴らさない。情報系列は空から始まる）。
    const restored = reduceNankaiUnit(emptyState(), { kind: "restore", persisted: nankaiUnitCodec.encode(advisory.state),
      clock: clock(desktop.createdAt + 1) }).state;
    expect(send(restored, F.advisory).intents).toEqual([]);
    expect(levels(send(restored, F.advisory2))).toEqual(["desktop:warning", "sound:warning"]);
    expect(send(emptyState(), F.advisory, (xml) => xml.replace("<Status>通常</Status>", "<Status>試験</Status>")).intents
      .map((item) => [item.channel, item.payload.title])).toEqual([["desktop", "【試験】南海トラフ地震臨時情報（巨大地震注意）"]]);
  });

  // 実不具合の再発防止（C8 実装のレビュー、Q-C8-IMPL-AMEND(1)・(2)）。
  it("P3-C8-T04 regression / AC04: the owner adopts a terminal update at the terminal budget", () => {
    const reported = at("2020-05-12T16:32:00+09:00");
    const template = send(emptyState(), F.advisory).intents[0];
    const terminalBytes = (values: readonly NankaiIntent[]) => values.filter((item) => item.disposition !== "pending")
      .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + 1, 0);
    // (1) 古い pending の再試行待ちの間に新しい終端記録が 98,304 byte 近くまで溜まり、その pending の配送が完了しても、owner が
    // 照合する更新した記録は残る（回収は次に古い終端記録から）。urgent の owner は投げない。
    const old: NankaiIntent = { ...template, id: "old-pending", createdAt: reported - 100_000, expiresAt: reported + 80_000 };
    const done = (index: number): NankaiIntent => ({ ...template, id: `done-${index}`, createdAt: reported + index, disposition: "delivered" });
    let count = 0;
    while (terminalBytes([...Array.from({ length: count + 1 }, (_, index) => done(index))]) <= 98_304) count++;
    const unitState: NankaiUnitState = { ...emptyState(), intents: [old, ...Array.from({ length: count }, (_, index) => done(index))] };
    const now = clock(reported + 1_000);
    const empty = restoreOwner({ runId: "run", place: "urgent", clock: now, restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const owner = { ...empty, units: { ...empty.units, "U-N": unitState } };
    const updated = intentUpdateOwner(owner, "U-N", [{ id: old.id, attempts: 1, nextAttemptAt: now.wallTimeMs, disposition: "delivered" }],
      now, linkedUnitTable);
    expect(updated.adopted).toBe(true);
    const after = updated.state.units["U-N"]!;
    expect(after.intents.find((item) => item.id === old.id)?.disposition).toBe("delivered");
    expect(after.intents.some((item) => item.id === "done-0")).toBe(false);
    expect(roundTrip(after).kind).toBe("restored");
  });

  // 実不具合の再発防止（C8 実装のレビュー、Q-C8-IMPL-AMEND(2)）。
  it("P3-C8-T05 regression / AC05: pending admitted at its budget survives save, restore, delivery updates, save and restore through the owner", () => {
    // (2)(7)(8) 受理 → 保存 → 復元 → 配送の更新（最長: attempts 16 桁、nextAttemptAt 25 文字）→ 保存 → 復元。予約は受理と decode で同じ式。
    let full = emptyState();
    for (let index = 0; index < 200; index++)
      // 見出しを長くして、件数より先に byte の上限に当てる。
      full = send(full, F.c1, (xml) => retime("2020-05-12T16:38:00+09:00")(replaceTag("EventID", `G${index}`)(xml))
        .replace(/<Headline>\s*<Text>[\s\S]*?<\/Text>/, `<Headline><Text>${"震".repeat(300)}</Text>`)).state;
    expect(pending(full).length).toBeLessThan(128);
    const first = roundTrip(full);
    if (first.kind !== "restored") throw new Error("the admitted state does not decode");
    const now = clock(at("2020-05-12T16:38:00+09:00"));
    const empty = restoreOwner({ runId: "run", place: "urgent", clock: now, restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const owner = { ...empty, units: { ...empty.units, "U-N": first.state } };
    const grown = intentUpdateOwner(owner, "U-N", pending(first.state).map((item, index) => ({ id: item.id, attempts: Number.MAX_SAFE_INTEGER,
      nextAttemptAt: -0.0000018927186924017318, disposition: index % 3 === 0 ? "superseded" as const : "pending" as const })), now, linkedUnitTable);
    expect(grown.adopted).toBe(true);
    expect(roundTrip(grown.state.units["U-N"]!).kind).toBe("restored");
  });

  // 実不具合の再発防止（C8 実装のレビュー、Q-C8-IMPL-AMEND(3)）。
  it("P3-C8-T03 regression / AC03: an original arriving after its cancel revives neither the current nor the information", () => {
    // (3) 取消が先着すると、遅れて届いた同じ報（headType・EventID）の古い元報は現況にも情報にも当たらない。
    const cancelFirst = send(emptyState(), F.cancel).state;
    const late = send(cancelFirst, F.advisory);
    expect(shape(late)).toEqual([[NANKAI, "unchanged", "stale"], ["normal/VYSE50/20200512163200", "unchanged", "stale"]]);
    expect([late.state, currentOf(late.state)]).toEqual([cancelFirst, undefined]);
  });

  // 実不具合の再発防止（C8 実装のレビュー、Q-C8-IMPL-AMEND(4)・P3）。
  it("P3-C8-T06 regression / AC07: the follow-up after restore, the correction to ended and information-only changes", () => {
    const reported = at("2020-05-12T16:32:00+09:00");
    // (4) 復元の後、現況の source と同じ報の事実の同じ続報は鳴らさない（情報系列は空でも、復元した現況との差で決める）。訂正は鳴らす。
    const restored = reduceNankaiUnit(emptyState(), { kind: "restore", persisted: nankaiUnitCodec.encode(send(emptyState(), F.advisory).state),
      clock: clock(reported + 1) }).state;
    const follow = send(restored, F.advisory, retime("2020-05-12T16:33:00+09:00"));
    expect([shape(follow)[0], follow.intents]).toEqual([[NANKAI, "changed", "revisionOnly"], []]);
    expect(send(restored, F.advisory, (xml) => replaceTag("InfoType", "訂正")(retime("2020-05-12T16:33:00+09:00")(xml))).intents)
      .toHaveLength(2);
    // P3: 現況の source への訂正が効かない code へ直して ended になっても transition は updated。
    const advisory = send(emptyState(), F.advisory).state;
    const toUnknown = send(advisory, F.advisory, (xml) => replaceTag("InfoType", "訂正")(xml).replace("<Code>130</Code>", "<Code>999</Code>"));
    expect([status(toUnknown.state), toUnknown.intents.map((item) => item.transition)]).toEqual(["ended", ["updated", "updated"]]);
    // 情報系列だけの変化（revisionOnly・期限の回収）でも証拠が変わるので保存世代を進める（P3-AUTH-AC01(5)、K2 前は進めなかった）。
    const c1 = send(emptyState(), F.c1);
    const revisionOnly = send({ ...c1.state, intents: [] }, F.c1, (xml) => retime("2020-05-12T16:39:00+09:00")(replaceTag("Serial", "2")(xml)));
    expect(revisionOnly.state.persistence.currentGeneration).toBe(c1.state.persistence.currentGeneration + 1);
    const gone = reduceNankaiUnit({ ...c1.state, intents: [] }, { kind: "deadline", clock: clock(at("2020-05-12T16:38:00+09:00") + 7 * DAY) });
    expect([gone.state.information, gone.state.persistence.currentGeneration]).toEqual([[], c1.state.persistence.currentGeneration + 1]);
  });

  // 実不具合の再発防止（F15、P3-CODEC-AC04）: Headline の無い報で Text から切り出す本文がサロゲートの対を割らない（body 全体には 80 単位の上限を置かない）。
  it("P3-CODEC-T03 regression / AC04: the body cut from Text keeps a surrogate pair whole", () => {
    const step = send(emptyState(), F.warning, (xml) => xml.replace(/<Headline>[\s\S]*?<\/Headline>/, "")
      .replace(/(<EarthquakeInfo[^>]*>[\s\S]*?)<Text>[\s\S]*?<\/Text>/, `$1<Text>${"あ".repeat(79)}😀</Text>`));
    expect(step.intents.map((item) => item.payload.body)).toEqual(["あ".repeat(79), "あ".repeat(79)]);
    expect(roundTrip(step.state).kind).toBe("restored");
  });

  // contractBoundary（P3-CODEC-AC03・RES-05、P3-AUTH-RES-01）: 現況 6 件の上限の形（inputId・title・headline・infoSerial を制御文字で上限まで）に
  // 証拠 64 件（subject 80 字・最長の安全な整数の時刻・Serial 10 桁・取消）と通知の予算（pending の実 byte＋予約と終端記録で 229,376）を
  // 足しても 273,259 byte の内側。
  it("P3-CODEC-T02 contractBoundary / AC03: six bounded currents, 64 evidence records and the whole notice budget stay within 273,259 bytes", () => {
    const wide = (length: number) => "\u0001".repeat(length);
    const currents = budgetState(true).currents.map((item): NankaiCurrent => {
      const source = { ...item.source, inputId: wide(64) };
      return "title" in item ? { ...item, source, title: wide(128), headline: wide(512), infoSerial: { code: item.infoSerial?.code ?? "0", name: wide(32) } }
        : { ...item, source };
    });
    const evidence = Array.from({ length: 64 }, (_, index): NankaiInformation => {
      const eventId = String(index).padStart(64, "E"), subject = `training/VYSE51/${eventId}`, reportDateTimeMs = -9_007_199_254_740_991;
      return { subject, family: "VYSE51", eventId, operation: "training", retainUntil: reportDateTimeMs + 7 * DAY, effective: "evidence",
        evidence: { subject, reportDateTimeMs, serialRaw: "1234567890", infoTypeRaw: "取消" } };
    });
    const state: NankaiUnitState = { ...emptyState(), currents, information: evidence };
    expect(roundTrip(state).kind).toBe("restored");
    const envelope = Buffer.byteLength(JSON.stringify({ schemaVersion: "p3-nankai-unit-v1", unit: "U-N", generation: 0, capturedAt: 0,
      payload: nankaiUnitCodec.encode(state), sha256: "0".repeat(64) }));
    console.info("P3-CODEC U-N bound", JSON.stringify({ currents: currents.length, evidence: evidence.length, envelope,
      bound: envelope + 62 - 2 + 229_376 }));
    // 空の intents 配列（2 byte）を通知の予算 229,376 で置き換え、generation と capturedAt の 62 byte を予約する。
    expect(envelope + 62 - 2 + 229_376).toBeLessThanOrEqual(273_259);
  });

  // contractBoundary: E22 の U-N は対象外（P3-C8-N2、AC13）。
  it("P3-C8-T10 contractBoundary / AC13: origin=recovery is not applied", () => {
    const state = send(emptyState(), F.advisory).state;
    const recovery = receive(state, decodeXml(fixtureXml(F.advisory2), "VYSE50", "recovered", "recovery"), clock(at("2020-05-12T16:35:00+09:00")));
    expect(recovery.state).toBe(state);
    expect(recovery.decisions).toMatchObject([{ decision: "unchanged", reason: "noChange" }]);
    expect([recovery.intents, recovery.outcomes, recovery.confirmationEvidence, recovery.displayChanges]).toEqual([[], [], [], []]);
  });

  // corpusHistory: expectedDecisions の 17 step、O07:35〜44 の保存・復元・時計、E13（AC09）。
  it("P3-C8-T08 corpusHistory / AC09: O01:68-79, O02:49-54, O07:35-44 and the E13 population", () => {
    const o01 = replay("O01", 68, 79);
    // :73・:74 は同じ subject・channel の desktop の pending を置き換え、:75 の訂正は :74 の pending を両 channel とも置き換える。
    expect(o01[11].intents.map((item) => [item.payload.level, item.payload.title])).toEqual([["info", "南海トラフ地震臨時情報（調査終了）"],
      ["info", "南海トラフ地震臨時情報（調査終了）"]]);
    expect(o01[7].intents.map((item) => [item.payload.level, item.payload.title, item.payload.body.startsWith("訂正: ")]))
      .toEqual([["warning", "[訂正] 南海トラフ地震関連解説情報（第３号）", true], ["warning", "[訂正] 南海トラフ地震関連解説情報（第３号）", true]]);
    expect(o01[8].intents.map((item) => [item.payload.level, item.payload.title, item.payload.body]))
      .toEqual([["cancel", "[取消] 南海トラフ地震臨時情報（巨大地震注意）", "この情報は取り消されました"],
        ["cancel", "[取消] 南海トラフ地震臨時情報（巨大地震注意）", "この情報は取り消されました"]]);
    expect(status(o01[11].state)).toBe("cancelled");
    expect(o01[2].intents.map((item) => [item.subject, item.transition, item.payload.level])).toEqual([[NANKAI, "updated", "critical"],
      [NANKAI, "updated", "critical"]]);
    const o02 = replay("O02", 49, 54);
    expect(o02[1].intents.map((item) => item.payload.level)).toEqual(["warning", "warning"]);
    expect(o02[1].state.currents).toEqual([]);
    expect(currentOf(o02[5].state, "normal/VYSE60/current")).toMatchObject({ effective: "active", status: "subsequentAdvisory",
      validUntil: at("2024-07-18T16:30:00+09:00") + 7 * DAY });
    const o07 = replay("O07", 35, 44);
    // :38 の復元は intent を作らず、:36 の pending を元の期限で戻す。:39 の取消は復元した現況を取り消し、その pending を置き換える。
    expect(o07[3].state.intents.map((item) => [item.channel, item.expiresAt])).toEqual(o07[1].state.intents.map((item) => [item.channel, item.expiresAt]));
    expect(o07[3].state.information).toEqual(o07[2].state.information.map(evidenceOnly));
    expect(o07[4].state.intents.filter((item) => item.subject === NANKAI && item.transition === "activated").map((item) => item.disposition))
      .toEqual(["superseded", "superseded"]);
    expect(infoOf(o07[4].state, "normal/VYSE50/20200512163200")).toMatchObject({ effective: "cancelled" });
    // :43 は validUntil の 1 ms 前で active、:44 の到来で expired。通知しない。
    expect(currentOf(o07[8].state)).toMatchObject({ effective: "active", validUntil: at("2020-05-19T16:28:00+09:00") });
    expect(currentOf(o07[9].state)).toMatchObject({ effective: "expired", retainUntil: at("2020-06-11T16:28:00+09:00") });
    expect(o07[9].intents).toEqual([]);

    // E13: fixtureIds の全正常 fixture を各 fixture の時刻の時計で受け、期限処理の後も残る恒常的な unavailable は U-N に無い。
    const groups: Record<string, string[]> = { changed: [], rejected: [] };
    for (const id of contract.contract.fixtureIds) {
      const fixture = manifest.fixtures.find((item) => item.fixtureId === id)!;
      const material = decodeFixture(fixture.path);
      const step = receive(emptyState(), material, clock(Date.parse(material.reportDateTimeRaw)));
      const after = reduceNankaiUnit(step.state, { kind: "deadline", clock: clock(Date.parse(material.reportDateTimeRaw) + 1) }).state;
      expect(Object.keys(toNankaiView(after).admission), id).toEqual([]);
      groups[step.decisions.at(-1)!.decision === "changed" ? "changed" : "rejected"].push(id);
    }
    expect(groups.rejected).toEqual(["test__fixtures__synthetic_VYSE50_no_earthquake_info"]);
    expect(groups.changed).toHaveLength(16);
  });

  // 版の比較（P3-REVISION-ORDER-001）: 74_01_04 を t−60 秒の初報にし、同じ時刻 t の Serial と InfoType（と EventID）だけを替えた報を当てる。
  const ORDER_AT = at("2020-05-12T16:28:00+09:00");
  const ordered = () => send(emptyState(), F.warning, retime("2020-05-12T16:27:00+09:00")).state;
  const version = ([serial, infoType]: readonly [string, string], eventId = "20200512162800") => decodeFixture(F.warning,
    (xml) => replaceTag("EventID", eventId)(replaceTag("InfoType", infoType)(replaceTag("Serial", serial)(xml))));
  const verdict = (step: NankaiUnitStep) => step.decisions.map((item) => item.decision === "unchanged" ? item.reason : item.decision);

  // regression（監査 F02）: 同時刻の Serial 2 の発表・Serial 空の訂正・Serial 1 の取消は、6 順列とも、各手順の前に復元を挟んでも取消で終わる。
  it("P3-ORDER-T01 regression / AC02: the F02 triple ends in the Serial 1 cancel in all 6 orders, with and without a restore before each step", () => {
    const first = ordered();
    const reports = { A: version(["2", "発表"]), B: version(["", "訂正"]), C: version(["1", "取消"]) };
    // owner の復元と同じく、保存物（encode→JSON）を保存世代を引き継いだ state へ restore で戻す。
    const restart = (state: NankaiUnitState) => {
      const decoded = roundTrip(state);
      if (decoded.kind !== "restored") throw new Error("the saved state does not decode");
      const generation = state.persistence.currentGeneration;
      return reduceNankaiUnit({ ...emptyState(), persistence: { kind: "saved", currentGeneration: generation, savedGeneration: generation,
        savedCapturedAt: null, savedAckAt: null, dirtySince: null } }, { kind: "restore", persisted: nankaiUnitCodec.encode(decoded.state),
        clock: clock(ORDER_AT) }).state;
    };
    const finals = [false, true].flatMap((restarting) => ["ABC", "ACB", "BAC", "BCA", "CAB", "CBA"].map((order) => [...order].reduce(
      (state, key) => receive(restarting ? restart(state) : state, reports[key as keyof typeof reports], clock(ORDER_AT)).state, first)));
    expect(finals.map((state) => [currentOf(state)?.effective, currentOf(state)?.source.serialRaw, currentOf(state)?.source.infoTypeRaw,
      pending(state).map((item) => [item.channel, item.transition]), roundTrip(state).kind]))
      .toEqual(Array(12).fill(["cancelled", "1", "取消", [["desktop", "cancelled"], ["sound", "cancelled"]], "restored"]));
  });

  // contractBoundary: 同時刻の 2 報は InfoType の優先 → 同じ EventID なら Serial（欠落はどの数値よりも小）で決まり、到着順によらない
  // （AC01・AC03(a)〜(c)）。EventID の違う 2 報は Serial を比べず同じ版で、先着を保って食い違い（AC03(e)）。
  it("P3-ORDER-T02 contractBoundary / AC01,AC03: InfoType before Serial, a missing Serial below any number, EventIDs apart, in both orders", () => {
    const first = ordered();
    // [一方, 他方, 勝つ方]
    const rows: [readonly [string, string], readonly [string, string], 0 | 1][] = [
      [["9", "発表"], ["1", "訂正"], 1], [["", "訂正"], ["1", "取消"], 1], [["2", "発表"], ["1", "発表"], 0], [["", "発表"], ["1", "発表"], 1]];
    for (const [one, other, winner] of rows) for (const [early, late, lateWins] of [[one, other, winner === 1], [other, one, winner === 0]] as const) {
      const step = receive(receive(first, version(early), clock(ORDER_AT)).state, version(late), clock(ORDER_AT));
      expect([verdict(step), step.diagnostics, [currentOf(step.state)?.source.serialRaw, currentOf(step.state)?.source.infoTypeRaw]],
        `${early}→${late}`).toEqual([Array(2).fill(lateWins ? "changed" : "stale"), [], lateWins ? late : early]);
    }
    const apart = [version(["2", "発表"], "20200512162900"), version(["1", "発表"])];
    for (const [early, late] of [apart, [...apart].reverse()]) {
      const step = receive(receive(first, early, clock(ORDER_AT)).state, late, clock(ORDER_AT));
      expect([verdict(step)[0], currentOf(step.state)?.eventId, step.diagnostics]).toMatchObject(["stale", early.eventIdRaw,
        [{ level: "WARN", reason: "nankaiRevisionConflict", unit: "U-N" }]]);
    }
  });

  // 監査 F03: 取消が先着した後の元報。復元は owner と同じく保存物（encode→JSON）を保存世代を引き継いだ state へ戻す。
  const restartAt = (state: NankaiUnitState, now: number) => {
    const decoded = roundTrip(state);
    if (decoded.kind !== "restored") throw new Error("the saved state does not decode");
    const generation = state.persistence.currentGeneration;
    return reduceNankaiUnit({ ...emptyState(), persistence: { kind: "saved", currentGeneration: generation, savedGeneration: generation,
      savedCapturedAt: null, savedAckAt: null, dirtySince: null } }, { kind: "restore", persisted: nankaiUnitCodec.encode(decoded.state),
      clock: clock(now) }).state;
  };

  // regression（監査 F03、P3-AUTH-AC01・AC02）: 修正前は復元で情報 subject が消え、元報が changed/semantic×2・現況 active・pending 2 で復活した。
  it("P3-AUTH-T01 regression / AC01,AC02: an original after its cancel stays stale with and without a restore, and version evidence survives", () => {
    const t = at("2020-05-12T16:38:00+09:00");
    const cancel = receive(emptyState(), decodeFixture(F.warning, (xml) => replaceTag("InfoType", "取消")(retime("2020-05-12T16:38:00+09:00")(xml))),
      clock(t));
    expect(cancel.state.persistence.currentGeneration).toBe(1);
    const original = decodeFixture(F.warning, retime("2020-05-12T16:37:00+09:00"));
    for (const [label, state] of [["direct", cancel.state], ["restored", restartAt(cancel.state, t + 1_000)]] as const) {
      const late = receive(state, original, clock(t + 1_000));
      expect([shape(late), late.state.currents, pending(late.state)], label).toEqual([[[NANKAI, "unchanged", "stale"],
        ["normal/VYSE50/20200512162800", "unchanged", "stale"]], [], []]);
      expect(late.state, label).toBe(state);
    }
    // 版の証拠: 現況に効かない VYSE52（Code 200）の Serial 2 を復元した後、Serial 1 は stale、Serial 2 の再送は duplicate（どちらも intent 0）。
    const at44 = clock(at("2020-05-12T16:44:00+09:00"));
    const serial = (value: string) => decodeFixture(F.regular, replaceTag("Serial", value));
    const restored = restartAt(receive(emptyState(), serial("2"), at44).state, at44.wallTimeMs);
    expect([serial("1"), serial("2")].map((material) => { const step = receive(restored, material, at44);
      return [verdict(step), step.intents.length]; })).toEqual([[["stale"], 0], [["duplicate"], 0]]);
  });

  // contractBoundary（P3-AUTH-AC06）: 旧保存（evidence の鍵が無い）は証拠 0 件で復元し、証拠の decode の不正は invalid。
  it("P3-AUTH-T05 contractBoundary / AC06: a legacy payload restores with no evidence and malformed evidence is invalid", () => {
    const state = chain([F.warning, F.c1, F.regular]).at(-1)!.state;
    const payload = JSON.parse(JSON.stringify(nankaiUnitCodec.encode(state))) as { evidence: Record<string, unknown>[] };
    const { evidence: _evidence, ...legacy } = payload;
    const decoded = nankaiUnitCodec.decode(legacy as JsonValue);
    expect([decoded.kind, decoded.kind === "restored" && decoded.state.information]).toEqual(["restored", []]);
    const [first] = payload.evidence;
    const many = Array.from({ length: 65 }, (_, index) => ({ ...first, subject: `normal/VYSE51/K${index}` }));
    const invalid: [string, unknown][] = [
      ["65 records", { ...payload, evidence: many }],
      ["duplicate subject", { ...payload, evidence: [first, first] }],
      ["subject form", { ...payload, evidence: [{ ...first, subject: "normal/VXSE53/K1" }] }],
      ["subject without an EventID", { ...payload, evidence: [{ ...first, subject: "normal/VYSE51" }] }],
      ["Serial", { ...payload, evidence: [{ ...first, serialRaw: "0" }] }],
      ["InfoType", { ...payload, evidence: [{ ...first, infoTypeRaw: "不明" }] }],
      ["time not an integer", { ...payload, evidence: [{ ...first, reportDateTimeMs: 1.5 }] }],
      ["evidence not a list", { ...payload, evidence: null }],
    ];
    expect(nankaiUnitCodec.decode({ ...payload, evidence: many.slice(0, 64) } as JsonValue).kind).toBe("restored");
    for (const [name, candidate] of invalid) expect(nankaiUnitCodec.decode(candidate as JsonValue).kind, name).toBe("invalid");
  });

  // regression（監査 F05・F16）: 満杯の情報系列 64 に到着の時点で期限を過ぎた別の EventID を受けても退去せず、最終の state に無い
  // subject を accepted・currentEstablished に出さず、保存世代も進めない（P3-FINAL-AC01・AC02）。
  it("P3-FINAL-T02 regression / F05・F16: an expired information newcomer evicts nothing and is not reported as current", () => {
    const t = at("2026-01-01T10:00:00+09:00");
    const iso = (ms: number) => new Date(ms + 32_400_000).toISOString().replace(".000Z", "+09:00");
    const report = (id: number, time: number) => decodeFixture("75_01_01_200512_VYSE51", (xml) => replaceTag("ReportDateTime", iso(time))(
      replaceTag("EventID", String(id).padStart(14, "0"))(xml)));
    let state = emptyState();
    for (let id = 1; id <= 64; id++) state = receive(state, report(id, t), clock(t)).state;
    const step = receive(state, report(65, t - 8 * DAY), clock(t));
    expect([step.state.information, step.state.currents, step.state.persistence]).toEqual([state.information, state.currents, state.persistence]);
    expect(step.decisions).toEqual([expect.objectContaining({ decision: "changed", change: "revisionOnly", currentEstablished: null })]);
    expect([step.outcomes, step.intents, step.displayChanges, step.diagnostics]).toEqual([[{ kind: "accepted", change: "revisionOnly", subjects: [] }], [], [], []]);
    // 記録の無い現況への 31 日前の VYSE50 も足さず、保存世代を進めない（AC01(5)、品質レビュー P2-3）。
    const lone = receive(emptyState(), decodeFixture(F.inv1, replaceTag("ReportDateTime", iso(t - 31 * DAY))), clock(t));
    expect([lone.state.currents, lone.state.information, lone.state.persistence]).toEqual([[], [], emptyState().persistence]);
  });
});

// sequences.json の履歴 oracle（expected:<seq>:<position>）を step ごとに照合する。save と restart は codec を通す。
function replay(sequenceId: string, from: number, to: number): NankaiUnitStep[] {
  const sequence = corpus.sequences.find((item) => item.sequenceId === sequenceId)!;
  const expectations = new Map(corpus.expectations.map((item) => [item.expectedId, item]));
  let state = emptyState();
  let savedPayload: JsonValue | null = null;
  const steps: NankaiUnitStep[] = [];
  for (const step of sequence.steps.filter((item) => item.position >= from && item.position <= to)) {
    const expected = expectations.get(step.expectedRef)!;
    const label = step.expectedRef;
    if (step.action === "save") {
      savedPayload = JSON.parse(JSON.stringify(nankaiUnitCodec.encode(state))) as JsonValue;
      steps.push({ ...reduceNankaiUnit(state, { kind: "deadline", clock: clock(step.evaluatedAt) }), state });
      continue;
    }
    if (step.action === "restart") {
      const restored = savedPayload == null ? null : nankaiUnitCodec.decode(savedPayload);
      if (restored != null) expect(restored.kind, label).toBe("restored");
      const next = restored?.kind === "restored" ? reduceNankaiUnit(emptyState(), { kind: "restore",
        persisted: nankaiUnitCodec.encode(restored.state), clock: clock(step.evaluatedAt) }) : null;
      if (next != null) expect(next.intents, label).toEqual([]);
      state = next?.state ?? emptyState();
      savedPayload = null;
      steps.push(next ?? reduceNankaiUnit(state, { kind: "deadline", clock: clock(step.evaluatedAt) }));
      if (expected.effective != null) expect(currentOf(state)?.effective, label).toBe("active");
      continue;
    }
    if (step.action === "advanceClock") {
      const result = reduceNankaiUnit(state, { kind: "deadline", clock: clock(step.evaluatedAt) });
      steps.push(result);
      state = result.state;
      if (expected.effective != null) expect(currentOf(state)?.effective, label).toBe(expected.effective.kind === "active" ? "active"
        : expected.effective.cause?.kind ?? null);
      continue;
    }
    const fixture = manifest.fixtures.find((item) => item.fixtureId === step.fixtureId)!;
    // owner と同じく、受信の前に到来した期限を回収する（reclaimDeadlineBeforeReceive）。
    state = reduceNankaiUnit(state, { kind: "deadline", clock: clock(step.receivedAt!) }).state;
    const result = receive(state, decodeFixture(fixture.path), clock(step.receivedAt!));
    steps.push(result);
    const made = result.decisions[0];
    if (expected.decision != null) expect({ kind: made.decision, ...("change" in made ? { change: made.change } : {}),
      ...(made.decision === "unchanged" || made.decision === "rejected" ? { reason: made.reason } : {}) }, label).toEqual(expected.decision);
    expect(result.decisions.map((item) => item.subject), label).toEqual(expect.arrayContaining(expected.subjects.map((item) => item.subject)));
    for (const subject of expected.subjects) {
      // stale の報の revision は報自身のもので、保存した記録には入らない。
      if (made.decision === "rejected" || made.decision === "unchanged" && made.reason === "stale") break;
      const record = subject.subject.endsWith("/current") ? currentOf(result.state, subject.subject) : infoOf(result.state, subject.subject);
      if (record == null || record.effective === "evidence") throw new Error(`${label} ${subject.subject} has no source`);
      const source = record.source;
      expect({ reportDateTimeRaw: source.reportDateTimeRaw, serialRaw: source.serialRaw, infoTypeRaw: source.infoTypeRaw },
        `${label} ${subject.subject}`).toEqual(subject.revision);
    }
    if (expected.effective != null) {
      const first = expected.subjects[0].subject;
      const record = first.endsWith("/current") ? currentOf(result.state, first) : infoOf(result.state, first);
      expect(record!.effective === "active" ? { kind: "active" } : { kind: "inactive", cause: { kind: record!.effective } }, label)
        .toEqual(expected.effective);
    }
    if (expected.intents != null) expect(result.intents.length > 0, label).toBe(expected.intents);
    if (expected.notices != null) expect(result.intents.length > 0, label).toBe(expected.notices);
    state = result.state;
  }
  return steps;
}


// I-U-N.capacityMeasurement の同時最大状態: 現況 6 件（2 系統 × 3 区分）に、pending と終端記録を byte の上限まで同じ intent で詰める。
// 実例の最大は 74_01_04・80_01_01 の現況と 80_01_01 の intent、上界（I-U-N.capacityReserve）は保存の境界の報の現況と intent。
function budgetState(bounded: boolean): NankaiUnitState {
  const now = at("2020-05-12T16:28:00+09:00");
  let state = emptyState();
  for (const [name, headType] of [[F.warning, "VYSE50"], [F.vyse60, "VYSE60"]] as const) for (const status of ["通常", "訓練", "試験"]) {
    const xml = bounded ? boundaryXml(fixtureXml(name), status) : fixtureXml(name).replace("<Status>通常</Status>", `<Status>${status}</Status>`);
    state = receive(state, decodeXml(xml, headType, bounded ? `${headType}${status}`.padEnd(64, "i") : undefined), clock(now)).state;
  }
  const base = bounded ? state.intents[0] : send(emptyState(), F.vyse60).intents[0];
  const sized = (index: number, disposition: NankaiIntent["disposition"]): NankaiIntent => ({ ...base, id: `${base.id}:${index}`, disposition,
    createdAt: now, expiresAt: now + 180_000 });
  const bytes = (item: NankaiIntent) => Buffer.byteLength(JSON.stringify(item));
  const pendingIntents: NankaiIntent[] = [];
  for (let size = 2, index = 0; pendingIntents.length < 128; index++) {
    // pending の予算は配送の更新の予約込み（Q-C8-IMPL-AMEND(8)）。
    const item = sized(index, "pending"), width = bytes(item) + (pendingIntents.length === 0 ? 0 : 1)
      + 16 - JSON.stringify(item.attempts).length + 25 - JSON.stringify(item.nextAttemptAt).length + 3;
    if (size + width > 131_072) break;
    pendingIntents.push(item);
    size += width;
  }
  const terminal: NankaiIntent[] = [];
  for (let size = 0, index = 1000; ; index++) {
    const item = sized(index, "delivered");
    if (size + bytes(item) + 1 > 98_304) break;
    terminal.push(item);
    size += bytes(item) + 1;
  }
  return { ...state, intents: [...pendingIntents, ...terminal] };
}

// 保存の境界の報: EventID 64 byte、ReportDateTime 40 文字、Serial 10 桁、全ての文字列を上限より長い 3 byte の文字で埋める。
function boundaryXml(xml: string, status: string): string {
  const wide = (length: number) => "震".repeat(length);
  const time = "2020-05-12T16:28:00.00000000000000+09:00";
  let next = retime(time)(replaceTag("EventID", "E".repeat(64))(replaceTag("Serial", "1234567890")(xml)))
    .replace("<Status>通常</Status>", `<Status>${status}</Status>`)
    .replace(/(<Head[^>]*>\s*)<Title>[^<]*<\/Title>/, `$1<Title>${wide(200)}</Title>`)
    .replace(/<Headline>\s*<Text>[\s\S]*?<\/Text>/, `<Headline><Text>${wide(600)}</Text>`)
    .replace(/(<EarthquakeInfo[^>]*>\s*)<InfoKind>[^<]*<\/InfoKind>/, `$1<InfoKind>${wide(100)}</InfoKind>`);
  if (!next.includes("<InfoSerial")) next = next.replace(/(<EarthquakeInfo[^>]*>\s*<InfoKind>[^<]*<\/InfoKind>)/,
    `$1<InfoSerial><Name>${wide(40)}</Name><Code>${"9".repeat(12)}</Code></InfoSerial>`);
  else next = next.replace(/<Name>[^<]*<\/Name>/, `<Name>${wide(40)}</Name>`);
  return next;
}

// 実 byte が 131,072 ちょうどで、予約（attempts 0・nextAttemptAt 13 桁・disposition の 3）を足すと超える pending。
function reserveOver(intent: Record<string, unknown>): Record<string, unknown>[] {
  const make = (index: number, pad: number) => ({ ...intent, id: `fit-${index}`, disposition: "pending",
    payload: { ...(intent.payload as Record<string, unknown>), body: "x".repeat(1 + pad) } });
  const items = Array.from({ length: 64 }, (_, index) => make(index, 0));
  const pad = 131_072 - Buffer.byteLength(JSON.stringify(items));
  items[0] = make(0, pad);
  if (Buffer.byteLength(JSON.stringify(items)) !== 131_072) throw new Error("pending is not 131,072 bytes");
  return items;
}
