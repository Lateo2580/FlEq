import type { DisplayTsunamiHeightSemanticV1 } from "./protocol";

// 津波予報区の固定計器行 (spec: 設計メモ 2026-07-09-summary-instrument-paging.md §2-c) 用の
// バケツ化純関数群。新 V1 の maxHeightSemantic がある行は semantic を唯一の真実源とし、
// maxHeight/maxHeightValue の文字列を再解釈しない。semantic が無い旧 V1 snapshot の行だけ、
// 既存の文字列 parse へ fallback する。表示ラベルは qualitative (巨大・高い等) のまま保つが、
// 並び順と最大選定だけは既存カードの安全順序 (巨大=最上位、高い=3m・qualifierRank 3) を使う。
// semantic の bounds はその実値で比較し、それ以外の qualitative 状態表現は数値へ推定しない。
export interface TsunamiHeightBucket {
  readonly label: string;
  readonly count: number;
  readonly semantic?: DisplayTsunamiHeightSemanticV1;
}

const UNKNOWN_HEIGHT_LABEL = "不明";

interface ParsedHeight {
  readonly kind: "numeric" | "qualitative" | "empty" | "unknown";
  /** 表示には使わない、並び順・最大選定専用の内部比較値。 */
  readonly orderValue: number | null;
  readonly qualifierRank: number;
  readonly tieBreak: string;
}

function normalizedHeight(raw: string): string {
  return raw.normalize("NFKC").trim();
}

// 旧 V1 fallback は従前の安全順序を保つ。巨大/高いの内部比較値は表示には使わない。
function parseHeight(raw: string): ParsedHeight | null {
  const normalized = normalizedHeight(raw);
  if (normalized === "巨大") {
    return { kind: "qualitative", orderValue: Number.POSITIVE_INFINITY, qualifierRank: 0, tieBreak: normalized };
  }
  if (normalized === "高い") {
    return { kind: "qualitative", orderValue: 3, qualifierRank: 3, tieBreak: normalized };
  }
  const m = /^([0-9]+(?:\.[0-9]+)?)m(超|以上|未満)?$/.exec(normalized);
  if (m == null) return null;
  const qualifierRank = m[2] === "超" ? 2 : m[2] === "以上" ? 1 : m[2] === "未満" ? -1 : 0;
  return { kind: "numeric", orderValue: Number(m[1]), qualifierRank, tieBreak: normalized };
}

function semanticLabel(semantic: DisplayTsunamiHeightSemanticV1): string {
  const label = semantic.label?.trim();
  if (label) return label;
  if (semantic.presence === "empty") return "空欄";
  return "不明";
}

function qualitativeOrder(
  ...candidates: ReadonlyArray<string | null>
): Pick<ParsedHeight, "orderValue" | "qualifierRank"> | null {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const normalized = normalizedHeight(candidate);
    if (normalized === "巨大") {
      return { orderValue: Number.POSITIVE_INFINITY, qualifierRank: 0 };
    }
    if (normalized === "高い") return { orderValue: 3, qualifierRank: 3 };
  }
  return null;
}

function semanticHeight(semantic: DisplayTsunamiHeightSemanticV1): ParsedHeight {
  const tieBreak = JSON.stringify([
    semanticLabel(semantic).normalize("NFKC"),
    semantic.condition?.normalize("NFKC") ?? null,
    semantic.raw?.normalize("NFKC") ?? null,
  ]);
  if (
    semantic.presence === "qualitative"
    && semantic.lowerBound == null
    && semantic.upperBound == null
  ) {
    const order = qualitativeOrder(semantic.label, semantic.raw);
    return {
      kind: "qualitative",
      orderValue: order?.orderValue ?? null,
      qualifierRank: order?.qualifierRank ?? 0,
      tieBreak,
    };
  }
  if (semantic.presence === "empty") {
    return { kind: "empty", orderValue: null, qualifierRank: 0, tieBreak };
  }
  if (semantic.presence === "unknown") {
    return { kind: "unknown", orderValue: null, qualifierRank: 0, tieBreak };
  }
  const orderValue = semantic.value ?? semantic.upperBound ?? semantic.lowerBound;
  if (orderValue != null && Number.isFinite(orderValue)) {
    // 文字列や badge は再解析せず、比較に使った semantic bounds の向きだけで旧順序へ写す。
    // lower-only (以上系) > exact > upper-only / 両側 range (上限値で比較) とする。
    const qualifierRank = semantic.value != null
      ? 0
      : semantic.upperBound != null
        ? -1
        : semantic.lowerBound != null
          ? 1
          : 0;
    return { kind: "numeric", orderValue, qualifierRank, tieBreak };
  }
  return { kind: "unknown", orderValue: null, qualifierRank: 0, tieBreak };
}

