export type { BlockId, BlockDef, MinimapCell } from "./types";
export { BLOCK_DEFS, ALL_BLOCK_IDS, mapAreaToBlock } from "./block-mapping";
export {
  renderMinimap,
  buildMinimapCells,
  shouldShowMinimap,
  renderMinimapForEvent,
} from "./minimap-renderer";
