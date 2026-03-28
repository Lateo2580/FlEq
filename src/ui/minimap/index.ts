export type { PrefId, PrefDef, MinimapCell } from "./types";
export { ALL_PREF_IDS, PREF_PLACEMENTS, GRID_ROWS, GRID_COLS } from "./grid-layout";
export { mapAreaToPref } from "./pref-mapping";
export {
  renderMinimap,
  buildMinimapCells,
  shouldShowMinimap,
  renderMinimapForEvent,
} from "./minimap-renderer";

// Legacy exports kept for block-mapping.test.ts (to be removed in Task 5)
export { BLOCK_DEFS, ALL_BLOCK_IDS, mapAreaToBlock } from "./block-mapping";
