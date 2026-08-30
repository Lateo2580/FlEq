import { testTelegramMeta } from "../../helpers/telegram-meta";
import { describe, it, expect, vi } from "vitest";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { computeMaxDisplaySeverity, computeMaxSoundLevel } from "../../../src/dmdata/weather-warning-level";
import type { ParsedWeatherWarning, WeatherItem, WeatherKind } from "../../../src/types";
import type {
  PersistedVpws50StateV2,
  WeatherReportIdentity,
} from "../../../src/engine/messages/vpws50-state";

function identity(reportDateTime: string, serial: string | null = null): WeatherReportIdentity {
  return { reportDateTime, serial };
}

function makeKind(code: string, severity: WeatherKind["severity"], name?: string): WeatherKind {
  const defaultName =
    code === "10" ? "大雨注意報" :
    code === "03" ? "大雨警報" :
    code === "33" ? "大雨特別警報" :
    code === "14" ? "雷注意報" :
    code === "09" ? "土砂災害警報" :
    code === "29" ? "土砂災害注意報" : `Kind${code}`;
  return { name: name ?? defaultName, code, severity };
}

function makeItem(areaName: string, areaCode: string, kinds: WeatherKind[]): WeatherItem {
  return { areaName, areaCode, kinds, statuses: [] };
}

function makeInfo(
  items: WeatherItem[],
  opts: { infoType?: string; type?: string; publishingOffice?: string } = {},
): ParsedWeatherWarning {
  const layers = [{ type: "気象警報・注意報（府県予報区等）", items }];
  return {
    meta: testTelegramMeta(false),
    type: opts.type ?? "VPWS50",
    infoType: opts.infoType ?? "発表",
    title: "気象警報・注意報",
    reportDateTime: "2026-06-05T15:18:00+09:00",
    headline: null,
    publishingOffice: opts.publishingOffice ?? "気象庁",
    editorialOffice: "気象庁",
    controlTitle: "気象警報・注意報",
    layers,
    comments: [],
    maxSeverity: "warning",
    maxDisplaySeverity: computeMaxDisplaySeverity(layers),
    maxSoundLevel: computeMaxSoundLevel(layers),
    warningAreaCount: 0,
    advisoryAreaCount: 0,
    isTest: false,
  };
}

describe("Vpws50StateHolder.diffAndUpdate - 基本", () => {
  it("初回は isFirstReport=true, confidence=confirmed, added/released 空", () => {
    const state = new Vpws50StateHolder();
    const info = makeInfo([makeItem("神奈川県", "140000", [makeKind("03", "warning")])]);
    const diff = state.diffAndUpdate(info, "msg-1");
    expect(diff.isFirstReport).toBe(true);
    expect(diff.isUnchanged).toBe(false);
    expect(diff.confidence).toBe("confirmed");
    expect(diff.added).toHaveLength(0);
    expect(diff.released).toHaveLength(0);
  });

  it("同一電文の再受信は isUnchanged=true, confidence=confirmed", () => {
    const state = new Vpws50StateHolder();
    const info = makeInfo([makeItem("神奈川県", "140000", [makeKind("03", "warning")])]);
    state.diffAndUpdate(info, "msg-1");
    const diff = state.diffAndUpdate(info, "msg-2");
    expect(diff.isUnchanged).toBe(true);
    expect(diff.confidence).toBe("confirmed");
  });

  it("新規発令 (state 空 → 1 件): added に予報区", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([]), "msg-0");
    const diff = state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "msg-1");
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].areaName).toBe("神奈川県");
    expect(diff.added[0].changes[0].phenomenonKey).toBe("大雨");
    expect(diff.added[0].changes[0].newSeverity).toBe("warning");
    expect(diff.added[0].changes[0].prevSeverity).toBeNull();
  });

  it("解除: released に予報区", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "msg-1");
    const diff = state.diffAndUpdate(makeInfo([]), "msg-2");
    expect(diff.released).toHaveLength(1);
    expect(diff.released[0].changes[0].prevSeverity).toBe("warning");
    expect(diff.released[0].changes[0].newSeverity).toBeNull();
  });
});

describe("Vpws50StateHolder.diffAndUpdate - 昇格判定の根幹 (R2 致命対応)", () => {
  it("大雨注意報 (code=10) → 大雨警報 (code=03): upgraded として検知される", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("千葉県", "120000", [makeKind("10", "advisory")]),
    ]), "msg-1");
    const diff = state.diffAndUpdate(makeInfo([
      makeItem("千葉県", "120000", [makeKind("03", "warning")]),
    ]), "msg-2");
    expect(diff.upgraded).toHaveLength(1);
    expect(diff.upgraded[0].changes[0].phenomenonKey).toBe("大雨");
    expect(diff.upgraded[0].changes[0].prevSeverity).toBe("advisory");
    expect(diff.upgraded[0].changes[0].newSeverity).toBe("warning");
    expect(diff.upgraded[0].changes[0].prevKindCode).toBe("10");
    expect(diff.upgraded[0].changes[0].newKindCode).toBe("03");
    expect(diff.added).toHaveLength(0);
    expect(diff.released).toHaveLength(0);
  });

  it("大雨警報 (code=03) → 大雨特別警報 (code=33): upgraded (警→特)", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("鹿児島県", "460000", [makeKind("03", "warning")]),
    ]), "msg-1");
    const diff = state.diffAndUpdate(makeInfo([
      makeItem("鹿児島県", "460000", [makeKind("33", "specialWarning")]),
    ]), "msg-2");
    expect(diff.upgraded).toHaveLength(1);
    expect(diff.upgraded[0].changes[0].newSeverity).toBe("specialWarning");
  });

  it("大雨警報 (code=03) → 大雨注意報 (code=10): downgraded", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("栃木県", "090000", [makeKind("03", "warning")]),
    ]), "msg-1");
    const diff = state.diffAndUpdate(makeInfo([
      makeItem("栃木県", "090000", [makeKind("10", "advisory")]),
    ]), "msg-2");
    expect(diff.downgraded).toHaveLength(1);
    expect(diff.downgraded[0].changes[0].prevSeverity).toBe("warning");
    expect(diff.downgraded[0].changes[0].newSeverity).toBe("advisory");
  });

  it("土砂災害でも昇格判定 (code 29 → 09)", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("熊本県", "430000", [makeKind("29", "advisory")]),
    ]), "msg-1");
    const diff = state.diffAndUpdate(makeInfo([
      makeItem("熊本県", "430000", [makeKind("09", "warning")]),
    ]), "msg-2");
    expect(diff.upgraded).toHaveLength(1);
    expect(diff.upgraded[0].changes[0].phenomenonKey).toBe("土砂災害");
  });
});

