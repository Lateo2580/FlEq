import { describe, expect, it } from "vitest";
import {
  PageAttentionState,
  canonicalAttentionJson,
  itemContentFingerprint,
  pageAttentionViewModel,
  pageContentFingerprint,
  pageIdentity,
} from "../page-attention";

function page(identity: string, value: string) {
  return { identity, fingerprint: itemContentFingerprint({ value }) };
}

describe("page attention state", () => {
  it("canonical fingerprint は undefined/null の差と object key 順を吸収し、page range を含める", () => {
    expect(canonicalAttentionJson({ b: undefined, a: 1 })).toBe(canonicalAttentionJson({ a: 1, b: null }));
    expect(pageIdentity("emergency-quake-regions", "range:0-2")).toBe("emergency-quake-regions:range:0-2");
    expect(pageContentFingerprint({ title: "地域" }, [{ identity: "a", fingerprint: "x" }]))
      .not.toBe(pageContentFingerprint({ title: "地域" }, [{ identity: "b", fingerprint: "x" }]));
  });

  it("初回と別 episode は全 page を未表示にし、保持満了後だけ減らす", () => {
    const state = new PageAttentionState();
    state.sync({ episodeKey: "event:a", severityRank: 1, pages: [page("p1", "a"), page("p2", "b")] });
    expect(state.viewModel(0)).toEqual({ page: "1/2", unseenCount: 2, text: "1/2・未表示2" });

    // active になっただけ、または満了前 unmount 相当では減らない。
    expect(state.unseenCount()).toBe(2);
    state.markHoldComplete("p1");
    expect(state.viewModel(0)).toEqual({ page: "1/2", unseenCount: 1, text: "1/2・未表示1" });

    state.sync({ episodeKey: "event:b", severityRank: 1, pages: [page("p1", "a"), page("p2", "b")] });
    expect(state.unseenCount()).toBe(2);
  });

  it("同一 episode の追加・訂正は新規/変化 page だけを未表示へ戻し、表示外の時刻・測定値では戻さない", () => {
    const state = new PageAttentionState();
    state.sync({ episodeKey: "event:a", severityRank: 1, pages: [page("p1", "a"), page("p2", "b")] });
    state.markHoldComplete("p1");
    state.markHoldComplete("p2");

    state.sync({ episodeKey: "event:a", severityRank: 1, pages: [page("p1", "a"), page("p2", "corrected"), page("p3", "new")] });
    expect(state.isUnseen("p1")).toBe(false);
    expect(state.isUnseen("p2")).toBe(true);
    expect(state.isUnseen("p3")).toBe(true);

    const visibleFingerprint = (input: { area: string; intensity: string; reportDateTime: string; measuredHeight: number }) => itemContentFingerprint({
      area: input.area,
      intensity: input.intensity,
    });
    const original = visibleFingerprint({ area: "A", intensity: "5強", reportDateTime: "2026-08-26T12:00:00Z", measuredHeight: 120 });
    const timeAndMeasurementOnly = visibleFingerprint({ area: "A", intensity: "5強", reportDateTime: "2026-08-26T12:01:00Z", measuredHeight: 240 });
    const visibleCorrection = visibleFingerprint({ area: "A", intensity: "6弱", reportDateTime: "2026-08-26T12:01:00Z", measuredHeight: 240 });
    expect(timeAndMeasurementOnly).toBe(original);
    expect(visibleCorrection).not.toBe(original);
  });

  it("provisional で消えて最終 partition に再出現した fingerprint 一致 page は既読を維持する", () => {
    const state = new PageAttentionState();
    state.sync({
      episodeKey: "event:a",
      severityRank: 1,
      pages: [page("initial:0-2", "stable"), page("initial:2-3", "old")],
      preserveStablePages: true,
    });
    state.markHoldComplete("initial:0-2");

    state.sync({
      episodeKey: "event:a",
      severityRank: 1,
      pages: [page("provisional:0-1", "provisional")],
      preserveStablePages: true,
      partitionPending: true,
    });

    state.sync({
      episodeKey: "event:a",
      severityRank: 1,
      pages: [page("measured:0-2", "stable"), page("measured:2-4", "changed")],
      preserveStablePages: true,
    });

    expect(state.isUnseen("measured:0-2")).toBe(false);
    expect(state.isUnseen("measured:2-4")).toBe(true);
    expect(state.unseenCount()).toBe(1);
  });

  it("severity 上昇と既存 page の並べ替えは全 page を未表示に戻し、dispose は世代を破棄する", () => {
    const state = new PageAttentionState();
    state.sync({ episodeKey: "event:a", severityRank: 1, pages: [page("p1", "a"), page("p2", "b")] });
    state.markHoldComplete("p1");
    state.markHoldComplete("p2");
    state.sync({ episodeKey: "event:a", severityRank: 2, pages: [page("p1", "a"), page("p2", "b")] });
    expect(state.unseenCount()).toBe(2);
    state.markHoldComplete("p1");
    state.markHoldComplete("p2");
    state.sync({ episodeKey: "event:a", severityRank: 2, pages: [page("p2", "b"), page("p1", "a")] });
    expect(state.unseenCount()).toBe(2);
    state.dispose();
    expect(state.viewModel(0)).toEqual({ page: null, unseenCount: 0, text: "" });
  });

  it("1 page は位置を省略し、未表示量だけを常設できる", () => {
    expect(pageAttentionViewModel({ activeIndex: 0, pageCount: 1, unseenCount: 1 }))
      .toEqual({ page: null, unseenCount: 1, text: "未表示1" });
  });

  it("1 page の保持完了で reactive unseen 集合が減り、未表示1 を残さない", () => {
    const state = new PageAttentionState();
    state.sync({ episodeKey: "event:a", severityRank: 1, pages: [page("p1", "a")] });
    expect(state.viewModel(0)).toEqual({ page: null, unseenCount: 1, text: "未表示1" });
    state.markHoldComplete("p1");
    expect(state.viewModel(0)).toEqual({ page: null, unseenCount: 0, text: "" });
  });

  it("既読 page の削除で reactive generation の総 page 数を即時に更新する", () => {
    const state = new PageAttentionState();
    state.sync({ episodeKey: "event:a", severityRank: 1, pages: [page("p1", "a"), page("p2", "b")] });
    state.markHoldComplete("p2");
    expect(state.viewModel(0)).toEqual({ page: "1/2", unseenCount: 1, text: "1/2・未表示1" });
    state.sync({ episodeKey: "event:a", severityRank: 1, pages: [page("p1", "a")] });
    expect(state.viewModel(0)).toEqual({ page: null, unseenCount: 1, text: "未表示1" });
  });
});
