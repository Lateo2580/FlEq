import { testTelegramMeta } from "../helpers/telegram-meta";
import { describe, expect, it, vi } from "vitest";
import type { ParsedVolcanoAshfallInfo, WsDataMessage } from "../../src/types";
import type { VolcanoBatchOutcome } from "../../src/engine/presentation/types";
import type { Vfvo53BatchItems } from "../../src/engine/messages/volcano-vfvo53-aggregator";
import { VolcanoRouteHandler } from "../../src/engine/messages/volcano-route-handler";
import { VolcanoStateHolder } from "../../src/engine/messages/volcano-state";

function info(volcanoCode: string, volcanoName: string): ParsedVolcanoAshfallInfo {
  return {
    meta: testTelegramMeta(false),
    domain: "volcano", kind: "ashfall", type: "VFVO53", subKind: "scheduled",
    infoType: "定時", title: "降灰予報", reportDateTime: "2026-07-10T12:00:00+09:00",
    eventDateTime: null, headline: null, publishingOffice: "気象庁", volcanoName, volcanoCode,
    coordinate: null, isTest: false, craterName: null, ashForecasts: [], plumeHeight: null,
    plumeDirection: null, bodyText: `${volcanoName}の降灰予報です。`,
  };
}

function message(id: string): WsDataMessage {
  return {
    type: "data", version: "2.0", classification: "telegram.volcano", id, passing: [],
    head: { type: "VFVO53", author: "気象庁", time: "2026-07-10T12:00:00+09:00", test: false, xml: true },
    format: "xml", compression: null, encoding: "utf-8", body: "",
  };
}

function batch(sources: Vfvo53BatchItems["sources"]): Vfvo53BatchItems {
  return {
    reportDateTime: "2026-07-10T12:00:00+09:00",
    isTest: false,
    items: [info("506", "桜島"), info("503", "霊島")],
    sources,
  };
}

describe("VolcanoRouteHandler VFVO53 batch source fallback", () => {
  it("disables display expansion when any source message is missing", () => {
    const outcomes: VolcanoBatchOutcome[] = [];
    const displayVolcanoBatch = vi.fn();
    const handler = new VolcanoRouteHandler({
      volcanoState: new VolcanoStateHolder(),
      notifier: { notifyVolcano: vi.fn(), notifyVolcanoBatch: vi.fn() } as never,
      runDisplayPipeline: (outcome, displayFn) => {
        outcomes.push(outcome as VolcanoBatchOutcome);
        displayFn();
        return true;
      },
      display: { displayVolcanoBatch } as never,
    });
    const emitBatch = (handler as unknown as { emitBatch(batch: Vfvo53BatchItems, opts: { notify: boolean }): void }).emitBatch;

    emitBatch.call(handler, batch([
      { info: info("506", "桜島") },
      { info: info("503", "霊島"), msg: message("kirishima") },
    ]), { notify: false });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].msg.id).toBe("kirishima");
    expect(outcomes[0].sources).toEqual([]);
    expect(displayVolcanoBatch).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy direct display when all source messages are missing", () => {
    const runDisplayPipeline = vi.fn();
    const displayVolcanoBatch = vi.fn();
    const handler = new VolcanoRouteHandler({
      volcanoState: new VolcanoStateHolder(),
      notifier: { notifyVolcano: vi.fn(), notifyVolcanoBatch: vi.fn() } as never,
      runDisplayPipeline,
      display: { displayVolcanoBatch } as never,
    });
    const emitBatch = (handler as unknown as { emitBatch(batch: Vfvo53BatchItems, opts: { notify: boolean }): void }).emitBatch;

    emitBatch.call(handler, batch([
      { info: info("506", "桜島") },
      { info: info("503", "霊島") },
    ]), { notify: false });

    expect(runDisplayPipeline).not.toHaveBeenCalled();
    expect(displayVolcanoBatch).toHaveBeenCalledTimes(1);
  });
});
