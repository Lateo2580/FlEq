const TRANSPORT_DEDUP_RETENTION_MS = 11 * 60_000;
const TRANSPORT_DEDUP_MAX_ENTRIES = 4096;

/**
 * transport の messageId だけを扱う重複排除。
 * revision／payload の意味判定は TelegramRevisionGate に委ねる。
 */
export class TelegramTransportDeduplicator {
  private readonly seen = new Map<string, number>();

  accept(messageId: string, receivedAtMs: number): boolean {
    this.sweep(receivedAtMs);
    if (this.seen.has(messageId)) return false;
    this.seen.set(messageId, receivedAtMs);
    while (this.seen.size > TRANSPORT_DEDUP_MAX_ENTRIES) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (oldest == null) break;
      this.seen.delete(oldest);
    }
    return true;
  }

  private sweep(nowMs: number): void {
    for (const [messageId, acceptedAtMs] of this.seen) {
      if (nowMs - acceptedAtMs > TRANSPORT_DEDUP_RETENTION_MS) {
        this.seen.delete(messageId);
      }
    }
  }
}
