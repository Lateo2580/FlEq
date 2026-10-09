// P2-CHROME-EEW-001: DOM・EventSource・performance に依存しない部分だけをここへ置く。
// vitest (node環境) はこのファイルを import するので、DOM型を参照しない。

import type { MaterialValue, Operation } from "../../../contracts/p1-parser-boundary.types";
import type {
  DisplayChannelView, DisplayConfirmationView, DisplayConnectionView, DisplaySeverity, DisplaySnapshot,
  DisplaySummaryItem, DisplayWorkerView, VisibleNotice,
} from "../../../contracts/p2-snapshot-sse.types";
import type { EewCurrent, EewPredictionIntensity } from "../../../contracts/p2-eew-unit.types";
import type { TsunamiAreaClass, TsunamiForecastArea, TsunamiForecastSubject } from "../../../contracts/p3-tsunami-unit.types";
import type { ChromeTsunamiMarkerDetail } from "../../../contracts/p3-tsunami-e01.types";
import { COAST_RECT_BY_CODE, type CoastRect } from "./coast.js";
import { GEOMETRY_RECT_BY_CODE, type GeometryRect } from "./geometry.js";

// AC01: streamId/sequenceだけで完全snapshot置換を決める。旧版・差分は保持しない。
function replaceDisplaySnapshot(current: DisplaySnapshot | null, incoming: DisplaySnapshot): DisplaySnapshot {
  if (current == null) return incoming;
  if (incoming.streamId !== current.streamId) return incoming;
  return incoming.sequence > current.sequence ? incoming : current;
}

// AC04: metadataだけのsnapshotでcard/mapを作り直さない。EEWの内容版はA4/A8のcontentRevisionが正本
// (A8もfull view本体をcontentRevisionで同一視する)。受信経路で本体を直列化・走査しない。
function eewContentChanged(before: DisplaySnapshot, after: DisplaySnapshot): boolean {
  const a = before.current.eew, b = after.current.eew;
  return before.streamId !== after.streamId || a.delivery !== b.delivery || a.contentRevision !== b.contentRevision;
}

// P3-C6-AC03(6): 津波も U-T の contentRevision だけで描き直しを決める（EEW の更新で津波を描き直さない、その逆も同じ）。
function tsunamiContentChanged(before: DisplaySnapshot, after: DisplaySnapshot): boolean {
  const a = before.current.tsunami, b = after.current.tsunami;
  return before.streamId !== after.streamId || a.delivery !== b.delivery || a.contentRevision !== b.contentRevision;
}

