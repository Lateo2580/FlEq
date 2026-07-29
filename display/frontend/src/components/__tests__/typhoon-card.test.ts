import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import TyphoonCard from "../TyphoonCard.svelte";
import type { ActiveStandbyCardV1, DisplayTyphoonV1 } from "../../lib/protocol";
import { typhoonHeaderTone } from "../../lib/typhoon-header-tone";

function typhoon(over: Partial<DisplayTyphoonV1> = {}): DisplayTyphoonV1 {
  return { typhoonKey: "TC-1", name: "Alpha", nameKana: "ALPHA", remark: null, typhoonNumber: "2605", category: "TS", location: "ocean", pressureHpa: 990, maxWindMs: 25, moveDirection: "N", moveSpeedKmh: 20, reportDateTime: "2026-07-21T00:00:00.000Z", ...over };
}

function typhoonItem(typhoons = [typhoon()]): Extract<ActiveStandbyCardV1, { kind: "typhoon" }> {
  return { kind: "typhoon", surface: "corner-right", key: "typhoon:active", sourceEventIds: ["typhoon-1"], updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-22T00:00:00.000Z", restored: false, severity: "normal", data: { typhoons } };
}

describe("TyphoonCard", () => {
  it("selects emergency across multiple typhoons regardless of order", () => {
    const advisory = typhoon({ intensityClass: "強い" });
    const emergency = typhoon({ typhoonKey: "TC-2", intensityClass: "猛烈な" });
    expect(typhoonHeaderTone([advisory, emergency])).toBe("emergency");
    expect(typhoonHeaderTone([emergency, advisory])).toBe("emergency");
  });

  it("uses the existing weather header tones for intensity and size classes", () => {
    const headerClass = (over: Partial<DisplayTyphoonV1>): DOMTokenList | undefined =>
      render(TyphoonCard, { item: typhoonItem([typhoon(over)]) }).container.querySelector("header")?.classList;

    expect(headerClass({ intensityClass: "強い" })?.contains("advisory")).toBe(true);
    expect(headerClass({ sizeClass: "大型" })?.contains("advisory")).toBe(true);
    expect(headerClass({ intensityClass: "非常に強い" })?.contains("warning")).toBe(true);
    expect(headerClass({ sizeClass: "超大型" })?.contains("warning")).toBe(true);
    expect(headerClass({ intensityClass: "猛烈な" })?.contains("emergency")).toBe(true);
    expect(headerClass({ intensityClass: "強い", sizeClass: "超大型" })?.contains("warning")).toBe(true);
    expect(headerClass({})?.contains("advisory")).toBe(false);
  });

  it("renders number, name, location, and labelled fact columns (no slash-joined facts)", () => {
    const { container } = render(TyphoonCard, { item: typhoonItem() });
    const card = container.querySelector(".typhoon");
    expect(card?.textContent).toContain("5");
    expect(card?.textContent).toContain("ALPHA");
    // 現在位置はラベルなし本文
    expect(container.querySelector(".location")?.textContent).toBe("ocean");
    // ラベル付き 3 列 (スラッシュ羅列は廃止)
    const labels = Array.from(container.querySelectorAll(".meta .stat-label")).map((el) => el.textContent);
    expect(labels).toEqual(["中心気圧", "最大風速", "進行"]);
    expect(container.querySelector(".meta")?.textContent).toContain("990hPa");
    expect(container.querySelector(".meta")?.textContent).toContain("25m/s");
    // 数値大・単位小の NumberUnit で組む (数値と単位を別 span に、複合単位はまとめて単位 span)
    const stats = container.querySelectorAll(".meta .stat-value");
    expect(stats[0].querySelector(".nu-value")?.textContent).toBe("990");
    expect(stats[0].querySelector(".nu-unit")?.textContent).toBe("hPa");
    expect(stats[1].querySelector(".nu-unit")?.textContent).toBe("m/s");
    // 進行は方角テキスト + 速度の NumberUnit (方角は数値化しない)
    expect(stats[2].textContent).toBe("N 20km/h");
    expect(stats[2].querySelector(".nu-value")?.textContent).toBe("20");
    expect(stats[2].querySelector(".nu-unit")?.textContent).toBe("km/h");
    // 旧 .facts (span + " / " 区切り) は消えている
    expect(container.querySelector(".facts")).toBeNull();
    expect(card?.textContent).not.toContain(" / ");
  });

  it("uses remark when a named typhoon is unavailable and renders each aggregated typhoon", () => {
    const { container } = render(TyphoonCard, { item: typhoonItem([typhoon({ name: null, nameKana: null, remark: "remark" }), typhoon({ typhoonKey: "TC-2", typhoonNumber: "2606", nameKana: "BETA" })]) });
    expect(container.querySelectorAll(".typhoon")).toHaveLength(2);
    expect(container.textContent).toContain("remark");
    expect(container.textContent).toContain("BETA");
  });

  it("marks a restored card as synchronizing", () => {
    const { container } = render(TyphoonCard, { item: { ...typhoonItem(), restored: true } });
    expect(container.querySelector(".restored-chip")?.textContent).toBe("同期中");
  });
});