describe("DISPLAY_SEVERITY_RANK ベースの昇降格 (Phase C)", () => {
  it("大雨警報 (03, L3) → レベル4大雨危険警報 (43, L4) を昇格として検出する", () => {
    const holder = new Vpws50StateHolder();
    holder.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning", "大雨警報")]),
    ]), "m1");
    const diff = holder.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("43", "warning", "レベル４大雨危険警報")]),
    ]), "m2");
    expect(diff.upgraded).toHaveLength(1);
    expect(diff.upgraded[0].changes[0].prevDisplaySeverity).toBe("officialL3");
    expect(diff.upgraded[0].changes[0].newDisplaySeverity).toBe("officialL4");
    expect(diff.upgraded[0].changes[0].newOfficialAlertLevel).toBe(4);
    expect(diff.isUnchanged).toBe(false); // 旧実装はここが true になるバグ
  });

  it("土砂 09→49 / 高潮 08→48 も昇格として検出する", () => {
    const holder = new Vpws50StateHolder();
    holder.diffAndUpdate(makeInfo([
      makeItem("熊本県", "430000", [makeKind("09", "warning", "土砂災害警報")]),
      makeItem("愛知県", "230000", [makeKind("08", "warning", "高潮警報")]),
    ]), "m1");
    const diff = holder.diffAndUpdate(makeInfo([
      makeItem("熊本県", "430000", [makeKind("49", "warning", "レベル４土砂災害警戒情報")]),
      makeItem("愛知県", "230000", [makeKind("48", "warning", "レベル４高潮危険警報")]),
    ]), "m2");
    expect(diff.upgraded).toHaveLength(2);
    const landslide = diff.upgraded.find((a) => a.areaCode === "430000");
    const surge = diff.upgraded.find((a) => a.areaCode === "230000");
    expect(landslide?.changes[0].prevDisplaySeverity).toBe("officialL3");
    expect(landslide?.changes[0].newDisplaySeverity).toBe("officialL4");
    expect(surge?.changes[0].prevDisplaySeverity).toBe("officialL3");
    expect(surge?.changes[0].newDisplaySeverity).toBe("officialL4");
    expect(diff.isUnchanged).toBe(false);
  });

  it("逆方向 (49→09) は降格として検出する", () => {
    const holder = new Vpws50StateHolder();
    holder.diffAndUpdate(makeInfo([
      makeItem("熊本県", "430000", [makeKind("49", "warning", "レベル４土砂災害警戒情報")]),
    ]), "m1");
    const diff = holder.diffAndUpdate(makeInfo([
      makeItem("熊本県", "430000", [makeKind("09", "warning", "土砂災害警報")]),
    ]), "m2");
    expect(diff.downgraded).toHaveLength(1);
    expect(diff.downgraded[0].changes[0].prevDisplaySeverity).toBe("officialL4");
    expect(diff.downgraded[0].changes[0].newDisplaySeverity).toBe("officialL3");
    expect(diff.upgraded).toHaveLength(0);
  });

  it("未知 Code kind は snapshot に保持され diff に参加する (rank 30)", () => {
    // (Codex R3 P1) name に「警報/注意報/特別警報」を含めない — 含めると
    // resolveDisplaySeverity の nameFallback で nonLevelWarning 等に解決されてしまい unknown パスを踏まない
    const holder = new Vpws50StateHolder();
    const diff1 = holder.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("99", "unknown", "謎")]),
    ]), "m1");
    expect(diff1.isFirstReport).toBe(true);
    const diff2 = holder.diffAndUpdate(makeInfo([]), "m2");
    expect(diff2.released).toHaveLength(1); // 消えたら解除として見える (沈黙しない)
    expect(diff2.released[0].changes[0].prevDisplaySeverity).toBe("unknown");
  });

  it("60 分再掲条件は displaySeverity rank >= nonLevelWarning(75) 相当", () => {
    // officialL3 のみ → 再掲対象
    const holderL3 = new Vpws50StateHolder();
    holderL3.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning", "大雨警報")]),
    ]), "m1");
    holderL3.__test_setLastSuccessfulFullDisplayAt(new Date(Date.now() - 65 * 60 * 1000));
    const recapDiff = holderL3.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning", "大雨警報")]),
    ]), "m2");
    expect(recapDiff.shouldRecap).toBe(true);

    // officialL2 のみ (rank 60 < 75) → 対象外
    const holderL2 = new Vpws50StateHolder();
    holderL2.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("10", "advisory", "大雨注意報")]),
    ]), "m1");
    holderL2.__test_setLastSuccessfulFullDisplayAt(new Date(Date.now() - 65 * 60 * 1000));
    const noRecapDiff = holderL2.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("10", "advisory", "大雨注意報")]),
    ]), "m2");
    expect(noRecapDiff.shouldRecap).toBe(false);
  });
});