// AC10: epoch ms + 32400000 を固定計算しUTC getterで読む。Intl・端末TZに依存しない。
function formatJst(epochMs: number | null): string {
  if (epochMs == null || !Number.isFinite(epochMs)) return "時刻不明";
  const d = new Date(epochMs + 32_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// ReportRef.reportDateTimeRaw (A1検証済みoffset付き日時) をepoch msへ。offset付きなので端末TZに依存しない。
function parseReportDateTime(raw: string): number | null {
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

// 震度の生表記と表示。並び順が段階 (rank = 添字+1)。
const INTENSITY_SCALE = [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["5-", "5弱"], ["5+", "5強"], ["6-", "6弱"],
  ["6+", "6強"], ["7", "7"]] as const;

type IntensityToken = Readonly<{ display: string; rank: number | null }>;

// AC03: 未知値・区域なしを既知震度へ補完しない。"5-"等はkind=text、"4"等の純数値はkind=numberで来る。
// 表にない値 (range・unknownを含む) は生表記のまま出し、段階を付けない。
function intensityToken(value: MaterialValue): IntensityToken {
  if (value.kind === "missing") return { display: "不明", rank: null };
  if (value.kind === "empty") return { display: "空", rank: null };
  if (value.kind === "text" || value.kind === "number") {
    const index = INTENSITY_SCALE.findIndex(([raw]) => raw === String(value.value));
    if (index >= 0) return { display: INTENSITY_SCALE[index][1], rank: index + 1 };
  }
  return { display: value.raw, rank: null };
}

type IntensityView = Readonly<{ display: string; severityClass: string }>;

// severityRule: 区間は表示にFrom/To両端を残し、色は上端(To)を用いる (592=3〜4/色4)。
// Toが無い (missing) ときだけFromで色を決める。To=overはdomain (src/domains/eew/eew.ts:462-466) と同じく
// Fromが既知のときだけ「{From}程度以上」・色はFrom。それ以外で段階の無いTo (不明など) は未知の色。
// AC03: condition/descriptionは落とさず表示に添える。
function intensityView(intensity: EewPredictionIntensity): IntensityView {
  const from = intensityToken(intensity.from), to = intensityToken(intensity.to);
  const over = from.rank != null && intensity.to.kind !== "missing"
    && intensity.to.raw.normalize("NFKC").trim().toLowerCase() === "over";
  const range = over ? `${from.display}程度以上`
    : intensity.to.kind === "missing" || from.display === to.display ? from.display : `${from.display}〜${to.display}`;
  const qualifiers = [intensity.condition, intensity.description].filter((text): text is string => text != null);
  return {
    display: qualifiers.length === 0 ? range : `${range}（${qualifiers.join("／")}）`,
    severityClass: severityClass(over || intensity.to.kind === "missing" ? from.rank : to.rank),
  };
}

// AC08: severity rankは固定表でCSSクラス名へ写す。wire文字列をクラス名に混ぜない。
function severityClass(rank: number | null): string {
  return rank != null && rank >= 1 && rank <= 9 ? `int-${rank}` : "int-unknown";
}

type EewCardArea = Readonly<{ code: string; display: string; severityClass: string; rect: GeometryRect | null }>;
type EewCardView = Readonly<{
  head: string;
  maximumSeverityClass: string;
  reportTimeDisplay: string;
  areas: readonly EewCardArea[];
}>;

const OPERATION_LABEL: Readonly<Record<Operation, string>> = { normal: "通常", training: "訓練", test: "試験" };

// AC02/AC03/AC04: 取得元はA8が運ぶA4 EewCurrent.prediction/sourceに統一 (retainedPredictionは読まない)。
// geometryは9区域のrect lookupだけに使い、無いcodeは塗らない。
function buildEewCard(current: EewCurrent): EewCardView {
  const max = intensityView(current.prediction.maximum);
  return {
    head: `[${OPERATION_LABEL[current.operation]}] ${current.family} ${current.eventId} 最大${max.display}`,
    maximumSeverityClass: max.severityClass,
    reportTimeDisplay: formatJst(parseReportDateTime(current.source.reportDateTimeRaw)),
    areas: current.prediction.areas.map((area) => ({ code: area.code, ...intensityView(area.intensity),
      rect: GEOMETRY_RECT_BY_CODE.get(area.code) ?? null })),
  };
}

// R40: A8生成textをそのまま出す。kind→文言表を重複定義しない。
function buildNoticeLine(notice: VisibleNotice): string {
  const office = notice.source?.office == null ? ""
    : `　${notice.source.office}${notice.source.officeTruncated ? "（切詰め）" : ""}`;
  return `[${OPERATION_LABEL[notice.operation]}] ${notice.text}${office}`;
}

const CHANNEL_LABEL: Readonly<Record<DisplayChannelView, string>> = {
  checking: "確認中", available: "使える", unavailable: "使えない", isolated: "隔離中",
};
// R41: availableを可聴の保証と書かない。
function buildChannelLines(channels: DisplaySnapshot["channels"]): readonly string[] {
  return [`デスクトップ通知: ${CHANNEL_LABEL[channels.desktop]}`, `音声通知: ${CHANNEL_LABEL[channels.sound]}`];
}

const CONNECTION_LABEL: Readonly<Record<DisplayConnectionView["state"], string>> = {
  connected: "接続中", reconnecting: "再接続中", stopped: "停止",
};
const WORKER_LABEL: Readonly<Record<DisplayWorkerView["state"], string>> = {
  healthy: "正常", stalled: "停滞（停止系）", unresponsive: "無応答（停止系）", stopped: "停止（停止系）",
};
// R42: 接続/確認の1行。初回snapshot前はconnectionが無く、workerはheartbeatが運んだものだけを出す。
function buildConnectionLine(
  connection: DisplayConnectionView | null, worker: DisplayWorkerView["state"] | null, browserStale: boolean,
): string {
  const link = connection == null ? "接続: snapshot未受信"
    : `接続: ${CONNECTION_LABEL[connection.state]} / 切断: ${connection.disconnectedAt == null ? "未切断" : formatJst(connection.disconnectedAt)}`;
  const receipt = browserStale ? "無受信45秒以上（stale）" : "無受信45秒未満";
  return `${link} / worker: ${worker == null ? "未受信" : WORKER_LABEL[worker]} / 受信: ${receipt}`;
}

// stale中とworker停止系の間は、今の表示が更新未確認であると明示する。
function staleBanner(browserStale: boolean, worker: DisplayWorkerView["state"] | null): string {
  return browserStale || (worker != null && worker !== "healthy") ? "更新未確認の最終情報" : "";
}

const WORKER_STATES = ["healthy", "stalled", "unresponsive", "stopped"] as const;
// heartbeatの境界検証。壊れたJSON・4値以外のstateは採らない (呼び出し元はstaleも解かない)。
// 表示に使うのはworker.stateだけなので、stateだけを取り出す。
function parseHeartbeatWorker(data: string): DisplayWorkerView["state"] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return null; }
  if (parsed == null || typeof parsed !== "object" || !("worker" in parsed)) return null;
  const worker = parsed.worker;
  if (worker == null || typeof worker !== "object" || !("state" in worker)) return null;
  return WORKER_STATES.find((candidate) => candidate === worker.state) ?? null;
}

const CONFIRMATION_LABEL: Readonly<Record<DisplayConfirmationView["state"], string>> = {
  confirmed: "確認済み", partial: "一部確認", unconfirmed: "未確認",
};
function buildConfirmationLine(operation: Operation, confirmation: DisplayConfirmationView): string {
  const at = confirmation.confirmedAt == null ? "" : ` (${formatJst(confirmation.confirmedAt)})`;
  return `${OPERATION_LABEL[operation]}確認状態: ${CONFIRMATION_LABEL[confirmation.state]}${at}`;
}

// AC04: summary行はnormalと、有効件数のあるoperationだけ。
function summaryRowVisible(item: DisplaySummaryItem): boolean {
  return item.operation === "normal" || item.activeCount > 0;
}

// AC04: U-Eで表示できない報は容量超過だけで、A8はA1 P2-A1-ADMISSION-COUNTSをitems[].admissionへ写す
// (items[].unavailableはU-W/U-F専用でU-Eでは常に空)。normalの公開mask中でcardが消えても件数は残るので、
// 無発令と区別できるよう1件以上のoperationだけ固定文言の行を出す。
function buildCapacityExceededLine(item: DisplaySummaryItem): string | null {
  const count = item.admission.capacityExceeded ?? 0;
  return count > 0 ? `[${OPERATION_LABEL[item.operation]}] 表示できない報がある（容量超過 ${count} 件）` : null;
}

// AC09: normalは常に、training/testはそのoperationのcard・summary行・容量超過行・noticeを出している間だけ。
function operationVisible(snapshot: DisplaySnapshot, item: DisplaySummaryItem): boolean {
  if (item.operation === "normal") return true;
  const eew = snapshot.current.eew;
  const shownInEew = eew.delivery === "full"
    ? eew.view.current.some((current) => current.operation === item.operation)
    : summaryRowVisible(item);
  return shownInEew || buildCapacityExceededLine(item) != null
    || snapshot.notices.some((notice) => notice.operation === item.operation);
}

const SEVERITY_LABEL: Readonly<Record<DisplaySeverity, string>> = {
  none: "なし", below: "基準未満", forecast: "予報", advisory: "注意報", warning: "警報", danger: "危険",
  specialWarning: "特別警報",
};
// AC04 summary: activeCount・予報/警報区分・updatedAtと省略中。EventID/震度/区域を補完しない。
function buildSummaryLine(item: DisplaySummaryItem): string {
  const severity = item.highestSeverity == null ? "区分不明" : SEVERITY_LABEL[item.highestSeverity];
  return `[${OPERATION_LABEL[item.operation]}] ${item.activeCount}件 / ${severity} / 更新: ${formatJst(item.updatedAt)} / 詳細省略中`;
}

// ── P3-C6-AC03: 津波の大カード・警報区分・最小海岸線。塗りの規則は manifest の expectedPaint もこれで作る（P3-C6-SERIES-SOURCE=A）。──
type TsunamiPaintClass = "majorWarning" | "warning" | "unknown" | "advisory";
// 海岸線に塗る区分だけ。unknown は P3-C5-KIND-ENUM=B で警報と同じ順位・同じ色。
function tsunamiPaintClass(value: TsunamiAreaClass): TsunamiPaintClass | null {
  switch (value) {
    case "majorWarning": case "warning": case "unknown": case "advisory": return value;
    case "forecast": case "released": case "none": return null;
  }
}
// Q-ENUM の kindTable（domains/tsunami/tsunami.ts の KIND_CLASS と同じ表。ブラウザの module は domain を読めないので写す）。表外は unknown
// （P3-C5-KIND-ENUM=B、警報と同じ順位）。区域コードの無い区域の区分だけをこれで決める（区域コードのある区域は view の areaClass）。
const KIND_CLASS: Readonly<Record<string, TsunamiAreaClass>> = {
  "52": "majorWarning", "53": "majorWarning", "51": "warning", "62": "advisory", "71": "forecast", "72": "forecast", "73": "forecast",
  "50": "released", "60": "released", "00": "none",
};
const higherPaint = (a: TsunamiPaintClass | null, b: TsunamiPaintClass | null): TsunamiPaintClass | null =>
  b == null || (a != null && TSUNAMI_PAINT[a].rank >= TSUNAMI_PAINT[b].rank) ? a : b;
const kindClass = (kindCode: string): TsunamiAreaClass => (Object.hasOwn(KIND_CLASS, kindCode) ? KIND_CLASS[kindCode]! : "unknown");
// AC08: class 名は固定表の値だけ。点滅は majorWarning の海岸線だけ（spec:1598）。
const TSUNAMI_PAINT: Readonly<Record<TsunamiPaintClass, Readonly<{ rank: number; className: string; label: string }>>> = {
  majorWarning: { rank: 3, className: "tsu-major", label: "大津波警報" },
  warning: { rank: 2, className: "tsu-warning", label: "津波警報" },
  unknown: { rank: 2, className: "tsu-warning", label: "津波警報（区分コード表外）" },
  advisory: { rank: 1, className: "tsu-advisory", label: "津波注意報" },
};

export type TsunamiPaintedArea = Readonly<{ code: string; areaClass: TsunamiAreaClass }>;
type TsunamiCoastSegment = Readonly<{ code: string; rect: CoastRect; className: string; blink: boolean }>;
type TsunamiCardView = Readonly<{
  subject: string; head: string; className: string; reportTimeDisplay: string;
  areas: readonly Readonly<{ text: string; className: string }>[];
}>;
type TsunamiPaintView = Readonly<{
  cards: readonly TsunamiCardView[];
  segments: readonly TsunamiCoastSegment[];
  // 塗る区分の区域のうち資材に無い code の数（spec§8.10 の 7 と同じく「対象なし」にしない）。
  missingCoastCount: number;
  // T6 候補の areas（subject をまたいで code ごとに最高区分へまとめた後の、その subject の code の塗った結果、code 順）。
  areasBySubject: ReadonlyMap<string, readonly TsunamiPaintedArea[]>;
}>;

const heightText = (area: TsunamiForecastArea): string => {
  const parts: string[] = [];
  const max = area.maxHeight;
  if (max != null) {
    const raw = max.value.kind === "missing" ? null : max.value.raw;
    const extra = [max.condition, max.description].filter((text): text is string => text != null);
    if (raw != null || extra.length > 0) parts.push(`高さ ${[raw, ...extra].filter((text) => text != null).join(" ")}`);
  }
  const first = [area.firstHeight.arrivalTimeRaw, area.firstHeight.condition].filter((text): text is string => text != null);
  if (first.length > 0) parts.push(`到達予想 ${first.join(" ")}`);
  return parts.length === 0 ? "" : ` / ${parts.join(" / ")}`;
};

// U-T の full view の forecasts から描画指示を作る。資材は code→矩形の Map を引くだけ（AC12）。
function buildTsunamiPaint(forecasts: readonly TsunamiForecastSubject[]): TsunamiPaintView {
  const merged = new Map<string, TsunamiPaintClass>();
  const missing = new Set<string>();
  for (const subject of forecasts) for (const area of subject.areas) {
    const paint = tsunamiPaintClass(area.areaClass);
    if (paint == null) continue;
    if (!COAST_RECT_BY_CODE.has(area.code)) { missing.add(area.code); continue; }
    const before = merged.get(area.code);
    // 同順位（warning と unknown）は先に塗った方を保つ。色は同じ。
    if (before == null || TSUNAMI_PAINT[paint].rank > TSUNAMI_PAINT[before].rank) merged.set(area.code, paint);
  }
  const segments = [...merged].map(([code, paint]) => ({ code, rect: COAST_RECT_BY_CODE.get(code)!,
    className: TSUNAMI_PAINT[paint].className, blink: paint === "majorWarning" }));
  const areasBySubject = new Map<string, readonly TsunamiPaintedArea[]>();
  const cards = forecasts.map((subject): TsunamiCardView => {
    const painted = new Map<string, TsunamiPaintedArea>();
    let highest: TsunamiPaintClass | null = null;
    for (const area of subject.areas) {
      const paint = tsunamiPaintClass(area.areaClass);
      highest = higherPaint(highest, paint);
      const shown = merged.get(area.code);
      if (paint != null && shown != null) painted.set(area.code, { code: area.code, areaClass: shown });
    }
    // 区域コードの無い区域（C5 の unkeyedAreas）も最高区分と行の色に数える（C5 は active と残る区分の段階に数える、P3-C5-KIND-ENUM=B）。
    // 海岸線の位置は推測せず塗らない（Q-C6-IMPL-AMEND (12)）。
    for (const area of subject.unkeyedAreas) highest = higherPaint(highest, tsunamiPaintClass(kindClass(area.kindCode)));
    areasBySubject.set(subject.subject, [...painted.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)));
    const label = highest == null ? "警報・注意報の区域なし" : TSUNAMI_PAINT[highest].label;
    const rowClass = (value: TsunamiAreaClass) => { const paint = tsunamiPaintClass(value); return paint == null ? "tsu-row" : `tsu-row ${TSUNAMI_PAINT[paint].className}`; };
    return {
      subject: subject.subject,
      head: `[${OPERATION_LABEL[subject.operation]}] 津波 ${subject.eventId} ${label}`,
      className: highest == null ? "tsu-none" : TSUNAMI_PAINT[highest].className,
      reportTimeDisplay: formatJst(parseReportDateTime(subject.source.reportDateTimeRaw)),
      areas: [...subject.areas.map((area) => ({ text: `${area.code} ${area.name}: ${area.kindName}${heightText(area)}`, className: rowClass(area.areaClass) })),
        ...subject.unkeyedAreas.map((area) => ({ text: `${area.name}: ${area.kindName}（区域コードなし）`, className: rowClass(kindClass(area.kindCode)) }))],
    };
  });
  return { cards, segments, missingCoastCount: missing.size, areasBySubject };
}

