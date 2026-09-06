import { describe, expect, it } from "vitest";
import type {
  DisplayWeatherChangeItemV1,
  DisplayWeatherChangeV1,
} from "../protocol";
import {
  buildWeatherEmergencyInput,
  groupWeatherChangeItems,
  selectWeatherChangeItems,
  selectWeatherChangeFitCandidate,
  validateWeatherChange,
  WEATHER_CHANGE_ROW_CAPACITY,
  WEATHER_CHANGE_ROW_CAPACITY_COMPACT,
  weatherChangeFadeDuration,
  weatherChangeLogicalFingerprint,
  weatherChangeLogicalTotal,
  weatherChangeMeasurementIdentity,
  weatherChangeOmittedCount,
  weatherChangeReserveFingerprint,
  weatherChangeRowText,
  weatherChangeSummary,
} from "../weather-panel";
import { deriveEmergencyPanels } from "../derive";
import { initialState, reduce } from "../store";
import { weatherChangeDensityInputForTransport } from "../../preview/fixtures";
import { baseSnapshot, baseState } from "./fixtures";

const GENERATED = "2026-08-13T12:00:00.000Z";

function item(kind: DisplayWeatherChangeItemV1["kind"], index: number): DisplayWeatherChangeItemV1 {
  return {
    areaCode: `${kind}-${index}`,
    areaName: `${kind}${index}`,
    phenomenonKey: `ph-${kind}-${index}`,
    kind,
    before: kind === "added" ? null : {
      kindShortName: "大雨注意報",
      kindCode: "10",
      displaySeverity: "officialL2",
      officialAlertLevel: 2,
    },
    after: kind === "released" ? null : {
      kindShortName: "大雨警報",
      kindCode: "03",
      displaySeverity: "officialL3",
      officialAlertLevel: 3,
    },
  };
}

function change(over: Partial<DisplayWeatherChangeV1> = {}): DisplayWeatherChangeV1 {
  return {
    source: "vpws50",
    changeKey: "boot:1",
    reportDateTime: "2026-08-13T21:00:00+09:00",
    issuedAt: GENERATED,
    expiresAt: "2026-08-13T12:01:00.000Z",
    changes: [item("upgraded", 0)],
    omitted: {},
    ...over,
  };
}

function promotedSnapshot(over: Partial<ReturnType<typeof baseSnapshot>> = {}) {
  return baseSnapshot({
    generatedAt: GENERATED,
    weatherPromotion: {
      vpws50: { level: 5, promotedAt: GENERATED, generation: 1 },
      vpww56: null,
    },
    weatherAlerts: [{
      source: "vpws50",
      label: "気象警報",
      role: "weatherEmergency",
      totalAreas: 1,
      items: [{
        kind: "L5 大雨特別警報",
        displaySeverity: "officialL5",
        rank: "emergency",
        shownAreas: ["東京都"],
        omittedAreaCount: 0,
      }],
      updatedAt: GENERATED,
    }],
    ...over,
  });
}

