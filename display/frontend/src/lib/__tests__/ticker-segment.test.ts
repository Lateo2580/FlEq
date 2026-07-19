import { describe, it, expect } from "vitest";
import {
  segmentTickerBody,
  normalizeForInvariant,
  SEG_TARGET_MIN,
  SEG_TARGET_MAX,
  splitRuns,
  lastPassedBookmark,
  mapEmphasisToSegments,
  splitEmphasis,
} from "../ticker-segment";

/** テスト用: n 文字の全角文字列 */
function jchars(n: number, ch = "あ"): string {
  return ch.repeat(n);
}

describe("segmentTickerBody", () => {
  it("空/空白のみは [] (フォールバックは呼び出し側)", () => {
    expect(segmentTickerBody(null)).toEqual([]);
    expect(segmentTickerBody(undefined)).toEqual([]);
    expect(segmentTickerBody("   ")).toEqual([]);
  });

  it("短い本文 (min 未満) は 1 セグメントのまま (帯を外れてよい)", () => {
    const out = segmentTickerBody("短い解説です。");
    expect(out).toEqual(["短い解説です。"]);
  });

  it("句点で文単位に割り、min 未満の断片は次と貪欲マージする", () => {
    // 各文 40 字 → 2 文で 80 字にマージ (min=60 を満たす)
    const s1 = jchars(39) + "。";
    const s2 = jchars(39) + "。";
    const out = segmentTickerBody(s1 + s2);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(s1 + s2);
  });

  it("max 超の 1 文は読点境界で再分割する", () => {
    // 読点で 3 分割: 各 50 字 → 50+50=100 でマージ, 残り 50
    const part = jchars(49) + "、";
    const body = part + part + part; // 150 字 1 文 (句点なし)
    const out = segmentTickerBody(body);
    for (const seg of out) {
      expect(Array.from(seg).length).toBeLessThanOrEqual(SEG_TARGET_MAX);
    }
    expect(out.length).toBeGreaterThan(1);
  });

  it("読点でも割れない超長文は max 字でハード分割する", () => {
    const body = jchars(250); // 句読点なし 250 字
    const out = segmentTickerBody(body);
    for (const seg of out) {
      expect(Array.from(seg).length).toBeLessThanOrEqual(SEG_TARGET_MAX);
    }
    // 250 / 100 = 3 セグメント (100,100,50)
    expect(out.length).toBe(3);
  });

  it("大半のセグメントが 60-100 字帯に収まる (全数一致は要求しない)", () => {
    const body = Array.from({ length: 10 }, () => jchars(45) + "。").join("");
    const out = segmentTickerBody(body);
    const inBand = out.filter((s) => {
      const n = Array.from(s).length;
      return n >= SEG_TARGET_MIN && n <= SEG_TARGET_MAX;
    });
    expect(inBand.length).toBeGreaterThanOrEqual(out.length - 1); // 末尾以外は帯内
  });

  it("見出し (【概況】) は直後の本文と同じセグメントに残る", () => {
    const body = "【概況】" + jchars(50) + "。";
    const out = segmentTickerBody(body);
    expect(out[0].startsWith("【概況】")).toBe(true);
  });

  it("内容保存 invariant: normalize(join) === normalize(original) — 改行込み複数セクション", () => {
    const body =
      "【概況】" + jchars(80) + "。" + jchars(70) + "。\n" +
      "【防災事項】" + jchars(120) + "、" + jchars(90) + "。";
    const out = segmentTickerBody(body);
    expect(normalizeForInvariant(out.join(""))).toBe(normalizeForInvariant(body));
  });

  it("内容保存 invariant: 読点のみの長文 (VPTA 相当 600 字級) でも文字を落とさない", () => {
    // 「、」区切りだけの長大本文 (句点なし) — 前回挙げた VPTA の懸念ケース
    const body = "台風の暴風域に入る確率（府県内最大・5日積算・カッコ内はピーク時間帯）：" +
      Array.from({ length: 45 }, (_, i) => `地域${i} ${i % 100}%（${i}日12時）`).join("、") + "。";
    const out = segmentTickerBody(body);
    expect(normalizeForInvariant(out.join(""))).toBe(normalizeForInvariant(body));
    for (const seg of out) {
      expect(Array.from(seg).length).toBeLessThanOrEqual(SEG_TARGET_MAX);
    }
  });

  it("opts で min/max を上書きできる (preview 調整前提)", () => {
    const body = jchars(60);
    const out = segmentTickerBody(body, { min: 10, max: 20 });
    for (const seg of out) {
      expect(Array.from(seg).length).toBeLessThanOrEqual(20);
    }
    expect(normalizeForInvariant(out.join(""))).toBe(normalizeForInvariant(body));
  });
});

