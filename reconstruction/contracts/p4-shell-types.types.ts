import type { ShellText } from "./p4-display-shell.types";

// P4-SHELL-TYPES-001: 新しい画面（reconstruction/src/display/screen/）の型を、後のカードの契約（C0・E0・C2・S1・M0）が書く分だけ 1 回で広げる。
// p4-display-shell.types.ts の ShellRow・ShellMapPaint がこの型を使う。決まりと「無いと壊れる受け手」は p4-shell-types-tables.md。

// 区域の層。G0 の reconstruction/assets/gis/manifest.json の layers の鍵（形の file の名前）と同じ 9 つ。
// 同じ Code が層をまたいで別の区域を指す（細分区域と津波予報区で 60 個、震度の市区町村と気象の市町村等で 1,707 個）ので、Code は層と組で持つ。
export type ShellAreaLayer = "pref" | "forecastLocalE" | "city" | "tsunamiArea" | "weatherPrefecture" | "weatherPrimary" | "weatherGroup" | "weatherCity" | "floodCity";

// 行の中の字の束（札と札の中の 2 段の字、札の右の行など）。token は字と同じ tokens.ts の固定表で class へ写す。束の中に束を入れない（1 段まで）。
export type ShellGroup = Readonly<{ token: string | null; texts: readonly ShellText[] }>;
// ShellRow.texts の要素。text を持てば字、texts を持てば束（"texts" in で見分ける。ShellText の形は変えない）。
export type ShellPart = ShellText | ShellGroup;
