import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ticker from "../Ticker.svelte";
import { LANES } from "../../lib/ticker-lanes";
import { CYCLE_MIN_INTERVAL_MS, REVISION_BADGE_MS } from "../../lib/ticker-schedule";
import { tickerEvent } from "../../lib/__tests__/fixtures";

describe("Ticker (親スケジューラ)", () => {
  it("① 縦に LANES 本のレーンが描画される", () => {
    const { container } = render(Ticker, { lines: [] });
    expect(container.querySelectorAll(".ticker-row").length).toBe(LANES);
  });

  it("② 行が無いとき両レーンとも何も表示しない (emptyLabel 撤去、spec §4-2)", () => {
    const { container } = render(Ticker, { lines: [] });
    expect(container.querySelector(".role-muted")).toBeFalsy();
    expect(container.querySelectorAll(".ticker-line").length).toBe(0);
    expect(container.textContent).not.toContain("受信待機中");
  });

  it("③ tickerBody を持つ行はセグメント分割されてレーンに流れる", async () => {
    render(Ticker, {
      lines: [tickerEvent({ id: "wx", tickerBody: "低気圧が発達しています。", summary: { text: "s", role: "normal" } })],
    });
    await tick();
    expect(screen.getByText("低気圧が発達しています。")).toBeTruthy();
  });

  it("④ tickerBody が無い行は tickerSentence にフォールバックして流れる", async () => {
    render(Ticker, {
      lines: [tickerEvent({ id: "q", tickerBody: null, tickerSentence: "宮城県沖で地震がありました。" })],
    });
    await tick();
    expect(screen.getByText("宮城県沖で地震がありました。")).toBeTruthy();
  });

  it("⑤ tickerSentence も無ければ summary + tickerDetail 連結にフォールバック", async () => {
    render(Ticker, {
      lines: [tickerEvent({ id: "d", tickerBody: null, tickerSentence: null, summary: { text: "大雨警報", role: "warning" }, tickerDetail: "山鹿市" })],
    });
    await tick();
    expect(screen.getByText("大雨警報 ▪ 山鹿市")).toBeTruthy();
  });

  it("⑥ now を渡すと右端に時計が render される", () => {
    const { container } = render(Ticker, { lines: [], now: new Date("2026-07-08T09:05:03+09:00") });
    expect(container.querySelector(".ticker-clock")?.textContent).toContain("09:05");
  });

  it("⑦ now を渡さないと時計は render されない", () => {
    const { container } = render(Ticker, { lines: [] });
    expect(container.querySelector(".ticker-clock")).toBeFalsy();
  });

  it("⑧ tickerGeneration が変わると ticker が新 lines で作り直される (snapshot reset)", async () => {
    const { rerender } = render(Ticker, {
      lines: [tickerEvent({ id: "old", tickerBody: "古い本文です。" })],
      tickerGeneration: 0,
    });
    await tick();
    expect(screen.getByText("古い本文です。")).toBeTruthy();

    await rerender({
      lines: [tickerEvent({ id: "new", tickerBody: "新しい本文です。" })],
      tickerGeneration: 1,
    });
    await tick();
    expect(screen.getByText("新しい本文です。")).toBeTruthy();
  });

  it("legacyの安定idが同じでもrevision固有eventKeyなら続報をenqueueする", async () => {
    const first = tickerEvent({
      id: "legacy:VPOA50:EVENT-1",
      eventKey: "legacy:VPOA50:EVENT-1:revision:1:first",
      domain: "legacyCounterpart",
      type: "VPOA50",
      tickerBody: null,
      tickerSentence: "旧形式情報の初報です。",
    });
    const newer = tickerEvent({
      id: first.id,
      eventKey: "legacy:VPOA50:EVENT-1:revision:2:newer",
      domain: "legacyCounterpart",
      type: "VPOA50",
      tickerBody: null,
      tickerSentence: "旧形式情報の続報です。",
    });
    const view = render(Ticker, { lines: [first], tickerGeneration: 0 });
    await tick();
    expect(screen.getByText("旧形式情報の初報です。")).toBeTruthy();

    await view.rerender({ lines: [newer, first], tickerGeneration: 0 });
    await tick();
    expect(screen.getByText("旧形式情報の続報です。")).toBeTruthy();
  });

  it("帯 (.ticker) は instrument surface (surface-low + 上辺 hairline) を敷く (Spec C §2)", () => {
    const src = readFileSync(join(__dirname, "..", "Ticker.svelte"), "utf-8");
    expect(src).toMatch(/\.ticker\s*\{[^}]*background:\s*var\(--surface-low\)/);
    expect(src).toMatch(/\.ticker\s*\{[^}]*border-top:\s*1px solid var\(--hairline\)/);
  });

  it("tickerLines は全 17 role を敷く (Spec C §6/§8 の全 role コントラスト実測の前提)", async () => {
    const { tickerLines } = await import("../../preview/fixtures");
    const roles = new Set(tickerLines.map((l) => l.summary.role));
    for (const r of ["weatherEmergency", "connectionOk", "connectionStale", "muted"]) {
      expect(roles.has(r as never)).toBe(true);
    }
  });

  it("⑨ lines から消えた行は catalog からも消え、巡回補充で再走しない (Codex 最終レビュー Critical)", async () => {
    // 再現条件: 2 本の low job を同時走行 → 片方 (tip) だけを lines から外す → 残り (sticky) は
    // 生き続けるので、その onLineComplete が「lines とは無関係に」runTick() を呼び続ける。catalog が
    // lines 縮小に追従していないと、CYCLE_MIN_INTERVAL_MS (120s) 経過後にこの runTick() が
    // 消えたはずの tip を巡回補充で復活させてしまう。
    vi.useFakeTimers();
    try {
      const sticky = tickerEvent({
        id: "sticky", tickerBody: null, tickerSentence: "常設の見出しです。", tickerPriority: "low",
      });
      const tip = tickerEvent({
        id: "tip", tickerBody: null, tickerSentence: "ヒント：これは知識系Tipsです。", tickerPriority: "low",
      });
      const { container, rerender } = render(Ticker, { lines: [sticky, tip], tickerGeneration: 0 });
      await tick();
      expect(container.textContent).toContain("ヒント：これは知識系Tipsです。");

      // tip だけ lines から外す (sticky は残る)。同一 generation → 我々の修正が効く分岐
      await rerender({ lines: [sticky], tickerGeneration: 0 });
      await tick();

      // 巡回間隔 (CYCLE_MIN_INTERVAL_MS) を跨いで、tip が「tooSoon」ガードで守られない状況にする
      vi.advanceTimersByTime(CYCLE_MIN_INTERVAL_MS + 1_000);

      // sticky を流し終える (lines とは無関係に onLineComplete → runTick() が走る経路)。
      // tip が乗っているレーンを animationend で完走させ、idle 化させる
      const tipLine = Array.from(container.querySelectorAll(".ticker-row")).find((row) =>
        row.textContent?.includes("ヒント：これは知識系Tipsです。"),
      )?.querySelector(".ticker-line");
      expect(tipLine).toBeTruthy();
      tipLine!.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "ticker-scroll" }));
      await tick();

      // catalog が lines 縮小に追従していれば、idle 化したレーンは tip を巡回補充せず空のまま。
      // 追従していない (回帰) と、この直後に tip が復活してしまう
      expect(container.textContent).not.toContain("ヒント：これは知識系Tipsです。");
    } finally {
      vi.useRealTimers();
    }
  });

  it("⑩ onJobComplete: 空 mount では発火しない (走る job が無い、Tips フィラーの deck 送りは job 完走が起点)", async () => {
    const onJobComplete = vi.fn();
    render(Ticker, { lines: [], onJobComplete });
    await tick();
    expect(onJobComplete).not.toHaveBeenCalled();
  });

  it("⑪ onJobComplete: job の最終 run を完走したら eventKey つきで 1 回だけ発火する", async () => {
    vi.useFakeTimers();
    try {
      const onJobComplete = vi.fn();
      const job = tickerEvent({
        id: "solo", tickerBody: null, tickerSentence: "単発の低優先度テロップです。", tickerPriority: "low",
      });
      const { container } = render(Ticker, { lines: [job], onJobComplete });
      await tick();
      expect(onJobComplete).not.toHaveBeenCalled(); // 走行中はまだ完走していない

      const line = container.querySelector(".ticker-line");
      expect(line).toBeTruthy();
      line!.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "ticker-scroll" }));
      await tick();

      // 単発 low → 最終 run 走破 → idle 化。完走した job の eventKey (k-solo) で 1 回だけ発火
      expect(onJobComplete).toHaveBeenCalledTimes(1);
      expect(onJobComplete).toHaveBeenCalledWith("k-solo");

      // idle が続く間は再発火しない
      await tick();
      expect(onJobComplete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("⑫ onJobComplete: generation 不一致の stale な animationend では発火しない", async () => {
    const onJobComplete = vi.fn();
    const job = tickerEvent({
      id: "solo", tickerBody: null, tickerSentence: "単発の低優先度テロップです。", tickerPriority: "low",
    });
    const { container } = render(Ticker, { lines: [job], onJobComplete });
    await tick();
    const line = container.querySelector(".ticker-line") as HTMLElement;
    expect(line).toBeTruthy();
    // 発火要素の data-generation を現行と異なる値に書き換えて stale 通知を模す (Critical 3 の遅延イベント)
    line.dataset.generation = "999";
    line.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "ticker-scroll" }));
    await tick();
    expect(onJobComplete).not.toHaveBeenCalled();
  });

  it("⑬ onJobComplete 未指定でも従来どおり動作する (crash しない)", async () => {
    const job = tickerEvent({ id: "noop", tickerBody: null, tickerSentence: "onJobComplete 未指定確認用。" });
    const { container } = render(Ticker, { lines: [job] });
    await tick();
    const line = container.querySelector(".ticker-line");
    line!.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "ticker-scroll" }));
    await expect(tick()).resolves.not.toThrow();
  });

  it("⑭ kind=tip: lines から外れた走行中の tip は即除去される (緊急遷移で豆知識が緊急画面に残らない)", async () => {
    const tip = {
      ...tickerEvent({ id: "t1", eventKey: "tip-1", tickerBody: null, tickerSentence: "豆知識テロップです。", tickerPriority: "low" }),
      kind: "tip" as const,
    };
    // 待機中: tip が走行中
    const { container, rerender } = render(Ticker, { lines: [tip], tickerGeneration: 0 });
    await tick();
    expect(container.textContent).toContain("豆知識テロップです。");

    // 緊急遷移で feeder が lines を空にする (同一 generation、電文 low と合成された tip が外れる)
    await rerender({ lines: [], tickerGeneration: 0 });
    await tick();

    // 走行中だった tip は current から即除去され、緊急画面のテロップに残らない
    expect(container.querySelectorAll(".ticker-line").length).toBe(0);
    expect(container.textContent).not.toContain("豆知識テロップです。");
  });

  it("⑮ 非 filler (電文, kind=event) job は lines から外れても保持され完走する (従来挙動)", async () => {
    const wx = tickerEvent({
      id: "wx", eventKey: "k-wx", tickerBody: null, tickerSentence: "大雨警報の本文です。", tickerPriority: "low",
    });
    const { container, rerender } = render(Ticker, { lines: [wx], tickerGeneration: 0 });
    await tick();
    expect(container.textContent).toContain("大雨警報の本文です。");

    // 電文 job (非 filler) を lines から外しても即除去はされない (走行中は完走まで残す = ⑨ の従来契約)
    await rerender({ lines: [], tickerGeneration: 0 });
    await tick();
    expect(container.textContent).toContain("大雨警報の本文です。");
  });

  it("⑯ kind=tip: 走行中 tip (下段) と共存する high (上段) がいても、緊急で tip を purge すると high は無傷で走行継続する", async () => {
    // 排他化 v2 では tip は電文が居ない間にしか始まらないが、走行を始めた後に電文が来るのは許容
    // (走行中 tip は中断せず完走)。tip=lane1、high=lane0 で共存 → 緊急遷移で tip だけ purge され、
    // high は fading に巻き込まれず running のまま完走する (kind ベース purge の回帰防止)。
    const tip = {
      ...tickerEvent({ id: "t1", eventKey: "tip-1", tickerBody: null, tickerSentence: "豆知識テロップです。", tickerPriority: "low" }),
      kind: "tip" as const,
    };
    const high = tickerEvent({
      id: "eew", eventKey: "k-high", groupKey: "g-eew", tickerBody: null,
      tickerSentence: "緊急地震速報の本文です。", tickerPriority: "high",
    });

    // 待機中: tip 単独で走行 (下段 lane1)
    const { container, rerender } = render(Ticker, { lines: [tip], tickerGeneration: 0 });
    await tick();
    expect(container.textContent).toContain("豆知識テロップです。");

    // high を投入 → 上段 lane0 へ (走行中 tip は中断しない)。両者共存
    await rerender({ lines: [high, tip], tickerGeneration: 0 });
    await tick();
    expect(container.textContent).toContain("緊急地震速報の本文です。");
    expect(container.textContent).toContain("豆知識テロップです。");

    // 緊急遷移で feeder が lines から tip を外す (high だけ残す)。走行中 tip を purge
    await rerender({ lines: [high], tickerGeneration: 0 });
    await tick();

    // tip は消え、high は無傷で走行継続 (fading に巻き込まれない)
    expect(container.textContent).not.toContain("豆知識テロップです。");
    expect(container.textContent).toContain("緊急地震速報の本文です。");
    const highLine = Array.from(container.querySelectorAll(".ticker-row"))
      .find((r) => r.textContent?.includes("緊急地震速報の本文です。"))
      ?.querySelector(".ticker-line");
    expect(highLine).toBeTruthy();
    expect(highLine!.classList.contains("fading")).toBe(false); // running のまま

    // high は走行要素として animationend で完走できる
    highLine!.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "ticker-scroll" }));
    await tick();
    expect(container.textContent).not.toContain("緊急地震速報の本文です。"); // 完走して idle 化
  });

  it("⑰ onActivityChange: 非 tip (電文) ジョブの在否が変わると通知される", async () => {
    const onActivityChange = vi.fn();
    const wx = tickerEvent({
      id: "wx", eventKey: "k-wx", tickerBody: null, tickerSentence: "電文本文です。", tickerPriority: "low",
    });
    const { rerender } = render(Ticker, { lines: [], tickerGeneration: 0, onActivityChange });
    await tick();
    // 初期 (空) は非アクティブ
    expect(onActivityChange).toHaveBeenLastCalledWith(false);

    // 電文が入るとアクティブ通知
    await rerender({ lines: [wx], tickerGeneration: 0, onActivityChange });
    await tick();
    expect(onActivityChange).toHaveBeenLastCalledWith(true);
  });
});

