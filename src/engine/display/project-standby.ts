import type { ParsedHeatAlertInfo } from "../../types";
import type { PresentationEvent } from "../presentation/types";
import type { DisplayHeatAreaV1 } from "./protocol";

export interface HeatUpdate {
  sourceEventId: string;
  reportDateTime: string;
  serial: string | null;
  targetDate: string;
  targetDateEndMs: number;
  areas: DisplayHeatAreaV1[];
  isSpecial: boolean;
  isCancellation: boolean;
}

const JST_OFFSET_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

function jstDateOf(timeMs: number): string {
  return new Date(timeMs + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function projectHeatUpdate(event: PresentationEvent, nowMs: number): HeatUpdate | null {
  if (event.domain !== "heatAlert" || event.raw == null || Array.isArray(event.raw)) return null;
  const raw = event.raw as ParsedHeatAlertInfo;
  if (raw.type !== "VPFT50") return null;
  const parsedTarget = raw.targetDateTime == null ? Number.NaN : Date.parse(raw.targetDateTime);
  const targetDate = jstDateOf(Number.isNaN(parsedTarget) ? nowMs : parsedTarget);
  const targetDateStartMs = Date.parse(`${targetDate}T00:00:00+09:00`);
  const isSpecial = event.title.includes("特別警戒");
  const areaName = raw.targetAreaName ?? event.areaNames[0] ?? null;
  return {
    sourceEventId: event.id,
    reportDateTime: event.reportDateTime,
    serial: event.serial ?? raw.serial,
    targetDate,
    targetDateEndMs: targetDateStartMs + DAY_MS,
    areas: areaName == null ? [] : [{ areaName, isSpecial }],
    isSpecial,
    isCancellation: event.isCancellation,
  };
}
