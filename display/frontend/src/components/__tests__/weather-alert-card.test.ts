import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import WeatherAlertCard from "../WeatherAlertCard.svelte";
import type { ActiveStandbyCardV1, DisplayWeatherAlertV1 } from "../../lib/protocol";

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

function restoredTornado(): Extract<ActiveStandbyCardV1, { kind: "tornado" }> {
  return {
    kind: "tornado", surface: "weather-rider", key: "tornado:active", sourceEventIds: ["t-1"],
    updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-21T01:00:00.000Z",
    restored: true, severity: "warning", data: { areas: ["東京都", "長崎県"], isSighted: false },
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
    // 見出しラベルの後ろに最終更新時刻 (UpdatedStamp) が並ぶため、ラベルは前方一致で見る
    expect(header?.textContent?.trim().startsWith("気象特別警報")).toBe(true);
    expect(header?.querySelector(".updated-stamp")?.textContent).toContain("更新");
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

  it("restored な竜巻 rider を『同期中』付きで描画する", () => {
    const { container } = render(WeatherAlertCard, { alerts: [], tornado: restoredTornado() });
    expect(container.querySelector(".tornado-rider")?.textContent).toContain("竜巻注意情報");
    expect(container.textContent).toContain("同期中");
  });

  it("右上予算と一致する WeatherAlertCard の高さ上限を持つ", () => {
    const src = readFileSync(join(__dirname, "..", "WeatherAlertCard.svelte"), "utf-8");
    expect(src).toMatch(/\.weather-card\s*\{[^}]*max-height:\s*min\(44vh,\s*280px\);/);
  });

  it("280px 枠からはみ出す末尾を黙って切らず、件数つき省略行へ置換する", async () => {
    const originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      if (this instanceof HTMLElement && this.hasAttribute("data-clip-summary")) {
        return { x: 16, y: 212, top: 212, right: 344, bottom: 240, left: 16, width: 328, height: 28, toJSON() {} } as DOMRect;
      }
      if (this instanceof HTMLUListElement) {
        return { x: 0, y: 40, top: 40, right: 360, bottom: 240, left: 0, width: 360, height: 200, toJSON() {} } as DOMRect;
      }
      const row = this instanceof HTMLElement ? this.dataset.weatherRow : undefined;
      if (row != null) {
        const top = 50 + Number(row) * 50;
        // row=3 は旧固定予約 24px の境界 (bottom=216) には入るが、実測省略行 top=212 には入らない。
        const bottom = row === "3" ? 214 : top + 30;
        return { x: 0, y: top, top, right: 360, bottom, left: 0, width: 360, height: bottom - top, toJSON() {} } as DOMRect;
      }
      return originalRect.call(this);
    };
    try {
      const alert = weatherAlert({
        items: ["大雨警報", "洪水警報", "暴風警報"].map((kind, index) => ({
          kind,
          displaySeverity: "warning",
          rank: "warning" as const,
          shownAreas: [`地域${index + 1}A`, `地域${index + 1}B`],
          omittedAreaCount: 0,
        })),
      });
      const { container } = render(WeatherAlertCard, { alerts: [alert] });
      await tick();
      await tick();
      expect(container.querySelector(".weather-card")?.classList.contains("clipped")).toBe(true);
      expect(container.querySelector(".clip-summary")?.textContent).toBe("ほか2項目/地域");
      expect(container.querySelectorAll("li.clip-hidden")).toHaveLength(2);
    } finally {
      Element.prototype.getBoundingClientRect = originalRect;
    }
  });

  it("同じ行構造の警報名・地域名差し替えでも再計測し、古い省略状態を残さない", async () => {
    const originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      if (this instanceof HTMLElement && this.hasAttribute("data-clip-summary")) {
        return { x: 16, y: 210, top: 210, right: 344, bottom: 240, left: 16, width: 328, height: 30, toJSON() {} } as DOMRect;
      }
      if (this instanceof HTMLUListElement) {
        return { x: 0, y: 40, top: 40, right: 360, bottom: 240, left: 0, width: 360, height: 200, toJSON() {} } as DOMRect;
      }
      const row = this instanceof HTMLElement ? this.dataset.weatherRow : undefined;
      if (row != null) {
        const longContent = (this.textContent?.length ?? 0) > 20;
        const top = 50 + Number(row) * 50;
        const bottom = longContent ? 270 : top + 30;
        return { x: 0, y: top, top, right: 360, bottom, left: 0, width: 360, height: bottom - top, toJSON() {} } as DOMRect;
      }
      return originalRect.call(this);
    };
    const short = weatherAlert({ items: [{
      kind: "大雨警報", displaySeverity: "warning", rank: "warning",
      shownAreas: ["宮崎市"], omittedAreaCount: 0,
    }] });
    const long = weatherAlert({ items: [{
      kind: "非常に長い名称の大雨警報が同じ項目位置へ差し替わるケース",
      displaySeverity: "warning", rank: "warning",
      shownAreas: ["非常に長い地域名称が同じ地域位置へ差し替わるケース"], omittedAreaCount: 0,
    }] });
    try {
      const { container, rerender } = render(WeatherAlertCard, { alerts: [short] });
      await tick();
      await tick();
      expect(container.querySelector(".clip-summary")?.classList.contains("clip-summary-hidden")).toBe(true);

      await rerender({ alerts: [long] });
      await tick();
      await tick();
      expect(container.querySelector(".clip-summary")?.textContent).toBe("ほか1項目/地域");
      expect(container.querySelector(".clip-summary")?.classList.contains("clip-summary-hidden")).toBe(false);

      await rerender({ alerts: [short] });
      await tick();
      await tick();
      expect(container.querySelector(".clip-summary")?.classList.contains("clip-summary-hidden")).toBe(true);
      expect(container.querySelector(".weather-card")?.classList.contains("clipped")).toBe(false);
    } finally {
      Element.prototype.getBoundingClientRect = originalRect;
    }
  });

  it("web font の確定後に行高を再計測して省略状態を更新する", async () => {
    const originalRect = Element.prototype.getBoundingClientRect;
    const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    let fontLoaded = false;
    let resolveFonts!: () => void;
    const ready = new Promise<void>((resolve) => { resolveFonts = resolve; });
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready, addEventListener, removeEventListener },
    });
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      if (this instanceof HTMLElement && this.hasAttribute("data-clip-summary")) {
        return { x: 16, y: 210, top: 210, right: 344, bottom: 240, left: 16, width: 328, height: 30, toJSON() {} } as DOMRect;
      }
      if (this instanceof HTMLUListElement) {
        return { x: 0, y: 40, top: 40, right: 360, bottom: 240, left: 0, width: 360, height: 200, toJSON() {} } as DOMRect;
      }
      const row = this instanceof HTMLElement ? this.dataset.weatherRow : undefined;
      if (row != null) {
        const top = 50 + Number(row) * 50;
        const bottom = fontLoaded && row === "1" ? 270 : top + 30;
        return { x: 0, y: top, top, right: 360, bottom, left: 0, width: 360, height: bottom - top, toJSON() {} } as DOMRect;
      }
      return originalRect.call(this);
    };
    try {
      const { container, unmount } = render(WeatherAlertCard, { alerts: [weatherAlert()] });
      await tick();
      await tick();
      expect(container.querySelector(".clip-summary")?.classList.contains("clip-summary-hidden")).toBe(true);
      expect(addEventListener).toHaveBeenCalledWith("loadingdone", expect.any(Function));

      fontLoaded = true;
      resolveFonts();
      await ready;
      await tick();
      await tick();
      expect(container.querySelector(".clip-summary")?.textContent).toBe("ほか1項目/地域");
      expect(container.querySelector(".clip-summary")?.classList.contains("clip-summary-hidden")).toBe(false);
      unmount();
      expect(removeEventListener).toHaveBeenCalledWith("loadingdone", expect.any(Function));
    } finally {
      Element.prototype.getBoundingClientRect = originalRect;
      if (originalFonts == null) delete (document as { fonts?: unknown }).fonts;
      else Object.defineProperty(document, "fonts", originalFonts);
    }
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
    const items = container.querySelectorAll("li:not(.clip-summary)");
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
    const classes = Array.from(container.querySelectorAll("li:not(.clip-summary)")).map((li) =>
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