// P3-C6-AC04: 1 回の津波の描き直しで出す T6 候補の detail と、今描いた subject。full 配送の subject ごとに present true を 1 つ、
// 直前に描いていて今回描かない subject に present false・areas 空を 1 つ。version は snapshot の版。
function tsunamiCandidates(snapshot: DisplaySnapshot, previousSubjects: ReadonlySet<string>): Readonly<{
  details: readonly ChromeTsunamiMarkerDetail[]; drawn: ReadonlySet<string>;
}> {
  const tsunami = snapshot.current.tsunami;
  const forecasts = tsunami.delivery === "full" ? tsunami.view.forecasts : [];
  const areas = buildTsunamiPaint(forecasts).areasBySubject;
  const displayVersion = { streamId: snapshot.streamId, semanticRevision: snapshot.semanticRevision, sequence: snapshot.sequence };
  const detail = (operation: Operation, subject: string, present: boolean): ChromeTsunamiMarkerDetail => ({ name: "fleq:p3:tsunami:T6-candidate",
    displayVersion, operation, subject, present, cardMarkerId: `tsunami-card:${subject}`, coastMarkerId: `coast:${subject}`,
    areas: present ? areas.get(subject) ?? [] : [] });
  const drawn = new Set(forecasts.map((subject) => subject.subject));
  const details = forecasts.map((subject) => detail(subject.operation, subject.subject, true));
  // subject は `${operation}/VTSE41/${eventId}`（I-U-T）なので、消えた subject の operation は先頭から読む。
  for (const subject of previousSubjects) if (!drawn.has(subject)) {
    const operation = OPERATIONS.find((value) => subject.startsWith(`${value}/`));
    if (operation != null) details.push(detail(operation, subject, false));
  }
  return { details, drawn };
}

