/**
 * 情報ディスプレイの起動・停止・状態確認を束ねるコントローラ。
 * 起動時の `--display` フラグと REPL の `display on/off` の両方から同じ経路で呼ばれる。
 * displayRuntime の実体は呼び出し元 (monitor.ts) が保持する変数を getRuntime/setRuntime 経由で
 * 読み書きすることで、単一の真実源として共有する (module singleton の getActiveDisplayRuntime は
 * REPL/handler 互換窓口として set のみ継続する)。
 */

import type { AppConfig } from "../../types";
import type { DisplayCallbacks } from "../messages/display-callbacks";
import type { DisplayConnectionStateV1, DisplayIngestSink } from "./types";
import type { DisplayRuntime, DisplaySeedSources } from "./runtime";

export interface DisplayController {
  start(): Promise<{ ok: boolean; message: string }>;
  stop(): Promise<{ ok: boolean; message: string }>;
  status(): { running: boolean; port: number | null; clientCount: number | null };
}

export interface DisplayControllerDeps {
  config: AppConfig;
  display: DisplayCallbacks;
  seeds: DisplaySeedSources;
  /** 呼び出し元が保持する displayRuntime 変数を読む */
  getRuntime(): DisplayRuntime | null;
  /** 呼び出し元が保持する displayRuntime 変数を書き換える */
  setRuntime(rt: DisplayRuntime | null): void;
  /** router へ渡す displaySink の向き先 (displayHubRef) を更新する */
  setHubRef(hub: DisplayIngestSink | null): void;
  /** null で display off sweep を再開、関数で停止して hub dirty 通知へ切り替える */
  setStandbyDirty?: (fn: (() => void) | null) => void;
  /**
   * 起動直後に publish する現在の dmdata 接続状態を取得する (省略可)。
   * 取得できない/未注入の場合は state-store 初期値 ("connecting") のまま
   */
  getConnectionState?(): DisplayConnectionStateV1["dmdata"];
}

export function createDisplayController(deps: DisplayControllerDeps): DisplayController {
  return {
    async start() {
      if (deps.getRuntime() != null) {
        return { ok: false, message: "情報ディスプレイは既に稼働中です" };
      }
      const { startDisplayRuntime, setActiveDisplayRuntime } = await import("./runtime");
      deps.setStandbyDirty?.(() => {});
      // onStopped: kill switch (onFatal) 経由の停止も deps 側の状態に反映し、二重管理をなくす
      let rt: DisplayRuntime | null;
      try {
        rt = await startDisplayRuntime(deps.config, deps.display, deps.seeds, () => {
          deps.setRuntime(null);
          deps.setHubRef(null);
          deps.setStandbyDirty?.(null);
        });
      } catch (err) {
        deps.setStandbyDirty?.(null);
        throw err;
      }
      if (rt == null) {
        deps.setStandbyDirty?.(null);
        return { ok: false, message: "情報ディスプレイの起動に失敗しました (詳細はログを確認してください)" };
      }
      deps.setRuntime(rt);
      deps.setHubRef(rt.hub);
      deps.setStandbyDirty?.(() => rt.hub.markExternalStateDirty());
      setActiveDisplayRuntime(rt);
      // セッション途中の display on では、実際の dmdata 接続状態を起動直後に反映する
      // (取得元が無ければ state-store 初期値 "connecting" のまま = 現状維持)
      const connState = deps.getConnectionState?.();
      if (connState != null) {
        rt.hub.publishConnection({ dmdata: connState });
      }
      return { ok: true, message: `情報ディスプレイを起動しました (ポート ${rt.transport.port()})` };
    },

    async stop() {
      const rt = deps.getRuntime();
      if (rt == null) {
        return { ok: false, message: "情報ディスプレイは起動していません" };
      }
      // rt.stop() (transport.close 等) が reject しても、状態は必ず「停止」に確定させる。
      // 参照を残すと以後の start() が「既に稼働中」誤判定で失敗し続けるため finally で必ずクリアする
      let stopError: unknown;
      try {
        await rt.stop();
      } catch (err) {
        stopError = err;
      } finally {
        deps.setRuntime(null);
        deps.setHubRef(null);
        deps.setStandbyDirty?.(null);
      }
      const { setActiveDisplayRuntime } = await import("./runtime");
      setActiveDisplayRuntime(null);
      if (stopError !== undefined) {
        return {
          ok: false,
          message: `情報ディスプレイの停止中にエラーが発生しました (状態は停止済みにしました): ${stopError instanceof Error ? stopError.message : String(stopError)}`,
        };
      }
      return { ok: true, message: "情報ディスプレイを停止しました" };
    },

    status() {
      const rt = deps.getRuntime();
      if (rt == null) return { running: false, port: null, clientCount: null };
      return { running: true, port: rt.transport.port(), clientCount: rt.transport.clientCount() };
    },
  };
}

/** displayController 未注入時 (テスト等) のフォールバック。常に「利用不可」を返す no-op */
export function createNoopDisplayController(): DisplayController {
  return {
    async start() {
      return { ok: false, message: "この構成では情報ディスプレイは利用できません" };
    },
    async stop() {
      return { ok: false, message: "情報ディスプレイは起動していません" };
    },
    status() {
      return { running: false, port: null, clientCount: null };
    },
  };
}
