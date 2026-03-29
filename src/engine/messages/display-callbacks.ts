/**
 * engine → ui の逆方向依存を解消するための表示コールバックインターフェース。
 * engine 層はこのインターフェースを通じてのみ表示を行う。
 * 実装は ui 層の display-adapter.ts で提供される。
 */

import type { WsDataMessage, ParsedVolcanoInfo } from "../../types";
import type { ProcessOutcome, VolcanoBatchOutcome, PresentationEvent } from "../presentation/types";
import type { VolcanoPresentation } from "../notification/volcano-presentation";
import type { Vfvo53BatchItems } from "./volcano-vfvo53-aggregator";

export interface DisplayCallbacks {
  /** ProcessOutcome に基づいてドメイン別の表示を行う (火山以外) */
  displayOutcome(outcome: ProcessOutcome): void;

  /** XML でない電文のヘッダのみ表示 */
  displayRawHeader(msg: WsDataMessage): void;

  /** 火山単発電文の表示 */
  displayVolcano(info: ParsedVolcanoInfo, presentation: VolcanoPresentation): void;

  /** 火山バッチ電文の表示 */
  displayVolcanoBatch(batch: Vfvo53BatchItems, presentation: VolcanoPresentation): void;

  /** 現在の表示モードを取得する ("normal" | "compact") */
  getDisplayMode(): string;

  /** PresentationEvent を1行サマリーに変換する */
  renderSummaryLine(event: PresentationEvent): string;
}
