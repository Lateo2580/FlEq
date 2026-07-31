import { testTelegramMeta } from "../../helpers/telegram-meta";
import { describe, it, expect } from "vitest";
import {
  analyzeWeatherTickerFacts,
  buildWeatherTickerSentence,
} from "../../../src/engine/display/weather-ticker-facts";
import type { ParsedWeatherWarning, WeatherAreaLayer } from "../../../src/types";
import { parseWeatherWarning } from "../../../src/dmdata/weather-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VPWS50_AGGREGATE,
  FIXTURE_VPWW55_OAME,
} from "../../helpers/mock-message";

function makeInfo(overrides: Partial<ParsedWeatherWarning>): ParsedWeatherWarning {
  return {
    meta: testTelegramMeta(false),
    type: "VPWS50",
    infoType: "発表",
    title: "気象警報・注意報（全国）",
    reportDateTime: "2026-07-08T21:00:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    editorialOffice: "気象庁",
    controlTitle: "気象警報・注意報（全国）",
    layers: [],
    comments: [],
    maxSeverity: "warning",
    ...overrides,
  } as ParsedWeatherWarning;
}

function layer(type: string, items: WeatherAreaLayer["items"]): WeatherAreaLayer {
  return { type, items };
}

function item(
  areaName: string,
  kinds: { name: string; code: string }[],
  statuses?: { kindCode: string; status: string; lastKindName?: string; lastKindCode?: string }[],
  fullStatus?: string,
): WeatherAreaLayer["items"][number] {
  return {
    areaName,
    areaCode: "000000",
    kinds: kinds.map((k) => ({ name: k.name, code: k.code, severity: "warning" as const })),
    statuses: statuses ?? kinds.map((k) => ({ kindCode: k.code, status: "発表" })),
    fullStatus,
  } as WeatherAreaLayer["items"][number];
}

