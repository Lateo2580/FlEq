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
    // 気圧・風速の数値本体は RollingNumber、進行速度は NumberUnit で組む
    const stats = container.querySelectorAll(".meta .stat-value");
    expect(stats[0].querySelector('[data-value="990"]')).toBeTruthy();
    expect(stats[0].querySelector(".stat-unit")?.textContent).toBe("hPa");
    expect(stats[1].querySelector('[data-value="25"]')).toBeTruthy();
    expect(stats[1].querySelector(".stat-unit")?.textContent).toBe("m/s");
    // 進行は方角テキスト + 速度の NumberUnit (方角は数値化しない)
    expect(stats[2].textContent).toBe("N 20km/h");
    expect(stats[2].querySelector(".nu-value")?.textContent).toBe("20");
    expect(stats[2].querySelector(".nu-unit")?.textContent).toBe("km/h");
    // 旧 .facts (span + " / " 区切り) は消えている
    expect(container.querySelector(".facts")).toBeNull();
    expect(card?.textContent).not.toContain(" / ");
  });

  it("気圧・風速の変化と総合 trend を muted 補助行に表示する", () => {
    const { container } = render(TyphoonCard, {
      item: typhoonItem([typhoon({
        pressureHpa: 980,
        pressureDeltaHpa: -10,
        maxWindMs: 30,
        maxWindDeltaMs: 5,
        intensityTrend: "developing",
      })]),
    });

    expect(container.querySelector(".pressure-delta")?.textContent).toBe("↓ 10 hPa");
    expect(container.querySelector(".wind-delta")?.textContent).toBe("↑ 5 m/s");
    expect(container.querySelector(".trend-label")?.textContent).toBe("発達傾向");
    expect(container.querySelector(".change-summary")?.querySelectorAll(".change-item")).toHaveLength(3);
    expect(container.querySelector('[data-value="980"]')).toBeTruthy();
    expect(container.querySelector('[data-value="30"]')).toBeTruthy();
  });

  it("片側差分が欠損していると総合 trend ラベルを表示しない", () => {
    const { container } = render(TyphoonCard, {
      item: typhoonItem([typhoon({
        pressureDeltaHpa: -5,
        maxWindDeltaMs: null,
        intensityTrend: "developing",
      })]),
    });

    expect(container.querySelector(".pressure-delta")?.textContent).toBe("↓ 5 hPa");
    expect(container.querySelector(".change-summary")?.querySelectorAll(".change-item")).toHaveLength(1);
    expect(container.querySelector(".trend-label")).toBeNull();
  });

  it("集約時も各台風の差分と trend を台風ごとに 1 補助行へ束ねる", () => {
    const { container } = render(TyphoonCard, {
      item: typhoonItem([
        typhoon({
          pressureDeltaHpa: -10,
          maxWindDeltaMs: 5,
          intensityTrend: "developing",
        }),
        typhoon({
          typhoonKey: "TC-2",
          typhoonNumber: "2606",
          pressureDeltaHpa: 8,
          maxWindDeltaMs: -4,
          intensityTrend: "weakening",
        }),
      ]),
    });

    const typhoons = container.querySelectorAll(".typhoon");
    expect(typhoons).toHaveLength(2);
    expect(typhoons[0].querySelectorAll(".change-summary")).toHaveLength(1);
    expect(typhoons[0].querySelectorAll(".change-item")).toHaveLength(3);
    expect(typhoons[0].querySelector(".change-summary")?.textContent).toContain("↓ 10 hPa");
    expect(typhoons[0].querySelector(".change-summary")?.textContent).toContain("↑ 5 m/s");
    expect(typhoons[0].querySelector(".change-summary")?.textContent).toContain("発達傾向");
    expect(typhoons[1].querySelectorAll(".change-summary")).toHaveLength(1);
    expect(typhoons[1].querySelectorAll(".change-item")).toHaveLength(3);
    expect(typhoons[1].querySelector(".change-summary")?.textContent).toContain("↑ 8 hPa");
    expect(typhoons[1].querySelector(".change-summary")?.textContent).toContain("↓ 4 m/s");
    expect(typhoons[1].querySelector(".change-summary")?.textContent).toContain("衰弱傾向");
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
