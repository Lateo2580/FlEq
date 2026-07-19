import { describe, it, expect } from "vitest";
import {
  buildTickerSentence,
  tickerCategoryOf,
  tickerSubjectOf,
} from "../../../src/engine/display/ticker-sentence";
import {
  prefectureOf,
  formatPrefectureList,
} from "../../../src/engine/display/prefecture-format";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import { processWeatherWarningTimeseries } from "../../../src/engine/presentation/processors/process-weather-warning-timeseries";
import { fromWeatherWarningTimeseriesOutcome } from "../../../src/engine/presentation/events/from-weather-warning-timeseries";
import {
  createMockWsDataMessage,
  FIXTURE_VPWP50_NAGANO,
  FIXTURE_VPWP50_HIGH_SEVERITY,
  FIXTURE_VPWP50_CANCEL,
} from "../../helpers/mock-message";

describe("prefectureOf", () => {
  it("完全名そのもの", () => {
    expect(prefectureOf("茨城県")).toBe("茨城県");
  });
  it("括弧付き接尾辞を落とす", () => {
    expect(prefectureOf("鹿児島県（奄美地方除く）")).toBe("鹿児島県");
  });
  it("京都府が最短マッチで割れない", () => {
    expect(prefectureOf("京都府南部")).toBe("京都府");
  });
  it("都道府県で始まらない名前は null", () => {
    expect(prefectureOf("宗谷地方")).toBeNull();
  });
});

describe("formatPrefectureList", () => {
  it("3 県以内は全列挙", () => {
    expect(formatPrefectureList(["和歌山県", "徳島県"])).toBe("和歌山県・徳島県");
  });
  it("4 つ以上は代表 3 + など N 接尾辞 (県のみ)", () => {
    expect(
      formatPrefectureList(["茨城県", "千葉県", "神奈川県", "静岡県", "愛知県"]),
    ).toBe("茨城県・千葉県・神奈川県など5県");
  });
  it("接尾辞は 都道府県 の順で合成", () => {
    expect(
      formatPrefectureList(["茨城県", "東京都", "京都府", "北海道", "千葉県"]),
    ).toBe("茨城県・東京都・京都府など5都道府県");
  });
  it("同一県の複数予報区は 1 つに集約", () => {
    expect(
      formatPrefectureList(["鹿児島県（奄美地方除く）", "鹿児島県（奄美地方）"]),
    ).toBe("鹿児島県");
  });
  it("都道府県が取れない名前はそのまま列挙", () => {
    expect(formatPrefectureList(["宗谷地方", "上川地方"])).toBe("宗谷地方・上川地方");
  });
  it("非都道府県混在で 4 つ以上は件数なしの「など」", () => {
    expect(formatPrefectureList(["宗谷地方", "上川地方", "留萌地方", "石狩地方"])).toBe(
      "宗谷地方・上川地方・留萌地方など",
    );
  });
  it("空配列は null", () => {
    expect(formatPrefectureList([])).toBeNull();
  });
});

function makeEvent(overrides: Partial<PresentationEvent>): PresentationEvent {
  return {
    id: "t1",
    classification: "telegram.earthquake",
    domain: "earthquake",
    type: "VXSE53",
    infoType: "発表",
    title: "震源・震度情報",
    headline: null,
    reportDateTime: "2026-07-08T21:40:00+09:00",
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: "normal",
    isCancellation: false,
    areaNames: [],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: 0,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],
    raw: null,
    ...overrides,
  };
}

