// 津波予報区の固定計器行 (spec: 設計メモ 2026-07-09-summary-instrument-paging.md §2-c) 用の
// バケツ化純関数群。coasts[].maxHeight / firstHeight は構造化されていない自由文字列
// (protocol.ts の DisplayTsunamiInputV1.coasts コメント参照) のため、フロントで文字列を解釈する。
// JMA 階級への正規化はしない (fixtures 実値に "4m"/"2m"/"0.5m" 等の非標準値が実在するため、
// 勝手に丸めると実値と食い違う)。パース不能・null は安全側フォールバックで「不明」系バケツへ寄せ、
// 黙って集計から落とさない。
export interface TsunamiHeightBucket {
  readonly label: string;
  readonly count: number;
}

const UNKNOWN_HEIGHT_LABEL = "不明";

interface ParsedHeight {
  readonly value: number;
  readonly qualifierRank: number;
}

function normalizedHeight(raw: string): string {
  return raw.normalize("NFKC").trim();
}

// 全角を NFKC 正規化してから "10m超" / "0.2m未満" / "3.2m" 等を読む。
// 定性値は、巨大を大津波相当の最上位、高いを津波警報相当 (3m より安全側) として比較する。
// 表示ラベルには正規化前の原文を使う。
function parseHeight(raw: string): ParsedHeight | null {
  const normalized = normalizedHeight(raw);
  if (normalized === "巨大") return { value: Number.POSITIVE_INFINITY, qualifierRank: 0 };
  if (normalized === "高い") return { value: 3, qualifierRank: 3 };
  const m = /^([0-9]+(?:\.[0-9]+)?)m(超|以上|未満)?$/.exec(normalized);
  if (m == null) return null;
  const qualifierRank = m[2] === "超" ? 2 : m[2] === "以上" ? 1 : m[2] === "未満" ? -1 : 0;
  return { value: Number(m[1]), qualifierRank };
}

/** coasts[].maxHeight の distinct 値ごとに件数集計する。JMA 階級への正規化はしない
 *  (実値そのものをラベルにする)。NFKC 後の数値で降順ソートし、同数値は超・以上を上位、
 *  未満を下位に置く。定性値の「巨大」「高い」は安全側の警報階級で配置する。
 *  パース不能な値・null は末尾の「不明」バケツへ安全側フォールバックで合流させる */
export function bucketTsunamiHeight(
  coasts: ReadonlyArray<{ maxHeight: string | null }>,
): TsunamiHeightBucket[] {
  const counts = new Map<string, number>();
  let unknownCount = 0;
  for (const coast of coasts) {
    const raw = coast.maxHeight;
    if (raw == null || parseHeight(raw) == null) {
      unknownCount += 1;
      continue;
    }
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }

  const parsed = Array.from(counts.entries()).map(([label, count]) => ({
    label,
    count,
    parsed: parseHeight(label)!,
  }));
  parsed.sort((a, b) => {
    if (a.parsed.value !== b.parsed.value) return b.parsed.value - a.parsed.value;
    if (a.parsed.qualifierRank !== b.parsed.qualifierRank) {
      return b.parsed.qualifierRank - a.parsed.qualifierRank;
    }
    return 0;
  });

  const buckets: TsunamiHeightBucket[] = parsed.map(({ label, count }) => ({ label, count }));
  if (unknownCount > 0) buckets.push({ label: UNKNOWN_HEIGHT_LABEL, count: unknownCount });
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
  readonly label: string; // 元の maxHeightValue 文字列そのまま (パース結果の丸め値ではなく実値を出す)
}

/** 観測実況 (observations) の中から最大波高の観測点を 1 つ選ぶ。maxHeightValue は自由文字列
 *  (protocol.ts DisplayTsunamiObservationV1 コメント参照) でパース不能・null が混在しうるため、
 *  NFKC 後にパースできた数値・定性値だけを安全側の順位で比較する。全件パース不能・空配列なら
 *  null (安全側で「最大観測」
 *  行ごと非表示にする判断は呼び出し側)。同値の場合は先に現れた観測点を優先する */
export function maxTsunamiObservation(
  observations: ReadonlyArray<{ stationName: string; maxHeightValue: string | null }>,
): TsunamiMaxObservation | null {
  let best: { parsed: ParsedHeight; stationName: string; label: string } | null = null;
  for (const o of observations) {
    if (o.maxHeightValue == null) continue;
    const parsed = parseHeight(o.maxHeightValue);
    if (parsed == null) continue;
    if (
      best == null
      || parsed.value > best.parsed.value
      || (
        parsed.value === best.parsed.value
        && parsed.qualifierRank > best.parsed.qualifierRank
      )
    ) {
      best = { parsed, stationName: o.stationName, label: o.maxHeightValue };
    }
  }
  return best != null ? { stationName: best.stationName, label: best.label } : null;
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
