import type { DisplayBackgroundTone, DisplayTickerSurface } from "./protocol";

/**
 * wire 値は JSON から到達するため、型注釈だけを信用しない。
 * 背景は加点的な演出なので、未知値は現状相当の calm へ安全に縮退する。
 */
export function normalizeBackgroundTone(value: unknown): DisplayBackgroundTone {
  switch (value) {
    case "calm":
    case "caution":
    case "alert":
    case "critical":
    case "quakeExtreme":
      return value;
    default:
      return "calm";
  }
}

/** 未知・旧 server のテロップ面は、従来どおり面なしに縮退する。 */
export function normalizeTickerSurface(value: unknown): DisplayTickerSurface {
  return value === "solid" ? "solid" : "none";
}
