import type { AcquisitionOrigin, DecodedMaterial, ParserMailboxResult } from "../../contracts/p1-parser-boundary.types";
import type { UnitJob, UnitTable } from "../../contracts/p3-unit-table.types";
import type { ExecutionPlace, OwnerOutput, RecoveryInputResult } from "../../contracts/p3-execution-split.types";
import type {
  CheckpointCapture,
  CheckpointResult,
  ClockReading,
  CurrentConfirmationEvidence,
  DiagnosticDetails,
  DiagnosticEvent,
  LossTally,
  NotificationIntentUpdate,
  PersistenceStatus,
  RejectionReason,
  RestoreUnitResult,
  RuntimeDisplayChange,
  RuntimePublishedOutcome,
  RuntimeRestoration,
  RuntimeState,
  RuntimeUnitDeadline,
  RuntimeUnitId,
  RuntimeUnitInputs,
  RuntimeUnitStates,
  RuntimeUnitSteps,
  RuntimeUnitView,
  RuntimeViews,
  SemanticEnvelopeResult, UnreadableCard, UnreadableCardView, WallBasis, DisplayRemoval,
} from "../../contracts/p2-shared-runtime.types";
import type { CodecMap } from "../checkpoint/checkpoint";
import { CARD_AREAS, CARD_AREAS_BYTES, CARD_TEXT, cardLimits, keptCards, keptLosses, lossReasons } from "../checkpoint/checkpoint";
import { headlineOf, rewriteBounded, titleOf } from "../units/unreadable";
import { boundDiagnosticDetails, boundedString, completeDiagnostic, parserDiagnosticReasons } from "./runtime-diagnostic"; import { validInputId } from "../contracts-revision/version";
import { classifyHeadType, executionPlaces, runtimeUnits } from "./unit-coverage"; import type { WeatherTimeseriesDetailRequest, WeatherTimeseriesDetailResponse } from "../../contracts/p2-weather-timeseries-unit.types"; import { weatherTimeseriesDetail } from "../units/weather-timeseries/weather-timeseries-unit"; import type { WeatherCurrentDetailRequest, WeatherCurrentDetailResponse } from "../../contracts/p3-uw-canon.types"; import type { BulletinTextRequest, BulletinTextResponse } from "../../contracts/p3-bulletin-text-api.types"; import type { VolcanoBulletin } from "../../contracts/p3-volcano-unit.types"; import type { NankaiInformation } from "../../contracts/p3-nankai-unit.types"; import { weatherCurrentDetail } from "../units/weather-current/weather-current-public";

// P3-EXECUTION-SPLIT-001 (C3a) owner core: everything one owner does to its own units, as pure functions of
// the owner state. The owner thread and the test path (1) call these; nothing here touches another place's units.

const EMPTY: readonly never[] = Object.freeze([]);

type OwnerState = Readonly<{
  runId: string;
  place: ExecutionPlace;
  units: Readonly<Partial<RuntimeUnitStates>>;
  deadlines: Readonly<Partial<Record<RuntimeUnitId, RuntimeUnitDeadline | null>>>;
  checkpointAttempts: RuntimeState["checkpointAttempts"];
  // P3-NL-AC14 (1): unit ごとの H39 の件数（envelope の losses。capture で書き、復元で読む。数え方は発注 2）。
  losses: Readonly<Partial<Record<RuntimeUnitId, readonly LossTally[]>>>;
  // P3-UM-AC11 (2)(6): unit ごとの H43 のカード（envelope の unreadable。capture で書き、復元で読む）。
  unreadable: Readonly<Partial<Record<RuntimeUnitId, readonly UnreadableCard[]>>>;
  // false once the shutdown input was applied: a later parser input is not applied (P2-WIRE-T04).
  accepting: boolean;
  // true once finalized: no deadline and no input is applied (spec §5.9 step 4).
  finalized: boolean;
}>;

type OwnerStep = Readonly<{
  state: OwnerState;
  changedUnits: readonly RuntimeUnitId[];
  // Present [] certifies only this step's generation change (P2-A3-AC10).
  generationInputIds: Readonly<Partial<Record<RuntimeUnitId, readonly string[]>>>;
  views: readonly RuntimeUnitView[];
  outcomes: readonly RuntimePublishedOutcome[];
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  retiredEvents: OwnerOutput["retiredEvents"];
  diagnostics: readonly DiagnosticEvent[];
}>;

// P3-UM-AC11 (2)(3): headType と receivedAt は item の値（host は常に渡す）。parser が断った入力の振り分け先とカードの受信時刻に使う。
// 渡さない呼び出し（unit の試験）は、decoded なら material の headType・origin、受信時刻は要求の wall で読む（origin は P3-UM-AC12 (10)）。
type ParserCompletion = Readonly<{ runId: string; inputId: string; result: ParserMailboxResult; headType?: string; receivedAt?: number; origin?: AcquisitionOrigin }>;
type UnitInput = Extract<RuntimeUnitInputs[RuntimeUnitId], { kind: "receive" | "deadline" | "shutdown" | "intentUpdate" }>; type UnreadableInput = Extract<RuntimeUnitInputs["U-E" | "U-T"], { kind: "unreadable" }>;

const encoder = new TextEncoder();
const cleanPersistence: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0,
  savedCapturedAt: null, savedAckAt: null, dirtySince: null };
const noHistory = { dayKey: null, count: 0, maxInt: null, counted: [], recent: [] } as const;
const initialUnits: RuntimeUnitStates = {
  "U-E": { schemaVersion: "p2-eew-unit-v5", contentRevision: 0, current: [], gates: [], intents: [], notices: [], unreadableNotices: [], persistence: cleanPersistence },
  "U-W": { schemaVersion: "p2-weather-current-unit-v8", contentRevision: 0, national: {}, partials: [], histories: [], ownership: {}, notices: [],
    tombstones: [], freshness: [], unavailable: [], intents: [], unconfirmed: [], persistence: cleanPersistence },
  "U-F": { schemaVersion: "p2-weather-timeseries-unit-v8", contentRevision: 0, subjects: [], gates: [], intents: [], persistence: cleanPersistence },
  "U-T": { schemaVersion: "p3-tsunami-unit-v9", contentRevision: 0, forecasts: [], observations: [], intents: [], failureMarks: [], unreadableNotices: [], persistence: cleanPersistence },
  "U-Q": { schemaVersion: "p3-seismic-unit-v9", contentRevision: 0, earthquakes: [], longPeriods: [],
    daily: { normal: noHistory, training: noHistory, test: noHistory }, intents: [], failureMarks: [], persistence: cleanPersistence },
  "U-N": { schemaVersion: "p3-nankai-unit-v8", contentRevision: 0, currents: [], information: [], intents: [], persistence: cleanPersistence },
  "U-V": { schemaVersion: "p3-volcano-unit-v8", contentRevision: 0, alerts: [], eruptions: [], ashfalls: [], shortfalls: [],
    scheduledAshfalls: [], batch: null, bulletins: [], intents: [], persistence: cleanPersistence },
  "U-L": { schemaVersion: "p3-landslide-unit-v8", contentRevision: 0, currents: [], intents: [], persistence: cleanPersistence },
  "U-R": { schemaVersion: "p3-flood-unit-v9", contentRevision: 0, currents: [], intents: [], persistence: cleanPersistence },
  "U-B": { schemaVersion: "p3-briefing-unit-v7", contentRevision: 0, currents: [], intents: [], persistence: cleanPersistence },
  "U-M": { schemaVersion: "p3-local-bulletins-unit-v7", contentRevision: 0, tornado: [], heat: [], transient: [], intents: [], persistence: cleanPersistence },
  "U-Y": { schemaVersion: "p3-typhoon-unit-v7", contentRevision: 0, analysis: [], probability: [], intents: [], persistence: cleanPersistence },
};

const placeUnits = (place: ExecutionPlace): readonly RuntimeUnitId[] =>
  runtimeUnits.filter((unit) => executionPlaces[unit] === place);

function rejection(material: DecodedMaterial, reason: RejectionReason): SemanticEnvelopeResult {
  return {
    kind: "rejected",
    reason,
    diagnostic: boundDiagnosticDetails({ level: "WARN", component: "shared-runtime", reason, inputId: material.inputId }),
  };
}

function reportDateTime(raw: string): number | null {
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (match == null) return null;
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) return null;
  const offsetMinutes = match[7] === "Z" ? 0 : (match[8] === "+" ? 1 : -1) * (Number(match[9]) * 60 + Number(match[10]));
  const local = new Date(value + offsetMinutes * 60_000);
  const actual = [local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()];
  return actual.every((part, index) => part === Number(match[index + 1])) ? value : null;
}

function validateSemanticEnvelope(material: DecodedMaterial): SemanticEnvelopeResult {
  if (!material.xml.children.some((node) => node.kind === "element" && node.name === "Head")) {
    return rejection(material, "headMissing");
  }
  if (material.reportDateTimeRaw.trim() === "") return rejection(material, "reportDateTimeMissing");
  const reportDateTimeMs = reportDateTime(material.reportDateTimeRaw);
  if (reportDateTimeMs == null) return rejection(material, "reportDateTimeInvalid");
  // P3-VM-AC08: 全 unit の受理で、ReportRef の読み戻し（version.ts の readReportRef）と同じ inputId の上限を 1 度だけ当てる。
  if (!validInputId(material.inputId)) return rejection(material, "identityInvalid");
  return { kind: "accepted", envelope: { material, reportDateTimeMs } };
}

function parserDiagnostic(reason: string, inputId: string): DiagnosticDetails | null {
  const matched = parserDiagnosticReasons.find((candidate) => candidate === reason);
  if (matched == null) return null;
  return boundDiagnosticDetails({ level: "WARN", component: "parser", reason: matched, inputId });
}

function ownUnit<K extends RuntimeUnitId>(state: OwnerState, unit: K): RuntimeUnitStates[K] {
  const value: RuntimeUnitStates[K] | undefined = state.units[unit];
  if (value == null) throw new Error(`unit ${unit} is not owned by ${state.place}`);
  return value;
}

// Pairs a unit with its own state and the input: each case narrows all three together (P3-C0-NO-AS-FORM 1).
function unitJob(state: OwnerState, unit: RuntimeUnitId, input: UnitInput): UnitJob {
  switch (unit) {
    case "U-E": return { unit, state: ownUnit(state, unit), input };
    case "U-W": return { unit, state: ownUnit(state, unit), input };
    case "U-F": return { unit, state: ownUnit(state, unit), input };
    case "U-T": return { unit, state: ownUnit(state, unit), input };
    case "U-Q": return { unit, state: ownUnit(state, unit), input };
    case "U-N": return { unit, state: ownUnit(state, unit), input };
    case "U-V": return { unit, state: ownUnit(state, unit), input };
    case "U-L": return { unit, state: ownUnit(state, unit), input };
    case "U-R": return { unit, state: ownUnit(state, unit), input };
    case "U-B": return { unit, state: ownUnit(state, unit), input };
    case "U-M": return { unit, state: ownUnit(state, unit), input };
    case "U-Y": return { unit, state: ownUnit(state, unit), input };
    default: { const missing: never = unit; throw new Error(`unit ${String(missing)} has no job`); }
  }
}

// The one place a unit reducer is called: the job's unit, state and input cannot come from different units.
function runUnitJob(units: UnitTable, job: UnitJob): RuntimeUnitSteps[RuntimeUnitId] {
  switch (job.unit) {
    case "U-E": return units[job.unit].reduce(job.state, job.input);
    case "U-W": return units[job.unit].reduce(job.state, job.input);
    case "U-F": return units[job.unit].reduce(job.state, job.input);
    case "U-T": return units[job.unit].reduce(job.state, job.input);
    case "U-Q": return units[job.unit].reduce(job.state, job.input);
    case "U-N": return units[job.unit].reduce(job.state, job.input);
    case "U-V": return units[job.unit].reduce(job.state, job.input);
    case "U-L": return units[job.unit].reduce(job.state, job.input);
    case "U-R": return units[job.unit].reduce(job.state, job.input);
    case "U-B": return units[job.unit].reduce(job.state, job.input);
    case "U-M": return units[job.unit].reduce(job.state, job.input);
    case "U-Y": return units[job.unit].reduce(job.state, job.input);
    default: { const missing: never = job; throw new Error(`unit job ${String(missing)} is not handled`); }
  }
}

