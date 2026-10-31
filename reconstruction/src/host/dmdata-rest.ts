import { request } from "node:https";
import type { ClientRequest } from "node:http";

import type { DmdataSubscription } from "../../contracts/p3-dmdata-connect.types";

// P3-C2-AC01: the three dmdata REST v2 socket calls and their boundary checks, nothing else.
// Results carry no API key, ticket, ipAddress or response text; callers record fixed reasons only (AC08).

// P3-C2-RES-05 (provisional): one request from start to its full body, no retry here.
const REQUEST_TIMEOUT_MS = 15_000;
const BODY_LIMIT_BYTES = 1024 * 1024;

type DmdataSocket = Readonly<{ id: number; appName: string | null; status: string; classifications: readonly string[] }>;
// HTTP 401/403 stay apart from other failures: the host stops retrying on them (P3-C2-RETRY).
type RestRefusal = Readonly<{ kind: "failed"; answered: boolean; retryAfterMs: number | null }> | Readonly<{ kind: "authRejected" }>; // answered: dmdata が答えた（P3-DC2-AC03 (2)、ネットの不調と分ける）
type SocketListResult = Readonly<{ kind: "ok"; sockets: readonly DmdataSocket[]; date: string | null }> | RestRefusal; // date: 応答の Date ヘッダ（P3-CK-AC02）
type SocketCloseResult = Readonly<{ kind: "ok" }> | RestRefusal;
// uncertain: the POST was handed over but whether a socket was created cannot be told (P3-C2-START-UNCERTAIN).
type SocketStartResult = Readonly<{ kind: "ok"; id: number; url: string; protocol: readonly string[] }>
  | RestRefusal | Readonly<{ kind: "uncertain" }>;

// notSent: failed before the request was handed to the OS. lost: handed over, but no complete answer.
// bytes は受けたままの本文（本文の呼び出しは text を往復させず parser の fatal な UTF-8 の検査へ渡す、P3-REC-AC01）。
// tooLarge: 本文が上限を越えた（読まずに切る。本文の呼び出しは断り、再試行しない、P3-REC-AC01）。
type Exchange = Readonly<{ kind: "notSent" }> | Readonly<{ kind: "lost" }> | Readonly<{ kind: "tooLarge" }> | Readonly<{ kind: "answered"; status: number; text: string; bytes: Uint8Array;
  date: string | null; retryAfter: number | null; contentType: string | null }>;
// P3-REC-AC01【発注 3】: 呼び先。省略は api.dmdata.jp・/v2・application/json・1 MiB（socket と一覧）。本文は data.api.dmdata.jp・/v1・XML・8 MiB・identity。
type Target = Readonly<{ hostname: string; prefix: string; accept: string; limitBytes: number; identity: boolean }>;
const API: Target = { hostname: "api.dmdata.jp", prefix: "/v2", accept: "application/json", limitBytes: BODY_LIMIT_BYTES, identity: false };

// signal: the caller's hard stop (the host's stop limit, P3-C2-RES-07). Aborted, the request is destroyed or never sent.
function exchange(method: "GET" | "POST" | "DELETE", path: string, apiKey: string, signal: AbortSignal | undefined,
  body?: object, target: Target = API): Promise<Exchange> {
  return new Promise((settle) => {
    if (signal?.aborted) { settle({ kind: "notSent" }); return; }
    let sent = false;
    let settled = false;
    let outgoing: ClientRequest | null = null;
    const end = (result: Exchange) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", lost);
      outgoing?.destroy();
      settle(result);
    };
    const lost = () => end(sent ? { kind: "lost" } : { kind: "notSent" });
    const timer = setTimeout(lost, REQUEST_TIMEOUT_MS);
    signal?.addEventListener("abort", lost);
    const payload = body == null ? undefined : JSON.stringify(body);
    try {
      outgoing = request({ hostname: target.hostname, port: 443, path: `${target.prefix}${path}`, method, headers: {
        Accept: target.accept, Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
        ...(target.identity ? { "Accept-Encoding": "identity" } : {}),
        ...(payload == null ? {} : { "Content-Type": "application/json" }) } }, (response) => {
        sent = true;
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          // A body over the limit is never read whole, so it is no answer.
          if (bytes > target.limitBytes) end({ kind: "tooLarge" }); else chunks.push(chunk);
        });
        response.on("end", () => {
          const received = Buffer.concat(chunks);
          end({ kind: "answered", status: response.statusCode ?? 0, text: received.toString("utf8"), bytes: received, date: response.headers.date ?? null,
            retryAfter: retryAfterMs(response.headers["retry-after"]), contentType: response.headers["content-type"] ?? null });
        });
        response.on("error", lost);
        response.on("close", lost);
      });
    } catch { end({ kind: "notSent" }); return; }
    // finish: the whole request reached the socket, so the server may have acted on it.
    outgoing.on("finish", () => { sent = true; });
    outgoing.on("error", lost);
    outgoing.end(payload);
  });
}

