import chalk from "chalk";
import type { PresentationEvent } from "../../engine/presentation/types";
import { intensityColor, intensityToNumeric } from "../formatter";
import type { BlockId, MinimapCell } from "./types";
import { ALL_BLOCK_IDS, mapAreaToBlock } from "./block-mapping";

// ── Layout ──

/**
 * Minimap layout: 4 rows, each row is an array of { blockId, col }.
 * col is the 0-based column position (each cell is 9 chars wide: "[XXX xx] ").
 */
const LAYOUT: Array<Array<{ blockId: BlockId; col: number }>> = [
  [{ blockId: "HKD", col: 3 }],
  [
    { blockId: "TOH", col: 0 },
    { blockId: "KKS", col: 1 },
    { blockId: "IZO", col: 2 },
  ],
  [
    { blockId: "HKR", col: 0 },
    { blockId: "TOK", col: 1 },
    { blockId: "KIN", col: 2 },
    { blockId: "CHG", col: 3 },
  ],
  [
    { blockId: "SKK", col: 1 },
    { blockId: "KNB", col: 2 },
    { blockId: "KNS", col: 3 },
    { blockId: "OKN", col: 4 },
  ],
];

/** Width of a single cell including trailing space: "[XXX xx] " = 9 chars */
const CELL_WIDTH = 9;

// ── Rendering ──

/**
 * Render the minimap from a set of cells.
 * Returns 4 lines of text representing the ASCII minimap.
 */
export function renderMinimap(cells: MinimapCell[]): string[] {
  const cellMap = new Map<BlockId, MinimapCell>();
  for (const cell of cells) {
    cellMap.set(cell.blockId, cell);
  }

  const lines: string[] = [];
  for (const row of LAYOUT) {
    // Determine leading spaces based on the minimum column in this row
    const minCol = Math.min(...row.map((r) => r.col));
    let line = " ".repeat(minCol * CELL_WIDTH);

    for (let i = 0; i < row.length; i++) {
      const entry = row[i];
      const cell = cellMap.get(entry.blockId);

      // Fill gaps between non-contiguous columns
      if (i > 0) {
        const gap = entry.col - row[i - 1].col - 1;
        if (gap > 0) {
          line += " ".repeat(gap * CELL_WIDTH);
        }
      }

      const content = cell?.content ?? ".";
      const padded = content.length >= 2 ? content.slice(0, 2) : content.padEnd(2);
      const inner = `${entry.blockId} ${padded}`;

      if (cell?.color) {
        line += cell.color(`[${inner}]`) + " ";
      } else {
        line += chalk.dim(`[${inner}]`) + " ";
      }
    }

    lines.push(line.trimEnd());
  }

  return lines;
}

// ── Building cells from PresentationEvent ──

/** Tsunami warning kind abbreviations */
function tsunamiKindAbbrev(kind: string): string {
  if (kind.includes("大津波")) return "MJ";
  if (kind.includes("津波警報")) return "WN";
  if (kind.includes("注意報")) return "AD";
  return "??";
}

/** Tsunami warning color by abbreviation */
function tsunamiColor(abbrev: string): chalk.Chalk {
  switch (abbrev) {
    case "MJ":
      return chalk.redBright;
    case "WN":
      return chalk.red;
    case "AD":
      return chalk.yellow;
    default:
      return chalk.white;
  }
}

/** Tsunami kind priority (higher = more severe) */
function tsunamiKindPriority(abbrev: string): number {
  switch (abbrev) {
    case "MJ":
      return 3;
    case "WN":
      return 2;
    case "AD":
      return 1;
    default:
      return 0;
  }
}

/**
 * Build MinimapCell[] from a PresentationEvent.
 * Assigns block-level data (max intensity, tsunami kind, etc.) for each matched block.
 */
export function buildMinimapCells(event: PresentationEvent): MinimapCell[] {
  const blockData = new Map<BlockId, { content: string; color?: chalk.Chalk; priority: number }>();

  if (event.domain === "earthquake" || event.domain === "lgObservation") {
    // Use areaItems with maxInt
    for (const item of event.areaItems) {
      const blockId = mapAreaToBlock(item.name);
      if (blockId == null) continue;
      const maxInt = item.maxInt ?? ".";
      const rank = maxInt !== "." ? intensityToNumeric(maxInt) : -1;
      const existing = blockData.get(blockId);
      if (!existing || rank > existing.priority) {
        blockData.set(blockId, {
          content: maxInt,
          color: maxInt !== "." ? intensityColor(maxInt) : undefined,
          priority: rank,
        });
      }
    }
  } else if (event.domain === "eew") {
    // Use areaItems (forecast areas) with maxInt
    for (const item of event.areaItems) {
      const blockId = mapAreaToBlock(item.name);
      if (blockId == null) continue;
      const maxInt = item.maxInt ?? ".";
      const rank = maxInt !== "." ? intensityToNumeric(maxInt) : -1;
      const existing = blockData.get(blockId);
      if (!existing || rank > existing.priority) {
        blockData.set(blockId, {
          content: maxInt,
          color: maxInt !== "." ? intensityColor(maxInt) : undefined,
          priority: rank,
        });
      }
    }
  } else if (event.domain === "tsunami") {
    // Use areaItems with kind for tsunami type
    for (const item of event.areaItems) {
      const blockId = mapAreaToBlock(item.name);
      if (blockId == null) continue;
      const kind = item.kind ?? "";
      const abbrev = tsunamiKindAbbrev(kind);
      const priority = tsunamiKindPriority(abbrev);
      const existing = blockData.get(blockId);
      if (!existing || priority > existing.priority) {
        blockData.set(blockId, {
          content: abbrev,
          color: tsunamiColor(abbrev),
          priority,
        });
      }
    }
  }

  // Build cells for all blocks
  const cells: MinimapCell[] = [];
  for (const blockId of ALL_BLOCK_IDS) {
    const data = blockData.get(blockId);
    if (data) {
      cells.push({ blockId, content: data.content, color: data.color });
    } else {
      cells.push({ blockId, content: "." });
    }
  }

  return cells;
}

// ── Display conditions ──

/**
 * Determine whether the minimap should be shown for this event.
 */
export function shouldShowMinimap(event: PresentationEvent): boolean {
  // Terminal width check
  const termWidth = process.stdout.columns ?? 80;
  if (termWidth < 100) return false;

  // Cancelled events are not shown
  if (event.isCancellation) return false;

  // Domain-specific checks
  switch (event.domain) {
    case "earthquake": {
      if (event.areaCount === 0) return false;
      const rank = event.maxIntRank ?? 0;
      return rank >= 4 || event.areaCount >= 4;
    }
    case "eew":
      return event.forecastAreaCount > 0;
    case "tsunami":
      if (event.forecastAreaCount === 0 && event.areaCount === 0) return false;
      return ["critical", "warning", "normal"].includes(event.frameLevel);
    case "lgObservation": {
      if (event.areaCount === 0) return false;
      const rank = event.maxIntRank ?? 0;
      return rank >= 4 || event.areaCount >= 4;
    }
    // Text, nankai-trough, volcano, raw: never show
    default:
      return false;
  }
}

/**
 * Public API: render the minimap for a PresentationEvent.
 * Returns the minimap lines, or null if the minimap should not be shown.
 */
export function renderMinimapForEvent(event: PresentationEvent): string[] | null {
  if (!shouldShowMinimap(event)) return null;
  const cells = buildMinimapCells(event);
  return renderMinimap(cells);
}
