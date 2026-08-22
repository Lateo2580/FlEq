import type {
  CardCandidate,
  CardKey,
  CardVariant,
  ColumnPlan,
  DisplaySelection,
  LadderStage,
  PlacementChoice,
  RotationSolution,
  TyphoonVariant,
  VariantSelection,
} from "./types";

const LEFT_KEYS = new Set<CardKey>(["tsunami", "quake"]);
const CENTER_ELIGIBLE_KEYS = new Set<CardKey>(["weather", "flood", "typhoon", "volcano"]);
const ROTATION_REVERSE_ORDER: readonly CardKey[] = ["heat", "volcano", "typhoon", "flood", "weather"];
const MAX_ROTATION_CANDIDATE_PASSES = 5;

export interface SolverContext {
  measuredHeight(key: CardKey, variant: CardVariant): number | null;
  measureSelection(choice: PlacementChoice, selection: DisplaySelection): {
    leftOverflowPx: number;
    rightOverflowPx: number;
    centerOverflowPx: number;
  } | null;
  capacityPx: { left: number; right: number; center: number };
  centerFixedHeightPx: number;
  floodIsWide: boolean;
  candidateSupplyLimit: number;
  rotationSlotHeight(keys: readonly CardKey[]): number;
  failureRowHeight: number;
  gapPx: number;
}

export interface ColumnPlanInput {
  candidates: readonly CardCandidate[];
  ctx: SolverContext;
  floorStage: LadderStage;
  requestedLadder: LadderStage | null;
}

function sortedCards(cards: readonly CardCandidate[]): CardCandidate[] {
  return [...cards].sort((left, right) => left.order - right.order);
}

function emptyPlacement(): PlacementChoice {
  return { left: [], right: [], center: [], moved: new Set<CardKey>() };
}

function columnHeight(cards: readonly CardCandidate[], gapPx: number): number {
  return cards.reduce((total, card) => total + card.naturalHeight, 0) + Math.max(0, cards.length - 1) * gapPx;
}

function centerHeight(cards: readonly CardCandidate[], ctx: SolverContext): number {
  const totalCount = cards.length + (ctx.centerFixedHeightPx > 0 ? 1 : 0);
  return cards.reduce((total, card) => total + card.centerNaturalHeight, 0)
    + ctx.centerFixedHeightPx + Math.max(0, totalCount - 1) * ctx.gapPx;
}

function rightHeight(cards: readonly CardCandidate[], ctx: SolverContext, rotationSlotHeight = 0, failureHeight = 0): number {
  let total = columnHeight(cards, ctx.gapPx);
  if (rotationSlotHeight > 0) total += (cards.length > 0 ? ctx.gapPx : 0) + rotationSlotHeight;
  if (failureHeight > 0) total += ctx.gapPx + failureHeight;
  return total;
}

function overflow(height: number, capacity: number): number {
  return Number.isFinite(capacity) ? Math.max(0, height - capacity) : 0;
}

function placementTotalOverflow(choice: PlacementChoice, ctx: SolverContext, rotationSlotHeight = 0, failureHeight = 0): number {
  return overflow(columnHeight(choice.left, ctx.gapPx), ctx.capacityPx.left)
    + overflow(rightHeight(choice.right, ctx, rotationSlotHeight, failureHeight), ctx.capacityPx.right)
    // The clock/statistics/recent-quake cluster is a real center consumer even
    // when every eligible card has moved out of the center.  Omitting it here
    // let an empty center appear fit while the fixed cluster crossed Nankai.
    + overflow(centerHeight(choice.center, ctx), ctx.capacityPx.center);
}

function placementFits(choice: PlacementChoice | null, ctx: SolverContext, rotationSlotHeight = 0, failureHeight = 0): boolean {
  return choice != null && placementTotalOverflow(choice, ctx, rotationSlotHeight, failureHeight) === 0;
}

function cardPlacement(choice: PlacementChoice | ColumnPlan, key: CardKey): "left" | "right" | "center" | null {
  if (choice.left.some((card) => card.key === key)) return "left";
  if (choice.right.some((card) => card.key === key)) return "right";
  if (choice.center.some((card) => card.key === key)) return "center";
  return null;
}

