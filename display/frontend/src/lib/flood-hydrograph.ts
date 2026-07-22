import type { DisplayFloodHydrographV1 } from "./protocol";

// 水位ミニグラフの viewBox は 132 × 28 固定 (FloodWideCard のセル右端に収める)。
// preserveAspectRatio="none" で描くため、座標はこの論理系でそのまま計算する。
const VIEW_W = 132;
const VIEW_H = 28;
const PAD_X = 3; // 端の丸 (r3) が切れないための左右余白
const PAD_Y = 4; // 上下余白
const MIN_RANGE_M = 0.5; // 平坦な系列でも潰れないための最小水位レンジ (m)
const RANGE_MARGIN_FRAC = 0.1; // レンジ上下に足す余白 (点・危険線が端に貼り付かない)

export interface FloodHydrographDot {
  x: number;
  y: number;
}

export interface FloodHydrographGeometry {
  /** 氾濫危険水位の横線 y。dangerLevelM が無ければ null */
  dangerY: number | null;
  /** 現況点 (塗り丸)。現況が欠測なら null */
  observed: FloodHydrographDot | null;
  /** 破線 polyline の points 文字列。欠測ごとに分割される (長さ 2 未満の区間は線にしない) */
  forecastSegments: string[];
  /** 予測点 (白抜き丸)。欠測点は含めない */
  forecastDots: FloodHydrographDot[];
  /** aria-label 用の要約文 */
  summary: string;
}

function formatMetres(value: number): string {
  return `${value.toFixed(2)}m`;
}

/** ハイドログラフを SVG 座標に落とす純関数。描画不能 (点なし / 有効値ゼロ) は null。
 *  欠測点は x 座標を保持したまま線を切る (詰めない) ことで、区間を跨いだ増減を捏造しない。 */
export function buildFloodHydrograph(hydrograph: DisplayFloodHydrographV1): FloodHydrographGeometry | null {
  const points = hydrograph.points;
  if (points.length === 0) return null;
  const validValues = points.map((point) => point.valueM).filter((value): value is number => value != null);
  if (validValues.length === 0) return null;

  const danger = hydrograph.dangerLevelM;

  // --- y レンジ: 有効全点 + 危険水位を含め、最小レンジと上下余白を確保する ---
  const rangeValues = danger == null ? validValues : [...validValues, danger];
  let lo = Math.min(...rangeValues);
  let hi = Math.max(...rangeValues);
  let span = hi - lo;
  if (span < MIN_RANGE_M) {
    const mid = (lo + hi) / 2;
    lo = mid - MIN_RANGE_M / 2;
    hi = mid + MIN_RANGE_M / 2;
    span = MIN_RANGE_M;
  }
  const margin = span * RANGE_MARGIN_FRAC;
  lo -= margin;
  hi += margin;
  const yOf = (value: number): number => PAD_Y + ((hi - value) / (hi - lo)) * (VIEW_H - 2 * PAD_Y);

  // --- x 座標: dateTime ベース。全点が parse でき、かつ幅があるときのみ時間軸。それ以外は index 等間隔 ---
  const times = points.map((point) => Date.parse(point.dateTime));
  const timeMin = Math.min(...times);
  const timeMax = Math.max(...times);
  const useTime = times.every((time) => Number.isFinite(time)) && timeMax > timeMin;
  const xOf = (index: number): number => {
    if (points.length === 1) return VIEW_W / 2;
    const t = useTime
      ? (times[index] - timeMin) / (timeMax - timeMin)
      : index / (points.length - 1);
    return PAD_X + t * (VIEW_W - 2 * PAD_X);
  };

  // --- 座標化 (欠測は null slot として保持し、線を切る) ---
  const coords = points.map((point, index) =>
    point.valueM == null ? null : { x: xOf(index), y: yOf(point.valueM) });

  const forecastSegments: string[] = [];
  let run: FloodHydrographDot[] = [];
  const flush = (): void => {
    if (run.length >= 2) forecastSegments.push(run.map((dot) => `${dot.x.toFixed(2)},${dot.y.toFixed(2)}`).join(" "));
    run = [];
  };
  for (const coord of coords) {
    if (coord == null) flush();
    else run.push(coord);
  }
  flush();

  const observed = coords[0];
  const forecastDots = coords.slice(1).filter((coord): coord is FloodHydrographDot => coord != null);
  const dangerY = danger == null ? null : yOf(danger);

  return {
    dangerY,
    observed: observed ?? null,
    forecastSegments,
    forecastDots,
    summary: buildSummary(hydrograph),
  };
}

/** 「現在 3.42m。1時間後 3.50m。…。氾濫危険水位 3.20m」形式。欠測は「欠測」。 */
function buildSummary(hydrograph: DisplayFloodHydrographV1): string {
  const points = hydrograph.points;
  const times = points.map((point) => Date.parse(point.dateTime));
  const t0 = times[0];
  const segments: string[] = [];
  points.forEach((point, index) => {
    const valueLabel = point.valueM == null ? "欠測" : formatMetres(point.valueM);
    if (index === 0) {
      segments.push(`現在 ${valueLabel}`);
      return;
    }
    const hoursAhead = Number.isFinite(t0) && Number.isFinite(times[index])
      ? Math.round((times[index] - t0) / 3_600_000)
      : index;
    segments.push(`${hoursAhead}時間後 ${valueLabel}`);
  });
  let summary = segments.join("。");
  if (hydrograph.dangerLevelM != null) summary += `。氾濫危険水位 ${formatMetres(hydrograph.dangerLevelM)}`;
  return summary;
}
