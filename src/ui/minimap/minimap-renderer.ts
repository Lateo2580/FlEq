import chalk from "chalk";
import type { PresentationEvent } from "../../engine/presentation/types";
import { intensityColor, intensityToNumeric } from "../formatter";
import type { PrefId, MinimapCell } from "./types";
import { PREF_PLACEMENTS, GRID_ROWS, GRID_COLS, ALL_PREF_IDS } from "./grid-layout";
import { mapAreaToPref } from "./pref-mapping";

// ── Constants ──

/** Width of a single cell including trailing space: "AA:xx " = 6 chars */
const CELL_WIDTH = 6;

/** Continuation marker for multi-cell prefectures */
const CONTINUATION = "·····";

// ── Legend ──

/** Intensity values in display order */
const INTENSITY_LEGEND = ["1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];

/** Tsunami abbreviations in display order */
const TSUNAMI_LEGEND: Array<{ abbrev: string; label: string; color: chalk.Chalk }> = [
  { abbrev: "MJ", label: "MJ", color: chalk.redBright },
  { abbrev: "WN", label: "WN", color: chalk.red },
  { abbrev: "AD", label: "AD", color: chalk.yellow },
];

/**
 * Build legend lines to overlay in the upper-left empty area.
 * Returns an array of { row, text } for rows 0-3.
 */
function buildLegend(): Array<{ row: number; text: string }> {
  const lines: Array<{ row: number; text: string }> = [];

  // Row 0: "震度:" header + first 4 values
  const intLine1 = INTENSITY_LEGEND.slice(0, 4)
    .map((v) => intensityColor(v)(v.padEnd(2)))
    .join(" ");
  lines.push({ row: 0, text: `震度: ${intLine1}` });

  // Row 1: next 4 values
  const intLine2 = INTENSITY_LEGEND.slice(4, 8)
    .map((v) => intensityColor(v)(v.padEnd(2)))
    .join(" ");
  lines.push({ row: 1, text: `      ${intLine2}` });

  // Row 2: last value (7)
  const intLine3 = intensityColor("7")("7 ");
  lines.push({ row: 2, text: `      ${intLine3}` });

  // Row 3: tsunami header + values
  const tsunamiText = TSUNAMI_LEGEND.map((t) => t.color(t.label)).join(" ");
  lines.push({ row: 3, text: `津波: ${tsunamiText}` });

  return lines;
}

// ── ANSI strip helper ──

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;]*m/g, "");
}

// ── Rendering ──

/**
 * Render the minimap from a set of cells.
 * Returns 12 lines of text representing the ASCII minimap with legend overlay.
 */
export function renderMinimap(cells: MinimapCell[]): string[] {
  // Build cell lookup
  const cellMap = new Map<PrefId, MinimapCell>();
  for (const cell of cells) {
    cellMap.set(cell.prefId, cell);
  }

  // Build placement lookup: (row,col) -> { prefId, isAnchor }
  const gridMap = new Map<string, { prefId: PrefId; isAnchor: boolean }>();
  for (const placement of PREF_PLACEMENTS) {
    for (const pos of placement.cells) {
      const key = `${pos.row},${pos.col}`;
      gridMap.set(key, {
        prefId: placement.id,
        isAnchor: pos.row === placement.anchor.row && pos.col === placement.anchor.col,
      });
    }
  }

  // Build legend
  const legend = buildLegend();
  const legendByRow = new Map<number, string>();
  for (const entry of legend) {
    legendByRow.set(entry.row, entry.text);
  }

  // Render each row
  const lines: string[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    let line = "";

    // Find the last occupied column in this row
    let lastCol = -1;
    for (let col = 0; col < GRID_COLS; col++) {
      if (gridMap.has(`${row},${col}`)) lastCol = col;
    }

    for (let col = 0; col < GRID_COLS; col++) {
      const key = `${row},${col}`;
      const entry = gridMap.get(key);

      if (entry == null) {
        // Empty cell (ocean) — check if legend should be rendered here
        if (legendByRow.has(row) && col === 0) {
          const legendText = legendByRow.get(row)!;
          line += legendText;
          // Calculate how many columns the legend text spans
          const legendVisualLen = stripAnsi(legendText).length;
          const colsSpanned = Math.ceil(legendVisualLen / CELL_WIDTH);
          col += colsSpanned - 1; // skip ahead (loop will increment)
          continue;
        }
        if (col <= lastCol) {
          line += " ".repeat(CELL_WIDTH);
        }
      } else {
        const cell = cellMap.get(entry.prefId);
        const content = cell?.content ?? "..";
        const isMatch = content !== "..";

        if (entry.isAnchor) {
          // Anchor cell: show "AA:xx"
          const padded = content.length >= 2 ? content.slice(0, 2) : content.padEnd(2);
          const text = `${entry.prefId}:${padded}`;
          if (isMatch && cell?.color) {
            line += cell.color(text) + " ";
          } else {
            line += chalk.dim(text) + " ";
          }
        } else {
          // Continuation cell: show "·····"
          if (isMatch && cell?.color) {
            line += cell.color(CONTINUATION) + " ";
          } else {
            line += chalk.dim(CONTINUATION) + " ";
          }
        }
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
 * Assigns prefecture-level data (max intensity, tsunami kind) for each matched area.
 */
export function buildMinimapCells(event: PresentationEvent): MinimapCell[] {
  const prefData = new Map<PrefId, { content: string; color?: chalk.Chalk; priority: number }>();

  if (event.domain === "earthquake" || event.domain === "lgObservation" || event.domain === "eew") {
    for (const item of event.areaItems) {
      const prefId = mapAreaToPref(item.name);
      if (prefId == null) continue;
      const maxInt = item.maxInt ?? "..";
      const rank = maxInt !== ".." ? intensityToNumeric(maxInt) : -1;
      const existing = prefData.get(prefId);
      if (!existing || rank > existing.priority) {
        prefData.set(prefId, {
          content: maxInt,
          color: maxInt !== ".." ? intensityColor(maxInt) : undefined,
          priority: rank,
        });
      }
    }
  } else if (event.domain === "tsunami") {
    for (const item of event.areaItems) {
      const prefId = mapAreaToPref(item.name);
      if (prefId == null) continue;
      const kind = item.kind ?? "";
      const abbrev = tsunamiKindAbbrev(kind);
      const priority = tsunamiKindPriority(abbrev);
      const existing = prefData.get(prefId);
      if (!existing || priority > existing.priority) {
        prefData.set(prefId, {
          content: abbrev,
          color: tsunamiColor(abbrev),
          priority,
        });
      }
    }
  }

  // Build cells for all prefectures
  const cells: MinimapCell[] = [];
  for (const prefId of ALL_PREF_IDS) {
    const data = prefData.get(prefId);
    if (data) {
      cells.push({ prefId, content: data.content, color: data.color });
    } else {
      cells.push({ prefId, content: ".." });
    }
  }

  return cells;
}

// ── Display conditions ──

/**
 * Determine whether the minimap should be shown for this event.
 */
export function shouldShowMinimap(event: PresentationEvent): boolean {
  const termWidth = process.stdout.columns ?? 80;
  if (termWidth < 80) return false;

  if (event.isCancellation) return false;

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
      if (event.areaCount === 0 && event.observationCount === 0) return false;
      const rank = event.maxIntRank ?? 0;
      const count = event.observationCount > 0 ? event.observationCount : event.areaCount;
      return rank >= 4 || count >= 4;
    }
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
