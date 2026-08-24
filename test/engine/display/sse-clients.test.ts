import type { ServerResponse } from "node:http";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  MAX_BLOCKED_MS,
  MAX_CLIENTS,
  MAX_EVENT_BYTES,
  MAX_WRITABLE_LENGTH,
} from "../../../src/engine/display/constants";
import { encodeSseGuarded, SseClients } from "../../../src/engine/display/sse-clients";
import type {
  DisplayEventDtoV1,
  DisplayReconcileMessageV1,
  DisplayServerMessage,
  DisplayStateSnapshotV1,
} from "../../../src/engine/display/types";
import { displayEventDto, displaySnapshot } from "../../helpers/display-fixtures";

interface FakeRes {
  write: Mock;
  writableLength: number;
  writableEnded: boolean;
  on: Mock;
  once: Mock;
  destroy: Mock;
}

function makeFakeRes(): FakeRes {
  return {
    write: vi.fn(() => true),
    writableLength: 0,
    writableEnded: false,
    on: vi.fn(),
    once: vi.fn(),
    destroy: vi.fn(),
  };
}

function asRes(fake: FakeRes): ServerResponse {
  return fake as unknown as ServerResponse;
}

/** on/once の登録済みコールバックを手動発火する (FakeRes は実イベントを流さないため) */
function trigger(fake: FakeRes, mockFn: "on" | "once", event: string): void {
  const call = fake[mockFn].mock.calls.find((c: unknown[]) => c[0] === event);
  expect(call).toBeDefined();
  (call![1] as () => void)();
}

function eventDto(seq: number, over: Partial<DisplayEventDtoV1> = {}): DisplayEventDtoV1 {
  return displayEventDto({ seq, id: `m${seq}`, eventKey: `k${seq}`, title: "t", ...over });
}

function eventMsg(seq: number, over: Partial<DisplayEventDtoV1> = {}): DisplayServerMessage {
  return { type: "event", event: eventDto(seq, over) };
}

function reconcileMsg(seq: number, over: Partial<DisplayEventDtoV1> = {}): DisplayReconcileMessageV1 {
  return { type: "reconcile", event: eventDto(seq, over), sourceEventKeys: ["source:key"] };
}

const baseSnapshot = displaySnapshot;

function snapshotMsg(over: Partial<DisplayStateSnapshotV1> = {}): DisplayServerMessage {
  return { type: "snapshot", snapshot: baseSnapshot(over) };
}

/** JSON 化後に MAX_SNAPSHOT_BYTES (256KB) を超える recentTicker を生成する */
function hugeRecentTicker(): DisplayEventDtoV1[] {
  const longTitle = "A".repeat(500);
  return Array.from({ length: 1000 }, (_, i) => eventDto(i, { title: longTitle }));
}

