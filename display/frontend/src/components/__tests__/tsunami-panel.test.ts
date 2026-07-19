import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import TsunamiPanel from "../TsunamiPanel.svelte";
import type { DisplayTsunamiInputV1, DisplayTsunamiObservationV1 } from "../../lib/protocol";
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

  it("同名観測点が複数あっても重複 key クラッシュを起こさず全件 render する", () => {
    const observations = [
      observation({ stationName: "石巻" }),
      observation({ stationName: "石巻" }),
    ];
    const { container } = render(
      TsunamiPanel,
      { input: tsunamiInput({ observations }) },
    );
    expect(container.querySelectorAll(".observation-row").length).toBe(2);
    expect(screen.getAllByText("石巻").length).toBe(2);
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

  it("全区パース不能の縮退時は「予想最大 不明」がそのまま先頭バケツとして出る", () => {
    const coasts = [
      { name: "A", kind: "warning", maxHeight: "巨大", firstHeight: "不明瞭" },
      { name: "B", kind: "warning", maxHeight: "測定不能", firstHeight: "検討中" },
    ];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    const headlines = container.querySelectorAll(".instrument-headline");
    expect(headlines[0].querySelector(".headline-value")?.textContent).toBe("不明");
    expect(headlines[0].querySelector(".headline-count")?.textContent).toBe("2予報区");
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
  it("少数予報区 (1 ページ収まり) ではページャを出さず既存の静的グルーピングのまま全件表示する", () => {
    const coasts = [...coastsOfKind("大津波警報", 3), ...coastsOfKind("津波警報", 2)];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    expect(container.querySelector(".page-frame")).toBeNull();
    expect(container.querySelectorAll(".coast-group").length).toBe(2);
    expect(container.querySelectorAll(".coast-row").length).toBe(5);
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

  it("境界: ちょうど容量 8 区は静的表示のまま、9 区でページングが発火する", () => {
    const eight = render(TsunamiPanel, { input: tsunamiInput({ coasts: coastsOfKind("津波警報", 8) }) });
    expect(eight.container.querySelector(".page-frame")).toBeNull();
    expect(eight.container.querySelectorAll(".coast-row").length).toBe(8);

    const nine = render(TsunamiPanel, { input: tsunamiInput({ coasts: coastsOfKind("津波警報", 9) }) });
    expect(nine.container.querySelector(".page-frame")).not.toBeNull();
    expectCurrentDot(nine.container, 1, 2);
    expect(nine.container.querySelectorAll(".coast-row").length).toBe(8);
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

  it("少数予報区 (静的枝) では h1 の直後が h2 (coast-kind) になり、h3 へ飛ばない", () => {
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

      const coastKindEls = Array.from(document.body.querySelectorAll(".coast-kind"));
      expect(coastKindEls.length).toBeGreaterThan(0);
      for (const el of coastKindEls) expect(el.tagName).toBe("H2");

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
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ observations }) });
    expect(container.querySelector(".obs-summary-line")?.textContent).toBe(
      "最大観測: 8.5m以上 宮古 / 観測 3地点",
    );
  });

  it("最大値がパースできる観測が 1 件も無ければ最大観測を省き地点数のみ表示する", () => {
    const observations = [observation({ stationName: "A", maxHeightValue: null })];
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ observations }) });
    expect(container.querySelector(".obs-summary-line")?.textContent).toBe("観測 1地点");
  });

  it("少数観測 (1ページ収まり) はページャを出さず静的に全件表示する", () => {
    const observations = tsunamiObservationsOfCount(5);
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ observations }) });
    const obsTile = container.querySelector(".tile-observations")!;
    expect(obsTile.querySelector(".page-frame")).toBeNull();
    expect(obsTile.querySelectorAll(".observation-row").length).toBe(5);
  });

  it("多数観測 (容量超) はページングを発火し固定枠 (見出し「観測」・ページ番号) を出す", () => {
    const observations = tsunamiObservationsOfCount(21); // stress fixture 相当規模
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ observations }) });
    const obsTile = container.querySelector(".tile-observations")!;
    expect(obsTile.querySelector(".page-frame .page-heading")?.textContent).toBe("観測");
    expectCurrentDot(obsTile, 1, 3); // ceil(21/8)
    expect(obsTile.querySelectorAll(".observation-row").length).toBe(8);
  });

  // T5c: 固定高さの実現方式が「行容量ぶんの min-height calc」から「flex:1 で .tiles 内の
  // 残り高さを受け取るページホスト (position:relative、実測は M3 でタイル個別に変更) +
  // そこへ position:absolute:inset:0 で重なる .page-fade」に変わった (重ねクロスフェードのため、
  // §2-c の「下位ブロックが上下移動しない」固定高さ要件自体は不変、実現手段だけ変わった)。
  // jsdom は layout 未解決なので、「ページホストが実測高さを受け取れる構造になっている」ことを
  // ソース文字列で検査する
  it("ページ本文領域 (予報区・観測とも) は flex:1 で実測高さを受け取るページホストを持つ (下位ブロックの上下移動防止)", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    // 予報区: .tile-coasts.page-tinted が position:relative + flex:1;min-height:0
    expect(source).toMatch(/\.tile-coasts\.page-tinted\s*\{[^}]*position: relative;[^}]*flex: 1;[^}]*min-height: 0;/);
    // 観測: .obs-list-host.paged が position:relative + flex:1;min-height:0
    expect(source).toMatch(/\.obs-list-host\.paged\s*\{[^}]*position: relative;[^}]*flex: 1;[^}]*min-height: 0;/);
    // どちらも .page-fade を position:absolute;inset:0 で重ねる
    expect(source).toMatch(/\.page-fade\s*\{[^}]*position: absolute;[^}]*inset: 0;/);

    const coasts = Array.from({ length: 12 }, (_, i) => ({
      name: `区${i + 1}`,
      kind: "津波警報",
      maxHeight: "3m",
      firstHeight: "既に到達と推測",
    }));
    const observations = tsunamiObservationsOfCount(21);
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts, observations }) });
    expect(container.querySelector(".tile-coasts.page-tinted")).not.toBeNull();
    expect(container.querySelector(".tile-observations.paged .obs-list-host.paged")).not.toBeNull();
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

  it("静的表示 (ページャなし) のときは背景色面を付けない", () => {
    const coasts = coastsOfKind("大津波警報", 3);
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts }) });
    const tile = container.querySelector(".tile-coasts") as HTMLElement;
    expect(tile.classList.contains("page-tinted")).toBe(false);
  });

  it("観測ページ領域には種別色面を付けない (種別色は予報区のみ)", () => {
    const observations = tsunamiObservationsOfCount(21);
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ observations }) });
    const obsTile = container.querySelector(".tile-observations") as HTMLElement;
    expect(obsTile.classList.contains("page-tinted")).toBe(false);
  });
});

