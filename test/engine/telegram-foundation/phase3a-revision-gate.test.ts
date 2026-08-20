import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramMeta } from "../../../src/dmdata/telegram-meta";
import {
  semanticPayloadFingerprint,
  TELEGRAM_REVISION_MAX_ENTRIES,
  TELEGRAM_REVISION_MAX_SEMANTIC_KEYS,
  TelegramRevisionGate,
} from "../../../src/engine/messages/telegram-revision-gate";
import { TelegramTransportDeduplicator } from "../../../src/engine/messages/telegram-transport-dedup";
import {
  ALL_REVISION_FAMILY_POLICIES,
  EEW_REVISION_FAMILY_POLICIES,
} from "../../../src/engine/messages/revision-family-registry";

const RECEIVED_AT = Date.parse("2026-07-31T12:10:00+09:00");
const TEST_NOW = Date.parse("2026-07-31T12:30:00+09:00");

beforeEach(() => {
  vi.useFakeTimers({ now: TEST_NOW, toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

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
    durable?: boolean;
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
    durable: input.durable === true,
    tombstoneRetentionMs: input.durable === true ? null : undefined,
    maxSubjects: input.durable === true ? 1 : undefined,
    payloadFingerprint: input.payload ?? "payload",
  });
}

function capacityInput(input: {
  id: string;
  stateSubjectKey: string | null;
  transientSubjectKey?: string | null;
  receivedAtMs?: number;
  domain?: string;
  revisionFamily?: string;
  maxSubjects?: number | null;
  durable?: boolean;
  tombstoneRetentionMs?: number | null;
  retainForFamilyCapacity?: boolean;
}) {
  const stateSubjectKey = input.stateSubjectKey;
  return {
    domain: input.domain ?? "synthetic",
    revisionFamily: input.revisionFamily ?? "CAPACITY",
    stateSubjectKey,
    transientSubjectKey: input.transientSubjectKey
      ?? (stateSubjectKey == null ? `transient:${input.id}` : null),
    meta: createTelegramMeta({
      messageId: input.id,
      eventId: input.id,
      type: "CAPACITY",
      reportDateTime: "2026-07-31T12:00:00+09:00",
      serial: "1",
      infoType: "発表",
      receivedAtMs: input.receivedAtMs ?? RECEIVED_AT,
      status: "通常",
      isTest: false,
    }),
    comparator: "serialOnly" as const,
    cancellationPolicy: "markCancelled" as const,
    terminal: false,
    durable: input.durable ?? true,
    tombstoneRetentionMs: input.tombstoneRetentionMs === undefined
      ? null
      : input.tombstoneRetentionMs,
    maxSubjects: input.maxSubjects === undefined ? 1 : input.maxSubjects,
    retainForFamilyCapacity: input.retainForFamilyCapacity ?? true,
    payloadFingerprint: semanticPayloadFingerprint({ id: input.id }),
  };
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

  it("同一 revision 訂正で durable comparison と現況 semantic payload を更新する", () => {
    const gate = new TelegramRevisionGate();
    const input = (infoType: "発表" | "訂正", payload: string, messageId: string) => ({
      domain: "tsunami",
      revisionFamily: "VTSE41",
      stateSubjectKey: "tsunami:current",
      meta: createTelegramMeta({
        messageId,
        eventId: "tsunami-event",
        type: "VTSE41",
        reportDateTime: "2026-07-31T12:00:00+09:00",
        serial: null,
        infoType,
        receivedAtMs: RECEIVED_AT,
        status: "通常",
        isTest: false,
      }),
      comparator: "reportDateTimeThenSerial" as const,
      cancellationPolicy: "clearCurrent" as const,
      terminal: false,
      durable: true,
      tombstoneRetentionMs: null,
      allowMissingSerial: true,
      payloadFingerprint: semanticPayloadFingerprint(payload),
    });
    const normal = input("発表", "津波警報", "normal");
    const correction = input("訂正", "大津波警報", "correction");
    expect(gate.decide(normal).accepted).toBe(true);
    expect(gate.decide(correction).kind).toBe("replaceCorrection");

    const persisted = gate.exportDurableEntries()[0];
    expect(persisted?.comparison.revision.infoType.value).toBe("訂正");
    expect(gate.matchesCurrentAcceptedPayload(correction)).toBe(true);
    expect(gate.matchesCurrentAcceptedPayload(normal)).toBe(false);
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

  it.each([
    ["terminal", "markCancelled", true, false, "terminal"],
    ["deactivation", "clearCurrent", false, true, "deactivation"],
  ] as const)("訂正と %s trigger が同時成立しても policy mutation と訂正属性を両立する", (
    _label,
    cancellationPolicy,
    terminal,
    deactivation,
    resolvedTrigger,
  ) => {
    const gate = new TelegramRevisionGate();
    gate.decide({
      domain: "synthetic",
      revisionFamily: "TEST",
      stateSubjectKey: "subject",
      meta: meta({ messageId: `normal-${_label}`, serial: "1" }),
      comparator: "serialOnly",
      cancellationPolicy,
      terminal: false,
      deactivation: false,
      payloadFingerprint: semanticPayloadFingerprint({ _label, state: "active" }),
    });
    const result = gate.decide({
      domain: "synthetic",
      revisionFamily: "TEST",
      stateSubjectKey: "subject",
      meta: meta({ messageId: `correction-${_label}`, serial: "1", infoType: "訂正" }),
      comparator: "serialOnly",
      cancellationPolicy,
      terminal,
      deactivation,
      payloadFingerprint: semanticPayloadFingerprint({ _label, state: "terminal" }),
    });
    expect(result).toMatchObject({
      kind: cancellationPolicy,
      accepted: true,
      isCorrection: true,
      isTerminal: terminal,
      resolvedTrigger,
    });
  });

  it("semantic payload は canonical JSON の固定長 digest にする", () => {
    const first = semanticPayloadFingerprint({ secret: "payload-body", a: 1, b: 2 });
    const reordered = semanticPayloadFingerprint({ b: 2, a: 1, secret: "payload-body" });
    expect(first).toBe(reordered);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain("payload-body");
  });

  it("同一 revision の semantic key 履歴を固定上限へ圧縮する", () => {
    const gate = new TelegramRevisionGate();
    const base = {
      domain: "weather",
      revisionFamily: "VPWS50",
      stateSubjectKey: "weather:vpws50",
      comparator: "reportDateTimeThenSerial" as const,
      cancellationPolicy: "restorePrevious" as const,
      terminal: false,
      durable: true,
      tombstoneRetentionMs: 60_000,
    };
    gate.decide({
      ...base,
      meta: meta({ messageId: "base", serial: "1" }),
      payloadFingerprint: semanticPayloadFingerprint({ revision: 0 }),
    });
    for (let index = 1; index <= TELEGRAM_REVISION_MAX_SEMANTIC_KEYS * 2; index++) {
      expect(gate.decide({
        ...base,
        meta: meta({ messageId: `correction-${index}`, serial: "1", infoType: "訂正" }),
        payloadFingerprint: semanticPayloadFingerprint({ revision: index }),
      }).accepted).toBe(true);
    }
    const [entry] = gate.exportDurableEntries();
    expect(entry.semanticKeys).toHaveLength(TELEGRAM_REVISION_MAX_SEMANTIC_KEYS);
    expect(entry.semanticKeys.every((key) => key.length <= 68)).toBe(true);
  });

  it("満杯の発表・訂正・取消履歴を alias 移行時に同じ slot で置換する", () => {
    const base = {
      domain: "synthetic",
      revisionFamily: "MIXED",
      stateSubjectKey: "subject-1",
      comparator: "reportDateTimeThenSerial" as const,
      cancellationPolicy: "markCancelled" as const,
      terminal: false,
      durable: true,
      tombstoneRetentionMs: null,
      maxSubjects: 1,
    };
    const legacyFingerprints = Array.from(
      { length: TELEGRAM_REVISION_MAX_SEMANTIC_KEYS },
      (_, index) => semanticPayloadFingerprint({ version: "legacy", index }),
    );
    const canonicalFingerprints = legacyFingerprints.map((_, index) =>
      semanticPayloadFingerprint({ version: "canonical", index }));
    const infoTypeFor = (index: number): "発表" | "訂正" | "取消" =>
      index === 0
        ? "発表"
        : index === TELEGRAM_REVISION_MAX_SEMANTIC_KEYS - 1
          ? "取消"
          : "訂正";
    const inputFor = (
      index: number,
      canonical = false,
    ) => ({
      ...base,
      meta: meta({
        messageId: `${canonical ? "canonical" : "legacy"}-${index}`,
        serial: "1",
        infoType: infoTypeFor(index),
      }),
      payloadFingerprint: canonical
        ? canonicalFingerprints[index]
        : legacyFingerprints[index],
      ...(canonical ? { payloadFingerprintAliases: [legacyFingerprints[index]] } : {}),
    });

    const gate = new TelegramRevisionGate();
    for (let index = 0; index < TELEGRAM_REVISION_MAX_SEMANTIC_KEYS; index++) {
      expect(gate.decide(inputFor(index)).accepted).toBe(true);
    }
    const beforeMigration = gate.exportDurableEntries();
    expect(beforeMigration[0].semanticKeys).toHaveLength(TELEGRAM_REVISION_MAX_SEMANTIC_KEYS);
    expect(beforeMigration[0].semanticKeys.some((key) => key.startsWith("発表:"))).toBe(true);
    expect(beforeMigration[0].semanticKeys.some((key) => key.startsWith("訂正:"))).toBe(true);
    expect(beforeMigration[0].semanticKeys.some((key) => key.startsWith("取消:"))).toBe(true);

    expect(gate.decide(inputFor(TELEGRAM_REVISION_MAX_SEMANTIC_KEYS - 1, true)))
      .toMatchObject({ accepted: false, kind: "semanticDuplicate", semanticKeyMigrated: true });
    const afterLastMigration = gate.exportDurableEntries()[0].semanticKeys;
    expect(afterLastMigration).toHaveLength(TELEGRAM_REVISION_MAX_SEMANTIC_KEYS);
    expect(afterLastMigration[0]).toBe(`発表:${legacyFingerprints[0]}`);
    expect(afterLastMigration.at(-1)).toBe(
      `取消:${canonicalFingerprints[TELEGRAM_REVISION_MAX_SEMANTIC_KEYS - 1]}`,
    );

    // schedule の flush 前に落ちても旧 snapshot の alias から再び無通知移行できる。
    const unflushedRestart = new TelegramRevisionGate();
    unflushedRestart.restoreDurableEntries(beforeMigration);
    expect(unflushedRestart.decide(inputFor(
      TELEGRAM_REVISION_MAX_SEMANTIC_KEYS - 1,
      true,
    ))).toMatchObject({
      accepted: false,
      kind: "semanticDuplicate",
      semanticKeyMigrated: true,
    });

    const migratedRestart = new TelegramRevisionGate();
    migratedRestart.restoreDurableEntries(gate.exportDurableEntries());
    const replayAfterMigration = migratedRestart.decide(inputFor(
      TELEGRAM_REVISION_MAX_SEMANTIC_KEYS - 1,
      true,
    ));
    expect(replayAfterMigration).toMatchObject({
      accepted: false,
      kind: "semanticDuplicate",
    });
    expect(replayAfterMigration.semanticKeyMigrated).toBeUndefined();

    // L32 の移行で L1 は退場しない。L1 自身も同位置で移行できる。
    expect(gate.decide(inputFor(0, true))).toMatchObject({
      accepted: false,
      kind: "duplicate",
      semanticKeyMigrated: true,
    });
    const afterFirstMigration = gate.exportDurableEntries()[0].semanticKeys;
    expect(afterFirstMigration).toHaveLength(TELEGRAM_REVISION_MAX_SEMANTIC_KEYS);
    expect(afterFirstMigration[0]).toBe(`発表:${canonicalFingerprints[0]}`);

    const nextFingerprint = semanticPayloadFingerprint({ version: "canonical", index: 32 });
    expect(gate.decide({
      ...base,
      meta: meta({ messageId: "canonical-32", serial: "1", infoType: "訂正" }),
      payloadFingerprint: nextFingerprint,
    }).accepted).toBe(true);
    const afterNextRevision = gate.exportDurableEntries()[0].semanticKeys;
    expect(afterNextRevision).toHaveLength(TELEGRAM_REVISION_MAX_SEMANTIC_KEYS);
    expect(afterNextRevision[0]).toBe(`訂正:${legacyFingerprints[1]}`);
    expect(afterNextRevision.at(-2)).toBe(
      `取消:${canonicalFingerprints[TELEGRAM_REVISION_MAX_SEMANTIC_KEYS - 1]}`,
    );
    expect(afterNextRevision.at(-1)).toBe(`訂正:${nextFingerprint}`);
  });

  it("durable entry を全体上限へ圧縮し、domain 指定期間後の tombstone を除去する", () => {
    const gate = new TelegramRevisionGate();
    const familyLimit = 64;
    for (let index = 0; index <= familyLimit; index++) {
      gate.decide({
        domain: "synthetic",
        revisionFamily: "DURABLE",
        stateSubjectKey: `subject-${index}`,
        meta: createTelegramMeta({
          messageId: `durable-${index}`,
          eventId: `subject-${index}`,
          type: "DURABLE",
          reportDateTime: "2026-07-31T12:00:00+09:00",
          serial: "1",
          infoType: "発表",
          receivedAtMs: RECEIVED_AT + index,
          status: "通常",
          isTest: false,
        }),
        comparator: "reportDateTimeThenSerial",
        cancellationPolicy: "clearCurrent",
        terminal: false,
        durable: true,
        tombstoneRetentionMs: 100,
        maxSubjects: familyLimit,
        payloadFingerprint: semanticPayloadFingerprint({ index }),
      });
    }
    expect(gate.exportDurableEntries()).toHaveLength(familyLimit);

    const tombstoneSubject = "tombstone";
    gate.decide({
      domain: "synthetic",
      revisionFamily: "DURABLE",
      stateSubjectKey: tombstoneSubject,
      meta: createTelegramMeta({
        messageId: "tombstone",
        eventId: tombstoneSubject,
        type: "DURABLE",
        reportDateTime: "2026-07-31T12:00:00+09:00",
        serial: "1",
        infoType: "取消",
        receivedAtMs: RECEIVED_AT + 10_000,
        status: "通常",
        isTest: false,
      }),
      comparator: "reportDateTimeThenSerial",
      cancellationPolicy: "clearCurrent",
      terminal: false,
      durable: true,
      tombstoneRetentionMs: 100,
      payloadFingerprint: semanticPayloadFingerprint({ cancelled: true }),
    });
    gate.decide({
      domain: "synthetic",
      revisionFamily: "DURABLE",
      stateSubjectKey: "sweep-trigger",
      meta: createTelegramMeta({
        messageId: "sweep-trigger",
        eventId: "sweep-trigger",
        type: "DURABLE",
        reportDateTime: "2026-07-31T12:01:00+09:00",
        serial: "1",
        infoType: "発表",
        receivedAtMs: RECEIVED_AT + 10_101,
        status: "通常",
        isTest: false,
      }),
      comparator: "reportDateTimeThenSerial",
      cancellationPolicy: "clearCurrent",
      terminal: false,
      durable: true,
      tombstoneRetentionMs: 100,
      payloadFingerprint: semanticPayloadFingerprint({ sweep: true }),
    });
    expect(gate.exportDurableEntries().some((entry) => entry.stateSubjectKey === tombstoneSubject))
      .toBe(false);
  });

  it("無期限 cancellation tombstone を global entry 上限の eviction から保護する", () => {
    const gate = new TelegramRevisionGate();
    const protectedSubject = "heat-tombstone";
    expect(gate.decide({
      domain: "heatAlert",
      revisionFamily: "VPFT50",
      stateSubjectKey: protectedSubject,
      meta: createTelegramMeta({
        messageId: "protected-tombstone",
        eventId: protectedSubject,
        type: "VPFT50",
        reportDateTime: "2026-07-31T12:00:00+09:00",
        serial: "1",
        infoType: "取消",
        receivedAtMs: RECEIVED_AT,
        status: "通常",
        isTest: false,
      }),
      comparator: "reportDateTimeThenSerial",
      cancellationPolicy: "clearCurrent",
      terminal: false,
      durable: true,
      tombstoneRetentionMs: 3 * 24 * 60 * 60_000,
      maxSubjects: 1,
      payloadFingerprint: semanticPayloadFingerprint({ cancelled: true }),
    }).accepted).toBe(true);

    for (let index = 0; index < 3; index++) {
      gate.decide({
        domain: "raw",
        revisionFamily: "raw",
        stateSubjectKey: `subject-${index}`,
        meta: createTelegramMeta({
          messageId: `evictable-${index}`,
          eventId: `subject-${index}`,
          type: "RAW",
          reportDateTime: "2026-07-31T12:01:00+09:00",
          serial: "1",
          infoType: "発表",
          receivedAtMs: RECEIVED_AT + index + 1,
          status: "通常",
          isTest: false,
        }),
        comparator: "reportDateTimeThenSerial",
        cancellationPolicy: "clearCurrent",
        terminal: false,
        durable: false,
        tombstoneRetentionMs: 24 * 60 * 60_000,
        maxSubjects: 2,
        payloadFingerprint: semanticPayloadFingerprint({ index }),
      });
    }

    const entries = gate.exportDurableEntries();
    expect(entries).toHaveLength(1);
    expect(entries).toContainEqual(expect.objectContaining({
      stateSubjectKey: protectedSubject,
      cancelled: true,
      tombstoneRetentionMs: 3 * 24 * 60 * 60_000,
    }));

    expect(gate.decide({
      domain: "heatAlert",
      revisionFamily: "VPFT50",
      stateSubjectKey: protectedSubject,
      meta: createTelegramMeta({
        messageId: "delayed-heat",
        eventId: protectedSubject,
        type: "VPFT50",
        reportDateTime: "2026-07-31T12:00:00+09:00",
        serial: "1",
        infoType: "発表",
        receivedAtMs: RECEIVED_AT + 20_000,
        status: "通常",
        isTest: false,
      }),
      comparator: "reportDateTimeThenSerial",
      cancellationPolicy: "clearCurrent",
      terminal: false,
      durable: true,
      tombstoneRetentionMs: 3 * 24 * 60 * 60_000,
      maxSubjects: 1,
      payloadFingerprint: semanticPayloadFingerprint({ delayed: true }),
    }).kind).toBe("stale");
  });

  it("family maxSubjects 超過時に最古の非取消 entry を退場させる", () => {
    const gate = new TelegramRevisionGate();
    for (let index = 0; index < 3; index++) {
      expect(gate.decide({
        domain: "synthetic",
        revisionFamily: "BOUNDED",
        stateSubjectKey: `bounded-${index}`,
        meta: createTelegramMeta({
          messageId: `bounded-${index}`,
          eventId: `bounded-${index}`,
          type: "BOUNDED",
          reportDateTime: `2026-07-31T12:0${index}:00+09:00`,
          serial: "1",
          infoType: "発表",
          receivedAtMs: RECEIVED_AT + index,
          status: "通常",
          isTest: false,
        }),
        comparator: "reportDateTimeThenSerial",
        cancellationPolicy: "clearCurrent",
        terminal: false,
        durable: true,
        tombstoneRetentionMs: null,
        maxSubjects: 2,
        payloadFingerprint: semanticPayloadFingerprint({ index }),
      }).accepted).toBe(true);
    }

    const entries = gate.exportDurableEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.stateSubjectKey).sort())
      .toEqual(["bounded-1", "bounded-2"]);
  });

  it("無期限 tombstone だけで family 上限を超えた場合は保護したまま設計エラーを通知する", () => {
    const capacityError = vi.fn();
    const gate = new TelegramRevisionGate(capacityError);
    const decisions = [];
    for (let index = 0; index < 2; index++) {
      decisions.push(gate.decide({
        domain: "synthetic",
        revisionFamily: "BROKEN-INDEFINITE",
        stateSubjectKey: `tombstone-${index}`,
        meta: createTelegramMeta({
          messageId: `tombstone-${index}`,
          eventId: `tombstone-${index}`,
          type: "BROKEN-INDEFINITE",
          reportDateTime: `2026-07-31T12:0${index}:00+09:00`,
          serial: "1",
          infoType: "取消",
          receivedAtMs: RECEIVED_AT + index,
          status: "通常",
          isTest: false,
        }),
        comparator: "reportDateTimeThenSerial",
        cancellationPolicy: "clearCurrent",
        terminal: false,
        durable: true,
        tombstoneRetentionMs: null,
        maxSubjects: 1,
        payloadFingerprint: semanticPayloadFingerprint({ index }),
      }));
    }

    expect(decisions.map((decision) => decision.kind)).toEqual([
      "clearCurrent",
      "capacityExceeded",
    ]);
    expect(gate.exportDurableEntries()).toHaveLength(1);
    expect(capacityError).toHaveBeenCalledTimes(1);
    expect(capacityError).toHaveBeenCalledWith(expect.stringContaining(
      "rejected new subject at hard family capacity: synthetic:BROKEN-INDEFINITE (1)",
    ));
  });
});

