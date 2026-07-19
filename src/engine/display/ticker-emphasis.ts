// テロップ本文の重要語句を機械抽出し、強調区間を index span で返す (backlog §3)。
// 強調表現はフロント側で font-weight を上げるのみ (色替え・点滅はしない)。語彙表は最小に絞り、
// 「量の大きさ / 状態変化 / 重要状態が行動判断に効く」パターンだけを宣言的ルールで対象にする
// (名前マッチの脆さを避けるため、単独語ではなく意味の完結する複合語だけを拾う)。
//
// span は **normalizeTickerBody を通した後の本文** に対する UTF-16 code unit オフセット [start, end)。
// project-event の射影チョークポイントで、情報系 (low) と警報級手前 (mid) の本文テロップに噛ませる。
// 数値 value は low 専用、状態変化 transition / 重要状態 status は low+mid に効かせる (high は非適用)。

import type { DisplayTickerPriority } from "./types";

/** 強調区間 (正規化後 tickerBody への index span、半開区間 [start, end))。 */
export interface TickerEmphasisSpan {
  start: number;
  end: number;
}

/** 強調の種別。重複解決・淘汰時の優先度に効く (kind は内部表現に留め、protocol へは出さない)。 */
type EmphasisKind = "value" | "transition" | "status";

/** 宣言的な強調ルール。source は呼び出しごとに fresh compile する (global 正規表現の lastIndex 汚染回避)。 */
interface EmphasisRule {
  id: string;
  /** 適用対象の優先度。ここに現在の priority が含まれるルールだけを走らせる。 */
  priorities: readonly DisplayTickerPriority[];
  /** 正規表現ソース (RegExp は都度生成する)。 */
  source: string;
  kind: EmphasisKind;
  /** 重複解決時の勝者を明示する重み。transition(30) > status(20) > value(10)。 */
  weight: number;
}

// 数値 (半角。normalizeTickerBody で全角→半角済み前提)。小数を許す
const NUM = "[0-9]+(?:\\.[0-9]+)?";

const LOW: readonly DisplayTickerPriority[] = ["low"];
const LOW_MID: readonly DisplayTickerPriority[] = ["low", "mid"];

const VALUE_WEIGHT = 10;
const STATUS_WEIGHT = 20;
const TRANSITION_WEIGHT = 30;

/** kind の淘汰優先度 (1 文 3 個上限を超えたとき残す順)。小さいほど残る。 */
const KIND_RANK: Record<EmphasisKind, number> = { transition: 0, status: 1, value: 2 };

/** 1 文 (「。」区切り) あたりの強調上限。 */
const MAX_PER_SENTENCE = 3;

// 数値+単位 (value)。単位は「量の大きさが行動判断に効く」ものだけ。日時 (「2日00時」) は頻出ノイズなので対象外。
// 旧実装は alternation の並び順で km/h を km より優先していたが、本テーブルでは「同開始位置は長い語優先」の
// 重複解決に置き換えたため並び順に依存しない (km/h と km が同じ開始位置なら長い km/h が勝つ)。
const VALUE_RULES: readonly EmphasisRule[] = [
  { id: "shindo", source: "震度[0-9]+[弱強]?", kind: "value", weight: VALUE_WEIGHT, priorities: LOW }, // 震度5弱 / 震度7
  { id: "magnitude", source: `マグニチュード${NUM}`, kind: "value", weight: VALUE_WEIGHT, priorities: LOW }, // マグニチュード7.1
  // M7.1 (気象庁式)。直前が英数字/ピリオドなら弾く (PM2.5 の M2.5 誤取得を防ぐ)
  { id: "m-magnitude", source: `(?<![0-9A-Za-z.])M${NUM}`, kind: "value", weight: VALUE_WEIGHT, priorities: LOW },
  { id: "kmh", source: `${NUM}km/h`, kind: "value", weight: VALUE_WEIGHT, priorities: LOW }, // 20km/h (移動速度)
  { id: "ms", source: `${NUM}m/s`, kind: "value", weight: VALUE_WEIGHT, priorities: LOW }, // 20m/s (風速)
  { id: "km", source: `${NUM}km`, kind: "value", weight: VALUE_WEIGHT, priorities: LOW }, // 150km (距離)
  { id: "mm", source: `${NUM}mm`, kind: "value", weight: VALUE_WEIGHT, priorities: LOW }, // 120mm (雨量)
  { id: "milli", source: `${NUM}ミリ`, kind: "value", weight: VALUE_WEIGHT, priorities: LOW }, // 120ミリ
  { id: "hpa", source: `${NUM}hPa`, kind: "value", weight: VALUE_WEIGHT, priorities: LOW }, // 970hPa (気圧)
  { id: "meter-kana", source: `${NUM}メートル`, kind: "value", weight: VALUE_WEIGHT, priorities: LOW }, // 35メートル (波高等)
  // 35m (素の m。後続が英数字/スラッシュなら上のより具体的な単位に譲る)
  { id: "meter", source: `${NUM}m(?![a-zA-Z0-9/])`, kind: "value", weight: VALUE_WEIGHT, priorities: LOW },
  { id: "percent", source: `${NUM}[%％]`, kind: "value", weight: VALUE_WEIGHT, priorities: LOW }, // 99% (確率)
];

