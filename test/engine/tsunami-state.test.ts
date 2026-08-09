import { testTelegramMeta } from "../helpers/telegram-meta";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TsunamiStateHolder } from "../../src/engine/messages/tsunami-state";
import { ParsedTsunamiInfo } from "../../src/types";
import {
  canonicalizeLegacyTsunamiInfo,
  type LegacyTsunamiForecastItemInput,
  type LegacyParsedTsunamiInfoInput,
} from "../../src/dmdata/tsunami-legacy-adapter";
import { createTelegramMeta } from "../../src/dmdata/telegram-meta";

// sound-player をモック
vi.mock("../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

/** テスト用の ParsedTsunamiInfo を生成する */
function createTsunamiInfo(
  overrides: Partial<LegacyParsedTsunamiInfoInput> = {}
): ParsedTsunamiInfo {
  const normalizedForecast = overrides.forecast?.map((item, index) => {
    const { areaCode, kindCode, ...rest } = item;
    return {
      ...rest,
      areaCode: areaCode === undefined ? `test-area-${index}` : areaCode,
      kindCode: kindCode === undefined ? `test-kind-${index}` : kindCode,
    };
  });
  return canonicalizeLegacyTsunamiInfo({
    meta: testTelegramMeta(false),
    type: "VTSE41",
    infoType: "発表",
    title: "津波警報・注意報・予報",
    reportDateTime: "2025-01-01T00:00:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    forecast: [],
    warningComment: "",
    isTest: false,
    ...overrides,
    ...(normalizedForecast === undefined ? {} : { forecast: normalizedForecast }),
  });
}

function eventInfo(
  eventId: string,
  forecast: LegacyTsunamiForecastItemInput[],
  reportDateTime = "2025-01-01T00:00:00+09:00",
): ParsedTsunamiInfo {
  return createTsunamiInfo({
    meta: createTelegramMeta({
      messageId: `${eventId}:${reportDateTime}`,
      eventId,
      type: "VTSE41",
      reportDateTime,
      serial: null,
      infoType: "発表",
      receivedAtMs: Date.parse(reportDateTime),
      status: "通常",
      isTest: false,
    }),
    reportDateTime,
    forecast,
  });
}

function forecast(
  areaCode: string | null,
  kindCode: string | null,
  areaName: string,
  kind = "津波警報",
): LegacyTsunamiForecastItemInput {
  return {
    areaCode,
    kindCode,
    areaName,
    kind,
    maxHeightDescription: "3m",
    firstHeight: "到達中と推測",
  };
}

describe("TsunamiStateHolder", () => {
  let holder: TsunamiStateHolder;

  beforeEach(() => {
    holder = new TsunamiStateHolder();
  });

  describe("accepted mutation", () => {
    it("同コードの名称変更は同じ keyed state を表示名だけ更新する", () => {
      holder.applyAccepted(eventInfo("event-a", [forecast("101", "51", "旧名称")]));
      holder.applyAccepted(eventInfo(
        "event-a",
        [forecast("101", "51", "新名称")],
        "2025-01-01T00:01:00+09:00",
      ));

      expect(holder.getLastInfo()?.forecast).toEqual([
        expect.objectContaining({ areaCode: "101", kindCode: "51", areaName: "新名称" }),
      ]);
    });

    it("同名でも異なるコードは別 keyed state として並存する", () => {
      holder.applyAccepted(eventInfo("event-a", [
        forecast("101", "51", "同名区域"),
        forecast("102", "51", "同名区域"),
      ]));

      expect(holder.getLastInfo()?.forecast?.map((item) => item.areaCode).sort())
        .toEqual(["101", "102"]);
    });

    it("コード欠落 item は fail-open 表示しても既存 keyed state を置換・解除しない", () => {
      holder.applyAccepted(eventInfo("event-a", [forecast("101", "51", "維持対象")]));
      holder.applyAccepted(eventInfo(
        "event-a",
        [forecast(null, null, "コード欠落")],
        "2025-01-01T00:01:00+09:00",
      ));

      expect(holder.getLevel()).toBe("津波警報");
      expect(holder.getLastInfo()?.forecast).toEqual([
        expect.objectContaining({ areaCode: "101", kindCode: "51", areaName: "維持対象" }),
      ]);
      expect(holder.getPersistedActive()?.forecast).toEqual([
        expect.objectContaining({ areaCode: "101", kindCode: "51", areaName: "維持対象" }),
      ]);
    });

    it("keyed・unkeyed 混在後続報は keyed 分だけ更新し、照合不能な旧 state を維持する", () => {
      holder.applyAccepted(eventInfo("event-a", [
        forecast("101", "51", "更新対象"),
        forecast("102", "51", "維持対象"),
      ]));

      holder.applyAccepted(eventInfo(
        "event-a",
        [
          forecast("101", "51", "更新後"),
          forecast(null, null, "コード欠落"),
        ],
        "2025-01-01T00:01:00+09:00",
      ));

      expect(holder.getLastInfo()?.forecast).toEqual([
        expect.objectContaining({ areaCode: "101", areaName: "更新後" }),
        expect.objectContaining({ areaCode: "102", areaName: "維持対象" }),
      ]);
    });

    it("取消は EventID 内のコード keyed state だけを解除する", () => {
      holder.applyAccepted(eventInfo("event-a", [forecast("101", "51", "同名区域")]));
      holder.applyAccepted(eventInfo(
        "event-b",
        [forecast("102", "51", "同名区域")],
        "2025-01-01T00:01:00+09:00",
      ));
      const cancellation = eventInfo("event-a", [], "2025-01-01T00:02:00+09:00");
      holder.clearAccepted(cancellation);

      expect(holder.getLastInfo()?.forecast).toEqual([
        expect.objectContaining({ areaCode: "102", kindCode: "51", areaName: "同名区域" }),
      ]);
    });

    it("コード付き取消は同名でも一致する triple key だけを解除する", () => {
      holder.applyAccepted(eventInfo("event-a", [
        forecast("101", "51", "同名区域"),
        forecast("102", "51", "同名区域"),
      ]));
      holder.clearAccepted(eventInfo(
        "event-a",
        [forecast("101", "51", "改名後")],
        "2025-01-01T00:01:00+09:00",
      ));

      expect(holder.getLastInfo()?.forecast).toEqual([
        expect.objectContaining({ areaCode: "102", kindCode: "51", areaName: "同名区域" }),
      ]);
    });

    it("コード欠落 item 付き取消は EventID 全体を解除しない", () => {
      holder.applyAccepted(eventInfo("event-a", [forecast("101", "51", "維持対象")]));

      holder.clearAccepted(eventInfo(
        "event-a",
        [forecast(null, null, "照合不能")],
        "2025-01-01T00:01:00+09:00",
      ));

      expect(holder.getLastInfo()?.forecast).toEqual([
        expect.objectContaining({ areaCode: "101", kindCode: "51", areaName: "維持対象" }),
      ]);
    });

    it("受理済み後続報の forecast が空なら同 EventID の旧 item を除去する", () => {
      holder.applyAccepted(eventInfo("event-a", [forecast("101", "51", "解除対象")]));

      holder.applyAccepted(eventInfo("event-a", [], "2025-01-01T00:01:00+09:00"));

      expect(holder.getLevel()).toBeNull();
      expect(holder.getLastInfo()).toBeNull();
      expect(holder.getPersistedActive()).toBeNull();
    });

    it("unkeyed item だけの新報は active state と永続 payload を作らない", () => {
      holder.applyAccepted(eventInfo("event-a", [forecast(null, null, "表示専用")]));

      expect(holder.getLevel()).toBeNull();
      expect(holder.getLastInfo()).toBeNull();
      expect(holder.getPersistedActive()).toBeNull();
    });

    it("異なる EventID の複数予報区は単一安全側レベルで並存する", () => {
      holder.applyAccepted(eventInfo("event-a", [forecast("101", "62", "予報区A", "津波注意報")]));
      holder.applyAccepted(eventInfo(
        "event-b",
        [forecast("102", "53", "予報区B", "大津波警報")],
        "2025-01-01T00:01:00+09:00",
      ));

      expect(holder.getLevel()).toBe("大津波警報");
      expect(holder.getLastInfo()?.forecast?.map((item) => item.areaCode).sort())
        .toEqual(["101", "102"]);
    });

    it("複数 EventID は keyed snapshot に分離して往復し、一方の取消後も残存 EventID を保つ", () => {
      holder.applyAccepted(eventInfo("event-a", [forecast("101", "53", "予報区A", "大津波警報")]));
      holder.applyAccepted(eventInfo(
        "event-b",
        [forecast("102", "62", "予報区B", "津波注意報")],
        "2025-01-01T00:01:00+09:00",
      ));

      expect(holder.getPersistedActive()).toBeNull();
      expect(holder.getPersistedKeyedActive().map((item) => item.meta.eventId.value).sort())
        .toEqual(["event-a", "event-b"]);

      const bothRestored = new TsunamiStateHolder();
      bothRestored.restorePersistedState(
        null,
        { VTSE51: [], VTSE52: [] },
        holder.getPersistedKeyedActive(),
      );
      expect(bothRestored.getLastInfo()?.forecast?.map((item) => item.areaCode).sort())
        .toEqual(["101", "102"]);

      holder.clearAccepted(eventInfo("event-a", [], "2025-01-01T00:02:00+09:00"));
      const persisted = holder.getPersistedActive();
      expect(persisted?.meta.eventId.value).toBe("event-b");
      expect(persisted?.forecast).toEqual([
        expect.objectContaining({ areaCode: "102", areaName: "予報区B" }),
      ]);

      const restored = new TsunamiStateHolder();
      restored.restorePersistedState(persisted, { VTSE51: [], VTSE52: [] });
      restored.clearAccepted(eventInfo("event-a", [], "2025-01-01T00:03:00+09:00"));
      expect(restored.getLastInfo()?.forecast).toEqual([
        expect.objectContaining({ areaCode: "102", areaName: "予報区B" }),
      ]);
    });

    it("旧 unkeyed scalar 復元は別 EventID の取消で消さず、再永続化はしない", () => {
      holder.restorePersistedState(
        eventInfo("event-b", [forecast(null, null, "旧 snapshot")]),
        { VTSE51: [], VTSE52: [] },
      );

      holder.clearAccepted(eventInfo("event-a", [], "2025-01-01T00:01:00+09:00"));

      expect(holder.getLevel()).toBe("津波警報");
      expect(holder.getLastInfo()?.meta.eventId.value).toBe("event-b");
      expect(holder.getPersistedActive()).toBeNull();
      expect(holder.getPersistedKeyedActive()).toEqual([]);
      expect(holder.getPersistedLegacyActive()?.forecast?.[0]?.areaName).toBe("旧 snapshot");
    });

    it("旧 A=大津波 scalar と新 B=注意報 keyed を安全側最大で集約する", () => {
      holder.restorePersistedState(
        eventInfo("event-a", [forecast(null, null, "旧予報区A", "大津波警報")]),
        { VTSE51: [], VTSE52: [] },
      );

      holder.applyAccepted(eventInfo(
        "event-b",
        [forecast("102", "62", "新予報区B", "津波注意報")],
        "2025-01-01T00:01:00+09:00",
      ));

      expect(holder.getLevel()).toBe("大津波警報");
      expect(holder.getLastInfo()?.forecast?.map((item) => item.areaName).sort())
        .toEqual(["新予報区B", "旧予報区A"]);
      expect(holder.getPersistedActive()).toBeNull();
      expect(holder.getPersistedKeyedActive()).toHaveLength(1);
      expect(holder.getPersistedLegacyActive()?.forecast?.[0]?.areaName).toBe("旧予報区A");
    });

    it("legacy 表示は同 EventID の取消や revision gate 判定に参加せず、正規通常報でだけ退場する", () => {
      holder.restorePersistedState(
        eventInfo("event-a", [forecast(null, null, "旧予報区", "大津波警報")]),
        { VTSE51: [], VTSE52: [] },
      );

      holder.clearAccepted(eventInfo("event-a", [], "2025-01-01T00:01:00+09:00"));
      expect(holder.getPersistedLegacyActive()?.forecast?.[0]?.areaName).toBe("旧予報区");
      expect(holder.getLevel()).toBe("大津波警報");

      holder.applyAccepted(eventInfo(
        "event-a",
        [forecast("101", "62", "正規予報区", "津波注意報")],
        "2025-01-01T00:02:00+09:00",
      ));
      expect(holder.getPersistedLegacyActive()).toBeNull();
      expect(holder.getLastInfo()?.forecast).toEqual([
        expect.objectContaining({ areaCode: "101", areaName: "正規予報区" }),
      ]);
    });

    it("復元入力の取消 payload は keyed・legacy のどちらからも active state に入れない", () => {
      const cancellation = eventInfo("event-a", [forecast("101", "51", "取消 payload")]);
      cancellation.meta = createTelegramMeta({
        messageId: "persisted-cancellation",
        eventId: "event-a",
        type: "VTSE41",
        reportDateTime: "2025-01-01T00:00:00+09:00",
        serial: null,
        infoType: "取消",
        receivedAtMs: Date.parse("2025-01-01T00:00:00+09:00"),
        status: "通常",
        isTest: false,
      });

      holder.restorePersistedState(
        null,
        { VTSE51: [], VTSE52: [] },
        [cancellation],
        cancellation,
      );

      expect(holder.getLastInfo()).toBeNull();
      expect(holder.getPersistedKeyedActive()).toEqual([]);
      expect(holder.getPersistedLegacyActive()).toBeNull();
    });

    it("完全 keyed な legacyActive 入力は legacy 表示にせず canonical keyed state へ昇格する", () => {
      const keyedLegacy = eventInfo(
        "event-a",
        [forecast("101", "51", "誤分類された keyed payload")],
      );

      holder.restorePersistedState(
        null,
        { VTSE51: [], VTSE52: [] },
        [],
        keyedLegacy,
      );

      expect(holder.getPersistedKeyedActive()).toEqual([keyedLegacy]);
      expect(holder.getPersistedLegacyActive()).toBeNull();
      expect(holder.getLastInfo()?.forecast).toEqual([
        expect.objectContaining({ areaCode: "101", kindCode: "51" }),
      ]);
    });

    it("旧 scalar は同 EventID の keyed 新報でだけ置換される", () => {
      holder.restorePersistedState(
        eventInfo("event-a", [forecast(null, null, "旧予報区A", "大津波警報")]),
        { VTSE51: [], VTSE52: [] },
      );

      holder.applyAccepted(eventInfo(
        "event-a",
        [forecast("101", "62", "新予報区A", "津波注意報")],
        "2025-01-01T00:01:00+09:00",
      ));

      expect(holder.getLevel()).toBe("津波注意報");
      expect(holder.getLastInfo()?.forecast).toEqual([
        expect.objectContaining({ areaCode: "101", areaName: "新予報区A" }),
      ]);
    });

    it("津波警報で更新される", () => {
      const info = createTsunamiInfo({
        forecast: [
          { areaName: "岩手県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
        ],
      });

      holder.applyAccepted(info);

      expect(holder.getLevel()).toBe("津波警報");
      expect(holder.getDetail()).not.toBeNull();
    });

    it("取消報でクリアされる", () => {
      // まず警報を設定
      holder.applyAccepted(
        createTsunamiInfo({
          forecast: [
            { areaName: "岩手県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
          ],
        })
      );
      expect(holder.getLevel()).toBe("津波警報");

      holder.clearActive();

      expect(holder.getLevel()).toBeNull();
      expect(holder.getDetail()).toBeNull();
    });

    it("警報レベルなし (津波予報のみ) でクリアされる", () => {
      // まず警報を設定
      holder.applyAccepted(
        createTsunamiInfo({
          forecast: [
            { areaName: "岩手県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
          ],
        })
      );

      // 津波予報のみに変更
      holder.applyAccepted(
        createTsunamiInfo({
          reportDateTime: "2025-01-01T00:01:00+09:00",
          forecast: [
            { areaName: "岩手県", kind: "津波予報（若干の海面変動）", maxHeightDescription: "0.2m未満", firstHeight: "" },
          ],
        })
      );

      expect(holder.getLevel()).toBeNull();
    });

    it("レベル変更に追従する (津波警報 → 大津波警報)", () => {
      holder.applyAccepted(
        createTsunamiInfo({
          forecast: [
            { areaName: "岩手県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
          ],
        })
      );
      expect(holder.getLevel()).toBe("津波警報");

      holder.applyAccepted(
        createTsunamiInfo({
          reportDateTime: "2025-01-01T00:01:00+09:00",
          forecast: [
            { areaName: "岩手県", kind: "大津波警報", maxHeightDescription: "10m超", firstHeight: "到達中と推測" },
            { areaName: "宮城県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
          ],
        })
      );
      expect(holder.getLevel()).toBe("大津波警報");
    });

  });

  describe("getPromptStatus", () => {
    it("アクティブ時はセグメントを返す", () => {
      holder.applyAccepted(
        createTsunamiInfo({
          forecast: [
            { areaName: "岩手県", kind: "津波警報", maxHeightDescription: "3m", firstHeight: "到達中と推測" },
          ],
        })
      );

      const segment = holder.getPromptStatus();
      expect(segment).toEqual({
        text: "津波警報",
        role: "tsunamiWarning",
        priority: 10,
      });
    });

    it("非アクティブ時は null を返す", () => {
      expect(holder.getPromptStatus()).toBeNull();
    });
  });

  describe("getDetail", () => {
    it("情報がある場合は kind と元情報を返す", () => {
      const info = createTsunamiInfo({
        forecast: [
          { areaName: "岩手県", kind: "津波注意報", maxHeightDescription: "1m", firstHeight: "" },
        ],
      });
      holder.applyAccepted(info);

      expect(holder.getDetail()).toEqual({ kind: "tsunami", info });
    });

    it("情報がない場合は null", () => {
      expect(holder.getDetail()).toBeNull();
    });
  });

  describe("category / emptyMessage", () => {
    it("category は 'tsunami'", () => {
      expect(holder.category).toBe("tsunami");
    });

    it("emptyMessage が定義されている", () => {
      expect(holder.emptyMessage).toBe("現在、継続中の津波情報はありません。");
    });
  });
});
