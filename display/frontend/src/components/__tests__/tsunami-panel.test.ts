import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import TsunamiPanel from "../TsunamiPanel.svelte";
import type {
  DisplayTsunamiHeightSemanticV1,
  DisplayTsunamiInputV1,
  DisplayTsunamiObservationV1,
} from "../../lib/protocol";
import { PAGE_HOLD_MS } from "../../lib/page-cycler.svelte";
import { expectCurrentDot } from "./page-dots-test-utils";

// T5c: ページ切替は {#key} + transition:fade (重ねクロスフェード、231ms) になった。
// fake timers 環境では element.animate() スタブ (test-setup.ts) の完了が setTimeout 経由なので、
// ページ送りのタイマーを進めた直後だけでなく、フェード時間ぶんも追加で進めてから DOM を読む
function settleFade(): void {
  vi.advanceTimersByTime(1000);
  flushSync();
}

function tsunamiInput(over: Partial<DisplayTsunamiInputV1> = {}): DisplayTsunamiInputV1 {
  return {
    kind: "tsunami",
    eventId: "T1",
    level: "warning",
    levelLabel: "津波警報",
    coasts: [],
    warningComment: null,
    observations: [],
    reportDateTime: "2026-07-07T10:00:00+09:00",
    ...over,
  };
}

function observation(over: Partial<DisplayTsunamiObservationV1> = {}): DisplayTsunamiObservationV1 {
  return {
    areaName: null,
    areaKind: "津波警報",
    stationName: "S1",
    arrivalTime: null,
    initial: null,
    maxHeightValue: null,
    condition: null,
    ...over,
  };
}

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

