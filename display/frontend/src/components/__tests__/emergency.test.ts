import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import EmergencyScreen from "../EmergencyScreen.svelte";
import WeatherEmergencyPanel from "../WeatherEmergencyPanel.svelte";
import { PAGE_HOLD_MS } from "../../lib/page-cycler.svelte";
import { expectCurrentDot } from "./page-dots-test-utils";
import type { EmergencyPanelModel } from "../../lib/derive";
import type {
  DisplayEewInputV1,
  DisplayLargeQuakeInputV1,
  DisplayTsunamiInputV1,
} from "../../lib/protocol";
import type { WeatherEmergencyInputV1, WeatherPanelItemV1 } from "../../lib/weather-panel";

// T5c: ページ切替は {#key} + transition:fade (重ねクロスフェード、231ms) になった。
// fake timers 環境では element.animate() スタブ (test-setup.ts) の完了が setTimeout 経由なので、
// ページ送りのタイマーを進めた直後だけでなく、フェード時間ぶんも追加で進めてから DOM を読む
function settleFade(): void {
  vi.advanceTimersByTime(1000);
  flushSync();
}

function eewInput(over: Partial<DisplayEewInputV1> = {}): DisplayEewInputV1 {
  return {
    kind: "eew",
    eventId: "E1",
    serial: "3",
    isWarning: true,
    isFinal: false,
    isCancellation: false,
    hypocenterName: "浦河沖",
    forecastMaxInt: "5強",
    forecastMaxIntRank: 5,
    magnitude: "6.1",
    colorIndex: null,
    reportDateTime: "2026-07-07T10:00:00+09:00",
    isAssumedHypocenter: false,
    depth: "30km",
    maxLgInt: null,
    regions: [],
    ...over,
  };
}

function tsunamiInput(over: Partial<DisplayTsunamiInputV1> = {}): DisplayTsunamiInputV1 {
  return {
    kind: "tsunami",
    level: "warning",
    levelLabel: "津波警報",
    coasts: [
      { name: "岩手県", kind: "warning", maxHeight: null, firstHeight: null },
      { name: "宮城県", kind: "warning", maxHeight: null, firstHeight: null },
    ],
    warningComment: null,
    observations: [],
    reportDateTime: "2026-07-07T10:00:00+09:00",
    ...over,
  };
}

function quakeInput(over: Partial<DisplayLargeQuakeInputV1> = {}): DisplayLargeQuakeInputV1 {
  return {
    kind: "largeQuake",
    eventId: "Q1",
    originTime: "2026-07-07T09:58:00+09:00",
    hypocenterName: "浦河沖",
    magnitude: "6.1",
    maxInt: "5強",
    maxIntRank: 9,
    intensityGroups: [
      { intensity: "5強", rank: 9, areas: ["浦河町", "様似町"], omittedAreaCount: 0 },
      { intensity: "4", rank: 7, areas: ["帯広市"], omittedAreaCount: 0 },
    ],
    reportDateTime: "2026-07-07T10:00:00+09:00",
    depth: "30km",
    maxLgInt: null,
    tsunamiWarning: false,
    ...over,
  };
}

function panel(key: string, input: EmergencyPanelModel["input"]): EmergencyPanelModel {
  return { key, input };
}

function weatherItem(
  over: Partial<WeatherPanelItemV1> & { kind: string; key: string },
): WeatherPanelItemV1 {
  return {
    source: "vpws50",
    level: 5,
    shownAreas: ["東京都", "千葉県"],
    omittedAreaCount: 0,
    addedAreas: [],
    ...over,
  };
}

function weatherInput(over: Partial<WeatherEmergencyInputV1> = {}): WeatherEmergencyInputV1 {
  return {
    kind: "weather",
    level: 5,
    generation: "vpws50:1",
    items: [weatherItem({ key: "vpws50:0:L5 大雨特別警報", kind: "L5 大雨特別警報" })],
    truncated: false,
    restored: false,
    trigger: null,
    activationKey: "a1",
    firstPageRowKey: null,
    ...over,
  };
}

