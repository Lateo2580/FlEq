import type { P3TsunamiE01Manifest, P3TsunamiTransitionTemplate } from "../../contracts/p3-tsunami-e01.types";
import type { TsunamiAreaTransition, TsunamiUnitState, TsunamiUnitStep } from "../../contracts/p3-tsunami-unit.types";

// tsunami.mjs のうち TS の試験が使う口だけの型。
export const TEMPLATE_FIXTURES: Readonly<Record<TsunamiAreaTransition, { prime: string; target: string }>>;
export const RELEASE_FIXTURE: string;
export const TSUNAMI_SMOKE_FILE: string;
export const C4_MANIFEST: string;
export const O09_POSITIONS: readonly number[];
export function tsunamiReport(fixtureName: string, input: { eventId: string; reportAtMs: number }): string;
export function emptyTsunamiState(): TsunamiUnitState;
export function receiveTsunami(state: TsunamiUnitState, xml: string, atMs: number): TsunamiUnitStep;
export function buildTemplates(): P3TsunamiTransitionTemplate[];
export function windowEventId(kind: 1 | 2, populationIndex: number, phase: "warmup" | "formal", run: number): string;
export function templateFixtureTexts(): Record<string, string>;
export function buildTsunamiSmokeConditions(chromeVersion: string): string;
export function buildP3TsunamiManifest(input: { id: string; chromeVersion: string; nodeVersion: string; osVersion: string; device: string;
  primeLeadMs?: Partial<Record<string, number>>; periodMs?: Partial<Record<string, number>>; triggerLeadMs?: Partial<Record<string, number>>;
  stop?: Partial<Record<string, { maxAttempts: number; maxDurationMs: number }>>; smokeText?: string }): {
  manifest: P3TsunamiE01Manifest; manifestText: string; c4Text: string; smokeText: string; contractTexts: Record<string, string>; coastJsonText: string;
  sequencesText: string; fixtureTexts: Record<string, string> };
// AC08・Q-C6-IMPL-AMEND (11): 予備の成立数・試行数・1 試行の所要から窓の stopCondition。
export function stopFromPreliminary(input: { successes: number; trials: number; msPerAttempt: number }): { maxAttempts: number; maxDurationMs: number; wilsonLower: number;
  expectedMs: number };
