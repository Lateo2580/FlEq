import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import TsunamiStandbyBanner from "../TsunamiStandbyBanner.svelte";
import type { DisplayTsunamiStateV1 } from "../../lib/protocol";

function tsunamiState(over: Partial<DisplayTsunamiStateV1> = {}): DisplayTsunamiStateV1 {
  return {
    kind: "tsunami",
    eventId: over.eventId ?? "T1",
    level: "warning",
    levelLabel: "津波警報",
    coasts: [
      { name: "宮崎県", kind: "津波警報", maxHeight: "3m", firstHeight: "既に到達と推測" },
      { name: "大分県瀬戸内海沿岸", kind: "津波警報", maxHeight: "3m", firstHeight: null },
    ],
    warningComment: null,
    observations: [],
    reportDateTime: "2026-07-07T14:32:00+09:00",
    updatedAtMs: 0,
    ...over, unkeyedSequence: over.unkeyedSequence ?? null,
  };
}

describe("TsunamiStandbyBanner", () => {
  it("単一レベルのみなら「等」を付けずに見出しを出す", () => {
    const { container } = render(TsunamiStandbyBanner, { tsunami: tsunamiState() });
    const header = container.querySelector(".standby-card-header__title");
    expect(header?.textContent?.replace(/\s+/g, " ").trim()).toBe("津波警報 発令中");
  });

  // 最終レビュー Finding 2 (spec D1、確信度 0.97-0.99): .etc (「等」suffix) は親 .banner-header
  // (--type-title-s-fluid、960px 幅で約 16.3px) の 0.7em 単体だと約 11.42px まで落ち、層2
  // (低プロミネンス補足) の 12px 床を割っていた。jsdom は scoped <style> の getComputedStyle 解決が
  // 不確実なため (このファイル・tsunami-panel.test.ts 共通の既存流儀)、ソース文字列で
  // max(12px, 0.7em) になっていることを検査する
  it(".etc (「等」suffix) は max(12px, 0.7em) で層2床 (12px) を割らない (spec D1)", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiStandbyBanner.svelte"), "utf-8");
    expect(source).toMatch(/\.etc\s*\{[^}]*font-size: max\(12px, 0\.7em\);/);
  });

  it("複数レベル混在時は「等」付きの見出しになる (最高レベル基準)", () => {
    const tsunami = tsunamiState({
      level: "majorWarning",
      coasts: [
        { name: "宮崎県", kind: "大津波警報", maxHeight: "10m超", firstHeight: null },
        { name: "高知県", kind: "津波警報", maxHeight: "3m", firstHeight: null },
        { name: "沖縄本島地方", kind: "津波注意報", maxHeight: "1m", firstHeight: null },
      ],
    });
    const { container } = render(TsunamiStandbyBanner, { tsunami });
    const header = container.querySelector(".standby-card-header__title");
    expect(header?.textContent?.replace(/\s+/g, " ").trim()).toBe("大津波警報等 発令中");
  });

  it("狭幅でも見出しを一行に保ち、更新時刻を縮小・省略できる", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiStandbyBanner.svelte"), "utf-8");
    const theme = readFileSync(join(__dirname, "../../lib/theme.css"), "utf-8");
    expect(theme).toMatch(/\.standby-card-header\s*\{[^}]*min-width:\s*0;/s);
    expect(theme).toMatch(/\.standby-card-header__title\s*\{[^}]*white-space:\s*nowrap;/s);
    expect(source).toMatch(/\.standby-card-header__meta :global\(\.updated-stamp\)\s*\{[^}]*max-width:\s*45%;[^}]*font-size:\s*clamp\(10px, 2\.6cqw, 14px\)/s);
    expect(source).toMatch(/@container \(max-width:\s*240px\)\s*\{\s*\.standby-card-header__meta :global\(\.updated-stamp\)\s*\{\s*display:\s*none;/s);
  });

  it("レベル別カウントを降順 (大津波→警報→注意報) のチップで render する", () => {
    const tsunami = tsunamiState({
      level: "majorWarning",
      coasts: [
        { name: "宮崎県", kind: "大津波警報", maxHeight: "10m超", firstHeight: null },
        { name: "高知県", kind: "大津波警報", maxHeight: "10m超", firstHeight: null },
        { name: "大分県瀬戸内海沿岸", kind: "津波警報", maxHeight: "3m", firstHeight: null },
        { name: "沖縄本島地方", kind: "津波注意報", maxHeight: "1m", firstHeight: null },
      ],
    });
    const { container } = render(TsunamiStandbyBanner, { tsunami });
    const items = Array.from(container.querySelectorAll(".count-chip")).map((el) => el.textContent);
    expect(items).toEqual(["大津波 2", "警報 1", "注意報 1"]);
  });

  it("coasts の地域名が marquee テキストとしてレベル見出し付きで render される", () => {
    const { container } = render(TsunamiStandbyBanner, { tsunami: tsunamiState() });
    const marquee = container.querySelector(".marquee-text");
    expect(marquee?.textContent).toBe("【津波警報】宮崎県・大分県瀬戸内海沿岸");
  });

  it("初回 paint から最上位区分の先頭予報区と全体総数を静的アンカーに出す", () => {
    const tsunami = tsunamiState({
      level: "majorWarning",
      coasts: [
        { name: "宮崎県", kind: "大津波警報", maxHeight: "10m超", firstHeight: null },
        { name: "高知県", kind: "津波警報", maxHeight: "3m", firstHeight: null },
        { name: "沖縄本島地方", kind: "津波注意報", maxHeight: "1m", firstHeight: null },
      ],
    });
    const { container } = render(TsunamiStandbyBanner, { tsunami });
    expect(container.querySelector("[data-anchor-label]")?.textContent).toBe("対象 3予報区・先頭 宮崎県（ほか2）");
  });

  it("既存の一行高の中で anchor と補助 scan viewport を並べる", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiStandbyBanner.svelte"), "utf-8");
    expect(source).toMatch(/\.banner-areas\s*\{[^}]*display:\s*flex;[^}]*height:\s*1\.5em;/s);
    expect(source).toMatch(/\.scan-viewport\s*\{[^}]*height:\s*1\.5em;[^}]*overflow:\s*hidden;/s);
  });

  it("coasts が空なら marquee 領域が render されない", () => {
    const { container } = render(TsunamiStandbyBanner, { tsunami: tsunamiState({ coasts: [] }) });
    expect(container.querySelector(".banner-areas")).toBeFalsy();
  });

  it("coasts が空ならカウント行 (.banner-counts) も render されない", () => {
    const { container } = render(TsunamiStandbyBanner, { tsunami: tsunamiState({ coasts: [] }) });
    expect(container.querySelector(".banner-counts")).toBeFalsy();
  });

  it("coasts が全件 unknown kind (津波予報等) ならカウント行が render されず、見出しは fallback (state.level) で出す", () => {
    const tsunami = tsunamiState({
      level: "advisory",
      coasts: [{ name: "大阪府", kind: "津波予報（若干の海面変動）", maxHeight: null, firstHeight: null }],
    });
    const { container } = render(TsunamiStandbyBanner, { tsunami });
    expect(container.querySelector(".banner-counts")).toBeFalsy();
    const header = container.querySelector(".standby-card-header__title");
    expect(header?.textContent?.replace(/\s+/g, " ").trim()).toBe("津波注意報 発令中");
  });

  it("接尾辞つき kind (「大津波警報：発表」等の古い state) でもレベル分類・見出しが崩れない", () => {
    const tsunami = tsunamiState({
      level: "majorWarning",
      coasts: [
        { name: "岩手県", kind: "大津波警報：発表", maxHeight: "巨大", firstHeight: null },
      ],
    });
    const { container } = render(TsunamiStandbyBanner, { tsunami });
    const header = container.querySelector(".standby-card-header__title");
    expect(header?.textContent?.replace(/\s+/g, " ").trim()).toBe("大津波警報 発令中");
    const items = Array.from(container.querySelectorAll(".count-chip")).map((el) => el.textContent);
    expect(items).toEqual(["大津波 1"]);
  });

  it("count-chip は radius-full (pill) トークンで直値 999px を持たない", () => {
    const src = readFileSync(join(__dirname, "..", "TsunamiStandbyBanner.svelte"), "utf-8");
    expect(src).toContain("var(--radius-full)");
    expect(src).not.toMatch(/border-radius:\s*999px/);
  });

  it("standby header は container/on/band トークンで --bar-* を使わない", () => {
    const src = readFileSync(join(__dirname, "..", "TsunamiStandbyBanner.svelte"), "utf-8");
    expect(src).toMatch(/var\(--header-tsunami\w+-container\)/);
    expect(src).toContain("--standby-header-band");
    expect(src).not.toContain("var(--bar-");
  });

  // 第3波 Fix10: marquee の走行距離が要素自身の幅 (translateX(100%→-100%)) に対する相対値だと、
  // 51 予報区分のような長大な marqueeText で「最初の文字が見えるまでの待ち時間」がテキスト長に
  // 比例して際限なく伸びる構造だった (最初の文字が現れない、と観測された)。left:100% (コンテナ
  // 基準) + 実測 px の --marquee-shift に切り替えたことをソースレベルで固定する
  it("marquee はコンテナ基準の left:100% で開始し、要素自身の幅に対する相対 translateX(±100%) を使わない (Fix10)", () => {
    const src = readFileSync(join(__dirname, "..", "TsunamiStandbyBanner.svelte"), "utf-8");
    expect(src).toContain("left: 100%");
    expect(src).toContain("--marquee-shift");
    expect(src).not.toMatch(/transform:\s*translateX\(100%\)/);
    expect(src).not.toMatch(/transform:\s*translateX\(-100%\)/);
  });

  it("marquee の duration は長大な地域リストでも有限値に収まる (jsdom は 0 幅なので下限 18s に floor される)", () => {
    const manyCoasts = Array.from({ length: 51 }, (_, i) => ({
      name: `予報区${i}`,
      kind: "津波警報",
      maxHeight: "1m",
      firstHeight: null,
    }));
    const { container } = render(TsunamiStandbyBanner, {
      tsunami: tsunamiState({ coasts: manyCoasts }),
    });
    const text = container.querySelector(".marquee-text") as HTMLElement | null;
    expect(text).toBeTruthy();
    const style = text?.getAttribute("style") ?? "";
    const duration = Number(style.match(/animation-duration:\s*([\d.]+)s/)?.[1]);
    expect(Number.isFinite(duration)).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(18);
  });

  it("staticMarquee は全件静止ページを一周し、補助経路を残す", async () => {
    vi.useFakeTimers();
    const { container } = render(TsunamiStandbyBanner, {
      tsunami: tsunamiState(),
      staticMarquee: true,
    });
    const page = container.querySelector<HTMLElement>(".marquee-text-static");
    expect(page?.dataset.marqueeStatic).toBe("true");
    expect(page?.textContent).toBe("【津波警報】");
    await vi.advanceTimersByTimeAsync(10_000);
    await tick();
    expect(container.querySelector(".marquee-text-static")?.textContent).toBe("宮崎県");
    const source = readFileSync(join(__dirname, "..", "TsunamiStandbyBanner.svelte"), "utf-8");
    expect(source).toContain("const staticScan = $derived(reducedMotion || staticMarqueeEnabled)");
  });

  // 第3波 Fix16: 減光は opacity ではなく background の color-mix (surface へのトーンブレンド) で
  // 表現する (祖先 .standby.dim との opacity 乗算事故を避けるため)。テストでは style 属性に
  // color-mix( が含まれるかで減光状態を判定する
  function isDim(el: Element | null | undefined): boolean {
    return el?.getAttribute("style")?.includes("color-mix(") ?? false;
  }

  // 第3波 Fix12: 種別ごとに分割した marquee を順番に流し、流れている種別のチップだけ強調する
  function multiLevelTsunami(): DisplayTsunamiStateV1 {
    return tsunamiState({
      level: "majorWarning",
      coasts: [
        { name: "宮崎県", kind: "大津波警報", maxHeight: "10m超", firstHeight: null },
        { name: "高知県", kind: "津波警報", maxHeight: "3m", firstHeight: null },
        { name: "沖縄本島地方", kind: "津波注意報", maxHeight: "1m", firstHeight: null },
      ],
    });
  }

  it("複数種別のときは最初のセグメント (大津波警報) だけを流し、対応チップだけ強調 (dim なし) する", () => {
    const { container } = render(TsunamiStandbyBanner, { tsunami: multiLevelTsunami() });
    const marquee = container.querySelector(".marquee-text");
    expect(marquee?.textContent).toBe("【大津波警報】宮崎県");

    const chips = Array.from(container.querySelectorAll(".count-chip"));
    expect(chips[0].textContent).toBe("大津波 1");
    expect(isDim(chips[0])).toBe(false);
    expect(chips[1].textContent).toBe("警報 1");
    expect(isDim(chips[1])).toBe(true);
    expect(chips[2].textContent).toBe("注意報 1");
    expect(isDim(chips[2])).toBe(true);
  });

  it("単一種別のときはどのチップも dim しない (現行と同じ常時強調)", () => {
    const { container } = render(TsunamiStandbyBanner, { tsunami: tsunamiState() });
    const chip = container.querySelector(".count-chip");
    expect(isDim(chip)).toBe(false);
  });

  it("animationend → 間隔 (1.5s) 経過で次の種別 (津波警報) へ切り替わり、チップの強調も同期する", async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(TsunamiStandbyBanner, { tsunami: multiLevelTsunami() });
      const first = container.querySelector(".marquee-text");
      expect(first?.textContent).toBe("【大津波警報】宮崎県");

      first?.dispatchEvent(new Event("animationend"));
      // 間隔中はまだ切り替わらない
      vi.advanceTimersByTime(1000);
      await tick();
      expect(container.querySelector(".marquee-text")?.textContent).toBe("【大津波警報】宮崎県");

      vi.advanceTimersByTime(600);
      await tick();
      expect(container.querySelector(".marquee-text")?.textContent).toBe("【津波警報】高知県");

      const chips = Array.from(container.querySelectorAll(".count-chip"));
      expect(isDim(chips[0])).toBe(true); // 大津波 (流れ終わった)
      expect(isDim(chips[1])).toBe(false); // 警報 (いま流れている)
      expect(isDim(chips[2])).toBe(true); // 注意報 (まだ)
    } finally {
      vi.useRealTimers();
    }
  });

  it("reduced-motion 時は clamp せず、補助 scan を全種別へ到達する静止ページに替え、チップはどれも dim しない", async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(TsunamiStandbyBanner, { tsunami: multiLevelTsunami(), reducedMotion: true });
      expect(container.querySelector(".marquee-text")).toBeFalsy();
      const staticEl = container.querySelector(".marquee-text-static");
      expect(staticEl?.textContent).toBe("【大津波警報】");
      await vi.advanceTimersByTimeAsync(10_000);
      await tick();
      expect(container.querySelector(".marquee-text-static")?.textContent).toBe("宮崎県");
      const chips = Array.from(container.querySelectorAll(".count-chip"));
      expect(chips.every((c) => !isDim(c))).toBe(true);
      const source = readFileSync(join(__dirname, "..", "TsunamiStandbyBanner.svelte"), "utf-8");
      expect(source).not.toContain("-webkit-line-clamp");
      expect(source).not.toContain("line-clamp:");
    } finally { vi.useRealTimers(); }
  });

  // 第3波 Fix16: opacity ベースの減光は祖先 .standby.dim (親0.35×子0.7=実効約0.245) と乗算し、
  // 非対象チップの実効アルファが 0.245×0.45≈0.11 まで落ちてほぼ視認不能になることを実測で確認した。
  // opacity を使わない色ブレンド方式へ変更したことをソースレベルで固定する
  it("count-chip の強調/減光は opacity ではなく background の色ブレンドで表現する (祖先 dim との乗算事故防止、Fix16)", () => {
    const src = readFileSync(join(__dirname, "..", "TsunamiStandbyBanner.svelte"), "utf-8");
    expect(src).toContain("color-mix(");
    expect(src).not.toMatch(/\.count-chip\.dim\s*\{[\s\S]*?opacity:/);
    expect(src).not.toMatch(/opacity:\s*0\.45/);
  });

  // 2026-07-14 チップクリック再生
  it("count-chip は button 化され、クリックで onReplayLevel にそのレベルを渡す", () => {
    const onReplayLevel = vi.fn();
    const tsunami = tsunamiState({
      level: "majorWarning",
      coasts: [
        { name: "宮崎県", kind: "大津波警報", maxHeight: "10m超", firstHeight: null },
        { name: "高知県", kind: "津波警報", maxHeight: "3m", firstHeight: null },
        { name: "沖縄本島地方", kind: "津波注意報", maxHeight: "1m", firstHeight: null },
      ],
    });
    const { container } = render(TsunamiStandbyBanner, { tsunami, onReplayLevel });
    const chips = container.querySelectorAll("button.count-chip");
    expect(chips.length).toBe(3);
    chips[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onReplayLevel).toHaveBeenLastCalledWith("majorWarning");
    chips[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onReplayLevel).toHaveBeenLastCalledWith("advisory");
  });

  it("チップクリックは stopPropagation され window の click (減光トグル) へ伝播しない", () => {
    const { container } = render(TsunamiStandbyBanner, { tsunami: tsunamiState(), onReplayLevel: () => {} });
    const windowClick = vi.fn();
    window.addEventListener("click", windowClick);
    try {
      container.querySelector("button.count-chip")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(windowClick).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("click", windowClick);
    }
  });

  it("onReplayLevel 未指定でもチップクリックで crash しない", () => {
    const { container } = render(TsunamiStandbyBanner, { tsunami: tsunamiState() });
    const chip = container.querySelector("button.count-chip")!;
    expect(() => chip.dispatchEvent(new MouseEvent("click", { bubbles: true }))).not.toThrow();
  });
});
