import type {
  RevisionRelation,
  TelegramMeta,
  TelegramRevisionComparisonInput,
} from "../../types";
import {
  compareTelegramRevisions,
  telegramRevision,
  type TelegramRevisionComparator,
} from "../../dmdata/telegram-meta";

export type CancellationPolicy =
  | "restorePrevious"
  | "clearCurrent"
  | "markCancelled";

export type TelegramRevisionDecisionKind =
  | "accept"
  | "acceptTransient"
  | "replaceCorrection"
  | "markCancelled"
  | "restorePrevious"
  | "clearCurrent"
  | "duplicate"
  | "semanticDuplicate"
  | "stale"
  | "invalidMeta"
  | "invalidRevision"
  | "cancelTargetMismatch";

export interface TelegramRevisionDecision {
  kind: TelegramRevisionDecisionKind;
  relation: RevisionRelation | null;
  accepted: boolean;
  isCorrection: boolean;
  isTerminal: boolean;
}

export interface TelegramRevisionGateInput {
  domain: string;
  revisionFamily: string;
  stateSubjectKey: string | null;
  transientSubjectKey?: string | null;
  meta: TelegramMeta;
  comparator: TelegramRevisionComparator;
  cancellationPolicy: CancellationPolicy;
  terminal: boolean;
  payloadFingerprint: string;
}

interface AcceptedRevisionState {
  comparison: TelegramRevisionComparisonInput;
  semanticKeys: Set<string>;
  cancelled: boolean;
  acceptedAtMs: number;
}

const REVISION_GATE_RETENTION_MS = 11 * 60_000;
const REVISION_GATE_MAX_ENTRIES = 4096;

function reject(
  kind: Exclude<
    TelegramRevisionDecisionKind,
    | "accept"
    | "acceptTransient"
    | "replaceCorrection"
    | "markCancelled"
    | "restorePrevious"
    | "clearCurrent"
  >,
  relation: RevisionRelation | null,
): TelegramRevisionDecision {
  return {
    kind,
    relation,
    accepted: false,
    isCorrection: false,
    isTerminal: false,
  };
}

function acceptedKind(
  input: TelegramRevisionGateInput,
):
  | "accept"
  | "replaceCorrection"
  | "markCancelled"
  | "restorePrevious"
  | "clearCurrent" {
  if (input.meta.infoType.value === "訂正") return "replaceCorrection";
  if (input.meta.infoType.value === "取消" || input.terminal) {
    return input.cancellationPolicy;
  }
  return "accept";
}

function semanticKey(input: TelegramRevisionGateInput): string {
  return `${input.meta.infoType.value}:${input.payloadFingerprint}`;
}

/**
 * domain/revisionFamily/subject 単位の意味 revision gate。
 * transport messageId は扱わず、同一 revision の通常報・訂正・取消だけを判定する。
 */
export class TelegramRevisionGate {
  private readonly states = new Map<string, AcceptedRevisionState>();
  private readonly transientStates = new Map<
    string,
    { semanticKey: string; acceptedAtMs: number }
  >();
  private readonly transientSemanticKeys = new Map<string, string>();

