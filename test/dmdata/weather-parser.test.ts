import { describe, it, expect } from "vitest";
import {
  parseWeatherWarning,
  deriveWeatherSeverity,
  selectPreferredWeatherLayer,
} from "../../src/dmdata/weather-parser";
import { computeMaxDisplaySeverity } from "../../src/dmdata/weather-warning-level";
import {
  createMockWsDataMessage,
  FIXTURE_VPWW55_OAME,
  FIXTURE_VPWW56_DOSHA,
  FIXTURE_VPWW57_KOCHO,
  FIXTURE_VPWW58_BOFU,
  FIXTURE_VPWW59_HARO,
  FIXTURE_VPWW60_OYUKI,
  FIXTURE_VPWW61_OTHER,
  FIXTURE_VPWS50_AGGREGATE,
  encodeXml,
} from "../helpers/mock-message";

describe("deriveWeatherSeverity", () => {
  it("Name に '解除' を含むものは release", () => {
    expect(deriveWeatherSeverity("解除", "00")).toBe("release");
  });

  it("Name に '特別警報' を含むものは specialWarning", () => {
    expect(deriveWeatherSeverity("大雨特別警報", "33")).toBe("specialWarning");
  });

  it("「危険警報」は warning (DMDATA/JMA 準拠)", () => {
    expect(deriveWeatherSeverity("レベル４土砂災害危険警報", "49")).toBe("warning");
  });

  it("一般的な警報は warning", () => {
    expect(deriveWeatherSeverity("大雨警報", "03")).toBe("warning");
    expect(deriveWeatherSeverity("暴風警報", "05")).toBe("warning");
  });

  it("注意報は advisory", () => {
    expect(deriveWeatherSeverity("大雨注意報", "10")).toBe("advisory");
    expect(deriveWeatherSeverity("雷注意報", "14")).toBe("advisory");
  });

  it("Code 番号で specialWarning を判定 (30-39)", () => {
    expect(deriveWeatherSeverity("", "33")).toBe("specialWarning");
    expect(deriveWeatherSeverity("", "39")).toBe("specialWarning");
  });

  it("Code 40-49 は warning (危険警報相当)", () => {
    expect(deriveWeatherSeverity("", "49")).toBe("warning");
  });

  it("Code 不明は unknown", () => {
    expect(deriveWeatherSeverity("", "")).toBe("unknown");
    expect(deriveWeatherSeverity("", "99")).toBe("unknown");
  });
});

describe("deriveWeatherSeverity strict code validation", () => {
  it("rejects a numeric prefix followed by non-numeric content", () => {
    expect(deriveWeatherSeverity("", "30foo")).toBe("unknown");
  });
});

describe("selectPreferredWeatherLayer", () => {
  it("空配列なら undefined", () => {
    expect(selectPreferredWeatherLayer([])).toBeUndefined();
  });

  it("市町村等を最優先で選ぶ (全角括弧)", () => {
    const layers = [
      { type: "気象警報・注意報（府県予報区等）", items: [] },
      { type: "気象警報・注意報（一次細分区域等）", items: [] },
      { type: "気象警報・注意報（市町村等をまとめた地域等）", items: [] },
      { type: "気象警報・注意報（市町村等）", items: [] },
    ];
    expect(selectPreferredWeatherLayer(layers)?.type).toBe("気象警報・注意報（市町村等）");
  });

  it("市町村等がなければ「まとめた」を選ぶ", () => {
    const layers = [
      { type: "気象警報・注意報（府県予報区等）", items: [] },
      { type: "気象警報・注意報（一次細分区域等）", items: [] },
      { type: "気象警報・注意報（市町村等をまとめた地域等）", items: [] },
    ];
    expect(selectPreferredWeatherLayer(layers)?.type).toBe(
      "気象警報・注意報（市町村等をまとめた地域等）",
    );
  });

  it("「市町村等をまとめた」を「市町村等」と誤マッチしない", () => {
    const layers = [
      { type: "気象警報・注意報（市町村等をまとめた地域等）", items: [] },
    ];
    expect(selectPreferredWeatherLayer(layers)?.type).toBe(
      "気象警報・注意報（市町村等をまとめた地域等）",
    );
  });
});

