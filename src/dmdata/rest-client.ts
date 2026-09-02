import https from "https";
import { AppConfig, SocketStartResponse, SocketListResponse, ContractListResponse, GdEarthquakeListResponse, TelegramListResponse } from "../types";
import * as log from "../logger";

const API_BASE = "https://api.dmdata.jp/v2";
const REQUEST_TIMEOUT_MS = 15_000;
const SOCKET_CLEANUP_MAX_RETRIES = 5;
const SOCKET_CLEANUP_RETRY_INTERVAL_MS = 500;

/** リトライ設定 */
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_JITTER_MS = 500;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

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

/** HTTP レスポンスのステータスコードを保持するエラー */
class HttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

/** 単発 HTTPS リクエストを Promise でラップ */
function requestOnce(
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

            // Retry-After ヘッダーの解析 (429 用)
            let retryAfterMs: number | null = null;
            if (statusCode === 429) {
              const retryAfter = res.headers["retry-after"];
              if (retryAfter != null) {
                const seconds = Number(retryAfter);
                if (!Number.isNaN(seconds)) {
                  retryAfterMs = seconds * 1_000;
                }
              }
            }

            reject(
              new HttpError(
                `${method} ${parsed.pathname}: HTTP ${statusCode}: ${errMsg}`,
                statusCode,
                retryAfterMs,
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
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timeout (${REQUEST_TIMEOUT_MS / 1000}s)`));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/** 指数バックオフ + ジッターの待ち時間を算出する (429 は Retry-After を尊重) */
function computeRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
  const exponentialDelay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * RETRY_MAX_JITTER_MS);
  const baseDelay = retryAfterMs != null
    ? Math.max(retryAfterMs, exponentialDelay)
    : exponentialDelay;
  return baseDelay + jitter;
}

/** 429 応答の Retry-After ヘッダーをミリ秒に直す (無い/不正なら null) */
function parseRetryAfterMs(headers: Record<string, string | string[] | undefined>): number | null {
  const retryAfter = headers["retry-after"];
  if (retryAfter == null) return null;
  const seconds = Number(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter);
  return Number.isNaN(seconds) ? null : seconds * 1_000;
}

/** 指数バックオフ + ジッター付きリトライでリクエストを実行 */
async function request(
  method: "GET" | "POST" | "DELETE",
  url: string,
  apiKey: string,
  body?: object
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await requestOnce(method, url, apiKey, body);
    } catch (err) {
      lastError = err;

      // リトライ上限到達
      if (attempt >= RETRY_MAX_ATTEMPTS) break;

      // リトライ可能なエラーか判定
      if (!(err instanceof HttpError) || !RETRYABLE_STATUS_CODES.has(err.statusCode)) {
        break; // ネットワークエラー・タイムアウト・4xx（429以外）等はリトライしない
      }

      // バックオフ遅延の算出: 指数バックオフ + ジッター、429 の場合は Retry-After を尊重
      const delay = computeRetryDelayMs(attempt, err.retryAfterMs);

      log.warn(
        `${method} ${new URL(url).pathname}: HTTP ${err.statusCode} — ${delay}ms 後にリトライします (${attempt + 1}/${RETRY_MAX_ATTEMPTS})`
      );

      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
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

export interface TelegramListQuery {
  type: string;
  limit?: number;
  /** Repair callers keep this explicit on every page/head request. */
  formatMode?: "raw";
  /**
   * Head 情報 (reportDateTime/serial/infoType/eventId) を items に載せる。
   * 既定 true。これが無いと item の meta が空のまま parse され、
   * 復元経路が identity を組めない (2026-09-02 に発覚した欠陥)。
   */
  xmlReport?: boolean;
  /** dmdata の opaque nextToken をそのまま渡す。内容を解釈しない。 */
  cursorToken?: string;
}

function normalizeTelegramListQuery(
  typeOrQuery: string | TelegramListQuery,
  legacyLimit: number,
  legacyCursorToken?: string,
): Required<Pick<TelegramListQuery, "type" | "limit" | "formatMode" | "xmlReport">>
  & Pick<TelegramListQuery, "cursorToken"> {
  const query = typeof typeOrQuery === "string"
    ? {
        type: typeOrQuery,
        limit: legacyLimit,
        formatMode: "raw" as const,
        xmlReport: true,
        cursorToken: legacyCursorToken,
      }
    : {
        type: typeOrQuery.type,
        limit: typeOrQuery.limit ?? 1,
        formatMode: typeOrQuery.formatMode ?? "raw",
        xmlReport: typeOrQuery.xmlReport ?? true,
        cursorToken: typeOrQuery.cursorToken,
      };
  if (query.type.trim() === "") throw new Error("Telegram List type must not be blank");
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) {
    throw new Error("Telegram List limit must be an integer from 1 to 100");
  }
  if (query.cursorToken != null && query.cursorToken.trim() === "") {
    throw new Error("Telegram List cursorToken must not be blank");
  }
  return query;
}

/**
 * 電文リストを一 page 取得する (GET /v2/telegram)。
 *
 * string/limit の旧呼び出しを維持しつつ、repair は query object を使う。
 * pagination 中も type/limit/formatMode を毎回明示し、nextToken は加工せず
 * cursorToken へだけ写す。
 */
export async function listTelegrams(
  apiKey: string,
  typeOrQuery: string | TelegramListQuery,
  limit = 1,
  cursorToken?: string,
): Promise<TelegramListResponse> {
  const query = normalizeTelegramListQuery(typeOrQuery, limit, cursorToken);
  const params = new URLSearchParams({
    type: query.type,
    limit: String(query.limit),
    formatMode: query.formatMode,
  });
  // false のときはパラメータ自体を出さない (dmdata 側の xmlReport=false 解釈が未確認のため)
  if (query.xmlReport) params.set("xmlReport", "true");
  if (query.cursorToken != null) params.set("cursorToken", query.cursorToken);
  log.debug(`GET /v2/telegram?${params}`);
  const res = (await request(
    "GET",
    `${API_BASE}/telegram?${params}`,
    apiKey
  )) as TelegramListResponse;

  if (res.status === "error") {
    throw new Error(
      `Telegram List failed: ${res.error?.message} (code: ${res.error?.code})`
    );
  }
  return res;
}

// ── Telegram Data v1 (本文取得) ──

/** Telegram Data v1 のベース URL。一覧 API (api.dmdata.jp/v2) とはホストが別。 */
export const TELEGRAM_DATA_BASE = "https://data.api.dmdata.jp/v1";

/**
 * 本文の受信上限。火山電文の実測は 7.5 KB なので 4 MiB で十分に広い。
 * `decodeTelegramBody` の 10 MiB より厳しく取り、超過は受信途中で打ち切る。
 */
export const TELEGRAM_BODY_MAX_BYTES = 4 * 1024 * 1024;

/** dmdata の電文 id は英数字のみ (実測 95〜96 文字のハッシュ)。 */
const TELEGRAM_ID_PATTERN = /^[A-Za-z0-9]{1,256}$/;

/**
 * 本文取得の結果。throw ではなく判別共用体で返す。
 * 呼び出し側は target 単位の fail-closed 理由を `reason` から組み立てる。
 */
export type TelegramBodyResult =
  | { kind: "ok"; xml: string }
  | {
      kind: "failed";
      reason: "forbidden" | "notFound" | "contentType" | "tooLarge" | "network";
    };

/** 応答 content-type が XML を名乗っているか */
function isXmlContentType(contentType: string): boolean {
  const normalized = contentType.trim().toLowerCase();
  return normalized.startsWith("application/xml") || normalized.startsWith("text/xml");
}

/**
 * 本文を 1 回だけ取りに行く。
 *
 * リトライ対象 (429/5xx) だけ `HttpError` で reject し、それ以外の終着は
 * すべて `TelegramBodyResult` で resolve する。
 */
function fetchTelegramBodyOnce(url: string, apiKey: string): Promise<TelegramBodyResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      agent: getKeepAliveAgent(),
      headers: {
        Accept: "application/xml",
        // gzip を受け取ると自前展開の経路が増える。実採取で無圧縮の生 XML を確認済み。
        "Accept-Encoding": "identity",
        Authorization: buildAuthorizationHeader(apiKey),
      },
    };

    let settled = false;
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      run();
    };

    const req = https.request(options, (res) => {
      const statusCode = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf-8");
        totalBytes += buf.length;
        if (totalBytes > TELEGRAM_BODY_MAX_BYTES) {
          settle(() => {
            req.destroy();
            resolve({ kind: "failed", reason: "tooLarge" });
          });
          return;
        }
        chunks.push(buf);
      });

      res.on("end", () => {
        if (settled) return;
        if (RETRYABLE_STATUS_CODES.has(statusCode)) {
          settle(() =>
            reject(
              new HttpError(
                `GET ${parsed.pathname}: HTTP ${statusCode}`,
                statusCode,
                parseRetryAfterMs(res.headers),
              ),
            ),
          );
          return;
        }
        if (statusCode === 403) {
          log.warn(
            `GET ${parsed.pathname}: HTTP 403 — 契約に telegram.data 権限が無い可能性があります`,
          );
          settle(() => resolve({ kind: "failed", reason: "forbidden" }));
          return;
        }
        if (statusCode === 404) {
          settle(() => resolve({ kind: "failed", reason: "notFound" }));
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          settle(() => resolve({ kind: "failed", reason: "network" }));
          return;
        }
        const contentType = res.headers["content-type"] ?? "";
        if (!isXmlContentType(Array.isArray(contentType) ? contentType[0] ?? "" : contentType)) {
          settle(() => resolve({ kind: "failed", reason: "contentType" }));
          return;
        }
        settle(() => resolve({ kind: "ok", xml: Buffer.concat(chunks).toString("utf-8") }));
      });
    });

    req.on("error", () => {
      settle(() => resolve({ kind: "failed", reason: "network" }));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timeout (${REQUEST_TIMEOUT_MS / 1000}s)`));
    });
    req.end();
  });
}

