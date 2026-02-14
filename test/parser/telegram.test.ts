import { describe, it, expect } from "vitest";
import zlib from "zlib";
import {
  decodeBody,
  parseEarthquakeTelegram,
  parseEewTelegram,
} from "../../src/parser/telegram";
import {
  createMockWsDataMessage,
  readFixture,
  encodeXml,
  FIXTURE_VXSE51_SHINDO,
  FIXTURE_VXSE51_CANCEL,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE53_CANCEL,
  FIXTURE_VXSE53_DRILL_1,
  FIXTURE_VXSE44_S10,
  FIXTURE_VXSE45_S1,
  FIXTURE_VXSE45_S26,
  FIXTURE_VXSE45_CANCEL,
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
