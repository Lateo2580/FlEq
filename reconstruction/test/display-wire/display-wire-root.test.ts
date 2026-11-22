import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { get } from "node:http";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import type { DisplayWireSnapshot } from "../../contracts/p4-display-wire.types";
import { startDisplayServer } from "../../src/http-sse/http-sse";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { projectDisplayWire } from "../../src/view-projector/display-wire";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { envelope, harnessedRoot, manualAdapter, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { decode, projectionInput, received, startup, step } from "../snapshot-sse/projection-fixture";
import { renderWire } from "./wire-client"; import { quietLosses } from "./display-wire-fixture";

// 旧の射影の戻り値を unchanged に固定する境界（P4-DW-T08）。各試験の前に戻す。
const forced = vi.hoisted(() => ({ unchanged: false }));
vi.mock("../../src/view-projector/view-projector", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/view-projector/view-projector")>();
  return { ...actual, projectSnapshot: (...args: Parameters<typeof actual.projectSnapshot>) => {
    const result = actual.projectSnapshot(...args);
    return forced.unchanged ? { kind: "unchanged" as const, state: result.state, diagnostics: result.diagnostics } : result;
  } };
});

const directories: string[] = [];
const harnesses: Harness[] = [];
beforeEach(() => { forced.unchanged = false; });
afterEach(async () => {
  forced.unchanged = false;
  await Promise.allSettled(harnesses.splice(0).map((h) => h.root.diagnostics.flush()));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const VXSE43 = readFileSync("test/fixtures/37_01_01_240613_VXSE43.xml", "utf8");
// 震源名だけが変わる続報（Serial を 1 つ進め、送信の時刻を 1 秒後へ）。
const renamed = (serial: number, name: string) => VXSE43.replace("<Serial>1</Serial>", `<Serial>${serial}</Serial>`)
  .replace(/<Name>豊後水道<\/Name>/, `<Name>${name}</Name>`).replace("2024-04-17T14:14:59Z", `2024-04-17T14:15:0${serial}Z`);

async function boot(server?: Awaited<ReturnType<typeof startDisplayServer>>) {
  const path = mkdtempSync(join(tmpdir(), "fleq-dw-"));
  directories.push(path);
  let at = { wallTimeMs: Date.parse("2024-04-17T23:15:00+09:00"), monotonicMs: 1 };
  const published: DisplaySnapshot[] = [], wires: DisplayWireSnapshot[] = [];
  const h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"), legacyStateDirectory: join(path, "old"),
    diagnosticDirectory: join(path, "diagnostics") }, linkedUnitCodecs, { clock: () => at, notificationAdapter: manualAdapter().adapter,
    display: { publish: (snapshot) => { published.push(snapshot); server?.publish(snapshot); },
      publishWire: (snapshot, urgent) => { wires.push(snapshot); server?.publishWire(snapshot, urgent); }, flushWire: () => server?.flushWire() } });
  harnesses.push(h);
  await startHarness(h, "dw", at);
  let sequence = 0;
  const send = (xml: string) => submit(h, envelope("dw", "VXSE43", `dw-${++sequence}`, Buffer.from(xml), at, sequence));
  return { h, published, wires, send, move: (ms: number) => { at = { wallTimeMs: at.wallTimeMs + ms, monotonicMs: at.monotonicMs + ms }; return at; } };
}
type Stream = { response: IncomingMessage; frames: string[] };
function open(port: number, path: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const request = get({ host: "127.0.0.1", port, path, agent: false }, (response) => {
      const stream: Stream = { response, frames: [] };
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) { stream.frames.push(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
      });
      response.on("error", () => {});
      resolve(stream);
    });
    request.on("error", reject);
  });
}
const dataOf = (frame: string) => frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
const until = async (check: () => boolean) => { for (let index = 0; index < 200 && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 5)); };

