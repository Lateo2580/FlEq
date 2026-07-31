/**
 * 府県気象台系 weather stream の共通 key。
 * revision subject と ticker group は必ずこの正規化を共有する。
 */
export function weatherOfficeStreamKey(
  type: string,
  publishingOffice: string | null | undefined,
): string | null {
  const normalizedType = type.trim();
  const normalizedOffice = publishingOffice?.trim() ?? "";
  if (normalizedType === "" || normalizedOffice === "") return null;
  return `weather:${normalizedType}:${normalizedOffice}`;
}