// ── AC01: snapshotの境界検証。A9が描画・判定で読む部分と判別値だけを確かめる (A8の型全体は複製しない)。──
type Fields = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = (table: object, value: unknown) => typeof value === "string" && Object.hasOwn(table, value);
const isTimeOrNull = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
const isTextOrNull = (value: unknown) => value === null || typeof value === "string";
const OPERATIONS = ["normal", "training", "test"] as const;

function isMaterialValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "missing": return true;
    case "empty": case "unknown": return typeof value.raw === "string";
    case "text": return typeof value.raw === "string" && typeof value.value === "string";
    case "number": return typeof value.raw === "string" && typeof value.value === "number";
    case "range": return typeof value.raw === "string" && typeof value.value === "number"
      && (value.bound === "lower" || value.bound === "upper");
    default: return false;
  }
}
const isIntensity = (value: unknown) => isRecord(value) && isMaterialValue(value.from) && isMaterialValue(value.to)
  && isTextOrNull(value.condition) && isTextOrNull(value.description);
const isCurrent = (value: unknown) => isRecord(value) && oneOf(OPERATION_LABEL, value.operation)
  && typeof value.subject === "string" && typeof value.eventId === "string"
  && (value.family === "VXSE43" || value.family === "VXSE45")
  && isRecord(value.source) && typeof value.source.reportDateTimeRaw === "string"
  && isRecord(value.prediction) && isIntensity(value.prediction.maximum) && Array.isArray(value.prediction.areas)
  && value.prediction.areas.every((area) => isRecord(area) && typeof area.code === "string" && isIntensity(area.intensity));
