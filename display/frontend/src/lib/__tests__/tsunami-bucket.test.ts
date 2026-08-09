import { describe, expect, it } from "vitest";
import { tsunamiNankaiInput, tsunamiStressInput } from "../../preview/fixtures";
import {
  bucketTsunamiArrival,
  bucketTsunamiHeight,
  formatArrivalDisplay,
  maxTsunamiObservation,
} from "../tsunami-bucket";
import type { DisplayTsunamiHeightSemanticV1 } from "../protocol";

function heightSemantic(
  over: Partial<DisplayTsunamiHeightSemanticV1> = {},
): DisplayTsunamiHeightSemanticV1 {
  return {
    raw: null,
    presence: "unknown",
    label: "不明",
    condition: null,
    description: null,
    value: null,
    lowerBound: null,
    upperBound: null,
    rawLowerBound: null,
    rawUpperBound: null,
    badge: "?",
    color: "unknown",
    render: true,
    ...over,
  };
}

describe("bucketTsunamiHeight", () => {
  it("null / 空配列", () => {
    expect(bucketTsunamiHeight([])).toEqual([]);
    expect(bucketTsunamiHeight([{ maxHeight: null }])).toEqual([{ label: "不明", count: 1 }]);
  });

  it("定性値の表示は保ったまま既存の内部安全順序で数値と混在ソートする", () => {
    expect(bucketTsunamiHeight([
      { maxHeight: "高い" },
      { maxHeight: "巨大" },
      { maxHeight: "１０ｍ超" },
      { maxHeight: "３．２ｍ" },
      { maxHeight: "０．２ｍ未満" },
    ])).toEqual([
      { label: "巨大", count: 1 },
      { label: "１０ｍ超", count: 1 },
      { label: "３．２ｍ", count: 1 },
      { label: "高い", count: 1 },
      { label: "０．２ｍ未満", count: 1 },
    ]);
  });

  it("semantic がある行は raw scalar を読まず、bounds と qualifier を真実源にする", () => {
    const buckets = bucketTsunamiHeight([
      {
        maxHeight: "999m",
        maxHeightSemantic: heightSemantic({
          raw: "巨大", presence: "qualitative", label: "巨大", badge: "?", color: "unknown",
        }),
      },
      {
        maxHeight: "0m",
        maxHeightSemantic: heightSemantic({
          raw: "2", presence: "qualitative", label: "2m程度以上", lowerBound: 2,
          badge: "≥", color: "safetyRank", rawLowerBound: "2",
        }),
      },
      {
        maxHeight: "1m",
        maxHeightSemantic: heightSemantic({
          raw: "1", presence: "range", label: "1〜4m", lowerBound: 1, upperBound: 4,
          badge: "↔", color: "safetyUpperRank", rawLowerBound: "1", rawUpperBound: "4",
        }),
      },
    ]);
    expect(buckets.map(({ label, count, semantic }) => ({ label, count, badge: semantic?.badge }))).toEqual([
      { label: "巨大", count: 1, badge: "?" },
      { label: "1〜4m", count: 1, badge: "↔" },
      { label: "2m程度以上", count: 1, badge: "≥" },
    ]);
  });

  it.each([
    [
      heightSemantic({ raw: "0.2", presence: "value", label: "0.2m", value: 0.2, badge: null, color: "normalRank" }),
      heightSemantic({ raw: "0.2", presence: "range", label: "0.2m未満", upperBound: 0.2, badge: "↔", color: "safetyUpperRank" }),
      "0.2m",
    ],
    [
      heightSemantic({ raw: "4", presence: "value", label: "4m", value: 4, badge: null, color: "normalRank" }),
      heightSemantic({ raw: "1〜4", presence: "range", label: "1〜4m", lowerBound: 1, upperBound: 4, badge: "↔", color: "safetyUpperRank" }),
      "4m",
    ],
  ] as const)("同じ比較値では upper 主導 range より exact %s を上位にする", (exact, upperRange, expected) => {
    const entries = [
      { maxHeight: "legacy ignored", maxHeightSemantic: upperRange },
      { maxHeight: "legacy ignored", maxHeightSemantic: exact },
    ];
    expect(bucketTsunamiHeight(entries)[0]?.label).toBe(expected);
    expect(maxTsunamiObservation(entries.map((entry, index) => ({
      stationName: index === 0 ? "range" : "exact",
      maxHeightValue: entry.maxHeight,
      maxHeightSemantic: entry.maxHeightSemantic,
    })))?.stationName).toBe("exact");
  });

  it("同じ比較値では lower-only を exact より上位にする", () => {
    const lower = heightSemantic({
      raw: "4", presence: "range", label: "4m以上", lowerBound: 4,
      badge: "≥", color: "safetyRank",
    });
    const exact = heightSemantic({
      raw: "4", presence: "value", label: "4m", value: 4,
      badge: null, color: "normalRank",
    });
    expect(bucketTsunamiHeight([
      { maxHeight: "4m", maxHeightSemantic: exact },
      { maxHeight: "4m以上", maxHeightSemantic: lower },
    ])[0]?.label).toBe("4m以上");
  });

  it("semantic の missing は非描画、empty/unknown は数値比較せず識別可能なまま集計する", () => {
    expect(bucketTsunamiHeight([
      {
        maxHeight: "10m",
        maxHeightSemantic: heightSemantic({ presence: "missing", label: null, badge: null, color: "notRendered", render: false }),
      },
      {
        maxHeight: "10m",
        maxHeightSemantic: heightSemantic({ presence: "empty", label: "空欄", badge: "∅", color: "neutral" }),
      },
      {
        maxHeight: "10m",
        maxHeightSemantic: heightSemantic({ presence: "unknown", label: "不明", badge: "?", color: "unknown" }),
      },
    ])).toEqual([
      { label: "空欄", count: 1, semantic: expect.objectContaining({ badge: "∅" }) },
      { label: "不明", count: 1, semantic: expect.objectContaining({ badge: "?" }) },
    ]);
  });

  it("semantic の空文字・空白 label は有効表示にせず presence 別 fallback を使う", () => {
    expect(bucketTsunamiHeight([
      {
        maxHeight: "999m",
        maxHeightSemantic: heightSemantic({ presence: "unknown", label: "  \t" }),
      },
      {
        maxHeight: "999m",
        maxHeightSemantic: heightSemantic({
          raw: "", presence: "empty", label: "", badge: "∅", color: "neutral",
        }),
      },
    ])).toEqual([
      { label: "空欄", count: 1, semantic: expect.objectContaining({ presence: "empty" }) },
      { label: "不明", count: 1, semantic: expect.objectContaining({ presence: "unknown" }) },
    ]);
  });

  it("semantic の bounds なし定性は巨大・高いだけ内部安全順序を使い、状態表現は数値の後に保つ", () => {
    const buckets = bucketTsunamiHeight([
      {
        maxHeight: "999m",
        maxHeightSemantic: heightSemantic({
          raw: "", presence: "qualitative", label: "観測中", condition: "観測中",
          badge: "?", color: "unknown",
        }),
      },
      {
        maxHeight: "999m",
        maxHeightSemantic: heightSemantic({
          raw: "高い", presence: "qualitative", label: "高い", badge: "?", color: "unknown",
        }),
      },
      {
        maxHeight: "0m",
        maxHeightSemantic: heightSemantic({
          raw: "10", presence: "value", label: "10m", value: 10,
          badge: null, color: "normalRank",
        }),
      },
      {
        maxHeight: "0m",
        maxHeightSemantic: heightSemantic({
          raw: "巨大", presence: "qualitative", label: "巨大", badge: "?", color: "unknown",
        }),
      },
    ]);
    expect(buckets.map((bucket) => bucket.label)).toEqual(["巨大", "10m", "高い", "観測中"]);
  });

  it("パース不能な文字列は不明バケツへ安全側フォールバック", () => {
    expect(bucketTsunamiHeight([{ maxHeight: "非常に高い" }])).toEqual([
      { label: "不明", count: 1 },
    ]);
  });

  it("非標準の波高値 (4m/2m/0.5m 等) が distinct バケツとして件数降順の値で並ぶ", () => {
    const coasts = [
      { maxHeight: "0.5m" },
      { maxHeight: "4m" },
      { maxHeight: "10m超" },
      { maxHeight: "2m" },
      { maxHeight: "10m" },
      { maxHeight: "4m" },
    ];
    expect(bucketTsunamiHeight(coasts)).toEqual([
      { label: "10m超", count: 1 },
      { label: "10m", count: 1 },
      { label: "4m", count: 2 },
      { label: "2m", count: 1 },
      { label: "0.5m", count: 1 },
    ]);
  });

  it("同数値は 10m超 が 10m より上位に並ぶ", () => {
    const coasts = [{ maxHeight: "10m" }, { maxHeight: "10m超" }];
    expect(bucketTsunamiHeight(coasts)).toEqual([
      { label: "10m超", count: 1 },
      { label: "10m", count: 1 },
    ]);
  });

  it("tsunamiStress (大津波警報9区+警報・注意報込み50区) を全区不明なく分類する", () => {
    const buckets = bucketTsunamiHeight(tsunamiStressInput.coasts);
    expect(buckets).toEqual([
      { label: "10m超", count: 3 },
      { label: "4m", count: 1 },
      { label: "3m", count: 6 },
      { label: "2m", count: 8 },
      { label: "1m", count: 11 },
      { label: "0.5m", count: 21 },
    ]);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(tsunamiStressInput.coasts.length);
  });

  it("tsunamiNankaiInput (17予報区・大津波警報主体+警報・注意報込み計29区) を全区不明なく分類する", () => {
    const buckets = bucketTsunamiHeight(tsunamiNankaiInput.coasts);
    expect(buckets).toEqual([
      { label: "10m超", count: 8 },
      { label: "10m", count: 1 },
      { label: "5m", count: 7 },
      { label: "3m", count: 2 },
      { label: "1m", count: 7 },
      { label: "0.2m", count: 4 },
    ]);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(tsunamiNankaiInput.coasts.length);
  });
});

