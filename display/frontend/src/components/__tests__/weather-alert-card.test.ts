import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import WeatherAlertCard from "../WeatherAlertCard.svelte";
import type { DisplayWeatherAlertV1 } from "../../lib/protocol";

function weatherAlert(over: Partial<DisplayWeatherAlertV1> = {}): DisplayWeatherAlertV1 {
  return {
    source: "vpww56",
    label: "気象警報",
    role: "weatherWarning",
    totalAreas: 1,
    items: [
      {
        kind: "L3 大雨警報",
        displaySeverity: "warning",
        rank: "warning",
        shownAreas: ["宮崎市"],
        omittedAreaCount: 0,
      },
    ],
    updatedAt: "2026-07-08T09:00:00+09:00",
    ...over,
  };
}

describe("WeatherAlertCard", () => {
  it("emergency alert なら紫ヘッダ・「気象特別警報」ラベルで render する", () => {
    const alert = weatherAlert({
      role: "weatherEmergency",
      label: "気象特別警報",
      items: [
        {
          kind: "L5 大雨特別警報",
          displaySeverity: "emergency",
          rank: "emergency",
          shownAreas: ["宮崎市"],
          omittedAreaCount: 0,
        },
      ],
    });
    const { container } = render(WeatherAlertCard, { alerts: [alert] });
    const header = container.querySelector(".card-header");
    expect(header?.textContent?.trim()).toBe("気象特別警報");
    expect(header?.getAttribute("style")).toContain("var(--header-weatherEmergency-container)");
  });

  it("県名を含む地域名は都道府県 → 市区町村の階層で render される", () => {
    const alert = weatherAlert({
      items: [
        {
          kind: "L4 土砂災害危険警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["宮崎県延岡市", "宮崎県日向市", "熊本県山鹿市"],
          omittedAreaCount: 0,
        },
      ],
    });
    const { container } = render(WeatherAlertCard, { alerts: [alert] });
    const groups = Array.from(container.querySelectorAll(".pref-group"));
    expect(groups.map((g) => g.querySelector(".pref-name")?.textContent)).toEqual([
      "宮崎県",
      "熊本県",
    ]);
    // 第3波 Fix14: 市区町村名は個別 span (white-space:nowrap) で render し、区切りは
    // 文字ではなく gap で表現する (名前の途中で改行しない)
    expect(
      Array.from(groups[0]?.querySelectorAll(".city-name") ?? []).map((el) => el.textContent),
    ).toEqual(["延岡市", "日向市"]);
    expect(
      Array.from(groups[1]?.querySelectorAll(".city-name") ?? []).map((el) => el.textContent),
    ).toEqual(["山鹿市"]);
  });

  it("地域名が都道府県名そのもの (「茨城県」) のとき、都道府県見出しに1回だけ出て市区町村欄には出ない", () => {
    const alert = weatherAlert({
      items: [
        {
          kind: "暴風警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["茨城県"],
          omittedAreaCount: 0,
        },
      ],
    });
    const { container } = render(WeatherAlertCard, { alerts: [alert] });
    const group = container.querySelector(".pref-group");
    expect(group?.querySelector(".pref-name")?.textContent).toBe("茨城県");
    // 残りが空なので市区町村 span は描画されない (二重表示しない)
    expect(group?.querySelector(".cities")).toBeFalsy();
    // カード全体で「茨城県」は都道府県見出しの1回だけ
    const occurrences = (container.textContent?.match(/茨城県/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("都道府県名＋括弧付き残り (「鹿児島県（奄美地方除く）」) は見出しと市区町村欄に分かれる", () => {
    const alert = weatherAlert({
      items: [
        {
          kind: "L3 大雨警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["鹿児島県（奄美地方除く）"],
          omittedAreaCount: 0,
        },
      ],
    });
    const { container } = render(WeatherAlertCard, { alerts: [alert] });
    const group = container.querySelector(".pref-group");
    expect(group?.querySelector(".pref-name")?.textContent).toBe("鹿児島県");
    expect(group?.querySelector(".cities")?.textContent).toBe("（奄美地方除く）");
  });

  it("「京都府」は「京都」+「府」に割れず、都道府県見出しに1回だけ出て市区町村欄には出ない", () => {
    const alert = weatherAlert({
      items: [
        {
          kind: "L3 大雨警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["京都府"],
          omittedAreaCount: 0,
        },
      ],
    });
    const { container } = render(WeatherAlertCard, { alerts: [alert] });
    const group = container.querySelector(".pref-group");
    expect(group?.querySelector(".pref-name")?.textContent).toBe("京都府");
    // 残りが空なので市区町村 span は描画されない (「府」だけが残らない)
    expect(group?.querySelector(".cities")).toBeFalsy();
  });

  it("「京都府京都市」は都道府県見出し「京都府」＋市区町村「京都市」に分かれる", () => {
    const alert = weatherAlert({
      items: [
        {
          kind: "L3 大雨警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["京都府京都市"],
          omittedAreaCount: 0,
        },
      ],
    });
    const { container } = render(WeatherAlertCard, { alerts: [alert] });
    const group = container.querySelector(".pref-group");
    expect(group?.querySelector(".pref-name")?.textContent).toBe("京都府");
    expect(group?.querySelector(".cities")?.textContent).toBe("京都市");
  });

  it("県名にマッチしない離島部・地方名 (例: 沖縄本島地方) は県名見出しと同格の独立見出しとして render する (backlog §1)", () => {
    const alert = weatherAlert({
      items: [
        {
          kind: "洪水警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["沖縄本島地方", "宗谷地方"],
          omittedAreaCount: 0,
        },
      ],
    });
    const { container } = render(WeatherAlertCard, { alerts: [alert] });
    const groups = Array.from(container.querySelectorAll(".pref-group"));
    // 県名グループと同じ .pref-name span で、地域ごとに別見出しとして並ぶ (「その他」1バケツに集約しない)
    expect(groups.map((g) => g.querySelector(".pref-name")?.textContent)).toEqual([
      "沖縄本島地方",
      "宗谷地方",
    ]);
    // 地域名自体が見出しなので、市区町村欄は出さない (二重表示しない)
    for (const g of groups) {
      expect(g.querySelector(".cities")).toBeFalsy();
    }
  });

  it("県名グループと県名にマッチしない地域が混在するとき、出現順を保ったまま並ぶ (backlog §1)", () => {
    const alert = weatherAlert({
      items: [
        {
          kind: "L3 大雨警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["熊本県山鹿市", "沖縄本島地方", "宮崎県延岡市"],
          omittedAreaCount: 0,
        },
      ],
    });
    const { container } = render(WeatherAlertCard, { alerts: [alert] });
    const groups = Array.from(container.querySelectorAll(".pref-group"));
    expect(groups.map((g) => g.querySelector(".pref-name")?.textContent)).toEqual([
      "熊本県",
      "沖縄本島地方",
      "宮崎県",
    ]);
  });

  it("omittedAreaCount がある item は「ほかN地域」を末尾に付けて render する (縮退 snapshot 用)", () => {
    const alert = weatherAlert({
      items: [
        {
          kind: "洪水警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["宮崎市", "都城市"],
          omittedAreaCount: 3,
        },
      ],
    });
    const { container } = render(WeatherAlertCard, { alerts: [alert] });
    expect(container.querySelector(".omitted")?.textContent).toBe("ほか3地域");
  });

  it("alerts が空なら .weather-card を render しない", () => {
    const { container } = render(WeatherAlertCard, { alerts: [] });
    expect(container.querySelector(".weather-card")).toBeFalsy();
  });

  it("複数バケツ (emergency + warning) を渡したとき、最高ランク (emergency) の item だけが描画され、下位 (warning) は省略される", () => {
    const emergencyAlert = weatherAlert({
      role: "weatherEmergency",
      label: "気象特別警報",
      items: [
        {
          kind: "L5 大雨特別警報",
          displaySeverity: "emergency",
          rank: "emergency",
          shownAreas: ["宮崎市"],
          omittedAreaCount: 0,
        },
      ],
    });
    const warningAlert = weatherAlert({
      role: "weatherWarning",
      label: "気象警報",
      items: [
        {
          kind: "洪水警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["都城市"],
          omittedAreaCount: 0,
        },
      ],
    });
    // 配列順を warning → emergency と逆にしても、描画順は rank によるフィルタで固定される
    const { container } = render(WeatherAlertCard, { alerts: [warningAlert, emergencyAlert] });
    const kinds = Array.from(container.querySelectorAll(".kind")).map((el) => el.textContent);
    expect(kinds).toEqual(["L5 大雨特別警報"]);
  });

  it("vpws50 / vpww56 の両バケツが同じ kind・rank の item を同時に持つとき、1グループに統合して重複表示しない (実機バグ Fix10)", () => {
    const vpws50Alert = weatherAlert({
      source: "vpws50",
      role: "weatherWarning",
      items: [
        {
          kind: "L3 大雨警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["宮崎市"],
          omittedAreaCount: 0,
        },
      ],
    });
    const vpww56Alert = weatherAlert({
      source: "vpww56",
      role: "weatherWarning",
      items: [
        {
          kind: "L3 大雨警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["都城市"],
          omittedAreaCount: 0,
        },
      ],
    });
    expect(() => render(WeatherAlertCard, { alerts: [vpws50Alert, vpww56Alert] })).not.toThrow();
    const { container } = render(WeatherAlertCard, { alerts: [vpws50Alert, vpww56Alert] });
    // source をまたいでも同一 kind は 1 つの <li> に統合される (跨 source 重複表示の解消)
    const kinds = Array.from(container.querySelectorAll(".kind")).map((el) => el.textContent);
    expect(kinds).toEqual(["L3 大雨警報"]);
    // areas は出現順を保ったまま union される
    const prefNames = Array.from(container.querySelectorAll(".pref-name")).map((el) => el.textContent);
    expect(prefNames).toEqual(["宮崎市", "都城市"]);
  });

  it("実機再現: vpws50 と vpww56 が同じ kind「L4 土砂災害危険警報」を持ち areas が一部重複するとき、union して1グループにまとめ omittedAreaCount を合算する (Fix10)", () => {
    const vpws50Alert = weatherAlert({
      source: "vpws50",
      role: "weatherWarning",
      items: [
        {
          kind: "L4 土砂災害危険警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["栃木県", "群馬県"],
          omittedAreaCount: 1,
        },
      ],
    });
    const vpww56Alert = weatherAlert({
      source: "vpww56",
      role: "weatherWarning",
      items: [
        {
          kind: "L4 土砂災害危険警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["栃木県"],
          omittedAreaCount: 2,
        },
      ],
    });
    const { container } = render(WeatherAlertCard, { alerts: [vpws50Alert, vpww56Alert] });
    const items = container.querySelectorAll("li");
    expect(items.length).toBe(1);
    const prefNames = Array.from(container.querySelectorAll(".pref-name")).map((el) => el.textContent);
    expect(prefNames).toEqual(["栃木県", "群馬県"]);
    expect(container.querySelector(".omitted")?.textContent).toBe("ほか3地域");
  });

  it("市区町村名は white-space:nowrap の city-name span で、名前の途中で改行しない (第3波 Fix14)", () => {
    const src = readFileSync(join(__dirname, "..", "WeatherAlertCard.svelte"), "utf-8");
    expect(src).toMatch(/\.city-name\s*\{[\s\S]*?white-space:\s*nowrap;[\s\S]*?\}/);
    expect(src).not.toContain("g.cities.join(");
  });

  it("item 行に rank 別の色クラス (rank-emergency / rank-warning / rank-advisory) が対応して付く (最高ランクのみ残る)", () => {
    const alert = weatherAlert({
      role: "weatherEmergency",
      items: [
        {
          kind: "L5 大雨特別警報",
          displaySeverity: "emergency",
          rank: "emergency",
          shownAreas: ["宮崎市"],
          omittedAreaCount: 0,
        },
        {
          kind: "洪水警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["都城市"],
          omittedAreaCount: 0,
        },
        {
          kind: "強風注意報",
          displaySeverity: "advisory",
          rank: "advisory",
          shownAreas: ["日南市"],
          omittedAreaCount: 0,
        },
      ],
    });
    const { container } = render(WeatherAlertCard, { alerts: [alert] });
    const classes = Array.from(container.querySelectorAll("li")).map((li) =>
      li.className.split(" ").filter((c) => c.startsWith("rank-")),
    );
    // 最高ランク (emergency) の item だけが残り、warning/advisory は省略される
    expect(classes).toEqual([["rank-emergency"]]);
  });

  it("単一バケツ (warning のみ) では従来どおり全 item が描画される", () => {
    const alert = weatherAlert({
      role: "weatherWarning",
      items: [
        {
          kind: "洪水警報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["都城市"],
          omittedAreaCount: 0,
        },
        {
          kind: "強風注意報",
          displaySeverity: "warning",
          rank: "warning",
          shownAreas: ["日南市"],
          omittedAreaCount: 0,
        },
      ],
    });
    const { container } = render(WeatherAlertCard, { alerts: [alert] });
    const kinds = Array.from(container.querySelectorAll(".kind")).map((el) => el.textContent);
    expect(kinds).toEqual(["洪水警報", "強風注意報"]);
  });

  it("card-header は container/on/band トークンで #000 直値 fg を持たない", () => {
    const src = readFileSync(join(__dirname, "..", "WeatherAlertCard.svelte"), "utf-8");
    expect(src).toMatch(/var\(--header-weather\w+-container\)/);
    expect(src).toContain("var(--header-band-width)");
    // .card-header の CSS ブロックに color:#000 が残っていない
    expect(src).not.toMatch(/\.card-header\s*\{[^}]*color:\s*#000/);
  });
});
