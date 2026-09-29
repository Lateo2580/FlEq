// frames.mjs のうち TS の試験が使う口だけの型。
export type XmlInput = { headType: string; xml: string };
export const WALL_ORIGIN_MS: number;
export const C_CYCLE: { periodMs: number; offsetsMs: number[]; validUntilAfterStartMs: number; restoreValidForMs: number; forecastOffice: string; warmupCycles: number };
export function nearCapacityFrames(input: { mode: "full" | "leaveRoomForP" | "cycleC"; room?: { partials: number; forecastSubjects: number } | null }): XmlInput[];
export function cycleCFrames(c: number, cycleStartWallMs: number): (XmlInput & { offsetMs: number })[];
export function validUntilMs(xml: string): number;
