// 緊急画面の分割レイアウト計算 (純関数)。
// 1件=全面 / 2件以上=主役1枚 (左) + 右スタック (2件目以降、常に compact)。
// 旧 split-2 (2件を左右対称に割る) は廃止し、2件も 3件以上と同じ「主役+右スタック」骨格に統一する
// (枚数増減をグリッド track 補間で滑らかに繋ぐため、横構造を全枚数で共通化する。spec 2026-07-13)。

export type EmergencyLayoutClass = "full" | "main-stack";

export interface EmergencyLayout {
  class: EmergencyLayoutClass;
  main: boolean;
  stackCount: number;
}

export function layoutPanels(count: number): EmergencyLayout {
  if (count >= 2) {
    return { class: "main-stack", main: true, stackCount: count - 1 };
  }
  return { class: "full", main: false, stackCount: 0 };
}
