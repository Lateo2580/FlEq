import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import LatestQuakeCard from "../LatestQuakeCard.svelte";
import type { DisplayLatestQuakeStateV1 } from "../../lib/protocol";
import { processEarthquake } from "../../../../../src/engine/presentation/processors/process-earthquake";
import { fromEarthquakeOutcome } from "../../../../../src/engine/presentation/events/from-earthquake";
import { projectRecentQuake } from "../../../../../src/engine/display/project-event";
import {
  createMockWsDataMessageFromXml,
  readFixture,
} from "../../../../../test/helpers/mock-message";

describe("Phase 5A card surface contract", () => {
  it("横断 contract と同じ XML を parser→projection→LatestQuakeCard の実 DOM まで通す", () => {
    const message = createMockWsDataMessageFromXml(
      readFixture("synthetic_phase5a_depth_600km_or_more.xml"),
      "VXSE52",
    );
    const outcome = processEarthquake(message);
    if (outcome == null) throw new Error("earthquake outcome が null");
    const event = fromEarthquakeOutcome(outcome);
    const recent = projectRecentQuake(event);
    if (recent == null) throw new Error("recent quake projection が null");
    const quake: DisplayLatestQuakeStateV1 = {
      ...recent,
      headline: event.headline,
      intensityGroups: recent.intensityGroups ?? [],
      updatedAtMs: Date.parse(event.reportDateTime),
    };

    const { container } = render(LatestQuakeCard, { quake });
    expect(container.querySelector(".magnitude")?.textContent).toContain("M5.0");
    expect(container.querySelector(".depth")?.textContent).toContain("600km以上≥");
    expect(container.querySelector(".depth")?.getAttribute("aria-label")).toContain("以上、下限値");
    expect(container.querySelector(".depth")?.getAttribute("aria-label")).toContain("深さ６００ｋｍ以上");
    expect(container.querySelector(".numeric-semantic-legend")?.textContent).toContain("以上（下限値）");
  });
});
