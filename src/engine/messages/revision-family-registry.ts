import type {
  ParsedEewInfo,
  ParsedTsunamiInfo,
  ParsedVolcanoInfo,
  ParsedVolcanoTextInfo,
  ParsedWeatherWarning,
  TelegramMeta,
  TsunamiObservationStation,
  VolcanoAlertStateEntry,
} from "../../types";
import type { TelegramRevisionComparator } from "../../dmdata/telegram-meta";
import {
  semanticPayloadFingerprint,
  TELEGRAM_REVISION_MAX_ENTRIES,
  type CancellationPolicy,
} from "./telegram-revision-gate";
import { resolveTsunamiLevel } from "../../utils/tsunami-kind";
import { TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY } from "./tsunami-state";
import {
  VPWW56_MAX_SUBJECTS,
  VPWW56_TOMBSTONE_RETENTION_MS,
  vpww56HasActiveAreas,
  vpww56StateSubjectKey,
} from "./vpww56-state";

interface RevisionFamilyPolicyBase<TParsed> {
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
  /** family が保持し得る subject 数。durable な無期限 tombstone では有限値を必須とする。 */
  maxSubjects: number | null;
  /** serial が構造上省略される family のみ明示して許可する。 */
  allowMissingSerial?: boolean;
}

export const FRAGMENT_MERGE_ALLOWLIST_KEYS = [
  "tsunamiObservation:VTSE51",
  "tsunamiObservation:VTSE52",
] as const;

export type FragmentMergeAllowlistKey = typeof FRAGMENT_MERGE_ALLOWLIST_KEYS[number];

export type RevisionFamilyPolicy<TParsed, TItem = never> = RevisionFamilyPolicyBase<TParsed> & (
  | {
      fragmentMerge: false;
      extractItems?: never;
      itemSubjectKey?: never;
      itemFingerprint?: never;
      fingerprintVersion?: never;
      fragmentEvidence?: never;
      fragmentAllowlistKey?: never;
    }
  | {
      fragmentMerge: true;
      fragmentAllowlistKey: FragmentMergeAllowlistKey;
      extractItems: (parsed: TParsed) => readonly TItem[];
      itemSubjectKey: (meta: TelegramMeta, item: TItem) => string | null;
      itemFingerprint: (item: TItem) => string;
      fingerprintVersion: string;
      fragmentEvidence: {
        corpusFixtures: readonly string[];
        regressionTests: readonly string[];
        rationale: string;
      };
    }
);

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
    maxSubjects: null,
    fragmentMerge: false,
  };
}

const VPWS50_SUBJECT = "weather:vpws50";
const TSUNAMI_CURRENT_SUBJECT = "tsunami:current";
export const VOLCANO_MAX_SUBJECTS = 512;
export const VOLCANO_ALERT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const VOLCANO_ERUPTION_TOMBSTONE_RETENTION_MS = 2 * 24 * 60 * 60_000;

export function volcanoAlertSubjectKey(volcanoCode: string): string | null {
  const code = volcanoCode.trim();
  return code === "" ? null : `volcano:alert:${code}`;
}

export function volcanoEruptionSubjectKey(volcanoCode: string): string | null {
  const code = volcanoCode.trim();
  return code === "" ? null : `volcano:eruption:${code}`;
}

function volcanoAlertSubjects(parsed: ParsedVolcanoInfo): string | readonly string[] | null {
  if (parsed.kind === "alert") return volcanoAlertSubjectKey(parsed.volcanoCode);
  if (parsed.kind !== "text" || parsed.type !== "VFVO51") return null;
  const subjects = volcanoTextAlertStateEntries(parsed).flatMap((entry) => {
    const subject = volcanoAlertSubjectKey(entry.volcanoCode);
    return subject == null ? [] : [subject];
  });
  return [...new Set(subjects)];
}

/** Phase 3B 導入前 DTO も受けつつ、VFVO51 の数値／非数値 state 候補を統一する。 */
export function volcanoTextAlertStateEntries(
  parsed: ParsedVolcanoTextInfo,
): VolcanoAlertStateEntry[] {
  if (parsed.alertStateEntries != null) {
    return parsed.alertStateEntries.map((entry) => ({
      ...entry,
      alertClass: entry.alertClass == null ? null : { ...entry.alertClass },
    }));
  }
  if (parsed.alertClasses.length > 0) {
    return parsed.alertClasses.map((entry) => ({
      volcanoCode: entry.volcanoCode,
      volcanoName: entry.volcanoName,
      alertLevel: null,
      alertLevelCode: entry.alertClass.code,
      action: entry.alertClass.isActive ? "continue" : "release",
      warningKind: entry.alertClass.name,
      alertClass: { ...entry.alertClass },
    }));
  }
  const subject = volcanoAlertSubjectKey(parsed.volcanoCode);
  if (subject == null || parsed.alertLevelCode == null) return [];
  return [{
    volcanoCode: parsed.volcanoCode,
    volcanoName: parsed.volcanoName,
    alertLevel: parsed.alertLevel,
    alertLevelCode: parsed.alertLevelCode,
    action: parsed.infoType === "取消" ? "cancel" : "continue",
    warningKind: "",
    alertClass: null,
  }];
}