/**
 * Telegram Data v1 から電文本文 (生 XML) を取得する。
 *
 * URL は id から自分で組む。`expectedUrl` (一覧 item の `url`) を渡した場合は
 * 組んだ URL と一致することを検証し、不一致なら送信せずに失敗させる
 * ——外部応答の文字列をそのまま fetch 先にすると、汚染時に任意ホストへ
 * Basic 認証ヘッダーを送ることになるため。
 */
export async function fetchTelegramBody(
  apiKey: string,
  id: string,
  expectedUrl?: string,
): Promise<TelegramBodyResult> {
  if (!TELEGRAM_ID_PATTERN.test(id)) {
    log.warn(`Telegram Data: 電文 id の形が想定外です (len=${id.length})`);
    return { kind: "failed", reason: "network" };
  }
  const url = `${TELEGRAM_DATA_BASE}/${id}`;
  if (expectedUrl != null && expectedUrl !== url) {
    log.warn(`Telegram Data: 一覧の url が想定と一致しません (id=${id})`);
    return { kind: "failed", reason: "network" };
  }

  for (let attempt = 0; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      log.debug(`GET /v1/${id}`);
      return await fetchTelegramBodyOnce(url, apiKey);
    } catch (err) {
      if (!(err instanceof HttpError) || attempt >= RETRY_MAX_ATTEMPTS) {
        return { kind: "failed", reason: "network" };
      }
      const delay = computeRetryDelayMs(attempt, err.retryAfterMs);
      log.warn(
        `GET /v1/${id}: HTTP ${err.statusCode} — ${delay}ms 後にリトライします (${attempt + 1}/${RETRY_MAX_ATTEMPTS})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return { kind: "failed", reason: "network" };
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

/** サーバー側でソケット削除が反映されるのを待つ */
async function awaitSocketCleanup(
  apiKey: string,
  closedIds: number[]
): Promise<void> {
  for (let attempt = 1; attempt <= SOCKET_CLEANUP_MAX_RETRIES; attempt++) {
    await new Promise((r) => setTimeout(r, SOCKET_CLEANUP_RETRY_INTERVAL_MS));
    try {
      const list = await listSockets(apiKey);
      const stillOpen = list.items.filter(
        (s) => s.status === "open" && closedIds.includes(s.id)
      );
      if (stillOpen.length === 0) {
        log.debug(`ソケット削除の反映を確認 (${attempt} 回目)`);
        return;
      }
      log.debug(
        `ソケット削除待機中... 残存 ${stillOpen.length} 件 (${attempt}/${SOCKET_CLEANUP_MAX_RETRIES})`
      );
    } catch {
      // リスト取得失敗は無視して次のリトライへ
    }
  }
  log.warn("ソケット削除の反映を確認できませんでしたが、続行します");
}

/** 既存のオープン接続をすべて閉じてから Socket Start する */
export async function prepareAndStartSocket(
  config: AppConfig,
  previousSocketId?: number
): Promise<SocketStartResponse> {
  /** クリーンアップで DELETE を送信したソケット ID */
  const closedIds: number[] = [];

  if (!config.keepExistingConnections) {
    // 同一 appName のオープンソケットを閉じる（他デバイスのソケットは維持）
    try {
      const list = await listSockets(config.apiKey);
      const allOpen = list.items.filter((s) => s.status === "open");
      log.debug(
        `オープンソケット一覧 (${allOpen.length} 件): ${allOpen.map((s) => `id=${s.id},appName=${s.appName ?? "(null)"}`).join("; ") || "(なし)"}`
      );
      log.debug(`自アプリ名: "${config.appName}", keepExisting=${config.keepExistingConnections}`);
      const openSockets = allOpen.filter(
        (s) => s.appName === config.appName
      );
      if (openSockets.length > 0) {
        const skipped = allOpen.filter(
          (s) => s.appName !== config.appName
        ).length;
        if (skipped > 0) {
          log.info(`他アプリの ${skipped} 件のソケットは維持します`);
        }
        await Promise.allSettled(
          openSockets.map((sock) => closeSocket(config.apiKey, sock.id))
        );
        closedIds.push(...openSockets.map((s) => s.id));
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
      closedIds.push(previousSocketId);
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
      const allOpen = list.items.filter((s) => s.status === "open");
      log.debug(
        `オープンソケット一覧 (${allOpen.length} 件): ${allOpen.map((s) => `id=${s.id},appName=${s.appName ?? "(null)"}`).join("; ") || "(なし)"}`
      );
      log.debug(`自アプリ名: "${config.appName}", keepExisting=${config.keepExistingConnections}`);
      const openSockets = allOpen.filter(
        (s) => s.appName === config.appName
      );
      if (openSockets.length > 0) {
        const skipped = allOpen.filter(
          (s) => s.appName !== config.appName
        ).length;
        log.info(
          `前回セッションの残留ソケットを ${openSockets.length} 件クローズします` +
          (skipped > 0 ? ` (他アプリの ${skipped} 件は維持)` : "")
        );
        await Promise.allSettled(
          openSockets.map((sock) => closeSocket(config.apiKey, sock.id))
        );
        closedIds.push(...openSockets.map((s) => s.id));
      }
    } catch (err) {
      log.warn(
        `残留ソケット確認中にエラー: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // ソケットを閉じた場合、サーバー側で削除が反映されるのを待ってから新規作成する
  // (反映前に POST /v2/socket すると同時接続上限を超過し、他デバイスが切断される)
  if (closedIds.length > 0) {
    await awaitSocketCleanup(config.apiKey, closedIds);
  }

  return startSocket(config);
}
