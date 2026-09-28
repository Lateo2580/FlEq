import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalGeometryJson } from "../../src/display/chrome-eew/geometry";

// P2-A9-T02 contractBoundary (AC03): 固定geometryのcanonical JSON bytesを契約AC03のsha256と照合する。
// 配信されたmoduleでの照合と中心pixelはsmokeが実Chromeで確かめる。
describe("P2-A9-T02 geometry hash", () => {
  it("canonical geometry JSON bytes match the sha256 in contract AC03", () => {
    const contract = JSON.parse(readFileSync(join(__dirname, "../../contracts/p2-chrome-eew.json"), "utf8"));
    const ac03: string = contract.contract.acceptanceChecks.find((check: { id: string }) => check.id === "P2-A9-AC03").requirement;
    expect(createHash("sha256").update(canonicalGeometryJson()).digest("hex")).toBe(/sha256=([0-9a-f]{64})/.exec(ac03)?.[1]);
  });
});
