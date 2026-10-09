import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import type { TsunamiAreaClass, TsunamiForecastArea, TsunamiForecastSubject } from "../../contracts/p3-tsunami-unit.types";
import { canonicalCoastJson, COAST_SEGMENTS } from "../../src/display/chrome-eew/coast";
import { buildTsunamiPaint, eewContentChanged, parseDisplaySnapshot, tsunamiCandidates, tsunamiContentChanged } from "../../src/display/chrome-eew/pure";
import { parseChromeMarkerDetail } from "../../src/measurement/eew-e01/frozen";

const repo = join(__dirname, "../../..");
const area = (code: string, areaClass: TsunamiAreaClass): TsunamiForecastArea => ({ code, name: `区域${code}`, areaClass, kindCode: "00", kindName: areaClass,
  firstHeight: { arrivalTimeRaw: null, condition: null }, maxHeight: null });
const forecast = (eventId: string, areas: readonly TsunamiForecastArea[]): TsunamiForecastSubject => ({
  subject: `normal/VTSE41/${eventId}`, eventId, operation: "normal",
  source: { inputId: "i", origin: "replay", operation: "normal", family: "VTSE41", subject: `normal/VTSE41/${eventId}`, reportDateTimeRaw: "2026-01-01T12:00:00+09:00",
    serialRaw: "", infoTypeRaw: "発表" },
  effective: "active", areas, unkeyedAreas: [], retainUntil: null,
});

function snapshot(forecasts: readonly TsunamiForecastSubject[], tsunamiRevision = "1", eewRevision = "0", sequence = 1): DisplaySnapshot {
  const item = (operation: "normal" | "training" | "test") => ({ operation, informationType: "tsunami" as const, activeCount: 0, highestSeverity: null, areaCounts: {},
    updatedAt: null, admission: {}, unavailable: {}, unconfirmed: {}, unknownCode: {}, freshness: {}, confirmation: { state: "unconfirmed" as const, confirmedAt: null } });
  const items = [item("normal"), item("training"), item("test")] as const;
  const summary = { contentRevision: eewRevision, items, delivery: "summary" as const, reason: "snapshotBudget" as const, originalBytes: 0, budgetBytes: 0 };
  return {
    schemaVersion: 1, streamId: "s", sequence, generatedAt: "2026-01-01T03:00:00.000Z", semanticRevision: "0",
    connection: { state: "connected", disconnectedAt: null, lastInputAt: null },
    worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null },
    persistence: {}, recovery: { "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" }, "U-T": { kind: "empty" },
      "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } },
    channels: { desktop: "available", sound: "available" },
    current: { eew: { unit: "U-E", ...summary }, weatherCurrent: { unit: "U-W", ...summary }, weatherTimeseries: { unit: "U-F", ...summary },
      tsunami: { unit: "U-T", contentRevision: tsunamiRevision, items, delivery: "full",
        view: { unit: "U-T", semanticRevision: "", contentRevision: tsunamiRevision, admission: {}, subjects: [], forecasts, observations: [] } },
      earthquake: { unit: "U-Q", ...summary },
      nankai: { unit: "U-N", ...summary }, volcano: { unit: "U-V", ...summary } },
    notices: [],
  };
}