describe("buildTickerSentence", () => {
  it("地震: 12時間制の時刻 + 震源 + M + 最大震度の代表地域", () => {
    const event = makeEvent({
      originTime: "2026-07-08T21:37:00+09:00",
      hypocenterName: "宮城県沖",
      magnitude: "4.8",
      maxInt: "3",
      areaItems: [
        { name: "石巻市", maxInt: "3" },
        { name: "東松島市", maxInt: "3" },
        { name: "仙台市", maxInt: "2" },
        { name: "名取市", maxInt: "2" },
      ],
    });
    expect(buildTickerSentence(event)).toBe(
      "午後9時37分ごろ、宮城県沖を震源とするマグニチュード4.8の地震がありました。石巻市・東松島市で最大震度3を観測しています。",
    );
  });

  it("地震: 最大震度グループが 3 地域以上なら「など」", () => {
    const event = makeEvent({
      originTime: "2026-07-08T09:05:00+09:00",
      hypocenterName: "日向灘",
      magnitude: "5.2",
      maxInt: "4",
      areaItems: [
        { name: "宮崎市", maxInt: "4" },
        { name: "延岡市", maxInt: "4" },
        { name: "日南市", maxInt: "4" },
      ],
    });
    expect(buildTickerSentence(event)).toBe(
      "午前9時5分ごろ、日向灘を震源とするマグニチュード5.2の地震がありました。宮崎市・延岡市などで最大震度4を観測しています。",
    );
  });

  it("地震: 00:05 は午前0時5分ごろ (NHK 式 12 時間制)", () => {
    const event = makeEvent({
      originTime: "2026-07-08T00:05:00+09:00",
      hypocenterName: "茨城県沖",
      magnitude: "3.5",
      maxInt: "1",
      areaItems: [{ name: "水戸市", maxInt: "1" }],
    });
    expect(buildTickerSentence(event)).toBe(
      "午前0時5分ごろ、茨城県沖を震源とするマグニチュード3.5の地震がありました。水戸市で最大震度1を観測しています。",
    );
  });

  it("地震: 12:10 は午後0時10分ごろ (NHK 式 12 時間制)", () => {
    const event = makeEvent({
      originTime: "2026-07-08T12:10:00+09:00",
      hypocenterName: "千葉県東方沖",
      magnitude: "3.9",
      maxInt: "2",
      areaItems: [{ name: "銚子市", maxInt: "2" }],
    });
    expect(buildTickerSentence(event)).toBe(
      "午後0時10分ごろ、千葉県東方沖を震源とするマグニチュード3.9の地震がありました。銚子市で最大震度2を観測しています。",
    );
  });

  it("EEW 警報: 体言止め・句点なし・強い揺れに警戒", () => {
    const event = makeEvent({
      domain: "eew",
      type: "VXSE45",
      title: "緊急地震速報（警報）",
      serial: "8",
      hypocenterName: "日向灘",
      magnitude: "7.1",
      forecastMaxInt: "6弱",
      isWarning: true,
    });
    expect(buildTickerSentence(event)).toBe(
      "緊急地震速報 #8: 日向灘でM7.1の地震　予想最大震度6弱　強い揺れに警戒",
    );
  });

  it("EEW 予報: 警戒文言なし", () => {
    const event = makeEvent({
      domain: "eew",
      type: "VXSE44",
      title: "緊急地震速報（予報）",
      serial: "3",
      hypocenterName: "三陸沖",
      magnitude: "5.6",
      forecastMaxInt: "4",
      isWarning: false,
    });
    expect(buildTickerSentence(event)).toBe(
      "緊急地震速報(予報) #3: 三陸沖でM5.6の地震　予想最大震度4",
    );
  });

  it("津波: 体言止め + 予報区数", () => {
    const event = makeEvent({
      domain: "tsunami",
      type: "VTSE41",
      title: "津波警報・注意報・予報",
      tsunamiKinds: ["津波警報"],
      areaItems: [
        { name: "宮崎県", kind: "津波警報" },
        { name: "大分県瀬戸内海沿岸", kind: "津波警報" },
        { name: "愛媛県宇和海沿岸", kind: "津波警報" },
        { name: "鹿児島県東部", kind: "津波警報" },
      ],
    });
    expect(buildTickerSentence(event)).toBe(
      "宮崎県・大分県瀬戸内海沿岸など4地域に津波警報",
    );
  });

  it("洪水予報: 河川 + 観測所 + 種別 + 警戒レベル相当", () => {
    const event = makeEvent({
      domain: "floodForecast",
      type: "VXKO50",
      title: "○○川氾濫警戒情報",
      headline: "【警戒レベル３相当情報［洪水］】○○川上流では、氾濫警戒水位に到達",
      raw: {
        rawStations: [
          { stationName: "△△観測所", primaryRiverName: "○○川", riverNames: ["○○川"], headlineLevel: "L3" },
          { stationName: "□□観測所", primaryRiverName: "○○川", riverNames: ["○○川"], headlineLevel: "L2" },
        ],
      } as unknown as PresentationEvent["raw"],
    });
    expect(buildTickerSentence(event)).toBe(
      "○○川の△△観測所で氾濫警戒情報（警戒レベル3相当）。",
    );
  });

  it("洪水予報: 観測所名が無い形は河川のみ", () => {
    const event = makeEvent({
      domain: "floodForecast",
      type: "VXKO50",
      title: "多摩川氾濫危険情報",
      raw: {
        rawStations: [
          { stationName: "", primaryRiverName: "多摩川", riverNames: ["多摩川"], headlineLevel: "L4" },
        ],
      } as unknown as PresentationEvent["raw"],
    });
    expect(buildTickerSentence(event)).toBe("多摩川で氾濫危険情報（警戒レベル4相当）。");
  });

  it("洪水予報: 解除 (種別未確定) は headline フォールバック", () => {
    const event = makeEvent({
      domain: "floodForecast",
      type: "VXKO50",
      title: "○○川洪水注意報解除",
      headline: "○○川の氾濫注意情報を解除",
      raw: {
        rawStations: [
          { stationName: "△△観測所", primaryRiverName: "○○川", riverNames: ["○○川"], headlineLevel: "release" },
        ],
      } as unknown as PresentationEvent["raw"],
    });
    expect(buildTickerSentence(event)).toBe("○○川の氾濫注意情報を解除。");
  });

  it("洪水予報: rawStations 空 (Headline-only / VXSU stub) は headline フォールバック", () => {
    const event = makeEvent({
      domain: "floodForecast",
      type: "VXSU50",
      title: "△△川水位周知",
      headline: "△△川で氾濫注意水位に到達",
      raw: { rawStations: [] } as unknown as PresentationEvent["raw"],
    });
    expect(buildTickerSentence(event)).toBe("△△川で氾濫注意水位に到達。");
  });

  it("洪水予報: 取消は観測所データが残っていても専用文を出さず共通の取消文", () => {
    const event = makeEvent({
      domain: "floodForecast",
      type: "VXKO50",
      title: "○○川氾濫警戒情報",
      isCancellation: true,
      infoType: "取消",
      raw: {
        rawStations: [
          { stationName: "△△観測所", primaryRiverName: "○○川", riverNames: ["○○川"], headlineLevel: "L3" },
        ],
      } as unknown as PresentationEvent["raw"],
    });
    expect(buildTickerSentence(event)).toBe("○○川氾濫警戒情報は取り消されました。");
  });

  it("長周期地震動: 最大階級の地域が複数あれば代表 1 つ + など", () => {
    const event = makeEvent({
      domain: "lgObservation",
      type: "VXSE62",
      title: "長周期地震動に関する観測情報",
      hypocenterName: "宮城県沖",
      maxLgInt: "3",
      areaItems: [
        { name: "東京都23区", maxLgInt: "3" },
        { name: "埼玉県南部", maxLgInt: "3" },
        { name: "神奈川県東部", maxLgInt: "2" },
      ],
    });
    expect(buildTickerSentence(event)).toBe(
      "宮城県沖を震源とする地震で、東京都23区などで長周期地震動階級3を観測。",
    );
  });

  it("長周期地震動: 最大階級が 1 地域なら下位階級があっても「など」なし", () => {
    const event = makeEvent({
      domain: "lgObservation",
      type: "VXSE62",
      title: "長周期地震動に関する観測情報",
      hypocenterName: "宮城県沖",
      maxLgInt: "3",
      areaItems: [
        { name: "東京都23区", maxLgInt: "3" },
        { name: "神奈川県東部", maxLgInt: "2" },
      ],
    });
    expect(buildTickerSentence(event)).toBe(
      "宮城県沖を震源とする地震で、東京都23区で長周期地震動階級3を観測。",
    );
  });

  it("長周期地震動: 対象地域が 1 つなら「など」なし", () => {
    const event = makeEvent({
      domain: "lgObservation",
      type: "VXSE62",
      title: "長周期地震動に関する観測情報",
      hypocenterName: "日向灘",
      maxLgInt: "4",
      areaItems: [{ name: "宮崎県南部平野部", maxLgInt: "4" }],
    });
    expect(buildTickerSentence(event)).toBe(
      "日向灘を震源とする地震で、宮崎県南部平野部で長周期地震動階級4を観測。",
    );
  });

  it("長周期地震動: 震源が取れなければ地域からのみ", () => {
    const event = makeEvent({
      domain: "lgObservation",
      type: "VXSE62",
      title: "長周期地震動に関する観測情報",
      hypocenterName: null,
      maxLgInt: "3",
      areaItems: [
        { name: "東京都23区", maxLgInt: "3" },
        { name: "千葉県北西部", maxLgInt: "3" },
      ],
    });
    expect(buildTickerSentence(event)).toBe("東京都23区などで長周期地震動階級3を観測。");
  });

  it("軽症組 (火山): headline に句点を保証", () => {
    const event = makeEvent({
      domain: "volcano",
      type: "VFVO50",
      title: "噴火警報",
      headline: "桜島で噴火警戒レベル3に引上げ",
    });
    expect(buildTickerSentence(event)).toBe("桜島で噴火警戒レベル3に引上げ。");
  });

  it("取消 (軽症組): title は取り消されました", () => {
    const event = makeEvent({
      domain: "tornado",
      type: "VPHW50",
      title: "竜巻注意情報",
      isCancellation: true,
      infoType: "取消",
    });
    expect(buildTickerSentence(event)).toBe("竜巻注意情報は取り消されました。");
  });

  it("フォールバック: headline も title も文章化できない構造でも非空", () => {
    const event = makeEvent({ domain: "raw", type: "UNKNOWN", title: "不明電文" });
    expect(buildTickerSentence(event)).toBe("不明電文。");
  });

  it("weather で raw が null でも旧ダンプに戻らず最小一文に落ちる (spec 必須 fixture)", () => {
    const event = makeEvent({
      domain: "weather",
      type: "VPWW55",
      title: "熊本県大雨警報・注意報",
      headline: "土砂災害に警戒してください",
      raw: null,
    });
    expect(buildTickerSentence(event)).toBe("土砂災害に警戒してください。");
  });
});

