import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DiagnosticEvent } from "../../contracts/p2-shared-runtime.types";
import { PersistentDiagnosticSink, projectParserDiagnostic } from "../../src/checkpoint/persistent-diagnostic-sink";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { nodeDiagnosticFileSystem } from "../../src/runtime/composition-root";

const temporary: string[] = [];

async function directory(): Promise<string> {
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-a3-diagnostic-"));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  for (const path of temporary.splice(0)) await fileSystem.rm(path, { recursive: true, force: true });
});

describe("P2 persistent diagnostic sink", () => {
  it("P2-A3-T07 contractBoundary / AC07: bounded JSONL survives restart, filters safely and contains no extra secrets", async () => {
    const path = await directory();
    const failures: DiagnosticEvent[] = [];
    const sink = new PersistentDiagnosticSink(path, nodeDiagnosticFileSystem(), () => 2_000,
      (message) => failures.push(message));
    const first = {
      timestamp: 1_000, level: "WARN", component: "parser", reason: "xmlInvalid", runId: "run",
      inputId: "x".repeat(9_000), token: "secret-token", raw: "<Report>secret</Report>",
    } satisfies DiagnosticEvent & { token: string; raw: string };
    expect(sink.enqueueDiagnostic(first).kind).toBe("accepted");
    sink.enqueueDiagnostic({ timestamp: 1_000, level: "ERROR", component: "checkpoint",
      reason: "checkpointWriteFailed", runId: "run", unit: "U-F", generation: 2 });
    await sink.flush();
    expect(failures).toEqual([]);

    const name = (await fileSystem.readdir(path))[0];
    const lines = (await fileSystem.readFile(join(path, name), "utf8")).trim().split("\n");
    expect(lines.every((line) => Buffer.byteLength(`${line}\n`) <= 8192)).toBe(true);
    expect(lines.join("\n")).not.toContain("secret-token");
    expect(lines.join("\n")).not.toContain("<Report>");
    expect(lines[0]).toContain("[truncated:fieldLimit]");

    const restarted = new PersistentDiagnosticSink(path, nodeDiagnosticFileSystem(), () => 2_000, () => {});
    expect(await restarted.readDiagnostics({ level: "ERROR", unit: "U-F", limit: 256 })).toMatchObject({
      records: [{ timestamp: 1_000, level: "ERROR", unit: "U-F", generation: 2 }], truncated: false,
    });
    const ordered = await restarted.readDiagnostics({ fromTimestampMs: 1_000, throughTimestampMs: 1_000, limit: 1 });
    expect(ordered.records).toHaveLength(1);
    expect(ordered.truncated).toBe(true);
    await expect(restarted.readDiagnostics({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(restarted.readDiagnostics({ fromTimestampMs: 2, throughTimestampMs: 1, limit: 1 }))
      .rejects.toThrow(RangeError);

    expect(projectParserDiagnostic({ inputId: "id", reason: "xmlInvalid", encodedByteLength: 10,
      expandedByteLength: 20, operation: { kind: "undetermined", sources: {} } }, "run", 3_000))
      .toMatchObject({ event: { timestamp: 3_000, reason: "xmlInvalid", runId: "run" },
        encodedByteLength: 10, expandedByteLength: 20 });
  });

  it("P2-A3-T07 contractBoundary / AC07: queue pressure and sink failure drop finitely without recursion", async () => {
    const removed: string[] = [];
    const retained: DiagnosticFileSystem = {
      async mkdir() {}, async appendFile() {}, async writeFile() {}, async rename() {},
      async readFile(path) { return `${JSON.stringify({ timestamp: path.includes("2020") ? 0 : 8 * 24 * 60 * 60 * 1000,
        level: "INFO", component: "retention", reason: "shutdownStarted", runId: "run" })}\n`; },
      async files() { return [
        { name: "diagnostics-2020-01-01.jsonl", size: 1, mtimeMs: 0 },
        { name: "diagnostics-2026-01-01.jsonl", size: 101 * 1024 * 1024, mtimeMs: 8 * 24 * 60 * 60 * 1000 },
      ].filter((file) => !removed.includes(`/retention/${file.name}`)); },
      async unlink(path) { removed.push(path); },
    };
    const retention = new PersistentDiagnosticSink("/retention", retained,
      () => 8 * 24 * 60 * 60 * 1000, () => {});
    retention.enqueueDiagnostic({ timestamp: 1, level: "INFO", component: "retention",
      reason: "shutdownStarted", runId: "run" });
    await retention.flush();
    expect(removed).toEqual([
      "/retention/diagnostics-2020-01-01.jsonl", "/retention/diagnostics-2026-01-01.jsonl",
    ]);

    let appends = 0;
    const unavailable: DiagnosticFileSystem = {
      async mkdir() {},
      async appendFile() { appends += 1; throw new Error("disk unavailable"); },
      async writeFile() {},
      async rename() {},
      async readFile() { return ""; },
      async files() { return []; },
      async unlink() {},
    };
    const failures: DiagnosticEvent[] = [];
    const failed = new PersistentDiagnosticSink("/virtual", unavailable, () => 0,
      (message) => failures.push(message));
    failed.enqueueDiagnostic({ timestamp: 0, level: "ERROR", component: "sink",
      reason: "diagnosticSinkFailed", runId: "run" });
    await failed.flush();
    expect(failures).toEqual([expect.objectContaining({ reason: "diagnosticSinkFailed", count: 1 })]);
    expect(failed.enqueueDiagnostic({ timestamp: 1, level: "ERROR", component: "sink",
      reason: "diagnosticSinkFailed", runId: "run" })).toMatchObject({
      kind: "dropped", reason: "sinkUnavailable", count: 2,
    });
    await failed.flush();
    expect(appends).toBe(1);

    const held: DiagnosticFileSystem = {
      async mkdir() {}, async appendFile() { await new Promise<void>(() => {}); },
      async writeFile() {},
      async rename() {},
      async readFile() { return ""; }, async files() { return []; }, async unlink() {},
    };
    const bounded = new PersistentDiagnosticSink("/virtual", held, () => 0, () => {});
    let last;
    for (let index = 0; index <= 256; index += 1) last = bounded.enqueueDiagnostic({ timestamp: index,
      level: "WARN", component: "queue", reason: "diagnosticQueueOverflow", runId: "run", inputId: String(index) });
    expect(last).toMatchObject({ kind: "dropped", reason: "itemLimit", level: "WARN", count: 1 });
  });

  it("P2-A3-T07B contractBoundary / AC07: queue and JSON records enforce the 1 MiB byte budget independently of item count", async () => {
    const path = await directory();
    const sink = new PersistentDiagnosticSink(path, nodeDiagnosticFileSystem(), () => 1_000, () => {});
    const large = (index: number): DiagnosticEvent => ({ timestamp: 1_000, level: "WARN", reason: "xmlInvalid",
      component: "c".repeat(3_000), runId: "r".repeat(3_000), inputId: `${index}:${"i".repeat(3_000)}`,
      attemptId: "a".repeat(3_000) });
    for (let batch = 0; batch < 2; batch += 1) {
      for (let index = 0; index < 100; index += 1)
        expect(sink.enqueueDiagnostic(large(batch * 100 + index)).kind).toBe("accepted");
      await sink.flush();
    }
    const read = await sink.readDiagnostics({ limit: 256 });
    expect(read.truncated).toBe(true);
    expect(read.records.length).toBeLessThan(200);
    expect(read.encodedByteLength).toBe(Buffer.byteLength(JSON.stringify(read.records)));
    expect(read.encodedByteLength).toBeLessThanOrEqual(1024 * 1024);
    let last;
    for (let index = 0; index < 200; index += 1) last = sink.enqueueDiagnostic(large(200 + index));
    expect(last).toMatchObject({ kind: "dropped", reason: "byteLimit" });
    await sink.flush();
  });
});
