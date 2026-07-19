import { describe, it, expect } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { readFileSync } from "fs";
import { join } from "path";
import { extractForecast, computeFallback } from "../../src/dmdata/weather-explanation-forecast";

const xmlParser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", parseTagValue: false,
  isArray: (n) => ["MeteorologicalInfos","MeteorologicalInfo","TimeSeriesInfo","TimeDefine","Item","Kind","Text","Area","Local"].includes(n),
});

function bodyOf(file: string): unknown {
  const xml = readFileSync(join("test/fixtures", file), "utf-8");
  const parsed = xmlParser.parse(xml);
  return parsed.Report.Body;
}

describe("extractForecast - 線状降水帯 (EventPart)", () => {
  it("県別の線状降水帯タイムラインを抽出", () => {
    const fc = extractForecast(bodyOf("83_02_01_260324_VPZJ51.xml"))!;
    expect(fc).not.toBeNull();
    expect(fc.series.length).toBe(1);
    const ev = fc.series[0].events;
    expect(ev.length).toBeGreaterThanOrEqual(12);
    const tokushima = ev.find((e) => e.areaName === "徳島県")!;
    expect(tokushima.regionLabel).toBe("四国地方");
    // [Codex plan R1] Sentence は期間文、「線状降水帯」は EventName 側
    expect(tokushima.eventType).toBe("線状降水帯");      // Event @type
    expect(tokushima.eventName).toBe("線状降水帯予想");   // EventName
    expect(tokushima.sentence).toContain("にかけて");      // Sentence = 期間文
    expect(tokushima.duration).toBe("PT24H");
  });

  it("Local 無 EventPart (Base.Event 直下)・refID 不在・Code無→CodeList を安全処理", () => {
    // Codex plan R2: Local が無く Base 直下に Event がある形 (fallback パス)
    const synthetic = xmlParser.parse(
      `<Body><MeteorologicalInfos type="予想"><TimeSeriesInfo>
        <TimeDefines><TimeDefine timeId="1"><Name>1日</Name></TimeDefine></TimeDefines>
        <Item><Kind><Property><Type>気象現象の予想</Type>
          <EventPart><Base>
            <Event type="線状降水帯" refID="9"><Sentence>S</Sentence><EventName>E</EventName></Event>
          </Base></EventPart>
        </Property></Kind><Area><Name>（地方）X県</Name><CodeList>019999</CodeList></Area></Item>
      </TimeSeriesInfo></MeteorologicalInfos></Body>`,
    ).Body;
    const fc = extractForecast(synthetic)!;
    const e = fc.series[0].events[0];
    expect(e.areaName).toBe("X県");     // Local 無 → Area.Name の県名に fallback
    expect(e.timeName).toBeNull();      // refID=9 は TimeDefine に無い → null
    expect(e.time).toBeNull();          // Event.Time 欠落 → null
    expect(e.code).toBe("019999");      // Code 無 → CodeList fallback
  });
});

describe("extractForecast - 台風 (定量 3 系列)", () => {
  it("風/波/雨 の 3 TimeSeriesInfo を別系列に保持 (timeId 系列ローカル)", () => {
    const fc = extractForecast(bodyOf("83_02_02_250630_VPZJ51.xml"))!;
    expect(fc.series.length).toBe(3);
    const rain = fc.series.find((s) => s.metrics.some((m) => m.metricType === "雨の予想"))!;
    expect(rain.timeDefines.length).toBe(3); // 雨は timeId 1,2,3
    const wind = fc.series.find((s) => s.metrics.some((m) => m.metricType === "風の予想"))!;
    expect(wind.timeDefines.length).toBe(2); // 風は 1,2
  });

  it("波高 condition=うねり は値と condition を両保持", () => {
    const fc = extractForecast(bodyOf("83_02_02_250630_VPZJ51.xml"))!;
    const wave = fc.series.find((s) => s.metrics.some((m) => m.metricType === "波の予想"))!;
    const allVals = wave.metrics.flatMap((m) => m.locals.flatMap((l) => l.phases.flatMap((p) => p.values)));
    const swell = allVals.find((v) => v.condition === "うねり" && v.value != null)!;
    expect(swell.value).toBeGreaterThan(0);
    expect(swell.condition).toBe("うねり");
    const none = allVals.find((v) => v.condition === "値なし");
    expect(none?.value).toBeNull();
  });

  it("Text を @type で分類 (気象要素=element)", () => {
    const fc = extractForecast(bodyOf("83_02_02_250630_VPZJ51.xml"))!;
    const wind = fc.series.find((s) => s.metrics.some((m) => m.metricType === "風の予想"))!;
    expect(wind.element).toContain("最大風速");
    expect(wind.intro.join("")).toContain("猛烈な風");
  });
});

