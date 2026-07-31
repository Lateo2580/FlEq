import { describe, expect, it } from "vitest";
import { createTelegramMeta } from "../../../src/dmdata/telegram-meta";
import {
  TelegramRevisionGate,
} from "../../../src/engine/messages/telegram-revision-gate";
import { TelegramTransportDeduplicator } from "../../../src/engine/messages/telegram-transport-dedup";
import {
  EEW_REVISION_FAMILY_POLICIES,
} from "../../../src/engine/messages/revision-family-registry";

const RECEIVED_AT = Date.parse("2026-07-31T12:10:00+09:00");

function meta(input: {
  messageId: string;
  serial: string | null;
  infoType?: string;
  reportDateTime?: string;
}) {
  return createTelegramMeta({
    messageId: input.messageId,
    eventId: "20260731120000",
    type: "VXSE45",
    reportDateTime:
      input.reportDateTime ?? "2026-07-31T12:00:00+09:00",
    serial: input.serial,
    infoType: input.infoType ?? "発表",
    receivedAtMs: RECEIVED_AT,
    status: "通常",
    isTest: false,
  });
}

function decide(
  gate: TelegramRevisionGate,
  input: {
    messageId: string;
    serial: string | null;
    infoType?: string;
    payload?: string;
    reportDateTime?: string;
  },
) {
  return gate.decide({
    domain: "eew",
    revisionFamily: "VXSE45",
    stateSubjectKey: "20260731120000",
    meta: meta(input),
    comparator: "serialOnly",
    cancellationPolicy: "markCancelled",
    terminal: false,
    payloadFingerprint: input.payload ?? "payload",
  });
}

describe("Phase 3A transport dedup", () => {
  it("primary/backup の同一 messageId を transport 層で一回にする", () => {
    const dedup = new TelegramTransportDeduplicator();
    expect(dedup.accept("same-message", RECEIVED_AT)).toBe(true);
    expect(dedup.accept("same-message", RECEIVED_AT + 1)).toBe(false);
    expect(dedup.accept("other-message", RECEIVED_AT + 1)).toBe(true);
  });
});

describe("Phase 3A EEW revision gate", () => {
  it("VXSE43/44/45 の policy を serialOnly + markCancelled で明示する", () => {
    expect(Object.keys(EEW_REVISION_FAMILY_POLICIES).sort()).toEqual([
      "VXSE43",
      "VXSE44",
      "VXSE45",
    ]);
    for (const policy of Object.values(EEW_REVISION_FAMILY_POLICIES)) {
      expect(policy).toMatchObject({
        domain: "eew",
        comparator: "serialOnly",
        cancellationPolicy: "markCancelled",
        fragmentMerge: false,
      });
    }
  });

  it("serialOnly は同一 serial の日時差を equal とし、通常報は duplicate", () => {
    const gate = new TelegramRevisionGate();
    expect(decide(gate, {
      messageId: "normal-1",
      serial: "3",
      reportDateTime: "2026-07-31T12:00:00+09:00",
    }).kind).toBe("accept");
    expect(decide(gate, {
      messageId: "normal-2",
      serial: "3",
      reportDateTime: "2026-07-31T11:59:00+09:00",
    })).toMatchObject({
      kind: "duplicate",
      relation: "equal",
      accepted: false,
    });
  });

  it("同一 serial 訂正を replaceCorrection とし、同 payload 再送だけを落とす", () => {
    const gate = new TelegramRevisionGate();
    decide(gate, {
      messageId: "normal",
      serial: "3",
      payload: "same",
    });
    const correction = decide(gate, {
      messageId: "correction-1",
      serial: "3",
      infoType: "訂正",
      payload: "same",
    });
    const repeated = decide(gate, {
      messageId: "correction-2",
      serial: "3",
      infoType: "訂正",
      payload: "same",
    });

    expect(correction).toMatchObject({
      kind: "replaceCorrection",
      relation: "equal",
      accepted: true,
      isCorrection: true,
    });
    expect(repeated.kind).toBe("semanticDuplicate");
  });

  it("小さい serial の訂正は stale、大きい serial は受理する", () => {
    const gate = new TelegramRevisionGate();
    decide(gate, { messageId: "normal", serial: "5" });
    expect(decide(gate, {
      messageId: "old-correction",
      serial: "4",
      infoType: "訂正",
    }).kind).toBe("stale");
    expect(decide(gate, {
      messageId: "new-correction",
      serial: "6",
      infoType: "訂正",
    }).kind).toBe("replaceCorrection");
  });

  it("取消を markCancelled とし、不正 serial を unordered で拒否する", () => {
    const gate = new TelegramRevisionGate();
    decide(gate, { messageId: "normal", serial: "1" });
    expect(decide(gate, {
      messageId: "cancel",
      serial: "2",
      infoType: "取消",
    }).kind).toBe("markCancelled");
    expect(decide(gate, {
      messageId: "invalid",
      serial: "serial-x",
      infoType: "訂正",
    })).toMatchObject({
      kind: "invalidRevision",
      relation: "unordered",
    });
  });

  it("EventID 欠落は単発 key で受理しつつ同一 semantic payload を拒否する", () => {
    const gate = new TelegramRevisionGate();
    const firstMeta = createTelegramMeta({
      messageId: "single-1",
      eventId: null,
      type: "VXSE45",
      reportDateTime: "2026-07-31T12:00:00+09:00",
      serial: "1",
      infoType: "訂正",
      receivedAtMs: RECEIVED_AT,
      status: "通常",
      isTest: false,
    });
    const input = {
      domain: "eew",
      revisionFamily: "VXSE45",
      stateSubjectKey: null,
      transientSubjectKey: "eew:single:VXSE45:1",
      meta: firstMeta,
      comparator: "serialOnly" as const,
      cancellationPolicy: "markCancelled" as const,
      terminal: false,
      payloadFingerprint: "same-correction",
    };

    expect(gate.decide(input)).toMatchObject({
      kind: "acceptTransient",
      accepted: true,
      isCorrection: true,
    });
    expect(gate.decide({
      ...input,
      transientSubjectKey: "eew:single:VXSE45:2",
      meta: { ...firstMeta, messageId: "single-2" },
    })).toMatchObject({
      kind: "semanticDuplicate",
      accepted: false,
    });
  });

  it("terminalPredicate の結果を cancellation policy と判定結果へ反映する", () => {
    const gate = new TelegramRevisionGate();
    const result = gate.decide({
      domain: "eew",
      revisionFamily: "VXSE45",
      stateSubjectKey: "20260731120000",
      meta: meta({ messageId: "final", serial: "7" }),
      comparator: "serialOnly",
      cancellationPolicy: "markCancelled",
      terminal: true,
      payloadFingerprint: "final",
    });

    expect(result).toMatchObject({
      kind: "markCancelled",
      accepted: true,
      isTerminal: true,
    });
  });
});
