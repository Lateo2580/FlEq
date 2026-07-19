import { describe, it, expect } from "vitest";
import { volcanoAshfallToText } from "../../../../src/engine/presentation/events/volcano-to-text";
import type { AshArea, AshForecastPeriod, ParsedVolcanoAshfallInfo } from "../../../../src/types";

function area(over: Partial<AshArea>): AshArea {
  return { name: "都城市", code: "4520200", ashCode: "70", ashName: "降灰", thickness: null, plumeDirection: null, distanceKm: null, ...over };
}
function period(over: Partial<AshForecastPeriod>): AshForecastPeriod {
  return { startTime: "2021-05-17T15:00:00+09:00", endTime: "2021-05-17T18:00:00+09:00", areas: [], ...over };
}
function ashfall(over: Partial<ParsedVolcanoAshfallInfo>): ParsedVolcanoAshfallInfo {
  return {
    kind: "ashfall", type: "VFVO53", subKind: "scheduled", infoType: "発表", title: "降灰予報",
    reportDateTime: "2021-05-17T14:00:00+09:00", eventDateTime: null, headline: null,
    publishingOffice: "気象庁", volcanoName: "桜島", volcanoCode: "506", coordinate: null,
    isTest: false, craterName: null, ashForecasts: [], plumeHeight: null, plumeDirection: null,
    bodyText: "原文平文", ...over,
  };
}

describe("volcanoAshfallToText 最低情報量ガード", () => {
  it("全 period が時間帯+現象+地域を満たすと合成文を返す", () => {
    const info = ashfall({ ashForecasts: [period({
      areas: [
        area({ ashName: "降灰", plumeDirection: "東（鹿屋市輝北方向）", distanceKm: 100 }),
        area({ ashName: "小さな噴石の落下", plumeDirection: "東", distanceKm: 5 }),
      ],
    })] });
    const text = volcanoAshfallToText(info);
    expect(text).toContain("【桜島】");
    expect(text).toContain("17日15時から18時まで");
    expect(text).toContain("東（鹿屋市輝北方向）に降灰（火口から100kmまで）");
    expect(text).toContain("東方向に小さな噴石の落下（火口から5kmまで）");
    expect(text).not.toContain("　"); // 全角スペースを含まない
  });
  it("direction が「方向」を含む場合 (description 属性の詳細語) は「方向」を二重化しない", () => {
    const info = ashfall({ ashForecasts: [period({
      areas: [area({ ashName: "やや多量の降灰", ashCode: "72", plumeDirection: "北西（鹿児島市吉野方向）", distanceKm: 20 })],
    })] });
    const text = volcanoAshfallToText(info);
    expect(text).toContain("北西（鹿児島市吉野方向）にやや多量の降灰（火口から20kmまで）");
    expect(text).not.toContain("方向）方向に");
  });
  it("direction が単純方位 (「方向」を含まない) の場合は「方向に」を補う", () => {
    const info = ashfall({ ashForecasts: [period({
      areas: [area({ ashName: "小さな噴石の落下", ashCode: "75", plumeDirection: "北東", distanceKm: 5 })],
    })] });
    const text = volcanoAshfallToText(info);
    expect(text).toContain("北東方向に小さな噴石の落下（火口から5kmまで）");
  });
  it("direction が「直上」の場合は場所寄りの語として「方向に」を付けず「に」直結する", () => {
    const info = ashfall({ ashForecasts: [period({
      areas: [area({ ashName: "少量の降灰", ashCode: "71", plumeDirection: "直上", distanceKm: null })],
    })] });
    const text = volcanoAshfallToText(info);
    expect(text).toContain("直上に少量の降灰");
    expect(text).not.toContain("直上方向に");
  });
  it("direction が「火口近傍」の場合は場所寄りの語として「方向に」を付けず「に」直結する", () => {
    const info = ashfall({ ashForecasts: [period({
      areas: [area({ ashName: "降灰", ashCode: "70", plumeDirection: "火口近傍", distanceKm: null })],
    })] });
    const text = volcanoAshfallToText(info);
    expect(text).toContain("火口近傍に降灰");
    expect(text).not.toContain("火口近傍方向に");
  });
  it("ashName が程度語込みの現象名 (実データ形) でも自然な文になる", () => {
    const info = ashfall({ ashForecasts: [period({
      areas: [area({ ashName: "少量の降灰", ashCode: "71", plumeDirection: "南東", distanceKm: 100 })],
    })] });
    const text = volcanoAshfallToText(info);
    expect(text).toContain("南東方向に少量の降灰（火口から100kmまで）");
  });
  it("方向なしは成功 (方向句を落とす)", () => {
    const info = ashfall({ ashForecasts: [period({ areas: [area({ plumeDirection: null, distanceKm: 100 })] })] });
    const text = volcanoAshfallToText(info);
    expect(text).toContain("降灰（火口から100kmまで）");
    expect(text).not.toContain("へ降灰");
  });
  it("距離なしでも対象地域があれば成功 (距離句を落とす)", () => {
    const info = ashfall({ ashForecasts: [period({ areas: [area({ plumeDirection: "南東", distanceKm: null })] })] });
    const text = volcanoAshfallToText(info);
    expect(text).not.toBeNull();
    expect(text).toContain("南東方向に降灰");
    expect(text).not.toContain("まで）");
  });
  it("時間帯なしの period が1つでもあると全体 null", () => {
    const info = ashfall({ ashForecasts: [
      period({ areas: [area({})] }),
      period({ startTime: "", endTime: "", areas: [area({})] }),
    ] });
    expect(volcanoAshfallToText(info)).toBeNull();
  });
  it("対象地域が空の period が1つでもあると全体 null", () => {
    const info = ashfall({ ashForecasts: [period({ areas: [] })] });
    expect(volcanoAshfallToText(info)).toBeNull();
  });
  it("ashForecasts 空は null", () => {
    expect(volcanoAshfallToText(ashfall({ ashForecasts: [] }))).toBeNull();
  });
  it("非空だが解釈不能な時刻を含む period が1つでもあると全体 null (原文フォールバック、部分合成文にしない)", () => {
    const info = ashfall({ ashForecasts: [
      period({ areas: [area({})] }),
      period({ startTime: "invalid", endTime: "invalid", areas: [area({})] }),
    ] });
    expect(volcanoAshfallToText(info)).toBeNull();
  });
});