describe("extractForecast - 複数の時系列解説キャプション除外", () => {
  it("VMCJ55 (89_02 千葉・大潮): TimeDefine 別キャプション 7 本を intro に積まない", () => {
    const fc = extractForecast(bodyOf("89_02_01_250630_VMCJ55.xml"))!;
    expect(fc).not.toBeNull();
    const joined = fc.series.flatMap((s) => s.intro).join("");
    // 日付情報は潮位予想の [timeName] 表示と完全重複するため省く
    expect(joined).not.toContain("４日に予想される満潮時刻");
    expect(joined).not.toContain("１０日に予想される満潮時刻");
    // 気象要素 (列見出し文) は従来どおり element に残る
    const tidal = fc.series.find((s) => s.element != null)!;
    expect(tidal.element).toContain("予想される満潮時刻及び平常時の潮位");
  });

  it("VMCJ55 (89_01 副振動): 単一の時系列解説はセクション導入文として intro に残す", () => {
    const fc = extractForecast(bodyOf("89_01_01_250630_VMCJ55.xml"))!;
    expect(fc).not.toBeNull();
    const joined = fc.series.flatMap((s) => s.intro).join("");
    expect(joined).toContain("次の満潮・干潮時刻は、以下のとおりです。");
  });

  it("VPFJ51 (85(82)_02_01 福井雪): 複数キャプション (降雪量×2/波×3) は intro から除外され、気象要素は element に残る", () => {
    const fc = extractForecast(bodyOf("85(82)_02_01_250630_VPFJ51.xml"))!;
    expect(fc).not.toBeNull();
    const joined = fc.series.flatMap((s) => s.intro).join("");
    // TimeDefine 別キャプションは metrics テーブルの列見出し (timeName) と重複するため省く
    expect(joined).not.toContain("２３日１８時から２４日１８時までに予想される２４時間降雪量");
    expect(joined).not.toContain("２３日に予想される波の高さ");
    // 気象要素 (列見出し文) は従来どおり各 series の element に残る
    const elements = fc.series.map((s) => s.element).filter((e) => e != null);
    expect(elements).toContain("予想される２４時間降雪量");
    expect(elements).toContain("予想される波の高さ");
  });

  it("VPFJ51 (85(82)_02_07 福井雪継続): 単一キャプション (降雪量×1) は intro に残り、複数 (波×2) は除外 (件数ベース発火条件の固定)", () => {
    const fc = extractForecast(bodyOf("85(82)_02_07_260326_VPFJ51.xml"))!;
    expect(fc).not.toBeNull();
    const joined = fc.series.flatMap((s) => s.intro).join("");
    // 同一 Property 内 1 本だけの時系列解説はセクション導入文として残す
    expect(joined).toContain("２４日１８時から２５日１８時までに予想される２４時間降雪量");
    // 2 本以上は除外
    expect(joined).not.toContain("２４日に予想される波の高さ");
  });

  it("VPFJ51 形 (synthetic): 複数キャプション除外後も type=解説 の散文 intro は残る", () => {
    // 実 VPFJ51 fixture の 解説 Text は空のため、散文 intro 残存は synthetic で固定する
    const synthetic = xmlParser.parse(
      `<Body><MeteorologicalInfos type="予想"><TimeSeriesInfo>
        <TimeDefines>
          <TimeDefine timeId="1"><Name>２３日</Name></TimeDefine>
          <TimeDefine timeId="2"><Name>２４日</Name></TimeDefine>
        </TimeDefines>
        <Item>
          <Kind><Property><Type>雪の予想</Type>
            <Text type="解説">大雪に警戒してください。</Text>
            <Text type="時系列解説" refID="1">２３日に予想される降雪量は、</Text>
            <Text type="時系列解説" refID="2">２４日に予想される降雪量は、</Text>
            <Text type="気象要素">予想される２４時間降雪量</Text>
            <SnowfallDepthPart><Base>
              <jmx_eb:SnowfallDepth type="２４時間最大降雪量" unit="cm" refID="1">30</jmx_eb:SnowfallDepth>
            </Base></SnowfallDepthPart>
          </Property></Kind>
          <Area><Name>（嶺北）福井県</Name><Code>180000</Code></Area>
        </Item>
      </TimeSeriesInfo></MeteorologicalInfos></Body>`,
    ).Body;
    const fc = extractForecast(synthetic)!;
    expect(fc).not.toBeNull();
    const joined = fc.series.flatMap((s) => s.intro).join("");
    expect(joined).toContain("大雪に警戒してください。");
    expect(joined).not.toContain("２３日に予想される降雪量");
    expect(joined).not.toContain("２４日に予想される降雪量");
  });

  it("VPZJ51 (83_02_02 台風): 複数キャプションは省かれ、解説本文は残る", () => {
    const fc = extractForecast(bodyOf("83_02_02_250630_VPZJ51.xml"))!;
    const wind = fc.series.find((s) => s.metrics.some((m) => m.metricType === "風の予想"))!;
    // 解説 (type="解説") は従来どおり intro に残る
    expect(wind.intro.join("")).toContain("猛烈な風");
    // 「２９日に予想される最大風速…」等のキャプションは列見出し (２９日/３０日) と重複するため省く
    expect(wind.intro.join("")).not.toContain("２９日に予想される最大風速");
  });
});

