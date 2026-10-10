import { describe, expect, it, vi } from "vitest";

import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { JsonValue } from "../../contracts/p2-shared-runtime.types";
import type { LandslideCurrent, LandslideIntent, LandslideUnitState, LandslideUnitStep } from "../../contracts/p3-landslide-unit.types";
import { deliveryGrowth } from "../../src/notification-delivery/delivery-growth";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { intentUpdateOwner, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { classifyHeadType, placeOfHeadType } from "../../src/runtime/unit-coverage";
import { landslideUnitCodec, reduceLandslideUnit, toLandslideView } from "../../src/units/landslide/landslide-unit";
import {
  SOYA, areas, clock, decodeFixture, decodeXml, emptyState, fixtureXml, office, receive, replaceTag, retime, send, status,
} from "./landslide-fixture";
import type { Area } from "./landslide-fixture";

const HOUR = 3_600_000;
const F = { soya: "15_16_01_241031_VPWW56", correction: "synthetic_VPWW56_correction", cancel: "synthetic_VPWW56_cancel",
  kagawa: "18_00_01_260603_VPWW56_kagawa_release" } as const;
const SUBJECT = "normal/VPWW56/稚内地方気象台";
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms + 32_400_000).toISOString().replace(".000Z", "+09:00");
const T0 = at("2020-06-22T23:00:00+09:00");
const shape = (step: LandslideUnitStep) => step.decisions.map((item) => [item.subject, item.decision,
  item.decision === "changed" ? item.change : item.decision === "unchanged" || item.decision === "rejected" ? item.reason : null]);
const levels = (step: LandslideUnitStep) => step.intents.map((item) => `${item.channel}:${item.payload.level}`);
const pending = (state: LandslideUnitState) => state.intents.filter((item) => item.disposition === "pending");
const groups = (value: LandslideCurrent | undefined) => value?.effective === "active"
  ? value.kinds.map((group) => [group.code, group.level, group.areas.length]) : value?.effective ?? null;
const recordOf = (state: LandslideUnitState, subject = SUBJECT) => state.currents.find((item) => item.subject === subject);
const roundTrip = (state: LandslideUnitState) =>
  landslideUnitCodec.decode(JSON.parse(JSON.stringify(landslideUnitCodec.encode(state))) as JsonValue);
const tick = (state: LandslideUnitState, wallTimeMs: number) => reduceLandslideUnit(state, { kind: "deadline", clock: clock(wallTimeMs) });
// 15_16_01 の 10 区域の Kind/Code（Status は区域ごとに替えられる）と、それを載せた続報。
const soya = (kinds: readonly string[], statuses: readonly string[] = []): Area[] =>
  SOYA.map((code, index) => ({ code, kind: kinds[index], status: statuses[index] ?? "発表" }));
const ORIGINAL = ["49", "09", "29", "29", "29", "29", "29", "29", "29", "29"] as const;
const follow = (state: LandslideUnitState, items: readonly Area[], time = "2020-06-22T23:30:00+09:00", extra: (xml: string) => string = (xml) => xml) =>
  send(state, F.soya, (xml) => extra(retime(time)(areas(items)(xml))));
const released = (kinds: readonly string[] = ORIGINAL) => soya(kinds, kinds.map(() => "解除"));
// 市町村等の Warning の中だけを書き換える（Head/Headline にも Kind があるため）。
const municipality = (edit: (warning: string) => string) => (xml: string) =>
  xml.replace(/<Warning type="気象警報・注意報（市町村等）">[\s\S]*?<\/Warning>/, edit);