// P3-C6-T03 contractBoundary (AC03・AC04): DOM に依存しない描画指示・T6 候補・境界検証。実描画と画素は smoke（T04）で見る。
describe("P3-C6-T03 tsunami paint instructions, candidates and the snapshot boundary", () => {
  it("paints only majorWarning・warning・unknown・advisory from the fixed class table, merges a code to its highest class across subjects, blinks only majorWarning and counts codes outside the asset", () => {
    const a = forecast("1", [area("311", "majorWarning"), area("312", "forecast"), area("100", "released"), area("110", "warning")]);
    const b = forecast("2", [area("311", "warning"), area("312", "advisory"), area("101", "unknown"), area("102", "none")]);
    const paint = buildTsunamiPaint([a, b]);
    expect(paint.segments.map((s) => [s.code, s.className, s.blink])).toEqual([["311", "tsu-major", true], ["312", "tsu-advisory", false], ["101", "tsu-warning", false]]);
    expect(paint.missingCoastCount).toBe(1);
    expect(paint.areasBySubject.get(a.subject)).toEqual([{ code: "311", areaClass: "majorWarning" }]);
    expect(paint.areasBySubject.get(b.subject)).toEqual([{ code: "101", areaClass: "unknown" }, { code: "311", areaClass: "majorWarning" }, { code: "312", areaClass: "advisory" }]);
    expect(paint.cards.map((c) => c.className)).toEqual(["tsu-major", "tsu-warning"]);
  });

  it("an area without Area/Code (C5's unkeyedAreas) counts for the highest class and the row colour, and is not painted on the coast", () => {
    const unkeyed = { ...forecast("3", []), unkeyedAreas: [{ name: "コードなしの区域", kindCode: "52", kindName: "大津波警報" }] };
    const mixed = { ...forecast("4", [area("311", "advisory")]), unkeyedAreas: [{ name: "コードなしの区域", kindCode: "52", kindName: "大津波警報" }] };
    const paint = buildTsunamiPaint([unkeyed, mixed]);
    expect(paint.cards.map((c) => [c.head.endsWith("大津波警報"), c.className])).toEqual([[true, "tsu-major"], [true, "tsu-major"]]);
    expect(paint.cards[1]!.areas.map((a) => a.className)).toEqual(["tsu-row tsu-advisory", "tsu-row tsu-major"]);
    expect(paint.segments.map((s) => [s.code, s.className])).toEqual([["311", "tsu-advisory"]]);
  });

  it("a subject drawn before and out of view now gets one present false candidate with empty areas; the drawn subjects get present true", () => {
    const a = forecast("1", [area("311", "warning")]);
    const { details, drawn } = tsunamiCandidates(snapshot([a]), new Set([a.subject, "normal/VTSE41/9"]));
    expect(details.map((d) => [d.subject, d.present, d.areas])).toEqual([[a.subject, true, [{ code: "311", areaClass: "warning" }]], ["normal/VTSE41/9", false, []]]);
    expect([...drawn]).toEqual([a.subject]);
  });

  it("rejects a snapshot without current.tsunami, with another unit, with two items or with a malformed area; redraws only the domain whose contentRevision changed", () => {
    const valid = snapshot([forecast("1", [area("311", "warning")])]);
    expect(parseDisplaySnapshot(JSON.stringify(valid))).not.toBeNull();
    const patch = (tsunami: unknown) => JSON.stringify({ ...valid, current: { ...valid.current, tsunami } });
    const t = valid.current.tsunami;
    expect(parseDisplaySnapshot(patch(undefined))).toBeNull();
    expect(parseDisplaySnapshot(patch({ ...t, unit: "U-E" }))).toBeNull();
    expect(parseDisplaySnapshot(patch({ ...t, items: t.items.slice(0, 2) }))).toBeNull();
    const view = t.delivery === "full" ? t.view : null;
    expect(parseDisplaySnapshot(patch({ ...t, view: { ...view, forecasts: [{ ...view!.forecasts[0], areas: [{ ...area("311", "warning"), code: 311 }] }] } }))).toBeNull();
    expect(parseDisplaySnapshot(patch({ ...t, view: { ...view, forecasts: [{ ...view!.forecasts[0], areas: [{ ...area("311", "warning"), areaClass: "red" }] }] } }))).toBeNull();
    // 区域コードの無い区域は kindCode が文字列でなければ受けない（描画で区分を引くので、欠落や文字列でない値で TypeError にしない、AC03(7)）。
    const unkeyed = (kindCode: unknown) => patch({ ...t, view: { ...view, forecasts: [{ ...view!.forecasts[0], unkeyedAreas: [{ name: "n", kindName: "k", kindCode }] }] } });
    expect([parseDisplaySnapshot(unkeyed("99")) != null, parseDisplaySnapshot(unkeyed(undefined)), parseDisplaySnapshot(unkeyed({ toString: null, valueOf: null }))])
      .toEqual([true, null, null]);
    expect(tsunamiContentChanged(valid, snapshot(view!.forecasts, "2"))).toBe(true);
    expect(eewContentChanged(valid, snapshot(view!.forecasts, "2"))).toBe(false);
    expect(tsunamiContentChanged(valid, snapshot(view!.forecasts, "1", "9"))).toBe(false);
    expect(eewContentChanged(valid, snapshot(view!.forecasts, "1", "9"))).toBe(true);
  });

  it("parseChromeMarkerDetail accepts the tsunami candidate and refuses a wrong area class, an extra area key or a present false candidate with areas", () => {
    const dv = { streamId: "s", semanticRevision: "1", sequence: 1 };
    const detail = { name: "fleq:p3:tsunami:T6-candidate", displayVersion: dv, operation: "normal", subject: "normal/VTSE41/1", present: true,
      cardMarkerId: "tsunami-card:x", coastMarkerId: "coast:x", areas: [{ code: "311", areaClass: "majorWarning" }] };
    expect(parseChromeMarkerDetail(detail)).toEqual(detail);
    expect(parseChromeMarkerDetail({ ...detail, areas: [{ code: "311", areaClass: "red" }] })).toBeNull();
    expect(parseChromeMarkerDetail({ ...detail, areas: [{ code: "311", areaClass: "warning", extra: 1 }] })).toBeNull();
    expect(parseChromeMarkerDetail({ ...detail, present: false })).toBeNull();
    expect(parseChromeMarkerDetail({ ...detail, present: false, areas: [] })).not.toBeNull();
  });
});

