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
  VPWW56_DORMANT_RETENTION_MS,
  VPWW56_MAX_DORMANT_OFFICES,
} from "../../../src/engine/messages/vpww56-state";
import type { ParsedWeatherWarning, WeatherKind, WeatherItem } from "../../../src/types";
import type { WeatherReportIdentity } from "../../../src/engine/messages/vpws50-state";

/**
 * VPWW56 は府県予報区ごとに別の地方気象台が発表する。この holder は発表官署単位で
 * view を保持し、参照時に union する契約なので、その契約 (別官署の続報が既存官署の
 * 警報を消さない / 単調性ガードが官署ごとに独立 / 解除官署の掃除) をここで固定する。
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

  it("単調性ガードは官署ごとに独立し、他官署の新しい報で古く見なされない", () => {
    const holder = new Vpww56StateHolder();
    // 旭川が先に T3 まで進んでも、稚内の T1→T2 の続報は受理される
    expect(holder.update(report(ASAHIKAWA, T3, [item("012000", "上川地方", [L4_LANDSLIDE])]), id(T3, "1")))
      .toEqual({ kind: "updated" });
    expect(holder.update(report(WAKKANAI, T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1")))
      .toEqual({ kind: "updated" });
    expect(holder.update(report(WAKKANAI, T2, [item("011000", "宗谷地方", [L3_LANDSLIDE])]), id(T2, "2")))
      .toEqual({ kind: "updated" });

    // 稚内自身の古い報は棄却される
    expect(holder.update(report(WAKKANAI, T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1")))
      .toEqual({ kind: "suppressed" });

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

  it("view を持たない官署は retention window を過ぎたら掃除される", () => {
    const holder = new Vpww56StateHolder();
    holder.update(report(WAKKANAI, T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1"));
    holder.update(report(WAKKANAI, T1, [], { infoType: "取消" }), id(T1, "1"));
    expect(holder.trackedOfficeCount()).toBe(1);

    // retention window 内の他官署電文では掃除されない
    const withinWindow = new Date(Date.parse(T1) + VPWW56_DORMANT_RETENTION_MS - 1000).toISOString();
    holder.update(report(ASAHIKAWA, withinWindow, [item("012000", "上川地方", [L4_LANDSLIDE])]), id(withinWindow, "1"));
    expect(holder.trackedOfficeCount()).toBe(2);

    // window を越えた電文で稚内の dormant エントリが消える
    const pastWindow = new Date(Date.parse(T1) + VPWW56_DORMANT_RETENTION_MS + 1000).toISOString();
    holder.update(report(ASAHIKAWA, pastWindow, [item("012000", "上川地方", [L4_LANDSLIDE])]), id(pastWindow, "2"));
    expect(holder.trackedOfficeCount()).toBe(1);
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(1);
  });

  it("発表中の官署は retention window を過ぎても掃除されない", () => {
    const holder = new Vpww56StateHolder();
    holder.update(report(WAKKANAI, T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1"));

    const pastWindow = new Date(Date.parse(T1) + VPWW56_DORMANT_RETENTION_MS * 3).toISOString();
    holder.update(report(ASAHIKAWA, pastWindow, [item("012000", "上川地方", [L4_LANDSLIDE])]), id(pastWindow, "1"));

    expect(holder.trackedOfficeCount()).toBe(2);
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(2);
  });

  it("dormant 官署が上限を超えたら古い順に捨て、エントリが無限に溜まらない", () => {
    const holder = new Vpww56StateHolder();
    const total = VPWW56_MAX_DORMANT_OFFICES + 20;
    for (let i = 0; i < total; i++) {
      // 全て同一 window 内 (retention では消えない) の別官署 → 発表直後に取消
      const at = new Date(Date.parse(T1) + i * 1000).toISOString();
      const office = `office-${i}`;
      holder.update(report(office, at, [item(`0${i}0000`, `area-${i}`, [L4_LANDSLIDE])]), id(at, "1"));
      holder.update(report(office, at, [], { infoType: "取消" }), id(at, "1"));
    }
    expect(holder.trackedOfficeCount()).toBe(VPWW56_MAX_DORMANT_OFFICES);
    expect(holder.getCurrentAreasForDisplay()).toBeUndefined();
  });

  it("官署名が空の電文も 1 系統として扱い、他官署と union される", () => {
    const holder = new Vpww56StateHolder();
    holder.update(report("", T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1"));
    holder.update(report(ASAHIKAWA, T1, [item("012000", "上川地方", [L4_LANDSLIDE])]), id(T1, "1"));

    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(2);
    // 空官署でも単調性ガードは効く
    expect(holder.update(report("", T1, [item("011000", "宗谷地方", [L4_LANDSLIDE])]), id(T1, "1")))
      .toEqual({ kind: "suppressed" });
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
    expect(holder.trackedOfficeCount()).toBe(2);
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
    // 稚内自身の古い報だけは棄却される
    expect(holder.update(parseAsOffice(WAKKANAI, T1), id(T1, "1"))).toEqual({ kind: "suppressed" });

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
