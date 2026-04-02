import { describe, it, expect } from "vitest";
import zlib from "zlib";
import {
  decodeBody,
  parseEarthquakeTelegram,
  parseEewTelegram,
  parseTsunamiTelegram,
  parseSeismicTextTelegram,
  parseNankaiTroughTelegram,
  parseLgObservationTelegram,
} from "../../src/dmdata/telegram-parser";
import {
  createMockWsDataMessage,
  readFixture,
  encodeXml,
  FIXTURE_VXSE51_SHINDO,
  FIXTURE_VXSE51_CANCEL,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE53_CANCEL,
  FIXTURE_VXSE53_DRILL_1,
  FIXTURE_VXSE52_HYPO_1,
  FIXTURE_VXSE56_ACTIVITY_1,
  FIXTURE_VXSE60_1,
  FIXTURE_VXSE60_CANCEL,
  FIXTURE_VXSE61_1,
  FIXTURE_VXSE61_CANCEL,
  FIXTURE_VTSE41_WARN,
  FIXTURE_VTSE41_CANCEL,
  FIXTURE_VTSE51_INFO,
  FIXTURE_VTSE52_OFFSHORE,
  FIXTURE_VXSE43_WARNING_S1,
  FIXTURE_VXSE44_S10,
  FIXTURE_VXSE45_S1,
  FIXTURE_VXSE45_S26,
  FIXTURE_VXSE45_CANCEL,
  FIXTURE_VXSE45_PLUM,
  FIXTURE_VXSE45_MIXED,
  FIXTURE_VZSE40_NOTICE,
  FIXTURE_VZSE40_CANCEL,
  FIXTURE_VYSE50_INVESTIGATION,
  FIXTURE_VYSE50_ALERT,
  FIXTURE_VYSE50_CAUTION,
  FIXTURE_VYSE50_CLOSED,
  FIXTURE_VYSE50_CANCEL,
  FIXTURE_VYSE51_ADVISORY,
  FIXTURE_VYSE52_REGULAR,
  FIXTURE_VXSE62_LGOBS,
  FIXTURE_VYSE60_AFTERSHOCK,
} from "../helpers/mock-message";

// ── decodeBody ──

describe("decodeBody", () => {
  it("gzip+base64 エンコードされたデータを正しくデコードする", () => {
    const original = "<Report>テストデータ</Report>";
    const compressed = zlib.gzipSync(Buffer.from(original, "utf-8"));
    const encoded = compressed.toString("base64");

    const msg = createMockWsDataMessage(FIXTURE_VXSE51_SHINDO, {
      body: encoded,
      compression: "gzip",
      encoding: "base64",
    });

    const result = decodeBody(msg);
    expect(result).toBe(original);
  });

  it("非圧縮・utf-8 のデータをそのまま返す", () => {
    const original = "<Report>テスト</Report>";
    const msg = createMockWsDataMessage(FIXTURE_VXSE51_SHINDO, {
      body: original,
      compression: null,
      encoding: "utf-8",
    });

    const result = decodeBody(msg);
    expect(result).toBe(original);
  });
});

// ── parseEarthquakeTelegram ──

