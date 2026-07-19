import { describe, it, expect } from "vitest";
import { toTickerJob, enqueueJob, assignLanes, createSchedulerState } from "../ticker-schedule";
import { tickerEvent } from "./fixtures";

describe("A/B/C 横断契約 (spec §10)", () => {
  it("A 未実装相当 (tickerSubject/tickerBody null) でも B は種別のみで壊れない", () => {
    const dto = tickerEvent({ id: "e", eventKey: "k", tickerBody: null, tickerSentence: "一言", tickerPriority: "low" });
    const jobV = toTickerJob(dto, 1);
    expect(jobV.segments).toEqual(["一言"]); // 本文なしフォールバック
    expect(jobV.runs.length).toBe(1);
  });

  it("B の revisionAt が続報昇格で立ち、C のバッジ判定に使える", () => {
    const dto1 = tickerEvent({ id: "e1", eventKey: "k1", groupKey: "g", tickerBody: "本文一。", tickerPriority: "low" });
    let s = createSchedulerState([toTickerJob(dto1, 1)]);
    s = assignLanes(s, 1000).state; // 走行開始
    // 同格続報 → coalescing → 待機上限で昇格
    const dto2 = tickerEvent({ id: "e2", eventKey: "k2", groupKey: "g", tickerBody: "本文二。", tickerPriority: "low" });
    s = enqueueJob(s, toTickerJob(dto2, 2), 1500);
    s = assignLanes(s, 1500 + 4_500).state; // MAX_REVISION_WAIT 到達で昇格 (fade)
    const lane = s.lanes.find((l) => l.replacement?.groupKey === "g" || l.current?.groupKey === "g");
    // 昇格した版に revisionAt が立つ (buffer 内は null だった)
    const promoted = lane?.replacement ?? lane?.current;
    expect(promoted?.revisionAt).not.toBeNull();
  });
});
