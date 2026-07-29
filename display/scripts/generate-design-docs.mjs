// FlEq display: デザイントークン一覧 + コントラスト監査表の生成器。
// theme.css を解析し docs/specs/display-design-system.md の GENERATED 区間へ差し込む。
// generate-springs.mjs のマーカー置換を踏襲し、安全契約 (アトミック書き込み) を強化する。
// ロジックは named export、副作用は最下部の CLI ガード内のみ。
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

// ── Task 1: theme.css トークン抽出 + var() 再帰解決 ──

/** :root と main[data-tier] ブロックからトークンを抽出する */
export function parseTokens(css) {
  const entries = [];
  const rootM = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (rootM == null) throw new Error("theme.css に :root ブロックが無い");
  collectDecls(rootM[1], entries, false);
  const tierRe = /main\[data-tier[^{]*\{([\s\S]*?)\n\}/g;
  let tm;
  while ((tm = tierRe.exec(css)) != null) collectDecls(tm[1], entries, true);
  return entries;
}

function collectDecls(body, entries, isTier) {
  let group = isTier ? "tier 上書き" : "(未分類)";
  let pending = "";
  for (const line of body.split("\n")) {
    const sec = line.match(/\/\*\s*──\s*(.+?)\s*──/);
    if (sec != null) { group = sec[1].trim(); pending = ""; continue; }
    let work = line;
    let trailing = "";
    const tc = line.match(/\/\*([\s\S]*?)\*\/\s*$/);
    if (tc != null) { trailing = tc[1].trim(); work = line.slice(0, tc.index); }
    const decls = [...work.matchAll(/(--[\w-]+):\s*([^;]+);/g)];
    if (decls.length === 0) {
      if (tc != null && work.trim() === "") pending = trailing; // 単独コメント行
      continue;
    }
    decls.forEach((d, i) => {
      const comment =
        decls.length === 1 ? (trailing !== "" ? trailing : pending)
        : i === decls.length - 1 ? trailing
        : i === 0 ? pending
        : "";
      entries.push({ name: d[1], group: isTier ? "tier 上書き" : group, raw: d[2].trim(), comment });
    });
    pending = "";
  }
}

/** name→raw の Map。先勝ち (base の :root 値を保持し tier 上書きに勝たせる) */
export function buildTokenMap(entries) {
  const map = new Map();
  for (const e of entries) if (!map.has(e.name)) map.set(e.name, e.raw);
  return map;
}

/** var(--x[, fallback]) を実値まで再帰解決する。未解決・循環は throw */
export function resolveValue(value, map, seen = new Set()) {
  const varRe = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]+(?:\([^()]*\)[^()]*)*))?\)/;
  let v = value;
  let guard = 0;
  while (varRe.test(v)) {
    v = v.replace(varRe, (_, name, fb) => {
      if (map.has(name)) {
        if (seen.has(name)) throw new Error(`var 参照が循環: ${name}`);
        return resolveValue(map.get(name), map, new Set([...seen, name]));
      }
      if (fb != null && fb.trim() !== "") return fb.trim();
      throw new Error(`未解決の var 参照: ${name}`);
    });
    if (++guard > 100) throw new Error(`var 解決が発散: ${value}`);
  }
  return v.trim();
}

// ── Task 2: 色計算 (WCAG 2.1 相対輝度・コントラスト比・srgb 合成) ──

function parseHex(hex) {
  const h = hex.trim().replace(/^#/, "");
  // 全体を検証してから parse (#000000zz の部分解釈を防ぐ。parseInt は途中まで読んでしまう)
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) throw new Error(`解釈不能な色: ${hex}`);
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") + "ff" : h.length === 6 ? h + "ff" : h;
  const n = Number.parseInt(full, 16);
  return { r: (n >>> 24) & 0xff, g: (n >>> 16) & 0xff, b: (n >>> 8) & 0xff, a: (n & 0xff) / 255 };
}

/** トップレベル (括弧外) の sep でのみ分割する */
function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** "C p%" 形式を {color, pct} に。pct は末尾 % のみ対応 (本監査の用法) */
function parseColorArg(arg) {
  const t = arg.trim();
  const m = t.match(/\s(\d+(?:\.\d+)?)%\s*$/);
  if (m != null) return { color: parseColor(t.slice(0, m.index).trim()), pct: Number.parseFloat(m[1]) };
  return { color: parseColor(t), pct: null };
}

function parseColorMix(str) {
  const inner = str.trim().replace(/^color-mix\(\s*in\s+srgb\s*,/i, "").replace(/\)\s*$/, "");
  const parts = splitTopLevel(inner, ",");
  if (parts.length !== 2) throw new Error(`color-mix の引数が 2 でない: ${str}`);
  const [a, b] = parts.map(parseColorArg);
  let wa = a.pct;
  let wb = b.pct;
  if (wa == null && wb == null) { wa = 50; wb = 50; }
  else if (wa == null) wa = 100 - wb;
  else if (wb == null) wb = 100 - wa;
  return srgbMix(a.color, b.color, wa / (wa + wb));
}