describe("parseWeatherWarning", () => {
  it("VPWW55 (大雨) を正しくパースする", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW55_OAME);
    const result = parseWeatherWarning(msg);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("VPWW55");
    expect(result!.infoType).toBe("発表");
    expect(result!.title).toContain("大雨");
    expect(result!.headline).not.toBeNull();
    expect(result!.isTest).toBe(false);
    expect(result!.layers.length).toBeGreaterThan(0);
  });

  it("VPWW56 (土砂災害) で複数階層が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW56_DOSHA);
    const result = parseWeatherWarning(msg);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("VPWW56");
    // 4階層 (府県予報区/一次細分/市町村まとめ/市町村等) が抽出される想定
    expect(result!.layers.length).toBeGreaterThanOrEqual(3);
    expect(result!.maxSeverity).toBe("warning"); // レベル4危険警報は warning
  });

  it("VPWW56 で警報地域と注意報地域がカウントされる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW56_DOSHA);
    const result = parseWeatherWarning(msg);

    expect(result!.warningAreaCount).toBeGreaterThan(0);
    expect(result!.advisoryAreaCount).toBeGreaterThan(0);
  });

  it("VPWW57-60 (高潮/暴風/波浪/大雪) もパースできる", () => {
    for (const fixture of [
      FIXTURE_VPWW57_KOCHO,
      FIXTURE_VPWW58_BOFU,
      FIXTURE_VPWW59_HARO,
      FIXTURE_VPWW60_OYUKI,
    ]) {
      const msg = createMockWsDataMessage(fixture);
      const result = parseWeatherWarning(msg);
      expect(result).not.toBeNull();
      expect(result!.layers.length).toBeGreaterThan(0);
    }
  });

  it("VPWW61 (その他注意報) は府県予報区レベルで複数 Kind を持つ", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW61_OTHER);
    const result = parseWeatherWarning(msg);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("VPWW61");
    // VPWW61 は雷/融雪/濃霧 など複数注意報が並ぶ (上位階層で集約)
    // どこかの layer に複数 Kind を持つ Item があることを期待
    const hasMultiKindItem = result!.layers.some((layer) =>
      layer.items.some((i) => i.kinds.length > 1),
    );
    expect(hasMultiKindItem).toBe(true);
  });

  it("VPWS50 (全国集約) も同じインターフェースでパースできる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWS50_AGGREGATE);
    const result = parseWeatherWarning(msg);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("VPWS50");
    expect(result!.layers.length).toBeGreaterThan(0);
    // 全国規模なので地域数は多い
    const totalAreas = result!.layers.reduce(
      (sum, l) => sum + l.items.length,
      0,
    );
    expect(totalAreas).toBeGreaterThan(100);
  });

  it("publishingOffice / editorialOffice / controlTitle が取得される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW56_DOSHA);
    const result = parseWeatherWarning(msg);

    expect(result!.publishingOffice).toBeTruthy();
    expect(result!.editorialOffice).toBeTruthy();
    expect(result!.controlTitle).toBeTruthy();
  });

  it("Comment 配列が抽出される (VPWW56 にはレベル4補足情報がある)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW56_DOSHA);
    const result = parseWeatherWarning(msg);

    expect(result!.comments.length).toBeGreaterThan(0);
    expect(result!.comments[0].text).toBeTruthy();
  });

  it("不正なXMLを渡すと null が返る (エラー時の安全網)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW55_OAME, {
      body: "invalid-base64-content",
    });
    const result = parseWeatherWarning(msg);
    expect(result).toBeNull();
  });

  // ── Code 先頭ゼロ保持 (R2 指摘 #1) ──

  it("Code の先頭ゼロが保持される (parseTagValue: false)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW55_OAME);
    const result = parseWeatherWarning(msg);
    expect(result).not.toBeNull();
    // 大雨警報 Code=03 が "03" のままになっていることを確認
    const allKindCodes = result!.layers.flatMap((l) =>
      l.items.flatMap((i) => i.kinds.map((k) => k.code)),
    );
    // 数値化されると "3" になってしまう。先頭ゼロが保たれているか
    for (const code of allKindCodes) {
      if (code === "" || code === "0") continue; // 空・解除は除く
      // 1桁の Code はないはず (00-99 の体系)
      expect(code.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("Area.Code (市町村コード) の先頭ゼロが保持される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW56_DOSHA);
    const result = parseWeatherWarning(msg);
    expect(result).not.toBeNull();
    const allAreaCodes = result!.layers.flatMap((l) =>
      l.items.map((i) => i.areaCode),
    );
    // 市町村コードは "0121400" のように先頭ゼロを持つ
    const hasLeadingZeroCode = allAreaCodes.some((c) => c.startsWith("0"));
    expect(hasLeadingZeroCode).toBe(true);
  });

  // ── Headline.Text 配列処理 (R2 指摘 info) ──

  it("Headline.Text が単一テキストとして抽出される (配列でも崩れない)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW55_OAME);
    const result = parseWeatherWarning(msg);
    expect(result!.headline).not.toBeNull();
    expect(result!.headline).not.toContain(","); // 配列を String() した時の comma が混入していないか
  });

  // ── Body.Warning の Status / ChangeStatus 抽出 ──

  it("Body.Warning から statuses (発表/継続) が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW56_DOSHA);
    const result = parseWeatherWarning(msg);
    const allStatuses = result!.layers.flatMap((l) =>
      l.items.flatMap((i) => i.statuses),
    );
    expect(allStatuses.length).toBeGreaterThan(0);
    // status は「発表」「継続」のいずれかが含まれる
    const statusValues = allStatuses.map((s) => s.status);
    const hasExpectedStatus = statusValues.some(
      (s) => s === "発表" || s === "継続",
    );
    expect(hasExpectedStatus).toBe(true);
  });

  it("Item の changeStatus が抽出される (Body.Warning 由来)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW56_DOSHA);
    const result = parseWeatherWarning(msg);
    const allItems = result!.layers.flatMap((l) => l.items);
    const hasChangeStatus = allItems.some((i) => i.changeStatus != null);
    expect(hasChangeStatus).toBe(true);
  });

  // ── 同 Item 内の Kind 重複防止 (R1 指摘 #4 の regression 防止) ──

  it("同 Item 内の Kind 重複追加が起きない", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW61_OTHER);
    const result = parseWeatherWarning(msg);
    for (const layer of result!.layers) {
      for (const item of layer.items) {
        const codes = item.kinds.map((k) => k.code);
        const unique = new Set(codes);
        expect(unique.size).toBe(codes.length);
      }
    }
  });
});

