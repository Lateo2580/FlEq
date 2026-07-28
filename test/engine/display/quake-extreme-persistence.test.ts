import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QuakeExtremePersistence } from "../../../src/engine/display/quake-extreme-persistence";
import type { QuakeExtremePersistedV1 } from "../../../src/engine/display/quake-extreme-store";

const T0 = Date.parse("2026-07-29T00:00:00Z");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("QuakeExtremePersistence", () => {
  it("即時保存は予約中の旧 active を破棄して取消 tombstone を確定する", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleq-quake-extreme-"));
    dirs.push(dir);
    const file = join(dir, "quake-extreme-v1.json");
    const persistence = new QuakeExtremePersistence(file, 60_000);
    const active: QuakeExtremePersistedV1 = {
      records: [{ groupKey: "quake:Q1", originTime: new Date(T0).toISOString(), sourceTypes: ["VXSE53"] }],
      seen: [],
    };
    const cancelled: QuakeExtremePersistedV1 = {
      records: [],
      seen: [{
        key: "quake:Q1:VXSE53",
        revision: { reportTimeMs: T0 + 1, serial: "2" },
        forgetAtMs: T0 + 12 * 60 * 60_000,
      }],
    };

    persistence.save(active, T0);
    persistence.schedule(active, T0);
    persistence.saveImmediate(cancelled, T0 + 1);

    expect(new QuakeExtremePersistence(file).load(T0 + 2)).toEqual(cancelled);
  });
});
