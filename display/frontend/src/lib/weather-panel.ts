import {
  displayWeatherPromotionLevel,
  isDisplayWeatherSeverity,
  type DisplayStateSnapshotV1,
  type DisplayWeatherAlertItemV1,
  type DisplayWeatherChangeItemV1,
  type DisplayWeatherChangeKindV1,
  type DisplayWeatherChangeV1,
  type DisplayWeatherPromotionLevelV1,
  type DisplayWeatherSourceV1,
} from "./protocol";
import { SPRING_EFFECTS_DEFAULT_MS } from "./motion";

/** 主役パネルへ載せる 1 行。同じ severity × 現象は source をまたいで統合する (spec §3) */
export interface WeatherPanelItemV1 {
  /** Svelte keyed each 用の安定キー。**種別が増減しても既存行のキーがずれない**よう
   *  severity + 安定現象キーで作る (source・出現位置は使わない、spec 追補 C12) */
  key: string;
  source: DisplayWeatherSourceV1;
  kind: string;
  level: DisplayWeatherPromotionLevelV1;
  shownAreas: string[];
  omittedAreaCount: number;
  /** この点灯で追加された地域 (この行のぶん)。フロントは下線で強調する */
  addedAreas: string[];
}

/**
 * 気象警報の主役パネル入力。engine の昇格状態 (`weatherPromotion`) と気象カード view
 * (`weatherAlerts` / 控え `restoredItems`) から**フロントで合成**する派生値で、wire 型ではない。
 * 期限計算は一切しない — 「非 null source があれば主役」だけを engine から受け取る。
 */
export interface WeatherEmergencyInputV1 {
  kind: "weather";
  /** 主レベル。L5 が 1 source でもあれば 5 */
  level: DisplayWeatherPromotionLevelV1;
  /** 昇格中 source の generation を連結した安定キー。内容が変わると変化する (縮退方向でも上がる) */
  generation: string;
  /** L5 → L4 の順。同レベル内は昇格 source の並び順 → alert 出現順 */
  items: WeatherPanelItemV1[];
  /** 縮退で地域が省略されている (「表示は一部です」の契機) */
  truncated: boolean;
  /** 1 source でも控え (restoredItems) 由来なら true。live 更新前であることを表示する */
  restored: boolean;
  /** この点灯が新規発表か更新発表か。null = 判定材料が無い (旧サーバ・装飾を失った復元) */
  trigger: "new" | "update" | null;
  /** 今回の点灯元 source の更新時刻。装飾元を特定できない旧状態では最新 source を採る */
  updatedAt: string | null;
  /** 点灯の同一性キー。**変わったら再点灯演出を発火する** (spec 追補 C1)。
   *  パネルの key は固定・wire も更新中ずっと非 null なので、これが無いと内容更新で
   *  パネルがマウントされたままになり「切り替えが視線を引く」効果が出ない */
  activationKey: string;
  /** 追加地域を含む行が最初のページに来るよう、その行のキーを持つ (spec 追補 C11) */
  firstPageRowKey: string | null;
  /** 現況とは別の、VPWS50 の短命な続報差分。期限・形状検証済みだけを載せる。 */
  change?: DisplayWeatherChangeV1 | null;
}

const SOURCES: readonly DisplayWeatherSourceV1[] = ["vpws50", "vpww56"];

/** 「どこ」領域の 1 ページに載せる行数の fallback (実測できない環境・初回描画用) */
export const WEATHER_PAGE_ROW_CAPACITY = 4;
/** 1 行に列挙する地域名の上限 (実測できない環境・初回描画用の fallback)。
 *  実運用では領域幅から `weatherRowAreaMax()` が算出する */
export const WEATHER_ROW_AREA_MAX = 12;
/** compact スロット (狭い右列) での地域名上限の fallback */
export const WEATHER_ROW_AREA_MAX_COMPACT = 6;
export const WEATHER_CHANGE_ROW_CAPACITY = 4;
export const WEATHER_CHANGE_ROW_CAPACITY_COMPACT = 2;

