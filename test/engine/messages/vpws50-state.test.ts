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

function makeInfo(items: WeatherItem[], opts: { infoType?: string } = {}): ParsedWeatherWarning {
  const layers = [{ type: "気象警報・注意報（府県予報区等）", items }];
  return {
    meta: testTelegramMeta(false),
    type: "VPWS50",
    infoType: opts.infoType ?? "発表",
    title: "気象警報・注意報",
    reportDateTime: "2026-06-05T15:18:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
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