describe("VPWS50 同一 rank の種別変更", () => {
  it("表示名だけの変更は通知用 diff を従来どおり unchanged に保ち、表示専用 diff だけへ載せる", () => {
    const holder = new Vpws50StateHolder();
    holder.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning", "大雨警報")]),
    ]), "m1");
    const { diff, displayDiff } = holder.diffAndUpdateWithDisplay(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning", "大雨危険情報")]),
    ]), "m2", { reportDateTime: "2026-08-13T12:01:00+09:00", serial: "2" });

    expect(diff).toEqual({
      isFirstReport: false,
      isUnchanged: true,
      isCancelRollback: false,
      shouldRecap: false,
      confidence: "confirmed",
      added: [],
      upgraded: [],
      downgraded: [],
      released: [],
    });
    expect(displayDiff?.kindChanged).toHaveLength(1);
    expect(displayDiff?.kindChanged[0]?.changes[0]).toMatchObject({
      phenomenonKey: "大雨",
      prevKindShortName: "大雨",
      kindShortName: "大雨危険情報",
      prevKindCode: "03",
      newKindCode: "03",
      prevDisplaySeverity: "officialL3",
      newDisplaySeverity: "officialL3",
    });
    expect(displayDiff?.upgraded).toHaveLength(0);
    expect(displayDiff?.downgraded).toHaveLength(0);
  });
});

describe("Vpws50StateHolder.rollback (history 深さ 8, R1-6/R2-3)", () => {
  it("通常 → 取消 で直前報の state に戻る", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "msg-1");
    state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
      makeItem("千葉県", "120000", [makeKind("10", "advisory")]),
    ]), "msg-2");
    const rollbackDiff = state.rollback("msg-2");
    expect(rollbackDiff?.isCancelRollback).toBe(true);
    const verifyDiff = state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "msg-3");
    expect(verifyDiff.isUnchanged).toBe(true);
  });

  it("対象報がない rollback は無視する", () => {
    const state = new Vpws50StateHolder();
    const diff = state.rollback("cancel-msg");
    expect(diff).toBeNull();
    expect(state.getCurrentAreasForDisplay()).toBeUndefined();
  });

  it("history 深さ 8 で 9 個目で古い entry が落ちる", () => {
    const state = new Vpws50StateHolder();
    for (let i = 0; i < 9; i++) {
      state.diffAndUpdate(makeInfo([
        makeItem(`県${i}`, `${i.toString().padStart(2, "0")}0000`, [makeKind("03", "warning")]),
      ]), `msg-${i}`);
    }
    for (let i = 0; i < 9; i++) {
      const diff = state.rollback(`msg-${8 - i}`);
      if (i < 8) {
        expect(diff?.isFirstReport).toBe(false);
      } else {
        expect(diff?.isFirstReport).toBe(true);
      }
    }
  });
});