describe("weatherChange frontend projection", () => {
  it("validates absolute TTL and hides the change when VPWS50 contribution is absent", () => {
    const valid = change();
    const snapshot = promotedSnapshot({ weatherChange: valid });
    expect(validateWeatherChange(snapshot, Date.parse(GENERATED) + 59_999)).not.toBeNull();
    expect(validateWeatherChange(snapshot, Date.parse(GENERATED) + 60_000)).toBeNull();
    expect(buildWeatherEmergencyInput(snapshot, Date.parse(GENERATED) + 1)?.change?.changeKey).toBe("boot:1");

    const onlyVpww56 = baseSnapshot({
      weatherPromotion: { vpws50: null, vpww56: { level: 5, promotedAt: GENERATED, generation: 1 } },
      weatherChange: valid,
      weatherAlerts: [],
    });
    expect(buildWeatherEmergencyInput(onlyVpww56, Date.parse(GENERATED) + 1)?.change).toBeNull();
  });

  it("accepts the exact future/past boundaries and rejects one millisecond outside", () => {
    const generated = Date.parse(GENERATED);
    const boundary = change({
      issuedAt: new Date(generated + 5_000).toISOString(),
      expiresAt: new Date(generated + 65_000).toISOString(),
    });
    expect(validateWeatherChange(promotedSnapshot({ weatherChange: boundary }), generated + 1)).not.toBeNull();

    const pastBoundary = change({
      issuedAt: new Date(generated - 59_999).toISOString(),
      expiresAt: new Date(generated + 1).toISOString(),
    });
    expect(validateWeatherChange(promotedSnapshot({ weatherChange: pastBoundary }), generated)).not.toBeNull();

    const tooFuture = change({
      issuedAt: new Date(generated + 5_001).toISOString(),
      expiresAt: new Date(generated + 65_001).toISOString(),
    });
    expect(validateWeatherChange(promotedSnapshot({ weatherChange: tooFuture }), generated + 1)).toBeNull();

    const tooPast = change({
      issuedAt: new Date(generated - 60_000).toISOString(),
      expiresAt: GENERATED,
    });
    expect(validateWeatherChange(promotedSnapshot({ weatherChange: tooPast }), generated)).toBeNull();
  });

  it("suppresses code-only kindChanged and reserves upgraded/released in compact selection", () => {
    const codeOnly = item("kindChanged", 0);
    codeOnly.before = { ...codeOnly.before!, kindShortName: "大雨" };
    codeOnly.after = { ...codeOnly.after!, kindShortName: "大雨" };
    const selected = selectWeatherChangeItems(change({
      changes: [
        item("upgraded", 0), item("upgraded", 1), item("added", 0),
        codeOnly, item("downgraded", 0), item("released", 0),
      ],
      omitted: { upgraded: 2 },
    }), 2);
    expect(selected.items.map((entry) => entry.kind)).toEqual(["upgraded", "released"]);
    expect(selected.totals.kindChanged).toBe(0);
    expect(weatherChangeSummary(selected)).toContain("追加");
    expect(weatherChangeSummary(selected)).toContain("悪化");
  });

  it("2026-08-27 観測に基づく幅利用と測定式上限として normal 12 / compact 4 を使う", () => {
    expect(WEATHER_CHANGE_ROW_CAPACITY).toBe(12);
    expect(WEATHER_CHANGE_ROW_CAPACITY_COMPACT).toBe(4);
    const changes = [
      ...Array.from({ length: 4 }, (_, index) => item("upgraded", index)),
      ...Array.from({ length: 3 }, (_, index) => item("added", index)),
      ...Array.from({ length: 2 }, (_, index) => item("kindChanged", index)),
      ...Array.from({ length: 2 }, (_, index) => item("downgraded", index)),
      ...Array.from({ length: 2 }, (_, index) => item("released", index)),
    ];
    const normal = selectWeatherChangeItems(change({ changes }), WEATHER_CHANGE_ROW_CAPACITY);
    const compact = selectWeatherChangeItems(change({ changes }), WEATHER_CHANGE_ROW_CAPACITY_COMPACT);
    expect(normal.items).toHaveLength(12);
    expect(compact.items).toHaveLength(4);
    expect(compact.items.map((entry) => entry.kind)).toContain("upgraded");
    expect(compact.items.map((entry) => entry.kind)).toContain("released");
    expect(weatherChangeLogicalTotal(normal)).toBe(13);
    expect(weatherChangeOmittedCount(normal)).toBe(1);
  });

  it("五区分を既定順に group 化し、chip 文言では区分語を反復しない", () => {
    const selection = selectWeatherChangeItems(change({
      changes: [
        item("released", 0), item("downgraded", 0), item("kindChanged", 0),
        item("added", 0), item("upgraded", 0),
      ],
    }), 5);
    expect(groupWeatherChangeItems(selection).map((group) => group.kind)).toEqual([
      "upgraded", "added", "kindChanged", "downgraded", "released",
    ]);
    expect(weatherChangeRowText(item("added", 0))).toBe("added0　L3 大雨警報");
    expect(weatherChangeRowText(item("released", 0))).toBe("released0　L2 大雨注意報");
    expect(weatherChangeRowText(item("upgraded", 0)))
      .toBe("upgraded0　L2 大雨注意報 → L3 大雨警報");
    expect(weatherChangeSummary(selection)).toBe("悪化 1件・追加 1件・種別変更 1件・緩和 1件・解除 1件");
    const sparse = selectWeatherChangeItems(change({ changes: [item("added", 0), item("released", 0)] }), 2);
    expect(groupWeatherChangeItems(sparse).map((group) => group.kind)).toEqual(["added", "released"]);
  });

  it("同一 batch の border-box 高から budget 内の最大候補を選び、summary-only 不可能を unresolved にする", () => {
    const heights = new Map(Array.from({ length: 5 }, (_, candidate) => [candidate, 80 + candidate * 20]));
    expect(selectWeatherChangeFitCandidate({ budget: 145, candidateHeights: heights, limit: 4 }))
      .toEqual({ selected: 3, unresolved: false });
    expect(selectWeatherChangeFitCandidate({
      budget: 479.875,
      candidateHeights: new Map([[7, 480], [6, 460]]),
      limit: 7,
    })).toEqual({ selected: 6, unresolved: false });
    expect(selectWeatherChangeFitCandidate({ budget: 70, candidateHeights: heights, limit: 4 }))
      .toEqual({ selected: 0, unresolved: true });
    expect(selectWeatherChangeFitCandidate({ budget: -1, candidateHeights: heights, limit: 4 }))
      .toEqual({ selected: 0, unresolved: true });
    expect(selectWeatherChangeFitCandidate({ budget: 145, candidateHeights: new Map([[0, 80]]), limit: 4 }))
      .toBeNull();
  });

  it("measurement identity は全契約 field の変更で cache key を変える", () => {
    const base = {
      changeKey: "c1", activationKey: "a1", compact: false,
      panelWidth: 800, panelHeight: 600, budget: 180, reserveHeight: 420,
      reserveFingerprint: "reserve", changeFingerprint: "change", fontEpoch: 1, settlingEpoch: 1,
    };
    const key = weatherChangeMeasurementIdentity(base);
    for (const variant of [
      { ...base, changeKey: "c2" }, { ...base, activationKey: "a2" }, { ...base, compact: true },
      { ...base, panelWidth: 801 }, { ...base, panelHeight: 601 }, { ...base, budget: 181 },
      { ...base, reserveHeight: 421 }, { ...base, reserveFingerprint: "reserve2" },
      { ...base, changeFingerprint: "change2" }, { ...base, fontEpoch: 2 }, { ...base, settlingEpoch: 2 },
    ]) expect(weatherChangeMeasurementIdentity(variant)).not.toBe(key);
  });

  it("reserve fingerprint は同型 shell の各生成元 field と全 base content を網羅する", () => {
    const base = {
      level: 5 as const,
      headingLabel: "大雨特別警報",
      triggerLabel: "更新発表",
      updatedAt: GENERATED,
      restored: false,
      compact: false,
      actionMode: "tile" as const,
      actionLabel: "命の危険 直ちに安全確保",
      alertNames: ["大雨特別警報"],
      subSectionPresent: true,
      subKinds: ["大雨警報"],
      subAddedKinds: ["大雨警報"],
      subAddedCount: 1,
      hiddenSubKindCount: 0,
      baseContentFingerprint: "weather-area-content-v1:all-fragments",
    };
    const fingerprint = weatherChangeReserveFingerprint(base);
    for (const variant of [
      { ...base, level: 4 as const },
      { ...base, headingLabel: "気象警報" },
      { ...base, triggerLabel: "新規発表" },
      { ...base, updatedAt: "2026-08-13T12:00:01.000Z" },
      { ...base, restored: true },
      { ...base, compact: true },
      { ...base, actionMode: "inline" as const },
      { ...base, actionLabel: "危険な場所にいる人は全員避難" },
      { ...base, alertNames: ["暴風特別警報"] },
      { ...base, subSectionPresent: false },
      { ...base, subKinds: ["洪水警報"] },
      { ...base, subAddedKinds: [] },
      { ...base, subAddedCount: 2 },
      { ...base, hiddenSubKindCount: 1 },
      { ...base, baseContentFingerprint: "weather-area-content-v1:changed-fragment" },
    ]) expect(weatherChangeReserveFingerprint(variant)).not.toBe(fingerprint);
  });

  it("change fingerprint は各 area・kind・severity 値と区分総数を網羅する", () => {
    const original = change();
    const fingerprintOf = (candidate: DisplayWeatherChangeV1): string =>
      weatherChangeLogicalFingerprint(candidate, selectWeatherChangeItems(candidate, Number.MAX_SAFE_INTEGER));
    const fingerprint = fingerprintOf(original);
    const originalItem = original.changes[0];
    const withItem = (next: DisplayWeatherChangeItemV1): DisplayWeatherChangeV1 => ({
      ...original,
      changes: [next],
    });
    const before = originalItem.before!;
    const after = originalItem.after!;
    for (const variant of [
      { ...original, changeKey: "boot:2" },
      { ...original, omitted: { upgraded: 1 } },
      withItem({ ...originalItem, areaName: "別地域" }),
      withItem({ ...originalItem, areaCode: "9999999" }),
      withItem({ ...originalItem, phenomenonKey: "別現象" }),
      withItem({ ...originalItem, kind: "downgraded" }),
      withItem({ ...originalItem, before: { ...before, kindShortName: "洪水注意報" } }),
      withItem({ ...originalItem, before: { ...before, kindCode: "11" } }),
      withItem({ ...originalItem, before: { ...before, displaySeverity: "nonLevelAdvisory" } }),
      withItem({ ...originalItem, before: { ...before, officialAlertLevel: 1 } }),
      withItem({ ...originalItem, after: { ...after, kindShortName: "洪水警報" } }),
      withItem({ ...originalItem, after: { ...after, kindCode: "04" } }),
      withItem({ ...originalItem, after: { ...after, displaySeverity: "nonLevelWarning" } }),
      withItem({ ...originalItem, after: { ...after, officialAlertLevel: 4 } }),
    ]) expect(fingerprintOf(variant)).not.toBe(fingerprint);
  });

  it.each([
    ["full", 13, 0], ["degraded-12", 12, 1], ["degraded-4", 4, 9], ["degraded-2", 2, 11],
  ] as const)("%s capture input は wire changes + omitted = 13 を実 DTO で保つ", (mode, changes, omitted) => {
    const input = weatherChangeDensityInputForTransport(mode);
    expect(input.change?.changes).toHaveLength(changes);
    expect(Object.values(input.change?.omitted ?? {}).reduce((sum, count) => sum + (count ?? 0), 0)).toBe(omitted);
  });

  it("null capture input は更新欄 DTO 自体を持たない", () => {
    expect(weatherChangeDensityInputForTransport("null").change).toBeNull();
  });

  it("reduced-motion では change 差し替え fade を 0ms にする", () => {
    expect(weatherChangeFadeDuration(true)).toBe(0);
    expect(weatherChangeFadeDuration(false)).toBeGreaterThan(0);
  });

  it("snapshot を更新せず clock だけ進めると change だけが消え、現況 panel は残る", () => {
    const state = baseState(promotedSnapshot({ weatherChange: change() }));
    const before = deriveEmergencyPanels(state, Date.parse(GENERATED) + 59_999);
    const after = deriveEmergencyPanels(state, Date.parse(GENERATED) + 60_000);
    expect(before).toHaveLength(1);
    expect(before[0]?.input.kind === "weather" ? before[0].input.change?.changeKey : null).toBe("boot:1");
    expect(after).toHaveLength(1);
    expect(after[0]?.input.kind === "weather" ? after[0].input.change : undefined).toBeNull();
  });

  it("reconnect の full snapshot 置換で欠落 weatherChange を前 snapshot から引き継がない", () => {
    const first = reduce(initialState(), {
      type: "snapshot",
      snapshot: promotedSnapshot({ weatherChange: change(), seq: 10 }),
    });
    const [firstPanel] = deriveEmergencyPanels(first, Date.parse(GENERATED) + 1);
    expect(firstPanel?.input.kind === "weather" ? firstPanel.input.change?.changeKey : null).toBe("boot:1");

    const reconnected = reduce(first, {
      type: "snapshot",
      snapshot: promotedSnapshot({ seq: 0 }), // 旧 server 相当: field 欠落、seq 巻戻り
    });
    const [panel] = deriveEmergencyPanels(reconnected, Date.parse(GENERATED) + 1);
    expect(panel?.input.kind === "weather" ? panel.input.change : undefined).toBeNull();
  });

  it.each([
    ["added", item("added", 0).after, null],
    ["added", null, null],
    ["released", null, null],
    ["released", null, item("released", 0).before],
    ["upgraded", null, item("upgraded", 0).after],
    ["downgraded", item("downgraded", 0).before, null],
    ["kindChanged", null, item("kindChanged", 0).after],
  ] as const)("%s の before/after 意味制約違反を fail-closed に隠す", (kind, before, after) => {
    const malformed = item(kind, 0);
    malformed.before = before;
    malformed.after = after;
    expect(validateWeatherChange(
      promotedSnapshot({ weatherChange: change({ changes: [malformed] }) }),
      Date.parse(GENERATED) + 1,
    )).toBeNull();
  });

  it("同じ areaCode と phenomenonKey の重複 item を DTO 全体ごと隠す", () => {
    const first = item("upgraded", 0);
    const duplicate = { ...item("released", 1), areaCode: first.areaCode, phenomenonKey: first.phenomenonKey };
    expect(validateWeatherChange(
      promotedSnapshot({ weatherChange: change({ changes: [first, duplicate] }) }),
      Date.parse(GENERATED) + 1,
    )).toBeNull();
  });
});