const isItem = (value: unknown, operation: Operation) => isRecord(value) && value.operation === operation
  && Number.isSafeInteger(value.activeCount) && (value.highestSeverity === null || oneOf(SEVERITY_LABEL, value.highestSeverity))
  && isTimeOrNull(value.updatedAt) && isRecord(value.admission)
  && (value.admission.capacityExceeded === undefined || Number.isSafeInteger(value.admission.capacityExceeded))
  && isRecord(value.confirmation) && oneOf(CONFIRMATION_LABEL, value.confirmation.state)
  && isTimeOrNull(value.confirmation.confirmedAt);
// P3-C6-AC03(7): 津波の描画に使う項目だけ。
const TSUNAMI_CLASSES: Readonly<Record<TsunamiAreaClass, true>> = {
  majorWarning: true, warning: true, advisory: true, forecast: true, released: true, none: true, unknown: true,
};
const isTsunamiArea = (value: unknown) => isRecord(value) && typeof value.code === "string" && typeof value.name === "string"
  && oneOf(TSUNAMI_CLASSES, value.areaClass) && typeof value.kindName === "string"
  && isRecord(value.firstHeight) && isTextOrNull(value.firstHeight.arrivalTimeRaw) && isTextOrNull(value.firstHeight.condition)
  && (value.maxHeight === null || isRecord(value.maxHeight) && isMaterialValue(value.maxHeight.value)
    && isTextOrNull(value.maxHeight.condition) && isTextOrNull(value.maxHeight.description));
