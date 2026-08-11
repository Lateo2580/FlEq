import { describe, expect, it } from "vitest";
import {
  buildTickerDetail,
  groupIntensityAreas,
  normalizeDepth,
  projectDisplayEvent,
  projectQuakeMapCommand,
  tickerPriority,
  tickerSurface,
} from "../../../src/engine/display/project-event";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import type { JmaIntensity, JmaLgIntensity, SpecialValue } from "../../../src/types";

describe("normalizeDepth", () => {
  it("null/undefined は null になる", () => {
    expect(normalizeDepth(null)).toBeNull();
    expect(normalizeDepth(undefined)).toBeNull();
  });

  it("空文字は null になる", () => {
    expect(normalizeDepth("")).toBeNull();
  });

  it("既に「30km」形式ならそのまま返す (パーサが既に正規化済み)", () => {
    expect(normalizeDepth("30km")).toBe("30km");
  });

  it("「ごく浅い」等の記述はそのまま返す", () => {
    expect(normalizeDepth("ごく浅い")).toBe("ごく浅い");
  });

  it("数値のみの文字列は km を補う (防御的正規化)", () => {
    expect(normalizeDepth("10")).toBe("10km");
  });
});

describe("projectQuakeMapCommand", () => {
  const nowMs = Date.parse("2026-07-30T12:00:00+09:00");
  const intensity = {
    localAreas: [{ name: "local", code: "440", maxInt: "5-", maxIntRank: 5 }],
    municipalities: [{ name: "city", code: "2230600", maxInt: "5-", maxIntRank: 5 }],
  };

  it("earthquake の code/rank を internal upsert にだけ載せる", () => {
    const event = baseEvent({
      eventId: "E1",
      serial: "2",
      maxInt: "5-",
      maxIntRank: 5,
      quakeIntensity: intensity,
      areaItems: [{ name: "local", code: "440", maxInt: "5-" }],
    });
    const command = projectQuakeMapCommand(event, nowMs);
    expect(command).toEqual(expect.objectContaining({
      kind: "upsert",
      sourceType: "VXSE53",
      revision: { reportTimeMs: Date.parse(event.reportDateTime), serial: "2" },
      event: expect.objectContaining({
        eventKey: "earthquake:E1",
        localAreas: [{ code: "440", rank: 5 }],
      }),
    }));
    const dto = projectDisplayEvent(event, "summary", command);
    expect(JSON.stringify(dto)).not.toContain('"code":"440"');
    expect(dto.emergency).toEqual(expect.objectContaining({
      mapEventKey: "earthquake:E1",
      mapSourceType: "VXSE53",
      mapRevision: command?.revision,
    }));
  });

  it("registry 受理済み取消・描画不能な明示震度・震度2訂正は旧 map を remove", () => {
    expect(projectQuakeMapCommand(baseEvent({
      eventId: "E1",
      serial: "2",
      isCancellation: true,
      foundationResolvedTrigger: "explicitCancellation",
      foundationCancellationPolicy: "markCancelled",
    }), nowMs)).toEqual(expect.objectContaining({
      kind: "remove", eventKey: "earthquake:E1", reason: "cancelled",
    }));
    expect(projectQuakeMapCommand(baseEvent({
      eventId: "E1", serial: "2", maxInt: "4", maxIntRank: 4,
    }), nowMs)).toEqual(expect.objectContaining({
      kind: "remove", eventKey: "earthquake:E1", reason: "nonExact",
    }));
    expect(projectQuakeMapCommand(baseEvent({
      eventId: "E1",
      serial: "3",
      maxInt: "2",
      maxIntRank: 2,
      quakeIntensity: {
        localAreas: [{ name: "local", code: "440", maxInt: "2", maxIntRank: 2 }],
        municipalities: [],
      },
    }), nowMs)).toEqual(expect.objectContaining({
      kind: "remove", eventKey: "earthquake:E1", reason: "belowThreshold",
    }));
    expect(projectQuakeMapCommand(baseEvent({
      eventId: "E1",
      type: "VXSE52",
      serial: "4",
      maxInt: null,
      maxIntRank: null,
      maxIntValue: {
        raw: null, value: null, condition: null, description: null, presence: "missing",
      },
      areaItems: [],
    }), nowMs)).toEqual(expect.objectContaining({
      kind: "remove", eventKey: "earthquake:E1", reason: "structuralMissing",
      eventUpdate: expect.objectContaining({ eventId: "E1", updatedAtMs: nowMs }),
    }));
  });

  it("EventID 欠落は同一受信時刻でも一意な単発 key にし、取消とは結合しない", () => {
    const event = baseEvent({
      eventId: null,
      maxInt: "4",
      maxIntRank: 4,
      quakeIntensity: {
        localAreas: [{ name: "local", code: "440", maxInt: "4", maxIntRank: 4 }],
        municipalities: [],
      },
    });
    const first = projectQuakeMapCommand(event, nowMs);
    const second = projectQuakeMapCommand(event, nowMs);
    expect(first?.kind === "upsert" ? first.event.eventKey : null)
      .not.toBe(second?.kind === "upsert" ? second.event.eventKey : null);
    expect(projectQuakeMapCommand({ ...event, isCancellation: true }, nowMs)).toBeNull();
    expect(projectQuakeMapCommand({ ...event, eventId: "", isCancellation: true }, nowMs)).toBeNull();
  });

  it("無効・未来の reportDateTime は受信時刻へ fallback する", () => {
    for (const reportDateTime of ["invalid", "2099-01-01T00:00:00+09:00"]) {
      const command = projectQuakeMapCommand(baseEvent({
        eventId: "E1",
        serial: "1",
        reportDateTime,
        maxInt: "4",
        maxIntRank: 4,
        quakeIntensity: {
          localAreas: [{ name: "local", code: "440", maxInt: "4", maxIntRank: 4 }],
          municipalities: [],
        },
      }), nowMs);
      expect(command?.revision.reportTimeMs).toBe(nowMs);
    }
  });

  it("earthquake 以外は対象外", () => {
    expect(projectQuakeMapCommand(baseEvent({ domain: "weather" }), nowMs)).toBeNull();
  });

  it("5弱以上未入電は lower rank 5 で地図を発火し ≥ semantic を載せる", () => {
    const value: SpecialValue<JmaIntensity> = {
      raw: "",
      value: null,
      condition: "5弱以上未入電",
      description: null,
      presence: "qualitative",
      lowerBound: "5-",
    };
    const command = projectQuakeMapCommand(baseEvent({
      eventId: "qualitative",
      maxIntValue: value,
      maxInt: null,
      maxIntRank: null,
      areaItems: [{ name: "地域A", code: "440", maxIntValue: value }],
      quakeIntensityValues: {
        localAreas: [{ name: "地域A", code: "440", maxIntValue: value }],
        municipalities: [],
      },
    }), nowMs);
    expect(command).toMatchObject({
      kind: "upsert",
      event: {
        maxIntRank: 5,
        maxIntSemantic: {
          presence: "qualitative", label: "5弱以上未入電", badge: "≥",
          color: "safetyRank", colorRank: 5, safetyLowerRank: 5,
          condition: "5弱以上未入電",
        },
        localAreas: [{
          code: "440", rank: 5,
          intensitySemantic: { presence: "qualitative", badge: "≥", colorRank: 5 },
        }],
      },
    });
  });

  it("range は lower で地図発火を判定し upper 色＋↔ semantic を載せる", () => {
    const value: SpecialValue<JmaIntensity> = {
      raw: "",
      value: null,
      condition: null,
      description: "震度3から5弱",
      presence: "range",
      lowerBound: "3",
      upperBound: "5-",
    };
    const command = projectQuakeMapCommand(baseEvent({
      eventId: "range",
      maxIntValue: value,
      areaItems: [{ name: "地域A", code: "440", maxIntValue: value }],
      quakeIntensityValues: {
        localAreas: [{ name: "地域A", code: "440", maxIntValue: value }],
        municipalities: [],
      },
    }), nowMs);
    expect(command).toMatchObject({
      kind: "upsert",
      event: {
        maxIntRank: 5,
        localAreas: [{
          code: "440", rank: 5,
          intensitySemantic: {
            presence: "range", badge: "↔", color: "safetyUpperRank",
            safetyLowerRank: 3, safetyUpperRank: 5, colorRank: 5,
          },
        }],
      },
    });
  });

  it("mixed 報は unknown/empty を負 rank semantic で載せ、missing だけを除外する", () => {
    const exact: SpecialValue<JmaIntensity> = {
      raw: "4", value: "4", condition: null, description: null, presence: "value",
    };
    const unknown: SpecialValue<JmaIntensity> = {
      raw: "", value: null, condition: "未入電", description: null, presence: "unknown",
    };
    const empty: SpecialValue<JmaIntensity> = {
      raw: "", value: null, condition: null, description: null, presence: "empty",
    };
    const missing: SpecialValue<JmaIntensity> = {
      raw: null, value: null, condition: null, description: null, presence: "missing",
    };
    const values = [
      { name: "exact", code: "440", maxIntValue: exact },
      { name: "unknown", code: "441", maxIntValue: unknown },
      { name: "empty", code: "442", maxIntValue: empty },
      { name: "missing", code: "443", maxIntValue: missing },
    ];
    const command = projectQuakeMapCommand(baseEvent({
      eventId: "mixed",
      maxIntValue: exact,
      maxInt: "4",
      maxIntRank: 4,
      areaItems: values,
      quakeIntensityValues: { localAreas: values, municipalities: [] },
    }), nowMs);
    expect(command?.kind).toBe("upsert");
    const localAreas = command?.kind === "upsert" ? command.event.localAreas : [];
    expect(localAreas).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "440", rank: 4 }),
      expect.objectContaining({
        code: "441", rank: -1,
        intensitySemantic: expect.objectContaining({ presence: "unknown", badge: "?", color: "unknown" }),
      }),
      expect.objectContaining({
        code: "442", rank: -1,
        intensitySemantic: expect.objectContaining({ presence: "empty", badge: "∅", color: "neutral" }),
      }),
    ]));
    expect(localAreas.some((area) => area.code === "443")).toBe(false);
  });

  it("全体 MaxInt missing でも地域 exact があれば地域値で地図 gate と旧 scalar を構成する", () => {
    const missing: SpecialValue<JmaIntensity> = {
      raw: null, value: null, condition: null, description: null, presence: "missing",
    };
    const exact: SpecialValue<JmaIntensity> = {
      raw: "4", value: "4", condition: null, description: null, presence: "value",
    };
    const command = projectQuakeMapCommand(baseEvent({
      eventId: "local-exact",
      maxIntValue: missing,
      maxInt: null,
      maxIntRank: null,
      areaItems: [{ name: "地域A", code: "440", maxIntValue: exact }],
      quakeIntensityValues: {
        localAreas: [{ name: "地域A", code: "440", maxIntValue: exact }],
        municipalities: [],
      },
    }), nowMs);
    expect(command).toMatchObject({
      kind: "upsert",
      event: {
        maxInt: "4",
        maxIntRank: 4,
        reportedMaxIntSemantic: { presence: "missing", render: false },
        localAreas: [{ code: "440", rank: 4 }],
      },
    });
    expect(command?.kind === "upsert" ? command.event.maxIntSemantic : undefined).toBeUndefined();
  });

  it.each([
    ["unknown", { raw: "", value: null, condition: "未入電", description: null, presence: "unknown" }],
    ["empty", { raw: "", value: null, condition: null, description: null, presence: "empty" }],
  ] as const)("%s-only 報は地図を発火しない", (_label, specialValue) => {
    const value = specialValue as SpecialValue<JmaIntensity>;
    expect(projectQuakeMapCommand(baseEvent({
      eventId: `only-${specialValue.presence}`,
      maxIntValue: value,
      areaItems: [{ name: "地域A", code: "440", maxIntValue: value }],
      quakeIntensityValues: {
        localAreas: [{ name: "地域A", code: "440", maxIntValue: value }],
        municipalities: [],
      },
    }), nowMs)).toMatchObject({ kind: "remove", reason: "nonExact" });
  });
});

