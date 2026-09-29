import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import { parseDisplaySnapshot, parseHeartbeatWorker, replaceDisplaySnapshot } from "../../src/display/chrome-eew/pure";

function snapshot(streamId: string, sequence: number): DisplaySnapshot {
  const item = (operation: "normal" | "training" | "test") => ({ operation, informationType: "eew" as const,
    activeCount: 0, highestSeverity: null, areaCounts: {}, updatedAt: null, admission: {}, unavailable: {},
    unconfirmed: {}, unknownCode: {}, freshness: {}, confirmation: { state: "unconfirmed" as const, confirmedAt: null } });
  const items = [item("normal"), item("training"), item("test")] as const;
  const summary = { contentRevision: "0", items, delivery: "summary" as const, reason: "snapshotBudget" as const,
    originalBytes: 0, budgetBytes: 0 };
  return {
    schemaVersion: 1, streamId, sequence, generatedAt: "2024-04-17T14:15:30.000Z", semanticRevision: "0",
    connection: { state: "connected", disconnectedAt: null, lastInputAt: null },
    worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null },
    persistence: {}, recovery: { "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" } },
    channels: { desktop: "available", sound: "available" },
    current: { eew: { unit: "U-E", ...summary }, weatherCurrent: { unit: "U-W", ...summary },
      weatherTimeseries: { unit: "U-F", ...summary } },
    notices: [],
  };
}

// P2-A9-T01 contractBoundary (AC01): 最新完全snapshot一枚だけを置換する。受信・再接続の実経路はsmokeで見る。
describe("P2-A9-T01 replaceDisplaySnapshot", () => {
  it("replaces on a higher sequence or a new stream, and keeps the current on a duplicate or older sequence", () => {
    const current = snapshot("s1", 5);
    const higher = snapshot("s1", 6);
    const restarted = snapshot("s2", 1);
    expect(replaceDisplaySnapshot(null, current)).toBe(current);
    expect(replaceDisplaySnapshot(current, higher)).toBe(higher);
    expect(replaceDisplaySnapshot(current, restarted)).toBe(restarted);
    expect(replaceDisplaySnapshot(current, snapshot("s1", 5))).toBe(current);
    expect(replaceDisplaySnapshot(current, snapshot("s1", 3))).toBe(current);
  });
});

// P2-A9-T01 contractBoundary (AC01): A9が読む構造の欠けたsnapshotを完全snapshotと見なさない。
describe("P2-A9-T01 parseDisplaySnapshot", () => {
  it("accepts a complete snapshot and rejects broken JSON or an identity-only object", () => {
    const complete = snapshot("s", 1);
    expect(parseDisplaySnapshot(JSON.stringify(complete))).toEqual(complete);
    expect(parseDisplaySnapshot("{")).toBeNull();
    expect(parseDisplaySnapshot(JSON.stringify({ schemaVersion: 1, streamId: "s", sequence: 1 }))).toBeNull();
  });
});

// P2-A9-T06 contractBoundary (AC09): heartbeatは境界で検証し、壊れたJSON・4値以外のworker.stateを採らない。
describe("P2-A9-T06 parseHeartbeatWorker", () => {
  it("accepts only a well-formed worker with one of the four states", () => {
    const worker = { state: "stopped", lastProgressAtMonotonicMs: 1, lastResponseAtMonotonicMs: null };
    expect(parseHeartbeatWorker(JSON.stringify({ worker, latestVersion: null, emittedAt: 0 }))).toBe("stopped");
    expect(parseHeartbeatWorker("{")).toBeNull();
    expect(parseHeartbeatWorker(JSON.stringify({ worker: { ...worker, state: "ok" } }))).toBeNull();
  });
});

// P2-A9-T05 contractBoundary (AC08 静的検査): HTMLとして解釈させるAPIと属性・script文字列の組立てをsrcから0件に保つ。
// class名・style値がwire文字列から組み立てられていないこと (固定表の値と固定geometryの数値だけ) は正規表現で
// 検出できないので、client.tsのel()呼び出しとstyle代入を手検査で確認済み (2026-09-29)。
describe("P2-A9-T05 forbidden HTML-interpreting APIs", () => {
  it("has zero occurrences in reconstruction/src/display/chrome-eew", () => {
    const dir = join(__dirname, "../../src/display/chrome-eew");
    const forbidden = [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /setHTMLUnsafe/, /parseHTMLUnsafe/, /document\.write/,
      /DOMParser/, /createContextualFragment/, /srcdoc/, /setAttribute/, /cssText/, /\.on[a-z]+\s*=/,
      /\[\s*["'`]on[a-z]+["'`]\s*\]/, /<[^>]*\son[a-z]+\s*=/, /\beval\(/, /\bFunction\(/];
    const hits = readdirSync(dir).filter((name) => /\.(ts|html)$/.test(name)).flatMap((name) => {
      const text = readFileSync(join(dir, name), "utf8");
      return forbidden.filter((pattern) => pattern.test(text)).map((pattern) => `${name}: ${pattern}`);
    });
    expect(hits).toEqual([]);
  });
});
