import type { WsDataMessage } from "../../../types";
import type { FloodForecastOutcome } from "../types";
import type { ProcessDeps } from "./process-message";
import { parseFloodForecast } from "../../../dmdata/flood-forecast-parser";
import { resolveFloodForecastLevels } from "../level-helpers";
import {
  buildStationDigests,
  type FloodForecastDiff,
} from "../../messages/flood-forecast-state";

/**
 * 指定河川洪水予報 (VXKO50-89 / VXSU50-59) を処理し FloodForecastOutcome を返す。
 * パース失敗時は null (process-message.ts の switch が processRaw fallback を呼ぶ)。
 *
 * dedup bypass / state holder の役割分担 (spec §8.1):
 *   - 取消 (info.infoType === "取消"):
 *       state.rollback(eventId) のみ呼び、suppressNotify=false (取消通知は必ず出す)
 *   - VXKO 通常発表 (schema="vxko50" && infoType !== "訂正" && rawStations.length > 0):
 *       state.diffAndUpdate を呼び、!diff.hasChange なら suppressNotify=true
 *   - 訂正 (infoType === "訂正"):
 *       dedup bypass。毎回通知 (内容更新の周知)
 *   - Headline-only (rawStations.length === 0):
 *       dedup bypass。state は更新しない (station 情報がないため)
 *   - VXSU (schema === "vxsu50"):
 *       dedup bypass。Phase 1 では VXSU station dedup は実装せず毎回通知 (将来課題)
 */
export function processFloodForecast(
  msg: WsDataMessage,
  deps: Pick<ProcessDeps, "floodForecastState">,
): FloodForecastOutcome | null {
  const info = parseFloodForecast(msg);
  if (info == null) return null;

  const { frameLevel, soundLevel, maxLevel, maxRank } =
    resolveFloodForecastLevels(info);

  let suppressNotify = false;
  let diff: FloodForecastDiff | null = null;

  if (info.infoType === "取消") {
    // 取消: state を巻き戻し、通知は必ず出す (suppressNotify=false 据置)
    deps.floodForecastState.rollback(info.eventId);
  } else if (
    info.schema === "vxko50" &&
    info.infoType !== "訂正" &&
    info.rawStations.length > 0
  ) {
    // VXKO 通常発表のみ dedup を効かせる
    const digests = buildStationDigests(info);
    diff = deps.floodForecastState.diffAndUpdate(
      info.eventId,
      digests,
      info.reportDateTime,
    );
    if (!diff.hasChange) {
      suppressNotify = true;
    }
  }
  // 訂正 / Headline-only / VXSU は dedup bypass (suppressNotify=false 据置)

  return {
    domain: "floodForecast",
    msg,
    headType: msg.head.type,
    statsCategory: "floodForecast",
    parsed: info,
    diff,
    maxLevel,
    maxRank,
    stats: { shouldRecord: true, eventId: info.eventId },
    presentation: {
      frameLevel,
      soundLevel,
      notifyCategory: "floodForecast",
      suppressNotify,
    },
  };
}