// The public view of one unit (never the unit state). 容量の拒否で normal を隠さない（P3-CC-AC01）。
// P3-UM-AC11 (8)（P3-UM-D-VIEW）: envelope のカードを全部、原文の本文を除いて写す（カードの無い unit は欄を書かない）。
// 同じ view と同じカードの配列には同じ object を返す（無いと、カードのある unit は view を出し直すたびに別の object になり、A8 が中身の
// 変わらない射影をやり直す）。
const cardedViews = new WeakMap<RuntimeUnitView, Readonly<{ cards: readonly UnreadableCard[]; view: RuntimeUnitView }>>();
const unitView = <K extends RuntimeUnitId>(state: OwnerState, units: UnitTable, unit: K): RuntimeViews[K] => units[unit].toView(ownUnit(state, unit));
function projectView(state: OwnerState, units: UnitTable, unit: RuntimeUnitId): RuntimeUnitView {
  const view: RuntimeUnitView = unitView(state, units, unit);
  const cards = state.unreadable[unit];
  if (cards == null || cards.length === 0) return view;
  const cached = cardedViews.get(view);
  if (cached?.cards === cards) return cached.view;
  const carded: RuntimeUnitView = { ...view, unreadableCards: cards.map(cardView) };
  cardedViews.set(view, { cards, view: carded });
  return carded;
}
function cardView({ raw, ...card }: UnreadableCard): UnreadableCardView {
  return { ...card, hasRaw: raw != null };
}

// ---- H43 のカード（P3-UM-AC11） ----

const TRUNCATED = "[truncated:fieldLimit]";
const text = (value: string, limit: number): string | null => value === "" ? null : boundedString(value, limit);
// (3)(12): 文字列は作るときに boundedString で切る。原文は木の正規形（unit が断った報・知らない種類）か展開した本文の先頭（parser が断った報）。
// rawCut は切った印（boundedString の印で終わるか。電文の原文は "</Report>" などで終わるので印と取り違えない）。
function makeCard(kind: UnreadableCard["kind"], reason: UnreadableCard["reason"], inputId: string, headType: string, receivedAt: number,
  material: DecodedMaterial | null, expandedText: string | null, areas?: UnreadableCard["areas"]): UnreadableCard {
  const raw = material == null ? expandedText : rewriteBounded([material.xml], CARD_TEXT.raw);
  return { kind, inputId, headType: boundedString(headType, CARD_TEXT.headType), operation: material?.operation ?? null, receivedAt, reason,
    title: material == null ? null : titleOf(material.xml), headline: material == null ? null : headlineOf(material.xml),
    reportDateTimeRaw: material == null ? null : text(material.reportDateTimeRaw, CARD_TEXT.reportDateTimeRaw),
    raw, rawCut: raw?.endsWith(TRUNCATED) === true, count: 1, ...areas == null ? {} : { areas } };
}
const cardRawBytes = (card: UnreadableCard): number => card.raw == null ? 0 : encoder.encode(JSON.stringify(card.raw)).byteLength;
const oldest = (cards: readonly UnreadableCard[], usable: (card: UnreadableCard) => boolean): number =>
  cards.reduce((found, card, index) => usable(card) && (found < 0 || card.receivedAt < cards[found].receivedAt) ? index : found, -1);
// (3)(4): 知らない種類は headType ごとに 1 枚（count を足し、中身は最後の報に替える）。原文の予算を越えたら受信時刻の古いカードから原文を外し、
// それでも枚数を越えたら最も古いカードを外す。dropped は外した原文とカードの数（H39 の unreadableDropped）。
// ponytail: カードは 8 か 16 枚なので、足すたびの線形の走査と原文の byte の数え直しでよい（P3-UM-AC17、Q-UM-COST）。
function placeCard(cards: readonly UnreadableCard[], unit: RuntimeUnitId, card: UnreadableCard): Readonly<{ cards: readonly UnreadableCard[]; dropped: number }> {
  const { cards: limit, rawBudget } = cardLimits(unit);
  const same = card.kind === "unknownType" ? cards.findIndex((item) => item.kind === "unknownType" && item.headType === card.headType) : -1;
  const next = same < 0 ? [...cards, card] : cards.map((item, index) => index !== same ? item
    : { ...card, count: Math.min(item.count + 1, Number.MAX_SAFE_INTEGER) });
  let dropped = 0, total = next.reduce((sum, item) => sum + cardRawBytes(item), 0);
  while (total > rawBudget) {
    const index = oldest(next, (item) => item.raw != null);
    total -= cardRawBytes(next[index]);
    // 欄の順は読み戻しの再直列化の照合と同じ（rawDropped は count の前、areas は最後）。原文を外しても areas は残す（AC11 (9)）。
    const { count, areas, ...rest } = next[index];
    next[index] = { ...rest, raw: null, rawDropped: true, count, ...areas == null ? {} : { areas } };
    dropped++;
  }
  while (next.length > limit) { next.splice(oldest(next, () => true), 1); dropped++; }
  return { cards: next, dropped };
}

// P3-NL-AC14 (2)(3)(4): 理由ごとの行に件数を足す（閉集合の外・別の unit の行は数えない）。count は安全な整数で飽和させ、lastAt は足した時の
// 手元の wall。何も足さなければ null。ponytail: 行は unit ごとに最大 8（P3-NL-RES-04、P3-UM-AC03 (4) で 1 語増えた）なので行の探索は線形。
function addLosses(rows: readonly LossTally[] | undefined, unit: RuntimeUnitId,
  items: readonly Readonly<{ reason: string; unit?: string; count?: number }>[], at: number): readonly LossTally[] | null {
  let next: LossTally[] | null = null;
  for (const item of items) {
    const reason = lossReasons(unit).find((value) => value === item.reason), count = item.count ?? 1;
    if (reason == null || item.unit != null && item.unit !== unit || !Number.isSafeInteger(count) || count < 1) continue;
    next ??= [...rows ?? []];
    const index = next.findIndex((row) => row.reason === reason);
    next[index < 0 ? next.length : index] = { reason, count: Math.min((index < 0 ? 0 : next[index].count) + count, Number.MAX_SAFE_INTEGER), lastAt: at };
  }
  return next;
}
// P3-NL-AC14 (5): 件数だけが変わった入力でもその unit の世代を進めて保存させる（unit の dirty と同じ形。domain の中身と contentRevision は
// 変えない）。無いと断っただけの入力の件数が保存されず、再起動で消える。
function raised(persistence: PersistenceStatus, monotonicMs: number): PersistenceStatus {
  const progress = { ...persistence, currentGeneration: persistence.currentGeneration + 1, dirtySince: persistence.dirtySince ?? monotonicMs };
  return persistence.kind === "saved" ? { ...progress, kind: "pending" } : progress;
}

// One owner request: its reducer calls, then the changes it must report, in the order they happened.
// basis は unit の receive・deadline・restore・shutdown の入力へ運ぶ要求の時計の根拠（P3-EF-AC01 (3)(4)、保存しない）。
function session(start: OwnerState, units: UnitTable, clock: ClockReading | null, basis: WallBasis = "verified") {
  let next = start;
  const changedUnits: RuntimeUnitId[] = [];
  const generationInputIds: Partial<Record<RuntimeUnitId, readonly string[]>> = {};
  const outcomes: RuntimePublishedOutcome[] = [];
  const displayChanges: RuntimeDisplayChange[] = [];
  const confirmationEvidence: CurrentConfirmationEvidence[] = [];
  const diagnostics: DiagnosticEvent[] = [];
  const viewUnits = new Set<RuntimeUnitId>();
  const changed = (unit: RuntimeUnitId) => { if (!changedUnits.includes(unit)) changedUnits.push(unit); };
  const diagnose = (details: DiagnosticDetails) => {
    if (clock == null) throw new Error("diagnostic requires an explicit clock");
    diagnostics.push(completeDiagnostic(details, clock, start.runId));
  };
  const reduceJob = (job: UnitJob, clock: ClockReading, receive: boolean) => { const unit = job.unit; // job は unitJob か notifyUnreadable が組む
    const step = runUnitJob(units, job);
    const previous = ownUnit(next, unit);
    // P3-NL-AC14 (4)(5): unit の採用の結果の診断を数える。同じ入力で unit が世代を進めたなら、その世代に含める。
    const losses = addLosses(next.losses[unit], unit, step.diagnostics, clock.wallTimeMs);
    if (losses != null) next = { ...next, losses: { ...next.losses, [unit]: losses } };
    const bump = losses != null && step.state.persistence.currentGeneration <= previous.persistence.currentGeneration;
    const persistence = bump ? raised(step.state.persistence, clock.monotonicMs) : step.state.persistence;
    if (persistence.currentGeneration > previous.persistence.currentGeneration)
      generationInputIds[unit] ??= [];
    if (step.state !== previous || bump) {
      const attempt = next.checkpointAttempts[unit];
      // The first changed durable generation after capture defines the next dirty interval.
      if (attempt != null && attempt.postCaptureDirtySince == null
        && persistence.currentGeneration > previous.persistence.currentGeneration
        && persistence.currentGeneration > attempt.generation) {
        next = { ...next, checkpointAttempts: { ...next.checkpointAttempts,
          [unit]: { ...attempt, postCaptureDirtySince: clock.monotonicMs } } };
      }
      next = { ...next, units: { ...next.units, [unit]: bump ? { ...step.state, persistence } : step.state } };
      changed(unit);
    }
    const deadline = step.nextDeadline;
    if (deadline != null && (deadline.wallTimeMs == null && deadline.monotonicMs == null
      || deadline.wallTimeMs != null && !Number.isFinite(deadline.wallTimeMs)
      || deadline.monotonicMs != null && !Number.isFinite(deadline.monotonicMs)))
      throw new RangeError("unit returned an invalid deadline");
    const previousDeadline = next.deadlines[unit] ?? null;
    if (deadline?.wallTimeMs !== previousDeadline?.wallTimeMs
      || deadline?.monotonicMs !== previousDeadline?.monotonicMs)
      next = { ...next, deadlines: { ...next.deadlines, [unit]: deadline } };
    for (const outcome of step.outcomes) outcomes.push({ unit, outcome });
    if (step.displayChanges.length !== 0) {
      displayChanges.push(...step.displayChanges);
      viewUnits.add(unit);
    }
    // 表示の変化の無い内容の変化（U-Q の当日履歴の日付の切り替え、P3-C7-SEM-04）も view を出し直す。
    if (step.state.contentRevision !== ownUnit(start, unit).contentRevision) viewUnits.add(unit);
    if (receive) confirmationEvidence.push(...step.confirmationEvidence);
    step.diagnostics.forEach(diagnose);
    return step;
  };
  const reduceUnit = (unit: RuntimeUnitId, unitInput: UnitInput) => reduceJob(unitJob(next, unit, unitInput), unitInput.clock, unitInput.kind === "receive");
  const notifyUnreadable = (unit: "U-E" | "U-T", input: UnreadableInput) => // P3-UM-AC12 (1): 読めない報のカードの通知の入力を 1 件渡す
    reduceJob(unit === "U-E" ? { unit, state: ownUnit(next, unit), input } : { unit, state: ownUnit(next, unit), input }, input.clock, false);
  // force: 根拠が verified に替わった要求で、到来の判定を通さず unit ごとに 1 回当てる（P3-EF-AC02 (7)。時計が後ろへ直っても保留の記録を回収する）。
  // 期限を何も持たない unit（nextDeadline が null）は当てるものが無いので送らない。
  const applyDeadlines = (targets: readonly RuntimeUnitId[], force = false, base?: OwnerState) => { // base は候補の受信の前の回収だけが渡す shadow の基点（U-R へ、P3-REC-AC12）
    if (clock == null || next.finalized) return;
    for (const unit of targets) {
      const deadline = next.deadlines[unit];
      if (deadline != null && (force || deadline.wallTimeMs != null && clock.wallTimeMs >= deadline.wallTimeMs
        || deadline.monotonicMs != null && clock.monotonicMs >= deadline.monotonicMs))
        reduceUnit(unit, { kind: "deadline", clock, basis, ...base == null || unit !== "U-R" ? {} : { recoveryBase: ownUnit(base, unit) } });
    }
  };
  // P3-UM-AC11 (5)(6)・AC13 (1): カードを足し、H39 に数え、件数と同じくその unit の世代を進めてこの入力に帰属させる（since はこの入力の処理の
  // 前の世代。unit がこの入力で既に進めていれば重ねない）。capture の後なら次の dirty の区間を始める（reduceUnit と同じ）。unit の断った報は
  // operation の whole を未確認にする負の証拠を載せる。
  const addCard = (unit: RuntimeUnitId, card: UnreadableCard, since: number, inputId: string, at: ClockReading, areasDropped = false) => { // areasDropped: AC11 (9)
    const placed = placeCard(next.unreadable[unit] ?? EMPTY, unit, card);
    const dropped = (card.rawCut ? 1 : 0) + (areasDropped ? 1 : 0) + placed.dropped;
    const losses = addLosses(next.losses[unit], unit, [{ reason: "unreadableReport" },
      ...dropped === 0 ? [] : [{ reason: "unreadableDropped", count: dropped }]], at.wallTimeMs) ?? next.losses[unit] ?? EMPTY;
    const current = ownUnit(next, unit).persistence;
    const persistence = current.currentGeneration > since ? current : raised(current, at.monotonicMs);
    const attempt = next.checkpointAttempts[unit];
    if (persistence !== current && attempt != null && attempt.postCaptureDirtySince == null && persistence.currentGeneration > attempt.generation)
      next = { ...next, checkpointAttempts: { ...next.checkpointAttempts, [unit]: { ...attempt, postCaptureDirtySince: at.monotonicMs } } };
    next = { ...next, units: { ...next.units, [unit]: { ...ownUnit(next, unit), persistence } }, losses: { ...next.losses, [unit]: losses },
      unreadable: { ...next.unreadable, [unit]: placed.cards } };
    generationInputIds[unit] = [inputId];
    changed(unit);
    viewUnits.add(unit);
    if (card.kind === "unreadable" && card.operation != null)
      confirmationEvidence.push({ source: "unreadableReport", scopes: [{ unit, operation: card.operation, kind: "unit" }] });
  };
  const setPersistence = (unit: RuntimeUnitId, persistence: PersistenceStatus) => {
    next = { ...next, units: { ...next.units, [unit]: { ...ownUnit(next, unit), persistence } } };
    changed(unit);
  };
  // beforeProjection: 印のあるときだけ owner-host が渡す測定時刻の読み口。state が決まった後・射影の前に 1 回呼ぶ（P3-UWR-AC08）。
  const finish = (project = true, beforeProjection?: () => void): OwnerStep => {
    // publisher が外す event 単位の確認記録: どの current も持たない event の U-E subject と、view から外れた U-T の VTSE41 subject
    // （I-U-T.confirmationScope。VTSE41 の subject は operation・EventID ごとに 1 つなので、外れた event を残りと照合しない）。
    let retiredEvents: OwnerOutput["retiredEvents"] = EMPTY;
    const leaving = (change: RuntimeDisplayChange) => change.after == null && change.before != null && change.before.current != null
      && (change.before.unit === "U-E" || change.before.unit === "U-T" && "areas" in change.before.current);
    if (displayChanges.some(leaving)) {
      const live = new Set(next.units["U-E"]?.current.map((item) => JSON.stringify([item.operation, item.eventId])));
      const retired: OwnerOutput["retiredEvents"][number][] = [];
      for (const change of displayChanges) {
        if (!leaving(change) || change.before?.current == null || !("eventId" in change.before.current)) continue;
        const unit = change.before.unit === "U-T" ? "U-T" as const : "U-E" as const;
        const eventId = change.before.current.eventId;
        if (unit === "U-T" || !live.has(JSON.stringify([change.operation, eventId]))) retired.push({ unit, operation: change.operation, eventId });
      }
      retiredEvents = retired;
    }
    beforeProjection?.();
    const views = !project || viewUnits.size === 0 ? EMPTY : [...viewUnits].map((unit) => projectView(next, units, unit));
    return { state: next, changedUnits, generationInputIds, views, outcomes, displayChanges, confirmationEvidence,
      retiredEvents, diagnostics };
  };
  return {
    get state() { return next; },
    set state(value: OwnerState) { next = value; },
    reduceUnit, notifyUnreadable, applyDeadlines, diagnose, setPersistence, finish, generationInputIds, displayChanges, outcomes, changed, addCard,
    viewed: (unit: RuntimeUnitId) => { viewUnits.add(unit); },
  };
}

