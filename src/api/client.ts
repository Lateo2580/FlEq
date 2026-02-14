import https from "https";
import { AppConfig, SocketStartResponse, SocketListResponse, ContractListResponse } from "../types";
import * as log from "../utils/logger";

const API_BASE = "https://api.dmdata.jp/v2";

/** HTTPS リクエストを Promise でラップ */
function request(
  method: "GET" | "POST" | "DELETE",
  url: string,
  apiKey: string,
  body?: object
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    // APIキーをクエリパラメータとして付与（dmdata.jp公式方式）
    parsed.searchParams.set("key", apiKey);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
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
  config: AppConfig
): Promise<SocketStartResponse> {
  if (!config.keepExistingConnections) {
    try {
      const list = await listSockets(config.apiKey);
      const openSockets = list.items.filter((s) => s.status === "open");
      for (const sock of openSockets) {
        await closeSocket(config.apiKey, sock.id);
      }
    } catch (err) {
      log.warn(
        `既存ソケット確認中にエラー: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  return startSocket(config);
}