describe("groupIntensityAreas", () => {
  it("震度文字列の空白を除去して同じグループへまとめる", () => {
    expect(groupIntensityAreas([
      { name: "熊本県熊本地方", maxInt: "6強" },
      { name: "熊本県阿蘇地方", maxInt: "6強 " },
    ])).toEqual([{
      intensity: "6強",
      rank: 8,
      areas: ["熊本県熊本地方", "熊本県阿蘇地方"],
      omittedAreaCount: 0,
    }]);
  });

  it("SpecialValue の qualifier/badge/color をカード group に保持し missing は除外する", () => {
    const groups = groupIntensityAreas([
      {
        name: "qualitative",
        maxIntValue: {
          raw: "", value: null, condition: "5弱以上未入電", description: null,
          presence: "qualitative", lowerBound: "5-",
        },
      },
      {
        name: "unknown",
        maxIntValue: {
          raw: "", value: null, condition: "未入電", description: null, presence: "unknown",
        },
      },
      {
        name: "empty",
        maxIntValue: {
          raw: "", value: null, condition: null, description: null, presence: "empty",
        },
      },
      {
        name: "missing",
        maxIntValue: {
          raw: null, value: null, condition: null, description: null, presence: "missing",
        },
      },
    ]);
    expect(groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        intensity: "5弱以上未入電", rank: 5, areas: ["qualitative"],
        intensitySemantic: expect.objectContaining({ badge: "≥", color: "safetyRank" }),
      }),
      expect.objectContaining({
        rank: -1, areas: ["unknown"],
        intensitySemantic: expect.objectContaining({ presence: "unknown", badge: "?" }),
      }),
      expect.objectContaining({
        rank: -1, areas: ["empty"],
        intensitySemantic: expect.objectContaining({ presence: "empty", badge: "∅" }),
      }),
    ]));
    expect(groups.some((group) => group.areas.includes("missing"))).toBe(false);
  });

  it("同一 label の semantic 差は一つの legacy-safe group に束ねる", () => {
    const groups = groupIntensityAreas([
      {
        name: "地域A",
        maxIntValue: {
          raw: "5弱以上未入電", value: null, condition: "5弱以上未入電",
          description: "説明A", presence: "qualitative", lowerBound: "5-",
        },
      },
      {
        name: "地域B",
        maxIntValue: {
          raw: " 5弱以上未入電 ", value: null, condition: "5弱以上未入電",
          description: "説明B", presence: "qualitative", lowerBound: "5-",
          rawLowerBound: "５－",
        },
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      intensity: "5弱以上未入電",
      rank: 5,
      areas: ["地域A", "地域B"],
      intensitySemantic: {
        raw: "5弱以上未入電",
        description: "説明A",
        presence: "qualitative",
      },
    });
  });
});

function baseEvent(over: Partial<PresentationEvent>): PresentationEvent {
  return {
    id: "msg-1", classification: "telegram.earthquake", domain: "earthquake",
    type: "VXSE53", infoType: "発表", title: "震源・震度情報", headline: null,
    reportDateTime: "2026-07-06T21:00:00+09:00", publishingOffice: "気象庁",
    isTest: false, frameLevel: "warning", isCancellation: false,
    areaNames: [], forecastAreaNames: [], municipalityNames: [], observationNames: [],
    areaCount: 0, forecastAreaCount: 0, municipalityCount: 0, observationCount: 0,
    areaItems: [], raw: null,
    ...over,
  } as PresentationEvent;
}