function selectionFits(choice: PlacementChoice, selection: DisplaySelection, ctx: SolverContext, reservedRightHeight = 0): boolean {
  const measured = ctx.measureSelection(choice, selection);
  return measured != null
    && measured.leftOverflowPx <= 0
    && measured.rightOverflowPx + reservedRightHeight <= 0
    && measured.centerOverflowPx <= 0;
}

function reservedRightHeight(choice: PlacementChoice, ctx: SolverContext, rotationSlotHeight: number, failureHeight: number): number {
  return (rotationSlotHeight > 0 ? (choice.right.length > 0 ? ctx.gapPx : 0) + rotationSlotHeight : 0)
    + (failureHeight > 0 ? ctx.gapPx + failureHeight : 0);
}

function maxRegionRows(choice: PlacementChoice, key: "quake" | "weather", ctx: SolverContext): number {
  const card = [...choice.left, ...choice.right, ...choice.center].find((candidate) => candidate.key === key);
  return Math.min(card?.maxRegionRows ?? 0, ctx.candidateSupplyLimit);
}

export function achievableSurplusUse(choice: PlacementChoice, ctx: SolverContext, rotationSlotHeight = 0, failureHeight = 0): number {
  const typhoonCard = [...choice.left, ...choice.right, ...choice.center].find((card) => card.key === "typhoon");
  let selection: DisplaySelection = {
    typhoon: typhoonCard?.variant === "full" ? "full" : "compact",
    floodWide: false,
    quakeRows: 0,
    weatherRows: 0,
  };
  let achieved = 0;
  const floodPlacement = cardPlacement(choice, "flood");
  if (ctx.floodIsWide && floodPlacement != null && floodPlacement !== "center") {
    const promoted = { ...selection, floodWide: true };
    if (selectionFits(choice, promoted, ctx, reservedRightHeight(choice, ctx, rotationSlotHeight, failureHeight))) {
      selection = promoted;
      achieved += 1;
    }
  }
  if (typhoonCard != null && selection.typhoon === "compact") {
    const promoted = { ...selection, typhoon: "full" as const };
    if (selectionFits(choice, promoted, ctx, reservedRightHeight(choice, ctx, rotationSlotHeight, failureHeight))) {
      selection = promoted;
      achieved += 1;
    }
  }
  for (const key of ["quake", "weather"] as const) {
    if (cardPlacement(choice, key) == null) continue;
    let best = 0;
    for (let rows = 1; rows <= maxRegionRows(choice, key, ctx); rows += 1) {
      const promoted = key === "quake" ? { ...selection, quakeRows: rows } : { ...selection, weatherRows: rows };
      if (selectionFits(choice, promoted, ctx, reservedRightHeight(choice, ctx, rotationSlotHeight, failureHeight))) best = rows;
    }
    if (best > 0) {
      selection = key === "quake" ? { ...selection, quakeRows: best } : { ...selection, weatherRows: best };
      achieved += best;
    }
  }
  return achieved;
}

