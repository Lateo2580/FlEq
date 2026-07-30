import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import VolcanoCard from "../VolcanoCard.svelte";
import type { ActiveStandbyCardV1, DisplayVolcanoEventV1 } from "../../lib/protocol";
import { VOLCANO_LEVEL_LABELS } from "../../lib/standby-cards";

function eruptionEvent(over: Partial<DisplayVolcanoEventV1> = {}): DisplayVolcanoEventV1 {
  return {
    label: "噴火",
    craterName: "山頂火口",
    eventDateTime: "2026-07-21T09:05:00+09:00",
    plumeHeightM: 2500,
    plumeHeightUnknown: false,
    plumeDirection: "南東",
    ...over,
  };
}

function volcanoItem(over: Partial<Extract<ActiveStandbyCardV1, { kind: "volcano" }>> = {}): Extract<ActiveStandbyCardV1, { kind: "volcano" }> {
  return {
    kind: "volcano", surface: "corner-right", key: "volcano:active", sourceEventIds: ["volcano-1"],
    updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: null, restored: false, severity: "critical",
    data: { volcanoes: [{ code: "V-1", name: "Mount Test", alertLevel: 4, latestEvent: eruptionEvent() }] }, ...over,
  };
}

describe("VolcanoCard", () => {
  it("噴火イベントを火口・噴火時刻・噴煙高度・流向の stat 列で表示する", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem() });
    expect(container.querySelector(".volcano")?.textContent).toContain("Mount Test");
    expect(container.querySelector(".volcano")?.textContent).toContain(VOLCANO_LEVEL_LABELS[4]);
    expect(container.querySelector("strong")?.textContent).toBe("噴火");
    const labels = Array.from(container.querySelectorAll(".event-stats .stat-label")).map((node) => node.textContent);
    expect(labels).toEqual(["火口", "噴火時刻", "噴煙高度", "流向"]);
    expect(container.querySelector(".crater-stat .stat-value")?.textContent).toBe("山頂火口");
    expect(container.querySelector(".event-time-stat .stat-value")?.textContent).toBe("09:05");
    expect(container.querySelector(".plume-height-stat .nu-value")?.textContent).toBe("2500");
    expect(container.querySelector(".plume-height-stat .nu-unit")?.textContent).toBe("m");
    expect(container.querySelector(".plume-direction-stat .stat-value")?.textContent).toBe("南東");
  });

  it("警戒レベルは「レベル 小 + 数値 大」の NumberUnit prefix 形式で描画する", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [{ code: "506", name: "桜島", alertLevel: 3, latestEvent: null }] },
    }) });
    expect(container.querySelector(".nu-prefix")?.textContent).toBe("レベル");
    expect(container.querySelector(".nu-value")?.textContent).toBe("3");
    // 括弧内ラベルは通常テキストのまま連結される
    expect(container.textContent).toContain("レベル3（入山規制）");
  });

  it("噴火イベント併存時はレベル3と名称も表示する", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [{
        code: "506", name: "桜島", alertLevel: 3,
        warningKind: "噴火警報（火口周辺）", targetKinds: ["入山規制"],
        latestEvent: eruptionEvent(),
      }] },
    }) });
    expect(container.querySelector(".volcano-main .nu-value")?.textContent).toBe("3");
    expect(container.querySelector(".volcano-main")?.textContent).toContain(VOLCANO_LEVEL_LABELS[3]);
  });

  it("単一の対象区分を主行の下に muted 補助行で表示する", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [{
        code: "506", name: "桜島", alertLevel: 4,
        warningKind: "噴火警報（火口周辺）", targetKinds: ["入山規制"], latestEvent: null,
      }] },
    }) });
    const meaning = container.querySelector(".alert-meaning");
    expect(meaning?.textContent).toBe("噴火警報（火口周辺） / 入山規制");
    expect(meaning?.previousElementSibling?.classList.contains("volcano-main")).toBe(true);
  });

  it("数値レベル運用外の警報区分をレベル行へ表示する", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [{
        code: "329",
        name: "硫黄島",
        alertLevel: null,
        alertClass: { code: "22", name: "火口周辺危険", severity: "warning", isActive: true },
        latestEvent: null,
      }] },
    }) });
    expect(container.querySelector(".volcano-main")?.textContent).toContain("硫黄島");
    expect(container.querySelector(".volcano-main")?.textContent).toContain("火口周辺危険");
    expect(container.querySelector(".volcano-card")?.classList.contains("band-warning")).toBe(true);
  });

  it("2 種の対象区分を電文順に列挙する", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [{
        code: "506", name: "桜島", alertLevel: 4,
        warningKind: "噴火警報（火口周辺）", targetKinds: ["入山規制", "避難準備"], latestEvent: null,
      }] },
    }) });
    expect(container.querySelector(".alert-meaning")?.textContent)
      .toBe("噴火警報（火口周辺） / 入山規制・避難準備");
  });

  it("3 種以上の対象区分は先頭 2 種と「ほか N 種」に縮約する", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [{
        code: "506", name: "桜島", alertLevel: 4,
        warningKind: "噴火警報（火口周辺）",
        targetKinds: ["入山規制", "避難準備", "避難", "高齢者等避難"],
        latestEvent: null,
      }] },
    }) });
    expect(container.querySelector(".alert-meaning")?.textContent)
      .toBe("噴火警報（火口周辺） / 入山規制・避難準備・ほか2種");
  });

  it("噴火速報のみで警報意味が欠損する場合は補助行を残さない", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [{
        code: "506", name: "桜島", alertLevel: null,
        warningKind: null, targetKinds: [], latestEvent: eruptionEvent({ label: "噴火速報" }),
      }] },
    }) });
    expect(container.querySelector(".alert-meaning")).toBeNull();
    expect(container.querySelector(".volcano")?.textContent).toContain("噴火速報");
  });

  it("噴煙高度不明は「不明」と表示し、欠損イベントでは高度列を出さない", () => {
    const unknown = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [{
        code: "506", name: "桜島", alertLevel: null,
        latestEvent: eruptionEvent({ plumeHeightM: null, plumeHeightUnknown: true }),
      }] },
    }) });
    expect(unknown.container.querySelector(".plume-height-stat .stat-value")?.textContent?.trim()).toBe("不明");
    expect(unknown.container.querySelector(".plume-height-stat .nu-value")).toBeNull();

    const missing = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [{
        code: "506", name: "桜島", alertLevel: null,
        latestEvent: eruptionEvent({ plumeHeightM: null, plumeHeightUnknown: false }),
      }] },
    }) });
    expect(missing.container.querySelector(".plume-height-stat")).toBeNull();
  });

  it("警報のみなら stat 列を出さず、警報補助行と噴火 stat は共存時も別層に置く", () => {
    const alertOnly = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [{
        code: "506", name: "桜島", alertLevel: 4,
        warningKind: "噴火警報（火口周辺）", targetKinds: ["入山規制"], latestEvent: null,
      }] },
    }) });
    expect(alertOnly.container.querySelector(".event-stats")).toBeNull();
    expect(alertOnly.container.querySelector(".volcano strong")).toBeNull();

    const coexist = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [{
        code: "506", name: "桜島", alertLevel: 4,
        warningKind: "噴火警報（火口周辺）", targetKinds: ["入山規制"],
        latestEvent: eruptionEvent(),
      }] },
    }) });
    const volcano = coexist.container.querySelector(".volcano");
    expect(volcano?.querySelector(":scope > .alert-meaning")?.textContent).toContain("入山規制");
    expect(volcano?.querySelector(":scope > strong")?.nextElementSibling?.classList.contains("event-stats")).toBe(true);
    expect(coexist.container.querySelectorAll(".event-stats .stat")).toHaveLength(4);
  });

  it("段階カラー: カード内最高段階で帯 class を決める (2=黄 advisory / 3=橙 warning / 4=赤 red / 5=紫 emergency)", () => {
    const bandFor = (alertLevel: number | null, latestEvent: DisplayVolcanoEventV1 | null = null): string => {
      const { container, unmount } = render(VolcanoCard, { item: volcanoItem({
        data: { volcanoes: [{ code: "V-1", name: "M", alertLevel, latestEvent }] },
      }) });
      const card = container.querySelector(".volcano-card")!;
      const band = ["band-advisory", "band-warning", "band-red", "band-emergency"].find((c) => card.classList.contains(c));
      unmount();
      return band ?? "none";
    };
    expect(bandFor(2)).toBe("band-advisory");
    expect(bandFor(3)).toBe("band-warning");
    expect(bandFor(4)).toBe("band-red");
    expect(bandFor(5)).toBe("band-emergency");
    // 噴火速報はレベル 4 未満でも赤へ引き上げる
    expect(bandFor(2, eruptionEvent({ label: "噴火速報" }))).toBe("band-red");
  });

  it("最高段階でカード帯を決め、複数火山を並べる (V-1 レベル4 + V-2 噴火速報 → band-red)", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem({
      data: { volcanoes: [
        { code: "V-1", name: "Mount Test", alertLevel: 4, latestEvent: null },
        { code: "V-2", name: "Mount Second", alertLevel: null, latestEvent: eruptionEvent({ label: "eruption" }) },
      ] },
    }) });
    expect(container.querySelector(".volcano-card")?.classList.contains("band-red")).toBe(true);
    expect(container.querySelectorAll(".volcano")).toHaveLength(2);
    expect(container.textContent).toContain("eruption");
  });

  it("marks a restored card as synchronizing", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem({ restored: true }) });
    expect(container.querySelector(".restored-chip")?.textContent).toBe("同期中");
  });
});
