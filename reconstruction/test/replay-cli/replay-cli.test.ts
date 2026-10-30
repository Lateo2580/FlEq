import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(__dirname, "../../..");
const CLI = join(REPO, "reconstruction/cli/replay.mjs");
const VXSE52 = "test__fixtures__32-35_01_02_240613_VXSE52";
const VXSE53 = "test__fixtures__32-35_01_03_240613_VXSE53";
const work = mkdtempSync(join(tmpdir(), "fleq-replay-cli-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const run = (...args: string[]) => spawnSync("node", [CLI, ...args], { cwd: REPO, encoding: "utf8", timeout: 60_000 });
const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]);

describe("P3-REPLAY-CLI-001", () => {
  // P3-RP-T01 acceptance (AC03・AC04・AC05・AC06)
  it("replays two fixtures through the product path with origin=replay and a clock moved forward by report time", () => {
    const out = join(work, "t01");
    mkdirSync(out);
    const result = run("--out", out, VXSE52, VXSE53);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.clockOrigin).toBe(Date.parse("2009-10-01T13:48:00+09:00"));
    expect(output.inputs).toMatchObject([{ inputId: "input-1", processed: true }, { inputId: "input-2", processed: true }]);
    expect(output.shutdown.code).toBe(0);
    expect(output.snapshot.current.earthquake.items[1].updatedAt).toBe(Date.parse("2009-10-01T13:50:00+09:00"));
    expect(Date.parse(output.snapshot.generatedAt)).toBeGreaterThanOrEqual(Date.parse("2009-10-01T13:50:00+09:00"));
    const saved = filesUnder(join(out, "state")).map((file) => readFileSync(file, "utf8"));
    expect(saved.some((text) => text.includes('"origin":"replay"'))).toBe(true);
    expect(saved.some((text) => text.includes('"origin":"live"'))).toBe(false);
  }, 70_000);

  // P3-RP-T02 contractBoundary (AC02)
  it("refuses an unknown fixtureId and a non-empty --out without creating or changing anything", () => {
    const missing = join(work, "not-yet");
    const a = run("--out", missing, "no-such-fixture");
    expect(a.status).toBe(1);
    expect(a.stdout).toBe("");
    expect(JSON.parse(a.stderr.trim())).toHaveProperty("error");
    expect(existsSync(missing)).toBe(false);

    const occupied = join(work, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "keep.txt"), "x");
    const b = run("--out", occupied, VXSE52);
    expect(b.status).toBe(1);
    expect(readdirSync(occupied)).toEqual(["keep.txt"]);
  }, 70_000);
});