describe("bucketTsunamiArrival", () => {
  const REPORT = "2026-07-09T09:17:18+09:00";

  it("null / 空配列", () => {
    expect(bucketTsunamiArrival([], REPORT)).toEqual([]);
    expect(bucketTsunamiArrival([{ firstHeight: null }], REPORT)).toEqual([
      { label: "到達時期不明", count: 1 },
    ]);
  });

  it("パース不能な文字列は到達時期不明バケツへ安全側フォールバック", () => {
    expect(bucketTsunamiArrival([{ firstHeight: "不明瞭" }, { firstHeight: "検討中" }], REPORT)).toEqual([
      { label: "到達時期不明", count: 2 },
    ]);
  });

  it("既に・ただちに・直ちに系の語は既に・直ちにバケツへ", () => {
    const coasts = [
      { firstHeight: "既に到達と推測" },
      { firstHeight: "ただちに津波来襲と予測" },
      { firstHeight: "直ちに到達と予想" },
    ];
    expect(bucketTsunamiArrival(coasts, REPORT)).toEqual([{ label: "既に・直ちに", count: 3 }]);
  });

  it("境界: ちょうど30分は30分以内、31分は1時間以内、ちょうど60分は1時間以内、61分はそれ以降", () => {
    // 秒のずれで境界がぼやけないよう reportDateTime を :00 秒に揃える
    const REPORT_ON_MINUTE = "2026-07-09T09:00:00+09:00";
    const coasts = [
      { firstHeight: "09時30分頃" }, // ちょうど+30分 -> 30分以内 (以内=含む)
      { firstHeight: "09時31分頃" }, // +31分 -> 1時間以内
      { firstHeight: "10時00分頃" }, // ちょうど+60分 -> 1時間以内 (以内=含む)
      { firstHeight: "10時01分頃" }, // +61分 -> それ以降
    ];
    const buckets = bucketTsunamiArrival(coasts, REPORT_ON_MINUTE);
    const byLabel = Object.fromEntries(buckets.map((b) => [b.label, b.count]));
    expect(byLabel["30分以内"]).toBe(1);
    expect(byLabel["1時間以内"]).toBe(2);
    expect(byLabel["それ以降"]).toBe(1);
  });

  it("報告時刻以前の時刻表記 (地震発生から2分後に到達済み等) は既に・直ちにへ合流する", () => {
    // 実値: fixtures.ts:1294 静岡県 "09時14分頃（地震発生から2分）" は reportDateTime 09:17:18 より前
    const coasts = [{ firstHeight: "09時14分頃（地震発生から2分）" }];
    expect(bucketTsunamiArrival(coasts, REPORT)).toEqual([{ label: "既に・直ちに", count: 1 }]);
  });

  it("括弧内の補足時間表現に惑わされず本体の時刻を拾う (までに到達 N分以内)", () => {
    // 実値: fixtures.ts:1297 三重県南部 "09時17分までに到達（5分以内）"
    const coasts = [{ firstHeight: "09時17分までに到達（5分以内）" }];
    expect(bucketTsunamiArrival(coasts, REPORT)).toEqual([{ label: "既に・直ちに", count: 1 }]);
  });

  it("tsunamiStress (50区) を全区・到達時期不明なく分類する", () => {
    const buckets = bucketTsunamiArrival(tsunamiStressInput.coasts, tsunamiStressInput.reportDateTime);
    expect(buckets).toEqual([
      { label: "既に・直ちに", count: 5 },
      { label: "30分以内", count: 2 },
      { label: "1時間以内", count: 3 },
      { label: "それ以降", count: 40 },
    ]);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(tsunamiStressInput.coasts.length);
  });

  it("tsunamiNankaiInput (29区) を全区・到達時期不明なく分類する", () => {
    const buckets = bucketTsunamiArrival(tsunamiNankaiInput.coasts, tsunamiNankaiInput.reportDateTime);
    expect(buckets).toEqual([
      { label: "既に・直ちに", count: 7 },
      { label: "30分以内", count: 7 },
      { label: "1時間以内", count: 3 },
      { label: "それ以降", count: 12 },
    ]);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(tsunamiNankaiInput.coasts.length);
  });

  it("reportDateTime 自体が不正なら時刻表記も到達時期不明へ安全側フォールバックする (既に・直ちにの語は例外)", () => {
    expect(bucketTsunamiArrival([{ firstHeight: "07日15時30分頃" }], "invalid-date")).toEqual([
      { label: "到達時期不明", count: 1 },
    ]);
    expect(bucketTsunamiArrival([{ firstHeight: "既に到達と推測" }], "invalid-date")).toEqual([
      { label: "既に・直ちに", count: 1 },
    ]);
  });
});

