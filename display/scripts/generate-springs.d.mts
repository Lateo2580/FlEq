export interface SpringResult {
  linear: string;
  durMs: number;
  wn: number;
}

export const SPRING_SPECS: Record<string, { stiffness: number; damping: number; mass?: number; stops?: number; settle?: number }>;
export function computeAll(): Record<string, SpringResult>;
export function renderCssBlock(): string;
export function renderMotionGeneratedTs(): string;
export function replaceCssSpringBlock(css: string): string;
export function writeGenerated(options: {
  readCss: () => string;
  writeCss: (css: string) => void;
  writeMotion: (motion: string) => void;
}): void;