function checkClock(clock: ClockReading): void {
  if (!Number.isFinite(clock.wallTimeMs) || !Number.isFinite(clock.monotonicMs))
    throw new RangeError("runtime clock must be finite");
}

// 起動時の owner の unit の復元（owner ごとの P2-A3-AC09）。各 unit の restore は 1 回だけで、復元した persistence を合成しない。view は
// 復元と期限を当てた後に ownerViews が射影する。
function restoreOwner(input: Readonly<{ runId: string; place: ExecutionPlace; clock: ClockReading; basis?: WallBasis;
  restored: Readonly<Partial<Record<RuntimeUnitId, RestoreUnitResult>>> }>,
units: UnitTable, codecs: CodecMap<RuntimeUnitStates>): OwnerStep & Readonly<{ restoration: Partial<RuntimeRestoration> }> {
  const own = placeUnits(input.place);
  if (input.runId.length === 0 || own.some((unit) => input.restored[unit] == null)) throw new RangeError("invalid startup input");
  checkClock(input.clock);
  const pick = <T>(value: (unit: RuntimeUnitId) => T) => Object.fromEntries(own.map((unit) => [unit, value(unit)]));
  const start: OwnerState = { runId: input.runId, place: input.place, units: pick((unit) => initialUnits[unit]),
    deadlines: pick(() => null), checkpointAttempts: {}, losses: {}, unreadable: {}, accepting: true, finalized: false };
  const work = session(start, units, input.clock, input.basis);
  const restoration: Partial<Record<RuntimeUnitId, RuntimeRestoration[RuntimeUnitId]>> = {};
  const restoreUnit = <K extends RuntimeUnitId>(unit: K) => {
    const restored = input.restored[unit]!;
    if (restored.kind === "empty" || restored.kind === "unavailable") { restoration[unit] = restored; return; }
    const { envelope } = restored;
    const codec = codecs?.[unit];
    if (envelope.unit !== unit || envelope.schemaVersion !== initialUnits[unit].schemaVersion
      || !Number.isSafeInteger(envelope.generation) || envelope.generation < 1
      || !Number.isFinite(envelope.capturedAt) || codec == null)
      throw new RangeError("invalid restored unit envelope");
    const decoded = codec.decode(envelope.payload);
    if (decoded.kind !== "restored") { restoration[unit] = { kind: "unavailable", reason: "noValidSlot" }; return; }
    const persistence: PersistenceStatus = { kind: "saved", currentGeneration: envelope.generation,
      savedGeneration: envelope.generation, savedCapturedAt: envelope.capturedAt, savedAckAt: null, dirtySince: null };
    const seeded = { ...decoded.state, persistence };
    // P3-NL-AC14 (6): lastAt＋24 時間を過ぎた行は復元のときに外す。
    const kept = keptLosses(envelope.losses ?? [], input.clock.wallTimeMs).losses;
    // P3-UM-AC11 (4)(6): 受信時刻＋24 時間を過ぎたカードは復元のときに外す（H39 には数えない）。
    const cards = keptCards(envelope.unreadable ?? [], input.clock.wallTimeMs).unreadable;
    // 唯一の `as`: CodecMap は JsonValue で型付けされ、state と保存の payload はこの unit 自身の codec が作った。K が generic なので
    // ここでは job 全体が相関した union から外れ、unit・state・入力の対応は目で確かめる。
    const step = runUnitJob(units, { unit, state: seeded,
      input: { kind: "restore", persisted: codec.encode(seeded), clock: input.clock, basis: input.basis ?? "verified" } } as UnitJob);
    // P3-NL-AC14 (4)(5) の読み（Q-NL-PRECHECK-2 (1)(i)）: 復元の診断（通知したか不明）も数え、件数だけが変われば世代を進める。
    const losses = addLosses(kept, unit, step.diagnostics, input.clock.wallTimeMs) ?? kept;
    const unitState = losses !== kept && step.state.persistence.currentGeneration <= envelope.generation
      ? { ...step.state, persistence: raised(step.state.persistence, input.clock.monotonicMs) } : step.state;
    work.state = { ...work.state, units: { ...work.state.units, [unit]: unitState },
      deadlines: { ...work.state.deadlines, [unit]: step.nextDeadline }, ...losses == null ? {} : { losses: { ...work.state.losses, [unit]: losses } },
      ...cards == null ? {} : { unreadable: { ...work.state.unreadable, [unit]: cards } } };
    restoration[unit] = { kind: "restored" };
    work.changed(unit);
    if (unitState.persistence.currentGeneration > envelope.generation) work.generationInputIds[unit] = [];
    for (const outcome of step.outcomes) work.outcomes.push({ unit, outcome });
    work.displayChanges.push(...step.displayChanges.filter((change) => change.after != null)
      .map((change) => ({ ...change, before: null })));
    step.diagnostics.forEach(work.diagnose);
  };
  for (const unit of own) restoreUnit(unit);
  return { ...work.finish(false), restoration };
}

// P3-UM-AC11 (4)(8): 遅れて返す step の view を、返すときの state から射影し直す（capture の時の view を送ると、その後の入力で変わった
// その unit の view を publisher の写しで巻き戻す。ヘルツ r0 の P2）。
function refreshedViews(step: OwnerStep, state: OwnerState, units: UnitTable): OwnerStep {
  return step.views.length === 0 ? step : { ...step, views: step.views.map((view) => projectView(state, units, view.unit)) };
}

// Every own unit's current view (startup and the publisher's first mirror).
function ownerViews(state: OwnerState, units: UnitTable): readonly RuntimeUnitView[] {
  return placeUnits(state.place).map((unit) => projectView(state, units, unit));
}

// Deadline request: the owner applies its own units' due deadlines (P3-C3A-DEADLINES).
function deadlineOwner(state: OwnerState, clock: ClockReading, units: UnitTable, basis: WallBasis = "verified", force = false): OwnerStep {
  checkClock(clock);
  const work = session(state, units, clock, basis);
  work.applyDeadlines(placeUnits(state.place), force);
  return work.finish();
}

function routedUnit(state: OwnerState, completion: ParserCompletion): RuntimeUnitId | undefined {
  const route = completion.result.kind === "decoded" ? classifyHeadType(completion.result.material.headType) : null;
  if (!state.accepting || route?.status !== "ready") return undefined;
  if (executionPlaces[route.unit] !== state.place) throw new Error(`input for ${route.unit} reached the ${state.place} owner`);
  return route.unit;
}