describe("maxTsunamiObservation", () => {
  it("空配列・全件パース不能なら null (安全側で行ごと非表示にする判断は呼び出し側)", () => {
    expect(maxTsunamiObservation([])).toBeNull();
    expect(
      maxTsunamiObservation([
        { stationName: "A", maxHeightValue: null },
        { stationName: "B", maxHeightValue: "観測中断" },
      ]),
    ).toBeNull();
  });

  it("パースできた値だけを比較し数値最大の観測点を返す (null・不能値は無視)", () => {
    const result = maxTsunamiObservation([
      { stationName: "宮古", maxHeightValue: "8.5m以上" },
      { stationName: "大船渡", maxHeightValue: null },
      { stationName: "相馬", maxHeightValue: "9.3m以上" },
      { stationName: "大洗", maxHeightValue: "4.0m" },
      { stationName: "不明地点", maxHeightValue: "観測中" },
    ]);
    expect(result).toEqual({ stationName: "相馬", label: "9.3m以上" });
  });

  it("同値なら先に現れた観測点を優先する", () => {
    const result = maxTsunamiObservation([
      { stationName: "先", maxHeightValue: "5.0m" },
      { stationName: "後", maxHeightValue: "5.0m" },
    ]);
    expect(result?.stationName).toBe("先");
  });

  it("全角・未満・超を NFKC 後に比較し、原文を代表値として保つ", () => {
    const result = maxTsunamiObservation([
      { stationName: "小", maxHeightValue: "０．２ｍ未満" },
      { stationName: "中", maxHeightValue: "３．２ｍ" },
      { stationName: "大", maxHeightValue: "１０ｍ超" },
    ]);
    expect(result).toEqual({ stationName: "大", label: "１０ｍ超" });
  });

  it("旧 V1 定性値は表示を保ち、巨大=最上位・高い=3m相当の内部安全順序だけで比較する", () => {
    expect(maxTsunamiObservation([
      { stationName: "数値", maxHeightValue: "10m" },
      { stationName: "定性", maxHeightValue: "巨大" },
    ])).toEqual({ stationName: "定性", label: "巨大" });
    expect(maxTsunamiObservation([
      { stationName: "注意報", maxHeightValue: "1m" },
      { stationName: "警報", maxHeightValue: "高い" },
    ])).toEqual({ stationName: "警報", label: "高い" });
    expect(maxTsunamiObservation([
      { stationName: "警報", maxHeightValue: "高い" },
      { stationName: "数値", maxHeightValue: "10m" },
    ])).toEqual({ stationName: "数値", label: "10m" });
  });

  it("semantic 観測は scalar を再解釈せず、高いの内部順位と bounds を比較する", () => {
    const result = maxTsunamiObservation([
      {
        stationName: "定性",
        maxHeightValue: "999m",
        maxHeightSemantic: heightSemantic({
          raw: "高い", presence: "qualitative", label: "高い", badge: "?", color: "unknown",
        }),
      },
      {
        stationName: "範囲",
        maxHeightValue: "0m",
        maxHeightSemantic: heightSemantic({
          presence: "range", label: "2〜5m", lowerBound: 2, upperBound: 5,
          badge: "↔", color: "safetyUpperRank",
        }),
      },
    ]);
    expect(result).toMatchObject({ stationName: "範囲", label: "2〜5m", semantic: { badge: "↔" } });
    expect(maxTsunamiObservation([
      {
        stationName: "実測",
        maxHeightValue: "10m",
        maxHeightSemantic: heightSemantic({
          raw: "10", presence: "value", label: "10m", value: 10,
          badge: null, color: "normalRank",
        }),
      },
      {
        stationName: "定性",
        maxHeightValue: "0m",
        maxHeightSemantic: heightSemantic({
          raw: "巨大", presence: "qualitative", label: "巨大", badge: "?", color: "unknown",
        }),
      },
    ])).toMatchObject({ stationName: "定性", label: "巨大", semantic: { badge: "?" } });
  });

  it("semantic の bounds なし状態表現は最大選定から外し、全件が状態表現なら null", () => {
    const observing = heightSemantic({
      raw: "", presence: "qualitative", label: "観測中", condition: "観測中",
      badge: "?", color: "unknown",
    });
    expect(maxTsunamiObservation([
      { stationName: "未計測", maxHeightValue: "", maxHeightSemantic: observing },
      {
        stationName: "実測",
        maxHeightValue: "10m",
        maxHeightSemantic: heightSemantic({
          raw: "10", presence: "value", label: "10m", value: 10,
          badge: null, color: "normalRank",
        }),
      },
    ])).toMatchObject({ stationName: "実測", label: "10m" });
    expect(maxTsunamiObservation([
      { stationName: "未計測", maxHeightValue: "", maxHeightSemantic: observing },
    ])).toBeNull();
  });
});

