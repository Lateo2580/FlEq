import zlib from "zlib";
import type { WsDataMessage } from "../types";

/** 展開後の最大許容サイズ (10 MB) */
const MAX_DECOMPRESSED_BYTES = 10 * 1024 * 1024;

/** body フィールドをデコードして XML 文字列を返す。 */
export function decodeTelegramBody(msg: WsDataMessage): string {
  let buf: Buffer;

  if (msg.encoding === "base64") {
    buf = Buffer.from(msg.body, "base64");
  } else {
    buf = Buffer.from(msg.body, "utf-8");
  }

  if (msg.compression === "gzip") {
    buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  } else if (msg.compression === "zip") {
    buf = zlib.unzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  }

  if (buf.length > MAX_DECOMPRESSED_BYTES) {
    throw new Error(
      `展開後のサイズが上限を超えています: ${buf.length} bytes (上限: ${MAX_DECOMPRESSED_BYTES} bytes)`,
    );
  }

  return buf.toString("utf-8");
}
