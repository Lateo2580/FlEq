// テロップ本文の意味分割 (spec §2-3)。サーバは本文プレーンテキストのみ配信し、
// 60-100 字の意味分割はフロント実行時にここで行う (preview で閾値を調整できるようにするため)。
// 純関数・単体テスト対象。外部ライブラリ (文節解析) は使わず決定性を優先する。

export const SEG_TARGET_MIN = 60; // 目標帯の下限 (保証値ではない)
export const SEG_TARGET_MAX = 100; // 目標帯の上限 (超長文はハード分割でここに収める)

export interface SegmentOpts {
  min?: number;
  max?: number;
}

/** コードポイント数で数える (半角 0.5 換算はしない。分割は字数、走行速度は表示幅で役割を分ける、spec §2-3) */
function charLen(s: string): number {
  return Array.from(s).length;
}

/** max 字ごとのハード分割 (読点でも割れない超長文の最終手段) */
function hardSplit(s: string, max: number): string[] {
  const chars = Array.from(s);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += max) {
    out.push(chars.slice(i, i + max).join(""));
  }
  return out;
}

/** \n と句点 (。) で文単位に割る。。は文に残す。見出し (【概況】) は直後の本文と同じ文に残る */
function splitSentences(body: string): string[] {
  const units: string[] = [];
  for (const line of body.split("\n")) {
    let buf = "";
    for (const ch of line) {
      buf += ch;
      if (ch === "。") {
        units.push(buf);
        buf = "";
      }
    }
    if (buf.length > 0) units.push(buf);
  }
  return units.map((u) => u.trim()).filter((u) => u.length > 0);
}

/** max 超の 1 文を読点 (、) 境界で再分割し、読点でも割れない超長片は max でハード分割する */
function splitLongUnit(unit: string, max: number): string[] {
  if (charLen(unit) <= max) return [unit];
  // 、で分割 (、を残す)
  const tokens: string[] = [];
  let buf = "";
  for (const ch of unit) {
    buf += ch;
    if (ch === "、") {
      tokens.push(buf);
      buf = "";
    }
  }
  if (buf.length > 0) tokens.push(buf);
  // 単独で max 超の token はハード分割
  const normalized: string[] = [];
  for (const t of tokens) {
    if (charLen(t) > max) normalized.push(...hardSplit(t, max));
    else normalized.push(t);
  }
  // token を max 以下の範囲で貪欲マージ
  const pieces: string[] = [];
  let cur = "";
  for (const t of normalized) {
    if (cur === "") cur = t;
    else if (charLen(cur) + charLen(t) <= max) cur += t;
    else {
      pieces.push(cur);
      cur = t;
    }
  }
  if (cur !== "") pieces.push(cur);
  return pieces;
}

/**
 * 本文を 60-100 字帯の意味セグメントに分割する。
 * - 60〜100 字は保証値でなく目標帯: 先頭/末尾や全体が短いとき、ハード分割の端数は帯を外れてよい
 * - 内容保存 invariant: normalize(segments.join("")) === normalize(body)
 *   (分割で挿入/除去するのは連結時の改行と見出し前後の空白のみ。文字は落とさない/増やさない)
 * - 空本文は [] を返す (呼び出し側が tickerSentence 1 本へフォールバック)
 */
export function segmentTickerBody(body: string | null | undefined, opts: SegmentOpts = {}): string[] {
  const min = opts.min ?? SEG_TARGET_MIN;
  const max = opts.max ?? SEG_TARGET_MAX;
  if (body == null || body.trim() === "") return [];

  const pieces: string[] = [];
  for (const unit of splitSentences(body)) {
    pieces.push(...splitLongUnit(unit, max));
  }

  // min 未満の断片を次の断片と貪欲マージ (max を超えない範囲で)
  const segments: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur === "") {
      cur = p;
    } else if (charLen(cur) < min && charLen(cur) + charLen(p) <= max) {
      cur += p;
    } else {
      segments.push(cur);
      cur = p;
    }
  }
  if (cur !== "") segments.push(cur);
  return segments;
}