describe("S7 capacity warning latch rearm", () => {
  it("上限到達後の拒否で警告を一度だけ出す", () => {
    const onCapacityError = vi.fn();
    const gate = new TelegramRevisionGate(onCapacityError);
    expect(gate.decide(capacityInput({ id: "full-1", stateSubjectKey: "full-1" })).accepted)
      .toBe(true);
    expect(gate.decide(capacityInput({ id: "full-2", stateSubjectKey: "full-2" }))).toMatchObject({
      kind: "capacityExceeded",
      accepted: false,
    });
    expect(gate.decide(capacityInput({ id: "full-3", stateSubjectKey: "full-3" })).kind)
      .toBe("capacityExceeded");
    expect(onCapacityError).toHaveBeenCalledTimes(1);
  });

  it("1 件 clear 後に再上限へ達すると警告を再武装する", () => {
    const onCapacityError = vi.fn();
    const gate = new TelegramRevisionGate(onCapacityError);
    gate.decide(capacityInput({ id: "clear-1", stateSubjectKey: "clear-1" }));
    expect(gate.decide(capacityInput({ id: "clear-reject-1", stateSubjectKey: "clear-reject-1" })).kind)
      .toBe("capacityExceeded");

    gate.clear("synthetic", "CAPACITY", "clear-1");
    expect(gate.decide(capacityInput({ id: "clear-2", stateSubjectKey: "clear-2" })).accepted)
      .toBe(true);
    expect(gate.decide(capacityInput({ id: "clear-reject-2", stateSubjectKey: "clear-reject-2" })).kind)
      .toBe("capacityExceeded");
    expect(onCapacityError).toHaveBeenCalledTimes(2);
  });

  it("expiry で空きができた後に警告を再武装する", () => {
    const onCapacityError = vi.fn();
    const gate = new TelegramRevisionGate(onCapacityError);
    gate.decide(capacityInput({ id: "expire-1", stateSubjectKey: "expire-1" }));
    expect(gate.decide(capacityInput({ id: "expire-reject-1", stateSubjectKey: "expire-reject-1" })).kind)
      .toBe("capacityExceeded");

    expect(gate.expireRevisionFamily("synthetic", "CAPACITY", RECEIVED_AT + 101, 100))
      .toBe(true);
    expect(gate.decide(capacityInput({
      id: "expire-2",
      stateSubjectKey: "expire-2",
      receivedAtMs: RECEIVED_AT + 101,
    })).accepted).toBe(true);
    expect(gate.decide(capacityInput({
      id: "expire-reject-2",
      stateSubjectKey: "expire-reject-2",
      receivedAtMs: RECEIVED_AT + 101,
    })).kind).toBe("capacityExceeded");
    expect(onCapacityError).toHaveBeenCalledTimes(2);
  });

  it("decide 冒頭の自動 sweep による期限切れ削除でも警告を再武装する", () => {
    const onCapacityError = vi.fn();
    const gate = new TelegramRevisionGate(onCapacityError);
    gate.decide(capacityInput({
      id: "sweep-1",
      stateSubjectKey: "sweep-1",
      durable: false,
      tombstoneRetentionMs: 60_000,
    }));
    expect(gate.decide(capacityInput({ id: "sweep-reject-1", stateSubjectKey: "sweep-reject-1" })).kind)
      .toBe("capacityExceeded");

    expect(gate.decide(capacityInput({
      id: "sweep-2",
      stateSubjectKey: "sweep-2",
      receivedAtMs: RECEIVED_AT + 61_000,
    })).accepted).toBe(true);
    expect(gate.decide(capacityInput({
      id: "sweep-reject-2",
      stateSubjectKey: "sweep-reject-2",
      receivedAtMs: RECEIVED_AT + 61_000,
    })).kind).toBe("capacityExceeded");
    expect(onCapacityError).toHaveBeenCalledTimes(2);
  });

  it("regular と transient の合計で family occupancy を再評価する", () => {
    const onCapacityError = vi.fn();
    const gate = new TelegramRevisionGate(onCapacityError);
    gate.decide(capacityInput({ id: "mixed-regular", stateSubjectKey: "mixed-regular" }));
    expect(gate.decide(capacityInput({ id: "mixed-reject", stateSubjectKey: "mixed-reject" })).kind)
      .toBe("capacityExceeded");

    gate.decide(capacityInput({
      id: "mixed-transient",
      stateSubjectKey: null,
      transientSubjectKey: "mixed-transient",
      durable: false,
      maxSubjects: null,
      tombstoneRetentionMs: 60_000,
      retainForFamilyCapacity: false,
    }));
    gate.clear("synthetic", "CAPACITY", "mixed-regular");
    gate.clear("synthetic", "CAPACITY", "mixed-transient");

    gate.decide(capacityInput({ id: "mixed-regular-2", stateSubjectKey: "mixed-regular-2" }));
    expect(gate.decide(capacityInput({ id: "mixed-reject-2", stateSubjectKey: "mixed-reject-2" })).kind)
      .toBe("capacityExceeded");
    expect(onCapacityError).toHaveBeenCalledTimes(2);
  });

  it("family clear は対象 family だけを再武装する", () => {
    const onCapacityError = vi.fn();
    const gate = new TelegramRevisionGate(onCapacityError);
    gate.decide(capacityInput({
      id: "family-a-1",
      stateSubjectKey: "family-a-1",
      revisionFamily: "FAMILY-A",
    }));
    expect(gate.decide(capacityInput({
      id: "family-a-reject-1",
      stateSubjectKey: "family-a-reject-1",
      revisionFamily: "FAMILY-A",
    })).kind).toBe("capacityExceeded");
    gate.decide(capacityInput({
      id: "family-b-1",
      stateSubjectKey: "family-b-1",
      revisionFamily: "FAMILY-B",
    }));
    expect(gate.decide(capacityInput({
      id: "family-b-reject-1",
      stateSubjectKey: "family-b-reject-1",
      revisionFamily: "FAMILY-B",
    })).kind).toBe("capacityExceeded");
    expect(onCapacityError).toHaveBeenCalledTimes(2);

    gate.clearFamily("synthetic", "FAMILY-A");
    expect(gate.decide(capacityInput({
      id: "family-b-reject-2",
      stateSubjectKey: "family-b-reject-2",
      revisionFamily: "FAMILY-B",
    })).kind).toBe("capacityExceeded");
    expect(onCapacityError).toHaveBeenCalledTimes(2);
    gate.decide(capacityInput({
      id: "family-a-2",
      stateSubjectKey: "family-a-2",
      revisionFamily: "FAMILY-A",
    }));
    expect(gate.decide(capacityInput({
      id: "family-a-reject-2",
      stateSubjectKey: "family-a-reject-2",
      revisionFamily: "FAMILY-A",
    })).kind).toBe("capacityExceeded");
    expect(onCapacityError).toHaveBeenCalledTimes(3);
  });

  it("全 clear 後は全 family の警告を再武装する", () => {
    const onCapacityError = vi.fn();
    const gate = new TelegramRevisionGate(onCapacityError);
    gate.decide(capacityInput({ id: "all-clear-1", stateSubjectKey: "all-clear-1" }));
    expect(gate.decide(capacityInput({ id: "all-clear-reject-1", stateSubjectKey: "all-clear-reject-1" })).kind)
      .toBe("capacityExceeded");
    expect(onCapacityError).toHaveBeenCalledTimes(1);

    gate.clear();
    gate.decide(capacityInput({ id: "all-clear-2", stateSubjectKey: "all-clear-2" }));
    expect(gate.decide(capacityInput({ id: "all-clear-reject-2", stateSubjectKey: "all-clear-reject-2" })).kind)
      .toBe("capacityExceeded");
    expect(onCapacityError).toHaveBeenCalledTimes(2);
  });
});

