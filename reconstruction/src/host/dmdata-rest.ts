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
type RestRefusal = Readonly<{ kind: "failed" }> | Readonly<{ kind: "authRejected" }>;
type SocketListResult = Readonly<{ kind: "ok"; sockets: readonly DmdataSocket[] }> | RestRefusal;
type SocketCloseResult = Readonly<{ kind: "ok" }> | RestRefusal;
// uncertain: the POST was handed over but whether a socket was created cannot be told (P3-C2-START-UNCERTAIN).
type SocketStartResult = Readonly<{ kind: "ok"; id: number; url: string; protocol: readonly string[] }>
  | RestRefusal | Readonly<{ kind: "uncertain" }>;

// notSent: failed before the request was handed to the OS. lost: handed over, but no complete answer.
type Exchange = Readonly<{ kind: "notSent" }> | Readonly<{ kind: "lost" }> | Readonly<{ kind: "answered"; status: number; text: string }>;

function exchange(method: "GET" | "POST" | "DELETE", path: string, apiKey: string, body?: object): Promise<Exchange> {
  return new Promise((settle) => {
    let sent = false;
    let settled = false;
    let outgoing: ClientRequest | null = null;
    const end = (result: Exchange) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outgoing?.destroy();
      settle(result);
    };
    const lost = () => end(sent ? { kind: "lost" } : { kind: "notSent" });
    const timer = setTimeout(lost, REQUEST_TIMEOUT_MS);
    const payload = body == null ? undefined : JSON.stringify(body);
    try {
      outgoing = request({ hostname: "api.dmdata.jp", port: 443, path: `/v2${path}`, method, headers: {
        Accept: "application/json", Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
        ...(payload == null ? {} : { "Content-Type": "application/json" }) } }, (response) => {
        sent = true;
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          // A body over the limit is never read whole, so it is no answer.
          if (bytes > BODY_LIMIT_BYTES) lost(); else chunks.push(chunk);
        });
        response.on("end", () => end({ kind: "answered", status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
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
const refusal = (status: number): RestRefusal => status === 401 || status === 403 ? { kind: "authRejected" } : { kind: "failed" };
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value != null && typeof value === "object" && !Array.isArray(value);
const isStrings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** GET /socket?status=<status>, projected to id, appName, status and classifications. */
async function listSockets(apiKey: string, status: "open" | "waiting"): Promise<SocketListResult> {
  const answer = await exchange("GET", `/socket?status=${status}`, apiKey);
  if (answer.kind !== "answered") return { kind: "failed" };
  if (!success(answer.status)) return refusal(answer.status);
  const body = parse(answer.text);
  // A next page would leave sockets uncounted.
  if (!isRecord(body) || body.status !== "ok" || !Array.isArray(body.items) || body.nextToken != null) return { kind: "failed" };
  const sockets: DmdataSocket[] = [];
  for (const item of body.items) {
    if (!isRecord(item)) return { kind: "failed" };
    const { id, appName, status: socketStatus, classifications } = item;
    if (!isId(id) || !(appName === null || typeof appName === "string") || typeof socketStatus !== "string"
      || !isStrings(classifications)) return { kind: "failed" };
    sockets.push({ id, appName, status: socketStatus, classifications });
  }
  return { kind: "ok", sockets };
}

/** DELETE /socket/{id}. Success is 2xx (an empty 204 included, a body must say ok) or 404 (already gone). */
async function closeSocket(apiKey: string, id: number): Promise<SocketCloseResult> {
  const answer = await exchange("DELETE", `/socket/${id}`, apiKey);
  if (answer.kind !== "answered") return { kind: "failed" };
  if (answer.status === 404) return { kind: "ok" };
  if (!success(answer.status)) return refusal(answer.status);
  if (answer.text === "") return { kind: "ok" };
  const body = parse(answer.text);
  return isRecord(body) && body.status === "ok" ? { kind: "ok" } : { kind: "failed" };
}

/** POST /socket. Failed only before sending or on a fully read non-2xx; any other unclear end is uncertain. */
async function startSocket(subscription: DmdataSubscription): Promise<SocketStartResult> {
  const answer = await exchange("POST", "/socket", subscription.apiKey, { classifications: subscription.classifications,
    test: "no", appName: subscription.appName, formatMode: "raw" });
  if (answer.kind === "notSent") return { kind: "failed" };
  if (answer.kind === "lost") return { kind: "uncertain" };
  if (!success(answer.status)) return refusal(answer.status);
  const body = parse(answer.text);
  const websocket = isRecord(body) && body.status === "ok" ? body.websocket : undefined;
  if (!isRecord(websocket)) return { kind: "uncertain" };
  const { id, url, protocol } = websocket;
  if (!isId(id) || typeof url !== "string" || !url.startsWith("wss:") || !isStrings(protocol)) return { kind: "uncertain" };
  return { kind: "ok", id, url, protocol };
}

export { closeSocket, listSockets, startSocket };
export type { DmdataSocket, SocketCloseResult, SocketListResult, SocketStartResult };
