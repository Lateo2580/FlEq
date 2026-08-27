import type {
  FrameLevel,
  Vpwp50DetailEntrySnapshot,
  Vpwp50DetailSnapshot,
} from "../types";
import {
  formatCriteriaTimeBySeries,
  formatPeakBySeries,
  formatSeriesWindows,
  partitionBySeverity,
} from "../engine/presentation/weather-severity-pyramid";
import {
  createRenderBuffer,
  flushWithRecap,
  frameBottom,
  frameDivider,
  frameLine,
  frameTop,
  getFrameWidth,
  pushWrappedFrameLine,
  pushWrappedFrameTitle,
} from "./formatter";
import { pushFrameTable } from "./frame-table-builder";

/** VPWP50 の保存済み detail snapshot を描画する。 */
export function displayVpwp50Detail(data: Vpwp50DetailSnapshot): void {
  const level = data.frameLevel;
  const width = getFrameWidth();
  const buf = createRenderBuffer();

  buf.push(frameTop(level, width));
  const titleParts = [
    { text: "[detail] VPWP50", priority: 0 as const, omission: "never" as const },
    ...(data.targetArea == null || data.targetArea === "" ? [] : [{
      text: data.targetArea, priority: 1 as const, omission: "never" as const, separatorBefore: " ",
    }]),
    { text: `(${data.infoType})`, priority: 1 as const, omission: "never" as const, separatorBefore: " " },
    {
      text: `保存 ${data.savedAt.slice(0, 19).replace("T", " ")}`,
      priority: 2 as const,
      omission: "drop" as const,
      separatorBefore: "  ",
    },
  ];
  pushWrappedFrameTitle(buf, level, { width }, titleParts);

  const part = partitionBySeverity(data.entries);

  if (part.advisory.length > 0) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, "▽ 注意報フル", width));
    pushAdvisoryFull(buf, level, width, part.advisory);
  }

  const detailRows: string[][] = [];
  for (const entry of [...part.special, ...part.warning]) {
    for (const window of entry.windows) {
      if (window.criteriaPeriod == null) continue;
      detailRows.push([
        `${entry.kindLabel} @${entry.areaName} (${window.series})`,
        window.criteriaPeriod.sentence,
        window.criteriaPeriod.duration,
      ]);
    }
  }
  if (detailRows.length > 0) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, "[基準到達詳細]", width));
    pushFrameTable(
      buf,
      level,
      width,
      [{ header: "対象" }, { header: "Sentence" }, { header: "Duration" }],
      detailRows,
    );
  }

  if (data.unknownCodes.length > 0) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, "[未知コード]", width));
    for (const unknown of data.unknownCodes) {
      pushWrappedFrameLine(
        buf,
        level,
        { width, purpose: "diagnostic" },
        `  ${unknown.areaName} ${unknown.propertyType} code=${unknown.code} ref=${unknown.timeRef} 高め扱い`,
      );
    }
  }

  buf.push(frameBottom(level, width));
  flushWithRecap(buf, level, width);
}

function pushAdvisoryFull(
  buf: ReturnType<typeof createRenderBuffer>,
  level: FrameLevel,
  width: number,
  advisory: Vpwp50DetailEntrySnapshot[],
): void {
  const rows: (string | null)[][] = advisory.map((entry) => [
    entry.kindLabel,
    entry.areaName,
    formatSeriesWindows(entry.windows),
    formatPeakBySeries(entry.windows, entry.windows.length > 1),
    formatCriteriaTimeBySeries(entry.windows, entry.windows.length > 1),
  ]);
  pushFrameTable(
    buf,
    level,
    width,
    [
      { header: "種別" },
      { header: "地域" },
      { header: "時刻枠" },
      { header: "ピーク" },
      { header: "基準到達" },
    ],
    rows,
  );
}
