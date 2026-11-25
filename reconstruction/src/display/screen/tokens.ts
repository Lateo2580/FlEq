// P4-DISPLAY-SHELL-001（S0）配置と色の宣言値。px と色はここだけに書く（P4-DS-AC04）。
// layout.ts・frame.ts・main.ts はここから読み、main.ts が起動の時に 1 回だけ CSS の変数へ入れる（P4-DS-AC01 (5)）。
// 値の出どころは表 p4-display-shell-tables.md の §1。

const LAYOUT = {
  screen: { w: 1920, h: 1080 },
  edge: 40,
  gap: 17,
  left: { x: 40, w: 540, top: 40, usable: 903 },
  right: { x: 1340, w: 540, top: 40, h: 1000 },
  clock: { w: 540, h: 80, x: 40, y: 960, sixX: 620 },
  status: { centerX: 960, top: 40 },
  // ページの表示の行（右の列はこの 2 つの和をそのカードの高さに数える。表 §4.4 の c）
  pageMarkRow: 37.5,
  pageMarkGap: 8,
  dots: { on: 16, off: 12, line: 2, gap: 12 },
  shift: 96,
  // 暗くする値は案（P4-DS-AC04 (2)、DS-OPEN-62 は C0 で決める）。明るさを下げ、面は不透明のまま
  dim: 0.6,
  eew: { one: { h: 1000 }, two: { h: 492, gap: 16 }, small: { h: 322, tops: [40, 379, 718] } },
  card: { border: 2, radius: 4, text: 30, headText: 40, divider: 2 },
  // DS の間の値（DS-SIZE-10〜12）。行の左右の内側 s5、見出しの行の間 s4、行の区切りの下の内側 s3、状態の札の内側 s3
  space: { s3: 12, s4: 16, s5: 24 },
  clockText: { date: 30, time: 56, gap: 18, padTop: 6 },
} as const;

const COLORS = {
  "ground-sea": "#0c1028", land: "#313133", line: "#b0b8bf", surface: "#141723", "surface-edge": "#3d414f", divider: "#313133",
  ink: "#e8ecef", "ink-muted": "#aab3bb", "ink-dark": "#000000", "ink-clock": "#c9ced3",
  lv5: "#0c000c", lv4: "#aa00aa", lv3: "#ff2800", lv2: "#f2e700",
  "int-7": "#b40068", "int-7-edge": "#ffe600", "int-6p": "#a50021", "int-6m": "#ff2800", "int-5p": "#ff9900", "int-5m": "#ffe600",
  "int-4": "#fae696", "int-3": "#0041ff", "int-2": "#00aaff", "int-1": "#f2f2ff",
  "tsunami-major": "#c800ff", "tsunami-warning": "#ff2800", "tsunami-advisory": "#faf500",
  epicenter: "#ff1744", cancel: "#cc79a7",
  "eq-a": "#ffffff", "eq-b": "#2ec4b6", "eq-c": "#ff9ad5", "eq-d": "#a4e057", "eq-e": "#a698ff", "eq-f": "#c08a5a",
  alert: "#ff2800", "eew-forecast": "#d9b400",
} as const;

// ShellText の token から class への固定表。表に無い token には class を付けない（P2-A9-AC08、P4-DS-AC09 (1)）。
// 各カードの契約が自分の token をここへ足す。S0 は DS-CSS-02 のカードの枠が使う 6 つだけ。
const TOKEN_CLASS: Readonly<Record<string, string>> = {
  ink: "t-ink", "ink-muted": "t-ink-muted",
  // 見出しの行・行の区切り（行の class）と、見出しの字・補足の字（DS-CSS-02、AC13 (3)）
  "row-head": "r-head", "row-divider": "r-divider", "text-head": "t-head", "text-sub": "t-sub",
};

export { COLORS, LAYOUT, TOKEN_CLASS };
