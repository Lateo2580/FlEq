import { describe, it, expect } from "vitest";
import {
  parseTornadoAdvisory,
  selectPreferredTornadoLayer,
} from "../../src/dmdata/tornado-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VPHW50_TOKYO,
  FIXTURE_VPHW50_ALT,
  FIXTURE_VPHW51_SIGHTING,
  encodeXml,
} from "../helpers/mock-message";

describe("selectPreferredTornadoLayer", () => {
  it("空配列なら undefined", () => {
    expect(selectPreferredTornadoLayer([])).toBeUndefined();
  });

  it("市町村等を最優先で選ぶ", () => {
    const layers = [
      { type: "竜巻注意情報（発表細分）", areas: [] },
      { type: "竜巻注意情報（一次細分区域等）", areas: [] },
      { type: "竜巻注意情報（市町村等をまとめた地域等）", areas: [] },
      { type: "竜巻注意情報（市町村等）", areas: [] },
    ];
    expect(selectPreferredTornadoLayer(layers)?.type).toBe(
      "竜巻注意情報（市町村等）",
    );
  });

  it("「まとめた」を含む層は「市町村等」優先と誤マッチしない", () => {
    const layers = [
      { type: "竜巻注意情報（市町村等をまとめた地域等）", areas: [] },
    ];
    expect(selectPreferredTornadoLayer(layers)?.type).toBe(
      "竜巻注意情報（市町村等をまとめた地域等）",
    );
  });
});

describe("parseTornadoAdvisory", () => {
  it("VPHW50 を正しくパースする", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW50_TOKYO);
    const result = parseTornadoAdvisory(msg);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("VPHW50");
    expect(result!.infoType).toBe("発表");
    expect(result!.title).toContain("竜巻注意情報");
    expect(result!.headline).not.toBeNull();
    expect(result!.isTest).toBe(false);
    expect(result!.layers.length).toBeGreaterThan(0);
  });

  it("VPHW50 で ValidDateTime が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW50_TOKYO);
    const result = parseTornadoAdvisory(msg);
    expect(result!.validDateTime).not.toBeNull();
    expect(result!.validDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("VPHW50 で Serial が抽出される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW50_TOKYO);
    const result = parseTornadoAdvisory(msg);
    expect(result!.serial).toBe("2");
  });

  it('「なし」の地域は集計・表示対象から除外される (Code 0 フィルタ)', () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW50_TOKYO);
    const result = parseTornadoAdvisory(msg);

    // 全 layer の areas に「なし」status は含まれないはず
    const allAreas = result!.layers.flatMap((l) => l.areas);
    const allActive = allAreas.every((a) => a.status === "active");
    expect(allActive).toBe(true);
  });

  it("VPHW50 では isSightingTelegram=false / hasSightingAreas=false / sightingAreas=[]", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW50_TOKYO);
    const result = parseTornadoAdvisory(msg);
    expect(result!.isSightingTelegram).toBe(false);
    expect(result!.hasSightingAreas).toBe(false);
    expect(result!.sightingAreas).toEqual([]);
  });

  it("VPHW51 で isSightingTelegram=true / hasSightingAreas=true / sightingAreas 抽出", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW51_SIGHTING);
    const result = parseTornadoAdvisory(msg);

    expect(result!.type).toBe("VPHW51");
    expect(result!.isSightingTelegram).toBe(true);
    expect(result!.hasSightingAreas).toBe(true);
    expect(result!.sightingAreas.length).toBeGreaterThan(0);
  });

  it("VPHW51 のヘッドラインに【目撃情報あり】が含まれる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW51_SIGHTING);
    const result = parseTornadoAdvisory(msg);
    expect(result!.headline).toContain("目撃情報あり");
  });

  it("activeAreaCount は market layer の地域数と一致する", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW50_TOKYO);
    const result = parseTornadoAdvisory(msg);
    const preferred = selectPreferredTornadoLayer(result!.layers);
    expect(result!.activeAreaCount).toBe(preferred!.areas.length);
    expect(result!.activeAreaCount).toBeGreaterThan(0);
  });

  it("Area.Code が文字列として保持される (parseTagValue: false の検証)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW50_TOKYO);
    const result = parseTornadoAdvisory(msg);
    const allCodes = result!.layers.flatMap((l) => l.areas.map((a) => a.code));
    // すべて string 型で、6 桁以上 (市町村コード) または 6 桁 (細分コード) の体系を保つ
    for (const code of allCodes) {
      expect(typeof code).toBe("string");
      expect(code.length).toBeGreaterThanOrEqual(6);
    }
  });

  it("publishingOffice / editorialOffice / controlTitle が取得される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW50_TOKYO);
    const result = parseTornadoAdvisory(msg);
    expect(result!.publishingOffice).toBeTruthy();
    expect(result!.editorialOffice).toBeTruthy();
    expect(result!.controlTitle).toBeTruthy();
  });

  it("別パターンの VPHW50 (FIXTURE_VPHW50_ALT) もパースできる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW50_ALT);
    const result = parseTornadoAdvisory(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("VPHW50");
    expect(result!.layers.length).toBeGreaterThan(0);
  });

  it("不正なXMLを渡すと null が返る", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW50_TOKYO, {
      body: "invalid-base64-content",
    });
    const result = parseTornadoAdvisory(msg);
    expect(result).toBeNull();
  });
});