describe("splitRuns (spec §2-5)", () => {
  it("上限内は 1 run (全 segment)", () => {
    const segs = ["あ".repeat(50), "い".repeat(50)];
    expect(splitRuns(segs, { maxChars: 800, maxRunMs: 180_000, charsPerSecond: 5 })).toEqual([
      { startSegmentIndex: 0, endSegmentIndexExclusive: 2 },
    ]);
  });

  it("maxChars 超で栞境界で run 分割 (文途中で切らない)", () => {
    const segs = ["あ".repeat(60), "い".repeat(60), "う".repeat(60)]; // 各 60 字
    // maxChars=100 なら 1 run に 1 segment ずつ (60+60=120>100 なので境界で切る)
    const runs = splitRuns(segs, { maxChars: 100, maxRunMs: 1_000_000, charsPerSecond: 5 });
    expect(runs).toEqual([
      { startSegmentIndex: 0, endSegmentIndexExclusive: 1 },
      { startSegmentIndex: 1, endSegmentIndexExclusive: 2 },
      { startSegmentIndex: 2, endSegmentIndexExclusive: 3 },
    ]);
  });

  it("単一 segment が上限超なら単独例外 run", () => {
    const segs = ["あ".repeat(50), "い".repeat(900), "う".repeat(50)];
    const runs = splitRuns(segs, { maxChars: 800, maxRunMs: 1_000_000, charsPerSecond: 5 });
    // seg0 は 1 run、超過 seg1 は単独例外 run、seg2 は 1 run
    expect(runs).toEqual([
      { startSegmentIndex: 0, endSegmentIndexExclusive: 1 },
      { startSegmentIndex: 1, endSegmentIndexExclusive: 2 },
      { startSegmentIndex: 2, endSegmentIndexExclusive: 3 },
    ]);
  });

  it("maxRunMs 超で分割 (走行時間 = 文字数 / charsPerSecond)", () => {
    // 全角 100 字 / 5 字秒 = 20 秒。maxRunMs=25_000 なら 100 字までで切る
    const segs = ["あ".repeat(60), "い".repeat(60)]; // 60+60=120字=24秒 > 25 秒?→ 60字=12秒, 120字=24秒<25秒 は 1 run
    const runs = splitRuns(segs, { maxChars: 100_000, maxRunMs: 13_000, charsPerSecond: 5 });
    // 60字=12秒<13秒 OK、+60字=120字=24秒>13秒 → 境界で切る
    expect(runs).toEqual([
      { startSegmentIndex: 0, endSegmentIndexExclusive: 1 },
      { startSegmentIndex: 1, endSegmentIndexExclusive: 2 },
    ]);
  });

  it("空配列は空 runs", () => {
    expect(splitRuns([], {})).toEqual([]);
  });

  it("ちょうど 800 字 (デフォルト maxChars) は分割されない", () => {
    const segs = ["あ".repeat(400), "い".repeat(400)];
    expect(splitRuns(segs)).toEqual([{ startSegmentIndex: 0, endSegmentIndexExclusive: 2 }]);
  });

  it("maxRunMs を単一 segment 単独で超過しても、その segment だけの例外 run になる", () => {
    // seg0 単独で 60字/5字秒=12000ms > maxRunMs=10000ms
    const segs = ["あ".repeat(60), "い".repeat(60)];
    const runs = splitRuns(segs, { maxChars: 100_000, maxRunMs: 10_000, charsPerSecond: 5 });
    expect(runs).toEqual([
      { startSegmentIndex: 0, endSegmentIndexExclusive: 1 },
      { startSegmentIndex: 1, endSegmentIndexExclusive: 2 },
    ]);
  });
});

