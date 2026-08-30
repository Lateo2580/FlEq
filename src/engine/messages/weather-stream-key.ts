/**
 * 府県気象台系 weather stream の共通 key。
 * revision subject と ticker group は必ずこの正規化を共有する。
 */
export const VPWS50_STATE_HEAD_TYPES = [
  "VPWS50",
  "VPWW55",
  "VPWW57",
  "VPWW58",
  "VPWW59",
  "VPWW60",
  "VPWW61",
] as const;

const VPWS50_STATE_HEAD_TYPE_SET: ReadonlySet<string> = new Set(VPWS50_STATE_HEAD_TYPES);

export function isVpws50StateHeadType(type: string): boolean {
  return VPWS50_STATE_HEAD_TYPE_SET.has(type);
}

export function weatherOfficeStreamKey(
  type: string,
  publishingOffice: string | null | undefined,
): string | null {
  const normalizedType = type.trim();
  const normalizedOffice = publishingOffice?.trim() ?? "";
  if (normalizedType === "" || normalizedOffice === "") return null;
  return `weather:${normalizedType}:${normalizedOffice}`;
}

/** VPNO50 の終了 watermark は電文種別を跨ぐため、官署だけを identity とする。 */
export function weatherOfficeWatermarkKey(
  publishingOffice: string | null | undefined,
): string | null {
  const normalizedOffice = publishingOffice?.trim() ?? "";
  return normalizedOffice === "" ? null : `weather:office:${normalizedOffice}`;
}

/** VPWW55-61 の revision subject から正規化済み官署名を取り出す。 */
export function weatherOfficeFromStreamKey(subjectKey: string): string | null {
  const match = /^weather:VPWW(?:55|57|58|59|60|61):(.+)$/.exec(subjectKey);
  const office = match?.[1]?.trim() ?? "";
  return office === "" ? null : office;
}

/** 既存 VPWW55 subject watermark を新しい官署 watermark へ読み替える。 */
export function normalizeWeatherOfficeWatermarkKey(key: string): string | null {
  if (key.startsWith("weather:office:")) {
    return weatherOfficeWatermarkKey(key.slice("weather:office:".length));
  }
  return weatherOfficeWatermarkKey(weatherOfficeFromStreamKey(key));
}