export function comparePlacements(left: PlacementChoice, right: PlacementChoice, ctx: SolverContext, rotationSlotHeight = 0, failureHeight = 0): number {
  const leftOverflow = placementTotalOverflow(left, ctx, rotationSlotHeight, failureHeight);
  const rightOverflow = placementTotalOverflow(right, ctx, rotationSlotHeight, failureHeight);
  const leftFits = leftOverflow === 0;
  const rightFits = rightOverflow === 0;
  if (leftFits !== rightFits) return leftFits ? -1 : 1;
  if (leftFits) {
    if (left.center.length !== right.center.length) return left.center.length - right.center.length;
    const leftWideFlood = ctx.floodIsWide && left.center.some((card) => card.key === "flood");
    const rightWideFlood = ctx.floodIsWide && right.center.some((card) => card.key === "flood");
    if (leftWideFlood !== rightWideFlood) return leftWideFlood ? -1 : 1;
    const leftSurplusUse = achievableSurplusUse(left, ctx, rotationSlotHeight, failureHeight);
    const rightSurplusUse = achievableSurplusUse(right, ctx, rotationSlotHeight, failureHeight);
    if (leftSurplusUse !== rightSurplusUse) return rightSurplusUse - leftSurplusUse;
    const leftMax = Math.max(columnHeight(left.left, ctx.gapPx), rightHeight(left.right, ctx, rotationSlotHeight, failureHeight));
    const rightMax = Math.max(columnHeight(right.left, ctx.gapPx), rightHeight(right.right, ctx, rotationSlotHeight, failureHeight));
    if (leftMax !== rightMax) return leftMax - rightMax;
  } else if (leftOverflow !== rightOverflow) return leftOverflow - rightOverflow;
  const leftBalance = Math.abs(columnHeight(left.left, ctx.gapPx) - rightHeight(left.right, ctx, rotationSlotHeight, failureHeight));
  const rightBalance = Math.abs(columnHeight(right.left, ctx.gapPx) - rightHeight(right.right, ctx, rotationSlotHeight, failureHeight));
  if (leftBalance !== rightBalance) return leftBalance - rightBalance;
  const leftCenterOverflow = left.center.length === 0 ? 0 : overflow(centerHeight(left.center, ctx), ctx.capacityPx.center);
  const rightCenterOverflow = right.center.length === 0 ? 0 : overflow(centerHeight(right.center, ctx), ctx.capacityPx.center);
  if (leftCenterOverflow !== rightCenterOverflow) return leftCenterOverflow - rightCenterOverflow;
  if (left.center.length !== right.center.length) return left.center.length - right.center.length;
  if (left.moved.size !== right.moved.size) return left.moved.size - right.moved.size;
  const tuple = (choice: PlacementChoice): string => [choice.left, choice.right, choice.center].map((cards) => cards.map((card) => card.key).join(",")).join("|");
  return tuple(left) < tuple(right) ? -1 : tuple(left) > tuple(right) ? 1 : 0;
}

export function enumeratePlacements(candidates: readonly CardCandidate[], forcedLeftKeys: ReadonlySet<CardKey>, allowCenter: boolean, requireCenter: boolean): PlacementChoice[] {
  const fixedLeft = candidates.filter((card) => LEFT_KEYS.has(card.key) || forcedLeftKeys.has(card.key));
  const movable = candidates.filter((card) => !LEFT_KEYS.has(card.key) && !forcedLeftKeys.has(card.key));
  const centerCandidates = allowCenter ? movable.filter((card) => CENTER_ELIGIBLE_KEYS.has(card.key)) : [];
  const placements: PlacementChoice[] = [];
  for (let centerMask = 0; centerMask < 1 << centerCandidates.length; centerMask += 1) {
    const center = centerCandidates.filter((_, index) => (centerMask & 1 << index) !== 0);
    if (requireCenter && center.length === 0) continue;
    const centerKeys = new Set(center.map((card) => card.key));
    const sideMovable = movable.filter((card) => !centerKeys.has(card.key));
    for (let leftMask = 0; leftMask < 1 << sideMovable.length; leftMask += 1) {
      const leftMovable = sideMovable.filter((_, index) => (leftMask & 1 << index) !== 0);
      const leftKeys = new Set(leftMovable.map((card) => card.key));
      const left = sortedCards([...fixedLeft, ...leftMovable]);
      placements.push({ left, right: sortedCards(sideMovable.filter((card) => !leftKeys.has(card.key))), center: sortedCards(center), moved: new Set(left.filter((card) => !LEFT_KEYS.has(card.key)).map((card) => card.key)) });
    }
  }
  return placements;
}

export function bestPlacement(placements: readonly PlacementChoice[], ctx: SolverContext, rotationSlotHeight = 0, failureHeight = 0): PlacementChoice | null {
  let best: PlacementChoice | null = null;
  for (const placement of placements) if (best == null || comparePlacements(placement, best, ctx, rotationSlotHeight, failureHeight) < 0) best = placement;
  return best;
}

function canonicalOrder(keys: readonly CardKey[], candidates: readonly CardCandidate[]): CardKey[] {
  return [...keys].sort((left, right) => (candidates.find((card) => card.key === left)?.order ?? 0) - (candidates.find((card) => card.key === right)?.order ?? 0));
}

