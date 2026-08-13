import { describe, expect, it } from "vitest";
import type {
  DisplayWeatherChangeItemV1,
  DisplayWeatherChangeV1,
} from "../protocol";
import {
  buildWeatherEmergencyInput,
  selectWeatherChangeItems,
  validateWeatherChange,
  weatherChangeFadeDuration,
  weatherChangeSummary,
} from "../weather-panel";
import { deriveEmergencyPanels } from "../derive";
import { initialState, reduce } from "../store";
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