function volcanoAlertIsInactive(parsed: ParsedVolcanoInfo): boolean {
  if (parsed.kind === "alert") {
    return parsed.action === "release"
      || parsed.action === "cancel"
      || parsed.alertLevel === 1 && (parsed.action === "continue" || parsed.action === "lower");
  }
  return parsed.kind === "text"
    && parsed.type === "VFVO51"
    && volcanoTextAlertStateEntries(parsed).length === 1
    && (() => {
      const entry = volcanoTextAlertStateEntries(parsed)[0];
      return entry.action === "release"
        || entry.action === "cancel"
        || entry.alertLevel === 1 && (entry.action === "continue" || entry.action === "lower")
        || entry.alertClass?.isActive === false;
    })();
}

export const VOLCANO_ALERT_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedVolcanoInfo> = {
  domain: "volcano",
  revisionFamily: "volcanoAlert",
  headTypes: ["VFVO50", "VFVO51", "VFSVii"],
  comparator: "reportDateTimeThenSerial",
  extractStateSubjectKey: (_meta, parsed) => volcanoAlertSubjects(parsed),
  extractCancellationTarget: (_meta, parsed) => {
    const extracted = volcanoAlertSubjects(parsed);
    return extracted == null ? null : typeof extracted === "string" ? [extracted] : extracted;
  },
  cancellationPolicy: "clearCurrent",
  terminalPredicate: () => false,
  deactivationPredicate: (_meta, parsed) => volcanoAlertIsInactive(parsed),
  durable: true,
  tombstoneRetentionMs: VOLCANO_ALERT_TOMBSTONE_RETENTION_MS,
  maxSubjects: VOLCANO_MAX_SUBJECTS,
  allowMissingSerial: true,
  fragmentMerge: false,
};

export const VOLCANO_ERUPTION_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedVolcanoInfo> = {
  domain: "volcano",
  revisionFamily: "volcanoEruption",
  headTypes: ["VFVO52", "VFVO56"],
  comparator: "reportDateTimeThenSerial",
  extractStateSubjectKey: (_meta, parsed) => parsed.kind === "eruption"
    ? volcanoEruptionSubjectKey(parsed.volcanoCode)
    : null,
  extractCancellationTarget: (_meta, parsed) => {
    if (parsed.kind !== "eruption") return null;
    const subject = volcanoEruptionSubjectKey(parsed.volcanoCode);
    return subject == null ? null : [subject];
  },
  cancellationPolicy: "clearCurrent",
  terminalPredicate: () => false,
  deactivationPredicate: () => false,
  durable: true,
  tombstoneRetentionMs: VOLCANO_ERUPTION_TOMBSTONE_RETENTION_MS,
  maxSubjects: VOLCANO_MAX_SUBJECTS,
  allowMissingSerial: true,
  fragmentMerge: false,
};

function tsunamiObservationItemSubjectKey(item: TsunamiObservationStation): string | null {
  const code = item.stationCode?.trim();
  return code ? code : null;
}

function tsunamiObservationItemFingerprint(item: TsunamiObservationStation): string {
  return semanticPayloadFingerprint({
    areaName: item.areaName,
    name: item.name,
    sensor: item.sensor,
    arrivalTime: item.arrivalTime,
    initial: item.initial,
    maxHeightCondition: item.maxHeightCondition,
    maxHeightValue: item.maxHeightValue,
    maxHeightValueCondition: item.maxHeightValueCondition ?? "",
  });
}

function tsunamiObservationPolicy(
  headType: "VTSE51" | "VTSE52",
): Extract<
  RevisionFamilyPolicy<ParsedTsunamiInfo, TsunamiObservationStation>,
  { fragmentMerge: true }
