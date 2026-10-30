import { describe, expect, it, vi } from "vitest";
import { withLongestMarks } from "../unreadable-mark/longest-mark";

import { LONGEST_NOTICE, expectRestoreStarted } from "../notice-ledger/notice-fixture";
import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { JsonValue, ReportRef, WallBasis } from "../../contracts/p2-shared-runtime.types";
import type { NankaiCurrent, NankaiInformation, NankaiIntent, NankaiUnitState, NankaiUnitStep } from "../../contracts/p3-nankai-unit.types";
import contract from "../../contracts/p3-nankai-unit.json";
import corpus from "../../tools/corpus/sequences.json";
import manifest from "../../tools/corpus/manifest.json";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { intentUpdateOwner, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { classifyHeadType, placeOfHeadType } from "../../src/runtime/unit-coverage";
import { nankaiUnitCodec, recoveryNotices, reduceNankaiUnit, toNankaiView } from "../../src/units/nankai/nankai-unit";
import { deliveryGrowth } from "../../src/notification-delivery/delivery-growth";
import { chain, clock, decodeFixture, decodeXml, emptyState, fixtureXml, receive, replaceTag, retime, send, sentLater } from "./nankai-fixture"; import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES } from "../../src/checkpoint/checkpoint";

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
const iso = (ms: number) => new Date(ms + 32_400_000).toISOString().replace(".000Z", "+09:00");

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
      [event("a\\b"), "identityInvalid"],
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
      source: expect.objectContaining({ family: "VYSE50", subject: NANKAI }), retainUntil: at("2020-05-12T16:36:00+09:00") + 30 * DAY,
      notice: expect.objectContaining({ kinds: ["report"] }) }); // P3-NL-AC02 (2): 系列の記録に通知の印
    expect(ended.intents.map((item) => [item.transition, item.payload.level])).toEqual([["released", "info"], ["released", "info"]]);
    // VYSE51 の第 1〜3 号は同じ EventID の情報 subject の revision で並び、現況と系統の watermark を変えない。
    expect(series.slice(7, 10).map((step) => {
      return infoOf(step.state, "normal/VYSE51/20200512163800")?.source.serialRaw;
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
    // 訂正は後の送信（同じ Control/DateTime の訂正は未確認、P3-VM-AC03）。
    const oldCorrection = send(both, F.warning, (xml) => sentLater(replaceTag("InfoType", "訂正")(xml).replace("巨大地震警戒</Name>", "巨大地震警戒（訂正）</Name>")));
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
    // 同じ時刻（Control/DateTime）で事実が違えば先着を保って stale＋WARN、現況と情報 subject に未確認の印（P3-VM-AC03・AC04）。
    const conflict = send(advisory, F.advisory, (xml) => xml.replace(/<Headline>\s*<Text>[^<]*/, "<Headline><Text>別の見出し"));
    expect(shape(conflict)).toEqual([[NANKAI, "unchanged", "stale"], ["normal/VYSE50/20200512163200", "unchanged", "stale"]]);
    const { unconfirmed: currentMark, ...keptCurrent } = currentOf(conflict.state)!;
    expect([keptCurrent, currentMark?.inputId]).toEqual([currentOf(advisory), conflict.diagnostics[0].inputId]);
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
    // 期限: 現況 7 日、watermark 30 日、情報の表示 7 日（元報の時刻から。記憶は P3-NS-T03）。到来していない deadline は同じ state 参照と空の結果。
    const reported = at("2020-05-12T16:32:00+09:00");
    const quiet = reduceNankaiUnit(advisory, { kind: "deadline", clock: clock(reported + 180_000) }).state;
    const tick = (state: NankaiUnitState, ms: number) => reduceNankaiUnit(state, { kind: "deadline", clock: clock(reported + ms) });
    const before = tick(quiet, 7 * DAY - 60_000);
    expect(before.state).toBe(quiet);
    expect([before.decisions, before.outcomes, before.displayChanges, before.intents, before.diagnostics]).toEqual([[], [], [], [], []]);
    const expired = tick(quiet, 7 * DAY);
    expect([status(expired.state), expired.state.information.map((item) => item.effective), expired.intents]).toEqual(["expired", ["expired"], []]);
    expect(expired.displayChanges.map((item) => [item.subject, item.after])).toEqual([[NANKAI, null], ["normal/VYSE50/20200512163200", null]]);
    expect(currentOf(tick(expired.state, 30 * DAY - 60_000).state)).toBeDefined();
    expect(tick(expired.state, 30 * DAY).state.currents).toEqual([]);
    // 到着の時点で期限を過ぎた報は採用して watermark を進め、同じ reduce で回収する（view に載らず鳴らない）。
    const overdue = send(emptyState(), F.advisory, undefined, reported + 8 * DAY);
    expect([status(overdue.state), overdue.state.information, overdue.intents, overdue.displayChanges]).toEqual(["expired", [], [], []]);
    expect(shape(send(overdue.state, F.advisory, undefined, reported + 8 * DAY))[0]).toEqual([NANKAI, "unchanged", "duplicate"]);
  });
  // 監査 F04 の U-N（P3-OPCAP-N-AC01・AC02）: 復元の後でも training の報は normal の取消の記録を退去せず、取消より古い報は stale のまま。
  it("P3-OPCAP-N-T01 regression / P3-OPCAP-N-AC01,AC02: a training report never evicts a normal cancel's evidence", () => {
    const now = at("2020-05-12T17:00:00+09:00");
    let state = send(emptyState(), F.cancel, undefined, now).state;
    for (let index = 0; index < 63; index++)
      state = send(state, F.regular, replaceTag("EventID", `N${String(index).padStart(13, "0")}`), now).state;
    const restored = reduceNankaiUnit(emptyState(), { kind: "restore", persisted: nankaiUnitCodec.encode(state), clock: clock(now) }).state;
    expect([restored.information.length, restored.information]).toEqual([64, state.information]);
    const training = send(restored, F.regular, (xml) => xml.replace("<Status>通常</Status>", "<Status>訓練</Status>"), now);
    expect(training.state.information).toBe(restored.information);
    expect([shape(training).at(-1), training.decisions.at(-1), training.outcomes, training.intents, training.diagnostics]).toEqual([
      ["training/VYSE52/20200512164400", "changed", "revisionOnly"], expect.objectContaining({ currentEstablished: null }),
      [{ kind: "accepted", change: "revisionOnly", subjects: [] }], [],
      [{ level: "INFO", component: "nankai", reason: "nankaiCapacityEvicted", unit: "U-N", count: 1 }]]);
    const old = send(training.state, F.advisory, undefined, now);
    expect([shape(old), old.intents, old.state.currents]).toEqual([[[NANKAI, "unchanged", "stale"], ["normal/VYSE50/20200512163200", "unchanged", "stale"]],
      [], restored.currents]);
    // 情報 subject を自身の退去で残さなくても、同じ報の現況の採用と通知は今のまま（P3-OPCAP-N-AC02）。pending は空にする（ID と欄の伸びた
    // 124 件の pending が byte の予算に届き、訓練の通知が先に外れるため。P3-NL-AC01・AC06）。
    const drill = send({ ...restored, intents: [] }, F.advisory, (xml) => xml.replace("<Status>通常</Status>", "<Status>訓練</Status>"), now);
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
    const growth = deliveryGrowth;
    const pad = 131_072 - bytesOf([...seeded(10), ...fresh]) - [...seeded(10), ...fresh].reduce((sum, item) => sum + growth(item), 0);
    expect(pending(send({ ...emptyState(), intents: seeded(10, pad) }, F.advisory).state)).toHaveLength(12);
    const byteOver = send({ ...emptyState(), intents: seeded(10, pad + 1) }, F.advisory);
    expect([byteOver.intents.map((item) => item.channel), bytesOf(pending(byteOver.state)) <= 131_072]).toEqual([["sound"], true]);
    // 終端記録の予算は無くなった（P3-NL-AC05 (2)）: 終端の更新は intent を外し、保存物を decode が受ける。
    const delivered = reduceNankaiUnit({ ...emptyState(), intents: seeded(1) }, { kind: "intentUpdate", clock: clock(reported), intentUpdate: {
      id: "seed-0", attempts: 1, nextAttemptAt: reported, disposition: "delivered", lastAttempt: null, replayed: false, expiresAt: 0, lossReason: null } });
    expect(delivered.state.intents).toEqual([]);
    expect(roundTrip(delivered.state).kind).toBe("restored");

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
    expect(Object.keys(payload as object).sort()).toEqual(["currents", "information", "intents", "schemaVersion"]);
    expect(nankaiUnitCodec.decode(payload)).toEqual({ kind: "restored", state: { ...withVyse60, contentRevision: 0,
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
      // 終端の intent は保存しない（P3-NL-AC05 (1)）。
      ["terminal intent", { ...value, intents: [{ ...intent, disposition: "delivered" }] }],
      ["duplicate intent", { ...value, intents: [intent, intent] }],
      ["intent of another unit", { ...value, intents: [{ ...intent, unit: "U-Q" }] }],
      ["intent subject form", { ...value, intents: [{ ...intent, subject: "normal/VXSE53/20200512162800",
        source: { ...(intent.source as Row), subject: "normal/VXSE53/20200512162800" } }] }],
    ];
    for (const [name, candidate] of invalid) expect(nankaiUnitCodec.decode(candidate as JsonValue).kind, name).toBe("invalid");
    // 値域は狭めない（作者裁定、Q-C8-IMPL-AMEND(8)）: worker の時計（Date.now() に performance の小数を足す）の小数の nextAttemptAt、
    // 負の時刻、大きな attempts を受ける。
    for (const [name, patch] of [["attempts 1000", { attempts: 1000 }], ["nextAttemptAt fraction", { nextAttemptAt: Number(intent.nextAttemptAt) + 0.123456 }],
      ["nextAttemptAt negative", { nextAttemptAt: -0.0000018927186924017318 }], ["attempts max safe", { attempts: Number.MAX_SAFE_INTEGER }]] as const)
      expect(nankaiUnitCodec.decode({ ...value, intents: [{ ...intent, ...patch }] } as JsonValue).kind, name).toBe("restored");
    // 記録の無い系列の intent（退去・回収で記録が消えた系列）は unavailable の理由にしない。
    expect(nankaiUnitCodec.decode({ ...value, currents: [], intents: value.intents.filter((item) => item.subject !== NANKAI) } as JsonValue).kind)
      .toBe("restored");

    // 契約境界（保存の境界）: 上限の長さの報を受信 → encode → JSON → decode まで通す。6 件の現況（2 系統 × 3 区分）を
    // EventID 64 byte・inputId ASCII 64 文字・ReportDateTime 40 文字・Serial 10 桁・上限を超える 3 byte 文字の文字列で作る。
    let bounded = emptyState();
    const now = at("2020-05-12T16:28:00+09:00");
    for (const [name, headType] of [[F.warning, "VYSE50"], [F.vyse60, "VYSE60"]] as const) for (const status of ["通常", "訓練", "試験"]) {
      const xml = boundaryXml(fixtureXml(name), status);
      const step = receive(bounded, decodeXml(xml, headType, `${headType}-${["通常", "訓練", "試験"].indexOf(status)}`.padEnd(64, "i")), clock(now));
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
    expect(restored.state.information).toEqual(state.information);
    expect(restored.outcomes).toMatchObject([{ kind: "recoveryApplied", scope: ["U-N"], coverage: [NANKAI, ...state.information.map((item) => item.subject)] }]);
  });

  // acceptance: Q-NOTICE の南海トラフ分（AC07）。
  it("P3-C8-T06 acceptance / AC07: opportunities, the NOTICE-LEVELS=B table, replacement, title/body, intentUpdate, training and restart", () => {
    // 報自身の InfoSerial/Code で決める（P3-C8-NOTICE-LEVELS=B）。
    const level = (code: string | null) => levels(send(emptyState(), F.advisory, (xml) => code == null
      ? xml.replace(/<InfoSerial[\s\S]*<\/InfoSerial>/, "") : xml.replace("<Code>130</Code>", `<Code>${code}</Code>`)))[0];
    // P3-NS-T05（H12）: 調査中（111〜113）は普通の音。111 への訂正も同じ表。
    expect(["120", "130", "111", "112", "113", "210", "219", "190", "200", "999", null].map(level)).toEqual(["desktop:critical",
      "desktop:warning", ...Array(3).fill("desktop:normal"), "desktop:warning", "desktop:warning", "desktop:info", "desktop:info", "desktop:warning",
      "desktop:warning"]);
    expect(levels(send(send(emptyState(), F.inv1).state, F.inv1, (xml) => sentLater(replaceTag("InfoType", "訂正")(xml))))).toEqual(["desktop:normal", "sound:normal"]);
    // corpus 履歴: 実の 74_01_01〜03（111〜113）をそのまま受けても普通の音。
    expect([F.inv1, F.inv2, F.inv3].map((name) => levels(send(emptyState(), name)))).toEqual(Array(3).fill(["desktop:normal", "sound:normal"]));
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
    const corrected = send(advisory.state, F.advisory, (xml) => sentLater(replaceTag("InfoType", "訂正")(xml)));
    expect(shape(corrected)).toEqual([[NANKAI, "changed", "revisionOnly"], ["normal/VYSE50/20200512163200", "changed", "revisionOnly"]]);
    expect(corrected.intents.map((item) => [item.payload.title, item.payload.body.startsWith("訂正: "), item.transition]))
      .toEqual([["[訂正] 南海トラフ地震臨時情報（巨大地震注意）", true, "updated"], ["[訂正] 南海トラフ地震臨時情報（巨大地震注意）", true, "updated"]]);
    // 置換（P3-C8-REPLACEMENT=A）: 巨大地震警戒が未配送の調査中を置き換え、解説は互いに消さない。
    const replaced = send(send(emptyState(), F.inv1).state, F.warning, retime("2020-05-12T16:20:30+09:00")).state;
    // P3-NL-AC05 (1): 置き換えた pending は intents から外れる。
    expect(replaced.intents.map((item) => [item.payload.level, item.disposition])).toEqual([["critical", "pending"], ["critical", "pending"]]);
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
    const updated = reduceNankaiUnit(advisory.state, { kind: "intentUpdate", clock: clock(desktop.createdAt), intentUpdate: [{ ...desktop,
      attempts: 1, nextAttemptAt: desktop.createdAt + 1_000, disposition: "pending", lossReason: null }, { id: "unknown", attempts: 1, nextAttemptAt: 0,
      disposition: "delivered", lastAttempt: null, replayed: false, expiresAt: 0, lossReason: null }] });
    expect(updated.state.persistence.currentGeneration).toBe(advisory.state.persistence.currentGeneration + 1);
    expect(updated.decisions).toMatchObject([{ decision: "changed", change: "deliveryOnly" }]);
    expect(reduceNankaiUnit(updated.state, { kind: "intentUpdate", clock: clock(desktop.createdAt), intentUpdate: { ...desktop, attempts: 1,
      nextAttemptAt: desktop.createdAt + 1_000, disposition: "pending", lossReason: null } }).state).toBe(updated.state);
    // 復元直後の同じ報は duplicate で鳴らさない（情報系列は保存したとおりに戻る、P3-NS-AC01 (3)）。
    const restored = reduceNankaiUnit(emptyState(), { kind: "restore", persisted: nankaiUnitCodec.encode(advisory.state),
      clock: clock(desktop.createdAt + 1) }).state;
    expect(send(restored, F.advisory).intents).toEqual([]);
    expect(levels(send(restored, F.advisory2))).toEqual(["desktop:warning", "sound:warning"]);
    expect(send(emptyState(), F.advisory, (xml) => xml.replace("<Status>通常</Status>", "<Status>試験</Status>")).intents
      .map((item) => [item.channel, item.payload.title])).toEqual([["desktop", "【試験】南海トラフ地震臨時情報（巨大地震注意）"]]);
  });

  // 実不具合の再発防止（C8 実装のレビュー、Q-C8-IMPL-AMEND(1)・(2)）。終端記録の予算は無くなった（P3-NL-AC05 (2)）ので、owner は
  // intent が外れ世代が進んだことで終端の更新の採用を確かめる（AC05 (3)）。urgent の owner は投げない。
  it("P3-C8-T04 regression / AC04: the owner adopts a terminal update that removes the intent", () => {
    const reported = at("2020-05-12T16:32:00+09:00");
    const template = send(emptyState(), F.advisory).intents[0];
    const old: NankaiIntent = { ...template, id: "old-pending", createdAt: reported - 100_000, expiresAt: reported + 80_000 };
    const unitState: NankaiUnitState = { ...emptyState(), intents: [old] };
    const now = clock(reported + 1_000);
    const empty = restoreOwner({ runId: "run", place: "urgent", clock: now, restored: { "U-E": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const owner = { ...empty, units: { ...empty.units, "U-N": unitState } };
    const updated = intentUpdateOwner(owner, "U-N", [{ ...old, attempts: 1, nextAttemptAt: now.wallTimeMs, disposition: "delivered", lossReason: null }],
      now, linkedUnitTable);
    expect(updated.adopted).toBe(true);
    const after = updated.state.units["U-N"]!;
    expect(after.intents).toEqual([]);
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
    const grown = intentUpdateOwner(owner, "U-N", pending(first.state).map((item, index) => ({ ...item, attempts: Number.MAX_SAFE_INTEGER,
      nextAttemptAt: -0.0000018927186924017318, disposition: index % 3 === 0 ? "superseded" as const : "pending" as const, lossReason: null })), now, linkedUnitTable);
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
    const toUnknown = send(advisory, F.advisory, (xml) => sentLater(replaceTag("InfoType", "訂正")(xml).replace("<Code>130</Code>", "<Code>999</Code>")));
    expect([status(toUnknown.state), toUnknown.intents.map((item) => item.transition)]).toEqual(["ended", ["updated", "updated"]]);
    // 情報系列だけの変化（revisionOnly・表示の期限）でも保存世代を進める（P3-NS-AC01 (4)、K2 前は進めなかった）。
    const c1 = send(emptyState(), F.c1);
    const revisionOnly = send({ ...c1.state, intents: [] }, F.c1, (xml) => retime("2020-05-12T16:39:00+09:00")(replaceTag("Serial", "2")(xml)));
    expect(revisionOnly.state.persistence.currentGeneration).toBe(c1.state.persistence.currentGeneration + 1);
    const gone = reduceNankaiUnit({ ...c1.state, intents: [] }, { kind: "deadline", clock: clock(at("2020-05-12T16:38:00+09:00") + 7 * DAY) });
    expect([gone.state.information.map((item) => item.effective), gone.state.persistence.currentGeneration])
      .toEqual([["expired"], c1.state.persistence.currentGeneration + 1]);
  });

  // 実不具合の再発防止（F15、P3-CODEC-AC04）: Headline の無い報で Text から切り出す本文がサロゲートの対を割らない（body 全体には 80 単位の上限を置かない）。
  it("P3-CODEC-T03 regression / AC04: the body cut from Text keeps a surrogate pair whole", () => {
    const step = send(emptyState(), F.warning, (xml) => xml.replace(/<Headline>[\s\S]*?<\/Headline>/, "")
      .replace(/(<EarthquakeInfo[^>]*>[\s\S]*?)<Text>[\s\S]*?<\/Text>/, `$1<Text>${"あ".repeat(79)}😀</Text>`));
    expect(step.intents.map((item) => item.payload.body)).toEqual(["あ".repeat(79), "あ".repeat(79)]);
    expect(roundTrip(step.state).kind).toBe("restored");
  });

  // contractBoundary（P3-NS-T04、P3-NS-AC06 (2)、P3-CODEC-T02 を置き換える）: 現況 6 件（line nankai の 3 件だけ warningUntil）・情報 64 件（重ならない
  // subject 80 字）に未確認の印・最長の通知の印・保留の印を付け、文字列を上限の長さで埋めた世代に pending の予算 131,072 を足しても 2,621,440 byte 以下。
  // 合法な状態は 3 byte の文字・40 文字の ASCII の時刻。解析の上界（Q-NS-BYTES）は同じ形を JSON で 6 byte になる文字で埋め、ReportDateTime を
  // 40 単位×6 byte と数える予約（ReportRef ごとに 200 byte）を足す。
  it("P3-NS-T04 contractBoundary / P3-NS-AC01,AC03,AC06,AC08: decode rejections, the legal large generation and the analytic bound within 2,621,440 bytes", () => {
    const time40 = "2020-05-12T16:28:00.00000000000000+09:00", reported = Date.parse(time40);
    const budget = budgetState(true);
    const build = (char: string, origin: "replay" | "recovery", infoType: string): NankaiUnitState => {
      const wide = (length: number) => char.repeat(length);
      const currents = budget.currents.map((item): NankaiCurrent => {
        if (item.effective !== "active") throw new Error("the bounded currents are active");
        const source = { ...item.source, origin, inputId: "i".repeat(64), controlDateTimeRaw: time40, infoTypeRaw: infoType };
        return { ...item, source, unconfirmed: { ...source, serialRaw: "1234567890", infoTypeRaw: "取消" }, notice: LONGEST_NOTICE, expiryPending: true,
          title: wide(128), headline: wide(512), infoSerial: { code: wide(8), name: wide(32) } };
      });
      const information = Array.from({ length: 64 }, (_, index): NankaiInformation => {
        const eventId = String(index).padStart(64, "E"), subject = `training/VYSE51/${eventId}`;
        const source: ReportRef = { inputId: "i".repeat(64), origin, operation: "training", family: "VYSE51", subject, reportDateTimeRaw: time40,
          controlDateTimeRaw: time40, serialRaw: "1234567890", infoTypeRaw: infoType };
        return { subject, family: "VYSE51", eventId, operation: "training", source, retainUntil: reported + 30 * DAY,
          unconfirmed: { ...source, infoTypeRaw: "取消" }, notice: LONGEST_NOTICE, effective: "active", infoKind: wide(64),
          infoSerial: { code: wide(8), name: wide(32) }, title: wide(128), headline: wide(512), truncated: true, text: wide(4_096),
          nextAdvisory: wide(512), validUntil: reported + 7 * DAY, expiryPending: true };
      });
      return { ...emptyState(), currents, information };
    };
    // 空の intents 配列（2 byte）を通知の予算 131,072 で置き換え、generation と capturedAt の 62 byte と inputBoundary・losses の最大を予約する。
    const generation = (state: NankaiUnitState) => Buffer.byteLength(JSON.stringify({ schemaVersion: "p3-nankai-unit-v8", unit: "U-N", generation: 0,
      capturedAt: 0, payload: nankaiUnitCodec.encode(state), sha256: "0".repeat(64) })) + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES + 62 - 2 + 131_072;
    const legal = build("震", "replay", "発表"), bound = build("\u0001", "recovery", "取消");
    expect(bound.currents.filter((item) => "warningUntil" in item)).toHaveLength(3);
    for (const state of [legal, bound]) {
      const full = { ...state, intents: budget.intents };
      const restored = roundTrip(full);
      if (restored.kind !== "restored") throw new Error("the large generation does not decode");
      expect([restored.state.currents, restored.state.information, restored.state.intents]).toEqual([full.currents, full.information, full.intents]);
    }
    const refs = (bound.currents.length + bound.information.length) * 2;
    const sizes = { legal: generation(legal), bound: generation(bound) + refs * 200, contractBound: 2_335_693, limit: 2_621_440 };
    console.info("P3-NS-T04 U-N generation", JSON.stringify(sizes));
    expect(Math.max(sizes.legal, sizes.bound)).toBeLessThanOrEqual(2_621_440);
    // P3-UM-AC03 (6)・RES-09: 現況と情報の全部の記録に読み戻しの上限いっぱいの印と予算いっぱいの原文を足した上界も、広げた器の内で decode が受ける。
    const marked = { ...bound, intents: budget.intents, currents: withLongestMarks(bound.currents, "infoName", [], 131_072),
      information: withLongestMarks(bound.information, "infoName", [], 0) };
    expect(roundTrip(marked).kind).toBe("restored");
    // P3-VM-AC05 の一覧の寿命（P3-MIG-AC01）: 捨ててよい旧い版の一覧は空で、前の版の slot は unknownSchema で読む。
    expect(nankaiUnitCodec.discardableSchemaVersions).toBeUndefined();

    // decode の拒否の表（invalid）と、受ける形。
    type Row = Record<string, unknown>;
    const base = send(chain([F.warning, F.c1]).at(-1)!.state, F.vyse60, undefined, at("2020-05-12T16:40:00+09:00")).state;
    const payload = JSON.parse(JSON.stringify(nankaiUnitCodec.encode(base))) as { schemaVersion: string; currents: Row[]; information: Row[]; intents: Row[] };
    const [warning, vyse60] = payload.currents;
    const info = payload.information.find((item) => item.family === "VYSE51")!;
    const { infoKind: _kind, infoSerial: _serial, title: _title, headline: _headline, truncated: _truncated, text: _text, nextAdvisory: _next,
      validUntil: _valid, effective: _effective, ...memory } = info;
    const { warningUntil: _warningUntil, ...unwarned } = warning;
    const currents = (row: Row) => ({ ...payload, currents: [row, vyse60] });
    const information = (row: Row) => ({ ...payload, information: [row] });
    const sourceOf = info.source as Row;
    const many = Array.from({ length: 65 }, (_, index) => ({ ...info, eventId: `K${index}`, subject: `normal/VYSE51/K${index}`,
      source: { ...sourceOf, subject: `normal/VYSE51/K${index}` } }));
    const invalid: [string, unknown][] = [
      ["megaquakeWarning without warningUntil", currents(unwarned)],
      ["warningUntil off the formula", currents({ ...warning, warningUntil: Number(warning.warningUntil) + 1 })],
      ["validUntil of a warned current is +7 d", currents({ ...warning, validUntil: Number(warning.validUntil) - 7 * DAY })],
      ["warningUntil on investigating", currents({ ...warning, status: "investigating" })],
      ["warningUntil on VYSE60", { ...payload, currents: [warning, { ...vyse60, warningUntil: Number(vyse60.validUntil) }] }],
      ["warningUntil on an expired current", currents({ ...memory, line: "nankai", effective: "expired", subject: warning.subject, eventId: warning.eventId,
        source: warning.source, retainUntil: warning.retainUntil, warningUntil: warning.warningUntil })],
      ["expired information with facts", information({ ...memory, effective: "expired", title: "x" })],
      ["cancelled information with text", information({ ...memory, effective: "cancelled", text: "x" })],
      ["active information validUntil", information({ ...info, validUntil: Number(info.validUntil) + 1 })],
      ["information retainUntil", information({ ...memory, effective: "expired", retainUntil: Number(info.retainUntil) + 1 })],
      ["unconfirmed of another subject", information({ ...info, unconfirmed: { ...sourceOf, subject: "normal/VYSE51/OTHER" } })],
      ["text over 4096", information({ ...info, text: "x".repeat(4_097) })],
      ["65 information", { ...payload, information: many }],
      ["the evidence key", { schemaVersion: payload.schemaVersion, currents: payload.currents, intents: payload.intents, evidence: payload.information }],
      ["v5", { ...payload, schemaVersion: "p3-nankai-unit-v5" }],
    ];
    for (const [name, candidate] of invalid) expect(nankaiUnitCodec.decode(candidate as JsonValue).kind, name).toBe("invalid");
    for (const [name, candidate] of [["megaquakeAdvisory with warningUntil", currents({ ...warning, status: "megaquakeAdvisory" })],
      ["expired memory", information({ ...memory, effective: "expired" })], ["cancelled", information({ ...memory, effective: "cancelled" })],
      ["64 information", { ...payload, information: many.slice(0, 64) }]] as const)
      expect(nankaiUnitCodec.decode(candidate as JsonValue).kind, name).toBe("restored");
  });

  // contractBoundary: origin=recovery の入口（C16 発注 4a、P3-REC-AC12・P3-C8-N2・UNIT-ENTRANCE=A）。live と同じ意味を当てて intent を作らず、
  // 版が決まらない本文は印も WARN も置かずに noChange（owner が held にする、P3-REC-AC05 の (a)）。
  it("P3-C8-T10 contractBoundary / AC13: origin=recovery applies the meaning without intents and returns an undecided version untouched", () => {
    const state = send(emptyState(), F.advisory).state, now = clock(at("2020-05-12T16:35:00+09:00")), live = receive(state, decodeXml(fixtureXml(F.advisory2), "VYSE50"), now);
    const recovery = receive(state, decodeXml(fixtureXml(F.advisory2), "VYSE50", "recovered", "recovery"), now), unsure = receive(state, decodeXml(fixtureXml(F.advisory).replace(/<Headline>\s*<Text>[^<]*/, "<Headline><Text>別の見出し"), "VYSE50", "unsure", "recovery"), now);
    expect([recovery.decisions.map((item) => item.decision), recovery.state.currents.map(({ notice: _notice, ...rest }) => rest), recovery.intents, recovery.displayChanges.length]).toEqual([live.decisions.map((item) => item.decision), live.state.currents.map(({ notice: _notice, ...rest }) => ({ ...rest, source: { ...rest.source, inputId: "recovered", origin: "recovery" } })), [], live.displayChanges.length]);
    expect([unsure.state === state, unsure.decisions.map((item) => item.decision === "unchanged" ? item.reason : item.decision), unsure.diagnostics]).toEqual([true, ["noChange", "noChange"], []]);
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
      .toEqual([["cancel", "[取消] 南海トラフ地震臨時情報（巨大地震注意）（16:32 発表）", "16:32 発表の南海トラフ地震臨時情報（巨大地震注意）を取り消しました"],
        ["cancel", "[取消] 南海トラフ地震臨時情報（巨大地震注意）（16:32 発表）", "16:32 発表の南海トラフ地震臨時情報（巨大地震注意）を取り消しました"]]);
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
    expect(o07[3].state.information).toEqual(o07[2].state.information);
    // P3-NL-AC05 (1): 置き換えた pending は intents から外れる。
    expect(o07[4].state.intents.filter((item) => item.subject === NANKAI && item.transition === "activated")).toEqual([]);
    expect(infoOf(o07[4].state, "normal/VYSE50/20200512163200")).toMatchObject({ effective: "cancelled" });
    // P3-NS-T07: :43 は warningUntil の 1 ms 前で巨大地震警戒、:44 の到来で巨大地震注意へ移る（active のまま）。通知しない。
    expect(currentOf(o07[8].state)).toMatchObject({ effective: "active", status: "megaquakeWarning", warningUntil: at("2020-05-19T16:28:00+09:00"),
      validUntil: at("2020-05-26T16:28:00+09:00") });
    expect(currentOf(o07[9].state)).toMatchObject({ effective: "active", status: "megaquakeAdvisory", retainUntil: at("2020-06-11T16:28:00+09:00") });
    expect(o07[9].intents).toEqual([]);
    expect(o01[1].intents.map((item) => item.payload.level)).toEqual(["normal", "normal"]);

    // E13: fixtureIds の全正常 fixture を各 fixture の時刻の時計で受け、期限処理の後も残る恒常的な unavailable は U-N に無い。
    const groups: Record<string, string[]> = { changed: [], rejected: [] };
    for (const id of contract.contract.fixtureIds) {
      const fixture = manifest.fixtures.find((item) => item.fixtureId === id)!;
      const material = decodeFixture(fixture.path);
      const step = receive(emptyState(), material, clock(Date.parse(material.reportDateTimeRaw)));
      const after = reduceNankaiUnit(step.state, { kind: "deadline", clock: clock(Date.parse(material.reportDateTimeRaw) + 1) }).state;
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

  // regression（監査 F02）: 同時刻（同じ Control/DateTime）の Serial 2 の発表・Serial 空の訂正・Serial 1 の取消は、報番号と InfoType の順位を
  // 比べず（P3-VM-D-SAMETIME=A）、同じ時刻の取消が勝つので（作者裁定 2026-10-21 昼）、6 順列とも各手順の前に復元を挟んでも取消で終わる。
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
    // 同じ時刻の取消は、どの順でも訂正と発表に勝つ（作者裁定 2026-10-21 昼）。取消の採用で印は外れ、取消の後の取消でない報は stale。
    expect(finals.map((state) => [currentOf(state)?.source.inputId, currentOf(state)?.unconfirmed, roundTrip(state).kind]))
      .toEqual(Array(12).fill([reports.C.inputId, undefined, "restored"]));
  });

  // contractBoundary: 同時刻（同じ Control/DateTime）の 2 報は InfoType と Serial を比べず、取消は取消でない報に勝ち（作者裁定 2026-10-21 昼）、
  // ほかは中身（InfoType を含む）が違えば到着順によらず先着を
  // 残して現況に未確認の印、同じなら Serial が違っても duplicate（P3-VM-D-SAMETIME=A。P3-VM-AC09(1) で K1 の表を置き換える）。
  // EventID の違う 2 報は先着を保って食い違い（AC03(e)）。
  it("P3-ORDER-T02 contractBoundary / AC01,AC03: same-time reports keep the first arrival and mark a different one, EventIDs apart, in both orders", () => {
    const first = ordered();
    // [一方, 他方, 中身が違うか]
    const rows: [readonly [string, string], readonly [string, string], boolean][] = [
      [["9", "発表"], ["1", "訂正"], true], [["", "訂正"], ["1", "取消"], true], [["2", "発表"], ["1", "発表"], false], [["", "発表"], ["1", "発表"], false]];
    for (const [one, other, differs] of rows) for (const [early, late] of [[one, other], [other, one]] as const) {
      const lateMaterial = version(late);
      const step = receive(receive(first, version(early), clock(ORDER_AT)).state, lateMaterial, clock(ORDER_AT));
      // 取消がどちらか一方だけなら取消が勝つ（作者裁定 2026-10-21 昼）。ほかの中身違いは先着を残して後着を印にする。
      const cancelWins = (early[1] === "取消") !== (late[1] === "取消"), lateWins = cancelWins && late[1] === "取消";
      const held = differs && !cancelWins;
      expect([verdict(step), step.diagnostics.map((item) => item.reason), [currentOf(step.state)?.source.serialRaw,
        currentOf(step.state)?.source.infoTypeRaw], currentOf(step.state)?.unconfirmed?.inputId], `${early}→${late}`)
        .toEqual([Array(2).fill(lateWins ? "changed" : differs ? "stale" : "duplicate"), held ? ["nankaiRevisionConflict"] : [], lateWins ? late : early,
          held ? lateMaterial.inputId : undefined]);
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
    // 版の証拠: 現況に効かない VYSE52（Code 200）の Serial 2 を復元した後、同じ Control/DateTime の Serial 1 と Serial 2 の再送はどちらも
    // duplicate（報番号を比べない、P3-VM-D-SAMETIME=A。intent 0）。
    const at44 = clock(at("2020-05-12T16:44:00+09:00"));
    const serial = (value: string) => decodeFixture(F.regular, replaceTag("Serial", value));
    const restored = restartAt(receive(emptyState(), serial("2"), at44).state, at44.wallTimeMs);
    expect([serial("1"), serial("2")].map((material) => { const step = receive(restored, material, at44);
      return [verdict(step), step.intents.length]; })).toEqual([[["duplicate"], 0], [["duplicate"], 0]]);
  });

  // contractBoundary（P3-AUTH-AC06、P3-NS-T04 の残り）: 情報 subject の記録の decode の不正は invalid。information の鍵の無い payload も invalid
  // （旧い形は版で捨てる、P3-NS-AC08）。
  it("P3-AUTH-T05 contractBoundary / AC06: malformed information records and a payload without the information key are invalid", () => {
    const state = chain([F.warning, F.c1, F.regular]).at(-1)!.state;
    const payload = JSON.parse(JSON.stringify(nankaiUnitCodec.encode(state))) as { information: Record<string, unknown>[] };
    const { information: _information, ...legacy } = payload;
    const first = payload.information.find((item) => item.family === "VYSE51")!;
    const source = first.source as Record<string, unknown>;
    const named = (subject: string) => ({ ...first, subject, eventId: subject.split("/")[2], source: { ...source, subject } });
    const invalid: [string, unknown][] = [
      ["duplicate subject", { ...payload, information: [first, first] }],
      ["subject form", { ...payload, information: [named("normal/VXSE53/K1")] }],
      ["subject without an EventID", { ...payload, information: [{ ...first, subject: "normal/VYSE51", source: { ...source, subject: "normal/VYSE51" } }] }],
      ["Serial", { ...payload, information: [{ ...first, source: { ...source, serialRaw: "0" } }] }],
      ["InfoType", { ...payload, information: [{ ...first, source: { ...source, infoTypeRaw: "不明" } }] }],
      ["time not an integer", { ...payload, information: [{ ...first, validUntil: 1.5 }] }],
      ["information not a list", { ...payload, information: null }],
      ["no information key", legacy],
      ["Control/DateTime not a string", { ...payload, information: [{ ...first, source: { ...source, controlDateTimeRaw: 1 } }] }],
    ];
    expect(nankaiUnitCodec.decode({ ...payload, information: Array.from({ length: 64 }, (_, index) => named(`normal/VYSE51/K${index}`)) } as JsonValue).kind)
      .toBe("restored");
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

  // acceptance（P3-NS-T01、H30）: 情報系列の全文と未確認の印を保存して戻し、一覧が再起動の前と同じになる。同じ報の受け直しは鳴らない。
  it("P3-NS-T01 acceptance / P3-NS-AC01,AC02,AC08: the information series and its unconfirmed mark survive save and restore, and a resend is a duplicate", () => {
    const C = "normal/VYSE51/20200512163800";
    const state = chain([F.advisory, F.c1, F.c2, F.c3]).at(-1)!.state;
    const conflict = send(state, F.c3, (xml) => xml.replace(/<Headline>\s*<Text>[^<]*/, "<Headline><Text>別の見出し"));
    expect([shape(conflict), infoOf(conflict.state, C)?.unconfirmed?.inputId, conflict.state.persistence.currentGeneration])
      .toEqual([[[C, "unchanged", "stale"]], conflict.diagnostics[0].inputId, state.persistence.currentGeneration + 1]);
    const decoded = roundTrip(conflict.state);
    if (decoded.kind !== "restored") throw new Error("the saved state does not decode");
    const restored = reduceNankaiUnit(emptyState(), { kind: "restore", persisted: nankaiUnitCodec.encode(decoded.state),
      clock: clock(at("2020-05-12T16:43:00+09:00")) });
    expect(restored.state.information).toEqual(conflict.state.information);
    expect(toNankaiView(restored.state).information).toEqual(toNankaiView(conflict.state).information);
    expect([restored.intents, restored.displayChanges.map((item) => item.subject)])
      .toEqual([[], [NANKAI, ...conflict.state.information.map((item) => item.subject)]]);
    const again = send(restored.state, F.c3);
    expect([shape(again), again.intents]).toEqual([[[C, "unchanged", "duplicate"]], []]);
  });

  // acceptance（P3-NS-T02、作者裁定 2026-10-21 朝の判断 1）: 巨大地震警戒は 7 日で巨大地震注意へ移り、14 日で expired。どの経路でも通知しない
  // （P3-NS-D-STEPDOWN-NOTICE=A）。
  it("P3-NS-T02 acceptance / P3-NS-AC03: the megaquake warning steps down at 7 d and expires at 14 d without a notice on every path", () => {
    const t = at("2020-05-12T16:28:00+09:00"), W = "normal/VYSE50/20200512162800";
    const issued = send(emptyState(), F.warning);
    expect(currentOf(issued.state)).toMatchObject({ status: "megaquakeWarning", warningUntil: t + 7 * DAY, validUntil: t + 14 * DAY });
    // pending の intent の expiresAt も期限の候補なので、配送で片付けた後の nextDeadline が t+7 日。
    expect(issued.nextDeadline?.wallTimeMs).toBe(t + 60_000);
    const settled = reduceNankaiUnit(issued.state, { kind: "intentUpdate", clock: clock(t), intentUpdate: issued.intents.map((item) => ({ id: item.id,
      attempts: 1, nextAttemptAt: t, disposition: "delivered" as const, lastAttempt: null, replayed: false, expiresAt: item.expiresAt, lossReason: null })) });
    expect(settled.nextDeadline?.wallTimeMs).toBe(t + 7 * DAY);
    const tick = (state: NankaiUnitState, ms: number) => reduceNankaiUnit(state, { kind: "deadline", clock: clock(t + ms) });
    expect(tick(settled.state, 7 * DAY - 1).state).toBe(settled.state);
    const stepped = tick(settled.state, 7 * DAY);
    const before = currentOf(settled.state);
    expect(currentOf(stepped.state)).toEqual({ ...before, status: "megaquakeAdvisory" });
    expect([stepped.intents, stepped.state.persistence.currentGeneration, stepped.displayChanges.map((item) => [item.subject, item.after == null])])
      .toEqual([[], settled.state.persistence.currentGeneration + 1, [[NANKAI, false], [W, true]]]);
    expect(stepped.outcomes).toMatchObject([{ kind: "deadlineApplied", subjects: [{ subject: NANKAI, transition: "active", changedFields: ["status"] },
      { subject: W, transition: "expired", changedFields: ["effective"] }] }]);
    expect(stepped.nextDeadline?.wallTimeMs).toBe(t + 14 * DAY);
    const repeat = tick(stepped.state, 7 * DAY);
    expect([repeat.state, repeat.outcomes, repeat.displayChanges, repeat.intents]).toEqual([stepped.state, [], [], []]);
    expect(repeat.state).toBe(stepped.state);
    // 復元の回収: 7 日を越えた復元は移り、14 日を越えた復元は移らずに直接 expired。awaiting で保留した期限も verified の後に移り、intent は 0。
    const restoreAt = (ms: number, basis?: WallBasis) => reduceNankaiUnit(emptyState(), { kind: "restore", persisted: nankaiUnitCodec.encode(settled.state),
      clock: clock(t + ms), basis });
    expect([status(restoreAt(7 * DAY + 1).state), restoreAt(7 * DAY + 1).intents, status(restoreAt(14 * DAY + 1).state)])
      .toEqual(["megaquakeAdvisory", [], "expired"]);
    const held = restoreAt(7 * DAY + 1, "awaiting");
    const applied = reduceNankaiUnit(held.state, { kind: "deadline", clock: clock(t + 7 * DAY + 2), basis: "verified" });
    expect([status(held.state), status(applied.state), applied.intents]).toEqual(["megaquakeWarning", "megaquakeAdvisory", []]);
    // 移った現況への同じ 120 の再送は duplicate（印なし・intent 0）。移った state の保存→復元の後と、情報 subject の退去の後も同じ。
    const late = (state: NankaiUnitState) => send(state, F.warning, undefined, t + 8 * DAY);
    const evicted = { ...stepped.state, information: stepped.state.information.filter((item) => item.subject !== W) };
    for (const [label, state] of [["direct", stepped.state], ["restored", restartAt(stepped.state, t + 8 * DAY)], ["evicted", evicted]] as const) {
      const step = late(state);
      expect([shape(step), currentOf(step.state)?.unconfirmed, step.intents], label).toEqual([[[NANKAI, "unchanged", "duplicate"],
        [W, "unchanged", "duplicate"]], undefined, []]);
    }
    // 移った後の調査中（別の EventID の 111）は現況を置き換えず、情報 subject だけが activated（level normal）。
    const investigating = send(stepped.state, F.inv1, retime(iso(t + 8 * DAY)));
    expect([status(investigating.state), investigating.intents.map((item) => [item.subject, item.transition, item.payload.level])])
      .toEqual(["megaquakeAdvisory", [["normal/VYSE50/20200512162000", "activated", "normal"], ["normal/VYSE50/20200512162000", "activated", "normal"]]]);
    expect([status(tick(stepped.state, 14 * DAY - 1).state), status(tick(stepped.state, 14 * DAY).state), tick(stepped.state, 14 * DAY).intents])
      .toEqual(["megaquakeAdvisory", "expired", []]);
    // 130 は warningUntil を持たず 7 日で expired。120 を置き換えた別の EventID の 130 は、その報から 7 日（二段を引き継がない）。
    const advisory = send(emptyState(), F.advisory), reported = at("2020-05-12T16:32:00+09:00");
    expect([currentOf(advisory.state), status(reduceNankaiUnit(advisory.state, { kind: "deadline", clock: clock(reported + 7 * DAY) }).state)])
      .toEqual([expect.not.objectContaining({ warningUntil: expect.anything() }), "expired"]);
    const replaced = currentOf(send(settled.state, F.advisory, retime(iso(t + 3 * DAY))).state);
    expect([replaced?.effective === "active" && replaced.status, replaced && "warningUntil" in replaced, replaced?.effective === "active" && replaced.validUntil])
      .toEqual(["megaquakeAdvisory", false, t + 10 * DAY]);
  });

  // P3-NS-T03 の共通部: 75_01_01 を t に受け、通知を配送で片付けると印の証拠が possible になる。取消は報の family・EventID・時刻を替えて作る。
  const T03 = at("2020-05-12T16:38:00+09:00"), C1 = "normal/VYSE51/20200512163800";
  const delivered = (step: NankaiUnitStep, now: number) => reduceNankaiUnit(step.state, { kind: "intentUpdate", clock: clock(now),
    intentUpdate: step.intents.map((item) => ({ id: item.id, attempts: 1, nextAttemptAt: now, disposition: "delivered" as const, lastAttempt: null,
      replayed: false, expiresAt: item.expiresAt, lossReason: null })) }).state;
  const cancelAt = (state: NankaiUnitState, eventId: string, headType: string, ms: number) => receive(state, decodeXml(
    replaceTag("DateTime", new Date(ms).toISOString())(retime(iso(ms))(replaceTag("EventID", eventId)(fixtureXml(F.cancel)))), headType), clock(ms));

  // acceptance（P3-NS-T03、P3-NS-AC04 (1)(2)(4)(5)）: 情報は表示の期限で expired の記憶になり（本文と未確認の印を捨てる）、同じ報は duplicate、
  // 記憶の取消は印の証拠で鳴り、取消の記録は取消の時刻＋30 日・記憶は＋30 日で消える。
  it("P3-NS-T03 acceptance / P3-NS-AC04: the information memory, its late cancel by the notice evidence and the 30 d end", () => {
    const issued = send(emptyState(), F.c1);
    // 同じ時刻の別の見出しで未確認の印を付けてから期限を迎える。
    const marked = send(issued.state, F.c1, (xml) => xml.replace(/<Headline>\s*<Text>[^<]*/, "<Headline><Text>別の見出し"));
    expect(infoOf(marked.state, C1)?.unconfirmed).toBeDefined();
    const tick = (state: NankaiUnitState, ms: number) => reduceNankaiUnit(state, { kind: "deadline", clock: clock(T03 + ms) });
    for (const [evidence, state] of [["possible", delivered({ ...issued, state: marked.state }, T03)], ["unattempted", marked.state]] as const) {
      const memory = tick(state, 7 * DAY);
      const record = infoOf(memory.state, C1);
      expect([record?.effective, record?.unconfirmed, record?.notice?.evidence, toNankaiView(memory.state).information], evidence)
        .toEqual(["expired", undefined, evidence, []]);
      expect(memory.outcomes, evidence).toMatchObject([{ kind: "deadlineApplied", subjects: [{ subject: C1, transition: "expired",
        source: { inputId: infoOf(state, C1)?.source.inputId } }] }]);
      expect(Object.keys(nankaiUnitCodec.encode(memory.state).information[0] ?? {}).sort(), evidence)
        .toEqual(["effective", "eventId", "family", "notice", "operation", "retainUntil", "source", "subject"]);
      const resend = send(memory.state, F.c1, undefined, T03 + 10 * DAY);
      expect([shape(resend), resend.intents], evidence).toEqual([[[C1, "unchanged", "duplicate"]], []]);
      const cancel = cancelAt(memory.state, "20200512163800", "VYSE51", T03 + 10 * DAY);
      expect([infoOf(cancel.state, C1)?.effective, levels(cancel)], evidence).toEqual(["cancelled", evidence === "possible" ? ["desktop:cancel", "sound:cancel"] : []]);
      expect([infoOf(tick(cancel.state, 40 * DAY - 1).state, C1)?.effective, infoOf(tick(cancel.state, 40 * DAY).state, C1)], evidence).toEqual(["cancelled", undefined]);
      expect([infoOf(tick(memory.state, 30 * DAY - 1).state, C1)?.effective, infoOf(tick(memory.state, 30 * DAY).state, C1)], evidence).toEqual(["expired", undefined]);
    }
  });

  // acceptance（P3-NS-T03、P3-NS-AC04 (7)、統合担当の決定 D1）: 通知した 130 の現況は期限切れの後も印を持ち、保存と復元を挟んだ取消で鳴る。
  it("P3-NS-T03 acceptance / P3-NS-AC04 (7): an expired current keeps its notice mark and its cancel after a restart is notified", () => {
    const t5 = at("2020-05-12T16:32:00+09:00");
    const lapsed = reduceNankaiUnit(delivered(send(emptyState(), F.advisory), t5), { kind: "deadline", clock: clock(t5 + 7 * DAY) }).state;
    expect([status(lapsed), currentOf(lapsed)?.notice?.evidence]).toEqual(["expired", "possible"]);
    const late = cancelAt(restartAt(lapsed, t5 + 10 * DAY), "20200512163200", "VYSE50", t5 + 10 * DAY);
    expect([status(late.state), late.intents.map((item) => [item.subject, item.payload.level])]).toEqual(["cancelled",
      [[NANKAI, "cancel"], [NANKAI, "cancel"]]]);
  });

  // contractBoundary（P3-NS-T03、P3-NS-AC06 (5)、統合担当の決定 D2）: 64 件の退去は training/test → normal の記憶 → normal の最古。
  // normal だけで 64 件のときの training の報は、受けた記録を残さない。
  it("P3-NS-T03 contractBoundary / P3-NS-AC06 (5): the 65th information evicts training, then the oldest normal memory, never a normal active", () => {
    const seed = infoOf(send(emptyState(), F.c1).state, C1);
    if (seed?.effective !== "active") throw new Error("the seed information is not active");
    // index の小さいほど古い。
    const make = (index: number, operation: Operation, effective: "active" | "expired"): NankaiInformation => {
      const eventId = `M${String(index).padStart(13, "0")}`, subject = `${operation}/VYSE51/${eventId}`, reported = T03 - (100 - index) * 60_000;
      const source = { ...seed.source, operation, subject, reportDateTimeRaw: iso(reported) };
      return effective === "active" ? { ...seed, subject, eventId, operation, source, validUntil: reported + 7 * DAY, retainUntil: reported + 30 * DAY }
        : { subject, family: "VYSE51", eventId, operation, source, retainUntil: reported + 30 * DAY, effective: "expired" };
    };
    const report = (eventId: string, status = "通常") => decodeFixture(F.regular, (xml) => retime(iso(T03))(replaceTag("EventID", eventId)(xml))
      .replace("<Status>通常</Status>", `<Status>${status}</Status>`));
    let state: NankaiUnitState = { ...emptyState(), information: Array.from({ length: 64 }, (_, index) =>
      make(index, index === 0 ? "training" : "normal", index >= 1 && index <= 10 ? "expired" : "active")) };
    const evictedSubjects: string[] = [];
    for (const eventId of ["N0001", "N0002"]) {
      const before = state.information.map((item) => item.subject);
      state = receive(state, report(eventId), clock(T03)).state;
      evictedSubjects.push(...before.filter((subject) => !state.information.some((item) => item.subject === subject)));
    }
    expect(evictedSubjects).toEqual([make(0, "training", "active").subject, make(1, "normal", "expired").subject]);
    expect(state.information.filter((item) => item.effective === "active" && item.operation === "normal")).toHaveLength(53 + 2);
    const normals: NankaiUnitState = { ...emptyState(), information: Array.from({ length: 64 }, (_, index) => make(index, "normal", index < 10 ? "expired" : "active")) };
    const drill = receive(normals, report("T0001", "訓練"), clock(T03));
    expect([drill.state.information, drill.diagnostics]).toEqual([normals.information, [{ level: "INFO", component: "nankai",
      reason: "nankaiCapacityEvicted", unit: "U-N", count: 1 }]]);
  });

  // regression（K13 r2・r3 のレビュー、作者裁定 2026-10-25）: 発表から 7〜14 日の間に初めて届いた 120 は巨大地震注意として出るので、巨大地震注意の
  // 段で 1 回鳴らす。修正前は情報の表示の期限で通知を止め、intent 0 だった。7 日の手前は今どおり巨大地震警戒の段（契約境界）。
  it("P3-NS-T02 regression / P3-NS-AC03: a first 120 between 7 d and 14 d rings once at the advisory level, before 7 d at the warning level", () => {
    const t = at("2020-05-12T16:28:00+09:00");
    const late = send(emptyState(), F.warning, undefined, t + 8 * DAY);
    expect([status(late.state), late.state.information, late.intents.map((item) => [item.subject, item.payload.level])])
      .toEqual(["megaquakeAdvisory", [], [[NANKAI, "warning"], [NANKAI, "warning"]]]);
    expect(send(late.state, F.warning, undefined, t + 9 * DAY).intents).toEqual([]);
    // 実不具合（K13 r3 のレビュー）: 配送の後に Control/DateTime だけ新しい同じ 120 は版だけの更新で、通知しない（修正前は移る前の status の差で
    // warning が 2 件増えた）。
    const follow = send(delivered(late, t + 8 * DAY), F.warning, sentLater, t + 8 * DAY + 1_000);
    expect([status(follow.state), follow.decisions.map((item) => item.decision === "changed" && item.change), follow.intents])
      .toEqual(["megaquakeAdvisory", ["revisionOnly", "revisionOnly"], []]);
    // 見えている巨大地震注意の取消は鳴る（H19、統合担当の決定）: (i) 遅れて届いた 120 (ii) 7 日目に移った 120。(iii) 14 日を過ぎた取消は、印に
    // 通知の証拠が無ければ鳴らない（証拠があれば決定 D1 で鳴る、下の owner の期限の処理の試験）。
    const cancelLevels = (state: NankaiUnitState, ms: number) => levels(cancelAt(state, "20200512162800", "VYSE50", t + ms));
    const moved = reduceNankaiUnit(delivered(send(emptyState(), F.warning), t), { kind: "deadline", clock: clock(t + 7 * DAY) }).state;
    const unheard = reduceNankaiUnit(send(emptyState(), F.warning).state, { kind: "deadline", clock: clock(t + 7 * DAY) }).state;
    expect([status(moved), cancelLevels(delivered(late, t + 8 * DAY), 9 * DAY), cancelLevels(moved, 9 * DAY), cancelLevels(unheard, 14 * DAY + 1)])
      .toEqual(["megaquakeAdvisory", ["desktop:cancel", "sound:cancel"], ["desktop:cancel", "sound:cancel"], []]);
    const early = send(emptyState(), F.warning, undefined, t + 6.9 * DAY);
    expect([status(early.state), levels(early)]).toEqual(["megaquakeWarning", ["desktop:critical", "sound:critical"]]);
    expect(send(emptyState(), F.warning, undefined, t + 14 * DAY).intents).toEqual([]);
  });

  // regression（K13 r4 のレビュー、統合担当の決定 2026-10-25）: 通知の判定は期限を当てた後の見える形で比べるので、受信の前に owner の期限の処理を
  // 通しても（afterTick）通さなくても（direct）同じ結果で、時計の根拠（verified・unverified）と復元の後でも同じ。(a) 普通に届いて通知した 120 は、8 日目に Control/DateTime だけ
  // 新しい同じ報で鳴らない (b) 8 日目に届いて配送した 120 の 14 日＋1 ms の取消は、期限切れの現況の印の証拠で鳴る（決定 D1）。
  it("P3-NS-T02 regression / P3-NS-AC03,AC04 (7): the notice decision is the same with the owner's deadline before receive, on each basis and after a restore", () => {
    const t = at("2020-05-12T16:28:00+09:00");
    // [direct, afterTick] の intent の level。
    const owner = (state: NankaiUnitState, material: ReturnType<typeof decodeFixture>, ms: number, basis: WallBasis) => {
      const input = { kind: "receive" as const, material, clock: clock(t + ms), basis };
      const reclaimed = reduceNankaiUnit(state, { kind: "deadline", clock: clock(t + ms), basis }).state;
      return [reduceNankaiUnit(state, input), reduceNankaiUnit(reclaimed, input)].map(levels);
    };
    const cancelMaterial = (ms: number) => decodeFixture(F.warning, (xml) => replaceTag("DateTime", new Date(t + ms).toISOString())(
      retime(iso(t + ms))(replaceTag("InfoType", "取消")(xml))));
    for (const [label, basis, restored] of [["verified", "verified", false], ["unverified", "unverified", false], ["restored", "verified", true]] as const) {
      const prepare = (state: NankaiUnitState, ms: number) => restored ? restartAt(state, t + ms) : state;
      const normal = delivered(send(emptyState(), F.warning), t);
      expect(owner(prepare(normal, 8 * DAY), decodeFixture(F.warning, sentLater), 8 * DAY, basis), `${label} (a)`).toEqual([[], []]);
      const late = delivered(send(emptyState(), F.warning, undefined, t + 8 * DAY), t + 8 * DAY);
      expect(owner(prepare(late, 14 * DAY + 1), cancelMaterial(14 * DAY + 1), 14 * DAY + 1, basis), `${label} (b)`)
        .toEqual(Array(2).fill(["desktop:cancel", "sound:cancel"]));
    }
  });

  // regression（K13 r5 のレビュー、統合担当の決定 2026-10-25）: awaiting で復元した巨大地震注意は、同じ 120 の Control/DateTime だけ新しい版で
  // 警戒へ戻らず鳴らない（修正前は critical を再配送した）。+8 日に届いた 120 と、普通に届いて 7 日目に移った 120 の両方。
  it("P3-NS-T02 regression / P3-NS-AC03: a restored advisory stays the advisory and silent for a version-only 120 while awaiting", () => {
    const t = at("2020-05-12T16:28:00+09:00");
    const late = delivered(send(emptyState(), F.warning, undefined, t + 8 * DAY), t + 8 * DAY);
    const moved = reduceNankaiUnit(delivered(send(emptyState(), F.warning), t), { kind: "deadline", clock: clock(t + 7 * DAY) }).state;
    for (const [label, state] of [["late", late], ["moved", moved]] as const) {
      const decoded = roundTrip(state);
      if (decoded.kind !== "restored") throw new Error("the saved state does not decode");
      const restored = reduceNankaiUnit(emptyState(), { kind: "restore", persisted: nankaiUnitCodec.encode(decoded.state), clock: clock(t + 8 * DAY),
        basis: "awaiting" }).state;
      const follow = reduceNankaiUnit(restored, { kind: "receive", material: decodeFixture(F.warning, sentLater), clock: clock(t + 8 * DAY + 1_000),
        basis: "awaiting" });
      expect([status(restored), status(follow.state), follow.intents], label).toEqual(["megaquakeAdvisory", "megaquakeAdvisory", []]);
    }
  });

  // P3-UNIT-N-NOTICE-001 の共通部: 74_01_04（120）を T からの経過で、時計の根拠つきで受ける・期限を当てる・復元する。
  const T = at("2020-05-12T16:28:00+09:00"), BASES = ["verified", "unverified", "awaiting"] as const;
  const receiveAt = (state: NankaiUnitState, transform: ((xml: string) => string) | undefined, ms: number, basis: WallBasis) =>
    reduceNankaiUnit(state, { kind: "receive", material: decodeFixture(F.warning, transform), clock: clock(T + ms), basis });
  const tickAt = (state: NankaiUnitState, ms: number, basis: WallBasis) => reduceNankaiUnit(state, { kind: "deadline", clock: clock(T + ms), basis });
  const restoreAt = (state: NankaiUnitState, ms: number, basis: WallBasis) => reduceNankaiUnit(emptyState(), { kind: "restore",
    persisted: nankaiUnitCodec.encode(state), clock: clock(T + ms), basis }).state;
  const notices = (step: NankaiUnitStep) => step.intents.map((item) => `${item.channel}:${item.transition}:${item.payload.level}`);
  const held = (value: NankaiCurrent | NankaiInformation | undefined) => value?.effective === "active" && value.expiryPending === true;
  const ringing = (transition: string, level: string) => [`desktop:${transition}:${level}`, `sound:${transition}:${level}`];

  // regression（K13 の残存リスク (18)、ヘルツの r5 の反例）: 巨大地震注意として出ている 120 へ、同じ ReportDateTime で見出しだけ替えた非訂正の版は
  // 巨大地震注意の段で鳴る（修正前は critical）。7 日の手前は今どおり巨大地震警戒の段（契約境界）。
  it("P3-NN-T01 regression / P3-NN-AC01: a headline change on a shown advisory 120 rings at the advisory level on every basis", () => {
    const changed = (xml: string) => sentLater(xml.replace(/(<Headline>\s*<Text>)[\s\S]*?(<\/Text>)/, "$1追加の防災上の注意事項$2"));
    const normal = delivered(receiveAt(emptyState(), undefined, 0, "verified"), T);
    const late = delivered(receiveAt(emptyState(), undefined, 8 * DAY, "verified"), T + 8 * DAY);
    const moved = tickAt(normal, 7 * DAY, "verified").state;
    for (const basis of BASES) {
      for (const [label, state, ms] of [["late", late, 8 * DAY + 1_000], ["moved", moved, 8 * DAY],
        ["restored", restoreAt(late, 8 * DAY, basis), 8 * DAY + 1_000]] as const) {
        const step = receiveAt(state, changed, ms, basis);
        expect([status(state), status(step.state), notices(step)], `${basis} ${label}`)
          .toEqual(["megaquakeAdvisory", "megaquakeAdvisory", ringing("updated", "warning")]);
      }
      const early = receiveAt(normal, changed, 3 * DAY, basis);
      expect([status(early.state), notices(early)], `${basis} before 7 d`).toEqual(["megaquakeWarning", ringing("updated", "critical")]);
    }
  });

  // regression（K13 の残存リスク (19)）と作者裁定 P3-NN-D-HELD-ADVISORY=A の受入: 保留の巨大地震注意は、時計が戻った awaiting の間に届いた同じ報の
  // 新しい版で保留の印の無い巨大地震注意として戻り、巨大地震注意の段で 1 回鳴り、14 日目まで出る（修正前は critical）。
  it("P3-NN-T02 regression / P3-NN-AC01,AC02: a version update brings back a held advisory at the advisory level until 14 d", () => {
    const normal = delivered(receiveAt(emptyState(), undefined, 0, "verified"), T);
    const stepped = tickAt(normal, 8 * DAY, "unverified").state;
    const pendingAll = tickAt(stepped, 15 * DAY, "unverified").state;
    expect([status(pendingAll), held(currentOf(pendingAll))]).toEqual(["megaquakeAdvisory", true]);
    const back = receiveAt(restoreAt(pendingAll, 9 * DAY, "awaiting"), sentLater, 9 * DAY + 1_000, "awaiting");
    expect([status(back.state), held(currentOf(back.state)), toNankaiView(back.state).currents.map((item) => item.status), notices(back)])
      .toEqual(["megaquakeAdvisory", false, ["megaquakeAdvisory"], ringing("activated", "warning")]);
    const checked = tickAt(back.state, 9 * DAY + 2_000, "verified");
    expect([status(checked.state), checked.intents]).toEqual(["megaquakeAdvisory", []]);
    const end = tickAt(checked.state, 14 * DAY, "verified");
    expect([status(end.state), end.intents]).toEqual(["expired", []]);
    // 対照 (1): 時計が戻らない（validUntil を過ぎた）awaiting では鳴らないが、保留の外れた記録が awaiting の間だけ出る（P3-NN-AC02 (4)、残存リスク (1)）。
    const ahead = receiveAt(restoreAt(pendingAll, 15 * DAY, "awaiting"), sentLater, 15 * DAY + 1_000, "awaiting");
    expect([status(ahead.state), held(currentOf(ahead.state)), toNankaiView(ahead.state).currents.map((item) => item.status), ahead.intents])
      .toEqual(["megaquakeAdvisory", false, ["megaquakeAdvisory"], []]);
    // 対照 (2)（同じ根の別の列）: 注意へ移っただけで情報 subject に保留の印がある state を、時計が戻った T＋2 日に復元する。
    expect([status(stepped), held(currentOf(stepped)), held(infoOf(stepped, "normal/VYSE50/20200512162800"))]).toEqual(["megaquakeAdvisory", false, true]);
    for (const basis of ["awaiting", "verified"] as const) {
      const step = receiveAt(restoreAt(stepped, 2 * DAY, basis), sentLater, 2 * DAY + 1_000, basis);
      expect([status(step.state), notices(step)], basis).toEqual(["megaquakeAdvisory", ringing("updated", "warning")]);
    }
  });

  // contractBoundary（P3-NN-AC01 (3)）: 段が変わらない側のうち、既存の試験（:951・:977・:999・:395）に無い basis の行。
  it("P3-NN-T03 contractBoundary / P3-NN-AC01 (3): a late first 120, a version-only 120, a late cancel and a correction keep their levels on each basis", () => {
    const normal = delivered(receiveAt(emptyState(), undefined, 0, "verified"), T);
    const moved = tickAt(normal, 7 * DAY, "verified").state;
    const late = delivered(receiveAt(emptyState(), undefined, 8 * DAY, "verified"), T + 8 * DAY);
    const unheard = tickAt(receiveAt(emptyState(), undefined, 0, "verified").state, 7 * DAY, "verified").state;
    // (i) 7〜14 日目に初めて届いた 120: unverified は巨大地震注意の段、awaiting は巨大地震警戒の段（K13 の残存リスク (17)）。
    const first = (basis: WallBasis) => { const step = receiveAt(emptyState(), undefined, 8 * DAY, basis); return [status(step.state), notices(step)]; };
    expect(first("unverified")).toEqual(["megaquakeAdvisory", ringing("activated", "warning")]);
    expect(first("awaiting")).toEqual(["megaquakeWarning", ringing("activated", "critical")]);
    for (const basis of ["unverified", "awaiting"] as const) {
      // (ii) Control/DateTime だけ新しい版は鳴らない。
      expect([receiveAt(late, sentLater, 8 * DAY + 1_000, basis).intents, receiveAt(moved, sentLater, 8 * DAY, basis).intents], basis).toEqual([[], []]);
    }
    // (iii) awaiting の 14 日＋1 ms の取消: 印の証拠（配送済み）があれば鳴り、無ければ鳴らない（決定 D1）。
    const ms = 14 * DAY + 1;
    const cancel = (state: NankaiUnitState) => notices(receiveAt(state, (xml) => replaceTag("DateTime", new Date(T + ms).toISOString())(
      retime(iso(T + ms))(replaceTag("InfoType", "取消")(xml))), ms, "awaiting"));
    expect([cancel(late), cancel(moved), cancel(unheard)]).toEqual([ringing("cancelled", "cancel"), ringing("cancelled", "cancel"), []]);
    // (iv) 移った巨大地震注意への訂正は引き継がないので、awaiting では巨大地震警戒の段（ヘルツの品質レビューの P3）。
    for (const [basis, expected, level] of [["verified", "megaquakeAdvisory", "warning"], ["unverified", "megaquakeAdvisory", "warning"],
      ["awaiting", "megaquakeWarning", "critical"]] as const) {
      const step = receiveAt(moved, (xml) => sentLater(replaceTag("InfoType", "訂正")(xml)), 8 * DAY, basis);
      expect([status(step.state), notices(step)], basis).toEqual([expected, ringing("updated", level)]);
    }
  });

  // contractBoundary（P3-NS-T06、H51 の B）: Serial の形の外と InfoSerial/Name の読めない報は断らずに受けて WARN を添える。Code の 2 個以上は今どおり断る。
  it("P3-NS-T06 contractBoundary / P3-NS-AC07: an unreadable Serial or InfoSerial/Name is accepted with a WARN, two Codes are still rejected", () => {
    for (const [name, serial, subject] of [[F.c1, "abc", "normal/VYSE51/20200512163800"], [F.warning, "0", "normal/VYSE50/20200512162800"],
      [F.warning, "12345678901", "normal/VYSE50/20200512162800"]] as const) {
      const step = send(emptyState(), name, replaceTag("Serial", serial));
      expect([step.decisions.map((item) => item.decision), infoOf(step.state, subject)?.source.serialRaw, step.intents.length], serial)
        .toEqual([step.decisions.map(() => "changed"), "", 2]);
      expect(step.diagnostics, serial).toMatchObject([{ level: "WARN", component: "nankai", reason: "identityInvalid", unit: "U-N" }]);
    }
    for (const unread of ["<Name>巨大地震注意</Name><Name>別名</Name>", "<Name><Ruby>巨大地震注意</Ruby></Name>"]) {
      const step = send(emptyState(), F.advisory, (xml) => xml.replace("<Name>巨大地震注意</Name>", unread));
      const current = currentOf(step.state);
      expect([status(step.state), current?.effective === "active" && current.infoSerial, levels(step)], unread)
        .toEqual(["megaquakeAdvisory", { code: "130", name: null }, ["desktop:warning", "sound:warning"]]);
      expect(step.diagnostics, unread).toMatchObject([{ level: "WARN", component: "nankai", reason: "requiredStructureInvalid", unit: "U-N" }]);
    }
    const base = emptyState();
    const twoCodes = receive(base, decodeFixture(F.advisory, (xml) => xml.replace("<Code>130</Code>", "<Code>130</Code><Code>130</Code>")),
      clock(at("2020-05-12T16:32:00+09:00")));
    expect([twoCodes.state, twoCodes.decisions.map((item) => item.decision === "rejected" && item.reason)]).toEqual([base, ["requiredStructureInvalid"]]);
    expect(twoCodes.state).toBe(base);
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
      if (record == null) throw new Error(`${label} ${subject.subject} has no source`);
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
    // inputId は受理と読み戻しの上限（ASCII 64 文字、P3-VM-AC08）いっぱい。
    state = receive(state, decodeXml(xml, headType, bounded ? `${headType}-${["通常", "訓練", "試験"].indexOf(status)}`.padEnd(64, "i") : undefined),
      clock(now)).state;
  }
  const base = bounded ? state.intents[0] : send(emptyState(), F.vyse60).intents[0];
  const sized = (index: number, disposition: NankaiIntent["disposition"]): NankaiIntent => ({ ...base, id: `${base.id}:${index}`, disposition,
    createdAt: now, expiresAt: now + 180_000 });
  const bytes = (item: NankaiIntent) => Buffer.byteLength(JSON.stringify(item));
  const pendingIntents: NankaiIntent[] = [];
  for (let size = 2, index = 0; pendingIntents.length < 128; index++) {
    // pending の予算は配送の更新の予約込み（Q-C8-IMPL-AMEND(8)）。
    const item = sized(index, "pending"), width = bytes(item) + (pendingIntents.length === 0 ? 0 : 1)
      + deliveryGrowth(item);
    if (size + width > 131_072) break;
    pendingIntents.push(item);
    size += width;
  }
  return { ...state, intents: pendingIntents };
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
// P3-NL-AC08 (1)(4)・AC15 (4): started の pending は復元で外れ、failed・null の pending は欄ごと戻る。
it("P3-NL-T07 contractBoundary / AC08・AC15 (4): U-N restores failed and null pending with their fields and drops a started one", () => {
  const issued = send(emptyState(), F.advisory);
  expect(issued.intents.length).toBeGreaterThanOrEqual(2);
  expectRestoreStarted({ intents: [issued.intents[0], issued.intents[1]], make: (intents) => ({ ...issued.state, intents }),
    restore: (state, at) => reduceNankaiUnit(emptyState(), { kind: "restore", persisted: nankaiUnitCodec.encode(state), clock: at }),
    markOf: (state, subject) => [...state.currents, ...state.information].find((item) => item.subject === subject)?.notice });
});

// P3-RECOVERY-001 発注 4a: 取り直しで拾った引上げ（H27、P3-REC-AC10・P3-REC-D-N2-RAISE=A）と、payload の 2 欄の codec（P3-REC-AC12）。
describe("P3-REC-T15 acceptance (U-N): the recovered raise of the current status", () => {
  const recovered = (state: NankaiUnitState, name: string, now: number) =>
    receive(state, decodeXml(fixtureXml(name), name.endsWith("VYSE60") ? "VYSE60" : "VYSE50", `rec-${name}`, "recovery"), clock(now)).state;
  it("a raise over the open state is one info per channel with the pair; no raise, a noticed version or a one-sided pair gives nothing", () => {
    const now = at("2020-05-12T16:35:00+09:00"), empty = emptyState();
    const advisory = recovered(empty, F.advisory, now);
    const noticed = recoveryNotices(empty, advisory, clock(now), "verified");
    expect(noticed.intents.map((item) => [item.channel, item.payload.level, item.payload.recovered, item.payload.reportDateTime, item.transition]))
      .toEqual(["desktop", "sound"].map((channel) => [channel, "info", true, currentOf(advisory)!.source.reportDateTimeRaw, "updated"]));
    expect(roundTrip(noticed)).toMatchObject({ kind: "restored", state: { intents: noticed.intents } });
    // 同じ段（起点が巨大地震注意）と通知済みの版は鳴らさない。調査中→巨大地震警戒は引上げ。
    expect(recoveryNotices(advisory, advisory, clock(now), "verified")).toBe(advisory);
    expect(recoveryNotices(empty, noticed, clock(now), "verified")).toBe(noticed);
    const investigating = recovered(empty, F.inv1, now), warning = recovered(investigating, F.warning, now);
    // 記録の無い線から調査中へも引上げ（段 0 → 1、統合担当の決め 2026-10-28）。
    expect([status(investigating), status(warning), recoveryNotices(investigating, warning, clock(now), "verified").intents.length,
      recoveryNotices(empty, investigating, clock(now), "verified").intents.length]).toEqual(["investigating", "megaquakeWarning", 2, 2]);
    // 北海道三陸沖後発の線は InfoSerial を持たない VYSE60 でも後発地震注意の現況を作る（code でなく status で比べる）。
    const vyse60 = recovered(empty, F.vyse60, at("2024-07-18T16:35:00+09:00"));
    expect(recoveryNotices(empty, vyse60, clock(at("2024-07-18T16:35:00+09:00")), "verified").intents.map((item) => item.subject))
      .toEqual(["normal/VYSE60/current", "normal/VYSE60/current"]);
    const { recovered: _recovered, ...oneSided } = noticed.intents[0].payload;
    expect(nankaiUnitCodec.decode(JSON.parse(JSON.stringify({ ...nankaiUnitCodec.encode(noticed), intents: [{ ...noticed.intents[0], payload: oneSided }] })) as JsonValue).kind)
      .toBe("invalid");
  });
});