describe("Vpws50StateHolder restorePrevious (revision 判定は共通 gate が担当)", () => {
  const firstIdentity = identity("2026-06-05T15:00:00+09:00", "1");
  const secondIdentity = identity("2026-06-05T15:30:00+09:00", "2");

  it("一つ前の完全 snapshot だけを復元する", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "msg-1", firstIdentity);
    state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
      makeItem("千葉県", "120000", [makeKind("10", "advisory")]),
    ]), "msg-2", secondIdentity);

    expect(state.restorePrevious().isCancelRollback).toBe(true);
    expect(state.getCurrentAreasForDisplay()?.totalAreas).toBe(1);
    expect(state.getCurrentAreasForDisplay()?.kinds[0].areas[0].areaCode).toBe("140000");
  });

  it("history がなければ current を空にする", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "msg-2", secondIdentity);

    expect(state.restorePrevious().isFirstReport).toBe(true);
    expect(state.getCurrentAreasForDisplay()).toBeUndefined();
  });

  it("永続化 round-trip 後も current と history を完全復元する", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "msg-1", firstIdentity);
    state.diffAndUpdate(makeInfo([
      makeItem("千葉県", "120000", [makeKind("10", "advisory")]),
    ]), "msg-2", secondIdentity);
    const restored = new Vpws50StateHolder();
    restored.restorePersistedState(state.exportPersistedState());
    expect(restored.getCurrentAreasForDisplay()?.kinds[0].areas[0].areaCode).toBe("120000");
    restored.restorePrevious();
    expect(restored.getCurrentAreasForDisplay()?.kinds[0].areas[0].areaCode).toBe("140000");
  });

  it("官署別 VPWW55 overlay も永続化 round-trip 後に全国 base と合成する", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "base", firstIdentity);
    state.mergePartialWithDisplay(makeInfo([
      makeItem("福井県", "180000", [makeKind("33", "specialWarning")]),
    ]), "partial", secondIdentity, "weather:VPWW55:福井地方気象台");

    const restored = new Vpws50StateHolder();
    restored.restorePersistedState(state.exportPersistedState());

    expect(restored.getCurrentAreasForDisplay()?.kinds).toEqual(expect.arrayContaining([
      expect.objectContaining({ displaySeverity: "officialL5", areas: [expect.objectContaining({ areaCode: "180000" })] }),
      expect.objectContaining({ displaySeverity: "officialL3", areas: [expect.objectContaining({ areaCode: "140000" })] }),
    ]));
  });

  it("同一官署・同一市町村の VPWW55 と VPWW57 は現象単位で合成し両 kinds を保持する", () => {
    const state = new Vpws50StateHolder();
    const office = "高松地方気象台";
    state.mergePartialWithDisplay(makeInfo([
      makeItem("高松市", "3720100", [makeKind("38", "specialWarning", "高潮特別警報")]),
    ], { type: "VPWW57", publishingOffice: office }), "surge", firstIdentity,
    `weather:VPWW57:${office}`);
    state.mergePartialWithDisplay(makeInfo([
      makeItem("高松市", "3720100", [makeKind("03", "warning", "大雨警報")]),
    ], { type: "VPWW55", publishingOffice: office }), "rain", secondIdentity,
    `weather:VPWW55:${office}`);

    const kinds = state.getCurrentAreasForDisplay()?.kinds ?? [];
    expect(kinds.map((kind) => kind.kindCode)).toEqual(expect.arrayContaining(["03", "38"]));
    expect(kinds.find((kind) => kind.kindCode === "03")?.areas).toContainEqual(
      expect.objectContaining({ areaCode: "3720100" }),
    );
    expect(kinds.find((kind) => kind.kindCode === "38")?.areas).toContainEqual(
      expect.objectContaining({ areaCode: "3720100" }),
    );
  });

  it("VPWW55 の明示解除 tombstone は base の同現象だけを消し、永続化・古い base 後も保持する", () => {
    const state = new Vpws50StateHolder();
    const office = "高松地方気象台";
    const area = "3720100";
    const baseInfo = makeInfo([
      makeItem("高松市", area, [
        makeKind("03", "warning", "大雨警報"),
        makeKind("38", "specialWarning", "高潮特別警報"),
      ]),
    ]);
    state.diffAndUpdate(baseInfo, "base", firstIdentity);
    const releasedItem = makeItem("高松市", area, [makeKind("00", "release", "解除")]);
    releasedItem.statuses = [{
      kindCode: "00",
      status: "解除",
      lastKindCode: "03",
      lastKindName: "大雨警報",
    }];
    const released = state.mergePartialWithDisplay(
      makeInfo([releasedItem], { type: "VPWW55", publishingOffice: office }),
      "rain-release",
      secondIdentity,
      `weather:VPWW55:${office}`,
    );
    expect(released.diff.released[0]?.changes[0]?.phenomenonKey).toBe("大雨");
    expect(state.getCurrentAreasForDisplay()?.kinds.map((kind) => kind.kindCode)).toEqual(["38"]);

    const restored = new Vpws50StateHolder();
    restored.restorePersistedState(state.exportPersistedState());
    restored.diffAndUpdate(
      baseInfo,
      "late-old-base",
      identity("2026-06-05T14:30:00+09:00", "0"),
    );
    expect(restored.getCurrentAreasForDisplay()?.kinds.map((kind) => kind.kindCode)).toEqual(["38"]);
  });

  it("tombstone-only 履歴を後続の曖昧解除へ引き継ぎ、base を復活させない", () => {
    const state = new Vpws50StateHolder();
    const office = "高松地方気象台";
    const area = "3720100";
    const subject = `weather:VPWW55:${office}`;
    state.diffAndUpdate(makeInfo([
      makeItem("高松市", area, [makeKind("03", "warning", "大雨警報")]),
    ]), "base", firstIdentity);

    const explicitRelease = makeItem("高松市", area, [makeKind("00", "release", "解除")]);
    explicitRelease.statuses = [{
      kindCode: "00",
      status: "解除",
      lastKindCode: "03",
      lastKindName: "大雨警報",
    }];
    state.mergePartialWithDisplay(
      makeInfo([explicitRelease], { type: "VPWW55", publishingOffice: office }),
      "explicit-release",
      secondIdentity,
      subject,
    );
    expect(state.getCurrentAreasForDisplay()?.kinds).toEqual([]);

    const ambiguousRelease = makeItem("高松市", area, [makeKind("00", "release", "解除")]);
    state.mergePartialWithDisplay(
      makeInfo([ambiguousRelease], { type: "VPWW55", publishingOffice: office }),
      "ambiguous-release",
      identity("2026-06-05T16:00:00+09:00", "3"),
      subject,
    );

    expect(state.getCurrentAreasForDisplay()?.kinds).toEqual([]);
    expect(state.exportPersistedState().partialStreams?.[0]?.snapshot.clearedPhenomena).toEqual([{
      areaCode: area,
      phenomenonKeys: ["大雨"],
    }]);
  });

  it("官署別 partialHistory は永続化 round-trip 後も取消で直前報を復元する", () => {
    const subject = "weather:VPWW55:福井地方気象台";
    const state = new Vpws50StateHolder();
    state.mergePartialWithDisplay(makeInfo([
      makeItem("福井市", "1820100", [makeKind("03", "warning")]),
    ]), "partial-1", firstIdentity, subject);
    state.mergePartialWithDisplay(makeInfo([
      makeItem("福井市", "1820100", [makeKind("33", "specialWarning")]),
    ]), "partial-2", secondIdentity, subject);

    const persisted = state.exportPersistedState();
    expect(persisted.partialHistory?.[0]?.entries).toHaveLength(1);
    const restored = new Vpws50StateHolder();
    restored.restorePersistedState(persisted);
    restored.restorePreviousPartial(subject);

    expect(restored.getCurrentAreasForDisplay()?.kinds[0]).toMatchObject({
      kindCode: "03", displaySeverity: "officialL3",
    });
  });

  it("官署別 partialHistory は最新8世代に bounded され、9回目の取消で clear する", () => {
    const subject = "weather:VPWW55:福井地方気象台";
    const state = new Vpws50StateHolder();
    for (let index = 0; index < 10; index++) {
      state.mergePartialWithDisplay(makeInfo([
        makeItem(`地域${index}`, `18201${index.toString().padStart(2, "0")}`, [makeKind("03", "warning")]),
      ]), `partial-${index}`, identity(`2026-08-30T10:${index.toString().padStart(2, "0")}:00+09:00`, `${index}`), subject);
    }
    expect(state.exportPersistedState().partialHistory?.[0]?.entries).toHaveLength(8);
    for (let index = 8; index >= 1; index--) {
      state.restorePreviousPartial(subject);
      expect(state.getCurrentAreasForDisplay()?.kinds[0]?.areas[0]?.areaName).toBe(`地域${index}`);
    }
    state.restorePreviousPartial(subject);
    expect(state.getCurrentAreasForDisplay()).toBeUndefined();
  });

  it("VPNO50 の区域 tombstone は再起動後も未受信だった VPWW57 の遅延 emergency を抑制する", () => {
    const office = "福井地方気象台";
    const officeKey = `weather:office:${office}`;
    const subject = `weather:VPWW57:${office}`;
    const state = new Vpws50StateHolder();
    state.clearEmergencyPartialAreas(officeKey, ["180000"], identity("2026-08-30T11:40:00+09:00", "2"));
    const restored = new Vpws50StateHolder();
    restored.restorePersistedState(state.exportPersistedState());

    restored.mergePartialWithDisplay(makeInfo([
      makeItem("福井市", "1820100", [
        makeKind("38", "specialWarning", "高潮特別警報"),
        makeKind("49", "warning", "レベル４土砂災害警戒情報"),
      ]),
    ], { type: "VPWW57", publishingOffice: office }), "late-old",
    identity("2026-08-30T11:20:00+09:00", "1"), subject);
    expect(restored.getCurrentAreasForDisplay()?.kinds).toEqual([
      expect.objectContaining({ kindCode: "49", displaySeverity: "officialL4" }),
    ]);

    restored.mergePartialWithDisplay(makeInfo([
      makeItem("福井市", "1820100", [makeKind("38", "specialWarning", "高潮特別警報")]),
    ], { type: "VPWW57", publishingOffice: office }), "new",
    identity("2026-08-30T11:41:00+09:00", "3"), subject);
    expect(restored.getCurrentAreasForDisplay()?.kinds[0]?.displaySeverity).toBe("officialL5");
  });

  it("遅延した古い VPNO50 は tombstone 後の新しい VPWW55 L5 を消さない", () => {
    const subject = "weather:VPWW55:福井地方気象台";
    const state = new Vpws50StateHolder();
    state.clearEmergencyPartialAreas(subject, ["180000"], identity("2026-08-30T11:40:00+09:00", "2"));
    state.mergePartialWithDisplay(makeInfo([
      makeItem("福井市", "1820100", [makeKind("33", "specialWarning")]),
    ]), "new", identity("2026-08-30T11:41:00+09:00", "3"), subject);

    state.clearEmergencyPartialAreas(subject, ["180000"], identity("2026-08-30T11:39:00+09:00", "1"));
    expect(state.getCurrentAreasForDisplay()?.kinds[0]?.displaySeverity).toBe("officialL5");
    expect(state.exportPersistedState().emergencyClearTombstones?.[0]?.identity).toEqual(
      identity("2026-08-30T11:40:00+09:00", "2"),
    );
  });

  it("tombstone 128件満杯で最古区域を更新後に追加しても、更新区域をLRU退場させない", () => {
    const state = new Vpws50StateHolder();
    const subject = (index: number): string => `weather:VPWW55:試験地方気象台${index}`;
    const officeKey = (index: number): string => `weather:office:試験地方気象台${index}`;
    for (let index = 0; index < 128; index++) {
      state.clearEmergencyPartialAreas(
        subject(index),
        ["180000"],
        identity("2026-08-30T11:40:00+09:00", "1"),
      );
    }
    state.clearEmergencyPartialAreas(
      subject(0),
      ["180000"],
      identity("2026-08-30T11:41:00+09:00", "2"),
    );
    state.clearEmergencyPartialAreas(
      subject(128),
      ["180000"],
      identity("2026-08-30T11:42:00+09:00", "3"),
    );

    const tombstones = state.exportPersistedState().emergencyClearTombstones ?? [];
    expect(tombstones).toHaveLength(128);
    expect(tombstones).toContainEqual({
      officeKey: officeKey(0),
      areaCodes: ["180000"],
      identity: { reportDateTime: "2026-08-30T11:41:00+09:00", serial: "2" },
    });
    expect(tombstones.map((entry) => entry.officeKey)).toContain(officeKey(128));
    expect(tombstones.map((entry) => entry.officeKey)).not.toContain(officeKey(1));
  });

  it("tombstone 128件満杯で最古以外を更新しても他区域を退場させず、更新区域は1枠だけ使う", () => {
    const state = new Vpws50StateHolder();
    const subject = (index: number): string => `weather:VPWW55:更新試験地方気象台${index}`;
    const officeKey = (index: number): string => `weather:office:更新試験地方気象台${index}`;
    for (let index = 0; index < 128; index++) {
      state.clearEmergencyPartialAreas(
        subject(index),
        ["180000"],
        identity("2026-08-30T11:40:00+09:00", "1"),
      );
    }

    state.clearEmergencyPartialAreas(
      subject(64),
      ["180000"],
      identity("2026-08-30T11:41:00+09:00", "2"),
    );

    const tombstones = state.exportPersistedState().emergencyClearTombstones ?? [];
    expect(tombstones).toHaveLength(128);
    expect(tombstones.map((entry) => entry.officeKey)).toContain(officeKey(0));
    expect(tombstones.filter((entry) => entry.officeKey === officeKey(64))).toEqual([{
      officeKey: officeKey(64),
      areaCodes: ["180000"],
      identity: { reportDateTime: "2026-08-30T11:41:00+09:00", serial: "2" },
    }]);
  });

  it("history-only subject は128件に bounded され、active同期で退場subjectを掃除する", () => {
    const state = new Vpws50StateHolder();
    const subject = (index: number): string => `weather:VPWW55:履歴地方気象台${index}`;
    const baseMs = Date.parse("2026-08-30T00:00:00Z");
    for (let index = 0; index < 129; index++) {
      const areaCode = `18${index.toString().padStart(5, "0")}`;
      const first = new Date(baseMs + index * 60_000).toISOString();
      const second = new Date(baseMs + index * 60_000 + 20_000).toISOString();
      const clear = new Date(baseMs + index * 60_000 + 40_000).toISOString();
      state.mergePartialWithDisplay(makeInfo([
        makeItem(`地域${index}`, areaCode, [makeKind("03", "warning")]),
      ]), `warning-${index}`, identity(first, "1"), subject(index));
      state.mergePartialWithDisplay(makeInfo([
        makeItem(`地域${index}`, areaCode, [makeKind("33", "specialWarning")]),
      ]), `special-${index}`, identity(second, "2"), subject(index));
      state.clearEmergencyPartialAreas(subject(index), ["180000"], identity(clear, "3"));
    }

    const bounded = state.exportPersistedState();
    // VPNO50 は raw stream を破壊せず、表示合成時の区域 tombstone で L5 を伏せる。
    // これにより tombstone より新しい再発表を同じ stream で受理できる。
    expect(bounded.partialStreams).toHaveLength(128);
    expect(bounded.partialHistory).toHaveLength(128);
    expect(bounded.partialHistory?.map((group) => group.subjectKey)).not.toContain(subject(0));
    expect(bounded.partialHistory?.map((group) => group.subjectKey)).toContain(subject(128));

    state.retainActivePartialSubjects([subject(128)]);
    expect(state.exportPersistedState().partialHistory?.map((group) => group.subjectKey))
      .toEqual([subject(128)]);
    // 129 subject × 全 stream 合成の容量境界テストは CI の共有 runner では 5s を超える
  }, 30_000);

  it("VPNO50 は全国 VPWS50 base の L5 だけを解除し、同区域の L4 は維持する", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("福井市", "1820100", [
        makeKind("33", "specialWarning"),
        makeKind("49", "warning", "レベル４土砂災害警戒情報"),
      ]),
    ]), "base", identity("2026-08-30T11:20:00+09:00", "1"));

    state.clearEmergencyPartialAreas(
      "weather:office:福井地方気象台",
      ["180000"],
      identity("2026-08-30T11:40:00+09:00", "2"),
    );

    expect(state.getCurrentAreasForDisplay()?.kinds.map((kind) => kind.kindCode)).toEqual(["49"]);
  });

  it.each(["VPWW→VPWS→VPNO", "VPWS→VPWW→VPNO"])("%s でも base と overlay の L5 をともに隠す", (order) => {
    const state = new Vpws50StateHolder();
    const base = makeInfo([
      makeItem("福井市", "1820100", [makeKind("33", "specialWarning")]),
    ]);
    const overlay = makeInfo([
      makeItem("福井市", "1820100", [
        makeKind("38", "specialWarning", "高潮特別警報"),
        makeKind("49", "warning", "レベル４土砂災害警戒情報"),
      ]),
    ], { type: "VPWW57", publishingOffice: "福井地方気象台" });
    const subject = "weather:VPWW57:福井地方気象台";
    if (order === "VPWW→VPWS→VPNO") {
      state.mergePartialWithDisplay(overlay, "overlay", identity("2026-08-30T11:30:00+09:00", "2"), subject);
      state.diffAndUpdate(base, "base", identity("2026-08-30T11:20:00+09:00", "1"));
    } else {
      state.diffAndUpdate(base, "base", identity("2026-08-30T11:20:00+09:00", "1"));
      state.mergePartialWithDisplay(overlay, "overlay", identity("2026-08-30T11:30:00+09:00", "2"), subject);
    }

    state.clearEmergencyPartialAreas(
      "weather:office:福井地方気象台",
      ["180000"],
      identity("2026-08-30T11:40:00+09:00", "3"),
    );
    expect(state.getCurrentAreasForDisplay()?.kinds.map((kind) => kind.kindCode)).toEqual(["49"]);
  });

  it("永続化した tombstone は遅延した古い base を抑制し、新しい再発表だけを通す", () => {
    const state = new Vpws50StateHolder();
    state.clearEmergencyPartialAreas(
      "weather:office:福井地方気象台",
      ["180000"],
      identity("2026-08-30T11:40:00+09:00", "2"),
    );
    const restored = new Vpws50StateHolder();
    restored.restorePersistedState(state.exportPersistedState());
    const special = makeInfo([
      makeItem("福井市", "1820100", [makeKind("33", "specialWarning")]),
    ]);

    restored.diffAndUpdate(special, "late-base", identity("2026-08-30T11:20:00+09:00", "1"));
    expect(restored.getCurrentAreasForDisplay()?.totalAreas).toBe(0);

    restored.diffAndUpdate(special, "reissue", identity("2026-08-30T11:41:00+09:00", "3"));
    expect(restored.getCurrentAreasForDisplay()?.kinds[0]?.displaySeverity).toBe("officialL5");
  });

  it("官署が異なっても対象府県 prefix だけを解除し、同一官署の別府県 L5 は維持する", () => {
    const state = new Vpws50StateHolder();
    state.mergePartialWithDisplay(makeInfo([
      makeItem("区域A", "010100", [makeKind("33", "specialWarning")]),
      makeItem("区域B", "020100", [makeKind("38", "specialWarning", "高潮特別警報")]),
    ], { type: "VPWW55", publishingOffice: "札幌管区気象台" }), "partial",
    identity("2026-08-30T11:20:00+09:00", "1"), "weather:VPWW55:札幌管区気象台");

    state.clearEmergencyPartialAreas(
      "weather:office:別の気象台",
      ["010000"],
      identity("2026-08-30T11:40:00+09:00", "2"),
    );
    const activeAreas = state.getCurrentAreasForDisplay()?.kinds.flatMap((kind) => kind.areas.map((area) => area.areaCode));
    expect(activeAreas).toEqual(["020100"]);
  });

  it("128 tombstone 境界でも active partial subject を対応づけたまま保持する", () => {
    const state = new Vpws50StateHolder();
    const activeSubject = "weather:VPWW55:稼働中地方気象台";
    state.mergePartialWithDisplay(makeInfo([
      makeItem("稼働区域", "990100", [makeKind("33", "specialWarning")]),
    ]), "active", identity("2026-08-30T11:20:00+09:00", "1"), activeSubject);
    for (let index = 0; index < 128; index++) {
      state.clearEmergencyPartialAreas(
        `weather:office:境界地方気象台${index}`,
        [`${(index % 90 + 10).toString().padStart(2, "0")}0000`],
        identity("2026-08-30T11:40:00+09:00", "2"),
      );
    }
    state.retainActivePartialSubjects([activeSubject]);

    const persisted = state.exportPersistedState();
    expect(persisted.emergencyClearTombstones).toHaveLength(128);
    expect(persisted.partialStreams?.map((entry) => entry.subjectKey)).toEqual([activeSubject]);
  });

  it("旧形式・破損 snapshot は破棄し、次の受信で安全に再構築する", () => {
    const legacy = {
      current: {
        messageId: "legacy",
        identity: { reportDateTime: "2026-06-05T15:00:00+09:00", serial: "1" },
        // marker 導入前の府県粒度 snapshot。配列構造自体は現行と同じでも復元しない。
        snapshot: {
          areas: [{
            areaCode: "120000",
            areaName: "千葉県",
            kinds: [{
              phenomenonKey: "rain",
              kindCode: "03",
              kindName: "大雨警報",
              severity: "warning",
              displaySeverity: "officialL3",
              officialAlertLevel: 3,
              resolutionSource: "map",
            }],
          }],
        },
      },
      history: [],
      lastSuccessfulFullDisplayAt: null,
    } as unknown as PersistedVpws50StateV2;
    const restored = new Vpws50StateHolder();

    expect(() => restored.restorePersistedState(legacy)).not.toThrow();
    expect(restored.getCurrentAreasForDisplay()).toBeUndefined();

    restored.diffAndUpdate(makeInfo([
      makeItem("市原市", "122190", [makeKind("03", "warning")]),
    ]), "rebuild");
    expect(restored.getCurrentAreasForDisplay()?.kinds[0]?.areas[0]).toEqual({
      areaName: "市原市",
      areaCode: "122190",
    });
  });
});