describe("P3-UNIT-L-001 U-L reducer", () => {
  // contractBoundary: Q-ENUM の順と原子性、合法の縮退、coverage と実行場所（AC01）。
  it("P3-C10-T01 contractBoundary / AC01: first reason only, unchanged state, a legal empty cancel and the U-L route", () => {
    const base = emptyState();
    const now = clock(T0);
    const xml = fixtureXml(F.soya);
    const reject = (source: string, inputId?: string) => {
      const step = receive(base, decodeXml(source, inputId), now);
      expect(step.state).toBe(base);
      expect([step.intents, step.outcomes, step.displayChanges, step.diagnostics.length, step.decisions.length]).toEqual([[], [], [], 1, 1]);
      const result = step.decisions[0];
      return result.decision === "rejected" ? `${result.reason} ${result.subject}`.trim() : result.decision;
    };
    const editorial = (value: string) => xml.replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, value);
    const many = (count: number, kind: (index: number) => string) =>
      areas(Array.from({ length: count }, (_, index) => ({ code: String(1_000_000 + index), kind: kind(index) })))(xml);
    const cases: [string, string][] = [
      [editorial(""), "identityMissing"], [editorial("<EditorialOffice> </EditorialOffice>"), "identityMissing"],
      [editorial("<EditorialOffice>稚内地方気象台</EditorialOffice><EditorialOffice>旭川地方気象台</EditorialOffice>"), "identityInvalid"],
      [office("局".repeat(65))(xml), "identityInvalid"], [office("稚内\t気象台")(xml), "identityInvalid"],
      [replaceTag("Serial", "1a")(xml), `identityInvalid ${SUBJECT}`], [replaceTag("Serial", "12345678901")(xml), `identityInvalid ${SUBJECT}`],
      // 小数秒で 40 文字を超える ReportDateTime と、8 文字を超える InfoType の raw（保存する ReportRef の上限、Q-ENUM.identity）。
      [retime("2020-06-22T23:00:00.0000000000000000+09:00")(xml), `identityInvalid ${SUBJECT}`],
      [replaceTag("InfoType", "発表        ")(xml), `identityInvalid ${SUBJECT}`],
      [xml.replace("<Title>宗谷地方土砂災害警報・注意報</Title>", ""), `requiredStructureMissing ${SUBJECT}`],
      [replaceTag("InfoType", "不明")(xml), `requiredStructureInvalid ${SUBJECT}`],
      [xml.replace('<Warning type="気象警報・注意報（市町村等）">', '<Warning type="その他">'), `requiredStructureMissing ${SUBJECT}`],
      [municipality((warning) => warning.replace("<Code>0121400</Code>", ""))(xml), `requiredStructureMissing ${SUBJECT}`],
      [municipality((warning) => warning.replace("<Code>0121400</Code>", "<Code>01214A0</Code>"))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [municipality((warning) => warning.replace("<Code>0121400</Code>", `<Code>${"1".repeat(17)}</Code>`))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [municipality((warning) => warning.replace("<Code>0151100</Code>", "<Code>0121400</Code>"))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [municipality((warning) => warning.replace(/<Kind>[\s\S]*?<\/Kind>/, ""))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [municipality((warning) => warning.replace(/<Kind>[\s\S]*?<\/Kind>/, (kind) => kind + kind))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [municipality((warning) => warning.replace("<Status>発表</Status>", "<Status>不明</Status>"))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [municipality((warning) => warning.replace("<Code>49</Code>", "<Code>4</Code>"))(xml), `requiredStructureInvalid ${SUBJECT}`],
      [many(257, () => "29"), `requiredStructureInvalid ${SUBJECT}`],
      [many(9, (index) => String(50 + index)), `requiredStructureInvalid ${SUBJECT}`],
      // Head/InfoType は 1 個の scalar（品質レビュー P2: 子要素や重複を取消と読まない）。
      [xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消<X/></InfoType>"), `requiredStructureInvalid ${SUBJECT}`],
      [xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType><InfoType>取消</InfoType>"), `requiredStructureInvalid ${SUBJECT}`],
      // 存在が妥当性より先（Q-ENUM.priorityRule）: Kind の 2 個より区域の code の欠落。
      [municipality((warning) => warning.replace(/<Kind>[\s\S]*?<\/Kind>/, (kind) => kind + kind).replace("<Code>0151100</Code>", ""))(xml),
        `requiredStructureMissing ${SUBJECT}`],
    ];
    expect(cases.map(([source]) => reject(source))).toEqual(cases.map(([, reason]) => reason));
    // 保存する inputId の上限（64 文字）を超える入力は identityInvalid。64 単位の官署と 64 文字の inputId は合法。
    expect(reject(xml, "i".repeat(65))).toBe(`identityInvalid ${SUBJECT}`);
    expect(receive(base, decodeXml(office("局".repeat(64))(xml), "i".repeat(64)), now).decisions[0].decision).toBe("changed");
    // 合法: Body/Warning の無い取消（synthetic_VPWW56_cancel）。
    expect(shape(send(base, F.cancel))).toEqual([[SUBJECT, "changed", "revisionOnly"]]);

    expect([classifyHeadType("VPWW56"), placeOfHeadType("VPWW56")]).toEqual([{ status: "ready", unit: "U-L" }, "deferred"]);
    // 一入力は U-L だけへ届き、同じ deferred の U-F の state は同じ参照のまま。
    const owner = restoreOwner({ runId: "run", place: "deferred", clock: now, restored: { "U-F": { kind: "empty" }, "U-L": { kind: "empty" },
      "U-R": { kind: "empty" }, "U-B": { kind: "empty" } } },
      linkedUnitTable, linkedUnitCodecs).state;
    const material = decodeFixture(F.soya);
    const routed = receiveOwner(owner, { runId: "run", inputId: material.inputId, result: { kind: "decoded", material } }, now, linkedUnitTable);
    expect(routed.changedUnits).toEqual(["U-L"]);
    expect(routed.state.units["U-F"]).toBe(owner.units["U-F"]);
  });

  // acceptance: 官署の current（AC02）。続報は試験内で 15_16_01 の市町村等を書き換えて作る。
  it("P3-C10-T02 acceptance / AC02: office current from the municipality warning, replacement, release, unknown codes and operations", () => {
    const first = send(emptyState(), F.soya);
    const record = recordOf(first.state)!;
    expect(shape(first)).toEqual([[SUBJECT, "changed", "semantic"]]);
    expect(record).toMatchObject({ office: "稚内地方気象台", effective: "active", title: "宗谷地方土砂災害警報・注意報", truncated: false,
      retainUntil: T0 + 48 * HOUR });
    expect(groups(record)).toEqual([["49", 4, 1], ["09", 3, 1], ["29", 2, 8]]);
    expect(record.effective === "active" && record.kinds.flatMap((group) => group.areas)).toEqual([SOYA[0], SOYA[1], ...SOYA.slice(2)]);
    // 区域の名前は採用時の outcome の facts だけ（保存しない）。
    expect(first.outcomes[0]).toMatchObject({ kind: "accepted", subjects: [{ facts: { areaNames: { [SOYA[0]]: "稚内市", [SOYA[1]]: "猿払村" } } }] });
    expect("areaNames" in JSON.parse(JSON.stringify(landslideUnitCodec.encode(first.state))).currents[0]).toBe(false);

    // 猿払村の引下げ（semantic）、事実の同じ新しい報（revisionOnly）。新しい報は官署の事実を全部置き換える。
    const lowered = follow(first.state, soya(["49", ...Array(9).fill("29")]));
    expect([shape(lowered), groups(recordOf(lowered.state))]).toEqual([[[SUBJECT, "changed", "semantic"]], [["49", 4, 1], ["29", 2, 9]]]);
    const same = follow(first.state, soya(ORIGINAL));
    expect([shape(same), recordOf(same.state)!.source.reportDateTimeRaw]).toEqual([[[SUBJECT, "changed", "revisionOnly"]],
      "2020-06-22T23:30:00+09:00"]);
    const fewer = follow(first.state, soya(["49", "09"]).slice(0, 2));
    expect(groups(recordOf(fewer.state))).toEqual([["49", 4, 1], ["09", 3, 1]]);
    // 全区域の解除（Status を解除にし Kind/Code を残す）は ended、記録の無い官署への解除は watermark だけの ended。
    const ended = follow(first.state, released());
    expect([shape(ended), recordOf(ended.state)!.effective, toLandslideView(ended.state).currents]).toEqual([[[SUBJECT, "changed", "semantic"]],
      "ended", []]);
    expect("kinds" in recordOf(ended.state)!).toBe(false);
    const other = "normal/VPWW56/旭川地方気象台";
    const watermark = follow(first.state, released(), undefined, office("旭川地方気象台"));
    expect([shape(watermark), recordOf(watermark.state, other)?.effective, recordOf(watermark.state)]).toEqual([[[other, "changed", "revisionOnly"]],
      "ended", record]);
    expect(watermark.displayChanges).toEqual([]);
    // 表に無い 2 桁の code は level null の active（fail-bright）で、group の順は 3 の直後。
    const unknown = follow(first.state, soya(["49", "09", "59", ...Array(7).fill("29")]));
    expect(groups(recordOf(unknown.state))).toEqual([["49", 4, 1], ["09", 3, 1], ["59", null, 1], ["29", 2, 7]]);
    // 別の官署の報は稚内地方気象台の記録を変えない。訓練の報は区分を交差しない。
    const asahikawa = send(first.state, F.soya, office("旭川地方気象台"));
    expect([asahikawa.state.currents.length, recordOf(asahikawa.state)]).toEqual([2, record]);
    const training = send(first.state, F.soya, status("訓練"));
    expect([shape(training), recordOf(training.state)]).toEqual([[["training/VPWW56/稚内地方気象台", "changed", "semantic"]], record]);
    expect(recordOf(training.state, "training/VPWW56/稚内地方気象台")).toMatchObject({ operation: "training", effective: "active" });
  });

  // acceptance: 版・取消・期限（AC03）。
  it("P3-C10-T03 acceptance / AC03: revisions, office-scoped cancel, the 6 h / 48 h retention and late reports", () => {
    const first = send(emptyState(), F.soya);
    // 同じ版の重複と食い違い（先着を保ち WARN）。
    const duplicate = send(first.state, F.soya);
    expect([shape(duplicate), duplicate.state, duplicate.diagnostics]).toEqual([[[SUBJECT, "unchanged", "duplicate"]], first.state, []]);
    const conflict = send(first.state, F.soya, areas(soya(["49", ...Array(9).fill("29")])));
    expect([shape(conflict), conflict.state, conflict.diagnostics]).toEqual([[[SUBJECT, "unchanged", "stale"]], first.state,
      [{ level: "WARN", component: "landslide", reason: "landslideRevisionConflict", inputId: expect.any(String), unit: "U-L" }]]);
    // 同じ版の訂正は InfoType の優先で採用する。取消は官署だけを cancelled にし、前の事実を戻さない。
    const corrected = send(first.state, F.correction);
    expect(shape(corrected)).toEqual([[SUBJECT, "changed", "revisionOnly"]]);
    const cancelled = send(corrected.state, F.cancel);
    expect([shape(cancelled), recordOf(cancelled.state)]).toEqual([[[SUBJECT, "changed", "semantic"]], { subject: SUBJECT, operation: "normal",
      office: "稚内地方気象台", source: expect.objectContaining({ infoTypeRaw: "取消" }), retainUntil: T0 + 6 * HOUR, effective: "cancelled" }]);
    // 取消以前の版は stale で復活しない。取消より新しい発表は新しい報として採用し active に戻す（activated）。
    for (const name of [F.soya, F.correction]) expect(shape(send(cancelled.state, name))).toEqual([[SUBJECT, "unchanged", "stale"]]);
    const again = follow(cancelled.state, soya(ORIGINAL));
    expect([shape(again), recordOf(again.state)?.effective, again.intents.map((item) => item.transition)]).toEqual([
      [[SUBJECT, "changed", "semantic"]], "active", ["activated", "activated"]]);
    // 記録の無い官署への取消は記憶だけで鳴らない。
    const memory = send(emptyState(), F.cancel);
    expect([recordOf(memory.state)?.effective, memory.intents]).toEqual(["cancelled", []]);

    // 期限の来ていない deadline 入力は同じ state 参照と空の結果。
    const idle = tick(first.state, T0 + 30_000);
    expect([idle.state, idle.decisions, idle.outcomes, idle.displayChanges, idle.diagnostics]).toEqual([first.state, [], [], [], []]);
    expect(idle.state).toBe(first.state);
    // inactive は元報 +6 時間、active は +48 時間で黙って除く（通知しない）。
    const ending = follow(first.state, released(), "2020-06-22T23:00:01+09:00").state;
    const end = T0 + 1_000 + 6 * HOUR;
    expect(recordOf(tick(ending, end - 60_000).state)?.effective).toBe("ended");
    expect(tick(ending, end).state.currents).toEqual([]);
    const kept = tick(first.state, T0 + 48 * HOUR - 60_000);
    expect(recordOf(kept.state)?.effective).toBe("active");
    const expired = tick(kept.state, T0 + 48 * HOUR);
    expect([expired.state.currents, expired.intents, expired.outcomes, expired.displayChanges.map((item) => [item.subject, item.after])])
      .toEqual([[], [], [], [[SUBJECT, null]]]);
    // 取消の記憶が 6 時間で消えた後に遅れて届いた古い発表（受理の時点で ReportDateTime+6 時間 1 分）は active にならず鳴らない。
    const forgotten = tick(cancelled.state, T0 + 6 * HOUR).state;
    expect(forgotten.currents).toEqual([]);
    const late = send(forgotten, F.soya, undefined, T0 + 6 * HOUR + 60_000);
    expect([shape(late), late.state, late.intents, late.displayChanges]).toEqual([[[SUBJECT, "changed", "revisionOnly"]], forgotten, [], []]);
    expect(late.state).toBe(forgotten);
    // 到着の時点で期限を過ぎた解除の報は採用して同じ reduce で回収する（記録を消し、鳴らさない）。
    const overdue = follow(first.state, released(), "2020-06-23T00:00:00+09:00");
    const due = send(first.state, F.soya, (xml) => retime("2020-06-23T00:00:00+09:00")(areas(released())(xml)), T0 + 7 * HOUR + 60_000);
    expect(overdue.intents.length).toBe(2);
    expect([due.state.currents, due.intents, due.displayChanges.map((item) => [item.subject, item.after])]).toEqual([[], [], [[SUBJECT, null]]]);
    // 監査 F12（P3-FINAL-AC05）: 新しいが失効済みの解除で、まだ有効な旧 active を消す今の意味を保ち、保存の対象として世代を進める（+1 に限らない）。
    expect(due.state.persistence.currentGeneration).toBeGreaterThan(first.state.persistence.currentGeneration);
    // 最終の状態に記録が無いので accepted に載せず currentEstablished は null（D-VANISHED=A、P3-OPCAP-AC02）。
    expect([due.outcomes.flatMap((item) => item.subjects), due.decisions[0]]).toEqual([[],
      expect.objectContaining({ decision: "changed", change: "semantic", currentEstablished: null })]);
    // K3 の残存リスク (3)（P3-OPCAP-AC03）: 続報の pending が生きている間に届いた期限切れの新しい解除は、その pending を全部撤回する。
    const lateAt = T0 + 7 * HOUR;
    const update = send(first.state, F.soya, (xml) => retime(iso(lateAt - 6 * HOUR - 120_000))(areas(soya(["49", ...Array(9).fill("29")]))(xml)),
      lateAt - 30_000);
    expect(pending(update.state).map((item) => item.channel)).toEqual(["desktop", "sound"]);
    const withdrawn = send(update.state, F.soya, (xml) => retime(iso(lateAt - 6 * HOUR - 60_000))(areas(released())(xml)), lateAt);
    expect([withdrawn.state.currents, pending(withdrawn.state), withdrawn.intents]).toEqual([[], [], []]);
  });

  // contractBoundary: 容量と受信 1 回の費用（AC04）。境界入力は試験内で作る。
  it("P3-C10-T04 contractBoundary / AC04: 128/129 offices, eviction order, report bounds, pending and terminal budgets, no whole encode", () => {
    const now = T0 + HOUR;
    const seed = recordOf(send(emptyState(), F.soya).state)!;
    const officeOf = (index: number) => `官署${String(index).padStart(3, "0")}`;
    const officeRecord = (index: number, patch: Partial<{ operation: Operation; retainUntil: number; inactive: boolean }> = {}): LandslideCurrent => {
      const operation = patch.operation ?? "normal", name = officeOf(index), subject = `${operation}/VPWW56/${name}`;
      const reported = now - (200 - index) * 60_000;
      const source = { ...seed.source, operation, subject, reportDateTimeRaw: iso(reported) };
      return patch.inactive ? { subject, operation, office: name, source, retainUntil: patch.retainUntil ?? reported + 6 * HOUR, effective: "ended" }
        : { ...seed, subject, operation, office: name, source, retainUntil: patch.retainUntil ?? reported + 48 * HOUR };
    };
    const report = (name: string, mark = "通常") => decodeFixture(F.soya, (xml) => status(mark)(office(name)(retime(iso(now))(xml))));
    const filled = (values: readonly LandslideCurrent[]): LandslideUnitState => ({ ...emptyState(), currents: values });
    expect(receive(filled(Array.from({ length: 127 }, (_, index) => officeRecord(index))), report("N1"), clock(now)).diagnostics).toEqual([]);
    const full = Array.from({ length: 128 }, (_, index) => officeRecord(index));
    const pushed = receive(filled(full), report("N1"), clock(now));
    expect(pushed.diagnostics).toEqual([{ level: "INFO", component: "landslide", reason: "landslideCapacityEvicted", unit: "U-L", count: 1 }]);
    expect([pushed.state.currents.length, pushed.state.currents.includes(full[0])]).toEqual([128, false]);
    // 退去の順: (1) retainUntil を過ぎたもの → (2) inactive → (3) training/test → (4) normal の最古。capacityExceeded を返さない。
    let state = filled([officeRecord(0), officeRecord(1, { operation: "training" }), officeRecord(2, { inactive: true }),
      officeRecord(3, { retainUntil: now }), ...Array.from({ length: 124 }, (_, index) => officeRecord(index + 10))]);
    const evicted: string[] = [];
    for (const name of ["N2", "N3", "N4", "N5"]) {
      const before = state.currents.map((item) => item.subject);
      const step = receive(state, report(name), clock(now));
      expect(step.decisions[0].decision).toBe("changed");
      state = step.state;
      evicted.push(...before.filter((subject) => !state.currents.some((item) => item.subject === subject)));
    }
    expect(evicted).toEqual([officeRecord(3).subject, officeRecord(2).subject, officeRecord(1, { operation: "training" }).subject,
      officeRecord(0).subject]);
    // normal の active だけの満杯に training の報を受けたら、その記録自身を退去する（currents の参照と保存世代を変えない、通知しない）。
    const crowded = filled(full);
    const self = receive(crowded, report("T1", "訓練"), clock(now));
    expect([shape(self), self.intents, self.diagnostics]).toEqual([[["training/VPWW56/T1", "changed", "revisionOnly"]], [],
      [{ level: "INFO", component: "landslide", reason: "landslideCapacityEvicted", unit: "U-L", count: 1 }]]);
    // 自身の退去の結果は最終の状態の時制（P3-OPCAP-AC02）。
    expect([self.decisions[0], self.outcomes]).toEqual([expect.objectContaining({ currentEstablished: null }),
      [{ kind: "accepted", change: "revisionOnly", subjects: [] }]]);
    // 監査 F04-L（P3-OPCAP-AC01）: normal の ended の記録は training の受理で退去しない。training があればそれを退去する。
    const ended = officeRecord(900, { inactive: true }), drill = officeRecord(901, { operation: "training" });
    const withMemory = [ended, ...full.slice(1)];
    expect(receive(filled(withMemory), report("T3", "訓練"), clock(now)).state.currents).toBe(withMemory);
    const trainingIn = receive(filled([ended, drill, ...full.slice(2)]), report("T4", "訓練"), clock(now)).state.currents;
    expect([trainingIn.includes(ended), trainingIn.includes(drill), trainingIn.length]).toEqual([true, false, 128]);
    expect([self.state.currents, self.state.persistence]).toEqual([crowded.currents, crowded.persistence]);
    expect(self.state.currents).toBe(crowded.currents);
    // 退去を伴う受理は、記録の無い官署への解除（revisionOnly の形）でも decision と outcome が semantic。
    const release = receive(crowded, decodeFixture(F.soya, (xml) => office("N6")(retime(iso(now))(areas(released())(xml)))), clock(now));
    expect([shape(release), release.outcomes.map((item) => item.kind === "accepted" && item.change)]).toEqual([
      [["normal/VPWW56/N6", "changed", "semantic"]], ["semantic"]]);
    // 実不具合（品質レビュー P2）: current を残さない取消（自身の退去）も、その subject の pending を置き換える。
    const mixed = receive(filled(full.slice(0, 127)), report("T2", "訓練"), clock(now)).state;
    const evictedTraining = receive(mixed, report("N7"), clock(now)).state;
    expect([evictedTraining.currents.some((item) => item.operation === "training"), pending(evictedTraining).map((item) => item.subject)])
      .toEqual([false, expect.arrayContaining(["training/VPWW56/T2"])]);
    const withdrawn = receive(evictedTraining, decodeFixture(F.cancel, (xml) => status("訓練")(office("T2")(retime(iso(now))(xml)))), clock(now));
    expect(withdrawn.state.currents).toBe(evictedTraining.currents);
    expect(withdrawn.state.intents.filter((item) => item.subject === "training/VPWW56/T2").map((item) => item.disposition)).toEqual(["superseded"]);
    expect(withdrawn.state.persistence.currentGeneration).toBe(evictedTraining.persistence.currentGeneration + 1);

    // 一報の Item 256・Kind/Code の種類 8 は受ける（257・9 は T01）。title 128/129 文字と Kind の名前 32/33 文字の切り詰め。
    const wide = areas(Array.from({ length: 256 }, (_, index) => ({ code: String(1_000_000 + index), kind: String(50 + index % 8),
      name: index === 0 ? "名".repeat(33) : "名".repeat(32) })));
    const widest = recordOf(send(emptyState(), F.soya, wide).state);
    expect(groups(widest)).toEqual(Array.from({ length: 8 }, (_, index) => [String(50 + index), null, 32]));
    expect(widest).toMatchObject({ title: "宗谷地方土砂災害警報・注意報", truncated: true });
    expect(widest?.effective === "active" && widest.kinds[0].name).toBe("名".repeat(32));
    const titled = (length: number) => recordOf(send(emptyState(), F.soya, (xml) => xml.replace("<Title>宗谷地方土砂災害警報・注意報</Title>",
      `<Title>${"題".repeat(length)}</Title>`)).state);
    expect([titled(129), titled(128)]).toMatchObject([{ title: "題".repeat(128), truncated: true }, { title: "題".repeat(128), truncated: false }]);

    // pending 128/129 件と 131,072/131,073 byte（予約は delivery-growth.ts の deliveryGrowth、式を写さない）。
    const template = send(emptyState(), F.soya).intents[0];
    const seeded = (count: number, pad = 0): LandslideIntent[] => Array.from({ length: count }, (_, index) => ({ ...template, id: `seed-${index}`,
      subject: `normal/VPWW56/S${index}`, source: { ...template.source, subject: `normal/VPWW56/S${index}` },
      payload: { ...template.payload, body: index === 0 ? "x".repeat(1 + pad) : "x" }, createdAt: T0 - 1000, expiresAt: T0 + 179_000 }));
    const fits = send({ ...emptyState(), intents: seeded(126) }, F.soya);
    expect([fits.intents.length, pending(fits.state).length, fits.diagnostics]).toEqual([2, 128, []]);
    const over = send({ ...emptyState(), intents: seeded(127) }, F.soya);
    expect([over.intents.map((item) => item.channel), over.diagnostics]).toMatchObject([["sound"], [{ reason: "notificationCapacityEvicted", count: 1 }]]);
    const bytesOf = (values: readonly LandslideIntent[]) => Buffer.byteLength(JSON.stringify(values));
    const fresh = send(emptyState(), F.soya).intents;
    const pad = 131_072 - bytesOf([...seeded(10), ...fresh]) - [...seeded(10), ...fresh].reduce((sum, item) => sum + deliveryGrowth(item), 0);
    expect(pending(send({ ...emptyState(), intents: seeded(10, pad) }, F.soya).state)).toHaveLength(12);
    expect(send({ ...emptyState(), intents: seeded(10, pad + 1) }, F.soya).intents.map((item) => item.channel)).toEqual(["sound"]);
    // 新しい intent が容量で外れただけなら intent の配列を変えない（C9 の Q-C9-IMPL-AMEND(9)(e)）。
    const busy: LandslideUnitState = { ...emptyState(), intents: seeded(128) };
    const dropped = send(busy, F.soya, status("訓練"));
    expect([dropped.intents, dropped.diagnostics]).toEqual([[], [{ level: "INFO", component: "landslide", reason: "notificationCapacityEvicted",
      unit: "U-L", count: 1 }]]);
    expect(dropped.state.intents).toBe(busy.intents);
    // 配送の更新で attempts が 1 桁から 5 桁・nextAttemptAt の桁が増えても、予約の内側で decode が受ける。
    const budget = send({ ...emptyState(), intents: seeded(10, pad) }, F.soya).state;
    const grown = reduceLandslideUnit(budget, { kind: "intentUpdate", clock: clock(T0), intentUpdate: pending(budget).map((item) => ({ id: item.id,
      attempts: 12_345, nextAttemptAt: T0 + 0.123456, disposition: "pending" as const })) });
    expect(roundTrip(grown.state).kind).toBe("restored");

    // I-U-L.capacityMeasurement の同時最大状態（実例の最大）と、上限の文字列での上界。どちらも encode でき 2,097,152 byte 以下で decode が受ける。
    const real = budgetState(false), bound = budgetState(true);
    const sizes = [real, bound].map((item) => Buffer.byteLength(JSON.stringify(landslideUnitCodec.encode(item))));
    const one = (value: object) => Buffer.byteLength(JSON.stringify(value));
    console.info("P3-C10 capacity", JSON.stringify({ realPayload: sizes[0], contractReal: 293_040, boundPayload: sizes[1], contractBound: 1_327_328,
      realActive: one(seed), contractActive: 815, realEnded: one(recordOf(follow(emptyState(), released()).state)!), contractEnded: 402,
      realIntent: one(template), contractIntent: 882, boundRecord: one(bound.currents[0]), contractBoundRecord: 8_566,
      counts: [real.currents.length, real.currents.reduce((sum, item) => sum + (item.effective === "active" ? item.kinds.reduce((total, group) =>
        total + group.areas.length, 0) : 0), 0), real.intents.length, bound.intents.length] }));
    for (const item of [real, bound]) expect(roundTrip(item).kind).toBe("restored");
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2_097_152);

    // 保持上限付近で、受信 1 回は記録単位の加算だけ（state・配列・既存の記録を直列化しない）。
    const near = { ...real };
    receive(near, report("N9"), clock(now));
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      receive(near, report("N9"), clock(now));
      const whole = new Set<unknown>([near, near.currents, near.intents, ...near.currents, ...near.intents]);
      expect(stringify.mock.calls.filter(([value]) => whole.has(value))).toEqual([]);
    } finally { stringify.mockRestore(); }
  });

  // contractBoundary: I-U-L.persisted・I-U-L.decode、復元で intent を作らない（AC05）。
  it("P3-C10-T05 contractBoundary / AC05: one codec, persisted fields only, every decode check and restore without new intents", () => {
    let state = send(emptyState(), F.soya).state;
    state = send(state, F.kagawa, undefined, T0 + 1_000).state;
    state = send(state, F.cancel, office("旭川地方気象台"), T0 + 2_000).state;
    const payload = JSON.parse(JSON.stringify(landslideUnitCodec.encode(state))) as JsonValue;
    expect(Object.keys(payload as object).sort()).toEqual(["currents", "intents", "schemaVersion"]);
    expect(landslideUnitCodec.decode(payload)).toEqual({ kind: "restored", state: { ...state, contentRevision: 0,
      persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } } });
    type Row = Record<string, unknown>;
    const value = payload as { currents: Row[]; intents: Row[] };
    const [active] = value.currents, [intent] = value.intents;
    const ended = value.currents.find((item) => item.effective === "ended")!;
    const source = active.source as Row;
    const kinds = active.kinds as Row[];
    const withActive = (patch: Row) => ({ ...value, currents: [{ ...active, ...patch }] });
    const group = (code: string, count: number, level: number | null = null) => ({ code, name: "x", level,
      areas: Array.from({ length: count }, (_, index) => String(1_000_000 + index)) });
    const many = <T>(length: number, make: (index: number) => T): T[] => Array.from({ length }, (_, index) => make(index));
    const invalid: [string, unknown][] = [
      ["schemaVersion", { ...value, schemaVersion: "p3-landslide-unit-v0" }],
      ["currents > 128", { ...value, currents: many(129, (index) => ({ ...active, office: `O${index}`, subject: `normal/VPWW56/O${index}`,
        source: { ...source, subject: `normal/VPWW56/O${index}` } })) }],
      ["duplicate subject", { ...value, currents: [active, active] }],
      ["subject and office", withActive({ office: "旭川地方気象台" })],
      ["subject and operation", withActive({ subject: "training/VPWW56/稚内地方気象台" })],
      ["office control character", withActive({ office: "稚内\t", subject: "normal/VPWW56/稚内\t", source: { ...source, subject: "normal/VPWW56/稚内\t" } })],
      ["office over 64", withActive({ office: "局".repeat(65), subject: `normal/VPWW56/${"局".repeat(65)}`,
        source: { ...source, subject: `normal/VPWW56/${"局".repeat(65)}` } })],
      ["inputId over 64", withActive({ source: { ...source, inputId: "i".repeat(65) } })],
      ["ReportDateTime over 40", withActive({ source: { ...source, reportDateTimeRaw: "2020-06-22T23:00:00.0000000000000000+09:00" } })],
      ["Serial over 10 digits", withActive({ source: { ...source, serialRaw: "12345678901" } })],
      ["InfoType", withActive({ source: { ...source, infoTypeRaw: "不明" } })],
      ["source family", withActive({ source: { ...source, family: "VPWW55" } })],
      ["source subject", withActive({ source: { ...source, subject: "normal/VPWW56/旭川地方気象台" } })],
      ["ended keeps facts", { ...value, currents: [{ ...ended, title: "x" }] }],
      ["ended retainUntil", { ...value, currents: [{ ...ended, retainUntil: Number(ended.retainUntil) + 42 * 3_600_000 }] }],
      ["active retainUntil", withActive({ retainUntil: Number(active.retainUntil) + 1 })],
      ["level and code", withActive({ kinds: [{ ...kinds[0], level: 3 }, ...kinds.slice(1)] })],
      ["group order", withActive({ kinds: [...kinds].reverse() })],
      ["duplicate group code", withActive({ kinds: [kinds[0], kinds[0]] })],
      ["inactive code group", withActive({ kinds: [group("00", 1)] })],
      ["no group", withActive({ kinds: [] })],
      ["empty group", withActive({ kinds: [group("59", 0)] })],
      ["groups over 8", withActive({ kinds: many(9, (index) => group(String(50 + index), 1)) })],
      ["areas over 256", withActive({ kinds: [group("59", 257)] })],
      ["area code over 16 bytes", withActive({ kinds: [{ ...group("59", 1), areas: ["1".repeat(17)] }] })],
      ["area code not digits", withActive({ kinds: [{ ...group("59", 1), areas: ["01214A0"] }] })],
      ["title over 128", withActive({ title: "x".repeat(129) })],
      ["kind name over 32", withActive({ kinds: [{ ...kinds[0], name: "x".repeat(33) }, ...kinds.slice(1)] })],
      ["pending > 128", { ...value, intents: many(129, (index) => ({ ...intent, id: `pending-${index}`, disposition: "pending" })) }],
      ["pending + delivery reserve > 131072 bytes", { ...value, intents: reserveOver(intent) }],
      ["attempts negative", { ...value, intents: [{ ...intent, attempts: -1 }] }],
      ["nextAttemptAt not finite", { ...value, intents: [{ ...intent, nextAttemptAt: null }] }],
      ["pending + terminal > 229,376 bytes", { ...value, intents: terminalOver(intent) }],
      ["intent of another unit", { ...value, intents: [{ ...intent, unit: "U-N" }] }],
      ["intent domain", { ...value, intents: [{ ...intent, payload: { ...(intent.payload as Row), domain: "volcano" } }] }],
      ["intent subject form", { ...value, intents: [{ ...intent, subject: "normal/VYSE50/1", source: { ...(intent.source as Row), subject: "normal/VYSE50/1" } }] }],
    ];
    for (const [name, candidate] of invalid) expect(landslideUnitCodec.decode(candidate as JsonValue).kind, name).toBe("invalid");
    // 回収された記録の intent は期限まで残るので、state に残る subject との一致は求めない。
    expect(landslideUnitCodec.decode({ ...value, currents: [] } as JsonValue).kind).toBe("restored");
    // 受理が通す上限ちょうど（Item 256・Kind/Code 8 種類・title 128 文字・Kind の名前 32 文字）の記録は decode も通す。
    const widest = send(emptyState(), F.soya, (xml) => areas(Array.from({ length: 256 }, (_, index) => ({ code: String(10 ** 15 + index),
      kind: String(50 + index % 8), name: "名".repeat(33) })))(xml).replace("<Title>宗谷地方土砂災害警報・注意報</Title>", `<Title>${"題".repeat(129)}</Title>`));
    expect(roundTrip(widest.state).kind).toBe("restored");

    // 復元で intent を作らず、pending の期限を延ばさない。
    const restoredAt = T0 + 61_000;
    const restored = reduceLandslideUnit(emptyState(), { kind: "restore", persisted: landslideUnitCodec.encode(state), clock: clock(restoredAt) });
    expect(restored.intents).toEqual([]);
    expect(restored.state.intents).toEqual(state.intents.filter((item) => item.expiresAt > restoredAt));
    expect(restored.state.intents.length).toBeGreaterThan(0);
    expect(restored.state.currents).toEqual(state.currents);
    expect(restored.outcomes).toMatchObject([{ kind: "recoveryApplied", scope: ["U-L"], coverage: [SUBJECT] }]);
  });

  // acceptance: Q-NOTICE の土砂分（AC07）。
  it("P3-C10-T06 acceptance / AC07: opportunities, the NOTICE-LEVELS=B table, replacement, title/body, intentUpdate, training and restart", () => {
    const first = send(emptyState(), F.soya);
    expect([levels(first), first.intents.map((item) => item.transition)]).toEqual([["desktop:warning", "sound:warning"], ["activated", "activated"]]);
    expect([first.intents[0].payload.title, first.intents[0].payload.body]).toEqual(["宗谷地方土砂災害警報・注意報",
      "レベル４土砂災害危険警報 1地域 / レベル３土砂災害警報 1地域 / レベル２土砂災害注意報 8地域 / 宗谷地方にレベル４土砂災害危険警報を発表しています。土砂災害に厳重に警戒をしてください。"]);
    expect(first.intents.map((item) => [item.payload.domain, item.expiresAt - item.createdAt])).toEqual([["weather", 180_000], ["weather", 60_000]]);
    // 上がった区域の最大: レベル5 critical・4 と 3 warning・2 normal・表に無い code warning。上がった区域の無い報（引下げ）は normal。
    const raised = (kinds: readonly string[]) => levels(follow(first.state, soya(kinds)))[0];
    expect([raised(["49", "09", "39", ...Array(7).fill("29")]), raised(["49", "09", "49", ...Array(7).fill("29")]),
      raised(["49", "09", "09", ...Array(7).fill("29")]), raised(["49", "09", "59", ...Array(7).fill("29")]),
      raised(["49", "29", ...Array(8).fill("29")]), raised(["49", "59", ...Array(8).fill("29")])]).toEqual(["desktop:critical", "desktop:warning",
      "desktop:warning", "desktop:warning", "desktop:normal", "desktop:normal"]);
    // 新しい区域だけの報（レベル2 の区域が増える）は normal、同じ事実の新しい報（revisionOnly）・重複では作らない。
    const smaller = follow(first.state, soya(ORIGINAL).slice(0, 9)).state;
    expect(levels(follow(smaller, soya(ORIGINAL), "2020-06-22T23:40:00+09:00"))).toEqual(["desktop:normal", "sound:normal"]);
    expect([follow(first.state, soya(ORIGINAL)).intents, send(first.state, F.soya).intents]).toEqual([[], []]);
    // 全解除は released・normal で、本文は Headline。記録の無い官署・取消の記録への解除の報（inactiveAdoption）も作る。ended への解除では作らない。
    const ended = follow(first.state, released());
    expect([levels(ended), ended.intents[0].transition, ended.intents[0].payload.body]).toEqual([["desktop:normal", "sound:normal"], "released",
      "宗谷地方にレベル４土砂災害危険警報を発表しています。土砂災害に厳重に警戒をしてください。"]);
    const kagawa = send(emptyState(), F.kagawa);
    expect([levels(kagawa), kagawa.intents[0].transition, kagawa.intents[0].payload.body]).toEqual([["desktop:normal", "sound:normal"], "released",
      "注意報を解除します。"]);
    expect(levels(follow(send(emptyState(), F.cancel).state, released()))).toEqual(["desktop:normal", "sound:normal"]);
    expect(follow(ended.state, released(), "2020-06-22T23:50:00+09:00").intents).toEqual([]);
    // 訂正は事実が同じでも作る（normal、[訂正]・「訂正: 」）。記憶だけの取消では作らない。取消は cancel。
    const corrected = send(first.state, F.correction);
    expect(corrected.intents.map((item) => [item.transition, item.payload.level, item.payload.title, item.payload.body.startsWith("訂正: ")]))
      .toEqual([["updated", "normal", "[訂正] 宗谷地方土砂災害警報・注意報", true], ["updated", "normal", "[訂正] 宗谷地方土砂災害警報・注意報", true]]);
    expect(send(emptyState(), F.cancel).intents).toEqual([]);
    const cancel = send(first.state, F.cancel);
    expect(cancel.intents.map((item) => [item.transition, item.payload.level, item.payload.title, item.payload.body])).toEqual([
      ["cancelled", "cancel", "[取消] 宗谷地方土砂災害警報・注意報", "この情報は取り消されました"],
      ["cancelled", "cancel", "[取消] 宗谷地方土砂災害警報・注意報", "この情報は取り消されました"]]);
    // 置換（P3-C10-REPLACEMENT=A）: 同じ subject・channel の新しい intent は古い pending を、取消は対象 subject の全 pending を置き換える。
    const replaced = follow(first.state, soya(["49", ...Array(9).fill("29")]), "2020-06-22T23:00:30+09:00").state;
    expect(replaced.intents.map((item) => item.disposition)).toEqual(["superseded", "superseded", "pending", "pending"]);
    expect(pending(send(replaced, F.cancel, retime("2020-06-22T23:00:40+09:00")).state).map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
    expect(send(first.state, F.soya, office("旭川地方気象台")).state.intents.slice(0, 2)).toEqual(first.state.intents);
    // intentUpdate: 既存 id だけを一括で更新し、保存世代を 1 つ進める。未知 id・同値は no-op。
    const [desktop] = first.intents;
    const updated = reduceLandslideUnit(first.state, { kind: "intentUpdate", clock: clock(desktop.createdAt), intentUpdate: [{ id: desktop.id,
      attempts: 1, nextAttemptAt: desktop.createdAt + 1_000, disposition: "pending" }, { id: "unknown", attempts: 1, nextAttemptAt: 0,
      disposition: "delivered" }] });
    expect([updated.state.persistence.currentGeneration, updated.decisions]).toMatchObject([first.state.persistence.currentGeneration + 1,
      [{ decision: "changed", change: "deliveryOnly" }]]);
    expect(reduceLandslideUnit(updated.state, { kind: "intentUpdate", clock: clock(desktop.createdAt), intentUpdate: { id: desktop.id, attempts: 1,
      nextAttemptAt: desktop.createdAt + 1_000, disposition: "pending" } }).state).toBe(updated.state);
    // 復元直後の続報は復元した記録との差で決める（同じ報は duplicate で鳴らさない、引下げは normal）。訓練は desktop だけ。
    const restored = reduceLandslideUnit(emptyState(), { kind: "restore", persisted: landslideUnitCodec.encode(first.state),
      clock: clock(desktop.createdAt + 1) }).state;
    expect(send(restored, F.soya).intents).toEqual([]);
    expect(levels(follow(restored, soya(["49", ...Array(9).fill("29")])))).toEqual(["desktop:normal", "sound:normal"]);
    expect(send(emptyState(), F.soya, status("訓練")).intents.map((item) => [item.channel, item.payload.level, item.payload.title])).toEqual([
      ["desktop", "warning", "【訓練】宗谷地方土砂災害警報・注意報"]]);
  });

  // contractBoundary: E22 の U-L は対象外（P3-C10-N2、AC13）。
  it("P3-C10-T10 contractBoundary / AC13: origin=recovery is not applied", () => {
    const state = send(emptyState(), F.soya).state;
    const recovery = receive(state, decodeXml(retime("2020-06-22T23:30:00+09:00")(fixtureXml(F.soya)), "recovered", "recovery"),
      clock(T0 + 30 * 60_000));
    expect(recovery.state).toBe(state);
    expect(recovery.decisions).toEqual([{ subject: SUBJECT, operation: "normal", decision: "unchanged", reason: "noChange" }]);
    expect([recovery.intents, recovery.outcomes, recovery.confirmationEvidence, recovery.displayChanges]).toEqual([[], [], [], []]);
  });

  // 実不具合の再発防止の型（C8 の Q-C8-IMPL-AMEND(1)(2) を U-L で）: owner を通した更新・保存・復元。
  it("P3-C10-T04 contractBoundary / AC04: an owner terminal update at the terminal budget and pending at its budget survive save and restore", () => {
    const template = send(emptyState(), F.soya).intents[0];
    const terminalBytes = (values: readonly LandslideIntent[]) => values.filter((item) => item.disposition !== "pending")
      .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + 1, 0);
    const old: LandslideIntent = { ...template, id: "old-pending", createdAt: T0 - 100_000, expiresAt: T0 + 80_000 };
    const done = (index: number): LandslideIntent => ({ ...template, id: `done-${index}`, createdAt: T0 + index, disposition: "delivered" });
    let count = 0;
    while (terminalBytes(Array.from({ length: count + 1 }, (_, index) => done(index))) <= 98_304) count++;
    const now = clock(T0 + 1_000);
    const empty = restoreOwner({ runId: "run", place: "deferred", clock: now, restored: { "U-F": { kind: "empty" }, "U-L": { kind: "empty" },
      "U-R": { kind: "empty" }, "U-B": { kind: "empty" } } },
      linkedUnitTable, linkedUnitCodecs).state;
    const owner = { ...empty, units: { ...empty.units, "U-L": { ...emptyState(), intents: [old, ...Array.from({ length: count }, (_, index) => done(index))] } } };
    const updated = intentUpdateOwner(owner, "U-L", [{ id: old.id, attempts: 1, nextAttemptAt: now.wallTimeMs, disposition: "delivered" }], now,
      linkedUnitTable);
    expect(updated.adopted).toBe(true);
    expect(updated.state.units["U-L"]!.intents.find((item) => item.id === old.id)?.disposition).toBe("delivered");
    // 終端記録の合計が 98,304 byte を超える分は最古（done-0）から期限前に回収し、更新で終端にした記録は回収しない。
    expect(updated.state.units["U-L"]!.intents.some((item) => item.id === "done-0")).toBe(false);
    expect(roundTrip(updated.state.units["U-L"]!).kind).toBe("restored");
    // 予算いっぱいに受理した pending が、最長の配送の更新（attempts 16 桁・nextAttemptAt 25 文字）の後も保存・復元できる。
    let full = emptyState();
    for (let index = 0; index < 200; index++)
      full = send(full, F.soya, (xml) => office(`官署${index}`)(xml).replace(/<Headline>\s*<Text>[\s\S]*?<\/Text>/,
        `<Headline><Text>${"土".repeat(250)}</Text>`), T0 + index).state;
    expect(pending(full).length).toBeLessThan(128);
    const first = roundTrip(full);
    if (first.kind !== "restored") throw new Error("the admitted state does not decode");
    const grown = intentUpdateOwner({ ...empty, units: { ...empty.units, "U-L": first.state } }, "U-L", pending(first.state).map((item, index) => ({
      id: item.id, attempts: Number.MAX_SAFE_INTEGER, nextAttemptAt: -0.0000018927186924017318,
      disposition: index % 3 === 0 ? "superseded" as const : "pending" as const })), now, linkedUnitTable);
    expect(grown.adopted).toBe(true);
    expect(roundTrip(grown.state.units["U-L"]!).kind).toBe("restored");
  });

  // 版の比較（P3-REVISION-ORDER-001）: 15_16_01 を t−60 秒の初報にし、同じ時刻 t（=T0）の Serial と InfoType だけを替えた報を当てる。
  const ordered = () => send(emptyState(), F.soya, (xml) => replaceTag("TargetDateTime", iso(T0 - 60_000))(retime(iso(T0 - 60_000))(xml))).state;
  const version = ([serial, infoType]: readonly [string, string]) =>
    decodeFixture(F.soya, (xml) => replaceTag("InfoType", infoType)(replaceTag("Serial", serial)(xml)));
  const verdict = (step: LandslideUnitStep) => step.decisions.map((item) => item.decision === "unchanged" ? item.reason : item.decision);

  // regression（監査 F02）: 同時刻の Serial 2 の発表・Serial 空の訂正・Serial 1 の取消は、6 順列とも、各手順の前に復元を挟んでも取消で終わる。
  it("P3-ORDER-T01 regression / AC02: the F02 triple ends in the Serial 1 cancel in all 6 orders, with and without a restore before each step", () => {
    const first = ordered();
    const reports = { A: version(["2", "発表"]), B: version(["", "訂正"]), C: version(["1", "取消"]) };
    // owner の復元と同じく、保存物（encode→JSON）を保存世代を引き継いだ state へ restore で戻す。
    const restart = (state: LandslideUnitState) => {
      const decoded = roundTrip(state);
      if (decoded.kind !== "restored") throw new Error("the saved state does not decode");
      const generation = state.persistence.currentGeneration;
      return reduceLandslideUnit({ ...emptyState(), persistence: { kind: "saved", currentGeneration: generation, savedGeneration: generation,
        savedCapturedAt: null, savedAckAt: null, dirtySince: null } }, { kind: "restore", persisted: landslideUnitCodec.encode(decoded.state),
        clock: clock(T0) }).state;
    };
    const finals = [false, true].flatMap((restarting) => ["ABC", "ACB", "BAC", "BCA", "CAB", "CBA"].map((order) => [...order].reduce(
      (state, key) => receive(restarting ? restart(state) : state, reports[key as keyof typeof reports], clock(T0)).state, first)));
    expect(finals.map((state) => [recordOf(state)?.effective, recordOf(state)?.source.serialRaw, recordOf(state)?.source.infoTypeRaw,
      pending(state).map((item) => [item.channel, item.transition]), roundTrip(state).kind]))
      .toEqual(Array(12).fill(["cancelled", "1", "取消", [["desktop", "cancelled"], ["sound", "cancelled"]], "restored"]));
  });

  // contractBoundary: 同時刻の 2 報は InfoType の優先 → Serial（欠落はどの数値よりも小、数として）で決まり、到着順によらない（AC01・AC03(a)〜(c)）。
  it("P3-ORDER-T02 contractBoundary / AC01,AC03: InfoType before Serial, a missing Serial below any number and \"01\" = \"1\", in both orders", () => {
    const first = ordered();
    // [一方, 他方, 勝つ方（null は同じ版）]
    const rows: [readonly [string, string], readonly [string, string], 0 | 1 | null][] = [
      [["9", "発表"], ["1", "訂正"], 1], [["", "訂正"], ["1", "取消"], 1], [["2", "発表"], ["1", "発表"], 0], [["", "発表"], ["1", "発表"], 1],
      [["01", "発表"], ["1", "発表"], null]];
    for (const [one, other, winner] of rows) for (const [early, late, lateWins] of [[one, other, winner === 1], [other, one, winner === 0]] as const) {
      const step = receive(receive(first, version(early), clock(T0)).state, version(late), clock(T0));
      expect([verdict(step), step.diagnostics, [recordOf(step.state)?.source.serialRaw, recordOf(step.state)?.source.infoTypeRaw]], `${early}→${late}`)
        .toEqual([[winner == null ? "duplicate" : lateWins ? "changed" : "stale"], [], lateWins ? late : early]);
    }
  });
});

// I-U-L.capacityMeasurement の同時最大状態: 実例は全国の市町村等 1,772 区域を 64 官署に 15_16_01 の形（3 group）で配り、
// 上界（I-U-L.capacityReserve）は 128 官署を上限の長さの記録で満たす。どちらも pending と終端記録を byte の上限まで詰める。
function budgetState(bounded: boolean): LandslideUnitState {
  const seed = recordOf(send(emptyState(), F.soya).state)!;
  if (seed.effective !== "active") throw new Error("inactive seed");
  const wide = (length: number) => "\u0001".repeat(length);
  const digits = (index: number) => String(index).padStart(4, "0").replace(/\d/g, (digit) => "〇一二三四五六七八九"[Number(digit)]);
  const count = bounded ? 128 : 64;
  let code = 0;
  const currents = Array.from({ length: count }, (_, index): LandslideCurrent => {
    const operation: Operation = bounded ? "training" : "normal";
    const name = bounded ? `${"局".repeat(60)}${digits(index)}` : `官署${String(index).padStart(2, "0")}地方気象台`;
    const subject = `${operation}/VPWW56/${name}`;
    const reportDateTimeRaw = bounded ? "-271821-04-20T00:00:00.0000000000000000Z" : seed.source.reportDateTimeRaw;
    const source = { inputId: "i".repeat(bounded ? 64 : 36), origin: "live" as const, operation, family: "VPWW56", subject, reportDateTimeRaw,
      serialRaw: bounded ? "1234567890" : "", infoTypeRaw: bounded ? "訂正" : "発表" };
    const area = () => bounded ? String(10 ** 15 + code++) : String(1_000_000 + code++);
    // 実例: 1,772 = 44 官署×28 区域 + 20 官署×27 区域、49×1・09×1・29×残り。上界: level null の 8 group に 32 区域ずつ。
    const kinds = bounded ? Array.from({ length: 8 }, (_, group) => ({ code: String(50 + group), name: wide(32), level: null,
      areas: Array.from({ length: 32 }, area) }))
      : seed.kinds.map((group, at) => ({ ...group, areas: Array.from({ length: at < 2 ? 1 : (index < 44 ? 28 : 27) - 2 }, area) }));
    return { ...seed, subject, operation, office: name, source, retainUntil: Date.parse(reportDateTimeRaw) + 48 * HOUR,
      title: bounded ? wide(128) : seed.title, kinds };
  });
  const intentBase = send(emptyState(), F.soya).intents[0];
  const sized = (index: number, disposition: LandslideIntent["disposition"]): LandslideIntent => ({ ...intentBase, id: `${intentBase.id}:${index}`,
    disposition, createdAt: T0, expiresAt: T0 + 180_000 });
  const bytes = (item: LandslideIntent) => Buffer.byteLength(JSON.stringify(item));
  const pendingIntents: LandslideIntent[] = [];
  let size = 2;
  for (let index = 0; pendingIntents.length < 128; index++) {
    const item = sized(index, "pending"), width = bytes(item) + (pendingIntents.length === 0 ? 0 : 1) + deliveryGrowth(item);
    if (size + width > 131_072) break;
    pendingIntents.push(item);
    size += width;
  }
  // 終端記録は配送の更新で終端にした記録を含めて「pending の実 byte＋予約＋終端記録」229,376 byte まで。
  const terminal: LandslideIntent[] = [];
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