export function solveRotation(candidates: readonly CardCandidate[], ctx: SolverContext): RotationSolution {
  const available = ROTATION_REVERSE_ORDER.filter((key) => candidates.some((card) => card.key === key));
  const displayed: CardKey[] = [];
  const failed: CardKey[] = [];
  const solveRemaining = (): { placement: PlacementChoice | null; slotHeight: number; failureHeight: number } => {
    const excluded = new Set([...displayed, ...failed]);
    const slotHeight = ctx.rotationSlotHeight(displayed);
    const failureHeight = failed.length > 0 ? ctx.failureRowHeight : 0;
    return { placement: bestPlacement(enumeratePlacements(candidates.filter((card) => !excluded.has(card.key)), new Set<CardKey>(), true, false), ctx, slotHeight, failureHeight), slotHeight, failureHeight };
  };
  for (let pass = 0; pass < MAX_ROTATION_CANDIDATE_PASSES && displayed.length + failed.length < available.length; pass += 1) {
    const next = available.find((key) => !displayed.includes(key) && !failed.includes(key));
    if (next == null) break;
    displayed.push(next);
    const solved = solveRemaining();
    if (placementFits(solved.placement, ctx, solved.slotHeight, solved.failureHeight)) {
      const keys = canonicalOrder(displayed, candidates);
      return { placement: solved.placement ?? emptyPlacement(), rotationKeys: keys, currentKey: keys[0] ?? null, slotHeight: solved.slotHeight, failureCount: failed.length, layoutFailure: false };
    }
  }
  while (displayed.length > 0) {
    const solved = solveRemaining();
    if (placementFits(solved.placement, ctx, solved.slotHeight, solved.failureHeight)) {
      const keys = canonicalOrder(displayed, candidates);
      return { placement: solved.placement ?? emptyPlacement(), rotationKeys: keys, currentKey: keys[0] ?? null, slotHeight: solved.slotHeight, failureCount: failed.length, layoutFailure: false };
    }
    const largest = displayed.slice().sort((left, right) => ctx.rotationSlotHeight([right]) - ctx.rotationSlotHeight([left]) || (candidates.find((card) => card.key === right)?.order ?? 0) - (candidates.find((card) => card.key === left)?.order ?? 0))[0];
    displayed.splice(displayed.indexOf(largest), 1);
    failed.push(largest);
  }
  const solved = solveRemaining();
  const keys = canonicalOrder(displayed, candidates);
  return { placement: solved.placement ?? emptyPlacement(), rotationKeys: keys, currentKey: keys[0] ?? null, slotHeight: solved.slotHeight, failureCount: failed.length, layoutFailure: !placementFits(solved.placement, ctx, solved.slotHeight, solved.failureHeight) };
}

function withVariant(card: CardCandidate, variant: CardVariant, ctx: SolverContext): CardCandidate {
  const measured = card.measurements?.[variant];
  return { ...card, variant, naturalHeight: measured?.naturalHeight ?? ctx.measuredHeight(card.key, variant) ?? card.naturalHeight, centerNaturalHeight: measured?.centerNaturalHeight ?? card.centerNaturalHeight };
}

function candidatesForVariants(candidates: readonly CardCandidate[], variants: VariantSelection, ctx: SolverContext): CardCandidate[] {
  return candidates.map((card) => withVariant(card, card.key === "quake" ? variants.quake : card.key === "weather" ? variants.weather : card.key === "typhoon" ? variants.typhoon : "compact", ctx));
}