export function weatherChangeFadeDuration(reducedMotion: boolean): number {
  return reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS;
}
/** 地域名 1 件が消費する幅の見積り (全角 n 文字ぶん)。「◯◯県」「宮古島地方」等の実データから、
 *  区切りの gap も込みで少し多めに置く — 見積りが過小だと 1 行に詰め込みすぎて折返しが増える */
const AREA_NAME_EM = 6;
/** 地域名に割り当てる行数の上限。これを超える折返しは行高を膨らませてページ効率を落とす */
const AREA_WRAP_LINES = 2;
/** compact での折返し許容行数 (狭い枠では 1 行に抑えて縦を主レベルへ渡す) */
const AREA_WRAP_LINES_COMPACT = 1;

/**
 * 「どこ」1 行に並べる地域名の件数を、**地域列の実測幅**から決める (ユーザー指摘 2026-07-26:
 * 表示領域にゆとりがあるのに固定件数で省略するのはもったいない)。
 *
 * 渡す幅は **`.areas` 列そのもの**の幅であること (Codex R6)。行全体や領域全体の幅を渡すと、
 * 区分列・列間 gap・縦罫と左 padding のぶんを数え込んで件数を過大評価する — 特に compact で
 * 差が大きい。過大評価は折返しを増やして行高を膨らませ、ページ効率を落とす。
 *
 * 幅 / (地域名 1 件の見積り幅) が 1 行あたりの件数で、それを許容折返し行数ぶん取る。
 * 未実測 (null) やフォントサイズが取れないときは fallback を返す。**最低 1 件**は必ず出す。
 */
export function weatherRowAreaMax(
  areaWidthPx: number | null,
  fontSizePx: number | null,
  compact: boolean,
): number {
  const fallback = compact ? WEATHER_ROW_AREA_MAX_COMPACT : WEATHER_ROW_AREA_MAX;
  if (areaWidthPx == null || fontSizePx == null) return fallback;
  if (!(areaWidthPx > 0) || !(fontSizePx > 0)) return fallback;
  const perLine = Math.floor(areaWidthPx / (fontSizePx * AREA_NAME_EM));
  const lines = compact ? AREA_WRAP_LINES_COMPACT : AREA_WRAP_LINES;
  return Math.max(1, perLine * lines);
}

/** 「L5 大雨特別警報」→「大雨特別警報」。緊急パネルは主レベルを見出しで一度示すので、
 *  行ごとの L 接頭辞は情報を足さず、レベル対応/非対応の混在だけが目に付く (ユーザー指摘 2026-07-26)。
 *  電文側の `formatLevelLabel` は変えない — 待機カード・テロップ・CLI は接頭辞つきのまま */
export function stripLevelPrefix(kind: string): string {
  return kind.replace(/^L\d+\s+/, "");
}

/**
 * 緊急気象パネルの色付きヘッダー。主レベルの具体種別を、最大 2 種まで直接示す。
 * 3 種以上は先頭 1 種 +「ほか」へ畳み、種別を安全に抽出できなければ従来名へ戻す。
 */