describe("extractForecast - 予想なし", () => {
  it("VPCJ51 (予想なし) は null", () => {
    const fc = extractForecast(bodyOf("84_01_01_260129_VPCJ51.xml"));
    expect(fc).toBeNull();
  });
});

describe("extractForecast - Area.Code 属性付き要素 (Codex R1 Minor1)", () => {
  it("Code に type 属性がある場合でも code が正しく抽出される", () => {
    // <Code codeType="...">VALUE</Code> のような属性付き Code を nodeText で正しく読む
    const synthetic = xmlParser.parse(
      `<Body><MeteorologicalInfos type="予想"><TimeSeriesInfo>
        <TimeDefines>
          <TimeDefine timeId="1"><DateTime>2026-01-01T06:00:00+09:00</DateTime><Duration>PT6H</Duration><Name>6時</Name></TimeDefine>
        </TimeDefines>
        <Item>
          <Kind><Property><EventPart><Base>
            <Event type="現象" refID="1"><Sentence>テスト</Sentence><EventName>現象</EventName></Event>
          </Base></EventPart></Property></Kind>
          <Area><Name>（地方）X県</Name><Code codeType="AreaForecast">019999</Code></Area>
        </Item>
      </TimeSeriesInfo></MeteorologicalInfos></Body>`,
    ).Body;
    const fc = extractForecast(synthetic)!;
    expect(fc).not.toBeNull();
    const events = fc.series[0].events;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].code).toBe("019999");
  });
});

describe("extractForecast - Property 複数対応 (同一 metric type の Property 複数) (Codex R1 強2)", () => {
  it("1 Kind に「風の予想」 Property を 2 個持つ場合、両 Property の値が同じ ForecastMetricArea の values に集約され、metricType は一貫する", () => {
    // 同一 metricType ("風の予想") の Property を 2 つ並べた synthetic XML。
    // VPWP50 R1 #4 同様、仕様上ありうるケース (1 Kind 内で同じ metric を別 Property に分割)。
    // なお異なる metric type (風+雨 など) の Property 混在は extractMetricArea が未対応
    // (実電文は別 TimeSeriesInfo で分離される設計のため、混在は仕様上想定外)。
    const synthetic = xmlParser.parse(
      `<Body><MeteorologicalInfos type="予想"><TimeSeriesInfo>
        <TimeDefines>
          <TimeDefine timeId="1"><DateTime>2026-01-01T06:00:00+09:00</DateTime><Duration>PT6H</Duration><Name>6時</Name></TimeDefine>
          <TimeDefine timeId="2"><DateTime>2026-01-01T12:00:00+09:00</DateTime><Duration>PT6H</Duration><Name>12時</Name></TimeDefine>
        </TimeDefines>
        <Item>
          <Kind>
            <Property>
              <Type>風の予想</Type>
              <WindSpeedPart><Base>
                <jmx_eb:WindSpeed type="最大風速" unit="m/s" refID="1">15</jmx_eb:WindSpeed>
              </Base></WindSpeedPart>
            </Property>
            <Property>
              <Type>風の予想</Type>
              <WindSpeedPart><Base>
                <jmx_eb:WindSpeed type="最大風速" unit="m/s" refID="2">20</jmx_eb:WindSpeed>
              </Base></WindSpeedPart>
            </Property>
          </Kind>
          <Area><Name>（東北地方）宮城県</Name><Code>040000</Code></Area>
        </Item>
      </TimeSeriesInfo></MeteorologicalInfos></Body>`,
    ).Body;
    const fc = extractForecast(synthetic)!;
    expect(fc).not.toBeNull();
    expect(fc.series.length).toBe(1);
    const metrics = fc.series[0].metrics;
    expect(metrics.length).toBe(1); // 1 Area
    const m = metrics[0];
    // 2 Property 分の値が両方入っている (locals[0].phases[0].values に集約)
    const basePhaseValues = m.locals[0].phases[0].values;
    expect(basePhaseValues.length).toBe(2);
    // metricType は両 Property で同じ「風の予想」で一貫
    expect(m.metricType).toBe("風の予想");
    const v1 = basePhaseValues.find((v) => v.timeRef === "1")!;
    expect(v1.value).toBe(15);
    expect(v1.subType).toBe("最大風速");
    const v2 = basePhaseValues.find((v) => v.timeRef === "2")!;
    expect(v2.value).toBe(20);
    expect(v2.subType).toBe("最大風速");
  });
});

