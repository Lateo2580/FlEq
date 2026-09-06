import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  createReplaySideEffects,
  prepareReplayStateDir,
  stateRelative,
} from "../../../src/engine/replay/replay-side-effects";

const CREATED: string[] = [];

afterEach(() => {
  for (const path of CREATED.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Phase 1 replay isolation", () => {
  it("marker と全 path を指定 state-dir 内に閉じ込め、空でない directory を拒否する", () => {
    const stateDir = resolve(`.tmp-replay-isolation-${process.pid}-${Date.now()}`);
    CREATED.push(stateDir);
    const prepared = prepareReplayStateDir(stateDir);
    expect(prepared).toBe(stateDir);
    expect(readFileSync(resolve(stateDir, ".fleq-replay"), "utf8")).toContain("scenario=vpbs50-fixed-2");
    expect(stateRelative(stateDir, resolve(stateDir, "events.jsonl"))).toBe("events.jsonl");
    expect(() => stateRelative(stateDir, resolve("data/runtime"))).toThrow(/escaped/);
    expect(() => prepareReplayStateDir(stateDir)).toThrow(/must be empty/);
  });

  it("production roots を拒否し、no-op logger/notifier は constructor 無しで attempt を数える", () => {
    expect(() => prepareReplayStateDir("data/runtime/replay"))
      .toThrow(/production runtime root/);
    expect(() => prepareReplayStateDir("eew-logs/replay"))
      .toThrow(/production runtime root/);
    const effects = createReplaySideEffects();
    expect(Object.getOwnPropertyNames(effects.eewLogger)).toEqual([]);
    expect(Object.getOwnPropertyNames(effects.notifier)).toEqual([]);
    effects.notifier.notifyWeatherBriefing = vi.fn(effects.notifier.notifyWeatherBriefing);
    effects.notifier.notifyWeatherBriefing({} as never);
    expect(effects.notifications).toEqual({ attempts: 1, suppressed: 1 });
    expect(existsSync(resolve("eew-logs"))).toBe(false);
  });

  it("replay の transitive module graph に REST/WS/connection manager/monitor runtime を含めない", () => {
    const visited = new Set<string>();
    const visit = (path: string): void => {
      if (visited.has(path)) return;
      visited.add(path);
      const source = readFileSync(path, "utf8");
      const imports = [
        ...source.matchAll(/^\s*import\s+(?!type\b)[^;]*?\sfrom\s+(["'])(\.[^"']+)\1/gm),
        ...source.matchAll(/^\s*import\s+(["'])(\.[^"']+)\1/gm),
      ].map((match) => match[2]!);
      for (const specifier of imports) {
        const base = resolve(dirname(path), specifier);
        const next = [base, `${base}.ts`, `${base}.svelte.ts`, resolve(base, "index.ts")]
          .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
        if (next != null) visit(next);
      }
    };
    visit(resolve("src/engine/cli/cli.ts"));
    const relativeModules = [...visited].map((path) => path.slice(resolve(".").length + 1));
    expect(relativeModules).toContain("src/engine/cli/cli-replay.ts");
    expect(relativeModules).not.toContain("src/engine/replay/vpbs50-runner.ts");
    expect(relativeModules).not.toContain("src/dmdata/rest-client.ts");
    expect(relativeModules).not.toContain("src/dmdata/ws-client.ts");
    expect(relativeModules).not.toContain("src/dmdata/multi-connection-manager.ts");
    expect(relativeModules).not.toContain("src/engine/monitor/monitor.ts");
    expect(relativeModules).not.toContain("src/engine/cli/cli-run.ts");
  });

  it("canonical JSON は object key だけを正規化し配列順と意味値を保持する", () => {
    expect(canonicalJson({ z: 1, a: [{ y: 2, x: 3 }] }))
      .toBe('{\n  "a": [\n    {\n      "x": 3,\n      "y": 2\n    }\n  ],\n  "z": 1\n}\n');
  });
});
