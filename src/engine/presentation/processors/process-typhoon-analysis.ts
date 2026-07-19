import type { WsDataMessage } from "../../../types";
import type { TyphoonAnalysisOutcome } from "../types";
import { parseTyphoonAnalysis } from "../../../dmdata/typhoon-analysis-parser";
import {
  typhoonAnalysisFrameLevel,
  typhoonAnalysisSoundLevel,
} from "../level-helpers";

/** 台風解析・予報情報 (VPTW60/61/62) を処理し TyphoonAnalysisOutcome を返す。パース失敗時は null。 */
export function processTyphoonAnalysis(msg: WsDataMessage): TyphoonAnalysisOutcome | null {
  const info = parseTyphoonAnalysis(msg);
  if (!info) return null;

  return {
    domain: "typhoonAnalysis",
    msg,
    headType: msg.head.type,
    statsCategory: "typhoonAnalysis",
    parsed: info,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? info.eventId,
    },
    presentation: {
      frameLevel: typhoonAnalysisFrameLevel(info),
      soundLevel: typhoonAnalysisSoundLevel(info),
      notifyCategory: "typhoonAnalysis",
    },
  };
}
