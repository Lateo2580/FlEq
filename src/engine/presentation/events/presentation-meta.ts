import type { TelegramMeta, WsDataMessage } from "../../../types";
import { requireTelegramMeta } from "../../../dmdata/telegram-ingress";

/**
 * Production ingress 済み message の共通 meta を返す。
 * projector 直接呼出しの unit test／旧 adapter だけは同じ normalizer で補完する。
 */
export function presentationTelegramMeta(msg: WsDataMessage): TelegramMeta {
  return requireTelegramMeta(msg);
}
