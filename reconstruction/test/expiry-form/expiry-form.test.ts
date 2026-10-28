import { describe, expect, it } from "vitest";

import type { JsonValue, NotificationIntent, NotificationIntentUpdate, WallBasis } from "../../contracts/p2-shared-runtime.types";
import type { BriefingUnitState } from "../../contracts/p3-briefing-unit.types";
import type { LocalBulletinsUnitState } from "../../contracts/p3-local-bulletins-unit.types";
import { briefingUnitCodec, reduceBriefingUnit } from "../../src/units/briefing/briefing-unit";
import { floodUnitCodec, reduceFloodUnit } from "../../src/units/flood/flood-unit";
import { landslideUnitCodec, reduceLandslideUnit } from "../../src/units/landslide/landslide-unit";
import { localBulletinsUnitCodec, reduceLocalBulletinsUnit, toLocalBulletinsView } from "../../src/units/local-bulletins/local-bulletins-unit";
import { reduceTsunamiUnit, toTsunamiView, tsunamiUnitCodec } from "../../src/units/tsunami/tsunami-unit";
import { reduceWeatherTimeseriesUnit, weatherTimeseriesUnitCodec } from "../../src/units/weather-timeseries/weather-timeseries-unit";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { eewUnitCodec, reduceEewUnit } from "../../src/units/eew/eew-unit";
import { nankaiUnitCodec, reduceNankaiUnit } from "../../src/units/nankai/nankai-unit";
import { reduceSeismicUnit, seismicUnitCodec } from "../../src/units/seismic/seismic-unit";
import { reduceTyphoonUnit, typhoonUnitCodec } from "../../src/units/typhoon/typhoon-unit";
import { reduceVolcanoUnit, volcanoUnitCodec } from "../../src/units/volcano/volcano-unit";
import { reduceWeatherCurrentUnit, weatherCurrentUnitCodec } from "../../src/units/weather-current/weather-current-unit";
import { ingestXmlData } from "../../src/ingress/ingress";
import * as B from "../briefing-unit/briefing-fixture";
import * as L from "../landslide-unit/landslide-fixture";
import * as M from "../local-bulletins-unit/local-bulletins-fixture";
import * as R from "../flood-unit/flood-fixture";
import * as T from "../tsunami-unit/tsunami-fixture";

// P3-EXPIRY-FORM-001（K10）の unit の試験（T03〜T07・T10）。報は corpus の fixture を試験の中で書き換えて作る（新しい fixture file を足さない）。

const HOUR = 3_600_000;
const at = (raw: string) => Date.parse(raw);
const clock = (wallTimeMs: number) => ({ wallTimeMs, monotonicMs: 0 });
// 配送済みの更新（系列の印の証拠を possible に上げる、P3-NL-AC02 (3)）。
const delivered = (intents: readonly NotificationIntent[]): NotificationIntentUpdate[] => intents.map((item) => ({ id: item.id,
  attempts: item.attempts + 1, nextAttemptAt: item.nextAttemptAt, disposition: "delivered", lastAttempt: item.lastAttempt, replayed: item.replayed,
  expiresAt: item.expiresAt, lossReason: null }));
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue;
function decodeWith(headType: string, xml: string, inputId: string) {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: 0, origin: "replay", kind: "replay", headType, body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}

const L0 = at("2020-06-22T23:00:00+09:00"), L_SUBJECT = "normal/VPWW56/稚内地方気象台";
const R0 = at("2019-05-27T09:00:00+09:00"), R_SUBJECT = "normal/VXKO50/123456789012";
const B0 = at("2026-08-22T17:09:00+09:00");
const K1 = "phase6b_VPBS50_KJPTK202608221709_202608221709", K2 = "phase6b_VPBS50_KJPTK202608221709_202608221717";
const K_SUBJECT = "normal/VPBS50/KJPTK202608221709_202608221709", OA = "phase6b_VPOA50_JPTK202608221709_202608221709";
const OA_SUBJECT = "normal/VPOA50/JPTK202608221709_202608221709";

