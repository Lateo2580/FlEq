export type HealthSample = {
  load: string; run: number; sampleIndex: number; scheduledMonotonicMs: number; requestStartMonotonicMs: number;
  bodyCompleteMonotonicMs: number | null; httpStatus: number | null; worker: string | null;
  failure: "bodyIncomplete" | "non200" | "invalidBody" | "timeout" | null;
};
export function runHealthClient(input: { url: string; count: number; everyMs?: number; timeoutMs: number; load: string; run: number; onSample?: (sample: HealthSample) => void }): Promise<HealthSample[]>;