describe("TsunamiPanel keyed-each 重複耐性", () => {
  it("同名・同種別の沿岸が複数あっても重複 key クラッシュを起こさず全件 render する", () => {
    const coasts = [
      { name: "岩手県", kind: "warning", maxHeight: null, firstHeight: null },
      { name: "岩手県", kind: "warning", maxHeight: null, firstHeight: null },
      { name: "宮城県", kind: "warning", maxHeight: null, firstHeight: null },
    ];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    expect(container.querySelectorAll(".coast-row").length).toBe(3);
    expect(screen.getAllByText("岩手県").length).toBe(2);
  });

  it("同じ kindCode の Kind.Name 変更でも親グループと子行の identity を維持する", async () => {
    const beforeCoast = {
      name: "旧予報区名", kind: "旧種別名", areaCode: "210", kindCode: "51",
      maxHeight: null, firstHeight: null,
    };
    const { container, rerender } = render(TsunamiPanel, {
      input: tsunamiInput({ coasts: [beforeCoast] }),
    });
    const beforeRow = container.querySelector(".coast-row-wrap");
    expect(beforeRow).not.toBeNull();

    await rerender({
      input: tsunamiInput({
        coasts: [{
          ...beforeCoast,
          name: "新予報区名",
          kind: "新種別名",
        }],
      }),
    });
    flushSync();

    expect(container.querySelector(".coast-row-wrap")).toBe(beforeRow);
    expect(container.querySelector(".page-kind")?.textContent).toBe("新種別名");
    expect(container.querySelector(".coast-name")?.textContent).toBe("新予報区名");
  });

  it("同名観測点が複数あっても重複 key クラッシュを起こさず全件 render する", () => {
    const observations = [
      observation({ stationName: "石巻" }),
      observation({ stationName: "石巻" }),
    ];
    const { container } = render(
      TsunamiPanel,
      { input: tsunamiInput({ coasts: [], observations }) },
    );
    expect(container.querySelectorAll(".observation-row").length).toBe(2);
    expect(screen.getAllByText("石巻").length).toBe(2);
  });

  it("最大波高の一般 condition と TsunamiHeight condition を観測行へ併記する", () => {
    const observations = [observation({
      maxHeightValue: "３．２ｍ",
      condition: "重要",
      heightCondition: "上昇中",
    })];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts: [], observations }) });
    expect(container.querySelector(".obs-max-value")?.textContent).toBe("３．２ｍ");
    expect(container.querySelector(".obs-condition")?.textContent).toBe("重要（上昇中）");
  });

  it("height semantic の label/badge/color を表示し、scalar は再解釈せず condition を title/ARIA に含める", () => {
    const coasts = [
      {
        name: "定性",
        kind: "津波警報",
        maxHeight: "999m",
        maxHeightSemantic: heightSemantic({
          presence: "qualitative", label: "巨大", condition: "定性判定", badge: "?", color: "unknown",
        }),
        firstHeight: null,
      },
      {
        name: "下限",
        kind: "津波警報",
        maxHeight: "0m",
        maxHeightSemantic: heightSemantic({
          presence: "qualitative", label: "3m程度以上", lowerBound: 3,
          badge: "≥", color: "safetyRank",
        }),
        firstHeight: null,
      },
      {
        name: "範囲",
        kind: "津波警報",
        maxHeight: "0m",
        maxHeightSemantic: heightSemantic({
          presence: "range", label: "1〜4m", lowerBound: 1, upperBound: 4,
          badge: "↔", color: "safetyUpperRank",
        }),
        firstHeight: null,
      },
      {
        name: "空欄",
        kind: "津波警報",
        maxHeight: "10m",
        maxHeightSemantic: heightSemantic({
          presence: "empty", label: "空欄", badge: "∅", color: "neutral",
        }),
        firstHeight: null,
      },
    ];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    const values = Array.from(container.querySelectorAll<HTMLElement>(".coast-height"));
    expect(values.map((value) => value.textContent)).toEqual(expect.arrayContaining([
      "巨大?", "3m程度以上≥", "1〜4m↔", "空欄∅",
    ]));
    const qualitative = values.find((value) => value.textContent === "巨大?");
    expect(qualitative?.title).toContain("定性判定");
    expect(qualitative?.getAttribute("aria-label")).toContain("定性判定");
    expect(qualitative?.getAttribute("style")).toContain("var(--c-raspberry)");
    expect(container.querySelector(".headline-value")?.textContent).toBe("巨大?");
    const legend = container.querySelector(".height-badge-legend");
    expect(legend?.getAttribute("aria-label")).toBe("津波高さ記号の凡例");
    expect(legend?.textContent).toContain("≥以上（下限値）");
    expect(legend?.textContent).toContain("↔範囲（上限値で比較）");
    expect(legend?.textContent).toContain("?不明・定性値");
    expect(legend?.textContent).toContain("∅空欄");
  });

  it("semantic badge が無い旧 V1 入力では高さ凡例を表示しない", () => {
    const { container } = render(TsunamiPanel, {
      input: tsunamiInput({
        coasts: [{ name: "旧入力", kind: "津波警報", maxHeight: "3m", firstHeight: null }],
      }),
    });
    expect(container.querySelector(".height-badge-legend")).toBeNull();
  });

  it("外部 semantic の空文字・空白 label は沿岸・観測・headline で不明表示へ倒す", () => {
    const blankUnknown = heightSemantic({ presence: "unknown", label: "  \t" });
    const { container } = render(TsunamiPanel, {
      input: tsunamiInput({
        coasts: [{
          name: "空白ラベル",
          kind: "津波警報",
          maxHeight: "999m",
          maxHeightSemantic: blankUnknown,
          firstHeight: null,
        }],
        observations: [],
      }),
    });
    expect(container.querySelector(".coast-height")?.textContent).toBe("不明?");
    expect(container.querySelector(".headline-value")?.textContent).toBe("不明?");
  });

  it.each([
    [1, "var(--role-tsunamiAdvisory)"],
    [3, "var(--role-tsunamiWarning)"],
    [1.2, "var(--role-tsunamiWarning)"],
    [3.2, "var(--role-tsunamiMajor)"],
    [10, "var(--role-tsunamiMajor)"],
  ] as const)("exact %sm は確立済みの津波高さ境界色 %s を使う", (height, expectedColor) => {
    const semantic = heightSemantic({
      raw: String(height),
      presence: "value",
      label: `${height}m`,
      value: height,
      badge: null,
      color: "normalRank",
    });
    const { container } = render(TsunamiPanel, {
      input: tsunamiInput({
        coasts: [{
          name: "境界",
          kind: "津波警報",
          maxHeight: "999m",
          maxHeightSemantic: semantic,
          firstHeight: null,
        }],
      }),
    });
    expect(container.querySelector<HTMLElement>(".coast-height")?.getAttribute("style")).toContain(expectedColor);
    expect(container.querySelector<HTMLElement>(".headline-value")?.getAttribute("style")).toContain(expectedColor);
  });

  it("observation height semantic を行・最大観測 headline へ表示し condition を併記する", () => {
    const observations = [observation({
      maxHeightValue: "0m",
      maxHeightSemantic: heightSemantic({
        presence: "value", label: "0.5m", value: 0.5, condition: "上昇中", badge: null, color: "normalRank",
      }),
      condition: "重要",
    })];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts: [], observations }) });
    const value = container.querySelector<HTMLElement>(".obs-max-value");
    expect(value?.textContent).toBe("0.5m");
    expect(value?.title).toContain("上昇中");
    expect(value?.getAttribute("aria-label")).toContain("上昇中");
    expect(container.querySelector(".obs-condition")?.textContent).toBe("重要（上昇中）");
    expect(container.querySelector(".obs-summary-value")?.textContent).toBe("0.5m");
  });

  // Codex R4: compact (副役スロット) の配線。compact prop を分割代入し、class:compact と
  // .tsunami-panel.compact の圧縮スタイルを持つ。狭い右列に津波パネルが full のまま入る不具合の修正。
  it("compact prop で class:compact が付き、compact 圧縮スタイルを持つ (Codex R4)", () => {
    const { container } = render(TsunamiPanel, { input: tsunamiInput(), compact: true });
    expect(container.querySelector(".tsunami-panel.compact")).toBeTruthy();
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toMatch(/let \{\s*input,\s*compact = false,/);
    expect(source).toContain("class:compact");
    expect(source).toContain(".tsunami-panel.compact");
  });

  it("compact なし (主役スロット) では compact class が付かない (Codex R4)", () => {
    const { container } = render(TsunamiPanel, { input: tsunamiInput() });
    expect(container.querySelector(".tsunami-panel.compact")).toBeFalsy();
    expect(container.querySelector(".tsunami-panel")).toBeTruthy();
  });
});