describe("P3-EXPIRY-FORM-001 expired memory, the pending mark and the tornado sound", () => {
  // acceptance: P3-EF-T03（AC05・AC09）。
  it("P3-EF-T03 acceptance / AC05,AC09: U-L, U-R and U-B keep an expired memory, a cancel during it sounds, late reports stay silent and U-F lapses", () => {
    // U-L: 元報＋48 時間で事実を持たない expired の記憶（元報＋54 時間）。記憶の間の取消は印の証拠で鳴り、記憶が消えた後は鳴らない。
    const first = L.send(L.emptyState(), "15_16_01_241031_VPWW56");
    const heard = reduceLandslideUnit(first.state, { kind: "intentUpdate", clock: clock(L0), intentUpdate: delivered(first.state.intents) }).state;
    const landslide = reduceLandslideUnit(heard, { kind: "deadline", clock: clock(L0 + 48 * HOUR) });
    expect([landslide.state.currents.map((item) => [item.subject, item.effective, item.retainUntil, "title" in item]), landslide.intents,
      landslide.displayChanges.map((item) => [item.subject, item.after])]).toEqual([[[L_SUBJECT, "expired", L0 + 54 * HOUR, false]], [],
      [[L_SUBJECT, null]]]);
    const cancelAt = L0 + 50 * HOUR;
    const cancelled = L.send(landslide.state, "synthetic_VPWW56_cancel", L.retime("2020-06-25T01:00:00+09:00"), cancelAt);
    expect(cancelled.intents.map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
    const forgotten = reduceLandslideUnit(landslide.state, { kind: "deadline", clock: clock(L0 + 54 * HOUR) }).state;
    expect(forgotten.currents).toEqual([]);
    expect(L.send(forgotten, "synthetic_VPWW56_cancel", L.retime("2020-06-25T06:00:00+09:00"), L0 + 55 * HOUR).intents).toEqual([]);
    // 元報＋48 時間を過ぎてから採る active の版は、verified なら記憶、unverified なら保留の印で、鳴らない（AC05 (5)）。
    const lateVersion = (basis: WallBasis) => reduceLandslideUnit(first.state, { kind: "receive", material: L.decodeFixture("15_16_01_241031_VPWW56",
      L.retime("2020-06-23T00:00:00+09:00")), clock: clock(L0 + 50 * HOUR), basis });
    expect((["verified", "unverified"] as const).map((basis) => {
      const step = lateVersion(basis), record = step.state.currents[0];
      return [record.effective, record.effective === "active" && record.expiryPending === true, step.intents.length];
    })).toEqual([["expired", false, 0], ["active", true, 0]]);

    // U-R: 元報＋36 時間で記憶（元報＋42 時間）と desktop の「[期限切れ]」1 件。unverified で印を付けるときに 1 件作り、続く verified では作らない。
    const flood = R.send(R.emptyState(), "16_02_01_220728_VXKO50");
    const verified = reduceFloodUnit(flood.state, { kind: "deadline", clock: clock(R0 + 36 * HOUR) });
    expect([verified.state.currents.map((item) => [item.subject, item.effective, item.retainUntil]), verified.intents.map((item) =>
      [item.channel, item.transition])]).toEqual([[[R_SUBJECT, "expired", R0 + 42 * HOUR]], [["desktop", "expired"]]]);
    const marked = reduceFloodUnit(flood.state, { kind: "deadline", clock: clock(R0 + 36 * HOUR), basis: "unverified" });
    const settled = reduceFloodUnit(marked.state, { kind: "deadline", clock: clock(R0 + 37 * HOUR), basis: "verified" });
    expect([marked.state.currents.map((item) => item.effective === "active" && item.expiryPending), marked.intents.map((item) => item.transition),
      settled.state.currents.map((item) => item.effective), settled.intents]).toEqual([[true], ["expired"], ["expired"], []]);

    // U-B: 見える記録は元報＋2 時間で記憶（元報＋9 時間）。aliased の VPOA50 の対応報の取消を released の期限の後に受けると、verified は記憶が
    // 残ってその間の VPOA50 の取消が鳴り、unverified は保留の印で事実と通知の印が残る（AC09 (2) の例外）。
    const record = B.send(B.emptyState(), K1);
    const briefing = reduceBriefingUnit(record.state, { kind: "deadline", clock: clock(B0 + 2 * HOUR) });
    expect(briefing.state.currents.map((item) => [item.subject, item.effective, item.retainUntil])).toEqual([[K_SUBJECT, "expired", B0 + 9 * HOUR]]);
    // VPOA50 は held から相関の窓で released になって鳴り（印の証拠 possible）、対応報で aliased になる。
    const held = B.send(B.emptyState(), OA).state;
    const released = reduceBriefingUnit(held, { kind: "deadline", clock: clock(B0 + 60_000) });
    const notified = reduceBriefingUnit(released.state, { kind: "intentUpdate", clock: clock(B0 + 60_000), intentUpdate: delivered(released.state.intents) }).state;
    const paired = B.send(notified, K1, undefined, B0 + 120_000).state;
    expect(paired.currents.find((item) => item.subject === OA_SUBJECT)?.effective).toBe("aliased");
    const counter = (basis: WallBasis) => reduceBriefingUnit(paired, { kind: "receive", clock: clock(B0 + 2 * HOUR + 60_000), basis,
      material: B.decodeFixture("synthetic_VPBS50_KJPTK_cancel", (xml) => xml.replace(/<EventID>[^<]*<\/EventID>/, "<EventID>KJPTK202608221709_202608221709</EventID>")) });
    const afterVerified = counter("verified").state, afterUnverified = counter("unverified").state;
    const vpoa = (state: BriefingUnitState) => state.currents.find((item) => item.subject === OA_SUBJECT);
    const kept = vpoa(afterUnverified);
    expect([vpoa(afterVerified)?.effective, vpoa(afterVerified)?.retainUntil, kept?.effective,
      kept?.effective === "released" && [kept.expiryPending, kept.notice?.evidence]]).toEqual(["expired", B0 + 9 * HOUR, "released", [true, "possible"]]);
    const oaCancel = B.send(afterVerified, "synthetic_VPOA50_JPTK_cancel", B.retime("2026-08-22T20:09:00+09:00"), B0 + 3 * HOUR);
    expect(oaCancel.intents.map((item) => item.payload.level)).toEqual(["cancel", "cancel"]);
    // LATE-INVERSION（AC05 (5)）: 前の見える記録より新しい版を表示の期限の後に受けると、採った報は記憶になり鳴らない。
    const inverted = B.send(B.send(B.emptyState(), "VPBS50_YJPNA202608270448", undefined, at("2026-08-27T07:32:00+09:00")).state,
      "VPBS50_YJPNA202608270448", (xml) => B.serial("2")(B.retime("2026-08-27T05:18:00+09:00")(xml.replace(/<Information type="情報タグ">[\s\S]*?<\/Information>/, ""))),
      at("2026-08-27T07:33:00+09:00"));
    expect([inverted.state.currents[0].effective, inverted.intents]).toEqual(["expired", []]);
    // 竜巻の遅着（AC05 (5)）: 有効期限の後の新しい版は expired の記憶になり鳴らない。
    const tornado = M.send(M.emptyState(), "19_03_01_130906_VPHW50");
    const lateTornado = M.send(tornado.state, "19_03_01_130906_VPHW50", M.compose(M.serial("2"), M.retime("2013-07-26T10:35:00+09:00"),
      M.replaceTag("ValidDateTime", "2013-07-26T10:50:00+09:00")), at("2013-07-26T10:55:00+09:00"));
    expect([lateTornado.state.tornado[0].effective, lateTornado.intents]).toEqual(["expired", []]);

    // U-F: validUntil の到来で noActiveItems＋lapsed、報が「なし」の noActiveItems と保存→復元の後も見分ける（AC05 (6)）。
    const forecast = decodeWith("VPWP50", L.fixtureXml("81_02_01_260605_VPWP50_high_severity"), "uf-active");
    const active = reduceWeatherTimeseriesUnit(emptyTimeseries(), { kind: "receive", material: forecast, clock: clock(at(forecast.reportDateTimeRaw)) });
    const until = active.state.subjects[0].validUntil!;
    const lapsed = reduceWeatherTimeseriesUnit(active.state, { kind: "deadline", clock: clock(until) }).state;
    const decoded = weatherTimeseriesUnitCodec.decode(json(weatherTimeseriesUnitCodec.encode(lapsed)));
    expect([lapsed.subjects[0].effective, lapsed.subjects[0].lapsed, decoded.kind === "restored" && decoded.state.subjects[0].lapsed])
      .toEqual(["noActiveItems", true, true]);
  });

  // acceptance: P3-EF-T04（AC06）。
  it("P3-EF-T04 acceptance / AC06: an unverified observation keeps its stations out of view; verified expires it without them", () => {
    const material = T.decodeFixture("synthetic_VTSE51_fragmentA", "VTSE51");
    const report = at(material.reportDateTimeRaw);
    const observed = reduceTsunamiUnit(T.emptyState(), { kind: "receive", material, clock: clock(report) }).state;
    const stations = observed.observations[0].stations.length;
    expect(stations).toBeGreaterThan(0);
    const marked = reduceTsunamiUnit(observed, { kind: "deadline", clock: clock(report + 24 * HOUR), basis: "unverified" }).state;
    expect([marked.observations[0].effective, marked.observations[0].expiryPending, marked.observations[0].stations.length,
      toTsunamiView(marked).observations]).toEqual(["active", true, stations, []]);
    const expired = reduceTsunamiUnit(marked, { kind: "deadline", clock: clock(report + 25 * HOUR), basis: "verified" }).state;
    expect([expired.observations[0].effective, expired.observations[0].stations, expired.observations[0].estimations,
      expired.observations[0].retainUntil]).toEqual(["expired", [], [], report + 24 * HOUR + 7 * 24 * HOUR]);
  });

  // acceptance: P3-EF-T05（AC07・AC08）。
  it("P3-EF-T05 acceptance / AC07,AC08: a tornado without a sighting sounds normal, a sighting warning, its expiry is expired; VPAW51 and VPZI50 keep 3 hours", () => {
    const plain = M.send(M.emptyState(), "synthetic_VPHW50_tokyo_pair", (xml) => xml.replace("【目撃情報あり】", ""));
    const sighted = M.send(M.emptyState(), "19_04_01_140425_VPHW51");
    expect([plain.intents.map((item) => item.payload.level), sighted.intents.map((item) => item.payload.level)]).toEqual([["normal", "normal"],
      ["warning", "warning"]]);
    const valid = at("2014-02-12T14:30:00+09:00");
    const expired = M.tick(plain.state, valid).state, released = M.send(plain.state, "synthetic_VPHW50_tokyo_release", undefined,
      at("2014-02-12T13:50:00+09:00"));
    expect([expired.tornado[0].effective, released.state.tornado[0].effective, released.intents.map((item) => item.payload.level)])
      .toEqual(["expired", "ended", ["info", "info"]]);
    // 早期天候情報・全般天候情報は Head/ValidDateTime を持っても元報から 3 時間で見えなくなる（P3-EF-D-TRANSIENT-VALID=A）。
    for (const name of ["72_08_01_190327_VPAW51", "29_01_01_140129_VPZI50"]) {
      const step = M.send(M.emptyState(), name);
      const report = at(step.state.transient[0].source.reportDateTimeRaw);
      expect([toLocalBulletinsView(M.tick(step.state, report + 3 * HOUR - 1).state).transient.length,
        toLocalBulletinsView(M.tick(step.state, report + 3 * HOUR).state).transient.length], name).toEqual([1, 0]);
    }
  });

  // corpusHistory: P3-EF-T06（AC09）。sequences の O01・O03・O07・O08 の書き換えた期待は briefing-corpus の履歴 oracle が通す。
  it("P3-EF-T06 corpusHistory / AC09: record rain is one subject per report, aliased by K and the whole EventID; series stay; a branch cancel without its record is silent", () => {
    let state = B.emptyState();
    for (const name of [OA, "phase6b_VPOA50_JPTK202608221709_202608221717", K1, K2]) state = B.send(state, name, undefined, B0 + 1_000).state;
    expect(state.currents.map((item) => [item.subject, item.effective])).toEqual([
      [OA_SUBJECT, "aliased"], ["normal/VPOA50/JPTK202608221709_202608221717", "aliased"],
      [K_SUBJECT, "active"], ["normal/VPBS50/KJPTK202608221709_202608221717", "active"]]);
    // 線状降水帯は系列ごと、K で始まらない記録雨も報ごと、記録雨とほかの種別が混ざる報は系列のまま。
    const subjects = ["VPBS50_YJPNB202608270448", "82_01_02_250630_VPBS50", "synthetic_VPBS50_multi"].map((name) =>
      B.send(B.emptyState(), name).decisions[0].subject);
    expect(subjects).toEqual(["normal/VPBS50/YJPNB202608270448", "normal/VPBS50/JPSB202307131329_202307131329", "normal/VPBS50/JPOD240001"]);
    // 記録雨の報の記録が記憶の期限を過ぎて無い状態で、同じ EventID の取消は同じ親番の系列の記録を取り消さず、鳴らない。
    const series = B.send(B.emptyState(), "VPBS50_YJPNB202608270448", (xml) => xml.replace(/<EventID>[^<]*<\/EventID>/,
      "<EventID>KJPTK202608221709_202608221709</EventID>").replace(/<ReportDateTime>[^<]*</, "<ReportDateTime>2026-08-22T17:09:00+09:00<"), B0).state;
    expect(series.currents.map((item) => item.subject)).toEqual(["normal/VPBS50/KJPTK202608221709"]);
    const cancel = B.send(series, "synthetic_VPBS50_KJPTK_cancel", (xml) => xml.replace(/<EventID>[^<]*<\/EventID>/,
      "<EventID>KJPTK202608221709_202608221717</EventID>"), B0 + 60_000);
    expect([cancel.decisions[0].subject, cancel.state.currents.find((item) => item.subject === "normal/VPBS50/KJPTK202608221709")?.effective,
      cancel.intents]).toEqual(["normal/VPBS50/KJPTK202608221709_202608221717", "active", []]);
    // 実不具合（契約適合レビュー）: 系列の報を全部記録雨へ直す訂正は系列の記録を引き継ぎ、記録を 2 件にしない。
    const linear = B.send(B.emptyState(), "VPBS50_YJPNB202608270448").state;
    const corrected = B.send(linear, "VPBS50_YJPNB202608270448", (xml) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>")
      .replace("<DateTime>2026-08-26T19:48:41Z</DateTime>", "<DateTime>2026-08-26T19:49:41Z</DateTime>")
      .replace("<Condition>線状降水帯直前</Condition>", "<Condition>記録雨</Condition>"));
    expect([corrected.state.currents.map((item) => [item.subject, item.effective]), [...new Set(corrected.intents.map((item) => item.subject))]])
      .toEqual([[["normal/VPBS50/YJPNB202608270448", "active"]], ["normal/VPBS50/YJPNB202608270448"]]);
    // 実不具合（品質レビュー）: 系列の報を全部記録雨へ直す訂正と対応の VPOA50 は、どちらの到着順でも EventID の全体で結ばれ、VPOA50 は
    // 解放されず鳴らない。訂正の ReportDateTime を Z で書いた形と、VPOA50 の発表時刻が 1 分違う形でも同じ（時刻は比べない）。
    const linearK = (xml: string) => xml.replace("<Condition>記録雨</Condition>", "<Condition>線状降水帯直前</Condition>");
    const fixK = (xml: string) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>")
      .replace("<DateTime>2026-08-22T08:09:31Z</DateTime>", "<DateTime>2026-08-22T08:10:31Z</DateTime>");
    const zulu = (xml: string) => fixK(xml).replace("<ReportDateTime>2026-08-22T17:09:00+09:00</ReportDateTime>",
      "<ReportDateTime>2026-08-22T08:09:00Z</ReportDateTime>");
    const minuteLater = (xml: string) => xml.replace("<ReportDateTime>2026-08-22T17:09:00+09:00</ReportDateTime>",
      "<ReportDateTime>2026-08-22T17:10:00+09:00</ReportDateTime>");
    const seriesK = B.send(B.emptyState(), K1, linearK, B0 + 1_000).state;
    const SERIES_K = "normal/VPBS50/KJPTK202608221709";
    for (const [fix, oa] of [[fixK, undefined], [zulu, undefined], [fixK, minuteLater]] as const) {
      for (const state of [B.send(B.send(seriesK, OA, oa, B0 + 2_000).state, K1, fix, B0 + 3_000).state,
        B.send(B.send(seriesK, K1, fix, B0 + 2_000).state, OA, oa, B0 + 3_000).state]) {
        const later = reduceBriefingUnit(state, { kind: "deadline", clock: clock(B0 + 5 * 60_000) });
        const record = later.state.currents.find((item) => item.subject === SERIES_K);
        expect([later.state.currents.length, record?.effective === "active" && record.items.map((item) => item.kind),
          later.state.currents.find((item) => item.subject === OA_SUBJECT)?.effective, later.intents,
          later.state.intents.filter((item) => item.subject === OA_SUBJECT)]).toEqual([2, ["recordRain"], "aliased", [], []]);
      }
    }
    // 実不具合: EventID の全体で当たる取消は、系列の subject に引き継いだ記録にも当たる（記録の無い取消にならない）。
    const inherited = B.send(B.send(seriesK, K1, fixK, B0 + 2_000).state, OA, undefined, B0 + 3_000).state;
    const cancelK = B.send(inherited, "synthetic_VPBS50_KJPTK_cancel", (xml) => xml.replace(/<EventID>[^<]*<\/EventID>/,
      "<EventID>KJPTK202608221709_202608221709</EventID>"), B0 + 20 * 60_000);
    expect([cancelK.decisions[0].subject, cancelK.state.currents.find((item) => item.subject === SERIES_K)?.effective,
      cancelK.state.currents.some((item) => item.subject === K_SUBJECT), cancelK.intents.map((item) => item.transition)])
      .toEqual([SERIES_K, "cancelled", false, ["cancelled", "cancelled"]]);
    // 実不具合（契約適合レビュー）: 線状降水帯の系列の記録は、最後の報の EventID の全体の取消でも系列へ当たらず、記録の無い取消で鳴らない（H19）。
    const yjpnb = B.send(B.emptyState(), "VPBS50_YJPNB202608270448").state;
    const branchCancel = B.send(yjpnb, "synthetic_VPBS50_KJPTK_cancel", (xml) => xml.replace(/<EventID>[^<]*<\/EventID>/,
      "<EventID>YJPNB202608270448_202608270448</EventID>").replace("<DateTime>2026-08-22T08:29:46Z</DateTime>", "<DateTime>2026-08-26T19:58:00Z</DateTime>")
      .replaceAll("2026-08-22T17:27:00+09:00", "2026-08-27T04:48:00+09:00"), at("2026-08-27T05:00:00+09:00"));
    expect([branchCancel.state.currents.find((item) => item.subject === "normal/VPBS50/YJPNB202608270448")?.effective, branchCancel.intents])
      .toEqual(["active", []]);
    // 契約境界: 引き継いだ印は訂正で付き、系列の報の上書きで外れ、外れた後の取消は系列の記録に当たらない。
    const relinear = B.send(inherited, K1, (xml) => linearK(fixK(xml)).replace("<DateTime>2026-08-22T08:10:31Z</DateTime>",
      "<DateTime>2026-08-22T08:11:31Z</DateTime>"), B0 + 4_000).state;
    const markOf = (state: BriefingUnitState) => {
      const record = state.currents.find((item) => item.subject === SERIES_K);
      return record?.headType === "VPBS50" ? record.inherited ?? false : null;
    };
    const relinearCancel = B.send(relinear, "synthetic_VPBS50_KJPTK_cancel", (xml) => xml.replace(/<EventID>[^<]*<\/EventID>/,
      "<EventID>KJPTK202608221709_202608221709</EventID>"), B0 + 20 * 60_000);
    expect([markOf(inherited), markOf(relinear), relinearCancel.state.currents.find((item) => item.subject === SERIES_K)?.effective,
      relinearCancel.intents]).toEqual([true, false, "active", []]);
  });

  // contractBoundary: P3-EF-T07（AC05・AC10・AC14 (20)）。
  it("P3-EF-T07 contractBoundary / AC05,AC10,AC14: the new shapes round-trip, old versions start empty and broken equations are refused", () => {
    const landslide = reduceLandslideUnit(L.send(L.emptyState(), "15_16_01_241031_VPWW56").state, { kind: "deadline", clock: clock(L0 + 48 * HOUR),
      basis: "unverified" }).state;
    const memory = reduceLandslideUnit(landslide, { kind: "deadline", clock: clock(L0 + 49 * HOUR) }).state;
    for (const state of [landslide, memory]) expect(landslideUnitCodec.decode(json(landslideUnitCodec.encode(state))).kind).toBe("restored");
    const flood = reduceFloodUnit(R.send(R.emptyState(), "16_02_01_220728_VXKO50").state, { kind: "deadline", clock: clock(R0 + 36 * HOUR) }).state;
    expect(floodUnitCodec.decode(json(floodUnitCodec.encode(flood))).kind).toBe("restored");
    const briefing = reduceBriefingUnit(B.send(B.emptyState(), K1).state, { kind: "deadline", clock: clock(B0 + 2 * HOUR), basis: "unverified" }).state;
    expect(briefingUnitCodec.decode(json(briefingUnitCodec.encode(briefing))).kind).toBe("restored");
    // VPBS50 の EventID の全体は系列と合う形だけ、VPOA50 は欄を持たない（P3-EF-AC09・AC10、項目ごとに確かめる）。
    const row = (json(briefingUnitCodec.encode(briefing)) as { currents: Record<string, unknown>[] }).currents[0];
    const held = (json(briefingUnitCodec.encode(B.send(B.emptyState(), OA).state)) as { currents: Record<string, unknown>[] }).currents[0];
    const { eventId: _eventId, ...withoutEventId } = row;
    // 引き継いだ印は系列の subject の記録だけが true で持てる（全体の subject の記録・false は invalid）。
    const linear = B.send(B.emptyState(), K1, (xml) => xml.replace("<Condition>記録雨</Condition>", "<Condition>線状降水帯直前</Condition>"), B0 + 1_000).state;
    const taken = B.send(linear, K1, (xml) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>")
      .replace("<DateTime>2026-08-22T08:09:31Z</DateTime>", "<DateTime>2026-08-22T08:10:31Z</DateTime>"), B0 + 2_000).state;
    const takenRow = (json(briefingUnitCodec.encode(taken)) as { currents: Record<string, unknown>[] }).currents[0];
    expect([row, { ...row, eventId: "JPTK202608221709_202608221709" }, withoutEventId, held, { ...held, eventId: "JPTK202608221709_202608221709" },
      takenRow, { ...takenRow, inherited: false }, { ...row, inherited: true }]
      .map((item) => briefingUnitCodec.decode(json({ ...briefingUnitCodec.encode(briefing), currents: [item] })).kind))
      .toEqual(["restored", "invalid", "invalid", "restored", "invalid", "restored", "invalid", "invalid"]);
    expect(takenRow.inherited).toBe(true);
    // 等式の外の記憶、表示の期限を持たない記録の保留の印は unavailable（invalid）。
    const payload = json(landslideUnitCodec.encode(memory)) as { currents: Record<string, unknown>[] };
    const pendingPayload = json(landslideUnitCodec.encode(landslide)) as { currents: Record<string, unknown>[] };
    const broken = [
      { ...payload, currents: [{ ...payload.currents[0], retainUntil: Number(payload.currents[0].retainUntil) + 1 }] },
      { ...payload, currents: [{ ...payload.currents[0], expiryPending: true }] },
      { ...pendingPayload, currents: [{ ...pendingPayload.currents[0], retainUntil: Number(pendingPayload.currents[0].retainUntil) + 6 * HOUR }] },
      { ...pendingPayload, currents: [{ ...pendingPayload.currents[0], expiryPending: false }] },
    ];
    expect(broken.map((value) => landslideUnitCodec.decode(json(value)).kind)).toEqual(["invalid", "invalid", "invalid", "invalid"]);
    const floodPayload = json(floodUnitCodec.encode(flood)) as { currents: Record<string, unknown>[] };
    expect(floodUnitCodec.decode(json({ ...floodPayload, currents: [{ ...floodPayload.currents[0], retainUntil: R0 + 36 * HOUR }] })).kind).toBe("invalid");
    const briefingPayload = json(briefingUnitCodec.encode(reduceBriefingUnit(briefing, { kind: "deadline", clock: clock(B0 + 3 * HOUR) }).state)) as
      { currents: Record<string, unknown>[] };
    expect([briefingPayload.currents[0].effective, briefingUnitCodec.decode(json({ ...briefingPayload, currents: [{ ...briefingPayload.currents[0],
      retainUntil: B0 + 3 * HOUR }] })).kind]).toEqual(["expired", "invalid"]);
    // 竜巻の expired の記憶と目撃の鍵、U-T の保留の観測、U-F の lapsed も往復する。
    const tornado = M.tick(M.send(M.emptyState(), "19_04_01_140425_VPHW51").state, at("2014-02-12T14:30:00+09:00")).state;
    const roundTornado = localBulletinsUnitCodec.decode(json(localBulletinsUnitCodec.encode(tornado)));
    expect([tornado.tornado[0].effective, tornado.tornado[0].notice?.fragments?.length, roundTornado.kind]).toEqual(["expired", 1, "restored"]);
    const tsunami = reduceTsunamiUnit(reduceTsunamiUnit(T.emptyState(), { kind: "receive", material: T.decodeFixture("synthetic_VTSE51_fragmentA", "VTSE51"),
      clock: clock(at("2011-03-11T15:02:00+09:00")) }).state, { kind: "deadline", clock: clock(at("2011-03-12T15:02:00+09:00")), basis: "unverified" }).state;
    expect(tsunamiUnitCodec.decode(json(tsunamiUnitCodec.encode(tsunami))).kind).toBe("restored");
    // 捨てる旧い版（P3-VM-AC05）。
    expect([landslideUnitCodec.discardableSchemaVersions, floodUnitCodec.discardableSchemaVersions, briefingUnitCodec.discardableSchemaVersions,
      tsunamiUnitCodec.discardableSchemaVersions, localBulletinsUnitCodec.discardableSchemaVersions, weatherTimeseriesUnitCodec.discardableSchemaVersions]
      .map((list) => list?.at(-1))).toEqual(["p3-landslide-unit-v6", "p3-flood-unit-v7", "p3-briefing-unit-v6", "p3-tsunami-unit-v6",
      "p3-local-bulletins-unit-v6", "p2-weather-timeseries-unit-v7"]);
  });

  // acceptance: P3-EF-T10（AC07 (3)〜(5)、D3・D4）。
  it("P3-EF-T10 acceptance / AC07: a sighting after its plain pair warns once by the SIGHTED key; an expired pair never comes back", () => {
    const plain50 = (state: LocalBulletinsUnitState, now = at("2014-02-12T13:19:00+09:00")) => M.send(state, "synthetic_VPHW50_tokyo_pair",
      (xml) => xml.replace("【目撃情報あり】", ""), now);
    const sighted51 = (state: LocalBulletinsUnitState, now = at("2014-02-12T13:20:00+09:00"), basis: WallBasis = "verified") =>
      reduceLocalBulletinsUnit(state, { kind: "receive", material: M.decodeFixture("19_04_01_140425_VPHW51"), clock: clock(now), basis });
    const first = plain50(M.emptyState());
    // (a) 50 の通知が pending なら warning が 1 件ずつ（channel ごと）で、50 の pending は置き換わる。
    const replaced = sighted51(first.state);
    expect([replaced.intents.map((item) => item.payload.level), replaced.state.intents.map((item) => item.payload.level)]).toEqual([
      ["warning", "warning"], ["warning", "warning"]]);
    // (b) 50 の通知が配送済みなら、もう 1 回 warning。
    const sent = reduceLocalBulletinsUnit(first.state, { kind: "intentUpdate", clock: clock(at("2014-02-12T13:19:30+09:00")),
      intentUpdate: delivered(first.state.intents) }).state;
    expect(sighted51(sent).intents.map((item) => item.payload.level)).toEqual(["warning", "warning"]);
    // (c) 50 の後に保存→復元を挟んでも warning はちょうど 1 回、(d) 51 を受け直しても作らない。
    const restored = localBulletinsUnitCodec.decode(json(localBulletinsUnitCodec.encode(sent)));
    if (restored.kind !== "restored") throw new Error("restore failed");
    const again = sighted51(restored.state);
    expect([again.intents.length, sighted51(again.state, at("2014-02-12T13:21:00+09:00")).intents]).toEqual([2, []]);
    // D4: 50 の後 unverified で表示の期限を過ぎて保留にし、保存→復元し、verified で記憶に移した後の 51 は見える状態に戻らず鳴らない。
    const valid = at("2014-02-12T14:30:00+09:00");
    const pending = reduceLocalBulletinsUnit(first.state, { kind: "deadline", clock: clock(valid), basis: "unverified" }).state;
    const pendingLate = sighted51(pending, valid + 60_000, "unverified");
    expect([pendingLate.intents, toLocalBulletinsView(pendingLate.state).tornado, pendingLate.state.tornado[0].effective === "active"
      && [pendingLate.state.tornado[0].expiryPending, pendingLate.state.tornado[0].sighted]]).toEqual([[], [], [true, true]]);
    const saved = localBulletinsUnitCodec.decode(json(localBulletinsUnitCodec.encode(pending)));
    if (saved.kind !== "restored") throw new Error("restore failed");
    const memory = reduceLocalBulletinsUnit(saved.state, { kind: "deadline", clock: clock(valid + 60_000), basis: "verified" }).state;
    const memoryLate = sighted51(memory, valid + 120_000);
    expect([memory.tornado[0].effective, memoryLate.intents, memoryLate.state.tornado[0].effective, toLocalBulletinsView(memoryLate.state).tornado])
      .toEqual(["expired", [], "expired", []]);
  });
});

function emptyTimeseries() {
  return { schemaVersion: "p2-weather-timeseries-unit-v8" as const, contentRevision: 0, subjects: [], gates: [], intents: [],
    persistence: { kind: "saved" as const, currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } };
}

// P3-EF-T02（AC02・AC03・AC04・AC11）: 12 unit の表。各 unit に 1 報を受けさせ、表示の期限・retainUntil・intent の期限のどれも過ぎた時刻の
// deadline・restore の入力を根拠ごとに当てる。
type Deadline = Readonly<{ kind: "deadline"; clock: ReturnType<typeof clock>; basis?: WallBasis }>;
type Restore<P> = Readonly<{ kind: "restore"; persisted: P; clock: ReturnType<typeof clock>; basis?: WallBasis }>;
type Unit<S, P> = Readonly<{ reduce: (state: S, input: Deadline | Restore<P>) => Readonly<{ state: S }>; encode: (state: S) => P }>;
function rowOf<S extends Readonly<{ intents: readonly NotificationIntent[] }>, P>(unit: string, seed: S, report: number, codec: Unit<S, P>,
  marked: (state: S) => boolean, display: boolean) {
  const far = report + 400 * 24 * HOUR;
  const deadline = (state: S, basis: WallBasis, wall = far) => codec.reduce(state, { kind: "deadline", clock: clock(wall), basis }).state;
  const restore = (basis: WallBasis) => codec.reduce(seed, { kind: "restore", persisted: codec.encode(seed), clock: clock(far), basis }).state;
  const awaiting = deadline(seed, "awaiting"), unverified = deadline(seed, "unverified"), verified = deadline(seed, "verified");
  return { unit, row: [awaiting === seed || unit === "U-E" && awaiting.intents === seed.intents, marked(unverified) === display,
    unverified.intents === seed.intents, deadline(unverified, "unverified", far + 1) === unverified, verified.intents.length, marked(verified),
    marked(restore("awaiting")), marked(restore("unverified")) === display, marked(restore("verified")), seed.intents.length > 0] };
}

const pendingIn = (values: readonly object[]) => values.some((item) => "expiryPending" in item);
function seedOf<S, I>(reduce: (state: S, input: I) => Readonly<{ state: S }>, empty: S, headType: string, file: string,
  input: (material: ReturnType<typeof decodeWith>, report: number) => I) {
  const material = decodeWith(headType, L.fixtureXml(file), `t02-${headType}`), report = at(material.reportDateTimeRaw);
  return { state: reduce(empty, input(material, report)).state, report };
}
const receiveAt = (material: ReturnType<typeof decodeWith>, report: number) => ({ kind: "receive" as const, material, clock: clock(report) });

describe("P3-EXPIRY-FORM-001 the basis of every unit", () => {
  it("P3-EF-T02 contractBoundary / AC02,AC03,AC04,AC11: awaiting applies nothing, unverified only the pending mark, verified the memory and the recall", () => {
    const e = seedOf(reduceEewUnit, initialUnits["U-E"], "VXSE43", "37_01_01_240613_VXSE43", receiveAt);
    const w = seedOf(reduceWeatherCurrentUnit, initialUnits["U-W"], "VPWW57", "15_16_02_251222_VPWW57", receiveAt);
    const f = seedOf(reduceWeatherTimeseriesUnit, initialUnits["U-F"], "VPWP50", "81_02_01_260605_VPWP50_high_severity", receiveAt);
    const t = seedOf(reduceTsunamiUnit, initialUnits["U-T"], "VTSE51", "synthetic_VTSE51_fragmentA", receiveAt);
    const q = seedOf(reduceSeismicUnit, initialUnits["U-Q"], "VXSE53", "32-35_04_04_240613_VXSE53", receiveAt);
    const n = seedOf(reduceNankaiUnit, initialUnits["U-N"], "VYSE50", "test/fixtures/selected_xml/74_01_04_200512_VYSE50.xml", receiveAt);
    const v = seedOf(reduceVolcanoUnit, initialUnits["U-V"], "VFVO56", "67_01_01_140927_VFVO56", receiveAt);
    // U-V の定時（VFVO53、見えない）と解説（VZVO40、保存しない）も行に持つ。
    const vs = seedOf(reduceVolcanoUnit, initialUnits["U-V"], "VFVO53", "66_01_01_210517_VFVO53", receiveAt);
    const vb = seedOf(reduceVolcanoUnit, initialUnits["U-V"], "VZVO40", "42_02_01_071130_VZVO40", receiveAt);
    const l = seedOf(reduceLandslideUnit, initialUnits["U-L"], "VPWW56", "15_16_01_241031_VPWW56", receiveAt);
    const r = seedOf(reduceFloodUnit, initialUnits["U-R"], "VXKO50", "16_02_01_220728_VXKO50", receiveAt);
    const b = seedOf(reduceBriefingUnit, initialUnits["U-B"], "VPBS50", K1, receiveAt);
    const m = seedOf(reduceLocalBulletinsUnit, initialUnits["U-M"], "VPHW50", "19_03_01_130906_VPHW50", receiveAt);
    const y = seedOf(reduceTyphoonUnit, initialUnits["U-Y"], "VPTW60", "10_05_01_200826_VPTW60", receiveAt);
    // U-T・U-Q は until を過ぎた失敗の印も持たせる（P3-EF-AC06 (4)・AC04）。
    const failure = (report: number) => [{ operation: "normal" as const, level: "critical" as const, until: report + 1 }];
    const tSeed = { ...t.state, failureMarks: failure(t.report) }, qSeed = { ...q.state, failureMarks: failure(q.report) };
    const rows = [
      rowOf("U-E", e.state, e.report, { reduce: reduceEewUnit, encode: eewUnitCodec.encode }, () => false, false),
      rowOf("U-W", w.state, w.report, { reduce: reduceWeatherCurrentUnit, encode: weatherCurrentUnitCodec.encode }, () => false, false),
      rowOf("U-F", f.state, f.report, { reduce: reduceWeatherTimeseriesUnit, encode: weatherTimeseriesUnitCodec.encode }, (state) => pendingIn(state.subjects), true),
      rowOf("U-T", tSeed, t.report, { reduce: reduceTsunamiUnit, encode: tsunamiUnitCodec.encode }, (state) => pendingIn(state.observations), true),
      rowOf("U-Q", qSeed, q.report, { reduce: reduceSeismicUnit, encode: seismicUnitCodec.encode }, () => false, false),
      rowOf("U-N", n.state, n.report, { reduce: reduceNankaiUnit, encode: nankaiUnitCodec.encode }, (state) => pendingIn(state.currents), true),
      rowOf("U-V", v.state, v.report, { reduce: reduceVolcanoUnit, encode: volcanoUnitCodec.encode }, (state) => pendingIn(state.eruptions), true),
      rowOf("U-V scheduled", vs.state, vs.report, { reduce: reduceVolcanoUnit, encode: volcanoUnitCodec.encode }, () => false, false),
      rowOf("U-V bulletin", vb.state, vb.report, { reduce: reduceVolcanoUnit, encode: volcanoUnitCodec.encode }, (state) => pendingIn(state.bulletins), true),
      rowOf("U-L", l.state, l.report, { reduce: reduceLandslideUnit, encode: landslideUnitCodec.encode }, (state) => pendingIn(state.currents), true),
      rowOf("U-R", r.state, r.report, { reduce: reduceFloodUnit, encode: floodUnitCodec.encode }, (state) => pendingIn(state.currents), true),
      rowOf("U-B", b.state, b.report, { reduce: reduceBriefingUnit, encode: briefingUnitCodec.encode }, (state) => pendingIn(state.currents), true),
      rowOf("U-M", m.state, m.report, { reduce: reduceLocalBulletinsUnit, encode: localBulletinsUnitCodec.encode }, (state) => pendingIn(state.tornado), true),
      rowOf("U-Y", y.state, y.report, { reduce: reduceTyphoonUnit, encode: typhoonUnitCodec.encode }, (state) => pendingIn(state.analysis), true),
    ];
    // 列: awaiting は同じ参照、unverified の印、unverified は intent を失効させない、unverified の繰り返しは同じ参照、verified の後の intent の数、
    // verified の後の印、復元（awaiting・unverified・verified）の印、seed が intent を持つ。U-R だけは印を付けるときに desktop の「[期限切れ]」を
    // 1 件作り（AC05 (4)、verified でも 1 件残る）、復元の入力では期限を当てない（復元の直後の owner の期限要求が当てる）。
    // 解説は保存しないので、復元の後の印は無い。
    expect(rows.map((item) => [item.unit, ...item.row])).toEqual(rows.map((item) => item.unit === "U-R"
      ? [item.unit, true, true, false, true, 1, false, false, false, false, true]
      : [item.unit, true, true, true, true, 0, false, false, item.unit !== "U-V bulletin", false, item.row[9]]));
    // 定時と解説は verified で retainUntil を過ぎたら除かれ、次の期限要求は同じ参照（回収の最小と削除が同じ条件、AC02 (3)・AC11）。
    const recalled = [vs, vb].map(({ state, report }) => {
      const once = reduceVolcanoUnit(state, { kind: "deadline", clock: clock(report + 400 * 24 * HOUR), basis: "verified" });
      const twice = reduceVolcanoUnit(once.state, { kind: "deadline", clock: clock(report + 400 * 24 * HOUR + 1), basis: "verified" });
      return [state.scheduledAshfalls.length + state.bulletins.length, once.state.scheduledAshfalls.length + once.state.bulletins.length,
        once.nextDeadline?.wallTimeMs ?? null, twice.state === once.state];
    });
    expect(recalled).toEqual([[1, 0, null, true], [1, 0, null, true]]);
    // 時計が後ろへ直る: 保留にした解説は、元の retainUntil より前の wall の verified でも除く（P3-EF-AC02 (3)(7)）。
    const pendingBulletin = reduceVolcanoUnit(vb.state, { kind: "deadline", clock: clock(vb.report + 400 * 24 * HOUR), basis: "unverified" }).state;
    const back = reduceVolcanoUnit(pendingBulletin, { kind: "deadline", clock: clock(vb.report + 1), basis: "verified" });
    expect([pendingIn(pendingBulletin.bulletins), back.state.bulletins, (back.nextDeadline?.wallTimeMs ?? Infinity) > vb.report + 1])
      .toEqual([true, [], true]);
    // 失敗の印は確かめた時計でだけ外れる（P3-EF-AC06 (4)・AC04）。
    const marks = (basis: WallBasis) => [reduceTsunamiUnit(tSeed, { kind: "deadline", clock: clock(t.report + 2), basis }).state.failureMarks.length,
      reduceSeismicUnit(qSeed, { kind: "deadline", clock: clock(q.report + 2), basis }).state.failureMarks.length];
    expect([marks("awaiting"), marks("unverified"), marks("verified")]).toEqual([[1, 1], [1, 1], [0, 0]]);
  });

  it("P3-EF-T02 contractBoundary / AC03: a full unit evicts past retainUntil first only on a verified input; otherwise the invisible tier oldest first", () => {
    const iso = (ms: number) => new Date(ms + 9 * HOUR).toISOString().replace(".000Z", "+09:00");
    // U-L 128 件: 元報＋48 時間を過ぎた古い active（A）、retainUntil の内の記憶（B）、新しい active 126 件。
    const seed = L.send(L.emptyState(), "15_16_01_241031_VPWW56").state.currents[0];
    if (seed.effective !== "active") throw new Error("active seed");
    const now = L0 + 50 * HOUR;
    const clone = (name: string, report: number) => {
      const subject = `normal/VPWW56/${name}`;
      return { ...seed, subject, office: name, source: { ...seed.source, subject, reportDateTimeRaw: iso(report) }, retainUntil: report + 48 * HOUR };
    };
    const a = clone("官署A", L0), memory = clone("官署B", L0 + HOUR);
    const b = { subject: memory.subject, operation: memory.operation, office: memory.office, source: memory.source, retainUntil: L0 + HOUR + 54 * HOUR,
      effective: "expired" as const };
    const full = { ...L.emptyState(), currents: [a, b, ...Array.from({ length: 126 }, (_, index) => clone(`官署${String(index).padStart(3, "0")}`, now - HOUR))] };
    const incoming = (basis: WallBasis) => reduceLandslideUnit(full, { kind: "receive", clock: clock(now), basis,
      material: L.decodeFixture("15_16_01_241031_VPWW56", (xml) => L.office("新官署")(L.retime(iso(now))(xml))) }).state.currents;
    const evicted = (currents: readonly Readonly<{ subject: string }>[]) => [a.subject, b.subject].filter((subject) => !currents.some((item) => item.subject === subject));
    expect([evicted(incoming("verified")), evicted(incoming("unverified"))]).toEqual([[a.subject], [b.subject]]);

    // U-T の fit も同じ形: 観測 512 件（見える normal 510、retainUntil を過ぎた expired の X、より古い保留の Y）に新しい観測。
    const report = at("2099-01-01T09:00:00+09:00"), later = report + 30 * 24 * HOUR;
    const observed = reduceTsunamiUnit(T.emptyState(), { kind: "receive", clock: clock(report),
      material: T.decodeXml(T.observation({ at: iso(report), serial: 1, stations: [{ code: "1", height: "1.0" }] }), "VTSE51") }).state.observations[0];
    const obs = (index: number, patch: object, reported = report) => {
      const eventId = `2099010100${String(index).padStart(4, "0")}`, subject = `normal/tsunamiObservation:VTSE51/${eventId}`;
      return { ...observed, ...patch, subject, eventId, stations: [], source: { ...observed.source, subject, reportDateTimeRaw: iso(reported) } };
    };
    // Y は X より古い報（見えない記録の段の中では古い順）。
    const x = obs(1, { effective: "expired", validUntil: null, retainUntil: later - 1 }, report + HOUR);
    const y = obs(2, { expiryPending: true });
    const tsunami = { ...T.emptyState(), observations: [x, y, ...Array.from({ length: 510 }, (_, index) => obs(100 + index,
      { validUntil: later + 24 * HOUR }))] };
    const arrive = (basis: WallBasis) => reduceTsunamiUnit(tsunami, { kind: "receive", clock: clock(later), basis,
      material: T.decodeXml(T.observation({ eventId: "20990201000000", at: iso(later), serial: 1 }), "VTSE51") }).state.observations;
    const gone = (observations: readonly Readonly<{ subject: string }>[]) => [x.subject, y.subject].filter((subject) => !observations.some((item) => item.subject === subject));
    expect([gone(arrive("verified")), gone(arrive("unverified"))]).toEqual([[x.subject], [y.subject]]);
  });
});