> {
  return {
    domain: "tsunamiObservation",
    revisionFamily: headType,
    headTypes: [headType],
    comparator: "reportDateTimeThenSerial",
    extractStateSubjectKey: () => `tsunami:observations:${headType}`,
    extractCancellationTarget: () => [`tsunami:observations:${headType}`],
    cancellationPolicy: "clearCurrent",
    terminalPredicate: () => false,
    deactivationPredicate: () => false,
    // 観測系列は警報継続中に 11 分を超えて更新される。runtime 内 watermark は期限切れさせない。
    durable: true,
    tombstoneRetentionMs: null,
    // family watermark 1 件 + station item watermark の上限。
    maxSubjects: TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY + 1,
    fragmentMerge: true,
    fragmentAllowlistKey: `tsunamiObservation:${headType}`,
    extractItems: (parsed) => parsed.observations ?? [],
    // code 欠落 item は common item gate では保持せず fail-open 表示へ送る。
    // DisplayStateStore の legacy name fallback は旧 snapshot/key 昇格互換として維持する。
    itemSubjectKey: (_meta, item) => tsunamiObservationItemSubjectKey(item),
    itemFingerprint: tsunamiObservationItemFingerprint,
    fingerprintVersion: "tsunami-observation-v1",
    fragmentEvidence: {
      corpusFixtures: [
        headType === "VTSE51"
          ? "32-39_11_10_250206_VTSE51.xml"
          : "61_11_01_250206_VTSE52.xml",
      ],
      regressionTests: [
        "test/engine/telegram-foundation/phase3b-tsunami.test.ts",
        "test/engine/display/state-store.test.ts",
      ],
      rationale: "station code の実在 fixture と、同一 revision 分割・順序反転 regression に限定する",
    },
  };
}

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
  maxSubjects: 1,
  allowMissingSerial: true,
  fragmentMerge: false,
};

export const VPWW56_REVISION_FAMILY_POLICY: RevisionFamilyPolicy<ParsedWeatherWarning> = {
  domain: "weather",
  revisionFamily: "VPWW56",
  headTypes: ["VPWW56"],
  comparator: "reportDateTimeThenSerial",
  // state holder / ticker と同じ官署×type stream。EventID は state 粒度に含めない。
  extractStateSubjectKey: (meta, parsed) =>
    meta.type.valid && meta.type.value === "VPWW56"
      ? vpww56StateSubjectKey(meta.type.value, parsed.publishingOffice)
      : null,
  extractCancellationTarget: (meta, parsed) => {
    const subject = meta.type.valid && meta.type.value === "VPWW56"
      ? vpww56StateSubjectKey(meta.type.value, parsed.publishingOffice)
      : null;
    return subject == null ? null : [subject];
  },
  cancellationPolicy: "clearCurrent",
  terminalPredicate: () => false,
  // 解除 Kind のみの通常続報も、その官署 stream の clear として扱う。
  deactivationPredicate: (_meta, parsed) => !vpww56HasActiveAreas(parsed),
  durable: true,
  // 旧 holder の dormant watermark と同じ 6 時間。可変 subject の無期限化はしない。
  tombstoneRetentionMs: VPWW56_TOMBSTONE_RETENTION_MS,
  maxSubjects: VPWW56_MAX_SUBJECTS,
  // VPWW56 の実 fixture は Serial 空を許す。
  allowMissingSerial: true,
  fragmentMerge: false,
};

export const TSUNAMI_REVISION_FAMILY_POLICIES = {
  VTSE41: {
    domain: "tsunami",
    revisionFamily: "VTSE41",
    headTypes: ["VTSE41"],
    comparator: "reportDateTimeThenSerial",
    // TsunamiStateHolder は EventID 別ではなく、全国で単一の active level/lastInfo を持つ。
    extractStateSubjectKey: () => TSUNAMI_CURRENT_SUBJECT,
    extractCancellationTarget: () => [TSUNAMI_CURRENT_SUBJECT],
    cancellationPolicy: "clearCurrent",
    terminalPredicate: () => false,
    deactivationPredicate: (_meta, parsed) =>
      resolveTsunamiLevel((parsed.forecast ?? []).map((item) => item.kind)) == null,
    durable: true,
    tombstoneRetentionMs: null,
    maxSubjects: 1,
    // VTSE41 は正常電文・取消とも Serial 空の実 fixture が存在する。
    allowMissingSerial: true,
    fragmentMerge: false,
  } satisfies RevisionFamilyPolicy<ParsedTsunamiInfo>,
  VTSE51: tsunamiObservationPolicy("VTSE51"),
  VTSE52: tsunamiObservationPolicy("VTSE52"),
} as const;

const FRAGMENT_MERGE_ALLOWLIST = new Set<string>(FRAGMENT_MERGE_ALLOWLIST_KEYS);

export interface RevisionFamilyPolicyValidationShape {
  domain: string;
  revisionFamily: string;
  fragmentMerge: boolean;
  durable?: boolean;
  tombstoneRetentionMs?: number | null;
  maxSubjects?: number | null;
  fragmentAllowlistKey?: FragmentMergeAllowlistKey;
  extractItems?: unknown;
  itemSubjectKey?: unknown;
  itemFingerprint?: unknown;
  fingerprintVersion?: string;
  fragmentEvidence?: {
    corpusFixtures: readonly string[];
    regressionTests: readonly string[];
    rationale: string;
  };
}