describe("Vpws50StateHolder.confidence (Plan-R1: 二段判定 confirmed/unsafe)", () => {
  it("layer 不在 → confidence=unsafe, unsafeReason=layer_missing, state 不変", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "msg-1");
    const broken: ParsedWeatherWarning = { ...makeInfo([]), layers: [] };
    const diff = state.diffAndUpdate(broken, "msg-2");
    expect(diff.confidence).toBe("unsafe");
    expect(diff.unsafeReason).toBe("layer_missing");
    const verify = state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "msg-3");
    expect(verify.isUnchanged).toBe(true);
  });

  it("layer あり items 空 (state 空) → confidence=confirmed", () => {
    const state = new Vpws50StateHolder();
    const diff = state.diffAndUpdate(makeInfo([]), "msg-1");
    expect(diff.confidence).toBe("confirmed");
  });

  it("layer あり items 空 (state 非空) → 全種別解除は confirmed + 現況空 (レビュー決定 2026-07-11)", () => {
    // 全種別 (100%) 一斉解除は正当として通し current を空にする (台風通過後の全解除等で
    // 気象カードを確実に消すため)。80% 以上 100% 未満の部分大量解除のみ異常電文防御の対象。
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
      makeItem("千葉県", "120000", [makeKind("10", "advisory")]),
    ]), "msg-1");
    const diff = state.diffAndUpdate(makeInfo([]), "msg-2");
    expect(diff.confidence).toBe("confirmed");
    expect(diff.unsafeReason).toBeUndefined();
    // current は空スナップショットに更新される (kinds 0 / totalAreas 0 → 下流でカード消滅)
    const view = state.getCurrentAreasForDisplay();
    expect(view?.kinds).toHaveLength(0);
    expect(view?.totalAreas).toBe(0);
  });

  it("80% 以上消失 → unsafe", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("A県", "010000", [makeKind("03", "warning")]),
      makeItem("B県", "020000", [makeKind("03", "warning")]),
      makeItem("C県", "030000", [makeKind("03", "warning")]),
      makeItem("D県", "040000", [makeKind("03", "warning")]),
      makeItem("E県", "050000", [makeKind("03", "warning")]),
      makeItem("F県", "060000", [makeKind("03", "warning")]),
      makeItem("G県", "070000", [makeKind("03", "warning")]),
      makeItem("H県", "080000", [makeKind("03", "warning")]),
      makeItem("I県", "090000", [makeKind("03", "warning")]),
      makeItem("J県", "100000", [makeKind("03", "warning")]),
    ]), "msg-1");
    const diff = state.diffAndUpdate(makeInfo([
      makeItem("J県", "100000", [makeKind("03", "warning")]),
    ]), "msg-2");
    expect(diff.confidence).toBe("unsafe");
    expect(diff.unsafeReason).toBe("abnormal_release_rate");
  });

  it("80% 未満消失 → confidence=confirmed、解除多数も含む", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("A県", "010000", [makeKind("03", "warning")]),
      makeItem("B県", "020000", [makeKind("03", "warning")]),
      makeItem("C県", "030000", [makeKind("03", "warning")]),
      makeItem("D県", "040000", [makeKind("03", "warning")]),
      makeItem("E県", "050000", [makeKind("03", "warning")]),
    ]), "msg-1");
    const diff = state.diffAndUpdate(makeInfo([
      makeItem("D県", "040000", [makeKind("03", "warning")]),
      makeItem("E県", "050000", [makeKind("03", "warning")]),
    ]), "msg-2");
    expect(diff.confidence).not.toBe("unsafe");
    expect(diff.released).toHaveLength(3);
  });
});

