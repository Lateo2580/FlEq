import type { ParsedEarthquakeHypocenter } from "../types";

function normalizeDescription(description: string): string {
  return description
    .normalize("NFKC")
    .trim()
    .replace(/^M(\d+(?:\.\d+)?)(?=\S)/, "M$1 ");
}

export function isNumericMagnitude(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Number(value));
}

/** CLI・通知など、接頭辞を含むマグニチュード表示を返す。 */
export function formatMagnitudeLabel(
  earthquake: Pick<ParsedEarthquakeHypocenter, "magnitude" | "magnitudeInfo">,
): string {
  const description = earthquake.magnitudeInfo?.description?.trim();
  if (description) return normalizeDescription(description);
  if (isNumericMagnitude(earthquake.magnitude)) return `M${earthquake.magnitude}`;
  return "M不明";
}

/**
 * Presentation の既存 magnitude field 用。
 * 数値は従来どおり数値文字列、不明値は接頭辞込みの安全な表示文字列にする。
 */
export function magnitudeForPresentation(
  earthquake: Pick<ParsedEarthquakeHypocenter, "magnitude" | "magnitudeInfo"> | undefined,
): string | null {
  if (earthquake == null) return null;
  if (isNumericMagnitude(earthquake.magnitude)) return earthquake.magnitude;
  return formatMagnitudeLabel(earthquake);
}

/** Presentation magnitude が既に表示文字列なら維持し、数値だけ M を補う。 */
export function formatPresentationMagnitude(magnitude: string): string {
  if (magnitude.trim().toLowerCase() === "nan") return "M不明";
  return isNumericMagnitude(magnitude) ? `M${magnitude}` : magnitude;
}
