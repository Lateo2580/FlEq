import type { WsDataMessage } from "../../../types";
import type { ProcessOutcome } from "../types";
import type { EewTracker } from "../../eew/eew-tracker";
import type { EewEventLogger } from "../../eew/eew-logger";
import type { TsunamiStateHolder } from "../../messages/tsunami-state";
import type { VolcanoStateHolder } from "../../messages/volcano-state";
import { routeToCategory } from "../../messages/telegram-stats";
import { processEew } from "./process-eew";
import { processEarthquake } from "./process-earthquake";
import { processSeismicText } from "./process-seismic-text";
import { processLgObservation } from "./process-lg-observation";
import { processTsunami } from "./process-tsunami";
import { processNankaiTrough } from "./process-nankai-trough";
import { processVolcano } from "./process-volcano";
import { processRaw } from "./process-raw";

/** processMessage に必要な依存群 */
export interface ProcessDeps {
  eewTracker: EewTracker;
  eewLogger: EewEventLogger;
  tsunamiState: TsunamiStateHolder;
  volcanoState: VolcanoStateHolder;
}

/**
 * ルートに応じた processXxx を呼び出し ProcessOutcome を返す。
 * パース失敗の場合は RawOutcome にフォールバックする（元カテゴリを statsCategory に保持）。
 *
 * EEW の場合: パース失敗/重複は null を返す（表示も統計記録もしない）。
 * 火山の場合: VFVO53 aggregator との連携は呼び出し側の責務。
 */
export function processMessage(
  msg: WsDataMessage,
  route: string,
  deps: ProcessDeps,
): ProcessOutcome | null {
  const category = routeToCategory(route);

  switch (route) {
    case "eew": {
      const eewResult = processEew(msg, deps.eewTracker, deps.eewLogger);
      if (eewResult.kind === "ok") return eewResult.outcome;
      if (eewResult.kind === "duplicate") return null; // 重複 → 表示・統計なし
      // parse-failed → raw 表示するが統計には含めない（旧 router と同じ動作）
      const raw = processRaw(msg, category);
      raw.stats.shouldRecord = false;
      return raw;
    }
    case "earthquake": {
      return processEarthquake(msg) ?? processRaw(msg, category);
    }
    case "seismicText": {
      return processSeismicText(msg) ?? processRaw(msg, category);
    }
    case "lgObservation": {
      return processLgObservation(msg) ?? processRaw(msg, category);
    }
    case "tsunami": {
      return processTsunami(msg, deps.tsunamiState) ?? processRaw(msg, category);
    }
    case "nankaiTrough": {
      return processNankaiTrough(msg) ?? processRaw(msg, category);
    }
    case "volcano": {
      return processVolcano(msg, deps.volcanoState) ?? processRaw(msg, category);
    }
    default: {
      return processRaw(msg, category);
    }
  }
}
