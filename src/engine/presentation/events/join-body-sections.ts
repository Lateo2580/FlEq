import type {
  ClimateBodyText,
  ParsedVolcanoAshfallInfo,
  WeatherExplanationSection,
} from "../../../types";
import { volcanoAshfallToText } from "./volcano-to-text";

// テロップ本文 (bodyText) を組む連結ヘルパ群。見出し (【概況】等) は
// 「途中から見た人の文脈喪失」緩和のため付す (spec §2-2 規則 1)。全滅は null。

function isBlank(s: string | null | undefined): boolean {
  return s == null || s.trim() === "";
}

/**
 * 気象解説情報 (VPCJ51/VPZJ51/VPFJ51/VMCJ53-55) の本文セクションを
 * 【sectionType】text の形で改行連結する。空/全空白セクションは除外、全滅は null。
 */
export function joinSections(sections: WeatherExplanationSection[]): string | null {
  const parts: string[] = [];
  for (const s of sections) {
    if (isBlank(s.text)) continue;
    const heading = isBlank(s.sectionType) ? "" : `【${s.sectionType}】`;
    parts.push(`${heading}${s.text.trim()}`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * 気候情報 (VPZI50/VPCI50) の本文ブロックを【textType】text の形で改行連結する。
 * textType が null のときは「本文」を見出しにする。空は除外、全滅は null。
 */
export function joinBodyTexts(bodyTexts: ClimateBodyText[]): string | null {
  const parts: string[] = [];
  for (const bt of bodyTexts) {
    if (isBlank(bt.text)) continue;
    parts.push(`【${bt.textType ?? "本文"}】${bt.text.trim()}`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * 降灰予報バッチ (VFVO53 集約) の全要素本文を文書順で連結する。
 * 複数火山ぶんが 1 batch に入りうるため火山名見出し【volcanoName】を付す。
 * 空・重複本文は除去 (代表 1 件では「全文」と両立しないため全件連結、spec §2-2)。
 */
export function joinVolcanoBatch(parsed: ParsedVolcanoAshfallInfo[]): string | null {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (isBlank(item.bodyText)) continue;
    const body = item.bodyText.trim();
    // 火山ごとに定型本文が重複しうるため、dedup キーは火山 (code 優先) と本文の組。
    // 本文のみをキーにすると別火山・同一定型本文で後者が火山名ごと消える。
    const dedupKey = `${item.volcanoCode ?? item.volcanoName ?? ""}\0${body}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const heading = isBlank(item.volcanoName) ? "" : `【${item.volcanoName}】`;
    parts.push(`${heading}${body}`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * 降灰バッチ (VFVO53 集約) を構造化文章化して連結する (spec §3-3)。
 * 全要素が合成成功 (最低情報量を満たす) のときだけ合成文連結、
 * 1 要素でも合成 null なら従来 joinVolcanoBatch (平文連結) へ全体フォールバック (all-or-nothing)。
 */
export function joinVolcanoAshfallBatch(parsed: ParsedVolcanoAshfallInfo[]): string | null {
  const synthesized = parsed.map((p) => volcanoAshfallToText(p));
  if (synthesized.some((s) => s == null)) {
    return joinVolcanoBatch(parsed); // 平文フォールバック (合成と表テキストを混在させない)
  }
  const parts: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const body = synthesized[i]!;
    const dedupKey = `${parsed[i].volcanoCode ?? parsed[i].volcanoName ?? ""}\0${body}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    parts.push(body);
  }
  return parts.length > 0 ? parts.join("\n") : joinVolcanoBatch(parsed);
}