describe("lastPassedBookmark (spec §2-2)", () => {
  // offsetLeft を持つ疑似 span (jsdom は offsetLeft=0 なので明示注入)
  const spans = (offsets: number[]): HTMLSpanElement[] =>
    offsets.map((o) => ({ offsetLeft: o } as unknown as HTMLSpanElement));

  it("未走行 (tx=0) は startIndex を返す", () => {
    expect(lastPassedBookmark(spans([0, 120, 240]), 0, 100, 0)).toBe(0);
  });

  it("中間まで走行 → 通過済みの最後の栞", () => {
    // scrollWidth=100。栞 offset 0/120/240。tx=-260 → -tx=260
    // 通過条件 -tx >= 100+offset: offset0(100)✓ offset120(220)✓ offset240(340)✗ → index1
    expect(lastPassedBookmark(spans([0, 120, 240]), -260, 100, 0)).toBe(1);
  });

  it("全走破付近は最終栞", () => {
    expect(lastPassedBookmark(spans([0, 120, 240]), -400, 100, 0)).toBe(2);
  });

  it("offset 取得不能 (非有限) は null (現在栞維持)", () => {
    expect(lastPassedBookmark(spans([0, NaN, 240]), -500, 100, 0)).toBeNull();
  });

  it("startIndex オフセットを加味する", () => {
    // startIndex=2 のとき返り値は絶対 index (2 + 相対)
    expect(lastPassedBookmark(spans([0, 120]), -260, 100, 2)).toBe(3);
  });
});

describe("mapEmphasisToSegments (本文全域 span → segment ローカル座標、backlog §3)", () => {
  it("単一 segment: 本文 index をそのままローカル index として返す", () => {
    const body = "中心気圧970hPa";
    // "中心気圧" = 4 文字, "970hPa" = index 4..10
    const result = mapEmphasisToSegments(body, [body], [{ start: 4, end: 10 }]);
    expect(result).toEqual([[{ start: 4, end: 10 }]]);
  });

  it("segment 境界の空白 trim を跨いでもローカル座標へ正しく写像する", () => {
    // 本文には 。の後に空白があるが、segments 側はその空白を trim 済み (segmentTickerBody の挙動)
    const body = "海面は35メートル。 沿岸に120mm";
    const segments = ["海面は35メートル。", "沿岸に120mm"];
    // 本文 index: "35メートル" = 3..9 / "120mm" = 14..19
    const result = mapEmphasisToSegments(body, segments, [{ start: 3, end: 9 }, { start: 14, end: 19 }]);
    expect(result[0]).toEqual([{ start: 3, end: 9 }]); // seg0 ローカル = 本文 index
    expect(result[1]).toEqual([{ start: 3, end: 8 }]); // seg1 ローカル ("沿岸に" 後の 120mm)
  });

  it("span が無ければ segments と同長の空配列列を返す", () => {
    const segments = ["ああ", "いい"];
    expect(mapEmphasisToSegments("ああいい", segments, [])).toEqual([[], []]);
  });

  it("segment を跨ぐ span は捨てる (誤描画より安全側)", () => {
    const body = "ABCD";
    const segments = ["AB", "CD"];
    // span [1,3) は seg0 の B と seg1 の C を跨ぐ → 捨てる
    expect(mapEmphasisToSegments(body, segments, [{ start: 1, end: 3 }])).toEqual([[], []]);
  });
});

describe("splitEmphasis (segment を素片/強調片へ分割、backlog §3)", () => {
  it("強調区間の前後を素片、区間内を強調片に切る", () => {
    expect(splitEmphasis("海面は35メートル。", [{ start: 3, end: 9 }])).toEqual([
      { text: "海面は", emph: false },
      { text: "35メートル", emph: true },
      { text: "。", emph: false },
    ]);
  });

  it("強調が無ければ全体を 1 素片で返す", () => {
    expect(splitEmphasis("普通の本文", [])).toEqual([{ text: "普通の本文", emph: false }]);
  });

  it("先頭からの強調・末尾までの強調も扱える", () => {
    expect(splitEmphasis("99%の確率", [{ start: 0, end: 3 }])).toEqual([
      { text: "99%", emph: true },
      { text: "の確率", emph: false },
    ]);
  });

  it("複数区間を順不同で渡しても昇順で切り出す", () => {
    // "970hPa と 25m/s": 970hPa = 0..6 / 25m/s = 9..14
    const parts = splitEmphasis("970hPa と 25m/s", [{ start: 9, end: 14 }, { start: 0, end: 6 }]);
    expect(parts.filter((p) => p.emph).map((p) => p.text)).toEqual(["970hPa", "25m/s"]);
  });
});
