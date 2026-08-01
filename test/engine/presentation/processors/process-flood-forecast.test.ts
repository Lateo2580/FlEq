import { describe, it, expect } from "vitest";
import { processFloodForecast } from "../../../../src/engine/presentation/processors/process-flood-forecast";
import { FloodForecastStateHolder } from "../../../../src/engine/messages/flood-forecast-state";
import type { FloodForecastOutcome } from "../../../../src/engine/presentation/types";
import { makeProcessDeps } from "../../../helpers/process-deps";
import {
  createMockWsDataMessage,
  FIXTURE_VXKO50_16_02_01,
  FIXTURE_VXKO50_16_05_01,
  FIXTURE_VXSU50_91_01_01,
  FIXTURE_SYNTHETIC_VXKO50_CANCEL,
  FIXTURE_SYNTHETIC_VXKO50_CORRECTION,
} from "../../../helpers/mock-message";

function makeDeps() {
  return makeProcessDeps({ floodForecastState: new FloodForecastStateHolder() });
}

function unwrap(result: ReturnType<typeof processFloodForecast>): FloodForecastOutcome {
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error(`unexpected result: ${result.kind}`);
  return result.outcome;
}

describe("processFloodForecast", () => {
  it("VXKO 通常発表 (16_02_01) → FloodForecastOutcome (初回 dedup 後 suppressNotify=false)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXKO50_16_02_01);
    const outcome = unwrap(processFloodForecast(msg, makeDeps()));
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("floodForecast");
    expect(outcome!.statsCategory).toBe("floodForecast");
    expect(outcome!.parsed.schema).toBe("vxko50");
    expect(outcome!.presentation.notifyCategory).toBe("floodForecast");
    expect(outcome!.presentation.suppressNotify).toBe(false);
    expect(outcome!.diff).not.toBeNull();
    expect(outcome!.parsed.rawStations.length).toBeGreaterThan(0);
    // 初回は少なくとも 1 件は "new" として検出される
    // (同 stationCode は store Map で merge されるため、station 重複時の changedStations は
    //  rawStations より少なくなる)
    expect(outcome!.diff!.changedStations.length).toBeGreaterThan(0);
    expect(outcome!.diff!.changedStations[0].reasons).toContain("new");
    expect(outcome!.diff!.hasChange).toBe(true);
    expect(outcome!.stats.shouldRecord).toBe(true);
    expect(outcome!.stats.eventId).toBe(outcome!.parsed.eventId);
    // frame/sound resolved
    expect(outcome!.presentation.frameLevel).toBeTruthy();
    expect(outcome!.presentation.soundLevel).toBeTruthy();
    // maxLevel / maxRank が結果に含まれる
    expect(outcome!.maxLevel).toBeTruthy();
    expect(outcome!.maxRank).toBeGreaterThan(0);
  });

  it("VXKO 通常発表 2 回連続: 同 deps で 2 回目は suppressNotify=true (内容変化なし)", () => {
    const deps = makeDeps();
    const msg1 = createMockWsDataMessage(FIXTURE_VXKO50_16_02_01);
    const outcome1 = unwrap(processFloodForecast(msg1, deps));
    expect(outcome1!.presentation.suppressNotify).toBe(false);
    expect(outcome1!.diff!.hasChange).toBe(true);

    // 同じ XML を再投入 → 全 station digest 同一 → hasChange=false → suppressNotify=true
    const msg2 = createMockWsDataMessage(FIXTURE_VXKO50_16_02_01);
    const outcome2 = processFloodForecast(msg2, deps);
    expect(outcome2.kind).toBe("suppressed");
  });

  it("取消 (synthetic_VXKO50_cancel) → state.rollback 呼出 + suppressNotify=false (取消通知)", () => {
    const deps = makeDeps();
    // 先に何か state を積んでおく
    const baseMsg = createMockWsDataMessage(FIXTURE_VXKO50_16_02_01);
    processFloodForecast(baseMsg, deps);

    const cancelMsg = createMockWsDataMessage(FIXTURE_SYNTHETIC_VXKO50_CANCEL);
    const outcome = unwrap(processFloodForecast(cancelMsg, deps));
    expect(outcome).not.toBeNull();
    expect(outcome!.parsed.infoType).toBe("取消");
    // 取消は dedup を経由しないため diff は null
    expect(outcome!.diff).toBeNull();
    expect(outcome!.presentation.suppressNotify).toBe(false);
    expect(outcome!.presentation.frameLevel).toBe("cancel");
    expect(outcome!.presentation.soundLevel).toBe("cancel");
    expect(outcome!.maxLevel).toBe("release");
  });

  it("取消後に元 eventId で再 record すると 'new' 復帰 (rollback 効いている)", () => {
    const deps = makeDeps();
    // 初回投入
    const msg = createMockWsDataMessage(FIXTURE_VXKO50_16_02_01);
    const before = unwrap(processFloodForecast(msg, deps));
    expect(before!.diff!.changedStations[0].reasons).toContain("new");
    const eventId = before!.parsed.eventId;
    // 同 eventId は 2 回目は不変化 (前提確認)
    expect(processFloodForecast(msg, deps).kind).toBe("suppressed");

    // 同 eventId の取消 fixture (synthetic_VXKO50_cancel.xml は元 16_02_01 ベースで eventId 保持)
    const cancelMsg = createMockWsDataMessage(FIXTURE_SYNTHETIC_VXKO50_CANCEL);
    expect(cancelMsg.head.type).toBe("VXKO50");
    const cancelOutcome = unwrap(processFloodForecast(cancelMsg, deps));
    expect(cancelOutcome!.parsed.eventId).toBe(eventId);

    // 取消後の同 fixture 再投入 → 'new' 復帰
    expect(processFloodForecast(msg, deps).kind).toBe("suppressed");
  });

  it("訂正 (synthetic_VXKO50_correction) → dedup bypass / suppressNotify=false / diff=null", () => {
    const deps = makeDeps();
    // 先に通常発表で state を積む (corrections は通常電文と同 eventId)
    const baseMsg = createMockWsDataMessage(FIXTURE_VXKO50_16_02_01);
    processFloodForecast(baseMsg, deps);

    const correctionMsg = createMockWsDataMessage(FIXTURE_SYNTHETIC_VXKO50_CORRECTION);
    const outcome = unwrap(processFloodForecast(correctionMsg, deps));
    expect(outcome).not.toBeNull();
    expect(outcome!.parsed.infoType).toBe("訂正");
    // 訂正は dedup bypass → diff は null のまま (state.diffAndUpdate 経由しない)
    expect(outcome!.diff).toBeNull();
    expect(outcome!.presentation.suppressNotify).toBe(false);
  });

  it("Headline-only (16_05_01, rawStations=0) → dedup bypass / suppressNotify=false / diff=null", () => {
    const deps = makeDeps();
    const msg = createMockWsDataMessage(FIXTURE_VXKO50_16_05_01);
    const outcome = unwrap(processFloodForecast(msg, deps));
    expect(outcome).not.toBeNull();
    expect(outcome!.parsed.rawStations.length).toBe(0);
    expect(outcome!.diff).toBeNull();
    expect(outcome!.presentation.suppressNotify).toBe(false);
  });

  it("VXSU (91_01_01) → schema='vxsu50' / dedup bypass / suppressNotify=false / diff=null", () => {
    const deps = makeDeps();
    const msg = createMockWsDataMessage(FIXTURE_VXSU50_91_01_01);
    const outcome = unwrap(processFloodForecast(msg, deps));
    expect(outcome).not.toBeNull();
    expect(outcome!.parsed.schema).toBe("vxsu50");
    // VXSU は Phase 1 で dedup bypass
    expect(outcome!.diff).toBeNull();
    expect(outcome!.presentation.suppressNotify).toBe(false);
  });

  it("パース失敗 (invalid XML) → null (process-message.ts 側で raw fallback)", () => {
    const deps = makeDeps();
    const badMsg = {
      type: "data" as const,
      version: "2.0",
      classification: "telegram.weather",
      id: "bad-flood",
      passing: [],
      head: {
        type: "VXKO50",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
        xml: true,
      },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "not-xml",
    };
    expect(processFloodForecast(badMsg, deps)).toEqual({ kind: "parse-failed" });
  });
});
