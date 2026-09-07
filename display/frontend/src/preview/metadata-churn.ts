/**
 * preview 限定の metadata churn ハーネス（Issue #15 / spec §3.4・分岐 5 A）。
 *
 * `?metadataChurnMs=<正整数>` が与えられたときだけ、その間隔で `generatedAt` と `seq` **だけ** を
 * 書き換えた snapshot を preview から流し込む。実 state 配信（500ms debounce）の metadata-only
 * 更新を模し、「見た目が完全に静止している時間帯の再計測」を実 Chrome で before/after 比較する
 * ための道具である。
 *
 * production の App.svelte はこのモジュールを読まない。パラメータ非指定・空・非数値・0・負値・
 * 小数はすべて null（無効）へ倒れ、preview の挙動は現行と完全に同一になる。
 */
export function parseMetadataChurnMs(raw: string | null | undefined): number | null {
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return value > 0 ? value : null;
}