export function validateRevisionFamilyPolicy(
  policy: RevisionFamilyPolicyValidationShape,
): void {
  const key = `${policy.domain}:${policy.revisionFamily}`;
  if (
    policy.maxSubjects != null
    && (
      !Number.isSafeInteger(policy.maxSubjects)
      || policy.maxSubjects <= 0
      || policy.maxSubjects > TELEGRAM_REVISION_MAX_ENTRIES
    )
  ) {
    throw new Error(`revision family maxSubjects is invalid: ${key}`);
  }
  if (
    policy.durable === true
    && policy.tombstoneRetentionMs === null
    && policy.maxSubjects == null
  ) {
    throw new Error(`indefinite durable family requires bounded maxSubjects: ${key}`);
  }
  if (!policy.fragmentMerge) return;
  if (policy.fragmentAllowlistKey !== key || !FRAGMENT_MERGE_ALLOWLIST.has(key)) {
    throw new Error(`fragmentMerge family is not allowlisted: ${key}`);
  }
  if (
    typeof policy.extractItems !== "function"
    || typeof policy.itemSubjectKey !== "function"
    || typeof policy.itemFingerprint !== "function"
    || policy.fingerprintVersion == null
    || policy.fingerprintVersion.trim() === ""
    || policy.fragmentEvidence == null
    || policy.fragmentEvidence.corpusFixtures.length === 0
    || policy.fragmentEvidence.regressionTests.length === 0
    || policy.fragmentEvidence.rationale.trim() === ""
  ) {
    throw new Error(`fragmentMerge evidence is incomplete: ${key}`);
  }
}

export function validateRevisionFamilyPolicies(
  policies: readonly RevisionFamilyPolicyValidationShape[],
): void {
  let indefiniteDurableSubjectBudget = 0;
  for (const policy of policies) {
    validateRevisionFamilyPolicy(policy);
    if (policy.durable === true && policy.tombstoneRetentionMs === null) {
      indefiniteDurableSubjectBudget += policy.maxSubjects ?? 0;
    }
  }
  if (indefiniteDurableSubjectBudget > TELEGRAM_REVISION_MAX_ENTRIES) {
    throw new Error(
      `indefinite durable family maxSubjects total exceeds gate capacity: ${indefiniteDurableSubjectBudget}/${TELEGRAM_REVISION_MAX_ENTRIES}`,
    );
  }
}

export const EEW_REVISION_FAMILY_POLICIES = {
  VXSE43: eewPolicy("VXSE43"),
  VXSE44: eewPolicy("VXSE44"),
  VXSE45: eewPolicy("VXSE45"),
} as const;

export const ALL_REVISION_FAMILY_POLICIES = [
  ...Object.values(EEW_REVISION_FAMILY_POLICIES),
  VPWS50_REVISION_FAMILY_POLICY,
  VPWW56_REVISION_FAMILY_POLICY,
  ...Object.values(TSUNAMI_REVISION_FAMILY_POLICIES),
  VOLCANO_ALERT_REVISION_FAMILY_POLICY,
  VOLCANO_ERUPTION_REVISION_FAMILY_POLICY,
] as const;

validateRevisionFamilyPolicies(ALL_REVISION_FAMILY_POLICIES);

export function eewRevisionFamilyPolicy(
  headType: string,
): RevisionFamilyPolicy<ParsedEewInfo> | null {
  return Object.hasOwn(EEW_REVISION_FAMILY_POLICIES, headType)
    ? EEW_REVISION_FAMILY_POLICIES[
        headType as keyof typeof EEW_REVISION_FAMILY_POLICIES
      ]
    : null;
}

export function tsunamiRevisionFamilyPolicy(
  headType: string,
): RevisionFamilyPolicy<ParsedTsunamiInfo, TsunamiObservationStation> | null {
  return Object.hasOwn(TSUNAMI_REVISION_FAMILY_POLICIES, headType)
    ? TSUNAMI_REVISION_FAMILY_POLICIES[
        headType as keyof typeof TSUNAMI_REVISION_FAMILY_POLICIES
      ]
    : null;
}

export function weatherRevisionFamilyPolicy(
  headType: string,
): RevisionFamilyPolicy<ParsedWeatherWarning> | null {
  if (headType === "VPWS50") return VPWS50_REVISION_FAMILY_POLICY;
  if (headType === "VPWW56") return VPWW56_REVISION_FAMILY_POLICY;
  return null;
}

export function volcanoRevisionFamilyPolicy(
  headType: string,
): RevisionFamilyPolicy<ParsedVolcanoInfo> | null {
  if (VOLCANO_ALERT_REVISION_FAMILY_POLICY.headTypes.includes(headType)) {
    return VOLCANO_ALERT_REVISION_FAMILY_POLICY;
  }
  if (VOLCANO_ERUPTION_REVISION_FAMILY_POLICY.headTypes.includes(headType)) {
    return VOLCANO_ERUPTION_REVISION_FAMILY_POLICY;
  }
  return null;
}