const success = (status: number) => status >= 200 && status < 300;
const refusal = (answer: Exchange): RestRefusal => answer.kind === "answered" && (answer.status === 401 || answer.status === 403) ? { kind: "authRejected" } : { kind: "failed", answered: answer.kind === "answered" || answer.kind === "tooLarge", retryAfterMs: answer.kind === "answered" ? answer.retryAfter : null };
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value != null && typeof value === "object" && !Array.isArray(value);
const isStrings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** GET /socket?status=<status>, projected to id, appName, status and classifications. */
async function listSockets(apiKey: string, status: "open" | "waiting", signal?: AbortSignal): Promise<SocketListResult> {
  const answer = await exchange("GET", `/socket?status=${status}`, apiKey, signal);
  if (answer.kind !== "answered") return refusal(answer);
  if (!success(answer.status)) return refusal(answer);
  const body = parse(answer.text);
  // A next page would leave sockets uncounted.
  if (!isRecord(body) || body.status !== "ok" || !Array.isArray(body.items) || body.nextToken != null) return refusal(answer);
  const sockets: DmdataSocket[] = [];
  for (const item of body.items) {
    if (!isRecord(item)) return refusal(answer);
    const { id, appName, status: socketStatus, classifications } = item;
    if (!isId(id) || !(appName === null || typeof appName === "string") || typeof socketStatus !== "string"
      || !isStrings(classifications)) return refusal(answer);
    sockets.push({ id, appName, status: socketStatus, classifications });
  }
  return { kind: "ok", sockets, date: answer.date };
}

/** DELETE /socket/{id}. Success is 2xx (an empty 204 included, a body must say ok) or 404 (already gone). */
async function closeSocket(apiKey: string, id: number, signal?: AbortSignal): Promise<SocketCloseResult> {
  const answer = await exchange("DELETE", `/socket/${id}`, apiKey, signal);
  if (answer.kind !== "answered") return refusal(answer);
  if (answer.status === 404) return { kind: "ok" };
  if (!success(answer.status)) return refusal(answer);
  if (answer.text === "") return { kind: "ok" };
  const body = parse(answer.text);
  return isRecord(body) && body.status === "ok" ? { kind: "ok" } : refusal(answer);
}

/** POST /socket. Failed only before sending or on a fully read non-2xx; any other unclear end is uncertain. */
async function startSocket(subscription: DmdataSubscription, signal?: AbortSignal): Promise<SocketStartResult> {
  const answer = await exchange("POST", "/socket", subscription.apiKey, signal, { classifications: subscription.classifications,
    test: subscription.testMode ?? "no", appName: subscription.appName, formatMode: "raw" });
  if (answer.kind === "notSent") return refusal(answer);
  if (answer.kind === "lost" || answer.kind === "tooLarge") return { kind: "uncertain" };
  if (!success(answer.status)) return refusal(answer);
  const body = parse(answer.text);
  const websocket = isRecord(body) && body.status === "ok" ? body.websocket : undefined;
  if (!isRecord(websocket)) return { kind: "uncertain" };
  const { id, url, protocol } = websocket;
  if (!isId(id) || typeof url !== "string" || !url.startsWith("wss:") || !isStrings(protocol)) return { kind: "uncertain" };
  return { kind: "ok", id, url, protocol };
}

// P3-REC-AC03 (3): Retry-After の秒の形だけを ms にする。日付の形・無い・読めないは null（倍々の待ちに回る）。
function retryAfterMs(value: string | undefined): number | null {
  return value != null && /^\d{1,9}$/.test(value.trim()) ? Number(value.trim()) * 1000 : null;
}

export { closeSocket, exchange, listSockets, startSocket };
export type { DmdataSocket, SocketCloseResult, SocketListResult, SocketStartResult, Target };