/** 解決済み色文字列 → {r,g,b,a}。hex / rgb(a) / color-mix をサポート */
export function parseColor(value) {
  const v = value.trim();
  if (v.startsWith("#")) return parseHex(v);
  if (/^color-mix\(/i.test(v)) return parseColorMix(v);
  const m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m != null) {
    const inner = m[1].trim();
    // legacy の comma 記法と CSS Color 4 の space 記法を分けて扱う。混在を許すと
    // `rgb(1, 2, 3 / .5)` のような不正値を部分解釈してしまうため、どちらか一方に限定する。
    const parts = inner.includes(",")
      ? inner.split(",").map((x) => x.trim())
      : inner.split("/").map((x) => x.trim());
    let channels;
    let alphaPart;
    if (inner.includes(",")) {
      if (inner.includes("/")) throw new Error(`解釈不能な色: ${value}`);
      if (parts.length !== 3 && parts.length !== 4) throw new Error(`解釈不能な色: ${value}`);
      channels = parts.slice(0, 3);
      alphaPart = parts[3];
    } else {
      if (parts.length > 2) throw new Error(`解釈不能な色: ${value}`);
      channels = parts[0].split(/\s+/);
      alphaPart = parts[1];
      if (channels.length !== 3 || (alphaPart != null && alphaPart === "")) throw new Error(`解釈不能な色: ${value}`);
    }
    const [r, g, b] = channels.map(Number);
    const a = alphaPart == null ? 1 : alphaPart.endsWith("%") ? Number(alphaPart.slice(0, -1)) / 100 : Number(alphaPart);
    if (![r, g, b, a].every(Number.isFinite)) throw new Error(`解釈不能な色: ${value}`);
    for (const ch of [r, g, b]) if (ch < 0 || ch > 255) throw new Error(`rgb 範囲外: ${value}`);
    if (a < 0 || a > 1) throw new Error(`alpha 範囲外: ${value}`);
    return { r, g, b, a };
  }
  throw new Error(`解釈不能な色: ${value}`);
}