describe("parseEarthquakeTelegram", () => {
  describe("VXSE51 震度速報", () => {
    it("最大震度と地域別震度を正しく抽出する", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE51_SHINDO, {
        head: {
          type: "VXSE51",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEarthquakeTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("VXSE51");
      expect(result!.infoType).toBe("発表");
      expect(result!.title).toBe("震度速報");

      // 震度情報の検証
      expect(result!.intensity).toBeDefined();
      expect(result!.intensity!.maxInt).toBe("4");

      // 地域が含まれている
      const areaNames = result!.intensity!.areas.map((a) => a.name);
      expect(areaNames).toContain("岩手県沿岸南部");
      expect(areaNames).toContain("宮城県北部");

      // 震度4の地域を確認
      const int4Areas = result!.intensity!.areas.filter(
        (a) => a.intensity === "4"
      );
      expect(int4Areas.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("VXSE53 遠地地震情報", () => {
    it("震源名・マグニチュード・津波コメントを正しく抽出する", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI, {
        head: {
          type: "VXSE53",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEarthquakeTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("VXSE53");
      expect(result!.title).toBe("遠地地震に関する情報");
      expect(result!.infoType).toBe("発表");

      // 震源情報
      expect(result!.earthquake).toBeDefined();
      expect(result!.earthquake!.hypocenterName).toBe("南太平洋");
      expect(result!.earthquake!.magnitude).toBe("7.1");

      // 座標 (南緯17.2度 東経178.6度 深さ570km)
      expect(result!.earthquake!.latitude).toBe("S17.2");
      expect(result!.earthquake!.longitude).toBe("E178.6");
      expect(result!.earthquake!.depth).toBe("570km");

      // 津波
      expect(result!.tsunami).toBeDefined();
      expect(result!.tsunami!.text).toContain("津波の心配はありません");
    });
  });

  describe("VXSE53 震源・震度情報 (訓練)", () => {
    it("震源座標・深さ・マグニチュード・震度観測を抽出する", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE53_DRILL_1, {
        head: {
          type: "VXSE53",
          author: "気象庁",
          time: new Date().toISOString(),
          test: true,
        },
      });

      const result = parseEarthquakeTelegram(msg);
      expect(result).not.toBeNull();

      // 震源情報
      expect(result!.earthquake).toBeDefined();

      // 震度情報
      expect(result!.intensity).toBeDefined();
      expect(result!.intensity!.areas.length).toBeGreaterThan(0);
    });
  });

  describe("VXSE52 震源に関する情報", () => {
    it("震源情報は抽出され、震度情報は含まれない", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE52_HYPO_1, {
        head: {
          type: "VXSE52",
          author: "気象庁",
          time: new Date().toISOString(),
          test: true,
        },
      });

      const result = parseEarthquakeTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("VXSE52");
      expect(result!.earthquake).toBeDefined();
      expect(result!.earthquake!.hypocenterName).toBe("駿河湾");
      expect(result!.earthquake!.magnitude).toBe("6.6");
      expect(result!.intensity).toBeUndefined();
    });
  });

  describe("VXSE61 震源要素更新", () => {
    it("震源要素更新の発表電文をパースできる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE61_1, {
        head: {
          type: "VXSE61",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEarthquakeTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("VXSE61");
      expect(result!.earthquake).toBeDefined();
      expect(result!.earthquake!.hypocenterName).toBe("駿河湾");
      expect(result!.earthquake!.magnitude).toBe("6.5");
    });

    it("複数 Coordinate ノード (十進度+度分) から十進度を正しく抽出する", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE61_1, {
        head: {
          type: "VXSE61",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEarthquakeTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.earthquake).toBeDefined();
      expect(result!.earthquake!.latitude).toBe("N34.8");
      expect(result!.earthquake!.longitude).toBe("E138.5");
      expect(result!.earthquake!.depth).toBe("20km");
    });

    it("取消電文の InfoType=取消 を取得できる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE61_CANCEL, {
        head: {
          type: "VXSE61",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEarthquakeTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.infoType).toBe("取消");
    });
  });

  describe("VXSE51 取消報", () => {
    it("InfoType=取消 が正しく反映される", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE51_CANCEL, {
        head: {
          type: "VXSE51",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEarthquakeTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.infoType).toBe("取消");
      expect(result!.headline).toContain("取り消します");
    });
  });

  describe("eventId 抽出", () => {
    it("VXSE52 で EventID が取得できる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE52_HYPO_1, {
        head: { type: "VXSE52", author: "気象庁", time: new Date().toISOString(), test: false },
      });
      const result = parseEarthquakeTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.eventId).toBe("20091001134500");
    });

    it("VXSE53 で EventID が取得できる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI, {
        head: { type: "VXSE53", author: "気象庁", time: new Date().toISOString(), test: false },
      });
      const result = parseEarthquakeTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.eventId).toBeDefined();
      expect(typeof result!.eventId).toBe("string");
    });

    it("VXSE61 で EventID が取得できる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE61_1, {
        head: { type: "VXSE61", author: "気象庁", time: new Date().toISOString(), test: false },
      });
      const result = parseEarthquakeTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.eventId).toBe("20090811050711");
    });
  });

  describe("VXSE53 取消報", () => {
    it("InfoType=取消 が正しく反映される", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE53_CANCEL, {
        head: {
          type: "VXSE53",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEarthquakeTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.infoType).toBe("取消");
      expect(result!.headline).toContain("取り消します");
    });
  });
});

