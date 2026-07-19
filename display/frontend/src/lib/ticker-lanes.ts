// テロップのレーン本数。固定ハッシュ分配 (laneIndexForId/distributeLanes) は spec §4-3 で廃止し、
// 親 Ticker.svelte の全体スケジューラ (ticker-schedule.ts) が優先度でレーンへ割り当てる。
export const LANES = 2;
