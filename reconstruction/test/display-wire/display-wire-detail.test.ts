import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";

import type { ExecutionPlace } from "../../contracts/p3-execution-split.types";
import type { TsunamiObservationSubject } from "../../contracts/p3-tsunami-unit.types";
import type { WireDetailRequest } from "../../contracts/p4-display-wire.types";
import { startDisplayServer } from "../../src/http-sse/http-sse";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { detailOwner, receiveOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import type { OwnerState } from "../../src/runtime/owner-runtime";
import { classifyHeadType, executionPlaces, placeOfHeadType, runtimeUnits } from "../../src/runtime/unit-coverage";
import manifest from "../../tools/corpus/manifest.json";
import type { RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import { toBriefingView } from "../../src/units/briefing/briefing-unit";
import { toFloodView } from "../../src/units/flood/flood-unit";
import { toLandslideView } from "../../src/units/landslide/landslide-unit";
import { toLocalBulletinsView } from "../../src/units/local-bulletins/local-bulletins-unit";
import { toSeismicView } from "../../src/units/seismic/seismic-unit";
import { toTsunamiView } from "../../src/units/tsunami/tsunami-unit";
import { toTyphoonView } from "../../src/units/typhoon/typhoon-unit";
import { eewStep, eewXml, emptyEew, material, projected, wire } from "./display-wire-fixture";

const AT = "2099-01-01T09:00:00+09:00";
const empty = (place: ExecutionPlace): OwnerState => restoreOwner({ runId: "run", place, clock: { wallTimeMs: Date.parse(AT), monotonicMs: 1 },
  restored: Object.fromEntries(runtimeUnits.filter((unit) => executionPlaces[unit] === place).map((unit) => [unit, { kind: "empty" }])) }, linkedUnitTable, linkedUnitCodecs).state;
const ask = (state: OwnerState, request: WireDetailRequest) => detailOwner(state, request);
// HTTP の本文（streamId 64 字）の全体。
const bodyBytes = (response: object) => Buffer.byteLength(JSON.stringify({ streamId: "x".repeat(64), ...response }));

// 受入条件 P4-DW-AC08（詳細）。
describe("P4-DW-T06 acceptance: the detail parts", () => {
  it("keeps a page within 65,536 bytes with the wrapper and omits what does not fit as pageBudget", () => {
    const station = (index: number) => ({ code: String(10000 + index), name: "観".repeat(400), areaCode: "100", areaName: null, sensor: null,
      firstHeight: { arrivalTimeRaw: null, initial: null, condition: null }, maxHeight: { dateTimeRaw: null, condition: null, height: null },
      revision: { reportDateTimeRaw: AT, serialRaw: "1", infoTypeRaw: "発表" } });
    const observation: TsunamiObservationSubject = { subject: "normal/tsunamiObservation:VTSE51/E1", eventId: "E1", operation: "normal", family: "VTSE51",
      source: { inputId: "input-1", origin: "replay", operation: "normal", family: "VTSE51", subject: "normal/tsunamiObservation:VTSE51/E1", reportDateTimeRaw: AT,
        controlDateTimeRaw: AT, serialRaw: "1", infoTypeRaw: "発表" }, controlDateTimeRaw: AT, effective: "active", stations: Array.from({ length: 300 }, (_, index) => station(index)),
      estimations: [], validUntil: Date.parse(AT) + 3_600_000, retainUntil: null };
    const base = empty("urgent"), unit = base.units["U-T"]!;
    const state: OwnerState = { ...base, units: { ...base.units, "U-T": { ...unit, contentRevision: 1, observations: [observation] } } };
    const index = ask(state, { unit: "U-T", part: "index", revision: "1", page: 0 });
    if (index.kind !== "ok" || index.part !== "index" || !("omitted" in index)) throw new Error("no index");
    const entry = index.entries[0];
    expect(entry).toMatchObject({ operation: "normal", part: "stations" });
    const page = ask(state, { unit: "U-T", part: "stations", id: entry.id, revision: entry.revision, page: 0 });
    if (page.kind !== "ok" || page.part !== "stations") throw new Error("no page");
    expect(bodyBytes(page)).toBeLessThanOrEqual(65_536);
    expect(page.omitted.length).toBeGreaterThan(0);
    expect([...page.items.map((item) => item.index), ...page.omitted.map((item) => item.index)].sort((a, b) => a - b)).toEqual(Array.from({ length: 256 }, (_, index) => index));
    expect(page.pageCount).toBe(2);
  });

  it("changes the revision when the returned object changes with the same source (the held EEW mark)", async () => {
    const first = eewStep(emptyEew(), eewXml({ eventId: "20990101000001", at: AT, areas: [["622", "4", "4"]] }));
    const held = eewStep(first.state, eewXml({ eventId: "20990101000001", at: AT, areas: [["622", "5-", "5-"]] }));
    const card = projected(await wire({ eew: first.state }, first.displayChanges, null)).snapshot.current.eew.wire.cards[0];
    const base = empty("urgent");
    const before = { ...base, units: { ...base.units, "U-E": first.state } }, after = { ...base, units: { ...base.units, "U-E": held.state } };
    // 要求は operation を持たない（id の sha256 に入る）。
    const request: WireDetailRequest = { unit: "U-E", part: "areas", id: card.ref.id, revision: card.ref.rev, page: 0 };
    expect(Object.keys(request)).not.toContain("operation");
    expect(ask(before, request)).toMatchObject({ kind: "ok", part: "areas", itemCount: 1 });
    const stale = ask(after, request);
    expect(stale).toMatchObject({ kind: "error", reason: "versionChanged" });
    expect(held.state.current[0].source).toBe(first.state.current[0].source);
    expect(stale.revision).not.toBe(card.ref.rev);
  });

  it("answers every page of every new part over the legal corpus without an omitted item, and the U-N・U-V entries open the delivered text", () => {
    const owners = new Map<ExecutionPlace, OwnerState>((["urgent", "seismic", "weatherCurrent", "deferred"] as const).map((place) => [place, empty(place)]));
    let count = 0;
    for (const fixture of manifest.fixtures) {
      const headType = fixture.transport.headType;
      if (headType == null || classifyHeadType(headType).status !== "ready") continue;
      const xml = readFileSync(fixture.path, "utf8");
      let decoded;
      try { decoded = material(xml, headType); } catch { continue; }
      const place = placeOfHeadType(headType), at = Date.parse(decoded.reportDateTimeRaw);
      const clock = { wallTimeMs: Number.isFinite(at) ? at + 1000 : Date.parse(AT), monotonicMs: ++count };
      owners.set(place, receiveOwner(owners.get(place)!, { runId: "run", inputId: decoded.inputId, result: { kind: "decoded", material: decoded } }, clock, linkedUnitTable).state);
    }
    let pages = 0, texts = 0;
    for (const unit of ["U-T", "U-Q", "U-N", "U-V", "U-M", "U-L", "U-R", "U-B", "U-Y"] as const) {
      const state = owners.get(executionPlaces[unit])!, revision = String(state.units[unit]?.contentRevision);
      for (let page = 0; ; page++) {
        const index = ask(state, { unit, part: "index", revision, page });
        if (index.kind !== "ok" || index.part !== "index" || !("omitted" in index)) throw new Error(`${unit} index`);
        expect([unit, index.omitted]).toEqual([unit, []]);
        for (const item of index.entries) {
          if (item.part === "text") {
            if (unit !== "U-N" && unit !== "U-V") throw new Error("text entry");
            const text = detailOwner(state, { unit, part: "text", id: item.id, revision: item.revision });
            expect(text).toMatchObject({ kind: "ok", part: "text", id: item.id });
            texts++;
            continue;
          }
          if (item.part === "item" || item.part === "comment") continue;
          const part = item.part;
          for (let at = 0; ; at++) {
            const request: WireDetailRequest = part === "event" ? { unit: "U-Q", part, id: item.id, revision: item.revision, page: at }
              : part === "stations" ? { unit: "U-T", part, id: item.id, revision: item.revision, page: at } : { unit: "U-T", part, id: item.id, revision: item.revision, page: at };
            const response = ask(state, request);
            if (response.kind !== "ok" || !("omitted" in response)) throw new Error(`${unit} ${part}`);
            expect([unit, part, response.omitted]).toEqual([unit, part, []]);
            pages++;
            if (at + 1 >= response.pageCount) break;
          }
        }
        if (page + 1 >= index.pageCount) break;
      }
    }
    expect(pages).toBeGreaterThan(0);
    expect(texts).toBeGreaterThan(0);
    // owner の写した view の形が unit の toView と同じ（rev は view の object の JSON の sha256、表 §2.1）。
    const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
    const revisions = (unit: "U-T" | "U-Q" | "U-M" | "U-L" | "U-R" | "U-B" | "U-Y") => {
      const state = owners.get(executionPlaces[unit])!, all: string[] = [];
      for (let page = 0; ; page++) {
        const index = ask(state, { unit, part: "index", revision: String(state.units[unit]?.contentRevision), page });
        if (index.kind !== "ok" || index.part !== "index" || !("omitted" in index)) throw new Error("index");
        all.push(...index.entries.flatMap((entry) => "part" in entry && entry.part === "comment" ? [] : [entry.revision]));
        if (page + 1 >= index.pageCount) return all;
      }
    };
    const units = (unit: RuntimeUnitId) => owners.get(executionPlaces[unit])!.units;
    const tsunami = toTsunamiView(units("U-T")["U-T"]!), quake = toSeismicView(units("U-Q")["U-Q"]!), local = toLocalBulletinsView(units("U-M")["U-M"]!);
    const landslide = toLandslideView(units("U-L")["U-L"]!), flood = toFloodView(units("U-R")["U-R"]!), briefing = toBriefingView(units("U-B")["U-B"]!);
    const typhoon = toTyphoonView(units("U-Y")["U-Y"]!);
    expect(revisions("U-T")).toEqual([...tsunami.forecasts, ...tsunami.observations].map(sha));
    expect(revisions("U-Q")).toEqual(quake.earthquakes.map(sha));
    expect(revisions("U-M")).toEqual([...local.tornado, ...local.heat, ...local.transient].map(sha));
    expect(revisions("U-L")).toEqual(landslide.currents.map(sha));
    expect(revisions("U-R")).toEqual(flood.currents.map(sha));
    expect(revisions("U-B")).toEqual(briefing.currents.map(sha));
    expect(revisions("U-Y")).toEqual([...typhoon.analysis, ...typhoon.probability].map(sha));
    expect(quake.earthquakes.length + tsunami.forecasts.length).toBeGreaterThan(0);
  });

  it("returns a card's raw text by its inputId and receivedAt, and the HTTP path reads the request field by field", async () => {
    const base = empty("urgent");
    const card = { kind: "unreadable" as const, inputId: "input-9", headType: "VXSE43", operation: "normal" as const, receivedAt: 123, reason: "xmlInvalid" as const,
      title: null, headline: null, reportDateTimeRaw: null, raw: "<Report/>", rawCut: false, count: 1 };
    const state: OwnerState = { ...base, unreadable: { "U-E": [card] } };
    expect(ask(state, { unit: "U-E", part: "raw", id: "input-9", revision: "123" })).toEqual({ kind: "ok", part: "raw", id: "input-9", revision: "123", raw: "<Report/>", rawCut: false, rawDropped: false });
    expect(ask(state, { unit: "U-E", part: "raw", id: "input-9", revision: "124" })).toEqual({ kind: "error", reason: "versionChanged", revision: "123" });
    const seen: unknown[] = [];
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null },
      detail: (input) => { seen.push(input); return { response: Promise.resolve({ kind: "error", reason: "unavailable", revision: null }), done: () => {} }; } });
    const get = (path: string) => new Promise<number>((resolve, reject) => {
      const sent = httpRequest({ host: "127.0.0.1", port: server.port, path, agent: false }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      sent.on("error", reject);
      sent.end();
    });
    try {
      expect(await get("/api/display/wire/detail?streamId=s&unit=U-Q&part=index&revision=3&page=0")).toBe(503);
      expect(seen).toEqual([{ streamId: "s", detail: { unit: "U-Q", part: "index", revision: "3", page: 0 } }]);
      expect(await get("/api/display/wire/detail?streamId=s&unit=U-E&part=index&revision=3&page=0")).toBe(400);
      expect(await get("/api/display/wire/detail?streamId=s&unit=U-T&part=areas&id=zz&revision=3&page=0")).toBe(400);
    } finally {
      await server.close();
    }
  });
});
