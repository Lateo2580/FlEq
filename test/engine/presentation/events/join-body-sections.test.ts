import { describe, it, expect } from "vitest";
import {
  joinSections,
  joinBodyTexts,
  joinVolcanoBatch,
} from "../../../../src/engine/presentation/events/join-body-sections";
import type {
  ClimateBodyText,
  ParsedVolcanoAshfallInfo,
  WeatherExplanationSection,
} from "../../../../src/types";

function section(over: Partial<WeatherExplanationSection>): WeatherExplanationSection {
  return { sectionType: "概況", propertyType: "気象概況", textType: "本文", text: "本文テキスト", ...over };
}

function bodyText(over: Partial<ClimateBodyText>): ClimateBodyText {
  return { textType: "概況", text: "本文", areas: [], periodLabel: null, ...over };
}

function ashfall(over: Partial<ParsedVolcanoAshfallInfo>): ParsedVolcanoAshfallInfo {
  return {
    kind: "ashfall",
    type: "VFVO53",
    subKind: "scheduled",
    infoType: "発表",
    title: "降灰予報",
    reportDateTime: "2026-07-10T12:00:00+09:00",
    eventDateTime: null,
    headline: null,
    publishingOffice: "気象庁",
    volcanoName: "桜島",
    volcanoCode: "506",
    coordinate: null,
    isTest: false,
    craterName: null,
    ashForecasts: [],
    plumeHeight: null,
    plumeDirection: null,
    bodyText: "降灰の本文",
    ...over,
  };
}

describe("joinSections", () => {
  it("各セクションを【sectionType】text で改行連結する", () => {
    const out = joinSections([
      section({ sectionType: "概況", text: "低気圧が発達しています。" }),
      section({ sectionType: "防災事項", text: "土砂災害に警戒してください。" }),
    ]);
    expect(out).toBe("【概況】低気圧が発達しています。\n【防災事項】土砂災害に警戒してください。");
  });

  it("空/全空白セクションは除外する", () => {
    const out = joinSections([
      section({ sectionType: "概況", text: "本文あり" }),
      section({ sectionType: "防災事項", text: "   " }),
      section({ sectionType: "付加情報", text: "" }),
    ]);
    expect(out).toBe("【概況】本文あり");
  });

  it("sectionType が空なら見出しを付けない", () => {
    const out = joinSections([section({ sectionType: "", text: "見出しなし本文" })]);
    expect(out).toBe("見出しなし本文");
  });

  it("全滅は null", () => {
    expect(joinSections([])).toBeNull();
    expect(joinSections([section({ text: "" }), section({ text: "  " })])).toBeNull();
  });
});

describe("joinBodyTexts", () => {
  it("各ブロックを【textType】text で改行連結する", () => {
    const out = joinBodyTexts([
      bodyText({ textType: "概況", text: "高温が続いています。" }),
      bodyText({ textType: "今後の見通し", text: "しばらく続く見込みです。" }),
    ]);
    expect(out).toBe("【概況】高温が続いています。\n【今後の見通し】しばらく続く見込みです。");
  });

  it("textType が null なら「本文」を見出しにする", () => {
    const out = joinBodyTexts([bodyText({ textType: null, text: "本文だけ" })]);
    expect(out).toBe("【本文】本文だけ");
  });

  it("空は除外、全滅は null", () => {
    expect(joinBodyTexts([bodyText({ text: "" })])).toBeNull();
    expect(joinBodyTexts([])).toBeNull();
  });
});

describe("joinVolcanoBatch", () => {
  it("全要素の bodyText を火山名見出し付きで文書順連結する", () => {
    const out = joinVolcanoBatch([
      ashfall({ volcanoName: "桜島", bodyText: "桜島の降灰予報" }),
      ashfall({ volcanoName: "阿蘇山", bodyText: "阿蘇山の降灰予報" }),
    ]);
    expect(out).toBe("【桜島】桜島の降灰予報\n【阿蘇山】阿蘇山の降灰予報");
  });

  it("同一火山・同一本文は除去する", () => {
    const out = joinVolcanoBatch([
      ashfall({ volcanoName: "桜島", volcanoCode: "506", bodyText: "同一本文" }),
      ashfall({ volcanoName: "桜島", volcanoCode: "506", bodyText: "同一本文" }),
    ]);
    expect(out).toBe("【桜島】同一本文");
  });

  it("別火山・同一定型本文は両方残す (火山名ごと消さない)", () => {
    const out = joinVolcanoBatch([
      ashfall({ volcanoName: "桜島", volcanoCode: "506", bodyText: "多量の降灰に注意してください。" }),
      ashfall({ volcanoName: "阿蘇山", volcanoCode: "503", bodyText: "多量の降灰に注意してください。" }),
    ]);
    expect(out).toBe("【桜島】多量の降灰に注意してください。\n【阿蘇山】多量の降灰に注意してください。");
  });

  it("空本文は除外、全滅は null", () => {
    expect(joinVolcanoBatch([ashfall({ bodyText: "" })])).toBeNull();
    expect(joinVolcanoBatch([])).toBeNull();
  });
});