// 状態変化 (transition)。「警報・注意報を発表/解除」「発表を再開」等、動詞を伴い意味が完結する複合語だけ。
// 「警報」「発表」単体では拾わない。特別警報は警報より長く同開始位置で勝つため、特別警報を発表 → 全体を強調する。
// 文言根拠: VPWW56/57「レベル４…危険警報を発表しています」、VTSE41「津波警報を発表しました」、
//   VZVO40「噴火警報を発表します」、VZSE40 系の運用停止/再開通知 (発表を再開)。
const TRANSITION_RULES: readonly EmphasisRule[] = [
  { id: "special-warning-transition", source: "特別警報(?:を)?(?:発表|解除)", kind: "transition", weight: TRANSITION_WEIGHT, priorities: LOW_MID },
  { id: "warning-transition", source: "警報(?:を)?(?:発表|解除)", kind: "transition", weight: TRANSITION_WEIGHT, priorities: LOW_MID },
  { id: "advisory-transition", source: "注意報(?:を)?(?:発表|解除)", kind: "transition", weight: TRANSITION_WEIGHT, priorities: LOW_MID },
  { id: "resume-transition", source: "(?:発表|運用)(?:を)?再開", kind: "transition", weight: TRANSITION_WEIGHT, priorities: LOW_MID },
];

// 重要状態 (status)。避難情報の警戒レベル体系の固定語 (単独で意味が完結し誤検出しにくい官製用語)。
// 文言根拠: VPWW56 補足情報「避難指示などの情報」、VXKO50「高齢者等避難の発令の目安」、
//   緊急安全確保は警戒レベル5 の官製用語で避難指示/高齢者等避難と対で使われる。
const STATUS_RULES: readonly EmphasisRule[] = [
  { id: "evac-order", source: "避難指示", kind: "status", weight: STATUS_WEIGHT, priorities: LOW_MID },
  { id: "elderly-evac", source: "高齢者等避難", kind: "status", weight: STATUS_WEIGHT, priorities: LOW_MID },
  { id: "emergency-safety", source: "緊急安全確保", kind: "status", weight: STATUS_WEIGHT, priorities: LOW_MID },
];

const ALL_RULES: readonly EmphasisRule[] = [...VALUE_RULES, ...TRANSITION_RULES, ...STATUS_RULES];

interface Candidate {
  start: number;
  end: number;
  kind: EmphasisKind;
  weight: number;
  ruleId: string;
}

/** [aStart,aEnd) と [bStart,bEnd) が重なるか (半開区間)。 */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** span の開始位置が属する文番号 (先行する「。」の個数)。 */
function sentenceIndexAt(body: string, start: number): number {
  let count = 0;
  for (let i = 0; i < start; i++) {
    if (body[i] === "。") count++;
  }
  return count;
}

/**
 * 正規化後の本文から強調区間を抽出する。priority で適用ルールを絞り (value=low のみ、
 * transition/status=low+mid)、重なりは 1 つに正規化、1 文あたり最大 3 個に淘汰する。
 * マッチが無ければ空配列。呼び出し側は空配列を「強調なし (null 等価)」として扱ってよい。
 */
export function extractTickerEmphasis(
  body: string | null | undefined,
  priority: DisplayTickerPriority = "low",
): TickerEmphasisSpan[] {
  if (body == null || body === "") return [];

  // 1. 適用対象ルールを全て走らせ候補を集める
  const candidates: Candidate[] = [];
  for (const rule of ALL_RULES) {
    if (!rule.priorities.includes(priority)) continue;
    const re = new RegExp(rule.source, "g");
    let match = re.exec(body);
    while (match != null) {
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: rule.kind,
        weight: rule.weight,
        ruleId: rule.id,
      });
      // 空マッチ保険 (本テーブルに空マッチ規則は無いが lastIndex 停滞を防ぐ)
      if (match.index === re.lastIndex) re.lastIndex++;
      match = re.exec(body);
    }
  }
  if (candidates.length === 0) return [];

  // 2. start 昇順 → 同位置は weight 降順 → 長い語優先 → ruleId で決定化。
  //    重複時の勝敗は「左端優先」で、weight は同一開始位置の候補間の tie-break にのみ効く。
  //    現行ルールでは異種 kind の部分重複 (value と transition 等) は起きないため、
  //    weight 昇格が左端優先に負ける状況は生じない (数値を含む transition を将来足す場合は要再設計)。
  candidates.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.weight !== b.weight) return b.weight - a.weight;
    const lenA = a.end - a.start;
    const lenB = b.end - b.start;
    if (lenA !== lenB) return lenB - lenA;
    return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
  });

  // 3. 貪欲に非重複で採用
  const accepted: Candidate[] = [];
  for (const c of candidates) {
    if (accepted.some((a) => overlaps(a.start, a.end, c.start, c.end))) continue;
    accepted.push(c);
  }

  // 4. 1 文あたり最大 3 個。超えたら transition > status > value → weight 降順 → start 昇順 で残す
  const bySentence = new Map<number, Candidate[]>();
  for (const c of accepted) {
    const idx = sentenceIndexAt(body, c.start);
    const bucket = bySentence.get(idx);
    if (bucket == null) bySentence.set(idx, [c]);
    else bucket.push(c);
  }
  const kept: Candidate[] = [];
  for (const bucket of bySentence.values()) {
    if (bucket.length <= MAX_PER_SENTENCE) {
      kept.push(...bucket);
      continue;
    }
    const ranked = [...bucket].sort((a, b) => {
      if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
      if (a.weight !== b.weight) return b.weight - a.weight;
      return a.start - b.start;
    });
    kept.push(...ranked.slice(0, MAX_PER_SENTENCE));
  }

  // 5. protocol へは start 昇順の {start,end}[] で返す (kind は内部表現に留める)
  kept.sort((a, b) => a.start - b.start);
  return kept.map((c) => ({ start: c.start, end: c.end }));
}