// ── parseEewTelegram ──

describe("parseEewTelegram", () => {
  describe("VXSE43 EEW警報", () => {
    it("警報区分としてパースされる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1, {
        head: {
          type: "VXSE43",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("VXSE43");
      expect(result!.isWarning).toBe(true);
      expect(result!.earthquake).toBeDefined();
      expect(result!.earthquake!.hypocenterName).toBe("豊後水道");
      expect(result!.earthquake!.magnitude).toBe("5.8");
      expect(result!.forecastIntensity).toBeDefined();
      expect(result!.forecastIntensity!.areas.length).toBeGreaterThan(1);
    });

    it("長周期地震動階級 (ForecastLgInt) を抽出する", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1, {
        head: {
          type: "VXSE43",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();

      // 全体の最大予測長周期地震動階級
      expect(result!.forecastIntensity!.maxLgInt).toBe("1");

      // 各地域の長周期地震動階級
      const oitaChubu = result!.forecastIntensity!.areas.find(
        (a) => a.name === "大分県中部"
      );
      expect(oitaChubu).toBeDefined();
      expect(oitaChubu!.lgIntensity).toBe("1");

      // 長周期地震動階級 0 の地域は lgIntensity が省略されないことを確認
      const ehimeNanyo = result!.forecastIntensity!.areas.find(
        (a) => a.name === "愛媛県南予"
      );
      expect(ehimeNanyo).toBeDefined();
      // "0" は truthy なので設定される
      expect(ehimeNanyo!.lgIntensity).toBe("0");
    });
  });

  describe("VXSE44 EEW予報", () => {
    it("EventID・Serial・震源・予測震度リストを抽出する", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE44_S10, {
        classification: "eew.forecast",
        head: {
          type: "VXSE44",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("VXSE44");
      expect(result!.eventId).toBe("20240417231454");
      expect(result!.serial).toBe("10");
      expect(result!.infoType).toBe("発表");

      // 震源
      expect(result!.earthquake).toBeDefined();
      expect(result!.earthquake!.hypocenterName).toBe("豊後水道");
      expect(result!.earthquake!.magnitude).toBe("6.5");

      // 予測震度
      expect(result!.forecastIntensity).toBeDefined();
      expect(result!.forecastIntensity!.areas.length).toBeGreaterThan(0);

      // 予測震度に愛媛県南予が含まれる
      const areaNames = result!.forecastIntensity!.areas.map((a) => a.name);
      expect(areaNames).toContain("愛媛県南予");
    });
  });

  describe("VXSE45 EEW地震動予報 (初報)", () => {
    it("Serial=1 の初報を正しくパースする", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_S1, {
        classification: "eew.forecast",
        head: {
          type: "VXSE45",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("VXSE45");
      expect(result!.serial).toBe("1");
      expect(result!.eventId).toBe("20240417231454");

      // M4.2
      expect(result!.earthquake).toBeDefined();
      expect(result!.earthquake!.magnitude).toBe("4.2");
      expect(result!.earthquake!.hypocenterName).toBe("豊後水道");
      expect(result!.earthquake!.depth).toBe("40km");
    });
  });

  describe("VXSE45 後続報 (Serial=26)", () => {
    it("マグニチュード更新と高い予測震度を取得する", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_S26, {
        classification: "eew.forecast",
        head: {
          type: "VXSE45",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.serial).toBe("26");

      // M6.7 に更新
      expect(result!.earthquake!.magnitude).toBe("6.7");
      expect(result!.earthquake!.depth).toBe("50km");

      // 予測震度 6弱 の地域がある
      expect(result!.forecastIntensity).toBeDefined();
      const areas = result!.forecastIntensity!.areas;
      const maxIntAreas = areas.filter((a) => a.intensity === "6-");
      expect(maxIntAreas.length).toBeGreaterThan(0);
    });
  });

  describe("VXSE45 取消報", () => {
    it("InfoType=取消 を正しく検出する", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_CANCEL, {
        classification: "eew.forecast",
        head: {
          type: "VXSE45",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.infoType).toBe("取消");
      expect(result!.serial).toBe("32");
      expect(result!.eventId).toBe("20240417231454");
    });
  });

  describe("PLUM法・仮定震源要素", () => {
    it("仮定震源要素を検出する", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_PLUM, {
        classification: "eew.forecast",
        head: {
          type: "VXSE45",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.isAssumedHypocenter).toBe(true);
    });

    it("PLUM法地域を検出する", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_PLUM, {
        classification: "eew.forecast",
        head: {
          type: "VXSE45",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.forecastIntensity).toBeDefined();

      const noto = result!.forecastIntensity!.areas.find((a) => a.name === "石川県能登");
      expect(noto).toBeDefined();
      expect(noto!.isPlum).toBe(true);
    });

    it("既到達Conditionを検出する", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_PLUM, {
        classification: "eew.forecast",
        head: {
          type: "VXSE45",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();

      const toyama = result!.forecastIntensity!.areas.find((a) => a.name === "富山県東部");
      expect(toyama).toBeDefined();
      expect(toyama!.hasArrived).toBe(true);
    });

    it("MaxIntChangeReason をパースする", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_PLUM, {
        classification: "eew.forecast",
        head: {
          type: "VXSE45",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.maxIntChangeReason).toBe(9);
    });

    it("falls back to assumed hypocenter when condition is missing but PLUM signals exist", () => {
      const xml = readFixture(FIXTURE_VXSE45_PLUM)
        .replace(/<Condition>仮定震源要素<\/Condition>/, "");

      const msg = createMockWsDataMessage(FIXTURE_VXSE45_PLUM, {
        classification: "eew.forecast",
        head: {
          type: "VXSE45",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });
      msg.body = encodeXml(xml);

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.maxIntChangeReason).toBe(9);
      expect(result!.isAssumedHypocenter).toBe(true);
    });

    it("does not mis-detect assumed hypocenter from M1.0 + 10km alone", () => {
      const xml = readFixture(FIXTURE_VXSE45_S1)
        .replace(">4.2<", ">1.0<")
        .replace("-40000/", "-10000/");

      const msg = createMockWsDataMessage(FIXTURE_VXSE45_S1, {
        classification: "eew.forecast",
        head: {
          type: "VXSE45",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });
      msg.body = encodeXml(xml);

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.earthquake!.magnitude).toBe("1.0");
      expect(result!.earthquake!.depth).toBe("10km");
      expect(result!.maxIntChangeReason).toBeUndefined();
      expect(result!.isAssumedHypocenter).toBe(false);
    });

    it("detects PLUM and arrived conditions with normalized text", () => {
      const xml = readFixture(FIXTURE_VXSE45_PLUM)
        .replace(
          "<Condition>ＰＬＵＭ法で推定</Condition>",
          "<Condition> PLUM 法 で 推定 </Condition>"
        )
        .replace(
          "<Condition>既に主要動到達と推測</Condition>",
          "<Condition> 既に 主要動 到達 と推測 </Condition>"
        );

      const msg = createMockWsDataMessage(FIXTURE_VXSE45_PLUM, {
        classification: "eew.forecast",
        head: {
          type: "VXSE45",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });
      msg.body = encodeXml(xml);

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();

      const noto = result!.forecastIntensity!.areas.find((a) => a.name === "石川県能登");
      expect(noto).toBeDefined();
      expect(noto!.isPlum).toBe(true);

      const toyama = result!.forecastIntensity!.areas.find((a) => a.name === "富山県東部");
      expect(toyama).toBeDefined();
      expect(toyama!.hasArrived).toBe(true);
    });

    it("混合電文で通常推定地域とPLUM法地域を区別する", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_MIXED, {
        classification: "eew.forecast",
        head: {
          type: "VXSE45",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.isAssumedHypocenter).toBe(false);

      const areas = result!.forecastIntensity!.areas;

      // 通常推定地域
      const noto = areas.find((a) => a.name === "石川県能登");
      expect(noto).toBeDefined();
      expect(noto!.isPlum).toBeUndefined();

      // PLUM法地域
      const toyamaE = areas.find((a) => a.name === "富山県東部");
      expect(toyamaE).toBeDefined();
      expect(toyamaE!.isPlum).toBe(true);

      // 既到達地域
      const toyamaW = areas.find((a) => a.name === "富山県西部");
      expect(toyamaW).toBeDefined();
      expect(toyamaW!.hasArrived).toBe(true);
    });

    it("通常電文で isAssumedHypocenter: false であることを確認する", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_S1, {
        classification: "eew.forecast",
        head: {
          type: "VXSE45",
          author: "気象庁",
          time: new Date().toISOString(),
          test: false,
        },
      });

      const result = parseEewTelegram(msg);
      expect(result).not.toBeNull();
      expect(result!.isAssumedHypocenter).toBe(false);
      expect(result!.maxIntChangeReason).toBeUndefined();
    });
  });

  // isWarning 判定の網羅状況:
  // - head.type === "VXSE43" → VXSE43 テストでカバー
  // - hasWarningAreaKind (Area Kind Code 10-19) → VXSE45 S26 / VXSE44 テストでカバー
  // - hasWarningHeadlineCode (Headline Code=31) → VXSE45 S26 が該当するが
  //   hasWarningAreaKind の短絡評価で先に true になるため単独パスは未検証。
  //   専用フィクスチャ (Headline Code=31 のみ、Area Kind なし) が必要
  // - classification フォールバック → VXSE45 S1 + eew.warning テストでカバー
  describe("isWarning XML ベース判定", () => {
    it("VXSE43 は head.type から isWarning=true", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
      const result = parseEewTelegram(msg);
      expect(result!.isWarning).toBe(true);
    });

    it("VXSE45 S26 (警報地域あり) は isWarning=true", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_S26);
      const result = parseEewTelegram(msg);
      expect(result!.isWarning).toBe(true);
    });

    it("VXSE45 S1 (警報地域なし) は isWarning=false", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_S1);
      const result = parseEewTelegram(msg);
      expect(result!.isWarning).toBe(false);
    });

    it("VXSE44 (警報地域あり) は XML から isWarning=true", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE44_S10);
      const result = parseEewTelegram(msg);
      expect(result!.isWarning).toBe(true);
    });

    it("classification=eew.warning でも XML で確認できない場合はフォールバックで true", () => {
      const msg = createMockWsDataMessage(FIXTURE_VXSE45_S1, {
        classification: "eew.warning",
      });
      const result = parseEewTelegram(msg);
      expect(result!.isWarning).toBe(true);
    });
  });
});