export function weatherEmergencyHeading(input: WeatherEmergencyInputV1): string {
  const fallback = input.level === 5 ? "気象特別警報" : "気象警報";
  const suffix = input.level === 5 ? "特別警報" : "警報";
  const maxLevelItems = input.items.filter((item) => item.level === input.level);
  const phenomena = maxLevelItems.map((item) =>
    stripLevelPrefix(item.kind)
      .match(/^(.+?)(?:特別警報|危険警報|警戒情報|警報)$/)?.[1]
      ?.trim() ?? "",
  );
  // 最大レベル行を 1 件でも解釈できなければ、既知の行だけを断定表示しない。
  // 未知種別を黙って消すより、汎用名へ安全に倒す。
  if (phenomena.some((name) => name === "")) return fallback;
  const sorted = [...new Set(phenomena)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (sorted.length === 0) return fallback;
  if (sorted.length === 1) return `${sorted[0]}${suffix}`;
  if (sorted.length === 2) return `${sorted.join("・")}${suffix}`;
  return `${sorted[0]}ほか${suffix}`;
}
/** 副セクション (L5 昇格中の L4 相当) に並べる種別の上限。超過は「ほか N 種別」で明示する */
export const WEATHER_SUB_KIND_MAX = 3;
/**
 * 「どこ」領域の 1 ページ行数を実測値から決める。**過積載は必ず切り捨てを生む**ので、迷ったら
 * 少なく見積もる側へ倒す (ページが増えるだけで情報は全部読める)。
 *
 * - `areaPx` / `rowPx` が null = **まだ測っていない** (ResizeObserver 未発火・jsdom)。fallback を返す
 * - 測った結果が使えない値 (行高 0 以下、面積が非有限) = 判定材料が壊れている。fallback で
 *   詰め込まず下限の **1 行**に落ちる — 「未実測だから fallback」と「実測したが使えない」を
 *   同じ扱いにすると、見えない/潰れた領域へ fallback 行数を描いて黙って消すことになる (Codex R4)
 * - それ以外は `area / row` の切り捨て
 *
 * 行間は CSS gap ではなく行自身の padding で持つ (border-box 実測に含まれる) ため、ここでは
 * gap を別途足し引きしない。`rowPx` には**観測した中で最も高い行**を渡すこと — 地域名の折返しで
 * 行高は不揃いになり、先頭行だけを代表値にすると後続の高い行で溢れる。
 */
export function weatherPageCapacity(
  areaPx: number | null,
  rowPx: number | null,
  fallback: number = WEATHER_PAGE_ROW_CAPACITY,
): number {
  if (areaPx == null || rowPx == null) return fallback;
  if (!(rowPx > 0) || !Number.isFinite(areaPx)) return 1;
  // 下限 1: 1 行も入らない高さでも 0 ページ (= 何も描かない) にはしない
  return Math.max(1, Math.floor(areaPx / rowPx));
}

/** 表示用に地域名を上限で畳んだ行。engine 縮退と UI 上限を同じ「ほか N 地域」へ合流させる */
export interface WeatherPanelRowV1 extends WeatherPanelItemV1 {
  /** 実際に描く地域名 */
  areas: string[];
  /** 「ほか N 地域」の N。engine の omittedAreaCount + UI 上限で落ちた件数 */
  hiddenAreaCount: number;
}

/**
 * 1 行の地域名を `maxAreas` 件までに畳む。落とした件数は engine 側の `omittedAreaCount` と
 * 合算して 1 つの「ほか N 地域」にする — 出所の違う省略を 2 か所に分けて出しても読み手には
 * 区別できず、**どちらも「まだ他にある」という同じ意味**だから。件数を黙って減らさないことだけを守る。
 */
export function capRowAreas(item: WeatherPanelItemV1, maxAreas: number): WeatherPanelRowV1 {
  const limit = maxAreas > 0 ? maxAreas : 1;
  // **この点灯で追加された地域は優先して残す** (Codex レビュー 2026-07-27)。素朴な先頭
  // slice だと、狭い枠 (compact は 6 件) で追加地域が後方にあると真っ先に落ちて
  // ハイライトが空振りする。engine 側の縮退保護と同じ考え方をフロントの上限にも掛ける
  const added = new Set(item.addedAreas);
  const indexed = item.shownAreas.map((area, index) => ({ area, index }));
  const kept = added.size === 0
    ? indexed.slice(0, limit)
    : [
      ...indexed.filter(({ area }) => added.has(area)),
      ...indexed.filter(({ area }) => !added.has(area)),
    ].slice(0, limit);
  // wire は名称のみだが、1 要素は engine 投影元の 1 areaCode に対応する。同名・別 code を
  // 名称 Set で再展開せず、位置 identity で元順へ戻して件数を保つ。
  const keptIndices = new Set(kept.map(({ index }) => index));
  const areas = indexed.filter(({ index }) => keptIndices.has(index)).map(({ area }) => area);
  const droppedByUi = Math.max(0, item.shownAreas.length - areas.length);
  return { ...item, areas, hiddenAreaCount: item.omittedAreaCount + droppedByUi };
}

/**
 * 副セクション (L5 昇格中の L4 相当) に出す種別を選ぶ。
 *
 * **副セクションは地域名を持たない要約**にする (ユーザー決定 2026-07-26)。地域行を並べると
 * 折返しで高さが青天井になり、ページ送りを持たない固定領域では溢れが黙って切られる — 件数の
 * 上限は高さの上限ではない (Codex R5)。種別名だけなら高さが予測でき、L4 が「何が出ているか」は
 * 残る。地域まで要る場面は主レベル (「どこ」) が担う。
 *
 * 上限は **distinct な種別数**で数える (Codex R3): 同じ種別が VPWS50 と VPWW56 の両方から
 * 来ることがあり、行数で数えると「既出の警報名しか隠していないのに『ほか 1 種別』」になる。
 */
export function selectSubKinds(
  items: readonly WeatherPanelItemV1[],
  maxKinds: number,
): { kinds: string[]; hiddenKindCount: number } {
  const limit = maxKinds > 0 ? maxKinds : 1;
  const shown: string[] = [];
  const hidden = new Set<string>();
  for (const item of items) {
    if (shown.includes(item.kind) || hidden.has(item.kind)) continue;
    if (shown.length >= limit) {
      hidden.add(item.kind);
      continue;
    }
    shown.push(item.kind);
  }
  return { kinds: shown, hiddenKindCount: hidden.size };
}

const WEATHER_CHANGE_KIND_ORDER: readonly DisplayWeatherChangeKindV1[] = [
  "upgraded",
  "added",
  "kindChanged",
  "downgraded",
  "released",
];

function isDisplayableWeatherChange(item: DisplayWeatherChangeItemV1): boolean {
  return item.kind !== "kindChanged"
    || (
      item.before?.kindShortName != null
      && item.after?.kindShortName != null
      && item.before.kindShortName !== item.after.kindShortName
    );
}

export interface WeatherChangeSelectionV1 {
  items: DisplayWeatherChangeItemV1[];
  totals: Record<DisplayWeatherChangeKindV1, number>;
  displayed: Record<DisplayWeatherChangeKindV1, number>;
}

/** wire と UI の双方の縮退で、カテゴリ代表枠を予約して内容の消失を明示する。 */
export function selectWeatherChangeItems(
  change: DisplayWeatherChangeV1 | null | undefined,
  max: number,
): WeatherChangeSelectionV1 {
  const empty = {
    items: [],
    totals: { added: 0, released: 0, upgraded: 0, downgraded: 0, kindChanged: 0 },
    displayed: { added: 0, released: 0, upgraded: 0, downgraded: 0, kindChanged: 0 },
  } satisfies WeatherChangeSelectionV1;
  if (change == null) return empty;
  const visible = change.changes.filter(isDisplayableWeatherChange);
  const byKind = new Map<DisplayWeatherChangeKindV1, DisplayWeatherChangeItemV1[]>();
  for (const kind of WEATHER_CHANGE_KIND_ORDER) byKind.set(kind, []);
  for (const item of visible) byKind.get(item.kind)?.push(item);
  const totals = { ...empty.totals };
  for (const kind of WEATHER_CHANGE_KIND_ORDER) {
    totals[kind] = (byKind.get(kind)?.length ?? 0) + (change.omitted[kind] ?? 0);
  }
  const presentKinds = WEATHER_CHANGE_KIND_ORDER.filter((kind) => totals[kind] > 0);
  const limit = Math.max(0, Math.floor(max));
  const reservedKinds = limit >= presentKinds.length
    ? presentKinds
    : limit >= 2
      && presentKinds.length >= 3
      && totals.upgraded > 0
      && totals.released > 0
      ? ["upgraded", "released"] as const
      : presentKinds.slice(0, limit);
  const selected = new Set<DisplayWeatherChangeItemV1>();
  for (const kind of reservedKinds) {
    const item = byKind.get(kind)?.[0];
    if (item != null) selected.add(item);
  }
  for (const kind of WEATHER_CHANGE_KIND_ORDER) {
    for (const item of byKind.get(kind) ?? []) {
      if (selected.size >= limit) break;
      selected.add(item);
    }
    if (selected.size >= limit) break;
  }
  const items = visible.filter((item) => selected.has(item));
  const displayed = { ...empty.displayed };
  for (const item of items) displayed[item.kind] += 1;
  return { items, totals, displayed };
}

export function weatherChangeValueLabel(
  value: DisplayWeatherChangeItemV1["before"],
): string {
  if (value == null) return "—";
  if (value.officialAlertLevel != null) return `L${value.officialAlertLevel} ${value.kindShortName}`;
  const prefix = value.displaySeverity === "nonLevelSpecial"
    ? "特別警報"
    : value.displaySeverity === "nonLevelWarning"
      ? "警報"
      : value.displaySeverity === "nonLevelAdvisory"
        ? "注意報"
        : "";
  return prefix === "" ? value.kindShortName : `${prefix} ${value.kindShortName}`;
}

export function weatherChangeRowText(item: DisplayWeatherChangeItemV1): string {
  const before = weatherChangeValueLabel(item.before);
  const after = weatherChangeValueLabel(item.after);
  if (item.kind === "added") return `${item.areaName} — 追加: ${after}`;
  if (item.kind === "released") return `${item.areaName} — 解除: ${before}`;
  return `${item.areaName} — 種別: ${before} → ${after}`;
}

/** wire 縮退・normal/compact の UI 縮退で落ちた件数をカテゴリ別に明示する。 */
export function weatherChangeSummary(selection: WeatherChangeSelectionV1): string {
  const labels: Record<DisplayWeatherChangeKindV1, string> = {
    upgraded: "悪化",
    added: "追加",
    kindChanged: "種別変更",
    downgraded: "緩和",
    released: "解除",
  };
  const omitted = WEATHER_CHANGE_KIND_ORDER
    .filter((kind) => selection.totals[kind] > selection.displayed[kind])
    .map((kind) => `${labels[kind]} ${selection.totals[kind]}件（表示 ${selection.displayed[kind]}件）`);
  return omitted.length > 0
    ? omitted.join("・")
    : `変更 ${selection.items.length}件`;
}

function isWeatherChangeKind(value: unknown): value is DisplayWeatherChangeKindV1 {
  return value === "added"
    || value === "released"
    || value === "upgraded"
    || value === "downgraded"
    || value === "kindChanged";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseFiniteTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateWeatherChangeValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.kindShortName === "string"
    && typeof value.kindCode === "string"
    && typeof value.displaySeverity === "string"
    && (value.officialAlertLevel == null
      || (typeof value.officialAlertLevel === "number"
        && Number.isFinite(value.officialAlertLevel)
        && Number.isInteger(value.officialAlertLevel)
        && value.officialAlertLevel >= 1
        && value.officialAlertLevel <= 5));
}

/** 旧 server の欠落・不正時刻・未来へ飛んだ DTO は安全側に非表示にする。 */
export function validateWeatherChange(
  snapshot: DisplayStateSnapshotV1,
  nowMs: number,
): DisplayWeatherChangeV1 | null {
  const raw = snapshot.weatherChange;
  if (!isRecord(raw) || raw.source !== "vpws50") return null;
  const generatedAtMs = parseFiniteTime(snapshot.generatedAt);
  const issuedAtMs = parseFiniteTime(raw.issuedAt);
  const expiresAtMs = parseFiniteTime(raw.expiresAt);
  if (generatedAtMs == null || issuedAtMs == null || expiresAtMs == null || !Number.isFinite(nowMs)) return null;
  if (
    expiresAtMs - issuedAtMs !== 60_000
    || !(generatedAtMs - 60_000 < issuedAtMs)
    || issuedAtMs > generatedAtMs + 5_000
    || !(generatedAtMs < expiresAtMs)
    || expiresAtMs > generatedAtMs + 65_000
    || expiresAtMs <= nowMs
    || typeof raw.changeKey !== "string"
    || raw.changeKey.length === 0
    || typeof raw.reportDateTime !== "string"
    || !Array.isArray(raw.changes)
    || !isRecord(raw.omitted)
  ) return null;
  const changes: DisplayWeatherChangeItemV1[] = [];
  const identities = new Set<string>();
  for (const item of raw.changes) {
    if (
      !isRecord(item)
      || typeof item.areaCode !== "string"
      || typeof item.areaName !== "string"
      || typeof item.phenomenonKey !== "string"
      || !isWeatherChangeKind(item.kind)
      || !("before" in item)
      || !("after" in item)
      || !(item.before === null || validateWeatherChangeValue(item.before))
      || !(item.after === null || validateWeatherChangeValue(item.after))
    ) return null;
    const beforePresent = item.before != null;
    const afterPresent = item.after != null;
    if (
      (item.kind === "added" && (beforePresent || !afterPresent))
      || (item.kind === "released" && (!beforePresent || afterPresent))
      || (
        item.kind !== "added"
        && item.kind !== "released"
        && (!beforePresent || !afterPresent)
      )
    ) return null;
    const identity = `${item.areaCode}\u0000${item.phenomenonKey}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
    changes.push(item as unknown as DisplayWeatherChangeItemV1);
  }
  const omitted: DisplayWeatherChangeV1["omitted"] = {};
  for (const kind of WEATHER_CHANGE_KIND_ORDER) {
    const value = raw.omitted[kind];
    if (value == null) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
    if (value > 0) omitted[kind] = value;
  }
  const validated: DisplayWeatherChangeV1 = {
    source: "vpws50",
    changeKey: raw.changeKey,
    reportDateTime: raw.reportDateTime,
    issuedAt: raw.issuedAt as string,
    expiresAt: raw.expiresAt as string,
    changes,
    omitted,
  };
  return selectWeatherChangeItems(validated, Number.MAX_SAFE_INTEGER).items.length > 0
    ? validated
    : null;
}

/**
 * 行をページへ等分割する。`capacity` は実測駆動なので 0 以下や NaN が来うる — その場合は
 * 1 行ずつに割って**必ず全行が到達可能**にする (画面外へ押し出して黙って消さない)。
 */
export function paginateWeatherRows<T>(rows: readonly T[], capacity: number): T[][] {
  if (rows.length === 0) return [];
  const size = Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : 1;
  const pages: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    pages.push(rows.slice(i, i + size));
  }
  return pages;
}

/** 昇格対象 (L4/L5 相当) の item だけを拾う。未知 severity は昇格に使わない (engine と同判定) */
function promotionLevelOf(item: DisplayWeatherAlertItemV1): DisplayWeatherPromotionLevelV1 | null {
  if (!isDisplayWeatherSeverity(item.displaySeverity)) return null;
  return displayWeatherPromotionLevel(item.displaySeverity);
}

/**
 * snapshot から主役パネル 1 枚分の入力を合成する。null = 気象パネルを出さない。
 *
 * 中身の権威は **live な `weatherAlerts` に当該 source があればそれ**、無ければ昇格根拠の控え
 * (`weatherPromotion.<source>.restoredItems`)。控えは engine 側で「live に当該 source が無く、
 * かつ空でないとき」だけ wire に載る (`docs/specs/engine.md` の昇格根拠の控え節)。
 */
export function buildWeatherEmergencyInput(
  snapshot: DisplayStateSnapshotV1,
  nowMs: number,
): WeatherEmergencyInputV1 | null {
  const promotion = snapshot.weatherPromotion;
  if (promotion == null) return null;

  const items: WeatherPanelItemV1[] = [];
  const itemsByPhenomenon = new Map<string, WeatherPanelItemV1>();
  const candidates: Array<{
    source: DisplayWeatherSourceV1;
    item: DisplayWeatherAlertItemV1;
    level: DisplayWeatherPromotionLevelV1;
    addedAreas: string[];
  }> = [];
  const generations: string[] = [];
  const promotedLevels: DisplayWeatherPromotionLevelV1[] = [];
  let restored = false;
  let updatedAt: string | null = null;
  let hasVpws50Contribution = false;

  // パネル全体の点灯キー (engine の watermark)。欠落 (旧サーバ) は演出も装飾も出さない
  const panelActivationKey = promotion.activationKey ?? "";
  // **装飾 (バッジ・追加地域ハイライト) を出せるのは、今回の点灯を起こした source だけ**。
  // engine は source ごとに点灯通し番号 (`entry.activationKey`) を振り、パネル全体の watermark は
  // 最後の点灯の番号になるので、両者が一致する entry が「いま光っている理由」そのもの。
  // 全 source から寄せ集めると、(a) 後から別 source が点いたときに古い追加地域が強調され続け、
  // (b) 最新 source が降格しただけで古いバッジが復活する (Codex レビュー 4 巡目 2026-07-27)
  const decorSource =
    panelActivationKey === ""
      ? null
      : (SOURCES.find((s) => promotion[s]?.activationKey === panelActivationKey) ?? null);
  let trigger: "new" | "update" | null = null;

  for (const source of SOURCES) {
    const entry = promotion[source];
    if (entry == null) continue; // demoted は wire 上 null。期限計算はしない
    generations.push(`${source}:${entry.generation}`);
    promotedLevels.push(entry.level);
    // バッジは点灯を起こした source のものだけを出す (spec 追補 C10)。
    // **再点灯の契機はここでは決めない** — パネル全体の activationKey (engine の watermark) を使う。
    // source 別キーの最大値を採ると、最後に点いた source が降格しただけで値が巻き戻って
    // 再点灯してしまう (Codex レビュー 2026-07-27)
    const decorated = source === decorSource;
    if (decorated) trigger = entry.trigger ?? null;

    const liveAlerts = snapshot.weatherAlerts.filter((a) => a.source === source);
    const sourceUpdatedAt = liveAlerts[0]?.updatedAt ?? entry.promotedAt;
    if (
      decorated
      || (decorSource == null
        && (updatedAt == null || Date.parse(sourceUpdatedAt) > Date.parse(updatedAt)))
    ) {
      updatedAt = sourceUpdatedAt;
    }
    const sourceItems =
      liveAlerts.length > 0
        ? liveAlerts.flatMap((a) => a.items)
        : (entry.restoredItems ?? []);
    if (source === "vpws50" && (liveAlerts.length > 0 || sourceItems.length > 0)) {
      hasVpws50Contribution = true;
    }
    if (liveAlerts.length === 0 && sourceItems.length > 0) restored = true;
    // 追加地域は種別ごとに届く。**source を含めて照合する** — 別 source の同名地域を
    // 取り違えないため (spec 追補 C10)。今回の点灯を起こしていない source の追加地域は
    // 前の点灯の残りなので載せない (持ち越し防止)
    const addedByKind = new Map<string, Set<string>>();
    if (decorated) {
      for (const a of entry.addedAreas ?? []) addedByKind.set(a.kind, new Set(a.areas));
    }

    for (const item of sourceItems) {
      const level = promotionLevelOf(item);
      if (level == null) continue;
      const added = addedByKind.get(item.kind);
      const addedAreas = added == null ? [] : item.shownAreas.filter((a) => added.has(a));
      candidates.push({ source, item, level, addedAreas });
    }
  }

  // phenomenonKey の有無が混在しても同じ現象を統合するため、先に表示名 alias ごとの
  // 安定キー候補を集める。候補が 1 つだけなら旧 item もそのキーへ寄せる。複数候補がある
  // 曖昧な alias は無理に統合せず、別現象の誤結合を避ける
  const phenomenonKeysByKind = new Map<string, Set<string>>();
  for (const { item } of candidates) {
    if (item.phenomenonKey == null) continue;
    const kindKey = `${item.displaySeverity}|${item.kind}`;
    const keys = phenomenonKeysByKind.get(kindKey) ?? new Set<string>();
    keys.add(`${item.displaySeverity}|${item.phenomenonKey}`);
    phenomenonKeysByKind.set(kindKey, keys);
  }

  for (const { source, item, level, addedAreas } of candidates) {
    const kindKey = `${item.displaySeverity}|${item.kind}`;
    const aliasKeys = phenomenonKeysByKind.get(kindKey);
    const rowKey = item.phenomenonKey != null
      ? `${item.displaySeverity}|${item.phenomenonKey}`
      : aliasKeys?.size === 1
        ? [...aliasKeys][0]!
        : kindKey;
    const existing = itemsByPhenomenon.get(rowKey);
    if (existing != null) {
      for (const area of item.shownAreas) {
        if (!existing.shownAreas.includes(area)) existing.shownAreas.push(area);
      }
      for (const area of addedAreas) {
        if (!existing.addedAreas.includes(area)) existing.addedAreas.push(area);
      }
      existing.omittedAreaCount += item.omittedAreaCount;
      continue;
    }
    const row: WeatherPanelItemV1 = {
      key: rowKey,
      source,
      kind: item.kind,
      level,
      shownAreas: [...item.shownAreas],
      omittedAreaCount: item.omittedAreaCount,
      addedAreas,
    };
    itemsByPhenomenon.set(rowKey, row);
    items.push(row);
  }

  // 昇格中の source が 1 つも無ければパネルを出さない。**逆に、非 null source があるなら
  // 中身が組めなくてもパネルは出す** — 昇格状態の権威は engine で、フロントが「描く item が無い」
  // を理由に主役表示を畳むのはフロント独自の降格になる (spec §3「非 null source があれば
  // 気象パネルを全体で 1 枚合成」、Codex R5)。中身が無い状態はパネル側が同期中として描く
  if (promotedLevels.length === 0) return null;

  items.sort((a, b) => b.level - a.level); // 安定ソート: 同レベルは source 順 → 出現順のまま
  const panelLevel = Math.max(...promotedLevels) as DisplayWeatherPromotionLevelV1;
  const change = hasVpws50Contribution ? validateWeatherChange(snapshot, nowMs) : null;
  return {
    kind: "weather",
    // 主レベルは **engine の昇格レベル**を採る (item 側から推定しない)。中身がまだ組めていない
    // 状態でも「警戒レベル N 相当」を正しく出せる
    level: panelLevel,
    generation: generations.join("|"),
    items,
    truncated: items.some((i) => i.omittedAreaCount > 0),
    restored,
    trigger,
    updatedAt,
    // パネル全体の点灯キー。**engine の watermark をそのまま使う** (欠落なら演出なしの固定値)
    activationKey: panelActivationKey,
    // 追加地域を含む行を最初のページへ (spec 追補 C11)。主レベルの行を優先し、無ければ
    // 下位レベルの追加行を指す — 下位でも**追加を含む行はページ送り列に載る**ので
    // (`selectPagedItems`)、指し先が見つからない空振りにはならない (ご主人決定 2026-07-27)
    firstPageRowKey:
      items.find((i) => i.level === panelLevel && i.addedAreas.length > 0)?.key
      ?? items.find((i) => i.addedAreas.length > 0)?.key
      ?? null,
    change,
  };
}

/**
 * ページ送り列 (「どこ」領域) に載せる行を選ぶ。
 *
 * 主レベルの行はすべて + **下位レベルのうち「この点灯で地域が増えた行」だけ** (ご主人決定
 * 2026-07-27)。「L5 継続中に L4 の地域が増えた」で更新点灯するのに、下位レベルが種別名 +
 * 件数へ畳まれていると**どこが増えたのかが一度も読めない**。追加が起きた行だけを例外として
 * 地域名つきで巡回に参加させ、追加を含まない下位行は従来どおり副セクションの要約に残す
 * (「compact では名前列を出さない」既決定はそのまま生きている)。
 */
export function selectPagedItems(
  items: readonly WeatherPanelItemV1[],
  panelLevel: DisplayWeatherPromotionLevelV1,
): WeatherPanelItemV1[] {
  return items.filter((i) => i.level === panelLevel || i.addedAreas.length > 0);
}

/**
 * この測定を受理してよいか (spec 追補 C1 の再点灯演出に伴う汚染防止)。
 *
 * crossfade 中は旧・新の DOM が同じ grid セルに共存し、**`pointer-events: none` では
 * ResizeObserver は止まらない**。退場中の旧レイアウトの高さが最後に届くと、それが現行ページの
 * 容量計算に残って行数を誤る。測定 callback は DOM が作られた時点の点灯キー (`token`) を持ち、
 * 現在の `activationKey` と一致する DOM の測定だけを受理する。
 * レイアウト整定中 (`layoutSettling`) の過渡値を採らない従来の条件もここに畳む。
 */
export function acceptsMeasurement(
  token: string,
  activationKey: string,
  layoutSettling: boolean,
): boolean {
  return !layoutSettling && token === activationKey;
}