/** 内容保存 invariant 用の正規化: 全空白 (改行含む) を除去する */
export function normalizeForInvariant(s: string): string {
  return s.replace(/\s+/g, "");
}

/** 強調区間 (正規化後 body への UTF-16 index span [start, end))。protocol の tickerEmphasis と同型 */
export interface EmphasisSpan {
  start: number;
  end: number;
}

/**
 * サーバが本文全域に対して算出した強調区間 (body への index span) を、フロントで分割した
 * segments のローカル座標へ写像する (spec backlog §3)。返り値は segments と同じ長さの配列で、
 * 各要素はその segment 内のローカル強調区間 [localStart, localEnd)。
 *
 * segmentTickerBody は内容を保存し (改行・見出し前後の空白のみ増減、文字は落とさない/増やさない)、
 * 強調対象の数値+単位トークンは空白を含まない連続文字列なので、1 つの span は 1 つの segment に
 * 収まる。body と segments の**非空白文字**を左から順に突き合わせて body index → (segment, local) の
 * 対応表を作り、各 span をその表で引く。span が複数 segment に跨る (ハード分割で数字が割れた等の
 * 稀ケース) 場合はその span を捨てる (誤描画より安全側)。
 */
export function mapEmphasisToSegments(
  body: string,
  segments: readonly string[],
  spans: readonly EmphasisSpan[],
): EmphasisSpan[][] {
  const perSegment: EmphasisSpan[][] = segments.map(() => []);
  if (spans.length === 0) return perSegment;

  // body の各非空白文字 index → { seg, local } の対応表。空白は対応させない (トークンは非空白連続)
  const bodyToSeg: Array<{ seg: number; local: number } | undefined> = new Array(body.length);
  let bodyPos = 0;
  const isSpace = (ch: string): boolean => /\s/.test(ch);
  for (let seg = 0; seg < segments.length; seg++) {
    const text = segments[seg]!;
    for (let local = 0; local < text.length; local++) {
      const ch = text[local]!;
      if (isSpace(ch)) continue; // segment 内の空白は body 側の空白に対応 (突き合わせ対象外)
      // body 側を次の非空白文字まで進める
      while (bodyPos < body.length && isSpace(body[bodyPos]!)) bodyPos++;
      if (bodyPos >= body.length || body[bodyPos] !== ch) return perSegment; // 不整合 → 強調なしで安全側
      bodyToSeg[bodyPos] = { seg, local };
      bodyPos++;
    }
  }

  for (const span of spans) {
    if (span.end <= span.start) continue;
    const head = bodyToSeg[span.start];
    const tail = bodyToSeg[span.end - 1];
    if (head == null || tail == null || head.seg !== tail.seg) continue; // 未対応/跨り → 捨てる
    perSegment[head.seg]!.push({ start: head.local, end: tail.local + 1 });
  }
  return perSegment;
}

/**
 * 1 セグメントを強調区間で「素片」と「強調片」の列に切り分ける (描画用、spec backlog §3)。
 * ranges は segment ローカル座標 [start, end)。重なりや順不同にも耐えるよう昇順整列してから走査する。
 */
export function splitEmphasis(text: string, ranges: readonly EmphasisSpan[]): Array<{ text: string; emph: boolean }> {
  if (ranges.length === 0) return text.length > 0 ? [{ text, emph: false }] : [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const parts: Array<{ text: string; emph: boolean }> = [];
  let cursor = 0;
  for (const r of sorted) {
    const start = Math.max(cursor, r.start);
    const end = Math.min(text.length, r.end);
    if (end <= start) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), emph: false });
    parts.push({ text: text.slice(start, end), emph: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), emph: false });
  return parts;
}

/**
 * reduced-motion のページ静止送り用 (spec §5)。実測レーン幅とフォントサイズから
 * 1 ページに収まる字数を導く (全角 1em 相当で概算)。測定不能時は分割しない大きな値を返す。
 */
