// P3-C4-AC13(3)①: E14 の束 k の 3 入力（試験が読む分だけの宣言）。
export function e14BundleFrames(k: number, atWallMs: number): { unit: "U-E" | "U-W" | "U-F"; headType: string; xml: string }[];
// 窓の並び（試験は id だけを読む）。
export function auxWindows(ctx: Record<string, unknown>): { id: string }[];