// P3-C6-T05 contractBoundary (AC05・AC07): 最小海岸線資材の canonical JSON と hash、code の和集合。
describe("P3-C6-T05 minimal coast asset", () => {
  it("the canonical JSON sha256 equals the C6 smoke conditions and the manifest draft; 51 codes are the union of the inputs, distinct and not overlapping", () => {
    const json = canonicalCoastJson();
    const sha = createHash("sha256").update(json).digest("hex");
    const smoke = JSON.parse(readFileSync(join(repo, "reconstruction/test/eew-e01/evidence/p3-tsunami/chrome-smoke-conditions.json"), "utf8"));
    const draft = JSON.parse(readFileSync(join(repo, "reconstruction/test/eew-e01/evidence/p3-tsunami/manifest.draft.json"), "utf8"));
    expect([smoke.coastSha256, draft.coastSha256]).toEqual([sha, sha]);
    expect(JSON.parse(json).provenance).toMatchObject({ expectedCodeCount: 51, retrievedAt: null, sourceArchiveSha256: null });
    const codesOf = (name: string) => {
      const forecastXml = /<Forecast>([\s\S]*?)<\/Forecast>/.exec(readFileSync(join(repo, `test/fixtures/${name}.xml`), "utf8"))![1]!;
      return [...forecastXml.matchAll(/<Area>\s*<Name>[^<]*<\/Name>\s*<Code>(\d+)<\/Code>/g)].map((m) => m[1]!);
    };
    const union = new Set(["311", "312", ...["32-39_11_02_250206_VTSE41", "32-39_11_09_250206_VTSE41", "32-39_11_11_250206_VTSE41"].flatMap(codesOf)]);
    const codes = COAST_SEGMENTS.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual([...union].sort());
    expect(codes).toHaveLength(51);
    const inside = COAST_SEGMENTS.every(({ rect: [x, y, w, h] }) => x >= 0 && y >= 0 && x + w <= 300 && y + h <= 272);
    const overlap = COAST_SEGMENTS.some((a, i) => COAST_SEGMENTS.some((b, j) => i < j && a.rect[0] < b.rect[0] + b.rect[2] && b.rect[0] < a.rect[0] + a.rect[2]
      && a.rect[1] < b.rect[1] + b.rect[3] && b.rect[1] < a.rect[1] + a.rect[3]));
    expect([inside, overlap]).toEqual([true, false]);
  });
});