// 受入条件 P4-DW-AC01（新しい経路）。
describe("P4-DW-T08 acceptance: the new path", () => {
  it("carries the twelve domains and the common part, and the follow-up with a new hypocenter name publishes on both paths", async () => {
    const t = await boot();
    await t.send(VXSE43);
    const first = t.wires.at(-1)!;
    expect(Object.keys(first.current)).toEqual(["eew", "tsunami", "earthquake", "weatherCurrent", "weatherTimeseries", "nankai", "volcano", "landslide", "flood", "briefing",
      "localBulletins", "typhoon"]);
    for (const [key, domain] of Object.entries(first.current))
      expect(Object.keys(domain)).toEqual(["eew", "tsunami", "earthquake"].includes(key) ? ["unit", "contentRevision", "items", "wire", "cards"]
        : ["unit", "contentRevision", "items", "delivery", "wire", "cards"]);
    expect(JSON.stringify(first.current)).not.toContain('"view"');
    expect(first.current.eew.wire.cards[0]).toMatchObject({ letter: "A", hypo: { text: "豊後水道" } });
    expect(renderWire(first)).toEqual({ kind: "rendered", sequence: first.sequence });
    expect(renderWire({ ...first, schemaVersion: 1 })).toEqual({ kind: "unsupported", version: 1 });
    // カードの ref をそのまま詳細の要求にすると、urgent の owner が同じ式で作り直した rev と合って 1 ページを返す（P4-DW-AC08）。
    const ref = first.current.eew.wire.cards[0].ref;
    const asked = t.h.root.requestDetail({ streamId: first.streamId, detail: { unit: "U-E", part: "areas", id: ref.id, revision: ref.rev, page: 0 } });
    await t.h.settle();
    expect(await asked.response).toMatchObject({ kind: "ok", part: "areas", id: ref.id, revision: ref.rev, itemCount: 9, omitted: [] });
    asked.done();
    const [old, wired] = [t.published.length, t.wires.length];
    await t.send(renamed(2, "四国沖"));
    // 受信の step と保存の完了の step で、どちらの経路も公開する。
    expect(t.published.length).toBeGreaterThan(old);
    expect(t.wires.length).toBeGreaterThan(wired);
    expect(t.wires.at(-1)!.current.eew.wire.cards[0].hypo?.text).toBe("四国沖");
  });

  it("publishes the new path from its own previous snapshot while the old projector is held at unchanged", async () => {
    const t = await boot();
    await t.send(VXSE43);
    forced.unchanged = true;
    const [old, wired] = [t.published.length, t.wires.length];
    await t.send(renamed(2, "四国沖"));
    expect(t.published.length).toBe(old);
    expect(t.wires.length).toBeGreaterThan(wired);
    expect(t.wires[wired].sequence).toBe(t.wires[wired - 1].sequence + 1);
    expect(t.wires.at(-1)!.current.eew.wire.cards[0].hypo?.text).toBe("四国沖");
  });

  // 実際の不具合の再発防止（ヘルツ H1）: 停止の確定（finalizeDone）で失効した EEW の表示差分は publisher の射影に渡らない。次の公開で
  // view を記録と照らし、失効したカードと区域を消す。
  it("drops an EEW that expires inside the shutdown finalization from the next publication", async () => {
    const t = await boot();
    await t.send(VXSE43);
    expect(t.wires.at(-1)!.current.eew.wire.cards).toHaveLength(1);
    const stopAt = t.move(600_000);
    await t.h.root.shutdownRuntime(0, stopAt);
    await t.h.settle();
    const last = t.wires.at(-1)!;
    expect(t.h.root.state.mirror["U-E"].view.unit === "U-E" && t.h.root.state.mirror["U-E"].view.current).toEqual([]);
    expect([last.current.eew.wire.cards, last.current.eew.wire.composites, last.current.eew.wire.omitted]).toEqual([[], [[]], 0]);
  });

  // 実際の不具合の再発防止 P4-DV-T06（台帳 147、保護 3 分野）: 包みの件数の見出しも新しい経路の差分から数えるので、停止の確定で回収した EEW を数えない。
  it("counts no active EEW in the items after the shutdown finalization collects it", async () => {
    const t = await boot();
    await t.send(VXSE43);
    expect(t.wires.at(-1)!.current.eew.items[0].activeCount).toBe(1);
    const stopAt = t.move(600_000);
    await t.h.root.shutdownRuntime(0, stopAt);
    await t.h.settle();
    expect(t.wires.at(-1)!.current.eew.items[0].activeCount).toBe(0);
  });

  // 本契約の後は 12 分野とも新しい経路に載るので、旧だけが変わる受信の step は組めない（表 §5.4）。旧の射影の入力だけを変え、新しい経路の入力
  // （差分・views・共通部）が前と同じ step で、旧が projected でも新しい経路は unchanged（P4-DW-T08 の条文、P4-DV-AC07 (3)）。
  it("does not publish the new path for a step that changes only the old projector's input", async () => {
    const at = { wallTimeMs: Date.parse("2026-06-05T17:00:00+09:00"), monotonicMs: 1 };
    const started = await startup(at);
    const before = projectionInput(started, at.wallTimeMs);
    const old = projectSnapshot(before, null);
    const views = { eew: before.eew, tsunami: before.tsunami, earthquake: before.earthquake, weatherCurrent: before.weatherCurrent, weatherTimeseries: before.weatherTimeseries,
      nankai: before.nankai, volcano: before.volcano, landslide: before.landslide, flood: before.flood, briefing: before.briefing, localBulletins: before.localBulletins,
      typhoon: before.typhoon };
    const first = projectDisplayWire({ projection: before, views, confirmation: before.confirmation, notices: old.state.notices, removalLoss: quietLosses }, null);
    const next = await step(started.state, received(started.state.runId, decode("81_02_01_260605_VPWP50_high_severity", "VPWP50"), { ...at, wallTimeMs: at.wallTimeMs + 1000 }));
    // 旧の射影には U-F の変わった step を渡す。
    const after = { ...projectionInput(next, at.wallTimeMs + 1000), persistence: before.persistence, generatedAt: before.generatedAt };
    const oldNext = projectSnapshot(after, old.state);
    expect(oldNext.kind).toBe("projected");
    const wireNext = projectDisplayWire({ projection: { ...before, displayChanges: [] }, views, confirmation: before.confirmation, notices: old.state.notices, removalLoss: quietLosses }, first.state);
    expect(wireNext.kind).toBe("unchanged");
  });

  it("serves /events byte for byte as the projector's output, and the new SSE path with one serialization per publish", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null } });
    try {
      const [events, wireA, wireB] = await Promise.all([open(server.port, "/events"), open(server.port, "/api/display/wire/events"), open(server.port, "/api/display/wire/events")]);
      const t = await boot(server);
      const stringify = vi.spyOn(JSON, "stringify");
      await t.send(VXSE43);
      // 待つ側の公開（P4-DC-AC04）は保留に入るので出してから比べる。比べる相手は最後に書かれた snapshot、直列化は書いた公開ごとに 1 回（P4-DC-AC08 (4)）。
      server.flushWire();
      const written = t.wires.filter((wire) => stringify.mock.calls.some(([value]) => value === wire));
      const wireCalls = written.map((wire) => stringify.mock.calls.filter(([value]) => value === wire).length);
      stringify.mockRestore();
      const lastWritten = written.at(-1)!;
      const last = (stream: Stream) => stream.frames.length === 0 ? null : dataOf(stream.frames.at(-1)!);
      await until(() => last(events) === JSON.stringify(t.published.at(-1)) && last(wireA) === JSON.stringify(lastWritten) && last(wireB) === last(wireA));
      expect(dataOf(events.frames.at(-1)!)).toBe(JSON.stringify(t.published.at(-1)));
      expect(dataOf(wireA.frames.at(-1)!)).toBe(JSON.stringify(lastWritten));
      expect(dataOf(wireB.frames.at(-1)!)).toBe(dataOf(wireA.frames.at(-1)!));
      expect(wireCalls).toEqual(written.map(() => 1));
      // heartbeat は旧の /events と同じ 15 秒ごとに、新しい経路にも同じ形で来る。
      const beats = (stream: Stream) => stream.frames.filter((frame) => frame.startsWith("event: heartbeat")).length;
      const [oldBeats, wireBeats] = [beats(events), beats(wireA)];
      vi.advanceTimersByTime(15_000);
      await until(() => beats(events) > oldBeats && beats(wireA) > wireBeats);
      const beat = JSON.parse(dataOf(wireA.frames.filter((frame) => frame.startsWith("event: heartbeat")).at(-1)!));
      expect(beat).toMatchObject({ worker: { state: "healthy" }, latestVersion: { sequence: lastWritten.sequence } });
      for (const stream of [events, wireA, wireB]) stream.response.destroy();
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });
});