function toLinear(c8) {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance({ r, g, b }) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** gamma 符号化 srgb の線形混合。w1 = c1 の重み (0-1) */
export function srgbMix(c1, c2, w1) {
  return {
    r: c1.r * w1 + c2.r * (1 - w1),
    g: c1.g * w1 + c2.g * (1 - w1),
    b: c1.b * w1 + c2.b * (1 - w1),
    a: (c1.a == null ? 1 : c1.a) * w1 + (c2.a == null ? 1 : c2.a) * (1 - w1),
  };
}

/** source-over: 上 (top, alpha) を不透明な下地 (bottom) に重ねる */
export function compositeOver(top, alpha, bottom) {
  return {
    r: top.r * alpha + bottom.r * (1 - alpha),
    g: top.g * alpha + bottom.g * (1 - alpha),
    b: top.b * alpha + bottom.b * (1 - alpha),
    a: 1,
  };
}

// ── Task 3: コントラスト監査ペア定義 + 許容リスト ──

const THRESHOLDS = { normal: 4.5, nontext: 3.0 }; // 初版は全テキストを 4.5:1 保守側判定 (large 緩和は未使用)

const INT_TEXT = ["--int-1", "--int-2", "--int-3", "--int-4", "--int-5", "--int-6", "--int-7"];
const SURFACES = ["--bg", "--surface-lowest", "--surface-low", "--surface-container", "--surface-high", "--surface-highest"];
const HEADER_ROLES = [
  "eewWarning", "eewForecast", "quakeCritical", "quakeWarning",
  "tsunamiMajor", "tsunamiWarning", "tsunamiAdvisory",
  "weatherEmergency", "weatherWarning", "weatherAdvisory",
];
const ROLE_TEXT = [
  "critical", "warning", "normal", "info", "cancel",
  "eewWarning", "eewForecast", "tsunamiMajor", "tsunamiWarning", "tsunamiAdvisory",
  "quakeMajor", "weatherEmergency", "weatherWarning", "weatherAdvisory",
  "connectionOk", "connectionStale", "muted",
];
// cat11 (dim×high lane) の母集合。export は design-docs-audit.test.ts の同期テストが
// ADVISORY_ROLES との整合を実配列で検証するため (HIGH_ROLES 変更や CALM_ROLES 変更の drift を検出)
export const HIGH_ROLES = [
  "critical", "warning", "eewWarning", "eewForecast",
  "tsunamiMajor", "tsunamiWarning", "tsunamiAdvisory",
  "weatherEmergency", "weatherWarning", "weatherAdvisory",
  "quakeMajor", // 震度5弱+ は role=quakeMajor, priority=high で実際に high lane を走る (既存監査欠落の補修)
];

// spec D5 可読性フロア: 警報級はテロップ dim の混色除外 (TickerLane.svelte data-alert 契約の写し)。
// フロントの真実源は lib/alert-roles.ts。design-docs-audit.test.ts の同期テストが機械的に突き合わせる
export const ALERT_CHIP_ROLES = new Set([
  "eewWarning", "quakeCritical", "quakeWarning",
  "tsunamiMajor", "tsunamiWarning", "weatherEmergency", "weatherWarning",
]); // HEADER_ROLES のうち警報級 (advisory 系 = eewForecast/tsunamiAdvisory/weatherAdvisory は dim 継続)
export const ALERT_TEXT_ROLES = [
  "critical", "warning", "eewWarning",
  "tsunamiWarning", "quakeMajor", "weatherEmergency", "weatherWarning",
]; // cat14 (通常レーン本文) の警報級 7 role。tsunamiMajor は専用不透明面 (TickerLane:547) のため
//    通常レーン面を背景とするペアが架空になる — cat11 除外 (2026-07-17 6b731a43) と同じ理由で除外
export const ADVISORY_ROLES = new Set(["eewForecast", "tsunamiAdvisory", "weatherAdvisory"]);
// cat11 (dim×high lane) で 35% 混色を継続する advisory 3 role。HIGH_ROLES (tsunamiMajor 除外後)
// のうち isAlertRole=false な role 集合と完全一致すべき値 (design-docs-audit.test.ts の同期テストが検証)

const TSU_KINDS = [
  ["大津波警報", "--role-tsunamiMajor"],
  ["津波警報", "--role-tsunamiWarning"],
  ["津波注意報", "--role-tsunamiAdvisory"],
];

function makePair(id, category, state, fg, bg, thresholdKind, note = "") {
  const ratio = contrastRatio(fg.color, bg.color);
  const threshold = THRESHOLDS[thresholdKind];
  return {
    id, category, state, fg: fg.color, bg: bg.color, fgLabel: fg.label, bgLabel: bg.label,
    ratio, threshold, thresholdKind, pass: ratio >= threshold, note,
  };
}

/** spec §6 の全カテゴリを評価する。id は決定的 (許容リストの pair_ids と対応) */
export function evaluatePairs(map) {
  const color = (name) => parseColor(resolveValue(`var(${name})`, map));
  const bg = color("--bg");
  const c = (name) => ({ label: name, color: color(name) });
  const mixBg = (name, w) => srgbMix(color(name), bg, w);
  const out = [];

  // 1 基本文字色
  for (const fg of ["--fg", "--fg-faint", "--clock-fg"]) {
    out.push(makePair(`base-${fg}`, "1 基本文字色", "base", c(fg), c("--bg"), "normal"));
  }
  // 16 engine 権威の背景トーン。通常前景・role 前景・header on を全 tone 上で監査し、
  // critical TierOverlay は前景と背景の両方へ既存と同じ film 合成を掛ける。
  const backgroundTones = ["calm", "caution", "alert", "critical", "quakeExtreme"];
  // App 直下で tone 背景に載り得る全 role 前景に加え、solid ticker が resolveChipTokens から
  // 選ぶ header on / cancel・neutral role / connectionOk 専用 on を網羅する。
  const toneForegrounds = [
    { token: "--fg", thresholdKind: "normal" },
    ...ROLE_TEXT.map((role) => ({
      token: `--role-${role}`,
      // connectionOk は文字ではなく、意図的に沈めた接続状態ドット。
      thresholdKind: role === "connectionOk" ? "nontext" : "normal",
    })),
    ...HEADER_ROLES.map((role) => ({ token: `--header-${role}-on`, thresholdKind: "normal" })),
    { token: "--c-gray", thresholdKind: "normal" }, // solid connectionOk の実 on 色
  ];
  // critical film との組合せは category 10 が実表示経路別に監査する。ここでは category 16 の
  // 既存契約 (--fg / role-normal / 大津波 solid on) を全 tone で維持する。
  const toneOverlayForegrounds = ["--fg", "--role-normal", "--header-tsunamiMajor-on"];
  const OVERLAY_CRITICAL = { r: 160, g: 48, b: 160, a: 1 };
  for (const tone of backgroundTones) {
    const toneName = `--background-tone-${tone}`;
    const toneColor = color(toneName);
    for (const { token: foreground, thresholdKind } of toneForegrounds) {
      out.push(makePair(
        `tone-${tone}-${foreground}`, "16 背景トーン", "background-tone",
        c(foreground), { label: toneName, color: toneColor }, thresholdKind,
        "App.svelte data-background-tone。通常前景・role 前景・header on の実表示組合せ",
      ));
    }
    for (const foreground of toneOverlayForegrounds) out.push(makePair(
      `tone-overlay-${tone}-${foreground}`, "16 背景トーン", "background-tone+critical",
      { label: `film(${foreground})`, color: compositeOver(OVERLAY_CRITICAL, 0.34, color(foreground)) },
      { label: `film(${toneName})`, color: compositeOver(OVERLAY_CRITICAL, 0.34, toneColor) }, "normal",
      "TierOverlay critical は前景・背景の双方へ合成する。role 別 overlay は category 10 で実経路を監査",
    ));
  }
  // 2 震度 rank 文字色 × (bg + surface 5 段)
  for (const fg of INT_TEXT) {
    for (const s of SURFACES) out.push(makePair(`int-${fg}-on-${s}`, "2 震度rank文字", "base", c(fg), c(s), "normal"));
  }
  // 3 震度 rank 面
  out.push(makePair("int8", "3 震度rank面", "base", c("--int-8-on"), c("--int-8-bg"), "normal"));
  out.push(makePair("int9", "3 震度rank面", "base", c("--int-9-on"), c("--int-9-bg"), "normal"));
  // 4 role 文字色 × (bg + surface-high + surface-panel)
  // --surface-panel は緊急パネルの地。WeatherEmergencyPanel が「面を持つのは詳細一覧だけ」構成へ
  // 変わり (2026-07-26)、role 色と --role-muted をパネル地の上へ直接置くようになったため監査対象に
  // 加えた。現値では --surface-panel が --surface-container / tier で --surface-high を指すので
  // 実質は既存ペアの再掲だが、独立色へ変えたときの回帰をここで拾う
  for (const r of ROLE_TEXT) {
    for (const s of ["--bg", "--surface-high", "--surface-panel"]) out.push(makePair(`role-${r}-on-${s}`, "4 role文字色", "base", c(`--role-${r}`), c(s), "normal"));
  }
  // 5 ヘッダ 3 層 (全 10 ペア)
  for (const r of HEADER_ROLES) out.push(makePair(`hdr-${r}`, "5 ヘッダ3層", "base", c(`--header-${r}-on`), c(`--header-${r}-container`), "normal"));
  // 6 ヘッダ band (非テキスト 3:1)
  for (const r of HEADER_ROLES) {
    out.push(makePair(`band-${r}-container`, "6 ヘッダband", "base", c(`--header-band-${r}`), c(`--header-${r}-container`), "nontext"));
    out.push(makePair(`band-${r}-bg`, "6 ヘッダband", "base", c(`--header-band-${r}`), c("--bg"), "nontext"));
  }
  // 7 津波/JMA テキスト色
  out.push(makePair("tsunami-purple", "7 JMA文字色", "base", c("--c-tsunami-purple"), c("--bg"), "normal"));
  out.push(makePair("jma-red", "7 JMA文字色", "base", c("--c-jma-red"), c("--bg"), "normal"));
  // 8 tier 上書き後 (surface-high/highest)
  for (const fg of ["--fg", "--role-muted"]) {
    for (const s of ["--surface-high", "--surface-highest"]) out.push(makePair(`tier-${fg}-on-${s}`, "8 tier上書き後", "tier", c(fg), c(s), "normal"));
  }
  // 9 dim × ticker チップ (警報級はフロアで素の色、advisory 系のみ 35% 混色継続)
  for (const r of HEADER_ROLES) {
    const keep = ALERT_CHIP_ROLES.has(r); // フロア: 警報級チップは素の色
    const fgc = keep ? color(`--header-${r}-on`) : mixBg(`--header-${r}-on`, 0.35);
    const bgc = keep ? color(`--header-${r}-container`) : mixBg(`--header-${r}-container`, 0.35);
    out.push(makePair(
      `dim-chip-${r}`, "9 dim×tickerチップ", "dim",
      { label: keep ? `floor(--header-${r}-on)` : `dim35(--header-${r}-on)`, color: fgc },
      { label: keep ? `floor(--header-${r}-container)` : `dim35(--header-${r}-container)`, color: bgc },
      "normal", "TickerLane.svelte dim 35% 混色 + data-alert フロア除外",
    ));
  }
  // 10 critical tier overlay 合成 (全画面フィルム。前景・背景の両方に source-over)
  // TierOverlay は position:fixed;inset:0 の全画面フィルムなので文字も背景も覆う。
  // 縁の最大 alpha=0.34 で保守側評価 (中心は 0.1)。前景・背景の両方に film を掛けてから比を取る。
  const film = (name) => compositeOver(OVERLAY_CRITICAL, 0.34, color(name));
  const overlayNote = "TierOverlay.svelte:33-35 critical 全画面フィルム。縁の最大α=0.34 で保守側 (中心0.1)";
  for (const fg of ["--fg", "--role-muted"]) {
    for (const s of ["--surface-high", "--surface-highest", "--surface-panel"]) {
      out.push(makePair(`overlay-${fg}-on-${s}`, "10 critical overlay合成", "tier-overlay",
        { label: `film(${fg})`, color: film(fg) },
        { label: `film(${s})`, color: film(s) }, "normal", overlayNote));
    }
  }
  // 気象の意味色をパネル面の**文字**に使う組合せ。critical フィルム下では AA を割るため
  // WeatherEmergencyPanel は critical tier で主要文字を --fg へ退避する (2026-07-26)。
  // 「使わないから監査しない」ではなく表に残し、許容リストで理由を明示する — UI 側の退避を
  // 外したときに、ここが FAIL として気づける状態を保つため
  for (const r of ["weatherEmergency", "weatherWarning"]) {
    for (const s of ["--surface-high", "--surface-highest", "--surface-panel"]) {
      out.push(makePair(`overlay-role-${r}-on-${s}`, "10 critical overlay合成", "tier-overlay",
        { label: `film(--role-${r})`, color: film(`--role-${r}`) },
        { label: `film(${s})`, color: film(s) }, "normal",
        "critical 中は WeatherEmergencyPanel が主要文字を --fg へ退避する (意味色は帯とレールに残す)"));
    }
  }
  for (const r of HEADER_ROLES) {
    out.push(makePair(`overlay-hdr-${r}`, "10 critical overlay合成", "tier-overlay",
      { label: `film(--header-${r}-on)`, color: film(`--header-${r}-on`) },
      { label: `film(--header-${r}-container)`, color: film(`--header-${r}-container`) }, "normal", overlayNote));
  }
  // 15 気象パネルの装飾 (バッジ輪郭・追加地域の下線)。**非テキスト 3:1** で評価する。
  // バッジは見出し帯の on 色を継承した輪郭 (border: currentColor) なので、帯の container を
  // 背景にとる。下線は role 色で、パネル面 (通常) と critical フィルム合成後の両方を見る。
  // 「使わない」前提に頼らず表へ載せる — UI 側が意味色を文字に流用したら FAIL で気づける (C9)
  for (const r of ["weatherEmergency", "weatherWarning"]) {
    out.push(makePair(
      `weather-badge-${r}`, "15 気象パネル装飾", "base",
      { label: `--header-${r}-on (輪郭)`, color: color(`--header-${r}-on`) },
      c(`--header-${r}-container`), "nontext",
      "WeatherEmergencyPanel .trigger-badge は帯の on 色を継承した輪郭",
    ));
    // 下線が載る面は 2 か所: 詳細一覧 (--surface-panel-raised、tier で --surface-highest) と、
    // 副セクションの種別名 (パネル地 --surface-panel、tier で --surface-high)。
    // **実描画の組合せだけ**を評価する (Codex レビュー 2026-07-27)
    for (const s2 of ["--surface-panel-raised", "--surface-highest", "--surface-panel", "--surface-high"]) {
      out.push(makePair(
        `weather-added-underline-${r}-on${s2}`, "15 気象パネル装飾", "base",
        c(`--role-${r}`), c(s2), "nontext",
        "WeatherEmergencyPanel .area-name.added の下線 (文字色は --fg のまま)",
      ));
      out.push(makePair(
        `weather-added-underline-${r}-on${s2}-overlay`, "15 気象パネル装飾", "tier-overlay",
        { label: `film(--role-${r})`, color: film(`--role-${r}`) },
        { label: `film(${s2})`, color: film(s2) }, "nontext",
        "critical フィルム合成後の下線 (α=0.34 の保守側評価)。L4 の下線 × critical 併発も含む",
      ));
    }
  }

  // 11 dim × high emphasis lane (12% tint → dim 60% の二段)
  // tsunamiMajor は除外: 大津波警報の走行文字は TickerLane.svelte:547-560 の専用規則で
  // dim 時も header container/on ペア (文字自身の不透明面) で on/container 両色を上書きするため、
  // lane 面を文字背景とするこのカテゴリの想定に当てはまらない。実ペアは cat9 (dim-chip) で監査済み。
  // quakeMajor は補修追加: 震度5弱+ は role=quakeMajor, priority=high で実際に high lane を走る。
  // フロア: 警報級は文字が素の色、advisory 系 3 role (eewForecast/tsunamiAdvisory/weatherAdvisory)
  // のみ 35% 混色を継続する。lane 面 (dimLane) は全 role 従来どおり 60% 混色。
  for (const r of HIGH_ROLES.filter((role) => role !== "tsunamiMajor")) {
    const roleColor = color(`--role-${r}`);
    const laneSurface = srgbMix(roleColor, color("--surface-low"), 0.12);
    const dimLane = srgbMix(laneSurface, bg, 0.6);
    const keep = !ADVISORY_ROLES.has(r);
    const dimText = keep ? roleColor : srgbMix(roleColor, bg, 0.35);
    out.push(makePair(
      `dim-high-${r}`, "11 dim×high lane", "dim",
      { label: keep ? `floor(--role-${r})` : `dim35(--role-${r})`, color: dimText },
      { label: `dim60(lane12 ${r})`, color: dimLane },
      "normal", "TickerLane.svelte:583,609 二段合成 + data-alert フロア除外",
    ));
  }
  // 12 津波予報区ページの二段 color-mix (見出し + 本文、津波 3 種)
  for (const [kind, roleVar] of TSU_KINDS) {
    const pageBg = srgbMix(color(roleVar), bg, 0.15);
    const heading = srgbMix(color("--fg"), pageBg, 0.65);
    out.push(makePair(`tsu-heading-${kind}`, "12 津波ページ二段mix", "base",
      { label: "見出し(--fg 65%)", color: heading },
      { label: `page-bg(${kind} 15%)`, color: pageBg }, "normal", "TsunamiPanel.svelte:85,750 見出し"));
    out.push(makePair(`tsu-body-${kind}`, "12 津波ページ二段mix", "base",
      c("--fg"),
      { label: `page-bg(${kind} 15%)`, color: pageBg }, "normal", "TsunamiPanel.svelte:85 本文"));
  }
  // 13 opacity 経路 (EEW serial opacity:0.85)
  const serialFg = { label: "EEW serial on×0.85", color: compositeOver(color("--header-eewWarning-on"), 0.85, color("--header-eewWarning-container")) };
  out.push(makePair("opacity-eew-serial", "13 opacity経路", "opacity", serialFg, c("--header-eewWarning-container"), "normal", "EewPanel.svelte:199 opacity:0.85"));

  // 14 dim × 通常レーン警報本文 (spec D5 必須代表 = weatherWarning mid)。フロアにより文字は素の色、
  // レーン面は dim60(surface-low)。警報級がフロアから漏れて再び暗くなったらここが落ちる番兵。
  // tsunamiMajor は専用不透明面のため対象外 (ALERT_TEXT_ROLES の定義コメント参照)
  const dimNormalLane = srgbMix(color("--surface-low"), bg, 0.6);
  for (const r of ALERT_TEXT_ROLES) {
    out.push(makePair(
      `dim-mid-${r}`, "14 dim×通常レーン警報本文", "dim",
      { label: `floor(--role-${r})`, color: color(`--role-${r}`) },
      { label: "dim60(--surface-low)", color: dimNormalLane },
      "normal", "TickerLane.svelte data-alert フロア (spec D5)",
    ));
  }

  return out;
}

/** 許容リスト。初回仕分けで現状 FAIL を全量、理由付きで記載する (spec §6)。
    エントリ形: { id, pair_ids: string[], reason, applies_when, last_verified_input_hash }
    (tokens/formula は持たない。hash は評価済み合成色から算出するため列挙漏れが起きない)
    以後の「新規」FAIL / STALE だけが auditGate に引っかかる。 */
export const ALLOWLIST = [
  {
    id: "intentional-low-prominence",
    // 意図的低プロミネンス (theme.css「沈んでいてよい」: 接続正常ドット / 空状態)。
    pair_ids: [
      "base---fg-faint",
      "role-connectionOk-on---bg", "role-connectionOk-on---surface-high",
      "role-connectionOk-on---surface-panel",
    ],
    reason: "意図的低プロミネンス (theme.css「沈んでいてよい」: 接続正常ドット/空状態)",
    applies_when: "*",
    // 2026-07-26 再審査: cat4 の面に --surface-panel を追加したことで対象ペアが 1 件増えた
    // (role-connectionOk-on---surface-panel = 3.00:1)。性質は既存の 2 件 (3.27:1 / 2.84:1) と同じ
    // 「沈んでいてよい」接続正常ドットで、判断は変わらないため許容を継続して hash を更新した
    // 2026-07-29: --role-connectionOk を #59636c へ最小リフト。既存の低プロミネンス許容を再検証。
    last_verified_input_hash: "6c83ab4bc2dd",
  },
  {
    id: "critical-overlay-weather-role-not-used-as-text",
    // critical フィルム下で気象の意味色を**文字**に使うと AA を割る (3.21〜4.44:1)。
    // WeatherEmergencyPanel は critical tier で主要文字を --fg へ退避する (6.85〜7.81:1) ので
    // この組合せは実際には描かれない。「使わないから監査しない」ではなく表に残し、UI 側の
    // 退避を外したら FAIL として気づける状態にしておく (2026-07-26 追加)
    pair_ids: [
      "overlay-role-weatherEmergency-on---surface-high",
      "overlay-role-weatherEmergency-on---surface-highest",
      "overlay-role-weatherEmergency-on---surface-panel",
      "overlay-role-weatherWarning-on---surface-high",
      "overlay-role-weatherWarning-on---surface-highest",
      "overlay-role-weatherWarning-on---surface-panel",
    ],
    reason: "critical 中はパネルが主要文字を --fg へ退避するため、この組合せは文字として描かれない (意味色は帯とレールの非テキストに残る)",
    applies_when: "state=tier-overlay",
    last_verified_input_hash: "81629ec83250",
  },
  {
    id: "night-dim-advisory-only",
    pair_ids: [
      "dim-chip-eewForecast", "dim-chip-tsunamiAdvisory", "dim-chip-weatherAdvisory",
      "dim-high-eewForecast", "dim-high-tsunamiAdvisory", "dim-high-weatherAdvisory",
    ],
    reason: "注意報級は夜間減光を優先 (警報級は spec D5 の可読性フロア + 自動サスペンドで救済済み)",
    applies_when: "state=dim",
    last_verified_input_hash: "9a0bf1d5587b",
  },
];

/** 対象 pair_ids の「評価済み合成後 fg/bg 色 (小数4桁丸め RGB)」から決定的な入力 hash を作る。
    トークン値・--bg・混色率・合成式のどれが変わっても合成色が変わるので、入力の列挙漏れなく STALE 失効する */
export function computeInputHash(pairIds, evaluated) {
  const r4 = (n) => Math.round(n * 10000) / 10000;
  const fmt = (c) => `${r4(c.r)},${r4(c.g)},${r4(c.b)}`;
  const parts = pairIds.map((id) => {
    const p = evaluated.find((x) => x.id === id);
    if (p == null) throw new Error(`hash 対象ペアが評価結果に無い: ${id}`);
    return `${id}|${fmt(p.fg)}/${fmt(p.bg)}`;
  });
  return createHash("sha256").update(parts.join(";")).digest("hex").slice(0, 12);
}

/** applies_when を解釈する。"*" または "state=<value>" のみ許容し、それ以外 (typo 等) は throw する
    (寛容フォールバックで「全 state マッチ」に倒すと誤入力を許容漏れとして見逃すため) */
function matchState(appliesWhen, state) {
  if (appliesWhen === "*") return true;
  const m = appliesWhen.match(/^state=(.+)$/);
  if (m == null) throw new Error(`解釈不能な applies_when: ${appliesWhen}`);
  return m[1] === state;
}

/** 評価済みペアに許容リストを適用し status を付与する。hash は評価済み合成色から算出 */
export function applyAllowlist(pairs, allowlist) {
  return pairs.map((p) => {
    if (p.pass) return { ...p, status: "PASS" };
    const allow = allowlist.find((a) => a.pair_ids.includes(p.id) && matchState(a.applies_when, p.state));
    if (allow == null) return { ...p, status: "FAIL" };
    const currentHash = computeInputHash(allow.pair_ids, pairs);
    if (currentHash !== allow.last_verified_input_hash) return { ...p, status: "STALE", allowReason: allow.reason };
    return { ...p, status: "ALLOWED", allowReason: allow.reason };
  });
}

/** status が FAIL または STALE のペア id を返す (許容外の不適合ゲート) */
export function auditGate(audited) {
  return audited.filter((p) => p.status === "FAIL" || p.status === "STALE").map((p) => p.id);
}

/** 許容リストを PASS/FAIL とは独立に、エントリ単位で常時検証する。
    applyAllowlist は PASS ペアで hash 照合を省くため、あるグループの全ペアが一時的に PASS になると
    (色改善) hash 不一致でも STALE を出さず、その後元の色へ戻すと古い hash が再一致して黙って ALLOWED
    に戻ってしまう。これを塞ぐため、各エントリについて次を pass 状態に依らず検証する:
      (a) pair_ids の全 id が評価結果に存在する
      (b) applies_when が pair 群の各 state と整合する
      (c) computeInputHash(pair_ids, evaluated) が last_verified_input_hash と一致する
    契約: docs/specs/display-design-system.md §6「入力 hash が変わったら失効し再判断を強制」。
    違反メッセージ (エントリ id 付き) の配列を返す。空なら健全。 */
export function validateAllowlist(allowlist, evaluated) {
  const violations = [];
  for (const entry of allowlist) {
    const missing = entry.pair_ids.filter((id) => !evaluated.some((p) => p.id === id));
    if (missing.length > 0) {
      // hash 計算が throw するので missing がある間は (b)(c) をスキップする
      violations.push(`ALLOWLIST[${entry.id}]: 評価結果に無い pair_ids: [${missing.join(", ")}]`);
      continue;
    }
    const stateMismatch = entry.pair_ids.filter((id) => {
      const p = evaluated.find((x) => x.id === id);
      return !matchState(entry.applies_when, p.state);
    });
    if (stateMismatch.length > 0) {
      violations.push(`ALLOWLIST[${entry.id}]: applies_when="${entry.applies_when}" と state 不整合: [${stateMismatch.join(", ")}]`);
    }
    const currentHash = computeInputHash(entry.pair_ids, evaluated);
    if (currentHash !== entry.last_verified_input_hash) {
      violations.push(`ALLOWLIST[${entry.id}]: 入力 hash 不一致 (記録 ${entry.last_verified_input_hash}, 実測 ${currentHash})。色を戻したか入力が変わった → 再審査して hash を更新せよ`);
    }
  }
  return violations;
}

// ── Task 4: レンダリング + マーカー置換 + CLI ──

function mdCell(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** spring linear() は点列が長大なので点数表記に省略する */
function abbrev(name, resolved) {
  if (resolved.startsWith("linear(")) return `linear() ${resolved.split(",").length} 点`;
  return resolved;
}

export function renderTokensBlock(resolved) {
  const groups = [];
  const byGroup = new Map();
  for (const t of resolved) {
    if (!byGroup.has(t.group)) { byGroup.set(t.group, []); groups.push(t.group); }
    byGroup.get(t.group).push(t);
  }
  const lines = [];
  for (const g of groups) {
    lines.push(`#### ${g}`, "");
    lines.push("| トークン | 定義 | 実値 | 説明 |", "| --- | --- | --- | --- |");
    for (const t of byGroup.get(g)) {
      lines.push(`| \`${mdCell(t.name)}\` | \`${mdCell(t.raw)}\` | \`${mdCell(abbrev(t.name, t.resolved))}\` | ${mdCell(t.comment)} |`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderContrastBlock(audited) {
  const lines = [];
  lines.push("| id | カテゴリ | state | 前景 | 背景 | 実測比 | 閾値 | 判定 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const p of audited) {
    const verdict =
      p.status === "PASS" ? "PASS"
      : p.status === "FAIL" ? "**FAIL**"
      : p.status === "STALE" ? `**STALE** (${p.allowReason})`
      : `許容 (${p.allowReason})`;
    lines.push(`| ${p.id} | ${p.category} | ${p.state} | \`${mdCell(p.fgLabel)}\` | \`${mdCell(p.bgLabel)}\` | ${p.ratio.toFixed(2)}:1 | ${p.threshold}:1 | ${verdict} |`);
  }
  return lines.join("\n");
}

export function generateBlocks(css) {
  const entries = parseTokens(css);
  const map = buildTokenMap(entries);
  const resolved = entries.map((e) => ({ ...e, resolved: resolveValue(e.raw, map) }));
  const audited = applyAllowlist(evaluatePairs(map), ALLOWLIST);
  return { tokens: renderTokensBlock(resolved), contrast: renderContrastBlock(audited) };
}

export const MARKERS = {
  tokens: {
    start: "<!-- GENERATED:tokens:start (display/scripts/generate-design-docs.mjs --write) -->",
    end: "<!-- GENERATED:tokens:end -->",
  },
  contrast: {
    start: "<!-- GENERATED:contrast:start (display/scripts/generate-design-docs.mjs --write) -->",
    end: "<!-- GENERATED:contrast:end -->",
  },
};

function countOccurrences(s, sub) {
  let n = 0;
  let i = 0;
  while ((i = s.indexOf(sub, i)) !== -1) { n++; i += sub.length; }
  return n;
}

/** 各マーカーがちょうど 1 組であることを検証する。0 / 複数は throw */
export function assertMarkers(md) {
  for (const [key, m] of Object.entries(MARKERS)) {
    const cs = countOccurrences(md, m.start);
    const ce = countOccurrences(md, m.end);
    if (cs !== 1 || ce !== 1) throw new Error(`GENERATED:${key} マーカーがちょうど1組でない (start=${cs}, end=${ce})`);
  }
}

export function extractBlock(md, key) {
  const m = MARKERS[key];
  const start = md.indexOf(m.start);
  const end = md.indexOf(m.end);
  if (start === -1 || end === -1 || end < start) throw new Error(`GENERATED:${key} マーカー不正`);
  return md.slice(start + m.start.length, end).trim();
}

export function replaceBlock(md, key, content) {
  const m = MARKERS[key];
  const start = md.indexOf(m.start);
  const end = md.indexOf(m.end);
  if (start === -1 || end === -1 || end < start) throw new Error(`GENERATED:${key} マーカー不正`);
  return md.slice(0, start + m.start.length) + "\n" + content + "\n" + md.slice(end);
}

export function checkDoc(md, css) {
  assertMarkers(md);
  const blocks = generateBlocks(css);
  const diffs = [];
  for (const key of ["tokens", "contrast"]) {
    if (extractBlock(md, key) !== blocks[key].trim()) diffs.push(key);
  }
  return { ok: diffs.length === 0, diffs };
}

/** write 経路を注入可能にして原子性をテストできるようにする。全検証 (marker・生成・
    replaceBlock) が通ってから writeDoc を 1 回だけ呼ぶ。どこかで throw すれば writeDoc は呼ばれない */
export function runWrite({ readDoc, writeDoc, css }) {
  const md = readDoc();
  assertMarkers(md);                  // ちょうど 1 組でなければ throw
  const blocks = generateBlocks(css); // 抽出・解決・監査が throw すれば書かない
  let next = md;
  next = replaceBlock(next, "tokens", blocks.tokens);   // 逆順マーカーはここで throw
  next = replaceBlock(next, "contrast", blocks.contrast);
  writeDoc(next);                     // 全検証後に 1 回だけ
  return next;
}

// ── CLI: 直接実行時のみ副作用 (import では出さない) ──
// パス解決はガード内でのみ行う (import.meta.url が file: URL でないテスト環境で
// モジュール読み込み自体が壊れるのを防ぐ。generate-springs.mjs の CLI ガードと同じ理由)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const CSS_PATH = fileURLToPath(new URL("../frontend/src/lib/theme.css", import.meta.url));
  const DOC_PATH = fileURLToPath(new URL("../../docs/specs/display-design-system.md", import.meta.url));
  const css = readFileSync(CSS_PATH, "utf-8");
  const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--check") ? "check" : "stdout";
  if (mode === "stdout") {
    const b = generateBlocks(css);
    console.log("=== tokens ===\n" + b.tokens + "\n\n=== contrast ===\n" + b.contrast);
  } else if (mode === "check") {
    const md = readFileSync(DOC_PATH, "utf-8");
    const { ok, diffs } = checkDoc(md, css);
    const map = buildTokenMap(parseTokens(css));
    const evaluated = evaluatePairs(map);
    const gated = auditGate(applyAllowlist(evaluated, ALLOWLIST));
    const allowlistViolations = validateAllowlist(ALLOWLIST, evaluated);
    if (!ok || gated.length > 0 || allowlistViolations.length > 0) {
      if (!ok) console.error(`design-docs 乖離: [${diffs.join(", ")}] が古い。'npm run docs:design' を実行して再生成せよ`);
      if (gated.length > 0) console.error(`許容外の FAIL/STALE: [${gated.join(", ")}]。許容リストへ追記するか色を修正せよ`);
      if (allowlistViolations.length > 0) console.error(`許容リスト検証エラー:\n${allowlistViolations.join("\n")}`);
      process.exit(1);
    }
    console.error("design-docs 同期 OK (FAIL/STALE なし・許容リスト健全)");
  } else {
    runWrite({
      readDoc: () => readFileSync(DOC_PATH, "utf-8"),
      writeDoc: (s) => writeFileSync(DOC_PATH, s),
      css,
    });
    console.error("wrote docs/specs/display-design-system.md GENERATED blocks");
    const gateMap = buildTokenMap(parseTokens(css));
    const gateEvaluated = evaluatePairs(gateMap);
    const gated = auditGate(applyAllowlist(gateEvaluated, ALLOWLIST));
    if (gated.length > 0) console.error(`警告: 許容外の FAIL/STALE が表に残っている: [${gated.join(", ")}]`);
    const allowlistViolations = validateAllowlist(ALLOWLIST, gateEvaluated);
    if (allowlistViolations.length > 0) console.error(`警告: 許容リスト検証エラー:\n${allowlistViolations.join("\n")}`);
  }
}