// parser の入力 1 件: 振り分け、受信、またはちょうど 1 件の診断（P3-UNIT-TABLE-001、P3-C3A-NONREADY）。
// seen は取り直しの候補だけが渡す: 版が決まらず unit が採らなかったか（noChange。結果を held にする、作者裁定 2026-10-28 午後）。
function receiveOwner(state: OwnerState, completion: ParserCompletion, clock: ClockReading, units: UnitTable,
  beforeProjection?: () => void, basis: WallBasis = "verified", seen?: { held: boolean; base?: OwnerState }): OwnerStep {
  checkClock(clock);
  const work = session(state, units, clock, basis);
  if (completion.runId !== state.runId || state.finalized) return work.finish(true, beforeProjection);
  const unit = routedUnit(state, completion);
  const route = completion.result.kind === "decoded" ? classifyHeadType(completion.result.material.headType) : null;
  // 受信の前に、求める unit は自分の wall の期限（記録の期限）を回収する。回収は parser の入力に帰属させず、この入力の名を
  // 持つのは下の受信だけ。
  if (unit != null && units[unit].reclaimDeadlineBeforeReceive && state.deadlines[unit]?.wallTimeMs != null)
    work.applyDeadlines([unit], false, seen?.base);
  // unit は共通の Head・日時の検査を自分でもう一度行う（入力ごとに診断 1 件）。U-W は拒否した入力でも §7.8 の鮮度の監視を続ける
  // （A1 freshnessException）。
  // P3-UM-AC11 (1)(2): カードの受信時刻は item の値。inputId が保存の読み戻しの上限（validInputId）を外れる入力はカードにしない（無いと
  // その unit の保存が丸ごと読めなくなる。host の input-N は外れない）。
  const receivedAt = completion.receivedAt ?? clock.wallTimeMs, cardable = state.accepting && validInputId(completion.inputId);
  // P3-UM-AC12 (1)(9)(10): U-E・U-T のカードは足す前に（同じ世代に入れる）通知の入力を渡す。取り直しの候補は渡さない（音は採用の step の recoveryNotices。渡すと候補の U-T に基点に無い intent ができ、部分集合の検査で候補ごと捨てられる）。
  const origin = completion.origin ?? (completion.result.kind === "decoded" ? completion.result.material.origin : "live"), place = (unit: RuntimeUnitId, card: UnreadableCard, since: number, areasDropped = false) => {
    if (origin !== "recovery" && (unit === "U-E" || unit === "U-T")) work.notifyUnreadable(unit, { kind: "unreadable", headType: card.headType, operation: card.operation, receivedAt, inputId: completion.inputId, origin, clock });
    work.addCard(unit, card, since, completion.inputId, clock, areasDropped); };
  if (unit != null && completion.result.kind === "decoded") {
    const generationBeforeReceive = ownUnit(work.state, unit).persistence.currentGeneration, lossesBefore = work.state.losses[unit];
    const { material } = completion.result;
    const received = work.reduceUnit(unit, { kind: "receive", material, clock, basis });
    if (seen != null) seen.held = received.decisions.some((decision) => decision.decision === "unchanged" && decision.reason === "noChange");
    // (1): unit が断った入力（共通の封筒の検査を含む）は unreadable のカード。ignored・stale・duplicate・capacityExceeded はカードにしない。
    // 1 つの入力に断った decision が複数あれば最初の理由で 1 枚。
    let rejected: RejectionReason | null = null, areas: CardAreas | undefined; // U-Y は地域ごとの不備だけで断った報に地域ごとの値を添える（AC14 (1)(2)）
    for (const decision of received.decisions) if (decision.decision === "rejected") { rejected = decision.reason; areas = "areas" in decision ? decision.areas : undefined; break; }
    if (rejected != null && cardable) { const chosen = areas == null ? null : cardAreas(areas);
      place(unit, makeCard("unreadable", rejected, completion.inputId, material.headType, receivedAt, material, null, chosen?.areas), generationBeforeReceive, chosen?.dropped); }
    // 容量の拒否でも失敗警報と title の書き換えで世代が進めば、その世代に帰属させる（P3-CC-AC10(9)、正常採用の扱いにはしない）。
    // U-E の採らない取消が取消の intent と印を足した世代、件数だけが変わった世代も同じ（P3-NL-AC04 (5)・AC14 (5)）。
    if (ownUnit(work.state, unit).persistence.currentGeneration > generationBeforeReceive
      && (received.intents.length !== 0 || work.state.losses[unit] !== lossesBefore
        || received.decisions.some((decision) => decision.decision === "changed" || decision.decision === "capacityExceeded")))
      work.generationInputIds[unit] = [completion.inputId];
  } else if (completion.result.kind === "rejected") {
    const { diagnostic } = completion.result;
    const details = parserDiagnostic(diagnostic.reason, diagnostic.inputId);
    if (details != null) work.diagnose(details);
    // (1)(2): parser が断った入力は unidentified のカード。振り分け先は item の headType（ignored はカードにしない、unit の無い入力は U-M）。
    // mailbox は同じ headType で owner を選ぶ（placeOfHeadType）ので、振り分け先はこの owner の unit になる。
    const reason = parserDiagnosticReasons.find((candidate) => candidate === diagnostic.reason);
    const target = completion.headType == null ? null : classifyHeadType(completion.headType);
    const owner = target?.status === "ready" ? target.unit : target == null || target.status === "ignored" ? null : "U-M";
    if (owner != null && reason != null && cardable && completion.headType != null && state.units[owner] != null)
      place(owner, makeCard("unidentified", reason, completion.inputId, completion.headType, receivedAt, null, diagnostic.expandedText ?? null),
        ownUnit(state, owner).persistence.currentGeneration);
  } else if (route?.status === "ignored") {
    // P3-UNIT-TABLE-001: 入力ごとに診断は 1 件まで。無視する headType は封筒の検査をしない。
    work.diagnose(boundDiagnosticDetails({ level: "INFO", component: "shared-runtime", reason: "routeIgnored", inputId: completion.inputId }));
  } else {
    const { material } = completion.result;
    const result = validateSemanticEnvelope(material);
    if (result.kind === "rejected") work.diagnose(result.diagnostic);
    else if (route?.status === "notPorted")
      work.diagnose(boundDiagnosticDetails({ level: "INFO", component: "shared-runtime", reason: "routeNotPorted",
        unit: route.candidate, inputId: completion.inputId }));
    else if (route?.status === "unlisted")
      work.diagnose(boundDiagnosticDetails({ level: "WARN", component: "shared-runtime", reason: "routeUnlisted", inputId: completion.inputId }));
    // (1)(2): unit の無い入力は封筒の検査の結果によらず、deferred の owner の U-M に headType ごとの unknownType のカード（Q-UM-PRECHECK-3 の M6）。
    if ((route?.status === "notPorted" || route?.status === "unlisted") && cardable && state.units["U-M"] != null)
      work.addCard("U-M", makeCard("unknownType", route.status === "notPorted" ? "routeNotPorted" : "routeUnlisted", completion.inputId,
        material.headType, receivedAt, material, null), ownUnit(state, "U-M").persistence.currentGeneration, completion.inputId, clock);
  }
  return work.finish(true, beforeProjection);
}

// 1 unit の照合済みの intent の更新を 1 回の unit 入力でまとめて採るか、まったく採らない（P2-A1 B4、P3-C3A-NOTIFY-ADOPT）。unit が
// pending として持たない intent への更新は何も採らない。decision は固定した判断の時計。
function intentUpdateOwner<K extends RuntimeUnitId>(state: OwnerState, unit: K, updates: readonly NotificationIntentUpdate[],
  decision: ClockReading, units: UnitTable): OwnerStep & Readonly<{ adopted: boolean }> {
  checkClock(decision);
  const work = session(state, units, decision);
  const before = ownUnit(state, unit);
  const originals = new Map(before.intents.map((intent) => [intent.id, intent]));
  if (state.finalized || updates.length === 0 || updates.some((update) => originals.get(update.id)?.disposition !== "pending"))
    return { ...work.finish(), adopted: false };
  const previousGeneration = before.persistence.currentGeneration;
  // ponytail: unit ごとの pending は 128 件まで（P3-NL-AC05 で終端記録は無い）。上限が増えても O(K) の一括のままにする。
  work.reduceUnit(unit, { kind: "intentUpdate", clock: decision, intentUpdate: updates.length === 1 ? updates[0] : updates });
  const adopted = ownUnit(work.state, unit);
  const intentsById = new Map(adopted.intents.map((intent) => [intent.id, intent]));
  // P3-NL-AC05 (3): 終端の intent は全 unit で印に置き換わるので、intents に無く世代が進んだことで採用を確かめる。
  for (const candidate of updates) {
    const intent = intentsById.get(candidate.id);
    if (candidate.disposition !== "pending" ? intent != null || adopted.persistence.currentGeneration <= previousGeneration
      : intent?.attempts !== candidate.attempts || intent.nextAttemptAt !== candidate.nextAttemptAt
        || intent.disposition !== candidate.disposition || intent.lastAttempt !== candidate.lastAttempt
        || intent.replayed !== candidate.replayed || intent.expiresAt !== candidate.expiresAt)
      throw new Error("unit did not adopt the correlated intent update");
  }
  // P3-NL-AC14 (4): 採用した更新の lossReason を数える（終端の更新だけが持ち、採用で世代は進んでいる）。
  const losses = addLosses(work.state.losses[unit], unit, updates.flatMap((update) => update.lossReason == null ? [] : [{ reason: update.lossReason }]),
    decision.wallTimeMs);
  if (losses != null) work.state = { ...work.state, losses: { ...work.state.losses, [unit]: losses } };
  return { ...work.finish(), adopted: true };
}

// The capture of one save attempt: the generation it saves and when (P2-A3-AC10 ordering).
function capturedOwner(state: OwnerState, capture: CheckpointCapture, units: UnitTable): OwnerStep {
  if (!Number.isSafeInteger(capture.generation) || capture.generation < 1 || !Number.isFinite(capture.capturedAt)
    || capture.attemptId.length === 0) throw new RangeError("invalid checkpoint capture");
  const work = session(state, units, null);
  const unit = capture.unit;
  const previous = state.units[unit]?.persistence;
  if (previous != null && capture.generation === previous.currentGeneration
    && capture.generation > (previous.savedGeneration ?? 0) && state.checkpointAttempts[unit] == null) {
    work.state = { ...state, checkpointAttempts: { ...state.checkpointAttempts, [unit]: {
      unit, attemptId: capture.attemptId, generation: capture.generation,
      capturedAt: capture.capturedAt, postCaptureDirtySince: null,
    } } };
  }
  // P3-NL-AC14 (6): capture が envelope から外した行（lastAt＋24 時間を過ぎた行）は、加算元からも外す。無いと外した行が state に残り、
  // 次の加算で再び保存され、再起動を挟むかで同じ入力の件数が変わる。
  const losses = work.state.losses[unit];
  if (losses != null) {
    const kept = keptLosses(losses, capture.capturedAt).losses;
    if (kept?.length !== losses.length) work.state = { ...work.state, losses: { ...work.state.losses, [unit]: kept } };
  }
  // P3-UM-AC11 (4): capture が外したカードも同じく加算元から外し、view を出し直す。
  const cards = work.state.unreadable[unit];
  if (cards != null) {
    const kept = keptCards(cards, capture.capturedAt).unreadable;
    if (kept !== cards) { work.state = { ...work.state, unreadable: { ...work.state.unreadable, [unit]: kept } }; work.viewed(unit); }
  }
  return work.finish();
}

// The result of the owner's own save attempt. dirtySince clears only when the acknowledged generation is current
// (P3-C3A-CHECKPOINT-ACK): an old ack advances savedGeneration and keeps the post-capture dirty time.
function checkpointResultOwner(state: OwnerState, result: CheckpointResult, units: UnitTable): OwnerStep {
  const work = session(state, units, null);
  const unit = runtimeUnits.find((candidate) => candidate === result.unit);
  const previous = unit == null ? undefined : state.units[unit]?.persistence;
  const attempt = unit == null ? undefined : state.checkpointAttempts[unit];
  if (unit == null || previous == null || attempt == null || attempt.attemptId !== result.attemptId
    || attempt.unit !== result.unit || attempt.generation !== result.generation
    || result.generation <= (previous.savedGeneration ?? 0) || result.generation > previous.currentGeneration)
    return work.finish();
  const progress = {
    currentGeneration: previous.currentGeneration, savedGeneration: previous.savedGeneration,
    savedCapturedAt: previous.savedCapturedAt, savedAckAt: previous.savedAckAt, dirtySince: previous.dirtySince,
  };
  if (result.kind === "acknowledged") {
    const saved = previous.currentGeneration === result.generation;
    if (!saved && attempt.postCaptureDirtySince == null)
      throw new Error("checkpoint capture was not ordered before durable updates");
    work.setPersistence(unit, { ...progress, kind: saved ? "saved" : "pending",
      savedGeneration: result.generation, savedCapturedAt: attempt.capturedAt, savedAckAt: result.ackAt,
      dirtySince: saved ? null : attempt.postCaptureDirtySince });
  } else if (result.kind === "failed") {
    work.setPersistence(unit, { ...progress, kind: "failed", stage: result.stage, reason: boundedString(result.reason) });
  } else if (previous.kind !== "uncertain" || previous.attemptedGeneration !== result.generation) {
    work.setPersistence(unit, { ...progress, kind: "uncertain", attemptedGeneration: result.generation });
  }
  if (result.kind !== "uncertain") {
    const attempts = { ...work.state.checkpointAttempts };
    delete attempts[unit];
    work.state = { ...work.state, checkpointAttempts: attempts };
  }
  return work.finish();
}

