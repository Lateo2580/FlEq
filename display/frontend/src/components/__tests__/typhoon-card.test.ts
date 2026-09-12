import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import TyphoonCard from "../TyphoonCard.svelte";
import type {
  ActiveStandbyCardV1,
  DisplayTyphoonNumericSemanticV1,
  DisplayTyphoonProbabilityV1,
  DisplayTyphoonV1,
} from "../../lib/protocol";
import { typhoonHeaderTone } from "../../lib/typhoon-header-tone";

function typhoon(over: Partial<DisplayTyphoonV1> = {}): DisplayTyphoonV1 {
  return { typhoonKey: "TC-1", name: "Alpha", nameKana: "ALPHA", remark: null, typhoonNumber: "2605", category: "TS", location: "ocean", pressureHpa: 990, maxWindMs: 25, maxGustMs: 35, moveDirection: "N", moveSpeedKmh: 20, reportDateTime: "2026-07-21T00:00:00.000Z", ...over };
}

function typhoonItem(typhoons = [typhoon()]): Extract<ActiveStandbyCardV1, { kind: "typhoon" }> {
  return { kind: "typhoon", surface: "corner-right", key: "typhoon:active", sourceEventIds: ["typhoon-1"], updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-22T00:00:00.000Z", restored: false, severity: "normal", data: { typhoons } };
}

function probability(
  over: Partial<DisplayTyphoonProbabilityV1> = {},
): DisplayTyphoonProbabilityV1 {
  return {
    baseTime: "2026-07-20T00:00:00.000Z",
    forecastEndsAt: "2026-07-25T00:00:00.000Z",
    reportDateTime: "2026-07-21T00:00:00.000Z",
    maxFiveDayProbability: 80,
    activePrefectureCount: 8,
    topPrefectures: [
      ["13", "東京都", 80],
      ["14", "神奈川県", 70],
      ["12", "千葉県", 60],
      ["11", "埼玉県", 50],
      ["08", "茨城県", 40],
      ["09", "栃木県", 30],
    ].map(([prefectureCode, prefectureName, fiveDayProbability]) => ({
      prefectureCode: String(prefectureCode),
      prefectureName: String(prefectureName),
      fiveDayProbability: Number(fiveDayProbability),
    })),
    worstArea: {
      areaCode: "1300",
      areaName: "東京地方",
      prefectureCode: "13",
      prefectureName: "東京都",
      fiveDayProbability: 80,
      peakAt: "2026-07-21T00:00:00.000Z",
    },
    ...over,
  };
}

function numericSemantic(
  over: Partial<DisplayTyphoonNumericSemanticV1> = {},
): DisplayTyphoonNumericSemanticV1 {
  return {
    raw: "20",
    presence: "value",
    label: "20km/h",
    condition: null,
    description: null,
    value: 20,
    lowerBound: null,
    upperBound: null,
    rawLowerBound: null,
    rawUpperBound: null,
    badge: null,
    color: "normalRank",
    render: true,
    rank: { kind: "value", value: 20 },
    ...over,
  };
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

  it("muted header は severity 変数三組を設定しない", () => {
    const { container } = render(TyphoonCard, { item: typhoonItem([typhoon({})]) });
    const header = container.querySelector("header.standby-card-header");
    expect(header?.classList.contains("standby-card-header--muted")).toBe(true);
    expect(header?.getAttribute("style") ?? "").toBe("");
  });

  it("renders number, name, location, and labelled fact columns (no slash-joined facts)", () => {
    const { container } = render(TyphoonCard, { item: typhoonItem() });
    const card = container.querySelector(".typhoon");
    expect(card?.textContent).toContain("5");
    expect(card?.textContent).toContain("ALPHA");
    // 現在位置はラベルなし本文
    expect(container.querySelector(".location")?.textContent).toBe("ocean");
    expect(container.querySelector(".typhoon-title-row > .location")?.textContent).toBe("ocean");
    expect(container.querySelector(".typhoon > .location")).toBeNull();
    // 最大瞬間風速は「最大瞬間」に短縮して最大風速の隣に置き、差分は追加しない
    const labels = Array.from(container.querySelectorAll(".meta .stat-label")).map((el) => el.textContent);
    expect(labels).toEqual(["中心気圧", "最大風速", "最大瞬間", "進行"]);
    // 気圧・風速・瞬間風速の数値本体は RollingNumber、進行速度は NumberUnit で組む
    const stats = container.querySelectorAll(".meta .stat-value");
    expect(stats[0].querySelector('[data-value="990"]')).toBeTruthy();
    expect(stats[0].querySelector(".stat-unit")?.textContent).toBe("hPa");
    expect(stats[1].querySelector('[data-value="25"]')).toBeTruthy();
    expect(stats[1].querySelector(".stat-unit")?.textContent).toBe("m/s");
    expect(stats[2].querySelector('[data-value="35"]')).toBeTruthy();
    expect(stats[2].querySelector(".stat-unit")?.textContent).toBe("m/s");
    // 進行は方角語と速度を別の原子トークンにし、方角は数値化しない
    expect(Array.from(stats[3].querySelectorAll(".stat-token")).map((el) => el.textContent)).toEqual(["N", "20km/h"]);
    expect(stats[3].querySelector(".nu-value")?.textContent).toBe("20");
    expect(stats[3].querySelector(".nu-unit")?.textContent).toBe("km/h");
    expect(container.querySelector(".gust-delta")).toBeNull();
    // 旧 .facts (span + " / " 区切り) は消えている
    expect(container.querySelector(".facts")).toBeNull();
    expect(card?.textContent).not.toContain(" / ");
  });

  it("長い台風名でも位置欄の42%をfull/compactで予約する", () => {
    const source = readFileSync(join(__dirname, "..", "TyphoonCard.svelte"), "utf-8");
    expect(source).toMatch(/\.typhoon-title-row strong\s*\{[^}]*flex:\s*1 1 55%;/s);
    expect(source).toMatch(/\.typhoon-title-row \.location\s*\{[^}]*flex:\s*0 0 42%;/s);
    expect(source).toMatch(/\.compact-primary strong\s*\{[^}]*flex:\s*1 1 55%;/s);
    expect(source).toMatch(/\.compact-primary \.compact-location\s*\{[^}]*flex:\s*0 0 42%;/s);
  });

  it("exact semantic は scalar/label でなく value だけを既存の数値 component へ渡す", () => {
    const { container } = render(TyphoonCard, { item: typhoonItem([typhoon({
      pressureHpa: 999,
      pressureHpaSemantic: numericSemantic({
        raw: "990", label: "990hPa", value: 990, rank: { kind: "value", value: 990 },
      }),
      maxWindMs: 99,
      maxWindMsSemantic: numericSemantic({
        raw: "25", label: "25m/s", value: 25, rank: { kind: "value", value: 25 },
      }),
      maxGustMs: 99,
      maxGustMsSemantic: numericSemantic({
        raw: "35", label: "35m/s", value: 35, rank: { kind: "value", value: 35 },
      }),
      moveSpeedKmh: 99,
      moveSpeedKmhSemantic: numericSemantic(),
    })]) });

    const stats = container.querySelectorAll(".meta .stat-value");
    expect(stats[0].querySelector('[data-value="990"]')).toBeTruthy();
    expect(stats[0].querySelector(".stat-unit")?.textContent).toBe("hPa");
    expect(stats[0].querySelectorAll(".stat-unit")).toHaveLength(1);
    expect(stats[1].querySelector('[data-value="25"]')).toBeTruthy();
    expect(stats[1].querySelector(".stat-unit")?.textContent).toBe("m/s");
    expect(stats[1].querySelectorAll(".stat-unit")).toHaveLength(1);
    expect(stats[2].querySelector('[data-value="35"]')).toBeTruthy();
    expect(stats[2].querySelector(".stat-unit")?.textContent).toBe("m/s");
    expect(stats[2].querySelectorAll(".stat-unit")).toHaveLength(1);
    expect(stats[3].querySelector(".nu-value")?.textContent).toBe("20");
    expect(stats[3].textContent).toBe("N 20km/h");
    expect(container.querySelector('[data-value="999"]')).toBeNull();
  });

  it("移動速度 qualitative は理由付き通常テキスト＋badge、WindSpeed なしは scalar 0 の従来表示にする", () => {
    const { container } = render(TyphoonCard, { item: typhoonItem([typhoon({
      pressureHpa: null,
      pressureHpaSemantic: numericSemantic({
        raw: "", presence: "unknown", label: "不明", condition: "解析不能",
        value: null, badge: "?", color: "unknown", rank: { kind: "unranked" },
      }),
      maxWindMs: 0,
      maxWindMsSemantic: numericSemantic({
        raw: "0", presence: "qualitative", label: "なし", condition: "なし",
        value: null, badge: "?", color: "unknown", rank: { kind: "unranked" },
      }),
      maxGustMs: null,
      maxGustMsSemantic: numericSemantic({
        raw: null, presence: "missing", label: null, value: null,
        badge: null, color: "notRendered", render: false, rank: { kind: "unranked" },
      }),
      moveSpeedKmh: null,
      moveSpeedKmhSemantic: numericSemantic({
        raw: "", presence: "qualitative", label: "ほとんど停滞", condition: "ほとんど停滞",
        description: "移動が極めて遅い状態", value: null, badge: "?", color: "unknown",
        rank: { kind: "unranked" },
      }),
    })]) });

    const labels = Array.from(container.querySelectorAll(".meta .stat-label")).map((el) => el.textContent);
    expect(labels).toEqual(["最大風速", "進行"]);
    const stats = container.querySelectorAll(".meta .stat-value");
    expect(stats[0].querySelector('[data-value="0"]')).toBeTruthy();
    expect(stats[0].querySelector(".stat-unit")?.textContent).toBe("m/s");
    expect(stats[0].querySelector(".semantic-badge")).toBeNull();
    expect(stats[1].textContent).toBe("N ほとんど停滞?");
    const semanticSpeed = stats[1].querySelector<HTMLElement>(".semantic-speed");
    expect(semanticSpeed?.querySelector(".semantic-text")?.textContent).toBe("ほとんど停滞");
    expect(semanticSpeed?.title).toContain("条件: ほとんど停滞");
    expect(semanticSpeed?.title).toContain("説明: 移動が極めて遅い状態");
    expect(semanticSpeed?.title).toContain("記号 ?: 不明・定性値");
    expect(semanticSpeed?.getAttribute("aria-label")).toBe(semanticSpeed?.title);
    expect(semanticSpeed?.querySelector(".semantic-badge")?.textContent).toBe("?");
    expect(semanticSpeed?.querySelector(".semantic-badge")?.getAttribute("aria-hidden")).toBe("true");
    expect(semanticSpeed?.querySelector(".nu-value")).toBeNull();
    expect(semanticSpeed?.querySelector("[data-value]")).toBeNull();
  });

  it("気圧・最大風速・最大瞬間の特殊値は semantic label/badge を新規表示しない", () => {
    const { container } = render(TyphoonCard, { item: typhoonItem([typhoon({
      pressureHpa: null,
      pressureHpaSemantic: numericSemantic({
        raw: "950", presence: "range", label: "950hPa以上", condition: "以上",
        value: null, lowerBound: 950, rawLowerBound: "950", badge: "≥",
        color: "safetyRank", rank: { kind: "range", lowerBound: 950, upperBound: null },
      }),
      maxWindMs: null,
      maxWindMsSemantic: numericSemantic({
        raw: "不明", presence: "unknown", label: "不明", value: null,
        badge: "?", color: "unknown", rank: { kind: "unranked" },
      }),
      maxGustMs: null,
      maxGustMsSemantic: numericSemantic({
        raw: "", presence: "empty", label: "空欄", value: null,
        badge: "∅", color: "neutral", rank: { kind: "unranked" },
      }),
      moveSpeedKmh: null,
      moveSpeedKmhSemantic: numericSemantic({
        raw: null, presence: "missing", label: null, value: null,
        badge: null, color: "notRendered", render: false, rank: { kind: "unranked" },
      }),
    })]) });

    expect(container.querySelector(".meta")).toBeNull();
    expect(container.textContent).not.toMatch(/950hPa以上|不明\?|空欄∅/u);
  });

  it("移動速度の unknown・empty・range・missing は進行列を新規表示しない", () => {
    const cases: Array<{ name: string; semantic: DisplayTyphoonNumericSemanticV1 }> = [
      {
        name: "unknown",
        semantic: numericSemantic({
          raw: "不明", presence: "unknown", label: "不明", value: null,
          badge: "?", color: "unknown", render: true, rank: { kind: "unranked" },
        }),
      },
      {
        name: "empty",
        semantic: numericSemantic({
          raw: "", presence: "empty", label: "空欄", value: null,
          badge: "∅", color: "neutral", render: true, rank: { kind: "unranked" },
        }),
      },
      {
        name: "range",
        semantic: numericSemantic({
          raw: "10", presence: "range", label: "10km/h以上", condition: "以上",
          value: null, lowerBound: 10, rawLowerBound: "10", badge: "≥",
          color: "safetyRank", render: true,
          rank: { kind: "range", lowerBound: 10, upperBound: null },
        }),
      },
      {
        name: "missing",
        semantic: numericSemantic({
          raw: null, presence: "missing", label: null, value: null,
          badge: null, color: "notRendered", render: false, rank: { kind: "unranked" },
        }),
      },
    ];

    for (const { name, semantic } of cases) {
      const { container, unmount } = render(TyphoonCard, { item: typhoonItem([typhoon({
        pressureHpa: null,
        maxWindMs: null,
        maxGustMs: null,
        moveSpeedKmh: null,
        moveSpeedKmhSemantic: semantic,
      })]) });
      expect(container.querySelector(".meta"), name).toBeNull();
      expect(container.textContent, name).not.toContain("進行");
      expect(container.querySelector(".semantic-speed"), name).toBeNull();
      unmount();
    }
  });

  it("移動速度 unknown でも valid な旧 scalar があれば従来の数値列へ戻す", () => {
    const { container } = render(TyphoonCard, { item: typhoonItem([typhoon({
      pressureHpa: null,
      maxWindMs: null,
      maxGustMs: null,
      moveDirection: "北",
      moveSpeedKmh: 10,
      moveSpeedKmhSemantic: numericSemantic({
        raw: "10", presence: "unknown", label: "不明", condition: "不明",
        value: null, badge: "?", color: "unknown", render: true,
        rank: { kind: "unranked" },
      }),
    })]) });

    expect(container.querySelector(".stat-label")?.textContent).toBe("進行");
    expect(container.querySelector(".stat-value")?.textContent).toBe("北 10km/h");
    expect(container.querySelector(".nu-value")?.textContent).toBe("10");
    expect(container.querySelector(".semantic-text")).toBeNull();
    expect(container.querySelector(".semantic-badge")).toBeNull();
  });

  it("気圧・風速の特殊 condition に valid scalar がある場合は従来の数値表示を維持する", () => {
    const { container } = render(TyphoonCard, { item: typhoonItem([typhoon({
      pressureHpa: 1002,
      pressureHpaSemantic: numericSemantic({
        raw: "1002", presence: "unknown", label: "解析不能", condition: "解析不能",
        value: null, badge: "?", color: "unknown", rank: { kind: "unranked" },
      }),
      maxWindMs: 0,
      maxWindMsSemantic: numericSemantic({
        raw: "0", presence: "qualitative", label: "なし", condition: "なし",
        value: null, badge: "?", color: "unknown", rank: { kind: "unranked" },
      }),
      maxGustMs: null,
      moveDirection: null,
      moveSpeedKmh: null,
    })]) });

    const labels = Array.from(container.querySelectorAll(".meta .stat-label")).map((el) => el.textContent);
    expect(labels).toEqual(["中心気圧", "最大風速"]);
    expect(container.querySelector('[data-value="1002"]')).toBeTruthy();
    expect(container.querySelector('[data-value="0"]')).toBeTruthy();
    expect(container.querySelector(".semantic-badge")).toBeNull();
  });

  it("長い移動速度 qualitative は nowrap token にせず card 幅で折り返せる", () => {
    const longLabel = "ほとんど停滞に近い非常に長い定性的な移動速度情報が継続している状態";
    const { container } = render(TyphoonCard, { item: typhoonItem([typhoon({
      pressureHpa: null,
      maxWindMs: null,
      maxGustMs: null,
      moveSpeedKmh: null,
      moveSpeedKmhSemantic: numericSemantic({
        raw: "", presence: "qualitative", label: longLabel, condition: "ほとんど停滞",
        description: longLabel, value: null, badge: "?", color: "unknown",
        rank: { kind: "unranked" },
      }),
    })]) });

    const speed = container.querySelector(".semantic-speed");
    expect(speed?.textContent).toBe(`${longLabel}?`);
    expect(speed?.classList.contains("stat-token")).toBe(false);
    const source = readFileSync(join(__dirname, "..", "TyphoonCard.svelte"), "utf8");
    expect(source).toMatch(/\.semantic-speed\s*\{[^}]*max-width:\s*100%;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s);
  });

  it("stat を原子トークンに分け、トークン内は nowrap・トークン間は折り返し可能にする", () => {
    const { container } = render(TyphoonCard, {
      item: typhoonItem([typhoon({
        moveDirection: "北北西",
        pressureDeltaHpa: -10,
        maxWindDeltaMs: 5,
        intensityTrend: "developing",
      })]),
    });
    const meta = container.querySelector(".meta");
    const stats = Array.from(meta?.children ?? []);
    expect(stats).toHaveLength(4);
    expect(stats.every((stat) =>
      stat.classList.contains("stat")
      && stat.querySelectorAll(":scope > .stat-label").length === 1
      && stat.querySelectorAll(":scope > .stat-value").length === 1
      && stat.querySelector("br") == null
    )).toBe(true);
    const tokens = Array.from(container.querySelectorAll(".stat-token"));
    expect(tokens).toHaveLength(5);
    expect(tokens[0].querySelector('[data-value="990"]')).toBeTruthy();
    expect(tokens[0].querySelector(".stat-unit")?.textContent).toBe("hPa");
    expect(tokens[1].querySelector('[data-value="25"]')).toBeTruthy();
    expect(tokens[1].querySelector(".stat-unit")?.textContent).toBe("m/s");
    expect(tokens[2].querySelector('[data-value="35"]')).toBeTruthy();
    expect(tokens[2].querySelector(".stat-unit")?.textContent).toBe("m/s");
    expect(tokens.slice(3).map((token) => token.textContent)).toEqual(["北北西", "20km/h"]);
    expect(meta?.querySelector(".stat-value .direction-token + .speed-token")).toBeTruthy();

    const changes = Array.from(container.querySelectorAll(".change-summary > .change-item"));
    expect(changes).toHaveLength(3);
    expect(changes.every((change) => change.querySelector("br") == null)).toBe(true);

    const source = readFileSync(join(__dirname, "..", "TyphoonCard.svelte"), "utf8");
    expect(source).toMatch(/\.meta\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*9rem\),\s*1fr\)\)/s);
    expect(source).toMatch(/\.stat-label\s*\{[^}]*display:\s*inline-block;[^}]*white-space:\s*nowrap;/s);
    expect(source).toMatch(/\.stat-value\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/s);
    expect(source).toMatch(/\.stat-token\s*\{[^}]*display:\s*inline-block;[^}]*white-space:\s*nowrap;/s);
    expect(source).toMatch(/\.change-item\s*\{\s*white-space:\s*nowrap;\s*\}/s);
  });

  it.each([undefined, null] as const)(
    "最大瞬間風速が %s なら最大瞬間列・空欄・NaN を出さない",
    (maxGustMs) => {
      const { container } = render(TyphoonCard, {
        item: typhoonItem([typhoon({ maxGustMs })]),
      });
      const labels = Array.from(container.querySelectorAll(".meta .stat-label")).map((el) => el.textContent);
      expect(labels).toEqual(["中心気圧", "最大風速", "進行"]);
      expect(container.textContent).not.toContain("最大瞬間");
      expect(container.textContent).not.toContain("NaN");
      expect(
        Array.from(container.querySelectorAll(".meta .stat-value"))
          .every((el) => (el.textContent ?? "").trim() !== ""),
      ).toBe(true);
    },
  );

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

  it("命名済み台風でも Remark を見出し下の補助行に残す", () => {
    const { container } = render(TyphoonCard, {
      item: typhoonItem([typhoon({ name: "ALPHA", remark: "台風消滅（温帯低気圧化）" })]),
    });
    expect(container.querySelector("strong")?.textContent).toContain("ALPHA");
    expect(container.querySelector(".remark")?.textContent).toBe("台風消滅（温帯低気圧化）");
  });

  it("marks a restored card as synchronizing", () => {
    const { container } = render(TyphoonCard, { item: { ...typhoonItem(), restored: true } });
    expect(container.querySelector(".restored-chip")?.textContent).toBe("同期中");
  });

  it("compact は各台風を二行以内にまとめ、詳細列と差分を省略して qualitative badge を保つ", () => {
    const qualitativeMove = numericSemantic({
      raw: "", presence: "qualitative", label: "ほとんど停滞", condition: "ほとんど停滞",
      value: null, badge: "?", color: "unknown", rank: { kind: "unranked" },
    });
    const { container } = render(TyphoonCard, {
      item: typhoonItem([
        typhoon({
          intensityClass: "非常に強い", sizeClass: "超大型", moveSpeedKmh: null,
          moveSpeedKmhSemantic: qualitativeMove, pressureDeltaHpa: -5, maxWindDeltaMs: 4,
        }),
        typhoon({ typhoonKey: "TC-2", typhoonNumber: "2606", nameKana: "BETA" }),
      ]),
      displayMode: "compact",
    });

    expect(container.querySelector(".typhoon-card")?.classList.contains("compact")).toBe(true);
    for (const card of container.querySelectorAll(".typhoon")) {
      expect(card.querySelectorAll(":scope > div").length).toBeLessThanOrEqual(2);
    }
    expect(container.querySelector(".compact-primary")?.textContent).toContain("超大型・非常に強い");
    expect(container.querySelector(".compact-primary .compact-location")?.textContent).toBe("ocean");
    expect(container.querySelector(".compact-summary")?.textContent).not.toContain("ocean");
    expect(container.querySelector('.compact-summary [data-value="990"]')).toBeTruthy();
    expect(container.querySelector('.compact-summary [data-value="25"]')).toBeTruthy();
    const windToken = container.querySelector('.compact-summary [data-value="25"]')?.closest(".compact-token");
    expect(windToken?.childNodes[0]?.textContent).toBe("最大風速 ");
    const firstCard = container.querySelector(".typhoon");
    expect(Array.from(firstCard?.querySelectorAll(".compact-numeric") ?? []).map((node) =>
      node.querySelector("[data-value]")?.getAttribute("data-value") ?? node.querySelector(".nu-value")?.textContent,
    ))
      .toEqual(["990", "25"]);
    expect(container.querySelector(".compact-movement")?.textContent).toBe("N ほとんど停滞?");
    expect(container.querySelector(".compact-movement .semantic-badge")?.textContent).toBe("?");
    expect(container.querySelector(".meta")).toBeNull();
    expect(container.querySelector(".change-summary")).toBeNull();
  });

  it("compact の中心気圧・最大風速・数値移動速度を同じ太字 token で表示する", () => {
    const { container } = render(TyphoonCard, {
      item: typhoonItem(),
      displayMode: "compact",
    });
    const windToken = container.querySelector('.compact-summary [data-value="25"]')?.closest(".compact-token");
    expect(windToken?.childNodes[0]?.textContent).toBe("最大風速 ");
    expect(Array.from(container.querySelectorAll(".compact-numeric")).map((node) =>
      node.querySelector("[data-value]")?.getAttribute("data-value") ?? node.querySelector(".nu-value")?.textContent,
    ))
      .toEqual(["990", "25", "20"]);
  });

  it("analysis-only / probability-only / combined を同じ additive card で描画する", () => {
    const analysis = render(TyphoonCard, { item: typhoonItem() });
    expect(analysis.container.querySelector(".probability")).toBeNull();
    analysis.unmount();

    const probabilityOnlyTyphoon = typhoon({
      name: "JANGMI", nameKana: "チャンミー", remark: "台風発生予想", category: null,
      location: null, pressureHpa: null, maxWindMs: null, maxGustMs: null,
      moveDirection: null, moveSpeedKmh: null, probability: probability(),
    });
    const probabilityOnly = render(TyphoonCard, {
      item: typhoonItem([probabilityOnlyTyphoon]),
    });
    expect(probabilityOnly.container.querySelector(".probability")).toBeTruthy();
    expect(probabilityOnly.container.querySelector(".meta")).toBeNull();
    expect(probabilityOnly.container.querySelector("header")?.classList.contains(
      "standby-card-header--muted",
    )).toBe(true);
    probabilityOnly.unmount();

    const combined = render(TyphoonCard, {
      item: typhoonItem([typhoon({ intensityClass: "非常に強い", probability: probability() })]),
    });
    expect(combined.container.querySelector(".meta")).toBeTruthy();
    expect(combined.container.querySelector(".probability")).toBeTruthy();
    expect(combined.container.querySelector("header")?.classList.contains("warning")).toBe(true);
  });

  it("§5.1-6,7: full 5件 / compact 3件の順序・隣接と omitted を維持する", () => {
    const item = typhoonItem([typhoon({ probability: probability() })]);
    for (const displayMode of ["full", "compact"] as const) {
      const view = render(TyphoonCard, { item, displayMode });
      const count = displayMode === "full" ? 5 : 3;
      const items = [...view.container.querySelectorAll(
        ".probability-prefecture-list li, .probability-prefectures > span:not(.probability-omitted)",
      )];
      expect(items).toHaveLength(count);
      expect(items.map((item) => item.firstElementChild?.textContent))
        .toEqual(["東京都", "神奈川県", "千葉県", "埼玉県", "茨城県"].slice(0, count));
      expect(items.map((item) => item.lastElementChild?.textContent))
        .toEqual(["80%", "70%", "60%", "50%", "40%"].slice(0, count));
      for (const item of items) {
        expect(item.children).toHaveLength(2);
        expect(item.firstElementChild?.nextElementSibling?.matches(".probability-number")).toBe(true);
      }
      expect(view.container.querySelector(".probability-omitted")?.textContent).toBe(`ほか${8 - count}府県等`);
      view.unmount();
    }
  });

  it("§5.1-1,2,3,5,7: full/compact は結論の label・area・NumberUnit と府県等見出しを直接隣接させる", () => {
    const item = typhoonItem([typhoon({ probability: probability() })]);
    for (const displayMode of ["full", "compact"] as const) {
      const view = render(TyphoonCard, { item, displayMode });
      const section = view.getByRole("region", { name: "暴風域に入る確率（5日以内）" });
      expect(view.container.querySelectorAll(".probability")).toHaveLength(1);
      expect(section.querySelectorAll(".probability-conclusion")).toHaveLength(1);
      const conclusion = section.querySelector(".probability-conclusion")!;
      const label = conclusion.querySelector(".probability-conclusion-label")!;
      const result = conclusion.querySelector(".probability-conclusion-result")!;
      expect([...conclusion.children]).toEqual([label, result]);
      expect(label.textContent).toBe("5日積算・全地域の最大");
      expect(label.nextElementSibling).toBe(result);
      const area = result.querySelector(".probability-conclusion-area")!;
      const number = result.querySelector(".probability-number")!;
      expect([...result.children]).toEqual([area, number]);
      expect(area.nextElementSibling).toBe(number);
      expect(area.textContent).toBe("東京地方（東京都）");
      expect(number.textContent).toBe("80%");
      const heading = view.getByRole("heading", { name: "府県等内の地域最大", level: 4 });
      expect(section.querySelectorAll("h4.probability-prefecture-heading")).toHaveLength(1);
      expect(conclusion.nextElementSibling).toBe(heading);
      expect(heading.nextElementSibling?.matches(displayMode === "full"
        ? ".probability-prefecture-list" : ".probability-prefectures")).toBe(true);
      const wrappers = [...section.querySelectorAll(".probability-number")];
      expect(wrappers).toHaveLength(displayMode === "full" ? 6 : 4);
      for (const wrapper of wrappers) {
        expect(wrapper.querySelectorAll(".nu-value")).toHaveLength(1);
        expect(wrapper.querySelectorAll(".nu-unit")).toHaveLength(1);
        const value = wrapper.querySelector(".nu-value");
        const unit = wrapper.querySelector(".nu-unit");
        expect(value?.nextElementSibling).toBe(unit);
        expect(unit?.textContent).toBe("%");
      }
      view.unmount();
    }
  });

  it("§5.2: probability は既存 spacing token・二列 grid・wrapping flex を維持する", () => {
    const source = readFileSync(join(__dirname, "..", "TyphoonCard.svelte"), "utf8");
    const css = source.slice(source.indexOf("  .probability {"), source.indexOf("  .compact .typhoon"));
    expect(css).toMatch(/\.probability-conclusion\s*\{[^}]*flex-direction:\s*column;[^}]*gap:\s*var\(--space-1\);/s);
    expect(css).toMatch(/\.probability-conclusion-result\s*\{[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*var\(--space-2\);/s);
    expect(css).toMatch(/\.probability-conclusion-area\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(css).toMatch(/\.probability-prefecture-list\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 8rem\), 1fr\)\);[^}]*gap:\s*var\(--space-1\) var\(--space-3\);/s);
    expect(css).toMatch(/\.probability-prefecture-list li,\s*\.probability-prefectures > span:not\(\.probability-omitted\)\s*\{[^}]*justify-content:\s*flex-start;[^}]*gap:\s*var\(--space-2\);/s);
    expect(css).toMatch(/\.probability-prefectures\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/s);
    expect(css).toMatch(/\.probability-prefecture-heading\s*\{[^}]*margin:\s*var\(--space-1\) 0 0;/s);
    expect(css).toMatch(/\.probability-number\s*\{[^}]*white-space:\s*nowrap;/s);
    expect(css).not.toMatch(/space-between|margin-left:\s*auto|(?:^|[;{\s])(?:width|height|max-height):|overflow(?:-[xy])?:\s*(?:hidden|clip|scroll|auto)/);
    expect(css).not.toMatch(/(?:gap|margin|padding)(?:-[a-z]+)?:[^;}]*(?:\dpx|(?<![\w-])-\d)/);
    const numberUnit = readFileSync(join(__dirname, "..", "NumberUnit.svelte"), "utf8");
    expect(numberUnit).toMatch(/\.nu-value\s*\{[^}]*font-weight:\s*var\(--num-weight\);/s);
  });

  it("§5.1-4 裁定4B: full/compact と null peak でも日時を DOM・可視 text・accessible name に描画しない", () => {
    // 旧 JST / 不明表示 test を置換。peak は5日積算の発生日時ではないためカードから外す。
    for (const displayMode of ["full", "compact"] as const) {
      for (const peakAt of ["2026-07-21T00:00:00.000Z", "2026-07-08T09:00:00+09:00", null]) {
        const view = render(TyphoonCard, {
          item: typhoonItem([typhoon({ probability: probability({
            worstArea: { ...probability().worstArea, peakAt },
          }) })]), displayMode,
        });
        const section = view.getByRole("region", { name: "暴風域に入る確率（5日以内）" });
        expect(section.querySelectorAll(".probability-maximum, .probability-worst, .probability-peak")).toHaveLength(0);
        for (const text of ["7月21日 09:00", "7月8日 09:00", "ピーク時刻不明"]) {
          expect(section.textContent).not.toContain(text);
          expect(section.outerHTML).not.toContain(text);
          expect(view.queryByRole("region", { name: new RegExp(text) })).toBeNull();
        }
        view.unmount();
      }
    }
  });

  it("§5.3-4: side/center shelf と live は同じ Typhoon branch と自然高測定を使う", () => {
    const source = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf8");
    expect(source.match(/<TyphoonCard\b/g)).toHaveLength(1);
    expect(source).toContain('{:else if key === "typhoon" && typhoonItem != null}<TyphoonCard item={typhoonItem} displayMode={variant === "full" ? "full" : "compact"} />');
    for (const placement of ["right", "center"]) {
      expect(source).toContain(`{@render renderCard(key, variant as CardVariant, "${placement}", true)}`);
      expect(source).toContain(`{@render renderCard(card.key, displayVariant(card), "${placement}", false, renderSelection)}`);
    }
    expect(source).toContain('if (live == null) return Math.round(node.getBoundingClientRect().height);');
    expect(source).toContain('Math.round(Math.max(live.getBoundingClientRect().height, live.scrollHeight))');
    expect(source).toContain('measurementOverride?.[id] ?? liveBorderBoxHeight(node)');
  });

  it.each([1, 50, 100])("§5.1-9: probability %i は probability-only / combined の header tone を変更しない", (value) => {
    for (const displayMode of ["full", "compact"] as const) {
      for (const combined of [false, true]) {
        const view = render(TyphoonCard, {
          item: typhoonItem([typhoon({
            category: combined ? "TS" : null,
            intensityClass: combined ? "非常に強い" : null,
            probability: probability({
              maxFiveDayProbability: value,
              topPrefectures: [{ prefectureCode: "13", prefectureName: "東京都", fiveDayProbability: value }],
              activePrefectureCount: 1,
              worstArea: { ...probability().worstArea, fiveDayProbability: value },
            }),
          })]), displayMode,
        });
        const header = view.container.querySelector("header");
        expect(header?.classList.contains("standby-card-header--muted")).toBe(!combined);
        expect(header?.classList.contains("advisory")).toBe(false);
        expect(header?.classList.contains("warning")).toBe(combined);
        expect(header?.classList.contains("emergency")).toBe(false);
        view.unmount();
      }
    }
  });

  it("ARIA、RestoredChip、UpdatedStamp を probability card でも維持する", () => {
    const { container } = render(TyphoonCard, {
      item: { ...typhoonItem([typhoon({ probability: probability() })]), restored: true },
    });
    expect(container.querySelector('section.probability[aria-label="暴風域に入る確率（5日以内）"]'))
      .toBeTruthy();
    expect(container.querySelector(".restored-chip")?.textContent).toBe("同期中");
    expect(container.querySelector(".updated-stamp")?.textContent).toContain("更新 7/21 09:00");
  });

  it("§5.1-8: 三値 invariant を満たす複数台風の wire order と結論値を維持する", () => {
    const { container } = render(TyphoonCard, {
      item: typhoonItem([
        typhoon({ typhoonKey: "TC-B", nameKana: "BETA", probability: probability() }),
        typhoon({
          typhoonKey: "TC-A", nameKana: "ALPHA",
          probability: probability({
            maxFiveDayProbability: 50,
            topPrefectures: probability().topPrefectures.map((prefecture) => ({ ...prefecture, fiveDayProbability: Math.min(50, prefecture.fiveDayProbability) })),
            worstArea: { ...probability().worstArea, fiveDayProbability: 50 },
          }),
        }),
      ]),
    });
    const cards = Array.from(container.querySelectorAll(".typhoon"));
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("BETA");
    expect(cards[0].querySelector(".probability-conclusion-result .probability-number")?.textContent).toContain("80%");
    expect(cards[1].textContent).toContain("ALPHA");
    expect(cards[1].querySelector(".probability-conclusion-result .probability-number")?.textContent).toContain("50%");
  });
});