describe("TsunamiPanel 固定サマリ計器 (spec §2-c)", () => {
  it("majorWarning は「ただちに高台へ避難」を表示する", () => {
    const { container } = render(TsunamiPanel, {
      input: tsunamiInput({ level: "majorWarning", levelLabel: "大津波警報" }),
    });
    expect(container.querySelector(".action-word")?.textContent).toBe("ただちに高台へ避難");
  });

  it("warning は「ただちに避難」を表示する", () => {
    const { container } = render(TsunamiPanel, {
      input: tsunamiInput({ level: "warning", levelLabel: "津波警報" }),
    });
    expect(container.querySelector(".action-word")?.textContent).toBe("ただちに避難");
  });

  it("advisory は「海から上がって離れる」を表示する", () => {
    const { container } = render(TsunamiPanel, {
      input: tsunamiInput({ level: "advisory", levelLabel: "津波注意報" }),
    });
    expect(container.querySelector(".action-word")?.textContent).toBe("海から上がって離れる");
  });

  it("総区数を「N予報区」で表示する", () => {
    const coasts = [
      { name: "岩手県", kind: "warning", maxHeight: "3m", firstHeight: null },
      { name: "宮城県", kind: "warning", maxHeight: "5m", firstHeight: null },
    ];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    expect(container.querySelector(".area-count")?.textContent).toBe("2予報区");
  });

  it("予想最大行はヘッドライン (先頭バケツのみ、全分布の羅列はしない)", () => {
    const coasts = [
      { name: "A", kind: "warning", maxHeight: "5m", firstHeight: null },
      { name: "B", kind: "warning", maxHeight: "10m超", firstHeight: null },
      { name: "C", kind: "warning", maxHeight: "10m超", firstHeight: null },
      { name: "D", kind: "warning", maxHeight: "10m", firstHeight: null },
      { name: "E", kind: "warning", maxHeight: "5m", firstHeight: null },
      { name: "F", kind: "warning", maxHeight: "5m", firstHeight: null },
    ];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    const headlines = container.querySelectorAll(".instrument-headline");
    expect(headlines[0].querySelector(".headline-label")?.textContent).toBe("予想最大");
    expect(headlines[0].querySelector(".headline-value")?.textContent).toBe("10m超");
    expect(headlines[0].querySelector(".headline-count")?.textContent).toBe("2予報区");
    expect(headlines[0].textContent).not.toContain("/"); // 全分布のスラッシュ羅列は表示しない
  });

  it("最速到達行はヘッドライン (先頭バケツのみ)", () => {
    const coasts = [
      { name: "A", kind: "warning", maxHeight: "3m", firstHeight: "ただちに津波来襲と予測" },
      { name: "B", kind: "warning", maxHeight: "3m", firstHeight: "10時20分頃" },
      { name: "C", kind: "warning", maxHeight: "3m", firstHeight: "10時50分頃" },
    ];
    const { container } = render(
      TsunamiPanel,
      { input: tsunamiInput({ coasts, reportDateTime: "2026-07-07T10:00:00+09:00" }) },
    );
    const headlines = container.querySelectorAll(".instrument-headline");
    expect(headlines[1].querySelector(".headline-label")?.textContent).toBe("最速到達");
    expect(headlines[1].querySelector(".headline-value")?.textContent).toBe("既に・直ちに");
    expect(headlines[1].querySelector(".headline-count")?.textContent).toBe("1予報区");
  });

  it("定性値「巨大」を最上位にし、パース不能値だけを不明へ縮退する", () => {
    const coasts = [
      { name: "A", kind: "warning", maxHeight: "巨大", firstHeight: "不明瞭" },
      { name: "B", kind: "warning", maxHeight: "測定不能", firstHeight: "検討中" },
    ];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    const headlines = container.querySelectorAll(".instrument-headline");
    expect(headlines[0].querySelector(".headline-value")?.textContent).toBe("巨大");
    expect(headlines[0].querySelector(".headline-count")?.textContent).toBe("1予報区");
    expect(headlines[1].querySelector(".headline-value")?.textContent).toBe("到達時期不明");
    expect(headlines[1].querySelector(".headline-count")?.textContent).toBe("2予報区");
  });

  it("coasts が空のときは計器のヘッドライン行を出さず総区数のみ 0 表示する", () => {
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts: [] }) });
    expect(container.querySelector(".area-count")?.textContent).toBe("0予報区");
    expect(container.querySelectorAll(".instrument-headline").length).toBe(0);
  });
});

// T7 レビュー決定 (spec §2-c【確定 2026-07-10】): .coast-first (到達予想値) は
// formatArrivalDisplay で括弧補足を削り時刻をコロン形式にした表示専用整形を通す
// (分類は formatArrivalDisplay 前の生の firstHeight で行う、tsunami-bucket.test.ts 側で確認済み)
describe("TsunamiPanel 到達予想値の表示整形 (spec §2-c【確定 2026-07-10】)", () => {
  it(".coast-first は formatArrivalDisplay を通した文字列を表示する (括弧補足を削り時刻をコロン化)", () => {
    const coasts = [
      { name: "静岡県", kind: "warning", maxHeight: "3m", firstHeight: "09時14分頃（地震発生から2分）" },
    ];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    expect(container.querySelector(".coast-first")?.textContent).toBe("09:14頃");
  });

  it("非時刻文 (既に・ただちに・直ちに系) は変更されずそのまま表示される", () => {
    const coasts = [
      { name: "A", kind: "warning", maxHeight: "3m", firstHeight: "ただちに津波来襲と予測" },
    ];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    expect(container.querySelector(".coast-first")?.textContent).toBe("ただちに津波来襲と予測");
  });

  it("firstHeight が null なら従来どおり「-」を表示する", () => {
    const coasts = [{ name: "A", kind: "warning", maxHeight: "3m", firstHeight: null }];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    expect(container.querySelector(".coast-first")?.textContent).toBe("-");
  });

  it("最速到達ヘッドラインはバケツラベル (「既に・直ちに」等) を表示し、firstHeight の生文字列とは無関係 (formatArrivalDisplay の影響を受けない)", () => {
    const coasts = [
      { name: "A", kind: "warning", maxHeight: "3m", firstHeight: "09時14分頃（地震発生から2分）" },
    ];
    const { container } = render(
      TsunamiPanel,
      { input: tsunamiInput({ coasts, reportDateTime: "2026-07-07T10:00:00+09:00" }) },
    );
    const headlines = container.querySelectorAll(".instrument-headline");
    expect(headlines[1].querySelector(".headline-value")?.textContent).toBe("既に・直ちに");
  });
});