  decide(input: TelegramRevisionGateInput): TelegramRevisionDecision {
    this.sweep(input.meta.receivedAtMs);
    const infoType = input.meta.infoType;
    if (!infoType.valid || infoType.value == null) {
      return reject("invalidMeta", null);
    }
    if (
      !input.meta.type.valid
      || input.meta.type.value == null
      || !input.meta.reportDateTime.valid
      || input.meta.reportDateTime.epochMs == null
      || !input.meta.serial.valid
      || input.meta.serial.numeric == null
    ) {
      return reject("invalidRevision", "unordered");
    }

    if (
      input.stateSubjectKey == null
      || input.stateSubjectKey === ""
      || !input.meta.eventId.valid
      || input.meta.eventId.value == null
    ) {
      if (
        input.transientSubjectKey == null
        || input.transientSubjectKey === ""
      ) {
        return reject("invalidMeta", null);
      }
      const transientSemanticKey = [
        input.domain,
        input.revisionFamily,
        input.meta.reportDateTime.raw,
        input.meta.serial.raw,
        input.meta.infoType.raw,
        input.payloadFingerprint,
      ].join(":");
      if (this.transientSemanticKeys.has(transientSemanticKey)) {
        return reject("semanticDuplicate", "equal");
      }
      if (this.transientStates.has(input.transientSubjectKey)) {
        return reject("invalidMeta", null);
      }
      this.transientStates.set(input.transientSubjectKey, {
        semanticKey: transientSemanticKey,
        acceptedAtMs: input.meta.receivedAtMs,
      });
      this.transientSemanticKeys.set(
        transientSemanticKey,
        input.transientSubjectKey,
      );
      return {
        kind: "acceptTransient",
        relation: null,
        accepted: true,
        isCorrection: infoType.value === "訂正",
        isTerminal: input.terminal,
      };
    }

    const key = `${input.domain}:${input.revisionFamily}:${input.stateSubjectKey}`;
    const incomingComparison: TelegramRevisionComparisonInput = {
      revision: telegramRevision(input.meta),
      stateSubjectKey: input.stateSubjectKey,
    };
    const existing = this.states.get(key);
    const nextSemanticKey = semanticKey(input);

    if (existing == null) {
      const kind = acceptedKind(input);
      this.states.set(key, {
        comparison: incomingComparison,
        semanticKeys: new Set([nextSemanticKey]),
        cancelled: input.terminal || kind === "markCancelled",
        acceptedAtMs: input.meta.receivedAtMs,
      });
      return {
        kind,
        relation: "newer",
        accepted: true,
        isCorrection: kind === "replaceCorrection",
        isTerminal: input.terminal,
      };
    }

    const relation = compareTelegramRevisions(
      incomingComparison,
      existing.comparison,
      input.comparator,
    );
    if (relation === "older") return reject("stale", relation);
    if (relation === "unordered") return reject("invalidRevision", relation);

    if (relation === "equal") {
      if (infoType.value === "発表") return reject("duplicate", relation);
      if (existing.semanticKeys.has(nextSemanticKey)) {
        return reject("semanticDuplicate", relation);
      }
      if (infoType.value === "取消" && existing.cancelled) {
        return reject("semanticDuplicate", relation);
      }
      const kind = acceptedKind(input);
      existing.semanticKeys.add(nextSemanticKey);
      existing.cancelled = input.terminal || kind === "markCancelled";
      existing.acceptedAtMs = input.meta.receivedAtMs;
      return {
        kind,
        relation,
        accepted: true,
        isCorrection: kind === "replaceCorrection",
        isTerminal: input.terminal,
      };
    }

    const kind = acceptedKind(input);
    this.states.set(key, {
      comparison: incomingComparison,
      semanticKeys: new Set([nextSemanticKey]),
      cancelled: input.terminal || kind === "markCancelled",
      acceptedAtMs: input.meta.receivedAtMs,
    });
    return {
      kind,
      relation,
      accepted: true,
      isCorrection: kind === "replaceCorrection",
      isTerminal: input.terminal,
    };
  }

  clear(domain: string, revisionFamily: string, stateSubjectKey: string): void {
    this.states.delete(`${domain}:${revisionFamily}:${stateSubjectKey}`);
  }

  private sweep(nowMs: number): void {
    for (const [key, state] of this.states) {
      if (nowMs - state.acceptedAtMs > REVISION_GATE_RETENTION_MS) {
        this.states.delete(key);
      }
    }
    for (const [subjectKey, state] of this.transientStates) {
      if (nowMs - state.acceptedAtMs > REVISION_GATE_RETENTION_MS) {
        this.transientStates.delete(subjectKey);
        this.transientSemanticKeys.delete(state.semanticKey);
      }
    }
    while (this.states.size > REVISION_GATE_MAX_ENTRIES) {
      const oldest = this.states.keys().next().value as string | undefined;
      if (oldest == null) break;
      this.states.delete(oldest);
    }
    while (this.transientStates.size > REVISION_GATE_MAX_ENTRIES) {
      const oldest = this.transientStates.keys().next().value as
        | string
        | undefined;
      if (oldest == null) break;
      const state = this.transientStates.get(oldest);
      this.transientStates.delete(oldest);
      if (state != null) {
        this.transientSemanticKeys.delete(state.semanticKey);
      }
    }
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value == null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function semanticPayloadFingerprint(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
