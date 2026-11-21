import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EewCurrent } from "../../contracts/p2-eew-unit.types";
import type { RuntimeDisplayChange } from "../../contracts/p2-shared-runtime.types";
import type { WireDetailResponse } from "../../contracts/p4-display-wire.types";
import { startDisplayServer } from "../../src/http-sse/http-sse";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { detailOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import type { OwnerState } from "../../src/runtime/owner-runtime";
import { currentSubject } from "../../src/units/eew/eew-unit";
import { decodeFixture, receive as receiveQuake } from "../seismic-unit/seismic-fixture";
import { clock } from "../tsunami-unit/tsunami-fixture";
import { eewStep, eewXml, emptyEew, projected, wire } from "./display-wire-fixture";

// P4-DISPLAY-WIRE-001 のヘルツの再レビュー（H4・H5）の場面。直す前の木（e57aa0b8）で落ちることを確かめてから直す。
const AT = "2099-01-01T09:00:00+09:00";
afterEach(() => { vi.restoreAllMocks(); });
function eewChange(after: EewCurrent): RuntimeDisplayChange {
  return { unit: "U-E", operation: after.operation, subject: after.subject, before: null,
    after: { unit: "U-E", operation: after.operation, subject: after.subject, office: null, current: after, subjects: [currentSubject(after)] } };
}

// 契約の境界 P4-DW-AC05（ヘルツ H5）: owner の返信は worker の写しなので、表示差分の無い step でも view の object は全部替わる。
describe("P4-DW-T02 contractBoundary: a re-emitted view across the worker costs nothing", () => {
  it("reads no area, hashes nothing and copies no map when an unreadable report re-emits the U-E view", async () => {
    const first = eewStep(emptyEew(), eewXml({ eventId: "20990101000000", at: AT, areas: [["622", "5-", "5-"], ["632", "4", "4"], ["752", "3", "3"]] }));
    const template = first.state.current[0];
    const current: EewCurrent[] = Array.from({ length: 300 }, (_, index) => {
      const eventId = `2099010100${String(index).padStart(4, "0")}`, subject = `normal/VXSE43/${eventId}`;
      return { ...template, eventId, subject };
    });
    const state = { ...first.state, current };
    const filled = projected(await wire({ eew: state }, current.map(eewChange), null));
    const card = { kind: "unreadable" as const, inputId: "input-9", headType: "VXSE43", operation: "normal" as const, receivedAt: 1, reason: "xmlInvalid" as const,
      title: null, headline: null, reportDateTimeRaw: null, rawCut: false, count: 1, hasRaw: true };
    const sets = vi.spyOn(Map.prototype, "set");
    const step = await wire({ eew: state }, [], filled.state, (views) => structuredClone({ ...views, eew: { ...views.eew, unreadableCards: [card] } }));
    const mapSets = sets.mock.calls.length;
    sets.mockRestore();
    expect(step.counts.eew).toEqual({ read: 0, recomputed: 0, built: 0, hashed: 0 });
    expect(mapSets).toBeLessThanOrEqual(4);
    const next = projected(step).snapshot.current.eew;
    expect(next.cards).toHaveLength(1);
    expect(next.wire).toBe(filled.snapshot.current.eew.wire);
  });

  it("does not rebuild the earthquake wire for a cloned view whose content revision did not move", async () => {
    const quake = receiveQuake((restoreOwner({ runId: "run", place: "seismic", clock: { wallTimeMs: 0, monotonicMs: 1 }, restored: { "U-Q": { kind: "empty" } } },
      linkedUnitTable, linkedUnitCodecs).state.units["U-Q"])!, decodeFixture("32-35_01_03_240613_VXSE53"), clock(Date.parse("2009-10-01T13:51:00+09:00")));
    const filled = projected(await wire({ quake: quake.state }, quake.displayChanges, null));
    const step = await wire({ quake: quake.state }, [], filled.state, (views) => structuredClone(views));
    expect(step.kind).toBe("unchanged");
    expect(step.counts.earthquake).toEqual({ read: 0, recomputed: 0, built: 0, hashed: 0 });
  });
});

// 受入条件 P4-DW-AC08（ヘルツ H4）: HTTP の本文（streamId は最大の 64 字）の全体が 65,536 byte 以下。
describe("P4-DW-T06 acceptance: the whole response body stays within 65,536 bytes", () => {
  const body = (response: WireDetailResponse | ReturnType<typeof detailOwner>) => Buffer.byteLength(JSON.stringify({ streamId: "x".repeat(64), ...response }));
  it("keeps every event page within the budget around the heading that just fits, with 1- and 4-byte characters", () => {
    const seismic = restoreOwner({ runId: "run", place: "seismic", clock: { wallTimeMs: 0, monotonicMs: 1 }, restored: { "U-Q": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
    const quake = receiveQuake(seismic.units["U-Q"]!, decodeFixture("32-35_01_03_240613_VXSE53"), clock(Date.parse("2009-10-01T13:51:00+09:00")));
    const event = quake.state.earthquakes[0];
    const named = (name: string) => {
      // 震度の要素は 2 件。
      const contributions = event.contributions.map((item) => ({ ...item, hypocenter: item.hypocenter == null ? null : { ...item.hypocenter, name },
        intensity: item.intensity == null ? null : { ...item.intensity, items: item.intensity.items.filter((value) => value.level === "pref").slice(0, 2) } }));
      const state = { ...quake.state, earthquakes: [{ ...event, contributions }] };
      const owner: OwnerState = { ...seismic, units: { ...seismic.units, "U-Q": state } };
      const index = detailOwner(owner, { unit: "U-Q", part: "index", revision: String(state.contentRevision), page: 0 });
      if (index.kind !== "ok" || index.part !== "index" || !("omitted" in index)) throw new Error("index");
      return detailOwner(owner, { unit: "U-Q", part: "event", id: index.entries[0].id, revision: index.entries[0].revision, page: 0 });
    };
    // 見出しだけで 65,520 byte ほどになる 1 byte の字の数を探し、その前後を 1 byte と 4 byte の字で 1 字ずつ動かす。
    const empty = named("");
    if (empty.kind !== "ok" || empty.part !== "event") throw new Error("event");
    expect(empty.itemCount).toBe(2);
    const fit = 65_520 - body({ ...empty, items: [], omitted: [] });
    let checked = 0;
    for (let delta = -24; delta <= 24; delta++) for (const [char, width] of [["a", 1], ["\u{20BB7}", 4]] as const) {
      const length = Math.max(0, Math.floor((fit + delta) / width));
      const response = named(char.repeat(length));
      expect([char, length, body(response) <= 65_536]).toEqual([char, length, true]);
      checked++;
    }
    expect(checked).toBe(98);
  });

  it("answers a body over the budget with 503 instead of 200 at the HTTP layer", async () => {
    const oversized: WireDetailResponse = { kind: "ok", part: "comment", id: "a".repeat(64), revision: "b".repeat(64), text: "x".repeat(70_000) };
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null },
      detail: () => ({ response: Promise.resolve(oversized), done: () => {} }) });
    try {
      const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const sent = httpRequest({ host: "127.0.0.1", port: server.port, agent: false,
          path: `/api/display/wire/detail?streamId=s&unit=U-T&part=comment&id=${"a".repeat(64)}&revision=${"b".repeat(64)}` }, (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => { text += chunk; });
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
        });
        sent.on("error", reject);
        sent.end();
      });
      expect(answer.status).toBe(503);
      expect(JSON.parse(answer.body)).toEqual({ streamId: "s", kind: "error", reason: "responseTooLarge", revision: null });
    } finally {
      await server.close();
    }
  });
});