describe("Vpws50StateHolder.shouldRecap (R1-5/EC-8)", () => {
  it("警報あり、最後フル表示から 30 分: shouldRecap=false", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "msg-1");
    state.__test_setLastSuccessfulFullDisplayAt(new Date(Date.now() - 30 * 60 * 1000));
    const diff = state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "msg-2");
    expect(diff.isUnchanged).toBe(true);
    expect(diff.shouldRecap).toBe(false);
  });

  it("警報あり、最後フル表示から 65 分: shouldRecap=true", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "msg-1");
    state.__test_setLastSuccessfulFullDisplayAt(new Date(Date.now() - 65 * 60 * 1000));
    const diff = state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "msg-2");
    expect(diff.shouldRecap).toBe(true);
  });

  it("注意報のみ 65 分経過: shouldRecap=false", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("茨城県", "080000", [makeKind("14", "advisory")]),
    ]), "msg-1");
    state.__test_setLastSuccessfulFullDisplayAt(new Date(Date.now() - 65 * 60 * 1000));
    const diff = state.diffAndUpdate(makeInfo([
      makeItem("茨城県", "080000", [makeKind("14", "advisory")]),
    ]), "msg-2");
    expect(diff.shouldRecap).toBe(false);
  });

  it("unsafe では lastSuccessfulFullDisplayAt を更新しない (R2-6)", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
    ]), "msg-1");
    const before = state.__test_getLastSuccessfulFullDisplayAt();
    state.diffAndUpdate({ ...makeInfo([]), layers: [] }, "msg-2");
    const after = state.__test_getLastSuccessfulFullDisplayAt();
    expect(after).toEqual(before);
  });

  it("rollback 失敗 (history 空) 後の lastSuccessfulFullDisplayAt は更新されない (R3)", () => {
    const state = new Vpws50StateHolder();
    const before = state.__test_getLastSuccessfulFullDisplayAt();
    state.rollback("cancel-msg");
    const after = state.__test_getLastSuccessfulFullDisplayAt();
    expect(after).toEqual(before);
  });
});

describe("Vpws50StateHolder.getDetail (DetailProvider)", () => {
  it("current 空なら null", () => {
    const state = new Vpws50StateHolder();
    expect(state.getDetail()).toBeNull();
  });

  it("emptyMessage は spec で定義した文字列", () => {
    const state = new Vpws50StateHolder();
    expect(state.emptyMessage).toBe("VPWS50 の最新電文を受信していません");
  });

  it("受信済なら vpws50 snapshot を返す", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(makeInfo([
      makeItem("茨城県", "080000", [makeKind("03", "warning")]),
    ]), "msg-1");
    const snapshot = state.getDetail();
    expect(snapshot?.kind).toBe("vpws50");
    expect(snapshot?.display.kinds[0].areas[0].areaName).toBe("茨城県");
  });
});
