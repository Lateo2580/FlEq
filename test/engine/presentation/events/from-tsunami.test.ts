import { describe, it, expect } from "vitest";
import { fromTsunamiOutcome } from "../../../../src/engine/presentation/events/from-tsunami";
import { processTsunami } from "../../../../src/engine/presentation/processors/process-tsunami";
import { TsunamiStateHolder } from "../../../../src/engine/messages/tsunami-state";
import {
  createMockWsDataMessage,
  FIXTURE_VTSE51_INFO,
  FIXTURE_VTSE51_OBSERVATION_MAXHEIGHT,
} from "../../../helpers/mock-message";

describe("fromTsunamiOutcome", () => {
  it("coasts に maxHeightDescription/firstHeight を積む (Phase A #3)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VTSE51_INFO, {
      head: { type: "VTSE51", author: "気象庁", time: new Date().toISOString(), test: false },
    });
    const result = processTsunami(msg, new TsunamiStateHolder());
    if (result.kind !== "ok") throw new Error(`processTsunami が ${result.kind} を返した`);
    const event = fromTsunamiOutcome(result.outcome);

    const iwate = event.areaItems.find((a) => a.name === "岩手県");
    expect(iwate).toMatchObject({ kind: "大津波警報：発表", maxHeightDescription: "巨大" });
  });

  it("tsunamiObservations が areaName から予報区の kind を補完する (Phase A #4)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VTSE51_OBSERVATION_MAXHEIGHT, {
      head: { type: "VTSE51", author: "気象庁", time: new Date().toISOString(), test: false },
    });
    const result = processTsunami(msg, new TsunamiStateHolder());
    if (result.kind !== "ok") throw new Error(`processTsunami が ${result.kind} を返した`);
    const event = fromTsunamiOutcome(result.outcome);

    expect(event.tsunamiObservations).toBeDefined();
    const kamaishi = event.tsunamiObservations!.find((o) => o.stationName === "釜石");
    expect(kamaishi).toMatchObject({
      areaName: "岩手県",
      areaKind: "大津波警報",
      maxHeightValue: "３．２ｍ",
      condition: "重要",
    });
  });
});
