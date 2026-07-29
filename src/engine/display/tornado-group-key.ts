export const UNKNOWN_TORNADO_PUBLISHING_OFFICE = "不明官署";

export function normalizeTornadoPublishingOffice(
  publishingOffice: string | null | undefined,
): string {
  return publishingOffice || UNKNOWN_TORNADO_PUBLISHING_OFFICE;
}

export function tornadoTickerGroupKey(
  publishingOffice: string | null | undefined,
): string {
  return `tornado:${normalizeTornadoPublishingOffice(publishingOffice)}`;
}
