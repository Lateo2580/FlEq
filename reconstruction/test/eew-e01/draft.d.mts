import type { P3E01Manifest } from "../../contracts/p3-e01-reaccept.types";

// draft.mjs のうち TS の試験が使う口だけの型。
export const A10_MANIFEST: string;
export function contractTextsFor(root?: string): Record<string, string>;
export function buildP3Manifest(input: {
  id: string; chromeVersion: string; nodeVersion: string; osVersion: string; device: string;
  collisionVerdict?: "A" | "B"; stop?: Partial<Record<string, { maxAttempts: number; maxDurationMs: number }>>; establishmentRate?: number;
  lead?: Partial<Record<string, number>>; deadlineSpan?: "population" | "encodeThroughWrite"; o09Positions?: readonly number[];
  e14?: { bundles: number; intervalMs: number }; ownerHeapSamples?: number;
}): { manifest: P3E01Manifest; manifestText: string; trialSetupText: string; initialStateText: string; smokeText: string; contractTexts: Record<string, string>; a10Text: string;
  sequencesText: string };
export const DEFAULT_LEAD_MS: Readonly<Record<"maxWeatherCheckpointEncodeStarted" | "maxForecastCheckpointSave" | "forecastDeadlineOverlap", number>>;
export const SEQUENCES_FILE: string;
