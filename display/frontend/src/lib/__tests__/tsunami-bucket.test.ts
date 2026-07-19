import { describe, expect, it } from "vitest";
import { tsunamiNankaiInput, tsunamiStressInput } from "../../preview/fixtures";
import {
  bucketTsunamiArrival,
  bucketTsunamiHeight,
  formatArrivalDisplay,
  maxTsunamiObservation,
} from "../tsunami-bucket";

describe("bucketTsunamiHeight", () => {
  it("null / 空配列", () => {
    expect(bucketTsunamiHeight([])).toEqual([]);
    expect(bucketTsunamiHeight([{ maxHeight: null }])).toEqual([{ label: "不明", count: 1 }]);
  });

  it("パース不能な文字列は不明バケツへ安全側フォールバック", () => {
    expect(bucketTsunamiHeight([{ maxHeight: "巨大" }, { maxHeight: "10m未満" }])).toEqual([
      { label: "不明", count: 2 },
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
