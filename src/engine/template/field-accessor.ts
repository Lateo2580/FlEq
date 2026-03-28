import type { PresentationEvent } from "../presentation/types";

/**
 * PresentationEvent からドットパス + index access で値を取得する。
 *
 * segments 例:
 * - ["title"]              → event.title
 * - ["raw", "xxx"]         → event.raw.xxx
 * - ["areaItems", 0, "name"] → event.areaItems[0].name
 */
export function getFieldValue(
  event: PresentationEvent,
  segments: (string | number)[],
): unknown {
  let current: unknown = event;

  for (const seg of segments) {
    if (current == null) return undefined;

    if (typeof current === "object") {
      current = (current as Record<string | number, unknown>)[seg];
    } else {
      return undefined;
    }
  }

  return current;
}