describe("computeFallback - 行数閾値 (volume guard)", () => {
  const mkSeries = (eventCount: number) => ({
    sourceIndex: 0, element: null, timeDefines: [], intro: [], supplement: [],
    events: Array.from({ length: eventCount }, () => ({
      areaName: "X", regionLabel: null, code: "0", eventType: "", eventName: "",
      sentence: "", timeRef: "1", timeName: null, time: null, duration: null,
    })),
    metrics: [],
  });
  it("≤80=none / ≤200=compactOnly / >200=raw", () => {
    expect(computeFallback([mkSeries(0)])).toBe("none");
    expect(computeFallback([mkSeries(80)])).toBe("none");
    expect(computeFallback([mkSeries(81)])).toBe("compactOnly");
    expect(computeFallback([mkSeries(200)])).toBe("compactOnly"); // 200 は raw 境界の直下
    expect(computeFallback([mkSeries(201)])).toBe("raw");
  });
});

describe("extractForecast - Becoming 連鎖 (4 階層 locals/phases)", () => {
  // Becoming が複数ある場合に ordinal で別 phase に分離されることを固定するテスト
  const becomingParser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", parseTagValue: false,
    isArray: (n) => ["MeteorologicalInfos","MeteorologicalInfo","TimeSeriesInfo","TimeDefine","Item","Kind","Text","Area","Local","Becoming","Property"].includes(n),
  });

  it("Becoming 連鎖 fixture の phases を ordinal 順に別保持する (synthetic/vpfj51_becoming_chain.xml)", () => {
    const xml = readFileSync(join("test/fixtures/synthetic", "vpfj51_becoming_chain.xml"), "utf-8");
    const body = becomingParser.parse(xml).Report.Body;
    const fc = extractForecast(body)!;
    expect(fc).not.toBeNull();
    expect(fc.series.length).toBe(1);
    const metrics = fc.series[0].metrics;
    expect(metrics.length).toBe(1);
    const metric = metrics[0];
    // locals: null (汎用) と "海上" の 2 グループ
    expect(metric.locals.length).toBe(2);

    // null グループ (Base + Becoming "のち" 東 + Becoming "のち" 南)
    const generic = metric.locals.find((l) => l.areaName == null)!;
    expect(generic).not.toBeNull();
    expect(generic.phases.length).toBe(3);
    expect(generic.phases[0].kind).toBe("base");
    expect(generic.phases[0].modifier).toBeNull();
    expect(generic.phases[0].values[0].raw).toBe("北東");
    expect(generic.phases[1].kind).toBe("becoming");
    expect(generic.phases[1].modifier).toBe("のち");
    expect(generic.phases[1].values[0].raw).toBe("東");
    expect(generic.phases[2].kind).toBe("becoming");
    expect(generic.phases[2].modifier).toBe("のち");
    expect(generic.phases[2].values[0].raw).toBe("南");

    // "海上" グループ (Becoming "ときどき" 南東のみ)
    const sea = metric.locals.find((l) => l.areaName === "海上")!;
    expect(sea).not.toBeNull();
    expect(sea.phases.length).toBe(1);
    expect(sea.phases[0].kind).toBe("becoming");
    expect(sea.phases[0].modifier).toBe("ときどき");
    expect(sea.phases[0].values[0].raw).toBe("南東");
  });
});