const isTsunamiForecast = (value: unknown) => isRecord(value) && oneOf(OPERATION_LABEL, value.operation)
  && typeof value.subject === "string" && typeof value.eventId === "string"
  && isRecord(value.source) && typeof value.source.reportDateTimeRaw === "string"
  && Array.isArray(value.areas) && value.areas.every(isTsunamiArea)
  && Array.isArray(value.unkeyedAreas) && value.unkeyedAreas.every((area) => isRecord(area) && typeof area.name === "string"
    && typeof area.kindName === "string");
const isNotice = (value: unknown) => isRecord(value) && oneOf(OPERATION_LABEL, value.operation) && typeof value.text === "string"
  && (value.source === null || isRecord(value.source) && isTextOrNull(value.source.office)
    && typeof value.source.officeTruncated === "boolean");

// 配送の外形（unit・内容版・3 行の items・full/summary）。view の中身は呼び出し側が unit ごとに確かめる。
function isDomain(domain: unknown, unit: string): domain is Fields {
  if (!isRecord(domain) || domain.unit !== unit || typeof domain.contentRevision !== "string") return false;
  const items = domain.items;
  return Array.isArray(items) && items.length === 3 && OPERATIONS.every((operation, index) => isItem(items[index], operation))
    && (domain.delivery === "summary" || domain.delivery === "full" && isRecord(domain.view));
}

