import { describe, expect, it, vi } from "vitest";
import {
  attachWeatherExpandedKinds,
  collectWeatherExpandedKinds,
  resolveWeatherKindKeys,
} from "../../../src/engine/display/weather-expanded-kinds";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import type {
  DisplayWeatherAlertItemV1,
  DisplayWeatherAlertV1,
} from "../../../src/engine/display/types";

const T0 = Date.parse("2026-08-20T12:00:00.000Z");

function item(
  kind: string,
  areas: readonly string[],
  over: Partial<DisplayWeatherAlertItemV1> = {},
): DisplayWeatherAlertItemV1 {
  return {
    kind,
    displaySeverity: "officialL5",
    phenomenonKey: kind,
    rank: "emergency",
    shownAreas: [...areas],
    omittedAreaCount: 0,
    ...over,
  };
}

function alert(
  source: DisplayWeatherAlertV1["source"],
  items: DisplayWeatherAlertItemV1[],
): DisplayWeatherAlertV1 {
  return {
    source,
    label: "気象特別警報",
    role: "weatherEmergency",
    totalAreas: items.reduce((total, value) => total + value.shownAreas.length, 0),
    items,
    updatedAt: new Date(T0).toISOString(),
  };
}

describe("weather expanded kind wire supply", () => {
  it("同一 kind を複数 source から union し、発表順と重複排除を保つ", () => {
    const result = collectWeatherExpandedKinds([
      alert("vpws50", [item("大雨", ["A", "B", "C"])]),
      alert("vpww56", [item("大雨", ["C", "D"])]),
    ]);

    expect(result).toEqual([{
      kindKey: "officialL5|大雨",
      areas: ["A", "B", "C", "D"],
      totalAreaCount: 4,
      candidateTruncated: false,
    }]);
  });

  it("地域名と Area.Code を対で source 横断集約し、同名でも別コードなら保持する", () => {
    const result = collectWeatherExpandedKinds([
      alert("vpws50", [item("大雨", ["府中市"], { shownAreaCodes: ["1320600"] })]),
      alert("vpww56", [item("大雨", ["府中市", "宮崎市"], { shownAreaCodes: ["3420600", "4520100"] })]),
    ]);

    expect(result).toEqual([{
      kindKey: "officialL5|大雨",
      areas: ["府中市", "府中市", "宮崎市"],
      areaCodes: ["1320600", "3420600", "4520100"],
      totalAreaCount: 3,
      candidateTruncated: false,
    }]);
  });

  it("複数 rank の alert は emergency を先頭に、warning 候補も併存して供給する", () => {
    const warning = {
      ...alert("vpws50", [item("大雨", ["警報級"], { displaySeverity: "officialL4", rank: "warning" })]),
      label: "気象警報",
      role: "weatherWarning" as const,
    };
    const emergency = alert("vpww56", [item("大雨", ["特別警報級"])]);

    expect(collectWeatherExpandedKinds([warning, emergency])).toEqual([
      { kindKey: "officialL5|大雨", areas: ["特別警報級"], totalAreaCount: 1, candidateTruncated: false },
      { kindKey: "officialL4|大雨", areas: ["警報級"], totalAreaCount: 1, candidateTruncated: false },
    ]);
  });

  it.each([
    [127, 127, false],
    [128, 128, false],
    [129, 128, true],
  ] as const)("安全弁 %i 件は %i 件を供給し、truncated=%s", (total, supplied, truncated) => {
    const result = collectWeatherExpandedKinds([
      alert("vpws50", [item("大雨", Array.from({ length: total }, (_, i) => `地域${i}`))]),
    ]);

    expect(result[0]).toMatchObject({
      areas: Array.from({ length: supplied }, (_, i) => `地域${i}`),
      totalAreaCount: total,
      candidateTruncated: truncated,
    });
  });

  it("現行表示合計が128を超える不変条件外入力は全体上限で後続 kind を切る", () => {
    const result = collectWeatherExpandedKinds([
      alert("vpws50", [
        item("先行", Array.from({ length: 127 }, (_, i) => `先行${i}`)),
        item("後続", ["後続0", "後続1", "後続2"]),
      ]),
    ]);

    expect(result).toEqual([
      {
        kindKey: "officialL5|先行",
        areas: Array.from({ length: 127 }, (_, i) => `先行${i}`),
        totalAreaCount: 127,
        candidateTruncated: false,
      },
      {
        kindKey: "officialL5|後続",
        areas: ["後続0"],
        totalAreaCount: 3,
        candidateTruncated: true,
      },
    ]);
    expect(result.reduce((total, kind) => total + kind.areas.length, 0)).toBe(128);
  });

  it("供給側 metadata を一度だけ計算し、snapshot owner が候補と flag を wire へ複製する", () => {
    const alerts = [alert("vpws50", [item("大雨", ["A", "B"])]),];
    const provider = vi.fn(() => attachWeatherExpandedKinds(alerts.map((value) => ({
      ...value,
      items: value.items.map((entry) => ({ ...entry, shownAreas: [...entry.shownAreas] })),
    }))));
    const store = new DisplayStateStore(undefined, undefined, undefined, undefined, provider);

    const snapshot = store.snapshot(1, T0);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(snapshot.weatherExpandedKinds).toEqual([{
      kindKey: "officialL5|大雨",
      areas: ["A", "B"],
      totalAreaCount: 2,
      candidateTruncated: false,
    }]);

    const jsonRoundTrip = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    expect(jsonRoundTrip.weatherExpandedKinds).toEqual(snapshot.weatherExpandedKinds);
  });

  it("snapshot の areaCodes は供給側 metadata と独立に複製する", () => {
    const supplied = attachWeatherExpandedKinds([
      alert("vpws50", [item("大雨", ["宮崎市"], { shownAreaCodes: ["4520100"] })]),
    ]);
    const store = new DisplayStateStore(undefined, undefined, undefined, undefined, () => supplied);
    const snapshot = store.snapshot(1, T0);
    snapshot.weatherExpandedKinds![0]!.areaCodes![0] = "破壊的変更";

    expect(store.snapshot(1, T0).weatherExpandedKinds).toMatchObject([{
      areas: ["宮崎市"], areaCodes: ["4520100"],
    }]);
  });

  it("StandbyStateStore.snapshotWeatherAlerts が source 横断候補を一度の供給値へ添付する", () => {
    const standby = new StandbyStateStore();
    const alerts = [alert("vpws50", [item("大雨", ["A", "B"])])];
    standby.applyWeatherAlerts("vpws50", alerts, new Date(T0).toISOString(), "1", T0);

    const supplied = standby.snapshotWeatherAlerts();
    const store = new DisplayStateStore(undefined, undefined, undefined, undefined, () => supplied);
    expect(store.snapshot(1, T0).weatherExpandedKinds).toEqual([{
      kindKey: "officialL5|大雨",
      areas: ["A", "B"],
      totalAreaCount: 2,
      candidateTruncated: false,
    }]);
  });

  it("旧 item の alias 解決は phenomenonKey の候補が一つのときだけ統合する", () => {
    expect(resolveWeatherKindKeys([
      { displaySeverity: "officialL4", kind: "大雨", phenomenonKey: "heavy-rain" },
      { displaySeverity: "officialL4", kind: "大雨" },
      { displaySeverity: "officialL4", kind: "洪水" },
      { displaySeverity: "officialL4", kind: "洪水", phenomenonKey: "flood" },
      { displaySeverity: "officialL4", kind: "洪水", phenomenonKey: "river-flood" },
    ])).toEqual([
      "officialL4|heavy-rain",
      "officialL4|heavy-rain",
      "officialL4|洪水",
      "officialL4|flood",
      "officialL4|river-flood",
    ]);
  });
});
