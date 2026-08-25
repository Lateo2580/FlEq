import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import StandbyScreen from "../StandbyScreen.svelte";
import type { DisplayBriefingEntryV1, DisplayStateSnapshotV1 } from "../../lib/protocol";

export function cleanupProductionStandby(): void {
  cleanup();
}

export async function renderProductionStandby(
  snapshot: DisplayStateSnapshotV1,
  entry: DisplayBriefingEntryV1,
): Promise<HTMLElement | null> {
  const rendered = render(StandbyScreen, {
    snapshot,
    now: new Date(snapshot.generatedAt),
    dim: false,
    sseConnected: true,
    testMeasurementOverride: {
      layoutWidthPx: 1280,
      layoutHeightPx: 900,
      "briefing:compact:right": 280,
      "briefing:expanded:right": 280,
      "briefing:full:right": 280,
      "briefing:compact:center": 280,
      "briefing:expanded:center": 280,
      "briefing:full:center": 280,
    },
  });
  for (let pass = 0; pass < 12; pass += 1) await tick();
  const root = rendered.container.querySelector<HTMLElement>(".standby");
  if (root == null) return null;
  if (root.querySelector("[data-layout-motion-card='briefing:right']") == null) return null;
  if (root.querySelector("[data-briefing-card]") == null) return null;
  const renderedEntry = root.querySelector<HTMLElement>("[data-briefing-entry]");
  if (renderedEntry?.textContent?.includes(entry.title) !== true) return null;
  if (renderedEntry.getAttribute("data-frame-level") !== entry.frameLevel) return null;
  return root;
}
