export type LadderStage = 0 | 1 | 2 | 3;
export type CardKey = "tsunami" | "quake" | "weather" | "briefing" | "flood" | "typhoon" | "volcano" | "heat";
/** Keys used only for paging partition/probe measurements, including dependent riders. */
export type PagePartitionKey = CardKey | "tornado";
/** Keys with independent page-coordinator runtime state. */
export type PageableKey = "quake" | "weather" | "briefing" | "flood" | "tornado";
export type CardVariant = "compact" | "expanded" | "full";
export type TyphoonVariant = "compact" | "full";

export interface VariantSelection {
  quake: CardVariant;
  weather: CardVariant;
  typhoon: TyphoonVariant;
}

export interface CardCandidate {
  key: CardKey;
  order: number;
  score: number;
  variant: CardVariant;
  naturalHeight: number;
  centerNaturalHeight: number;
  /** Variant-specific measurements supplied by the component measurement shelf. */
  measurements?: Partial<Record<CardVariant, { naturalHeight: number; centerNaturalHeight: number }>>;
  /** The number of candidate region prefixes available to this card. */
  maxRegionRows?: number;
}

export interface PlacementChoice {
  left: CardCandidate[];
  right: CardCandidate[];
  center: CardCandidate[];
  moved: Set<CardKey>;
}

export interface DisplaySelection {
  typhoon: TyphoonVariant;
  floodWide: boolean;
  quakeRows: number;
  weatherRows: number;
}

export interface RotationSolution {
  placement: PlacementChoice;
  rotationKeys: CardKey[];
  currentKey: CardKey | null;
  slotHeight: number;
  failureCount: number;
  layoutFailure: boolean;
}

export interface ColumnPlan {
  left: CardCandidate[];
  right: CardCandidate[];
  center: CardCandidate[];
  moved: Set<CardKey>;
  unresolved: boolean;
  centerUnresolved: boolean;
  stage: LadderStage;
  variants: VariantSelection;
  rotationKeys: CardKey[];
  rotationCurrentKey: CardKey | null;
  rotationSlotHeight: number;
  rotationFailureCount: number;
  layoutFailure: boolean;
  /** Scores retained for the next epoch's priority-rise stability check. */
  candidateScores?: Partial<Record<CardKey, number>>;
}

export interface PageTail {
  kindKey: string;
  omittedAreaCount: number;
}

export interface PageRange {
  start: number;
  end: number;
  tails: PageTail[];
  omittedAreaCount: number;
}

export interface PageMeasureEntry {
  id: string;
  key: PagePartitionKey;
  start: number;
  end: number;
  tails: PageTail[];
  omittedAreaCount: number;
}

export interface PartitionResult {
  ranges: PageRange[];
  pending: PageMeasureEntry[];
  infeasible: boolean;
  probeCount: number;
}

export interface CardPageRuntime {
  activeKey: string | null;
  knownKeys: string[];
  pendingKeys: string[];
  cycleOriginKey: string | null;
}

export interface PageAreaEntry {
  kindKey: string;
  area: string;
  /** 同名地域を区別する XML Area.Code。旧経路は欠落しうる。 */
  areaCode?: string | null;
  occurrenceIndex: number;
}