// T7 レビュー決定 (spec §2-c【確定 2026-07-10】): .coast-first の nowrap 化 (T6c ③) で
// 長文の閉じ括弧が列幅から欠けていたため、表示専用の整形関数を追加した。分類 (bucketTsunamiArrival)
// は元の firstHeight 文字列のままで、この関数の出力を分類に使わないことを別途確認する
describe("formatArrivalDisplay", () => {
  it("null はそのまま null を返す (呼び出し側の \"-\" フォールバックに委ねる)", () => {
    expect(formatArrivalDisplay(null)).toBeNull();
  });

  it("括弧補足が無い時刻表記は「H時M分」を「H:M」に変換するだけ (頃はそのまま残る)", () => {
    expect(formatArrivalDisplay("09時30分頃")).toBe("09:30頃");
  });

  it("日付き時刻表記は日部分を変えず時刻部分だけコロン化する", () => {
    // 実値: fixtures.ts の "07日15時30分頃" 相当 (bucketTsunamiArrival テストと同じ表記)
    expect(formatArrivalDisplay("07日15時30分頃")).toBe("07日15:30頃");
  });

  it("括弧補足 (地震発生からN分) を削り、時刻をコロン化する", () => {
    // 実値: fixtures.ts:1294 静岡県 "09時14分頃（地震発生から2分）"
    expect(formatArrivalDisplay("09時14分頃（地震発生から2分）")).toBe("09:14頃");
  });

  it("括弧補足 (N分以内) を削り、「までに到達」等の語尾は残したうえで時刻をコロン化する", () => {
    // 実値: fixtures.ts:1297 三重県南部 "09時17分までに到達（5分以内）"
    expect(formatArrivalDisplay("09時17分までに到達（5分以内）")).toBe("09:17までに到達");
  });

  it("非時刻文 (既に・ただちに・直ちに系) はそのまま変更しない", () => {
    expect(formatArrivalDisplay("既に到達と推測")).toBe("既に到達と推測");
    expect(formatArrivalDisplay("ただちに津波来襲と予測")).toBe("ただちに津波来襲と予測");
    expect(formatArrivalDisplay("直ちに到達と予想")).toBe("直ちに到達と予想");
  });

  it("パース不能・想定外の自由文字列もそのまま返す (安全側、括弧補足だけは削る)", () => {
    expect(formatArrivalDisplay("不明瞭")).toBe("不明瞭");
    expect(formatArrivalDisplay("検討中（詳細確認中）")).toBe("検討中");
  });

  it("bucketTsunamiArrival の分類には影響しない (formatArrivalDisplay の出力を分類に渡しても意味が変わらないことの確認ではなく、元の raw 文字列で分類されることの確認)", () => {
    // formatArrivalDisplay 適用後の "09:17までに到達" を分類に渡すと TIME_PATTERN (時+分必須) に
    // マッチせず「到達時期不明」に落ちてしまう (コロン形式は分類側の対象外)。TsunamiPanel.svelte
    // は分類に c.firstHeight (整形前) を、表示に formatArrivalDisplay(c.firstHeight) を別々に
    // 使っており、分類側の入力が整形後の文字列にすり替わっていないことをここで担保する
    const report = "2026-07-09T09:17:18+09:00";
    const raw = "09時17分までに到達（5分以内）";
    const displayed = formatArrivalDisplay(raw);
    expect(bucketTsunamiArrival([{ firstHeight: raw }], report)).toEqual([
      { label: "既に・直ちに", count: 1 },
    ]);
    expect(bucketTsunamiArrival([{ firstHeight: displayed }], report)).toEqual([
      { label: "到達時期不明", count: 1 },
    ]);
  });
});
