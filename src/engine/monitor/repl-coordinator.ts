import * as log from "../../logger";

import type { ReplHandler as ReplHandlerType } from "../../ui/repl";

/**
 * REPL の表示状態を一時的に制御しつつアクションを実行する。
 * 電文表示時にプロンプトが割り込まないよう beforeDisplayMessage / afterDisplayMessage で囲む。
 */
export function withReplDisplay(repl: ReplHandlerType | null, action: () => void): void {
  repl?.beforeDisplayMessage();
  try {
    action();
  } catch (err) {
    log.error(`電文処理エラー: ${err instanceof Error ? err.message : err}`);
  } finally {
    repl?.afterDisplayMessage();
  }
}

/**
 * REPL の接続状態を更新してプロンプトを再描画する。
 */
export function updateReplConnectionState(repl: ReplHandlerType | null, connected: boolean): void {
  if (!repl) return;
  repl.setConnected(connected);
  repl.refreshPrompt();
}