describe("projectDisplayEvent tickerEmphasis (重要語句強調、backlog §3)", () => {
  it("情報系 (low 優先) の本文は数値+単位を強調区間として付ける", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "weatherExplanation", type: "VPZJ51", frameLevel: "normal",
        bodyText: "中心気圧は970hPa、最大風速は25m/sの見込み。",
      }),
      "台風解説",
    );
    expect(dto.tickerPriority).toBe("low");
    expect(dto.tickerEmphasis).not.toBeNull();
    const marked = dto.tickerEmphasis!.map((s) => dto.tickerBody!.slice(s.start, s.end));
    expect(marked).toEqual(["970hPa", "25m/s"]);
  });

  it("警報級 (high/mid) には強調を付けない (severity 意匠と干渉させない)", () => {
    // 震度5弱 = high。本文に数値があっても tickerEmphasis は null
    const dto = projectDisplayEvent(
      baseEvent({ domain: "earthquake", maxIntRank: 5, maxInt: "5弱", bodyText: "最大震度5弱、M6.5。" }),
      "地震情報",
    );
    expect(dto.tickerPriority).toBe("high");
    expect(dto.tickerEmphasis).toBeNull();
  });

  it("数値が無い情報系本文は tickerEmphasis を null にする (空配列で埋めない)", () => {
    const dto = projectDisplayEvent(
      baseEvent({ domain: "weatherExplanation", type: "VPZJ51", frameLevel: "normal", bodyText: "警戒を呼びかけています。" }),
      "解説",
    );
    expect(dto.tickerPriority).toBe("low");
    expect(dto.tickerEmphasis).toBeNull();
  });

  it("本文が無ければ tickerBody・tickerEmphasis とも null", () => {
    const dto = projectDisplayEvent(
      baseEvent({ domain: "weatherExplanation", type: "VPZJ51", frameLevel: "normal", bodyText: null }),
      "解説",
    );
    expect(dto.tickerBody).toBeNull();
    expect(dto.tickerEmphasis).toBeNull();
  });
});

describe("buildTickerDetail", () => {
  it("地震系 (maxInt) は震度の大きい順にグルーピングする", () => {
    const detail = buildTickerDetail(
      baseEvent({
        domain: "earthquake",
        headline: null,
        areaItems: [
          { name: "宮城県北部", maxInt: "3" },
          { name: "福島県中通り", maxInt: "3" },
          { name: "岩手県沿岸南部", maxInt: "4" },
        ],
      }),
    );
    expect(detail).toBe("震度4: 岩手県沿岸南部／震度3: 宮城県北部、福島県中通り");
  });

  it("気象警報・津波系 (kind) は kind ごとにグルーピングする", () => {
    const detail = buildTickerDetail(
      baseEvent({
        domain: "weather",
        headline: null,
        areaItems: [
          { name: "山鹿市", kind: "大雨警報(土砂災害)" },
          { name: "菊池市", kind: "大雨警報(土砂災害)" },
          { name: "球磨川流域", kind: "洪水警報" },
        ],
      }),
    );
    expect(detail).toBe("大雨警報(土砂災害): 山鹿市、菊池市／洪水警報: 球磨川流域");
  });

  it("maxInt/kind どちらも無ければ地域名だけを列挙する", () => {
    const detail = buildTickerDetail(
      baseEvent({
        domain: "tsunami",
        headline: null,
        areaItems: [{ name: "岩手県" }, { name: "宮城県" }],
      }),
    );
    expect(detail).toBe("岩手県、宮城県");
  });

  it.each(["", " "])("空の maxInt (%j) は無視して地域名だけを列挙する", (maxInt) => {
    const detail = buildTickerDetail(
      baseEvent({
        domain: "earthquake",
        headline: null,
        areaItems: [{ name: "熊本県熊本地方", maxInt }],
      }),
    );
    expect(detail).toBe("熊本県熊本地方");
  });

  it("空白のみの maxInt は無視して kind グループへ進む", () => {
    const detail = buildTickerDetail(
      baseEvent({
        domain: "weather",
        headline: null,
        areaItems: [{ name: "山鹿市", maxInt: " ", kind: "大雨警報" }],
      }),
    );
    expect(detail).toBe("大雨警報: 山鹿市");
  });

  it("headline のみでも詳細文になる (areaItems 空)", () => {
    const detail = buildTickerDetail(
      baseEvent({ domain: "weather", headline: "大雨警報が発表されました", areaItems: [] }),
    );
    expect(detail).toBe("大雨警報が発表されました");
  });

  it("headline と areaItems の両方あれば「 ▪ 」で連結する", () => {
    const detail = buildTickerDetail(
      baseEvent({
        domain: "weather",
        headline: "土砂災害に警戒してください",
        areaItems: [{ name: "山鹿市", kind: "大雨警報" }],
      }),
    );
    expect(detail).toBe("土砂災害に警戒してください ▪ 大雨警報: 山鹿市");
  });

  it("headline も areaItems も空なら null になる", () => {
    const detail = buildTickerDetail(baseEvent({ domain: "weather", headline: null, areaItems: [] }));
    expect(detail).toBeNull();
  });

  it("長文でも打ち切らず全量保持する (2026-07-07 レビュー決定: 200 文字上限は撤廃)", () => {
    const manyAreas = Array.from({ length: 50 }, (_, i) => ({ name: `地域${i}`, kind: "大雨警報" }));
    const detail = buildTickerDetail(baseEvent({ domain: "weather", headline: null, areaItems: manyAreas }));
    expect(detail).not.toBeNull();
    expect(detail).toContain("地域0");
    expect(detail).toContain("地域49");
    expect(detail!.length).toBeGreaterThan(200);
  });

  it("EEW ドメインは headline/areaItems があっても null になる", () => {
    const detail = buildTickerDetail(
      baseEvent({
        domain: "eew",
        headline: "強い揺れに警戒してください",
        areaItems: [{ name: "宮崎県", maxInt: "6弱" }],
      }),
    );
    expect(detail).toBeNull();
  });
});

describe("tickerPriority (§2-1 境界値)", () => {
  it("EEW 警報 = high / EEW 予報 = mid", () => {
    expect(tickerPriority(baseEvent({ domain: "eew", isWarning: true }))).toBe("high");
    expect(tickerPriority(baseEvent({ domain: "eew", isWarning: false }))).toBe("mid");
  });

  it("大津波警報・津波警報 = high / 津波注意報・津波予報 = mid", () => {
    expect(tickerPriority(baseEvent({ domain: "tsunami", tsunamiKinds: ["大津波警報"] }))).toBe("high");
    expect(tickerPriority(baseEvent({ domain: "tsunami", tsunamiKinds: ["津波警報"] }))).toBe("high");
    expect(tickerPriority(baseEvent({ domain: "tsunami", tsunamiKinds: ["津波注意報"] }))).toBe("mid");
    expect(tickerPriority(baseEvent({
      domain: "tsunami",
      tsunamiKinds: ["津波予報（若干の海面変動）"],
    }))).toBe("mid");
  });

  it("震度5弱以上 = high / 震度4以下 = mid", () => {
    expect(tickerPriority(baseEvent({ domain: "earthquake", maxIntRank: 5 }))).toBe("high");
    expect(tickerPriority(baseEvent({ domain: "earthquake", maxIntRank: 4 }))).toBe("mid");
  });

  it.each([
    ["range 3〜5弱", { raw: null, value: null, condition: null, description: null, presence: "range" as const, lowerBound: "3" as const, upperBound: "5-" as const }],
    ["5弱以上未入電", { raw: "", value: null, condition: "5弱以上未入電", description: null, presence: "qualitative" as const, lowerBound: "5-" as const }],
  ])("%s は exact maxIntRank がなくても safety rank で high", (_label, maxIntValue) => {
    expect(tickerPriority(baseEvent({
      domain: "earthquake",
      maxInt: null,
      maxIntRank: null,
      maxIntValue,
    }))).toBe("high");
  });

  it("取消 = low (ドメインに関わらず)", () => {
    expect(tickerPriority(baseEvent({ domain: "eew", isWarning: true, isCancellation: true }))).toBe("low");
    expect(tickerPriority(baseEvent({ domain: "tsunami", tsunamiKinds: ["大津波警報"], isCancellation: true }))).toBe("low");
  });

  it("解説系 (weatherExplanation, frameLevel=normal) = low", () => {
    expect(tickerPriority(baseEvent({ domain: "weatherExplanation", frameLevel: "normal" }))).toBe("low");
  });

  it("気象 特別警報級 (critical) = high / 警報級 (warning) = mid / info = low", () => {
    expect(tickerPriority(baseEvent({ domain: "weather", frameLevel: "critical" }))).toBe("high");
    expect(tickerPriority(baseEvent({ domain: "weather", frameLevel: "warning" }))).toBe("mid");
    expect(tickerPriority(baseEvent({ domain: "weather", frameLevel: "info" }))).toBe("low");
  });

  it("解除相当 (frameLevel=cancel、isCancellation なし) = low", () => {
    expect(tickerPriority(baseEvent({ domain: "weather", frameLevel: "cancel", isCancellation: false }))).toBe("low");
  });

  it("訓練/テスト電文でも frameLevel=critical なら high (isTest は優先度を下げない)", () => {
    expect(tickerPriority(baseEvent({ domain: "weather", frameLevel: "critical", isTest: true }))).toBe("high");
  });

  it("南海トラフ critical = high / warning = mid (frameLevel 分岐)", () => {
    expect(tickerPriority(baseEvent({ domain: "nankaiTrough", frameLevel: "critical" }))).toBe("high");
    expect(tickerPriority(baseEvent({ domain: "nankaiTrough", frameLevel: "warning" }))).toBe("mid");
  });

  it("長周期地震動 LgInt4 (critical) = high / LgInt3 (warning) = mid (lgObservation は frameLevel 分岐)", () => {
    expect(tickerPriority(baseEvent({ domain: "lgObservation", frameLevel: "critical" }))).toBe("high");
    expect(tickerPriority(baseEvent({ domain: "lgObservation", frameLevel: "warning" }))).toBe("mid");
  });
});

