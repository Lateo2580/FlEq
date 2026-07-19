import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("../../src/logger", () => ({ warn: vi.fn() }));

import * as log from "../../src/logger";
import {
  __phenomenonKey_internals,
  kindCodeToPhenomenonKey,
} from "../../src/dmdata/weather-phenomenon-key";

describe("kindCodeToPhenomenonKey - 公式 Kind code 全 phenomenon family 網羅", () => {
  beforeEach(() => {
    vi.mocked(log.warn).mockClear();
    __phenomenonKey_internals.warnedUnknown.clear();
  });

  // spec §3.1 の全マッピング
  const CASES: Array<[string, string]> = [
    ["02", "暴風雪"], ["32", "暴風雪"],
    ["03", "大雨"], ["10", "大雨"], ["33", "大雨"], ["43", "大雨"],
    ["04", "洪水"], ["18", "洪水"],
    ["05", "暴風"], ["35", "暴風"],
    ["06", "大雪"], ["12", "大雪"], ["36", "大雪"],
    ["07", "波浪"], ["16", "波浪"], ["37", "波浪"],
    ["08", "高潮"], ["19", "高潮"], ["38", "高潮"], ["48", "高潮"],
    ["09", "土砂災害"], ["29", "土砂災害"], ["39", "土砂災害"], ["49", "土砂災害"],
    ["13", "風雪"],
    ["14", "雷"],
    ["15", "強風"],
    ["17", "融雪"],
    ["20", "濃霧"],
    ["21", "乾燥"],
    ["22", "なだれ"],
    ["23", "低温"],
    ["24", "霜"],
    ["25", "着氷"],
    ["26", "着雪"],
    ["27", "その他注意報"],
  ];

  it.each(CASES)("Code %s → %s", (code, expected) => {
    expect(kindCodeToPhenomenonKey(code)).toBe(expected);
  });

  it("大雨の昇格判定の根幹: code 10 と code 03 は同じ phenomenonKey", () => {
    expect(kindCodeToPhenomenonKey("10")).toBe(kindCodeToPhenomenonKey("03"));
  });

  it("土砂災害の昇格判定の根幹: code 29 と code 09 は同じ phenomenonKey", () => {
    expect(kindCodeToPhenomenonKey("29")).toBe(kindCodeToPhenomenonKey("09"));
  });

  it("未知 code は 'unknown_NN' でフォールバック", () => {
    expect(kindCodeToPhenomenonKey("99")).toBe("unknown_99");
    expect(kindCodeToPhenomenonKey("00")).toBe("unknown_00"); // 解除 code は実装上呼ばれないが防御
  });

  it("空文字 → 'unknown_'", () => {
    expect(kindCodeToPhenomenonKey("")).toBe("unknown_");
  });

  it("同一の未知 code は 1 回だけ warn する", () => {
    kindCodeToPhenomenonKey("warn-once-same");
    kindCodeToPhenomenonKey("warn-once-same");

    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("異なる未知 code はそれぞれ 1 回 warn する", () => {
    kindCodeToPhenomenonKey("warn-once-a");
    kindCodeToPhenomenonKey("warn-once-b");

    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
