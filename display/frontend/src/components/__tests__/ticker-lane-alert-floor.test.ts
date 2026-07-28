// spec D5 可読性フロア: 警報級 role (isAlertRole, lib/alert-roles.ts) の走行行・チップに
// data-alert が付き、CSS 側の dim 除外規則 (TickerLane.svelte) が発火するフックになることを確認する。
// CSS 契約そのもの (dim 混色から除外) は既存の TickerLane 系テストのソース読み手法に倣い別途担保する。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tick } from "svelte";
import type { ComponentProps } from "svelte";
import { render } from "@testing-library/svelte";
import TickerLane from "../TickerLane.svelte";
import type { TickerJob } from "../../lib/ticker-schedule";

function job(over: Partial<TickerJob> = {}): TickerJob {
  const segments = over.segments ?? ["セグメント本文"];
  return {
    key: "k", groupKey: null, seq: 1, kind: "event", priority: "low", role: "info", category: null,
    subject: null,
    segments,
    segmentEmphasis: over.segmentEmphasis ?? segments.map(() => []),
    runs: over.runs ?? [{ startSegmentIndex: 0, endSegmentIndexExclusive: segments.length }],
    runIndex: 0, segmentIndex: 0, retryCount: 0, deferUntil: null, deferKind: null,
    revisionAt: null, isCancellation: false, tipPolicy: null, tipHazards: [], surface: "none",
    ...over,
  };
}

const noop = (): void => {};
const noopBookmark = (): void => {};

function renderLane(
  props: Partial<ComponentProps<typeof TickerLane>> & { job: TickerJob | null },
) {
  const j = props.job;
  const runEnd = j != null ? j.runs[j.runIndex]!.endSegmentIndexExclusive : 0;
  return render(TickerLane, {
    segmentIndex: 0,
    generation: 1,
    phase: "running",
    runEnd,
    onScrollEnd: noop,
    onFadeEnd: noop,
    onBookmarkCapture: noopBookmark,
    ...props,
  } as ComponentProps<typeof TickerLane>);
}

describe("TickerLane 可読性フロア (spec D5, data-alert)", () => {
  it("weatherWarning の行に data-alert が付く", () => {
    const { container } = renderLane({
      job: job({ role: "weatherWarning", category: "気象警報・注意報", segments: ["大雨警報"] }),
    });
    expect(container.querySelector(".ticker-line[data-alert]")).not.toBeNull();
    expect(container.querySelector(".ticker-label[data-alert]")).not.toBeNull();
  });

  it("weatherAdvisory の行には data-alert が付かない", () => {
    const { container } = renderLane({
      job: job({ role: "weatherAdvisory", category: "気象警報・注意報", segments: ["大雨注意報"] }),
    });
    expect(container.querySelector(".ticker-line[data-alert]")).toBeNull();
    expect(container.querySelector(".ticker-label[data-alert]")).toBeNull();
  });

  it("job=null (チップのみ linger) では走行行は無いが、チップは警報級 role なら data-alert を保つ", async () => {
    const { container, rerender } = renderLane({
      job: job({ role: "tsunamiWarning", category: "津波警報", segments: ["津波警報"] }),
    });
    await tick();
    expect(container.querySelector(".ticker-label[data-alert]")).not.toBeNull();

    await rerender({
      job: null, segmentIndex: 0, runEnd: 0, generation: 1, phase: "idle",
      onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
    } as ComponentProps<typeof TickerLane>);
    await tick();
    expect(container.querySelector(".ticker-line")).toBeNull();
    expect(container.querySelector(".ticker-label[data-alert]")).not.toBeNull();
  });

  // ── CSS 契約ガード (ソース読み、既存 TickerLane 系テストの手法に倣う) ──
  it("dim ブロックの後に可読性フロア CSS があり、data-alert 行・チップを素の色へ戻す", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    expect(src).toMatch(/\.ticker-lane\.dim \.ticker-line\[data-alert\]\s*\{\s*color:\s*var\(--tk-c\);\s*\}/);
    expect(src).toMatch(
      /\.ticker-lane\.dim \.ticker-label\[data-alert\]\s*\{[\s\S]*?--chip-on-rendered:\s*var\(--chip-on\);[\s\S]*?--chip-container-rendered:\s*var\(--chip-container\);[\s\S]*?background:\s*var\(--chip-container\);[\s\S]*?color:\s*var\(--chip-on\);[\s\S]*?\}/,
    );
    // フロア規則は dim 減光ブロック (35% 混色) より後のソース順 (カスケード後勝ちで確実に上書きする)
    const dimIdx = src.indexOf(".ticker-lane.dim .ticker-label {");
    const floorIdx = src.indexOf(".ticker-lane.dim .ticker-line[data-alert]");
    expect(dimIdx).toBeGreaterThan(-1);
    expect(floorIdx).toBeGreaterThan(dimIdx);
  });

  it("大津波警報の反転面は dim でも data-alert フロアで専用規則が素の色へ戻る", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    const m = src.match(/\.ticker-lane\.dim \.ticker-line\.solid\[data-alert\]\s*\{[^}]*\}/);
    expect(m).toBeTruthy();
    const decl = m![0];
    expect(decl).toMatch(/background:\s*var\(--ticker-surface-container\)/);
    expect(decl).toMatch(/color:\s*var\(--ticker-surface-on\)/);
  });
});
