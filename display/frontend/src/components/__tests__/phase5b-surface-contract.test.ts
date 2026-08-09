import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import TyphoonCard from "../TyphoonCard.svelte";
import { StandbyPersistence } from "../../../../../src/engine/display/standby-persistence";
import { StandbyStateStore } from "../../../../../src/engine/display/standby-state-store";
import { fromTyphoonAnalysisOutcome } from "../../../../../src/engine/presentation/events/from-typhoon-analysis";
import { processTyphoonAnalysis } from "../../../../../src/engine/presentation/processors/process-typhoon-analysis";
import {
  createMockWsDataMessageFromXml,
  readFixture,
} from "../../../../../test/helpers/mock-message";

const NOW = Date.parse("2026-08-10T00:00:01+09:00");
const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Phase 5B card surface contract", () => {
  it("ほとんど停滞を同じ XML から scalar null→save/load/restore→実 DOM まで通す", () => {
    const message = createMockWsDataMessageFromXml(
      readFixture("synthetic_phase5b_typhoon_qualitative.xml"),
      "VPTW60",
    );
    const outcome = processTyphoonAnalysis(message);
    if (outcome == null) throw new Error("typhoon outcome が null");
    const frame = outcome.parsed.frames[0];
    expect(frame?.center.moveSpeedKmh).toBeNull();
    expect(frame?.center.moveSpeedKmhValue).toEqual({
      raw: "", value: null, condition: "ほとんど停滞", description: null,
      presence: "qualitative",
    });
    const event = fromTyphoonAnalysisOutcome(outcome);
    const live = new StandbyStateStore();
    live.applyEvent(event, NOW);
    const sandbox = fs.mkdtempSync(path.join(process.cwd(), `.phase5b-card-contract-${process.pid}-`));
    sandboxes.push(sandbox);
    const persistence = new StandbyPersistence(path.join(sandbox, "standby.json"), 0);
    persistence.save(live.exportActiveState());
    const loaded = persistence.load();
    if (loaded == null) throw new Error("typhoon persistence load が null");
    const restored = new StandbyStateStore();
    restored.restoreActiveState(loaded, NOW);
    expect(restored.exportActiveState().typhoons[0]).toMatchObject({
      typhoon: { moveSpeedKmh: null },
      moveSpeedKmhValue: {
        raw: "", value: null, condition: "ほとんど停滞", description: null,
        presence: "qualitative",
      },
    });
    const item = restored.snapshotItems().find((candidate) => candidate.kind === "typhoon");
    if (item == null) throw new Error("typhoon card projection が null");

    const { container } = render(TyphoonCard, { item });
    const labels = Array.from(container.querySelectorAll(".meta .stat-label")).map((node) => node.textContent);
    expect(labels).toEqual(["最大風速", "進行"]);
    const values = container.querySelectorAll(".meta .stat-value");
    expect(values[0].querySelector('[data-value="0"]')).toBeTruthy();
    expect(values[0].querySelector(".stat-unit")?.textContent).toBe("m/s");
    expect(values[0].querySelector(".semantic-badge")).toBeNull();
    expect(values[1].textContent).toBe("北 ほとんど停滞?");
    const semanticSpeed = values[1].querySelector<HTMLElement>(".semantic-speed");
    expect(semanticSpeed?.querySelector(".semantic-text")?.textContent).toBe("ほとんど停滞");
    expect(semanticSpeed?.title).toContain("条件: ほとんど停滞");
    expect(semanticSpeed?.getAttribute("aria-label")).toBe(semanticSpeed?.title);
    expect(semanticSpeed?.querySelector(".semantic-badge")?.getAttribute("aria-hidden")).toBe("true");
    expect(values[1].querySelector(".nu-value")).toBeNull();
    expect(container.textContent).not.toContain("最大瞬間");
    expect(container.textContent).not.toContain("0km/h");
    expect(container.textContent).not.toContain("不明?");
  });
});