// spec §2-c / §3 のページャ配線。TSUNAMI_PAGE_ROW_CAPACITY = 8 (instrument-layout.ts) 前提
function coastsOfKind(kind: string, count: number): DisplayTsunamiInputV1["coasts"] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${kind}区${i + 1}`,
    kind,
    maxHeight: "3m",
    firstHeight: "既に到達と推測",
  }));
}

describe("TsunamiPanel 予報区ページャ配線 (spec §2-c/§3, T5b)", () => {
  it("D1-A の少数予報区も固定本文 page で表示し、位置は一頁なら省略する", () => {
    const coasts = [...coastsOfKind("大津波警報", 3), ...coastsOfKind("津波警報", 2)];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    expect(container.querySelector(".page-frame")).not.toBeNull();
    expect(container.querySelector(".page-attention")?.textContent).toBe("1/2・未表示2");
    expect(container.querySelectorAll(".coast-row").length).toBe(3);
  });

  it("多数予報区 (nankai 相当 29 区、3 種別) はページ分割し、固定枠 (見出し/種別/ページ番号) を出す。種別境界でページが切れる", () => {
    // 大津波警報17 → 3ページ (8+8+1) / 津波警報8 → 1ページ / 津波注意報4 → 1ページ = 計5ページ
    const coasts = [
      ...coastsOfKind("大津波警報", 17),
      ...coastsOfKind("津波警報", 8),
      ...coastsOfKind("津波注意報", 4),
    ];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ level: "majorWarning", levelLabel: "大津波警報", coasts }) });

    expect(container.querySelector(".page-frame")).not.toBeNull();
    expect(container.querySelector(".page-heading")?.textContent).toBe("予報区");
    expect(container.querySelector(".page-kind")?.textContent).toBe("大津波警報");
    // T8① (spec §3 改訂): ドットは種別内番号ではなく全ページ (5 = 3+1+1) を表す
    expectCurrentDot(container, 1, 5);
    // 1 ページ目は大津波警報の先頭 8 区のみ (種別境界を越えない)
    expect(container.querySelectorAll(".coast-row").length).toBe(8);
    expect(container.querySelector(".coast-name")?.textContent).toBe("大津波警報区1");
    expect(container.querySelector(".coast-group")).toBeNull(); // 静的グルーピング表示は出ない
  });

  // T8⑤: 種別 (警報/注意報等) の境界に gap を入れる任意機能 (T8① で一度実装) は、
  // preview 目視レビューで「間隔が不揃いに見える」と不評だったため撤去した。全ドット常に均等間隔になる
  it("種別境界をまたぐページでもドットは均等間隔で並ぶ (group-start 等の個別 margin は無い)", () => {
    const coasts = [
      ...coastsOfKind("大津波警報", 17),
      ...coastsOfKind("津波警報", 8),
      ...coastsOfKind("津波注意報", 4),
    ];
    const { container } = render(TsunamiPanel, {
      input: tsunamiInput({ level: "majorWarning", levelLabel: "大津波警報", coasts }),
    });
    const dots = Array.from(container.querySelectorAll<HTMLElement>(".page-dot"));
    expect(dots.length).toBe(5);
    for (const dot of dots) {
      expect(dot.classList.contains("group-start")).toBe(false);
      expect(dot.style.marginLeft).toBe("");
    }
  });

  // クリックで jumpTo が呼ばれる配線の end-to-end 確認 (ドット単体のコールバック配線は
  // page-dots.test.ts、jumpTo 自体の周回タイマー再スタートは page-cycler.test.ts 側)
  it("ドットをクリックすると該当ページへジャンプし、静止タイマーもそのページから再スタートする", async () => {
    vi.useFakeTimers();
    try {
      const coasts = [...coastsOfKind("津波警報", 12)]; // 2ページ (8+4)
      const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
      expectCurrentDot(container, 1, 2);
      expect(container.querySelector(".coast-name")?.textContent).toBe("津波警報区1");

      const dots = container.querySelectorAll(".page-dot");
      await fireEvent.click(dots[1]);
      settleFade(); // フェード分の 1000ms を消費する (この後の残り静止時間は PAGE_HOLD_MS - 1000)
      expectCurrentDot(container, 2, 2);
      expect(container.querySelector(".coast-name")?.textContent).toBe("津波警報区9");

      // ジャンプ直後から静止時間が丸ごと再スタートしているはず (ジャンプ前の周回とは無関係)
      vi.advanceTimersByTime(PAGE_HOLD_MS - 1000 - 1);
      expectCurrentDot(container, 2, 2); // まだ進まない
      vi.advanceTimersByTime(1);
      settleFade();
      expectCurrentDot(container, 1, 2); // 2ページなので周回して戻る
    } finally {
      vi.useRealTimers();
    }
  });

  it("D1-A+D2-A は単一 pager の保持満了後だけ未表示数を減らし、予報区 identity を重複表示しない", () => {
    vi.useFakeTimers();
    try {
      const coasts = coastsOfKind("津波警報", 12);
      const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
      expect(container.querySelector("[data-page-attention]")?.textContent).toBe("1/2・未表示2");
      const firstNames = Array.from(container.querySelectorAll(".coast-name")).map((node) => node.textContent);
      expect(new Set(firstNames).size).toBe(firstNames.length);
      vi.advanceTimersByTime(PAGE_HOLD_MS);
      settleFade();
      expect(container.querySelector("[data-page-attention]")?.textContent).toBe("2/2・未表示1");
      const secondNames = Array.from(container.querySelectorAll(".coast-name")).map((node) => node.textContent);
      expect(secondNames.every((name) => !firstNames.includes(name))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resetSeq (level 上昇) でページャが先頭ページへ戻る", () => {
    vi.useFakeTimers();
    try {
      const coasts = [...coastsOfKind("津波注意報", 12)];
      const { container, rerender } = render(TsunamiPanel, {
        input: tsunamiInput({ level: "advisory", levelLabel: "津波注意報", coasts }),
      });
      expectCurrentDot(container, 1, 2);

      vi.advanceTimersByTime(PAGE_HOLD_MS);
      settleFade();
      expectCurrentDot(container, 2, 2);

      // level が warning へ上昇 (昇格) → 先頭ページへリセットされる
      rerender({ input: tsunamiInput({ level: "warning", levelLabel: "津波警報", coasts }) });
      settleFade();
      expectCurrentDot(container, 1, 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("EventID が変わると level が同じでもページャを先頭へ戻す", () => {
    vi.useFakeTimers();
    try {
      const coasts = [...coastsOfKind("津波警報", 12)];
      const { container, rerender } = render(TsunamiPanel, {
        input: tsunamiInput({ eventId: "T1", coasts }),
      });
      vi.advanceTimersByTime(PAGE_HOLD_MS);
      settleFade();
      expectCurrentDot(container, 2, 2);

      rerender({ input: tsunamiInput({ eventId: "T2", coasts }) });
      settleFade();
      expectCurrentDot(container, 1, 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unkeyed snapshot episode reset で pager を先頭へ戻す", () => {
    vi.useFakeTimers();
    try {
      const coasts = [...coastsOfKind("津波警報", 12)];
      const { container, rerender } = render(TsunamiPanel, {
        input: tsunamiInput({ eventId: null, coasts }), episodeResetKey: 1,
      });
      vi.advanceTimersByTime(PAGE_HOLD_MS);
      settleFade();
      expectCurrentDot(container, 2, 2);

      rerender({ input: tsunamiInput({ eventId: null, coasts }), episodeResetKey: 2 });
      settleFade();
      expectCurrentDot(container, 1, 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("境界: ちょうど容量 8 区も固定 page、9 区では位置を常設する", () => {
    const eight = render(TsunamiPanel, { input: tsunamiInput({ coasts: coastsOfKind("津波警報", 8) }) });
    expect(eight.container.querySelector(".page-frame")).not.toBeNull();
    expect(eight.container.querySelectorAll(".coast-row").length).toBe(8);

    const nine = render(TsunamiPanel, { input: tsunamiInput({ coasts: coastsOfKind("津波警報", 9) }) });
    expect(nine.container.querySelector(".page-frame")).not.toBeNull();
    expectCurrentDot(nine.container, 1, 2);
    expect(nine.container.querySelectorAll(".coast-row").length).toBe(8);
  });

  it("実測 probe は極端に長い予報区名を同じ page へ過積載しない", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    class ProbeResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        this.callback([{ contentRect: { width: 320, height: 100 }, target } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    vi.stubGlobal("ResizeObserver", ProbeResizeObserver);
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return this.classList.contains("partition-probe-body") ? 100 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        if (!this.classList.contains("partition-probe-body")) return 0;
        return this.querySelectorAll(".coast-name").length * 70;
      },
    });
    let unmount: (() => void) | undefined;
    try {
      const long = "極端に長い津波予報区名".repeat(18);
      const rendered = render(TsunamiPanel, {
        input: tsunamiInput({
          coasts: [
            { name: `${long}甲`, kind: "津波警報", maxHeight: "3m", firstHeight: null },
            { name: `${long}乙`, kind: "津波警報", maxHeight: "3m", firstHeight: null },
          ],
        }),
      });
      unmount = rendered.unmount;
      await vi.waitFor(() => expectCurrentDot(rendered.container, 1, 2));
      expect(rendered.container.querySelectorAll(".page-fade:not(.partition-probe-page) .coast-name")).toHaveLength(1);
      expect(rendered.container.querySelector("[data-partition-probe-shelf]")?.getAttribute("aria-hidden")).toBe("true");
    } finally {
      unmount?.();
      if (clientHeight == null) delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
      else Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      if (scrollHeight == null) delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      else Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
      vi.stubGlobal("ResizeObserver", originalResizeObserver);
    }
  });

  it("host 高だけが縮んでも probe cache を再計測し、page を分割し直す", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    let hostHeight = 150;
    class ProbeResizeObserver {
      private static readonly observers = new Set<ProbeResizeObserver>();
      private readonly targets = new Set<Element>();
      constructor(private readonly callback: ResizeObserverCallback) {
        ProbeResizeObserver.observers.add(this);
      }
      observe(target: Element): void {
        this.targets.add(target);
        this.emit(target);
      }
      disconnect(): void { ProbeResizeObserver.observers.delete(this); }
      unobserve(target: Element): void { this.targets.delete(target); }
      private emit(target: Element): void {
        this.callback([{ contentRect: { width: 320, height: hostHeight }, target } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      static emitAll(): void {
        for (const observer of ProbeResizeObserver.observers) {
          for (const target of observer.targets) observer.emit(target);
        }
      }
    }
    vi.stubGlobal("ResizeObserver", ProbeResizeObserver);
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return this.classList.contains("partition-probe-body") ? hostHeight : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("partition-probe-body")
          ? this.querySelectorAll(".coast-name").length * 70
          : 0;
      },
    });
    let unmount: (() => void) | undefined;
    try {
      const rendered = render(TsunamiPanel, { input: tsunamiInput({ coasts: coastsOfKind("津波警報", 2) }) });
      unmount = rendered.unmount;
      await vi.waitFor(() => expect(rendered.container.querySelector(".page-dots")).toBeNull());

      hostHeight = 100;
      ProbeResizeObserver.emitAll();
      await vi.waitFor(() => expectCurrentDot(rendered.container, 1, 2));
    } finally {
      unmount?.();
      if (clientHeight == null) delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
      else Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      if (scrollHeight == null) delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      else Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
      vi.stubGlobal("ResizeObserver", originalResizeObserver);
    }
  });

  it("resetSeq は level 低下ではリセットしない (非対称性)", () => {
    vi.useFakeTimers();
    try {
      const coasts = [...coastsOfKind("津波注意報", 12)];
      const { container, rerender } = render(TsunamiPanel, {
        input: tsunamiInput({ level: "majorWarning", levelLabel: "大津波警報", coasts }),
      });
      expectCurrentDot(container, 1, 2);

      vi.advanceTimersByTime(PAGE_HOLD_MS);
      settleFade();
      expectCurrentDot(container, 2, 2);

      // level が majorWarning → warning へ低下 (降格) → ページ位置は維持される
      rerender({ input: tsunamiInput({ level: "warning", levelLabel: "津波警報", coasts }) });
      settleFade();
      expectCurrentDot(container, 2, 2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// 最終レビュー Finding 1 (A11y、確信度 0.97-0.99): h2「予報区」はページング枝
// (currentTsunamiPage != null) にしかなく、少数予報区の静的枝では h3.coast-kind が h2 を
// 経由せず現れるため、App の h1 (App.svelte:138、単一 visually-hidden h1) から h1→h3 に
// レベルが飛んでいた。coast-kind を h2 へ昇格させた修正の回帰防止として、実際の DOM 文脈
// (h1 が先に存在する状態) を模して mount し、以降に現れる見出しレベルが連続 1 段ずつしか
// 上がらない (スキップしない) ことを検査する
describe("TsunamiPanel 見出し階層 (最終レビュー Finding 1)", () => {
  function headingLevels(): number[] {
    return Array.from(document.body.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((el) =>
      Number(el.tagName[1]),
    );
  }

  it("D1-A の固定 page では h1 の直後が h2 (page-heading) になり、h3 へ飛ばない", () => {
    const appHeading = document.createElement("h1");
    appHeading.className = "visually-hidden";
    appHeading.textContent = "FlEq 防災情報ディスプレイ";
    document.body.appendChild(appHeading);
    try {
      const coasts = [
        { name: "岩手県", kind: "大津波警報", maxHeight: "3m", firstHeight: null },
        { name: "宮城県", kind: "津波警報", maxHeight: "2m", firstHeight: null },
      ];
      render(TsunamiPanel, { input: tsunamiInput({ coasts }) });

      const headings = Array.from(document.body.querySelectorAll(".page-heading"));
      expect(headings.length).toBeGreaterThan(0);
      for (const el of headings) expect(el.tagName).toBe("H2");

      const levels = headingLevels();
      expect(levels[0]).toBe(1); // App の h1
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1); // 2 段以上のスキップが無い
      }
    } finally {
      appHeading.remove();
    }
  });
});

// 目視フィードバック 2 件 (preview 目視): ① ページ本文領域の固定高さ ② 観測津波の 3 層化
function tsunamiObservationsOfCount(count: number): DisplayTsunamiObservationV1[] {
  return Array.from({ length: count }, (_, i) =>
    observation({ stationName: `観測点${i + 1}`, maxHeightValue: `${i + 1}.0m` }),
  );
}

describe("TsunamiPanel 観測津波の 3 層化 (spec §2-c フィードバック, T5b追補)", () => {
  it("計器行に最大観測の値・地点名・総地点数を表示する", () => {
    const observations = [
      observation({ stationName: "宮古", maxHeightValue: "8.5m以上" }),
      observation({ stationName: "大洗", maxHeightValue: "4.0m" }),
      observation({ stationName: "不明地点", maxHeightValue: null }),
    ];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts: [], observations }) });
    expect(container.querySelector(".obs-summary-line")?.textContent).toBe(
      "最大観測: 8.5m以上 宮古 / 観測 3地点",
    );
  });

  it("最大値がパースできる観測が 1 件も無ければ最大観測を省き地点数のみ表示する", () => {
    const observations = [observation({ stationName: "A", maxHeightValue: null })];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts: [], observations }) });
    expect(container.querySelector(".obs-summary-line")?.textContent).toBe("観測 1地点");
  });

  it("少数観測 (1ページ収まり) も固定本文 page で全件表示する", () => {
    const observations = tsunamiObservationsOfCount(5);
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts: [], observations }) });
    expect(container.querySelector(".page-heading")?.textContent).toBe("観測");
    expect(container.querySelectorAll(".observation-row").length).toBe(5);
  });

  it("多数観測 (容量超) はページングを発火し固定枠 (見出し「観測」・ページ番号) を出す", () => {
    const observations = tsunamiObservationsOfCount(21); // stress fixture 相当規模
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts: [], observations }) });
    expect(container.querySelector(".page-frame .page-heading")?.textContent).toBe("観測");
    expectCurrentDot(container, 1, 3); // ceil(21/8)
    expect(container.querySelectorAll(".observation-row").length).toBe(8);
  });

  // T5c: 固定高さの実現方式が「行容量ぶんの min-height calc」から「flex:1 で .tiles 内の
  // 残り高さを受け取るページホスト (position:relative、実測は M3 でタイル個別に変更) +
  // そこへ position:absolute:inset:0 で重なる .page-fade」に変わった (重ねクロスフェードのため、
  // §2-c の「下位ブロックが上下移動しない」固定高さ要件自体は不変、実現手段だけ変わった)。
  // jsdom は layout 未解決なので、「ページホストが実測高さを受け取れる構造になっている」ことを
  // ソース文字列で検査する
  it("ページ本文領域 (予報区・観測とも) は flex:1 で実測高さを受け取るページホストを持つ (下位ブロックの上下移動防止)", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toMatch(/\.unified-page\s*\{[^}]*position: relative;[^}]*flex: 1;[^}]*min-height: 0;/);
    expect(source).toMatch(/\.page-fade\s*\{[^}]*position: absolute;[^}]*inset: 0;/);

    const coasts = Array.from({ length: 12 }, (_, i) => ({
      name: `区${i + 1}`,
      kind: "津波警報",
      maxHeight: "3m",
      firstHeight: "既に到達と推測",
    }));
    const observations = tsunamiObservationsOfCount(21);
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts, observations }) });
    expect(container.querySelector(".tile-coasts.unified-page")).not.toBeNull();
  });
});

describe("TsunamiPanel 予報区ページ領域の種別別背景色面 (spec §2-c 改訂, 可読性優先の高コントラスト版)", () => {
  it("ページング発火時、予報区ページ領域は種別色をごく薄く含む暗面 (color-mix + 最暗 --bg) を背景に持つ (opacity は使わない)", () => {
    const coasts = coastsOfKind("大津波警報", 9);
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    const tile = container.querySelector(".tile-coasts") as HTMLElement;
    expect(tile.classList.contains("page-tinted")).toBe(true);
    const bg = tile.style.getPropertyValue("--page-bg");
    expect(bg).toBe("color-mix(in srgb, var(--role-tsunamiMajor) 15%, var(--bg))");
    expect(tile.getAttribute("style")).not.toContain("opacity");
  });

  it("種別が変われば背景色の元になる役割トークンも変わる (大津波警報と津波注意報で異なる)", () => {
    const major = render(TsunamiPanel, {
      input: tsunamiInput({ level: "majorWarning", coasts: coastsOfKind("大津波警報", 9) }),
    });
    const advisory = render(TsunamiPanel, {
      input: tsunamiInput({ level: "advisory", coasts: coastsOfKind("津波注意報", 9) }),
    });
    const majorBg = (major.container.querySelector(".tile-coasts") as HTMLElement).style.getPropertyValue(
      "--page-bg",
    );
    const advisoryBg = (advisory.container.querySelector(".tile-coasts") as HTMLElement).style.getPropertyValue(
      "--page-bg",
    );
    expect(majorBg).toContain("var(--role-tsunamiMajor)");
    expect(advisoryBg).toContain("var(--role-tsunamiAdvisory)");
    expect(majorBg).not.toBe(advisoryBg);
  });

  it("種別ラベル (ページ固定枠) は色相シグナルとしてヘッダトークン色を維持する (目立たせ枠は現状維持)", () => {
    const coasts = coastsOfKind("津波警報", 9);
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    const pageKind = container.querySelector(".page-kind") as HTMLElement;
    expect(pageKind.style.color).toBe("var(--header-tsunamiWarning-on)");
  });

  it("予報区行の 3 列 (予報区名/波高/到達予想) は色相を乗せず --fg をそのまま継承する (ミュートしない)", () => {
    // jsdom は scoped <style> からのカスケード解決が不確実なため (emergency.test.ts と同じ流儀で)
    // ソース文字列で「.page-tinted のベース color は --fg そのもの」「3 列に個別の色指定が無い
    // (= 継承されたまま)」ことを検査する
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toMatch(
      /\.tile-coasts\.page-tinted \{[\s\S]*?background: var\(--page-bg\);\s*color: var\(--fg\);/,
    );
    // coast-name/height/first に個別の色指定 (継承を上書きするルール) が無いことを確認する
    expect(source).not.toMatch(/\.page-tinted \.coast-(name|height|first)\s*\{/);
    expect(source).not.toContain("--page-fg"); // 旧改訂の残骸トークンが残っていないこと
  });

  it("単一 coast page でも種別背景色面を維持する", () => {
    const coasts = coastsOfKind("大津波警報", 3);
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    const tile = container.querySelector(".tile-coasts") as HTMLElement;
    expect(tile.classList.contains("page-tinted")).toBe(true);
  });

  it("観測 page には種別色面を付けない (種別色は予報区のみ)", () => {
    const observations = tsunamiObservationsOfCount(21);
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts: [], observations }) });
    const tile = container.querySelector(".tile-coasts") as HTMLElement;
    expect(tile.classList.contains("page-tinted")).toBe(false);
  });
});

// D1-A: 平均行高ではなく候補 range の実描画高を sequentialPartitionRanges へ返す。
describe("TsunamiPanel 実測 probe partition 配線", () => {
  it("予報区・観測を section ごとに sequentialPartitionRanges へ渡し、単一 pager へ平坦化する", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toContain("sequentialPartitionRanges(");
    expect(source).toContain("const tsunamiPartitions = $derived.by");
    expect(source).toContain("const panelPages = $derived.by");
    expect(source).not.toContain("rowCapacity(");
    expect(source).not.toContain("sectionAvailableHeight(");
  });

  it("隠し棚は aria-hidden/inert かつ layout 外で、候補本文の scrollHeight/clientHeight を比較する", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toContain('class="partition-probe-shelf" aria-hidden="true" inert data-partition-probe-shelf');
    expect(source).toContain("contentHeight: node.scrollHeight");
    expect(source).toContain("availableHeight: node.clientHeight");
    expect(source).toMatch(/\.partition-probe-shelf\s*\{[^}]*visibility: hidden;[^}]*pointer-events: none;/);
  });

  it("高さ cache の generation は表示 fingerprint と host 幅・高さに紐づく", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toContain("tsunamiProbeFingerprint");
    expect(source).toContain("tsunamiProbeGeneration");
    expect(source).toContain("probeWidth");
    expect(source).toContain("probeHeight");
    expect(source).toContain(":h${Math.round(probeHeight * 100) / 100}");
    expect(source).toContain("use:observeProbeBox");
  });

  it("統一 page host は少数件でも常時マウントされる", () => {
    const coasts = [
      { name: "岩手県", kind: "warning", maxHeight: null, firstHeight: null },
      { name: "宮城県", kind: "warning", maxHeight: null, firstHeight: null },
    ];
    const observations = tsunamiObservationsOfCount(2);
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts, observations }) });
    expect(container.querySelector(".tile-coasts.unified-page")).not.toBeNull();
    expect(container.querySelector("[data-partition-probe-shelf]")).not.toBeNull();
  });

  // T6c ②: 文字がカード縁に密着するバグの修正 (preview 目視指摘)。position:absolute な
  // .page-fade の containing block は最も近い positioned 祖先の padding box (border box では
  // ないため、祖先自身の padding 宣言は絶対配置の子には効かない) になるので、.tile-coasts の
  // padding (.tile 由来) が予報区ページ本文で無視されていた。.page-fade 自体に padding を
  // 持たせて復元する。既存 spacing トークン (.tile と同じ var(--space-4) var(--space-5)) を
  // 再利用し、新規直値は使わない。観測 page も同じ unified-page の absolute な子なので、
  // tile 契約の padding をここで一元して実効化する。
  it("予報区・観測 page 本文 (.page-fade) には .tile と同じ既存 spacing トークンで内側 padding を復元する", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toMatch(
      /\.tile-coasts\.unified-page \.page-fade \{\s*padding: var\(--space-4\) var\(--space-5\);\s*\}/,
    );
    // 新規直値 (px 直書き) や opacity 減光を使っていないことの確認
    expect(source).not.toMatch(/\.tile-coasts\.unified-page \.page-fade \{[^}]*\d+px/);
    expect(source).not.toMatch(/\.tile-coasts\.unified-page \.page-fade \{[^}]*opacity/);
  });

  it("compact 時も coast live page と隠し probe は同じ padding token で測定する", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toMatch(
      /\.tsunami-panel\.compact \.tile-coasts\.unified-page \.page-fade,\s*\.tsunami-panel\.compact \.partition-probe-page \{\s*padding: var\(--space-2\) var\(--space-3\);\s*\}/,
    );
  });

  // T6c ③: 「8.5m以上」のような観測値・「10m超」のような波高値が CJK/英数字の境界で途中改行
  // される (preview 目視指摘)。値トークンを個別 span にして white-space: nowrap を付ける
  // (.city-name と同じ「値の途中で折らない」規範)。列幅は「はみ出したら ellipsis で切り捨てる」
  // のではなく minmax(…, max-content) で調整する方針にした (maxHeightValue コメント「実値そのまま
  // (丸め値ではない)」という既存の verbatim 保持方針に合わせ、値を欠落させない)
  describe("T6c ③ 観測値・波高値の途中改行防止", () => {
    it("観測行の値 (.obs-max-value) と計器行の最大観測値 (.obs-summary-value) は white-space: nowrap", () => {
      const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
      expect(source).toMatch(/\.obs-max-value \{[^}]*white-space: nowrap;/);
      expect(source).toMatch(/\.obs-summary-value \{\s*white-space: nowrap;\s*\}/);
    });

    it("予報区行の波高値 (.coast-height) と到達予想値 (.coast-first)、計器のヘッドライン値 (.headline-value) も white-space: nowrap", () => {
      const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
      expect(source).toMatch(/\.coast-height \{[^}]*white-space: nowrap;/);
      expect(source).toMatch(/\.coast-first \{[^}]*white-space: nowrap;/);
      expect(source).toMatch(/\.headline-value \{\s*white-space: nowrap;\s*\}/);
    });

    it("nowrap にした値列 (波高・観測最大値) は列幅を minmax(…, max-content) にして、ellipsis で値を欠落させない (実値そのまま保持する既存方針)", () => {
      const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
      expect(source).toContain("grid-template-columns: 11em minmax(4em, max-content) minmax(11em, 1fr);");
      expect(source).toContain("grid-template-columns: 10em 5ch 3em minmax(4em, max-content) 6em;");
      expect(source).not.toContain("text-overflow: ellipsis");
    });

    it("計器行の最大観測値は maxObservation.label だけを個別 span (.obs-summary-value) に切り出し、周囲の文言・地点数は従来どおり textContent に含まれる", () => {
      const observations = [
        observation({ stationName: "宮古", maxHeightValue: "8.5m以上" }),
        observation({ stationName: "大洗", maxHeightValue: "4.0m" }),
      ];
      const { container } = render(TsunamiPanel, { input: tsunamiInput({ observations }) });
      const valueSpan = container.querySelector(".obs-summary-value");
      expect(valueSpan?.textContent).toBe("8.5m以上");
      expect(container.querySelector(".obs-summary-line")?.textContent).toBe(
        "最大観測: 8.5m以上 宮古 / 観測 2地点",
      );
    });
  });

  it("ページ切替は {#key} + transition:fade の重ねクロスフェードで、時間/easing は既存の spring-effects-default を流用する (新規定数なし)", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toContain("{#key pageCycler.index}");
    expect(source).toContain('import { fade } from "svelte/transition"');
    // モーション振り付け spec で revealScaleIn/heightReveal 用に SPRING_SPATIAL_DEFAULT_MS /
    // springSpatialOut も motion から取り込むため、import 行の固定はやめ必要シンボルを個別に確認する
    expect(source).toMatch(/\bSPRING_EFFECTS_DEFAULT_MS\b/);
    expect(source).toMatch(/\bspringEffectsOut\b[\s\S]*?from "\.\.\/lib\/motion"/);
    expect(source).toMatch(
      /transition:fade=\{\{\s*duration: reducedMotion \? 0 : SPRING_EFFECTS_DEFAULT_MS,\s*easing: springEffectsOut,\s*\}\}/,
    );
  });

  it("背景色 (--page-bg) は CSS transition で同じ spring-effects-default-dur を使って滑らかに変わる", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toMatch(
      /transition: background-color var\(--spring-effects-default-dur\) var\(--spring-effects-default\);/,
    );
  });

  it("reduced-motion では背景色遷移が 0 秒になる (フェード自体は cycler.reducedMotion で JS 側が 0 にする)", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toMatch(/prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.tile-coasts\.page-tinted\s*\{\s*transition: none;/);
  });
});
