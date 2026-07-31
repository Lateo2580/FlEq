import { describe, it, expect } from "vitest";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  readFixture,
  FIXTURE_VPWW56_DOSHA,
} from "../../helpers/mock-message";
import { parseWeatherWarning } from "../../../src/dmdata/weather-parser";
import {
  Vpww56StateHolder,
} from "../../../src/engine/messages/vpww56-state";
import type { ParsedWeatherWarning, WeatherKind, WeatherItem } from "../../../src/types";
import type { WeatherReportIdentity } from "../../../src/engine/messages/vpws50-state";

/**
 * VPWW56 は府県予報区ごとに別の地方気象台が発表する。この holder は発表官署単位で
 * view を保持し、参照時に union する契約なので、その契約 (別官署の続報が既存官署の
 * 警報を消さない / view が官署ごとに独立 / 解除官署の掃除) をここで固定する。
 */

const LAYER_TYPE = "気象警報・注意報（府県予報区等）";

/** レベル４土砂災害危険警報 (landslide, officialL4) */
const L4_LANDSLIDE: WeatherKind = {
  name: "レベル４土砂災害危険警報",
  code: "49",
  severity: "warning",
};
/** レベル４高潮危険警報 (stormSurge, officialL4 — landslide と同 rank) */
const L4_STORM_SURGE: WeatherKind = {
  name: "レベル４高潮危険警報",
  code: "48",
  severity: "warning",
};
/** レベル３土砂災害警戒警報 (landslide, officialL3 — L4 より下位 rank) */
const L3_LANDSLIDE: WeatherKind = {
  name: "レベル３土砂災害警戒警報",
  code: "09",
  severity: "warning",
};

function baseInfo(): ParsedWeatherWarning {
  const parsed = parseWeatherWarning(createMockWsDataMessage(FIXTURE_VPWW56_DOSHA));
  expect(parsed).not.toBeNull();
  return parsed!;
}

function item(areaCode: string, areaName: string, kinds: WeatherKind[]): WeatherItem {
  return {
    areaName,
    areaCode,
    kinds,
    statuses: kinds.map((k) => ({ kindCode: k.code, status: "発表" })),
  };
}

function report(
  office: string,
  reportDateTime: string,
  items: WeatherItem[],
  overrides: Partial<ParsedWeatherWarning> = {},
): ParsedWeatherWarning {
  return {
    ...baseInfo(),
    publishingOffice: office,
    reportDateTime,
    layers: [{ type: LAYER_TYPE, items }],
    ...overrides,
  };
}

function id(reportDateTime: string, serial: string | null = null): WeatherReportIdentity {
  return { reportDateTime, serial };
}

const T1 = "2026-07-19T09:00:00+09:00";
const T2 = "2026-07-19T10:00:00+09:00";
const T3 = "2026-07-19T11:00:00+09:00";

const WAKKANAI = "稚内地方気象台";
const ASAHIKAWA = "旭川地方気象台";