describe("Phase 3B clearCurrent cancellation latch", () => {
  const affectedPolicies = ALL_REVISION_FAMILY_POLICIES.filter((policy) =>
    policy.cancellationPolicy === "clearCurrent"
    && (
      policy.domain === "tsunami"
      || policy.domain === "tsunamiObservation"
      || policy.domain === "weather" && policy.revisionFamily === "VPWW56"
      || policy.domain === "volcano"
      || policy.domain === "floodForecast"
    ));

  it.each(affectedPolicies.map((policy) => [
    `${policy.domain}:${policy.revisionFamily}`,
    policy,
  ] as const))("%s rejects an equal-revision correction after cancellation, including restart", (_label, policy) => {
    const gate = new TelegramRevisionGate();
    const receivedAtMs = Date.now();
    const input = (infoType: "発表" | "訂正" | "取消", serial: string, payload: string) => ({
      domain: policy.domain,
      revisionFamily: policy.revisionFamily,
      stateSubjectKey: `${policy.domain}:test-subject`,
      meta: createTelegramMeta({
        messageId: `${policy.domain}-${infoType}-${payload}`,
        eventId: "event-1",
        type: policy.headTypes[0]!,
        reportDateTime: "2026-07-31T12:00:00+09:00",
        serial,
        infoType,
        receivedAtMs,
        status: "通常",
        isTest: false,
      }),
      comparator: policy.comparator,
      cancellationPolicy: policy.cancellationPolicy,
      terminal: false,
      cancellationTargetMatches: true,
      durable: true,
      tombstoneRetentionMs: policy.tombstoneRetentionMs,
      maxSubjects: policy.maxSubjects,
      allowMissingSerial: policy.allowMissingSerial,
      payloadFingerprint: semanticPayloadFingerprint(payload),
    });
    expect(gate.decide(input("発表", "1", "active")).accepted).toBe(true);
    expect(gate.decide(input("取消", "2", "cancel")).kind).toBe("clearCurrent");
    expect(gate.decide(input("訂正", "2", "late-correction"))).toMatchObject({
      kind: "stale",
      accepted: false,
    });

    const restarted = new TelegramRevisionGate();
    restarted.restoreDurableEntries(gate.exportDurableEntries());
    expect(restarted.decide(input("訂正", "2", "restart-correction"))).toMatchObject({
      kind: "stale",
      accepted: false,
    });
  });

  it("keeps markCancelled correction reactivation for EEW", () => {
    const gate = new TelegramRevisionGate();
    expect(decide(gate, { messageId: "active", serial: "1", payload: "active", durable: true }).accepted).toBe(true);
    expect(decide(gate, {
      messageId: "cancel",
      serial: "2",
      infoType: "取消",
      payload: "cancel",
      durable: true,
    }).kind).toBe("markCancelled");
    expect(decide(gate, {
      messageId: "correction",
      serial: "2",
      infoType: "訂正",
      payload: "corrected-active",
      durable: true,
    })).toMatchObject({ kind: "replaceCorrection", accepted: true });
    expect(gate.exportDurableEntries()[0]?.cancelled).toBe(false);
  });
});

