import { describe, it, expect } from "vitest";
import { withRenderMutex, RenderQueueFullError, getQueueDepth } from "../lib/render-mutex";

describe("render-mutex", () => {
  it("並列呼び出しを直列化する (同時実行は常に 1)", async () => {
    const events: string[] = [];
    let inside = 0;
    const make = (id: string) => async () => {
      inside++;
      events.push(`start-${id}`);
      events.push(`inside-${inside}`);
      await new Promise((r) => setTimeout(r, 5));
      inside--;
      events.push(`end-${id}`);
      return id;
    };

    const results = await Promise.all([
      withRenderMutex(make("A")),
      withRenderMutex(make("B")),
      withRenderMutex(make("C")),
    ]);

    expect(results).toEqual(["A", "B", "C"]);
    // 直列であれば inside-1 だけが現れる (inside-2 や inside-3 は出ない)
    const insideEvents = events.filter((e) => e.startsWith("inside-"));
    expect(insideEvents.every((e) => e === "inside-1")).toBe(true);
  });

  it("queue 上限 (8) を超えると RenderQueueFullError を投げる", async () => {
    // ゆっくり終わる task を 8 個 in-flight にしたまま 9 個目を投げる
    const slow = () => new Promise<string>((r) => setTimeout(() => r("ok"), 50));
    const inflight: Promise<string>[] = [];
    for (let i = 0; i < 8; i++) {
      inflight.push(withRenderMutex(slow));
    }
    // 上限超過
    await expect(withRenderMutex(slow)).rejects.toBeInstanceOf(RenderQueueFullError);
    // 既存 8 件は完走する
    const results = await Promise.all(inflight);
    expect(results.every((r) => r === "ok")).toBe(true);
  });

  it("getQueueDepth で現在の queue 深さが取れる", async () => {
    expect(getQueueDepth()).toBe(0);
    const p = withRenderMutex(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return "x";
    });
    // すぐに depth は 1 になる
    expect(getQueueDepth()).toBe(1);
    await p;
    expect(getQueueDepth()).toBe(0);
  });

  it("fn が throw した場合も queue depth は元に戻る", async () => {
    expect(getQueueDepth()).toBe(0);
    await expect(
      withRenderMutex(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(getQueueDepth()).toBe(0);
  });
});
