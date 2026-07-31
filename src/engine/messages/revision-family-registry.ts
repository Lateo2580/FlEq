import type { ParsedEewInfo, TelegramMeta } from "../../types";
import type { TelegramRevisionComparator } from "../../dmdata/telegram-meta";
import type { CancellationPolicy } from "./telegram-revision-gate";

export interface RevisionFamilyPolicy<TParsed> {
  domain: string;
  revisionFamily: string;
  headTypes: readonly string[];
  comparator: TelegramRevisionComparator;
  extractStateSubjectKey: (
    meta: TelegramMeta,
    parsed: TParsed,
  ) => string | readonly string[] | null;
  extractCancellationTarget: (
    meta: TelegramMeta,
    parsed: TParsed,
  ) => readonly string[] | null;
  cancellationPolicy: CancellationPolicy;
  terminalPredicate: (meta: TelegramMeta, parsed: TParsed) => boolean;
  deactivationPredicate: (meta: TelegramMeta, parsed: TParsed) => boolean;
  fragmentMerge: false;
}

function eewPolicy(headType: "VXSE43" | "VXSE44" | "VXSE45"):
  RevisionFamilyPolicy<ParsedEewInfo> {
  return {
    domain: "eew",
    revisionFamily: headType,
    headTypes: [headType],
    comparator: "serialOnly",
    extractStateSubjectKey: (meta) =>
      meta.eventId.valid ? meta.eventId.value : null,
    extractCancellationTarget: (meta) =>
      meta.eventId.valid && meta.eventId.value != null
        ? [meta.eventId.value]
        : null,
    cancellationPolicy: "markCancelled",
    terminalPredicate: (_meta, parsed) => parsed.nextAdvisory != null,
    deactivationPredicate: (meta, parsed) =>
      meta.infoType.value === "取消" || parsed.nextAdvisory != null,
    fragmentMerge: false,
  };
}

export const EEW_REVISION_FAMILY_POLICIES = {
  VXSE43: eewPolicy("VXSE43"),
  VXSE44: eewPolicy("VXSE44"),
  VXSE45: eewPolicy("VXSE45"),
} as const;

export function eewRevisionFamilyPolicy(
  headType: string,
): RevisionFamilyPolicy<ParsedEewInfo> | null {
  return Object.hasOwn(EEW_REVISION_FAMILY_POLICIES, headType)
    ? EEW_REVISION_FAMILY_POLICIES[
        headType as keyof typeof EEW_REVISION_FAMILY_POLICIES
      ]
    : null;
}