describe("EmergencyScreen", () => {
  it("④ EewPanel が 震央/推定最大震度/M/続報番号 を render する", () => {
    const { container } = render(EmergencyScreen, { panels: [panel("eew:1", eewInput())] });
    expect(screen.getByText("浦河沖")).toBeTruthy();
    // v3 で震度表記が「5強」→「5+」に統一された (formatIntShort)
    // 推定最大震度: プレフィックスは静止テキスト、値は RollingNumber (data-value) で取る
    expect(container.querySelector(".max-int")?.textContent).toContain("推定最大震度");
    expect(container.querySelector('.max-int [data-value="5+"]')).toBeTruthy();
    // Phase B タイル化で M はラベル (「M」) と値 (「6.1」) が別要素の stat タイルに分かれた
    expect(screen.getByText("M", { selector: ".stat-label" })).toBeTruthy();
    expect(container.querySelector('.stat-value [data-value="6.1"]')).toBeTruthy();
    expect(container.querySelector('.stat-tile [data-value="6.1"]')).toBeTruthy();
    expect(screen.getByText(/第3報/)).toBeTruthy();
  });

  it("⑤ 続報 (同 key の input 差し替え) で再マウントされず内容が更新される", async () => {
    const { rerender } = render(EmergencyScreen, {
      panels: [panel("eew:1", eewInput({ serial: "1" }))],
    });
    const before = screen.getByTestId("eew:1");
    await rerender({ panels: [panel("eew:1", eewInput({ serial: "2" }))] });
    const after = screen.getByTestId("eew:1");
    expect(after).toBe(before);
    expect(screen.getByText(/第2報/)).toBeTruthy();
  });

  it("⑥ TsunamiPanel が levelLabel と沿岸名を render、level 別 class が付く", () => {
    const { container } = render(EmergencyScreen, {
      panels: [
        panel(
          "tsunami:current",
          tsunamiInput({ level: "majorWarning", levelLabel: "大津波警報" }),
        ),
      ],
    });
    expect(screen.getByText("大津波警報")).toBeTruthy();
    expect(screen.getByText("岩手県")).toBeTruthy();
    expect(container.querySelector(".tsunami-majorWarning")).toBeTruthy();
  });

  it("⑦ QuakePanel が震度別リストを大きい順に render する", () => {
    render(EmergencyScreen, { panels: [panel("quake:1", quakeInput())] });
    const strong = screen.getByText(/浦河町/);
    const weak = screen.getByText(/帯広市/);
    // DOM 順序: compareDocumentPosition の PRECEDING/FOLLOWING で判定
    // strong (5強=表示上は5+) が weak (4) より前に出現する
    // eslint-disable-next-line no-bitwise
    const position = strong.compareDocumentPosition(weak);
    expect((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
  });

  // ── Spec C Phase 2: 気象警報の主役パネル ──

  describe("WeatherEmergencyPanel", () => {
    it("weather kind が QuakePanel に落ちず WeatherEmergencyPanel で描画される (フォールスルー撲滅)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput())],
      });
      expect(container.querySelector(".weather-panel")).toBeTruthy();
      expect(container.querySelector(".quake-panel")).toBeFalsy();
      expect(container.querySelector(".eew-panel")).toBeFalsy();
      expect(container.querySelector(".tsunami-panel")).toBeFalsy();
    });

    it("「何が / どこ / どうする」の 3 固定領域を描く (L5)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput())],
      });
      const p = container.querySelector(".weather-panel")!;
      expect(p.querySelector(".heading")?.textContent).toContain("気象特別警報");
      // 何が
      expect(p.querySelector(".tile-what .level-label")?.textContent).toBe("警戒レベル5相当");
      expect(p.querySelector(".tile-what .alert-name")?.textContent).toBe("大雨特別警報");
      // どこ
      const row = p.querySelector(".tile-where .where-row")!;
      expect(row.querySelector(".kind")?.textContent).toBe("大雨特別警報");
      expect(Array.from(row.querySelectorAll(".area-name")).map((el) => el.textContent)).toEqual([
        "東京都",
        "千葉県",
      ]);
      // どうする (主役スロットは独立した行動レール。compact のみヒーロー行へ束ねる)
      expect(p.querySelector(".tile-action .action-main")?.textContent).toBe("命の危険 直ちに安全確保");
      expect(p.querySelector(".tile-action .action-note")?.textContent).toContain(
        "自治体が発令する避難指示とは別の防災気象情報です",
      );
    });

    it("L4 のみの昇格では見出し・行動文が L4 の語彙になる", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              level: 4,
              items: [weatherItem({ key: "k1", kind: "L4 洪水警報", level: 4 })],
            }),
          ),
        ],
      });
      const p = container.querySelector(".weather-panel")!;
      expect(p.querySelector(".heading")?.textContent).toContain("気象警報");
      expect(p.querySelector(".level-label")?.textContent).toBe("警戒レベル4相当");
      expect(p.querySelector(".action-main")?.textContent).toBe("危険な場所にいる人は全員避難");
      expect(p.classList.contains("role-weatherWarning")).toBe(true);
    });

    it("L5 主 + L4 併存では L4 が副セクションへ回り、主セクションには混ざらない", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              items: [
                weatherItem({ key: "k5", kind: "L5 大雨特別警報", level: 5 }),
                weatherItem({ key: "k4", kind: "L4 洪水警報", level: 4, source: "vpww56" }),
              ],
            }),
          ),
        ],
      });
      const p = container.querySelector(".weather-panel")!;
      const mainKinds = Array.from(p.querySelectorAll(".tile-where .kind")).map((el) => el.textContent);
      expect(mainKinds).toEqual(["大雨特別警報"]);
      const sub = p.querySelector(".tile-sub")!;
      expect(sub.querySelector(".sub-level")?.textContent).toBe("警戒レベル4相当");
      expect(sub.querySelector(".sub-action")?.textContent).toBe("危険な場所にいる人は全員避難");
      expect(Array.from(sub.querySelectorAll(".kind")).map((el) => el.textContent)).toEqual([
        "洪水警報",
      ]);
    });

    it("同じ kind が両 source にあっても行を統合せず、地域数も合算しない (非合算契約)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              items: [
                weatherItem({ key: "a", kind: "L5 大雨特別警報", source: "vpws50", shownAreas: ["東京都"], omittedAreaCount: 2 }),
                weatherItem({ key: "b", kind: "L5 大雨特別警報", source: "vpww56", shownAreas: ["千葉県"], omittedAreaCount: 3 }),
              ],
              truncated: true,
            }),
          ),
        ],
      });
      const rows = container.querySelectorAll(".tile-where .where-row");
      expect(rows.length).toBe(2);
      expect(Array.from(rows).map((r) => r.querySelector(".omitted")?.textContent)).toEqual([
        "ほか2地域",
        "ほか3地域",
      ]);
      // 「何が」の警報名だけは重複を畳む (地域は畳まない)
      expect(container.querySelectorAll(".tile-what .alert-name").length).toBe(1);
    });

    // ユーザー決定 2026-07-26: 省略の告知は行末の「ほか N 地域」「ほか N 種別」に一本化する。
    // 領域下端の固定文「表示は一部です」は主語が無く「ページの一部」と誤読されるうえ、
    // 行末表記が同じことを件数付きで言っているので廃止した
    it("省略があっても領域下端に固定文を出さない (告知は行末の件数に一本化)", () => {
      const areas = Array.from({ length: 20 }, (_, i) => `地域${i}`);
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              truncated: true,
              items: [weatherItem({ key: "k", kind: "L5 大雨特別警報", shownAreas: areas, omittedAreaCount: 3 })],
            }),
          ),
        ],
      });
      expect(container.querySelector(".tile-where .partial")).toBeFalsy();
      // 省略の告知そのものは残る (UI 上限 8 件 + engine 縮退 3 件 = ほか15地域)
      expect(container.querySelector(".tile-where .omitted")?.textContent).toContain("ほか");
    });

    // Codex R3 Important: source 違いの同一種別を 2 種別と数えると、実際には何も隠していないのに
    // 「ほか 1 種別」が出る
    it("副セクションの上限は distinct な種別で数える (同一種別が両 source から来ても 1 種別)", () => {
      const subs = [
        weatherItem({ key: "s0", kind: "L4 洪水警報", level: 4, source: "vpws50" }),
        weatherItem({ key: "s1", kind: "L4 洪水警報", level: 4, source: "vpww56" }),
        weatherItem({ key: "s2", kind: "L4 高潮警報", level: 4, source: "vpws50" }),
        weatherItem({ key: "s3", kind: "L4 土砂災害警戒情報", level: 4, source: "vpws50" }),
      ];
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({ items: [weatherItem({ key: "m", kind: "L5 大雨特別警報" }), ...subs] }),
          ),
        ],
      });
      const sub = container.querySelector(".tile-sub")!;
      // 副セクションは地域を持たない種別の要約。洪水警報は source 2 件でも 1 種別に畳む
      expect(Array.from(sub.querySelectorAll(".sub-kinds .kind")).map((el) => el.textContent)).toEqual([
        "洪水警報",
        "高潮警報",
        "土砂災害警戒情報",
      ]);
      expect(sub.querySelector(".sub-omitted")).toBeFalsy();
    });

    // Codex R5 Important: 昇格状態の権威は engine。中身が組めていない窓でも主役表示は畳まない
    it("中身 0 件でもパネルを描き、「同期中」を明示する (フロント独自の降格をしない)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput({ items: [] }))],
      });
      expect(container.querySelector(".weather-panel")).toBeTruthy();
      expect(container.querySelector(".tile-what .level-label")?.textContent).toBe("警戒レベル5相当");
      expect(container.querySelector(".tile-where .syncing")?.textContent).toBe("対象地域を同期中です");
      // 行動文は engine のレベルから出るので、中身待ちでも「どうする」は出る
      expect(container.querySelector(".action-main")?.textContent).toBe("命の危険 直ちに安全確保");
    });

    // Codex R5 Minor: 「同じ measureKey のまま親が新しい input object を渡しても実測値を捨てない」
    // — これが崩れると ResizeObserver が鳴らない限り fallback 行数に固定される (実際に踏んだ)
    it("同一 generation で input object が差し替わっても実測値を捨てない", async () => {
      const origRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      class FixedResizeObserver {
        constructor(private cb: (entries: unknown[]) => void) {}
        observe(el: Element): void {
          if (el.classList.contains("where-body")) {
            this.cb([{ contentRect: { height: 100 }, target: el }]);
          } else if (el.classList.contains("where-row")) {
            this.cb([{ borderBoxSize: [{ blockSize: 40 }], target: el }]);
          }
        }
        unobserve(): void {}
        disconnect(): void {}
      }
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FixedResizeObserver;
      try {
        const items = Array.from({ length: 5 }, (_, i) =>
          weatherItem({ key: `k${i}`, kind: `L5 特別警報${i}` }),
        );
        const { container, rerender } = render(WeatherEmergencyPanel, {
          input: weatherInput({ items }),
          compact: false,
          layoutSettling: false,
        });
        flushSync();
        // 実測 100px / 40px = 2 行/ページ → 5 行で 3 ページ
        expectCurrentDot(container.querySelector(".tile-where"), 1, 3);

        // 中身も generation も同じだが、親は毎回新しいオブジェクトを渡す (deriveEmergencyPanels の実態)
        await rerender({
          input: weatherInput({ items: items.map((it) => ({ ...it })) }),
          compact: false,
          layoutSettling: false,
        });
        flushSync();
        // 実測を捨てて fallback (4 行 → 2 ページ) に戻っていないこと
        expectCurrentDot(container.querySelector(".tile-where"), 1, 3);
      } finally {
        if (origRO === undefined) {
          delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
        } else {
          (globalThis as { ResizeObserver?: unknown }).ResizeObserver = origRO;
        }
      }
    });

    // ユーザー指摘 2026-07-26: 電文由来の `L5 大雨特別警報` と `暴風特別警報` (レベル非対応) が
    // 混在して読みづらい。主レベルは見出しで一度示すので、パネル内では接頭辞を落として揃える
    it("警報名の L 接頭辞を落として揃える (レベル非対応の種別と混在させない)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              items: [
                weatherItem({ key: "a", kind: "L5 大雨特別警報" }),
                weatherItem({ key: "b", kind: "暴風特別警報" }),
                weatherItem({ key: "c", kind: "L4 洪水警報", level: 4 }),
              ],
            }),
          ),
        ],
      });
      expect(
        Array.from(container.querySelectorAll(".tile-what .alert-name")).map((el) => el.textContent),
      ).toEqual(["大雨特別警報", "暴風特別警報"]);
      expect(
        Array.from(container.querySelectorAll(".tile-where .kind")).map((el) => el.textContent),
      ).toEqual(["大雨特別警報", "暴風特別警報"]);
      expect(container.querySelector(".tile-sub .kind")?.textContent).toBe("洪水警報");
      // 見出しの「警戒レベル5相当」がレベルを担うので、行から L が消えても情報は失われない
      expect(container.querySelector(".tile-what .level-label")?.textContent).toBe("警戒レベル5相当");
    });

    // ユーザー指摘 2026-07-26: 区分と地域が font-weight だけで分かれていて視認性が悪い。
    // 遠見・夜間減光ではウェイト差が最初に消えるので、列 + 罫線 + role 色で分ける
    it("「どこ」の行は 2 列グリッドで、地域側に罫線・区分に role 色を持つ", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toMatch(/\.where-row\s*\{[^}]*display: grid;[^}]*grid-template-columns:/);
      expect(src).toMatch(/\.areas\s*\{[^}]*border-inline-start: 1px solid var\(--hairline\);/);
      expect(src).toMatch(/\.kind\s*\{[^}]*color: var\(--role-weatherWarning\);/);
      expect(src).toMatch(/\.role-weatherEmergency \.where-row \.kind\s*\{[^}]*color: var\(--role-weatherEmergency\);/);
    });

    // ユーザー指摘 2026-07-26: 同格タイルの多用でメリハリが無い。面を持つのは詳細一覧だけにする
    it("面 (surface/影) を持つのは詳細一覧タイルだけで、他 3 領域は面を持たない", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toMatch(
        /\.tile-what,\s*\.tile-action,\s*\.tile-sub\s*\{[^}]*background: none;[^}]*box-shadow: none;/,
      );
      // どうする = role 色の縦レール、副節 = 髪の毛罫のみ
      expect(src).toMatch(/\.tile-action\s*\{[^}]*border-inline-start: var\(--header-band-width\) solid var\(--role-weatherWarning\)/);
      expect(src).toMatch(/\.tile-sub\s*\{[^}]*border-top: 1px solid var\(--hairline\)/);
    });

    it("ページャは詳細一覧の見出し行にあり、省略の告知とは場所を分ける", () => {
      const items = Array.from({ length: 5 }, (_, i) =>
        weatherItem({ key: `k${i}`, kind: `L5 特別警報${i}` }),
      );
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput({ items }))],
      });
      expect(container.querySelector(".where-head .section-label")?.textContent).toBe("対象地域・区分");
      expect(container.querySelector(".where-head .page-dots")).toBeTruthy();
    });

    // Codex R6 Important: 行高の観測は最大値の片方向なので、狭幅で折り返した行高が広幅へ戻っても
    // 残り、余分なページが居座る。1 行に並ぶ地域数が変わったら DOM から測り直す
    it("狭幅で増えたページが、幅が戻ると解消する (行高の観測が片方向に残らない)", async () => {
      const origRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      const origRect = Element.prototype.getBoundingClientRect;
      // 幅と行高をまとめて制御する。狭いときは行が折り返して高くなる、という実機の関係を模す
      let areaWidth = 120; // 地域列の幅
      const rowHeightOf = (): number => (areaWidth < 300 ? 50 : 25);
      // 観測対象を覚えておき、幅が変わったら実 ResizeObserver と同じく再通知する
      const observed: Array<{ el: Element; cb: (entries: unknown[]) => void }> = [];
      const notify = (el: Element, cb: (entries: unknown[]) => void): void => {
        if (el.classList.contains("where-body")) {
          cb([{ contentRect: { height: 100 }, target: el }]);
        } else if (el.classList.contains("where-row")) {
          cb([{ borderBoxSize: [{ blockSize: rowHeightOf() }], target: el }]);
        }
      };
      const fireAll = (): void => {
        for (const { el, cb } of observed) notify(el, cb);
      };
      class WidthResizeObserver {
        constructor(private cb: (entries: unknown[]) => void) {}
        observe(el: Element): void {
          observed.push({ el, cb: this.cb });
          notify(el, this.cb);
        }
        unobserve(): void {}
        disconnect(): void {}
      }
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = WidthResizeObserver;
      Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
        const height = this.classList.contains("where-body")
          ? 100
          : this.classList.contains("where-row")
            ? rowHeightOf()
            : 0;
        const width = this.classList.contains("areas") ? areaWidth : 0;
        return { height, width, top: 0, bottom: height, left: 0, right: width, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      };
      // jsdom は CSS を解決しないので実効フォントサイズも与える (地域件数の算出に要る)
      const origComputed = window.getComputedStyle;
      window.getComputedStyle = ((el: Element) =>
        ({ fontSize: "20px", getPropertyValue: () => "" }) as unknown as CSSStyleDeclaration) as typeof window.getComputedStyle;
      try {
        const items = Array.from({ length: 4 }, (_, i) =>
          weatherItem({ key: `k${i}`, kind: `L5 特別警報${i}` }),
        );
        const { container } = render(WeatherEmergencyPanel, {
          input: weatherInput({ items }),
          compact: false,
          layoutSettling: false,
        });
        flushSync();
        // 狭幅: 領域 100px / 行 50px = 2 行/ページ → 4 行で 2 ページ
        expectCurrentDot(container.querySelector(".tile-where"), 1, 2);

        // 幅だけが広がる (レイアウト整定を経由しない、純粋な ResizeObserver 通知)
        areaWidth = 600;
        fireAll();
        flushSync();
        // 領域 100px / 行 25px = 4 行 → 1 ページ。折返し時の 50px を持ち越していたら 2 ページのまま
        expect(container.querySelector(".tile-where .page-dots")).toBeFalsy();
      } finally {
        Element.prototype.getBoundingClientRect = origRect;
        window.getComputedStyle = origComputed;
        if (origRO === undefined) {
          delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
        } else {
          (globalThis as { ResizeObserver?: unknown }).ResizeObserver = origRO;
        }
      }
    });

    // ── spec 追補 (2026-07-26/27): 新規/更新バッジ・追加地域ハイライト・再点灯 ──

    it("新規発表・更新発表をバッジで出し、判定材料が無ければ出さない", () => {
      const cases: Array<[("new" | "update" | null), string | null]> = [
        ["new", "新規発表"],
        ["update", "更新発表"],
        [null, null],
      ];
      for (const [trigger, label] of cases) {
        const { container, unmount } = render(EmergencyScreen, {
          panels: [panel("weather:current", weatherInput({ trigger }))],
        });
        expect(container.querySelector(".heading .trigger-badge")?.textContent ?? null).toBe(label);
        unmount();
      }
    });

    it("追加された地域だけに下線ハイライトが付く", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              items: [
                weatherItem({
                  key: "k",
                  kind: "L5 大雨特別警報",
                  shownAreas: ["東京都", "千葉県"],
                  addedAreas: ["千葉県"],
                }),
              ],
            }),
          ),
        ],
      });
      const areas = Array.from(container.querySelectorAll(".tile-where .area-name"));
      expect(areas.map((el) => el.textContent)).toEqual(["東京都", "千葉県"]);
      expect(areas.map((el) => el.classList.contains("added"))).toEqual([false, true]);
    });

    // ご主人決定 2026-07-27: 「L5 継続中に L4 の地域が増えた」で更新点灯するのに、下位レベルが
    // 種別名 + 件数へ畳まれているとどこが増えたのか一度も読めない。追加が起きた下位行だけを
    // 例外として地域名つきでページ送り列に出す
    it("追加を含む下位レベルの行だけ、地域名つきでページ送り列に出る", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              items: [
                weatherItem({ key: "m", kind: "L5 大雨特別警報", shownAreas: ["東京都"] }),
                weatherItem({
                  key: "s-added",
                  kind: "L4 洪水警報",
                  level: 4,
                  shownAreas: ["千葉県", "茨城県"],
                  addedAreas: ["茨城県"],
                }),
                // 追加を含まない下位行は従来どおり要約のまま (地域名を出さない)
                weatherItem({ key: "s-plain", kind: "L4 高潮警報", level: 4, shownAreas: ["静岡県"] }),
              ],
            }),
          ),
        ],
      });
      const rows = Array.from(container.querySelectorAll(".tile-where .where-row"));
      expect(rows.map((r) => r.querySelector(".kind")?.textContent)).toEqual([
        "大雨特別警報",
        "L4洪水警報",
      ]);
      // 下位レベルの行はレベル印を持ち、主レベルの意味色を借りない
      const subRow = rows[1];
      expect(subRow.classList.contains("sub-level-row")).toBe(true);
      expect(subRow.querySelector(".row-level")?.textContent).toBe("L4");
      // 追加された地域だけに下線が付く
      const areas = Array.from(subRow.querySelectorAll(".area-name"));
      expect(areas.map((el) => el.textContent)).toEqual(["千葉県", "茨城県"]);
      expect(areas.map((el) => el.classList.contains("added"))).toEqual([false, true]);
      // 副セクションの要約は下位レベルの全種別を持ったまま (巡回で別ページでも種別は読める)
      const sub = container.querySelector(".tile-sub")!;
      expect(Array.from(sub.querySelectorAll(".sub-kinds .kind")).map((el) => el.textContent)).toEqual([
        "洪水警報",
        "高潮警報",
      ]);
    });

    it("ハイライトは文字色を触らず、下線と色以外の手掛かりを併用する (critical overlay 耐性)", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      const rule = src.match(/\.area-name\.added\s*\{[^}]*\}/)?.[0] ?? "";
      expect(rule).toContain("text-decoration");
      expect(rule).not.toMatch(/(^|[^-])color:/); // 文字色は触らない
      expect(src).toMatch(/\.area-name\.added::before\s*\{[^}]*content:/); // 色に依存しない手掛かり
    });

    // spec 追補 C1: パネル key は固定なので、これが無いと内容更新で画面が動かない
    it("activationKey が変わると中身が差し替わる (再点灯演出の契機)", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toContain("{#key input.activationKey}");
      // 外側 key に混ぜない (レイアウト補間と実測状態を壊さない)
      const derive = readFileSync(join(__dirname, "..", "..", "lib", "derive.ts"), "utf-8");
      expect(derive).toContain('key: "weather:current"');
      expect(derive).not.toMatch(/key: `weather:current[^`]*\$\{/);
    });

    it("EmergencyScreen は気象パネルにもレイアウト整定フラグを渡す", () => {
      const src = readFileSync(join(__dirname, "..", "EmergencyScreen.svelte"), "utf-8");
      expect(src).toMatch(/<WeatherEmergencyPanel[^>]*layoutSettling=\{settling\}/);
    });

    // Codex R4 Important: 整定中の過渡値を確定値へ昇格させると、遷移中に折り返して膨らんだ行高が
    // 最終レイアウトに residue として残り、以後ずっと余分にページを割る。
    // 遷移中 40px → 整定後 20px を与え、最終値で容量が計算し直されることを実挙動で固定する
    it("整定解除後は遷移中の行高を持ち越さず、最終 DOM から測り直して容量を決める", async () => {
      const origRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      const origRect = Element.prototype.getBoundingClientRect;
      // 遷移中は折返しで 40px、整定後の最終レイアウトでは 20px を報告する
      let reportedRowPx = 40;
      class SettlingResizeObserver {
        constructor(private cb: (entries: unknown[]) => void) {}
        observe(el: Element): void {
          if (el.classList.contains("where-body")) {
            this.cb([{ contentRect: { height: 100 }, target: el }]);
          } else if (el.classList.contains("where-row")) {
            this.cb([{ borderBoxSize: [{ blockSize: reportedRowPx }], target: el }]);
          }
        }
        unobserve(): void {}
        disconnect(): void {}
      }
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = SettlingResizeObserver;
      // 整定後の最終レイアウト: 領域 100px・行 20px (= 5 行入る)
      Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
        const height = this.classList.contains("where-body")
          ? 100
          : this.classList.contains("where-row")
            ? 20
            : 0;
        return { height, width: 0, top: 0, bottom: height, left: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      };
      try {
        const items = Array.from({ length: 5 }, (_, i) =>
          weatherItem({ key: `k${i}`, kind: `L5 特別警報${i}` }),
        );
        const { container, rerender } = render(WeatherEmergencyPanel, {
          input: weatherInput({ items }),
          compact: false,
          layoutSettling: true,
        });
        flushSync();
        // 整定中は実測を採らない = 未実測扱いの fallback 4 行 → 2 ページ
        expectCurrentDot(container.querySelector(".tile-where"), 1, 2);

        reportedRowPx = 20;
        await rerender({ input: weatherInput({ items }), compact: false, layoutSettling: false });
        flushSync();
        // 最終 DOM (100px / 20px) で測り直し 5 行 = 1 ページ。遷移中の 40px を持ち越していたら 3 ページになる
        expect(container.querySelector(".tile-where .page-dots")).toBeFalsy();
        expect(container.querySelectorAll(".tile-where .where-row").length).toBe(5);
      } finally {
        Element.prototype.getBoundingClientRect = origRect;
        if (origRO === undefined) {
          delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
        } else {
          (globalThis as { ResizeObserver?: unknown }).ResizeObserver = origRO;
        }
      }
    });

    // ユーザー決定 2026-07-26: 区分一覧は上限を掛けず折り返して全種別を載せる。
    // 上限 + 「ほか N 種別」だと、最上級レベルに何が出ているかが件数へ丸められる
    it("区分一覧は種別数によらず全種別を載せる (件数に丸めない)", () => {
      const items = Array.from({ length: 7 }, (_, i) =>
        weatherItem({ key: `k${i}`, kind: `L5 特別警報${i}` }),
      );
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput({ items }))],
      });
      const what = container.querySelector(".tile-what")!;
      expect(what.querySelectorAll(".alert-name").length).toBe(7);
      expect(what.querySelector(".name-omitted")).toBeFalsy();
    });

    // ユーザー決定 2026-07-26: 副セクションは主役スロットでも compact でも「地域を持たない要約」。
    // 地域行を並べると折返しで高さが青天井になり、ページ送りの無い固定領域では黙って切られる
    it("副セクションは地域行を持たず、種別名だけを並べる (主役スロットでも同じ)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              items: [
                weatherItem({ key: "m", kind: "L5 大雨特別警報" }),
                weatherItem({ key: "s0", kind: "L4 洪水警報", level: 4, shownAreas: ["千葉県", "茨城県"] }),
              ],
            }),
          ),
        ],
      });
      const sub = container.querySelector(".tile-sub")!;
      expect(sub.querySelectorAll(".where-row").length).toBe(0);
      expect(sub.querySelectorAll(".area-name").length).toBe(0);
      expect(Array.from(sub.querySelectorAll(".sub-kinds .kind")).map((el) => el.textContent)).toEqual([
        "洪水警報",
      ]);
      expect(sub.querySelector(".sub-omitted")).toBeFalsy();
    });

    // ユーザー決定 2026-07-26: 区分は compact でも全種別を載せる (最上級の中身を件数へ丸めない)。
    // 補助行だけは主役スロット限定にして、狭い枠では主情報へ高さを回す
    it("compact でも区分一覧は全種別を載せ、補助行だけを省く", () => {
      const items = Array.from({ length: 4 }, (_, i) =>
        weatherItem({ key: `k${i}`, kind: `L5 特別警報${i}` }),
      );
      const { container } = render(EmergencyScreen, {
        panels: [panel("eew:1", eewInput()), panel("weather:current", weatherInput({ items }))],
      });
      const p = container.querySelector(".weather-panel.compact")!;
      expect(p.querySelectorAll(".tile-what .alert-name").length).toBe(4);
      expect(p.querySelector(".tile-what .name-omitted")).toBeFalsy();
      expect(p.querySelector(".action-note")).toBeFalsy();
      // compact だけはレベルと行動文を 1 行に束ねて縦を節約する
      expect(p.querySelector(".hero.merged")).toBeTruthy();
      expect(p.querySelector(".hero .level-label")?.textContent).toBe("警戒レベル5相当");
      expect(p.querySelector(".hero .action-main")?.textContent).toBe("命の危険 直ちに安全確保");
    });

    it("主役スロットではレベルと行動文を束ねず、行動レールに補助行も出す", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput())],
      });
      // ヒーロー行はレベルのみ (行動文を束ねない)
      expect(container.querySelector(".hero .action-main")).toBeFalsy();
      expect(container.querySelector(".hero.merged")).toBeFalsy();
      expect(container.querySelector(".tile-action .action-note")?.textContent).toContain("自治体が発令する");
    });

    // Codex 最終レビュー: critical tier では TierOverlay の全画面フィルム (最大 α=0.34) が
    // 文字にも背景にも掛かり、合成後は意味色が AA を割る (weatherEmergency 3.21〜3.66:1)。
    // 主要な文字を --fg へ退避する。この退避を外すと監査表の該当ペアが FAIL として現れる
    // (許容リスト critical-overlay-weather-role-not-used-as-text の前提でもある)
    it("critical tier では主要な文字を --fg へ退避する (overlay 合成後の AA 割れ回避)", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      const rule = src.match(
        /:global\(main\[data-tier="critical"\]\)[\s\S]*?\{\s*color: var\(--fg\);\s*\}/,
      )?.[0];
      expect(rule, "critical tier の退避規則が無い").toBeTruthy();
      for (const sel of [".level-label", ".action-main", ".where-row .kind", ".sub-kinds .kind", ".sub-level"]) {
        expect(rule).toContain(sel);
      }
      // 意味色は看板ヘッダ帯と行動レール (非テキスト) に残す
      expect(src).toMatch(/\.role-weatherEmergency \.heading\s*\{[^}]*background: var\(--header-weatherEmergency-container\)/);
      expect(src).toMatch(/\.role-weatherEmergency \.tile-action\s*\{[^}]*border-inline-start-color: var\(--role-weatherEmergency\)/);
    });

    // ユーザー指摘 2026-07-26: 行動文 (最長 14 文字) が行動レールの幅で折り返すと視線が切れる。
    // パネルの container query 単位で上限を掛け、読める範囲まで自動で縮める
    it("行動文は折り返さず、コンテナ幅に対する可変サイズになる", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toMatch(/\.action-main\s*\{[^}]*white-space: nowrap;/);
      expect(src).toMatch(/\.action-main\s*\{[^}]*font-size: min\([^)]*\)[^;]*cqw\)/);
      // bento (行動レールが 1fr 列に入る) では上限をその幅で採り直す
      expect(src).toMatch(/@container \(min-width: 860px\)[\s\S]*\.action-main\s*\{[^}]*cqw/);
      // container query 単位が効くよう、パネルは container-type: inline-size を持つ
      expect(src).toMatch(/\.weather-panel\s*\{[^}]*container-type: inline-size;/);
    });

    // ユーザー指摘 2026-07-26: 「相当」は「警戒レベル5」に従属する語なので一段小さく出す
    it("「警戒レベルN」と「相当」を別要素にして従属を型サイズで示す", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput())],
      });
      const label = container.querySelector(".tile-what .level-label")!;
      expect(label.textContent).toBe("警戒レベル5相当");
      expect(label.querySelector(".level-suffix")?.textContent).toBe("相当");
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toMatch(/\.level-suffix\s*\{[^}]*font-size: 0\.\d+em;/);
    });

    it("compact でも控え由来なら同期中チップは残す", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel("eew:1", eewInput()),
          panel("weather:current", weatherInput({ restored: true })),
        ],
      });
      expect(container.querySelector(".weather-panel.compact .tile-what .restored-chip")).toBeTruthy();
    });

    it("compact でも同じ要約になる (幅で挙動が割れない)", () => {
      const subs = [
        weatherItem({ key: "s0", kind: "L4 洪水警報", level: 4, source: "vpws50" }),
        weatherItem({ key: "s1", kind: "L4 洪水警報", level: 4, source: "vpww56" }),
        weatherItem({ key: "s2", kind: "L4 高潮警報", level: 4 }),
      ];
      const { container } = render(EmergencyScreen, {
        panels: [
          panel("eew:1", eewInput()),
          panel(
            "weather:current",
            weatherInput({ items: [weatherItem({ key: "m", kind: "L5 大雨特別警報" }), ...subs] }),
          ),
        ],
      });
      const sub = container.querySelector(".weather-panel.compact .tile-sub")!;
      expect(sub.querySelectorAll(".where-row").length).toBe(0);
      expect(Array.from(sub.querySelectorAll(".sub-kinds .kind")).map((el) => el.textContent)).toEqual([
        "洪水警報",
        "高潮警報",
      ]);
      expect(sub.querySelector(".sub-omitted")).toBeFalsy();
    });

    it("控え (restoredItems) 由来のときは同期中チップを出す", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput({ restored: true }))],
      });
      expect(container.querySelector(".tile-what .restored-chip")).toBeTruthy();
    });

    it("副役スロットでは compact 表示になる", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("eew:1", eewInput()), panel("weather:current", weatherInput())],
      });
      expect(container.querySelector(".weather-panel.compact")).toBeTruthy();
      expect(container.querySelector(".eew-panel.compact")).toBeFalsy();
    });

    // Codex R1 Important: 旧実装は .tile-where が overflow:hidden で、種別が増えると下側が
    // 無言で切れていた (engine 縮退にしか反応しない truncated では検知できない)。
    // QuakePanel / TsunamiPanel と同じ自動ページ送りに置き換え、全種別が到達可能なことを固定する
    it("種別が 1 ページ容量 (fallback 4) を超えたらページャが出て、全種別が巡回で到達できる", () => {
      vi.useFakeTimers();
      try {
        const items = Array.from({ length: 5 }, (_, i) =>
          weatherItem({ key: `k${i}`, kind: `L5 特別警報${i}` }),
        );
        const { container } = render(EmergencyScreen, {
          panels: [panel("weather:current", weatherInput({ items }))],
        });
        flushSync();
        // 1 ページ目: 先頭 4 件、5 件目はまだ出ない
        const kindsOf = (): (string | null)[] =>
          Array.from(container.querySelectorAll(".tile-where .kind")).map((el) => el.textContent);
        expect(kindsOf()).toEqual(["特別警報0", "特別警報1", "特別警報2", "特別警報3"]);
        expectCurrentDot(container.querySelector(".tile-where"), 1, 2);

        // 巡回で 2 ページ目へ進み、残りの種別が読める (切り捨てられていない)
        vi.advanceTimersByTime(PAGE_HOLD_MS);
        settleFade();
        expect(kindsOf()).toEqual(["特別警報4"]);
        expectCurrentDot(container.querySelector(".tile-where"), 2, 2);
      } finally {
        vi.useRealTimers();
      }
    });

    // Codex R2 Important: jsdom は ResizeObserver 未実装なので、既存テストは fallback 経路しか
    // 通らない。実測経路 (領域 100px・行高が不揃い) を制御可能なモックで通し、
    // 「最も高い行」を基準に容量を決める = 過積載しないことを固定する。
    // 行間は CSS gap ではなく行の padding で持つ設計なので、実測値に gap 補正を足す必要はない
    it("実測経路: 行高が不揃いでも最も高い行を基準にページ分割する (過積載しない)", () => {
      const origRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      let rowSeen = 0;
      class FakeResizeObserver {
        constructor(private cb: (entries: unknown[]) => void) {}
        observe(el: Element): void {
          if (el.classList.contains("where-body")) {
            this.cb([{ contentRect: { height: 100 }, target: el }]);
            return;
          }
          if (el.classList.contains("where-row")) {
            // 1 行目 20px、2 行目以降は折返しで 40px (先頭行だけを代表値にすると溢れる形)
            const height = rowSeen++ === 0 ? 20 : 40;
            this.cb([{ borderBoxSize: [{ blockSize: height }], target: el }]);
          }
        }
        unobserve(): void {}
        disconnect(): void {}
      }
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
      try {
        const items = Array.from({ length: 5 }, (_, i) =>
          weatherItem({ key: `k${i}`, kind: `L5 特別警報${i}` }),
        );
        const { container } = render(EmergencyScreen, {
          panels: [panel("weather:current", weatherInput({ items }))],
        });
        flushSync();
        // 100px / 最大行高 40px = 2 行/ページ → 5 行は 3 ページ (先頭行 20px 基準の 5 行詰めではない)
        expectCurrentDot(container.querySelector(".tile-where"), 1, 3);
        expect(container.querySelectorAll(".tile-where .where-row").length).toBe(2);
      } finally {
        if (origRO === undefined) {
          delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
        } else {
          (globalThis as { ResizeObserver?: unknown }).ResizeObserver = origRO;
        }
      }
    });

    it("1 ページに収まるときはページャを出さない", () => {
      const { container } = render(EmergencyScreen, {
        panels: [panel("weather:current", weatherInput())],
      });
      expect(container.querySelector(".tile-where .page-dots")).toBeFalsy();
    });

    it("1 行の地域名が上限を超えたら「ほか N 地域」へ合算する (engine 縮退ぶんと合流)", () => {
      const areas = Array.from({ length: 20 }, (_, i) => `地域${i}`);
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({
              items: [weatherItem({ key: "k", kind: "L5 大雨特別警報", shownAreas: areas, omittedAreaCount: 3 })],
            }),
          ),
        ],
      });
      const row = container.querySelector(".tile-where .where-row")!;
      // 非 compact の上限 12 件まで描き、落とした 8 件 + engine 縮退 3 件 = ほか11地域
      expect(row.querySelectorAll(".area-name").length).toBe(12);
      expect(row.querySelector(".omitted")?.textContent).toBe("ほか11地域");
    });

    it("副セクションの種別が上限を超えたら「ほか N 種別」で明示する (黙って消さない)", () => {
      const subs = Array.from({ length: 5 }, (_, i) =>
        weatherItem({ key: `s${i}`, kind: `L4 警報${i}`, level: 4 }),
      );
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "weather:current",
            weatherInput({ items: [weatherItem({ key: "m", kind: "L5 大雨特別警報" }), ...subs] }),
          ),
        ],
      });
      const sub = container.querySelector(".tile-sub")!;
      expect(sub.querySelectorAll(".sub-kinds .kind").length).toBe(3);
      expect(sub.querySelector(".sub-omitted")?.textContent).toBe("ほか2種別");
    });

    it("page-cycler を onDestroy で破棄する (QuakePanel/TsunamiPanel と同じ配線)", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toMatch(/import \{[^}]*\bonDestroy\b[^}]*\} from "svelte"/);
      expect(src).toContain("onDestroy(() => cycler.destroy())");
      expect(src).toContain("../lib/page-cycler.svelte");
    });

    it("主見出しは他パネルと同じ --panel-header-* トークンで高さを揃える", () => {
      const src = readFileSync(join(__dirname, "..", "WeatherEmergencyPanel.svelte"), "utf-8");
      expect(src).toContain("--panel-header-min-h");
      expect(src).toContain("--panel-header-padding-v");
      expect(src).toContain("--panel-header-padding-h");
      // 色 role は既存の weatherEmergency / weatherWarning を再利用 (新規 role トークンを作らない)
      expect(src).toMatch(/var\(--header-weather(Emergency|Warning)-container\)/);
      expect(src).toMatch(/var\(--header-band-width\)\s+solid\s+var\(--header-band-weather\w+\)/);
      expect(src).not.toContain("var(--bar-");
    });
  });

  it("⑧ 緊急画面はヘッダ帯の小時計を持たない (第3波でテロップへ移設)", () => {
    const { container } = render(EmergencyScreen, {
      panels: [panel("eew:1", eewInput())],
    });
    expect(container.querySelector(".clock-corner")).toBeFalsy();
  });

  it("⑨ QuakePanel の地域別震度が待機画面と同じ int-chip 形式で render される", () => {
    const { container } = render(EmergencyScreen, { panels: [panel("quake:1", quakeInput())] });
    expect(container.querySelector(".int-chip.int-r9")).toBeTruthy();
  });

  // compact 切替の遅延 (spec §3): 新規キーは即時、既存キーが主役⇔副役を移るときだけ quick 遷移
  // 完了後に compact を反映する。142ms 内の逆転操作 (割込み → 即取り消し) で古い timer が誤適用
  // されないことを固定する。jsdom は matchMedia 未実装 = reducedMotion false = 遅延が有効。
  it("compact 遅延: 142ms 内の主役⇔副役 逆転操作で古い timer が誤適用されない (spec §3)", async () => {
    vi.useFakeTimers();
    try {
      const quake = panel("quake:1", quakeInput());
      const eew = panel("eew:1", eewInput());
      // 初期: quake 主役 (compact なし) / eew 副役 (compact)
      const { container, rerender } = render(EmergencyScreen, { panels: [quake, eew] });
      flushSync();
      expect(container.querySelector(".quake-panel.compact")).toBeFalsy();
      expect(container.querySelector(".eew-panel.compact")).toBeTruthy();

      // priority 割込みで役割逆転。compact は遷移完了 (142ms) 後に反映されるため、この時点では据え置き
      await rerender({ panels: [eew, quake] });
      flushSync();
      expect(container.querySelector(".quake-panel.compact")).toBeFalsy();
      expect(container.querySelector(".eew-panel.compact")).toBeTruthy();

      // 142ms 未満で元へ戻す (逆転操作) → 保留中の timer は取り消される
      vi.advanceTimersByTime(50);
      await rerender({ panels: [quake, eew] });
      flushSync();

      // 以降いくら時間を進めても古い timer は誤適用されず、元の割り当てのまま
      vi.advanceTimersByTime(500);
      flushSync();
      expect(container.querySelector(".quake-panel.compact")).toBeFalsy();
      expect(container.querySelector(".eew-panel.compact")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex R2: deriveEmergencyPanels() は毎レンダ新配列を返すため、同一目標のまま頻繁に再レンダされると
  // 旧実装は役割変更 timer を毎回張り直して永久に発火しなかった。目標が変わらない再レンダでは timer を
  // 継続させ、142ms 経過で確実に反映されることを固定する。
  it("compact 遅延: 目標が変わらない頻繁な再レンダでも timer が永久リセットされず反映される (Codex R2)", async () => {
    vi.useFakeTimers();
    try {
      const quake = panel("quake:1", quakeInput());
      const eew = panel("eew:1", eewInput());
      const { container, rerender } = render(EmergencyScreen, { panels: [quake, eew] });
      flushSync();
      // 役割逆転: eew 主役 / quake 副役 → quake の compact target が false→true になる (この時点で timer 起動)
      await rerender({ panels: [eew, quake] });
      flushSync();
      // 目標を変えずに 30ms ごとの再レンダを 6 回 (毎レンダ新配列を模す)。142ms を跨ぐが timer は継続すべき
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(30);
        await rerender({ panels: [eew, quake] });
        flushSync();
      }
      vi.advanceTimersByTime(50);
      flushSync();
      // 累計 >142ms: timer が発火し役割変更が反映される (quake 副役=compact / eew 主役=非compact)
      expect(container.querySelector(".quake-panel.compact")).toBeTruthy();
      expect(container.querySelector(".eew-panel.compact")).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex R1: settling は「新しい遷移が始まるたびに fallback timer を張り直す」方式。割込み遷移
  // (142ms 内の再遷移) で先に終わる列の遷移完了が settling を早期解除しないこと (data-settling で観測)。
  it("settling: 割込み遷移で fallback を張り直し、遷移収束まで data-settling を保つ (Codex R1)", async () => {
    vi.useFakeTimers();
    try {
      const p1 = panel("quake:1", quakeInput());
      const p2 = panel("eew:1", eewInput());
      const p3 = panel("tsunami:1", tsunamiInput());
      const { container, rerender } = render(EmergencyScreen, { panels: [p1] });
      flushSync();
      const settling = (): string | null => container.querySelector(".panels")?.getAttribute("data-settling") ?? null;
      // 初期マウントは整定しない
      expect(settling()).toBe("false");

      // 1→2: settling 開始 (fallback fires t=222)
      await rerender({ panels: [p1, p2] });
      flushSync();
      expect(settling()).toBe("true");

      // t=100 で 2→3 に再遷移 → fallback 張り直し (新 fallback fires t=322)
      vi.advanceTimersByTime(100);
      await rerender({ panels: [p1, p2, p3] });
      flushSync();

      // t=250: 旧 fallback (222) の時刻を越えても張り直しにより settling 継続
      vi.advanceTimersByTime(150);
      flushSync();
      expect(settling()).toBe("true");

      // t=450 > 322: 最後の fallback 窓を越えたら解除
      vi.advanceTimersByTime(200);
      flushSync();
      expect(settling()).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex R4: TsunamiPanel の compact 配線。副役スロット (index!==0) で compact 表示になる。
  it("TsunamiPanel は副役スロットで compact 表示になり、主役は compact でない (Codex R4)", () => {
    const { container } = render(EmergencyScreen, {
      panels: [panel("eew:1", eewInput()), panel("tsunami:1", tsunamiInput())],
    });
    expect(container.querySelector(".tsunami-panel.compact")).toBeTruthy();
    expect(container.querySelector(".eew-panel.compact")).toBeFalsy();
  });

  // Codex R6: 遷移中に OS で reduced-motion がオンになると CSS transition は即停止するが、grid sig が
  // 不変だと fallback timer だけが残り settling 解除が最大 222ms 遅延していた。reduced-motion は同期反映
  // 経路として、進行中の fallback を取り消して settling を即時解除する。jsdom は matchMedia 未実装のため
  // 制御可能な matchMedia モックを差し込んで change を発火させる (他テストへ漏らさないよう finally で復元)。
  it("settling: 遷移中に reduced-motion がオンになると fallback を待たず即時解除する (Codex R6)", async () => {
    const origMatchMedia = window.matchMedia;
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    let rmMatches = false;
    window.matchMedia = ((query: string) => ({
      get matches() {
        return rmMatches;
      },
      media: query,
      onchange: null,
      addEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
      removeEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
      addListener: (cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
      removeListener: (cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
      dispatchEvent: () => true,
    })) as unknown as typeof window.matchMedia;
    vi.useFakeTimers();
    try {
      const p1 = panel("quake:1", quakeInput());
      const p2 = panel("eew:1", eewInput());
      const p3 = panel("tsunami:1", tsunamiInput());
      const { container, rerender } = render(EmergencyScreen, { panels: [p1, p2] });
      flushSync();
      const settling = (): string | null => container.querySelector(".panels")?.getAttribute("data-settling") ?? null;

      // 2→3: settling 開始 (fallback fires t=222)
      await rerender({ panels: [p1, p2, p3] });
      flushSync();
      expect(settling()).toBe("true");

      // fallback を待たず (t=50) に reduced-motion をオン → grid sig 不変でも即時解除
      vi.advanceTimersByTime(50);
      rmMatches = true;
      for (const cb of listeners) cb({ matches: true } as MediaQueryListEvent);
      flushSync();
      expect(settling()).toBe("false");
    } finally {
      vi.useRealTimers();
      if (origMatchMedia === undefined) {
        delete (window as unknown as { matchMedia?: unknown }).matchMedia;
      } else {
        window.matchMedia = origMatchMedia;
      }
    }
  });

  it("⑪ QuakePanel は看板ヘッダ (固定ラベル) + 本文に震源概要を表示する統一文法へ再構成されている", () => {
    const { container } = render(EmergencyScreen, {
      panels: [
        panel(
          "quake:1",
          quakeInput({
            hypocenterName: "浦河沖",
            magnitude: "6.1",
            depth: "30km",
            maxLgInt: "3",
            tsunamiWarning: true,
            originTime: "2026-07-07T09:58:00+09:00",
          }),
        ),
      ],
    });
    // ヘッダは種別名の看板のみ (震源名等の概要を含まない)
    const heading = container.querySelector(".quake-panel .heading");
    expect(heading?.textContent).toContain("地震情報");
    expect(heading?.textContent).not.toContain("浦河沖");
    // 概要情報 (震源名・最大震度・M・深さ・長周期・津波・発生時刻) は本文 (.tiles) 側で値単位に render される
    const tiles = container.querySelector(".quake-panel .tiles");
    expect(tiles?.querySelector(".hypocenter")?.textContent).toContain("浦河沖");
    expect(tiles?.querySelector(".max-int")?.textContent).toContain("最大震度");
    expect(tiles?.querySelector(".stat-value")?.textContent).toContain("6.1");
    expect(
      Array.from(tiles?.querySelectorAll(".stat-value") ?? []).some((el) => el.textContent?.includes("30km")),
    ).toBe(true);
    expect(
      Array.from(tiles?.querySelectorAll(".stat-value") ?? []).some((el) => el.textContent?.includes("3")),
    ).toBe(true);
    expect(tiles?.querySelector(".chip.tsunami-mark")).toBeTruthy();
    expect(tiles?.querySelector(".chip.origin-time")?.textContent).toContain("発生");
  });

  it("⑩ EewPanel/TsunamiPanel/QuakePanel の主見出しが共通トークン (--panel-header-*) で高さを揃えている (第4波)", () => {
    // jsdom はレイアウト計算をしないため実測 height は信頼できない (このプロジェクトの既存規約)。
    // ソース上で3パネルとも同じ --panel-header-min-h / --panel-header-padding-* を参照していることを
    // 検査し、TsunamiPanel だけ headline-l (40px) を使って高さがずれていた回帰を防ぐ
    const eewSource = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    const tsunamiSource = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    const quakeSource = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    for (const source of [eewSource, tsunamiSource, quakeSource]) {
      expect(source).toContain("--panel-header-min-h");
      expect(source).toContain("--panel-header-padding-v");
      expect(source).toContain("--panel-header-padding-h");
    }
    expect(tsunamiSource).not.toContain("--type-headline-l-size");
  });

  it("パネルの角丸は shape scale トークン参照で、tile/chip の直値角丸を持たない (B1 contrasting shapes)", () => {
    const eew = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    const tsunami = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    const quake = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    for (const src of [eew, tsunami, quake]) {
      expect(src).toContain("var(--radius-m)");
      // 内側タイル/チップの px 直値角丸が残っていないこと
      expect(src).not.toMatch(/border-radius:\s*1[026]px/);
    }
    expect(eew).toContain("var(--radius-s)"); // assumed-chip
    expect(quake).toContain("var(--radius-s)"); // int-chip
  });

  it("パネルヘッダは container/on-container + 下端 CUD 帯で、旧 --bar-* solid を使わない (B2a)", () => {
    const eew = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    const tsunami = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    const quake = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    for (const src of [eew, tsunami, quake]) {
      expect(src).toMatch(/var\(--header-\w+-container\)/);
      expect(src).toMatch(/var\(--header-band-width\)\s+solid\s+var\(--header-band-\w+\)/);
      expect(src).not.toContain("var(--bar-");
    }
  });

  it("緊急パネルは elevation-3、内側タイルは elevation-1 の box-shadow を持つ (B2b、selector 単位で検証: Codex R10)", () => {
    const eew = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    // 宣言をセレクタブロックに紐付けて検査する (コメント・別ブロックでの誤マッチを避ける)
    expect(eew).toMatch(/\.eew-panel\s*\{[^}]*box-shadow:\s*var\(--elevation-3\)/);
    expect(eew).toMatch(/\.tile\s*\{[^}]*box-shadow:\s*var\(--elevation-1\)/);
  });

  // B3 hero moment: 旧・hero-in の opacity 0 スタート入場 (frame-1 可視を破る 3 経路の一つ) は
  // モーション振り付け spec (2026-07-10) で撤去した。主役スロットの「最大面積」は入場アニメでは
  // なく main-stack の grid-row span 構造 (grid-column:1 / grid-row:1 / -1) が担う。入場は
  // revealScaleIn (初期は演出なし=frame-1 可視、後発は transform+opacity) へ転換した
  it("緊急画面の主役スロットは main-stack で grid-row span の最大面積を持つ (B3 hero moment、opacity 0 入場は撤去)", () => {
    const src = readFileSync(join(__dirname, "..", "EmergencyScreen.svelte"), "utf-8");
    // 主役スロットは grid-column:1 / grid-row:1 / -1 で列全体を占める
    expect(src).toMatch(/\.layout-main-stack \.panel-slot\.is-main \{[^}]*grid-row: 1 \/ -1;/);
    // opacity 0 スタートの hero-in / panel-in keyframe は撤去済み
    expect(src).not.toContain("@keyframes hero-in");
    expect(src).not.toContain("@keyframes panel-in");
    // 入場は外枠 revealScaleIn を撤去し、枚数増減のグリッド track 補間 (grid-template の CSS transition) が担う
    expect(src).not.toContain("revealScaleIn");
    expect(src).toContain("grid-template-columns");
    expect(src).toContain("var(--spring-spatial-quick)");
  });

  it("tier ウェイトスウェル: EewPanel hero が font-weight transition を持ち、color/surface は瞬時のまま (wght #2)", () => {
    const src = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    expect(src).toMatch(/transition:\s*font-weight var\(--dur-weight-swell\)/);
    // 色や surface を tier で transition していない (weight のみ)
    expect(src).not.toMatch(/transition:[^;]*background/);
  });

  it("緊急画面の gap/padding が space トークンを使う (B4)", () => {
    const src = readFileSync(join(__dirname, "..", "EmergencyScreen.svelte"), "utf-8");
    expect(src).toContain("var(--space-3)");
  });

  it("QuakePanel の市区町村名は white-space:nowrap の city-name span で、名前の途中で改行しない (第3波 Fix14)", () => {
    const src = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    expect(src).toMatch(/\.city-name\s*\{[\s\S]*?white-space:\s*nowrap;[\s\S]*?\}/);
    expect(src).not.toContain('pg.cities.join("・")');
  });

  // T5a (詳細ページング配線) でスクロール機構を撤去し、静的リスト + ページャに置き換えた
  it("QuakePanel/LatestQuakeCard はスクロール機構 (vertical-ping-pong-scroll) を参照しない (T5a)", () => {
    const quake = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    const latest = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
    for (const src of [quake, latest]) {
      expect(src).not.toContain("vertical-ping-pong-scroll");
      expect(src).not.toMatch(/translateY\(-?100%\)/);
      // 各コンポーネント側に phase 状態機械の再実装 (setTimeout チェーン) が残っていないこと
      expect(src).not.toMatch(/type ScrollPhase/);
    }
  });

  it("QuakePanel/LatestQuakeCard は詳細ページングに共有のページャ部品 (lib/page-cycler.svelte) を参照し、実装がコピペ複製されていない", () => {
    const quake = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    const latest = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
    for (const src of [quake, latest]) {
      expect(src).toContain("../lib/page-cycler.svelte");
      expect(src).toContain("createPageCycler");
    }
  });

  it("EewPanel はスクロール機構 (vertical-ping-pong-scroll) を参照しない (T4a 全廃)", () => {
    const eew = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    expect(eew).not.toContain("vertical-ping-pong-scroll");
  });

  // 固定サマリ計器: ヘッドライン2行 (spec §2-b 改訂 2026-07-09、review-T5a-3、T4b から改修)。
  // 旧・震度分布行 (dist-item/「広域」連呼) と県別件数行 (pref-count) は廃止された
  describe("QuakePanel: 固定サマリ計器 (ヘッドライン2行)", () => {
    it("最大震度規模行に各グループの県数・市町村数を render する", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [
                { intensity: "6強", rank: 8, areas: ["高知県高知市", "愛知県名古屋市"], omittedAreaCount: 0 },
                { intensity: "6弱", rank: 7, areas: ["宮崎県宮崎市"], omittedAreaCount: 0 },
              ],
            }),
          ),
        ],
      });
      const top = container.querySelector(".instrument-top");
      // v3 で震度表記が「6強」→「6+」に統一されている (formatIntShort)
      expect(top?.querySelector(".int-chip")?.textContent).toContain("6+");
      expect(top?.querySelector(".instrument-value")?.textContent).toBe("2県2市町村");
    });

    it("グループが1つだけなら拡大範囲行は render されない", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [{ intensity: "6強", rank: 8, areas: ["高知県高知市"], omittedAreaCount: 0 }],
            }),
          ),
        ],
      });
      expect(container.querySelector(".instrument-expanded")).toBeFalsy();
    });

    // T7 preview 実測の回帰修正 (#standby-cards): areas が県プレフィックス無しの市名だけ
    // (spec §2-b の静的リスト例そのもの「宮崎市」「日南市」) だと県数が 0 になり、
    // 「0県2市町村」「0県に拡大」という意味不明な表示になっていた
    it("県プレフィックス無しの areas だけのときは規模行が「N県」を省いて市町村数だけ render する", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [{ intensity: "6弱", rank: 7, areas: ["宮崎市", "日南市"], omittedAreaCount: 0 }],
            }),
          ),
        ],
      });
      const value = container.querySelector(".instrument-top .instrument-value");
      expect(value?.textContent).toBe("2市町村");
    });

    it("両グループとも県プレフィックス無しで累積県数が 0 のときは拡大範囲行が render されない (1グループのみと同じ扱い)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [
                { intensity: "6弱", rank: 7, areas: ["宮崎市", "日南市"], omittedAreaCount: 0 },
                { intensity: "5強", rank: 6, areas: ["都城市", "延岡市"], omittedAreaCount: 3 },
              ],
            }),
          ),
        ],
      });
      expect(container.querySelector(".instrument-expanded")).toBeFalsy();
    });

    it("最大震度グループが県プレフィックス無しでも2番目のグループに県があれば拡大範囲行は通常どおり render する (県あり/なし混在)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [
                { intensity: "6弱", rank: 7, areas: ["宮崎市", "日南市"], omittedAreaCount: 0 },
                { intensity: "5強", rank: 6, areas: ["高知県高知市"], omittedAreaCount: 0 },
              ],
            }),
          ),
        ],
      });
      const expanded = container.querySelector(".instrument-expanded");
      expect(expanded?.querySelector(".instrument-value")?.textContent).toBe("1県に拡大");
    });

    it("拡大範囲行は2番目のランクラベルと累積 (最大震度含む) distinct 県数を render する", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [
                { intensity: "7", rank: 9, areas: ["宮城県栗原市"], omittedAreaCount: 0 },
                {
                  intensity: "6強", rank: 8,
                  areas: Array.from({ length: 19 }, (_, i) => `福島県市町村${i}`),
                  omittedAreaCount: 0,
                },
              ],
            }),
          ),
        ],
      });
      const expanded = container.querySelector(".instrument-expanded");
      expect(expanded?.querySelector(".instrument-label")?.textContent).toBe("6強以上");
      expect(expanded?.querySelector(".instrument-value")?.textContent).toBe("2県に拡大");
    });

    it("最大震度グループが153件でも規模行は数値のまま出す (縮退・ページングと無関係)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [
                {
                  intensity: "7", rank: 9,
                  areas: Array.from({ length: 153 }, (_, i) => `高知県市町村${i}`),
                  omittedAreaCount: 0,
                },
              ],
            }),
          ),
        ],
      });
      const value = container.querySelector(".instrument-top .instrument-value");
      expect(value?.textContent).toBe("1県153市町村");
    });
  });

  // 詳細ページング (T5a: spec §3/§4)
  describe("QuakePanel: 詳細ページング", () => {
    it("静的リスト (totalEffective<=30) では .tile-groups の全件を静的表示し、ページャは出さない", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [
                { intensity: "6強", rank: 8, areas: ["高知県高知市"], omittedAreaCount: 0 },
                { intensity: "6弱", rank: 7, areas: ["愛知県名古屋市"], omittedAreaCount: 0 },
              ],
            }),
          ),
        ],
      });
      expect(container.querySelector(".tile-groups")).toBeTruthy();
      expect(container.querySelector(".tile-page-detail")).toBeFalsy();
    });

    // T7 回帰修正 (spec §2-b の静的リスト例「震度6強 宮崎市 日南市」どおり): 静的リストは
    // pref:null バケツに「その他」ラベルを出さず市名だけにする (ページング側は維持、別テスト参照)
    it("静的リストでは県プレフィックス無しの area がラベル無しで市名だけ render される", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [{ intensity: "6強", rank: 8, areas: ["宮崎市", "日南市"], omittedAreaCount: 0 }],
            }),
          ),
        ],
      });
      const group = container.querySelector(".tile-groups .group");
      expect(group?.querySelector(".pref-name")).toBeNull();
      expect(
        Array.from(group?.querySelectorAll(".city-name") ?? []).map((el) => el.textContent),
      ).toEqual(["宮崎市", "日南市"]);
    });

    // 詳細ページング側は「その他」ラベルを維持する (レビュー指示: 原則3のラベル明示はページ側に
    // だけ意味がある)。31件超で shouldPageDetails が発火し、県プレフィックス無しの area は
    // .tile-page-detail 側の pg.pref ?? "その他" 分岐に流れることを確認する
    it("詳細ページングでは県プレフィックス無しの area が「その他」ラベル付きで render される (静的リストとは異なり維持)", () => {
      const areas = Array.from({ length: 35 }, (_, i) => `市町村${i}`);
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({ intensityGroups: [{ intensity: "6強", rank: 8, areas, omittedAreaCount: 0 }] }),
          ),
        ],
      });
      expect(container.querySelector(".tile-groups")).toBeFalsy();
      const page = container.querySelector(".tile-page-detail");
      expect(page?.querySelector(".pref-name")?.textContent).toBe("その他");
    });

    it("10県153市町村 (南海トラフ級) は各県がバジェット(20)の半分を超え県ごとに1ページ、計10ページに割れる", () => {
      const prefectures = [
        "高知県", "徳島県", "愛媛県", "香川県", "静岡県",
        "愛知県", "三重県", "和歌山県", "宮崎県", "大分県",
      ];
      const perPref = Math.floor(153 / prefectures.length);
      const areas: string[] = [];
      prefectures.forEach((pref, idx) => {
        const count = idx === prefectures.length - 1 ? 153 - perPref * (prefectures.length - 1) : perPref;
        for (let i = 0; i < count; i++) areas.push(`${pref}市町村${i}`);
      });
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 0 }],
            }),
          ),
        ],
      });
      expect(container.querySelector(".tile-groups")).toBeFalsy();
      const page = container.querySelector(".tile-page-detail");
      expect(page?.querySelector(".page-title")?.textContent).toBe("観測震度 詳細");
      expect(page?.querySelector(".page-count")?.textContent).toBe("10県153市町村");
      expectCurrentDot(page, 1, 10);
    });

    it("1県がバジェット超なら続きラベルを付けてページをまたぐ (大県分断)", () => {
      const areas = Array.from({ length: 31 }, (_, i) => `高知県市町村${i}`);
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 0 }],
            }),
          ),
        ],
      });
      const page = container.querySelector(".tile-page-detail");
      expect(page?.querySelector(".pref-name")?.textContent).toBe("高知県");
      expectCurrentDot(page, 1, 2);
    });

    // Codex R レビュー M2: severityTier (地震は最大震度 rank) が同一イベントの続報中に
    // 「上昇」したときもページを先頭に戻す。下降・同値ではリセットしない (spec §3)
    it("同一イベントで maxIntRank が上昇したらページが先頭に戻る。下降・同値では維持する", async () => {
      vi.useFakeTimers();
      try {
        const areas = Array.from({ length: 60 }, (_, i) => `高知県市町村${i}`);
        const { container, rerender } = render(EmergencyScreen, {
          panels: [
            panel(
              "quake:1",
              quakeInput({
                eventId: "Q-M2",
                maxIntRank: 7,
                intensityGroups: [{ intensity: "6強", rank: 7, areas, omittedAreaCount: 0 }],
              }),
            ),
          ],
        });
        expectCurrentDot(container, 1, 3);

        vi.advanceTimersByTime(PAGE_HOLD_MS * 2);
        settleFade();
        expectCurrentDot(container, 3, 3);

        // 下降 (rank 7→5、同一 eventId): リセットしない
        await rerender({
          panels: [
            panel(
              "quake:1",
              quakeInput({
                eventId: "Q-M2",
                maxIntRank: 5,
                intensityGroups: [{ intensity: "6強", rank: 7, areas, omittedAreaCount: 0 }],
              }),
            ),
          ],
        });
        settleFade();
        expectCurrentDot(container, 3, 3);

        // 同値 (rank 5→5): リセットしない
        await rerender({
          panels: [
            panel(
              "quake:1",
              quakeInput({
                eventId: "Q-M2",
                maxIntRank: 5,
                intensityGroups: [{ intensity: "6強", rank: 7, areas, omittedAreaCount: 0 }],
              }),
            ),
          ],
        });
        settleFade();
        expectCurrentDot(container, 3, 3);

        // 上昇 (rank 5→9、同一 eventId): 先頭ページに戻る
        await rerender({
          panels: [
            panel(
              "quake:1",
              quakeInput({
                eventId: "Q-M2",
                maxIntRank: 9,
                intensityGroups: [{ intensity: "6強", rank: 7, areas, omittedAreaCount: 0 }],
              }),
            ),
          ],
        });
        settleFade();
        expectCurrentDot(container, 1, 3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Codex R レビュー M1: createPageCycler は $effect.root で独立 root を持つため、消費側が
  // destroy() を呼ばないと unmount (main-stack のモード切替・panel 差替え) で timer /
  // matchMedia listener がリークする。page-cycler.svelte.ts 側には「destroy 後はタイマーが
  // 発火しない」の単体テストが既にあるため、消費側はソースの配線だけを検査する
  describe("QuakePanel/TsunamiPanel: page-cycler の onDestroy 配線 (Codex R M1)", () => {
    it("QuakePanel は onDestroy で cycler.destroy() を呼ぶ", () => {
      const src = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(src).toContain('import { onDestroy } from "svelte"');
      expect(src).toContain("onDestroy(() => cycler.destroy())");
    });

    it("TsunamiPanel は onDestroy で pageCycler.destroy() と obsPageCycler.destroy() を呼ぶ", () => {
      const src = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
      expect(src).toContain('import { onDestroy } from "svelte"');
      expect(src).toContain("onDestroy(() => pageCycler.destroy())");
      expect(src).toContain("onDestroy(() => obsPageCycler.destroy())");
    });
  });

  // T5c: ページ行容量の画面高さ駆動化 + 切替フェード (spec §2-c)。jsdom は ResizeObserver 未実装
  // かつ layout 未解決のため実測 px の挙動 (T7 preview 実測対象) はソース文字列で配線を検査する
  describe("QuakePanel T5c 配線 (画面高さ駆動 + フェード)", () => {
    it("ページ本文は measureHeight (面積+代表行) で実測し、cityBudgetFromArea でバジェットを導出する", () => {
      const source = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(source).toContain("cityBudgetFromArea(pageBodyAreaHeight, pageBodyLineHeight, PAGE_CITY_BUDGET)");
      expect(source).toContain("use:measureHeight={applyPageBodyArea}");
      expect(source).toContain("paginateAreas(input.intensityGroups, cityBudget)");
    });

    it("ページ切替は {#key cycler.index} + transition:fade の重ねクロスフェードで、時間/easing は既存の spring-effects-default を流用する (新規定数なし)", () => {
      const source = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(source).toContain("{#key cycler.index}");
      expect(source).toContain('import { fade } from "svelte/transition"');
      // モーション振り付け spec で revealScaleIn/heightReveal 用に SPRING_SPATIAL_DEFAULT_MS も
      // motion から取り込むため、import 行の固定はやめ必要シンボルの取り込みを個別に確認する
      expect(source).toMatch(/import \{[^}]*\bSPRING_EFFECTS_DEFAULT_MS\b[^}]*\bspringEffectsOut\b[^}]*\} from "\.\.\/lib\/motion"/);
      expect(source).toMatch(
        /transition:fade=\{\{\s*duration: cycler\.reducedMotion \? 0 : SPRING_EFFECTS_DEFAULT_MS,\s*easing: springEffectsOut,\s*\}\}/,
      );
    });

    it("旧ページと新ページが重なるよう、.tile-page-detail は position:relative、.page-fade は position:absolute で重ねる", () => {
      const source = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(source).toMatch(/\.tile-page-detail\s*\{[^}]*position: relative;/);
      expect(source).toMatch(/\.page-fade\s*\{[^}]*position: absolute;[^}]*inset: 0;/);
    });

    // T6c ②: 文字がカード縁に密着するバグの修正 (preview 目視指摘)。position:absolute な
    // .page-fade の containing block は最も近い positioned 祖先 (.tile-page-detail) の
    // padding box になり、祖先自身の padding 宣言は絶対配置の子には効かないため、
    // .tile-page-detail の padding (var(--space-4) var(--space-5)) が実質無視されていた。
    // .page-fade 自体に同じトークンで padding を持たせて復元する。pageBodyAreaHeight は
    // .page-body を直接 measureHeight する構造なので、この padding 変更は次回実測で自動的に
    // 反映される (TsunamiPanel の coastRowCapacity のような明示補正定数は不要)
    it(".page-fade には .tile-page-detail と同じ既存 spacing トークンで内側 padding を持たせる (新規直値・opacity 減光は使わない)", () => {
      const source = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(source).toMatch(/\.page-fade\s*\{[^}]*padding: var\(--space-4\) var\(--space-5\);/);
      expect(source).not.toMatch(/\.page-fade\s*\{[^}]*\d+px/);
      expect(source).not.toMatch(/\.page-fade\s*\{[^}]*opacity/);
    });
  });
});
