import type { ParsedEewInfo, ParsedWeatherWarning, TelegramMeta } from "../../types";
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
  /** durable active watermark を永続化する。tombstone は下記の domain 規則で compact する。 */
  durable: boolean;
  /** durable tombstone の domain 固有保持期間。null は固定 subject のため期限なし。 */
  tombstoneRetentionMs: number | null;
  /** serial が構造上省略される family のみ明示して許可する。 */
  allowMissingSerial?: boolean;
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
    durable: false,
    tombstoneRetentionMs: null,
    fragmentMerge: false,
  };
}

const VPWS50_SUBJECT = "weather:vpws50";

export const VPWS50_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedWeatherWarning> = {
  domain: "weather",
  revisionFamily: "VPWS50",
  headTypes: ["VPWS50"],
  comparator: "reportDateTimeThenSerial",
  // VPWS50 holder は全国集約 stream を一つだけ保持する。EventID は state 粒度ではない。
  extractStateSubjectKey: () => VPWS50_SUBJECT,
  extractCancellationTarget: () => [VPWS50_SUBJECT],
  cancellationPolicy: "restorePrevious",
  terminalPredicate: () => false,
  deactivationPredicate: () => false,
  durable: true,
  // 全国集約の固定 1 subject なので増殖しない。restorePrevious の B tombstone は期限なく保つ。
  tombstoneRetentionMs: null,
  allowMissingSerial: true,
  fragmentMerge: false,
};

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
