import { createHash } from "node:crypto";
import * as log from "../../logger";
import type { TelegramRevisionGateSnapshot } from "./telegram-revision-gate";
import { TelegramRevisionGate } from "./telegram-revision-gate";
import {
  VolcanoStateHolder,
  type VolcanoHolderSnapshot,
  type VolcanoOperationalV2ResolutionAction,
  type VolcanoOperationalV2AlertResolutionV1,
  type VolcanoRepairStateV1,
} from "./volcano-state";
import { StandbyStateStore } from "../display/standby-state-store";
import {
  StandbyPersistenceAdmissionCoordinator,
  type StandbyTransactionResult,
} from "../display/standby-persistence-admission";

export interface VolcanoRuntimeSnapshot {
  schemaGeneration: 1;
  runtimeVersion: number;
  holder: VolcanoHolderSnapshot;
  gates: TelegramRevisionGateSnapshot;
  repair: VolcanoRepairStateV1;
}

export interface VolcanoAdmissionTimes {
  acceptedAtMs: number;
  classificationNowMs: number;
  expiryNowMs: number;
}

export interface VolcanoScratchRuntime {
  gate: TelegramRevisionGate;
  holder: VolcanoStateHolder;
  standby: StandbyStateStore;
  repair: VolcanoRepairStateV1;
  base: VolcanoRuntimeSnapshot;
}

export type VolcanoTransactionFamily = "volcanoAlert" | "volcanoEruption" | "volcanoAshfall";

export type VolcanoTransactionReducer<T> = (
  scratch: VolcanoScratchRuntime,
) =>
  | { kind: "accepted"; value: T; durableChanged: boolean }
  | { kind: "rejected"; reason: string };

const VOLCANO_TOUCHED_OWNERS = [
  "telegramRevisionGate",
  "standbyStateStore",
  "volcanoHolderAndRepair",
] as const;

function validRuntimeClock(value: number): boolean {
  return Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
}

function canonicalComparisonValue(
  comparison: import("../../types").TelegramRevisionComparisonInput | null,
): unknown {
  if (comparison == null) return null;
  const revision = comparison.revision;
  return {
    revision: {
      eventId: {
        raw: revision.eventId.raw,
        value: revision.eventId.value,
        valid: revision.eventId.valid,
      },
      type: {
        raw: revision.type.raw,
        value: revision.type.value,
        valid: revision.type.valid,
      },
      reportDateTime: {
        raw: revision.reportDateTime.raw,
        epochMs: revision.reportDateTime.epochMs,
        valid: revision.reportDateTime.valid,
      },
      serial: {
        raw: revision.serial.raw,
        numeric: revision.serial.numeric,
        valid: revision.serial.valid,
      },
      infoType: {
        raw: revision.infoType.raw,
        value: revision.infoType.value,
        valid: revision.infoType.valid,
      },
    },
    stateSubjectKey: comparison.stateSubjectKey,
    ...(comparison.variantRank == null ? {} : { variantRank: comparison.variantRank }),
  };
}

function sameCanonicalComparison(
  left: import("../../types").TelegramRevisionComparisonInput | null,
  right: import("../../types").TelegramRevisionComparisonInput | null,
): boolean {
  return JSON.stringify(canonicalComparisonValue(left))
    === JSON.stringify(canonicalComparisonValue(right));
}

function omissionCanonicalValue(omission: VolcanoRepairStateV1["unrecoverableAlertOmissions"][number]): unknown[] {
  return [
    omission.scope,
    omission.volcanoCode,
    omission.sourceFamily,
    canonicalComparisonValue(omission.lastKnownComparison),
    omission.reason,
  ];
}

