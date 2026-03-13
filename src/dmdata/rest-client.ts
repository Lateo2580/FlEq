import https from "https";
import { AppConfig, SocketStartResponse, SocketListResponse, ContractListResponse, GdEarthquakeListResponse } from "../types";
import * as log from "../logger";

const API_BASE = "https://api.dmdata.jp/v2";

/** TLS ハンドシェイクを再利用するための keep-alive エージェント (遅延初期化) */
let keepAliveAgent: https.Agent | null = null;
function getKeepAliveAgent(): https.Agent {
  if (keepAliveAgent == null) {
    keepAliveAgent = new https.Agent({ keepAlive: true });
  }
  return keepAliveAgent;
}

/** dmdata.jp REST API の推奨方式に合わせて Basic 認証ヘッダーを構築 */
function buildAuthorizationHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

/** HTTPS リクエストを Promise でラップ */
function request(
  method: "GET" | "POST" | "DELETE",
  url: string,
  apiKey: string,
  body?: object
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method,
      agent: getKeepAliveAgent(),
      headers: {
        Accept: "application/json",
        Authorization: buildAuthorizationHeader(apiKey),
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      const statusCode = res.statusCode ?? 0;
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        // 204 No Content は成功（ボディなし）なのでそのまま返す
        if (statusCode === 204) {
          resolve({});
          return;
        }

        // Content-Type チェック
        const contentType = res.headers["content-type"] || "";
        if (!contentType.includes("application/json")) {
          reject(
            new Error(
              `${method} ${parsed.pathname}: 予期しない Content-Type: ${contentType} (status=${statusCode}, body=${data.slice(0, 200)})`
            )
          );
          return;
        }

        try {
          const json: unknown = JSON.parse(data);

          // HTTP ステータスコードの検証
          if (statusCode < 200 || statusCode >= 300) {
            const errMsg =
              typeof json === "object" && json != null && "error" in json
                ? (json as { error: { message?: string } }).error?.message || "Unknown error"
                : data.slice(0, 200);
            reject(
              new Error(
                `${method} ${parsed.pathname}: HTTP ${statusCode}: ${errMsg}`
              )
            );
            return;
          }

          resolve(json);
        } catch {
          reject(
            new Error(
              `${method} ${parsed.pathname}: JSON パース失敗 (status=${statusCode}): ${data.slice(0, 200)}`
            )
          );
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error("Request timeout (15s)"));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/** 契約一覧を取得し、有効な区分を返す */
export async function listContracts(apiKey: string): Promise<string[]> {
  log.debug("GET /v2/contract");
  const res = (await request(
    "GET",
    `${API_BASE}/contract`,
    apiKey
  )) as ContractListResponse;

  if (res.status === "error") {
    throw new Error(
      `Contract List failed: ${res.error?.message} (code: ${res.error?.code})`
    );
  }

  const validClassifications = res.items
    .filter((item) => item.isValid)
    .map((item) => item.classification);

  log.debug(`契約済み区分: ${validClassifications.join(", ") || "(なし)"}`);
  return validClassifications;
}

/** 地震履歴を取得 */
export async function listEarthquakes(
  apiKey: string,
  limit = 10
): Promise<GdEarthquakeListResponse> {
  log.debug(`GET /v2/gd/earthquake?limit=${limit}`);
  const res = (await request(
    "GET",
    `${API_BASE}/gd/earthquake?limit=${limit}`,
    apiKey
  )) as GdEarthquakeListResponse;

  if (res.status === "error") {
    throw new Error(
      `Earthquake List failed: ${res.error?.message} (code: ${res.error?.code})`
    );
  }
  return res;
}

/** 既存のオープンソケットを取得 */
export async function listSockets(apiKey: string): Promise<SocketListResponse> {
  log.debug("GET /v2/socket?status=open");
  const res = (await request(
    "GET",
    `${API_BASE}/socket?status=open`,
    apiKey
  )) as SocketListResponse;

  if (res.status === "error") {
    throw new Error(
      `Socket List failed: ${res.error?.message} (code: ${res.error?.code})`
    );
  }
  return res;
}

/** 既存ソケットを閉じる */
export async function closeSocket(
  apiKey: string,
  socketId: number
): Promise<void> {
  log.debug(`DELETE /v2/socket/${socketId}`);
  const res = (await request(
    "DELETE",
    `${API_BASE}/socket/${socketId}`,
    apiKey
  )) as { status: string; error?: { message: string; code: number } };

  if (res.status === "error") {
    log.warn(`Socket Close failed for id=${socketId}: ${res.error?.message}`);
  } else {
    log.info(`既存ソケット id=${socketId} をクローズしました`);
  }
}

/** Socket Start: WebSocket接続用チケットを取得 */
export async function startSocket(
  config: AppConfig
): Promise<SocketStartResponse> {
  const body = {
    classifications: config.classifications,
    test: config.testMode,
    appName: config.appName,
    formatMode: "raw",
  };

  log.debug(`POST /v2/socket body=${JSON.stringify(body)}`);
  const res = (await request(
    "POST",
    `${API_BASE}/socket`,
    config.apiKey,
    body
  )) as SocketStartResponse;

  if (res.status === "error") {
    throw new Error(
      `Socket Start failed: ${res.error?.message} (code: ${res.error?.code})`
    );
  }
  return res;
}

/** 既存のオープン接続をすべて閉じてから Socket Start する */
export async function prepareAndStartSocket(
  config: AppConfig,
  previousSocketId?: number
): Promise<SocketStartResponse> {
  if (!config.keepExistingConnections) {
    // 同一 appName のオープンソケットを閉じる（他デバイスのソケットは維持）
    try {
      const list = await listSockets(config.apiKey);
      const openSockets = list.items.filter(
        (s) => s.status === "open" && s.appName === config.appName
      );
      if (openSockets.length > 0) {
        const skipped = list.items.filter(
          (s) => s.status === "open" && s.appName !== config.appName
        ).length;
        if (skipped > 0) {
          log.info(`他アプリの ${skipped} 件のソケットは維持します`);
        }
        await Promise.allSettled(
          openSockets.map((sock) => closeSocket(config.apiKey, sock.id))
        );
      }
    } catch (err) {
      log.warn(
        `既存ソケット確認中にエラー: ${err instanceof Error ? err.message : err}`
      );
    }
  } else if (previousSocketId != null) {
    // 再接続: 自分の旧接続だけを閉じる (サーバー側で既に閉じられている場合は 404 が返る)
    try {
      await closeSocket(config.apiKey, previousSocketId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("404")) {
        log.debug(`旧ソケット(id=${previousSocketId})は既にサーバー側で閉じられています`);
      } else {
        log.warn(`旧ソケット(id=${previousSocketId})のクローズに失敗: ${errMsg}`);
      }
    }
  } else {
    // 初回起動: 前回セッションの残留ソケットをクリーンアップ
    // appName でフィルタリングし、他デバイスのソケットを誤って閉じないようにする
    try {
      const list = await listSockets(config.apiKey);
      const openSockets = list.items.filter(
        (s) => s.status === "open" && s.appName === config.appName
      );
      if (openSockets.length > 0) {
        const skipped = list.items.filter(
          (s) => s.status === "open" && s.appName !== config.appName
        ).length;
        log.info(
          `前回セッションの残留ソケットを ${openSockets.length} 件クローズします` +
          (skipped > 0 ? ` (他アプリの ${skipped} 件は維持)` : "")
        );
        await Promise.allSettled(
          openSockets.map((sock) => closeSocket(config.apiKey, sock.id))
        );
      }
    } catch (err) {
      log.warn(
        `残留ソケット確認中にエラー: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  return startSocket(config);
}