function semanticKey(semantic: DisplayTsunamiHeightSemanticV1): string {
  return JSON.stringify([
    semantic.presence,
    semantic.label,
    semantic.condition,
    semantic.value,
    semantic.lowerBound,
    semantic.upperBound,
    semantic.badge,
  ]);
}

function parsedHeightOrder(value: ParsedHeight): number {
  if (value.orderValue != null) return 0;
  switch (value.kind) {
    case "qualitative":
      return 1;
    case "numeric":
      return 3;
    case "empty":
      return 2;
    case "unknown":
      return 3;
  }
}

function compareParsedHeight(left: ParsedHeight, right: ParsedHeight): number {
  const kindOrder = parsedHeightOrder(left) - parsedHeightOrder(right);
  if (kindOrder !== 0) return kindOrder;
  if (left.orderValue != null && right.orderValue != null) {
    if (left.orderValue > right.orderValue) return -1;
    if (left.orderValue < right.orderValue) return 1;
    if (left.qualifierRank !== right.qualifierRank) {
      return right.qualifierRank - left.qualifierRank;
    }
  }
  if (left.tieBreak < right.tieBreak) return -1;
  if (left.tieBreak > right.tieBreak) return 1;
  return 0;
}

function isHigherParsedHeight(candidate: ParsedHeight, current: ParsedHeight): boolean {
  if (candidate.orderValue == null) return false;
  if (current.orderValue == null) return true;
  if (candidate.orderValue !== current.orderValue) {
    return candidate.orderValue > current.orderValue;
  }
  return candidate.qualifierRank > current.qualifierRank;
}

interface HeightBucketEntry {
  label: string;
  count: number;
  parsed: ParsedHeight;
  semantic?: DisplayTsunamiHeightSemanticV1;
}

/** coasts[].maxHeight の distinct 値ごとに件数集計する。JMA 階級への正規化はしない
 *  (実値そのものをラベルにする)。semantic 経路では numeric bounds と既知の定性ラベルの
 *  内部安全順序で比較するが、表示ラベルは数値化しない。旧 V1 のパース不能な値・null は
 *  末尾の「不明」バケツへ寄せる。 */
export function bucketTsunamiHeight(
  coasts: ReadonlyArray<{
    maxHeight: string | null;
    maxHeightSemantic?: DisplayTsunamiHeightSemanticV1;
  }>,
): TsunamiHeightBucket[] {
  const counts = new Map<string, HeightBucketEntry>();
  let fallbackUnknownCount = 0;
  for (const coast of coasts) {
    if (coast.maxHeightSemantic != null) {
      const semantic = coast.maxHeightSemantic;
      if (!semantic.render || semantic.presence === "missing") continue;
      const label = semanticLabel(semantic);
      const key = `semantic:${semanticKey(semantic)}`;
      const existing = counts.get(key);
      if (existing == null) {
        counts.set(key, { label, count: 1, parsed: semanticHeight(semantic), semantic });
      } else {
        existing.count += 1;
      }
      continue;
    }
    const raw = coast.maxHeight;
    if (raw == null || parseHeight(raw) == null) {
      fallbackUnknownCount += 1;
      continue;
    }
    const parsed = parseHeight(raw)!;
    const existing = counts.get(`legacy:${raw}`);
    if (existing == null) {
      counts.set(`legacy:${raw}`, { label: raw, count: 1, parsed });
    } else {
      existing.count += 1;
    }
  }

  const parsed = Array.from(counts.values());
  parsed.sort((a, b) => compareParsedHeight(a.parsed, b.parsed));

  const buckets: TsunamiHeightBucket[] = parsed.map(({ label, count, semantic }) => ({
    label,
    count,
    ...(semantic == null ? {} : { semantic }),
  }));
  if (fallbackUnknownCount > 0) buckets.push({ label: UNKNOWN_HEIGHT_LABEL, count: fallbackUnknownCount });
  return buckets;
}