describe("analyzeWeatherTickerFacts + buildWeatherTickerSentence", () => {
  it("VPWS50: 市町村層が同居していても府県予報区層で集約する (実電文構造)", () => {
    const info = makeInfo({
      layers: [
        // 実電文は市町村等層も Status 付きで持つ。最細層につられて市区町村を
        // 羅列しないこと (= この改修で消したい症状) をこの同居構造で固定する
        layer("気象警報・注意報（市町村等）", [
          item("水戸市", [{ name: "波浪注意報", code: "16" }]),
          item("日立市", [{ name: "波浪注意報", code: "16" }]),
        ]),
        layer("気象警報・注意報（府県予報区等）", [
          item("鹿児島県（奄美地方除く）", [{ name: "大雨警報", code: "03" }]),
          item("茨城県", [{ name: "波浪注意報", code: "16" }]),
          item("千葉県", [{ name: "波浪注意報", code: "16" }]),
          item("神奈川県", [{ name: "波浪注意報", code: "16" }]),
          item("静岡県", [{ name: "波浪注意報", code: "16" }]),
        ]),
      ],
    });
    const facts = analyzeWeatherTickerFacts(info);
    expect(facts?.mode).toBe("active");
    expect(buildWeatherTickerSentence(facts!)).toBe(
      "現在、大雨警報が鹿児島県に、波浪注意報が茨城県・千葉県・神奈川県など4県に発表されています。",
    );
  });

  it("解除のみ (実電文構造): Head は Kind を Name=解除/Code=00 に潰し、元種別は Body の "
    + "Status=解除 + LastKind にしか残らない。lastKindName から正しく「大雨警報は解除されました」になる", () => {
    // 旧テストは Head Kind に元コード (03) をそのまま残す合成構造だったため、Head/Body の
    // Code ズレ (Head=00 プレースホルダ / Body=元コード) を検出できずこのバグを見逃していた。
    // 実 fixture (test/fixtures/15_18_01_250630_VPWS50.xml) と同じ構造に是正する
    const info = makeInfo({
      type: "VPWW55",
      title: "熊本県大雨警報・注意報",
      layers: [
        layer("気象警報・注意報（市町村等）", [
          item(
            "熊本市",
            [{ name: "解除", code: "00" }],
            [{ kindCode: "03", status: "解除", lastKindName: "大雨警報", lastKindCode: "03" }],
          ),
        ]),
        layer("気象警報・注意報（府県予報区等）", [
          item(
            "熊本県",
            [{ name: "解除", code: "00" }],
            [{ kindCode: "03", status: "解除", lastKindName: "大雨警報", lastKindCode: "03" }],
          ),
        ]),
      ],
    });
    const facts = analyzeWeatherTickerFacts(info);
    expect(facts?.mode).toBe("releaseOnly");
    expect(buildWeatherTickerSentence(facts!)).toBe(
      "熊本県に発令されていた大雨警報は解除されました。",
    );
  });

  it("継続のみ: 発表と同じ「発表されています」で扱う", () => {
    const info = makeInfo({
      type: "VPWW55",
      title: "熊本県大雨警報・注意報",
      layers: [
        layer("気象警報・注意報（府県予報区等）", [
          item("熊本県", [{ name: "大雨警報", code: "03" }], [{ kindCode: "03", status: "継続" }]),
        ]),
      ],
    });
    expect(buildWeatherTickerSentence(analyzeWeatherTickerFacts(info)!)).toBe(
      "熊本県に大雨警報が発表されています。",
    );
  });

  it("府県内一部 (fullStatus=一部) は「県内の一部に」と表現する", () => {
    const info = makeInfo({
      type: "VPWW55",
      title: "熊本県大雨警報・注意報",
      layers: [
        layer("気象警報・注意報（府県予報区等）", [
          item(
            "熊本県",
            [{ name: "大雨警報", code: "03" }],
            [{ kindCode: "03", status: "発表" }],
            "一部",
          ),
        ]),
      ],
    });
    expect(buildWeatherTickerSentence(analyzeWeatherTickerFacts(info)!)).toBe(
      "熊本県内の一部に大雨警報が発表されています。",
    );
  });

  it("取消は cancel mode", () => {
    const info = makeInfo({ infoType: "取消" });
    const facts = analyzeWeatherTickerFacts(info);
    expect(facts?.mode).toBe("cancel");
    expect(buildWeatherTickerSentence(facts!)).toBe("この情報は取り消されました。");
  });

  it("層が空なら null (呼び出し側 fallback)", () => {
    const info = makeInfo({ layers: [] });
    expect(analyzeWeatherTickerFacts(info)).toBeNull();
  });

  it("府県予報区層が無い VPWS50 は null (spec 必須 fixture)", () => {
    const info = makeInfo({
      layers: [
        layer("気象警報・注意報（市町村等）", [
          item("水戸市", [{ name: "波浪注意報", code: "16" }]),
        ]),
      ],
    });
    expect(analyzeWeatherTickerFacts(info)).toBeNull();
  });

  it("単県・複数種別・全 group 同一範囲 (全域×2): 圧縮文を維持する", () => {
    const info = makeInfo({
      type: "VPWW55",
      title: "熊本県大雨警報・強風注意報",
      layers: [
        layer("気象警報・注意報（府県予報区等）", [
          item("熊本県", [{ name: "大雨警報", code: "03" }], [{ kindCode: "03", status: "発表" }]),
          item("熊本県", [{ name: "強風注意報", code: "14" }], [{ kindCode: "14", status: "発表" }]),
        ]),
      ],
    });
    expect(buildWeatherTickerSentence(analyzeWeatherTickerFacts(info)!)).toBe(
      "熊本県に大雨警報・強風注意報が発表されています。",
    );
  });

  it("単県・複数種別・partial/full 混在: 範囲を混同せず列挙形式にする", () => {
    const info = makeInfo({
      type: "VPWW55",
      title: "熊本県大雨警報・強風注意報",
      layers: [
        layer(
          "気象警報・注意報（府県予報区等）",
          [
            item("熊本県", [{ name: "大雨警報", code: "03" }], [{ kindCode: "03", status: "発表" }], "一部"),
            item("熊本県", [{ name: "強風注意報", code: "14" }], [{ kindCode: "14", status: "発表" }]),
          ],
        ),
      ],
    });
    expect(buildWeatherTickerSentence(analyzeWeatherTickerFacts(info)!)).toBe(
      "現在、大雨警報が熊本県内の一部に、強風注意報が熊本県に発表されています。",
    );
  });

  it("実 VPWW55 電文 (島根県大雨警報・注意報): 府県予報区層で完全一致の文になる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW55_OAME);
    const info = parseWeatherWarning(msg);
    const facts = analyzeWeatherTickerFacts(info!);
    const sentence = buildWeatherTickerSentence(facts!);
    // fixture の府県予報区層は 島根県 1 件のみ (レベル３大雨警報, Status=継続, FullStatus=一部)。
    // 市町村層 (松江市 等) の地域名が混入しないことをここで固定する。
    expect(sentence).toBe("島根県内の一部に大雨警報が発表されています。");
  });

  it("実 VPWS50 電文 (宗谷地方の解除): Head の解除プレースホルダを Body の LastKind から復元し、"
    + "「〜に発令されていた濃霧注意報は解除されました。」になる (根因の現物再現)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWS50_AGGREGATE);
    const parsed = parseWeatherWarning(msg)!;
    const prefLayer = parsed.layers.find((l) => l.type.includes("府県予報区"))!;
    const soya = prefLayer.items.find((it) => it.areaName === "宗谷地方")!;
    // 現物確認: Head は Name="解除"/Code="00" に潰し、元種別 (濃霧注意報/20) は
    // Body.Warning の Status="解除" + LastKind にしか残らない
    expect(soya.kinds).toEqual([{ name: "解除", code: "00", severity: "release" }]);
    expect(soya.statuses[0]).toMatchObject({
      kindCode: "20", status: "解除", lastKindName: "濃霧注意報", lastKindCode: "20",
    });

    // 全国集約 (VPWS50) の府県予報区層は他県の発表中警報も同居するため、宗谷地方の解除だけを
    // 抜き出して単独の releaseOnly ケースとして検証する (analyzeWeatherTickerFacts は active が
    // 1 件でもあれば releaseOnly 判定にならない仕様のため)
    const info = makeInfo({
      type: "VPWS50",
      layers: [layer("気象警報・注意報（府県予報区等）", [soya])],
    });
    const facts = analyzeWeatherTickerFacts(info);
    expect(facts?.mode).toBe("releaseOnly");
    expect(buildWeatherTickerSentence(facts!)).toBe(
      "宗谷地方に発令されていた濃霧注意報は解除されました。",
    );
  });
});
