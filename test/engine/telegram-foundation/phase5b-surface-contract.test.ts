import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTyphoonAnalysis } from "../../../src/dmdata/typhoon-analysis-parser";
import { StandbyPersistence } from "../../../src/engine/display/standby-persistence";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { projectDisplayEvent } from "../../../src/engine/display/project-event";
import { Notifier } from "../../../src/engine/notification/notifier";
import { fromTyphoonAnalysisOutcome } from "../../../src/engine/presentation/events/from-typhoon-analysis";
import { processTyphoonAnalysis } from "../../../src/engine/presentation/processors/process-typhoon-analysis";
import { displayTyphoonAnalysisInfo } from "../../../src/ui/typhoon-analysis-formatter";
import { stripAnsi } from "../../../src/ui/formatter";
import { notifyMock } from "../../setup";
import { createMockWsDataMessage, createMockWsDataMessageFromXml, readFixture } from "../../helpers/mock-message";

const FIXTURE = "synthetic_phase5b_typhoon_qualitative.xml";
const NOW = Date.parse("2026-08-10T00:00:01+09:00");
const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Phase 5B typhoon numeric transverse contract", () => {
  it("同一 XML を parser→CLI→notification→ticker→wire→persistence で意味維持する", () => {
    const message = createMockWsDataMessageFromXml(readFixture(FIXTURE), "VPTW60");
    const parsed = parseTyphoonAnalysis(message);
    if (parsed == null) throw new Error("typhoon parser が null");
    const frame = parsed.frames[0]!;

    expect(frame.center.pressureHpaValue).toMatchObject({
      raw: "", condition: "解析不能", presence: "unknown",
    });
    expect(frame.center.moveSpeedKmhValue).toEqual({
      raw: "", value: null, condition: "ほとんど停滞", description: null, presence: "qualitative",
    });
    expect(frame.center.moveSpeedKmh).toBeNull();
    expect(parsed.frames[1]?.center.moveSpeedKmhValue).toEqual({
      raw: "", value: null, condition: null, description: "ゆっくり", presence: "qualitative",
    });
    expect(frame.wind?.maxWindMs).toBe(0);
    expect(frame.wind?.maxWindMsValue).toMatchObject({
      raw: "0", condition: "なし", presence: "qualitative",
    });
    expect(frame.wind?.maxGustMsValue).toMatchObject({ raw: null, presence: "missing" });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    displayTyphoonAnalysisInfo(parsed);
    const cli = stripAnsi(log.mock.calls.map((call) => String(call[0] ?? "")).join("\n"));
    log.mockRestore();
    expect(cli).toContain("移動 北 ほとんど停滞");
    expect(cli).toContain("最大風速 0 m/s");

    notifyMock.mockClear();
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    notifier.toggleCategory("typhoonAnalysis");
    notifier.notifyTyphoonAnalysis(parsed, "normal");
    notifier.toggleCategory("typhoonAnalysis");
    expect(notifyMock.mock.calls.at(-1)?.[0]).toMatchObject({
      message: "リーベ (台風99号) 合成海域",
    });
    expect(String(notifyMock.mock.calls.at(-1)?.[0]?.message))
      .not.toMatch(/hPa|m\/s|km\/h|ゆっくり|ほとんど停滞/u);

    const outcome = processTyphoonAnalysis(createMockWsDataMessage(FIXTURE));
    if (outcome == null) throw new Error("typhoon outcome が null");
    const event = fromTyphoonAnalysisOutcome(outcome);
    const ticker = projectDisplayEvent(event, "Phase 5B contract").tickerBody ?? "";
    expect(ticker).toContain("北へ向かっていますが、移動速度は「ほとんど停滞」です");
    expect(ticker).toContain("北へ向かうものの、移動速度は「ゆっくり」となる見込みです");
    expect(ticker).not.toContain("時速");

    const live = new StandbyStateStore();
    live.applyEvent(event, NOW);
    const wire = live.snapshotItems().find((item) => item.kind === "typhoon");
    expect(wire?.data.typhoons[0]).toMatchObject({
      pressureHpaSemantic: { presence: "unknown", label: "不明", badge: "?", render: true },
      maxWindMsSemantic: { presence: "qualitative", label: "最大風速なし", badge: "?", render: true },
      maxGustMsSemantic: { presence: "missing", label: null, badge: null, render: false },
      moveSpeedKmhSemantic: { presence: "qualitative", label: "ほとんど停滞", badge: "?", render: true },
    });

    const sandbox = fs.mkdtempSync(path.join(process.cwd(), `.phase5b-contract-${process.pid}-`));
    sandboxes.push(sandbox);
    const persistence = new StandbyPersistence(path.join(sandbox, "standby.json"), 0);
    persistence.save(live.exportActiveState());
    const loaded = persistence.load();
    if (loaded == null) throw new Error("typhoon persistence load が null");
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, NOW);

    expect(restored.exportActiveState().typhoons[0]).toMatchObject({
      pressureHpaValue: frame.center.pressureHpaValue,
      maxWindMsValue: frame.wind?.maxWindMsValue,
      maxGustMsValue: frame.wind?.maxGustMsValue,
      moveSpeedKmhValue: frame.center.moveSpeedKmhValue,
    });
    expect(restored.snapshotItems().find((item) => item.kind === "typhoon")?.data.typhoons[0])
      .toMatchObject(wire!.data.typhoons[0]!);
  });
});