export function pageCharsForWidth(laneWidthPx: number, fontSizePx: number): number {
  if (!(fontSizePx > 0) || !(laneWidthPx > 0)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.floor(laneWidthPx / fontSizePx));
}

/** セグメントを幅フィットの静止ページへ分割する (reduced-motion 専用、§5)。空は [""] を返す。 */
export function pageSplit(segment: string, pageChars: number): string[] {
  const chars = Array.from(segment);
  if (chars.length === 0) return [""];
  if (pageChars >= chars.length) return [segment];
  const pages: string[] = [];
  for (let i = 0; i < chars.length; i += pageChars) {
    pages.push(chars.slice(i, i + pageChars).join(""));
  }
  return pages;
}

/** 連続走行 (run) の境界。segments[start, end) が 1 本の連続走行 (spec §2-5、§8) */
export interface TickerRun {
  startSegmentIndex: number;
  endSegmentIndexExclusive: number;
}

const RUN_DEFAULT_MAX_CHARS = 800;
const RUN_DEFAULT_MAX_MS = 180_000;
const RUN_DEFAULT_CPS = 5;

/**
 * segments を連続走行 (run) の境界へ分割する (spec §2-5)。
 * - 文字数が maxChars or 推定走行時間 (chars/charsPerSecond*1000) が maxRunMs を超える手前で栞境界を切る
 * - 単一 segment 自身が上限超なら、その segment だけを単独例外 run にする (文途中では切らない)
 * - 上限内は全 segment を 1 run
 */
export function splitRuns(
  segments: string[],
  opts: { maxChars?: number; maxRunMs?: number; charsPerSecond?: number } = {},
): TickerRun[] {
  const maxChars = opts.maxChars ?? RUN_DEFAULT_MAX_CHARS;
  const maxRunMs = opts.maxRunMs ?? RUN_DEFAULT_MAX_MS;
  const cps = opts.charsPerSecond ?? RUN_DEFAULT_CPS;
  if (segments.length === 0) return [];
  const overMs = (chars: number): boolean => (chars / cps) * 1000 > maxRunMs;

  const runs: TickerRun[] = [];
  let start = 0;
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    const len = charLen(segments[i]!);
    if (i > start && (acc + len > maxChars || overMs(acc + len))) {
      // 現 run をここで閉じ、この segment から新 run を始める (栞境界で切る)
      runs.push({ startSegmentIndex: start, endSegmentIndexExclusive: i });
      start = i;
      acc = 0;
    }
    acc += len;
  }
  runs.push({ startSegmentIndex: start, endSegmentIndexExclusive: segments.length });
  return runs;
}

/** 走行中要素の水平移動量 (translateX) を DOMMatrixReadOnly で読む。none/空/非有限は null (spec §2-2) */
export function readTranslateX(el: HTMLElement): number | null {
  const t = getComputedStyle(el).transform;
  if (t === "" || t === "none") return null;
  try {
    const tx = new DOMMatrixReadOnly(t).m41;
    return Number.isFinite(tx) ? tx : null;
  } catch {
    return null;
  }
}

/**
 * span の offsetLeft 実測から「最後に通過した栞」の絶対 index を返す (spec §2-2)。
 * 通過条件: -tx >= scrollWidth + offsetLeft。offset 取得不能 (非有限) は null (現在栞維持)。
 * @param startIndex 描画開始栞 (返り値は startIndex + 相対 index の絶対値)
 */
export function lastPassedBookmark(
  bookmarks: readonly HTMLSpanElement[],
  tx: number,
  scrollWidth: number,
  startIndex: number,
): number | null {
  let last = startIndex;
  for (let i = 0; i < bookmarks.length; i += 1) {
    const offset = bookmarks[i]?.offsetLeft;
    if (offset == null || !Number.isFinite(offset)) return null;
    if (-tx >= scrollWidth + offset) last = startIndex + i;
    else break;
  }
  return last;
}