describe("tickerSurface (engine 権威)", () => {
  it("大津波・気象 L5 相当・震度 7 だけが solid になる", () => {
    expect(tickerSurface(baseEvent({ domain: "tsunami", tsunamiKinds: ["大津波警報"] }))).toBe("solid");
    expect(tickerSurface(baseEvent({
      domain: "weather",
      raw: { maxDisplaySeverity: "officialL5" } as never,
    }))).toBe("solid");
    expect(tickerSurface(baseEvent({ domain: "earthquake", maxIntRank: 9 }))).toBe("solid");
  });

  it("津波警報・L4・震度 6 強・取消は none になる", () => {
    expect(tickerSurface(baseEvent({ domain: "tsunami", tsunamiKinds: ["津波警報"] }))).toBe("none");
    expect(tickerSurface(baseEvent({ domain: "weather", raw: { maxDisplaySeverity: "officialL4" } as never }))).toBe("none");
    expect(tickerSurface(baseEvent({ domain: "earthquake", maxIntRank: 8 }))).toBe("none");
    expect(tickerSurface(baseEvent({ domain: "earthquake", maxIntRank: 9, isCancellation: true }))).toBe("none");
  });
});

describe("projectDisplayEvent", () => {
  const giantMagnitude: SpecialValue<number> = {
    raw: "NaN",
    value: null,
    condition: "不明",
    description: "Ｍ８を超える巨大地震",
    presence: "qualitative",
  };
  const boundedDepth: SpecialValue<number> = {
    raw: "-600000",
    value: null,
    condition: "以上",
    description: "深さ600km以上",
    presence: "range",
    lowerBound: 600,
  };

  it("Magnitude/Depth semantic を recent/latest/map/largeQuake へ JSON-safe に射影する", () => {
    const event = baseEvent({
      eventId: "Q-semantic",
      serial: "2",
      maxInt: "5弱",
      maxIntRank: 5,
      hypocenterName: "震源A",
      magnitude: "M8 を超える巨大地震",
      magnitudeValue: giantMagnitude,
      depth: "600km",
      depthValue: boundedDepth,
      areaItems: [{ name: "地域A", code: "440", maxInt: "5弱" }],
    });
    const command = projectQuakeMapCommand(event, Date.parse(event.reportDateTime));
    expect(command).toMatchObject({
      kind: "upsert",
      event: {
        magnitude: "M8 を超える巨大地震",
        magnitudeSemantic: {
          raw: "NaN",
          presence: "qualitative",
          label: "M8 を超える巨大地震",
          value: null,
          lowerBound: null,
          upperBound: null,
          badge: "?",
          color: "unknown",
          render: true,
          rank: { kind: "giant" },
        },
        depth: "600km",
        depthSemantic: {
          raw: "-600000",
          presence: "range",
          label: "600km以上",
          value: null,
          lowerBound: 600,
          upperBound: null,
          badge: "≥",
          color: "safetyRank",
          render: true,
        },
      },
    });

    const dto = projectDisplayEvent(event, "semantic", command);
    for (const projection of [dto.recentQuake, dto.latestQuake, dto.emergency]) {
      expect(projection).toMatchObject({
        magnitudeSemantic: { rank: { kind: "giant" } },
        depthSemantic: { lowerBound: 600, upperBound: null },
      });
    }
    const roundTripped = JSON.parse(JSON.stringify(dto)) as typeof dto;
    expect(roundTripped).toMatchObject({
      recentQuake: {
        magnitudeSemantic: { rank: { kind: "giant" } },
        depthSemantic: { lowerBound: 600, upperBound: null },
      },
      latestQuake: {
        magnitudeSemantic: { rank: { kind: "giant" } },
        depthSemantic: { lowerBound: 600, upperBound: null },
      },
      emergency: {
        kind: "largeQuake",
        magnitudeSemantic: { rank: { kind: "giant" } },
        depthSemantic: { lowerBound: 600, upperBound: null },
      },
    });
    const roundTripSemantics = [
      roundTripped.recentQuake?.magnitudeSemantic,
      roundTripped.recentQuake?.depthSemantic,
      roundTripped.latestQuake?.magnitudeSemantic,
      roundTripped.latestQuake?.depthSemantic,
      roundTripped.emergency?.kind === "largeQuake"
        ? roundTripped.emergency.magnitudeSemantic
        : undefined,
      roundTripped.emergency?.kind === "largeQuake"
        ? roundTripped.emergency.depthSemantic
        : undefined,
    ];
    for (const semantic of roundTripSemantics) {
      expect(semantic).toBeDefined();
      expect(Object.hasOwn(semantic!, "value")).toBe(true);
      expect(Object.hasOwn(semantic!, "lowerBound")).toBe(true);
      expect(Object.hasOwn(semantic!, "upperBound")).toBe(true);
      expect(Object.hasOwn(semantic!, "rawLowerBound")).toBe(true);
      expect(Object.hasOwn(semantic!, "rawUpperBound")).toBe(true);
    }
  });

  it("EEW と津波 emergency に canonical semantic を additive に射影する", () => {
    const eew = projectDisplayEvent(baseEvent({
      domain: "eew",
      type: "VXSE43",
      eventId: "E-semantic",
      isWarning: true,
      magnitude: "M8 を超える巨大地震",
      magnitudeValue: giantMagnitude,
      depth: "600km",
      depthValue: boundedDepth,
    }), "EEW");
    expect(eew.emergency).toMatchObject({
      kind: "eew",
      magnitudeSemantic: { rank: { kind: "giant" } },
      depthSemantic: { lowerBound: 600, upperBound: null },
    });

    const tsunami = projectDisplayEvent(baseEvent({
      domain: "tsunami",
      type: "VTSE51",
      tsunamiKinds: ["津波警報"],
      magnitudeValue: giantMagnitude,
      depthValue: boundedDepth,
    }), "津波");
    expect(tsunami.emergency).toMatchObject({
      kind: "tsunami",
      magnitudeSemantic: { rank: { kind: "giant" } },
      depthSemantic: { lowerBound: 600, upperBound: null },
    });
  });

  it("legacy scalar-only event では additive semantic field を省略する", () => {
    const dto = projectDisplayEvent(baseEvent({
      domain: "eew",
      type: "VXSE43",
      eventId: "E-legacy",
      magnitude: "6.5",
      depth: "10km",
    }), "legacy");
    expect(dto.emergency).not.toHaveProperty("magnitudeSemantic");
    expect(dto.emergency).not.toHaveProperty("depthSemantic");
  });

  it("adopted local intensity drives summary role and ticker priority/surface", () => {
    const missing = {
      raw: null,
      value: null,
      condition: null,
      description: null,
      presence: "missing" as const,
    };
    const local = {
      raw: "7",
      value: "7" as const,
      condition: null,
      description: null,
      presence: "value" as const,
    };
    const dto = projectDisplayEvent(baseEvent({
      domain: "earthquake",
      eventId: "Q-local-7",
      maxInt: null,
      maxIntRank: null,
      maxIntValue: missing,
      areaItems: [{ name: "地域A", code: "440", maxInt: "7", maxIntValue: local }],
      quakeIntensityValues: {
        localAreas: [{ name: "地域A", code: "440", maxIntValue: local }],
        municipalities: [],
      },
    }), "local intensity");

    expect(dto.summary.role).toBe("quakeMajor");
    expect(dto.tickerPriority).toBe("high");
    expect(dto.tickerSurface).toBe("solid");
  });

  it("explicit unknown suppresses stale legacy rank in summary and ticker consumers", () => {
    const dto = projectDisplayEvent(baseEvent({
      domain: "earthquake",
      eventId: "Q-explicit-unknown",
      frameLevel: "normal",
      maxInt: null,
      maxIntRank: 9,
      maxIntValue: {
        raw: "未入電",
        value: null,
        condition: "未入電",
        description: null,
        presence: "unknown",
      },
    }), "explicit unknown");

    expect(dto.summary.role).toBe("normal");
    expect(dto.tickerPriority).toBe("mid");
    expect(dto.tickerSurface).toBe("none");
  });

  it("raw と stateSnapshot を DTO に含めない (シリアライズ全走査)", () => {
    const dto = projectDisplayEvent(
      baseEvent({ raw: { dummy: true } as never, stateSnapshot: { kind: "volcano", isRenotification: false } }),
      "要約",
    );
    const keys = new Set<string>();
    JSON.stringify(dto, (k, v) => { if (k) keys.add(k); return v; });
    expect(keys.has("raw")).toBe(false);
    expect(keys.has("stateSnapshot")).toBe(false);
    expect(dto.version).toBe(1);
  });

  it("EEW を emergency(eew) に射影し colorIndex は stateSnapshot から取る", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "eew", type: "VXSE45", eventId: "E1", serial: "3", originTime: "2026-07-29T10:00:00+09:00",
        isWarning: true, isFinal: false, hypocenterName: "能登半島沖",
        forecastMaxInt: "5強", forecastMaxIntRank: 6, magnitude: "6.5",
        frameLevel: "critical",
        stateSnapshot: { kind: "eew", activeCount: 1, colorIndex: 2, isCancelled: false },
      }),
      "EEW要約",
    );
    expect(dto.emergency).toMatchObject({ kind: "eew", eventId: "E1", serial: "3", isWarning: true, colorIndex: 2, originTime: "2026-07-29T10:00:00+09:00" });
    expect(dto.groupKey).toBe("eew:E1");
    expect(dto.summary.role).toBe("eewWarning");
    expect(dto.tickerSuppressed).toBe(true);
  });

  it("津波警報を emergency(tsunami) に射影する", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "tsunami", type: "VTSE41", tsunamiKinds: ["津波警報"],
        areaItems: [{ name: "石川県能登", kind: "津波警報" }],
        frameLevel: "warning",
      }),
      "津波要約",
    );
    expect(dto.emergency).toMatchObject({ kind: "tsunami", level: "warning", levelLabel: "津波警報" });
    expect(dto.groupKey).toBe("tsunami:current");
    expect(dto.summary.role).toBe("tsunamiWarning");
  });

  it("津波取消でも表示 aggregate が残れば emergency を維持する", () => {
    const dto = projectDisplayEvent(
      baseEvent({ domain: "tsunami", type: "VTSE41", isCancellation: true, tsunamiKinds: ["津波警報"] }),
      "取消要約",
    );
    expect(dto.emergency).toMatchObject({ kind: "tsunami", level: "warning" });
  });

  it("津波取消の表示 aggregate が空なら emergency null になる", () => {
    const dto = projectDisplayEvent(
      baseEvent({ domain: "tsunami", type: "VTSE41", isCancellation: true, tsunamiKinds: [] }),
      "取消要約",
    );
    expect(dto.emergency).toBeNull();
  });

  it("震度5弱以上の地震を emergency(largeQuake) に射影し震度別グループを降順で組む", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "earthquake", eventId: "Q1", maxInt: "5強", maxIntRank: 6,
        originTime: "2026-07-06T20:58:00+09:00", hypocenterName: "石川県能登地方", magnitude: "5.9",
        areaItems: [
          { name: "石川県能登", maxInt: "5強" },
          { name: "石川県加賀", maxInt: "4" },
          { name: "富山県東部", maxInt: "4" },
        ],
      }),
      "地震要約",
    );
    expect(dto.emergency).toMatchObject({ kind: "largeQuake", maxInt: "5強" });
    const groups = dto.emergency?.kind === "largeQuake" ? dto.emergency.intensityGroups : [];
    expect(groups[0]).toMatchObject({ intensity: "5強", areas: ["石川県能登"] });
    expect(groups[1]).toMatchObject({ intensity: "4", areas: ["石川県加賀", "富山県東部"] });
    expect(dto.summary.role).toBe("quakeMajor");
  });

  it("5弱以上未入電は exact scalar なしでも largeQuake gate を通り qualifier を wire に保持する", () => {
    const value: SpecialValue<JmaIntensity> = {
      raw: "", value: null, condition: "5弱以上未入電", description: null,
      presence: "qualitative", lowerBound: "5-",
    };
    const dto = projectDisplayEvent(baseEvent({
      domain: "earthquake",
      eventId: "Q-qualitative",
      maxIntValue: value,
      maxInt: null,
      maxIntRank: null,
      hypocenterName: "震源A",
      areaItems: [{ name: "地域A", maxIntValue: value }],
    }), "qualitative");
    expect(dto.emergency).toMatchObject({
      kind: "largeQuake",
      maxInt: "5弱以上未入電",
      maxIntRank: 5,
      maxIntSemantic: {
        presence: "qualitative", badge: "≥", color: "safetyRank", colorRank: 5,
      },
      intensityGroups: [expect.objectContaining({
        intensity: "5弱以上未入電", rank: 5,
        intensitySemantic: expect.objectContaining({ badge: "≥", colorRank: 5 }),
      })],
    });
    expect(dto.latestQuake).toMatchObject({
      maxInt: null,
      maxIntRank: null,
      maxIntSemantic: { presence: "qualitative", badge: "≥", safetyRank: 5 },
    });
    expect(dto.recentQuake).toMatchObject({
      maxInt: null,
      maxIntRank: null,
      maxIntSemantic: { presence: "qualitative", badge: "≥", safetyRank: 5 },
    });
  });

  it("震度4以下の地震は emergency null で recentQuake に載る", () => {
    const dto = projectDisplayEvent(
      baseEvent({ domain: "earthquake", eventId: "Q2", maxInt: "4", maxIntRank: 4, hypocenterName: "宮城県沖" }),
      "小地震要約",
    );
    expect(dto.emergency).toBeNull();
    expect(dto.recentQuake).toMatchObject({ eventId: "Q2", maxInt: "4" });
  });

  it("summary の ANSI を strip する", () => {
    const dto = projectDisplayEvent(baseEvent({}), "\x1b[31m赤い要約\x1b[0m");
    expect(dto.summary.text).toBe("赤い要約");
  });

  it("EEW の isAssumedHypocenter/depth/maxLgInt/regions を射影する (Phase A)", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "eew", type: "VXSE45", eventId: "E2", serial: "1",
        isWarning: true, isFinal: false, frameLevel: "critical",
        isAssumedHypocenter: true, depth: "10km", maxLgInt: "3",
        eewRegions: [
          { name: "南部", intensity: "4", intensityTo: "5-", isPlum: false, hasArrived: false, arrivalTime: null },
          { name: "北部", intensity: "5弱", intensityTo: null, isPlum: true, hasArrived: true, arrivalTime: "2026-07-07T10:00:00+09:00" },
        ],
      }),
      "EEW要約",
    );
    expect(dto.emergency).toMatchObject({
      kind: "eew", isAssumedHypocenter: true, depth: "10km", maxLgInt: "3",
      regions: [
        { name: "南部", intensity: "4", intensityTo: "5-", isPlum: false, hasArrived: false, arrivalTime: null },
        { name: "北部", intensity: "5弱", intensityTo: null, isPlum: true, hasArrived: true, arrivalTime: "2026-07-07T10:00:00+09:00" },
      ],
    });
  });

  it("EEW 全体・地域別の SpecialValue と親 Area qualifier を同時に wire 化する", () => {
    const qualitative: SpecialValue<JmaIntensity> = {
      raw: "",
      value: null,
      condition: "5弱以上未入電",
      description: "震度5弱以上",
      presence: "qualitative",
      lowerBound: "5-",
      rawLowerBound: "5-",
      rawUpperBound: "over",
    };
    const dto = projectDisplayEvent(baseEvent({
      domain: "eew",
      type: "VXSE45",
      eventId: "E-semantic",
      forecastMaxInt: "5弱以上未入電",
      forecastMaxIntRank: 5,
      maxIntValue: qualitative,
      areaItems: [{ name: "北部", maxIntValue: qualitative }],
      eewRegions: [{
        name: "北部", intensity: "", intensityTo: "over",
        isPlum: true, hasArrived: true, arrivalTime: null,
      }],
    }), "EEW qualifier");
    expect(dto.emergency).toMatchObject({
      kind: "eew",
      forecastMaxIntSemantic: {
        presence: "qualitative", label: "5弱以上未入電", badge: "≥",
        condition: "5弱以上未入電", rawUpperBound: "over",
      },
      regions: [{
        name: "北部", intensity: "5弱以上未入電", intensityTo: null,
        isPlum: true, hasArrived: true,
        intensitySemantic: {
          presence: "qualitative", label: "5弱以上未入電", badge: "≥",
          condition: "5弱以上未入電", rawUpperBound: "over",
        },
      }],
    });
  });

  it("EEW 全体・地域別 ForecastLgInt の range／unknown qualifier を semantic wire に保持する", () => {
    const overall: SpecialValue<JmaLgIntensity> = {
      raw: "", value: null, condition: "予測幅", description: "最大長周期階級幅",
      presence: "range", lowerBound: "2", upperBound: "3",
      rawLowerBound: "２", rawUpperBound: "３",
    };
    const regional: SpecialValue<JmaLgIntensity> = {
      raw: "", value: null, condition: null, description: "地域長周期階級幅",
      presence: "range", lowerBound: "1", upperBound: "2",
      rawLowerBound: "１", rawUpperBound: "２",
    };
    const unknown: SpecialValue<JmaLgIntensity> = {
      raw: "", value: null, condition: "未入電", description: "長周期階級未入電",
      presence: "unknown",
    };
    const dto = projectDisplayEvent(baseEvent({
      domain: "eew", type: "VXSE45", eventId: "E-lg-semantic",
      maxLgInt: null,
      maxLgIntValue: overall,
      areaItems: [
        { name: "南部", maxInt: "4", maxLgIntValue: regional },
        { name: "北部", maxInt: "4", maxLgIntValue: unknown },
      ],
      eewRegions: [
        { name: "南部", intensity: "4", intensityTo: null, isPlum: false, hasArrived: false, arrivalTime: null },
        { name: "北部", intensity: "4", intensityTo: null, isPlum: false, hasArrived: false, arrivalTime: null },
      ],
    }), "EEW LgInt qualifier");

    expect(dto.emergency).toMatchObject({
      kind: "eew",
      maxLgInt: null,
      maxLgIntSemantic: {
        presence: "range", label: "2〜3", badge: "↔", color: "safetyUpperRank",
        condition: "予測幅", description: "最大長周期階級幅",
        safetyLowerRank: 2, safetyUpperRank: 3, safetyRank: 3, colorRank: 3,
      },
      regions: [
        expect.objectContaining({
          name: "南部", lgIntensity: "1〜2",
          lgIntensitySemantic: expect.objectContaining({
            presence: "range", label: "1〜2", badge: "↔", colorRank: 2,
          }),
        }),
        expect.objectContaining({
          name: "北部", lgIntensity: "不明（未入電）",
          lgIntensitySemantic: expect.objectContaining({
            presence: "unknown", label: "不明（未入電）", badge: "?", color: "unknown",
            safetyRank: null, colorRank: null,
          }),
        }),
      ],
    });
  });

  it("EEW の regions/depth が無い場合は空配列/null にフォールバックする", () => {
    const dto = projectDisplayEvent(
      baseEvent({ domain: "eew", type: "VXSE45", eventId: "E3", isWarning: false, frameLevel: "warning" }),
      "EEW要約",
    );
    expect(dto.emergency).toMatchObject({ kind: "eew", isAssumedHypocenter: false, depth: null, maxLgInt: null, regions: [] });
  });

  it("津波の warningComment/observations/coasts の maxHeight・firstHeight を射影する (Phase A)", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "tsunami", type: "VTSE41", tsunamiKinds: ["津波警報"],
        areaItems: [{
          name: "石川県能登", areaCode: "AREA-CODE-INTERNAL", kindCode: "KIND-CODE-INTERNAL",
          kind: "津波警報", maxHeightDescription: "３ｍ", firstHeight: "既に到達と推測",
          maxHeight: { raw: "3", value: 3, condition: null, description: "３ｍ", presence: "value" },
        }],
        warningComment: "満潮と重なるとより高くなります",
        tsunamiObservations: [
          {
            areaCode: "AREA-CODE-INTERNAL", kindCode: "KIND-CODE-INTERNAL",
            areaName: "石川県能登", areaKind: "津波警報", stationName: "輪島",
            arrivalTime: "2026-07-07T10:05:00+09:00", initial: "押し", maxHeightValue: "0.5m", condition: "観測中",
            maxHeight: { raw: "0.5", value: 0.5, condition: "観測中", description: "0.5m", presence: "value" },
          },
        ],
        frameLevel: "warning",
      }),
      "津波要約",
    );
    expect(dto.emergency).toMatchObject({
      kind: "tsunami",
      coasts: [{
        name: "石川県能登", kind: "津波警報",
        areaCode: "AREA-CODE-INTERNAL", kindCode: "KIND-CODE-INTERNAL",
        maxHeight: "３ｍ", firstHeight: "既に到達と推測",
        maxHeightSemantic: expect.objectContaining({
          presence: "value", value: 3, label: "３ｍ", badge: null, color: "normalRank", render: true,
        }),
      }],
      warningComment: "満潮と重なるとより高くなります",
      observations: [
        {
          areaName: "石川県能登", areaCode: "AREA-CODE-INTERNAL", areaKind: "津波警報",
          stationName: "輪島",
          arrivalTime: "2026-07-07T10:05:00+09:00", initial: "押し", maxHeightValue: "0.5m", condition: "観測中",
          maxHeightSemantic: expect.objectContaining({
            presence: "value", value: 0.5, label: "0.5m", condition: "観測中",
            badge: null, color: "normalRank", render: true,
          }),
        },
      ],
    });
    expect(JSON.stringify(dto)).toContain("AREA-CODE-INTERNAL");
    expect(JSON.stringify(dto)).toContain("KIND-CODE-INTERNAL");
  });

  it("tsunamiDisplay aggregate 分岐の coasts へ Area.Code/Kind.Code を投影する", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "tsunami",
        type: "VTSE41",
        tsunamiKinds: ["津波注意報"],
        areaItems: [{
          name: "受信意味の予報区", areaCode: "PARSED-AREA", kindCode: "PARSED-KIND",
          kind: "津波注意報",
        }],
        tsunamiDisplay: {
          kinds: ["津波警報"],
          areaItems: [{
            name: "aggregate の予報区", areaCode: "DISPLAY-AREA", kindCode: "DISPLAY-KIND",
            kind: "津波警報", maxHeightDescription: "３ｍ", firstHeight: "既に到達と推測",
          }],
          warningComment: null,
        },
        frameLevel: "warning",
      }),
      "津波概要",
    );

    expect(dto.emergency).toMatchObject({
      kind: "tsunami",
      level: "warning",
      coasts: [{
        name: "aggregate の予報区",
        kind: "津波警報",
        areaCode: "DISPLAY-AREA",
        kindCode: "DISPLAY-KIND",
        maxHeight: "３ｍ",
        firstHeight: "既に到達と推測",
      }],
    });
  });

  it("津波種別の接尾辞つき表記 (「大津波警報：発表」等) も前方一致でレベル判定される (Phase 2)", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "tsunami", type: "VTSE41", tsunamiKinds: ["大津波警報：発表"],
        areaItems: [{ name: "岩手県", kind: "大津波警報：発表" }],
        frameLevel: "critical",
      }),
      "津波要約",
    );
    expect(dto.emergency).toMatchObject({ kind: "tsunami", level: "majorWarning", levelLabel: "大津波警報" });
    expect(dto.summary.role).toBe("tsunamiMajor");
  });

  it("接尾辞つき種別は coasts.kind も canonical ラベルに正規化される (色分け・banner 集計の一致のため)", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "tsunami", type: "VTSE41", tsunamiKinds: ["津波警報：発表"],
        areaItems: [{ name: "北海道太平洋沿岸中部", kind: "津波警報：発表" }],
        frameLevel: "warning",
      }),
      "津波要約",
    );
    expect(dto.emergency).toMatchObject({
      kind: "tsunami",
      coasts: [{ name: "北海道太平洋沿岸中部", kind: "津波警報" }],
    });
  });

  it("観測の areaKind も接尾辞を正規化する (観測フィルタの exact match 対策)", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "tsunami", type: "VTSE41", tsunamiKinds: ["大津波警報：発表"],
        areaItems: [{ name: "岩手県", kind: "大津波警報：発表" }],
        tsunamiObservations: [
          {
            areaName: "岩手県", areaKind: "大津波警報：発表", stationName: "宮古",
            arrivalTime: "2026-07-07T10:05:00+09:00", initial: "押し", maxHeightValue: null, condition: "観測中",
          },
        ],
        frameLevel: "critical",
      }),
      "津波要約",
    );
    expect(dto.emergency).toMatchObject({
      observations: [{ areaKind: "大津波警報" }],
    });
  });

  it("津波予報 (0.2m以下、警報/注意報を含まない) の kind は正規化されずそのまま残る", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "tsunami", type: "VTSE41", tsunamiKinds: ["津波警報"],
        areaItems: [
          { name: "石川県能登", kind: "津波警報" },
          { name: "大阪府", kind: "津波予報（若干の海面変動）" },
        ],
        frameLevel: "warning",
      }),
      "津波要約",
    );
    const coasts = dto.emergency?.kind === "tsunami" ? dto.emergency.coasts : [];
    // 警報・注意報ありのため pickAlertCoasts が予報区を除外する (既存仕様。正規化の副作用で復活しない)
    expect(coasts).toEqual([{ name: "石川県能登", kind: "津波警報", maxHeight: null, firstHeight: null }]);
  });

  it("大地震の depth/maxLgInt/tsunamiWarning を射影する (Phase A)", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "earthquake", eventId: "Q3", maxInt: "6弱", maxIntRank: 7,
        hypocenterName: "日向灘", depth: "20km", maxLgInt: "2", tsunamiWarning: true,
        areaItems: [{ name: "宮崎県", maxInt: "6弱" }],
      }),
      "地震要約",
    );
    expect(dto.emergency).toMatchObject({ kind: "largeQuake", depth: "20km", maxLgInt: "2", tsunamiWarning: true });
  });

  it("recentQuake の depth/tsunamiWarning を射影する (Phase A)", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "earthquake", eventId: "Q4", maxInt: "3", maxIntRank: 3,
        hypocenterName: "千葉県東方沖", depth: "40km", tsunamiWarning: false,
      }),
      "小地震要約",
    );
    expect(dto.recentQuake).toMatchObject({ eventId: "Q4", depth: "40km", tsunamiWarning: false });
  });

  it("recentQuake に各地の震度 intensityGroups が rank 降順で組まれる (履歴カード再表示用)", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "earthquake", eventId: "Q6", maxInt: "4", maxIntRank: 4,
        hypocenterName: "茨城県沖", tsunamiWarning: false,
        areaItems: [
          { name: "茨城県北部", maxInt: "4" },
          { name: "福島県浜通り", maxInt: "3" },
        ],
      }),
      "小地震要約",
    );
    expect(dto.recentQuake?.intensityGroups?.length).toBe(2);
    expect(dto.recentQuake?.intensityGroups?.[0]).toMatchObject({ intensity: "4", areas: ["茨城県北部"] });
    expect(dto.recentQuake?.intensityGroups?.[1]).toMatchObject({ intensity: "3", areas: ["福島県浜通り"] });
  });

  it("地震イベントは latestQuake に射影され intensityGroups が rank 降順で組まれる (Task 3)", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "earthquake", eventId: "Q5", maxInt: "4", maxIntRank: 4,
        hypocenterName: "茨城県沖", magnitude: "5.1", depth: "50km",
        originTime: "2026-07-08T10:00:00+09:00", tsunamiWarning: false,
        areaItems: [
          { name: "茨城県北部", maxInt: "4" },
          { name: "福島県浜通り", maxInt: "3" },
        ],
      }),
      "小地震要約",
    );
    expect(dto.latestQuake).toMatchObject({ eventId: "Q5", maxInt: "4", hypocenterName: "茨城県沖" });
    expect(dto.latestQuake?.intensityGroups.length).toBeGreaterThan(0);
    expect(dto.latestQuake?.intensityGroups[0]).toMatchObject({ intensity: "4", areas: ["茨城県北部"] });
  });

  it("内部 provenance は隠し、公開用 SpecialValue semantic だけを display protocol JSON へ載せる", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "earthquake",
        type: "VXSE52",
        eventId: "Q-internal",
        hypocenterName: "茨城県沖",
        maxInt: null,
        maxIntRank: null,
        maxIntValue: {
          raw: "",
          value: null,
          condition: "未入電",
          description: null,
          presence: "unknown",
        },
      }),
      "内部bridge",
    );
    const json = JSON.stringify(dto);
    expect(json).not.toContain("maxIntValue");
    expect(json).not.toContain("observationSourceType");
    expect(dto.latestQuake?.maxIntSemantic).toMatchObject({
      presence: "unknown", badge: "?", color: "unknown", condition: "未入電",
    });
  });

  it("非地震イベントの latestQuake は null になる (Task 3)", () => {
    const dto = projectDisplayEvent(
      baseEvent({ domain: "weather", headline: "大雨警報が発表されました", areaItems: [] }),
      "気象要約",
    );
    expect(dto.latestQuake).toBeNull();
  });

  it("取消地震イベントの latestQuake は null になる (Task 3 境界)", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "earthquake", eventId: "Q6", isCancellation: true,
        maxInt: "4", maxIntRank: 4, hypocenterName: "茨城県沖",
      }),
      "取消要約",
    );
    expect(dto.latestQuake).toBeNull();
  });

  it("maxInt も hypocenterName も無い地震イベントの latestQuake は null になる (Task 3 境界)", () => {
    const dto = projectDisplayEvent(
      baseEvent({ domain: "earthquake", eventId: "Q7", maxInt: null, hypocenterName: null }),
      "空要約",
    );
    expect(dto.latestQuake).toBeNull();
  });

  it("EEW ドメインは地震っぽいフィールドを持っていても latestQuake は null になる (Task 3 境界)", () => {
    const dto = projectDisplayEvent(
      baseEvent({
        domain: "eew", type: "VXSE45", eventId: "E4", isWarning: true, frameLevel: "critical",
        hypocenterName: "能登半島沖", magnitude: "6.5", forecastMaxInt: "5強", forecastMaxIntRank: 6,
      }),
      "EEW要約",
    );
    expect(dto.latestQuake).toBeNull();
  });

  it("解説系・南海トラフ・台風の groupKey を射影する (続報版管理、§4-5)", () => {
    const gk = (over: Partial<PresentationEvent>): string | null =>
      projectDisplayEvent(baseEvent(over), "要約").groupKey;
    expect(gk({ domain: "nankaiTrough", eventId: "N1" })).toBe("nankai:N1");
    expect(gk({ domain: "weatherExplanation", eventId: "W1" })).toBe("weatherExplanation:W1");
    expect(gk({ domain: "volcano", eventId: "V1" })).toBe("volcano:V1");
    expect(gk({ domain: "climateInfo", eventId: "C1" })).toBe("climateInfo:C1");
    expect(gk({ domain: "typhoonAnalysis", eventId: "TC2001" })).toBe("typhoonAnalysis:TC2001");
    expect(gk({ domain: "typhoonProbability", eventId: "TC2001" })).toBe("typhoonProbability:TC2001");
  });

  it("eventId が無い解説系の groupKey は null (版管理せず個別に流す)", () => {
    expect(projectDisplayEvent(baseEvent({ domain: "weatherExplanation", eventId: null }), "要約").groupKey).toBeNull();
    expect(projectDisplayEvent(baseEvent({ domain: "typhoonAnalysis", eventId: null }), "要約").groupKey).toBeNull();
  });

  it("weather VPWS50 は全国集約単一ストリームの安定シングルトンキー", () => {
    const gk = (over: Partial<PresentationEvent>): string | null =>
      projectDisplayEvent(baseEvent(over), "要約").groupKey;
    // publishingOffice や eventId が変わっても VPWS50 は常に同一キー (定時集約通報を最新 1 件へ畳む)
    expect(gk({ domain: "weather", type: "VPWS50", publishingOffice: "気象庁", eventId: "a" })).toBe("weather:vpws50");
    expect(gk({ domain: "weather", type: "VPWS50", publishingOffice: "気象庁", eventId: "b" })).toBe("weather:vpws50");
  });

  it("weather VPWW55-61 は (type, publishingOffice) 単位で系列を 1 本化する", () => {
    const gk = (over: Partial<PresentationEvent>): string | null =>
      projectDisplayEvent(baseEvent(over), "要約").groupKey;
    // 同一府県・同一カテゴリの続報は同一キー (最新版へ置換)
    expect(gk({ domain: "weather", type: "VPWW55", publishingOffice: "松江地方気象台" }))
      .toBe("weather:VPWW55:松江地方気象台");
    // 異なる府県 → 別キー (共存)
    expect(gk({ domain: "weather", type: "VPWW55", publishingOffice: "京都地方気象台" }))
      .toBe("weather:VPWW55:京都地方気象台");
    // 同一府県でも異なるカテゴリ (type) → 別キー (大雨と高潮は別警報として共存)
    expect(gk({ domain: "weather", type: "VPWW57", publishingOffice: "松江地方気象台" }))
      .toBe("weather:VPWW57:松江地方気象台");
  });

  it("tickerBody に event.bodyText を射影する (解説系の全文配線)", () => {
    const dto = projectDisplayEvent(
      baseEvent({ domain: "weatherExplanation", bodyText: "【概況】低気圧が発達しています。" }),
      "解説要約",
    );
    expect(dto.tickerBody).toBe("【概況】低気圧が発達しています。");
  });

  it("生の全角スペース入り bodyText が DTO で正規化される (normalizeTickerBody 差込確認)", () => {
    const dto = projectDisplayEvent(
      baseEvent({ domain: "weatherExplanation", bodyText: "　　１７日は１００ｋｍ" }),
      "解説要約",
    );
    expect(dto.tickerBody).toBe("17日は100km");
  });

  it("bodyText が無い電文の tickerBody は null (従来 tickerSentence フォールバック)", () => {
    const dto = projectDisplayEvent(baseEvent({ domain: "earthquake", maxInt: "3", maxIntRank: 3 }), "地震要約");
    expect(dto.tickerBody).toBeNull();
  });

  it("tickerPriority を DTO に射影する", () => {
    const dto = projectDisplayEvent(
      baseEvent({ domain: "earthquake", maxInt: "5弱", maxIntRank: 5, frameLevel: "critical" }),
      "地震要約",
    );
    expect(dto.tickerPriority).toBe("high");
  });

  it("tickerSentence と tickerCategory を埋める", () => {
    const event = baseEvent({
      domain: "earthquake",
      originTime: "2026-07-08T21:37:00+09:00",
      hypocenterName: "宮城県沖",
      magnitude: "4.8",
      maxInt: "3",
      areaItems: [{ name: "石巻市", maxInt: "3" }],
    });
    const dto = projectDisplayEvent(event, "[情報] 震源・震度情報 宮城県沖 M4.8 震度3");
    expect(dto.tickerCategory).toBe("地震情報");
    expect(dto.tickerSentence).toBe(
      "午後9時37分ごろ、宮城県沖を震源とするマグニチュード4.8の地震がありました。石巻市で最大震度3を観測しています。",
    );
  });

  it("projectDisplayEvent が tickerSubject を射影する (火山)", () => {
    const event = baseEvent({
      domain: "volcano",
      type: "VFVO50",
      title: "噴火警報",
      frameLevel: "warning",
      volcanoName: "桜島",
    } as Partial<PresentationEvent>);
    expect(projectDisplayEvent(event, "サマリ").tickerSubject).toBe("桜島");
  });
});

