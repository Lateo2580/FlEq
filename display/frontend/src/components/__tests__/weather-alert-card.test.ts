import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import WeatherAlertCard from "../WeatherAlertCard.svelte";
import type { ActiveStandbyCardV1, DisplayWeatherAlertV1 } from "../../lib/protocol";
import { createCardPageCoordinator } from "../../lib/legacy-standby/time-slice-scheduler.svelte";
import { collectWeatherExpandedKinds } from "../../lib/weather-expanded-kinds";

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
  it("県名プレフィックスなしの市町村を areaCode から都道府県グループへ入れる", () => {
    const alert = weatherAlert({
      items: [{
        kind: "L3 大雨警報",
        displaySeverity: "warning",
        rank: "warning",
        shownAreas: ["宮崎市", "都城市"],
        shownAreaCodes: ["4520100", "4520200"],
        omittedAreaCount: 0,
      }],
    });

    const { container } = render(WeatherAlertCard, { alerts: [alert] });
    const group = container.querySelector(".pref-group");
    expect(group?.querySelector(".pref-name")?.textContent).toBe("宮崎県");
    expect(Array.from(group?.querySelectorAll(".city-name") ?? []).map((el) => el.textContent))
      .toEqual(["宮崎市", "都城市"]);
  });

  it("shownAreaCodes がない旧 wire は県名完全前方一致で従来どおりグループ化する", () => {
    const alert = weatherAlert({
      items: [{
        kind: "L3 大雨警報",
        displaySeverity: "warning",
        rank: "warning",
        shownAreas: ["宮崎県延岡市", "宮崎県日向市"],
        omittedAreaCount: 0,
      }],
    });

    const { container } = render(WeatherAlertCard, { alerts: [alert] });
    const group = container.querySelector(".pref-group");
    expect(group?.querySelector(".pref-name")?.textContent).toBe("宮崎県");
    expect(Array.from(group?.querySelectorAll(".city-name") ?? []).map((el) => el.textContent))
      .toEqual(["延岡市", "日向市"]);
  });

  it("同名でも異なる Area.Code の市町村は source 横断で両方を表示する", () => {
    const tokyo = weatherAlert({
      source: "vpws50",
      items: [{
        kind: "L3 大雨警報", displaySeverity: "warning", rank: "warning",
        shownAreas: ["府中市"], shownAreaCodes: ["1320600"], omittedAreaCount: 0,
      }],
    });
    const hiroshima = weatherAlert({
      source: "vpww56",
      items: [{
        kind: "L3 大雨警報", displaySeverity: "warning", rank: "warning",
        shownAreas: ["府中市"], shownAreaCodes: ["3420600"], omittedAreaCount: 0,
      }],
    });

    const { container } = render(WeatherAlertCard, { alerts: [tokyo, hiroshima] });
    expect(Array.from(container.querySelectorAll(".pref-name")).map((el) => el.textContent))
      .toEqual(["東京都", "広島県"]);
    expect(Array.from(container.querySelectorAll(".city-name")).map((el) => el.textContent))
      .toEqual(["府中市", "府中市"]);
  });

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

  it("wire の candidateTruncated が残置数0でもページ表示を残す", async () => {
    const pageCoordinator = createCardPageCoordinator();
    const source = weatherAlert({
      items: [{
        kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "warning", rank: "warning",
        shownAreas: Array.from({ length: 129 }, (_, index) => `地域${index + 1}`), omittedAreaCount: 0,
      }],
    });
    const [wire] = collectWeatherExpandedKinds([source]);
    expect(wire?.candidateTruncated).toBe(true);
    const alert = weatherAlert({
      items: [{
        ...source.items[0]!, shownAreas: ["宮崎市"], omittedAreaCount: 0,
        candidateTruncated: wire?.candidateTruncated,
      } as DisplayWeatherAlertV1["items"][number] & { candidateTruncated: boolean }],
    });
    const view = render(WeatherAlertCard, { alerts: [alert], pageCoordinator, pageScheduling: true });
    await tick();
    expect(view.container.querySelector<HTMLElement>(".weather-card")?.dataset.cardPage).toBe("1/1");
    expect(view.container.querySelector("[data-card-page-indicator]")?.textContent).toBe("1/1");
    view.unmount();
    pageCoordinator.dispose();
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

  it("単一ページの竜巻注意/目撃情報は対象地域を「ほか」省略せず表示する", () => {
    const { container } = render(WeatherAlertCard, {
      alerts: [],
      tornado: { ...restoredTornado(), data: { areas: ["東京都", "長崎県", "宮崎県"], isSighted: true } },
    });
    const rider = container.querySelector(".tornado-rider");
    expect(rider?.textContent).toContain("竜巻目撃情報（東京都、長崎県、宮崎県）");
    expect(rider?.textContent).not.toContain("ほか");
  });

  it("forced tornado range は rider に現在ページだけを描画し、全件へ戻さない", () => {
    const { container } = render(WeatherAlertCard, {
      alerts: [],
      tornado: { ...restoredTornado(), data: { areas: ["同名地域", "同名地域", "後続地域"], isSighted: false } },
      measurementTornadoRange: { start: 1, end: 2, tails: [], omittedAreaCount: 0 },
      tornadoPageIndex: 2,
      tornadoPageCount: 3,
    });
    const rider = container.querySelector<HTMLElement>(".tornado-rider");
    expect(rider?.textContent).toContain("同名地域");
    expect(rider?.textContent).not.toContain("後続地域");
    expect(rider?.querySelector("[data-tornado-page-marker]")?.textContent).toBe("対象地域 2/3");
    expect(container.querySelector<HTMLElement>(".weather-card")?.dataset.tornadoPageRange).toBe("1:2");
  });

  it("tornado 単独 forced shelf は card root と rider の両方を probe 対象にする", () => {
    const { container } = render(WeatherAlertCard, {
      alerts: [], tornado: restoredTornado(),
      measurementTornadoRange: { start: 0, end: 1, tails: [], omittedAreaCount: 0 },
    });
    const card = container.querySelector<HTMLElement>(".weather-card");
    expect(card?.hasAttribute("data-page-probe-card")).toBe(true);
    expect(card?.querySelectorAll("[data-page-probe-readable]")).toHaveLength(1);
  });

  it("pending tornado without a supplied range keeps a one-area provisional rider", () => {
    const { container } = render(WeatherAlertCard, {
      alerts: [],
      tornado: { ...restoredTornado(), data: { areas: ["先頭地域", "後続地域", "さらに後続"], isSighted: false } },
      tornadoPending: true,
    });
    const rider = container.querySelector<HTMLElement>(".tornado-rider");
    expect(rider?.textContent).toContain("先頭地域");
    expect(rider?.textContent).not.toContain("後続地域");
    expect(container.querySelector<HTMLElement>(".weather-card")?.dataset.tornadoPageRange).toBe("0:1");
  });

  it.each([1, 2, 5, 12])("tornado safety envelope %i regions keeps the forced readable range", (count) => {
    const areas = Array.from({ length: count }, (_, index) => index === 1 ? "同名の長い地域名同名の長い地域名" : `地域${index + 1}`);
    const { container } = render(WeatherAlertCard, {
      alerts: [],
      tornado: { ...restoredTornado(), data: { areas, isSighted: true } },
      measurementTornadoRange: { start: 0, end: Math.min(1, count), tails: [], omittedAreaCount: 0 },
      tornadoPageCount: count > 1 ? count : 1,
    });
    const rider = container.querySelector<HTMLElement>(".tornado-rider");
    expect(rider?.classList.contains("sighted")).toBe(true);
    expect(rider?.textContent).toContain("竜巻目撃情報");
    expect(rider?.textContent).toContain("地域1");
    if (count > 1) expect(rider?.textContent).not.toContain("同名の長い地域名");
  });

  it("empty tornado rider keeps an empty forced range without fallback", () => {
    const { container } = render(WeatherAlertCard, {
      alerts: [], tornado: { ...restoredTornado(), data: { areas: [], isSighted: false } },
      measurementTornadoRange: { start: 0, end: 0, tails: [], omittedAreaCount: 0 },
    });
    expect(container.querySelector<HTMLElement>(".weather-card")?.dataset.tornadoPageRange).toBe("0:0");
    expect(container.querySelector(".tornado-rider")?.textContent).toContain("対象地域");
  });

  it("weather と tornado の safety envelope は各 readable viewport を別々に持つ", () => {
    const { container } = render(WeatherAlertCard, {
      alerts: [weatherAlert({ items: [{
        kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: ["宮崎市", "都城市"], omittedAreaCount: 0,
      }] })],
      tornado: { ...restoredTornado(), data: { areas: ["宮崎県", "鹿児島県"], isSighted: false } },
      measurementRange: { start: 0, end: 1, tails: [], omittedAreaCount: 0 },
      measurementTornadoRange: { start: 0, end: 1, tails: [], omittedAreaCount: 0 },
      tornadoPageCount: 2,
    });
    const readable = container.querySelectorAll("[data-page-probe-readable]");
    expect(readable).toHaveLength(2);
    expect(readable[0]?.textContent).toContain("宮崎市");
    expect(readable[1]?.textContent).toContain("宮崎県");
    expect(readable[1]?.textContent).not.toContain("鹿児島県");
  });

  it("tornado marker は複数ページだけ rider 行末に inline で表示する", () => {
    const multi = render(WeatherAlertCard, {
      alerts: [], tornado: restoredTornado(),
      measurementTornadoRange: { start: 0, end: 1, tails: [], omittedAreaCount: 0 }, tornadoPageCount: 2,
    });
    expect(multi.container.querySelector("[data-tornado-page-marker]")?.textContent).toBe("対象地域 1/2");
    multi.unmount();
    const single = render(WeatherAlertCard, { alerts: [], tornado: restoredTornado() });
    expect(single.container.querySelector("[data-tornado-page-marker]")).toBeNull();
    const source = readFileSync(join(__dirname, "..", "WeatherAlertCard.svelte"), "utf-8");
    expect(source).toMatch(/\.tornado-page-marker\s*\{[^}]*display:\s*inline;[^}]*white-space:\s*nowrap;/s);
  });

  it("paging, pending, and confirmation keep the fixed outer-height contract", async () => {
    const view = render(WeatherAlertCard, {
      alerts: [], tornado: restoredTornado(),
      measurementTornadoRange: { start: 0, end: 1, tails: [], omittedAreaCount: 0 }, tornadoPageCount: 2, tornadoPending: true,
    });
    const card = view.container.querySelector<HTMLElement>(".weather-card");
    expect(card?.classList.contains("paging-contract")).toBe(true);
    await view.rerender({
      alerts: [], tornado: restoredTornado(),
      measurementTornadoRange: { start: 0, end: 1, tails: [], omittedAreaCount: 0 }, tornadoPageCount: 2, tornadoPending: false,
    });
    expect(card?.classList.contains("paging-contract")).toBe(true);
    const source = readFileSync(join(__dirname, "..", "WeatherAlertCard.svelte"), "utf-8");
    expect(source).toMatch(/\.weather-card\.paging-contract\s*\{[^}]*height:\s*min\(44vh,\s*280px\);/s);
    view.unmount();
  });

  it("pending 前の rider scheduling でも shared contract を先行適用できる", () => {
    const view = render(WeatherAlertCard, {
      alerts: [], tornado: restoredTornado(), forceTornadoPagingContract: true,
    });
    expect(view.container.querySelector<HTMLElement>(".weather-card")?.classList.contains("paging-contract")).toBe(true);
    view.unmount();
  });

  it("weather 単独の pending/infeasible と単一 truncate は自然高のままにする", async () => {
    const alerts = [weatherAlert({ items: [{
      kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: ["宮崎市"], omittedAreaCount: 3,
    }] })];
    const view = render(WeatherAlertCard, {
      alerts, pageScheduling: true, partitionProbe: () => null,
    });
    const card = view.container.querySelector<HTMLElement>(".weather-card");
    expect(card?.dataset.cardPagePending).toBe("true");
    expect(card?.classList.contains("paging-contract")).toBe(false);
    await view.rerender({ alerts, pageScheduling: true, partitionProbe: () => 0 });
    expect(card?.dataset.cardPagePending).toBe("false");
    expect(card?.classList.contains("paging-contract")).toBe(false);
    view.unmount();

    const single = render(WeatherAlertCard, { alerts });
    expect(single.container.querySelector<HTMLElement>(".weather-card")?.classList.contains("paging-contract")).toBe(false);
    single.unmount();

    const infeasible = render(WeatherAlertCard, {
      alerts, pageScheduling: true, partitionProbe: () => 2,
    });
    expect(infeasible.container.querySelector<HTMLElement>(".weather-card")?.dataset.cardPageInfeasible).toBe("true");
    expect(infeasible.container.querySelector<HTMLElement>(".weather-card")?.classList.contains("paging-contract")).toBe(false);
    infeasible.unmount();
  });

  it("infeasible rider は aggregate と final clip を区別し、provisional range を保つ", async () => {
    const view = render(WeatherAlertCard, {
      alerts: [], tornado: restoredTornado(),
      measurementTornadoRange: { start: 0, end: 1, tails: [], omittedAreaCount: 0 }, tornadoPending: true,
    });
    const card = view.container.querySelector<HTMLElement>(".weather-card");
    expect(card?.dataset.tornadoPagePending).toBe("true");
    expect(card?.querySelector(".tornado-rider")?.textContent).toContain("東京都");
    await view.rerender({
      alerts: [], tornado: restoredTornado(), tornadoAggregatePending: true,
    });
    expect(card?.dataset.tornadoPageFallback).toBe("aggregate-pending");
    expect(card?.classList.contains("paging-contract")).toBe(true);
    await view.rerender({
      alerts: [], tornado: restoredTornado(), tornadoInfeasible: "aggregate",
    });
    expect(card?.dataset.tornadoPageInfeasible).toBe("aggregate");
    expect(card?.dataset.tornadoPageFallback).toBe("aggregate");
    expect(card?.textContent).toContain("対象 2 地域");
    await view.rerender({
      alerts: [], tornado: restoredTornado(), tornadoInfeasible: "clip",
    });
    expect(card?.dataset.tornadoPageInfeasible).toBe("clip");
    expect(card?.textContent).toContain("地域…");
    view.unmount();
  });

  it("tornado の1地域 fail は aggregate probe を経て aggregate / clip を決める", () => {
    const calls: string[] = [];
    const aggregate = render(WeatherAlertCard, {
      alerts: [], tornado: restoredTornado(), pageScheduling: true,
      tornadoPartitionProbe: (tornadoRange) => {
        calls.push(`${tornadoRange.start}:${tornadoRange.end}:${tornadoRange.omittedAreaCount}`);
        return tornadoRange.end - tornadoRange.start === 1 ? 2 : 0;
      },
    });
    expect(aggregate.container.querySelector<HTMLElement>(".weather-card")?.dataset.tornadoPageInfeasible).toBe("aggregate");
    expect(calls).toContain("0:0:2");
    aggregate.unmount();

    const clip = render(WeatherAlertCard, {
      alerts: [], tornado: restoredTornado(), pageScheduling: true,
      tornadoPartitionProbe: () => 2,
    });
    expect(clip.container.querySelector<HTMLElement>(".weather-card")?.dataset.tornadoPageInfeasible).toBe("clip");
    clip.unmount();
  });

  it("tornado range は weather の全 live page 組合せが測定されるまで登録しない", () => {
    const combinations: string[] = [];
    const { container } = render(WeatherAlertCard, {
      alerts: [weatherAlert({ items: [{
        kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: ["宮崎市", "都城市"], omittedAreaCount: 0,
      }] })],
      tornado: { ...restoredTornado(), data: { areas: ["宮崎県", "鹿児島県"], isSighted: false } },
      pageScheduling: true,
      partitionProbe: (_key, _placement, range) => range.end - range.start > 1 ? 2 : 0,
      tornadoPartitionProbe: (tornadoRange, weatherRange) => {
        combinations.push(`${weatherRange.start}:${weatherRange.end}/${tornadoRange.start}:${tornadoRange.end}`);
        return tornadoRange.end - tornadoRange.start > 1 ? 2 : 0;
      },
    });
    expect(combinations).toContain("0:1/0:1");
    expect(combinations).toContain("1:2/0:1");
    expect(container.querySelector<HTMLElement>(".weather-card")?.dataset.tornadoPage).toBe("1/2");
  });

  it("weather 内容更新は新しい組合せ probe を要求してから tornado を再 publish する", async () => {
    const probes: string[] = [];
    const coordinator = createCardPageCoordinator({ tickOverride: 0 });
    const makeAlerts = (area: string) => [weatherAlert({ items: [{
      kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: [area], omittedAreaCount: 1,
    }] })];
    const view = render(WeatherAlertCard, {
      alerts: makeAlerts("更新前"), tornado: restoredTornado(), pageCoordinator: coordinator, pageScheduling: true,
      tornadoPartitionProbe: (tornadoRange, weatherRange) => { probes.push(`${weatherRange.start}:${weatherRange.end}/${tornadoRange.start}:${tornadoRange.end}`); return 0; },
    });
    await tick();
    const before = probes.length;
    await view.rerender({ alerts: makeAlerts("更新後"), tornado: restoredTornado(), pageCoordinator: coordinator, pageScheduling: true,
      tornadoPartitionProbe: (tornadoRange, weatherRange) => { probes.push(`${weatherRange.start}:${weatherRange.end}/${tornadoRange.start}:${tornadoRange.end}`); return 0; },
    });
    await tick();
    expect(probes.length).toBeGreaterThan(before);
    view.unmount(); coordinator.dispose();
  });

  it("confirmed tornado pages register once per settled input without oscillation", async () => {
    const coordinator = createCardPageCoordinator({ tickOverride: 0 });
    const register = vi.spyOn(coordinator, "register");
    const view = render(WeatherAlertCard, {
      alerts: [], tornado: restoredTornado(), pageCoordinator: coordinator, pageScheduling: true,
      tornadoPartitionProbe: () => 0,
    });
    await tick(); await tick();
    const tornadoCalls = register.mock.calls.filter(([entry]) => entry.key === "tornado");
    expect(tornadoCalls).toHaveLength(1);
    view.unmount(); coordinator.dispose();
  });

  it("weather infeasible は同一 full-body shell の probe 確定後に tornado を公開する", () => {
    const { container } = render(WeatherAlertCard, {
      alerts: [weatherAlert()], tornado: { ...restoredTornado(), data: { areas: ["先頭", "未証明"], isSighted: false } },
      pageScheduling: true, partitionProbe: () => 2, tornadoPartitionProbe: () => 0,
    });
    const card = container.querySelector<HTMLElement>(".weather-card");
    expect(card?.dataset.cardPageInfeasible).toBe("true");
    expect(card?.dataset.tornadoPageRange).toBe("0:2");
    expect(card?.querySelector(".tornado-rider")?.textContent).toContain("未証明");
  });

  it("aggregate final publish replaces an old multi-page tornado registration", async () => {
    const coordinator = createCardPageCoordinator({ tickOverride: 0 });
    const register = vi.spyOn(coordinator, "register");
    const view = render(WeatherAlertCard, { alerts: [], tornado: restoredTornado(), pageCoordinator: coordinator, pageScheduling: true, tornadoPartitionProbe: (range) => range.end - range.start > 1 ? 2 : 0 });
    await tick();
    await view.rerender({ alerts: [], tornado: restoredTornado(), pageCoordinator: coordinator, pageScheduling: true, tornadoPartitionProbe: () => 2 });
    await tick(); await tick();
    const calls = register.mock.calls.filter(([entry]) => entry.key === "tornado");
    expect(calls[0]?.[0].identities.length).toBeGreaterThan(1);
    expect(calls.at(-1)?.[0].identities).toHaveLength(1);
    view.unmount(); coordinator.dispose();
  });

  it("右上予算と一致する WeatherAlertCard の高さ上限を持つ", () => {
    const src = readFileSync(join(__dirname, "..", "WeatherAlertCard.svelte"), "utf-8");
    expect(src).toMatch(/\.weather-card\s*\{[^}]*max-height:\s*min\(44vh,\s*280px\);/);
  });

  it("対象地域は2列に組版し、pref-groupを列境界で分断せず旧clip機構を持たない", () => {
    const src = readFileSync(join(__dirname, "..", "WeatherAlertCard.svelte"), "utf-8");
    expect(src).toMatch(/ul\s*\{[^}]*column-count:\s*2;[^}]*column-gap:/s);
    expect(src).toMatch(/\.pref-group\s*\{[^}]*break-inside:\s*avoid;/s);
    expect(src).not.toContain("clipWeatherRows");
    expect(src).not.toContain("clip-summary");
    expect(src).not.toContain("clip-hidden");
  });

  it("測定棚ではページ番号を本文とriderの間の補償済み隙間へゼロ高 footer で組版する", () => {
    const { container } = render(WeatherAlertCard, {
      alerts: [weatherAlert({ items: [{
        kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: ["宮崎市"], omittedAreaCount: 3,
      }] })],
      tornado: restoredTornado(),
      measurementPageFooter: true,
      measurementRange: { start: 0, end: 1, tails: [{ kindKey: "warning|大雨警報", omittedAreaCount: 3 }], omittedAreaCount: 3 },
    });
    const card = container.querySelector<HTMLElement>(".weather-card");
    const body = card?.querySelector<HTMLElement>("[data-page-probe-body]");
    const footer = card?.querySelector<HTMLElement>("[data-card-page-footer]");
    const rider = card?.querySelector<HTMLElement>(".tornado-rider");
    expect(card?.hasAttribute("data-page-probe-card")).toBe(true);
    expect(card?.classList.contains("has-tornado")).toBe(true);
    expect(footer?.querySelector("[data-card-page-indicator]")?.textContent).toBe("1/1");
    expect(body?.contains(footer ?? null)).toBe(false);
    expect(footer?.nextElementSibling).toBe(rider);
    const source = readFileSync(join(__dirname, "..", "WeatherAlertCard.svelte"), "utf-8");
    expect(source).toMatch(/\.card-page-footer\s*\{[^}]*display:\s*flex;[^}]*flex:\s*0 0 0;[^}]*height:\s*0;/s);
    expect(source).toMatch(/\.weather-card\.has-page-footer ul\s*\{[^}]*padding-top:\s*calc\(var\(--space-2\) - 4px\);[^}]*padding-bottom:\s*calc\(var\(--space-3\) - 6px\);/s);
    expect(source).toMatch(/\.weather-card\.has-page-footer\.has-tornado \.tornado-rider\s*\{[^}]*margin-top:\s*var\(--card-page-indicator-block-size\);[^}]*padding-top:\s*calc\(var\(--space-2\) - 3px\);[^}]*padding-bottom:\s*calc\(var\(--space-2\) - 3px\);/s);
    expect(source).toMatch(/\.weather-card\.has-page-footer:not\(\.has-tornado\)\s*\{[^}]*padding-bottom:\s*var\(--card-page-indicator-block-size\);/s);
    expect(source).toMatch(/\.card-page-indicator\s*\{[^}]*block-size:\s*var\(--card-page-indicator-block-size\);[^}]*line-height:\s*1;/s);
    expect(source).not.toMatch(/\.card-page-footer\s*\{[^}]*transform:/s);
    expect(source).not.toMatch(/\.card-page-indicator\s*\{[^}]*position:\s*absolute;/s);
  });

  it("通常変異の測定棚は live と同じく truncate 時だけ 1/1 footer を持つ", () => {
    const { container } = render(WeatherAlertCard, {
      alerts: [weatherAlert({ items: [{
        kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: ["宮崎市"], omittedAreaCount: 3,
      }] })],
      tornado: restoredTornado(),
      measurementPageFooter: true,
    });
    const card = container.querySelector<HTMLElement>(".weather-card");
    expect(card?.classList.contains("has-page-footer")).toBe(true);
    expect(card?.querySelector("[data-card-page-indicator]")?.textContent).toBe("1/1");
  });

  it("非 paginate・非 truncate の棚は footer を増やさず rider の幅を live と揃える", () => {
    const { container } = render(WeatherAlertCard, {
      alerts: [weatherAlert({ items: [{
        kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: ["宮崎市"], omittedAreaCount: 0,
      }] })],
      tornado: restoredTornado(),
      measurementPageFooter: true,
    });
    const card = container.querySelector<HTMLElement>(".weather-card");
    expect(card?.classList.contains("has-page-footer")).toBe(false);
    expect(card?.querySelector("[data-card-page-footer]")).toBeNull();
    expect(card?.querySelector(".tornado-rider")).toBeTruthy();
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

  it("最高 role 内の item は rank 別色を保ったまま全て表示する", () => {
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
    expect(classes).toEqual([["rank-emergency"], ["rank-warning"], ["rank-advisory"]]);
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

  it("共有 coordinator の weather substate が地域リスト内容をページ単位で差し替える", async () => {
    const pageCoordinator = createCardPageCoordinator();
    const areas = Array.from({ length: 9 }, (_, index) => `地域${index + 1}`);
    const view = render(WeatherAlertCard, {
      alerts: [weatherAlert({ items: [{
        kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: areas, omittedAreaCount: 0,
      }] })],
      pageCoordinator,
      pageScheduling: true,
      rotationMember: true,
    });
    await tick();
    const card = view.container.querySelector<HTMLElement>(".weather-card")!;
    expect(card.dataset.cardPage).toBe("1/2");
    expect(card.querySelector("[data-card-page-indicator]")?.textContent).toBe("1/2");
    expect(card.textContent).toContain("地域1");
    expect(card.textContent).not.toContain("地域9");
    pageCoordinator.jumpTo("weather", 1);
    await tick();
    expect(card.dataset.cardPage).toBe("2/2");
    expect(card.querySelector("[data-card-page-indicator]")?.textContent).toBe("2/2");
    expect(card.textContent).toContain("地域9");
    expect(card.textContent).not.toContain("地域1");
    view.unmount();
    pageCoordinator.dispose();
  });

  it("wire truncated の残置行は該当 kind の最終ページにだけ復元する", async () => {
    const pageCoordinator = createCardPageCoordinator({ tickOverride: 0 });
    const areas = Array.from({ length: 9 }, (_, index) => `地域${index + 1}`);
    const view = render(WeatherAlertCard, {
      alerts: [weatherAlert({ items: [{
        kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: areas, omittedAreaCount: 12,
      }] })],
      pageCoordinator,
      pageScheduling: true,
    });
    await tick();
    expect(view.container.querySelector(".omitted")).toBeNull();
    expect(view.container.querySelector("[data-card-page-indicator]")?.textContent).toBe("1/2");
    pageCoordinator.jumpTo("weather", 1);
    await tick();
    expect(view.container.querySelector<HTMLElement>(".weather-card")?.dataset.cardPage).toBe("2/2");
    expect(view.container.querySelector("[data-card-page-indicator]")?.textContent).toBe("2/2");
    expect(view.container.querySelector(".omitted")?.textContent).toContain("ほか12地域");
    view.unmount();
    pageCoordinator.dispose();
  });

  it("tail-only kind は他kindの複数ページ後にも残置行として描画される", async () => {
    const pageCoordinator = createCardPageCoordinator({ tickOverride: 1 });
    const view = render(WeatherAlertCard, {
      alerts: [weatherAlert({ items: [
        { kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: Array.from({ length: 9 }, (_, i) => `地域${i + 1}`), omittedAreaCount: 0 },
        { kind: "洪水警報", displaySeverity: "warning", rank: "warning", shownAreas: [], omittedAreaCount: 7 },
      ] })],
      pageCoordinator,
      pageScheduling: true,
    });
    await tick();
    expect(view.container.querySelector<HTMLElement>(".weather-card")?.dataset.cardPage).toBe("2/2");
    expect(view.container.textContent).toContain("洪水警報");
    expect(view.container.textContent).toContain("ほか7地域");
    view.unmount();
    pageCoordinator.dispose();
  });

  it("先行 tail-only kind は後続地域の複数ページより前のcanonical位置に残る", async () => {
    const view = render(WeatherAlertCard, {
      alerts: [weatherAlert({ items: [
        { kind: "洪水警報", displaySeverity: "warning", rank: "warning", shownAreas: [], omittedAreaCount: 7 },
        { kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: ["後続地域1", "後続地域2"], omittedAreaCount: 0 },
      ] })],
      pageScheduling: true,
      partitionProbe: (_key, _placement, range) => range.end - range.start > 1 ? 2 : 0,
    });
    await tick();
    const card = view.container.querySelector<HTMLElement>(".weather-card")!;
    expect(card.dataset.cardPage).toBe("1/3");
    expect(card.textContent).toContain("洪水警報");
    expect(card.textContent).toContain("ほか7地域");
    expect(card.textContent).not.toContain("後続地域1");
    view.unmount();
  });

  it("実測 partition probe は長い地域名を一枚ずつのページ本文として残す", async () => {
    const pageCoordinator = createCardPageCoordinator({ tickOverride: 1 });
    const longAreas = ["長い地域名長い地域名長い地域名A", "長い地域名長い地域名長い地域名B"];
    const view = render(WeatherAlertCard, {
      alerts: [weatherAlert({ items: [{ kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: longAreas, omittedAreaCount: 0 }] })],
      pageCoordinator,
      pageScheduling: true,
      partitionProbe: (_key, _placement, range) => range.end - range.start > 1 ? 2 : 0,
    });
    await tick();
    const card = view.container.querySelector<HTMLElement>(".weather-card")!;
    expect(card.dataset.cardPage).toBe("2/2");
    expect(card.textContent).toContain(longAreas[1]);
    expect(card.querySelector("[data-card-page-indicator]")?.textContent).toBe("2/2");
    view.unmount();
    pageCoordinator.dispose();
  });

  it("pageScheduling は同名地域の Area.Code 差し替えを別ページ identity として扱う", async () => {
    const pageCoordinator = createCardPageCoordinator({ tickOverride: 0 });
    const makeAlerts = (firstCode: string) => [weatherAlert({ items: [{
      kind: "大雨警報", displaySeverity: "warning", rank: "warning",
      shownAreas: ["府中市", "後続地域"], shownAreaCodes: [firstCode, "4520100"], omittedAreaCount: 0,
    }] })];
    const view = render(WeatherAlertCard, {
      alerts: makeAlerts("1320600"), pageCoordinator, pageScheduling: true,
      partitionProbe: (_key, _placement, range) => range.end - range.start > 1 ? 2 : 0,
    });
    await tick();
    const before = pageCoordinator.cardDiagnostics("weather").identities;
    expect(before[0]).toContain("code:1320600");

    await view.rerender({
      alerts: makeAlerts("3420600"), pageCoordinator, pageScheduling: true,
      partitionProbe: (_key, _placement, range) => range.end - range.start > 1 ? 2 : 0,
    });
    await tick();
    const after = pageCoordinator.cardDiagnostics("weather").identities;
    expect(after[0]).toContain("code:3420600");
    expect(after).not.toContain(before[0]!);
    view.unmount();
    pageCoordinator.dispose();
  });

  it("pageScheduling は先頭へ加わる同名別 Area.Code を既存ページと別 identity にする", async () => {
    const pageCoordinator = createCardPageCoordinator({ tickOverride: 0 });
    const makeAlerts = (codes: string[]) => [weatherAlert({ items: [{
      kind: "大雨警報", displaySeverity: "warning", rank: "warning",
      shownAreas: codes.map(() => "府中市"), shownAreaCodes: codes, omittedAreaCount: 0,
    }] })];
    const view = render(WeatherAlertCard, {
      alerts: makeAlerts(["1320600", "3420600"]), pageCoordinator, pageScheduling: true,
      partitionProbe: (_key, _placement, range) => range.end - range.start > 1 ? 2 : 0,
    });
    await tick();
    const previous = pageCoordinator.cardDiagnostics("weather").identities;

    await view.rerender({
      alerts: makeAlerts(["1310100", "1320600", "3420600"]), pageCoordinator, pageScheduling: true,
      partitionProbe: (_key, _placement, range) => range.end - range.start > 1 ? 2 : 0,
    });
    await tick();
    const diagnostics = pageCoordinator.cardDiagnostics("weather");
    expect(diagnostics.identities).toHaveLength(3);
    expect(diagnostics.identities[0]).toContain("code:1310100");
    expect(diagnostics.identities).not.toContain(previous[0]!);
    expect(diagnostics.identities).toContain("warning|大雨警報|府中市|1|code:1320600");
    view.unmount();
    pageCoordinator.dispose();
  });

  it("混在rank・alias fallback・複数sourceでも wire weatherExpandedKinds とカード group key 集合が一致する", () => {
    const alerts = [
      weatherAlert({
        source: "vpws50",
        role: "weatherEmergency",
        items: [
          {
            kind: "大雨特別警報", phenomenonKey: "heavy-rain", displaySeverity: "emergency", rank: "emergency",
            shownAreas: ["宮崎市"], omittedAreaCount: 0,
          },
          {
            kind: "洪水特別警報", phenomenonKey: "flood", displaySeverity: "emergency", rank: "advisory",
            shownAreas: ["都城市"], omittedAreaCount: 0,
          },
        ],
      }),
      weatherAlert({
        source: "vpww56",
        role: "weatherEmergency",
        items: [{
          kind: "大雨特別警報", displaySeverity: "emergency", rank: "warning",
          shownAreas: ["日南市"], omittedAreaCount: 0,
        }],
      }),
      weatherAlert({
        source: "vpww56",
        role: "weatherWarning",
        items: [{
          kind: "下位の大雨警報", phenomenonKey: "lower-rain", displaySeverity: "warning", rank: "warning",
          shownAreas: ["除外地域"], omittedAreaCount: 0,
        }],
      }),
    ];
    const wireKeys = collectWeatherExpandedKinds(alerts).map((entry) => entry.kindKey);
    const { container } = render(WeatherAlertCard, { alerts });
    const cardKeys = Array.from(container.querySelectorAll<HTMLElement>("[data-kind-key]"))
      .map((element) => element.dataset.kindKey);
    expect(cardKeys).toEqual(wireKeys);
    expect(container.textContent).not.toContain("除外地域");
  });

  it("輪番所属 weather は実時間timerを持たず、再登場eventで地域ページを進める", async () => {
    vi.useFakeTimers();
    try {
      const pageCoordinator = createCardPageCoordinator();
      const areas = Array.from({ length: 9 }, (_, index) => `地域${index + 1}`);
      const view = render(WeatherAlertCard, {
        alerts: [weatherAlert({ items: [{
          kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: areas, omittedAreaCount: 0,
        }] })],
        pageCoordinator,
        pageScheduling: true,
        rotationMember: true,
      });
      await tick();
      const card = view.container.querySelector<HTMLElement>(".weather-card")!;
      expect(card.dataset.cardPage).toBe("1/2");
      expect(vi.getTimerCount()).toBe(0);
      pageCoordinator.recordRotationAppearance("weather");
      await tick();
      expect(card.dataset.cardPage).toBe("2/2");
      expect(card.textContent).toContain("地域9");
      view.unmount();
      pageCoordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("card-header は container/on/band トークンで #000 直値 fg を持たない", () => {
    const src = readFileSync(join(__dirname, "..", "WeatherAlertCard.svelte"), "utf-8");
    expect(src).toMatch(/var\(--header-weather\w+-container\)/);
    expect(src).toContain("var(--header-band-width)");
    // .card-header の CSS ブロックに color:#000 が残っていない
    expect(src).not.toMatch(/\.card-header\s*\{[^}]*color:\s*#000/);
  });
});