// spec §5.9 step 3: each unit's declared shutdown input; later parser inputs are not applied.
function shutdownInputOwner(state: OwnerState, clock: ClockReading, units: UnitTable, basis: WallBasis = "verified"): OwnerStep {
  checkClock(clock);
  const work = session(state, units, clock, basis);
  for (const unit of placeUnits(state.place)) work.reduceUnit(unit, { kind: "shutdown", clock, basis });
  work.state = { ...work.state, accepting: false };
  return work.finish();
}

// spec §5.9 step 4: deadlines up to cutoff apply, later ones are evaluated at the next start.
function finalizeOwner(state: OwnerState, cutoff: ClockReading, units: UnitTable, basis: WallBasis = "verified"): OwnerStep {
  checkClock(cutoff);
  const work = session(state, units, cutoff, basis);
  work.applyDeadlines(placeUnits(state.place));
  work.state = { ...work.state, finalized: true };
  return work.finish();
}

// ---- 取り直しの候補（P3-RECOVERY-001 発注 3、P3-REC-D-CANDIDATE-PLACE=A） ----

// P3-REC-AC07（発注前点検 N12）: 候補が基点にした unit が今の live と同じか。currentGeneration と、persistence を除いた unit の state の欄の参照・
// カード・件数・期限を比べる（欄の数は定数で O(1)、state を直列化しない、P3-REC-AC16）。保存の ack と capture（persistence・checkpointAttempts）は
// 比べない（無いと、ack だけで当て直しが走り、RES-08 を越えた候補は generationConflict になる）。違えば候補を今の live に当て直す。
function sameBase(live: OwnerState, base: OwnerState, unit: RuntimeUnitId): boolean {
  const now = live.units[unit], then = base.units[unit];
  if (now == null || then == null || now.persistence.currentGeneration !== then.persistence.currentGeneration) return false;
  const fields = new Map(Object.entries(then));
  return Object.entries(now).every(([key, value]) => key === "persistence" || fields.get(key) === value)
    && live.unreadable[unit] === base.unreadable[unit] && live.losses[unit] === base.losses[unit] && live.deadlines[unit] === base.deadlines[unit];
}

// P3-REC-AC06 (b): 候補の下で見た本文 1 件の結果。parser が断った報は unreadable、負の証拠のある報はその語、ほかは adopted（変化・重複・古い報を問わない）。
function recoveryResult(completion: ParserCompletion, step: OwnerStep, held: boolean): RecoveryInputResult["result"] {
  if (completion.result.kind === "rejected") return "unreadable";
  if (held) return "held";
  for (const evidence of step.confirmationEvidence)
    if (evidence.source === "capacityExceeded" || evidence.source === "unreadableReport") return evidence.source;
  return "adopted";
}

/**
 * 候補の採用の step（P3-REC-AC06 (a)・AC07・AC08）。shadow は live と同じ基点から作った候補で、その unit の欄を live へ差し替える。
 * 部分集合の検査（候補の pending の id は基点の pending の id の内）の後に、unit が引上げ（H27）と読めない報の info を作り、期限を今の時計と根拠で当てる。
 * 検査に外れたら null（候補を捨てる）。inputIds は候補に入れた入力（世代の帰属、P2-A3-AC10）。
 */
function adoptRecoveryOwner(live: OwnerState, shadow: OwnerState, unit: RuntimeUnitId, recoveryId: string, open: OwnerState, inputIds: readonly string[],
  clock: ClockReading, units: UnitTable, basis: WallBasis, removals: Map<string, DisplayRemoval | null>): OwnerStep | null { // removals: 候補の Map（P4-RL-AC03）
  checkClock(clock);
  const before = new Set(ownUnit(live, unit).intents.map((intent) => intent.id));
  if (ownUnit(shadow, unit).intents.some((intent) => !before.has(intent.id))) return null;
  const work = session(live, units, clock, basis);
  // 保存の進み具合は live の最新を保ち、候補が進めた世代を載せる。capture の後なら次の dirty の区間を始める（reduceUnit と同じ）。
  // P3-RB-AC01（D-RAISE=A）: 候補が世代を進めていなくても 1 つ進める。無いと state の変わらない取り直しで resolve した境界が保存に載らない。
  const current = ownUnit(live, unit).persistence, generation = Math.max(ownUnit(shadow, unit).persistence.currentGeneration, current.currentGeneration + 1);
  const persistence = { ...raised(current, clock.monotonicMs), currentGeneration: generation };
  const attempt = live.checkpointAttempts[unit];
  const attempts = attempt != null && attempt.postCaptureDirtySince == null && generation > attempt.generation
    ? { ...live.checkpointAttempts, [unit]: { ...attempt, postCaptureDirtySince: clock.monotonicMs } } : live.checkpointAttempts;
  let adopted: OwnerState = { ...live, units: { ...live.units, [unit]: { ...ownUnit(shadow, unit), persistence } },
    unreadable: { ...live.unreadable, [unit]: shadow.unreadable[unit] }, losses: { ...live.losses, [unit]: shadow.losses[unit] },
    checkpointAttempts: attempts, deadlines: { ...live.deadlines, [unit]: shadow.deadlines[unit] } };
  // P3-REC-AC12（発注 4a）: 採用の step の音（H27 と U-T の読めない報の info）は unit の行の recoveryNotices が作る（owner-runtime は unit を import しない、台帳 104 の循環）。
  work.state = adopted = noticed(units, unit, { live, open, adopted, recoveryId, inputIds, clock, basis });
  work.generationInputIds[unit] = inputIds; // 採用は必ず世代を進めるので、その世代に候補の入力を結ぶ（空の候補は空の列、P2-A3-AC10）
  work.changed(unit);
  work.viewed(unit);
  // U-R の期限は基点（採用の直前の live）でその subject が見えていなかった記録の intent を作らない（候補を作る間の回収と同じ規則、P3-REC-AC12・Q-REC-IMPL-4b-1 (b)）。
  work.applyDeadlines([unit], false, live); noteRemovals(removals, work.displayChanges); // P4-RL-AC03 (3): 空にする前に期限の step の removal を Map に足し、正味の消失に Map の値を付ける（無ければ unknown）
  // P3-REC-AC07（投影の直し）: 期限の step が積んだ差分を、採用の直前の live から最終の state への正味の差分に置き換える（追記すると期限を二重に数える）。
  work.displayChanges.length = 0;
  for (const change of netChanges(units, unit, live, work.state)) work.displayChanges.push(change.after == null ? { ...change, removal: removals.get(removalKey(change)) ?? "unknown" } : change);
  return work.finish();
}

// P3-REC-AC07（Q-REC-PRECHECK-7 の N2）: unit の行の recoveryChanges で正味の表示の変化を作る。行の無い unit は止める（無いと、採用した記録を
// publisher の投影が知らず、その記録が live で変わると view-projector が RangeError）。
function netChanges<K extends RuntimeUnitId>(units: UnitTable, unit: K, live: OwnerState, adopted: OwnerState): readonly RuntimeDisplayChange[] {
  const changes = units[unit].recoveryChanges;
  if (changes == null) throw new RangeError(`unit ${unit} has no recovery display changes`);
  return changes(ownUnit(live, unit), ownUnit(adopted, unit));
}

// 採用の step の音（P3-REC-AC12）。音の intent は候補の採用と同じ世代に入れる（候補が世代を進めていなければ 1 つ進める、P3-NL-AC14 (5) の形）。
// 行の無い unit（U-Q・U-B・U-M・U-Y はカードだけ、P3-REC-D-N2-RAISE=A・-4B=A）は鳴らさない。U-T の card は P3-UM-AC12 (10): 候補の origin=recovery の
// 読めないカードの最初の 1 枚（ほかの unit の行は使わない）。
type RecoverySound = Readonly<{ live: OwnerState; open: OwnerState; adopted: OwnerState; recoveryId: string; inputIds: readonly string[]; clock: ClockReading; basis: WallBasis }>;
function noticed<K extends RuntimeUnitId>(units: UnitTable, unit: K, at: RecoverySound): OwnerState {
  const notices = units[unit].recoveryNotices;
  if (notices == null) return at.adopted;
  const ids = new Set(at.inputIds), card = (at.adopted.unreadable[unit] ?? EMPTY).find((item) => ids.has(item.inputId) && item.kind !== "unknownType");
  const candidate = ownUnit(at.adopted, unit), result = notices(ownUnit(at.open, unit), candidate, { recoveryId: at.recoveryId, clock: at.clock, basis: at.basis, live: ownUnit(at.live, unit),
    card: card == null ? null : { operation: card.operation, receivedAt: card.receivedAt, inputId: card.inputId, headType: card.headType } });
  if (result === candidate) return at.adopted;
  const persistence = result.persistence.currentGeneration > ownUnit(at.live, unit).persistence.currentGeneration ? result.persistence : raised(result.persistence, at.clock.monotonicMs);
  return { ...at.adopted, units: { ...at.adopted.units, [unit]: { ...result, persistence } } };
}

// P3-UFP-AC06: owner の state から U-F の詳細の 1 ページを作る。U-F の関数を直接呼ぶ（Q-UFP-DETAIL-PATH）。
function detailOwner(state: OwnerState, request: WeatherTimeseriesDetailRequest | WeatherCurrentDetailRequest | BulletinTextRequest | WireDetailRequest): WeatherTimeseriesDetailResponse | WeatherCurrentDetailResponse | BulletinTextResponse | WireDetailResponse { if (isWireDetail(request)) return wireDetail(state, request); // P4-DW-AC08: 新しい part は先に分ける
  // P3-UWC-AC07 (3): U-W の要求（unit で判別）は U-W の関数へ。どちらも state も期限も動かさない。
  if ("unit" in request && request.unit !== "U-W") return bulletinText(request.unit === "U-V" ? state.units["U-V"]?.bulletins : state.units["U-N"]?.information, request);
  if ("unit" in request) { const unit = state.units["U-W"]; return unit == null ? { kind: "error", reason: "unavailable", revision: null } : weatherCurrentDetail(unit, request, { contentRevision: String(unit.contentRevision) }); }
  const unit = state.units["U-F"]; return unit == null ? { kind: "error", reason: "unavailable", revision: null } : weatherTimeseriesDetail(unit, request, { contentRevision: String(unit.contentRevision) });
}

// P3-BT-AC03: 見出しが view に載っている記録の本文だけを答える。urgent の owner で動くので、探索は 64 件以下の 1 回に留め、本文を直列化しない（P3-BT-AC05）。
function bulletinText(records: readonly (VolcanoBulletin | NankaiInformation)[] | undefined, request: BulletinTextRequest): BulletinTextResponse {
  if (records == null) return { kind: "error", reason: "unavailable", revision: null };
  const record = records.find((item) => item.subject === request.id);
  if (record == null || record.effective !== "active" || record.expiryPending === true) return { kind: "error", reason: "versionChanged", revision: null };
  // 時刻の欄を含む鍵は P3-BT-D-KEY のまま（決めた時は採番が起動ごとに戻っていた。P3-FINAL-REVIEW-FIX-001 の後は、保存から戻したどの inputId よりも大きい番号から振る。保存に届かなかった番号は次の起動でもう一度振られうる）。
  const { inputId, reportDateTimeRaw, controlDateTimeRaw } = record.source, revision = JSON.stringify([inputId, reportDateTimeRaw, controlDateTimeRaw]);
  if (revision !== request.revision) return { kind: "error", reason: "versionChanged", revision };
  return { kind: "ok", part: "text", id: record.subject, revision, text: record.text, nextAdvisory: record.nextAdvisory };
}

