import type { ServerResponse } from "node:http";
import * as log from "../../logger";
import {
  MAX_BLOCKED_MS,
  MAX_CLIENTS,
  MAX_EVENT_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_WRITABLE_LENGTH,
} from "./constants";
import type {
  DisplayBroadcastResult,
  DisplayServerMessageWithReconcile,
} from "./types";

/** encode + byte 上限ガード。上限超過は null (呼び出し元で警告ログ)。接続時 snapshot 送信もこれを必ず通す */
export function encodeSseGuarded(msg: DisplayServerMessageWithReconcile): string | null {
  const json = JSON.stringify(msg);
  const id = msg.type === "event" || msg.type === "reconcile" ? `id: ${msg.event.seq}\n` : "";
  const encoded = `${id}event: ${msg.type}\ndata: ${json}\n\n`;
  const limit = msg.type === "event" || msg.type === "reconcile" ? MAX_EVENT_BYTES : MAX_SNAPSHOT_BYTES;
  if (Buffer.byteLength(encoded, "utf8") > limit) return null;
  return encoded;
}

// keepalive は SSE コメント (": ..."; ブラウザの EventSource からは観測できない) ではなく
// 名前付き data イベントにする。コメントだとバイトは流れて TCP のアイドル切断は防げるが、
// クライアントの liveness watchdog が「最終受信時刻」を更新できず、ゾンビ SSE (TCP は ESTAB の
// まま更新が届かない状態) を検知できない。名前付きイベントなら client が addEventListener("ping")
// で受信を観測できる。data は捨て値 (client は受信した事実だけ使う。空 data だと EventSource が
// dispatch しないため非空にする)。DisplayServerMessage の JSON union には含めない (protocol 型不変)。
const HEARTBEAT_CHUNK = "event: ping\ndata: 1\n\n";

interface ClientEntry {
  res: ServerResponse;
  /** write() が false を返した時刻。drain で null に戻る。null なら blocked していない */
  blockedSinceMs: number | null;
}

// SSE クライアント管理: 上限数・backpressure (blocked/writableLength)・ペイロード上限を一箇所に集約する。
// 遅い/詰まったクライアント 1 台が monitor プロセスのメモリ (writable バッファ) を圧迫するのを防ぐガード。
export class SseClients {
  private readonly clients = new Map<ServerResponse, ClientEntry>();
  private readonly now: () => number;
  private readonly onCountChange: ((count: number) => void) | null;

  constructor(
    now: () => number = Date.now,
    onCountChange: ((count: number) => void) | null = null,
  ) {
    this.now = now;
    this.onCountChange = onCountChange;
  }

  /** 上限超過なら false (呼び出し元が 503 等を返す) */
  add(res: ServerResponse): boolean {
    if (this.clients.size >= MAX_CLIENTS) return false;
    const entry: ClientEntry = { res, blockedSinceMs: null };
    this.clients.set(res, entry);
    res.once("close", () => {
      this.removeClient(res);
    });
    // 'error' (ECONNRESET 等) はリスナー無しだとプロセスを abort させる (monitor 同居のため致命的)。
    // 'close' への伝播前に破壊済み res へ write する窓を塞ぐため、ここでも即座に除去する。
    res.on("error", () => {
      this.removeClient(res);
    });
    res.on("drain", () => {
      entry.blockedSinceMs = null;
    });
    this.onCountChange?.(this.clients.size);
    return true;
  }

  count(): number {
    return this.clients.size;
  }

  /**
   * 単一クライアントへの送信 (接続時 snapshot 用)。broadcast と同じ encode 上限 +
   * backpressure ガード経路 (writeToClient) を必ず通す。
   * 戻り値 false = サイズ上限超過で未送信 (呼び出し元が縮退を判断する)。
   * 未登録の res (error/close で除去済み) は送る先が無いだけなので true を返し縮退させない。
   */
  sendTo(res: ServerResponse, msg: DisplayServerMessageWithReconcile): boolean {
    const encoded = encodeSseGuarded(msg);
    if (encoded == null) return false;
    const entry = this.clients.get(res);
    if (entry != null) this.writeToClient(entry, encoded, this.now());
    return true;
  }

  /**
   * JSON.stringify は 1 回のみ (broadcast あたり)。上限超過は誰にも書かず警告ログ。
   * 戻り値で「blocked 等でこの message を受け取れなかった client 数」を返し、authoritative
   * sync (tickerSynced) の完全配送を呼び出し元 (hub) が判定できるようにする (最終レビュー finding 2)。
   */
  broadcast(msg: DisplayServerMessageWithReconcile): DisplayBroadcastResult {
    const total = this.clients.size;
    const encoded = encodeSseGuarded(msg);
    if (encoded == null) {
      log.warn(`SseClients: payload がバイト上限を超えたため送信をスキップしました (type=${msg.type})`);
      return { total, blockedSkipped: total, byteGuardDropped: true }; // 誰にも届いていない
    }
    const nowMs = this.now();
    let blockedSkipped = 0;
    for (const entry of this.clients.values()) {
      if (!this.writeToClient(entry, encoded, nowMs)) blockedSkipped += 1;
    }
    return { total, blockedSkipped };
  }

  /** keepalive ping (client 死活検知 + 中継機器のアイドル切断防止)。HEARTBEAT_CHUNK 参照 */
  heartbeat(): void {
    const nowMs = this.now();
    for (const entry of this.clients.values()) {
      this.writeToClient(entry, HEARTBEAT_CHUNK, nowMs);
    }
  }

  closeAll(): void {
    for (const entry of this.clients.values()) {
      entry.res.destroy();
    }
    if (this.clients.size === 0) return;
    this.clients.clear();
    this.onCountChange?.(0);
  }

  /** 戻り値: この chunk が socket buffer に届いたか (true=書込/バッファ済で client は受け取る、
   *  false=blocked skip / 上限切断 / ended でこの chunk を受け取れなかった)。broadcast の
   *  完全配送判定に使う。ok=false (backpressure) でも chunk は socket buffer に入るため true */
  private writeToClient(entry: ClientEntry, chunk: string, nowMs: number): boolean {
    const { res } = entry;
    if (res.writableEnded) return false;
    if (res.writableLength > MAX_WRITABLE_LENGTH) {
      this.destroyClient(entry);
      return false;
    }
    if (entry.blockedSinceMs != null) {
      if (nowMs - entry.blockedSinceMs > MAX_BLOCKED_MS) {
        this.destroyClient(entry);
      }
      return false; // blocked 継続中は drain か destroy を待つ (書き込まない = この chunk は未達)
    }
    let ok: boolean;
    try {
      ok = res.write(chunk);
    } catch {
      // 破壊済みソケット等への write は同期 throw しうる。broadcast/timer の呼び出し元
      // (monitor 同居) へ漏らさず、該当クライアントだけを除去する
      this.destroyClient(entry);
      return false;
    }
    if (!ok) entry.blockedSinceMs = nowMs;
    return true;
  }

  /** destroy() は 'close'/'error' 発火まで非同期の窓がある。その窓で map に残らないよう同期削除する */
  private destroyClient(entry: ClientEntry): void {
    this.removeClient(entry.res);
    entry.res.destroy();
  }

  /** close / error / backpressure destroy が重なっても人数変更を一度だけ通知する。 */
  private removeClient(res: ServerResponse): void {
    if (!this.clients.delete(res)) return;
    this.onCountChange?.(this.clients.size);
  }
}