export type TsunamiArrivalLabel = "既に・直ちに" | "30分以内" | "1時間以内" | "それ以降" | "到達時期不明";

export interface TsunamiArrivalBucket {
  readonly label: TsunamiArrivalLabel;
  readonly count: number;
}

// 表示の固定順序 (spec §2-c モック「既に・直ちに / 30分以内 / 1時間以内」の並び + 不明を末尾に)
const ARRIVAL_LABEL_ORDER: TsunamiArrivalLabel[] = [
  "既に・直ちに",
  "30分以内",
  "1時間以内",
  "それ以降",
  "到達時期不明",
];

// "既に到達と推測" / "ただちに津波来襲と予測" / "直ちに到達と予想" 等、既に到達済み・直ちに来襲する
// 表現を検出する。時刻表記 ("07日15時30分頃" 等) は数値なので誤検出しない
const IMMEDIATE_PATTERN = /既に|ただちに|直ちに/;

// "07日15時30分頃" / "15時30分頃" / "09時17分までに到達（5分以内）" 等、日 (任意) + 時 + 分を
// 拾う。括弧内の補足 ("地震発生から2分" 等) は「時」を伴わないため誤マッチしない
const TIME_PATTERN = /(?:(\d{1,2})日)?(\d{1,2})時(\d{1,2})分/;

// ISO8601 (常に +09:00 想定、protocol.ts コメント準拠) から年月日を抜き出す。Date の
// getDate()/getHours() はランタイムのローカルタイムゾーンに依存し JST と食い違いうるため、
// 文字列から直接カレンダー要素を取り、UTC 演算で確定的に扱う
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;

interface ReportInstant {
  readonly instantMs: number;
  readonly jstYear: number;
  readonly jstMonth: number; // 1-12
  readonly jstDay: number;
}

