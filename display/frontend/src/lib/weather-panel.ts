import {
  displayWeatherPromotionLevel,
  isDisplayWeatherSeverity,
  type DisplayStateSnapshotV1,
  type DisplayWeatherAlertItemV1,
  type DisplayWeatherPromotionLevelV1,
  type DisplayWeatherSourceV1,
} from "./protocol";

/** 主役パネルへ載せる 1 行 (source × kind)。source 間の統合・地域数合算はしない (spec §3) */
export interface WeatherPanelItemV1 {
  /** Svelte keyed each 用の安定キー。source + 出現位置 + kind で一意 */
  key: string;
  source: DisplayWeatherSourceV1;
  kind: string;
  level: DisplayWeatherPromotionLevelV1;
  shownAreas: string[];
  omittedAreaCount: number;
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
}

const SOURCES: readonly DisplayWeatherSourceV1[] = ["vpws50", "vpww56"];

/** 「どこ」領域の 1 ページに載せる行数の fallback (実測できない環境・初回描画用) */
export const WEATHER_PAGE_ROW_CAPACITY = 4;
/** 1 行に列挙する地域名の上限 (実測できない環境・初回描画用の fallback)。
 *  実運用では領域幅から `weatherRowAreaMax()` が算出する */
export const WEATHER_ROW_AREA_MAX = 12;
/** compact スロット (狭い右列) での地域名上限の fallback */
export const WEATHER_ROW_AREA_MAX_COMPACT = 6;
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
  const areas = item.shownAreas.slice(0, limit);
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
): WeatherEmergencyInputV1 | null {
  const promotion = snapshot.weatherPromotion;
  if (promotion == null) return null;

  const items: WeatherPanelItemV1[] = [];
  const generations: string[] = [];
  const promotedLevels: DisplayWeatherPromotionLevelV1[] = [];
  let restored = false;

  for (const source of SOURCES) {
    const entry = promotion[source];
    if (entry == null) continue; // demoted は wire 上 null。期限計算はしない
    generations.push(`${source}:${entry.generation}`);
    promotedLevels.push(entry.level);

    const liveAlerts = snapshot.weatherAlerts.filter((a) => a.source === source);
    const sourceItems =
      liveAlerts.length > 0
        ? liveAlerts.flatMap((a) => a.items)
        : (entry.restoredItems ?? []);
    if (liveAlerts.length === 0 && sourceItems.length > 0) restored = true;

    sourceItems.forEach((item, index) => {
      const level = promotionLevelOf(item);
      if (level == null) return;
      items.push({
        key: `${source}:${index}:${item.kind}`,
        source,
        kind: item.kind,
        level,
        shownAreas: item.shownAreas,
        omittedAreaCount: item.omittedAreaCount,
      });
    });
  }

  // 昇格中の source が 1 つも無ければパネルを出さない。**逆に、非 null source があるなら
  // 中身が組めなくてもパネルは出す** — 昇格状態の権威は engine で、フロントが「描く item が無い」
  // を理由に主役表示を畳むのはフロント独自の降格になる (spec §3「非 null source があれば
  // 気象パネルを全体で 1 枚合成」、Codex R5)。中身が無い状態はパネル側が同期中として描く
  if (promotedLevels.length === 0) return null;

  items.sort((a, b) => b.level - a.level); // 安定ソート: 同レベルは source 順 → 出現順のまま
  return {
    kind: "weather",
    // 主レベルは **engine の昇格レベル**を採る (item 側から推定しない)。中身がまだ組めていない
    // 状態でも「警戒レベル N 相当」を正しく出せる
    level: Math.max(...promotedLevels) as DisplayWeatherPromotionLevelV1,
    generation: generations.join("|"),
    items,
    truncated: items.some((i) => i.omittedAreaCount > 0),
    restored,
  };
}
