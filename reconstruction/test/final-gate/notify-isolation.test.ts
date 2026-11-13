import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ClockReading, NotificationResult, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAbortRequest, NotificationAttempt, NotificationChannel, NotificationPriorityGroup } from "../../contracts/p2-notification-delivery.types";
import { linkedUnitCodecs } from "../../src/runtime/composition-root";
import { executionPlaces, runtimeUnits } from "../../src/runtime/unit-coverage";
import { envelope, harnessedRoot, startHarness, submit, unitBodies } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";

// P3-FINAL-GATE-001 発注 2 の T04（AC06）: 最終の形の結線（本物の unit 表と codec、owner 4 本）に unitBodies の 12 本を流し、1 つの channel の adapter が
// abort を無視して隔離された後も、もう一方の channel と受理・保存が止まらないことを、本物の 12 unit が作った intent で確かめる。故障の種類ごとの振る舞い・
// 群の順・満杯の採否は既存の試験が持つ（AC06 の担い手の分け）。

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function config() {
  const path = mkdtempSync(join(tmpdir(), "fleq-c22-t04-"));
  directories.push(path);
  return { appName: "fleq-p3", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") } as const;
}

const reportTime = (body: Uint8Array) => Date.parse(/<ReportDateTime>([^<]+)<\/ReportDateTime>/.exec(Buffer.from(body).toString("utf8"))![1]);
// intent の ID は JSON の配列で、6 番目が channel（P3-NL-AC01）。
const channelOf = (id: string) => (JSON.parse(id) as readonly string[])[5];
const groupOf = (unit: RuntimeUnitId): NotificationPriorityGroup => unit === "U-E" ? "normalEew" : unit === "U-T" ? "normalTsunamiEmergency" : "other";
// unitBodies の報で intent を作る unit: U-F は通知を作らず、U-W（VPWW57）・U-L（VPWW56）の報は desktop だけ（Q-FG-ORDER2-PRECHECK の (3)）。
const makes = (channel: NotificationChannel) => runtimeUnits.filter((unit) => unit !== "U-F" && (channel === "desktop" || unit !== "U-W" && unit !== "U-L"));

// 壊す channel の run は settle せずに abort を待ち、abort を受けたら stopped false で 1 回だけ settle する（停止を確かめられない adapter）。4 番目の
// 引数 onLateStop は呼ばない（閉じない player。戻る道は P3-NFR-T01・T05）。もう一方の channel の run はすぐ delivered を返す。
function brokenAdapter(broken: NotificationChannel) {
  const runs: NotificationAttempt[] = [];
  const open = new Map<string, (result: NotificationResult) => void>();
  return { runs,
    run: (attempt: NotificationAttempt, clock: () => ClockReading) => {
      runs.push(attempt);
      const base = { attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel };
      if (attempt.channel !== broken) return Promise.resolve<NotificationResult>({ ...base, kind: "delivered", completedAt: clock() });
      return new Promise<NotificationResult>((resolve) => { open.set(attempt.attemptId, resolve); });
    },
    abort: async (request: NotificationAbortRequest, _stopBy: number, clock: () => ClockReading, _onLateStop?: unknown) => {
      const attempt = runs.find((item) => item.attemptId === request.attemptId);
      const settle = open.get(request.attemptId);
      open.delete(request.attemptId);
      if (attempt != null && settle != null) {
        const base = { attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() };
        settle(request.cause === "timeout" ? { ...base, kind: "timeout", stopped: false } : { ...base, kind: "aborted", reason: request.cause, stopped: false });
      }
      return { attemptId: request.attemptId, stopped: false, completedAt: clock() };
    } };
}

async function scene(broken: NotificationChannel) {
  const other: NotificationChannel = broken === "sound" ? "desktop" : "sound";
  const adapter = brokenAdapter(broken);
  let now: ClockReading = { wallTimeMs: 0, monotonicMs: 1 };
  const h: Harness = harnessedRoot(config(), linkedUnitCodecs, { notificationAdapter: adapter, clock: () => now });
  // owner の state は harness の unit() と同じく owners の各 owner から読む（読むだけ）。
  const lossesOf = (unit: RuntimeUnitId) => h.owners.get(executionPlaces[unit])!["state"]?.losses[unit] ?? [];
  const unsavedAfterInput: string[] = [];
  const lossesMissing: string[] = [];
  // 期限処理の直後に見る: その区間に送った壊した channel の expired の更新ごとに、owner の losses にその時の wall の時刻の行がある（後でまとめて見ると、
  // 年をまたぐ次の入力の capture が 24 時間を過ぎた行を外す、P3-NL-AC14）。
  const checkLosses = (from: number, label: string) => {
    for (const { request } of h.sent.slice(from)) {
      if (request.kind !== "intentUpdate") continue;
      for (const update of request.updates) {
        if (channelOf(update.id) !== broken || update.disposition !== "expired") continue;
        if (!lossesOf(request.unit).some((row) => row.reason === "notificationExpired" && row.lastAt === now.wallTimeMs))
          lossesMissing.push(`${label}:${request.unit}:${update.id}`);
      }
    }
  };
  const inputs = runtimeUnits.map((unit) => ({ unit, ...unitBodies[unit] })).sort((a, b) => reportTime(a.body) - reportTime(b.body));
  now = { wallTimeMs: reportTime(inputs[0].body), monotonicMs: 1 };
  await startHarness(h, "run", now);
  let sequence = 0;
  for (const input of inputs) {
    const wallTimeMs = reportTime(input.body) + 1_000;
    now = { wallTimeMs, monotonicMs: now.monotonicMs + Math.max(1, wallTimeMs - now.wallTimeMs) };
    const from = h.sent.length;
    await submit(h, envelope("run", input.headType, `t04-${input.unit}`, input.body, now, ++sequence));
    checkLosses(from, input.unit);
    const status = h.root.state.mirror[input.unit].persistence;
    if (status.currentGeneration < 1 || status.savedGeneration !== status.currentGeneration) unsavedAfterInput.push(input.unit);
  }
  // 全部の intent の期限を過ぎる時計で tick を 1 回。
  now = { wallTimeMs: now.wallTimeMs + 3_600_000, monotonicMs: now.monotonicMs + 3_600_000 };
  const from = h.sent.length;
  h.root.tick(now);
  await h.settle();
  checkLosses(from, "tick");
  await h.root.diagnostics.flush();

  const updates = h.sent.flatMap(({ request }) => request.kind === "intentUpdate"
    ? request.updates.map((update) => ({ requestId: request.requestId, unit: request.unit, update })) : []);
  const doneOf = new Map(h.delivered.flatMap(({ reply }) => reply.kind === "intentUpdateDone" ? [[reply.requestId, reply.adopted] as const] : []));
  // (2) の期待: owner の返信に出たもう一方の channel の pending の intent の全件。
  const expected = new Map(h.delivered.flatMap(({ reply }) => "output" in reply ? reply.output.units.flatMap((delta) => delta.pendingIntents ?? []) : [])
    .filter((intent) => intent.channel === other).map((intent) => [intent.id, intent.unit] as const));
  const otherDelivered = updates.filter((item) => channelOf(item.update.id) === other && item.update.disposition === "delivered");
  const brokenExpired = updates.filter((item) => channelOf(item.update.id) === broken && item.update.disposition === "expired"
    && item.update.lossReason === "notificationExpired");
  return { h, adapter, other, expected, otherDelivered, brokenExpired, updates, doneOf, unsavedAfterInput, lossesMissing };
}

describe("P3-FG-T04 notification channel isolation on the 12 linked units (order 2)", () => {
  it("P3-FG-T04 acceptance / AC06: an isolated channel stops neither the other channel nor acceptance and saves", async () => {
    for (const broken of ["sound", "desktop"] as const) {
      const { h, adapter, other, expected, otherDelivered, brokenExpired, updates, doneOf, unsavedAfterInput, lossesMissing } = await scene(broken);
      // (1) 隔離と重ね呼び 0: 壊した channel の run は全体で 1 回（最初の入力 U-Q の VXSE53）で、isolated（stopUnconfirmed）のまま終わる。
      const channel = h.root.state.notificationChannels[broken];
      expect([broken, adapter.runs.filter((item) => item.channel === broken).map((item) => item.unit), channel.kind,
        channel.kind === "isolated" ? channel.reason : null]).toEqual([broken, ["U-Q"], "isolated", "stopUnconfirmed"]);
      // (2) もう一方の channel: 期待の ID の全件に delivered の終端の更新が 1 件ずつあり、owner に採られ、pending が残らない（adapter の戻り値だけを証拠にしない）。
      const deliveredIds = otherDelivered.map((item) => item.update.id);
      expect([broken, runtimeUnits.filter((unit) => [...expected.values()].includes(unit))]).toEqual([broken, makes(other)]);
      expect([broken, [...deliveredIds].sort(), deliveredIds.length]).toEqual([broken, [...expected.keys()].sort(), new Set(deliveredIds).size]);
      expect([broken, otherDelivered.filter((item) => doneOf.get(item.requestId) !== true).map((item) => item.update.id)]).toEqual([broken, []]);
      expect([broken, runtimeUnits.flatMap((unit) => h.unit(unit).intents.filter((intent) => intent.channel === other && intent.disposition === "pending")
        .map((intent) => intent.id))]).toEqual([broken, []]);
      // (3) 隔離中の欠落: 壊した channel に intent を作る各 unit が expired・notificationExpired の終端の更新を持ち、壊した channel の delivered は 0。
      // owner の losses の行は期限処理の直後に見た（scene の checkLosses）。
      expect([broken, runtimeUnits.filter((unit) => brokenExpired.some((item) => item.unit === unit)),
        updates.filter((item) => channelOf(item.update.id) === broken && item.update.disposition === "delivered").length, lossesMissing])
        .toEqual([broken, makes(broken), 0, []]);
      // (4) 受理と保存: 各入力の後にその unit の写しが保存済み。最後の tick の後、12 unit の owner と publisher の写しの世代が一致して保存済み。
      expect([broken, unsavedAfterInput, runtimeUnits.filter((unit) => {
        const owner = h.unit(unit).persistence, mirror = h.root.state.mirror[unit].persistence;
        return owner.currentGeneration !== mirror.currentGeneration || owner.savedGeneration !== owner.currentGeneration
          || mirror.savedGeneration !== mirror.currentGeneration;
      }), h.failures]).toEqual([broken, [], [], []]);
      // (5) 群: U-E は normalEew、U-T は normalTsunamiEmergency（unitBodies の VTSE41 は津波警報）、ほかは other。
      expect([broken, adapter.runs.filter((item) => item.priorityGroup !== groupOf(item.unit)).map((item) => [item.unit, item.priorityGroup])]).toEqual([broken, []]);
    }
  });
});