function parseReportInstant(reportDateTime: string): ReportInstant | null {
  const instantMs = Date.parse(reportDateTime);
  if (Number.isNaN(instantMs)) return null;
  const m = ISO_DATE_PATTERN.exec(reportDateTime);
  if (m == null) return null;
  return {
    instantMs,
    jstYear: Number(m[1]),
    jstMonth: Number(m[2]),
    jstDay: Number(m[3]),
  };
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** firstHeight の自由文字列を到達時間帯バケツへ分類する。"既に"/"ただちに"/"直ちに" 系の語なら
 *  即時扱い、"D日H時M分頃" 等の時刻表記なら reportDateTime からの差分で 30分以内/1時間以内/それ以降
 *  に振る。境界はどちらも「以内」なので含む (30分ちょうど→30分以内、60分ちょうど→1時間以内)。
 *  解釈できない表記・null・reportDateTime 自体が不正なら「到達時期不明」へ安全側フォールバックする */
export function bucketTsunamiArrival(
  coasts: ReadonlyArray<{ firstHeight: string | null }>,
  reportDateTime: string,
): TsunamiArrivalBucket[] {
  const report = parseReportInstant(reportDateTime);
  const counts = new Map<TsunamiArrivalLabel, number>();
  const bump = (label: TsunamiArrivalLabel) => counts.set(label, (counts.get(label) ?? 0) + 1);

  for (const coast of coasts) {
    const raw = coast.firstHeight;
    if (raw == null) {
      bump("到達時期不明");
      continue;
    }
    if (IMMEDIATE_PATTERN.test(raw)) {
      bump("既に・直ちに");
      continue;
    }
    const label = report != null ? classifyByTime(raw, report) : null;
    bump(label ?? "到達時期不明");
  }

  return ARRIVAL_LABEL_ORDER.filter((label) => (counts.get(label) ?? 0) > 0).map((label) => ({
    label,
    count: counts.get(label)!,
  }));
}

export interface TsunamiMaxObservation {
  readonly stationName: string;
  readonly label: string;
  readonly semantic?: DisplayTsunamiHeightSemanticV1;
}

/** semantic がある観測は value/bounds を真実源にして最大値を選ぶ。bounds の無い qualitative は
 * 巨大/高いだけ既存の内部安全順序で比較し、観測中等の状態表現は最大選定から除外する。
 * semantic の無い旧 V1 観測だけ maxHeightValue の文字列 parse へ fallback する。 */
export function maxTsunamiObservation(
  observations: ReadonlyArray<{
    stationName: string;
    maxHeightValue: string | null;
    maxHeightSemantic?: DisplayTsunamiHeightSemanticV1;
  }>,
): TsunamiMaxObservation | null {
  let best: {
    parsed: ParsedHeight;
    stationName: string;
    label: string;
    semantic?: DisplayTsunamiHeightSemanticV1;
  } | null = null;
  for (const o of observations) {
    if (o.maxHeightSemantic != null) {
      const semantic = o.maxHeightSemantic;
      if (!semantic.render || semantic.presence === "missing") continue;
      const parsed = semanticHeight(semantic);
      if (parsed.orderValue == null) continue;
      if (best == null || isHigherParsedHeight(parsed, best.parsed)) {
        best = { parsed, stationName: o.stationName, label: semanticLabel(semantic), semantic };
      }
      continue;
    }
    if (o.maxHeightValue == null) continue;
    const parsed = parseHeight(o.maxHeightValue);
    if (parsed == null) continue;
    if (parsed.orderValue == null) continue;
    if (best == null || isHigherParsedHeight(parsed, best.parsed)) {
      best = { parsed, stationName: o.stationName, label: o.maxHeightValue };
    }
  }
  return best != null
    ? {
        stationName: best.stationName,
        label: best.label,
        ...(best.semantic == null ? {} : { semantic: best.semantic }),
      }
    : null;
}

// 全角括弧の補足 ("（地震発生から2分）"「（5分以内）」等) を削るための正規表現。TIME_PATTERN
// (分類用) とは無関係の表示専用整形なのでここに置く
const PARENTHETICAL_PATTERN = /（[^）]*）/g;

// 時刻表記 "H時M分" をコロン形式 "H:M" に変換する。TIME_PATTERN (分類用、日部分を含む) とは
// 別に「時」「分」の直前直後だけを対象にする、日部分 ("7日"等) には触れない
const TIME_COLON_PATTERN = /(\d{1,2})時(\d{1,2})分/g;

/** firstHeight の自由文字列を表示用に整形する (spec §2-c【確定 2026-07-10】)。
 *  ① 全角括弧の補足 (「（地震発生から2分）」「（5分以内）」等) を削る — .coast-first の
 *     nowrap 化 (T6c ③) で列幅に収まりきらない長文の閉じ括弧が欠けていた対策
 *  ② 時刻表記 "H時M分" をコロン形式 "H:M" にする (「頃」「までに到達」等の語尾はそのまま残す。
 *     日付き "D日H時M分頃" は日部分 (「7日」等) を変えず時刻部分だけコロン化する)
 *  ③ 「ただちに津波来襲と予測」等の非時刻文はそのまま返す
 *
 *  bucketTsunamiArrival の分類は元の firstHeight 文字列で行う (この関数は表示専用の整形で、
 *  分類ロジックには一切使わない)。null はそのまま null を返す (呼び出し側の "-" フォールバックに
 *  委ねる、TsunamiPanel.svelte の `formatArrivalDisplay(c.firstHeight) ?? "-"` と同じ流儀) */
export function formatArrivalDisplay(firstHeight: string | null): string | null {
  if (firstHeight == null) return firstHeight;
  return firstHeight.replace(PARENTHETICAL_PATTERN, "").replace(TIME_COLON_PATTERN, "$1:$2");
}

function classifyByTime(raw: string, report: ReportInstant): TsunamiArrivalLabel | null {
  const m = TIME_PATTERN.exec(raw);
  if (m == null) return null;
  const day = m[1] != null ? Number(m[1]) : report.jstDay;
  const hour = Number(m[2]);
  const minute = Number(m[3]);

  const targetMs = Date.UTC(report.jstYear, report.jstMonth - 1, day, hour, minute, 0) - JST_OFFSET_MS;
  const diffMs = targetMs - report.instantMs;
  // 報告時刻以前 (例: "09時14分頃" が reportDateTime 09:17:18 より前) は「地震発生からN分」等
  // 既に到達済みの推定を表す実値パターンが実在する (fixtures.ts:1294)。翌日への安全側ロール
  // オーバーはせず (誤って「それ以降」に化けるため)、素直に既到達バケツへ合流させる
  if (diffMs <= 0) return "既に・直ちに";

  const diffMinutes = diffMs / 60_000;
  if (diffMinutes <= 30) return "30分以内";
  if (diffMinutes <= 60) return "1時間以内";
  return "それ以降";
}