// ── parseSeismicTextTelegram ──

describe("parseSeismicTextTelegram", () => {
  it("VXSE56 地震活動情報の本文を抽出できる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE56_ACTIVITY_1, {
      head: {
        type: "VXSE56",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseSeismicTextTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("VXSE56");
    expect(result!.headline).toBeTruthy();
    expect(result!.bodyText).toContain("伊豆東部");
    expect(result!.bodyText.length).toBeGreaterThan(100);
  });

  it("VXSE60 取消電文の InfoType=取消 を取得できる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE60_CANCEL, {
      head: {
        type: "VXSE60",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseSeismicTextTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("VXSE60");
    expect(result!.infoType).toBe("取消");
  });

  it("VXSE60 発表電文をパースできる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE60_1, {
      head: {
        type: "VXSE60",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseSeismicTextTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.headline).toContain("地震回数に関する情報");
  });
});

// ── parseTsunamiTelegram ──

describe("parseTsunamiTelegram", () => {
  it("VTSE41 津波警報をパースできる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VTSE41_WARN, {
      head: {
        type: "VTSE41",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseTsunamiTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("VTSE41");
    expect(result!.forecast).toBeDefined();
    expect(result!.forecast!.some((item) => item.kind.includes("大津波警報"))).toBe(true);
    expect(result!.forecast![0].maxHeightDescription).toBe("巨大");
  });

  it("VTSE41 取消電文の InfoType=取消 を取得できる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VTSE41_CANCEL, {
      head: {
        type: "VTSE41",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseTsunamiTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.infoType).toBe("取消");
  });

  it("VTSE51 津波情報をパースできる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VTSE51_INFO, {
      head: {
        type: "VTSE51",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseTsunamiTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.forecast).toBeDefined();
    expect(result!.forecast!.length).toBeGreaterThan(0);
  });

  it("VTSE52 沖合津波情報をパースできる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VTSE52_OFFSHORE, {
      head: {
        type: "VTSE52",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseTsunamiTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.observations).toBeDefined();
    expect(result!.observations!.length).toBeGreaterThan(0);
    expect(result!.observations!.some((obs) => obs.sensor === "ＧＰＳ波浪計")).toBe(true);
    expect(result!.estimations).toBeDefined();
    expect(result!.estimations!.length).toBeGreaterThan(0);
  });
});

