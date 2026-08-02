import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import RecentQuakes from "../RecentQuakes.svelte";
import type { DisplayIntensitySemanticV1, DisplayRecentQuakeV1 } from "../../lib/protocol";

function quake(over: Partial<DisplayRecentQuakeV1> = {}): DisplayRecentQuakeV1 {
  return {
    eventId: null,
    reportDateTime: "2026-07-07T10:00:00+09:00",
    originTime: null,
    hypocenterName: "浦河沖",
    magnitude: "5.2",
    maxInt: "4",
    maxIntRank: 5,
    depth: "30km",
    tsunamiWarning: false,
    ...over,
  };
}

function semantic(over: Partial<DisplayIntensitySemanticV1>): DisplayIntensitySemanticV1 {
  return {
    raw: "4", presence: "value", label: "4", condition: null, description: null,
    lowerBound: null, upperBound: null, rawLowerBound: null, rawUpperBound: null,
    badge: null, color: "normalRank", render: true, safetyLowerRank: 4,
    safetyUpperRank: 4, safetyRank: 4, colorRank: 4, ...over,
  };
}

describe("RecentQuakes intensity semantic", () => {
  it("5弱以上未入電・unknown・empty を label/badge/専用色で表示する", () => {
    const lower = semantic({
      raw: "5弱以上未入電", presence: "qualitative", label: "5弱以上未入電",
      condition: "5弱以上未入電", lowerBound: "5-", badge: "≥", color: "safetyRank",
      safetyLowerRank: 5, safetyUpperRank: null, safetyRank: 5, colorRank: 5,
    });
    const unknown = semantic({
      raw: "未入電", presence: "unknown", label: "不明", condition: "未入電",
      badge: "?", color: "unknown", safetyLowerRank: null, safetyUpperRank: null,
      safetyRank: null, colorRank: null,
    });
    const empty = semantic({
      raw: "", presence: "empty", label: "空欄", badge: "∅", color: "neutral",
      safetyLowerRank: null, safetyUpperRank: null, safetyRank: null, colorRank: null,
    });
    const { container } = render(RecentQuakes, { quakes: [
      quake({ eventId: "L", hypocenterName: "下限", maxInt: null, maxIntRank: 5, maxIntSemantic: lower }),
      quake({ eventId: "U", hypocenterName: "未知", maxInt: null, maxIntRank: null, maxIntSemantic: unknown }),
      quake({ eventId: "E", hypocenterName: "空", maxInt: null, maxIntRank: null, maxIntSemantic: empty }),
    ] });
    const chips = [...container.querySelectorAll(".int-chip")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["5弱以上未入電≥", "不明?", "空欄∅"]);
    expect(chips[0].classList.contains("int-r5")).toBe(true);
    expect(chips[1].classList.contains("special-unknown")).toBe(true);
    expect(chips[2].classList.contains("special-empty")).toBe(true);
    expect(chips[0].getAttribute("title")).toContain("以上（下限値）");
    expect(chips[1].getAttribute("aria-label")).toContain("理由: 未入電");
  });
});

describe("RecentQuakes keyed-each 重複耐性", () => {
  it("eventId が null で同一 reportDateTime の行が複数あっても重複 key クラッシュを起こさず全件 render する", () => {
    const quakes = [
      quake({ eventId: null, reportDateTime: "2026-07-07T10:00:00+09:00", hypocenterName: "浦河沖" }),
      quake({ eventId: null, reportDateTime: "2026-07-07T10:00:00+09:00", hypocenterName: "日向灘" }),
    ];
    const { container } = render(RecentQuakes, { quakes });
    expect(container.querySelectorAll("li").length).toBe(2);
    expect(screen.getByText("浦河沖")).toBeTruthy();
    expect(screen.getByText("日向灘")).toBeTruthy();
  });
});

describe("RecentQuakes 発生日付表示", () => {
  it("ごく浅い震源を距離へ置換しない", () => {
    const { container } = render(RecentQuakes, { quakes: [quake({ depth: "ごく浅い" })] });
    expect(container.querySelector(".depth")?.textContent).toBe("ごく浅い");
    expect(container.textContent).not.toContain("~10km");
  });

  it("各行の時刻列に formatMdHm 表記 (M/D HH:MM) で発生日付を前置する", () => {
    const quakes = [quake({ originTime: "2026-03-11T14:46:00+09:00", hypocenterName: "三陸沖" })];
    render(RecentQuakes, { quakes });
    expect(screen.getByText("3/11 14:46")).toBeTruthy();
  });

  it("originTime が null のときは reportDateTime にフォールバックして日付を出す", () => {
    const quakes = [quake({ originTime: null, reportDateTime: "2026-07-06T18:20:00+09:00" })];
    render(RecentQuakes, { quakes });
    expect(screen.getByText("7/6 18:20")).toBeTruthy();
  });
});

describe("RecentQuakes クリック再表示 (2026-07-14)", () => {
  it("各行が button 化され、クリックで onSelect に地震 DTO と安定 ID (index 非依存) を渡す", async () => {
    const onSelect = vi.fn();
    const quakes = [
      quake({ eventId: "A", hypocenterName: "浦河沖" }),
      quake({ eventId: "B", hypocenterName: "日向灘" }),
    ];
    const { container } = render(RecentQuakes, { quakes, onSelect });
    const buttons = container.querySelectorAll("button.row");
    expect(buttons.length).toBe(2);
    buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].hypocenterName).toBe("日向灘");
    expect(onSelect.mock.calls[0][1]).toBe("B"); // recentQuakeId = eventId (配列 index を含まない)
  });

  it("新地震が先頭挿入されても同じ地震の選択 ID は変わらない (再クリックが別項目扱いにならない、指摘4)", async () => {
    const onSelect = vi.fn();
    const before = [quake({ eventId: "B", hypocenterName: "日向灘" })];
    const { container, rerender } = render(RecentQuakes, { quakes: before, onSelect });
    container.querySelector("button.row")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const idBefore = onSelect.mock.calls[0][1];

    // 先頭に新地震 A を挿入 (B は index 0 → 1 へずれる)
    await rerender({ quakes: [quake({ eventId: "A", hypocenterName: "浦河沖" }), ...before], onSelect });
    const bRow = Array.from(container.querySelectorAll("button.row")).find((b) => b.textContent?.includes("日向灘"))!;
    bRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const idAfter = onSelect.mock.calls[1][1];
    expect(idAfter).toBe(idBefore); // index がずれても ID は "B" のまま
  });

  it("行クリックは stopPropagation され、window の click (減光トグル) へ伝播しない", () => {
    const quakes = [quake({ eventId: "A", hypocenterName: "浦河沖" })];
    const { container } = render(RecentQuakes, { quakes, onSelect: () => {} });
    const windowClick = vi.fn();
    window.addEventListener("click", windowClick);
    try {
      const button = container.querySelector("button.row")!;
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(windowClick).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("click", windowClick);
    }
  });

  it("onSelect 未指定でもクリックで crash しない", () => {
    const quakes = [quake({ eventId: "A" })];
    const { container } = render(RecentQuakes, { quakes });
    const button = container.querySelector("button.row")!;
    expect(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true }))).not.toThrow();
  });
});
