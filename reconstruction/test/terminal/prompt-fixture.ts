import { readFileSync } from "node:fs";

import type { ClockReading, WallBasis } from "../../contracts/p2-shared-runtime.types";
import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import type { HostStatus } from "../../contracts/p3-cli-repl.types";
import type { CheckpointFileSystem, WritableCheckpoint } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import type { RuntimeMirror } from "../../src/runtime/shared-runtime";
import { currentItems } from "../../src/terminal/prompt-current";
import type { TerminalOptions } from "../../src/terminal/output";
import { envelope, harnessedRoot, startHarness, submit } from "../execution-split/owner-harness";
import { harness } from "./terminal-fixture";

// P3-TERMINAL-PROMPT-001 の試験の共通: 製品の publisher と in-process の owner を通した mirror を、root の project から端末の sink へ渡す。
// host の口の 1 行だけは prompt-host.test.ts が本物の host で確かめる。

class MemoryFiles implements CheckpointFileSystem {
  readonly files = new Map<string, Uint8Array>();
  unlinkSync(path: string): void { this.files.delete(path); }
  readFile(path: string): Uint8Array | null { return this.files.get(path) ?? null; }
  async mkdir(): Promise<void> {}
  async open(path: string): Promise<WritableCheckpoint> {
    let bytes = new Uint8Array();
    return { write: async (value) => { bytes = value.slice(); }, sync: async () => {}, close: async () => { this.files.set(path, bytes); } };
  }
  async rename(from: string, to: string): Promise<void> { this.files.set(to, this.files.get(from)!); this.files.delete(from); }
  async syncDirectory(): Promise<void> {}
}
class MemoryDiagnostics implements DiagnosticFileSystem {
  readonly lines = new Map<string, string>();
  async mkdir(): Promise<void> {}
  async appendFile(path: string, data: string): Promise<void> { this.lines.set(path, (this.lines.get(path) ?? "") + data); }
  async readLastByte(path: string): Promise<number | null> { return Buffer.from(this.lines.get(path) ?? "").at(-1) ?? null; }
  async writeFile(path: string, data: string): Promise<void> { this.lines.set(path, data); }
  async rename(from: string, to: string): Promise<void> { this.lines.set(to, this.lines.get(from) ?? ""); this.lines.delete(from); }
  async readFile(path: string): Promise<string> { return this.lines.get(path) ?? ""; }
  async files(): Promise<readonly { name: string; size: number; mtimeMs: number }[]> { return []; }
  async unlink(path: string): Promise<void> { this.lines.delete(path); }
}
const config = { appName: "fleq-p3", stateDirectory: "prompt-state", legacyAppName: "fleq", legacyStateDirectory: "legacy-state",
  diagnosticDirectory: "prompt-diagnostics" } as const;

const fixture = (path: string): string => readFileSync(`test/fixtures/${path}.xml`, "utf8");
const reportMs = (xml: string): number => Date.parse(/<ReportDateTime>([^<]*)</.exec(xml)![1]);
const same = (xml: string): string => xml;

type WorldOptions = Readonly<{ startMs?: number; files?: MemoryFiles; basis?: { value: WallBasis }; status?: Partial<HostStatus>;
  terminal?: TerminalOptions }>;

async function world(options: WorldOptions = {}) {
  const startMs = options.startMs ?? Date.parse("2020-01-01T00:00:00+09:00");
  let now: ClockReading = { wallTimeMs: startMs, monotonicMs: 1_000 };
  const moveTo = (wallTimeMs: number) => { now = { wallTimeMs, monotonicMs: now.monotonicMs + Math.max(1, wallTimeMs - now.wallTimeMs) }; };
  const clock = () => now;
  const snapshots: DisplaySnapshot[] = [];
  const t = harness({ clock, ...options.terminal }, options.status);
  const h = harnessedRoot(config, linkedUnitCodecs, { clock, checkpointFileSystem: options.files ?? new MemoryFiles(), diagnosticFileSystem: new MemoryDiagnostics(),
    display: { publish: (snapshot) => { snapshots.push(snapshot); }, mirror: (mirror) => { t.output.sink.mirror(mirror); } },
    onInputDone: (reply) => { t.output.sink.inputDone(reply); },
    ...options.basis == null ? {} : { wallBasis: () => options.basis!.value, contentBasis: () => options.basis!.value } });
  await startHarness(h, "prompt", now);
  t.attach();
  let sequence = 0;
  h.root.attachSequence(() => ++sequence, () => sequence);
  return {
    h, t, snapshots, get now() { return now; }, moveTo,
    mirror: (): RuntimeMirror => h.root.state.mirror,
    label: (mode: "clock" | "elapsed" | "uptime" = "clock") => t.output.control.promptLabel(mode),
    items: () => currentItems(h.root.state.mirror, new WeakMap()),
    // 報の時刻の 1 秒後に受ける（時計より前の報でも時計は戻さない）。
    async send(path: string, transform: (xml: string) => string = same, headType = /(V[A-Z]{3}\d\d)/.exec(path)![1]) {
      const xml = transform(fixture(path));
      moveTo(Math.max(now.wallTimeMs, reportMs(xml) + 1_000));
      const at = ++sequence;
      await submit(h, envelope(h.root.state.runId, headType, `input-${at}`, Buffer.from(xml), now, at));
    },
    async tick(wallTimeMs: number) {
      moveTo(wallTimeMs);
      h.root.mailbox.recordWorkerResponse(now.monotonicMs);
      h.root.tick(now);
      await h.settle();
    },
    async save() { await h.root.driveCheckpoint(); await h.settle(); await h.root.diagnostics.flush(); },
    close: () => t.output.close(),
  };
}

export { MemoryFiles, fixture, reportMs, world };