describe("Phase 3B trigger and transient capacity contracts", () => {
  it.each([
    ["取消", true, true, "explicitCancellation"],
    ["発表", true, true, "terminal"],
    ["発表", false, true, "deactivation"],
  ] as const)("resolves A > B > C once", (
    infoType,
    terminal,
    deactivation,
    resolvedTrigger,
  ) => {
    const gate = new TelegramRevisionGate();
    const result = gate.decide({
      domain: "synthetic",
      revisionFamily: "TRIGGERS",
      stateSubjectKey: "subject",
      meta: meta({ messageId: `trigger-${resolvedTrigger}`, serial: "1", infoType }),
      comparator: "serialOnly",
      cancellationPolicy: "clearCurrent",
      terminal,
      deactivation,
      maxSubjects: 1,
      payloadFingerprint: semanticPayloadFingerprint({ resolvedTrigger }),
    });
    expect(result).toMatchObject({
      kind: "clearCurrent",
      accepted: true,
      resolvedTrigger,
    });
  });

  it("uses the family retention and family capacity for missing EventID", () => {
    const gate = new TelegramRevisionGate();
    const input = (id: string, receivedAtMs: number) => ({
      domain: "climateInfo",
      revisionFamily: "climateInfo",
      stateSubjectKey: null,
      transientSubjectKey: `climate:single:${id}`,
      meta: createTelegramMeta({
        messageId: id,
        eventId: null,
        type: "VPZI50",
        reportDateTime: "2026-07-31T12:00:00+09:00",
        serial: "1",
        infoType: "発表",
        receivedAtMs,
        status: "通常",
        isTest: false,
      }),
      comparator: "reportDateTimeThenSerial" as const,
      cancellationPolicy: "markCancelled" as const,
      terminal: false,
      durable: false,
      tombstoneRetentionMs: 30 * 24 * 60 * 60_000,
      maxSubjects: 2,
      payloadFingerprint: semanticPayloadFingerprint({ payload: id }),
    });

    expect(gate.decide(input("first", RECEIVED_AT)).accepted).toBe(true);
    expect(gate.decide({
      ...input("retry", RECEIVED_AT + 12 * 60_000),
      payloadFingerprint: semanticPayloadFingerprint({ payload: "first" }),
    }).kind).toBe("semanticDuplicate");

    expect(gate.decide(input("second", RECEIVED_AT + 13 * 60_000)).accepted).toBe(true);
    expect(gate.decide(input("third", RECEIVED_AT + 14 * 60_000)).accepted).toBe(true);
    expect(gate.decide(input("first", RECEIVED_AT + 15 * 60_000)).accepted).toBe(true);
  });
});