export function makeColumnPlan(input: ColumnPlanInput): ColumnPlan {
  const { ctx } = input;
  const fullVariants: VariantSelection = { quake: "compact", weather: "compact", typhoon: "full" };
  let variants = fullVariants;
  let candidates = candidatesForVariants(input.candidates, variants, ctx);
  let sidePlacement = bestPlacement(enumeratePlacements(candidates, new Set<CardKey>(), false, false), ctx);
  if (!placementFits(sidePlacement, ctx)) {
    variants = { ...fullVariants, typhoon: "compact" };
    candidates = candidatesForVariants(input.candidates, variants, ctx);
    sidePlacement = bestPlacement(enumeratePlacements(candidates, new Set<CardKey>(), false, false), ctx);
  }
  const auto = input.requestedLadder == null;
  const floor = auto ? input.floorStage : input.requestedLadder ?? 0;
  let selected = sidePlacement ?? emptyPlacement();
  let stage: LadderStage = 0;
  let rotation: RotationSolution | null = null;
  const useRotation = (): void => {
    const solved = solveRotation(candidates, ctx);
    // A stage-3 plan must reserve and expose at least one rotating card.  The
    // empty fallback has excluded failed rotation candidates, so restore the
    // ordinary central placement before leaving the rotation path.
    if (solved.rotationKeys.length === 0) {
      selected = bestPlacement(enumeratePlacements(candidates, new Set<CardKey>(), true, true), ctx) ?? selected;
      rotation = null;
      stage = 2;
      return;
    }
    selected = solved.placement;
    rotation = solved;
    stage = 3;
  };
  if (!(floor === 0 && (placementFits(sidePlacement, ctx) || !auto))) {
    const centerPlacement = bestPlacement(enumeratePlacements(candidates, new Set<CardKey>(), true, true), ctx);
    const centerFits = placementFits(centerPlacement, ctx);
    if (floor <= 1 && (centerFits || !auto || floor === 1)) { selected = centerPlacement ?? selected; stage = auto && !centerFits ? 2 : 1; }
    else if (floor <= 2) { selected = centerPlacement ?? selected; stage = 2; if (auto && !centerFits) useRotation(); }
    else useRotation();
  }
  if (input.requestedLadder === 1) stage = 1;
  if (input.requestedLadder === 2) stage = 2;
  if (input.requestedLadder === 3) useRotation();
  const rotationResult = rotation as RotationSolution | null;
  const rotationHeight = rotationResult?.slotHeight ?? 0;
  const failureCount = rotationResult?.failureCount ?? 0;
  const layoutFailure = rotationResult?.layoutFailure ?? false;
  const centerUnresolved = centerHeight(selected.center, ctx) > ctx.capacityPx.center;
  const sideUnresolved = columnHeight(selected.left, ctx.gapPx) > ctx.capacityPx.left || rightHeight(selected.right, ctx, rotationHeight, failureCount > 0 ? ctx.failureRowHeight : 0) > ctx.capacityPx.right;
  return { left: selected.left, right: selected.right, center: selected.center, moved: selected.moved, unresolved: layoutFailure || sideUnresolved || centerUnresolved, centerUnresolved, stage, variants, rotationKeys: rotationResult?.rotationKeys ?? [], rotationCurrentKey: rotationResult?.currentKey ?? null, rotationSlotHeight: rotationHeight, rotationFailureCount: failureCount, layoutFailure };
}

export function promoteAndExpand(plan: ColumnPlan, ctx: SolverContext): DisplaySelection {
  const choice: PlacementChoice = { left: plan.left, right: plan.right, center: plan.center, moved: plan.moved };
  let selection: DisplaySelection = { typhoon: plan.variants.typhoon, floodWide: false, quakeRows: 0, weatherRows: 0 };
  for (const key of ["flood", "typhoon"] as const) {
    const placement = cardPlacement(plan, key);
    if (placement == null || plan.rotationKeys.includes(key)) continue;
    const promoted = key === "flood" ? { ...selection, floodWide: true } : { ...selection, typhoon: "full" as TyphoonVariant };
    if ((key !== "flood" || ctx.floodIsWide && placement !== "center") && (key !== "typhoon" || selection.typhoon === "compact") && selectionFits(choice, promoted, ctx)) selection = promoted;
  }
  for (const key of ["quake", "weather"] as const) {
    if (plan.rotationKeys.includes(key)) continue;
    let best = 0;
    for (let rows = 1; rows <= maxRegionRows(choice, key, ctx); rows += 1) {
      const promoted = key === "quake" ? { ...selection, quakeRows: rows } : { ...selection, weatherRows: rows };
      if (selectionFits(choice, promoted, ctx)) best = rows;
    }
    if (best > 0) selection = key === "quake" ? { ...selection, quakeRows: best } : { ...selection, weatherRows: best };
  }
  return selection;
}
