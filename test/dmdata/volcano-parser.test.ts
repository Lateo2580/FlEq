import { describe, it, expect } from "vitest";
import { parseVolcanoTelegram, normalizeVolcanoBodyText, parseAshDistanceKm } from "../../src/dmdata/volcano-parser";
import { parseXml } from "../../src/dmdata/telegram-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VFVO50_ALERT_LV3,
  FIXTURE_VFVO50_ALERT_CONTINUE,
  FIXTURE_VFVO50_ALERT_LOWER,
  FIXTURE_VFVO51_EXTRA,
  FIXTURE_VFVO51_NORMAL,
  FIXTURE_VFVO52_ERUPTION_1,
  FIXTURE_VFSV_MARINE,
  FIXTURE_VFVO53_ASH_REGULAR,
  FIXTURE_VFVO54_ASH_RAPID,
  FIXTURE_VFVO55_ASH_DETAIL,
  FIXTURE_VFVO56_FLASH_1,
  FIXTURE_VFVO60_PLUME,
  FIXTURE_VZVO40_NOTICE,
  createMockWsDataMessageFromXml,
  readFixture,
} from "../helpers/mock-message";

describe("parseVolcanoTelegram", () => {
  // ── VFVO50: 噴火警報・予報 ──

  describe("VFVO50 (噴火警報・予報)", () => {
    it("レベル3引上げをパースできる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LV3);
      const result = parseVolcanoTelegram(msg);

      expect(result).not.toBeNull();
      expect(result!.domain).toBe("volcano");
      expect(result!.kind).toBe("alert");
      expect(result!.type).toBe("VFVO50");
      expect(result!.volcanoName).toBe("浅間山");
      expect(result!.volcanoCode).toBe("306");
      expect(result!.infoType).toBe("発表");

      if (result!.kind === "alert") {
        expect(result!.alertLevel).toBe(3);
        expect(result!.alertLevelCode).toBe("13");
        expect(result!.action).toBe("raise");
        expect(result!.isMarine).toBe(false);
        expect(result!.municipalities.length).toBeGreaterThan(0);
      }
    });

    it("レベル5引上げをパースできる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO50_ALERT_CONTINUE);
      const result = parseVolcanoTelegram(msg);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe("alert");
      if (result!.kind === "alert") {
        expect(result!.volcanoName).toBe("箱根山");
        expect(result!.volcanoCode).toBe("315");
        expect(result!.alertLevel).toBe(5);
        expect(result!.alertLevelCode).toBe("15");
        expect(result!.action).toBe("raise");
      }
    });

    it("レベル1引下げをパースできる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LOWER);
      const result = parseVolcanoTelegram(msg);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe("alert");
      if (result!.kind === "alert") {
        expect(result!.volcanoCode).toBe("350");
        expect(result!.alertLevel).toBe(1);
        expect(result!.alertLevelCode).toBe("11");
        expect(result!.action).toBe("lower");
      }
    });
  });

  // ── VFVO52: 噴火に関する火山観測報 ──

  describe("VFVO52 (噴火に関する火山観測報)", () => {
    it("噴火観測報をパースできる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO52_ERUPTION_1);
      const result = parseVolcanoTelegram(msg);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe("eruption");
      expect(result!.type).toBe("VFVO52");
      expect(result!.volcanoName).toBe("浅間山");

      if (result!.kind === "eruption") {
        expect(result!.phenomenonCode).toBe("52");
        expect(result!.phenomenonName).toContain("噴火");
        expect(result!.isFlashReport).toBe(false);
        expect(result!.eventDateTime).toBe("2020-05-22T14:45:00+09:00");
        expect(result!.craterName).toBeNull();
        // 噴煙高度不明のケース
        expect(result!.plumeHeightUnknown).toBe(true);
        expect(result!.plumeHeight).toBeNull();
        expect(result!.plumeDirection).toBeNull();
      }
    });

    it("ColorPlume があっても高度ノードがなければ欠損として扱う", () => {
      const xml = readFixture(FIXTURE_VFVO52_ERUPTION_1)
        .replace(/<jmx_eb:PlumeHeightAboveCrater\b[^>]*\/>/, "");
      expect(xml).toContain("<ColorPlume>");
      expect(xml).not.toContain("<jmx_eb:PlumeHeightAboveCrater");

      const result = parseVolcanoTelegram(createMockWsDataMessageFromXml(xml, "VFVO52"));
      expect(result?.kind).toBe("eruption");
      if (result?.kind === "eruption") {
        expect(result.plumeHeight).toBeNull();
        expect(result.plumeHeightUnknown).toBe(false);
      }
    });
  });

  // ── VFVO56: 噴火速報 ──

  describe("VFVO56 (噴火速報)", () => {
    it("噴火速報をパースできる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO56_FLASH_1);
      const result = parseVolcanoTelegram(msg);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe("eruption");
      expect(result!.type).toBe("VFVO56");
      expect(result!.volcanoName).toBe("御嶽山");
      expect(result!.volcanoCode).toBe("312");

      if (result!.kind === "eruption") {
        expect(result!.isFlashReport).toBe(true);
        expect(result!.phenomenonCode).toBe("52");
        expect(result!.eventDateTime).toBe("2014-09-27T11:53:00+09:00");
      }
    });
  });

  // ── VFSVii: 火山海上警報 ──

  describe("VFSVii (火山海上警報)", () => {
    it("海上警報をパースできる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFSV_MARINE);
      const result = parseVolcanoTelegram(msg);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe("alert");
      expect(result!.type).toBe("VFSVii");
      expect(result!.volcanoName).toBe("桜島");

      if (result!.kind === "alert") {
        expect(result!.isMarine).toBe(true);
      }
    });
  });

  // ── VFVO51: 火山の状況に関する解説情報 ──

  describe("VFVO51 (火山の状況に関する解説情報)", () => {
    it("通常の解説情報をパースできる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO51_NORMAL);
      const result = parseVolcanoTelegram(msg);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe("text");
      expect(result!.type).toBe("VFVO51");

      if (result!.kind === "text") {
        expect(result!.alertLevel).toBe(2);
        expect(result!.alertLevelCode).toBe("12");
        expect(result!.isExtraordinary).toBe(false);
        expect(result!.bodyText).toBeTruthy();
      }
    });

    it("月例一覧（複数火山）をパースできる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO51_EXTRA);
      const result = parseVolcanoTelegram(msg);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe("text");
      expect(result!.type).toBe("VFVO51");
      if (result!.kind === "text") {
        // 月例一覧は Headline > Information 構造が異なり alertLevel が取れない場合がある
        expect(result!.bodyText).toBeTruthy();
      }
    });
  });

  // ── VFVO53: 降灰予報（定時） ──

  describe("VFVO53 (降灰予報 定時)", () => {
    it("定時降灰予報をパースできる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR);
      const result = parseVolcanoTelegram(msg);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe("ashfall");
      expect(result!.type).toBe("VFVO53");
      expect(result!.volcanoName).toBe("桜島");

      if (result!.kind === "ashfall") {
        expect(result!.subKind).toBe("scheduled");
        expect(result!.ashForecasts.length).toBeGreaterThan(0);
      }
    });

    it("共有 XML parser が先頭ゼロ付き Code 06 を保持する", () => {
      const parsed = parseXml(readFixture(FIXTURE_VFVO53_ASH_REGULAR));

      expect(JSON.stringify(parsed)).toContain('"Code":"06"');
    });
  });

  // ── VFVO54: 降灰予報（速報） ──

  describe("VFVO54 (降灰予報 速報)", () => {
    it("速報降灰予報をパースできる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO54_ASH_RAPID);
      const result = parseVolcanoTelegram(msg);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe("ashfall");
      expect(result!.type).toBe("VFVO54");
      expect(result!.volcanoName).toBe("桜島");

      if (result!.kind === "ashfall") {
        expect(result!.subKind).toBe("rapid");
        expect(result!.ashForecasts.length).toBeGreaterThan(0);
        // 降灰エリアが含まれている
        const allAreas = result!.ashForecasts.flatMap((f) => f.areas);
        expect(allAreas.length).toBeGreaterThan(0);
        // ashCode が設定されている
        expect(allAreas[0].ashCode).toBeTruthy();
        expect(allAreas[0].ashName).toBeTruthy();
      }
    });
  });

  // ── VFVO55: 降灰予報（詳細） ──

  describe("VFVO55 (降灰予報 詳細)", () => {
    it("詳細降灰予報をパースできる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO55_ASH_DETAIL);
      const result = parseVolcanoTelegram(msg);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe("ashfall");
      expect(result!.type).toBe("VFVO55");

      if (result!.kind === "ashfall") {
        expect(result!.subKind).toBe("detailed");
        expect(result!.ashForecasts.length).toBeGreaterThan(0);
        // 複数時間帯のデータがある
        expect(result!.ashForecasts.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  // ── VFVO60: 推定噴煙流向報 ──

  describe("VFVO60 (推定噴煙流向報)", () => {
    it("噴煙流向報をパースできる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO60_PLUME);
      const result = parseVolcanoTelegram(msg);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe("plume");
      expect(result!.type).toBe("VFVO60");
      expect(result!.volcanoName).toBe("桜島");

      if (result!.kind === "plume") {
        expect(result!.phenomenonCode).toBe("51");
        expect(result!.plumeHeight).toBe(1800);
        expect(result!.plumeDirection).toBe("南東");
        expect(result!.windProfile.length).toBeGreaterThan(0);
      }
    });
  });

  // ── VZVO40: 火山に関するお知らせ ──

  describe("VZVO40 (火山に関するお知らせ)", () => {
    it("お知らせをパースできる", () => {
      const msg = createMockWsDataMessage(FIXTURE_VZVO40_NOTICE);
      const result = parseVolcanoTelegram(msg);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe("text");
      expect(result!.type).toBe("VZVO40");

      if (result!.kind === "text") {
        expect(result!.bodyText).toBeTruthy();
        expect(result!.isExtraordinary).toBe(false);
        expect(result!.alertLevel).toBeNull();
      }
    });
  });

  // ── 共通フィールド ──

  describe("共通フィールド", () => {
    it("domain が 'volcano' に設定される", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LV3);
      const result = parseVolcanoTelegram(msg);
      expect(result!.domain).toBe("volcano");
    });

    it("reportDateTime が設定される", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LV3);
      const result = parseVolcanoTelegram(msg);
      expect(result!.reportDateTime).toBeTruthy();
    });

    it("coordinate が設定される (火山情報)", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LV3);
      const result = parseVolcanoTelegram(msg);
      expect(result!.coordinate).toBeTruthy();
    });
  });

  // ── normalizeVolcanoBodyText ──

  describe("normalizeVolcanoBodyText", () => {
    it("行頭ラベル内の全角スペースを除去する", () => {
      expect(normalizeVolcanoBodyText("火　山：浅間山")).toBe("火山：浅間山");
      expect(normalizeVolcanoBodyText("日　時：2024年")).toBe("日時：2024年");
    });

    it("連続する全角スペースはラベル内のみ除去する", () => {
      expect(normalizeVolcanoBodyText("火\u3000\u3000山：浅間山")).toBe("火山：浅間山");
      expect(normalizeVolcanoBodyText("日\u3000\u3000時：2024年")).toBe("日時：2024年");
    });

    it("コロンのない行の全角スペースは保持する", () => {
      // 市町村区切りの全角スペースは保持
      expect(normalizeVolcanoBodyText("鹿児島市\u3000日置市\u3000いちき串木野市")).toBe("鹿児島市\u3000日置市\u3000いちき串木野市");
      expect(normalizeVolcanoBodyText("あ\u3000\u3000い")).toBe("あ\u3000\u3000い");
    });

    it("空文字列を安全に処理する", () => {
      expect(normalizeVolcanoBodyText("")).toBe("");
    });

    it("VFVO52 の bodyText に「火　山」が含まれない", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO52_ERUPTION_1);
      const result = parseVolcanoTelegram(msg);
      expect(result).not.toBeNull();
      if (result!.kind === "eruption" && result!.bodyText) {
        expect(result!.bodyText).not.toContain("火\u3000山");
      }
    });
  });

  describe("降灰予報の方向・距離抽出 (Spec A §3-1)", () => {
    it("PlumeDirection の description と Distance(km) を AshArea に取り込む", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR);
      const info = parseVolcanoTelegram(msg)!;
      expect(info.kind).toBe("ashfall");
      if (info.kind !== "ashfall") return;
      const areas = info.ashForecasts.flatMap((f) => f.areas);
      const ashArea = areas.find((a) => a.ashName === "降灰");
      expect(ashArea?.plumeDirection).toBe("東（鹿屋市輝北方向）");
      expect(ashArea?.distanceKm).toBe(100);
      const rock = areas.find((a) => a.ashName === "小さな噴石の落下");
      expect(rock?.distanceKm).toBe(5);
    });

    it("Distance は unit=km のときだけ採用する (m・unit欠落・非数値は null)", () => {
      expect(parseAshDistanceKm({ "@_unit": "km", "#text": "100" })).toBe(100);
      expect(parseAshDistanceKm({ "@_unit": "m", "#text": "100" })).toBeNull(); // km 以外
      expect(parseAshDistanceKm({ "#text": "100" })).toBeNull();               // unit 欠落
      expect(parseAshDistanceKm("100")).toBeNull();                            // primitive (unit なし)
      expect(parseAshDistanceKm({ "@_unit": "km", "#text": "abc" })).toBeNull(); // 非数値
      expect(parseAshDistanceKm(null)).toBeNull();
      expect(parseAshDistanceKm({ "@_unit": "km", "#text": "100abc" })).toBeNull(); // parseFloat の緩さで 100 に化けない
      expect(parseAshDistanceKm({ "@_unit": "km", "#text": "Infinity" })).toBeNull(); // 非有限値
    });
  });
});
