import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import UpdatedStamp from "../UpdatedStamp.svelte";
import VolcanoCard from "../VolcanoCard.svelte";
import TyphoonCard from "../TyphoonCard.svelte";
import WeatherAlertCard from "../WeatherAlertCard.svelte";
import TsunamiStandbyBanner from "../TsunamiStandbyBanner.svelte";
import type {
  ActiveStandbyCardV1,
  DisplayTsunamiStateV1,
  DisplayWeatherAlertV1,
} from "../../lib/protocol";

// 最終更新時刻の表示 (ご主人要望 2026-07-26)。気象警報 / 台風情報 / 火山情報 / 津波情報の
// 4 カードで、見出し帯の右端に「更新 M/D HH:MM」を出す。
// 時刻は Asia/Tokyo 固定で評価される (vitest.config.ts の TZ 設定)。

function volcanoItem(updatedAt: string): Extract<ActiveStandbyCardV1, { kind: "volcano" }> {
  return {
    kind: "volcano", surface: "corner-right", key: "volcano:active", sourceEventIds: ["v1"],
    updatedAt, expiresAt: null, restored: false, severity: "critical",
    data: { volcanoes: [{ code: "506", name: "桜島", alertLevel: 3, latestEvent: null }] },
  };
}

function typhoonItem(updatedAt: string): Extract<ActiveStandbyCardV1, { kind: "typhoon" }> {
  return {
    kind: "typhoon", surface: "corner-right", key: "typhoon:active", sourceEventIds: ["t1"],
    updatedAt, expiresAt: null, restored: false, severity: "normal",
    data: {
      typhoons: [{
        typhoonKey: "TC-1", name: "Alpha", nameKana: "アルファ", remark: null, typhoonNumber: "2605",
        category: "TS", location: "沖縄の南", pressureHpa: 990, maxWindMs: 25,
        moveDirection: "北", moveSpeedKmh: 20, reportDateTime: updatedAt,
      }],
    },
  };
}

function weatherAlert(source: "vpws50" | "vpww56", updatedAt: string): DisplayWeatherAlertV1 {
  return {
    source, label: "気象警報", role: "weatherWarning", totalAreas: 1,
    items: [{ kind: "L3 大雨警報", displaySeverity: "officialL3", rank: "warning", shownAreas: ["東京都"], omittedAreaCount: 0 }],
    updatedAt,
  };
}

function tsunamiState(reportDateTime: string): DisplayTsunamiStateV1 {
  return {
    kind: "tsunami", level: "warning", levelLabel: "津波警報",
    coasts: [{ name: "岩手県", kind: "warning", maxHeight: null, firstHeight: null }],
    warningComment: null, observations: [], reportDateTime, updatedAtMs: 0,
  };
}

describe("UpdatedStamp", () => {
  it("月日込みで出す (HH:MM だけだと数日前の電文が今日の更新に見えるため)", () => {
    const { container } = render(UpdatedStamp, { iso: "2026-07-08T09:05:00+09:00" });
    expect(container.querySelector(".updated-stamp")?.textContent).toBe("更新 7/8 09:05");
  });

  it("iso が null / 空なら何も描かない (「更新 -」を出さない)", () => {
    const nullCase = render(UpdatedStamp, { iso: null });
    expect(nullCase.container.querySelector(".updated-stamp")).toBeFalsy();
    nullCase.unmount();
    const emptyCase = render(UpdatedStamp, { iso: "" });
    expect(emptyCase.container.querySelector(".updated-stamp")).toBeFalsy();
  });
});

describe("カード見出しの最終更新時刻", () => {
  it("火山情報カードは header 右端に電文の更新時刻を出す", () => {
    const { container } = render(VolcanoCard, { item: volcanoItem("2026-07-08T09:05:00+09:00") });
    expect(container.querySelector("header .updated-stamp")?.textContent).toBe("更新 7/8 09:05");
  });

  it("台風情報カードは header 右端に電文の更新時刻を出す", () => {
    const { container } = render(TyphoonCard, { item: typhoonItem("2026-07-08T21:30:00+09:00") });
    expect(container.querySelector("header .updated-stamp")?.textContent).toBe("更新 7/8 21:30");
  });

  it("津波情報バナーは header 右端に電文の発表時刻を出す", () => {
    const { container } = render(TsunamiStandbyBanner, {
      tsunami: tsunamiState("2026-07-08T05:00:00+09:00"),
    });
    expect(container.querySelector(".banner-header .updated-stamp")?.textContent).toBe("更新 7/8 05:00");
  });

  it("気象警報カードは束ねている alert のうち最新の updatedAt を出す (source は独立に届く)", () => {
    const { container } = render(WeatherAlertCard, {
      alerts: [
        weatherAlert("vpws50", "2026-07-08T09:00:00+09:00"),
        weatherAlert("vpww56", "2026-07-08T11:20:00+09:00"),
      ],
    });
    expect(container.querySelector(".card-header .updated-stamp")?.textContent).toBe("更新 7/8 11:20");
  });

  // Codex 最終レビュー: 起動 seed は toISOString() の `Z`、live 更新は電文の reportDateTime
  // (`+09:00`) をそのまま運ぶので、オフセット表記は実際に混在する。辞書順で比べると逆転する
  it("オフセット表記が混在しても時刻として比較する (Z と +09:00 の混在)", () => {
    const { container } = render(WeatherAlertCard, {
      alerts: [
        // JST 09:05 (こちらが新しい)。辞書順では "2026-07-08T09:00:00+09:00" に負ける
        weatherAlert("vpws50", "2026-07-08T00:05:00.000Z"),
        weatherAlert("vpww56", "2026-07-08T09:00:00+09:00"),
      ],
    });
    expect(container.querySelector(".card-header .updated-stamp")?.textContent).toBe("更新 7/8 09:05");
  });

  it("気象警報カードは alert が 1 件でもその時刻を出す", () => {
    const { container } = render(WeatherAlertCard, {
      alerts: [weatherAlert("vpws50", "2026-07-08T09:00:00+09:00")],
    });
    expect(container.querySelector(".card-header .updated-stamp")?.textContent).toBe("更新 7/8 09:00");
  });
});