function isDisplaySnapshot(value: unknown): value is DisplaySnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.streamId !== "string"
    || !Number.isSafeInteger(value.sequence) || typeof value.semanticRevision !== "string") return false;
  const { connection, worker, channels, notices, current } = value;
  if (!isRecord(connection) || !oneOf(CONNECTION_LABEL, connection.state) || !isTimeOrNull(connection.disconnectedAt)
    || !isRecord(worker) || !oneOf(WORKER_LABEL, worker.state)
    || !isRecord(channels) || !oneOf(CHANNEL_LABEL, channels.desktop) || !oneOf(CHANNEL_LABEL, channels.sound)
    || !Array.isArray(notices) || !notices.every(isNotice) || !isRecord(current)) return false;
  const eew = current.eew, tsunami = current.tsunami;
  if (!isDomain(eew, "U-E") || !isDomain(tsunami, "U-T")) return false;
  return (eew.delivery === "summary" || isRecord(eew.view) && Array.isArray(eew.view.current) && eew.view.current.every(isCurrent))
    && (tsunami.delivery === "summary" || isRecord(tsunami.view) && Array.isArray(tsunami.view.forecasts)
      && tsunami.view.forecasts.every(isTsunamiForecast));
}

// 受信した文字列をsnapshotへ。不正なら null を返し、呼び出し元は受信時刻・stale・marker・表示を更新しない。
function parseDisplaySnapshot(data: string): DisplaySnapshot | null {
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return null; }
  return isDisplaySnapshot(parsed) ? parsed : null;
}

export {
  buildChannelLines, buildConfirmationLine, buildConnectionLine, buildEewCard, buildNoticeLine, buildSummaryLine,
  buildCapacityExceededLine, buildTsunamiPaint, eewContentChanged, operationVisible, parseDisplaySnapshot, parseHeartbeatWorker,
  replaceDisplaySnapshot, staleBanner,
  summaryRowVisible, tsunamiCandidates, tsunamiContentChanged,
};
