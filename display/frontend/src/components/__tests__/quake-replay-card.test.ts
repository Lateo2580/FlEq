import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import QuakeReplayCard from "../QuakeReplayCard.svelte";
import type { DisplayRecentQuakeV1 } from "../../lib/protocol";

function quake(over: Partial<DisplayRecentQuakeV1> = {}): DisplayRecentQuakeV1 {
  return {
    eventId: "Q1",
    reportDateTime: "2026-07-14T21:00:00+09:00",
    originTime: "2026-07-14T20:58:00+09:00",
    hypocenterName: "日向灘",
    magnitude: "5.2",
    maxInt: "5弱",
    maxIntRank: 5,
    depth: "20km",
    tsunamiWarning: false,
    ...over,
  };
}

describe("QuakeReplayCard", () => {
  it("履歴 DTO の実在値 (震央・短縮震度・規模・深さ・発生日時) を表示する", () => {
    const { container } = render(QuakeReplayCard, { quake: quake() });
    expect(screen.getByText("日向灘")).toBeTruthy();
    expect(screen.getByText("5-")).toBeTruthy(); // formatIntShort で "5弱" → "5-"
    expect(screen.getByText("M5.2")).toBeTruthy();
    expect(screen.getByText("20km")).toBeTruthy();
    expect(screen.getByText("7/14 20:58")).toBeTruthy();
    expect(container.querySelector(".int-r5")).toBeTruthy();
  });

  it("tsunamiWarning=true で津波マークを出す", () => {
    render(QuakeReplayCard, { quake: quake({ tsunamiWarning: true }) });
    expect(screen.getByText("津波")).toBeTruthy();
  });

  it("ごく浅い震源を距離へ置換しない", () => {
    const { container } = render(QuakeReplayCard, { quake: quake({ depth: "ごく浅い" }) });
    expect(container.querySelector(".stat:nth-child(2) .stat-value")?.textContent).toBe("ごく浅い");
    expect(container.textContent).not.toContain("~10km");
  });

  it("カードクリックで onClose を呼ぶ", () => {
    const onClose = vi.fn();
    const { container } = render(QuakeReplayCard, { quake: quake(), onClose });
    container.querySelector("button.quake-replay-card")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("カードクリックは stopPropagation され window へ伝播しない (減光トグル防止)", () => {
    const { container } = render(QuakeReplayCard, { quake: quake(), onClose: () => {} });
    const windowClick = vi.fn();
    window.addEventListener("click", windowClick);
    try {
      container.querySelector("button.quake-replay-card")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(windowClick).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("click", windowClick);
    }
  });

  it("maxIntRank>=7 で critical ヘッダになる", () => {
    const { container } = render(QuakeReplayCard, { quake: quake({ maxInt: "7", maxIntRank: 9 }) });
    expect(container.querySelector(".banner-header.critical")).toBeTruthy();
  });

  it("intensityGroups があれば各地の震度を LatestQuakeCard と同じ文法 (震度チップ + 県グループ) で表示する", () => {
    const { container } = render(QuakeReplayCard, {
      quake: quake({
        intensityGroups: [
          { intensity: "5弱", rank: 5, areas: ["宮城県仙台市", "宮城県石巻市"], omittedAreaCount: 0 },
          { intensity: "4", rank: 4, areas: ["福島県福島市"], omittedAreaCount: 0 },
        ],
      }),
    });
    expect(container.querySelector(".groups")).toBeTruthy();
    expect(screen.getByText("震度5弱")).toBeTruthy();
    expect(screen.getByText("震度4")).toBeTruthy();
    expect(screen.getByText("仙台市")).toBeTruthy();
    expect(screen.getByText("石巻市")).toBeTruthy();
    // 県見出しでグルーピングされる (LatestQuakeCard と同じ prefecture-group 文法)
    expect(screen.getAllByText("宮城県").length).toBeGreaterThan(0);
  });

  it("intensityGroups が空/欠落なら震度セクションごと非表示 (無い情報を偽装しない)", () => {
    const { container: c1 } = render(QuakeReplayCard, { quake: quake({ intensityGroups: [] }) });
    expect(c1.querySelector(".groups")).toBeFalsy();
    const { container: c2 } = render(QuakeReplayCard, { quake: quake() }); // intensityGroups 欠落
    expect(c2.querySelector(".groups")).toBeFalsy();
  });

  it("rank 降順に並ぶ (入力順に依らず高い震度が上)", () => {
    const { container } = render(QuakeReplayCard, {
      quake: quake({
        intensityGroups: [
          { intensity: "3", rank: 3, areas: ["A市"], omittedAreaCount: 0 },
          { intensity: "6強", rank: 8, areas: ["B市"], omittedAreaCount: 0 },
        ],
      }),
    });
    const labels = Array.from(container.querySelectorAll(".g-int")).map((el) => el.textContent);
    expect(labels).toEqual(["震度6強", "震度3"]);
  });

  it("上限超過分とサーバ cap の omittedAreaCount を「ほか N 地域」で省略表記する", () => {
    const areas = Array.from({ length: 10 }, (_, i) => `県${i}市`);
    const { container } = render(QuakeReplayCard, {
      quake: quake({
        intensityGroups: [{ intensity: "5弱", rank: 5, areas, omittedAreaCount: 3 }],
      }),
    });
    // 予算 8 → 表示 8、残り 2 + サーバ cap 3 = 5 地域を省略
    expect(container.querySelector(".g-omitted")?.textContent).toContain("ほか5地域");
  });
});
