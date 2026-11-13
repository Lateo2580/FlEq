import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ClockReading, PersistenceStatus, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { CheckpointFileSystem } from "../../src/checkpoint/checkpoint";
import { linkedUnitCodecs, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { runtimeUnits } from "../../src/runtime/unit-coverage";
import { recordingNotificationAdapter } from "../checkpoint-shutdown/runtime-fixture";
import { envelope, harnessedRoot, park, startHarness, submit, unitBodies } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";

// P3-FINAL-GATE-001 発注 1 の T03（AC05 (1)）: 12 unit を全部 dirty にした最終の形の結線（本物の unit 表と codec、owner 4 本）で、E20 の場面のうち
// owner の停止を除く 4 つ（通常終了・保存不能・batch 残存・終了中の遅い ack）を起こし、§5.9 の段の順・各 unit の最終世代の確認・終了 code を見る。
// owner の停止の場面は P3-OWNER-REBUILD-001 の配送の後（発注 3）にこの file へ足す。

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function config() {
  const path = mkdtempSync(join(tmpdir(), "fleq-c22-"));
  directories.push(path);
  return { appName: "fleq-p3", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") } as const;
}

const unsaved = (status: PersistenceStatus) => status.savedGeneration !== status.currentGeneration;
const reportTime = (body: Uint8Array) => Date.parse(/<ReportDateTime>([^<]+)<\/ReportDateTime>/.exec(Buffer.from(body).toString("utf8"))![1]);

type Scene = Readonly<{
  // 最終保存でも open が ENOSPC で失敗する unit（保存不能）。
  unsaveable?: RuntimeUnitId;
  // running の段の保存を失敗させない unit（遅い ack の場面の U-W）。
  saving?: RuntimeUnitId;
  // 12 本の後に入れる報（test/fixtures の名前と headType）。
  extra?: readonly Readonly<{ headType: string; file: string }>[];
  // この unit の最初の保存の open を、during が gate を開くまで止める（遅い ack。返信の順は変えない）。
  gated?: RuntimeUnitId;
  // 全部の入力の後、shutdownRuntime の前。
  ready?: (h: Harness) => void;
  // shutdownRuntime を呼んだ後、要約を待つ前。open は止めた保存を進める。
  during?: (h: Harness, open: () => void) => Promise<void> }>;

// 12 unit の報を各報の時刻（ReportDateTime の 1 秒後）の時計で running の段に採らせ、その段の保存は open で失敗させて最終保存の段まで dirty に
// 残す（running の段の入力はすぐ保存される、P3-UWR-AC03。C3b の P3-C3B-T05 の failingOpen と同じ条件）。1 つの時計では古い報の unit が採らない。
async function scene(options: Scene = {}) {
  const settings = config();
  const summaryPath = join(settings.diagnosticDirectory, "shutdown-summary.json");
  const order: string[] = [];
  let atFinalize: Partial<Record<RuntimeUnitId, PersistenceStatus>> = {};
  let running = true;
  let now: ClockReading = { wallTimeMs: 0, monotonicMs: 1 };
  const files = nodeCheckpointFileSystem();
  let openGate = () => {};
  let gate: Promise<void> | null = options.gated == null ? null : new Promise<void>((done) => { openGate = done; });
  const checkpointFileSystem: CheckpointFileSystem = { ...files, open: async (path) => {
    if (gate != null && options.gated != null && path.includes(options.gated)) {
      // owner-harness の park: settle() はこの呼出しを待たない（P3-UWR-AC10(8)）。
      const waiting = park(gate);
      gate = null;
      await waiting;
    }
    const fails = options.unsaveable != null && path.includes(options.unsaveable) || running && (options.saving == null || !path.includes(options.saving));
    if (fails) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    return files.open(path);
  } };
  const h: Harness = harnessedRoot(settings, linkedUnitCodecs, { notificationAdapter: recordingNotificationAdapter(), clock: () => now, checkpointFileSystem,
    shutdownHooks: {
      drainMailbox: (_deadline, active) => h.root.drainInputs(active),
      // 副作用固定の段（drain・shutdownInput の後、最終保存の前）での各 unit の保存の状態。
      finalizeBatchesAndSideEffects: async () => {
        atFinalize = Object.fromEntries(runtimeUnits.map((unit) => [unit, h.root.state.mirror[unit].persistence]));
        return { batches: 0, notificationAttempts: 0 };
      },
      closeWorker: async () => { order.push(existsSync(summaryPath) ? "closeAfterSummary" : "closeBeforeSummary"); } } });
  h.holdRequests((_place, request) => {
    if (!running && ["input", "shutdownInput", "finalize", "checkpointGrant"].includes(request.kind)) order.push(request.kind);
    return false;
  });
  const inputs = [...runtimeUnits.map((unit) => ({ headType: unitBodies[unit].headType, body: unitBodies[unit].body, id: `dirty-${unit}` })),
    ...(options.extra ?? []).map((item, index) => ({ headType: item.headType, body: readFileSync(`test/fixtures/${item.file}.xml`), id: `extra-${index}` }))]
    .sort((a, b) => reportTime(a.body) - reportTime(b.body));
  now = { wallTimeMs: reportTime(inputs[0].body), monotonicMs: 1 };
  await startHarness(h, "run", now);
  let sequence = 0;
  for (const input of inputs) {
    const wallTimeMs = reportTime(input.body) + 1_000;
    now = { wallTimeMs, monotonicMs: now.monotonicMs + Math.max(1, wallTimeMs - now.wallTimeMs) };
    await submit(h, envelope("run", input.headType, input.id, input.body, now, ++sequence));
  }
  options.ready?.(h);
  running = false;
  const stopping = h.root.shutdownRuntime(sequence, now);
  await options.during?.(h, openGate);
  const summary = await stopping;
  await h.root.diagnostics.flush();
  const persistence = Object.fromEntries(runtimeUnits.map((unit) => [unit, h.root.state.mirror[unit].persistence]));
  const savedUnits = runtimeUnits.filter((unit) => !unsaved(h.root.state.mirror[unit].persistence));
  // 前提: 最終保存の段の前に 12 unit が全部 dirty（遅い ack の場面の U-W は ack を止めた保存の後の世代で dirty）。
  expect(runtimeUnits.filter((unit) => atFinalize[unit] == null || !unsaved(atFinalize[unit]))).toEqual([]);
  // E20: 保存を確かめていない code 0 は 0（code 0 なら全 unit の最終世代が保存済みで、要約の persistence も同じ）。
  // owner の持つ世代とも照らす（publisher の写しだけで保存済みと読まない）。
  if (summary.code === 0) expect([savedUnits, summary.persistence, runtimeUnits.filter((unit) => unsaved(h.unit(unit).persistence)
    || h.unit(unit).persistence.currentGeneration !== persistence[unit].currentGeneration)]).toEqual([[...runtimeUnits], persistence, []]);
  return { h, summary, order, savedUnits };
}

// §5.9 の段の順: drain の入力 → 各 owner の shutdownInput → finalize → 最終保存の権（dirty の unit ごと）→ 要約の記録 → owner の終了。
function expectStageOrder(order: readonly string[], grants: number) {
  const first = (kind: string) => order.indexOf(kind), last = (kind: string) => order.lastIndexOf(kind);
  expect(["shutdownInput", "finalize", "checkpointGrant"].map((kind) => order.filter((item) => item === kind).length)).toEqual([4, 4, grants]);
  expect([last("input") < first("shutdownInput"), last("shutdownInput") < first("finalize"), last("finalize") < first("checkpointGrant"),
    last("checkpointGrant") < first("closeAfterSummary"), order.includes("closeBeforeSummary")]).toEqual([true, true, true, true, false]);
}

describe("P3-FG-T03 E20 on the 12 linked units (order 1: four scenes)", () => {
  it("P3-FG-T03 acceptance / AC05 (1): normal, unsaveable, batch left open and a late ack during shutdown", async () => {
    // (1) 通常終了: 12 unit の最終世代が最終保存の段で全部保存されてから要約、owner の終了。code 0。
    {
      const { summary, order } = await scene();
      expect(summary).toMatchObject({ code: 0, reasons: [] });
      expectStageOrder(order, 12);
    }
    // (2) 保存不能: U-Q（seismic の owner）の最終保存が ENOSPC で失敗する。code 2、ほかの 11 unit は保存済み。
    {
      const { summary, savedUnits, order } = await scene({ unsaveable: "U-Q" });
      expect(summary).toMatchObject({ code: 2, reasons: ["finalCheckpoint:unsavedUnits"] });
      expect(savedUnits).toEqual(runtimeUnits.filter((unit) => unit !== "U-Q"));
      expect(order.filter((kind) => kind === "checkpointGrant").length).toBeGreaterThanOrEqual(12);
    }
    // (3) batch 残存: 採った VFVO53 の batch（P3-C9-BATCH）が開いたまま停止に入る。U-V の shutdownInput が終了理由 shutdown の無音の flush で
    // 閉じ（spec §5.9 の 3）、その後の世代が保存される。code 0。
    {
      const { h, summary, order } = await scene({ extra: [{ headType: "VFVO53", file: "66_01_01_210517_VFVO53" }],
        ready: (h) => { expect(h.unit("U-V").batch?.subjects).toEqual(["normal/VFVO53/506"]); } });
      // U-V の shutdownInput は batch の有無によらず batchCompleted（shutdown）を返すので、停止の前に開いていた batch が停止の後に無いことで見る。
      // 閉じた batch の subjects は空: 停止の時計（後の報の 2026 年）では VFVO53 の記録の期限が過ぎ、flush の前の期限の適用で active でない。
      const closed = h.delivered.flatMap(({ reply }) => reply.kind === "shutdownInputDone" ? reply.output.outcomes : [])
        .filter((item) => item.unit === "U-V" && item.outcome.kind === "batchCompleted");
      expect(closed.map((item) => item.outcome.kind === "batchCompleted" ? item.outcome.reason : null)).toEqual(["shutdown"]);
      expect(h.unit("U-V").batch).toBeNull();
      expect(h.unit("U-V").intents.filter((intent) => intent.subject.includes("VFVO53"))).toEqual([]);
      expect(summary).toMatchObject({ code: 0, reasons: [] });
      expectStageOrder(order, 12);
    }
    // (4) 終了中の遅い ack: running の段で採った U-W の報の保存の I/O を停止の後まで止める。その後の U-W の報（自分の保存中の留保で drain の段に
    // 送られる、P3-UWR-AC07）が新しい世代を作り、遅れた ack は前の世代だけを保存済みにし、最終保存の段が新しい世代を保存する。code 0。
    {
      const seen: { before: PersistenceStatus | null } = { before: null };
      const { h, summary, order } = await scene({ saving: "U-W", gated: "U-W", extra: [{ headType: "VPWW55", file: "18_00_01_260830_VPWW55_fukui_L5" }],
        during: async (h, open) => {
          await h.settle();
          // 書込み権は U-W の最初の保存に出たまま（ack が来ていない）で、drain の段の報は採られている。
          expect(h.root.checkpoint.grantOf("U-W")?.unit).toBe("U-W");
          seen.before = h.root.state.mirror["U-W"].persistence;
          open();
        } });
      const status = h.root.state.mirror["U-W"].persistence;
      // 止めた保存の前の世代は 0 で、drain の報が世代を進めている（止めた保存の世代 1 より後）。
      expect([seen.before?.savedGeneration, (seen.before?.currentGeneration ?? 0) > 1]).toEqual([0, true]);
      expect([status.currentGeneration >= (seen.before ?? status).currentGeneration, status.savedGeneration]).toEqual([true, status.currentGeneration]);
      expect(summary).toMatchObject({ code: 0, reasons: [] });
      expect(order.filter((kind) => kind === "input")).toEqual(["input"]);
      expectStageOrder(order, 12);
    }
  });
});
