import type { PresentationEvent } from "../presentation/types";
import {
  formatDepthSpecialValue,
  formatMagnitudeSpecialValue,
  formatPresentationMagnitude,
} from "../../utils/magnitude";

/**
 * PresentationEvent からドットパスで値を取得する。
 *
 * 表示専用ポリシー (dmdata.jp 再配信ポリシー対応) のため、配列インデックス参照
 * (`[N]`) は parser 側で禁止済み。本関数では二重防御として、念のため `raw`
 * フィールドへのアクセスも拒否する。
 *
 * segments 例:
 * - ["title"]          → event.title
 * - ["earthquake", "magnitude"] → event.earthquake.magnitude
 */
export function getFieldValue(
  event: PresentationEvent,
  segments: string[],
): unknown {
  // 二重防御: parser を経由せず直接呼ばれた場合にも raw への参照を拒否
  if (segments[0] === "raw") return undefined;

  // 旧 magnitude/depth 変数は互換維持。semantic 表示は additive な専用変数で公開する。
  if (segments.length === 1 && segments[0] === "magnitudeLabel") {
    if (event.magnitudeValue != null) return formatMagnitudeSpecialValue(event.magnitudeValue) ?? "—";
    return event.magnitude == null ? undefined : formatPresentationMagnitude(event.magnitude);
  }
  if (segments.length === 1 && segments[0] === "depthLabel") {
    if (event.depthValue != null) return formatDepthSpecialValue(event.depthValue) ?? "—";
    return event.depth ?? undefined;
  }

  let current: unknown = event;

  for (const seg of segments) {
    if (current == null) return undefined;

    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }

  return current;
}
