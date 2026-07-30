import type { ParsedHeatAlertInfo, ParsedTyphoonAnalysis, ParsedVolcanoInfo } from "../../types";
import type { PresentationEvent } from "../presentation/types";
import type { DisplayHeatAreaV1, DisplayTyphoonV1, DisplayVolcanoEntryV1 } from "./protocol";

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

export interface TyphoonUpdate {
  typhoonKey: string;
  sourceEventId: string;
  reportDateTime: string;
  serial: string | null;
  typhoon: DisplayTyphoonV1;
  isCancellation: boolean;
}

export function projectTyphoonUpdate(event: PresentationEvent): TyphoonUpdate | null {
  if (event.domain !== "typhoonAnalysis" || event.raw == null || Array.isArray(event.raw)) return null;
  const raw = event.raw as ParsedTyphoonAnalysis;
  const typhoonKey = event.eventId ?? raw.eventId;
  if (typhoonKey == null || typhoonKey === "") return null;
  const frame = raw.frames.find((candidate) => candidate.kind === "実況") ?? raw.frames[0];
  if (frame == null) return null;
  return {
    typhoonKey,
    sourceEventId: event.id,
    reportDateTime: event.reportDateTime,
    serial: event.serial ?? raw.serial,
    isCancellation: event.isCancellation || raw.infoType === "取消",
    typhoon: {
      typhoonKey,
      name: raw.name?.name ?? null,
      nameKana: raw.name?.nameKana ?? null,
      remark: raw.name?.remark ?? null,
      typhoonNumber: raw.name?.number ?? null,
      category: frame.typhoonClass.category,
      intensityClass: frame.typhoonClass.intensity,
      sizeClass: frame.typhoonClass.size,
      location: frame.center.location,
      pressureHpa: frame.center.pressureHpa,
      maxWindMs: frame.wind?.maxWindMs ?? null,
      maxGustMs: frame.wind?.maxGustMs ?? null,
      moveDirection: frame.center.moveDirection,
      moveSpeedKmh: frame.center.moveSpeedKmh,
      reportDateTime: event.reportDateTime,
    },
  };
}

export interface VolcanoUpdate {
  volcano: DisplayVolcanoEntryV1;
  sourceEventId: string;
  reportDateTime: string;
  serial: string | null;
  kind: "alert" | "eruption";
  isCancellation: boolean;
  isLevelIncrease: boolean;
}

function levelOf(code: string | null): number {
  const match = code?.match(/[1-5]/);
  return match == null ? 0 : Number(match[0]);
}

export function projectVolcanoUpdate(event: PresentationEvent): VolcanoUpdate | null {
  if (event.domain !== "volcano" || event.raw == null || Array.isArray(event.raw)) return null;
  const raw = event.raw as ParsedVolcanoInfo;
  if (raw.kind !== "alert" && raw.kind !== "eruption") return null;
  if (raw.volcanoCode === "") return null;
  const alertLevel = raw.kind === "alert" ? raw.alertLevel : null;
  return {
    volcano: {
      code: raw.volcanoCode,
      name: raw.volcanoName,
      alertLevel,
      latestEvent: raw.kind === "eruption" ? (raw.isFlashReport ? "噴火速報" : raw.phenomenonName) : null,
    },
    sourceEventId: event.id,
    reportDateTime: event.reportDateTime,
    serial: event.serial ?? null,
    kind: raw.kind,
    isCancellation: event.isCancellation || raw.infoType === "取消",
    isLevelIncrease: raw.kind === "alert" && levelOf(raw.alertLevelCode) > levelOf(raw.previousLevelCode),
  };
}
