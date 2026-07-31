// processMessage に渡す ProcessDeps の型付きビルダー。
//
// ProcessDeps は電文種別の追加ごとに state holder が増えるため、テストごとに object
// literal を書くと holder が 1 つ増えるたび全テストが型エラーになる。既定の holder 一式を
// 土台に敷き、個別に差し替えたいものだけ override で上書きする。

import { EewTracker } from "../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../src/engine/eew/eew-logger";
import { TsunamiStateHolder } from "../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../src/engine/messages/volcano-state";
import { Vpws50StateHolder } from "../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../src/engine/messages/vpww56-state";
import { Vpwp50DetailCache } from "../../src/engine/messages/vpwp50-detail-cache";
import { TyphoonProbabilityStateHolder } from "../../src/engine/messages/typhoon-probability-state";
import { FloodForecastStateHolder } from "../../src/engine/messages/flood-forecast-state";
import { TelegramRevisionGate } from "../../src/engine/messages/telegram-revision-gate";
import type { ProcessDeps } from "../../src/engine/presentation/processors/process-message";

/** 各 state holder を新品で用意した ProcessDeps。呼び出しごとに独立した state になる */
export function makeProcessDeps(over: Partial<ProcessDeps> = {}): ProcessDeps {
  return {
    eewTracker: new EewTracker(),
    eewLogger: new EewEventLogger(),
    tsunamiState: new TsunamiStateHolder(),
    volcanoState: new VolcanoStateHolder(),
    vpws50State: new Vpws50StateHolder(),
    vpww56State: new Vpww56StateHolder(),
    vpwp50Cache: new Vpwp50DetailCache(),
    typhoonProbabilityState: new TyphoonProbabilityStateHolder(),
    floodForecastState: new FloodForecastStateHolder(),
    ...over,
    revisionGate: over.revisionGate ?? new TelegramRevisionGate(),
  };
}
