export interface TokenEntry {
  name: string;
  group: string;
  raw: string;
  comment: string;
}

export interface RgbColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface ContrastPair {
  id: string;
  category: string;
  state: string;
  fg: RgbColor;
  bg: RgbColor;
  fgLabel: string;
  bgLabel: string;
  ratio: number;
  threshold: number;
  thresholdKind: string;
  pass: boolean;
  note: string;
  status?: "PASS" | "FAIL" | "STALE" | "ALLOWED";
  allowReason?: string;
}

export interface AuditablePair {
  id: string;
  state: string;
  pass: boolean;
  fg: Pick<RgbColor, "r" | "g" | "b">;
  bg: Pick<RgbColor, "r" | "g" | "b">;
}

export interface AllowlistEntry {
  id: string;
  pair_ids: string[];
  reason: string;
  applies_when: string;
  last_verified_input_hash: string;
}

export function parseTokens(css: string): TokenEntry[];
export function buildTokenMap(entries: TokenEntry[]): Map<string, string>;
export function resolveValue(value: string, map: Map<string, string>, seen?: Set<string>): string;
export function parseColor(value: string): RgbColor;
export function relativeLuminance(color: RgbColor): number;
export function contrastRatio(fg: RgbColor, bg: RgbColor): number;
export function srgbMix(c1: RgbColor, c2: RgbColor, w1: number): RgbColor;
export function compositeOver(top: RgbColor, alpha: number, bottom: RgbColor): RgbColor;

export const HIGH_ROLES: string[];
export const ALERT_CHIP_ROLES: Set<string>;
export const ALERT_TEXT_ROLES: string[];
export const ADVISORY_ROLES: Set<string>;
export function evaluatePairs(map: Map<string, string>): ContrastPair[];
export const ALLOWLIST: AllowlistEntry[];
export function computeInputHash(pairIds: string[], evaluated: AuditablePair[]): string;
export function applyAllowlist<T extends AuditablePair>(pairs: T[], allowlist: AllowlistEntry[]): Array<T & Pick<ContrastPair, "status" | "allowReason">>;
export function auditGate(audited: Array<AuditablePair & Pick<ContrastPair, "status">>): string[];
export function validateAllowlist(allowlist: AllowlistEntry[], evaluated: AuditablePair[]): string[];

export function renderTokensBlock(resolved: Array<TokenEntry & { resolved: string }>): string;
export function renderContrastBlock(audited: ContrastPair[]): string;
export function generateBlocks(css: string): { tokens: string; contrast: string };
export const MARKERS: Record<"tokens" | "contrast", { start: string; end: string }>;
export function assertMarkers(md: string): void;
export function extractBlock(md: string, key: "tokens" | "contrast"): string;
export function replaceBlock(md: string, key: "tokens" | "contrast", content: string): string;
export function checkDoc(md: string, css: string): { ok: boolean; diffs: string[] };
export function runWrite(options: {
  readDoc: () => string;
  writeDoc: (content: string) => void;
  css: string;
}): string;