// P3-UM-AC11 (9)・AC14 (2): U-Y の地域を「不明＞5 日積算の高い＞低い」の順で 384 件・24,576 byte（JSON の配列の UTF-8 の長さ）に収まるまで選び、
// 5 日積算の高い順（不明は最後、同じなら code の順）に並べる。dropped は落とした地域があったか。
type CardAreas = NonNullable<UnreadableCard["areas"]>;
function cardAreas(areas: CardAreas): Readonly<{ areas: CardAreas; dropped: boolean }> {
  const order = (left: CardAreas[number], right: CardAreas[number]) => (right.value ?? -1) - (left.value ?? -1) || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0);
  const ranked = [...areas].sort((left, right) => (left.value == null) === (right.value == null) ? order(left, right) : left.value == null ? -1 : 1);
  const kept: CardAreas[number][] = [];
  let size = 2;
  for (const area of ranked) {
    const add = encoder.encode(JSON.stringify(area)).byteLength + (kept.length === 0 ? 0 : 1);
    if (kept.length >= CARD_AREAS || size + add > CARD_AREAS_BYTES) break;
    kept.push(area);
    size += add;
  }
  return { areas: kept.sort(order), dropped: kept.length < areas.length };
}

export {
  adoptRecoveryOwner, capturedOwner, checkpointResultOwner, deadlineOwner, detailOwner, finalizeOwner, initialUnits, intentUpdateOwner, noteRemovals, ownerViews, recoveryResult, removalKey, sameBase,
  placeUnits, receiveOwner, refreshedViews, reportDateTime, restoreOwner, shutdownInputOwner, validateSemanticEnvelope,
};
export type { OwnerState, OwnerStep, ParserCompletion };

// ---- P4-DISPLAY-WIRE-001（B0）: 新しい part の詳細（P4-DW-AC08、表 §2）。import は行を足さない書き方のため file の最後に置く（宣言は巻き上がる） ----
import { createHash } from "node:crypto";
import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { ReportRef as WireReportRef, RuntimeUnitStates as WireUnitStates } from "../../contracts/p2-shared-runtime.types";
import type { EewAreaDetail, WireDetailRequest, WireDetailResponse, WireEventHeader, WireIndexEntry, WireLongPeriodHeader, WireOmitted, WireOmittedField } from "../../contracts/p4-display-wire.types";
import type { MarkViewed as WireMarkViewed } from "../../contracts/p2-shared-runtime.types";
import type { EarthquakeContribution, EarthquakeEvent, EarthquakeEventView, EarthquakeFamily, LongPeriodSubject, SeismicIntensityItem } from "../../contracts/p3-seismic-unit.types";
import type { TsunamiForecastSubject, TsunamiObservationSubject } from "../../contracts/p3-tsunami-unit.types";
import { shown } from "../units/notice-mark";
import { markView } from "../units/unreadable";
// P4-DISPLAY-VOCAB-001: 9 分野の索引の項目と part=item・unreadable。weather の 2 つの module は上で既に読む（循環を足さない）。
import type { UnreadableMark as WireUnreadableMark } from "../../contracts/p2-shared-runtime.types";
import type { VocabIndexItem, VocabIndexUnit, VocabItem, VocabUnit, WireIndexOmitted, WireUnreadableSide } from "../../contracts/p4-display-wire.types";
import { vocabItem } from "../view-projector/display-vocab";
import { timeseriesPublicSubject } from "../units/weather-timeseries/weather-timeseries-unit";
import { weatherCurrentAreas } from "../units/weather-current/weather-current-public";

// ---- unit の view の写し（P4-DW-AC08 の詳細の照合用） ----
// owner は unit の toView を import できない（domain が shared-runtime 経由でこの module を読むので、unit の module を読むと循環して
// 初期化の前の値を読む）。詳細の rev は view の object の JSON の sha256 なので、ここで同じ形を作る。形が unit の toView と同じことは
// P4-DW-T06 が corpus の全部で照らす。
type Viewable = Readonly<{ effective: string; expiryPending?: true }>;
const onScreen = (value: Viewable): boolean => value.effective === "active" && value.expiryPending !== true;
const tsunamiForecasts = (records: readonly TsunamiForecastSubject[]) => records.filter((item) => item.effective === "active").map((item) => shown(item));
const tsunamiObservations = (records: readonly TsunamiObservationSubject[]) => records.filter(onScreen).map((item) => shown(item));
const reportMs = (source: WireReportRef): number => Date.parse(source.reportDateTimeRaw);
function newestOf(event: EarthquakeEvent, order: readonly EarthquakeFamily[], has: (item: EarthquakeContribution) => boolean): EarthquakeContribution | null {
  let best: EarthquakeContribution | null = null;
  for (const item of event.contributions) {
    if (item.effective !== "active" || !order.includes(item.family) || !has(item)) continue;
    if (best == null) { best = item; continue; }
    const time = reportMs(item.source) - reportMs(best.source);
    if (time > 0 || time === 0 && order.indexOf(item.family) < order.indexOf(best.family)) best = item;
  }
  return best;
}
const VIEW_LEVELS: ReadonlySet<SeismicIntensityItem["level"]> = new Set(["pref", "area", "city"]);
// seismic-unit の factsOf と eventView を合わせた形（欄の順も同じ）。
function quakeView(event: EarthquakeEvent): EarthquakeEventView {
  const hypocenter = newestOf(event, ["VXSE61", "VXSE53", "VXSE52"], (item) => item.hypocenter != null)?.hypocenter ?? null;
  const facts = newestOf(event, ["VXSE53", "VXSE51"], (item) => item.intensity != null)?.intensity ?? null;
  const comment = newestOf(event, ["VXSE53", "VXSE52"], () => true) ?? newestOf(event, ["VXSE51"], () => true);
  const tsunamiFamily = comment?.tsunamiComment == null ? null : comment.family === "VXSE61" ? null : comment.family;
  const originTimeRaw = newestOf(event, ["VXSE61", "VXSE53", "VXSE52"], (item) => item.hypocenter?.originTimeRaw != null)?.hypocenter?.originTimeRaw
    ?? newestOf(event, ["VXSE51"], (item) => item.targetDateTimeRaw != null)?.targetDateTimeRaw ?? null;
  const marks = event.contributions.flatMap((item) => item.effective === "active" && item.unreadable != null ? [{ family: item.family, ...markView(item.unreadable) }] : []);
  return { subject: `${event.operation}/earthquake/${event.eventId}`, eventId: event.eventId, operation: event.operation,
    sources: event.contributions.filter((item) => item.effective === "active").map((item) => item.source), originTimeRaw, hypocenter,
    intensity: facts == null ? null : { ...facts, items: facts.items.filter((item) => VIEW_LEVELS.has(item.level)) },
    tsunamiComment: tsunamiFamily == null ? null : comment?.tsunamiComment ?? null, tsunamiCommentFamily: tsunamiFamily, strongHold: event.strongHold,
    ...event.unavailable == null ? {} : { unavailable: event.unavailable }, ...event.cancelledSummary == null ? {} : { cancelledSummary: event.cancelledSummary },
    ...marks.length === 0 ? {} : { unreadableView: marks } };
}
// U-Q の view に載る event（active の寄与を持ち保留の印が無いか、取り消した地震の一覧の印を持つ）。
// U-Q の view に載る長周期（active で保留の印が無い記録に印の写しを当てたもの、toSeismicView と同じ）。
const longViews = (records: readonly LongPeriodSubject[]) => records.filter((item) => item.effective === "active" && item.expiryPending !== true).map((item) => shown(item));
const quakeViews = (events: readonly EarthquakeEvent[]) => events.filter((event) => event.contributions.some((item) => item.effective === "active")
  && event.expiryPending !== true || event.cancelledSummary != null).map(quakeView);

// 1 ページの件数は U-W と同じ（行 256・索引 32）。HTTP の本文（streamId は最大の 64 字）を wrapper 込みで加算し、入らない項目は pageBudget で省く（P3-UWC-AC06 (3)）。
const WIRE_ITEM_PAGE = 256, WIRE_INDEX_PAGE = 32, WIRE_RESPONSE_BYTES = 65_536, WIRE_STREAM_ID = "x".repeat(64);
const wireSha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const WIRE_UNITS: ReadonlySet<string> = new Set(["U-E", "U-T", "U-Q", "U-N", "U-V", "U-M", "U-L", "U-R", "U-B", "U-Y"]);
// 新しい part の要求（index・areas・stations・comment・event・raw・item・unreadable）。U-W・U-V・U-N の配送済みの要求はここに入らない（part が index か raw でない
// U-V・U-N は本文の口）。item・unreadable は U-W・U-F も新しい part で、U-W の口（index・areas・lastKnown）と part の名が重ならない（P4-DV-AC12 (1)）。
function isWireDetail(request: WeatherTimeseriesDetailRequest | WeatherCurrentDetailRequest | BulletinTextRequest | WireDetailRequest): request is WireDetailRequest {
  return "unit" in request && request.part !== "text" && (request.part === "raw" || request.part === "item" || request.part === "unreadable" || request.part === "losses"
    || request.unit !== "U-W" && WIRE_UNITS.has(request.unit));
}
const wireChanged = (revision: string | null): WireDetailResponse => ({ kind: "error", reason: "versionChanged", revision });
const wireInvalid: WireDetailResponse = { kind: "error", reason: "invalidRequest", revision: null };
const wireUnavailable: WireDetailResponse = { kind: "error", reason: "unavailable", revision: null };
// 項目の境界で切り、置いた項目と残りを全部省略にしたときの和が上限以下の項目だけを置く。null は page が範囲外。
// 索引（plain）は項目をそのまま entries に並べ（U-W の索引と同じ欄の名）、ほかは { index, item } で items に並べる。
function wirePage<Item>(page: number, size: number, all: readonly Item[], wrapper: (pageCount: number) => object, plain = false):
  Readonly<{ pageCount: number; itemCount: number; items: readonly Readonly<{ index: number; item: Item }>[]; omitted: readonly WireOmitted[] }> | null {
  const pageCount = Math.max(1, Math.ceil(all.length / size));
  if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) return null;
  const start = page * size, end = Math.min(all.length, start + size);
  const base = Buffer.byteLength(JSON.stringify({ streamId: WIRE_STREAM_ID, ...wrapper(pageCount),
    ...plain ? { entryCount: all.length, entries: [] } : { itemCount: all.length, items: [] }, omitted: [] }));
  const omittedBytes = (index: number) => Buffer.byteLength(JSON.stringify({ index, reason: "pageBudget" }));
  const rest = new Array<number>(end - start + 1).fill(0);
  for (let index = end - 1; index >= start; index--) rest[index - start] = rest[index - start + 1] + omittedBytes(index);
  const items: { index: number; item: Item }[] = [], omitted: WireOmitted[] = [];
  const commas = (count: number) => Math.max(count - 1, 0);
  let itemBytes = 0, omittedSoFar = 0;
  for (let index = start; index < end; index++) {
    const entry = { index, item: all[index] }, size = Buffer.byteLength(JSON.stringify(plain ? entry.item : entry)), later = end - index - 1;
    if (base + itemBytes + size + commas(items.length + 1) + omittedSoFar + rest[index - start + 1] + commas(omitted.length + later) <= WIRE_RESPONSE_BYTES) {
      items.push(entry); itemBytes += size;
    } else { omitted.push({ index, reason: "pageBudget" }); omittedSoFar += omittedBytes(index); }
  }
  return { pageCount, itemCount: all.length, items, omitted };
}
type Located<T> = Readonly<{ object: T; revision: string }> | null;
// id＝sha256([unit, operation, subject])、rev＝その part が返す view の object の JSON の sha256（表 §2.1）。要求ごとに同じ式で作り直して照合する。
function locate<T extends Readonly<{ operation: string; subject: string }>>(unit: RuntimeUnitId, items: readonly T[], id: string): Located<T> {
  const object = items.find((item) => wireSha([unit, item.operation, item.subject]) === id);
  return object == null ? null : { object, revision: wireSha(object) };
}
const entryOf = (unit: RuntimeUnitId, item: Readonly<{ operation: Operation; subject: string }>) => ({ id: wireSha([unit, item.operation, item.subject]), revision: wireSha(item), operation: item.operation });
function wireIndex(state: OwnerState, unit: "U-T" | "U-Q"): Readonly<{ revision: string; entries: readonly WireIndexEntry[] }> | null {
  const units: Readonly<Partial<WireUnitStates>> = state.units;
  switch (unit) {
    case "U-T": { const value = units["U-T"]; if (value == null) return null; const view = { forecasts: tsunamiForecasts(value.forecasts), observations: tsunamiObservations(value.observations) };
      return { revision: String(value.contentRevision), entries: [...view.forecasts.flatMap((item): WireIndexEntry[] => [{ ...entryOf(unit, item), part: "areas" },
        ...item.warningComment == null ? [] : [{ ...entryOf(unit, item), part: "comment" as const }]]), ...view.observations.map((item): WireIndexEntry => ({ ...entryOf(unit, item), part: "stations" }))] }; }
    case "U-Q": { const value = units["U-Q"]; if (value == null) return null;
      return { revision: String(value.contentRevision), entries: [...quakeViews(value.earthquakes), ...longViews(value.longPeriods)].map((item): WireIndexEntry => ({ ...entryOf(unit, item), part: "event" })) }; }
  }
}

