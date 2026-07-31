import { describe, expect, it } from "vitest";
import { extractSpecialValue } from "../../src/dmdata/special-value";
import { createJmxShadowXmlParser } from "../../src/dmdata/xml-shape";

describe("extractSpecialValue", () => {
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