describe("tickerCategoryOf", () => {
  it("VPWS50 は全国集約ラベル", () => {
    expect(tickerCategoryOf(makeEvent({ domain: "weather", type: "VPWS50" }))).toBe(
      "気象警報・注意報（全国集約）",
    );
  });
  it("VPWW55 は単県ラベル", () => {
    expect(tickerCategoryOf(makeEvent({ domain: "weather", type: "VPWW55" }))).toBe(
      "気象警報・注意報",
    );
  });
  it("earthquake は地震情報", () => {
    expect(tickerCategoryOf(makeEvent({}))).toBe("地震情報");
  });
});

describe("weatherWarningTimeseriesSentence (VPWP50、実 fixture ゴールデン)", () => {
  const sentenceOf = (fixture: string): string => {
    const ev = fromWeatherWarningTimeseriesOutcome(
      processWeatherWarningTimeseries(createMockWsDataMessage(fixture))!,
    );
    return buildTickerSentence(ev);
  };

  it("注意報級のみ: 「{地域}で{種別}が予測されています。」", () => {
    expect(sentenceOf(FIXTURE_VPWP50_NAGANO)).toBe("長野で濃霧注意報が予測されています。");
  });

  it("警報級を優先し、alertLevel 系は「(警戒レベルN相当)」で誤読名を避ける", () => {
    expect(sentenceOf(FIXTURE_VPWP50_HIGH_SEVERITY)).toBe(
      "稚内市で土砂災害（警戒レベル4相当）・大雨特別警報が予測されています。",
    );
  });

  it("取消は専用文", () => {
    expect(sentenceOf(FIXTURE_VPWP50_CANCEL)).toBe("気象警報・注意報の予測情報は取り消されました。");
  });

  it("題名だけのフォールバックに落ちない (種別が本文に出る)", () => {
    const s = sentenceOf(FIXTURE_VPWP50_NAGANO);
    expect(s).not.toBe("長野気象警報・注意報時系列情報。");
    expect(s).toContain("予測されています");
  });
});