describe("tickerSuppressed (情報ゼロ電文の抑制、spec 2026-07-23 T5-2)", () => {
  const vpwp50 = (over: Partial<PresentationEvent>) =>
    baseEvent({
      domain: "weatherWarningTimeseries", type: "VPWP50",
      title: "鹿児島県警戒・注意事項時系列情報",
      ...over,
    });
  const weatherExplanation = (over: Partial<PresentationEvent>) =>
    baseEvent({
      domain: "weatherExplanation", type: "VPZJ51",
      title: "全般気象解説情報",
      frameLevel: "normal",
      ...over,
    });

  it("entries ゼロ (sentence null・body null) の非取消 VPWP50 は true", () => {
    const dto = projectDisplayEvent(vpwp50({ raw: { areas: [] } as never }), "s");
    expect(dto.tickerSuppressed).toBe(true);
  });

  it("取消は抑制しない (取消文が出る)", () => {
    const dto = projectDisplayEvent(vpwp50({ raw: { areas: [] } as never, isCancellation: true, infoType: "取消" }), "s");
    expect(dto.tickerSuppressed).toBe(false);
    expect(dto.tickerSentence).toBe("気象警報・注意報の予測情報は取り消されました。");
  });

  it("bodyText がある電文は sentence null でも抑制しない", () => {
    const dto = projectDisplayEvent(vpwp50({ raw: { areas: [] } as never, bodyText: "本文あり" }), "s");
    expect(dto.tickerSuppressed).toBe(false);
  });

  it("他ドメインは常に false", () => {
    const dto = projectDisplayEvent(baseEvent({}), "s");
    expect(dto.tickerSuppressed).toBe(false);
  });

  it("EEW は取消を含め常にテロップから除外する", () => {
    const dto = projectDisplayEvent(
      baseEvent({ domain: "eew", type: "VXSE45", isCancellation: true, infoType: "取消" }),
      "s",
    );
    expect(dto.tickerSuppressed).toBe(true);
  });

  it("headline も本文もない非取消の気象解説は抑制する", () => {
    const dto = projectDisplayEvent(
      weatherExplanation({ headline: null, bodyText: null }),
      "s",
    );
    expect(dto.tickerSuppressed).toBe(true);
  });

  it("headline がある気象解説は本文がなくても抑制しない", () => {
    const dto = projectDisplayEvent(
      weatherExplanation({ headline: "有意なヘッドライン", bodyText: null }),
      "s",
    );
    expect(dto.tickerSuppressed).toBe(false);
    expect(dto.tickerSentence).toBe("有意なヘッドライン。");
  });

  it("取消の気象解説は本文・headline がなくても抑制しない", () => {
    const dto = projectDisplayEvent(
      weatherExplanation({ isCancellation: true, infoType: "取消", headline: null, bodyText: null }),
      "s",
    );
    expect(dto.tickerSuppressed).toBe(false);
  });
});
