import { describe, expect, it } from "vitest";
import {
  FUTURE_REPORT_DATETIME_SKEW_MS,
  compareTelegramRevisions,
  createTelegramMeta,
  parseStrictInfoType,
  parseStrictReportDateTime,
  parseStrictText,
  parseTelegramSerial,
  telegramRevision,
} from "../../src/dmdata/telegram-meta";

const RECEIVED_AT = Date.parse("2026-07-31T12:00:00+09:00");

function meta(overrides: Partial<Parameters<typeof createTelegramMeta>[0]> = {}) {
  return createTelegramMeta({
    messageId: "message-1",
    eventId: "event-1",
    type: "VXSE51",
    reportDateTime: "2026-07-31T11:59:00+09:00",
    serial: "001",
    infoType: "発表",
    receivedAtMs: RECEIVED_AT,
    status: "通常",
    isTest: false,
    ...overrides,
  });
}

function comparable(
  overrides: Partial<Parameters<typeof createTelegramMeta>[0]> = {},
  stateSubjectKey: string | null = "quake:event-1",
) {
  return {
    revision: telegramRevision(meta(overrides)),
    stateSubjectKey,
  };
}

describe("TelegramMeta", () => {
  it("strict text は raw を完全保存し、利用値だけを trim する", () => {
    expect(parseStrictText(" event-1 ")).toEqual({
      raw: " event-1 ",
      value: "event-1",
      valid: true,
    });
    expect(parseStrictText("　 ")).toEqual({
      raw: "　 ",
      value: null,
      valid: false,
    });
  });

  it("serial は10進数字の安全な整数だけ numeric revision とする", () => {
    expect(parseTelegramSerial("001")).toEqual({ raw: "001", numeric: 1, valid: true });
    for (const raw of [null, "", "12A", "+12", "1.2", " 12", "9007199254740992"]) {
      expect(parseTelegramSerial(raw)).toEqual({ raw, numeric: null, valid: false });
    }
  });

  it("InfoType は既知3値だけを受理し raw は変更しない", () => {
    expect(parseStrictInfoType(" 訂正 ")).toEqual({
      raw: " 訂正 ",
      value: "訂正",
      valid: true,
    });
    expect(parseStrictInfoType("定時")).toEqual({
      raw: "定時",
      value: null,
      valid: false,
    });
  });

  it("ReportDateTime は timezone・実在日時を厳密検証する", () => {
    expect(parseStrictReportDateTime("2026-07-31T12:00:00+09:00", RECEIVED_AT))
      .toEqual({
        raw: "2026-07-31T12:00:00+09:00",
        epochMs: RECEIVED_AT,
        valid: true,
      });
    for (const raw of [
      null,
      "",
      "not-a-date",
      "2026-02-30T12:00:00+09:00",
      "2026-07-31T12:00:00",
      " 2026-07-31T12:00:00+09:00 ",
    ]) {
      expect(parseStrictReportDateTime(raw, RECEIVED_AT)).toEqual({
        raw,
        epochMs: null,
        valid: false,
      });
    }
  });

  it("未来15分ちょうどは valid、1ms超過は invalid で now へ昇格しない", () => {
    const boundary = new Date(RECEIVED_AT + FUTURE_REPORT_DATETIME_SKEW_MS).toISOString();
    const exceeded = new Date(RECEIVED_AT + FUTURE_REPORT_DATETIME_SKEW_MS + 1).toISOString();
    expect(parseStrictReportDateTime(boundary, RECEIVED_AT)).toEqual({
      raw: boundary,
      epochMs: RECEIVED_AT + FUTURE_REPORT_DATETIME_SKEW_MS,
      valid: true,
    });
    expect(parseStrictReportDateTime(exceeded, RECEIVED_AT)).toEqual({
      raw: exceeded,
      epochMs: null,
      valid: false,
    });
    expect(parseStrictReportDateTime("invalid", RECEIVED_AT).epochMs).not.toBe(RECEIVED_AT);
  });

  it("TelegramMeta と TelegramRevision を spec の形で生成する", () => {
    const parsed = meta();
    expect(parsed).toMatchObject({
      messageId: "message-1",
      eventId: { raw: "event-1", value: "event-1", valid: true },
      type: { raw: "VXSE51", value: "VXSE51", valid: true },
      serial: { raw: "001", numeric: 1, valid: true },
      infoType: { raw: "発表", value: "発表", valid: true },
      receivedAtMs: RECEIVED_AT,
      status: "通常",
      isTest: false,
    });
    expect(telegramRevision(parsed)).toEqual({
      eventId: parsed.eventId,
      type: parsed.type,
      reportDateTime: parsed.reportDateTime,
      serial: parsed.serial,
      infoType: parsed.infoType,
    });
  });

  it("日時主 comparator は日時、同時刻なら numeric serial を比較する", () => {
    const current = comparable({ serial: "2" });
    expect(compareTelegramRevisions(
      comparable({ reportDateTime: "2026-07-31T12:00:00+09:00", serial: "1" }),
      current,
    )).toBe("newer");
    expect(compareTelegramRevisions(comparable({ serial: "3" }), current)).toBe("newer");
    expect(compareTelegramRevisions(comparable({ serial: "2" }), current)).toBe("equal");
    expect(compareTelegramRevisions(comparable({ serial: "1" }), current)).toBe("older");
  });

  it("serialOnly は numeric serial だけを比較し日時を tie-breaker にしない", () => {
    const current = comparable({ serial: "2" });
    const incoming = comparable({
      reportDateTime: "2026-07-31T11:58:00+09:00",
      serial: "3",
    });
    expect(compareTelegramRevisions(incoming, current, "serialOnly")).toBe("newer");
    expect(compareTelegramRevisions(
      comparable({ reportDateTime: "2026-07-31T12:00:00+09:00", serial: "2" }),
      current,
      "serialOnly",
    )).toBe("equal");
  });

  it("非数値・欠落 serial と invalid date は unordered にする", () => {
    const current = comparable({ serial: "2" });
    for (const serial of [null, "", "2A"]) {
      expect(compareTelegramRevisions(
        comparable({ serial }),
        current,
      )).toBe("unordered");
    }
    expect(compareTelegramRevisions(
      comparable({ reportDateTime: "invalid" }),
      current,
    )).toBe("unordered");
  });

  it("EventID・type・stateSubjectKey の identity 不一致は unordered にする", () => {
    const current = comparable({ serial: "2" });
    expect(compareTelegramRevisions(
      comparable({ eventId: "event-2", serial: "2" }),
      current,
    )).toBe("unordered");
    expect(compareTelegramRevisions(
      comparable({ type: "VXSE52", serial: "2" }),
      current,
    )).toBe("unordered");
    expect(compareTelegramRevisions(
      comparable({ serial: "2" }, "quake:other"),
      current,
    )).toBe("unordered");
    expect(compareTelegramRevisions(
      comparable({ serial: "2" }, ""),
      comparable({ serial: "2" }, ""),
    )).toBe("unordered");
    expect(compareTelegramRevisions(
      comparable({ serial: "2" }, null),
      comparable({ serial: "2" }, null),
    )).toBe("unordered");
    expect(compareTelegramRevisions(
      comparable({ serial: "2" }, null),
      current,
    )).toBe("unordered");
    expect(compareTelegramRevisions(
      comparable({ eventId: null, serial: "2" }),
      comparable({ eventId: null, serial: "2" }),
    )).toBe("unordered");
  });
});