describe("Vpww56StateHolder 官署単位 union", () => {
  it("別官署の発表は互いを消さず union された view を返す", () => {
    const holder = new Vpww56StateHolder();
    holder.update(report(WAKKANAI, T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1"));
    holder.update(report(ASAHIKAWA, T2, [item("012000", "上川地方", [L4_LANDSLIDE])]), id(T2, "1"));

    const view = holder.getCurrentAreasForDisplay();
    expect(view?.totalAreas).toBe(2);
    expect(view?.kinds).toHaveLength(1);
    expect(view?.kinds[0].areas).toEqual([
      { areaName: "宗谷地方", areaCode: "011000" },
      { areaName: "上川地方", areaCode: "012000" },
    ]);
  });

  it("受理済み mutation は官署ごとに独立し、他官署の view を巻き込まない", () => {
    const holder = new Vpww56StateHolder();
    // 旭川が先に T3 まで進んでも、稚内の T1→T2 の続報は受理される
    expect(holder.update(report(ASAHIKAWA, T3, [item("012000", "上川地方", [L4_LANDSLIDE])]), id(T3, "1")))
      .toEqual({ kind: "updated" });
    expect(holder.update(report(WAKKANAI, T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1")))
      .toEqual({ kind: "updated" });
    expect(holder.update(report(WAKKANAI, T2, [item("011000", "宗谷地方", [L3_LANDSLIDE])]), id(T2, "2")))
      .toEqual({ kind: "updated" });

    const view = holder.getCurrentAreasForDisplay();
    expect(view?.totalAreas).toBe(2);
    // 稚内は L3 へ置換済み、旭川の L4 は残る
    expect(view?.kinds.map((k) => k.kindCode)).toEqual(["49", "09"]);
    expect(view?.kinds[0].areas).toEqual([{ areaName: "上川地方", areaCode: "012000" }]);
    expect(view?.kinds[1].areas).toEqual([{ areaName: "宗谷地方", areaCode: "011000" }]);
  });

  it("同一官署の続報は自分の view だけを置換し、他官署の地域を巻き込まない", () => {
    const holder = new Vpww56StateHolder();
    holder.update(report(WAKKANAI, T1, [
      item("011000", "宗谷地方", [L4_LANDSLIDE]),
      item("011100", "宗谷北部", [L4_LANDSLIDE]),
    ]), id(T1, "1"));
    holder.update(report(ASAHIKAWA, T1, [item("012000", "上川地方", [L4_LANDSLIDE])]), id(T1, "1"));
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(3);

    // 稚内が 1 地域へ縮小 → 稚内分だけ減り、旭川分は残る
    holder.update(report(WAKKANAI, T2, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T2, "2"));
    const view = holder.getCurrentAreasForDisplay();
    expect(view?.totalAreas).toBe(2);
    expect(view?.kinds[0].areas.map((a) => a.areaCode).sort()).toEqual(["011000", "012000"]);
  });

  it("片方の官署の取消は自分の view だけを落とす", () => {
    const holder = new Vpww56StateHolder();
    holder.update(report(WAKKANAI, T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1"));
    holder.update(report(ASAHIKAWA, T1, [item("012000", "上川地方", [L4_LANDSLIDE])]), id(T1, "1"));

    expect(holder.update(
      report(WAKKANAI, T1, [], { infoType: "取消" }),
      id(T1, "1"),
    )).toEqual({ kind: "updated" });

    const view = holder.getCurrentAreasForDisplay();
    expect(view?.totalAreas).toBe(1);
    expect(view?.kinds[0].areas).toEqual([{ areaName: "上川地方", areaCode: "012000" }]);
  });

  it("全官署が取消されると undefined へ落ちる", () => {
    const holder = new Vpww56StateHolder();
    holder.update(report(WAKKANAI, T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1"));
    holder.update(report(ASAHIKAWA, T1, [item("012000", "上川地方", [L4_LANDSLIDE])]), id(T1, "1"));

    holder.update(report(WAKKANAI, T1, [], { infoType: "取消" }), id(T1, "1"));
    holder.update(report(ASAHIKAWA, T1, [], { infoType: "取消" }), id(T1, "1"));
    expect(holder.getCurrentAreasForDisplay()).toBeUndefined();
  });

  it("発表中 Kind がゼロになった続報は、その官署の view を空へ落とす", () => {
    const holder = new Vpww56StateHolder();
    holder.update(report(WAKKANAI, T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1"));
    holder.update(report(ASAHIKAWA, T1, [item("012000", "上川地方", [L4_LANDSLIDE])]), id(T1, "1"));

    // 解除 Kind のみの続報 → buildView が undefined → 稚内の view が消える
    holder.update(report(WAKKANAI, T2, [
      item("011000", "宗谷地方", [{ name: "解除", code: "00", severity: "release" }]),
    ]), id(T2, "2"));

    const view = holder.getCurrentAreasForDisplay();
    expect(view?.totalAreas).toBe(1);
    expect(view?.kinds[0].areas).toEqual([{ areaName: "上川地方", areaCode: "012000" }]);
  });

  it("同一 areaCode が複数官署から来ても totalAreas と areas を重複させない", () => {
    const holder = new Vpww56StateHolder();
    holder.update(report(WAKKANAI, T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1"));
    holder.update(report(ASAHIKAWA, T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1"));

    const view = holder.getCurrentAreasForDisplay();
    expect(view?.totalAreas).toBe(1);
    expect(view?.kinds).toHaveLength(1);
    expect(view?.kinds[0].areas).toEqual([{ areaName: "宗谷地方", areaCode: "011000" }]);
  });

  it("kinds は displaySeverity 降順、同 rank では kindCode 昇順で決定的に並ぶ", () => {
    const holder = new Vpww56StateHolder();
    // 受信順は L3 → L4(49) → L4(48)。並びは rank 降順 + 同 rank kindCode 昇順
    holder.update(report(WAKKANAI, T1, [item("011000", "宗谷地方", [L3_LANDSLIDE])]), id(T1, "1"));
    holder.update(report(ASAHIKAWA, T1, [item("012000", "上川地方", [L4_LANDSLIDE])]), id(T1, "1"));
    holder.update(report("札幌管区気象台", T1, [item("016000", "石狩地方", [L4_STORM_SURGE])]), id(T1, "1"));

    expect(holder.getCurrentAreasForDisplay()?.kinds.map((k) => k.kindCode)).toEqual(["48", "49", "09"]);
  });

  it("官署名が空の電文は durable holder に入れず、完全な官署 stream は維持する", () => {
    const holder = new Vpww56StateHolder();
    holder.update(report("", T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1"));
    holder.update(report(ASAHIKAWA, T1, [item("012000", "上川地方", [L4_LANDSLIDE])]), id(T1, "1"));

    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(1);
  });
});

/**
 * ストリームの単位は (head.type, publishingOffice) の複合キー。
 * 現状 holder に入ってくるのは VPWW56 だけ (processWeather が門番している) なので
 * 実運用の挙動は変わらないが、将来 VPWW55/57-61 を相乗りさせたときに
 * 「同一官署の別カテゴリが互いを上書きする」事故を起こさないための契約をここで固定する。
 * 粒度は project-event.ts のテロップ groupKey `weather:${type}:${publishingOffice}` と一致する。
 */
describe("Vpww56StateHolder 複合キー (type, publishingOffice)", () => {
  const LANDSLIDE = "VPWW56";
  const HEAVY_RAIN = "VPWW61";

  it("同一官署でも type が違えば別ストリームとして共存する", () => {
    const holder = new Vpww56StateHolder();
    holder.update(report(WAKKANAI, T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1"));
    holder.update(
      report(WAKKANAI, T1, [item("011100", "宗谷北部", [L4_LANDSLIDE])], { type: HEAVY_RAIN }),
      id(T1, "1"),
    );

    expect(holder.trackedStreamCount()).toBe(2);
    const view = holder.getCurrentAreasForDisplay();
    expect(view?.totalAreas).toBe(2);
    expect(view?.kinds[0].areas.map((a) => a.areaCode).sort()).toEqual(["011000", "011100"]);
  });

  it("同一官署・同一 type の続報は従来どおり置換される", () => {
    const holder = new Vpww56StateHolder();
    holder.update(report(WAKKANAI, T1, [
      item("011000", "宗谷地方", [L4_LANDSLIDE]),
      item("011100", "宗谷北部", [L4_LANDSLIDE]),
    ]), id(T1, "1"));
    holder.update(report(WAKKANAI, T2, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T2, "2"));

    expect(holder.trackedStreamCount()).toBe(1);
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(1);
  });

  it("受理済み mutation は (type, 官署) ごとに独立する", () => {
    const holder = new Vpww56StateHolder();
    // 同一官署の VPWW61 が先に T3 まで進んでも、VPWW56 の T1→T2 は受理される
    expect(holder.update(
      report(WAKKANAI, T3, [item("011100", "宗谷北部", [L4_LANDSLIDE])], { type: HEAVY_RAIN }),
      id(T3, "1"),
    )).toEqual({ kind: "updated" });
    expect(holder.update(report(WAKKANAI, T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1")))
      .toEqual({ kind: "updated" });
    expect(holder.update(report(WAKKANAI, T2, [item("011000", "宗谷地方", [L3_LANDSLIDE])]), id(T2, "2")))
      .toEqual({ kind: "updated" });
  });

  it("取消は同一 type のストリームだけを落とし、同一官署の別 type は残る", () => {
    const holder = new Vpww56StateHolder();
    holder.update(report(WAKKANAI, T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1"));
    holder.update(
      report(WAKKANAI, T1, [item("011100", "宗谷北部", [L4_LANDSLIDE])], { type: HEAVY_RAIN }),
      id(T1, "1"),
    );

    expect(holder.update(report(WAKKANAI, T1, [], { infoType: "取消", type: LANDSLIDE }), id(T1, "1")))
      .toEqual({ kind: "updated" });

    const view = holder.getCurrentAreasForDisplay();
    expect(view?.totalAreas).toBe(1);
    expect(view?.kinds[0].areas).toEqual([{ areaName: "宗谷北部", areaCode: "011100" }]);
  });

});

/**
 * 上の describe は view を手組みして契約を固定しているが、それだと parser が
 * publishingOffice をどこから採るかが検証から抜ける (mock の envelope は既定で
 * "気象庁" 固定なので、fixture 経由だと全電文が同一官署へ落ちる)。
 * ここでは fixture → parseWeatherWarning → holder の実経路を通し、
 * envelope の官署を振り分けた電文が別ストリームとして保持されることを押さえる。
 */
describe("Vpww56StateHolder 官署単位 union (fixture 実経路)", () => {
  /** fixture をそのまま、envelope の発表官署だけ差し替えて parse する */
  function parseAsOffice(office: string, reportDateTime: string): ParsedWeatherWarning {
    const msg = createMockWsDataMessage(FIXTURE_VPWW56_DOSHA, undefined, { publishingOffice: office });
    const parsed = parseWeatherWarning(msg);
    expect(parsed).not.toBeNull();
    return { ...parsed!, reportDateTime };
  }

  /** fixture XML の対象地域を差し替えた synthetic 電文 (別府県予報区の官署を模す) */
  function parseAsOtherArea(office: string, reportDateTime: string): ParsedWeatherWarning {
    const xml = readFixture(FIXTURE_VPWW56_DOSHA)
      .replaceAll("宗谷地方", "上川地方")
      .replaceAll("011000", "012000");
    const msg = createMockWsDataMessageFromXml(xml, "VPWW56", { publishingOffice: office });
    const parsed = parseWeatherWarning(msg);
    expect(parsed).not.toBeNull();
    return { ...parsed!, reportDateTime };
  }

  it("parser は envelope の publishingOffice を採り、官署ごとに別エントリになる", () => {
    const wakkanai = parseAsOffice(WAKKANAI, T1);
    const asahikawa = parseAsOtherArea(ASAHIKAWA, T1);
    expect(wakkanai.publishingOffice).toBe(WAKKANAI);
    expect(asahikawa.publishingOffice).toBe(ASAHIKAWA);

    const holder = new Vpww56StateHolder();
    holder.update(wakkanai, id(T1, "1"));
    holder.update(asahikawa, id(T1, "1"));
    expect(holder.trackedStreamCount()).toBe(2);
  });

  it("別官署の発表が既存官署の view を消さず、両方の地域が union される", () => {
    const holder = new Vpww56StateHolder();
    holder.update(parseAsOffice(WAKKANAI, T1), id(T1, "1"));
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(1);

    holder.update(parseAsOtherArea(ASAHIKAWA, T2), id(T2, "1"));
    const view = holder.getCurrentAreasForDisplay();
    expect(view?.totalAreas).toBe(2);
    const areaCodes = view?.kinds.flatMap((k) => k.areas.map((a) => a.areaCode)) ?? [];
    expect([...new Set(areaCodes)].sort()).toEqual(["011000", "012000"]);
  });

  it("片方の官署だけが取消されても、もう片方の view は残る", () => {
    const holder = new Vpww56StateHolder();
    holder.update(parseAsOffice(WAKKANAI, T1), id(T1, "1"));
    holder.update(parseAsOtherArea(ASAHIKAWA, T1), id(T1, "1"));
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(2);

    const cancelled: ParsedWeatherWarning = { ...parseAsOffice(WAKKANAI, T1), infoType: "取消" };
    expect(holder.update(cancelled, id(T1, "1"))).toEqual({ kind: "updated" });

    const view = holder.getCurrentAreasForDisplay();
    expect(view?.totalAreas).toBe(1);
    expect(view?.kinds[0].areas).toEqual([{ areaName: "上川地方", areaCode: "012000" }]);
  });

  it("他官署が新しい報を出しても、自官署の続報は古い扱いにならない", () => {
    const holder = new Vpww56StateHolder();
    // 旭川が先に T3 まで進む
    expect(holder.update(parseAsOtherArea(ASAHIKAWA, T3), id(T3, "1"))).toEqual({ kind: "updated" });
    // 稚内は T1 → T2 と自分のペースで進める
    expect(holder.update(parseAsOffice(WAKKANAI, T1), id(T1, "1"))).toEqual({ kind: "updated" });
    expect(holder.update(parseAsOffice(WAKKANAI, T2), id(T2, "2"))).toEqual({ kind: "updated" });
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(2);
  });

  it("将来 VPWW61 が相乗りしても、同一官署の別カテゴリを上書きしない", () => {
    const holder = new Vpww56StateHolder();
    holder.update(parseAsOffice(WAKKANAI, T1), id(T1, "1"));
    const heavyRain: ParsedWeatherWarning = { ...parseAsOtherArea(WAKKANAI, T2), type: "VPWW61" };
    holder.update(heavyRain, id(T2, "1"));

    expect(holder.trackedStreamCount()).toBe(2);
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(2);
  });

  it("同一官署が同じ fixture を出し続けても地域は重複しない", () => {
    const holder = new Vpww56StateHolder();
    holder.update(parseAsOffice(WAKKANAI, T1), id(T1, "1"));
    holder.update(parseAsOffice(WAKKANAI, T2), id(T2, "2"));

    const view = holder.getCurrentAreasForDisplay();
    expect(view?.totalAreas).toBe(1);
    expect(view?.kinds[0].areas).toEqual([{ areaName: "宗谷地方", areaCode: "011000" }]);
  });
});