describe("maxDisplaySeverity (Phase C)", () => {
  it("VPWW55 fixture: 大雨警報 (Code 03) を含む電文は officialL3", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW55_OAME);
    const info = parseWeatherWarning(msg)!;
    expect(info.maxDisplaySeverity).toBe("officialL3");
  });

  it("maxSoundLevel が parser で配線される (VPWW55 = officialL3 のみ → warning)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW55_OAME);
    const info = parseWeatherWarning(msg)!;
    expect(info.maxSoundLevel).toBe("warning");
  });

  it("maxSoundLevel: VPWW56 (Code 49 = officialL4 単独) → warning (L4 単独の音は据置)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW56_DOSHA);
    const info = parseWeatherWarning(msg)!;
    expect(info.maxDisplaySeverity).toBe("officialL4");
    expect(info.maxSoundLevel).toBe("warning");
  });

  it("computeMaxDisplaySeverity: 解除 Kind のみのレイヤは null", () => {
    const releaseOnlyLayers = [
      {
        type: "気象警報・注意報（府県予報区等）",
        items: [
          {
            areaName: "テスト地域",
            areaCode: "010000",
            kinds: [{ code: "00", name: "解除", severity: "release" as const }],
            statuses: [],
          },
        ],
      },
    ];
    expect(computeMaxDisplaySeverity(releaseOnlyLayers)).toBeNull();
  });
});

describe("parseWeatherWarning acceptance boundary", () => {
  it.each([
    ["Head", "<Report />"],
    ["InfoType", "<Report><Head><Title>test</Title></Head></Report>"],
    ["Title", "<Report><Head><InfoType>test</InfoType></Head></Report>"],
  ])("returns null when %s is missing", (_, xml) => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW55_OAME);
    msg.body = encodeXml(xml);

    expect(parseWeatherWarning(msg)).toBeNull();
  });

  it("returns null for a non-weather header type", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW55_OAME);
    msg.head.type = "VPBS50";

    expect(parseWeatherWarning(msg)).toBeNull();
  });
});