describe("Phase D: 2 系統フィールド", () => {
  it("VPHW51 (目撃あり): displaySeverity=nonLevelSpecial / soundLevel=warning", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW51_SIGHTING);
    const result = parseTornadoAdvisory(msg)!;
    expect(result.displaySeverity).toBe("nonLevelSpecial");
    expect(result.soundLevel).toBe("warning");
  });

  it("VPHW50 (通常発表): displaySeverity=nonLevelWarning / soundLevel=warning", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW50_TOKYO);
    const result = parseTornadoAdvisory(msg)!;
    expect(result.displaySeverity).toBe("nonLevelWarning");
    expect(result.soundLevel).toBe("warning");
  });
});

// ── route / process / event の配線スモーク ──

describe("tornado route integration smoke", () => {
  it("VPHW51 が processTornado → fromTornadoOutcome を通って critical frame になる", async () => {
    const { processTornado } = await import(
      "../../src/engine/presentation/processors/process-tornado"
    );
    const { fromTornadoOutcome } = await import(
      "../../src/engine/presentation/events/from-tornado"
    );

    const msg = createMockWsDataMessage(FIXTURE_VPHW51_SIGHTING);
    const outcome = processTornado(msg);
    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("tornado");
    expect(outcome!.statsCategory).toBe("tornado");
    expect(outcome!.presentation.notifyCategory).toBe("tornado");
    expect(outcome!.presentation.frameLevel).toBe("critical");
    // 2026-06-12 レビュー決定: 特別警報級でも特別警報の名を持たなければ音は warning
    expect(outcome!.presentation.soundLevel).toBe("warning");

    const event = fromTornadoOutcome(outcome!);
    expect(event.domain).toBe("tornado");
    expect(event.type).toBe("VPHW51");
    expect(event.isWarning).toBe(true);
    // 目撃情報は event.raw 経由で取得する設計 (PresentationEvent フィールドは流用しない)
    const rawInfo = event.raw as { hasSightingAreas?: boolean; sightingAreas?: unknown[] };
    expect(rawInfo.hasSightingAreas).toBe(true);
    expect(Array.isArray(rawInfo.sightingAreas)).toBe(true);
    expect((rawInfo.sightingAreas as unknown[]).length).toBeGreaterThan(0);
    // municipalityNames は使わない設計
    expect(event.municipalityNames).toEqual([]);
  });

  it("VPHW51 フェイルセーフ (目撃地域抽出失敗) でも event.isWarning が true (安全側昇格が event 出口で潰れない)", async () => {
    const { processTornado } = await import(
      "../../src/engine/presentation/processors/process-tornado"
    );
    const { fromTornadoOutcome } = await import(
      "../../src/engine/presentation/events/from-tornado"
    );

    // VPHW51 (目撃電文) を通常通り process。これは frameLevel=critical になる。
    const msg = createMockWsDataMessage(FIXTURE_VPHW51_SIGHTING);
    const outcome = processTornado(msg);
    expect(outcome).not.toBeNull();

    // フェイルセーフ状態 (目撃電文だが地域抽出に失敗) を再現:
    //   activeAreaCount=0 / hasSightingAreas=false / sightingAreas=[] でも
    //   displaySeverity=nonLevelSpecial (resolveTornadoSeverity が isSightingTelegram
    //   単独 true で安全側に上げる) なので frameLevel は critical のまま。
    outcome!.parsed.activeAreaCount = 0;
    outcome!.parsed.hasSightingAreas = false;
    outcome!.parsed.sightingAreas = [];
    expect(outcome!.presentation.frameLevel).toBe("critical");

    // 旧実装 (isWarning: activeAreaCount > 0) では false に落ちていた箇所。
    const event = fromTornadoOutcome(outcome!);
    expect(event.isWarning).toBe(true);
  });

  it("VPHW50 が processTornado → frameLevel=warning になる (目撃情報なし)", async () => {
    const { processTornado } = await import(
      "../../src/engine/presentation/processors/process-tornado"
    );
    const msg = createMockWsDataMessage(FIXTURE_VPHW50_TOKYO);
    const outcome = processTornado(msg);
    expect(outcome).not.toBeNull();
    expect(outcome!.presentation.frameLevel).toBe("warning");
    expect(outcome!.presentation.soundLevel).toBe("warning");
  });
});

describe("parseTornadoAdvisory acceptance boundary", () => {
  it.each([
    ["Head", "<Report />"],
    ["InfoType", "<Report><Head><Title>test</Title></Head></Report>"],
    ["Title", "<Report><Head><InfoType>test</InfoType></Head></Report>"],
  ])("returns null when %s is missing", (_, xml) => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW50_TOKYO);
    msg.body = encodeXml(xml);

    expect(parseTornadoAdvisory(msg)).toBeNull();
  });

  it("returns null for a non-tornado header type", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPHW50_TOKYO);
    msg.head.type = "VPWW55";

    expect(parseTornadoAdvisory(msg)).toBeNull();
  });
});
