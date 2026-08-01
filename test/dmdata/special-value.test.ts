import { describe, expect, it } from "vitest";
import { extractSpecialValue } from "../../src/dmdata/special-value";
import { createJmxShadowXmlParser } from "../../src/dmdata/xml-shape";

describe("extractSpecialValue", () => {
  it.each([
    ["value", { "#text": "4" }, { raw: "4", value: "4", presence: "value" }],
    ["missing", undefined, { raw: null, value: null, presence: "missing" }],
    ["empty", {}, { raw: "", value: null, presence: "empty" }],
    ["unknown", { "@_condition": "未入電" }, { value: null, condition: "未入電", presence: "unknown" }],
    ["qualitative", { "@_condition": "5弱以上未入電" }, { value: null, condition: "5弱以上未入電", presence: "qualitative", lowerBound: "5-" }],
    ["range", { From: "3", To: "4" }, { value: null, presence: "range", lowerBound: "3", upperBound: "4" }],
  ] as const)("Intensity の %s を共通契約へ分類する", (_label, node, expected) => {
    expect(extractSpecialValue("Intensity", node)).toMatchObject(expected);
  });

  it("未知 Condition と valid 本文が矛盾しても本文を value として保持する", () => {
    expect(extractSpecialValue("Intensity", {
      "#text": "4",
      "@_condition": "5弱以上未入電ではない",
    })).toEqual({
      raw: "4",
      value: "4",
      condition: "5弱以上未入電ではない",
      description: null,
      presence: "value",
      diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
    });
  });

  it("未知 Condition があっても Description の範囲 qualifier を保持する", () => {
    expect(extractSpecialValue("Intensity", {
      "#text": "4",
      "@_condition": "新しい未知語",
      "@_description": "震度4以上",
    })).toEqual({
      raw: "4",
      value: null,
      condition: "新しい未知語",
      description: "震度4以上",
      presence: "range",
      lowerBound: "4",
      upperBound: null,
      diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
    });
  });

  it.each([
    ["Intensity unknown", "Intensity", "未入電", "unknown", undefined],
    ["Intensity qualitative", "Intensity", "5弱以上未入電", "qualitative", "5-"],
    ["LgInt unknown", "LgInt", "未入電", "unknown", undefined],
  ] as const)("既知 Condition を From/To より優先する: %s", (
    _label,
    domain,
    condition,
    presence,
    lowerBound,
  ) => {
    expect(extractSpecialValue(domain, {
      From: "3",
      To: "4",
      "@_condition": condition,
    })).toMatchObject({
      raw: "",
      value: null,
      condition,
      presence,
      rawLowerBound: "3",
      rawUpperBound: "4",
      ...(lowerBound == null ? {} : { lowerBound }),
    });
  });

  it.each([
    ["Condition unknown", "未入電", "5弱以上未入電", "unknown", undefined],
    ["Condition qualitative", "5弱以上未入電", "未入電", "qualitative", "5-"],
  ] as const)("既知 Condition を矛盾する Description より優先する: %s", (
    _label,
    condition,
    description,
    presence,
    lowerBound,
  ) => {
    expect(extractSpecialValue("Intensity", {
      "@_condition": condition,
      "@_description": description,
    })).toEqual({
      raw: "",
      value: null,
      condition,
      description,
      presence,
      ...(lowerBound == null ? {} : { lowerBound }),
      diagnostics: ["specialValueConflict"],
    });
  });

  it.each([
    ["unknown", "未入電", undefined],
    ["qualitative", "5弱以上未入電", "5-"],
  ] as const)("priority %s return でも未知 Condition の diagnostics を保持する", (
    presence,
    description,
    lowerBound,
  ) => {
    expect(extractSpecialValue("Intensity", {
      From: "3",
      To: "4",
      "@_condition": "新しい未知語",
      "@_description": description,
    })).toEqual({
      raw: "",
      value: null,
      condition: "新しい未知語",
      description,
      presence,
      ...(lowerBound == null ? {} : { lowerBound }),
      rawLowerBound: "3",
      rawUpperBound: "4",
      diagnostics: ["unmappedSpecialValue", "specialValueConflict"],
    });
  });

  it.each([
    ["Intensity unknown", "Intensity", "未入電", "unknown", undefined],
    ["Intensity qualitative", "Intensity", "5弱以上未入電", "qualitative", "5-"],
    ["LgInt unknown", "LgInt", "未入電", "unknown", undefined],
  ] as const)("description-only の既知特殊語を分類する: %s", (
    _label,
    domain,
    description,
    presence,
    lowerBound,
  ) => {
    expect(extractSpecialValue(domain, {
      "@_description": description,
    })).toMatchObject({
      raw: "",
      value: null,
      condition: null,
      description,
      presence,
      ...(lowerBound == null ? {} : { lowerBound }),
    });
  });

  it("Intensity の同値 From/To を raw bounds 付き exact value に畳む", () => {
    expect(extractSpecialValue("Intensity", { From: "4", To: "4" })).toEqual({
      raw: "",
      value: "4",
      condition: null,
      description: null,
      presence: "value",
      rawLowerBound: "4",
      rawUpperBound: "4",
    });
  });

  it("Intensity の非 canonical To を raw のまま保持する", () => {
    expect(extractSpecialValue("Intensity", { From: "5-", To: "over" })).toEqual({
      raw: "",
      value: null,
      condition: null,
      description: null,
      presence: "range",
      lowerBound: "5-",
      upperBound: null,
      rawLowerBound: "5-",
      rawUpperBound: "over",
    });
  });

  it.each([
    ["unknown Condition", "新しい未知語", null, { value: "3", presence: "value" }],
    ["negated known term", "未入電ではない", null, { value: "3", presence: "value" }],
    ["Description range", "新しい未知語", "長周期地震動階級3以上", {
      value: null,
      presence: "range",
      lowerBound: "3",
      upperBound: null,
    }],
  ] as const)("LgInt の %s を完全一致規約で分類する", (_label, condition, description, expected) => {
    expect(extractSpecialValue("LgInt", {
      "#text": "3",
      "@_condition": condition,
      ...(description == null ? {} : { "@_description": description }),
    })).toMatchObject({
      condition,
      description,
      ...expected,
    });
  });

  it.each([
    ["Intensity value", "Intensity", { "#text": "４" }, {
      raw: "４",
      value: "4",
      presence: "value",
    }],
    ["LgInt value", "LgInt", { "#text": "３" }, {
      raw: "３",
      value: "3",
      presence: "value",
    }],
    ["Intensity range", "Intensity", { From: "３", To: "４" }, {
      value: null,
      presence: "range",
      lowerBound: "3",
      upperBound: "4",
      rawLowerBound: "３",
      rawUpperBound: "４",
    }],
  ] as const)("全角 canonical: %s", (_label, domain, node, expected) => {
    expect(extractSpecialValue(domain, node)).toMatchObject(expected);
  });

  it.each([
    ["value", { "#text": "3" }, { value: "3", presence: "value" }],
    ["missing", undefined, { raw: null, value: null, presence: "missing" }],
    ["empty", {}, { raw: "", value: null, presence: "empty" }],
    ["unknown", { "@_condition": "未入電" }, { value: null, condition: "未入電", presence: "unknown" }],
    ["qualitative", { "#text": "解析保留" }, { value: null, raw: "解析保留", presence: "qualitative" }],
    ["range", { From: "1", To: "3" }, { value: null, presence: "range", lowerBound: "1", upperBound: "3" }],
  ] as const)("LgInt の %s を共通契約へ分類する", (_label, node, expected) => {
    expect(extractSpecialValue("LgInt", node)).toMatchObject(expected);
  });

  it("missing と empty を別結果にする", () => {
    expect(extractSpecialValue("Magnitude", undefined)).toEqual({
      raw: null,
      value: null,
      condition: null,
      description: null,
      presence: "missing",
    });
    expect(extractSpecialValue("Magnitude", {})).toEqual({
      raw: "",
      value: null,
      condition: null,
      description: null,
      presence: "empty",
    });
  });

  it.each(["", " ", "　", " \t　"])("empty raw %j を byte-for-byte で保持する", (raw) => {
    expect(extractSpecialValue("Pressure", { "#text": raw })).toMatchObject({
      raw,
      value: null,
      presence: "empty",
    });
  });

  it("shadow XML parser から空白本文と self-closing を区別して抽出する", () => {
    const parsed = createJmxShadowXmlParser().parse(
      "<Root><Whitespace> \t　</Whitespace><SelfClosing /></Root>",
    ) as {
      Root: { Whitespace: string; SelfClosing: string };
    };
    expect(extractSpecialValue("Pressure", parsed.Root.Whitespace)).toMatchObject({
      raw: " \t　",
      presence: "empty",
    });
    expect(extractSpecialValue("Pressure", parsed.Root.SelfClosing)).toMatchObject({
      raw: "",
      presence: "empty",
    });
  });

  it("condition / description の欠落と明示空を区別する", () => {
    expect(extractSpecialValue("Pressure", { "#text": "950" })).toMatchObject({
      condition: null,
      description: null,
    });
    expect(extractSpecialValue("Pressure", {
      "#text": "950",
      "@_condition": "",
      "@_description": "",
    })).toMatchObject({
      condition: "",
      description: "",
    });
  });

  it("通常値の解析コピーだけを正規化し raw を変更しない", () => {
    expect(extractSpecialValue("Pressure", { "#text": "　＋９５０．５　" })).toEqual({
      raw: "　＋９５０．５　",
      value: 950.5,
      condition: null,
      description: null,
      presence: "value",
    });
  });

  it("From / To 構造を range として保持する", () => {
    expect(extractSpecialValue("Intensity", {
      From: "3",
      To: "4",
    })).toEqual({
      raw: "",
      value: null,
      condition: null,
      description: null,
      presence: "range",
      lowerBound: "3",
      upperBound: "4",
      rawLowerBound: "3",
      rawUpperBound: "4",
    });
  });

  it("下限・上限 condition を bounds へ構造化する", () => {
    expect(extractSpecialValue("WindSpeed", {
      "#text": "50",
      "@_condition": "以上",
      "@_description": "風速５０ノット以上",
      "@_unit": "ノット",
    })).toMatchObject({
      raw: "50",
      value: null,
      condition: "以上",
      description: "風速５０ノット以上",
      presence: "range",
      lowerBound: 50,
      upperBound: null,
    });
    expect(extractSpecialValue("TsunamiHeight", {
      "#text": "0.2",
      "@_description": "０．２ｍ未満",
    })).toMatchObject({
      presence: "range",
      lowerBound: null,
      upperBound: 0.2,
    });
  });

  it("既知の unknown と qualitative を domain 規約で区別する", () => {
    expect(extractSpecialValue("Pressure", {
      "#text": "NaN",
      "@_condition": "解析不能",
    }).presence).toBe("unknown");
    expect(extractSpecialValue("Magnitude", {
      "#text": "NaN",
      "@_condition": "不明",
      "@_description": "Ｍ８を超える巨大地震",
    })).toMatchObject({
      raw: "NaN",
      value: null,
      presence: "qualitative",
      condition: "不明",
      description: "Ｍ８を超える巨大地震",
    });
    expect(extractSpecialValue("Intensity", {
      "@_condition": "5弱以上未入電",
    })).toMatchObject({
      presence: "qualitative",
      lowerBound: "5-",
    });
  });

  it("数値付きの津波 観測中 は値を保持し、数値なしは qualitative にする", () => {
    expect(extractSpecialValue("TsunamiHeight", {
      "#text": "3.2",
      "@_condition": "観測中",
    })).toMatchObject({
      value: 3.2,
      condition: "観測中",
      presence: "value",
    });
    expect(extractSpecialValue("TsunamiHeight", {
      "@_condition": "観測中",
    })).toMatchObject({
      value: null,
      condition: "観測中",
      presence: "qualitative",
    });
  });

  it("未知 condition と valid 本文が衝突しても本文を value として保持する", () => {
    expect(extractSpecialValue("WindSpeed", {
      "#text": "25",
      "@_condition": "新しい未知語",
    })).toMatchObject({
      raw: "25",
      value: 25,
      condition: "新しい未知語",
      presence: "value",
    });
  });

  it("PlumeHeight は観測阻害 condition を description の雲中より優先する", () => {
    expect(extractSpecialValue("PlumeHeight", {
      "#text": "1200",
      "@_condition": "観測できず",
      "@_description": "雲中",
    })).toMatchObject({
      raw: "1200",
      value: null,
      condition: "観測できず",
      description: "雲中",
      presence: "unknown",
    });
  });

  it("PlumeHeight は condition/body 以外の定性語で分類を上書きしない", () => {
    expect(extractSpecialValue("PlumeHeight", {
      "#text": "1200",
      "@_description": "雲中",
    })).toMatchObject({
      value: 1200,
      description: "雲中",
      presence: "value",
    });
    expect(extractSpecialValue("PlumeHeight", {
      "@_condition": "雲中",
      "@_description": "観測できず",
    })).toMatchObject({
      value: null,
      condition: "雲中",
      description: "観測できず",
      presence: "qualitative",
    });
  });
});
