import type { PresentationEvent } from "../../engine/presentation/types";
import type { FrameLevel } from "../formatter";
import type { SummaryModel } from "./types";
import {
  formatDepthSpecialValue,
  formatMagnitudeSpecialValue,
  formatPresentationMagnitude,
} from "../../utils/magnitude";

const SEVERITY_MAP: Record<FrameLevel, string> = {
  critical: "[緊急]",
  warning: "[警告]",
  normal: "[情報]",
  info: "[通知]",
  cancel: "[取消]",
};

export function buildSummaryModel(event: PresentationEvent): SummaryModel {
  const severity = SEVERITY_MAP[event.frameLevel];

  const areaNames =
    event.areaNames.length > 0
      ? event.areaNames
      : event.forecastAreaNames.length > 0
        ? event.forecastAreaNames
        : undefined;

  return {
    domain: event.domain,
    severity,
    title: event.title,
    location: event.hypocenterName ?? event.volcanoName ?? undefined,
    magnitude: event.magnitudeValue != null
      ? formatMagnitudeSpecialValue(event.magnitudeValue) ?? "—"
      : event.magnitude
        ? formatPresentationMagnitude(event.magnitude)
        : undefined,
    depth: event.depthValue != null
      ? formatDepthSpecialValue(event.depthValue) ?? "—"
      : event.depth ?? undefined,
    maxInt: event.maxIntLabel != null
      ? `震度${event.maxIntLabel}`
      : event.maxInt
        ? `震度${event.maxInt}`
        : undefined,
    maxLgInt: event.maxLgIntLabel != null
      ? `長周期${event.maxLgIntLabel}`
      : event.maxLgInt
        ? `長周期${event.maxLgInt}`
        : undefined,
    headline: event.headline ?? undefined,
    volcanoName: event.volcanoName ?? undefined,
    serial: event.serial ? `#${event.serial}` : undefined,
    areaNames,
  };
}
