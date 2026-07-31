import type { TelegramMeta } from "../../src/types";
import { createTelegramMeta } from "../../src/dmdata/telegram-meta";

/**
 * parser を通さず Parsed DTO を直接組み立てる unit test 用 metadata。
 * 実 XML fixture は mock-message.ts の ingress normalizer を使う。
 */
export function testTelegramMeta(isTest = false): TelegramMeta {
  return createTelegramMeta({
    messageId: "synthetic-test-message",
    eventId: "synthetic-test-event",
    type: "TEST00",
    reportDateTime: "2026-01-01T00:00:00+09:00",
    serial: "1",
    infoType: "発表",
    receivedAtMs: 0,
    status: isTest ? "試験" : "通常",
    isTest,
  });
}