export function volcanoOmissionFingerprint(
  omission: VolcanoRepairStateV1["unrecoverableAlertOmissions"][number],
): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(omissionCanonicalValue(omission)), "utf8")
    .digest("hex")}`;
}

export interface VolcanoRepairStatusItem {
  omissionFingerprint: string;
  scope: "volcano" | "domain";
  volcanoCode: string | null;
  lastKnownComparison: import("../../types").TelegramRevisionComparisonInput | null;
  actions: VolcanoOperationalV2ResolutionAction[];
  expectedRuntimeVersion: number;
}

export interface ResolveOperationalV2AlertOmissionRequest {
  omissionFingerprint: string;
  action: VolcanoOperationalV2ResolutionAction;
  reason: string;
  expectedRuntimeVersion: number;
}

export type ResolveOperationalV2AlertOmissionResult =
  | { kind: "committed"; resolutionId: string }
  | { kind: "notFound" | "staleVersion" | "invalidAction" | "admissionRejected" };

/** Volcano-specific adapter over the one all-domain admission boundary. */
export class VolcanoTransactionCoordinator {
  constructor(
    private readonly admission: StandbyPersistenceAdmissionCoordinator,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): VolcanoRuntimeSnapshot {
    const captured = this.admission.capture();
    return {
      schemaGeneration: 1,
      runtimeVersion: captured.domains.volcanoHolderAndRepair.runtimeVersion,
      holder: structuredClone(captured.domains.volcanoHolderAndRepair.holder),
      gates: structuredClone(captured.domains.telegramRevisionGate),
      repair: structuredClone(captured.domains.volcanoHolderAndRepair.repair),
    };
  }

  sweepAll(expiryNowMs: number): StandbyTransactionResult<import("../display/standby-persistence-admission").AllDomainSweepResult> {
    return this.admission.sweepAll(expiryNowMs);
  }

  transact<T>(
    family: VolcanoTransactionFamily,
    reduce: VolcanoTransactionReducer<T>,
  ): StandbyTransactionResult<T> {
    return this.admission.transact(
      `volcano:${family}`,
      VOLCANO_TOUCHED_OWNERS,
      (draft) => {
        const base: VolcanoRuntimeSnapshot = {
          schemaGeneration: 1,
          runtimeVersion: draft.volcanoHolderAndRepair.runtimeVersion,
          holder: structuredClone(draft.volcanoHolderAndRepair.holder),
          gates: structuredClone(draft.telegramRevisionGate),
          repair: structuredClone(draft.volcanoHolderAndRepair.repair),
        };
        const gate = TelegramRevisionGate.fromSnapshot(draft.telegramRevisionGate);
        const holder = VolcanoStateHolder.fromSnapshot(draft.volcanoHolderAndRepair.holder);
        const standby = StandbyStateStore.fromSnapshot(draft.standbyStateStore);
        const repair = structuredClone(draft.volcanoHolderAndRepair.repair);
        const result = reduce({ gate, holder, standby, repair, base });
        if (result.kind === "rejected") return result;
        const holderSnapshot = holder.snapshot();
        const gateSnapshot = gate.cloneSnapshot();
        const holderChanged = JSON.stringify(holderSnapshot) !== JSON.stringify(base.holder);
        const repairChanged = JSON.stringify(repair) !== JSON.stringify(base.repair);
        const gateChanged = JSON.stringify(gateSnapshot) !== JSON.stringify(base.gates);
        if ((holderChanged || repairChanged || gateChanged)
          && base.runtimeVersion >= Number.MAX_SAFE_INTEGER) {
          return { kind: "rejected", reason: "volcanoRuntimeVersionExhausted" };
        }
        if (holderChanged) standby.replaceVolcanoDerived(holderSnapshot);
        draft.telegramRevisionGate = gateSnapshot;
        draft.volcanoHolderAndRepair = {
          runtimeVersion: base.runtimeVersion + (holderChanged || repairChanged || gateChanged ? 1 : 0),
          holder: holderSnapshot,
          repair,
        };
        draft.standbyStateStore = standby.cloneSnapshot();
        return result;
      },
    );
  }

  status(): VolcanoRepairStatusItem[] {
    const snapshot = this.snapshot();
    return snapshot.repair.unrecoverableAlertOmissions
      .filter((omission) => omission.reason === "operationalV2ProvenanceLost")
      .map((omission) => ({
        omissionFingerprint: volcanoOmissionFingerprint(omission),
        scope: omission.scope,
        volcanoCode: omission.volcanoCode,
        lastKnownComparison: structuredClone(omission.lastKnownComparison),
        actions: omission.scope === "domain"
          ? ["acknowledgeDomainLoss"]
          : ["acceptCurrent", "clearCurrent"],
        expectedRuntimeVersion: snapshot.runtimeVersion,
      }));
  }

  resolveOperationalV2AlertOmission(
    request: ResolveOperationalV2AlertOmissionRequest,
  ): ResolveOperationalV2AlertOmissionResult {
    if (request.action !== "acceptCurrent"
      && request.action !== "clearCurrent"
      && request.action !== "acknowledgeDomainLoss") {
      return { kind: "invalidAction" };
    }
    if (typeof request.reason !== "string"
      || typeof request.omissionFingerprint !== "string"
      || !Number.isSafeInteger(request.expectedRuntimeVersion)) {
      return { kind: "invalidAction" };
    }
    const normalizedReason = request.reason.normalize("NFC");
    if (/\p{Cc}/u.test(normalizedReason)) return { kind: "invalidAction" };
    const reason = normalizedReason.trim();
    if (reason === "" || reason.length > 256) return { kind: "invalidAction" };
    const before = this.snapshot();
    if (request.expectedRuntimeVersion !== before.runtimeVersion) return { kind: "staleVersion" };
    const omission = before.repair.unrecoverableAlertOmissions.find((item) =>
      item.reason === "operationalV2ProvenanceLost"
      && volcanoOmissionFingerprint(item) === request.omissionFingerprint);
    if (omission == null) return { kind: "notFound" };
    if (omission.scope === "domain" && request.action !== "acknowledgeDomainLoss"
      || omission.scope === "volcano" && request.action === "acknowledgeDomainLoss") {
      return { kind: "invalidAction" };
    }
    const resolvedAtMs = this.now();
    if (!validRuntimeClock(resolvedAtMs)) return { kind: "admissionRejected" };
    const resolutionId = `sha256:${createHash("sha256").update(JSON.stringify([
      request.omissionFingerprint,
      request.action,
      reason,
      resolvedAtMs,
      "local-repl",
    ]), "utf8").digest("hex")}`;
    const transaction = this.transact("volcanoAlert", (scratch) => {
      if (scratch.base.runtimeVersion !== request.expectedRuntimeVersion) {
        return { kind: "rejected", reason: "staleVersion" };
      }
      const index = scratch.repair.unrecoverableAlertOmissions.findIndex((item) =>
        item.reason === "operationalV2ProvenanceLost"
        && volcanoOmissionFingerprint(item) === request.omissionFingerprint);
      if (index < 0) return { kind: "rejected", reason: "notFound" };
      const current = scratch.repair.unrecoverableAlertOmissions[index]!;
      const code = current.volcanoCode;
      if (current.scope === "volcano") {
        if (code == null) return { kind: "rejected", reason: "invalidAction" };
        const composite = scratch.holder.composite(code);
        const subject = `volcano:alert:${code}`;
        const gateEntry = scratch.gate.exportDurableEntries().find((entry) =>
          entry.domain === "volcano"
          && entry.revisionFamily === "volcanoAlert"
          && entry.stateSubjectKey === subject);
        const alert = composite?.alert ?? null;
        const semanticTail = gateEntry?.semanticKeys.at(-1);
        if (current.sourceFamily !== "unknown"
          || current.lastKnownComparison == null
          || gateEntry?.volcanoProvenance?.kind !== "alert"
          || gateEntry.volcanoProvenance.sourceFamily !== "operationalV2Unknown"
          || gateEntry.volcanoProvenance.operationalV2ResolutionId != null
          || semanticTail == null
          || !sameCanonicalComparison(current.lastKnownComparison, gateEntry.comparison)
          || alert != null && (alert.sourceFamily !== "operationalV2Unknown"
            || alert.operationalV2ResolutionId != null
            || alert.revision.reportTimeMs !== gateEntry.comparison.revision.reportDateTime.epochMs
            || alert.revision.serial !== gateEntry.comparison.revision.serial.raw
            || alert.appliedSemanticKey !== semanticTail)
          || scratch.repair.operationalV2AlertResolutions.some((resolution) =>
            resolution.omissionFingerprint === request.omissionFingerprint)) {
          return { kind: "rejected", reason: "invalidAction" };
        }
        if (request.action === "acceptCurrent") {
          if (alert == null || gateEntry.cancelled) {
            return { kind: "rejected", reason: "invalidAction" };
          }
          const holderSnapshot = scratch.holder.snapshot();
          const target = holderSnapshot.composites.find((item) => item.volcanoCode === code);
          if (target?.alert == null) return { kind: "rejected", reason: "invalidAction" };
          target.alert.operationalV2ResolutionId = resolutionId;
          scratch.holder.replacePrevalidated(holderSnapshot);
          const gateSnapshot = scratch.gate.cloneSnapshot();
          const targetGate = gateSnapshot.states.find((entry) =>
            entry.key === `volcano:volcanoAlert:${subject}`);
          if (targetGate?.volcanoProvenance?.kind !== "alert") {
            return { kind: "rejected", reason: "invalidAction" };
          }
          targetGate.volcanoProvenance.operationalV2ResolutionId = resolutionId;
          scratch.gate.replacePrevalidated(gateSnapshot);
        } else if (request.action === "clearCurrent") {
          if (alert != null && !scratch.holder.clearAlert(code)) {
            return { kind: "rejected", reason: "invalidAction" };
          }
          const gateSnapshot = scratch.gate.cloneSnapshot();
          const targetGate = gateSnapshot.states.find((entry) =>
            entry.key === `volcano:volcanoAlert:${subject}`);
          if (targetGate?.volcanoProvenance?.kind !== "alert") {
            return { kind: "rejected", reason: "invalidAction" };
          }
          targetGate.volcanoProvenance.operationalV2ResolutionId = resolutionId;
          scratch.gate.replacePrevalidated(gateSnapshot);
        }
      }
      scratch.repair.unrecoverableAlertOmissions.splice(index, 1);
      const audit: VolcanoOperationalV2AlertResolutionV1 = {
        resolutionId,
        omissionFingerprint: request.omissionFingerprint,
        scope: current.scope,
        volcanoCode: current.volcanoCode,
        action: request.action,
        resolvedAtMs,
        actor: "local-repl",
        reason,
      };
      scratch.repair.operationalV2AlertResolutions.push(audit);
      return { kind: "accepted", value: resolutionId, durableChanged: true };
    });
    if (transaction.kind === "staleVersion") return { kind: "staleVersion" };
    if (transaction.kind === "rejected") {
      if (transaction.reason === "staleVersion") return { kind: "staleVersion" };
      if (transaction.reason === "notFound") return { kind: "notFound" };
      if (transaction.reason === "invalidAction") return { kind: "invalidAction" };
      return { kind: "admissionRejected" };
    }
    log.info(`[volcano-repair] operational-v2 resolution committed action=${request.action} scope=${omission.scope} code=${omission.volcanoCode ?? "domain"} resolutionId=${resolutionId}`);
    return { kind: "committed", resolutionId };
  }
}

export interface VolcanoRepairAdministration {
  status(): VolcanoRepairStatusItem[];
  resolveOperationalV2AlertOmission(
    request: ResolveOperationalV2AlertOmissionRequest,
  ): ResolveOperationalV2AlertOmissionResult;
}