// ---- 9 分野の view の要素の写し（P4-DV-AC05・AC12） ----
// 各 unit の toView と同じく「active で保留の印が無い」記録に印の写しを当てたもの（U-R は比べの欄を外す、U-B は released も載る、解説・情報は本文を外す）。
// rev は view の object の JSON の sha256 なので、形と鍵の順が toView と同じであることを P4-DV-T04 が corpus の全部で照らす。record は原文つきの印を持つ記録。
type WireMarked = Readonly<{ unreadable?: WireUnreadableMark; marineUnreadable?: WireUnreadableMark }>;
type WireElement = Readonly<{ source: Parameters<typeof vocabItem>[0]; id: string; revision: string; operation: Operation; record: WireMarked }>;
const nankaiHeading = (value: Extract<NankaiInformation, Readonly<{ effective: "active" }>>) => { const { text: _text, nextAdvisory: _next, ...heading } = value; return shown(heading); };
const volcanoHeading = (value: Extract<VolcanoBulletin, Readonly<{ effective: "active" }>>) => { const { text: _text, nextAdvisory: _next, ...heading } = value; return shown(heading); };
function wireElements(state: OwnerState, unit: VocabUnit): readonly WireElement[] | null {
  const units: Readonly<Partial<WireUnitStates>> = state.units;
  const of = (source: Parameters<typeof vocabItem>[0], record: WireMarked, operation: Operation, subject: string): WireElement =>
    ({ source, record, operation, id: wireSha([unit, operation, subject]), revision: wireSha(source.value) });
  switch (unit) {
    // U-W・U-F は公開形の id と revision（P3-UW-CANON-001・P3-UF-PUBLIC-001）。U-W の公開形は読めない印を持たない。
    case "U-W": { const value = units["U-W"]; if (value == null) return null;
      return weatherCurrentAreas(value).map((area) => ({ source: { k: "weatherCurrent.area", value: area }, record: {}, operation: area.operation, id: area.id, revision: area.revision })); }
    case "U-F": { const value = units["U-F"]; if (value == null) return null;
      return value.subjects.map((subject) => { const view = timeseriesPublicSubject(subject);
        return { source: { k: "weatherTimeseries.subject", value: view }, record: view.unreadableView == null ? {} : subject, operation: view.operation, id: view.id, revision: view.revision }; }); }
    case "U-N": { const value = units["U-N"]; if (value == null) return null;
      return [...value.currents.flatMap((item) => item.effective === "active" && item.expiryPending !== true ? [of({ k: "nankai.current", value: shown(item) }, item, item.operation, item.subject)] : []),
        ...value.information.flatMap((item) => item.effective === "active" && item.expiryPending !== true
          ? [of({ k: "nankai.information", value: nankaiHeading(item) }, item, item.operation, item.subject)] : [])]; }
    case "U-V": { const value = units["U-V"]; if (value == null) return null;
      return [...value.alerts.flatMap((item) => item.effective === "active" ? [of({ k: "volcano.alert", value: shown(item) }, item, item.operation, item.subject)] : []),
        ...value.eruptions.flatMap((item) => item.effective === "active" && item.expiryPending !== true ? [of({ k: "volcano.eruption", value: shown(item) }, item, item.operation, item.subject)] : []),
        ...value.ashfalls.flatMap((item) => item.effective === "active" && item.expiryPending !== true ? [of({ k: "volcano.ashfall", value: shown(item) }, item, item.operation, item.subject)] : []),
        ...value.bulletins.flatMap((item) => item.effective === "active" && item.expiryPending !== true
          ? [of({ k: "volcano.bulletin", value: volcanoHeading(item) }, item, item.operation, item.subject)] : []),
        // 不足の subject は unit が使う形（volcano-unit.ts の resolveShortfall、P4-DV-AC02）。
        ...value.shortfalls.map((item) => of({ k: "volcano.shortfall", value: item }, {}, item.operation, `${item.operation}/shortfall/${item.id}`))]; }
    case "U-L": { const value = units["U-L"]; if (value == null) return null;
      return value.currents.flatMap((item) => item.effective === "active" && item.expiryPending !== true ? [of({ k: "landslide.office", value: shown(item) }, item, item.operation, item.subject)] : []); }
    case "U-R": { const value = units["U-R"]; if (value == null) return null;
      return value.currents.flatMap((item) => {
        if (item.effective !== "active" || item.expiryPending === true) return [];
        if (item.observedCompare == null) return [of({ k: "flood.event", value: shown(item) }, item, item.operation, item.subject)];
        const { observedCompare: _compare, ...rest } = item;
        return [of({ k: "flood.event", value: shown(rest) }, item, item.operation, item.subject)];
      }); }
    case "U-B": { const value = units["U-B"]; if (value == null) return null;
      return value.currents.flatMap((item) => (item.effective === "active" || item.effective === "released") && item.expiryPending !== true
        ? [of({ k: "briefing.current", value: shown(item) }, item, item.operation, item.subject)] : []); }
    case "U-M": { const value = units["U-M"]; if (value == null) return null;
      return [...value.tornado.flatMap((item) => item.effective === "active" && item.expiryPending !== true ? [of({ k: "localBulletins.tornado", value: shown(item) }, item, item.operation, item.subject)] : []),
        ...value.heat.flatMap((item) => item.effective === "active" && item.expiryPending !== true ? [of({ k: "localBulletins.heat", value: shown(item) }, item, item.operation, item.subject)] : []),
        ...value.transient.flatMap((item) => item.effective === "active" && item.expiryPending !== true
          ? [of({ k: "localBulletins.transient", value: shown(item) }, item, item.operation, item.subject)] : [])]; }
    case "U-Y": { const value = units["U-Y"]; if (value == null) return null;
      return [...value.analysis.flatMap((item) => item.effective === "active" && item.expiryPending !== true ? [of({ k: "typhoon.analysis", value: shown(item) }, item, item.operation, item.subject)] : []),
        ...value.probability.flatMap((item) => item.effective === "active" && item.expiryPending !== true
          ? [of({ k: "typhoon.probability", value: shown(item) }, item, item.operation, item.subject)] : [])]; }
  }
}
// 詳細の項目は切らない（P4-DV-D-UNBOUNDED-TEXT=A）。索引に出るのは 15 種（U-W・U-F は既存の索引の口）。
const detailItem = (element: WireElement): VocabItem => vocabItem(element.source, { id: element.id, rev: element.revision }, true);
const indexItem = (item: VocabItem): VocabIndexItem | null => item.k === "weatherCurrent.area" || item.k === "weatherTimeseries.subject" ? null : item;
const indexEntry = (element: WireElement): WireIndexEntry | null => {
  const item = indexItem(detailItem(element));
  return item == null ? null : { id: element.id, revision: element.revision, operation: element.operation, part: "item", item };
};
// 索引のページの境（P4-DV-D-INDEX-PAGING=A）: 32 件まで、65,536 に入らない項目は次のページの先頭へ繰り越し、1 件だけで入らない項目は印だけのページにする。
// 境は前のページの byte に依るので、unit の state の版（object）ごとに 1 度だけ全部の項目を変換して数えて持つ（保存しない、版が変われば捨てる）。
type WirePaging = Readonly<{ revision: string; elements: readonly WireElement[]; pages: readonly Readonly<{ start: number; end: number; oversize: boolean }>[] }>;
const pagingCache = new WeakMap<object, WirePaging>();
function vocabPaging(state: OwnerState, unit: VocabIndexUnit): WirePaging | null {
  const version = state.units[unit];
  if (version == null) return null;
  const found = pagingCache.get(version);
  if (found != null) return found;
  const elements = wireElements(state, unit) ?? [], revision = String(version.contentRevision), most = Math.max(1, elements.length);
  // 番号の欄は最大の桁で数える（pageCount と page は項目の数を越えない）。
  const base = Buffer.byteLength(JSON.stringify({ streamId: WIRE_STREAM_ID, kind: "ok", part: "index", revision, page: most, pageCount: most, entryCount: most, entries: [], omitted: [] }));
  const sizes = elements.map((element) => Buffer.byteLength(JSON.stringify(indexEntry(element))));
  const pages: { start: number; end: number; oversize: boolean }[] = [];
  for (let start = 0; start < elements.length;) {
    let used = base, end = start;
    while (end < elements.length && end - start < WIRE_INDEX_PAGE && used + sizes[end] + (end > start ? 1 : 0) <= WIRE_RESPONSE_BYTES) used += sizes[end] + (end > start ? 1 : 0), end++;
    if (end === start) { pages.push({ start, end: start + 1, oversize: true }); start++; } else { pages.push({ start, end, oversize: false }); start = end; }
  }
  if (pages.length === 0) pages.push({ start: 0, end: 0, oversize: false });
  const result: WirePaging = { revision, elements, pages };
  pagingCache.set(version, result);
  return result;
}
function vocabIndex(state: OwnerState, request: Extract<WireDetailRequest, { part: "index" }> & Readonly<{ unit: VocabIndexUnit }>): WireDetailResponse {
  const paging = vocabPaging(state, request.unit);
  if (paging == null) return wireUnavailable;
  if (request.revision !== paging.revision) return wireChanged(paging.revision);
  const page = Number.isSafeInteger(request.page) && request.page >= 0 ? paging.pages[request.page] : undefined;
  if (page == null) return wireInvalid;
  // 要求ごとに変換するのはこのページの項目だけ（統合担当の決め 8）。
  const chosen = paging.elements.slice(page.start, page.end);
  const omitted: WireIndexOmitted[] = page.oversize ? chosen.map((element, offset) => ({ index: page.start + offset, reason: "pageBudget", id: element.id, revision: element.revision })) : [];
  const entries = page.oversize ? [] : chosen.flatMap((element) => { const entry = indexEntry(element); return entry == null ? [] : [entry]; });
  return { kind: "ok", part: "index", revision: paging.revision, page: request.page, pageCount: paging.pages.length, entryCount: paging.elements.length, entries, omitted };
}
// part=item・unreadable（P4-DV-AC12）。読むだけで state も期限も動かさない。消えた対象は revision: null、版の違いは今の revision を返す。
function vocabDetail(state: OwnerState, request: Extract<WireDetailRequest, { part: "item" | "unreadable" }>): WireDetailResponse {
  // 7 分野は版ごとに 1 度だけ作った写し（vocabPaging）を使い、要求ごとに全部の記録を写して hash しない。U-W・U-F は公開形の id と revision を読むだけ。
  const elements = request.unit === "U-W" || request.unit === "U-F" ? wireElements(state, request.unit) : vocabPaging(state, request.unit)?.elements ?? null;
  if (elements == null) return wireUnavailable;
  const element = elements.find((item) => item.id === request.id);
  if (element == null) return wireChanged(null);
  if (element.revision !== request.revision) return wireChanged(element.revision);
  if (request.part === "item") return { kind: "ok", part: "item", id: element.id, revision: element.revision, item: detailItem(element) };
  // 欠片は (site, scope) ごとに 1 件（unreadable.ts の印）。U-F の付加事項（site addition）も parts に入る。U-V の警報だけ海上の印を marine で持つ。
  const side = (name: WireUnreadableSide["side"], mark: WireUnreadableMark | undefined): WireUnreadableSide[] => mark == null ? []
    : [{ side: name, parts: mark.parts.map((part) => ({ site: part.site, scope: part.scope ?? null, raw: part.raw })), headline: mark.headline }];
  return { kind: "ok", part: "unreadable", id: element.id, revision: element.revision,
    sides: [...side("land", element.record.unreadable), ...side("marine", element.record.marineUnreadable)] };
}
// 新しい part の 1 ページ。読むだけで、state も期限も動かさない（U-W の口と同じ）。
function wireDetail(state: OwnerState, request: WireDetailRequest): WireDetailResponse {
  const units: Readonly<Partial<WireUnitStates>> = state.units;
  if (request.part === "raw") {
    const card = (state.unreadable[request.unit] ?? EMPTY).find((item) => item.inputId === request.id);
    if (card == null) return wireChanged(null);
    if (String(card.receivedAt) !== request.revision) return wireChanged(String(card.receivedAt));
    return { kind: "ok", part: "raw", id: request.id, revision: request.revision, raw: card.raw, rawCut: card.rawCut, rawDropped: card.rawDropped === true };
  }
  if (request.part === "item" || request.part === "unreadable") return vocabDetail(state, request); if (request.part === "losses") return lossDetail(state, request); // P4-RL-AC08 (7)
  if (request.part === "index") {
    if (request.unit !== "U-T" && request.unit !== "U-Q") return vocabIndex(state, { ...request, unit: request.unit });
    const index = wireIndex(state, request.unit);
    if (index == null) return wireUnavailable;
    if (request.revision !== index.revision) return wireChanged(index.revision);
    const paged = wirePage(request.page, WIRE_INDEX_PAGE, index.entries, (pageCount) => ({ kind: "ok", part: "index", revision: index.revision, page: request.page, pageCount }), true);
    return paged == null ? wireInvalid : { kind: "ok", part: "index", revision: index.revision, page: request.page, pageCount: paged.pageCount,
      entryCount: paged.itemCount, entries: paged.items.map(({ item }) => item), omitted: paged.omitted };
  }
  if (request.unit === "U-E") {
    const value = units["U-E"]; if (value == null) return wireUnavailable;
    const found = locate("U-E", value.current, request.id);
    if (found == null || found.revision !== request.revision) return wireChanged(found?.revision ?? null);
    const rows: readonly EewAreaDetail[] = found.object.prediction.areas.map((area, index) => ({ code: area.code, intensity: area.intensity, report: found.object.reportAreas[index] ?? null }));
    const paged = wirePage(request.page, WIRE_ITEM_PAGE, rows, (pageCount) => ({ kind: "ok", part: "areas", id: request.id, revision: found.revision, page: request.page, pageCount }));
    return paged == null ? wireInvalid : { kind: "ok", part: "areas", id: request.id, revision: found.revision, page: request.page, ...paged };
  }
  if (request.unit === "U-T") {
    const value = units["U-T"]; if (value == null) return wireUnavailable;
    const view = { forecasts: tsunamiForecasts(value.forecasts), observations: tsunamiObservations(value.observations) };
    if (request.part === "stations") {
      const found = locate("U-T", view.observations, request.id);
      if (found == null || found.revision !== request.revision) return wireChanged(found?.revision ?? null);
      const paged = wirePage(request.page, WIRE_ITEM_PAGE, found.object.stations, (pageCount) => ({ kind: "ok", part: "stations", id: request.id, revision: found.revision, page: request.page, pageCount }));
      return paged == null ? wireInvalid : { kind: "ok", part: "stations", id: request.id, revision: found.revision, page: request.page, ...paged };
    }
    const found = locate("U-T", view.forecasts, request.id);
    if (found == null || found.revision !== request.revision) return wireChanged(found?.revision ?? null);
    // 付加文は unit が持つ 4,096 字の全部（P4-DW-D-TSUNAMI-COMMENT=A）。escape の最悪 24,576 byte でも 1 応答に入る。
    if (request.part === "comment") return found.object.warningComment == null ? wireChanged(null)
      : { kind: "ok", part: "comment", id: request.id, revision: found.revision, text: found.object.warningComment };
    const rows = [...found.object.areas, ...found.object.unkeyedAreas];
    const paged = wirePage(request.page, WIRE_ITEM_PAGE, rows, (pageCount) => ({ kind: "ok", part: "areas", id: request.id, revision: found.revision, page: request.page, pageCount }));
    return paged == null ? wireInvalid : { kind: "ok", part: "areas", id: request.id, revision: found.revision, page: request.page, ...paged };
  }
  const value = units["U-Q"]; if (value == null) return wireUnavailable;
  // 長周期の見出しの ref もこの part で開ける（見出しは地震と同じ U-Q の event の形）。
  const found = locate<EarthquakeEventView | WireMarkViewed<LongPeriodSubject>>("U-Q", [...quakeViews(value.earthquakes), ...longViews(value.longPeriods)], request.id);
  if (found == null || found.revision !== request.revision) return wireChanged(found?.revision ?? null);
  // 見出し（震度の要素を除く）を各ページに載せ、震度の要素をページに切る。見出しも 1 応答の予算に入れ、入らないときは大きい欄から値を外して
  // omittedFields に名を挙げる（黙って切らない）。既知でない区域もここで読む（表 §1.1）。
  const { intensity, ...rest } = found.object;
  const items = intensity?.items ?? [], pageCount = Math.max(1, Math.ceil(items.length / WIRE_ITEM_PAGE));
  let event: WireEventHeader | WireLongPeriodHeader = { ...rest, intensity: intensity == null ? null : { maxInt: intensity.maxInt, maxLgInt: intensity.maxLgInt, lgCategory: intensity.lgCategory } };
  const omittedFields: WireOmittedField[] = [];
  // 不変条件: 見出しは、本文に出うるもの（最長の streamId・omittedFields の最大・このページの全項目ぶんの省略の行）を先に引いて入る大きさにする。
  // 項目は wirePage がその差額だけで置くので、本文の全体が 65,536 byte を越えない（U-W の加算と同じ形、P3-UWC-AC06 (3)）。
  const start = Number.isSafeInteger(request.page) && request.page >= 0 ? request.page * WIRE_ITEM_PAGE : 0, end = Math.min(items.length, start + WIRE_ITEM_PAGE);
  const omittedLines = Array.from({ length: Math.max(0, end - start) }, (_, index): WireOmitted => ({ index: start + index, reason: "pageBudget" }));
  const headerBytes = () => Buffer.byteLength(JSON.stringify({ streamId: WIRE_STREAM_ID, kind: "ok", part: "event", id: request.id, revision: found.revision, page: request.page,
    pageCount, itemCount: items.length, items: [], omitted: omittedLines, event, omittedFields: WIRE_OMITTABLE }));
  for (const field of WIRE_OMITTABLE) {
    if (headerBytes() <= WIRE_RESPONSE_BYTES) break;
    const shrunk = omitField(event, field);
    if (shrunk !== event) { event = shrunk; omittedFields.push(field); }
  }
  const header = event;
  const paged = wirePage(request.page, WIRE_ITEM_PAGE, items, (count) => ({ kind: "ok", part: "event", id: request.id, revision: found.revision, page: request.page, pageCount: count, event: header, omittedFields }));
  return paged == null ? wireInvalid : { kind: "ok", part: "event", id: request.id, revision: found.revision, page: request.page, ...paged, event: header, omittedFields };
}
// 見出しの欄を大きくなりうる順に外す（null・空・欄ごと消す）。外せる欄が無ければ同じ object を返す。
const WIRE_OMITTABLE: readonly WireOmittedField[] = ["hypocenter", "headline", "title", "tsunamiComment", "sources", "unreadableView", "unavailable", "cancelledSummary", "strongHold"];
function omitField(event: WireEventHeader | WireLongPeriodHeader, field: WireOmittedField): WireEventHeader | WireLongPeriodHeader {
  if ("sources" in event) {
    const { unreadableView: _view, unavailable: _unavailable, cancelledSummary: _summary, ...bare } = event;
    switch (field) {
      case "hypocenter": return event.hypocenter == null ? event : { ...event, hypocenter: null };
      case "tsunamiComment": return event.tsunamiComment == null ? event : { ...event, tsunamiComment: null };
      case "sources": return event.sources.length === 0 ? event : { ...event, sources: [] };
      case "strongHold": return event.strongHold == null ? event : { ...event, strongHold: null };
      case "unreadableView": return event.unreadableView == null ? event : { ...bare, ...event.unavailable == null ? {} : { unavailable: event.unavailable }, ...event.cancelledSummary == null ? {} : { cancelledSummary: event.cancelledSummary } };
      case "unavailable": return event.unavailable == null ? event : { ...bare, ...event.unreadableView == null ? {} : { unreadableView: event.unreadableView }, ...event.cancelledSummary == null ? {} : { cancelledSummary: event.cancelledSummary } };
      case "cancelledSummary": return event.cancelledSummary == null ? event : { ...bare, ...event.unreadableView == null ? {} : { unreadableView: event.unreadableView }, ...event.unavailable == null ? {} : { unavailable: event.unavailable } };
      default: return event;
    }
  }
  const { unreadableView: _view, unavailable: _unavailable, ...bare } = event;
  switch (field) {
    case "hypocenter": return event.hypocenter == null ? event : { ...event, hypocenter: null };
    case "headline": return event.headline == null ? event : { ...event, headline: null };
    case "title": return event.title === "" ? event : { ...event, title: "" };
    case "unreadableView": return event.unreadableView == null ? event : { ...bare, ...event.unavailable == null ? {} : { unavailable: event.unavailable } };
    case "unavailable": return event.unavailable == null ? event : { ...bare, ...event.unreadableView == null ? {} : { unreadableView: event.unreadableView } };
    default: return event;
  }
}

