// chrome.mjs のうち、試験（run.test.ts の P3-PH-AC02）が使う口の型。
export const FLAGS: readonly string[];
type Scope = { add: (close: () => Promise<void>) => void; children?: unknown[] };
export function openPage(url: string, scope?: Scope | null, options?: { motion?: string | null; cdp?: string | null }): Promise<{
  evaluate: (expression: string) => Promise<unknown>; close: () => Promise<void>; remote: { cdp: string; product: string; userAgent: string; modelName: string; modelVersion: string } | null;
  command: string; activation: string }>;