// ── ユーティリティ関数 (parseCoordinate を間接テスト) ──

describe("座標パース (parseCoordinate)", () => {
  it("北緯・東経・深さを正しくパースする", () => {
    // VXSE44 (豊後水道 +33.2+132.4-40000/) から確認
    const msg = createMockWsDataMessage(FIXTURE_VXSE44_S10, {
      classification: "eew.forecast",
      head: {
        type: "VXSE44",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseEewTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.earthquake!.latitude).toBe("N33.2");
    expect(result!.earthquake!.longitude).toBe("E132.4");
    expect(result!.earthquake!.depth).toBe("40km");
  });

  it("南緯・東経の座標を正しくパースする", () => {
    // VXSE53 遠地 (-17.2+178.6-570000/)
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI, {
      head: {
        type: "VXSE53",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseEarthquakeTelegram(msg);
    expect(result!.earthquake!.latitude).toBe("S17.2");
    expect(result!.earthquake!.longitude).toBe("E178.6");
    expect(result!.earthquake!.depth).toBe("570km");
  });
});

// ── parseSeismicTextTelegram (VZSE40) ──

describe("parseSeismicTextTelegram (VZSE40)", () => {
  it("VZSE40 お知らせ電文の本文を抽出できる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VZSE40_NOTICE, {
      head: {
        type: "VZSE40",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseSeismicTextTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("VZSE40");
    expect(result!.infoType).toBe("発表");
    expect(result!.bodyText).toContain("沖縄県");
  });

  it("VZSE40 取消電文の InfoType=取消 を取得できる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VZSE40_CANCEL, {
      head: {
        type: "VZSE40",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseSeismicTextTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.infoType).toBe("取消");
  });
});

// ── parseNankaiTroughTelegram ──

describe("parseNankaiTroughTelegram", () => {
  it("VYSE50 調査中 (Code=111) をパースできる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE50_INVESTIGATION, {
      head: {
        type: "VYSE50",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseNankaiTroughTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("VYSE50");
    expect(result!.infoType).toBe("発表");
    expect(result!.infoSerial).toBeDefined();
    expect(result!.infoSerial!.code).toBe("111");
    expect(result!.infoSerial!.name).toBe("調査中");
    expect(result!.bodyText).toContain("南海トラフ地震");
    expect(result!.nextAdvisory).toBeDefined();
    expect(result!.nextAdvisory).toContain("南海トラフ地震臨時情報");
  });

  it("VYSE50 巨大地震警戒 (Code=120) をパースできる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE50_ALERT, {
      head: {
        type: "VYSE50",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseNankaiTroughTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.infoSerial!.code).toBe("120");
    expect(result!.infoSerial!.name).toBe("巨大地震警戒");
  });

  it("VYSE50 巨大地震注意 (Code=130) をパースできる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE50_CAUTION, {
      head: {
        type: "VYSE50",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseNankaiTroughTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.infoSerial!.code).toBe("130");
    expect(result!.infoSerial!.name).toBe("巨大地震注意");
  });

  it("VYSE50 調査終了 (Code=190) をパースできる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE50_CLOSED, {
      head: {
        type: "VYSE50",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseNankaiTroughTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.infoSerial!.code).toBe("190");
    expect(result!.infoSerial!.name).toBe("調査終了");
  });

  it("VYSE50 取消電文をパースできる (EarthquakeInfo なし)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE50_CANCEL, {
      head: {
        type: "VYSE50",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseNankaiTroughTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.infoType).toBe("取消");
    expect(result!.infoSerial).toBeUndefined();
    expect(result!.bodyText).toContain("取り消します");
  });

  it("VYSE51 臨時解説情報 (Code=210) をパースできる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE51_ADVISORY, {
      head: {
        type: "VYSE51",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseNankaiTroughTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("VYSE51");
    expect(result!.infoSerial!.code).toBe("210");
  });

  it("VYSE52 定例解説情報 (Code=200) をパースできる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE52_REGULAR, {
      head: {
        type: "VYSE52",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseNankaiTroughTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("VYSE52");
    expect(result!.infoSerial!.code).toBe("200");
  });

  it("VYSE60 後発地震注意情報をパースできる (InfoSerial なし)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VYSE60_AFTERSHOCK, {
      head: {
        type: "VYSE60",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseNankaiTroughTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("VYSE60");
    expect(result!.infoSerial).toBeUndefined();
    expect(result!.bodyText).toContain("三陸沖");
  });
});

