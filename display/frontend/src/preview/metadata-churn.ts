/**
 * preview 限定の churn ハーネス（Issue #15）。
 *
 * 第 1 便（spec §3.4・分岐 5 A）で `?metadataChurnMs=<正整数>` を入れた。その間隔で `generatedAt` と
 * `seq` **だけ** を書き換えた snapshot を preview から流し込み、実 state 配信（500ms debounce）の
 * metadata-only 更新を模して「見た目が完全に静止している時間帯の再計測」を実 Chrome で before/after
 * 比較するための道具である。
 *
 * 第 2 便（`spec: 2026-09-08-standby-resettle-residual-load.md（作業ノート、repo 外）` §3.0 段階 0）で二つ足した。
 *
 * - `?metadataChurnMode=reparse` — 配信 snapshot を毎回 `JSON.parse(JSON.stringify(...))` し直す
 *   本番形状モード。本番の state は SSE のペイロードを毎回 parse するので（`lib/connection.svelte.ts:84`）
 *   入れ子まで全部が新オブジェクトになり、参照等価で伝播が止まる箇所が存在しない。既定の `shared`
 *   モードは `scenarioSnapshot` の入れ子を共有するため本番より軽く、**reparse が本番相当の主指標**、
 *   shared は第 1 便との before/after 比較用の副指標である。
 * - `?contentChurnMs=<正整数>` — 実電文相当の内容変化を周期的に流し、1 epoch のコストを測る。
 *
 * production の `App.svelte` とそこから到達するモジュールはこのファイルを読まない（受入条件 A13）。
 * パラメータ非指定・空・非数値・0・負値・小数はすべて無効へ倒れ、preview の挙動は現行と完全に同一になる。
 */
import type { ActiveStandbyCardV1, DisplayStateSnapshotV1 } from "../lib/protocol";

/** churn した snapshot の配信形状。`shared` が既定（現行と完全に同一）。 */
export type MetadataChurnMode = "shared" | "reparse";

/** `window.__fleqChurnProbe()` が返す観測点の読み出し（preview 限定・段階 0）。 */
export interface ChurnProbeReadout {
  readonly mode: MetadataChurnMode;
  readonly metadataChurnMs: number;
  readonly metadataChurnTick: number;
  readonly contentChurnMs: number;
  readonly contentChurnTick: number;
  /** 観測点が有効なら 1。0 のとき mutation 系カウンタは常に 0 のまま。 */
  readonly probe: number;
  /** 計測シェルフ配下の DOM 変異数（spec §2.2 の経路 iii）。 */
  readonly shelfMutations: number;
  /** `.standby` 自身の診断属性の書き換え数。 */
  readonly rootAttrMutations: number;
  /** 生きているカード側の DOM 変異数。 */
  readonly liveMutations: number;
}

declare global {
  interface Window {
    /** preview の churn パラメータが有効なときだけ生える観測窓。production には存在しない。 */
    __fleqChurnProbe?: () => ChurnProbeReadout;
  }
}

export interface ChurnStep {
  /** 0 起点の churn 回数。`seq` の増分と、内容変化の対象選択に使う。 */
  readonly tick: number;
  /** その配信の `generatedAt`（ISO 文字列）。内容変化では `updatedAt` にも使う。 */
  readonly generatedAt: string;
}

function parsePositiveIntMs(raw: string | null | undefined): number | null {
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return value > 0 ? value : null;
}

export function parseMetadataChurnMs(raw: string | null | undefined): number | null {
  return parsePositiveIntMs(raw);
}

export function parseContentChurnMs(raw: string | null | undefined): number | null {
  return parsePositiveIntMs(raw);
}

export function parseMetadataChurnMode(raw: string | null | undefined): MetadataChurnMode {
  return raw === "reparse" ? "reparse" : "shared";
}

/**
 * 観測点（MutationObserver カウンタ）の有効化。既定 false。
 * 観測自体が main thread を食うので、主指標の採取は probe 無しで走らせ、帰属を採るときだけ立てる。
 */
export function parseChurnProbeFlag(raw: string | null | undefined): boolean {
  return raw === "1" || raw === "true";
}

/**
 * 第 1 便から変わらない metadata-only churn。入れ子は同一参照のまま流す。
 * これが「現行ハーネスは本番より軽い」の実体で、spec §1.2 の下限側の数字を作る。
 */
export function applyMetadataChurn(
  base: DisplayStateSnapshotV1,
  { tick, generatedAt }: ChurnStep,
): DisplayStateSnapshotV1 {
  return { ...base, generatedAt, seq: base.seq + tick };
}

/**
 * 本番形状（SSE の `JSON.parse`）と同じく入れ子まで新オブジェクトにする。
 * 値は元と完全に一致するので、見た目は動かないまま参照等価の打ち切りだけが消える。
 */
export function reparseSnapshot(base: DisplayStateSnapshotV1): DisplayStateSnapshotV1 {
  return JSON.parse(JSON.stringify(base)) as DisplayStateSnapshotV1;
}

function positiveMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/**
 * 実電文相当の内容変化を 1 回ぶん流す。epoch を確実に開かせるために二つ動かす。
 *
 * 1. `standbyItems` の 1 枚だけ `updatedAt` を進める（1 通の電文がカード 1 枚を更新した状態）。
 *    `standbyContentIdentity`（`components/StandbyScreen.svelte:2059-2070`）は全 kind の分岐で
 *    `updatedAt` を読むので、これだけで contentKey が必ず変わる
 * 2. `recentQuakes` を 1 つ以上回転させる（履歴カードの描画内容とサイズが実際に動く）。
 *    `standbyLayoutKey` は `recentQuakes` を丸ごと直列化する（`lib/legacy-standby/layout-key.ts:196`）
 *
 * **限界**: 実電文はカード本文の文字数まで変えるので、ここでの内容変化は「実 epoch の下限側」である。
 * 測りたいのは settle ループ 1 回ぶんの構造的コストで、その意味では十分に代表的だが、
 * 圧縮段の境界をまたぐような大きな寸法変化は再現していない。
 */
export function applyContentChurn(
  base: DisplayStateSnapshotV1,
  { tick, generatedAt }: ChurnStep,
): DisplayStateSnapshotV1 {
  const items = base.standbyItems;
  const touchedItems: ActiveStandbyCardV1[] | undefined = items == null || items.length === 0
    ? items
    : items.map((item, index) =>
        index === positiveMod(tick, items.length) ? { ...item, updatedAt: generatedAt } : item,
      );
  const quakes = base.recentQuakes;
  const offset = quakes.length >= 2 ? 1 + positiveMod(tick, quakes.length - 1) : 0;
  const rotatedQuakes = offset === 0 ? quakes : [...quakes.slice(offset), ...quakes.slice(0, offset)];
  return {
    ...base,
    generatedAt,
    seq: base.seq + tick,
    recentQuakes: rotatedQuakes,
    ...(touchedItems == null ? {} : { standbyItems: touchedItems }),
  };
}
