import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { HEARTBEAT_MS } from "./constants";
import { createDisplayRequestListener } from "./http-server";
import { SseClients } from "./sse-clients";
import type { DisplayBroadcastResult, DisplayServerMessage, DisplayStateSnapshotV1, DisplayTransport } from "./types";

export interface DisplayServerOptions {
  host: string;
  port: number;
  distDir: string;
  getSnapshot: () => DisplayStateSnapshotV1;
  log: { info(msg: string): void; warn(msg: string): void };
  /** 非 loopback 接続に要求するアクセストークン。null = 認証なし (loopback バインド時のみ許容) */
  token?: string | null;
}

/** displayHost が loopback (127.0.0.1 / ::1 / localhost) かどうかを判定する */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

// InfoDisplayHub から見た DisplayTransport 実装。node:http サーバ (SSE + static 配信) と
// SseClients (backpressure ガード) を束ねて起動/停止のライフサイクルを持つ。
export class InProcessSseDisplayTransport implements DisplayTransport {
  private readonly clients = new SseClients();
  private server: Server | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private boundPort = 0;

  constructor(private readonly opts: DisplayServerOptions) {}

  async start(): Promise<void> {
    if (!existsSync(join(this.opts.distDir, "index.html"))) {
      throw new Error("display/dist が見つかりません。`npm --prefix display run build` を実行してください");
    }
    if (!isLoopbackHost(this.opts.host)) {
      this.opts.log.warn(
        `情報ディスプレイを非ローカルアドレス (${this.opts.host}) で公開しています。非 loopback からの接続にはアクセストークンが必要です。`,
      );
    }
    const listener = createDisplayRequestListener({
      distDir: this.opts.distDir,
      clients: this.clients,
      getSnapshot: this.opts.getSnapshot,
      log: this.opts.log,
      token: this.opts.token ?? null,
    });
    const server = createServer(listener);
    await new Promise<void>((resolveStart, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port, this.opts.host, () => {
        server.removeListener("error", reject);
        resolveStart();
      });
    });
    const address = server.address();
    this.boundPort = typeof address === "object" && address != null ? address.port : this.opts.port;
    this.server = server;
    this.heartbeatTimer = setInterval(() => this.clients.heartbeat(), HEARTBEAT_MS);
    this.heartbeatTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer != null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clients.closeAll();
    const server = this.server;
    this.server = null;
    if (server == null) return;
    await new Promise<void>((resolveStop, reject) => {
      server.close((err) => {
        if (err != null) reject(err);
        else resolveStop();
      });
    });
  }

  broadcast(msg: DisplayServerMessage): DisplayBroadcastResult {
    return this.clients.broadcast(msg);
  }

  clientCount(): number {
    return this.clients.count();
  }

  /** テスト用。port: 0 起動時の実ポートを返す */
  port(): number {
    return this.boundPort;
  }
}