function ev(over: Record<string, unknown>): PresentationEvent {
  return {
    id: "x", classification: "c", domain: "volcano", type: "VFVO50", infoType: "発表", title: "t",
    headline: null, reportDateTime: "2026-07-11T00:00:00+09:00", publishingOffice: "気象庁", isTest: false,
    frameLevel: "normal", isCancellation: false,
    areaNames: [], forecastAreaNames: [], municipalityNames: [], observationNames: [],
    areaCount: 0, forecastAreaCount: 0, municipalityCount: 0, observationCount: 0, areaItems: [], raw: null,
    ...over,
  } as unknown as PresentationEvent;
}

describe("tickerSubjectOf 件名導出", () => {
  it("火山は volcanoName", () => {
    expect(tickerSubjectOf(ev({ domain: "volcano", volcanoName: "桜島" }))).toBe("桜島");
  });
  it("台風は raw.name から台風番号を短縮", () => {
    const raw = { name: { name: "ナクリー", number: "2015", remark: null } };
    expect(tickerSubjectOf(ev({ domain: "typhoonAnalysis", raw }))).toBe("台風15号");
  });
  it("気象解説 (地方版): タイトルが県名で始まらないので無加工", () => {
    expect(tickerSubjectOf(ev({ domain: "weatherExplanation", areaNames: ["関東甲信地方"] }))).toBe("関東甲信地方");
  });
  it("気象解説 (府県版): タイトルの県名を地域名に併記", () => {
    expect(
      tickerSubjectOf(
        ev({ domain: "weatherExplanation", title: "山形県気象解説情報（大雪・高波・雷）", areaNames: ["村山"] }),
      ),
    ).toBe("山形県 村山");
  });
  it("気象解説 (府県版): 地域名が既に県名で始まるなら二重化しない", () => {
    expect(
      tickerSubjectOf(
        ev({ domain: "weatherExplanation", title: "福井県気象解説情報", areaNames: ["福井県嶺北"] }),
      ),
    ).toBe("福井県嶺北");
  });
  it("気候 (地方版): タイトルが県名で始まらないので無加工", () => {
    expect(tickerSubjectOf(ev({ domain: "climateInfo", areaItems: [{ name: "関東甲信地方" }] }))).toBe("関東甲信地方");
  });
  it("気候 (府県版): タイトルの県名を地域名に併記", () => {
    expect(
      tickerSubjectOf(
        ev({ domain: "climateInfo", title: "新潟県天候情報", areaItems: [{ name: "上越" }] }),
      ),
    ).toBe("新潟県 上越");
  });
  it("熱中症は areaNames[0]", () => {
    expect(tickerSubjectOf(ev({ domain: "heatAlert", areaNames: ["埼玉県"] }))).toBe("埼玉県");
  });
  it("南海トラフ・供給源欠落は null", () => {
    expect(tickerSubjectOf(ev({ domain: "nankaiTrough" }))).toBeNull();
    expect(tickerSubjectOf(ev({ domain: "volcano", volcanoName: null }))).toBeNull();
    expect(tickerSubjectOf(ev({ domain: "earthquake" }))).toBeNull();
  });
});