describe("SseClients", () => {
  it("① MAX_CLIENTS 超の add が false", () => {
    const clients = new SseClients();
    const list = Array.from({ length: MAX_CLIENTS }, () => makeFakeRes());
    for (const res of list) {
      expect(clients.add(asRes(res))).toBe(true);
    }
    expect(clients.count()).toBe(MAX_CLIENTS);
    const extra = makeFakeRes();
    expect(clients.add(asRes(extra))).toBe(false);
    expect(clients.count()).toBe(MAX_CLIENTS);
  });

  it("② broadcast が全クライアントの write を呼ぶ (id 行付き)", () => {
    const clients = new SseClients();
    const res1 = makeFakeRes();
    const res2 = makeFakeRes();
    clients.add(asRes(res1));
    clients.add(asRes(res2));
    clients.broadcast(eventMsg(7));
    expect(res1.write).toHaveBeenCalledTimes(1);
    expect(res2.write).toHaveBeenCalledTimes(1);
    const chunk = res1.write.mock.calls[0][0] as string;
    expect(chunk).toContain("id: 7\n");
    expect(chunk).toContain("event: event\n");
  });

  it("6B後半: reconcile も canonical seq を SSE id として一 frame で送る", () => {
    const clients = new SseClients();
    const res = makeFakeRes();
    clients.add(asRes(res));
    clients.broadcast(reconcileMsg(8));
    const chunk = res.write.mock.calls[0][0] as string;
    expect(chunk).toContain("id: 8\n");
    expect(chunk).toContain("event: reconcile\n");
    expect(chunk).toContain('"sourceEventKeys":["source:key"]');
  });

  it("③ write が false を返したクライアントは blocked になり以降 skip、drain 後に復帰", () => {
    const clients = new SseClients();
    const res = makeFakeRes();
    clients.add(asRes(res));
    res.write.mockReturnValueOnce(false);
    clients.broadcast(eventMsg(1));
    expect(res.write).toHaveBeenCalledTimes(1);
    clients.broadcast(eventMsg(2));
    expect(res.write).toHaveBeenCalledTimes(1); // blocked 中は skip
    trigger(res, "on", "drain");
    clients.broadcast(eventMsg(3));
    expect(res.write).toHaveBeenCalledTimes(2); // drain で復帰
  });

  it("③-b broadcast が blocked client を blockedSkipped として報告し、drain 後は 0 に戻る (最終レビュー finding 2)", () => {
    const clients = new SseClients();
    const blocked = makeFakeRes();
    const healthy = makeFakeRes();
    clients.add(asRes(blocked));
    clients.add(asRes(healthy));
    // 初回: blocked の write が false → socket buffer には入る (この chunk は未達ではない) → skip 0
    blocked.write.mockReturnValueOnce(false);
    const r1 = clients.broadcast(eventMsg(1));
    expect(r1).toEqual({ total: 2, blockedSkipped: 0 });
    // 2 回目: blocked は blockedSinceMs 記録済みで skip されこの message 未達 → blockedSkipped 1
    const r2 = clients.broadcast(eventMsg(2));
    expect(r2.total).toBe(2);
    expect(r2.blockedSkipped).toBe(1);
    expect(healthy.write).toHaveBeenCalledTimes(2); // healthy には届き続ける
    // drain 復帰後は全 client へ届き blockedSkipped 0
    trigger(blocked, "on", "drain");
    const r3 = clients.broadcast(eventMsg(3));
    expect(r3.blockedSkipped).toBe(0);
  });

  it("③-c payload がバイト上限超なら全 client を未達 (blockedSkipped=total) として報告する", () => {
    const clients = new SseClients();
    const res1 = makeFakeRes();
    const res2 = makeFakeRes();
    clients.add(asRes(res1));
    clients.add(asRes(res2));
    const hugeTitle = "A".repeat(MAX_EVENT_BYTES + 100);
    const r = clients.broadcast(eventMsg(1, { title: hugeTitle }));
    expect(r).toEqual({ total: 2, blockedSkipped: 2, byteGuardDropped: true });
    expect(res1.write).not.toHaveBeenCalled();
  });

  it("6B後半: reconcile frame の byte guard は byteGuardDropped として型付きで返す", () => {
    const clients = new SseClients();
    const res = makeFakeRes();
    clients.add(asRes(res));
    const r = clients.broadcast(reconcileMsg(8, { title: "A".repeat(MAX_EVENT_BYTES + 100) }));

    expect(r).toEqual({ total: 1, blockedSkipped: 1, byteGuardDropped: true });
    expect(res.write).not.toHaveBeenCalled();
  });

  it("④ blocked が MAX_BLOCKED_MS 超で destroy", () => {
    let t = 0;
    const clients = new SseClients(() => t);
    const res = makeFakeRes();
    clients.add(asRes(res));
    res.write.mockReturnValueOnce(false);
    clients.broadcast(eventMsg(1)); // t=0 で blocked 開始
    t = MAX_BLOCKED_MS; // ちょうど閾値では destroy しない
    clients.broadcast(eventMsg(2));
    expect(res.destroy).not.toHaveBeenCalled();
    t = MAX_BLOCKED_MS + 1;
    clients.broadcast(eventMsg(3));
    expect(res.destroy).toHaveBeenCalledTimes(1);
  });

  it("⑤ writableLength > MAX_WRITABLE_LENGTH で destroy", () => {
    const clients = new SseClients();
    const res = makeFakeRes();
    clients.add(asRes(res));
    res.writableLength = MAX_WRITABLE_LENGTH + 1;
    clients.broadcast(eventMsg(1));
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(res.write).not.toHaveBeenCalled();
  });

  it("⑥ event payload が MAX_EVENT_BYTES 超なら誰にも write しない", () => {
    const clients = new SseClients();
    const res1 = makeFakeRes();
    const res2 = makeFakeRes();
    clients.add(asRes(res1));
    clients.add(asRes(res2));
    const hugeTitle = "A".repeat(MAX_EVENT_BYTES + 100);
    clients.broadcast(eventMsg(1, { title: hugeTitle }));
    expect(res1.write).not.toHaveBeenCalled();
    expect(res2.write).not.toHaveBeenCalled();
  });

  it("⑦ snapshot/state payload が MAX_SNAPSHOT_BYTES (256KB) 超なら write が一切呼ばれない", () => {
    const clients = new SseClients();
    const res = makeFakeRes();
    clients.add(asRes(res));
    const huge = snapshotMsg({ recentTicker: hugeRecentTicker() });
    expect(Buffer.byteLength(JSON.stringify(huge), "utf8")).toBeGreaterThan(256 * 1024);
    expect(encodeSseGuarded(huge)).toBeNull();
    clients.broadcast(huge);
    expect(res.write).not.toHaveBeenCalled();
  });

  it("write が throw するクライアントは除去され、broadcast は throw を漏らさない", () => {
    const clients = new SseClients();
    const bad = makeFakeRes();
    const good = makeFakeRes();
    clients.add(asRes(bad));
    clients.add(asRes(good));
    bad.write.mockImplementation(() => {
      throw new Error("write after destroy");
    });
    expect(() => clients.broadcast(eventMsg(1))).not.toThrow();
    expect(bad.destroy).toHaveBeenCalledTimes(1);
    expect(clients.count()).toBe(1);
    expect(good.write).toHaveBeenCalledTimes(1); // 他クライアントへの配信は継続
    clients.broadcast(eventMsg(2));
    expect(bad.write).toHaveBeenCalledTimes(1); // 除去済みなので再 write されない
    expect(good.write).toHaveBeenCalledTimes(2);
  });

  it("sendTo が broadcast と同じ backpressure ガード経路を通る (write false → blocked 記録)", () => {
    const clients = new SseClients();
    const res = makeFakeRes();
    clients.add(asRes(res));
    res.write.mockReturnValueOnce(false);
    expect(clients.sendTo(asRes(res), snapshotMsg())).toBe(true);
    expect(res.write).toHaveBeenCalledTimes(1);
    clients.broadcast(eventMsg(1)); // blocked 記録済みなので skip される
    expect(res.write).toHaveBeenCalledTimes(1);
  });

  it("sendTo はサイズ上限超過で false を返し write しない (呼び出し元が縮退を判断)", () => {
    const clients = new SseClients();
    const res = makeFakeRes();
    clients.add(asRes(res));
    expect(clients.sendTo(asRes(res), snapshotMsg({ recentTicker: hugeRecentTicker() }))).toBe(false);
    expect(res.write).not.toHaveBeenCalled();
  });

  it("'error' イベント発火でクライアントが除去され、以降の broadcast で write されない", () => {
    const clients = new SseClients();
    const res = makeFakeRes();
    clients.add(asRes(res));
    expect(clients.count()).toBe(1);
    trigger(res, "on", "error");
    expect(clients.count()).toBe(0);
    clients.broadcast(eventMsg(1));
    expect(res.write).not.toHaveBeenCalled();
  });

  it("destroy 経路 (writableLength 超過) は 'close' 発火前でも同期的に map から除去される", () => {
    const clients = new SseClients();
    const res = makeFakeRes();
    clients.add(asRes(res));
    res.writableLength = MAX_WRITABLE_LENGTH + 1;
    clients.broadcast(eventMsg(1)); // destroy() は呼ばれるが FakeRes は 'close' を自発発火しない
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(clients.count()).toBe(0); // 'close' 伝播を待たず同期削除済み
    clients.broadcast(eventMsg(2)); // 破壊済み res に書き込まれない
    expect(res.write).not.toHaveBeenCalled();
  });

  it("destroy 経路 (blocked timeout) も 'close' 発火前に同期的に map から除去される", () => {
    let t = 0;
    const clients = new SseClients(() => t);
    const res = makeFakeRes();
    clients.add(asRes(res));
    res.write.mockReturnValueOnce(false);
    clients.broadcast(eventMsg(1));
    t = MAX_BLOCKED_MS + 1;
    clients.broadcast(eventMsg(2));
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(clients.count()).toBe(0);
  });

  it("⑧ close イベントで count が減る", () => {
    const clients = new SseClients();
    const res = makeFakeRes();
    clients.add(asRes(res));
    expect(clients.count()).toBe(1);
    trigger(res, "once", "close");
    expect(clients.count()).toBe(0);
  });

  it("人数変更を add と除去で一度ずつ通知し、close/error の重複発火では二重通知しない", () => {
    const counts: number[] = [];
    const clients = new SseClients(Date.now, (count) => counts.push(count));
    const res1 = makeFakeRes();
    const res2 = makeFakeRes();

    clients.add(asRes(res1));
    clients.add(asRes(res2));
    trigger(res1, "on", "error");
    trigger(res1, "once", "close");
    trigger(res2, "once", "close");

    expect(counts).toEqual([1, 2, 1, 0]);
  });

  it("heartbeat が全クライアントに名前付き ping イベントを backpressure 経路で書き込む", () => {
    const clients = new SseClients();
    const res = makeFakeRes();
    clients.add(asRes(res));
    clients.heartbeat();
    // SSE コメントではなく client が addEventListener("ping") で観測できる名前付きイベント
    // (liveness watchdog の最終受信時刻更新用)。空 data だと EventSource が dispatch しないため非空
    expect(res.write).toHaveBeenCalledWith("event: ping\ndata: 1\n\n");
  });

  it("closeAll が全クライアントを destroy し count を 0 にする", () => {
    const clients = new SseClients();
    const res1 = makeFakeRes();
    const res2 = makeFakeRes();
    clients.add(asRes(res1));
    clients.add(asRes(res2));
    clients.closeAll();
    expect(res1.destroy).toHaveBeenCalledTimes(1);
    expect(res2.destroy).toHaveBeenCalledTimes(1);
    expect(clients.count()).toBe(0);
  });
});

describe("encodeSseGuarded", () => {
  it("event メッセージは id 行を持つが snapshot/state は持たない", () => {
    expect(encodeSseGuarded(eventMsg(42))).toContain("id: 42\n");
    expect(encodeSseGuarded(snapshotMsg())).not.toContain("id:");
  });
});