// 続報バッジ TTL の one-shot 化 (D4)。旧実装は毎秒 setInterval で badgeNow を進めていたため、
// バッジが 1 件も無い平常時にも 1 日 86,400 回起床していた。バッジは真→偽へ一度変わるだけなので、
// 「表示中レーンの最も近い失効時刻」1 本にだけ setTimeout を張る方式へ移した。
describe("Ticker 続報バッジのタイマー", () => {
  const chip = { tickerCategory: "地震情報", tickerBody: null, tickerPriority: "low" as const };
  const SETTLE_MS = 500; // チップ transition スタブを流し切るための小さな経過

  /** 続報を昇格させ、バッジが出ている状態まで進める (最終 run 完走時の coalescedRevision 昇格経路)。 */
  async function renderWithBadge() {
    const first = tickerEvent({
      ...chip, id: "q1", eventKey: "k-q1", groupKey: "g-q", tickerSentence: "第1報の本文です。",
    });
    const second = tickerEvent({
      ...chip, id: "q2", eventKey: "k-q2", groupKey: "g-q", tickerSentence: "第2報の本文です。",
    });
    const view = render(Ticker, { lines: [first], tickerGeneration: 0 });
    await tick();
    // 同 groupKey・同格の続報 → coalescedRevision へ畳まれる (lines は新しい順)
    await view.rerender({ lines: [second, first], tickerGeneration: 0 });
    await tick();
    // 走行中の第1報を完走させると、畳まれていた続報が revisionAt=now で昇格する
    view.container.querySelector(".ticker-line")!
      .dispatchEvent(Object.assign(new Event("animationend"), { animationName: "ticker-scroll" }));
    await tick();
    expect(view.container.querySelector(".ticker-label-revision")?.textContent).toBe("続報");
    // チップ差替えの transition スタブ (test-setup の Element.animate → 0ms setTimeout) を流し切り、
    // 残るタイマーをバッジ用の 1 本だけにする。TTL は絶対時刻で張るので、この分の経過は下の
    // 「失効まで残り 1 秒」判定に効く (SETTLE_MS を引いた上で境界を跨がせる)
    vi.advanceTimersByTime(SETTLE_MS);
    await tick();
    return view;
  }

  it("バッジ対象が無い間はタイマーを 1 本も張らない (平常時の毎秒起床をゼロにする)", async () => {
    vi.useFakeTimers();
    try {
      render(Ticker, { lines: [], tickerGeneration: 0 });
      await tick();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("バッジ表示中は失効時刻への one-shot が 1 本だけ張られる", async () => {
    vi.useFakeTimers();
    try {
      await renderWithBadge();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("REVISION_BADGE_MS 経過でバッジが消える (直前までは出たまま)", async () => {
    vi.useFakeTimers();
    try {
      const { container } = await renderWithBadge();

      vi.advanceTimersByTime(REVISION_BADGE_MS - SETTLE_MS - 1_000);
      await tick();
      expect(container.querySelector(".ticker-label-revision")).toBeTruthy();

      vi.advanceTimersByTime(1_000);
      await tick();
      expect(container.querySelector(".ticker-label-revision")).toBeNull();
      expect(vi.getTimerCount()).toBe(0); // 失効後は張り直さない
    } finally {
      vi.useRealTimers();
    }
  });

  it("コンポーネント破棄でバッジタイマーが解放される", async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = await renderWithBadge();
      expect(vi.getTimerCount()).toBe(1);
      unmount();
      await tick();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("回帰防止: バッジ用の常設 interval を持たない (ソース契約)", () => {
    const src = readFileSync(join(__dirname, "..", "Ticker.svelte"), "utf-8");
    expect(src).not.toMatch(/setInterval/);
  });
});

// 津波チップ再生 (enqueueReplay) の Ticker 統合 (2026-07-14)
describe("Ticker enqueueReplay (津波チップ再生)", () => {
  function replayDto(over: {
    level?: string; seq?: number; generation?: number; body?: string;
  } = {}) {
    const level = over.level ?? "warning";
    const seq = over.seq ?? 1;
    const groupKey = `replay:tsunami:${level}`;
    return {
      ...tickerEvent({
        id: `replay-${level}-${seq}`,
        eventKey: `${groupKey}:${seq}`,
        groupKey,
        tickerBody: over.body ?? "【津波警報】高知県",
        tickerSentence: over.body ?? "【津波警報】高知県",
        tickerPriority: "low",
      }),
      kind: "replay" as const,
      replayGeneration: over.generation ?? 0,
    };
  }

  it("enqueueReplay で合成 replay が Ticker に流れる (kind/priority/key は DTO 由来)", async () => {
    const { container, component } = render(Ticker, { lines: [], tickerGeneration: 0, tsunamiGeneration: 0 });
    await tick();
    (component as unknown as { enqueueReplay: (d: unknown) => void }).enqueueReplay(replayDto({ body: "【津波警報】高知県" }));
    await tick();
    expect(container.textContent).toContain("【津波警報】高知県");
  });

  it("連打ガード: 同レベル (同 groupKey) の replay が active の間は再投入を無視する", async () => {
    const { container, component } = render(Ticker, { lines: [], tickerGeneration: 0, tsunamiGeneration: 0 });
    const api = component as unknown as { enqueueReplay: (d: unknown) => void };
    await tick();
    api.enqueueReplay(replayDto({ seq: 1 }));
    await tick();
    api.enqueueReplay(replayDto({ seq: 2 })); // 同 groupKey → 無視
    await tick();
    // 走行中テロップ行は 1 本だけ (2 本目は連打ガードで載らない)
    expect(container.querySelectorAll(".ticker-line").length).toBe(1);
  });

  it("世代ガード: tsunamiGeneration が変わると走行中の replay は即時停止する", async () => {
    const { container, component, rerender } = render(Ticker, { lines: [], tickerGeneration: 0, tsunamiGeneration: 0 });
    (component as unknown as { enqueueReplay: (d: unknown) => void }).enqueueReplay(replayDto({ generation: 0 }));
    await tick();
    expect(container.textContent).toContain("【津波警報】高知県");

    // 津波が更新/解除 → 世代が進む。投入時 (0) と食い違う replay は purge される
    await rerender({ lines: [], tickerGeneration: 0, tsunamiGeneration: 1 });
    await tick();
    expect(container.textContent).not.toContain("【津波警報】高知県");
  });

  it("排他連動: replay 走行中は tip が開始されない (hasNonTipActivity に replay が数えられる)", async () => {
    const { container, component, rerender } = render(Ticker, { lines: [], tickerGeneration: 0, tsunamiGeneration: 0 });
    (component as unknown as { enqueueReplay: (d: unknown) => void }).enqueueReplay(replayDto());
    await tick();
    expect(container.textContent).toContain("【津波警報】高知県");

    // replay 走行中に tip を lines へ投入 → 電文 (replay) が居るので tip は載らない
    const tip = {
      ...tickerEvent({ id: "tip1", eventKey: "tip-1", tickerBody: null, tickerSentence: "豆知識テロップです。", tickerPriority: "low" }),
      kind: "tip" as const,
    };
    await rerender({ lines: [tip], tickerGeneration: 0, tsunamiGeneration: 0 });
    await tick();
    expect(container.textContent).not.toContain("豆知識テロップです。"); // tip は開始されない
    expect(container.textContent).toContain("【津波警報】高知県"); // replay は継続
  });

  it("onActivityChange: replay が入るとアクティブ通知される (tip 供給ゲートに効く)", async () => {
    const onActivityChange = vi.fn();
    const { component } = render(Ticker, { lines: [], tickerGeneration: 0, tsunamiGeneration: 0, onActivityChange });
    await tick();
    expect(onActivityChange).toHaveBeenLastCalledWith(false);
    (component as unknown as { enqueueReplay: (d: unknown) => void }).enqueueReplay(replayDto());
    await tick();
    expect(onActivityChange).toHaveBeenLastCalledWith(true);
  });

  it("knownKeys 無限肥大の回帰防止: enqueueReplay は knownKeys.add を呼ばない (指摘3、kiosk リーク)", () => {
    // replay の key は lines に現れないので fresh 判定に不要。add すると完走/purge 後も刈られず、
    // 静穏時の繰り返し replay で Set が無限肥大する。jsdom では Set サイズを直接観測できないため
    // ソース契約で固定する (lines $effect の knownKeys 再構築は別途 ⑨ 等でカバー済み)。
    const src = readFileSync(join(__dirname, "..", "Ticker.svelte"), "utf-8");
    const fn = src.match(/export function enqueueReplay[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(fn).toContain("enqueueJob"); // 本体が取れていることの確認
    expect(fn).not.toMatch(/knownKeys\s*\.\s*add/); // knownKeys.add(...) を呼ばない (コメント言及は許容)
  });

  it("完走後に同レベル replay を再投入でき、繰り返し流せる (連打ガードは active 中だけ、指摘3 の裏取り)", async () => {
    const { container, component } = render(Ticker, { lines: [], tickerGeneration: 0, tsunamiGeneration: 0 });
    const api = component as unknown as { enqueueReplay: (d: unknown) => void };
    await tick();
    api.enqueueReplay(replayDto({ seq: 1 }));
    await tick();
    const line = container.querySelector(".ticker-line")!;
    line.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "ticker-scroll" }));
    await tick();
    expect(container.querySelectorAll(".ticker-line").length).toBe(0); // 完走で idle

    // 完走後に同レベルを再投入 → また流れる (knownKeys に stale が残って弾かれたりしない)
    api.enqueueReplay(replayDto({ seq: 2 }));
    await tick();
    expect(container.textContent).toContain("【津波警報】高知県");
  });
});
