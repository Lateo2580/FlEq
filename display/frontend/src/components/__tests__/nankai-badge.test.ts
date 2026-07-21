import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import NankaiBadge from "../NankaiBadge.svelte";
import type { ActiveStandbyCardV1 } from "../../lib/protocol";

function nankaiItem(restored = false): Extract<ActiveStandbyCardV1, { kind: "nankaiTrough" }> {
  return {
    kind: "nankaiTrough", surface: "clock-below", key: "nankai:current", sourceEventIds: ["nankai-1"],
    updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-28T00:00:00.000Z", restored,
    severity: "critical", data: { statusCode: "10", label: "巨大地震警戒" },
  };
}

describe("NankaiBadge", () => {
  it("marks a restored badge as synchronizing", () => {
    const { container } = render(NankaiBadge, { item: nankaiItem(true) });
    expect(container.querySelector(".restored-chip")?.textContent).toBe("同期中");
  });
});