// T5c/T6/T6b: ページ行容量の画面高さ駆動化 + 切替フェード (spec §2-c)。jsdom は ResizeObserver
// 未実装かつ layout 未解決のため実測 px の挙動 (T7 preview 実測対象) はソース文字列で配線を検査
// する。可用高さ算出の算術自体 (昇格判定・収束・2カラム分岐) は instrument-layout.test.ts の
// sectionAvailableHeight/isStackedLayout 単体テストが担う (jsdom で ResizeObserver の
// コールバックを直接叩く経路が存在しないため)
describe("TsunamiPanel T5c/T6/T6b 配線 (画面高さ駆動 + フェード)", () => {
  // T6 (Codex R レビュー M3 の最終解決): 静的表示中のタイルは content-driven の自然高さで
  // 測定されるため、旧実装 (rowCapacity(coastsAreaHeight, ...) のように自タイルの実測を
  // そのまま容量に使う) は「全件が収まる高さを自分自身が返す」自己参照になり、狭い画面でも
  // needsPaging へ昇格できない不具合が残っていた。.tiles (常時 flex:1 constrained な共通
  // ビューポート) の実測高さから、相手タイルの実測高さ (obsBox.height/coastsBox.height、
  // 静的でもページング中でも「実際に消費している高さ」) を差し引いた sectionAvailableHeight を
  // 容量算出の入力にし、自己参照を解消した。T6b で両タイルの実測を統合し、isStackedLayout で
  // 2 カラム grid 時は相手が競合しない扱いにした。coastRowCapacity は T6c ② の page-fade padding
  // 補正 (PAGE_FADE_PADDING_PX) も加わっている
  it("両タイルの利用可能高さは .tiles 実測 − 相手タイルの実測高さ (sectionAvailableHeight) から導出し、自タイルの実測をそのまま使い回さない", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).not.toContain("tilesAreaHeight");
    expect(source).toContain("use:measureHeight={applyTilesHeight}");
    expect(source).toContain(
      "sectionAvailableHeight(tilesHeight, obsBox.height, TILES_GAP_PX, visibleObservations.length > 0 && stacked)",
    );
    expect(source).toContain("sectionAvailableHeight(tilesHeight, coastsBox.height, TILES_GAP_PX, stacked)");
    expect(source).toContain(
      "rowCapacity(Math.max(0, coastsAvailableHeight - coastHeaderOverheadPx), coastRowHeight, TSUNAMI_PAGE_ROW_CAPACITY)",
    );
    expect(source).toContain(
      "rowCapacity(Math.max(0, obsAvailableHeight - obsHeaderOverheadPx), obsRowHeight, TSUNAMI_PAGE_ROW_CAPACITY)",
    );
    // 自タイルの実測 (coastsBox/obsBox) は「相手の可用高さを出す入力」としてのみ使われ、
    // rowCapacity の直接の第一引数には渡らない (自己参照の再発防止)
    expect(source).not.toContain("rowCapacity(coastsBox");
    expect(source).not.toContain("rowCapacity(obsBox");
  });

  // ヘッダ実測補正 (T-a11y-gate fix、preview 実機確認 2026-07-18: 予報区・観測タイルとも
  // 末尾行が切れる)。旧実装は coastRowCapacity が PAGE_FADE_PADDING_PX (page-fade 自身の padding)
  // だけを差し引き、page-frame (見出し・PageDots) や obs-summary-frame (観測サマリ見出し) の
  // 実高さは容量計算に一切反映されていなかった (obsRowCapacity にいたっては無補正)。
  // page-frame は PageDots の折返し (多ページ時) で実高さが伸びうるため固定定数では追従できず、
  // ResizeObserver 実測 ($state) を capacity から差し引く構造にした。jsdom は ResizeObserver
  // 未実装のため実測 px の挙動そのものは検証できないが、配線 (実測 state → capacity 算出への
  // 加算) をソース文字列で固定する
  it("予報区・観測とも、ページ見出し (.page-frame) と観測サマリ見出し (.obs-summary-frame) の実測高さを capacity 計算から差し引く", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    // 実測配線: .page-frame (予報区・観測) と .obs-summary-frame に measureBorderHeight を付ける
    expect(source).toMatch(/class="page-frame" use:measureBorderHeight=\{applyCoastFrameHeight\}/);
    expect(source).toMatch(/class="obs-summary-frame" use:measureBorderHeight=\{applyObsSummaryHeight\}/);
    expect(source).toMatch(/class="page-frame" use:measureBorderHeight=\{applyObsFrameHeight\}/);
    // 実測 $state は margin-bottom 分の定数を加算してからオーバーヘッドに算入する
    // (border-box 実測は margin を含まないため)
    expect(source).toContain(
      "PAGE_FADE_PADDING_PX + (coastFrameHeight > 0 ? coastFrameHeight + PAGE_FRAME_MARGIN_PX : 0)",
    );
    expect(source).toContain(
      "(obsSummaryHeight > 0 ? obsSummaryHeight + OBS_SUMMARY_FRAME_MARGIN_PX : 0)",
    );
    expect(source).toContain("(obsFrameHeight > 0 ? obsFrameHeight + PAGE_FRAME_MARGIN_PX : 0)");
    // 観測タイルは予報区と違って tile 自身の padding が通常フローで直接効くため、
    // TILE_PADDING_PX を観測側だけのオーバーヘッドに加える
    expect(source).toContain("const obsHeaderOverheadPx = $derived(\n    TILE_PADDING_PX +");
    // layoutSettling 中は他の実測 (coastRowHeight 等) と同じ pending 機構で保留する
    expect(source).toContain("function applyCoastFrameHeight(h: number): void {");
    expect(source).toContain("function applyObsSummaryHeight(h: number): void {");
    expect(source).toContain("function applyObsFrameHeight(h: number): void {");
  });

  // T6b M-a: .tiles は `@container (min-width: 1200px)` で 2 カラム grid に切り替わり、その
  // 状態では予報区/観測は縦方向に高さを奪い合わない。container query の状態を JS から直接
  // 読む API が無いため、両 tile の実測 top/bottom から isStackedLayout で幾何的に判定し、
  // 横並びのときは sectionAvailableHeight に「相手は競合しない」を渡す
  it("縦積みか横並びかは isStackedLayout (両 tile の実測 top/bottom の幾何判定) から導出し、stacked を可用高さの競合フラグに渡す", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toMatch(/isStackedLayout[\s\S]{0,60}\} from "\.\.\/lib\/instrument-layout"/);
    expect(source).toContain("const stacked = $derived(isStackedLayout(coastsBox.bottom, obsBox.top));");
  });

  // T6c (再レビュー M-a 残 major): measureBox (自分の rect だけを書き込む旧構造) だと、
  // サイズは変わらず位置だけ動いた相手 tile の rect が古いまま取り残される (静的→ページング昇格で
  // 片方の高さが変わっても、もう片方は自分のサイズが変わらなければ ResizeObserver が発火しない)。
  // 両 tile の node 参照を親が保持し、単一の remeasureTiles() が両方の rect を常にペアで
  // 読み直す構造に置き換えた。① 各 tile 自身の resize (observeResize) と ② 表示モード切替
  // (needsPaging/obsNeedsPaging の変化を追う $effect) の両方から remeasureTiles() を呼ぶ
  it("両 tile の rect は remeasureTiles() で常にペアで読み直され、resize イベントと表示モード切替 (needsPaging/obsNeedsPaging) の両方から呼ばれる", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    // remeasureTiles は coastsTileEl/obsTileEl 両方を読み直す (どちらか片方だけの resize でも
    // 両方の rect が最新化される)。レイアウト遷移中 (layoutSettling) は保留し settling 完了時に flush する
    expect(source).toContain("if (coastsTileEl != null) coastsBox = readBox(coastsTileEl);");
    expect(source).toContain("if (obsTileEl != null) obsBox = readBox(obsTileEl);");
    // ① 両 tile とも observeResize + bind:this で remeasureTiles を直接渡している
    expect(source).toMatch(/class="tile tile-coasts"[\s\S]{0,500}?bind:this=\{coastsTileEl\}/);
    expect(source).toMatch(/class="tile tile-coasts"[\s\S]{0,500}?use:observeResize=\{remeasureTiles\}/);
    expect(source).toMatch(/class="tile tile-observations"[\s\S]{0,300}?bind:this=\{obsTileEl\}/);
    expect(source).toMatch(/class="tile tile-observations"[\s\S]{0,300}?use:observeResize=\{remeasureTiles\}/);
    // ② needsPaging/obsNeedsPaging の変化を追う $effect が remeasureTiles を呼ぶ
    expect(source).toMatch(
      /\$effect\(\(\) => \{\s*void needsPaging;\s*void obsNeedsPaging;\s*remeasureTiles\(\);\s*\}\);/,
    );
  });

  // T6b M-b: measureHeight (content-box) は .tile の padding/border を含まないため、相手タイルの
  // 実消費高さを過小評価し可用高さを過大評価する。予報区/観測タイルは border-box 込みの実測
  // (readBox、T6c)、行高 (coastRowHeight/obsRowHeight) は border-box のみの measureBorderHeight に
  // 切り替えた。.tiles 自体 (子に使える content-box 高さが正しい単位) は measureHeight のまま
  it("行高 (代表行) は border-box 込みの measureBorderHeight で測る (padding を含めた実消費高さ)", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toContain("use:measureBorderHeight={i === 0 ? applyCoastRowHeight : undefined}");
    expect(source).toContain("use:measureBorderHeight={i === 0 ? applyObsRowHeight : undefined}");
    // .tiles (コンテナが子に使える高さ) は content-box のままでよい (padding は子に使えないため)
    expect(source).toContain("use:measureHeight={applyTilesHeight}");
  });

  // M3 派生の major fix (Codex R 再確認): measureHeight が {#if needsPaging}/{#if obsNeedsPaging}
  // の内側にしか mount されない旧構造だと、(a) 初期 fallback (8行) 以下の件数だと静的枝から
  // 一度も抜けられずページングへ昇格できない鶏卵、(b) 画面縮小後も静的枝では observer が消えて
  // 容量が更新されない stale、の2つの不具合があった。静的表示中でも測定 host (.tile-coasts /
  // .obs-list-host) が存在し続けることを確認する
  it("静的表示中 (ページング未発火) でも予報区 tile と観測リストホストが同一要素として常時マウントされている", () => {
    const coasts = [
      { name: "岩手県", kind: "warning", maxHeight: null, firstHeight: null },
      { name: "宮城県", kind: "warning", maxHeight: null, firstHeight: null },
    ];
    const observations = tsunamiObservationsOfCount(2);
    const { container } = render(TsunamiPanel, { input: tsunamiInput({ coasts, observations }) });

    const coastsTile = container.querySelector(".tile-coasts");
    expect(coastsTile).not.toBeNull();
    expect(coastsTile!.classList.contains("page-tinted")).toBe(false); // 静的表示中

    const obsHost = container.querySelector(".tile-observations .obs-list-host");
    expect(obsHost).not.toBeNull();
    expect(obsHost!.classList.contains("paged")).toBe(false); // 静的表示中

    // ソース上も、observeResize が {#if needsPaging}/{#if obsNeedsPaging} の外側 (常時マウント
    // される要素自体) に配線されていることを検査し、分岐の内側だけに存在する構造への回帰を防ぐ。
    // T6: 観測タイルの実測は内側の .obs-list-host ではなく外側の .tile-observations
    // (summary-frame ぶんの overhead も含めた「タイルが実際に消費している高さ」) に移設した
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toMatch(
      /class="tile tile-coasts"[\s\S]{0,500}?use:observeResize=\{remeasureTiles\}/,
    );
    expect(source).toMatch(
      /class="tile tile-observations"[\s\S]{0,300}?use:observeResize=\{remeasureTiles\}/,
    );
  });

  // T6c ②: 文字がカード縁に密着するバグの修正 (preview 目視指摘)。position:absolute な
  // .page-fade の containing block は最も近い positioned 祖先の padding box (border box では
  // ないため、祖先自身の padding 宣言は絶対配置の子には効かない) になるので、.tile-coasts の
  // padding (.tile 由来) が予報区ページ本文で無視されていた。.page-fade 自体に padding を
  // 持たせて復元する。既存 spacing トークン (.tile と同じ var(--space-4) var(--space-5)) を
  // 再利用し、新規直値は使わない。観測側の .page-fade (.obs-list-host 内) はこの落とし穴の
  // 対象外だった (position:relative の祖先が padding を持たない別要素) ため、対称に padding を
  // 追加してはいけない (追加すると意図せず二重パディングになる)
  it("予報区ページ本文 (.page-fade) には .tile と同じ既存 spacing トークンで内側 padding を復元する (観測側には追加しない)", () => {
    const source = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    expect(source).toMatch(
      /\.tile-coasts\.page-tinted \.page-fade \{\s*padding: var\(--space-4\) var\(--space-5\);\s*\}/,
    );
    // 新規直値 (px 直書き) や opacity 減光を使っていないことの確認
    expect(source).not.toMatch(/\.tile-coasts\.page-tinted \.page-fade \{[^}]*\d+px/);
    expect(source).not.toMatch(/\.tile-coasts\.page-tinted \.page-fade \{[^}]*opacity/);
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
    expect(source).toContain("{#key obsPageCycler.index}");
    expect(source).toContain('import { fade } from "svelte/transition"');
    // モーション振り付け spec で revealScaleIn/heightReveal 用に SPRING_SPATIAL_DEFAULT_MS /
    // springSpatialOut も motion から取り込むため、import 行の固定はやめ必要シンボルを個別に確認する
    expect(source).toMatch(/\bSPRING_EFFECTS_DEFAULT_MS\b/);
    expect(source).toMatch(/\bspringEffectsOut\b[\s\S]*?from "\.\.\/lib\/motion"/);
    expect(source).toMatch(
      /transition:fade=\{\{\s*duration: pageCycler\.reducedMotion \? 0 : SPRING_EFFECTS_DEFAULT_MS,\s*easing: springEffectsOut,\s*\}\}/,
    );
    expect(source).toMatch(
      /transition:fade=\{\{\s*duration: obsPageCycler\.reducedMotion \? 0 : SPRING_EFFECTS_DEFAULT_MS,\s*easing: springEffectsOut,\s*\}\}/,
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
