const VISIBLE_EDGE_LENGTH = 4;
const MASK_PLACEHOLDER = "****";

/** APIキーの先頭・末尾のみ表示し、中間をマスクする */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= VISIBLE_EDGE_LENGTH * 2) {
    return MASK_PLACEHOLDER;
  }
  return (
    apiKey.substring(0, VISIBLE_EDGE_LENGTH) +
    MASK_PLACEHOLDER +
    apiKey.substring(apiKey.length - VISIBLE_EDGE_LENGTH)
  );
}