// ── parseLgObservationTelegram ──

describe("parseLgObservationTelegram", () => {
  it("VXSE62 長周期地震動観測情報をパースできる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE62_LGOBS, {
      head: {
        type: "VXSE62",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseLgObservationTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("VXSE62");
    expect(result!.infoType).toBe("発表");
    expect(result!.title).toBe("長周期地震動に関する観測情報");
  });

  it("震源情報を抽出する", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE62_LGOBS, {
      head: {
        type: "VXSE62",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseLgObservationTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.earthquake).toBeDefined();
    expect(result!.earthquake!.hypocenterName).toBe("岩手県沖");
    expect(result!.earthquake!.magnitude).toBe("6.3");
  });

  it("最大長周期地震動階級と最大震度を抽出する", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE62_LGOBS, {
      head: {
        type: "VXSE62",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseLgObservationTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.maxLgInt).toBe("3");
    expect(result!.maxInt).toBe("5-");
    expect(result!.lgCategory).toBe("4");
  });

  it("地域別の長周期地震動階級を抽出する", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE62_LGOBS, {
      head: {
        type: "VXSE62",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseLgObservationTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.areas.length).toBeGreaterThan(0);

    // 宮城県北部が長周期階級3
    const miyagi = result!.areas.find((a) => a.name === "宮城県北部");
    expect(miyagi).toBeDefined();
    expect(miyagi!.maxLgInt).toBe("3");
    expect(miyagi!.maxInt).toBe("4");
  });

  it("コメントとURIを抽出する", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE62_LGOBS, {
      head: {
        type: "VXSE62",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
      },
    });

    const result = parseLgObservationTelegram(msg);
    expect(result).not.toBeNull();
    expect(result!.comment).toBeDefined();
    expect(result!.comment).toContain("長周期地震動階級");
    expect(result!.detailUri).toBeDefined();
    expect(result!.detailUri).toContain("https://");
  });
});
