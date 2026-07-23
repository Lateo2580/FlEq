import { describe, expect, it } from "vitest";
import { buildTickerDetail, normalizeDepth, projectDisplayEvent, tickerPriority } from "../../../src/engine/display/project-event";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

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

  it("大津波警報・津波警報 = high / 津波注意報 = mid", () => {
    expect(tickerPriority(baseEvent({ domain: "tsunami", tsunamiKinds: ["大津波警報"] }))).toBe("high");
    expect(tickerPriority(baseEvent({ domain: "tsunami", tsunamiKinds: ["津波警報"] }))).toBe("high");
    expect(tickerPriority(baseEvent({ domain: "tsunami", tsunamiKinds: ["津波注意報"] }))).toBe("mid");
  });

  it("震度5弱以上 = high / 震度4以下 = mid", () => {
    expect(tickerPriority(baseEvent({ domain: "earthquake", maxIntRank: 5 }))).toBe("high");
    expect(tickerPriority(baseEvent({ domain: "earthquake", maxIntRank: 4 }))).toBe("mid");
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

describe("projectDisplayEvent", () => {
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
        domain: "eew", type: "VXSE45", eventId: "E1", serial: "3",
        isWarning: true, isFinal: false, hypocenterName: "能登半島沖",
        forecastMaxInt: "5強", forecastMaxIntRank: 6, magnitude: "6.5",
        frameLevel: "critical",
        stateSnapshot: { kind: "eew", activeCount: 1, colorIndex: 2, isCancelled: false },
      }),
      "EEW要約",
    );
    expect(dto.emergency).toMatchObject({ kind: "eew", eventId: "E1", serial: "3", isWarning: true, colorIndex: 2 });
    expect(dto.groupKey).toBe("eew:E1");
    expect(dto.summary.role).toBe("eewWarning");
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

  it("津波取消は emergency null になる", () => {
    const dto = projectDisplayEvent(
      baseEvent({ domain: "tsunami", type: "VTSE41", isCancellation: true, tsunamiKinds: ["津波警報"] }),
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
        areaItems: [{ name: "石川県能登", kind: "津波警報", maxHeightDescription: "３ｍ", firstHeight: "既に到達と推測" }],
        warningComment: "満潮と重なるとより高くなります",
        tsunamiObservations: [
          {
            areaName: "石川県能登", areaKind: "津波警報", stationName: "輪島",
            arrivalTime: "2026-07-07T10:05:00+09:00", initial: "押し", maxHeightValue: "0.5m", condition: "観測中",
          },
        ],
        frameLevel: "warning",
      }),
      "津波要約",
    );
    expect(dto.emergency).toMatchObject({
      kind: "tsunami",
      coasts: [{ name: "石川県能登", kind: "津波警報", maxHeight: "３ｍ", firstHeight: "既に到達と推測" }],
      warningComment: "満潮と重なるとより高くなります",
      observations: [
        {
          areaName: "石川県能登", areaKind: "津波警報", stationName: "輪島",
          arrivalTime: "2026-07-07T10:05:00+09:00", initial: "押し", maxHeightValue: "0.5m", condition: "観測中",
        },
      ],
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
});
