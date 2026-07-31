import { describe, expect, it } from "vitest";
import { createTelegramMeta } from "../../../src/dmdata/telegram-meta";
import {
  semanticPayloadFingerprint,
  TelegramRevisionGate,
  type TelegramRevisionDecision,
  type TelegramRevisionGateInput,
} from "../../../src/engine/messages/telegram-revision-gate";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import type { ParsedTsunamiInfo } from "../../../src/types";

function tsunami(
  reportDateTime: string,
  infoType: "発表" | "訂正" | "取消",
  kind = "津波警報",
): ParsedTsunamiInfo {
  const meta = createTelegramMeta({
    messageId: `${infoType}:${reportDateTime}:${kind}`,
    eventId: "tsunami",
    type: "VTSE41",
    reportDateTime,
    serial: null,
    infoType,
    receivedAtMs: Date.parse(reportDateTime) || 1,
    status: "通常",
    isTest: false,
  });
  return {
    meta,
    type: "VTSE41",
    infoType,
    title: "津波警報・注意報・予報",
    reportDateTime,
    headline: null,
    publishingOffice: "気象庁",
    forecast: infoType === "取消" ? [] : [
      { areaName: "岩手県", kind, maxHeightDescription: "3m", firstHeight: "到達中と推測" },
    ],
    warningComment: "",
    isTest: false,
  };
}

function gateInput(info: ParsedTsunamiInfo): TelegramRevisionGateInput {
  return {
    domain: "tsunami",
    revisionFamily: "VTSE41",
    stateSubjectKey: "tsunami:current",
    meta: info.meta,
    comparator: "reportDateTimeThenSerial",
    cancellationPolicy: "clearCurrent",
    terminal: false,
    deactivation: false,
    cancellationTargetMatches: true,
    durable: true,
    tombstoneRetentionMs: null,
    allowMissingSerial: true,
    payloadFingerprint: semanticPayloadFingerprint(info),
  };
}

function apply(
  gate: TelegramRevisionGate,
  holder: TsunamiStateHolder,
  info: ParsedTsunamiInfo,
): TelegramRevisionDecision {
  const decision = gate.decide(gateInput(info));
  if (!decision.accepted) return decision;
  if (decision.kind === "clearCurrent") holder.clearActive();
  else holder.applyAccepted(info);
  return decision;
}

describe("tsunami common revision gate 敵対シーケンス", () => {
  it("遅着取消と順序逆転した格下げ報を棄却する", () => {
    const gate = new TelegramRevisionGate();
    const holder = new TsunamiStateHolder();
    expect(apply(gate, holder, tsunami("2025-01-01T00:02:00+09:00", "発表", "大津波警報")).accepted).toBe(true);
    expect(apply(gate, holder, tsunami("2025-01-01T00:01:00+09:00", "取消")).kind).toBe("stale");
    expect(apply(gate, holder, tsunami("2025-01-01T00:01:00+09:00", "発表", "津波注意報")).kind).toBe("stale");
    expect(holder.getLevel()).toBe("大津波警報");
  });

  it("取消後は遅着旧報を拒否し、より新しい発表だけ復活させる", () => {
    const gate = new TelegramRevisionGate();
    const holder = new TsunamiStateHolder();
    expect(apply(gate, holder, tsunami("2025-01-01T00:01:00+09:00", "発表")).kind).toBe("accept");
    expect(apply(gate, holder, tsunami("2025-01-01T00:02:00+09:00", "取消")).kind).toBe("clearCurrent");
    expect(apply(gate, holder, tsunami("2025-01-01T00:01:30+09:00", "発表")).kind).toBe("stale");
    expect(holder.getLevel()).toBeNull();
    expect(apply(gate, holder, tsunami("2025-01-01T00:03:00+09:00", "発表", "大津波警報")).kind).toBe("accept");
    expect(holder.getLevel()).toBe("大津波警報");
  });

  it("invalid ReportDateTime を拒否し watermark と state を汚染しない", () => {
    const gate = new TelegramRevisionGate();
    const holder = new TsunamiStateHolder();
    expect(apply(gate, holder, tsunami("not-a-date", "発表")).kind).toBe("invalidRevision");
    expect(holder.getLevel()).toBeNull();
    expect(apply(gate, holder, tsunami("2025-01-01T00:01:00+09:00", "発表")).kind).toBe("accept");
    expect(holder.getLevel()).toBe("津波警報");
  });
});