// ---- P4-REMOVAL-LOSS-001: 取り直しの候補の消えた理由（P4-RL-AC03 (1)〜(4)） ----
// 候補の各 step の差分から、基点にあった表示のキー（unit・operation・subject）の removal を持つ。値 null は候補の中でできたキーで、ある間だけ持ち消えたら外す
// （正味の消失にならない）。基点のキーは消えた時に持ち、戻ったら外す。大きさは基点の記録の数と今ある候補のキーの数で抑えられ、入力の数では伸びない。
const removalKey = (change: RuntimeDisplayChange): string => JSON.stringify([change.unit, change.operation, change.subject]); // unit も入れる（owner-host の復元版は同じ place の別の unit と取り違えない）
function noteRemovals(removals: Map<string, DisplayRemoval | null>, changes: readonly RuntimeDisplayChange[]): void {
  for (const change of changes) {
    const key = removalKey(change);
    if (change.after == null) { if (removals.get(key) === null) removals.delete(key); else removals.set(key, change.removal); }
    else if (change.before == null) { if (removals.has(key)) removals.delete(key); else removals.set(key, null); }
  }
}
// P4-RL-AC08 (7): H39 の理由の行（unit ごとに最大 9 行）。読むだけで state も期限も動かさない。rev は publisher の H39 の欄と同じく行の JSON の sha256（行が無ければ []）。
function lossDetail(state: OwnerState, request: Extract<WireDetailRequest, { part: "losses" }>): WireDetailResponse {
  if (state.units[request.unit] == null) return wireUnavailable;
  const rows = state.losses[request.unit] ?? EMPTY, revision = wireSha(rows);
  return revision === request.revision ? { kind: "ok", part: "losses", unit: request.unit, revision, rows } : wireChanged(revision);
}
