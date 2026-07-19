const MAX_QUEUE = 8;

export class RenderQueueFullError extends Error {
  constructor() {
    super(`Render queue full (max ${MAX_QUEUE})`);
    this.name = "RenderQueueFullError";
  }
}

let currentChain: Promise<unknown> = Promise.resolve();
let queueDepth = 0;

export function getQueueDepth(): number {
  return queueDepth;
}

export async function withRenderMutex<T>(fn: () => Promise<T>): Promise<T> {
  if (queueDepth >= MAX_QUEUE) {
    throw new RenderQueueFullError();
  }
  queueDepth++;
  const next = currentChain.then(fn, fn);
  currentChain = next.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await next;
  } finally {
    queueDepth--;
  }
}
