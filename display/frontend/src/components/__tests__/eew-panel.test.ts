import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import EewPanel from "../EewPanel.svelte";
import type { DisplayEewInputV1, DisplayEewRegionV1 } from "../../lib/protocol";

function region(name: string, over: Partial<DisplayEewRegionV1> = {}): DisplayEewRegionV1 {
  return { name, intensity: "4", intensityTo: null, isPlum: false, hasArrived: false, arrivalTime: null, ...over };
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

describe("EewPanel 固定サマリ計器 (T4a)", () => {
  // T8④ (preview 目視指摘): 値は reportDateTime (当該報の受信時刻) であり「次の続報」
  // ではないため、ラベルを「続報」から「最終更新」に変更した (「最終更新時刻」はタイル幅の
  // 等分割で兄弟ラベル (M/深さ/長周期、1〜3文字) より突出するため4文字に短縮、詳細は
  // EewPanel.svelte のコメント参照)
  it("受信時刻を formatHms で「最終更新」stat タイルとして表示する", () => {
    const { container } = render(EewPanel, { input: eewInput({ reportDateTime: "2026-07-07T09:17:18+09:00" }) });
    expect(screen.getByText("最終更新")).toBeTruthy();
    expect(container.querySelector('.stat-value [data-value="09:17:18"]')).toBeTruthy();
  });

  it("震度別の県数集約行: 単一バケツのみなら最大震度の県数だけ出す (以上行なし)", () => {
    const regions = [region("宮崎県", { intensity: "6弱" }), region("大分県", { intensity: "6弱" })];
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    const items = container.querySelectorAll(".agg-item");
    expect(items.length).toBe(1);
    expect(items[0].textContent).toContain("震度6弱:");
    expect(items[0].querySelector('[data-value="2"]')).toBeTruthy();
  });

  it("震度別の県数集約行: 複数バケツで最大震度県数 + 次ランク以上の累積県数 (top を含む) を出す", () => {
    // ハンドオフ §2-a モック「震度7: 8県  6強以上: 19県」は 6強以上に震度7分を内包した累積読み
    // (19 > 8)。3 番目以下のバケツ (5弱=香川) はこの行の集計に含まない
    const regions = [
      region("高知県", { intensity: "7" }),
      region("徳島県", { intensity: "7" }),
      region("愛媛県", { intensity: "6強" }),
      region("香川県", { intensity: "5弱" }),
    ];
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    const items = container.querySelectorAll(".agg-item");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain("震度7:");
    expect(items[0].querySelector('[data-value="2"]')).toBeTruthy(); // top: 高知/徳島 = 2県
    expect(items[1].textContent).toContain("6強以上:");
    // 累積: 高知/徳島/愛媛 = 3県 (香川=5弱は3番目のバケツなので含まない)
    expect(items[1].querySelector('[data-value="3"]')).toBeTruthy();
  });

  it("PLUM を含む region があれば集約行末に件数付きで出す。なければ出さない", () => {
    const withPlum = [region("宮崎県", { isPlum: true }), region("大分県", { isPlum: false })];
    const { container: withContainer } = render(EewPanel, { input: eewInput({ regions: withPlum }) });
    expect(withContainer.querySelector(".agg-plum")?.textContent).toContain("PLUM含む 1地域");

    const withoutPlum = [region("宮崎県"), region("大分県")];
    const { container: withoutContainer } = render(EewPanel, { input: eewInput({ regions: withoutPlum }) });
    expect(withoutContainer.querySelector(".agg-plum")).toBeFalsy();
  });

  it("regions が空なら集約行自体を出さない", () => {
    const { container } = render(EewPanel, { input: eewInput({ regions: [] }) });
    expect(container.querySelector(".agg-tile")).toBeFalsy();
  });

  it("N<=10 (境界): 静的な震度別リストを render する。到達列・行内 PLUM は出さない", () => {
    const regions = [
      region("地域1", { intensity: "6弱", isPlum: true, hasArrived: true }),
      region("地域2", { intensity: "6弱" }),
      ...Array.from({ length: 8 }, (_, i) => region(`地域${i + 3}`)),
    ];
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    expect(container.querySelectorAll(".region-row").length).toBe(2); // 震度6弱グループ + 震度4グループ の2行
    expect(screen.getByText("地域1 地域2")).toBeTruthy(); // 静的併記
    expect(container.querySelector(".region-arrival")).toBeFalsy();
    expect(container.querySelector(".plum")).toBeFalsy();
  });

  // T8⑥ (preview 目視レビュー): 列数は行数 (震度バケツ数) 駆動にする。emergency-1 相当の
  // 4 バケツ程度では 2 列に割る必要が薄いと判断され、5 バケツ以上でだけ 2 列にする
  // (eew-region-tiers.ts の EEW_REGION_LIST_TWO_COLUMN_MIN_ROWS=5、閾値自体の単体テストは
  // eew-region-tiers.test.ts 側)
  it("震度バケツが4個 (閾値未満) なら .region-list は単列のまま (.two-column が付かない)", () => {
    const regions = ["7", "6強", "6弱", "5強"].map((intensity) => region(`地域-${intensity}`, { intensity }));
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    expect(container.querySelectorAll(".region-row").length).toBe(4);
    expect(container.querySelector(".region-list")?.classList.contains("two-column")).toBe(false);
  });

  it("震度バケツが5個以上 (閾値以上) なら .region-list に .two-column が付く", () => {
    const regions = ["7", "6強", "6弱", "5強", "5弱"].map((intensity) => region(`地域-${intensity}`, { intensity }));
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    expect(container.querySelectorAll(".region-row").length).toBe(5);
    expect(container.querySelector(".region-list")?.classList.contains("two-column")).toBe(true);
  });

  it("バケツ数が5個以上でも compact モードでは class:two-column は付くが、CSS の詳細度で単列に戻る (jsdom はカスケード計算しないためソース文字列で確認)", () => {
    const regions = ["7", "6強", "6弱", "5強", "5弱"].map((intensity) => region(`地域-${intensity}`, { intensity }));
    const { container } = render(EewPanel, { input: eewInput({ regions }), compact: true });
    expect(container.querySelector(".region-list")?.classList.contains("two-column")).toBe(true);
    const source = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    // .eew-panel.compact .region-list (詳細度3) が .region-list.two-column (詳細度2) より
    // 詳細度が高く、two-column が付いていても columns: unset で確実に単列へ戻ることをコメントで
    // 明示している箇所を確認する (実際のカスケード計算は jsdom の範囲外)
    expect(source).toMatch(/\.eew-panel\.compact \.region-list \{\s*columns: unset;/);
  });

  // T8③ (preview 目視指摘、emergency-1 等): 2 カラム時の中央仕切りが --hairline
  // (面分離用の薄い境界線、焼付き最小が本来の用途) では弱すぎたため、既存の可読トークン
  // --role-muted に差し替えた。新規直値色は使わない (jsdom は multi-column layout を
  // レンダリングしないため、ソース文字列で検証する)
  it("静的リストの2カラム中央仕切り (column-rule) は --hairline ではなく既存の可読トークン --role-muted を使う", () => {
    const source = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    expect(source).toMatch(/\.region-list\s*\{[^}]*column-rule: 1px solid var\(--role-muted\);/);
    expect(source).not.toMatch(/\.region-list\s*\{[^}]*column-rule: 1px solid var\(--hairline\);/);
  });

  it("N=11 (境界超): 震度5弱以上の都道府県フラットリストを 1 本で render する。震度別の行分けはしない (spec §2-a 2026-07-09 改訂)", () => {
    const regions = [
      region("高知県高知市", { intensity: "7" }),
      region("高知県室戸市", { intensity: "7" }), // 同一県の別市区町村 → 短縮名は 1 回だけに集約
      region("徳島県徳島市", { intensity: "7" }),
      region("愛知県名古屋市", { intensity: "7" }),
      region("静岡県静岡市", { intensity: "7" }),
      region("三重県津市", { intensity: "7" }),
      region("和歌山県和歌山市", { intensity: "7" }),
      region("宮崎県宮崎市", { intensity: "7" }),
      region("大分県大分市", { intensity: "7" }),
      region("大阪府大阪市", { intensity: "6強" }),
      region("兵庫県神戸市", { intensity: "6強" }),
    ];
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    // 震度別の行分け (region-row) はしない (旧仕様の撤去確認)
    expect(container.querySelector(".region-row")).toBeFalsy();
    // 分類ラベルを行頭に添える
    expect(container.querySelector(".pref-flat-label")?.textContent).toBe("震度5弱以上");
    const names = (container.querySelector(".pref-flat-names")?.textContent ?? "").split(" ").filter(Boolean);
    expect(names).toEqual(["高知", "徳島", "愛知", "静岡", "三重", "和歌山", "宮崎", "大分", "大阪", "兵庫"]); // 短縮名・地域出現順
    expect(names.filter((n) => n === "高知").length).toBe(1); // 同一県は重複しない
  });

  it("短縮名変換: 都/府/県 サフィックスを除去し、北海道はそのまま残す", () => {
    const regions = [
      region("東京都新宿区", { intensity: "6強" }),
      region("大阪府大阪市", { intensity: "6強" }),
      region("京都府京都市", { intensity: "6強" }),
      region("北海道札幌市", { intensity: "6強" }),
      region("静岡県静岡市", { intensity: "6強" }),
      ...Array.from({ length: 6 }, (_, i) => region(`地域${i}`, { intensity: "4" })),
    ];
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    const names = (container.querySelector(".pref-flat-names")?.textContent ?? "").split(" ").filter(Boolean);
    expect(names).toEqual(["東京", "大阪", "京都", "北海道", "静岡"]);
  });

  it("震度5弱未満の region は都道府県フラットリストに出ない", () => {
    const regions = [
      region("静岡県静岡市", { intensity: "6強" }),
      ...Array.from({ length: 10 }, (_, i) => region(`愛知県愛知市${i}`, { intensity: "4" })), // 5弱未満 (震度4)
    ];
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    const names = (container.querySelector(".pref-flat-names")?.textContent ?? "").split(" ").filter(Boolean);
    expect(names).toEqual(["静岡"]); // 震度4の愛知県は含まない
  });

  it("N=45 でも地域名 (市区町村) は出さず、都道府県フラットリストへ抽象化する (重複県は畳む)", () => {
    const prefs = ["北海道", "青森県", "岩手県", "宮城県", "秋田県"];
    const regions = Array.from({ length: 45 }, (_, i) =>
      region(`${prefs[i % prefs.length]}${i}市`, { intensity: i < 30 ? "5弱" : "4" }),
    );
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    const names = (container.querySelector(".pref-flat-names")?.textContent ?? "").split(" ").filter(Boolean);
    expect(names.length).toBe(5); // 5 県への重複除去 (震度4 は5弱未満なので混在しない)
    expect(screen.queryByText(/北海道0市/)).toBeFalsy(); // 地域名 (市区町村) 自体は出ない
  });

  it("閾値超でも震度5弱以上が0件なら都道府県フラットリストを出さず、計器のみで打ち切る", () => {
    const regions = Array.from({ length: 11 }, (_, i) => region(`地域${i}`, { intensity: "4" })); // 全件5弱未満
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    expect(container.querySelector(".tile-regions")).toBeFalsy();
    expect(container.querySelector(".pref-flat-list")).toBeFalsy();
    expect(container.querySelector(".agg-tile")).toBeTruthy(); // 計器は生存
  });

  it("フラット県名リストの文字サイズは県数駆動: 少数 (8県以下) は上限サイズ 32px", () => {
    const regions = [
      region("高知県", { intensity: "7" }),
      region("徳島県", { intensity: "7" }),
      region("愛知県", { intensity: "7" }),
      ...Array.from({ length: 8 }, (_, i) => region(`地域${i}`, { intensity: "4" })), // 計 11 件で >10 を満たす
    ];
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    const names = container.querySelector(".pref-flat-names") as HTMLElement | null;
    expect(names).toBeTruthy();
    expect(names!.getAttribute("style")).toContain("font-size: calc(32px * var(--panel-scale, 1));");
  });

  it("フラット県名リストの文字サイズは県数駆動: 多数 (21県以上) は下限サイズ 19px に段階縮小する", () => {
    const prefs = [
      "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
      "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
      "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
    ]; // 21 県 distinct
    const regions = prefs.map((p) => region(`${p}某市`, { intensity: "6強" }));
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    const names = container.querySelector(".pref-flat-names") as HTMLElement | null;
    expect(names).toBeTruthy();
    expect(names!.getAttribute("style")).toContain("font-size: calc(19px * var(--panel-scale, 1));");
  });

  it("到達時刻情報 (arrivalLabel/region-arrival) を全廃している", () => {
    const regions = Array.from({ length: 5 }, (_, i) => region(`地域${i + 1}`, { hasArrived: true }));
    const { container } = render(EewPanel, { input: eewInput({ regions }) });
    expect(container.querySelector(".region-arrival")).toBeFalsy();
    expect(screen.queryByText("到達")).toBeFalsy();
  });
});
